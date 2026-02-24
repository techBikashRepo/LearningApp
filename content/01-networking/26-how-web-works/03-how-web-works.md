# How Web Works — Part 3 of 3

### Topic: AWS SAA Exam Synthesis, Master Comparison Tables, Quick Revision, Capstone Architect Exercise

**Series:** Networking Fundamentals → System Design → AWS Solutions Architect
**Sections Covered:** 9, 10, 11, 12

---

## SECTION 9 — AWS SAA Certification Focus

### How "How Web Works" Maps to AWS SAA Exam

The AWS SAA exam doesn't explicitly ask "what happens when you type a URL." But EVERY question about improving web application performance, availability, or security requires understanding the complete web request flow. This section maps AWS services to each phase of the flow.

---

### Phase-by-Phase AWS Service Mapping

**Phase 1 — DNS (Route 53)**

```
Core Route 53 exam knowledge:

Routing Policies:
  Simple:       single answer, no health check, no failover
  Weighted:     A/B testing, blue/green (80% v1 → 20% v2)
  Latency:      route users to lowest-latency AWS region
  Geolocation:  route by user's country/continent (GDPR, content rights)
  Geoproximity: route by geographic distance + bias (Traffic Flow only)
  Failover:     active/passive; primary + standby; requires health check
  Multivalue:   return multiple healthy IPs (NOT a substitute for load balancer)

Alias vs CNAME:
  CNAME: only for non-root domains (www.example.com, NOT example.com)
         chargeable per DNS query; can't point to AWS ELB directly
  Alias: works at zone apex (example.com); free; resolves AWS ELBs, CloudFront, S3 websites

  RULE: For CloudFront + custom domain → USE ALIAS (not CNAME)

Domain registrar vs Route 53:
  Route 53 is BOTH registrar AND DNS service — you can do both in AWS
  Or: register elsewhere (GoDaddy) → update NS records to Route 53 NS servers

Health check types:
  HTTP/HTTPS/TCP health check to your endpoint (every 10s or 30s)
  Calculated health check: combines multiple child checks
  CloudWatch Alarm: if alarm fires → Route 53 marks unhealthy → fail over

EXAM TRAP: "Route 53 health check can't reach private VPC endpoint"
  Fix: Use Route 53 Resolver + CloudWatch CWAgent metric alarm health check
       (private resources can't be directly health-checked by Route 53)
```

**Phase 2 & 3 — Network (VPC, Security Groups, NACLs)**

```
Security Group vs NACL (repeatedly tested):

Security Group:
  Stateful: response traffic automatically allowed (if inbound 443 allowed, reply allowed)
  Level: instance / ENI (network interface)
  Rules: only ALLOW rules (no explicit deny)
  Evaluation: all rules evaluated; most permissive wins

NACL:
  Stateless: must explicitly allow BOTH inbound AND outbound
  Level: subnet
  Rules: ALLOW and DENY rules (numbered; lowest number wins)
  Evaluation: rules evaluated in order (lower number wins)

  NACL inbound rule 100: allow 443
  NACL outbound rule 100: allow 1024-65535 (ephemeral ports for responses)
  (If you forget the ephemeral port outbound rule: NACL blocks responses!)

EXAM TRAP: You add an inbound NACL rule to allow HTTPS. Still can't connect?
  ANSWER: You need an outbound NACL rule for ephemeral ports 1024-65535
```

**Phase 4 & 5 — Transport Layer (ALB, NLB, Global Accelerator)**

```
Load Balancer selection (most-tested pattern):

ALB (Application Load Balancer):
  Layer 7: HTTP/HTTPS/WebSocket
  Routing: by path (/api → API servers; / → web servers)
  Host-based: app1.example.com vs app2.example.com
  WAF: attach AWS WAF rules
  Target types: EC2, ECS, Lambda, IP (private IP targets in VPC)
  Connection: ALB → target in HTTP (decrypts HTTPS before forwarding)
  Headers: X-Forwarded-For (real source IP preserved for apps)

NLB (Network Load Balancer):
  Layer 4: TCP/UDP/TLS
  Use when: static IP required (NLB has static EIP), extreme performance (millions rps)
  Use when: non-HTTP protocols (SMTP, custom TCP)
  TLS passthrough: can pass encrypted TLS to backend (or terminate at NLB)
  Connection: preserves source IP (no X-Forwarded-For header added)

EXAM QUESTION: "Application needs a fixed IP address that clients can whitelist. What LB?"
ANSWER: NLB (has static EIP per AZ; ALB has dynamic IPs that change)

EXAM QUESTION: "Application needs to route /mobile → mobile servers, /web → web servers"
ANSWER: ALB (path-based routing; NLB is layer 4 and can't inspect HTTP path)

Global Accelerator:
  NOT a CDN (no caching)
  AWS anycast IPs: users connect to nearest AWS edge via anycast → routed over AWS backbone
  Use case: non-HTTP (TCP/UDP game servers, real-time apps, IoT), static IP global routing

EXAM QUESTION: "Application needs global routing AND fixed static IP addresses"
ANSWER: Global Accelerator (static anycast IPs + AWS backbone routing)
        NOT CloudFront (dynamic IPs) NOT ALB (regional only)
```

