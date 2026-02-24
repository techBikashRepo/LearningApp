# Database Basics: Tables & Schema — Part 1 of 3

### Sections: 1 (Intuition), 2 (Why This Exists), 3 (Internal Working), 4 (Query Execution Flow)

**Series:** Databases & Data Modeling → Topic 01

---

## SECTION 1 — Intuition: Bank Ledger Analogy

Forget "tables are like spreadsheets." That analogy breaks the moment you hit scale.

**Think instead: a bank's double-entry ledger system.**

A bank never records "Alice has $5,000." It records every _event_:

```
Date        | Account   | Type    | Amount  | Balance_After | Teller_ID | Branch
2026-02-01  | ACC-001   | DEPOSIT | +1000   | 5000          | T-42      | NYC-01
2026-02-01  | ACC-002   | DEBIT   | -1000   | 2000          | T-42      | NYC-01
```

This design encodes 4 architectural decisions you'll make in every system:

```
DECISION 1: WHAT IS THE UNIT OF TRUTH?
  Bank: A transaction is the source of truth. Balance is derived.
  Bad design: Store balance as mutable field. One update failure = money disappears.
  Good design: Balance = SUM(transactions). Immutable audit trail. Replay-able.

DECISION 2: HOW DO YOU MODEL RELATIONSHIPS?
  Teller T-42 appears in 10,000 rows. Do you duplicate name/branch in every row?
  Bank answer: store Teller_ID (foreign key). Join to tellers table when you need the name.
  Trade-off: join cost at read vs. update anomaly at write.

DECISION 3: WHAT CHANGES TOGETHER?
  Transaction amount never changes (fact). Account balance changes hourly.
  Storing them in the same table = lock contention. High-write column blocks reads of immutable data.

DECISION 4: HOW WILL YOU QUERY THIS IN 3 YEARS?
  "Show me all transactions for branch NYC-01 last month" → needs index on (branch, date).
  "Show me balance for account ACC-001" → needs index on account.
  Schema without these indexes: full table scan across 500M rows = 40-second query at 2 AM.
```

**The architect's frame:** Every schema decision is a prediction about your future query patterns.
Wrong prediction = production incident at scale.

---

## SECTION 2 — Why This Exists: Real Production Failures That Forced Better Schema Design

### The Failure That Created Normalization

In the 1970s, IBM was running payroll systems where employee data was stored in flat files:

```
EMP_NAME  | DEPT_NAME       | DEPT_BUDGET | MANAGER_NAME | SALARY
Alice     | Engineering     | 500000      | Bob          | 120000
Charlie   | Engineering     | 500000      | Bob          | 95000
Dave      | Engineering     | 500000      | Bob          | 105000
```

**What happened when Engineering's budget changed to $600,000?**
Update 3 rows. Miss updating one row (network blip, partial batch failure): data inconsistency.
Now `Alice.DEPT_BUDGET = 600000`, `Charlie.DEPT_BUDGET = 500000`. Both claim to be in Engineering.

This is an **update anomaly** — not a theoretical problem. A real payroll system paying wrong amounts.

**What happens when Dave leaves the company and is the only person in a department?**
Delete Dave's row → department record disappears. That's a **deletion anomaly**.

Normalization was not academic. It was the engineering response to real data corruption incidents.

### The Modern Version of the Same Mistake

```
// This happens in 2026, not 1975:
{
  "order_id": "ORD-5892",
  "customer_name": "Alice Chen",     // ← duplicated in 10,000 orders
  "customer_email": "alice@co.com",  // ← Alice updates email → 10,000 rows to update
  "customer_address": "123 Main St", // ← partial update leaves 8,000 rows stale
  "product_name": "Widget Pro",      // ← product renamed → how many rows updated correctly?
  "product_price": 49.99             // ← price was $39.99 at time of purchase — now you lost history
}
```

The exact same anomaly. Different decade. NoSQL developers hit this at scale every day.

