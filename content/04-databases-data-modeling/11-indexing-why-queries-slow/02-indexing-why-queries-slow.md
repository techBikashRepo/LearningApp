# Indexing — Why Queries Are Slow — Part 2 of 3

### Sections: 5 (Bad vs Correct), 6 (Performance Impact), 7 (Concurrency & Data Integrity), 8 (Optimization & Indexing)

**Series:** Databases & Data Modeling → Topic 11

---

## SECTION 5 — Bad Usage vs Correct Usage

### Pattern 1: Not Using CONCURRENTLY on Production Index Creation

```sql
-- BAD: creates index without CONCURRENTLY on a production table
CREATE INDEX idx_orders_customer ON orders(customer_id);
-- This acquires: ShareLock on the orders table.
-- ShareLock: blocks all INSERTs, UPDATEs, DELETEs on orders until index creation completes.
-- For a 200M row table: index creation takes 5-15 minutes.
-- During those 5-15 minutes: all write operations on orders are BLOCKED.
-- Result: production outage for your entire checkout flow.

-- CORRECT: CONCURRENTLY builds the index in the background without blocking writes
CREATE INDEX CONCURRENTLY idx_orders_customer ON orders(customer_id);
-- ShareUpdateExclusiveLock: allows concurrent reads AND writes during index creation.
-- Builds index in two or more passes. Takes 2-3x longer than non-concurrent.
-- Does NOT block in-flight write operations.
-- Cannot be run inside a transaction block (BEGIN/COMMIT).
-- If interrupted: leaves an INVALID index. Must DROP and recreate.
-- Check: SELECT indexname, indisvalid FROM pg_indexes WHERE indisvalid = FALSE;
```

### Pattern 2: Index on a Non-Sargable Expression (Index Cannot Be Used)

```sql
-- BAD: function wrapped around the indexed column — index unusable
SELECT * FROM events WHERE DATE(created_at) = '2024-03-15';
-- DATE(created_at) applies a transformation to the column.
-- The index on created_at stores raw TIMESTAMPTZ values, not DATE values.
-- The planner cannot use the index. SeqScan on 500M rows. 45 seconds.

-- CORRECT: use a RANGE predicate on the raw column (SARGABLE)
SELECT * FROM events WHERE created_at >= '2024-03-15' AND created_at < '2024-03-16';
-- The index on created_at covers this range. B-tree range scan. Milliseconds.

-- OR create a functional index on the expression:
CREATE INDEX idx_events_date ON events(DATE(created_at));
SELECT * FROM events WHERE DATE(created_at) = '2024-03-15';
-- Now the function matches the index expression. Planner can use it.
-- Trade-off: additional index maintained on every insert. Only useful if DATE() query is common.
```

### Pattern 3: Index Created but Never Used (Statistics Problem)

```sql
-- SETUP: events table, 50M rows. Index on user_id. Query runs fine for months.
-- After a large batch import: statistics become stale. Planner switches to SeqScan.

-- CHECK: are statistics current?
SELECT relname, last_analyze, last_autoanalyze
FROM pg_stat_user_tables
WHERE relname = 'events';
-- last_analyze: 2 weeks ago! 50M new rows imported since then. Stats are stale.

-- PLANNER ESTIMATE vs ACTUAL:
EXPLAIN (ANALYZE) SELECT * FROM events WHERE user_id = 42;
-- Estimated rows: 5 (from stale stats).
-- Actual rows: 185,000 (user 42 has been active for 2 years).
-- Planner chose Nested Loop based on 5-row estimate. Wrong plan.

-- FIX: update statistics
ANALYZE events;  -- or VACUUM ANALYZE events; (also reclaims dead tuples)

-- VERIFY:
EXPLAIN (ANALYZE) SELECT * FROM events WHERE user_id = 42;
-- Now: correct row estimate. Planner selects appropriate plan.

-- LONG-TERM: for large tables with fast-growing data, increase autovacuum frequency:
ALTER TABLE events SET (autovacuum_analyze_scale_factor = 0.01);  -- trigger at 1% change (default 20%)
```

### Pattern 4: SELECT \* Defeating Index-Only Scan

```sql
-- BAD: SELECT * forces heap fetch even when index has all needed data
SELECT * FROM orders WHERE customer_id = 42 ORDER BY created_at DESC LIMIT 20;
-- Index: (customer_id, created_at). Contains customer_id and created_at.
-- ORDER BY: covered. WHERE: covered. But SELECT *: needs total, status, item_count from heap.
-- Result: Heap fetches for 20 rows. Acceptable but misses optimization.

-- CORRECT for frequently-run, latency-sensitive endpoints: covering index
CREATE INDEX idx_orders_customer_covering
ON orders(customer_id, created_at DESC)
INCLUDE (id, status, total);  -- INCLUDE: store extra columns in leaf, not in tree key
-- Now: SELECT id, status, total, created_at WHERE customer_id=42 ORDER BY created_at DESC LIMIT 20
-- → Index-Only Scan. Zero heap fetches (unless visibility map not set — VACUUM addresses this).

-- INCLUDE vs composite key:
-- INCLUDE columns: stored in leaf pages only. Not part of the tree key. Cannot be filtered by.
-- Composite key columns: part of the sort key. Can be filtered AND sorted by.
-- Use INCLUDE for columns you SELECT but don't filter or sort by.
```

