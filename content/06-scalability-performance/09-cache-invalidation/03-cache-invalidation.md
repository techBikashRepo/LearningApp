# Cache Invalidation — Part 3 of 3

### Topic: AWS Certification Focus, Comparison Tables, Quick Revision & Architect Exercise

**Series:** Scalability & Performance → Topic 09

---

## SECTION 9 — Certification Focus (AWS SAA)

```
THE DUAL ROLE OF TTL IN AN INVALIDATION SYSTEM:

  Role 1: FALLBACK for missed invalidations.
  Role 2: MEMORY MANAGEMENT (evict unused entries).

  With active invalidation: TTL is long (hours/days).
  Rationale: DEL handles freshness. TTL only needed for:
    - Missed invalidations (race conditions, system failures)
    - Memory pressure relief (evict cold entries)

  TTL CALIBRATION FOR INVALIDATION SYSTEMS:

  Active invalidation present → TTL = longest acceptable staleness window
  No active invalidation → TTL = shortest acceptable staleness window

  Data type              | Invalidation type       | TTL recommendation
  ─────────────────────────────────────────────────────────────────────
  User email/phone       | Active (DEL on update)  | 24 hours
  Product price (flash)  | Active + CDN invalidation| 5 minutes
  Product description    | Active on edit           | 7 days
  Search result page     | Active (dependency map)  | 2 hours
  Category list          | Active (tag-based)       | 4 hours
  Auth permissions       | Active (immediate DEL)   | 15 minutes
  Read-only reference    | TTL only (never changes) | 7 days
  Config/feature flags   | TTL + pub/sub (L1)       | 5 minutes

JITTER FOR INVALIDATION SYSTEMS:
  When a batch of entities is invalidated simultaneously
  (e.g., "all products on sale" — 5,000 products updated during flash sale prep):
  5,000 cache DELs → 5,000 concurrent DB reads as cache re-warms.

  Option 1: Pre-warm the cache after batch invalidation.
    Before going live with the sale:
    Proactively re-cache all 5,000 products from DB.
    No miss storm on launch.

  Option 2: Stagger invalidations.
    Pipeline DELs in batches of 500, with 100ms pause between batches.
    Cache re-warm requests spread over 1 second instead of simultaneous.
    DB: handles gradual re-warm instead of spike.

NEGATIVE TTL — Caching Absence of Data:
  Request for product:99999 (doesn't exist).
  DB query: returns null.
  WITHOUT negative caching: every request → cache miss → DB query → null.
  Attack: scan for non-existent IDs → DB flooded.

  WITH negative caching:
    redis.SETEX("product:99999", 60, "__null__")
    Next 60 seconds: cache HIT → return null. Zero DB queries.

  Invalidation of negative cache:
    Product is CREATED (product:99999 is now real):
    DEL the negative cache entry.
    Otherwise: users get "product not found" for up to 60 seconds after creation.
    Active invalidation: required for negative cache entries on create operations.
```

---

## SECTION 10 — Comparison Table

### Multi-Layer Invalidation on AWS

```
AWS CACHE INVALIDATION ARCHITECTURE:

┌─────────────────────────────────────────────────────────────────────┐
│                         WRITE PATH                                   │
│                                                                       │
│  1. PUT /api/products/99         2. Aurora UPDATE committed          │
│     (API Gateway)                   (RDS Aurora Primary)             │
│                                                                       │
│  3. Application:                 4. ElastiCache:                     │
│     redis.del("product:v1:99")      Key removed. Next read: DB.      │
│     (ElastiCache)                                                     │
│                                                                       │
│  5. EventBridge Event published: 6. CloudFront Invalidation:         │
│     { type: "product_updated",       PUT /2020-11-20/distributions/  │
│       id: 99, fields: ["price"] }    {id}/invalidation               │
│     → SNS/SQS Fanout                 Paths: ["/api/products/99",     │
│       → Other services subscribe      "/api/products/99/*"]          │
│                                       15–30s propagation             │
└─────────────────────────────────────────────────────────────────────┘

CLOUDFRONT INVALIDATION SPECIFICS:
  Cost: First 1,000 paths/month: FREE. After: $0.005 per path.
  Wildcard: "/api/products/*" counts as 1 path.
             Invalidates ALL objects matching that pattern.
  Latency: 5–15s for most edge locations. Up to 30s globally.

  STRATEGY: Use wildcards for batch invalidation.
    Bad: invalidate 5,000 individual product paths.
         5,000 × $0.005 = $25 per batch operation.
    Good: invalidate "/api/v1/products/*" (wildcard = 1 path).
         $0.000005. Invalidates all product endpoints.

    Tradeoff: wildcard invalidates MORE than needed.
    Valid for batch operations. Use targeted paths for individual product updates.

ELASTICACHE KEYSPACE NOTIFICATIONS FOR AWS:
  ElastiCache: supports Redis keyspace notifications.
  Lambda can subscribe via ElastiCache Redis pub/sub:

  Lambda (consumer function):
    const subscriber = new Redis(process.env.REDIS_URL);
    await subscriber.config('SET', 'notify-keyspace-events', 'Kxe');
    await subscriber.subscribe('__keyevent@0__:expired', '__keyevent@0__:del');

    subscriber.on('message', async (channel, key) => {
      if (key.startsWith('product:')) {
        await cloudfront.createInvalidation({ Paths: { Items: [`/api/${key}`] } });
      }
    });

  USE CASE: CDN invalidation triggered by Redis key expiry.
  When cache key expires: automatically invalidate CDN path.
  Keeps CDN and Redis in sync without explicit invalidation code in write paths.

DynamoDB STREAMS + LAMBDA INVALIDATION:
  If using DynamoDB as DB:
    DynamoDB Streams: publishes every item change (INSERT, UPDATE, DELETE).
    Lambda: reads stream → determines affected cache keys → DEL from ElastiCache.

  This is fully decoupled CDC-based invalidation on AWS:
    Application writes to DynamoDB.
    Zero invalidation logic in the application.
    Lambda automatically handles cache invalidation from the stream.

  Limitation: Lambda stream processing has up to 1s latency.
  For sub-second invalidation requirements: explicit DEL in the write path still needed.
```

