# Audit Columns — Part 2 of 3

### Sections: 5 (Bad vs Correct Usage), 6 (Performance Impact), 7 (Concurrency & Data Integrity), 8 (Optimization & Indexing)

**Series:** Databases & Data Modeling → Topic 22

---

## SECTION 5 — Bad Usage vs Correct Usage

### Common Audit Column Anti-Patterns

**Anti-Pattern 1: Application-layer `updated_at` — missed on direct DB writes**

```sql
-- BAD: application sets updated_at manually
-- Application ORM (Python SQLAlchemy example):
user.name = "New Name"
user.updated_at = datetime.utcnow()   # ← developer must remember to set this
db.session.commit()

-- Problems:
-- 1. Direct DB fix: UPDATE users SET name = 'Fixed Name' WHERE id = 42;
--    → updated_at NOT updated. No trace of the manual change. Audit gap.
-- 2. Bulk update: UPDATE users SET plan = 'legacy' WHERE plan = 'old_name';
--    → updated_at NOT set unless developer explicitly includes it. Common omission.
-- 3. Another service/microservice writes to same table: may not set updated_at.

-- CORRECT: database trigger. Cannot be bypassed by any writer:
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated_at
BEFORE UPDATE ON users
FOR EACH ROW
WHEN (OLD.* IS DISTINCT FROM NEW.*)  -- only if something actually changed
EXECUTE FUNCTION set_updated_at();
-- Now: every UPDATE from any client, tool, or script sets updated_at correctly.
```

---

**Anti-Pattern 2: Trigger fires on no-op UPDATE (phantom updated_at changes)**

```sql
-- BAD: trigger without WHEN guard
CREATE TRIGGER trg_users_updated_at
BEFORE UPDATE ON users
FOR EACH ROW  -- NO WHEN clause
EXECUTE FUNCTION set_updated_at();

-- Problem: issuing UPDATE users SET name = name WHERE id = 42 (no-op update):
-- Trigger STILL fires! updated_at changes.
-- Or: ORM saves unchanged entity → spurious updated_at change.
-- Audit log entry: "Alice updated at 14:32:00" when NOTHING actually changed.
-- Debugging production: misleading "Recent activity" feed for no change operations.

-- CORRECT: WHEN guard prevents no-op trigger fires:
CREATE TRIGGER trg_users_updated_at
BEFORE UPDATE ON users
FOR EACH ROW
WHEN (OLD.* IS DISTINCT FROM NEW.*)  -- only row-level actual change triggers this
EXECUTE FUNCTION set_updated_at();
-- No-op UPDATEs: OLD.* = NEW.* → WHEN false → trigger skipped → updated_at unchanged. Correct.
```

---

**Anti-Pattern 3: audit_log written in separate transaction from the data change**

```sql
-- BAD: two-phase audit write (data change + separate audit write):
-- Application code (buggy pattern):
BEGIN;
UPDATE medications SET dose = '10mg' WHERE patient_id = 42 AND medication = 'atenolol';
COMMIT;
-- ↑ data committed

-- NOW write audit log separately:
BEGIN;
INSERT INTO audit_log (table_name, record_id, old_values, new_values, changed_at)
VALUES ('medications', 42, '{"dose":"5mg"}', '{"dose":"10mg"}', NOW());
COMMIT;
-- ↑ audit written separately

-- Problem: if server crashes between the two COMMITs:
-- Data change: committed.
-- Audit log: not written.
-- Result: data changed with NO audit trail. Patient dose increased → no record. Malpractice risk.

-- CORRECT: audit log in SAME transaction as data change (or via trigger):
BEGIN;
UPDATE medications SET dose = '10mg' WHERE patient_id = 42 AND medication = 'atenolol';
-- Trigger fires within same transaction: audit_log INSERT happens here.
COMMIT;
-- Both committed atomically. If crash: both rolled back together. No audit gap. Ever.
```

---

**Anti-Pattern 4: Not masking PII in old_values/new_values JSONB**

