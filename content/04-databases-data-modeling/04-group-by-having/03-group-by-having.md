# GROUP BY & HAVING — Part 3 of 3

### Sections: 9 (AWS Mapping), 10 (Interview Questions), 11 (Debugging Exercise), 12 (Architect's Mental Model)

**Series:** Databases & Data Modeling → Topic 04

---

## SECTION 9 — AWS Service Mapping

### GROUP BY & HAVING Across AWS Data Services

```
RDS / AURORA:
  GROUP BY: standard behavior (hash or sort-based aggregation, described in parts 1-2).

  AURORA PARALLEL QUERY:
    Partial aggregation pushed to the storage layer.
    Each storage node aggregates its own data partition → sends partial aggregates to head node.
    Head node: merges partial aggregates → final result.
    Benefit: instead of transferring 50M raw rows to head node, sends N partial-aggregate rows.
    E.g., GROUP BY region (5 regions): each storage node sends 5 rows → head merges 5×(number-of-nodes) rows.
    Huge reduction in data transfer across the Aurora storage fabric.
    Enable: SET aurora_parallel_query = ON; (Aurora MySQL 5.7+, select Aurora PostgreSQL versions).

  AURORA SERVERLESS v2:
    GROUP BY with high cardinality: large hash table memory → more ACUs auto-scaled.
    Cost: proportional to peak ACU usage × duration.
    Optimization: run GROUP BY on scheduled reports asynchronously. Materialized view refresh at night.
    Avoid running high-cardinality GROUP BY on synchronized dashboard queries (every user load).

REDSHIFT (OLAP):
  GROUP BY: primary workload. Entire architecture optimized for this.

  DISTRIBUTION IMPACT ON GROUP BY:
    GROUP BY customer_id with DISTKEY on customer_id:
      All rows for same customer_id on same compute node → GROUP BY is local, no shuffle.
      Fast. Minimal network.
    GROUP BY customer_id with DISTKEY on order_id (wrong distribution):
      customer_id rows spread across all nodes → aggregation requires cross-node shuffle.
      Each node sends partial results → leader aggregates → slow for large cardinality.
      Fix: ALTER TABLE DISTSTYLE KEY DISTKEY customer_id; (requires full table rebuild).

  MATERIALIZED VIEWS in Redshift:
    Perfect for GROUP BY aggregations consumed repeatedly.
    CREATE MATERIALIZED VIEW monthly_revenue AS SELECT ... GROUP BY ...;
    AUTO REFRESH: automatically refreshed when base tables change.
    Incremental refresh: Redshift only processes changed rows (not full rebuild) for eligible MVs.
    Query rewrite: planner may use MV automatically when matching patterns detected.

DYNAMODB:
  No SQL GROUP BY. Aggregation options:

  1. DynamoDB Streams + Lambda: each item change triggers Lambda → update aggregate counters in a summary table.
      Exactly equivalent to: TRIGGER → UPDATE aggregate_table SET cnt = cnt + 1.
      Real-time aggregation. Complex setup. Exactly-once guarantee with DynamoDB transactions.

  2. DynamoDB → Kinesis Data Stream → Kinesis Data Analytics (SQL on streams):
      GROUP BY event_type WINDOW TUMBLING (60 seconds): rolling 1-minute count per event type.
      Then: UPSERT aggregated results back to DynamoDB or write to S3.

  3. Export to S3 + Athena for ad-hoc GROUP BY:
      DynamoDB Pitr export → Parquet on S3 → Athena GROUP BY. Point-in-time analytics.
      Not real-time. Acceptable for batch reporting.

ATHENA:
  GROUP BY: distributed MapReduce-style.
  Each worker node: partial GroupBy on its data split.
  Shuffle phase: rows with same GROUP BY key sent to same node.
  Final aggregation on each node: merge partial aggregates.

  PARTITION PRUNING + GROUP BY:
    Query: GROUP BY YEAR, MONTH WHERE year = 2024 AND month = 3.
    If table partitioned by (year, month): Athena reads only March 2024 S3 objects.
    Without partition alignment: reads all 5 years of data. 60x more data scanned.

  COST: Athena charges per TB scanned. GROUP BY on non-partitioned huge table = expensive.
    Always: partition by time + use columnar format (Parquet/ORC) for aggregation queries.

OPENSEARCH / ELASTICSEARCH:
  Aggregation framework (not SQL GROUP BY, but equivalent):
    Terms aggregation: equivalent to GROUP BY + COUNT.
    Sum/Avg/Max aggregation: equivalent to SUM/AVG/MAX within groups.
    Date histogram aggregation: GROUP BY DATE_TRUNC('day', timestamp).

  PERFORMANCE: aggregations run on all shards in parallel → results merged.
    High-cardinality GROUP BY (terms aggregation with many unique values): memory intensive.
    Default: returns top 10 groups (size parameter). Returning all unique groups: pagination needed.
    "All unique user_ids": cardinality aggregation (approximate COUNT DISTINCT via HyperLogLog).
```