**Phase 6 — Origin Processing (EC2, ECS, Lambda)**

```
Compute tier selection:

EC2 + Auto Scaling Group:
  When: long-running processes, stateful workloads, OS-level customization needed
  Scale: min/max/desired; target tracking on ALB request count
  Warm-up time: 3-5 minutes to launch + configure + health check

ECS Fargate:
  When: containerized, stateless, variable scale, no OS management
  Scale: ECS Service Auto Scaling; 60-90s to launch a new task
  Cost: pay per vCPU/memory second (vs EC2: pay per hour)

Lambda:
  When: event-driven, short-lived functions (< 15 min), pay-per-invocation
  API: API Gateway → Lambda (common serverless pattern)
  Cold start: 200ms-2s on first invocation (warm: ~1ms)

EXAM TRAP: Lambda concurrency limits
  Default: 1,000 concurrent executions per region
  Reserved concurrency: guarantee X for critical function
  Provisioned concurrency: eliminate cold starts for predictable load

EXAM TRAP: API Gateway + Lambda timeout
  API Gateway hard timeout: 29 seconds (non-changeable)
  Lambda max: 15 minutes
  For async jobs > 29s: use SQS pattern (API returns job ID, Lambda processes async, client polls)
```

**Phase 6 — Database and Cache (RDS, DynamoDB, ElastiCache)**

```
Database selection for web apps:

RDS/Aurora (relational):
  ACID: use for financial, inventory, order management
  Multi-AZ: sync standby replica in different AZ → automatic failover < 60s
  Read replicas: async copies for read scaling (eventually consistent)

  Aurora: MySQL/PostgreSQL compatible; 3× faster; storage auto-scales to 128TB
  Aurora Serverless: auto-pause when inactive (dev/test environments)
  Aurora Global: one primary region, up to 5 read regions (< 1s replication lag)

DynamoDB (NoSQL):
  Single-digit millisecond latency at any scale
  On-demand: pay per read/write unit (no capacity planning)
  DAX: DynamoDB Accelerator (in-memory cache for DynamoDB; microsecond reads)
  Global Tables: multi-region, active-active replication

ElastiCache:
  Redis: data structures (sorted sets for leaderboards), pub/sub, persistence
  Memcached: simple key-value, multi-thread, no persistence

EXAM: "Application needs session management across many EC2 instances"
ANSWER: ElastiCache Redis (sticky sessions at ALB is anti-pattern for stateless design)

EXAM: "DynamoDB reads are slow. How to add sub-millisecond reads?"
ANSWER: DAX (DynamoDB Accelerator) — in-memory cache for DynamoDB queries
```

**Phase 7 — CDN Layer (CloudFront)**

```
Key CloudFront exam traps (covered in Topic 25, summarized here):

1. ACM certificate for CloudFront: must be in us-east-1
2. OAC (preferred) over OAI (legacy) for S3 origins
3. Signed URL = one file; Signed Cookie = path pattern
4. CloudFront Functions: viewer events only, < 1ms, no network calls
5. Lambda@Edge: all events, 5-30s, must be in us-east-1
6. CloudFront vs Global Accelerator: CDN/cache vs routing/static IP
7. Origin Shield: extra caching tier, reduces origin requests ~90%
8. Price Class 100: cheapest, US+EU only; All: maximum coverage
```

---

### AWS SAA "How Web Works" Scenario Questions

```
Scenario 1: "Website is slow for users in Australia. Traffic originates from us-east-1."
  Diagnosis: High RTT between AU users and us-east-1 (200ms+ per round trip)
  Solutions (in order of effort):
    A. CloudFront (CDN) — caches static + semi-dynamic content at Sydney PoP
    B. Global Accelerator — routes to us-east-1 over AWS backbone (reduces jitter)
    C. Multi-region with Route 53 Latency routing — deploy ap-southeast-2 (Sydney)

  EXAM ANSWER: CloudFront (most common first answer); Global Accelerator for dynamic/non-HTTP

Scenario 2: "Application gets 503s during traffic spikes that last 5 minutes"
  Diagnosis: auto scaling can't add capacity fast enough; startup takes 3 min; spike = 5 min
  Solutions:
    A. Pre-warm Auto Scaling (scheduled scaling before known spikes)
    B. CloudFront cache more aggressively (reduce origin load by 90%)
    C. SQS to smooth burst (buffer requests, process at consistent rate)
    D. Provisioned Lambda concurrency (for serverless architectures)

  EXAM ANSWER: Enable CloudFront caching + Scheduled Auto Scaling ahead of known spikes

Scenario 3: "Application served over HTTP has data interception complaints"
  Solution: HTTPS only (enforce with CloudFront viewer policy: Redirect HTTP → HTTPS)
  HTTP → CloudFront → redirect 301 to HTTPS
  Add HSTS: Strict-Transport-Security: max-age=31536000 in response headers

  EXAM ANSWER: CloudFront viewer protocol policy = Redirect HTTP to HTTPS
               HSTS header in CloudFront response headers policy

Scenario 4: "After deployment, users see old version of the site for up to 24 hours"
  Diagnosis: Long TTL on CDN. New deployment doesn't invalidate CDN cache.
  Solutions:
    A. CloudFront invalidation on deploy (short-term fix): aws cloudfront create-invalidation --paths "/*"
    B. Content hashing (permanent fix): every JS/CSS file gets hash in filename
       deploy → new hash → new URL → CDN never returns old file
    C. Separate index.html TTL: Cache-Control: no-cache on index.html (CDN validates every request)

  EXAM ANSWER: Content hashing for assets + no-cache on index.html

Scenario 5: "Need to block users from countries X, Y, Z from accessing the application"
  Solution: CloudFront Geo-restriction (allow/block list by country)
  Returns 403 Forbidden to blocked country users

  EXAM ANSWER: CloudFront geo-restriction feature
  NOTE: Route 53 Geolocation routing routes to different ENDPOINTS per country — NOT blocks
```

