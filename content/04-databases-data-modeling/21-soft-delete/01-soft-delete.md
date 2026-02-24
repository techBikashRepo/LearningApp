# Soft Delete — Part 1 of 3

### Sections: 1 (Intuition & Analogy), 2 (Why This Exists), 3 (Internal Working), 4 (Query Execution Flow)

**Series:** Databases & Data Modeling → Topic 21

---

## SECTION 1 — Intuition & Analogy

### The Recycle Bin

When you delete a file on your operating system, it doesn't immediately vanish from the disk. It goes to the Recycle Bin — flagged as "deleted," invisible during normal use, but recoverable if you empty the bin accidentally. The file remains on disk, fully intact, just hidden from the standard file browser. `rm -rf` (hard delete) is the true permanent removal.

**Soft delete is the database equivalent of the Recycle Bin.** Instead of executing `DELETE FROM users WHERE id = 42`, you execute:

```sql
UPDATE users SET deleted_at = NOW() WHERE id = 42;
```

The row persists in the database. All its data — relationships, history, foreign key targets — remain intact. Normal application queries add `WHERE deleted_at IS NULL` to ignore it. But the data is accessible for recovery, auditing, compliance, or forensics.

```
Hard delete:       Soft delete:
users table:       users table:
id | name          id | name  | deleted_at
42 | Alice    →    42 | Alice | 2024-03-15 09:42:00
(row gone)         (row present but "invisible")

Foreign keys       Foreign keys
pointing to id=42: pointing to id=42:
  → REFERENTIAL ERROR  → still valid
  → cascades or fails  row still exists
```

The trade-off is explicit: **data safety and auditability in exchange for storage, query complexity, and UNIQUE constraint management overhead.**

---

## SECTION 2 — Why This Problem Exists (Production Failures)

### Real-World Incidents: The Cost of Hard Deleting

**Incident 1: Financial Platform — Compliance Audit Failure**
Platform: fintech startup, 120K users. Regulator required: all user account data retained for 7 years after account closure for anti-money-laundering audit purposes. Architecture: hard delete on account closure. After 18 months of operation, the company's compliance officer requested a 5-year audit trail. Result: 8,400 accounts hard-deleted since launch had zero data. Regulatory fine: $840K. Emergency migration: 4 months to reconstruct partial data from event logs.

Root cause: no soft delete policy. Once users closed accounts, all data was permanently destroyed. Irrecoverable.

---

**Incident 2: SaaS — Accidental Mass Delete, No Recovery**
Platform: B2B project management tool. A developer ran a database migration on production intended for a test tenant, mistakenly targeting `WHERE tenant_id IN (1,2,3)` when the test tenant was tenant_id=4. 3 production tenants with hard-deleted projects, tasks, and comments. 47,000 rows deleted. No soft delete. No row-level backup. Most recent backup: 6 hours old. 6 hours of data permanently lost. Customer compensation: $280K in credits and contract renegotiation.

---

**Incident 3: E-commerce — Order History Disappearing on User Deactivation**
Platform: marketplace. When a seller deactivated their account, their user record was hard deleted. Foreign key ON DELETE CASCADE: also deleted all their products and all their orders. Buyers who had purchased from the seller: their order history now showed blank seller names, missing product details, and broken receipts. Customer support: 12,000 tickets. Legal: two threatened lawsuits from buyers over missing transaction records.

Root cause: hard delete + CASCADE = one deletion can destroy a graph of related data unexpectedly.

---

**Incidents from INCORRECT soft delete implementations:**

**Incident 4: UNIQUE Constraint Violation on Re-Registration**
User deletes account → `deleted_at = NOW()`. User re-registers with same email. UNIQUE constraint on `email` column: still enforces uniqueness across deleted rows. `INSERT INTO users WHERE email = 'alice@corp.com'` → duplicate key error. User: "why can't I use my own email?" Engineering: one week to migrate to partial UNIQUE index.

---

## SECTION 3 — Internal Working

### Implementing Soft Delete in PostgreSQL

**Core schema pattern:**

```sql
CREATE TABLE users (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email       TEXT NOT NULL,
    name        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at  TIMESTAMPTZ,           -- NULL = active, NOT NULL = soft-deleted
    deleted_by  INTEGER REFERENCES users(id)  -- who initiated the deletion
);

-- WRONG: UNIQUE on email blocks re-registration after soft delete
-- ALTER TABLE users ADD CONSTRAINT uq_email UNIQUE (email);

-- CORRECT: Partial UNIQUE index — only enforce among active (non-deleted) rows
CREATE UNIQUE INDEX uq_users_email_active
    ON users (email)
    WHERE deleted_at IS NULL;
-- Soft-deleted users don't participate in the uniqueness check.
-- Email becomes available again when the row is soft-deleted.

-- Index for efficient filtering of active records:
CREATE INDEX idx_users_active ON users (id) WHERE deleted_at IS NULL;
-- Index-only scan for most queries: WHERE deleted_at IS NULL.
-- Without this: every query scans all rows (including deleted) then filters.
```

