# Joins (INNER, LEFT) — Part 1 of 3

### Sections: 1 (Intuition), 2 (Why This Exists), 3 (Internal Working), 4 (Query Execution Flow)

**Series:** Databases & Data Modeling → Topic 08

---

## SECTION 1 — Intuition: Two Filing Cabinets

Imagine a police department with two filing cabinets. Cabinet A holds suspect profiles (name, ID, address). Cabinet B holds arrest records (suspect_id, date, charge). Not every suspect in Cabinet A has been arrested. Not every arrest record accurately links to a valid suspect profile (data entry errors).

```
INNER JOIN (find overlap):
  Pull out every suspect profile.
  Pull out every arrest record.
  MATCH: only return pairs where BOTH the profile AND the arrest exist.
  Result: only suspects who have been arrested. No unmatched profiles. No unmatched arrests.

LEFT JOIN (keep all of Cabinet A):
  Start with every suspect profile (Cabinet A = left table).
  For each profile: look for matching arrest records in Cabinet B.
  If found: return the pair with full arrest data.
  If NOT found: return the profile with NULLs in all arrest columns.
  Result: ALL suspects, arrested or not. Unarrested suspects: arrest columns = NULL.

RIGHT JOIN (keep all of Cabinet B):
  Mirror of LEFT JOIN. Keep all arrests, even ones with no valid suspect profile.
  Use case: data quality audit — find arrests with no matching suspect profile.
  (In practice: most engineers rewrite RIGHT JOIN as LEFT JOIN with tables swapped.)

FULL OUTER JOIN (keep everything):
  Return all profiles and all arrests.
  Matched pairs: full data.
  Unmatched profiles: NULLs in arrest columns.
  Unmatched arrests: NULLs in profile columns.
  Use case: data reconciliation, merge audits, ETL validation.

ARCHITECT'S FRAME:
  • INNER JOIN: "I want rows from BOTH tables that satisfy the relationship."
  • LEFT JOIN: "I want ALL rows from the left table; extras from the right if they exist."
  • The choice determines: which rows survive in the result.
  • The JOIN CONDITION determines: what constitutes a "match."
  • MISS in JOIN CONDITION: Cartesian product (every row × every row). Catastrophic.
```

---

## SECTION 2 — Why This Exists: Production Failures

### Failure 1: INNER vs LEFT JOIN — The Invisible Business Logic Bug

```
INCIDENT: E-commerce reporting dashboard. Monthly report: "Revenue by product category."

QUERY (incorrect):
  SELECT c.name, SUM(oi.price) AS revenue
  FROM categories c
  INNER JOIN products p ON p.category_id = c.id
  INNER JOIN order_items oi ON oi.product_id = p.id
  WHERE oi.created_at BETWEEN $1 AND $2
  GROUP BY c.name
  ORDER BY revenue DESC;

PROBLEM:
  "Electronics" category: no orders in the date range.
  INNER JOIN: "Electronics" drops from the result. CEO asks why Electronics is missing.
  "We had marketing spend in Electronics this month — where's the zero?"

  Dashboard showed 8 categories instead of 9.
  Decision: product manager approved axing Electronics team (why fund a zero-revenue category?).
  Reality: Electronics had $0 orders in the date range, but was a new category with pipeline.
  "Absent from report" → interpreted as "doesn't exist" → wrong business decision.

FIX:
  SELECT c.name, COALESCE(SUM(oi.price), 0) AS revenue
  FROM categories c
  LEFT JOIN products p ON p.category_id = c.id
  LEFT JOIN order_items oi
    ON oi.product_id = p.id
    AND oi.created_at BETWEEN $1 AND $2  ← move date filter TO the JOIN, not WHERE
  GROUP BY c.name
  ORDER BY revenue DESC;

CRITICAL DETAIL: WHERE oi.created_at BETWEEN ... after LEFT JOIN turns it into INNER JOIN.
  (WHERE filters post-join. NULL rows from LEFT JOIN have oi.created_at = NULL → fail filter → dropped.)
  Date range filter on the joined table MUST be in the ON clause, not WHERE.
```

### Failure 2: Missing JOIN Condition → Cartesian Product in Production

```sql
-- A developer wrote:
SELECT u.name, o.order_id, o.total
FROM users u, orders o   -- old-style implicit JOIN syntax
WHERE u.active = true;   -- forgot to add: AND o.user_id = u.id

-- users table: 200,000 rows
-- orders table: 5,000,000 rows
-- Cartesian product: 200,000 × 5,000,000 = 1,000,000,000,000 (1 trillion) rows
-- Query ran for 2+ hours before DBA killed it. DB server CPU: 100%.
-- All other queries on the instance: starved. Downtime for entire application.
-- The developer tested on dev environment: users=100, orders=500 → 50,000 rows. Seemed fine.

-- LESSON:
-- ALWAYS use explicit JOIN syntax with ON clause.
-- NEVER mix WHERE-based implicit joins.
-- Always test query plans against production-scale row counts (use pg_class.reltuples).
-- Code review checklist: every FROM with multiple tables MUST have a JOIN condition per table pair.

-- MODERN EQUIVALENT (still dangerous):
SELECT u.name, o.order_id, o.total
FROM users u
CROSS JOIN orders o    -- explicit cartesian product: at least intent is clear
WHERE u.active = true;  -- still missing AND o.user_id = u.id → same trillion rows
```

### Failure 3: LEFT JOIN Used When INNER Intended — Null Propagation Silently Corrupting Aggregates

