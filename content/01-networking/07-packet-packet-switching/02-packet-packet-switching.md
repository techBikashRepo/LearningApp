# Packet & Packet Switching — Part 2 of 3

### Topic: Real World Systems, System Design Impact, AWS Mapping & Interview Prep

**Series:** Networking Fundamentals → System Design → AWS Solutions Architect
**Audience:** 14-Year Experienced Full-Stack Developer → Becoming an Architect
**Sections Covered:** 5, 6, 7, 8

---

## SECTION 5 — Real World Examples

### Real-Life Analogy 1 — Highway vs Dedicated Private Road

**Circuit Switching = Reserved Private Road:**
Before the internet, the phone system used circuit switching. When you call someone, the telephone exchange reserves a dedicated electrical circuit end-to-end between your phone and theirs — before any voice is transmitted. That circuit stays reserved for the entire call duration, even during silences (which make up ~50% of a phone call). If 100,000 people want to call New York simultaneously and there are only 50,000 circuits, 50,000 calls fail — capacity exhausted.

The circuit is like a private road built just for you. Nobody else can drive on it. Whether you're driving (talking) or parked (silent), the road is tied up.

**Packet Switching = Shared Highway:**
The internet uses shared highways (physical cables/fiber). Everyone's data (packets) rides the same highway, taking turns. A 1-second silence in your video call doesn't block anyone else's packets. The capacity is shared dynamically — heavy Netflix traffic during prime time and your email both coexist, each getting proportional access. No reservation needed.

When the highway gets congested (peak traffic), packets queue in router buffers. Some may be dropped (TCP retransmits them). Latency increases, but no connection is flat-out refused. This is fundamentally different from circuit switching where you either get dedicated capacity or none.

---

### Real-Life Analogy 2 — Newspaper vs Magazine Printing

**Circuit switching = exclusive printing press:**
Imagine hiring a printing press exclusively for 1 hour to print a newspaper. The press is unavailable to anyone else during that hour, whether you're printing the full run or just loading the paper.

**Packet switching = shared printing press with job queue:**
A modern print shop has one press handling many jobs in a queue. Each job is split into pages (packets). Pages from different jobs are interleaved — the press doesn't wait for one full book to finish. Total throughput of the print shop is maximized. Your 200-page book and the other customer's 10-page brochure are processed concurrently with the press never sitting idle waiting for one specific job.

---

### Real Software Example — How AWS CloudFront Delivers Content via Packets

When a user in Mumbai loads a page from a US-based website served via CloudFront, here's what happens at the packet level:

**Without CloudFront (origin-only):**

- User in Mumbai → TCP SYN to origin server in US-East-1
- Round-trip latency: ~200ms (Mumbai to Virginia = physical distance)
- HTML arrives: 200ms wait
- Browser parses HTML, finds 50 assets (images, JS, CSS)
- 50 TCP connections to US-East-1, each with 200ms RTT overhead
- Page load time: 4–8 seconds

**With CloudFront (global packet delivery optimization):**

1. User's DNS query → Route 53 returns IP of nearest CloudFront edge in Mumbai
2. TCP SYN → Mumbai PoP (~5ms RTT) — TLS handshake in Mumbai
3. CloudFront Mumbai checks cache → MISS on first request
4. CloudFront Mumbai → Persistent TCP connection to US-East-1 origin (already established, no SYN overhead for each user)
5. HTML and assets served from Mumbai cache on subsequent requests

**Packet-level differences CloudFront creates:**

- TTL in IP header: packets between user and Mumbai PoP travel only ~5ms vs 200ms — fewer hops, lower TTL consumption
- TCP window: shorter round-trip = faster window ramp-up = faster convergence to full link speed (TCP slow start is lethal over long distances)
- Packet loss recovery: retransmits resolved within 5ms (Mumbai PoP) vs 400ms (full round-trip to US and back)
- Persistent connections: CloudFront pre-establishes and maintains TCP connections to origin — users never pay the 3-way handshake penalty to origin

This is why CDNs exist — they solve the physics problem of packet latency by moving content closer to users.

---

## SECTION 6 — System Design Importance

### Packet Loss and Its Cascading Effects

Packet loss is the enemy of network performance. In TCP:

- Every lost packet triggers retransmit wait + TCP congestion window reduction halving

