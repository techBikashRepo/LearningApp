# EXPLAIN ANALYZE — Part 1 of 3

### Sections: 1 (Intuition & Analogy), 2 (Why This Exists), 3 (Internal Working), 4 (Query Execution Flow)

**Series:** Databases & Data Modeling → Topic 25

---

## SECTION 1 — Intuition & Analogy

### The GPS Navigation vs Actual Drive Report

Before GPS, you planned a route on a map: "I'll take Highway 5 to Exit 42, then 3 miles on Oak Street." That's the plan — based on estimated distances and speeds. The actual drive might differ: construction on Highway 5 added 20 minutes, Oak Street was congested.

`EXPLAIN` is the PostgreSQL query planner's route estimate: "I plan to use the index on `created_at`, estimate 4,200 rows, estimate 180ms cost." It's the map-based plan. The planner makes this estimate using statistics but has NOT executed the query yet.

`EXPLAIN ANALYZE` is the actual drive with a GPS recorder: PostgreSQL EXECUTES the query, records exactly what happened — how many rows were actually returned at each step, how long each node actually took — and presents both the plan AND the actual measurements.

```
EXPLAIN (plan only):
  Hash Join  (cost=1200..8800 rows=4200 width=48)
              ^^^^^^           ^^^^^
              estimated cost   estimated rows

  "The planner thinks this will cost 8800 units and return 4200 rows."
  Zero actual execution. Instantaneous. READ-ONLY (safe for production).

EXPLAIN ANALYZE (plan + actual execution):
  Hash Join  (cost=1200..8800 rows=4200 width=48)
             (actual time=220..890 rows=41332 loops=1)
                           ^^^        ^^^^^
                           actual time  actual rows!

  "The planner estimated 4200 rows. Actually returned 41,332 rows. 10x off.
   The planner's statistics are stale. This is why the query is slow."

  CAUTION: EXPLAIN ANALYZE actually executes the query.
  For SELECT: safe (reads-only, returns result set internally, discards it).
  For INSERT/UPDATE/DELETE: executes the modification. Use with ROLLBACK:
    BEGIN; EXPLAIN ANALYZE UPDATE ...; ROLLBACK;
```

---

## SECTION 2 — Why This Problem Exists (Production Failures)

### Real-World Incidents: Solved by EXPLAIN ANALYZE

**Incident 1: "We Added an Index, It Got Slower"**
Platform: PostgreSQL 14, orders table 200M rows. Team added `CREATE INDEX idx_orders_status ON orders(status)`. Query performance: WORSE after the index. Query: `SELECT * FROM orders WHERE status = 'pending' ORDER BY created_at LIMIT 20`.

Without EXPLAIN ANALYZE: "the index isn't being used" or "the index is wrong." Days of guessing.

With EXPLAIN ANALYZE (2 minutes):

```
Index Scan using idx_orders_status on orders (cost=..)(actual rows=180,000,000)
  Filter: (status = 'pending')
  Rows Removed by Filter: 0
Sort (actual rows=180,000,000)  ← SORTING 180M ROWS!
Limit
```

Discovery: 90% of rows have `status = 'pending'`. The index has 0% selectivity on this value. PostgreSQL used the index (technically correct) but then had to sort 180M rows. Fix: create an index on `(created_at) WHERE status = 'pending'` — a partial index. Sort is eliminated, limit is applied early. Query: 2ms.

---

**Incident 2: "The Query Was Fine Last Week"**
Platform: dashboard query, ran in 80ms for 6 months. Suddenly: 14,000ms. No code changes.

EXPLAIN ANALYZE revealed:

```
Hash Join (actual rows=8,200,000 loops=1)  ← hash join building 8M row hash table!
  Previously: (actual rows=4,200)          ← size grew 2,000x after data growth
```

PostgreSQL's statistics were stale. `autovacuum_analyze_scale_factor = 0.2` — analyze triggers at 20% of table change. Table had grown from 50K to 10M rows. Analyze hadn't triggered proportionally. Fix: `ANALYZE events;` immediately + `ALTER TABLE events SET autovacuum_analyze_scale_factor = 0.01`.

