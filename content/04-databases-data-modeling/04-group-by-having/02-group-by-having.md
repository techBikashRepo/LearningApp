# GROUP BY & HAVING — Part 2 of 3

### Sections: 5 (Bad vs Correct), 6 (Performance Impact), 7 (Concurrency), 8 (Optimization & Indexing)

**Series:** Databases & Data Modeling → Topic 04

---

## SECTION 5 — Bad Usage vs Correct Usage

### Pattern 1: HAVING Instead of WHERE for Row-Level Filters

```sql
-- ❌ BAD: Filtering rows via HAVING (after aggregation)
SELECT department_id, COUNT(*) AS headcount
FROM employees
HAVING department_id IN (10, 20, 30);
-- DB does: scan ALL employees → group ALL → count ALL → discard groups not in (10,20,30).
-- 100,000 employees: 100,000 rows scanned + grouped, 97,000 discarded at end.

-- ✅ CORRECT: Filter rows via WHERE (before aggregation)
SELECT department_id, COUNT(*) AS headcount
FROM employees
WHERE department_id IN (10, 20, 30)
GROUP BY department_id;
-- DB does: index lookup on department_id IN (10,20,30) → read only 3 groups.
-- Only relevant rows enter the aggregation. 97% work eliminated.

-- THE RULE:
-- WHERE: filters individual rows BEFORE grouping. Can use indexes. Reduces input to GROUP BY.
-- HAVING: filters groups AFTER aggregation. Cannot use row-level indexes. Runs on derived values.

-- VALID HAVING USE: filter on an AGGREGATED value (WHERE can't do this):
SELECT department_id, COUNT(*) AS headcount
FROM employees
WHERE active = true              -- ← row filter: WHERE
GROUP BY department_id
HAVING COUNT(*) > 10;           -- ← group filter: HAVING (aggregated value)
-- COUNT(*) doesn't exist before grouping, so HAVING is mandatory here.
```

### Pattern 2: SELECT Non-Aggregated Column Without Grouping It

```sql
-- ❌ BAD: MySQL's loose GROUP BY (silently wrong results)
-- In MySQL 5.x (ONLY_FULL_GROUP_BY disabled):
SELECT department_id, employee_name, COUNT(*) AS headcount
FROM employees
GROUP BY department_id;
-- Returned employee_name: random employee in each department group.
-- There are 50 employees in department 10: which name is returned? Undefined.
-- Tests pass (always returns SOME name). Production: wrong names shown. Silent corruption.

-- ✅ Postgres/MySQL 8 strict mode: ERROR.
-- ERROR: column "employees.employee_name" must appear in the GROUP BY clause
-- or be used in an aggregate function.
-- Forces you to be explicit.

-- ✅ CORRECT: Explicit intent choices
-- Option A: Get all employees in groups:
SELECT department_id,
       array_agg(employee_name ORDER BY hire_date) AS employees,
       COUNT(*) AS headcount
FROM employees
GROUP BY department_id;

-- Option B: Get the most senior employee per department:
SELECT DISTINCT ON (department_id) department_id, employee_name
FROM employees
ORDER BY department_id, hire_date;
```

### Pattern 3: GROUP BY High-Cardinality Column in OLTP

```sql
-- ❌ BAD: Live report query, OLTP database, high-cardinality GROUP BY
SELECT DATE_TRUNC('minute', created_at) AS minute, COUNT(*) AS events
FROM events
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY DATE_TRUNC('minute', created_at);
-- 24 hours × 60 minutes = 1,440 groups. Seems fine.
-- BUT: events table has 50M rows/day → 50M rows in last 24h scanned and grouped.
-- On OLTP server (primary): massive CPU usage. Competes with production writes.
-- Runs every 30 seconds by a dashboard → constantly competing.

-- ✅ CORRECT: Async aggregation pattern
-- 1. Run the heavy aggregation on a read replica, not primary.
-- 2. Pre-aggregate into a summary table via scheduled job or trigger:
CREATE MATERIALIZED VIEW events_per_minute AS
SELECT DATE_TRUNC('minute', created_at) AS minute_bucket, COUNT(*) AS event_count
FROM events
GROUP BY 1;
-- Dashboard reads from materialized view: single index scan, ~1,440 rows. Microseconds.
-- Refresh: REFRESH MATERIALIZED VIEW CONCURRENTLY events_per_minute; (every 60s, non-blocking).
```

