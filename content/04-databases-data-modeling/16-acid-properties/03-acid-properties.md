# ACID Properties — Part 3 of 3

### Sections: 9 (AWS Service Mapping), 10 (Interview Q&A), 11 (Debugging Exercise), 12 (Architect's Mental Model)

**Series:** Databases & Data Modeling → Topic 16

---

## SECTION 9 — AWS Service Mapping

### ACID Properties Across AWS Services

```
Aurora PostgreSQL — Full ACID:

  ATOMICITY:
    Maintained via WAL (Write-Ahead Logging). On COMMIT: WAL is written to Aurora Storage
    (6 copies, 4/6 quorum). On crash: WAL replay during recovery re-applies all committed
    changes. All operations in a transaction are applied, or none are.
    Aurora Crash Recovery: ~30 seconds to replay WAL since last checkpoint. Faster than
    standard PostgreSQL because Aurora Storage performs redo locally; the DB engine doesn't
    need to read all dirty pages back from disk.

  CONSISTENCY:
    CHECK, UNIQUE, NOT NULL, FK constraints enforced by the Aurora PG engine (same as vanilla PG).
    Aurora doesn't add or remove consistency guarantees — it delegates to PostgreSQL's constraint
    evaluation layer. Constraints are enforced at write time, not at storage layer.

  ISOLATION:
    Same isolation level support: READ COMMITTED (default), REPEATABLE READ, SERIALIZABLE (SSI).
    Aurora Parallel Query: allows a single SELECT to fan out across Aurora Storage nodes.
    Parallel Query respects snapshot isolation. Query reads pages as of its start snapshot.

  DURABILITY:
    Aurora's "log-is-the-database" model:
    - Traditional PG: writes buffer pool dirty pages to .data files + WAL to disk.
    - Aurora: writes ONLY WAL (redo log) to Aurora Storage. Storage nodes apply redo to local pages.
    - COMMIT latency: ~1-3ms (4/6 quorum write to 3 AZs).
    - No local disk fsync required. The 6-copy storage layer provides durability.
    - RTO: typical crash recovery < 30 seconds.

  Aurora Serverless v2:
    Same ACID guarantees as provisioned Aurora. ACU scaling doesn't affect transaction semantics.
    Transactions in progress during scale events: continue within existing ACUs.
    Cold start: ACUs scale up before new connections are accepted. No mid-transaction scaling.

RDS MySQL / Aurora MySQL:

  Atomicity + Durability: InnoDB redo log (analogous to PostgreSQL WAL).
    innodb_flush_log_at_trx_commit:
      1 = fsync on COMMIT (full A+D guarantee).
      2 = write to OS cache on COMMIT (full D on clean shutdown, up to 1s loss on crash).
      0 = up to innodb_flush_log_interval loss. Not durable.
    In Aurora MySQL: value of 1 is the effective behavior regardless of parameter setting.
    Aurora storage provides the durability; InnoDB redo writes go to Aurora's 6-copy storage.

  Consistency: MySQL 8.0+ enforces CHECK constraints. Prior: CHECK parses but doesn't enforce.
    UNIQUE and FK: enforced. BUT: FK enforcement can be disabled via SET foreign_key_checks=0.
    Disabling FK checks on bulk loads: temporarily violates consistency guarantee. Restore after.

  Isolation: MySQL SERIALIZABLE uses shared read locks (not SSI like PG). Higher contention.
    REPEATABLE READ (default): phantom reads protected within a transaction by next-key locks.
    PostgreSQL REPEATABLE READ: doesn't protect against phantoms (only SERIALIZABLE does).

DynamoDB:

  "ACID" in DynamoDB context:
    DynamoDB Transactions (TransactWriteItems / TransactGetItems):
    Up to 100 items per transaction. Automatically provides ACID across those items.

    ATOMICITY: all items in the TransactWriteItems apply or none do.
    CONSISTENCY: ConditionExpression enforces invariants at write time (version check, attribute check).
    ISOLATION: SERIALIZABLE for transaction; items outside the transaction: READ COMMITTED.
    DURABILITY: all writes replicated to 3 AZs before ACK. SLA: 99.999999999% (11 nines).

  Important caveat: TransactWriteItems cost = 2x normal WCU (two-phase internal mechanism).
  For 100 items in a transaction: you pay 200 WCUs.

  DynamoDB "ACID" without TransactWriteItems:
    Conditional writes on single items: atomic at the item level. Consistent. Isolated.
    NOT atomic across multiple items without TransactWriteItems.

ElastiCache Redis:

  Redis is NOT ACID durable by default:
    Atomicity: MULTI/EXEC block is atomic (all commands execute or none do).
      Caveats: MULTI does NOT roll back if a command fails mid-block (unlike DB transactions).
      If SET succeeds but a later INCRBY fails on type error: SET is kept. No rollback.
    Consistency: no constraint enforcement. Application-defined.
    Isolation: Redis is single-threaded for command execution. Commands don't interleave.
    Durability: by default, data is in-memory only. Lost on restart.
      AOF (Append-Only File): persistence option. fsync every write = durable but slow.
      RDB snapshot: periodic snapshot. RPO = time since last snapshot (minutes of data at risk).

  Use Redis for: caching, rate limiting, session storage (acceptable data loss risk).
  Do NOT use Redis as the system of record for data where ACID durability is required.

RDS Parameter Groups — ACID tuning for PostgreSQL:

  Critical parameters:
    synchronous_commit: on (default, full durability) | off | remote_write | remote_apply
    fsync: on (default) | off (dangerous — data corruption risk on OS crash even with fsync=off WAL)
    wal_level: replica (default) | logical (for replication/CDC)
    checkpoint_timeout: 5min default. Affects crash recovery duration (longer = longer recovery).

  Monitoring ACID health in RDS/Aurora:
    CloudWatch: FreeStorageSpace (low → WAL segments can't be written → durability risk).
    CloudWatch: DBLoad (high → transactions are queueing → isolation contention).
    CloudWatch: CommitThroughput + CommitLatency → baseline for COMMIT overhead.
    RDS Enhanced Monitoring: per-process CPU breakout. WAL writer CPU spike → COMMIT bottleneck.
```

