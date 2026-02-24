# Latency vs Bandwidth vs Throughput — Part 3 of 3

### Topic: AWS SAA Exam Focus, Comparison Tables, Quick Revision, Architect Exercise

**Series:** Networking Fundamentals → System Design → AWS Solutions Architect
**Sections Covered:** 9, 10, 11, 12

---

## SECTION 9 — AWS SAA Certification Focus

### AWS SAA Exam Traps and Key Distinctions

```
TRAP 1: "Lower latency" does NOT always mean CloudFront

  Scenario: "Reduce latency for your REST API handling dynamic, user-specific responses"
  Wrong answer: Use CloudFront (can't cache user-specific content effectively)
  Correct answer: AWS Global Accelerator + Route 53 Latency-based routing

  Differentiator:
    CloudFront → cache at edge → best for STATIC or public cacheable content
    Global Accelerator → TCP/UDP private backbone → best for DYNAMIC content, WebSocket
    Route 53 Latency-Based → DNS-level routing to lowest latency region → multi-region active-active

TRAP 2: "High throughput" for databases is a different conversation than "low latency"

  "Your RDS database is receiving 50,000 writes/second but read latency is 150ms for users"
  Wrong: Upgrade RDS instance to get more IOPS (solves write throughput, not read latency)
  Correct: Add ElastiCache Redis in front of RDS to serve reads (1ms vs 150ms)

  Throughput fix: horizontal scale reads = Add RDS Read Replicas
  Latency fix: caching layer = ElastiCache

TRAP 3: Direct Connect vs VPN for bandwidth

  Both provide connectivity to AWS. Exam scenario:
  "Needs 10 Gbps consistent bandwidth for daily 5TB data transfer to S3"
  Wrong: AWS Site-to-Site VPN (bandwidth limited, goes over public internet = inconsistent)
  Correct: AWS Direct Connect (dedicated 10 Gbps connection, consistent bandwidth)

  Direct Connect: dedicated physical fiber, 1 or 10 Gbps, consistent, NOT encrypted natively
  Site-to-Site VPN: internet-based, encrypted, but bandwidth varies (public internet)

  "Needs encrypted 10 Gbps connection" → Direct Connect + MACsec encryption (Layer 2 encryption)
  OR Direct Connect + VPN over it (double tunnel: secure + consistent)

TRAP 4: Kinesis Shard capacity is BOTH throughput AND latency relevant

  "Kinesis consumer has high IteratorAgeMilliseconds (consumer lag)"
  Fix options:
    a) Add more shards (increase throughput ceiling)    ← correct only if shards are at limit
    b) Add more consumer instances (parallel consumption) ← correct if consumer CPU-bound
    c) Increase batch size per poll (higher read efficiency) ← often best first fix

  Exam answer: "IteratorAge rising" = consumer throughput < producer throughput
    → First check: are you at shard write limit (1 MB/s, 1000 records/s per shard)?
    → If yes: add shards
    → If no: consumer is the bottleneck → parallelize consumer

TRAP 5: S3 transfer speed limitations (bandwidth vs S3 design)

  "Need to upload 100 TB in 24 hours from on-premises to S3"
  100 TB / 86,400 sec = ~1.2 GB/s = ~9.6 Gbps

  Direct internet: typical 1 Gbps line → would take 8 days. Wrong solution.
  Direct Connect 10 Gbps: could work, BUT provisioning takes weeks. Wrong for urgent.
  AWS Snowball Edge: physical device, ship it. 80 TB per device, 5-7 day shipping.
    2 devices → 160 TB total capacity, arrives in ~1 week. Correct for time constraint.

  S3 Transfer Acceleration: speeds up internet-based S3 uploads via CloudFront
    Good for: globally distributed clients uploading to one S3 bucket
    NOT good for: when you already have a fast enough direct connection

TRAP 6: Throughput vs RCU/WCU in DynamoDB

  "DynamoDB returning ProvisionedThroughputExceededException"
  This is a THROUGHPUT error (not a latency error)

  Fix options:
    a) Increase provisioned RCU/WCU: works but costs more
    b) DynamoDB on-demand: automatically handles throughput spikes, no capacity planning
    c) DAX (DynamoDB Accelerator): for read-heavy → caches results in DAX,
       reduces reads hitting DynamoDB → fewer RCU consumed
    d) Exponential backoff + retry: SDK does this automatically (AWS SDK best practice)

  Key distinction:
    High latency on individual DynamoDB reads: not a capacity issue → check access patterns
    Throttling (exceeded RCU/WCU): capacity issue → scale up or use on-demand
```

