# SELECT & WHERE — Part 2 of 3

### Sections: 5 (Bad vs Correct), 6 (Performance Impact), 7 (Concurrency), 8 (Optimization & Indexing)

**Series:** Databases & Data Modeling → Topic 02

---

## SECTION 5 — Bad Usage vs Correct Usage

### Pattern 1: SELECT \* in Production Application Code

```sql
-- ❌ BAD: SELECT * in application query
SELECT * FROM users WHERE id = $1;

-- PROBLEMS:
-- • Column added to users table: application receives unexpected column →
--   JSON serialization sends PII (added column 'ssn') to frontend. Security breach.
-- • Wide rows: users.profile_photo BYTEA = 500KB. SELECT * = 500KB per row over wire.
--   At 100 concurrent users: 50MB/query. Memory pressure on DB connection pool.
-- • Column reordering during migration: ORM maps by position → silent data corruption.
-- • Query plan not stable: different columns retrieved = different cost estimates.

-- ✅ CORRECT: Explicit column list
SELECT id, email, display_name, created_at, tier FROM users WHERE id = $1;

-- WHEN SELECT * IS ACCEPTABLE:
-- • Ad-hoc debugging in a REPL or DB IDE.
-- • Exploratory queries during development (never ship to production).
-- • COUNT(*) — this specific form is correct and idiomatic (counts all rows, no column semantics).
-- • EXISTS(SELECT * FROM ...) — also correct, optimized by planner (reads no actual columns).
```

### Pattern 2: Dynamic WHERE with Always-True Fallback

```sql
-- ❌ BAD: Dynamic query builder adding WHERE 1=1 and optional filters
SELECT * FROM transactions
WHERE 1=1
  AND ($1::TEXT IS NULL OR user_id = $1::INT)
  AND ($2::TEXT IS NULL OR status = $2);

-- PROBLEM: Index usage.
-- When $1 IS NULL: entire DB evaluates condition, ignores index on user_id.
-- PostgreSQL can't use index when condition structure is OR NULL.
-- Full table scans on every "get all" call.

-- ✅ CORRECT: Build query conditionally in application.
-- Python example:
clauses = ["1=1"]
params  = []
if user_id:
    clauses.append(f"user_id = ${len(params)+1}")
    params.append(user_id)
if status:
    clauses.append(f"status = ${len(params)+1}")
    params.append(status)
query = f"SELECT id, amount, status FROM transactions WHERE {' AND '.join(clauses)}"

-- Each query shape uses proper indexes.
-- Prepared statement cache: each distinct shape cached once.

-- ALTERNATIVE in PostgreSQL: Use CASE or application-level dispatch.
```

### Pattern 3: String Concatenation Instead of Parameterized Queries

```sql
-- ❌ DANGEROUS: Direct string interpolation (SQL injection + no plan reuse)
query = f"SELECT * FROM users WHERE email = '{user_input}'"
# user_input = "'; DROP TABLE users; --"
# Result: SELECT * FROM users WHERE email = ''; DROP TABLE users; --'

-- ✅ CORRECT: Always parameterized
query = "SELECT id, email FROM users WHERE email = $1"
cursor.execute(query, (user_input,))  # user_input treated as data, never executed

-- PERFORMANCE BONUS:
-- Parameterized: plan cache hit after first execution. Same query, different value = reuse plan.
-- String interpolation: every query is syntactically different string = re-plan every time.
-- At 10,000 logins/second: 10,000 × (parse + plan) time vs 10,000 × plan cache lookup.
```

### Pattern 4: Predicate on Function Call Breaks Index

```sql
-- ❌ BAD: Non-sargable predicate
SELECT * FROM orders WHERE YEAR(created_at) = 2024;  -- MySQL
SELECT * FROM orders WHERE EXTRACT(YEAR FROM created_at) = 2024;  -- Postgres
-- Index on created_at: USELESS. DB must compute YEAR() for every row.

-- ✅ CORRECT: Sargable range predicate
SELECT id, total, status FROM orders
WHERE created_at >= '2024-01-01' AND created_at < '2025-01-01';
-- Index on created_at: fully used. Range scan. Milliseconds on 500M rows.

-- ❌ BAD: LOWER() on comparison
SELECT * FROM users WHERE LOWER(email) = LOWER($1);
-- Index on email: useless. Function wraps the column.

-- ✅ CORRECT: Functional index
CREATE INDEX idx_users_email_lower ON users(LOWER(email));
SELECT * FROM users WHERE LOWER(email) = LOWER($1);
-- Now: functional index used. Case-insensitive lookup + index utilization.
```

