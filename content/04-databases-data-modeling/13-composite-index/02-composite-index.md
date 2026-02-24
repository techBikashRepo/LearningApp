# Composite Index — Part 2 of 3

### Sections: 5 (Bad vs Correct), 6 (Performance Impact), 7 (Concurrency & Data Integrity), 8 (Optimization & Indexing)

**Series:** Databases & Data Modeling → Topic 13

---

## SECTION 5 — Bad Usage vs Correct Usage

### Pattern 1: Wrong Column Order (Range Predicate Before Equality)

```sql
-- BAD: range predicate leads the composite index
CREATE INDEX idx_orders_bad ON orders(created_at, customer_id, status);
-- Query: WHERE customer_id = $1 AND status = 'PENDING'
-- created_at is the leading column. Customer_id is not the leading column.
-- Planner cannot filter by customer_id without first scanning through all created_at entries.
-- Effectively: index unusable for this query pattern. SeqScan or near-full index scan.

-- CORRECT: equality predicates first, then range
CREATE INDEX idx_orders_correct ON orders(customer_id, status, created_at DESC);
-- Query: WHERE customer_id = $1 AND status = 'PENDING' ORDER BY created_at DESC
-- customer_id = equality → narrow to one customer. Status = equality → narrow further.
-- created_at DESC → range scan within that narrow result. Perfect use of composite index.
-- EXPLAIN: Index Scan Backward. No Sort node. Efficient.

-- GENERAL RULE:
-- Equality predicates → leading columns (most selective first).
-- Range predicates or ORDER BY column → trailing columns.
-- Cardinality: higher cardinality (more unique values) columns → earlier in index.
```

### Pattern 2: Building Separate Indexes When One Composite Covers Both

```sql
-- BAD: two separate single-column indexes for a query that filters on both
CREATE INDEX idx_orders_customer ON orders(customer_id);
CREATE INDEX idx_orders_status   ON orders(status);

-- Query: SELECT * FROM orders WHERE customer_id = $1 AND status = 'PENDING'
-- Postgres must choose: Bitmap Index Scan on both → Bitmap AND.
-- Bitmap Index Scan: scans customer_id index → bitmap of 50K rows.
-- Bitmap Index Scan: scans status index → bitmap of 200K rows.
-- BitmapAnd: 50K ∩ 200K = 2K rows. Then heap fetch for each.
-- Total I/O: two full index lookups + heap fetches.

-- CORRECT: one composite index serves the combined predicate directly
CREATE INDEX idx_orders_customer_status ON orders(customer_id, status);
-- Query: WHERE customer_id = $1 AND status = 'PENDING'
-- B-tree descent: customer_id first (32-bit subtree), then status within that subtree.
-- Directly reaches the matching rows. No bitmap intersection overhead.
-- Fewer index pages read. Faster. Lower I/O.

-- WHEN are separate indexes still worth keeping?
-- If customer_id is queried alone AND status alone with high frequency,
-- separate indexes for single-column queries. But add the composite for combined queries.
-- Total: 3 indexes. Acceptable if all 3 query patterns are heavily used.
```

### Pattern 3: Composite Index Not Used Because of Implicit Type Cast

