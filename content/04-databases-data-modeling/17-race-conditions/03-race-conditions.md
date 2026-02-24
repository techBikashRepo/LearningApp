# Race Conditions — Part 3 of 3

### Sections: 9 (AWS Service Mapping), 10 (Interview Q&A), 11 (Debugging Exercise), 12 (Architect's Mental Model)

**Series:** Databases & Data Modeling → Topic 17

---

## SECTION 9 — AWS Service Mapping

### Race Conditions Across AWS Services

```
Aurora PostgreSQL — Full race condition toolset:

  All PostgreSQL concurrency primitives available:
    SELECT FOR UPDATE / FOR SHARE: row-level pessimistic locks.
    SKIP LOCKED: queue pattern — grab available rows, skip already-locked rows.
    Atomic UPDATE WHERE: single-statement read-modify-write. No inter-statement race.
    Advisory Locks: pg_try_advisory_xact_lock(key) — application-defined mutex on an integer key.
    Optimistic Locking: UPDATE ... WHERE version = $expected AND RETURNING version.
    SERIALIZABLE isolation: prevents write skew via SSI.

  Aurora-specific considerations:
    Reader endpoints (read replicas): read replica lag is typically < 20ms but non-zero.
    If application reads from reader endpoint AND writes to writer endpoint:
    Race condition: write from one request, read for validation from read replica = sees old data.
    Solution: for critical reads before writes (inventory check before purchase), ALWAYS read
    from the writer endpoint. Reader endpoint: for eventually-consistent reads only.

    Aurora Global Database secondary regions:
    Secondary regions: always eventually consistent (replication ~1 second lag).
    Never use a Global Database secondary region as the source of truth for an inventory count,
    available seat count, or any read that precedes a write. Full race condition between regions.
    Writes MUST go to primary region. Reads-before-writes MUST also go to primary.

DynamoDB — Optimistic Locking Built-In:

  DynamoDB Conditional Writes (single item — most common race condition fix):
    ConditionExpression = the database-level optimistic locking mechanism.

    Example: atomically decrement inventory, prevent negative quantity:
    UpdateItem:
      Key: { productId: "SHOE-001" }
      UpdateExpression: "SET quantity = quantity - :dec"
      ConditionExpression: "quantity >= :dec"
      ExpressionAttributeValues: { :dec: 1 }
    If condition fails: raises ConditionalCheckFailedException → return "sold out" to user.
    If condition passes: quantity updates atomically. Cannot race to below zero.

  Version-based optimistic locking (AWS SDK DynamoDB Mapper):
    Add a @DynamoDBVersionAttribute (or version attribute in any SDK).
    Read item → get version=5.
    Write item with ConditionExpression: "version = :expected" AND set version = :expected+1.
    Concurrent writer: updates version to 6. Your write: ConditionExpression fails.
    Application: retries with fresh read. Clean optimistic-lock pattern built into the SDK.

  DynamoDB Transactions (TransactWriteItems) — preventing cross-item races:
    Atomic conditional write across up to 100 items.
    Example: transfer credits from one account to another, both with balance >= amount checks.
    TransactWriteItems:
      ConditionCheck on source: balance >= amount (prevent negative)
      Update source: SET balance = balance - :amount
      Update dest: SET balance = balance + :amount
    If any check fails: entire transaction rolls back atomically. No partial transfer.
    Cost: 2x WCU.

ElastiCache Redis — Distributed Locking (with caveats):

  Redis SETNX pattern (SET if Not eXists):
    SETNX lock_key "owner_id" EX 30  -- set with 30-second expiry
    Returns 1: lock acquired.
    Returns 0: lock held by another process. Retry or fail fast.

  Redlock algorithm (Martin Kleppmann's critique):
    Attempts to use majority of Redis nodes (3 or 5) for distributed lock.
    Problem: still has edge cases with clock skew, GC pauses, and process sleeps.
    A process can acquire the lock, pause for GC > lock expiry, and another process acquires the lock.
    Both processes believe they hold the lock. Race condition remains.

  The fundamental problem with Redis + DB:
    Redis lock → Critical section → Database write: occurs in two steps.
    Redis lock release and database commit are NOT atomic.
    Between Redis lock release and DB commit: another process can acquire Redis lock.
    The Redis lock provides no guarantee about what's in the database.

  Rule: for race conditions involving shared mutable database state: solve it IN the database.
    SELECT FOR UPDATE, atomic UPDATE, SERIALIZABLE isolation.
    Redis locks: useful for coordinating application-level resources (external API rate limits,
    distributed cron deduplication) not for protecting database write consistency.

  Redis correct usage for race conditions:
    Rate limiting (INCR + EXPIRE): genuinely atomic in Redis. Prevent API abuse.
    Deduplication (SETNX for idempotency keys): prevent duplicate event processing.
    Distributed cron lock (prevent 2 instances running same job): appropriate use.

Amazon SQS FIFO Queues — Architectural Avoidance of Database Race Conditions:

  Root cause of many race conditions: horizontal scaling + shared mutable state.
  10 application servers all trying to decrement the same inventory counter simultaneously.

  Alternative architecture: serialize all writes to shared state through a queue.

  SQS FIFO queue with MessageGroupId = resource identifier:
    All writes for productId=SHOE-001 → same MessageGroupId → processed exactly once, in order.
    Single consumer per MessageGroup: no concurrent writes to same inventory record.
    Throughput: up to 3,000 messages/sec per message group (SQS FIFO throughput limit).

  Trade-off: increased latency (async processing), complexity (worker infrastructure).
  Appropriate when: contention is extreme (flash sales, lottery events) and eventual consistency
  is acceptable (user sees "processing" state before inventory confirmation).
  Not appropriate when: synchronous response required ("yes you got the item" immediately).

RDS Proxy:

  RDS Proxy reduces race condition risk by reducing connection pool spikes.
  During flash sale: 10,000 concurrent connections → PostgreSQL max_connections limit → errors.
  RDS Proxy: multiplexes 10,000 application connections to 100 real PostgreSQL connections.
  Reduces "connection storm" race conditions where connections pile up on hot rows.
  But: doesn't change the database-level locking semantics. FOR UPDATE still required.
```

