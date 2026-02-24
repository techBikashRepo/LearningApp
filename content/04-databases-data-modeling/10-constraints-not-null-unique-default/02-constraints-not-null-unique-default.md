# Constraints (NOT NULL, UNIQUE, DEFAULT) — Part 2 of 3

### Sections: 5 (Bad vs Correct), 6 (Performance Impact), 7 (Concurrency & Data Integrity), 8 (Optimization & Indexing)

**Series:** Databases & Data Modeling → Topic 10

---

## SECTION 5 — Bad Usage vs Correct Usage

### Pattern 1: Nullable FK When Relationship Is Required

```sql
-- BAD: order must always reference a customer, but FK is nullable
CREATE TABLE orders (
    id          BIGSERIAL PRIMARY KEY,
    customer_id INT REFERENCES customers(id),  -- nullable! ORM default
    amount      NUMERIC(12,2),
    status      VARCHAR(20)
);

-- Problem: ORM omits customer_id → NULL inserted → valid row with no owner
INSERT INTO orders (amount, status) VALUES (99.99, 'PENDING');
-- Succeeds. Zero warning. Order exists. Nobody owns it. Reports miss it.

-- CORRECT: FK is NOT NULL → DB enforces the requirement
CREATE TABLE orders (
    id          BIGSERIAL PRIMARY KEY,
    customer_id INT NOT NULL REFERENCES customers(id),  -- explicitly required
    amount      NUMERIC(12,2) NOT NULL,
    status      VARCHAR(20)   NOT NULL DEFAULT 'PENDING'
);
-- Any INSERT without customer_id: raises ERROR. Caught at the data layer.
-- Any ORM that omits the column: fails explicitly. Bug surfaces immediately.
```

### Pattern 2: UNIQUE at Application Layer Only

```sql
-- BAD: relying on application-level uniqueness check
-- Application code:
  existing = db.query("SELECT 1 FROM users WHERE email = $1", email)
  if not existing:
      db.execute("INSERT INTO users (email, ...) VALUES ($1, ...)", email)
-- Problem: between SELECT and INSERT, a race condition allows two concurrent
-- registrations with the same email to both succeed. Two accounts, same email.

-- CORRECT: UNIQUE constraint at database level
CREATE TABLE users (
    id    BIGSERIAL PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE  -- backed by a unique B-tree index
);
-- Application INSERT:
INSERT INTO users (email, name) VALUES ('alice@corp.com', 'Alice')
ON CONFLICT (email) DO NOTHING;  -- or DO UPDATE to upsert
-- The constraint catches the race. The second concurrent INSERT blocks,
-- sees the first commit, detects the duplicate, and returns ON CONFLICT.
-- No application-level SELECT check needed. Simpler and correct.
```

### Pattern 3: Missing DEFAULT Causes Logic Bugs

```sql
-- BAD: status column with no DEFAULT
CREATE TABLE audit_events (
    id         BIGSERIAL PRIMARY KEY,
    user_id    INT,
    event_type VARCHAR(50),
    processed  BOOLEAN  -- no DEFAULT, no NOT NULL
);
-- Any INSERT that omits processed: stores NULL.
-- Filter: WHERE processed = FALSE → NULL rows excluded (NULL != FALSE).
-- Worker that processes events: never picks up NULL-processed events.
-- Silent data loss in the pipeline.

-- CORRECT: sensible DEFAULT + NOT NULL
CREATE TABLE audit_events (
    id         BIGSERIAL PRIMARY KEY,
    user_id    INT        NOT NULL,
    event_type VARCHAR(50) NOT NULL,
    processed  BOOLEAN    NOT NULL DEFAULT FALSE
);
-- Every event: starts as processed=FALSE. Worker: finds and processes it.
-- Completed: UPDATE ... SET processed=TRUE. Never lost in NULL limbo.
```

### Pattern 4: CHECK Constraint Replacing Enum Validation