---

## SECTION 10 — Interview Questions

### Beginner Questions

**Q1: Can you use `WHERE` to filter on the result of an aggregate function? Why or why not?**

> No. WHERE runs before GROUP BY in the logical query processing order.
> Aggregate functions (COUNT, SUM, etc.) produce values that don't exist until AFTER grouping.
> Attempting WHERE COUNT(\*) > 5 is a syntax error or semantic error.
> The correct clause for filtering on aggregate results is HAVING, which runs after GROUP BY.
> Rule: WHERE = filter rows (inputs to GROUP BY), HAVING = filter groups (outputs of GROUP BY).

**Q2: What is the difference between `GROUP BY 1` and `GROUP BY column_name`?**

> `GROUP BY 1` uses positional notation: group by the 1st column in the SELECT list.
> `GROUP BY column_name` uses the explicit name.
> Positional notation: shorter to write. Dangerous: if someone reorders SELECT columns,
> GROUP BY 1 now groups by a different column silently. No error. Incorrect results.
> Best practice: always use column names in GROUP BY. Positional notation: acceptable only
> in interactive/ad-hoc queries, never in production code or stored procedures.

**Q3: What happens when you GROUP BY a nullable column?**

> NULL values form their own group. All rows where the GROUP BY column is NULL are grouped
> together as one group with key NULL. The aggregate (COUNT, SUM, etc.) operates over those rows.
> Example: GROUP BY manager_id — employees with no manager (manager_id IS NULL) form one group.
> This is sometimes expected (group of all orphaned records). Often surprising.
> If NULL group should be excluded: add WHERE col IS NOT NULL before GROUP BY.
> If NULL group should display a label: use COALESCE(manager_id, 0) or similar in GROUP BY.

### Intermediate Questions

**Q4: Explain hash aggregation vs sort-based aggregation. When does the planner choose each?**

> Hash aggregation: builds an in-memory hash table keyed by GROUP BY column(s). Each row
> updates its group's accumulator. O(N) scan, O(distinct_groups) memory. Spills to disk
> if hash table exceeds work_mem.
> Sort-based aggregation (GroupAggregate): requires input sorted by GROUP BY keys. Walks the
> sorted stream, emitting a group when the key changes. O(N log N) sort + O(1) memory per group.
> Good when input is already sorted (via index) or when there are many distinct groups.
> The planner chooses hash aggregation when: high selectivity after filters, no useful index for
> sort order. Planner chooses GroupAggregate when: an index provides pre-sorted order, or
> when hash table would be too large for work_mem.

**Q5: How would you optimize a real-time GROUP BY COUNT query on a 100M-row table that runs every 5 seconds on a dashboard?**

> Running GROUP BY COUNT(\*) on 100M rows every 5 seconds is not viable for OLTP.
> Options in order of increasing sophistication:
>
> 1. Cache result in application (Redis) with 5-second TTL. Reduce aggregation frequency.
> 2. Materialized view: REFRESH CONCURRENTLY every 60 seconds. Dashboard reads the pre-computed MV.
> 3. Trigger-maintained summary table: INSERT/UPDATE/DELETE on the base table → trigger updates
>    a small summary table. Dashboard reads summary table: single row lookup. Zero aggregation cost.
> 4. For exact real-time: incremental aggregation via change data capture (Debezium → Kafka → streaming GROUP BY).
>    The correct answer depends on acceptable staleness. For a dashboard: 5-60 second cache is universally acceptable.

