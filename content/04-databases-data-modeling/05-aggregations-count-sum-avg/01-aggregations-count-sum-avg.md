# Aggregations (COUNT, SUM, AVG) — Part 1 of 3

### Sections: 1 (Intuition), 2 (Why This Exists), 3 (Internal Working), 4 (Query Execution Flow)

**Series:** Databases & Data Modeling → Topic 05

---

## SECTION 1 — Intuition: The Insurance Actuarial Model

An insurance company needs to know: total claims paid last year, average claim size, and number of claims per policy type. An actuary doesn't read every claim file and add them up by hand. She has a ledger that's been totaling values as claims were recorded. The act of aggregation is a function applied to a set of values to produce a single representative scalar.

```
THE ARCHITECT'S FRAME ON AGGREGATION FUNCTIONS:

  COUNT(*):  How many physical rows exist? (includes NULLs)
  COUNT(col): How many rows where col IS NOT NULL? (excludes NULLs)
  COUNT(DISTINCT col): How many unique non-null values? (most expensive: needs deduplication)

  SUM(col):  Total value. Ignores NULLs (doesn't add 0 for NULL rows).
  AVG(col):  Mean. = SUM(col) / COUNT(col). NULLs excluded from both numerator and denominator.

  MIN/MAX:   Extreme values. With index: O(1). Without index: full scan.

  THESE 3 DIFFER IN WAYS THAT CAUSE PRODUCTION BUGS:

  SUM(amount): NULL amounts treated as 0 in the total.
    → If 30% of rows have amount = NULL: SUM returns total of 70% of rows silently.
    → Expect: $1M total. Get: $700K. Difference: $300K of NULL amounts excluded.

  AVG(amount): denominator = COUNT(amount) NOT COUNT(*).
    → AVG = 7,000 / 70 = $100 (only 70 non-null rows counted)
    → But you meant: average across ALL 100 rows = 7,000 / 100 = $70
    → FIX: AVG(COALESCE(amount, 0)) or SUM/COUNT(*) manually

  COUNT(*) vs COUNT(id):
    COUNT(*) = 100 (all rows).
    COUNT(id) = 100 (id is NOT NULL, always same as COUNT(*) for PK column).
    COUNT(amount) = 70 (30 NULLs excluded).

  This NULL behavior is where incorrect financial reports are generated.
  Understanding it is a core production debugging skill.
```

**The architectural decision:** aggregate at the database, not in application code. The database executes aggregation co-located with the data. Network transfer of raw rows to aggregate in application code is the most common performance anti-pattern in data-heavy systems.

---

## SECTION 2 — Why This Exists: Production Failures

### Failure 1: COUNT(\*) vs COUNT(col) Bug in Financial Report

```
INCIDENT: Monthly revenue report showing $2.3M when accounting says $3.1M.

The query:
  SELECT AVG(order_total) as avg_order_value, COUNT(order_total) as order_count
  FROM orders
  WHERE created_at BETWEEN '2026-01-01' AND '2026-01-31';

PROBLEM:
  order_total column is nullable.
  Reason: orders created by "guest checkout" flow don't have a total until payment confirmed.
  In January: 25,000 completed orders + 8,000 pending (order_total = NULL).

  AVG(order_total): averages only 25,000 rows. 8,000 NULL rows excluded from both sum and count.
  COUNT(order_total): returns 25,000 (not 33,000).
  Revenue calculation: 25,000 × $92 avg = $2.3M.
  Correct revenue: 33,000 × $92 avg = $3.04M (pending orders are real, they'll be charged).

  CFO received $770K lower revenue number. SEC filing implications.

ROOT CAUSE: Using COUNT(nullable_col) when COUNT(*) was needed.
FIX: COUNT(*) for total order count regardless of field nullability.
     SUM(COALESCE(order_total, 0)) for revenue including pending.
     Or: separate query filtering only WHERE order_total IS NOT NULL for "realized" revenue.
```

### Failure 2: AVG Masking Skewed Distribution

