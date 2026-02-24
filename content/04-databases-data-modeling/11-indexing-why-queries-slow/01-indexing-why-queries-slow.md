# Indexing — Why Queries Are Slow — Part 1 of 3

### Sections: 1 (Intuition), 2 (Why It Exists), 3 (Internal Working), 4 (Query Execution Flow)

**Series:** Databases & Data Modeling → Topic 11

---

## SECTION 1 — The Intuition

### Mental Model: The Encyclopedia Without an Index

```
Imagine a printed encyclopedia — 10,000 pages.
You want to find every article that mentions "Nikola Tesla."

Option A (No Index):
  Start at page 1. Read every single page.
  Scan for "Nikola Tesla" on every page. Write down every page number you find it.
  When done: you have your answer — but you read 10,000 pages to get it.

Option B (With an Index):
  Go to the alphabetical index at the back of the encyclopedia.
  Look up "T" → "Tesla, Nikola" → "see pages 487, 1,203, 4,891."
  Jump directly to those three pages. Done.

In Option A: you touched every page. Cost = O(N).
In Option B: you touched the index (tiny) + 3 pages. Cost = O(log N + k) where k is results.

THIS IS EXACTLY what happens in your database.

WITHOUT INDEX:
  SELECT * FROM users WHERE email = 'alice@corp.com'
  Database: page 1 → check every row → page 2 → check every row → ... → page 80,000.
  Called: Sequential Scan (SeqScan). Cost grows linearly with table size.
  1M rows at 8KB/page → 160,000 pages to read. At 100MB/s I/O: 12.8 seconds.

WITH INDEX:
  B-tree index on email. Root → branch → leaf: 3-4 page reads to find alice's row pointer.
  Jump to that heap page (~1 page read). Done. ~5 page reads total.
  0.001 seconds. Independent of table size (O(log N)).

WHY QUERIES BECOME SLOW OVER TIME:
  Startup: table has 1,000 rows. SeqScan reads 1,000 rows quickly. "Fast enough."
  6 months later: 10,000,000 rows. SeqScan reads 10,000,000 rows. "Why is it slow now?"
  The query hasn't changed. The data volume has. Only an index changes the access pattern.
```

---

## SECTION 2 — Why This Exists: Production Slow Query Incidents

### The Cost of Missing Indexes

```
REAL INCIDENT TYPE 1: Authentication Query — 4.8 Seconds Per Login

  System: web application, 8M users.
  Query: SELECT id, password_hash FROM users WHERE email = $1
  No index on email column. Added by ORM default: only PK index on id.

  At 5K concurrent logins/minute:
    Each login: SeqScan of 8M rows. ~800 pages read per second per query.
    5K parallel SeqScans: saturates disk I/O bus entirely.
    Response time: 4.8 seconds per login. Users abandoning login page.

  Fix: CREATE INDEX CONCURRENTLY idx_users_email ON users(email);
  After index: 0.3ms per login. 16,000x improvement. Single index creation.
  Root cause: ORM created the table with only PK index. No awareness of query patterns.

REAL INCIDENT TYPE 2: Report Query — Timing Out After Data Growth

  System: analytics dashboard. Monthly active users report.
  Query: SELECT user_id, COUNT(*) FROM events WHERE created_at >= '2024-01-01' GROUP BY user_id;
  Table: events, 500M rows. Partition added for each month... but no index on created_at.

  Month 1 (5M rows): query runs in 0.2 seconds. "Fast."
  Month 10 (50M rows): 2 seconds. "Acceptable."
  Month 24 (500M rows): 45 seconds → connection timeout. Dashboard broken.

  Fix: CREATE INDEX CONCURRENTLY idx_events_created_at ON events(created_at);
  After index: 1.2 seconds (with partition pruning + index). Query works again.
  Root cause: no performance regression testing. Query performance wasn't monitored as data grew.

REAL INCIDENT TYPE 3: FK Without Index — Cascading Lock Timeouts

  System: e-commerce, order processing.
  Table: order_items(id, order_id FK, product_id FK, quantity, price)
  Index: only on id (PK). No index on order_id or product_id.

  Support team deletes a product (rare operation via admin panel).
  FK check on order_items: "does any order_item still reference this product?"
  Without index on product_id: SeqScan of 200M order_items rows.
  Duration: 90 seconds. Holds ShareLock on order_items table during scan.
  All ORDER INSERT operations during those 90 seconds: blocked.
  Revenue impact: 90-second checkout outage.

  Fix: CREATE INDEX CONCURRENTLY idx_order_items_product_id ON order_items(product_id);
  After index: FK check = 3ms. No lockout.

REAL INCIDENT TYPE 4: Sort Without Index — work_mem Spill and Disk I/O

  System: customer support dashboard.
  Query: SELECT * FROM tickets ORDER BY created_at DESC LIMIT 50;
  Table: tickets, 30M rows. No index on created_at.

  Without index: database must read ALL 30M rows, sort them, return top 50.
  Sort requires all 30M rows in memory. work_mem=64MB insufficient for 30M rows.
  Result: sort spills to disk. I/O bottleneck. Query: 18 seconds.

  Fix: CREATE INDEX ON tickets(created_at DESC);
  With index: "Index Scan Backward" on the index. Reads 50 rows from rightmost leaf pages.
  Query time: 0.1ms. Sorted order: free from the index structure.

WHY DOES THE QUERY PLANNER CHOOSE SeqScan SOMETIMES?
  The planner isn't failing. It's making a cost-based decision.
  On very small tables (< ~1,000 rows, < 8 pages): SeqScan is faster than index lookup.
    Index lookup: B-tree traversal (3-4 random I/Os) → heap page (1 random I/O).
    SeqScan: read 8 pages sequentially. Sequential I/O faster than 4 random I/Os.
    Planner correctly chooses SeqScan.

  On large tables with high selectivity (1% of rows returned):
    Index lookup: O(log N) + heap random I/Os for 1% of rows. Efficient.
    SeqScan: O(N) pages. 100x more I/O. Planner correctly chooses index.

  When the planner is wrong (Estimate vs Actual row count mismatch):
    Bad statistics → planner thinks 10 rows → chooses SeqScan → actually 100K rows → slow.
    Fix: ANALYZE table_name to refresh statistics. VACUUM ANALYZE for all maintenance at once.
```