---

## SECTION 6 — Performance Impact

### Hash Aggregation Memory (Group Cardinality × Row Size)

```
POSTGRES HASH AGGREGATION:
  Hash table: one entry per unique GROUP BY value combination.
  Memory per entry: ~100 bytes (key + accumulator state + overhead).

  Total memory: group_count × 100 bytes.

  Examples:
    100 groups (departments):            10 KB → trivial, in-memory.
    10,000 groups (products):             1 MB → in-memory.
    1,000,000 groups (user_ids):        100 MB → needs work_mem = 128MB or will spill.
    43,800,000 groups (session_ids/day): 4.38 GB → will spill with any normal work_mem.

SPILL BEHAVIOR:
  When hash table > work_mem:
  1. Split groups into batches.
  2. Process batch 1 in memory, write partial results to temp disk.
  3. Process batch 2... N.
  4. Merge partial results from temp disk.

  EXPLAIN (ANALYZE):
    HashAggregate  Batches: 1   Peak Memory Usage: 45MB  ← in-memory
    HashAggregate  Batches: 32  Disk Usage: 2456kB       ← spilled to disk
    → Batches > 1: increase work_mem or redesign query (reduce cardinality before grouping).

MONITORING high-cardinality GROUP BY candidates:
  SELECT attname AS column, n_distinct
  FROM pg_stats
  WHERE tablename = 'your_table'
  AND n_distinct > 100000;  -- n_distinct > 100K → GROUP BY will use significant memory
```

### ROLLUP vs Multiple Queries

```sql
-- NEED: summary at three levels: by year, by year+month, by year+month+department.
-- ❌ BAD: Three separate queries (three full scans)
SELECT year, NULL, NULL, SUM(revenue) FROM sales GROUP BY year;
SELECT year, month, NULL, SUM(revenue) FROM sales GROUP BY year, month;
SELECT year, month, dept, SUM(revenue) FROM sales GROUP BY year, month, dept;
-- 3 full scans. 3 separate sort/hash passes. 3x the work.

-- ✅ CORRECT: ROLLUP (one scan, multiple group levels)
SELECT year, month, dept, GROUPING(year, month, dept) AS level, SUM(revenue)
FROM sales
GROUP BY ROLLUP(year, month, dept);
-- One scan. Postgres computes all three aggregation levels in a single pass.
-- Result includes rows for each grouping level.
-- level=0: (year, month, dept) detail.
-- level=6: (year, NULL, NULL) year subtotal.
-- level=7: (NULL, NULL, NULL) grand total.

-- CUBE: all possible combinations of GROUP BY columns.
-- GROUPING SETS: explicit set of grouping combinations.
GROUP BY GROUPING SETS ((year, month, dept), (year, month), (year), ());
-- Equivalent to ROLLUP above but explicit. Use when you don't want all rollup levels.
```

---

## SECTION 7 — Concurrency

### Group Aggregation and MVCC Snapshot Consistency

```
IMAGINE: Billing job running:
  SELECT customer_id, SUM(usage_bytes) AS total_usage
  FROM usage_events
  WHERE billing_period = '2024-03'
  GROUP BY customer_id;

  Concurrently: INSERT INTO usage_events ... (new events arriving every 100ms)

  READ COMMITTED (default):
    Billing job: sees snapshot at query start.
    New events inserted AFTER query start: NOT visible. Good.
    Problem: if billing job takes 10 minutes (huge table), and it restarts mid-way due to error,
    the second run sees a DIFFERENT snapshot with new events.
    Result: first run and second run return different totals → billing inconsistency.

  SAFE APPROACH FOR BILLING: Run in a REPEATABLE READ transaction.
    BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ;
    SELECT customer_id, SUM(usage_bytes)
    FROM usage_events WHERE billing_period = '2024-03' GROUP BY customer_id;
    -- Snapshot: fixed at transaction start. Re-runs within transaction: same result.
    COMMIT;

  ALTERNATIVE: Snapshot-based billing tables.
    At billing period close: COPY all usage for that period to a snapshot table.
    Billing runs against immutable snapshot table. No concurrent writes. No MVCC issues.
```

