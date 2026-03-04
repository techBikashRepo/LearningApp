# Cache Invalidation — Part 2 of 3

### Topic: Real World Examples, System Design Importance, AWS Mapping & Interview Prep

**Series:** Scalability & Performance → Topic 09

---

## SECTION 5 — Real World Example

### When Simple DEL Is Not Enough

```
SINGLE-LAYER, SINGLE-KEY INVALIDATION (easy case):
  update product:99 → redis.del("product:99")
  One key. One DEL. Done.

MULTI-LAYER CACHE (production reality):
  Three layers: Browser cache, CDN, Redis.
  One product update must invalidate ALL three.

  ┌─────────────────────────────────────────────────────┐
  │ Product price update: $29 → $19                      │
  │                                                       │
  │ Layer 1: Browser cache                                │
  │   Cache-Control: max-age=3600 in HTTP response.       │
  │   Browser caches price for 1 hour.                    │
  │   Invalidation: impossible. Cannot reach user browsers.│
  │   Best approach: set short max-age (60s) for price.   │
  │   Or: embed price in JS (served from CDN, invalidatable)│
  │                                                       │
  │ Layer 2: CloudFront / CDN                             │
  │   CDN path: /api/products/99?fields=price             │
  │   Invalidation: CloudFront CreateInvalidation API     │
  │   Cost: $0.005 per 1,000 paths ($0.000005 per path)   │
  │   Delay: 15–30 seconds for global propagation         │
  │                                                       │
  │ Layer 3: Redis (ElastiCache)                           │
  │   Key: product:v1:99                                  │
  │   Invalidation: redis.del("product:v1:99")            │
  │   Delay: immediate                                    │
  └─────────────────────────────────────────────────────┘

  EXECUTION ORDER on product update:
    1. UPDATE products SET price=19 WHERE id=99   (DB first)
    2. redis.del("product:v1:99")                  (Redis — immediate)
    3. cloudfront.createInvalidation("/api/products/99")  (CDN — async, 15–30s)

  WHY THIS ORDER:
    Redis DEL: instant. Next API call after this returns fresh data.
    CDN invalidation: async, takes 15–30s.
    During those 30s: API calls that hit origin (miss CDN) return fresh data.
    After 30s: CDN also serves fresh data.
    Browser cache: still stale for up to max-age seconds (can't invalidate).
    Tolerable: browser cache has short max-age (60s) for dynamic pricing.

INVALIDATION FANOUT CRISIS:
  Real e-commerce scenario: Product belongs to many categories.
  Database:
    product:99 in categories: [electronics, sale, new-arrivals, gift-ideas, under-50]

  Cache keys affected by a product price change:
    product:99                          (product detail)
    search:?category=electronics:page1  (search results pages)
    search:?category=electronics:page2
    search:?category=sale:page1
    search:?category=new-arrivals:page1
    search:?category=gift-ideas:page1
    search:?category=under-50:page1
    homepage:featured-products          (if product is featured)
    user:watchlist:*                    (every user who watchlisted product:99)

  One product update: potentially hundreds of cache keys to invalidate.
  For category pages with pagination: thousands of keys.

  PROBLEM 1: Invalidation takes too long (1,000+ Redis DELs).
  PROBLEM 2: You don't know all affected keys at write time.

  SOLUTION A: TAG-BASED INVALIDATION
    Each cache key is tagged with entity IDs it depends on.
    Tags stored separately: tag:product:99 → [set of keys]

    On product update:
      tag_members = redis.smembers("tag:product:99")
      redis.del(...tag_members)
      redis.del("tag:product:99")

    Implementation with Redis Sets:
      SADD tag:product:99 "product:99" "search:?category=electronics:page1" ...
      On update: SMEMBERS tag:product:99 → pipeline DEL all.

    Maintenance: add to tag set when cache key is created.
      SADD tag:product:99 {searchKey}  ← on every cache population that touches product:99

    Scale problem: tag:product:99 set can grow unboundedly.
    Mitigate: TTL on the tag set itself. Periodically clean stale members.

  SOLUTION B: CACHE KEY VERSIONING
    Don't invalidate individual keys. Increment a version number.

    Current product version: product:version:99 = 3
    Cache key: product:v3:99

    When product updates:
      INCR product:version:99   → 4 (atomic)
      (Old key "product:v3:99" is now dead — will expire via TTL)
      (No explicit DEL needed for the old key)

    Reads:
      version = redis.get("product:version:99")  → 4
      key = `product:v${version}:99`             → "product:v4:99"
      data = redis.get(key)                      → miss (version 4 doesn't exist yet)
      → DB read → redis.setex("product:v4:99", ...)

    Cost: 1 extra Redis GET (version lookup) per cache read.
    Benefit: no fanout DEL. The old keys self-expire via TTL.

    This is elegant for high-fanout scenarios where DEL is impractical.
```

---

## SECTION 6 — System Design Importance

