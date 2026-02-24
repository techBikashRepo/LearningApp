# Joins (INNER, LEFT) — Part 2 of 3

### Sections: 5 (Bad vs Correct), 6 (Performance Impact), 7 (Concurrency), 8 (Optimization & Indexing)

**Series:** Databases & Data Modeling → Topic 08

---

## SECTION 5 — Bad Usage vs Correct Usage

### Pattern 1: Moving WHERE Filter to LEFT JOIN ON Clause

```sql
-- ❌ BAD: Date filter in WHERE after LEFT JOIN (converts to INNER JOIN semantics)
SELECT u.id, u.email, COUNT(o.id) AS orders_in_q1
FROM users u
LEFT JOIN orders o ON o.user_id = u.id
WHERE o.created_at BETWEEN '2024-01-01' AND '2024-03-31';
-- What this does: LEFT JOIN first (all users + matching orders + NULL rows for users with no orders).
-- Then WHERE: o.created_at must be in range. For users with no orders: o.created_at = NULL.
-- NULL BETWEEN '2024-01-01' AND '2024-03-31' = NULL = FALSE → row dropped.
-- Result: only users who have orders in Q1. Users with no Q1 orders: invisible.
-- This is functionally INNER JOIN. The LEFT JOIN was wasted.

-- ✅ CORRECT: Filter on joined column goes in ON clause, not WHERE.
SELECT u.id, u.email, COUNT(o.id) AS orders_in_q1
FROM users u
LEFT JOIN orders o ON o.user_id = u.id
                   AND o.created_at BETWEEN '2024-01-01' AND '2024-03-31'
GROUP BY u.id, u.email;
-- ON clause: apply filter before joining. Users with no Q1 orders: matched = 0 rows from orders.
-- After LEFT JOIN: still have those users with NULL in all order columns.
-- COUNT(o.id): o.id = NULL → 0 for users with no Q1 orders. Correct.
-- Result: ALL users, each with their Q1 order count (including 0).
```

### Pattern 2: Joining on Non-Indexed Column

```sql
-- TABLE: orders (id, customer_email, total, status)
-- TABLE: customers (id, email, name, tier)
-- FK: by email (not by ID — legacy schema, no surrogate key relationship)

-- ❌ BAD: Join on non-indexed text column
SELECT c.name, c.tier, SUM(o.total) AS ltv
FROM customers c
JOIN orders o ON o.customer_email = c.email   -- email: no index on orders
GROUP BY c.id, c.name, c.tier;

-- With 5M orders and 500K customers:
-- Planner: hash join (no index to use). Build hash on customers (500K rows).
-- Probe: scan all 5M orders, probe hash for each.
-- Text comparison per row: slower than integer comparison. Collation overhead.
-- Result: reasonable if fits in work_mem, but still 5M hash probes with text keys.

-- ✅ CORRECT: Add index, or better — redesign with proper FK relationship.
CREATE INDEX idx_orders_customer_email ON orders(customer_email);
-- Now: nested loop possible if customers is filtered to small subset.

-- IDEAL: Migrate to integer FK.
ALTER TABLE orders ADD COLUMN customer_id INT REFERENCES customers(id);
UPDATE orders o SET customer_id = c.id FROM customers c WHERE c.email = o.customer_email;
CREATE INDEX idx_orders_customer_id ON orders(customer_id);
-- Integer FK join: 4 bytes vs 30-50 bytes for email. Hash table 10x smaller. 3x faster probing.
```

### Pattern 3: Unnecessary DISTINCT After JOIN Causing Sort

```sql
-- ❌ BAD: Duplicate rows from join → DISTINCT to fix → expensive sort/hash
SELECT DISTINCT c.id, c.name
FROM customers c
JOIN orders o ON o.customer_id = c.id
WHERE o.status = 'COMPLETED';
-- Each customer with 10 orders: appears 10 times in join result.
-- DISTINCT: deduplicates. Requires sort or hash of entire result set.
-- For 100K customers with multiple orders: sort 500K rows to get 100K distinct rows.

-- ✅ CORRECT A: EXISTS subquery (no deduplication needed, stops at first match)
SELECT c.id, c.name
FROM customers c
WHERE EXISTS (
  SELECT 1 FROM orders WHERE customer_id = c.id AND status = 'COMPLETED'
);
-- For each customer: single index lookup in orders (stop at first COMPLETED row found).
-- No duplicates generated. No DISTINCT needed. No sort cost.
-- With index on orders(customer_id, status): very fast.

-- ✅ CORRECT B: Use DISTINCT ON (Postgres) for specific ordered use case.
-- ✅ CORRECT C: If you need aggregate data anyway, GROUP BY instead of DISTINCT.
SELECT c.id, c.name, COUNT(o.id) AS completed_orders
FROM customers c
JOIN orders o ON o.customer_id = c.id AND o.status = 'COMPLETED'
GROUP BY c.id, c.name;
-- GROUP BY collapses duplicates WITH useful aggregate. No wasted DISTINCT.
```

