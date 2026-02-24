# Race Conditions — Part 2 of 3

### Sections: 5 (Bad vs Correct), 6 (Performance Impact), 7 (Concurrency & Data Integrity), 8 (Optimization & Indexing)

**Series:** Databases & Data Modeling → Topic 17

---

## SECTION 5 — Bad Usage vs Correct Usage

### Pattern 1: Check-Then-Insert Without Locking (Duplicate Insert Race)

```sql
-- BAD: application checks for existence, then inserts (race window)
-- Python:
exists = db.execute("SELECT 1 FROM subscriptions WHERE user_id=$1 AND plan_id=$2", uid, pid)
if not exists:
    db.execute("INSERT INTO subscriptions (user_id, plan_id) VALUES ($1, $2)", uid, pid)
-- Race: two concurrent requests both execute SELECT → both see no row → both INSERT.
-- Result: two identical subscription rows. Customer double-billed.

-- CORRECT: single atomic INSERT with ON CONFLICT
INSERT INTO subscriptions (user_id, plan_id, created_at)
VALUES ($1, $2, NOW())
ON CONFLICT (user_id, plan_id) DO NOTHING;
-- Requires: UNIQUE (user_id, plan_id) constraint.
-- Atomic: no separate SELECT. No race window. Exactly one row. Always.
-- Pattern: do not check in application code → insert in DB. Let constraint enforce.
```

### Pattern 2: Non-Atomic Read-Modify-Write (Lost Update)

```python
# BAD: read-modify-write in application code (two database round trips)
row = db.execute("SELECT quantity FROM inventory WHERE product_id=$1", pid)
new_qty = row.quantity - 1
if new_qty >= 0:
    db.execute("UPDATE inventory SET quantity=$1 WHERE product_id=$2", new_qty, pid)
# Race: 1,000 concurrent requests all read quantity=500. All compute 499. All UPDATE to 499.
# Result: quantity = 499 after 1,000 "reserved" units. Sold 999 extra items.

# CORRECT option A: atomic conditional UPDATE in one SQL statement
updated = db.execute("""
    UPDATE inventory
    SET quantity = quantity - 1
    WHERE product_id = $1 AND quantity > 0
    RETURNING quantity
""", pid)
# If no rows returned (RETURNING returns nothing): quantity was already 0 → sold out.
# Atomic: the decrement and the check happen inside the DB engine, under row lock.
# 1,000 concurrent: each acquires row lock in turn. Each gets current committed value.
# Result: quantity decrements exactly 1,000 times, then stops at 0. Correct.

# CORRECT option B: SELECT FOR UPDATE with explicit lock
with db.transaction():
    row = db.execute("SELECT quantity FROM inventory WHERE product_id=$1 FOR UPDATE", pid)
    if row.quantity > 0:
        db.execute("UPDATE inventory SET quantity=quantity-1 WHERE product_id=$1", pid)
    # else: handle sold-out
# SELECT FOR UPDATE: acquires row lock. Other transactions wait.
# After COMMIT: row lock released. Next transaction gets updated value.
# Slower than option A (explicit lock + extra round trip). Use option A when possible.
```

### Pattern 3: Redis Lock Without Database Transaction (Non-Atomic)

```python
# BAD: using Redis as a distributed lock but updating database outside its protection
redis.set("lock:order:12345", "worker-1", nx=True, ex=10)  # acquire lock

row = db.execute("SELECT * FROM orders WHERE id=12345")
# ... process order ...
db.execute("UPDATE orders SET status='PROCESSED' WHERE id=12345")

redis.delete("lock:order:12345")  # release lock
# PROBLEM 1: Redis lock expires (10s) before the processing completes → lock released early.
#            Another worker acquires lock → two workers process same order.
# PROBLEM 2: Worker crashes between Redis lock acquisition and DB COMMIT.
#            Lock expires. Another worker processes. But Redis and DB state are now inconsistent.
# PROBLEM 3: Redis replication lag → lock acquired on primary, primary fails, replica does not
#            have the lock entry → another worker acquires "same" lock on new primary.

# CORRECT: use database-level locking for database operations.
with db.transaction():
    row = db.execute("SELECT * FROM orders WHERE id=12345 FOR UPDATE SKIP LOCKED")
    # If row is None: another worker already took it. Return immediately.
    if not row:
        return
    # Process order (within the transaction):
    db.execute("UPDATE orders SET status='PROCESSING' WHERE id=12345")
# COMMIT: releases row lock. All-or-nothing.
# No Redis needed. DB lock is the coordination mechanism.
# FOR UPDATE SKIP LOCKED: if locked by another worker, skip to next available order.
# Atomic, durable, contained in one transaction.
```