---

## SECTION 10 — Interview Questions & Answers

### Beginner Level

**Q1: What is a race condition in a database?**

A race condition occurs when multiple concurrent operations read and then modify the same shared data, and the final result depends on the order of execution — producing incorrect or inconsistent outcomes under certain timing conditions.

The classic pattern is read-decide-write: Transaction A reads a value, makes a decision based on it, then writes a new value. If Transaction B also reads the same value, makes its own decision, and writes — before A's write commits — then B's write was based on stale data. Both operations complete, but the combined result violates a business rule.

Example: two users both see 1 seat remaining for a concert. Both click "Purchase." Both transactions read `quantity = 1`, both pass the check, both decrement: `quantity = 0` for one, `quantity = -1` for the other's UPDATE. The concert is now over-sold by 1.

---

**Q2: What is a "lost update"?**

A lost update happens when two concurrent transactions both read a value, both compute a new value from it, and both write their new value — with the second write silently overwriting the first.

Example:

```
Initial: likes = 100
Transaction A: reads 100, adds 1, writes 101
Transaction B: reads 100 (same snapshot), adds 1, writes 101
Result: likes = 101 (should be 102)
Transaction A's update is "lost" — it ran but had no effect.
```

Lost updates are prevented with:

1. **Atomic UPDATE**: `UPDATE posts SET likes = likes + 1 WHERE id = 42` — the entire read-modify-write happens inside ONE database statement. Atomic. No race.
2. **SELECT FOR UPDATE**: lock the row before reading, then update. Others block until lock is released.
3. **Optimistic locking**: include a version check in the UPDATE. If another writer changed the version first, your UPDATE affects 0 rows. Retry.

---

**Q3: What does `SELECT FOR UPDATE` do?**

`SELECT FOR UPDATE` acquires an exclusive row-level lock on every row returned by the SELECT. Other transactions that try to `SELECT FOR UPDATE`, `UPDATE`, or `DELETE` those rows must wait until the lock holder either commits or rolls back.

```sql
BEGIN;
SELECT balance FROM accounts WHERE id = 42 FOR UPDATE;
-- Row 42 is now locked. Any other transaction attempting to modify row 42 blocks here.
UPDATE accounts SET balance = balance - 500 WHERE id = 42;
COMMIT;  -- lock released
```

The lock prevents any other transaction from modifying the row between your read and your write. The gap — where the value read might become stale before the write — is closed.

**When to use:** when you read a value, do application-level computation with it, and then write based on that computation. The computation happens at the application layer, outside the database, so the row must be locked during that window.

