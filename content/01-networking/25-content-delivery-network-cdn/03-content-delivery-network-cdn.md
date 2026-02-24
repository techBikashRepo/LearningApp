# Content Delivery Network (CDN) — Part 3 of 3

### Topic: AWS SAA Exam Prep, Comparison Tables, Quick Revision, Architect Exercise

**Series:** Networking Fundamentals → System Design → AWS Solutions Architect
**Sections Covered:** 9, 10, 11, 12

---

## SECTION 9 — AWS SAA Certification Focus

### Core CloudFront Exam Knowledge

CloudFront is heavily tested on AWS SAA. Know these patterns cold:

**What CloudFront IS and IS NOT:**

```
CloudFront IS:
  ✅ A CDN (cache layer in front of origins)
  ✅ HTTPS termination at edge (SSL/TLS offloading)
  ✅ DDoS protection (AWS Shield Standard included free)
  ✅ WAF integration point (Lambda@Edge or CloudFront WAF)
  ✅ Origin for static content: S3
  ✅ Origin for dynamic content: ALB, API Gateway, custom HTTP endpoint
  ✅ Geographic restriction (country-based block/allow)
  ✅ Signed URLs / Signed Cookies (access control for private content)

CloudFront is NOT:
  ❌ A load balancer (that's ALB/NLB/CLB)
  ❌ A DNS service (that's Route 53)
  ❌ A firewall per se (WAF is, CloudFront is proxy/cache)
  ❌ A compute platform (Lambda@Edge is, but CloudFront itself is not)
  ❌ A message queue or event bus
```

### AWS SAA Exam Traps — CDN

**Trap 1: OAI vs OAC (Origin Access Identity vs Origin Access Control)**

```
OAI (Origin Access Identity) — LEGACY (exam may still test):
  Creates a special CloudFront identity
  S3 bucket policy grants read to OAI
  CloudFront signs requests with OAI identity
  Limitation: doesn't work with SSE-KMS if key is in different account

OAC (Origin Access Control) — CURRENT (preferred):
  Newer, more secure than OAI
  Uses IAM-signed SigV4 requests to S3
  Supports SSE-KMS (can decrypt S3 content encrypted with KMS)
  Supports S3 Object Lambda (transforming objects on the fly)
  Supports all S3 regions including opt-in regions

EXAM QUESTION: "Customer wants CloudFront in front of S3 with KMS-encrypted objects.
                 What do you configure?"
ANSWER: CloudFront with OAC (not OAI — OAI doesn't support SSE-KMS access)

Bucket policy for OAC:
{
  "Principal": {
    "Service": "cloudfront.amazonaws.com"
  },
  "Condition": {
    "StringEquals": {
      "AWS:SourceArn": "arn:aws:cloudfront::123456789:distribution/EDFDVBD6EXAMPLE"
    }
  }
}
```

**Trap 2: CloudFront 403 Forbidden Troubleshooting**

```
Scenario: CloudFront returns 403 for S3-hosted content

Possible causes (check in order):
  1. Bucket policy doesn't allow CloudFront (OAI/OAC not configured correctly)
     Fix: Update bucket policy to allow cloudfront.amazonaws.com

  2. S3 Block Public Access is ON + no OAC:
     If you're trying to serve S3 publicly without OAC: Block Public Access rejects it
     Fix: Either use OAC (recommended) or turn off Block Public Access (not recommended)

  3. Object doesn't exist in S3: S3 returns 403 (to obscure bucket enumeration), not 404
     Fix: verify object key (case-sensitive!), check S3 copy was successful

  4. CloudFront Geo-restriction blocking the requester's country
     Fix: Check CloudFront distribution geo-restriction settings

  5. Signed URL/Cookie required but not provided:
     Fix: Generate valid signed URL with non-expired timestamp and correct key pair

  6. WAF or Lambda@Edge blocking the request (custom rule match)
     Fix: Check WAF logs and Lambda@Edge function logs in CloudWatch

EXAM TRAP: "User gets 403 when accessing CloudFront → S3. What is the FIRST thing to check?"
ANSWER: The bucket policy / OAC configuration (most common cause)
```

**Trap 3: Signed URL vs Signed Cookies**

