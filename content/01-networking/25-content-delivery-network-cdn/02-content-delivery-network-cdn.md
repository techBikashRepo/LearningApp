# Content Delivery Network (CDN) — Part 2 of 3

### Topic: Real-World Examples, System Design Patterns, AWS Mapping, Interview Q&As

**Series:** Networking Fundamentals → System Design → AWS Solutions Architect
**Sections Covered:** 5, 6, 7, 8

---

## SECTION 5 — Real World Examples

### Analogy 1 — Amazon Fulfillment Centers

Amazon's fulfillment center network IS a physical CDN:

- **Origin**: Amazon's main purchasing/inventory systems (the "source of truth")
- **Warehouse (DC)**: Fulfillment center closest to you. Stores popular items in your area.
- **Same-day delivery**: Amazon predicts what you (and people like you) will order, pre-positions items in the local warehouse BEFORE you order
- **Prime Now**: Items stored in lockers literally 2 miles from you

The analogy:

- **Edge cache**: your local fulfillment center
- **Regional cache**: the sorting center your local center pulls from
- **Origin**: the central Amazon DC where unique/slow items ship from
- **Cache prefill**: Amazon's predictive algorithm stocking popular items locally
- **Cache TTL**: how long an item stays in the local warehouse before being shuffled out
- **Cache eviction**: seasonal items returned to central DC when popular season ends

**The big CDN lesson from Amazon:** Proximity wins. Amazon spends billions on warehouses close to customers because the last 50 miles are both the most expensive and most time-sensitive. CDN does the same for bytes.

### Analogy 2 — Radio Broadcasting Repeater Towers

A radio station broadcasts from one transmitter. The signal reaches maybe 100 miles. To cover an entire continent: they don't build one massive transmitter — they set up hundreds of repeater towers.

Each repeater receives the signal and re-broadcasts it locally. Users near each repeater get a strong, clear signal. The original broadcast station doesn't need 10,000 watts to reach everyone — it just needs enough power to reach the nearest repeater.

**CDN:** radio station = origin. Repeater towers = edge PoPs. Listeners = end users. Signal quality = latency. Dead zones (no signal) = geographic gaps in CDN coverage.

**CDN design insight**: You don't need a massive origin server that can handle every user in the world. Your origin needs to handle only cache misses (~5-10% of traffic). The CDN carries the load for everyone else.

### Real Software Example — Stack Overflow's CDN Strategy

Stack Overflow handled 500+ million pageviews per month with a tiny engineering team (9 engineers at peak) by AGGRESSIVELY caching via CDN:

```
Stack Overflow's CDN architecture:
  CDN provider: Fastly (similar concepts to CloudFront)
  Origin: 9 servers in New York

  Strategy: "Make CDN do 80% of the work"

  CDN caching rules:
    /questions/12345 (public question page):
      Cache-Control: public, max-age=2592000 (30 days)
      Surrogate-Control: max-age=2592000 (CDN-specific extended TTL)
      → CDN caches questions for 30 days
      → Origin sees < 0.1% of question views

    Instant invalidation (CDN's API):
      When question is edited → API call to Fastly → purge that question URL
      CDN invalidates within 150ms globally
      Next request: cache miss → fresh from origin → cached again

    Search results (/search?q=python):
      Cache-Control: private (user-specific search history)
      NOT cached at CDN
      But: most search hits are popular enough that result content is popular pages

    JavaScript/CSS/Images:
      Content-hashed filenames: infinite TTL
      app.{hash}.js → max-age=31536000, immutable

  Real impact:
    9 servers handle 500M monthly pageviews
    Without CDN: would need hundreds of servers + global data centers
    With CDN: 80-95% of requests served from CDN edge

  Stack Overflow surrogateKey (tag-based invalidation):
    Every response tagged: "question:12345 user:67890 tag:python"
    When user 67890 edits their profile: purge all pages tagged "user:67890"
    → Entire CDN cache for that user's content invalidated in one API call

  This is "cache tagging" — advanced CDN feature (Fastly and CloudFront support similar)
```

---

## SECTION 6 — System Design Importance

### 1. CDN Cache Hit Ratio Optimization

