# B-Tree Index — Part 1 of 3

### Sections: 1 (Intuition), 2 (Why It Exists), 3 (Internal Working), 4 (Query Execution Flow)

**Series:** Databases & Data Modeling → Topic 12

---

## SECTION 1 — The Intuition

### Mental Model: The Sorted Library Card Catalog

```
A B-tree index is a sorted, balanced tree structure that allows the database to find
any value in O(log N) time — and because it's sorted, it also supports range queries.

ANALOGY: Library card catalog with a specific organization.

Imagine a library with 1,000,000 books (rows). Each book has an author (column).
You want to find all books by authors whose last name starts with "Sa" through "Sh".

Without an index catalog:
  Walk through every single shelf. Read every book's spine. 1,000,000 shelves.

With a B-tree card catalog:
  The catalog (B-tree) has:
    Root card: "A-M | N-Z" (two branches)
    Branch cards: "Sa-Sl | Sm-Sz" (sub-branches)
    Leaf cards: "Sabato, Sagan, Said, ... Santos, Saussure" (actual references)

  You go: root → right branch (N-Z) → sub-branch (Sa-Sl) → leaf range (Sa-Sh).
  Pull those 50 cards. Go directly to those 50 books. Done.

  2-3 hops to find your starting point. Then follow the chain of leaves.
  This is precisely how B-tree index lookup works.

THE "B" DOESN'T STAND FOR "BINARY":
  B-tree = Balanced tree (sometimes credited to Bayer & McCreight, the inventors, 1972).
  "Balanced" means every leaf node is the same distance from the root.
  Height difference between any two leaf paths: 0. Always O(log N) lookup. No degenerate cases.

WHAT B-TREE SUPPORTS:
  = (equality):  WHERE status = 'ACTIVE'              → exact key lookup → O(log N)
  < > <= >=:     WHERE price < 100                     → find starting position, then range scan
  BETWEEN:       WHERE age BETWEEN 25 AND 35           → range from lower to upper bound
  LIKE 'prefix%': WHERE name LIKE 'Jo%'                → range from 'Jo' to 'Jp' in B-tree
  IS NULL:       WHERE deleted_at IS NULL              → indexed NULL values (PostgreSQL)
  ORDER BY:      ORDER BY last_name                    → B-tree is already sorted, no sort needed
  MIN() / MAX(): → read first / last leaf. O(log N).

WHAT B-TREE DOES NOT SUPPORT:
  LIKE '%suffix':  WHERE name LIKE '%son'             → no prefix → must scan entire index
  LIKE '%middle%': WHERE name LIKE '%Smith%'          → same problem
  Full-text search: WHERE description LIKE '%keyword%' → use GIN / full-text index instead
  Geometric containment: ST_Contains, overlapping ranges → use GiST/SP-GiST index
  Array containment: WHERE tags @> '{sql,performance}'  → use GIN index
```

---

## SECTION 2 — Why This Exists: What Breaks Without B-Tree

