# SELECT & WHERE — Part 3 of 3

### Sections: 9 (AWS Mapping), 10 (Interview Questions), 11 (Debugging Exercise), 12 (Architect's Mental Model)

**Series:** Databases & Data Modeling → Topic 02

---

## SECTION 9 — AWS Service Mapping

### SELECT & WHERE Across AWS Data Services

```
RELATIONAL (RDS / Aurora):
  SELECT + WHERE: standard SQL. Optimizer behavior described in Parts 1-2.
  Aurora-specific:
    • Aurora Parallel Query: for large analytical SELECT + WHERE (bypasses buffer pool,
      pushes WHERE filters to storage layer → reduces data transferred to head node).
      Enable:  SET aurora_parallel_query = ON;
      Use for: full-table analytical scans with highly selective WHERE (< 25% of data).
      Avoid for: OLTP — parallel query has overhead. Better for ad-hoc analytics only.

    • Aurora serverless: auto-pause feature. Cold-start cost: 10-30 seconds for first query.
      Design around this: use Aurora Serverless v2 (scales to min 0.5 ACU, no cold start).

  RDS Read Replicas:
    Route SELECT-heavy workloads to read replica (via DNS endpoint or app-level routing).
    WHERE pushdown: same as primary. No special behavior.
    Replication lag: replica may be 10-1000ms behind. SELECT on replica: may return stale data.
    Use when: eventual consistency acceptable (analytics, reports, search indexes).
    Avoid when: "read your own write" consistency required (use primary endpoint).

AURORA SERVERLESS v2 SPECIFIC:
  Auto-scaling ACUs (Aurora Capacity Units) based on load.
  SELECT * on wide table during burst: triggers ACU scale-out.
  SELECT specific_cols: narrower result → less serialization → less memory → fewer ACUs needed.
  Cost implication: SELECT * → more ACUs consumed → higher bill.
  "SELECT * is expensive" is directly literal in serverless pricing.

DYNAMODB:
  No SQL SELECT/WHERE. Equivalent:
    • Query: requires Partition Key (column specified as PK). Fast. O(1). Use always when possible.
    • Scan: reads every item in table. Equivalent to SELECT * with no WHERE. Avoid in production.
    • Filter Expression: applied AFTER Scan fetches items. Does NOT reduce RCU consumption.
      (Read all items, filter in DynamoDB, return subset — but you pay for all read.)
    SELECT * WHERE region = 'EU': if region is not PK → requires Scan = full table read.
    Fix: add GSI (Global Secondary Index) on region attribute → Query on GSI efficiently.

  DESIGN IMPLICATION: DynamoDB "WHERE" planning = access pattern modeling at design time.
    No index = Scan. Scan = cost + latency × table size.

REDSHIFT (OLAP):
  SELECT + WHERE: columnar storage. WHERE pushdown is automatic (column-level zone maps).
  Zone maps: min/max per 1MB block per column. WHERE year = 2024 → skips blocks where
    year_min > 2024 or year_max < 2024. Reduces I/O dramatically.
  DISTKEY + SORTKEY strategy determines WHERE clause efficiency.
  WHERE on SORTKEY column: maximum zone map benefit (blocks sorted by that column).
  WHERE on non-SORTKEY: full column scan within matching blocks (still column-level, but no zone skip).

  RECOMMENDATION:
    SORTKEY: always matches your most common time-range WHERE clause (e.g., event_date).
    DISTKEY: matches your most common JOIN column (e.g., customer_id).

ATHENA:
  SELECT + WHERE on S3 data.
  WHERE on partition columns (year, month, day in path): partition pruning = reads fewer S3 objects.
  WHERE on non-partition column: full object scan of matching partitions.
  Partition columns in WHERE: mandatory for cost-efficient Athena queries.
  Parquet format: WHERE on a specific column → reads only that column's data (columnar).
  CSV/JSON format: reads entire file even for single-column WHERE. Use Parquet/ORC always.
```

---

## SECTION 10 — Interview Questions

### Beginner Questions

**Q1: What is the difference between `WHERE` and `HAVING`?**

> WHERE filters individual rows before grouping; it runs before GROUP BY and can use indexes.
> HAVING filters groups after aggregation; it runs after GROUP BY and operates on aggregated values.
> Use WHERE to filter rows, HAVING to filter groups. Moving a row-level filter from HAVING to WHERE
> reduces the number of rows that enter aggregation — critical for performance.

**Q2: Why is `SELECT *` considered bad practice in production code?**

> Three main reasons: (1) Schema drift — adding a column later (e.g., a sensitive SSN field)
> automatically exposes it to all SELECT \* callers. (2) Bandwidth waste — pulling every column
> when only 2 are needed wastes network and memory; severe on wide rows with blob columns.
> (3) Unstable contracts — if columns are reordered or renamed, positional ORM mappings break.
> Always name the columns you need.