```
Cache hit ratio = (CDN hits) / (total requests) × 100%
Target: > 80% for static content; > 60% for semi-dynamic

Why cache hit ratio might be low:

Problem 1: Too many unique URLs (low cacheability)
  Bad:  /api/products?user=123&session=abc456&timestamp=1678901234
        (unique per user+session+time → 0% cache hit)
  Good: /api/products?category=5&page=1
        (same URL for all users browsing category 5 page 1 → 95% cache hit)

Problem 2: Cookies in cache key (user personalization defeating caching)
  If Cookie header is in cache key:
    User A: Cookie: session=abc → separate cached version
    User B: Cookie: session=xyz → separate cached version
    10,000 users = 10,000 unique cache entries = 0% reuse

  Fix: strip session cookies from cache key (use them on the ORIGIN)
  CloudFront Cache Policy: don't forward cookies to CDN for public content
  Separate public → /public/products vs private /api/my-cart

Problem 3: TTL too short
  30-second TTL: only 30 seconds of reuse per edge PoP
  1,000 users/minute hitting the same edge:
    Without CDN: 1,000 origin hits/minute
    With 30s TTL: 2 origin hits/minute (much better, but still)
    With 5-minute TTL: 1 origin hit per 5 min per PoP (near-optimal)

  Increase TTL for content that doesn't change often
  Use stale-while-revalidate for content that can tolerate brief staleness

Problem 4: Geographic spread (no PoP in user's region)
  CDN coverage gaps → users fall back to origin with full latency
  Solution: choose CDN provider with PoPs in your users' regions
  CloudFront: 450+ PoPs globally (comprehensive coverage)

Cache hit ratio targets:
  > 90%: Excellent. Most traffic served from edge. (hashed assets, long-lived content)
  70-90%: Good. Some dynamic content missing.
  50-70%: Okay. Investigate TTL settings and URL uniqueness.
  < 50%: Poor. CDN not providing its value. Audit cache keys and TTLs.
```

### 2. CDN as a Security Layer

```
CDN sits between the internet and your origin — natural security position:

DDoS protection:
  CloudFront + AWS Shield Standard (free):
    Protects against network-level (L3/L4): SYN floods, UDP reflection, volumetric
    CloudFront absorbs attack traffic at edge (not reaching origin)
    Edge capacity: tens of Tbps → absorbs most volumetric DDoS

  CloudFront + AWS Shield Advanced ($3,000/month):
    L7 DDoS protection (HTTP floods: 1M requests/sec hitting your app)
    DRT (DDoS Response Team): 24/7 support during attacks
    Cost protection: AWS credits attack-related scale-out costs

WAF (Web Application Firewall) at CDN:
  CloudFront + AWS WAF:
    Rules evaluate EVERY request at the EDGE before hitting origin
    Built-in rule groups: OWASP Top 10, Bot Control, IP reputation lists
    Custom rules: block specific IPs, rate limit per IP, block malicious patterns

  Rate limiting at CDN edge:
    Rule: more than 100 req/5min from single IP → Block
    Impact: bots and scrapers blocked at edge, never touch origin

Bot management:
  CloudFront + WAF Bot Control:
    Identifies bots by browser signature, TLS fingerprint, JavaScript challenges
    Verified bots (Googlebot): allow
    Malicious bots (scrapers, credential stuffers): block or challenge (CAPTCHA)

Hot content protection (bandwidth theft):
  Signed URLs: time-limited, user-specific URLs for premium content
    URL params: Key-Pair-Id, Expires, Signature (CloudFront signed URL)
    User A's signed URL: expires in 1 hour, anyone else loading that URL gets 403
    Use case: video streaming, paid downloads, private S3 content

  Signed Cookies: for users browsing multiple pages of protected content
    Set a signed cookie once at login
    All subsequent CDN requests authenticated by cookie
    Use case: subscription video site — all premium videos accessible with one cookie
```

### 3. CDN for Video Streaming (Adaptive Bitrate)

