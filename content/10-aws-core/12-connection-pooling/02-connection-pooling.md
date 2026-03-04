# Connection Pooling

## FILE 02 OF 03 — Production Incidents, Failure Patterns & Debugging

> **Architect Training Mode** | Senior Principal Architect Perspective
> _Optimized for: design judgement · tradeoff evaluation · failure prediction · production debugging_

---

## SECTION 5 — Real World Example

```
INCIDENT TIMELINE:
  T+0:  Lambda function deployed. Works fine in staging (low concurrency).
  T+7:  Production traffic increases. 500 concurrent Lambda invocations.
  T+8:  RDS CPU = 10%, I/O = normal. But 500 database errors in logs.
  T+9:  Error: "FATAL: remaining connection slots reserved for replication superuser"
  T+10: Lambda functions error-retrying (3 retries each) → 1,500 connection attempts
  T+15: RDS DB completely unresponsive to new connections. EXISTING queries fail.
       Cascading: API Gateway → Lambda → RDS connection flood → total outage.

ROOT CAUSE:
  Lambda: each concurrent invocation is a separate process.
  Each process: opens its OWN pg.Pool (or even raw connection per invocation).
  500 concurrent Lambda × 1 connection each = 500 connections to RDS.
  RDS db.t3.medium: max_connections = 85.

  Without RDS Proxy: Lambda cannot share a connection pool (ephemeral, per-process)
  This problem is FUNDAMENTAL to serverless — cannot be solved by app-pool only.

CORRECT FIX:
  Place RDS Proxy between Lambda and RDS:
    Lambda (500 concurrent) → RDS Proxy (accepts 500 connections internally)
    RDS Proxy → RDS (maintains only 20 real DB connections via multiplexing)

  RDS: sees 20 connections. Stays healthy. Lambda scales to thousands.

LAMBDA CONNECTION BEST PRACTICES:
  // Initialize pool OUTSIDE handler (reuse across warm invocations):

  const pool = new Pool({
    host: process.env.DB_PROXY_ENDPOINT,  // RDS Proxy endpoint, not RDS directly
    max: 1,       // Lambda: 1 connection per warm execution context (proxy multiplexes)
    min: 0,       // Don't hold idle (Lambda may be frozen)
    idleTimeoutMillis: 120000,  // 2 min (Lambda freezes, don't close aggressively)
  });

  export const handler = async (event) => {
    // pool is reused across invocations in same warm execution context
    const result = await pool.query('SELECT ...', []);
    return result.rows;
  };
```

---

## SECTION 6 — System Design Importance

```
INCIDENT:
  Application gradually slows over 12 hours. Eventually: all requests time out.
  DB has only 3 connections active of 100 configured pool connections.
  Fix: restart application containers (restores pool). Problem returns after 12 hours.

ROOT CAUSE (connection leak):
  Code review reveals: unhandled exception path that bypasses client.release()

  BUGGY CODE:
  async function dangerousQuery(userId) {
    const client = await pool.connect(); // ← borrows connection
    const result = await client.query('SELECT * FROM users WHERE id = $1', [userId]);
    if (result.rows.length === 0) {
      throw new Error('User not found'); // ← LEAK: client never released!
    }
    client.release();
    return result.rows[0];
  }

  Each "User not found" error: 1 connection leaked.
  1,000 user lookups/hour × 1% miss rate = 10 leaked connections/hour.
  12 hours = 120 leaked connections = pool exhausted.

FIX:
  async function safeQuery(userId) {
    const client = await pool.connect();
    try {
      const result = await client.query('SELECT * FROM users WHERE id = $1', [userId]);
      if (result.rows.length === 0) throw new Error('User not found');
      return result.rows[0];
    } finally {
      client.release(); // ← ALWAYS releases, even on throw
    }
  }

  BETTER: use pool.query() for single queries (auto-releases):
  const result = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);

DETECTION:
  Monitor: pool.totalCount, pool.idleCount, pool.waitingCount
  Alert: pool.waitingCount > 5 for > 30 seconds → possible leak
  Log periodic pool stats:
    setInterval(() => {
      console.log('Pool stats:', { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount });
    }, 60000);
```

