# DB Connection Pooling (Production View)

## FILE 01 OF 03 — Core Concepts, Pool Architecture & Configuration

> **Architect Training Mode** | Site Reliability Engineer Perspective
> _Connection pool exhaustion is one of the most common causes of production outages. Get this right and a whole class of 2am incidents disappears._

---

## SECTION 1 — Intuition (Explain Like a 12-Year-Old)

```
WITHOUT A POOL:
  Every HTTP request opens a new TCP connection to PostgreSQL.
  TCP handshake: 10ms. TLS: 20ms. PostgreSQL auth: 15ms. Total: ~45ms overhead per request.
  At 100 RPS: 100 new connections/second.
  PostgreSQL max_connections default: 100.
  That's 100 connections just for idle connections sitting open after requests.
  Any burst above 100 RPS: new connection attempt → PostgreSQL "sorry, too many connections" → request fails.

WITH A POOL (pg-pool):
  Application startup: pool creates N connections (N = pool size, e.g. 10).
  Connections stay open permanently. No handshake overhead per request.
  Request 1 arrives → borrows a connection → runs query → returns connection.
  Request 2 arrives simultaneously → borrows another → runs query → returns.
  10 simultaneous requests: all served from the pool.
  Request 11: waits up to connectionTimeoutMillis for a connection to be returned.
  Average query time 50ms: 10 connections × (1000ms / 50ms) = 200 RPS capacity.
  Overhead per request: 0ms (no TCP handshake, connection already exists).

WHY A POOL RATHER THAN ONE CONNECTION:
  One shared connection: requests queue up serially. Request 2 waits for request 1 to finish.
  At 100ms avg query: one connection handles max 10 RPS.
  Pool of 10: 10× throughput with same DB cost. Pool of 20: 20×.
  But: PostgreSQL has a connection limit. You can't just set pool size = 1000.
  The pool size × tasks × services must stay under PostgreSQL max_connections with headroom.
```

---

## SECTION 2 — Core Technical Explanation

```
THE FORMULA:

  Max connections allowed by this service =
    (RDS max_connections × safety_factor) ÷ (services × tasks per service)

WHERE:
  RDS max_connections = function of RDS instance memory.
    RDS formula: LEAST(DBInstanceClassMemory/9531392, 5000)
    db.t3.micro (1GB):   ~87 connections
    db.t3.small (2GB):   ~193 connections
    db.t3.medium (4GB):  ~420 connections
    db.r5.large (16GB):  ~1704 connections

  safety_factor = 0.8 (leave 20% for RDS admin connections, replica connections, migrations)

  services = how many different ECS services connect to this RDS instance
  tasks per service = ECS desired count × max scaling count

EXAMPLE:
  RDS instance: db.t3.medium → ~420 max_connections
  Safety headroom: 420 × 0.8 = 336 usable connections
  Services connecting: 3 (api, worker, scheduler)
  Tasks per service: 2-4 tasks
    api:       4 tasks (2 normal, scales to 4)
    worker:    2 tasks
    scheduler: 1 task
    Total tasks: 4 + 2 + 1 = 7 tasks

  Per-task connection budget: 336 ÷ 7 ≈ 48 connections per task

  BUT: save some for:
    Database migrations (might need 5-10 connections during deploy)
    DBA queries / performance debugging
    RDS Performance Insights: 1 connection

  Practical pool size per task: 48 × 0.7 = ~33 connections
  Round down to a safe number: pool size = 10-20 per task.

  Why not use all 33?
    Bursts: if all services scale to max simultaneously → connection surge.
    Headroom = you don't get OOM-killed at peak traffic.

SIMPLE SAFE DEFAULT:
  Most production services: pool size = 10.
  High-throughput APIs: pool size = 20.
  Background workers (lower concurrency): pool size = 5.
  Cron/scheduler (one at a time): pool size = 2-3.
```

---

## SECTION 3 — Architecture Diagram (MANDATORY)