---

## SECTION 10 — Interview Questions & Answers

### Beginner Level

**Q1: What does ACID stand for and what does each property guarantee?**

**Atomicity**: a transaction is all-or-nothing. If any part fails, the entire transaction is rolled back. No partial state is left in the database. Enforcement: WAL tracks the transaction; on failure, WAL replay rolls back any partial writes.

**Consistency**: a transaction brings the database from one valid state to another valid state. All constraints (NOT NULL, UNIQUE, CHECK, FK) hold before and after the transaction. The database never transitions to a state where defined rules are violated.

**Isolation**: concurrent transactions execute as if they were serial — running one after another. Each transaction sees a consistent snapshot of the data, not partially-committed changes from other transactions. Degrees of isolation exist (READ COMMITTED, REPEATABLE READ, SERIALIZABLE), each with different trade-offs between isolation strength and performance.

**Durability**: once a transaction commits, its changes are permanent. They survive crashes, power failures, and server restarts. Enforcement: COMMIT doesn't return success until the WAL is flushed to persistent storage. On crash, WAL replay re-applies all committed changes.

---

**Q2: What is the difference between Atomicity and Durability?**

Both relate to the lifecycle of a transaction, but at different points:

**Atomicity** governs what happens if a transaction **fails before committing**: "either all changes happen or none do." It protects against partial application of a multi-step operation. The bank transfer either completes both the debit and credit, or neither.

**Durability** governs what happens **after a transaction commits successfully**: "changes persist through crashes and failures." Once your application receives a COMMIT confirmation, the data is safe regardless of what happens to the server next — crash, power loss, reboot.

Atomicity and Durability work together through the WAL: atomicity uses the WAL to know which transactions were incomplete (to roll them back on recovery), and durability uses the WAL to know which transactions were committed (to replay them on recovery). Same mechanism, different direction of concern.

---

**Q3: Why do applications moving from a SQL database to NoSQL sometimes lose ACID guarantees?**

Most NoSQL databases (MongoDB, DynamoDB, Cassandra) prioritize availability and partition tolerance (CAP theorem) over strong consistency. This means: by default, they often provide weaker guarantees than ACID.

**Atomicity**: most NoSQL databases are only atomic at the single-document/item level. Cross-document operations (move balance from account A to account B) are NOT atomic without explicit transaction support (which DynamoDB TransactWriteItems, MongoDB multi-document transactions provide at extra cost/complexity).

