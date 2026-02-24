# B-Tree Index — Part 2 of 3

### Sections: 5 (Bad vs Correct), 6 (Performance Impact), 7 (Concurrency & Data Integrity), 8 (Optimization & Indexing)

**Series:** Databases & Data Modeling → Topic 12

---

## SECTION 5 — Bad Usage vs Correct Usage

### Pattern 1: Redundant Index Duplicating the Primary Key Prefix

```sql
-- BAD: creates a separate index that overlaps with the PK
CREATE TABLE orders (
    id          BIGSERIAL PRIMARY KEY,   -- PK index: B-tree on (id)
    customer_id BIGINT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_orders_id ON orders(id);  -- REDUNDANT. Already indexed by PK.

-- Any query on WHERE id = $1 uses the PK index. The new index never used by planner.
-- SELECT pg_stat_user_indexes WHERE indexrelname = 'idx_orders_id';
-- idx_scan = 0 forever. Wastes disk. Wastes write overhead. Provides zero benefit.

-- CORRECT: drop truly redundant indexes. Trust the PK.
DROP INDEX CONCURRENTLY idx_orders_id;
```

### Pattern 2: Index on Every Column "For Safety"

```sql
-- BAD: indexing every column anticipating "maybe we'll query by it"
CREATE TABLE events (
    id         BIGSERIAL PRIMARY KEY,
    user_id    BIGINT,
    session_id UUID,
    event_type VARCHAR(50),
    page_url   TEXT,
    referrer   TEXT,
    ip_address INET,
    created_at TIMESTAMPTZ,
    payload    JSONB
);
CREATE INDEX idx_events_user_id    ON events(user_id);
CREATE INDEX idx_events_session_id ON events(session_id);
CREATE INDEX idx_events_type       ON events(event_type);
CREATE INDEX idx_events_page_url   ON events(page_url);
CREATE INDEX idx_events_referrer   ON events(referrer);
CREATE INDEX idx_events_ip         ON events(ip_address);
CREATE INDEX idx_events_created_at ON events(created_at);
-- 7 non-PK indexes on a 500M-row insert-heavy events table.
-- Each INSERT: 7 × B-tree updates. Every insert costs 8x the baseline.
-- Most of these: idx_scan = 0, 1, or a handful after months of queries.

-- CORRECT: index only what your actual queries need.
-- Identify slow queries first with pg_stat_statements.
-- Create targeted composites rather than individual single-column indexes.
-- Right-size to 1-3 well-chosen indexes for most tables.
CREATE INDEX idx_events_user_created ON events(user_id, created_at DESC) INCLUDE (event_type);
-- One index covers: WHERE user_id = $1 ORDER BY created_at DESC + SELECT event_type.
-- Replaces: idx_events_user_id + idx_events_created_at for the primary access pattern.
```

### Pattern 3: Index on Expression Without a Matching Functional Index

```sql
-- BAD: query uses an expression on a column. Raw column index is bypassed.
CREATE INDEX idx_users_email ON users(email);      -- indexes raw email

SELECT * FROM users WHERE UPPER(email) = UPPER($1);  -- wraps email in UPPER()
-- Index: contains 'alice@corp.com'. UPPER('alice@corp.com') = 'ALICE@CORP.COM'.
-- The planner looks for an index on UPPER(email). Not found. SeqScan.

-- CORRECT option A: normalize data on write, query on normalized column
-- Store email always lowercased at INSERT time (application responsibility + CHECK):
ALTER TABLE users ADD CONSTRAINT email_lowercase CHECK (email = LOWER(email));
-- Then query: WHERE email = LOWER($1). Uses index on raw email. Clean.

-- CORRECT option B: functional index matching the expression
CREATE INDEX idx_users_email_upper ON users(UPPER(email));
SELECT * FROM users WHERE UPPER(email) = UPPER($1);
-- Planner matches UPPER(email) in query to UPPER(email) in index. Uses the index.
-- Caveat: two indexes on email (raw) and (UPPER). Double write cost.
-- Choose based on which query form you control.
```

