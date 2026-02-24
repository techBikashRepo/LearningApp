# B-Tree Index — Part 3 of 3

### Sections: 9 (AWS Service Mapping), 10 (Interview Q&A), 11 (Debugging Exercise), 12 (Architect's Mental Model)

**Series:** Databases & Data Modeling → Topic 12

---

## SECTION 9 — AWS Service Mapping

### B-Tree Index Behavior Across AWS Services

```
Aurora PostgreSQL:

  B-tree index behavior: identical to PostgreSQL. Same page structure, same scan algorithms,
  same FILLFACTOR tuning, same INCLUDE columns support (PG 11+), same HOT update optimization.

  Aurora storage difference:
    Standard PostgreSQL: index pages stored on local disk. Buffer pool (shared_buffers) is L1.
    Aurora: index pages stored on distributed Aurora storage tier (replicated across 3 AZs, 6 copies).
    Index page read cache miss: read from Aurora storage volume (network round trip: ~1-2ms to storage nodes).
    Index page read cache hit (shared_buffers): same as local PG (~0.01ms).

    Implication: shared_buffers sizing is MORE critical in Aurora than standard PG.
    Undersized shared_buffers in Aurora: every B-tree descent that misses cache → Aurora storage read.
    Aurora storage read vs local NVMe: Aurora ~1-2ms, local NVMe ~0.1ms. 10-20x difference.

    Recommendation: Aurora PostgreSQL instances with significant OLTP load: size shared_buffers
    to fit the hot index pages (working set). db.r6g.2xlarge: 64GB RAM, set shared_buffers to 32GB.
    Aurora Parameter Group: shared_buffers = {DBInstanceClassMemory / 32768} × 8  (increase from default).

  Aurora I/O-Optimized (2023 feature):
    Aurora I/O-Optimized: no per-I/O charges. Pay flat for compute + storage.
    Previously: heavy index scans (many cache misses) generated high I/O charges.
    With I/O-Optimized: index-heavy analytical workloads have predictable cost.
    Choose I/O-Optimized when: I/O costs > 25% of total Aurora DB bill.

RDS MySQL (InnoDB):

  B-tree structure: InnoDB uses B+ trees (same as PostgreSQL's B-tree effectively).
  Key difference: InnoDB PRIMARY KEY index is CLUSTERED.
    Clustered index: leaf pages contain the ACTUAL row data, not just a pointer.
    Secondary index leaf pages: contain PK value, not heap CTID.
    Double lookup: secondary index lookup → find PK → PK index lookup → find row data.
    This is different from PostgreSQL where heap and index are always separate.

  InnoDB innodb_buffer_pool_size: equivalent to PostgreSQL shared_buffers.
  Default: 128MB. For production: set to 70-80% of available RAM.

  InnoDB Change Buffer: buffers secondary index changes in memory, applies them asynchronously.
    Reduces random I/O on write-heavy workloads. Automatic. No tuning needed.
    Risk: after crash, change buffer must be replayed. Add seconds to startup time.

DynamoDB:

  DynamoDB: no B-tree indexes. Uses a distributed hash-based storage engine.

  Primary Key storage:
    Partition key: hashed to determine physical storage partition.
    Sort key: within a partition, items stored in sorted order (similar to a B-tree leaf).
    Sort key queries: efficient range scans within a partition (like B-tree range scan).
    Cross-partition range scans: not possible without a GSI. Full scan required (expensive).

  GSI storage: eventually-consistent copy of items projected into the GSI.
  B-tree equivalent: DynamoDB's internal storage within a partition + sort key = B-tree-like range capability.
  External API: you query with between(), begins_with(), comparison operators on sort key.

  DynamoDB Accelerator (DAX):
    In-memory cache in front of DynamoDB. B-tree equivalent benefit: read from memory, not storage.
    For read-heavy: DAX reduces latency from single-digit ms to microseconds.
    Not for write-heavy (writes still go to DynamoDB; cache invalidation).

ElastiCache (Redis/Memcached):

  Not a database. No B-tree indexes. Pure in-memory key-value store.
  B-tree equivalent pattern: cache the result of common index-driven queries in Redis.

  Example: instead of querying `SELECT * FROM products WHERE category_id = 42 ORDER BY price LIMIT 20`
  every time (uses composite B-tree index), cache the result in Redis:
    Key: "products:category:42:price:page1"
    Value: serialized first page of results.
    TTL: 60 seconds.
  Subsequent requests: Redis hit, no database query. B-tree index bypassed entirely.
  Trade-off: stale data within TTL. Appropriate for product listings, not financial balances.
```

