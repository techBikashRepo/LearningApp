# Transactions — Part 2 of 3

### Sections: 5 (Bad vs Correct), 6 (Performance Impact), 7 (Concurrency & Data Integrity), 8 (Optimization & Indexing)

**Series:** Databases & Data Modeling → Topic 15

---

## SECTION 5 — Bad Usage vs Correct Usage

### Pattern 1: Transaction Left Open Across Network / Application Wait

```python
# BAD: transaction held open while waiting for external API call
with db.transaction():                      # BEGIN
    row = db.execute("SELECT * FROM orders WHERE id=$1", order_id)
    # Make an external HTTP call inside the transaction:
    api_result = requests.get("https://payment-api.example.com/verify", timeout=30)
    # Transaction is OPEN during this 30-second HTTP call.
    # Row-level locks acquired by the SELECT may be held.
    # If SELECT FOR UPDATE was used: the orders row is LOCKED for 30 seconds.
    # All other requests trying to process the same order: BLOCKED.
    db.execute("UPDATE orders SET status=$1 WHERE id=$2", api_result, order_id)
# COMMIT

# CORRECT: separate the read from the external call. Keep transactions short.
# Step 1: Read outside transaction (or in a very short one)
row = db.execute("SELECT * FROM orders WHERE id=$1", order_id)
# Step 2: External call outside any transaction
api_result = requests.get("https://payment-api.example.com/verify", timeout=30)
# Step 3: Short transaction for the write only
with db.transaction():    # BEGIN — transaction open for milliseconds, not 30 seconds
    db.execute("UPDATE orders SET status=$1 WHERE id=$2", api_result, order_id)
# COMMIT
```

### Pattern 2: Unintentional Autocommit Off (Implicit Transaction Never Committed)

```sql
-- BAD: developer disables autocommit, runs statements, forgets COMMIT
-- Python psycopg2 default: autocommit=OFF. Every statement starts a transaction.
conn = psycopg2.connect(dsn)
conn.autocommit = False  # (this is the default!)
cursor = conn.cursor()
cursor.execute("INSERT INTO products ...")
-- Forgets: conn.commit()
-- End of function: cursor goes out of scope. Connection returned to pool.
-- psycopg2 on connection close without commit: implicitly ROLLBACK.
-- Symptom: INSERT "works" (no error), but rows never appear in database.
-- Developer sees rows in their own session (via MVCC snapshot), not after function returns.

-- CORRECT:
conn.autocommit = True   # each statement auto-commits. Safe for simple operations.
# OR explicitly use context manager:
with conn.transaction():  # BEGIN
    cursor.execute("INSERT INTO products ...")
# COMMIT automatically on context manager exit
```

### Pattern 3: Long-Running Transaction Blocking VACUUM

```sql
-- BAD: analytics query runs a very long transaction (hours)
BEGIN;
SELECT COUNT(*), SUM(amount) FROM orders GROUP BY DATE(created_at);
-- This query runs for 2 hours. The transaction holds its snapshot.
-- MVCC: Postgres cannot VACUUM dead rows that are newer than this transaction's snapshot.
-- While this transaction runs: old dead rows accumulate. Table bloat grows.
-- Extreme case: transaction_id XID from this session = "horizon" for VACUUM.
-- VACUUM for the orders table: completely blocked for 2 hours. Dead rows pile up.
-- After 2 hours: VACUUM runs, handles all accumulated dead rows at once. I/O spike.
-- Prolonged: risk of XID wraparound (if running for days).

-- CORRECT: run analytics READ-ONLY queries outside of explicit transactions.
-- For multi-statement analytics that need a consistent snapshot:
SET statement_timeout = '30min';   -- Safety net. Kills if exceeds.
SET idle_in_transaction_session_timeout = '5min';  -- kills idle transactions
BEGIN ISOLATION LEVEL REPEATABLE READ;   -- snapshot for consistency
SELECT ...;  -- run query
COMMIT;  -- immediately after. Don't linger.

-- Monitor long transactions:
SELECT pid, now() - xact_start AS duration, query
FROM pg_stat_activity
WHERE state IN ('active', 'idle in transaction')
  AND xact_start IS NOT NULL
ORDER BY xact_start;
-- Any transaction > 5 minutes: investigate. Likely needs pg_cancel_backend(pid).
```

### Pattern 4: N Independent Transactions vs One Batched Transaction

```python
# BAD: each INSERT in its own transaction (autocommit ON or explicit per-row commit)
for row in data:   # 10,000 rows
    with db.transaction():   # BEGIN
        db.execute("INSERT INTO events VALUES ($1, $2, $3)", row)
    # COMMIT — fsync() for each row. WAL flush per transaction.
# Result: 10,000 round trips to disk. 10,000 separate WAL flushes.
# At 5ms/commit: 10,000 × 5ms = 50 seconds for 10K rows. Horrific.

# CORRECT: batch into a single transaction
with db.transaction():   # single BEGIN
    for row in data:     # 10,000 rows
        db.execute("INSERT INTO events VALUES ($1, $2, $3)", row)
# single COMMIT — one WAL flush for all 10,000 rows.
# Result: 150ms for 10K rows (vs 50s). 333x faster.

# EVEN BETTER: use COPY for bulk inserts (bypass INSERT overhead entirely)
import io
csv_data = io.StringIO()
for row in data:
    csv_data.write(f"{row[0]},{row[1]},{row[2]}\n")
csv_data.seek(0)
cursor.copy_from(csv_data, 'events', sep=',', columns=('col1','col2','col3'))
# COPY: 5-10x faster than batch INSERT. No per-row statement parsing. Bulk WAL write.
```

