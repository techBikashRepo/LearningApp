# Write-Through vs Write-Back — Part 1 of 3

### Topic: Foundations — Intuition, Core Concepts, Architecture & Data Flow

**Series:** Scalability & Performance → Topic 08

---

## SECTION 1 — Intuition (Explain Like a 12-Year-Old)

```
THREE WAYS AN OFFICE WORKER HANDLES NOTES:

SCENARIO: Sales rep updates a customer's contact info.

CACHE-ASIDE (reference model):
  Rep goes to the filing cabinet (DB), pulls the file, updates it.
  Then crosses out the sticky note they had on their desk (cache DEL).
  Next time they need the info: desk is empty → back to the cabinet.

  The desk is opportunistic. Cabinet is the master.

WRITE-THROUGH (update both at the same time):
  Rep updates the desk sticky note (cache) immediately.
  AND simultaneously updates the filing cabinet (DB).
  Both are always in sync.

  Advantage: desk is always current. No staleness ever.
  Cost: every update requires both desk AND cabinet update. Takes longer.
  Risk: if you update the desk but the cabinet drawer is jammed (DB fails):
        the desk says one thing, the cabinet says another.

WRITE-BACK / WRITE-BEHIND (update cache, defer to filing cabinet):
  Rep updates the desk sticky note (cache) immediately.
  Cabinet update: "I'll do it later when I have time" (async flush).

  Advantage: rep proceeds immediately. Very fast.
  Risk critical: if the desk catches fire (cache crash) before
                 the cabinet update happens: the change is PERMANENTLY LOST.

  Nobody told the filing cabinet. The change never happened.

IN SOFTWARE:
  Desk sticky note = Redis cache
  Filing cabinet   = Database (source of truth)

  Write-Through: write to Redis AND DB synchronously. Both updated. Both correct.
  Write-Back:    write to Redis only. DB is updated asynchronously. Gap = risk window.

  THE ARCHITECT'S CONCERN: the filing cabinet is the institution's actual record.
  The desk can burn. The cabinet must survive.
  Write-Through: cabinet always matches desk. Safe.
  Write-Back: the desk is ahead of the cabinet. Everything in the gap is at risk.
```

---

## SECTION 2 — Core Technical Explanation

### Write-Through: Consistency on a Write-Heavy Read-After-Write Flow

```
PROBLEM WRITE-THROUGH SOLVES:

  User updates their profile. Immediately navigates to their profile page.

  With Cache-Aside:
    Write: UPDATE DB → DEL cache.
    Immediate read: cache miss → DB read.

    Risk: user is behind a load balancer. Their read goes to a DB replica.
    Replication lag: 50ms. The update isn't in the replica yet.
    User sees THEIR OWN OLD PROFILE immediately after saving it.
    "Did my save fail?"

  With Write-Through:
    Write: UPDATE DB → SET cache (with new value).
    Immediate read: cache HIT → returns new value.

    Replication lag: irrelevant. Cache has authoritative value.
    User always sees their own write immediately.

  THIS IS THE "READ-YOUR-OWN-WRITES" GUARANTEE.
  Write-through delivers it naturally.
  Cache-aside with replica reads does not.

WHEN TO USE WRITE-THROUGH:
  ✅ User settings, preferences, profile data
     (user writes AND immediately reads their own update)
  ✅ Shopping cart (write item, immediately display updated cart)
  ✅ Real-time dashboards where display must reflect write instantly
  ✅ Any flow where the same request context reads immediately after writing
  ✅ Moderate write frequency — cache fills with useful data (high future hit rate)

WHEN NOT TO USE WRITE-THROUGH:
  ❌ Write-heavy, rarely-read data
     (every write cached = cache fills with data nobody ever reads again)
     (cache pollution: useful cached data evicted for newly written → rarely read data)
  ❌ Data generated in bulk (batch imports, ETL, data pipelines)
     (10M bulk inserts → 10M Redis writes in the critical path → write performance collapses)
  ❌ When DB write latency is already acceptable and cache warmup is acceptable
     (unnucessary complexity if cache-aside + short TTL solves the problem)
```