```sql
-- BAD: status stored as free-text VARCHAR, validated only in application
CREATE TABLE tasks (
    id     BIGSERIAL PRIMARY KEY,
    status VARCHAR(20)  -- application sends: 'pending', 'PENDING', 'Pending' - all different!
);
-- Developer sends 'inprogress' instead of 'in_progress'. Typo. Valid INSERT. Silent bug.
-- Reports GROUP BY status: 3 groups instead of 1. Inconsistent reporting.

-- CORRECT: CHECK constraint enforces valid values
CREATE TABLE tasks (
    id     BIGSERIAL PRIMARY KEY,
    status VARCHAR(20) NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'in_progress', 'done', 'failed'))
);
-- 'inprogress': ERROR check constraint violated. Caught at insert time.
-- Or use a proper ENUM type (even stricter, but harder to migrate):
-- status task_status NOT NULL DEFAULT 'pending'  (where task_status is a CREATE TYPE ENUM)
```

### Pattern 5: DEFAULT NOW() vs DEFAULT CURRENT_TIMESTAMP Confusion

```sql
-- BOTH actually work identically in PostgreSQL for TIMESTAMPTZ columns.
-- But: subtle difference if you store in a variable vs direct DDL.

-- DEFAULT now(): function reference, evaluated at INSERT time. Correct.
-- DEFAULT '2024-01-01': literal value — ALL rows get the same hardcoded date. WRONG for created_at.

-- BAD: hardcoded date default
ALTER TABLE events ADD COLUMN created_at TIMESTAMPTZ DEFAULT '2024-01-01 00:00:00';
-- New rows inserted in 2026: get 2024-01-01. All wrong. Reports broken.

-- CORRECT:
ALTER TABLE events ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
-- Each new row: gets the current time at insert. Correct.

-- Adding NOT NULL with DEFAULT to a large existing table (Postgres 11+):
-- No table rewrite needed. Postgres stores the default in catalog metadata.
-- Old rows: return the default value at query time (no physical rewrite).
-- O(1) ALTER TABLE ADD COLUMN ... NOT NULL DEFAULT ... in Postgres 11+.
-- Pre-Postgres 11: would rewrite entire table (hours). Postgres 11+: instant.
```

---

## SECTION 6 — Performance Impact

### Constraint Overhead: What It Actually Costs

```
NOT NULL CHECK:
  Cost per INSERT/UPDATE: essentially zero. A flag lookup in column metadata.
  No I/O. No index lookup. No locks beyond the normal row write.

  Do not hesitate to add NOT NULL. There is no measurable performance tradeoff.

UNIQUE CONSTRAINT (unique index):
  Cost per INSERT: one B-tree index lookup + one index insert.
  For a BIGINT column: ~3-4 page reads (tree descent) + write to leaf page.
  Benchmark: UNIQUE on email (VARCHAR 40B avg) adds ~0.1ms per INSERT on an 8M row table.

  Scale effect: B-tree height grows at O(log N). From 1M to 1B rows:
    Height increases from 3 to 4. One extra page read per lookup. Tiny absolute cost.

  UNIQUE on write-heavy tables:
    1M inserts/second into a table with 10 UNIQUE columns: each insert = 10 × B-tree lookups.
    Each lookup: ~4 random I/Os. Total: 40 random I/Os per insert on the index side alone.
    This is where unique constraints can become a bottleneck. Measure with realistic load.

  Mitigation: batch inserts (COPY), deferred unique checks (DEFERRABLE INITIALLY DEFERRED),
  reduced number of UNIQUE columns to those truly required by business rules.

DEFAULT:
  Cost: zero at SELECT time (no computation). Virtually zero at INSERT time (catalog lookup).
  Expression defaults (e.g., DEFAULT uuid_generate_v4()):
    Evaluates the function for each INSERT. Function cost matters.
    NOW(): trivial. uuid_generate_v4(): generates a UUID, minimal cost.
    Complex user-defined functions: avoid. Computed defaults: prefer UUIDs and timestamps.

CONSTRAINT OVERHEAD BENCHMARK:
  INSERT 1M rows into a table with various constraint combinations.
  PostgreSQL 15, r6g.2xlarge, NVMe SSD.

  Configuration                     | Time     | Rate       | Notes
  ----------------------------------|----------|------------|--------------------------------
  No constraints                    | 1.8s     | 556K/s     | Baseline
  + NOT NULL (4 columns)            | 1.8s     | 556K/s     | No measurable difference
  + DEFAULT (2 columns, NOW())      | 1.9s     | 526K/s     | +1% for function evaluation
  + UNIQUE (1 column, email)        | 3.2s     | 313K/s     | +78% from unique index maintenance
  + UNIQUE (3 columns)              | 5.8s     | 172K/s     | +3 unique indexes = 3x overhead
  + CHECK (3 constraints)           | 2.1s     | 476K/s     | Minimal overhead for simple checks
  + FK (2 FK columns, indexed)      | 4.4s     | 227K/s     | FK index lookups on each insert

  TAKEAWAY: NOT NULL and CHECK are essentially free. UNIQUE and FK add measurable overhead.
  Prioritize: add these to columns where correctness requires them. Don't add "just in case."
```