**Consistency**: NoSQL databases typically don't enforce relational constraints (foreign keys, NOT NULL, UNIQUE across all use cases). The application must enforce these rules. If the application has a bug, the database won't catch invalid data.

**Isolation**: many NoSQL systems use eventual consistency (multiple replicas converge over time). Reads may see stale data. Two writes to the same document from different clients may result in last-write-wins (lost updates without application-level conflict detection).

**Durability**: some NoSQL systems (Redis by default, DynamoDB with eventual consistency reads) don't guarantee that a completed write has reached persistent storage before returning success. A power failure can lose recently written data.

The consequence: teams migrating from RDBMS to NoSQL sometimes see duplicate records, inconsistent counts, missing records, and "impossible" business states — problems that the RDBMS constraints would have prevented.

---

### Intermediate Level

**Q4: What is write skew, which isolation level prevents it, and give a concrete example?**

Write skew is a type of isolation anomaly where two concurrent transactions each read the same data, make decisions based on that data, and write non-overlapping rows — but the combined result violates a business invariant that would have been caught if they ran serially.

**Concrete example — doctor on-call system:**
Business rule: at least one doctor must be on call at all times.

```sql
-- Current state: doctor_A is on_call=true, doctor_B is on_call=true.
-- Both doctors decide to go off call simultaneously.

-- Transaction 1 (Dr. A):                  -- Transaction 2 (Dr. B):
BEGIN;                                       BEGIN;
SELECT COUNT(*) FROM doctors                 SELECT COUNT(*) FROM doctors
  WHERE on_call = true;  -- returns 2          WHERE on_call = true;  -- returns 2
-- "2 doctors on call, safe to go off"      -- "2 doctors on call, safe to go off"
UPDATE doctors SET on_call = false           UPDATE doctors SET on_call = false
  WHERE name = 'Dr. A';                        WHERE name = 'Dr. B';
COMMIT;                                      COMMIT;

-- Result: both doctors are off call. Invariant VIOLATED.
-- Neither transaction modified the other's rows (no lost update).
-- Read data changed out from under each transaction's decision (phantom-like condition).
```

**Why REPEATABLE READ doesn't help:** each transaction re-reads its snapshot consistently. The check passes in each transaction's snapshot. But the combined effect violates the constraint.

**SERIALIZABLE isolation (SSI) catches this:** PostgreSQL's SSI tracks read/write dependencies between transactions. It detects that T1 and T2 have a dependency cycle (each depended on what the other wrote to form a valid outcome). One transaction is aborted with `ERROR: could not serialize access due to read/write dependencies`. The application retries, and the second doctor's check now sees only 1 on-call doctor → denied.

---

**Q5: How does PostgreSQL implement Durability through WAL, and what happens during crash recovery?**

**Write-Ahead Log (WAL) mechanics:**

1. Every change to a data page (heap or index) is first recorded as a WAL record in the WAL buffer.
2. Before a COMMIT returns success: `write()` + `fsync()` flush the WAL buffer to disk (to WAL segment files, typically `pg_wal/` directory).
3. The actual data page (e.g., heap page in `base/16384/12345`) may still be "dirty" in shared_buffers — not yet written to disk. This is safe because the WAL supersedes the data page.
4. A background `checkpointer` process periodically writes all dirty pages from shared_buffers to their data files, then writes a checkpoint WAL record.

**Crash recovery sequence:**

1. PostgreSQL starts, reads the `pg_control` file to find the last valid checkpoint.
2. Opens the WAL starting from that checkpoint.
3. Replays each WAL record forward in time: applies changes from WAL to data pages.
4. Any transaction with a COMMIT record in the WAL: its changes are applied (durable).
5. Any transaction with no COMMIT record: WAL records exist but transaction is marked incomplete → rolled back (atomicity restored).
6. Database is now in the exact committed state at the moment of crash. Startup completes.

**PITR (Point-in-Time Recovery):** WAL is the mechanism behind PostgreSQL's backup/recovery. WAL archived continuously to S3 (via `archive_command`) + a base backup = ability to restore to any second in any past timeframe.

---

### Advanced Level

**Q6: In a microservices architecture with two separate databases, how do you achieve "atomic" cross-service operations without 2PC?**

