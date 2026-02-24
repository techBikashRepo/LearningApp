# Transactions — Part 3 of 3

### Sections: 9 (AWS Service Mapping), 10 (Interview Q&A), 11 (Debugging Exercise), 12 (Architect's Mental Model)

**Series:** Databases & Data Modeling → Topic 15

---

## SECTION 9 — AWS Service Mapping

### Transactions Across AWS Database Services

```
Aurora PostgreSQL:

  Transaction semantics: identical to PostgreSQL 14+ (Aurora PG 14 / 15 / 16 available).
  Isolation levels: READ COMMITTED, REPEATABLE READ, SERIALIZABLE — all supported.

  Aurora-specific transaction performance:
    COMMIT durability: Aurora writes WAL to 6 copies across 3 AZs (4/6 quorum required for ack).
    COMMIT latency: ~1-3ms (vs ~0.1ms on local NVMe). Slightly higher than standard PG with NVMe.
    COMMIT throughput: Aurora I/O path is optimized for high-concurrency commits. Many small
    transactions: Aurora's distributed storage performs better at scale than single NVMe.

  Aurora Global Database:
    Primary cluster: handles all writes. COMMIT goes to regional storage (4/6 quorum) + async
    replication to secondary regions (< 1 second typically).
    Read replicas in secondary region: can only read. All writes go to primary region.
    Failover to secondary: promotes it to primary. Lag at failover = seconds of lost transactions.
    RPO (Recovery Point Objective): < 1 second in most scenarios. RTO: ~1 minute for managed failover.

  Amazon RDS Proxy:
    Multiplexes application connections to RDS/Aurora. Transaction mode pooling recommended.
    Transactions: maintained within one real RDS connection for their duration.
    BEGIN...COMMIT: fully routed to the same underlying connection. No mid-transaction re-pinning.
    Caveat: session-level settings (SET, advisory locks) don't survive connection re-pinning after COMMIT.
    Use transaction-scoped alternatives (SET LOCAL, pg_advisory_xact_lock).

RDS MySQL / Aurora MySQL:

  InnoDB transaction model:
    Full ACID support. COMMIT writes redo log (equivalent to PostgreSQL WAL) to disk.
    innodb_flush_log_at_trx_commit:
      1 (default): flush and fsync on each COMMIT. Full durability.
      2: write log buffer to OS file cache on COMMIT. Fsync every second. Risk: 1 second of loss on crash.
      0: don't flush on COMMIT. Highest performance. Risk: up to innodb_flush_log_interval (100ms) loss.

    In Aurora MySQL: redo log goes to Aurora storage (6 copies). Not a local disk flush.
    innodb_flush_log_at_trx_commit = 1: COMMIT waits for Aurora quorum write ack. ~1-3ms.
    Higher settings: marginal improvement. Aurora durability is handled by the storage layer.

  MySQL transactions vs PostgreSQL:
    Both: BEGIN / COMMIT / ROLLBACK syntax identical.
    MySQL: SAVEPOINT supported (same syntax).
    MySQL: no DEFERRABLE constraints. Check constraints deferred to commit: not supported.
    MySQL: no true SERIALIZABLE via SSI. MySQL SERIALIZABLE: uses locking (shared read locks).
    PostgreSQL SERIALIZABLE: uses SSI (Serializable Snapshot Isolation) — non-locking. Lower contention.

DynamoDB:

  DynamoDB Transactions (TransactWriteItems / TransactGetItems):
    Up to 100 items across up to 100 tables in one transaction.
    All-or-nothing: if any condition fails, all items roll back.
    Uses optimistic locking internally: check versions, apply all, or rollback.

    TransactWriteItems: PUT, UPDATE, DELETE, ConditionCheck operations combined.
    ConditionCheck: used to group a check-then-write atomically.

    Example: atomic transfer (deduct from A, add to B):
    TransactWriteItems:
      Update account A: SET balance = balance - :amount IF balance >= :amount
      Update account B: SET balance = balance + :amount
    — Atomic across both items, even if in different partitions.

    Cost: 2x the normal WCU (two-phase internal mechanism).
    Limitation: only 100 items. No cursor/streaming within a transaction. No partial results.

  DynamoDB vs PostgreSQL transaction flexibility:
    PostgreSQL transaction: can hold a lock for seconds, run arbitrary SQL, use savepoints.
    DynamoDB transaction: stateless, one request, 100 items max, no multi-statement flow.
    DynamoDB: design for event-driven, single-request atomicity. Not for long-running workflows.

Step Functions (AWS):

  For multi-service distributed transactions (DynamoDB + SQS + Lambda):
  Step Functions + Saga pattern: explicit compensating actions for distributed workflows.
  Not a "transaction" in the DB sense. Eventual consistency via compensation.
  Use when: operations span multiple services/databases with no shared transaction coordinator.
```