**TCP Cubic / AIMD (Additive Increase Multiplicative Decrease):**

```
Start: window = 1 MSS
Slow start: window doubles each RTT (1 → 2 → 4 → 8 → 16...)
Congestion avoidance: window grows by 1 MSS per RTT (linear)
Packet loss detected: window halved (e.g., 64 → 32)
Recovery: grow back linearly
```

At 1% packet loss over a path with 50ms RTT, TCP throughput drops to approximately:

```
Throughput ≈ (MSS / RTT) × (1 / √loss_rate)
           ≈ (1460 / 0.050) × (1 / √0.01)
           ≈ 29,200 × 10 = 292 KB/s
```

Over a 100 Mbps link, 1% loss causes TCP degradation to ~292 KB/s = ~2.3% efficiency. This is why 0.01% loss is the production target for network infrastructure, not 1%.

**UDP under packet loss:** UDP doesn't retransmit. Packet loss manifests as:

- Video call: pixelation, freezes
- Online gaming: teleporting characters, missed inputs
- DNS: request times out (client retries)

Applications using UDP must implement their own loss recovery (or tolerate loss) — like QUIC does with per-stream recovery without blocking other streams.

---

### How Large Data Transfers Work — and What Breaks Them

**Upload a 1 GB file to S3:**
1 GB = 1,073,741,824 bytes → at 1,460 bytes per TCP segment → ~735,000 segments

For S3 uploads:

- AWS SDK uses **multipart upload** for files >100 MB
- File split into 8 MB–5 GB parts
- Each part uploaded as a separate HTTP PUT request
- Parts can be uploaded **in parallel** (multiple TCP connections)
- S3 assembles parts on the server side
- If one part fails, only that part retransmits (not the whole file)

```
1 GB file → 125 × 8MB parts
8 simultaneous connections × 8MB each
Effective upload bandwidth ≈ 8× single connection throughput
Total time: ~12 seconds at 100 Mbps vs ~80 seconds single-stream
```

**Why parallel connections help:** Each TCP connection independently ramps up its window and competes for bandwidth. 8 connections collectively demand 8× more bandwidth — effectively competing more aggressively with other traffic. Also bypasses single-stream throughput limits imposed by latency (window size × RTT = max throughput per TCP connection).

---

### QoS (Quality of Service) — Prioritizing Packets

Not all packets are equal. A voice over IP (VoIP) packet delayed by 200ms causes a voice hiccup. An email attachment packet delayed by 200ms is completely unnoticeable. QoS is the mechanism to prioritize latency-sensitive packets over bulk data.

**DSCP (Differentiated Services Code Point):** The 8-bit ToS field in the IP header (file 01, IP anatomy table) carries the DSCP value — a priority marking:

| DSCP Value | Class                | Traffic Type                                   |
| ---------- | -------------------- | ---------------------------------------------- |
| EF (46)    | Expedited Forwarding | VoIP, real-time video (highest priority)       |
| AF41–43    | Assured Forwarding 4 | Interactive video (Zoom, Teams)                |
| AF21–23    | Assured Forwarding 2 | Critical business applications                 |
| CS0 (0)    | Best Effort          | Default — email, web browsing, general traffic |

Routers and switches honor DSCP markings by placing high-priority packets in preferred queues — they're transmitted first even when the interface is congested.

**AWS and QoS:** AWS EC2 networking doesn't expose QoS controls to end users. Instead, Enhanced Networking (SR-IOV, ENA driver) and EC2 instance network performance tiers determine packet throughput. For real-time workloads, instance placement groups (cluster placement) ensure instances are on the same physical rack, minimizing packet hop count and latency.

---

### What Breaks in Production Without Understanding Packets

| Misunderstanding                                          | Production Consequence                                                                                             |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Ignoring packet loss in network design                    | Bulk transfers 10–100× slower than expected; TCP cwnd thrashing                                                    |
| MTU misconfiguration (e.g., 9000 + 1500 link in path)     | Packets silently dropped (DF bit set); mysterious connection hangs                                                 |
| Blocking ICMP on firewall                                 | PMTUD breaks — sender never learns correct MTU; connections hang for large payloads (common issue with VPNs)       |
| Not using multipart upload for large S3 objects           | Single-stream upload limited by TCP window × RTT; failure = full restart                                           |
| VPN with 1,500 MTU (adds VPN overhead, actual MTU ~1,440) | IP fragmentation cascade; performance degradation; some packets dropped                                            |
| Confusing latency and bandwidth                           | Optimizing bandwidth when latency is the bottleneck; high-bandwidth link over 200ms RTT still has slow TCP ramp-up |