```
Signed URL:
  One URL grants access to ONE specific file
  URL contains expiry + signature
  Use for: one-off downloads, one video, PDF, image
  Limitation: user must use exact signed URL; can't be shared (tied to file path)

  Format: https://d1234.cloudfront.net/video.mp4
           ?Expires=1679500000
           &Signature=ABCD1234...
           &Key-Pair-Id=APKA...

Signed Cookies:
  One cookie set grants access to MULTIPLE files matching a path pattern
  Use for: subscription video (user can watch all /premium-videos/*)
           software download (all files in /download/$version/*)

  Flow:
    1. User authenticates at backend
    2. Backend sets 3 cookies:
       CloudFront-Policy: base64(JSON policy)
       CloudFront-Signature: HMAC(policy, private key)
       CloudFront-Key-Pair-Id: public key ID
    3. User's browser sends cookies with every CloudFront request
    4. CloudFront validates cookies → allows access to all files in policy path

EXAM QUESTION: "Users pay for a subscription to access all videos in /premium/*.
                 How do you enforce access?"
ANSWER: Signed Cookies (not Signed URLs; Signed Cookies cover the entire /premium/* path)

EXAM QUESTION: "User should only be able to download one specific report: report_2024.pdf.
                 How do you enforce access?"
ANSWER: Signed URL (single file access)
```

**Trap 4: CloudFront Functions vs Lambda@Edge Edge Case Traps**

```
CloudFront Functions:
  Triggers: Viewer Request, Viewer Response ONLY
  Cannot: access origin request/response
  Cannot: make network calls (no HTTP requests, no DynamoDB, no Redis)
  Cannot: use Node.js (ES5.1 JavaScript only, no npm packages normally)
  Runs at: ALL edge PoPs (450+)

Lambda@Edge:
  Triggers: Viewer Request, Viewer Response, Origin Request, Origin Response
  CAN: make network calls (but adds latency)
  CAN: use full Node.js or Python with packages
  Runs at: REGIONAL edge locations (13 globally, not all PoPs)
  MUST be deployed in us-east-1 region (even if serving global traffic)

EXAM TRAP 1: Lambda@Edge must be created in which region?
  ANSWER: us-east-1 (N. Virginia) — regardless of where users are

EXAM TRAP 2: Customer wants to inspect origin response headers and add custom headers
              before returning to user. Can CloudFront Functions do this?
  ANSWER: No. CloudFront Functions only handle Viewer events. Must use Lambda@Edge
          at "Origin Response" event trigger.

EXAM TRAP 3: Which Lambda@Edge event can modify the cache key?
  ANSWER: Origin Request (between CloudFront and origin, before caching)
          Viewer Request modifications don't affect cache key
```

**Trap 5: CloudFront Cache Policy vs Forward Cookies/Headers (Legacy)**

```
New way (Cache Policies — 2020+):
  Create named Cache Policy (reusable across distributions)
  Specify: which query strings, headers, cookies to include in cache key
  Explicit cache key construction

Legacy way (per-behavior: "Forward Headers: All/None/Whitelist"):
  Old CloudFront UI: set per-behavior which headers to forward and cache on
  Very confusing: "forward" ≠ "include in cache key" in old UI

EXAM: Recent exams use Cache Policies; older question banks reference legacy settings
  If you see "Forward Cookies: None" → equivalent to "don't include cookies in cache key"
  If you see "Cache Policy" → modern configuration method

KEY RULE: If a header/cookie is included in the cache key, it MUST also be forwarded
          to origin (so origin can use it to generate the right response).
```

**Trap 6: CloudFront + API Gateway Endpoint Types**

```
API Gateway endpoint types:
  Regional: single region, no CloudFront built-in, use for SameRegion access or custom CDN
  Edge-Optimized: API Gateway auto-creates CloudFront distribution (managed, no control)
  Private: only accessible within VPC (VPC endpoint required)

CloudFront + API Gateway (explicit setup):
  Use API Gateway Regional type + CloudFront distribution (manual)
  WHY: gives you control over CloudFront settings (cache policy, WAF rules, Functions)

EXAM: "Customer wants global low-latency API with custom cache rules and WAF protection"
ANSWER: API Gateway Regional endpoint + custom CloudFront distribution + AWS WAF
        (not Edge-Optimized which auto-manages CloudFront with limited control)
```

**Trap 7: Route 53 + CloudFront Connection**

