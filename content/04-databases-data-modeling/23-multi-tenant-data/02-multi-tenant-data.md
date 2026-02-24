# Multi-Tenant Data — Part 2 of 3

### Sections: 5 (Bad vs Correct Usage), 6 (Performance Impact), 7 (Concurrency & Data Integrity), 8 (Optimization & Indexing)

**Series:** Databases & Data Modeling → Topic 23

---

## SECTION 5 — Bad Usage vs Correct Usage

### Common Multi-Tenant Anti-Patterns

**Anti-Pattern 1: Missing tenant_id in the index (leading column rule violated)**

```sql
-- BAD: index on status only — tenant_id missing or not leading:
CREATE INDEX idx_orders_status ON orders(status);

-- Query from a specific tenant:
SELECT * FROM orders WHERE tenant_id = 42 AND status = 'pending';

-- Execution plan: Index Scan on idx_orders_status (status='pending')
--   → returns ALL 'pending' orders from ALL tenants (3M rows)
--   → filter tenant_id = 42 → keeps 50 rows.
-- Cost: 3M rows touched, 2,999,950 discarded. 100% wasted work.

-- EXPLAIN ANALYZE output (bad index):
-- Index Scan using idx_orders_status on orders  (cost=0.56..48721.33 rows=48 width=312)
--   (actual time=0.218..8423.112 rows=50 loops=1)
--   Index Cond: (status = 'pending')
--   Filter: (tenant_id = 42)
--   Rows Removed by Filter: 2999950   ← 3M wasted rows

-- CORRECT: tenant_id as leading column:
CREATE INDEX idx_orders_tenant_status ON orders(tenant_id, status);

-- Same query with correct index:
-- Index Scan using idx_orders_tenant_status on orders
--   (actual time=0.031..0.187 rows=50 loops=1)
--   Index Cond: ((tenant_id = 42) AND (status = 'pending'))
--   Rows Removed by Filter: 0   ← perfect, zero wasted
-- 8,423ms → 0.19ms = 44,000x improvement.
```

---

**Anti-Pattern 2: Application-only tenant enforcement (no database-level guarantee)**

```sql
-- BAD: tenant filtering only in WHERE clause written by developers:
-- User service request:
def get_users(tenant_id):
    return db.execute("SELECT * FROM users WHERE tenant_id = %s", [tenant_id])

-- ONE developer writes a utility function:
def get_all_users_for_debugging():
    return db.execute("SELECT * FROM users")  # forgot tenant_id filter
-- Cross-tenant data leak. Any developer's mistake = data breach.

-- CORRECT: RLS makes tenant isolation a database guarantee:
ALTER TABLE users ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON users
    USING (tenant_id = current_setting('app.tenant_id', TRUE)::INTEGER);

-- Now: even "SELECT * FROM users" is automatically rewritten by the DB to:
--   SELECT * FROM users WHERE tenant_id = current_setting('app.tenant_id')::INTEGER
-- Developer can't leak cross-tenant data. DB enforces it always.
-- Only exception: superuser or BYPASSRLS role (must be tightly controlled).
```

---

**Anti-Pattern 3: Storing tenant_id as TEXT instead of INTEGER**

```sql
-- BAD: tenant_id as TEXT
CREATE TABLE resources (
    id         TEXT DEFAULT gen_random_uuid()::TEXT,
    tenant_id  TEXT,   -- ← "org_a1b2c3d4" or "acme-corp"
    ...
);
CREATE INDEX ON resources(tenant_id, created_at);
-- Problems:
-- 1. Text comparison: slower than integer comparison (variable-length, collation rules).
-- 2. Index size: TEXT 'org-name-company' = 16+ bytes vs INTEGER 4 bytes. 4x larger index.
-- 3. Typo risk: "Acme-Corp" vs "acme-corp" → two different tenants accidentally.
-- 4. No FK enforcement: tenant_id TEXT can't easily reference tenants(id) with FK.

-- CORRECT: INTEGER foreign key for tenant_id:
CREATE TABLE resources (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id  INTEGER NOT NULL REFERENCES tenants(id),
    ...
);
-- Integer: 4 bytes, fixed width, fast comparison, proper FK, smaller indexes.
-- For external-facing tenant identifiers: use a separate slug/code TEXT column on tenants table.
--   Internal joins: always on tenant_id INTEGER. External API: use slug.
```

