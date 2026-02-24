# Race Conditions — Part 1 of 3

### Sections: 1 (Intuition), 2 (Why It Exists), 3 (Internal Working), 4 (Query Execution Flow)

**Series:** Databases & Data Modeling → Topic 17

---

## SECTION 1 — The Intuition

### Mental Model: Two People Reaching for the Last Seat

```
A race condition occurs when the OUTCOME depends on the timing of concurrent operations.
Both operations make a valid decision based on the state they observed —
but by the time they act, the state has changed due to the other operation.

ANALOGY: Two people buying the last concert ticket.

Ticket counter: 1 seat remaining.

Person A checks: "Is there a seat available?" → YES.
Person B checks: "Is there a seat available?" → YES.
Person A buys the seat (seat count → 0).
Person B buys the seat (seat count → -1). Oversold.

Each person made a valid decision. But between the CHECK and the ACT, the world changed.
The gap between observation and action is where the race condition lives.

IN YOUR DATABASE:
  The same pattern appears as:

  Application read: SELECT seats_remaining FROM shows WHERE id=42  → 1
  ← TIME PASSES. Another user does the same. ←
  Application write: UPDATE shows SET seats_remaining = seats_remaining - 1 WHERE id=42  → 0
  Both writes commit. seats_remaining = -1. Two tickets oversold.

THE THREE-PHASE PATTERN OF A RACE CONDITION:
  1. READ:   observe current state ("there is 1 seat left")
  2. DECIDE: make a decision based on that state ("I can sell this seat")
  3. WRITE:  apply the action ("seat count = 0")

  Race condition: another transaction completes its READ→DECIDE→WRITE
  between your READ and your WRITE.
  Your WRITE is based on stale state.

CATEGORIES OF DATABASE RACE CONDITIONS:

  LOST UPDATE:
    T1 reads value X. T2 reads value X. T1 writes X+1. T2 writes X+1 (not X+2).
    T1's increment is lost. T2 overwrites it.

  WRITE SKEW:
    T1 reads the view (A+B). T2 reads the same view (A+B). T1 updates A. T2 updates B.
    Neither transaction saw the other's write. Combined: they violate an invariant.
    (The on-call doctor example from Topic 16.)

  PHANTOM READ:
    T1 queries rows matching a condition (count of available rooms = 2).
    T2 inserts a new row (reserves 1 room).
    T1 queries again (before commit): now count = 1. T1's logic based on "2 available" is wrong.

  DOUBLE SPEND / DUPLICATE BOOKING:
    T1 and T2 concurrently check if coupon is unused → both see "AVAILABLE" → both claim it.
```

---

## SECTION 2 — Why This Exists: Production Race Condition Incidents