**When NOT to use:** for simple counters or increments. Use atomic UPDATE instead (`SET balance = balance - 500 WHERE balance >= 500`). Atomic UPDATE doesn't need a prior SELECT and is 8-10x faster than SELECT FOR UPDATE + UPDATE under contention.

---

### Intermediate Level

**Q4: What is the difference between optimistic locking and pessimistic locking? When is each appropriate?**

**Pessimistic locking** assumes conflicts will occur. It acquires exclusive locks _before_ accessing shared data. Other transactions wanting to modify the same data must wait for the lock to be released.

Implementation: `SELECT ... FOR UPDATE`. Lock at read time. Others block until your COMMIT.
Result: no retries, no wasted computation. The conflict never happens.
Cost: under high contention, transactions queue. Throughput is bounded by how fast the lock holder commits.

**Optimistic locking** assumes conflicts are rare. It reads data without acquiring locks. Before writing, it checks whether the data changed since the read using a version number or timestamp. If unchanged: write succeeds. If changed: write fails — retry.

Implementation:

```sql
-- Read: SELECT id, balance, version FROM accounts WHERE id = 42;
-- Got: version=7
-- Write (check + increment):
UPDATE accounts SET balance = $new_balance, version = 8 WHERE id = 42 AND version = 7;
-- Returns 0 rows if another writer changed version 7 to 8 already. → Retry.
```

**Choosing:**

- High contention (same row modified frequently by many concurrent requests): pessimistic. Lock wait time < retry overhead.
- Low contention (same row rarely modified by multiple concurrent requests): optimistic. Zero lock overhead, higher parallelism.
- Long window between read and write (e.g., a complex form the user fills out over seconds): optimistic. Never hold a DB lock while waiting for user input.
- High retry cost (external calls, multi-step computation in the retry): pessimistic. Avoid retrying expensive work.

---

**Q5: What is `SKIP LOCKED` and what problem does it solve?**

`SELECT ... FOR UPDATE SKIP LOCKED` acquires an exclusive lock on rows that are NOT currently locked by other transactions, and completely skips (ignores) rows that ARE locked — without waiting.

```sql
-- Job queue pattern:
BEGIN;
SELECT id, job_payload FROM job_queue
WHERE status = 'pending'
  AND scheduled_at <= NOW()
ORDER BY scheduled_at
LIMIT 1
FOR UPDATE SKIP LOCKED;
-- If a pending job is locked by another worker: skip it. Grab the next available one.
UPDATE job_queue SET status = 'processing', worker_id = $my_id WHERE id = $selected_id;
COMMIT;
```

**Problem solved:** "thundering herd" on job queues. Without SKIP LOCKED: 100 workers all SELECT the same "oldest pending job". 99 of them block waiting for the first worker to commit. They all wake simultaneously, re-elect the next oldest job, and block again. Serial throughput despite 100 workers.

With SKIP LOCKED: 100 workers each grab a DIFFERENT available job in their own SKIP LOCKED query. No waiting. Parallel processing of 100 jobs simultaneously. **Linear throughput scaling with worker count.**

Also useful for: sending email notifications (workers take different batches), background tasks, audit processing, any "pull work from a queue" pattern.

---

### Advanced Level

**Q6: Walk me through a flash sale: 10,000 concurrent users trying to buy the last item. How do you handle this correctly at scale?**

**Problem dimensions:**

1. **Correctness**: quantity must not go below 0. No overselling.
2. **Performance**: 10,000 concurrent requests on one inventory row → extreme contention point.
3. **User experience**: most users should see "sold out" quickly, not time out.

**Layer 1: Application-level pre-filtering (reduce DB hits).**
Cache the `quantity` in Redis. Decrement in Redis atomically (`DECRBY`). If Redis counter reaches 0, all subsequent requests short-circuit at the Redis layer — never reach the database. Redis `DECRBY` is atomic (single-threaded Redis). Result: 9,999 users get "sold out" from cache. ~1-10 users reach the database.
Caveat: Redis is not the source of truth. Redis can be wrong (cache eviction, restart). Redis counter is an optimistic gate, not a guarantee.

**Layer 2: Database atomic UPDATE (source of truth).**
For the requests that pass the Redis gate:

```sql
UPDATE products
SET quantity = quantity - 1
WHERE id = $product_id AND quantity > 0
RETURNING quantity;
-- If quantity was already 0: returns 0 rows → sold out. Application returns error.
-- If quantity was >= 1: decrements and returns new value. Application confirms purchase.
```

