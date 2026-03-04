# Write-Through vs Write-Back — Part 2 of 3

### Topic: Real World Examples, System Design Importance, AWS Mapping & Interview Prep

**Series:** Scalability & Performance → Topic 08

---

## SECTION 5 — Real World Example

### How Hit Rate Behaves Differently Across Patterns

```
CACHE-ASIDE HIT RATE PROFILE:
  Cold start: 0%. Warms up as missed keys are populated.
  Steady state: 80–97% depending on key cardinality.
  After TTL expiry: brief drop on each key, then re-warms.
  After write (DEL): brief miss on next read, re-warms.

WRITE-THROUGH HIT RATE PROFILE:
  Cold start: 0% until first writes occur (writes ARE the cache population).
  After significant write activity: hit rate rises because writes pre-populate.
  Pattern: reads AFTER writes have near-100% hit rate.

  PROBLEM: Write-through populates cache for ALL written keys.
  For write-heavy data that is NEVER read again:
    100 inserts → 100 cache entries → 100 DB memory slots used.
    Zero cache hits for these entries.
    Meanwhile: frequently-read entries may be evicted to make room.
    Cache hit rate drops. DB load rises (evicted reads now miss).

  THIS IS CACHE POLLUTION: writing data that will never be hit.

  Mitigation: Only apply write-through to entities with high read-after-write frequency.
  Use cache-aside for entities that are written and rarely re-read.

WRITE-BACK HIT RATE PROFILE:
  Very high hit rate for recent writes (data is always in cache, never evicted until flushed).
  But: if flush interval is 30s and TTL is 60s:
  Data written at t=0: in cache until t=60s.
  Flush at t=30s: persisted to DB.
  Read at t=45s: still a cache hit.
  Read at t=61s: TTL expired → cache miss → DB read (data IS in DB due to flush at t=30).

  RISK WINDOW: write at t=0, crash at t=15, no flush yet.
               Data in cache (memory) — gone with the crash.
               DB: doesn't have it. Recovery: permanent loss.

  THE WINDOW SIZE = your flush interval. Choose it based on acceptable data loss.
```

---

## SECTION 6 — System Design Importance

### Write-Through Failures

```
FAILURE 1: Write-Through Increases Write Latency (and P99)

  Write before write-through:
    UPDATE products ... → 20ms DB write. Return 200.

  Write with write-through:
    UPDATE products ... → 20ms DB write.
    redis.SETEX product:99 ... → 1ms Redis write.
    Total: ~21ms. 5% overhead. Acceptable.

  PROBLEM: Redis becomes slow (memory pressure, network congestion).
  redis.SETEX: 200ms timeout.
  Write operation: 20ms (DB) + 200ms (Redis timeout) = 220ms.
  P99 write latency: 10× worse when Redis is slow.

  FIX: Don't wait for Redis in the critical path.
    Option A: Fire-and-forget Redis write (async, no await).
      DB write is synchronous. Cache write is async.
      Risk: cache may not be updated if Redis write fails.
      For non-critical data: acceptable.

    Option B: Redis write with short timeout (50ms max).
      If Redis takes > 50ms: skip the cache write. Continue.
      Next read: cache miss → DB hit (self-healing).
      Prevents Redis slowness from affecting write SLO.

    Option C: Publish to an invalidation queue.
      Write: UPDATE DB → publish { key } to SQS.
      Cache updater Lambda: picks up SQS message → SET cache.
      Decouples cache write from request latency entirely.
      Adds eventual consistency (100ms–2s lag for cache population).

FAILURE 2: Write-Through Cache Pollution at Scale

  B2B platform. 10,000 enterprise customers. Each has a detailed profile.
  But 8,000 haven't logged in for 2+ years.
  Write-through: every CRM sync writes all 10,000 profiles to cache.

  8,000 inactive profiles: consuming 40% of Redis memory.
  0% hit rate on those 8,000 (nobody reads them — users are inactive).
  Active 2,000 profiles: being evicted (LRU eviction — inactive profiles haven't been read,
  but they were recently WRITTEN so they look "recent" to LRU).

  Wait — write-through writes are also touch events for LRU.
  So recently-written but never-read profiles SURVIVE eviction.
  Recently-written AND read profiles: also survive.
  Old but frequently-read profiles: evicted.
  HIT RATE COLLAPSES.

  FIX: Selective write-through.
  Only write-through for keys that have been read in the last N days.
  Track read frequency separately. On write: check if key has been read recently.
  If yes: write-through. If no: just update DB (cache-aside path on next read).
```

