# Health Checks

## FILE 01 OF 03 — Core Concepts, Architecture & AWS Integration

> **Architect Training Mode** | Site Reliability Engineer Perspective
> _A service that reports healthy but cannot serve users is worse than one that reports unhealthy — because it gets traffic anyway._

---

## SECTION 1 — Intuition (Explain Like a 12-Year-Old)

```
WITHOUT HEALTH CHECKS:
  You deploy a new version. The container starts. The process runs.
  But the app panicked on startup: couldn't connect to DB. Listening but crashing on every request.
  ALB keeps routing traffic to it. Users get 500s. You get paged by users.
  ALB has no idea the task is broken — it just knows the port is open.

WITH HEALTH CHECKS:
  You deploy a new version. Container starts. Process runs.
  ALB health check: GET /health → receives connection refused (app still starting) → unhealthy.
  ALB keeps old tasks. Doesn't route to new task until /health returns 200.
  New task eventually errors: DB connection fails → /health now returns 503.
  ALB marks target unhealthy. Routes all traffic to healthy tasks only.
  Deploy is rolled back automatically (ECS sees unhealthy → stops task → restores previous).
  Zero user impact.

HEALTH CHECKS ARE USED BY:                WHAT THEY DO:
  ALB (Application Load Balancer)     →   Stop routing traffic to unhealthy targets
  ECS (Container health check)        →   Restart containers that fail checks
  ECS deployment circuit breaker      →   Roll back a bad deployment automatically
  Auto Scaling                        →   Replace unhealthy instances before scale-out
```

---

## SECTION 2 — Core Technical Explanation

```
SHALLOW HEALTH CHECK ("is the process alive?"):
  GET /health → 200 OK → {"status": "ok"}

  What it checks: is the HTTP server running and responding?
  What it does NOT check: database, Redis, external APIs, disk space, memory.

  Use case: ECS container health check (liveness check).
  Why: if the process is alive but dependencies are broken, you still want liveness reports.
  If /health returned 503 on every DB blip: ECS would restart the task constantly.
  Restarting doesn't fix a database; it just thrashes your service.

DEEP HEALTH CHECK ("can I serve requests?"):
  GET /health/ready → checks all dependencies

  What it checks: DB connection, Redis ping, critical config present, disk writable.
  Returns 503 if any critical dependency is broken.

  Use case: ALB target group health check (readiness check).
  Why: if DB is down, you don't want the task receiving new requests.
  Remove it from rotation (503 → ALB marks unhealthy).
  But don't restart it (still alive, just unready).

LIVENESS vs READINESS (Kubernetes terms, applicable to ECS too):
  Liveness = "Is this container worth keeping alive?"
    If no → kill it and start a fresh one.
    Triggered by: infinite loop, deadlock, corrupted state.
    ECS: container health check that kills + restarts.

  Readiness = "Should this container receive traffic right now?"
    If no → take it out of load balancer rotation BUT keep it alive.
    Triggered by: DB connection lost, downstream service unavailable, warming up.
    ALB: health check that routes traffic to other targets.

PRACTICAL ECS PATTERN:
                         ┌──────────────────────────────────┐
  ECS Container Check → │ GET /health (shallow)            │
                         │ Returns 200 if process is alive  │
                         │ Used by ECS to decide: kill?     │
                         └──────────────────────────────────┘

                         ┌──────────────────────────────────┐
  ALB Target Group  →   │ GET /health/ready (deep)         │
                         │ Returns 200 if all deps healthy  │
                         │ Used by ALB to decide: route?    │
                         └──────────────────────────────────┘
```

---

## SECTION 3 — Architecture Diagram (MANDATORY)

