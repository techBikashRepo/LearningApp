# ACID Properties — Part 2 of 3

### Sections: 5 (Bad vs Correct), 6 (Performance Impact), 7 (Concurrency & Data Integrity), 8 (Optimization & Indexing)

**Series:** Databases & Data Modeling → Topic 16

---

## SECTION 5 — Bad Usage vs Correct Usage

### Pattern 1: synchronous_commit = off for Financial Data

```sql
-- BAD: disabling synchronous commit for performance on a payments table
-- postgresql.conf or RDS parameter:
synchronous_commit = off

-- Effect: COMMIT returns success to the application BEFORE the WAL is flushed to disk.
-- WAL writer flushes asynchronously every wal_writer_delay (default 200ms).
-- If server crashes within that 200ms window:
--   The COMMIT was acknowledged. Application believes payment processed.
--   WAL not on disk. After recovery: transaction does not exist in the database.
--   Payment record lost. Money charged. No record. Support calls.

-- PRODUCTION INCIDENT:
-- FinTech startup: synchronous_commit=off on payments table "for performance."
-- AWS EBS volume temporary I/O spike → PostgreSQL process killed by OOM.
-- On recovery: 47 payment records lost. Already charged cards. Zero DB records.
-- Reconciliation nightmare. Manual resolution over 3 days.

-- CORRECT: always keep synchronous_commit = on for financial tables.
ALTER SYSTEM SET synchronous_commit = 'on';  -- or in RDS: modify parameter group
-- For tables where some loss is acceptable (analytics events, session hits):
ALTER TABLE analytics_events SET (autovacuum_enabled = on);  -- different optimization
-- Or: use synchronous_commit=off only for those specific sessions:
BEGIN;
SET LOCAL synchronous_commit = 'off';   -- LOCAL: resets after transaction ends
INSERT INTO page_views (user_id, page) VALUES ($1, $2);
COMMIT;
-- Risk: 200ms of committed page_views could be lost on crash. Acceptable for analytics.
-- NOT acceptable for orders, payments, user accounts.
```

### Pattern 2: Application-Level "Check Then Insert" (Violating Consistency via Race)

```sql
-- BAD: application checks for duplicate email, then inserts (two-round-trip pattern)
-- Application code (Python):
result = db.execute("SELECT COUNT(*) FROM users WHERE email = $1", email)
if result[0][0] == 0:
    db.execute("INSERT INTO users (email, ...) VALUES ($1, ...)", email)

-- Problem: ACID Consistency is only upheld if constraints back it up.
-- Between the SELECT and INSERT: another request can insert the same email.
-- Window: microseconds to milliseconds. At high traffic: happens regularly.
-- Both inserts succeed. Two users with same email. Consistency violated.
-- Application-level checks WITHOUT database constraints: NOT an ACID consistency guarantee.

-- CORRECT: UNIQUE constraint enforces the invariant at database level.
CREATE UNIQUE INDEX users_email_unique ON users(email);
-- Application:
INSERT INTO users (email, name) VALUES ($1, $2)
ON CONFLICT (email) DO NOTHING  -- or DO UPDATE for upsert
RETURNING id;
-- Database enforces uniqueness atomically. Race condition handled by the DB engine.
-- Application receives ON CONFLICT result instead of two successful inserts.
```

### Pattern 3: SELECT Without Transaction for "Check and Act" on a Financial Balance

```sql
-- BAD: two separate statements with no transaction context
-- Statement 1 (autocommit):
SELECT balance FROM accounts WHERE id = $1;
-- Returns: balance = 100.00

-- ... application logic: "100 > 80, proceed" ...

-- Statement 2 (autocommit):
UPDATE accounts SET balance = balance - 80 WHERE id = $1;
-- Returns: balance updated. New balance: 20.

-- Problem: between Statement 1 and Statement 2, another process withdraws $50:
--   Other process: balance becomes 50.
--   Statement 2 executes: balance = 50 - 80 = -30. Negative balance. Constraint violated.
--   (if no CHECK constraint on balance) → $ overdraft. Consistency violated.

-- CORRECT (within a transaction with locking):
BEGIN;
SELECT balance FROM accounts WHERE id = $1 FOR UPDATE;  -- acquire row lock
-- Now: no other transaction can modify this row until COMMIT.
-- Value seen: current committed value (READ COMMITTED: 50 if other txn committed first).
IF balance >= 80:
    UPDATE accounts SET balance = balance - 80 WHERE id = $1;
    COMMIT;
ELSE:
    ROLLBACK;

-- WITH CHECK CONSTRAINT as double safety net:
ALTER TABLE accounts ADD CONSTRAINT balance_non_negative CHECK (balance >= 0);
-- Even if logic is wrong, DB-level constraint prevents negative balance.
```