---

**CORRECT Pattern: full multi-tenant setup with RLS + composite PK**

```sql
CREATE TABLE orders (
    tenant_id    INTEGER NOT NULL REFERENCES tenants(id),
    id           BIGINT NOT NULL DEFAULT nextval('orders_id_seq'),
    customer_id  INTEGER NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending',
    total_cents  INTEGER NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, id)  -- tenant_id first: all lookups tenant-scoped
);

-- Required indexes (tenant_id always leading):
CREATE INDEX ON orders(tenant_id, status);
CREATE INDEX ON orders(tenant_id, customer_id);
CREATE INDEX ON orders(tenant_id, created_at DESC);

-- RLS:
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON orders
    USING (tenant_id = current_setting('app.tenant_id')::INTEGER);

-- Application: set context at connection start:
SET LOCAL app.tenant_id = '42';
-- All subsequent queries: automatically scoped to tenant 42. No developer error possible.
```

---

## SECTION 6 — Performance Impact

### Multi-Tenant Query Performance Analysis

```
Dataset: 30M total orders across 150 tenants.
Average: 200K orders/tenant. Largest tenant: 2.5M orders.

Scenario 1: Index WITHOUT tenant_id as leading column
  Index: idx_orders_status ON orders(status)
  Query: WHERE tenant_id = 42 AND status = 'processing'
  Cost: 30M rows in index, filter after scan.
  Execution: 8,400ms
  Index usage: 0% efficient (cross-tenant scan)

Scenario 2: Composite index WITH tenant_id leading
  Index: idx_orders_tenant_status ON orders(tenant_id, status)
  Same query
  Index entries scanned: ~200K (tenant slice only)
  Execution: 3.2ms
  Improvement: 2,625x

Scenario 3: RLS vs explicit WHERE performance
  Without RLS (explicit WHERE tenant_id = 42):
    Plan: Index Scan using idx_orders_tenant_status
    Execution: 3.2ms

  With RLS USING (tenant_id = current_setting('app.tenant_id')::INTEGER):
    Plan: Index Scan using idx_orders_tenant_status (RLS condition pushed into Index Cond)
    Execution: 3.3ms
    Overhead: +0.1ms (roughly 3%). Negligible.

  Why RLS adds near-zero overhead:
    The planner pushes the RLS predicate into the index condition.
    It is logically equivalent to the explicit WHERE clause.
    No extra filter step: happens at index scan level.

Noisy neighbor scenario:
  Largest tenant (2.5M orders) starts batch import: 100K INSERTs/second.
  Effect on shared_buffers: batch import evicts other tenants' pages from buffer cache.
  Small tenant query (cold cache): 3.2ms → 18ms (5.6x slower during import storm).
  Mitigation: rate limit per-tenant at application layer, separate write connection pool.
```

---

## SECTION 7 — Concurrency & Data Integrity

### Tenant Safety Under Concurrent Access

**Connection pool and SET LOCAL safety:**

```sql
-- PgBouncer in transaction-mode pooling:
-- Connection A: Tx 1 for tenant 42 → SET LOCAL app.tenant_id = '42'; COMMIT → reused.
-- Connection A: Tx 2 for tenant 99 → SET LOCAL app.tenant_id = '99'; ...

-- SET LOCAL semantics: variable reset at COMMIT/ROLLBACK.
-- After Tx 1 COMMIT: app.tenant_id is reset to NULL.
-- Tx 2: correctly sets to '99'. No leakage.

-- DANGEROUS: using SET (without LOCAL) in transaction pooling:
SET app.tenant_id = '42';  -- session variable, NOT reset at COMMIT
-- Connection reused: next tenant's request still has tenant_id='42'.
-- RLS: enforces wrong tenant context. Cross-tenant data leak.
-- ALWAYS USE SET LOCAL in transaction-mode pooling. Never plain SET.

-- Correct connection setup (all app queries do this at transaction start):
BEGIN;
SET LOCAL app.tenant_id = '42';
-- ... all queries here are automatically tenant-isolated by RLS ...
COMMIT;
-- After COMMIT: app.tenant_id = NULL (session default). Safe for reuse.
```

