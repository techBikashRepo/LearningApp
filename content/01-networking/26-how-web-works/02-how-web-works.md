# How Web Works — Part 2 of 3

### Topic: Real-World Web Stacks, AWS Complete Architecture, System Design Patterns, Interview Q&As

**Series:** Networking Fundamentals → System Design → AWS Solutions Architect
**Sections Covered:** 5, 6, 7, 8

---

## SECTION 5 — Real World Examples

### How the Giants Solve "How Web Works"

The URL-to-page journey is universal, but every major tech company tackles it differently. Their solutions reveal the deepest system design thinking in the industry.

---

### Google — The Edge-First Architecture

Google's core insight: **every millisecond is revenue**. A 100ms delay in search results = 1% fewer clicks = millions in lost ad revenue.

```
Google's Web Request Architecture:

User in Tokyo types google.com
        │
        ▼
[Route: DNS Anycast]
Google has its own authoritative DNS servers
Reply comes from nearest server (Tokyo PoP)
No third-party DNS — Google controls all latency here

        │
        ▼
[TLS Termination: Google Front End (GFE) in Tokyo]
Google owns and operates 100+ GFE locations worldwide
TLS terminates in Tokyo (< 5ms RTT for Tokyo user)
NOT in Mountain View (which would be 80+ ms)

Key: Google terminates TLS at the user's nearest city
Traditional sites: TLS goes to your origin = painful RTT for remote users

        │
        ▼
[Google Private Backbone]
Tokyo GFE → Mountain View via Google's private fiber
NOT the public internet
Google has trans-Pacific fiber cables (FASTER-GO, UNITY cables)
Lower latency, less jitter, more bandwidth = predictable performance

        │
        ▼
[Google Production Cluster (Borg/Kubernetes ancestor)]
Thousands of machines in a data center
Maglev: software load balancer (no hardware LBs — Google does everything in SW)
GWS (Google Web Server): custom HTTP server
Stubby: internal RPC framework (predecessor to gRPC)

        │
        ▼
[Cache Hierarchy]
L1: In-process cache on each web server (hot data: top 10,000 queries)
L2: Memcache cluster (shared across web servers)
L3: Bigtable (persistent NoSQL: user data, metadata)
L4: Colossus (distributed file system: large data, less frequent)

        │
        ▼
[Response: Brotli compressed, HTTP/2 Server Push for critical resources]

Key optimizations Google applies:
1. Speculative prefetch: while rendering, Google prefetches the likely next page
2. AMP (Accelerated Mobile Pages): pre-cached in Google's CDN before user clicks
3. DNS prefetch: Google's result page has <link rel="dns-prefetch"> for every result link
4. HTTP/2 multiplexing: logo, CSS, JS all load in same 1 RTT after HTML received
```

---

### Amazon — The Microservices Origin Story

Amazon's insight: **every component of a page is independently cacheable and deployable**. Their 2001 migration from monolith to microservices was forced by this insight.

```
Amazon product page (www.amazon.com/dp/B08L5TNJHG):

The page is assembled from 100+ independent microservices:
  - Product info service (title, price, images)
  - Review service (stars, reviews count, top reviews)
  - Recommendation service (customers also bought)
  - Inventory service (in stock? delivery date?)
  - Sponsored products service (paid placements)
  - Q&A service (customer questions)
  - ... 100+ more

Each service has its own cache TTL:
  Product price: Cache 5 minutes (price can change)
  Product title/images: Cache 24 hours (rarely changes)
  Review count: Cache 1 hour (updated periodically)
  Inventory: NO CACHE (real-time — don't show out-of-stock item as available)
  Recommendations: Cache 15 minutes (personalized per user segment, not per user)

FULL PAGE TIMEOUT RULE:
  If Recommendations service takes > 300ms: omit it, ship page without it
  If Reviews service fails: show "Reviews temporarily unavailable"
  User prefers a fast page missing one module over a slow complete page

  Pattern: Bulkhead + Graceful Degradation at page composition layer

Edge assembly (CloudFront Lambda@Edge):
  Some page fragments assembled at edge for personalization
  Different countries: prices in local currency, compliance differences handled at edge

AWS services behind amazon.com:
  Route 53: DNS
  CloudFront: static assets (product images, CSS, JS) — ~PB/day CDN traffic
  ALB: HTTP request routing
  EC2 Autoscaling + ECS: microservice fleets
  ElastiCache: session, recommendation caches
  DynamoDB: product catalog, cart, order state
  Aurora: financial transactions, order records
  S3: product images, JS/CSS assets
  SQS/SNS/EventBridge: between-service messaging
  X-Ray: distributed tracing across 100+ services
```

---

### Netflix — The Streaming Web Stack

Netflix's insight: **streaming video IS a web protocol**. Every segment is an HTTP GET. Their challenge: serve 700 petabytes/month from the cheapest and closest possible location.