```sql
-- QUERY: System health check — average API response time.
SELECT AVG(response_ms) FROM api_logs WHERE endpoint = '/checkout' AND date = CURRENT_DATE;

-- RESULT: 210ms — seems acceptable. SLA: 500ms.

-- REALITY:
-- 95th percentile: 1,800ms (users experiencing >1.5 second checkouts)
-- 99th percentile: 8,000ms (1% of users waiting 8 seconds)
-- Distribution: 90% of requests: 50ms. 10% of requests: 1,600ms (DB query timeout retries).
-- AVG = (90% × 50) + (10% × 1,600) = 45 + 160 = 205ms.
-- The average hides the bimodal distribution. 10% of users are suffering.

-- CORRECT APPROACH: Percentiles, not averages.
-- Postgres:
SELECT
  COUNT(*) as total_requests,
  AVG(response_ms) as avg_ms,
  PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY response_ms) AS p50_ms,
  PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY response_ms) AS p95_ms,
  PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY response_ms) AS p99_ms,
  MAX(response_ms) as max_ms
FROM api_logs
WHERE endpoint = '/checkout' AND date = CURRENT_DATE;

-- p95: 1,800ms. p99: 8,000ms. Now the problem is visible.
-- RULE: Never monitor service health with AVG alone. Always add p95/p99.
```

### Failure 3: SUM Overflow and Silent Data Loss

```sql
-- POSTGRES: SUM(integer) returns BIGINT automatically for most cases — safe.
-- MYSQL: SUM(int_column) stays as DECIMAL — usually safe.
-- Application-level accumulation: most dangerous.

-- INCIDENT: Node.js aggregating prices from a loop:
let totalRevenue = 0;
for (const order of tenMillionOrders) {
  totalRevenue += order.total_cents;  // total_cents: integer (cents, not dollars)
}
// total_cents for 10M orders: avg $50 order = 5,000 cents × 10M = 50,000,000,000
// JavaScript MAX_SAFE_INTEGER = 9,007,199,254,740,991 — fine.
// BUT: JavaScript floating point: 0.1 + 0.2 = 0.30000000000000004
// Running sum of floating point decimals: accumulates rounding errors.
// 10M additions: error accumulates to ~$47 off actual value.

// FIX: Always aggregate monetary values in the database, not in application code.
// Database uses fixed-precision NUMERIC/DECIMAL arithmetic.
SELECT SUM(total_cents) FROM orders WHERE ...;  // Exact. No float rounding.

-- For very large values, use NUMERIC type:
ALTER TABLE orders ALTER COLUMN total_cents TYPE NUMERIC(15,0);
-- 15 digits: prevents integer overflow for even largest enterprise totals.
```

---

## SECTION 3 — Internal Working

### How Each Aggregation Function Works Internally

```
COUNT(*):
  Database maintains a counter per group. Increments for every row.
  No column data needed — purely a row counter.
  Optimization: if table has no WHERE and no GROUP BY:
    Postgres reads pg_class.reltuples (estimated row count) for approximate COUNT.
    For exact COUNT(*) of entire table: must scan all pages (MVCC — deleted rows must be excluded).
    Large tables: COUNT(*) is always O(N). Consider: table statistics instead.

COUNT(col):
  Like COUNT(*) but also checks: is this column's value NULL?
  Increments counter only if not NULL.
  Costs slightly more than COUNT(*) per row: null check per row.

SUM(col):
  Maintains an accumulator. Adds each non-NULL value.
  For NUMERIC type: exact arithmetic (slower).
  For FLOAT type: floating-point addition (faster, with rounding error).
  Integer SUM: database automatically promotes to BIGINT to prevent overflow.

AVG(col):
  Internally: tracks running SUM and running COUNT (both non-NULL).
  Returns SUM/COUNT. Does NOT accumulate the average iteratively (avoids rounding drift).
  NUMERIC division: exact.
  Can still misrepresent data if NULLs are excluded inadvertently.

MIN / MAX:
  WITH index: B-tree first/last entry. O(1) — single index page read.
  WITHOUT index: sequential scan comparing every row. O(N).
  Application:
    If you query MIN/MAX frequently: create an index on that column.
    INDEX SCAN for MIN: SELECT min(created_at) FROM orders → reads leftmost B-tree leaf. ~3 I/Os.
    SEQ SCAN alternative: reads every row. For 100M rows: 100M row comparisons.

COUNT(DISTINCT col):
  Most expensive aggregate. Requires deduplication.
  Algorithm: hash all values → count distinct hashes.
  Memory: proportional to number of distinct values.
  For high-cardinality columns (user_id, uuid): can require significant work_mem.

  ALTERNATIVE at scale: HyperLogLog (approximate, uses fixed memory)
  -- Extension: pg_hll or built into Citus/Redshift.
  SELECT hll_cardinality(hll_add_agg(hll_hash_bigint(user_id))) FROM events;
  -- Returns approximate count (±2% error) using kilobytes instead of gigabytes.
  -- Use case: "how many unique users today?" — doesn't need to be exact.
```

