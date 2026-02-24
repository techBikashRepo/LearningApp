# Request-Response Lifecycle — Part 2 of 3

### Topic: Request-Response Lifecycle in Production Systems and AWS

**Series:** Networking Fundamentals → System Design → AWS Solutions Architect
**Sections Covered:** 5, 6, 7, 8

---

## SECTION 5 — Real World Examples

### Analogy 1 — Emergency 911 Call Center

When you call 911, a precise lifecycle executes:

1. Your phone connects to the nearest cell tower (DNS + TCP equivalent)
2. The tower routes the call to the regional dispatch center (routing/load balancing)
3. The dispatcher answers and takes your information (HTTP request received)
4. Dispatcher checks computer system: "Any officers nearby?" (server processing + DB lookup)
5. Dispatcher broadcasts to officers (parallel dispatch, like async tasks)
6. "Unit 45 is responding — ETA 3 minutes" (response returned to caller)

What breaks the lifecycle? If the dispatch database is slow (N+1 query), if the computer crashes between steps 4 and 5 (exactly-once processing failure), or if the recording system is down but the call still goes through (partial failure tolerance).

The lifecycle must be observable — every step logged — because if someone dies, investigators need the exact sequence of what went wrong.

### Analogy 2 — Amazon Warehouse Order Fulfillment

When you click "Buy Now" on Amazon:

1. Receipt: your order arrives at the order processing center
2. Inventory check: is the item in a warehouse near you?
3. Route optimization: which warehouse ships it in under 2 hours?
4. Pick and pack: human or robot retrieves item, packages it
5. Label printing: shipping label with tracking number
6. Dispatch: handed to carrier
7. Confirmation: "Your order has been placed" email to you
8. Delivery tracking: incremental status updates (chunked responses, webhooks)

The HTTP response lifecycle mirrors this: the 200 OK is the "order confirmed" email, not the delivery. The actual work (delivery/server rendering) continues after the response. This is the foundation of async processing: accept the request fast, process asynchronously, notify via webhook or polling.

### Real Software Example — Google's PageSpeed Metrics

Google measures and monetizes the request-response lifecycle:

```
Core Web Vitals (Google's measurement of lifecycle phases):

  LCP (Largest Contentful Paint) — measures how fast the main content loads
    Target: < 2.5 seconds
    What it captures: DNS + TCP + TLS + TTFB + server processing + transfer + render

  INP (Interaction to Next Paint) — measures responsiveness
    Target: < 200ms
    What it captures: event handler execution → browser re-renders visual feedback

  CLS (Cumulative Layout Shift) — measures visual stability
    Target: < 0.1
    What it captures: rendering phase stability (images without dimensions causing shifts)

Real impact on business (Google's A/B test data):
  "A 100ms increase in page load time reduces Amazon's revenue by 1%"
  "53% of mobile visits are abandoned if pages take longer than 3 seconds"

  Lifecycle optimization ROI:
    Pinterest reduced perceived wait times by 40% → 15% increase in sign-up conversions
    Mobify found each 100ms improvement increased conversions 1.11%

Google search ranking:
  Page Experience signals (Core Web Vitals) are ranking factors
  Slow lifecycle = lower SERP ranking = less organic traffic

Chrome DevTools Network Waterfall:
  Shows every phase of the lifecycle per request
  Color coding:
    Gray block: Queuing / stalled
    Dark gray: DNS lookup (Phase 1)
    Orange: TCP connection (Phase 2)
    Purple: SSL (Phase 3)
    Green: Time to first byte — TTFB (Phases 4-6: request sent + server processing)
    Blue: Content download (Phase 7 download)

  TTFB > 200ms: server processing is too slow → investigate caching, DB queries
  Content download > 100ms: response too large → compress, paginate, lazy load
```

---

## SECTION 6 — System Design Importance

### 1. Identifying Lifecycle Bottlenecks

