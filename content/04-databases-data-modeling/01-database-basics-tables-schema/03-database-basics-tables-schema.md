# Database Basics: Tables & Schema — Part 3 of 3

### Sections: 9 (AWS Mapping), 10 (Interview Questions), 11 (Debugging Exercise), 12 (Architect's Mental Model)

**Series:** Databases & Data Modeling → Topic 01

---

## SECTION 9 — AWS Mapping

### RDS vs Aurora: When Each Decision Makes Sense

```
RDS (Relational Database Service):
  Managed Postgres/MySQL/SQL Server running on a single EC2 instance behind the scenes.
  You pick: instance class, storage, Multi-AZ.

  WHEN TO USE RDS:
  • Predictable steady-state workload (< 10K queries/sec)
  • Budget-conscious: Aurora is ~20% more expensive in compute
  • Need specific Postgres extension not supported by Aurora (PostGIS full version, etc.)
  • Single-region, single-AZ acceptable (dev/staging)

  WHEN NOT TO USE RDS:
  • Workload grows unpredictably (RDS: scale up = downtime for instance class change)
  • Traffic spikes need read scale-out (RDS: max 5 read replicas, manual failover)
  • Replication needs to be near-instant (RDS: async replication → read replica lag 10-100ms)

AURORA (PostgreSQL-compatible):
  Storage layer decoupled from compute. Shared 6-way replicated storage across 3 AZs.

  WHEN TO USE AURORA:
  • Need fast failover: Aurora failover <30 seconds (vs RDS: ~60-120 seconds)
  • Read scale: up to 15 read replicas, all sharing same storage (no replication lag on reads)
  • Aurora Serverless v2: auto-scales compute in 0.5 ACU increments — ideal for variable traffic
  • Multi-region: Aurora Global Database → <1s replication cross-region

  AURORA CATCH: you pay for storage even when idle. Dev environments: Aurora Serverless v2
  with min ACU=0.5 (pauses when idle). For production: never set min ACU=0 (cold start).
```

### Connection Pooling: The Most Misunderstood AWS Architecture Decision

```
THE PROBLEM:
  Your API: 200 Lambda functions, each with a DB connection.
  Your RDS Postgres db.r6g.large: max_connections = ~1,000
  200 Lambdas × 10 concurrent invocations each = 2,000 connections requested.
  DB refused connections: "FATAL: remaining connection slots are reserved for..."

  Root cause: every Lambda function opened a new TCP connection on invocation.
  TCP handshake + Postgres authentication: ~15ms each.
  Lambda: cold starts open a new connection → hot starts reuse... but Lambda is ephemeral.

SOLUTION: RDS PROXY (AWS-managed PgBouncer)

  ┌────────────────────────────────────────────────────────────────┐
  │                                                                │
  │  Lambda 1 ─┐                                                  │
  │  Lambda 2 ─┤                                                  │
  │  Lambda 3 ─┤──► RDS Proxy (connection pool)──► RDS Postgres  │
  │  ...       ─┤   (maintains 50 persistent       (50 connections│
  │  Lambda 200─┘   connections to RDS)             max needed)   │
  │                                                                │
  │  2,000 Lambda connections → multiplexed into 50 DB connections│
  └────────────────────────────────────────────────────────────────┘

  RDS Proxy:
  • Maintains persistent connection pool to DB (configurable: 10-1000 connections)
  • Lambda connects to Proxy (~1ms, in-VPC): IAM auth or Secrets Manager
  • Proxy multiplexes Lambda connections onto pool connections
  • Pinning: transaction-level sessions pin a connection for entire transaction

  CATCH: RDS Proxy doesn't support all Postgres features.
    • No: SET LOCAL, advisory locks maintained across queries, LISTEN/NOTIFY
    • Pinning triggers (connection can't be shared mid-transaction):
      happens automatically for transactions, SET statements — expected behavior
    • Cost: ~$0.015/hour per endpoint + $0.0012/GB data processed

CONNECTION POOLING FOR PERSISTENT SERVERS (ECS, EC2, App Runner):
  Use PgBouncer at application container level.
  Or: pg library pool configuration (node-postgres):

  const pool = new Pool({
    host: process.env.DB_HOST,
    max: 20,                  // max connections per process
    idleTimeoutMillis: 30000, // close idle connections after 30s
    connectionTimeoutMillis: 5000,  // fail fast: 5s to get a connection from pool
  });

  Rule: max connections per process × number of processes = total DB connections.
  ECS: 5 tasks × pool.max=20 = 100 DB connections. Plan accordingly.
```