```
Netflix Web Request Journey (User plays a movie):

Step 1: GET netflix.com (web app load)
  Route 53 → CloudFront → ALB → Node.js web tier (React SSR for SEO/first paint)
  TTFB target: < 200ms globally

Step 2: User logs in
  POST /login → ALB → Auth service (EVCache for session storage)
  EVCache = Netflix's custom Memcache-based distributed cache (multi-region)

Step 3: Home page personalization
  React UI queries: /api/home → API Gateway (Zuul) → Recommendation service
  Recommendation ML model (Apache Giraph → TensorFlow predictions)
  Personalized content list generated, cached for 5 minutes per user in EVCache

Step 4: User clicks Play
  GET /api/manifest/{movieId} → returns:
  {
    "masterPlaylist": "https://ipv4-aws1.1.nflxso.net/v1/...master.m3u8",
    "bitrateProfiles": ["4k", "1080p", "720p", "480p", "360p"],
    "encryptionKey": "https://licenses.netflix.com/...",
    "startPosition": 0
  }

Step 5: Video manifest fetch
  CDN URL → Netflix Open Connect Appliance (OCA) at local ISP (not AWS!)
  Netflix has 1,700+ cache appliances inside ISPs worldwide
  Popular titles pre-populated: "Stranger Things" is on EVERY OCA globally

  Manifest file (*.m3u8) cached on OCA → 1ms latency vs 50ms from cloud

Step 6: DRM License
  Each video chunk requires valid license key (Widevine/PlayReady/FairPlay)
  License server (AWS): validates user subscription → returns decryption key

Step 7: Adaptive video streaming
  Player (NPlayer Android, EPlayer iOS, custom) measures bandwidth every 500ms
  Selects appropriate quality tier: user on 150 Mbps fiber → 4K (25 Mbps)
  Every 2-second TS segment: GET https://isp-local-oca/v1/...seg001-4k.ts
  On OCA: < 1ms (already pre-loaded)
  On cache miss: OCA → AWS Regional cache → AWS Origin (S3 + MediaConvert output)

Key Netflix networking facts:
  Peak traffic: 700 Gbps at Netflix during evening prime time
  Open Connect absorbs 95% of that → only 5% hits AWS network
  AWS egress cost if they used CloudFront for all: ~$50M/month
  ISP-direct cost: far lower (OCAs are Netflix-owned hardware, ISPs host them for free peering)
```

---

## SECTION 6 — System Design Patterns in "How Web Works"

### Pattern 1: The Complete AWS Web Stack

```
User Request → AWS-Hosted Application

[Route 53]
  Purpose: DNS resolution (authoritative)
  Why AWS: health checks, latency-based routing, failover

[CloudFront CDN]
  Purpose: cache static assets + terminate TLS at edge + DDoS absorption
  Why: reduces origin load by 90%, cuts global TTFBs to < 20ms for static
  Config: S3 origin (static), ALB origin (dynamic)

[AWS WAF]
  Purpose: L7 filtering (OWASP rules, IP blocking, rate limiting)
  Sits at: CloudFront edge (blocks before any AWS resource is touched)

[ALB (Application Load Balancer)]
  Purpose: L7 HTTP routing (path-based, host-based)
  Health checks: removes unhealthy targets in < 10s
  Sticky sessions: optional (session affinity via cookie)
  HTTPS → HTTP internally: ALB terminates incoming TLS, talks HTTP to targets

[ECS Fargate / EC2 Auto Scaling]
  Purpose: stateless application tier
  IMPORTANT: stateless = no session stored in application process
  Session state in: ElastiCache (not in process)
  Scale: 2 → 200 tasks in minutes via target tracking (CPU 70% → scale out)

[ElastiCache Redis]
  Purpose: session store, frequently-read cache, rate limiting counters
  Mode: Cluster mode for horizontal scale
  Eviction: allkeys-lru (cache hot data automatically)

[Aurora MySQL/PostgreSQL]
  Purpose: source of truth for structured data (users, orders, products)
  Setup: Multi-AZ (primary + standby replica in different AZ) for HA
  Read replicas: 1-15 replicas for read-heavy workloads (product catalog reads)
  Proxy: RDS Proxy for connection pooling (Lambda & serverless)

[S3]
  Purpose: user uploads, static assets, backup, logs
  Lifecycle rules: Intelligent-Tiering for assets accessed unpredictably
  Versioning: enabled for user-uploaded critical files

[SQS / EventBridge]
  Purpose: decouple synchronous request from async side effects
  Pattern: user places order (sync: save to Aurora)
           → SQS message → (async: send email, update inventory, analytics)
  Benefit: order API returns immediately, side effects don't slow user experience

Complete request flow (e-commerce site):

  https://shop.example.com/product/123

  1. Route 53 A record → CloudFront distribution IP (anycast)
  2. CloudFront checks cache:
     /product/123 hit? YES → return HTML (max-age=300) → done in < 20ms
     MISS → continue
  3. WAF evaluates request: bot? SQL injection? rate limit exceeded?
     BLOCK → 403/429 to user
     PASS → forward to origin
  4. CloudFront → ALB (origin request)
  5. ALB → ECS target (round-robin or least connections)
  6. ECS task:
     Check ElastiCache: product:123 JSON cached?
       HIT → return from cache (< 1ms) → assemble HTML → respond
       MISS → query Aurora read replica:
               SELECT * FROM products WHERE id = 123;
               Store in ElastiCache with 5-minute TTL
               Assemble HTML → respond
  7. Response travels back: ECS → ALB → CloudFront (caches HTML) → User
  8. Browser renders, JS loads, React hydrates (interactive > 400ms)
```