### Multi-Server Cache Invalidation

```
THE PROBLEM WITH IN-PROCESS CACHES IN DISTRIBUTED SYSTEMS:

  3 app server instances. Each has an in-process LRU cache (L1).
  Server 1: caches product:99 price = $29.
  Server 2: caches product:99 price = $29.
  Server 3: caches product:99 price = $29.

  Admin updates price to $19 via Server 1:
    Server 1: DB update → DEL L1 cache → DEL Redis (L2).
    Server 1: ✅ returns $19 on next read (L1 miss → L2 miss → DB hit $19).
    Server 2: ❌ L1 still has $19. Will return $29 for up to L1 TTL (30s).
    Server 3: ❌ L1 still has $29. Same.

  For 30 seconds: 2 of 3 servers serve wrong price.
  Load balanced: ~67% of users see wrong price.

  SOLUTION: REDIS PUB/SUB FOR L1 INVALIDATION

  Writer:
    after DB update + L2 DEL:
    redis.publish("cache:invalidate:product", JSON.stringify({ id: 99 }))

  Every server process (subscriber):
    redis.subscribe("cache:invalidate:product")
    on message: l1Cache.delete(`product:${message.id}`)

  Effect:
    Server 1: DEL L1 + publish event.
    Server 2: receives pub/sub → DEL L1.
    Server 3: receives pub/sub → DEL L1.
    All 3 servers: L1 cleared within ~1ms (pub/sub latency).

  EDGE CASE: A server is down when invalidation fires.
    It restarts 5 minutes later: misses the pub/sub message.
    Its L1 cache has stale data that will never be explicitly invalidated.

    MITIGATION: L1 TTL as fallback.
    L1 TTL = 30s. With pub/sub: 99% of invalidations are instant.
    The 1% case (server was down): stale for at most 30s after restart.
    Acceptable for most use cases.

REDIS KEYSPACE NOTIFICATIONS (alternative to pub/sub):
  Redis built-in: publishes events when keys are modified.
  Configure: notify-keyspace-events KEA ("K" = keyspace, "E" = keyevent, "A" = all)

  Other services can subscribe:
    redis.subscribe("__keyevent@0__:del")  ← fires on every DEL in DB 0

  USE CASE: Cache invalidation at the edge (without modifying writer code).
    Legacy service updates DB and DELetes Redis.
    Other services: subscribe to keyspace events → respond to DELs.

  PROBLEM: keyspace notifications add overhead to Redis.
  Fires for EVERY key operation. At high write rates: significant CPU.
  Use only for low-to-medium write rates.
```

---

## SECTION 7 — AWS & Cloud Mapping

### Managing Key Dependencies

```
THE KEY DEPENDENCY MAP PROBLEM:

  Application code is spread across 15 microservices.
  Each service caches different representations of shared data.

  Service A (Product Service): caches product detail.
    key: products:v1:{id}

  Service B (Search Service): caches search results that include products.
    key: search:v1:{query}:{page}
    Invalidate when: any product in the result set changes.

  Service C (Recommendation Service): caches personalized product lists.
    key: recs:v1:{userId}:{context}
    Invalidate when: product inventory or price changes.

  ONE PRODUCT UPDATE: Must invalidate across 3 services.
  Service A knows to invalidate its own key.
  Service A does NOT know about Service B or C's keys.

  SOLUTION: INVALIDATION CONTRACT VIA EVENTS

  Product Service: on update, publishes event.
  Format: { entityType: "product", id: 99, changedFields: ["price"], timestamp: ... }

  Each service: subscribes and manages its own invalidation logic.
    Service A: subscribes → DEL products:v1:99.
    Service B: subscribes → invalidate search results that include product 99.
    Service C: subscribes → invalidate rec lists that include product 99.

  FANOUT IS NOW DECENTRALIZED:
    Product Service doesn't know about B and C's cache keys.
    B and C invalidate themselves based on domain events.
    New Service D added: subscribes to product events, self-manages.
    Adding a new service NEVER requires modifying existing invalidation logic.

  IMPLEMENTATION — SERVICE-SPECIFIC INVALIDATION:

  Service B (Search):
    on event { entityType: "product", id: 99, changedFields: ["price"] }:

    // Find all search result cache keys that contain product 99
    // (tracked at cache population time)
    const affectedSearchKeys = await db.query(
      `SELECT cache_key FROM search_cache_index WHERE product_ids @> ARRAY[$1]`,
      [99]
    );
    await redis.del(...affectedSearchKeys.map(r => r.cache_key));

    // Also delete the index entries (stale keys, will be re-added on next cache population)
    await db.query(
      'DELETE FROM search_cache_index WHERE product_ids @> ARRAY[$1]', [99]
    );

  SEARCH CACHE INDEX TABLE:
  CREATE TABLE search_cache_index (
    cache_key TEXT PRIMARY KEY,
    product_ids INT[],    -- which product IDs are in this search result
    created_at TIMESTAMP,
    ttl_expires_at TIMESTAMP
  );

  On search cache population:
    redis.SETEX("search:v1:electronics:page1", 3600, results)
    db.INSERT INTO search_cache_index (cache_key, product_ids, ...) VALUES (...)

  On product update:
    SELECT cache_key WHERE product_ids @> ARRAY[99] → get affected search keys.
    DEL those keys. Clean up index entries.

  This is the "cache dependency registry" pattern.
  Trade-off: more DB writes on cache population (tracking index).
  Benefit: precise fanout invalidation without scanning Redis keyspace.
```

