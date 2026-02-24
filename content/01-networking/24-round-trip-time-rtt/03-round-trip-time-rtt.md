# Round Trip Time (RTT) — Part 3 of 3

### Topic: AWS SAA Exam Focus, Comparison Tables, Quick Revision, Architect Exercise

**Series:** Networking Fundamentals → System Design → AWS Solutions Architect
**Sections Covered:** 9, 10, 11, 12

---

## SECTION 9 — AWS SAA Certification Focus

### AWS SAA Exam Traps Around RTT and Latency Routing

```
TRAP 1: Route 53 Latency-Based Routing ≠ Geolocation Routing

  Scenario: "European users should be served from eu-west-1"

  Geolocation routing: routes based on WHERE the user IS (their IP's country/region)
    European IP → EU record
    Asian IP → Asia record
    Use for: data residency compliance, legal restrictions, language-specific content
    Does NOT guarantee lowest latency (a UK user might have lower RTT to us-east-1 than eu-west-1 for some ISPs)

  Latency-based routing: routes based on MEASURED RTT to each AWS region
    Route 53 measures RTT from regions to user IP blocks
    Same UK user → if us-east-1 is actually 30ms but eu-west-1 is 80ms (edge case) → gets us-east-1
    Use for: performance optimization regardless of geography

  Exam tip: "I want the BEST performance globally" → Latency-Based
  Exam tip: "I want EU users' data to STAY in EU (GDPR)" → Geolocation

TRAP 2: Global Accelerator static IPs vs CloudFront dynamic IPs

  Global Accelerator: 2 static Anycast IP addresses, always the same
  CloudFront: DNS-based (CNAME to xxxx.cloudfront.net), IPs can change

  Scenario: "On-premises firewall whitelists specific IP addresses for our API"
    Wrong: CloudFront (IPs change, whitelist breaks)
    Correct: Global Accelerator (static IPs, whitelist works forever)

  Scenario: "Store images and serve globally with low RTT"
    Wrong: Global Accelerator (no caching)
    Correct: CloudFront (caches at 450+ PoPs, reduces origin RTT to edge RTT)

TRAP 3: RTT-related timeouts

  API Gateway max timeout: 29 seconds (non-negotiable hard limit)

  "Lambda function processes data and takes 60 seconds maximum, called via API Gateway"
  → Impossible: API Gateway will send 504 after 29 seconds
  Solution: return 202 Accepted immediately, use async SQS + polling

  ALB idle timeout default: 60 seconds
  Lambda max execution: 15 minutes
  ECS task stop timeout: 30 seconds
  CloudFront origin timeout: 30 seconds (configurable 1-60s)

  Scenario: "Users report 504 errors from CloudFront for large file uploads"
    → CloudFront origin timeout too low for slow uploads
    Solution: increase CloudFront origin response timeout (max 60s)
    Or: use S3 presigned URLs (bypass CloudFront for uploads → direct to S3)

TRAP 4: Health check timing and RTT

  Route 53 health checks: check interval 10s or 30s; failure threshold 1-10
  Recovery time = check_interval × failure_threshold

  "Need DNS failover within 30 seconds"
    → Configure: 10s interval, 1-3 failure threshold = fails in 10-30s

  Route 53 + ALB health check: ALB health check to targets (2-12 checks × 5-30s interval)
    ALB marks unhealthy → Route 53 health check sees ALB endpoint fail → DNS failover

  Potential gap: ALB takes: 3 checks × 30s = 90s to mark unhealthy
    THEN Route 53 detects: 3 checks × 30s = 90s
    Total failover: up to 180s!

  For fast failover: tighten both health check intervals and thresholds
    ALB: unhealthy threshold 2, interval 5s = 10s to mark unhealthy
    Route 53: 10s interval, 1 failed check = 10s detection
    Total: ~20s failover

TRAP 5: CloudFront RTT metrics (TimeToFirstByte in access logs)

  CloudFront logs include: time-taken (total), x-edge-response-result-type (Hit/Miss/RefreshHit)

  Analysis: cache miss x-edge-response-result-type = Miss → higher RTT (includes origin call)
  Analysis: cache hit = Hit → lower RTT (served from edge only)

  "Why does CloudFront sometimes have high TTFB even for cached content?"
  → cache HIT TTFB should be 5-20ms
  → Possible causes: ResponseHeadersPolicy adding headers (Lambda@Edge adding latency),
     Origin Shield (extra 1 middle-cache tier) adding RTT on miss, Shield RTT adds 20-30ms

  Origin Shield: optional middle tier between CloudFront PoPs and origin
    Reduces origin RTT by ~60% (fewer unique cache misses reach origin)
    But adds 20-30ms on cache miss (extra hop through Shield PoP)
    Trade-off: fewer origin calls vs slightly higher miss latency
```