### Pattern 2: CDN Hierarchy for Performance

The web is fast because of layered caching, each layer preventing the need for the next slower layer:

```
Layer 1: Browser Cache (fastest, ~0ms)
  DNS results: TTL from authoritative NS (e.g., 300s)
  HTTP resources: Cache-Control headers set by origin
  CSS/JS: immutable at hashed URLs → cached forever after first load

  Hit: user returns to same page → all resources already in browser
  → Page loads in < 50ms (only dynamic data needs fetching)
  Miss: first-ever visit to site → no browser cache

Layer 2: CDN Edge PoP (~3-10ms from user)
  Popular pages, product pages, API responses (TTL 30-300s)
  Static assets (TTL 1 year)

  Hit: someone in user's city recently visited this page → PoP has cached copy
  Miss: cold PoP (rare for popular content)

Layer 3: CDN Regional Cache (~15-30ms from user)
  Larger cache (1TB+ vs edge's 5TB SSD)
  Absorbs PoP misses

  Hit: content cached at regional level → PoP gets copy, both caches warm
  Miss: regional cache miss → origin request

Layer 4: Application Cache (ElastiCache, ~1-5ms from origin)
  DB query results, computed aggregations, session data
  In-memory → microseconds (0.3-1ms for Redis GET)

  Hit: saved DB query → sub-millisecond response
  Miss: DB query needed (50-200ms depending on query complexity and index usage)

Layer 5: Database (Aurora, ~5-50ms)
  Source of truth — always correct, never stale
  Only consulted on full cache miss chain

Cache hierarchy efficiency:
  For a popular product page:
    Layer 1 hit rate: 60% (returning browsers)
    Layer 2 hit rate: 35% of remaining → 35% × 40% = 14%
    Layer 3 hit rate: 3% of remaining → ...
    Layer 4 hit rate: 1.9% of remaining → ...
    Layer 5 (DB): < 1% of all requests

  = 1,000 users → 999 from cache → 1 DB query
  = Origin needs to serve 0.1% of traffic
```

### Pattern 3: Failure Modes and Their Web Symptoms

```
Failure Mode → User Symptom → Debugging Path

DNS failure (Route 53 health check fails, switches to backup):
  Symptom: Site unreachable for 30-60s then comes back
  Why: DNS TTL (e.g., 60s) → clients cached old IP for up to 60s
  Debugging: dig www.example.com (check which IP returns)
              nslookup www.example.com 8.8.8.8 (resolver check)
              Route 53: check health check results

TCP timeout (fire-and-forget SYN, no response):
  Symptom: Browser spins for 20-30s then shows "ERR_CONNECTION_TIMED_OUT"
  Why: SYN packets dropped (security group, NACL, crashed server, overloaded)
  Debugging: telnet target-ip 443 (direct TCP test)
              VPC Security Group: check inbound 443 allowed
              NLB/ALB: check target health (unhealthy target drops connections)

TLS certificate error:
  Symptom: Browser red padlock, "Your connection is not private" (NET::ERR_CERT_DATE_INVALID)
  Why: Certificate expired, wrong domain, self-signed, chain broken
  Debugging: openssl s_client -connect example.com:443 (check cert chain)
              ACM: check certificate expiry + renewal status
              CloudFront: check which cert is attached to distribution

5xx origin error:
  Symptom: "502 Bad Gateway" or "503 Service Unavailable"
  Why 502: CloudFront → ALB connection refused or invalid response from origin
  Why 503: ALB has no healthy targets (all ECS tasks OOMKilled or health check failed)
  Debugging: CloudFront: read 5xxErrorRate metric + origin error logs
              ALB: check target group health (Unhealthy targets)
              ECS: check task definitions, check CloudWatch Logs for crash reason

Slow TTFB (server-side bottleneck):
  Symptom: browser spins for 2+ seconds before any content
  Why: slow DB query, N+1 problem, missing cache, slow external API
  Debugging: Browser DevTools → Network tab → "Waiting (TTFB)"
              X-Ray: service map shows which downstream call is slow
              CloudWatch: check RDS Slow Query Log (> 1s queries)

High error rate + slowdown simultaneously (the cascade):
  Symptom: intermittent 504s, then 503s, then site down
  Pattern: Traffic spike → origin CPU high → requests queue → requests timeout
           → clients retry → more traffic → faster death spiral
  Debugging: CloudFront: requests + 5xxErrorRate increase together = origin overloaded
              Fix: CDN cache more aggressively, autoscaling group, circuit breaker
```