---

## SECTION 7 — AWS & Cloud Mapping

```
INCIDENT:
  PgBouncer deployed in transaction pooling mode.
  Application: TypeORM with prepared statements enabled by default.
  Post-deployment: random query errors → "prepared statement 'xxx' does not exist"

ROOT CAUSE:
  Transaction pooling: server connection returned to pool after each transaction.
  Next transaction for same client: may get a DIFFERENT server connection.
  Prepared statements: cached on specific server connection.

  Sequence:
  T+1: Client A: PREPARE stmt1 AS 'SELECT ...' → executed on Server Conn-5
  T+2: Transaction ends → Conn-5 returned to pool
  T+3: Client A: EXECUTE stmt1 → get Conn-7 (different server connection)
  T+4: Server: "prepared statement 'stmt1' does not exist" → ERROR

FIX OPTIONS:
  Option A: Disable prepared statements in ORM
    TypeORM: extra.prepareThreshold = 0  (disables auto-prepare)
    Sequelize: dialectOptions: { prepareThreshold: 0 }
    node-postgres: just don't use pool.query with named statements

  Option B: Switch PgBouncer to session pooling mode
    pool_mode = session
    Drawback: less efficient (1 server connection per client session, not per transaction)
    Use when: app heavily relies on session features (prepared stmts, SET variables, cursors)

  Option C: Use RDS Proxy (handles prepared statement routing correctly in newer versions)

LESSON: understand your pooler's mode before deploying. Test with your ORM's query patterns.
```

---

## SECTION 8 — Interview Preparation

**Beginner:**

**Q: If opening a database connection is slow, how much time does it actually take?**
**A:** Opening a new PostgreSQL connection involves: TCP handshake (~1ms), SSL/TLS handshake (~5-10ms), PostgreSQL authentication (password check, ~2-5ms), session startup (setting parameters, ~1-2ms). Total: ~10-20ms per connection. For a web server processing 100 requests/second, if every request opens a new connection: 100 Ã— 15ms = 1.5 seconds of overhead per second JUST for connections â€” before any SQL runs. A connection pool opens 10-20 connections ONCE at startup, then reuses them. Result: zero connection overhead per request (borrow â†’ use â†’ return ~0.1ms).

**Q: What does it mean when a connection pool is "exhausted" and how does it affect users?**
**A:** Pool exhaustion means every connection in the pool is currently checked out by a request. A new incoming request needs a connection but finds none available. It either: (1) *Waits:* queued waiting for a connection to be returned (up to connectionTimeoutMs). If it waits too long â†’ timeout error. (2) *Fails immediately:* throws "connection pool exhausted" / "no available connections." Users see: 500 errors or very high latency during traffic spikes. This is not a database problem â€” it's a pool sizing or slow query problem (queries take too long, tying up connections).

**Q: What is the pg library's default pool behavior in Node.js?**
**A:** The pg library's Pool class: creates connections on demand (lazy), up to max (default: 10). If a request comes in and all 10 connections are busy, the request waits in queue for up to idleTimeoutMillis (default: 10 seconds) then throws. pool.query() automatically manages checkout/checkin. pool.connect() gives manual control â€” you MUST call client.release() in EVERY code path (including error paths) or you leak the connection. Safer pattern: pool.query() handles release automatically. Use pool.connect() only for transactions (where you need multiple queries on the same connection).

---

**Intermediate:**