### Pattern 4: Write Skew — Two Transactions Reading Shared State, Writing Different Rows

```sql
-- SCENARIO: conference room booking. Only one booking per room per time slot.
-- T1: Bob books Room A from 2-3pm.
-- T2: Alice checks if Room A is free from 2-3pm (sees: free) → books it.
-- T1: checks Room A 2-3pm (sees: free) → books it.
-- Both check, both see free. Both insert. Result: Room A double-booked.

-- BAD: READ COMMITTED with application-level uniqueness check
-- T1:
count = db.execute("SELECT COUNT(*) FROM bookings WHERE room='A' AND slot='14:00'")
if count == 0:
    db.execute("INSERT INTO bookings (room, slot, user) VALUES ('A','14:00','Bob')")
-- T2 (concurrent):
count = db.execute("SELECT COUNT(*) FROM bookings WHERE room='A' AND slot='14:00'")
if count == 0:
    db.execute("INSERT INTO bookings (room, slot, user) VALUES ('A','14:00','Alice')")
-- Both see count=0. Both insert. Double booking.

-- CORRECT: UNIQUE constraint enforces the invariant at insert time.
CREATE UNIQUE INDEX uniq_bookings_room_slot ON bookings(room, slot);
-- T1: INSERT → acquires pending unique entry.
-- T2: INSERT for same (room, slot) → BLOCKS on unique contention.
-- T1: COMMITS. Unique entry permanent.
-- T2: Unblocks. Unique check: finds T1's entry. CONFLICT.
--     ON CONFLICT (room, slot) DO NOTHING → T2 gets 0 rows affected. Handle gracefully.
```

---

## SECTION 6 — Performance Impact

### Locking Strategies: Performance Comparison

```
BENCHMARK: Inventory deduction under concurrent load.
Table: inventory(product_id BIGINT PK, quantity INT). 1 product. 1000 concurrent workers.
Each worker: deduct 1 unit from quantity. Start quantity: 10,000. End: 9,000 remaining.
PostgreSQL 15, r6g.2xlarge.

Strategy                          | Throughput | Latency (P99) | Final qty correct?
----------------------------------|------------|---------------|-------------------
Unprotected (read-modify-write)   | 95,000/s   | 2ms           | No (race condition)
Optimistic (version check)        | 12,000/s   | 45ms (retries)| Yes (with retries)
SELECT FOR UPDATE (pessimistic)   | 3,200/s    | 42ms          | Yes
Atomic UPDATE WHERE qty > 0       | 28,000/s   | 8ms           | Yes

ANALYSIS:
  Unprotected: highest throughput but INCORRECT. Race results in wrong quantity.
  Atomic UPDATE: 28K/s is 8.75x faster than FOR UPDATE. Correct. Default choice.
  SELECT FOR UPDATE: high latency from lock contention. Workers queue behind each other.
    1,000 workers × avg 5ms wait time = ~5ms wasted per request waiting for lock.
  Optimistic: retry overhead when contention high. Good for LOW contention scenarios.

  THE HOT ROW PROBLEM (high-contention single row):
    All 1,000 workers contend on ONE row. Only ONE can hold the row lock at a time.
    With FOR UPDATE: effectively serialized. Max throughput = 1/lock_hold_time.
    Lock hold time = query exec time (~0.5ms) + network roundtrip (~1ms) = ~1.5ms.
    Max throughput: 1 / 0.0015 = 667 transactions/second per hot row.

    Mitigation: shard the hot resource.
    Instead of 1 quantity row, use N shards:
    UPDATE inventory SET quantity = quantity - 1
    WHERE product_id = $1 AND shard_id = (random() * 10)::int
    AND quantity > 0;
    10 shards: 10 × 667 = 6,670 per hot product. 10x improvement.

SKIP LOCKED THROUGHPUT FOR JOB QUEUES:

  Without SKIP LOCKED: 10 workers compete for jobs.
    Worker 1: SELECT ... FOR UPDATE → locks row 1.
    Workers 2-10: block waiting for Worker 1 to commit.
    Worker 1 commits (5ms). Workers 2-10 unblock. They all try for row 2.
    Massive contention. Throughput: ~200 jobs/second for 10 workers on fast hardware.

  With SKIP LOCKED: 10 workers skip locked rows.
    Worker 1: SELECT ... FOR UPDATE SKIP LOCKED → locks row 1.
    Worker 2: row 1 locked → skips it. Locks row 2.
    Worker 3: rows 1,2 locked → skips them. Locks row 3. ... Parallel.
    All 10 workers proceed immediately. No contention. Throughput: ~2,000 jobs/second.
    10x improvement. SKIP LOCKED is the correct pattern for all job queue implementations.

ADVISORY LOCKS OVERHEAD:

  pg_advisory_lock(key): application-level lock. Keys are BIGINT (64-bit).
  Lock: stored in shared memory (no table page locks). Zero I/O overhead.
  Contention: session-level advisory lock blocks until released.
  Use: "I need to serialize an operation across multiple SQL statements or even multiple tables."
  Cost: ~0.01ms per acquire/release pair. Effectively free.
  Risk: forgetting to release → lock held until session ends.
  Pattern: always use pg_advisory_xact_lock (transaction-scoped; auto-released on COMMIT/ROLLBACK).

  SELECT pg_advisory_xact_lock(hashtext('process:order:12345')::bigint);
  -- Lock auto-released when transaction ends. No manual release needed.
```

