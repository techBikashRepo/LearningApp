# Composite Index — Part 1 of 3

### Sections: 1 (Intuition), 2 (Why It Exists), 3 (Internal Working), 4 (Query Execution Flow)

**Series:** Databases & Data Modeling → Topic 13

---

## SECTION 1 — The Intuition

### Mental Model: The Multi-Level Phone Book

```
A composite index is a B-tree index built on multiple columns — in a specific order.
The most important concept: the LEADING COLUMN RULE.

ANALOGY: Phone book sorted by (Last Name, First Name, City).

This phone book can efficiently answer:
  "Find all people named Smith"                     → look up "Smith" in last-name section
  "Find John Smith in New York"                      → last name = Smith, first = John, city = NY
  "Find all Smiths in Chicago"                       → last name = Smith, city = Chicago (scan across first names)
  "Find all Smiths named John"                       → last name = Smith, first = John

This phone book CANNOT efficiently answer:
  "Find all Johns"                                   → "John" is not the first column. Must scan entire book.
  "Find everyone in Chicago"                         → "Chicago" is the third column. Same problem.

THE CRITICAL RULE: You can use a composite index (A, B, C) for queries that filter on:
  A              → ✅ uses index on A
  A, B           → ✅ uses index on A and B
  A, B, C        → ✅ uses index on all three
  A, C           → ✅ uses index on A fully, C partially (range scan from A's position)
  B              → ❌ cannot use -- B is not the leading column
  C              → ❌ cannot use -- C is not the leading column
  B, C           → ❌ cannot use -- neither is the leading column

THE ORDER MATTERS:
  Index (customer_id, status) vs Index (status, customer_id):
    Query: WHERE customer_id = 42 AND status = 'ACTIVE'
      Both work. Same result. But different for other queries:
    Query: WHERE customer_id = 42 (only)
      (customer_id, status): ✅ customer_id is leading column. Uses index.
      (status, customer_id): ❌ status is leading column. Cannot use.
    Query: WHERE status = 'ACTIVE' (only, many matches)
      (customer_id, status): ❌ (low selectivity even if leading; skip if not leading)
      (status, customer_id): ✅ can use (but may not be selective enough to benefit)

  Rule of thumb for composite index column ordering:
    1. Equality predicates go first (WHERE col = value)
    2. Range predicates go last (WHERE col BETWEEN … or col > …)
    3. High-cardinality columns go before low-cardinality within each category
```

---

## SECTION 2 — Why This Exists: Performance Wins and Failure Modes

```
PROBLEM 1: Separate Indexes Can Be Sub-Optimal for Multi-Column Filters

  Query: SELECT * FROM orders WHERE customer_id = 42 AND status = 'PENDING'

  Two separate indexes: idx_customer_id, idx_status
  Option A: use idx_customer_id → find all orders for customer 42 (maybe 5,000 rows),
            then filter for status = 'PENDING' → 500 rows returned.

  Option B: Bitmap AND of both indexes → intersection of customer_id=42 set AND status='PENDING' set.
            This works but requires materializing both sets and BitmapAND operation.

  Composite index idx(customer_id, status):
    Find customer_id = 42 AND status = 'PENDING' in a single B-tree lookup.
    Tree descends: key = (42, 'PENDING'). Finds all matching leaf entries directly.
    Fewer index pages visited. Better than Bitmap AND.

PROBLEM 2: Index-Only Scans (Covering Index) — Major Performance Win

  Query: SELECT order_id, total_amount FROM orders WHERE customer_id = 42 ORDER BY created_at

  Composite index: (customer_id, created_at) — only covers WHERE + ORDER BY.
  Still must fetch heap pages for order_id and total_amount.

  Covering index: (customer_id, created_at, order_id, total_amount) — includes all referenced columns.
  Now: the index contains every column the query needs.
  Result: INDEX-ONLY SCAN. Zero heap fetches. Pure index reads.
  I/O: log(N) to find customer 42's starting position + sequential leaf scan. No random heap I/O.

  Performance impact: 10-50x faster on queries that qualify for index-only scan.
  Cost: larger index (more storage). Index maintained on every write to covered columns.
  Use when: query is hot (called thousands of times per second) and all columns fit in the index.

PRODUCTION INCIDENT: The Missing Leading Column

  System: order management, 200M orders.
  Query (inside a cronjob, runs every minute):
    SELECT COUNT(*) FROM orders WHERE status = 'FAILED' AND created_at < NOW() - INTERVAL '7 days';

  DBA created index: (created_at, status) — created_at first.
  Query uses status = 'FAILED' as primary filter, not created_at.

  With index (created_at, status):
    Planner: leading column = created_at. Predicate created_at < 7 days ago → range on leading column.
    Uses index. But: returns ~190M rows matching the date range. Filters for status='FAILED' inline.
    Reads most of the index. Nearly as bad as SeqScan.

  Correct index: (status, created_at)
    Leading column = status = 'FAILED'. Highly selective. Returns ~0.1% of rows.
    Second column = created_at. Further narrows to recent failures.
    Result: 200 rows matched. Index scan: 5ms. Cronjob impact: negligible.

INDEX ORDERING FOR SORT:
  Query: SELECT * FROM orders WHERE customer_id = 42 ORDER BY created_at DESC

  Index (customer_id, created_at):
    Find customer_id = 42 position. Scan forward through leaf pages (created_at ASC order).
    To get DESC order: scan backward from last entry for customer_id=42. PostgreSQL: Index Scan Backward.
    No explicit sort node needed. Free sort from index structure.

  Index (customer_id, created_at DESC):
    Created_at stored in descending order in the index.
    Scanning forward in the index = results in descending created_at order. No backward scan needed.
    Minor optimization for queries that always ORDER BY DESC on this column.
```

