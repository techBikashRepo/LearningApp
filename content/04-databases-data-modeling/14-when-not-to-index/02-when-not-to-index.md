# When NOT to Index — Part 2 of 3

### Sections: 5 (Bad vs Correct), 6 (Performance Impact), 7 (Concurrency & Data Integrity), 8 (Optimization & Indexing)

**Series:** Databases & Data Modeling → Topic 14

---

## SECTION 5 — Bad Usage vs Correct Usage

### Pattern 1: Indexing a Boolean / Low-Cardinality Column

```sql
-- BAD: index on is_deleted boolean (2 values: true/false)
CREATE INDEX idx_users_deleted ON users(is_deleted);

-- Table: 50M users. is_deleted = TRUE: 1M (2%). is_deleted = FALSE: 49M (98%).
-- Query: SELECT * FROM users WHERE is_deleted = FALSE;
-- Selectivity: 98%. Planner correctly chooses SeqScan (reading 98% of the table).
-- The index is never used for this query. index for is_deleted = TRUE (2%): maybe.
-- In practice: planner still ignores it for anything above ~10-15% selectivity.

EXPLAIN SELECT * FROM users WHERE is_deleted = FALSE;
-- "Seq Scan on users  (cost=0.00..1022000.00 rows=49000000 ...)"
-- The index exists. It provides 0 benefit. It adds overhead on every write.

-- CORRECT approach:
-- Option A: Drop the index. Accept SeqScan for the high-selectivity case.
DROP INDEX CONCURRENTLY idx_users_deleted;

-- Option B: Partial index covering only the rare/useful value
CREATE INDEX idx_users_active ON users(id) WHERE is_deleted = FALSE;
-- Or for the deleted minority (2%):
CREATE INDEX idx_users_deleted_true ON users(id) WHERE is_deleted = TRUE;
-- Tiny. Planner uses it WHERE is_deleted = TRUE. Never used WHERE is_deleted = FALSE.
```

### Pattern 2: Index on a Tiny Table

```sql
-- BAD: adding an index to a table with 200 rows
CREATE TABLE payment_methods (
    id   SERIAL PRIMARY KEY,
    name VARCHAR(50) NOT NULL,    -- 'credit_card', 'paypal', 'crypto', ...
    active BOOLEAN NOT NULL DEFAULT TRUE
);
-- 200 rows. 200 rows fit in 2-3 heap pages.
-- SeqScan: reads 2-3 pages, checks 200 rows. Total: ~0.001ms.
-- Index Scan: reads 2-3 index pages + 1 heap page per match. Potentially MORE I/O.
-- Planner for small tables: ALWAYS chooses SeqScan (by design). Index never used.

CREATE INDEX idx_payment_methods_active ON payment_methods(active);
-- idx_scan = 0 forever. Wasted. Maintenance overhead on every write.

-- CORRECT: for lookup tables or config tables below ~10,000 rows, no extra indexes needed.
-- The PK/UNIQUE constraints are sufficient. Planner handles the rest.
-- Exception: FK reference indexes are still needed even on small tables
-- (the FK lookup: PostgreSQL scans the referenced table, not just the referencing one).
```

### Pattern 3: Index on a Column Used Only in OLAP / Reporting Queries

```sql
-- BAD: creating B-tree index on a column used only in GROUP BY aggregation
CREATE INDEX idx_events_country ON events(country_code);
-- Table: 2B rows. country_code has 200 distinct values.
-- Typical analytics: SELECT country_code, COUNT(*) FROM events GROUP BY country_code;
-- Result: 200 groups from 2B rows. Planner reads the entire table regardless.
-- Index: zero benefit for full-table aggregation. Planner chooses SeqScan + Hash Aggregate.
-- But: every INSERT into events now also writes to idx_events_country. 2B × tiny cost = large total.

-- CORRECT for analytics workload:
-- Option A: No index. Accept SeqScan; use parallel workers.
SET max_parallel_workers_per_gather = 8;
EXPLAIN SELECT country_code, COUNT(*) FROM events GROUP BY country_code;
-- Parallel Seq Scan (8 workers) on 2B rows: 30-60 seconds. Acceptable for nightly reports.

-- Option B: Partition by time, BRIN index for time range filtering (not GROUP BY column):
CREATE INDEX idx_events_created_brin ON events USING BRIN(created_at);
-- Analytics: WHERE created_at BETWEEN '2024-01-01' AND '2024-12-31' reduced from 2B to 200M.
-- Then SeqScan with parallel workers on the 200M subset. Much faster. Minimal index overhead.

-- Option C: Materialized view or pre-aggregation for dashboard queries (not an index solution).
```

### Pattern 4: Index on a Column With a Volatile Expression Default