```
To use custom domain with CloudFront:
  1. CloudFront SSL certificate: must be in us-east-1 ACM (regardless of CloudFront region)
  2. Add Alternate Domain Name (CNAME) to CloudFront distribution: mydomain.com
  3. Route 53: create Alias record (not CNAME) pointing to CloudFront distribution domain

WHY Alias not CNAME:
  Route 53 Alias: free, works at zone apex (example.com, not just www.example.com)
  CNAME: charged per query, can't be at zone apex (CNAME at root domain is invalid DNS)

Certificate MUST be in us-east-1:
  ACM certificates for CloudFront must be issued in N. Virginia (us-east-1)
  ACM cert in eu-west-1 cannot be attached to CloudFront distribution
  This is a HARD AWS requirement — no workaround except re-issuing in us-east-1

EXAM TRAP: "Customer tries to add ACM certificate to CloudFront but certificate is not
            in dropdown list. What's wrong?"
ANSWER: Certificate was issued in wrong region — must be in us-east-1
```

---

## SECTION 10 — 5 Comparison Tables

### Table 1: CDN Caching by Content Type

| Content Type                           | Cache-Control Header                              | CDN Cached?                | TTL                   | Cache Key Tip                              |
| -------------------------------------- | ------------------------------------------------- | -------------------------- | --------------------- | ------------------------------------------ |
| Hashed static assets (`app.abc123.js`) | `max-age=31536000, immutable`                     | Yes                        | 1 year                | URL only (hash ensures uniqueness)         |
| Non-hashed static assets (`app.js`)    | `max-age=3600`                                    | Yes                        | 1h                    | URL only; set short for active development |
| HTML pages                             | `no-cache, public`                                | Yes (with ETag validation) | Until ETag changes    | Don't include session cookies in key       |
| API: public catalog                    | `public, s-maxage=60`                             | Yes                        | 60s                   | URL + relevant query params only           |
| API: user-specific data                | `private, max-age=30`                             | No                         | 30s (browser only)    | N/A — never reaches CDN                    |
| Images (product photos)                | `public, max-age=86400`                           | Yes                        | 24h                   | URL only                                   |
| Videos (HLS segments `*.ts`)           | `public, max-age=86400, immutable`                | Yes                        | 24h                   | URL only                                   |
| Video playlists (`*.m3u8`)             | `public, max-age=6`                               | Yes                        | 6s                    | URL only                                   |
| News article (breaking)                | `public, s-maxage=60, stale-while-revalidate=300` | Yes                        | 6 min effective       | URL only                                   |
| Real-time prices / auth tokens         | `no-store`                                        | No                         | Never cached anywhere | N/A                                        |

### Table 2: CloudFront Functions vs Lambda@Edge

| Feature              | CloudFront Functions                                                 | Lambda@Edge                                                 |
| -------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------- |
| Execution location   | All 450+ edge PoPs                                                   | 13 regional edge locations                                  |
| Latency              | < 1ms                                                                | 5–100ms                                                     |
| Trigger events       | Viewer Request, Viewer Response                                      | All 4 (+ Origin Request, Origin Response)                   |
| Runtime              | JavaScript (ES5.1)                                                   | Node.js, Python                                             |
| Max execution time   | 1ms                                                                  | 5s (viewer) / 30s (origin)                                  |
| Max memory           | 2MB                                                                  | 128MB–10GB                                                  |
| Network calls        | ❌ Not allowed                                                       | ✅ Allowed                                                  |
| Cost                 | $0.10/1M invocations                                                 | Lambda pricing (~$0.60/1M + compute)                        |
| Package size         | 10KB                                                                 | 50MB (zip)                                                  |
| Can modify cache key | ❌ No (viewer events only)                                           | ✅ Yes (origin request event)                               |
| Deployment region    | Any region                                                           | **Must be us-east-1**                                       |
| Use cases            | URL rewrites, simple header add/remove, basic auth, A/B testing flag | Complex auth, image resizing, dynamic personaliz., DB calls |

### Table 3: Signed URL vs Signed Cookie vs S3 Pre-signed URL

