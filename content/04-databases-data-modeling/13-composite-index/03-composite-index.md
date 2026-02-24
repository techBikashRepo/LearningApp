# Composite Index — Part 3 of 3

### Sections: 9 (AWS Service Mapping), 10 (Interview Q&A), 11 (Debugging Exercise), 12 (Architect's Mental Model)

**Series:** Databases & Data Modeling → Topic 13

---

## SECTION 9 — AWS Service Mapping

### Composite Index Behavior Across AWS Services

```
Aurora PostgreSQL:

  Composite indexes: full support. Same B-tree semantics as open-source PostgreSQL.
  INCLUDE columns (PG 11+): fully supported in Aurora PostgreSQL.
  Partial composite indexes (WHERE clause): fully supported.

  Aurora Performance Insights — composite index diagnosis:
    Performance Insights → Top SQL → filter by "wait event = IO:DataFileRead"
    High IO:DataFileRead on a specific query → index missing or incorrect column order.
    Click into the query → View SQL text → EXPLAIN ANALYZE via Query Editor or psql.
    Aurora automatically surfaces this bottleneck faster than manual monitoring.

  Aurora Parallel Query:
    Aurora MySQL: Parallel Query feature for analytical queries can scan large tables
    across multiple storage nodes simultaneously. Partially mitigates the need for
    composite indexes on analytical queries (not OLTP). PostgreSQL version uses parallel
    workers differently — managed via max_parallel_workers_per_gather.

RDS MySQL / Aurora MySQL:

  Composite indexes: fully supported. Same leading column rule as PostgreSQL.
  Column order matters identically: equality predicates first, range predicates last.

  MySQL-specific composite index behavior:
    Covering index: same concept as PostgreSQL. If the composite index covers all SELECT cols:
    "Using index" in EXPLAIN (MySQL) = Index-Only Scan in PostgreSQL.

    MySQL index condition pushdown (ICP):
    WHERE col_a = 1 AND col_b > 10 on index (col_a, col_b):
    MySQL can evaluate the col_b > 10 condition within the storage engine (pushed down),
    before fetching the full row. Reduces rows passed to the SQL layer.
    EXPLAIN: "Using index condition" = ICP active.
    PostgreSQL achieves same via index range scan natively (no separate "pushdown" concept).

    MySQL FORCE INDEX hint:
    If the planner makes a wrong choice (similar to PostgreSQL wrong plan after stale stats):
    SELECT * FROM orders FORCE INDEX(idx_orders_customer_created) WHERE ...;
    PostgreSQL equivalent: SET enable_seqscan = off; for the session (diagnostic only — never in production).
    Better in both cases: fix the statistics (ANALYZE / ANALYZE TABLE) rather than force hints.

DynamoDB:

  DynamoDB composite key:
    Primary key = partition key (required) + sort key (optional).
    This IS a composite key in DynamoDB. Both define the unique item identity.
    Range queries on sort key within a partition: efficient (sorted B-tree-like storage).

  GSI as composite index equivalent:
    GSI partition key + sort key = effectively a composite index.
    Query pattern: WHERE dept_id = $1 ORDER BY hire_date → GSI(dept_id, hire_date).

  DynamoDB leading column rule (same fundamental constraint):
    Cannot query by sort key alone without specifying the partition key.
    Same as PostgreSQL: cannot use index starting from the second column.

    Table: items(category PK, item_id SK) with GSI(status, created_at).
    Valid: Query WHERE status = 'active' ORDER BY created_at.
    Invalid: Query WHERE created_at > '2024-01-01' (no partition key = full scan).

  DynamoDB vs PostgreSQL composite index flexibility:
    PostgreSQL: add composite index in 15-30 minutes on existing 100M row table.
    DynamoDB GSI: created via API, backfills asynchronously (hours). Eventually consistent.
    DynamoDB: cannot modify GSI projection after creation (must delete + recreate GSI).
    PostgreSQL: add INCLUDE column to existing index via REINDEX CONCURRENTLY.
    PostgreSQL composite indexes are far more flexible and faster to iterate on.

Amazon Redshift:

  Redshift: columnar store. No B-tree composite indexes.

  Composite sort key: the closest equivalent.
  CREATE TABLE orders (
    customer_id BIGINT,
    status      VARCHAR(20),
    created_at  TIMESTAMP,
    total       DECIMAL(12,2)
  ) SORTKEY (customer_id, status, created_at);
  -- Data is physically sorted on disk by (customer_id, status, created_at).
  -- Range scans on leading columns: can skip most of the data (zone maps).
  -- Redshift zone maps: per-block min/max values. If block min > query value: skip the block.
  -- Leading column rule applies: query on customer_id alone → zone map filtering on first column.
  -- Range scan on status alone → no zone map benefit (not leading column).

  Interleaved sort key: balanced across all sort key columns. Higher VACUUM maintenance cost.

  Composite distribution key:
  DISTKEY(customer_id) ensures all orders for one customer go to the same node.
  Joins on customer_id → collocated join. No network shuffle. Much faster for customer-centric queries.
```

