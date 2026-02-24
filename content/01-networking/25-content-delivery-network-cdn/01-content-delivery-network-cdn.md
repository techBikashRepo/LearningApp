# Content Delivery Network (CDN) — Part 1 of 3

### Topic: CDN Architecture, Cache Hierarchy, and CloudFront Deep Dive

**Series:** Networking Fundamentals → System Design → AWS Solutions Architect
**Sections Covered:** 1, 2, 3, 4

---

## SECTION 1 — ELI12: The Simple Story

### What is a CDN?

Imagine a popular bakery in New York City. Their chocolate croissants are famous worldwide. Without a CDN, if someone in Tokyo wants a chocolate croissant, they must fly to New York, buy it, and fly back. That's 14+ hours — just for a croissant!

A smart bakery sets up **satellite branches** in Tokyo, London, Paris, and Sydney. They teach each branch how to make the exact same croissant recipe. Now Tokyo residents walk 5 minutes to the local branch. Same croissant. Fraction of the time.

**CDN = the bakery branch network for the internet.**

Your website's files (HTML, CSS, JavaScript, images, videos) are stored on servers in one place (your origin — like the New York bakery). A CDN copies these files to hundreds of servers around the world (edge servers — the local branches). When users try to access your site, they get the files from the nearest edge server, not from your faraway origin.

### The Key Insight: CDN Serves Copies, Not the Original

```
WITHOUT CDN:
  Tokyo User → ─────── 14,000 km ──────── New York Server
                         150ms RTT
                         Slow, expensive, congested

WITH CDN:
  Tokyo User → ─── 50 km ─── CDN Edge in Tokyo
                    3ms RTT
                    Fast, cheap, local

HOW the CDN has the file:
  1. First user in Tokyo requests: /logo.png
  2. CDN Tokyo edge: "I don't have this! Let me get it."
  3. CDN Tokyo fetches /logo.png from New York origin: 150ms (once)
  4. CDN Tokyo stores (caches) the copy
  5. All subsequent Tokyo users: get the copy instantly from CDN (3ms)
```

### Why Not Just Copy to All Branches Proactively?

For a large website with millions of files, copying everything proactively would be wasteful — some files might never be requested in Tokyo. CDN uses **pull caching** (lazy loading): copy files to each edge server only when the first user at that location requests them. Popular content gets cached everywhere fast; obscure content might only be cached in a few locations.

### Two ELI12 Analogies

**Analogy 1 — School Library System**
Your school has 1,000 students but the main library is downtown, 2 hours away. The school sets up mini-libraries in every classroom with copies of the most popular books. Students borrow books from the classroom shelf in seconds. If a student wants an obscure book not in the classroom shelf, the teacher sends to the main library and adds a copy to the shelf for the future.

**CDN:** classroom shelf = edge cache. Main library = origin server. Sending to downtown = cache miss → origin fetch.

**Analogy 2 — Netflix's DVD-by-Mail Era**
Netflix used to mail DVDs from one warehouse. Long movie = long wait. They fixed it by opening 100 local distribution centers across the USA. Your DVD ships from the nearest center in your city. Same movie, but arrives next day instead of 5 days. CDN is the internet equivalent of those local distribution centers.

---

## SECTION 2 — Core Technical Deep Dive

### CDN Architecture Layers

