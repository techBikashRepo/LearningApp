# Cache-Aside Pattern — Part 3 of 3

### Topic: AWS Certification Focus, Comparison Tables, Quick Revision & Architect Exercise

**Series:** Scalability & Performance → Topic 07

---

## SECTION 9 — Certification Focus (AWS SAA)

```
TTL IS YOUR CONSISTENCY CONTRACT, NOT A PERFORMANCE DIAL.

THE COMMON MISTAKE:
  Team sets TTL = 3600s (1hr) to maximize hit rate.
  Product prices update every 15 minutes during flash sales.
  Users see wrong prices for up to 1 hour.
  Business impact: refunds, disputes, customer complaints.

  The TTL was set without asking: "How stale can this data be?"

CORRECT APPROACH — ASK THREE QUESTIONS:

  Q1: If this cache entry is stale, what is the business impact?
    Low: display artifact (show old thumbnail) → long TTL OK.
    High: financial error (wrong price charged) → short TTL + active invalidation.

  Q2: How often does this data actually change?
    Static (product description): change once per month → 24hr TTL is fine.
    Dynamic (stock count): change every second → 30s TTL MAX.

  Q3: Can you add active invalidation?
    If yes: TTL is a safety net. Set it longer.
    If no: TTL is your ONLY protection. Set it shorter.

CACHE-ASIDE SPECIFIC TTL PATTERN: JITTER

  Problem: 10,000 product pages all cached at startup.
  All have TTL = 3600s.
  At t=3600: ALL 10,000 keys expire simultaneously.
  10,000 concurrent DB queries → DB overwhelmed.

  Fix: Randomize TTL per key.
    ttl = 3600 + Math.floor(Math.random() * 300)
    Keys expire spread over a 5-minute window.
    DB query rate: evenly distributed instead of spiked.

  Example implementation:
    const BASE_TTL = 3600;
    const JITTER = Math.floor(Math.random() * 600);  // 0-10min jitter
    await redis.setex(key, BASE_TTL + JITTER, value);
```

---

## SECTION 10 — Comparison Table

### ElastiCache + DAX + Application Integration

```
CACHE-ASIDE WITH ELASTICACHE FOR REDIS:

  Standard setup:
    ElastiCache Replication Group (1 primary + 1 replica, Multi-AZ)
    App servers connect via primary endpoint (writes) + reader endpoint (reads)

    Primary endpoint: always points to primary.     Use for: writes + critical reads.
    Reader endpoint:  round-robins across replicas. Use for: non-critical reads.

  Cache-aside app config (Node.js ioredis):
    const redis = new Redis.Cluster([
      { host: process.env.REDIS_PRIMARY },
      { host: process.env.REDIS_READER }
    ], {
      scaleReads: 'slave',      // route reads to replicas
      commandTimeout: 200,      // 200ms timeout — don't wait for slow Redis
      retryStrategy: times => Math.min(times * 50, 300),
      enableOfflineQueue: false // fail fast — don't queue commands during outage
    });

DYNAMODB + DAX (Cache-Aside built-in):
  If you use DynamoDB as your DB:
  DAX (DynamoDB Accelerator) is a transparent caching layer.

  No app code change needed for basic cache-aside:
    DynamoDB client → DAX → DynamoDB (on miss)

  DAX handles: cache population, TTL, invalidation on updates.
  Performance: 10× faster reads (microseconds for cache hits).

  Limitation: DAX only works with DynamoDB. Not for RDS.
  For RDS: you implement cache-aside logic in your application code.

MONITORING CACHE-ASIDE HEALTH (CloudWatch):

  ElastiCache metrics:
    CacheHits / CacheMisses → hit rate dashboard.
    Alert: CacheHitRate < 0.80 sustained 15min → investigate key eviction.

    Evictions:
      > 0 evictions/min: cache is under memory pressure.
      Keys being evicted before TTL: hit rate will drop.
      Action: scale up node or reduce TTL of less-important keys.

    CurrConnections: track connection pool usage.

  App-side custom metrics (emit these):
    cache.hit / cache.miss / cache.error per entity type.
    cache.population_latency: how long DB + SET takes on miss path.
    cache.invalidation.success / cache.invalidation.failure.

  Alert: cache.invalidation.failure > 0 → DLQ filling up → stale data growing.
```

