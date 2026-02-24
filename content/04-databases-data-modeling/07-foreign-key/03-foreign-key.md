# Foreign Key — Part 3 of 3

### Sections: 9 (AWS Mapping), 10 (Interview Questions), 11 (Debugging Exercise), 12 (Architect's Mental Model)

**Series:** Databases & Data Modeling → Topic 07

---

## SECTION 9 — AWS Service Mapping

### Foreign Keys Across AWS Data Services

```
RDS / AURORA (PostgreSQL / MySQL):
  FK ENFORCEMENT:
    Standard FK behavior. Strongly recommend: always enabled in production.
    Exceptions: bulk data loading → use DEFERRABLE INITIALLY DEFERRED (Postgres) or
    disable per-session (MySQL: SET FOREIGN_KEY_CHECKS = 0) then re-enable and verify.
    Never disable globally in RDS parameter groups as a "performance optimization."

  AURORA PARALLEL QUERY:
    FK check during INSERT: parent table lookup via shared lock.
    With parallel query enabled: the FK check itself doesn't use parallel query (single-row lookup).
    No interaction between parallel query and FK enforcement.

  RDS READ REPLICAS:
    FKs: enforced on primary. Not re-enforced on replicas (replicas replay binlog, not re-validate).
    Application: never write to replica (it's read-only). FK constraint violations: caught on primary.
    If direct-to-replica writes were possible (Aurora Multi-Master v1): enforced. But avoided in production.

  AURORA GLOBAL DATABASE:
    Writes: primary region only. FK checks: happen on primary.
    Secondary regions: read-only replicas. Replication: applies deletes from primary (including cascades).
    CASCADE DELETE: executes on primary, replicates the result to secondaries.
    Secondary does NOT re-execute the cascade. Receives the resulting DELETEs as binlog entries.

  PARAMETER GROUP SETTINGS (Aurora MySQL):
    foreign_key_checks: should be ON (default). Confirm via:
      SHOW VARIABLES LIKE 'foreign_key_checks';  → should return ON.
    Some DBAs set OFF globally to speed up snapshots/restores. Always re-enable after.

DYNAMODB:
  NO NATIVE FOREIGN KEY CONSTRAINTS. DynamoDB does not enforce referential integrity.

  APPROACH 1: Application-level FK enforcement.
    Before INSERT into child table: check parent exists with GetItem.
    Problem: not atomic. Race: parent deleted between check and insert → orphan created.
    DynamoDB transactions: use TransactWriteItems to atomically insert child + check parent in one transaction.

    dynamodb.transact_write_items(
      TransactItems=[
        {
          'ConditionCheck': {
            'TableName': 'orders',
            'Key': {'id': {'S': parent_order_id}},
            'ConditionExpression': 'attribute_exists(id)'  # parent must exist
          }
        },
        {
          'Put': {
            'TableName': 'order_items',
            'Item': { ... }
          }
        }
      ]
    )
    -- If parent doesn't exist: TransactionCanceledException. Atomic. No orphan.
    -- Cost: 2 WCU per transact_write call. Acceptable overhead.

  APPROACH 2: DynamoDB Streams → Lambda to clean orphans after parent deletion.
    On DELETE from orders: Lambda detects via stream, issues DELETE for all order_items.
    Eventual consistency: brief window where orphans exist. Acceptable for most use cases.
    Not acceptable for: financial data, audit-required systems.

  APPROACH 3: Denormalize and store child data inline with parent.
    Order items: stored as a list attribute inside the order item.
    Single DynamoDB item. No cross-table FK needed. No consistency gap.
    Tradeoff: DynamoDB item size limit: 400KB. For orders with hundreds of items: may exceed.

AURORA → REDSHIFT (ETL):
  On ETL loads into Redshift: foreign keys exist as metadata but are NOT ENFORCED.
    CREATE TABLE order_items (..., order_id INT REFERENCES orders(id));
    Redshift: stores the FK declaration for documentation/optimizer hints.
    Does NOT enforce on INSERT. Orphaned FK values: perfectly insertable.

  WHY: Redshift OLAP workloads often load from pre-validated sources (Aurora).
    Re-enforcing FKs on 500M-row COPY would be prohibitively expensive.
    Data quality: guaranteed by the source system (Aurora) or ETL validation step.

  OPTIMIZER BENEFIT: Even unenforced, FK declarations help the query optimizer.
    Redshift: uses FK knowledge for join elimination (if A.id FK to B.id and you only select
    from A with no WHERE on B columns, planner may eliminate the join entirely).
    Declare FKs in Redshift even if unenforced. They improve query plans.

OPENSEARCH:
  No concept of FK. Document model: denormalize the data.
    Instead of: order_items table with order_id FK → orders.
    OpenSearch: store order as single document including nested item array.
    Parent-child documents: OpenSearch join type (rare, complex, performance-limited).
    Best practice for OS: design documents to avoid cross-document FK matching at query time.
```

