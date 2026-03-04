# TTL Strategy — Part 2 of 3

### Topic: Real World Examples, System Design Importance, AWS Mapping & Interview Prep

**Series:** Scalability & Performance → Topic 10

---

## SECTION 5 — Real World Example

### How TTL Behaves Differently in Cache-Aside vs Write-Through vs Write-Back

```
TTL IN CACHE-ASIDE:
  Purpose:  (1) Freshness guarantee when DEL is missed
            (2) Memory management — expire cold entries

  Implementation: SETEX on cache population.
    const ttl = calculateTTL(entityType) + jitter();
    await redis.setex(key, ttl, JSON.stringify(value));

  TTL calibration with active invalidation:
    Have active DEL: TTL = 24h (safety net only).
    No active DEL: TTL = acceptable staleness window.

  Key insight: cache-aside TTL is a maximum staleness guarantee.
  In practice: active DEL means much shorter observed staleness.

TTL IN WRITE-THROUGH:
  Purpose:  Memory management ONLY (cache is always fresh from writes).
  Freshness is guaranteed by write-through (cache = DB always).
  TTL only evicts unused/cold entries to reclaim memory.

  TTL calibration:
    "How long should we keep data in cache after last access?"
    Very read-heavy data: long TTL (7d) — keep it warm.
    Rarely-read data: short TTL (1h) — evict quickly to save RAM.

  SLIDING EXPIRY is most appropriate for write-through:
    Reset TTL on every read → hot items stay indefinitely.
    Cold items: expire after inactive TTL.

    redis.GETEX key EX 3600   ← atomic GET + EXPIRE on hit.
    On write: SETEX key 3600 value (initial population).

  EDGE CASE: Write-through + sliding expiry + the race condition.
    Two concurrent writes, both try to SETEX with different values.
    Both also reset TTL on their read/write path.
    Last writer wins for value. Last TTL reset wins for expiry.
    Usually not a problem (both writes are "fresh" data).
    Can be a problem if write ordering matters (see Section 8 of Topic 08).

TTL IN WRITE-BACK:
  THE CRITICAL RULE: Write-back BUFFER keys must NEVER have TTL.

  Write-back buffer = unflushed writes pending DB sync.
  IF buffer key expires before being flushed = DATA LOSS.

  Buffer keys: no EXPIREAT, no SETEX.
    LPUSH write_queue:scores { playerId: 123, score: 9500, ts: 1720000000 }
    ← no expiry. Will persist until explicitly consumed.

  Display cache (different key from write-back buffer):
    product:display:99 = { price: 19 }  ← HAS TTL (for memory management).
    write_queue:product_updates = [...]  ← NO TTL (durable buffer).

  Two Redis keys, two different purposes, two different expiry behaviors.
  Conflating them is a common source of data loss bugs.

TTL IN MULTI-TIER CACHES:
  Different TTLs per layer ordered by latency and freshness tradeoff.

  L1 (in-process, e.g., node-lru-cache):
    Very short TTL: 30–60 seconds.
    Rationale: no pub/sub invalidation per-process. Must self-expire quickly.
    Staleness window = L1 TTL (30–60s). Must be acceptable.
    Only for: config, feature flags, slow-changing shared data.

  L2 (Redis):
    Medium TTL: 5 minutes–24 hours.
    Active DEL handles freshness.
    TTL is safety net + memory management.

  L3 (CDN):
    Shortest TTL for dynamic API responses (60s–5min).
    Reason: CDN holds data at edge, no per-request invalidation possible.
    Only explicit API call (CloudFront CreateInvalidation) removes a CDN entry.
    But CDN max-age: 60s means at most 60s stale even without invalidation.

  CONFIGURING PER-LAYER TTL:
    L1 TTL:  let l1Cache = new LRU({ ttl: 30_000 });    // 30 seconds
    L2 TTL:  redis.setex(key, 3600, value);              // 1 hour
    CDN TTL: Cache-Control: public, max-age=60, s-maxage=300    // 60s browser, 5min CDN
```

---

