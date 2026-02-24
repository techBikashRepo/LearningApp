# Indexing — Why Queries Are Slow — Part 3 of 3

### Sections: 9 (AWS Service Mapping), 10 (Interview Q&A), 11 (Debugging Exercise), 12 (Architect's Mental Model)

**Series:** Databases & Data Modeling → Topic 11

---

## SECTION 9 — AWS Service Mapping

### Indexing Across AWS Database Services

```
RDS PostgreSQL / Aurora PostgreSQL:

  All PostgreSQL index types: B-tree, GIN, GiST, BRIN, Hash — fully supported.
  CREATE INDEX CONCURRENTLY: supported (same semantics as open-source PG).

  Aurora-specific:
    Aurora PostgreSQL: distributed storage. Index pages stored on Aurora storage layer.
    Index creation performance: similar to RDS. Large indexes (100GB+) take same elapsed time.
    Aurora I/O optimization: Aurora's write path for index pages goes through Aurora storage,
    not local NVMe. For WRITE-heavy workloads: Aurora storage API latency adds ~1ms overhead
    vs local NVMe. For READ-heavy (index lookups): shared_buffers cache mitigates (same as PG).

    Performance Insights (RDS/Aurora feature): shows top SQL wait events, top SQL queries,
    top database users. Directly surfaces slow queries. Replaces part of pg_stat_statements.
    Use: RDS Console → Performance Insights → "Top SQL" → order by db load. Click query →
    see execution plan, call count, average latency. Faster than manual pg_stat_statements.

  Enhanced Monitoring: OS-level metrics (CPU, I/O wait, memory). Useful to detect:
    High io_await: index reads going to disk (shared_buffers too small, need cache tuning).
    High CPU during index build: normal. Temporary. Parallelize if too long.

  Automatic recommendations (RDS Recommendations / DevOps Guru for RDS):
    AWS machine learning: analyzes query patterns, suggests missing indexes.
    Not always accurate. Use as a starting point, validate with EXPLAIN ANALYZE.

RDS MySQL / Aurora MySQL:

  MySQL index types: B-tree (InnoDB), FULLTEXT (InnoDB 5.6+), SPATIAL.
  No GIN, GiST, BRIN (PostgreSQL-specific).

  InnoDB B-tree specific behaviors vs PostgreSQL:
    Clustered index: InnoDB stores actual row data in the PK B-tree (clustered).
      Secondary indexes: store PK value + secondary key. Lookup = secondary index descent + PK descent.
      PostgreSQL: heap table (unclustered). Secondary index stores item pointer (ctid) to heap.
      Impact: InnoDB secondary index: 2 B-tree traversals per point lookup (secondary + clustered PK).
              PostgreSQL secondary index: 1 B-tree traversal + 1 heap page read. Similar total I/O.

    UUID as InnoDB Primary Key: extremely bad for performance.
      Random UUIDs → random page splits on the clustered index → extreme write amplification.
      Entire row data must be moved on every split (clustered storage).
      PostgreSQL UUIDs on secondary index: heap is separate, split only affects index pages.
      MySQL InnoDB: ALWAYS use sequential PKs (BIGINT AUTO_INCREMENT) or UUIDv7.

    EXPLAIN in MySQL: similar to PostgreSQL EXPLAIN. "rows" column = estimated, not actual.
    Use EXPLAIN ANALYZE (MySQL 8.0.18+) for actual row counts. Critical for diagnosis.

DynamoDB:

  DynamoDB "indexes" are not B-trees. They are eventually-consistent secondary tables.

  Global Secondary Index (GSI):
    Full secondary query capability on any attribute.
    Can have different partition key and sort key from main table.
    Separate throughput allocation (RCUs/WCUs consumed separately from main table).
    Consistency: eventually consistent ONLY. Up to seconds behind main table.
    Use for: different query access patterns (query by email, query by status+date).

  Local Secondary Index (LSI):
    Same partition key as main table, different sort key.
    Must be created at table creation time (cannot add later — critical limitation).
    Shares throughput with main table.
    Consistency: can be strongly consistent (unlike GSI).
    Use for: different sort order on same partition.

  DynamoDB vs PostgreSQL Index comparison:
    PostgreSQL: covering index in seconds CONCURRENTLY with no schema change.
    DynamoDB GSI: created via AWS API, may take hours to backfill on large tables.
    DynamoDB: no functional indexes, no partial indexes, no GIN/GiST equivalents.
    Pattern: design DynamoDB access patterns at schema design time. Not "add index when slow."

Redshift:

  Redshift: columnar store. B-tree indexes do not exist.

  Sort Keys: defines physical row order on disk (like CLUSTER in PostgreSQL).
    COMPOUND sort key: ideal for queries that filter/sort on all leading columns.
    INTERLEAVED sort key: balanced performance across multiple query patterns. Higher vacuum cost.
    Choosing sort key: use the column most frequently in WHERE and ORDER BY.

  Distribution Keys: how rows are spread across Redshift nodes (slices).
    EVEN: round-robin. Good for tables with no common join key.
    KEY: same key goes to same node. Eliminates network shuffle for co-located joins.
    ALL: full copy on every node. Good for small dimension tables.

  Redshift query tuning: no EXPLAIN ANALYZE equivalent. Use EXPLAIN or STL_EXPLAIN table.
  SELECT * FROM SVL_QUERY_SUMMARY where query = <query_id> — shows actual execution metrics.
  Missing index equivalent: wrong distribution key → massive DS_BCAST_INNER (broadcast) in plan.
  Fix: change distribution key or add DIST KEY to match join pattern.
```