---

## SECTION 10 — Interview Questions

### Beginner Questions

**Q1: What is a foreign key and what problem does it solve?**

> A foreign key is a column (or columns) in one table whose values must match values in the
> primary key of another table. It enforces referential integrity — the guarantee that every
> reference to a related entity actually points to an existing entity.
> Without FK: you can insert an order_item referencing order_id=9999 even if order 9999 doesn't
> exist. Queries joining the tables return garbage. Aggregates miss data. Applications crash.
> With FK: the database rejects the insert with a constraint violation, preventing orphaned data
> from ever entering the system. It's a contract enforced by the database engine, not application code.

**Q2: What are the four `ON DELETE` behaviors for a foreign key and when would you use each?**

> RESTRICT (default): prevents deleting the parent row if any child rows reference it.
> Use when: application must explicitly handle the relationship before deletion (safest, most explicit).
> CASCADE: automatically delete all child rows when parent is deleted.
> Use when: child data has no independent value (e.g., audit log entries for a deleted session).
> SET NULL: set the FK column to NULL in child rows when parent is deleted.
> Use when: the relationship is optional and child record should be retained without the reference (e.g., orders should survive even if a product is removed from catalog).
> SET DEFAULT: set the FK column to its default value.
> Use when: there's a sentinel / placeholder parent row (e.g., "unassigned" category) that should absorb orphaned rows.

**Q3: Why must you index foreign key columns on child tables?**

> When you delete or update a row in the parent table, the database must verify whether any
> child rows reference that parent row (to decide whether to restrict, cascade, etc.).
> Without an index on the FK column: the database scans the entire child table — O(N) scan.
> For a child table with 500M rows: every parent deletion requires a 500M-row sequential scan,
> taking seconds and holding locks that block other operations.
> With an index on the FK column: the check is an O(log N) index lookup — milliseconds.
> The index on the child FK column is required for correct performance. It is NOT created
> automatically by the database when you declare the FK constraint (unlike the PK index).

### Intermediate Questions

**Q4: What is a deferred constraint and when would you use it?**

> By default, FK constraints are checked immediately after each INSERT/UPDATE statement.
> A DEFERRABLE INITIALLY DEFERRED constraint delays its check until COMMIT time.
> USE CASE: bulk loading parent + child data in the same transaction where topological insert
> order can't be guaranteed.
> Example: loading 10,000 departments and 500,000 employees from CSV files.
> employees.department_id → departments.id.
> If employees are inserted before their departments: immediate FK check fails.
> With DEFERRABLE INITIALLY DEFERRED: all 510,000 inserts proceed; at COMMIT, the engine
> verifies all FK values — if any employee references a non-existent department, the
> entire transaction rolls back with a clear error. No orphans possible.

**Q5: A delete operation that should take 100ms is taking 30 seconds occasionally in production. How would you diagnose if a foreign key is the cause?**

> Step 1: Check `pg_stat_activity` during the slow delete to see what the process is doing:
> `SELECT wait_event, wait_event_type, query FROM pg_stat_activity WHERE state = 'active'`.
> FK check appears as: wait_event = LockAcquire or showing sequential scan.
> Step 2: `EXPLAIN (ANALYZE, BUFFERS) DELETE FROM parent WHERE id = $problematic_id`
> to get the actual plan.
> Step 3: Look for `Seq Scan on child_table` in the EXPLAIN output — this confirms a missing
> index on the FK column.
> Step 4: Confirm with the FK diagnostic query that lists all FK columns without a supporting index.
> Fix: `CREATE INDEX CONCURRENTLY idx_child_parent_fk ON child_table(parent_id)`.
> The CONCURRENTLY flag ensures no table lock on the child table during index creation.

### Advanced Questions

**Q6: Design a schema that must maintain referential integrity across two microservices, each with its own database. The order service has orders, and the inventory service has products. An order item must reference a valid product.**

