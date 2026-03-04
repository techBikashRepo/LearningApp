# Cache-Aside Pattern — Part 2 of 3

### Topic: Real World Examples, System Design Importance, AWS Mapping & Interview Prep

**Series:** Scalability & Performance → Topic 07

---

## SECTION 5 — Real World Example

### The Hit Rate Determines If Cache-Aside Is Worth It

```
HIT RATE MATH:

  Variables:
    H = hit rate (fraction, 0–1)
    n = number of unique keys in working set
    c = cache capacity (max keys before eviction)
    λ = requests per second
    T = TTL in seconds
    r = average requests per key per TTL window

  Steady-state hit rate ≈ min(c/n, 1) × min(r, 1)

  PRACTICAL TRANSLATION:

  Product catalog: n = 10,000 products. c = 50,000 keys (Redis has space for all).
  Access pattern: 80/20 rule — 20% of products get 80% of requests.
  TTL: 30 min. Average requests per product per hour: 200 for hot products, 2 for cold.

  Hot 2,000 products: always in cache. Hit rate: ~100%.
  Cold 8,000 products: hit on first request per 30min window.
    8,000 products × 1 miss per 30min = 267 misses/min
    Total requests: λ = 10,000/min baseline
    Miss contribution from cold products: 267/10,000 = 2.7% miss rate

  Overall hit rate: ~97%. DB gets 3% of traffic.

WHEN HIT RATE COLLAPSES:

  1. HIGH KEY CARDINALITY + LIMITED CACHE:
     User search results: key = "search:{query}:{page}:{filters}"
     Millions of unique combinations → cache fills → LRU eviction thrashes.
     Cache becomes useless. Each evicted key is immediately requested again.
     Hit rate: < 10%. Net effect: added Redis overhead to EVERY request with no benefit.

     FIX: Only cache high-frequency queries.
          Add a frequency threshold: "only cache if this exact query was made > 5 times."
          Track query frequency in a Redis sorted set. Promote to cache once threshold met.

  2. HOT KEY PROBLEM — THE OPPOSITE FAILURE:
     One product goes viral (celebrity endorsement, news mention).
     1 million requests/minute all for product:viral_item.
     Redis: single key. One Redis PRIMARY handles all reads.
     Redis single-threaded: can handle ~1M ops/sec total.
     1M reads for one key = all Redis capacity consumed by ONE product.
     All other cache reads: queued behind the viral product.

     FIX: Hot key replication.
          Detect: track per-key request rate in Redis sorted set.
          When key exceeds threshold: replicate to multiple Redis keys.
          product:viral_item:shard:{0..N}  — round-robin reads across shards.
          Invalidation: DEL all N shards.

  3. CACHE MISS STORM (cold start):
     Redis restarts empty. All N concurrent requests miss.
     N requests hit DB simultaneously. DB overwhelmed.
     DB latency rises. App returns errors. Service appears down.

     FIX: Cache warming + request coalescing.
          Coalescing: when first request misses cache, set a Redis key with
          a "loading" flag. Other concurrent requests: see "loading" → wait
          briefly (poll 50ms intervals). First request: DB result → SET cache
          → release waiters. Only ONE DB query per key at a time.
```

---

## SECTION 6 — System Design Importance

### What Goes Wrong in Production with Cache-Aside