---

## SECTION 10 — 5 Master Comparison Tables

### Table 1: All 26 Topics — Web Request Phase Mapping

| Phase                  | Topic(s) Covered                                                               | AWS Service                        |
| ---------------------- | ------------------------------------------------------------------------------ | ---------------------------------- |
| DNS Resolution         | DNS, CDN, How Web Works                                                        | Route 53, CloudFront (DNS managed) |
| TCP Handshake          | TCP vs UDP (T08), RTT (T24)                                                    | VPC, Security Groups, NLB          |
| TLS Handshake          | SSL/TLS (T20), Latency (T23), RTT (T24)                                        | ACM, CloudFront, ALB               |
| HTTP Request/Response  | HTTP1/2/3 (T09), REST/gRPC/GraphQL (T10), Request-Response Lifecycle (T22)     | API Gateway, ALB                   |
| CDN / Edge             | CDN (T25), DNS/CDN/Anycast (T12), Caching L14-T18                              | CloudFront, Global Accelerator     |
| Load Balancing         | Load Balancing L4/L7 (T13), Auto-Scaling (T20)                                 | ALB, NLB, Auto Scaling             |
| Application Processing | Microservices (T39), Idempotency (T27), Rate Limiting (T23)                    | ECS, Lambda, EKS                   |
| Caching                | Cache Eviction (T15), Write-Through/Back/Around (T16), Cache Problems (T17-18) | ElastiCache, DAX                   |
| Database               | ACID vs BASE (T06), Consistency Models (T04), CAP Theorem (T05)                | Aurora, DynamoDB, RDS              |
| Messaging/Async        | Message Queues (T29), Kafka vs RabbitMQ (T30), Event-driven (T33)              | SQS, SNS, EventBridge, Kinesis     |
| Security               | Auth/AuthZ (T45), OAuth/JWT (T46), TLS (T47), OWASP (T50)                      | IAM, Cognito, WAF, Shield          |
| Observability          | Logging (T51), Metrics (T52), Tracing (T53), Alerting (T54), Health (T55)      | CloudWatch, X-Ray                  |
| Resilience             | Circuit Breaker (T34), Retries (T35), Graceful Degradation (T37)               | SDK retry, App-level               |
| Performance            | Latency/Throughput (T03, T23), RTT (T24), Scalability (T19, T20)               | CloudFront, ElastiCache, Aurora    |

### Table 2: AWS Service Decision Tree for Web Apps

| If you need to...                      | Use                          | Not                                         |
| -------------------------------------- | ---------------------------- | ------------------------------------------- |
| Route global DNS                       | Route 53                     | Third-party DNS (if already on AWS)         |
| Serve static files globally fast       | CloudFront + S3              | EC2 serving files directly                  |
| Protect against DDoS                   | Shield Advanced + CloudFront | Nothing; all sites need this                |
| Filter malicious HTTP traffic          | AWS WAF + CloudFront         | Just security groups (L3 only)              |
| Route HTTP by path or host             | ALB                          | NLB (L4 only)                               |
| Need static IPs globally               | Global Accelerator           | CloudFront (dynamic IPs)                    |
| Cache sub-millisecond in-memory        | ElastiCache Redis            | DynamoDB (5ms)                              |
| Store cache at CDN edge                | CloudFront cache behavior    | ElastiCache (within VPC, not edge)          |
| Serverless API                         | API Gateway + Lambda         | EC2 (over-provisioned for low-traffic APIs) |
| ACID transactions                      | Aurora                       | DynamoDB (eventually consistent by default) |
| Infinite horizontal scale, simple keys | DynamoDB                     | RDS (connection limits)                     |
| Full-text search                       | OpenSearch Service           | RDS LIKE queries (slow)                     |
| Queue to decouple services             | SQS                          | Direct API calls between services           |
| Fan-out to multiple consumers          | SNS → multiple SQS           | Single SQS (only one consumer)              |
| Real-time stream processing            | Kinesis Data Streams         | SQS (no replay, no ordering)                |

### Table 3: Latency Values You Must Memorize (Exam + Interviews)