---

## SECTION 6 — Performance Impact

### Row Width and Memory Amplification

```
SCENARIO: users table.
  id          BIGINT           8 bytes
  email       TEXT             50 bytes avg
  display_name TEXT            25 bytes avg
  profile_blob BYTEA           480,000 bytes avg (profile photo)
  metadata    JSONB            2,000 bytes avg
  Total row:  ~482,083 bytes (~471 KB)

SELECT * FROM users WHERE tier = 'enterprise':
  500 enterprise users × 471 KB = 235.5 MB returned to application.
  Network: 235.5 MB transfer on 1 Gbps link = ~2 seconds just for data transfer.
  Application memory: hold 235.5 MB while processing.
  Connection memory: Postgres backend process peaks at ~245 MB for this query.

SELECT id, email, display_name FROM users WHERE tier = 'enterprise':
  500 rows × 83 bytes = 41.5 KB.
  Network: <1 ms.
  Application memory: trivial.
  DB memory: negligible.

RATIO: 235,500 KB vs 41.5 KB = 5,675x difference in data moved.
At 100 concurrent "dashboard loads":
  SELECT *:   23.5 GB/sec → saturates network, OOM errors.
  SELECT cols: 4.15 MB/sec → imperceptible.
```

### WHERE Clause Selectivity and I/O

```
TABLE: events (id, user_id, event_type, occurred_at, payload)
  Rows: 50,000,000
  B-tree index on (user_id, occurred_at)

QUERY A: WHERE user_id = 42
  Selectivity: 0.00002 (1,000 rows / 50M)
  Execution: Index range scan. Reads ~1,000 rows via index.
  I/O: ~130 index pages + ~100 heap pages (1.8MB). Time: 2-5ms.

QUERY B: WHERE event_type = 'PAGE_VIEW'
  Selectivity: 0.60 (60% of rows are PAGE_VIEW)
  Execution: Seq Scan (planner: index scan would need 30M heap fetches = worse than seq scan).
  I/O: all 50M rows at 8KB/row = 400GB scan. Time: minutes.
  Fix: partial index if this query is common:
  CREATE INDEX idx_events_non_pageview ON events(occurred_at) WHERE event_type != 'PAGE_VIEW';
  Or: materialized view pre-aggregating PAGE_VIEW counts by day.

QUERY C: WHERE user_id = 42 AND occurred_at > NOW() - INTERVAL '7 days'
  Selectivity: 0.000001 (50 rows / 50M)
  Execution: composite index scan (user_id + occurred_at both constrained).
  I/O: ~10 pages. Time: sub-millisecond.

LESSON: Selectivity = fraction of rows returned.
  Low selectivity (< 1-2%): index preferred.
  High selectivity (> 15-20%): sequential scan preferred.
  The planner estimates — bad estimates (stale stats) → wrong choice → fix with ANALYZE.
```

---

## SECTION 7 — Concurrency & Data Integrity

### Read Isolation and the "Dirty Read" Problem

