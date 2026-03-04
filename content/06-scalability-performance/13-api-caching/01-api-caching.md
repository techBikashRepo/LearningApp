# API Caching — Part 1 of 3

### Topic: Foundations — Intuition, Core Concepts, Architecture & Data Flow

**Series:** Scalability & Performance → Topic 13

---

## SECTION 1 — Intuition (Explain Like a 12-Year-Old)

```
THE LIBRARY CATALOG MODEL:

  A vast library. Millions of books. You want to find "System Design Interview Vol 2."

  OPTION A: Walk directly through the stacks.
  Search every row until you find it. O(N) time. Exhausting.

  OPTION B: Check the catalog card index first.
  Walk to the index (30 seconds).
  Find: "System Design Interview Vol 2 → Shelf C, Row 4."
  Walk to the book directly (30 seconds). Done in 1 minute.

  OPTION C: Yesterday you checked the same book. You remembered shelf C, row 4.
  You walk directly there without the catalog. Done in 30 seconds.

  API CACHING IS OPTION C AT EACH LAYER:

  BROWSER (your memory):
    You already fetched this API response 5 minutes ago.
    No network request at all. Served from your local memory.
    Cost: 0. Latency: 0.

  CDN (the catalog at the library entrance):
    Browser doesn't have it. CDN at the Internet edge does.
    Served from CDN node 10ms away.
    Original API server: not contacted.
    Cost: near zero (CDN edge compute). Latency: CDN RTT (10–50ms).

  API GATEWAY CACHE (catalog at the elevator):
    CDN misses. API Gateway in your VPC has it cached.
    Your backend app: not contacted.
    Cost: Gateway compute. Latency: internal network only.

  REDIS CACHE (library's fast catalog):
    API Gateway misses. App queries Redis.
    Database: not contacted.
    Cost: Redis memory. Latency: 0.3ms network to Redis.

  ORIGIN DB (the actual books):
    Everything misses. Raw database query.
    Full processing. Most expensive.
    Cost: DB compute + storage I/O. Latency: 5–100ms.

  FOR AN API CALL:

  Without caching: EVERY request = DB query.
  100,000 requests/minute → 100,000 DB queries/minute.

  With good caching:
  99% of requests: served from CDN or Redis.
  1,000 requests/minute → DB.
  100,000 req/min → DB effectively reduced to 1,000 req/min.
  DB can handle its actual workload. No over-provisioning required.
```

---

## SECTION 2 — Core Technical Explanation

### Why API Calls Are Expensive (and What Caching Solves)

```
THE FOUR COSTS OF AN UNCACHED API CALL:

  1. EXTERNAL API RATE LIMITS (third-party APIs)
     You call a weather API, a payment gateway, or a geocoding service.
     Each has a rate limit: 100 requests/second, 10,000/day, etc.
     Exceeding: 429 errors. Your service fails.

     SOLUTION: Cache the response. One API call → N users served.
     Weather for "New York City": same response for all users facing NYC.
     Cache for 5 minutes. One external call per 5 minutes, not one per user.

  2. EXTERNAL API COST (per-call pricing)
     Google Maps Geocoding API: $0.005 per call. 1,000,000 daily address lookups = $5,000/day.
     With caching: if 80% of lookups are for the same addresses → 200K unique calls → $1,000/day.
     60% cost reduction by caching repeated lookups.

  3. INTERNAL DB LOAD
     Every API request hitting the DB: CPU, I/O, connections.
     Product detail page: joins products + inventory + pricing + seller info.
     At 10,000 users/minute: 10,000 database queries/minute.
     DB: needs significant compute to handle this.

     With Redis cache: 9,800 hits (98% hit rate) → served from Redis.
     200 DB queries/minute. DB sized for 200, not 10,000.
     DB compute cost: 50× lower.

  4. LATENCY FOR THE USER
     DB query: 10ms average. Network: 20ms. App processing: 5ms. Total: 35ms.
     Redis cached: DB+app skipped. Redis: 0.5ms. Network: 20ms. Total: 20.5ms.
     CDN cached: everything except CDN edge skipped. Total: 5ms.
     Browser cached: 0ms.

     Each cache hit removes cost from the critical path.

TYPES OF API RESPONSES: WHAT CAN BE CACHED?

  CACHEABLE (same response for same request, regardless of who asks):
    Product catalog: GET /products/99 → same JSON for all users.
    Weather data: GET /weather?city=NYC → same response for all NYC queries.
    Static content: GET /config/features.json → same for everyone.
    Currency rates: GET /fx/USD-EUR → same for all users.

  PRIVATE CACHEABLE (same response for same user, same parameters):
    User profile: GET /users/me → different per user, but same if user re-requests.
    Order history: GET /orders?userId=123 → specific to user 123.
    Cache in private CDN layer (Vary: Authorization) or Redis per-user key.

  NOT CACHEABLE:
    Real-time data: GET /stock/AAPL → price changes every millisecond.
    User-specific mutations: POST /orders → creates a new order, no cache point.
    Search with unique queries: GET /search?q=randomUniqueQuery → no repeated reads.
    Authenticated write operations: PATCH, PUT, DELETE → mutate state. Must not cache.
```

