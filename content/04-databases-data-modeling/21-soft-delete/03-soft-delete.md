# Soft Delete — Part 3 of 3

### Sections: 9 (AWS Mapping), 10 (Interview Q&A), 11 (Debugging Exercise), 12 (Architect's Mental Model)

**Series:** Databases & Data Modeling → Topic 21

---

## SECTION 9 — AWS Service Mapping

### How AWS Services Relate to Soft Delete

| Layer           | AWS Service                    | Soft Delete Relevance                                                                                                                                                                                  |
| --------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Relational DB   | Amazon RDS / Aurora PostgreSQL | Soft delete via `deleted_at` column + partial index: full support. RLS policies for hiding soft-deleted rows: available.                                                                               |
| Audit/Retention | Amazon S3 + Lifecycle Policies | Hard-deleted S3 objects with versioning: S3 creates a delete marker (conceptually a soft delete). Lifecycle policy can permanently delete after retention period.                                      |
| DynamoDB        | Amazon DynamoDB                | No built-in soft delete. Convention: `deleted_at` TTL attribute. DynamoDB TTL: automatically hard-deletes items after `deleted_at` timestamp (eventual, within 48 hours).                              |
| Compliance      | AWS S3 Object Lock             | WORM (Write Once Read Many) for regulatory compliance. Objects cannot be deleted or overwritten for a specified retention period. Legal compliance equivalent of "force soft delete" at storage layer. |
| Audit Trail     | AWS CloudTrail                 | Logs every API deletion call. Provides external audit layer — even if DB row is hard deleted, CloudTrail shows who called delete and when.                                                             |
| CDN             | Amazon CloudFront              | Cache invalidation for soft-deleted content. After soft delete: invalidate CDN cache so deleted content stops being served.                                                                            |
| Archival        | Amazon S3 Glacier              | Long-term archival for soft-deleted database records. Nightly job: move rows with `deleted_at < NOW()-90days` to S3 Glacier for 7-year retention.                                                      |

---

**DynamoDB soft delete with TTL:**

```python
import boto3
from datetime import datetime, timedelta

dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table('users')

def soft_delete_user(user_id):
    # DynamoDB TTL: set deleted_at to 90 days from now.
    # DynamoDB will hard-delete between 0-48 hours after TTL expires.
    # Until TTL fires: item still exists but marked deleted.
    retention_days = 90
    deleted_timestamp = int((datetime.utcnow() + timedelta(days=retention_days)).timestamp())

    table.update_item(
        Key={'id': user_id},
        UpdateExpression='SET deleted_at = :da, #s = :s',
        ExpressionAttributeNames={'#s': 'status'},
        ExpressionAttributeValues={
            ':da': deleted_timestamp,  # epoch seconds: DynamoDB TTL attribute
            ':s': 'deleted'
        }
    )
    # Application: filter WHERE status != 'deleted' in all read queries.
    # DynamoDB TTL: automatically removes item after retention_days. GDPR compliant.
```

---

## SECTION 10 — Interview Q&A

### Beginner Questions

**Q1: What is soft delete and why use it instead of hard delete?**

Soft delete marks a record as deleted (typically via a `deleted_at` timestamp) without physically removing the row from the database. The reason to prefer it over hard delete: (1) Data recovery — accidental deletions can be undone by clearing `deleted_at`. (2) Audit and compliance — regulations like GDPR, HIPAA, and AML may require retaining records for 5-7 years; hard delete destroys this. (3) Referential integrity — hard deleting a user while their orders exist creates orphaned records or requires cascading deletes that may destroy historical data. (4) Debugging — "who deleted this record and when?" is answerable with soft delete, not with hard delete.

---

**Q2: What is the biggest trap when adding a UNIQUE constraint to a soft-delete table?**

A full-table UNIQUE constraint includes soft-deleted rows. If user Alice is soft-deleted and tries to re-register with the same email, the UNIQUE constraint rejects the new row because Alice's deleted email still occupies the unique index. The fix is a **partial UNIQUE index** that excludes deleted rows: `CREATE UNIQUE INDEX ON users(email) WHERE deleted_at IS NULL`. Now only active users participate in the uniqueness check. Soft-deleted emails are free to be re-used by new registrations.

---