### Critical RTT Reference: Protocol Overhead by Scenario

```
Scenario: User first visit (new connection, no cache):
  DNS (no cache): 1 RTT
  TCP: 1 RTT (SYN, SYN-ACK, ACK — the ACK can carry HTTP data in same packet)
  TLS 1.3: 1 RTT (ClientHello → ServerHello+Cert+Finished)
  HTTP GET: 1 RTT
  Total: 4 RTTs

  With CDN edge (5ms RTT): 4 × 5ms = 20ms
  Without CDN (150ms RTT): 4 × 150ms = 600ms

Scenario: User returning (keep-alive connection, TLS session ticket):
  DNS: 0 RTT (OS cache)
  TCP: 0 RTT (keep-alive)
  TLS: 0 RTT (session resumption)
  HTTP GET: 1 RTT
  Total: 1 RTT

  With CDN (5ms): 5ms
  Without CDN (150ms): 150ms

Scenario: WebSocket connection (after setup):
  Per-message RTT: 0 RTT for server push (fire and forget from server side)
  Client sends message: 1 RTT until server receives + ACK

Exam: RTT of a single HTTP request over an established HTTP/2 connection:
  1 RTT (the HTTP frame is the only overhead once connection is open)
```

---

## SECTION 10 — Comparison Tables

### Table 1 — RTT by Connection Type and Optimization

| Connection State                         | DNS | TCP | TLS | HTTP | Total RTTs | Time (5ms RTT) | Time (150ms RTT) |
| ---------------------------------------- | --- | --- | --- | ---- | ---------- | -------------- | ---------------- |
| First visit, new connection, TLS 1.2     | 1   | 1   | 2   | 1    | 5          | 25ms           | 750ms            |
| First visit, new connection, TLS 1.3     | 1   | 1   | 1   | 1    | 4          | 20ms           | 600ms            |
| Return visit, keep-alive, session resume | 0   | 0   | 0   | 1    | 1          | 5ms            | 150ms            |
| Return visit, HTTP/3 QUIC, 0-RTT         | 0   | N/A | 0   | 1    | 1          | 5ms            | 150ms            |
| Return visit, HTTP/3 QUIC, 0-RTT (data)  | 0   | N/A | 0   | 0    | 0.5        | ~2.5ms         | ~75ms            |
| WebSocket (per message after setup)      | 0   | 0   | 0   | 0.5  | 0.5        | ~2.5ms         | ~75ms            |

---

### Table 2 — RTT by AWS Region Pair (approx. real-world ping)

| Region Pair                     | Distance  | Typical RTT |
| ------------------------------- | --------- | ----------- |
| us-east-1 ↔ us-east-1 (same AZ) | <10km     | 0.1–1ms     |
| us-east-1 ↔ us-east-1 (diff AZ) | 10–100km  | 1–5ms       |
| us-east-1 ↔ us-west-2           | ~4,500km  | 60–80ms     |
| us-east-1 ↔ eu-west-1           | ~5,700km  | 70–90ms     |
| us-east-1 ↔ eu-central-1        | ~7,000km  | 90–110ms    |
| us-east-1 ↔ ap-southeast-1      | ~15,300km | 170–200ms   |
| us-east-1 ↔ ap-northeast-1      | ~13,600km | 150–180ms   |
| eu-west-1 ↔ ap-southeast-1      | ~10,800km | 130–160ms   |
| us-west-2 ↔ ap-southeast-1      | ~9,700km  | 130–160ms   |
| us-east-1 ↔ sa-east-1           | ~7,700km  | 100–140ms   |