### Advanced Questions

**Q6: A query uses `GROUP BY user_id` on a 500M-row table. Sometimes it's fast, sometimes it causes OOM. What is the root cause and how do you stabilize it?**

> Root cause: the number of distinct user_ids varies with the data in the filter range.
> Hash aggregation memory = distinct_groups × ~100 bytes. When distinct user_ids is high
> (e.g., full historical query), hash table exceeds work_mem → spills to disk.
> When distinct user_ids is small (e.g., filtered to last hour), fits in memory.
> Stabilization strategy: (1) Always filter to bounded time ranges (WHERE created_at > ...).
> (2) Increase work_mem for this query class: SET LOCAL work_mem = '512MB'.
> (3) Create a composite index on (user_id, created_at) so planner chooses GroupAggregate
> (streaming, O(1) memory per group) instead of HashAggregate.
> (4) Pre-aggregate in a summary table and run the report against that instead of raw data.

---

## SECTION 11 — Debugging Exercise

### Scenario: Monthly Invoice Generation Running Out of Disk

```
SYMPTOMS:
  - Monthly billing job runs on the 1st of each month.
  - Job: GROUP BY customer_id on 50M billing events to sum charges.
  - Month 1-6: completed in 4 minutes.
  - Month 7: job fails with: "ERROR: could not write to file pg_tmp_xxx: No space left on device"
  - Disk usage alert: /tmp partition at 100%.
  - Month 6: 43.8M events (same as previous). No data volume change.
  - What changed: DB server was migrated from 64GB RAM to 32GB RAM to reduce costs.

ROOT CAUSE ANALYSIS:

Step 1: Check EXPLAIN for the billing query:
  EXPLAIN (ANALYZE, BUFFERS)
  SELECT customer_id, SUM(amount) FROM billing_events
  WHERE billing_month = '2024-07'
  GROUP BY customer_id;

  OBSERVED:
    HashAggregate  (cost=...) (actual time=480321..480321 rows=43800000 loops=1)
      Batches: 1 → 256   ← key change
      Peak Memory Usage: 29,184kB (should be much larger)
      Disk Usage: 89,234,112kB   ← 89 GB written to temp disk
    -> Seq Scan on billing_events
         Filter: (billing_month = '2024-07')
         Rows Removed by Filter: 0

  Finding: 43.8M distinct customer_ids × 100 bytes = 4.38GB hash table.
  Old server: 64GB RAM → work_mem allocated: 512MB → hash fits in ~9 batches. Some disk.
  New server: 32GB RAM → work_mem: 128MB → 4.38GB / 128MB = 35 batches → 89GB disk spill.
  The /tmp partition: only 80GB. Overflow at batch 35. FAILURE.

Step 2: Confirm the RAM change:
  SELECT pg_size_pretty(setting::bigint * 1024) AS shared_buffers
  FROM pg_settings WHERE name = 'shared_buffers';
  -- Old server: shared_buffers = 16GB. work_mem could be set higher.
  -- New server: shared_buffers = 8GB. Less memory headroom.

RESOLUTION PLAN (3 tiers):

Tier 1 — Immediate fix (restore this month's billing):
  SET work_mem = '512MB';  -- temporarily before this session
  -- OR: set in postgresql.conf and reload for billing user only.
  -- ALTER ROLE billing_user SET work_mem = '512MB';
  Hash table: 4.38GB / 512MB = 9 batches (vs 256). Temp disk: ~9GB instead of 89GB.
  /tmp: handles 9GB easily. Billing completes.

Tier 2 — Structural fix (prevent regression):
  Add index on (customer_id, billing_month) to enable GroupAggregate (streaming):
  CREATE INDEX idx_billing_events_customer_month
  ON billing_events(customer_id, billing_month);

  New plan:
    GroupAggregate  (Sort: customer_id, billing_month)
    -> Index Scan on idx_billing_events_customer_month
         Index Cond: (billing_month = '2024-07')

  Memory: O(1) per group (streaming). Peak memory: ~1MB regardless of cardinality.
  Disk: 0 bytes temp written. Time: similar to hash (trades sort cost for memory cost).

Tier 3 — Architecture fix (billing shouldn't run on primary):
  Route billing job to a dedicated read replica or RDS snapshot.
  Billing runs on replica: no competition with production OLTP.
  RAM on replica can be tuned for analytics workloads (higher work_mem, lower shared_buffers).
```