---

## SECTION 10 — Interview Questions & Answers

### Beginner Level

**Q1: Why does a query slow down as a table grows, even if the query itself hasn't changed?**

Without an index, the database performs a sequential scan — reading every row from disk to find matches. As the table grows from 100K to 100M rows, the scan reads 1,000x more pages. A query that ran in 50ms at 100K rows may take 50 seconds at 100M rows because the I/O cost scales linearly with the number of rows.

An index prevents this by providing a pre-sorted data structure that the database can traverse in O(log N) time regardless of table size. Going from 1M to 1B rows increases a B-tree to one extra level — roughly 1.5x slower, not 1,000x. The index height grows with the logarithm of the table size, so queries remain fast even at massive scale. When data grows but queries slow down: the first diagnostic step is to check for missing indexes with `EXPLAIN ANALYZE`.

---

**Q2: What is a sequential scan, and when should the database use one?**

A sequential scan reads every page of the table from start to finish, examining every row. It doesn't use any index. This sounds bad, but it's the right choice in several situations:

1. **Small tables**: a 1,000-row table fits in 2-3 disk pages. A B-tree lookup adds overhead that exceeds the cost of reading 3 pages sequentially. The planner prefers SeqScan.
2. **High-selectivity queries**: `WHERE status = 'ACTIVE'` on a table where 80% of rows are active pulls 80% of the table regardless. An index-then-heap-fetch costs MORE than a sequential scan in this case.
3. **No relevant index exists**: forced sequential scan.

The planner calculates the estimated cost of both plans. If the estimated cost of an Index Scan (based on n_distinct, correlation, and cost constants) exceeds the sequential scan cost, it correctly chooses SeqScan. You should trust this decision for small tables and high-selectivity predicates.

---

**Q3: What is `EXPLAIN ANALYZE` and what should you look for in its output?**

`EXPLAIN ANALYZE` shows the query execution plan AND runs the query to collect actual runtime statistics. Use it to diagnose slow queries.

Key things to look for:

- **Seq Scan on a large table**: signals a missing index for that table's filter column.
- **"rows=1" estimated vs "actual rows=10000"**: stale statistics. Run `ANALYZE table_name` to fix.
- **Sort node**: an `ORDER BY` not satisfied by an index. May spill to disk with `Sort Method: external merge Disk: XXXkB`. Fix: add an index covering the ORDER BY column.
- **"Buffers: shared hit=... read=..."**: `read` means disk I/O. High `read` relative to `hit` means the working set doesn't fit in `shared_buffers` (cache miss). May need memory tuning or index optimization.
- **Nested Loop with high iterations**: watch for O(N×M) plans on large joins. May need a better join index.

