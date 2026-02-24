# When NOT to Index — Part 1 of 3

### Sections: 1 (Intuition), 2 (Why It Exists), 3 (Internal Working), 4 (Query Execution Flow)

**Series:** Databases & Data Modeling → Topic 14

---

## SECTION 1 — The Intuition

### Mental Model: Over-Indexing as Over-Cataloging a Warehouse

```
An index speeds up reads by maintaining a sorted, searchable structure on the side.
But every index is also a maintenance contract: every INSERT, UPDATE, DELETE must
update every index on the table. More indexes = more work per write. Always.

ANALOGY: Warehouse inventory catalog system.

A warehouse receives 10,000 new products (boxes) every day.
Management decides to maintain catalogs sorting products by:
  - Product ID (necessary: primary search key)
  - Color
  - Weight
  - Country of origin
  - Manufacturer
  - Fragility rating
  - Packaging material
  - Shelf life
  - Supplier ID
  - Product category

Every time a box arrives: a worker must add an entry to all 10 catalogs simultaneously.
Every time a box is moved: update all 10 catalogs.
Every time a box ships: remove from all 10 catalogs.

Result: workers spend more time updating catalogs than actually moving boxes.
Most catalogs: never consulted. The product ID catalog: used 1,000 times/day.
The "fragility rating" catalog: used once per quarter.

THE KEY INSIGHT:
  Every index is ALWAYS paid for at write time.
  Every index is ONLY paid back at read time.
  An index on a column never queried: costs writes, returns nothing.

THE FIVE SITUATIONS WHERE INDEXES HURT MORE THAN THEY HELP:
  1. Low-cardinality columns (e.g., status with 3 values): index not selective enough.
  2. Small tables (<1,000-8,000 rows): SeqScan faster than index overhead.
  3. High-write / low-read columns: write cost dominates, reads don't recoup it.
  4. OLAP bulk loads: indexes on analytic tables make bulk inserts 10-100x slower.
  5. Columns used only with non-sargable predicates: LIKE '%keyword%', functions on column.
```

---

## SECTION 2 — Why This Exists: Incidents from Over-Indexing

```
INCIDENT 1: 14 Indexes on events Table — INSERT Rate Collapses

  System: event tracking service. Schema: events(id, user_id, event_type, metadata, created_at).
  Over 2 years: engineers added indexes for every ad-hoc query.

  Indexes accumulated:
    1. events_pkey (id)
    2. idx_events_user_id
    3. idx_events_event_type
    4. idx_events_created_at
    5. idx_events_user_event_type
    6. idx_events_user_created
    7. idx_events_user_event_created
    8. idx_events_metadata (GIN on JSONB)
    9. idx_events_week (expression: DATE_TRUNC('week', created_at))
    10. idx_events_hour (expression: DATE_TRUNC('hour', created_at))
    11. idx_events_event_type_created
    12. idx_events_user_type_meta (composite including metadata)
    13. idx_events_recent (partial: created_at > NOW() - INTERVAL '30 days')
    14. idx_events_active_users (partial: event_type IN ('login','purchase'))

  Problem: 50K events/second at peak.
  INSERT time: 8ms per INSERT (was 0.2ms at launch).
  Each INSERT: must update 14 indexes. Some GIN indexes (JSONB): especially expensive (5-15ms each).
  Total: 14 index writes per event insert → I/O and CPU dominated by index maintenance.

  Analysis of index usage:
    SELECT indexrelname, idx_scan FROM pg_stat_user_indexes WHERE relname = 'events';
    Results: 8 of 14 indexes: 0 scans in the past 30 days. Never used.

  Resolution: DROP 8 unused indexes. INSERT rate: back to 0.3ms. 26x improvement.
  Lesson: regularly audit index usage. Drop what isn't used.

INCIDENT 2: Index on status Column (3 Values) — Planner Ignores It Anyway

  Engineer adds: CREATE INDEX idx_orders_status ON orders(status);
  Status values: 'PENDING' (40%), 'COMPLETED' (55%), 'FAILED' (5%).

  Planner analysis for query WHERE status = 'COMPLETED':
    Estimated rows: 55% of 50M = 27.5M rows.
    Index Scan cost: random I/O for 27.5M heap fetches = catastrophically expensive.
    SeqScan cost: sequential read of all 50M rows. Cheaper than 27M random I/Os.
    Planner decision: SeqScan. Ignores the index entirely. Correct decision.

  Result: index on status costs write overhead on every order INSERT/UPDATE but is never used
  for the common case (COMPLETED). Only worth it for: WHERE status = 'FAILED' (5%) — rare queries.

  Correct approach:
    PARTIAL index: CREATE INDEX idx_orders_failed ON orders(id) WHERE status = 'FAILED';
    Small (5% of rows). Only used when querying failed orders. No cost for queries on COMPLETED.

INCIDENT 3: Functional Index Missing — Expression Breaks Index on Column

  Query: SELECT * FROM users WHERE LOWER(email) = LOWER('Alice@Corp.COM');
  Index: CREATE INDEX ON users(email);

  Problem: LOWER(email) ≠ email. The function wraps the column reference.
  B-tree index on email: stores raw values ('Alice@Corp.COM', 'bob@example.com').
  WHERE LOWER(email) = ... : function applied at query time. Cannot use the B-tree index.
  Result: SeqScan. The index on email does nothing for this query pattern.

  Correct: CREATE INDEX ON users (LOWER(email));
  Index stores: ('alice@corp.com', 'bob@example.com') — pre-lowercased.
  Query: WHERE LOWER(email) = 'alice@corp.com' — matches index expression exactly.
  Planner uses the functional index. Sub-millisecond lookup.

  But now: TWO indexes exist (raw email + lower(email)). Write overhead doubled for users table.
  Decision: if all queries use LOWER(email), drop the raw email index and keep only the functional one.

INCIDENT 4: Indexes on OLAP Bulk Load Table — ETL Takes 8 Hours Instead of 45 Minutes

  System: data warehouse, nightly ETL loads 500M rows into a staging table.
  Schema: events_staging with 6 indexes (for downstream analysts to query during load).

  ETL with 6 indexes: 8.5 hours. Index maintenance cost dominates.
  ETL without indexes (load bare table, recreate indexes after):
    COPY into empty table (no indexes): 45 minutes.
    CREATE INDEX CONCURRENTLY × 6: 90 minutes.
    Total: 2.25 hours vs 8.5 hours. 3.8x faster.

  Pattern for OLAP loads:
    1. TRUNCATE staging table (or DROP + recreate).
    2. COPY data in (no indexes, no FK checks).
    3. CREATE INDEX CONCURRENTLY after load completes.
    4. Swap staging → production (rename or view swap).
```

