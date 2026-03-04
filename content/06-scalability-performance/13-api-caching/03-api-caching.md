# API Caching — Part 3 of 3

### Topic: AWS Certification Focus, Comparison Tables, Quick Revision & Architect Exercise

**Series:** Scalability & Performance → Topic 13

---

## SECTION 9 — Certification Focus (AWS SAA)

### Calibrating Cache Duration to Data Change Frequency

```
THE CORE QUESTION: "How often does this data change? How bad is serving stale data?"

  Fast-changing + high staleness cost → short TTL or no cache.
  Slow-changing + low staleness cost → long TTL.

TTL REFERENCE TABLE:

  API CATEGORY              EXAMPLE                TTL (CDN)  TTL (Redis)  NOTES
  ──────────────────────────────────────────────────────────────────────────────────────────────
  Static site config        /config/features.json  1h         6h           Near-immutable
  Legal/Terms               /api/terms             24h        24h          Changes are planned. Invalidate on deploy.
  Product catalog           /api/products/{id}     5min       10min        Changes via admin. Invalidate on update.
  Product search results    /api/products?q=laptop 1min       2min         New products added frequently
  Product inventory         /api/inventory/{id}    15s        30s          Changes during shopping. Short TTL.
  Product pricing           /api/pricing/{id}      30s        1min         Flash sales, promotions
  User profile (public)     /api/users/{id}/public 1min       5min         Display name, avatar. Changes infrequent.
  User profile (private)    /api/me                CDN:no     60s          Private. Redis only. no-CDN.
  Order history             /api/orders            CDN:no     2min         User-specific. private cache only.
  Currency exchange rates   /api/fx                1min       60s          Financial: re-fetch every minute.
  Weather by city           /api/weather?city=NYC  5min       5min         1 key per city. Rate-limit friendly.
  Geocoding                 /api/geocode?addr=...  7 days     7 days       Addresses don't change after lookup.
  News articles             /api/articles/{id}     10min      30min        Published content, rarely edited.
  News feed (live)          /api/feed              30s        60s          Changes as new articles publish.
  Real-time stock prices    /api/stocks/{sym}      CDN:no     15s          Display only. Not for trading.
  Sports scores (live)      /api/scores/{gameId}   CDN:no     10s          Active game: very short. Final: 24h.
  Social post (past 24h)    /api/posts/{id}        1min       5min         Active engagement. Likes/comments change.
  Social post (archived)    /api/posts/{id}        30min      2h           Old posts. Less engagement.

DYNAMIC TTL BASED ON CONTENT AGE:

  Post published today: TTL = 60 seconds (active engagement window).
  Post published last week: TTL = 10 minutes.
  Post published last year: TTL = 2 hours.

  Implementation:
    const ageInDays = (Date.now() - post.createdAt) / 86400000;
    let ttl;
    if (ageInDays < 1)  ttl = 60;        // 1 min
    else if (ageInDays < 7)  ttl = 600;  // 10 min
    else ttl = 7200;                      // 2 hours

    await redis.setex(key, ttl, JSON.stringify(post));

CACHE WARMING PATTERNS:

  Avoid cold cache on deploy or TTL reset storm.

  LAZY WARMING (default): TTL expires → next request fills → thundering herd risk.
  Fix with jitter + mutex pattern.

  ACTIVE WARMING: before TTL expires, proactively refresh.
  Background job: runs every TTL/2 minutes. Refreshes popular API responses.

  SEEDED WARMING on deploy:
    New deploy → ALL keys expire (due to cache key version bump).
    Pre-warm: before routing traffic to new deploy, run warm-up script.
    Script calls top-N most popular API responses → fills Redis.
    Then: flip load balancer. Traffic hits warm cache.
```

---

## SECTION 10 — Comparison Table

### CloudFront, API Gateway, and ElastiCache for API Caching