| Operation                         | Latency       | Why it matters                          |
| --------------------------------- | ------------- | --------------------------------------- |
| L1 CPU cache access               | 1ns           | Reference for "fast"                    |
| RAM access                        | 100ns         | 100× slower than L1                     |
| SSD read (local NVMe)             | 100μs         | 1,000× slower than RAM                  |
| HDD read (random)                 | 10ms          | 100,000× slower than RAM                |
| Same-AZ network round trip        | 0.1–1ms       | ECS task → ElastiCache in same AZ       |
| Cross-AZ (same region)            | 1–3ms         | Highly available but with latency cost  |
| Cross-region (US East → US West)  | ~60ms         | Multi-region adds this minimum overhead |
| US East → Europe                  | ~80ms         | 1 RTT across Atlantic                   |
| US East → Asia-Pacific            | ~150ms        | 1 RTT across Pacific                    |
| US East → geostationary satellite | ~600ms        | Unusable for real-time                  |
| Redis GET (ElastiCache)           | 0.3–1ms       | In-memory, same-AZ                      |
| DynamoDB GET                      | 1–5ms         | Managed NoSQL, single-digit ms          |
| RDS Aurora SELECT (warm)          | 5–30ms        | Index-optimized relational query        |
| Lambda cold start                 | 200ms–2s      | Worst case for first invocation         |
| Lambda warm                       | 1–10ms        | After first invocation                  |
| CloudFront edge (cache HIT)       | 2–10ms        | Served from local PoP memory            |
| CloudFront edge (cache MISS)      | 50–150ms      | Origin fetch + caching                  |
| Ping same-city CDN PoP            | 5–15ms        | Typical urban CDN round trip            |
| Speed of light (vacuum)           | 300,000 km/s  | Physics: hard lower bound on latency    |
| Speed of light (fiber optic)      | ~200,000 km/s | 2/3 of vacuum speed in glass            |

### Table 4: HTTP Status Codes and Their AWS Diagnostic Meaning

| Status Code               | Meaning                 | Most Likely Cause in AWS                                | Fix                                                     |
| ------------------------- | ----------------------- | ------------------------------------------------------- | ------------------------------------------------------- |
| 200 OK                    | Success                 | —                                                       | —                                                       |
| 301/302                   | Redirect                | CloudFront viewer policy: HTTP → HTTPS                  | Intentional; ensure no redirect loop                    |
| 304 Not Modified          | Cached (ETag match)     | CDN/browser conditional request                         | Efficient — ETag working correctly                      |
| 400 Bad Request           | Client error            | Invalid request body, missing required params           | Check API Gateway request validation                    |
| 401 Unauthorized          | Not authenticated       | Missing/expired JWT, Cognito token expired              | Check Lambda authorizer; check token TTL                |
| 403 Forbidden             | Not authorized          | S3 bucket policy, CloudFront geo-restriction, WAF block | Check bucket policy/OAC; CloudFront geo; WAF logs       |
| 404 Not Found             | Resource missing        | Wrong S3 key (case-sensitive!), wrong route in ALB      | Debug path, check content hashing redirect              |
| 429 Too Many Requests     | Rate limited            | API Gateway throttling, WAF rate rule                   | Check API GW throttle limits; adjust                    |
| 500 Internal Server Error | App bug                 | Lambda uncaught exception, ECS app crash                | Check CloudWatch Logs; Lambda error count metric        |
| 502 Bad Gateway           | Invalid origin response | ECS task crashed, Lambda returned malformed response    | Check ECS CloudWatch logs; ALB target health            |
| 503 Service Unavailable   | No healthy targets      | All ALB targets unhealthy; Lambda concurrency limit     | Scale ECS; check health check; raise Lambda concurrency |
| 504 Gateway Timeout       | Origin timed out        | Slow DB query, Lambda timeout, API GW 29s exceeded      | Add DB index, add caching, use async SQS pattern        |

### Table 5: "Why Is My Site Slow?" — Diagnostic Decision Tree

| Symptom                             | Root Cause                                    | AWS Signal                                  | Fix                                                                  |
| ----------------------------------- | --------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------- |
| Slow globally (all users)           | Single-region origin, all traffic hits origin | CloudFront CacheHitRate < 30%               | Add CloudFront, increase TTLs                                        |
| Slow in one region only             | No CDN PoP coverage OR no multi-region        | High origin latency from specific geography | CloudFront Price Class All; or deploy in that region                 |
| Slow first visit, fast after        | Cold CDN / cold browser cache                 | CloudFront X-Cache: Miss on first request   | Pre-warm CDN after deploy; use content hashing                       |
| High TTFB (> 500ms)                 | Slow server processing                        | X-Ray: DB call is 400ms+ of request time    | Cache DB result in ElastiCache; fix N+1                              |
| Page loads HTML fast but then spins | JS blocking rendering                         | Chrome LCP > 3s; large un-split JS bundle   | Code-split JS; defer non-critical; use CDN                           |
| Intermittent 503s                   | Auto scaling lag                              | ALB 503 spike during scale-out events       | Pre-warm ASG; increase min capacity                                  |
| Site down for ~60s then recovers    | RDS Multi-AZ failover                         | RDS events: "Multi-AZ instance failover"    | Use Aurora for faster failover (~30s); pre-warm app DB connections   |
| Site slow during deploy             | Old ECS tasks drain, new cold                 | ALB: temporary reduced healthy host count   | Blue/green deployment (new target group); CodeDeploy weighted switch |
| Everything slow at same time        | Origin overloaded                             | ALB RequestCount spike + ECS CPU 100%       | Increase ECS task count; add ElastiCache; cache more at CDN          |
| Specific API endpoint slow          | N+1 problem or missing index                  | X-Ray: multiple DB calls per request (10+)  | DataLoader batching; add DB index; add caching                       |

