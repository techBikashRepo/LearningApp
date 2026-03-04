# DB Connection Pooling (Production View)

## FILE 03 OF 03 — Design Decisions, Exam Traps & Architect's Mental Model

> **Architect Training Mode** | Site Reliability Engineer Perspective

---

## SECTION 9 — Certification Focus (AWS SAA-C03)

### Decision 1: pg-pool vs RDS Proxy vs PgBouncer

```
PG-POOL (client-side pooling):
  The pg library's built-in pool. Runs inside your Node.js process.
  ✅ Zero infrastructure to manage.
  ✅ Works for 95% of production ECS applications.
  ✅ Connection lifecycle fully controlled in your code.
  ❌ Each ECS task maintains its own pool — no sharing between tasks.
  ❌ Pool dies with the task. New task = cold connection warmup on startup.
  CHOOSE: always start here. Add the others only when you hit their specific problems.

RDS PROXY (AWS managed server-side pooling):
  ✅ Multiplexes hundreds of app connections down to a small RDS connection pool.
  ✅ Handles RDS failover automatically (Multi-AZ switchover transparent to apps).
  ✅ IAM authentication without passing DB credentials to app.
  ✅ Connection pooling for Lambda (new connections per invocation = RDS killer without proxy).
  ❌ $15-30/month per endpoint. Adds another network hop (~1ms latency).
  ❌ Only supports specific engine/auth combinations.
  CHOOSE: when Lambda connects to RDS, or total connections approaching max_connections.

PGBOUNCER (self-hosted server-side pooling):
  ✅ Extremely efficient: thousands of app connections → dozens of RDS connections.
  ✅ Transaction pooling mode is more aggressive than session pooling.
  ✅ Free. Very mature and stable.
  ❌ Another container to run, configure, monitor, and maintain.
  ❌ Some pg features don't work with PgBouncer in transaction mode (prepared statements).
  CHOOSE: when you need RDS Proxy-level connection multiplexing but want more control.

DECISION TREE:
  Lambda → RDS?                      → RDS Proxy (Lambda has no persistent process for pooling)
  ECS → RDS, connections < 200?      → pg-pool (default config above) — sufficient
  ECS → RDS, connections 200-500?    → pg-pool + RDS Proxy
  ECS → RDS, > 20 services/tasks?    → RDS Proxy or PgBouncer
  Need Multi-AZ failover in < 30s?   → RDS Proxy (proxies transparently to new primary)
```

### Decision 2: Pool Sizing in Auto-Scaling Environments

```
PROBLEM WITH AUTO-SCALING:
  Pool size × max ECS tasks determines peak RDS connections.
  But "max ECS tasks" includes the maximum of your auto-scaling target.

  If you set:
    pool size = 10, max ECS tasks = 20
    Peak connections from this service = 200

  And you have 3 services, same config:
    Peak total = 600 connections
    db.t3.medium: 420 max_connections
    OVERFLOW: service degradation at peak traffic when you need it most.

  You need to plan for MAX capacity, not average capacity.

FORMULA REMINDER:
  pool size ≤ (RDS max_connections × 0.75) ÷ (max_tasks_across_all_services)

DYNAMIC POOL SIZING OPTION:
  Read pool max from environment variable:

    max: parseInt(process.env.DB_POOL_MAX ?? '10')

  Set it via SSM Parameter Store → ECS task definition env var.
  If you need to increase: update SSM, redeploy. No code change.
  Allows tuning per environment (dev: 3, staging: 5, prod: 10).
```

### Decision 3: Transaction Patterns — When to Use Raw Client vs pool.query