```
AWS API GATEWAY RESPONSE CACHING:

  Available for: REST APIs on API Gateway.
  NOT available for: HTTP APIs (newer, faster, but no built-in cache).

  Configuration:
    Stage-level: enable cache for entire stage (dev, prod).
    Method-level: override per HTTP method + resource.
    TTL: 0 to 3600 seconds (default 300s if not set).
    Cache capacity: 0.5GB to 237GB per stage (billed hourly).

  Cache key components:
    Default: path + query params (all params included).
    Custom: select which query params and headers to include in the key.
    Per-method: fine-grained control.

  Example CLI setup:
    aws apigateway update-stage \
      --rest-api-id abc123 \
      --stage-name prod \
      --patch-operations \
        op=replace,path=/cacheClusterEnabled,value=true \
        op=replace,path=/cacheClusterSize,value=1.6 \
        op=replace,path=/*/*/caching/ttlInSeconds,value=300

  WHEN TO USE API GATEWAY CACHE:
    APIs behind API Gateway that can't be CDN-cached (require IAM auth, API keys).
    APIs with complex auth logic where bypass-cache logic at CloudFront is impractical.
    Simple TTL-based memoization without app code changes.

  COST NOTE: API Gateway cache: $0.02–$0.04 per GB-hour. For large caches: costs add up.
              ElastiCache: usually more cost-effective at scale.

CLOUDFRONT FOR API CACHING:

  CloudFront as CDN in front of public APIs.

  Distribution setup:
    Origin: your API Gateway, ALB, or EC2.
    Behaviors: per URL path pattern.

  BEHAVIOR CONFIGURATION — Public API:
    Path pattern: /api/v1/products/* (static product data)
    Allowed methods: GET, HEAD.
    Cache policy: TTL min=60, default=300, max=3600.
    Query string policy: forward all, normalize order.

  BEHAVIOR CONFIGURATION — Private API:
    Path pattern: /api/v1/me* (user-specific)
    Cache policy: TTL = 0 (no cache).
    Forward headers: Authorization.

  CACHE INVALIDATION:
    aws cloudfront create-invalidation \
      --distribution-id E1234567890 \
      --paths "/api/v1/products/99" "/api/v1/products/99/*"

    On product update in your backend: trigger Lambda → CloudFront invalidation.
    EventBridge rule: on "product.updated" event → Lambda → createInvalidation.

  ORIGIN SHIELD: CloudFront adds an intermediate caching tier between edges and origin.
    Reduces origin hit count by consolidating cache misses through one region.
    Useful for: origins with limited bandwidth, expensive DB queries.
    Cost: $0.0075 per 10,000 origin requests → amortized over many edge nodes.

ELASTICACHE FOR APPLICATION-LEVEL API CACHING:

  Redis for backend logic caching — the last mile before DB.

  RECOMMENDED CONFIGURATION for API caching:
    maxmemory-policy: allkeys-lru (evict LRU when full).
    maxmemory: 70% of available node RAM (leave headroom).
    Eviction: set CloudWatch alarm on evictions > 0 for 5 min.

  CLUSTER ARCHITECTURE:
    Separate Redis instances for:
    - Application cache (this topic, allkeys-lru).
    - Session storage (volatile-lru, different eviction policy).
    - Rate limiting (allkeys-lru, small, very high QPS).

    Reason: different maxmemory-policy per workload. Can't mix on same node without
    all keys sharing the same eviction policy. Separate nodes = separate policies.

  COST COMPARISON:
    ElastiCache cache.r7g.large (6.4GB): ~$0.17/hr = ~$124/month.
    API Gateway cache (1.6GB): ~$0.02/GB-hr = ~$23/month for 1.6GB.
    At 5GB+: ElastiCache cheaper AND more functional (Redis data types, no API Gateway limitation).
```

---

## SECTION 11 — Quick Revision

**Scenario:** Your company uses a third-party weather API with a rate limit of 1,000 requests/day (strict hard limit). You have a weather widget embedded on 50,000 web pages. Users load these pages 5 million times per day. Each weather request includes: user's city, user's unit preference (C or F). Design a multi-layer caching solution that stays under the 1,000/day API limit while serving accurate weather to 5M daily users.

---

**Answer:**