---

## SECTION 6 — Performance Impact

### Index Impact Quantified

```
BENCHMARK: Single-Column Equality Lookup

Table: users, 10M rows, 8KB pages, email VARCHAR(80) avg.
Average page: ~50 rows per page → 200,000 heap pages.

                     | No Index      | With B-tree Index
---------------------|---------------|-------------------
Buffer reads         | 200,000       | 4-5
I/O at 100MB/s       | ~16 seconds   | ~0.4ms
CPU (rows evaluated) | 10,000,000    | 1
Response time        | 14,200ms      | 0.3ms
Improvement          | baseline      | 47,333x

BENCHMARK: Range Query (30-day window)

Table: events, 500M rows. Matching rows: 2.5M (0.5% of table).

                     | No Index      | With B-tree Index (Bitmap Scan)
---------------------|---------------|--------------------------------
Buffer reads         | 800,000       | ~12,500 (index) + ~2,500 (heap)
I/O time             | 64 seconds    | 1.2 seconds
Improvement          | baseline      | 53x

BENCHMARK: ORDER BY + LIMIT (Pagination)

Table: orders, 50M rows. LIMIT 20.

Query: SELECT * FROM orders ORDER BY created_at DESC LIMIT 20;

                     | No Index      | With index on created_at DESC
---------------------|---------------|------------------------------
Plan                 | Sort → SeqScan| Index Scan Backward
Rows examined        | 50,000,000    | 20
Buffer reads         | 500,000       | 5
I/O time             | 40 seconds    | < 1ms
Improvement          | baseline      | 40,000x+

INDEX CREATION PERFORMANCE IMPACT:

  Creating an index on a large table is itself a significant operation.
  CREATE INDEX CONCURRENTLY on 500M-row events table:
    Duration: 15-25 minutes.
    CPU: single-threaded by default. Saturates one core.
    Disk: sequential read of entire table (to build the index). ~20-40GB read at 500MB/s.
    Disk writes: new index pages. ~8-15GB for a BIGINT column.
    I/O impact on other queries: shared buffer contention. Some query slow-down expected.
    Memory: maintenance_work_mem governs sort buffer for index build. Default 64MB. For large tables:
      SET maintenance_work_mem = '1GB'; before CREATE INDEX CONCURRENTLY → fewer sort passes → faster.
```

---

## SECTION 7 — Concurrency & Data Integrity

### Index Locking and Write Path

```
INDEX LOCK MODES DURING WRITE OPERATIONS:

  INSERT: acquires RowExclusiveLock on heap table + RowExclusiveLock on each index.
  Does NOT block: other INSERTs, SELECTs. Does block: VACUUM, DDL operations.

  UPDATE (non-HOT): same as INSERT. New row version written to heap + new index entries.
  UPDATE (HOT): no index lock needed if updated column is not indexed. Faster path.

  DELETE: marks heap row as dead. Index entries not immediately removed.
  Lock: RowExclusiveLock on heap. Index entries: deferred to VACUUM cleanup.

  DDL (CREATE INDEX): ShareLock (non-CONCURRENTLY) or ShareUpdateExclusiveLock (CONCURRENTLY).
  ShareLock: blocks INSERTs/UPDATEs/DELETEs on the table.
  ShareUpdateExclusiveLock: does NOT block I/U/D. Allows concurrent DML.

INDEX AND VACUUM INTERACTION:

  Dead tuples accumulate in the heap and the associated indexes.
  Dead index entries: point to dead heap rows. Still occupy B-tree leaf pages.

  High-update scenario (e.g., order status updates at 10K/second):
    Each UPDATE creates a dead old version + new version in heap.
    Index: gets a new leaf entry for the new version. Old entry: remains until VACUUM.

  Without adequate VACUUM:
    Index grows: bloated with dead entries → more pages → slower scans.
    Heap grows: bloated with dead rows → more pages → slower SeqScans.
    Table bloat diagnostic:
      SELECT relname, n_dead_tup, n_live_tup,
             n_dead_tup::float / NULLIF(n_live_tup + n_dead_tup, 0) AS bloat_ratio
      FROM pg_stat_user_tables
      WHERE relname = 'orders';
    bloat_ratio > 0.2 (20% dead rows): trigger manual VACUUM or tune autovacuum settings.

  AUTOVACUUM TUNING for high-write tables:
    Default: autovacuum triggers when 20% of rows are modified. Too slow for large tables.
    Large orders table (50M rows): 20% = 10M rows changed before autovacuum starts.
    Fix: lower threshold for specific table:
      ALTER TABLE orders SET (
        autovacuum_vacuum_scale_factor = 0.02,   -- trigger at 2% change (1M rows)
        autovacuum_analyze_scale_factor = 0.01   -- analyze at 1% (500K rows)
      );

INDEX ACCESS PATTERNS AND BUFFER CONTENTION:

  High-concurrency read scenario: 5,000 concurrent requests all hitting the same index.
  B-tree root page: accessed by ALL lookups. High contention on this page.
  Postgres: uses lightweight locks (LWLocks) on pages. Not row-level. Brief.
  Root page LWLock: held for microseconds per access. At 5,000 req/sec: 5,000 × microseconds.
  In practice: Postgres handles this efficiently. B-tree root LWLock contention rarely a bottleneck.

  WHERE it becomes a bottleneck: heavy index INSERT into a sequential or HOT index (UUID in InnoDB).
  Random inserts → many different leaf pages need locks → more contention spread across pages,
  but also more cache misses (the random leaf page may not be in shared_buffers).
```