> Cross-database FKs don't exist. Three patterns, each with different tradeoffs:
>
> Pattern 1 — Synchronous Validation (tight coupling):
> Order service calls Inventory service API synchronously before accepting an order item.
> If product doesn't exist: reject.
> Risk: Inventory service downtime = Order service downtime. Circuit breaker required.
>
> Pattern 2 — Event-Driven with Local Cache (eventual consistency):
> Inventory service publishes "product created/deleted" events to Kafka.
> Order service consumes events, maintains a local products reference table (id, name, status).
> FK is against the LOCAL products table (within the same DB as orders).
> Lag: seconds. Window: orphaned order items if product deleted while message in transit.
> Mitigation: product deletion is a soft-delete (status='archived') — never hard-delete referenced products.
>
> Pattern 3 — Saga Pattern with Compensating Transaction:
> Order placement = saga: reserve inventory → create order → confirm.
> Each step has a compensating transaction (cancel reservation → delete order).
> If any step fails: compensating transactions run. Eventual consistency guaranteed.
> Most robust but complex. Use for financial/inventory-critical workloads.

---

## SECTION 11 — Debugging Exercise

### Scenario: Cascade Delete Taking Hours in Production

```
SYMPTOMS:
  - Admin panel: "Delete User" button on user account management page.
  - Deleting a user: takes 0.1 seconds for most users. Takes 2+ hours for some enterprise users.
  - DB CPU: spikes to 100% during these long deletions. Other queries: timing out.
  - The admin app eventually throws: "Connection timeout after 7200 seconds."
  - Enterprise user deleted: 1 user with millions of associated records.

SCHEMA (simplified):
  users (id PK, email, ...)
  accounts (id PK, user_id FK → users ON DELETE CASCADE)
  projects (id PK, account_id FK → accounts ON DELETE CASCADE)
  tasks (id PK, project_id FK → projects ON DELETE CASCADE)
  comments (id PK, task_id FK → tasks ON DELETE CASCADE)
  attachments (id PK, comment_id FK → comments ON DELETE CASCADE)

DATA PROFILE (for the enterprise user causing issues):
  user_id=1001: enterprise customer, 6 years of data.
    accounts:    1,200 accounts
    projects:    48,000 projects
    tasks:       2,400,000 tasks
    comments:    18,000,000 comments
    attachments: 5,400,000 attachments
  Total rows to cascade-delete: ~25.8M rows.

INVESTIGATION:

Step 1: Check lock state during a slow delete.
  During a deletion, query pg_stat_activity and pg_locks:

  SELECT pid, query, wait_event, wait_event_type, query_start
  FROM pg_stat_activity WHERE query LIKE '%DELETE%' AND state = 'active';

  Found: one backend, running for 1.5 hours, wait_event = NULL (CPU-bound, not waiting for locks).
  Query: DELETE FROM users WHERE id = 1001;

  The deletion itself is not blocked. It's just a very long-running transaction
  deleting 25.8M rows while holding RowExclusiveLock on all 6 tables.
  Other write operations to those tables: BLOCKED for the duration.

Step 2: Check index coverage on FK columns.
  Run FK index diagnostic query. Results:
    tasks.project_id: NO INDEX!   ← 2.4M rows
    comments.task_id: NO INDEX!   ← 18M rows
    attachments.comment_id: NO INDEX! ← 5.4M rows

  Without index on tasks.project_id:
    For each of 48,000 projects: SeqScan tasks (2.4M rows) to find children.
    48,000 × SeqScan(2.4M) = full scan essentially never completes.

  Finding: the cascade delay is both (a) missing indexes causing sequential scans
  AND (b) volume (25.8M rows is genuinely large for a single transaction).

RESOLUTION — Three phases:

Phase 1: Emergency index creation (first, before next enterprise delete).
  CREATE INDEX CONCURRENTLY idx_tasks_project ON tasks(project_id);
  CREATE INDEX CONCURRENTLY idx_comments_task ON comments(task_id);
  CREATE INDEX CONCURRENTLY idx_attachments_comment ON attachments(comment_id);
  -- CONCURRENTLY: no table locks. Runs in background. Safe during production.

  After indexes: each cascade level = index lookup, not SeqScan.
  Total time: ~2-5 minutes for 25.8M rows (still large but manageable).

Phase 2: Soft-delete pattern for enterprise accounts.
  Instead of hard-delete: UPDATE users SET deleted_at = NOW(), anonymized = TRUE WHERE id = $1;
  Physical deletion: background job runs nightly, deletes in batches:
    DELETE FROM comments WHERE task_id IN (
      SELECT t.id FROM tasks t JOIN projects p ON p.id = t.project_id
      JOIN accounts a ON a.id = p.account_id
      WHERE a.user_id = 1001 AND a.deleted_at IS NOT NULL
    )
    LIMIT 10000;  -- 10K rows per batch. Sleep 100ms between batches.

  User experience: instant (soft-delete). Physical cleanup: happens overnight, no blocking.

Phase 3: Long-term — cap cascade depth in architecture.
  Cascade depth > 3 levels: redesign. Use explicit background job for deep cascades.
  FK ON DELETE RESTRICT beyond depth 2: application handles deletion explicitly.
  This makes "what gets deleted when I delete X" explicit and auditable, not implicit.
```

