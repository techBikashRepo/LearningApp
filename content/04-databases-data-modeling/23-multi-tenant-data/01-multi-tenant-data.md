# Multi-Tenant Data — Part 1 of 3

### Sections: 1 (Intuition & Analogy), 2 (Why This Exists), 3 (Internal Working), 4 (Query Execution Flow)

**Series:** Databases & Data Modeling → Topic 23

---

## SECTION 1 — Intuition & Analogy

### The Apartment Building

An apartment building has many tenants. They share:

- The building infrastructure (foundation, plumbing, elevators)
- Common areas (lobby, roof deck)
- Costs (proportional to their unit)

But each apartment is **private**. Tenant A cannot open Tenant B's door. Tenant B cannot look through Tenant A's windows. The building manager (super-user) has access to all units for maintenance.

**Multi-tenant databases work the same way.** Multiple customers (tenants) share the same database infrastructure but their data must be:

1. **Isolated**: Tenant A cannot read Tenant B's data.
2. **Separate**: Tenant B's load should not degrade Tenant A's performance.
3. **Maintainable**: schema changes, upgrades, and backups should be efficient across all tenants.

```
Three apartment building models (three multi-tenancy models):

Model 1: Shared Building, Labeled Rooms (Shared Schema)
  One database. One set of tables.
  Every row has a tenant_id column.
  Pros: simple, cheap, scales to thousands of tenants.
  Cons: tenant isolation enforced by application/RLS (not physical separation).
       One large tenant can slow all others (noisy neighbor).
       Compliance: all tenants' data in one database (may violate data residency laws).

Model 2: Separate Floors (Schema-Per-Tenant)
  One database. Each tenant: their own schema (namespace).
  Table: tenant_42.orders, tenant_99.orders (different schemas, same table names).
  Pros: schema-level isolation. Tenant-specific customization possible.
  Cons: schema proliferation (thousands of schemas = management overhead).
       Connection pooling complexity.

Model 3: Separate Buildings (Database-Per-Tenant)
  Each tenant: their own database (possibly their own server).
  Pros: true isolation. Tenant-specific backups, compliance, scaling.
  Cons: expensive ($N × server cost). Complex deployment. Hard to cross-tenant query.
       Only feasible for high-value enterprise tenants.
```

Most SaaS companies start with Shared Schema, migrate hot tenants to dedicated databases as they grow.

---

## SECTION 2 — Why This Problem Exists (Production Failures)

### Real-World Incidents: Multi-Tenancy Gone Wrong

**Incident 1: Tenant Data Leakage — Missing tenant_id in Query**
Platform: B2B SaaS CRM, 2,800 tenant companies. Bug: a developer wrote a new "global search" feature. Query: `SELECT * FROM contacts WHERE name ILIKE '%alice%'`. Missing: `AND tenant_id = $current_tenant`. Result: searching for "Alice" returned contacts from ALL tenants that had customers named Alice. 12 tenants had their customer lists exposed to other tenants for 6 hours before the bug was caught. GDPR breach notification required. Regulatory investigation. Two tenants terminated contracts. Revenue impact: $1.4M.

Root cause: application-layer enforcement (missing WHERE clause) with no database-level safety net.

---

**Incident 2: Noisy Neighbor — One Tenant Crashed All Others**
Platform: multi-tenant analytics platform, 400 tenants. Single large enterprise tenant launched a marketing campaign, generating 300M new events in one hour — 50x normal volume. Shared `events` table: 8 billion rows. Autovacuum: fell behind. Table bloat. All tenant queries (including small tenants with 5,000 events) degraded from 12ms to 8,000ms. 380 tenants experienced severe performance degradation for 4 hours.

Root cause: shared schema with no per-tenant resource isolation. One tenant's write storm affected all.

---

**Incident 3: Schema Migration Failure Across 6,000 Tenants**
Platform: schema-per-tenant SaaS, 6,000 tenants. Migration: ADD COLUMN to all tenant schemas. Migration script: looped through all schemas, executed ALTER TABLE. Runtime: 14 hours (6,000 × ~8 seconds per table lock). During this time: all tenants experienced brief write stalls. 40 tenants (those with the most data) experienced up to 90-second write locks.

Root cause: schema-per-tenant at scale makes table DDL operations O(N tenants) in cost and duration.

---

## SECTION 3 — Internal Working

### Multi-Tenancy Implementation in PostgreSQL

**Model 1: Shared Schema with tenant_id**

```sql
-- Every table has tenant_id as the FIRST column in composite indexes:
CREATE TABLE projects (
    id          BIGINT GENERATED ALWAYS AS IDENTITY,
    tenant_id   INTEGER NOT NULL REFERENCES tenants(id),
    name        TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'active',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, id)   -- composite PK: tenant_id first
--  ^^^^^^^^^^^^: every row access is routed through tenant_id.
--  Physical ordering: all rows for tenant_id=42 clustered together.
);

-- ALL indexes: tenant_id as leading column:
CREATE INDEX idx_projects_tenant_status ON projects (tenant_id, status);
CREATE INDEX idx_projects_tenant_name   ON projects (tenant_id, name);
-- Without tenant_id leading: a query for tenant 42's active projects
-- reads ALL tenants' index entries first, then filters. Cross-tenant data pollution.
```