```
ANALYSIS:
  5,000,000 requests/day from users.
  1,000 external API calls allowed/day.
  Cache efficiency needed: 99.98%+ overall (external call rate = 1000/5000000 = 0.02%).

  Key insight: "city" determines weather. "Unit preference" (C/F) is a CLIENT-SIDE conversion.
  Cache by city. Convert on the way out. Don't cache per city+unit (doubles cache misses).

LAYER 1: EXTERNAL API CALL GOVERNANCE

  One Redis key per city: weather:ext:v1:{citySlug}
  TTL: 15 minutes (weather data is meaningfully stale after 15 min).
  Per 24 hours: 24h × 60min ÷ 15min = 96 maximum calls per city.
  Budget: 1000 calls/day ÷ 96 calls/city/day = ~10 cities fully covered.
  But: if same cities repeat (NYC, London, LA = 80% of traffic) — far fewer external calls needed.

  CIRCUIT BREAKER on external API:
    If external API fails: serve stale weather (even expired cache) for up to 2 hours.
    Users prefer "slightly old weather" to error page.
    stale-if-error pattern via Redis: keep expired key with PERSIST until background refresh.

LAYER 2: REDIS CACHE (APPLICATION LAYER)

  Key: weather:ext:v1:{citySlug}
  Value:
    {
      "tempC": 22,             // always store in Celsius
      "condition": "sunny",
      "humidity": 55,
      "cachedAt": 1720000000,
      "validUntil": 1720000900  // cachedAt + 900 (15 min)
    }
  TTL: 900 seconds (15 minutes).

  Cache Aside logic:
    1. Check Redis for city.
    2. Hit: return cached weather. Convert C→F if user preference = F.
    3. Miss: Lock (SETNX, 10s TTL). Call external API. Store. Release lock.

  Unit conversion (C→F): done in application code after cache retrieval.
  NEVER cache per (city + unit). That doubles key space and halves hit rates.
  Store always in Celsius. Convert at response time. Conversion: trivial computation.

  Expected hit rate at Redis layer:
  200 unique cities × ~25,000 users/city/day = 5M total.
  Each city: cache populated once per 15 min.
  Redis calls per city per day: 24h × 4 calls/h = 96 cache misses per city.
  200 cities × 96 = 19,200 Redis misses — but ONLY 1 external API call per miss group.
  External calls: 200 cities × 96 populates (if all cities checked every 15 min) = 19,200.
  But rate limit is 1,000/day. CONFLICT.

  SOLUTION: Rate limit enforcement BEFORE external call.
  Only explicitly refresh cities on-demand. Use a BUDGET COUNTER.

  Key: weather:apiBudget:v1:{YYYYMMDD} → INCR on each external call.
  EXPIRE at next midnight.

  On cache miss:
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const budgetKey = `weather:apiBudget:v1:${today}`;
    const usedCalls = await redis.incr(budgetKey);
    await redis.expireat(budgetKey, nextMidnightUnix());

    if (usedCalls > 980) {  // reserve 20 calls as emergency buffer
      // Budget exhausted: return stale weather or "unavailable" gracefully
      const stale = await redis.get(`weather:ext:v1:${citySlug}`);  // may be expired
      return stale ? {...JSON.parse(stale), isStale: true} : null;
    }

    // Budget available: call external API
    const freshWeather = await externalWeatherApi.get(citySlug);
    await redis.setex(`weather:ext:v1:${citySlug}`, 900, JSON.stringify(freshWeather));
    return freshWeather;

LAYER 3: CDN CACHING (PUBLIC API RESPONSE)

  Weather widget: client makes request to YOUR API: GET /api/weather?city=NYC
  Your API: fetches from Redis.
  Response: Cache-Control: public, max-age=300, s-maxage=900 (15 min CDN).

  CDN key: /api/weather?city=NYC (city is normalized: lowercase, slug format).

  For 5M users in 200 cities:
  CDN hit rate: most requests to /api/weather?city=NYC → CDN hit (same response for all NYC users for 15 min).
  CDN effectively reduces Redis reads by 80%+.

  What users see if CDN caches "22°C"? All NYC users see 22°C for up to 15 min.
  This is fine for a weather widget. Not for flight departure status.

LAYER 4: BROWSER CACHE (SHORT TTL)

  Cache-Control: public, max-age=120 (2 min browser cache).
  User refreshes page: same city, browser serves cached response. Zero network.
  After 2 min: re-fetches (goes to CDN, likely still cached).

UNIT CONVERSION (C → F):

  Client-side: JavaScript widget converts C to F based on user's stored preference.
  OR: server-side on response: temp = (unit === 'F') ? (tempC * 9/5) + 32 : tempC.

  NOT cached per unit. NEVER split cache by unit preference.

RESULT:
  5M user requests/day.
  CDN absorbs: ~4.5M (90% of identical city requests via CDN).
  Redis serves: ~500K (10% CDN misses → Redis).
  Redis misses → budget check: at most 1000 external API calls/day.

  External API budget: under control. Users served with >99.98% cache hit rate.
```

---

## SECTION 12 — Architect Thinking Exercise

**Q: "What is Cache-Control: no-cache vs no-store?"**

> "Confusingly named. no-cache does NOT mean don't cache — it means 'cache this, but always check with the server before using it.' The client sends a conditional request (If-None-Match or If-Modified-Since). Server returns 304 Not Modified if nothing changed — so you save bandwidth. But there's always a round-trip to verify. Use no-cache for content that should be up-to-date but can benefit from bandwidth savings when unchanged.
>
> no-store means 'do not cache anywhere, ever.' Not in the browser, not in a CDN, not in a proxy. Used for genuinely sensitive data: OTP codes, payment confirmation pages, medical records.
>
> So: no-cache = cache + validate. no-store = don't cache at all."

---

**Q: "How would you prevent cache poisoning in a CDN?"**

