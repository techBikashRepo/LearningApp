# Round Trip Time (RTT) — Part 1 of 3

### Topic: Understanding RTT, Its Components, and Its Impact on All Network Protocols

**Series:** Networking Fundamentals → System Design → AWS Solutions Architect
**Sections Covered:** 1, 2, 3, 4

---

## SECTION 1 — ELI12: The Simple Story

### What is RTT?

Imagine you and your friend are on opposite sides of a large lake. You shout "HELLO!" across the water, and wait to hear your friend shout "HELLO!" back.

**RTT** (Round Trip Time) is the total time from when you shouted to when you heard the echo — the time it took for your voice to travel TO your friend AND for their response to travel BACK to you.

```
  You ──── "HELLO!" ──────────────────────► Friend
  You ◄─── "HELLO!" ──────────────────────  Friend

  Time for both legs = RTT
```

If your shout takes 2 seconds to cross the lake and their response takes 2 seconds to return, RTT = 4 seconds.

### Why Does RTT Matter So Much?

Every time your computer talks to a server on the internet, this exact thing happens — many times:

1. Your computer says "Can we talk?" → server says "Yes!" → **1 RTT just to set up the connection**
2. Your computer says "Prove you're really Amazon" → server sends credentials → **1 RTT for security**
3. Your computer says "Give me the products page" → server sends the page → **1 RTT for actual data**

Before you even see a single product on the Amazon page: **3 RTTs have already passed.**

If you're in Sydney and the server is in New York, each RTT is about 200ms. So:

- 3 RTTs × 200ms = 600ms just in protocol overhead before any real content!

This is why **"closeness matters"** — CDN (Content Delivery Network) puts servers closer to you. Sydney → Sydney edge server = 5ms RTT, so 3 RTTs = 15ms. That's 40× faster!

### Two Analogies

**Analogy 1 — Mountain Echo**
You shout toward a mountain cliff. The RTT is how long until you hear the echo. A cliff 170 meters away: sound travels at 340 m/s → 0.5 seconds one-way → 1 second RTT. You cannot make the echo faster by shouting louder (more bandwidth). You can only reduce RTT by moving closer to the cliff (CDN) or finding a shortcut (private backbone network).

**Analogy 2 — Letter Exchange Between Pen Pals**
You write a letter and mail it. Your pen pal replies as soon as they receive it. RTT = time you sent it to time you received their reply. This is exactly how TCP acknowledgments work: your computer sends a packet, the server acknowledges it, RTT = time until you receive the ACK.

---

## SECTION 2 — Core Technical Deep Dive

### RTT Components

```
RTT = 2 × (Propagation Delay + Transmission Delay + Processing Delay + Queueing Delay)
     = 2 × One-Way Latency

For practical purposes in system design:
  RTT ≈ round-trip network time as measured by ping or TCP timing

Component breakdown (NYC → London example):
  Propagation: 28ms each way (6,000 km / 200,000 km/s in fiber)
  Transmission: 0.012ms (1500-byte packet on 1 Gbps link — negligible)
  Processing:   2ms (multiple router hops: ~10 hops × 0.2ms avg)
  Queueing:     2ms typical (minimal off-peak, up to 200ms during congestion)

  One-way: 32ms → RTT ≈ 64ms
  Measured ping NY → London: typically 70-90ms (routing indirect paths add overhead)
```

### RTT Budget in Common Protocols

Every protocol "costs" a certain number of RTTs before useful data can flow:

```
Protocol     Connection RTTs   Notes
──────────────────────────────────────────────────────────────────────
TCP          1 RTT             SYN → SYN-ACK → ACK (3 messages, 1 RTT to establish)
TLS 1.2      2 RTT             ClientHello + ServerHello (1) + Finished (1)
TLS 1.3      1 RTT             ClientHello+key_share, ServerHello+cert+Finished
TLS 1.3 0-RTT 0 RTT            Session resumption with PSK (pre-shared key)
HTTP/1.1     1 RTT per request  (+ TCP + TLS setup overhead)
HTTP/2       1 RTT for all      Single TCP connection, multiplex streams
HTTP/3+QUIC  1 RTT             New connection (QUIC on UDP)
HTTP/3 0-RTT  0 RTT            Reconnection with prior session key
DNS          1 RTT             UDP query → UDP response (usually 1 RTT)
DNS recursive 3-5 RTT          If cache miss: query root → TLD → auth
```