```
Three-tier CDN architecture:

┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  TIER 1: Edge PoPs (Points of Presence)                        │
│  ─────────────────────────────────────                         │
│  Location: 450+ cities globally (CloudFront)                   │
│  Purpose: Serve requests with lowest latency (< 10ms)          │
│  Storage: SSD, typically 1-20 TB per PoP                       │
│  Cache hit rate: typically 60-90% for static content           │
│                                                                 │
│  TIER 2: Regional Edge Caches (CloudFront specific)            │
│  ────────────────────────────────────────────────              │
│  Location: 12 cities globally (larger than PoPs)               │
│  Purpose: Cache objects not in Edge PoP; absorb cache misses   │
│  Storage: tens of TB per location                              │
│  Benefit: many edge PoP misses resolved here without touching origin │
│                                                                 │
│  TIER 3: Origin (Your Server)                                  │
│  ────────────────────────────                                  │
│  Location: your data center or AWS region                      │
│  Purpose: source of truth; only queried on full cache miss     │
│  Traffic: ideally 5-10% of all requests (90-95% CDN served)   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

Request flow for a user in Frankfurt:
  1. User requests: GET /app.js
  2. DNS resolves to nearest CloudFront PoP IP (Frankfurt PoP)
  3. Frankfurt PoP cache lookup:
     HIT → serve immediately (3ms)
     MISS → go to step 4
  4. Frankfurt PoP queries Regional Edge Cache (eu-central-1 REC):
     HIT → REC serves to Frankfurt PoP → cached there → served to user (~15ms)
     MISS → go to step 5
  5. Regional EC queries origin (us-east-1):
     Origin responds (80ms) → REC caches → Frankfurt PoP caches → user served (~100ms)
  6. Next Frankfurt user: HIT at step 3 (3ms)
```

### Cache-Control Headers: The Language of CDN Caching

```
You control what CDN caches using HTTP headers:

header: Cache-Control — most important

max-age=N:        Cache for N seconds (from both browser and CDN)
s-maxage=N:       Cache for N seconds at CDN only (browser ignores this)
no-cache:         Must revalidate with origin before serving cached response (ETag check)
no-store:         Never cache this response (not in CDN, not in browser)
public:           Can be cached by CDN (default for GET 200 responses)
private:          Only browser can cache; CDN must NOT cache
immutable:        Browser: never revalidate (the URL will change if content changes)
stale-while-revalidate=N: Serve stale cache while fetching fresh in background

Examples:
  Static app bundle (content-hashed filenames like app.a8f3b2.js):
    Cache-Control: public, max-age=31536000, immutable
    → CDN caches for 1 year, never revalidates
    → When app changes: new filename (app.c9d4e3.js) → cache misses to new file

  HTML page (changes frequently):
    Cache-Control: no-cache, public, max-age=0
    → CDN can cache but must validate with ETag before serving
    → ETag matches? → 304 Not Modified (fast, no resend of body)

  User profile page (private):
    Cache-Control: private, max-age=300
    → Browser caches for 5 minutes; CDN does NOT cache

  News article (somewhat static):
    Cache-Control: public, max-age=60, stale-while-revalidate=3600
    → CDN serves from cache for 60s
    → After 60s: serve stale version IMMEDIATELY, fetch fresh in background
    → User never waits; max staleness = 1 hour

  Product API (often read):
    Cache-Control: public, s-maxage=30
    → CDN caches for 30s → 30s stale at most
    → Browser: uncacheable (no browser max-age) → browser always goes to CDN
```

### CDN Cache Keys and Variations

```
Cache key: the unique identifier for a cached object.
Default cache key: URL path + query string (exact match)

Problem: same URL, different users need different content:
  GET /api/products → different content for logged-in vs anonymous
  GET /products?id=5 → same for everyone ← cacheable
  GET /profile → different per user ← not cacheable without user-key

Cache key configuration:
  Include headers in cache key:
    Accept-Language: de → cache separate German and English versions
    Accept-Encoding: gzip → cache separate compressed versions

  Include cookies in cache key:
    session_id → every user gets own cache entry (defeats CDN purpose!)
    ab_testing_group → separate A and B versions (ok, only 2 versions)

  CloudFront Cache Policy — controls cache key:
    Headers: list specific headers to include
    Cookies: whitelist only cookies needed for variation
    Query strings: include all, none, or specific list

  Vary header (server tells CDN what varies):
    Vary: Accept-Encoding → CDN stores separate copies per encoding
    Vary: Accept-Language → CDN stores per language
    Vary: Cookie → CDN stores per cookie value (BAD: defeats caching for private data)
    Vary: * → CDN cannot cache this at all

Origin Shield (CloudFront):
  Optional middle tier between ALL edge PoPs and your origin
  All cache misses from all PoPs → go to ONE origin Shield location
  Origin Shield then queries your origin (one location, one connection pool)

  Benefit: reduces origin request count by ~90%+ for global traffic
  Example: video with 100 edge PoPs getting a miss → without Shield: 100 origin requests
           With Shield: 1 origin request from Shield, Shield fills all PoPs
  Cost: adds ~20ms for Shield→PoP hop on cache miss
```

