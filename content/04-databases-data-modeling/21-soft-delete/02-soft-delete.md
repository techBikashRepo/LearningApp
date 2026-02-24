# Soft Delete — Part 2 of 3

### Sections: 5 (Bad vs Correct Usage), 6 (Performance Impact), 7 (Concurrency & Data Integrity), 8 (Optimization & Indexing)

**Series:** Databases & Data Modeling → Topic 21

---

## SECTION 5 — Bad Usage vs Correct Usage

### Common Soft Delete Anti-Patterns

**Anti-Pattern 1: Forgetting to filter deleted rows (data leakage)**

```sql
-- BAD: query without soft delete filter
SELECT * FROM users WHERE email = 'alice@corp.com';
-- Returns: Alice's active account AND her soft-deleted previous account.
-- Application sees 2 rows for one email. "Duplicate user" error. Or worse:
-- logs Alice into her old deleted account.

-- BAD: API endpoint that returns all records without filtering:
GET /api/admin/users → SELECT * FROM users → returns deleted users in the list.
-- Admin sees ghost users. Support team confused by "deleted" users still appearing.

-- CORRECT: always filter in every query:
SELECT * FROM users WHERE email = 'alice@corp.com' AND deleted_at IS NULL;

-- BETTER: RLS policy so the filter is automatic:
CREATE POLICY no_deleted ON users USING (deleted_at IS NULL);
-- Now: SELECT * FROM users WHERE email = '...' → automatically filters deleted rows.
-- No developer can forget to add the filter.
```

---

**Anti-Pattern 2: UNIQUE constraint on a column without partial index**

```sql
-- BAD: full table UNIQUE constraint
ALTER TABLE users ADD CONSTRAINT uq_email UNIQUE (email);

-- Scenario: Alice creates account → gets deleted (deleted_at = '2024-03-01').
-- Alice tries to re-register with same email:
INSERT INTO users (email, ...) VALUES ('alice@corp.com', ...);
-- ERROR: duplicate key value violates unique constraint "uq_email"
-- The deleted row still participates in the UNIQUE constraint!
-- Alice cannot re-register with her own email. Support ticket. User lost.

-- CORRECT: partial UNIQUE index, only for active rows:
DROP CONSTRAINT uq_email;
CREATE UNIQUE INDEX uq_users_email_active ON users(email) WHERE deleted_at IS NULL;
-- Alice can re-register: deleted row doesn't participate in uniqueness check.
-- Two active users cannot share an email.

-- Additional uniqueness scenarios requiring partial indexes:
-- Slugs, usernames, API keys — any naturally unique identifier:
CREATE UNIQUE INDEX uq_projects_slug_active ON projects(team_id, slug) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_api_keys_active ON api_keys(key_hash) WHERE deleted_at IS NULL;
```

---

**Anti-Pattern 3: No cascade logic — orphaned active children of deleted parents**

```sql
-- BAD: parent soft-deleted but children remain "active"
-- User soft-deleted: users.deleted_at = NOW()
-- Their posts: still have deleted_at IS NULL in posts table.
-- Application: "show active posts" → shows posts from a deleted user.
-- Public blog: ghost author posts still publicly visible.

-- CORRECT: cascade soft delete to children:
-- Via trigger (automatic, cannot be forgotten by developers):
CREATE OR REPLACE FUNCTION cascade_soft_delete()
RETURNS TRIGGER AS $$
BEGIN
    -- Cascade to all child FK relationships:
    UPDATE posts    SET deleted_at = NEW.deleted_at WHERE user_id = NEW.id  AND deleted_at IS NULL;
    UPDATE comments SET deleted_at = NEW.deleted_at WHERE user_id = NEW.id  AND deleted_at IS NULL;
    UPDATE api_keys SET deleted_at = NEW.deleted_at WHERE user_id = NEW.id  AND deleted_at IS NULL;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_cascade_user_soft_delete
AFTER UPDATE OF deleted_at ON users
FOR EACH ROW
WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
EXECUTE FUNCTION cascade_soft_delete();
```

