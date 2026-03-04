# Caching & Redis — Part 2 of 3

### Topic: Real World Examples, System Design Importance, AWS Mapping & Interview Prep

**Series:** Scalability & Performance → Topic 06

---

## SECTION 5 — Real World Example

### The Economics of Each Path

```
CACHE HIT PATH:
  Client → App → Redis GET → Key found → Return JSON
  Cost:
    Network: 1 round-trip to Redis (~0.4ms, same AZ, keep-alive)
    CPU: JSON.parse() of the response (~0.1ms)
    DB: 0 queries
    Total: ~0.5–2ms

  At 10,000 req/sec hitting this endpoint with a 90% hit rate:
    9,000 requests/sec served in ~1ms. DB: untouched.
    1,000 requests/sec hit DB.
    DB load: 1,000 req/sec instead of 10,000. 90% reduction.

CACHE MISS PATH:
  Client → App → Redis GET → Key NOT found → DB query → Redis SET → Return JSON
  Cost:
    Redis GET: ~0.4ms (returns nil)
    DB query: 8–50ms (depends on query, indexing, buffer pool)
    Redis SET: ~0.5ms (writes result back)
    JSON serialize + parse: ~0.2ms
    Total: 10–52ms

  You're always going to have misses. The design question is: how many?

WHAT DETERMINES HIT RATE:

  1. KEY CARDINALITY:
     "Get product by ID" — 10,000 unique products.
     Cache can hold 10,000 items before eviction kicks in.
     If cache has space: after first miss per product, all subsequent hits.
     Hit rate approaches 100% once cache is "warm."

     But: "Get order history for user X" — millions of unique users.
     At 1KB per user history → 10M users = 10GB.
     Redis node with 4GB RAM: can only hold 4M entries at a time.
     The other 6M users ALWAYS miss cache. Hit rate ceiling: 40%.

  2. TTL vs REQUEST FREQUENCY:
     Product with TTL = 1 hour. Requested 1,000 times/hour → 999 hits, 1 miss.
     Product with TTL = 1 minute. Requested 1 time/hour → 0 hits, 1 miss.
     Effective caching requires: request frequency > (1 / TTL).
     If a key is requested LESS frequently than it expires: caching it wastes memory.

  3. CACHE WARMTH:
     Cold start (new deployment, Redis flush, failover to empty replica):
       All requests: cache miss → DB.
       At 10,000 req/sec: 10,000 DB queries/sec simultaneously.
       DB: overwhelmed. This is the "thundering herd after cold start" problem.
       Mitigation: cache warming strategy (pre-populate before routing traffic).

MONITORING HIT RATE:

  Redis command:
    INFO stats | grep keyspace_hits
    INFO stats | grep keyspace_misses

    Hit rate = keyspace_hits / (keyspace_hits + keyspace_misses) × 100

  ElastiCache CloudWatch:
    CacheHits (metric)
    CacheMisses (metric)
    CacheHitRate = CacheHits / (CacheHits + CacheMisses)

  Alert threshold:
    < 80% hit rate sustained: investigate — cache may be undersized,
    TTL too short, keys not being cached for enough frequent resources,
    or cold start event in progress.
    < 50% hit rate: the cache is likely HURTING you (overhead of miss path
    without proportional benefit). Re-evaluate caching strategy.
```

---

## SECTION 6 — System Design Importance

### The Hardest Problem in Caching

```
"There are only two hard things in Computer Science:
 cache invalidation and naming things." — Phil Karlton

THIS IS NOT A JOKE IN PRODUCTION. Here's why:

THE PROBLEM:
  You cached product:99 at 10:00 AM: { id: 99, price: $29.99, stock: 5 }
  Admin updates price at 10:15 AM: price → $24.99 (flash sale).
  Redis TTL: 1 hour.

  At 10:30 AM: a user requests product:99.
  Cache returns: $29.99. (stale)
  User: "Checkout shows $24.99 but you charged me $29.99."

  THE CACHE HAS CAUSED A BUSINESS INTEGRITY PROBLEM.
  This is not a theoretical performance discussion.
  It's a customer dispute, a refund, and a support ticket.
```

---

### Invalidation Strategy 1: TTL-Only (Passive Expiry)

```
MECHANISM: Set a TTL. Wait for it to expire. Cache becomes fresh on next miss.

WHEN TO USE:
  ✅ Data that is naturally stale-tolerant (exchange rates, public metrics, trending items)
  ✅ Data that rarely changes (product descriptions, static config)
  ✅ Non-financial data where brief staleness is acceptable
  ✅ Systems where invalidation events are difficult to instrument
  (e.g., DB not owned by your service — you can't hook into updates)

WHEN NOT TO USE:
  ❌ Pricing, inventory levels, account balances — stale = business error
  ❌ User permissions / roles — stale = security error
  ❌ Any data with a regulatory consistency requirement

SETTING TTL:
  Ask: "How stale can this data be before it causes a visible problem?"
  Exchange rates: 5 minutes is fine → TTL = 300s
  Product availability: 2 minutes acceptable → TTL = 120s
  User roles: 0 seconds acceptable staleness → no TTL caching, or very short (30s)

  ANTI-PATTERN: setting all keys to the same TTL (e.g., 3600s) by default.
  This means pricing data AND static config AND user sessions all expire at 1hr.
  Pricing should be shorter. Static config should be longer (or never expire).
  TUNE TTL PER DATA TYPE.
```

