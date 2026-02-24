# Audit Columns — Part 1 of 3

### Sections: 1 (Intuition & Analogy), 2 (Why This Exists), 3 (Internal Working), 4 (Query Execution Flow)

**Series:** Databases & Data Modeling → Topic 22

---

## SECTION 1 — Intuition & Analogy

### The Paper Trail

Every physical document that matters — a contract, a medical record, a legal filing — has a paper trail. Someone signed it. Someone dated it. Every modification is initialed and dated. If a dispute arises ("who changed my dosage?", "when was the contract modified?"), the paper trail provides an exact answer.

**Audit columns are the paper trail for database rows.** They answer four basic questions about every record:

```
  When was this row created?    → created_at  TIMESTAMPTZ
  When was it last modified?    → updated_at  TIMESTAMPTZ
  Who created it?               → created_by  INTEGER (user_id)
  Who last modified it?         → updated_by  INTEGER (user_id)
```

Extended audit patterns add:

```
  How many times was it modified?    → version      INTEGER
  What was the previous value?       → Full history in a separate audit_log table
  Why was it modified?               → change_reason TEXT
  What IP address made the change?   → created_from_ip INET
```

The core insight: **almost every production database will eventually need to answer "who changed this and when?" under pressure — audit, debugging, a security incident, a legal dispute. Adding `created_at` and `updated_at` costs 16 bytes per row and prevents future investigations from being unanswerable.**

```
Without audit columns:
  Support: "why does Alice's account show a $0 balance?"
  Engineer: looks at accounts table → balance = 0
  Engineer: no idea when this happened, who did it, or what it was before.
  Answer: "I don't know."

With audit columns:
  Engineer: looks at accounts table → balance = 0, updated_at = '2024-03-14 02:17:44', updated_by = 8832
  Check user 8832: internal admin tool API key.
  Check system logs at 2024-03-14 02:17: found an automated refund reconciliation job.
  Answer: specific, traceable, fixable.
```

---

## SECTION 2 — Why This Problem Exists (Production Failures)

### Real-World Incidents: When Audit Columns Are Missing

**Incident 1: Healthcare — Undetectable Record Modification**
Platform: hospital patient management system. Problem: a nurse noticed a patient's allergy record had changed. The allergy to penicillin was no longer listed. The patient received penicillin and had an anaphylactic reaction. Investigation: which version of the software? Which user session? When was it changed? Answer: unknown — the database had no `updated_at`, no `updated_by`, no version column. The row had been modified but no evidence of when or by whom. Malpractice investigation: unable to determine liability. Settlement: $1.8M.

Root cause: no audit columns, no audit log. The modification was invisible.

---

**Incident 2: Financial — Fraudulent Salary Modification Undetectable**
Platform: HR system, publicly traded company. A payroll administrator modified 3 employee salaries upward by $80K/year each — their own salary and two accomplices. The modified rows had no `updated_at`, no `updated_by`. SOX audit (Sarbanes-Oxley compliance): required a 12-month audit trail. The forensic accounting team could see the current values but couldn't prove when the changes were made or by whom from database records alone. 6-month investigation required for server access logs as a workaround. Total forensic cost: $240K.

---

**Incident 3: SaaS — Debug Nightmare Without Timestamps**
Platform: project management tool. Users complained that tasks were "randomly" losing their priority assignments. Engineering: looked at tasks table — no `updated_at`. Could not determine if tasks had been modified recently or long ago, whether the issue was a recent regression or a long-standing bug, or which code path was modifying the column. Spent 3 weeks adding comprehensive logging to every code path to reproduce. Total engineering cost: 180 hours.

Adding `updated_at` would have instantly localized the issue to a time window, enabling log correlation in under 1 hour.

---

## SECTION 3 — Internal Working

### Implementing Audit Columns in PostgreSQL

**Basic pattern — four standard columns:**

```sql
CREATE TABLE products (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        TEXT NOT NULL,
    price_cents INTEGER NOT NULL,
    -- Audit columns: apply to every table
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by  INTEGER REFERENCES users(id),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by  INTEGER REFERENCES users(id)
);
```

**Automatic `updated_at` maintenance via trigger:**

```sql
-- Reusable function — works for any table:
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply to each table:
CREATE TRIGGER trg_products_updated_at
BEFORE UPDATE ON products
FOR EACH ROW
WHEN (OLD.* IS DISTINCT FROM NEW.*)   -- only fire if something actually changed
EXECUTE FUNCTION set_updated_at();

-- The WHEN clause: prevents the trigger firing on no-op UPDATEs
-- (UPDATE products SET name = name WHERE id = 42 → no actual change → no updated_at bump)
```

---

**Full audit log table (complete change history):**

