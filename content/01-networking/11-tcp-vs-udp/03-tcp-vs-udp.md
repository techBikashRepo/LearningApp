# TCP vs UDP — Part 3 of 3

### Topic: AWS SAA Exam Traps, Comparison Tables, and Architecture Exercise

**Series:** Networking Fundamentals → System Design → AWS Solutions Architect
**Sections Covered:** 9, 10, 11, 12

---

## SECTION 9 — AWS SAA Certification Focus

### Core Service Mapping

| Protocol Requirement      | AWS Service              | Key Detail                                    |
| ------------------------- | ------------------------ | --------------------------------------------- |
| HTTP/HTTPS load balancing | ALB                      | Layer 7, path/host routing, WAF integration   |
| TCP/UDP load balancing    | NLB                      | Layer 4, static EIPs, source IP preservation  |
| UDP game servers          | NLB + Global Accelerator | Anycast + UDP NLB listener                    |
| HTTP/3 (QUIC/UDP)         | CloudFront, ALB          | Frontend QUIC; backend HTTP/2 or HTTP/1.1     |
| MQTT IoT protocol (TCP)   | AWS IoT Core             | MQTT 3.1.1 and 5.0 over TLS/TCP               |
| WebSocket (long TCP)      | ALB                      | Upgrades HTTP → WebSocket, manages connection |
| NTP (UDP 123)             | AWS Time Sync Service    | EC2 VMs access via 169.254.169.123            |
| IPsec VPN (UDP 500/4500)  | AWS Site-to-Site VPN     | IKEv1/v2 over UDP for key exchange            |

---

### Critical Exam Traps

**Trap 1 — ALB Cannot Handle UDP**

ALB operates only at Layer 7 (HTTP/HTTPS). Any question involving UDP, gaming, VoIP, DNS forwarding, MQTT over UDP, or custom TCP protocols → the answer is **NLB** (or NLB + Global Accelerator).

Common wrong answer: "Use ALB because it has more features." Correct: ALB doesn't support UDP at all.

Exam pattern: "A company runs a DNS server on EC2 and wants to load balance DNS queries" → NLB with UDP listener. Not ALB.

**Trap 2 — NLB Does NOT Terminate TLS by Default — You Must Configure It**

NLB passes TCP connections through by default (TCP passthrough). For TLS termination, you must explicitly create a TLS listener on NLB and associate an ACM certificate.

Without TLS termination on NLB: the EC2 targets must handle TLS themselves (more CPU load on instances).