### RTT × Protocol Overhead = Real World Impact

```
Scenario: User in London (70ms RTT to server in us-east-1)
Loading https://api.shop.com/products (first visit):

Step 1: DNS resolution
  Browser checks local cache: MISS
  OS resolver: MISS
  ISP resolver: queries authoritative: 1 RTT to US NS = 70ms
  Total DNS: ~70ms

Step 2: TCP handshake: 1 RTT = 70ms
Step 3: TLS 1.2 handshake: 2 RTT = 140ms
Step 4: HTTP GET request + response: 1 RTT = 70ms

Total RTTs: 5 RTTs × 70ms = 350ms before user sees content
Plus server processing: ~30ms
Total: ~380ms

With TLS 1.3 (1 RTT TLS):
  DNS + TCP + TLS + HTTP = 4 RTTs × 70ms = 280ms (saves 1 RTT = 70ms)

With TLS 1.3 + HTTP/2 session resumption (0-RTT TLS on return visit):
  DNS (cached) + TCP + TLS0-RTT+HTTP = 2 RTTs × 70ms = 140ms

With CDN (London PoP, 5ms RTT):
  DNS + TCP + TLS + HTTP = 4 RTTs × 5ms = 20ms ← 19× faster!
  Plus origin fetch (one-time, cached after): 380ms (first user only)
```

### How RTT Is Measured

```
Tool 1: ping (ICMP RTT — network layer only, not TCP/TLS)
  ping amazon.com
  → Reply from 54.239.17.6: time=8ms TTL=55
  → 8ms RTT (just ICMP, no TCP handshake overhead)

  Note: Some hosts block ICMP → 100% packet loss ≠ host is down

Tool 2: traceroute (per-hop RTT, find slow hops)
  tracert amazon.com (Windows) / traceroute amazon.com (Linux/Mac)
  Output: each hop shows 3 measured RTTs

  Reading traceroute:
    Consistent latency jump at hop 8: that's where your traffic crosses the internet
    Large jump at hop 12: could be a slow international link
    * * * at hop 5: that router doesn't respond to ICMP (doesn't mean data doesn't pass)

Tool 3: mtr (combines ping + traceroute, real-time with loss%)
  mtr --report amazon.com
  Shows: per-hop latency + packet loss %, excellent for identifying flaky hops

Tool 4: curl (HTTP-layer RTT including all protocol overhead)
  curl -w "\nTime: %{time_total}s\nConnect: %{time_connect}s\nTTFB: %{time_starttransfer}s\n" \
    -o /dev/null -s https://api.amazon.com
  → time_connect = TCP RTT (1 RTT to complete handshake)
  → time_appconnect - time_connect = TLS RTT cost
  → time_starttransfer - time_appconnect = HTTP RTT + server processing

Tool 5: AWS Route 53 Health Checks
  Configure health check → Route 53 measures HTTP RTT from its global locations
  Use to measure your service latency from each region's perspective
```

### TCP and RTT: Slow Start Revisited

```
TCP uses RTT for its congestion control clock:

  cwnd doubles every RTT during slow start:
    RTT 1: send 1 segment (1 × MSS = 1460 bytes)
    RTT 2: send 2 segments (2 × 1460 = 2920 bytes)
    RTT 3: send 4 segments (4 × 1460 = 5840 bytes)
    RTT 4: send 8 segments (8 × 1460 = 11680 bytes)
    ...

  For a 1 MB file over 70ms RTT link:
    Time to increase cwnd to full window: ~7 RTTs = 490ms ramp-up
    Time to actually transfer data at full window: negligible (LAN speeds)
    Total: mostly ramp-up overhead!

  For a 100 byte API response over 70ms RTT:
    Never even reaches slow start end — single packet fits in initial window
    Transfer time = 1 RTT = 70ms (plus server processing)

  This is why short-lived HTTP/1.1 connections waste so much time:
    Every new connection pays TCP slow start from scratch
    HTTP/2 + keep-alive: one connection per server, slow start pays once
```

### RTT in Database Queries