---

## SECTION 10 — Interview Questions & Answers

### Beginner Level

**Q1: What is a database transaction and why do we need them?**

A transaction is a group of database operations that execute as a single atomic unit: either ALL succeed and are permanently saved, or NONE of them take effect. The purpose is to keep the database consistent even when operations are complex (multi-step) or failures occur.

Without transactions, a bank transfer — deduct $300 from Alice, credit $300 to Bob — could partially complete: Alice's money is gone but Bob never received it (or vice versa if the server crashes mid-operation). With a transaction wrapping both updates, a crash causes a ROLLBACK: Alice's balance is restored, Bob never receives the credit. No money is created or destroyed. The database stays consistent.

Transactions also protect against concurrent modifications, ensuring that two people withdrawing from the same account simultaneously can't both see a balance of $500 and both successfully withdraw $400, producing a $-300 balance.

---

**Q2: What is the difference between COMMIT and ROLLBACK?**

`COMMIT` tells the database: "all changes made in this transaction are correct and permanent." After COMMIT, the changes are durable — they survive server crashes, are visible to other transactions, and cannot be undone by the user (only by a subsequent UPDATE/DELETE).

`ROLLBACK` tells the database: "discard all changes made in this transaction." The database restores the state to what it was before the transaction began. Useful when: an error occurs mid-transaction, validation fails, or the application decides the operation shouldn't proceed.

The key implication: you should always ensure every transaction either commits or rolls back explicitly in application code. If a connection dies without committing, PostgreSQL automatically rolls back the incomplete transaction. This is why "implicit open transactions" (forgetting to COMMIT after BEGIN) silently discard all work.

---

**Q3: What does "atomicity" mean in a database context?**

Atomicity means a transaction is treated as a single indivisible unit. It either completes fully (all operations applied, COMMIT) or has no effect at all (all operations reverted, ROLLBACK). There is no in-between state.

The word "atomic" comes from Greek "atomos" — indivisible. Just as an atom cannot be split without fundamentally changing its nature, a transaction cannot be partially applied without violating data consistency. Atomicity is enforced by the database's Write-Ahead Log (WAL): changes are recorded in the WAL before being applied to the actual data pages. On crash, uncommitted WAL entries are ignored during recovery; committed entries are replayed. Either the full transaction commits to the WAL and replays, or none of it does.

---

### Intermediate Level

**Q4: What is the difference between a long-running transaction and a short-lived transaction, and what problems can long-running transactions cause?**

A short-lived transaction locks a minimal set of resources for milliseconds and releases them immediately. A long-running transaction holds its resources — including its MVCC snapshot, any row locks (if `FOR UPDATE` was used), and its transaction ID (XID) — for seconds, minutes, or hours.

Problems caused by long-running transactions:

1. **VACUUM bloat**: PostgreSQL's VACUUM cannot reclaim dead rows (from DELETEs/UPDATEs) that are newer than the oldest active transaction's snapshot. A 2-hour analytics query holds a 2-hour-old snapshot → 2 hours of dead rows accumulate unreclaimed → table and index bloat.
2. **Row lock contention**: if the transaction holds `FOR UPDATE` locks, all other transactions modifying those rows queue behind it for its entire duration.
3. **XID exhaustion**: in extreme cases (days-long transactions), transaction ID wraparound risk increases.
4. **Connection starvation**: in connection-pooled systems, a connection tied up in a long transaction blocks the pool from reusing it.

Mitigation: `idle_in_transaction_session_timeout = '30s'` (kills idle transactions after 30 seconds), `statement_timeout` (kills runaway queries), connection pool transaction mode (releases connection after each COMMIT/ROLLBACK).

---

**Q5: Explain Write-Ahead Logging (WAL) and how it provides both durability and crash recovery.**