```
INCIDENT 1: Inventory Oversell — 1,400 Items Sold That Didn't Exist

  System: flash sale platform. 500 units of a product available.
  Code:
    inventory = db.execute("SELECT quantity FROM inventory WHERE product_id=$1", pid)
    if inventory.quantity > 0:
        db.execute("UPDATE inventory SET quantity = quantity - 1 WHERE product_id=$1", pid)
        db.execute("INSERT INTO orders (...) VALUES (...)")

  Traffic spike: 50,000 concurrent users hit the flash sale.
  All 50,000: read quantity > 0 simultaneously.
  All 50,000: proceed to decrement and create orders.
  Result: 1,400 orders created. Only 500 items available.
  900 orders: no inventory to fulfill. Customer refunds: $47,000. Reputation damage.

  Fix: atomic conditional update
    UPDATE inventory SET quantity = quantity - 1
    WHERE product_id = $1 AND quantity > 0
    RETURNING quantity;
    -- If returns NULL or 0 rows: inventory exhausted. Reject order.
    -- Database ensures atomicity. No separate read needed. No race window.

INCIDENT 2: Double Vote — Poll Allowed Multiple Responses Per User

  System: voter poll. One vote per user enforced by application.
  Code:
    voted = db.execute("SELECT 1 FROM votes WHERE user_id=$1 AND poll_id=$2")
    if not voted:
        db.execute("INSERT INTO votes (user_id, poll_id, choice) VALUES ($1, $2, $3)")

  Race: user double-clicks submit button. Two requests fire within 20ms.
  Both requests: SELECT → no vote found (neither has committed yet) → both INSERT.
  Result: two votes for same user. Poll results corrupted.

  Fix: UNIQUE constraint + on-conflict
    ALTER TABLE votes ADD CONSTRAINT votes_unique UNIQUE (user_id, poll_id);

    INSERT INTO votes (user_id, poll_id, choice) VALUES ($1, $2, $3)
    ON CONFLICT (user_id, poll_id) DO NOTHING;
    -- UNIQUE constraint: backed by unique B-tree index.
    -- Concurrent inserts: second insert blocks until first commits.
    -- First commits: second sees duplicate → ON CONFLICT → silently discarded.
    -- No application-level read needed. Database handles the race condition.

INCIDENT 3: Balance Underflow — Concurrent Withdrawals Creating Negative Balance

  System: digital wallet. Balance: $100. Two concurrent withdrawal requests for $80 each.
  Code:
    balance = db.execute("SELECT balance FROM wallets WHERE user_id=$1")
    if balance >= withdrawal_amount:
        db.execute("UPDATE wallets SET balance = balance - $2 WHERE user_id=$1", withdrawal_amount)

  T1: SELECT → $100. T2: SELECT → $100.
  T1: $100 >= $80 → proceed. T2: $100 >= $80 → proceed.
  T1: UPDATE balance = $100 - $80 = $20. Commits.
  T2: UPDATE balance = $100 - $80 = $20. Commits. (T2 re-reads $100 from snapshot, not T1's $20.)
  Result: balance = $20. $160 withdrawn from a $100 wallet.

  Fix Option A: SELECT FOR UPDATE
    BEGIN;
    SELECT balance FROM wallets WHERE user_id=$1 FOR UPDATE; -- acquires row lock
    -- T2 blocks here until T1 commits or rolls back.
    -- T1 commits (balance=$20). T2 unblocks. T2's SELECT FOR UPDATE returns $20 (fresh read).
    if balance >= withdrawal: UPDATE ...
    COMMIT;

  Fix Option B: CHECK constraint + atomic update (cleaner)
    ALTER TABLE wallets ADD CONSTRAINT wallet_min_balance CHECK (balance >= 0);
    UPDATE wallets SET balance = balance - $2 WHERE user_id = $1;
    -- If T2's update would create balance < 0: CHECK fires → ERROR. T2 rolls back.
    -- T1 succeeds (balance=$20). T2 fails (balance would be $20-$80=-$60 → CHECK violation).
    -- T2: handle constraint error → return "insufficient funds."

INCIDENT 4: Write Skew — Two Admins Simultaneously Delete "Last" Admin

  System: multi-tenant SaaS. Rule: each account must always have at least one admin.
  Code:
    admins = db.execute("SELECT count(*) FROM users WHERE account_id=$1 AND role='admin'")
    if admins > 1:  # more than just this one admin
        db.execute("UPDATE users SET role='member' WHERE id=$1")

  Account: 2 admins (Alice, Bob). Alice demotes herself. Bob demotes himself. Concurrent.
  T1 (Alice): count admins → 2. Proceed. T2 (Bob): count admins → 2. Proceed.
  T1: UPDATE Alice → member. Commits.
  T2: UPDATE Bob → member. Commits.
  Result: 0 admins on the account. Neither could be managed by any admin. Account locked out.

  Fix: serializable isolation or explicit lock
    BEGIN;
    SELECT count(*) FROM users WHERE account_id=$1 AND role='admin' FOR UPDATE;
    -- Locks all admin rows. T2 cannot read admin rows until T1 commits.
    -- T1 demotes Alice. Commits. admin count = 1.
    -- T2 unblocks. FOR UPDATE re-reads: count = 1. Since count <= 1: cannot demote. Returns error.
    COMMIT;
```

---

## SECTION 3 — Internal Working

### Isolation Levels, Locking, and MVCC as Race Condition Controls