---

**PostgreSQL Row-Level Security (RLS) — database-enforced tenant isolation:**

```sql
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;

-- Policy: each session can only see its own tenant's rows
CREATE POLICY tenant_isolation ON projects
    USING (tenant_id = current_setting('app.tenant_id')::INTEGER);

-- Application: set tenant context at connection/transaction start:
SET app.tenant_id = '42';  -- or: SET LOCAL app.tenant_id = '42' (transaction-scoped)
-- Now: SELECT * FROM projects → automatically filtered to tenant 42.
-- No WHERE tenant_id needed in application queries.
-- Leakage bug (missing WHERE): RLS catches it at the database layer.

-- Superuser bypass (for admin tools):
ALTER TABLE projects FORCE ROW LEVEL SECURITY;  -- applies even to table owner
-- Except: roles with BYPASSRLS attribute still bypass.
-- Admin role: GRANT BYPASSRLS TO admin_role; → admin can see all tenants.

-- Performance note: RLS adds a filter condition to every query.
-- With tenant_id as leading index column: the RLS filter becomes an index condition.
-- Overhead: negligible (the filter would have been there anyway as a WHERE clause).
```

---

**Model 2: Schema-Per-Tenant**

```sql
-- Create a schema for each tenant:
CREATE SCHEMA tenant_42;
SET search_path = tenant_42;

CREATE TABLE projects (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        TEXT NOT NULL,
    status      TEXT NOT NULL
    -- No tenant_id needed: schema IS the tenant namespace
);

-- All tenant_42 connections: SET search_path = tenant_42;
-- queries automatically resolve to tenant_42.projects
-- Isolation: schema-level. SELECT * FROM projects only sees tenant_42 rows.

-- Shared lookup tables (e.g., plan_types): in a shared schema:
CREATE TABLE public.plan_types (id INTEGER PRIMARY KEY, name TEXT);
-- SET search_path = tenant_42, public; → tenant tables first, public as fallback.
```

---

**Tenant-aware connection pooling (PgBouncer):**

```
Schema-per-tenant + PgBouncer:
  Each tenant gets a "named" pool.
  PgBouncer pool config:
    pool_tenant_42: user=app dbname=saasdb pool_size=10
    pool_tenant_99: user=app dbname=saasdb pool_size=5
  On connection: PgBouncer runs: SET search_path = tenant_{id};
  All queries in that connection: routed to the correct schema automatically.

Shared schema + PgBouncer:
  Single pool. On checkout: PgBouncer runs: SET LOCAL app.tenant_id = '{id}';
  RLS policy reads app.tenant_id → tenant isolation enforced.
  Simpler pooling. Slightly more complex security model.
```

---

## SECTION 4 — Query Execution Flow

### How Tenant Isolation Affects Query Plans

**Scenario:** Shared schema, 10M rows in `projects`, 5,000 tenants. Query: all active projects for tenant 42.

```sql
-- Setup:
-- projects table: 10M rows. Tenant 42: 2,000 rows.
-- Index: idx_projects_tenant_status ON projects (tenant_id, status)

-- WITHOUT tenant_id in index (bad):
EXPLAIN ANALYZE
SELECT id, name FROM projects WHERE status = 'active' AND tenant_id = 42;

-- Bitmap Index Scan on idx_projects_status (index only on status)
--   Index Cond: (status = 'active')
--   → returns 6M rows (60% of table is active)
-- Bitmap Heap Scan: 6M rows fetched from heap
-- Recheck Cond: tenant_id = 42
--   → filters 6M down to 2,000
-- Execution time: 8,400ms. Scanned 6M rows to get 2,000.

-- WITH (tenant_id, status) composite index:
EXPLAIN ANALYZE
SELECT id, name FROM projects WHERE tenant_id = 42 AND status = 'active';

-- Index Scan using idx_projects_tenant_status on projects
--   Index Cond: (tenant_id = 42 AND status = 'active')
--   → returns exactly 2,000 rows (only tenant 42's active projects)
-- Execution time: 3.2ms. Scanned 2,000 rows. Perfect.

-- Key difference: tenant_id in leading position of the composite index
-- means PostgreSQL descends the B-tree to exactly tenant 42's range,
-- never touching any other tenant's rows.
```

**RLS-enabled query plan:**

```sql
SET app.tenant_id = '42';

EXPLAIN ANALYZE SELECT id, name FROM projects WHERE status = 'active';
-- PostgreSQL rewrites the query to: WHERE tenant_id = 42 AND status = 'active'
-- (the RLS USING clause is appended as a filter predicate)
-- Index Scan using idx_projects_tenant_status on projects
--   Index Cond: ((tenant_id = current_setting(...)::integer) AND (status = 'active'))
-- Execution time: 3.2ms (same as explicit WHERE clause)
-- The RLS filter is pushed down into the index scan. Zero overhead vs explicit WHERE.
```
