# Caching & Redis — Part 1 of 3

### Topic: Foundations — Intuition, Core Concepts, Architecture & Data Flow

**Series:** Scalability & Performance → Topic 06

---

## SECTION 1 — Intuition (Explain Like a 12-Year-Old)

```
RESTAURANT WITHOUT A CACHE (cook every order from scratch):

  Customer orders: "Grilled chicken with rice."
  Kitchen:
    ① Source chicken from cold storage          (10 seconds)
    ② Season and prep                           (90 seconds)
    ③ Fire up the grill, heat the pan           (120 seconds)
    ④ Cook chicken to temperature               (480 seconds)
    ⑤ Cook rice from dry                        (900 seconds)
    ⑥ Plate and serve                           (30 seconds)

    Total: ~27 minutes per order

  Customer 2 orders the same dish 3 minutes later.
  Kitchen: starts from scratch again. Another 27 minutes.

  Meanwhile: 200 customers are waiting. Kitchen is swamped.
  The grill is the bottleneck. Every order competes for it.
  Adding more customers doesn't add grill capacity.

RESTAURANT WITH CACHING (prep in advance, serve instantly):

  Prep shift (2AM–3AM): pre-grill 120 portions of chicken.
  Store in warmers at serving temperature.

  Service hour:
    Customer orders: "Grilled chicken with rice."
    Kitchen: plate from warmer + rice already steamed in batches.
    Serve: 90 seconds.

    Customer 2: same dish. 90 seconds.
    Customer 200: same dish. Still 90 seconds.

  Kitchen can now serve 200 customers in the time it used to serve 20.

  IN SOFTWARE:
    "Cooking from scratch" = querying the database for every request.
    "Pre-grilled chicken in the warmer" = result stored in Redis.
    "Order ticket" = the cache key (e.g., "product:prod_99").
    "Expiry time of the warmer food" = TTL.

  THE WARMER HAS LIMITS (this is where the analogy teaches architecture):
    ① Warmer holds limited portions (cache memory limit — eviction policy).
    ② Food gets stale if left too long (TTL / consistency problem).
    ③ If a dish is customized per customer, you can't pre-cook it (cache key design).
    ④ If today's special changes, you must update the warmer before serving (invalidation).

  Each of these limits maps to a real production problem.
  The rest of this topic teaches you how to handle each one.
```

---

### Why This Is an Architecture Shift, Not Just a Performance Trick

```
WITHOUT CACHE:
  System design is simple:
    Request → App Server → Database → Response
  Every request touches the database.
  The database is the truth store AND the query engine AND the serving layer.

  This is fine for:
    < 500 requests/second
    Simple queries (PK lookups, small result sets)
    Write-heavy workloads (every read is also fresh data)

WITH CACHE:
  System gains a NEW component with its OWN failure modes:

    Request → App Server → Cache (hit?) → YES: return cached result
                        ↓ NO (miss)
                        ↓
                    Database → Store in Cache → Return result

  You now have:
    TWO sources of truth (cache + DB can diverge)
    TWO failure modes (cache failure, DB failure — different behaviors)
    TWO eviction/expiry systems (TTL, LRU eviction in cache)
    TWO read paths (cache hit path vs cache miss path — different performance profiles)
    NEW invalidation complexity (when DB changes, cache may be stale)

  A CACHE CHANGES YOUR ARCHITECTURE. It's not a drop-in optimization.
  Engineers who treat it as "just add Redis" create the worst production incidents.
```

---

## SECTION 2 — Core Technical Explanation

### The DB Is Not Designed to Be Your Serving Layer