Atomic UPDATE: no explicit lock acquisition, no race. The database guarantees only one row can successfully decrement to 0. Second concurrent UPDATE on `quantity = 0` returns 0 rows.

**Layer 3: Queue-based serialization (for extreme contention).**
If the UPDATE throughput is still insufficient (10,000 req/sec on 1 row), serialize via SQS FIFO:

- All purchase requests → SQS FIFO queue with product_id as MessageGroupId.
- Single worker consumes queue in-order. One atomic UPDATE at a time.
- Trade-off: async response (user polls for result). Appropriate for high-ticket flash sales where exact ordering matters.

**Layer 4: Row sharding (maintain synchronous response).**
Shard the inventory row: instead of `products` having `quantity = 1`, split into `product_id=1/shard=0/quantity=1`. Assign request to a random shard. Each shard handles its portion of load. Aggregate for total inventory display.

**Combined recommendation** for most flash sales: Redis counter gate (99% of load absorbed) + atomic UPDATE WHERE quantity > 0 (1% of load hits DB, handles remaining concurrency) + monitoring for oversell detection.

---

**Q7: Design a distributed job queue using only PostgreSQL that is race-condition-free, handles worker crashes, and scales to 1,000 workers.**

```sql
-- Table design:
CREATE TABLE job_queue (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    job_type        TEXT NOT NULL,
    payload         JSONB NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending'     -- pending | processing | done | failed
                    CHECK (status IN ('pending', 'processing', 'done', 'failed')),
    priority        INTEGER NOT NULL DEFAULT 100,
    scheduled_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    claimed_at      TIMESTAMPTZ,
    claimed_by      TEXT,                               -- worker identifier
    heartbeat_at    TIMESTAMPTZ,                        -- worker must update this to retain claim
    attempt_count   INTEGER NOT NULL DEFAULT 0,
    max_attempts    INTEGER NOT NULL DEFAULT 3,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for efficient claim query:
CREATE INDEX idx_jq_pending ON job_queue (priority DESC, scheduled_at)
WHERE status = 'pending';  -- partial index: only indexes claimable rows

-- Index for stale job heartbeat recovery:
CREATE INDEX idx_jq_processing ON job_queue (heartbeat_at)
WHERE status = 'processing';
```

**Worker claim pattern (race-condition-free):**

```sql
-- Each worker runs this in a tight loop:
BEGIN;
WITH claimed AS (
    SELECT id FROM job_queue
    WHERE status = 'pending'
      AND scheduled_at <= NOW()
    ORDER BY priority DESC, scheduled_at
    LIMIT 1
    FOR UPDATE SKIP LOCKED    -- skip rows locked by other workers
)
UPDATE job_queue
SET status     = 'processing',
    claimed_at = NOW(),
    claimed_by = $worker_id,
    heartbeat_at = NOW(),
    attempt_count = attempt_count + 1
FROM claimed
WHERE job_queue.id = claimed.id
RETURNING job_queue.id, job_queue.payload;
COMMIT;
-- Returns the job exclusively to this worker. Other workers get different jobs.
```

**Heartbeat (prevent lost jobs on worker crash):**

```sql
-- Worker updates heartbeat every 10 seconds while processing:
UPDATE job_queue SET heartbeat_at = NOW()
WHERE id = $job_id AND status = 'processing' AND claimed_by = $worker_id;
```

**Reaper (recover crashed worker jobs):**

```sql
-- Background reaper runs every 30 seconds:
UPDATE job_queue
SET status       = CASE WHEN attempt_count >= max_attempts THEN 'failed' ELSE 'pending' END,
    claimed_by   = NULL,
    claimed_at   = NULL,
    heartbeat_at = NULL
WHERE status = 'processing'
  AND heartbeat_at < NOW() - INTERVAL '30 seconds';  -- no heartbeat for 30 seconds = worker died
```

**Scale:** 1,000 workers with SKIP LOCKED → 1,000 parallel job claims with no blocking. Each worker claims from its own isolated row. The partial index on `(priority DESC, scheduled_at) WHERE status='pending'` keeps claim queries fast even with millions of jobs.

**Why race-condition-free:** the only way to claim a job is via the atomic CTE + UPDATE. Two workers can never claim the same job because: the FOR UPDATE SKIP LOCKED means they lock different rows. A job transitions from `pending` to `processing` atomically in one UPDATE. No two can win the same row in the same UPDATE.

---

## SECTION 11 — Debugging Exercise

