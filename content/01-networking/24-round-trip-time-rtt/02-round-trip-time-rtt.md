# Round Trip Time (RTT) — Part 2 of 3

### Topic: Real-World Examples, System Design Patterns, AWS Mapping, Interview Q&As

**Series:** Networking Fundamentals → System Design → AWS Solutions Architect
**Sections Covered:** 5, 6, 7, 8

---

## SECTION 5 — Real World Examples

### Analogy 1 — Trading Floor Communication

Imagine a trading floor in a physical stock exchange. Traders shout buy/sell orders across the floor. One trader on the East side wants to communicate with a trader on the West side:

**High RTT scenario (physical floor):** The East trader shouts, it echoes back in 0.5 seconds → they can complete 2 exchanges per second.

**Low RTT scenario (adjacent desks):** Traders next to each other whisper and get confirmation in 0.05 seconds → 20 exchanges per second.

**Automated trading lesson:** Modern high-frequency trading firms physically co-locate their servers in the NYSE data center to achieve RTT of **microseconds** instead of milliseconds. A firm in Chicago had slightly higher RTT to NYSE than firms in New Jersey — they ran **fiber under the Appalachian Mountains** to shorten the cable path and gain 3ms advantage. That 3ms = $100M+ in annual trading profits. This is RTT optimization taken to its physical extreme.

**System design insight from trading:** RTT matters so much that the industry pays millions for physical proximity. In your architecture, this means: put your application servers in the SAME AVAILABILITY ZONE as your database. The 1-3ms cross-AZ RTT adds up across thousands of queries.

### Analogy 2 — Space Communication (Ultimate RTT)

RTT from Earth to Moon: 2.56 seconds (light speed × 384,000 km)
RTT from Earth to Mars: 3 to 22 minutes (orbit-dependent)

What happens to TCP on a link with 3-minute RTT?

- TCP slow start: first window = 1 MSS. After receiving ACK... wait 3 minutes. cwnd doubles. Send 2 packets. Wait 3 minutes...
- To transfer 1 GB file from Mars with default TCP: would take years (literally)

NASA uses **custom protocols** for deep space communication — **CCSDS (Consultative Committee for Space Data Systems)** — that use huge pre-negotiated windows and accept out-of-order delivery, essentially bypassing TCP's RTT dependency entirely.

**System design insight:** When RTT is extremely high (satellite links, inter-region), standard TCP becomes ineffective. Solutions: QUIC, pre-fetching, compression, binary protocols, or burst transmission + local caching.

### Real Software Example — Cloudflare Workers (RTT Optimization at the Edge)

Cloudflare operates the world's largest RTT-reduction network:

```
Traditional API (user in Tokyo → server in us-east-1):
  RTT per round trip: ~160ms

  A single login request (Auth0 style):
    DNS: 160ms
    TCP: 160ms
    TLS: 160ms
    POST /auth: 160ms
    Total: 640ms just for login!

Cloudflare Workers approach:
  User in Tokyo → Cloudflare Tokyo PoP (RTT: 3ms)

  Cloudflare Worker (JavaScript at the edge):
    Runs JWT validation at edge: 0.5ms
    Calls origin only if needed: Cloudflare backbone to us-east-1 (~70ms, NOT 160ms)

  Cloudflare Worker RTT math:
    DNS: 3ms (Tokyo PoP DNS)
    TCP: 3ms
    TLS: 3ms
    POST /auth: 3ms (edge) + 70ms (edge-to-origin via backbone) = 73ms total
    Total: 9ms + 73ms = 82ms (vs 640ms → 7.8× faster)

  How Cloudflare Workers reduce RTT:
    1. Move computation TO the user (edge compute)
    2. For cacheable data: user never sees the origin RTT at all
    3. For dynamic/auth: edge handles early validation, origin call is on fast backbone

  AWS equivalent: Lambda@Edge or CloudFront Functions
    Lambda@Edge: runs at CloudFront edge PoPs, 100ms avg latency overhead
    CloudFront Functions: <1ms execution, runs at ALL 450+ edge PoPs
    Use case: JWT validation, URL rewriting, A/B testing at edge
    Reduces: client-to-origin RTT to client-to-edge RTT for all requests
```