---

## SECTION 8 — Optimization & Indexing

### Pre-Aggregation with Materialized Views

```sql
-- HOT QUERY: running count of orders by status, refreshed hourly by dashboard.
-- 50M rows × every-30-second refresh = constant heavy aggregation.

-- ✅ SOLUTION: Materialized view with concurrent refresh.
CREATE MATERIALIZED VIEW order_status_counts AS
SELECT status, COUNT(*) AS cnt, SUM(total) AS total_revenue
FROM orders
GROUP BY status;

CREATE UNIQUE INDEX ON order_status_counts(status);  -- required for CONCURRENTLY refresh

-- Refresh without blocking reads:
REFRESH MATERIALIZED VIEW CONCURRENTLY order_status_counts;
-- Runs in background. Old data serves reads during refresh. New view atomically swapped.

-- Dashboard query:
SELECT status, cnt, total_revenue FROM order_status_counts;
-- Result: 5 rows (one per status). Sub-millisecond. Zero aggregation cost.
-- vs: SELECT status, COUNT(*), SUM(total) FROM orders GROUP BY status → 2-30s depending on indexes.

-- INCREMENTAL AGGREGATION (Postgres 15+: not yet native — use triggers or TimescaleDB):
-- For append-only tables, maintain running totals via trigger:
CREATE FUNCTION update_order_summary() RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO order_summary (status, cnt, total_revenue)
  VALUES (NEW.status, 1, NEW.total)
  ON CONFLICT (status) DO UPDATE SET
    cnt = order_summary.cnt + 1,
    total_revenue = order_summary.total_revenue + EXCLUDED.total_revenue;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_order_inserted
AFTER INSERT ON orders
FOR EACH ROW EXECUTE FUNCTION update_order_summary();
-- Aggregation maintained in real-time. Reads always instant. Writes: +1 trigger per INSERT.
```

### Indexes to Support GROUP BY

```sql
-- QUERY:
SELECT customer_id, DATE_TRUNC('day', created_at) AS day, SUM(amount) AS daily_total
FROM orders
WHERE created_at >= '2024-01-01'
GROUP BY customer_id, DATE_TRUNC('day', created_at)
ORDER BY customer_id, day;

-- B-TREE INDEX for GroupAggregate (sort-based aggregation):
CREATE INDEX idx_orders_cust_date ON orders(customer_id, created_at);
-- This index provides rows pre-sorted by (customer_id, created_at).
-- Planner chooses GroupAggregate (streaming aggregation) instead of HashAggregate.
-- StreamingAggregate: processes one group at a time from sorted stream. Zero hash table.
-- Memory: O(group_size) constant, not O(total_groups). Safe for any cardinality.

-- FUNCTIONAL INDEX for expression in GROUP BY:
CREATE INDEX idx_orders_date_trunc ON orders(DATE_TRUNC('day', created_at));
-- With this: GROUP BY DATE_TRUNC('day', created_at) can use index.
-- Without: function evaluated for every row before grouping (non-sargable expression).

EXPLAIN comparison:
  Without index:
    HashAggregate  (cost=...  Batches: 8   Disk Usage: 45678kB)  ← spilled
    -> Seq Scan on orders  Filter: (created_at >= '2024-01-01')

  With idx_orders_cust_date:
    GroupAggregate  (cost=... Batches: 1   Peak Memory: 512kB)   ← streaming, no spill
    -> Index Scan using idx_orders_cust_date on orders
         Index Cond: (created_at >= '2024-01-01')
         -- Rows arrive sorted by (customer_id, created_at) → GroupAggregate can stream.
```
