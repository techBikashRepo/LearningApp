# SELECT & WHERE — Part 1 of 3

### Sections: 1 (Intuition), 2 (Why This Exists), 3 (Internal Working), 4 (Query Execution Flow)

**Series:** Databases & Data Modeling → Topic 02

---

## SECTION 1 — Intuition: The Warehouse Inventory System

A distribution warehouse manages 2 million SKUs across 40 shelves. Every morning, a picker needs the list of items that are low-stock, in a specific aisle, and ordered by urgency.

Without a query language, the picker walks every single shelf, reads every label, discards 99% of what they see, and writes down the 0.1% that matches. That is a **sequential scan** — what your database does when there is no index and no predicate optimization.

```
WAREHOUSE ANALOGY → DATABASE MAPPING:

  "Give me everything on Shelf 7"
    → SELECT * FROM inventory WHERE shelf_id = 7

  "Give me just the SKU and quantity, not the full item description"
    → SELECT sku, quantity FROM inventory WHERE shelf_id = 7

  "Give me items where quantity < 10 AND last_restocked < 7 days ago"
    → SELECT sku, quantity FROM inventory
       WHERE shelf_id = 7
         AND quantity < 10
         AND last_restocked < NOW() - INTERVAL '7 days'

THE ARCHITECT'S FRAME:

  SELECT defines WHAT data comes back — bandwidth, serialization cost, memory.
  WHERE defines HOW MUCH of the table is read — I/O cost, CPU cost, lock scope.

  SELECT *   = bring every column from every matching row across the wire.
              At scale: 100 columns × 100KB JSONB each × 10,000 rows = 1GB per query.

  WHERE determines if the DB reads 1 row or 50 million rows.
  A missing or poorly-written WHERE clause on a 500M-row table:
  full table scan → minutes of latency → connection pool exhausted → cascading failure.
```

**The mental model a Principal Architect holds:** SELECT is a contract between your code and the database. Every column you request has a cost: wire transfer, deserialization, memory allocation. Every WHERE predicate is a filter that, if index-supported, converts an O(N) scan into an O(log N) lookup.

---

## SECTION 2 — Why This Exists: The Production Failures

### Failure 1: The SELECT \* That Brought Down the API

```
INCIDENT: A fintech API serving 10,000 req/sec.
Timeline:
  T+0:    Developer adds "debug logging" — wraps existing query with SELECT *.
          Previously: SELECT id, status, amount FROM transactions WHERE user_id = ?
          Now: SELECT * FROM transactions WHERE user_id = ?

  T+0:    transactions table: 200 columns. Includes: audit_log JSONB (avg 50KB per row).
  T+0:    Per query: 50KB × 20 rows avg = 1MB per request.
  T+5min: Memory on API server: 8GB used (was 2GB).
  T+7min: GC pauses. P99 latency: 200ms → 8 seconds.
  T+9min: OOM killer terminates API process.
  T+10min: Load balancer marks instance unhealthy. Traffic rerouted. Cascade begins.

ROOT CAUSE: SELECT * with a wide table containing a large BLOB column.
            The query matched ~20 rows but pulled 1MB each from the heap.

FIX: Never use SELECT * in application code. Always project explicit columns.
     SELECT id, status, amount, created_at — 4 small columns — same 20 rows = ~1KB total.
```

### Failure 2: The WHERE Clause That Was Always True

```sql
-- REAL BUG PATTERN — dynamic WHERE clause construction:
async function getOrders(filters) {
  let where = '';
  if (filters.status) where += ` AND status = '${filters.status}'`;
  // ... build where string

  const query = `SELECT * FROM orders WHERE 1=1 ${where}`;
  return db.query(query);
}

-- When called without filters: getOrders({})
-- Generated query: SELECT * FROM orders WHERE 1=1
-- Returns: ALL 50 million rows.
-- Node.js: tries to hold 50M rows in memory → OOM crash.
-- Even if paginated: DB reads all 50M, filters in memory.

-- INCIDENT: A batch job called getOrders() without filters.
--           DB CPU: 0% → 100% instantly.
--           All other queries starved. Site down for 12 minutes.

-- FIX: Require at least one constraining predicate for high-volume tables.
--      Use parameterized queries with explicit column projection.
--      Add: LIMIT clause as a safety net.
```

### Failure 3: WHERE on the Wrong Data Type

```sql
-- INCIDENT: Auth service login queries suddenly 5x slower after midnight.
-- Query:
SELECT id, email FROM users WHERE user_id = '12345';
--                                             ^^^
--                                             String literal vs INT column.
-- Postgres: implicit cast: INTEGER = '12345'::INTEGER = fine for equality.
-- MySQL: '12345' vs INT → implicit cast works BUT disables index usage!

-- In MySQL specifically:
-- user_id column: INT with index.
-- WHERE user_id = '12345' (string) → type mismatch → index cast → full table scan.
-- 5M users: was 0.1ms (index) → now 1.2 seconds (scan).

-- At midnight: automated job ran with string-typed user IDs loaded from CSV.
-- 5M users × sequential scan per lookup = DB overwhelmed.

-- FIX: Always match WHERE predicate types to column types.
--      Use typed parameters: WHERE user_id = $1 where $1 is bound as INTEGER.
--      ORMs help but raw queries: always verify.
```

