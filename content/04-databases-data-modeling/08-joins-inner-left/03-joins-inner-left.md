# Joins (INNER, LEFT) — Part 3 of 3

### Sections: 9 (AWS Mapping), 10 (Interview Questions), 11 (Debugging Exercise), 12 (Architect's Mental Model)

**Series:** Databases & Data Modeling → Topic 08

---

## SECTION 9 — AWS Service Mapping

### Joins Across AWS Data Services

```
RDS / AURORA (PostgreSQL):
  JOIN ALGORITHM SELECTION:
    The planner chooses: Nested Loop, Hash Join, or Merge Join based on table sizes,
    estimated row counts, and index availability.

    Override parameters (for tuning without query rewrite):
      SET enable_hashjoin = OFF;    -- force away from hash join (e.g., debugging memory spill)
      SET enable_mergejoin = OFF;   -- force away from merge join
      SET enable_nestloop = OFF;    -- disable nested loop (for large table joins only)
      Note: global disabling risky. Use in a single session for testing. Revert after.

  HASH JOIN MEMORY:
    work_mem: per-sort / per-hash-table. E.g., 64MB work_mem, complex query with 4 hash joins
    → up to 256MB memory per backend for that query (4 × 64MB).
    EXPLAIN (ANALYZE, BUFFERS): shows "Batches: N" — if N > 1: hash table spilled to disk.
    Aurora instance: r6g.2xlarge = 64GB RAM. With connection pool of 200 connections:
    64MB work_mem × 200 connections × 4 joins = 51.2GB potential memory. Plan carefully.

  AURORA PARALLEL QUERY:
    Available: Aurora MySQL 5.6/5.7/8.0 compatible. Not Aurora Postgres natively.
    JOIN BENEFIT: parallel query can parallelize the scan + filter phase of each join input.
    The probe phase of a hash join: can be parallelized against the storage tier.
    Large join of big tables (each 100M+ rows): parallel query reduces scan time by 2-8x.
    Restriction: only applies to tables fully in Aurora Optimized Reads storage tier.
    Check: EXPLAIN output shows "Using parallel query" for each table.

REDSHIFT:
  JOIN DISTRIBUTION IS THE CRITICAL DESIGN DECISION.

  DIST KEY (EVEN) + MISMATCHED JOIN:
    Table A: DISTKEY(customer_id). Table B: DISTKEY(order_id).
    A JOIN B ON A.order_id = B.order_id: mismatched distkeys.
    Redshift: MUST shuffle one entire table across all nodes before joining.
    EXPLAIN output: DS_BCAST or DS_DIST marker on the join.
    DS_DIST: redistribute one table (T1 network transfer), then join locally on each node.
    DS_BCAST: broadcast smallest table to all nodes. Acceptable for small tables (<10M rows).

  CO-LOCATED JOIN (optimal):
    Both tables: DISTKEY on the JOIN column.
    A.DISTKEY(customer_id) JOIN B.DISTKEY(customer_id): both tables slice by customer_id.
    Each Redshift slice processes its own customers' rows. No network transfer. Best performance.
    Design rule: fact tables distributed on their most-joined dimension. Dimension tables:
    small → DISTSTYLE ALL (broadcast copy on every node, never moved during joins).

  SORT KEY:
    Columns used in JOIN + WHERE + GROUP BY: candidate for SORT KEY.
    Sorted data: allows zone map optimization (skip entire blocks if value range doesn't match).
    Example: SORTKEY(created_at) + WHERE created_at > '2024-01-01': scans only recent blocks.
    Compound SORTKEY: (user_id, created_at) — benefits queries filtering both columns in that order.
    Interleaved SORTKEY: all columns equally weighted — useful when query patterns vary.

AMAZONATHENA (Presto/Trino engine):
  JOINS ON S3 DATA:
    Athena: stateless, serverless. Every query: fresh worker allocation.
    JOIN performance: depends on data format, partitioning, file size.

  BROADCAST JOIN (SMALL + LARGE):
    Athena: automatically uses broadcast join when one table is small (< ~4GB in practice).
    Small table: broadcast to all workers.
    Large table: scanned in parallel across workers. Each worker has the small table in memory.
    No shuffle needed. Equivalent to Redshift DS_BCAST. Fastest join pattern in Athena.

  SHUFFLE JOIN (LARGE + LARGE):
    Both tables large: Athena shuffles rows by join key to co-locate matching rows.
    Network-intensive. Can spill to disk. Slow for very large joins (100GB+ each table).
    Optimization: partition both tables by join column. Partition pruning reduces shuffle data.
    Example: both tables partitioned by date → join with WHERE date = '2024-03' → each worker
    processes only March partition. Avoids global shuffle.

  EXPLAIN:
    Athena doesn't expose full EXPLAIN in console. Use:
    EXPLAIN EXTENDED <your query> → shows join types, distribution, estimated rows.
    Important for diagnosing cross-partition shuffle joins.

DYNAMODB:
  NO JOIN OPERATION. DynamoDB has no SQL JOIN. Period.

  PATTERN 1: Single-Table Design (STD).
    All entities in one table. PK and SK overloaded to represent multiple entity types.
    PK = USER#user_id, SK = ORDER#order_id → retrieves all a user's orders.
    PK = ORDER#order_id, SK = ITEM#item_id → retrieves all items in an order.
    "Join" at query time: Query by PK, filter by SK prefix. Single GetItem / Query call.

  PATTERN 2: Application-Side Join (anti-pattern at scale).
    Query DynamoDB to get order IDs. For each order: call GetItem for order detail.
    100 orders = 101 GetItem calls = N+1 problem. Never do this in hot paths.
    Exception: batch up to 100 items: BatchGetItem → 1 API call for 100 items.

  PATTERN 3: GSI for reverse lookup (replaces SQL reverse JOIN direction).
    PK = order_id (primary access pattern).
    GSI: PK = customer_id, SK = order_date → "get all orders by customer" access pattern.
    GSI is the DynamoDB substitute for adding a "join direction" you didn't design for originally.

NEPTUNE (Graph Database):
  When query pattern fundamentally is a JOIN chain: consider Graph DB.
  "Find all friends of friends of user X within 2 hops" = recursive self-JOIN in SQL.
  Neptune: Gremlin traversal: g.V(user_id).out('FRIENDS').out('FRIENDS').dedup()
  Much more natural. SQL double-self-join with dedup = expensive + hard to read.
  Neptune use case: social graphs, fraud networks, recommendation engines, access control trees.
```