```
Systematic diagnosis for "API is slow":

Step 1: Measure TTFB (Time To First Byte) using curl:
  curl -o /dev/null -s -w "
    DNS:        %{time_namelookup}s
    TCP:        %{time_connect}s
    TLS:        %{time_appconnect}s
    TTFB:       %{time_starttransfer}s
    Total:      %{time_total}s
    Size:       %{size_download} bytes
  " https://api.shop.com/products

  Interpreting results:
    time_namelookup > 0.1s → DNS is slow: increase TTL, use local DNS cache
    time_connect high → Network latency: use CDN, move server closer to users
    time_appconnect high → TLS overhead: enable session resumption, upgrade to TLS 1.3
    time_starttransfer high → Server processing slow: optimize code, add cache, check DB
    time_total - TTFB high → response body too large: compress, paginate

Step 2: Distributed tracing (production):
  X-Ray, Jaeger, Datadog APM
  Shows: how long each phase took, which microservice call was slow

Step 3: Database profiling:
  If TTFB is server-side slow: enable slow query log
  PostgreSQL: log_min_duration_statement = 100  (log queries taking >100ms)
  MySQL: slow_query_log = 1; long_query_time = 0.1
  RDS: Performance Insights → shows which queries consumed the most time
```

### 2. The Critical Rendering Path Optimization

```
For web pages (HTML responses), the critical rendering path determines FCP:

Render-blocking resources must be eliminated or deferred:

BEFORE optimization (slow):
  <head>
    <link rel="stylesheet" href="all-styles.css">     ← blocks rendering (4MB CSS!)
    <script src="app.js"></script>                     ← blocks parsing (2MB JS!)
  </head>
  <body>
    <h1>Product List</h1>
  </body>

AFTER optimization (fast):
  <head>
    <style>/* critical CSS: above-fold styles only, inlined (5KB) */</style>
    <link rel="stylesheet" href="all-styles.css" media="print"
          onload="this.media='all'">                   ← loads async, doesn't block
    <link rel="preload" href="/fonts/Inter.woff2" as="font" crossorigin>
    <link rel="dns-prefetch" href="//api.shop.com">    ← DNS early
  </head>
  <body>
    <h1>Product List</h1>
    <script src="app.js" defer></script>               ← runs after parse, doesn't block
  </body>

Metrics improvement:
  FCP: from 3.5s → 0.8s
  LCP: from 5.2s → 1.9s
  Each metric improvement = conversion rate improvement
```

### 3. Connection Pooling and the Handshake Tax

```
Problem: Each database query opens a new TCP connection:
  MySQL TCP connect: 5ms
  MySQL TLS handshake: 20ms
  MySQL authentication: 5ms
  Total overhead: 30ms before the QUERY even starts!

  For 1,000 req/s, each needing 1 DB query without pooling:
    1,000 new connections/s × 30ms overhead = only 333 queries/s throughput
    (Saturated by connection overhead alone)

Solution: Connection pool (PgBouncer, HikariCP, TypeORM pool):
  Pool of 20 pre-authenticated DB connections kept warm
  App borrows connection → executes query → returns to pool
  No TCP/TLS/auth overhead → execute query immediately

  Pool sizing formula:
    Pool size = (Core count × 2) + effective spindle count
    For 4-CPU app server: pool size = 4 × 2 + 1 = 9 (start here)
    Adjust based on observed DB CPU and wait times

  Connection pool metrics to monitor:
    pool.waitingCount: requests waiting for an available connection → if > 0: pool undersized
    pool.idleCount: connections sitting unused → if always > 0: pool oversized
    pool.acquireTime: time to get a connection from pool → should be <1ms
```

### 4. Keep-Alive, Pipelining, and HTTP/2 Multiplexing

```
HTTP/1.1 without Keep-Alive:
  Each request:  TCP SYN → SYN-ACK → ACK → TLS 1+2 → Request → Response → TCP FIN
  10 requests = 10 × (3 RTT TCP + 2 RTT TLS) = 50 RTTs overhead!

HTTP/1.1 with Keep-Alive:
  First request: TCP + TLS overhead once
  Subsequent requests: send immediately
  BUT: serial! Request 2 waits for Request 1 to complete (Head-of-Line blocking)

HTTP/1.1 with Parallelism:
  Browsers open 6-8 parallel TCP connections per domain
  8 resources load simultaneously
  Each connection still has TCP+TLS setup overhead

HTTP/2 Multiplexing:
  Single TCP+TLS connection: everything shared
  100 requests sent simultaneously as separate streams
  Each stream is an independent request: no HOL blocking
  Header compression (HPACK): reduces header overhead 60-90%
  Server Push: server sends CSS/JS before browser even asks for it

HTTP/3 (QUIC):
  UDP-based, 0-RTT connection establishment on resume
  Each stream independent at transport layer (fix for HTTP/2 TCP HOL)
  ~10-20% faster than HTTP/2 on mobile/lossy networks
```