---

## SECTION 6 — System Design Importance

### 1. RTT-Aware API Design

```
Principle: MINIMIZE ROUND TRIPS, not just individual latency

Anti-pattern: Chatty API (many small calls)
  Client: GET /user/123
  Client: GET /user/123/preferences
  Client: GET /user/123/cart
  Client: GET /user/123/recommendations
  = 4 RTTs × 150ms = 600ms for a London user fetching a dashboard

  (Even if each endpoint responds in 5ms, you paid 4 × 150ms = 600ms in RTT)

Better pattern: Compound document API (single round trip)
  Client: GET /user/123?include=preferences,cart,recommendations
  Server: joins and returns all in one response
  = 1 RTT × 150ms = 150ms (4× improvement purely from RTT reduction)

Best pattern: GraphQL or BFF (Backend for Frontend)
  GraphQL: client specifies exactly what it needs in ONE query
    { user(id: 123) { profile preferences cart { items { product price } } } }
    = 1 RTT to GraphQL server → server resolves all in parallel from own data sources

  BFF (Backend for Frontend):
    Separate API gateway built specifically for mobile app or web app
    Pre-aggregates all data the client needs for each screen
    Client RTT: 1 (to BFF) + BFF resolves internally (sub-ms between services)

HTTP Batch APIs:
  Some APIs support batching multiple logical requests in one HTTP call:
  POST /batch
  Body: [
    { "method": "GET", "path": "/users/123" },
    { "method": "GET", "path": "/orders?user=123" },
    { "method": "POST", "path": "/events", "body": {"type":"page_view"} }
  ]
  = 1 RTT instead of 3
```

### 2. RTT and Microservice Mesh Design

```
Each synchronous microservice hop adds RTT to total response time.

Example: API Gateway → Service A → Service B → Service C (sequential)
  If each hop is 1ms RTT (same AZ): 3ms microservice overhead (fine)
  If each hop crosses AZ (3ms): 9ms overhead (fine)
  If each hop crosses region (70ms): 210ms microservice RTT overhead (not fine!)

  Rule: synchronous microservices should be co-located (same region, ideally same AZ)
  Rule: cross-region calls should be ASYNC (SQS, SNS, EventBridge) whenever possible

  Synchronous cross-region = RTT × number of hops → cascading latency

Service Mesh and RTT:
  Envoy sidecar proxy (used in App Mesh, Istio): adds ~1-2ms per hop
  Trade-off: observability, mTLS, retry logic worth the 1-2ms overhead
  If RTT is 1ms same-AZ: Envoy doubles the hop latency (1ms → 2ms)
  If RTT is 70ms cross-region: 1ms Envoy overhead is negligible (70ms → 71ms)

  Design principle: Envoy overhead significant only for very low-latency paths
  (trading systems, real-time audio/video)
```

### 3. RTT Budget as an SLA Tool

```
Define RTT budget per tier to ensure end-to-end SLA:

Example: API must respond in < 200ms (p99) for users globally

Budget allocation:
  Network RTT (global users, CDN edge): ≤ 10ms   (CloudFront edge, 450 PoPs worldwide)
  TLS + connection overhead: ≤ 5ms               (TLS 1.3, HTTP/2, session resume)
  API Gateway + routing: ≤ 5ms                   (CloudFront Functions or API GW)
  Auth validation: ≤ 10ms                        (JWT validate at edge or Lambda@Edge)
  Backend service: ≤ 50ms                        (ECS/Lambda + ElastiCache lookup)
  Database query: ≤ 10ms                         (ElastiCache hit = 1ms, miss = 10ms)
  Response serialization: ≤ 5ms                  (JSON stringify)
  Total: 95ms budget (with 105ms headroom for variability)

Monitoring against budget:
  X-Ray: segment per component → instrument against budget
  CloudWatch: alarm when any component exceeds budget
  SLO: "95% of requests must have total < 200ms" → alert at 97% (early warning)

Budget violation investigation:
  X-Ray trace: "which segment exceeded its budget?"
  Common culprits: cache miss (Redis → DB), Lambda cold start (0ms → 500ms),
  N+1 queries, synchronous call to slow external service
```