```
READ COMMITTED (default in Postgres, MySQL):
  Each SELECT sees a snapshot as of the moment the SELECT starts.
  CANNOT see: uncommitted changes from other transactions.
  CAN see: committed changes that commit BETWEEN multiple SELECTs in same transaction.

PHANTOM READ SCENARIO:
  Transaction A:
    SELECT COUNT(*) FROM orders WHERE status = 'PENDING';  -- returns 100
    -- ... some processing ...
    SELECT order_ids FROM orders WHERE status = 'PENDING';  -- returns 101 rows (one added by T-B)
    -- Counts are inconsistent within the same transaction! Phantom read.

  Prevention: REPEATABLE READ or SERIALIZABLE isolation level.
  SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
  -- Snapshot taken at first SELECT in transaction. All subsequent SELECTs see same snapshot.

LOCK BEHAVIOR FOR SELECT:
  Plain SELECT: takes no locks. Never blocks writers. Never blocks other readers.
  SELECT FOR UPDATE: takes RowShareLock → blocks other transactions' FOR UPDATE/FOR SHARE on same row.
  SELECT FOR SHARE:  takes RowShareLock weaker → blocks FOR UPDATE but not FOR SHARE.

  Use SELECT FOR UPDATE: when you read a row to conditionally UPDATE it (prevent lost updates).
  "Check then act" pattern: SELECT balance FOR UPDATE → check → UPDATE balance.
  Without: two transactions both read balance=100, both subtract 50, both write 50. Loss of $50.
  With FOR UPDATE: second transaction waits for first to commit → correct final balance.
```

---

## SECTION 8 — Optimization & Indexing

### Covering Indexes: Zero Heap Reads

```sql
-- QUERY (frequent hot path):
SELECT id, email, tier FROM users WHERE tier = 'enterprise' AND active = true;

-- STANDARD INDEX on (tier):
--   Index scan: reads index entry → gets heap TID → fetches heap page → reads all columns.
--   Cost: index pages + heap pages. Heap fetches: 1 per row (random I/O if rows scattered).

-- COVERING INDEX (includes all columns needed by query):
CREATE INDEX idx_users_covering ON users(tier, active) INCLUDE (id, email);

-- EXPLAIN:
Index Only Scan using idx_users_covering on users
  Index Cond: (tier = 'enterprise' AND active = true)
  Heap Fetches: 0   ← ZERO heap reads. All data in index leaf pages.

-- VS non-covering:
Index Scan using idx_users_tier on users
  Index Cond: (tier = 'enterprise')
  Filter: (active = true)
  Heap Fetches: 1200  ← 1200 heap page reads (one per matching row).

-- WHEN TO COVER:
--   Queries on B-tree indexed columns that SELECT specific few columns.
--   High-frequency queries (>100/sec) where the extra index size is worth it.
--   INCLUDE columns: stored in leaf pages only (not internal nodes) → index size increase is modest.

-- MONITORING: Track index-only scan hit rate:
SELECT schemaname, relname, indexrelname,
       idx_scan, idx_tup_read, idx_tup_fetch,
       (idx_scan - idx_tup_fetch)::FLOAT / NULLIF(idx_scan, 0) AS index_only_ratio
FROM pg_stat_user_indexes
WHERE idx_scan > 100
ORDER BY idx_scan DESC;
-- index_only_ratio near 1.0: nearly all scans are index-only → good.
-- index_only_ratio near 0.0: all scans hit heap → consider covering index.
```

### Partial Indexes for Sparse Queries

```sql
-- TABLE: tasks (id, status, assignee_id, priority, created_at)
-- 10M tasks. Status distribution:
--   COMPLETED: 9,500,000 (95%)
--   ACTIVE:      480,000  (4.8%)
--   BLOCKED:      20,000  (0.2%)

-- FREQUENT QUERY: "Get active tasks for user X"
SELECT id, title, priority FROM tasks WHERE status = 'ACTIVE' AND assignee_id = $1;

-- FULL INDEX on (status, assignee_id): includes 10M entries. 95% are COMPLETED (never queried).
-- PARTIAL INDEX: only indexed rows where condition is true:
CREATE INDEX idx_tasks_active_assignee
ON tasks(assignee_id)
WHERE status = 'ACTIVE';

-- Index size: 480,000 entries (not 10M) → 48x smaller.
-- Fits entirely in shared_buffers (RAM). Zero disk reads for active-task lookups.
-- INSERT of COMPLETED task: does NOT touch this index (predicate mismatch) → no write overhead.

-- QUERY: must include the partial index predicate for planner to use it:
-- ✅ Uses partial index:
SELECT id, title FROM tasks WHERE status = 'ACTIVE' AND assignee_id = $1;
-- ❌ Cannot use partial index:
SELECT id, title FROM tasks WHERE assignee_id = $1;  -- status not constrained
```