---

## SECTION 6 — Performance Impact

### Join Algorithm Cost Comparison

```
SCENARIO: users (1M rows) JOIN orders (10M rows) ON orders.user_id = users.id

NESTED LOOP JOIN (orders has index on user_id):
  For each user (1M): index lookup in orders → find ~10 order rows.
  Cost: 1M × (index traversal cost ~4 reads) = 4M page reads.
  Memory: O(1) — no hash table, no sort buffer.
  Best for: small outer table, indexed inner table.

HASH JOIN (no index — or planner prefers hash for large outer):
  Phase 1 (build): scan SMALLER table → build hash table.
    Smaller = users (1M rows). Hash table: 1M × ~50 bytes = 50MB.
    If 50MB < work_mem: single-batch in-memory. Fast.
  Phase 2 (probe): scan LARGER table (10M orders) → probe hash for user_id.
    10M hash probes: O(1) per probe.
  Total: sequential scan users + sequential scan orders + 10M hash lookups.
  Memory: 50MB.

MERGE JOIN (both sides have index providing sorted order):
  Prerequisite: index scan on users(id) + index scan on orders(user_id).
  Walk both sorted sequences simultaneously: O(N + M) with zero additional memory.
  Best for: large tables, both already sorted (or both have covering indexes).

CARTESIAN JOIN (missing ON clause — accidental):
  1M × 10M = 10 TRILLION rows generated.
  Planner may estimate small result: 1M × 10M × selectivity.
  If selectivity wrong (no stats): could attempt this and die.
  Safeguard: max_rows_per_plan_node or statement_timeout to kill runaway queries.

JOIN ALGORITHM SELECTION SIGNALS:
  EXPLAIN shows: "Nested Loop" → small outer, indexed inner. ✓
               "Hash Join"    → medium/large tables. Check Batches: value.
               "Merge Join"   → both sorted. Check "Sort" nodes above it.
               "Hash Join Batches: 8" → spilling to disk. Increase work_mem.
```

### work_mem and Hash Join Batching

```
Hash join memory pressure:
  Hash table = smaller_input_rows × bytes_per_row

  Threshold: if hash table > work_mem → partition inputs into batches → disk spill.

  Example: users 1M rows × 50 bytes = 50MB.
  work_mem = 4MB (default): batches = 50 / 4 = 13 batches.

  Cost per additional batch: one extra read of both input files.
  13 batches: reads users table 12 extra times, orders table 12 extra times.
  Performance: 12x slower than in-memory hash join.

  SET work_mem = '64MB':
  50MB < 64MB: hash fits in memory. Batches = 1. No disk I/O. Full speed.

  PER-QUERY TUNING (don't set globally high):
  SET LOCAL work_mem = '128MB';
  <execute join-heavy analytical query>
  -- Resets after transaction. Other sessions: unaffected (still use global default 4MB).

  FINDING QUERIES THAT BENEFIT FROM MORE work_mem:
  SELECT query, hash_batches, hash_disk_usage_bytes
  FROM pg_stat_statements
  WHERE hash_batches > 1
  ORDER BY hash_disk_usage_bytes DESC
  LIMIT 20;
  -- These queries: spilling hash joins to disk → candidates for work_mem increase or index addition.
```

---

## SECTION 7 — Concurrency

### Lock Contention During Joins on Hot Tables