---

## SECTION 8 — Interview Preparation

**Beginner:**

**Q: What is cache invalidation and why is it described as "one of the two hard problems in computer science"?**
**A:** Cache invalidation means deciding when to remove or update cached data because the original data has changed. It's considered hard because you must decide: how do you know when the cached copy is stale? How do you update all caches across many servers simultaneously? How do you do this without causing a thundering herd? Get it wrong and users see old data; get it too aggressive and you lose all caching benefit.

**Q: What are the three main ways to invalidate a cache?**
**A:** (1) *TTL-based expiry:* cached items automatically expire after a fixed time (e.g., 1 hour). Simple but you'll serve stale data for up to 1 hour. (2) *Event-driven invalidation:* when data changes, immediately delete or update the cache entry. Fresh data always, but complex to implement. (3) *Versioned keys:* instead of invalidating, create a new cache key with a version number (product:123:v2). Old key expires naturally. Good for cache busting.

**Q: Which invalidation strategy should beginners start with?**
**A:** TTL-based expiry â€” it's simple, requires no extra infrastructure, and handles most use cases. Choose TTL based on how often your data changes and how stale is acceptable. Product descriptions: 1 hour. User profiles: 15 minutes. Stock counts: 30 seconds or no caching at all. Start simple, add event-driven invalidation only when staleness actually causes user-visible problems.

---

**Intermediate:**

**Q: What is the "double deletion" pattern in cache invalidation and why is it needed?**
**A:** Simple deletion has a race condition: (1) Request A reads DB (old value), (2) Request B updates DB + deletes cache, (3) Request A writes old value to cache. Now cache has stale data again. Double deletion: delete cache BEFORE updating DB AND after updating DB. If Request A writes stale data between the two deletes, the second delete removes it. This halves the race condition window. For critical consistency, use a short TTL (30 seconds) as a safety net even with event-driven deletion.

**Q: How does distributed caching complicate invalidation when you have multiple app servers?**
**A:** Each app server might have a *local* L1 cache (in-process, e.g., Node.js Map) AND a shared Redis cache. When data updates, you must invalidate both: the Redis entry (easy â€” one command) AND the local caches on ALL running servers. For local cache invalidation, use Redis pub/sub: publish an invalidation event that all servers subscribe to â€” each server deletes the local entry on receiving the event. This is called "cache invalidation broadcasting."

**Q: What is cache versioning and when does it outperform TTL invalidation?**
**A:** Instead of invalidating product:123, you use product:123:v{version}. When you update the product, increment the version stored in DB. Cache key includes the current version number. Old cache entries (product:123:v1) are effectively unreachable â€” they'll expire naturally. New reads use product:123:v2. Best for deployments: change your cache key format (e.g., include git SHA) to immediately invalidate all old cached responses after a deploy, without needing to track individual keys.

---

**Advanced (System Design):**

**Scenario 1:** You have a content management system (CMS) that serves articles to 500,000 readers. When an editor publishes an edit, all cached copies of that article must be invalid within 5 seconds. You have 20 app servers, each with a local in-memory cache (1,000 article cache), plus a shared Redis cluster. Design the invalidation strategy.

*Event-driven + broadcast:* Edit published â†’ (1) Write to DB. (2) Delete from Redis. (3) Publish invalidate:article:{id} event to Redis pub/sub. (4) All 20 app servers receive event via subscription â†’ delete from local cache. (5) Next request to any server: cache miss â†’ read from Redis (or DB if not in Redis) â†’ fresh content populated within seconds.
*Fallback:* TTL of 60 seconds on all article keys as safety net. Even if pub/sub fails, staleness is max 60 seconds.

**Scenario 2:** Your pricing service has strict rules: a user must NEVER see a higher price at checkout than what was displayed on the product page (displayed price must be honored). Prices update multiple times per day. Design the caching and invalidation strategy.

*Price display â†’ cache with short TTL (30s) + version token:* user sees price + gets a price_token (hash of price + timestamp). At checkout, validate: current DB price == displayed price (using token). If price increased: reject checkout with "price changed" message. If price decreased: honor new lower price automatically.
*Cache strategy:* Price per product cached in Redis with TTL=30s. On price change event (via SQS/SNS): immediate cache delete. Maximum staleness = 30 seconds. Clear UX messaging if price changed: "This item's price changed since you viewed it."