### Pattern 4: SERIALIZABLE Isolation Without Retry Logic

```python
# BAD: using SERIALIZABLE without handling serialization failures
with db.transaction(isolation='serializable'):
    count = db.execute("SELECT COUNT(*) FROM on_call WHERE status='active'")
    if count > 0:
        db.execute("UPDATE on_call SET status='off' WHERE doctor_id=$1", doctor_id)
# Problem: if two transactions run concurrently (write skew), PostgreSQL detects
# the serialization anomaly and raises:
#   ERROR: could not serialize access due to concurrent update
# Application crashes. 500 error to user. No retry. Bad experience.

# CORRECT: implement retry loop for serialization failures
MAX_RETRIES = 3
for attempt in range(MAX_RETRIES):
    try:
        with db.transaction(isolation='serializable'):
            count = db.execute("SELECT COUNT(*) FROM on_call WHERE status='active'")
            if count > 0:
                db.execute("UPDATE on_call SET status='off' WHERE doctor_id=$1", doctor_id)
        break  # success, exit loop
    except psycopg2.errors.SerializationFailure:
        if attempt == MAX_RETRIES - 1:
            raise  # all retries exhausted, propagate
        time.sleep(0.1 * (2 ** attempt))  # exponential backoff: 100ms, 200ms, 400ms
```

---

## SECTION 6 — Performance Impact

### ACID Compliance vs Performance Trade-offs

```
ISOLATION LEVEL OVERHEAD:

  READ COMMITTED (default):       Baseline. Zero additional overhead vs no isolation.
  REPEATABLE READ:                ~5% throughput reduction (snapshot tracking overhead).
  SERIALIZABLE:                   ~10-20% throughput reduction (SSI conflict detection).

  SSI (Serializable Snapshot Isolation) overhead:
    Each transaction: tracks read/write sets for dependency detection.
    Memory: pg_serial backend structure in shared memory.
    At 1,000 concurrent serializable transactions: overhead is measurable (~12%).
    At 10,000+: SSI table contention can become a bottleneck.

  Serialization failure rate matters:
    Low-contention application: 0.01% failure rate. Retry cost negligible.
    High-contention (50% same rows): 30-50% failure rate. Retry cost is dominant.
    Benchmark: high-contention stock trade application with SERIALIZABLE isolation:
      Successful throughput: 2,200 trades/sec (with 35% retry overhead).
      Without serializable (using application-level locking): 3,800 trades/sec.
      With FOR UPDATE (pessimistic): 1,600 trades/sec (lock contention limits parallelism).
      Best choice depends on contention profile and retry cost.

DURABILITY OVERHEAD (WAL fsync):

  Each COMMIT: one fsync() call to flush WAL to disk.
  fsync latency by storage type:

  Storage Type              | fsync Latency | Max COMMIT/sec | Notes
  --------------------------|---------------|----------------|----------------------------
  HDD (SATA)               | 5-10ms        | 100-200        | Legacy. Avoid for PG.
  SATA SSD                  | 0.5-1ms       | 1,000-2,000    | Acceptable.
  NVMe SSD                  | 0.05-0.2ms    | 5,000-20,000   | Excellent.
  AWS EBS gp2               | 1-5ms         | 200-1,000      | IOPS depends on volume size.
  AWS EBS gp3 (16K IOPS)   | 0.5-2ms       | 500-2,000      | Provisioned.
  AWS EBS io2 (64K IOPS)   | 0.2-0.5ms     | 2,000-5,000    | High performance.
  AWS Aurora (Quorum Write) | 1-3ms         | 333-1,000      | 4/6 quorum, lower single-op.
  RDS Multi-AZ              | 0.3-0.8ms     | 1,250-3,333    | Sync replica.

  group_commit (commit_delay + commit_siblings):
    PostgreSQL can batch multiple concurrent COMMITs into one fsync.
    commit_delay = 100-1000 microseconds (wait time to accumulate group).
    commit_siblings = 5 (trigger group commit if ≥5 transactions waiting).
    Effect: at 500+ TPS, group commit amortizes fsync over 10-50 transactions.
    fsync cost per transaction: drops 10-50x. Throughput increases dramatically.
    Latency: increases slightly (by commit_delay). Acceptable trade-off.

  ASYNC COMMIT TRADE-OFF SUMMARY:

  Mode                 | Durability              | Latency | Max TPS
  ---------------------|-------------------------|---------|--------
  sync_commit=on       | Full (zero data loss)   | 0.5-2ms | 5,000
  sync_commit=local    | Crash-safe (not replica)| 0.5-2ms | 5,000
  sync_commit=off      | 200ms window data loss  | 0.05ms  | 50,000+

  Rule: sync_commit=off ONLY for event logs, analytics, cache warming. Never for business data.
```