---

## SECTION 6 — Performance Impact

### Transaction Overhead Components

```
TRANSACTION COST BREAKDOWN:

  Each transaction has these unavoidable overheads:

  1. XID Assignment:
     Every write transaction: PostgreSQL allocates a Transaction ID (XID).
     XID counter: atomic increment. Fast, but global. Contention at very high txn rates.
     Read-only transactions: no XID (unless they upgrade to write). Cheaper.

  2. Snapshot Creation (MVCC):
     BEGIN: snapshot = list of all active transaction XIDs at that moment.
     Large ProcArray (many active transactions): snapshot creation requires scanning all.
     At 5,000 concurrent transactions: snapshot creation = iterate 5,000 entries.
     Cost: microseconds, but at 100,000 TPS: adds up.

  3. WAL Flush (Durability):
     COMMIT: WAL buffer flushed to disk. fsync() system call.
     fsync on NVMe SSD: ~0.1ms. On network storage (EBS io1): 0.5-2ms.
     This is the primary limiting factor for COMMIT throughput.
     On EBS gp2 (no provisioned IOPS): 1-4ms per commit. Limits to 250-1000 commits/sec.

     synchronous_commit = off: skip WAL flush on COMMIT. Risk: up to wal_writer_delay (200ms)
     of committed transactions lost on crash. Trade-off: 10-20x higher commit throughput.
     Use only for non-critical data (analytics events, session logs, not financial records).

TRANSACTION THROUGHPUT BENCHMARK:

  PostgreSQL 15, r6g.4xlarge, EBS gp3 (16K IOPS, 1000MB/s throughput).
  Test: pgbench -M prepared -T 60 -c 32 -j 8

  Configuration            | TPS      | Avg Latency | P99 Latency
  -------------------------|----------|-------------|------------
  synchronous_commit=on    | 4,200    | 7.6ms       | 18ms
  synchronous_commit=off   | 48,000   | 0.67ms      | 2.1ms
  synchronous_commit=local | 9,800    | 3.3ms       | 9ms  (replicas async)
  + PgBouncer txn pooling  | 12,000   | 2.7ms       | 7ms  (on top of sync_commit=on)

BATCH SIZE IMPACT:

  Task: insert 1M rows.

  Batch size (rows/transaction) | Duration | Commits  | Throughput
  ------------------------------|----------|----------|------------
  1 (autocommit)                | 820s     | 1,000,000| 1,220/s
  100                           | 82s      | 10,000   | 12,200/s
  1,000                         | 12s      | 1,000    | 83,333/s
  10,000                        | 5.2s     | 100      | 192,308/s
  100,000                       | 4.8s     | 10       | 208,333/s
  1,000,000 (all in one)        | 4.6s     | 1        | 217,391/s

  Diminishing returns above 10,000 rows per batch.
  In practice: batch 1,000-10,000 rows per transaction for bulk inserts.
  Trade-off: larger batches → larger rollback if the batch fails.
  Recommended: 1,000-5,000 rows per transaction for most use cases.
```

---

## SECTION 7 — Concurrency & Data Integrity

### Isolation Levels and Concurrent Transaction Behavior