## SECTION 6 — System Design Importance

```
DEFINITION:
  Cache stampede = many concurrent requests simultaneously trigger
  the cache miss path (DB query + cache population) for the SAME key.

  After a TTL expiry OR on cold start, all concurrent requests that read
  the expired/absent key will each attempt a DB query.

  With N concurrent requests and DB query time of D seconds:
  DB receives N queries in rapid succession.
  Worst case: if each query is expensive, DB is overloaded immediately.

STAMPEDE LIKELIHOOD FACTORS:
  1. Request rate to the key (higher = worse stampede).
  2. DB query time (longer = more time for concurrent requests to pile up).
  3. TTL synchronization (synchronized TTLs = multiple popular keys expire together).
  4. Key hotness (the most popular key causes the worst stampede on expiry).

SOLUTION 1: MUTEX / SINGLETON PATTERN (simple, high latency under load)

  On cache miss: try to acquire a lock before querying DB.

  const lock = await redis.set(
    `lock:${key}`, '1', 'NX', 'EX', 10  // NX = only if not exists, EX 10 = 10s TTL
  );

  if (lock) {
    // I am the "leader" — query DB and populate cache
    const data = await db.query(id);
    await redis.setex(key, ttl, JSON.stringify(data));
    await redis.del(`lock:${key}`);
    return data;
  } else {
    // Someone else is populating — wait and retry
    await sleep(50);  // wait 50ms
    return getFromCacheOrDb(id);  // recursive retry
  }

  PROBLEM: Waiters are queued. Each waits 50ms, retries.
  For very high QPS (10,000/sec) on a hot key:
  Hundreds of requests queue waiting for lock. Latency spikes.
  If lock holder crashes without deleting lock: all waiters wait 10s (lock TTL).

  OK FOR: moderate QPS, acceptable tail latency during stampede.
  NOT FOR: extremely high QPS hot keys with strict latency SLOs.

SOLUTION 2: EARLY EXPIRY NOTIFICATION (LOCKING + SERVE STALE)

  Serve stale value to waiters while recomputing.

  // Store separate: value + expiry_time
  const cached = await redis.hgetall(key);  // { data: "...", expires: "1720000000" }

  const isExpired = Date.now() / 1000 > parseInt(cached.expires);

  if (!isExpired) return JSON.parse(cached.data);  // fresh

  // EXPIRED. Try to acquire recompute lock.
  const lock = await redis.set(`lock:${key}`, '1', 'NX', 'EX', 5);

  if (lock) {
    // Leader: recompute
    const fresh = await db.query(id);
    const newExpires = Math.floor(Date.now() / 1000) + 3600;
    await redis.hmset(key, { data: JSON.stringify(fresh), expires: newExpires });
    await redis.del(`lock:${key}`);
    return fresh;
  } else {
    // Not the leader: serve STALE data while leader recomputes.
    // Users see slightly stale data. No queuing. No latency spike.
    return JSON.parse(cached.data);  // ← STALE, but served immediately
  }

  EFFECT: Only 1 request hits DB on expiry (lock holder).
  All other concurrent requests: served stale data immediately (0 added latency).
  After leader populates: next requests get fresh data.
  Stale window: at most DB_query_time seconds (e.g., 200ms).

  BEST FOR: high QPS hot keys. Tiny staleness window. No queuing.

SOLUTION 3: BACKGROUND REFRESH (TTL-DRIVEN ASYNC RECOMPUTE)

  Key NEVER expires from user perspective.
  Background job: refreshes keys before they expire.

  Strategy: set actual TTL = 2 × refresh_interval.
  Background job: runs every refresh_interval.
  On each run: re-fetches from DB + writes to Redis.

  Example: Refresh interval = 5min. Redis TTL = 10min.
  Background job: runs every 5 minutes, updates cache.
  Redis key: refreshed at 5 min. Expires at 10 min (never reached if job runs on time).

  FAILURE MODE: Background job fails.
  Key age: 5min (job failed), 10min (key expires).
  First miss after 10min: triggers synchronous recompute.
  Stampede possible but rare (only on background job failure).

  Alert: background cache refresh failure → PagerDuty.
  This is a silent degradation otherwise.
```