---

## SECTION 3 — Internal Working

### Composite B-Tree Key Structure

```
COMPOSITE KEY ENCODING:
  Standard B-tree. The "key" is now a tuple of multiple column values.
  Comparison: lexicographic. (customer_id=1, status='ACTIVE') < (customer_id=1, status='PENDING')
  because 'ACTIVE' < 'PENDING' lexicographically.
  And (customer_id=1, ...) < (customer_id=2, ...) regardless of status.

  Leaf page entries: {(col1_value, col2_value, ...) | heap TID}
  Sorted in the same lexicographic order.

LEADING COLUMN RANGE SCAN MECHANICS:
  Index: (customer_id INT, created_at TIMESTAMPTZ)

  Query: WHERE customer_id = 42 AND created_at > '2024-01-01'
    B-tree descend: find first entry where (customer_id=42, created_at > '2024-01-01').
    Since entries are sorted: all (42, *) entries form a contiguous range in leaf pages.
    Within that range: scan forward until created_at exceeds '2024-01-01' lower bound.
    Stop when: customer_id changes to 43 (or created_at exceeds upper bound if any).

  Query: WHERE customer_id IN (42, 55, 99) AND created_at > '2024-01-01'
    Three separate range scans: one for each customer_id value.
    Merge results. Efficient if each customer_id is highly selective.

RANGE PREDICATE ON LEADING COLUMN — BREAKS SECOND COLUMN INDEX USE:
  Index: (created_at, status)
  Query: WHERE created_at > '2024-01-01' AND status = 'FAILED'

  Execution:
    Find first entry where created_at > '2024-01-01'. Fine.
    Scan leaf chain forward from there. Entries are sorted by (created_at, status).
    Within created_at > '2024-01-01': status values are NOT in a contiguous range.
    For each created_at value, entries cycle through status values alphabetically.
    The status = 'FAILED' filter: applies inline for each visited leaf entry.
    Cannot skip large sections. Every entry after the date threshold must be checked for status.

  IMPLICATION:
    Once a RANGE predicate is used on a leading column, all subsequent columns can only
    be used for filtering (RECHECK), not for constraining the scan range.
    Rule: equality predicates exhaust the prefix before any range predicate appears.
    Index (status, created_at): status='FAILED' is equality → used fully.
    Then created_at > '2024-01-01' → range on second column. Efficient.

INDEX SIZE vs PERFORMANCE:
  Composite index width: sum of all column widths + overhead per entry.
  Example: (BIGINT customer_id [8B], TIMESTAMPTZ created_at [8B], UUID order_id [16B]) = 32B + overhead
  Entries per 8KB page: 8192 / (32 + 10) ≈ 195 entries per page.
  For 200M rows: 200M / 195 ≈ 1,025,641 leaf pages ≈ 8GB index.

  Trade-off analysis for adding a column to a covering index:
    INT column (4B added): increases index by ~4% of leaf pages. Small cost.
    TEXT column (avg 60B added): doubles index size or worse. Evaluate carefully.
    UUID column (16B added): increases index by ~30%. Measurable. Worth it if it eliminates heap fetches.

PARTIAL COMPOSITE INDEX:
  Apply composite index only to a subset of rows.
  CREATE INDEX idx_orders_active_customer ON orders (customer_id, created_at) WHERE status = 'ACTIVE';

  Benefits:
    Index only contains ACTIVE orders (say 5% of total rows).
    Size: 20x smaller than full composite index.
    Writes: only updated when status = 'ACTIVE' orders are modified. Less write overhead.
    Lookup: planner uses this index only when query includes WHERE status = 'ACTIVE' (or equivalent).

  Common use: WHERE is_deleted = FALSE (covers only non-deleted rows — often 90%+ of queries).
```

