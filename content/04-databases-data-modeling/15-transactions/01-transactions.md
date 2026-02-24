# Transactions — Part 1 of 3

### Sections: 1 (Intuition), 2 (Why It Exists), 3 (Internal Working), 4 (Query Execution Flow)

**Series:** Databases & Data Modeling → Topic 15

---

## SECTION 1 — The Intuition

### Mental Model: The Bank Transfer

```
A transaction is a unit of work that either completes entirely or does nothing.
No partial completions. No half-writes. All-or-nothing is the guarantee.

THE CLASSIC EXAMPLE: Bank transfer

  Alice has $1,000. Bob has $500.
  Transfer $300 from Alice to Bob.

  This operation requires TWO writes:
    1. Deduct $300 from Alice's account → Alice: $700
    2. Add $300 to Bob's account        → Bob: $800

  WITHOUT TRANSACTIONS (what could go wrong):
    Step 1 completes: Alice now has $700.
    Power failure / server crash / network timeout BETWEEN step 1 and step 2.
    Alice: $700 (lost $300). Bob: $500 (didn't receive $300).
    $300 has vanished from the system. Financial catastrophe.

  WITH TRANSACTIONS:
    BEGIN;
    UPDATE accounts SET balance = balance - 300 WHERE user_id = 'Alice';
    UPDATE accounts SET balance = balance + 300 WHERE user_id = 'Bob';
    COMMIT;

    If anything fails between BEGIN and COMMIT: ROLLBACK automatically.
    Both updates: either both happen (committed) or neither happens (rolled back).
    Database returns to its pre-transaction state. Alice: $1,000. Bob: $500. Safe.

THE THREE KEY GUARANTEES OF TRANSACTIONS:

  ATOMICITY: all-or-nothing. Either every statement in the transaction commits,
  or upon any failure, all statements are rolled back. No partial state persists.

  ISOLATION: concurrent transactions don't see each other's in-progress changes.
  Alice's transfer is invisible to a concurrent query until COMMIT.
  Other transactions see either the pre-transfer state OR the committed result.
  Never a half-transferred state (Alice: $700, Bob: $500).

  DURABILITY: once COMMIT returns, the data is saved. Even if the server crashes
  the next millisecond, the committed transaction persists on restart.
  Achieved via the Write-Ahead Log (WAL) — changes written to disk BEFORE commit returns.

(These three plus Consistency = ACID. Consistency is discussed in Topic 16.)
```

---

## SECTION 2 — Why This Exists: Production Failures Without Transactions

```
INCIDENT 1: Double-Charge After Partial Failure

  System: e-commerce payment processing.
  Flow (no transaction):
    1. Deduct items from inventory.
    2. Charge customer's credit card via Stripe.
    3. Insert order record into orders table.

  Failure mode: Stripe charge succeeds (step 2), but orders table INSERT fails (step 3)
  due to a FK constraint violation (product_id no longer exists).

  Result: Customer charged. No order record. No fulfillment. Support ticket.
  Recovery: manual. Match Stripe charge to incomplete order. Issue refund or fix manually.
  Volume: 14 incidents per week at peak traffic. 2 full-time support staff occupied.

  Fix: wrap all three operations in a single transaction.
  BEGIN;
    UPDATE inventory SET quantity = quantity - 1 WHERE product_id = $pid;
    -- (external Stripe call happens outside transaction — see section 3 for this pattern)
    INSERT INTO orders (customer_id, product_id, stripe_charge_id, ...) VALUES (...);
  COMMIT;

  External API calls (Stripe) cannot be inside a transaction (they're not transactional).
  Correct pattern: execute the DB operations transactionally. Stripe call: idempotent with
  idempotency key. Reconciliation job: find charges without matching orders → auto-refund.

INCIDENT 2: Duplicate Coupon Redemption Race Condition

  System: promo/coupon platform.
  Code (pseudocode):
    coupon = db.query("SELECT * FROM coupons WHERE code = $1 AND used = FALSE")
    if coupon:
        db.execute("UPDATE coupons SET used = TRUE WHERE id = $1", coupon.id)
        db.execute("INSERT INTO orders (coupon_id, ...) VALUES (...)")

  Race condition: two concurrent requests with the same coupon code both check "used = FALSE"
  simultaneously. Both see FALSE. Both proceed. Both mark used = TRUE (second overwrites first
  or both succeed due to no lock). Both create an order with the coupon.

  Coupon redeemed twice. Free order given twice. $50 loss per incident.
  At 100K concurrent users: dozens of duplicate redemptions per day.

  Fix: SELECT ... FOR UPDATE inside a transaction.
  BEGIN;
    SELECT * FROM coupons WHERE code = $1 AND used = FALSE FOR UPDATE;
    -- This acquires a row-level lock. Second concurrent request: blocks here.
    -- Cannot proceed until the first transaction commits.
    UPDATE coupons SET used = TRUE WHERE id = $1;
    INSERT INTO orders (...);
  COMMIT;
  -- Second request's FOR UPDATE now unblocks. Sees used = TRUE. Returns "coupon already used."

INCIDENT 3: Report Inconsistency from Reading During a Long Write

  System: financial reporting. One transaction aggregates $1.2M of transactions.
  Simultaneously: a large batch import is adding 250K new transactions.

  Without isolation: the report reads some rows before the import, some after.
  Report total: $1.2M + partial new batch = inconsistent figure. Neither old nor new.

  With proper isolation (REPEATABLE READ or SNAPSHOT ISOLATION):
  The report transaction takes a snapshot at its BEGIN time.
  It reads ONLY rows committed before that snapshot. The batch import: invisible.
  Report: consistent view as of its start time. Accurate at a point in time.
```