### Window Functions: The Aggregation That Doesn't Collapse Rows

```sql
-- NORMAL AGGREGATION: collapses rows into groups.
SELECT customer_id, SUM(amount) FROM orders GROUP BY customer_id;
-- Returns: 1 row per customer. Original rows lost.

-- WINDOW FUNCTION: aggregates without collapsing. Every row remains.
SELECT
  order_id,
  customer_id,
  amount,
  SUM(amount) OVER (PARTITION BY customer_id) AS customer_total,
  amount / SUM(amount) OVER (PARTITION BY customer_id) AS pct_of_customer_total,
  ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY amount DESC) AS rank_in_customer
FROM orders;
-- Returns: every order row, PLUS per-customer total, percentage, and rank columns.
-- Enables: "show each order as a % of that customer's total spend" — impossible with GROUP BY alone.

-- WINDOW FUNCTION PERFORMANCE:
-- Postgres: must sort data by PARTITION BY + ORDER BY columns for each window.
-- Each OVER() clause with different PARTITION/ORDER: separate sort pass.
-- Multiple OVER() clauses: expensive if not using same partition key.

-- OPTIMIZATION: use same OVER() specification for multiple functions:
SELECT
  order_id,
  SUM(amount)   OVER w AS total,
  COUNT(*)      OVER w AS count,
  AVG(amount)   OVER w AS avg
FROM orders
WINDOW w AS (PARTITION BY customer_id ORDER BY created_at);
-- 'w' defined once, reused. Single sort pass for all three functions.
```

---

## SECTION 4 — Query Execution Flow

### Aggregate Pushdown and Filter Interaction

```
QUERY:
  SELECT
    status,
    COUNT(*) AS order_count,
    SUM(total_amount) AS revenue,
    AVG(total_amount) AS avg_order
  FROM orders
  WHERE created_at >= '2026-01-01'
  GROUP BY status;

EXECUTION FLOW:

1. STORAGE ACCESS:
   WHERE created_at >= '2026-01-01':
   →  If index on created_at: index range scan → fetch matching heap rows (40% of table).
   → If no index: sequential scan with filter (reads 100% of table, applies filter per row).

   IMPORTANT: aggregate functions themselves can't push down to storage in standard Postgres.
   Exception: columnar storage extensions (Citus, TimescaleDB): can read only 'status' and
   'total_amount' columns, skip others entirely (column pruning).

2. AGGREGATION:
   HashAggregate (small number of distinct statuses: 5-6):
   Hash table: {
     'PENDING':   {count: 12000, sum: 480000, n_for_avg: 12000},
     'SHIPPED':   {count: 89000, sum: 4450000, n_for_avg: 89000},
     'DELIVERED': {count: 450000, sum: 22500000, n_for_avg: 450000},
     ...
   }
   One pass through filtered rows: O(N) where N = rows from WHERE filter.
   Final AVG: sum/n_for_avg computed at output phase.

3. PROJECTION:
   For each hash bucket: emit (status, count, sum, sum/n_for_avg).
   5-6 rows total. Trivial.

CRITICAL OPTIMIZATION — filtering on GROUP BY column:
  SELECT status, COUNT(*) FROM orders GROUP BY status:
  6 distinct statuses → tiny hash table (fits in L1 cache virtually).

  SELECT product_id, COUNT(*) FROM orders GROUP BY product_id:
  500,000 distinct product_ids → hash table: 500K × ~50 bytes = 25MB.
  If work_mem < 25MB: spills to disk. Significant I/O.

  The number of distinct values in GROUP BY columns determines memory pressure.
  Always check: SELECT COUNT(DISTINCT grouping_column) FROM table — know your cardinality.
```