### Read Replicas: Architecture Decisions

```sql
-- SCENARIO: Reporting queries hammering your primary DB.
-- Monthly invoice generation: SELECT SUM aggregating 10M rows.
-- Impact: 8-second query holding shared locks, degrading OLTP queries.

-- SOLUTION: Route reads to replica

-- AWS Aurora: up to 15 replicas, automatic reader endpoint (DNS round-robin)
-- aurora-cluster-xxx.cluster-ro-xxx.region.rds.amazonaws.com

-- In your ORM:
const primaryPool = new Pool({ host: process.env.DB_WRITER_HOST });
const replicaPool = new Pool({ host: process.env.DB_READER_HOST });

async function getOrders(customerId) {
  // OLTP read: can use replica (some lag acceptable, data freshness < 1 second)
  return replicaPool.query('SELECT * FROM orders WHERE customer_id = $1', [customerId]);
}

async function createOrder(data) {
  // Write: always goes to primary
  return primaryPool.query('INSERT INTO orders ...', [...]);
}

async function generateInvoice(accountId) {
  // Reporting: heavy aggregation, always use replica
  return replicaPool.query('SELECT SUM(...) FROM transactions WHERE ...', [accountId]);
}

-- REPLICATION LAG TRAP:
-- User creates order → immediate redirect to "order confirmation" page.
-- Page reads from replica. Replica lag: 50ms.
-- Query: "SELECT * FROM orders WHERE id = $1" → 0 rows (replica hasn't caught up).
-- User sees: "Order not found."
--
-- FIX:
-- a) Read-your-own-writes: route reads immediately after write to PRIMARY (for 5 seconds).
-- b) Sticky session: after write, user's session reads from primary for grace period.
-- c) Accept eventual consistency: show "Processing..." page, not immediate confirm.

-- REPLICA LAG MONITORING (set CloudWatch alert):
-- Metric: AuroraReplicaLag or ReplicaLag on RDS
-- Alert threshold: > 100ms for OLTP, > 1 second for reporting workloads
```

### Schema Migrations in Production (AWS + Zero Downtime)

```
APPROACH 1: Expand-Contract Pattern

  EXPAND phase (deploy V1):
    Add nullable new column: ALTER TABLE orders ADD COLUMN billing_address JSONB;
    Write code that writes to BOTH old and new column.
    Read code reads from OLD column.
    → Zero downtime: nullable column doesn't require table lock (Postgres 11+)

  BACKFILL phase (background job):
    UPDATE orders SET billing_address = jsonb_build_object('street', shipping_addr)
    WHERE billing_address IS NULL
    LIMIT 1000;  -- batch to avoid long lock hold
    REPEAT until done. No rush. Days acceptable.

  CONTRACT phase (deploy V2):
    Switch read code to read from NEW column.
    Remove writes to old column.

  CLEANUP phase (deploy V3, weeks later):
    DROP COLUMN shipping_addr;
    → By now: zero code references it. Safe to remove.

APPROACH 2: AWS DMS (Database Migration Service)
  Use for: major schema restructuring or DB engine migration (MySQL → Aurora Postgres).

  DMS: replicates data continuously while you test the new schema.
  Cutover: on defined maintenance window, point application to new DB.

  PITFALL: DMS doesn't migrate all DB objects.
    • Sequences, stored procedures, triggers: migrate manually.
    • DMS row count validation: always run before cutover.
    • Foreign keys: DMS disables them during migration (can cause constraint violations post-cutover).
```

---

## SECTION 10 — Interview Questions

### Beginner Level

**Q1: What's the difference between a primary key and a foreign key? Why do both matter?**

```
ANSWER:
Primary key: unique identifier for a row within its own table. Enforces: no duplicates, no NULLs.
Foreign key: a column in table B that references the primary key of table A.
Enforces: every value in B.column must exist in A.primary_key (referential integrity).

Why both matter in production:
  Without PK: no reliable way to reference a specific row. UPDATE might match 0 rows silently.
  Without FK: child records accumulate referencing deleted parents (orphaned rows).

  Example: order_items.product_id without FK → DELETE a product → order_items still reference it.
  "What products did I ship last month?" joins to nothing. Revenue reports zeroed.

  FK enforcement catches this at write time (constraint violation) before data corruption spreads.
```

**Q2: What is a database index and when would you not want to create one?**

