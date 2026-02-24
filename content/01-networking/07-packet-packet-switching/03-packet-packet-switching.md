# Packet & Packet Switching — Part 3 of 3

### Topic: AWS Certification Focus, Comparison Tables, Quick Revision, Architect Exercise

**Series:** Networking Fundamentals → System Design → AWS Solutions Architect
**Audience:** 14-Year Experienced Full-Stack Developer → Becoming an Architect
**Sections Covered:** 9, 10, 11, 12

---

## SECTION 9 — AWS & Certification Focus

### AWS SAA Exam — Packets Must-Know Facts

**Enhanced Networking:**
AWS provides two types of enhanced networking to optimize packet processing on EC2 instances:

1. **ENA (Elastic Network Adapter):** Supports up to 100 Gbps network bandwidth. Available on most current-gen instance families (C5, M5, R5, etc.). Uses SR-IOV (Single Root I/O Virtualization) to bypass the hypervisor for networking — the NIC communicates directly with the driver, eliminating software overhead per packet.

2. **Intel 82599 VF (ixgbevf):** Older, supports 10 Gbps. Used on older instance types.

**Exam: What instance types support 100 Gbps?** C5n (n = network optimized), P4d (ML compute), inf1 (inference). For the exam: choose "network-optimized instances" for bandwidth-intensive workloads.

---

### Jumbo Frames in AWS

Default Ethernet MTU: 1,500 bytes. AWS supports **Jumbo Frames (9,001 bytes MTU)** within a VPC for supported instance types using the ENA driver.

**When to use Jumbo Frames:**

- Large data transfers within the same VPC (EC2 to EC2, EC2 to EFS, HPC workloads)
- Reduces CPU overhead: with 1,500-byte MTU, 1 GB transfer = 699,050 frames × (interrupt, scheduling overhead). With 9,001-byte MTU = 116,509 frames → 6× fewer interrupts
- EFA (Elastic Fabric Adapter) for HPC/ML training: requires Jumbo Frames

**When Jumbo Frames are NOT supported:**

- Traffic through Internet Gateway: standard internet MTU (1,500 bytes); any packet >1,500 is fragmented or dropped with DF=1
- VPC Peering cross-region: standard 1,500 MTU
- Direct Connect: 1,522 bytes max frame size (just above Ethernet standard due to VLAN tags)
- Site-to-Site VPN: limited by IPsec overhead; effective payload MTU ~1,400 bytes

**Exam trap:** HPC cluster with EFA (Jumbo Frames enabled) won't achieve full performance if some instances don't have ENA/EFA drivers or the AMI doesn't support it. Also, traffic leaving the VPC loses Jumbo Frame support.

---

### VPC Flow Logs — Exam Facts

- Flow Logs can be created at: ENI level, Subnet level, VPC level
- Flow Logs are NOT real-time — there is a delay (typically 10–15 minutes to S3/CWL delivery)
- Flow Logs capture METADATA only — not packet payload content
- Enabling/disabling Flow Logs has NO impact on network performance or bandwidth
- Flow Logs do NOT capture traffic to/from: 169.254.169.254 (IMDS), 169.254.169.123 (Amazon Time Sync), DHCP traffic, DNS queries to Route 53 Resolver
- For real-time packet capture: use Traffic Mirroring (mirrors actual packet content to an ENI for analysis)

**Traffic Mirroring vs Flow Logs:**
| Feature | VPC Flow Logs | Traffic Mirroring |
|---------|-------------|-----------------|
| Content | Metadata only (5-tuple + counts) | Full packet content (headers + payload) |
| Latency | Delayed (10–15 minutes) | Near real-time |
| Storage | S3 or CloudWatch Logs | Sent to ENI on monitoring instance |
| Cost | Low | Higher (requires monitoring instance, bandwidth) |
| Use case | Audit, troubleshooting | Deep packet inspection, IDS/IPS, forensics |

---

### AWS Network Performance Tiers

EC2 instance network performance directly determines how many packets per second (PPS) and bandwidth (Gbps) an instance can handle:

| Instance family | Network Bandwidth           | Use Case                             |
| --------------- | --------------------------- | ------------------------------------ |
| t3.micro        | Up to 5 Gbps (burstable)    | Development, light workloads         |
| m5.xlarge       | Up to 10 Gbps               | General-purpose applications         |
| c5.4xlarge      | Up to 10 Gbps               | Compute-intensive, high request rate |
| c5n.18xlarge    | 100 Gbps                    | Network-intensive, big data, HPC     |
| p4d.24xlarge    | 400 Gbps (4 × 100 Gbps EFA) | ML training distributed workloads    |

**Exam:** "An application is receiving high network latency even with sufficient CPU/memory." → Consider upgrading to a network-optimized instance (c5n). Network bandwidth is a separate constraint from CPU/memory.

---

### AWS Services That Work at Packet Level

| Service            | Packet Behavior                                                                    |
| ------------------ | ---------------------------------------------------------------------------------- |
| Internet Gateway   | Performs 1:1 NAT for Elastic IPs; doesn't fragment; routes public IP ↔ private IP  |
| NAT Gateway        | PAT (Port Address Translation); manages connection table; 5 Gbps base, 45 Gbps max |
| ALB                | Terminates TCP/TLS; rebuilds TCP connection to backend; operates at L7             |
| NLB                | TCP/UDP pass-through; does NOT terminate TCP; source IP preserved; 100 Gbps+       |
| Global Accelerator | Anycast routing; moves user packets to AWS edge → AWS backbone transition          |
| VPC Flow Logs      | Observes packet metadata at ENI/subnet/VPC — passive, no packet modification       |
| Traffic Mirroring  | Copies complete packets to monitoring destination — full forensic capture          |
| AWS WAF            | Inspects L7 HTTP packets; blocks based on rules (SQL injection, XSS, rate limits)  |
| AWS Shield         | Absorbs DDoS floods — volumetric UDP/TCP floods absorbed at AWS scrubbing centers  |

---

## SECTION 10 — Comparison Tables

### Table 1: Circuit Switching vs Packet Switching

| Dimension               | Circuit Switching                                 | Packet Switching                              |
| ----------------------- | ------------------------------------------------- | --------------------------------------------- |
| Path setup              | Dedicated path established before data            | No setup — packets route independently        |
| Resource allocation     | Reserved for entire session (even during silence) | Shared dynamically on demand                  |
| Bandwidth efficiency    | Low (idle circuits waste capacity)                | High (statistical multiplexing)               |
| Failure handling        | Entire call fails if any link fails               | Packets reroute around failures automatically |
| Latency consistency     | Consistent (dedicated path, no queuing)           | Variable (queuing at congested routers)       |
| Maximum connected users | Limited by number of circuits                     | Limited by total bandwidth (shared)           |
| Historical use          | PSTN (telephone networks), ISDN                   | Internet, TCP/IP networks, AWS                |
| Modern relevance        | Legacy MPLS (circuit-like VPNs)                   | All cloud networking, internet                |

---

### Table 2: TCP vs UDP vs QUIC — Packet-Level Comparison

| Dimension             | TCP                                   | UDP                           | QUIC                         |
| --------------------- | ------------------------------------- | ----------------------------- | ---------------------------- |
| Transport             | IP                                    | IP                            | UDP (on top of UDP)          |
| Connection setup      | 3-way handshake (1 RTT)               | None                          | 1 RTT (0-RTT for resumption) |
| Reliability           | Guaranteed (retransmit)               | Best-effort                   | Per-stream retransmit        |
| Ordering              | Ordered delivery                      | No ordering                   | Per-stream ordering          |
| Head-of-line blocking | Yes (all streams blocked by one loss) | N/A                           | No (per-stream)              |
| Flow control          | Yes (sliding window)                  | No                            | Yes (per-stream)             |
| Encryption            | Via TLS (separate handshake)          | Via DTLS (separate handshake) | Integrated TLS 1.3           |
| Connection migration  | No (bound to 4-tuple)                 | N/A                           | Yes (Connection ID)          |
| Use cases             | HTTP/1, HTTP/2, SMTP, databases       | DNS, VoIP, gaming, NTP        | HTTP/3, Google services      |
| AWS support           | All services                          | NLB (UDP), Route 53, NTP      | CloudFront HTTP/3            |