---

### Table 3 — RTT Impact on System Design Choices

| RTT Range     | Typical Scenario               | Design Choice                                  | Protocol        |
| ------------- | ------------------------------ | ---------------------------------------------- | --------------- |
| < 5ms         | Same AZ, CDN edge              | Synchronous microservices OK                   | HTTP/gRPC       |
| 5–30ms        | Same region diff AZ, local CDN | Synchronous OK, pool connections               | HTTP/2, gRPC    |
| 30–80ms       | Same continent (EU-EU, US-US)  | Minimize round trips, use HTTP/2               | HTTP/2 priority |
| 80–200ms      | Intercontinental               | CDN mandatory for web, async for writes        | CDN + WebSocket |
| 200ms+        | Global edge cases              | Multi-region active-active, async everywhere   | Event-driven    |
| 300ms–seconds | Satellite                      | Custom protocols, large pre-fetch, compression | QUIC, custom    |

---

### Table 4 — AWS Service RTT and Throughput Characteristics

| Service                          | RTT (same-AZ call)                | Notes                                             |
| -------------------------------- | --------------------------------- | ------------------------------------------------- |
| ElastiCache Redis (GET)          | 0.3–1ms                           | Sub-ms, fastest in-memory option                  |
| DynamoDB (GetItem, on-demand)    | 1–5ms                             | Single-digit ms SLA                               |
| DynamoDB DAX                     | 0.3–1ms                           | Microsecond cache in front of DynamoDB            |
| RDS Aurora MySQL (simple query)  | 2–10ms                            | Depends on query complexity                       |
| RDS PostgreSQL (complex query)   | 5–50ms                            | Index coverage determines this                    |
| Lambda → Lambda (sync)           | 5–20ms                            | Includes Lambda invoke overhead                   |
| API Gateway → Lambda             | 5–15ms (warm) / 200–2000ms (cold) | Cold start dominant                               |
| SQS SendMessage                  | 2–10ms                            | Eventual delivery; producer sees fast ACK         |
| SNS Publish                      | 1–5ms                             | Fan-out async, producer latency is send time only |
| S3 GetObject (small, HDD class)  | 5–30ms                            | First byte; large objects then stream             |
| S3 GetObject (small, S3 Express) | 1–5ms                             | Single-AZ, ultra-low latency S3 class             |

---

### Table 5 — RTT Optimization Techniques and Their Impact

| Technique                         | RTT Reduction                           | Complexity                  | AWS Service         |
| --------------------------------- | --------------------------------------- | --------------------------- | ------------------- |
| CDN for static assets             | 150ms → 5ms (30×)                       | Low                         | CloudFront          |
| CDN for API responses (short TTL) | 150ms → 5ms (30×)                       | Medium (cache invalidation) | CloudFront          |
| HTTP/2 keep-alive                 | 4 RTTs → 1 RTT per extra request        | Low (server config)         | ALB, CloudFront     |
| TLS 1.3 (vs 1.2)                  | 2 RTT TLS → 1 RTT (save 1 RTT per conn) | Low (cert/config)           | ACM + ALB           |
| TLS 0-RTT session resumption      | 1 RTT → 0 RTT (on reconnect)            | Low (session tickets on)    | TLS 1.3 default     |
| Connection pool (DB)              | 2ms per query overhead → 0ms            | Medium                      | HikariCP, PgBouncer |
| Redis pipeline (batch commands)   | N × 1ms → 1ms total for N commands      | Medium                      | ElastiCache         |
| GraphQL/BFF (API batching)        | 4 RTTs → 1 RTT                          | High (API redesign)         | API Gateway custom  |
| Global Accelerator                | 200ms → 100ms (30–50% on backbone)      | Low                         | Global Accelerator  |
| Route 53 Latency-Based Routing    | Routes to minimum-RTT region            | Low                         | Route 53            |
| QUIC / HTTP/3                     | 2 RTT → 0 RTT on return                 | Low (enable on CloudFront)  | CloudFront          |