```
RTT matters inside your application too:

Application server → Redis (same AZ): RTT = 0.3ms
Application server → RDS (same AZ): RTT = 1ms

Pipeline of database calls (sequential):
  SELECT user FROM users WHERE id=123;        → 1ms RTT
  SELECT preferences WHERE user_id=123;       → 1ms RTT
  SELECT cart WHERE user_id=123;              → 1ms RTT
  SELECT addresses WHERE user_id=123;         → 1ms RTT
  → 4 queries × 1ms = 4ms DB time

  But with 1ms network RTT each:
    4 queries × (1ms query + 1ms RTT) = 8ms total

  If app server is in us-east-1, DB in us-west-2 (70ms RTT):
    4 queries × (1ms query + 70ms RTT) = 284ms! (35× slower!)

  Fix: DB in same AZ/same region as application
  Fix: Batch queries → 1 request, 1 RTT: SELECT * FROM users, preferences, cart... WHERE user_id=123 (JOIN)
  Fix: Redis pipeline → send 4 commands without waiting for each ACK → 1 RTT total for 4 commands
```

---

## SECTION 3 — ASCII Diagram

```
                        RTT EXPLAINED
                        ══════════════

┌───────────────────────────────────────────────────────────────────┐
│                     One Round Trip                                │
│                                                                   │
│  Client                                                Server     │
│    │                                                     │        │
│    │──── Request (72 bytes) ────────────────────────────►│ T=0ms  │
│    │     (travels at ~200,000 km/s in fiber)             │        │
│    │                                               ┌─────┘        │
│    │                                               │ Server       │
│    │                                               │ processes    │
│    │                                               │ request      │
│    │                                               │ (1-50ms)     │
│    │                                               └─────┐        │
│    │◄─── Response/ACK (52 bytes) ─────────────────────── │ T=RTT  │
│    │                                                     │        │
│    RTT = T(response arrives) - T(request sent)                    │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘

┌───────────────────────────────────────────────────────────────────┐
│                     RTT Accumulation in HTTPS                     │
│                                                                   │
│  Browser              DNS              Server              CDN    │
│    │                   │                 │                  │     │
│    │──DNS query────────►│                 │                  │     │
│    │◄──DNS reply────────│ ← 1 RTT (70ms) │                  │     │
│    │                   │                 │                  │     │
│    │──────────TCP SYN──────────────────►│                  │     │
│    │◄─────────SYN-ACK───────────────────│ ← 1 RTT (70ms)  │     │
│    │──────────ACK──────────────────────►│                  │     │
│    │                                    │                  │     │
│    │──────────ClientHello──────────────►│                  │     │
│    │◄─────────ServerHello+Cert─────────── ← 1 RTT (70ms)  │     │
│    │──────────Finished─────────────────►│ (TLS 1.3)       │     │
│    │                                    │                  │     │
│    │──────────GET /products────────────►│                  │     │
│    │◄─────────200 OK + data─────────────│ ← 1 RTT (70ms)  │     │
│    │                                    │                  │     │
│    │   Total RTTs × 70ms = 4×70 = 280ms │                  │     │
│    │   With CDN (5ms RTT): 4×5ms = 20ms │                  │     │
└───────────────────────────────────────────────────────────────────┘

┌───────────────────────────────────────────────────────────────────┐
│                RTT Impact on TCP Throughput                       │
│                                                                   │
│  Different RTTs, same bandwidth (1 Gbps), same window (64KB):    │
│                                                                   │
│  5ms RTT:   ████████████████████████████████████  ~100 Mbps      │
│  50ms RTT:  █████████████                         ~10 Mbps       │
│  150ms RTT: ████                                  ~3.4 Mbps      │
│  600ms RTT: █                                     ~0.85 Mbps     │
│                                                                   │
│  Formula: Throughput = Window(64KB×8bits) / RTT(seconds)         │
│  5ms:    524,280 / 0.005 = 104,856,000 bps ≈ 100 Mbps           │
│  600ms:  524,280 / 0.600 =    873,800 bps ≈ 0.85 Mbps           │
│                                                                   │
│  Lesson: Same bandwidth, 120× difference in throughput            │
│          due to 120× difference in RTT                            │
└───────────────────────────────────────────────────────────────────┘

┌───────────────────────────────────────────────────────────────────┐
│                 QUIC/HTTP3 vs TCP+TLS RTT Comparison              │
│                                                                   │
│  TCP + TLS 1.3 (new connection):                                  │
│  T=0ms    ─── TCP SYN ────────────────────────────────►           │
│  T=RTT    ◄── TCP SYN-ACK ─────────────────────────────          │
│  T=RTT    ─── TLS ClientHello (combined with ACK) ────►           │
│  T=2RTT   ◄── TLS ServerHello+Cert+Finished ────────────         │
│  T=2RTT   ─── HTTP Request (0-RTT possible on TLS resume) ─►      │
│  Total new: 2 RTT before first byte                               │
│                                                                   │
│  QUIC + HTTP/3 (new connection):                                  │
│  T=0ms    ─── QUIC ClientHello (1-RTT) ───────────────►           │
│  T=RTT    ◄── QUIC ServerHello + HTTP response ─────────         │
│  Total new: 1 RTT before first byte                               │
│                                                                   │
│  QUIC 0-RTT (returning connection):                               │
│  T=0ms    ─── QUIC 0-RTT data (HTTP request) ─────────►          │
│  T=RTT    ◄── HTTP response ────────────────────────────          │
│  Total returning: 0 RTT connection overhead!                      │
└───────────────────────────────────────────────────────────────────┘
```