---

## SECTION 11 — Quick Revision

**Scenario:** E-commerce platform. Flash sale starts at 12:00 PM. 10,000 products have their prices reduced for 4 hours. At 4:00 PM, all prices revert. Design the cache invalidation strategy for the price change — both at 12:00 PM and 4:00 PM. The product detail page hit rate is normally 95%. During the flash sale: 3× normal traffic.

---

**Answer:**

```
CHALLENGE ANALYSIS:
  Two events: 12:00 PM (price drop to sale price) and 4:00 PM (price reverts).
  10,000 products. 3× traffic. Normal TTL for product cache: 1 hour.
  Without intervention: products cached at 11:59 AM with regular prices
  will serve wrong prices until cache expires (up to 12:59 PM for some).

  At 4:00 PM revert: same problem in reverse — sale prices stay cached
  after the sale ends.

SOLUTION: SCHEDULED BATCH INVALIDATION + PRE-WARMING

  STEP 1: PRE-WARM BEFORE SALE (11:50 AM)
    Job runs 10 minutes before sale:
    - Fetch all 10,000 sale products from DB.
    - For each: SET cache key with sale price (overwriting regular price).
    - Use MSET pipeline: 10,000 SETEX in batches of 500 (20 batches, 200ms total).
    - CDN: pre-populate origin responses with sale prices.
    - CDN invalidation: "/api/products/*" wildcard (1 path, ~$0.000005).

    At 12:00 PM: ALL 10,000 products already cached with sale price.
    No miss storm. Cache hit rate: maintained at 95%+ during 3× traffic spike.

  STEP 2: REAL-TIME SALE ACTIVATION (12:00 PM)
    Application: batch DB UPDATE setting sale prices.
    If pre-warm was successful: cache already has sale prices. No action needed.

    Safety: if pre-warm missed some products (< 72hr since last cache population):
      Any missed keys: will serve old price for up to TTL seconds.
      Mitigation: set TTL = 5 minutes during sale window.
      "Small TTL + pre-warm" = max 5 min staleness + near-100% hit rate.

  STEP 3: SALE END (4:00 PM)
    Same pre-warm approach:
    - 3:50 PM: batch reset cache with original prices.
    - CDN: wildcard invalidation.
    - At 4:00 PM: DB reverts prices. Cache already has original prices.

    If pre-warm missed any: TTL 5 minutes → self-heals within 5 minutes of sale end.

  CACHE KEY VERSIONING ALTERNATIVE:
    Instead of DEL/SET per key:
    During sale window: use key product:sale:v1:{id}.
    Pre-sale: product:v1:{id}.
    Router: if sale_active → use product:sale:v1:{id} key. Else: product:v1:{id}.

    At sale end: flip the flag. product:sale:v1:* keys are abandoned.
    They expire via TTL. Zero explicit invalidation at 4:00 PM.
    No mass-DEL required. No CDN invalidation at 4:00 PM either.

    This is the cleanest approach at scale:
    Zero invalidation events. Instant switch via a feature flag.
    Old keys self-expire. New keys cold-start on first miss (which hits pre-warm).

  TRAFFIC CONCERN (3× spike):
    With pre-warm: cache hit rate at 95%. DB receives 5% of 3× traffic.
    = 15% of normal DB load. Manageable.

    Without pre-warm + correct invalidation:
    First 5 minutes of sale: near-0% hit rate (mass invalidation).
    100% of 3× traffic hits DB. DB overwhelmed.
    Response time: degrades. Sale launches to a slow/broken site.
    Pre-warm is therefore a BUSINESS-CRITICAL operation for flash sales.
```

---

## SECTION 12 — Architect Thinking Exercise

**Q: "Explain the race condition in cache invalidation and how you prevent it."**