---

## SECTION 11 — Quick Revision

**Scenario:** A news platform serves personalized article feeds. 5M daily active users. Each user's feed is: 20 articles, personalized by ML model, recomputed every 10 minutes. Also: article detail pages (public, not personalized). Design the cache-aside strategy.

---

**Answer:**

```
ENTITY 1: Article detail pages
  Read pattern: public. Same content for all users. Very high read frequency.
  Change frequency: article text published once, rarely updated. Thumbnails/titles: occasionally.

  KEY: article:{articleId}
  TTL: 1 hour + jitter(0–300s)
  Active invalidation: YES — on article update/publish → redis.del(key)
  Layer: CloudFront (L1) + Redis (L2)
    CloudFront: Cache-Control: public, max-age=300 for article detail API
                Invalidation: on article publish event → CloudFront invalidation path
    Redis: article:{id} for internal service-to-service reads
  Hit rate target: > 97%

ENTITY 2: Personalized feed
  Read pattern: unique per user. 5M users × 1 feed each.
  Payload: 20 article IDs per feed ≈ 500 bytes.
  Change frequency: every 10 minutes (ML recompute schedule).

  OPTION A (cache-aside, lazy population):
    First user request: cache miss → ML model inference → SET feed:{userId}
    TTL: 10 min (matches recompute schedule) + jitter(0–60s)
    Problem: > 5M unique keys. All expire every 10 minutes.
    Miss storm: every 10 minutes, N concurrent users get cold misses simultaneously.
    ML inference: 200ms per user. At 50,000 concurrent: 50,000 × 200ms inflight.

  OPTION B (pre-compute + cache-aside warmup — BETTER):
    Background job: every 10 minutes, pre-compute feeds for active users (seen in last 24h).
    For 1M active users/day: 1M × 500 bytes = 500MB in Redis per cycle.
    Job populates: SETEX feed:{userId} 600 {article_ids}
    User requests their feed: cache HIT almost always.
    Miss only for: brand new users (first ever visit) → 200ms one-time wait.

  KEY: feed:{userId}
  TTL: 600s (10min) + jitter(0–60s)
  Eviction: volatile-lru (only evict TTL-bearing keys — never evict article cache)
  Memory: 500MB for 1M users' feeds per 10min window → need cache.r7g.xlarge (26GB)

  Separate Redis cluster for feeds vs article cache:
    Article cache: allkeys-lru, no persistence, small node.
    User feeds: volatile-lru, no persistence, larger node (500MB+ working set).

INVALIDATION TRIGGERS:
  Article updated: redis.del(article:{id}) + CloudFront invalidation.
  User preferences changed: redis.del(feed:{userId}) → next request triggers fresh ML inference.
  ML model redeployed: flush feed:* namespace (version bump: feed:v2:{userId} key format).
```

---

## SECTION 12 — Architect Thinking Exercise

**Q: "Explain cache-aside and what makes it different from read-through."**

> "Cache-aside puts the application in charge of all cache interactions. The application checks the cache first; on a miss, it queries the DB, gets the result, writes it to cache, and returns. On a write, the application updates the DB and deletes the cache key — never writes new values directly to the cache. Cache and DB have no awareness of each other.
>
> Read-through sits between the app and DB. The app always reads from the cache; the cache is responsible for fetching from DB on a miss. The difference is ownership: in cache-aside, your application code manages cache population and invalidation. In read-through, the caching layer manages it.
>
> Cache-aside is the dominant production pattern because application code has business context — you can apply field filtering, access control, and custom serialization during cache population. A generic cache layer can't replicate that."

---

**Q: "What is the race condition in cache-aside writes and how do you prevent it?"**

