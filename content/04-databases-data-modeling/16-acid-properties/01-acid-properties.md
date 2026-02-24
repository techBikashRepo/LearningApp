# ACID Properties — Part 1 of 3

### Sections: 1 (Intuition), 2 (Why It Exists), 3 (Internal Working), 4 (Query Execution Flow)

**Series:** Databases & Data Modeling → Topic 16

---

## SECTION 1 — The Intuition

### Mental Model: The Four Safety Guarantees of a Bank Vault

```
ACID is not a single feature. It's four distinct guarantees that work together.
Each property solves a different class of failure. Removing any one breaks data integrity.

THINK OF IT AS FOUR LOCKS ON A BANK VAULT:

  ATOMICITY — "The All-or-Nothing Lock"
    A bank transaction either: fully processes (both debit and credit recorded)
    or completely fails (neither change persists).
    Without it: partial failure mid-transaction → money created or destroyed.
    Real: power failure at the wrong millisecond corrupts financial data.

  CONSISTENCY — "The Business Rules Lock"
    Every transaction transforms the database from one valid state to another valid state.
    Valid = all constraints, rules, and invariants are satisfied.
    Example constraints: account balance cannot go negative (CHECK balance >= 0),
    every order must reference an existing customer (FK constraint),
    total debits = total credits in a double-entry accounting ledger.
    Without it: data can drift into states that violate business logic.

  ISOLATION — "The Concurrency Lock"
    Concurrent transactions don't interfere with each other.
    Each transaction appears to execute as if it's the only one running.
    Without it: "dirty reads" (seeing uncommitted data), "lost updates" (two writes racing),
    "phantom reads" (query results changing mid-transaction).
    Real: two concurrent transfers can create negative balances without isolation.

  DURABILITY — "The Permanence Lock"
    Once a transaction commits, its effects persist permanently.
    A server crash, power failure, or hardware failure immediately after COMMIT
    does not lose the committed data.
    Without it: successful payment confirmation followed by data loss on crash.
    Customer charged, no record, no fulfillment. Catastrophic.

THE ACID PROMISE:
  Any committed transaction: all four properties guaranteed simultaneously.
  "I received a COMMIT acknowledgment" = "these changes are permanent, valid, isolated, and complete."
  This is the fundamental contract between the database and every application that uses it.
```

---

## SECTION 2 — Why This Exists: Real Failures From Violating Each Property