---

## SECTION 3 — Internal Working

### How the Query Planner Decides: Index vs SeqScan

```
THE COST MODEL:
  PostgreSQL planner assigns a numeric cost to every possible plan.
  Chooses the plan with the LOWEST total cost estimate.

  Cost units: "unit" ≈ cost of reading 1 page from disk. Abstract. Relative to each other.
  Key constants (pg_settings):
    seq_page_cost = 1.0    → cost per page in a sequential scan
    random_page_cost = 4.0 → cost per page in a random I/O (index lookup)
    cpu_tuple_cost = 0.01  → cost per row processed
    cpu_index_tuple_cost = 0.005
    effective_cache_size: planner's estimate of how much the OS will cache

  SEQSCAN cost formula:
    seq_page_cost × pages + cpu_tuple_cost × rows
    For events (500M rows, 80,000 pages):
      1.0 × 80,000 + 0.01 × 500,000,000 = 80,000 + 5,000,000 = 5,080,000 cost units

  INDEX SCAN cost formula:
    random_page_cost × (index pages traversed + heap pages fetched) + cpu costs
    For email = 'alice@corp.com' (1 result, index height = 3):
      4.0 × (3 + 1) + 0.01 × 1 = 16.01 cost units

  Planner picks index scan: 16 << 5,080,000.

STATISTICS — THE PLANNER'S KNOWLEDGE:
  pg_stats table: planner's knowledge about each column's data distribution.

  Key statistics:
    n_distinct: estimated distinct values. High → high selectivity → index helps.
    correlation: how physically ordered is the data vs the index order?
      correlation = 1.0 → heap rows perfectly aligned with index → very efficient index scan.
      correlation = 0.0 → completely random heap layout → many random I/Os per index entry.
    most_common_vals + most_common_freqs: most frequent values and their frequencies.
    histogram_bounds: data distribution histogram for range queries.

  How correlation affects plan choice:
    INDEX SCAN on perfectly correlated data: sequential-ish I/O pattern. Efficient.
    INDEX SCAN on uncorrelated data: every index entry → random heap I/O.
    At ~30% correlation: planner may prefer SeqScan over IndexScan.
    BITMAP INDEX SCAN: middle ground — collects all heap pointers from index,
    sorts them by physical page order, then reads heap sequentially.
    Better than random I/O for medium-selectivity queries (1% – 30% rows).

STATISTICS STALENESS:
  Statistics are not updated continuously. Updated by VACUUM ANALYZE.
  autovacuum: runs ANALYZE when ~20% of table rows have been modified (default).
  Large append-only tables: autovacuum may not trigger analyze often enough.
  Result: planner estimates 100 rows → actual: 10,000,000 rows → wrong plan chosen.

  Fix: manual ANALYZE after large data loads.

  CHECK for stale statistics:
    SELECT schemaname, tablename, last_analyze, last_autoanalyze
    FROM pg_stat_user_tables
    WHERE relname = 'events';

  HISTOGRAMS:
    Default: 100 histogram buckets per column (default_statistics_target = 100).
    For complex columns or heavily queried columns: increase to 500 or 1,000:
      ALTER TABLE events ALTER COLUMN user_id SET STATISTICS 500;
      ANALYZE events;
    More buckets → more accurate selectivity estimates → better plan choices.

EXPLAIN — READING THE PLANNER'S DECISIONS:

  EXPLAIN SELECT * FROM users WHERE email = 'alice@corp.com';
  Plan without index:
    Seq Scan on users  (cost=0.00..189,234.00 rows=1 width=84)
      Filter: ((email)::text = 'alice@corp.com'::text)

  Plan with index on email:
    Index Scan using idx_users_email on users  (cost=0.43..8.45 rows=1 width=84)
      Index Cond: ((email)::text = 'alice@corp.com'::text)

  EXPLAIN (ANALYZE, BUFFERS) — actual runtime stats:
    -> actual time=0.043..0.044 rows=1 loops=1
       Buffers: shared hit=4        ← 4 pages from buffer cache
    vs SeqScan with Buffers: shared hit=5,847 read=75,421  ← 75K pages from disk.

  KEY EXPLAIN METRICS:
    rows= (estimated) vs actual rows= → accuracy of statistics
    Buffers: shared hit → from memory. shared read → from disk. (disk I/O = slow)
    Batches: N → > 1 means hash join or hash agg spilled to disk
    Loops: N → how many times this node executed (Nested Loop inner = N times)
```