---

## SECTION 10 — Interview Questions

### Beginner Questions

**Q1: What is the difference between INNER JOIN and LEFT JOIN?**

> INNER JOIN: returns only rows where the join condition matches in BOTH tables.
> If a row in the left table has no matching row in the right table: excluded entirely.
> LEFT JOIN (also LEFT OUTER JOIN): returns all rows from the left table, plus any matching
> rows from the right table. When no match exists: right-table columns appear as NULL.
> Practical difference: if you're reporting products and some products have no orders,
> INNER JOIN ignores those products. LEFT JOIN includes them with null order data.
> Which to use: INNER when you only care about rows with complete relationships.
> LEFT when left-table rows may have no related right-table rows and you want them anyway.

**Q2: What causes a Cartesian product in SQL and why is it catastrophic?**

> A Cartesian product occurs when you join two tables without a JOIN condition (or with one that
> always evaluates to TRUE, or simply by listing two tables in FROM without a JOIN keyword).
> Result: every row in the left table is paired with every row in the right table.
> With 1,000 rows × 1,000 rows = 1,000,000 output rows.
> With 1,000,000 rows × 1,000,000 rows = 1,000,000,000,000 rows — database will never finish.
> In practice: a missing ON clause in a JOIN, or CROSS JOIN (explicit), or old-style comma:
> `FROM orders, customers` without a WHERE clause.
> Fix: always use explicit JOIN...ON syntax. The optimizer cannot rescue a Cartesian product —
> the massive result set itself is the problem, not the execution strategy.