**Q3: What is a SARGABLE predicate and why does it matter?**

> SARGABLE (Search ARGument ABLE) means the predicate can use a B-tree index directly.
> `WHERE created_at > '2024-01-01'` is sargable — the index is walked from that date forward.
> `WHERE YEAR(created_at) = 2024` is NOT sargable — the function must be computed per row;
> the index cannot be consulted. Sargability determines whether a query runs in milliseconds
> (index scan) or seconds (full sequential scan).

### Intermediate Questions

**Q4: A query runs fast in development (100K rows) but times out in production (50M rows). What are the first three things you check?**

> 1. `EXPLAIN (ANALYZE, BUFFERS)` — look for Seq Scan where an Index Scan was expected.
>    Seq Scan on a 50M row table = full scan; look for missing indexes.
> 2. Stale statistics — `pg_stats` shows last analyze date. Run `ANALYZE table_name`.
>    Planner uses statistics to choose join algorithms; stale stats = wrong plan.
> 3. WHERE clause sargability — check if any predicate wraps the column in a function
>    (YEAR(), LOWER(), CAST()) which disables index use regardless of whether an index exists.

**Q5: Explain the performance difference between `LIKE 'react%'` and `LIKE '%react%'`.**

> `LIKE 'react%'` (prefix match): sargable. B-tree index knows to scan all entries from 'react'
> to 'reacs' (next value). O(k) index reads where k = matching entries.
> `LIKE '%react%'` (contains match): NOT sargable. B-tree has no mechanism to find entries
> containing a substring — it would need to check every entry. Forces full sequential scan.
> Fix for contains: use a full-text search index (GIN + tsvector in Postgres) or pg_trgm
> trigram index (CREATE EXTENSION pg_trgm; CREATE INDEX ... USING gin(col gin_trgm_ops)).

### Advanced Questions

**Q6: Design a query pattern for "get all orders for a user" that works correctly under high concurrency with new orders being inserted continuously.**

> Use keyset pagination (cursor-based) over a composite index on `(user_id, created_at DESC, id DESC)`.
> First page: `WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 20`.
> Subsequent pages: `WHERE user_id = $1 AND (created_at, id) < ($last_ts, $last_id) ORDER BY ... LIMIT 20`.
> Under READ COMMITTED: each page query gets its own snapshot at statement start.
> New inserts: appear on the next page load (new snapshot), not mid-page, avoiding the skip/duplicate
> problem of OFFSET pagination. The composite index ensures the WHERE tuple is sargable.

**Q7: A critical query uses a covering index but `EXPLAIN` still shows `Heap Fetches: 250,000`. What's wrong and how do you fix it?**

> High Heap Fetches on an Index Only Scan indicates the visibility map for those pages is not
> up to date — Postgres must check the heap to determine row visibility (MVCC).
> Root cause: table hasn't been vacuumed recently; many dead tuples or recently-inserted rows
> not yet reflected in the visibility map.
> Fix: run `VACUUM table_name` — this updates the visibility map. After vacuum, heap fetches
> should drop to near zero for a true Index Only Scan. Long-term fix: tune autovacuum for the
> table's write rate (`autovacuum_vacuum_scale_factor`, `autovacuum_vacuum_cost_delay`).

---

## SECTION 11 — Debugging Exercise

### Scenario: Authentication Service Degrading Under Load

