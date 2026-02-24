# Constraints (NOT NULL, UNIQUE, DEFAULT) — Part 3 of 3

### Sections: 9 (AWS Service Mapping), 10 (Interview Q&A), 11 (Debugging Exercise), 12 (Architect's Mental Model)

**Series:** Databases & Data Modeling → Topic 10

---

## SECTION 9 — AWS Service Mapping

### Constraints Across AWS Database Services

```
RDS PostgreSQL / Aurora PostgreSQL:

  NOT NULL, UNIQUE, DEFAULT, CHECK: fully supported. Identical to upstream PostgreSQL.
  DEFERRABLE INITIALLY DEFERRED: supported.
  Functional UNIQUE indexes: supported.
  Partial UNIQUE indexes: supported.

  Aurora-specific behavior:
    Aurora PostgreSQL: same constraint semantics as standard PostgreSQL.
    Multi-AZ failover: constraints (stored in catalog) replicated to standby.
    After failover: all constraints remain active. No re-configuration needed.

  RDS Migration Consideration:
    When migrating from MySQL to Aurora PostgreSQL:
    MySQL: does not enforce CHECK constraints (parses but ignores them in MySQL 5.x).
    Aurora PostgreSQL: enforces CHECK constraints. Data already violating CHECK → migration fails.
    Pre-migration: run validation queries to find CHECK-violating rows and clean them up.

RDS MySQL / Aurora MySQL:

  NOT NULL: enforced.
  UNIQUE: enforced (backed by a unique index, as in PG).
  DEFAULT: supported. CURRENT_TIMESTAMP for DATETIME columns with special syntax.
  CHECK (MySQL 5.7 and earlier): PARSED but NOT ENFORCED. Silent no-op.
  CHECK (MySQL 8.0.16+): ENFORCED. Upgrade path to enforce data integrity.

  Aurora MySQL: same constraint behavior as MySQL 8.0.
  Important: if you rely on CHECK constraints, ensure MySQL 8.0 or use Aurora PG.

DynamoDB:

  DynamoDB: no SQL-style constraints. No NOT NULL, UNIQUE, CHECK.

  Primary key: uniqueness enforced (partition key alone, or partition + sort key together).
  Everything else: schema-less. Any attribute can be absent (equivalent to nullable).

  Equivalent to NOT NULL:
    Application-level validation before writes.
    Lambda with DynamoDB Streams: validate incoming items, dead-letter invalid ones.
    ConditionExpression on PutItem: attribute_exists(required_field) → only update if exists.
      PUT with: ConditionExpression="attribute_exists(customerId)"
      If customerId missing: ConditionalCheckFailedException. Reject the write.

  Equivalent to UNIQUE (on non-PK attribute):
    No native support. Must implement in application.
    Pattern: create a separate "unique constraint table":
      Table: users_by_email (PK: email) with TransactWriteItems:
      - PutItem TO users_by_email (email) with ConditionExpression = attribute_not_exists(email)
      - PutItem TO users (userId, ...)
      Both in one transaction. If email exists: ConditionalCheckFailedException. Rollback.
    Complex. DynamoDB constraint simulation is application responsibility.

Redshift:

  Redshift: supports NOT NULL, UNIQUE, PRIMARY KEY, FOREIGN KEY syntax.
  BUT: "UNIQUE and PRIMARY KEY constraints are informational ONLY in Redshift."
  Redshift does NOT enforce uniqueness. You CAN insert duplicate values.

  Purpose in Redshift: query optimizer hints. The planner MAY use them to optimize joins.
  They do NOT prevent duplicate data.

  Enforcement: application or ETL pipeline must enforce uniqueness before loading.
  Detect violations: SELECT email, COUNT(*) FROM users GROUP BY email HAVING COUNT(*) > 1;
  Run post-load. If duplicates found: deduplicate before promoting to production layer.

RDS Proxy and Constraints:

  RDS Proxy: connection pooler. Transparent to application.
  Constraint violations: returned as errors through RDS Proxy exactly as they would be directly.
  ON CONFLICT behavior: unchanged by RDS Proxy.
  No impact on constraint semantics. Only affects connection management.
```

---

## SECTION 10 — Interview Questions & Answers

### Beginner Level

**Q1: What is the difference between NOT NULL and an empty string in PostgreSQL?**