### CloudFront Distributions and Behaviors

```
CloudFront Distribution = your CDN configuration

Distribution settings:
  Origins: one or more backend servers (S3, ALB, EC2, custom HTTP endpoint)
  CNAMEs: your domain (shop.com → points to distribution via CNAME)
  SSL cert: ACM cert for your domain

  Example distribution: shop.com

  Behaviors (routing rules within a distribution):
    Path pattern: /api/*
      → Origin: ALB (dynamic content, API calls)
      → Cache policy: CachingDisabled (no caching for API)

    Path pattern: /images/*
      → Origin: S3 bucket
      → Cache policy: CachingOptimized (max-age=86400, compress)

    Path pattern: * (default)
      → Origin: ALB (dynamic pages)
      → Cache policy: CachingDisabled or short TTL

  Request routing: CloudFront matches MOST SPECIFIC pattern first:
    /images/logo.png → matches /images/* → goes to S3
    /api/users → matches /api/* → goes to ALB
    /checkout → matches * (default) → goes to ALB

Geo-restriction:
  Allow list: only these countries can access this distribution
  Block list: block specific countries
  Use case: comply with regional content licenses

  How: CloudFront checks client IP → MaxMind geo-database → allow/block
  403 Forbidden returned for blocked countries
```

---

## SECTION 3 — ASCII Diagram

```
                    CDN ARCHITECTURE OVERVIEW
                    ══════════════════════════

┌─────────────────────────────────────────────────────────────────────┐
│                    THREE TIER CDN HIERARCHY                         │
│                                                                     │
│   User (Frankfurt)                                                  │
│        │                    ┌──────────────────────────────────┐   │
│        ▼                    │    TIER 1: Edge PoPs             │   │
│   ┌─────────┐               │    (450+ cities worldwide)       │   │
│   │Frankfurt│◄──CACHE HIT──►│    Frankfurt PoP     [SSD 5TB]  │   │
│   │  USER   │  (3ms, ~80%)  │    London PoP        [SSD 5TB]  │   │
│   └─────────┘               │    Paris PoP         [SSD 5TB]  │   │
│        │                    │    Mumbai PoP        [SSD 5TB]  │   │
│        │ CACHE MISS (~20%)  └─────────────────────┬────────────┘  │
│        │                                          │               │
│        │                    ┌─────────────────────▼────────────┐  │
│        │                    │    TIER 2: Regional Edge Cache   │  │
│        │                    │    (12 locations worldwide)      │  │
│        │                    │    eu-central-1 [HDD 100TB]     │  │
│        │◄──CACHE HIT────────│    us-east-1 REC [HDD 100TB]   │  │
│        │   (20ms, ~15%)     │    ap-southeast-1 REC...        │  │
│        │                    └─────────────────────┬────────────┘  │
│        │                                          │               │
│        │                    ┌─────────────────────▼────────────┐  │
│        │                    │    TIER 3: Origin                │  │
│        │                    │    Your server in us-east-1      │  │
│        │◄──FROM ORIGIN──────│    S3 bucket, ALB, EC2, API GW   │  │
│        │   (120ms, ~5%)     │    Only ~5% of requests reach   │  │
│        │                    │    here (CDN absorbs 95%)        │  │
│                             └──────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                CACHE-CONTROL HEADER CHEAT SHEET                     │
│                                                                     │
│  Content Type        │ Header                     │ CDN Behavior   │
│  ───────────────────────────────────────────────────────────────── │
│  App bundle (hashed) │ max-age=31536000,immutable  │ 1 year, no    │
│  e.g. app.a8f3b2.js  │                             │ revalidation  │
│                      │                             │               │
│  HTML page           │ no-cache, public, max-age=0 │ Cache + ETag  │
│                      │                             │ check always  │
│                      │                             │               │
│  User data           │ private, max-age=300        │ NO CDN cache  │
│                      │                             │               │
│  News article        │ max-age=60,                 │ Serve stale,  │
│                      │ stale-while-revalidate=3600 │ refresh async │
│                      │                             │               │
│  Real-time API       │ no-store                    │ Never cached  │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│            CACHE HIT RATE IMPACT ON COSTS AND LATENCY               │
│                                                                     │
│  100,000 requests/day for a 1 MB image served to global users:      │
│                                                                     │
│  0% cache hit (no CDN):                                             │
│    100,000 × 1 MB = 100 GB/day from origin                          │
│    Cost: $0.09/GB × 100 GB = $9/day from origin bandwidth           │
│    Average latency: 150ms (origin in us-east-1)                     │
│                                                                     │
│  95% cache hit (good CDN):                                          │
│    5,000 origin requests × 1 MB = 5 GB/day from origin              │
│    Cost: $0.09/GB × 5 GB = $0.45/day + CloudFront: ~$0.80/day      │
│    Total: $1.25/day (vs $9/day) = 86% cost reduction                │
│    Average latency: (95% × 5ms) + (5% × 150ms) = 12.25ms avg       │
│    vs 150ms = 12× faster                                            │
└─────────────────────────────────────────────────────────────────────┘
```