---

### Table 3: Ethernet Frame vs IP Packet vs TCP Segment

| Element         | Ethernet Frame (L2)               | IP Packet (L3)                     | TCP Segment (L4)                         |
| --------------- | --------------------------------- | ---------------------------------- | ---------------------------------------- |
| Purpose         | Hop-to-hop delivery               | End-to-end routing                 | Reliable byte stream                     |
| Address used    | MAC (48-bit hardware)             | IP (32-bit logical)                | Port (16-bit)                            |
| Changes per hop | New MAC addresses each router hop | Unchanged source/dst IP end-to-end | Unchanged ports end-to-end               |
| Max size        | 1,500 bytes payload + headers     | 65,535 bytes total                 | Limited by IP packet (MSS ≈ 1,460 bytes) |
| Error detection | FCS (Frame Check Sequence)        | Header checksum only               | Full header+data checksum                |
| Key fields      | Dst MAC, Src MAC, EtherType       | TTL, Protocol, Src IP, Dst IP      | Seq#, ACK#, Flags, Window                |

---

### Table 4: MTU Values in Different AWS Network Contexts

| Network Context                     | MTU          | Notes                                                    |
| ----------------------------------- | ------------ | -------------------------------------------------------- |
| Internet (standard Ethernet)        | 1,500 bytes  | Universal; never exceed this for internet-bound traffic  |
| VPC within same region (EC2 to EC2) | 9,001 bytes  | Jumbo frames supported; requires ENA driver              |
| VPC Peering (same region)           | 9,001 bytes  | Jumbo frames supported                                   |
| VPC Peering (cross-region)          | 1,500 bytes  | Standard MTU for cross-region                            |
| Internet Gateway                    | 1,500 bytes  | Ingress/egress to internet; excess fragmented or dropped |
| Direct Connect                      | 1,522 bytes  | 1,500 payload + VLAN tag overhead                        |
| Site-to-Site VPN (IPsec)            | ~1,400 bytes | IPsec adds ~60–100 bytes overhead to each packet         |
| EFA (HPC workloads within VPC)      | 9,001 bytes  | Required for optimal MPI performance                     |

---

### Table 5: VPC Packet Path — Where Inspection Happens

| Location in VPC        | What Inspects Packets             | Type                             | Stateful?            |
| ---------------------- | --------------------------------- | -------------------------------- | -------------------- |
| EC2 ENI                | Security Group                    | Instance-level firewall          | Yes (stateful)       |
| Subnet boundary        | Network ACL (NACL)                | Subnet-level ACL                 | No (stateless)       |
| VPC route              | Route Table                       | Routing decision only            | N/A                  |
| Load Balancer (ALB)    | AWS WAF (optional)                | L7 HTTP inspection               | Session-based        |
| VPC → Internet         | Internet Gateway                  | NAT/routing only — no filtering  | N/A                  |
| All traffic (optional) | Gateway Load Balancer + appliance | Deep packet inspection (IDS/IPS) | Depends on appliance |
| ENI (optional)         | Traffic Mirroring                 | Forensic copy — passive          | Passive              |

---

## SECTION 11 — Quick Revision & Memory Tricks

### 10 Key Points — Packet & Packet Switching

1. **A packet = header + payload** — The header carries addressing and control information (IP src/dst, TTL, protocol); payload carries application data. Encapsulation layers each header around the one above: Ethernet wraps IP wraps TCP wraps HTTP.

2. **Packet switching vs circuit switching: shared highway vs reserved road** — Packet switching is the foundation of the internet; circuit switching was the telephone system. Packets are more efficient, resilient, and scalable.

3. **MTU = 1,500 bytes on Ethernet** — The maximum payload of one frame. Larger data is fragmented (broken into multiple packets). In AWS VPCs, Jumbo Frames (9,001 bytes) reduce CPU overhead for large internal transfers. Traffic leaving VPC reverts to 1,500 bytes.