| Feature            | CloudFront Signed URL                       | CloudFront Signed Cookie                      | S3 Pre-signed URL             |
| ------------------ | ------------------------------------------- | --------------------------------------------- | ----------------------------- |
| Scope              | Single file                                 | Multiple files (path pattern)                 | Single S3 object              |
| Mechanism          | Query string params in URL                  | HTTP cookies in browser                       | Query string in direct S3 URL |
| Use case           | One-time download, single video             | Subscription: all content in /premium/\*      | Direct S3 access without CDN  |
| CDN involved       | ✅ Yes                                      | ✅ Yes                                        | ❌ No (bypasses CloudFront)   |
| Expiry control     | ✅ Yes                                      | ✅ Yes                                        | ✅ Yes                        |
| Shareable?         | ⚠️ URL can be shared (bad for paid content) | ✅ Harder to share (requires browser cookies) | ⚠️ URL shareable              |
| Mobile app support | ✅ Easy (add params)                        | ⚠️ Cookie handling required                   | ✅ Easy                       |
| Key pair required  | ✅ CloudFront key pair                      | ✅ CloudFront key pair                        | IAM credentials               |
| Audit control      | CloudFront logs                             | CloudFront logs                               | S3 access logs                |

### Table 4: CDN vs API Gateway Caching vs ElastiCache

| Dimension             | CloudFront CDN                            | API Gateway Cache                           | ElastiCache (Redis)                          |
| --------------------- | ----------------------------------------- | ------------------------------------------- | -------------------------------------------- |
| Location              | Network edge (450+ PoPs)                  | API GW regional PoP                         | In your VPC (app-layer)                      |
| Caches                | Full HTTP response (headers + body)       | Full HTTP response                          | Any value (JSON, string, binary)             |
| TTL granularity       | Per-behavior path pattern                 | Per-resource/method                         | Per-key (programmatic)                       |
| Cache key             | URL + custom headers/cookies/query params | URL + configured headers/query params       | Custom key (your code defines it)            |
| User-specific caching | Limited (cache key per custom header)     | ⚠️ Easy to misconfigure (must exclude auth) | ✅ Full control                              |
| Max object size       | 30 GB                                     | N/A (max 10MB per response typically)       | 512 MB per key (Redis)                       |
| Invalidation          | AWS API / file path pattern               | Flush all (no per-item sadly)               | Individual keys via DEL/EXPIRE               |
| Best for              | Static + semi-dynamic global traffic      | API response caching (1000–1000s rps)       | Session data, computed results, leaderboards |
| Cost model            | Per GB transferred + per 10K requests     | $0.020/GB + instance size                   | Instance hourly (r6g.large ~$0.16/hr)        |

### Table 5: CDN Provider Comparison (AWS Exam Context)

| CDN Provider       | AWS Equivalent? | Key Differentiator                                                        | When exam tests it                      |
| ------------------ | --------------- | ------------------------------------------------------------------------- | --------------------------------------- |
| CloudFront         | ✅ AWS-native   | Deep AWS integration (S3, ALB, API GW, WAF, Shield, ACM)                  | Most CloudFront questions on SAA        |
| Cloudflare         | ❌ Third-party  | Best-in-class DDoS, Workers (V8 isolates, faster than Lambda@Edge)        | Mentioned in comparison; not exam focus |
| Akamai             | ❌ Third-party  | Oldest CDN, enterprise contracts, media streaming leader                  | Not AWS SAA focus                       |
| Fastly             | ❌ Third-party  | Real-time purge APIs, VCL customization, edge compute                     | Not AWS SAA focus                       |
| Global Accelerator | Complementary   | NOT a CDN (no caching); routes TCP/UDP to nearest origin via AWS backbone | SAA tests GA vs CloudFront distinction  |

**CloudFront vs Global Accelerator (most-tested distinction):**

|                            | CloudFront                          | Global Accelerator                                 |
| -------------------------- | ----------------------------------- | -------------------------------------------------- |
| Caches content?            | ✅ Yes                              | ❌ No                                              |
| For static content?        | ✅ Yes                              | N/A                                                |
| For dynamic content?       | Limited                             | ✅ Yes                                             |
| Works with HTTP only?      | ❌ Also TCP/UDP? No                 | ✅ Any TCP/UDP                                     |
| Uses anycast IPs?          | No                                  | ✅ Static anycast IPs                              |
| IP fixed for allowlisting? | ❌ Dynamic IPs                      | ✅ 2 static IPs                                    |
| Use case                   | Static + cacheable content globally | Real-time apps, gaming, IoT, multi-region failover |