---

### Write-Back Failures

```
FAILURE 1: Data Loss on Cache Failure

  Write-back to Redis → Redis crashes (OOM, hardware failure, network partition).
  Pending writes (not yet flushed to DB): gone.

  Severity depends on data type:
    Leaderboard scores: 30 seconds of score updates lost. Rank slightly stale. Recoverable.
    User account updates: "I changed my email and it disappeared." Not recoverable. Incident.
    Payment processing: NEVER use write-back for financial data. Data loss = regulatory incident.

  For acceptable write-back data: Design for loss scenarios.
    User-facing message: "Changes are saved every 30 seconds."
    Use case: collaborative document editor, game state, analytics.
    Not use case: any legally-required record.

FAILURE 2: Flush Worker Failure

  Background flush worker crashes mid-batch.
  Scenario A: crash before INSERT → No data written to DB. Redis still has data.
    Recovery: restart worker, replay from write_queue. OK.

  Scenario B: crash after some of the batch INSERT, before confirming.
    DB: has partial batch.
    Redis: still has full batch (we haven't confirmed flush yet).
    Recovery: replay full batch → duplicate INSERTs.
    MUST use idempotent INSERT: INSERT ... ON CONFLICT (id) DO UPDATE.
    Without idempotency: duplicate data. PRIMARY KEY violations. Worker stuck in retry loop.

  Always design write-back flush operations to be IDEMPOTENT.
  Give each write a unique ID (UUID) and use ON CONFLICT to handle retries.

FAILURE 3: Outpacing the Flush Worker

  Write rate: 10,000 items/second.
  Flush interval: every 30 seconds.
  Pending items: 300,000 items per flush cycle.

  DB bulk insert of 300,000 rows: 3 seconds.
  Redis queue: accumulating 10,000 items/sec while flush runs (3s): 30,000 more items.

  If flush consistently takes longer than the period between flushes:
  The queue grows unboundedly → Redis runs out of memory → evictions begin
  → data that was never flushed is evicted → permanent data loss at scale.

  FIX: Multiple flush workers with partitioned queues.
    Shard by write_queue:0 through write_queue:15.
    Each worker handles one shard.
    16 parallel flush workers → 16× the flush throughput.

  FIX: Monitor write_queue depth with alert:
    Alert when queue depth > 2 × (flush_interval × write_rate).
    Trigger: scale flush workers, or switch to synchronous writes temporarily.
```

---

## SECTION 7 — AWS & Cloud Mapping

### Side-by-Side Guarantee Comparison

```
┌──────────────────────────┬────────────────┬────────────────┬────────────────┐
│ GUARANTEE                │ CACHE-ASIDE    │ WRITE-THROUGH  │ WRITE-BACK     │
├──────────────────────────┼────────────────┼────────────────┼────────────────┤
│ Read-your-own-writes     │ ❌ (miss after │ ✅ Cache HIT   │ ✅ Cache HIT   │
│ (see your own update     │    DEL; may    │    immediately │    immediately │
│  immediately)            │    hit replica)│    after write │    after write │
├──────────────────────────┼────────────────┼────────────────┼────────────────┤
│ DB always correct        │ ✅ DB is       │ ✅ DB written  │ ❌ DB is       │
│ (DB = source of truth)   │    written     │    sync with   │    behind cache│
│                          │    before DEL  │    cache       │    by flush lag│
├──────────────────────────┼────────────────┼────────────────┼────────────────┤
│ No data loss on cache    │ ✅ DB is       │ ✅ DB written  │ ❌ Unflushed   │
│ failure                  │    always first│    sync        │    writes lost │
├──────────────────────────┼────────────────┼────────────────┼────────────────┤
│ Bounded staleness        │ ✅ TTL-bounded │ ✅ Near-zero   │ ⚠ Flush       │
│                          │                │    (race edge  │    interval-   │
│                          │                │    case only)  │    bounded     │
├──────────────────────────┼────────────────┼────────────────┼────────────────┤
│ Handles write spikes     │ ✅ Cache not   │ ❌ Write to    │ ✅ Redis       │
│                          │    in write    │    both = more │    absorbs     │
│                          │    critical    │    write load  │    spike, DB   │
│                          │    path        │                │    batched     │
├──────────────────────────┼────────────────┼────────────────┼────────────────┤
│ Cache failure resilience │ ✅ Reads fall  │ ✅ DB still    │ ❌ Cache       │
│                          │    through     │    correct;    │    failure =   │
│                          │    to DB       │    reads miss  │    data loss   │
│                          │                │    but correct │                │
└──────────────────────────┴────────────────┴────────────────┴────────────────┘
```