```
Video streaming is CDN's most demanding use case:

Video is chunked into small segments:
  Master playlist: video.m3u8
  720p playlist: 720p/video.m3u8 → segments: 720p/seg001.ts, 720p/seg002.ts...
  1080p playlist: 1080p/video.m3u8 → segments: 1080p/seg001.ts, ...
  4K playlist: 4k/video.m3u8 → segments: 4k/seg001.ts, ...

  Protocol: HLS (HTTP Live Streaming) — each segment is a standard HTTP GET

CDN for video:
  Playlist files (*.m3u8): Short cache TTL (5-10s) — player polls for new segments
    Cache-Control: max-age=6, s-maxage=6

  Segment files (*.ts, *.m4s): Long TTL — they never change once created
    Cache-Control: max-age=86400, immutable

  CloudFront handles video streaming:
    Player (Tokyo) → CloudFront Tokyo PoP → (cache miss) → Origin S3 → cached at edge
    Next 10,000 viewers in Tokyo: same edge cache → no origin hit

Adaptive Bitrate (ABR) streaming:
  Player measures throughput every 2-10 seconds
  If measured throughput > bitrate needed: switch UP quality (buffering unlikely)
  If measured throughput < bitrate needed: switch DOWN quality (prevent buffering)

  CDN enables ABR: each resolution is cached separately at edge
  Player switches from 720p/seg050.ts to 1080p/seg051.ts mid-video seamlessly
  Both cached at edge PoP → switch latency < 1ms

Origin capacity for popular events (Super Bowl, Olympics):
  Without CDN: 50 million simultaneous viewers → 50 million connections to origin
  With CDN: 50 million viewers → ~50 origin connections (one per edge PoP filling cache)
  CDN effectively multiplies origin capacity by 1 million ×
```

### 4. CDN and CORS Interaction

```
Critical gotcha: CDN caches CORS headers

Problem setup:
  GET /api/products → Cache-Control: max-age=300
  Request from https://shop.com → Origin sends: Access-Control-Allow-Origin: https://shop.com
  CDN caches the response WITH that CORS header

  Next request from https://admin.shop.com:
  CDN returns cached response with: Access-Control-Allow-Origin: https://shop.com
  Browser rejects: "ACAO does not match requesting origin admin.shop.com"

Root cause: CDN served one origin's CORS response to a different origin

Fix: Add Vary: Origin header to CORS responses
  Vary: Origin tells CDN: "Cache separate versions per Origin header value"

  shop.com request: CDN caches with key (URL + Origin:shop.com) → ACAO: shop.com
  admin.shop.com request: cache miss (different Origin header) → origin served with ACAO:admin.shop.com
  Next admin.shop.com: CDN returns cached ACAO:admin.shop.com → correct!

CloudFront specific:
  CloudFront Cache Policy: include Origin header in cache key
    → Solves the Vary:Origin problem natively in CloudFront config
    → Don't need to set Vary:Origin manually on origin if using CloudFront Cache Policies
```

---

## SECTION 7 — AWS Mapping

### CloudFront Deep Dive

```
CloudFront distribution types:
  Web distribution: HTTP/HTTPS (what you always want for web apps)
  No longer: RTMP distributions (Flash streaming, deprecated 2020)

CloudFront Origins:
  S3 bucket: static files, SPA, static websites
    OAI (legacy) or OAC (current): restricts S3 to only CloudFront access
    S3 bucket: private → only CloudFront can read → users can't directly access S3 URL

  ALB: dynamic applications, APIs, WebSocket (ALB must be HTTPS or HTTP)
  EC2: direct to instances (not recommended; use ALB instead for high availability)
  API Gateway: REST or HTTP APIs
  Custom origin: any HTTP endpoint (on-premises, another cloud, etc.)
  Origin Group: primary + failover origin (if primary fails, CloudFront auto-fails over)

CloudFront Edge Functions:
  CloudFront Functions:
    Runtime: JavaScript (ES5.1)
    Execution: viewer request and viewer response events only
    Latency: < 1ms (extremely fast, runs at ALL 450+ PoPs)
    Use cases: URL rewrites/redirects, header manipulation, basic auth check, A/B testing
    Cost: $0.10 per 1 million invocations
    Limits: max 2ms execution, 10KB memory, no network calls

  Lambda@Edge:
    Runtime: Node.js, Python
    Execution: all 4 events (viewer request/response, origin request/response)
    Latency: 5-100ms (runs at 13 regional edge locations, not all PoPs)
    Use cases: complex auth, device detection, image resizing, dynamic content
    Cost: Lambda pricing ($0.60 per 1M + $0.00000625/GB-sec)
    Limits: 5-30 second timeout, up to 1GB memory, CAN make network calls

  Choosing between them:
    Simple header/URL manipulation: CloudFront Functions (faster, cheaper)
    Complex logic, API calls, database lookups: Lambda@Edge
    Real-time personalization at edge: Lambda@Edge (but adds latency)
```