---

**Preventing BYPASSRLS and superuser leaks:**

```sql
-- Service accounts should NOT be superuser:
-- Superuser: bypasses RLS automatically. One cross-tenant bug = total breach.

-- Create application role with RLS enforced:
CREATE ROLE app_service LOGIN PASSWORD '...';
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_service;
-- app_service: RLS enforced. Normal user. Correct.

-- RLS bypass for admin/reporting service (explicit and audited):
CREATE ROLE reporting_admin BYPASSRLS LOGIN PASSWORD '...';
GRANT SELECT ON ALL TABLES IN SCHEMA public TO reporting_admin;
-- reporting_admin: can see all tenants. MUST be issued only to cross-tenant reporting tools.
-- Audit: log all connections by reporting_admin. Alert on unusual query patterns.

-- View who has BYPASSRLS:
SELECT rolname FROM pg_roles WHERE rolbypassrls = TRUE;
-- Should be: only superuser + reporting_admin (or equivalent).
-- Any unexpected role here: security incident.
```

---

## SECTION 8 — Optimization & Indexing

### Complete Multi-Tenant Index Strategy

```sql
-- Every table: tenant_id as leading column on ALL indexes.

-- Generic multi-tenant table:
CREATE TABLE items (
    tenant_id   INTEGER NOT NULL,
    id          BIGINT  NOT NULL,
    category_id INTEGER NOT NULL,
    status      TEXT    NOT NULL,
    user_id     INTEGER,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, id)
);

-- 1. Primary key (always tenant-first): already defined above.

-- 2. Category browse with pagination:
CREATE INDEX ON items(tenant_id, category_id, created_at DESC);

-- 3. Status filter (pending review queue):
CREATE INDEX ON items(tenant_id, status, created_at DESC)
    WHERE status IN ('pending', 'processing');  -- partial: only active statuses

-- 4. User's item history:
CREATE INDEX ON items(tenant_id, user_id, created_at DESC);

-- DO NOT create:
CREATE INDEX ON items(category_id);         -- BAD: cross-tenant, wrong
CREATE INDEX ON items(status);              -- BAD: cross-tenant, wrong
CREATE INDEX ON items(created_at);          -- BAD: cross-tenant, wrong only

-- Verify all indexes are tenant-aware:
SELECT
    indexname,
    indexdef
FROM pg_indexes
WHERE tablename = 'items'
  AND indexdef NOT LIKE '%tenant_id%';
-- Returns: indexes that do NOT reference tenant_id.
-- All of these should be reviewed — likely wrong for a multi-tenant table.

-- Per-tenant partitioning for large tenants:
-- When one tenant has >10M rows and others average 100K:
CREATE TABLE items_tenant_42 PARTITION OF items
    FOR VALUES IN (42);    -- dedicated partition for large tenant
CREATE TABLE items_others  PARTITION OF items DEFAULT;
-- Benefits: large tenant queries hit dedicated partition.
-- VACUUM, autovacuum: operates per-partition (won't block other tenants).
-- Schema change on tenant_42's data: only needs lock on items_tenant_42.

-- Monitor per-tenant query performance:
SELECT
    left(query, 80) AS query_snippet,
    calls,
    mean_exec_time,
    total_exec_time
FROM pg_stat_statements
WHERE query ILIKE '%tenant_id = 42%'
ORDER BY total_exec_time DESC
LIMIT 10;
-- Identify: which tenant's queries are slowest.
-- Targeted: add indexes only where benefiting specific tenants' query patterns.
```