---

**Anti-Pattern 4: Soft delete on high-volume tables without partition strategy**

```sql
-- BAD: 500M row events table with soft_deleted column.
-- Most rows: never deleted. But:
-- 1. deleted_at column: 8 bytes × 500M rows = 4GB of NULL storage overhead.
-- 2. Every query: must filter deleted_at IS NULL (partial index needed on 499M rows).
-- 3. Bloat: autovacuum must process the 1M deleted rows mixed with 499M active rows.

-- BETTER: for truly append-only tables, don't use soft delete.
-- Use an "events_deleted" or "events_archive" table instead:
-- "delete" an event: move to events_deleted (INSERT + DELETE).
-- Active events table: only undeleted. No filter needed.

-- Or: partition by deleted_at status:
CREATE TABLE events (
    id          BIGINT,
    tenant_id   INTEGER,
    event_type  TEXT,
    deleted_at  TIMESTAMPTZ
) PARTITION BY LIST (CASE WHEN deleted_at IS NULL THEN 'active' ELSE 'deleted' END);

CREATE TABLE events_active  PARTITION OF events FOR VALUES IN ('active');
CREATE TABLE events_deleted PARTITION OF events FOR VALUES IN ('deleted');
-- "Active" partition: always the target of normal queries. No filter overhead.
-- "Deleted" partition: only for audit/recovery queries.
```

---

## SECTION 6 — Performance Impact

### Soft Delete Performance Benchmarks

```
Test table: users (20M rows, 3M soft-deleted = 15% deleted).
Indexes:
  - users_pkey (id)
  - idx_users_email (email) — BAD: full index including deleted rows

Scenario 1: Query without partial index
SELECT id, name FROM users WHERE deleted_at IS NULL AND created_at >= '2024-01-01';
  SeqScan: 20M rows scanned, 3M filtered as deleted.
  Execution: 4,200ms.
  Wasted scan effort: 15% of pages contain deleted-row data.

Scenario 2: Add partial index
CREATE INDEX idx_users_created_at_active ON users(created_at) WHERE deleted_at IS NULL;
  Index size: covers 17M rows (not 20M) → 15% smaller index.
  Same query: Index Scan on 17M active rows.
  Execution: 280ms (15x improvement).

Scenario 3: COUNT(*) for active users
WITHOUT partial index: SeqScan → 2,800ms.
WITH CREATE INDEX idx_users_active ON users(id) WHERE deleted_at IS NULL:
  Index Only Scan → 45ms (62x improvement).

Partial index benefits summary:
  Smaller index: 15-20% size reduction (excludes deleted rows).
  Faster scans: planner can eliminate deleted rows at index level (never touches heap for them).
  Fresher cache: smaller index fits in shared_buffers better.

Write overhead of soft delete vs hard delete:
  Hard DELETE: marks pages dead, VACUUM reclaims. Write: single page marking.
  Soft DELETE (UPDATE deleted_at = NOW()): writes new row version to heap page.
    Old version: marked dead (VACUUM needed). New version: written.
    Overhead vs hard delete: roughly equal per-row write cost.
    VACUUM: same work either way (dead tuple from DELETE vs old version from UPDATE).
  Conclusion: no meaningful performance difference between hard and soft delete per-operation.
```

---

## SECTION 7 — Concurrency & Data Integrity

### Soft Delete Under Concurrent Writes

**Race condition: concurrent soft delete and insert**