### Pattern 4: Creating Index During Peak Traffic

```sql
-- BAD: CREATE INDEX without CONCURRENTLY during business hours
-- 14:30 Tuesday. Engineering deploys migration:
CREATE INDEX idx_payments_status ON payments(status);
-- Acquires ShareLock. Duration: 12 minutes (80M rows).
-- All writes to payments table: BLOCKED for 12 minutes.
-- Checkout, payment processing, refunds: all halted.
-- Incident triggered. Rollback: DROP INDEX. All wasted.

-- CORRECT: always CONCURRENTLY on live tables, plus schedule during low-traffic windows
-- 02:00 Sunday:
CREATE INDEX CONCURRENTLY idx_payments_status ON payments(status);
-- No blocking. Index builds in background over 20-25 minutes. Writes continue.

-- If CONCURRENTLY build is interrupted (network timeout, kill signal):
-- Check for INVALID index:
SELECT indexname, pg_index.indisvalid
FROM pg_indexes
JOIN pg_class ON indexname = pg_class.relname
JOIN pg_index ON pg_class.oid = pg_index.indexrelid
WHERE NOT pg_index.indisvalid;
-- Drop invalid index and recreate:
DROP INDEX CONCURRENTLY idx_payments_status;
CREATE INDEX CONCURRENTLY idx_payments_status ON payments(status);
```

---

## SECTION 6 — Performance Impact

### B-Tree Index Size and Cost Model

```
INDEX SIZE MATH:

For a B-tree index on a BIGINT column:
  - Each key entry: 8 bytes (BIGINT) + 6 bytes (item pointer) = 14 bytes.
  - Page size: 8192 bytes. Header: ~24 bytes. Usable: ~8,168 bytes.
  - Entries per leaf page: 8,168 / 14 ≈ 583 entries. (Approximate; actual ~455 with overhead.)
  - 100M rows: 100M / 455 ≈ 220,000 leaf pages = ~1.7GB.
  - Branch pages: tiny fraction. B-tree height: 3 levels.

For a VARCHAR(100) column:
  - Average entry: 50 bytes + 6 bytes = 56 bytes.
  - Entries per page: 8,168 / 56 ≈ 146 entries.
  - 100M rows: ~685,000 leaf pages = ~5.5GB.
  - B-tree height: 3-4 levels.

INDEX FILLFACTOR IMPACT:

  Default FILLFACTOR: 90% (10% free space on each leaf page for later inserts).

  Random INSERT distribution (e.g., UUIDs as PK):
    Each new row may land on ANY existing leaf page (random key).
    Existing pages may be full → page split → two half-full pages.
    Page splits propagate to parent: can cascade up the tree.
    With FILLFACTOR=90: 10% buffer space helps absorb inserts before splitting.
    With FILLFACTOR=50: 50% free space per page. More splits deferred. Larger index size.

  Monotonically increasing PK (BIGINT GENERATED ALWAYS AS IDENTITY):
    New rows always go to the RIGHTMOST leaf page.
    No random splits. Only the last page grows. Very efficient.
    FILLFACTOR: can be 100% if only appending. But updates/deletes on existing rows still occur.
    Practical recommendation: leave at 90% (default). Fine for most PK types.

BENCHMARK: B-tree Index Performance Across Table Sizes

Table: users, email VARCHAR (avg 40B), random email values.

Rows      | Index Size | Height | Point Lookup | Range (1% rows)
----------|-----------|--------|--------------|----------------
100K      | 4MB       | 2      | 0.05ms       | 0.2ms (SeqScan wins here)
1M        | 40MB      | 3      | 0.08ms       | 0.9ms
10M       | 400MB     | 3      | 0.10ms       | 7ms
100M      | 4GB       | 3      | 0.15ms       | 45ms
1B        | 40GB      | 4      | 0.20ms       | 350ms

Key insight: index lookup latency scales logarithmically (O(log N)).
Increase from 1M to 1B rows: 1000x more data → 2.5x more latency (one extra tree level).
B-tree is extremely efficient even at billion-row scale.

WRITE AMPLIFICATION BENCHMARK:

PostgreSQL 15, r6g.4xlarge, NVMe SSD.
INSERT 10M rows:

Indexes per table | Total INSERT Time | Rate      | Index overhead
------------------|-------------------|-----------|----------------
1 (PK only)       | 18s               | 556K/s    | baseline
2 (+1 BIGINT idx) | 23s               | 435K/s    | +27%
4 (+3 more)       | 38s               | 263K/s    | +111%
8 (+7 more)       | 72s               | 139K/s    | +300%
12 (+11 more)     | 112s              | 89K/s     | +526%

Each additional index adds roughly linear write overhead once past 4 indexes.
```

