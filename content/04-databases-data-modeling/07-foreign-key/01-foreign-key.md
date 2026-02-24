# Foreign Key — Part 1 of 3

### Sections: 1 (Intuition), 2 (Why This Exists), 3 (Internal Working), 4 (Query Execution Flow)

**Series:** Databases & Data Modeling → Topic 07

---

## SECTION 1 — Intuition: The Library's Book-Borrower Ledger

A library records loan transactions: which book was borrowed by which member. The membership ledger and the book catalog are maintained separately. A loan record REFERENCES both a member ID and a book ID. If a member is deleted from the membership ledger, should their loan records still exist? The business answer is "no" — their loans should be cancelled or archived. The technical mechanism enforcing this relationship is a **foreign key constraint**.

```
FOREIGN KEY = A PROMISE ENFORCED BY THE DATABASE:
  "This value in table B MUST exist as a primary key in table A."

  Without FK constraint:
    DELETE FROM members WHERE id = 42;   -- member deleted
    SELECT * FROM loans WHERE member_id = 42;  -- still returns rows!
    "Who is member 42?" → nobody. Orphaned loans. Corrupt data.

  With FK constraint (ON DELETE CASCADE):
    DELETE FROM members WHERE id = 42;
    → DB automatically: DELETE FROM loans WHERE member_id = 42;
    → DB automatically: (recursively cascades to other tables with FK to loans)
    → Atomic. Either all deleted or none. No orphans.

  With FK constraint (ON DELETE RESTRICT — default):
    DELETE FROM members WHERE id = 42;
    → ERROR: update or delete on table "members" violates foreign key constraint
    → Forces application to handle the deletion explicitly. Safer.

WHAT FK GIVES YOU THE DATABASE ENFORCES:
  ✓ No orphaned child records (loans without members)
  ✓ No phantom parent references (product_id in orders pointing to deleted product)
  ✓ Cascade operations (delete parent → optionally delete/nullify children)
  ✓ Self-documentation: the schema IS the data relationship diagram
```

---

## SECTION 2 — Why This Exists: Production Failures

### Failure 1: Orphaned Records Causing Incorrect Billing

```
INCIDENT: SaaS billing platform. 6-month discrepancy discovered in audit.
FK: subscriptions.plan_id references plans.id — NOT enforced (FK removed "for performance").

Timeline:
  T=0:   Sales team deletes "Legacy Plan" from plans table (cleaning up old SKUs).
         plans.id = 15 deleted.
         subscriptions with plan_id = 15: 1,247 rows → now orphaned.

  T=0 to T+6mo: Monthly billing job:
    SELECT s.*, p.monthly_price FROM subscriptions s JOIN plans p ON s.plan_id = p.id;
    JOIN: subscriptions with plan_id = 15 → LEFT JOIN would show NULLs. INNER JOIN silently drops them.
    1,247 subscriptions: never billed. $89/month × 1,247 × 6 months = $666,666 unbilled.

  T+6mo: Audit finds discrepancy. Forensics reveals deleted plan.
  Some customers: still using the product, never charged, never noticed.
  Recovery: awkward billing correction, customer complaints, compensatory credits.

ROOT CAUSE: FK constraint disabled "for performance." Performance savings: ~1ms per INSERT.
Cost: $666K unbilled revenue + audit cost + customer relationship damage.
```

### Failure 2: Cascade Delete That Went Too Deep