---

## SECTION 10 — Interview Questions & Answers

### Beginner Level

**Q1: What is a B-tree index and what operations does it support?**

A B-tree (Balanced Tree) index is a self-balancing tree data structure where every leaf is at the same depth. Data is stored in sorted order. When you search for a value, the database descends from the root through branch nodes to a leaf page in O(log N) time — typically 3-4 page reads for tables with hundreds of millions of rows.

B-tree indexes support: equality (`=`), range comparisons (`<`, `>`, `<=`, `>=`, `BETWEEN`), prefix matching (`LIKE 'abc%'`), `IS NULL`/`IS NOT NULL`, `ORDER BY` (the data is already sorted), and `MIN`/`MAX` (go to the leftmost or rightmost leaf).

B-trees do NOT support: suffix matching (`LIKE '%abc'`), full-text search, array containment, or geometric queries. For those, use GIN (array/full-text), GiST (geometric), or specialized extensions.

---

**Q2: What is a page split, and why should you care about it?**

A page split occurs when a B-tree leaf page is full and a new entry must be inserted. The database splits the full page into two half-full pages and adds a new branch entry pointing to the second page. The parent branch may also need to split (cascading up to the root in extreme cases).

Page splits are expensive: they require writing two new pages, updating parent entries, and they reduce index density (now two pages are half-full instead of one full page). Over time, many splits lead to index bloat — the index has more pages than it needs, so scans read more pages.

Mitigations:

- **`FILLFACTOR`**: leave free space on leaf pages (default 10%) to absorb inserts before splitting.
- **Sequential PKs** (like `BIGSERIAL`): inserts always go to the rightmost leaf page. No splits except at the right edge.
- **`REINDEX CONCURRENTLY`**: rebuilds the index, re-packs it to target fill factor, eliminating accumulated bloat.

---

**Q3: What is the difference between an Index Scan and an Index-Only Scan?**

An **Index Scan** uses the index to find matching values, then fetches the actual row from the heap (the main table storage) for each match. It requires two I/O paths: index traversal + heap fetch per row. This is the normal index lookup path.

An **Index-Only Scan** gets all needed data directly from the index, skipping the heap entirely. This requires: (1) all columns in the `SELECT` are present in the index (as key or `INCLUDE` columns), AND (2) the page's entry in the visibility map is set (indicating all rows on that page are visible to all transactions — set by `VACUUM`). An Index-Only Scan can be 5-50x faster than a regular Index Scan because it eliminates the random heap page reads.

---

### Intermediate Level

**Q4: How does a B-tree support range queries efficiently?**

B-tree leaf pages are organized as a doubly-linked list: each leaf page has a pointer to the next and previous leaf page. The pages are stored in sorted key order.

For a range query like `WHERE created_at BETWEEN '2024-01-01' AND '2024-01-31'`:

1. The database descends the tree to find the leaf entry for `2024-01-01` (O(log N) — 3-4 pages).
2. It scans forward through the linked leaf pages, collecting matching rows, until it reaches `2024-01-31`.
3. It stops as soon as it passes the end of the range.