---

### Intermediate Level

**Q4: What's the difference between a Bitmap Index Scan and a regular Index Scan?**

A regular **Index Scan** descends the B-tree and fetches heap rows one by one as it finds matching index entries. Each heap fetch is a random I/O. Best for high-selectivity queries returning very few rows (< ~0.5% of table).

A **Bitmap Index Scan** descends the B-tree and builds a bitmap of which heap pages contain matching rows — then sorts those page locations and fetches them sequentially. This converts random I/O into sequential I/O. Best for medium-selectivity queries (0.1%–20% of table). More efficient than repeated random heap fetches, but less efficient than Index Scan for very selective queries.

Additionally, multiple Bitmap Index Scans can be combined with `BitmapAnd` and `BitmapOr` operations — allowing the planner to use two separate indexes simultaneously and merge the results. This is why separate single-column indexes can work together for multi-column filters, though a composite index is usually more efficient.

---

**Q5: How do you identify which queries in production are causing index problems?**

Use `pg_stat_statements` combined with `EXPLAIN ANALYZE`:

```sql
-- Step 1: Find slow queries
SELECT query, calls, mean_exec_time, total_exec_time
FROM pg_stat_statements
WHERE mean_exec_time > 50  -- > 50ms average
ORDER BY total_exec_time DESC
LIMIT 20;

-- Step 2: For each slow query, run EXPLAIN ANALYZE with BUFFERS
EXPLAIN (ANALYZE, BUFFERS) <slow query text>;

-- Step 3: Find tables with high sequential scan rates
SELECT relname, seq_scan, idx_scan,
       seq_scan * 100.0 / NULLIF(seq_scan + idx_scan, 0) AS pct_seq
FROM pg_stat_user_tables
ORDER BY pct_seq DESC;
```

Tables with >50% sequential scans on large tables with >1M rows are strong candidates for missing indexes. Combine with `auto_explain.log_min_duration` to capture execution plans for slow queries automatically in the log files.

---

### Advanced Level

**Q6: Explain how stale statistics cause the planner to choose the wrong query plan, and how to fix it.**

PostgreSQL's query planner estimates the cost of each execution plan using statistics stored in `pg_stats`. These statistics — row counts, column value distributions, correlation between physical order and sort order — are collected by `ANALYZE` and updated by autovacuum. When they're stale, the planner's cost estimates are wrong.

**Example:** A table had 1M rows when last analyzed. `user_id = 42` has 3 rows in statistics. The planner estimates 3 rows for a lookup, chooses Nested Loop. In reality, after a large import, user 42 has 200,000 rows. The Nested Loop on 200K rows is catastrophic.

**Symptoms:**

