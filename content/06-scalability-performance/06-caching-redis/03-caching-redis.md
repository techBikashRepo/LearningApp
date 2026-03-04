# Caching & Redis — Part 3 of 3

### Topic: AWS Certification Focus, Comparison Tables, Quick Revision & Architect Exercise

**Series:** Scalability & Performance → Topic 06

---

## SECTION 9 — Certification Focus (AWS SAA)

### TTL Is Not a Performance Knob — It's a Consistency Contract

```
TTL DESIGN PRINCIPLE:
  "Set TTL based on how long stale data is acceptable for this specific data type —
   NOT based on what makes the hit rate look good."

  Wrong mindset: "1-hour TTL gives us 95% hit rate. Problem solved."
  Right mindset: "For this data type, can we accept a 1-hour old value?
                  If yes: 1hr TTL is correct.
                  If no: shorter TTL, or active invalidation, or bypass cache."

TTL REFERENCE TABLE (production-calibrated):

DATA TYPE                           TTL           REASONING
────────────────────────────────────────────────────────────────────────────────
Product catalog (name, description)  24 hours    Rarely changes. Low staleness risk.
Product price                        5 minutes   Can change. Business impact if stale.
                                                  Invalidate on update as well (belt+suspenders).
Inventory / stock count              60 seconds  Changes constantly. Display only.
                                                  ALWAYS bypass cache for final purchase check.
User profile (name, avatar)          1 hour      Changes infrequently. Stale: low impact.
User roles / permissions             5 minutes   Security-sensitive. Short TTL.
                                                  On role change: DEL immediately.
Auth session                         Matches     Set TTL = session expiry time.
                                     session TTL Don't let TTL expire before session does.
Exchange rates                       30 minutes  Changes during trading hours. Acceptable lag.
API responses (3rd party)            15 minutes  Reduces external API usage + cost.
Search results                       2 minutes   Freshness expected. But 2m is tolerable.
Leaderboards / rankings              1 minute    Near-real-time feel. Avoid DB aggregation.
Static config / feature flags        10 minutes  Or use pub/sub invalidation on toggle.
Computed aggregates (report data)    1-8 hours   Heavy computation. Accept staleness.
Rate limit counters                  Sliding     DO NOT use TTL — use atomic increments.
                                     window      (INCR + EXPIREAT based on window start)
```

---

### TTL Anti-Patterns (What Breaks in Production)