---

## SECTION 4 — Step-by-Step Flow

### Scenario 1 — Setting Up CloudFront for a React App

```
Goal: Deploy a React SPA to S3 + CloudFront, globally fast

Step 1: Build React app with content hashing
  npm run build
  → Creates: dist/assets/index.a8f3b2.js, dist/assets/main.c9d4e3.css
  Content hash in filename: file content changes = new name = cache busted automatically

Step 2: Upload to S3
  aws s3 sync dist/ s3://my-spa-bucket/ --delete
  S3 bucket: NOT a public website, private bucket (CloudFront will access it)

Step 3: Create CloudFront distribution
  Origin: S3 bucket with OAC (Origin Access Control) — only CloudFront can read S3
  Default root object: index.html (SPA: all routes return index.html)

  Custom error pages (for SPA routing):
    Error code: 403 → Response: index.html, HTTP status: 200
    Error code: 404 → Response: index.html, HTTP status: 200
    (React Router handles the route client-side; S3 only has index.html)

Step 4: Configure cache behaviors
  Default behavior (/*):
    Cache Policy: CachingOptimized (auto gzip/brotli, 86400s default TTL)
    BUT: index.html should have short cache or no-cache

  Per-file Cache-Control (set on S3 metadata):
    index.html: Cache-Control: no-cache, public (CDN caches but revalidates via ETag)
    *.js, *.css (hashed): Cache-Control: max-age=31536000, immutable (1 year)
    *.webp, *.avif (hashed): Cache-Control: max-age=31536000, immutable

Step 5: Deploy
  aws cloudfront create-invalidation --distribution-id ABCD1234 --paths "/index.html"
  Only invalidate index.html (assets auto-bust via hash in filename)

Result:
  User in Tokyo requests https://shop.com:
    DNS → CloudFront Tokyo PoP (registered ACM cert in us-east-1 or ap-northeast-1)
    CloudFront serves from nearest PoP cache
    index.html: ETag check → if unchanged, 304 (tiny response, fast)
    app.a8f3b2.js: served from edge cache (1 year TTL, no revalidation needed)
```

### Scenario 2 — CDN Cache Invalidation Strategy