---

## SECTION 7 — Concurrency & Data Integrity

### ACID Under Concurrent Load

```
ATOMICITY AND CONCURRENT WRITES:

  Two transactions T1 and T2 both modify the accounts table concurrently.

  T1: BEGIN. UPDATE accounts SET balance = balance - 100 WHERE id = 1 (Alice).
  T2: BEGIN. UPDATE accounts SET balance = balance - 50  WHERE id = 1 (Alice).

  T1 acquires row lock on Alice's row.
  T2: tries to UPDATE same row. BLOCKS. Waits for T1.

  T1 COMMITS. Alice's balance = 400 (was 500).
  T2 UNBLOCKS. Under READ COMMITTED: T2 re-reads Alice's row → sees 400, applies -50 → 350.
  T2 COMMITS.

  Result: Alice's balance = 350. Both updates applied correctly. Atomicity maintained.

  If T1 crashes (not the server — the transaction):
  T1: ROLLBACK (application error mid-transaction).
  T2: unblocks. Re-reads Alice's row → sees 500 (T1 rolled back). Applies -50 → 450.
  T2 COMMITS.
  Result: Alice's balance = 450. T1's changes evaporated. Atomic. Clean.

ISOLATION AND PHANTOM READ PREVENTION:

  Phantom read: T1 counts rows, T2 inserts a new row, T1 counts again → different count.
  READ COMMITTED: phantom reads possible (statements get fresh snapshots).
  REPEATABLE READ: phantom reads prevented (transaction holds its snapshot).

  EXAMPLE:
  T1 (REPEATABLE READ): SELECT COUNT(*) FROM seats WHERE available = TRUE; → 1
  T2: INSERT INTO seats (available) VALUES (TRUE); COMMIT;
  T1: SELECT COUNT(*) FROM seats WHERE available = TRUE; → still 1 (T1's snapshot, pre-T2).
  T1 makes decision based on count = 1. Consistent within its snapshot.

  Under READ COMMITTED:
  T1: SELECT COUNT(*) ... → 1.
  T2: INSERT + COMMIT.
  T1: SELECT COUNT(*) ... → 2. Different! T1's logic may be inconsistent.

WRITE SKEW (THE ACID ISOLATION PITFALL):

  Write skew: both transactions read a shared condition, each updates a DIFFERENT row
  based on that condition. Neither update conflicts with the other.
  MVCC: allows both to proceed. Result: invariant violated.

  Scenario: hospital rule: at least 1 doctor on-call at all times. 2 doctors: Alice and Bob.

  T1 (Bob going off): SELECT COUNT(*) WHERE on_call=TRUE → 2. OK to go off. UPDATE Bob → off.
  T2 (Alice going off): SELECT COUNT(*) WHERE on_call=TRUE → 2. OK to go off. UPDATE Alice → off.
  Both COMMIT. Count now = 0. Rule violated.

  Prevention:
  Option A: SERIALIZABLE isolation. Detects the dependency cycle. Aborts one.
  Option B: SELECT FOR UPDATE on the count query (materializes a lock on the checked rows).
            With FOR UPDATE: T2 blocks until T1 commits. T2 then re-reads count = 1. Doesn't proceed.
  Option C: Application-level advisory locks (pg_advisory_lock(key)).

  Detection:
  SELECT pg_stat_database.conflicts, deadlocks
  FROM pg_stat_database WHERE datname = current_database();
  Rising conflicts_confl_snapshot under SERIALIZABLE: write skew attempts.
```