---

## SECTION 11 — Quick Revision

### 10 Key Points for Last-Minute Review

1. **CDN serves cached copies from edge PoPs; origin serves only cache misses (~5-10% of traffic)**
2. **Three tiers**: Edge PoP (450+ cities, SSD, <10ms) → Regional Edge Cache (12 cities, HDD, ~20ms) → Origin (anywhere, ~100ms+)
3. **Cache-Control is the CDN instruction manual**: `max-age` = how long; `s-maxage` = CDN-specific TTL; `no-store` = never cache; `immutable` = never revalidate even if expired
4. **Content hashing eliminates cache invalidation**: `app.a8f3b2.js` has unique hash → safe to set 1-year TTL → new deploy = new filename = new URL = never stale
5. **CloudFront Functions** (< 1ms, viewer events only, no network calls) vs **Lambda@Edge** (5-100ms, all events, can call APIs, must deploy from us-east-1)
6. **OAC > OAI**: use OAC for new deployments; OAC supports KMS, S3 Object Lambda, all regions
7. **Signed URLs** = one file at a time; **Signed Cookies** = path pattern (e.g., `/premium/*`)
8. **ACM certificate for CloudFront MUST be in us-east-1** regardless of your origin's region
9. **CloudFront vs Global Accelerator**: CloudFront caches (static/semi-dynamic); Global Accelerator routes TCP/UDP (no caching, real-time/gaming/IoT, static anycast IPs)
10. **Origin Shield** = extra caching tier between all PoPs and origin → 90% reduction in origin requests; adds 20-30ms on miss; worth it for expensive-to-generate content

### 30-Second Explanation

"A CDN is a network of servers worldwide that cache copies of your content close to your users. Instead of every user hitting your origin server across the ocean, they hit a PoP in their city. That PoP either serves from cache in milliseconds, or fetches from your origin once and caches it for the next 10,000 users. In AWS, CloudFront is the CDN — it sits in front of S3, ALBs, and APIs, terminating SSL at the edge, absorbing DDoS attacks, and running serverless functions (CloudFront Functions and Lambda@Edge) right at the edge. The core setup: S3 + OAC + CloudFront = globally-cached, secure, cheap static hosting."

### Mnemonics

**"POEM" — CDN Core Components:**

- **P**oP (Point of Presence — the edge server near users)
- **O**rigin (your actual server — the source of truth)
- **E**dge cache (the storage at the PoP)
- **M**iss/Hit (the two outcomes of every CDN request)

**"HASH = NEVER THRASH":**
Content hashing → never need to cache invalidate → never stale → never angry users. Hash the file, set TTL to infinity.

**"OAC not OAI":**
OAC = New, better, supports KMS. OAI = Old, legacy, avoid for new deployments.

**"CloudFront = Cache, Global Accelerator = Route":**
If the question mentions caching, caching strategy, CDN, static content → CloudFront.
If the question mentions static IP, real-time, non-HTTP, multi-region failover, gaming → Global Accelerator.

**"CF Functions = Viewer-only, Edge-only, No Net":**
CloudFront Functions: only Viewer events, runs at all edges, no network calls allowed.

**"Lambda@Edge = Born in Virginia":**
Must be created in us-east-1 (N. Virginia). Always. Even for global workloads.

**Cache-Control cheat codes:**

- `max-age=31536000, immutable` → "Hashed assets: cache forever"
- `no-cache, public` → "Cache but verify" (HTML)
- `private, no-store` → "Never touch CDN" (user data)
- `s-maxage=60, stale-while-revalidate=300` → "News: cache 60s, refresh in background for 5min"

**"Signed URL = One, Signed Cookie = Many":**
URL for one specific file. Cookie for many files under a path.

---

## SECTION 12 — Architect Thinking Exercise

_Read the problem. Think for 3 minutes before reading the solution._

---

### The Problem

You are the Lead Solutions Architect at **StreamNow**, a video streaming startup.

**Current state:**