---

## SECTION 7 — Concurrency & Data Integrity

### Index Creation Locking and Visibility Map

```
INDEX CREATION LOCK MODES:

  CREATE INDEX (non-concurrent):
    Lock: ShareLock on the table.
    Blocked by: concurrent DML (INSERT/UPDATE/DELETE) → waits for them to finish first.
    Blocks: subsequent DML (all writes wait behind this DDL).
    Duration: held for the entire index build duration.
    Use: only in maintenance windows. Never on production tables with live traffic.

  CREATE INDEX CONCURRENTLY:
    Phase 1: Acquires ShareUpdateExclusiveLock briefly to register the index in the catalog.
             Takes a snapshot. Scans table. Builds initial index on existing rows.
    Phase 2: Processes changes made during Phase 1 (from WAL). Applies them to index.
    Phase 3: Final cleanup. Marks index valid.
    Total: 2-3x longer than non-concurrent. But never blocks DML.
    Limitation: Cannot run inside a transaction block (BEGIN/COMMIT).

  REINDEX (non-concurrent):
    Lock: AccessExclusiveLock. Blocks everything (reads + writes).
    Use case: after major bloat (pg_relation_size(index) >> expected).
    Never use in production without downtime.

  REINDEX CONCURRENTLY (Postgres 12+):
    Builds a replacement index under ShareUpdateExclusiveLock.
    Old index remains active and valid during rebuild.
    When complete: atomic swap.
    On failure: leaves a second (INVALID) index. Drop the INVALID one.

    REINDEX INDEX CONCURRENTLY idx_orders_customer;
    -- Safe for production. No downtime. Some performance overhead during rebuild.

VISIBILITY MAP AND INDEX-ONLY SCANS:

  Index-Only Scan: retrieves data from the index without touching the heap.
  Requires: all queried columns in the index (covering) AND visibility map page bit = 1.

  Visibility map: per-page bitmap. Bit = 1: all rows on this page are visible to all transactions.
  After a page is VACUUMed and has no dead tuples: bit set to 1.

  Under heavy write load:
    Each UPDATE/DELETE clears the visibility map bit for the modified page.
    Index-Only Scans fall back to heap fetch for those pages.
    High-write table: most pages have visibility map bit = 0 → many heap fetches → Index Scan, not Index-Only Scan.

  Tuning: aggressive VACUUM keeps visibility map bits set:
    ALTER TABLE orders SET (autovacuum_vacuum_cost_delay = 2);  -- ms between vacuum bursts. Default 20ms.
    Lower delay: faster VACUUM, more I/O. Faster visibility map updates. More Index-Only Scan eligibility.

  Monitoring:
    SELECT heap_blks_read, idx_blks_hit, heap_blks_hit, idx_blks_read
    FROM pg_statio_user_tables
    WHERE relname = 'orders';
    -- idx_blks_hit high + heap_blks_read low → efficient index-only scan pattern.
    -- heap_blks_read high → VACUUM falling behind, heap fetches happening.
```

---