### Exam Scenario Matrix

| Scenario                                      | Service                     | Specific Fix                             |
| --------------------------------------------- | --------------------------- | ---------------------------------------- |
| Global API, dynamic content, < 50ms worldwide | Global Accelerator          | Multi-region ALB + Route 53 Latency      |
| Static website, global low latency            | CloudFront + S3             | Cache-Control headers, TTL tuning        |
| 10+ Gbps consistent on-prem to AWS            | Direct Connect              | 10 Gbps dedicated port                   |
| 100TB urgent on-prem to S3                    | AWS Snowball Edge           | Physical device transfer                 |
| API throttling on Lambda (concurrent)         | Lambda Reserved Concurrency | Provisioned Concurrency for latency      |
| DynamoDB throttling                           | On-Demand or increase WCU   | DAX for read reduction                   |
| Kafka consumer lag                            | More consumers, more shards | Kinesis Enhanced Fan-Out                 |
| Slow DB reads, need latency < 1ms             | ElastiCache Redis           | Cache-aside pattern                      |
| Video streaming CDN                           | CloudFront                  | Streaming distributions, cached segments |

---

## SECTION 10 — Comparison Tables

### Table 1 — Latency by Distance (Physics Limits)

| Route                           | Distance   | Min One-Way Latency | Min RTT  | Typical Measured RTT       |
| ------------------------------- | ---------- | ------------------- | -------- | -------------------------- |
| Same data center (rack-to-rack) | <1 km      | <0.001ms            | <0.002ms | 0.1–1ms (switch hops)      |
| Same AZ (AWS)                   | <2 km      | <0.01ms             | <0.02ms  | 0.5–2ms                    |
| Same region, different AZ (AWS) | 10–100 km  | <1ms                | <2ms     | 1–5ms                      |
| US East → US West               | ~4,500 km  | 22ms                | 45ms     | 60–80ms (routing overhead) |
| NYC → London (transatlantic)    | ~5,600 km  | 28ms                | 56ms     | 70–90ms                    |
| NYC → Frankfurt                 | ~6,200 km  | 31ms                | 62ms     | 80–100ms                   |
| NYC → Singapore                 | ~15,300 km | 76ms                | 153ms    | 160–200ms                  |
| NYC → Sydney                    | ~16,000 km | 80ms                | 160ms    | 180–220ms                  |
| Geostationary satellite         | ~35,786 km | 179ms               | 358ms    | 600–700ms (both legs)      |

---

### Table 2 — Bandwidth vs Throughput vs Latency by AWS Service

| AWS Service             | Max Bandwidth              | Typical Throughput            | Typical Latency      | Bottleneck Factor |
| ----------------------- | -------------------------- | ----------------------------- | -------------------- | ----------------- |
| ALB                     | 100 Gbps (burst)           | ~40 Gbps sustained            | 1–5ms                | Connection count  |
| NLB                     | 100 Gbps                   | ~100 Gbps (L4 passthrough)    | <1ms                 | Packets/sec       |
| CloudFront              | 100+ Gbps (aggregate edge) | Scales to petabytes           | 1–5ms (cache hit)    | Cache hit ratio   |
| Direct Connect 10G      | 10 Gbps dedicated          | ~9.5 Gbps                     | ~1ms cross-connect   | Physical link     |
| S3 (single object)      | No limit                   | Limited by TCP window         | 10–50ms (TTFB)       | TCP connections   |
| S3 Multipart (parallel) | No limit                   | Near-line rate                | Same TTFB            | Number of parts   |
| DynamoDB                | Per-table RCU/WCU          | Millions of req/s (on-demand) | <5ms                 | Access patterns   |
| ElastiCache Redis       | Instance network bandwidth | ~100K-1M ops/sec              | 0.3–1ms              | Node CPU/memory   |
| Kinesis Data Streams    | 1 MB/s per shard (write)   | Linear with shards            | <5ms write           | Shard count       |
| Lambda                  | Scales with concurrency    | 1000+ concurrent = ~1M req/s  | 1ms warm, 200ms cold | Cold starts       |

