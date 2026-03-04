# Cache-Aside Pattern — Part 1 of 3

### Topic: Foundations — Intuition, Core Concepts, Architecture & Data Flow

**Series:** Scalability & Performance → Topic 07

---

## SECTION 1 — Intuition (Explain Like a 12-Year-Old)

```
IMAGINE A CEO AND THEIR PERSONAL ASSISTANT:

WITHOUT CACHE-ASIDE (CEO does all the work):
  CEO gets a question: "What's our Q3 revenue?"
  CEO: walks to the finance archive room (database).
  Pulls the file. Reads the number. Returns.

  Next person asks same question 10 minutes later.
  CEO: walks to the archive room again.
  Same file. Same number. Same walk.

  The CEO's time (database compute) is wasted on repetitive lookups.
  Nobody else can ask the CEO anything while they're in the archive room.
  Archive room access = the bottleneck.

WITH CACHE-ASIDE (assistant handles repeated questions):
  CEO first asks the assistant: "Do you have Q3 revenue?"
  Assistant checks their notepad (cache): "Yes — $4.2M."
  CEO never leaves the room.

  If the assistant doesn't have it (cache miss):
    CEO walks to archive room (DB query).
    Gets the answer.
    CEO tells the assistant: "Write this down — Q3 was $4.2M." (populate cache)

  Next 50 people ask the same question:
    Assistant answers from notepad. CEO never moves.

THE CRITICAL DETAIL IN THE ANALOGY:
  The CEO MANAGES what goes on the assistant's notepad.
  The assistant doesn't auto-fetch things. Doesn't auto-delete things.

  If the finance team updates Q3 revenue (data changes):
    The CEO must TELL the assistant: "Erase Q3 from your notepad."
    (cache invalidation — explicit, application-managed)

  If the CEO forgets to tell the assistant:
    The assistant keeps giving the old number.
    This is the staleness problem. The CEO's responsibility to prevent it.

  IN SOFTWARE:
    CEO = application code
    Archive room = database
    Assistant's notepad = Redis cache
    The "tell the assistant to erase" = redis.del(key) on write

  CACHE-ASIDE = the application drives ALL cache interactions.
  Cache and DB know nothing about each other.
  The application is the coordinator.
```

---

### Why Cache-Aside Is the Default Pattern

```
CACHE-ASIDE vs OTHER PATTERNS — THE PRACTICAL REASON IT DOMINATES:

Read-Through: Cache fetches from DB automatically on miss.
  Requires: cache driver that knows your DB schema and query logic.
  Reality: your DB queries have business logic, JOINs, ACL filters.
           No generic cache driver can replicate that.
           You'd need to bake business logic into the caching layer.
           Violates separation of concerns.

Write-Through: Every write goes to both cache and DB.
  Requires: cache to be in the critical write path.
  Problem: write latency doubles. Cache failure = write failure.

Write-Back: Write to cache only, flush to DB later.
  Requires: cache to be durable (data lives in cache before DB).
  Problem: cache failure = data loss.

CACHE-ASIDE:
  Cache is ONLY in the read path.
  Writes go ONLY to DB (+ DEL the cache key).
  Cache failure: read performance degrades (DB hit), but writes succeed.
  DB failure: reads fail even with cache (bad data vs no data — depends on your choice).

  Cache-Aside is the most resilient to cache failure because:
  The DB remains the source of truth at all times.
  The cache is purely an acceleration layer — not a required component.
```

---

## SECTION 2 — Core Technical Explanation

### DB Read Saturation at Scale