NOT NULL prevents a column from containing the special `NULL` value — which means "unknown" or "absent." An empty string `''` is a valid string value with zero characters. They are completely different.

A `NOT NULL` column can still hold `''`, `0`, `FALSE`, or any other value — just not NULL. NULL is not zero, not false, and not empty string. `NULL = NULL` is not TRUE; it returns NULL. You must use `IS NULL` or `IS NOT NULL` to test for it. In practice: use `NOT NULL` on every column where absence of data is invalid. Use empty-string checks (`WHERE col != ''`) only if empty strings are also logically invalid for your use case.

---

**Q2: Why is applying UNIQUE only at the application layer (SELECT then INSERT) insufficient?**

Because of the race condition between the SELECT and the INSERT. Two concurrent requests can both execute the SELECT, both see no existing row, both proceed with the INSERT, and both succeed — resulting in duplicate data. The database does not see both operations as competing; it sees them as independent. Only a UNIQUE constraint backed by a UNIQUE index prevents this, because the database engine serializes the uniqueness check and the insert atomically using internal locking at the index level. The second concurrent INSERT blocks until the first commits, then detects the duplicate and fails. No application-level check can replicate this guarantee.

---

**Q3: What does DEFAULT do, and when is it evaluated?**

`DEFAULT` assigns a value to a column when an INSERT statement omits that column. The default expression is evaluated at INSERT execution time — not at table creation time. This means `DEFAULT NOW()` inserts the current timestamp at the moment each row is inserted, not the time the table was created. Two rows inserted 10 minutes apart will have different `created_at` values. A `DEFAULT 0` applies the literal `0` to each new row. Starting from PostgreSQL 11, adding a column with a `NOT NULL DEFAULT` to an existing large table is an instant catalog-only change — no table rewrite needed — making large-table migrations safe and fast.

---

### Intermediate Level

**Q4: How does UNIQUE handle NULL values? Can a UNIQUE column have multiple NULLs?**

By default, yes: a UNIQUE column can have multiple NULL values, because `NULL != NULL` — nulls are considered distinct from each other. Each NULL occupies a separate unique position.

This has practical implications for soft-delete patterns: if you have `UNIQUE (email)` and email can be NULL (for deleted accounts), multiple deleted accounts can exist with email = NULL. If you want to prevent even NULL duplicates, PostgreSQL 15 introduced `UNIQUE NULLS NOT DISTINCT`, which treats all NULLs as equal — so only one NULL is permitted. This is useful for columns like `external_reference_id` that must be globally unique including NULL.

---

**Q5: How do you add a NOT NULL constraint to a 500 million row table without downtime?**

In PostgreSQL, adding `NOT NULL` to an existing column requires a full table scan to verify no NULLs exist, which locks the table. For large tables, use the deferred validation pattern:

1. **Add as NOT VALID CHECK** (no scan, no lock): `ALTER TABLE events ADD CONSTRAINT events_user_id_nn CHECK (user_id IS NOT NULL) NOT VALID;`
2. **Validate concurrently** (scan without blocking writes): `ALTER TABLE events VALIDATE CONSTRAINT events_user_id_nn;` — takes minutes but only holds a light lock (ShareUpdateExclusiveLock).
3. **Convert to column NOT NULL** (fast catalog change): `ALTER TABLE events ALTER COLUMN user_id SET NOT NULL;` — PostgreSQL 12+ can deduce the constraint from the validated CHECK and makes this instant.
4. **Drop the CHECK constraint**: `ALTER TABLE events DROP CONSTRAINT events_user_id_nn;`

This provides full NOT NULL enforcement with zero write blocking throughout the process.

---

### Advanced Level

**Q6: Explain how DEFERRABLE INITIALLY DEFERRED constraints work and when you would use them.**

Normally, constraint checks happen at the end of each SQL statement. `DEFERRABLE INITIALLY DEFERRED` moves the check to the end of the transaction (at COMMIT time). This allows intermediate states within a transaction that would violate the constraint, as long as the final state is valid.

**Use case — circular foreign keys or batch dependency:** If you need to insert two rows that each reference the other (circular FK), the standard approach fails because either insert would violate the FK before the other row exists. With `DEFERRABLE INITIALLY DEFERRED`, you insert both within one transaction, and the FK is only checked at COMMIT — by which point both rows exist.

