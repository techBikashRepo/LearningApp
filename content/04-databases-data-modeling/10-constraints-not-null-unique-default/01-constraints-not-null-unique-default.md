# Constraints (NOT NULL, UNIQUE, DEFAULT) — Part 1 of 3

### Sections: 1 (Intuition), 2 (Why It Exists), 3 (Internal Working), 4 (Query Execution Flow)

**Series:** Databases & Data Modeling → Topic 10

---

## SECTION 1 — The Intuition

### Mental Model: Database Contracts

```
A constraint is a rule enforced by the database engine itself—not your application code.
Think of it as a contract written into the table definition that runs unconditionally,
on every write, from every client, regardless of which application version is deployed.

ANALOGY: Airport security checkpoint.

Without a constraint:
  Every departure gate (every API endpoint, every script, every ORM operation)
  must remember to validate the passenger's boarding pass before boarding.
  One gate forgets validation → passenger boards wrong flight (bad data enters the table).

With a constraint:
  The walkway physically won't open unless the boarding pass is valid.
  No application, no script, no bulk import, no direct psql session can bypass it.
  The rule isn't in the app — it IS the infrastructure.

THE THREE BASIC CONSTRAINTS:

  NOT NULL — "this column must always have a value"
    Like: "every order must have a customer_id"
    Without it: some orders have customer_id = NULL. Who owns them? Nobody knows.
    Effect: blocks INSERT/UPDATE if the column value is NULL.

  UNIQUE — "no two rows can have the same value in this column"
    Like: "no two accounts can share the same email address"
    Without it: 1 user can register 10 times with the same email. Password reset sends to all.
    Effect: checks uniqueness across all rows before each INSERT/UPDATE. Blocks duplicates.

  DEFAULT — "if no value is provided, use this value instead"
    Like: "all new orders default to status='PENDING' unless explicitly specified"
    Without it: INSERT without specifying status puts NULL in that column.
    NULL status is invisible to filters like WHERE status = 'PENDING'. Record disappears.
    Effect: substitutes the default at INSERT time when the column is omitted.

THE KEY INSIGHT:
  Application-level validation is a first line of defense.
  Constraint-level validation is the last line — and the only reliable one.
  Bugs, migrations, scripts, third-party tools, and DB console access all bypass app code.
  Constraints don't. They enforce correctness at the only layer that matters: the data itself.
```

---

## SECTION 2 — Why This Exists: Production Failures Without Constraints

### The Business Cost of Missing Constraints

```
REAL INCIDENT TYPE 1: Missing NOT NULL — NULL Propagation in Revenue Reports

  System: SaaS billing platform.
  Schema: invoices(id, customer_id, amount, tax_rate, total)
  Problem: total column has no NOT NULL, no DEFAULT.

  A deployment bug: a code path set total = NULL for invoices where tax was exempt.
  Result: 12,000 invoices with total = NULL.

  Revenue query:
    SELECT SUM(total) FROM invoices WHERE month = '2024-01';
    → Returns a number 40% lower than actual.

  Why: NULL arithmetic. SUM() ignores NULL values. If even one total = NULL, SUM skips it.
  Effect: CFO presents incorrect quarterly revenue to the board.
  Recovery time: 3 days of reconciliation. NULL rows had to be backfilled manually.

  Prevention: total NUMERIC(12,2) NOT NULL DEFAULT 0

REAL INCIDENT TYPE 2: Missing UNIQUE — Duplicate Users Causing Double-Billing

  System: subscription platform.
  Schema: users(id, email, stripe_customer_id, plan_id)
  Problem: email column has no UNIQUE constraint.

  Race condition: two concurrent registrations with the same email (browser double-click,
  retry from poor connection) both succeed — INSERT returns 200 for both.

  Result: same email → 2 user accounts → 2 Stripe customers → charged twice.
  48 hours until customer complained. 200+ duplicate accounts found in audit.

  Prevention: email VARCHAR(255) NOT NULL UNIQUE
  A UNIQUE constraint (backed by a unique B-tree index) catches this even in a race condition.
  The SECOND concurrent insert blocks until the first commits, then sees the conflict and fails.

REAL INCIDENT TYPE 3: Missing DEFAULT — Status Column NULL Causes Invisible Records

  System: job processing queue.
  Schema: jobs(id, payload, status, created_at)
  The worker query: SELECT * FROM jobs WHERE status = 'PENDING' LIMIT 100;

  After a new deployment: a background intake script that POSTed jobs didn't send the status field.
  The column had no DEFAULT. ORM silently omitted the field → NULL inserted for status.

  Result: 14,000 jobs created with status = NULL. None processed. No error. No alert.
  WHERE status = 'PENDING': NULL != 'PENDING' → not returned. Jobs silently vanished from queue.

  Detection: only after customers reported missing results. 6-hour SLA breach.

  Prevention (both):
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'RUNNING', 'DONE', 'FAILED'))

REAL INCIDENT TYPE 4: Missing NOT NULL on FK — Orphaned Financial Records

  System: expense management.
  Schema: expense_reports(id, user_id, amount, approved_by)
  approved_by: FK to users(id) — but nullable.

  An automated approval script had a bug: set approved_by = NULL instead of the approver's ID.
  Result: 8,000 expense reports with approved_by = NULL.
  Downstream audit query: JOIN to users ON approved_by = users.id → inner join → all 8K records
  dropped from audit reports. Finance team didn't see them. $1.2M in unapproved expenses.

  Prevention: approved_by INT NOT NULL REFERENCES users(id)
  — but only if "every report must be approved before insertion" is a valid business rule.
  Alternative: use a workflow status to model approval state explicitly.
```

