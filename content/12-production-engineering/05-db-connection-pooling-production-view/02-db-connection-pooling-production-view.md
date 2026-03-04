# DB Connection Pooling (Production View)

## SECTION 5 — Real World Example

> **Architect Training Mode** | Site Reliability Engineer Perspective

---

### INCIDENT 01 — Pool Exhaustion Under Load

```
SYMPTOM:
  Normal Friday. Traffic gradually increases as users browse at lunch.
  At 12:14pm: P1 alarm. "API error rate > 5%."
  Logs: 100% of errors are "PoolExhaustedError: timeout of 5000ms exceeded."
  Not a single database error. Not a slow query. The POOL itself is full.
  Requests are waiting for connections that never come free.

  10 minutes before the alarm:
    ECS CPU: 15% (not CPU-bound).
    ECS Memory: 32% (not memory-bound).
    RDS CPU: 12% (not database-bound).
  Everything looks fine in standard metrics. Then sudden wall of errors.

ROOT CAUSE:
  api service: 2 ECS tasks, pool size = 10 each.
  Total capacity: 20 concurrent DB operations.

  A new feature was deployed that week: product recommendation algorithm.
  On homepage load: the recommendation endpoint makes 8 sequential DB queries.
  Before: homepage = 2 queries. After: homepage = 10 queries (8 new ones).

  10 concurrent homepage users × 10 queries each = 100 concurrent DB operations needed.
  Available: 20. Queue builds up. connectionTimeoutMillis = 5000ms.
  After 5 seconds of waiting: PoolExhaustedError.

  The DB itself was fine. 12% CPU. Easily handled the query volume.
  The bottleneck was pool connections, not the database.

DIAGNOSIS:
  # CloudWatch Logs Insights:
  fields @timestamp, error.type, error.message, event
  | filter level = "ERROR"
  | stats count() by error.type
  | sort count desc
  # Top result: PoolExhaustedError. Confirmed: pool, not DB.

  # Check pool metrics (if emitting to CloudWatch):
  fields @timestamp, poolWaiting, poolIdle, poolTotal
  | filter poolWaiting > 0
  | sort @timestamp desc
  # poolWaiting was climbing for 10 minutes before the alarm. Missed signal.

IMMEDIATE RESOLUTION:
  Scale ECS tasks from 2 to 4 (doubles pool capacity: 20 → 40 connections).
  Error rate drops immediately.

ROOT CAUSE FIX (code):
  Recommendation queries were sequential:
    const q1 = await db.query('SELECT...');     // query 1
    const q2 = await db.query('SELECT...');     // query 2, after q1
    // ...8 sequential queries...

  Fix: parallelize independent queries:
    const [q1, q2, q3, q4] = await Promise.all([
      db.query('SELECT...'),
      db.query('SELECT...'),
      db.query('SELECT...'),
      db.query('SELECT...'),
    ]);
    // 8 sequential → 2 batches of 4 parallel = same work, uses 4 connections for ~half the time.
    // Connection hold time per request: dramatically reduced.

LESSON:
  Pool exhaustion is often not a capacity issue — it's a query pattern issue.
  Sequential queries = connections held longer = fewer requests can be served simultaneously.
  Always look at: "how long is each request holding a connection?"
  Not just: "how many connections are in the pool?"
```

---

### INCIDENT 02 — Connection Leak → Pool Slowly Dies

```
SYMPTOM:
  Gradual degradation over 48 hours.
  Monday 9am: pool metrics healthy. idle = 8/10.
  Monday 6pm: idle = 4/10. Requests taking slightly longer.
  Tuesday 9am: idle = 1/10. Intermittent PoolExhaustedErrors starting.
  Tuesday 2pm: idle = 0/10. Service in pool exhaustion. P1 alarm.

  Restart the ECS task: immediately healthy again. But degrades again by the next day.
  This is a pattern: tasks need to be restarted every 1-2 days.

ROOT CAUSE: Connection leak.
  Code acquires a pool client manually (for transactions) but doesn't release it on error:

  // LEAKING CODE:
  async function doSomethingInTransaction() {
    const client = await pool.connect();  // borrow a client
    await client.query('BEGIN');
    const result = await client.query('INSERT INTO...');

    if (result.rows[0].someCondition) {
      throw new Error('Business logic error');  // ← client.release() never called!
    }

    await client.query('COMMIT');
    client.release();  // only reached if no error
  }

  Every time the business logic error is thrown: one connection is leaked.
  Pool: 10 connections. After 10 leaks: all connections used by leaked transactions.
  New requests: wait infinitely (no connection to borrow). Then: PoolExhaustedError.

FIX — Always release in a finally block:
  async function doSomethingInTransaction() {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query('INSERT INTO...');

      if (result.rows[0].someCondition) {
        throw new Error('Business logic error');  // caught by finally
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();    // ← ALWAYS released, regardless of error
    }
  }

DETECT LEAKS EARLY — pool.totalCount vs expected:
  // pool.totalCount should always equal pool.max (10) after warmup.
  // If totalCount < max: connections were permanently leaked.
  // Monitor: totalCount drops below max and stays there → leak in progress.

  // Also: set allowExitOnIdle: false and check for unclosed clients:
  // pg-pool logs a warning if a client is checked out but not returned.
  // Enable verbose pg logging in staging: pool._clients.length

SIMPLER FIX — Use pool.query() instead of pool.connect():
  // pool.query() automatically acquires AND releases the connection:
  const result = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
  // No manual release needed. No leak risk.

  // Only use pool.connect() when you NEED a transaction across multiple queries.
  // For single queries: always prefer pool.query().
```