WAL is PostgreSQL's mechanism for ensuring that committed data survives crashes and that the database can recover to a consistent state after a failure.

**How it works:**

1. When a transaction modifies data, the change is first written to the WAL buffer in memory — a sequential log describing the change.
2. On `COMMIT`, the WAL buffer is flushed and `fsync`'d to the WAL segment files on disk. The COMMIT returns success to the application only after this flush completes.
3. The actual heap/index pages may still be "dirty" in shared_buffers (not yet written to their own data files). This is fine — the WAL contains the canonical record of what committed.
4. Periodically, a checkpoint copies dirty pages from shared_buffers to their data files. The WAL entry for that checkpoint marks all pages before it as safe for future WAL truncation.
5. On crash: PostgreSQL replays all WAL entries after the last checkpoint, re-applying all committed changes to the data files. The database reaches the exact committed state at the moment of crash.

**Durability**: COMMIT doesn't return until WAL is on disk. Even if the server dies the next millisecond, the WAL on disk is replayed on restart — the committed data is never lost.

**Performance trade-off**: the WAL fsync is the bottleneck for commit throughput. `synchronous_commit = off` removes this guarantee for ~200ms of risk, enabling much higher write throughput for non-critical data.

---

### Advanced Level

**Q6: Describe the difference between optimistic and pessimistic concurrency control for transactions. When would you choose each?**

**Pessimistic concurrency control**: assumes conflicts will happen. Acquires locks before reading the data it will modify. Other transactions wanting to modify the same row wait behind the lock. No retries needed — the winner proceeds; the losers wait their turn.

Implementation: `SELECT ... FOR UPDATE`. Row is locked at read time. Others block until COMMIT or ROLLBACK.
Best for: high-contention scenarios where conflicts are frequent. Lock wait time is less than retry overhead (e.g., financial account balances at a bank, hot inventory items).

**Optimistic concurrency control**: assumes conflicts are rare. Reads data without acquiring locks. At write time, checks if anything changed since the read (using a version number or timestamp). If unchanged: write succeeds. If changed: write fails — application retries with fresh data.

Implementation: `UPDATE table SET col=val, version=version+1 WHERE id=$1 AND version=$2`. Returns 0 rows if another writer incremented version first. Application retries.
Best for: low-contention scenarios where concurrent modification of the same row is uncommon (e.g., user profile updates, document editing where conflicts are rare).

**Choosing between them:**