4. **TTL prevents routing loops** — Every router decrements TTL by 1. At 0, packet is discarded; ICMP Time Exceeded sent back. `traceroute` exploits this to map network paths.

5. **Sequence numbers are TCP's reliability foundation** — Every byte in a TCP stream has a sequence number. Receiver sends ACK of next expected byte. Gaps trigger retransmit. Out-of-order packets are buffered and reordered before delivery to application.

6. **TCP throughput = window size / RTT** — High bandwidth + high latency is still slow without a large window. Window scaling (RFC 1323) allows >64 KB windows. This is why CDNs and Global Accelerator matter — they reduce RTT.

7. **1% packet loss → TCP throughput drops ~10× or more** — TCP's congestion control halves the window on each loss event. Design networks targeting <0.01% packet loss in production.

8. **QUIC solves TCP's key limitations** — Per-stream retransmit (no head-of-line blocking), 1-RTT connection setup, connection migration across IPs. HTTP/3 uses QUIC. CloudFront supports HTTP/3.

9. **VPC Flow Logs = packet metadata without payload** — Captures 5-tuple + bytes + action (ACCEPT/REJECT). Essential for security investigation and troubleshooting. Does NOT capture IMDS, DHCP, or DNS traffic. Traffic Mirroring captures full packet content.

10. **Blocking ICMP breaks PMTUD** — ICMP "Fragmentation Needed" messages are required for Path MTU Discovery. Blocking them causes large packet flows to hang mysteriously. Never block ICMP Type 3 Code 4 in production security groups or NACLs.

---

### 30-Second Explanation

"A packet is a small, independently routable chunk of data — typically 1,500 bytes or less — containing a header with addressing info and a payload with actual data. The internet uses packet switching: data is broken into packets, each routed independently across shared infrastructure, then reassembled at the destination. This is far more efficient than circuit switching (dedicated reserved paths). Packets have multiple layers: Ethernet (MAC addresses, hop-to-hop), IP (IP addresses, end-to-end routing, TTL), TCP (ports and sequence numbers for reliable ordered delivery). In AWS, VPC Flow Logs capture packet metadata, jumbo frames optimize internal transfers, and NACLs require explicit rules for return traffic's ephemeral port range."

---

### Memory Tricks

**"Packet = Letter in an Envelope in a Mailbag"**

- Letter (TCP payload) → envelope (TCP segment with address/return address/sequence) → mailbag (IP packet with routing addresses) → truck box (Ethernet frame with next-hop MAC)

**"TTL = Time To Leave" (not Live)**

- Decrements per hop → "you've overstayed your welcome" at 0 → discarded

**"QUIC = Quick and Unblocked In Channel"**

- Per-stream retransmit: one bad stream doesn't block others (unlike TCP)
- Q = no-queue blocking, U = UDP-based, I = Integrated TLS, C = Connection migration

**"MTU 1500 = One and a Half Thousand Maximum Transfer Unit"**

- Standard Ethernet = 1,500 bytes — memorize this; it appears everywhere

**"PMTUD Blocked = Pages Mysteriously Timeout Until Debugged"**

- Blocking ICMP kills PMTUD; large payloads mysteriously fail while small ones work fine

**"Flow Logs = Five-Tuple Only" (no payload content)**

- Source IP, Source Port, Destination IP, Destination Port, Protocol — that's it for metadata capture

**"Sequence Numbers = TCP's Page Numbers"**

- Like a book: sequence numbers track which pages (bytes) have been received; ACKs say "send me page 501 next"

---

### Exam Quick-Fire

- What is the standard Ethernet MTU? 1,500 bytes
- What is the AWS VPC Jumbo Frame MTU? 9,001 bytes
- What happens when a packet with DF=1 exceeds the link MTU? Dropped; ICMP Fragmentation Needed sent to source
- What AWS feature enables full packet capture (not just metadata)? Traffic Mirroring
- What protocol does traceroute exploit? ICMP (via TTL decrement → ICMP Time Exceeded replies)
- Does enabling VPC Flow Logs slow network packets? No — it's passive monitoring, zero performance impact
- What transport does HTTP/3 use? UDP (QUIC)
- Why is packet loss more damaging for TCP than UDP? TCP halves congestion window and retransmits; throughput plummets; UDP just drops the packet
- What ICMP type/code must be allowed for PMTUD? Type 3, Code 4 (Destination Unreachable: Fragmentation Needed)
- What's the effective MTU for traffic through a Site-to-Site VPN? ~1,400 bytes (IPsec encapsulation overhead)