```sql
CREATE TABLE audit_log (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    table_name      TEXT NOT NULL,
    record_id       BIGINT NOT NULL,
    operation       TEXT NOT NULL CHECK (operation IN ('INSERT', 'UPDATE', 'DELETE')),
    changed_by      INTEGER REFERENCES users(id),
    changed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    old_values      JSONB,    -- row values BEFORE the change
    new_values      JSONB,    -- row values AFTER the change
    changed_fields  TEXT[],   -- array of column names that changed
    client_ip       INET,     -- from application context
    session_id      TEXT      -- application session identifier
);

CREATE INDEX idx_audit_log_record ON audit_log (table_name, record_id, changed_at);
CREATE INDEX idx_audit_log_user    ON audit_log (changed_by, changed_at);

-- Generic audit trigger function:
CREATE OR REPLACE FUNCTION log_audit_event()
RETURNS TRIGGER AS $$
DECLARE
    old_row JSONB := NULL;
    new_row JSONB := NULL;
    changed TEXT[] := ARRAY[]::TEXT[];
    key TEXT;
BEGIN
    IF TG_OP = 'INSERT' THEN
        new_row := to_jsonb(NEW);
    ELSIF TG_OP = 'DELETE' THEN
        old_row := to_jsonb(OLD);
    ELSIF TG_OP = 'UPDATE' THEN
        old_row := to_jsonb(OLD);
        new_row := to_jsonb(NEW);
        -- Compute which fields changed:
        FOR key IN SELECT jsonb_object_keys(old_row) LOOP
            IF old_row->key IS DISTINCT FROM new_row->key THEN
                changed := changed || key;
            END IF;
        END LOOP;
    END IF;

    INSERT INTO audit_log (table_name, record_id, operation, changed_by, old_values, new_values, changed_fields)
    VALUES (
        TG_TABLE_NAME,
        COALESCE(NEW.id, OLD.id),
        TG_OP,
        current_setting('app.current_user_id', TRUE)::INTEGER,  -- set by application
        old_row,
        new_row,
        changed
    );

    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- Apply to sensitive tables:
CREATE TRIGGER trg_products_audit
AFTER INSERT OR UPDATE OR DELETE ON products
FOR EACH ROW EXECUTE FUNCTION log_audit_event();
```

**Setting application context for audit triggers:**

```sql
-- Application code sets the current user context before queries:
SET LOCAL app.current_user_id = '42';  -- transaction-scoped setting
UPDATE products SET price_cents = 2999 WHERE id = 101;
-- Audit trigger reads: current_setting('app.current_user_id') → '42'
-- Audit log records: changed_by = 42
```

---

**Optimized audit columns for high-throughput tables:**

```sql
-- Heavy tables (10M+ inserts/day): full audit log row per change is expensive.
-- Pattern: keep basic created_at/updated_at on the hot table,
--          write full audit log only when sensitive fields change.

CREATE TRIGGER trg_products_audit_sensitive
AFTER UPDATE ON products
FOR EACH ROW
WHEN (OLD.price_cents IS DISTINCT FROM NEW.price_cents
   OR OLD.name IS DISTINCT FROM NEW.name)
EXECUTE FUNCTION log_audit_event();
-- Only audit price or name changes — not every status bump or view count increment.
```

---

## SECTION 4 — Query Execution Flow

### Temporal Queries Using Audit Columns

**Q1: "When did this record last change, and what changed?"**

```sql
-- Using created_at / updated_at on the row:
SELECT id, name, price_cents, created_at, updated_at
FROM products
WHERE id = 101;
-- Single primary key lookup: O(1). 0.2ms.
-- Tells you: current state + when it was last modified.
-- Doesn't tell you: what the previous value was.

-- Using audit_log for full history:
SELECT changed_at, operation, changed_by, old_values->>'price_cents' AS old_price,
       new_values->>'price_cents' AS new_price
FROM audit_log
WHERE table_name = 'products' AND record_id = 101
ORDER BY changed_at DESC;

-- EXPLAIN ANALYZE:
-- Index Scan using idx_audit_log_record on audit_log
--   Index Cond: (table_name = 'products' AND record_id = 101)
-- Order: using index (changed_at included in idx_audit_log_record)
-- Execution time: 0.8ms for 47 audit events on this product.
```

**Q2: "Which products changed price in the last 7 days?"**

```sql
SELECT p.id, p.name, p.price_cents AS current_price,
       p.updated_at, p.updated_by
FROM products p
WHERE p.updated_at >= NOW() - INTERVAL '7 days';

-- With index: CREATE INDEX idx_products_updated_at ON products(updated_at);
-- Index Scan using idx_products_updated_at
-- Execution time: 12ms for returning 4,200 changed products.
-- Without index: SeqScan of all products. 3,400ms on 8M products.
```

**Q3: "What did user 42 change yesterday?"**

```sql
SELECT a.table_name, a.record_id, a.operation,
       a.changed_at, a.changed_fields,
       a.old_values, a.new_values
FROM audit_log a
WHERE a.changed_by = 42
  AND a.changed_at >= '2024-03-14 00:00:00'
  AND a.changed_at <  '2024-03-15 00:00:00'
ORDER BY a.changed_at;

-- Index Scan using idx_audit_log_user on audit_log
--   Index Cond: (changed_by = 42 AND changed_at BETWEEN ...)
-- Execution time: 3.2ms returning 84 changes by user 42 yesterday.
```