---

## SECTION 3 — Internal Working

### How the Database Engine Enforces Constraints

```
NOT NULL IMPLEMENTATION:
  Stored in pg_attribute catalog: attnotnull = TRUE for the column.
  Stored in MySQL information_schema.columns: IS_NULLABLE = 'NO'.

  Enforcement point: before the row is written to the heap page.
  On INSERT: executor checks every NOT NULL column. If any is NULL → error raised, row rejected.
  On UPDATE: checked only for columns being updated. Other columns: not re-checked.

  Cost: essentially zero. It's a flag check on the column metadata. No separate index lookup.
  NULL storage: when a column is NOT NULL, Postgres can omit the null bitmap entry for that row,
  slightly reducing storage per row. Meaningful on wide tables with many NOT NULL columns.

UNIQUE CONSTRAINT IMPLEMENTATION:
  A UNIQUE constraint creates a unique B-tree index automatically on the constrained column(s).

  On INSERT: executor computes the index key, probes the B-tree for the exact key.
  If found (key already exists in the index): ERROR: duplicate key value violates unique constraint.
  If not found: insert the row into heap AND insert into the unique index. Two operations.

  CONCURRENCY BEHAVIOR (critical):
    Two concurrent transactions T1 and T2 both try to INSERT the same email:
    T1 inserts first: takes a RowExclusiveLock on the index page, writes the entry.
    T2 tries to insert same key: blocked until T1 commits or rolls back.
    T1 commits: T2 resumes, finds the key exists → raises duplicate key error.
    T1 rolls back: T2 resumes, key no longer exists → T2 proceeds successfully.
    Result: exactly one of the two concurrent inserts succeeds. Exactly as required.

  NULL AND UNIQUE:
    Important SQL standard rule: NULL is not equal to NULL for UNIQUE purposes.
    Multiple NULLs in a UNIQUE column are ALLOWED (each NULL is considered distinct).
    Exception: PostgreSQL NULLS NOT DISTINCT (PG15+):
      UNIQUE NULLS NOT DISTINCT (col) → only one NULL permitted. Strict uniqueness.
    MySQL: NULLs are permitted in UNIQUE columns (standard behavior).

DEFAULT IMPLEMENTATION:
  Stored in pg_attrdef catalog: column default expression.
  Can be a literal value (DEFAULT 'PENDING'), a function call (DEFAULT NOW()), or an expression.

  Evaluation time: DEFAULT is evaluated at INSERT time when the column is omitted.
  NOT at table creation time. NOT when the DEFAULT is declared. When the row is inserted.

  DEFAULT NOW(): each row gets the timestamp of its own INSERT. Correct.
  DEFAULT CURRENT_TIMESTAMP: same behavior.

  Implication: DEFAULT uuid_generate_v4() → each row gets a unique UUID. Correct.

  No storage cost for DEFAULT. It's metadata. Only matters at INSERT time.

  DEFAULT vs NOT NULL interaction:
    Column has DEFAULT but no NOT NULL:
      Omitting the column → DEFAULT applied.
      Explicitly passing NULL → NULL stored (DEFAULT not applied — explicit NULL overrides DEFAULT).
    Column has both DEFAULT and NOT NULL:
      Omitting the column → DEFAULT applied. Safe.
      Explicitly passing NULL → NOT NULL check fires → ERROR. Expected.
    Rule: for columns that should always have a value, use BOTH DEFAULT AND NOT NULL.

CHECK CONSTRAINTS:
  A generalization of these three: arbitrary boolean expression on column(s).
  CHECK (amount > 0): rejects any INSERT with amount <= 0.
  CHECK (status IN ('PENDING','RUNNING','DONE','FAILED')): enum enforcement at DB level.
  Stored in pg_constraint catalog.
  Evaluated at INSERT / UPDATE for affected rows.
  Can span multiple columns: CHECK (end_date >= start_date).
```