---

## SECTION 12 — Architect's Mental Model

```
=== Architect's Mental Model: GROUP BY & HAVING ===

DECISION RULE 1: The GROUP BY key cardinality determines memory cost.
  Low cardinality (5 regions, 12 months): hash table is tiny. HashAggregate: always in-memory.
  High cardinality (43M customers): hash table is large. Must either increase work_mem,
  use GroupAggregate with index, or pre-aggregate into a summary table.
  Before writing a GROUP BY query: SELECT COUNT(DISTINCT grouping_col) FROM table.
  If > 1M: plan for memory pressure.

DECISION RULE 2: Move filters to WHERE, not HAVING.
  HAVING filters after aggregating. Any row-level condition that doesn't involve an aggregate
  MUST be in WHERE. WHERE reduces rows entering GROUP BY → small hash table → less memory →
  faster. HAVING is only valid for aggregate conditions: HAVING COUNT(*) > 5.

DECISION RULE 3: Repeated GROUP BY queries belong in a materialized view or summary table.
  A GROUP BY that runs the same computation repeatedly on the same data is waste.
  Materialized view: computed once, read many times. REFRESH CONCURRENTLY: no blocking.
  Summary table with trigger: real-time aggregation. Read is always O(1).
  Rule: if the same GROUP BY runs more than once/minute: materialize it.

DECISION RULE 4: ROLLUP/CUBE/GROUPING SETS for multi-level summaries.
  Three separate GROUP BY queries on the same table = three full scans.
  ROLLUP/CUBE: one scan, multiple aggregation levels. Always use when business needs subtotals.
  Cost: 1 scan + small overhead for multiple group levels. Savings: N-1 full scans eliminated.

DECISION RULE 5: GroupAggregate (streaming) beats HashAggregate at extreme cardinality.
  At 10M+ distinct groups: HashAggregate memory is often impossible to provide.
  GroupAggregate from sorted input: O(1) memory regardless of cardinality.
  Investment: index on GROUP BY columns. Return: predictable memory, no spill, stable performance.

COMMON MISTAKE 1: HAVING instead of WHERE for non-aggregate filters.
  Seen in: auto-generated ORM queries, copied SQL snippets.
  Impact: 10-100x slower for selective filters (aggregates entire table before filtering).
  Detection: any HAVING clause without an aggregate function = HAVING used incorrectly.

COMMON MISTAKE 2: GROUP BY in a hot OLTP query path.
  "Get today's order count" running GROUP BY on orders table every page load.
  10,000 users × 10 page loads/hour × GROUP BY scan = 100,000 scans/hour. Unsustainable.
  Fix: materialized counter with atomic increment on insert. Read from counter, not group query.

COMMON MISTAKE 3: Forgetting NULL groups in GROUP BY.
  Business: "group by account manager." Account manager NULL = "unassigned accounts."
  Without NULL group: unassigned accounts are invisible in the report.
  Product manager sees 0 unassigned accounts. Reality: 2,000 unassigned accounts → support backlog.
  Fix: COALESCE(manager_id, -1) or filter explicitly, or ensure all rows have a non-null key.

30-SECOND INTERVIEW ANSWER (What's the difference between WHERE and HAVING?):
  "WHERE filters rows before they reach the GROUP BY step — it runs first and can use indexes
  to reduce the number of rows that enter aggregation. HAVING filters groups after aggregation —
  it operates on computed aggregate values like COUNT(*) or SUM(total) which don't exist until
  after grouping is complete. The practical implication is performance: if you put a non-aggregate
  condition in HAVING instead of WHERE, you force the database to aggregate ALL rows before
  discarding most of them, which can be 10-100x more expensive than filtering first via WHERE."
```
