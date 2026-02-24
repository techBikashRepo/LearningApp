# Latency vs Bandwidth vs Throughput — Part 1 of 3

### Topic: Understanding Latency, Bandwidth, and Throughput at the architectural level

**Series:** Networking Fundamentals → System Design → AWS Solutions Architect
**Sections Covered:** 1, 2, 3, 4

---

## SECTION 1 — ELI12: The Simple Story

### What are Latency, Bandwidth, and Throughput?

Imagine you need to move water from one city to another.

**Latency** is how long one drop of water takes to travel from the source to the destination. If the pipe is 100 km long and water flows at 100 km/h, latency = 1 hour. It doesn't matter if your pipe is huge or tiny — a single water molecule still takes 1 hour. Latency is about _time_ and _distance_.

**Bandwidth** is how wide the pipe is. A narrow pipe (let's say 2 cm) can carry a thin stream of water. A massive pipe (1 meter wide) can carry a river. Bandwidth is the _maximum potential_ capacity — how much _could_ flow if everything was running at full blast. It's a ceiling, not a guarantee.

**Throughput** is how much water _actually_ arrives per hour. Maybe your pipe is 1 meter wide (huge bandwidth), but half the pipe is blocked by sediment. Actual throughput = 50% of bandwidth. Or maybe there's a pump failure upstream. Throughput is what reality delivers — it's always equal to or less than bandwidth.

### The Three in One Picture

```
Source ────────────────────────────────────────────────── Destination
  │                                                             │
  │◄──────────────── LATENCY: 100ms ───────────────────────────►│
  │                                                             │
  │═══════════════ BANDWIDTH: 100 Mbps (pipe width) ═══════════│
  │                                                             │
  │─────────────── THROUGHPUT: 72 Mbps (actual flow) ──────────│
  │                 (limited by retransmits, slow receiver,     │
  │                  protocol overhead, congestion)             │
```

### The Road Analogy (remember this one forever)

Imagine a 10-lane highway from London to Edinburgh (640 km):

- **Latency**: The time for ONE car to drive London → Edinburgh. Speed limit = 130 km/h → ~4.9 hours. Doesn't matter if you have 10 lanes or 1 lane — the travel time for one car is the same.
- **Bandwidth**: The maximum number of cars that _can_ travel simultaneously. 10 lanes × 100 cars per lane = 1,000 cars in transit at any given moment. This is capacity.
- **Throughput**: How many cars _actually_ arrive in Edinburgh per hour. If there's a traffic jam at the M1 merge point (congestion), maybe only 200 cars/hour arrive instead of the theoretical 1,000.

**Key insight:** You can widen the highway (more bandwidth) without making any individual car faster. But if you add a faster speed limit (faster network link), latency drops. These are independent dimensions.

---

## SECTION 2 — Core Technical Deep Dive

### Latency Defined and Decomposed

Latency = total time for one unit of data (one packet) to travel from source to destination.

**4 components of latency:**

```
Total Latency = Propagation Delay + Transmission Delay + Processing Delay + Queueing Delay

1. Propagation Delay (physics — can't optimize beyond physics)
   = Distance / Speed of light in medium
   Speed of light in vacuum:        299,792 km/s
   Speed of light in fiber:         ~200,000 km/s (refractive index ≈ 1.5)
   Speed of light in copper:        ~200,000 km/s (similar)

   New York → London (6,000 km):
     Propagation delay = 6,000 / 200,000 = 0.030 seconds = 30ms ONE WAY
     Round trip (RTT) = 60ms minimum (physics, cannot beat this with any optimization)

   New York → Singapore (15,000 km):
     Propagation delay = 15,000 / 200,000 = 0.075 seconds = 75ms ONE WAY
     RTT = 150ms minimum

2. Transmission Delay (time to push bits onto the wire)
   = Packet Size (bits) / Link Bandwidth (bps)

   1500-byte packet on 1 Gbps link:
     = (1500 × 8 bits) / 1,000,000,000 bps
     = 12,000 / 1,000,000,000
     = 0.000012 seconds = 12 microseconds

   On a slow 1 Mbps link:
     = 12,000 / 1,000,000 = 12ms

   On 1 Gbps: this component is negligible (< 1ms for typical packets)
   On congested or slow links (satellite, IoT): significant

3. Processing Delay (routers, firewalls, switches doing work on packet)
   = Time for each network device to examine, route, and forward packet
   Modern router: 1–50 microseconds per hop
   Firewall with deep packet inspection: 1–5ms per hop
   10-hop path: 0.1ms–50ms of processing delay

4. Queueing Delay (most variable — the main cause of jitter)
   = Time packet spends waiting in buffer/queue at congested points
   No congestion: 0ms (packet exits immediately)
   Moderate traffic: 1–20ms
   Congested router: 100–1000ms (severe tail latency issues)

   Queueing delay causes "jitter" = variation in latency
   Real-time video/gaming: jitter > 30ms = noticeable disruption
```

### Bandwidth Defined

Bandwidth = maximum data transfer rate of a link (theoretical ceiling).

**Common link bandwidths:**

```
Link Type                  Bandwidth
─────────────────────────────────────────────
Dial-up (56K modem)        56 Kbps
ADSL home internet         10–100 Mbps
Cable internet             100–1,000 Mbps
4G LTE mobile              10–100 Mbps
5G mobile                  100–10,000 Mbps
Enterprise fiber (office)  1 Gbps
AWS Direct Connect         1 Gbps / 10 Gbps
AWS instance (c6gn)        100 Gbps
AWS VPC intra-AZ           Up to 25 Gbps per instance
AWS VPC cross-AZ           Limited by instance ENI BW
Internet backbone           100–400 Gbps per link
```

**Bandwidth ≠ what you get.** Protocol overhead consumes 1–10% of bandwidth. TCP slow start limits throughput initially. Retransmissions waste bandwidth. Multiple users share bandwidth (contentious).

### Throughput Defined

Throughput = actual data transfer rate measured end-to-end.

**Throughput < Bandwidth, always.** Why?

```
Throughput limiters (in order of impact):

1. TCP Slow Start and Congestion Control
   TCP starts a new connection cautiously:
   - Round 1: send 1 segment
   - Round 2: send 2 segments (if ACK received → double it)
   - Round 3: send 4 segments
   - Continues until congestion window (cwnd) reaches ssthresh
   - Then grows linearly (congestion avoidance)

   On a 100 Mbps link with 100ms RTT:
     Time to reach full bandwidth: several seconds of ramp-up
     Throughput for a 50KB file: < 10% of link capacity (never reaches full speed)
     Throughput for a 10GB file: eventually near 100% (after slow start completes)

2. Window Size limits throughput (Throughput = Window / RTT)
   TCP throughput formula:
     Max Throughput = Window Size / RTT

     1 Gbps link, 100ms RTT, default 64KB TCP window:
       Max throughput = 65,535 bytes / 0.1 sec = 655,350 bytes/sec = ~5.2 Mbps
       (Not 1 Gbps! The 64KB window is the bottleneck!)

     Fix: TCP window scaling (RFC 1323)
       Windows up to 1 GB possible with window scaling
       Modern OS: window scaling enabled by default

   Throughput = Window / RTT is the BDP formula (Bandwidth-Delay Product key insight)

3. Retransmissions: dropped packets must be re-sent → wastes bandwidth + adds latency
4. Header overhead: TCP/IP/Ethernet headers = ~54 bytes per 1460-byte payload = ~3.5%
5. Half-duplex links: can't send and receive simultaneously (old Ethernet, some wireless)
6. Receiver processing: if receiver is too slow to process, it reduces TCP window (flow control)
```

### Bandwidth-Delay Product (BDP) — The Critical Formula

```
BDP = Bandwidth × Round-Trip Latency

This is the number of bits "in flight" simultaneously on a network path.

Example:
  Bandwidth: 1 Gbps (1,000,000,000 bps)
  RTT: 100ms (0.1 seconds)
  BDP = 1,000,000,000 × 0.1 = 100,000,000 bits = 12,500,000 bytes = 12.5 MB

To fully utilize a 1 Gbps link with 100ms RTT:
  TCP window must be ≥ 12.5 MB
  If window is only 64 KB (65,535 bytes): max throughput = 64KB/100ms = 5.2 Mbps
  You're utilizing only 0.52% of a 1 Gbps link!

This is why long-distance high-bandwidth links need special TCP tuning (jumbo windows)
This is why CDN matters: CDN brings data close → reduces RTT → TCP window sufficient → full throughput
```

---

## SECTION 3 — ASCII Diagram

### Complete Visualization

```
                     LATENCY vs BANDWIDTH vs THROUGHPUT
                     ════════════════════════════════════

┌─── Latency: Time for ONE PACKET to travel ─────────────────────────────┐
│                                                                         │
│  Sender                                                     Receiver   │
│    │      ←──────────── 100ms RTT (30ms each way) ──────────────►  │   │
│    │      ←── propagation 28ms ──── processing 2ms ────────────►  │   │
│    │                                                                │   │
│    │  A single tear of water droplet: time = fixed by physics      │   │
└─────────────────────────────────────────────────────────────────────────┘

┌─── Bandwidth: PIPE WIDTH (maximum capacity) ───────────────────────────┐
│                                                                         │
│  1 Gbps link:                                                           │
│  ████████████████████████████████████████████████  (wide pipe)         │
│                                                                         │
│  1 Mbps link:                                                           │
│  █  (narrow pipe)                                                       │
│                                                                         │
│  NOTE: Wider pipe does NOT = faster for small messages                  │
└─────────────────────────────────────────────────────────────────────────┘

┌─── Throughput: ACTUAL FLOW (always ≤ Bandwidth) ───────────────────────┐
│                                                                         │
│  Bandwidth:   ████████████████████████████  100 Mbps capacity          │
│  Throughput:  ████████████████░░░░░░░░░░░░   72 Mbps actual            │
│               ←───────────────► ←──────────►                           │
│                   actual flow    "wasted" by:                          │
│                                  - TCP overhead                        │
│                                  - Retransmissions                     │
│                                  - Slow start ramp                     │
│                                  - Window size limit                   │
└─────────────────────────────────────────────────────────────────────────┘

┌─── BDP: Bits in Flight on a Long-Haul Link ────────────────────────────┐
│                                                                         │
│  New York ──────────────────────────────── Singapore                   │
│            ←──────── 150ms RTT ────────────►                           │
│            ←── 15,000 km ────────────────►                             │
│                                                                         │
│  1 Gbps link: BDP = 1 Gbps × 0.15s = 150 Mb = 18.75 MB "in flight"    │
│                                                                         │
│  ●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●  = 18.75 MB      │
│  packets that have been sent but not yet acknowledged                  │
│  TCP window must be THIS large to keep the pipe full                   │
└─────────────────────────────────────────────────────────────────────────┘

┌─── Latency vs Bandwidth for Different File Sizes ──────────────────────┐
│                                                                         │
│  Transfer time = Latency(RTT) + FileSize/Throughput                     │
│                                                                         │
│  File Size  │  1 Mbps + 100ms RTT │  1 Gbps + 100ms RTT                │
│  ───────────┼─────────────────────┼──────────────────────              │
│  1 KB       │  100ms + 8ms = 108ms│  100ms + 0.008ms = 100ms           │
│  100 KB     │  100ms + 800ms = 900ms│ 100ms + 0.8ms = 101ms            │
│  10 MB      │  100ms + 80s = 80s  │  100ms + 80ms = 180ms             │
│  1 GB       │  100ms + 8000s = ~2h │ 100ms + 8000ms = 8.1s            │
│                                                                         │
│  For SMALL files: latency dominates (even fast 1 Gbps = 100ms)         │
│  For LARGE files: bandwidth dominates (1 Mbps = 2 hours for 1 GB!)     │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## SECTION 4 — Step-by-Step Flow

### Scenario 1 — Why Your API Calls Feel Slow (even on gigabit internet)

```
Setup: Developer has 1 Gbps fiber. Company API server is in us-east-1.
Developer is in Sydney, Australia. RTT to us-east-1: ~250ms.

Developer: "GET /users/123" (tiny request, 200-byte response)

Transfer time:
  = RTT + payload/bandwidth
  = 250ms + (200 bytes × 8 bits) / 1,000,000,000 bps
  = 250ms + 0.0016ms
  = 250.0016ms

The bandwidth (1 Gbps) is irrelevant! The 250ms RTT dominates entirely.

If developer makes a web page with 50 API calls (waterfall, no parallelism):
  Total time = 50 × 250ms = 12,500ms = 12.5 SECONDS

Fix: Parallelism + CDN
  Parallelism: Promise.all([50 concurrent API calls]) → 250ms (all in parallel)
  CDN regional cache: RTT Sydney→Sydney PoP = 5ms
  Total: 5ms (CDN), or 250ms (1 parallel round trip)

Real-world lesson:
  Latency matters most for small, frequent requests (API calls, DNS lookups)
  Bandwidth matters most for large transfers (file uploads, video streaming, S3 copies)
```

### Scenario 2 — TCP Window Bottleneck on a Satellite Link

```
Setup: Remote oil platform uses VSAT satellite internet.
Bandwidth: 20 Mbps (plenty of bandwidth)
Latency: 600ms RTT (geostationary satellite is 35,786 km above earth)

Attempting to download a 10MB software update via HTTP:

TCP window (default): 64 KB = 65,535 bytes
Maximum throughput = window / RTT = 65,535 / 0.6 sec = 109,225 bytes/sec = ~873 Kbps

Actual bandwidth: 20 Mbps
Utilized: 873 Kbps / 20,000 Kbps = 4.3%!

96% of the 20 Mbps satellite link is WASTED due to the small TCP window.
The 10MB download takes: 10,000,000 / 109,225 = 91 seconds instead of 10/20 = 4 seconds

Fix: TCP window scaling
  OS setting (Linux): sysctl -w net.core.rmem_max=134217728  (128 MB window)
  Optimal window = BDP = 20 Mbps × 0.6s = 12,000,000 bits = 1.5 MB
  With 1.5 MB window: throughput = 1,500,000 / 0.6 = 2,500,000 bytes/sec = 20 Mbps ✓
  Download time: 10MB / 20 Mbps = 4 seconds (as expected from bandwidth)

This is why BBCP, FASP (Aspera), and S3 multipart transfer all use parallel streams —
each stream has its own window and TCP congestion control.
S3 multipart: 8 parallel connections × (window/RTT) per connection = 8× throughput
```

### Scenario 3 — CDN Reduces Latency and Improves Throughput Together

```
Scenario: Video streaming, user in Frankfurt, server in us-east-1.

WITHOUT CDN:
  Source: us-east-1 (Virginia, USA)
  User: Frankfurt, Germany
  RTT: ~90ms
  Bandwidth (AWS → user): 1 Gbps
  BDP = 1 Gbps × 0.09s = 90 Mb = 11.25 MB

  For smooth 4K video: need 15-25 Mbps sustained throughput
  TCP window needs: 25 Mbps × 0.09s = 2.25 Mb = 281 KB (achievable, but slow start!)

  Initial TCP slow start: starts at 1 segment (1 MSS ≈ 1460 bytes)
  Time to reach 25 Mbps: logarithmic ramp-up over several RTTs
  User experience: buffering at start (especially for <5 second clips)

WITH CloudFront CDN (Frankfurt PoP 2ms from user):
  RTT: 4ms (user ↔ Frankfurt edge)
  BDP = 1 Gbps × 0.004s = 4 Mb = 0.5 MB window needed (easily supported)

  TCP slow start: much faster ramp-up (4ms per doubling vs 90ms)
  25 Mbps reached after: log2(25/1.5) × 4ms = 4 × 4ms = 16ms (vs 4 × 90ms = 360ms)

  User experience: video starts instantly, no buffering for typical clips

  Bonus: CloudFront pre-fetches and caches the video at the edge.
  If 100 users in Frankfurt watch the same video: 1 pull from origin (us-east-1),
  99 served from edge cache. Origin traffic drops 99%.
```

### Scenario 4 — Measuring the Three Metrics

```
Tools for each metric:

LATENCY:
  ping: ICMP round-trip time (network layer only, not TCP/TLS overhead)
    ping api.shop.com            → 45ms average, shows jitter

  traceroute/tracert: per-hop latency (shows which hop is slow)
    mtr api.shop.com             → shows % packet loss + latency per hop

  curl: full HTTP latency (all phases)
    curl -w "TTFB: %{time_starttransfer}s\nTotal: %{time_total}s" https://api.shop.com

BANDWIDTH:
  speedtest.net / speedtest-cli: measures bandwidth to nearest test node
    speedtest-cli --simple        → Ping: 14ms, Download: 948 Mbps, Upload: 897 Mbps

  iperf3: measures bandwidth between two specific hosts (useful for server-to-server tuning)
    Server: iperf3 -s
    Client: iperf3 -c server-ip -t 30    → shows ~900 Mbps if 1 Gbps link with tuned window

THROUGHPUT:
  Actual observed throughput when transferring data:
    dd if=/dev/zero bs=1M count=1000 | ssh remote "cat > /dev/null"
    Windows robocopy with /bytes flag: shows bytes/sec

  Application-level throughput:
    How many HTTP requests/sec with acceptable p99 latency?
    wrk -t12 -c400 -d30s http://api.shop.com/products
    → Requests/sec: 8,420.14
    → Latency 99th: 234.15 ms
    This is throughput + latency simultaneously
```

---

## File Summary

This file covered:

- Water pipe and highway analogies for latency (time), bandwidth (pipe width), throughput (actual flow)
- 4 components of latency: propagation (physics), transmission (packet size / link speed), processing (router hops), queueing (congestion/jitter)
- Speed of light in fiber = 200,000 km/s; NY-London propagation = 30ms one way (60ms minimum RTT)
- Bandwidth: theoretical ceiling; common link speeds from 56Kbps dial-up to 100 Gbps AWS instances
- Throughput: always ≤ bandwidth; limited by TCP slow start, window size, retransmissions, receiver speed
- BDP (Bandwidth × Delay Product): the number of bits "in flight" = minimum TCP window to fully utilize a link
- TCP throughput formula: Throughput = Window / RTT
- Latency dominates for small files; bandwidth dominates for large files
- Satellite TCP window bottleneck: 20 Mbps link used at 4% due to 600ms RTT with 64KB default window
- CDN reduces RTT → faster TCP slow start ramp → achieves full throughput in milliseconds vs seconds
- Measurement tools: ping/mtr for latency, speedtest/iperf3 for bandwidth, wrk/curl for throughput

**Continue to File 02** for real-world examples, system design patterns, AWS mapping, and 8 interview Q&As.