```sql
-- TABLE DEFINITION:
CREATE TABLE sessions (
    id         BIGSERIAL PRIMARY KEY,
    user_id    INT NOT NULL,       -- INT (4-byte integer)
    started_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_sessions_user_started ON sessions(user_id, started_at DESC);

-- BAD: parameter type mismatch forces cast, may prevent index use
-- Application sends user_id as a string (common in ORMs using generic parameter binding):
SELECT * FROM sessions WHERE user_id = '42';
-- PostgreSQL: may cast '42'::text to INT implicitly (varchar → int cast is implicit in PG).
-- In this case: PG is smart enough, still uses the index.
-- BUT for BIGINT vs INT mismatch:
-- If column is BIGINT and you pass INT literal, or vice versa, PG may or may not cast.
-- Always match parameter types to column types at the application layer.

-- ANOTHER CAST PROBLEM: TIMESTAMP vs TIMESTAMPTZ
CREATE TABLE events ( ts TIMESTAMP );  -- no timezone
CREATE INDEX idx_events_ts ON events(ts);
SELECT * FROM events WHERE ts > NOW();
-- NOW() returns TIMESTAMPTZ. Column is TIMESTAMP. Implicit cast required.
-- Cast on the column side (TIMESTAMPTZ → TIMESTAMP): makes index unusable.
-- EXPLAIN: SeqScan. Index bypassed.
-- FIX: use TIMESTAMP explicitly: WHERE ts > NOW()::TIMESTAMP  (casts NOW(), not column)
-- OR: store TIMESTAMPTZ (recommended — always use timezone-aware timestamps).
```

### Pattern 4: Composite Index Where the 4th Column Breaks Economics

```sql
-- BAD: composite index with too many included key columns
CREATE INDEX idx_orders_full ON orders(customer_id, status, created_at, total, item_count);
-- 5-column composite key.
-- Problem 1: index entry size = 8+8+8+8+4 + 20B overhead = ~60B per entry.
-- Problem 2: Planner only uses equality predicates for customer_id + status + maybe created_at range.
--            total and item_count are never WHERE predicates. They waste key space.
-- Problem 3: Larger index = more pages = more I/O for any scan.
-- Problem 4: Every modification to total or item_count updates the index (they're key columns).

-- CORRECT: Key columns only for filtering/sorting. Extra needed columns in INCLUDE:
CREATE INDEX idx_orders_customer_covering ON orders(customer_id, status, created_at DESC)
INCLUDE (total, item_count);
-- Key: (customer_id, status, created_at). Used for B-tree lookup + ORDER BY.
-- Leaf payload: also stores total, item_count. Available in index-only scan.
-- But: updates to total/item_count do NOT maintain them as key columns. Just leaf data updates.
-- Smaller B-tree key = more entries per page = faster traversal.
```

---

## SECTION 6 — Performance Impact

### Composite Index vs Alternatives: Measured Comparison

```
BENCHMARK SETUP: orders table, 50M rows, PostgreSQL 15, r6g.4xlarge.
Query: SELECT id, total, status FROM orders WHERE customer_id = $1 AND status = 'PENDING'
  ORDER BY created_at DESC LIMIT 20;
Customer 42 has ~3,000 pending orders.

Scenario                               | Plan                    | Latency  | Buffer Reads
---------------------------------------|-------------------------|----------|-------------
No index                               | SeqScan                 | 22,000ms | 500,000
customer_id only                       | Index Scan + filter     | 85ms     | 3,200
status only (3 values, useless)        | SeqScan                 | 22,000ms | 500,000
customer_id + status separate          | BitmapAnd               | 18ms     | 1,400
(customer_id, status) composite        | Index Scan              | 3.2ms    | 180
(customer_id, status, created_at DESC) | Index Scan Backward     | 1.1ms    | 22
(above) + INCLUDE(id, total)           | Index-Only Scan         | 0.3ms    | 8

TAKEAWAY:
- Each optimization step: 2x-6x improvement.
- Composite index (3 columns correct order): 20,000x faster than SeqScan.
- Index-Only Scan (covering): another 3.7x on top of composite. 73,000x total.
- Going from 0 indexes → correct composite covering index: 22s → 0.3ms.

SORT ELIMINATION VALUE:

  Every ORDER BY that is NOT satisfied by an index requires an in-memory sort.
  For 3,000 matching rows: sort is trivial (fits in work_mem=4MB easily).
  For 300,000 matching rows (popular customer, long history): sort may spill to disk.

  work_mem: per-sort buffer. Default 4MB. If sort result > 4MB: disk spill (temp files).
  Disk spill indicators:
    EXPLAIN ANALYZE: "Sort Method: external merge Disk: XXXXKB"

  Composite index with trailing ORDER BY column: eliminates sort node entirely.
  Zero work_mem consumption for the sort. Zero disk spill risk.
  For high-row-count queries: this is often more impactful than the index lookup itself.

INDEX SIZE COMPARISON:

  Index type                                     | Rows  | Approximate Size
  -----------------------------------------------|-------|------------------
  Single (customer_id BIGINT)                    | 50M   | 1.1GB
  Composite (customer_id, status VARCHAR10)      | 50M   | 1.8GB
  Composite (customer_id, status, created_at)    | 50M   | 2.5GB
  + INCLUDE(id, total)                           | 50M   | 2.9GB
  Partial composite (WHERE status='PENDING', 2%) | 1M    | 52MB

  Partial composite for PENDING orders: 48x smaller than full composite.
  If PENDING query is the only frequent access pattern: partial is optimal.
```

