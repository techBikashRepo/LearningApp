# API Caching — Part 2 of 3

### Topic: Real World Examples, System Design Importance, AWS Mapping & Interview Prep

**Series:** Scalability & Performance → Topic 13

---

## SECTION 5 — Real World Example

### Building Keys That Uniquely Identify a Response

```
A CACHE KEY MUST UNIQUELY IDENTIFY THE RESPONSE CONTENT.

  If two requests would get the same response: they should map to the same key.
  If two requests would get different responses: they must map to different keys.

  Get this wrong:
  Same key for different responses → user gets wrong data.
  Different keys for same response → cache miss rate inflates. No reuse.

COMPONENTS OF AN API CACHE KEY:

  1. METHOD + PATH
     GET:/api/v1/products:99 → base key.
     POST:/api/v1/orders → NEVER CACHE. Don't include POST in cache key design.

  2. QUERY PARAMETERS (include all that affect response content)
     GET /products?sort=price&category=electronics&page=2
     Key: products?sort=price&category=electronics&page=2

     Sort params: must be in key. Different sort → different response.
     Include page/limit: different page → different content.
     Exclude UI-only params that don't affect response:
       utm_source, utm_campaign, ref → tracking params. Don't affect response.
       If included in key: GET /products?category=electronics&utm_source=google
       ≠ GET /products?category=electronics&utm_source=twitter
       Same response, different keys. Cache miss. Wasted.
       NORMALIZE: strip tracking params before building cache key.

  3. AUTHENTICATION SCOPE (for private/user-specific responses)
     User-specific: cache key must include userId or scope.
     GET /me → different user gets different profile.
     Key: user:v1:profile:{userId} (Redis key, not URL-based).

     DO NOT include raw Authorization token in CDN cache key.
     Reason: token rotates (refresh). New token → different cache key → always misses.
     Extract stable claim (userId or scope fingerprint) if caching at app layer.

  4. CONTENT NEGOTIATION (if response format varies by Accept header)
     GET /products/99 with Accept: application/json → JSON response.
     GET /products/99 with Accept: application/xml → XML response. (Rare, but exists.)
     Different cache keys or use CDN with Vary: Accept.

  5. API VERSION
     GET /api/v1/products → cache key: api:v1:products:99
     GET /api/v2/products → different key. Schema might differ.

KEY NORMALIZATION (CRITICAL FOR CDN AND REDIS):

  Problem: Query parameter ORDER varies between clients.
  Client A: GET /products?category=electronics&sort=price
  Client B: GET /products?sort=price&category=electronics
  Same response. Different URL strings. CDN: two separate cache entries.
  Effectively doubles cache key space unnecessarily.

  SOLUTION: Normalize before key construction.
  Sort query params alphabetically before joining.
  category=electronics&sort=price → normalized key regardless of input order.

  Implementation (middleware or CDN configuration):
    CloudFront: "Query string parameters - Include all, Sort" behavior.
    Application cache key:
      const sortedParams = Object.keys(query).sort().map(k => `${k}=${query[k]}`).join('&');
      const cacheKey = `${namespace}:${path}?${sortedParams}`;

CACHE KEY EXAMPLES BY SCENARIO:

  SCENARIO 1: Public product catalog (CDN-cacheable)
    URL: GET /api/v1/products/99
    CDN cache key: path = /api/v1/products/99, method = GET.
    No user context. No query params affecting product detail.
    Cache-Control: public, max-age=300, s-maxage=3600
    CDN TTL: 1 hour. Browser TTL: 5 min.

  SCENARIO 2: Product search (CDN-cacheable with query params)
    URL: GET /api/v1/products?q=laptop&sort=price&page=1&limit=20
    CDN normalized key: /api/v1/products?limit=20&page=1&q=laptop&sort=price
    Strip: utm_*, ref, fbclid, gclid (tracking params).
    Cache-Control: public, max-age=60, s-maxage=300
    Short TTL: search results may change (new products, inventory).

  SCENARIO 3: User's order history (Redis only, no CDN)
    URL: GET /api/v1/orders?userId=12345&page=1
    Redis key: orders:v1:user:12345:page:1
    Cache-Control: private, max-age=30 (browser brief cache, CDN bypassed)
    Redis TTL: 5 minutes.
    Invalidated: when new order created for user 12345.

  SCENARIO 4: Rate-limited external API response (Redis, expensive to re-fetch)
    Weather for NYC: fetched from OpenWeather API.
    Key: external:weather:v1:city:NYC
    TTL: 5 minutes (weather doesn't change faster).
    On miss: fetch from external API → cache result → return.
    Avoids hitting rate limit when same city requested by many users.
```

