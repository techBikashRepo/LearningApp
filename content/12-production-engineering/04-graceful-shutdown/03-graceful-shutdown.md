# Graceful Shutdown

## FILE 03 OF 03 — Design Decisions, Exam Traps & Architect's Mental Model

> **Architect Training Mode** | Site Reliability Engineer Perspective

---

## SECTION 9 — Certification Focus (AWS SAA-C03)

### Decision 1: What Resources Need Cleanup?

```
ALWAYS CLEAN UP:
  HTTP server             → server.close() — stops accepting new connections
  Database pool           → pool.end() — waits for active queries, then closes
  Redis client            → client.quit() — graceful vs client.disconnect() (abrupt)
  SQS polling loop        → isShuttingDown flag — finish current message, then stop
  Log buffers             → logger.flush() — pino buffers async writes
  External SDK clients    → most AWS SDKs don't need explicit cleanup (stateless per call)

CONDITIONAL CLEANUP:
  File uploads in progress → depends on your implementation
    If writing to local disk then uploading to S3: wait for S3 upload to complete.
    If streaming directly to S3: the stream needs to finish.

  Scheduled jobs (setInterval):
    clearInterval(jobHandle) — stops new iterations. Current iteration finishes naturally.

  WebSocket connections:
    Close all open sockets with close() (code 1001 = "Going Away").
    Clients should auto-reconnect to a different task.

ORDER OF CLEANUP:
  1. Stop accepting new requests (server.close()).
     Reason: don't take on new work while shutting down.

  2. Let in-flight requests finish.
     Reason: fulfill obligations already started.

  3. Close DB connections (pool.end()).
     Reason: let DB know connections are being released cleanly.

  4. Flush log buffers (logger.flush()).
     Reason: ensure shutdown events are persisted.

  5. process.exit(0).
     Reason: clean exit after everything is done.

  If you close the DB pool in step 1: in-flight requests that need DB will fail.
  Order matters.
```

### Decision 2: How Long Should the Shutdown Window Be?

```
FACTORS:
  1. What is your maximum expected request duration?
     Typical REST API: 500ms-2s. Long-running report: 30s.
     Set graceful shutdown timeout to: max request duration + 5s buffer.

  2. What is your ECS stopTimeout?
     stopTimeout = graceful shutdown timeout + 10s.
     Give SIGKILL a 10-second margin after your graceful window closes.

  3. What does ALB deregistration_delay say?
     If deregistration_delay = 30s and SIGTERM arrives before deregistration completes:
     New requests could still arrive after SIGTERM but before deregistration.
     Graceful window must be long enough to handle them.

TYPICAL CONFIGURATION:
  Standard REST API:
    max request duration:      5 seconds
    graceful shutdown timeout: 15 seconds
    ECS stopTimeout:           25 seconds
    ALB deregistration_delay:  15 seconds

  API with file uploads:
    max request duration:      120 seconds
    graceful shutdown timeout: 130 seconds
    ECS stopTimeout:           140 seconds
    ALB deregistration_delay:  120 seconds

  Never set graceful timeout longer than stopTimeout - 10.
  Never set it to the same value as stopTimeout (race condition with SIGKILL).
```

### Decision 3: Express vs Fastify Graceful Shutdown

```
EXPRESS:
  server.close(callback) stops accepting new connections.
  BUT: keep-alive connections are NOT terminated.

  Problem: modern HTTP clients (including ALB) use keep-alive connections.
  Keep-alive connection = persistent TCP connection reused for multiple requests.
  server.close() won't close an idle keep-alive connection that has no active request.
  server might hang for the keep-alive timeout (default: 5s) even with no in-flight work.

  Fix: use the 'http-terminator' library:
    import { createHttpTerminator } from 'http-terminator';
    const httpTerminator = createHttpTerminator({ server });

    // In graceful shutdown:
    await httpTerminator.terminate();  // closes keep-alive connections too

  OR: set keepAliveTimeout lower to reduce the hang window:
    server.keepAliveTimeout = 1000;   // 1 second instead of 5

FASTIFY:
  fastify.close() handles keep-alive connections correctly by default.
  Uses the under-the-cover close-with-graceful approach.
  Preferred for new projects.

RECOMMENDATION: Fastify for new services (simpler graceful shutdown).
Express + http-terminator for existing Express services.
```

---

## SECTION 10 — Comparison Table