---

## SECTION 3 — Internal Working

### WAL, Lock Manager, and MVCC: the Three Engines of Transactions

```
ENGINE 1: WRITE-AHEAD LOG (WAL)

  Durability mechanism. Every change is written to the WAL before the heap page is modified.

  WAL anatomy:
    WAL file: sequential log on disk. Each entry: LSN (Log Sequence Number), transaction XID,
    operation type (INSERT/UPDATE/DELETE), before/after page data.

  Transaction COMMIT procedure:
    1. All dirty (modified) pages: held in shared_buffers (memory). Not yet on disk.
    2. WAL records for all changes: written to WAL buffer (in memory).
    3. At COMMIT: fsync() on WAL buffer → WAL records on durable storage.
    4. COMMIT returns to client. "Your data is safe."
    5. Heap pages (in shared_buffers): flushed to disk asynchronously by the background writer.
    6. Checkpoint: periodically ensures all in-memory pages are written to disk.

  Crash recovery:
    Server restarts. WAL replay: reads WAL from last checkpoint forward.
    Redoes all committed transactions whose heap pages weren't yet flushed.
    Undoes all in-progress transactions that hadn't yet committed.
    Database reaches consistent state exactly matching the last committed transaction.

  WAL I/O is sequential: much faster than random heap writes.
  This is why: a committed transaction with 100 random heap page writes can commit in <1ms.
  The WAL write: sequential. The heap writes: deferred and batched.

ENGINE 2: LOCK MANAGER

  Controls concurrent access to shared resources.

  Lock granularity (coarsest to finest):
    Table-level: ACCESS SHARE (SELECT), ROW EXCLUSIVE (INSERT/UPDATE/DELETE), ACCESS EXCLUSIVE (DDL)
    Row-level: FOR SHARE, FOR NO KEY UPDATE, FOR UPDATE, FOR KEY SHARE
    Advisory: application-defined locks (pg_advisory_lock)

  ROW-LEVEL LOCK TYPES:
    FOR UPDATE: exclusive. Blocks other writers and FOR UPDATE readers.
      Use: "I'm about to modify this row. No concurrent modification allowed."
    FOR NO KEY UPDATE: exclusive for non-PK updates.
      Use: UPDATE non-PK columns. Allows FK reference reads by other transactions.
    FOR SHARE: shared. Allows other FOR SHARE readers. Blocks writers.
      Use: "I need this row to stay stable (FK check). Don't delete it."
    FOR KEY SHARE: weakest. Allows most concurrent operations except DELETE/update-PK.
      Use: FK lookups when inserting into child tables.

  DEADLOCK:
    T1: locks row A, then waits for row B.
    T2: locks row B, then waits for row A.
    PostgreSQL: detects cycle. Kills one transaction. Returns ERROR 40P01 deadlock detected.
    Prevention: always acquire locks in deterministic order (e.g., always lock lower ID first).
    Don't hold locks across user-facing wait operations (like user confirmation prompts).

ENGINE 3: MVCC (Multi-Version Concurrency Control)

  Readers and writers don't block each other. Each sees a consistent snapshot.

  Each row has:
    xmin: XID (transaction ID) of the transaction that created this row version.
    xmax: XID of the transaction that deleted or updated this row version. NULL if still live.

  Snapshot: at transaction BEGIN (or first query), a snapshot is taken:
    {current_xid, xmin (oldest active XID), list of active XIDs, xmax (next unassigned XID)}

  Visibility rule for each row a query encounters:
    Row is visible if:
      xmin < snapshot.xmin (created by an old, committed transaction) AND
      (xmax IS NULL OR xmax > snapshot.xmax OR xmax IS IN active_xids)

    In English: the row was created by a committed transaction before this snapshot,
    AND it hasn't been deleted (yet) by a committed transaction.

  PRACTICAL IMPLICATION:
    T1 starts UPDATE on row 42 (creates new version, marks old version xmax = T1.xid).
    T2 runs SELECT on row 42 CONCURRENTLY.
    T2 sees: old version (xmax = T1.xid, T1 still in progress → not committed → old version visible).
    T2 returns the pre-update value of row 42. No blocking. No inconsistency.

    T1 COMMITS. Now T1.xid is committed.
    T3 starts SELECT on row 42.
    T3 sees: new version (xmin = T1.xid, T1 committed → new version visible).
    T3 returns the post-update value.

  DEAD TUPLE ACCUMULATION:
    MVCC creates old row versions that persist until VACUUM runs.
    High UPDATE rate: many dead tuples → table bloat → slower SeqScans (more pages).
    Autovacuum: removes dead tuples, updates visibility map, updates statistics.
    Thrashing: if UPDATE rate >> autovacuum rate → growing bloat → degrading performance.
    Fix: tune autovacuum_vacuum_scale_factor (trigger earlier), or manual VACUUM ANALYZE.

TRANSACTION ISOLATION LEVELS:
  READ UNCOMMITTED: (doesn't exist in Postgres — treated as READ COMMITTED)

  READ COMMITTED (default in Postgres):
    Each statement in the transaction takes a fresh snapshot.
    A query can see commits that happened AFTER the transaction started (if before the query).
    Non-repeatable reads: two SELECT statements in same transaction may see different data.
    Phantom reads: new rows inserted by concurrent transactions may appear mid-transaction.

  REPEATABLE READ (snapshot isolation in Postgres):
    Single snapshot taken at BEGIN. Same snapshot used for all statements.
    Concurrent commits invisible during the transaction. Consistent view throughout.
    Serialization anomalies: still possible (write skew).

  SERIALIZABLE:
    Strongest guarantee. Equivalent to running transactions one-at-a-time (serial order).
    Postgres SSI (Serializable Snapshot Isolation): detects and aborts transactions that
    would cause read-write conflicts leading to non-serial results.
    Application must retry aborted transactions.
    Use for: financial precision (bank transfers where balance must be checked + updated atomically).
```

