# When NOT to Index — Part 3 of 3

### Sections: 9 (AWS Service Mapping), 10 (Interview Q&A), 11 (Debugging Exercise), 12 (Architect's Mental Model)

**Series:** Databases & Data Modeling → Topic 14

---

## SECTION 9 — AWS Service Mapping

### "When NOT to Index" Across AWS Services

```
Aurora PostgreSQL:

  Aurora I/O pricing (non-I/O-Optimized):
    Each index: charges I/O per page read during index scans AND per page write during index maintenance.
    Unnecessary indexes: directly inflate Aurora I/O costs. Not just a performance problem — a billing problem.
    Example: 8 unused indexes on a 500M-row events table:
      INSERT rate: 10K rows/sec × 8 indexes = 80K extra index page writes/sec.
      Aurora I/O: charged per I/O. At $0.20/million I/O ops:
      80K × 3600sec × 24hr = 6.9 billion extra I/Os/day = $1,380/day for unused indexes.
    Dropping unused indexes: both a performance win and a cost win in Aurora.

    I/O-Optimized Aurora: flat pricing. Index count affects write throughput but not direct I/O cost.
    Still: fewer indexes = higher INSERT throughput = fewer compute resources needed.

  Aurora Serverless v2:
    Scales ACUs (Aurora Capacity Units) based on load.
    Heavy index maintenance on write-heavy tables → higher CPU/I/O → more ACUs → higher cost.
    Over-indexed tables on Aurora Serverless: can significantly increase the minimum capacity needed.
    Monitor: CloudWatch ACUUtilization spike during bulk writes → check index count.

RDS MySQL / Aurora MySQL:

  InnoDB change buffer partially mitigates write amplification from unnecessary secondary indexes.
  Change buffer: defers non-unique secondary index updates to batch applies during idle time.
  Effect: INSERT/UPDATE: don't always immediately write all secondary indexes.
  Limitation: UNIQUE indexes and PRIMARY KEY: cannot use change buffer (must verify immediately for uniqueness).

  Result: MySQL/Aurora MySQL unnecessary non-unique BTREE indexes: less immediately painful than PostgreSQL.
  But: still wastes disk, still causes VACUUM/purge overhead, still inflates buffer pool usage.
  Rule: same principle applies — remove indexes not driven by query patterns.

  MySQL EXPLAIN and unused index detection:
    MySQL: SELECT * FROM performance_schema.table_io_waits_summary_by_index_usage
           WHERE OBJECT_SCHEMA = 'app_db' AND COUNT_READ = 0 AND COUNT_WRITE = 0;
    Show indexes with zero reads AND zero writes → drop candidates.
    (Note: reset when MySQL restarts. Needs stable, long-running period to be reliable.)

DynamoDB:

  DynamoDB: GSI = automatic cost.
  Each GSI: reads and writes consume additional RCUs/WCUs separately from the base table.
  DynamoDB pricing is tied to capacity unit consumption. Unused GSIs still consume WCUs on write.

  Effect: a GSI that is never queried still consumes write capacity on every base table update.
  For tables with 100K writes/second: an unused GSI adds 100K WCUs/second of unnecessary cost.
  At on-demand pricing: $1.25/million WRUs. 100K × 3600 × 24 = 8.64 billion extra WRUs/day = $10,800/day.

  DynamoDB unused GSI: potentially the most expensive "unnecessary index" scenario of any platform.

  Monitoring: CloudWatch metric ConsumedWriteCapacityUnits per GSI.
  If a GSI has high ConsumedWCU but low SuccessfulRequestLatency (no queries): unused GSI. Delete it.

  LSI (Local Secondary Index):
    Shares WCU with base table. Created at table creation only.
    Cannot delete an LSI without re-creating the table.
    Over-specified LSIs at creation time: permanent write amplification. Cannot be removed.
    Rule: be very conservative with LSI creation. Only add what you're certain you need.

Amazon Redshift:

  Redshift: no traditional B-tree indexes. Sort keys and distribution keys play their roles.

  "When not to sort key":
    Random distribution table (EVEN diststyle): sort key has no co-location benefit.
    Fact tables with no common query predicate: sort key choice irrelevant. Skip.
    Tables < 1M rows: Redshift full scan is fast. Sort key overhead not worth the VACUUM cost.

  Interleaved sort key over-use:
    Interleaved SORTKEY (col1, col2, col3): balanced access across all three. High VACUUM REINDEX cost.
    More than 3-4 columns in an interleaved sort key: VACUUM REINDEX takes hours. Not worth it.
    Default to COMPOUND sort key for most tables. Only interleaved when multiple access patterns exist
    with proven equal frequency.
```

