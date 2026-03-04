# Graceful Shutdown

## SECTION 5 — Real World Example

> **Architect Training Mode** | Site Reliability Engineer Perspective

---

### INCIDENT 01 — In-Flight Payment Lost During Deployment

```
SYMPTOM:
  Engineering team deploys a new version every day. Usually no issues.
  One Tuesday: customer calls. "I was charged twice."
  Investigation: payment ID exists once in DB. But Stripe shows a charge.
  DB transaction was never committed. The charge was captured at Stripe.

  Order is in limbo: charged but no order record. Manual reconciliation needed.
  Customer compensation: refund + credit. Reputation damage.

ROOT CAUSE:
  Deployment started at 2pm. ECS stopped old tasks.
  A payment request arrived at the OLD task at exactly the moment it received SIGTERM.
  Old task default handler: no SIGTERM handler → Node.js exits in 10 seconds.

  The payment flow was:
    1. Validate request (done)
    2. Call Stripe API → charge card (DONE — Stripe was called, returned success)
    3. INSERT order to DB ← NEVER HAPPENED (process exited during step 3)

  Stripe was already charged. DB record was never created. Charge with no order.

ROOT CAUSE (deeper): Node.js default behavior without SIGTERM handler:
  Node.js will eventually exit after SIGTERM even without a handler.
  But active HTTP connections are not waited on.
  Mid-request exit is possible.

FIX:
  SIGTERM handler:
    process.on('SIGTERM', () => shutdown('SIGTERM', server));

  server.close() ensures existing connections finish.
  The payment request would complete: Stripe charge + DB insert = both succeed.

ADDITIONAL PROTECTION — Idempotency key:
  Even with graceful shutdown, network issues can cause double charges.
  Stripe idempotency keys prevent this:

  const charge = await stripe.paymentIntents.create({
    amount: order.totalCents,
    currency: 'usd',
    idempotencyKey: `payment-${order.id}`  // same key = same result, not double charge
  });

  Stripe: if the same idempotency key is retried within 24h, returns the original result.
  No double charge even if the request is retried.
```

---

### INCIDENT 02 — SIGKILL Before Cleanup → Data Corruption

```
SYMPTOM:
  Service restarts fine 98% of the time. Occasionally:
  One DB connection stays "idle in transaction" in PostgreSQL.
  After a while: 5 stuck connections, all "idle in transaction."
  DB connection pool gets exhausted faster than expected (10 connections, 5 are stuck).
  50% of pool occupied by zombie connections.

ROOT CAUSE:
  ECS stopTimeout = 30 seconds (default).
  Graceful shutdown timeout = 30 seconds (same as stopTimeout!).

  Shutdown sequence:
    t=0:  SIGTERM received. server.close() called.
    t=28: One complex DB query still running (bulk report generation, legitimately slow).
    t=30: SIGKILL. Process terminates instantly.
    t=30: DB query was in the middle of a transaction.

  PostgreSQL behavior after client disconnects mid-transaction:
    PostgreSQL eventually detects the broken connection (TCP timeout or keepalive).
    Until then: the transaction is locked as "idle in transaction."
    Other queries trying to access the same rows are BLOCKED.
    Connection slot is occupied (counts against max_connections).

  Depending on PostgreSQL idle_in_transaction_session_timeout:
    Default: 0 (disabled — connections can sit "idle in transaction" forever).
    Fix: set a timeout in PostgreSQL.

FIXES:
  Fix 1 — stopTimeout > graceful shutdown timeout:
    ECS stopTimeout = 35 seconds.
    Graceful shutdown timeout = 25 seconds.
    Now: forced exit at 25s, SIGKILL at 35s. 10-second margin.

  Fix 2 — PostgreSQL idle_in_transaction_session_timeout:
    # In RDS parameter group:
    idle_in_transaction_session_timeout = 30000  # 30 seconds in milliseconds
    # PostgreSQL will automatically close connections stuck in idle transaction.

  Fix 3 — Set statement_timeout for long-running queries:
    # Connection-level or application-level:
    await pool.query("SET statement_timeout = '20s'");  // before long queries
    # Any query taking > 20s gets cancelled automatically.
    # Cancelled query = transaction rolled back = connection freed.

  Fix 4 — Pool cleanup on exit:
    // During graceful shutdown, before process.exit():
    await pool.end();  // pg-pool.end() sends ROLLBACK to any open transactions
    // Then closes all connections cleanly.
```

---

### INCIDENT 03 — Worker Processes Duplicate Jobs