**Q3: Why does moving a filter from WHERE to ON in a LEFT JOIN change the results?**

> LEFT JOIN semantics: rows from the left table that don't match the join condition are still
> returned, with NULL in the right-table columns.
> Filter in ON clause: applied during the join phase. Non-matching rows: kept in result with NULLs.
> Filter in WHERE clause: applied AFTER the join. Any rows where the right-table column IS NULL
> (including rows that had no match) are excluded → converts the LEFT JOIN into an INNER JOIN.
> Example:
> LEFT JOIN orders ON orders.customer_id = c.id AND orders.status = 'completed'
> → customers with no completed orders appear: NULL in order columns. ✓
> LEFT JOIN orders ON orders.customer_id = c.id WHERE orders.status = 'completed'
> → customers with no completed orders excluded (NULL != 'completed' → excluded). ✗
> Rule: filters on the right-table of a LEFT JOIN always go in the ON clause, never WHERE.

### Intermediate Questions

**Q4: Walk through the three join algorithms PostgreSQL uses and explain when each is appropriate.**

> Nested Loop: for each row in the outer table, scan the inner table for matching rows (using index if available).
> Best when: outer table is very small (< ~1,000 rows) and inner table has an index on the join column.
> Terrible when: outer table is large — O(outer × inner) without index = full scan per outer row.
>
> Hash Join: build a hash table from the smaller table in memory; probe with each row from the larger.
> Best when: both tables are large, no useful index on the join column, memory available for the build phase.
> Memory: hash table must fit in work_mem. If not: spill to disk (Batches > 1). Still correct, just slower.
>
> Merge Join: both tables already sorted on the join key (or sorting is cheap); linearly merge them.
> Best when: both tables have an index (or are pre-sorted), join produces large result sets.
> Can do: sort before merge (explicit sort node in plan) — cost worth it for very large result sets.
> Worst when: data is unsorted and sort cost > hash build cost.

**Q5: A query with a hash join is showing `Batches: 8` in EXPLAIN ANALYZE. What does that mean and how do you fix it?**

> `Batches: 1`: the entire hash table fits in one pass in memory. Fast path.
> `Batches: 8`: the hash table was 8x larger than available work_mem. PostgreSQL split it into 8
> batches, spilling 7 of those batches to disk, processing one batch at a time.
> Cost: 8 disk-write + 8 disk-read operations instead of in-memory. 2-10x slower than Batches: 1.
> Diagnosis:
> Hash Batches: 8, Hash Buckets: 65536 → look at "Build" rows count.
> At 8 batches + 64K buckets: ~16M row hash table with defaults.
> At 8 bytes/row average: ~128MB hash table. work_mem = 16MB (default). Spill.
> Fix option 1: SET work_mem = '128MB' for this session. Hash table fits → Batches: 1.
> Fix option 2: Add index on the join column → planner shifts to Index-based Nested Loop.
> Fix option 3: Reduce result set before join (more selective WHERE filter earlier in query).

### Advanced Questions

**Q6: How does Redshift's data distribution model affect join performance, and how would you design a schema for a fact table joining against two large dimension tables?**

> Redshift distributes table rows across slices (virtual nodes) within each compute node.
> Distribution style options: EVEN (default round-robin), KEY (rows with same key on same slice),
> ALL (all rows on every node), AUTO (Redshift chooses).
>
> For a fact table joining two large dimension tables:
> fact_events(event_id, user_id, product_id, ts, ...) → 100B rows
> users(user_id, country, ...) → 100M rows
> products(product_id, category, ...) → 1M rows
>
> Large dimension (users — 100M rows):
> DISTKEY(user_id) for both fact_events and users → co-located join.
> Each slice processes its own user_id subset independently. No shuffle.
>
> Small dimension (products — 1M rows):
> DISTSTYLE ALL → full copy on every node.
> fact_events × products join: each node reads local products copy. No shuffle.
>
> SORT KEY on fact_events: COMPOUND SORTKEY(user_id, ts).
> Queries filtering by user_id first + ts range: zone map pruning on both columns.
> Most common query pattern shapes the sort key choice.

