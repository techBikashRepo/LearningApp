# Aggregations (COUNT, SUM, AVG) — Part 3 of 3

### Sections: 9 (AWS Mapping), 10 (Interview Questions), 11 (Debugging Exercise), 12 (Architect's Mental Model)

**Series:** Databases & Data Modeling → Topic 05

---

## SECTION 9 — AWS Service Mapping

### Aggregations Across AWS Data Services

```
RDS / AURORA:
  COUNT, SUM, AVG: standard Postgres/MySQL behavior.

  AURORA PARALLEL QUERY for aggregations:
    Partial aggregates computed at storage layer per storage node.
    COUNT(*): each node counts → head node sums the partial counts.
    SUM(amount): each node sums → head node sums partial sums.
    AVG: cannot be partially computed as just average — needs (SUM, COUNT) partial state.
      Each node sends (partial_sum, partial_count) → head: final_avg = total_sum / total_count.
    COUNT(DISTINCT): expensive even with parallel query (deduplication cannot be trivially partitioned).

  RDS Performance Insights:
    Identify: aggregate functions consuming most DB time.
    Dashboard: top SQL by "active sessions." Aggregate queries: often appear as CPU-bound waits.
    Action: if same aggregation appears repeatedly → materialize it.

DYNAMODB:
  No native aggregation functions. Options:

  1. Lambda → Scan → Python aggregate (for small tables < 100K items):
     def get_total_orders():
         response = table.scan(FilterExpression=Attr('status').eq('COMPLETED'))
         return sum(item['total'] for item in response['Items'])
     -- Simple but reads ALL items. RCU proportional to table size. Never for large tables.

  2. Atomic counters for COUNT/SUM:
     table.update_item(
       Key={'pk': 'STATS'},
       UpdateExpression='ADD total_orders :inc, total_revenue :amount',
       ExpressionAttributeValues={':inc': 1, ':amount': Decimal('49.99')}
     )
     -- Atomic. O(1). Real-time. Read by GET item 'STATS'. Perfect for COUNT and SUM.
     -- AVG: maintain (total_sum, count) separately. Compute avg at read time.

  3. DynamoDB Streams → Lambda → CloudWatch Metric / Aurora aggregate table:
     Every write event triggers Lambda → update aggregate.
     Near-real-time (< 500ms lag). Decoupled from primary table.

  4. S3 Export + Athena for historical aggregates:
     DynamoDB PITR export → S3 Parquet → Athena SELECT COUNT(*), SUM(total).
     Best for: daily/weekly reporting, not real-time.

REDSHIFT:
  Aggregations: primary use case. Columnar storage = columnar scan for SUM/COUNT.

  APPROXIMATE AGGREGATION:
    APPROXIMATE COUNT(DISTINCT user_id): uses HyperLogLog.
    Error: ±2%. 100x faster than exact COUNT(DISTINCT) for large cardinalities.
    Use for: dashboards showing "~1.5M active users." NOT for billing.

  WINDOW FUNCTIONS IN REDSHIFT:
    Computed in parallel across slices.
    PARTITION BY: if partition key aligns with distribution key — computed locally per slice.
    PARTITION BY: if different from distribution key — requires cross-node shuffle (slower).
    Design: DISTKEY on the column used most in WINDOW PARTITION BY.

  EARLY AGGREGATION (predicate pushdown):
    SELECT region, SUM(revenue) FROM sales WHERE year = 2024 GROUP BY region;
    Redshift: prunes blocks outside year = 2024 (SORTKEY zone maps).
    Only scans 2024 data → aggregates a fraction of total data.
    Sorting by SORTKEY = early aggregation by reducing input.

KINESIS DATA ANALYTICS / FLINK:
  Streaming aggregations: COUNT, SUM, AVG over time windows.

  TUMBLING WINDOW: fixed non-overlapping windows.
    SELECT event_type, COUNT(*) FROM events
    GROUP BY TUMBLING(INTERVAL '1' MINUTE), event_type;
    Returns: one row per (event_type, 1-minute window) every minute.

  SLIDING WINDOW: overlapping windows.
    SELECT user_id, SUM(purchases) FROM events
    GROUP BY SLIDING(INTERVAL '5' MINUTE, INTERVAL '1' MINUTE), user_id;
    Returns: running 5-minute sum, updated every 1 minute.

  LATENCY: sub-second to second-level aggregates. vs Redshift: minutes.
  Use Kinesis/Flink for: real-time fraud detection (AVG spend in last 60s), live dashboards.
  Use Redshift for: historical reporting, complex multi-join aggregations.

CLOUDWATCH METRICS:
  PutMetricData: AWS-managed aggregation for time-series metrics.
  SUM, AVG, COUNT, MAX, MIN: all built-in statistics on metric dimensions.
  Resolution: 1-second to 1-minute granularity.
  Retention: 15 months.
  Use when: aggregating operational metrics (latency, error rate, business KPIs).
  Cost: $0.30/metric/month. Cheaper than running DB aggregation queries for ops metrics.
```