---

## SECTION 12 — Architect Thinking Exercise

### Exercise: Design a Video Streaming Platform (Like Prime Video) — Packet Delivery Architecture

Your company is launching a streaming platform targeting 5 million concurrent viewers globally, with the following requirements:

- 4K video = ~25 Mbps per stream
- HD video = 5 Mbps per stream
- SD video = 1.5 Mbps per stream
- Average viewer: HD (5 Mbps)
- Maximum acceptable buffering: 2 seconds (single rebuffer allowed per 30-minute session)
- Cost constraint: minimize egress costs while maintaining quality
- Global: viewers in Americas, Europe, and Asia-Pacific

**Calculate the numbers:**

- 5 million viewers × 5 Mbps = 25 Tbps peak egress
- Origin servers serving this directly? Impossible — no single data center has 25 Tbps internet uptime

**Think About:**

1. How do you serve 25 Tbps without a single mega-server?
2. What determines whether a viewer gets smooth playback or buffering?
3. What happens at the packet level when a viewer's connection degrades?
4. How do you optimize packet delivery for mobile viewers switching between WiFi and LTE?
5. What AWS services form the delivery architecture?

---

### Solution Walkthrough

**Step 1 — Distributed Packet Delivery (CDN Architecture)**

No single origin can serve 25 Tbps. Solution: distribute the content. AWS CloudFront has 450+ points of presence (PoPs) globally. Each PoP caches video segments and serves them locally:

- 5M viewers → each viewer connects to nearest CloudFront PoP (avg ~20ms RTT)
- PoP serves cached video segments — NO origin traffic for cached content
- 95%+ of traffic served from edge cache (popular content = high cache hit rate)
- Origin (S3 + MediaPackage) serves only cache misses and new content

**Packet math at edge:**

- 5M viewers × 5 Mbps / 450 PoPs = ~55 Gbps per PoP
- Large PoPs (NY, London, Tokyo) serve 200+ Gbps — well within capacity

**Step 2 — Video Format: Adaptive Bitrate Streaming (HLS/DASH)**

Video is NOT delivered as one continuous stream. It's broken into 2–10 second segments, each available in multiple quality levels:

```
https://cdn.example.com/movie/
  360p/1.ts, 360p/2.ts, ...   (500 Kbps)
  720p/1.ts, 720p/2.ts, ...   (3 Mbps)
  1080p/1.ts, 1080p/2.ts, ... (8 Mbps)
  4K/1.ts, 4K/2.ts, ...       (25 Mbps)
```

The player measures available bandwidth every few seconds and requests the appropriate quality level for the next segment. This is done via HTTP GET requests for each segment — these are plain HTTP packets served by CloudFront.

**Packet-level behavior of adaptive bitrate:**

- Good connectivity: player requests 1080p segments → 8 Mbps × 10s = 80 MB per segment fetch
- Congestion: player downloads next segment slower than real-time → buffer shrinks → player downgrades to 720p → 30 MB per segment → buffer recovers
- Why 2-10 second segments? Short enough to react to bandwidth changes; long enough to amortize HTTP request overhead

**Step 3 — Mobile Viewers (QUIC / HTTP/3)**

Mobile viewers switch between WiFi and LTE constantly. TCP connections break on IP change (new IP on LTE vs WiFi). QUIC (HTTP/3) uses Connection IDs — the video stream continues uninterrupted through the network transition:

```
Viewer on WiFi (192.168.1.5) watching video → QUIC connection to CloudFront
Viewer moves → IP changes to LTE (172.20.5.100)
QUIC: Connection ID still valid → segment delivery continues seamlessly
TCP: Connection terminated → player reconnects → re-buffer for 2–3 seconds
```