```sql
-- Problem: user soft-deletes their account at the same time as their API request creates a post.
-- Transaction A: UPDATE users SET deleted_at = NOW() WHERE id = 42;
-- Transaction B: INSERT INTO posts (user_id, content) VALUES (42, 'Hello!');

-- At READ COMMITTED: Tx B may not see Tx A's update if A hasn't committed yet.
-- Tx B succeeds: creates post for user_id=42 (soft-deleted user).
-- After both commit: posts table has a post for a deleted user.

-- Fix: application-layer: check user status at post creation time within same transaction.
-- Or: CHECK constraint/trigger that prevents inserts with a deleted parent:
CREATE OR REPLACE FUNCTION check_user_not_deleted()
RETURNS TRIGGER AS $$
BEGIN
    IF (SELECT deleted_at FROM users WHERE id = NEW.user_id) IS NOT NULL THEN
        RAISE EXCEPTION 'Cannot create post: user % is deleted', NEW.user_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_posts_user_active
BEFORE INSERT ON posts
FOR EACH ROW EXECUTE FUNCTION check_user_not_deleted();
-- Now: any attempt to insert a post for a soft-deleted user → exception.
-- Concurrent soft delete + post creation: one of them fails. Correct behavior.
```

---

**Partial UNIQUE index and concurrent re-registrations:**

```sql
-- Two concurrent re-registrations for same email (after one user soft-deleted):
-- Tx A: INSERT INTO users (email='alice@corp.com') WHERE not exists active user with this email
-- Tx B: INSERT INTO users (email='alice@corp.com') WHERE not exists active user with this email

-- Both check the partial UNIQUE index: no active user → both proceed.
-- PostgreSQL's UNIQUE index: speculative insert protocol.
-- One INSERT takes the speculative lock on 'alice@corp.com' in the partial index.
-- Second INSERT: detects conflict → UNIQUE violation → fails.
-- Result: only one new Alice account created. Correct.
-- The partial UNIQUE index enforces this atomically, same as a full UNIQUE would.
```

---

## SECTION 8 — Optimization & Indexing

### Complete Indexing Strategy for Soft Delete Tables

```sql
-- Standard soft-delete table: users
CREATE TABLE users (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email       TEXT NOT NULL,
    name        TEXT NOT NULL,
    tenant_id   INTEGER NOT NULL,
    role        TEXT NOT NULL DEFAULT 'user',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at  TIMESTAMPTZ
);

-- 1. Business key uniqueness (partial — active only):
CREATE UNIQUE INDEX uq_users_email_tenant_active
    ON users (tenant_id, email)
    WHERE deleted_at IS NULL;

-- 2. Soft delete filter + common sort (most frequent query pattern):
CREATE INDEX idx_users_tenant_created_active
    ON users (tenant_id, created_at DESC)
    WHERE deleted_at IS NULL;
-- Covers: SELECT * FROM users WHERE tenant_id = $x AND deleted_at IS NULL ORDER BY created_at DESC

-- 3. Admin queries on deleted users:
CREATE INDEX idx_users_deleted_at ON users(deleted_at)
    WHERE deleted_at IS NOT NULL;
-- Covers: SELECT ... FROM users WHERE deleted_at BETWEEN $start AND $end (audit queries)

-- 4. For recovery (looking up soft-deleted record by email to restore):
CREATE INDEX idx_users_email_deleted ON users(email, deleted_at)
    WHERE deleted_at IS NOT NULL;
-- Covers: SELECT id FROM users WHERE email = 'alice@corp.com' AND deleted_at IS NOT NULL

-- Monitoring soft delete ratio:
SELECT
    COUNT(*) AS total_rows,
    COUNT(*) FILTER (WHERE deleted_at IS NOT NULL) AS deleted_rows,
    ROUND(100.0 * COUNT(*) FILTER (WHERE deleted_at IS NOT NULL) / COUNT(*), 2) AS pct_deleted
FROM users;
-- If pct_deleted > 30%: consider archiving deleted rows to separate table.
-- High deleted ratio: wastes storage and dilutes index cache effectiveness.

-- Automated archival:
CREATE TABLE users_deleted_archive (LIKE users INCLUDING ALL);
-- Run weekly:
WITH moved AS (
    DELETE FROM users
    WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - INTERVAL '90 days'
    RETURNING *
)
INSERT INTO users_deleted_archive SELECT * FROM moved;
-- After 90 days: hard-deleted from main table (moved to archive).
-- Main table: only active + recently-deleted rows. Stays lean.
```