```
PROBLEM 1: Linear Search Kills Performance at Scale

  Without B-tree: finding a row requires reading every row in the table.
  O(N) growth. Performance degrades in direct proportion to data volume.

  Table: customers, 10M rows, 1KB average row width.
  Without index: 10M × 1KB = ~10GB of data to scan for one lookup.
  At 500MB/s disk throughput: 20 seconds.
  With B-tree: 3-4 page reads (24-32KB). Sub-millisecond.

  The B-tree collapses 10GB of disk I/O into 32KB. That is the entire value proposition.

PROBLEM 2: Unsorted Data Cannot Support Range Queries Efficiently

  Without B-tree: WHERE price BETWEEN 10 AND 20 requires scanning ALL rows.
  Even if you index with a hash: hash index supports only equality. No range.

  B-tree maintains sorted order. Range query:
    Find first entry >= 10. Follow leaf chain forward until entry > 20. Done.
    Total work: O(log N) to find start + O(k) to return k results. Efficient.

PROBLEM 3: ORDER BY Without Index Forces Sort Operation

  Without index:
    SELECT * FROM employees ORDER BY hire_date DESC LIMIT 50;
    Must read all rows, sort them (potentially spilling to disk), return top 50.
    For 50M rows: sort = 50M row read + in-memory or disk sort. Seconds.

  With B-tree on hire_date:
    "Index Scan Backward" — read 50 rows from the rightmost leaf pages.
    Cost: reading 50 rows from pre-sorted index. Milliseconds.

PROBLEM 4: High-Selectivity Joins Without Index

  WITHOUT B-tree on FK column:
    SELECT * FROM orders o JOIN customers c ON c.id = o.customer_id WHERE c.region = 'APAC'
    For each customer in APAC: scan ALL orders to find matching customer_id.
    Nested Loop: O(APAC_customers × orders) = terrible.

  WITH B-tree on orders.customer_id:
    For each APAC customer: B-tree lookup on orders.customer_id → O(log N).
    The join is now efficient regardless of table size.

WHY B-TREE SPECIFICALLY (vs alternatives):

  Hash index: O(1) equality lookup. BUT: no range queries, no ORDER BY, no LIKE prefix.
    Useful only: pure equality on high-cardinality columns (e.g., UUIDs).
    PostgreSQL: Hash indexes exist but are rarely preferred over B-tree.

  B-tree: O(log N) equality AND range queries AND ORDER BY AND LIKE prefix AND MIN/MAX.
    One structure handles almost all OLTP index needs. Default for good reason.

  GIN (Generalized Inverted Index): for full-text search, array containment, JSONB keys.
    Better for: multi-valued attributes. NOT for equality/range on scalar values.

  GiST (Generalized Search Tree): for geometric data, range types, nearest-neighbor.
    Better for: spatial queries, timestamp ranges, overlapping intervals.

  BRIN (Block Range Index): for huge tables with physically sorted data (timeseries).
    Each entry represents a range of data in N consecutive pages. Tiny index footprint.
    Terrible for random access. Excellent for created_at range scans on append-only tables.
```

---

## SECTION 3 — Internal Working

### B-Tree Page Structure and Operation