---

## SECTION 7 — AWS Mapping

### The Full AWS Web Stack Mapped

Every layer of a web request maps to AWS services:

```
NETWORK LAYER:
  Global Routing:   Route 53 (DNS) → latency-based paths globally
  CDN:              CloudFront → 450+ edge PoPs → static + semi-dynamic
  DDoS protection:  AWS Shield Standard (free) or Advanced ($3,000/mo)
  WAF:              AWS WAF → OWASP rules, rate limit, bot detection
  Private network:  AWS Global Accelerator → static anycast IPs + AWS backbone

LOAD BALANCING LAYER:
  HTTP/HTTPS apps:  ALB (Application Load Balancer) — L7 routing
  TCP/UDP / static IP: NLB (Network Load Balancer) — L4, low latency
  Smart routing:    CloudFront Cache Behaviors → different origins per path

COMPUTE LAYER:
  Containers:       ECS (Elastic Container Service) on Fargate (serverless)
  VMs:              EC2 Auto Scaling Groups
  Serverless:       Lambda (API Gateway→Lambda for serverless web APIs)
  Edge compute:     CloudFront Functions (viewer events) / Lambda@Edge (all events)

CACHING LAYER:
  In-memory:        ElastiCache Redis (cluster mode) or Memcached
  HTTP cache:       CloudFront + API Gateway cache (for HTTP responses)
  DB query cache:   ElastiCache (app manages cache keys manually)

DATABASE LAYER:
  Relational:       Aurora MySQL/PostgreSQL (Multi-AZ + read replicas)
  NoSQL:            DynamoDB (serverless, millisecond latency, infinite scale)
  Caching DB:       Redis (ElastiCache) — also used as primary DB for simple apps
  Search:           OpenSearch Service (ES-compatible: full-text search, facets)

OBJECT STORAGE:
  Static assets:    S3 (+ CloudFront in front for CDN delivery)
  User uploads:     S3 (presigned URLs for direct browser-to-S3 upload)

ASYNC PROCESSING:
  Task queue:       SQS (at-least-once; use DLQ for failed messages)
  Event bus:        EventBridge (event routing between services)
  Pub/Sub:          SNS (fan-out notifications to multiple SQS / Lambda)
  Streaming:        Kinesis Data Streams (replay, ordering, high throughput)

OBSERVABILITY:
  Tracing:          X-Ray (distributed traces across Lambda, ECS, RDS, DynamoDB)
  Metrics:          CloudWatch Metrics + CloudWatch Alarms
  Logs:             CloudWatch Logs + Log Insights (SQL-like queries)
  Dashboards:       CloudWatch Dashboards or Grafana (Amazon Managed Grafana)

SECURITY:
  Identity:         IAM (roles for services, not users)
  SSL certificates: ACM (free, auto-renewed, for CloudFront must be us-east-1)
  Secrets:          Secrets Manager (rotate DB passwords, API keys)
  Encryption:       KMS (key management for S3/RDS/Parameter Store)
  API protection:   API Gateway + Lambda authorizer or JWT authorizer

AWS reference architecture for a web app:

  Internet
     │
  Route 53 (DNS)
     │
  CloudFront (CDN + TLS + WAF)
     │ cache miss
  ALB (L7 load balancer)
     │
  ECS Fargate tasks (stateless app tier, 3-50 instances)
     │         │
  ElastiCache  Aurora PostgreSQL (Multi-AZ)
  (Redis)      + 2 Read Replicas
     │
  S3 (assets, uploads, backups)
     │
  SQS → Lambda workers (email, notifications, analytics)
```

### AWS CLI Commands for Web Debugging