> "Three lines of defense. First: validate and sanitize all server-side output — never reflect unvalidated input in API responses. A cache poisoning attack relies on getting malicious data into the response body; if your code sanitizes inputs, there's nothing to inject. Second: distinguish clearly between public and private responses. Any user-specific response must carry Cache-Control: private — CDN should be configured to skip caching when the Authorization header is present. Third: for content injection via Host header: normalize the Host header on ingress (only allow whitelisted values) and never use the Host header to construct response URLs without validation. Combined, these eliminate the primary vectors."

---

## === Architect's Mental Model ===

### 5 Decision Rules

**Rule 1: Cache as close to the user as possible, using as many cache layers as the data's privacy allows.**
Public data (product catalog, weather): CDN → all requests absorbed at the edge. Private data (user orders): never CDN, only Redis with per-user key. The rule is layered: start from the outermost layer (browser, CDN) and work inward. Each layer that can serve the response without involving the next layer is a win for both latency and cost.

**Rule 2: Cache the data transformation, not just the raw data.**
If an API returns product data including a complex JOIN across 3 tables with price calculations and inventory status: cache the final computed result, not individual DB tables. The cached response should be the exact JSON the client receives. Reconstructing it from cached primitives often negates the performance gains. "Compute once, serve many" — the cache should hold the expensive output, not cheap parts.

**Rule 3: Private vs public has security implications, not just performance ones.**
Failing to set Cache-Control: private on user-specific responses is not a performance bug — it's a security vulnerability. User data cached in a CDN can be served to different users. This category of bug causes data breaches. Make private vs public classification explicit and mandatory in code review for any endpoint that accesses user-specific data. Add a lint rule or middleware that enforces Cache-Control: private when the response contains userId-scoped data.

**Rule 4: For external APIs with rate limits: budget enforcement is a first-class feature.**
Rate limits on external APIs are hard constraints — exceeding them causes service degradation or billing spikes. Treat the daily budget as a Redis counter. Enforce it before making external calls. Design around the budget: cache longer (15 min instead of 5 min per call). Precompute and warm caches for predictable traffic (weather at midnight, currency at market open). Never assume "we probably won't hit the limit" — that assumption fails during traffic spikes.

**Rule 5: Normalize cache keys before storing, not just before looking up.**
Client A: sorts query params as `a=1&b=2`. Client B: sends `b=2&a=1`. Both map to the same content. If cache key is built from raw URL, they miss each other. Implement normalization consistently: sort query params alphabetically, strip irrelevant tracking params, lowercase city/country names, canonicalize locale formats. Apply normalization at every cache layer (CDN configuration, application middleware, Redis key builder). Different normalization at different layers = cache fragmentation and harder debugging.

---

### 3 Common Mistakes

**Mistake 1: Caching per user+preference combination instead of entity+converting on output.**
Weather cached per city+unit, products cached per user+currency — these inflate cache key space unnecessarily and destroy hit rates. Store in one canonical format (Celsius, USD, base locale). Convert for the requesting client at output time. The conversion is trivial computation. The cache hit rate improvement is fundamental.

**Mistake 2: Not configuring CDN to bypass cache for authenticated requests by default.**
The safe default: CDN should NOT cache any request with an Authorization header unless explicitly configured to do so for a specific endpoint pattern. Many CDN configurations default to caching ALL responses. Developers add caching for public endpoints but forget to explicitly exempt authenticated endpoints. The result: user-specific data cached at CDN, served cross-user. Make the policy explicit: CDN caches nothing with Authorization header by default. Explicitly opt endpoints IN to CDN caching with Cache-Control: public, s-maxage=N.

**Mistake 3: Treating cache invalidation as an afterthought.**
Teams design caching first (great TTL, good hit rate), then encounter the hard part: "how do we update cached data when the database changes?" Cache invalidation is harder than the caching itself. Design the invalidation strategy alongside the caching strategy. For every cached entity, define: what events cause the cache to be invalid? Who publishes those events? What keys need to be DEL'd or updated? CloudFront invalidation, Redis DEL, event-driven invalidation via DynamoDB Streams — all require upfront design, not retrofitting.

---

### 30-Second Interview Answer

> "API caching is about multiple layers — browser, CDN, API gateway, and Redis — each reducing load on the next. HTTP Cache-Control headers control what the browser and CDN can cache and for how long: public and s-maxage for CDN-cacheable data, private and no-store for sensitive user data. Redis handles application-level caching for private data, expensive computations, and external API responses. The core design decisions are: which layer is appropriate for which data based on its privacy and change frequency, how to build cache keys that uniquely identify a response without over-partitioning, and what the invalidation strategy is when data changes. The most common mistake is designing caching in isolation from invalidation, or forgetting to mark user-specific responses as private and accidentally caching them in CDN."

---

_End of Topic 13 — API Caching_