### Production Incident: Inventory Shows Negative Quantity After Flash Sale

**Scenario:**
The holiday flash sale ended 2 hours ago. Inventory management team reports that 23 products show negative quantity in the database — quantities as low as -847. Orders were placed for these non-existent items. Customer service is escalating. Engineering is unclear how this happened because "the inventory check is in the code."

---

**Step 1: Identify the two inventory update code paths.**

```
Via git grep "UPDATE products SET quantity":

File 1: order_service/checkout.py (line 84):
    # Atomic UPDATE — correct pattern
    result = db.execute("""
        UPDATE products
        SET quantity = quantity - %s
        WHERE id = %s AND quantity >= %s
        RETURNING quantity
    """, [qty, product_id, qty])
    if not result:
        raise OutOfStockError()

File 2: inventory_sync/sync.py (line 212):
    # Non-atomic read-modify-write — RACE CONDITION
    current = db.execute("SELECT quantity FROM products WHERE id = %s", [product_id]).fetchone()
    new_qty = current.quantity - sold_in_period
    db.execute("UPDATE products SET quantity = %s WHERE id = %s", [new_qty, product_id])
    db.commit()
```

Two code paths. One is correct (atomic UPDATE WHERE). One is broken (read-then-write).

---

**Step 2: Confirm via pg_stat_statements that both query patterns appear in production.**

```sql
SELECT query, calls, total_exec_time
FROM pg_stat_statements
WHERE query LIKE '%products%quantity%'
ORDER BY calls DESC;

-- Output:
-- "UPDATE products SET quantity = quantity - $1 WHERE id = $2 AND quantity >= $1 RETURNING quantity"
--   calls=8,423,100 (checkout service, correct)
-- "UPDATE products SET quantity = $1 WHERE id = $2"
--   calls=2,847 (sync service, broken: writes an absolute value, not relative)
```

The second query is the problem. During the flash sale peak, the sync service ran while checkout was processing. The sync service read 500 quantity, observed 200 sold in its window, computed 300, and wrote `quantity = 300` — overwriting the in-flight checkout service's decrements.

---

**Step 3: Trace a specific product.**

```sql
-- Audit log for product_id=1847 (quantity=-47):
SELECT operation, old_quantity, new_quantity, source, occurred_at
FROM product_audit_log
WHERE product_id = 1847
ORDER BY occurred_at;

-- outcome:
-- PRE_SALE: quantity = 100
-- CHECKOUT update: 100→99, 99→98 ... 2→1, 1→0 (correct atomic updates)
-- SYNC update 14:32:07: quantity = 0 → overwritten to quantity = 53 (sync read old snapshot)
-- CHECKOUT update: 53→52 ... 3→2, 2→1, 1→0, 0→ (checkout continues after sync's false re-stock)
-- Another SYNC: quantity=actual → syncs again with another stale read
-- Net: checkout service sold items that sync service "restored" repeatedly during the sale
```

**Step 4: Fix the sync service.**

```python
# Don't do this (broken):
current = db.execute("SELECT quantity FROM products WHERE id = %s", [product_id]).fetchone()
new_qty = current.quantity - sold_in_period
db.execute("UPDATE products SET quantity = %s WHERE id = %s", [new_qty, product_id])

# Do this (atomic relative update):
db.execute("""
    UPDATE products
    SET quantity = GREATEST(0, quantity - %s)  -- floor at 0
    WHERE id = %s
""", [sold_in_period, product_id])
```

**Step 5: Add a CHECK constraint to catch it at the database level.**

```sql
ALTER TABLE products ADD CONSTRAINT quantity_non_negative CHECK (quantity >= 0);
-- Any update producing negative quantity: raises constraint violation → caught, not silently corrupted.
```

**Outcome:** two fixes — atomic relative UPDATE in sync service + CHECK constraint. Audit log added to detect future divergence. Pre-sale code review checklist updated: flag any query pattern `UPDATE table SET col = $absolute_value WHERE id = $id` on shared mutable counters.

---

## SECTION 12 — Architect's Mental Model