---

## SECTION 7 — Concurrency & Data Integrity

### Deadlocks, Lock Wait, and Lock Ordering

```
DEADLOCK SCENARIO AND PREVENTION:

  T1 processes transfer: Alice → Bob. Locks Alice first, then Bob.
  T2 processes transfer: Bob → Alice. Locks Bob first, then Alice.

  Timeline:
    T1: SELECT * FROM accounts WHERE id=1 FOR UPDATE  → locks Alice. ✓
    T2: SELECT * FROM accounts WHERE id=2 FOR UPDATE  → locks Bob. ✓
    T1: SELECT * FROM accounts WHERE id=2 FOR UPDATE  → Bob locked by T2. T1 WAITS.
    T2: SELECT * FROM accounts WHERE id=1 FOR UPDATE  → Alice locked by T1. T2 WAITS.
    → Deadlock. PostgreSQL detects after deadlock_timeout (1s). Aborts T2.
    T2 receives: ERROR: deadlock detected.
    T1 proceeds. Completes successfully.

  PREVENTION: always acquire locks in a deterministic order (lower ID first):

  -- Always lock lower account ID first:
  accounts = sorted([from_account_id, to_account_id])  -- sort by ID
  SELECT * FROM accounts WHERE id = $1 FOR UPDATE;  -- lock smaller ID first
  SELECT * FROM accounts WHERE id = $2 FOR UPDATE;  -- lock larger ID second

  With consistent ordering: T1 and T2 both try to lock account 1 first.
  T2: blocks on account 1 (T1 holds it). T1 completes. T2 proceeds.
  No deadlock possible.

LOCK_TIMEOUT AND NOWAIT:

  Scenario: payment processing. If row is locked, fail fast (don't wait 30 seconds).

  -- NOWAIT: fail immediately if row is locked (don't block at all)
  SELECT * FROM orders WHERE id=$1 FOR UPDATE NOWAIT;
  -- If locked: immediately raises ERROR: could not obtain lock on row in relation "orders".
  -- Application: catches error, returns "retry later" to client.

  -- lock_timeout: fail after a duration
  SET lock_timeout = '3000ms';  -- 3 second timeout
  SELECT * FROM orders WHERE id=$1 FOR UPDATE;
  -- If not acquired within 3 seconds: ERROR: canceling statement due to lock timeout.

  USE CASES:
    NOWAIT: user-facing, interactive: "item currently being processed, try again"
    lock_timeout: background workers: "retry after brief wait"
    Neither (wait indefinitely): internal batch jobs where correctness > latency.

OPTIMISTIC LOCKING RETRY STRATEGY:

  Optimistic locking: add a version column. Check it on UPDATE. Retry on miss.

  CREATE TABLE documents (
    id      BIGSERIAL PRIMARY KEY,
    content TEXT NOT NULL,
    version INT  NOT NULL DEFAULT 1
  );

  Read phase:
    row = SELECT id, content, version FROM documents WHERE id = $1;
    -- row.version = 5

  Write phase (within a transaction, or atomically):
    rows_updated = UPDATE documents
                   SET content = $1, version = version + 1
                   WHERE id = $2 AND version = $3  ← optimistic version check
                   RETURNING id;
    -- $3 = 5 (the version we read)

    IF rows_updated == 0:
        -- version mismatch: another writer updated since we read. Retry.
        -- Exponential backoff:
        sleep(random() * 0.1 * (2 ** attempt))
        -- Re-read latest version and re-attempt update.

  WHEN TO USE OPTIMISTIC LOCKING:
    Low-contention: 90%+ of updates succeed on first try.
        → Cost: one extra version column. Zero lock overhead.
  WHEN TO USE FOR UPDATE (PESSIMISTIC):
    High-contention: many concurrent writers on same rows.
        → Optimistic: high retry rate. Retry overhead > lock wait overhead.
    Financial transactions: correctness critical, some wait acceptable.
```