### The Production Incident: E-Commerce Order Price Drift

```
INCIDENT TIMELINE:
  T+0:   Marketing team runs UPDATE products SET price = 59.99 WHERE id = 42.
  T+0:   800,000 orders still reference product_name="Widget Pro" with price=49.99 in order table.
  T+5min: Finance reports total revenue as $59.99 × all_orders (uses order table price column).
  T+6min: Revenue inflated by $8 million on quarterly report.
  T+2hr:  Rollback attempted. Orders placed BETWEEN T+0 and T+2hr: which price applies?
  T+3hr:  Incident. Root cause: price stored denormalized in orders table, not referenced via FK.

CORRECT DESIGN:
  orders.product_id → FK to products.id.
  orders.unit_price_at_purchase = snapshot of price at time of order (intentional denormalization).
  products.price = current price (changes freely).

  The schema makes the decision explicit: "unit_price_at_purchase is intentional history preservation."
  Not an accident. An architectural choice documented in the schema itself.
```

---

## SECTION 3 — Internal Working: What the Database Engine Actually Does

### When You Run `SELECT * FROM orders WHERE customer_id = 5`

Most developers picture this as "the database looks up rows where customer_id = 5."
What actually happens:

```
STEP 1: QUERY PARSING
  SQL string → parse tree → logical plan.
  The engine doesn't execute SQL. It converts it to a tree of operations.
  "This is a SELECT on table 'orders', filter predicate: customer_id = 5."

STEP 2: QUERY PLANNER / OPTIMIZER
  The most important step. The engine evaluates multiple execution strategies:

  Option A: Sequential scan (read every row, filter for customer_id = 5)
    Cost estimate: 50,000 rows × 8 bytes avg = 400KB disk read.

  Option B: Index scan on idx_orders_customer (if index exists)
    Cost estimate: 1 B-tree lookup = 3 disk reads, then fetch matching rows.

  Planner picks Option B if index exists, Option A if not.
  Planning decision determined by: TABLE STATISTICS (row count, cardinality, data distribution).
  OUT-OF-DATE STATISTICS = wrong plan chosen. This is a production problem.

  REAL INCIDENT: Postgres table grown from 10K to 50M rows. Statistics say 10K rows.
  Planner chooses sequential scan (seemed fast for 10K). Now reading 50M rows.
  Fix: ANALYZE orders; (updates stats immediately)

STEP 3: DISK READ — B-TREE INDEX STRUCTURE

  An index on customer_id looks like this in memory:

  B-TREE NODE (Root)
  ┌─────────────────────────────────────┐
  │  [1-1000] │ [1001-5000] │ [5001-9999] │
  └────┬──────────────┬──────────────┬───┘
       │              │              │
  LEAF NODES   LEAF NODES      LEAF NODES
  [customer_id=1, page_ptr=0x4A2]
  [customer_id=2, page_ptr=0x4A3]
  ...
  [customer_id=5, page_ptr=0x512]  ← found. Read this page.

  Each leaf node: contains (indexed_value, pointer_to_heap_page).
  Heap page: actual row data.

  For customer_id = 5: 3-4 B-tree node reads → 1 heap page read = ~4 I/O operations.
  Without index: read every heap page = potentially thousands of I/O operations.

STEP 4: LOCKS

  A SELECT (read) acquires a SHARED LOCK on rows being read.
  An UPDATE acquires an EXCLUSIVE LOCK on rows being modified.

  Shared locks coexist with other shared locks. (multiple readers: fine)
  Exclusive lock blocks all other shared locks. (writer blocks readers)

  MVCC (Multi-Version Concurrency Control) in PostgreSQL/MySQL InnoDB:
  Readers don't block writers. Writers don't block readers.
  Mechanism: maintain multiple row versions. Each transaction sees a consistent snapshot.

  ┌──────────────────────────────────────────────────────────┐
  │  Row: order_id=5, status="PENDING", version=1           │
  │  Row: order_id=5, status="SHIPPED", version=2 (new)     │
  │                                                          │
  │  Transaction started at T=10: sees version=1 (PENDING)  │
  │  Transaction started at T=12: sees version=2 (SHIPPED)  │
  │  Both run concurrently — no blocking.                    │
  └──────────────────────────────────────────────────────────┘

STEP 5: RETURNING RESULTS
  Rows fetched → projected (SELECT * = all columns, SELECT id = only id column).
  Result buffered in server memory → sent to client over connection wire protocol.
  Buffer size matters: SELECT * FROM orders (10M rows) = OOM crash on DB server.
  Application-side: always paginate. LIMIT + OFFSET or cursor-based pagination.
```