True distributed atomicity (2PC) is fragile — a coordinator failure leaves transactions in a "prepared" limbo state, blocking VACUUM and requiring manual resolution. Modern distributed systems use the **Saga pattern** as a practical alternative.

**Saga pattern — two variants:**

1. **Choreography-based Saga**: each service publishes events and listens to other services' events. No central coordinator. Services react to events and publish their own outcomes.

```
Order Service (DB1):
  INSERT order (status=PENDING) → publishes OrderCreated event to Kafka

Payment Service (DB2):
  Consumes OrderCreated → charges card → if success: publishes PaymentSucceeded
                                          if fail: publishes PaymentFailed

Order Service:
  Consumes PaymentSucceeded → UPDATE order SET status=CONFIRMED
  Consumes PaymentFailed → UPDATE order SET status=CANCELLED
```

2. **Orchestration-based Saga**: a central saga orchestrator (a Step Functions state machine, a dedicated saga service) coordinates the steps and compensations.

**Compensating transactions (the key to atomicity-like behavior):**

- Each saga step has a corresponding compensating action that undoes it if a later step fails.
- Charge payment → compensation: refund payment.
- Reserve inventory → compensation: release reservation.
- Rollback semantics: if step 3 of 5 fails, execute compensations for steps 2 and 1 in reverse order.

**Difference from true ACID atomicity:** Saga is eventually consistent. During the saga's execution, other concurrent reads may observe partial state (ORDER_PENDING briefly). ACID atomicity: intermediate state is never visible to any concurrent transaction (in SERIALIZABLE). Saga requires the application to handle "in-flight" states gracefully — UI showing "processing", idempotent compensations, retry handling.

**When 2PC IS the right answer:** when you control both databases, the coordinator is reliable, the data volume is low-throughput, and an occasional stuck prepared transaction is operationally acceptable (internal batch reconciliation, for example).

---

**Q7: Compare ACID vs BASE — what does each stand for, and when would you architect for each?**

**ACID** — Atomicity, Consistency, Isolation, Durability:

- Goal: correctness and consistency of every individual transaction.
- Trade-off: availability and partition tolerance may be sacrificed. Under network partition, the database may refuse writes rather than risk inconsistency.
- Use cases: financial transactions, order management, inventory systems, user accounts, anything where "wrong data" causes business damage.

**BASE** — Basically Available, Soft State, Eventually Consistent:

- Goal: high availability and partition tolerance. The system always responds, but responses may reflect stale or partially-updated data. State converges over time.
- Trade-off: consistency is eventual, not immediate. For a period after a write, different nodes may return different values.
- Use cases: social media timelines, product catalogs, recommendation engines, analytics events, shopping cart (where short-term duplicate or missing item is acceptable), user presence/activity tracking.

**Choosing the model:**

```
Question 1: Can your business tolerate momentarily incorrect data?
  No → ACID
  Yes, for seconds/minutes → BASE acceptable

Question 2: What is the cost of a consistency violation?
  Financial loss, regulatory violation, safety risk → ACID
  Slightly stale product price, like count off by 1, slightly delayed timeline → BASE

Question 3: What is your scale and availability requirement?
  < 100K writes/sec, can tolerate brief unavailability on partition → ACID (PostgreSQL handles this scale)
  > 1M writes/sec, must be available during network partition → BASE (DynamoDB, Cassandra)
```

Most real systems: hybrid. ACID for the core transactional record (orders, payments, users). BASE for derived data (recommendations, analytics, caches, search indexes). Events flow from ACID core outward via CDC (Change Data Capture) to eventually-consistent derived stores.

---

## SECTION 11 — Debugging Exercise

### Production Incident: Financial Ledger Shows Impossible Negative Balance

**Scenario:**
Your finance team reports that the ledger system shows an account balance of -$187,430. The minimum balance business rule is $0 — accounts cannot go negative. The engineering team insists the application checks the balance before every withdrawal. How did this happen?

---

**Step 1: Confirm the database constraint state.**

```sql
-- Check: is there a database-level constraint protecting the balance column?
SELECT conname, consrc, convalidated
FROM pg_constraint
WHERE conrelid = 'accounts'::regclass AND contype = 'c';

-- Output:
-- balance_non_negative | (balance >= 0) | convalidated = FALSE

-- convalidated = FALSE means: this constraint was added with NOT VALID.
-- It checks NEW rows and NEW updates going forward, but DID NOT validate existing data.
-- The constraint does not currently reject rows where balance < 0.
```