```sql
-- DANGEROUS FK DESIGN:
CREATE TABLE users (id SERIAL PRIMARY KEY, email TEXT);
CREATE TABLE workspaces (id SERIAL PRIMARY KEY, owner_id INT REFERENCES users(id) ON DELETE CASCADE);
CREATE TABLE projects   (id SERIAL PRIMARY KEY, workspace_id INT REFERENCES workspaces(id) ON DELETE CASCADE);
CREATE TABLE tasks      (id SERIAL PRIMARY KEY, project_id INT REFERENCES projects(id) ON DELETE CASCADE);
CREATE TABLE comments   (id SERIAL PRIMARY KEY, task_id INT REFERENCES tasks(id) ON DELETE CASCADE);

-- Admin accidentally:
DELETE FROM users WHERE id = 42;

-- What the DB does:
-- 1. Deletes users row.
-- 2. CASCADE: deletes workspaces where owner_id = 42 → 3 workspaces.
-- 3. CASCADE: deletes projects in those 3 workspaces → 47 projects.
-- 4. CASCADE: deletes tasks in those 47 projects → 2,847 tasks.
-- 5. CASCADE: deletes comments on those 2,847 tasks → 89,423 comments.
-- Total: 92,320 rows deleted in one DELETE statement. Atomic. No warning. No undo.

-- INCIDENT: User requested account deletion (GDPR). Admin deleted their record.
-- Unintended: 3-year history of a 10-person team's work: gone. CASCADE fired.
-- Recovery: had to restore from last night's backup, replay 18 hours of transactions.

-- SAFER DESIGN:
-- Use ON DELETE RESTRICT (default) for most relationships.
-- Application handles cascades explicitly with proper logging and soft-delete first.
-- Reserve ON DELETE CASCADE for true child-only data with no independent value.
```

### Failure 3: FK Without Index on Child Column (Lock Contention)

```sql
-- Schema:
CREATE TABLE orders (id SERIAL PRIMARY KEY, customer_id INT NOT NULL REFERENCES customers(id));
-- NO index on orders.customer_id

-- OPERATIONS:
-- Thread 1: UPDATE customers SET tier = 'premium' WHERE id = 42;
-- Thread 2: INSERT INTO orders (customer_id, ...) VALUES (99, ...);
-- Thread 3: DELETE FROM customers WHERE id = 55;

-- WHAT HAPPENS:
-- UPDATE on customers: DB must verify no FK constraint affected (it's not, tier change).
-- DELETE on customers id=55: DB must scan orders.customer_id to check for children.
--   WITHOUT INDEX: full sequential scan on orders table to find any rows with customer_id = 55.
--   500M orders × scan = seconds of table scan while holding lock on customers row.
-- Meanwhile: all inserts/updates to orders that touch customer_id = 55's region: BLOCKED.
-- Plus: the sequential scan holds a table-level lock on orders.

-- PRODUCTION IMPACT: "Locks cascade" — one CASCADE CHECK causes wide lock.
-- Symptom: random lock timeout errors on the orders table during seemingly unrelated operations.

-- FIX: Always index the FK column on the child table.
CREATE INDEX idx_orders_customer_id ON orders(customer_id);
-- Now: FK check on DELETE customers = index lookup on orders (milliseconds, not seconds).
-- Lock scope: minimal. Problem eliminated.
```

---

## SECTION 3 — Internal Working

### Constraint Check Mechanics

```
ON EVERY INSERT into child table:
  DB checks: does the referenced PK value exist in the parent table?
  Mechanism: SHARE row-level lock on the parent row (ensures it can't be deleted mid-check).
  Cost: ~1 additional index lookup + lock acquisition.
  This is the "performance cost" people cite when disabling FKs. Usually negligible.

ON EVERY UPDATE to FK column in child table:
  Same check as INSERT.

ON EVERY DELETE from parent table:
  DB checks: are there child rows referencing this PK?
  ON DELETE RESTRICT: check if any child rows exist → error if yes.
  ON DELETE CASCADE: delete all child rows (recursive cascade trigger).
  ON DELETE SET NULL: set FK column to NULL in child rows.
  ON DELETE SET DEFAULT: set FK column to default value in child rows.

  Mechanism: look up all child rows via the FK index.
  WITHOUT INDEX on child FK column: full table scan of child table.
  WITH INDEX: index lookup → O(log N). Fast.

DEFERRED CONSTRAINT CHECKING:
  By default: FK checked IMMEDIATELY on each statement.
  DEFERRABLE INITIALLY DEFERRED: check at end of transaction.

  Use case: bulk data loading where parent + child inserted in same transaction,
  but order might not be topologically correct.

  Example: INSERT 10,000 users and their orders in one COPY command.
  Immediate check: fails if any order inserted before its user row.
  Deferred: all INSERTs proceed; constraint checked at COMMIT.
  If any orphan exists at COMMIT: entire transaction rolls back.

  CREATE TABLE orders (
    customer_id INT REFERENCES customers(id) DEFERRABLE INITIALLY DEFERRED
  );
```