```bash
# Test DNS resolution
dig www.example.com +short
nslookup www.example.com 8.8.8.8

# Check Route 53 health check status
aws route53 get-health-check-status --health-check-id <id>

# Test TCP connectivity
curl -v --max-time 10 https://www.example.com

# Measure all latency components
curl -w "\n
      namelookup: %{time_namelookup}s\n
              tcp: %{time_connect}s\n
              tls: %{time_appconnect}s\n
         pretransfer: %{time_pretransfer}s\n
        starttransfer: %{time_starttransfer}s\n
             total: %{time_total}s\n" \
     -o /dev/null -s https://www.example.com

# Check CloudFront cache hit rate (last 1 hour)
aws cloudwatch get-metric-statistics \
  --namespace AWS/CloudFront \
  --metric-name CacheHitRate \
  --dimensions Name=DistributionId,Value=ABCDE12345 \
  --start-time $(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 300 \
  --statistics Average

# Check ALB target group health
aws elbv2 describe-target-health \
  --target-group-arn arn:aws:elasticloadbalancing:...

# Check ECS service events (scaling, deployment issues)
aws ecs describe-services \
  --cluster production \
  --services web-service \
  --query 'services[0].events[:10]'
```

---

## SECTION 8 — Interview Q&As

### Beginner Questions

**Q1: What are the minimum network round trips needed to load a web page for the first time?**

A: For a user's first-ever visit to an HTTPS site, the minimum is:

1. **DNS lookup**: 1 RTT (to recursive resolver; may need 3 if cache cold: resolver + TLD + authoritative)
2. **TCP handshake**: 1 RTT (SYN → SYN-ACK → ACK, but data can be sent with the ACK)
3. **TLS 1.3 handshake**: 1 RTT (Client Hello → Server Hello+Cert+Finished → Client Finished)
4. **HTTP request**: 1 RTT (GET → response, assuming response fits in initial TCP window ~14KB)

Total: **3-5 RTTs** before first byte of HTML.

If London user to London PoP (CDN): 5ms RTT × 4 = 20ms. If London to New York origin without CDN: 80ms RTT × 4 = 320ms before HTML starts arriving. This is WHY CDN matters — it's not just caching, it's reducing each RTT.

Modern optimizations reduce this:

- DNS TTL (cached): 0 extra RTTs
- HTTP/2 (connection reuse): subsequent resource loads use existing TCP+TLS connection
- TLS 0-RTT session resumption: returning users save 1 RTT
- TCP Fast Open: saves TCP RTT on subsequent connections to same server

**Q2: Why does HTTPS add latency compared to HTTP, and how do modern CDNs minimize this?**

A: HTTPS adds the TLS handshake: at minimum 1 additional RTT (TLS 1.3) or 2 (TLS 1.2) before the HTTP request can be sent.

For London → New York (80ms RTT):

- HTTP: TCP 80ms + HTTP 80ms = 160ms to first byte
- HTTPS TLS 1.2: TCP 80ms + TLS 160ms + HTTP 80ms = 320ms (2× slower!)
- HTTPS TLS 1.3: TCP 80ms + TLS 80ms + HTTP 80ms = 240ms (50% better than TLS 1.2)

CDNs minimize HTTPS overhead 3 ways:

1. **TLS termination at the edge**: Instead of TLS all the way to New York, TLS terminates at the London PoP (5ms RTT). London user's TLS handshake = 5ms not 80ms. 16× faster. The CDN then connects to origin over a persistent, already-established TLS connection.

2. **Session resumption / 0-RTT**: CDN remembers TLS session state. Returning user's browser already has session ticket from last visit. TLS resumes in 0-RTT — no round trip needed for encryption setup.

3. **Connection pooling to origin**: CloudFront maintains persistent HTTP/2 connections to your ALB. Cache misses use an already-open connection — no TCP or TLS overhead on the origin path.

**Q3: What is TTFB and what does a high TTFB indicate?**

A: TTFB (Time to First Byte) is the time from sending the HTTP GET request until the first byte of the response arrives. In Web DevTools Network tab: it's labeled "Waiting (TTFB)".

TTFB = Network latency (request to server) + Server processing time + Network latency (response back)

Example: 500ms TTFB

- Could be: 250ms round-trip to origin + 0ms server processing (cached response)
- Could be: 10ms network + 480ms server processing (slow DB query)
- Could be: 10ms + 490ms N+1 problem (100 sequential DB queries)

High TTFB (> 500ms) indicates:

1. **Geographic problem**: Client is far from server, high RTT. Fix: CDN or multi-region.
2. **Server processing slow**: DB queries, cache misses, third-party API calls within request path. Fix: add caching, fix N+1, profile with X-Ray.
3. **DNS slowdown**: DNS resolution included in TTFB measurement in some tools. Fix: lower TTL → faster failover; or check DNS provider health.
4. **TCP slow**: Connection not reused (new TCP each request). Fix: ensure HTTP keep-alive / HTTP/2.

---

### Intermediate Questions

**Q4: Trace a request that results in a 504 Gateway Timeout. What does each component do?**

A: A 504 is Gateway Timeout — an intermediary (proxy/LB) gave up waiting for the upstream server.