---

## SECTION 8 — Optimization & Indexing

### Choosing Isolation Levels and Monitoring ACID Behavior

```
ISOLATION LEVEL DECISION MATRIX:

  Transaction Type              | Recommended Isolation  | Notes
  ------------------------------|------------------------|-----------------------------------------------
  Simple OLTP reads             | READ COMMITTED         | Default. Highest throughput.
  UPDATE single row             | READ COMMITTED         | Row lock prevents concurrent conflicts.
  Multi-row read + single write | READ COMMITTED + FOR UPDATE | Lock the read row before write.
  Read-then-write on same row   | READ COMMITTED + FOR UPDATE | Prevent read-modify-write race.
  Report / dashboard query      | REPEATABLE READ        | Consistent snapshot. No phantom reads.
  Complex invariant read+write  | SERIALIZABLE           | Write skew protection. Add retry logic.
  Financial balance mutations   | SERIALIZABLE or FOR UPDATE | Zero tolerance for inconsistency.
  Bulk ETL / data load          | READ COMMITTED         | No concurrent conflicts expected.

XID WRAPAROUND PREVENTION:

  Transaction IDs (XIDs) are 32-bit: max 2^32 ≈ 4.2 billion.
  1B transactions/day: would exhaust in 4 days. Postgres mitigates with freezing.

  VACUUM FREEZE: marks old rows as "frozen" (visible to all future transactions).
  Frozen rows: don't consume XID comparisons. Prevent wraparound.

  Monitoring XID age (how close to wraparound):
  SELECT relname, age(relfrozenxid) AS xid_age, 2^31 - age(relfrozenxid) AS xids_remaining
  FROM pg_class
  WHERE relkind = 'r' AND schemaname = 'public'
  ORDER BY xid_age DESC
  LIMIT 10;
  -- xid_age > 1.5 billion: urgent. Emergency VACUUM FREEZE needed.
  -- Amazon RDS: automated alert at 500M remaining. DBA action required.

  Aggressive VACUUM to prevent wraparound:
  VACUUM FREEZE VERBOSE large_table;  -- forces freeze of old rows
  ALTER TABLE large_table SET (autovacuum_freeze_max_age = 100000000);  -- 100M
  -- Default autovacuum_freeze_max_age: 200M. Lower = more frequent freezing = safer.

DURABILITY MONITORING AND CONFIGURATION:

  -- Verify synchronous_commit setting:
  SHOW synchronous_commit;  -- should be 'on' for production financial systems.

  -- Verify fsync is on (NEVER turn off in production — data corruption on crash):
  SHOW fsync;  -- must be 'on'. fsync=off: catastrophic on crash. No discussion.

  -- WAL level verification (needed for replication/archiving):
  SHOW wal_level;  -- 'replica' for streaming replication. 'logical' for logical replication.

  -- Check for replication lag (affects Durability on replicas):
  SELECT client_addr, state, sent_lsn, write_lsn, flush_lsn, replay_lsn,
         sent_lsn - replay_lsn AS lag_bytes
  FROM pg_stat_replication;
  -- lag_bytes > 100MB: replica falling behind. Potential durability gap on failover.

  -- Recommended RDS parameter settings for ACID compliance:
  -- synchronous_commit = on
  -- fsync = 1 (on)
  -- wal_level = replica
  -- max_wal_size = 4GB (prevent WAL from growing unbounded during heavy writes)
  -- For Aurora: 4/6 quorum write always on. No synchronous_commit setting exposed.
```
