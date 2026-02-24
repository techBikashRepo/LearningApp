# GROUP BY & HAVING — Part 1 of 3

### Sections: 1 (Intuition), 2 (Why This Exists), 3 (Internal Working), 4 (Query Execution Flow)

**Series:** Databases & Data Modeling → Topic 04

---

## SECTION 1 — Intuition: The Logistics Operations Room

A freight company's operations manager gets a report every morning: shipments grouped by carrier, showing total weight, count of packages, and average delivery time — but only for carriers who handled more than 500 shipments last month.

Without GROUP BY, you'd pull every single shipment record (50 million rows), load it into a spreadsheet, manually group by carrier, and total each group. GROUP BY is the database doing this grouping work at the storage layer, where 50 million rows can collapse into 12 carrier summary rows — and ship only those 12 rows to your application.

```
THE CRITICAL ARCHITECTURAL INSIGHT:

  Without GROUP BY (wrong approach):
    Application: fetch 50M rows, group in memory, compute totals.
    Network: 50M × ~200 bytes = 10GB transferred.
    Application memory: ~10GB.
    Time: minutes.

  With GROUP BY (correct approach):
    DB: reads 50M rows internally, groups, aggregates.
    Network: 12 carrier rows × ~50 bytes = 600 bytes transferred.
    Application memory: negligible.
    Time: seconds (or milliseconds with proper indexes).

  RULE: Aggregation belongs in the database. The database has the data co-located
  with the compute. Moving 10GB to aggregate in application code is architectural malpractice.

GROUP BY vs HAVING — the correct mental model:

  WHERE:  filters ROWS before grouping ("only include shipments from last month")
  GROUP BY: collapses rows into groups ("one row per carrier")
  HAVING: filters GROUPS after grouping ("only carriers with > 500 shipments")

  A common mistake: using HAVING where WHERE should be used.
  HAVING filters aggregated results — it runs AFTER the group operation.
  WHERE filters raw rows — it runs BEFORE the group operation.
  Always push filters into WHERE if they don't reference aggregate functions.
```

---

## SECTION 2 — Why This Exists: Production Failures

### Failure 1: HAVING Instead of WHERE (Full Table Aggregate)

```sql
-- DEVELOPER'S INTENT: Get active users who joined this year.
-- ❌ WRONG: HAVING on non-aggregate column
SELECT user_id, COUNT(orders.id) as order_count
FROM orders
JOIN users ON orders.user_id = users.id
GROUP BY user_id
HAVING users.created_at > '2026-01-01' AND users.is_active = true;

-- WHAT THE DB DOES:
-- 1. Join ALL orders with ALL users (hundreds of millions of rows).
-- 2. Group ALL of them by user_id.
-- 3. AFTER grouping: filter for created_at and is_active.
-- Aggregates 10M rows, builds huge hash table — then discards 90% in HAVING.

-- ✅ CORRECT: Push non-aggregate predicates to WHERE
SELECT user_id, COUNT(orders.id) as order_count
FROM orders
JOIN users ON orders.user_id = users.id
WHERE users.created_at > '2026-01-01'   -- filter BEFORE grouping
  AND users.is_active = true            -- 10% of users → join only those
GROUP BY user_id;
-- Joins only the 10% of users who match. Group only their orders.
-- 90% reduction in rows processed before aggregation begins.
```

### Failure 2: GROUP BY Causing a Production Outage via Memory Exhaustion

```
INCIDENT: BI dashboard query causing DB OOM crash.
Query: daily sales report grouped by (product_category, region, salesperson, date).
Number of distinct combinations: 5 categories × 12 regions × 2,000 salespeople × 365 days = 43.8M groups.

Hash Aggregation strategy:
  DB builds a hash table: one entry per distinct group combination.
  43.8M entries × ~100 bytes per entry = 4.38GB hash table.
  work_mem: 256MB per sort/hash node.
  Spill to disk: 4.38GB - 256MB = 4.1GB written to temp files.
  Simultaneously: 3 other sessions running the same report.
  Temp disk: 4.1GB × 3 = 12.3GB. Temp disk limit: 10GB.
  DB: "ERROR: could not write to file: disk full."

  CASCADING FAILURE: temp disk used for ALL queries (sorts, hash joins, group bys).
  All queries failing. Site reads: working. Writes involving sorts: failing.

ROOT CAUSE: Dashboard aggregate on too many dimensions, no pre-aggregation.
FIX: Materialized view pre-aggregated nightly. Dashboard reads from 43.8M → 12K rows summary.
```

### Failure 3: The HAVING Clause That Missed Null Groups

```sql
-- INTENT: Find users with more than 3 failed login attempts.
SELECT user_id, COUNT(*) as failure_count
FROM login_attempts
WHERE success = false
GROUP BY user_id
HAVING COUNT(*) > 3;

-- PROBLEM: Users with 0 failures (never had a row in login_attempts) not in result.
-- Fine for this specific query.

-- BUT: "Find users with NO purchases" can't be done with GROUP BY + HAVING alone.
-- GROUP BY only creates groups for rows that EXIST.
-- Users with 0 purchases have no rows in purchases table → no group created → invisible.

-- CORRECT APPROACH: LEFT JOIN + HAVING IS NULL, or NOT EXISTS
SELECT u.id, u.email
FROM users u
LEFT JOIN orders o ON u.id = o.user_id
GROUP BY u.id, u.email
HAVING COUNT(o.id) = 0;  -- groups where no orders exist

-- OR (often more readable and performant):
SELECT id, email FROM users u
WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id);
```