```
ANTI-PATTERN 1: THUNDERING HERD / CACHE STAMPEDE

  SCENARIO:
    10,000 users hit your homepage. The homepage data (top products, trending)
    is cached with TTL = 3600s.
    At exactly 10AM: the TTL expires.

    Within milliseconds: 500 concurrent requests for the homepage arrive.
    All: cache miss (key expired).
    All 500: query the DB simultaneously.
    DB: 500 concurrent queries for the same expensive aggregation.
    DB CPU: spikes to 100%. All 500 queries take 8 seconds.
    Homepage: down or severely degraded for 8 seconds.

    Every hour on the hour: this happens. Predictable. Avoidable.

  FIX 1: Jitter / Randomized TTL
    Instead of: TTL = 3600
    Use: TTL = 3600 + random(0, 300)
    Effect: keys expire within a 5-minute window — not simultaneously.
    Stampede: 500 queries → spread over 5 min → 1-2 per second. DB handles it.

  FIX 2: Background Refresh (Pre-Expiry Re-Population)
    Before TTL expires: a background worker re-queries DB, updates cache.
    Users: never see a cache miss. Always served fresh data (within refresh interval).

    Implementation:
      Store TWO TTLs in the value:
      { data: {...}, soft_ttl: <timestamp 5min from now>, hard_ttl: (Redis TTL 10min) }

      When soft_ttl < now BUT Redis key still alive (hard_ttl not expired yet):
        Serve cached data. Trigger async re-check in background.
        One background request hits DB. Updates cache. No stampede.

  FIX 3: Probabilistic Early Expiry (XFetch algorithm, from Facebook research)
    The key: let individual requests probabilistically decide to re-fetch
    BEFORE the TTL expires. The probability increases as expiry approaches.

    expire_score = -1/β × ln(rand()) × recompute_time
    If current_time - (ttl_remaining) > -expire_score: re-fetch early

    Result: the first request to naturally trigger early re-fetch does so.
    Others keep getting cache hits. Stampede is eliminated.
    Widely deployed at Facebook, Twitter, LinkedIn.

──────────────────────────────────────────────────────────────────────────────

ANTI-PATTERN 2: THUNDERING HERD AFTER COLD START

  Redis fails. Replacement node comes up: EMPTY.
  All requests: cache miss → DB simultaneously.
  DB: cold start stampede. Same failure mode as expiry stampede.

  FIX: Cache Warming Script
    On startup (or before routing traffic to a new Redis node):
    Run: SELECT top 10,000 most-read product IDs from DB
         → warm each into Redis.
    THEN: start routing requests.

    AWS: can automate with an ECS task that runs before ALB target registration.
    Parameter: register target with ALB ONLY AFTER warmup script exits 0.

──────────────────────────────────────────────────────────────────────────────

ANTI-PATTERN 3: AGGRESSIVE TTL = FALSE CONFIDENCE

  Team sets TTL = 30 days for user permissions to maximize hit rate.
  Admin revokes a user's admin privileges.
  User: still has admin access for up to 30 days (cache still valid).
  Security incident.

  RULE: TTL for security-sensitive data (permissions, tokens, sessions):
        ALWAYS match to your acceptable revocation window.
        If you need instant revocation: don't cache, or maintain a revocation list.
```

---

## SECTION 10 — Comparison Table

### ElastiCache for Redis: Architecture Decisions