---

### Write-Back: Throughput for Extreme Write Volume

```
PROBLEM WRITE-BACK SOLVES:

  Gaming leaderboard. 5 million players. Each game ends:
    Update player's score in DB.
    Update player's rank in DB.

  At peak: 100,000 game completions per minute = 1,667 writes/second.
  Each write: 2 DB queries (score + rank update). = 3,334 queries/second.
  RDS db.r6g.xlarge: max write throughput ~2,000 writes/second.
  SYSTEM IS OVERWHELMED at peak.

  With Write-Back:
    Game ends → Redis ZADD leaderboard:scores playerId score (O(log N))
    Background job: every 30 seconds → batch flush top N changed scores to DB.

    Redis ZADD: ~0.5ms. 100,000/min = 1,667 ops/second. Redis handles this at ~1% capacity.
    DB writes: 30-second batches → 1,667 × 30 = 50,000 items per batch.
    One bulk INSERT: executes in 200ms. Every 30 seconds. DB very happy.

  Write-Back trades DURABILITY for THROUGHPUT.
  30-second delay between Redis write and DB write.
  If Redis crashes in that 30-second window: all pending writes lost.

  For a leaderboard: 30 seconds of score updates lost → slightly incorrect ranks.
  Acceptable for a game leaderboard. NOT acceptable for a bank balance.

WHEN TO USE WRITE-BACK:
  ✅ Leaderboards, view counts, like counts, real-time metrics
  ✅ Analytics event ingestion (counts, histograms)
  ✅ Session activity tracking (last-seen timestamps)
  ✅ Any metric where "approximately correct" is acceptable
  ✅ Any write volume that exceeds DB write throughput

WHEN NOT TO USE WRITE-BACK:
  ❌ Financial transactions (balance updates, payment records)
  ❌ Order status, inventory deductions (lost writes = overselling, lost orders)
  ❌ Audit trails (must be durable — missing audit record = compliance violation)
  ❌ Any data where "we lost 30 seconds of writes" is a business incident
```

---

## SECTION 3 — Architecture Diagram (MANDATORY)

### Write-Through Architecture

```
WRITE-THROUGH: SYNCHRONOUS WRITE TO CACHE + DB

REQUEST: PUT /users/profile (update display name)
                │
                ▼
        ┌──────────────┐
        │ App Server   │
        │              │
        │  1. Validate │
        │  2. Write ──►│──────────────────────►┌───────────┐
        │     to both  │  BEGIN TRANSACTION:   │  Redis    │
        │     AT ONCE  │   SET user:usr_a1 ... │           │◄── MUST SUCCEED
        │              │   TTL: 3600           │           │
        │              │──────────────────────►└───────────┘
        │              │
        │              │  AND  ──────────────────────────────►┌──────────┐
        │              │   UPDATE users SET name=... WHERE id │ Database │◄── MUST SUCCEED
        │              │  ────────────────────────────────────└──────────┘
        │              │
        │  3. Return   │
        │     success  │
        └──────────────┘
        only when BOTH succeed

FAILURE HANDLING — THE CRITICAL DESIGN:

  Scenario A: DB write succeeds, Redis write fails.
    Application state: DB has new value. Redis has old value (or no value).
    Decision: Return success to user? Or return error?

    ANSWER: The DB is the source of truth. DB write succeeded = the operation succeeded.
    Return 200 to user.
    On next read: cache miss → DB read → correct value → re-populate cache.
    The Redis failure is self-healing via the read path.

    This is why write-through is safer than write-back:
    DB is the primary. Cache failure on write = degraded performance, not data loss.

  Scenario B: Redis write succeeds, DB write fails.
    Application state: Redis has new value. DB has old value.
    Decision: ROLLBACK the Redis write. Return error to user.

    CRITICAL: if you return success here, cache says "name: NewName",
    DB says "name: OldName". User sees new name. But after TTL expires,
    they'll see old name. Ghost write.

    Implementation:
      try {
        await db.updateUser(userId, changes);     // DB first
        await redis.setex(key, 3600, newValue);   // cache second
        return Success;
      } catch(dbError) {
        return Error;                             // DB failed → cache not touched
      } catch(redisError) {
        // DB succeeded → cache failed → acceptable, self-healing
        logger.warn('Write-through cache update failed', { key });
        return Success;                           // DB write was authoritative
      }
```