---

## SECTION 10 — Interview Questions & Answers

### Beginner Level

**Q1: Why would adding an index actually make a database slower?**

Each index you add must be updated every time a row is inserted, updated (if the indexed column changes), or deleted (deferred to VACUUM). On a write-heavy table, this write amplification accumulates. Every INSERT into a table with 10 indexes writes to 10 B-trees instead of one heap. A benchmark with 10M inserts: 1 index (PK) → 526K rows/sec; 12 indexes → 89K rows/sec. That's an 83% throughput reduction from indexing.

Additionally, if the query is highly selective (e.g., `WHERE status = 'ACTIVE'` when 90% of rows are active), the database correctly ignores the index and performs a sequential scan anyway — meaning the index provides zero read benefit while still adding write overhead. The index is pure cost.

---

**Q2: What types of queries can the planner choose to ignore an existing index?**

The planner ignores an index when its estimated cost exceeds the sequential scan cost. This happens in these scenarios:

1. **Small tables**: a 500-row table fits in 3-4 pages. A SeqScan of 4 pages is faster than an index descent of 3-4 pages + random heap fetches.
2. **Low selectivity**: `WHERE status IN ('active', 'inactive')` — if both values cover 50%+ of rows each, an index scan fetches more than half the table via random I/O. SeqScan is cheaper.
3. **Large LIMIT-free scans**: `SELECT * FROM events WHERE year = 2024` — if 2024 covers 80% of events, sequential scan wins.
4. **Non-sargable predicates**: `WHERE LOWER(email) = 'alice@corp.com'` — the index is on raw `email`, not `LOWER(email)`. The function transformation makes the index unusable.
5. **Correlation mismatch**: if physical row order correlates poorly with the index column (rows are scattered randomly on disk), random heap fetches cost more than sequential scan. Bitmap Scan is chosen as a middle ground.

---

**Q3: What does "write amplification" mean in the context of database indexes?**

Write amplification is when a single logical write (one INSERT or UPDATE) causes multiple physical writes to disk. Each index on a table requires its own B-tree to be updated whenever indexed column values change. One row INSERT with 10 indexes: triggers 1 heap write + up to 10 × (B-tree descent + leaf page write + possible page split cascade).

If a leaf page is full and splits: the parent branch page also needs updating. If the parent splits too: the grandparent. This cascade is rare but adds up at high write rates. The practical impact: each additional index reduces insert throughput by 25-35% (measured across common workloads). For a table receiving 500K inserts/second, the difference between 2 indexes and 10 indexes is 400K rows/second of lost throughput.

---

### Intermediate Level

**Q4: How do you identify indexes that should be dropped in a production database?**

Use a multi-signal approach:

```sql
-- Signal 1: zero idx_scan (never read)
SELECT indexrelname, idx_scan, pg_size_pretty(pg_relation_size(indexrelid)) AS size
FROM pg_stat_user_indexes
WHERE schemaname = 'public' AND idx_scan = 0
  AND indexrelname NOT LIKE '%pkey'
  AND indexrelname NOT LIKE '%unique';
-- Run after 30+ days of uptime without pg_stat_reset().

-- Signal 2: index read ratio very low vs writes
SELECT indexrelname,
       idx_scan AS reads,
       idx_tup_read AS tuples_read,
       pg_size_pretty(pg_relation_size(indexrelid)) AS size
FROM pg_stat_user_indexes
WHERE schemaname = 'public'
  AND idx_scan < 100    -- very few reads
ORDER BY pg_relation_size(indexrelid) DESC;

-- Signal 3: pg_stats — column has very low cardinality (index likely ignored by planner anyway)
SELECT attname, n_distinct
FROM pg_stats
WHERE tablename = 'events'
  AND (n_distinct > -0.1 AND n_distinct < 20);  -- absolute <20 or <10% unique

-- After identifying candidates: use hypopg to confirm index removal won't hurt any real query.
-- Then: DROP INDEX CONCURRENTLY idx_name; one at a time, monitoring query latency.
```