```
DEPLOYMENT MODES:

1. SINGLE-NODE (dev/staging only):
   One Redis instance. No replication. No HA.
   ✅ Cheapest. ✅ Simple.
   ❌ Single point of failure. Restart = empty cache.
   NEVER use in production for user-facing systems.

2. REPLICATION GROUP (standard production):
   1 primary (read+write) + 1-5 replicas (read-only).

   Primary handles:
     All writes (SET, DEL, EXPIRE, INCR).
   Replica(s) handle:
     Read traffic (scale read throughput).
     One replica auto-promoted to primary on primary failure.
     Failover time: ~10-60 seconds (DNS update propagation).

   Multi-AZ: deploy primary in AZ-A, replica in AZ-B.
             AZ-A upstream failure: replica in AZ-B promoted.

   Configuration:
     numShards: 1 (cluster mode disabled — single keyspace)
     numReplicas: 2 (1 primary + 2 replicas — at least 1 cross-AZ)
     automaticFailover: true
     multiAZEnabled: true

   WHEN TO USE:
     Working set fits in one node's RAM (< 26GB in most cases).
     Simple key-value cache patterns.
     Session storage.

3. CLUSTER MODE (large-scale):
   Data sharded across 1–500 shards.
   Each shard: 1 primary + 1-5 replicas.

   Keys distributed by CRC16(key) % 16384 (hash slot assignment).

   EXAMPLE: 3 shards, 6 nodes:
     Shard 1: Primary A (slots 0–5460), Replica A1
     Shard 2: Primary B (slots 5461–10922), Replica B1
     Shard 3: Primary C (slots 10923–16383), Replica C1

   WHEN TO USE:
     Working set > single-node RAM (> 50GB commonly).
     Write throughput exceeds single-primary capacity.
     Extreme read throughput (3 primaries × 1M ops/s = 3M ops/s aggregate).

   CAVEAT: CLUSTER MODE RESTRICTIONS
     Multi-key commands (MGET, MSET) only work if all keys are in the same slot.
     Lua scripts: all keys must hash to same slot.
     Transactions (MULTI/EXEC): all keys same slot.
     Solution: use hash tags: user:{user_123}:session and user:{user_123}:cart
               The {user_123} hash tag forces both keys to the same slot.
               Now MGET user:{user_123}:session user:{user_123}:cart works.

NODE SIZING GUIDE:

  Daily Active Users × Avg session size × Expected concurrent ratio = RAM needed

  EXAMPLE:
    1M DAU × 2KB session × 5% concurrent = 1M × 0.05 × 2KB = 100MB (tiny!)

  The WORKING SET is more important than DAU:
    How many unique keys are accessed frequently?
    "Frequently" = more than once per TTL cycle.
    If 50,000 products, each 1KB = 50MB working set.
    Node: cache.r7g.large (13GB RAM) provides ample headroom.

  RedisInsight or redis-cli --latency-history: identifies actual memory pressure.
  ElastiCache CloudWatch: DatabaseMemoryUsagePercentage > 80% → scale up.

──────────────────────────────────────────────────────────────────────────────

CLOUDFRONT AS L1 CACHE (in front of ElastiCache/App):

CACHE HIERARCHY:
  ┌──────────┐    ┌─────────────┐    ┌──────────────┐    ┌──────────┐
  │ Browser  │───►│ CloudFront  │───►│  ElastiCache │───►│ Database │
  │ (L0)     │    │ Edge Cache  │    │  Redis (L2)  │    │  (L3)    │
  │          │    │ (L1)        │    │              │    │          │
  └──────────┘    └─────────────┘    └──────────────┘    └──────────┘

  L0 (Browser cache): user-specific, short TTL for API responses, long for static.
  L1 (CloudFront):    public/shared content — product pages, images, API responses.
                     Edge nodes globally — sub-20ms for users near PoPs.
  L2 (ElastiCache):   Application-level cache — session data, computed values.
  L3 (Database):      Source of truth — only hit on full cache miss.

CLOUDFRONT CACHING STRATEGY:

  What to cache at CloudFront:
    ✅ Public product catalog API responses (/api/products/*)
    ✅ Static assets (images, CSS, JS — long TTL + versioned URLs)
    ✅ User-independent API responses (homepage, trending)

  What NOT to cache at CloudFront:
    ❌ User-specific API responses (GET /api/orders — per-user)
    ❌ POST / PUT / DELETE requests (must not be cached)
    ❌ Checkout / payment flows (freshness required)

  CloudFront cache key design:
    Default: { URL, Host, protocol }
    Add: Accept-Encoding header (gzip vs brotli = different cached objects)
    Remove: cookie header (unless cookies are part of the cache key)
             Most web app requests: strip all cookies/auth headers for public API caching.

  Invalidation:
    POST /2020-05-31/distributions/{distId}/invalidations
    { Paths: { Items: ["/api/products/99"] } }
    Cost: $0.005 per 1,000 paths.
    Latency: propagates to all PoPs in < 30 seconds.
    Use for: urgent incident response, product updates.
    Don't use for: routine cache management (TTL is cheaper).
```

---

## SECTION 11 — Quick Revision

**Scenario:** E-commerce platform. 2M daily active users. Peak: 50,000 concurrent users. Key endpoints:

1. `GET /products/:id` — 95% of traffic, read-only product data
2. `GET /users/:id/recommendations` — personalized recommendations, expensive ML computation (800ms)
3. `GET /cart/:userId` — user's cart, updated on every add/remove
4. `POST /checkout` — purchase flow, inventory deduction

Design the full caching strategy.

---

**Answer:**