```
ATOMICITY VIOLATION — The Partial Transfer

  Pre-database era: batch file processing.
  Step 1: write to account A file. Step 2: write to account B file.
  OS crash between step 1 and step 2: A updated, B not. Money destroyed.

  Modern equivalent (no transaction):
    connection.execute("UPDATE account SET balance = balance - 500 WHERE id = A")
    # timeout / crash here
    connection.execute("UPDATE account SET balance = balance + 500 WHERE id = B")  # never runs

  Without atomicity: A loses $500. B never gains $500. $500 evaporates.
  Volume at scale: financial platform with 10K transfers/hour, even 0.001% partial failure rate
  = 10 incidents/hour. Each requires manual reconciliation. Regulatory reporting nightmare.

CONSISTENCY VIOLATION — Negative Balance Without a CHECK Constraint

  WITHOUT CHECK(balance >= 0):
  T1: read Alice's balance = $100.
  T2: read Alice's balance = $100 (concurrent).
  T1: deduct $80. Balance = $20. Commit.
  T2: deduct $80. Balance = $20 (calculated from stale $100 read). Commit.

  Alice: $100 → both deductions committed → actual balance should be -$60 but shows $20.
  (This is also an isolation violation. Consistency + isolation failures often co-occur.)

  With CHECK(balance >= 0) + SERIALIZABLE isolation:
  T2's deduction would either be blocked (isolated) or raise a constraint violation.
  The constraint provides the last line of defense even if isolation is imperfect.

ISOLATION VIOLATION — The Dirty Read

  READ UNCOMMITTED would allow:
  T1: BEGIN; UPDATE orders SET status = 'SHIPPED' WHERE id = 42;
      (T1 hasn't committed yet)
  T2: SELECT status FROM orders WHERE id = 42;
      → returns 'SHIPPED' (dirty read of uncommitted data)
  T1: ROLLBACK; (something failed)
      → status reverted to 'PENDING'
  T2: already sent "your order shipped!" email to customer.

  Result: email sent for a shipment that never happened. Support tickets. Customer confusion.

  PostgreSQL: does not implement READ UNCOMMITTED. Minimum = READ COMMITTED.
  Even READ COMMITTED: prevents dirty reads. Transactions only see committed data.

ISOLATION VIOLATION — Lost Update (No Isolation, Concurrent Writes)

  Two concurrent sessions editing the same configuration record.
  T1: SELECT config FROM apps WHERE id=1 → {theme: 'dark', lang: 'en'}
  T2: SELECT config FROM apps WHERE id=1 → {theme: 'dark', lang: 'en'}
  T1: UPDATE apps SET config = {theme: 'light', lang: 'en'} WHERE id=1  → commits
  T2: UPDATE apps SET config = {theme: 'dark', lang: 'fr'}  WHERE id=1  → commits

  T2 didn't know about T1's change. T2's write overwrites T1's.
  Result: theme change (T1) is LOST. Only T2's lang change survived.

  Fix: Optimistic Locking (version column) or SELECT FOR UPDATE (pessimistic).

DURABILITY VIOLATION — The Unacknowledged Write

  fsync disabled (synchronous_commit = off in Postgres):
  Commits return immediately without waiting for WAL fsync.
  Throughput: doubles or triples. Latency: much lower.

  Power failure between COMMIT acknowledgment and WAL disk write:
  Last few seconds of committed transactions: LOST.
  Database restarts to a point-in-time before those commits.

  For some use cases acceptable: session data, analytics counters, recommendation caches.
  For financial data: NEVER. The COMMIT acknowledgment is the contract.

  Postgres setting:  synchronous_commit = on (default) — fsync WAL before ack.
  MySQL InnoDB: innodb_flush_log_at_trx_commit = 1 (flush on each commit) — full durability.
```

---

## SECTION 3 — Internal Working

### How Each ACID Property Is Implemented in PostgreSQL