---

**Q5: Under what conditions should you drop indexes before a large bulk load and recreate them after?**

When loading data in bulk (millions of rows via `COPY` or large `INSERT ... SELECT`), each inserted row updates every index in real time. For a table with 6 indexes and 500M rows to load: each row touches 6 B-trees = 3 billion index writes. This can take 8-10 hours.

If you drop all non-PK indexes before the load and recreate them after:

- Indexes are rebuilt in one pass using efficient sort + bulk-fill (faster than row-by-row incremental updates).
- FILLFACTOR applies cleanly: pages packed optimally from the start. No fragmentation.
- Result: same load that took 8.5 hours takes 2.5 hours (load) + 0.5 hours (index rebuild) = 3 hours. 65% reduction.

**Steps:**

1. Script: `DROP INDEX CONCURRENTLY` for all non-PK, non-UNIQUE indexes (keep UNIQUE for constraint enforcement).
2. Bulk load via `COPY table FROM '/data/file.csv'` or `INSERT INTO ... SELECT`.
3. `ANALYZE table_name` immediately after load.
4. `CREATE INDEX CONCURRENTLY` for each dropped index.

Important: keep UNIQUE constraint indexes during load if uniqueness must be enforced during the load itself. If uniqueness can be verified post-load, drop those too and recreate after with a UNIQUE constraint validation.

---

### Advanced Level

**Q6: A senior engineer insists on a GIN index on every JSONB column "for flexibility." What's the argument against it, and under what conditions might they be right?**

**The argument against:**

GIN (Generalized Inverted Index) on JSONB is expensive to maintain. GIN indexes every key-value element in the JSONB document separately. For a JSONB column with 50 keys and 100 values per document:

- One INSERT: updates the GIN index with ~150 entries (each key, each value).
- At 10K inserts/sec: 1.5 million GIN index writes/second.
- GIN write overhead: each GIN write is 5-15x more expensive than B-tree (more pages modified per entry due to the inverted structure).
- Result: GIN on a high-write JSONB events column can increase INSERT latency by 200-400%.

Additionally, GIN indexes are large: 20-50% of the JSONB data size. On a 1TB events table: 200-500GB of GIN index storage.

**When a GIN index IS justified:**

1. The JSONB column is queried frequently with `@>` (containment), `?` (key exists), or full-text within JSONB.
2. The table is read-heavy (OLTP reads >> writes). Few writes, many reads.
3. A targeted GIN on a SPECIFIC path is more efficient: `CREATE INDEX ON docs((metadata->>'category'))` — just a functional B-tree on one extracted JSON path, not a full GIN.

**Counter-proposal:** Index only the specific JSON paths your queries actually use via functional indexes. Full GIN only for true free-form search across all fields (like a product search on arbitrary attributes).

---

**Q7: How does the PostgreSQL planner's "correlation" statistic affect index selection, and what does it mean for "when not to index"?**

`correlation` in `pg_stats` measures how well the physical storage order of rows correlates with the sorted order of a column's values. Range: -1.0 to +1.0.

**correlation = 1.0 (perfect):** rows with `created_at = '2024-01-01'` are stored together on the same heap pages. An index range scan reads a consecutive block of heap pages → sequential-like I/O. Index Scan is very efficient.

**correlation = 0.0 (random):** rows with `email = 'alice@corp.com'` could be on any of the 200,000 heap pages. Each matching row requires reading a different page. For 5,000 matching rows: 5,000 random page reads. At `random_page_cost = 4.0`, this is far more expensive than a sequential scan. The planner chooses:

- Index Scan for very low row counts (< 0.5% of table).
- Bitmap Index Scan (converts random to sequential-ish) for medium selectivity (0.5-15%).
- SeqScan for high selectivity (>15%).

**"When not to index" implications:** a column with low correlation (random physical order relative to its sorted values) yields less benefit from a B-tree index for range queries. For a column like `user_id` on an `events` table (inserted in time order, but user_id is random): correlation ≈ 0. A range scan on `user_id` requires random page fetches. A point lookup (`WHERE user_id = 42`) still benefits, but range scans (`WHERE user_id BETWEEN 1000 AND 2000`) may not — especially at medium selectivity. Check correlation before assuming an index will help range queries.