```
FAILURE MODE 1: THE STALE READ AFTER WRITE

  Timeline:
    t=0: Thread A reads product:99 → cache miss → DB read → cache SET { price: $29 }
    t=1: Admin updates price to $19 (flash sale) → DB UPDATE → redis.DEL product:99
    t=2: Thread B reads product:99 → cache miss → DB read... (DB reflecting $19 now)
    t=3: ... Thread A's cache SET from t=0 is already done. Already in cache.

    Wait — this is fine. The DEL at t=1 removes what Thread A set at t=0.
    Thread B at t=2 gets a fresh DB read.

    THE ACTUAL RACE CONDITION:
    t=0.0: Thread A reads product:99 → cache miss → starts DB query
    t=0.5: Admin updates price → DB UPDATE succeeds → redis.DEL product:99 (key doesn't exist yet)
    t=0.8: Thread A DB query returns { price: $29 } (stale — old value from before the UPDATE)
    t=0.9: Thread A: redis.SETEX product:99 { price: $29 } ← writes OLD price AFTER DEL!

    Cache now has: OLD price $29. DB has: NEW price $19. Cache TTL: 1 hour.
    For 1 hour: product:99 returns wrong price from cache.

FIX 1: Short TTL as a safety net.
  Even if the race condition occurs: damage is bounded by TTL.
  For pricing: TTL = 5 minutes. Max staleness window: 5 minutes + race window.

FIX 2: Version-based cache population.
  DB: add updated_at column.
  Cache SET: only if cached version < DB version.
  Thread A: before SET, check if cached or DB updated_at > your DB read timestamp.
  If yes: discard your result. Cache has newer data.

FIX 3: Cache-Aside with optimistic locking.
  Use Redis WATCH + MULTI/EXEC (transaction) to detect if key was modified
  between your read and your write:

  WATCH product:99          // watch for changes
  GET product:99            // if someone DELetes this key before EXEC:
  MULTI
  SETEX product:99 3600 {...}
  EXEC                      // returns nil if key changed since WATCH — abort SET

  If EXEC returns nil: someone invalidated the key between your DB read and your SET.
  That's correct behavior: the new value is already wrong. Don't write it.

──────────────────────────────────────────────────────────────────────────────

FAILURE MODE 2: CACHE WITHOUT A CIRCUIT BREAKER

  Redis becomes unavailable. Connection timeout: 5 seconds per attempt.
  Every request: tries Redis, waits 5 seconds, fails, falls through to DB.
  DB now receives 100% of traffic.
  DB also starts timing out from overload.
  Total request latency: 5s (Redis timeout) + 50ms (DB) = 5.05s.
  Users: perceive complete outage.

  FIX: Circuit Breaker on Redis.
  After N consecutive Redis failures: open the circuit.
  Open circuit: skip Redis entirely, go straight to DB.
  Half-open: after 30s, test Redis with 1% of requests.
  Close: Redis healthy → resume normal operation.

  Result: Redis outage → 5ms DB fallback path (no 5s timeout overhead).
  Performance degrades gracefully instead of catastrophically.

──────────────────────────────────────────────────────────────────────────────

FAILURE MODE 3: CACHE POISONING VIA DIRECT WRITES

  Some teams: on update, instead of DEL, they SET the cache with new value.
  "More efficient — saves one DB read on next access."

  Why this is dangerous:
    Request A: reads product at t=0. Gets old value from DB. Has not SET cache yet.
    Request B: admin update → SET cache with new value.
    Request A: SET cache with old value (arrives t=1, after B's SET).

    Cache poisoned: old value overwrites new value.
    Will persist until TTL expires.

  Pattern: SET on write creates a write ordering problem under concurrency.
  DELETE on write is safe: worst case = one extra DB miss.
  SET on write is dangerous: worst case = sustained incorrect data.
```

---

## SECTION 7 — AWS & Cloud Mapping

### The Three Guarantees Cache-Aside Provides (and Doesn't)

```
WHAT CACHE-ASIDE GUARANTEES:

  1. EVENTUAL CONSISTENCY:
     After a DB write + cache DEL:
     The next read will fetch fresh data from DB and re-populate cache.
     "Eventually" = after the current TTL expires OR after the next read post-DEL.
     For most use cases: this is sufficient.

  2. BOUNDED STALENESS:
     Even if DEL fails: TTL bounds the staleness window.
     Set TTL = max acceptable staleness for each data type.
     This is your worst-case consistency guarantee.

  3. DB REMAINS SOURCE OF TRUTH:
     On cache miss: you ALWAYS go to the DB.
     You never serve data that isn't in the DB (no cache-only data risk).

WHAT CACHE-ASIDE DOES NOT GUARANTEE:

  1. STRONG CONSISTENCY:
     Between a DB write and the cache DEL: a read can return stale data.
     The DEL is not atomic with the DB write.
     Gap window = time between DB commit and successful redis.DEL.
     In practice: milliseconds. Usually acceptable.
     For financial systems: milliseconds of wrong price = possible charge error.
     Solution: bypass cache for post-write reads in sensitive flows.

  2. MONOTONIC READS:
     User sees product at $19 (fresh DB read after DEL).
     User refreshes page.
     Cache is now repopulated. But was it repopulated with $19 or $29?
     (Depends on whether the race condition described in Section 6 happened.)
     User might see $29 on second read.

     This is a monotonic read violation: older value returned after a newer value was seen.
     Rare in practice. But possible without version-based population.

  3. READ-YOUR-OWN-WRITES:
     User submits form update. Write to DB. Cache DEL.
     User immediately GETs their updated data.
     REQUEST ARRIVES BEFORE CACHE IS REPOPULATED FROM DB.
     → DB read returns fresh data (correct).

     Actually this is fine for single-server.
     Problem: if DB write went to PRIMARY, reads go to REPLICA.
     Replication lag: user's own write may not be in replica yet.
     User sees their OWN stale data immediately after updating.

     FIX: For "read-your-own-writes" flows:
     Direct the read to the DB PRIMARY for a brief window after a user's own write.
     OR: after write, write a "just-updated:{userId}:{entity}" flag in Redis (short TTL).
     If flag exists: route read to DB primary. If not: use normal cache path.
```