```
ENDPOINT 1: GET /products/:id

  ANALYSIS:
    - 95% of traffic. High read frequency per product.
    - Data: name, description, price, images. Changes infrequently.
    - Price changes during sales — must handle correctly.

  STRATEGY: Cache-Aside with active invalidation + TTL safety net

  Redis key: product:{id}
  Data stored: JSON(id, name, description, price, imageUrls[])
  TTL: 15 minutes (safety net — not primary invalidation mechanism)
  Active invalidation: ON product UPDATE event/API → redis.del(`product:${id}`)

  CloudFront in front:
    Cache-Control: public, max-age=300 (5 min)
    Vary: Accept-Encoding
    CloudFront TTL: 5 minutes (shorter than Redis — freshness at edge matters more)

  Cache warmup:
    On deploy: pre-load top 5,000 most-viewed products.

  Expected hit rate: ~98% (warm cache + moderate invalidation)

──────────────────────────────────────────────────────────────────────────────

ENDPOINT 2: GET /users/:id/recommendations

  ANALYSIS:
    - Personalized per user (can't use CloudFront).
    - 800ms ML computation → MUST cache.
    - Recommendations change slowly (hourly is fine).
    - 2M users × 1 result set: high cardinality.

  STRATEGY: Cache-Aside + TTL + background refresh

  Redis key: recs:{userId}
  Data: JSON(array of 20 recommended product IDs)
  Size: ~500 bytes per user
  TTL: 30 minutes

  Background job:
    Every 20 minutes: re-compute recommendations for users active in last 24h.
    Pre-populate cache BEFORE TTL expires.
    Users: never see 800ms (always served from cache).
    New users (never seen): first request = 800ms (one-time wait).

  Priority tier:
    Limit Redis storage for recommendations: 500 bytes × 2M users = 1GB.
    Set eviction policy: volatile-lru (only evict TTL-bearing keys).
    Cold users' caches evict first. Hot users' caches remain.

  Expected hit rate: ~92% (some new users + cold starts)

──────────────────────────────────────────────────────────────────────────────

ENDPOINT 3: GET /cart/:userId

  ANALYSIS:
    - Mutable: changes on EVERY add/remove click.
    - User-specific: no CDN.
    - Must be reasonably fresh (< 5s stale acceptable).
    - But: cart GET is high frequency (page renders).

  STRATEGY: Write-through cache (cart is written AND cached on every mutation)

  Redis key: cart:{userId}
  Data structure: Redis HASH
    HSET cart:usr_a1 prod_99 "{ qty: 1, price: 29.99 }" prod_77 "{ qty: 2, price: 9.99 }"
    WHY HASH:
      - HGET single item without deserializing entire cart.
      - HSET single item update without re-serializing entire cart.
      - Atomic: no race condition on concurrent item adds.
  TTL: 24 hours (rolling — reset on every cart operation)

  On add-to-cart:
    1. DB: INSERT cart_items (userId, productId, qty, price)  ← persistent record
    2. HSET cart:{userId} productId JSON(qty, price)           ← atomic update

  On cart GET:
    HGETALL cart:{userId}  → 0.5ms, no DB hit.

  Note: cart in Redis is a performance copy of the DB.
  DB is the source of truth. On cache miss: rebuild from DB.

──────────────────────────────────────────────────────────────────────────────

ENDPOINT 4: POST /checkout

  ANALYSIS:
    - Writes: inventory deduction, order creation.
    - Financial: price MUST be fresh. Stock MUST be fresh (don't oversell).
    - Correctness > performance.

  STRATEGY: NO CACHE — bypass entirely for this path.

  Final inventory check: SELECT ... FOR UPDATE on DB.
  Price at checkout: read from DB directly (bypass product cache).

  Rationale:
    The order confirmation is a financial transaction.
    5-minute stale price can result in undercharging or dispute.
    Stock check from cache can allow overselling.

    The cost of ONE EXTRA DB READ at checkout is negligible.
    The cost of serving stale data at checkout is: refunds + support + reputation.

  POST-CHECKOUT INVALIDATION:
    After successful checkout:
    redis.del(`product:${id}`)     ← product page freshness (price + stock display)
    redis.del(`cart:${userId}`)    ← cart cleared

──────────────────────────────────────────────────────────────────────────────

FINAL ARCHITECTURE:

  Browser → CloudFront → App Servers → ElastiCache Redis → RDS Aurora

  Redis Cluster Configuration:
    Mode: Replication Group (not cluster mode — fits in single node RAM)
    Nodes: cache.r7g.large (13GB RAM) × 1 primary + 1 replica (cross-AZ)
    Eviction: allkeys-lru (for cache cluster) / volatile-lru (for cart cluster)
    Separate clusters:
      recs-cache cluster:   recommendations (allkeys-lru, no persistence)
      cart-session cluster: carts + sessions (volatile-lru, AOF persistence)
      NO: mixing these on one cluster (different eviction + persistence needs)
```