---

**Incident 3: "The ORM Query Takes 5 Seconds"**
Platform: Django ORM, complex queryset with `.filter().annotate().order_by()`. Developer: "the ORM is slow." EXPLAIN ANALYZE revealed: the ORM was generating a query with a correlated subquery executed once per row. 50,000 rows × 1 subquery = 50,000 sub-executions. Fix: rewrite as a JOIN. Query time: 5,000ms → 40ms.

---

## SECTION 3 — Internal Working

### Anatomy of EXPLAIN ANALYZE Output

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT c.name, o.id, o.total_cents
FROM orders o
JOIN customers c ON c.id = o.customer_id
WHERE o.status = 'processing'
  AND o.created_at >= '2024-01-01'
ORDER BY o.created_at DESC
LIMIT 100;
```

**Full annotated output:**

```
Limit  (cost=1240.56..1240.81 rows=100 width=48)
       (actual time=18.432..18.445 rows=100 loops=1)
  →  Sort  (cost=1240.56..1245.56 rows=2000 width=48)
           (actual time=18.428..18.433 rows=100 loops=1)
       Sort Key: o.created_at DESC
       Sort Method: top-N heapsort  Memory: 32kB        ← efficient: only keeps top 100
       →  Hash Join  (cost=420.00..1180.00 rows=2000 width=48)
                    (actual time=4.218..17.890 rows=1847 loops=1)
            Hash Cond: (o.customer_id = c.id)
            Buffers: shared hit=2840 read=156            ← 156 pages from disk (cache miss)
            →  Bitmap Heap Scan on orders o
                 (cost=80.00..700.00 rows=2000 width=32)
                 (actual time=1.234..12.450 rows=1847 loops=1)
                 Recheck Cond: (status = 'processing' AND created_at >= '2024-01-01')
                 Heap Blocks: exact=1234
                 Buffers: shared hit=1256 read=154
                 →  BitmapAnd
                      →  Bitmap Index Scan on idx_orders_status
                           (actual rows=8420)  ← status filter: 8420 candidates
                      →  Bitmap Index Scan on idx_orders_created_at
                           (actual rows=120000)  ← date filter: 120K candidates
                         Combined: 1847 rows (intersection of both bitmaps)
            →  Hash
                 (cost=200.00..200.00 rows=17600)
                 (actual time=2.980..2.980 rows=17600 loops=1)
                 Buckets: 32768  Batches: 1  Memory Usage: 1856kB   ← in-memory hash
                 →  Seq Scan on customers c
                      (cost=0..165.00 rows=17600)
                      (actual time=0.012..1.890  rows=17600 loops=1)
                      Buffers: shared hit=165

Planning Time: 0.842 ms
Execution Time: 18.621 ms
```

**Reading the output — key fields:**

```
cost=startup..total
  startup: cost to return FIRST row. High startup = expensive setup (sort, hash build).
  total:   cost to return ALL rows. Scale is relative (seq_page_cost=1.0 as baseline).
  UNIT: not milliseconds. Relative cost units for planner comparison.

actual time=first_row..last_row  (milliseconds)
  first_row: time to start returning rows.
  last_row:  time when all rows returned.
  This IS wall-clock time in milliseconds.

rows=N (in plan) vs rows=M (in actual)
  If plan >> actual: planner over-estimated. Stats may cause wrong join order.
  If actual >> plan: planner under-estimated. Hash joins may spill to disk.
  Ratio > 10x: stale statistics or poor histogram. Run ANALYZE.

loops=N
  How many times this node executed. Nested loop inner: loops = outer rows.
  actual time is PER LOOP. Total = actual_time × loops.
  Missed: actual time=50ms loops=1000 → 50 SECONDS total for this node.

Buffers: shared hit=N read=M
  hit: pages served from shared_buffers (in-memory cache). Fast.
  read: pages fetched from disk (or OS page cache). Slower.
  High read: page cache miss. Consider: more shared_buffers, CLUSTER, or BRIN.