---

## SECTION 8 — Optimization & Indexing

### Building the Right Index for the Right Query

```
IDENTIFYING MISSING INDEXES:

  Method 1: pg_stat_user_tables (sequential scan monitor)
  SELECT relname, seq_scan, idx_scan,
         seq_scan::float / NULLIF(idx_scan + seq_scan, 0) AS pct_seq
  FROM pg_stat_user_tables
  WHERE relname NOT LIKE 'pg_%'
    AND seq_scan + idx_scan > 1000   -- active tables only
    AND seq_scan::float / NULLIF(idx_scan + seq_scan, 0) > 0.5  -- > 50% seq scans
  ORDER BY seq_scan DESC;
  -- High pct_seq on a large, frequently-accessed table → missing index candidate.

  Method 2: pg_stat_statements (slow query analysis)
  SELECT query, calls, mean_exec_time, total_exec_time,
         total_exec_time / calls AS avg_ms
  FROM pg_stat_statements
  WHERE mean_exec_time > 50    -- > 50ms average
  ORDER BY total_exec_time DESC
  LIMIT 20;
  -- Top time consumers → EXPLAIN each to identify SeqScans on large tables.

  Method 3: auto_explain (log slow query plans)
  -- In postgresql.conf or RDS parameter group:
  shared_preload_libraries = 'auto_explain'
  auto_explain.log_min_duration = 1000   -- log queries > 1 second
  auto_explain.log_analyze = on          -- include ANALYZE output (runtime stats)
  -- Slow query plans automatically logged. No manual EXPLAIN needed.

INDEX SELECTION STRATEGY:

  Step 1: Identify the slow query.
  Step 2: EXPLAIN (ANALYZE, BUFFERS) → find SeqScan on large table.
  Step 3: Identify the WHERE columns. Check cardinality (n_distinct from pg_stats).
  Step 4: Build composite index with equality columns first, range columns last.
  Step 5: Consider INCLUDE for covering index if SELECT columns are few and stable.
  Step 6: CREATE INDEX CONCURRENTLY in production (never without CONCURRENTLY on live tables).
  Step 7: EXPLAIN again. Confirm planner uses the new index.
  Step 8: Monitor pg_stat_user_indexes for idx_scan > 0. Confirm real-world usage.
  Step 9: After 30 days, re-check. If idx_scan = 0: DROP it (write cost not being recouped).

PARTIAL INDEX STRATEGY:

  Scenario: 99% of queries on orders filter by status = 'PENDING'.
  Full index on status: low cardinality → planner often ignores it.

  CREATE INDEX idx_orders_pending ON orders(created_at)
  WHERE status = 'PENDING';
  -- Only PENDING orders indexed. Fast because: 2%  of all orders (small, highly selective).
  -- Query: SELECT ... FROM orders WHERE status = 'PENDING' AND created_at > NOW() - INTERVAL '7 days';
  -- → Uses this partial index. Planner can see the index predicate + query predicate match.
  -- Result: 100x smaller index than full composite. Index-only scan possible.

  DROP unused full index to reclaim write overhead:
  DROP INDEX CONCURRENTLY idx_orders_status;  -- if it was low-cardinality and unused

INDEX MONITORING DASHBOARD QUERY:
  SELECT
    t.relname              AS table,
    ix.indexrelname        AS index,
    ix.idx_scan            AS scans,
    pg_size_pretty(pg_relation_size(ix.indexrelid)) AS size,
    CASE WHEN ix.idx_scan = 0 THEN 'CANDIDATE FOR DROP' ELSE 'ACTIVE' END AS status
  FROM pg_stat_user_indexes ix
  JOIN pg_stat_user_tables t ON ix.relid = t.relid
  WHERE t.schemaname = 'public'
  ORDER BY pg_relation_size(ix.indexrelid) DESC;
  -- Shows: every index, its scan count, size, and drop candidacy.
  -- Run after 30+ days of production traffic for meaningful result.
```