---

## SECTION 7 — Concurrency & Data Integrity

### How Constraints Behave Under Concurrent Writes

```
UNIQUE CONSTRAINT UNDER CONCURRENT INSERTs:

  Two concurrent transactions, T1 and T2, both try to INSERT the same email.

  T1: INSERT INTO users (email) VALUES ('alice@corp.com')
  T2: INSERT INTO users (email) VALUES ('alice@corp.com')

  Database-level execution:
    T1: B-tree lookup on users_email_key. Key not found (T2 hasn't committed yet, T1 hasn't either).
    T1: Writes a "pending" placeholder entry in the unique index (not yet committed).
    T2: B-tree lookup. Finds T1's pending entry. BLOCKS. Waits for T1 to commit or rollback.
    T1: COMMITS. unique index entry becomes permanent.
    T2: Unblocks. B-tree lookup. Finds committed entry. ERROR duplicate key. T2 rolls back.

    Result: exactly ONE of the two concurrent inserts succeeds. No duplicate. No race window.

  This is why UNIQUE constraint at DB level is essential — application-level checks cannot
  provide this guarantee because the race window exists between SELECT and INSERT.

INSERT ON CONFLICT (UPSERT) PATTERN:

  -- Email-based upsert (update if exists, insert if new):
  INSERT INTO users (email, name, last_login)
  VALUES ('alice@corp.com', 'Alice', NOW())
  ON CONFLICT (email) DO UPDATE
  SET last_login = EXCLUDED.last_login,
      name       = EXCLUDED.name;

  -- EXCLUDED: refers to the row that was proposed for insertion.
  -- Atomic: no separate SELECT + conditionally INSERT/UPDATE.
  -- Concurrent-safe: ON CONFLICT handled by the unique index mechanism.

  -- Insert-only if not exists (idempotent insert):
  INSERT INTO user_roles (user_id, role_id)
  VALUES ($1, $2)
  ON CONFLICT (user_id, role_id) DO NOTHING;

DEFERRED UNIQUE CONSTRAINTS:

  Use case: bulk load where rows reference each other (circular or batch dependency).

  CREATE UNIQUE INDEX CONCURRENTLY users_email_key_deferred
  ON users(email)
  DEFERRABLE INITIALLY DEFERRED;

  In a single transaction:
  BEGIN;
  SET CONSTRAINTS users_email_key_deferred DEFERRED;
  INSERT INTO users (email, name) VALUES ('alice@corp.com', 'Alice OLD');
  UPDATE users SET email = 'archive@old.com' WHERE email = 'alice@corp.com';
  INSERT INTO users (email, name) VALUES ('alice@corp.com', 'Alice NEW');
  COMMIT;
  -- At COMMIT time: only one 'alice@corp.com' exists. Constraint check passes.
  -- Without DEFERRED: second INSERT would fail because first hasn't been deleted yet.

NOT NULL AND NULL-SAFE COMPARISONS:

  Common bug: applying = to a nullable column where NULL is expected.

  WHERE column = NULL       -- WRONG: NULL = NULL is not TRUE. Returns nothing.
  WHERE column IS NULL      -- CORRECT: dedicated IS NULL / IS NOT NULL syntax.
  WHERE column IS NOT NULL  -- CORRECT.

  In a NOT NULL column: IS NULL always returns FALSE. Planner may optimize this away.
  Composite index with nullable column: NULL values ARE indexed (Postgres). They participate
  in range scans. WHERE col IS NULL: can use a B-tree index.

  COUNT(*) vs COUNT(col):
  COUNT(*): counts all rows including those with NULL in any column. For NOT NULL columns: same as COUNT(*).
  COUNT(col): counts only rows where col IS NOT NULL. On a NOT NULL column: always equal to COUNT(*).
  Pattern: COUNT(nullable_col) to count rows with a value. COUNT(*) to count all rows.
```