### 4. Connection Reuse: The RTT Multiplier Reducer

```
Every NEW connection = 1-3 RTTs of overhead before any useful work.

Database connections:
  Without pooling (new conn per request):
    API request → open MySQL TCP (1ms RTT) → MySQL TLS (2ms) → auth (1ms) → query (5ms)
    Total: 9ms (but 4ms = pure RTT overhead, 55% waste)

  With connection pool (connection already open):
    API request → borrow conn from pool (0ms) → query (5ms)
    Total: 5ms (55% faster purely by eliminating RTT overhead)

HTTP Keep-Alive and Persistent Connections:
  Web performance: browser has 4 resources to load from same CDN
  Without keep-alive (HTTP/1.0): 4 × (TCP 1 RTT + TLS 1 RTT + HTTP 1 RTT) = 12 RTTs
  With keep-alive HTTP/1.1: 1 × (TCP + TLS) + 4 × HTTP = 6 RTTs (2× faster)
  With HTTP/2: 1 × (TCP + TLS) + 1 set of multiplexed HTTP = 3 RTTs (4× faster)
  With HTTP/3 QUIC: 1 RTT total (0-RTT resume after first visit) = 1 RTT (12× faster!)
```

---

## SECTION 7 — AWS Mapping

### AWS Services and RTT Implications

```
Route 53 Latency-Based Routing:
  Measures RTT from user to each AWS region you deploy in
  Returns DNS record for the region with lowest measured RTT
  Route 53 has RTT measurement infrastructure: probes from global checkpoints
  Update frequency: Route 53 updates latency data regularly (not real-time)

  Use case: deploy API in us-east-1, eu-west-1, ap-southeast-1
    Australian user → Route 53 → sees ap-southeast-1 is lowest latency → returns that IP
    European user → Route 53 → sees eu-west-1 → returns eu-west-1 IP

  Exam tip: Latency-based routing optimizes RTT to your origin, not to CloudFront edge

AWS Global Accelerator and RTT:
  GA gives you 2 static Anycast IP addresses
  User's packet routes to nearest GA edge (AWS edge in 80+ cities)
  From edge: packet travels AWS private backbone (not public internet) to your region

  RTT breakdown WITHOUT GA (user in Mumbai, origin in us-east-1):
    Mumbai → public internet → us-east-1: ~200ms RTT
    Public internet has: unpredictable routing, multiple ISP hops, congestion

  RTT breakdown WITH GA:
    Mumbai → AWS Mumbai PoP (3ms) → AWS private backbone → us-east-1: ~100ms
    Private backbone: fewer hops, no congestion, deterministic routing
    RTT reduction: ~100ms (50% improvement) for that user specifically

  GA health checks: if your us-east-1 endpoint fails, GA switches users to
  another region within 30 seconds (using the same 2 Anycast IPs — no DNS change)

CloudFront and RTT:
  CloudFront edge PoPs: 450+ globally
  User → nearest PoP: typically 1-10ms for most of world (urbanized areas)
  This is the minimum possible RTT for HTTP traffic (short of Starlink direct)

  CloudFront caching converts origin RTT to edge RTT:
    Origin RTT: 150ms (user to us-east-1)
    Edge RTT: 5ms (user to Frankfurt PoP)
    Cache HIT: user sees 5ms response (no origin involved)

  CloudFront Regional Edge Caches (middle tier):
    PoPs → Regional Edge Cache → Origin
    If PoP cache miss: doesn't go to origin yet
    Regional Edge Cache (12 locations): serves if cached there
    Reduces origin RTT to ~20ms (PoP → nearest Regional EC → Origin skipped)
    Reduces origin load by 90%+
```