---

## SECTION 10 — Interview Questions

### Beginner Questions

**Q1: What is the difference between `COUNT(*)`, `COUNT(col)`, and `COUNT(DISTINCT col)`?**

> COUNT(_) counts every row in the group including rows with NULL values in any column.
> COUNT(col) counts non-NULL values of that specific column; rows where col IS NULL are excluded.
> COUNT(DISTINCT col) counts unique non-NULL values; duplicates are counted once.
> The key insight: COUNT(_) and COUNT(col) return different results if col has NULLs.
> This difference has caused production billing errors when developers used COUNT(nullable_col)
> thinking it counted total records, but it silently excluded NULL-value rows.

**Q2: Why does `AVG()` sometimes return misleading results for performance metrics?**

> AVG is a single-point summary that hides the distribution of values.
> A bimodal distribution (90% of values at 50ms, 10% at 5,000ms) produces an average of ~545ms —
> which looks "mildly elevated" but doesn't reveal that 10% of users experience 5-second latency.
> For performance metrics, always use percentiles: p50 (median), p95, p99.
> p50=50ms and p99=5,000ms signals "most users are fast, but 1 in 100 is catastrophically slow."
> In Postgres: PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY latency_ms).

**Q3: Why should monetary amounts be stored as `NUMERIC` or integer cents, never as `FLOAT`?**

> IEEE 754 floating-point cannot represent most decimal fractions exactly.
> 0.1 in binary float is: 0.100000000000000005551115... (tiny error).
> SUM(float_price) over millions of rows accumulates these tiny errors into visible drift.
> At 10M transactions: SUM may be off by $47 from the true total.
> NUMERIC: arbitrary-precision exact decimal arithmetic. No rounding error at any scale.
> Integer cents: e.g., $49.99 stored as integer 4999. Pure integer arithmetic. Exact and fast.

### Intermediate Questions

**Q4: Explain the performance difference between `COUNT(DISTINCT user_id)` and an approximate equivalent. When would you use each?**

> COUNT(DISTINCT user_id) is exact: scans all rows, builds a hash set or sorts to deduplicate,
> counts unique entries. Cost: O(N) scan + O(N) memory or O(N log N) sort. For 50M rows with
> 5M distinct users: builds 5M-entry hash set (~40MB) while scanning 50M rows.
>
> Approximate via HyperLogLog: scans rows once, hashes each user_id, updates a 1KB probabilistic
> data structure. Error: ±2%. Cost: O(N) scan, O(1) memory.
>
> Use exact: billing, compliance, any count where a $0.01 difference has consequences.
> Use approximate: dashboards showing "~5M daily active users," analytics where ±2% is acceptable.
> In Postgres: pg_hll extension. In Redshift: APPROXIMATE COUNT(DISTINCT). In Athena: approx_distinct().

**Q5: What is a window function and when should you use it instead of a subquery?**

> A window function computes an aggregate over a set of rows related to the current row, WITHOUT
> collapsing rows into groups. The full row plus the aggregate value is returned per row.
> Example: `SUM(total) OVER (PARTITION BY customer_id)` adds the customer's lifetime total to
> every order row, while keeping all order rows intact (unlike GROUP BY which collapses to 1 row/group).
>
> Use window functions instead of correlated subqueries whenever you need "aggregate + row detail"
> together. A correlated subquery for each of N rows = N+1 queries. A window function = 1 scan.
> At 100K orders: window function 10x-100x faster than correlated subqueries for the same result.

### Advanced Questions

**Q6: A financial reporting query computes `SUM(amount)` on 200M rows partitioned across 8 Redshift nodes. How does Redshift execute this efficiently, and what schema design minimizes execution time?**