**Q: How do you properly handle connection release in transactions?**
**A:** Transactions require a dedicated connection for all queries (so they're in the same transaction context). The danger: if you forget to release after a transaction (especially in error paths), the connection is leaked â€” eventually pool exhausts. Correct pattern:
`javascript
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query('INSERT INTO orders ...', [data]);
  await client.query('UPDATE inventory ...', [data]);
  await client.query('COMMIT');
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
} finally {
  client.release();  // ALWAYS released â€” success OR error
}
`
The inally block guarantees release regardless of exception. This is the canonical Node.js transaction pattern.

**Q: What is the max_overflow concept (SQLAlchemy) and does pg have an equivalent?**
**A:** In SQLAlchemy (Python ORM), max_overflow allows temporarily exceeding the pool max during peak load (creates extra connections, closes them when load drops). pg pool in Node.js doesn't have explicit max_overflow â€” it queues waiting requests instead. The philosophy: hard cap via max pool connections, queue excess requests. Equivalent in pg: set a higher max and trust the DB to handle it. PgBouncer's transaction pooling is a more sophisticated version: MANY application connections share FEW real DB connections, so "overflow" is handled transparently. In production: don't rely on overflow â€” right-size your pool and use PgBouncer if needed.

**Q: What are the production-critical monitoring metrics for a connection pool?**
**A:** Key metrics to expose and alert on: pool.totalCount â€” total connections (should stay â‰¤ max). pool.idleCount â€” idle connections (if always 0, pool may be too small). pool.waitingCount â€” requests waiting for a connection (should be 0; > 0 indicates pool pressure). pool.size â€” alias for totalCount. Dashboard: waitingCount over time. Alert: waitingCount > 3 for 2 consecutive minutes. In pg: pool.totalCount, pool.idleCount, pool.waitingCount. Export to Prometheus/CloudWatch custom metrics via a background interval. This is critical â€” pool exhaustion can cause a total service outage.

---

**Advanced (System Design):**

**Scenario 1:** You're designing connection pooling for a multi-tenant SaaS platform where each tenant has their own PostgreSQL schema (same RDS instance, schemas: 	enant_1, 	enant_2, etc., 200 tenants total). Your API routes requests to the correct schema with SET search_path = tenant_X at query start. Design the pool architecture.

*Challenge:* a connection pool typically reuses connections â€” but if a connection has search_path=tenant_5 set and gets reused for a 	enant_3 request, the wrong schema is queried.

*Solution 1 â€” Per-request search_path reset:*
Use a single shared pool. On every connection checkout: SELECT pg_catalog.set_config('search_path', tenantSchema, false) as the first query. This is ~1ms overhead per query. Simple but adds a round trip per request.

*Solution 2 â€” Separate pool per tenant (for large tenants):*
Create a Map<tenantId, Pool>. Small pool (max=2) per tenant. 200 tenants Ã— 2 = 400 connections â€” too many for one RDS instance. Use PgBouncer to multiplex 400 app connections into 50 real DB connections (transaction pooling mode).

*Recommendation:* Solution 1 for simplicity. Solution 2 for large tenants that need isolation. PgBouncer always.

**Scenario 2:** A senior engineer wants to set pool max=100 per ECS task "to handle high traffic." You have 20 ECS tasks. The RDS instance is db.r6g.large (max_connections=870). Should you agree? What is the risk and what's the better approach?

*Analysis:* 20 tasks Ã— 100 = 2,000 potential connections. RDS max_connections = 870. At peak, when all tasks have their pools at 80% usage: 20 Ã— 80 = 1,600 connections attempting to connect simultaneously â†’ RDS rejects connections beyond 870 â†’ errors.

*Root problem:* the senior engineer is confusing "pool size handles high traffic" with "pool size should equal concurrency needs." The pool handles concurrency by having enough connections for IN-FLIGHT queries simultaneously. If your API processes queries in 10ms, at 100 req/s per task, you need at peak: 100 req/s Ã— 0.01s = 1 connection busy at a time. A pool of 10-15 connections is sufficient for 100 req/s on a healthy DB.

*Better approach:* Keep pool max = 10 (15 tasks Ã— 10 = 150, safely under 870). For genuine scaling: add more ECS tasks (horizontal) â€” each with pool max=10. 50 tasks Ã— 10 = 500 connections â†’ still under 870. Or add PgBouncer for true scale-out.