### X-Ray for RTT Analysis

```
AWS X-Ray automatically measures RTT between services:

Service map in X-Ray:
  Client → API GW → Lambda → DynamoDB
  Shows RTT for each edge (connection between services):
    Client→API GW: 150ms (user network RTT)
    API GW→Lambda: 2ms (same region)
    Lambda→DynamoDB: 3ms (same region)
    Lambda→External ML API: 120ms (external, cross-region)

  Identifies: external ML API has the highest RTT cost → candidate for caching or async

X-Ray subsegment breakdown:
  {
    "id": "abc123",
    "name": "DynamoDBGetItem",
    "start_time": 1678901234.000,
    "end_time": 1678901234.003,   ← 3ms RTT to DynamoDB
    "http": {
      "response": {"status": 200}
    },
    "aws": {
      "table_name": "Products"
    }
  }

  Aggregate traces: "Which DynamoDB table has the highest p99 RTT?"
  p99 outliers: often cache misses or hot partition issues

CloudWatch Contributor Insights for RTT analysis:
  Shows which IPs, user agents, or paths contribute most to high RTT
  Use: identify outlier clients (e.g., old mobile app using HTTP/1.1 = higher RTT)
  Fix: force upgrade or add HTTP/2 headers

VPC Reachability Analyzer:
  Tests network path between instances
  Not RTT measurement but verifies connectivity (rules out security group / routing)
  Use: before blaming RTT, confirm packets are actually flowing
```

### CloudWatch Metrics for RTT Monitoring

```
Build a comprehensive RTT dashboard:

Panel 1: End-to-end latency (p50/p95/p99)
  Source: ALB TargetResponseTime or X-Ray trace duration
  Alarm: p99 > 500ms (SLA breach)

Panel 2: DNS resolution time
  Source: Route 53 → CloudWatch (DNS query latency metric)
  Healthy: < 10ms average

Panel 3: Database RTT
  Source: X-Ray segment durations for DynamoDB/RDS
  RDS healthy: < 10ms per query; Alert: > 50ms (network or DB issue)
  DynamoDB healthy: < 5ms; Alert: > 10ms

Panel 4: External API RTT
  Source: Custom CloudWatch metrics from Lambda (publish RTT of each external call)
  Essential for: payment gateways, ML APIs, partner services
  Alarm: external API RTT > SLA threshold → trigger circuit breaker pattern

Panel 5: CloudFront cache hit RTT vs miss RTT
  Source: CloudFront access logs → insight query
  Shows: cache hit responses are 5ms, misses are 150ms → validate CDN is working

Alarm routing:
  RTT spike in Database segment → notify DB team
  RTT spike in Lambda→External segment → notify API team
  End-to-end RTT breaches SLA → notify on-call + auto-scale trigger
```

---

## SECTION 8 — Interview Q&As

### Beginner Questions

**Q1: What is RTT and why does it matter in web performance?**

A: RTT (Round Trip Time) is the time it takes for a message to travel from a source to a destination AND back. In web performance, RTT matters because every protocol step (DNS resolution, TCP connection, TLS handshake, HTTP request) requires at least one round trip.

For a user 200ms RTT away from the server, loading a simple HTTPS page requires:

- 1 RTT for DNS = 200ms
- 1 RTT for TCP = 200ms
- 1 RTT for TLS 1.3 = 200ms
- 1 RTT for HTTP GET = 200ms

That's 800ms just in network overhead before the page starts loading — and the server hasn't done any work yet.

RTT is primarily determined by geography (speed of light in fiber). You cannot engineer your way past physics. The solution is to reduce distance: CDN servers close to users reduce RTT from 200ms to 5-10ms. This is why CDN is the single highest-impact optimization for global web performance — not server-side code speed.

**Q2: How does RTT affect TCP performance differently from application performance?**

A: TCP uses RTT as a fundamental clock for congestion control. The throughput formula is:

**Throughput = TCP Window Size / RTT**

With the default 64KB TCP window:

- 5ms RTT: throughput ≈ 100 Mbps (great)
- 50ms RTT: throughput ≈ 10 Mbps (decent)
- 200ms RTT: throughput ≈ 2.6 Mbps (terrible on a 1 Gbps link)

The application performance impact is different: it's about how many sequential round trips must complete before the user sees a result. Even for a tiny 1KB response, if it takes 5 sequential round trips (DNS + TCP + TLS + redirect + HTTP), and each is 200ms, the total wait is 1,000ms — not because the data is large, but because of the protocol overhead multiplied by RTT.

Fix for TCP throughput: increase window size (TCP window scaling) or use parallel connections.
Fix for application RTT: reduce the number of sequential round trips (CDN, HTTP/2, keep-alive, connection pools).

**Q3: A developer says "our server response time is only 10ms, so the app should feel instant." Why might users still experience slowness?**

A: Server response time (10ms) is only part of the total RTT experience. What the developer measured is likely Time-To-First-Byte (TTFB) from the server's perspective, which doesn't include:

1. **Network RTT**: if the user is 150ms away, they wait 150ms for the request to arrive and 150ms for the response to return = 300ms network time alone
2. **DNS resolution**: 50-100ms for new users
3. **TCP + TLS setup**: 1-3 RTTs before the HTTP request is even sent (150-450ms for that 150ms RTT user)
4. **Multiple requests**: if loading a webpage, the browser may make 30-50 requests sequentially (for non-optimized pages), each paying 150ms+ RTT

Total user experience for 10ms server, 150ms RTT user:

- DNS: 150ms + TCP: 150ms + TLS: 150ms + HTTP: 150ms + server: 10ms = 610ms
- Then CSS/JS loads: another 30 requests × 150ms = 4,500ms (HTTP/1.1 waterfall)

Fix: CDN (reduces 150ms RTT to 5ms), HTTP/2 (30 requests → 1 connection × 1 RTT), compression (fewer bytes = faster download).

---

### Intermediate Questions

**Q4: You're building a real-time collaborative document editor (like Google Docs). How does RTT affect your architecture decisions?**

A: Real-time collaboration has strict RTT requirements:

- User types character → other collaborators must see it in < 100ms to feel "real-time"
- 100ms budget includes: client processing + network RTT + conflict resolution + recipient rendering

Architectural decisions driven by RTT:

**Conflict-free Replicated Data Types (CRDTs) vs Operational Transform (OT):**
Both require sending operations to collaborators. Central server model: client → server → all clients = 2 × RTT latency. For a London user with 80ms RTT to us-east-1: 2 × 80ms = 160ms minimum > 100ms target.

**Solution: Regional server presence**
Deploy operation servers in us-east-1, eu-west-1, ap-southeast-1. London users connect to eu-west-1 (10-30ms RTT). 2 × 30ms = 60ms ≤ 100ms budget.

**WebSocket multiplexing:**
WebSocket stays open (no per-message RTT overhead from TCP setup). Each keystroke = 1 RTT on established WebSocket. Without WebSocket (HTTP polling every 1s): up to 1s delay + RTT. WebSocket is essential for real-time.

**Global Accelerator:**
Static Anycast IPs → nearest PoP → AWS backbone. For mixed regions: users in different continents connect to nearby PoPs. Collaboration happens via inter-region AWS backbone (~70ms cross-region on backbone vs ~150ms public internet). Net effect: 2 × RTT between collaborators in different countries reduced by 30-50%.

**Local prediction (optimistic updates):**
Show the user's own keystrokes immediately (0ms local RTT), reconcile later. This decouples local perceived latency from network RTT entirely. Users never feel their own typing lag.

**Q5: How does RTT affect database read consistency choices in distributed systems?**

A: Every consistency level in distributed databases has an RTT cost:

```
Eventual consistency (DynamoDB default reads):
  Read from nearest replica without quorum: ~1-5ms
  No RTT waiting for consensus
  Trade-off: may read stale data (seconds behind primary)

Read-your-writes consistency:
  After a write, subsequent reads guaranteed to see your own write
  DynamoDB: use strongly consistent reads OR sticky session (same node reads)
  Cost: slightly higher RTT (must check primary or wait for replication confirmation)

Strong consistency (DynamoDB consistent reads):
  DynamoDB: reads return current data to the primary
  RTT cost: no extra RTT IF primary is local; higher if cross-region
  Cost: higher WCU/RCU consumption + potentially higher latency under load

Multi-region strong consistency:
  Aurora Global Database: write to primary region (us-east-1)
    → global WAL (Write-Ahead Log) replicates with <1s lag to other regions
  Problem: writes MUST go to primary → us-east-1 RTT for writes from Tokyo user
    Tokyo → us-east-1 write: 160ms per write RTT (unacceptable for real-time apps)
  Solution: eventual consistency for most reads (local region), strong only for critical paths
```

**Q6: Explain how QUIC/HTTP3 reduces RTT overhead and when you should enable it on CloudFront.**

A: QUIC eliminates connection setup overhead:

TCP + TLS 1.3 (new): 1 RTT TCP + 1 RTT TLS = 2 RTTs before first byte
QUIC (new): 1 RTT TLS + connection = 1 RTT before first byte (TLS integrated into QUIC)
QUIC (returning): 0-RTT — first packet includes the HTTP request (connection ticket from last visit)

Additional QUIC advantages for RTT-sensitive applications:

- **Connection migration**: user's IP changes (mobile switching from WiFi to 4G) → TCP must re-establish (new TCP handshake = 1-2 RTTs). QUIC: connection identified by connection ID, not IP:port → 0 RTT on IP change
- **Stream-level loss recovery**: one lost UDP packet → only that stream stalls, not all streams. TCP: one lost packet blocks all streams until retransmission (HOL blocking at transport layer) → effectively adds 1 RTT for each lost packet to ALL requests
- **Particularly beneficial for**: mobile users (IP changes, lossy networks), video streaming, large file transfers

**When to enable HTTP/3 on CloudFront:**