> Redshift distributes rows across slices (compute node partitions) based on DISTKEY.
> For `SUM(amount) WHERE date_range...`: execution proceeds in two phases.
> Phase 1 (local): each slice sums its local rows matching the filter → produces (partial_sum, partial_count).
> Phase 2 (global merge): leader node receives one aggregate row per slice (8 rows) → final SUM.
>
> Optimization: set SORTKEY on the date column. Zone maps (min/max per 1MB block) allow skipping
> blocks outside the date range. Only relevant blocks are scanned — I/O reduced proportionally.
> DISTKEY choice for SUM: any EVEN distribution is optimal (workload balanced across slices).
> If DISTKEY is skewed (one value has 80% of rows): one slice handles 80% of I/O — bottleneck.
> Run `SELECT SLICE, COUNT(*) FROM stv_blocklist WHERE tbl = $table_id GROUP BY SLICE` to check
> distribution evenness. Skew > 10%: reconsider DISTKEY.

---

## SECTION 11 — Debugging Exercise

### Scenario: Revenue Report Showing Different Totals Each Run

```
SYMPTOMS:
  - Finance team reports: monthly revenue summary showing different totals each time they refresh.
  - Query result variance: ±$3,000-15,000 per run on $2M monthly total.
  - The variance: random, not consistently higher or lower.
  - Data ingestion: continuous (orders arrive all month until billing close).
  - Query runs on primary read/write database.

QUERY:
  SELECT
    DATE_TRUNC('day', created_at) AS day,
    SUM(total) AS daily_revenue,
    COUNT(*) AS order_count,
    AVG(total) AS avg_order_value
  FROM orders
  WHERE EXTRACT(MONTH FROM created_at) = $1
    AND EXTRACT(YEAR FROM created_at)  = $2
  GROUP BY 1
  ORDER BY 1;

INVESTIGATION:

Step 1: Check query for non-deterministic behavior.
  The query itself is deterministic given fixed data.
  But: it runs under READ COMMITTED isolation (default).
  During query execution (takes 8 minutes on large table), new orders are being inserted.
  At READ COMMITTED: each row fetch sees data committed at time of THAT FETCH, not query start.
  (Postgres note: Postgres READ COMMITTED snapshot is per-statement, not per-fetch.
   A 8-minute statement sees a single snapshot in Postgres — but if the job runs the query twice,
   or if there's a cursor with re-execution, snapshots differ.)

  Real variance cause: the finance team is hitting "Run" multiple times as data arrives.
  Each run: different snapshot. Run at 2pm vs 4pm: 2pm doesn't include 3pm orders. Different total.

  Additionally: EXTRACT(MONTH FROM created_at) is non-sargable.
  Full table scan (not using index on created_at) → query takes 8 minutes.
  In those 8 minutes: new orders in the month are committed → next run differs.

Step 2: Fix sargability.
  REPLACE:
    EXTRACT(MONTH FROM created_at) = $month AND EXTRACT(YEAR FROM created_at) = $year
  WITH:
    created_at >= DATE_TRUNC('month', MAKE_DATE($year, $month, 1))
    AND created_at < DATE_TRUNC('month', MAKE_DATE($year, $month, 1) + INTERVAL '1 month')

  Now: index on created_at used. Query time: 8 minutes → 45 seconds.
  Shorter window of new data arriving = smaller variance between runs.

Step 3: Fix data consistency.
  Use billing_close_at timestamp to freeze data:
    Option A: Add WHERE created_at <= $billing_close_time (immutable cutoff).
    Option B: Create billing snapshot table on billing close date.
    Option C: Run in REPEATABLE READ transaction:

    BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ;
    SELECT DATE_TRUNC('day', created_at) AS day,
           SUM(total), COUNT(*), AVG(total)
    FROM orders
    WHERE created_at >= $month_start AND created_at < $month_end
    GROUP BY 1 ORDER BY 1;
    COMMIT;

    REPEATABLE READ: snapshot fixed at transaction start.
    Multiple runs within same transaction: same snapshot. Same result. No variance.

    NOTE: Run as two separate transactions at two different times → still different results
    (different snapshots). For truly immutable reports: snapshot table is the only guarantee.

FINAL ARCHITECTURE:
  On billing close (1st of next month, midnight):
    INSERT INTO monthly_revenue_snapshots
    SELECT $billing_month, DATE_TRUNC('day', created_at), SUM(total), COUNT(*), AVG(total)
    FROM orders WHERE created_at >= $month_start AND created_at < $month_end GROUP BY 1, 2;
    -- This snapshot: immutable. Finance queries monthly_revenue_snapshots. Always same answer.
    -- Subsequent analysis, restatements: insert corrected_monthly_revenue_snapshots row.
```