```
WHAT A DATABASE IS DESIGNED FOR:
  - Durability (write to disk, survive reboots)
  - Consistency (ACID transactions)
  - Flexible queries (JOINs, aggregations, filters)
  - Correctness under concurrent writes

  It is NOT designed for:
  - Serving thousands of identical reads per second
  - Sub-millisecond response times under load
  - Horizontal read scaling to millions of requests/second

WHY IT BECOMES A BOTTLENECK AT SCALE:

  1. EVERY QUERY GOES TO THE SAME MACHINE (before read replicas):
     1,000 users all request the same product page.
     1,000 SQL queries hit the same RDS instance.
     Query execution is parallel but I/O is shared.
     Buffer pool is the same. CPU is the same.
     At ~2,000-5,000 queries/second: most RDBMS instances start to struggle.

  2. IDENTICAL QUERIES REPEATED AT HIGH FREQUENCY:
     SELECT * FROM products WHERE id = 99
     ...executed 10,000 times per minute.
     Even with optimal indexing: 10,000 rows read from disk → deserialize → serialize.
     Same answer every time. All that computation to return unchanged data.

  3. CONNECTION LIMIT:
     PostgreSQL: default 100 max connections (configurable but bounded).
     Each app server: maintains a connection pool (e.g., 10 connections).
     At 20 app servers: 200 connections consumed — already past default.
     RDS connection limit at instance scale:
       db.t3.medium: 420 connections max
       db.r6g.large: 1,350 connections max
     With auto-scaling app layer: you hit the DB connection ceiling.

  4. LOCK CONTENTION:
     READ queries don't lock rows, but:
     Heavy read traffic shares buffer pool and read I/O with write transactions.
     A long-running analytics query holds a table read lock.
     All subsequent reads queue behind it.

WHAT THE DB LOOKS LIKE BEFORE A CACHE INCIDENT:

  Metrics (RDS CloudWatch):
    DatabaseConnections:    312/420 (near ceiling)
    ReadIOPS:               8,400 (sustained)
    CPUUtilization:         78%
    ReadLatency:            48ms (was 8ms last week)
    FreeableMemory:         450MB (buffer pool is exhausted — reads from disk)

  What's happening:
    Buffer pool can't hold the full working set in memory.
    Every query that doesn't hit the OS buffer cache → disk I/O.
    48ms = disk read latency.
    8ms = memory read latency (when buffer pool was sufficient).

  ADDING CACHE HERE:
    10,000 product reads/min → 10,000 Redis GETs/min.
    Cache hit rate: 95% → 9,500 Redis GETs (< 0.5ms each).
    Only 500 cache misses → 500 DB reads/min.
    DB ReadIOPS: 8,400 → 500 (94% reduction).
    DB CPU: 78% → 12%.
    DB ReadLatency: 48ms → 8ms (buffer pool now fits working set).

  The cache didn't make the DB faster. It made the DB irrelevant for most reads.
```

---

## SECTION 3 — Architecture Diagram (MANDATORY)

### Three Patterns: Cache-Aside, Read-Through, Write-Through

```
PATTERN 1: CACHE-ASIDE (most common in production)

  The APPLICATION is responsible for managing the cache.
  Cache and DB know nothing about each other.
  App code: check cache → hit: return. Miss: read DB, populate cache.

  READ FLOW:

  ┌────────┐   1. GET product:99         ┌───────────────────┐
  │Client  │──────────────────────────►  │ App Server        │
  └────────┘                             │                    │
                                         │  2. Redis GET      │
                                         │  product:99 ──────►│─────► Redis
                                         │                    │       └─ KEY NOT FOUND (miss)
                                         │  3. DB SELECT      │
                                         │  WHERE id=99 ─────►│─────► Database
                                         │                    │       └─ Returns { id:99, name:"..." }
                                         │  4. Redis SET      │
                                         │  product:99 ──────►│─────► Redis
                                         │  EX 3600           │       └─ Stored with 1hr TTL
                                         │  5. Return data    │
  ┌────────┐   6. Response               │                    │
  │Client  │◄──────────────────────────  │ App Server        │
  └────────┘                             └───────────────────┘

  Next READ (within 1hr):
  Step 2: Redis GET product:99 → HIT → return immediately.
  Steps 3 + 4 skipped.

──────────────────────────────────────────────────────────────────────────────

PATTERN 2: READ-THROUGH

  Cache sits IN FRONT of the database.
  App ONLY talks to the cache.
  Cache is responsible for fetching from DB on a miss.

  ┌────────┐   1. GET product:99     ┌────────────┐    2. MISS: fetch     ┌──────────┐
  │Client  │────────────────────────►│   Cache    │──────────────────────►│ Database │
  │        │                         │  (Redis /  │    3. Returns data    │          │
  │        │   4. Return data        │   Memcache │◄──────────────────────│          │
  │        │◄────────────────────────│   with     │    (cache stores it)  └──────────┘
  └────────┘                         │  loader fn)│
                                     └────────────┘

  DIFFERENCE FROM CACHE-ASIDE:
    App code: simpler (one place to read: the cache).
    Cache: must know how to load from DB (needs a "loader" function / driver).
    AWS ElastiCache: supports this pattern via DAX (DynamoDB Accelerator) natively.
    For custom Redis: you implement the loader logic in a shared service.

──────────────────────────────────────────────────────────────────────────────

PATTERN 3: WRITE-THROUGH

  Every WRITE goes to both cache AND database synchronously.
  Cache is always up to date.

  ┌────────┐  1. POST product update  ┌────────────┐  2. Write cache + DB   ┌──────────┐
  │Client  │─────────────────────────►│ App Server │───────────────────────►│ Redis    │
  │        │                          │            │                         │ Database │
  │        │  5. Return 200           │            │  4. Both ACK           │(both hit)│
  │        │◄─────────────────────────│            │◄───────────────────────│          │
  └────────┘                          └────────────┘  3. Writes in parallel └──────────┘

  TRADEOFF:
    ✅ Cache is always consistent with DB — no stale reads.
    ❌ EVERY write has dual-write overhead (Redis + DB in same request).
    ❌ If Redis write fails: do you rollback the DB write? (consistency problem)
    ❌ Cache fills with data that may never be read again (cache pollution).

  USE FOR: write-heavy but read-even-heavier data (e.g., user preferences, config).
  AVOID FOR: high-write-volume systems where write latency matters.
```