---

### Table 3 — TCP Throughput vs RTT vs Window Size

| TCP Window      | RTT 5ms    | RTT 50ms   | RTT 150ms | RTT 600ms (satellite) |
| --------------- | ---------- | ---------- | --------- | --------------------- |
| 64 KB (default) | 100 Mbps   | 10 Mbps    | 3.4 Mbps  | 0.85 Mbps             |
| 512 KB          | 800 Mbps   | 80 Mbps    | 27 Mbps   | 6.8 Mbps              |
| 4 MB            | 6,400 Mbps | 640 Mbps   | 213 Mbps  | 53 Mbps               |
| 16 MB           | Exceeds 1G | 2,560 Mbps | 853 Mbps  | 213 Mbps              |

_Formula: Throughput (bps) = Window (bytes × 8) / RTT (seconds)_
_Note: Modern OS uses window scaling automatically (max ~1 GB window)_

---

### Table 4 — Latency Optimization Service Comparison

| Service                  | Latency Reduction Mechanism       | Incremental Complexity        | Works for Dynamic?      | Static?          | Cost     |
| ------------------------ | --------------------------------- | ----------------------------- | ----------------------- | ---------------- | -------- |
| CloudFront               | Edge caching, fewer hops          | Low (just DNS + distribution) | Partially (short TTL)   | Excellent        | Low      |
| Global Accelerator       | AWS private backbone routing      | Medium (anycast IPs)          | Yes                     | Yes (no caching) | Medium   |
| Route 53 Latency Routing | Routes DNS to nearest region      | Low (routing policy)          | Yes (multi-region)      | Yes              | Minimal  |
| ElastiCache Redis        | In-process cache (1ms vs 50ms DB) | Medium (cache invalidation)   | Yes                     | N/A              | Medium   |
| DAX                      | DynamoDB cache transparent        | Low (SDK swap)                | Read-only               | N/A              | High     |
| Lambda@Edge              | Code at CloudFront edge           | High (distributed code)       | Yes (per-request logic) | Yes              | Medium   |
| CloudFront Functions     | Simpler edge scripts              | Low                           | Yes (lightweight only)  | Yes              | Very Low |

---

### Table 5 — When to Optimize What

| Symptom                               | Root Cause                     | Dimension           | AWS Fix                                      |
| ------------------------------------- | ------------------------------ | ------------------- | -------------------------------------------- |
| API calls slow, large data payload    | Download time                  | Bandwidth           | Compress with gzip/br, paginate, S3 presign  |
| API calls slow, tiny responses (1KB)  | Network distance               | Latency             | CloudFront, Global Accelerator, multi-region |
| High error rate at peak load          | Capacity exhausted             | Throughput          | Auto Scaling, Lambda, DynamoDB on-demand     |
| Consistent slowness with DB reads     | Cache misses                   | Latency/throughput  | ElastiCache Redis cache-aside                |
| Occasional 10-second spikes (p99)     | Jitter / GC pause / cold start | Latency (tail)      | Provisioned Concurrency, reduce GC, warming  |
| Analytics queries slow (minutes)      | No index / full scan           | Throughput          | Athena partitioning, Redshift, DynamoDB GSI  |
| File upload slow for global users     | Geographic distance            | Latency + bandwidth | S3 Transfer Acceleration                     |
| Cross-region data transfer unreliable | Public internet                | Bandwidth           | Direct Connect for consistency               |

---

## SECTION 11 — Quick Revision

### 10 Key Points

