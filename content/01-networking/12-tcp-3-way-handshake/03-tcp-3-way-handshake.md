# TCP 3-Way Handshake — Part 3 of 3

### Topic: AWS SAA Exam Traps, Comparison Tables, and Architecture Exercise

**Series:** Networking Fundamentals → System Design → AWS Solutions Architect
**Sections Covered:** 9, 10, 11, 12

---

## SECTION 9 — AWS SAA Certification Focus

### Core AWS Connection Management Mapping

| TCP Handshake Concept          | AWS Service/Feature                           | Key Detail                                                              |
| ------------------------------ | --------------------------------------------- | ----------------------------------------------------------------------- |
| SYN proxy (absorbs SYN floods) | ALB + NLB                                     | LB completes 3-way handshake; backend sees only established connections |
| TLS termination                | ALB, NLB (TLS listener), CloudFront           | ACM cert; backend can be HTTP or TLS                                    |
| Connection draining            | Target group deregistration delay             | ALB waits for existing HTTP requests; NLB waits for TCP connections     |
| Idle connection timeout        | ALB: 60s default (max 4000s); NLB: 350s fixed | Connections idle beyond limit are dropped                               |
| Connection pool to backend     | ALB: reuses connections to targets            | Reduces new TCP handshakes to backends                                  |
| SOURCE IP preservation         | NLB (yes), ALB (no — uses X-Forwarded-For)    | NLB passes client IP at TCP layer                                       |
| SYN flood protection           | AWS Shield Standard (free)                    | Absorbs Layer 3/4 SYN floods before reaching your infra                 |
| TLS 1.3                        | ALB, CloudFront, NLB (TLS listener)           | Supported — check Security Policy settings                              |

---

### Critical Exam Traps

**Trap 1 — ALB Idle Timeout Default is 60 Seconds**

The default ALB idle timeout is 60 seconds. For WebSocket applications, real-time dashboards, long-polling, or database connections through ALB, this creates silent connection drops.

Symptom: WebSocket clients unexpectedly disconnect every 60 seconds. Error: "WebSocket connection closed."
Root cause: WebSocket that's silent for 60 seconds gets dropped by ALB (idle timeout).
Fix: Increase ALB idle_timeout to match application needs (max 4000 seconds).

This is distinct from NLB's 350-second idle timeout. Both are exam-testable.

**Trap 2 — Security Groups Must Allow Established Connections Return Traffic**

Security groups are stateful — they automatically allow return traffic for established connections. IMPORTANT: this applies to the TCP connection as a whole, not individual flags.

A SYN packet from client creates an entry in the stateful table → the SYN-ACK (outbound from server) is automatically allowed without an explicit outbound rule.

If the question uses a **NACL (stateless)** instead: you must explicitly allow both directions — including the ephemeral port range for return traffic. NACLs evaluate each packet independently with no state tracking.

Exam trick: "Connection established but responses not getting back" → check NACL (stateless) not security group (stateful).

**Trap 3 — Connection Draining: ALB vs NLB Behavior Difference**

- ALB (Layer 7): understands HTTP request boundaries. During deregistration, ALB allows in-flight HTTP requests to complete before removing the target. It does NOT send new requests.
- NLB (Layer 4): does NOT understand HTTP. During deregistration, NLB stops routing new TCP connections to the target. Existing TCP connections remain open until they close naturally or timeout.

Practical difference: if a user's HTTP request spans 45 seconds (a long download) and you deregister the ALB target with 60s delay, ALB completes the request. With NLB, the TCP connection stays open, so the download continues too — but NLB can't distinguish "request in progress" from "idle connection."

**Trap 4 — NLB Does Not Modify Source IP in Security Group Rules**

