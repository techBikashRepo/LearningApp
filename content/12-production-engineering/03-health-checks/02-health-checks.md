# Health Checks

## SECTION 5 — Real World Example

> **Architect Training Mode** | Site Reliability Engineer Perspective
> _Real health check failures that caused real outages — and how to prevent them._

---

### INCIDENT 01 — Auth Middleware Blocking Health Check → Mass Unhealthy

```
SYMPTOM:
  Deployment starts. New tasks spin up. ALB health checks start.
  All new tasks immediately marked UNHEALTHY.
  Circuit breaker trips. Deployment fails. Auto-rollback initiated.
  But you've already had 2 minutes of partial degradation.

  During investigation: old and new tasks report "unhealthy."
  Service is partially working — some requests succeed, some fail.
  ALB is juggling between healthy old tasks and the chaos.

ROOT CAUSE:
  A developer added global JWT auth middleware to the Express app:

    app.use(authMiddleware);   // JWT required for ALL routes
    app.get('/health', ...);   // registered AFTER auth middleware

  ALB health checker sends: GET /health (no Authorization header).
  Auth middleware checks for Bearer token. None present → 401 Unauthorized.
  ALB receives 401. Expected 200. Target marked unhealthy.
  ALL tasks in ALL deployments are marked unhealthy.

  The service was actually working fine for authenticated users.
  But ALB thought every task was broken.

FIX — Register health routes BEFORE auth middleware:
  // WRONG:
  app.use(authMiddleware);    // auth applied globally
  app.get('/health', ...);    // health check ALSO gets auth-guarded

  // CORRECT:
  app.get('/health', healthHandler);       // registered FIRST — no middleware applies
  app.get('/health/ready', readyHandler);  // registered FIRST
  app.use(authMiddleware);                 // auth applied to all routes BELOW this line

  // Or: explicitly exclude health routes from middleware:
  app.use((req, res, next) => {
    if (req.path.startsWith('/health')) return next(); // skip auth
    return authMiddleware(req, res, next);
  });

ALSO CHECK: rate limiting middleware
  If you have express-rate-limit applied globally:
  ALB fires health checks every 10-30 seconds from ~20 ALB nodes.
  20 health checks × every 10 seconds = 120 requests/minute from ALB alone.
  Rate limiter may throttle them → 429 → ALB marks targets unhealthy.
  Fix: exclude /health from rate limiting as well.
```

---

### INCIDENT 02 — Health Check Times Out → Not Actually Down

```
SYMPTOM:
  Noon on a Tuesday. Traffic is at its peak (highest point of the day).
  ALB starts marking tasks unhealthy. Tasks are removed from rotation.
  Remaining capacity: 50% of normal. Latency climbs. User impact.
  PagerDuty fires at P1.

  Engineers connect to task via ECS Exec. App is running. Responding to /health instantly.
  Restarting tasks: they come back healthy. Then go unhealthy again after 5-10 minutes.

ROOT CAUSE:
  Under high load, all threads are busy serving application requests.
  Health check: GET /health/ready queries the database (SELECT 1).
  DB pool has 10 connections. All 10 are occupied by peak traffic.
  Health check waits for a free connection. Pool timeout = 5000ms.
  ALB health check timeout = 5 seconds.
  Health check waits 4.9 seconds, gets a connection, returns 200.
  But 4.9s > ALB's 5s timeout → marked as failed.

  The service is healthy. It's OVERLOADED. But the symptom is "health check failure."

FIX 1 — Separate connection pool for health checks:
  const appPool = new Pool({ connectionString, max: 10 });
  const healthPool = new Pool({ connectionString, max: 1, idleTimeoutMillis: 5000 });
  // Health check uses healthPool → not competing with app traffic
  // App uses appPool → health check doesn't starve app of connections

FIX 2 — Shallow /health for ALB, deep /health/ready for early deploy check:
  ALB doesn't need to verify DB connectivity on every poll.
  That's what application errors are for (they'll show up as 5xx).
  Use ALB for shallow check (process alive).
  Use deep check only during deployment (to gate rollout, not ongoing).

FIX 3 — Don't run queries in health check under load:
  Cache the last DB check result for 10 seconds:

  let lastDbCheck = { ok: true, checkedAt: 0 };

  async function checkDatabase(): Promise<boolean> {
    const now = Date.now();
    if (now - lastDbCheck.checkedAt < 10_000) {
      return lastDbCheck.ok;  // use cached result
    }
    try {
      await healthPool.query('SELECT 1');
      lastDbCheck = { ok: true, checkedAt: now };
      return true;
    } catch {
      lastDbCheck = { ok: false, checkedAt: now };
      return false;
    }
  }

  // Health check runs every 30s, so cache of 10s has minimal lag.
```