```
PRACTICAL ISOLATION LEVEL SELECTION:

  READ COMMITTED (default):
    Each statement: sees all committed rows at that statement's start time.
    Within one transaction: two identical SELECTs may return different results.
    (Rows committed between the two SELECTs become visible.)

    Use for: most OLTP operations. Highest concurrency. Lowest overhead.
    Risk: non-repeatable reads (re-read same row, get different data). Phantom reads.

  REPEATABLE READ:
    Entire transaction: sees the same snapshot (rows committed at BEGIN time).
    Two identical SELECTs within transaction: always return the same rows.
    No UPDATE of rows that were modified after BEGIN (serialization failure if tried).

    Use for: long-running reports that must see a consistent state. Batch aggregations.
    Risk: write skew (two transactions each see consistent state → write conflicting).
    Requires retry logic in application.

  SERIALIZABLE:
    Strongest. Every transaction appears to execute one-at-a-time.
    Detects read/write dependencies. Aborts conflicting transactions (raises:
    ERROR: could not serialize access due to concurrent update)

    Use for: financial mutations that read-then-write complex invariants.
    Risk: serialization failures requiring application-level retry with exponential backoff.
    Overhead: ~10-20% throughput reduction vs READ COMMITTED.

LOCK WAIT TIMEOUT AND DEADLOCK RESOLUTION:

  Scenario: Transaction A holds lock on row 1, tries to lock row 2.
            Transaction B holds lock on row 2, tries to lock row 1.
            → Deadlock.

  PostgreSQL deadlock detection: runs automatically every deadlock_timeout (1 second default).
  When detected: one transaction (chosen by lock priority) is aborted with:
  ERROR: deadlock detected
  The aborted transaction: must be retried by the application.

  lock_timeout: prevents indefinite waiting.
  SET lock_timeout = '5s';
  -- If lock not acquired within 5 seconds:
  -- ERROR: canceling statement due to lock timeout
  -- Application must retry or surface an error.

  Deadlock prevention strategies:
    1. Always acquire locks in the same order. T1 and T2 both lock row1 before row2.
    2. Use SELECT FOR UPDATE to acquire all needed locks at once (vs incremental).
    3. Reduce transaction scope to minimize rows touched simultaneously.

  Monitoring deadlocks:
  SELECT deadlocks FROM pg_stat_database WHERE datname = current_database();
  -- Rising deadlock count: fix lock ordering in application code.

IDLE IN TRANSACTION:

  A transaction that opened but hasn't committed or rolled back and is now idle.
  Common cause: application opened transaction, started doing work, hit an error,
  forgot to ROLLBACK. Or: holding connection while waiting for user input.

  Danger: holds MVCC snapshot, prevents VACUUM progress.
  Danger: may hold row locks, blocking other transactions.

  Set idle_in_transaction_session_timeout:
  -- In postgresql.conf or per session:
  SET idle_in_transaction_session_timeout = '30s';
  -- Any session idle in transaction for > 30 seconds: automatically terminated.
  -- Application receives: FATAL: terminating connection due to idle-in-transaction timeout.
  -- Application should handle this and retry.
```

---

## SECTION 8 — Optimization & Indexing

### Transaction Throughput Optimization

```
CONNECTION POOLING (PgBouncer):

  Problem: each PostgreSQL connection = 5-10MB RAM + background worker.
  At 500 concurrent connections: 2.5-5GB RAM for connection overhead alone.
  PostgreSQL: not designed for thousands of direct connections.

  PgBouncer: lightweight proxy. Maintains a small pool of actual PG connections.
  Application: connects to PgBouncer (cheap, thousands allowed).
  PgBouncer: multiplexes onto 20-100 real PG connections.

  Modes:
    Session pooling: one PG connection per application session. Minimal savings.
    Transaction pooling: PG connection released back to pool on COMMIT/ROLLBACK.
                         Application can have 5,000 sessions sharing 100 PG connections.
                         Best for OLTP. Does NOT support PREPARE TRANSACTION or SET LOCAL.
    Statement pooling: extreme mode. Released after each statement. Rarely usable.

  Transaction pooling performance:
    Without pooling: 200 concurrent connections → PG RAM exhausted, context-switch overhead.
    With PgBouncer (200 app connections, 20 PG connections): throughput 2-4x higher.
    PgBouncer overhead: ~0.1ms per connection handoff. Negligible.

TWO-PHASE COMMIT (Distributed Transactions):

  Use case: update PostgreSQL + update another database/service atomically.
  Or: coordinate across multiple PostgreSQL instances.

  Phase 1 (Prepare):
    PREPARE TRANSACTION 'tx_order_12345';
    -- Transaction prepared: durably recorded in pg_prepared_xacts.
    -- Not yet committed. Locks held.
    -- If coordinator crashes now: transaction remains in prepared state on disk.
    -- On coordinator restart: can be found in pg_prepared_xacts and completed.

  Phase 2 (Commit or Rollback):
    COMMIT PREPARED 'tx_order_12345';
    -- or:
    ROLLBACK PREPARED 'tx_order_12345';
    -- Coordinator asks all participants to commit or rollback based on all-success/any-failure.

  Production risk: prepared transactions that are never resolved (coordinator crash + no recovery):
    SELECT * FROM pg_prepared_xacts;  -- shows all dangling prepared transactions.
    Dangling: hold locks, prevent VACUUM. Must be manually committed or rolled back.

  Modern alternative: Saga pattern (event-driven compensating transactions)
  or distributed transaction coordinators (XA-compatible middleware).
  Two-phase commit: heavy overhead, complex failure handling. Avoid unless truly necessary.

SAVEPOINTS FOR PARTIAL ROLLBACKS:

  Use case: batch operation where some rows may fail validation but others should succeed.

  BEGIN;
  FOR EACH row IN batch:
      SAVEPOINT sp_row;  -- create savepoint before each row's INSERT
      INSERT INTO events VALUES ($1, $2, $3);
      IF error:
          ROLLBACK TO SAVEPOINT sp_row;  -- undo only this row
          RELEASE SAVEPOINT sp_row;       -- clean up savepoint
          -- log the failure, continue to next row
      ELSE:
          RELEASE SAVEPOINT sp_row        -- clean up savepoint on success
  COMMIT;

  PERFORMANCE NOTE: savepoints have overhead.
  Each SAVEPOINT: records a snapshot, adds overhead proportional to transaction size.
  For batches of 1,000+ rows: savepoints for each row → significant overhead.
  Better pattern for large batches: catch errors at the batch level, re-run failed rows individually.
  Use savepoints sparingly: 1-5 per transaction, not per-row.
```