```sql
-- INTENT: Get total revenue per sales rep.
-- QUERY:
SELECT sr.name, SUM(o.total) AS revenue
FROM sales_reps sr
LEFT JOIN orders o ON o.rep_id = sr.id
GROUP BY sr.name;

-- PROBLEM: Sales reps with no orders → o.total = NULL.
-- SUM(NULL) = NULL. But SUM(... NULL) = ignores NULL values.
-- Actually SUM(NULL, NULL, NULL) = NULL in GROUP BY context.
-- So reps with NO orders show revenue = NULL, not 0.

-- Downstream: commission calculation: revenue * 0.05.
-- NULL * 0.05 = NULL. NULL commission.
-- Payroll system treats NULL commission as "no entry" → rep gets $0.
-- Rep complains. Payroll audits. Finds 12 reps with NULL commissions.
-- Correct: COALESCE(SUM(o.total), 0) AS revenue.

-- DEEPER ISSUE: Any math/comparison involving NULL produces NULL.
-- In WHERE: WHERE revenue > 10000 → NULL > 10000 → NULL → filtered OUT.
-- Entire left-join extended rows disappear when you filter on nullable columns.
-- Design rule: always COALESCE nullable aggregates before using in calculations.
```

---

## SECTION 3 — Internal Working

### Three Join Algorithms the Planner Chooses From

```
ALGORITHM 1: NESTED LOOP JOIN
  For each row in outer table:
    Scan inner table for matching rows.

  Time complexity: O(N × M) worst case.
  Best case: inner table has index on join column → O(N × log M).

  Optimal when:
    • Outer table is small (few rows after WHERE filter)
    • Inner table has an index on the join column

  Classic use: PK/FK joins with good selectivity.

  EXPLAIN marker: "Nested Loop"
    -> Seq Scan on large_table  (outer — WRONG: should be small table as outer)
    -> Index Scan on small_table  (inner — correct if indexed)

ALGORITHM 2: HASH JOIN
  Phase 1 (Build): Scan smaller table → build in-memory hash table keyed on join column.
  Phase 2 (Probe): Scan larger table → probe hash table for each row.

  Time complexity: O(N + M) — linear. Faster than nested loop for large tables.
  Memory: hash table must fit in work_mem. If not → spills to disk (slow).

  Optimal when:
    • Both tables are large
    • No useful index on the join column
    • Join is equality join (hash tables only work with =)

  EXPLAIN marker: "Hash Join"
    -> Hash  (build phase: smaller table hashed)
      -> Seq Scan on smaller_table
    -> Seq Scan on larger_table  (probe phase)

  Batches: 1  → hash fits in memory (good)
  Batches: 8  → hash spilled to disk 8 times (8x slower — increase work_mem)

ALGORITHM 3: MERGE JOIN
  Pre-requisite: both inputs must be sorted on the join column.

  Phase: merge two sorted streams like merge-sort's merge step.
  Time complexity: O(N + M) if pre-sorted.
  If not pre-sorted: add sort cost O(N log N + M log M).

  Optimal when:
    • Both inputs have an index providing sorted order
    • Large equality or range joins
    • Data already sorted from preceding sort step

  EXPLAIN marker: "Merge Join"
    -> Index Scan using idx on table_a  (sorted by join col)
    -> Index Scan using idx on table_b  (sorted by join col)

JOIN ORDER MATTERS:
  Planner tries join orderings. With 2 tables: 2 orderings. With 5 tables: 120 orderings.
  join_collapse_limit (Postgres default: 8): beyond this, use genetic algorithm.
  Common performance fix: SET join_collapse_limit = 1; before a complex query to force
  the join order you specify in the query → use when you know the selectivity better than planner.
```

---

## SECTION 4 — Query Execution Flow

### Join Execution Walkthrough with Plan Analysis

```sql
-- QUERY:
SELECT u.email, COUNT(o.id) AS order_count, SUM(o.total) AS lifetime_value
FROM users u
LEFT JOIN orders o ON o.user_id = u.id
WHERE u.active = true AND u.created_at > '2024-01-01'
GROUP BY u.id, u.email
HAVING SUM(o.total) > 100
ORDER BY lifetime_value DESC
LIMIT 100;

-- EXECUTION PIPELINE:

Step 1 — Scan users with WHERE filter:
  Index Scan on users WHERE active = true AND created_at > '2024-01-01'
  Estimated: 15,000 rows match (out of 5M total users)

Step 2 — LEFT JOIN orders on user_id:
  15,000 users → planner chooses:
    Option A: Nested Loop + Index Scan on orders(user_id) per user row
    Option B: Hash Join — build hash of 15,000 users, probe orders

  Planner's choice: depends on orders rows per user and index availability.
  If orders has index on user_id: Nested Loop preferred (15K index lookups, each fast).
  If no index: Hash Join (hash 15K users, scan 50M orders once).

Step 3 — Group and aggregate:
  Hash Aggregate over user_id.
  Accumulators: COUNT(o.id) ignores NULLs (users with no orders: count=0).
  SUM(o.total) with COALESCE needed: users with no orders → SUM=NULL unless COALESCEd.

Step 4 — HAVING filter:
  SUM(o.total) > 100: drops users with lifetime_value <= 100 or NULL.
  NOTE: HAVING SUM > 100 on NULL: NULL > 100 = NULL = false → user dropped.
  If you want users with no orders in result: HAVING COALESCE(SUM(o.total), 0) > 100.

Step 5 — Sort and LIMIT:
  Top-N heapsort: extracts 100 rows with highest lifetime_value without full sort.

-- PERFORMANCE LEVERS:
-- • Index on users(active, created_at) or users(created_at) WHERE active = true (partial index)
-- • Index on orders(user_id) — critical for nested loop path
-- • work_mem for hash join: SET work_mem = '64MB' for complex multi-join queries
-- • EXPLAIN (ANALYZE, BUFFERS): shows actual rows vs estimated rows per step
--   Large divergence: outdated statistics → run ANALYZE
```