This is extremely efficient because the matching values are physically adjacent in the index. No random jumping. The scan is essentially sequential I/O through the leaf level — cheap and fast. Without a B-tree, a range query requires examining every row in the entire table.

---

**Q5: What is FILLFACTOR and how does it affect index performance?**

`FILLFACTOR` is the percentage of each B-tree leaf page that PostgreSQL fills with entries during index creation or `REINDEX`. The default is 90%, leaving 10% free.

**Lower FILLFACTOR (e.g., 70%):** more free space per page. Updates and inserts to existing pages less likely to trigger page splits. Writes are faster/smoother. But the index has more pages for the same data → range scans read more pages → slightly slower reads. Good for write-heavy tables with frequent UPDATEs on indexed columns.

**Higher FILLFACTOR (100%):** pages are packed tightly. Minimum number of pages → fastest range scans. But any insert into a full page triggers an immediate split. Good for append-only data (like time-series logs where new data always goes to the rightmost page — old pages never need new inserts).

**Practical default:** leave at 90%. Only tune if profiling shows high split rates (`pg_stat_user_tables.n_tup_upd` high + index bloat growing rapidly).

---

### Advanced Level

**Q6: Walk me through exactly what happens when a query uses a B-tree index in PostgreSQL, from planning through execution.**

1. **Planning:** Parser sends the query to the planner. Planner fetches `pg_stats` for the target column (n_distinct, correlation, histogram). It calculates cost of SeqScan vs Index Scan vs Bitmap Index Scan using cost constants (`random_page_cost`, `seq_page_cost`, `cpu_tuple_cost`). If Index Scan estimated cost < SeqScan cost: planner chooses Index Scan. Plan is cached for prepared statements.

2. **Executor — index descent:** Executor opens the index relation. Reads the root page from shared_buffers (or disk if not cached). Follows the branch entry whose key range contains the search value. Reads branch pages down to the leaf level. Typically 2-3 page reads.

3. **Leaf scan:** At the leaf level, reads index entries from the current position. Each entry contains the key value + heap `ctid` (page number + offset within page). For range queries: moves forward through the linked leaf list until the range is exhausted.

4. **Heap fetch:** For each matching ctid, the executor opens the heap page (from shared_buffers or disk) and reads the row at the specified offset. For an Index-Only Scan: skips this if visibility map says the page is all-visible.

5. **MVCC visibility check:** For each heap row, checks `xmin` (inserting transaction) and `xmax` (deleting transaction) against the current transaction's snapshot. Only returns rows visible to this transaction's snapshot.

6. **Return:** Rows matching the predicate are returned to the upper plan node (Sort, Limit, Aggregate, etc.) or directly to the client.

---

**Q7: A 200GB table has a B-tree index that's grown to 180GB. How do you fix this without a maintenance window?**

Index bloat: accumulated dead entries from DELETEs and UPDATE-induced deletions that VACUUM hasn't reclaimed, plus page splits leaving pages half-full. The index is 180GB when it should be ~60GB at full packing.

**Diagnosis first:**

```sql
-- Measure actual vs expected:
SELECT pg_size_pretty(pg_relation_size('idx_orders_customer')) AS actual_size;
-- Compare to: table_size × (index columns / avg row size) × 1.1 (overhead)
-- 180GB vs ~60GB expected: significant bloat.

-- Check if VACUUM is keeping up:
SELECT relname, n_dead_tup, last_vacuum, last_autovacuum
FROM pg_stat_user_tables WHERE relname = 'orders';
```

**Fix without downtime:**

```sql
REINDEX INDEX CONCURRENTLY idx_orders_customer;
-- Builds a fresh copy of the index alongside the old one (uses ShareUpdateExclusiveLock).
-- Old index remains active for all queries during the rebuild.
-- On completion: atomic swap (old → new). Old index dropped.
-- Duration: 15-30 minutes for 60GB result (reading 200GB table).
-- No write blocking. No read blocking.
-- Monitor progress:
SELECT phase, blocks_done, blocks_total
FROM pg_stat_progress_create_index WHERE relid = 'orders'::regclass;
```

