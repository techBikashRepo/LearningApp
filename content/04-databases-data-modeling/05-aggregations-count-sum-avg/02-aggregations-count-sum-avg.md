# Aggregations (COUNT, SUM, AVG) — Part 2 of 3

### Sections: 5 (Bad vs Correct), 6 (Performance Impact), 7 (Concurrency), 8 (Optimization & Indexing)

**Series:** Databases & Data Modeling → Topic 05

---

## SECTION 5 — Bad Usage vs Correct Usage

### Pattern 1: COUNT(\*) vs COUNT(col) vs COUNT(DISTINCT col) Confusion

```sql
-- THE THREE COUNTS — THEY ARE NOT EQUIVALENT:

-- COUNT(*): counts ALL rows in group, including NULLs. Never returns NULL.
-- COUNT(col): counts non-NULL values of col. Returns 0 if all are NULL.
-- COUNT(DISTINCT col): counts unique non-NULL values. Slowest. Never returns NULL.

-- EXAMPLE TABLE: orders (id, user_id, coupon_id, amount)
-- Rows: id=1 user=1 coupon=NULL amount=10
--       id=2 user=1 coupon=100  amount=20
--       id=3 user=2 coupon=100  amount=30

SELECT
  COUNT(*)             AS total_orders,       -- 3
  COUNT(coupon_id)     AS orders_with_coupon, -- 2 (ignores NULL)
  COUNT(DISTINCT user_id) AS unique_users,    -- 2
  COUNT(DISTINCT coupon_id) AS unique_coupons -- 1 (100 appears twice but is one coupon)
FROM orders;

-- ❌ BAD: Using COUNT(nullable_column) to count total rows
SELECT department_id, COUNT(manager_id) AS headcount
FROM employees
GROUP BY department_id;
-- Some employees have no manager (manager_id IS NULL, e.g., top-level managers).
-- COUNT(manager_id) = 0 for those → falsely reports 0 headcount for their department.
-- Query intent was "how many employees per department" — should be COUNT(*).

-- ✅ CORRECT:
SELECT department_id, COUNT(*) AS headcount FROM employees GROUP BY department_id;
```

### Pattern 2: AVG Masking Bimodal Distribution

```sql
-- ❌ BAD: Using AVG for system health monitoring
SELECT AVG(response_time_ms) AS avg_response_time FROM api_requests
WHERE endpoint = '/api/checkout' AND created_at > NOW() - INTERVAL '1 hour';
-- Returns: 210ms. Alert threshold: 500ms. No alert fires.
-- Reality:
--   95% of requests: 50ms (fast path, cached)
--   5% of requests:  3,200ms (slow path, no cache, DB contention)
--   Weighted average: (0.95 × 50) + (0.05 × 3200) = 208ms. Looks healthy. Isn't.
-- 5% of users experience 3.2-second checkouts. Revenue impact: measurable.

-- ✅ CORRECT: Use percentiles
SELECT
  PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY response_time_ms) AS p50,
  PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY response_time_ms) AS p95,
  PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY response_time_ms) AS p99,
  MAX(response_time_ms) AS max_response
FROM api_requests
WHERE endpoint = '/api/checkout' AND created_at > NOW() - INTERVAL '1 hour';
-- p50: 48ms (healthy). p95: 1,800ms (problem). p99: 3,200ms (disaster). Max: 8,900ms (incident).
-- Dashboard now shows reality. Alert on p95 > 500ms fires immediately.
```

### Pattern 3: SUM on Floating-Point Columns for Financial Data

```sql
-- ❌ BAD: SUM on FLOAT/DOUBLE for monetary values
CREATE TABLE line_items (id SERIAL, price FLOAT);
-- Float: 0.1 + 0.2 = 0.30000000000000004 in IEEE 754.

SELECT SUM(price) FROM line_items;
-- 10M line items × small rounding errors → significant cumulative drift.
-- Invoice total: $47,832.12. Correct total: $47,832.07. Drift: $0.05 shown to user.
-- At 1M invoices/day: auditor flags unexplained $50,000/day discrepancy.

-- ✅ CORRECT: Use NUMERIC (exact decimal arithmetic)
CREATE TABLE line_items (id SERIAL, price NUMERIC(12, 4));
-- NUMERIC(12,4): up to 99,999,999.9999. No floating-point rounding.
-- SUM(price): exact. $47,832.07 always returns $47,832.07.
-- Cost: NUMERIC is ~2-4x slower than FLOAT for arithmetic. Acceptable for financial data.

-- ALTERNATIVELY: Store amounts as integer cents.
price_cents BIGINT  -- $47.99 stored as 4799. No decimal, no float, no rounding.
-- Division only at display time: price_cents / 100.0 → format as currency string.
-- Aggregation: SUM(price_cents) is pure integer arithmetic. Exact and fast.
```