---

## SECTION 7 — AWS Mapping

### AWS X-Ray: Tracing the Full Lifecycle

```
X-Ray traces the request lifecycle across services:

Instrumentation (Node.js):
  const AWSXRay = require('aws-xray-sdk');
  const express = require('express');
  const app = express();

  app.use(AWSXRay.express.openSegment('ProductService'));

  app.get('/products', async (req, res) => {
    const segment = AWSXRay.getSegment();

    // Subsegment for cache check
    const cacheSubseg = segment.addNewSubsegment('redis-cache-check');
    const cached = await redisClient.get('products');
    cacheSubseg.close();

    if (cached) return res.json(JSON.parse(cached));

    // Subsegment for DB query
    const dbSubseg = segment.addNewSubsegment('postgres-query');
    const products = await db.query('SELECT * FROM products');
    dbSubseg.close();

    res.json(products);
  });

  app.use(AWSXRay.express.closeSegment());

X-Ray Service Map:
  Shows visual graph: Client → API Gateway → Lambda → RDS
  Each edge shows: request count, error rate, average latency
  Click on a node: see p50/p95/p99 latency distribution
  Click on a trace: see exact timing for each subsegment

  "Why is p99 slow even though p50 is fast?"
  → Find the 1% of traces that are slow
  → Common cause: cold starts, cache misses, DB slow queries on those specific requests
```

### AWS CloudWatch: Monitoring Each Phase

```
Metrics per lifecycle phase:

Phase 1 (DNS): Route 53 Resolver logs
  CloudWatch Logs Insights: query for slow DNS resolutions

Phase 2-3 (TCP+TLS): ALB metrics
  ALB → CloudWatch:
    TargetConnectionCount: current open connections
    ActiveConnectionCount: active TCP connections
    NewConnectionCount: new connections per second
    ClientTLSNegotiationErrorCount: TLS handshake failures (client side)

Phase 4-5 (HTTP Request + Transit): CloudFront
  CloudFront → CloudWatch:
    4xxErrorRate: client errors
    5xxErrorRate: server errors
    BytesDownloaded: total data transferred

Phase 6 (Server Processing):
  Lambda: Duration, ConcurrentExecutions, Throttles, InitDuration (cold start)
  ECS: CPUUtilization, MemoryUtilization
  RDS: ReadLatency, WriteLatency, DatabaseConnections, Deadlocks
  ElastiCache: CacheHits, CacheMisses, CurrConnections, Latency

Phase 7 (Response):
  ALB: TargetResponseTime: time from ALB sending request to target to receiving response
  CloudFront: TimeToFirstByte for cache miss

Key composite metric: End-to-end latency
  Custom: publish p50/p95/p99 latency from your application as custom CloudWatch metric
  Dashboard: graph end-to-end vs each component latency
  Alert on p99 > 500ms (not p50 — averages hide outliers)
```

### AWS CDN (CloudFront) Lifecycle Optimization

```
CloudFront optimizes lifecycle phases 2-7:

Phase 2-3 savings: Persistent connections from browser to CloudFront edge
  CloudFront: keeps TCP connections open to origin (persistent connection pool)
  Browser → CF edge: one TLS session, many requests (HTTP/2)
  CF edge → origin: connection pool (no per-request TCP handshake to origin)

Phase 5 savings: Edge PoP close to user
  Request only travels to nearest PoP (~2-5ms) rather than origin region (~50-200ms)

Phase 6 savings: Cache at edge (no origin processing for cached content)
  Cache HIT: server processing phase = 0ms (served entirely from edge)

Phase 7 savings: Compression at edge
  CloudFront compresses text responses with gzip/br if origin doesn't
  50-80% size reduction → 50-80% download time reduction

CloudFront Functions (lifecycle hook at Phase 4):
  Lightweight JavaScript runs at edge, at request time:
    Modify headers before forwarding to origin
    A/B testing redirects
    URL rewriting
    Simple request validation
  Latency: <1ms (runs at edge, no Lambda cold start)

Lambda@Edge (lifecycle hooks at all phases):
  Phase 1: Viewer request — modify/inspect before cache lookup
  Phase 2: Origin request — modify before forwarding to origin (cache miss)
  Phase 3: Origin response — modify origin response before caching
  Phase 4: Viewer response — modify before returning to client
```