---

## SECTION 12 — Architect Thinking Exercise

**Q: "Why do we need caching? Can't we just scale the database?"**

> "Caching solves a different problem than scaling the database. The database is designed for consistency, durability, and flexible querying — not for serving thousands of identical reads per second at sub-millisecond latency. Even a perfectly-indexed DB query takes 5–50ms. Redis returns the same data in 0.3ms.
>
> Scaling the DB helps throughput (more queries per second) but doesn't change per-query latency. And DB scaling has hard limits — connection ceilings, I/O contention, connection pool exhaustion. Cache reduces _how much you ask the DB at all_. A 95% cache hit rate on product reads means the DB only handles 5% of the traffic it would otherwise. That's not a performance improvement — it's a 20× reduction in DB load. These are fundamentally different levers."

---

**Q: "What is the cache invalidation problem and how do you handle it?"**

> "Cache invalidation is the problem of ensuring cached data reflects the current state of the source after a change. The naïve approach — delete on write, re-populate on miss — works but has a race condition: a reader can re-populate the cache with stale data between the DB write and the DEL call.
>
> In production I layer three defenses: First, TTL as the ultimate safety net — even if all else fails, staleness is bounded. Second, active invalidation — DEL the key whenever the source changes (always after the DB commit, never before). Third, for high-write or security-sensitive data, event-driven invalidation via a message queue so invalidation is decoupled, ordered, and retried on failure.
>
> The critical rule: never cache data where stale = business or security error without also having a revocation mechanism."

---

**Q: "A cache starts returning stale product prices intermittently. Walk me through your debugging approach."**

> "First, I'd check active invalidation: is the price update service calling `redis.del(product:{id})` after the DB write? I'd look at application logs for the update path — is the DEL actually being called? Is it erroring silently?
>
> Second, check the ordering: some teams write to cache BEFORE confirming the DB commit. If DB write fails, the cache now has a value the DB doesn't. I'd look for set-before-commit patterns.
>
> Third, check for the race condition: is a concurrent reader re-populating the cache with the old value AFTER the DEL? This appears as: DEL succeeds, immediately followed by a SET with old value.
>
> Fourth, check Redis replication: if reads go to replicas and there's replication lag, writes to primary take 10–100ms to reach replicas. A read immediately after a write might hit replica before replication completes.
>
> The fix depends on which layer is the cause: TTL reduction, explicit read-from-primary for post-write reads, or moving to event-driven invalidation with ordering guarantees."

---

## === Architect's Mental Model ===

### 5 Decision Rules

**Rule 1: Cache data proportional to how often it's read relative to how often it changes.**
Product names: read millions of times, changed once a month — ideal cache candidate. Shopping cart: read and written with equal frequency — cache the read path, but write-through is viable. Real-time inventory count: changes every transaction — do not cache for transaction decisions, only for display. The ratio of reads to writes is the fundamental cache sizing input.