---

## SECTION 11 — Quick Revision

### 10 Key Points

1. **RTT = 2 × one-way latency.** It measures the time for a message to travel to a destination AND return. Every protocol step costs at least 1 RTT.

2. **Physics sets the minimum.** Speed of light in fiber ≈ 200,000 km/s. NY-London minimum one-way = 30ms. RTT cannot be less than ~60ms for NY-London regardless of hardware.

3. **First HTTPS visit = 4 RTTs:** DNS + TCP + TLS 1.3 + HTTP. On a 150ms RTT link: 600ms before user sees first byte, even if server responds in 1ms.

4. **HTTP/2 keep-alive converts N RTTs to 1 RTT** for subsequent requests. Maintaining the connection eliminates DNS, TCP, and TLS overhead for every request beyond the first.

5. **QUIC/HTTP3 = 1 RTT new, 0 RTT returning.** Connection ticket from prior session eliminates all setup overhead for returning users. Mobile network switches (WiFi → 4G) don't restart the connection.

6. **TCP throughput = Window / RTT.** Default 64KB window on a 200ms RTT link = only 2.6 Mbps, even on a 1 Gbps fiber. High-bandwidth long-distance links need large TCP windows.

7. **CDN is the single most impactful RTT optimization.** Reduces 150-200ms RTT to 1-10ms for both TCP setup and HTTP requests. Converts origin RTT to edge RTT.

8. **API round trips accumulate.** 1 API call at 150ms RTT = 150ms. 10 sequential API calls at 150ms RTT = 1,500ms. Combine calls (GraphQL, BFF, compound documents) to minimize RTTs.

9. **Same-AZ database matters for every query.** Cross-AZ = 5ms RTT per query. 10 queries = 50ms overhead. Cross-region DB = 70ms RTT per query. 10 queries = 700ms overhead.

10. **Tail latency (p99) is often an RTT problem.** TCP retransmits (200ms+ backoff), DNS cold misses (200ms), Lambda cold starts (200-2000ms), DB pool exhaustion (seconds) — all manifest as RTT spikes in the 1% of bad requests.

---

### 30-Second Concept Explanation

> "RTT is the round trip time — how long it takes for a packet to go from your computer to a server and come back. It's governed by physics: light travels at 200,000 km/s in fiber, so New York to London is at least 60ms round trip regardless of hardware. What makes RTT expensive is that it multiplies: loading a secure webpage requires DNS, then TCP, then TLS, then HTTP — that's 4 round trips before any content arrives. At 150ms RTT: 4x150ms = 600ms. CDN servers close to users reduce this to 4x5ms = 20ms — that's a 30x improvement from geography alone. Every sequential API call, every database query, every microservice hop adds RTT. The optimization strategy is simple: reduce the distance, reduce the number of round trips, reuse connections."

---

### Mnemonics

**"DTTH": DNS, TCP, TLS, HTTP — The 4 RTTs to First Byte**

```
D = DNS        (1 RTT — resolve the IP address)
T = TCP        (1 RTT — SYN, SYN-ACK, ACK)
T = TLS 1.3    (1 RTT — ClientHello, ServerHello+Cert+Finished)
H = HTTP GET   (1 RTT — GET /page, 200 OK response)
= 4 RTTs total for first visit

With CDN (5ms): 4×5ms = 20ms
Without CDN (150ms): 4×150ms = 600ms
```

**"WOR": Window Over RTT = Throughput**

```
Throughput = Window / RTT
W = Window size (bytes)
O = Over (divided by)
R = RTT (seconds)
→ BIG window + SMALL RTT = HIGH throughput
→ CDN = small RTT → high throughput
```

**"KIAS": Keep connections, Inline CSS, Avoid sequential, Shorten distance**

```
K = Keep TCP connections alive (HTTP/2 + keep-alive)
I = Inline critical CSS (removes 1 RTT for CSS fetch)
A = Avoid sequential round trips (batch APIs, GraphQL)
S = Shorten distance (CDN, multi-region, co-location)
→ These 4 techniques cover 90% of RTT optimization work
```