### CloudFront Monitoring and Logs

```
CloudFront Standard Logs (access logs):
  Written to S3 (chosen by you, not real-time, 1-5 min delay)
  Fields: date, time, x-edge-location, bytes, method, host, uri, status,
          x-edge-result-type (Hit/Miss/RefreshHit/Error), time-taken, ssl-protocol...

  Athena query example (find cache hit rate per day):
    SELECT date,
      SUM(CASE WHEN x_edge_result_type = 'Hit' THEN 1 ELSE 0 END) as hits,
      COUNT(*) as total,
      ROUND(100.0 * SUM(CASE WHEN x_edge_result_type='Hit' THEN 1 ELSE 0 END) / COUNT(*), 2) as hit_rate
    FROM cloudfront_logs
    GROUP BY date ORDER BY date;

CloudFront Real-Time Logs:
  Streams to Kinesis Data Streams in real-time (< 5s latency)
  Use: real-time dashboards, live alerting on cache hit rate drop
  More expensive than standard logs

CloudFront metrics (CloudWatch):
  Requests: total request count
  BytesDownloaded: data served to clients
  BytesUploaded: POST/PUT bytes received
  4xxErrorRate: client errors (404, 403)
  5xxErrorRate: origin errors (502, 503, 504)
  CacheHitRate: % of requests served from cache
  OriginLatency: time to first byte from origin (only on cache misses)
  TimeToFirstByte: end-to-end (hit: very fast; miss: origin latency)

  Alarms to set:
    5xxErrorRate > 1%: origin is failing, investigate
    CacheHitRate < 50%: CDN effectiveness degraded, check TTL/cache keys
    OriginLatency p99 > 500ms: origin is slow on misses
```

### CloudFront Pricing

```
Pricing model: pay for what users download from CDN, not from origin

CloudFront data transfer OUT (per GB):
  First 10 TB/month: $0.085/GB
  Next 40 TB:        $0.080/GB
  Next 100 TB:       $0.060/GB
  Scales down with volume

CloudFront HTTPS requests:
  $0.0100 per 10,000 requests (GET/HEAD)
  $0.0100 per 10,000 requests (POST/PUT)

Price class (reduces cost by limiting edge PoP regions):
  Price Class All: all 450+ PoPs globally ($$$)
  Price Class 200: excludes most expensive PoPs (South America, Australia, India partial)
  Price Class 100: US, Canada, Europe only (cheapest, but slow for Asia/Oceania users)

Free tier:
  1 TB data transfer out/month
  10 million HTTP/HTTPS requests/month
  Excellent for dev/testing

CloudFront vs S3 direct pricing:
  S3 data transfer out: $0.09/GB
  CloudFront data transfer out: $0.085/GB (cheaper!)
  + S3 to CloudFront: free (if same region)
  = CloudFront is cheaper than serving S3 directly for high-volume use cases

Origin Shield pricing add-on:
  $0.008–$0.010 per 10,000 requests (incremental cost for Shield benefit)
  Break-even: worth it if origin cost per request > Shield cost per request
```

---

## SECTION 8 — Interview Q&As

### Beginner Questions

**Q1: What is a CDN and why would you use one?**

A: A CDN (Content Delivery Network) is a geographically distributed network of servers that cache and serve content from locations close to end users. Instead of all traffic going to one origin server, CDN edge servers in hundreds of cities serve cached copies.

You'd use a CDN to:

1. **Reduce latency**: serve files from 5ms away (local PoP) vs 200ms away (origin). Images, JS, CSS load near-instantly globally.
2. **Reduce origin load**: CDN absorbs 90-95% of traffic. Your origin handles only cache misses. A server that struggled with 10,000 req/s becomes comfortable with 500 req/s.
3. **Reduce bandwidth costs**: CDN data transfer is cheaper than direct server data transfer at scale. S3 to CloudFront is free within AWS.
4. **Improve availability**: CDN can serve cached content even if origin is temporarily down. Edge servers absorb DDoS attacks that would overwhelm a single origin.
5. **SSL termination at edge**: CDN handles HTTPS, presents certificate from nearest PoP, faster TLS handshake for users.

**Q2: What happens when someone requests a file that isn't in the CDN cache?**

A: A cache miss triggers the following flow:

1. User requests: `GET /images/logo.png`
2. DNS resolves to nearest CDN edge PoP
3. Edge PoP checks cache: **MISS** (file not found or TTL expired)
4. Edge PoP may check Regional Edge Cache: if present, served from there (~15-20ms) and cached at PoP
5. If still miss: Edge PoP makes a GET request to your origin server (us-east-1: ~120ms)
6. Origin sends the file with appropriate Cache-Control headers
7. Edge PoP stores the file in its cache with TTL from Cache-Control headers
8. Edge PoP responds to original user with the file (with `X-Cache: Miss` header)
9. **All subsequent requests** from that PoP's region: cache HIT (served in <10ms)

The first user to request an uncached file "pays" the origin latency. Every subsequent user benefits from that cached copy. This is called "warming the cache" and is why cache hit rate increases over time after deployment.

**Q3: What is the difference between Cache-Control: no-cache and no-store?**

A: Both prevent long-term caching, but differently:

**no-cache**: "You MAY store a copy, but you must validate it with the origin before serving." The CDN/browser stores the cached response. On next request, it sends a conditional request (`If-None-Match: "abc123"` if the response had an ETag). If origin says "not changed" (304 Not Modified), serve the cached copy. If changed, return fresh content.

Effect: Slightly stale content never served. But saves re-downloading if content hasn't changed (304 response has no body — just headers, much faster).

**no-store**: "You must NOT store this response anywhere." Nothing cached. Every request goes to origin fresh. Server always returns full response.

Use cases:

- `no-cache`: HTML pages that change often but might not change every request (efficient with ETags)
- `no-store`: Sensitive data (bank account balances, prescriptions, real-time stock prices, API responses with private user data)

In practice for secure content: `Cache-Control: private, no-store` — explicitly says: don't store anywhere (especially CDN/proxies).

---

### Intermediate Questions

**Q4: Your CDN cache hit rate is 30%. What are the likely causes and how do you investigate?**

A: 30% is poor — 70% of requests still reaching origin. Systematic investigation:

**Step 1: Check what content types are requested**

```bash
# CloudFront access log analysis (Athena):
SELECT uri, x_edge_result_type, COUNT(*) as count
FROM cf_logs
GROUP BY uri, x_edge_result_type
ORDER BY count DESC LIMIT 50;
```

**Likely causes:**

1. **Too many unique/non-cacheable URLs**: are API endpoints included in CDN? `/api/sessions`, `/api/user-profile` — user-specific, can't cache. Check what % of requests are cacheable vs non-cacheable paths. Solution: separate cacheable and non-cacheable paths; disable caching for non-cacheable routes explicitly.

2. **TTL too short**: is everything set to `Cache-Control: no-cache` or `max-age=5`? Review per-content-type TTLs. Solution: set appropriate TTLs — 1 year for hashed assets, 5 minutes for semi-dynamic, 0/no-store for truly private.

3. **Session/user cookies in cache key**: if Authorization or session cookie is part of cache key → every unique user+session = separate cache entry → near-0% reuse. Solution: don't include session cookies in CDN cache key; separate public from authenticated endpoints.

4. **Geographic traffic spread too thin**: if first user in a PoP covers 1/1000 of PoP's capacity, that PoP's cache is cold for every new user. Very low traffic globally → CDN evicts objects before next user arrives. Solution: for very low-traffic global sites, consider Price Class 100 (fewer PoPs, more traffic concentrated per PoP → higher hit rate per PoP).

5. **Cache invalidation too aggressive**: are you invalidating the entire cache on every deployment? Solution: use content hashing, only invalidate what actually changed.

**Q5: Explain how you would serve a personalized home page through CDN efficiently.**

