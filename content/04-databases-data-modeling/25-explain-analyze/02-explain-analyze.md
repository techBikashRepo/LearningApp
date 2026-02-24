# EXPLAIN ANALYZE — Part 2 of 3

### Sections: 5 (Bad vs Correct Usage), 6 (Performance Impact), 7 (Concurrency & Data Integrity), 8 (Optimization & Indexing)

**Series:** Databases & Data Modeling → Topic 25

---

## SECTION 5 — Bad Usage vs Correct Usage

### Common EXPLAIN ANALYZE Anti-Patterns

**Anti-Pattern 1: Reading only the top-level cost — missing the expensive inner node**

```
-- BAD: glancing at the top-level row and stopping:
EXPLAIN ANALYZE SELECT ...;
--  Nested Loop  (cost=0.56..8.91 rows=1 width=32) (actual time=1.2..4823.4 rows=1 loops=1)
--  ↑ "Only 8.91 cost? That seems fine." WRONG.

-- The top-level cost is the SUM of all children.
-- You must read BOTTOM-UP to find the expensive node:

EXPLAIN ANALYZE SELECT o.id, u.name, oi.qty
FROM orders o
JOIN users u ON u.id = o.user_id
JOIN order_items oi ON oi.order_id = o.id
WHERE o.status = 'completed';

-- Output (simplified):
-- Nested Loop  (actual time=0.03..4823.12 rows=100 loops=1)
--   -> Nested Loop  (actual time=0.02..4700.44 rows=100 loops=1)
--       -> Seq Scan on orders  (actual time=0.01..0.12 rows=100 loops=1)
--           Filter: (status = 'completed')
--       -> Index Scan on users  (actual time=0.04..47.00 rows=1 loops=100)  ←← EXPENSIVE
--
-- Reading: Seq Scan on orders: trivial (100 rows, 0.12ms).
--          Index Scan on users: 47ms × 100 loops = 4,700ms total. THE CULPRIT.
--          users needs a better index or the data distribution is unexpected.
-- Action: EXPLAIN shows users index scan per order. 100 orders → 100 user lookups.
--         This just revealed an N+1 inside a "JOIN" that the planner serialized.
--         Even with a JOIN: nested loop + poor statistics = N+1 behavior.
```

---

**Anti-Pattern 2: Ignoring the `loops` multiplier**

```
-- BAD: looking at per-loop time and thinking it's total time.
-- EXPLAIN ANALYZE output:
-- Index Scan on order_items  (actual time=0.05..0.08 rows=3 loops=500)
-- Developer sees: "0.08ms — very fast!"
-- WRONG: total time = 0.08ms × 500 loops = 40ms. Not 0.08ms.
-- The loops= field is the MULTIPLIER. Always compute: actual_time × loops.

-- CORRECT reading: find the node with highest (actual_time * loops):
SELECT
    node_type,
    actual_total_time,
    loops,
    actual_total_time * loops AS total_contribution_ms
-- This is why reading EXPLAIN ANALYZE output requires computing per-node totals.

-- Practical habit: for every node, compute actual_total_time × loops.
-- The highest product: that's your bottleneck.
```

---

**Anti-Pattern 3: Running DML inside EXPLAIN ANALYZE without ROLLBACK**

```sql
-- BAD: forgetting ROLLBACK when using EXPLAIN ANALYZE on INSERT/UPDATE/DELETE
EXPLAIN ANALYZE INSERT INTO orders (user_id, status) VALUES (1, 'pending');
-- EXPLAIN ANALYZE actually EXECUTES the statement.
-- Row inserted. Rows count incremented. Data changed in production.
-- Developer thought they were "just checking the plan." Oops.

-- CORRECT: wrap DML in a transaction and rollback:
BEGIN;
EXPLAIN ANALYZE INSERT INTO orders (user_id, status) VALUES (1, 'pending');
ROLLBACK;
-- Row inserted during analysis, then rolled back.
-- Production data unchanged. Plan observed.

-- For SELECT: no transaction needed (read-only, no side effects).
-- For INSERT/UPDATE/DELETE: ALWAYS BEGIN + ROLLBACK.
```

---

**Anti-Pattern 4: Trusting EXPLAIN (without ANALYZE) for actual performance**