```typescript
// app.ts — health check endpoints

import express from "express";
import { pool } from "./db"; // pg-pool instance
import { redisClient } from "./redis"; // Redis client

const app = express();

// ──────────────────────────────────────────────────────────
// LIVENESS CHECK (ECS container health check)
// Fast. No external calls. Just "is the process awake?"
// ──────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    timestamp: new Date().toISOString(),
    version: process.env.APP_VERSION ?? "unknown",
    uptime: Math.floor(process.uptime()),
  });
});

// ──────────────────────────────────────────────────────────
// READINESS CHECK (ALB target group health check)
// Checks all dependencies. Used to gate traffic routing.
// ──────────────────────────────────────────────────────────
app.get("/health/ready", async (req, res) => {
  const checks: Record<
    string,
    { ok: boolean; latencyMs?: number; error?: string }
  > = {};
  let allOk = true;

  // Check 1: Database connectivity
  const dbStart = Date.now();
  try {
    await pool.query("SELECT 1");
    checks.database = { ok: true, latencyMs: Date.now() - dbStart };
  } catch (err: any) {
    checks.database = { ok: false, error: err.message };
    allOk = false; // DB failure = not ready to serve requests
  }

  // Check 2: Redis connectivity (if applicable)
  if (redisClient) {
    const redisStart = Date.now();
    try {
      await redisClient.ping();
      checks.redis = { ok: true, latencyMs: Date.now() - redisStart };
    } catch (err: any) {
      checks.redis = { ok: false, error: err.message };
      // Redis failure: mark unhealthy ONLY if Redis is required for ALL operations.
      // If Redis is used only for caching, consider leaving allOk = true.
      // Service can degrade gracefully (slower, no cache) while still serving requests.
    }
  }

  // Check 3: Required environment variables present
  const requiredEnv = ["DATABASE_URL", "JWT_SECRET", "PORT"];
  const missingEnv = requiredEnv.filter((key) => !process.env[key]);
  if (missingEnv.length > 0) {
    checks.config = { ok: false, error: `Missing: ${missingEnv.join(", ")}` };
    allOk = false;
  } else {
    checks.config = { ok: true };
  }

  const status = allOk ? 200 : 503;
  res.status(status).json({
    status: allOk ? "ready" : "not_ready",
    checks,
    timestamp: new Date().toISOString(),
  });
});

// IMPORTANT: register health routes BEFORE any auth middleware
// Auth middleware might reject requests without tokens
// ALB health check has no auth token → would get 401 → marked unhealthy → disaster
```

---

## SECTION 4 — Request Flow (MANDATORY FLOWCHART)

```
HOW ALB HEALTH CHECKS WORK:
  Every healthCheckIntervalSeconds: ALB sends a request to each registered target.
  If response is in healthyHttpCodes range AND within healthCheckTimeoutSeconds: healthy.
  If 'unhealthyThresholdCount' consecutive failures: target marked UNHEALTHY.
    → ALB stops sending traffic to this target.
  If 'healthyThresholdCount' consecutive successes: target marked HEALTHY again.
    → ALB resumes sending traffic.

TERRAFORM CONFIGURATION:
  resource "aws_lb_target_group" "api" {
    name        = "api-prod"
    port        = 8080
    protocol    = "HTTP"
    vpc_id      = var.vpc_id
    target_type = "ip"     # required for Fargate

    health_check {
      enabled             = true
      path                = "/health/ready"   # use the deep check for ALB
      port                = "traffic-port"    # same port as main traffic
      protocol            = "HTTP"
      matcher             = "200"             # only 200 counts as healthy
      interval            = 30               # check every 30 seconds
      timeout             = 5                # must respond within 5 seconds
      healthy_threshold   = 2                # 2 consecutive successes → healthy
      unhealthy_threshold = 3               # 3 consecutive failures → unhealthy
    }
  }

PARAMETER TUNING GUIDE:
  interval (30s default):
    Lower = faster detection of unhealthy targets, but more health check traffic.
    For payment services: consider 10s. For non-critical: 30s is fine.

  timeout (5s default):
    Must be < interval. Set to expected max response time for /health/ready.
    If DB query in health check takes 2s: set timeout to 4s.
    If timeout too low: health check times out even when app is healthy → unnecessary failures.

  healthy_threshold (2 default):
    Lower = quicker recovery when service comes back online.
    Keep at 2 for production.

  unhealthy_threshold (3 default):
    Lower = faster removal of bad targets. Can set to 2 for critical services.
    Higher = more tolerant of transient blips. Reduces false positives.

AFTER UNHEALTHY: how long until traffic stops?
  3 failures × 30 second interval = up to 90 seconds of bad traffic.
  Reduce to: unhealthy_threshold = 2, interval = 10 → 20 seconds.
  This is the right setting for payment-critical services.
```

---

### ECS Container Health Check