---

## SECTION 12 — Architect's Mental Model

```
=== Architect's Mental Model: Aggregations (COUNT, SUM, AVG) ===

DECISION RULE 1: Know your aggregate's NULL semantics before using it in production.
  COUNT(*) = all rows. COUNT(col) = non-NULL rows only. AVG(col) = SUM(col)/COUNT(col).
  Every aggregate that touches a nullable column: verify NULL behavior matches intent.
  Gold standard: add explicit COALESCE at aggregation boundary for all financial/billing queries.
  One unhandled NULL in a revenue aggregate can mean millions in undetected variance.

DECISION RULE 2: AVG is for insight, percentiles are for SLA management.
  AVG hides distribution. If you care about user experience, you care about p95 and p99.
  "Our average latency is 200ms" ≠ "200ms experience for 99% of users."
  Rule: any SLA, SLO, or user-facing performance metric: always include p95 and p99.
  Use PERCENTILE_CONT / PERCENTILE_DISC. For large tables: use approximate (t-digest extension).

DECISION RULE 3: Monetary values always use NUMERIC or integer arithmetic.
  FLOAT: fast, but introduces cumulative rounding error.
  NUMERIC: exact, ~3x slower. Acceptable for financial data.
  Integer cents: exact, fastest. Divide only at display layer (format as currency string).
  Never aggregate financial values in application code using float variables.
  All financial aggregation happens IN the database where exact types are enforced.

DECISION RULE 4: COUNT(DISTINCT high_cardinality_column) is expensive — plan for it.
  On large tables (>10M rows), COUNT(DISTINCT) requires full scan + deduplication.
  For dashboards: use HyperLogLog approximation if ±2% acceptable (it almost always is for DAU/MAU).
  For billing: use pre-counted summary tables maintained by triggers or CDC.
  Avoid: running COUNT(DISTINCT user_id) on 500M rows in a dashboard widget called 100/second.

DECISION RULE 5: Window functions replace correlated subqueries — always.
  Correlated subquery per row = N+1 query executions.
  Window function = 1 scan with O(N) aggregate computation.
  Any query shape "for each row, compute an aggregate over related rows": use window function.
  Exceptions: EXISTS check (exists() is efficient), scalar subquery on PK (single indexed lookup).

COMMON MISTAKE 1: Trusting AVG for sampling/monitoring.
  P99 alert: never fires because AVG is fine. 1% of users experience catastrophic slowness.
  By the time AVG rises above threshold: 50%+ of users are affected. Too late.
  Add p95/p99 column to every table storing latency, duration, or time measurements.
  Use histogram_quantile() (Prometheus), PERCENTILE_CONT (Postgres), or approximate t-digest.

COMMON MISTAKE 2: Running ad-hoc aggregates on the primary write database.
  Monthly revenue report on production primary: 8-minute query, full table scan.
  Locks: none (reads don't block), but: CPU and I/O consumed → OLTP latency increase.
  autovacuum: postponed during heavy read I/O. Bloat accumulates. Cascade: more performance issues.
  Fix: read replicas for reports. Redshift/Athena for historical analytics. Always.

COMMON MISTAKE 3: COUNT(*) to check existence (should use EXISTS).
  IF (SELECT COUNT(*) FROM orders WHERE user_id = $1) > 0: THEN ...
  Count scans ALL matching rows to produce the count, then the application checks > 0.
  Fix: IF EXISTS (SELECT 1 FROM orders WHERE user_id = $1): THEN ...
  EXISTS: stops at first matching row. O(1) vs O(k) where k = matching rows.
  For a user with 50,000 orders: EXISTS finds first order instantly. COUNT scans all 50,000.

30-SECOND INTERVIEW ANSWER (What's the difference between COUNT(*) and COUNT(col)?):
  "COUNT star counts every row in the group, including rows where any specific column is NULL.
  COUNT of a column counts only the non-NULL values of that column — if a row has NULL in that
  column, it's excluded from the count. This is a common bug: when you intend to count all records
  but use COUNT of a nullable column, records with NULL values are silently dropped from the count.
  The practical rule: use COUNT star to count rows, use COUNT of a column when you specifically
  want to count 'how many rows have a non-null value in this column.' Always test with NULL data
  in your development environment to verify your aggregation returns what you actually expect."
```