```
ATOMICITY IMPLEMENTATION:

  Transaction XID (Transaction ID): integer counter. Each transaction gets a unique XID.
  pg_xact directory: tracks the state of every XID as one of: IN PROGRESS, COMMITTED, ABORTED.

  During transaction: all writes tagged with xmin = current XID (IN PROGRESS).
  At COMMIT: XID state in pg_xact → COMMITTED. Atomic bit flip.
  At ROLLBACK: XID state → ABORTED.

  MVCC enforces atomicity for readers:
    Row with xmin = XID and XID = IN PROGRESS → row invisible to other transactions.
    Row with xmin = XID and XID = ABORTED → row permanently invisible to all.
    No partial state ever visible to external transactions.

  Savepoints: nested atomicity within a transaction.
    SAVEPOINT s1;
    UPDATE accounts SET balance = balance - 300 WHERE id = 'alice';  -- succeeds
    SAVEPOINT s2;
    UPDATE accounts SET balance = balance + 300 WHERE id = 'bob';    -- fails
    ROLLBACK TO SAVEPOINT s2;                                         -- undo only since s2
    -- Can still retry bob's update or do something else
    UPDATE accounts SET balance = balance + 300 WHERE id = 'charlie'; -- try charlie instead
    COMMIT;
    -- alice's deduction committed; charlie receives, bob wasn't touched.

CONSISTENCY IMPLEMENTATION:

  Consistency = constraints enforced at commit time.
  NOT NULL, UNIQUE, CHECK: enforced per-statement (IMMEDIATE default).
  FOREIGN KEY: enforced per-statement or at COMMIT (if DEFERRED).
  Application-defined invariants: must be encoded as constraints or enforced in application.

  "Consistency" in ACID is partly the database's job (constraints) and partly the application's.
  The DB guarantees: no committed row violates a declared constraint.
  The application guarantees: business rules beyond what constraints can express.

  Example the DB can enforce:
    CHECK (balance >= 0) → atomically enforced on every UPDATE. Database catches violations.
  Example the DB CANNOT enforce automatically:
    "total debits must equal total credits in a double-entry ledger across all accounts"
    → requires an application-level assertion or a deferred constraint across many rows.

ISOLATION IMPLEMENTATION (MVCC):

  READ COMMITTED (default):
    Each SQL statement gets a fresh snapshot of committed data.
    Sees commits that happened between statements (but not within a statement).

    Anomalies allowed: non-repeatable reads, phantom reads.
    Two SELECTs in the same transaction: may see different data if a COMMIT happens between them.
    Acceptable for: most web application reads. Not acceptable for: financial reporting, inventory checks.

  REPEATABLE READ (Snapshot Isolation):
    Snapshot taken once at BEGIN. All statements use the same snapshot.
    Concurrent COMMITs: invisible for the duration of the transaction.

    Anomalies prevented: dirty reads, non-repeatable reads, phantom reads.
    Anomaly still possible: WRITE SKEW.

    Write skew example:
      Rule: at least one doctor must be on-call at all times.
      Doctor A: SELECT count → 2 on-call. Decides to take sick day. UPDATE → 1 on-call. Commits.
      Doctor B (concurrent): SELECT count → 2 on-call. Decides to take sick day. UPDATE → 1 on-call. Commits.
      Result: 0 doctors on-call. Neither saw the other's update (snapshot isolation).
      Both committed. Business rule violated despite REPEATABLE READ.

  SERIALIZABLE (SSI):
    PostgreSQL's Serializable Snapshot Isolation detects dangerous read-write dependencies.
    Creates a dependency graph of concurrent transactions.
    If a cycle is detected (T1 reads what T2 wrote, T2 reads what T1 wrote): abort one.
    Application must retry the aborted transaction.

    Write skew above: SSI detects the concurrent read-write conflict. Aborts one doctor's transaction.
    That doctor's transaction: retried. Sees 1 on-call (the first doctor already called in sick).
    Second doctor can't also call in sick (would leave 0). Returns error / prevents action.

DURABILITY IMPLEMENTATION:

  WAL (Write-Ahead Log):
    Before any heap page is modified: the change is written to the WAL.
    Before COMMIT returns: WAL records are flushed to durable storage (fsync).

    fsync path:
      WAL buffer (in RAM) → WAL file (on disk). fsync() confirms OS buffer written to physical storage.

    Crash recovery:
      On restart: PostgreSQL reads from the last checkpoint.
      Checkpoint: periodic event where all dirty shared_buffers pages are flushed to disk,
      and a checkpoint WAL record is written.
      Recovery: replay all WAL records after the checkpoint.
      Committed XIDs: their heap changes are re-applied.
      In-progress XIDs: their changes are skipped (MVCC treats them as aborted).

    Aurora difference:
      Aurora: WAL (redo log) is the database. The log is replicated to all 6 AZ copies.
      Quorum write: 4 of 6 copies confirm WAL receipt → COMMIT returns.
      Heap pages: not sent over the network. Reconstructed from the log at each storage node.
      Result: write I/O cut dramatically. Only WAL written over network. Faster commits.
```

---

## SECTION 4 — Query Execution Flow

### ACID in Action: Concurrent Transfers With Full Transaction Trace

