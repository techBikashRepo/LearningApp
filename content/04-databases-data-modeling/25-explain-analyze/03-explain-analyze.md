# EXPLAIN ANALYZE — Part 3 of 3

### Sections: 9 (AWS Mapping), 10 (Interview Q&A), 11 (Debugging Exercise), 12 (Architect's Mental Model)

**Series:** Databases & Data Modeling → Topic 25

---

## SECTION 9 — AWS Service Mapping

### How AWS Services Support Query Plan Analysis

| Layer             | AWS Service                                    | EXPLAIN ANALYZE Relevance                                                                                                                                                                                                                                |
| ----------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Query Analysis    | Amazon RDS Performance Insights                | Shows top SQL by DB load with execution metrics (average wait events, CPU, I/O). Identifies which queries to run EXPLAIN ANALYZE on. Click-through to see parameterized query with execution stats.                                                      |
| Slow Query Log    | Amazon RDS Enhanced Monitoring                 | `slow_query_log` for MySQL / `log_min_duration_statement` for PostgreSQL. Both capture slow queries automatically. PostgreSQL: auto_explain.log_min_duration captures full EXPLAIN ANALYZE output into logs.                                             |
| Log Analysis      | Amazon CloudWatch Logs Insights                | Query PostgreSQL log groups via SQL-like syntax: `filter @message like "%duration%"                                                                                                                                                                      | stats avg(@duration) by @query`. Identifies slow queries and their frequency. |
| Automated Advisor | AWS RDS Performance Insights + Trusted Advisor | Trusted Advisor flags: missing indexes (inferred from slow queries), underutilized indexes (index exists but not used). Not as precise as EXPLAIN ANALYZE but automated alerting.                                                                        |
| External Tools    | pganalyze (AWS Marketplace)                    | SaaS tool: ingests `pg_stat_statements` + EXPLAIN plans. Auto-EXPLAIN slow queries. Tracks plan changes over time (regression detection). "This query was using Index Scan last week, now Seq Scan" triggers alert.                                      |
| Aurora            | Amazon Aurora Query Plan Management            | Aurora PostgreSQL has Query Plan Management (QPM): captures query plans, lets you pin a plan, prevents plan regressions when statistics change. Production plan stability guarantee without pg_hint_plan.                                                |
| Parameter Tuning  | AWS RDS Parameter Groups                       | Key parameters affecting EXPLAIN plans: `work_mem` (affects Sort Method), `effective_cache_size` (affects planner's cost estimate for disk vs cache), `random_page_cost` (affects index vs seq scan choice). Tuned via Parameter Groups without restart. |

---

**auto_explain on Amazon RDS PostgreSQL:**

```sql
-- In RDS Parameter Group:
-- shared_preload_libraries: auto_explain
-- auto_explain.log_min_duration: 1000   (log plans for queries > 1 second)
-- auto_explain.log_analyze: 1
-- auto_explain.log_buffers: 1
-- auto_explain.log_format: json

-- After applying (requires DB restart for shared_preload_libraries):
-- PostgreSQL now logs full EXPLAIN ANALYZE JSON for every query > 1 second.
-- In CloudWatch Logs Insights, search for slow query plans:
-- fields @timestamp, @message
-- | filter @message like "Query Text"
-- | sort @timestamp desc
-- | limit 20
```

---

**Aurora Query Plan Management:**

```sql
-- Aurora PostgreSQL QPM: pin a known-good plan
-- Step 1: approve current plan:
SELECT apg_plan_mgmt.validate_plans('SELECT * FROM orders WHERE tenant_id=$1',
    apg_plan_mgmt.PLAN_STATUS_APPROVED);

-- Step 2: when statistics change and planner wants a different (worse) plan:
-- QPM enforces the approved plan.
-- Step 3: periodic review: run apg_plan_mgmt.evolve_plan_baselines() to check if
-- newer plans are genuinely better (lower cost) before auto-approving them.
```

---

## SECTION 10 — Interview Q&A

### Beginner Questions

**Q1: What is the difference between EXPLAIN and EXPLAIN ANALYZE?**

`EXPLAIN` shows the query execution _plan_ — what the PostgreSQL planner _estimates_ it will do, based on statistics. It does not execute the query. `EXPLAIN ANALYZE` both plans AND executes the query, then shows both the planner's estimates and the actual execution metrics (actual time, actual rows, actual loops). The difference matters when a query is slow: `EXPLAIN` might show `rows=100` (planner's estimate), but `EXPLAIN ANALYZE` might reveal `actual rows=5,000,000` — showing that stale statistics caused a catastrophically wrong plan. For diagnosing actual performance: always use `EXPLAIN ANALYZE`.