```
SYMPTOM:
  Background email worker processes "send_welcome_email" jobs.
  After a deployment: some users receive 2 welcome emails.
  Happens ~5% of the time. Intermittent. Hard to reproduce.

ROOT CAUSE:
  SQS message visibility timeout = 30 seconds.
  When worker receives a message: SQS makes it invisible for 30 seconds.
  If worker doesn't delete the message within 30 seconds: SQS makes it visible again.
  Another worker (new deployment instance) picks it up. Sends another email.

  The SIGTERM scenario:
    t=0:  Old worker task receives SQS message. Starts processing.
    t=0:  Sends email successfully (takes 2 seconds).
    t=2:  About to call DeleteMessage to remove from SQS.
    t=2:  SIGTERM received. isShuttingDown = true.
    t=2:  Worker loop exits BEFORE calling DeleteMessage.
    t=30: SQS visibility timeout expires. Message becomes visible again.
    t=30: New task picks it up. Sends second email.

FIX 1 — Always delete BEFORE yielding to shutdown check:
  // WRONG: check shutdown BEFORE completing the current message:
  while (!isShuttingDown) {
    const msg = await receiveMessage();
    if (isShuttingDown) break;  // ← may skip processing a received message
    await processMessage(msg);
    await deleteMessage(msg);
  }

  // CORRECT: if you've received a message, always complete it:
  while (!isShuttingDown) {
    const msg = await receiveMessage();
    if (!msg) continue;
    // Don't check isShuttingDown here — finish what was started:
    await processMessage(msg);      // process
    await deleteMessage(msg);       // always delete after processing
    // isShuttingDown checked at top of next loop iteration
  }

FIX 2 — Idempotency in the worker:
  // worker.ts — idempotent email sending:
  async function processWelcomeEmail(userId: string, messageId: string): Promise<void> {
    // Check if already sent (use DB or Redis as idempotency store):
    const alreadySent = await db.query(
      'SELECT 1 FROM sent_emails WHERE user_id = $1 AND type = $2',
      [userId, 'welcome']
    );
    if (alreadySent.rows.length > 0) {
      logger.info({ event: 'email_already_sent_skipping', userId, messageId });
      return;  // idempotent: skip if already done
    }

    await sendEmail(userId, 'welcome');

    // Record that we sent it:
    await db.query(
      'INSERT INTO sent_emails (user_id, type, sent_at) VALUES ($1, $2, NOW())',
      [userId, 'welcome']
    );
  }

FIX 3 — Increase SQS visibility timeout:
  If your job takes max 60 seconds:
    visibility_timeout = 120 seconds (2× the max processing time)
  Reduces duplicate processing window in case of mid-processing crash.
```

---

## SECTION 8 — Interview Preparation

**Beginner:**

**Q: What is graceful shutdown and why does abrupt shutdown cause problems?**
**A:** Graceful shutdown is the process of stopping a server cleanly: stop accepting new requests, finish processing all in-flight requests, close database connections, then exit. Abrupt shutdown (kill -9 or crash) terminates immediately â€” any requests being processed are abandoned mid-way, possibly leaving your database in partial state (order created but payment not charged), open database connections abandoned (connection pool exhausted), and in-flight writes lost. Every time your server restarts in deployment or autoscaling, if it doesn't shut down gracefully, users experience failed requests.

**Q: What Linux signal is used to trigger graceful shutdown and how does Docker/ECS use it?**
**A:** SIGTERM (signal 15) is the polite "please shut down" signal. SIGKILL (signal 9) is the forceful "die immediately â€” no cleanup" signal. ECS and Docker send SIGTERM first, wait a configurable stop timeout (default 30s), then send SIGKILL if the process hasn't exited. Your Node.js application should: process.on('SIGTERM', () => { server.close(() => { db.end(); process.exit(0); }); }). The server.close() stops accepting new HTTP connections but allows existing connections to finish. db.end() closes the PostgreSQL connection pool cleanly.

**Q: What is a "connection drain" on an AWS ALB, and why is it important for graceful shutdown?**
**A:** Connection draining (called "deregistration delay" in ALB settings) is the time the ALB waits after removing a target before it stops sending requests to it. When your ECS task receives SIGTERM: (1) ECS tells ALB to deregister the target. (2) ALB stops sending NEW requests to the deregistering target. (3) ALB waits the drain timeout (default 300s, usually set to 30-60s) for in-flight requests to complete. (4) ECS sends SIGKILL if the target doesn't exit within the stop timeout. Your app's graceful shutdown needs to complete within the stop timeout. Set ALB deregistration delay â‰ˆ ECS stop timeout.

---

**Intermediate:**

**Q: What database cleanup must happen during graceful shutdown and what risks exist if it doesn't?**
**A:** *Connection pool:* Close all database connections in the pool. If not closed: the connection persists on the database server side (RDS sees "established" connections from a dead process). RDS has a max_connections limit â€” leaked connections consume slots. After several deployments without proper cleanup, the connection pool is full and new connections fail. *Transactions:* If a transaction is in-progress during shutdown, it MUST be committed or rolled back. Abandoning a transaction holds locks â€” other queries are blocked until connection timeout frees the lock (often 30-60 seconds). *Prepared statements:* Close all prepared statements before disconnect.