---

## SECTION 3 — Internal Working

### Write Amplification and Index Maintenance Cost

```
WRITE AMPLIFICATION MECHANICS:

  For a table with N indexes:

  INSERT:
    1. Write new row to heap page (1 page write minimum).
    2. For EACH index: compute key, descend B-tree, insert at leaf level.
       Each B-tree insert: ~3 page reads (tree descent) + 1 page write (leaf).
       If page split: 1-3 additional writes (new page + parent update + grandparent).
    Total writes: 1 heap + N × (1-3 index page writes) + potential split cascades.

    Example: 1 heap write + 14 indexes × 2 page writes average = 29 page writes per INSERT.
    vs 1 heap write + 1 PK index = 3 page writes. 10x difference.

  UPDATE (touching an indexed column):
    1. Write new heap row version (UPDATE in Postgres = INSERT new version + mark old as dead).
    2. For EACH index on modified column: remove old key entry + insert new key entry.
       Both operations traverse the B-tree independently.
    Total: 1 heap write + 2 × N × B-tree writes (for each updated indexed column).

    UPDATE not touching indexed columns: HOT update (heap-only tuple). Index NOT updated.
    Critical design: keep frequently-updated columns OUT of indexes to benefit from HOT updates.

  DELETE:
    1. Mark heap row as dead (set xmax = current transaction ID).
    2. Index entries: NOT immediately removed. Still point to the now-dead heap row.
    3. VACUUM: reclaims dead index entries and dead heap rows in a background pass.
    Total immediate write: 1 heap page write (marking xmax). Index: deferred to vacuum.

    High DELETE rate: large number of dead index entries accumulate → index bloat.
    Bloated index: larger than needed → more pages to scan → slower (but correct) reads.
    Fix: manual VACUUM ANALYZE or tune autovacuum aggressiveness.

INDEX MAINTENANCE COSTS IN NUMBERS:
  Benchmark: INSERT 1M rows into a table with different index counts.
  (PostgreSQL 15, NVMe SSD, AWS r6g.2xlarge)

  Indexes  | INSERT rate  | Total time  | Index size
  ---------|-------------|-------------|------------
  0        | 280,000/sec | 3.6s        | 0
  1 (PK)   | 210,000/sec | 4.8s        | 80MB
  3        | 140,000/sec | 7.1s        | 320MB
  6        | 90,000/sec  | 11.1s       | 640MB
  10       | 58,000/sec  | 17.2s       | 1.1GB
  14       | 38,000/sec  | 26.3s       | 1.5GB

  Each added index: roughly +0.15ms per INSERT at this data size.
  GIN indexes (JSONB): +1-5ms per INSERT. Much more expensive than B-tree.

CHECKING INDEX USAGE:
  -- Indexes with 0 or near-0 scans (candidates for removal):
  SELECT schemaname, relname AS table, indexrelname AS index,
         idx_scan, idx_tup_read, idx_tup_fetch,
         pg_size_pretty(pg_relation_size(indexrelid)) AS size
  FROM pg_stat_user_indexes
  WHERE idx_scan = 0
    AND schemaname NOT IN ('pg_catalog', 'information_schema')
  ORDER BY pg_relation_size(indexrelid) DESC;

  -- Note: pg_stat reset on server restart. Give it at least 30 days of traffic before trusting.
  -- Reset stats to get fresh baseline: SELECT pg_stat_reset_single_table_counts('table_name');

LOW-CARDINALITY COLUMN ANALYSIS:
  -- Find low-cardinality columns that have indexes (potential waste):
  SELECT a.attname AS column, s.n_distinct,
         i.indexrelname, pg_size_pretty(pg_relation_size(i.indexrelid)) AS size,
         i.idx_scan
  FROM pg_stats s
  JOIN pg_attribute a ON a.attname = s.attname AND a.attrelid = s.schemaname::regclass
  JOIN pg_stat_user_indexes i ON i.relname = s.tablename AND i.indexdef LIKE '%' || s.attname || '%'
  WHERE s.tablename = 'orders'
    AND s.n_distinct BETWEEN 1 AND 20  -- low cardinality threshold
  ORDER BY s.n_distinct;
```