**Q3: Why is it important to add a partial index on `deleted_at IS NULL`?**

Without a partial index, every query that filters `WHERE deleted_at IS NULL` on a large table performs a full sequential scan — reading all rows including deleted ones, then filtering. On a 20M row table with 3M deleted rows, this is wasteful. A partial index `CREATE INDEX ON users(created_at) WHERE deleted_at IS NULL` is built only on the 17M active rows: smaller, faster, fits better in cache. All queries that include `WHERE deleted_at IS NULL` can use this index, reducing query time from seconds to milliseconds.

---

### Intermediate Questions

**Q4: How do you implement cascade soft delete for related records?**

Via a database trigger on the parent table. When a user is soft-deleted (UPDATE sets `deleted_at`), the trigger automatically fires and updates all child records — posts, comments, API keys — setting their `deleted_at` to the same timestamp within the same transaction. Using a trigger rather than application code ensures: (1) The cascade cannot be forgotten by a developer; (2) It applies even to direct database changes; (3) It's atomic with the parent soft delete. The trigger uses `WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)` to fire only on actual deletion (not on undelete or other updates).

---

**Q5: What is the archival strategy for managing table bloat from soft-deleted rows?**

Three-phase lifecycle: (1) **Active phase** (0-90 days after deletion): soft-deleted rows stay in the main table. Recovery is instant. (2) **Archival phase** (90 days - 7 years): rows moved from main table to a separate `users_archived` table or S3 Glacier. Main table stays lean. Recovery requires a restore procedure. (3) **Purge phase** (after legal retention period): rows permanently deleted from archive. A weekly maintenance job executes: `DELETE FROM users WHERE deleted_at IS NOT NULL AND deleted_at < NOW()-'90 days'::interval RETURNING *` and INSERTs the returned rows into the archive table. Main table never accumulates years of soft-deleted rows.

---

### Advanced Questions

**Q6: GDPR's "right to be forgotten" requires truly deleting user data. How do you reconcile this with soft delete's retention goals?**

These requirements conflict and must be separated by data category: (1) **PII** (name, email, address): hard deleted on GDPR request — overwrite or delete these columns even in soft-deleted rows: `UPDATE users SET email = 'redacted', name = 'redacted', ... WHERE id = $x`. The row's structural integrity (foreign keys, audit references) is preserved, but the personal data is gone. (2) **Business records** (orders, transactions, audit logs): retained for legal/tax purposes. Personal identifiers in these records are pseudonymized or removed. (3) **Soft delete row**: kept for referential integrity but all PII columns are nulled/redacted. GDPR "erasure" = remove PII, not necessarily remove the row skeleton.

---

**Q7: How would you design a multi-table soft delete that must be consistent under concurrent failures?**

Use a distributed saga with per-table soft-delete entries tracked in a `deletion_jobs` table. The job records which tables need to be soft-deleted for a given entity deletion. Each step (soft delete users, cascade to posts, cascade to comments) is idempotent: `UPDATE table SET deleted_at = $ts WHERE id = $x AND deleted_at IS NULL`. A background worker reads `deletion_jobs` with `FOR UPDATE SKIP LOCKED` and processes pending steps. If the server crashes mid-saga: the incomplete job remains in `deletion_jobs` with `status='processing'`. On restart the worker picks it up and retries (idempotency ensures no double-deletion effect). The saga completes even across crashes.

---

## SECTION 11 — Debugging Exercise

### Production Incident: Users Seeing Other Users' Deleted Orders

**Scenario:**
Customer support reports: 47 users called saying they can see orders on their account that they never placed. Investigation reveals these are orders belonging to previously soft-deleted user accounts that were somehow re-associated with new accounts sharing the same email.

**Investigation:**

```sql
-- Find orders associated with multiple user accounts sharing the same email:
SELECT o.id AS order_id, o.user_id, u.email, u.deleted_at
FROM orders o
JOIN users u ON u.id = o.user_id
WHERE u.email IN (
    SELECT email FROM users GROUP BY email HAVING COUNT(*) > 1
)
ORDER BY u.email, u.deleted_at;
-- Result: for email 'alice@example.com':
--   order 1001, user_id=100, deleted_at='2024-01-15' (old account)
--   order 1002, user_id=847, deleted_at=NULL (new account)
-- New user (id=847) is seeing order 1001 which belongs to id=100.
```