---

## SECTION 3 — Internal Working

### Two Aggregation Strategies: Hash vs Sort-Based

```
HASH AGGREGATION:
  Build a hash table in memory: key = GROUP BY columns, value = running aggregate.
  For each input row: hash(group_key) → find/create bucket → update aggregate.
  After all rows processed: output one row per bucket.

  WHEN USED: when number of distinct groups fits in work_mem.
  ADVANTAGE: single pass through data (O(N)).
  DISADVANTAGE: if groups don't fit in work_mem → spill to disk → expensive.

  IN EXPLAIN:
  HashAggregate (cost=50000..51000 rows=1000 width=16)
    Group Key: user_id
    Batches: 1  Memory Usage: 840kB     ← in-memory (good)

  OR (spilling):
  HashAggregate (cost=50000..51000 rows=1000 width=16)
    Group Key: user_id
    Batches: 8  Disk Usage: 145600kB   ← spilled to disk (investigate)

SORT-BASED (GROUP) AGGREGATION:
  Sort input by GROUP BY columns.
  Scan sorted data: when group key changes, emit previous group's aggregate.

  WHEN USED: when data already sorted (index scan), or when number of groups is large.
  ADVANTAGE: streaming — can start emitting results before seeing all input.
  DISADVANTAGE: requires sort (O(N log N)) unless data already ordered.

  IN EXPLAIN:
  GroupAggregate (cost=45000..55000 rows=1000 width=16)
    Group Key: user_id
    → Sort on user_id
         → Seq Scan on orders

CHOOSING BETWEEN THEM:
  Small number of distinct groups (fits in work_mem): HashAggregate → faster.
  Large number of groups OR index already provides sort order: GroupAggregate → better.
  Planner decides based on estimated cardinality of GROUP BY columns.
  Wrong cardinality estimate → wrong strategy → production slowness.
```

### Partial Aggregation (Parallel Query)

```
POSTGRES PARALLEL QUERY:
  Large table → multiple worker processes scan different table sections.
  Each worker: performs PARTIAL aggregation on its subset.
  Leader: FINALIZE aggregation by combining partial results.

  EXPLAIN with parallel:
  Finalize GroupAggregate (rows=100)
    → Gather (workers=4)
         → Partial GroupAggregate (each worker on its segment)
              → Parallel Seq Scan on orders (workers=4)

  Wall clock time: ~4x speedup for CPU-bound aggregation on large tables.

  CONSTRAINTS:
    max_parallel_workers_per_gather (default 2): increase for analytics queries.
    work_mem: multiplied by worker count. 256MB work_mem × 4 workers = 1GB.
    Plan: parallel_tuple_cost and parallel_setup_cost affect planner decision.
```

---

## SECTION 4 — Query Execution Flow

### Complete Execution with GROUP BY + HAVING

```
QUERY:
  SELECT
    customer_id,
    DATE_TRUNC('month', created_at) AS month,
    COUNT(*) AS order_count,
    SUM(total_amount) AS revenue
  FROM orders
  WHERE created_at >= '2026-01-01'
    AND status != 'CANCELLED'
  GROUP BY customer_id, DATE_TRUNC('month', created_at)
  HAVING SUM(total_amount) > 1000
  ORDER BY revenue DESC
  LIMIT 50;

EXECUTION PLAN WALKTHROUGH:

1. FROM orders:
   Access method chosen: SeqScan or IndexScan based on WHERE selectivity.
   If 2026 orders = 40% of table: likely SeqScan + filter.
   If index on created_at: IndexScan → range scan for >= '2026-01-01'.

2. WHERE filter:
   Apply: created_at >= '2026-01-01' AND status != 'CANCELLED'.
   Note: "!=" predicates don't use standard indexes well (index can't help for != easily).
   Partial index consideration: WHERE status != 'CANCELLED' → common enough to index.

3. GROUP BY customer_id, DATE_TRUNC('month', created_at):
   Note: DATE_TRUNC is a FUNCTION applied to created_at.
   If we want grouping to use an index: better to have a generated column:
   ALTER TABLE orders ADD COLUMN order_month DATE
     GENERATED ALWAYS AS (DATE_TRUNC('month', created_at)) STORED;
   CREATE INDEX idx_orders_customer_month ON orders(customer_id, order_month);
   Then GROUP BY customer_id, order_month → index scan → GroupAggregate (no sort needed).

4. HAVING SUM(total_amount) > 1000:
   Applied AFTER aggregation. Rows eliminated at this stage cost the same as rows kept
   (they were already aggregated). Push everything possible to WHERE.

5. ORDER BY revenue DESC:
   Sorts the post-HAVING result (hopefully small — just the groups that passed HAVING).

6. LIMIT 50:
   Returns first 50 of sorted result. Heapsort used instead of full sort.

TOTAL PIPELINE COST FACTORS:
  (Number of rows after WHERE) × (cost per row to hash/sort into group)
  + (Number of groups) × (HAVING filter cost)
  + (Number of groups passing HAVING) × (ORDER BY sort cost)
  + (50 rows) × (projection and serialization cost)
```