When traffic flows through an NLB, the **source IP remains the original client IP** (not the NLB's IP). Your EC2 target group instances' security groups must allow the client CIDR range, not the NLB CIDR.

With ALB: ALB uses its own IP to connect to backend. Backend SG allows ALB CIDR (or ALB's security group).
With NLB: NLB is transparent at Layer 4. Backend SG must allow client CIDR ranges (or `0.0.0.0/0` if public).

Exam scenario: "EC2 behind NLB not receiving traffic" → check if EC2 security group allows client IPs, not just NLB IPs.

**Trap 5 — TCP Handshake in VPC Peering and Transit Gateway**

VPC peering and Transit Gateway are transparent to TCP — once the underlying routing is configured, TCP connections work normally. But:

- VPC peering does NOT support **overlapping CIDR ranges** — the 4-tuple would be ambiguous
- Transit Gateway supports overlapping CIDRs only with careful route table design
- TCP connections through VPC peering stay within AWS backbone — extremely low RTT (~0.3ms inter-AZ, ~1ms inter-region)

---

### AWS Shield and SYN Flood

| Shield Tier                   | SYN Flood Protection                                 | Coverage                     |
| ----------------------------- | ---------------------------------------------------- | ---------------------------- |
| Shield Standard (free)        | HTTP/HTTPS SYN flood (CloudFront, Route 53, ALB)     | All AWS customers, automatic |
| Shield Advanced ($3000/month) | All protocols + DDoS Response Team + WAF integration | Opt-in, advanced protection  |

Shield Standard absorbs large volumetric attacks (100+ Gbps SYN floods) before they reach your infrastructure. You don't need to configure anything for basic SYN flood protection on AWS.

---

## SECTION 10 — Comparison Tables

### Table 1 — TCP 3-Way Handshake vs 4-Way Teardown

| Aspect              | 3-Way Handshake (Setup)        | 4-Way Teardown (Close)                           |
| ------------------- | ------------------------------ | ------------------------------------------------ |
| Segments            | 3 (SYN, SYN-ACK, ACK)          | 4 (FIN, ACK, FIN, ACK)                           |
| Initiator           | Either side (client typically) | Either side (server more common for HTTP)        |
| Purpose             | Agree on ISNs, establish state | Gracefully close each direction independently    |
| Why different count | Server combines its ACK + SYN  | Each direction must be independently closed      |
| Half-close possible | No — both directions together  | Yes — FIN closes one direction; other stays open |
| Can be skipped      | No                             | Yes (RST = abrupt close, bypasses 4-way)         |
| State afterward     | Both: ESTABLISHED              | Active closer: TIME_WAIT; Passive: CLOSED        |
| RTT cost            | 1 RTT                          | 1–2 RTT (can overlap)                            |

---

### Table 2 — SYN Queue vs Accept Queue

| Queue                 | SYN Queue (Incomplete)                | Accept Queue (Complete)                           |
| --------------------- | ------------------------------------- | ------------------------------------------------- |
| When populated        | After server receives SYN             | After server receives final ACK                   |
| Connection state      | SYN_RECEIVED                          | ESTABLISHED                                       |
| Kernel config         | `tcp_max_syn_backlog` (per socket)    | `net.core.somaxconn` (global) + `listen(backlog)` |
| Default size          | 128–1024 (varies by kernel)           | 128                                               |
| When full (SYN queue) | New SYNs dropped (or SYN cookie used) | New complete connections dropped                  |
| SYN flood impact      | SYN queue fills → DoS                 | Not directly targeted                             |
| SYN cookies effect    | Bypasses SYN queue entirely           | No SYN queue entry → goes straight to Accept      |
| App reads from        | N/A                                   | `accept()` syscall                                |

---

### Table 3 — TLS Version Handshake Comparison

| Property                 | TLS 1.2                      | TLS 1.3                           | TLS 1.3 (0-RTT)     |
| ------------------------ | ---------------------------- | --------------------------------- | ------------------- |
| Extra RTT after TCP      | 2 RTT                        | 1 RTT                             | 0 RTT               |
| Total RTT for first byte | TCP+2 = 3 RTT                | TCP+1 = 2 RTT                     | TCP+0 = 1 RTT       |
| Forward secrecy          | Optional (ECDHE available)   | Mandatory (ECDHE only)            | Not for 0-RTT data  |
| Cipher suites            | Many (including weak ones)   | 5 modern only                     | Same as 1.3         |
| Handshake encryption     | Partial (cert in clear)      | Yes (ServerHello encrypted)       | Yes                 |
| Session resumption       | Session ID or session ticket | Session ticket (PSK)              | PSK with 0-RTT data |
| Replay attack risk       | Low                          | Low                               | Medium (0-RTT data) |
| AWS support              | Yes (ALB, CloudFront, NLB)   | Yes (use ELBSecurityPolicy-TLS13) | CloudFront only     |

---

### Table 4 — ALB vs NLB Connection Handling

| Behavior                      | ALB                          | NLB                           |
| ----------------------------- | ---------------------------- | ----------------------------- |
| Layer                         | 7 (HTTP/HTTPS)               | 4 (TCP/UDP)                   |
| SYN proxy                     | Yes                          | Yes                           |
| TLS termination               | Yes (ACM cert)               | Yes (ACM cert or passthrough) |
| Idle timeout                  | 60s default, 4000s max       | 350s fixed                    |
| Connection draining           | Per-request (HTTP-aware)     | Per-connection (TCP-level)    |
| Source IP to backend          | ALB IP (use X-Forwarded-For) | Client's original IP          |
| Security group for backend    | Allow ALB SG                 | Allow client CIDR             |
| Connection pooling to backend | Yes                          | No (TCP passthrough)          |
| WebSocket support             | Yes (automatic upgrade)      | Yes (TCP passthrough)         |
| HTTP/2 to client              | Yes                          | No (TCP passthrough)          |
| Backend health check          | HTTP GET /health             | TCP handshake or HTTP         |

---

### Table 5 — TCP Handshake States: Normal vs SYN Flood vs SYN Cookie

| State                  | Normal Traffic                    | SYN Flood (no cookies)            | SYN Flood (cookies enabled)                    |
| ---------------------- | --------------------------------- | --------------------------------- | ---------------------------------------------- |
| SYN_RECEIVED entries   | Few (millisecond transitions)     | Thousands (fill queue)            | Zero (no queue allocated)                      |
| ESTABLISHED            | Healthy, mirrors connection count | Zero (queue full, no completions) | Normal (legitimate clients complete)           |
| Memory usage           | Normal                            | High (SYN queue allocation)       | Normal (no queue entries)                      |
| CPU usage              | Normal                            | Low (simple packet handling)      | Slightly higher (hash computation per SYN-ACK) |
| Legitimate connections | Connect normally                  | Fail: SYN dropped                 | Connect normally                               |
| Attacker SYN packets   | N/A                               | Consume queue entries             | Ignored (can't complete handshake)             |
| Configuration          | Always-on                         | Vulnerable                        | `tcp_syncookies=1`                             |

---

## SECTION 11 — Quick Revision & Memory Tricks

### 10 Key Points to Remember

1. **3-way handshake = 1 RTT.** SYN → SYN-ACK → ACK. Three packets, one round-trip time cost. After this, both sides have agreed on ISNs and the connection is live.

2. **ISN is random (cryptographic).** Prevents TCP session hijacking and ghost packets from old connections with same 4-tuple port reuse.

3. **SYN "consumes" 1 sequence number.** Even with no data payload. Same for FIN. This allows the receiver to ACK the connection-establishment message itself.

4. **SYN queue = half-open connections.** Server allocates entry after SYN, before final ACK. SYN flood fills this queue. SYN cookies bypass it entirely.

5. **SYN cookies: ISN becomes a cryptographic hash**. Server encodes connection parameters in the SYN-ACK ISN. No queue entry. Legitimate clients complete handshake; spoofed SYNs never can.

6. **ALB idle timeout = 60 seconds** (default). WebSockets and long-poll MUST increase this. NLB idle timeout = 350 seconds (fixed). Both silently drop idle connections.

7. **ALB is a SYN proxy — backends only see established connections.** Backends never receive individual SYN packets. Clean separation of concerns.

8. **NLB preserves source IP; ALB doesn't.** NLB security groups on backends need client CIDR. ALB security groups need ALB CIDR.

9. **TLS 1.3 = 1 RTT after TCP.** TLS 1.2 = 2 RTT after TCP. TLS 1.3 0-RTT resumption = 0 additional RTT for reconnecting clients.

10. **TIME_WAIT = 2×MSL (~60–120 seconds).** Port unavailable during this period. Solution: `tcp_tw_reuse`, increase port range, or use connection keep-alive (reduces new connections dramatically).

---

### 30-Second Explanation (Memorize This)

"The TCP 3-way handshake has three steps: the client sends SYN with its initial sequence number, the server responds with SYN-ACK acknowledging the client's ISN and sending its own, and the client sends ACK acknowledging the server's ISN. This costs one round-trip time. Both sides must exchange sequence numbers because TCP requires bidirectional acknowledgment — a 2-step exchange would leave the server's ISN unconfirmed. ISNs are random to prevent session hijacking. SYN floods fill the server's half-open connection queue with spoofed SYNs — SYN cookies defend by encoding connection parameters in the ISN itself, requiring no queue allocation. In AWS, ALB and NLB both act as SYN proxies, meaning your backends only ever see fully established connections."

---

### Memory Mnemonics

**SYN = "Starting Your Network-link" — Client starts, sends ISN**
**SYN-ACK = "Server Yes! And Connects back" — Server confirms + adds its own ISN**
**ACK = "Acknowledged, Connected, Knocking good" — Client confirms server, connection open**

**ISN = "It's Secret Now"** — ISN must be random and secret; predictable = hijackable.

**SYN Cookies = "Solving Your huge Network queue problem":**
SYN cookies solve the SYN queue overflow problem by encoding params in the SYN-ACK ISN.

**For NLB vs ALB security groups — "NLB = Naked Bypass LB":**
NLB passes client IP through "naked" → backend security group must allow CLIENT CIDRs.
ALB wraps/rewrites the IP → backend security group allows ALB CIDR.

**Quick-fire exam facts:**

- ALB idle timeout default? → 60 seconds
- NLB idle timeout? → 350 seconds (fixed, not configurable)
- SYN flood → enable `tcp_syncookies=1` on Linux
- Backend SG behind NLB → allow client IPs, not NLB IPs
- TIME_WAIT port exhaustion → `tcp_tw_reuse` + increase `ip_local_port_range`
- TLS 1.3 on ALB → use `ELBSecurityPolicy-TLS13-1-2-2021-06` security policy

---

## SECTION 12 — Architect Thinking Exercise

### The Problem (Read carefully — take 5 minutes to think before viewing the solution)

**Scenario:**
A high-frequency trading (HFT) firm is building a new order management system on AWS. Requirements:

- **Latency target:** < 1 millisecond round-trip from their on-premises data center in New York to their AWS order execution service
- **Scale:** 1,000,000 orders per second at peak
- **Reliability:** 99.999% uptime
- **Protocol:** proprietary binary TCP protocol (not HTTP)
- **Security:** encrypted (TLS)

Current problem: their measurements show 3.2ms average RTT from on-premises to AWS service behind an NLB. The team says "1ms is impossible — the TCP handshake alone should take 1ms for the 50-mile distance between their DC and the AWS region."

**The team is correct that the physical RTT (speed of light) is ~0.5ms for 50 miles. But their system shows 3.2ms. Why is there a 2.7ms gap, and how do you achieve the 1ms target?**

_(Think through the latency budget before scrolling)_

---

↓

↓

↓

↓

---

### Solution — Latency Archaeology and HFT TCP Optimization

**Latency Budget Analysis:**

Let's decompose the 3.2ms:

```
Physical RTT (speed of light, 50 miles):      ~0.5ms
Expected total: 0.5ms

Actual measured: 3.2ms
Gap to explain:  2.7ms

Decomposing the gap:
  1. TCP SYN/SYN-ACK/ACK setup:            +0.5ms  (1 physical RTT)
  2. NLB additional RTT (LB → backend):     +0.5ms  (NLB introduces its own connection)
  3. Direct Connect vs internet routing:    +0.5ms  (if using VPN/internet, not Direct Connect)
  4. Kernel network stack processing:       +0.2ms  (IRQ handling, socket buffer copies)
  5. Nagle's algorithm buffering delay:     +0.5ms  (TCP coalesces small packets → adds latency)
  6. TLS handshake overhead per new conn:   +varies  (if new connections per order)
  Total: ~2.2ms additional → explains most of the 2.7ms gap
```

**Problem 1: Nagle's Algorithm (biggest culprit for small messages)**

Nagle's algorithm coalesces small TCP segments to reduce packet count. For HFT sending 50-byte order messages:

- Nagle waits until: (a) previous ACK received, OR (b) enough data to fill MSS (1460 bytes)
- If sending 50-byte order messages 1M/sec → Nagle buffers them → batch delay of up to 200ms
- Fix: **TCP_NODELAY socket option** — disables Nagle's algorithm

```python
import socket
sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)  # CRITICAL for HFT
```

**Problem 2: NLB Adding Extra RTT**

NLB introduces connection proxying. For HFT, remove NLB from the path:

- Use **Direct Connect** (not VPN, not internet) from on-prem DC to AWS

Direct Connect with sub-millisecond latency requires:

- Hosted connection with 10 Gbps Direct Connect at Equinix NY (co-location)
- Direct Connect port in AWS → VPC Direct Connect Gateway
- No NLB in the path → direct to EC2 instance private IP via Direct Connect VLAN

**Problem 3: Connection Establishment Cost**

Creating a new TCP connection per order at 1M orders/sec is impossible. Even with 0.5ms RTT, that's 500,000 connection setups per second consuming all available ports.

Solution: **persistent connection with multiplexed ordering via message framing**

```
Traditional (wrong for HFT):
  CONNECT → SEND order 1 → RESPONSE 1 → DISCONNECT
  CONNECT → SEND order 2 → RESPONSE 2 → DISCONNECT
  Cost: 2× RTT per order (connect + request/response)

HFT-correct:
  CONNECT ONCE (at startup)
  ──────────────────────────────────────── (persistent TCP connection)
  SEND order_001 [seq=1]  → RESPONSE [ack=1]
  SEND order_002 [seq=2]  → RESPONSE [ack=2]  (pipelining without new connect)
  SEND order_003 [seq=3]  → RESPONSE [ack=3]
  Cost: 0.5ms RTT per order (no handshake overhead)
```

**Complete Architecture for <1ms HFT:**

```
Physical colocation:
On-prem DC (Equinix NY) ──[10Gbps Direct Connect]──► AWS ap-northeast-1 (or us-east-1)
                              (no internet, no VPN)

Network path:
EC2 (on-prem app) → Direct Connect interface →
AWS Direct Connect Gateway → VPC → EC2 (order execution)
Target: ~0.3ms networking RTT

AWS Infrastructure:
- EC2: c6i.32xlarge (Enhanced Networking, ENA, 100 Gbps)
- Placement Group (Cluster): EC2 instances in same rack
- EC2: `sriov` module enabled (single-root I/O virtualization)
- NO NLB in path: direct private IP connection
- ENA (Elastic Network Adapter): bypasses hypervisor for network stack

Application Configuration:
- TCP_NODELAY = 1 (disable Nagle)
- TCP_QUICKACK = 1 (send ACK immediately, don't buffer)
- socket receive buffer: 4 MB (SO_RCVBUF)
- socket send buffer: 4 MB (SO_SNDBUF)
- Persistent connections pre-established at startup
- Binary framing protocol (not HTTP): 8-byte header + payload vs 200+ bytes HTTP headers
- io_uring or DPDK for kernel-bypass networking (advanced — truly sub-0.1ms)

Security (TLS, but pre-negotiated):
- TLS 1.3 session resumption (0-RTT) on reconnects
- Cert pinned + rotated offline to avoid handshake cost at runtime
- Pre-established TLS sessions: handshake on startup, all orders use existing TLS session

Result:
  Direct Connect physical RTT:    ~0.3ms
  TCP_NODELAY (no buffering):     eliminates Nagle 200ms → 0ms
  Persistent connection:          0ms handshake per order
  Kernel optimizations:           ~0.05ms vs ~0.2ms
  Total: ~0.35–0.5ms RTT
  ✓ < 1ms target achieved
```

**Key Insights for the Exam:**

- Sub-millisecond latency in the cloud requires: Direct Connect (not internet/VPN), no load balancers in hot path, persistent TCP connections, TCP_NODELAY
- The SAA exam won't ask about TCP_NODELAY, but will ask: "Which AWS service provides dedicated network connectivity with the lowest latency?" → **Direct Connect**
- "Application needs to bypass NAT and load balancers for lowest latency" → Direct Connect + EC2 with Elastic IP or private IP

---

## Complete Series Summary — Topic 12

| File    | Sections | Core Content                                                                                                                                                                                                              |
| ------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File 01 | 1–4      | Phone operator + film clapperboard analogies; ISN mechanics (random, RFC 6528); step-by-step packet-level detail; TCP options (MSS, SACK, WS, TFO); SYN/Accept queue; SYN cookies; HTTPS = TCP + TLS 1.3 timing           |
| File 02 | 5–8      | GitHub DDoS SYN flood, ALB SYN proxy, connection pool size math; TIME_WAIT exhaustion; AWS ALB connection draining; TLS 1.2 vs 1.3 RTT comparison; 8 interview Q&As including TLS internals                               |
| File 03 | 9–12     | AWS exam traps (ALB 60s idle, NLB source IP, security group rules, stateful vs stateless); 5 tables; SYN/SYNACK/ACK mnemonics; HFT <1ms latency architecture exercise with Nagle's algorithm, Direct Connect, TCP_NODELAY |

**Next Topic →** Topic 13: TCP Reliability (ACK, Retransmission) — Sequence numbers and cumulative ACKs, RTO calculation (Karn's algorithm), fast retransmit (3 dup ACKs), Selective Acknowledgment (SACK), congestion control (slow start, AIMD, CUBIC, BBR), and how AWS Enhanced Networking (ENA/SR-IOV) affects these at scale.