```typescript
// db.ts — production-ready pg-pool configuration
import { Pool } from "pg";
import { logger } from "./logger";

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,

  // ── POOL SIZE ──────────────────────────────────
  max: 10, // maximum connections in pool
  min: 2, // keep at least 2 connections warm at all times
  // min prevents cold-start latency: connections exist before requests arrive.

  // ── TIMEOUT SETTINGS ──────────────────────────
  connectionTimeoutMillis: 5000,
  // How long to wait for a FREE connection from the pool.
  // If all 10 connections are busy for > 5s: throw PoolExhaustedError.
  // Set this to your request timeout minus overhead (e.g. 5s if request timeout is 10s).

  idleTimeoutMillis: 30_000,
  // After a connection is returned to pool: if unused for 30s, close it.
  // Prevents idle connections from being killed by PostgreSQL/RDS idle timeout.
  // Set LOWER than RDS idle client timeout (default: no timeout, but some configs have it).

  // ── HEALTH CHECKS ─────────────────────────────
  allowExitOnIdle: false,
  // Don't let the pool process exit when all connections are idle.
  // For long-running servers: always false.

  // ── SSL (always for production RDS) ───────────
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: true }
      : false,

  // ── STATEMENT TIMEOUT ─────────────────────────
  // Set per-query if needed:
  // await pool.query({ text: 'SELECT ...', timeout: 10000 })
  // Or globally via PostgreSQL parameter:
  // statement_timeout = 30000  (in RDS parameter group or SET command)
});

// ── POOL EVENT MONITORING ──────────────────────
pool.on("connect", (client) => {
  logger.debug({ event: "db_pool_connection_created" });
});

pool.on("acquire", (client) => {
  logger.debug({ event: "db_pool_connection_acquired" });
});

pool.on("remove", (client) => {
  logger.debug({ event: "db_pool_connection_removed" });
});

pool.on("error", (err, client) => {
  // A pool client had an error OUTSIDE of a query (e.g. DB restarted).
  // Log it. The pool will remove the client and create a new one.
  logger.error({ event: "db_pool_idle_client_error", error: err.message });
});

// ── EXPORT POOL STATS FUNCTION ─────────────────
export function getPoolMetrics() {
  return {
    total: pool.totalCount, // total connections in pool (active + idle)
    idle: pool.idleCount, // currently idle (waiting for queries)
    waiting: pool.waitingCount, // requests waiting for a free connection
  };
}
```

---

## SECTION 4 — Request Flow (MANDATORY FLOWCHART)

```typescript
// Emit pool metrics every 30 seconds for monitoring and alerting:
setInterval(async () => {
  const metrics = getPoolMetrics();

  await cloudWatch.send(
    new PutMetricDataCommand({
      Namespace: "MyApp/Database",
      MetricData: [
        {
          MetricName: "PoolTotalConnections",
          Value: metrics.total,
          Unit: "Count",
          Dimensions: [
            { Name: "Service", Value: "api" },
            { Name: "Environment", Value: "production" },
          ],
        },
        {
          MetricName: "PoolIdleConnections",
          Value: metrics.idle,
          Unit: "Count",
          Dimensions: [
            { Name: "Service", Value: "api" },
            { Name: "Environment", Value: "production" },
          ],
        },
        {
          MetricName: "PoolWaitingClients",
          Value: metrics.waiting,
          Unit: "Count",
          Dimensions: [
            { Name: "Service", Value: "api" },
            { Name: "Environment", Value: "production" },
          ],
        },
      ],
    }),
  );
}, 30_000);

// CloudWatch Alarm on PoolWaitingClients:
// resource "aws_cloudwatch_metric_alarm" "pool_waiting" {
//   alarm_name  = "db-pool-waiting-clients"
//   namespace   = "MyApp/Database"
//   metric_name = "PoolWaitingClients"
//   threshold   = 3    // 3+ requests waiting for a connection
//   comparison_operator = "GreaterThanOrEqualToThreshold"
//   evaluation_periods  = 2
//   period              = 60
//   statistic           = "Maximum"
//   alarm_description   = "P2: DB pool congestion — connection bottleneck forming"
//   alarm_actions       = [aws_sns_topic.p2.arn]
// }
```

---

### Connection Pool in ECS: The Math