```sql
-- BAD: indexing a UUID column populated by gen_random_uuid() (v4 UUIDs in random order)
CREATE TABLE sessions (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id BIGINT NOT NULL
);
-- PK index: B-tree on UUID. Random UUIDs → random insert positions in B-tree.
-- 500M rows: every INSERT lands on a RANDOM leaf page.
-- That page likely not in shared_buffers (random access pattern). Cache miss.
-- Result: significant page splits. Index bloat over time. High random I/O.

-- CORRECT: use UUIDv7 (time-ordered) or BIGSERIAL for high-insert tables
-- UUIDv7 (available via extensions or Postgres 17 pg_uuidv7):
-- Same global uniqueness as v4, but monotonically increasing prefix.
-- B-tree: new inserts always append to the rightmost leaf. No random splits. Efficient.
CREATE TABLE sessions (
    id UUID DEFAULT uuid_generate_v7() PRIMARY KEY,  -- time-ordered UUID
    user_id BIGINT NOT NULL
);
-- Or simply use BIGSERIAL if global uniqueness across systems is not needed:
CREATE TABLE sessions (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL
);
```

---

## SECTION 6 — Performance Impact

### Write Amplification — Measured Overhead per Index

```
BENCHMARK: PostgreSQL 15, m6i.4xlarge (16 CPU, 64GB RAM), 1TB NVMe.
Workload: INSERT 5M rows, transaction batches of 1000 rows.
Table: events(id BIGSERIAL, user_id BIGINT, session_id UUID, event_type VARCHAR20, created_at TIMESTAMPTZ, payload JSONB)

Number of Indexes | Total INSERT Time | Throughput (rows/s) | Overhead vs baseline
------------------|-------------------|---------------------|---------------------
1 (PK only)       | 9.5s              | 526,315             | baseline
2 (+ user_id)     | 12.1s             | 413,223             | 27%
3 (+ session_id)  | 15.6s             | 320,513             | 64%
4 (+ event_type)  | 18.9s             | 264,550             | 99%
5 (+ created_at)  | 22.4s             | 223,214             | 136%
6 (+ payload GIN) | 41.8s             | 119,617             | 340%
10 (all + 4 more) | 78.2s             | 63,940              | 723%

GIN index on JSONB: single most expensive (payload GIN adds 164% overhead alone).
Each additional B-tree: roughly 25-35% overhead on the baseline.
At 10 indexes: same workload takes 8x longer. Throughput drops 88%.

UPDATE amplification (indexed column change):
  UPDATE events SET event_type = 'click' WHERE id = $1;
  event_type index: delete old entry + insert new entry = 2 × B-tree writes.
  10 indexed columns, all changed: 20 index leaf writes + possible splits.

  HOT update (non-indexed column change):
  UPDATE events SET payload = $1 WHERE id = $1;
  If payload and id are on the same heap page: no index writes at all.
  Zero index overhead. 10 indexes: doesn't matter. HOT update bypasses all.

INDEX STORAGE COST:

  Table: events, 5M rows after benchmark.

  pg_relation_size('events'): 1,800MB (heap data)
  pg_relation_size('idx_events_pkey'):         83MB
  pg_relation_size('idx_events_user_id'):      83MB
  pg_relation_size('idx_events_session_id'):  167MB (UUID = wider key)
  pg_relation_size('idx_events_event_type'):   55MB
  pg_relation_size('idx_events_created_at'):  111MB
  pg_relation_size('idx_events_payload_gin'): 890MB (GIN: high overhead for JSONB)

  Total index storage: 1,389MB (~77% of heap size)
  Total on-disk footprint: 3,189MB (1.77x heap-only)

  At 10 indexes: total indexes may exceed table size. Doubles storage cost.
  For 10TB tables: each unnecessary index = 2-5TB of wasted disk.
```

---

## SECTION 7 — Concurrency & Data Integrity

### Index Creation, Drop, and Maintenance Concurrency

```
CREATE INDEX CONCURRENTLY — LOCK BEHAVIOR:

  Phase 1: ShareUpdateExclusiveLock briefly. Registers index in catalog.
           Allows: SELECT, INSERT, UPDATE, DELETE. No blocking.

  Phase 2: Reads all existing rows. Fills index. No additional locks.
           Ongoing writes: captured via WAL log, applied in Phase 3.

  Phase 3: Second pass using WAL entries. Marks index VALID.
           Brief ShareUpdateExclusiveLock again to finalize.

  Why CONCURRENTLY is always preferred in production:
    A 15-minute index build with no CONCURRENTLY = 15-minute write stall.
    CONCURRENTLY: 25-minute build (slower) but zero write blocking. Always worth it.

  Pitfall: CONCURRENTLY cannot run inside a transaction block.
  If your migration tool wraps in BEGIN/COMMIT: remove the wrapping transaction for index creation.
  Flyway, Liquibase, Alembic: all have configurations to run specific migrations non-transactional.

DROP INDEX CONCURRENTLY — IMPACT ON WRITE THROUGHPUT:

  Dropping an index: immediately removes write overhead.
  DROP INDEX CONCURRENTLY idx_events_user_id;

  Before drop: each INSERT into events → also writes to user_id B-tree.
  After drop:  INSERT → only writes to remaining indexes. Lower per-insert cost.

  Real impact: on the high-write events table (500K/s ingestion rate), dropping 4 unused indexes
  raised throughput from 280K rows/s to 430K rows/s (+54%) by eliminating write amplification.

  DROP INDEX CONCURRENTLY uses ShareUpdateExclusiveLock (same as CREATE).
  No write blocking. Safe during production hours.

PARALLEL INDEX CREATION:
  PostgreSQL 11+ supports parallel index builds (non-CONCURRENTLY only).
  SET max_parallel_maintenance_workers = 4;
  CREATE INDEX idx_events_created ON events(created_at);  -- 4 workers scan table in parallel

  4 workers: roughly 2-3x faster than single-threaded (I/O bound, not CPU bound).
  CONCURRENTLY: currently single-threaded (Phase 2 and Phase 3).
  Trade-off: for large tables in maintenance windows, REINDEX without CONCURRENTLY + parallelism
  is faster (2-3x). With CONCURRENTLY: 1 thread, 3x longer, but no blocking. Choose based on context.
```