---

### INCIDENT 03 — Crash Loop Because startPeriod Not Set

```
SYMPTOM:
  New service deployment. Developer just added DB migrations on startup.
  Tasks start, run migrations (takes 40 seconds), then start listening.
  But tasks are dying and restarting every 30 seconds.
  Migrations never complete. Service never comes up.
  Debug: logs show migrations starting, then task killed, then migrations starting again.

ROOT CAUSE:
  ECS health check configured with default startPeriod = 0.
  interval = 30, retries = 3 (default).
  At 0 seconds: first health check → app not listening yet → fail.
  At 30 seconds: second health check → migrations still running → fail.
  At 60 seconds: third health check (retries exhausted) → task marked UNHEALTHY.
  ECS kills and restarts. Migrations restart. Infinite loop.

FIX — Set startPeriod to cover maximum startup time:
  {
    "healthCheck": {
      "command": ["CMD", "curl", "-f", "http://localhost:8080/health"],
      "interval": 30,
      "timeout": 5,
      "retries": 3,
      "startPeriod": 120   // give 2 minutes for migrations + startup
    }
  }

  Rule of thumb:
    Measure your worst-case startup time in staging.
    startPeriod = max startup time + 30-second buffer.

  For services with expensive startup:
    DB migrations: startPeriod = 300 (5 minutes)
    Loading ML models: startPeriod = 600 (10 minutes)
    Simple REST API: startPeriod = 60 (1 minute)

ALSO: emit a log at startup so you can see the timeline:
  logger.info({ event: 'startup_db_migrations_start' });
  await runMigrations();
  logger.info({ event: 'startup_db_migrations_complete', durationMs });
  logger.info({ event: 'startup_server_listening', port: 8080 });

  This shows exactly how long each phase takes.
  CloudWatch Logs Insights time range narrows the startPeriod problem quickly.
```

---

### INCIDENT 04 — Health Check Returning 200 But Service Is Broken

```
SYMPTOM:
  All tasks marked HEALTHY. ALB routing to all tasks.
  But users are getting errors on about 30% of requests.
  Error: "Cannot read property 'id' of undefined" in some endpoint.
  Rate: 30% not 100% — only affecting some requests.

  Engineer: "How? Health checks are passing. Tasks are healthy."

ROOT CAUSE:
  Health check endpoint (/health/ready) checks DB connectivity.
  The bug is in application logic — a null check missing in a specific code path.
  The DB is perfectly reachable. SELECT 1 returns fine.
  So health check passes. But a specific feature is completely broken.

LESSON:
  Health checks verify infrastructure connectivity, not application correctness.
  They will NOT catch:
    - Logic bugs
    - Incorrect data returned (JSON structure wrong)
    - Feature-specific failures (a specific API endpoint always 500s)
    - Business logic errors (prices calculated wrongly)

  For these: you need integration tests in your deployment pipeline + smoke tests post-deploy.

POST-DEPLOY SMOKE TESTS:
  After deployment completes, run a suite of HTTP tests:

  // smoke-tests.ts — run after deploy as part of CI/CD
  async function smokeTest() {
    const results = [];

    // Test 1: Can we reach the health endpoint?
    results.push(await test('GET /health', async () => {
      const r = await fetch(`${BASE_URL}/health`);
      assert(r.status === 200);
    }));

    // Test 2: Can we authenticate?
    results.push(await test('POST /auth/login', async () => {
      const r = await fetch(`${BASE_URL}/auth/login`, {
        method: 'POST',
        body: JSON.stringify({ email: TEST_USER, password: TEST_PASS })
      });
      assert(r.status === 200);
      const body = await r.json();
      assert(body.token);
    }));

    // Test 3: Can we fetch a product list?
    results.push(await test('GET /products', async () => {
      const r = await fetch(`${BASE_URL}/products`, { headers: { Authorization: `Bearer ${token}` } });
      assert(r.status === 200);
    }));

    const failed = results.filter(r => !r.ok);
    if (failed.length > 0) {
      console.error('Smoke tests failed:', failed);
      process.exit(1);  // fail CI/CD → trigger rollback
    }
  }
```

---

### Debugging Health Check Problems