---

## SECTION 11 — Quick Revision

### 10 Key Points for Last-Minute Review

1. **The web request has 8 phases**: DNS → TCP → TLS → HTTP Request → Transit → Server Processing → HTTP Response → Browser Rendering. Each adds latency; CDN + caching shortens every phase.

2. **DNS resolution: 3 cache levels** (browser → OS → recursive resolver); first lookup 20-200ms; subsequent 0-2ms. Route 53 health checks enable automatic failover.

3. **TCP = 1 RTT before data; TLS 1.3 = 1 more RTT**. Total: 2+ RTTs before first HTTP byte. CDN terminates both at nearest edge city → 5ms instead of 200ms.

4. **TTFB = network latency + server processing**. High TTFB = origin too far (CDN fix) OR slow processing (cache/index fix). Measured in DevTools Network tab.

5. **HTTP/2 multiplexes all resources over 1 TCP connection**; HTTP/1.1 opens 6 connections per domain. HTTP/2 = page load dramatically faster (one TLS, one TCP, many parallel streams).

6. **Cache hierarchy**: Browser (0ms) → CDN PoP (5ms) → Regional Cache (20ms) → ElastiCache (1ms) → DB (50ms). 99% of requests should never reach DB.

7. **ALB for HTTP routing (path/host-based), NLB for static IP or TCP**. Static IP → NLB or Global Accelerator (CloudFront has dynamic IPs).