---

## SECTION 6 — System Design Importance

### What Goes Wrong with API Caching

```
FAILURE 1: CACHE POISONING

  Definition: malicious or erroneous response stored in cache and served to other users.

  HOW IT HAPPENS:

  Vector 1: Response Manipulation via URL injection.
    Attacker sends: GET /api/products/99?evil_param=<script>xss</script>
    If param reflected in response AND cached:
    All users who request /api/products/99: get XSS payload.

    PREVENTION:
    Sanitize all response output. Never reflect unvalidated input.
    Normalize cache keys (strip unknown params before caching).

  Vector 2: Unkeyed Header Injection (Host header poisoning).
    Attacker sends: GET /api/products/99 with Host: evil.com
    App generates URL based on Host header: "next page URL = http://evil.com/products/..."
    If cached and served to others: users see evil.com URLs in response.

    PREVENTION:
    Never build response URLs from unvalidated Host header.
    Whitelist valid host values. Log/block unexpected Host headers.

  Vector 3: Authenticated user's private data in public CDN cache.
    Developer forgets to set Cache-Control: private.
    CDN caches user A's /api/me (their profile).
    User B requests /api/me → same CDN key → user A's profile returned.

    PREVENTION: ALL /me, /user, /profile endpoints → Cache-Control: private.
    Review every authenticated endpoint. Explicit opt-in to public caching.
    CDN rule: requests with Authorization header → bypass cache (unless explicitly configured).

FAILURE 2: STALE DATA AFTER UPDATE

  Scenario: product price updated in DB.
  CDN: has cached GET /products/99 with old price.
  CDN TTL: 1 hour.
  Users: see old price for up to 1 hour.
  Checkout attempts: may succeed or fail depending on server-side validation.

  SOLUTIONS:

  A) SHORTER TTL (simplest):
    Cache-Control: s-maxage=60 (1 minute CDN TTL).
    Max 60s of staleness. Usually acceptable for most data.
    Cost: more origin requests (CDN refresh every 60s).

  B) CACHE TAG INVALIDATION (best for frequently changing data):
    Response header: Cache-Tag: product-99 (Cloudflare, Fastly)
    or: Surrogate-Key: product-99 (Fastly terminology)

    On product update: call Fastly/Cloudflare API.
    POST /purge with tag: product-99 → all cached responses tagged product-99 invalidated.
    Sub-second invalidation globally.

    CloudFront: CreateInvalidation API.
    CloudFront::InvalidationBatch: [{Paths: {'/api/v1/products/99', '/api/v1/products/99/*'}}]

  C) VERSIONED URLS (cache busting):
    /api/v1/products/99?v=1720000000 (version = last modified timestamp).
    When product updates: new URL (new version). Old URL expires naturally.
    Works for browser and CDN.
    Application client: must track product version. Complexity increases.

FAILURE 3: THUNDERING HERD ON CACHE EXPIRY

  1000 concurrent users request the same product.
  Redis cache expires simultaneously.
  All 1000 go to DB simultaneously. DB: saturated.

  Solutions covered in TTL Strategy topic:
  Jitter on TTL: expiry spread. Mutex lock: only one fills cache. Stale-while-revalidate.

FAILURE 4: AUTH DATA LEAKAGE ACROSS TENANTS (SaaS multi-tenancy)

  SaaS app. Tenants A and B.
  GET /api/invoices?limit=10 → returns tenant A's invoices (from last login).
  CDN caches response.
  Tenant B's user happens to make same request → CDN returns tenant A's data.

  PREVENTION:
  Cache key MUST include tenant ID or scope.
  Redis: api:v1:invoices:{tenantId}:{userId}:page:1
  CDN: do NOT cache any response containing tenant-scoped data.
  CDN: business-logic-based caching decisions (cache only public endpoints, never invoices).
```

