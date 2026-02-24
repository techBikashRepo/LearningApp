# Multi-Tenant Data — Part 3 of 3

### Sections: 9 (AWS Mapping), 10 (Interview Q&A), 11 (Debugging Exercise), 12 (Architect's Mental Model)

**Series:** Databases & Data Modeling → Topic 23

---

## SECTION 9 — AWS Service Mapping

### How AWS Services Support Multi-Tenant Data Models

| Layer             | AWS Service                         | Multi-Tenant Strategy                                                                                                                                                         |
| ----------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared DB         | Amazon RDS / Aurora (shared schema) | Row-level security per tenant. Single Aurora cluster, single schema, `tenant_id` column + RLS. Most cost-efficient. Used for SMB SaaS (<500 tenants, similar size).           |
| Schema-per-tenant | Amazon RDS (schema isolation)       | Separate PostgreSQL schema per tenant in one DB. Connection via `SET search_path = tenant_42`. Higher isolation, harder migrations. 100-1000 tenants.                         |
| DB-per-tenant     | Amazon RDS per-tenant / Aurora      | Separate RDS instance per enterprise tenant. Maximum isolation. Supports tenant-specific configuration. Expensive. Used for large enterprise customers with compliance needs. |
| Serverless        | Amazon Aurora Serverless v2         | Shared infrastructure, auto-scales per-cluster. RLS enforces tenant isolation. Scales down to near-zero for inactive tenants. Cost-optimized for SaaS with variable load.     |
| Connection Pool   | Amazon RDS Proxy                    | Manages connection pooling for multi-tenant workloads. Sets `SET LOCAL app.tenant_id` per transaction. Reduces connection churn for schema-per-tenant patterns.               |
| NoSQL             | Amazon DynamoDB                     | Partition key = `tenantId#entityId`. All items include tenantId. SDK-enforced tenant filtering (no RLS in DynamoDB). IAM policies can restrict per-tenant access.             |
| Search            | Amazon OpenSearch                   | Per-tenant index naming convention: `tenant_42_orders`. Index-level isolation. Rich Kibana dashboards per tenant. Tenant-specific retention policies.                         |
| Analytics         | Amazon Redshift                     | Shared cluster, separate schemas per tenant. Redshift Groups and permission grants control cross-tenant access. Redshift Spectrum for cold tenant data on S3.                 |

---

**Aurora with RLS + RDS Proxy:**

```python
# RDS Proxy manages connection pool.
# Application sets tenant context per transaction:
import psycopg2

def get_db_connection(tenant_id):
    conn = psycopg2.connect(host='your-rds-proxy-endpoint', ...)
    cursor = conn.cursor()
    # Set tenant context at transaction start:
    cursor.execute("SET LOCAL app.tenant_id = %s", [str(tenant_id)])
    # RLS automatically filters all subsequent queries to tenant_id.
    return conn, cursor

# Usage:
conn, cur = get_db_connection(tenant_id=42)
cur.execute("SELECT * FROM orders WHERE status = 'pending'")
# Returns: only orders for tenant 42. RLS enforces it.
orders = cur.fetchall()
conn.close()
```

---

## SECTION 10 — Interview Q&A

### Beginner Questions

**Q1: What are the three multi-tenancy models and when do you choose each?**

**(1) Shared database, shared schema (tenant_id column):** All tenants in one database, one set of tables, rows tagged with `tenant_id`. Cheapest, simplest to operate, hardest to isolate. Best for: high volume of small/SaaS tenants (thousands of SMBs with similar data sizes).

**(2) Shared database, schema-per-tenant:** One database, separate PostgreSQL schema per tenant (`SET search_path = tenant_42`). More isolation, easier per-tenant customization. Best for: medium isolation needs, 100-500 tenants, migrations manageable.

**(3) Database-per-tenant:** Separate database instance per tenant. Maximum isolation, highest cost, simplest compliance (GDPR: delete tenant database = complete erasure). Best for: large enterprise customers, regulated industries, customers with strict data residency requirements.

---

**Q2: Why must `tenant_id` be the leading column in every index on a multi-tenant table?**

Because the most selective filter in any query from a multi-tenant application is the tenant boundary. When `tenant_id` is the leading index column, the database can skip to exactly the segment of the index belonging to that tenant — scanning only that tenant's rows. If `tenant_id` is a trailing column (or absent), the database must scan across all tenants' index entries to find the ones matching, then filter. On a table with 30M rows across 150 tenants, the difference is scanning 200K rows (correct) vs 30M rows (wrong) for a typical tenant query.

---

**Q3: What is Row Level Security and how does it provide tenant isolation?**