---

## SECTION 7 — Concurrency & Data Integrity

### Writes to Composite Indexed Tables

```
WHAT WRITES TOUCH THE COMPOSITE INDEX:

  For index (customer_id, status, created_at DESC) INCLUDE (total):

  INSERT: always updates the composite index. New leaf entry added.
          Cost: ~3-4 B-tree page reads (descent) + 1 leaf write + possible page split.

  UPDATE customer_id: updates index (column is a key). Old entry removed, new entry added.
                       Two leaf-page writes. May cause splits on both old and new leaf.

  UPDATE status: same as above. Key column changed.

  UPDATE created_at: same. Key column.

  UPDATE total: updates ONLY the leaf page payload (INCLUDE column). No key change.
                Cheaper: no tree re-balancing. Just leaf page write.

  UPDATE item_count (not in index): HOT update possible if on same heap page.
                                     Zero index writes. Most efficient.

  DELETE: marks heap row dead. Composite index entry: deferred removal by VACUUM.
           No immediate index write on DELETE.

  PRACTICAL IMPACT:
  For a table where customer_id and status change frequently (orders moving PENDING→SHIPPED→DELIVERED):
    Each status UPDATE: removes old index entry + inserts new index entry.
    At 10K status updates/second: 20K index page writes/second for this one composite index.
    Monitoring: pg_stat_bgwriter.buffers_alloc spike → index/heap write pressure.
    Mitigation: consider FILLFACTOR=80 on index to reduce page splits.

INDEX INTEGRITY UNDER CRASH:

  WAL protects both heap AND index changes atomically.
  If the server crashes mid-INSERT (after heap write, before index write):
    On recovery: WAL replays BOTH heap write AND index write.
    Result: index is always consistent with heap data after crash recovery.

  SCENARIO: CREATE INDEX CONCURRENTLY is interrupted by crash.
    The index remains but is marked INVALID in pg_index.indisvalid = false.
    Queries: planner ignores INVALID indexes. Data integrity maintained.
    Fix: DROP INDEX CONCURRENTLY idx_name; then recreate.
    No data corruption. Only the index metadata is invalid. Heap data intact.

  CONCURRENT SCAN + WRITE CONSISTENCY:
    Long-running SELECT on orders (full table scan for analytics) + concurrent INSERTs.
    The SELECT holds a snapshot from its start time (MVCC).
    New rows inserted after snapshot: invisible to this SELECT. Consistent view.
    No blocking between concurrent reads and concurrent writes (MVCC).
    Index updated by INSERT but not visible to current readers. Correct.
```

---

## SECTION 8 — Optimization & Indexing

### Composite Index Discovery and Tuning Tools