```
USE pool.query() whenever possible:
  Automatically acquires and releases the connection.
  Zero risk of connection leaks.
  Simpler code.

  const users = await pool.query('SELECT * FROM users WHERE active = $1', [true]);

USE pool.connect() ONLY for multi-statement transactions:
  Must use a single connection for the entire transaction.
  BEGIN, multiple queries, COMMIT/ROLLBACK — all on the same client.

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE accounts SET balance = balance - $1 WHERE id = $2', [amount, fromId]);
    await client.query('UPDATE accounts SET balance = balance + $1 WHERE id = $2', [amount, toId]);
    await client.query('INSERT INTO transfers (from_id, to_id, amount) VALUES ($1, $2, $3)', [fromId, toId, amount]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();  // ← never forget this
  }

TRANSACTION HELPER (extract to reduce boilerplate):
  async function withTransaction<T>(
    fn: (client: PoolClient) => Promise<T>
  ): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // Usage:
  const result = await withTransaction(async (client) => {
    await client.query('UPDATE ...', [...]);
    await client.query('INSERT ...', [...]);
    return { success: true };
  });
```

---

## SECTION 10 — Comparison Table

```
TRAP 1: "More connections = better performance."
  Reality: connections consume PostgreSQL memory and CPU for switching between them.
  PostgreSQL is highly optimized for concurrent queries, but not unlimited connections.
  Rule from PgBouncer documentation: optimal concurrent connections ≈ CPU cores × 2-4.
  For db.t3.medium (2 vCPU): optimal active connections = 4-8.
  Beyond this: connections queue inside PostgreSQL waiting for CPU. More connections = slower.

  A pool of 10 connections with efficient queries outperforms 100 connections with slow queries.

TRAP 2: "pg-pool max = 10 means max 10 concurrent requests."
  max = 10 means max 10 CONCURRENT DB OPERATIONS, not requests.
  A request that does 3 queries holds a connection for the duration of those 3 queries.
  A request that does no DB queries: holds no connection.
  Pool of 10 × requests averaging 50ms query time = 200 RPS DB capacity.
  That's more than most applications ever need.

TRAP 3: "PoolExhaustedError means the database is overwhelmed."
  Pool exhaustion can happen when the DB is at 5% CPU.
  It means your POOL is full — not the database.
  Debug: check PoolWaitingClients metric, check query patterns (sequential vs parallel),
  check for connection leaks (poolTotal < max).
  Don't scale the database — fix the pool configuration or query patterns.

TRAP 4: "pool.end() during shutdown closes all connections immediately."
  pool.end() waits for all checked-out clients (active queries) to finish,
  then closes all connections.
  It's graceful: active queries complete before connections are closed.
  If you have a query running for 30 seconds when shutdown starts:
  pool.end() will wait 30 seconds. Make sure this fits within your shutdown window.

TRAP 5: "No need to handle pool client errors — pg-pool auto-recovers."
  pg-pool DOES auto-recover from idle client errors (DB restart, network glitch).
  BUT: without pool.on('error') handler: unhandled error → Node.js crash.
  The unhandled 'error' event on EventEmitter throws if no listener is registered.
  Always register pool.on('error') — even if it just logs. Prevents silent crashes.

TRAP 6: "RDS Proxy solves all connection problems."
  RDS Proxy helps with connection count at scale.
  It does NOT help with:
    Pool leaks in your application code (still need to fix client.release() patterns)
    Slow queries (queries slow down with proxy as with direct connection)
    Pool exhaustion due to high concurrency within one task (app pool still needed)
  RDS Proxy multiplexes connections at the network level. Your app still needs a pool.
```

---

## SECTION 11 — Quick Revision