Row Level Security (RLS) is a PostgreSQL feature that automatically appends a WHERE clause to every query based on a policy. For multi-tenancy: `CREATE POLICY tenant_isolation ON orders USING (tenant_id = current_setting('app.tenant_id')::INTEGER)`. After `ALTER TABLE orders ENABLE ROW LEVEL SECURITY`, every `SELECT/INSERT/UPDATE/DELETE` on `orders` is automatically filtered to the current tenant's rows — even if the developer writes `SELECT * FROM orders` without any WHERE clause. It is a database-level enforcement mechanism: application bugs, missing WHERE clauses, or new developer mistakes cannot leak cross-tenant data.

---

### Intermediate Questions

**Q4: A large enterprise tenant is degrading performance for all other tenants (noisy neighbor). How do you solve it?**

Short-term: rate-limit the large tenant's queries at the application connection pool layer (assign fewer connections to that tenant's pool). Medium-term: move the large tenant to a dedicated partition within the same database — `CREATE TABLE orders_tenant_enterprise PARTITION OF orders FOR VALUES IN (tenant_enterprise_id)`. This gives the large tenant's data its own autovacuum, its own index pages (reduced buffer contention), and allows index tuning specific to their access patterns. Long-term: offer the large tenant a dedicated RDS instance as an enterprise tier. The dedicated instance means their I/O cannot impact others; it also lets them choose retention, backup windows, and maintenance independently.

---

**Q5: How do you safely run schema migrations across 500 tenants in a schema-per-tenant model?**

Parallel migration with concurrency control: (1) Build a migration runner that iterates all 500 tenant schemas. (2) Run migrations in batches of 20 schemas concurrently (configurable based on DB capacity). (3) Each migration step: `SET search_path = tenant_{id}; ALTER TABLE orders ADD COLUMN ...;`. (4) Track completion in a `migration_log` table: `(schema_name, migration_version, status, applied_at)`. (5) Idempotent migrations: each migration checks if already applied (by checking column existence or migration_log) before executing. (6) Rollback plan: for every migration add a DOWN script. (7) Test on 5 tenants first (canary). (8) Monitor for lock waits: `pg_locks` during migration. Total time for 500 tenants with 20-parallel: duration of one migration × (500/20) batches.

---

### Advanced Questions

**Q6: How do you achieve GDPR compliance (right to erasure) in a shared-schema multi-tenant model?**

GDPR "right to erasure" for tenant data: when a tenant cancels and requests data deletion, you must delete all their data from shared tables. Strategy: (1) Tag all tables with `tenant_id`. (2) Execute: `DELETE FROM each_table WHERE tenant_id = $x` in the right FK order (leaf tables first). (3) For PII specifically: anonymize-in-place for tables with regulatory retention (financial records must be kept but PII removed): `UPDATE orders SET customer_email = 'redacted', customer_name = 'redacted' WHERE tenant_id = $x`. (4) Track deletion job in a `tenant_deletion_jobs` table with per-table completed flags. (5) Idempotent: deletion job can be retried. (6) Certificate of deletion: log completion timestamp and tables processed — provide to tenant as compliance record. Automating this with a `GDPR_delete_tenant($x)` stored procedure reduces risk of missing a table.

---

**Q7: Design a multi-tenant analytics system where tenants can run ad-hoc queries on their own data without seeing other tenants' data.**

Architecture: (1) **Isolated Redshift schemas**: each tenant has `tenant_42` schema in shared Redshift cluster. Data loaded into their schema only. (2) **Redshift IAM + database users**: tenant's analytics user has USAGE on `tenant_42` schema only. Cross-schema access: denied by default. (3) **API layer**: tenant submits SQL query via API. API validates query (SQL injection protection), prepends `SET search_path = tenant_{id}`, executes via dedicated connection pool for that tenant. (4) **Query timeout and resource limits**: Redshift workload management (WLM) queue per tenant tier. (5) **Result caching**: Redshift query result cache serves repeated queries instantly. (6) **Row-level**: for especially sensitive shared tables, Redshift dynamic data masking and row-level security provide additional filtering. This gives tenants self-service analytics with hard schema-level isolation.

---

## SECTION 11 — Debugging Exercise

### Production Incident: Tenant Data Leaking via Admin API

**Scenario:**
A customer from tenant B contacts you saying they can see data belonging to a competitor (tenant A) in the admin export feature. This is a GDPR incident with potential fines up to €20M.

**Immediate investigation:**

```sql
-- Check what tenant B's admin exported:
SELECT
    export_id, tenant_id, exported_by, exported_at,
    record_count, query_used
FROM export_audit_log
WHERE exported_by = 'admin@tenant-b.com'
  AND exported_at > NOW() - INTERVAL '24 hours';
-- exported_at: 2024-12-01 14:23:11
-- query_used: SELECT * FROM orders WHERE status = 'shipped'
-- Note: NO tenant_id filter in the query_used field.
```

**Finding the leak:**