---

## SECTION 10 — Interview Questions & Answers

### Beginner Level

**Q1: What is the leading column rule for composite indexes?**

The leading column rule states that a composite index `(A, B, C)` can only be used by a query if the query's filter includes the first (leading) column A. The index stores data sorted first by A, then by B within each A group, then by C within each B group.

If a query filters only on B or C — without filtering on A — the database has no way to jump to a specific location in the index. It would have to scan the entire index to find matching B or C values, which is usually worse than a sequential table scan. The planner ignores the index in this case.

What can use the index: `WHERE A = ?` (A alone), `WHERE A = ? AND B = ?` (A+B), `WHERE A = ? AND B = ? AND C = ?` (all three), `WHERE A = ? AND C = ?` (A alone first, C filtered after). What cannot: `WHERE B = ?` alone, `WHERE C = ?` alone, `WHERE B = ? AND C = ?`.

---

**Q2: Why should equality predicates come before range predicates in a composite index?**

Because once the B-tree encounters a range predicate ( `>`, `<`, `BETWEEN`), it cannot narrow the scan for subsequent columns. Consider an index `(status, created_at)` vs. `(created_at, status)` for a query `WHERE status = 'PENDING' AND created_at > '2024-01-01'`.

With `(status, created_at)`: the B-tree first narrows to all `PENDING` rows (equality), then within that narrow group does a range scan on `created_at`. Very efficient — small set of rows, small range scan.

With `(created_at, status)`: the B-tree starts with the range on `created_at` — this could match 60% of all rows (since 2024). It cannot then efficiently filter by `status` within that range because `status` is not sorted independently; it's only sorted WITHIN each `created_at` value. The planner may scan a huge portion of the index and filter `status` afterward. Much more expensive.

Always: put equality columns first, range columns (or ORDER BY columns) last.

---

**Q3: What is a covering index, and when is it beneficial?**

A covering index (also called an index-only scan in PostgreSQL) is an index that contains all the columns needed by a query — both the filter columns and the SELECT columns. When the database can get all its answers from the index alone, it never reads the heap (the main table storage).