```
B-TREE PHYSICAL STRUCTURE:

  A B-tree index is stored as pages (same 8KB pages as heap).
  Three node types:
    1. Root page: single page at the top. Contains only pivot keys + pointers to children.
    2. Internal (branch) pages: pivot keys + pointers to children. Many levels possible.
    3. Leaf pages: actual index entries (key + heap TID). Doubly-linked list between leaf pages.

  HEIGHT CALCULATION:
    B-tree branching factor: how many entries fit in one 8KB page.
    For a BIGINT index (8 bytes key + 6 bytes TID + 4 bytes overhead = ~18 bytes per entry):
    Entries per page: 8192 / 18 ≈ 455 entries per page.

    Height for 100M rows:
      Level 0 (root):     1 page. Can point to 455 children.
      Level 1 (branch):   455 pages. Can point to 455² = 207,025 leaves.
      Level 2 (leaf):     207,025 pages × 455 entries = 94M entries. ≈ 100M rows.

    Result: 3-level B-tree handles 100M rows. Only 3 page reads to find any value.

    For TEXT index (VARCHAR(255) average say 40 bytes per key):
    Entries per page: 8192 / (40+6+4) = ~162 entries per page.
      Level 3 needed at: 162³ ≈ 4.25M entries (smaller fan-out).
    Height 4 for ~689M rows with text keys.

LEAF PAGE STRUCTURE:
  Each leaf entry: {key value | heap TID (page_id, slot_id)}
  Entries: sorted by key value within the page.
  Sibling pointers: each leaf page has a right-sibling pointer (linked list).
                    Also a left-sibling pointer (doubly linked).
  Range scan: find the starting leaf via root descent, then follow right-sibling pointers.
  No need to go back to root for range traversal. Just walk the leaf chain.

PAGE SPLITS — HOW THE TREE GROWS:
  INSERT: descend to the correct leaf page. Insert new key in sorted position.
  Page full: PAGE SPLIT.
    1. Allocate a new leaf page.
    2. Move the right half of the current page's entries to the new page.
    3. The middle key becomes a new pivot key sent UP to the parent (internal page).
    4. Parent may also overflow → cascade split upward.
    5. Root split: new root page created. Tree height increases by 1.

  WRITE AMPLIFICATION from page splits:
    One INSERT can cause: leaf write + parent write + grandparent write + ...
    In practice: a page split touches O(height) pages = 3-4 pages for most trees.
    Page fill factor (FILLFACTOR): by default 90%. Leaves 10% free space for inserts before split.
    For insert-heavy columns: FILLFACTOR = 70 — more headroom, fewer splits.
    CREATE INDEX ON tables(col) WITH (FILLFACTOR = 70);
    Trade-off: larger index (more pages) but fewer write-triggered splits.

INDEX PAGE CACHING:
  Root and upper branch pages: accessed on EVERY index lookup.
  Postgres buffer manager: hot pages (like B-tree root) are rarely evicted from shared_buffers.
  Result: for a busy index, only the leaf page access goes to disk. Root+branch: always in cache.

  INDEX BLOAT:
    DELETE + UPDATE: old index entries not immediately removed. Marked as dead tuples.
    Autovacuum: reclaims dead entries, making pages reusable. Reduces bloat.
    Detecting index bloat:
      SELECT indexrelname, pg_size_pretty(pg_relation_size(indexrelid)) AS index_size,
             idx_scan, idx_tup_read
      FROM pg_stat_user_indexes
      WHERE schemaname = 'public'
      ORDER BY pg_relation_size(indexrelid) DESC;

    Rebuilding bloated index (zero-downtime):
      REINDEX INDEX CONCURRENTLY idx_name;  -- PG12+. Takes minutes. No locks.

MULTI-VERSION CONCURRENCY (MVCC) AND INDEXES:
  B-tree stores ONE entry per row per version: (key, heap TID).
  Old row versions (dead rows): have entries in the index that point to dead heap rows.
  These are NOT removed immediately on UPDATE/DELETE (no index entry removed at that time).
  VACUUM: marks index entries for dead heap rows as recyclable. Later: reclaim.

  HOT (Heap Only Tuple) UPDATE optimization:
    If the UPDATE doesn't change any indexed column and there's free space on the same heap page:
    Postgres creates a HOT update — new row version on the same heap page, linked to old version.
    Index: NOT updated (still points to old version which now chains to new version).
    Result: fewer index write operations for updates to non-indexed columns. Performance win.
```

---

## SECTION 4 — Query Execution Flow

### Inside a B-Tree Index Scan: Step by Step