### API Gateway and the Request Lifecycle

```
API Gateway adds its own phases to the lifecycle:

Lifecycle inside API Gateway:
  1. TLS termination (at API GW edge)
  2. Request validation (API Gateway validates JSON schema, headers, params)
  3. Lambda authorizer / Cognito authorizer (adds 5-50ms for custom auth)
  4. Request mapping / transformation (Velocity Template Language)
  5. Integration call (Lambda cold start: 200-2000ms; warm: 1-5ms)
  6. Response mapping / transformation
  7. Response logging (CloudWatch)

Total API Gateway overhead: 10-20ms (warm, no authorizer)
With Lambda authorizer: +5-100ms (caching authorizer reduces this to near-0 for repeat tokens)
With Lambda integration cold start: +200-2000ms (use Provisioned Concurrency to eliminate)

API Gateway caching:
  Enable stage cache → responses cached at API GW level
  Cache key: method + path + (optional) headers/query params
  TTL: configurable (default 300s)
  Use case: reduce Lambda invocations for read-heavy GET endpoints

  Cache key too broad: wrong user sees cached data from another user!
  Fix: include Authorization header or userId in cache key
  Or: disable caching for authenticated resources (use CDN instead for public data)
```

---

## SECTION 8 — Interview Q&As

### Beginner Questions

**Q1: What is TTFB (Time to First Byte) and what does it measure?**

A: TTFB (Time to First Byte) measures the time from when a client sends an HTTP request to when it receives the first byte of the HTTP response. It's a composite metric that captures:

- Network transit time (request traveling to server)
- Server processing time (authentication, database queries, business logic)
- Time for the response to start traveling back

TTFB does NOT include: DNS resolution, TCP handshake, TLS handshake (which happen before the HTTP request is sent), or the time to download the full response body.

A high TTFB (>200ms) indicates server-side slowness: slow database queries, no caching, expensive business logic, or geographic distance from the server. Optimizations: add Redis caching (serve from cache in 1ms instead of 50ms DB query), move to CDN, add API response caching.

A fast TTFB (< 100ms) means the server is efficient. If the page still feels slow, the bottleneck is: heavy response body (optimize transfer) or browser rendering (optimize critical path).

**Q2: Why does my API feel slow for new users but fast for existing users?**

A: Multiple cold-path vs warm-path differences:

1. **DNS caching**: new users have no cached DNS for your domain. First lookup can take 50-100ms. Existing users have it cached. Fix: set DNS TTL to at least 60 seconds; use `dns-prefetch` hints.

2. **TCP connection**: HTTPS requires TCP + TLS handshake (1-2 RTTs). Existing users with persistent connections (HTTP/2 keep-alive) skip this on subsequent requests.

3. **Server-side caches**: new users trigger cache misses. Their data isn't in Redis/Memcached. Existing users have cached profiles, recommended products, session data. Fix: warm up caches; implement cache-aside pattern aggressively.

4. **Lambda cold starts**: if using serverless, first request after idle starts a new Lambda container (200-2000ms delay). Existing users hit warm containers. Fix: Lambda Provisioned Concurrency.

5. **CDN cache**: new users may land on a CDN edge that hasn't cached your content yet. Fix: CloudFront cache warm-up (pre-request popular resources after deployment).

**Q3: What is the difference between latency and throughput in the context of a request-response cycle?**

A: Latency is the time for one request-response round trip to complete. Throughput is the number of requests the system handles per second.

Latency and throughput are related but distinct:

- Optimizing for low latency: minimize each step in the lifecycle (fast DNS, persistent connections, cache hits, rapid server processing)
- Optimizing for high throughput: maximize how many concurrent requests are in flight simultaneously (connection pool sizing, async I/O, horizontal scaling)

They can conflict: a small connection pool (say 5 connections) means high throughput at the pool level (all 5 always busy) but high latency for requests waiting for a connection. A very large pool means low latency for each request but possible DB saturation (too many concurrent queries degrade DB performance, increasing latency for all).

Little's Law ties them together: **L = λ × W** where L = requests in the system, λ = throughput (requests/sec), W = average latency. If you want high throughput without high latency, you need the queue (L) to be small.

---

### Intermediate Questions