### Pattern 4: NULL Propagation in Aggregate Chains

```sql
-- ❌ BAD: Chaining aggregates where NULL propagates
SELECT
  AVG(score) AS average_score,
  AVG(score) * 100 AS percentage    -- NULL * 100 = NULL if no rows match
FROM assessments
WHERE employee_id = 9999 AND year = 2024;
-- Employee 9999 has no assessments: AVG(score) = NULL.
-- percentage = NULL * 100 = NULL.
-- ORM: maps NULL to None/nil/null. Application: tries to format None as "%.1f%%" → TypeError.

-- ✅ CORRECT: COALESCE at the aggregation boundary
SELECT
  COALESCE(AVG(score), 0)       AS average_score,
  COALESCE(AVG(score), 0) * 100 AS percentage
FROM assessments
WHERE employee_id = 9999 AND year = 2024;
-- Returns 0 and 0 instead of NULL. Application renders "0.0%" instead of crashing.
-- Design decision: is 0 the right default? Or -1 to signal "no data"? Document your convention.
```

---

## SECTION 6 — Performance Impact

### COUNT(DISTINCT) — The Most Expensive Aggregate

```
COUNT(*):         O(N). Simple counter increment per row. No deduplication.
COUNT(col):       O(N). Same as COUNT(*) with NULL check.
COUNT(DISTINCT):  O(N log N) or O(N) with hash. Must deduplicate all values.
                  PostgreSQL: uses hash set or sort to deduplicate.

EXAMPLE: COUNT(DISTINCT user_id) in events table (50M rows, 2M distinct users).
  Postgres executes: build hash set of all user_ids seen → scan all 50M rows → count set size.
  Memory: 2M distinct user_ids × ~8 bytes each = 16MB in hash set.
  Time: full sequential scan + hash insertion × 50M. ~30 seconds on spinning disk.

APPROXIMATE COUNT(DISTINCT) FOR ANALYTICS:
  Extension: pg_hll (HyperLogLog) — probabilistic cardinality estimation.
  Error: typically ±2%. Time: same as COUNT(*). Memory: ~1KB regardless of cardinality.

  -- HyperLogLog in TimescaleDB / analytics:
  SELECT hll_cardinality(hll_add_agg(hll_hash_integer(user_id))) AS approx_distinct_users
  FROM events WHERE day = '2024-03-15';
  -- Returns: 1,986,242 (actual: 2,000,000 ± 1.4%)
  -- Time: 2 seconds. vs COUNT(DISTINCT): 28 seconds.
  -- Acceptable for dashboards showing "~2M DAU". Not for billing where exact counts matter.
```

### Aggregate Pushdown in Execution Plan

```
QUERY: SELECT region, SUM(total) FROM orders GROUP BY region;

WITHOUT PARALLEL QUERY:
  Seq Scan orders (50M rows) → HashAggregate (5 regions) → Result.
  Single worker. Time: 45 seconds.

WITH PARALLEL QUERY (enable_parallel_hash = on, max_parallel_workers_per_gather = 4):
  Gather → workers: each scans 12.5M rows.
  Each worker: partial HashAggregate (5 regions, partial sums).
  Gather: merge 4 partial aggregations (5 groups each) → final 5 rows.

  EXPLAIN:
    Finalize HashAggregate  (rows=5)
      -> Gather  (workers: 4)
         -> Partial HashAggregate  (rows=5 per worker)
            -> Parallel Seq Scan on orders  (each worker scans 25% of pages)

  Time: 12 seconds (near-linear scale with 4 workers, minus parallelization overhead).
  At 8 workers: ~7 seconds (diminishing returns as gather + merge cost grows).

PARTIAL AGGREGATE: each worker maintains 5-row hash table (one per region).
  Not 50M/4 row hash tables. Always 5. Memory: trivial.
  Without partial aggregation (old behavior): each worker aggregates all rows → 4 final merge.
  With partial aggregation: each sums 12.5M rows, produces 5-row partial → 4 × 5 = 20 row merge.
  20 rows merged at gather: O(1). Zero bottleneck.
```

---

## SECTION 7 — Concurrency

### Aggregate Staleness and Dirty Reads