**Finding the bug:**

```sql
-- App code that shows user's orders:
SELECT * FROM orders WHERE user_id IN (
    SELECT id FROM users WHERE email = $current_user_email  -- ← matches ALL users with this email!
);
-- Includes soft-deleted user with same email.
-- New user sees old user's orders.

-- The query should be:
SELECT * FROM orders WHERE user_id = $current_user_id;  -- ← use the authenticated user ID
-- Or if email lookup is required:
SELECT * FROM orders o
JOIN users u ON u.id = o.user_id
WHERE u.email = $email AND u.deleted_at IS NULL AND u.id = $current_user_id;
```

**The deeper issue:**
The application was looking up the user by email without filtering `deleted_at IS NULL`. When a new user registered with a previously-used email, the query matched BOTH the old deleted account and the new active account — returning orders belonging to the old account.

**Prevention:**

```sql
-- All user lookups by email MUST filter on deleted_at IS NULL:
SELECT id FROM users WHERE email = $email AND deleted_at IS NULL;
-- Returns: only the active user. Never the old deleted one.

-- Add RLS to enforce automatically:
CREATE POLICY no_soft_deleted ON users USING (deleted_at IS NULL);
-- Now any query on users: automatically filtered to active users only.
-- The bug becomes impossible: the deleted user is invisible to queries.
```

---

## SECTION 12 — Architect's Mental Model

### 5 Decision Rules

1. **Partial UNIQUE index, always.** Any table with a soft-delete column and a business uniqueness requirement (email, slug, username): `CREATE UNIQUE INDEX ON table(column) WHERE deleted_at IS NULL`. Never a full-table UNIQUE constraint on a soft-delete table.

2. **Cascade soft delete via trigger, never application code.** Application code is optional (can be skipped). Database triggers cannot be bypassed. For correctness guarantees: put cascade logic in the trigger.

3. **Filter by `deleted_at IS NULL` in every single query — or use RLS.** One query missing the filter = data leak or data confusion. RLS is the architectural enforcement: the filter is automatic, impossible to forget.

4. **Archive soft-deleted rows after retention window.** Every table with soft delete: a weekly archival job. Rows older than (retention_period - buffer): moved to archive table or cold storage. Main table stays lean; partial indexes stay small.

5. **GDPR/CCPA deletion request = PII erasure, not row deletion.** `UPDATE users SET email=NULL, name=NULL, phone=NULL WHERE id=$x`. The row stays for FK integrity and audit. The personal data is gone. Satisfy the regulation without breaking referential integrity.

---

### 3 Common Mistakes

**Mistake 1: Adding soft delete to a table mid-production without immediately adding the partial UNIQUE index.** The moment you add `deleted_at`, old UNIQUE constraints now include deleted rows. Any user who was deleted and tries to re-register gets blocked. Always: add partial UNIQUE index in the same migration that adds `deleted_at`.

**Mistake 2: Relying on application-layer filtering without RLS.** One microservice, one script, one ORM method that omits `WHERE deleted_at IS NULL` leaks deleted records to users. RLS makes the filter part of the database contract.

**Mistake 3: Using soft delete for high-velocity event/log tables.** Append-only tables with millions of rows per day: soft delete adds a `deleted_at` column that's NULL for essentially every row. Bloat, index size, and autovacuum overhead are high. For event/log tables: use hard delete or partition-swap instead.

---

### 30-Second Interview Answer

> "Soft delete marks rows as deleted via `deleted_at TIMESTAMPTZ` instead of removing them — enabling recovery, audit trails, and compliance with data retention regulations. The two things I always get right: a partial UNIQUE index `WHERE deleted_at IS NULL` so deleted users can re-register with their email, and a cascade trigger so child records are automatically soft-deleted when the parent is. For visibility enforcement at scale, I use RLS with `USING (deleted_at IS NULL)` so no developer can accidentally query deleted rows. For GDPR 'right to erasure': null out the PII columns on the row rather than deleting it — preserving FK integrity while satisfying the regulation."

---

_→ Next: [03-Audit Columns.md](../22 - Audit Columns/03-Audit Columns.md)_