---

### INCIDENT 03 — RDS Restart Breaks Pool Permanently

```
SYMPTOM:
  Thursday maintenance window: RDS undergoes a minor version upgrade.
  RDS restarts (expected, 2-3 minutes of downtime).
  After RDS comes back: API still returning errors. Pool never recovers.
  Need to force-restart all ECS tasks manually.

ROOT CAUSE:
  pg-pool's idle connection health: by default, pg-pool does NOT proactively
  test idle connections. It trusts the connection is still valid.

  When RDS restarted: all TCP connections to PostgreSQL were dropped.
  Pool: "I have 10 connections." Reality: all 10 are dead TCP sockets.
  Request arrives: pool loans a dead connection. Query sent. TCP error. PoolExhaustedError.

  pg-pool removes the dead client... but it should create a new one.
  In some versions/configurations: the pool doesn't always recover automatically.

FIX 1 — Set pool error handler (already in production config):
  pool.on('error', (err, client) => {
    logger.error({ event: 'db_pool_idle_client_error', error: err.message });
    // pg-pool removes the errored client and opens a new one automatically.
  });

FIX 2 — Health check with retry in application:
  // When a query fails with a connection error, retry:
  async function queryWithRetry<T>(
    text: string,
    values?: any[],
    retries = 1
  ): Promise<T[]> {
    try {
      const result = await pool.query(text, values);
      return result.rows;
    } catch (err: any) {
      if (retries > 0 && isConnectionError(err)) {
        logger.warn({ event: 'db_query_retry', error: err.message });
        await new Promise(r => setTimeout(r, 1000));  // wait 1s before retry
        return queryWithRetry(text, values, retries - 1);
      }
      throw err;
    }
  }

  function isConnectionError(err: Error): boolean {
    return err.message.includes('Connection terminated') ||
           err.message.includes('connection closed') ||
           err.message.includes('ECONNREFUSED') ||
           err.message.includes('ETIMEDOUT');
  }

FIX 3 — RDS Proxy absorbs RDS restarts:
  RDS Proxy maintains a warm connection pool to RDS.
  When RDS restarts: Proxy reconnects automatically.
  Application connects to Proxy: no interruption from RDS restarts.
  Proxy handles the failover and reconnection transparently.
  This is one of the biggest benefits of RDS Proxy for ECS services.
```

---

## SECTION 8 — Interview Preparation

**Beginner:**

**Q: What is a database connection pool and why do we need one?**
**A:** Opening a new database connection is expensive â€” it involves TCP handshake, authentication, and SSL negotiation (~20-100ms). If your API server opens a new connection for every request and closes it after, a 100 req/s API spends a significant portion of its time just on connection overhead. A connection pool maintains a set of open connections that are reused. A request borrows a connection, uses it, returns it to the pool. Connection overhead: paid once at startup, not per request. Result: dramatically lower latency, fewer connections on the DB side, more efficient resource usage.

**Q: What are the key configuration parameters of a connection pool and what happens when the pool is full?**
**A:** Key params: *min:* connections always kept open (avoid cold start delay). *max:* maximum connections the pool will open. *idleTimeoutMs:* close idle connections after N ms. *connectionTimeoutMs:* how long to wait for a free connection before throwing an error. When pool is full (all max connections in use) and a request needs a connection: it waits in a queue for up to connectionTimeoutMs. If no connection becomes free in time â†’ error thrown: "connection timeout" or "pool exhausted." This surfaces in production as a spike in errors during high traffic.

**Q: What is the relationship between max pool size and RDS max_connections?**
**A:** RDS max_connections is the total connections the entire database can handle simultaneously. It's determined by instance memory (RDS formula: roughly DBInstanceClassMemory / 12582880). For db.t3.medium (2GB): ~170 max connections. If you have 10 ECS tasks each with pool max=20, that's 200 potential connections â€” more than RDS allows. Result: connection failures when all tasks have their pools full. Rule: total (ECS tasks Ã— pool max) must stay well below RDS max_connections (leave 20% headroom for admin connections, replication, migrations).