```
TRAP 1: "SIGTERM kills the process immediately."
  SIGTERM is a REQUEST to terminate gracefully. It can be caught and handled.
  SIGKILL is the one that kills immediately and cannot be caught.
  Node.js with no SIGTERM handler: process eventually exits, but not immediately.
  With a handler: you control exactly what happens.

TRAP 2: "server.close() ends all connections."
  server.close() stops accepting NEW connections.
  Existing connections (especially keep-alive) remain open.
  Use http-terminator or fastify.close() for complete cleanup.

TRAP 3: "30-second ECS stopTimeout is plenty."
  30 seconds = ECS will SIGKILL in 30 seconds.
  If your graceful shutdown timeout is 30 seconds: it's a race.
  Node.js forced exit at 30s vs ECS SIGKILL at 30s — unpredictable.
  Always: graceful timeout < stopTimeout with at least 5-10 seconds of margin.

TRAP 4: "Workers just need to stop processing — no cleanup needed."
  SQS workers that stop without deleting their current message:
    Message becomes visible again after visibility timeout.
    Another worker (or a restarted instance) picks it up.
    Duplicate processing = duplicate emails, duplicate charges, duplicate events.
  Always complete the current message (including DeleteMessage) before exiting.
  Design workers to be idempotent as a second line of defense.

TRAP 5: "Graceful shutdown is only needed for production."
  Graceful shutdown makes local development better too:
    Ctrl+C in development = SIGINT.
    Without handler: DB connections abruptly closed, connection pool corrupts.
    With handler: clean exit, DB connections properly released.
  Register SIGINT + SIGTERM handlers in all environments.
```

---

## SECTION 11 — Quick Revision

```
Q1: "What happens when ECS stops a task?"

A: "ECS sends SIGTERM to the container's main process (PID 1).
The application has until the stopTimeout (configurable, default 30s) to exit.
If it doesn't exit by then, ECS sends SIGKILL — forced, immediate termination.
So graceful shutdown must complete within stopTimeout minus a small buffer.

Concurrently, if the task is in an ALB target group, ECS puts the task
into DEREGISTERING state. The ALB drain period (deregistration_delay) runs —
existing connections are allowed to finish, new connections go to healthy tasks.
By the time SIGTERM arrives, the ALB should have already stopped routing new requests here."

────────────────────────────────────────────────────────────────────

Q2: "How do you implement graceful shutdown in Node.js?"

A: "Register a SIGTERM handler that calls a shutdown function.
The shutdown function calls server.close() — this stops accepting new connections
but lets in-flight requests complete. I wait for server.close() to call back,
meaning all active requests have finished. Then I close the database pool with pool.end(),
which waits for active queries then closes all connections. Then flush log buffers.
Then process.exit(0).

I also set a forced-exit timeout at 25 seconds so even if something hangs,
the process exits before ECS sends SIGKILL at 35 seconds.
The forced timeout prevents the process from hanging indefinitely."

────────────────────────────────────────────────────────────────────

Q3: "How do you prevent duplicate job processing during deployments?"

A: "Two layers.
First: finish the current message before acknowledging shutdown.
My SQS worker checks isShuttingDown at the top of the polling loop,
not between receive and delete. If I've received a message, I always complete it
and call DeleteMessage before consulting isShuttingDown.

Second: idempotency at the business logic level.
For emails: check if already sent before sending. Mark as sent after.
For payments: use Stripe idempotency keys.
For DB inserts: use INSERT ... ON CONFLICT DO NOTHING with a business-key unique constraint.
The first layer prevents duplicates during normal graceful shutdown.
The second layer catches edge cases — SIGKILL, network partition, retried SQS messages."
```

---

## SECTION 12 — Architect Thinking Exercise

### 5 Decision Rules

```
RULE 1: REGISTER SIGTERM BEFORE THE SERVER STARTS LISTENING
  process.on('SIGTERM', ...) must be registered before app.listen().
  A signal can arrive during startup. Register early.

RULE 2: STOP ACCEPTING BEFORE CLEANING UP
  server.close() first. Then cleanup resources.
  Wrong order: close DB → in-flight requests fail on DB calls → errors returned to users.
  Right order: stop new work → finish current work → release resources.

RULE 3: stopTimeout = graceful timeout + 10 seconds
  Never set them equal. Never leave stopTimeout at default if your shutdown window is > 20s.
  The 10-second buffer prevents SIGKILL from racing with your cleanup code.

RULE 4: WORKERS MUST BE IDEMPOTENT
  Graceful shutdown reduces duplicates but doesn't eliminate them.
  Network issues, SIGKILL, ECS spot interruptions — any of these can cause reprocessing.
  Every background job must be safe to run twice.

RULE 5: TEST SHUTDOWN IN STAGING REGULARLY
  Shutdown code is rarely exercised in unit tests.
  Run a deployment to staging weekly. Check logs for clean shutdown sequence.
  Inject a slow request during shutdown. Verify it completes.
  Untested shutdown code = unknown behavior during real deployments.
```

### 30-Second Interview Answer

```
"When ECS stops a task, it sends SIGTERM before SIGKILL.
I handle SIGTERM to implement graceful shutdown in three steps.

First: stop accepting new connections via server.close().
Second: wait for in-flight requests to complete — no forced cancellation.
Third: close the database pool with pool.end(), flush log buffers, then exit.

I set a forced timeout at graceful-window minus 5 seconds as a safety net,
and configure ECS stopTimeout to be 10 seconds longer than my graceful window.

For SQS workers: I set an isShuttingDown flag and finish the current message
including the DeleteMessage call before exiting the polling loop.
All workers are idempotent as a second line of defense against duplicates."
```