### The Three Files Every Table Lives In (PostgreSQL)

```
HEAP FILE:        stores actual row data, in pages (8KB each by default)
                  reading a row = finding which page it's on, loading that page into buffer

INDEX FILE:       B-tree (default), Hash, GIN, GiST — each tuned for different query types
                  reading via index = B-tree traversal → pointer → heap page

WAL FILE:         Write-Ahead Log — records EVERY change before it's applied to heap
                  if server crash mid-write: replay WAL to recover → durability guarantee
                  WAL fills up: autovacuum kicks in → can cause latency spikes
                  if WAL fills disk: DB goes read-only → production outage
```

### What VACUUM Does (And Why You Care)

```
MVCC keeps old row versions alive until no transaction can see them.
Over time: heap pages fill with dead tuples (old versions nobody reads).
Table grows on disk: "bloat." Query reads more pages than needed: slower.

VACUUM: scans heap, marks dead tuples as reusable space. Does not return space to OS.
VACUUM FULL: rewrites entire table, returns space to OS. Acquires exclusive lock. Blocks prod.

PRODUCTION RISK:
  Autovacuum too slow for high-write table.
  Dead tuples accumulate: table size 10x actual data size.
  Query: now reads 10x more pages. Latency 10x worse.
  Fix: tune autovacuum_vacuum_cost_delay and autovacuum_vacuum_scale_factor per table.

  Extreme case: transaction ID wraparound (XID exhaustion).
  Postgres: 32-bit transaction IDs. ~2 billion before wrap.
  If autovacuum doesn't run: XID wraps → ALL rows appear to be "in the future."
  Database refuses writes. Forced maintenance window. See: Sentry 2015 incident.
```

---

## SECTION 4 — Query Execution Flow

### End-to-End: From Application Code to Result

```
YOUR APPLICATION CODE (Node.js/Python/Java)
│
│  const result = await db.query(
│    'SELECT * FROM orders WHERE customer_id = $1 AND status = $2',
│    [userId, 'PENDING']
│  );
│
▼
DATABASE DRIVER (pg, psycopg2, JDBC)
│  • Maintains a connection pool (PgBouncer or driver-level)
│  • Picks an available connection from pool
│  • Serializes SQL + parameters into PostgreSQL wire protocol (binary)
│  • Sends over TCP socket to DB server
│
▼
DATABASE ENGINE (PostgreSQL process)
│  1. Receive query on postmaster → fork worker process (or reuse)
│  2. Parse SQL string → parse tree
│  3. Analyze: resolve table/column names, check types
│  4. Rewrite: apply query rewrite rules (views expanded here)
│  5. Plan: generate execution plan
│     - Statistics lookup: pg_statistic table
│     - Cost model: seq_page_cost, random_page_cost, cpu_tuple_cost
│     - Choose: SeqScan vs IndexScan vs BitmapHeapScan
│  6. Execute: walk the plan tree
│
▼
STORAGE ENGINE
│  Index Scan (if chosen):
│  • Load root B-tree node (probably in shared_buffers already)
│  • Walk tree: 3-4 page reads
│  • Reach leaf: get heap page pointer
│  • Load heap page (8KB) from disk or shared_buffers (cache)
│
▼
SHARED BUFFERS (PostgreSQL in-memory cache, default: 128MB — tune to 25% of RAM)
│  • Acts as database page cache
│  • Cache hit: zero disk I/O, microsecond latency
│  • Cache miss: OS page cache check → disk read (milliseconds)
│  • Eviction: clock-sweep algorithm when buffers full
│
▼
OS PAGE CACHE
│  • OS caches disk pages in RAM
│  • Even a "disk read" may be served from OS cache: ~50μs
│  • True physical disk read: 1-10ms (SSD), 5-15ms (HDD)
│
▼
RESULT BACK TO APPLICATION
   • Row data serialized → wire protocol → TCP → driver → deserialized
   • Driver returns result as rows/objects
   • Connection returned to pool
```