---

## SECTION 3 — Architecture Diagram (MANDATORY)

### How the Browser and CDN Know What to Cache

```
The HTTP cache control system: a negotiation between server (sets policy) and client/CDN (follows policy).

CACHE-CONTROL HEADER (the master directive):

  Response header: Cache-Control: <directives>

  KEY DIRECTIVES:

  max-age=N:
    Cache this response for N seconds.
    After N seconds: stale. Must revalidate.

    Cache-Control: max-age=3600 → browser/CDN caches for 1 hour.

  s-maxage=N:
    Shared cache max-age (CDN-specific TTL). Overrides max-age for CDN.
    Browser respects max-age. CDN respects s-maxage.

    Cache-Control: max-age=60, s-maxage=3600
    → Browser caches for 60s (more fresh). CDN caches for 3600s (longer, more efficient).

  public:
    Any cache (browser, CDN, proxy) may cache this.
    Required for CDN caching.
    Default for GET with no Authorization header.

  private:
    Only the end-client (browser) may cache. Intermediate proxies/CDNs must not.
    Required for user-specific responses when shared caches would leak data across users.

    Cache-Control: private, max-age=3600 → browser caches, CDN does NOT.

  no-cache:
    May be cached but MUST revalidate with server before each use.
    Sends conditional request (If-None-Match or If-Modified-Since).
    Server returns 304 Not Modified (no body) if unchanged → efficient.
    Server returns 200 + new body if changed.
    "no-cache" does NOT mean "don't cache." It means "cache but always check freshness."

  no-store:
    DO NOT cache anywhere. Not in browser, not in CDN, not in any proxy.
    For truly sensitive data: payment confirmations, OTP codes.
    "no-store" means "actually don't cache."

  stale-while-revalidate=N:
    After max-age expires: serve the stale response IMMEDIATELY.
    Simultaneously in the background: fetch fresh response.
    For N more seconds: stale is served while fresh is being fetched.

    Cache-Control: max-age=60, stale-while-revalidate=30
    At t=61: response is stale. Return stale immediately (no user latency).
    Background: fetch fresh. At t=65: fresh available. Next request: gets fresh.
    Benefit: zero-latency cache refresh from user's perspective.

  stale-if-error=N:
    If origin is DOWN: serve stale response for N more seconds.
    Graceful degradation.

    Cache-Control: max-age=3600, stale-if-error=86400
    Price API crashes at t=7200. Browser/CDN: has 86400s allowance to serve stale price.
    Users: see slightly stale prices instead of error pages.

ETAG AND CONDITIONAL REQUESTS:

  Server sets ETag:
    Response header: ETag: "abc123" (hash of the content or version ID).
    Browser stores it alongside the cached response.

  On subsequent request:
    Request header: If-None-Match: "abc123"
    Server compares ETag to current content.
    If unchanged: 304 Not Modified (no body, just headers). ~100 bytes instead of 5KB.
    If changed: 200 OK with new ETag and new body.

  BENEFIT: bandwidth savings. For mobile users: significant.
  For large API responses (50KB): conditional request = 99.8% bandwidth reduction on hit.

  LAST-MODIFIED alternative:
    Response: Last-Modified: Wed, 15 Jul 2025 10:00:00 GMT
    Request: If-Modified-Since: Wed, 15 Jul 2025 10:00:00 GMT
    Less precise than ETag (timestamp resolution = 1 second). ETag is preferred.

VARY HEADER:

  Tells CDN: cached response depends on this request header.

  Vary: Accept-Encoding
    CDN caches separate versions for gzip vs brotli vs uncompressed responses.

  Vary: Accept-Language
    Cache separate responses for en, fr, es.

  Vary: Authorization
    DANGER: caches a separate response per Authorization token.
    Effectively disables CDN caching for authenticated endpoints (one cached version per user).

  Practical rule:
    Do NOT use Vary: Authorization in CDN config for authenticated endpoints.
    Instead: don't cache authenticated endpoints at CDN layer at all.
    Cache user-specific data in Redis per-user key (no CDN).
    Cache public data in CDN with no Vary: Authorization.
```

---

## SECTION 4 — Request Flow (MANDATORY FLOWCHART)