- 2,000 paying subscribers, growing 20% month-over-month
- Videos stored in S3 (single bucket, us-east-1)
- Backend: EC2 web server in us-east-1 behind an ALB
- Authentication: JWT token (24h expiry) in Authorization header
- Video access: authenticated GET to backend → backend generates pre-signed S3 URL → client uses pre-signed URL to download video → user downloads raw `.mp4` file (not HLS)
- ALL video requests go through backend for the pre-signed URL step
- NO CDN in use
- Complaints from European and Asian subscribers: 15-40 second load times before video starts
- Server-side cost: 70 EC2 instances, constantly CPU-bound during peak hours
- S3 egress bill last month: $8,400 (1.4 TB transferred)

**New requirements:**

1. Video start time < 3 seconds globally (P95)
2. Support 10,000 concurrent subscribers (projected in 6 months)
3. Reduce infrastructure cost > 50%
4. Premium subscribers: unlimited 4K. Standard subscribers: max 1080p.
5. All video access must be authenticated (no public URLs)
6. GDPR: European user data (watch history, profile) must stay in EU region
7. Must prevent account sharing (max 3 concurrent streams per account)

**Design the new architecture. Specifically address:**
A. Video delivery architecture
B. Authentication/authorization for video access
C. Concurrent stream limit enforcement
D. GDPR compliance for EU data
E. Cost projections

---

### Solution (READ ONLY AFTER THINKING)

---

#### Architecture Overview

```
Global Architecture:

  European User                          Asian User
       |                                      |
  Route 53 (Latency-Based routing)
       |                                 |
  CloudFront Distribution (global edge)
  [CloudFront Functions: JWT validation at edge, stream count check]
       |
  Origin Group:
    Primary: S3 (us-east-1) for most videos
    EU-Mirror: S3 (eu-west-1) for EU-targeted content
  [Origin Shield: us-east-1 for US; eu-west-1 for EU traffic]
       |
  API Backend: ECS Fargate (us-east-1 + eu-west-1)
  [Handles auth, stream slot claiming, metadata queries]
       |
  ElastiCache Redis (multi-region): session + stream slot state
  Aurora Global Database: primary us-east-1, read replica EU
```

#### A. Video Delivery Architecture

**Problem:** Raw `.mp4` + backend pre-signed URL generation = 2 round trips minimum before video starts + no caching.

**Solution:**

1. **Convert to HLS (HTTP Live Streaming)**:

   ```
   Source video → AWS Elemental MediaConvert
     Output: HLS segments (*.ts, 2-second segments)
     Multiple renditions:
       4K (3840×2160): s3://videos/movie-id/4k/playlist.m3u8
       1080p (1920×1080): s3://videos/movie-id/1080p/playlist.m3u8
       720p (1280×720): s3://videos/movie-id/720p/playlist.m3u8
       480p: s3://videos/movie-id/480p/playlist.m3u8
     Master playlist: s3://videos/movie-id/master.m3u8
   ```

2. **CloudFront distribution for video**:

   ```
   Distribution 1: video.streamnow.com
     Origins:
       S3 videos bucket (us-east-1) + OAC
       S3 EU videos bucket (eu-west-1) + OAC [replica of popular EU content]

     Behaviors:
       /*/master.m3u8:
         Cache-Control: max-age=5 (master playlist: changes if we add quality)
         Signed Cookie required: YES

       /*/playlist.m3u8:
         Cache-Control: max-age=5 (segment playlists: updated for live, short TTL for VOD fine)
         Signed Cookie required: YES

       /*.ts (video segments):
         Cache-Control: max-age=86400, immutable
         (Segments never change after creation — infinite cache life)
         Signed Cookie required: YES

     Origin Shield: enabled (eu-west-1 for EU traffic, us-east-1 for all others)
       Prevents origin from seeing 450-PoP miss storm for popular content
   ```

3. **Adaptive Bitrate Switching**: HLS player (hls.js in web, native on iOS/Android) auto-selects quality based on measured connection speed. European user on 20 Mbps connection gets 1080p seamlessly. User on 3 Mbps mobile: starts at 480p, upgrades as connection allows.

#### B. Authentication / Authorization

**Problem:** Backend generates per-request pre-signed URLs = expensive, doesn't scale.

**New flow:**