---

## SECTION 7 — AWS & Cloud Mapping

### How AWS Handles Packets Internally

**AWS Nitro System — Hypervisor-Level Packet Processing:**
Traditional virtualization: packets processed by hypervisor software → CPU overhead → slower networking. AWS Nitro offloads networking to dedicated hardware (Nitro cards). The Nitro card handles:

- Packet encryption/decryption (VPC traffic isolation is encrypted between hosts)
- Packet routing (ENI → correct EC2 instance)
- VPC network enforcement (security group rules enforced in hardware)

Result: near-bare-metal networking performance. C5n instances achieve 100 Gbps network bandwidth with virtually zero CPU overhead for networking.

**Overlay Network:**
AWS VPC is an **overlay network** on top of the physical AWS infrastructure. Physical servers are connected via a physical underlay network. VPC packets are **encapsulated** in an AWS-proprietary protocol before traversal of the physical network:

```
VPC Packet (your 10.0.1.10 → 10.0.2.20)
  ↓ Wrapped in AWS overlay header
Physical Packet (172.16.x.x → 172.16.y.y — internal AWS infrastructure)
```

This encapsulation is why VPC flow logs show your logical IP addresses (10.0.x.x) while the physical network uses completely different addressing.

---

### VPC Flow Logs — Capturing Packet Metadata

VPC Flow Logs record metadata about packets flowing through EC2 ENIs, VPC, or subnet level. NOT full packet content — just the header information:

```
version  accountId  interfaceId  srcAddr   dstAddr    srcPort  dstPort  protocol  packets  bytes   start       end         action  logStatus
2        123456789  eni-abc123   10.0.1.5  10.0.2.10  49320    5432     6         10       5240    1622565501  1622565561  ACCEPT  OK
2        123456789  eni-abc123   1.2.3.4   10.0.1.5   44331    22       6         3        182     1622565601  1622565611  REJECT  OK
```

**What you can derive from flow logs:**

- Port scanning: one source IP connecting to many destination ports in short timeframe
- Data exfiltration: unexpectedly large byte counts to external IPs
- Connection failures: REJECT entries showing security group/NACL blocks
- Protocol analysis: protocol=6 (TCP), 17 (UDP), 1 (ICMP)
- Top talkers: which IPs send most bytes (bandwidth hogs)

Flow logs are stored in S3 or CloudWatch Logs, queryable via Athena (for S3) or CloudWatch Insights (for CWL). Essential for security investigations and network troubleshooting.

---

### AWS PrivateLink — Packet-Level Service Access

When using AWS PrivateLink for S3 (Gateway endpoint) or other services (Interface endpoint), packets to AWS services stay on the AWS network:

**Without VPC endpoint:**

```
EC2 (10.0.2.50)
  → Routing table: 0.0.0.0/0 → NAT Gateway
  → NAT Gateway → Internet Gateway → public internet
  → S3 API (s3.amazonaws.com = public IP)
  (Packets traverse public internet; NAT Gateway charges apply)
```

**With S3 Gateway Endpoint:**

```
EC2 (10.0.2.50)
  → Routing table: pl-XXXXX (S3 prefix list) → vpce-XXXXX (S3 endpoint)
  → Packets route directly to S3 on AWS internal network
  → Never touch internet; no NAT Gateway needed; no data transfer charges
```

S3 Gateway endpoints are FREE and reduce both cost and latency. Every VPC should have S3 and DynamoDB gateway endpoints configured — no reason not to.

---

### AWS Global Accelerator — Reducing Internet Packet Hops

Without Global Accelerator: user packets traverse the public internet all the way to your AWS region. Variable latency, packet loss at congested internet peering points.

With Global Accelerator:

- User connects to AWS edge location (anycast IP — closest PoP)
- After the AWS edge, packets travel on AWS's private global fiber backbone — not the public internet
- AWS's backbone is over-provisioned, monitored, and much more reliable than public internet