---

## SECTION 4 — Query Execution Flow

### Transaction Lifecycle: BEGIN to COMMIT

```
TRANSACTION: Transfer $300 from Alice to Bob.
BEGIN;
UPDATE accounts SET balance = balance - 300 WHERE id = 'alice';
UPDATE accounts SET balance = balance + 300 WHERE id = 'bob';
COMMIT;

STEP 1: BEGIN
  Backend assigns a new transaction ID (XID): e.g., XID = 87,234.
  Snapshot taken (for READ COMMITTED: refreshed per statement).
  No locks acquired yet. No WAL written yet.
  Transaction state: IN PROGRESS (in pg_proc, visible as active in pg_stat_activity).

STEP 2: FIRST UPDATE — UPDATE accounts SET balance = balance - 300 WHERE id = 'alice'

  2a. Read current row for id='alice':
    B-tree index on id → heap TID → read heap page.
    MVCC: check xmin/xmax. Row visible. Current value: balance=1000.

  2b. Acquire row-level lock (FOR NO KEY UPDATE) on Alice's row:
    Lock manager: row not locked by anyone else → lock granted for XID 87,234.

  2c. Compute new value: 1000 - 300 = 700.

  2d. Write new row version to heap (same page if space available — HOT update):
    New tuple: balance=700, xmin=87234, xmax=NULL.
    Old tuple: balance=1000, xmin=<original>, xmax=87234 (marked as deleted by our transaction).

  2e. Write WAL record:
    WAL entry: {XID=87234, type=UPDATE, table=accounts, page=X, slot=Y, new_balance=700}
    Written to WAL buffer (not yet flushed to disk — that happens at COMMIT).

STEP 3: SECOND UPDATE — UPDATE accounts SET balance = balance + 300 WHERE id = 'bob'

  Same mechanics. Bob's row: balance=500 → new tuple balance=800, xmin=87234, xmax=NULL.
  WAL entry: {XID=87234, type=UPDATE, table=accounts, page=Z, slot=W, new_balance=800}

STEP 4: COMMIT
  4a. WAL FLUSH:
    All WAL records for XID 87234: written from WAL buffer to WAL file on disk.
    fsync() called. WAL records are durable (survive crash).
    Transaction XID 87234 marked as COMMITTED in the pg_xact (transaction status) file.

  4b. Lock release:
    Row-level locks on Alice's and Bob's rows: released.
    Any transactions that were waiting on these locks: unblocked.

  4c. COMMIT returns to client: "Data saved."

  Heap pages: still dirty in shared_buffers. NOT yet on disk.
  If server crashes NOW: crash recovery reads WAL, sees XID 87234 committed,
  replays the heap writes from WAL records. Both rows correctly updated on restart.

STEP 5: WHAT ANOTHER CONCURRENT TRANSACTION SEES

  T2 starts at the same time as T1.
  T2: SELECT balance FROM accounts WHERE id = 'alice';

  During T1's execution (before COMMIT):
    T2 reads Alice's row. Sees old version (xmax = 87234, but 87234 is in-progress → NOT committed).
    T2 returns: balance = 1000. (The snapshot shows the pre-transfer state.)

  After T1 COMMIT:
    T2 starts a new statement (READ COMMITTED: new snapshot per statement).
    T2 reads Alice's row. Old version: xmax=87234, now COMMITTED → old version is DEAD.
    New version: xmin=87234, COMMITTED → visible.
    T2 returns: balance = 700. (Post-transfer state.)

STEP 6: ROLLBACK PATH (if something went wrong)
  BEGIN;
  UPDATE accounts SET balance = balance - 300 WHERE id = 'alice'; ← succeeds
  UPDATE accounts SET balance = balance + 300 WHERE id = 'bob';   ← ERROR (bob doesn't exist)
  → ROLLBACK automatically triggered.

  Rollback process:
    Alice's new row version: set xmax = 87234. XID 87234 marked as ABORTED in pg_xact.
    No WAL flush for the data changes (WAL might have partial records but they're marked aborted).
    Any future query checking Alice's row: xmax=87234, XID 87234 = ABORTED → new version invisible.
    Old version (balance=1000): xmax was set to 87234 (aborted) → old version still valid. Visible.
    Alice's balance: back to 1000. Bob's row: never modified. Clean state.

MONITORING ACTIVE TRANSACTIONS:
  -- Long-running transactions (potential for lock hoarding):
  SELECT pid, usename, application_name, state, query_start, xact_start,
         NOW() - xact_start AS duration, query
  FROM pg_stat_activity
  WHERE xact_start IS NOT NULL
    AND state != 'idle'
  ORDER BY duration DESC;

  -- Transactions holding locks:
  SELECT locktype, relation::regclass, mode, granted, pid, query
  FROM pg_locks l
  JOIN pg_stat_activity a ON l.pid = a.pid
  WHERE NOT granted  -- show waiting transactions
  ORDER BY a.query_start;
```