---

### Invalidation Strategy 2: Active Invalidation (Cache-Busting)

```
MECHANISM: When the source data changes, immediately delete the cache key.

CODE PATH:
  updateProduct(id, changes):
    1. UPDATE products SET ... WHERE id = ?    ← DB write
    2. redis.del(`product:${id}`)             ← bust cache

  Next read: miss → fresh DB pull → new value in cache.

THE ORDERING PROBLEM:

  WRONG ORDER (cache update before DB commit):
    1. redis.SET product:99 { price: 24.99 }  ← new value in cache
    2. DB UPDATE ... (fails with deadlock)     ← DB write fails

    Result: cache has new price. DB has old price.
    If TTL is 1hr: stale WRONG value for 1 hour even though DB is "correct."

  CORRECT ORDER:
    1. DB UPDATE ... (commit first)
    2. redis.DEL product:99

    If step 1 fails: cache is unchanged. No stale data.
    If step 2 fails: cache has old value until TTL expires. Stale, but bounded.
    TTL is your safety net for failed invalidations.

THE RACE CONDITION (even with correct order):

  Thread A: starts DB update for product:99
  Thread B: cache miss → reads product:99 from DB (OLD value)
  Thread A: DB update commits (NEW value now in DB)
  Thread A: redis.DEL product:99 ← invalidates cache
  Thread B: redis.SET product:99 (OLD value) ← re-populates with stale data!

  Result: Thread A correctly invalidated, but Thread B wrote OLD data AFTER the delete.
  Cache is stale again. TTL is now reset to 1 hour with the old data.

  SOLUTIONS:

  1. Read-then-cache with version check (optimistic locking):
     DB: version column on products table.
     When reading for cache: SELECT id, price, version FROM products WHERE id=99
     Only cache if version > cached_version.

  2. Leases / Short TTL during writes:
     During a write: set a brief (1-5s) "locked" marker in Redis.
     Other threads seeing the marker: don't re-populate cache.
     Marker expires: safe to re-populate again.

  3. Event sourcing + cache rebuild (most robust):
     All writes emit events (Kafka, EventBridge).
     Cache invalidation consumer: listens, processes, invalidates.
     Ordering: guaranteed by event stream.
     This eliminates the race condition at the cost of introducing a message broker.
```

---

### Invalidation Strategy 3: Event-Driven Invalidation

```
USE WHEN: your write path emits events, and multiple caches (CDN + Redis + local)
          must all be invalidated when data changes.

ARCHITECTURE:

  Admin updates product:
    → DB write
    → EventBridge event: { type: "product.updated", id: 99, timestamp: ... }

  Cache invalidation consumer (Lambda / ECS):
    → Subscribes to product.updated events
    → redis.del(`product:99`)
    → CloudFront invalidation: POST /2020-05-31/distributions/{id}/invalidations
      { Paths: { Items: ["/api/products/99", "/products/99"] } }
    → Optionally: re-prime the cache with fresh DB data (warm the cache)

ADVANTAGES:
  ✅ Decoupled: write service doesn't know about caches.
  ✅ Multi-cache: EventBridge fan-out → Redis + CDN + any subscriber.
  ✅ Ordered: events have timestamps + ordering guarantees.
  ✅ Observable: event stream is auditable (when was cache invalidated? why?).

DISADVANTAGES:
  ❌ Eventual consistency: event processing adds 100ms–2s delay.
     Window where DB is new but cache is still old.
  ❌ Operational complexity: event bus + consumer = new failure domain.
  ❌ Dead letter queue needed: failed invalidations must be retried or alarmed.
```

---

## SECTION 7 — AWS & Cloud Mapping

### The Three Staleness Windows You Must Design For

```
WINDOW 1: TTL STALENESS
  Cache value is valid but reflects DB state from N seconds ago.

  Example: product stock = 5 (cached). 3 items sold. DB: stock = 2.
  Cache: still shows 5 for up to TTL duration.
  User sees: "5 in stock." Tries to buy 5. Only 2 left. Error at checkout.

  Design decision:
    Stock level display (not at checkout): TTL 60s → acceptable. User sees ≈5.
    Stock level at CHECKOUT (actual purchase): bypass cache, always read DB.

  Pattern: "Cache for display, bypass for transactions."
  Use the cache for rendering the product page.
  Do NOT use the cache for the final inventory check before deduction.

WINDOW 2: FAILED INVALIDATION STALENESS
  You tried to delete the cache key. Redis was briefly unreachable.
  Cache was not invalidated. TTL is the only safety net now.

  Design decision:
    Short TTL is your insurance policy. If invalidation fails:
    how long can you afford to serve stale data?
    For inventory: 5-minute TTL maximum (even if invalidation works).
    For prices: 15-minute TTL maximum.
    Even if your invalidation is 99.9% reliable: that 0.1% fails.
    TTL bounds the damage.

WINDOW 3: REPLICATION LAG STALENESS (the hidden one)
  Redis Cluster / ElastiCache Replication Group:
    Primary: handles writes.
    Replica: handles reads (to scale read throughput).
    Replication lag: typically 1-5ms, can spike to 100ms+ under load.

  Write flow: SET key = newValue on PRIMARY.
  Read flow: GET key from REPLICA.
  If read happens within the replication lag window: returns OLD value.

  DESIGN IMPLICATION:
    For critical reads: force read from PRIMARY (not replica).
    Redis client configuration:
      readFrom: "MASTER"  (reads go to primary only)
      vs
      readFrom: "SLAVE_PREFERRED"  (reads go to replica first)

    Cost of MASTER reads: primary handles all read load (less horizontal scaling).
    Cost of SLAVE reads: potential lag-based staleness.

    For financial data: always read from primary.
    For catalog/content: replica reads are fine (accept 5ms potential staleness).
```