---

## SECTION 3 — Internal Working: What the DB Engine Does

### How WHERE Predicates Are Evaluated

```
QUERY: SELECT id, amount FROM transactions WHERE user_id = 42 AND status = 'SETTLED'

STEP 1: CLAUSE ANALYSIS
  Planner examines each predicate:
    Predicate A: user_id = 42
      → Is there an index on user_id? YES: idx_transactions_user
      → Estimated selectivity: 1 in 50,000 users → ~200 rows out of 10M
      → Plan: Index Scan using idx_transactions_user for user_id = 42

    Predicate B: status = 'SETTLED'
      → Is there an index on status? YES: idx_transactions_status
      → Estimated selectivity: 70% of rows are SETTLED
      → Individual index scan on status: would return 7M rows → slower than seq scan
      → Plan: Filter AFTER user_id index narrows to ~200 rows

  COMBINED PLAN:
    1. Index scan on user_id = 42 → ~200 rows from heap
    2. Filter those 200 rows where status = 'SETTLED' (in memory, fast)
    3. Project: id, amount (discard other columns)
    4. Return result

STEP 2: SHORT-CIRCUIT EVALUATION
  Postgres evaluates predicates in cost order (cheapest first).
  If first predicate eliminates row: second predicate never evaluated.
  Rule: put most selective / cheapest predicate first in your WHERE clause.

  Cheap predicates: equality on indexed integer column, IS NULL, IS NOT NULL
  Expensive predicates: LIKE '%pattern%', regex, function calls, subqueries

STEP 3: PREDICATE PUSHDOWN
  In complex queries with subqueries or CTEs:
  Postgres tries to push WHERE predicates as close to the data source as possible.

  -- WITHOUT pushdown:
  -- CTE reads all 10M rows, THEN outer query filters.
  WITH all_transactions AS (SELECT * FROM transactions)
  SELECT * FROM all_transactions WHERE user_id = 42;

  -- Postgres CTE optimization (12+): pushes predicate into CTE.
  -- But prior to Postgres 12: CTEs were "optimization fences" — no pushdown.
  -- This was a notorious performance trap: CTEs that appeared to filter early but didn't.

  In Postgres 12+: CTEs inline by default unless MATERIALIZED keyword used.
```

### The Predicate Evaluation Cost Model

```
PREDICATE TYPE              COST (relative)    CAN USE INDEX?    NOTES
──────────────────────────────────────────────────────────────────────────
col = value                 1x                 YES               Best case
col IN (v1, v2, v3)         ~N×                YES               Becomes OR internally
col BETWEEN a AND b         1x                 YES               Range scan
col > val AND col < val     1x                 YES               Same as BETWEEN
col IS NULL                 1x                 YES (partial idx) Partial index on NULLs
LOWER(col) = 'val'          5x                 NO (without func idx) Always functional index
col LIKE 'prefix%'          2x                 YES (btree)       Only if leading chars fixed
col LIKE '%suffix'          100x               NO                Full scan, no index help
col ~ '^pattern'            10x                NO (without GIN)  Use GIN trigram index
col IN (SELECT ...)         50x+               MAYBE             Rewrite as EXISTS or JOIN
f(col1, col2) = val         10x                NO                Computed column + index
```

### SARGABILITY: The Most Important WHERE Concept

```sql
-- SARG: Search ARGument able — a predicate where the index CAN be used.

-- ❌ NON-SARGABLE (index ignored, full scan):
WHERE YEAR(created_at) = 2026            -- function on indexed column
WHERE CAST(user_id AS TEXT) = '42'       -- cast on indexed column
WHERE email LIKE '%@company.com'         -- leading wildcard
WHERE ABS(balance) > 1000               -- function on column
WHERE created_at + INTERVAL '1 day' > NOW()  -- arithmetic on column

-- ✅ SARGABLE (index used):
WHERE created_at BETWEEN '2026-01-01' AND '2026-12-31'  -- range on column
WHERE created_at >= '2026-01-01' AND created_at < '2027-01-01'  -- explicit range
WHERE user_id = 42                       -- equality on column
WHERE email LIKE 'alice%'                -- prefix match (trailing wildcard only)
WHERE balance > 1000 OR balance < -1000  -- column compared to constant

-- RULE: Move functions from the column to the constant side of the comparison.
-- Transform: YEAR(created_at) = 2026
-- Into:      created_at >= '2026-01-01' AND created_at < '2027-01-01'
-- Result:    Index used. Latency: 900ms → 2ms.
```

---

## SECTION 4 — Query Execution Flow

### The Full Pipeline: Application Code to Result Set