**Q: How do you implement graceful shutdown in a Node.js API with Express and pg (PostgreSQL)?**
**A:** Complete implementation:
`js
const server = app.listen(3000, () => console.log('Started'));

async function shutdown(signal) {
  console.log(Received , starting graceful shutdown);
  
  // 1. Stop accepting new HTTP connections
  server.close(async () => {
    try {
      // 2. Wait for in-flight requests to complete (server.close() does this)
      // 3. Close database pool
      await pool.end();
      console.log('Database pool closed');
      // 4. Exit cleanly
      process.exit(0);
    } catch (err) {
      console.error('Error during shutdown:', err);
      process.exit(1);
    }
  });
  
  // 5. Force exit after 25s (before ECS sends SIGKILL at 30s)
  setTimeout(() => { console.error('Forced shutdown'); process.exit(1); }, 25000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));  // Ctrl+C in dev
`

**Q: What happens to background jobs (cron tasks, queue consumers) during graceful shutdown?**
**A:** Background jobs need their own shutdown logic: *Cron tasks:* check if a job is currently running; if yes, let it finish before exiting. Set a flag isShuttingDown = true, check it at the start of each cron run. *Queue consumers (SQS):* stop polling for new messages, finish processing current message, call deleteMessage to acknowledge completion, then exit. If process exits mid-processing without deleting the SQS message, SQS visibility timeout expires â†’ message becomes visible again â†’ another instance processes it. This is the "at-least-once delivery" guarantee: same message may be processed twice around restarts â€” your consumer must be idempotent.

---

**Advanced (System Design):**

**Scenario 1:** Design the complete graceful shutdown sequence for a service that: (1) serves HTTP requests, (2) processes SQS messages (5 concurrent consumers), (3) runs a periodic cron job every minute, (4) holds a PostgreSQL connection pool of 20 connections, and (5) maintains a Redis cache client. The ECS stop timeout is 30 seconds.

*Ordered shutdown sequence (target: complete in 25s):*
`
T+0s  SIGTERM received
T+0s  Set globalShuttingDown = true
T+0s  HTTP server.close() â€” stop accepting new HTTP connections
T+0s  SQS: stop polling for new messages immediately
T+0s  Cron: set flag, current running job completes naturally
T+1s  Wait for in-flight HTTP requests to drain (server.close callback)
T+1s  Wait for 5 SQS consumers to finish current messages
T+5s  HTTP requests done (typical: < 5s for most requests)
T+10s SQS consumers done (each message processing < 10s)
T+10s pool.end()  â€” PostgreSQL pool closes gracefully
T+11s redis.quit() â€” Redis connection closes
T+11s process.exit(0) â€” clean exit
T+25s Force exit (safety net, before ECS SIGKILL at T+30s)
`

**Scenario 2:** After a deployment, you notice 3-4 "connection refused" errors in your logs every time a deployment happens, even though you've implemented graceful shutdown. The errors happen 1-2 seconds AFTER the new version is fully healthy. What could cause this?

*Root cause:* ALB deregistration delay timing mismatch. Even though your service handles SIGTERM gracefully (no mid-request failures), the ALB continues routing NEW requests to the shutting-down instance for the deregistration delay period. If your service closes the HTTP server immediately, those new requests get "connection refused."

*Fix:* In SIGTERM handler â€” don't close the HTTP server immediately. Instead: (1) Mark the instance as "draining" â€” /health/ready returns 503 (tells ALB to stop routing new traffic sooner). (2) Wait for ALB to deregister (typically 5s after 503 health checks). (3) Then call server.close(). This sequence: SIGTERM â†’ health check returns 503 â†’ ALB stops new requests â†’ drain 5s â†’ server.close() â†’ pool.end() â†’ exit. No "connection refused" because we stop receiving traffic before closing the server.

## SECTION 6 — System Design Importance

The incident patterns above highlight key system design principles: design for failure, implement graceful degradation, enforce security boundaries at every layer, and monitor proactively. Each incident represents a production scenario that should inform your system design decisions.

## SECTION 7 — AWS & Cloud Mapping

AWS services directly relevant to these patterns: **ECS/Fargate** for container orchestration and task lifecycle management; **ECR** for secure image storage and scanning; **Secrets Manager / SSM Parameter Store** for runtime secret injection; **CloudWatch** for container metrics, logs, and alarms; **IAM** for fine-grained access control.


**Beginner:**
- What are the most common production issues you've seen with this technology?
- How do you debug a service that is failing in production?

**Intermediate:**
- Walk through a real incident you've handled (or studied) — root cause, fix, and prevention.
- How do you build runbooks and post-mortems for recurring failure patterns?

**Advanced (System Design):**
- Design a production-grade deployment pipeline that catches the failure types described above before they reach production.