---

## SECTION 8 — Optimization & Indexing

### Race Condition Detection, Monitoring, and Architectural Mitigations

```
MONITORING RACE CONDITIONS IN PRODUCTION:

  Deadlock monitoring (daily check):
  SELECT datname, deadlocks, conflicts
  FROM pg_stat_database
  WHERE datname = current_database();
  -- deadlocks: count since last pg_stat_reset(). Rising = lock ordering problem.
  -- conflicts: serialization failures under SERIALIZABLE. Rising = retry overhead.

  Lock wait monitoring (real-time):
  SELECT
    waiting.pid,
    waiting.query   AS waiting_query,
    blocking.pid    AS blocking_pid,
    blocking.query  AS blocking_query,
    now() - waiting.query_start AS wait_duration
  FROM pg_stat_activity waiting
  JOIN pg_locks wl ON wl.pid = waiting.pid AND NOT wl.granted
  JOIN pg_locks bl ON bl.relation = wl.relation AND bl.granted AND bl.pid != waiting.pid
  JOIN pg_stat_activity blocking ON blocking.pid = bl.pid;
  -- Shows: who is waiting, who is blocking them, how long they've been waiting.
  -- wait_duration > 5s: investigate the blocking query.
  -- Same blocking_pid dominating the output: one query causing cascade starvation.

  Hot row detection:
  SELECT locktype, relation::regclass, page, tuple, transactionid,
         COUNT(*) AS waiter_count
  FROM pg_locks
  WHERE NOT granted
  GROUP BY locktype, relation, page, tuple, transactionid
  ORDER BY waiter_count DESC
  LIMIT 10;
  -- High waiter_count on one tuple: hot row problem.
  -- Solutions: row sharding, queue-based serialization, or denormalization.

QUEUE-BASED SERIALIZATION FOR HOT RESOURCES:

  When a single resource is accessed by thousands of concurrent operations per second:
  No locking strategy scales well. Instead: serialize access through a queue.

  Pattern (PostgreSQL-native job queue):

  CREATE TABLE inventory_ops (
    id         BIGSERIAL PRIMARY KEY,
    product_id BIGINT NOT NULL,
    delta      INT NOT NULL,           -- negative = deduct, positive = return
    processed  BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );

  Write path (application, 1,000 concurrent):
    INSERT INTO inventory_ops (product_id, delta) VALUES ($1, -1);
    -- Zero contention. Just an INSERT. Always succeeds.

  Processing (single serialized worker or low-parallelism worker):
    BEGIN;
    SELECT * FROM inventory_ops WHERE NOT processed ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED;
    -- Processes 100 ops at once → batch UPDATE on inventory → mark processed.
    COMMIT;

  Throughput: application path at 100K+ inserts/second (no contention).
              Process worker: 10-50K ops/second (bulk batch).
  Trade-off: latency (op applied when worker processes it, not immediately on insert).
             Acceptable for most inventory decrement scenarios (eventual-consistent stock count).

SHARDING HOT ROWS:

  Product ID 42 has 5,000 orders/second. All contend on inventory(product_id=42).

  Solution: split into N shards, randomly distribute writes, aggregate on reads.

  CREATE TABLE inventory_shards (
    product_id  BIGINT NOT NULL,
    shard_id    INT    NOT NULL,    -- 0 to 9 (10 shards)
    quantity    INT    NOT NULL DEFAULT 0,
    PRIMARY KEY (product_id, shard_id)
  );

  -- Write (deduct 1 unit):
  UPDATE inventory_shards
  SET quantity = quantity - 1
  WHERE product_id = $1
    AND shard_id = floor(random() * 10)::int
    AND quantity > 0;
  -- Random shard: spreads lock contention across 10 rows (10 separate B-tree leaf entries).
  -- Throughput: 10x higher (10 parallel row locks instead of 1).

  -- Read (total stock):
  SELECT SUM(quantity) FROM inventory_shards WHERE product_id = $1;
  -- Slightly more expensive read (10 rows instead of 1). Usually acceptable.

  TRADEOFF: complexity vs throughput. Use when profiling shows hot-row lock contention as bottleneck.
  Do not over-engineer: most products are not at 5,000 orders/second.
```