AWS CloudFront supports HTTP/3 (QUIC) — enable it to improve mobile viewer experience.

**Step 4 — Packet Loss Handling and Buffering**

The player maintains a video buffer (typically 30–120 seconds of content pre-downloaded). This is the key resilience mechanism against packet loss:

- Normal operation: buffer stays at 60+ seconds ahead; occasional packet loss → TCP retransmit within 50ms → transparent
- Congestion event: buffer size decreases; player triggers quality downgrade
- Severe loss: buffer depletes → rebuffering event (player pauses, shows spinner)

Designing for the 2-second rebuffer requirement:

- Target 30+ seconds of buffer → tolerate 30 seconds of complete outage before rebuffer
- CloudFront PoPs close to viewers minimize RTT → faster TCP ramp-up → buffer fills faster on initial load

**Step 5 — Full Packet Architecture**

```
  Viewer in Tokyo                      Viewer in New York
  on mobile (QUIC)                     on WiFi (HTTP/2)
        │                                    │
        │ UDP/QUIC port 443                  │ TCP port 443
        ▼                                    ▼
  CloudFront PoP Tokyo               CloudFront PoP NY
  (Cache: 98% hit rate)              (Cache: 98% hit rate)
        │                                    │
        │ Cache miss: HTTPS to origin        │
        ▼                                    ▼
  AWS backbone → S3 (us-east-1) ← ── MediaConvert/MediaPackage
                                    (Transcodes source video
                                     into HLS/DASH segments
                                     at all bitrates)
                                    Stored in S3
```

**The packet math check:**

- 5M concurrent × 5 Mbps × 0.02 cache miss rate = 500 Gbps origin traffic
- S3 and MediaPackage in us-east-1: multiple AZs, designed for Tbps throughput
- Origin: 500 Gbps well within AWS regional capacity
- Edge: 24.5 Tbps served from CloudFront cache (no origin cost)

**Cost optimization:**

- CloudFront to viewer: $0.085/GB (more than S3 direct, but mandatory for latency)
- S3 to CloudFront: $0.00/GB within same region (Amazon free tier for S3 CloudFront origin)
- Reserved capacity pricing for CloudFront at 5M viewers scale: significant discounts

This is how Netflix, Amazon Prime Video, Disney+, and all major streaming platforms work at the packet architecture level.

---

## Complete Series Summary — Packet & Packet Switching

| File    | Sections | Key Takeaways                                                                                                                                                                                                                  |
| ------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| File 01 | 1–4      | Packet = address header + data payload; packet switching vs circuit switching; Ethernet/IP/TCP anatomy; TTL; MTU and fragmentation; PMTUD; full OSI-layer journey                                                              |
| File 02 | 5–8      | CDN = packet physics optimization; TCP packet loss → throughput collapse; PMTUD failure diagnosis; multipart S3 upload; QoS/DSCP; AWS Nitro packet processing; Flow Logs queries; QUIC advantages; video game UDP architecture |
| File 03 | 9–12     | ENA/Jumbo Frames in AWS; MTU table by network type; Flow Logs vs Traffic Mirroring; TCP/UDP/QUIC comparison tables; memory tricks; video streaming platform (Netflix-architecture) packet delivery design                      |

---

**Networking Fundamentals Series — Topic Completion Status:**

| Topic | Title                       | Status      |
| ----- | --------------------------- | ----------- |
| 01    | What is a Network           | ✅ Complete |
| 02    | LAN vs WAN vs Internet      | ✅ Complete |
| 03    | Public IP vs Private IP     | ✅ Complete |
| 04    | IP Address Structure (IPv4) | ✅ Complete |
| 05    | Ports & Sockets             | ✅ Complete |
| 06    | Router vs Switch            | ✅ Complete |
| 07    | Packet & Packet Switching   | ✅ Complete |

**Suggested Next Topics:**

- Topic 08: DNS — How domain names resolve to IP addresses, Route 53, DNS record types
- Topic 09: TCP/IP Three-Way Handshake — SYN, SYN-ACK, ACK in depth
- Topic 10: Load Balancing — L4 vs L7, round-robin, least-connections, consistent hashing