```bash
# ──────────────────────────────────────────────────────
# ALB TARGET HEALTH — WHY IS A TARGET UNHEALTHY?
# ──────────────────────────────────────────────────────

# Get health status of all targets in a group:
aws elbv2 describe-target-health \
  --target-group-arn <target-group-arn> \
  --query 'TargetHealthDescriptions[*].{
    Target:Target.Id,
    Port:Target.Port,
    State:TargetHealth.State,
    Reason:TargetHealth.Reason,
    Description:TargetHealth.Description
  }'

# Common TargetHealth.Reason values:
# Elb.InternalError       → ALB internal issue (not your app)
# Target.Timeout          → health check request timed out → lower health check timeout
# Target.FailedHealthChecks → app returned non-200 → check app logs
# Target.NotRegistered    → target not in group
# Target.NotInUse         → service has 0 desired tasks (scale-to-zero?)
# Elb.RegistrationInProgress → task just started, still warming up

# Debug the health check manually (run from within VPC or bastion):
curl -v http://<task-private-ip>:8080/health/ready
# -v shows response headers, status code
# If this returns 200: health check URL is wrong in ALB config
# If this times out/refuses: app not listening on that port

# ──────────────────────────────────────────────────────
# ECS TASK HEALTH STATUS
# ──────────────────────────────────────────────────────

# Get health status of running tasks:
aws ecs describe-tasks \
  --cluster prod \
  --tasks $(aws ecs list-tasks --cluster prod --service-name api \
    --query 'taskArns' --output text) \
  --query 'tasks[*].{
    TaskId:taskArn,
    Status:lastStatus,
    Health:healthStatus,
    StopReason:stopCode
  }'

# Check if health check is even configured on the task:
aws ecs describe-task-definition \
  --task-definition api:latest \
  --query 'taskDefinition.containerDefinitions[0].healthCheck'
# If null: no container health check configured → tasks always UNKNOWN

# ──────────────────────────────────────────────────────
# SIMULATE HEALTH CHECK FROM INSIDE CONTAINER
# ──────────────────────────────────────────────────────

# ECS Exec into the container:
aws ecs execute-command \
  --cluster prod \
  --task <task-arn> \
  --container api \
  --command "curl -s -o /dev/null -w '%{http_code}' http://localhost:8080/health/ready" \
  --interactive

# If health check uses wget not curl:
# --command "wget -q -O /dev/null http://localhost:8080/health && echo OK"
```

## SECTION 6 — System Design Importance

The incident patterns above highlight key system design principles: design for failure, implement graceful degradation, enforce security boundaries at every layer, and monitor proactively. Each incident represents a production scenario that should inform your system design decisions.

## SECTION 7 — AWS & Cloud Mapping

AWS services directly relevant to these patterns: **ECS/Fargate** for container orchestration and task lifecycle management; **ECR** for secure image storage and scanning; **Secrets Manager / SSM Parameter Store** for runtime secret injection; **CloudWatch** for container metrics, logs, and alarms; **IAM** for fine-grained access control.

## SECTION 8 — Interview Preparation

**Beginner:**

**Q: What is a health check endpoint and what should it return?**
**A:** A health check is a dedicated endpoint (GET /health) that your load balancer or orchestrator calls periodically to verify the service is alive and able to handle requests. Minimum response: HTTP 200 with {"status": "ok"}. The load balancer checks this every 30 seconds; if it fails 2-3 consecutive times, the instance is removed from rotation and a new one is started. Without health checks, a crashed or hung server continues receiving traffic and all requests fail silently. Health checks are the basic self-healing mechanism of modern infrastructure.

**Q: What is the difference between a liveness check and a readiness check?**
**A:** *Liveness:* Is the process alive at all? Tests basic process health â€” if this fails, restart the container. Example: GET /health/live â†’ just returns 200. Catches hung processes, deadlocks. *Readiness:* Is the service ready to handle traffic? Tests dependencies (can the service connect to the database? Is it done with startup initialization?). If this fails, remove from load balancer rotation but DON'T restart. Example: a Node.js service may be alive (process running) but not ready (still running migrations). Used by Kubernetes and AWS ECS to manage traffic routing separately from container restarts.