---

## SECTION 4 — Step-by-Step Flow

### Scenario 1 — Counting RTTs in a GraphQL Request

```
User in Singapore (150ms RTT to us-east-1) makes a GraphQL query
to fetch user profile + cart + recommendations (N+1 anti-pattern to fix):

GraphQL query: { user { profile cart recommendations } }

Server-side resolver with N+1 (bad):
  Step 1: SELECT * FROM users WHERE id=123
          → 1 RTT to RDS (1ms) = 1ms
  Step 2: SELECT * FROM carts WHERE user_id=123
          → 1 RTT to RDS (1ms) = 1ms
  Step 3: for each cart item: SELECT * FROM products WHERE id=?
          → 10 items × 1 RTT = 10ms
  Step 4: SELECT * FROM recommendations WHERE user_id=123
          → 1 RTT to ML service (5ms) = 5ms

  Total server processing: 17ms (13 DB round trips at 1ms each)

  But these are server-side RTTs (same-AZ, 1ms each). Client RTT is 150ms.
  Client sees: 150ms (network) + 17ms (server) = 167ms per page request

  With N+1 to cross-region DB (DB in us-west-2, app in us-east-1, 70ms between them):
    13 DB RTTs × 70ms = 910ms server processing!
    + 150ms client network = 1060ms per GraphQL request

Optimized GraphQL (DataLoader batching — all DB queries in 1 round trip):
  Step 1: Batch all user IDs → single SELECT * FROM users WHERE id IN (123)
  Step 2: Batch all cart items → single SELECT * FROM products WHERE id IN (1,2,...,10)
  Step 3: Batch recommendations → single SELECT

  Total DB RTTs: 3 (vs 13 before)
  Server processing with same-region DB: 3ms (was 17ms)
  Server processing with cross-region DB: 3 × 70ms = 210ms (was 910ms)

Lesson: each cross-service RTT compounds; minimizing N+1 = minimizing RTT overhead
```

### Scenario 2 — Why 0-RTT Matters for Mobile Users