**Root cause fix:** Tune autovacuum to run more frequently, preventing future bloat:

```sql
ALTER TABLE orders SET (autovacuum_vacuum_scale_factor = 0.01, autovacuum_vacuum_cost_delay = 2);
```

---

## SECTION 11 — Debugging Exercise

### Production Incident: Index Bloat Degrading Response Time

**Scenario:**
Your orders API served 8ms median for a year. Over the past 6 weeks it's drifted to 85ms. No code changes, no schema changes, no traffic change. The engineering team suspects "just the database getting older."

---

**Step 1: Confirm the symptom is in the database layer.**

```
Application latency breakdown (from APM):
  SQL query execution: 78ms of the 85ms total.
  Network + serialization: 7ms.
  → Confirmed: database query time is the issue.
```

**Step 2: Run EXPLAIN ANALYZE on the slow query.**

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, total, status, created_at
FROM orders WHERE customer_id = 52001 ORDER BY created_at DESC LIMIT 20;

-- OUTPUT:
-- Index Scan Backward using idx_orders_customer_created on orders
--   (cost=0.70..1842.00 rows=20 actual rows=20 width=48)
--   Index Cond: (customer_id = 52001)
--   Buffers: shared hit=194 read=1287  ← 1,287 disk reads for 20 rows!
-- Execution Time: 78ms
```

The index IS being used. But 1,287 disk reads for just 20 rows is unusual. An index scan of 20 rows should read maybe 5-10 index pages + 20 heap pages. Something is wrong with the index.

**Step 3: Check index size vs expected.**

```sql
SELECT
  relname AS table,
  indexrelname AS index,
  pg_size_pretty(pg_relation_size(i.indexrelid)) AS index_size
FROM pg_stat_user_indexes i
JOIN pg_stat_user_tables t ON i.relid = t.relid
WHERE i.relname = 'orders';

-- Output:
-- orders | idx_orders_customer_created | 22 GB
-- Expected for 80M orders rows: ~5 GB. Actual: 22 GB. 4x bloat.
```

**Step 4: Understand why bloat accumulated.**

```sql
-- Check VACUUM activity:
SELECT relname, n_dead_tup, last_autovacuum, autovacuum_count
FROM pg_stat_user_tables WHERE relname = 'orders';
-- last_autovacuum: 6 weeks ago. n_dead_tup: 12,000,000 dead rows.
-- 6 weeks ago: a large batch job deleted 30M "archived" orders.
-- autovacuum ran once, then autovacuum_vacuum_threshold was too high to retrigger.
-- Dead index entries: accumulated. Index bloat compounded.
```

**Step 5: Fix.**

```sql
-- Force VACUUM to clean dead tuples immediately:
VACUUM ANALYZE orders;  -- Duration: ~20 minutes for 80M rows with 12M dead. Non-blocking.
-- Check n_dead_tup afterward: should be < 100,000 (autovacuum clears as it goes).

-- If bloat persists after VACUUM (index pages not repacked by VACUUM alone):
REINDEX INDEX CONCURRENTLY idx_orders_customer_created;
-- Duration: ~25 minutes. Zero write/read blocking.

-- After reindex:
EXPLAIN (ANALYZE, BUFFERS) -- re-run the query
-- Buffers: shared hit=18 read=4  ← back to normal! 22 reads vs 1,291 before.
-- Execution Time: 6ms.
```

**Prevention:**

```sql
-- Lower autovacuum threshold for the orders table:
ALTER TABLE orders SET (
  autovacuum_vacuum_scale_factor = 0.01,   -- trigger at 1% (800K rows) vs default 20%
  autovacuum_vacuum_cost_delay = 2         -- less aggressive throttling
);
-- Alert rule: index_size / expected_size > 2x → trigger investigation.
```

---

## SECTION 12 — Architect's Mental Model

```
=== Architect's Mental Model: B-Tree Index ===