A: The challenge: personalized = unique per user, CDN loves identical content. Strategies to bridge this:

**Strategy 1: Cache the "shell" + lazy load personalization**

```html
<!-- Cached at CDN: public, max-age=300 -->
<html>
  <head>
    <!-- CSS, meta -->
  </head>
  <body>
    <div id="shell"><!-- Static public layout --></div>
    <div id="personalized" data-user-id="">
      <!-- Initially empty -- -->
    </div>
    <script>
      // Loads after shell: one API call for personalized data
      fetch("/api/me/home-data") // This is NOT cached (private)
        .then((data) => renderPersonalized(data));
    </script>
  </body>
</html>
```

Shell is cacheable globally. Only one API call per user for personalization (not cached at CDN, served directly from origin). Result: 5ms for shell load + 50ms for API call = 55ms. Without CDN: 150ms for full page + 150ms for API = 300ms.

**Strategy 2: Edge Lambda for lightweight personalization**
Lambda@Edge at Viewer Request: reads cookie, adds `X-User-Segment: premium` header. Origin (or origin CloudFront Function) adds user-segment-specific content (without full user data). Cache keyed on `X-User-Segment` — only 3-5 variants (free, premium, enterprise) → 3-5 cached versions per URL instead of millions.

**Strategy 3: stale-while-revalidate for "good enough" freshness**
For non-sensitive personalization (recently viewed items list, recommendations): `Cache-Control: private, max-age=30, stale-while-revalidate=60`. Browser caches for 30s, serves stale for 60s while refreshing. User accepts slightly stale recommendations. Reduces API calls by 3-4×.

**Q6: What is CloudFront Origin Shield and when should you use it?**

A: Origin Shield is an optional additional caching layer between CloudFront's edge PoPs and your origin.

Normally: 450 edge PoPs can each send cache misses to your origin independently. For a popular video that's cold-cached, 100 different PoPs might all request the same video segment from your origin within seconds (thundering herd on cache miss).

With Origin Shield: all edge PoP cache misses funnel through ONE regional Origin Shield location. Shield maintains its own cache. Origin sees one request per unique uncached object — not one per PoP.

**When to use it:**

1. High-value origin capacity: your origin has limited bandwidth or expensive compute
2. Video origin (large files, cold starts common): Shield dramatically reduces origin hits
3. Paid API with per-request charges: reduce origin API calls with Shield's cache layer
4. Global traffic hitting same content: 450 PoPs → 1 origin request instead of 450 per cache miss

**Trade-offs:**

- Additional cost: ~$0.008-$0.010 per 10K incremental requests through Shield
- Additional latency: +20-30ms on cache misses (Shield→origin hop extra)
- Worth it when: origin compute/bandwidth cost saved > Shield cost

---

### Advanced System Design Questions

**Q7: Design a CDN caching strategy for a news website that publishes 1,000 articles/day, with a mix of breaking news (update every 5 minutes) and archived articles (never change after 24h).**

A: Two-tier caching strategy:

```
Breaking news (< 24 hours old):
  URL structure: /breaking/article-{id}
  Cache-Control: public, s-maxage=60, stale-while-revalidate=300

  Behavior:
    CDN serves from cache for 60 seconds (fresh enough for news)
    After 60s: stale-while-revalidate → serve stale immediately, refresh in background
    Stale-while-revalidate window: 300s → user never waits for freshness check
    Max staleness: 60 + 300 = 360 seconds = 6 minutes (acceptable for news)

  Invalidation: if BREAKING news (major event): CloudFront invalidation API
    aws cloudfront create-invalidation --paths "/breaking/article-{id}"
    Propagates globally in 1-5 minutes
    Use sparingly: only for factual corrections on major stories

Archive articles (> 24 hours old):
  URL structure: /archive/2024/01/15/article-{id}
  Cache-Control: public, max-age=31536000, immutable
  (Articles don't change after 24h; treat as immutable)

  Cache hit rate: ~99% (no invalidation ever needed for archive)

Homepage / article index pages:
  Cache-Control: public, s-maxage=30, stale-while-revalidate=60
  (Homepage always fresh within 90 seconds, user never waits)

  Tag-based invalidation (if CDN supports it):
    Tag: "section:technology" on all technology articles
    When new tech article published → purge tag → all tech index pages refreshed

Ads (dynamic, revenue-sensitive):
  DO NOT cache ad content (<div class="ad-slot"> populated by client-side JS)
  Ad pixels and tracking: Cache-Control: no-store

Performance results:
  Archive articles: 99% cache hit (virtually no origin traffic for old content)
  Breaking news: 90% cache hit (60s window shared across thousands of PoP users)
  Homepage: 85% cache hit (30s window, many users load homepage per 30s)
  Overall: ~93% cache hit rate → origin handles 7% of traffic
```