### Partial FK Constraint (When You Don't Want Full Enforcement)

```sql
-- SCENARIO: Multi-tenant system. Some records are "system records" (tenant_id = 0)
-- that don't reference a real tenant. But all others must.

-- ❌ CANNOT partially enforce FK in standard SQL.
-- The constraint file applies to all rows.

-- ✅ WORKAROUND: Check constraint + trigger, or use a dummy "system" tenant row.
INSERT INTO tenants (id, name) VALUES (0, 'SYSTEM');
-- Now FK on tenant_id = 0 is valid — references row id=0 in tenants.
-- Semantically clean. FK enforced for all rows including "system" rows.

-- ALTERNATIVE: Use NULL for "no tenant" (FK allows NULL by default):
CREATE TABLE events (
  id         UUID PRIMARY KEY,
  tenant_id  INT REFERENCES tenants(id),  -- NULL allowed = "system event"
  payload    JSONB
);
-- tenant_id = NULL: no FK check (NULL never violates FK).
-- tenant_id = 42: must exist in tenants.id.
```

---

## SECTION 4 — Query Execution Flow

### FK Impact on INSERT and DELETE Performance

```
INSERT INTO orders (customer_id, total, status) VALUES (42, 99.99, 'PENDING'):

  1. Parse + Plan: trivial for single-row insert.

  2. Execute:
     a. Acquire RowExclusiveLock on orders table.
     b. FK CHECK: Is customer_id = 42 valid?
        → Lock parent row: SELECT 1 FROM customers WHERE id = 42 (FOR SHARE)
        → Acquires ShareLock on customers row 42.
        → Verifies row exists.
        → Releases ShareLock.
        → Time: ~0.3ms (index lookup on customers PK).
     c. Insert tuple into heap page.
     d. Update all indexes on orders table (PK + any other indexes).
     e. Write to WAL.
     f. Commit (releases RowExclusiveLock).

  Total FK overhead: ~0.3ms per INSERT. Negligible for OLTP rates.
  At 50,000 inserts/second: 0.3ms × 50,000 = 15 seconds of cumulative wait — but parallelized,
  so actual impact: adds ~0.3ms to each individual insert latency. Acceptable.

DELETE FROM customers WHERE id = 42:

  WITHOUT FK index on orders.customer_id:
    3. DB must verify no child rows exist.
    4. Scan orders table: SeqScan looking for customer_id = 42.
    5. 500M row table: 30+ seconds of sequential scan.
    6. Locks the orders table for read during scan → blocks inserts.

  WITH FK index on orders.customer_id:
    3. Index lookup: orders WHERE customer_id = 42 → returns 0 rows.
    4. Time: ~0.5ms. No table lock. No blocking.

DIAGNOSTIC: Finding FK columns missing indexes (Postgres):
  SELECT
    tc.table_name AS child_table,
    kcu.column_name AS fk_column,
    ccu.table_name AS parent_table
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name
  JOIN information_schema.constraint_column_usage ccu
    ON ccu.constraint_name = tc.constraint_name
  WHERE tc.constraint_type = 'FOREIGN KEY'
    AND NOT EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE tablename = tc.table_name AND indexdef LIKE '%' || kcu.column_name || '%'
    );
  -- Returns: every FK column that has no supporting index.
  -- All returned rows: immediate action required (add index before production issues arise).
```