**Use case — bulk re-assignment within UNIQUE column:** Moving a UNIQUE value from one row to another in two steps (UPDATE A to temp, UPDATE B to original value, UPDATE A to B's original) would fail at each step without deferral. Deferred UNIQUE allows the intermediate duplicate to exist transiently within the transaction.

Syntax: `CONSTRAINT my_fk FOREIGN KEY (ref_id) REFERENCES other_table(id) DEFERRABLE INITIALLY DEFERRED;`

---

**Q7: A developer says "we're using NOT NULL on all columns so our data is always clean." What's missing?**

`NOT NULL` only enforces presence — it cannot enforce correctness. A column with `NOT NULL` constrained to `VARCHAR(20)` can still contain `' '` (whitespace), `'N/A'`, `'null'` (the string), or any other meaningless value. True data cleanliness requires a full constraint stack:

1. **NOT NULL**: presence check (column must have a value).
2. **CHECK**: validity check (value must be within allowed domain — e.g., `CHECK (status IN ('pending', 'active', 'closed'))`).
3. **UNIQUE**: uniqueness (no business-key duplicates).
4. **REFERENCES / FK**: relational integrity (no orphaned rows).
5. **Application validation**: business rules too complex for SQL constraints.
6. **Input sanitization**: trim whitespace, reject placeholder values like `'N/A'` at the application layer before they reach the database.

Each layer catches different failure modes. NOT NULL alone is necessary but far from sufficient.

---

## SECTION 11 — Debugging Exercise

### Production Incident: Silent Data Quality Failure

**Scenario:**
Your company's revenue dashboard shows $4.2M in revenue for Q3. The finance team's external audit reports $5.1M. You've been paged at 2am. The discrepancy is $900K. Your database is the system of record.

**Your tools:** `pg_stat_user_tables`, `psql`, `pg_constraints`, and the application schema.

---

**Step 1: Identify the affected table.**

```sql
-- Which tables have revenue-relevant data?
SELECT tablename, attname, atttypid::regtype
FROM pg_attribute
JOIN pg_class ON pg_class.oid = attrelid
JOIN pg_tables ON tablename = relname
WHERE attname ILIKE '%amount%' OR attname ILIKE '%revenue%' OR attname ILIKE '%total%'
  AND schemaname = 'public';
-- Output: orders.total, payments.amount, line_items.unit_price, line_items.quantity
```

**Step 2: Check for NULL values in revenue-contributing columns.**

```sql
-- Are there NULL amounts in the payments table?
SELECT COUNT(*) AS total_rows,
       COUNT(amount) AS non_null_count,
       COUNT(*) - COUNT(amount) AS null_count,
       SUM(amount) AS dashboard_revenue
FROM payments
WHERE created_at >= '2024-07-01' AND created_at < '2024-10-01';

-- Output:
-- total_rows: 842,000
-- non_null_count: 752,341
-- null_count: 89,659    ← 89,659 rows with NULL amount!
-- dashboard_revenue: 4,200,000

-- The dashboard query: SUM(amount) ignores NULLs. 89,659 payments never counted.
```

**Step 3: Find the source of NULL amounts.**

```sql
-- When did NULL amounts start appearing?
SELECT DATE(created_at), COUNT(*) AS null_payment_count
FROM payments
WHERE amount IS NULL
GROUP BY DATE(created_at)
ORDER BY DATE(created_at);
-- Output: null amounts started on 2024-07-14.

-- What changed on 2024-07-14?
-- Check git log for schema changes around that date.
-- Deploy log: "2024-07-14 09:32 - Added payment_method column to payments table"
```

**Step 4: Check the schema change.**

```sql
-- What does the payments table look like now?
SELECT attname, atttypid::regtype, attnotnull, adsrc
FROM pg_attribute
LEFT JOIN pg_attrdef ON adrelid = attrelid AND adnum = attnum
WHERE attrelid = 'payments'::regclass AND attnum > 0;

-- Output includes: payment_method VARCHAR(50) DEFAULT NULL (not NOT NULL)
-- The migration also accidentally dropped DEFAULT on amount column.

-- Verify:
SELECT column_name, column_default, is_nullable
FROM information_schema.columns
WHERE table_name = 'payments';
-- amount: is_nullable = YES, column_default = NULL  ← root cause
-- Previously: amount had NOT NULL. Migration inadvertently dropped it.
```

**Step 5: Fix and recover.**

```sql
-- Restore NOT NULL constraint:
-- Step 1: fill NULLs from source system (charge records in Stripe via API reconciliation)
-- After filling NULLs:
ALTER TABLE payments ALTER COLUMN amount SET NOT NULL;

-- Verify no remaining NULLs:
SELECT COUNT(*) FROM payments WHERE amount IS NULL;  -- must return 0

-- Add DEFAULT to prevent future issues:
ALTER TABLE payments ALTER COLUMN amount SET DEFAULT 0;  -- or application always provides it

-- Fix constraint for future:
ALTER TABLE payments ADD CONSTRAINT payments_amount_notnull CHECK (amount IS NOT NULL);
```

**Root cause:** Schema migration dropped `NOT NULL` on `amount`. The application used an ORM that omitted `amount` from the INSERT when payment processing was async (amount filled in by a webhook). After the constraint was dropped, NULL amounts were inserted and silently excluded from SUM queries.

**Prevention:**

1. Code-review all schema migrations for accidental constraint removal.
2. Add database-level monitoring for NULL rates on financial columns.
3. Alert when `COUNT(*) - COUNT(amount) > 0` for any payment record.

---

## SECTION 12 — Architect's Mental Model

```
=== Architect's Mental Model: Database Constraints ===

┌─────────────────────────────────────────────────────────────────┐
│  PHILOSOPHY: Push correctness into the database layer.           │
│  Application code has bugs. Deployments fail mid-flight.         │
│  The database is the only component that can enforce invariants  │
│  atomically across all application code paths, languages, and    │
│  time zones. Constraints are your last line of defense.          │
└─────────────────────────────────────────────────────────────────┘

DECISION RULES:

1. DEFAULT "every column is NOT NULL" unless absence is meaningful.
   Columns where NULL has a distinct business meaning (e.g., "employee has no manager" for
   the CEO row, or "coupon has no expiry") may be nullable.
   All other columns: NOT NULL. Nullable by exception, not by default.

2. Every business key gets a UNIQUE constraint — not just a "please don't insert duplicates"
   comment in the code. Email, username, order_reference, external_id: all get
   UNIQUE at the database level. ON CONFLICT is free insurance.

3. DEFAULT values should reflect the most common correct state.
   status = DEFAULT 'pending', active = DEFAULT TRUE, created_at = DEFAULT NOW().
   A sensible default prevents silent NULLs from application code that omits the column.

4. Add CHECK constraints for categorical columns with known domains
   (status, type, tier, region). The check is essentially zero cost.
   Catches typos and invalid states that would otherwise silently corrupt reports.

5. When running ALTER TABLE on large tables in production:
   Always use NOT VALID → VALIDATE CONSTRAINT two-phase pattern.
   Never run a constraint add directly on a 100M+ row table without the two-phase approach.
   Test migration execution time on a restored production-size backup first.

COMMON MISTAKES:

1. Trusting ORMs to enforce constraints.
   ORMs do application-level validation (before the INSERT). That validation is bypassed by:
   direct SQL writes, bulk imports, seed scripts, legacy code, migrations, and admin tooling.
   The database constraint always fires, regardless of code path. The ORM validation does not.

2. Nullable foreign key columns.
   "customer_id INT REFERENCES customers(id)" without NOT NULL: allows orders with no customer.
   Any FK that represents a required relationship must also be NOT NULL.
   ORM defaults are often nullable. Always explicitly add NOT NULL to required FKs.

3. Adding a NOT NULL constraint without handling existing NULLs first.
   ALTER TABLE ... SET NOT NULL on a column with existing NULLs: fails immediately.
   Always: UPDATE table SET column = <default> WHERE column IS NULL; before adding NOT NULL.
   Or: use the NOT VALID → VALIDATE two-phase pattern for zero-downtime.

                     ╔══════════════════════════════════╗
  30-SECOND ANSWER → ║  CONSTRAINTS IN 30 SECONDS       ║
                     ╚══════════════════════════════════╝

"Database constraints are the only mechanism that enforces data integrity across
every code path, atomically, without exception. NOT NULL prevents missing data.
UNIQUE prevents duplicate business keys and backs fast lookups. DEFAULT ensures
every row starts in a valid state. CHECK rejects values outside known domains.
The database is the single source of truth — put your invariants there, not
scattered across application code that can be bypassed, rewritten, or broken.
The performance cost of constraints is minimal; the cost of corrupt data
is catastrophic."
```