```
THE PRODUCTION PROBLEM:

  Product detail page. 500,000 page views per day.
  85% of views are for the top 5,000 products.
  Each page view: 3 DB queries (product, reviews summary, seller info).

  Daily DB read load:
    500,000 × 3 = 1,500,000 queries/day
    Peak hour (8PM): 60,000 page views → 180,000 queries/hour = 50 queries/sec

  RDS db.r6g.large: handles ~3,000 queries/sec max.
  50 queries/sec sounds trivial — but that's during calm periods.
  Flash sale at 8PM: 10× spike → 500 queries/sec → still under limit.
  Black Friday spike: 50× spike → 2,500 queries/sec → approaching limit.
  Anything above that: DB becomes the ceiling.

  CACHE-ASIDE CHANGES THE MATH:

  Top 5,000 products cached with TTL 30min.
  After first miss per product: all reads served from Redis.

  Cache hit rate: 85% (85% of views = top 5,000 products, all cached after warmup)
  DB queries during peak:
    50 queries/sec × 15% miss rate = 7.5 queries/sec

  DB load: 50 → 7.5 queries/sec. 85% reduction.
  On Black Friday: 2,500 → 375 queries/sec. WELL within limit.
  The DB ceiling is no longer reached.

WHEN CACHE-ASIDE IS NOT THE SOLUTION:

  ❌ Write-heavy workloads where every write invalidates a cache key
     (high churn: cache hit rate approaches zero — only overhead, no benefit)

  ❌ Data that is unique per user AND varies every request
     (no shared cache benefit: every key is a miss until warmed per-user)

  ❌ When data consistency > performance
     (financial transaction flows, inventory deduction, auth decision points)
     Use case: the final checkout price verification MUST come from DB.
     Cache-Aside here → potential to serve stale price → customer dispute.

  ❌ Very small datasets that fit in DB working set / buffer pool
     (if all data fits in DB memory, DB returns in ~1ms — cache overhead not worth it)
```

---

## SECTION 3 — Architecture Diagram (MANDATORY)

### Annotated System View

```
CACHE-ASIDE: SYSTEM VIEW

┌─────────────────────────────────────────────────────────────────────────┐
│                    APPLICATION SERVICE                                   │
│                                                                          │
│   READ PATH:                        WRITE PATH:                         │
│                                                                          │
│   1. cacheKey = build_key(id)       1. DB.update(record)                │
│   2. val = redis.GET(cacheKey)      2. redis.DEL(cacheKey)              │
│   3. if val: return parse(val)      3. return success                   │
│   4. val = DB.query(id)             (Cache is NOT updated on write)     │
│   5. redis.SETEX(cacheKey, TTL, val)                                    │
│   6. return val                                                          │
│                                                                          │
└────────────────┬────────────────────┬───────────────────────────────────┘
                 │                    │
        (read)   │                    │ (write/invalidate)
                 ▼                    ▼
┌────────────────────────┐  ┌────────────────────────┐
│    Redis Cache         │  │  Redis Cache            │
│                        │  │                         │
│  product:99  ──────────┤  │  product:99  ◄──DEL─── │
│  { name, price, ... }  │  │  (key removed)          │
│  TTL: 1795s remaining  │  │                         │
└────────────────────────┘  └─────────────────────────┘
                 │                    │
  (miss only)    │                    │ (always)
                 ▼                    ▼
┌────────────────────────────────────────────────────────┐
│              Database (Source of Truth)                 │
│                                                         │
│  SELECT ... FROM products WHERE id = 99                 │
│  UPDATE products SET price=... WHERE id = 99            │
│                                                         │
└────────────────────────────────────────────────────────┘

KEY PROPERTIES:
  1. Cache and DB never talk directly.
  2. Read path: cache-first, DB fallback.
  3. Write path: DB-first, then DEL cache (never SET cache on write).
  4. If cache goes down: reads fall through to DB. Writes are unaffected.
  5. If DB goes down: cache misses can't be served (no fallback to stale on by default).
     (Though: some systems choose to serve stale cache on DB outage — circuit breaker pattern)
```

---

### Multi-Tier Cache-Aside

```
LAYERED CACHE-ASIDE (production pattern for high-traffic systems):

REQUEST → App Server
    │
    ├─ CHECK: in-process memory (LRU cache, e.g., node-lru-cache)
    │   Hit: return in < 0.1ms. No network call.
    │   Size: 100–1,000 items max (RAM bounded).
    │   TTL: 30 seconds (very short — local cache gives stale risk).
    │
    ├─ CHECK: Redis (L2)
    │   Hit: return in 0.3–1ms.
    │   Size: millions of items (Redis RAM).
    │   TTL: 5–60 minutes.
    │
    └─ DB QUERY (L3, only on full miss)
        → Populate Redis (L2)
        → Populate in-process cache (L1)
        → Return

WHEN TO USE L1 IN-PROCESS CACHE:
  ✅ Data requested on EVERY incoming request (e.g., feature flags, config)
  ✅ Data that changes at most once per minute
  ✅ Data identical across all users (not user-personalized)

  ❌ NEVER for user session data (each process has different users — stale cross-user)
  ❌ Never for data that must invalidate instantly (process has no pub/sub awareness)

  The 30-second L1 TTL is the risk window.
  A config change: takes up to 30s to propagate across all app server processes.
  For feature flags: acceptable. For pricing: too long.
```