---

## SECTION 4 — Query Execution Flow

### When the Planner Chooses SeqScan Over an Existing Index

```
SCENARIO: Index Exists but Planner Still Chooses SeqScan

Table: orders (50M rows)
Index: idx_orders_status ON orders(status)
Status distribution: COMPLETED=55%, PENDING=40%, FAILED=5%
Query: SELECT id, total FROM orders WHERE status = 'COMPLETED'

STEP 1: PLANNER GATHERS STATISTICS

  From pg_stats WHERE tablename = 'orders' AND attname = 'status':
    most_common_vals = {'COMPLETED', 'PENDING', 'FAILED'}
    most_common_freqs = {0.55, 0.40, 0.05}

  Selectivity for status = 'COMPLETED': 0.55
  Expected rows to return: 50M × 0.55 = 27.5M rows.

STEP 2: PLANNER COST COMPARISON

  SeqScan cost:
    Pages: 50M rows at 100 rows/page (assuming ~80 byte rows) = 500,000 pages.
    seq_page_cost × pages = 1.0 × 500,000 = 500,000
    cpu_tuple_cost × rows = 0.01 × 50M = 500,000
    Total: 1,000,000 (approximate)

  Index Scan cost:
    Index height traversal: 4.0 × 3 = 12
    Heap fetches: 27.5M rows expected → 27.5M × 4.0 seq_page_cost (random I/O per row) = 110M
    Total: 110,000,012

    Index Scan is 110x MORE EXPENSIVE than SeqScan for this query!

  Planner correctly chooses SeqScan. It's NOT a bug. It's the right decision.

STEP 3: UNDERSTANDING THE CROSSOVER POINT

  When does the index become useful?
  B-tree index cost < SeqScan cost when:
    expected_rows × random_page_cost < n_pages × seq_page_cost
    expected_rows × 4.0 < 500,000 × 1.0
    expected_rows < 125,000

  Selectivity threshold: 125,000 / 50,000,000 = 0.25%

  For this table: index only useful when the query returns < 0.25% of rows.
  status = 'FAILED' (5%): still above threshold. SeqScan may still win.
  customer_id = 42 (< 0.001%): well below threshold. Index scan wins.

  ENABLING INDEX SCAN FOR TESTING (understanding behavior only):
    SET enable_seqscan = OFF;
    EXPLAIN SELECT id, total FROM orders WHERE status = 'COMPLETED';
    Show index scan cost: 110M. Confirms the planner was right to ignore it.
    SET enable_seqscan = ON;  -- always restore!

STEP 4: BITMAP INDEX SCAN — THE MIDDLE GROUND

  Query: SELECT id, total FROM orders WHERE status = 'FAILED'
  Expected rows: 5% of 50M = 2.5M. Threshold was 125K. Still too many for Index Scan?

  Actually: planner may choose BITMAP INDEX SCAN for 1-20% selectivity range.
  Bitmap scan approach:
    Phase 1: scan entire index for status = 'FAILED'. Collect all heap TIDs as a bitmap.
    Phase 2: sort TIDs by physical heap page order (not random I/O order).
    Phase 3: read heap pages in sequential order, recheck filter.

  Cost advantage over Index Scan: sequential-ish heap access instead of random I/O per row.
  Cost: higher than pure Index Scan for very selective queries (< 0.1% rows).
  Lower than Index Scan for moderate range (1-20%).

  EXPLAIN shows:
    -> Bitmap Heap Scan on orders
       Recheck Cond: (status = 'FAILED')
       -> Bitmap Index Scan on idx_orders_status
          Index Cond: (status = 'FAILED')

SUMMARY: WHEN TO SKIP THE INDEX

  |  Selectivity  |  Expected behavior         |  Planner choice         |
  |---------------|---------------------------|-------------------------|
  |  < 0.1%       |  Index Scan (random I/O)  |  Index Scan             |
  |  0.1% - 20%   |  Bitmap Scan (batch I/O)  |  Bitmap Index Scan      |
  |  > 20%        |  Sequential scan wins     |  Seq Scan (ignores idx) |

  The index is still maintained on every write even when SeqScan is preferred.
  That's the cost you pay with no read benefit for high-selectivity predicates.
```