```
1. User logs in → backend (Fargate) issues:
   a. JWT access token (5-minute lifetime)
   b. JWT refresh token (24h, stored in HttpOnly cookie)
   c. 3 CloudFront Signed Cookies (valid for 4 hours):
      Policy JSON:
        {
          "Statement": [{
            "Resource": "https://video.streamnow.com/*",
            "Condition": {
              "DateLessThan": {"AWS:EpochTime": 1679503200},
              "IpAddress": {"AWS:SourceIp": "0.0.0.0/0"}
            }
          }]
        }
      Cookies:
        CloudFront-Policy: base64(policy)
        CloudFront-Signature: HMAC-SHA1(policy, private_key)
        CloudFront-Key-Pair-Id: APKA...

2. User selects video → browser sends Signed Cookies with all CloudFront requests
   CloudFront validates: are cookies valid signature? Not expired?
   YES → serve HLS files from edge (< 5ms for cached segments)
   NO → 403 → client redirects to login

3. Backend NOT involved in video delivery after login
   Eliminates the pre-signed URL bottleneck
   Backend now only handles: auth, profile, watch history (small queries)
```

**Quality restriction per subscriber tier:**

```
CloudFront Function (Viewer Request event):

  function handler(event) {
    var request = event.request;
    var uri = request.uri;
    var cookies = request.cookies;

    // jwt_tier decoded from session lookup cookie
    // (set by backend at login alongside CloudFront cookies)
    var userTier = getCookieValue(cookies, 'user_tier'); // "standard" or "premium"

    if (uri.includes('/4k/') && userTier === 'standard') {
      return {
        statusCode: 403,
        statusDescription: 'Forbidden',
        body: 'Upgrade to Premium for 4K'
      };
    }
    return request;
  }

Result: Standard users' 4K requests blocked at edge (< 1ms, no origin hit)
         Premium users: no restriction applied
```

#### C. Concurrent Stream Limit (Max 3 per Account)

**Problem:** CloudFront is stateless — can't count concurrent streams at edge.

**Solution: Redis-based stream slot system**

```python
# Fargate service: StreamSlotService (sub-millisecond Redis operations)

import redis
import jwt

r = redis.Redis(host='streamnow-redis.abc.ng.0001.use1.cache.amazonaws.com')

def claim_stream_slot(user_id: str, device_id: str, video_id: str) -> bool:
    """
    Claim a stream slot before issuing CloudFront signed cookies.
    Returns True if slot available, False if at limit (3 concurrent streams).
    """
    key = f"streams:{user_id}"

    with r.pipeline() as pipe:
        # Get current active streams
        active_streams = r.smembers(key)

        # If device already has a slot (re-opening same video), refresh instead
        if device_id.encode() in active_streams:
            r.expire(key, 14400)  # Refresh expiry (4h = signed cookie lifetime)
            return True

        # At or over limit
        if len(active_streams) >= 3:
            return False

        # Add device to active streams set with 4h expiry (matches signed cookie TTL)
        pipe.sadd(key, device_id)
        pipe.expire(key, 14400)  # 4 hours
        pipe.execute()
        return True

def release_stream_slot(user_id: str, device_id: str):
    """Called when user pauses/stops/logs out"""
    r.srem(f"streams:{user_id}", device_id)

# Heartbeat: every 5 minutes, client PINGs:
# POST /api/stream/heartbeat {user_id, device_id, video_id}
# → refreshes Redis key TTL → prevents slot from expiring during active watch
# → if client crashes/closes: TTL expires in < 5 min → slot freed automatically
```

```
Flow:
  User presses Play on Device 4 (already has 3 active streams on D1, D2, D3):

  1. Client → POST /api/stream/play {device_id: D4, video_id: 123}
  2. Fargate → claim_stream_slot(user_id, "D4", "123")
  3. Redis: smembers("streams:user-uuid") = {D1, D2, D3} → len = 3 → REJECT
  4. Fargate → 429 response: "Maximum concurrent streams reached. Stop another device to continue."
  5. CloudFront signed cookies NOT issued → no video access

  Device 2 stops watching (component unmount / tab close):
  1. Client → POST /api/stream/stop {device_id: D2}
  2. Fargate → release_stream_slot(user_id, "D2")
  3. Redis: srem("streams:user-uuid", "D2") → {D1, D3}
  4. Device 4 retries → claim succeeds → signed cookies issued → video starts
```

#### D. GDPR Compliance for EU Data

**Problem:** User watch history, profiles stored in us-east-1 → violates GDPR data residency requirements.

**Solution: Data Classification + Routing**