```
Mobile user in Frankfurt opens your news app after 10 minutes idle:

Scenario A: HTTP/1.1 (worst case)
  Every page refresh opens NEW TCP connection:
  DNS (cold): 50ms
  TCP SYN/SYN-ACK: 1 RTT = 20ms (Frankfurt PoP is close)
  TLS 1.2 full handshake: 2 RTT = 40ms
  HTTP GET: 1 RTT = 20ms
  Total: 130ms before first byte of content

  If they refresh 50 article pages in 30 minutes:
    50 × 130ms = 6,500ms wasted just in connection overhead

Scenario B: HTTP/2 with keep-alive (good case)
  First page: same as above = 130ms
  Subsequent pages: no new TCP/TLS (connection reused)
  HTTP GET: 1 RTT = 20ms
  50 pages: 130ms + 49 × 20ms = 1,110ms connection overhead = 84% improvement

Scenario C: HTTP/3 + QUIC (returning user, 0-RTT)
  First page (ever): 1 RTT (QUIC) + 1 RTT (HTTP) = 40ms
  Returning user (0-RTT): HTTP request included in first packet
    = 0 connection overhead + 1 RTT for response = 20ms!
  50 pages: 20ms first + 49 × 20ms = 1,000ms = equivalent to HTTP/2
  But: no per-connection RTT overhead even after idle (QUIC 0-RTT)

  Mobile advantage: QUIC handles packet loss at stream level
  If one packet drops: only THAT stream retransmits
  TCP: all streams in the connection stall until retransmission (HOL blocking)

AWS: CloudFront supports HTTP/3 (enable in distribution settings)
```

### Scenario 3 — RTT in Distributed Microservices

```
Payment processing service makes 6 sequential calls:
  Each internal service: same region, 1ms RTT
  Total internal RTT cost: 6 × 1ms = 6ms

  Service calls (sequential):
    1. AuthService.validateToken()      → 5ms (Redis lookup)   + 1ms RTT = 6ms
    2. UserService.getCustomer()        → 8ms (DB query)       + 1ms RTT = 9ms
    3. FraudService.checkTransaction()  → 45ms (ML inference)  + 1ms RTT = 46ms
    4. InventoryService.reserveItem()   → 12ms (DB + lock)     + 1ms RTT = 13ms
    5. PaymentGateway.charge()          → 200ms (external API) + 2ms RTT = 202ms (external!)
    6. OrderService.createOrder()       → 10ms (DB write)      + 1ms RTT = 11ms

  Total sequential: 6 + 9 + 46 + 13 + 202 + 11 = 287ms

  Optimization: parallelize where possible (calls 1, 2, 3 don't depend on each other):
    Phase 1 (parallel): AuthService + UserService + FraudService
      → takes MAX(6ms, 9ms, 46ms) = 46ms
    Phase 2 (sequential, needs Phase 1 results): InventoryService
      → 13ms
    Phase 3: PaymentGateway + OrderService (OrderService depends on payment)
      → 202ms + 11ms = 213ms (sequential within phase 3)

    Total with parallelism: 46 + 13 + 213 = 272ms (vs 287ms — marginal gain here)
    But if FraudService was 150ms: sequential = 391ms, parallel = 376ms... still similar

    The real win: the EXTERNAL PaymentGateway dominates. Can't parallelize it.
    To improve: pre-validate fraud + auth before even starting the payment flow
    Or: timeout payment gateway quickly (5s max) → retry → circuit breaker

Key lesson: RTT optimization within the data center is <10ms total;
  external service calls are where RTTs of 100-300ms hide
```

---

## File Summary

This file covered:

- Mountain echo and pen pal letter analogies for RTT
- RTT = 2 × one-way latency; components: propagation, transmission, processing, queueing
- Physics minimum NY-London = 30ms one-way (~60ms RTT minimum)
- Protocol RTT budget: TCP=1, TLS 1.2=2, TLS 1.3=1, TLS 1.3 0-RTT=0, HTTP/1.1=1/request, QUIC=1 new/0 returning
- First HTTPS visit: 4-5 RTTs accumulated before content starts flowing
- TCP throughput = Window / RTT: 64KB window at 600ms RTT = 0.85 Mbps on 1 Gbps link
- Measuring RTT: ping (ICMP), traceroute (per-hop), mtr (continuous), curl (HTTP layer), Route 53 health checks
- DB RTT matters: 4 sequential queries × 70ms cross-region RTT = 280ms vs 4ms same-AZ
- TCP slow start clock: every RTT, cwnd doubles — high RTT = slow ramp-up = poor throughput for bulk transfers
- GraphQL N+1: 13 DB RTTs vs 3 with DataLoader batching
- HTTP/2 keep-alive eliminates per-request TCP+TLS RTT overhead (84% improvement for multi-request users)
- QUIC/HTTP3: 1 RTT new, 0 RTT return; eliminates connection overhead for returning mobile users

**Continue to File 02** for real-world examples, system design patterns, AWS mapping, and 8 interview Q&As.