```
SYMPTOMS:
  - Production login endpoint P99 latency: 450ms (was 15ms last week)
  - DB CPU: 78% (was 8%)
  - No code changes deployed
  - Coincides with user growth: 300K → 3M users over past month
  - pg_stat_activity shows: dozens of identical queries running

QUERY SEEN IN pg_stat_activity:
  SELECT id, password_hash, last_login FROM users WHERE email = $1 AND active = TRUE;

INVESTIGATION STEPS:

Step 1: Check EXPLAIN ANALYZE:
  EXPLAIN (ANALYZE, BUFFERS)
  SELECT id, password_hash, last_login FROM users WHERE email = 'test@example.com' AND active = TRUE;

  OBSERVED:
    Seq Scan on users  (cost=0.00..45892.00 rows=1 width=88)
                                            (actual time=1823.431..1823.433 rows=1 loops=1)
      Filter: ((email = $1) AND (active = TRUE))
      Rows Removed by Filter: 2,999,999
    Buffers: shared hit=8654 read=12330  ← 12,330 pages read from disk

  Finding: No index on email. Full table scan of 3M users per login attempt.
  At 300K users: table fit in buffer cache (8K pages). Cache hit = fast.
  At 3M users: table = 80K pages. Doesn't fit in 1GB shared_buffers. Random disk reads.

Step 2: Check pg_stats for email column:
  SELECT n_distinct, null_frac, avg_width FROM pg_stats
  WHERE tablename = 'users' AND attname = 'email';
  -- n_distinct: -1 (all unique). avg_width: 28 bytes.
  -- Confirms: email is highly selective. Index would be extremely efficient.

Step 3: Check if index exists:
  SELECT indexname FROM pg_indexes WHERE tablename = 'users' AND indexdef LIKE '%email%';
  -- Empty. No index on email.

ROOT CAUSE: Missing index on email column. Scaled from 300K to 3M users.
At 300K users: table fit in RAM, seq scan fast enough (not noticed).
At 3M users: table 10x larger, no longer fits in cache, each login = disk I/O.

RESOLUTION:
  CREATE INDEX CONCURRENTLY idx_users_email ON users(email);
  -- CONCURRENTLY: no table lock. Builds index in background while production traffic flows.

  Better (only indexes active users — saves 20% inactive user index space):
  CREATE INDEX CONCURRENTLY idx_users_email_active ON users(email) WHERE active = TRUE;
  -- Partial index: smaller, faster, only serves the exact WHERE clause used.

OPTIMIZATION BONUS:
  ADD covering to eliminate heap fetch:
  CREATE INDEX CONCURRENTLY idx_users_login_covering
  ON users(email) INCLUDE (id, password_hash, last_login) WHERE active = TRUE;
  -- Login query: Index Only Scan. Zero heap reads. From 1,823ms → 0.3ms.
```

---

## SECTION 12 — Architect's Mental Model

```
=== Architect's Mental Model: SELECT & WHERE ===

DECISION RULE 1: Column list = bandwidth contract.
  Every column in SELECT list is a promise to serialize, transmit, and deserialize that data.
  SELECT * breaks this contract open-endedly. In any query touching > 10K rows or > 10MB of data:
  explicitly list only the columns the caller will actually use.

DECISION RULE 2: WHERE clause is the I/O controller.
  WHERE determines how many blocks are read from disk. Every predicate is either:
    (a) sargable → can use an index → O(k log N) reads | k = matching rows
    (b) non-sargable → cannot use index → O(N) reads (full scan)
  Design schema so commonly-filtered columns are indexable and predicates are sargable.

DECISION RULE 3: Selectivity determines strategy.
  High selectivity (< 2% rows match): index scan. Low selectivity (> 15% rows match): seq scan wins.
  The planner's job is to estimate this. Your job: keep statistics fresh (ANALYZE).
  Vacuum lag → stale stats → wrong plan → unexpected slowness.

DECISION RULE 4: Parameterization is not optional.
  Parameterized queries: plan cached, no injection risk.
  String interpolation: re-plan on every call, SQL injection surface, no cache benefit.
  Every query with a variable must be parameterized. No exceptions in production code.

DECISION RULE 5: Test query plans against production-scale row counts.
  Dev environment: 1,000 rows. Prod: 50,000,000 rows.
  A plan that uses seq scan on 1K rows (fine) uses seq scan on 50M rows (catastrophic).
  Use pg_class.reltuples to check production row counts.
  CI/CD: include explain-plan regression tests for critical query paths on realistic data volumes.

COMMON MISTAKE 1: Adding an index but query still uses seq scan.
  The predicate wraps the column: WHERE LOWER(email) = ... turns index on email useless.
  Fix: create a functional index: CREATE INDEX ON users(LOWER(email)) or rewrite the predicate.

COMMON MISTAKE 2: Trusting DEV query performance.
  Dev: seq scan of 1K rows = 0.5ms. Ships to prod. Prod: seq scan of 50M rows = 45 seconds.
  Monitoring catches this in prod. But the cost is already paid (user impact, on-call).
  Prevention: capture EXPLAIN output in CI against a data-scale representative environment.

COMMON MISTAKE 3: Dynamic WHERE with NULL-fallback disabling index.
  WHERE ($1 IS NULL OR col = $1) — the OR NULL path disables index use when $1 IS NULL.
  The planner sees: this condition is sometimes false for indexed rows, sometimes true for all rows.
  It conservatively chooses seq scan. Fix: build query conditionally in application code.

30-SECOND INTERVIEW ANSWER (Why does SELECT * hurt performance?):
  "SELECT star sends every column across the network and into application memory. If the table
  has a 500KB blob column and you're fetching 10,000 rows, that's 5GB of unnecessary data.
  Beyond bandwidth, it prevents covering index optimizations — the planner can't use an
  index-only scan if the application demands columns not in the index. Most critically it
  creates a fragile contract: adding a sensitive column to the table automatically exposes it
  to every SELECT star caller. In production, always name your columns."
```