---

## SECTION 7 — AWS & Cloud Mapping

### TTL as an Active Memory Management Tool

```
REDIS MEMORY WITHOUT TTL DISCIPLINE:

  Team adds caching without TTL on some keys.
  No TTL: keys persist forever (unless evicted by maxmemory policy).

  Over time:
    Stale users: user:99999:profile cached. User deleted from DB 2 years ago.
                 Profile cached forever (no TTL). Uses memory. Returns stale deleted user.

    Old sessions: session:sess_abcde123 cached. Session expired by auth system.
                  Redis still has the session. Forever.
                  Served to: nobody (auth service checks its own expiry), but wastes memory.

    Old search results: search:v1:?query=old_product_page:1 cached.
                        Product deleted. Search result cached forever with "ghost" product.

  Without TTL: Redis memory grows monotonically.
  Eventually: maxmemory reached → eviction policy fires.
  With allkeys-lru: evicts even your critical live data.
  With noeviction: writes start blocking.

TTL AS FIRST-CLASS MEMORY MANAGEMENT:

  Rule: EVERY key in production Redis should have a TTL.
  Only exceptions:
    Write-back buffers (must not expire — data loss risk).
    Counter keys that are read and reset in application logic (not cache).
    Distributed lock keys (expire when lock releases or TTL fires as deadlock prevention).

  Reasoning: "If I can't tell you how long this data is useful, I can't cache it."

MEMORY SIZING WITH TTL:

  Formula: Redis working set size at steady state =
    Σ (keys_of_type × avg_value_size_bytes × (average_TTL / average_inter-access-interval))

  Simplified intuition:
    Product details: 10,000 active products × 2KB per product × (3600s TTL / 60s avg access interval)
    = 10,000 × 2,048 × 60  = ~1.2GB   [keeps products alive 60 hit-refreshes]

    With sliding expiry: hot products never expire. Cold products expire after TTL.
    Working set ≈ hot products only.

    If hot product count = 1,000 (top 10% of catalog):
    1,000 × 2KB = 2MB for product detail cache.

EVICTION POLICY + TTL INTERACTION:

  maxmemory-policy options and their interaction with TTL:

  allkeys-lru:      Evicts any key by LRU (ignores TTL).
                    Good: caches where ALL keys have TTL and LRU is acceptable.

  volatile-lru:     Evicts only keys WITH a TTL set, by LRU.
                    Keys without TTL: NEVER evicted.
                    Good: mixed use (cache + write-back buffers).
                    Write-back buffers (no TTL): protected from eviction.
                    Cache entries (have TTL): subject to LRU eviction.

  allkeys-lfu:      Evicts any key by LFU (frequency, not recency).
                    Better than LRU for "scan" access patterns.

  volatile-ttl:     Evicts keys with TTT that are closest to expiry first.
                    Intuitive but dangerous: near-expiry keys may still be hot.
                    Usually inferior to volatile-lru/lfu.

  noeviction:       Reject writes when memory full. Reads still work.
                    Good for write-back systems where data loss is unacceptable.
                    Bad for pure caches: write failure propagates up to application.

  RECOMMENDATION PER USE CASE:
    Pure cache only: allkeys-lru or allkeys-lfu.
    Cache + durable buffers: volatile-lru (protect no-TTL write buffers).
    Write-back only: noeviction (never evict unflushed writes).
    Session storage: volatile-lru (sessions have TTLs; don't evict other critical data, use dedicated instance).
```

---

## SECTION 8 — Interview Preparation

**Beginner:**

**Q: What is TTL (Time to Live) in caching?**
**A:** TTL is the expiry timer on a cached item. You say "cache this for 1 hour" and after 1 hour, it automatically disappears â€” the next request must go to the database to get fresh data. Like food expiry dates: a snack is good for a week, milk for 3 days, fresh fish for 1 day. The more perishable (changeable) the data, the shorter the TTL.