## SECTION 8 — Optimization & Indexing

### Advanced B-Tree Tuning Techniques

```
COVERING INDEX WITH INCLUDE (Postgres 11+):

  Problem: Composite index (customer_id, created_at) satisfies WHERE + ORDER BY.
  But: SELECT also needs id, total, status. Heap fetch required for each row.

  Solution: INCLUDE adds extra columns to the leaf page (not part of tree key).

  CREATE INDEX idx_orders_customer_covering
  ON orders(customer_id, created_at DESC)
  INCLUDE (id, total, status);

  Effect:
    B-tree key: (customer_id, created_at DESC). Used for lookup and range scan.
    Leaf page payload: also stores id, total, status. No heap fetch needed.
    Index-only scan: WHERE customer_id=$1 ORDER BY created_at DESC → INCLUDE columns satisfy SELECT.

  Size tradeoff: larger index (more bytes per leaf entry). Worth it for high-frequency queries.

  INCLUDE columns: NOT usable in WHERE filters. Not part of sort key.
  Wrong: WHERE status = 'PAID' AND customer_id = $1 — status in INCLUDE is NOT filtered.
  Right: WHERE customer_id = $1 ORDER BY created_at DESC → returns status from INCLUDE.

PARTIAL INDEX (Filter Rarely-Needed Rows Out of Index):

  CREATE INDEX idx_orders_pending ON orders(created_at DESC)
  WHERE status = 'PENDING';

  Effect: index contains ONLY pending orders.
  If 2% of orders are PENDING (vs 98% COMPLETED/CANCELLED):
    Full index: 50M rows → ~4GB.
    Partial index: 1M rows → ~80MB. 50x smaller.
    Planner: uses this index when query includes WHERE status = 'PENDING'.
    Write overhead: only INSERT/UPDATE of PENDING rows touches this index. 98% of writes skip it.

  Critical: query MUST include the partial index predicate WHERE status = 'PENDING'.
  Index: never used for WHERE status = 'COMPLETED'. Correct behavior.

BLOOM FILTER / HASH INDEX ALTERNATIVES:

  Hash Index (Postgres 10+ crash-safe):
  CREATE INDEX idx_events_session_hash ON events USING HASH (session_id);
  USE CASE: equality-only lookups on high-cardinality UUID columns.
  ADVANTAGE: smaller than B-tree (no key ordering overhead). Faster for = lookups.
  DISADVANTAGE: no range queries, no ORDER BY, no composite support.
  BENCHMARK: 30% smaller than B-tree on UUID column. Equality lookup: 15% faster.
  VERDICT: Niche. Use only for pure = lookup on high-cardinality non-range columns.

  BRIN Index (Block Range INdex):
  CREATE INDEX idx_events_created_brin ON events USING BRIN (created_at);
  USE CASE: very large tables (100M+ rows) where data is physically sorted (append-only logs).
  ADVANTAGE: ~10KB for any size table. Minimal write overhead. Near-zero size.
  DISADVANTAGE: Only useful if data is physically sorted by the index column.
    If created_at is not correlated with physical order: BRIN does nothing useful.
    For events table (append-only, created_at monotonically increases): perfect.
  BENCHMARK: 2KB BRIN index on 100M row events table. Replaces 1.7GB B-tree.
    Lookup: 50ms (not as fast as B-tree 0.15ms). Acceptable for analytics. Not for OLTP.

  MAINTENANCE QUERY:
  -- Index size vs table size ratio:
  SELECT relname, pg_size_pretty(pg_relation_size(relid)) AS table_size,
         string_agg(indexrelname || ': ' || pg_size_pretty(pg_relation_size(indexrelid)), ', ') AS indexes
  FROM pg_stat_user_indexes
  JOIN pg_stat_user_tables USING (relid, schemaname)
  WHERE schemaname = 'public'
  GROUP BY relname, relid
  ORDER BY pg_relation_size(relid) DESC;
```