---

## SECTION 8 — Interview Preparation

**Beginner:**

**Q: What is caching and why do we use it?**
**A:** Think of a chef who memorizes the most popular dish recipes instead of looking them up in a cookbook every time. Caching means storing the result of an expensive operation so the next identical request gets the pre-computed answer instantly. Instead of querying the database (taking 100ms), read from a cache (taking 1ms). 100Ã— faster, same result.

**Q: What is Redis and why is it commonly used for caching?**
**A:** Redis is an in-memory data store â€” it keeps all its data in RAM instead of on disk, which is why it's fast (sub-millisecond reads). It supports data structures like strings, lists, sets, hashes, and sorted sets â€” not just key-value pairs. It's the industry standard cache because it's fast, battle-tested, has built-in TTL/expiry, and runs standalone or in a cluster. AWS offers it as ElastiCache for Redis.

**Q: What is a cache miss vs. a cache hit?**
**A:** *Cache hit:* the data you requested is already in the cache â†’ return it instantly. *Cache miss:* the data is NOT in the cache â†’ go to the database, get it, store it in cache for next time, then return it. High cache hit rate (>90%) means most requests return instantly. Low hit rate means most requests still hit the database and caching provides little benefit.

---

**Intermediate:**

**Q: What is cache stampede / thundering herd and how do you prevent it?**
**A:** Cache stampede happens when a popular cached item expires simultaneously, and hundreds of requests arrive at that exact moment â€” all get a cache miss, all hit the database at the same time, overwhelming it. Prevention: (1) *Probabilistic early expiration:* slightly before expiry, one request refreshes the cache (probabilistic recomputation). (2) *Mutex/lock:* only one request queries the DB on miss; others wait for the first result. (3) *Background refresh:* a separate job refreshes the cache before it expires â€” TTL is always extended before reaching zero.

**Q: When should you NOT use Redis caching?**
**A:** (1) Data that changes frequently (every second) â€” cache becomes stale before it's useful. (2) Data that must always be perfectly fresh (e.g., financial balances, inventory stock counts) â€” stale cache could cause double-spending or overselling. (3) Data accessed rarely â€” caching costs memory without benefit. (4) Very small datasets that fit in one DB query with an index â€” the DB query might already be < 5ms. Rule: cache when reads >> writes and staleness is acceptable.

**Q: What is the difference between local in-process caching and Redis caching?**
**A:** *Local cache:* stored in your application's memory (e.g., a JavaScript Map or Python dict). Instant access (< 1Î¼s) but data is per-server â€” Server 1's cache â‰  Server 2's cache. On horizontal scaling, this causes inconsistency. *Redis cache:* shared external store, slightly slower (< 1ms network) but consistent across all app servers. Use local cache for static config/app startup data; Redis for user-specific or shared runtime data.

---

**Advanced (System Design):**

**Scenario 1:** Design a product catalog caching strategy for an e-commerce site with 1 million products. Products update infrequently (3-4 times per day). During a sale, 80% of traffic goes to 200 "hot" products. You have one Redis instance.

*Strategy:*
- Cache individual products by ID: product:{id} â†’ JSON blob. TTL = 1 hour.
- Hot product pre-warming: a background job runs at sale start, pre-loading the 200 hot product IDs into Redis before the sale begins (eliminates cold-start misses).
- Cache invalidation on update: when a product is edited, delete product:{id} from cache immediately (write-through or event-driven via SQS consumer).
- Memory sizing: 1M products Ã— 2KB avg = 2GB. With Redis key overhead, ~3GB. Use Redis maxmemory-policy allkeys-lru to evict cold products automatically if memory fills.

**Scenario 2:** Your Redis caching layer is hit by a DDoS-style cache invalidation attack â€” an attacker sends millions of unique product IDs that don't exist, causing 100% cache miss rate and overwhelming your database. How do you defend?

*Bloom filter:* A probabilistic data structure that can tell you "this ID definitely does NOT exist in the database" in O(1) time with no DB query. Store all valid product IDs in a Redis Bloom filter (redis-bloom module). Any request for an unknown ID gets rejected at the cache layer â€” no DB query ever happens. False positives are possible (< 1%) but false negatives are not (no valid ID ever rejected).