---

## SECTION 4 — Query Execution Flow

### From SQL Statement to Index Lookup: Full Pipeline

```
QUERY: SELECT * FROM orders WHERE customer_id = 42 AND status = 'PENDING'
Table: orders, 20M rows. Indexes: idx_orders_customer (customer_id), idx_orders_status (status).

STEP 1: PARSING
  SQL text → parse tree. Validates syntax. Identifies: table=orders, filter=(customer_id=42 AND status='PENDING').
  No semantic analysis yet.

STEP 2: ANALYSIS (SEMANTIC)
  Resolves table and column names against the catalog.
  Fetches column data types. Identifies applicable indexes from pg_index.
  Output: query tree with full type information.

STEP 3: REWRITING
  Rule system applies. For simple SELECT: no rewriting needed.
  Important for views (view → underlying table expansion) and RLS policies.

STEP 4: PLANNING / OPTIMIZATION
  Planner enumerates possible access paths:

  Path 1: SeqScan on orders + filter
    Cost: seq_page_cost × pages + cpu_tuple_cost × rows = 1.0×320,000 + 0.01×20M = ~520,000

  Path 2: Index Scan on idx_orders_customer (customer_id=42)
    Estimated rows for customer_id=42: check pg_stats → most_common_vals / histogram.
    Suppose 500 orders per customer on average.
    Cost: 4.0 × (3 index pages + 500 heap pages) + cpu overhead ≈ 2,016
    Then apply status='PENDING' filter on those 500 rows.
    Net cost: ~2,016. Much less than 520,000.

  Path 3: Index Scan on idx_orders_status (status='PENDING')
    Estimated rows for status='PENDING': 30% of 20M = 6M rows.
    Cost: 4.0 × (3 index pages + 6M heap pages) = ~24M. Terrible. SeqScan better.
    Planner notes: status index not useful for this predicate (low selectivity).

  Path 4: Bitmap AND (both indexes)
    Bitmap scan on customer_id=42 → ~500 row pointers.
    Bitmap scan on status='PENDING' → ~6M row pointers.
    AND the bitmaps → ~150 row pointers (assuming 30% of customer's orders are PENDING).
    Re-check on heap → 150 rows. Cost: medium. Not best here.

  WINNER: Path 2 (Index Scan on customer_id). Selected plan.

STEP 5: EXECUTOR RUNTIME

  5a. Start Index Scan:
    Open B-tree index idx_orders_customer.
    Descend root → branch → leaf node containing key 42.
    From leaf: read heap TID (page 8,341, slot 7). Fetch that heap page.
    Check row visibility: is this row visible to the current transaction snapshot?
    Apply remaining filter: status = 'PENDING'. Pass/fail.

  5b. Continue iteration:
    Advance to next index entry with key 42 (same leaf page or next leaf page).
    Fetch heap TID. Check visibility. Apply filter. Yield if passes.
    Repeat until no more key=42 entries in the leaf level.

  5c. Buffer management:
    Each page access: check shared_buffers first. If present: "shared hit" (fast, no disk I/O).
    If not present: "shared read" — fetch from OS page cache or physical disk.
    Fetched pages are placed in shared_buffers (evicting LRU pages if full).

  5d. Visibility check (MVCC):
    Each row's xmin (created by transaction) and xmax (deleted by transaction) checked.
    Row visible if: xmin committed AND (xmax is NULL OR xmax not yet committed).
    Ensures the query sees a consistent snapshot even during concurrent writes.

STEP 6: RESULT TRANSMISSION
  Rows that pass filter + visibility check → sent to client via wire protocol.
  PostgreSQL wire protocol: binary or text format depending on client.

MONITORING QUERY EFFICIENCY:
  -- Queries without index (most time-consuming):
  SELECT query, calls, total_exec_time, mean_exec_time, rows
  FROM pg_stat_statements
  WHERE mean_exec_time > 100  -- queries averaging > 100ms
  ORDER BY total_exec_time DESC
  LIMIT 20;

  -- pg_stat_statements: requires shared_preload_libraries = 'pg_stat_statements'
  -- Enable in Aurora: RDS parameter group → shared_preload_libraries → add pg_stat_statements.

  -- Tables with sequential scans (potential missing index):
  SELECT relname, seq_scan, idx_scan,
         seq_scan::float / NULLIF(idx_scan + seq_scan, 0) AS seq_scan_ratio
  FROM pg_stat_user_tables
  WHERE seq_scan > 1000  -- active tables being scanned
  ORDER BY seq_scan DESC;
  -- seq_scan_ratio close to 1.0 = almost always SeqScan = candidate for new index.
```