This is beneficial when : (1) the query is executed very frequently, (2) the table is large (heap reads are expensive), and (3) the SELECT column list is small and stable (doesn't frequently change). The speed-up is typically 5–50x compared to a non-covering index scan because random heap page reads are the bottleneck and they're eliminated entirely.

In PostgreSQL, use `INCLUDE (col3, col4)` to add non-key SELECT columns to the index leaf pages — making the index covering without adding those columns to the sort key.

---

### Intermediate Level

**Q4: A query uses two columns in a composite index but the query is still slow. What could explain this?**

Several non-obvious causes:

1. **Wrong column order**: the range-predicate column leads the composite. The planner must scan a large portion of the index before filtering the equality column.
2. **Stale statistics**: the planner estimates 10 rows, chooses an Index Scan, but the actual result is 500,000 rows. The plan is correct given the estimate but terrible for reality. Fix: `ANALYZE`.
3. **Index used but heap fetches dominate**: the composite index finds the rows but then fetches each row from the heap (random I/O). If 50,000 rows match, that's 50,000 random page reads. The index traversal is fast; the heap access is slow. Fix: add `INCLUDE` columns to enable index-only scan.
4. **Sort not covered**: query has `ORDER BY` on a third column not in the index. Plan: Index Scan (fast) + Sort (spill to disk if large result). Fix: add the ORDER BY column as the trailing column in the composite index.
5. **Correlated subquery in the projection**: the index IS being used for the WHERE clause, but a correlated subquery in SELECT runs for every returned row. The index isn't the bottleneck; the subquery is.

---

**Q5: How does the planner decide between a Bitmap And on two separate indexes vs a single composite index?**

The planner estimates the cost of both plans using statistics:

**Bitmap And path:**

1. Bitmap Index Scan on `idx_orders_customer` → builds bitmap of pages for `customer_id = 42`.
2. Bitmap Index Scan on `idx_orders_status` → builds bitmap of pages for `status = 'PENDING'`.
3. BitmapAnd: intersect both bitmaps → pages containing rows matching BOTH predicates.
4. Bitmap Heap Scan: fetch those pages from heap.

**Composite index path:**

1. Index Scan on `idx_orders_customer_status` → directly descends to `(customer_id=42, status='PENDING')` subtree.
2. Sequential leaf scan within that subtree.
3. Heap fetch only for those rows.

The composite is more efficient for most cases because it avoids building two bitmaps and performing an intersection. But the planner may choose BitmapAnd when: (1) no composite index exists, (2) the selectivity of each single-column filter is high enough that the intersection reduces the heap pages significantly, or (3) after a new composite index is created but statistics haven't yet reflected it (`pg_stat_user_indexes.idx_scan = 0`).

---

### Advanced Level

**Q6: Design the optimal index strategy for this query pattern: millions of users, billions of events, querying by user + time window + event type, paginating by time descending.**

```sql
-- Query:
SELECT event_id, event_type, metadata, occurred_at
FROM events
WHERE user_id = $1
  AND occurred_at BETWEEN $2 AND $3
  AND event_type = $4
ORDER BY occurred_at DESC
LIMIT 20 OFFSET $5;
```

**Analysis:**

- `user_id`: equality — highest cardinality of the filter columns (millions of users). Must be first.
- `event_type`: equality — but lower cardinality. Second.
- `occurred_at`: range + ORDER BY. Must be last key column.
- SELECT columns: `event_id, event_type, metadata, occurred_at` — can cover with INCLUDE.

**Optimal index:**

```sql
CREATE INDEX idx_events_user_type_time
ON events(user_id, event_type, occurred_at DESC)
INCLUDE (event_id, metadata);

-- Alternatively, if event_type queries are absent frequently:
CREATE INDEX idx_events_user_time
ON events(user_id, occurred_at DESC)
INCLUDE (event_id, event_type, metadata);
-- Use the simpler 2-column key if event_type filter is only present 20% of the time.
-- Two indexes (one with event_type, one without) for different query shapes = index bloat.
-- Preferred: single index that works for both forms.
```

**OFFSET problem:** `OFFSET $5` is inherently expensive — it must skip `OFFSET` rows even with the index. At `OFFSET 10000`: reads 10,020 rows to return 20. Known as the "offset pagination problem."

**Better pagination pattern:** keyset pagination:

```sql
WHERE user_id = $1 AND event_type = $4
  AND (occurred_at, event_id) < ($last_occurred_at, $last_event_id)
ORDER BY occurred_at DESC, event_id DESC
LIMIT 20;
-- Uses the index to jump directly to the page boundary. O(1) pagination at any depth.
```

---

**Q7: How would you diagnose and fix a composite index that existed for 3 months but was never used by the planner?**

```sql
-- Step 1: Confirm it has 0 scans
SELECT indexrelname, idx_scan FROM pg_stat_user_indexes WHERE indexrelname = 'idx_orders_;

-- Step 2: Check index definition
SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_orders_...';
-- e.g., CREATE INDEX idx_orders_customer_status ON orders(customer_id, status)

-- Step 3: Check what queries are running against the table
SELECT query FROM pg_stat_statements WHERE query LIKE '%orders%' ORDER BY calls DESC LIMIT 20;

-- Step 4: EXPLAIN the top queries
EXPLAIN SELECT * FROM orders WHERE status = 'pending' AND created_at > NOW() - INTERVAL '7d';
-- If: "Seq Scan — Filter: (customer_id = $1 AND status = 'pending')"
-- The composite index has (customer_id, status). This query starts with status, not customer_id.
-- Leading column mismatch → planner cannot use this index.

-- Step 5: Fix — rebuild with correct column order matching actual queries
DROP INDEX CONCURRENTLY idx_orders_customer_status;
CREATE INDEX CONCURRENTLY idx_orders_status_created ON orders(status, created_at);
-- Or if queries always have customer_id: verify why they don't match. Different column?
-- Or: the table has only 10,000 rows — planner always prefers SeqScan. Index appropriate?

-- Step 6: After 2 weeks, check idx_scan again. If still 0: the query pattern doesn't match.
-- Drop the index. It is pure write overhead with zero read benefit.
```

---

## SECTION 11 — Debugging Exercise

### Production Incident: Wrong Composite Index Column Order

**Scenario:**
Your nightly reconciliation job queries orders placed in the last 24 hours for each payment provider. Monday and Tuesday it runs in 45 seconds. After Wednesday's deployment (which added 3 new payment providers), it now runs for 18 minutes and times out your Lambda function.

---

**Step 1: Identify the query.**

```sql
-- From the reconciliation job source code:
SELECT * FROM orders
WHERE payment_provider = $1
  AND created_at BETWEEN NOW() - INTERVAL '24 hours' AND NOW()
  AND status = 'CAPTURED';
-- Runs once per provider: 8 times (now 11 after deployment).
-- Previously: 3 providers × 45s/11 = 12.3s avg per provider query.
-- Now: 18 minutes total. Something changed with the new providers.
```

**Step 2: EXPLAIN on the slow query (for one of the new providers).**

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM orders
WHERE payment_provider = 'crypto_pay'  -- new provider
  AND created_at BETWEEN NOW() - INTERVAL '24 hours' AND NOW()
  AND status = 'CAPTURED';

-- OUTPUT:
-- Index Scan using idx_orders_created_provider on orders
--   (cost=0.56..982000 rows=125000 actual rows=82 width=312)
--   Index Cond: (created_at BETWEEN ... )
--   Filter: ((payment_provider = 'crypto_pay') AND (status = 'CAPTURED'))
--   Rows Removed by Filter: 124918     ← 125,000 rows scanned to find 82!
-- Buffers: shared hit=1200 read=8400
-- Execution Time: 98,421ms  (98 seconds!)
```

**Step 3: Understand the index.**

```sql
SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_orders_created_provider';
-- OUTPUT:
-- CREATE INDEX idx_orders_created_provider ON orders USING btree (created_at, payment_provider)
-- Leading column: created_at (range predicate). Second: payment_provider (equality).
-- For old providers (visa, mastercard, paypal): high volume. Many rows → many post-filter hits.
-- For new providers (crypto_pay, etc): low volume. Same 24-hour created_at range → 125K rows scanned.
-- But only 82 match provider. 99.9% of index scan result filtered away.
-- The wrong column order is exposed by low-volume providers.
```

**Step 4: Build the correct index.**

```sql
-- Correct order: equality first (payment_provider), range last (created_at)
CREATE INDEX CONCURRENTLY idx_orders_provider_created
ON orders(payment_provider, status, created_at);
-- payment_provider = 'crypto_pay' → narrow to ~82 rows. Then status filter. Then time range.

-- After creation (25 minutes), re-explain:
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM orders
WHERE payment_provider = 'crypto_pay'
  AND created_at BETWEEN ...
  AND status = 'CAPTURED';
-- Output:
-- Index Scan using idx_orders_provider_created
--   rows=82 actual rows=82. No filter!
-- Buffers: shared hit=5 read=2
-- Execution Time: 1.2ms
```

**Step 5: Drop old index.**

```sql
-- Old index (wrong column order). Check it's no longer needed:
-- Large providers (visa): re-test. New index also serves them (payment_provider is equality).
-- Confirmed all provider queries use new index.
DROP INDEX CONCURRENTLY idx_orders_created_provider;
-- Write overhead of old wrong index: eliminated.
```

**Before/after:** 98 seconds per query → 1.2ms. Reconciliation job: 18 minutes → < 15 seconds.

---

## SECTION 12 — Architect's Mental Model

```
=== Architect's Mental Model: Composite Index ===

┌─────────────────────────────────────────────────────────────────┐
│  PHILOSOPHY: One well-designed composite index beats three       │
│  single-column indexes in almost every scenario.                 │
│  Design composite indexes by reading your query WHERE clauses — │
│  not by "this table has these columns, let me index them all."  │
└─────────────────────────────────────────────────────────────────┘

DECISION RULES:

1. Order rule: equality predicates first (most selective first), range/ORDER BY last.
   "Which columns filter with = ?" → put them at the front.
   "Which column has ORDER BY or a range?" → put it last.
   Violating this rule: the index may exist but scan far more rows than necessary.

2. Check if you can make it covering. Once you have (A, B, range_col):
   Look at SELECT columns. If they're a small set (3-5 columns), add them via INCLUDE.
   INCLUDE: zero cost on tree traversal. Only adds leaf page size. Enables index-only scan.
   Net result: zero heap fetches for the most frequent query. 5-50x latency reduction.

3. One composite is usually better than two singles for a combined predicate.
   BitmapAnd (two single indexes merged) works, but a direct composite descent is cheaper.
   Target: if a query always filters on A AND B, those two columns belong in one composite.

4. Partial composite index on the common case.
   If 95% of queries filter WHERE status = 'PENDING': add that WHERE clause to the index.
   Partial composite: 20-50x smaller than full composite. Planner uses it for matching queries.
   Dramatically reduces write overhead (non-PENDING inserts/updates don't touch this index).

5. Validate new composite indexes with hypopg before creating on large tables.
   Creating an index on a 500M row table: 30-60 minute operation, even CONCURRENTLY.
   Use hypopg to confirm the planner WOULD use it before paying the creation cost.
   Only CONCURRENTLY after validation.

COMMON MISTAKES:

1. Adding a composite when a partial would suffice.
   "I need a composite (status, customer_id) for PENDING orders" →
   Actually: partial index on (customer_id) WHERE status = 'PENDING' is smaller and equally fast.
   Check whether the extra key column is needed vs using a WHERE clause on the index.

2. Not updating composite indexes when query patterns change.
   Index was designed for `WHERE customer_id = ? AND status = ?`.
   Three months later: most queries are `WHERE customer_id = ? AND region = ? ORDER BY total`.
   Old composite: still used for old pattern, ignored for new pattern.
   Regular audit: compare pg_stat_statements top queries vs existing index definitions.
   Evolve indexes as query patterns evolve.

3. Duplicating composite columns across multiple indexes without consolidating.
   idx_orders_a on (customer_id, status).
   idx_orders_b on (customer_id, created_at).
   idx_orders_c on (customer_id, status, created_at).
   Index _c: makes _a and _b redundant (it can serve both their queries as well as combined).
   Result: 3 indexes writing overhead where 1 would suffice. Debt accumulates over years.

                     ╔══════════════════════════════════╗
  30-SECOND ANSWER → ║  COMPOSITE INDEX IN 30 SECONDS   ║
                     ╚══════════════════════════════════╝

"A composite index is a B-tree built on two or more columns, sorted lexicographically.
It's most powerful when designed to match your actual query WHERE clauses exactly:
equality predicates first (most selective ones first), range predicates or ORDER BY column last.
The leading column rule is absolute: without the leading column in your filter,
the index cannot be used. A covering composite — with INCLUDE columns for SELECT
extras — enables index-only scans, eliminating all heap reads. One well-ordered
composite typically replaces two or three single-column indexes and outperforms them,
because a direct B-tree descent beats a Bitmap AND intersection every time."
```