---

**Q2: What does "cost" mean in an EXPLAIN plan?**

Cost is a dimensionless unit the PostgreSQL planner uses to estimate the relative expense of a query plan. It is represented as `cost=startup_cost..total_cost`. `startup_cost` is the estimated cost before the first row can be returned (e.g., for sorting, the entire sort must complete before any rows are emitted). `total_cost` is the estimated cost to return all rows. Cost units roughly correspond to disk page reads, with sequential page reads = 1 unit, random page reads = 4 units (by default), and CPU operations scaled proportionally. Higher cost = planner estimates it's more expensive. The planner chooses the plan with the lowest total cost.

---

**Q3: What is `Rows Removed by Filter` in EXPLAIN ANALYZE and why does it matter?**

`Rows Removed by Filter` shows how many rows were physically read from the table or index but then discarded by a WHERE clause condition. A large number here (e.g., "Rows Removed by Filter: 2,999,950") indicates that the query access path is inefficient — it reads far more data than it needs before filtering. This means either the wrong index is used, there's no suitable index, or the data distribution makes an index ineffective for this predicate. The goal: minimize rows removed by filter. The ideal: zero rows removed (perfect index match) or a low ratio relative to returned rows.

---

### Intermediate Questions

**Q4: Your EXPLAIN ANALYZE shows `actual rows` is 8 million but `rows` (estimate) is 1,200. What is wrong and how do you fix it?**

This is a row count estimation error of 6,667x — a catastrophic mismatch. Root cause: stale statistics. PostgreSQL's planner uses histogram statistics (from `pg_statistic`) to estimate rows. If the table has grown significantly since the last `ANALYZE`, the statistics are stale. Fix: `ANALYZE table_name;` — refreshes statistics from a sample of the table (non-blocking, fast). If the mismatch recurs after ANALYZE: the column has a non-uniform distribution that default statistics can't capture. Fix: `ALTER TABLE t ALTER COLUMN c SET STATISTICS 500; ANALYZE t;` — increases the number of histogram buckets for that column, giving the planner better distribution information for skewed data.

---

**Q5: Explain what `Sort Method: external merge Disk: 28672kB` means and how to fix it.**

This message in EXPLAIN ANALYZE means the sort operation required 28 MB of data but `work_mem` was too small to hold it in memory, so PostgreSQL spilled to temporary disk files. External merge sort is dramatically slower than in-memory sort (disk I/O vs RAM). Fix: increase `work_mem` for the session or globally: `SET work_mem = '64MB'` (session scope) or in `postgresql.conf` for permanent change. Caution: `work_mem` is per sort operation per query. A query with 5 sort nodes and 100 concurrent connections = up to 500 × work_mem of memory. Increase carefully. Alternatively: add an index that pre-orders data in the needed sort column — the planner may choose an Index Scan in sorted order, avoiding the sort entirely.

---

### Advanced Questions

**Q6: How do you use EXPLAIN ANALYZE to diagnose a query that regressed from 80ms to 14,000ms after a routine deployment?**