```
User → CloudFront → ALB → ECS Task → Aurora DB
                    ↑          ↑           ↑
                    Where is the 504 generated?

Scenario: DB query hangs (table lock, full table scan, long transaction)

Timeline:
  T=0ms:    User sends GET /product/123
  T=10ms:   CloudFront → ALB (cache miss)
  T=15ms:   ALB → ECS task (forwards request)
  T=20ms:   ECS task → Aurora: "SELECT * FROM products WHERE..., JOIN reviews..."
  T=20ms:   Aurora query starts executing (table lock exists)
  T=29,000ms: ALB idle timeout (default: 60s, but API Gateway: 29s hard limit) —
              ALB closes connection to ECS task
  T=29,005ms: ALB → CloudFront: 504 response code
  T=29,010ms: CloudFront → User: 504 (or CloudFront's own error page if configured)

User sees: 504 Gateway Timeout after 29 seconds of spinning

Debugging trail:
  1. CloudFront logs: status=504 for that request URL
  2. ALB logs: target_status_code=504, request_processing_time → identify which target
  3. ECS CloudWatch Logs: see the DB query that was running (application log)
  4. Aurora Performance Insights: long-running queries, wait events (lock wait, I/O wait)
  5. Fix: add DB index, kill long transaction, add STATEMENT_TIMEOUT, cache this query

Other 504 causes:
  ECS task: OOMKilled mid-request → doesn't respond → ALB sees 504
  ECS task: Lambda cold start > 29s → API Gateway hard timeout → 504
  Aurora: failover in progress (60s) → all queries fail → 504 wave then recovery
```

**Q5: Why can two users get completely different page load times for the same URL?**

A: The same URL can load in 100ms for one user and 3,000ms for another. Every network layer introduces user-specific variability:

1. **Geographic distance to the nearest CDN PoP**: User in Frankfurt vs user in a small Pacific island. CDN PoP spacing can mean 5ms vs 200ms RTT.

2. **DNS resolution**: First-ever user (cache cold): 100ms. Browser-cached user: 0ms. Enterprise user on internal DNS proxy: 50ms extra hop.

3. **Browser cache state**: User who visited yesterday: browser has JS/CSS/images cached → page loads in 150ms. First-ever visitor: downloads everything → 1,500ms.

4. **CDN cache state**: User requests a just-invalidated CDN cache edge → cache miss → origin fetch (120ms extra). Next user at same edge: cache hit (2ms). Classic "cache stampede" effect.

5. **Last-mile connection**: 1 Gbps fiber vs 4G mobile (50ms RTT, packet loss, variable bandwidth). Mobile packet loss causes TCP retransmits = multiply RTT by retransmit count.

6. **TCP congestion window**: User's TCP path has shared bottleneck (busy ISP) → slow start never reaches full speed → large files slower.

7. **Device processing speed**: Low-end phone: JS parsing + execution 5× slower than desktop. Layout calculation on low-memory device slower.

8. **Regional origin capacity**: Single-region origin: London user (25ms) vs Tokyo user (200ms). Multi-region origin: equalizes.

For consistent global performance: CDN + multi-region origins + minimize JS bundle size (least processing variance) + minimize DNS TTL for fast switching.

**Q6: Design a healthcheck system that can detect web application problems before users do.**

A: Proactive health checking at every layer:

```
Layer 1: DNS Health Checks (Route 53)
  Route 53 Health Check: HTTP GET /health to origin every 30s
  If 3 consecutive failures: Route 53 fails over to backup region

  Alarm: Route 53 health check failure → SNS → PagerDuty (immediate)

  What the health endpoint checks:
    app.py:
    @app.route('/health')
    def health():
        checks = {}
        # DB check (< 50ms or fail)
        try:
            db.execute("SELECT 1")
            checks['db'] = 'ok'
        except: checks['db'] = 'fail'

        # Cache check
        try:
            redis.ping()
            checks['cache'] = 'ok'
        except: checks['cache'] = 'fail'

        # Downstream API check (optional)
        status = 200 if all(v == 'ok' for v in checks.values()) else 503
        return jsonify(checks), status

Layer 2: ALB Health Checks
  Health check: GET /health every 10s
  Healthy threshold: 2 consecutive 200s
  Unhealthy threshold: 3 consecutive non-200s → remove from target group
  Timeout: 5s (if app hangs > 5s, considered unhealthy)

  Result: unhealthy ECS task gets traffic drained in < 30s

Layer 3: CloudWatch Synthetic Canaries (Canary Monitoring)
  AWS CloudWatch Synthetics: headless browser runs your real user flow every 5 minutes
  Script:
    1. GET / (home page load)
    2. Search "laptop"
    3. Click first result
    4. Add to cart
    5. Check cart has item
  Measures: real latency for full user journey (not just /health)

  Alarm: canary fails → "user-facing checkout broken" → highest priority alert

  Why: /health endpoint might return 200 while the checkout page has a JS error
       Canary catches user-facing issues /health misses

Layer 4: CloudWatch Metrics Alarms
  Key metrics to alarm on:
    HTTPCode_ELB_5XX_Count > 10/min → application errors
    TargetResponseTime p99 > 2s → latency spike
    HealthyHostCount < 2 → scale-in too aggressive
    CacheHitRate < 40% → CDN effectiveness dropped (misconfiguration?)

Layer 5: Real User Monitoring (RUM)
  CloudWatch RUM: JavaScript snippet on your page measures REAL user timing:
    DNS resolution: window.performance.timing.domainLookupEnd - domainLookupStart
    TCP+TLS: connectEnd - connectStart
    TTFB: responseStart - navigationStart
    Page load: loadEventEnd - navigationStart

  Value: synthetic monitoring shows p50; RUM shows p95/p99 of real users
  When they diverge: investigate CDN-specific issues (synthetic tests same region; users everywhere)
```