```
ANSWER:
Index: a separate B-tree data structure that stores (indexed_value → row_pointer).
Trades write overhead for read speed.

When NOT to create one:
  1. Low-cardinality column (boolean, status with 3 values): sequential scan cheaper for >20% selectivity.
  2. Table receiving 50,000+ writes/second: each index = extra B-tree update = write amplification.
  3. Query returns most of the table: index scan + random heap reads > sequential scan.
  4. Column never appears in WHERE, JOIN, or ORDER BY: pure storage waste.

  My rule: confirm query pattern first. Add index surgically. Verify with EXPLAIN ANALYZE before and after.
```

**Q3: Explain normalization in one sentence and describe when you'd intentionally violate it.**

```
ANSWER:
Normalization: organize data so each fact is stored once and only once, eliminating update anomalies.

When to intentionally violate it (denormalize):
  1. Read performance critical: reporting table needs product_name alongside order_id.
     Join at query time costs 50ms. Store name in orders = 0.1ms. Accept update complexity.
  2. Historical accuracy required: orders.unit_price_at_purchase must NOT link to current price.
     This denormalization is correct by design — it preserves what the customer was charged.
  3. Read replicas + CQRS: read model denormalized for reporting. Write model normalized.

  Key: intentional denormalization is documented and understood. Accidental denormalization is a bug.
```

---

### Intermediate Level

**Q4: A production query that runs in 200ms suddenly takes 15 seconds after a weekend deploy. How do you diagnose it?**

```
STEP 1: Run EXPLAIN (ANALYZE, BUFFERS) on the exact query.
  Look for: Seq Scan where an Index Scan was before.
  Look for: "Rows Removed by Filter" much larger than "rows=X" in estimate.

STEP 2: Check query plan changed:
  SELECT * FROM pg_stat_statements WHERE query LIKE '%orders%' ORDER BY mean_exec_time DESC;
  Were statistics updated? Did a new deploy change the query? Did the table grow?

STEP 3: Check table statistics freshness:
  SELECT last_autoanalyze, last_analyze, n_live_tup, n_dead_tup FROM pg_stat_user_tables
  WHERE relname = 'orders';
  If n_dead_tup >> n_live_tup: bloat. Run VACUUM ANALYZE orders immediately.

STEP 4: Check for lock waits:
  SELECT pid, wait_event_type, wait_event, query FROM pg_stat_activity
  WHERE state = 'active' AND wait_event IS NOT NULL;
  If many queries waiting on "relation" or "tuple": lock contention.
  Find the blocking query: SELECT pg_blocking_pids(pid) FROM pg_stat_activity;

STEP 5: Force immediate re-plan:
  ANALYZE orders;  -- updates planner statistics from current row distribution
  -- Re-run query. If fast again: stale statistics confirmed as root cause.
```

**Q5: How does MVCC work, and what is a "long-running transaction" actually causing at the DB level?**

```
MVCC: every row version gets a (xmin, xmax) — transaction ID that created it and the one that deleted it.
A reader's snapshot: "show me all rows where xmin ≤ my_txn_id < xmax."
Old versions kept alive as long as any active snapshot needs them.

Long-running transaction impact:
  Transaction started at T=0. Holds snapshot from T=0.
  All row versions created since T=0: kept on disk (cannot be vacuumed).
  Table bloat accumulates. High-write table: bloat grows GB per hour with a 2-hour transaction.
  VACUUM cannot reclaim space: "the oldest live snapshot is from T=0, everything after is visible to it."

  After transaction commits/rollbacks: VACUUM can proceed. Bloat cleared.

Production pattern that causes this:
  Background job opens transaction to batch-export 1M rows.
  Loops through in application code, processing each.
  Leaves transaction open for 3 hours.
  Meanwhile, orders table receives 100K inserts/updates: all versions accumulate.
  Query performance degrades across entire database. Not just background job.

Fix: open transactions only for the duration of the actual DB operation.
     For long-running jobs: process in small batches with separate transactions per batch.
```

**Q6: You have a high-write table (5M inserts/day). How do you decide which indexes to create?**

```
PROCESS:
  1. Capture slow query log or pg_stat_statements: find actual production queries hitting this table.
  2. For each slow query: EXPLAIN ANALYZE to see current plan.
  3. Identify: which columns are in WHERE, JOIN ON, ORDER BY, GROUP BY?
  4. Add indexes only on columns that appear in (3) AND where the query returns < 15% of rows.
  5. Test index addition in staging with a production-sized dataset (bulk load from prod anonymized).
  6. Measure: write throughput before and after index addition.
  7. Accept: each index = ~10-20% write overhead on the table.

TRADE-OFF DECISION:
  5M inserts/day = ~58 inserts/second average.
  Each additional index: ~10 ms extra write latency at high volume.
  If you have 5 indexes: 50ms added to each write path.
  If read SLA requires the index: pay the write cost.
  If nobody reads that column in production: drop the index.

MONITORING: Set up pg_stat_index usage alerts. Any index with idx_scan = 0 after 30 days: candidate for removal.
```