First: confirm the plan changed between deployments using `pg_stat_statements` (total_exec_time spike on a specific query hash). Then: `EXPLAIN ANALYZE` on the slow query now vs a captured plan from before the incident (from `auto_explain` logs or pganalyze historical plans). Key things to compare: (1) Did the join algorithm change? (Hash Join → Nested Loop = usually regression). (2) Did an Index Scan become a Seq Scan? (index dropped or statistics changed via new data). (3) Did row estimates suddenly change? (data migration added/removed a large batch — statistics not updated). Most common cause of post-deployment regression: a data migration ran that changed table statistics but `ANALYZE` was not run after. Fix: `ANALYZE affected_table` to restore planner accuracy.

---

**Q7: What is `auto_explain` and when do you use it in production?**

`auto_explain` is a PostgreSQL extension that automatically logs the EXPLAIN ANALYZE plan for any query exceeding a threshold duration. In production, you cannot run EXPLAIN ANALYZE manually on queries that are slow only under load or intermittently. `auto_explain` captures plans in real-time into the PostgreSQL log. Configuration: `auto_explain.log_min_duration = 1000` (log queries >1s), `log_analyze = on`, `log_buffers = on`. Use cases: (1) a query is slow only in production (not reproducible in dev); (2) a plan regression happened at 3am during peak load; (3) investigating whether parallel workers are launching correctly under load. In AWS: configure via Parameter Group (requires `auto_explain` in `shared_preload_libraries`). Review logs via CloudWatch Logs Insights for the captured plans.

---

## SECTION 11 — Debugging Exercise

### Production Incident: Dashboard Query Regressed from 0.2s to 140 Seconds

**Scenario:**
The quarterly business review dashboard, which had been loading in 200ms for 6 months, suddenly takes 140 seconds after last night's Q4 batch job which loaded 45M new event records. The batch job ran `INSERT INTO events SELECT * FROM events_stage` — no ANALYZE was triggered.

**Step 1: Capture the slow plan:**

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT
    date_trunc('day', event_date) AS day,
    event_type,
    COUNT(*) AS event_count
FROM events
WHERE event_date >= '2024-10-01' AND event_date < '2025-01-01'
GROUP BY 1, 2
ORDER BY 1, 2;
```

**Step 2: Read the output:**

```
Sort (actual time=139847.3..139851.1 rows=456 loops=1)
  -> HashAggregate (actual time=139832.1..139841.2 rows=456 loops=1)
       -> Seq Scan on events (actual time=0.1..98432.7 rows=183000000 loops=1)
            Filter: ((event_date >= '2024-10-01') AND (event_date < '2025-01-01'))
            Rows Removed by Filter: 62000000    ← 62M rows scanned but discarded
  Buffers: shared read=2847193     ← 22 GB read from disk!
Planning rows=2400 actual rows=183000000   ← 76,250× underestimate ← KEY SIGNAL
```

**Diagnosis:**

- Row estimate: 2,400. Actual: 183,000,000. 76,250× underestimate.
- Cause: statistics showed ~2.4K rows from before the 45M-row batch insert. Statistics are catastrophically stale.
- Planner chose: Seq Scan (thought table was tiny).
- Reality: 245M total rows in events. 183M in Q4 date range.
- With correct stats: planner would choose the index on `event_date`.

**Fix:**

```sql
-- Step 1: Update statistics (non-blocking, takes ~30 seconds on 245M rows):
ANALYZE events;

-- Step 2: Re-run EXPLAIN ANALYZE:
EXPLAIN (ANALYZE, BUFFERS) SELECT ... (same query);
-- Now:
-- Index Scan on idx_events_date (actual time=0.1..742.3 rows=183000000 loops=1)
-- Much better: using index for date range.

-- Wait — still slow. 183M rows with index scan on a date range:
-- The index helps filter, but 183M rows to group and sort is still expensive.
-- Further: check if a summary table pre-aggregates this daily:
-- Add a dashboard_daily_stats table refreshed nightly by the batch job.
-- Query hits 92 rows (3 months × ~30 event types) instead of 183M rows.