1. **Latency = time for one packet to travel; bandwidth = maximum data rate of the link; throughput = actual data rate observed.** Throughput ≤ bandwidth always.

2. **Propagation delay is physics, not engineering.** NY-London = 30ms one way regardless of how fast your servers are. The only fix is geographic proximity (CDN, multi-region).

3. **BDP (Bandwidth-Delay Product) = Bandwidth × RTT** = bytes needed in the TCP pipe at any moment to fully utilize the link. If your window < BDP, you can't fill the pipe.

4. **TCP throughput formula: Throughput = Window / RTT.** A 64KB window on a 100ms RTT link = only 5.2 Mbps, even on a 1 Gbps physical link.

5. **Latency dominates for small files; bandwidth dominates for large files.** 1KB API response on 100ms RTT network = 100ms regardless of whether you have 1 Mbps or 1 Gbps bandwidth.

6. **Jitter = variation in latency.** Caused by queueing delays varying. Real-time applications (voice, video, gaming) suffer from jitter more than average latency.

7. **Little's Law: L = λ × W.** If average latency (W) doubles (e.g., slow DB), the system needs twice the concurrency (L) to maintain the same throughput (λ). Without extra concurrency: throughput halves.

8. **CDN reduces latency AND improves throughput simultaneously.** Lower RTT → TCP slow start ramps faster → full throughput reached in milliseconds instead of seconds. Cached responses skip all server-side processing.

9. **CloudFront for caching HTTP content; Global Accelerator for dynamic/non-cached TCP/UDP.** Common exam trap: both "reduce latency" but for different traffic types.

10. **AWS Direct Connect gives dedicated bandwidth; VPN shares public internet.** For consistent high-bandwidth data transfer: Direct Connect. For encrypted low-footprint on-prem backup: VPN. For high-bandwidth AND encryption: Direct Connect + MACsec.

---

### 30-Second Concept Explanation

> "Latency, bandwidth, and throughput are three different measurements of network performance. Latency is time — how long it takes ONE piece of data to travel from A to B. Bandwidth is capacity — how wide the pipe is, how much COULD flow. Throughput is reality — how much data ACTUALLY flows end-to-end, always less than bandwidth due to overhead, congestion, and protocol limits. The key formula is: TCP throughput = window size divided by round-trip latency. For small API calls, latency dominates — you can have a 1 Gbps connection but a 100ms round trip means each API call takes 100ms no matter what. For bulk transfers, bandwidth dominates. For concurrent workloads, throughput is king. AWS lets you optimize all three: CloudFront cuts latency to single-digit milliseconds, Direct Connect guarantees bandwidth, and DynamoDB + Lambda scale throughput to millions of operations per second."

---

### Mnemonics

**"L-B-T: Little Buses Travel"**

```
L = Latency:   TIME for one unit to travel (one bus on the road)
B = Bandwidth: Maximum BUSES that can travel simultaneously (highway capacity)
T = Throughput: BUSES that actually ARRIVE (real-world delivery rate ≤ bandwidth)
```

**BDP: "Big Data Pipe = Bandwidth × Delay Product"**

```
BDP = Bandwidth (bps) × Delay (seconds)
= bytes that can be "in flight" simultaneously
= minimum TCP window needed to fill the pipe
If window < BDP: you're wasting bandwidth
```

**Throughput formula: "Windows Divided by Round Trips"**

```
Max Throughput = Window / RTT
Windows = your TCP buffer size
RTT = round trip time to the server
Faster server (closer) = smaller RTT = higher throughput (even with same window)
→ CDN fixes throughput not just latency
```

**Latency components: "Pretty Packets Prefer Quality"**

```
P = Propagation delay (physics: distance / speed of light in fiber)
P = Processing delay (router/firewall doing work)
P = (transmission) Pipe delay — packet size / link bandwidth
Q = Queueing delay (waiting in congested router buffer)
Total = P + P + P + Q
Only Q can spike (causes jitter); first three are predictable
```

**Little's Law: "Lambda W equals L"**