**Rule 2: Cache at the right layer — not just at the closest layer.**
CloudFront handles requests before your servers are even involved. A CDN cache hit saves not just DB load but also app server CPU, Redis bandwidth, and network RTT. Cache-aside in Redis reduces DB load but still costs app server processing. Design the cache hierarchy from the outside in: CDN first, Redis second, DB last. The outermost cache that can satisfy the request should be used.

**Rule 3: Use separate Redis clusters for cache vs session vs queue.**
Cache: needs aggressive eviction (allkeys-lru), no persistence, accepts memory pressure. Sessions: must not be evicted (users logged out), needs persistence (AOF), TTL-based expiry. Queues: durability required, no eviction. Mixing these on one Redis instance means session eviction during cache memory pressure — logged-out users at peak traffic. The cost of a second instance is trivially low compared to that incident.

**Rule 4: Every cache key design must include a namespace and a version path.**
key format: `{service}:{version}:{entity}:{id}` — e.g., `catalog:v2:product:99`. Namespaces prevent cross-service key collisions when sharing a Redis cluster. Version path enables instant cache invalidation on schema change: bump v2 → v3, all old keys simply expire (never matched, never read). Without versioning: a schema change requires flushing the entire cache or complex migration logic.

**Rule 5: Short TTL + active invalidation is almost always better than long TTL alone.**
Long TTL logic: "high hit rate, good performance." What it hides: 1-hour stale data on every update, failed invalidation causing multi-hour staleness, security-sensitive data served from cache after revocation. Short TTL (5–15 min) bounds the damage window for ALL failure modes. Add active invalidation for immediate correctness on writes. The two together give you both performance AND correctness guarantees.

---

### 3 Common Mistakes

**Mistake 1: Caching at checkout, payment validation, and inventory deduction.**
These are the three points where stale data causes direct financial harm and regulatory exposure. No matter how fast your Redis is, these operations must read from the primary DB inside a transaction. A commonly seen incident: product price cached at $9.99, actual price updated to $99.99, thousands of orders placed at $9.99 before TTL expires. The revenue loss in 15 minutes can exceed an entire month of Redis costs. Rule: identify "high-stakes reads" explicitly in your data model, and never cache them.

**Mistake 2: Storing JSON blobs for everything instead of using Redis data types.**
A user cart stored as a JSON string: to add one item, you GET the string, parse it, append, serialize, SET it back. Two Redis commands, full serialize/deserialize, and a race condition if two tabs add items simultaneously. The same cart as a Redis HASH: HSET is atomic, operates on one field, no race condition, no full re-serialization. Redis gives you Strings, Hashes, Lists, Sets, Sorted Sets, and more — each with 10–50 specific commands. Treating Redis as a dumb string store ignores 90% of its value.

**Mistake 3: Not measuring cache hit rate continuously.**
A team builds a caching layer, measures 92% hit rate at launch, and never looks at it again. Over 12 months: the product catalog grows 10×, more users arrive, DB query patterns change, new endpoints are added without caching. Hit rate drifts to 60%. The DB is struggling. Nobody knows why. The team adds more DB read replicas (expensive). The actual fix: add missing cache keys, tune eviction policy, increase Redis memory. Hit rate metrics should be a dashboard staple beside CPU and error rate — not a one-time launch measurement.

---

### 30-Second Interview Answer

> "Caching is needed because databases are designed for consistency and durability, not for serving thousands of identical reads per second. A DB query takes 5–50ms minimum; Redis returns the same data in 0.3ms. More importantly, a cache removes the load from the DB entirely — a 95% hit rate means the DB handles 5% of what it otherwise would. The architectural shift is non-trivial: a cache introduces two sources of truth, which creates cache invalidation, staleness windows, and race conditions as new failure modes. The key decisions are: what pattern (cache-aside is standard), what TTL per data type based on acceptable staleness, active invalidation on writes for consistency, and crucially — what NOT to cache: checkout, payments, and security-sensitive reads must always go to the DB."

---

_End of Topic 06 — Caching & Redis_