```sql
-- BAD: storing raw PII in audit log
INSERT INTO audit_log VALUES (
    'users', 42,
    '{"ssn":"123-45-6789","email":"alice@corp.com","password_hash":"$2a$12..."}',
    '{"ssn":"987-65-4321","email":"newalice@corp.com","password_hash":"$2a$12..."}'
);
-- audit_log table: often has broader read access (security team, compliance).
-- SSN in plaintext in audit log: HIPAA violation. Audit log = data breach vector.

-- CORRECT: exclude or mask sensitive fields in audit trigger:
CREATE OR REPLACE FUNCTION audit_changes()
RETURNS TRIGGER AS $$
DECLARE
    old_sanitized JSONB;
    new_sanitized JSONB;
    excluded_fields TEXT[] := ARRAY['password_hash', 'ssn', 'credit_card_last4'];
BEGIN
    old_sanitized = to_jsonb(OLD);
    new_sanitized = to_jsonb(NEW);
    -- Remove sensitive fields from audit record:
    FOREACH f IN ARRAY excluded_fields LOOP
        old_sanitized = old_sanitized - f;
        new_sanitized = new_sanitized - f;
    END LOOP;
    INSERT INTO audit_log (table_name, record_id, old_values, new_values)
    VALUES (TG_TABLE_NAME, NEW.id, old_sanitized, new_sanitized);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

---

## SECTION 6 — Performance Impact

### Measuring Audit Column Overhead

```
Test: users table (5M rows), 10K UPDATE/second workload.
Trigger: set_updated_at() with WHEN guard.

Scenario 1: No trigger
  UPDATE throughput: 28,400 rows/sec
  p99 latency: 0.8ms per UPDATE

Scenario 2: Trigger with WHEN guard (real change only)
  UPDATE throughput: 27,600 rows/sec (3% reduction)
  p99 latency: 0.84ms per UPDATE
  Overhead: ~3% on typical OLTP UPDATE load.

Scenario 3: Trigger WITH full audit_log INSERT (JSONB old+new)
  UPDATE throughput: 21,200 rows/sec (25% reduction)
  p99 latency: 1.1ms per UPDATE
  Overhead: ~25% due to audit_log INSERT per change.
  Extra I/O: additional WAL write for audit_log row.

Scenario 4: Selective audit (only 3 sensitive columns trigger audit):
  UPDATE throughput: 26,800 rows/sec (5-6% reduction on sensitive-column writes)
  For non-sensitive column UPDATEs: 0% overhead (WHEN guard excludes them)

Decision rule:
  - created_at / updated_at only: ~3% overhead. Always worth it.
  - Full audit_log on all updates: ~25% overhead. Only for compliance-required tables.
  - Full audit_log on sensitive fields only (WHEN OLD.ssn IS DISTINCT FROM NEW.ssn):
    5-6% overhead. Best balance.
```

---

**audit_log table storage growth:**

```
High-write table example: order_updates (50K updates/day)
Average audit row (JSONB old+new): ~800 bytes
Daily audit storage: 50K × 800 bytes = 40MB / day
Monthly: 1.2GB / month
Yearly: 14.4GB / year (before indexes)

Index on (table_name, record_id, changed_at): +50% → 21.6GB / year

Mitigation options:
  1. Partition audit_log by month → DROP old partitions after legal retention period.
  2. pg_compress JSONB values for very old partitions.
  3. Move audit_log to TimescaleDB / append-optimized store.
  4. Only log changed fields (not full old/new rows):
     changed_fields: ["email"] old_values: {"email":"a@b.com"} new_values: {"email":"c@d.com"}
     Reduces average row size by 60-70% vs logging full row.
```

---

## SECTION 7 — Concurrency & Data Integrity

### Audit Columns Under Concurrent Writes

**Transaction atomicity with triggger-based auditing:**

```sql
-- Key guarantee: trigger fires WITHIN the same transaction.
-- Scenario: two concurrent updates to same medications row:
--   Tx A: UPDATE medications SET dose='10mg' WHERE id=99; → triggers audit INSERT
--   Tx B: UPDATE medications SET dose='15mg' WHERE id=99; → also triggers audit INSERT