---

## SECTION 12 — Architect's Mental Model

```
=== Architect's Mental Model: Foreign Key ===

DECISION RULE 1: FK without index on the child column is a ticking lock bomb.
  Every parent row deletion and update triggers a child table check.
  Without index: O(N) scan of entire child table while holding locks.
  At any meaningful write rate to the child table: this causes locking cascades.
  Rule: immediately after declaring any FK, add the index. Automate this in your migration templates.

DECISION RULE 2: ON DELETE CASCADE is powerful and irreversible. Use sparingly.
  CASCADE is appropriate ONLY for data that has no independent value beyond its parent.
  (e.g., session tokens when user deleted, shopping cart when checkout completed).
  Business records that persist beyond the relationship (orders, invoices, audit logs):
  NEVER cascade delete. Use soft-delete on parent + RESTRICT on child. Application handles it.

DECISION RULE 3: Deep cascade chains are operational risks.
  Cascade depth > 3: one DELETE can trigger tens of millions of deletes.
  During cascade: all affected tables are locked for writes. Wide operational blast radius.
  Maximum recommended cascade depth: 2 levels. Beyond that: explicit application batch delete.

DECISION RULE 4: Disabling FKs for performance is a false economy.
  FK check: ~0.3ms per INSERT (one index lookup). "Too slow" only in bulk load scenarios.
  For bulk loads: use DEFERRABLE INITIALLY DEFERRED. Check at COMMIT boundary. No permanent disable.
  The data integrity cost of permanently disabled FKs: measured in six-figure revenue incidents.

DECISION RULE 5: FK declarations matter in OLAP even when not enforced.
  Redshift, BigQuery: FK constraints are stored but not enforced.
  Query planner uses FK knowledge to eliminate unnecessary joins.
  Always declare FKs in Redshift/Snowflake/BigQuery schemas. They cost nothing to declare.
  They help the optimizer and serve as documentation for the data model.

COMMON MISTAKE 1: Assuming FK index is created automatically.
  Databases DO auto-create PK indexes. They do NOT auto-create indexes on FK columns.
  Every ORM migration that creates a FK: manually add the index in the same migration.
  Automated check: run FK index diagnostic query after every schema migration in CI.

COMMON MISTAKE 2: ON DELETE CASCADE on deeply nested schemas.
  Seen in: frameworks that generate cascade for "belongs to" associations by default.
  Rails, Django: careful with dependent: :destroy — it triggers application-level cascade (N+1).
  Database-level CASCADE: efficient (single transaction), but creates all-or-nothing risk.
  Neither approach is safe at depth > 2-3. Architect explicit deletion flows.

COMMON MISTAKE 3: Making FK nullable when it should be NOT NULL.
  orders.customer_id INT REFERENCES customers(id) ← nullable by default in most ORMs.
  Every order should have a customer. Nullable FK allows: order with customer_id = NULL.
  This creates a class of orphaned orders that silently exist in the system.
  Rule: if "this relation is required," add NOT NULL to the FK column.
  Only omit NOT NULL when the relationship is genuinely optional (e.g., optional manager_id).

30-SECOND INTERVIEW ANSWER (Why do you need an index on a foreign key column?):
  "When you delete a row from the parent table, the database must check whether any rows in
  the child table reference that parent. Without an index on the child's FK column, the database
  must scan the entire child table to answer that question. For a child table with millions of
  rows, that's a full sequential scan that takes seconds, holds locks, and blocks every other
  write to that table during the scan. With an index, the check is an O(log N) index lookup
  that takes less than a millisecond. The database doesn't automatically create this index
  when you declare the FK — you have to add it manually, and forgetting it is one of the
  most common causes of mysterious locking problems in production databases."
```