---

### Write-Back Architecture

```
WRITE-BACK (WRITE-BEHIND): ASYNC DB FLUSH

REQUEST: POST /games/complete (update player score)
                │
                ▼
        ┌──────────────────────┐
        │ App Server           │
        │                      │
        │  1. ZADD             │
        │  leaderboard:scores  │──────────────────────►┌──────────────┐
        │  playerId score      │   O(log N). ~0.5ms.   │   Redis      │
        │                      │◄──────────────────────│              │
        │  2. Return 200       │   Done. Return now.   │ Pending set: │
        │  immediately         │                       │ {p1:9500,    │
        └──────────────────────┘                       │  p3:8200,    │
                                                       │  p7:7100}    │
                                                       └──────┬───────┘
                                                              │
                                            Every 30 seconds │
                                            (background job) │
                                                              ▼
                                                       ┌──────────────┐
                                                       │ Flush Worker │
                                                       │  1. ZRANGE   │
                                                       │     (get all)│
                                                       │  2. Batch    │
                                                       │     UPSERT   │
                                                       │     to DB    │
                                                       └──────┬───────┘
                                                              │
                                                              ▼
                                                       ┌──────────────┐
                                                       │  Database    │
                                                       │              │
                                                       │ Bulk write:  │
                                                       │ 50,000 rows  │
                                                       │ in ~200ms    │
                                                       └──────────────┘

RELIABILITY ADDITION: CHANGE LOG IN REDIS

  The problem: flush worker crashes. Redis key is flushed (cleared).
  But the batch INSERT to DB never happened. Data lost.

  Fix: before flushing, write a "pending flush" marker.
  After DB confirms insert: clear the marker.
  On crash + restart: flush worker checks for pending markers → retries.

  Pattern: REDIS LIST as a durable write queue.
    LPUSH write_queue { playerId, score, timestamp }
    Flush worker: LRANGE write_queue 0 999 → batch INSERT → LTRIM write_queue 1000 -1.
    If crash between INSERT and LTRIM: duplicate items on retry.
    Fix: DB must handle UPSERT (INSERT ON CONFLICT UPDATE) to be idempotent.
```

---

## SECTION 4 — Request Flow (MANDATORY FLOWCHART)

### Write-Through: Full Lifecycle

```
WRITE FLOW:
  1. Receive update request.
  2. Start DB transaction.
  3. UPDATE db_table SET ... WHERE id = ?
  4. COMMIT.
  5. On commit success: redis.SETEX key TTL new_value
  6. Return success.

  CRITICAL ORDER: DB write MUST precede or be atomic with cache write.
  Never: cache write first, then DB write.
  If DB write fails after cache write: cache has wrong data, DB has old data.

READ FLOW (after write-through):
  1. redis.GET key → HIT (cache was just populated by write).
  2. Return cached value.
  3. Zero DB reads.

  BENEFIT: If the service is write-then-read per user session (profiles, settings):
  Nearly 100% hit rate for reads immediately following writes.
  The write itself is the cache population event.

STALE DATA IN WRITE-THROUGH:
  WHERE does staleness still occur?

  Multi-instance race:
    Instance A writes user:123 to DB + cache (value: v2).
    Instance B ALSO writes user:123 (concurrent update, different field).
    Instance B updates DB (value: v3) + cache (value: v3).
    Instance A's Redis SETEX arrives after B's, due to network delay.
    Cache: v2. DB: v3. Stale.

  FIX: Write-through with optimistic locking.
    Add version/updated_at to DB.
    Redis cache entry: include version field.
    Before writing to cache: compare with DB version.
    Only overwrite cache if your version >= existing cache version.
```

---

_→ Continued in: [02-Write-Through vs Write-Back.md](02-Write-Through%20vs%20Write-Back.md)_