-- Prevention: add ANALYZE to the batch job's runbook:
-- After INSERT INTO events SELECT ... FROM events_stage:
-- ANALYZE events;    ← always. non-negotiable after bulk loads.
```

**Permanent fix for batch jobs:**

```sql
-- After every bulk load: run ANALYZE.
-- Or: set autovacuum scale factors lower for this table:
ALTER TABLE events SET (
    autovacuum_analyze_scale_factor = 0.01,  -- analyze after 1% of rows change
    autovacuum_analyze_threshold = 10000     -- or 10K rows changed
);
-- Default: 20% scale factor + 50 rows — way too high for a 245M row table.
-- At 1%: ANALYZE fires after 2.45M rows change. Keeps statistics current after large batch loads.
```

---

## SECTION 12 — Architect's Mental Model

### 5 Decision Rules

1. **EXPLAIN ANALYZE before and after any optimization.** Measure, don't guess. Before adding an index: capture the current plan. After adding the index: capture the new plan. Confirm the index is used, actual time improved, buffer reads reduced. Without before/after: you don't know if your change helped, hurt, or did nothing.

2. **Always read bottom-up. The expensive node is rarely the top row.** The top node is the aggregation of all children. Find the leaf node with the highest `actual_time × loops` product. That is your target. Everything above it is a consequence.

3. **Row estimate vs actual > 10x: run ANALYZE immediately.** A 10x mismatch is the threshold for plan instability. The planner makes join strategy, memory allocation, and parallelism decisions based on row estimates. Wrong estimates = systematically wrong plan choices. `ANALYZE table_name` is non-blocking and fast. Run it.

4. **BUFFERS output is mandatory for I/O diagnosis.** `shared hit` vs `shared read` tells you whether data is in RAM or requires disk. A query with `shared read=2,800,000` (22 GB disk I/O) is fundamentally different from `shared hit=2,800,000` (RAM). You cannot diagnose the difference without BUFFERS.

5. **Use `auto_explain` in production, always.** You cannot run EXPLAIN ANALYZE manually on every slow production query. `auto_explain.log_min_duration = 1000` captures plans automatically. Set it up during application launch, not after the first incident. By the time you need it, it's too late to turn it on (the incident is already over).

---

### 3 Common Mistakes

**Mistake 1: Running EXPLAIN ANALYZE on INSERT/UPDATE/DELETE without wrapping in ROLLBACK.** The statement executes. Data changes. This is a production data integrity risk. Always: `BEGIN; EXPLAIN ANALYZE INSERT/UPDATE/DELETE ...; ROLLBACK;`

**Mistake 2: Trusting the planner's cost estimate over actual execution time.** Cost is an estimate. A low-cost plan can have a long actual execution time if statistics are stale. A higher-cost plan can be faster if it avoids a disk spill. Always: look at `actual time`, not `cost`. Cost is for understanding the planner's decision-making; actual time is reality.

**Mistake 3: Adding an index without verifying EXPLAIN ANALYZE uses it.** Index Created ≠ Index Used. The planner may still choose a Seq Scan if it estimates the index is not selective enough (or statistics are stale). After creating an index: run EXPLAIN ANALYZE on the target query, confirm ` Index Scan using new_index_name` appears in the plan. If not: run `ANALYZE table_name` and check again.

---

### 30-Second Interview Answer

> "EXPLAIN ANALYZE is how I find exactly why a query is slow — it executes the query and returns both the planner's estimates and the actual execution metrics per node. My reading workflow: bottom-up, find the node with the highest actual_time×loops product, check the row estimate vs actual ratio (>10x = stale statistics, run ANALYZE), look at Sort Method (external merge = increase work_mem), check Rows Removed by Filter (high = wrong or missing index). I always add BUFFERS to see if slowness is disk I/O vs computation. For production: `auto_explain.log_min_duration = 1000` captures slow query plans automatically — because the slow query at 3am can't wait for me to manually EXPLAIN it."

---

_End of Databases & Data Modeling Series → Topics 18-25 complete._