### Where Latency Actually Comes From

```
OPERATION                          TYPICAL LATENCY    PRODUCTION CULPRIT
─────────────────────────────────────────────────────────────────────────
Index lookup (cache hit)           0.1 - 0.5 ms       Rarely the problem
Index lookup (cache miss)          1 - 5 ms           Buffer hit rate < 90%
Sequential scan (1M rows)          50 - 500 ms        Missing index
N+1 query (ORM mistake)           100ms × N rows      Forgot to eager-load
Lock wait (writer blocking)        0 - ∞              Long-running transaction
Connection acquisition wait        5 - 50 ms          Pool exhausted
Autovacuum running on table        2x normal latency  Bloated table
Cross-AZ network (RDS read replica)2 - 5 ms           Sending writes to replica
Query plan regression              5x normal latency  Stale statistics
```

### The N+1 Problem: Invisible Until It Destroys Your Latency

```javascript
// This looks innocent in development (10 users in test DB):
const users = await User.findAll(); // 1 query → 10 rows
for (const user of users) {
  const orders = await user.getOrders(); // 1 query PER USER
}
// Total: 11 queries, ~5ms in dev.

// In production (10,000 users):
// 1 + 10,000 = 10,001 queries.
// At 1ms each: 10 seconds.
// With connection pool (20 connections): serialized across 20 connections = 500 queries × 1ms each...
// ... and you've exhausted your connection pool. Other requests queue.

// CORRECT: Eager load with JOIN
const users = await User.findAll({ include: [{ model: Order }] });
// 1 query (JOIN) → returns all users and their orders.
// At scale: 1 query vs 10,001 queries.

// POSTGRES EXPLAIN OUTPUT for N+1 (what you'd see on production):
//
// Seq Scan on orders (cost=0.00..1500.00 rows=50000 width=200)
//   Filter: (user_id = $1)
//   Rows Removed by Filter: 49999
//
// This "Filter: (user_id = $1)" printed 10,000 times in logs = N+1 confirmed.
```

### Query Plan Reading: Your Most Underused Debugging Tool

```sql
-- Run this in production READ REPLICA (safe, no lock):
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT * FROM orders
WHERE customer_id = 5
  AND status = 'PENDING'
ORDER BY created_at DESC
LIMIT 20;

-- KEY THINGS TO READ IN THE OUTPUT:
--
-- Seq Scan on orders  (cost=0.00..89432.00 rows=1 width=200) (actual time=423.122..423.122 rows=1 loops=1)
--   ^^^^^^^
--   RED FLAG: Sequential scan on a table used in hot path.
--   "rows=1" means 1 row matched. "cost=89432" means it read the whole table to find it.
--   FIX: Create index on (customer_id, status)
--
-- Buffers: shared hit=200 read=45000
--                          ^^^^^^^^^^^^
--   45,000 pages read from DISK. Each 8KB = 360MB of disk I/O for one query.
--   LOW HIT RATE = buffer cache too small or data too big for cache.
--
-- (actual time=423.122..423.122)
--   ^^^^^^^
--   423ms for a query that should take 1ms. With the right index: 0.5ms.
```