- `EXPLAIN ANALYZE` shows: `(rows=3 actual rows=200000)` — large divergence.
- Slow query appears sudden (wasn't slow before data grew).

**Fix:**

```sql
ANALYZE table_name;  -- rebuild statistics for one table
VACUUM ANALYZE table_name;  -- also reclaim dead tuples

-- For large tables that change faster than autovacuum handles:
ALTER TABLE orders SET (autovacuum_analyze_scale_factor = 0.01);  -- trigger at 1% change
```

**Prevention:** Monitor `last_analyze` in `pg_stat_user_tables`. Alert if any high-traffic table hasn't been analyzed in > 24 hours. Lower `autovacuum_analyze_scale_factor` for large tables where 20% (the default threshold) represents millions of changed rows.

---

**Q7: A query was running in 20ms. After a deployment last night, it now takes 8 seconds. No schema changed. What do you check?**

This is a classic query plan regression. The plan was correct before; now it's choosing a worse plan. Possible causes:

1. **Data volume crossed a threshold**: autovacuum missed a statistics update. Planner now uses a wrong row estimate. Fix: `ANALYZE table_name`.
2. **Parameter sniffing / plan cache**: the planner cached a plan based on one parameter value (e.g., popular user with 5 rows), but is now executing it for a user with 50K rows. Fix: `SET plan_cache_mode = 'force_generic_plan'` or prepared statement re-planning.
3. **Bloated table after bulk import**: dead tuples from a large DELETE/UPDATE inflate estimated table size. The planner thinks the table is larger → switches to SeqScan. Fix: `VACUUM ANALYZE`.
4. **Index became invalid**: `CREATE INDEX CONCURRENTLY` interrupted, leaving INVALID index. Fix: `DROP INDEX; CREATE INDEX CONCURRENTLY`.
5. **Statistics divergence after data change**: a new data pattern (e.g., new customers all in one region) shifts n_distinct or histogram, making the old plan suboptimal.

Always start with: `EXPLAIN (ANALYZE, BUFFERS) <slow query>`. Look for: (a) estimated vs actual row divergence, (b) SeqScan on a large table, (c) INVALID index in `pg_indexes`. Then `ANALYZE` the relevant tables.

---

## SECTION 11 — Debugging Exercise

### Production Incident: Sudden 45-Second API Response

**Scenario:**
Your `/api/orders/history` endpoint returns a user's last 50 orders, sorted by date. It has run at 12ms for 18 months. This morning at 09:15 it started timing out at 45 seconds. No code changes were deployed. Your SLA requires < 500ms.

---

**Step 1: Check what the query is.**

```sql
-- From the application code or slow query log:
SELECT id, total, status, created_at
FROM orders
WHERE customer_id = $1
ORDER BY created_at DESC
LIMIT 50;
```

**Step 2: Run EXPLAIN ANALYZE.**

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, total, status, created_at
FROM orders WHERE customer_id = 42 ORDER BY created_at DESC LIMIT 50;

-- OUTPUT (this morning):
-- Seq Scan on orders  (cost=0.00..4980000 rows=50 actual rows=50 width=32)
--   Filter: (customer_id = 42)
--   Rows Removed by Filter: 95000000     ← full 95M row SeqScan!
--   Buffers: shared hit=0 read=652000    ← pure disk read, nothing cached
-- Planning Time: 0.8ms
-- Execution Time: 44823ms
```

**Step 3: Check existing indexes.**

```sql
SELECT indexname, indexdef, pg_size_pretty(pg_relation_size(indexrelid))
FROM pg_indexes
JOIN pg_class ON indexname = relname
WHERE tablename = 'orders';
-- Output:
-- orders_pkey | ON orders USING btree (id) | 8GB
-- idx_orders_customer | ON orders USING btree (customer_id) | 4GB  ← exists!
```

**Step 4: Why isn't the index being used?**

```sql
-- Check index validity:
SELECT indexrelname, indisvalid
FROM pg_stat_user_indexes
JOIN pg_index ON indexrelid = pg_index.indexrelid
WHERE relname = 'orders';
-- Output:
-- orders_pkey: indisvalid = true
-- idx_orders_customer: indisvalid = FALSE  ← INVALID INDEX!
```

**Step 5: Check recent index operations.**

```sql
-- Check pg_stat_activity for recent CREATE INDEX operations:
-- Or check application logs / deployment history.
-- Finding: a DEV ran "REINDEX INDEX idx_orders_customer" at 09:10 (non-concurrent)
-- to fix perceived bloat. Server was live. REINDEX without CONCURRENTLY:
-- acquires AccessExclusiveLock → blocked by existing queries → waited → then blocked all writes.
-- The engineer killed the REINDEX at 09:12 after noticing the block.
-- REINDEX was interrupted before completing → left index in INVALID state.
```

**Step 6: Fix.**

```sql
-- Drop the invalid index and rebuild concurrently:
DROP INDEX CONCURRENTLY idx_orders_customer;
CREATE INDEX CONCURRENTLY idx_orders_customer ON orders(customer_id, created_at DESC);
-- Better: add created_at as second column to eliminate ORDER BY sort.
-- Monitor: tail the progress in pg_stat_progress_create_index.
SELECT phase, blocks_done, blocks_total, tuples_done, tuples_total
FROM pg_stat_progress_create_index
WHERE relid = 'orders'::regclass;
```

**After index rebuild:**

- Index valid: `indisvalid = TRUE`
- `EXPLAIN ANALYZE`: Index Scan Backward on `idx_orders_customer`. 50 rows. 1.2ms.
- API endpoint: back to 8ms. Incident resolved. Total outage: 35 minutes.

**Prevention implemented:**

1. Never run `REINDEX` (without CONCURRENTLY) on a production table.
2. Add alerting: `SELECT COUNT(*) FROM pg_index WHERE NOT indisvalid` — alert if > 0.
3. Runbook updated: all REINDEX operations must use CONCURRENTLY.

---

## SECTION 12 — Architect's Mental Model

```
=== Architect's Mental Model: Indexing — Why Queries Slow ===

┌─────────────────────────────────────────────────────────────────┐
│  PHILOSOPHY: Queries don't slow down; data outgrows them.        │
│  A query that scanned 10,000 rows at launch scans 50,000,000     │
│  rows at scale. Indexing is maintenance debt that compounds.     │
│  Budget regular index review into every growth milestone.        │
└─────────────────────────────────────────────────────────────────┘

DECISION RULES:

1. "EXPLAIN before you guess." Never add an index without running EXPLAIN ANALYZE first.
   Confirm the query actually does a SeqScan, confirm the table is large enough to benefit,
   and confirm the column has high enough selectivity. Data-driven decisions only.

2. The three-step index signal: slow query → SeqScan on large table → high seq_scan ratio
   in pg_stat_user_tables. All three: strong case for an index. One or two: investigate further.

3. Every index is a write tax. When adding an index, calculate the write-to-read ratio.
   If the table gets 100K writes/second and your new index would be queried 10 times/day:
   the tax is catastrophic. Drop it. The write path pays for it forever.

4. CONCURRENTLY is the only acceptable mode for production index creation.
   REINDEX without CONCURRENTLY is a scheduled outage. Never forget this under pressure.
   Even at 3am in an emergency: take the 30-minute CONCURRENTLY build over the 30-second
   ACCESS EXCLUSIVE lock that stalls your entire application.

5. Statistics are the planner's map. A stale map gives wrong directions.
   After any large data import, schema change, or sudden query regression:
   immediately run ANALYZE on affected tables. Add autovacuum_analyze_scale_factor tuning
   for tables that grow faster than autovacuum can keep up.

COMMON MISTAKES:

1. Adding an index for a query that was never slow.
   Profile first. Many developers add indexes "just in case" on every JOIN column.
   Result: write overhead without read benefit. Index hygiene requires saying no.

2. Forgetting to check for INVALID indexes after incidents.
   After any connection kill, server crash, or interrupted REINDEX:
   query `pg_index WHERE NOT indisvalid` immediately. INVALID indexes are invisible
   performance time bombs — queries silently fall back to SeqScan.

3. Tuning the query instead of tuning the statistics.
   The query may be perfectly written, but EXPLAIN shows SeqScan because the planner
   thinks the table has 1,000 rows (stale statistics) when it has 50,000,000.
   Before rewriting a query or adding an index: run ANALYZE and re-run EXPLAIN.
   80% of "wrong plans" fix themselves with current statistics.

                     ╔══════════════════════════════════╗
  30-SECOND ANSWER → ║  INDEXING SLOWS IN 30 SECONDS    ║
                     ╚══════════════════════════════════╝

"Queries slow down when the database must read more data than necessary to find
the matching rows. Without an index, a query scans the entire table — O(N) — even
to find a single row. An index is a pre-sorted data structure that lets the database
jump directly to matching rows in O(log N). As tables grow from thousands to millions
of rows, an unindexed query can go from milliseconds to minutes — not because
anything changed in the query, but because the data outgrew the scan capacity.
Diagnosis: EXPLAIN ANALYZE shows Seq Scan with high row counts. Fix: add a targeted
index, ensure statistics are fresh, and verify the index is used with EXPLAIN after creation."
```