---

### Advanced System Design Questions

**Q7: How does a major e-commerce site handle Black Friday — 50× normal traffic in 30 minutes?**

A: Black Friday is the system design final exam. Normal traffic: 10,000 req/s. Black Friday peak: 500,000 req/s in under 30 minutes from midnight.

```
Step 1: Pre-warm everything (before the event)

CDN cache warming:
  Run crawler before midnight: fetch every product page, category page
  → CDN PoPs globally have cache populated
  → First Black Friday request: Cache HIT (not origin hit)

  aws cloudfront create-invalidation... (force fresh cache before event)
  Then warm: for url in product_urls: requests.get(url, headers={'Origin': 'https://shop.com'})

Auto Scaling pre-warm:
  ECS Service: Desired=20 tasks normally → pre-scale to 100 tasks at T-1h
  Why: cold ECS task start time ~60s (pull image, start container, pass health check)
  Can't scale 100 tasks in 30 seconds during the spike → pre-scale before

RDS: promote a read replica to reduce write-replica read load
ElastiCache: pre-warm popular product cache entries
Lambda concurrency: increase reserved concurrency for event-critical functions

Step 2: Cache EVERYTHING cacheable (accept slight staleness)

Normal day:
  Product price: Cache 5 minutes
  Inventory count: NOT cached (real-time)

Black Friday mode (toggle via feature flag):
  Product price: Cache 5 minutes (same — price changes are intentional)
  Inventory count: Cache 30 seconds (acceptable staleness — shows "2 left!" not "0 left!")
  → Reduces DB reads by 99% just from inventory caching

  Feature flag (AWS AppConfig): toggle stale-inventory-cache = ON at T-1h
  Toggle off after event

Step 3: Degrade gracefully under overload

Circuit breaker (per downstream):
  Recommendation service: if > 500ms p99, return empty recommendations (don't fail page)
  Review service: if failing, show "Reviews unavailable"
  Payment options (PayPal): if timeout, hide PayPal option (show card only)

  Core path protected: Browse → Add to Cart → Pay (never degraded)

FIFO queue for checkout:
  1M checkouts in 60 minutes = 16,666/s → DB can handle ~1,000 ACID writes/sec
  Pattern: checkout → SQS FIFO → Lambda consumer → DB (controlled rate)
  User sees "Order being processed" screen (async confirmation within 5s)
  Prevents DB overload from synchronized checkout burst

Step 4: Observe and react

CloudWatch dashboard (all metrics on one screen):
  ECS CPU/Memory, ALB request rate + 5xx rate, DB connections, cache hit rate

Alarm thresholds lower during event: 5xx > 5 (not normal 10) → page engineer immediately

Auto scaling policies aggressive:
  ALB RequestCountPerTarget > 300 → scale out (add 10 tasks) in 60s
  ECS CPU > 70% → scale out immediately (don't wait for 75%)
  EC2 Spot is fine for ECS tasks — they're stateless; spot interruption = gracefully drained

Result (typical well-prepared e-commerce):
  50× traffic handled with 3× infrastructure (CDN absorbs >90% of traffic)
  DB never overloaded (cache hit rate 99% on product reads)
  Checkout: slight queueing during peak minute (acceptable: "processing" screen)
  Revenue: captured, not lost to errors
```

**Q8: What happens when the URL you type is a new, never-seen domain? Trace through cold DNS, cold CDN, cold cache end-to-end.**

A: Worst case: SSL certificate first-time validation, no cached DNS, cold CDN, cold application cache.