---

## SECTION 11 — Debugging Exercise

### Scenario: Dashboard Shows Wrong Active User Count

```
SYMPTOMS:
  - Weekly executive dashboard shows "Active Users in Last 30 Days" metric.
  - Count: 14,218 users.
  - Data team checks source: actual active user signups last 30 days = 19,450.
  - 5,232 users are missing. Unexplained.
  - Dashboard has been running for 6 months. Problem only noticed when correlated against CRM data.

QUERY (as written in dashboard):
  SELECT u.region, COUNT(DISTINCT u.id) AS active_users
  FROM users u
  LEFT JOIN events e ON e.user_id = u.id
  WHERE e.event_type = 'page_view'
    AND e.created_at >= NOW() - INTERVAL '30 days'
  GROUP BY u.region;

INVESTIGATION:

Step 1: Understand what the query is supposed to do.
  Goal: count distinct users who had any 'page_view' event in the last 30 days.
  LEFT JOIN: intended to include users who might have no events.
  But: WHERE e.event_type = 'page_view' AND e.created_at >= ...
  → This WHERE filter applies to the right-table (events) AFTER the join.
  → Users with NO events: e.event_type IS NULL, e.created_at IS NULL.
  → NULL = 'page_view' → FALSE. NULL >= date → FALSE. Row excluded.
  → The LEFT JOIN IS behaving as an INNER JOIN due to the WHERE filter.

Step 2: Identify the affected rows.
  -- Count users excluded by this pattern:
  SELECT COUNT(*) AS excluded_users
  FROM users u
  LEFT JOIN events e
    ON e.user_id = u.id
    AND e.event_type = 'page_view'
    AND e.created_at >= NOW() - INTERVAL '30 days'
  WHERE e.user_id IS NULL
    AND u.created_at >= NOW() - INTERVAL '30 days';
  -- Returns: 5,232. This confirms: 5,232 users registered in last 30 days but had zero page_view events.
  -- They were registered active users but hadn't triggered page_view yet.
  -- The dashboard was under-counting by excluding all brand-new users with no events.

Step 3: The correct query design.
  -- WRONG (original): WHERE filter on right-table = implicit INNER JOIN
  SELECT u.region, COUNT(DISTINCT u.id) AS active_users
  FROM users u
  LEFT JOIN events e ON e.user_id = u.id
  WHERE e.event_type = 'page_view'                             -- ← converts to INNER JOIN
    AND e.created_at >= NOW() - INTERVAL '30 days'
  GROUP BY u.region;

  -- CORRECT: move right-table filters to ON clause
  SELECT u.region, COUNT(DISTINCT u.id) AS active_users
  FROM users u
  LEFT JOIN events e
    ON e.user_id = u.id
    AND e.event_type = 'page_view'                             -- ← in ON clause: preserved
    AND e.created_at >= NOW() - INTERVAL '30 days'            -- ← in ON clause: preserved
  WHERE u.created_at >= NOW() - INTERVAL '30 days'            -- ← filter on LEFT table: correct in WHERE
  GROUP BY u.region;

  -- This version: users with no page_view events → e.user_id IS NULL → still counted.
  -- Users with page_view events → joined and counted.
  -- Result: 19,450 users. Matches CRM.

INVESTIGATION OUTCOME:
  6 months of incorrect executive reporting.
  Business impact: under-reported active users affected SaaS billing verification,
  user acquisition ROI calculations, and regional marketing spend allocation.
  Root cause: single WHERE → ON clause distinction. One of the most common SQL logic bugs.
  Prevention: code review checklist → "Any filter on right-table of LEFT JOIN? Move to ON."
```

---

## SECTION 12 — Architect's Mental Model