---

## SECTION 7 — AWS & Cloud Mapping

### When Your API Design Breaks Standard Caching

```
WHY GRAPHQL BREAKS HTTP CACHING:

  REST: GET /products/99 → deterministic URL. CDN caches by URL.

  GraphQL: typically POST /graphql with body:
    {
      "query": "{ product(id: 99) { name price } }",
      "variables": { "id": 99 }
    }

  HTTP caching: typically for GET requests. POST requests: not cached by CDN (POST = can mutate state).
  CDN: sees POST /graphql → does not cache. All GraphQL requests hit origin.

  SOLUTION 1: PERSISTED QUERIES (industry standard)
    Pre-register queries on the server with a hash ID.
    Client sends: GET /graphql?queryHash=abc123&id=99 (GET, not POST).
    Server looks up pre-registered query by hash, executes with variables.
    CDN: can cache GET /graphql?queryHash=abc123&id=99.

    Apollo Server: supports persisted queries natively.

    Benefits: CDN-cacheable. URL is stable per query type.
    Also: request size reduction (client sends hash, not full query text).
    And: security (only pre-registered queries can run — prevents arbitrary query injection).

  SOLUTION 2: CDN + GRAPHQL EDGE WORKERS
    Cloudflare Workers: intercept GraphQL POST requests at the edge.
    Worker: parses the POST body, extracts query hash, constructs a cache key.
    Worker: checks edge KV cache. Hit → return. Miss → forward to origin.

    More complex but provides CDN-like caching for POST-based GraphQL.

  SOLUTION 3: REDIS MEMOIZATION AT THE RESOLVER LEVEL
    GraphQL resolver: the function that fetches data for each field.
    Wrap resolvers with Redis cache:

    const productResolver = async (_, { id }) => {
      const cacheKey = `graphql:product:v1:${id}`;
      const cached = await redis.get(cacheKey);
      if (cached) return JSON.parse(cached);

      const product = await dbQuery.getProduct(id);
      await redis.setex(cacheKey, 300, JSON.stringify(product));
      return product;
    };

    Each resolver: independently cached.
    Complex queries: compose from cached resolvers.

  SOLUTION 4: DATALOADER (N+1 PROBLEM SOLUTION + BATCHING)
    GraphQL N+1 problem: resolving 10 products → N resolver calls → N DB queries.
    DataLoader: batches N individual lookups into one DB query per request.

    Does not cache across requests by itself.
    Combined with Redis: DataLoader batches + Redis caches across requests.

  WHAT ABOUT MUTATIONS?
    GraphQL mutations = state changes. Never cache.
    On mutation: invalidate relevant cached queries.
    Product price mutation → invalidate graphql:product:v1:{id}.
    Implement invalidation in mutation resolvers.
```

---

## SECTION 8 — Interview Preparation

**Beginner:**

**Q: What is API caching and how is it different from database caching?**
**A:** Database caching (e.g., Redis) saves raw database query results. API caching saves the entire HTTP response â€” headers, body, status code. The difference: API caching can happen at multiple layers (CDN, load balancer, application, client) and can cache responses from external APIs you call, not just your own database. Example: your weather API calls OpenWeatherMap. Cache OpenWeatherMap's response for 10 minutes â€” no need to hit their API 1,000 times per second.

**Q: What do HTTP cache headers do?**
**A:** Cache headers tell browsers, CDNs, and proxy servers how to cache the response. Key headers: Cache-Control: max-age=3600 (cache for 1 hour), Cache-Control: no-store (never cache, e.g., for sensitive data), ETag (a version hash â€” browser asks "changed since this hash?" and gets a 304 Not Modified if not), Last-Modified (timestamp version). Setting these correctly enables caching at every layer without application-specific code.