---

## SECTION 8 — Interview Preparation

**Beginner:**

**Q: What is the Cache Aside Pattern?**
**A:** It's the most common caching approach: the application is "aside" (responsible for the cache). When data is needed: (1) Check cache first. If there â†’ return it. If not â†’ (2) Go to database. (3) Store result in cache with a TTL. (4) Return result. The app manages both the cache and the database directly â€” there's no automatic sync between them.

**Q: Who is responsible for updating the cache when data changes?**
**A:** Your application code. When you update data in the database, you must also either (a) delete the cache entry (so next read re-fetches fresh data) or (b) update the cache entry with the new value. If you forget to do this, the cache will serve stale data until the TTL expires.

**Q: When does Cache Aside work best?**
**A:** When reads are much more frequent than writes. Product catalogs, user profiles, configuration settings, reference data â€” anything that's read thousands of times per minute but updated only occasionally. It's also good when you can tolerate briefly stale data (e.g., product descriptions can be 1 hour stale; bank balances cannot).

---

**Intermediate:**

**Q: What is the race condition in Cache Aside and how do you handle it?**
**A:** Two concurrent requests both miss the cache simultaneously. Both go to the database. Both write to the cache. If the writes are version 1 and version 2 (from two different DB states), the second write overwrites the first. Solution: (1) Use SET key value EX ttl NX (NX = only set if not exists) â€” only the first write wins. (2) Use optimistic locking with a version number stored in the cache value. (3) For critical data, use a distributed lock (Redlock) to ensure only one writer at a time.

**Q: How do you implement Cache Aside correctly in Node.js with error handling?**
**A:** Key considerations: (1) Cache errors must be *non-fatal* â€” if Redis goes down, your app should continue by always going to the database (fallback). (2) Use 	ry/catch around all cache operations. (3) Set a short Redis operation timeout (connectTimeout, commandTimeout) so a slow Redis doesn't make your API slow. (4) Log cache errors to metrics but don't alert unless the hit rate drops significantly. (5) Never let cache failures cascade to user errors.

**Q: What is the N+1 problem with Cache Aside and how do you solve it?**
**A:** When loading a list of 100 items, each with a cache lookup: you do 100 cache GET operations, each potentially a miss â†’ 100 database queries. Solution: (1) mget for bulk cache reads (100 keys in one Redis command). For misses, batch the DB query: SELECT * FROM products WHERE id IN (missing_ids). (2) Cache the list itself: user:123:recent_orders â†’ cached list of IDs. This trades granularity for fewer cache operations.

---

**Advanced (System Design):**

**Scenario 1:** Design a caching layer for a social media feed where each user has a personalized timeline of posts from people they follow. The feed must be refreshed when new posts are created. You have 10 million users.

*Fan-out on write (push model):* When User A posts, immediately write to the cache of every follower. Cache key: eed:{userId} â†’ sorted set of post IDs by timestamp. Fast reads (< 5ms), expensive writes (celebrity with 1M followers = 1M cache writes).
*Fan-out on read (pull model):* When User B opens their feed, merge caches from all followed users. Flexible but slow for users following thousands of people.
*Hybrid:* Push only to users with < 10,000 followers (most users). Pull for celebrity accounts. Twitter uses this approach.

**Scenario 2:** Your cache hit rate has dropped from 85% to 40% over the past week without any code changes. Walk through how you diagnose and fix it.

*Diagnosis:* (1) Check Redis INFO keyspace â€” are keys evicting due to maxmemory? (2) Check key TTL distribution: are most keys expiring too quickly? (3) Check access patterns: is the traffic mix changing (more unique keys = lower hit rate)? (4) Check Redis memory: has usage increased (cached data growing)?
*Common fixes:* Increase Redis memory allocation. Adjust TTL to match access patterns. Pre-warm cache for predictable traffic. Eviction policy: switch to llkeys-lru to keep hot keys. Add cache key monitoring to alert on hit rate drops.