```
=== Architect's Mental Model: Race Conditions ===

┌─────────────────────────────────────────────────────────────────┐
│  PHILOSOPHY: A race condition is a gap in time between           │
│  observation and action. Close the gap. Every architecture       │
│  decision around shared mutable state is a decision about        │
│  whether a gap exists and who bears the cost when it's exploited.│
└─────────────────────────────────────────────────────────────────┘

DECISION RULES:

1. Default to atomic UPDATE. Reach for SELECT FOR UPDATE only when you must.
   Atomic UPDATE WHERE: one database round trip, no application-layer read, no gap, no lock contention.
   SELECT FOR UPDATE: two round trips, application logic in between, row locked for the entire duration.
   If the computation can be expressed as: SET col = col ± delta WHERE col condition → use atomic UPDATE.
   Only use SELECT FOR UPDATE when: the new value requires application computation (external logic,
   multiple column values combined, business rules that can't be expressed in a single SQL expression).

2. SKIP LOCKED is the correct pattern for every queue-based workload.
   Any "assign work items to N workers" pattern: SKIP LOCKED. Without it: all workers block on each other.
   The partial index on (priority, scheduled_at) WHERE status='pending': essential for performance.
   The heartbeat + reaper: essential for correctness under worker crashes.

3. Identify hot rows in your schema. Each hot row is a throughput ceiling.
   A hot row = one row modified by many concurrent transactions.
   Max throughput on a hot row ≈ 1 / (average transaction duration holding the lock).
   At 5ms transaction duration: 200 TPS max per hot row, regardless of instance size or scale-out.
   If throughput requirement > hot row limit: redesign.
   Options: row-level sharding (inventory slots), event sourcing (append-only + periodic aggregation),
   queue serialization (SQS FIFO per resource), or pre-processing (reserve before sale, reconcile after).

4. Use SERIALIZABLE for write-skew scenarios. Design with retry.
   Write skew (multi-row decisions with non-overlapping writes): cannot be prevented by FOR UPDATE.
   SERIALIZABLE + application retry loop (3-5 attempts) is the correct solution.
   Serialization failures are NOT bugs — they are the database correctly preventing an inconsistency.
   Treat them like any other retriable error (429 Too Many Requests equivalent).

5. Never use Redis as the sole guard for database consistency.
   Redis lock + DB write = two-step, non-atomic combo. Clock skew, GC pauses, and network delays
   create windows where both holders of the "lock" proceed. Use Redis for:
     - application-level coordination (distributed cron lock, event deduplication)
     - read-path caching (with DB as source of truth)
     - not for protecting database writes from parallel modification
   For DB-level race conditions: solve in the DB with atomic SQL.

COMMON MISTAKES:

1. Read-compute-write in application code for shared counters.
   SELECT quantity → application checks quantity > 0 → UPDATE quantity = quantity - 1.
   The gap between SELECT and UPDATE: any number of concurrent transactions can read the same
   quantity value and all proceed. Fix: move both check AND update into one atomic statement.
   Thumb rule: if two SQL statements together enforce one business invariant, there's a race.

2. Thinking Redis SETNX provides database-level atomicity.
   Redis lock acquisition: succeeds. Application: writes to database. Power failure at that exact moment.
   Redis lock is in memory (if no AOF persistence). Database write was in-flight. Inconsistent state.
   The combination of Redis lock + DB write is not atomic — no tool makes it atomic without 2PC.
   Engineer understanding: "I use Redis for locking" ≠ "my database writes are race-free."

3. Optimistic locking without retry handling.
   Optimistic locking implementation: UPDATE ... WHERE version = $v RETURNING version.
   Application checks: 0 rows returned = conflict. But application throws an error to the user.
   Correct behavior: if 0 rows returned = retry the entire operation (re-read, re-compute, re-write).
   Without retry: optimistic locking just turns race conditions into visible errors rather than
   preventing them. The race is still there; you're just notifying the user of it.
   Always implement: read → try → if conflict → re-read → try again (max N retries).

                     ╔══════════════════════════════════╗
  30-SECOND ANSWER → ║  RACE CONDITIONS IN 30 SECONDS   ║
                     ╚══════════════════════════════════╝

"A race condition occurs when concurrent transactions read the same data, make
decisions, and write — with one transaction's write based on data already changed
by another. The canonical pattern is read-decide-write with a gap between read
and write that other transactions can exploit. Fix it with: atomic UPDATE WHERE
(moves read and write into one statement — no gap), SELECT FOR UPDATE (lock the
row at read time, hold through write), or optimistic locking (version check in
the UPDATE, retry if 0 rows affected). SKIP LOCKED for queue patterns. SERIALIZABLE
for write skew. Never rely on application-layer reads to enforce shared-state
invariants — the database must enforce them atomically. Check plus write must
happen in one SQL statement or under a lock."
```