```
=== Architect's Mental Model: Joins (INNER, LEFT) ===

DECISION RULE 1: INNER JOIN = intersection. LEFT JOIN = preserve all from the left.
  Ask before writing every JOIN: "Should rows from the left table appear even if no match exists?"
  YES → LEFT JOIN. NO → INNER JOIN. If uncertain: LEFT JOIN is safer (more inclusive).
  Implicit INNER JOIN from LEFT JOIN + WHERE: the most common and costly SQL logic error.
  Establish code review convention: every filter on right-table column → confirm it's in ON clause.

DECISION RULE 2: Join algorithm selection = implicit query tuning.
  The planner selects Nested Loop / Hash Join / Merge Join automatically.
  Watch for: Nested Loop on two large tables (planner underestimated row counts → bad stats).
  Diagnosis: EXPLAIN ANALYZE. Actual rows >> Estimated rows → stale statistics.
  Fix: ANALYZE table_name; then re-explain.
  Manual override: SET enable_nestloop = OFF; — only in test sessions. Never globally.

DECISION RULE 3: work_mem directly controls join memory ceiling.
  Batches > 1 in hash join = memory spill. Each batch = extra disk read/write round trip.
  At high concurrency: increasing work_mem platform-wide risks OOM on the instance.
  Targeted fix: SET work_mem = 'NNNmb' for the specific expensive query session.
  Or: rewrite to reduce the cardinality of the hash build table (filter earlier, join later).

DECISION RULE 4: Join order matters for Nested Loop performance.
  PostgreSQL planner: usually picks optimal join order.
  If plan is wrong: set join_collapse_limit = 1 → planner uses query-written join order.
  Manual optimization: small, indexed table first (inner) → fast index lookup per outer row.
  The table you are looping over should be large. The table you look up into should be indexed.

DECISION RULE 5: DynamoDB with JOIN-heavy access patterns = wrong data model, not wrong query.
  If you find yourself writing: multiple GetItem calls in a loop = application-side join.
  This is always avoidable with proper DynamoDB single-table design.
  The time to redesign: before the data grows. After 100M items: table restructure is painful.
  Signal: if your access patterns require "join" in DynamoDB → evaluate Aurora or document model.

COMMON MISTAKE 1: Adding WHERE filter on right-table column after LEFT JOIN.
  Always: WHERE on right-table column will null-filter the non-matching rows (converts to INNER).
  Fix: move the filter into the ON clause. Re-test to confirm results include NULLs as expected.
  In EXPLAIN: if a LEFT JOIN produces same row count as INNER JOIN → suspect this pattern.

COMMON MISTAKE 2: Forgetting the ON clause entirely (Cartesian product).
  SELECT * FROM a, b WHERE a.id = b.id: old-style syntax, hides the join in WHERE.
  If someone accidentally deletes the WHERE condition: full Cartesian product.
  Always use: SELECT * FROM a JOIN b ON a.id = b.id — explicit JOIN syntax.
  Cartesian protection: explicit JOIN requires ON clause or database rejects query (most modern DBs).

COMMON MISTAKE 3: Adding DISTINCT after a JOIN instead of fixing the join.
  Symptom: result has duplicate rows. "Fix": SELECT DISTINCT.
  Actual problem: cardinality mismatch. One side of the join has multiple rows per key.
  DISTINCT hides the root cause and adds a sort operation.
  Fix: diagnose WHY duplicates exist → usually a missing second join condition or wrong relationship.
  DISTINCT should never appear in a query unless uniquifying results is the intentional business logic.

30-SECOND INTERVIEW ANSWER (Why does a filter in WHERE after a LEFT JOIN behave differently than a filter in ON?):
  "The LEFT JOIN and WHERE clause execute in different phases. The ON clause applies during the
  join phase — rows from the left table that find no match are retained with NULLs in the right columns.
  But WHERE applies after the join to the complete result set. If you filter on a right-table column
  in WHERE, rows where that right column is NULL are excluded — and that NULL is exactly what you get
  for non-matching left-table rows. So the WHERE filter silently removes all the rows the LEFT JOIN
  was meant to preserve, converting it into an INNER JOIN in effect. The fix is simple: move the
  filter condition on right-table columns into the ON clause, where it participates in the join
  decision rather than post-filtering the joined result."
```