**Step 2: Check the migration history.**

```sql
-- Check pg_stat_user_tables for when the constraint was added:
-- (Check release notes or Flyway/Liquibase migration history)

-- Migration 0142 (3 weeks ago):
-- ALTER TABLE accounts ADD CONSTRAINT balance_non_negative CHECK (balance >= 0) NOT VALID;
-- Note: NOT VALID was added because a "quick fix" — wanted zero downtime on a 50M-row table.
-- But VALIDATE CONSTRAINT was never run. The constraint is not actually enforced on updates.
```

**Step 3: Reproduce the insufficient application check.**

Examining application code:

```python
def withdraw(account_id, amount):
    with db.transaction() as conn:  # READ COMMITTED (default)
        acct = conn.execute("SELECT balance FROM accounts WHERE id = %s", [account_id]).fetchone()
        if acct.balance < amount:
            raise InsufficientFundsError("Balance too low")
        conn.execute("UPDATE accounts SET balance = balance - %s WHERE id = %s", [amount, account_id])
```

Under concurrent access:

```
Time    | Transaction A (withdraw $150k)     | Transaction B (withdraw $100k)
--------|-------------------------------------|-------------------------------------
T0      | BEGIN                               | BEGIN
T1      | SELECT balance → $187,430           | SELECT balance → $187,430 (same snap)
T2      | 187430 >= 150000 → OK, proceed      | 187430 >= 100000 → OK, proceed
T3      | UPDATE SET balance = balance−150000  | (waiting... or simultaneous in PG READ COMMITTED)
T4      | COMMIT (balance now $37,430)         |
T5      |                                     | UPDATE SET balance = balance−100000
T6      |                                     | COMMIT (balance now $37,430 − $100,000 = −$62,570)
```

Both transactions read $187,430 before either committed. Both passed the application-level check. Both committed. Classic Read-Before-Update race condition.

**Step 4: Fix — three layers.**

**Layer 1: Fix the constraint (immediate).**

```sql
-- First, identify and fix the negative-balance rows that currently exist:
UPDATE accounts SET balance = 0 WHERE balance < 0;  -- or investigate and correct properly

-- Then validate the constraint (makes it apply to existing rows):
ALTER TABLE accounts VALIDATE CONSTRAINT balance_non_negative;
-- This runs a full table scan to verify no rows violate constraint. Long on large tables; use maintenance window or:
-- Note: VALIDATE CONSTRAINT acquires ShareUpdateExclusiveLock (allows concurrent reads/writes).

-- Now any UPDATE that would produce balance < 0 raises constraint violation immediately.
```

**Layer 2: Fix the application check (use atomic UPDATE).**

```python
def withdraw(account_id, amount):
    with db.transaction() as conn:
        result = conn.execute("""
            UPDATE accounts
            SET balance = balance - %s
            WHERE id = %s AND balance >= %s
            RETURNING balance
        """, [amount, account_id, amount]).fetchone()

        if result is None:
            raise InsufficientFundsError("Insufficient balance")
        return result.balance
# One atomic UPDATE: reads and applies simultaneously. No window for race condition.
```

**Layer 3: Database constraint as final guard (Defense in Depth).**
The VALIDATE CONSTRAINT means the database ITSELF rejects balance < 0, even if application code has a bug. Defense in depth: application + database constraint = two independent guards.

**Outcome:** negative balance prevented at both layers. Migration process updated to always run VALIDATE CONSTRAINT in the next migration after NOT VALID. Constraint audit added to deployment checklist.

---

## SECTION 12 — Architect's Mental Model

