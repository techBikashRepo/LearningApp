# Health Checks

## FILE 03 OF 03 — Design Decisions, Exam Traps & Architect's Mental Model

> **Architect Training Mode** | Site Reliability Engineer Perspective

---

## SECTION 9 — Certification Focus (AWS SAA-C03)

### Decision 1: One Endpoint or Two?

```
OPTION A — Single /health endpoint for both ALB and ECS:
  Simple. One endpoint to maintain.
  Problem: if DB goes down, /health returns 503.
  ECS container check: 503 = UNHEALTHY = restart the task.
  Restarting the task does not fix the database.
  Now you have a crash loop AND a DB outage simultaneously.
  Service is doubly broken.

OPTION B — Two endpoints (recommended):
  /health        → liveness check (used by ECS container check)
                   Returns 200 if process is running. Period.
                   Even if DB is down: returns 200. "I'm alive."

  /health/ready  → readiness check (used by ALB target group)
                   Returns 200 only if all dependencies are healthy.
                   If DB down: returns 503. ALB stops routing traffic.
                   But ECS does NOT restart the task (it's not the liveness check).

  Outcome: DB outage → tasks stop receiving NEW traffic (ALB sees 503).
           But existing tasks stay alive, waiting for DB to recover.
           When DB comes back: /health/ready returns 200 → ALB re-adds target → traffic flows.
           No restart needed. Zero additional downtime.

VERDICT: Always use two endpoints. The distinction matters in real incidents.
```

### Decision 2: What Should the Deep Health Check Verify?

```
INCLUDE (critical path dependencies — without these, can't serve most requests):
  ✅ Database connectivity: SELECT 1 (or pool.query equivalent)
  ✅ Required configuration: critical env vars present
  ✅ If your app CANNOT function without Redis: Redis ping

EXCLUDE (non-critical or expensive):
  ❌ Third-party APIs (Stripe, SendGrid): they could be slow → health check times out.
     If Stripe is slow: your payments may fail but health endpoint should not.
     You don't want ALL tasks marked unhealthy because Stripe is responding in 3 seconds.
  ❌ S3 file operations: could be slow. Not required for most request types.
  ❌ Complex business queries: "count all active users" — 100ms+ → health check timeout.
  ❌ Cache warmup status: not a hard dependency.

RULE: only include in health check what is so critical that
  receiving requests WITHOUT IT would cause 100% of requests to fail.
  If 80% of endpoints work without Redis caching → Redis should not gate /health/ready.
```

### Decision 3: Health Check Response Time Budget

```
ALB health check timeout: 5 seconds (recommended).
Your /health/ready response must complete in < 5 seconds.

Budget breakdown:
  DB query (SELECT 1): 5-20ms normally (< 50ms under load)
  Redis ping:          1-5ms normally (< 20ms under load)
  Config checks:       < 1ms (synchronous)
  Total:               < 80ms normally

If health check is taking 1+ seconds: something is wrong BEFORE the alarms fire.

Measure health check response time:
  app.get('/health/ready', async (req, res) => {
    const start = Date.now();
    // ... checks ...
    const duration = Date.now() - start;

    // Log slow health checks as a warning:
    if (duration > 1000) {
      logger.warn({ event: 'health_check_slow', durationMs: duration });
    }

    res.status(status).json({ ...result, durationMs: duration });
  });
```

---

## SECTION 10 — Comparison Table

```
TRAP 1: "If health checks are passing, my service is working correctly."
  Health checks verify: process alive + dependencies reachable.
  They do NOT verify: correct business logic, correct responses, no bugs.
  A service can return {"success": false} on every request and still pass health checks.
  Use smoke tests after deployment + application-level error rate monitoring.

TRAP 2: "I can use a single /health endpoint for everything."
  ECS container health check + ALB target group health check are different.
  Using the same deep check for ECS health check → dependency outage = crash loop.
  ECS restarts tasks when it should just pull them from traffic temporarily.
  Use shallow liveness for ECS, deep readiness for ALB.

TRAP 3: "Setting startPeriod means my health checks won't work during startup."
  startPeriod does NOT disable health checks. It sets a grace period.
  During startPeriod: health check runs, but failures do NOT count toward retries.
  After startPeriod: failures count normally.
  So the health check still triggers — you'll see results in ECS console.
  But early failures won't kill your container before it finishes starting.

TRAP 4: "Unhealthy tasks are automatically replaced."
  Partially true. There are conditions:
  1. ECS service must have a rolling deployment or be managing the task lifecycle.
  2. The deployment circuit breaker must be enabled (for rollback on failed deploys).
  3. For running tasks in a service: ECS WILL replace UNHEALTHY tasks.
  4. For standalone tasks (not part of a service): no replacement. They just stop.
  Services (not standalone tasks) get automatic replacement on UNHEALTHY status.

TRAP 5: "Health check failure = the app is down."
  Health check failure means the ALB's health check request didn't get a 200.
  Possible non-app causes:
    • ALB health check path is wrong (typo in URL)
    • ALB is checking the wrong port
    • Security group blocking health check probe IPs
    • Network ACL blocking traffic
    First debug: curl the health endpoint from within the VPC manually.
    If it returns 200: the problem is ALB configuration, not the app.

TRAP 6: "Health checks add too much database load."
  SELECT 1 query = trivial. Almost no CPU. <1ms on any modern database.
  30-second interval × 2 tasks = 4 queries/minute = negligible.
  Even with 10 health check polling IPs per ALB = 40 queries/minute.
  RDS handles thousands of queries/second. Health checks are invisible noise.
  Don't avoid DB checks in health endpoints for "performance reasons."
```