```
Q1: "How do you size a connection pool for production?"

A: "I use the formula: pool size = RDS max_connections × 0.75 ÷ max total ECS tasks.
RDS max_connections depends on instance size — db.t3.medium gives about 420 connections.
With a safety factor of 0.75, that's 315 usable connections.
Divided across all services and their maximum task counts.
If I have 3 services × 6 tasks max = 18 tasks: 315 / 18 = ~17 per task.
I'd round down to 10-15 and keep headroom for migrations and admin connections.
The key insight: you size for max scaling capacity, not average load."

────────────────────────────────────────────────────────────────────

Q2: "Walk me through debugging a PoolExhaustedError in production."

A: "First, confirm it's a pool issue, not a DB issue.
PoolExhaustedError with RDS at 10% CPU = pool problem, not database problem.

Second, check the pool metrics I emit to CloudWatch:
poolWaiting, poolIdle, poolTotal. If waiting > 0 and idle = 0: pool exhausted.
If poolTotal < max pool size: there's a connection leak.

Third, check query patterns. Are requests making sequential DB calls
that could be parallelized? A single request holding a connection for 2 seconds
while making 10 sequential queries blocks 10× more pool capacity than necessary.

Immediate fix: scale ECS tasks to multiply available pool capacity.
Root cause fix: parallelize independent queries with Promise.all(),
reduce connection hold time, or increase pool size if the math permits."

────────────────────────────────────────────────────────────────────

Q3: "When would you use RDS Proxy?"

A: "Two main scenarios.
Lambda connecting to RDS: Lambda creates a new process per invocation.
Without RDS Proxy, each invocation potentially opens a new DB connection.
At 1000 concurrent Lambdas, that's 1000 connections to RDS, which exhausts most instances.
RDS Proxy pools those connections down to a manageable number.

The second scenario is multi-AZ failover. When a primary RDS instance fails,
ECS tasks have existing TCP connections to the old primary that must be retried.
With RDS Proxy: the failover is handled at the proxy level.
Applications see a brief pause but don't need to reconnect to a new endpoint.
Without proxy: apps might need 60-120 seconds to detect and recover from the failover."
```

---

## SECTION 12 — Architect Thinking Exercise

### 5 Decision Rules

```
RULE 1: pool.query() OVER pool.connect() — ALWAYS FOR SINGLE QUERIES
  pool.query() auto-releases. pool.connect() requires manual release.
  Manual release in a finally block is error-prone.
  Only use pool.connect() when you need a multi-statement transaction.

RULE 2: POOL SIZE × ALL TASKS × ALL SERVICES < RDS MAX_CONNECTIONS × 0.75
  Do this math BEFORE deploying. Not after you hit pool exhaustion.
  Include auto-scaling max counts, not just current counts.
  Leave 25% headroom for admin, monitoring, migrations.

RULE 3: MONITOR poolWaiting — NOT JUST RDS CONNECTIONS
  RDS DatabaseConnections metric shows connections ESTABLISHED.
  It does NOT show app requests WAITING for a connection.
  poolWaiting > 0 is the early warning signal. Act on it before errors occur.
  Alarm on poolWaiting > 3 (early warning), not after PoolExhaustedErrors.

RULE 4: ALWAYS pool.on('error') — PREVENTS SILENT CRASHES
  Idle client errors are normal (network blips, RDS restarts).
  Without an error handler: unhandled EventEmitter error → Node.js process crash.
  The handler doesn't need to do much — just log and let pg-pool recover.

RULE 5: DESIGN FOR FAST CONNECTIONS, NOT SLOW TRANSACTIONS
  The pool is a shared resource. A request that holds a connection for 5 seconds
  to do 10 sequential queries is starving other requests.
  Parallelize independent queries. Minimize transaction scope.
  Short-lived connections = higher throughput from the same pool size.
```

### 30-Second Interview Answer

```
"Connection pooling solves two problems: connection overhead and connection limits.

Without a pool: each request opens and closes a DB connection — 45ms overhead plus
PostgreSQL max_connections exhausted at moderate traffic.

With pg-pool: connections are reused. Pool of 10 handles 200+ RPS at 50ms avg queries.

For production sizing: pool size = RDS max_connections × 0.75 ÷ total max ECS tasks.
For db.t3.medium with 3 services of 6 tasks each: 315 / 18 = ~17 per task, round to 10-15.

I monitor PoolWaitingClients metric — that's the early warning before exhaustion.
Pool errors handler on pool.on('error') prevents crashes from idle client disconnects.
RDS Proxy for Lambda or when total connections approach RDS limits."
```