**Q4: Your API handles 100 req/s normally with 50ms p99. During a traffic spike to 500 req/s, p99 rises to 5 seconds. What is the likely cause?**

A: Classic resource saturation pattern. At 5x traffic, one or more resources reached their limits:

**Root cause diagnosis:**

1. **Database connection pool exhaustion:**
   - Pool of 20 connections at 100 req/s = each request uses a connection for 20ms × 100/s = 2 connections average
   - At 500 req/s: 10 connections average needed, well within 20
   - BUT if some requests take 200ms (slow queries): 500 × 0.2 = 100 connections needed → pool exhausted → requests queue for available connection → latency spikes to seconds

2. **Thread/process pool exhaustion (synchronous framework):**
   - Node.js: single event loop, CPU-bound code blocks all requests
   - Java/Python synchronous: thread pool of 50 threads, each taking 200ms → 50/0.2 = 250 req/s capacity → at 500 req/s: queue builds up

3. **External service rate limiting:**
   - If downstream API has a 200 req/s rate limit: 500 req/s → 50% throttled → retry logic → queue builds

4. **GC pressure (Java/Go/C#):**
   - High traffic → high allocation rate → frequent GC → GC pauses add to every request latency

**Fixes:**

- Connection pool: resize to handle burst traffic (or use read replicas for reads)
- Async I/O: don't block threads/event loop on I/O
- Circuit breaker on external service: fail fast instead of stacking requests
- Horizontal scaling + auto-scaling to add capacity before pool exhaustion

**Q5: Describe the difference between synchronous and asynchronous request patterns and when you'd use each.**

A: Synchronous: the client sends a request, blocks waiting for the response, and gets the result inline:

```
Client: POST /order → waits → receives {orderId: "123", status: "confirmed"}
Client can immediately show: "Order #123 placed successfully!"
Suitable when: the result is needed immediately by the UI, operation is fast (<500ms)
```

Asynchronous: client sends a request, gets an immediate acknowledgment, and is notified later:

```
Client: POST /order → immediately receives {jobId: "job-abc", status: "processing"}
Result arrives later via: polling, webhooks, SSE, WebSocket
  Polling: client calls GET /jobs/job-abc every 5s until status="completed"
  Webhook: server calls client's https://client.com/webhooks/orders when done
  SSE: server streams status updates
  WebSocket: bidirectional; server pushes completed event

Suitable when: operation takes >1-2s (report generation, video transcoding, large imports)
               response isn't needed immediately (send email, charge subscription)
               operation can fail and retry independently (message queue)
```

In microservices, async patterns (event-driven via SQS/SNS/Kafka) provide decoupling: the order service doesn't wait for the email service to send the confirmation — it publishes an event and returns. The email service processes at its own pace.

**Q6: What is connection draining / deregistering in the context of a load balancer and request lifecycle?**

A: When a backend server needs to be removed (deployment, scaling down, failure): the load balancer must not kill existing in-flight requests — they should complete naturally.

Connection draining (called Deregistration Delay in AWS ALB):

1. Operator marks target as "deregistering" (or health check fails)
2. ALB: stops sending NEW requests to this target
3. ALB: waits for existing in-flight requests to complete
4. ALB: waits up to deregistration_delay (default: 300 seconds)
5. After all requests complete OR timeout: target removed from rotation

Without connection draining:

- User clicks "Place Order" → ALB routes to Target B → Target B is killed mid-request → user sees 502 error
- Order may be half-created in DB (data inconsistency)

With connection draining:

- User's request completes on Target B before it's killed
- No request interruption
- Zero-downtime deployments rely on this mechanism

ALB default: 300s deregistration delay
For fast APIs (<1s per request): reduce to 30s (300s is excessive, causes slow deploys)
For slow jobs (batch processing): increase or use separate target group with high timeout

---

### Advanced System Design Questions

**Q7: Design an observability system that tracks the full request-response lifecycle across 50 microservices and can identify which service caused an SLA breach.**

A: End-to-end distributed tracing:

```
Standards: W3C Trace Context (traceparent header)
  Format: 00-{traceId}-{spanId}-{flags}
  Example: traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01

  traceId: 128-bit, same for entire request across all services
  spanId: 64-bit, unique per service hop

Tools:
  AWS X-Ray: native AWS, automatic instrumentation for Lambda, ECS, API Gateway
  Jaeger (CNCF): open-source, self-hosted
  Datadog APM: commercial, full-featured

Architecture:
  Service mesh (Envoy): auto-injects traceId into every request header
  Services: propagate traceparent header to all outbound calls
  Each service: reports start_time, end_time, service_name, status_code, span metadata

  Storage:
    Hot path: 100% sampled for errors (all 500s traced)
    Cold path: 1% sampled for normal requests (cost control)
    Adaptive sampling: spike in traffic → increase sample rate

  Analysis: "Find traces with total duration > 500ms" → identify outliers
    Span breakdown shows: ServiceA(2ms) → ServiceB(4ms) → ServiceC(490ms) ← BOTTLENECK

SLA breach detection:
  Stream traces to CloudWatch: filter total_duration > SLA_threshold
  Alarm: p99 > 500ms → PagerDuty
  Automated root cause: "90% of breaches have ServiceC DB query > 300ms"
  ServiceC DB team alerted with trace IDs showing the slow queries
```

**Q8: A user reports their request "timed out" but the server logs show a successful 200 response. Explain the complete request-response lifecycle failure modes that could cause this.**

A: The request succeeded on the server but the client never received the response. Multiple failure points:

**Failure Point 1: Server response timeout vs application timeout mismatch**

```
Server: processes in 28 seconds → sends 200 OK at T+28s
Client: HttpClient timeout = 25 seconds → throws TimeoutException at T+25s
Client never receives the 200 OK response (it was waiting at T+28s when response arrived)
Server-side: logged 200 OK (it completed correctly)
Client-side: TimeoutException (it gave up before response arrived)
Fix: align timeouts — all clients must have timeout > server processing time
     Or fix server: make it faster or async (return 202 immediately, webhook when done)
```

**Failure Point 2: Load balancer idle connection timeout**

```
Client → ALB → Lambda
Lambda processes for 31 seconds
ALB default idle timeout: 60 seconds
In this case: ALB waited
BUT if Lambda took 65 seconds → ALB closes connection → client gets TCP RST
Server: Lambda succeeded at T+65s (logged as 200)
Client: Connection reset at T+60s (ALB timeout)
Fix: ALB idle timeout must be >= max server processing time
     Lambda: functions have max 15 minutes; ALB: max 4000 seconds idle timeout
```

**Failure Point 3: Connection dropped in transit**

```
Server sent the response but a network device (NAT gateway, firewall)
dropped the TCP connection before the response reached the client
(TCP RST or silent drop)
Fix: Application-layer retries on the client side (with idempotency)
     TCP keepalives prevent firewall from closing idle connections
```

**Failure Point 4: Response Too Large for Timeout**

```
Server correctly sends 200 OK with 500MB response body
Client download speed: 1 Mbps → 4000 seconds to receive
Client read timeout: 30 seconds → TimedOut
Server logged: sent 200 OK began sending body
Fix: Streaming responses (chunked transfer encoding), pagination, presigned S3 URL
     Never send large blobs in HTTP response bodies — presign to S3 instead
```

---

## File Summary

This file covered:

- 911 dispatch + Amazon order fulfillment analogies (lifecycle phases are universal patterns)
- Google Core Web Vitals: LCP, INP, CLS and their lifecycle mapping; business impact of lifecycle latency
- Bottleneck identification: curl w-format timing breakdown, X-Ray distributed tracing approach
- Critical rendering path optimization: inline critical CSS, defer scripts, preload fonts
- Connection pooling: why it's essential, pool sizing formula, metrics to monitor
- HTTP/1.1 Keep-Alive vs HTTP/2 multiplexing: single connection for 100 concurrent streams
- AWS X-Ray: instrumentation code, Service Map, p50/p95/p99 analysis
- CloudWatch metrics per lifecycle phase (DNS→TCP→TLS→TTFB→download→render)
- CloudFront lifecycle optimization: edge caching, persistent origin connections, Functions vs Lambda@Edge
- API Gateway phases: validation → authorizer → integration → response mapping, caching traps
- 8 Q&As: TTFB definition, new vs returning user latency, latency vs throughput, saturation spikes, sync vs async patterns, connection draining, distributed tracing design, timeout mismatch debugging

**Continue to File 03** for AWS SAA exam traps, 5 comparison tables, Quick Revision mnemonics, and Architect Exercise.