**Q: When should you NOT cache an API response?**
**A:** Never cache: authenticated user-specific data with Cache-Control: public (other users will see it!), payment or order creation responses (must always be fresh), responses containing one-time tokens or verification codes. Always add Cache-Control: private for user-specific responses, 
o-store for highly sensitive data, and vary by Authorization or Cookie headers if responses differ per user.

---

**Intermediate:**

**Q: What is the difference between CDN caching and Redis application-level caching, and which should you use?**
**A:** *CDN caching:* operates at the network edge (globally distributed), serves cached responses without your servers being involved at all. Best for: public, non-personalized content (product images, static pages, public API responses). *Redis application caching:* operates inside your application. Only your servers are bypassed â€” CDN still receives the request. Best for: personalized content, data that requires business logic before returning, or when caching prevents expensive DB queries (not just saves bandwidth). Use CDN for public content; Redis for personalized or dynamic business logic.

**Q: What is an API caching stampede and how does it differ from a database stampede?**
**A:** An API caching stampede is identical in mechanism to a database stampede: cached response expires â†’ many concurrent requests all miss cache â†’ all call the upstream API or database simultaneously â†’ thundering herd. With *external* API calls, this is worse because: (1) You might hit rate limits on the external API (e.g., Only 100 calls/minute), causing errors instead of just slowness. (2) External APIs may charge per call. Prevention: mutex lock on the cache key â€” only one request calls the upstream API; others wait for the result.

**Q: How do you implement conditional requests (ETags) to reduce bandwidth for API caching?**
**A:** (1) Server generates an ETag (hash of response content) and includes it in responses. (2) Client stores the ETag. (3) On next request, client sends If-None-Match: {etag}. (4) Server checks: if content unchanged â†’ returns 304 Not Modified (no body, just headers â†’ tiny response). If changed â†’ returns 200 with new content + new ETag. This reduces bandwidth for frequently polled APIs (dashboards, status checks) without sacrificing freshness â€” the server still does the freshness check, but doesn't retransmit unchanged data.

---

**Advanced (System Design):**

**Scenario 1:** Design the API caching strategy for a B2B SaaS platform where: (a) public product pricing pages must be real-time accurate, (b) each customer gets a personalized dashboard with custom analytics, (c) a public status page must show real-time system status. Each has different caching requirements.

*Pricing pages:* CDN cache with short TTL (60s) + ETag for conditional requests. On price change â†’ CDN cache invalidation via API (CloudFront invalidation API). CDN handles 99% of traffic; your servers handle only cache misses.
*Personalized dashboard:* No CDN (user-specific). Redis cache per user (dashboard:{userId} â†’ pre-computed analytics). Background job refreshes every 5 minutes. On-demand refresh button triggers immediate recalculation and cache update.
*Status page:* Public CDN with aggressive caching (30s TTL). If status changes â†’ push update via WebSocket to open browsers AND trigger CDN cache invalidation. CDN ensures high availability of status page even if your servers are down.

**Scenario 2:** Your Node.js API calls an external credit scoring API (charges .05 per call) to display credit risk scores. Normal traffic: 10,000 API calls per hour at /hr. How do you use caching to reduce costs by 90% without significantly impacting data freshness?

*Credit scores change rarely* (updated by bureaus monthly/quarterly). Cache per user: credit_score:{userId} â†’ score + timestamp. TTL = 24 hours (credit score won't change in 24 hours for 99.9% of users). Result: 10,000 unique users = 10,000 calls on first lookup. Next 24 hours = 0 calls for repeat visits. If a user is viewed 5Ã— per day = 5 calls reduced to 1. In practice, most users are viewed multiple times. 90% reduction achievable with 24-hour TTL. Cost: /hr â†’ /hr. Cache invalidation: manual trigger for users who report score update (verified via secondary channel).