```
λ (lambda) = throughput (requests/sec)
W = latency (seconds per request)
L = concurrency (requests in flight)
λ × W = L
Latency doubles → need 2× concurrency to maintain same throughput
→ This is why slow dependencies cause cascading overload
```

---

## SECTION 12 — Architect Thinking Exercise

### Problem Statement

You're Principal Architect at a global SaaS company. The product team just approved a new real-time feature: **"Live Stock Price Ticker"** — showing current stock prices that update every second. Requirements:

- **Global users**: US, Europe, Asia (users in 50+ countries)
- **Update frequency**: every 1 second (new price data from NYSE)
- **Latency target**: price displayed on screen < 500ms after NYSE publishes it
- **Scale**: 5 million concurrent connected users during market hours
- **Reliability target**: 99.95% uptime (≤ 4.4 hours downtime/year)
- **Budget constraint**: must be cost-efficient (CFO approved $50K/month)

**Current architecture:** Single-region REST API (poll every 2s). Users notice prices are often 5-10 seconds stale. CloudFront caches responses for 60s (making the staleness 60+ seconds!).

**Question: Redesign this for the stated requirements. Analyze each of Latency, Bandwidth, and Throughput in your solution.**

---

_(Try to solve this yourself for 5 minutes before reading the solution below)_

---

### Solution

**Analysis of the three dimensions:**

```
LATENCY analysis:
  NYSE publishes → your system receives: ~10ms (co-located market data feed)
  Your system processes → pushes to 5M users:
    With current REST polling: average staleness = poll_interval / 2 = 1s average
    With WebSocket push: staleness = processing time only (~50ms)

  Geographic latency:
    Server in us-east-1, user in Tokyo: 150ms RTT
    Server in us-east-1, user in Frankfurt: 90ms RTT
    For 500ms end-to-end budget: 90ms network + 50ms processing = 140ms, within budget

  Problem: 5M concurrent WebSocket connections per instance = impossible
    Solution: Push via CDN WebSocket or regional distribution

BANDWIDTH analysis:
  Per message: 50 bytes (stock ticker update: symbol + price + timestamp + change)
  5M users × 50 bytes × 1 update/sec = 250 MB/s outbound bandwidth
  = 2 Gbps sustained bandwidth (24M × 8 bits × 1/s)

  One EC2 instance (c5.18xlarge): 25 Gbps network → handles this in theory
  BUT: 5M concurrent TCP connections = infeasible on single host

  Solution: distribute across CDN / edge push infrastructure

THROUGHPUT analysis:
  5M connected clients, each receiving 1 push/sec = 5M events/sec delivery throughput
  WebSocket server: typically 50,000-100,000 concurrent connections per instance
  Required instances: 5M / 75K = ~67 EC2 instances
  Auto Scaling: scale between market hours and off-hours
```

**Architecture Design:**