```
URL: https://brand-new-startup.com/product/new-product
(Launched 1 minute ago. Nobody has visited. CDN cold. DNS just configured.)

T+0ms: User presses Enter

T+0ms: Browser cache: MISS (never visited)
T+0ms: OS cache: MISS
T+1ms: Query ISP recursive resolver → recursive cache: MISS
T+5ms: Recursive → Root NS: "who handles .com?" → response: j.gtld-servers.net
T+15ms: Recursive → j.gtld-servers.net: "who handles brand-new-startup.com?"
         → response: ns1.amazondns.com (Route 53 NS records)
T+25ms: Recursive → ns1.amazondns.com: "A record for brand-new-startup.com?"
         → Response: CloudFront distribution IP (e.g., 54.182.0.1), TTL=60s
T+25ms: DNS resolution complete: 25ms total (all cache cold)

T+26ms: TCP SYN to 54.182.0.1 (CloudFront edge PoP nearest to user)
         Let's say nearest PoP is 10ms away
T+36ms: SYN-ACK received (10ms RTT)
T+37ms: ACK sent. TCP established.

T+37ms: TLS ClientHello → CloudFront PoP
         NEW certificate for brand-new-startup.com:
         OCSP check: required before serving cert (is cert revoked?)
         OCSP stapling: if server included OCSP staple in handshake: no extra RTT
         Without stapling: browser sends OCSP request to CA's OCSP server → +50ms
         Assume OCSP stapled: no extra RTT

T+47ms: ServerHello+Certificate+Finished received
         Browser: verify cert chain (Root CA → Intermediate → brand-new-startup.com)
         Check: expiry valid, SAN matches, CA in trust store → OK
T+48ms: ClientFinished sent. Symmetric keys derived. TLS established.

T+48ms: HTTP/2 GET /product/new-product
T+58ms: CloudFront checks edge cache: product/new-product → MISS (cold cache)
T+58ms: CloudFront checks Origin Shield: MISS (cold)
T+58ms: CloudFront → origin: ALB in us-east-1 (assume 80ms RTT from PoP → AWS origin)
T+138ms: Request reaches ALB
T+139ms: ALB → ECS task (new deploy, first request)
          ECS task checks ElastiCache: product:new-product → MISS (cold)
          ECS task → Aurora: SELECT * FROM products WHERE slug = 'new-product'
          Cold query plan: full table scan (no warm plan cache)
T+289ms: Aurora returns product data (150ms for cold query)
          ECS stores in ElastiCache (TTL=300s)
          ECS assembles HTML
T+320ms: Response to ALB → CloudFront PoP (80ms return)
T+400ms: CloudFront PoP: caches HTML (s-maxage=60s!)
T+400ms: First byte received at browser (TTFB = 400ms)

T+415ms: Full HTML received (15ms download)
T+420ms: Browser issues resource requests (JS, CSS, images) —
          ALL COLD cache on CDN!
          JS/CSS: 80ms RTT × 2 per file = 160ms each (cold CDN)
          HTTP/2 multiplexing: all parallel, so total delay = worst file time

T+600ms: All assets received (parallel fetch)
T+650ms: DOM + CSSOM complete
T+700ms: First Contentful Paint (FCP: 700ms — much later than warm cache)
T+900ms: Fully Interactive (JS executed)

Second user (visits 30 seconds later):
  DNS: 2ms (cached by ISP resolver for 60s)
  TCP: 10ms (reuses connection if HTTP/2 keep-alive)
  TLS: 0ms (session resumption)
  CloudFront: HIT for HTML (60s TTL from first user)!
  CloudFront: HIT for JS/CSS (1-year TTL from hashed filenames)!
  TTFB: 10ms (edge cache hit)
  FCP: 200ms total

  = 700ms → 200ms: 3.5× faster just from cache warming by the first visitor
```

---

## File Summary

This file covered:

- Google's web architecture: GFE edge PoPs, private backbone, Maglev LB, layered caches (in-process → Memcache → Bigtable)
- Amazon: 100+ microservices per product page, per-service TTLs, graceful degradation on service failure, bulkhead pattern
- Netflix: Open Connect Appliances at ISPs (95% traffic bypasses AWS), EVCache, DRM at request time, ABR streaming
- Complete AWS web stack: Route 53 → CloudFront → WAF → ALB → ECS Fargate → ElastiCache → Aurora → S3 → SQS/EventBridge
- Cache hierarchy: Browser (0ms) → CDN PoP (3ms) → Regional Cache (20ms) → ElastiCache (1ms) → Aurora (50ms); 1% of requests hit DB
- Failure mode analysis: DNS failure, TCP timeout, TLS cert error, 5xx origin cascade, TTFB spikes with debugging playbooks
- AWS CLI debugging commands: dig, curl -w timing, cloudwatch metrics, ALB target health, ECS events
- 8 Q&As: minimum RTTs (3-5), HTTPS latency and CDN mitigation, TTFB causes, 504 debugging, user variability sources, proactive health checks, Black Friday 50× traffic handling, cold cache end-to-end trace

**Continue to File 03** for AWS SAA exam synthesis, 5 master comparison tables, complete Quick Revision, and the ultimate Architect Exercise: "Design google.com on AWS."