```
READ COMMITTED: COUNT(*) sees committed rows as of statement start.
  "How many active users?" → 50,022 (correct snapshot at query start).
  Concurrent insert of new user: not visible to this COUNT. Added to next count.
  Acceptable for dashboards. Not acceptable for billing or inventory.

INVENTORY CONTROL (needs exact count):
  Problem: "How many widgets in stock?" query concurrent with reservation transactions.

  ❌ WRONG approach:
    Separate: SELECT COUNT(*) FROM inventory WHERE status = 'AVAILABLE' AND sku = 'WIDGET-X';
    Reserve:  UPDATE inventory SET status = 'RESERVED' WHERE sku = 'WIDGET-X' AND status = 'AVAILABLE' LIMIT 1;
    The COUNT is a separate transaction — a new reservation could occur between COUNT and UPDATE.
    COUNT says 5 available. By UPDATE time: 0 available. UPDATE affects 0 rows. Silent failure.

  ✅ CORRECT: Use SELECT FOR UPDATE (pessimistic) or optimistic locking.
    BEGIN;
    SELECT COUNT(*) FROM inventory WHERE sku = 'WIDGET-X' AND status = 'AVAILABLE' FOR UPDATE;
    -- Locks available rows. Concurrent reservations block until this transaction commits.
    -- If count >= 1: proceed with UPDATE.
    -- If count = 0: ROLLBACK, inform user "out of stock."
    COMMIT;
```

---

## SECTION 8 — Optimization & Indexing

### Materialized Aggregate Tables

```sql
-- HIGH-FREQUENCY QUERY: "Daily active users for last 30 days."
-- events table: 500M rows. Full scan + DATE_TRUNC + COUNT(DISTINCT) = minutes.

-- ✅ PATTERN: Incremental aggregate materialization.
-- Step 1: Create summary table.
CREATE TABLE daily_active_users (
  day DATE PRIMARY KEY,
  dau INT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Step 2: Populate historical data (run once, off-hours).
INSERT INTO daily_active_users (day, dau)
SELECT DATE_TRUNC('day', created_at), COUNT(DISTINCT user_id)
FROM events
WHERE created_at < CURRENT_DATE
GROUP BY 1
ON CONFLICT (day) DO UPDATE SET dau = EXCLUDED.dau, updated_at = NOW();

-- Step 3: Incremental daily job (runs once per day, processes 1 day of events).
INSERT INTO daily_active_users (day, dau)
SELECT DATE_TRUNC('day', created_at), COUNT(DISTINCT user_id)
FROM events
WHERE created_at >= CURRENT_DATE - INTERVAL '1 day'
  AND created_at < CURRENT_DATE
GROUP BY 1
ON CONFLICT (day) DO UPDATE SET dau = EXCLUDED.dau, updated_at = NOW();
-- Processes ~1M events (one day) instead of 500M. Runs in seconds.

-- Step 4: Dashboard query.
SELECT day, dau FROM daily_active_users
WHERE day >= CURRENT_DATE - INTERVAL '30 days'
ORDER BY day;
-- Returns 30 rows. Microseconds. Zero aggregation.
```

### Window Functions vs GROUP BY

```sql
-- GOAL: For each order, show the order total AND the customer's total lifetime value.
-- NEED: aggregation (customer total) alongside individual row data.

-- ❌ BAD: Correlated subquery (N+1 query pattern)
SELECT
  o.id,
  o.total,
  (SELECT SUM(o2.total) FROM orders o2 WHERE o2.customer_id = o.customer_id) AS ltv
FROM orders o
WHERE o.created_at > '2024-01-01';
-- For each row in orders: executes a separate SELECT. 10,000 orders → 10,001 queries.
-- Time: 10,001 × ~5ms each = 50 seconds.

-- ✅ CORRECT: Window function (single scan)
SELECT
  id,
  total,
  SUM(total) OVER (PARTITION BY customer_id) AS ltv
FROM orders
WHERE created_at > '2024-01-01';
-- Single scan. Window function computed in one pass.
-- Time: ~0.5 seconds. 100x faster.

-- MULTIPLE WINDOW FUNCTIONS (reuse WINDOW definition for single sort pass):
SELECT
  id,
  total,
  SUM(total)   OVER w AS ltv,
  COUNT(*)     OVER w AS order_count,
  AVG(total)   OVER w AS avg_order_value,
  MAX(total)   OVER w AS largest_order,
  ROW_NUMBER() OVER w AS order_rank
FROM orders
WHERE created_at > '2024-01-01'
WINDOW w AS (PARTITION BY customer_id ORDER BY created_at);
-- All window functions share the same WINDOW w → sorted once.
-- Without WINDOW clause: potentially 5 separate sort operations.
```