---

## SECTION 11 — Debugging Exercise

### Production Incident: INSERT Performance Collapse Under Index Accumulation

**Scenario:**
Your data ingestion service writes 200K events/second to the `events` table. At launch 18 months ago, inserts ran at 195K-200K/sec. This month it's averaging 38K/sec — an 81% throughput drop — and the team is discussing upgrading to a larger instance. You suspect something else before recommending a $12K/month hardware upgrade.

---

**Step 1: Establish baseline without a hardware change.**

```sql
-- Check: how many indexes on this table?
SELECT indexname, pg_size_pretty(pg_relation_size(indexrelid)) AS index_size
FROM pg_indexes
JOIN pg_class ON indexname = relname
WHERE tablename = 'events';

-- Output (13 indexes!):
-- events_pkey              | 82GB
-- idx_events_user_id       | 77GB
-- idx_events_session_id    | 155GB  (UUID: large)
-- idx_events_type          | 44GB
-- idx_events_page_url      | 200GB  (TEXT: huge)
-- idx_events_referrer      | 180GB  (TEXT: huge)
-- idx_events_ip            | 55GB
-- idx_events_country       | 22GB
-- idx_events_created_at    | 88GB
-- idx_events_device        | 30GB
-- idx_events_browser       | 28GB
-- idx_events_os            | 25GB
-- idx_events_gin_payload   | 400GB  (GIN on JSONB payload)
-- Total indexes: 1,386GB (~1.4TB). Table data: 900GB.
-- Index storage: 154% of table data! Massive.
```

**Step 2: Identify which indexes are actually used.**

```sql
SELECT indexrelname, idx_scan
FROM pg_stat_user_indexes
WHERE relname = 'events'
ORDER BY idx_scan DESC;

-- Output:
-- events_pkey            | 4,200,000  (used: PK lookups)
-- idx_events_user_id     | 3,800,000  (used: user activity queries)
-- idx_events_created_at  | 2,100,000  (used: time range queries)
-- idx_events_session_id  | 890,000    (used: session replay queries)
-- idx_events_type        | 45,000     (used somewhat)
-- idx_events_country     | 1,200      (rare)
-- idx_events_ip          | 880        (occasional fraud checks)
-- idx_events_device      | 120        (basically never)
-- idx_events_browser     | 90         (basically never)
-- idx_events_os          | 60         (basically never)
-- idx_events_page_url    | 0          (NEVER USED)
-- idx_events_referrer    | 0          (NEVER USED)
-- idx_events_gin_payload | 0          (NEVER USED — added "for future use")
```

**Step 3: Calculate the write savings from dropping unused indexes.**

```
Indexes to drop: page_url (200GB), referrer (180GB), gin_payload (400GB), device (30GB), browser (28GB), os (25GB), country (22GB) = 7 indexes.
Keep: pkey, user_id, created_at, session_id, type, ip = 6 indexes.

Estimated write amplification: 13 indexes = each insert writes ~13 B-tree pages (+ GIN = ~25 writes).
After drop: 6 indexes = each insert writes ~6 pages.
Expected throughput improvement: 13/6 ≈ 2.2x.
Expected new throughput: 38K × 2.2 = ~83K/sec. Still below original 200K.
But: the GIN index alone may account for 50% of write overhead (GIN is 5-10x per-write cost).
With GIN gone: expected 160-180K/sec. Close to original.
```

**Step 4: Execute the drops.**

```sql
-- Drop largest unused indexes first to reclaim write capacity:
DROP INDEX CONCURRENTLY idx_events_gin_payload;    -- 400GB, GIN overhead eliminated
DROP INDEX CONCURRENTLY idx_events_page_url;       -- 200GB, TEXT index, never used
DROP INDEX CONCURRENTLY idx_events_referrer;       -- 180GB, TEXT index, never used
DROP INDEX CONCURRENTLY idx_events_device;
DROP INDEX CONCURRENTLY idx_events_browser;
DROP INDEX CONCURRENTLY idx_events_os;
DROP INDEX CONCURRENTLY idx_events_country;
-- After each drop: monitor ingestion throughput in real-time. Should rise incrementally.
```

**Post-drop throughput: 188K rows/second.** From 38K to 188K with zero hardware change.