**Q: Why is a deep health check sometimes dangerous and when should you use a shallow vs deep check?**
**A:** *Shallow check* (just returns 200, no dependency checks): Fast, no side effects. Use for: load balancer health checks (ALB pings this every 30s for all instances â€” if it runs a DB query each time, you're adding thousands of DB queries/minute with zero benefit). *Deep check* (checks DB connectivity, Redis connectivity, downstream API): More informative â€” catches cascading failures. Use for: startup readiness check (before receiving first traffic), internal ops dashboard, CI/CD smoke tests. Danger of deep checks in ALB health: if your DB is briefly overloaded, all ALB targets fail health checks simultaneously â†’ entire service removed from rotation â†’ cascade failure from a health check itself.

---

**Intermediate:**

**Q: How do you implement a health check that catches a database connection pool exhaustion issue before it affects users?**
**A:** Pool exhaustion (all connections checked out, new requests wait or fail) manifests first as increased latency, then errors. In your deep health check: SELECT 1 query with a strict timeout (500ms). If it times out or fails â†’ health check fails. Additionally: expose pool metrics (/metrics endpoint): db.pool.active, db.pool.idle, db.pool.waiting. CloudWatch alarm: db.pool.waiting > 3 for 2 consecutive minutes â†’ alert before it degrades to user-visible failures. The goal is to catch the problem when you're at 85% pool capacity, not at 100% when users see errors.

**Q: What is a circuit breaker pattern and how does it relate to health checks?**
**A:** A circuit breaker monitors calls to a dependency (external API, database). Three states: *Closed* (normal operation, calls proceed). *Open* (dependency failing â€” after N failures in a time window, STOP calling it, return error immediately without trying). *Half-open* (after a cooldown period, try one call â€” success â†’ close, failure â†’ stay open). Health checks and circuit breakers work together: the health check tests current dependency state, circuit breaker prevents cascading load onto a struggling dependency. Without circuit breaker: if payments API is slow, all API threads queue up waiting â†’ entire service freezes. With circuit breaker â†’ fail fast, shed load, let the dependency recover.

**Q: How should startup and shutdown health check behavior differ, and what is a "warming up" state?**
**A:** *Startup â€” Readiness:* Service starts, loads configuration, initializes DB connection pool, runs startup checks. During this time: return 503 from /health/ready so load balancer doesn't route traffic yet. Only return 200 after fully initialized. ECS health check grace period (60-120s) gives the service time to pass readiness before being declared unhealthy. *Shutdown â€” Graceful:* When SIGTERM received, immediately return 503 from health check â†’ ALB stops sending new traffic â†’ process drains existing requests (30s drain timeout) â†’ exits. Never process new requests after SIGTERM. *Warm-up state:* Some services need ramp-up (JVM JIT compilation, connection pool filling). Return 503 or a reduced-capacity signal until warm.

---

**Advanced (System Design):**

**Scenario 1:** Design health check architecture for a service that calls 3 external dependencies: PostgreSQL, Redis, and a third-party payment API. Define: what each check verifies, what happens when each fails, and how to prevent a flaky third-party API from causing your service to be removed from the load balancer.

*Three health check endpoints:*

GET /health/live â†’ returns 200 always if process is running. Used by ECS restart policy.

GET /health/ready â†’ returns 200 only if PostgreSQL and Redis are healthy. Payment API NOT included (a flaky external API should not take your whole service offline). Checked by ALB health check.

GET /health/deep â†’ checks all three dependencies, returns detailed status JSON. Used only by internal dashboards and ops team, NOT by ALB.

*Payment API health:* Separate CloudWatch alarm monitors payment API error rate. Circuit breaker pattern in code: if payment API fails 5 times in 30s â†’ open circuit, return graceful error to users ("payment temporarily unavailable"). Alert ops team. Payment API health never causes ALB deregistration.

**Scenario 2:** After a deployment, a new version of your service is passing liveness health checks but users are experiencing 500 errors. The ALB target group shows all targets as healthy. Why could this happen and how do you fix the health check design?

*Root cause:* Health check endpoint (GET /health) returns 200 but the actual request handling is broken (e.g., a new code path introduced a bug that only triggers on real requests, not the health check). The health check is too shallow â€” it proves the process is alive and the HTTP server responds, but doesn't test actual request handlers.

*Fixes:*
(1) Add a more meaningful deep check that calls a representative internal function (e.g., run a simple DB query from the actual connection pool used by request handlers, not a separate health check connection).
(2) Smoke test in the deployment pipeline: after deploy, before marking deployment successful, run curl /api/v1/products (an actual API endpoint) and verify 200. This would catch the bug before traffic is routed.
(3) ECS deployment circuit breaker: configure ollback: true â€” if > 50% of new tasks fail within 5 minutes of deployment (as measured by CloudWatch alarms, not just health check), automatic rollback to previous task definition.

