# ORDER BY — Part 2 of 3

### Sections: 5 (Bad vs Correct), 6 (Performance Impact), 7 (Concurrency), 8 (Optimization & Indexing)

**Series:** Databases & Data Modeling → Topic 03

---

## SECTION 5 — Bad Usage vs Correct Usage

### Pattern 1: ORDER BY Without LIMIT on Large Tables

```sql
-- ❌ BAD: Full sort of million-row result
SELECT user_id, amount, created_at FROM transactions
ORDER BY created_at DESC;
-- Returns ALL 50M rows, sorted. Sort cost: O(N log N). Memory or disk spill.
-- Caller: a Python script that reads the first 100 rows then closes cursor.
-- Wasted: sorted 50M rows, transferred ~5GB, used 0.01% of the result.

-- ✅ CORRECT: Declare intent with LIMIT
SELECT user_id, amount, created_at FROM transactions
ORDER BY created_at DESC
LIMIT 100;
-- Planner: top-N heapsort. Maintains heap of 100 rows. O(N log 100) ≈ O(N).
-- Memory: only 100 rows held. No sort spill.
-- If index on created_at: Index Scan Backward → 0 sort cost. Just read 100 rows.
```

### Pattern 2: OFFSET Pagination — The Performance Cliff

```sql
-- ❌ BAD: OFFSET-based pagination at large offsets
-- Page 1: OFFSET 0   LIMIT 20  → reads rows 1-20.
-- Page 2: OFFSET 20  LIMIT 20  → reads rows 1-40, discards 1-20, returns 21-40.
-- Page 500: OFFSET 9980 LIMIT 20 → reads rows 1-10,000. Discards 9,980. Returns 20.
-- Page 5000: OFFSET 99,980 LIMIT 20 → reads 100,000 rows. Returns 20.
-- Latency grows LINEARLY with page number. Page 10K: 200,000 rows read for 20 returned.

-- REAL PRODUCTION DATA:
-- Offset 0:      3ms
-- Offset 10,000: 45ms
-- Offset 100,000: 420ms
-- Offset 500,000: 2,100ms → users on page 25,000 experience 2+ second loads.

-- ✅ CORRECT: Keyset (cursor-based) pagination
-- First page:
SELECT id, amount, created_at FROM transactions
ORDER BY created_at DESC, id DESC
LIMIT 20;
-- Returns: last_created_at = '2024-03-15 14:22:33', last_id = 98765

-- Next page (uses cursor, not offset):
SELECT id, amount, created_at FROM transactions
WHERE (created_at, id) < ($last_created_at, $last_id)
ORDER BY created_at DESC, id DESC
LIMIT 20;

-- PERFORMANCE: Always index scan from cursor position. O(1) regardless of page number.
-- Offset 0 and "page 5 million": same latency (~3ms).
-- TRADEOFF: cannot jump to arbitrary page. Only "next page" / "previous page".
-- Use case: infinite scroll, feed pagination, API cursors. NOT admin "jump to page N" UIs.
```

### Pattern 3: ORDER BY on Non-Deterministic Column Sets

```sql
-- ❌ BAD: Tie-breaking undefined
SELECT id, name FROM products WHERE category = 'electronics'
ORDER BY price ASC;
-- Multiple products at same price: ordering between them undefined.
-- Page 1: returns [product_A, product_C] at price=99.
-- Page 2 with OFFSET 20: same query, different execution plan → [product_C, product_A].
-- product_C appears on BOTH pages. product_B appears on NEITHER.
-- Users see duplicates. Items "disappear."

-- ✅ CORRECT: Always include a unique tiebreaker
SELECT id, name FROM products WHERE category = 'electronics'
ORDER BY price ASC, id ASC;  -- id is unique → deterministic order guaranteed.
-- Keyset pagination cursor: (price, id) tuple. Always unique. No duplicates, no skips.
```

---

## SECTION 6 — Performance Impact

### Sort Memory and Temp Disk Spill

```
POSTGRES SORT MEMORY:
  work_mem: memory allocated per sort operation per query plan node.
  Default: 4MB. Pitfall: a single query can have MULTIPLE sort nodes (e.g., multiple window funcs).

  If sort fits in work_mem: in-memory quicksort. Fast.
  If sort exceeds work_mem: external merge sort (spills runs to disk, merges).

  SPILL DETECTION:
  EXPLAIN (ANALYZE):
    Sort Method: quicksort  Memory: 1024kB    ← in-memory. Good.
    Sort Method: external merge  Disk: 45678kB ← spilled 45MB to disk. Slow.

IMPACT OF SPILL:
  In-memory sort: ~100ns per comparison.
  Disk sort: read run files (disk I/O) → 1000x slower per comparison.
  Table: 10M rows × 200B each = 2GB of sort data.
  work_mem=4MB: ~500 disk runs generated → 9 merge passes → 9x data read from disk.
  work_mem=256MB: fits ~1.2M rows per run → 8-9 runs → 1 merge pass.
  work_mem=2048MB: fits all 10M rows in memory → pure quicksort. Zero disk I/O.

CAUTION with work_mem:
  Setting work_mem=2048MB globally: each connection can use 2GB per sort node.
  100 connections × 5 sort nodes each = 100 × 5 × 2GB = 1TB RAM needed. OOM.
  SAFE APPROACH: set low globally, high per session for known heavy sort queries:
    SET LOCAL work_mem = '256MB';  -- applies to current transaction only
    <execute heavy sort query>
    -- resets after transaction

MONITORING:
  SELECT query, sort_temp_bytes FROM pg_stat_activity WHERE sort_temp_bytes > 0;
  -- Shows active queries currently spilling sorts to temp disk.
```