**Q: How do I choose the right TTL for my data?**
**A:** Ask two questions: (1) How often does this data actually change? And (2) How bad is it if a user sees stale data? For static content (app logo, terms of service): TTL = 24 hours. For user profiles: 15 minutes. For product inventory counts: 30 seconds. For financial balances: NO caching (or TTL = 1-5 seconds max). Match TTL to the acceptable staleness window.

**Q: What happens when ALL my cache keys expire at the same time?**
**A:** All requests suddenly miss cache simultaneously and hit the database â€” this can overwhelm it. This is called a "cache stampede." Prevention: add random jitter to TTLs. Instead of TTL = 3600, use TTL = 3600 + random(0, 300). Keys now expire at different times, spreading the database load. Always add jitter for caches storing many similar items (product pages, user profiles, etc.).

---

**Intermediate:**

**Q: What is sliding TTL vs. fixed TTL and when should each be used?**
**A:** *Fixed TTL:* the timer starts when the item is first cached. After X seconds, it expires regardless of how recently it was accessed. Simple, predictable. *Sliding TTL:* the timer resets on every access â€” if accessed within the TTL window, it's extended. Redis supports this with GETEX (get + extend TTL). Use fixed TTL for content that must be refreshed on a schedule (exchange rates, prices). Use sliding TTL for session data (user stays logged in as long as they're active; times out only after inactivity).

**Q: What is the minimum recommended TTL and what happens with very short TTLs?**
**A:** In practice, TTL below 1 second defeats the purpose of caching for most use cases (database latency of 10-50ms means you'd need thousands of identical requests per second for sub-1s caching to help). Very short TTLs (1-5s) are valid for: rate limiting (per-second counters), real-time dashboards, or deduplicating events. The overhead of cache operations (serialization, network) may exceed the benefit if TTL < connection time to Redis (~1ms within same VPC).

**Q: How do you use cache warming to prevent cold start cache misses after a deployment?**
**A:** *Cache warming* = pre-populate the cache with hot data before traffic hits. Strategies: (1) Run a warming script before deploy that reads the top 1000 most-accessed items from DB and writes them to Redis. (2) Continue serving the old cache while deploying (blue/green) â€” new instances inherit the warm cache. (3) Use a "lazy read" approach with short TTL during the first 5 minutes after deploy, then extend TTL once warmed. For highly predictable traffic patterns, schedule warming before business hours.

---

**Advanced (System Design):**

**Scenario 1:** You manage a news aggregator where articles are frequently updated during breaking news events. Normally, a 10-minute TTL is acceptable. During breaking news, you need near-real-time updates (30-second freshness). Design an adaptive TTL system.

*Solution:* Tag articles with a "volatility" score (updated by editors or by system detecting rapid edits). Normal articles: TTL = 600s. Articles tagged "breaking" or edited > 3Ã— in the last hour: TTL = 30s. Implement in application logic: cacheTTL = article.breaking ? 30 : 600. Additionally, use event-driven invalidation (editor saves article â†’ publish Redis pub/sub message â†’ invalidate that specific article's cache immediately). Adaptive TTL reduces database load vs. a blanket 30s TTL for all articles.

**Scenario 2:** Your Redis cluster has a memory limit of 8GB. You're caching 5 types of data with different TTLs and access frequencies. Design the memory allocation and eviction strategy to maximize cache hit rate.

*Analysis:* Calculate memory per key type Ã— key count. Identify high-value keys (high request frequency Ã— high benefit from caching). Use edis-cli --bigkeys to find memory hogs. Strategy: (1) Set maxmemory-policy allkeys-lru so Redis automatically evicts least-recently-used keys when memory fills. (2) Explicitly set longer TTLs (24h) on high-value low-change data (product descriptions) and shorter TTLs on volatile data. (3) Use Redis OBJECT ENCODING to check if strings are compressed. (4) Enable key compression: store JSON-compressed values. (5) Monitor with INFO memory â€” if mem_fragmentation_ratio > 1.5, consider Redis restart or cluster rebalancing.