```
Data classification:
  Video content files (*.ts, *.m3u8):
    NOT personal data → store in us-east-1, replicate as needed for performance

  User personal data:
    Watch history, profile, email, payment → PERSONAL DATA
    Must remain in EU for EU users

EU Data Architecture:
  Aurora Global Database:
    Primary: us-east-1 (US users' data)
    Secondary: eu-west-1 Dublin (EU users' data — GDPR compliant)

  Fargate API services:
    us-east-1: handles US/APAC user APIs
    eu-west-1: handles EU user APIs

  Route 53 Geolocation Routing:
    Europe → api.streamnow.com → eu-west-1 ECS Fargate → Dublin Aurora
    Rest of world → api.streamnow.com → us-east-1 ECS Fargate → Virginia Aurora

  Key guarantee: EU users' requests for /api/me, /api/watch-history, /api/profile
                 never leave EU region

  Video content: European users → CloudFront → nearest PoP → origin S3 us-east-1
                 Video bytes are content, not personal data → no GDPR restriction
```

#### E. Cost Projections

```
Old architecture (70 EC2 + S3 egress):
  70 × c5.2xlarge: $1,097.60/month
  S3 egress (1.4 TB): $127.40/month
  Total: ~$9,625/month

New architecture:
  CloudFront:
    10,000 concurrent × 4h avg watch × 30 days = 1.2M viewer-hours/month
    Avg 4 Mbps (1080p): 1.2M × 4 Mbps × 3600s = 17.28 TB outbound
    CloudFront price (10+ TB): $0.085/GB → 17,280 GB × $0.085 = $1,468.80/month
    Requests (10B/month): 10,000 × 30 × 1,200 HLS requests = $100/month

  Fargate (backend only — video no longer hitting backend):
    16 tasks × 0.5 vCPU / 1 GB: ~$120/month
    (70 EC2 → 16 Fargate tasks = 83% reduction; backend load eliminated)

  S3 egress:
    S3 → CloudFront: FREE (same region)
    Only egress: CloudFront → Internet (counted above)
    S3 storage (growing): ~$50/month

  Aurora Global:
    db.r6g.large (us-east-1 + eu-west-1): $0.26/hr × 2 × 720h = $374.40/month

  ElastiCache Redis:
    cache.r6g.large: $0.16/hr × 720h = $115.20/month

  MediaConvert (one-time per video encoding):
    Per video: ~$0.02/min of content (assume 10,000 videos × 90 min average = $18,000 one-time)
    Ongoing new uploads: ~$50/month

  Total new monthly: $1,469 + $100 + $120 + $50 + $374 + $115 + $50 = ~$2,278/month

  Savings: $9,625 → $2,278 = $7,347/month savings (76% reduction) ✅ (exceeded 50% target)

  Performance:
    Old: 15-40s video start (EC2 API + pre-signed URL + full mp4 download from S3 us-east-1)
    New:
      Signed cookies: issued at login (no per-video backend call)
      CloudFront HLS: first segment cached at PoP → 3ms latency → first frame in < 1s
      Adaptive bitrate: starts at appropriate quality for user's connection
      P95 video start < 1.5s globally ✅ (well under 3s target)

  Scalability:
    10,000 concurrent = 10,000 CloudFront connections (scales automatically)
    Backend Fargate handles only: auth + stream slots + metadata (tiny fraction of old load)
    CloudFront has NO capacity limit that will affect us at 10,000 users
```

---

## Topic 25 Complete

**CDN is covered across all 3 files:**

| File | Sections | Core Content                                                                                                                                                                                                                               |
| ---- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 01   | 1-4      | CDN mechanics, three-tier architecture, cache headers, CloudFront distributions, React SPA deployment                                                                                                                                      |
| 02   | 5-8      | Amazon/radio analogies, Stack Overflow real example, cache hit rate optimization, CDN security, video streaming, AWS mapping (CF Functions, Lambda@Edge, pricing, logs)                                                                    |
| 03   | 9-12     | AWS SAA traps (OAC vs OAI, signed URLs/cookies, CF Functions vs Lambda@Edge, certificate in us-east-1), 5 comparison tables, quick revision mnemonics, StreamNow architect exercise (HLS + CloudFront + Redis stream slots + GDPR routing) |

**Proceed to Topic 26:** How Web Works — the capstone topic tying together all 25 networking concepts.