---

## SECTION 12 — Architect Thinking Exercise

### Problem Statement

You're a Solutions Architect at a logistics company. Their tracking system has a major problem:

**Current behavior:** Drivers update package status from their mobile app. The status change appears in the customer app in **45 seconds on average** (customers are constantly refreshing and complaining).

**Root cause investigation reveals:**

- Driver app polls every 30 seconds: `GET /api/status/{driverId}`
- Mobile to API server: 180ms RTT (drivers in rural areas → 3G network, high RTT)
- API server queries DynamoDB for driver location every poll
- Customer polling: every 5 seconds: `GET /api/packages/{packageId}`
- Customer to server: 50ms RTT (urban users, good connectivity)
- Server to DynamoDB: 3ms RTT (same region)

**The math:**

- Driver updates every 30s. Customer polls every 5s.
- Average staleness = driver update interval / 2 = 15 seconds
- Plus: customer poll happens 0-5s after driver update = average 7.5s customer delay
- Total average visible delay = 15s + 7.5s = **22.5 seconds** (not 45 — where is the extra 22.5s?)

**What's adding the hidden 22.5 seconds?**

**Your task:** Find the root cause of the extra 22.5 seconds AND redesign the system for < 5 seconds update propagation globally.

---

_(Investigate the hidden delay before reading the solution)_

---

### Solution

**Hidden delay: API caching is set too aggressively!**

```
Discovery: CloudFront cache on the customer tracking API:
  Cache-Control: max-age=30 (30 second TTL set by developer "to reduce server load")

  Impact on freshness:
    Driver updates at T=0
    CloudFront edge still serves T=-30s cached version
    CloudFront TTL expires at T=30
    CloudFront fetches from origin at T=30+
    Customer poll after T=30: gets fresh data

  Average staleness from CloudFront cache alone:
    Customers hitting the cache anytime: 0-30 seconds stale
    Average: 15 seconds from CloudFront TTL

  Combined staleness:
    Driver update interval: avg 15s (driver polls every 30s)
    CloudFront TTL: avg 15s (up to 30s TTL → 15s avg)
    Customer poll: avg 2.5s (polls every 5s)
    Total: 15 + 15 + 2.5 = 32.5s average (closer to the reported 45s with variance)

The fix must address BOTH: driver update frequency AND CloudFront caching.
But the real redesign should eliminate polling entirely.
```

**Redesigned Architecture (< 5 second propagation):**

```
CHANGE 1: Driver → Real-time push (replace 30s polling with WebSocket)
  Driver app: maintain WebSocket/MQTT connection to server
  On driver location change: push event immediately (< 100ms of driver action)

  AWS IoT Core: handles millions of MQTT connections (mobile-optimized)
    iOS maps apps → MQTT → IoT Core → Rule → Lambda → DynamoDB
    Driver update latency: 200ms (RTT on 3G) + 50ms server = 250ms total

  Key change: 30-second delay eliminated → 250ms update

CHANGE 2: Customer → Server-Sent Events (replace 5s polling with SSE push)
  Customer app: connects to SSE endpoint: GET /api/packages/{packageId}/stream
  Server maintains connection, pushes events when status changes

  ALB + ECS EventSource endpoint:
    const eventSource = new EventSource('/api/packages/PKG123/stream');
    eventSource.onmessage = (e) => updateUI(JSON.parse(e.data));

  Server architecture: ECS container publishes updates via Redis Pub/Sub
    DynamoDB → DynamoDB Streams → Lambda → Redis Pub/Sub
    SSE server: subscribed to Redis channel for package → pushes to customer
    Customer update latency: 50ms (RTT push to customer)

  Key change: 7.5-second average customer poll delay → 50ms push

CHANGE 3: Fix CloudFront caching for tracking data
  Dynamic endpoint (package status): Cache-Control: no-store  OR short-TTL
  Send Cache-Control: max-age=0, no-cache for tracking endpoints
  (Essentially: don't cache real-time data!)

  Static endpoints (driver list, package metadata): Cache-Control: max-age=60 (ok to cache)

End-to-end flow:
  Driver → IoT Core MQTT (250ms) → Lambda → DynamoDB (5ms) → DynamoDB Streams
    → Lambda (100ms processing) → Redis Pub/Sub (1ms) → ECS SSE server (1ms)
    → SSE push to customer (50ms)

  Total propagation: ~400ms (vs 45 seconds before!)

  Is < 5 seconds met? 400ms << 5 seconds ✓
```

