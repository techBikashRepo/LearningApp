# Denormalization — Part 3 of 3

### Sections: 9 (AWS Mapping), 10 (Interview Q&A), 11 (Debugging Exercise), 12 (Architect's Mental Model)

**Series:** Databases & Data Modeling → Topic 20

---

## SECTION 9 — AWS Service Mapping

### How AWS Services Implement Denormalization Patterns

| Layer              | AWS Service                               | Denormalization Pattern                                                                                                                                                              |
| ------------------ | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Read Replica       | Amazon RDS Read Replica / Aurora Replicas | Read-only replicas serve read queries. Not denormalization, but reduces load on primary so complex aggregation queries don't impact writes.                                          |
| Materialized Views | Amazon Redshift                           | Materialized views supported natively. `CREATE MATERIALIZED VIEW` + auto-refresh possible. Redshift AQUA (Advanced Query Accelerator) caches pre-computed results at hardware level. |
| Caching            | Amazon ElastiCache (Redis/Memcached)      | Application-layer counter caches stored in Redis. `INCR user:42:follower_count` — atomic, fast. Redis persistence (AOF/RDB) provides durability for counter caches.                  |
| Summary Tables     | Amazon Timestream                         | Time-series summary/rollup tables. Purpose-built for counter caches and aggregations over time-series events. Automatic data tiering (hot → warm → cold).                            |
| Full-Text          | Amazon OpenSearch                         | Denormalized documents stored in OpenSearch. User profile, order history, tags: all flattened into one JSON document per entity. Read-optimized for search access patterns.          |
| Data Warehouse     | Amazon Redshift                           | Star schema: intentionally denormalized. Dimension tables + fact tables. Columnar storage amplifies the benefits of pre-aggregated structures.                                       |
| Real-Time          | Amazon Kinesis Data Streams + Lambda      | Streaming aggregation builds real-time summary tables. Lambda consumes events, updates DynamoDB counters atomically. Denormalized real-time dashboard data.                          |

---

**ElastiCache Redis as counter cache:**

```python
import redis
r = redis.Redis(host='your-elasticache-endpoint', port=6379)

# Atomic counter cache increment (no drift):
def follow_user(follower_id, followed_id):
    # DB write:
    db.execute("INSERT INTO follows (follower_id, followed_id) VALUES (%s, %s)",
               [follower_id, followed_id])
    # Cache counter update (atomic Redis INCR, like DB UPDATE counter+1):
    r.incr(f"user:{followed_id}:follower_count")

def get_follower_count(user_id):
    count = r.get(f"user:{user_id}:follower_count")
    if count is None:
        # Cache miss: warm from DB
        count = db.execute("SELECT COUNT(*) FROM follows WHERE followed_id=%s", [user_id]).scalar()
        r.set(f"user:{user_id}:follower_count", count, ex=3600)  # 1-hour TTL
    return int(count)
```

---

## SECTION 10 — Interview Q&A

### Beginner Questions

**Q1: What is denormalization and when should you use it?**

Denormalization is the intentional addition of redundant data or pre-computed values to a schema to improve read performance — at the cost of increased write complexity and potential data inconsistency. Use it when: (1) a specific query is provably slow despite correct indexing and statistics; (2) the denormalized value is either immutable or rarely changes; (3) the cost of maintaining the redundancy (triggers, background jobs) is lower than the cost of running the expensive query at runtime. Always profile first. Denormalize precisely and document why.

---

**Q2: What is a counter cache and what problem does it solve?**

A counter cache is a pre-stored integer column that tracks the count of related records, eliminating the need for `COUNT(*)` queries at read time. It solves the performance problem of counting large numbers of related records for frequently-read entities. For example, storing `follower_count` on the `users` table avoids `SELECT COUNT(*) FROM follows WHERE followed_id = ?` — which requires scanning potentially millions of rows. The trade-off: every follow/unfollow must atomically update the counter using `UPDATE users SET follower_count = follower_count + 1`.

---

**Q3: What is a materialized view and how does it differ from a regular view?**