---

## SECTION 4 — Query Execution Flow

### How Constraints Change the Write Path

```
SCENARIO: INSERT INTO orders (customer_id, amount, status) VALUES (NULL, 150.00, NULL)
Schema: customer_id INT NOT NULL, amount NUMERIC(12,2) NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'PENDING'

EXECUTION PIPELINE:

Step 1: PARSE
  Parser reads the INSERT statement. Identifies: target table = orders.
  Column list: (customer_id, amount, status). Values: (NULL, 150.00, NULL).

Step 2: REWRITE / DEFAULTS
  Planner checks if any omitted columns have DEFAULT values.
  Status is PROVIDED (as NULL explicitly) — DEFAULT is NOT applied. NULL is the explicit value.
  If status were omitted entirely: DEFAULT 'PENDING' would be substituted here.

Step 3: EXECUTOR — NOT NULL CHECKS
  Before inserting the row, executor checks all NOT NULL constraints:
  customer_id: provided as NULL. NOT NULL check fires. → ERROR: null value in column
  "customer_id" of relation "orders" violates not-null constraint.
  DETAIL: Failing row contains (null, 150.00, null).

  Row is REJECTED. No heap write. No index write. No WAL entry for this row.
  Transaction state: current transaction marked as aborted if this was a bare statement.
  If inside a larger transaction: sub-statement rolled back. Transaction can continue with SAVEPOINT.

Step 4 (what would happen with customer_id=42): HEAP WRITE
  Row TupleID allocated on heap page. Row written to page buffer.

Step 5: UNIQUE INDEX CHECK (if applicable)
  For each unique-constrained column in the INSERT:
  Index probe: seek the unique index for the key being inserted.
  Found → duplicate key error (ROLLBACK). Not found → proceed.

  For a UNIQUE(email) on the users table:
  INSERT INTO users (email) VALUES ('alice@corp.com')
  B-tree lookup on unique_users_email_idx for key 'alice@corp.com'.
  Not found → insert into B-tree index. Row committed.
  Second attempt with same email → found → ERROR duplicate key.

Step 6: WAL WRITE
  If all constraints pass and row is written to heap: WAL record generated.
  Write-ahead log: ensures durability. On crash: WAL replay recreates the row.
  Constraints that fired and rejected: no WAL entry. Nothing to recover.

CONSTRAINT TIMING MODES (PostgreSQL):

  IMMEDIATE (default): constraint checked immediately after each statement.
  DEFERRED: constraint checked at COMMIT time. Useful for circular FK inserts.

  Example where DEFERRABLE helps:
    Table A FK → Table B. Table B FK → Table A. (Circular dependency.)
    With immediate: impossible to insert either first.
    With DEFERRABLE INITIALLY DEFERRED: insert both rows in one transaction,
    check FKs at COMMIT. Both exist → both pass. Committed cleanly.

  NOT NULL: cannot be deferred. Always immediate.
  UNIQUE: can be deferred with CREATE UNIQUE INDEX ... DEFERRABLE INITIALLY DEFERRED.
  FOREIGN KEY: can be deferred.
  CHECK: can be deferred.

READING CONSTRAINT METADATA:
  -- See all constraints on a table:
  SELECT conname, contype, pg_get_constraintdef(oid)
  FROM pg_constraint
  WHERE conrelid = 'orders'::regclass;

  -- Check column nullability:
  SELECT attname, attnotnull, atthasdef
  FROM pg_attribute
  WHERE attrelid = 'orders'::regclass AND attnum > 0 AND NOT attisdropped;

  -- See column defaults:
  SELECT attname, pg_get_expr(adbin, adrelid) AS default_expr
  FROM pg_attrdef
  JOIN pg_attribute ON adrelid = attrelid AND adnum = attnum
  WHERE adrelid = 'orders'::regclass;
```