```sql
-- BAD: using EXPLAIN (not ANALYZE) to diagnose a slow query
EXPLAIN SELECT * FROM events WHERE event_date > '2024-01-01';
-- Output:
--   Seq Scan on events (cost=0.00..48500.00 rows=2400 width=128)
-- Developer: "2,400 rows seems right. Cost 48,500 is high but acceptable."

-- ACTUAL execution (with ANALYZE):
EXPLAIN ANALYZE SELECT * FROM events WHERE event_date > '2024-01-01';
--   Seq Scan on events (actual time=0.019..12847.3 rows=8340000 loops=1)
--                                                          ^^^^ not 2,400 rows!
-- Estimate: 2,400. Actual: 8.34M rows. Statistics were stale.
-- EXPLAIN lied (gave planner's estimate). ANALYZE told the truth (actual execution).

-- Rule: for diagnosis of actual query slowness: ALWAYS use EXPLAIN ANALYZE.
--       EXPLAIN (no ANALYZE) is only useful for checking planner choices without executing.
```

---

## SECTION 6 — Performance Impact

### EXPLAIN ANALYZE Overhead and Buffer Analysis

```
EXPLAIN ANALYZE overhead:
  Added timing collection: ~1-5% overhead on most queries.
  EXPLAIN (ANALYZE, BUFFERS): ~5-10% overhead (buffer I/O tracking adds counters).
  Acceptable for optimization work. Never use in a production hot path.

Buffer analysis — cache miss detection:
  EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM orders WHERE user_id = 42;

  -- shared hit=842 read=0
  -- "shared hit=842": 842 buffer pages served from shared_buffers (RAM). Fast.
  -- "read=0": zero pages read from disk. Fully cached. Fast.

  -- vs cold cache:
  -- shared hit=12 read=830
  -- "shared hit=12": 12 pages from RAM.
  -- "read=830": 830 pages from disk I/O.
  -- 830 disk pages × 8KB = 6.6MB of disk I/O for this query.
  -- Optimisation: this query will be slow until data is cached.
  --   Solutions: increase shared_buffers, pre-warm cache, add a narrower index.

work_mem and Sort Method:
  EXPLAIN ANALYZE SELECT ... ORDER BY amount DESC:

  -- Sort Method: quicksort  Memory: 2048kB    → fits in work_mem. Fast.
  -- vs:
  -- Sort Method: external merge  Disk: 28672kB  → spilled to disk. Slow.
  -- "external merge Disk": the sort required 28 MB but work_mem was too small.
  -- Fix: SET work_mem = '64MB' for session, or increase per sort operation.
  -- Production: add to postgresql.conf for query types that commonly sort large sets.
```

---

**Row estimate vs actual rows — the most important diagnostic:**

```
-- Row estimate mismatch = stale statistics or non-uniform distribution.
-- This single issue causes 80% of bad query plans.

-- Estimating join selectivity:
PostgreSQL estimates: 100 rows after WHERE filter.
Actual: 8.3M rows.
Ratio: 83,000x underestimate.

-- Effect on plan choice:
-- 100 rows estimates → planner chooses Hash Join (good for small sets).
-- 8.3M rows actual → Hash Join requires 8.3M rows in memory → hash spill to disk.
-- Better plan for 8.3M rows: Merge Join or partitioned scan.
-- Planner can't choose the right plan with wrong row estimates.

-- Fix 1: run ANALYZE to refresh statistics:
ANALYZE events;  -- updates pg_statistic for events table.
-- Cost: takes a sample (~30,000 rows default). Runs in seconds. Non-blocking.

-- Fix 2: increase statistics target for skewed columns:
ALTER TABLE events ALTER COLUMN event_type SET STATISTICS 500;
-- Default: 100 buckets. Increasing to 500: better estimates for high-cardinality columns.
ANALYZE events;  -- re-analyze with new target.
```

---

## SECTION 7 — Concurrency & Data Integrity

### Plan Stability Under Load

**Auto-explain for production capture:**