---

## SECTION 4 — Query Execution Flow

### Composite Index Scan: Full Walk-Through

```
SCENARIO:
  Table: orders (200M rows)
  Columns: id BIGINT PK, customer_id INT, status VARCHAR(20), created_at TIMESTAMPTZ, total NUMERIC
  Composite Index: idx_orders_composite ON orders(customer_id, status, created_at)
  Query: SELECT id, total FROM orders WHERE customer_id = 42 AND status = 'PENDING'
         ORDER BY created_at DESC LIMIT 20;

STEP 1: PLANNER ANALYSIS

  Selectivity estimates:
    customer_id = 42:  200M rows × (1 / n_distinct(customer_id)) = 200M / 500K ≈ 400 rows avg.
    status = 'PENDING': 200M × most_common_freq('PENDING') ≈ 30% = 60M rows.
    Combined (AND): 400 rows. Very selective. Index scan win.

  Sort coverage analysis:
    ORDER BY created_at DESC.
    Index: (customer_id, status, created_at).
    For entries with customer_id=42 AND status='PENDING': they are sorted by created_at ascending in the leaf chain.
    Reading them backward (Index Scan Backward): gives DESC order. No explicit sort node needed!

  Heap fetch analysis:
    Query needs: id and total. Neither is in the index.
    Index-only scan: NOT possible. Must fetch heap pages.
    Estimated heap fetches: 20 rows (LIMIT 20). Very cheap.

  Plan selected: Index Scan Backward on idx_orders_composite + heap fetches.

STEP 2: INDEX DESCENT
  Root page: (42, '...', ...) comparison. Branch right or left based on customer_id.
  Branch pages: narrow to customer_id=42, status='PENDING' range.
  Leaf pages: land at the LAST entry with (42, 'PENDING', ...) because we scan backward.

STEP 3: LEAF PAGE BACKWARD SCAN
  Leaf entry: (42, 'PENDING', '2024-03-15 14:22:01', TID(98341, 7)) ← most recent
  Fetch heap row at TID(98341,7). MVCC check. Fetch id + total. Yield. Count: 1.

  Move to previous leaf entry: (42, 'PENDING', '2024-03-14 09:11:45', TID(87205, 2))
  Fetch heap row. MVCC check. Yield. Count: 2.

  ... continue backward through leaf pages until 20 rows yielded.

STEP 4: LIMIT CHECK
  Executor: after 20 rows, LIMIT satisfied. Stop scanning. Return to client.
  Total index pages visited: ~3 (tree height) + ~1-2 leaf pages.
  Total heap pages visited: ~20 (one per row, assuming rows not co-located on same page).
  Total I/O: ~22-25 pages. For a 200M row table. Sub-millisecond.

EXPLAIN OUTPUT:
  EXPLAIN (ANALYZE, BUFFERS)
  SELECT id, total FROM orders
  WHERE customer_id = 42 AND status = 'PENDING'
  ORDER BY created_at DESC LIMIT 20;

  -> Limit  (cost=0.57..28.91 rows=20 width=24)
             (actual time=0.098..0.213 rows=20 loops=1)
     -> Index Scan Backward using idx_orders_composite on orders
                  (cost=0.57..566.49 rows=400 width=24)
                  (actual time=0.093..0.207 rows=20 loops=1)
        Index Cond: ((customer_id = 42) AND (status = 'PENDING'))
        Buffers: shared hit=24 read=3

  Execution time: 0.241 ms

CONTRAST: WRONG INDEX ORDER → SORT ADDED:
  Index: idx_orders_wrong ON orders(status, customer_id) -- created_at NOT in index

  -> Limit  (cost=312.34..312.39 rows=20)
     -> Sort  (cost=312.34..313.34 rows=400 width=24)
              Sort Key: created_at DESC
           -> Index Scan using idx_orders_wrong on orders
              Index Cond: ((status = 'PENDING') AND (customer_id = 42))

  Sort node added! For 400 rows: sort_in_memory, fast. But for thousands of rows per customer:
  sort could spill to disk. The correct composite index eliminates the sort entirely.

DIAGNOSING INDEX USAGE:
  -- Is the composite index being used?
  SELECT indexrelname, idx_scan, idx_tup_read, idx_tup_fetch
  FROM pg_stat_user_indexes
  WHERE relname = 'orders' AND indexrelname = 'idx_orders_composite';

  -- idx_scan = 0 after running queries → index not used → check planner with EXPLAIN.
  -- idx_tup_fetch << idx_tup_read → many index entries scanned but few heap rows fetched →
  --   indicates index is filtering well at index level but many non-visible rows being skipped.
  --   May indicate stale bloat. Run VACUUM ANALYZE orders.
```