---

## SECTION 4 — Request Flow (MANDATORY FLOWCHART)

### Exact Code + Decision Trees

```javascript
// Cache-Aside READ — production-grade implementation
async function getProduct(productId) {
  const key = `catalog:v1:product:${productId}`;

  // ── L1: in-process cache ─────────────────────────────────
  const l1 = localCache.get(key);
  if (l1) {
    metrics.increment("cache.l1.hit", { entity: "product" });
    return l1;
  }

  // ── L2: Redis ─────────────────────────────────────────────
  let raw;
  try {
    raw = await redis.get(key);
  } catch (redisErr) {
    // Redis is down — fall through to DB without crashing
    logger.warn("Redis unavailable, falling through to DB", {
      key,
      err: redisErr.message,
    });
    metrics.increment("cache.redis.error");
    // DECISION POINT: serve stale L1 if available? Or go straight to DB?
    // For non-critical data: serve whatever L1 has (no error to user)
    // For critical financial data: go to DB (correctness > availability)
  }

  if (raw) {
    metrics.increment("cache.l2.hit", { entity: "product" });
    const data = JSON.parse(raw);
    localCache.set(key, data, 30); // populate L1, 30s TTL
    return data;
  }

  metrics.increment("cache.miss", { entity: "product" });

  // ── DB query ───────────────────────────────────────────────
  const product = await db.query(
    "SELECT id, name, price, stock_display, image_urls FROM products WHERE id = $1",
    [productId],
  );

  if (!product) {
    // NEGATIVE CACHING: Store a sentinel to prevent repeated DB hits for missing items
    // Common attack vector: scan for non-existent IDs → each misses cache → hammer DB
    await redis.setex(key, 60, "NULL_SENTINEL");
    return null;
  }

  // Populate L2 (Redis)
  const ttl = computeTTL(product); // e.g., shorter TTL for products with active discounts
  await redis.setex(key, ttl, JSON.stringify(product));

  // Populate L1
  localCache.set(key, product, 30);

  return product;
}
```

---

```javascript
// Cache-Aside WRITE — invalidation path, not update
async function updateProductPrice(productId, newPrice, updatedBy) {
  // ── STEP 1: DB update FIRST ────────────────────────────────
  // The DB is always updated before cache action.
  // If DB update fails: we abort. Cache is unchanged. No inconsistency.
  await db.transaction(async (trx) => {
    await trx.query(
      "UPDATE products SET price = $1, updated_by = $2, updated_at = NOW() WHERE id = $3",
      [newPrice, updatedBy, productId],
    );
    await trx.query(
      "INSERT INTO price_audit (product_id, old_price, new_price, changed_by, changed_at) ...",
    );
  });

  // ── STEP 2: DEL from Redis AFTER DB commits ────────────────
  // WHY DEL and not SET?
  //   SET with new price: race condition risk
  //   (a concurrent reader may overwrite your new SET with old data)
  //   DEL: forces next reader to re-fetch from DB with fresh data
  const key = `catalog:v1:product:${productId}`;
  try {
    await redis.del(key);
    metrics.increment("cache.invalidated", { entity: "product" });
  } catch (redisErr) {
    // Redis DEL failed. Cache still has old price.
    // TTL will eventually expire it, but we want faster resolution.
    logger.error("Cache invalidation failed — TTL will self-heal", {
      key,
      err: redisErr,
    });
    metrics.increment("cache.invalidation.failed");
    // Enqueue a retry: SQS message → Lambda → redis.del(key) with backoff
    await invalidationQueue.send({ key, retryCount: 0 });
  }

  // ── STEP 3: DEL from L1 (local in-process cache) ───────────
  // This only affects THIS server process. Other processes have stale L1.
  // They'll serve stale data for up to 30s (L1 TTL).
  localCache.delete(key);

  // ── OPTIONAL STEP 4: Publish invalidation event ────────────
  // Other processes: pub/sub listener → localCache.delete(key)
  // This shortens the L1 staleness window to near-zero.
  await redis.publish("cache:invalidate", JSON.stringify({ key }));
}
```

---

_→ Continued in: [02-Cache-Aside Pattern.md](02-Cache-Aside%20Pattern.md)_