```sql
-- Problem: slow queries in production can't be manually EXPLAIN ANALYZED in real-time.
-- You need query plans captured AUTOMATICALLY when queries exceed a threshold.

-- Setup auto_explain extension:
LOAD 'auto_explain';
SET auto_explain.log_min_duration = 1000;  -- log plans for queries > 1 second
SET auto_explain.log_analyze = TRUE;
SET auto_explain.log_buffers = TRUE;
SET auto_explain.log_format = 'json';  -- JSON for programmatic parsing

-- Or in postgresql.conf (permanent):
shared_preload_libraries = 'auto_explain'
auto_explain.log_min_duration = 1000
auto_explain.log_analyze = on
auto_explain.log_buffers = on

-- Result: PostgreSQL logs to pg_log every query exceeding 1 second WITH full EXPLAIN ANALYZE.
-- Next morning: review pg_log for plans of last night's slow queries.

-- WARNING: auto_explain.log_analyze = on: executes EXPLAIN ANALYZE on slow queries.
-- For extremely hot paths this adds overhead. Set log_min_duration high enough
-- that only genuinely slow queries are analyzed (>1s or >5s).
```

---

**Parallel query EXPLAIN output:**

```
-- EXPLAIN ANALYZE with parallel execution:
-- Gather  (actual time=1.2..4823.1 rows=100000 loops=1)
--   Workers Planned: 4
--   Workers Launched: 4     ← if fewer than planned: OS concurrency limits
--   -> Parallel Seq Scan on events  (actual time=0.1..3122.4 rows=25000 loops=5)
--      (loops=5: 4 workers + 1 leader, each scanning 25K rows)

-- How to read parallel plans:
-- loops=5: total of 5 processes ran this node (1 leader + 4 workers).
-- actual rows: 25,000 per loop. Total rows: 25,000 × 5 = 125,000. OK.
-- actual time: per-process time, NOT total wall clock. Wall clock ≠ per-node time / loops.
-- Gather node actual time: THAT is the wall clock (end-to-end observing time).

-- Workers Launched < Workers Planned: max_parallel_workers or OS limit hit.
-- Check: SHOW max_parallel_workers_per_gather;
```

---

## SECTION 8 — Optimization & Indexing

### Using EXPLAIN ANALYZE to Guide Index Decisions

```sql
-- Complete optimization workflow using EXPLAIN ANALYZE:

-- Step 1: Capture the slow query plan:
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT u.id, u.name, COUNT(o.id) AS order_count
FROM users u
LEFT JOIN orders o ON o.user_id = u.id
WHERE u.created_at > '2024-01-01'
GROUP BY u.id, u.name
ORDER BY order_count DESC
LIMIT 20;

-- Step 2: Look for:
-- a) Seq Scan: on a large table (>100K rows) → likely needs an index.
-- b) shared read > shared hit: data not cached → index may help with smaller scans.
-- c) Row estimate vs actual: large ratio → run ANALYZE on affected table.
-- d) Sort: external merge → increase work_mem or add covering index with ORDER BY.
-- e) Hash Batches > 1: hash spill → increase work_mem.

-- Step 3: Create candidate index:
CREATE INDEX CONCURRENTLY idx_users_created_at ON users(created_at DESC);
-- CONCURRENTLY: no table lock on users during index build.

-- Step 4: Re-run EXPLAIN ANALYZE and compare:
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT ...;  -- same query
-- Compare: old vs new actual time, rows scanned, buffer hits.

-- Step 5: Use pg_stat_user_indexes to verify the new index is being used:
SELECT
    indexrelname AS index_name,
    idx_scan       AS times_used,
    idx_tup_read   AS tuples_read,
    idx_tup_fetch  AS tuples_fetched
FROM pg_stat_user_indexes
WHERE relname = 'users';
-- If idx_scan = 0 after the index was created and queries ran:
-- the index is NOT being used. Either: statistics need updating or planner
-- estimates that a seq scan is cheaper (table too small, or data skew).

-- JSON output for automated tooling (pganalyze, Dalibo explain.depesz.com):
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
SELECT ...;
-- JSON plan can be pasted into explain.depesz.com for visual breakdown,
-- or sent to pganalyze for continuous plan regression tracking (plan changes over time).

-- Track plan regressions in production:
-- pg_stat_statements gives you total_exec_time and calls.
-- If mean_exec_time for a specific query suddenly doubles week-over-week:
--   1. Run EXPLAIN ANALYZE on that query manually.
--   2. Compare: has the plan changed? (e.g., Seq Scan where Index Scan was before?)
--   3. Likely cause: new data volume pushed planner past a threshold, or stale stats.
--   4. ANALYZE + pg_hint_plan for emergency plan control if needed.
```