With TLS termination on NLB: NLB decrypts TLS, forwards plaintext TCP to instances (reduces instance CPU; but NLB can't inspect HTTP content — that would require ALB).

**Trap 3 — Connection Draining (Deregistration Delay) Works Differently Between ALB and NLB**

When you remove a target from a target group:

- ALB: "Connection Draining" (now called "Deregistration Delay") — ALB stops sending new requests but completes in-flight HTTP requests. Default: 300 seconds. ALB understands HTTP request boundaries.
- NLB: "Deregistration Delay" — waits for existing TCP connections to close naturally OR for the delay timeout. NLB cannot "complete an HTTP request" because it doesn't understand HTTP — it works at TCP level. Existing TCP connections continue until they close or timeout.

Exam implication: for graceful deployments, ALB handles connection draining more elegantly for HTTP workloads. NLB's deregistration simply allows open TCP connections to drain.

**Trap 4 — TCP Keepalive vs NLB Idle Timeout Mismatch**

NLB drops TCP connections silent after 350 seconds (default) of idle time. Applications that maintain long-lived TCP connections (database connection pools, WebSocket connections) must ensure they send data or TCP keepalive probes before this timeout.

If they don't:

- NLB silently drops the connection (no FIN/RST to either side in some cases)
- Application tries to write/read → gets connection reset error unexpectedly
- Looks like a random application crash with no obvious cause

Solution: enable TCP keepalive in application (`SO_KEEPALIVE` socket option with `tcp_keepalive_time < 350s`), or implement application-level heartbeats.

**Trap 5 — WebSocket Requires Specific ALB Configuration**

WebSocket connections start as HTTP/1.1 upgrade requests. ALB supports WebSockets, but you must:

1. Ensure the ALB listener is HTTP or HTTPS (not TLS without HTTP layer)
2. Idle timeout must be set appropriately (default 60s → not enough for persistent WebSocket connections that may be quiet for minutes)
3. Target group stickiness may be needed (if your WebSocket app is stateful and requires same-server affinity)

For long-lived WebSocket connections: set ALB idle timeout to match your application's expected quiet period + buffer.

---

### Exam Pricing Facts

| Service            | Relevant Cost                                                               |
| ------------------ | --------------------------------------------------------------------------- |
| NLB                | $0.008/LCU-hour (Network Load Balancer Capacity Unit); $0.0225/hour per NLB |
| ALB                | $0.008/LCU-hour; $0.0225/hour per ALB                                       |
| Global Accelerator | $0.025/hour + $0.015/GB (accelerated traffic)                               |
| Data Transfer      | TCP/UDP data within AZ = free; cross-AZ = varies                            |
| Elastic IP         | $0.005/hour if not attached; free if attached to running instance           |

---

## SECTION 10 — Comparison Tables

### Table 1 — TCP vs UDP Core Comparison

| Property            | TCP                                    | UDP                              |
| ------------------- | -------------------------------------- | -------------------------------- |
| Connection          | Connection-oriented (3-way handshake)  | Connectionless                   |
| Reliability         | Guaranteed delivery (ACK + retransmit) | Best-effort (no guarantee)       |
| Ordering            | Ordered delivery (sequence numbers)    | No ordering                      |
| Error checking      | Checksum + retransmission              | Checksum only (optional in IPv4) |
| Flow control        | Yes (receive window)                   | No                               |
| Congestion control  | Yes (slow start, AIMD)                 | No                               |
| Header size         | 20 bytes minimum                       | 8 bytes always                   |
| Setup latency       | 1 RTT (handshake)                      | 0 RTT                            |
| Throughput          | Slightly lower (overhead)              | Higher (less overhead)           |
| Broadcast/multicast | No (unicast only)                      | Yes                              |
| State on server     | Full state per connection              | No state                         |
| Use cases           | HTTP, HTTPS, SSH, FTP, SMTP, DB        | DNS, DHCP, NTP, video, gaming    |

---

### Table 2 — AWS Load Balancer Protocol Support

| Feature                | ALB (Application LB)        | NLB (Network LB)               | CLB (Classic)   |
| ---------------------- | --------------------------- | ------------------------------ | --------------- |
| TCP                    | No (Layer 7 only)           | Yes                            | Yes             |
| UDP                    | No                          | Yes                            | No              |
| TLS                    | Yes (terminate)             | Yes (terminate or passthrough) | Yes (terminate) |
| HTTP/HTTPS             | Yes                         | No                             | Yes             |
| WebSocket              | Yes                         | No (TCP passthrough works)     | Limited         |
| HTTP/2                 | Yes                         | No                             | No              |
| HTTP/3 (QUIC)          | Yes (frontend only)         | No                             | No              |
| gRPC                   | Yes                         | No (TCP works)                 | No              |
| Static IPs             | No (use NLB)                | Yes (Elastic IP per AZ)        | No              |
| Source IP preservation | No (X-Forwarded-For header) | Yes                            | No              |
| WAF integration        | Yes                         | No                             | No              |
| Lambda targets         | Yes                         | No                             | No              |
| Layer                  | 7                           | 4                              | 4/7 (limited)   |

---

### Table 3 — Protocol Selection by Use Case

| Use Case                        | Protocol                                   | Why                                       |
| ------------------------------- | ------------------------------------------ | ----------------------------------------- |
| Web application (HTTP APIs)     | TCP (HTTPS via ALB)                        | Reliability, routing, WAF                 |
| Database connections            | TCP                                        | Ordered, reliable data                    |
| Real-time live video            | UDP                                        | Loss-tolerant, zero-stall                 |
| Online gaming (state updates)   | UDP                                        | Sub-frame latency, loss acceptable        |
| DNS queries                     | UDP (TCP for large)                        | Single datagram query-response, tiny size |
| File download                   | TCP                                        | Every byte must arrive                    |
| VoIP audio (RTP)                | UDP                                        | Real-time, old frames worthless           |
| WebSocket (chat, collaboration) | TCP (via ALB)                              | Ordered real-time messages                |
| QUIC / HTTP/3                   | UDP (with reliability)                     | Low latency + multiplexing                |
| SNMP traps (monitoring)         | UDP                                        | Fire-and-forget monitoring events         |
| NTP (time sync)                 | UDP                                        | Single datagram request-response          |
| SMTP (email)                    | TCP                                        | Every email must arrive                   |
| IoT sensor data                 | Both (TCP for critical, UDP for telemetry) | Depends on SLA                            |

---

### Table 4 — TCP Connection States Reference

| State        | Who Enters     | Meaning                                     |
| ------------ | -------------- | ------------------------------------------- |
| CLOSED       | Both           | No connection                               |
| LISTEN       | Server         | Waiting for connection on a port            |
| SYN_SENT     | Client         | Sent SYN, waiting for SYN-ACK               |
| SYN_RECEIVED | Server         | Received SYN, sent SYN-ACK, waiting for ACK |
| ESTABLISHED  | Both           | Connection active, data flowing             |
| FIN_WAIT_1   | Active closer  | Sent FIN, waiting for ACK                   |
| FIN_WAIT_2   | Active closer  | FIN ACK'd, waiting for remote FIN           |
| CLOSE_WAIT   | Passive closer | Received FIN, waiting for app to close()    |
| LAST_ACK     | Passive closer | Sent FIN, waiting for final ACK             |
| TIME_WAIT    | Active closer  | Waiting 2×MSL before returning to CLOSED    |
| CLOSING      | Both           | Both sides trying to close simultaneously   |

---

### Table 5 — QUIC vs TCP vs UDP Comparison

| Property             | TCP                           | UDP                          | QUIC (UDP-based)                          |
| -------------------- | ----------------------------- | ---------------------------- | ----------------------------------------- |
| Connection setup     | 1 RTT                         | 0 RTT                        | 0 RTT (with session resume)               |
| TLS integration      | External (separate)           | External (DTLS)              | Built-in (TLS 1.3 mandatory)              |
| Multiplexed streams  | HTTP/2 (HoL blocking)         | Application handles          | Yes (no HoL blocking)                     |
| HoL blocking         | Yes (single byte stream)      | N/A (datagrams)              | No (per-stream reliability)               |
| Connection migration | No (IP change = new TCP conn) | N/A                          | Yes (connection ID survives IP change)    |
| Congestion control   | Yes (AIMD, BBR, CUBIC)        | No                           | Yes (similar to TCP + QUIC-specific)      |
| OS kernel required   | Yes                           | Yes                          | No (user-space library)                   |
| Firewall blocking    | Rare (TCP 80/443 universal)   | Some firewalls block UDP 443 | Progressive (firewalls may block UDP 443) |
| AWS support          | Native everywhere             | NLB, Route 53                | CloudFront, ALB (frontend)                |

---

## SECTION 11 — Quick Revision & Memory Tricks

### 10 Key Points to Remember

1. **TCP = reliable, ordered, connection-oriented.** 3-way handshake, sequence numbers, ACKs, retransmission, flow control, congestion control. Use when every byte must arrive in order.

2. **UDP = fast, connectionless, no guarantees.** 8-byte fixed header, no state, no ACK. Use for live media, DNS, gaming, IoT telemetry — where loss is tolerable or application handles reliability.

3. **TCP header = 20+ bytes; UDP header = 8 bytes always.** Size difference matters for high-frequency small messages (DNS, gaming packets).

4. **TIME_WAIT = 2×MSL after close.** Prevents ghost packets from past connections being misinterpreted. Port can't be reused until TIME_WAIT expires (60–120s). High-traffic servers tune `tcp_tw_reuse`.

5. **ALB = Layer 7 (HTTP/HTTPS/WebSocket/gRPC); NLB = Layer 4 (TCP/UDP).** UDP workloads ALWAYS need NLB. ALB cannot handle UDP at all.

6. **NLB idle timeout = 350 seconds.** Long-lived TCP connections (DB pools, WebSockets) must send keepalive probes or application heartbeats within 350 seconds or NLB drops the connection silently.

7. **QUIC = UDP + TLS + per-stream reliability.** Solves TCP HoL blocking for HTTP/3. No OS kernel update needed — pure userspace. Connection ID enables IP migration (WiFi→4G without reconnect).

8. **UDP amplification DDoS** uses spoofed source IP and large response payloads. AWS Shield Standard absorbs these. Your UDP servers should never return large responses to unchallenged sources.

9. **NLB preserves source IP; ALB doesn't.** ALB inserts original client IP in `X-Forwarded-For` header. NLB passes original TCP packet source IP directly. This matters for rate limiting, geo-blocking, and audit logs.

10. **TCP flow control with zero window = sender must stop.** Receiver sets window=0 when buffer is full → sender pauses → sender sends 1-byte probes → waits for window update before resuming.

---

### 30-Second Explanation (Memorize This)

"TCP and UDP are both Layer 4 transport protocols. TCP establishes a connection with a 3-way handshake, guarantees every byte arrives in order through sequence numbers and acknowledgments, and includes flow and congestion control. It's for anything where losing data is unacceptable — HTTP, database queries, file transfers. UDP skips all of that — no handshake, no acknowledgment, no ordering — just fire and forget. It's for real-time video, gaming, and DNS where low latency matters more than delivery guarantees. In AWS, the ALB handles HTTP traffic at Layer 7, and the NLB handles TCP and UDP at Layer 4 — if you need UDP load balancing, you always use NLB."

---

### Memory Mnemonics

**RUOC = Reliable Unordered-impossible Ordered Connection-oriented (TCP)**
TCP gives you: Reliability, Unambiguous ordering (opposite of unordered), Connection.
When you think TCP → think RUOC = Reliable, Unambiguous Order, Connected.

**FRE = Fast, Raw, Effortless (UDP)**
UDP is fast (no overhead), raw (no guarantees), effortless (no setup).
When you think UDP → think FRE = Fast, Raw, Effortless.

**"ALB = Alphabet soup (HTTP letters), NLB = Naked bits (raw TCP/UDP)"**
ALB speaks HTTP (a language, made of letters) → any HTTP-aware routing.
NLB speaks raw TCP/UDP (just bits) → any protocol, any port.

**TIME_WAIT = "There Isn't More Exchanges — Wait":**
After connection close: both sides are DONE with exchanges, but hold state briefly. 2×MSL. Wait for ghost packets.

**Quick-fire exam facts:**

- WebSocket via ALB? → Set idle timeout > expected quiet period
- UDP gaming traffic? → NLB + Global Accelerator (not ALB)
- Source IP needed in logs? → NLB (preserves source IP); ALB uses X-Forwarded-For
- HTTP/3 support on AWS? → CloudFront + ALB (frontend only; backend is HTTP/2)
- IoT sensor critical data? → AWS IoT Core (MQTT over TCP/TLS); QoS 1 or 2

---

## SECTION 12 — Architect Thinking Exercise

### The Problem (Read carefully — take 5 minutes to think before viewing the solution)

**Scenario:**
A fintech company runs a real-time payment processing application. Architecture details:

- Backend: Java Spring Boot microservices on EC2, behind an NLB
- Database: RDS PostgreSQL, connection pooled via HikariCP (pool size=20, maxLifetime=1800000ms=30min)
- Infrastructure: NLB → EC2 (connection draining=300s), RDS in private subnet

**The problem:**
On Monday mornings, starting around 9:05 AM (5 minutes after market open at 9:00 AM), the payment service experiences an error storm lasting about 3 minutes:

```
FATAL: HikariCP - Connection is not available, request timed out after 30000ms
org.postgresql.util.PSQLException: An I/O error occurred while sending to the backend
java.net.SocketException: Connection reset
```

After 3 minutes, everything works fine until next Monday morning. The team notices this only happens on Monday mornings. Traffic on Monday morning is 10× normal. But the team doubled the connection pool from 10 to 20 — error persists.

**Diagnose the root cause. Design a fix that makes Monday mornings reliable.**

---

↓

↓

↓

↓

---

### Solution — NLB Idle Timeout Meets Weekend Database Connections

**Root Cause Analysis:**

The error only on Monday mornings immediately after a weekend is the crucial clue. Here's what happens:

```
Friday 5:00 PM: Traffic drops to near zero
  → HikariCP pool maintains up to 20 connections open (minIdle=20 or LIFO reuse)
  → These connections are established TCP connections:
    EC2 → NLB → RDS PostgreSQL

Friday 5:00 PM → Monday 9:00 AM = ~64 hours of idle time

NLB idle timeout = 350 seconds = ~6 minutes

What actually happens at NLB:
  After 350 seconds of no TCP data on a connection:
  NLB marks the connection as expired in its connection table
  NLB may NOT send RST/FIN to either side (stateful firewall behavior)

  Result:
    EC2 HikariCP thinks connection is alive (no FIN received)
    RDS also thinks connection might be alive OR has cleaned it up
    NLB has quietly dropped its state for that connection

Monday 9:00 AM — market opens, 10× traffic spike
  HikariCP pulls "idle" connections from pool
  Tries to send SQL query → TCP write to "connection"
  NLB receives packet → no connection state for this 5-tuple → sends RST
  EC2 receives RST → PSQLException: Connection reset
  HikariCP marks connection bad → validation starts
  20 connections × validation overhead = pool momentarily empty
  Incoming requests queue → 30s timeout → HikariCP connection timeout errors

  3-minute recovery: HikariCP creates fresh connections → NLB establishes new state
  → errors stop once pool fully refreshed
```

**Why doubling pool size (10→20) didn't help:**
More connections = more idle connections over the weekend = MORE connections affected. The error count doubled, but the total system throughput didn't improve because all connections were stale.

**Fix Plan:**

```
Fix 1 — TCP Keepalive on EC2 instances (OS level):
  Configure in /etc/sysctl.conf:
  net.ipv4.tcp_keepalive_time = 60      # send probe after 60s idle
  net.ipv4.tcp_keepalive_intvl = 10     # probe every 10s if no response
  net.ipv4.tcp_keepalive_probes = 5     # 5 probes before declaring dead

  Apply: sudo sysctl -p

  Effect: every 60s, OS sends TCP keepalive probe for each idle connection
  NLB sees TCP traffic → resets its idle timer → connection stays alive
  NLB never drops it after 350s

Fix 2 — HikariCP connection validation (application level):
  hikari.connectionTestQuery=SELECT 1        # verify connection before use
  hikari.keepaliveTime=60000                  # HikariCP sends keepalive every 60s
  hikari.maxLifetime=1800000                  # forcefully recycle connections every 30 min
  hikari.connectionTimeout=30000
  hikari.idleTimeout=600000                   # close idle connections after 10 min

  maxLifetime recycles connections every 30 minutes → 2-hour weekend idle is fine
  keepaliveTime sends heartbeat query every 60s → triggers TCP traffic → NLB timer reset

Fix 3 — Increase NLB idle timeout (infrastructure level):
  NLB target group attribute:
  deregistration_delay.timeout_seconds = 6000  (NLB max is 6000)

  Set via AWS Console or:
  aws elbv2 modify-target-group-attributes \
    --target-group-arn arn:aws:elasticloadbalancing:... \
    --attributes Key=deregistration_delay.timeout_seconds,Value=6000

  Note: NLB idle timeout specifically for TCP flows is not directly configurable
  In practice, TCP keepalive (Fix 1) is more reliable

Fix 4 — Connection test on checkout (safest for weekends):
  HikariCP: connection-test-on-borrow=true
  → Every time HikariCP gives out a connection, it runs SELECT 1
  → Stale connections detected and replaced on first use
  → 1 failed query per stale connection (vs storm on full pool)
  → Trade-off: tiny overhead per connection checkout (~1ms for SELECT 1)

  Acceptable for payment service where correctness > minimal latency
```

**Production recommendation (implement all 4 layers):**

1. OS TCP keepalive (60s) — infrastructure defense
2. HikariCP `keepaliveTime` (60s) — application defense
3. HikariCP `connectionTestOnBorrow=true` — safeguard for any slipped stale connections
4. HikariCP `maxLifetime` — prevents any connection from living longer than 30 minutes regardless

**Monitoring to confirm fix:**

- CloudWatch: NLB "Processed Bytes" metric over weekend — should show periodic small TCP keepalive traffic
- HikariCP metrics: `hikaricp.connections.timeout` and `hikaricp.connections.creation` — should be near-zero on Monday mornings
- RDS: `DatabaseConnections` CloudWatch metric — should show stable connections over weekend, not a spike on Monday

---

## Complete Series Summary — Topic 11

| File    | Sections | Core Content                                                                                                                                                                                                      |
| ------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File 01 | 1–4      | TCP vs UDP certified mail vs radio analogies; TCP guarantees (reliable/ordered/flow/congestion); UDP simplicity; header comparison (20 vs 8 bytes); TCP flags; state machine; TIME_WAIT; full TCP lifecycle trace |
| File 02 | 5–8      | QUIC over UDP, HoL blocking solution; TCP HoL blocking in microservices; UDP congestion risks; amplification DDoS; ALB vs NLB protocol support; Global Accelerator UDP; IoT protocol design; gaming architecture  |
| File 03 | 9–12     | AWS exam traps (ALB no-UDP, NLB TLS config, connection draining, keepalive timeout); 5 comparison tables; RUOC/FRE mnemonics; NLB idle timeout + HikariCP weekend connection pool exercise                        |

**Next Topic →** Topic 12: TCP 3-Way Handshake — Deep dive into SYN/SYN-ACK/ACK mechanics, Initial Sequence Numbers (ISN), what happens in each state, SYN flood attacks and SYN cookies mitigation, TLS handshake layered on top, and what TCP Fast Open (TFO) changes about connection setup.