---

## SECTION 11 — Quick Revision

```
Q1: "Walk me through how you'd implement health checks for an ECS Fargate service."

A: "Two separate endpoints with different purposes.
The first is GET /health — the liveness endpoint.
It returns 200 as long as the Node.js process is alive.
No database calls, no external checks. Just 'I'm running.'
This is configured as the ECS container health check. If it fails, ECS restarts the task.

The second is GET /health/ready — the readiness endpoint.
It verifies the database connection (SELECT 1), confirms required environment variables
are present, and optionally checks Redis.
It returns 200 if all critical dependencies are healthy, 503 if any fail.
This is configured as the ALB target group health check.
If it returns 503: ALB stops routing new requests to that task.
But the task stays alive, waiting for dependencies to recover.

On the ECS task definition, I set startPeriod to cover the maximum startup time —
typically 60 seconds for a REST API with DB migrations.
This prevents health checks from killing containers during startup."

────────────────────────────────────────────────────────────────────

Q2: "Why do you separate liveness and readiness checks?"

A: "The distinction matters during dependency failures.
If I use only one deep health check for both ECS and ALB:
when the database goes down, the health check returns 503.
ECS sees 503 from the liveness check → marks the container unhealthy → kills and restarts it.
Restarting the container doesn't fix the database. It just adds restart thrash.
Now I have a DB outage AND tasks crash-looping simultaneously.

With two separate endpoints:
ALB uses /health/ready. DB down → task gets 503 → removed from traffic.
ECS uses /health. DB down → still returns 200 → task stays alive.
When DB recovers: /health/ready returns 200 → ALB adds task back to rotation.
No restarts needed. Much faster recovery."

────────────────────────────────────────────────────────────────────

Q3: "What is the ECS deployment circuit breaker?"

A: "It's a feature that automatically rolls back a bad deployment.
Without it: if you deploy a broken image, tasks start and fail health checks.
ECS keeps trying to start new tasks, they keep failing, old tasks are gone.
The deployment just hangs with a partially broken service indefinitely.

With the circuit breaker enabled: if a certain percentage of tasks fail
their health checks during the deployment window, ECS marks the deployment FAILED
and automatically rolls back to the previous task definition revision.
Combined with rollback = true in Terraform, the old version is restored automatically.
You still get notified via EventBridge/SNS, but the service self-heals without manual intervention."
```

---

## SECTION 12 — Architect Thinking Exercise

### 5 Decision Rules

```
RULE 1: TWO ENDPOINTS — ONE FOR LIVENESS, ONE FOR READINESS
  Never use a single health check for both ECS container restart decisions
  and ALB traffic routing decisions. The response to each failure is different.
  ECS liveness failure = restart the task. ALB readiness failure = remove from rotation.

RULE 2: HEALTH CHECKS VERIFY CONNECTIVITY, NOT CORRECTNESS
  A passing health check means dependencies are reachable.
  It does NOT mean requests are being handled correctly.
  Supplement with: post-deploy smoke tests, application error rate alarms.

RULE 3: ALWAYS SET startPeriod
  Never leave startPeriod at 0 for a service with startup work.
  Measure actual startup time in staging. Add 30 seconds as buffer.
  A missing startPeriod causes crash loops on every deploy with slow startup.

RULE 4: HEALTH CHECK DEPENDENCIES = KNOWN FAILURE MODES
  Everything you include in /health/ready is a single point of failure for traffic routing.
  Including an optional service (S3, a third-party API) means that service's degradation
  removes your tasks from the load balancer. Only include HARD dependencies.

RULE 5: VERIFY HEALTH CHECK WORKS AFTER EVERY CHANGE
  New auth middleware → did you register health routes before it?
  New rate limiting → did you exclude health endpoints?
  New port mapping → did you update ALB health check port?
  Health check misconfiguration during deployment = deployment failure or security hole.
  Always manually curl the health endpoint after any middleware change.
```

### 3 Most Expensive Mistakes

```
MISTAKE 1: AUTH MIDDLEWARE APPLIED BEFORE HEALTH ROUTES
  Result: ALB health check returns 401 → all tasks marked unhealthy → service goes dark.
  Happened to a fintech team moments after a midnight deployment.
  Fix: register /health and /health/ready BEFORE any auth middleware.

MISTAKE 2: startPeriod = 0 WITH DB MIGRATIONS
  Result: crash loop on every deployment. Service never starts.
  Deployment hangs until manually intervened.
  Fix: always measure startup time and set startPeriod accordingly.

MISTAKE 3: NOT ENABLING DEPLOYMENT CIRCUIT BREAKER
  Result: bad deployment hangs your service in a partially degraded state indefinitely.
  Without circuit breaker: manual rollback required. Incident duration = detection + manual action.
  With circuit breaker: auto-rollback in minutes.
  One line in Terraform. No excuse not to enable it.
```

### 30-Second Interview Answer

```
"Health checks in ECS have two roles.

The ECS container health check is a liveness probe — it tells ECS whether to restart
a container. I implement this as a shallow /health endpoint: process alive = 200.
No database calls. DB outage should NOT cause restarts.

The ALB target group health check is a readiness probe — it tells the load balancer
whether to route traffic here. I implement this as a deep /health/ready endpoint
that verifies database connectivity and critical configuration.
DB down = 503 = removed from rotation. No restarts needed.

For ECS, I always set startPeriod to cover maximum startup time — prevents crash loops
during deployment. I also enable the ECS deployment circuit breaker for auto-rollback
when a new deployment fails health checks.

The result: dependency failures pull tasks from traffic without restarting them,
and bad deployments auto-rollback without manual intervention."
```