- Always enable it (it's free, CloudFront supports it, clients fall back to HTTP/2 if needed)
- Enable at distribution level: CloudFront distribution → HTTP versions → HTTP/3
- Benefit: users on modern browsers (Chrome, Firefox, Safari) get HTTP/3 automatically
- Browsers negotiate: "Does server support 103 Early Hints?" → use Alt-Svc header to upgrade
- Non-breaking: 100% backward-compatible fallback

---

### Advanced System Design Questions

**Q7: Design a global, latency-sensitive data synchronization system for a mobile app where users should see updates within 200ms regardless of their location.**

A: This is a real-time state synchronization problem. Budget: 200ms end-to-end.

```
RTT budget allocation:
  Mobile → nearest edge: ≤ 10ms (WebSocket on AWS infrastructure)
  Edge → regional backend: ≤ 30ms (Global Accelerator private backbone)
  Backend processing: ≤ 50ms (state validation, conflict resolution)
  Regional sync to other regions: async (doesn't block response)
  Response → client: ≤ 10ms (same return path)
  Total: 100ms (with 100ms margin)

Architecture:

Layer 1: Edge Sockets (IoT Core or API Gateway WebSocket API)
  Users connect to nearest AWS edge WebSocket endpoint
  Connection mapping: connectionId → userId stored in DynamoDB/ElastiCache
  All traffic via Global Accelerator (consistent low RTT)

Layer 2: State Management (CRDTs for conflict resolution)
  Use CRDTs (Yjs, Automerge): allows concurrent edits without server coordination
  Client can apply own changes immediately (0ms perceived latency)
  Client sends operation to server → server validates → ACK → broadcast to connected clients

Layer 3: Regional broadcast
  Redis Pub/Sub (ElastiCache): subscriber per region
  When operation processed: publish to channel for that document/object
  All regional Lambda workers subscribed to channel → push to connected clients via IoT Core

Layer 4: Cross-region sync (< 1s, async, doesn't block response)
  DynamoDB Global Tables: operation log replicated across regions
  Users reconnecting to different region: read from local Global Tables replica (< 1s stale)

Conflict resolution: CRDT merge at both client (optimistic) and server (authoritative)
  If conflict detected on server: merge, return merged state (< 50ms merge operation)
  Client reconciles if server result differs from local state

Result: Local changes feel instant (CRDT optimistic), sync confirmed in < 200ms
```

**Q8: Your application's p99 latency is 2 seconds, but p50 is 50ms. What RTT-related issues could cause this and how do you diagnose?**

A: The large gap between p50 (50ms) and p99 (2 seconds) indicates "tail latency" — specific conditions that cause 1% of requests to take 40× longer than typical.

**RTT-related causes:**

1. **TCP retransmission cascade**
   - 1% of TCP segments are dropped (packet loss on the network)
   - Dropped segment: TCP waits RTO (Retransmission Timeout) = 200ms minimum (exponential backoff: 200ms, 400ms, 800ms...)
   - p99 users experience TCP retransmit = +200-800ms added to their RTT
   - Diagnosis: look for network packet loss with mtr; CloudWatch NetworkPacketsTraceIn/Out; VPC flow logs

2. **DNS cold misses**
   - 99% of users have DNS cached → 2ms
   - 1% first-time users with expired DNS → full recursive lookup → 100-500ms
   - Diagnosis: Route 53 DNS query latency metric → bimodal distribution (2ms vs 200ms)
   - Fix: increase DNS TTL, add dns-prefetch hints, shorter DNS resolution chain

3. **Lambda cold starts**
   - 99% warm invocations: 5ms overhead
   - 1% cold start: 200-2000ms (JVM especially)
   - Diagnosis: X-Ray → filter Init_Duration > 0 → those are cold starts
   - Fix: Provisioned Concurrency eliminates cold starts; or keep-warm ping every 5 minutes

4. **Database connection pool exhaustion**
   - 99% requests: get connection from pool immediately (< 1ms)
   - 1% during sudden traffic spike: pool exhausted, wait for available connection (500-2000ms)
   - Diagnosis: pool waitingCount metric; RDS DatabaseConnections at max_connections
   - Fix: increase pool size; add read replicas; circuit breaker to fail fast

5. **Garbage collection pauses**
   - JVM / .NET / Go: periodic GC pauses stop all request processing for 50-500ms
   - Diagnosis: JVM: enable GC logging; look for Stop-the-World events correlating with p99 spikes
   - Fix: tune GC heap size; use GC-less languages (Rust, Go with low pause GC); or spread load to avoid single-thread GC impact

---

## File Summary

This file covered:

- HFT co-location: firms pay millions and route fiber under mountains to gain 3ms RTT advantage
- Cloudflare Workers: moves compute to nearest edge, converting 160ms RTT to 3ms for users
- NASA deep space: standard TCP unusable at 3-22 minute RTT — requires custom protocols
- Chatty API (4 RTTs) vs compound/GraphQL API (1 RTT): 4× improvement from API design alone
- Microservice co-location: cross-region synchronous calls = 70ms × N hops
- RTT budget framework: allocate ms per tier to enforce end-to-end SLA
- Connection reuse: pool + keep-alive ÷ 2-3 RTTs per request to near-zero overhead
- Route 53 Latency-Based routing: measures actual RTT from users to AWS regions
- Global Accelerator: private backbone reduces RTT by 30-50% for non-cacheable dynamic content
- CloudFront: edge PoPs reduce HTTP RTT from 150ms+ to 5-10ms
- X-Ray: segment-level RTT breakdown, identifies which microservice hop is the bottleneck
- 8 Q&As: RTT definition, TCP vs app performance, server 10ms but still slow, real-time doc editor, consistency RTT trade-offs, QUIC HTTP/3 when to enable, real-time sync architecture, p99 tail latency diagnosis

**Continue to File 03** for AWS SAA exam traps, 5 comparison tables, Quick Revision mnemonics, and Architect Exercise.