---

### Advanced Level

**Q7: Design the schema for a multi-tenant SaaS with 10,000 tenants and queries that must never return data from the wrong tenant. What are the trade-offs of your approach?**

```
APPROACH 1: SHARED SCHEMA — tenant_id column in every table

CREATE TABLE orders (
  id          UUID PRIMARY KEY,
  tenant_id   INT NOT NULL REFERENCES tenants(id),
  ...
);

-- Every query must include: WHERE tenant_id = $current_tenant
-- Enforced via: Row Level Security (RLS)

ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON orders
  USING (tenant_id = current_setting('app.current_tenant_id')::INT);
-- Now: every SELECT, UPDATE, DELETE automatically filtered by tenant_id.
-- Application: SET app.current_tenant_id = {tenant_id} per connection/transaction.

TRADE-OFF:
  PRO: Single DB, lowest operational cost, simple schema migrations.
  CON: Missing WHERE tenant_id = ? in ONE query = data leak to another tenant.
       RLS mitigates but requires rigorous testing. Performance: large tenants cause hot spots.
       Regulatory concerns: data co-location may not satisfy GDPR for EU tenants.

APPROACH 2: SEPARATE SCHEMAS PER TENANT (schema-based isolation)
  CREATE SCHEMA tenant_1042;
  CREATE TABLE tenant_1042.orders (...);  -- identical structure, isolated data

  PRO: Hard isolation at schema level. Simpler security reasoning.
  CON: 10,000 schemas × 20 tables = 200,000 tables in pg_class. Postgres degrades above ~1M tables.
       Schema migrations: must apply to all 10,000 schemas (tooling required).

APPROACH 3: SEPARATE DATABASES PER TENANT
  Each tenant: their own RDS/Aurora instance.

  PRO: Full isolation. Independent backups, scaling, maintenance.
  CON: 10,000 RDS instances = ~$2-20M/month. Not practical unless premium enterprise tier.
  USE CASE: Only if tenants pay > $1K/month and have contractual isolation requirements.

MY ANSWER: Shared schema + RLS for most tenants. Dedicated DB for enterprise tenants who pay for it
and have compliance requirements. This matches how Salesforce and GitHub multitenancy work.
```

**Q8: Your orders table has 500M rows. A new critical feature requires adding a column with a non-null default. How do you execute this migration with zero downtime?**

```
THE TRAP:
  ALTER TABLE orders ADD COLUMN priority INT NOT NULL DEFAULT 0;
  In Postgres < 11: rewrites entire table. 500M rows × 200 bytes = 100GB rewrite.
  Table locked for write for 2-4 hours. Production outage.

POSTGRES 11+ BEHAVIOR (what most use today):
  Adding column with constant default: stored in catalog, no table rewrite.
  The 500M rows don't get the value physically written.
  New rows: store value. Old rows: default returned from catalog on read.
  → Instant. Zero lock (except brief catalog lock).

  CATCH: Non-constant defaults (defaults involving functions, sequences, NOW()):
  Still requires table rewrite in some versions.
  Non-null without default: still requires table rewrite (every row needs the value).

ZERO-DOWNTIME PROCEDURE FOR COMPLEX CASES:
  Phase 1 — Add as NULL first (immediate, no rewrite):
    ALTER TABLE orders ADD COLUMN priority INT;
    -- This is always fast. Nullable column = no rewrite needed.

  Phase 2 — Backfill in small batches (background job):
    UPDATE orders SET priority = 0 WHERE id IN (
      SELECT id FROM orders WHERE priority IS NULL LIMIT 1000
    );
    -- Loop until all rows updated. Commit per batch. Never overwhelm WAL.
    -- Use: pg_sleep(10ms) between batches for write-heavy tables.

  Phase 3 — Add NOT NULL constraint with validation deferred:
    ALTER TABLE orders ADD CONSTRAINT orders_priority_notnull
      CHECK (priority IS NOT NULL) NOT VALID;
    -- NOT VALID: constraint checked on new writes but doesn't scan existing rows (fast).

  Phase 4 — Validate constraint during low traffic window:
    ALTER TABLE orders VALIDATE CONSTRAINT orders_priority_notnull;
    -- Scans table once. Acquires ShareUpdateExclusiveLock (allows reads/writes).
    -- Slow but non-blocking.

  Phase 5 — Promote to actual NOT NULL:
    ALTER TABLE orders ALTER COLUMN priority SET NOT NULL;
    -- Postgres verifies constraint exists and valid → just a catalog update. Instant.
    DROP CONSTRAINT orders_priority_notnull;

TOTAL DOWNTIME: 0 seconds.
TOTAL CALENDAR TIME: 2-5 days (backfill runs at your pace).
```