---

## SECTION 8 — Interview Preparation

**Beginner:**

**Q: What is write-through caching?**
**A:** Every time you save data, you save it to BOTH the cache AND the database at the same time, before confirming success to the user. Like updating both your whiteboard (fast, visible) and your filing cabinet (safe, permanent) every time you make a note. No data loss possible, but every write takes as long as the combined database + cache write.

**Q: What is write-back (write-behind) caching?**
**A:** You save data to the cache FIRST, confirm success to the user immediately, then write to the database later in the background. Like writing a note on your whiteboard immediately, then filing it later. Much faster for the user, but if your server crashes before the background write happens, that whiteboard data is lost. High risk for important data.

**Q: Which should I use for financial transactions?**
**A:** Always write-through. You can never afford to lose a financial transaction, so you must confirm the database write before responding to the user. Write-back caching is appropriate for non-critical data like analytics events, clickstream data, or draft content where losing a few seconds of data is acceptable.

---

**Intermediate:**

**Q: What are the consistency tradeoffs between write-through and write-back?**
**A:** *Write-through:* cache and database are always consistent. Any server can read from cache and get the current truth. Downside: write latency = DB latency (you wait for both). *Write-back:* fast writes but cache and DB are temporarily inconsistent. If the cache server crashes and the background flush hasn't run, data written to cache but not yet DB is permanently lost. If you read while the flush is pending, you read a value the DB doesn't yet know about â€” can cause issues in multi-server environments.

**Q: How does write-through interact with horizontal scaling?**
**A:** With write-through, every write goes to both the shared cache and database. This is safe under horizontal scaling because all servers write to the same shared cache (Redis) and the same database. Under write-back, the risk increases because if Server 1 holds pending writes in memory (not yet flushed) and Server 1 crashes, those writes are lost regardless of the database's state. Pure write-back implementations often use Redis as the write buffer and run a dedicated flusher process to prevent this.

**Q: What is the write-around strategy and when is it useful?**
**A:** Write-around bypasses the cache on writes â€” data goes directly to the database and is NOT written to cache. Next read misses cache â†’ fetches from DB â†’ populates cache with TTL. Best for: write-heavy data that is never (or rarely) read back (write-once, rarely-read-again). Example: audit logs (write millions per hour, rarely queried), bulk import data. Avoids polluting the cache with data that won't benefit from caching.

---

**Advanced (System Design):**

**Scenario 1:** Design the write caching strategy for a high-frequency ride-sharing app where driver GPS coordinates are updated every 2 seconds per driver, and 100,000 active drivers are online simultaneously. Reads (finding nearby drivers) are 50Ã— more frequent than position updates.

*Don't write-through to DB for every GPS update* â€” 100,000 updates/second to a relational DB is infeasible.
*Strategy:* Write-back with Redis as truth-of-record for live locations. GPS update â†’ write to Redis (GEOPOSITION sorted set, 1ms). Background worker batch-writes to DB every 30 seconds (for trip history). Reads â†’ always from Redis GEO sorted set (GEORADIUS command).
*Durability tradeoff:* losing 30 seconds of GPS history on Redis crash is acceptable. Trip completion writes (start/end) go write-through to DB â€” these are critical financial records.

**Scenario 2:** An e-commerce platform uses write-back caching for the shopping cart (fast, low-latency cart updates). A data center power event causes Redis to restart before the background flush. Users report their carts are empty. How do you prevent this in future architecture?

*Prevention:* Enable Redis AOF (Append-Only File) persistence with ppendfsync everysec â€” Redis writes each command to disk within 1 second, limiting data loss to 1 second. Use Redis Cluster with replication â€” data replicated to a replica before acknowledging write. Set min-slaves-to-write 1 so Redis only acknowledges writes after at least one replica confirms. Result: at most 1 second of cart data lost, only if both primary and replica fail simultaneously.