A regular view is a named SQL query stored in the database — it executes the underlying query every time the view is queried. A materialized view is a regular view whose result set is physically stored on disk. Queries against a materialized view read the stored data rather than re-executing the underlying query — making reads as fast as a table scan on the materialized data. The trade-off: the stored data may be stale until refreshed. PostgreSQL's `REFRESH MATERIALIZED VIEW CONCURRENTLY` updates the view without blocking reads, making it suitable for live dashboards with a tolerable staleness window.

---

### Intermediate Questions

**Q4: How do you keep a counter cache consistent under concurrent writes?**

Atomic SQL updates enforce consistency: `UPDATE users SET follower_count = follower_count + 1 WHERE id = ?`. PostgreSQL executes this as a read-modify-write in a single atomic step — no application-level read is involved, so concurrent transactions see a monotonically correct counter. The update should be in the same transaction as the `follows` INSERT so a rollback reverts both. A nightly reconciliation job checks `SELECT COUNT(*) FROM follows WHERE followed_id = ?` and compares to `users.follower_count` — fixing any drift caused by direct database modifications or historical bugs.

---

**Q5: When is a materialized view better than a summary table, and vice versa?**

A **materialized view** is better when: the query is complex (multiple JOINs, GROUP BY), you want the DB to manage refresh logic, and a 1-hour staleness window is acceptable. `REFRESH MATERIALIZED VIEW CONCURRENTLY` handles the mechanics automatically.

A **summary table** is better when: you need incremental updates (not full recomputation on every refresh), you want sub-minute freshness via streaming aggregation, or you need fine control over which time ranges to refresh. Summary tables are more work to maintain (custom INSERT/UPDATE logic) but offer lower latency for real-time dashboards.

**Rule of thumb:** MV for hourly reporting, summary table for 1-15 minute freshness, counter cache for real-time.

---

### Advanced Questions

**Q6: Explain how denormalization can make data inconsistency a legal or financial risk.**

In a ticketing system, `available_seats` is a counter cache on the `events` table. If the counter cache drifts (due to a bug, missed decrement, or non-atomic update), it reports more available seats than actually exist. Customers buy "available" seats that don't exist. Result: overselling, double booking, customer service liability, potential legal exposure for breach of contract. The fix requires strict atomicity (seat reservation and counter update in the same transaction), a nightly reconciliation job, and an application-layer check that confirms `available_seats > 0` AND an actual seat record can be reserved — using optimistic locking to prevent the race.

---

**Q7: How do you design denormalization for a distributed system where the source of truth is in a different microservice?**

Denormalized copies across microservices must be maintained via domain events, not synchronous calls. When User service changes `user.name`, it publishes a `UserNameChanged` event to Kafka. The Orders service, which stores `customer_name` in orders (denormalized for receipt display), consumes the event and updates its local copy. The Orders service accepts eventual consistency: between event publication and consumption, orders may show the old name. This is acceptable for receipts (display only, not identity verification). The event consumer must be idempotent (same event applied twice = same result). For compliance data (name on a legal document): don't denormalize — always read from the authoritative source at compliance query time.

---

## SECTION 11 — Debugging Exercise

### Production Incident: Oversold Event Tickets

**Scenario:**
Your ticketing platform sold 50 seats for an event that holds 30 people. The `events` table has an `available_seats` column (counter cache). 20 customers show up to a sold-out event. Post-mortem required.

**Investigation:**

```sql
-- Check current state:
SELECT id, name, capacity, available_seats FROM events WHERE id = 99;
-- id=99, name='Jazz Night', capacity=30, available_seats=-20
-- Counter drifted BELOW zero! Something decremented without checking.

-- Check actual reservations:
SELECT COUNT(*) FROM reservations WHERE event_id = 99 AND status = 'confirmed';
-- 50 confirmed reservations for a 30-capacity event.

-- Find the race window — when did available_seats go negative?
SELECT * FROM audit_log
WHERE table_name = 'events' AND record_id = 99
ORDER BY changed_at DESC;
-- 15 updates within a 200ms window at 18:42:00 — ticket sale flash event.
-- All decremented from 5 to 4, 4 to 3... several decremented from 1 to 0...
-- then -1 to -2, etc. Concurrent writes bypassed the check.
```