```
SCENARIO: Reporting query with large JOIN running concurrently with OLTP writes.

Reporting query:
  SELECT COUNT(*), SUM(o.total) FROM users u JOIN orders o ON o.user_id = u.id
  WHERE u.tier = 'enterprise';
  -- Duration: 30 seconds (large result set).
  -- Lock type: AccessShareLock on users AND orders tables.

Concurrent OLTP:
  INSERT INTO orders (...) — acquires RowExclusiveLock. Compatible with AccessShareLock. ✓ OK.
  UPDATE orders SET status='SHIPPED' WHERE id=... — RowExclusiveLock. Compatible. ✓ OK.

  ALTER TABLE orders ADD COLUMN weight DECIMAL; — AccessExclusiveLock (DDL).
  BLOCKS: must wait for reporting query to finish.
  If ALTER is blocked, ALL subsequent queries on orders table ALSO BLOCK (lock queue).

SOLUTION: Statement timeout on reporting queries.
  SET statement_timeout = '30s';
  -- Reporting query killed if exceeds 30 seconds. DBA DDL can proceed.

BETTER: Run reports on read replica (no lock contention with primary at all).
  Reporting: pg_bouncer or app routing → standby replica.
  DDL: runs on primary. No conflict.

LOCK-SAFE DDL (Postgres):
  Instead of ALTER TABLE (AccessExclusiveLock):
  Use: ALTER TABLE orders ADD COLUMN IF NOT EXISTS weight DECIMAL;
  In Postgres 12+: adding nullable column with no default = metadata change only. Near-instant.
  No AccessExclusiveLock in recent Postgres versions for nullable column additions.
```

---

## SECTION 8 — Optimization & Indexing

### Composite Index for Multi-Column Join + Filter

```sql
-- FREQUENT QUERY:
SELECT o.id, o.total, o.status, u.email
FROM orders o
JOIN users u ON u.id = o.user_id
WHERE o.status = 'PENDING' AND u.tier = 'enterprise'
ORDER BY o.created_at DESC
LIMIT 50;

-- INDEX STRATEGY:
-- Step 1: Filter orders (status = 'PENDING').
CREATE INDEX idx_orders_pending_user ON orders(status, user_id, created_at DESC)
WHERE status = 'PENDING';   -- partial index: only PENDING orders indexed
-- Covers: status filter, user_id for join, created_at for sort.

-- Step 2: Filter users (tier = 'enterprise').
CREATE INDEX idx_users_enterprise ON users(id) WHERE tier = 'enterprise';
-- or: CREATE INDEX idx_users_id_tier ON users(id, tier);

-- EXPECTED PLAN:
Limit (rows=50)
  -> Nested Loop
     -> Index Scan on orders using idx_orders_pending_user  ← suffix scan for sort
          Index Cond: (status = 'PENDING')
     -> Index Scan on users using idx_users_enterprise
          Index Cond: (id = orders.user_id)
          Filter: (tier = 'enterprise')

-- HASH JOIN ALTERNATIVE (when enterprise users overlap significantly with pending orders):
-- Planner may choose: Hash users WHERE tier='enterprise' → probe against orders.
-- If enterprise users are rare (< 1%) → nested loop + users index likely wins.
-- If enterprise users are 40% → hash join + full scan of pending orders likely wins.
-- Let statistics guide the planner. Only override (via hints or join_collapse_limit) if EXPLAIN
-- shows clearly wrong estimates vs actual rows.
```

### LATERAL JOIN for Row-by-Row Subquery Optimization

```sql
-- GOAL: For each user, get their most recent 3 orders.
-- ❌ BAD: Correlated subquery (N subqueries)
SELECT u.id, u.email,
  (SELECT ARRAY_AGG(total ORDER BY created_at DESC)
   FROM (SELECT total, created_at FROM orders WHERE user_id = u.id
         ORDER BY created_at DESC LIMIT 3) t) AS recent_totals
FROM users u;

-- ✅ CORRECT: LATERAL JOIN (single scan, declarative)
SELECT u.id, u.email, recent.total, recent.created_at
FROM users u
CROSS JOIN LATERAL (
  SELECT total, created_at
  FROM orders
  WHERE user_id = u.id
  ORDER BY created_at DESC
  LIMIT 3
) AS recent;

-- LATERAL: for each row in the LEFT side (users), executes the subquery once.
-- With index on orders(user_id, created_at DESC): each subquery = 3 index reads.
-- Total: users × 3 index reads = fast nested loop.
-- vs correlated subquery: semantically identical but LATERAL makes intent explicit to planner.
-- Planner treats LATERAL as nested loop with inner being the lateral subquery.
-- Performance: O(N × 3 × log M) = optimal for top-K per group.
```