```
Problem: You deployed a bug fix. Users still see the old version.
The cached app.a8f3b2.js has the bug. New bundle is app.cc3411.js.

If no content hashing (bad practice):
  Old: /static/app.js (cached by CDN for 1 year)
  New: /static/app.js (same URL! CDN still serves old version for 1 year)
  Fix: manual CloudFront invalidation (costs money, takes 1-5 minutes to propagate globally)

  CloudFront invalidation cost: first 1,000 paths/month free; then $0.005/path
  Long TTL + manual invalidation = unreliable, costly deployment process

With content hashing (best practice):
  Old: /static/app.a8f3b2.js (CDN caches with 1-year TTL) — stays cached forever
  New: /static/app.cc3411.js (new URL = new cache miss, pulls from origin immediately)
  index.html updated: references new /static/app.cc3411.js

  Process:
    Deploy new build to S3 (new files added, old files stay for users mid-session)
    Invalidate /index.html only → CDN fetches new index.html immediately → references new JS
    Old JS files: harmless, sit in CDN until TTL expires (1 year) or nobody requests them

    No downtime: old JS still cached for browser reload
    New users: fetch new index.html → new JS URL → new JS fetched
    Ongoing users: their browser has old JS cached until page reload

CloudFront Invalidation API:
  aws cloudfront create-invalidation \
    --distribution-id EXXXXXX \
    --paths "/index.html" "/api/products/*"

  Wildcard: "/api/products/*" invalidates all products paths at once
  Price: free for first 1,000 paths/month
  Time: typically 1-5 minutes globally (not instant)
  Alternative: versioned paths (/v2/api/products) → no invalidation needed
```

### Scenario 3 — CDN for a REST API

```
Pattern: API caching at CloudFront for high-read endpoints

Scenario: product catalog API, 100,000 req/hour, 1% actually change

Without CDN:
  100,000 requests/hour → all hit Lambda + DynamoDB
  Cost: 100,000 Lambda invocations × $0.0000002 + DynamoDB reads
  Latency: avg 50ms (Lambda warm + DynamoDB)

With CloudFront API caching:
  Cache-Control: public, s-maxage=60, stale-while-revalidate=300

  First request in 60s window: cache miss → Lambda + DynamoDB (50ms)
  Next 99 requests in same 60s: cache hit at CloudFront edge (5ms)

  Cache hit rate: ~99% for stable catalog data
  Lambda invocations: 100,000 → 1,000 per hour (99% reduction)
  Cost: drops ~99% for Lambda + DynamoDB reads
  Average latency: 99% × 5ms + 1% × 50ms = 5.45ms (vs 50ms before)

Configuration on CloudFront:
  Behavior: /api/products/*
    Cache Policy: custom
      TTL: min=0, default=60, max=300
      Cache key: Method + URL path + query params (no cookies, no auth header)
      Compression: enabled

    IMPORTANT: do NOT include Authorization header in cache key for public data
    (all users get same product list → safe to serve cached version to all)

  What NOT to cache at CDN:
    /api/cart/* (user-specific)
    /api/orders/* (user-specific, must be fresh)
    /api/auth/* (security, must not be cached)

  For these: Cache-Control: private, no-store → CloudFront passes through to origin

CloudFront + API Gateway:
  API Gateway has its own stage cache ($0.02/hour for cache)
  CloudFront in front of API Gateway: adds edge caching (closer to users)
  Stack: User → CloudFront (edge, global) → API Gateway (regional cache) → Lambda
  Two-tier cache: if CF misses, API GW cache may hit → cheaper than Lambda invoke
```

---

## File Summary

This file covered:

- Bakery branch network + school library + Netflix DVD analogies for CDN
- CDN serves copies (edge cache), not the original (origin) — pull caching on first request per location
- Three-tier CDN: Edge PoPs (450+ cities) → Regional Edge Cache (12 cities) → Origin
- Detailed cache flow: Frankfurt user → Frankfurt PoP (80% hit, 3ms) → EU Regional Cache (15% hit, 20ms) → Origin (5% miss, 120ms)
- Cache-Control headers guide: max-age, s-maxage, no-cache, no-store, private, immutable, stale-while-revalidate
- Cache keys: default = URL; customizable with headers, cookies, query strings; Vary header
- Origin Shield: optional middle tier, reduces origin requests by ~90% for global traffic
- CloudFront distributions: origins, behaviors (path patterns route to different origins), geo-restriction
- React SPA deployment: content hashing eliminates manual invalidation, OAC for S3, custom error pages
- Invalidation strategy: content-hashed filenames + invalidate only index.html = zero-downtime deploys
- CDN for REST API: 60s TTL on public catalog → 99% cache hit → 99% Lambda cost reduction + 10× faster

**Continue to File 02** for real-world examples, system design patterns, AWS mapping, and 8 interview Q&As.