- Contention rate > 20% (same rows modified concurrently often): pessimistic wins.
- Contention rate < 5%: optimistic wins (zero lock overhead, high parallelism).
- Retry cost is high (complex re-computation, downstream effects): pessimistic wins (avoid retries).
- Long-lived network operations between read and write: optimistic (don't hold locks over network waits).

---

**Q7: What is two-phase commit, when is it needed, and what are its risks?**

Two-phase commit (2PC) is a distributed transaction protocol that coordinates multiple independent resource managers (databases, message brokers, etc.) to commit or rollback atomically.

**When needed**: when a single operation must update two separate databases (or a database and a message broker) and you need both-or-neither semantics. For example: deduct inventory from PostgreSQL AND publish an event to Kafka — both must succeed or both must be undone.

**Phase 1 (Prepare)**: the coordinator asks each participant to prepare (verify it can commit, persist the intent to WAL). `PREPARE TRANSACTION 'tx_id'`. Each participant responds "ready" or "abort".

**Phase 2 (Commit or Rollback)**: if ALL ready: `COMMIT PREPARED 'tx_id'` on each. If ANY abort: `ROLLBACK PREPARED 'tx_id'` on all.

**Risks**:

1. **Coordinator failure between phases**: prepared transactions persist on all participants (durable, visible in `pg_prepared_xacts`). They hold locks. If the coordinator crashes and doesn't recover, they remain indefinitely — blocking VACUUM and other writes. Manual intervention required.
2. **Performance**: two round trips for every commit (prepare + commit phases). 2x latency overhead.
3. **Complexity**: implementing a reliable coordinator is hard. Most teams underestimate recovery logic.

**Modern alternative**: Saga pattern (event-driven compensating actions). Each step succeeds independently; failures trigger compensating transactions. Eventually consistent. No blocking. Scales better than 2PC for most microservice scenarios.

---

## SECTION 11 — Debugging Exercise

### Production Incident: Transaction Holding Connection, Killing Throughput

**Scenario:**
Your checkout service starts returning 503 errors at 14:32 on a Tuesday. Database CPU is at 12% (low). Application CPU: 8% (low). But every request is timing out. The on-call engineer escalates. Your SLA requires 99.9% uptime — you have 3 minutes before an SLA breach.

---

**Step 1: Check what's blocking in the database (30 seconds).**

```sql
SELECT pid, state, wait_event_type, wait_event, now() - xact_start AS txn_duration, query
FROM pg_stat_activity
WHERE state != 'idle'
ORDER BY xact_start NULLS LAST
LIMIT 20;

-- Output:
-- pid=17234 | state=idle in transaction | wait_event=Client | duration=00:14:32 | query=BEGIN
-- pid=18901 | state=active | wait_event=Lock | query="UPDATE orders SET status=..."
-- pid=19012 | state=active | wait_event=Lock | query="UPDATE orders SET status=..."
-- ... (180 more rows, all wait_event=Lock)
-- pid=17234 is 14 minutes old, idle in transaction! 181 queries blocked behind it.
```

**Step 2: Identify what pid 17234 locked.**

```sql
SELECT mode, relation::regclass, granted
FROM pg_locks
WHERE pid = 17234;

-- Output:
-- RowExclusiveLock | orders | granted=true
-- RowExclusiveLock | payments | granted=true
-- ExclusiveLock    | orders:row | granted=true  ← row-level lock on one orders row!

-- Which row?
SELECT locktype, page, tuple FROM pg_locks WHERE pid = 17234 AND locktype = 'tuple';
-- Returns: page=48392, tuple=7 → row 7 on heap page 48392 of the orders table.
```

**Step 3: Identify what's in that transaction (what happened 14 minutes ago).**

```
Application log at 14:18:
"BEGIN checkout for order_id=9871234"
"Acquired payment lock for user 84732"
"Calling external fraud API..."
<no further log entries for pid 17234>

External fraud API: went down at 14:18. Application: HTTP request timed out at 14:28 (10-minute timeout).
But the connection to PostgreSQL was NOT closed by the application after timeout.
The transaction remained open — "idle in transaction" — holding the orders row lock.
All new checkout requests for any order involving user 84732: queued waiting for this lock.
```

**Step 4: Immediate fix — kill the stuck transaction.**

```sql
-- First: verify this is safe to kill (it hasn't committed; killing it auto-ROLLBACKs it).
-- SELECT state FROM pg_stat_activity WHERE pid = 17234; → 'idle in transaction'. Safe.
SELECT pg_cancel_backend(17234);  -- gentle kill: cancels current statement (if any)
-- If that doesn't work:
SELECT pg_terminate_backend(17234);  -- forces connection termination → automatic ROLLBACK
```

After termination: 181 queued queries unblock. They begin executing. Service recovers within 10 seconds.

**Step 5: Root cause and fix.**

**Root cause:** Application held a database transaction open while calling an external HTTP API with a 10-minute timeout. External API went down. Transaction never closed. Connection held idle-in-transaction for 14 minutes.

**Fix 1 (immediate):** Add `idle_in_transaction_session_timeout`.

```sql
ALTER DATABASE appdb SET idle_in_transaction_session_timeout = '30s';
-- Any session idle in transaction for > 30 seconds: auto-killed. Transaction rolled back.
```

**Fix 2 (architectural):** Restructure application to never hold a DB transaction across external API calls:

```python
# Don't do this:
with db.transaction():
    lock_order()
    call_external_fraud_api()  # may take 10 minutes
    update_order()

# Do this:
# Step 1: Short DB transaction to lock and mark order
with db.transaction():   # < 50ms
    lock_order()
    mark_order_processing()
# Transaction COMMITTED. Connection released.

# Step 2: External call outside transaction
result = call_external_fraud_api()   # may take up to 10 minutes, no DB connection held

# Step 3: Short DB transaction to finalize
with db.transaction():   # < 50ms
    finalize_order(result)
```

**Fix 3:** Set connection-level `statement_timeout` for all application connections:

```sql
ALTER ROLE app_user SET statement_timeout = '60s';  -- no single statement > 60 seconds
```

**Outcome:** idle_in_transaction_session_timeout deployed. Architectural fix in next sprint. Zero recurrence.

---

## SECTION 12 — Architect's Mental Model

```
=== Architect's Mental Model: Transactions ===

┌─────────────────────────────────────────────────────────────────┐
│  PHILOSOPHY: Transactions are contracts with time and scope.     │
│  The shorter the transaction, the lower the cost.               │
│  Duration and scope determine contention, lock risk, VACUUM      │
│  health, and throughput. Design transactions to be as brief      │
│  and narrow as they need to be — not as convenient as possible. │
└─────────────────────────────────────────────────────────────────┘

DECISION RULES:

1. Never hold a transaction open across an external call.
   Network call, third-party API, user input, sleep, or any I/O not controlled by you:
   all happen OUTSIDE the database transaction. Period.
   The transaction opens only when database writes begin, and closes as soon as possible.
   Lock all resources at once at the start of the transaction (acquire in consistent order).

2. Batch size matters: 1,000-5,000 rows per transaction for bulk inserts.
   1 row per commit: 100x slower than batched (fsync overhead dominates).
   1 million rows per commit: failure mid-load rolls back everything (retry cost too high).
   Sweet spot: 1,000-5,000 rows per transaction for bulk loads. Balanced throughput vs recovery.

3. Set idle_in_transaction_session_timeout in production. Always.
   Open transactions that die without committing leave zombie connections blocking VACUUM and locking rows.
   30 seconds is a reasonable default for OLTP. 5 minutes for long-running analytics batches.
   Never leave this unset on a production database — it's a production incident waiting to happen.

4. Choose isolation level per transaction, not globally.
   Default (READ COMMITTED) is correct for most OLTP. Don't change it globally.
   Use REPEATABLE READ for multi-statement analytics that need a consistent snapshot.
   Use SERIALIZABLE + retry logic only where write skew protection is essential (financial invariants).
   Mix isolation levels per transaction type, not per database.

5. Two-phase commit is a last resort.
   If you think you need 2PC: first design a Saga pattern with compensating transactions.
   2PC + coordinator failure = stuck prepared transactions, blocked VACUUM, manual intervention.
   Sagas are more complex to write but far more operationally resilient at scale.

COMMON MISTAKES:

1. Disabling synchronous_commit on financial tables "for performance."
   The 200ms window between COMMIT acknowledgment and WAL flush: exactly long enough for
   a power failure, OOM kill, or storage failure to destroy data the application believes is saved.
   For analytics events: acceptable trade-off. For orders, payments, user accounts: never acceptable.

2. Long transactions inhibiting VACUUM → table bloat → unexpected performance cliffs.
   A single analytics connection running a 2-hour report accumulates 2 hours of dead rows.
   VACUUM is blocked for 2 hours. Heap and index bloat grows linearly with the transaction duration.
   The performance cliff appears hours AFTER the long transaction, when the table has bloated.
   Schedule long analytical queries on read replicas (where they don't block the primary's VACUUM).

3. Assuming transaction = performance safety.
   "I wrapped it in a transaction, so it's safe." Unclear what "safe" means here.
   Transaction provides: atomicity, isolation (per isolation level), durability.
   Transaction does NOT provide: protection against application bugs that commit wrong data,
   protection against disk failure (that's synchronous_commit + replication), or sequential execution
   of concurrent transactions without explicit locking or SERIALIZABLE isolation.
   Know exactly what your transaction level guarantees and doesn't guarantee.

                     ╔══════════════════════════════════╗
  30-SECOND ANSWER → ║  TRANSACTIONS IN 30 SECONDS      ║
                     ╚══════════════════════════════════╝

"A transaction groups multiple database operations into a single atomic unit —
all succeed and permanently commit, or all fail and roll back. BEGIN starts the
unit; COMMIT makes it permanent; ROLLBACK discards it. Durability is enforced by
Write-Ahead Logging: WAL is flushed to disk at COMMIT, ensuring committed data
survives crashes. Isolation prevents concurrent transactions from seeing each
other's incomplete work — READ COMMITTED, REPEATABLE READ, and SERIALIZABLE
offer increasing protection with increasing overhead. The key design principle:
keep transactions short and narrow. Every second a transaction stays open, it
holds its MVCC snapshot (blocking VACUUM), possibly holds row locks (blocking
writes), and ties up a connection. Transactions are powerful but expensive when
misused."
```