---

## SECTION 11 — Debugging Exercise

### Scenario: Production Slow Query Ticket

```
TICKET:
  "Our order history page has degraded from 50ms to 8 seconds starting 2 days ago.
   Customer-facing. Hundreds of reports. SLA breach."

  QUERY (unchanged for 6 months):
  SELECT
    o.id, o.status, o.created_at,
    c.name, c.email,
    COUNT(oi.id) as item_count,
    SUM(oi.unit_price_at_purchase * oi.quantity) as total
  FROM orders o
  JOIN customers c ON o.customer_id = c.id
  JOIN order_items oi ON oi.order_id = o.id
  WHERE o.customer_id = $1
  ORDER BY o.created_at DESC
  LIMIT 20;

  EXPLAIN ANALYZE output:
  Limit  (actual time=7830.422..7831.003 rows=20 loops=1)
    -> Sort  (actual time=7830.398..7830.412 rows=20 loops=1)
         Sort Key: o.created_at DESC
         Sort Method: external merge  Disk: 245816kB    ← 240MB sort to disk!
         -> Hash Join  (actual time=4521.3..7823.1 rows=50000)
              Hash Cond: (oi.order_id = o.id)
              -> Seq Scan on order_items oi  (cost=0..180000 rows=5000000)
                   ← Sequential scan: 5M rows!
              -> Hash  (actual time=4520.1..4520.1 rows=50000)
                   -> Index Scan on orders (customer_id=42)
                        (actual rows=50000)
                        ← Customer 42 has 50,000 orders??
```

### Diagnosis

```
ROOT CAUSE INVESTIGATION:

CLUE 1: "Sort Method: external merge Disk: 245MB"
  The sort spilled to disk because work_mem is too small for this result set.
  work_mem (default: 4MB) is per-sort-node, per-query.
  240MB sort → work_mem too low for this cardinality.
  BUT: this is a symptom. Why is this customer returning 50,000 rows?

CLUE 2: "Index Scan on orders (customer_id=42) → actual rows=50,000"
  Customer 42 has 50,000 orders. This customer is a corporate account
  or a test account that was used to generate fake data.

  INVESTIGATE:
    SELECT customer_id, COUNT(*) FROM orders
    GROUP BY customer_id
    ORDER BY COUNT(*) DESC
    LIMIT 10;

  Result: customer_id=42: 2,300,000 orders. (a load test user never cleaned up!)
  All other customers: 5-200 orders.

  The query with LIMIT 20 still joins ALL 2.3M orders to get the sort.
  Sort: 2.3M × JOIN with order_items = 5M rows → sort → take top 20.

CLUE 3: "Seq Scan on order_items oi → 5M rows"
  No index on order_items.order_id?

  SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'order_items';
  Result: idx_order_items_order_id — EXISTS. Was just dropped by last migration accidentally.

  The deploy 2 days ago: dropped and recreated the index — but recreation failed silently
  (disk space warning). Index missing.
```

### Fixes Applied