Sort Method:
  "quicksort Memory: 25MB" → in-memory sort. Fast.
  "external merge Disk: 512MB" → sort spilled to disk. 100x slower. Increase work_mem.
```

---

**The most important diagnostic signals:**

```
Signal 1: rows estimate vs actual >> 10x
  Cause: stale statistics, non-uniform distribution, correlated columns.
  Fix: ANALYZE table; or SET default_statistics_target = 200; ANALYZE;
  Or: CREATE STATISTICS for correlated columns.

Signal 2: "external merge Disk" in Sort
  Cause: work_mem too low for this sort.
  Fix: SET work_mem = '256MB'; (session-level) or increase globally.

Signal 3: loops=N with high actual time
  Cause: nested loop join with many outer rows.
  Fix: add index on inner join column, or encourage hash join (SET enable_nestloop = off;).

Signal 4: Seq Scan on large table
  Cause: no index, or index exists but planner chose not to use it (low selectivity, stale stats).
  Fix: check correlation, check n_distinct, run ANALYZE, add partial index.

Signal 5: Hash Join with "Batches: N > 1"
  Cause: hash table didn't fit in work_mem. Spilled to disk.
  Fix: increase work_mem. Hash batches = number of disk passes = Nx slower.
```

---

## SECTION 4 — Query Execution Flow

### Reading EXPLAIN ANALYZE Like a Senior Engineer

**Step-by-step reading method:**

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT u.email, COUNT(o.id) AS order_count
FROM users u
LEFT JOIN orders o ON o.user_id = u.id
WHERE u.created_at >= '2024-01-01'
GROUP BY u.id, u.email
ORDER BY order_count DESC
LIMIT 10;
```

**Rule 1: Read bottom-up, inside-out.**
The innermost, deepest-indented nodes execute first. Build your understanding from leaves to root.

**Rule 2: Find the widest gap between estimated and actual rows.**
That's where the planner went wrong.

```
Annotated reading order:

Step 1: DEEPEST node (executes first):
  →  Index Scan on users (idx_users_created_at)
       (cost=0.56..1240 rows=42000)(actual rows=89421 loops=1)
       ← Planner: 42,000 users created in 2024. Actual: 89,421. 2x underestimate.
       ← Root cause: statistics sample was from when fewer users existed.
       ← Impact: the planner under-sized the hash table for the next join.

Step 2: NEXT node up:
  →  Hash (Batches: 4  Memory Usage: 12MB)
       ← "Batches: 4" means the hash table spilled to disk 4 times!
       ← The planner expected 42K users (small hash), got 89K (large hash → spill).
       ← This is the performance bottleneck.

Step 3: NEXT node:
  →  Hash Join Hash Cond: (o.user_id = u.id)
       (actual time=840..12450)
       ← 12.4 seconds in this join. Caused by the hash spill.

Step 4: ROOT node:
  GroupAggregate (actual time=12450..12460)
  Sort (actual time=12460..12462)
  Limit (actual time=12462..12462 rows=10)
  Total execution: 12,462ms.

Diagnosis: stale stats → wrong cardinality estimate → undersized hash → disk spill → slow.

Fix:
  ANALYZE users;                          -- update statistics
  -- After analyze: planner estimates 89K → sizes hash correctly → no spill
  -- Expected time after fix: 240ms
```

**EXPLAIN ANALYZE diagnostic workflow:**

```
1. Run EXPLAIN (ANALYZE, BUFFERS) → get actual execution data.
2. Find the most expensive node: highest "actual time" top-level difference.
3. Check: estimated rows vs actual rows.
   >10x difference → stale stats. Run ANALYZE.
4. Check: Sort Method. "external merge" → increase work_mem.
5. Check: Buffers read. High disk reads → cold cache or missing index.
6. Check: loops × actual time. High product → nested loop problem. Add index/change join type.
7. After fix: re-run EXPLAIN ANALYZE. Confirm improvement.
```