### OFFSET Latency Profile (Measured)

```
TABLE: events, 50M rows, index on (user_id, created_at)

Query:
  SELECT id, type, created_at FROM events
  ORDER BY created_at DESC LIMIT 20 OFFSET $1;

Offset 0:         3ms    (index reads ~20 rows)
Offset 1,000:     8ms    (index reads 1,020 rows, discards 1,000)
Offset 10,000:    45ms   (reads 10,020, discards 10,000)
Offset 100,000:   410ms  (reads 100,020, discards 100,000)
Offset 500,000:   2,100ms
Offset 1,000,000: 4,200ms  → SLA breach (typical p99 budget: 500ms)

SAME QUERY with keyset pagination:
  All pages: 3-5ms. Flat line. O(1) per page regardless of depth.
```

---

## SECTION 7 — Concurrency & Ordering Stability

### Phantom Ordered Results Across Transactions

```
SCENARIO: Pagination API, READ COMMITTED isolation (default).

Transaction A — User loads page 1:
  SELECT ... ORDER BY created_at DESC LIMIT 10 OFFSET 0;
  Returns items sorted by created_at, IDs: [100, 99, 98, 97, 96, 95, 94, 93, 92, 91]

Transaction B — Concurrent INSERT:
  INSERT INTO items (created_at) VALUES ('2024-03-15 09:00:01');
  New item: id=101, created_at BETWEEN id=100 and id=99 (same second, different microsecond)
  Transaction B commits.

Transaction A — User loads page 2 (separate request, new transaction):
  SELECT ... ORDER BY created_at DESC LIMIT 10 OFFSET 10;
  New snapshot: now includes id=101.
  id=91 has shifted to offset 11.
  Page 2 returns: [90, 89, 88, 87, 86, 85, 84, 83, 82, 81] — id=91 skipped.

EFFECT: id=91 never shown to user. Phantom skip due to concurrent insert shifting positions.
Can't be solved with OFFSET pagination under READ COMMITTED.
SOLUTION: Keyset pagination (cursor-based) navigates by value, not position.
  New inserts before cursor: not visible (cursor filter drops them). No skips.
```

---

## SECTION 8 — Optimization & Indexing

### Index-Backed Sort (Zero Sort Cost)

```sql
-- QUERY: Latest 100 orders for a specific user.
SELECT id, total, status, created_at FROM orders
WHERE user_id = $1
ORDER BY created_at DESC
LIMIT 100;

-- NAIVE INDEX: (user_id) only.
--   Scan: uses index to find all user_id rows → heap fetch each → sort → limit.
--   For user with 50,000 orders: 50,000 heap fetches + sort 50,000 rows → 20-100ms.

-- COMPOSITE INDEX: (user_id, created_at DESC)
CREATE INDEX idx_orders_user_created ON orders(user_id, created_at DESC);
-- Planner: index already sorted by (user_id, created_at DESC).
-- Execution: index scan + LIMIT stops at row 100.
-- NO SORT STEP in plan. O(100 × log N) regardless of total rows for user.

EXPLAIN:
  Limit (rows=100)
    -> Index Scan Backward using idx_orders_user_created on orders
         Index Cond: (user_id = $1)
         -- "Backward" because DESC = walking index in reverse.
         -- But if index is (user_id, created_at DESC), forward scan = DESC order already.
         -- "Index Scan" not "Sort" → zero sort cost.

TIME COMPARISON (user with 50K orders):
  Without composite index: 85ms (sort 50K rows)
  With composite index:     1.2ms (read 100 rows from pre-sorted index)

-- COVERING variant (eliminate heap reads entirely):
CREATE INDEX idx_orders_user_created_covering
ON orders(user_id, created_at DESC)
INCLUDE (id, total, status);
-- Index Only Scan: no heap reads. From 1.2ms → 0.3ms.
```

### Incremental Sort (PostgreSQL 13+)

```sql
-- SCENARIO: Partial sort order already established.
-- Query: SELECT user_id, created_at, total FROM orders ORDER BY user_id, created_at DESC;
-- Index: on user_id only.

-- PRE-PG13: Seq Scan → Sort on (user_id, created_at). Full sort of all rows.
-- PG13+: Incremental Sort:
--   1. Index Scan on user_id: rows arrive sorted by user_id (partial sort).
--   2. For each group of rows sharing same user_id: sort by created_at.
--   3. Never sort the entire table at once — sort small groups.
--   Memory: max(group_size × row_size) instead of total_rows × row_size.
--   For even user distribution: each group ~1,000 rows. Tiny sort, no spill.

EXPLAIN output:
  Incremental Sort (key: user_id, created_at DESC) (presorted key: user_id)
    -> Index Scan on orders using idx_orders_user
-- "presorted key: user_id" means first key already sorted; second sorted in small batches.
```