> "The race condition happens when a read populates the cache with stale data AFTER a write has already invalidated the key. Here's the timeline: Thread A misses the cache, reads old value from DB (the DB read happens before the write commits). Thread B then writes the new value to DB and DELetes the cache key. Thread A, whose DB read returned old data, then writes that old data to cache. The DEL from Thread B was a no-op because Thread A hadn't written yet.
>
> The best general mitigation is shorter TTLs — even if the race occurs, the stale value self-heals when the TTL fires. For strong consistency: use Redis WATCH/MULTI/EXEC transactions — the SET aborts if the key was modified between your DB read and your cache write. For high-value keys: use version-based keys and only SET if your version is newer than the currently cached version."

---

**Q: "How would you design cache invalidation across microservices?"**

> "Don't let individual services try to invalidate each other's caches — that creates tight coupling and an ever-growing list of dependencies every service must track. Instead, use event-driven invalidation: the writing service publishes a domain event to a message bus describing what changed. Each downstream service subscribes to relevant events and invalidates its own cache keys based on what it knows about its own data model.
>
> The key benefit: when a new service is added, it subscribes independently — no changes needed to existing services. Each service owns its invalidation logic. For complex fanout across many keys, use a cache dependency registry — at population time, record which entity IDs contributed to each cache entry. At invalidation time, query the registry to find all affected keys."

---

## === Architect's Mental Model ===

### 5 Decision Rules

**Rule 1: TTL is always the safety net. Active invalidation is the mechanism. You need both.**
TTL-only systems tolerate staleness up to the TTL window — acceptable for slow-changing data. Active invalidation plus a long TTL: near-instant freshness with TTL as the fallback for missed invalidations. The TTL is never zero even with active invalidation. It's the fire extinguisher in case the active system misses something.

**Rule 2: DEL after DB commit, never before.**
Pre-commit DEL: race condition risk. A concurrent reader can miss the cache (key DELeted), read OLD data from DB (before your commit), and re-populate cache with stale data. DEL after commit: worst case, another reader reads stale data during the gap between commit and DEL — a millisecond window. Always: DB commit first, DEL second.

**Rule 3: Pre-warm caches before scheduled invalidation events.**
Mass invalidations at predictable times (sale launches, deployments, batch updates) cause miss storms. The miss storm happens exactly when traffic is highest (sale launch). Pre-compute and pre-load the new cache values before the invalidation event. At the actual switch: close to 100% hit rate because the new data is already cached. The invalidation event becomes a no-op for traffic.

**Rule 4: Fanout invalidation must be decentralized in microservice architectures.**
If Service A knows which cache keys to invalidate in Service B: you've introduced cross-service coupling. A domain event model (Service A publishes "entity changed", Services B and C subscribe and invalidate themselves) keeps each service's invalidation logic internal. It also scales — adding more services never changes existing invalidation code.

**Rule 5: Cache dependency registries are the only correct answer for search result invalidation.**
Search results are aggregations over many underlying entities. Knowing which entity changed doesn't tell you which search result pages contain that entity — unless you explicitly track it at cache population time. Record which entity IDs contributed to each cached search result when you populate the cache. On entity update: query the registry, DEL all affected result pages. Without this, either you over-invalidate (wildcard DEL all search results, needlessly), or you under-invalidate (stale search results).

---

### 3 Common Mistakes

**Mistake 1: Invalidating cache before updating DB.**
Classic ordering bug: DEL cache key, then UPDATE DB. A concurrent request sees the cache miss, hits DB (still has old data), re-populates cache with old data. Your subsequent DB update makes the DB correct, but cache is now wrong. The correct order is always: write to DB first, DEL from cache second. The gap between DB commit and cache DEL is minimized but can't be eliminated. The DEL-first order creates a much larger window of incorrectness.

**Mistake 2: Forgetting to invalidate negative cache entries on entity creation.**
Negative caching (caching null results) is correct and important for preventing DB hammering on missing IDs. But when the entity is then created: the negative cache entry must be explicitly DELeted. Teams add negative caching, forget to handle the creation invalidation, and spend hours debugging why newly created entities return "not found" for a minute after creation. Every negative cache entry creation must have a corresponding CREATE event handler that DELs it.

**Mistake 3: Using a single Redis cluster with keyspace notifications enabled at high volume.**
Keyspace notifications add per-operation overhead to the Redis event loop. At 10,000 ops/sec: manageable. At 500,000 ops/sec: keyspace notifications add enough overhead to push Redis CPU to saturation level, causing latency spikes for ALL operations. Enable keyspace notifications (notify-keyspace-events) with selective event types (Kxe for only expired events) and only on clusters with moderate traffic. High-volume clusters: use explicit pub/sub channels instead.

---

### 30-Second Interview Answer

> "Cache invalidation has three strategies: TTL-only, active DEL on write, and event-driven via change events. In practice, you use all three at once. Active DEL is the primary mechanism — it fires immediately after DB write. TTL is the safety net for missed invalidations and race conditions. Events drive cross-service invalidation where explicit DEL isn't practical. The hardest part is fanout: one DB update can affect dozens of cache keys across multiple layers — Redis, CDN, and in-process caches — and in multiple services. The solution is a dependency registry at cache population time and event-driven invalidation contracts between services. The most critical rule: always update the DB first, then DEL the cache. Never the reverse. Pre-DEL followed by a concurrent reader repopulating with stale DB data is the classic race condition."

---

_End of Topic 09 — Cache Invalidation_