┌─────────────────────────────────────────────────────────────────┐
│  PHILOSOPHY: The B-tree is the workhorse. Before reaching for   │
│  GIN, GiST, BRIN, or NoSQL, verify a well-tuned B-tree          │
│  cannot solve the problem. 95% of production index requirements  │
│  are satisfied by B-trees with correct column order and INCLUDE. │
└─────────────────────────────────────────────────────────────────┘

DECISION RULES:

1. Start with B-tree for all equality, range, and ORDER BY use cases.
   Consider alternatives only when B-tree provably doesn't fit:
   LIKE '%suffix' → pg_trgm GIN. Array containment → GIN. Geolocation → GiST.
   Append-only huge tables with date range → BRIN. Pure equality on UUID → Hash.

2. INCLUDE columns over wider composite keys for SELECT-only extras.
   Columns that you SELECT but never filter or sort by: put in INCLUDE.
   Result: narrower B-tree key (more entries/page, faster traversal) + index-only scan enabled.

3. Monitor index bloat monthly. B-tree indexes bloat from DELETE-heavy workloads.
   Every major batch delete: check index size vs expected. If > 1.5x: REINDEX CONCURRENTLY.
   Don't wait for performance to degrade before investigating.

4. Tune FILLFACTOR for tables with mixed INSERT + UPDATE of indexed columns.
   If UPDATE-heavy on index columns: set FILLFACTOR=70 to absorb updates without splits.
   If append-only: FILLFACTOR=100 for maximum density. Range scans read fewer pages.

5. Sequential PKs are a structural performance choice, not just an aesthetic one.
   BIGSERIAL or GENERATED ALWAYS AS IDENTITY: inserts always to rightmost leaf. Zero random splits.
   UUID v4 PKs: every insert hits a random leaf. High split rate. Index bloat. Slower writes.
   At >1M rows/day: the PK type measurably affects write throughput and index health.

COMMON MISTAKES:

1. Ignoring index bloat after large deletes.
   Deleting 50M rows from a 200M row table: frees heap space, but leaves dead index entries.
   VACUUM reclaims dead entries but doesn't repack the index. Index stays large (hollow).
   Only REINDEX CONCURRENTLY rebuilds the packed index. This regularly surprises engineers.

2. Using random UUID as PK on InnoDB (MySQL/Aurora MySQL).
   PostgreSQL: heap and index are separate. UUID PK → index splits don't move row data.
   MySQL InnoDB: clustered index. UUID PK → split moves ROWS. Catastrophic write amplification.
   The same UUID approach that is merely inefficient in PostgreSQL is a serious production
   performance problem in MySQL InnoDB. Know your engine.

3. Not running ANALYZE after bulk loads.
   Load 20M rows in one COPY statement. Statistics still reflect the pre-load state.
   Planner estimates wrong row counts. Wrong plans. SeqScans where Index Scans should be.
   Always: ANALYZE table after any bulk load affecting more than 5% of rows.

                     ╔══════════════════════════════════╗
  30-SECOND ANSWER → ║  B-TREE INDEX IN 30 SECONDS      ║
                     ╚══════════════════════════════════╝

"A B-tree index is a balanced sorted tree that lets the database find any value
in O(log N) time — typically 3-4 page reads — regardless of table size.
Leaf pages are linked as a sorted list, enabling efficient range scans.
It supports equality, range, prefix match, ORDER BY, and IS NULL.
B-trees need maintenance: they bloat from deletes and splits, which VACUUM
doesn't fully repair — REINDEX CONCURRENTLY does. Sequential primary keys
matter: they prevent random splits by always appending to the rightmost page.
FILLFACTOR controls how full pages are packed, trading read density for write
headroom. The B-tree is the right index for 95% of OLTP access patterns."
```