```
FINDING COMPOSITE INDEX CANDIDATES WITH pg_stat_statements:

  -- Find expensive queries + their filter columns → build composite index candidates
  SELECT query, calls, mean_exec_time, rows
  FROM pg_stat_statements
  WHERE mean_exec_time > 20   -- >20ms average
    AND query LIKE '%orders%'
  ORDER BY mean_exec_time DESC
  LIMIT 10;

  -- Take the slow query text → EXPLAIN ANALYZE → find SeqScan + filter columns.
  -- Check: are the filter columns all single-column indexes? → Merge into composite.

  EXPLAIN (ANALYZE, BUFFERS)
  SELECT * FROM orders
  WHERE customer_id = 42 AND status = 'PENDING'
  ORDER BY created_at DESC LIMIT 20;

  -- Look for: "Filter: ..." lines under a Seq Scan (shows columns being filtered post-scan)
  -- Those filter columns + ORDER BY column → composite index candidate.

HYPOPG: WHAT-IF INDEX ANALYSIS:

  hypopg is a PostgreSQL extension for testing hypothetical indexes without creating them.
  Useful for: validating that a proposed composite index would actually be used.

  -- Install (available in RDS/Aurora via CREATE EXTENSION):
  CREATE EXTENSION hypopg;

  -- Create a hypothetical index (doesn't exist on disk, zero write impact):
  SELECT hypopg_create_index('CREATE INDEX ON orders(customer_id, status, created_at DESC)');

  -- Test query against the hypothetical index:
  EXPLAIN SELECT * FROM orders
  WHERE customer_id = 42 AND status = 'PENDING' ORDER BY created_at DESC LIMIT 20;
  -- → Shows the plan WITH the hypothetical index. If it uses it: safe to create for real.

  -- Clean up hypothetical indexes:
  SELECT hypopg_reset();

  USE CASES:
    1. Validate index choice before paying creation cost (10-30 min for large tables).
    2. A/B test (customer_id, status) vs (status, customer_id) ordering.
    3. Convince the team the index will help before scheduling the maintenance window.

COMPOSITE INDEX CONSOLIDATION ANALYSIS:

  -- Find tables with multiple single-column indexes that could be merged into composite:
  SELECT
    t.relname AS table,
    array_agg(i.indexrelname ORDER BY i.idx_scan DESC) AS indexes,
    array_agg(pg_size_pretty(pg_relation_size(i.indexrelid)) ORDER BY i.idx_scan DESC) AS sizes,
    array_agg(i.idx_scan ORDER BY i.idx_scan DESC) AS scans
  FROM pg_stat_user_indexes i
  JOIN pg_stat_user_tables t ON i.relid = t.relid
  WHERE i.schemaname = 'public'
  GROUP BY t.relname
  HAVING COUNT(*) > 4  -- tables with more than 4 indexes → consolidation candidates
  ORDER BY COUNT(*) DESC;

  -- For each identified table: run EXPLAIN on your top 5 queries.
  -- Find queries that use BitmapAnd (two Bitmap Index Scans merged).
  -- BitmapAnd = strong signal: those two index columns should be a composite.
  -- Replace two single-column indexes + BitmapAnd with one composite. Drop the singles.

MAINTAINING INDEX HEALTH LONG-TERM:

  -- Weekly: check index scan counts (zero-scan indexes to DROP)
  SELECT indexrelname, idx_scan, pg_size_pretty(pg_relation_size(indexrelid)) AS size
  FROM pg_stat_user_indexes
  WHERE schemaname = 'public'
    AND idx_scan = 0
    AND indexrelname NOT LIKE '%pkey'   -- keep primary key
  ORDER BY pg_relation_size(indexrelid) DESC;

  -- Monthly: check index bloat
  SELECT indexrelname, pg_size_pretty(pg_relation_size(indexrelid)) AS current_size
  FROM pg_stat_user_indexes
  WHERE schemaname = 'public'
  ORDER BY pg_relation_size(indexrelid) DESC;
  -- Compare to expected size based on row count.
  -- > 2x expected: REINDEX CONCURRENTLY.

  -- After access pattern changes (new features, query rewrites):
  -- Re-run pg_stat_statements analysis. Access profile may have shifted.
  -- Indexes built for old patterns may be obsolete. New patterns may need new composites.
  -- Index strategy: not a one-time task. Ongoing maintenance discipline.
```