```sql
-- Test the leaking query:
-- Application code for admin export (buggy):
def export_orders(status_filter):
    # BUG: no tenant_id filter — exports ALL tenants' matching orders!
    return db.execute("SELECT * FROM orders WHERE status = %s", [status_filter])

-- Even with RLS enabled: the export was run by a service account with BYPASSRLS.
-- Check:
SELECT rolname FROM pg_roles WHERE rolbypassrls = TRUE;
-- export_service_account: BYPASSRLS = TRUE  ← the runaway permission
```

**Root cause:** The export service account had `BYPASSRLS` enabled. RLS was in place for normal app users, but the export feature used a privileged account that bypassed it. The export query had no `tenant_id` filter in the code.

**Immediate fix:**

```sql
-- Remove BYPASSRLS from export service account:
ALTER ROLE export_service_account NOBYPASSRLS;
-- Now: RLS enforces tenant context even for export service.

-- Add tenant context to export service:
-- Before every export: SET LOCAL app.tenant_id = $tenant_id;

-- Add explicit WHERE clause as defense-in-depth:
def export_orders(tenant_id, status_filter):
    return db.execute(
        "SELECT * FROM orders WHERE tenant_id = %s AND status = %s",
        [tenant_id, status_filter]
    )

-- Audit all BYPASSRLS roles monthly:
SELECT rolname, rolsuper, rolbypassrls FROM pg_roles
WHERE rolbypassrls = TRUE OR rolsuper = TRUE
ORDER BY rolname;
-- Any unexpected role: security review immediately.
```

**GDPR response:** Document the incident, identify exact records exposed (via export_audit_log), notify affected tenants within 72 hours, notify supervisory authority if >250 employees affected. Provide remediation steps taken.

---

## SECTION 12 — Architect's Mental Model

### 5 Decision Rules

1. **`tenant_id` as leading column on every index, composite PK, and composite FK. No exceptions.** Before any CREATE INDEX on a multi-tenant table: does it start with `tenant_id`? If not: it is wrong. Run the index audit query (indexes NOT containing tenant_id) monthly.

2. **RLS is the safety net; explicit WHERE tenant_id is the primary filter.** Defensive coding: always include `WHERE tenant_id = $x` in application queries AND have RLS as the backstop. Two independent enforcement mechanisms. One bug in either: the other catches it.

3. **BYPASSRLS roles: audit quarterly, restrict to minimum necessary.** The most dangerous permission in a multi-tenant system. Superuser and BYPASSRLS roles: tight access control, logged, reviewed. Any service that doesn't need cross-tenant access: must NOT have BYPASSRLS.

4. **SET LOCAL, never SET, in transaction-mode connection pooling.** `SET LOCAL app.tenant_id` resets on COMMIT/ROLLBACK. `SET app.tenant_id` persists to next transaction (wrong tenant). In ANY pooled environment: `SET LOCAL`. Always. Document this in the codebase onboarding guide.

5. **Test for cross-tenant data leaks in CI/CD.** Add a test: create two tenants (A and B), insert records for each, query as tenant A, assert zero records from tenant B appear. Run this test against every endpoint that reads tenant data. Makes cross-tenant leaks a failing CI check, not a production incident.

---

### 3 Common Mistakes

**Mistake 1: Adding `tenant_id` to the WHERE clause but not to the index.** The query filters correctly, but the index on `status` doesn't include `tenant_id` as leading column. Index used: cross-tenant scan + filter. Correct indexes required for correct performance, not just correct results.

**Mistake 2: Schema-per-tenant without automating schema migration.** After 200 tenants: manually running migrations per schema is untenable. Migration runner with a `tenant_list` table, concurrency control, and idempotent migration scripts must be built from day one of schema-per-tenant adoption, not retrofitted at 100 tenants.

**Mistake 3: Treating multi-tenancy as purely an application concern.** "We'll just add WHERE tenant_id in every query." This fails at the first developer mistake, the first ad-hoc DBA query, or the first BI tool connected directly to the database. Multi-tenancy must be enforced at the database layer (RLS) for correctness guarantees that hold under all access paths.

---

### 30-Second Interview Answer

> "Multi-tenancy has three models — shared schema with tenant_id column (cost-efficient, RLS-enforced), schema-per-tenant (stronger isolation), and database-per-tenant (maximum isolation for enterprise). For shared schema, two things are critical: tenant_id as the leading column on every index (so scans are always tenant-scoped) and Row Level Security (so no query can accidentally cross tenant boundaries regardless of application bugs). The identity is passed via `SET LOCAL app.tenant_id` at transaction start — using SET LOCAL so it resets at commit and doesn't leak to the next connection pool request. Every BYPASSRLS role is audited quarterly, because that's the one permission that voids your entire isolation guarantee."

---

_→ Next: [03-N+1 Query Problem.md](../24 - N+1 Query Problem/03-N+1 Query Problem.md)_