---

**Intermediate:**

**Q: What is PgBouncer and when is it necessary in production?**
**A:** PgBouncer is a connection pooling proxy that sits between your application servers and PostgreSQL. It multiplexes many application connections onto a smaller set of actual database connections. Necessary when: many application instances Ã— pool max exceeds RDS max_connections. Example: 50 ECS tasks Ã— 10 connections each = 500. RDS max = 200. Solution: all tasks connect to PgBouncer â†’ PgBouncer maintains 150 real connections to RDS. The 500 application connections share those 150 real connections. Traffic modes: *session pooling* (one real connection per session duration), *transaction pooling* (real connection only held during transaction â€” most efficient, allows 100s of app connections over ~20 real connections), *statement pooling* (one statement at a time â€” can't use multi-step transactions).

**Q: What is connection pool warming and why does a cold application start perform poorly?**
**A:** Connection pool warming is pre-establishing connections when the application starts. With lazy initialization (default in many libraries), connections are created on first use â€” the first requests after startup pay the connection overhead. With min pool connections > 0, the pool eagerly opens those connections at startup â€” first requests proceed immediately. In ECS: when a task starts during an autoscaling event, the first few requests to that task have higher latency (establishing connections) if min: 0. Set min: 2-5 to pre-warm connections. Trade-off: DB connections are used even when traffic is zero (cost of idle connections on small DBs is negligible).

**Q: What are the production symptoms of connection pool misconfiguration, and how do you diagnose each?**
**A:** *Pool too small:* connection timeout exceeded errors during traffic spikes. Metric: pool.waitingCount > 0 for sustained periods. Fix: increase max pool size (ensure RDS max_connections not exceeded). *Pool too large:* RDS max_connections exhausted, other services can't connect. Metric: SELECT count(*) FROM pg_stat_activity approaches RDS limit. Fix: reduce max or implement PgBouncer. *Idle timeout too aggressive:* Spike in latency on "warm" requests when idle connections are closed and must be reopened. Metric: connection open events correlate with latency spikes. Fix: increase idleTimeoutMs. *Connection leak:* pool.totalCount grows continuously, never decreases. Query not releasing connections (code path skips client.release()). Fix: review all code paths for proper client release in error cases.

---

**Advanced (System Design):**

**Scenario 1:** You're running 30 ECS tasks each with a connection pool of max=10, connected to an RDS PostgreSQL db.r6g.large (max_connections â‰ˆ 870). Peak traffic: 50 tasks are running (autoscaling). You also run 5 separate Lambda functions that open direct connections (no pool) and are concurrently running 100 instances. Design a connection management strategy that prevents exhaustion.

*Calculation:* 50 ECS tasks Ã— 10 connections = 500. Lambdas: 100 concurrent Ã— 1 connection each = 100. Total potential: 600. RDS max: 870. Reserve 100 for: admin, migrations, read replicas, monitoring. Usable: 770. 600 < 770 â€” technically fine, but Lambda scales elastically and could spike to 500+ concurrent.

*Strategy:*
(1) ECS: keep pool max=10, ensure tasks Ã— pool max stays within budget.
(2) Lambdas: use RDS Proxy (AWS managed connection pool proxy for Lambda) â€” Lambdas connect to RDS Proxy, not RDS directly. RDS Proxy maintains a fixed pool to RDS regardless of Lambda concurrency. Lambda reserved concurrency set to 200 max.
(3) RDS Proxy handles transaction-level multiplexing â€” 500 Lambda connections become ~50 real RDS connections.
(4) CloudWatch alarm: DatabaseConnections > 700 â†’ alert â†’ investigate before exhaustion.

**Scenario 2:** Your RDS instance shows max_connections at 95% during peak every day. Engineers respond by manually restarting ECS tasks to free connections. This is obviously unsustainable. Design a permanent fix.

*Root cause investigation:*
SELECT count(*), state, wait_event_type, wait_event FROM pg_stat_activity GROUP BY state, wait_event_type, wait_event ORDER BY count DESC;
Common findings: (a) many connections in idle in transaction state (code that starts transactions but doesn't commit/rollback â€” transaction timeout not set). (b) Lambda functions directly connecting without pool. (c) Connection pool max set too high during a past scaling event.

*Fixes based on root cause:*
- Idle in transaction: set idle_in_transaction_session_timeout = 30000 (30s) in PostgreSQL â€” auto-terminates forgotten open transactions.
- Lambda: add RDS Proxy between Lambda and RDS.
- Pool too large: reduce max pool size, audit all services' pool configs.
- Long-term: add PgBouncer as a sidecar for all ECS services to reduce connection overhead.
- Preventive: CloudWatch alarm at 70% max_connections to catch before hitting 95%.

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