```
User in Singapore → INTERNET (hops, congestion) → US-East ALB

With Global Accelerator:
User in Singapore → AWS edge in Singapore (~5ms)
                 → AWS private backbone to US-East (~120ms)
                 → US-East ALB
Total: ~125ms vs ~180ms internet (and 60% fewer packet drops)
```

This is why gaming companies, financial services, and real-time applications use Global Accelerator — the AWS backbone is more predictable than the public internet for latency-sensitive packet flows.

---

## SECTION 8 — Interview Preparation

### BEGINNER LEVEL

**Q1: What is the difference between circuit switching and packet switching?**

_Answer:_ Circuit switching reserves a dedicated end-to-end communication path before data transmission begins. The path is held for the entire session duration — exclusive, guaranteed bandwidth, but wasteful during silences. The telephone network traditionally used circuit switching. Packet switching breaks data into independent packets, each with addressing information. Packets from different conversations share the same physical links, taking turns. No reservation is needed. The internet uses packet switching because: it's more efficient (shared infrastructure), more resilient (packets route around failures), and scales better (no capacity reservation per conversation). The trade-off: packet switching introduces variable latency (queuing at routers) and potential packet loss under congestion.

---

**Q2: What is TTL in an IP packet and why is it important?**

_Answer:_ TTL (Time To Live) is an 8-bit field in the IP header that starts at a value (typically 64 on Linux, 128 on Windows) and is decremented by 1 at every router hop. When TTL reaches 0, the router discards the packet and sends an ICMP "Time Exceeded" message back to the source. TTL prevents routing loops from circulating packets indefinitely — a misconfigured router could create a routing loop where a packet bounces forever. Without TTL, such loops would fill router queues with stale packets until the network collapses. TTL is also exploited by `traceroute`: by successively sending packets with TTL=1, 2, 3... and recording which routers send back ICMP replies, you map the exact routing path from source to destination.

---

**Q3: What is MTU and what happens when a packet exceeds it?**

_Answer:_ MTU (Maximum Transmission Unit) is the maximum payload size of a single packet on a given network link. Standard Ethernet MTU is 1,500 bytes. If an IP packet is larger than the link's MTU, it must either be fragmented (split into smaller pieces) or discarded. If the IP packet has the DF (Don't Fragment) bit set, and it exceeds the MTU, the router discards it and sends an ICMP "Fragmentation Needed" message to the sender with the link's MTU. The sender uses this feedback to reduce its packet size — this process is called Path MTU Discovery (PMTUD). In production, blocking ICMP on firewalls breaks PMTUD — causing mysterious connection hangs for large payloads (small payloads work fine; large ones are silently discarded). This is a common issue with VPN tunnels, which add headers that reduce the effective MTU.

---

### INTERMEDIATE LEVEL

**Q4: Explain TCP's sliding window mechanism. How does it affect throughput over high-latency networks?**

_Answer:_ TCP's sliding window is a flow control and performance mechanism that allows the sender to transmit multiple segments without waiting for each to be acknowledged individually. The window size represents how many bytes the sender can have "in flight" (sent but unacknowledged) at a time.

The fundamental throughput limit of a TCP connection is: `Throughput = Window_Size / RTT`

On a high-latency link (e.g., 200ms RTT to Australia), even with a 1 Gbps physical link capacity:

- Window size = 65,535 bytes (default): `65,535 / 0.200 = 327,675 B/s = 2.6 Mbps`
- Window size = 65,535 bytes on 1 Gbps link → only 2.6 Mbps used (0.26% efficiency)

Modern TCP with window scaling can use window sizes up to 1 GB, solving this for most cases. But slow start (TCP begins with a small window and grows) means every new TCP connection starts slow — particularly painful when pages load many resources with separate connections. HTTP/2 multiplexing (many requests on one TCP connection) and HTTP/3's QUIC (UDP-based, bypasses TCP slow start limitations) address this.

---

**Q5: What is QUIC and how does it improve upon TCP for packet delivery?**

_Answer:_ QUIC (Quick UDP Internet Connections) is a transport protocol developed by Google, now standardized as RFC 9000. It runs on UDP and addresses TCP's fundamental limitations:

1. **Head-of-line blocking:** In HTTP/2 over TCP, if one TCP segment is lost, all multiplexed streams stall waiting for retransmit (even though other streams' data is already in the buffer). QUIC handles retransmission per stream — loss in stream A doesn't block stream B.

2. **Connection establishment overhead:** TCP requires 1 RTT for SYN/SYN-ACK/ACK, then 1 RTT for TLS handshake = 2 RTT before first byte of data. QUIC combines connection and TLS in 1 RTT (0-RTT for resuming connections to known servers).

3. **Connection migration:** A TCP connection is tied to a 4-tuple (src IP, src port, dst IP, dst port). If your phone switches from WiFi to LTE (IP changes), TCP connection breaks — must reconnect. QUIC uses a Connection ID instead — the connection persists across IP changes.

4. **Middlebox ossification:** TCP has been extended so many times that many "middleboxes" (old firewalls, NATs) make assumptions about TCP behavior, blocking newer TCP extensions. QUIC's payload is fully encrypted — middleboxes can't interfere with protocol evolution.

HTTP/3 uses QUIC as its transport. AWS CloudFront supports HTTP/3. YouTube uses QUIC extensively. For high-latency mobile connections, QUIC provides significant measurable improvements.

---

**Q6: How does VPC Flow Logs help diagnose packet delivery issues in AWS?**

_Answer:_ VPC Flow Logs capture 5-tuple metadata (source IP, source port, destination IP, destination port, protocol) plus packet/byte counts, start/end time, and action (ACCEPT/REJECT) for traffic flowing through ENIs, subnets, or the entire VPC.

**Practical diagnostic scenarios:**

- **Security group blocking:** Flow log shows REJECT action for specific src/dst/port combination → identify which SG rule needs updating
- **NACL blocking:** If traffic appears in flow logs at the sending ENI but not at the receiving ENI → NACL on the destination subnet is dropping it
- **Asymmetric routing:** After a VPN failover, logs show traffic entering via DX but return traffic going via VPN → routing table on return path is incorrect
- **Port scanning:** A source IP attempting connections to 50+ ports in 60 seconds → security incident indicator
- **Internal lateral movement:** After a security incident, trace which IPs the compromised instance communicated with and what data volumes were transferred

Flow logs are queried using Athena for cost-effective analytics on large datasets:

```sql
SELECT srcaddr, dstaddr, dstport, SUM(bytes) as total_bytes
FROM vpc_flow_logs
WHERE action = 'ACCEPT' AND dstaddr LIKE '10.0.2.%'
GROUP BY srcaddr, dstaddr, dstport
ORDER BY total_bytes DESC
LIMIT 20;
```

This query reveals the top data flows to database subnet — useful for finding unexpected large data transfers.

---

### ADVANCED SYSTEM DESIGN LEVEL

**Q7: Design a real-time multiplayer game that needs <30ms end-to-end latency globally. How do packets play a role?**

_Ideal Thinking Approach:_

**The physics problem:**
Speed of light in fiber: ~200,000 km/s. New York to London: ~5,500 km. Minimum latency: 27.5ms each way = 55ms round-trip. We need <30ms — physics is the constraint for transatlantic gameplay. Players must be in the same region for <30ms guarantee.

**Protocol choice — UDP, not TCP:**

- Games use UDP because TCP retransmission is incompatible with real-time requirements
- A dropped game state packet at T=0ms should NOT block new packets at T=50ms
- Game state at T=100ms is MORE useful than the retransmitted T=0ms packet
- Games use application-level "ordering" with timestamps, not TCP reliability
- Lost packets are accepted — game extrapolates (client-side prediction) and corrects when next packet arrives

**Packet structure for game state:**

```
UDP Datagram payload:
  [timestamp: 4 bytes]
  [sequence: 4 bytes]
  [player_positions: N × 16 bytes (x,y,z + rotation)]
  [events: variable (shots, actions)]
Typical game state packet: 100–500 bytes
Rate: 20–60 per second per player
```

**AWS architecture for <30ms globally:**

- GameLift (AWS game server management) in multiple regions
- Route 53 GameLift FleetIQ or latency-based routing → nearest region
- UDP game servers on EC2 with Enhanced Networking (ENA) and SR-IOV
- Placement groups (cluster) to minimize intra-game-server latency
- Global Accelerator for edge entry → AWS private backbone for inter-region coordination (matchmaking, leaderboards)

**Client-server vs P2P:**

- P2P: each player sends game state to all others directly over internet — variable paths, no control over routing
- Client-server: all players send to/receive from game server — server is authoritative; AWS optimizes paths from each player to nearest server; cheating prevention (server validates)

**Anti-cheat at packet level:** Server validates claimed player positions. If a player teleports 100m in one tick, server ignores the claimed position and overrides with the last valid position × max speed × time delta.

---

**Q8: A customer reports their application works fine for small requests but hangs for large file uploads (>2MB). You suspect MTU issues. How do you diagnose and fix?**

_Ideal Thinking Approach:_

**Classic signature of MTU/PMTUD failure:**

- Small requests (<1,500 bytes, fit in one packet): work perfectly
- Large requests (multiple packets): hang or timeout
- The hang often happens after 3-way handshake and TLS — during actual data transfer

Root cause: somewhere in the network path, a link has an MTU smaller than 1,500 bytes (common with VPN tunnels, VXLAN overlays, PPPoE DSL connections). The sender (EC2 or client) has DF=1 set and sends 1,500-byte packets. An intermediate router can't forward them and needs to fragment. Since DF=1, it drops the packet and sends ICMP "Fragmentation Needed." But if ICMP is blocked by a security group or firewall, the sender never receives this feedback and keeps retransmitting the same oversized packet — connection hangs.

**Diagnosis Steps:**

1. **Reproduce with size threshold:**
   - `curl -v --max-filesize 1000 https://api/upload` → works
   - `curl -v --max-filesize 3000 https://api/upload` → hangs
     Confirms it's packet-size related, not timeout or auth.

2. **Check MTU on path:**

   ```bash
   # From client, ping with DF bit and decreasing sizes to find MTU
   ping -M do -s 1472 api.example.com  # 1472 data + 28 header = 1500
   ping -M do -s 1400 api.example.com  # 1400 + 28 = 1428 — if 1472 fails but 1400 works
   # Keep bisecting to find exact MTU
   ```

3. **Check ICMP is not being blocked:**
   - AWS Security Group: ensure ICMP is permitted from the network path
   - NACL: ensure ICMP is allowed

4. **Check VPN overhead:**
   If traffic goes through a VPN, the VPN adds ~40-60 bytes of header overhead. If the VPN-facing interface sends 1,500-byte packets but the underlying network MTU is 1,500, the VPN-wrapped packet is 1,540 bytes → fragmentation. Fix: set VPN MTU to 1,440 (1,500 - VPN overhead).

5. **Fix options:**
   - **Fix ICMP blocking** (correct long-term fix): allow ICMP "Type 3, Code 4" (Fragmentation Needed) through security groups and NACLs. In AWS SG: add inbound rule for ICMP All traffic if source is restricted.
   - **Lower TCP MSS (MSS clamping):** Configure the load balancer or server to announce a smaller MSS in TCP SYN — sender respects this and uses smaller packets from the start. `iptables -A FORWARD -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu`
   - **Jumbo frames end-to-end** (within VPC): configure all EC2 instances to use jumbo frames (9,001 bytes MTU) on their ENIs — only works within a VPC, not across internet.

---

## File Summary

This file connected packet theory to real-world performance and AWS implementation:

- Circuit switching vs packet switching: reserved private road vs shared efficient highway
- TCP packet loss effects: 1% loss → 10× throughput reduction; why 0.01% is target
- MTU problems in production: VPN overhead, ICMP blocking, PMTUD failure diagnosis
- AWS multipart upload: parallel TCP streams for large object transfers
- QoS / DSCP marking: VoIP packets prioritized over email at the router queue level
- AWS Nitro: hardware-level packet processing; VPC as overlay network
- VPC Flow Logs: diagnosing ACCEPT/REJECT at packet level with Athena queries
- Global Accelerator: AWS private backbone replaces unpredictable internet hops
- QUIC: UDP-based transport solving TCP head-of-line blocking and handshake latency
- Game server architecture: UDP for real-time packets, client prediction, anti-cheat

**Continue to File 03** for AWS Certification Focus, Comparison Tables, Quick Revision, and the Architect Thinking Exercise.