```
=== Architect's Mental Model: ACID Properties ===

┌─────────────────────────────────────────────────────────────────┐
│  PHILOSOPHY: ACID properties are a contract with correctness.   │
│  Each property protects a different dimension of data quality.  │
│  Weakening any one: opens the door to a specific class of bugs  │
│  that look like application logic failures but are database      │
│  configuration failures. Know which property each setting        │
│  controls — and which failures follow from weakening it.        │
└─────────────────────────────────────────────────────────────────┘

DECISION RULES:

1. synchronous_commit = on for all financial or user-data tables.
   Off = up to 200ms risk of ACK-but-not-durable on crash.
   For a payment system processing 500 transactions/second:
   200ms window × 500 TPS = up to 100 in-flight transactions can vanish without trace.
   Revenue, compliance, and audit trail: use synchronous_commit = on. Period.
   For event logging, analytics, non-critical events: off is acceptable (and offers ~30% write improvement).

2. Enforce application invariants at BOTH layers: application code AND database constraints.
   NOT NULL, CHECK, UNIQUE, FK constraints: define them all.
   Application checks: fast (avoid round trips), user-friendly error messages, business logic.
   Database constraints: final guard, enforced regardless of application bugs, code paths, or direct DB access.
   "Defense in depth": application checks prevent most violations; DB constraints catch what application misses.

3. Use SERIALIZABLE + retry for financial invariants involving multi-row decisions.
   Write skew (doctors on-call, seats remaining, inventory reservation): cannot be prevented by
   application-level READ COMMITTED checks. SERIALIZABLE (SSI) detects the dependency cycle and
   aborts one transaction. Application must be prepared to retry (begin, re-read, re-decide, re-write).
   Pattern: wrap SERIALIZABLE operations in a retry loop with max 3-5 retries. Serialization failures
   are expected, not errors from the application's perspective.

4. Monitor XID (Transaction ID) age to prevent wraparound.
   PostgreSQL XID is a 32-bit counter. At ~2 billion, it wraps around.
   Wraparound protection: autovacuum_freeze_max_age (default 200M). VACUUM freezes old XIDs.
   If VACUUM can't keep up (long transactions blocking it, massive dead tuple accumulation):
   PostgreSQL will eventually shut down writes to force a manual VACUUM FREEZE.
   Alert threshold: relpages * n_dead_tup > 100M OR age(datfrozenxid) > 1.5 billion.
   pg_database.datfrozenxid: the key metric. Monitor it weekly.

5. Match the isolation level to the specific operation, not globally.
   For each transaction type: ask "what concurrent anomaly am I protecting against?"
   Dirty read risk only → READ COMMITTED (default).
   Need consistent snapshot across multiple queries → REPEATABLE READ.
   Multi-row decisions based on aggregate state → SERIALIZABLE.
   Default to READ COMMITTED globally. Upgrade specific transaction types explicitly per transaction.

COMMON MISTAKES:

1. Treating NOT NULL as the only needed data quality constraint.
   NOT NULL = required field. But a balance column that is NOT NULL and = -$100,000 is perfectly valid
   by NOT NULL alone. Add CHECK (balance >= 0) for the actual business invariant.
   UNIQUE for natural keys. FK for referential integrity. NOT NULL is just the beginning.

2. NOT VALID without VALIDATE CONSTRAINT in the next migration.
   NOT VALID is a valid performance optimization (add constraint without full table scan).
   But a constraint that is NOT VALID is not enforced on existing rows and can create false
   confidence that data is protected. After the NOT VALID addition: always VALIDATE in the
   next deployment window — or during a maintenance window immediately after if data integrity requires it.

3. REPEATABLE READ protects against write skew.
   It does NOT. Repeatable Read prevents your transaction from seeing new committed versions
   of rows it already read. It does NOT prevent write skew — two transactions with non-overlapping
   write sets creating an invalid combined state. Only SERIALIZABLE protection via SSI prevents write skew.
   Teams that implement REPEATABLE READ for financial invariants and expect write skew protection
   will still see violations under concurrent load.

                     ╔══════════════════════════════════╗
  30-SECOND ANSWER → ║  ACID PROPERTIES IN 30 SECONDS   ║
                     ╚══════════════════════════════════╝

"ACID provides four correctness guarantees for database transactions: Atomicity —
all operations in a transaction complete or none do, enforced by WAL rollback on
failure; Consistency — all constraints hold after every transaction, enforced by
the database's constraint system; Isolation — concurrent transactions don't see
each other's incomplete work, enforced by MVCC and optionally by locking, with
degrees ranging from READ COMMITTED to SERIALIZABLE; Durability — committed data
survives crashes, enforced by fsync-ing the WAL before COMMIT returns success.
In production: synchronous_commit = on for financial data, CHECK constraints for
all business invariants, SERIALIZABLE for write-skew-sensitive operations, and
monitor XID age for wraparound risk."
```