> "The race condition: Thread A reads from DB (gets stale value), Thread B writes new value to DB then DELetes the cache key, Thread A writes the old stale value to cache. The cache now contains wrong data that will persist until TTL expires.
>
> There are three defenses: First, short TTLs as a safety net — even if the race condition occurs, it self-heals within minutes. Second, version-based population — store the DB record's updated_at timestamp alongside the cached value, and only write to cache if your DB read timestamp is newer than what the cache already has. Third, Redis's WATCH/MULTI/EXEC transaction — watch the key before your DB read; if someone invalidated it between your read and your SET, EXEC returns nil and you abort the write."

---

## === Architect's Mental Model ===

### 5 Decision Rules

**Rule 1: Cache-aside is the right default for read-heavy, write-occasionally data with independent cache and DB layers.**
If you can't answer "how does the cache get updated when this data changes?" with a clear code path: don't cache it yet. The answer for cache-aside is always: DEL on write, DB-populate on next miss. Anything else introduces the race condition.

**Rule 2: DEL on write, never SET on write.**
Setting cache with new value on write creates a race with concurrent readers repopulating with stale data. Deleting creates at most one extra DB miss. The asymmetry matters: a SET can cause hours of wrong data; a DEL causes one DB hit. Always delete, never update.

**Rule 3: Negative cache NULL results.**
If `GET /products/99999` returns a product-not-found response, and you receive 10,000 of these per second for non-existent IDs: every request hits the DB. Cache `null` under the same key with a short TTL (60s). This is especially critical for DDoS-adjacent scenarios where an attacker scans random IDs.

**Rule 4: Pipeline multi-key cache-aside operations.**
A page needing 10 entities with sequential Redis calls: 5ms. Same page with pipelined calls: 0.5ms. At 1,000 req/sec, that's 4.5 seconds of wasted CPU and network per second. Pipeline GETs together; handle misses in parallel DB batch; pipeline SETs together. The code complexity is worth it at even moderate traffic levels.

**Rule 5: Use a circuit breaker on the Redis client.**
Redis failure → sequential timeouts per request → app appears hung. Without a circuit breaker, your Redis failure takes down your entire app even though the DB is fine. With a circuit breaker: Redis fails → circuit opens → app routes all traffic directly to DB. Performance degrades but service remains up. This is the difference between a degraded incident and a full outage.

---

### 3 Common Mistakes

**Mistake 1: Putting business logic in the cache key without namespace + version.**
`product:99` — what version of the schema? What serialization format? When the product schema adds a new field, the cached JSON doesn't have it. For months after a schema migration, old cache entries return wrong data. Always use: `catalog:v2:product:99`. When schema changes: bump the version. All old keys are simply never hit (expire naturally or can be flushed by pattern). Re-review your key naming strategy at every schema migration.

**Mistake 2: Not handling Redis errors in the cache-aside path.**
`const val = await redis.get(key)` with no try-catch. Redis throws a connection error. Unhandled exception propagates. Request fails with 500. But the DB is completely healthy! Every cache infrastructure problem becomes a user-facing error. Redis errors in cache-aside should always be caught, logged, and result in a DB fallback — not a 500. The cache is an optimization, not a required component.

**Mistake 3: Sharing a Redis cluster for caching AND session storage with allkeys-lru eviction.**
allkeys-lru will evict any key — including session keys — when memory is full. Users are logged out because their session was evicted to make room for a product description cache. The fix: separate clusters with separate eviction policies (allkeys-lru for cache; volatile-lru for sessions). The cost of a second small Redis instance is insignificant compared to the support burden of random user logouts.

---

### 30-Second Interview Answer

> "Cache-aside is the most common caching pattern because it keeps the cache optional and the DB as the source of truth. On a read: check cache first. Miss? Query DB, populate cache, return. On a write: update DB, delete the cache key — never write new values directly to cache. Delete avoids the race condition where a concurrent reader could repopulate cache with stale data after your write. The pattern's strength is resilience: if the cache goes down, reads fall through to DB and everything still works, just slower. The key disciplines are: consistent key naming with versioning, negative caching for null results, short TTLs per data type based on acceptable staleness, and wrapping Redis calls in circuit breakers so Redis failures degrade gracefully rather than taking the service down."

---

_End of Topic 07 — Cache-Aside Pattern_