---

## SECTION 4 — Request Flow (MANDATORY FLOWCHART)

### Annotated: Exactly What Happens at Each Step

```
CACHE-ASIDE READ — Line-by-Line Code Analysis:

async function getProduct(productId) {
  const cacheKey = `product:${productId}`;

  // ── STEP 1: Check Redis ───────────────────────────────────────────────
  const cached = await redis.get(cacheKey);
  //   Actual Redis command: GET product:99
  //   Redis: O(1) hash table lookup by key.
  //   Latency: 0.3-0.5ms (same AZ, keep-alive connection)

  if (cached) {
    // ── STEP 2: Cache HIT ─────────────────────────────────────────────
    return JSON.parse(cached);
    //   Cost: 0 DB calls. 0.5ms total including network.
    //   P99 at this point: < 2ms.
  }

  // ── STEP 3: Cache MISS – fetch from DB ───────────────────────────────
  const product = await db.query(
    'SELECT id, name, price, stock FROM products WHERE id = $1',
    [productId]
  );
  //   DB round-trip: 8-50ms depending on buffer pool + connection pool state.
  //   If product doesn't exist: product = null.

  if (!product) {
    // ── STEP 4: Store NULL to prevent repeated DB misses ──────────────
    await redis.setex(cacheKey, 60, 'null');        // 60s TTL for null sentinel
    //   WHY: if this key doesn't exist in DB, every request would miss cache
    //   AND hit DB. "Cache null values" prevents DB hammering on non-existent keys.
    //   This is "negative caching" — prevents DB abuse for missing resources.
    return null;
  }

  if (product) {
    // ── STEP 5: Store in Redis with TTL ──────────────────────────────
    await redis.setex(cacheKey, 3600, JSON.stringify(product));
    //   SETEX key seconds value
    //   TTL: 3600s (1 hour). After 1hr: key automatically deleted.
    //   Next request after TTL: cache miss → DB hit again.
    //   JSON.stringify: Redis stores strings/bytes, not objects. Serialize first.
    return product;
  }
}

──────────────────────────────────────────────────────────────────────────────

CACHE-ASIDE WRITE — The Update Problem:

async function updateProductPrice(productId, newPrice) {

  // ── STEP 1: Update Database (source of truth) ─────────────────────────
  await db.query(
    'UPDATE products SET price = $1, updated_at = NOW() WHERE id = $2',
    [newPrice, productId]
  );

  // ── STEP 2: Invalidate Cache (NOT update) ────────────────────────────
  await redis.del(`product:${productId}`);
  //   WHY DEL, not SET?
  //   Option A: SET with new value. But the DB transaction may not have
  //             committed by the time Redis is updated (race condition).
  //             Under replication lag: the "new" data in Redis may still
  //             be wrong if you read it back from a replica.
  //
  //   Option B: DEL the key. Next read: cache miss → fresh DB read → re-populate.
  //             Slightly more DB load (one cache miss per updated key, per read).
  //             But: guaranteed fresh data on the next read.
  //
  //   Standard practice: DELETE on write, re-populate on next read.

  // ── WHAT IF REDIS DEL FAILS? ─────────────────────────────────────────
  //   DB update succeeded. Redis DEL failed (Redis blip, network).
  //   Cache now has STALE data. Every read for this product:
  //   returns old price until TTL expires (up to 1hr).
  //
  //   MITIGATION: Short TTLs (5-30 minutes) limit the staleness window.
  //   MITIGATION: Retry DEL with exponential backoff.
  //   MITIGATION: Background job: scan for modified DB records, bust cache.
}
```

---

_→ Continued in: [02-Caching & Redis.md](02-Caching%20%26%20Redis.md)_