```
SCENARIO: Alice transfers $300 to Bob. Charlie transfers $200 to Alice. Both concurrent.

T1: Alice → Bob ($300)          T2: Charlie → Alice ($200)
---                             ---
BEGIN;                          BEGIN;
                                UPDATE accounts SET balance = balance - 200 WHERE id = 'charlie';
UPDATE accounts ...alice - 300;
                                UPDATE accounts SET balance = balance + 200 WHERE id = 'alice';
UPDATE accounts ...bob + 300;
COMMIT;
                                COMMIT;

INITIAL STATE: Alice=$1000, Bob=$500, Charlie=$800.
EXPECTED FINAL: Alice=$900 (−300+200), Bob=$800 (+300), Charlie=$600 (−200).

ATOMICITY CHECK:
  If T1 crashes between Alice's debit and Bob's credit:
    Alice's row: new version xmin=T1, xmax=NULL. T1 XID: ABORTED.
    Bob's row: was never updated.
    On crash recovery: T1 aborted → Alice's new row version invisible → old version survives.
    Alice: $1000 (unchanged). Bob: $500 (unchanged). Atomicity preserved.

ISOLATION CHECK (READ COMMITTED):
  T2 reads Alice's balance during T1's execution (after T1 debited but not yet committed):
    T1's new Alice row: xmin=T1_XID, T1 = IN PROGRESS → invisible to T2.
    T2 reads: old Alice row = $1000.
    T2: credits Alice $200 based on $1000 → new row value: $1200.
    T1 commits. Alice has two new committed row versions: $700 (T1) and $1200 (T2).

    BUT WAIT: real Postgres behavior:
    When T2 tries to UPDATE Alice's row, it must acquire a row-level lock.
    T1 already holds a row-level lock on Alice's row.
    T2's UPDATE: blocked until T1 commits.
    T1 commits: Alice = $700. T2 unblocks.
    T2: re-reads Alice's row (READ COMMITTED re-evaluates predicate). Sees $700.
    T2: $700 + $200 = $900. Commits.

    Final: Alice=$900, Bob=$800, Charlie=$600. Correct.

CONSISTENCY CHECK:
  If we have CHECK(balance >= 0) on accounts:
  Suppose Charlie only has $100 (not $800). T2 tries to debit $200.
  UPDATE accounts SET balance = balance - 200 WHERE id = 'charlie';
  New balance: $100 - $200 = -$100.
  CHECK(balance >= 0) → FAILS. ERROR: new row for relation "accounts" violates check constraint.
  T2: ROLLBACK. Charlie's balance: unchanged ($100).
  Consistency preserved.

DURABILITY CHECK:
  T1 COMMITS. Client receives: "Commit successful."
  Server crashes (power failure) 50ms after COMMIT.
  WAL: Alice's and Bob's updates written and fsync'd before COMMIT returned.

  On restart:
    Last checkpoint: from 30 seconds ago.
    WAL replay: from checkpoint LSN to end of WAL file.
    T1's records found in WAL: XID committed. Alice=$700, Bob=$800 replayed onto heap.
    T2's records found in WAL: if committed before crash, replayed. If in-progress: skipped.
    Database reaches consistent state: all committed transactions preserved.

MONITORING ACID COMPLIANCE:
  -- Check for long-running transactions (ACID blocker — holding snapshots and locks):
  SELECT pid, xact_start, NOW() - xact_start AS age, state, query
  FROM pg_stat_activity
  WHERE xact_start IS NOT NULL
    AND NOW() - xact_start > INTERVAL '5 minutes'
  ORDER BY age DESC;

  -- Check for serialization failures (application needs to retry):
  SELECT * FROM pg_stat_database WHERE datname = current_database();
  -- Column: deadlocks → high value = locking anti-patterns.
  -- Column: temp_files, temp_bytes → sorts/hash joins spilling to disk (work_mem too low).

  -- Check for uncommitted old transactions (potential wraparound risk):
  SELECT pid, backend_xid, backend_xmin, age(backend_xid)
  FROM pg_stat_activity
  WHERE backend_xid IS NOT NULL
  ORDER BY age(backend_xid) DESC;
  -- XIDs age toward wraparound (2B XIDs). Old transactions: prevent VACUUM from cleaning old tuples.
```