```
NYSE Feed → Market Data Service → Price Distribution System → Global Users

Layer 1: Market Data Ingestion (Latency-critical)
  AWS Direct Connect to NYSE colocation (sub-1ms feed reception)
  EC2 c5.metal in us-east-1 (closest AWS region to NYSE in NYC)
  Parses and validates price updates: ~5ms

Layer 2: Fan-Out (Throughput-critical)
  Kinesis Data Streams: 250 shards × 1 MB/s = 250 MB/s capacity (matches requirement)
  Publishers: market data service writes price updates to Kinesis
  Write latency: < 5ms

Layer 3: WebSocket Distribution (Latency + Throughput)

Option A: AWS IoT Core
  MQTT over WebSocket: designed for millions of concurrent connections
  Supports 5M+ concurrent connections (managed service, no EC2 sizing)
  IoT Core rule → Lambda → sends delta to specific IoT topic per symbol
  Clients subscribe to symbols they watch: "prices/AAPL" → AAPL updates only

  But: IoT Core geographic distribution = same region delay for Tokyo users

Option B: Multi-Region WebSocket with Global Accelerator
  us-east-1 WebSocket fleet → for US users (10-50ms)
  eu-west-1 WebSocket fleet → for European users (10-30ms)
  ap-northeast-1 WebSocket fleet → for Asia users (10-50ms)

  Price sync: Kinesis Global Tables equivalent (DynamoDB Streams → cross-region Lambda)
  Each regional fleet receives price data in < 200ms (replication lag)

  Global Accelerator: anycast IP → routes user to nearest regional WS fleet
  WebSocket connections: persistent TCP via GA → users in each region get <50ms latency

  Auto Scaling: Scale WebSocket EC2 fleet: 0 → 100 instances over market hours
  Target: 1 hour before NYSE open (pre-warm, not cold-start at 9:30am)

Layer 4: WebSocket Server (ECS on EC2, spot instances)
  Node.js + uWebSockets.js: 1M concurrent WebSocket connections per node (C++ kernel)
  5 nodes per region × 3 regions = 15 total server instances
  Each node: < 2GB RAM for 1M connections (WebSocket state is tiny — subscription list)

Layer 5: Throttling and Bandwidth Management
  Per-connection: clients receive only subscribed symbols (filter at server)
  Burst protection: if price updates come faster than 1/sec (flash crash): debounce
  Token bucket: max 2 updates/sec per symbol to clients (prevents bandwidth spike)

Reliability:
  Route 53 Health checks → failover to secondary region in 30s if primary fails
  DynamoDB Global Tables: price state replicated across regions → 0 RPO on connection reconnect
  ALB across WebSocket nodes: if one node fails → connections re-balance (< 30s reconnect)
```

**Cost estimate:**

```
3 regions × 5 EC2 instances (c5.2xlarge $0.34/hr each) × 730 hrs/month = $3,723
But: market hours only (6.5 hrs/day × 21 trading days = 136.5 hrs/month):
  → Auto Scaling during market hours only:
  3 × 5 × $0.34 × 136.5 hrs = $697/month WebSocket fleet

Kinesis: 250 shards × $0.015/hr × 730 = $2,737/month
DynamoDB (latest prices): < $100/month (tiny data)
Global Accelerator: $0.025/hr + $0.015/GB × 2 Gbps daily = ~$1,200/month
Lambda (Kinesis triggers): 5M events/sec × 10ms × $0.0000002 = ~$500/month

Total: ~$5,200/month (well within $50K budget, with room for S3 price history, monitoring, etc.)
```

**Key architectural decisions explained:**

1. **Latency**: Direct Connect to NYSE (sub-ms feed); multi-region deployment (< 50ms to users globally); per-symbol subscription (sends only relevant data, no client-side filtering latency)

2. **Bandwidth**: Filter at server (50 bytes per subscribed symbol vs 50 bytes × all symbols); token bucket prevents burst; only active connections receive data (no broadcast to idle tabs)

3. **Throughput**: IoT Core / uWebSockets handles millions of connections; Kinesis provides linear throughput scaling; auto-scaling pre-warms before NYSE open to avoid cold-start throughput gaps

---

## Quick Reference Card

```
Formulas:
  Propagation delay (one-way) = Distance / Speed_in_fiber (200,000 km/s)
  TCP Throughput = Window_size_bytes / RTT_seconds
  BDP = Bandwidth × RTT  (bytes in flight = minimum window to fill the pipe)
  Little's Law: L = λ × W  (concurrency = throughput × latency)

Rules of thumb:
  NYC-London RTT: ~70-90ms
  NYC-Singapore RTT: ~160-200ms
  Same-AZ (AWS): ~1-3ms
  Cross-AZ (AWS): ~2-5ms
  Cross-region (AWS backbone): ~60-200ms (varies by region pair)
  ElastiCache Redis latency: 0.3-1ms
  DynamoDB latency: 1-5ms
  RDS read latency: 5-50ms

AWS Direct Connect bandwidths: 50 Mbps, 100 Mbps, 500 Mbps, 1 Gbps, 10 Gbps
S3 multipart threshold: > 100 MB (use multipart for better throughput)
S3 multipart for large files: 8-16 parts in parallel = near line-rate throughput
```