-- Both audit_log rows written:
-- Row 1: changed_at=14:32:01.123 old: {"dose":"5mg"} new: {"dose":"10mg"} user: 'nurse_a'
-- Row 2: changed_at=14:32:01.890 old: {"dose":"10mg"} new: {"dose":"15mg"} user: 'dr_jones'
-- Result: complete history of both changes. Who changed what and when. Full lineage.

-- If Tx A rolls back: its audit_log INSERT also rolls back. No phantom audit entry. Correct.
```

---

**`current_setting` cross-tenant safety:**

```sql
-- Pattern: SET app.current_user_id at connection start.
-- Risk: connection pooling reuses connections. If pool doesn't reset session vars between requests:
--   Request A sets: SET LOCAL app.current_user_id = '42';
--   Connection returned to pool.
--   Request B reuses connection: current_user_id is STILL '42' unless explicitly reset.
--   Audit log: B's changes attributed to user 42. Wrong.

-- CORRECT: use SET LOCAL (resets at transaction end):
BEGIN;
SET LOCAL app.current_user_id = '42';
UPDATE patients SET ... ;
COMMIT;
-- After COMMIT: app.current_user_id resets to session default (empty or prior value).

-- Even better: use a database function that reads from the connection context:
current_setting('app.current_user_id', TRUE)  -- TRUE = return NULL if not set (won't error)

-- PgBouncer: always use transaction-mode pooling with SET LOCAL. Never session-mode when
-- using current_setting for security-critical data like audit user IDs.
```

---

## SECTION 8 — Optimization & Indexing

### Index Strategy for Audit Columns

```sql
-- The audit_log table grows indefinitely. Index strategy is critical.

-- Primary query patterns for audit_log:
-- 1. "Show all changes to user #42" → WHERE table_name = 'users' AND record_id = 42
-- 2. "Show all changes by Dr. Jones today" → WHERE changed_by = 'dr.jones' AND changed_at::date = today
-- 3. "Show all medication changes in last 7 days" → WHERE table_name = 'medications' AND changed_at > NOW()-7d
-- 4. "Which fields changed in this specific update?" → changed_fields @> '["email"]' (GIN)

CREATE TABLE audit_log (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    table_name    TEXT NOT NULL,
    record_id     BIGINT NOT NULL,
    changed_by    TEXT,     -- app.current_user_id at time of change
    changed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    operation     TEXT NOT NULL CHECK (operation IN ('INSERT','UPDATE','DELETE')),
    old_values    JSONB,
    new_values    JSONB,
    changed_fields TEXT[]   -- array of column names that changed
);

-- Index 1: lookup by record (most common: "show history of entity X"):
CREATE INDEX idx_audit_record ON audit_log(table_name, record_id, changed_at DESC);

-- Index 2: lookup by user (compliance: "what did admin Bob do?"):
CREATE INDEX idx_audit_user ON audit_log(changed_by, changed_at DESC)
    WHERE changed_by IS NOT NULL;

-- Index 3: time range scans (monitoring: "recent changes in last hour"):
CREATE INDEX idx_audit_time ON audit_log(changed_at DESC);

-- Index 4: changed field queries (HIPAA: "who changed SSN field?"):
CREATE INDEX idx_audit_fields ON audit_log USING GIN(changed_fields);
-- Query: WHERE changed_fields @> ARRAY['ssn']

-- Partitioning (required for long-lived audit logs):
CREATE TABLE audit_log (... ) PARTITION BY RANGE (changed_at);

CREATE TABLE audit_log_2024_01 PARTITION OF audit_log
    FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');
CREATE TABLE audit_log_2024_02 PARTITION OF audit_log
    FOR VALUES FROM ('2024-02-01') TO ('2024-03-01');
-- Add partitions in advance (monthly rotation). Automate with pg_partman.
-- Retention: DROP TABLE audit_log_2020_01 (instant vs deleting 10M rows: hours).

-- Verify audit coverage: check all critical tables have the audit trigger:
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_type = 'BASE TABLE'
  AND table_name NOT IN (
      SELECT event_object_table
      FROM information_schema.triggers
      WHERE trigger_name LIKE 'trg_%_audit'
  );
-- Returns: tables WITHOUT an audit trigger. Review and add if missing.
```