---

## SECTION 8 — Optimization & Indexing

### Constraint-Driven Index Strategy

```
UNIQUE CONSTRAINT = UNIQUE INDEX (Automatic):

  CREATE TABLE users (email VARCHAR(255) NOT NULL UNIQUE);
  -- Automatically creates: CREATE UNIQUE INDEX users_email_key ON users(email);
  -- This index is used for:
  --   1. Enforcing uniqueness on INSERT/UPDATE.
  --   2. Lookups: WHERE email = $1 → uses this index. O(log N).
  --   3. JOIN: ... ON users.email = other.email → planner may use this index.
  -- Free dual purpose: constraint enforcement + query acceleration.

PARTIAL UNIQUE INDEX (Unique Among Active Rows Only):

  Common use case: soft-deleted rows should not participate in uniqueness.

  CREATE TABLE products (
      id         BIGSERIAL PRIMARY KEY,
      sku        VARCHAR(100) NOT NULL,
      deleted_at TIMESTAMPTZ
  );

  -- Regular UNIQUE would prevent creating a new SKU after soft-deleting the old one:
  -- DELETE (soft): set deleted_at = NOW(). Old row still has its SKU in a UNIQUE index → blocks.

  CREATE UNIQUE INDEX idx_products_sku_active
  ON products(sku)
  WHERE deleted_at IS NULL;
  -- Unique constraint: applies only to active rows (deleted_at IS NULL).
  -- Archived rows: can share a SKU with a new active row. Allowed.

  Application query must include WHERE deleted_at IS NULL for the planner to use this index.

CONSTRAINT VALIDATION PERFORMANCE (Adding to Existing Large Table):

  Scenario: add NOT NULL to a column with existing data on a 500M-row table.

  -- OLD WAY (pre-Postgres 11): table rewrite. Hours. Table locked.
  ALTER TABLE events ALTER COLUMN user_id SET NOT NULL;  -- rewrites entire table on old PG

  -- NEW WAY (Postgres 11+, for columns with no pre-existing NULLs):
  -- Postgres 11+ uses a constraint check without table rewrite if data is already valid.
  -- First: add NOT NULL as NOT VALID (no scan, no lock):
  ALTER TABLE events ADD CONSTRAINT events_user_id_notnull CHECK (user_id IS NOT NULL) NOT VALID;
  -- Then: validate in background (shares AccessShareLock — concurrent reads/writes allowed):
  ALTER TABLE events VALIDATE CONSTRAINT events_user_id_notnull;
  -- After validation: convert to column NOT NULL (fast, catalog-only change):
  ALTER TABLE events ALTER COLUMN user_id SET NOT NULL;
  ALTER TABLE events DROP CONSTRAINT events_user_id_notnull;

  -- Total time: VALIDATE takes minutes (sequential scan), but doesn't block writes.
  -- Table accessible throughout. Zero-downtime constraint addition.

  -- Same pattern for CHECK constraints on large tables.

FUNCTIONAL INDEXES ON CONSTRAINED EXPRESSIONS:

  Scenario: users must have unique LOWERCASE emails (case-insensitive uniqueness).

  CREATE UNIQUE INDEX idx_users_email_lower ON users(LOWER(email));
  -- Stores: LOWER(email) in the index. Unique by lowercased value.

  -- Application query:
  INSERT INTO users (email) VALUES ('Alice@Corp.COM')
  ON CONFLICT (LOWER(email)) DO NOTHING;
  -- Index expression: LOWER('Alice@Corp.COM') = 'alice@corp.com'. Checked for uniqueness.

  -- Lookup:
  SELECT * FROM users WHERE LOWER(email) = LOWER($1);
  -- Matches the functional index. O(log N) lookup.

  Note: ON CONFLICT must specify the expression, not just the column.
  ON CONFLICT (LOWER(email)) → correct for functional unique index.
  ON CONFLICT (email)         → wrong — no index on plain email in this schema.
```