```
QUERY: SELECT * FROM products WHERE price = 49.99

SETUP:
  Table: products, 5M rows, 8KB pages, ~200 rows/page → 25,000 heap pages.
  Index: idx_products_price on price (NUMERIC). B-tree height: 3. Leaf pages: ~11,000.
  shared_buffers: root page and top branch pages already in buffer cache (hot).

STEP 1: PLANNER DECISION
  Estimate rows for price = 49.99:
  pg_stats for price column:
    n_distinct = 1,200 (1,200 distinct prices across 5M rows)
    most_common_vals doesn't include 49.99 specifically
    estimated selectivity via histogram: ~0.008% → ~400 rows

  Index scan cost: 4.0 × (3 + 400) + cpu overhead ≈ 1,612
  SeqScan cost: 1.0 × 25,000 + 0.01 × 5M = 75,000
  Planner selects: Index Scan on idx_products_price.

STEP 2: INDEX DESCENT (ROOT → BRANCH → LEAF)

  Page 1 (ROOT): [10.00 → left | 50.00 → right | 100.00 → far-right]
    Key 49.99 < 50.00 → follow "left" pointer → Branch page 7.

  Page 7 (BRANCH): [40.00 → left | 48.00 → right | 52.00 → far-right]
    Key 49.99 > 48.00 AND 49.99 < 52.00 → follow "right" pointer → Leaf page 4,322.

  Page 4,322 (LEAF):
    Entry: [49.95, TID(18921,3)]
    Entry: [49.99, TID(18924,7)]  ← key match
    Entry: [49.99, TID(19042,1)]  ← same key, different row
    Entry: [50.00, TID(19250,4)]  ← past our key

    Collect all TIDs for key = 49.99: (18924,7), (19042,1).
    Check next leaf page (right sibling) for more 49.99 entries.
    Next leaf: starts with 50.05. No more 49.99. Stop.

STEP 3: HEAP FETCHES
  For TID (18924,7):
    Check shared_buffers for page 18924. Not in cache → disk read.
    Read heap page 18924. Navigate to slot 7.
    MVCC check: row xmin = 10042 (committed), xmax = NULL (not deleted). Visible.
    Apply any remaining filters (none in this query). Yield row.

  For TID (19042,1):
    shallow check shared_buffers for page 19042. Not in cache → disk read.
    Read heap page 19042. Navigate to slot 1.
    MVCC check: visible. Yield row.

  Total I/O: 3 index pages + 2 heap pages = 5 page reads.
  Vs SeqScan: 25,000 page reads.

STEP 4: INDEX-ONLY SCAN OPTIMIZATION
  If the query only selects indexed columns (no heap fetch needed):
  SELECT price FROM products WHERE price = 49.99
  → Index-only scan: read the index leaf. Value is there. Return without heap fetch.
  I/O: 3 pages (root+branch+leaf). Heap: 0 reads (unless visibility check requires it).

  Visibility map: Postgres maintains a visibility map (1 bit per heap page).
  If all rows on a heap page are known-visible: index-only scan skips visibility check entirely.
  autovacuum sets visibility map bits. Fresh inserts: bits not set yet → may need heap check.

STEP 5: RESULT STREAMING
  Executor yields rows one at a time (pipeline model). No buffering of all results.
  Client reads rows as they stream from the executor via the wire protocol.
  If client stops reading (e.g., LIMIT): executor stops scanning. No wasted work.

EXPLAIN ANATOMY FOR INDEX SCAN:
  EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM products WHERE price = 49.99;

  -> Index Scan using idx_products_price on products  (cost=0.56..812.44 rows=400 width=128)
                                                       (actual time=0.043..1.234 rows=412 loops=1)
     Index Cond: (price = 49.99)
     Buffers: shared hit=2 read=403  ← 403 pages from disk (index pages + heap pages)

  Planning time: 0.231 ms
  Execution time: 1.456 ms

  VS without index:
  -> Seq Scan on products  (cost=0.00..143,789.00 rows=400 width=128)
                            (actual time=0.034..3,421.34 rows=412 loops=1)
     Filter: (price = 49.99)
     Rows Removed by Filter: 4,999,588
     Buffers: shared hit=387 read=24,613  ← 24,613 pages from disk

  Execution time: 3,421 ms

PRACTICAL INDEX CREATION:
  -- Basic:
  CREATE INDEX ON products (price);

  -- Named (recommended for large systems — easier to reference):
  CREATE INDEX idx_products_price ON products (price);

  -- Zero-downtime (CONCURRENTLY):
  CREATE INDEX CONCURRENTLY idx_products_price ON products (price);
  -- Takes longer (builds index in background). No table lock. Safe in production.
  -- Cannot be run inside a transaction block.

  -- Descending (for ORDER BY ... DESC):
  CREATE INDEX idx_products_price_desc ON products (price DESC);

  -- Partial (for a subset of rows — smaller and faster):
  CREATE INDEX idx_products_active_price ON products (price) WHERE is_active = TRUE;
```