```
SCENARIO: Production system load test

  Service: api (Node.js Express)
  ECS: desired_count = 3, max_count = 6 (auto-scaling)
  Pool size per task: 10
  RDS instance: db.t3.medium (~420 max_connections)
  Total services connecting to RDS: api + worker (2 services)

  NORMAL LOAD (3 tasks):
    api: 3 tasks × 10 connections = 30 connections to RDS
    worker: 2 tasks × 5 connections = 10 connections to RDS
    Total: 40 / 420 = 9.5% of RDS capacity used. Safe.

  PEAK LOAD (api scales to 6):
    api: 6 tasks × 10 connections = 60 connections to RDS
    worker: 2 tasks × 5 connections = 10 connections to RDS
    Total: 70 / 420 = 16.7% used. Safe.

  ACCIDENTAL MISCONFIG (pool size = 100 per task):
    Normal: 3 × 100 = 300 connections for api alone.
    + worker 10 = 310. That's 73.8% of 420. Getting close.
    Scale to 6 tasks: 600 + 10 = 610 > 420. OVERFLOW. RDS refuses connections.
    Service crashes. All connections fail.
    This happens in production more than teams expect.

  RULE: pool size × max ECS tasks × number of services < (RDS max_connections × 0.75)
  Solve for pool size: pool size < (420 × 0.75) / (6 × 2) = 315 / 12 = 26.25
  Safe pool size: 10-20. Not 100.

PgBouncer (for very high connection counts):
  If you have 20+ ECS tasks × 20 pool size = 400 connections hitting RDS:
  Add PgBouncer as a connection pooler BETWEEN your app and RDS.
  PgBouncer holds the app connections in pooling mode:
    App: 400 logical connections to PgBouncer.
    PgBouncer: 50 real connections to RDS.
  Multiplexes many app connections through fewer RDS connections.
  AWS alternative: RDS Proxy (managed, no infra to run).
```

---

### RDS Proxy (AWS Manages Pooling)

```
WHAT RDS PROXY DOES:
  Sits between your ECS tasks and RDS.
  Accepts thousands of application connections.
  Maintains a small, efficient connection pool to RDS.
  Handles connection reuse, failover, and health automatically.

WHEN TO USE RDS PROXY:
  Lambda → RDS: Lambda invocations create a new connection per invocation.
    Without proxy: 1000 concurrent Lambdas = 1000 new RDS connections. Pool exhaustion.
    With proxy: 1000 Lambdas → RDS Proxy pool → 20 connections to RDS. Works fine.

  Microservices × ECS tasks: when math shows you're approaching max_connections.
  High churn connections: serverless or burst workloads that open/close connections frequently.

COST: ~$0.015/vCPU-hour + $0.015/GB of storage provisioned for proxy.
For small applications: adds ~$15-30/month.
Cheaper than engineering time debugging connection pool issues.

WHEN NOT NEEDED:
  Small application: 1-3 ECS tasks × pool size 10 = 10-30 connections.
  Long-lived ECS tasks with stable pool: RDS Proxy overhead not justified.
  Standard use case: pg-pool configured correctly is sufficient.

Terraform:
  resource "aws_db_proxy" "main" {
    name                   = "api-prod-proxy"
    debug_logging          = false
    engine_family          = "POSTGRESQL"
    idle_client_timeout    = 1800
    require_tls            = true
    role_arn               = aws_iam_role.rds_proxy.arn
    vpc_security_group_ids = [aws_security_group.rds_proxy.id]
    vpc_subnet_ids         = var.private_subnet_ids

    auth {
      auth_scheme = "SECRETS"
      description = "RDS credentials"
      iam_auth    = "DISABLED"
      secret_arn  = aws_secretsmanager_secret.db_credentials.arn
    }
  }

  # App connects to proxy endpoint instead of RDS directly:
  # DATABASE_URL = postgresql://user:pass@proxy-endpoint:5432/dbname
```

---

### Production Readiness Checklist

```
POOL CONFIGURATION
  [ ] max pool size calculated using formula: fits under RDS max_connections × 0.75
  [ ] min pool size = 2 (avoid cold-start latency)
  [ ] connectionTimeoutMillis < request timeout (throw before request times out)
  [ ] idleTimeoutMillis < RDS idle connection timeout
  [ ] SSL enabled in production (rejectUnauthorized: true)
  [ ] pool.on('error') handler logs idle client errors without crashing

MONITORING
  [ ] PoolWaitingClients metric emitted to CloudWatch every 30s
  [ ] PoolWaitingClients > 3 triggers P2 alarm
  [ ] RDS DatabaseConnections metric monitored (> 80% max = P2)

CLEANUP
  [ ] pool.end() called during graceful shutdown
  [ ] pool.end() called before process.exit() in uncaught exception handler

SCALING MATH
  [ ] Verified: max tasks × pool size × service count < RDS max_connections × 0.75
  [ ] If approaching limit: RDS Proxy or larger RDS instance in roadmap
```