---

## SECTION 8 — Optimization & Indexing

### Automated Index Audit and Right-Sizing

```
AUDIT #1: Zero-Usage Indexes (DROP Candidates)

SELECT
  s.schemaname,
  s.relname                                          AS table,
  s.indexrelname                                     AS index,
  pg_size_pretty(pg_relation_size(s.indexrelid))    AS index_size,
  s.idx_scan                                        AS scans_since_restart,
  t.n_live_tup                                      AS live_rows
FROM pg_stat_user_indexes s
JOIN pg_stat_user_tables t ON s.relid = t.relid
WHERE s.schemaname = 'public'
  AND s.idx_scan = 0                                  -- never used
  AND s.indexrelname NOT LIKE '%pkey'                 -- keep primary keys
  AND s.indexrelname NOT LIKE '%unique'               -- keep unique constraints
  AND t.n_live_tup > 10000                            -- non-trivial tables
ORDER BY pg_relation_size(s.indexrelid) DESC;

-- Review output: large indexes with 0 scans → strong DROP candidates.
-- Confirm: pg_stat_user_indexes resets on pg_stat_reset() or server restart.
-- Run for 30+ days without restarts for reliable zero-scan data.

AUDIT #2: Low-Selectivity Indexes (Likely Ignored by Planner)

SELECT
  a.attname AS column,
  s.n_distinct,
  s.correlation,
  pg_size_pretty(pg_relation_size(i.indexrelid)) AS index_size,
  i.indexrelname AS index
FROM pg_stats s
JOIN pg_class c ON c.relname = s.tablename
JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = s.attname
JOIN pg_index pi ON pi.indrelid = c.oid
JOIN pg_stat_user_indexes i ON i.indexrelid = pi.indexrelid
WHERE s.schemaname = 'public'
  AND s.tablename = 'events'
  AND (s.n_distinct BETWEEN -0.2 AND 0 OR s.n_distinct < 20)  -- low cardinality
ORDER BY ABS(s.n_distinct);
-- n_distinct: positive = absolute count. Negative = fraction of rows (-0.1 = 10% unique).
-- n_distinct = -0.02 (2% unique values): index likely ignored for any query >15% selectivity.

AUDIT #3: Redundant / Overlapping Indexes

-- An index (A) is redundant if another index (B) has A's columns as a leading prefix.
-- e.g., index on (customer_id) is redundant if (customer_id, status, created_at) exists.
-- The composite already covers all queries that the single-column would.

-- Use the pg_index catalog to detect overlapping indexes:
SELECT
  a.indrelid::regclass AS table,
  array_agg(ic.relname ORDER BY ic.relname) AS indexes,
  COUNT(*) AS index_count
FROM pg_index a
JOIN pg_class ic ON ic.oid = a.indexrelid
JOIN pg_class tc ON tc.oid = a.indrelid
GROUP BY a.indrelid, a.indkey
HAVING COUNT(*) > 1;  -- same column combination in multiple indexes
-- This catches exact duplicates. Manual review still needed for prefix overlaps.

STRATEGY FOR HIGH-WRITE TABLES:

  Target: keep index count to 1-3 per high-write table.

  Step 1: Profile top 10 queries via pg_stat_statements.
  Step 2: Build one composite index covering the top 3 query patterns.
  Step 3: Drop all single-column indexes that are prefixes of the composite.
  Step 4: For any remaining unique access patterns: add targeted partial indexes.
  Step 5: Monitor idx_scan on the new indexes. At 30 days: drop anything still at 0.

  Ideal target for a high-write table (500K writes/second):
    events(id PK, user_id, event_type, created_at, session_id):
    Keep: events_pkey (required).
    Keep: idx_events_user_created (user_id, created_at DESC) — top API query.
    Add: idx_events_created_brin ON events USING BRIN(created_at) — for analytics time range.
    Drop: any individual single-column B-trees on event_type, session_id if not needed.
    Total: 3 indexes. Balanced write throughput + read performance.
```