### Positioning Caches at Each Layer

```
THE 5-LAYER CACHE HIERARCHY:

  ┌─────────────────────────────────────────────────────────────────────────────────────────┐
  │  REQUEST FLOW: User → Browser → CDN → API Gateway → App + Redis → DB                  │
  │                                                                                          │
  │  Layer 1: BROWSER CACHE                                                                  │
  │    Where: user's local storage                                                           │
  │    What: static assets (JS, CSS, images). API responses with public max-age.            │
  │    TTL: max-age in Cache-Control.                                                        │
  │    Hit: 0ms. No network.                                                                 │
  │    Control: Cache-Control response header.                                               │
  │                                                                                          │
  │  Layer 2: CDN CACHE (CloudFront, Fastly, Akamai)                                        │
  │    Where: edge nodes near users globally.                                                │
  │    What: public API responses, static assets, cacheable pages.                          │
  │    TTL: s-maxage or CloudFront behavior TTL.                                             │
  │    Hit: 5–50ms (nearest edge node). ~70–90% of traffic absorbed here for popular APIs.  │
  │    Control: Cache-Control (s-maxage), CloudFront cache behaviors per path.              │
  │                                                                                          │
  │  Layer 3: API GATEWAY CACHE                                                              │
  │    Where: API Gateway (AWS) or reverse proxy (Nginx, Kong).                             │
  │    What: query result caching. Per-stage or per-method.                                  │
  │    TTL: 0–3600s in API Gateway cache settings.                                          │
  │    Hit: ~1ms (VPC-internal). Absorbs remaining N% not served by CDN.                   │
  │    Use for: endpoints CDN can't cache (authorization headers, dynamic path).            │
  │                                                                                          │
  │  Layer 4: APPLICATION CACHE (Redis / Memcached)                                          │
  │    Where: in-memory cache sidecar/cluster (ElastiCache).                                │
  │    What: DB query results, computed data, per-user data.                                │
  │    TTL: configurable per entity type.                                                    │
  │    Hit: 0.5–2ms (Redis network hop). Primary hit-or-miss decision for backend logic.   │
  │    Control: application code. Full flexibility in keys and TTLs.                        │
  │                                                                                          │
  │  Layer 5: DATABASE INDEX CACHE (DB buffer pool)                                          │
  │    Where: within the DB (Postgres/MySQL shared_buffers / InnoDB buffer pool).           │
  │    What: hot data pages in memory inside the DB process.                                │
  │    Hit: 1–3ms (no disk I/O — data already in DB memory).                               │
  │    Miss: 10–100ms (disk I/O — reads from SSD/EBS).                                     │
  │    Control: DB configuration (shared_buffers: size of buffer pool).                    │
  └─────────────────────────────────────────────────────────────────────────────────────────┘

WHAT EACH LAYER IS GOOD FOR:

  BROWSER: Repeat visits. Saves bandwidth. No server cost. Limited to that user's browser.

  CDN: Geographic distribution. High-traffic public APIs.
       Public product catalog: GET /products/99 → identical for 1M users.
       CDN: 1 origin fetch → serves 1M users from edge. 1M : 1 origin savings.

  API Gateway cache: Authenticated APIs where CDN can't cache. VPC-internal savings.
                     Dynamic APIs that are still idempotent per input combination.

  Redis: User-specific data. Complex computations. Write-through patterns.
         User's recommendation list, user's dashboard computed data.
         Also: sessions, rate limits, and any data beyond just caching responses.

  DB buffer pool: Always active. Background optimization. Nothing to configure in app code.

ANTI-PATTERNS TO AVOID:

  ❌ Caching at CDN with no cache invalidation:
     Product price changes. CDN has cached GET /products/99 with old price.
     Users see stale price until CDN TTL expires.
     SOLUTION: either use short TTL (60s) OR set up CDN invalidation via API.
     CloudFront CreateInvalidation: clears specific paths on product update.

  ❌ Caching user-specific responses at CDN without Vary or private:
     User A logs in. API returns their profile. CDN caches it.
     User B requests the same URL. CDN returns User A's profile.
     Data leak between users.
     SOLUTION: Cache-Control: private on all user-specific API responses.
               CDN BYPASSES cache for requests with Authorization header (configure CDN).

  ❌ Infinite TTL on API responses:
     Cache-Control: max-age=9999999 → browsers and CDNs cache "forever."
     Product is discontinued. API response says "in stock: true" for months.
     SOLUTION: use Surrogate-Key (Fastly) or cache tags (CloudFront) for targeted invalidation.
               Or: max-age 300–3600s for most API data. Never permanent.
```

---

_→ Continued in: [02-API Caching.md](02-API%20Caching.md)_