8. **ACM certificate for CloudFront must be in us-east-1** (regardless of users' region). Route 53 Alias (not CNAME) for zone apex domains.

9. **504 = origin timeout; 503 = no healthy targets; 502 = origin returned invalid response; 403 = access denied** (check: CloudFront geo-restriction, WAF, S3 bucket policy/OAC).

10. **"Design a global web app" answer pattern**: Route 53 (latency routing) → CloudFront (CDN + WAF + Shield) → ALB (multi-AZ) → ECS Fargate (stateless, auto-scale) → ElastiCache (session + query cache) → Aurora Multi-AZ (primary DB) + Read Replicas → S3 (assets) → SQS/EventBridge (async) → X-Ray (tracing).

### 30-Second Explanation

"When you press Enter on a URL, your browser first finds the server's IP via DNS, then establishes a TCP connection via a 3-way handshake, then negotiates TLS encryption for HTTPS. Next it sends an HTTP GET request which travels through the internet to the nearest CDN edge, which checks its cache. Cache hit: returns the page in milliseconds. Cache miss: the request forwards to the origin — a load balancer routes it to an application server, which checks in-memory cache, then the database if needed, assembles HTML, and returns it. The response travels back, CDN caches it, browser receives HTML, then fetches CSS and JavaScript in parallel over HTTP/2, builds the DOM and render tree, runs layout and paint, and finally the user sees the page. On AWS: Route 53 → CloudFront → WAF → ALB → ECS → ElastiCache → Aurora → S3."

### Mnemonics — The Master Set

**The 8 Phases: "DTTHT SRR"** (Doctor Takes The Hospital Train, Somewhere Really Remote)

- **D**NS resolution
- **T**CP handshake
- **T**LS handshake
- **H**TTP request
- **T**ransit
- **S**erver processing
- **R**esponse
- **R**endering

**AWS Web Stack: "R-C-W-A-E-E-A-S"** (Really Cool Websites Are Even Easier At Scale)

- **R**oute 53 (DNS)
- **C**loudFront (CDN)
- **W**AF (Security)
- **A**LB (Load Balancer)
- **E**CS Fargate (Compute)
- **E**lastiCache (Cache)
- **A**urora (Database)
- **S**3 (Storage)

**Latency order: "NRSH Cross"** (Nanoseconds, Microseconds, Sub-milliseconds, High-milliseconds — cross-region)

- Same memory: nanoseconds
- Same machine (SSD): microseconds
- Same AZ (Redis): < 1ms
- Same region (cross-AZ): 1-3ms
- Cross-region: 60-200ms

**HTTP error code pattern:**

- 4xx = Client's fault (wrong request, not authorized, not found)
- 5xx = Server's fault (crashed, overloaded, timed out)
- 2xx = Success (200 OK, 201 Created, 304 Not Modified)
- 3xx = Redirect (301 permanent, 302 temporary)

**504 vs 503 vs 502:**

- 504 = **T**imeout (Timed out waiting for upstream)
- 503 = **N**o service (No healthy targets)
- 502 = **B**ad gateway (Got invalid response from upstream)

---

## SECTION 12 — Architect Thinking Exercise: The Capstone

_This is the final architect challenge. Take 5 minutes to think before reading the solution._

---

### The Challenge

**Design google.com from scratch on AWS.**

Constraints (strictly enforced):

- **Scale**: 10 billion requests per day (115,000 requests/second average, 400,000 req/s peak)
- **Availability**: 99.99% uptime globally (< 53 minutes downtime per year)
- **Latency**: < 100ms to First Contentful Paint for 95th percentile of users globally
- **Personalization**: every user sees a customized home page (logged-in users)
- **Security**: cannot be DDoSed offline; must handle 1 Tbps+ attack capacity
- **Budget**: optimize for this scale (but don't sacrifice SLA for cost)
- **You must cover**: DNS, CDN, compute, database, caching, search (the core product), and observability

---

### Solution

---

#### Architecture Philosophy

"The best request is the one that never reaches your origin."

Tiered approach: serve 95% of traffic from edge/cache, <4% from regional compute clusters, <1% from core origin databases.

---

#### Layer 1 — Global DNS (Route 53 + Anycast)

```
DNS Architecture:

Route 53 for public DNS:
  Hosted zone: google.com (simulated)

  A record: www.google.com → Alias → CloudFront distribution
  AAAA record: www.google.com → Alias → CloudFront (IPv6 support)

Routing policy: Latency-Based Routing to nearest CloudFront PoP
  Tokyo users → Tokyo PoP (5ms RTT)
  London users → London PoP (3ms RTT)
  Sydney users → Sydney PoP (8ms RTT)

Health checks on all regional origins:
  If us-east-1 goes fully down → Route53 failover to us-west-2 (< 60s failover)

DNS TTL: 60 seconds
  Why not 300s? Faster DNS failover during regional outage
  Why not 5s? DNS resolver caching becomes ineffective (amplifies recursive resolver load)
  60s: best balance of speed and resolver load

Route 53 Resolver inbound endpoints:
  For corporate users (split horizon): internal DNS resolves to internal endpoints
```

#### Layer 2 — CDN Edge (CloudFront)

```
CloudFront Distribution Configuration:

Origins:
  1. S3 (us-east-1): static assets (CSS, JS, images) — OAC enabled
  2. ALB (us-east-1 primary): dynamic content
  3. ALB (eu-west-1 secondary): EU origin failover
  4. Origin Group: primary=us-east-1 ALB, failover=eu-west-1 ALB
     Failover triggers: HTTP 5xx or origin timeout

Price Class: All (450+ PoPs globally — google.com can't compromise on coverage)

Cache Behaviors (path pattern priority):
  /s/* (static assets with content hash):
    Cache-Control: max-age=31536000, immutable
    TTL: 365 days at edge
    Compression: Brotli

  /xjs/* (JavaScript bundles):
    Cache-Control: max-age=31536000, immutable
    TTL: 365 days

  /images/* (logos, icons):
    Cache-Control: public, max-age=86400
    TTL: 24h

  / (home page — PERSONALIZED):
    Cache-Control: private, no-store (per-user, cannot cache)
    TTL: 0 at edge
    BUT: use "ESI" or "Fragment caching" pattern (see Layer 3)

  /search* (live search results):
    Cache-Control: no-store
    TTL: 0 (real-time, never cache search results)

Origin Shield:
  Enabled for us-east-1 origin
  All 450 PoP misses funnel through us-east-1 Origin Shield first
  Reduces origin hits by 90% for popular but uncached pages

WAF Rules:
  AWS Managed Rule Groups:
    - Core Rule Set (OWASP Top 10)
    - Bot Control (block scrapers, allow Googlebot)
    - IP Reputation (block known malicious IPs)
    - Rate limiting: > 1,000 requests/5min from same IP → CAPTCHA challenge

AWS Shield Advanced:
  Always-on volumetric DDoS protection
  DRT team on standby for attack response
  1 Tbps+ attack: CloudFront PoPs absorb it at edge, origin never sees it

CloudFront Functions (viewer request):
  Purpose: handle personalization header injection, A/B test flag
  Read cookie: user_experiment_group (A/B flag)
  Add header: X-Experiment: group_b → ALB routes to experiment compute fleet
  < 1ms execution at all 450 PoPs
```

#### Layer 3 — Edge Personalization (Lambda@Edge)

```
The personalization challenge: google.com home page is unique per user
  10B requests/day = 10B unique pages = cannot cache at CDN

Solution: Cache the SHELL, personalize at edge

Lambda@Edge (Origin Request event — runs before origin query):

  1. Read session JWT from cookie
  2. Decode JWT: extract user_id, user_country, user_language, is_logged_in
  3. Make Redis call → fetch user's personalization config (language, region, saved URL)
     [ElastiCache Redis Global Datastore: 5 regions, < 5ms read anywhere]
  4. Add request headers:
     X-User-Lang: en (or ja/es/de...)
     X-User-Region: US
     X-User-Status: logged_in
  5. Modify cache key: CloudFront caches per (URL + X-User-Lang + X-User-Region)
     3 languages × 50 regions = 150 cache variants per URL
     (not per-user: language+region defines the personalized shell)

  Result:
    150 cache variants × 1 minute TTL = 150 versions, each cached for 1 minute
    150M+ users but only 150 edge-cached variants
    Origin hit rate: 150 per minute (one refresh per variant per minute)
    Without this: 10B requests/day hit origin
    With Lambda@Edge shell caching: 150 × 1440 min = 216,000 origin hits/day
    Reduction: 10,000,000,000 → 216,000 = 46,000× reduction in origin load
```

#### Layer 4 — Application Tier (ECS Fargate, Multi-Region)

```
Deployment regions:
  Primary:   us-east-1 (N. Virginia) — main traffic hub
  Secondary: eu-west-1 (Ireland) — European users
  Tertiary:  ap-northeast-1 (Tokyo) — Asia-Pacific users

  Route 53 Latency routing distributes to nearest region

ECS Fargate Configuration:
  Service: google-home (web tier)
  Min tasks: 100 per region
  Max tasks: 10,000 per region (Black Friday / Super Bowl equivalent)
  Auto scaling: ALB RequestCountPerTarget > 500 → add 50 tasks (aggressive pre-scale)

  Why ECS Fargate over Lambda?
    10B requests/day = 115K req/s average
    Lambda: 115K concurrent = 115K cold starts possible = unpredictable latency
    ECS: persistent containers = consistent warm latency
    Lambda @115K req/s: ~$50M/month (Lambda pricing)
    ECS Fargate @115K req/s: ~$0.5M/month (much cheaper at sustained high volume)

ALB Configuration:
  Multi-AZ: targets in 3 AZs per region (9 AZs total across 3 regions)
  ALB targets: ECS tasks
  Connection draining: 30s (gracefully complete in-flight requests during deploy)
  Health check: GET /healthz every 10s; 2 consecutive 200s = healthy; 3 failures = remove

  Blue/Green Deployments (CodeDeploy):
    New version: deploy new ECS tasks alongside existing
    Canary: 10% traffic → new (monitor 5 minutes)
    Linear: +10% every minute
    Full: 30 minutes later → 100% new (zero-downtime)
```

#### Layer 5 — Search Infrastructure (The Core Product)

```
Search is not a simple DB query — approximate design:

Index Storage: S3 Glacier Instant + Custom Index on EC2 i3en instances
  Web index: hundreds of PB of inverted index (URL → words, words → URLs)
  S3: too slow for real-time lookup → Index loaded into EC2 high-memory instances
  i3en.24xlarge: 60TB NVMe, 768GB RAM — used for "hot" index shards

Query Path:
  User searches "aws certification"

  1. ALB → Search coordinator service (ECS)
  2. Coordinator: parallel fan-out to 100+ index shard services
     Each shard: "which URLs contain 'aws certification'? Return top 100 + relevance score"
  3. Coordinator: merge results, rank by PageRank + recency + quality
  4. Personalization: adjust for user's country (GDPR: geo-filter EU court orders)
  5. Assemble: top 10 results, ads (separate auction service), knowledge panel

AWS Services for search:
  OpenSearch Service: managed Elasticsearch-compatible (but at Google scale: custom)
  DynamoDB Global Tables: for URL crawl metadata (last crawl, status)
  S3: index file storage
  EC2 i-family (storage-optimized): hot index shards in memory
  Elasticache Redis: query result cache (popular queries cached 5 minutes)

Query cache (most impactful layer):
  "Top 100,000 search queries" cover 65% of ALL search traffic
  Cache these in ElastiCache Redis (sub-millisecond return) → 65% of queries: 0.5ms
  Remaining 35%: fresh computation from index

Daily index update:
  Crawler results → S3 → Apache Spark on EMR → build new index shards → atomic swap
  Zero-downtime index update via S3 A/B pointer swap
```

#### Layer 6 — Data Layer (Aurora Global + DynamoDB)

```
User Data (profiles, settings, search history):
  Aurora PostgreSQL Global Database:
    Primary: us-east-1 (write)
    Read replicas: eu-west-1, ap-northeast-1, ap-southeast-1
    Replication lag: < 1s globally
    Failover: promote read replica in < 30s (vs RDS Multi-AZ 60s)

  Data sharding (by user_id hash):
    Shard 0-499M users: Aurora cluster 1
    Shard 500M-1B users: Aurora cluster 2
    ...
    (At Google scale, even Aurora can't hold all users in single cluster)

Session Data (short-lived, high-volume):
  DynamoDB Global Tables:
    All regions active-active
    Session: user_id → {last_active, search_context, preferences}
    TTL: auto-expire sessions after 30 days of inactivity
    Scale: DynamoDB handles billions of sessions without capacity planning

URL/Crawl Metadata:
  DynamoDB (us-east-1 primary):
    Partition key: url_hash
    Attributes: last_crawled, status, page_rank, crawl_frequency
    On-demand capacity: handles crawler bursts (billions of URLs/day)

Personalization cache:
  ElastiCache Redis Global Datastore:
    5 regions (us-east-1, eu-west-1, ap-northeast-1, ap-southeast-1, us-west-2)
    Read-from-nearest-region (< 5ms globally)
    Stores: user_id → personalization_config (language, country, experiment flags)
    TTL: 1 hour (refresh on each page load)
```

#### Layer 7 — Observability

```
The monitoring system for 10B requests/day:

Metrics (CloudWatch):
  115,000 metrics per second across all services

  Critical dashboards:
    Request rate per region + P50/P95/P99 TTFB
    Cache hit rate per CDN PoP
    Error rate per service (ALB 5xx, Lambda errors, DynamoDB throttles)
    DB: Aurora replication lag, query latency, connection pool usage

  Alarms (SNS → PagerDuty → On-call):
    P99 TTFB > 500ms for 3 consecutive minutes (automated runbook: check cache hit rate)
    5xxErrorRate > 0.1% (immediate page)
    Cache hit rate < 70% (auto-investigate CDN config)
    Aurora replication lag > 5s (failover risk)

Distributed Tracing (X-Ray):
  Sample rate: 1% of requests (at 115K req/s: 1,150 traces/second = enough)
  Service Map: visualizes all microservice call paths and latencies
  Trace for P99 outliers: sample 100% of requests > 1s (catch tail latency causes)

  X-Ray Groups:
    Group: "Critical Path" (home load + search + first result click)
    Alert: if critical path P99 > 500ms → investigate → fix in < 30 minutes

Log Aggregation (CloudWatch Logs + Kinesis):
  115K requests/sec × 200 bytes/log = 23 MB/second of access logs
  Kinesis Data Firehose → S3 (daily partitioned) → Athena (ad-hoc queries)
  CloudWatch Logs Insights: real-time queries for incidents

  Saved Athena query: "Find all requests where TTFB > 2s in last 1 hour":
    SELECT request_id, uri, ttfb_ms, aws_cloudfront_pop, target_instance
    FROM access_logs_2024
    WHERE ttfb_ms > 2000 AND timestamp > now() - interval 1 hour
    ORDER BY ttfb_ms DESC LIMIT 100;
```

#### Cost Estimate

```
Scale: 10B requests/day = 115K req/s (assume ~1KB average response, mixed cache hit/miss)

CloudFront:
  Data out: 10B req × 50KB avg (mix of miss+hit) = 500 TB/month
  Data out cost: 500 TB × $0.080/GB (volume pricing) = $40,000/month
  Requests: 10B × 30 days × $0.010/10K = $300,000/month (this is high)
  Estimate: ~$340,000/month CloudFront
  (Google's actual CDN: proprietary, near zero marginal cost — this is for AWS simulation)

EC2/ECS compute (3 regions, 300 Fargate tasks average):
  c6g.2xlarge equivalent (8 vCPU, 16GB): $0.36/hr × 300 × 720h = $77,760/month

Aurora (3 regional read replicas):
  db.r6g.4xlarge × 4 instances: $1.04/hr × 4 × 720 = $3,000/month per cluster × 3 = $9,000

ElastiCache (5 regions, cluster per region):
  r6g.xlarge × 3 nodes × 5 regions: $0.268/hr × 15 × 720 = $2,894/month

DynamoDB (billions of reads):
  On-demand: 10B item reads/month × $0.25/1M = $2,500/month

S3 (index, assets, logs):
  Storage: 1 PB × $0.023/GB = $23,000/month

Total estimated AWS cost: ~$450,000/month

Google's actual infrastructure cost: PROPRIETARY (but orders of magnitude different)
  - They own custom ASICs (TPUs for ML, custom switch ASICs)
  - Own fiber cables (saves $millions in transit costs)
  - Custom OS, custom hardware → much higher efficiency per dollar
  - Estimated annual infrastructure cost: $10-15B (proprietary)

AWS simulation takeaway: at Google's scale, you'd need $5-8M/month on AWS.
Real Google saves 95% of that through vertical integration and custom hardware.
But for a startup scaling to millions? The exact same AWS pattern scales effectively.
```

---

## The 26-Topic Journey — Complete

You've completed a full tour of networking fundamentals from first principles to AWS production architecture:

| Block                        | Topics                                                                                           | Mastery                |
| ---------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------- |
| **Foundations**              | 01-07: Requirements, Scalability, Latency, Consistency, CAP, ACID/BASE, SLAs                     | System thinking        |
| **Transport**                | 08-11: TCP/UDP, HTTP versions, REST/gRPC/GraphQL, WebSockets/SSE                                 | Protocol decisions     |
| **Network Services**         | 12-18: DNS/CDN/Anycast, Load Balancing, Caching layers, Eviction, Write policies, Cache problems | Infrastructure         |
| **Scale & Resilience**       | 19-23: Scaling, Auto-scaling, Stateless, Backpressure, Rate limiting                             | Operations             |
| **Distributed Systems**      | 24-33: Consensus, Leader election, Clocks, Idempotency, Messaging, Kafka/SQS, Events             | Architecture           |
| **Reliability Patterns**     | 34-38: Circuit breakers, Retries, Bulkheads, Graceful degradation, Chaos                         | Production             |
| **Application Architecture** | 39-44: Monolith/Microservices, Service discovery, API Gateway, Inter-service, Sagas              | Design                 |
| **Security**                 | 45-50: Auth, OAuth/JWT, TLS, Secrets, DDoS, OWASP                                                | Secure design          |
| **Observability**            | 51-55: Logging, Metrics, Tracing, Alerting, Health checks                                        | Operational excellence |
| **Network Deep Dives**       | 20 (TLS), 21 (CORS), 22 (Lifecycle), 23 (Latency), 24 (RTT), 25 (CDN), 26 (Web Works)            | End-to-end synthesis   |

**You are ready for:**

- AWS Solutions Architect Associate exam
- System Design interviews (FAANG and beyond)
- Senior engineering discussions about web performance and architecture
- Diagnosing real production incidents across the full web stack