**Cost considerations:**

```
IoT Core: $0.08 per million MQTT messages
  1,000 drivers × 1 update/minute = 1,440,000 messages/day × $0.08/M = $0.12/day

ECS SSE fleet: small (SSE connections are cheap, mostly idle)
  2 ECS tasks (t3.small, $0.021/hr each) = $30/month

Redis Pub/Sub: ElastiCache cache.t3.micro = $15/month

DynamoDB Streams + Lambda:
  1,440,000 events/day → Lambda processes → $0.002/1M invocations × 1.44M = $0.003/day

Total additional cost: ~$50/month for < 5s real-time propagation vs 45s polling
Previous polling cost: 1000 drivers × 2 polls/minute × 60min × 24h × 365 days
  = 1.05 billion API Gateway requests/year × $3.50/million = $3,675/year

Net savings: reduced API Gateway load (polling eliminated), cheaper total system
```

**Architecture diagram:**

```
Driver (Mobile, 3G, 180ms RTT)
  │── MQTT ──────────────────────────► AWS IoT Core
  │                                       │
  │                                    Lambda (process update)
  │                                       │
  │                                    DynamoDB (write location)
  │                                       │
  │                                    DynamoDB Streams
  │                                       │
  │                                    Lambda (fan-out)
  │                                       │
  │                              Redis Pub/Sub (channel: PKG123)
  │                                       │
  │                                    ECS SSE Server
  │                                       │
Customer (Mobile/Web, 50ms RTT) ◄── SSE push (< 100ms from Redis)
```

**Key architectural lessons:**

1. **Polling = RTT × poll interval overhead**. 30s driver poll + 5s customer poll + 30s cache = 65s worst case. Polling is inherently stale.

2. **Push-based architecture eliminates polling RTT entirely.** Events flow from driver → customer in < 500ms end-to-end.

3. **Caching and real-time are opposites.** Always set `Cache-Control: no-store` or near-zero TTL for data that must be fresh.

4. **IoT Core handles high-RTT mobile connections natively.** Designed for unreliable mobile networks with reconnection and QoS levels.

5. **SSE is simpler than WebSocket for server-to-client only.** No bidirectional needed → SSE is lighter and more proxy-friendly.

---

## Quick Reference Card

```
RTT formulas:
  RTT = 2 × one-way latency
  TCP Throughput = Window_bytes / RTT_seconds
  BDP = Bandwidth × RTT (bytes needed in flight to fill pipe)

Protocol RTT costs:
  DNS: 1 RTT (or 3-5 for recursive)
  TCP: 1 RTT
  TLS 1.3: 1 RTT (new), 0 RTT (resume)
  TLS 1.2: 2 RTT
  HTTP/1.1: 1 RTT per request
  HTTP/2 keep-alive: 1 RTT total for first, 0 for multiplexed
  QUIC: 1 RTT (new), 0 RTT (returning)
  First HTTPS: 4 RTTs total (DNS+TCP+TLS1.3+HTTP)

RTT ranges (AWS):
  Same AZ: 0.1–1ms
  Cross-AZ: 1–5ms
  US cross-region: 60–80ms
  US-EU: 70–100ms
  US-Asia: 150–200ms

Key AWS services for RTT reduction:
  CloudFront: 150ms origin → 5ms edge (30× improvement)
  Global Accelerator: 200ms internet → 100ms backbone (2× improvement)
  Route 53 Latency-Based: routes to minimum-RTT region automatically
  ElastiCache: DB 50ms → Redis 0.5ms (100× improvement for reads)
```