**Q8: Your CloudFront distribution is returning stale content even after you ran an invalidation. Troubleshoot this.**

A: Stale-after-invalidation is a class of issues with multiple causes:

**Investigation checklist:**

1. **Browser cache, not CDN cache**: invalidation clears CDN, not the user's browser. Browser may have cached response for `max-age=3600`. User needs hard refresh (Ctrl+F5/Cmd+Shift+R) or clear cache.
   - Diagnosis: Check response headers — `X-Cache: Hit from cloudfront` = CDN cache. `Age: 1245` = how many seconds ago the response was cached
   - Fix: Set appropriate browser TTL via `max-age`; use content hashing to force new URL on change

2. **Invalidation propagation delay**: CloudFront invalidation typically 1-5 minutes globally. If user requests within that window: may get stale.
   - Diagnosis: Check invalidation status in CloudFront console — "In Progress" = not complete
   - Fix: Wait 5 minutes; or use versioned paths (`/v2/api/products`) to bypass invalidation entirely

3. **stale-while-revalidate serving stale during refresh**: `stale-while-revalidate=3600` means CDN will serve stale content for up to 1 hour after TTL expires (including after invalidation might have cleared fresh content).
   - Diagnosis: Response header `Stale: true` or check CDN logs for `RefreshHit` result type
   - Fix: Don't use stale-while-revalidate for content that needs immediate invalidation clarity

4. **Origin Shield serving stale**: If Origin Shield is enabled, Shield's cache must also be cleared. CloudFront invalidation propagates through Shield, but it takes time.
   - Diagnosis: Test from region WITHOUT Origin Shield path → if fresh, Shield is serving stale
   - Fix: Invalidation path must include Shield → CloudFront handles this automatically but takes longer

5. **Multiple CloudFront distributions with overlapping paths**: rare but possible in complex setups.
   - Diagnosis: check which distribution your domain resolves to; check CNAME chains

6. **Cache key includes query parameter**: you invalidated `/product` but requests come in as `/product?variant=red`. Cache keys differ.
   - Diagnosis: invalidation pattern must match exact cache key path (including query string if in key)
   - Fix: `/product*` wildcard invalidation covers `/product` and `/product?variant=*`

---

## File Summary

This file covered:

- Amazon fulfillment center and radio repeater analogies for CDN architecture and scale
- Stack Overflow: 9 engineers + 500M pageviews via aggressive CDN caching + tag-based invalidation
- Cache hit ratio optimization: unique URLs, cookies in cache key, TTL settings, geographic spread
- CDN as security layer: Shield Standard/Advanced DDoS, WAF at edge, bot management, signed URLs/cookies
- Video streaming: HLS segments, adaptive bitrate, CDN makes 50M viewer events sustainable at origin
- CORS + CDN: Vary: Origin critical to prevent serving wrong CORS headers to different origins
- CloudFront edge functions: CloudFront Functions (<1ms, URL/header manipulation) vs Lambda@Edge (complex logic, network calls)
- CloudFront monitoring: access logs + Athena queries, real-time logs → Kinesis, CloudWatch cache hit rate alarms
- CloudFront pricing: $0.085/GB out, cheaper than S3 direct; Price Classes; Origin Shield cost/benefit
- 8 Q&As: CDN definition, cache miss flow, no-cache vs no-store, 30% hit rate diagnosis, personalized home page strategies, Origin Shield, news site caching strategy, stale-after-invalidation troubleshooting

**Continue to File 03** for AWS SAA exam traps, 5 comparison tables, Quick Revision mnemonics, and Architect Exercise.