```
APPLICATION CODE:
  const result = await db.query(
    'SELECT id, amount, status FROM transactions WHERE user_id = $1 AND status = $2',
    [42, 'SETTLED']
  );

  ↓

QUERY PLANNING PHASE (happens every time for ad-hoc; cached for prepared statements):

  1. PARSE:       SQL text → parse tree (AST)

  2. ANALYZE:     Resolve names → "transactions" → OID 16432 (internal table identifier)
                  Check: does user_id column exist? Type INT? YES.
                  Check: does status column exist? Type VARCHAR? YES.

  3. REWRITE:     Apply rule system (views are expanded here)
                  No views involved: pass-through.

  4. PLAN:
    a. Generate candidate plans:
       - SeqScan + filter
       - IndexScan on idx_user_id → filter status
       - IndexScan on idx_status → filter user_id
       - BitmapAnd(BitmapScan on idx_user_id, BitmapScan on idx_status)

    b. Estimate costs using pg_statistic:
       - transactions: n_distinct for user_id ≈ 50,000 → 200 rows per user
       - status 'SETTLED': correlation 0.7 → 70% of 200 = 140 rows

    c. Choose plan with lowest total cost.
       Winner: IndexScan on idx_user_id (200 rows) + recheck status (free)

  5. EXECUTE:
    a. Walk index: B-tree root → internal → leaf page for user_id=42
    b. Get heap pointers: ~200 TIDs (tuple IDs = page_number:offset)
    c. Fetch heap pages (random I/O — hopefully in shared_buffers)
    d. For each row: check status = 'SETTLED', project id+amount+status
    e. Buffer result rows

  ↓

RESULT TRANSMISSION:
  Rows serialized → PostgreSQL wire protocol → TCP → libpq/driver → deserialized → your object

  For 140 rows × 3 columns × ~20 bytes each ≈ 8.4KB transmitted.
  Network: LAN ~0.1ms, cross-AZ ~2ms.

  ↓

ORM LAYER (if using Prisma/Sequelize/TypeORM):
  Raw rows → JavaScript objects (deserialization)
  For 140 rows: ~0.5ms deserialization
  Watch: ORM may issue additional queries (eager loading, lazy loading, N+1)
```

### Prepared Statements: The Hidden Performance Win

```javascript
// ❌ AD-HOC QUERIES: Parse + Plan every single time
for (const userId of userIds) {
  await db.query(
    `SELECT id, amount FROM transactions WHERE user_id = ${userId}`,
  );
  // Each call: parse SQL text → analyze → plan → execute
  // Planning: ~1-5ms per query (cheap but adds up)
}

// ✅ PREPARED STATEMENTS: Plan once, execute many times
await db.query(
  "PREPARE get_txns AS SELECT id, amount FROM transactions WHERE user_id = $1",
);

for (const userId of userIds) {
  await db.query("EXECUTE get_txns($1)", [userId]);
  // Planning step: SKIPPED. Cached execution plan reused.
  // Savings: ~2ms per query × 1,000 queries = 2 seconds saved.
}

// In node-postgres (pg): prepared statements via named queries
const getTransactions = {
  name: "get-transactions", // Name triggers prepared statement behavior
  text: "SELECT id, amount FROM transactions WHERE user_id = $1",
  values: [userId],
};
await pool.query(getTransactions);
// First call: parses + plans + caches.
// Subsequent calls: cached plan reused (same connection or globally via server-side prepare).

// CAVEAT: Prepared statement plan is based on FIRST SET of parameters.
// If data distribution is skewed (user 1: 5 rows, user 999999: 50,000 rows):
// Plan optimized for "50 rows" may be wrong for "50,000 rows" user.
// Solution: SET plan_cache_mode = force_custom_plan on sessions with skewed data.
```

### WHERE Clause Ordering: A Subtle Optimization

```sql
-- Postgres evaluates WHERE predicates left to right within same cost tier.
-- Most selective (eliminates most rows) first = less work overall.

-- ❌ WRONG ORDER: Expensive/broad predicate first
SELECT * FROM events
WHERE payload->>'event_type' = 'checkout'    -- JSONB extraction: moderate cost, 30% selectivity
  AND user_id = 42                            -- Integer equality: cheap, 0.002% selectivity
  AND created_at > NOW() - INTERVAL '7 days'; -- Range: cheap, 10% selectivity

-- ✅ BETTER ORDER: Cheapest + most selective first
SELECT * FROM events
WHERE user_id = 42                            -- cheap equality, most selective → eliminates 99.998% of rows
  AND created_at > NOW() - INTERVAL '7 days' -- range on indexed column
  AND payload->>'event_type' = 'checkout';   -- JSONB last: applied to tiny remaining set

-- NOTE: With indexes, the query planner often reorders anyway.
-- But for queries where planner doesn't know selectivity (JSONB fields, custom types):
-- manual ordering matters.

-- COMPOSITE INDEX ALIGNMENT:
-- If index is on (user_id, created_at):
-- WHERE user_id = 42 AND created_at > X → uses index perfectly (leading column + range)
-- WHERE created_at > X AND user_id = 42 → planner reorders anyway, same result
-- WHERE created_at > X (only) → partial index use (user_id not in predicate → less efficient)
```