**Storage reclaimed:** 885GB of index storage freed. Instance storage pressure reduced significantly.

**Prevention:** Add automated index monitoring:

- Weekly `idx_scan = 0` check with alerting.
- Quarterly index review: any index with `idx_scan < 1000 / per million inserts` → DROP candidate.
- Require justification ("this query exists and runs frequently") before any new index is added to high-throughput tables.

---

## SECTION 12 — Architect's Mental Model

```
=== Architect's Mental Model: When NOT to Index ===

┌─────────────────────────────────────────────────────────────────┐
│  PHILOSOPHY: Every index is a debt contract.                     │
│  You borrow read-time performance by paying write-time tax.      │
│  The debt is perpetual — paid on every write for as long as      │
│  the index exists. Only create indexes where the read benefit    │
│  provably exceeds the write cost over the access profile.        │
└─────────────────────────────────────────────────────────────────┘

DECISION RULES:

1. Prove the query is slow BEFORE adding an index.
   Index-driven development: "this column is queried, I should add an index" without benchmarking
   is the root cause of 90% of over-indexed tables. Always: EXPLAIN ANALYZE first, index second.
   If the query isn't slow, there's no case to make.

2. Calculate write-to-read ratio. High writes, rare reads → don't index.
   events table: 200K writes/second. A given session_id: queried once when a user replays a session.
   Ratio: 200,000 writes per 1 read. The index pays for 200,000 write operations to accelerate
   ONE read. Consider an application-layer cache instead.

3. Check column selectivity before indexing. Low cardinality = the planner won't use it anyway.
   n_distinct < 10 OR percentage of rows returned > 15%: index likely ignored by planner.
   An index that the planner ignores for all practical queries is pure write overhead.
   Exception: partial index on the rare value (e.g., WHERE status = 'FAILED' when failures are <1%).

4. Bulk loads: drop non-critical indexes, load, recreate.
   If you're loading more than 10% of a table's eventual data: the rebuild-after approach wins.
   Always ANALYZE immediately after load. Always recreate with CONCURRENTLY.

5. OLAP workloads: think zone maps and columnar compression, not row-level indexes.
   A B-tree index in Redshift or on a 10B-row PostgreSQL analytics table: wrong tool.
   BRIN for physical sort columns. Partition pruning for time ranges. Parallel workers for aggregates.
   Columnar stores (Aurora Parallel Query, Redshift, BigQuery): different performance model entirely.
   B-tree indexes are OLTP tools. Don't apply them to OLAP problems.

COMMON MISTAKES:

1. Adding an index "for future queries we might add."
   "We might query this someday" indexes accumulate over years. 18 months later: 13 indexes,
   7 unused, 81% write throughput degraded. The team considers a hardware upgrade.
   Policy: no indexes without a current, slow, identified query that needs them. No speculative indexing.

2. Not measuring before AND after index changes.
   Dropping an unused index without monitoring INSERT throughput and query latency.
   Adding an index without confirming the target query now uses it and is faster.
   Index changes: always measure the before state, apply the change, measure the after state.
   No measurement = no learning = same mistakes repeated next quarter.

3. Keeping "just in case" indexes after query patterns change.
   Feature was removed 6 months ago. Index supporting that feature's query: still there.
   Still paying write overhead. Still occupying storage.
   Establish a "30-day rule": any index with idx_scan = 0 after 30 days of production traffic
   gets a DROP ticket. Exceptions require explicit justification: "used by scheduled job X."

                     ╔══════════════════════════════════╗
  30-SECOND ANSWER → ║  WHEN NOT TO INDEX IN 30 SECONDS ║
                     ╚══════════════════════════════════╝

"Every index adds write overhead paid on every INSERT, UPDATE, and DELETE — forever.
Don't index when: the column has low cardinality (planner ignores it anyway), the table
is small (SeqScan is faster), the workload is write-heavy with rare reads (write tax
exceeds read benefit), you're doing bulk OLAP loads (drop indexes, load, recreate),
or the predicate is non-sargable (wrapped in a function — index can't help).
Detect unnecessary indexes with pg_stat_user_indexes watching for idx_scan = 0 after
30 days. Drop them. Each dropped unused index directly increases write throughput
and frees storage. The best index is the one that earns its write cost every day."
```