**Root cause:**

```sql
-- BAD application code:
def reserve_ticket(event_id, user_id):
    event = db.query("SELECT available_seats FROM events WHERE id=%s", event_id)
    if event.available_seats > 0:   # ← check here
        # Race window: another transaction decrements here before we continue
        db.execute("UPDATE events SET available_seats = available_seats - 1 WHERE id=%s", event_id)
        db.execute("INSERT INTO reservations (event_id, user_id) VALUES (%s,%s)", [event_id, user_id])
    # Check and update were NOT atomic. 20 concurrent users all read "5 available", all reserved.
```

**Fix:**

```sql
-- CORRECT: atomic check-and-decrement in single statement:
WITH updated AS (
    UPDATE events
    SET available_seats = available_seats - 1
    WHERE id = $event_id AND available_seats > 0  -- check AND update are atomic
    RETURNING id
)
INSERT INTO reservations (event_id, user_id)
SELECT $event_id, $user_id
WHERE EXISTS (SELECT 1 FROM updated);
-- If available_seats was 0: UPDATE touches 0 rows → INSERT skipped → reservation rejected.
-- If available_seats was 5: UPDATE decrements to 4 AND INSERT creates reservation.
-- No race condition. Atomic single-statement check-and-reserve.
```

---

## SECTION 12 — Architect's Mental Model

### 5 Decision Rules

1. **Measure before you denormalize.** Run `EXPLAIN ANALYZE` on the slow query. Add missing indexes. Run `ANALYZE` on tables. Increase `work_mem`. Only if none of these fix it should denormalization be considered.

2. **Counter caches require atomic increments + same-transaction updates.** Never read-compute-write from application code. `UPDATE t SET counter = counter + 1` is the only correct pattern. Counter and the event that caused it: same transaction.

3. **Materialized views: always create the UNIQUE index before REFRESH CONCURRENTLY.** Without a unique index, CONCURRENTLY fails. Every materialized view: unique index on its natural key as setup step.

4. **Denormalized data must have a reconciliation job.** Any counter cache or denormalized column that can drift: weekly or nightly reconciliation that computes the real value from normalized source and updates if different. This is the safety net for any code path that was missed.

5. **Staleness is a contract, not a bug.** A materialized view refreshed every hour is correct — if the dashboard says "updated hourly." Make the staleness visible to users. "Last updated: 47 minutes ago." Unexplained staleness is a bug. Expected staleness communicated to users: a feature.

---

### 3 Common Mistakes

**Mistake 1: Denormalizing a mutable foreign key value (like product name, user email) without an event-driven update mechanism.** Product name in order_items: fine if stored as a point-in-time snapshot. Not fine if expected to stay current — it will drift the moment a product is renamed.

**Mistake 2: Refreshing a materialized view without CONCURRENTLY on a live production system.** The non-CONCURRENTLY refresh takes an exclusive lock. All reads from that view block for the duration of the refresh (potentially minutes). Always CONCURRENTLY for production views with a unique index.

**Mistake 3: Adding a counter cache to a table with high write throughput without measuring the added lock contention.** At 100K writes/second on orders, adding an `order_count` counter on users means 100K UPDATE users WHERE id=x per second — all serializing on individual user rows. For very high write rates, maintain counters in Redis instead and sync to the DB asynchronously.

---

### 30-Second Interview Answer

> "Denormalization is intentional redundancy for read performance. I use four patterns based on freshness requirements: counter caches for real-time counts (atomic DB increment, same transaction as the event), materialized views for complex pre-computed aggregates refreshed hourly with CONCURRENTLY, summary tables for 15-minute-fresh dashboards via incremental updates, and redundant immutable columns for point-in-time historical snapshots. The invariant I always maintain: counter caches need atomic increment-in-transaction plus a nightly reconciliation job. Denormalization without a reconciliation job is technical debt waiting to produce incorrect data."

---

_→ Next: [03-Soft Delete.md](../21 - Soft Delete/03-Soft Delete.md)_