```
HOW ECS CONTAINER HEALTH CHECK DIFFERS FROM ALB:
  ALB health check: ALB server sends HTTP request to your container's IP.
  ECS container health check: runs a COMMAND INSIDE your container.
  They operate independently and do different things.

ECS HEALTH CHECK → decides if the CONTAINER should be restarted.
ALB HEALTH CHECK → decides if the TARGET should receive TRAFFIC.

ECS TASK DEFINITION:
  {
    "name": "api",
    "image": "123456789.dkr.ecr.us-east-1.amazonaws.com/api:latest",
    "healthCheck": {
      "command": ["CMD", "curl", "-f", "http://localhost:8080/health", "||", "exit", "1"],
      "interval": 30,          // seconds between checks
      "timeout": 5,            // seconds to wait for response
      "retries": 3,            // failures before marked UNHEALTHY
      "startPeriod": 60        // grace period on startup (don't check for 60 seconds)
    }
  }

startPeriod IS CRITICAL:
  Application startup takes time: DB migrations, loading config, warming caches.
  Without startPeriod: health check fires during startup → fails → task killed → restarts.
  Crash loop during every deployment.

  Set startPeriod to: max startup time + 30 second buffer.
  If app starts in 15-20 seconds: startPeriod = 60.
  If app runs DB migrations (can take minutes): startPeriod = 300.

ALTERNATIVE: use wget if curl not in your image:
  "command": ["CMD-SHELL", "wget -q -O /dev/null http://localhost:8080/health || exit 1"]

TASK HEALTH STATES:
  HEALTHY   — health check passing. Task running normally.
  UNHEALTHY — health check failed retries times. ECS will kill and replace this task.
  UNKNOWN   — health check not yet run, or no health check configured.

  Note: UNKNOWN ≠ unhealthy. Tasks without health checks are always UNKNOWN.
  Add an ECS health check to move tasks from UNKNOWN to HEALTHY/UNHEALTHY.
```

---

### ECS Deployment Circuit Breaker

```
WHAT IS IT?
  A safety net for bad deployments.

  Without circuit breaker:
    Deploy bad image → tasks crash loop → ECS keeps trying forever.
    50% bad tasks, 50% healthy old tasks. PARTIAL OUTAGE for hours.
    You don't even know the deploy is stuck (no alarm for this by default).

  With circuit breaker:
    Deploy bad image → tasks fail health checks → circuit breaker trips.
    ECS automatically rolls back to previous version.
    Old tasks restored. Service healthy again. You're notified via EventBridge.
    Total bad time: 5-10 minutes (time to detect + rollback) instead of hours.

TERRAFORM:
  resource "aws_ecs_service" "api" {
    name            = "api"
    cluster         = aws_ecs_cluster.prod.id
    task_definition = aws_ecs_task_definition.api.arn
    desired_count   = 2

    deployment_circuit_breaker {
      enable   = true
      rollback = true   # auto-rollback on failure
    }

    deployment_controller {
      type = "ECS"  # required for circuit breaker (not CodeDeploy)
    }
  }

CIRCUIT BREAKER LOGIC:
  ECS watches failed vs successful tasks during deployment.
  If failure rate crosses threshold: deployment marked FAILED, rollback triggered.
  Specifically: if 50% of tasks fail within the deployment window → rollback.

RECEIVE NOTIFICATIONS:
  EventBridge rule to catch deployment failures:
  {
    "source": ["aws.ecs"],
    "detail-type": ["ECS Deployment State Change"],
    "detail": {
      "eventType": ["ERROR"],
      "eventName": ["SERVICE_DEPLOYMENT_FAILED"]
    }
  }
  → Route to SNS → Slack channel.
```

---

### Startup Order Problem (Service Depends on DB)

```
PROBLEM:
  ECS task starts. App starts immediately. Tries to connect to DB.
  DB is up, but VPC DNS resolution takes 2 seconds.
  Or: DB is restarting.
  App crashes. ECS restarts. Crash loop until DB is ready.

SOLUTION: health check with retry logic at startup:

  // server.ts — wait for DB before starting to serve traffic
  async function waitForDatabase(maxAttempts = 10, delayMs = 3000): Promise<void> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await pool.query('SELECT 1');
        console.log('Database connection established');
        return;
      } catch (err) {
        console.warn(`DB connection attempt ${attempt}/${maxAttempts} failed:`, err.message);
        if (attempt === maxAttempts) throw err;
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }

  async function start() {
    try {
      await waitForDatabase();      // wait up to 30s for DB

      app.listen(8080, () => {
        console.log('Server listening on port 8080');
      });
    } catch (err) {
      console.error('Fatal: cannot connect to database', err);
      process.exit(1);              // exit cleanly. ECS will restart the task.
    }
  }

  start();

COMBINED WITH startPeriod = 60:
  DB retry: up to 10 attempts × 3 seconds = 30 seconds of retrying.
  startPeriod = 60 gives us the full 30 seconds without ECS health checks firing.
  After 30 seconds: either connected (tasks become HEALTHY) or process.exit(1) (ECS restarts).
```