```
MVCC AND THE RACE CONDITION WINDOW:

  MVCC by itself does NOT prevent write-write races.
  MVCC ensures: you read a consistent snapshot.
  But: reading a consistent snapshot of stale data and then writing = race condition.

  Example: T1 reads balance=$100 (snapshots $100). T2 reads balance=$100 (snapshots $100).
  Both are reading their OWN snapshot — no MVCC violation. Both are seeing committed data.
  The race: both DECIDE based on $100, then both WRITE.

  MVCC addresses: dirty reads (reading uncommitted data). → Prevents reading partial state.
  MVCC does NOT address: lost updates (two writes based on same stale read snapshot).
  Locking addresses: write-write conflicts. Explicit row lock or constraint.

SELECT FOR UPDATE — PESSIMISTIC LOCKING:

  Acquires a row-level exclusive lock during the SELECT.
  Other transactions wanting to modify the same row: must WAIT.
  Lock held until current transaction commits or rolls back.

  BEGIN;
  SELECT * FROM seats WHERE id=$1 AND available=TRUE FOR UPDATE;
  -- Row is now locked. No other transaction can update or delete it.
  -- If row not found (seat already booked): no lock acquired. Transaction proceeds to check.
  UPDATE seats SET available=FALSE WHERE id=$1;
  COMMIT;

  Concurrent T2:
  SELECT * FROM seats WHERE id=$1 AND available=TRUE FOR UPDATE;
  → T2 blocks until T1 commits.
  T1 commits (seat now available=FALSE).
  T2 unblocks. Reads seat (FOR UPDATE re-reads committed state). available=FALSE.
  T2: no row returned. Zero rows. Seat already booked. T2 rolls back or handles gracefully.

  LOCK ESCALATION RISK:
    FOR UPDATE on a query returning 10,000 rows: locks 10,000 rows.
    Large lock set: increased chance of deadlock with other concurrent transactions.
    Mitigation: FOR UPDATE with SKIP LOCKED (skip rows already locked, process available ones):
      SELECT * FROM jobs WHERE status='PENDING' FOR UPDATE SKIP LOCKED LIMIT 1;
      Used for: job queues, task distribution. Each worker picks a different row. No contention.

OPTIMISTIC LOCKING — NO DATABASE LOCKS:

  Approach: add a version column to the row. Check it hasn't changed before updating.

  Row: {id, balance, version=5}

  Application read: SELECT id, balance, version FROM accounts WHERE id=$1
  → returns {id=42, balance=$100, version=5}

  Application decides: subtract $80.

  Application write (conditional update):
  UPDATE accounts
  SET balance = balance - 80, version = version + 1
  WHERE id = $1 AND version = 5;  ← check: did anyone else update since we read?
  RETURNING version;

  Case 1: No concurrent update. version is still 5 → UPDATE succeeds → 1 row affected → proceed.
  Case 2: Concurrent update changed version to 6 → WHERE id=$1 AND version=5 matches 0 rows
          → UPDATE affects 0 rows → application detects "0 rows updated" → retry with fresh read.

  No database locks held during "think time." Better throughput for low-conflict scenarios.
  Downside: retry logic required in application. Livelock possible under high contention.
  Best for: update-heavy with LOW conflict probability (most of the time no one else is updating).

SKIP LOCKED — QUEUE PATTERN:

  Classic race: multiple workers racing for the same pending job.
  Worker A: SELECT WHERE status='PENDING' LIMIT 1 → job 42.
  Worker B: SELECT WHERE status='PENDING' LIMIT 1 → job 42 (same, before A commits).
  Both process job 42.

  Fix:
  SELECT id FROM jobs WHERE status='PENDING'
  ORDER BY created_at
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  Worker A: acquires lock on job 42.
  Worker B: SKIP LOCKED → skips job 42 (locked), picks job 43.
  Workers: process different jobs. No duplication. Minimal contention.

ADVISORY LOCKS — APPLICATION-MANAGED LOCKING:

  For logic that spans multiple DB operations or non-DB resources.

  pg_advisory_lock(key): application-chosen integer key.
  Lock acquired: only one session can hold the lock with this key simultaneously.
  Others: WAIT (pg_advisory_lock) or RETURN FALSE (pg_try_advisory_lock).

  Use case: prevent duplicate payment processing.
  pg_advisory_lock(payment_id::int8);  -- serialize all logic for this payment
  → process payment (external API + DB writes)
  pg_advisory_unlock(payment_id::int8);

  Key choice: must be globally unique. Use hash of the logical resource ID.
  Session-level advisory locks: auto-released on session disconnect.
  Transaction-level advisory locks: auto-released on COMMIT/ROLLBACK.

ISOLATION LEVELS AS RACE CONDITION CONTROLS:

  READ COMMITTED:
    Prevents: dirty reads.
    Does NOT prevent: lost updates, non-repeatable reads, phantom reads, write skew.
    Suitable for: most simple reads. NOT for check-then-act patterns.

  REPEATABLE READ:
    Prevents: dirty reads, non-repeatable reads, phantoms (in Postgres with SSI semantics).
    Does NOT prevent: write skew with concurrent writes to DIFFERENT rows.
    Suitable for: financial reports, consistent multi-statement reads.

  SERIALIZABLE:
    Prevents: all race conditions including write skew.
    How: tracks read-write dependencies. Aborts one transaction in a conflict cycle.
    Cost: ~10-20% throughput reduction due to dependency tracking overhead.
    Application: must handle serialization failure codes (40001) with retry.
    Suitable for: inventory management, account management, any check-then-act pattern.
```

---

## SECTION 4 — Query Execution Flow

### Anatomy of a Race Condition and Its Prevention