```sql
-- FIX 1: Restore missing index (immediate, concurrent rebuilds without lock)
CREATE INDEX CONCURRENTLY idx_order_items_order_id ON order_items(order_id);
-- ~5 minutes to build at 5M rows. No downtime.

-- FIX 2: Delete load test data causing data skew (coordinate with team)
DELETE FROM orders WHERE customer_id = 42;
-- Or: rename account as "LOAD_TEST" and exclude from LIMIT queries.

-- FIX 3: Use cursor-based pagination instead of OFFSET to avoid sort of full result
-- Replace: ORDER BY created_at DESC LIMIT 20
-- With: keyset pagination:
SELECT o.id, o.status, o.created_at, c.name, c.email, COUNT(oi.id), SUM(...)
FROM orders o
JOIN customers c ON o.customer_id = c.id
JOIN order_items oi ON oi.order_id = o.id
WHERE o.customer_id = $1
  AND o.created_at < $2   -- cursor: last seen created_at from previous page
ORDER BY o.created_at DESC
LIMIT 20;
-- cursor stops the sort from processing 2.3M rows — only rows after cursor.

-- FIX 4: Set work_mem for reporting sessions (NOT globally — would OOM server)
SET LOCAL work_mem = '64MB';  -- Only for this session/transaction
SELECT ... ORDER BY ... LIMIT 20;
RESET work_mem;

-- VERIFICATION:
EXPLAIN (ANALYZE, BUFFERS)
SELECT ... FROM orders o ...
WHERE o.customer_id = 5   -- use normal customer, not test data customer
ORDER BY o.created_at DESC LIMIT 20;

-- EXPECTED AFTER FIX:
-- Index Scan on order_items (order_id=...)  → actual rows=20  ← only 20 rows
-- Sort Method: quicksort  Memory: 25kB      ← in-memory sort, no disk
-- actual time=1.2..1.4  ← 1.4ms vs 8,000ms before
```

---

## SECTION 12 — Architect's Mental Model

```
=== Architect's Mental Model: Database Basics & Schema Design ===

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

▶ DECISION RULE 1: Schema is a prediction — design for your read patterns, not your write patterns.
  Every table structure encodes an assumption about how data will be queried.
  Get it wrong: every query is a full table scan or a complex multi-join.
  Identify the top 5 queries on day one. Schema around them.

▶ DECISION RULE 2: Put constraints in the database, not the application.
  Application code has bugs, gets bypassed, has race conditions.
  UNIQUE constraints, NOT NULL, CHECK constraints, FK: enforced at the DB level always.
  Rule of thumb: if two applications ever write to the same database, every constraint
  that matters must live at the DB level.

▶ DECISION RULE 3: Normalize first, denormalize with intent.
  Start normalized. Run production. Find the slow queries.
  Denormalize EXACTLY those queries with documented rationale.
  Accidental denormalization = data corruption. Intentional denormalization = architecture decision.

▶ DECISION RULE 4: Index for reads, budget for writes.
  Every index costs ~10-20% write overhead on that table.
  For a table taking 50K writes/second: 5 indexes = effectively 250K B-tree operations/second.
  Before adding an index: confirm it's used by production queries.
  After adding an index: measure write throughput regression.

▶ DECISION RULE 5: Long-running transactions are infrastructure incidents.
  A transaction open for >1 minute: blocks VACUUM, causes table bloat, holds locks.
  Review: any background job, batch processor, or report generator that opens a transaction.
  Rule: transaction lifetime = time to execute the DB operations. Never hold a transaction
  while waiting on external I/O (HTTP calls, user input, file reads).

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

⚠ COMMON MISTAKE 1: Relying on application-level uniqueness checks.
  CHECK → SELECT → INSERT is always a race condition.
  Two simultaneous requests will both pass the SELECT and both INSERT.
  Fix: DB UNIQUE constraint. Catch error code 23505. Handle gracefully.

⚠ COMMON MISTAKE 2: Adding indexes reactively under production pressure.
  "Query is slow, add an index NOW" during incident = write throughput drops 15% on already overloaded DB.
  Fix: REINDEX CONCURRENTLY or CREATE INDEX CONCURRENTLY. Test in staging first.
       Better: post-mortem adds index after incident resolved.

⚠ COMMON MISTAKE 3: Mistaking storage cost for schema cost.
  "Storage is cheap, store everything in one wide table."
  Cost is not just bytes — it's lock contention, vacuum overhead, cache utilization, join complexity.
  A 500-column table where 490 columns are NULL for any given row:
  every row read fetches those null bytes, evicts useful data from cache, slows VACUUM.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

◆ 30-SECOND INTERVIEW ANSWER (schema design for scale):

"I design schemas around three questions:
  What are my top query patterns — what columns appear in WHERE and JOIN?
  What are my consistency boundaries — what must be atomic, what can be eventually consistent?
  What changes together — columns updated by the same operation belong together; others are separate tables.

I start normalized with FK constraints enforced at the DB layer — not the application layer.
I add indexes only after confirming query patterns from production traffic, accepting 10-20% write overhead per index.
I denormalize intentionally when a specific read pattern justifies it, documenting the trade-off.
For production migrations, I use expand-contract: add nullable columns, backfill in batches,
add constraints, never rewrite a 500M-row table in a single ALTER TABLE statement."
```