---

**PostgreSQL Row-Level Security (RLS) for transparent soft delete:**

```sql
-- Enable RLS on the table
ALTER TABLE users ENABLE ROW LEVEL SECURITY;

-- Policy: hide soft-deleted rows automatically for all non-admin roles
CREATE POLICY hide_deleted_users ON users
    FOR ALL
    TO app_role  -- the role used by the application
    USING (deleted_at IS NULL);

-- Application queries: no need to add WHERE deleted_at IS NULL manually
-- SELECT * FROM users WHERE id = 42; → automatically sees only active rows
-- Admin role (not bound by this policy): can see all rows including deleted
-- Bypass: SET ROLE admin_role; → policy not applied
```

**Caveat:** RLS adds ~5-10% query overhead. For high-throughput queries, explicit `WHERE deleted_at IS NULL` + partial index is faster. Choose based on security requirement vs performance.

---

**Soft delete for tables with foreign key references:**

```sql
CREATE TABLE projects (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_id    INTEGER NOT NULL REFERENCES users(id),  -- FK to users
    name        TEXT NOT NULL,
    deleted_at  TIMESTAMPTZ
);

-- When a user is soft-deleted:
-- 1. FK reference (owner_id) still points to an existing row → no constraint violation
-- 2. The project is "orphaned from an active user" but the data is intact
-- 3. Application layer must decide: cascade soft-delete? Or leave as detached record?

-- Cascade soft-delete via trigger:
CREATE OR REPLACE FUNCTION cascade_soft_delete_projects() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
        UPDATE projects
        SET deleted_at = NEW.deleted_at
        WHERE owner_id = NEW.id AND deleted_at IS NULL;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_cascade_soft_delete_user
AFTER UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION cascade_soft_delete_projects();
```

---

**Cleanup: physical deletion of aged soft-deleted rows:**

```sql
-- Retention policy: permanently delete soft-deleted records older than 90 days
-- Run as a scheduled maintenance job:
DELETE FROM users
WHERE deleted_at IS NOT NULL
  AND deleted_at < NOW() - INTERVAL '90 days';

-- If regulated retention (7 years for financial data): archive to cold storage first
INSERT INTO users_archive
SELECT * FROM users
WHERE deleted_at IS NOT NULL
  AND deleted_at < NOW() - INTERVAL '7 years';

DELETE FROM users
WHERE deleted_at IS NOT NULL
  AND deleted_at < NOW() - INTERVAL '7 years';
```

---

## SECTION 4 — Query Execution Flow

### How Soft Delete Affects Query Plans

**Scenario:** query active users in a 20M-row users table where 3M rows are soft-deleted.

```sql
-- Without partial index (naive):
EXPLAIN ANALYZE
SELECT id, email, name FROM users
WHERE deleted_at IS NULL
  AND created_at >= '2024-01-01';

-- Execution without partial index:
-- Seq Scan on users  (cost=0..480,000 rows=17,000,000 width=...)
--   Filter: (deleted_at IS NULL AND created_at >= '2024-01-01')
--   Rows Removed by Filter: 3,000,000  ← scanning all deleted rows wastefully
-- Execution time: 4,200ms (scanning 20M rows to return 2M)

-- Add partial index:
CREATE INDEX idx_users_active_created_at
    ON users (created_at)
    WHERE deleted_at IS NULL;
-- This index contains ONLY the 17M active rows. 3M deleted rows: not in the index.

EXPLAIN ANALYZE
SELECT id, email, name FROM users
WHERE deleted_at IS NULL
  AND created_at >= '2024-01-01';

-- Index Scan using idx_users_active_created_at on users
--   (cost=0.56..4,280 rows=280,000 width=...)
--   Index Cond: (created_at >= '2024-01-01')
-- Execution time: 280ms  → 15x improvement
-- Partial index: 17M entries vs full index: 20M entries. Also smaller: less memory footprint.

-- Counting active users (dashboard metric):
EXPLAIN ANALYZE SELECT COUNT(*) FROM users WHERE deleted_at IS NULL;

-- Without partial index: SeqScan of 20M rows. ~2,000ms.
-- With partial index on (id) WHERE deleted_at IS NULL:
-- Index Only Scan (reads index, doesn't touch heap at all)
-- Execution time: 45ms  (index-only scan on 17M entries)
```

**The compound soft-delete + business filter query:**

```sql
-- Find active users who placed orders last month:
SELECT u.id, u.email
FROM users u
WHERE u.deleted_at IS NULL
  AND EXISTS (
    SELECT 1 FROM orders o
    WHERE o.customer_id = u.id
      AND o.ordered_at >= '2024-02-01'
      AND o.ordered_at < '2024-03-01'
  );

-- Query plan:
-- Hash Semi Join
--   → Bitmap Index Scan on idx_users_active (deleted_at IS NULL)
--   → Index Scan on orders (ordered_at range)
-- Execution time (with indexes): 340ms vs 14,000ms without partial index
```