```
SCENARIO: Flash Sale — Last Concert Ticket

Setup: shows table with seats_remaining = 1. 1,000 concurrent HTTP requests at T=0.

WITHOUT PROTECTION:

Timeline (simplified, T1 and T2 represent any two of the 1,000 requests):

T=0ms: T1 arrives.   SELECT seats_remaining FROM shows WHERE id=42  → 1
T=0ms: T2 arrives.   SELECT seats_remaining FROM shows WHERE id=42  → 1
T=0ms: T3 arrives.   SELECT seats_remaining FROM shows WHERE id=42  → 1
...999 more requests all read seats_remaining = 1...

T=1ms: T1 decides: 1 > 0, proceed.
T=1ms: T2 decides: 1 > 0, proceed.
T=1ms: T3 decides: 1 > 0, proceed.

T=2ms: T1 executes: UPDATE shows SET seats_remaining = seats_remaining - 1 WHERE id=42
       Heap: seats_remaining=0. T1 commits.
T=2ms: T2 executes: UPDATE shows SET seats_remaining = seats_remaining - 1 WHERE id=42
       (In READ COMMITTED: T2's UPDATE sees committed value. seats_remaining is now 0.)
       (seats_remaining = 0 - 1 = -1. No CHECK constraint. Commits.)
T=2ms: T3 ... same → -2. And so on.

Result: seats_remaining = -999. 1,000 orders created. 999 oversold.

WITH PROTECTION (Atomic Conditional Update):

  All 1,000 requests execute:
  UPDATE shows SET seats_remaining = seats_remaining - 1
  WHERE id = 42 AND seats_remaining > 0
  RETURNING seats_remaining, id;

EXECUTION in database:

T=0ms: 1,000 UPDATE statements arrive. Database processes them serially per row.

Step 1: Row lock serialization.
  The first UPDATE to reach the storage layer acquires a row-level lock on shows.id=42.
  All other 999 UPDATEs: blocked, waiting for the row lock.

Step 2: First UPDATE executes.
  Reads heap row: seats_remaining=1. Condition: 1 > 0 → TRUE.
  Writes new heap row: seats_remaining=0. Commits. Lock released.
  RETURNING: returns seats_remaining=0 and id=42. → T1 succeeds.

Step 3: 999 remaining UPDATEs unblock.
  They serialize against each other (next one acquires lock, runs, releases).
  Second UPDATE: reads committed row. seats_remaining=0. Condition: 0 > 0 → FALSE.
  WHERE condition fails. 0 rows updated. No RETURNING row.
  → T2 receives 0 rows updated. Application: "sold out."

  All remaining 998 requests: same. 0 rows updated. "Sold out."

Result: exactly 1 ticket sold. seats_remaining=0. No oversell. No race condition.

DATABASE PROCESSING OF THE CONCURRENT UPDATE WAVE:

- Row locks: serialize access to the SINGLE row being updated. Enforced at storage layer.
- No application-level coordination needed. No Redis lock. No queue.
- Atomic compare-and-update: the WHERE seats_remaining > 0 is evaluated atomically with the UPDATE.
  Between the check and the write: no other transaction can modify that row (row lock held).

EXPLAIN TRACE (simplified):
  EXPLAIN (ANALYZE)
  UPDATE shows SET seats_remaining = seats_remaining - 1
  WHERE id=42 AND seats_remaining > 0;

  -> Update on shows  (cost=0.43..8.45 rows=1)
                       (actual time=0.234..0.235 rows=1 loops=1)  ← 1st request: 1 row updated
     -> Index Scan using shows_pkey on shows  (cost=0.43..8.45 rows=1)
        Index Cond: (id = 42)
        Filter: (seats_remaining > 0)

  For the 2nd-1000th request:
  -> Update on shows  (actual rows=0 loops=1)  ← 0 rows updated = sold out signal
     -> Index Scan ...
        Filter: (seats_remaining > 0)
        Rows Removed by Filter: 1  ← row found but condition was FALSE. Not updated.

MONITORING RACE CONDITIONS IN PRODUCTION:
  -- Detect deadlocks (race condition with mutual blocking):
  SELECT deadlocks FROM pg_stat_database WHERE datname = current_database();

  -- Detect lock waits (high concurrency on same rows):
  SELECT count(*) AS waiting_queries
  FROM pg_stat_activity
  WHERE wait_event_type = 'Lock';

  -- Find which queries are waiting and for how long:
  SELECT pid, query, wait_event, NOW() - query_start AS wait_time
  FROM pg_stat_activity
  WHERE wait_event_type = 'Lock'
  ORDER BY wait_time DESC;

  -- pg_locks: which relation is causing contention:
  SELECT relation::regclass, mode, count(*) AS lock_count
  FROM pg_locks
  WHERE relation IS NOT NULL
  GROUP BY relation, mode
  ORDER BY lock_count DESC;
```
