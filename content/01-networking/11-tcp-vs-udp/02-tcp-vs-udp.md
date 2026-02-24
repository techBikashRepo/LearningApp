# TCP vs UDP — Part 2 of 3

### Topic: Real-World Protocol Choices, AWS Load Balancer Architecture, and Interview Mastery

**Series:** Networking Fundamentals → System Design → AWS Solutions Architect
**Sections Covered:** 5, 6, 7, 8

---

## SECTION 5 — Real-World Examples

### Analogy 1 — Assembly Line vs Pile of Parts

**TCP = Assembly Line:**
A car factory has an assembly line where parts arrive in strict order — chassis first, then engine, then body panels, then seats, then tires. If the engine doesn't arrive, the entire line stops and waits. You cannot attach seats to a chassis without an engine — the order and completeness are mandatory.

This is TCP. Your HTTP request headers must arrive before the body. A database query response must be complete before you execute business logic on it. Missing byte 3000 in a 5000-byte response means bytes 3001–5000 are buffered and withheld from the application until byte 3000 arrives.

**UDP = Parts Dropped by Helicopter:**
A military operation drops supplies by helicopter over a wide area. Some boxes land on target. Some land in a river. You use what you catch. No one is waiting for the box that landed in the river before you open the ones you have.

This is UDP. Each live video frame is independent. If frame 500 is lost, the player shows frame 501. The viewer sees a brief visual glitch — far better than the entire stream freezing for 2 seconds while TCP retransmits frame 500.

### Analogy 2 — Chess by Mail vs Chess in Person

**TCP = Chess by Mail:**
You and your opponent mail moves back and forth. Every move is confirmed: "I received your Nf3 − here is my e5 response." If your move is lost in the mail, your opponent doesn't respond until you resend. The game is complete and ordered.

**UDP = Chess in Person with a Timer:**
Fast blitz chess with 2-second moves. You make your move. If your opponent missed it because they blinked, you still hit the clock — the game moves on. There's no "wait for confirmation" — speed is everything.

Real applications use TCP when "every move must be acknowledged" and UDP when "the game must keep moving regardless."

### Real Software Example — QUIC: UDP Reimplementing TCP's Reliability at the Application Layer

Google observed that TCP's limitations were creating performance problems, especially on mobile networks where network path changes (switching from WiFi to 4G) caused TCP connections to drop and require full re-establishment.

QUIC is a transport protocol built on top of UDP that reimplements TCP's reliability guarantees plus adds new capabilities:

```
QUIC vs TCP comparison:
                     TCP         QUIC (over UDP)
Connection setup:    1–2 RTT     0 RTT (session resumption)
Protocol overhead:   20+ bytes   QUIC header ~8–12 bytes
TLS integration:     Separate    Built-in (TLS 1.3 mandatory)
HoL blocking:        Yes         No (stream multiplexing)
Connection migration: No         Yes (connection ID, survives IP change)
OS required:         Yes         No (userspace library)
Deployment speed:    Slow        Fast (library update, no OS kernel patch)

HoL (Head-of-Line) blocking in TCP:
  HTTP/2 over TCP: multiple streams multiplexed on one TCP connection
  If TCP segment for stream 1 is lost:
  → ALL streams 1–N blocked waiting for stream 1's retransmission
  → Even stream 2, 3, 4 data — fully received — is withheld until stream 1 is complete

  QUIC over UDP: each QUIC stream is independently reliable
  If QUIC stream 1 data is lost:
  → Streams 2, 3, 4 continue delivering to application immediately
  → Only stream 1 is paused waiting for retransmission
  → Dramatically better performance for pages with many parallel resources
```

QUIC is the foundation of HTTP/3. As of 2024, ~25% of all internet traffic uses QUIC (YouTube, Google Search, Facebook, Cloudflare). AWS CloudFront and ALB support HTTP/3 (QUIC).

---

## SECTION 6 — Why This Matters for System Design

### Problem 1 — TCP Head-of-Line Blocking in Microservices

When building microservices that make many parallel requests:

```
API Gateway makes 5 parallel requests to downstream services:
  Request to UserService    (100ms response)
  Request to OrderService   (150ms response)
  Request to ProductService (80ms response)
  Request to InventoryService (200ms response)
  Request to PricingService (90ms response)

With HTTP/1.1 (one request per TCP connection):
  Each service gets its own TCP connection
  No HoL blocking between services
  But: connection setup overhead per service call

With HTTP/2 (all requests multiplexed on one TCP connection):
  Efficient use of connections
  BUT: if one TCP segment is lost anywhere:
  → All 5 service responses are blocked until retransmission

With HTTP/3/QUIC:
  Each stream independently reliable
  One lost packet only blocks that specific service's stream
  Others continue — better tail latency performance
```

**Design decision:** for internal microservice communication with low packet loss (within a VPC), HTTP/2 over TCP is fine. For public-facing services over the internet where packet loss is higher, HTTP/3/QUIC improves performance.

### Problem 2 — UDP Without Congestion Control — The Rogue Sender Problem

UDP has no congestion control. An application using UDP can flood the network at any rate it chooses. Classical internet protocols (TCP's AIMD — Additive Increase Multiplicative Decrease) are designed so all senders cooperate to avoid network congestion.

A UDP application that ignores congestion:

- Floods the network with traffic regardless of current network load
- Causes TCP flows on the same network to back off (as TCP sees "congestion" via loss)
- Effectively steals bandwidth from well-behaved TCP applications

**Production concern:** if you build a UDP-based internal messaging system without implementing your own congestion control:

- Normal operations: fine
- During a traffic spike or partial network failure: your UDP application may starve other services
- Solution: implement application-level congestion control similar to TCP's AIMD, or use QUIC which includes congestion control

### Problem 3 — Security Risks: UDP Amplification

UDP's connectionless nature makes it the primary vector for amplification DDoS attacks:

- Attacker forges source IP to victim's address
- Attacker sends small UDP request to open server (NTP, DNS, Memcached, SSDP)
- Server sends large response to forged source (victim)
- Amplification ratio: NTP can amplify 4000×; Memcached was used for 1.7 Tbps attacks

**How to protect your UDP-based services:**

1. Require application-level handshake before sending large responses
2. Rate-limit UDP responses per source IP
3. Use BCP38 network ingress filtering (ISPs should block spoofed IPs — many don't)
4. Reduce query response size (e.g., disable DNS EDNS for amplification-susceptible servers)
5. AWS Shield absorbs volumetric UDP floods at infrastructure layer

### Protocol Selection Decision Framework

```
┌─────────────────────────────────────────────────────────────────┐
│           PROTOCOL SELECTION DECISION TREE                      │
└─────────────────────────────────────────────────────────────────┘

Does your application require reliable delivery of every byte?
  YES → Use TCP (or QUIC for lower latency)
  NO  → continue ↓

Does your application require ordered delivery?
  YES → Use TCP
  NO  → continue ↓

Do you need to broadcast to multiple receivers simultaneously?
  YES → Use UDP multicast (e.g., stock price feeds, video conferencing server→clients)
  NO  → continue ↓

Is latency more critical than completeness?
  YES → UDP + application-level retry/tolerance
  NO  → TCP

Examples:
  File transfer → TCP        Live video → UDP/QUIC
  Database query → TCP       DNS lookup → UDP
  HTTP API → TCP/QUIC        Online gaming → UDP
  Email (SMTP) → TCP         VoIP (RTP) → UDP
  SSH → TCP                  IoT sensors → UDP (often)
  WebRTC data channel → SCTP over DTLS over UDP (bundled)
```

---

## SECTION 7 — AWS Mapping

### Load Balancer Protocol Support

AWS has three types of load balancers with different protocol support:

```
┌──────────────────────────────────────────────────────────────┐
│              AWS LOAD BALANCER PROTOCOL SUPPORT              │
├──────────┬──────────────────────┬──────────────────────────── │
│ Layer    │ ALB                  │ NLB                        │
│          │ (Application)        │ (Network)                  │
├──────────┼──────────────────────┼────────────────────────────┤
│ Layer 7  │ HTTP, HTTPS, HTTP/2, │ N/A (layer 4 only)        │
│          │ WebSocket, HTTP/3    │                            │
├──────────┼──────────────────────┼────────────────────────────┤
│ Layer 4  │ N/A                  │ TCP, UDP, TLS, TCP_UDP     │
└──────────┴──────────────────────┴────────────────────────────┘
```

**ALB (Application Load Balancer):**

- Operates at Layer 7 — understands HTTP/HTTPS content
- Can route based on hostname, path, headers, query string, method
- Terminates TLS (SSL offloading)
- WebSocket support (long-lived TCP connections for real-time apps)
- HTTP/3 support (frontend: QUIC; backend: HTTP/1.1 or HTTP/2)
- Does NOT support UDP protocols (cannot use ALB for DNS, gaming, VoIP)

**NLB (Network Load Balancer):**

- Operates at Layer 4 — doesn't look at HTTP content
- Supports: TCP, UDP, TLS, TCP_UDP (both protocols on same port)
- Ultra-low latency (microseconds vs milliseconds for ALB)
- Preserves client source IP (ALB replaces source IP with ALB IP)
- Supports static Elastic IPs per AZ (critical for IP allow-listing)
- Can handle millions of connections per second

**When to use NLB:**

- UDP services (DNS, DHCP, game servers, VoIP/RTP, syslog)
- Extreme low-latency requirements (financial trading)
- Need to preserve source IP for application-level logging
- IP allow-listing requirements (static IPs)
- Non-HTTP protocols (MQTT, custom TCP binary)

### TCP Keepalive and NLB Idle Timeout

NLB has a default idle timeout of 350 seconds. If no data flows on a TCP connection for 350 seconds, NLB drops the connection.

Problem: long-held database connections, WebSocket connections, and message queue consumers that have quiet periods get silently dropped.

Application sees: next attempt to read/write returns a connection reset error.

**Solutions:**

1. TCP keepalive on the OS level:
   - Linux: `net.ipv4.tcp_keepalive_time=60` (send keepalive probe after 60s idle)
   - Application: `SO_KEEPALIVE` socket option
2. Application-level heartbeat: send a ping/noop message every 60 seconds
3. Increase NLB idle timeout (up to 6000 seconds for NLB)
4. ALB has a 4000-second idle timeout — more generous but layer 7 overhead

### UDP in AWS — Key Services

Services using UDP within AWS:

| Service                 | UDP Usage                                      |
| ----------------------- | ---------------------------------------------- |
| Route 53 Resolver (DNS) | UDP port 53 for standard DNS queries           |
| NLB with UDP listener   | Terminate UDP at NLB, forward to EC2           |
| AWS Game Tech           | UDP for game server backend                    |
| VPC Transit Gateway     | ECMP over multiple paths (UDP-based routing)   |
| Direct Connect          | Layer 2 (Ethernet frames over dedicated fiber) |
| VPN (Site-to-Site)      | UDP 500 (IKE) + UDP 4500 (NAT-T) for IPsec     |
| CloudFront HTTP/3       | QUIC (UDP port 443) at edge                    |

### AWS Global Accelerator and UDP

AWS Global Accelerator supports both TCP and UDP traffic. It provides anycast IPs (2 static IPs globally) with:

- UDP support for gaming workloads (game servers requiring UDP)
- TCP for web applications
- Routed through AWS backbone from edge PoP to your region
- Reduces internet RTT by entering AWS network at the nearest PoP

NLB + Global Accelerator = the standard pattern for game servers and IoT that requires UDP.

---

## SECTION 8 — Interview Q&As

### Beginner Questions

**Q1: What is the main difference between TCP and UDP?**

A: TCP is **connection-oriented** and **reliable** — it establishes a connection (3-way handshake), guarantees every byte arrives in order, and retransmits lost data. UDP is **connectionless** and **best-effort** — it just sends datagrams with no connection, no ordering guarantee, and no retransmission.

Use TCP when every byte must arrive in order (HTTP, database queries, file transfers). Use UDP when low latency matters more than completeness and the application can tolerate or recover from loss (DNS, live video, gaming).

**Q2: What is the TCP 3-way handshake?**

A: The TCP 3-way handshake establishes a TCP connection between client and server:

1. **SYN:** Client sends a segment with SYN flag set and a random initial sequence number (ISN) to the server
2. **SYN-ACK:** Server acknowledges with SYN+ACK, confirms client's ISN+1, and includes its own ISN
3. **ACK:** Client acknowledges server's ISN+1

After these 3 segments, both sides have agreed on sequence numbers and the connection is established. Data transfer can begin. This costs 1 RTT (round-trip time) before the first byte of application data can be sent.

**Q3: Why does DNS use UDP instead of TCP?**

A: DNS queries are small (~32 bytes) and responses are usually small (~80–150 bytes). Using TCP would require a 3-way handshake before every query — doubling the latency. DNS is also inherently idempotent: if a response is lost, simply re-sending the same query works perfectly. UDP's stateless nature maps perfectly to DNS's request-response model.

DNS does use TCP for zone transfers (AXFR) and when responses exceed 512 bytes (the resolver sets the TC/truncated bit and the client retries with TCP).

---

### Intermediate Questions

**Q4: What is TCP HoL (Head-of-Line) blocking and how does HTTP/3/QUIC solve it?**

A: TCP Head-of-Line blocking occurs when HTTP/2 multiplexes multiple streams over a single TCP connection. TCP treats all data as a single ordered byte stream — if one segment is lost, ALL streams on that connection are blocked until the lost segment is retransmitted, even if data from other streams has already arrived.

Example:

- Stream 1 (CSS): segment lost → CSS stream stalled
- Stream 2 (JS): all segments arrived → but application can't receive JS until CSS retransmission completes
- User sees: page rendering pause even though most data arrived

QUIC solves this by building per-stream reliability at the application layer over UDP. Each QUIC stream maintains its own ordering and retransmission logic. A lost packet only blocks the specific stream it belongs to — other streams deliver data to the application immediately.

This is the primary motivation for HTTP/3 → connection multiplexing without HoL blocking.

**Q5: How does TCP flow control work? What happens when a receiver's buffer is full?**

A: TCP flow control uses the **receive window** field in every TCP segment header. The receiver announces how much buffer space it currently has available. The sender is not allowed to have more unacknowledged data in flight than the receiver's advertised window.

When the receiver's application is slow (not reading data fast enough):

1. TCP receive buffer fills up
2. Receiver sets window=0 in next ACK (zero-window advertisement)
3. Sender immediately stops sending new data
4. Sender sends "window probe" segments periodically (single byte) to check when window opens
5. When receiver's app reads data, buffer frees up, receiver sends window update
6. Sender resumes sending up to new window size

Without flow control: a fast 10 Gbps sender could overwhelm a slow 100 Mbps embedded device, causing the device to drop packets continuously, wasting bandwidth and causing retransmissions.

**Q6: When would you choose NLB over ALB, and vice versa?**

A: Choose NLB when:

- Protocol is not HTTP/HTTPS (UDP gaming traffic, VoIP/RTP, MQTT, custom TCP binary protocols)
- Need ultra-low latency (financial trading systems where ALB's millisecond overhead matters)
- Need to preserve source IP (NLB passes original client IP; ALB rewrites to its own IP)
- Need static EIPs per AZ (NLB supports this; ALB doesn't)
- Need to IP allow-list at the load balancer level (publish fixed NLB IPs to partners)
- SMTP relay or other non-HTTP services

Choose ALB when:

- HTTP/HTTPS/WebSocket/gRPC applications
- Path-based or hostname-based routing between multiple services
- WAF integration (ALB can attach AWS WAF; NLB cannot for general WAF)
- Native HTTP authentication (Cognito, OIDC integration at ALB)
- Lambda function targets (only ALB supports Lambda as a target)
- Content-based routing (route based on request body, headers, cookies)

---

### Advanced System Design Questions

**Q7: Design the transport layer architecture for a multiplayer online game with 100,000 concurrent players, 60 updates/second per player, requiring <50ms latency globally. What protocols, where, and why?**

A: This requires layered protocol decisions:

**Player ↔ Game Server (real-time game state):**

- Protocol: UDP with application-level reliability
- Why UDP: 60 updates/second; 16ms between frames; TCP retransmission latency (typically 30–100ms) exceeds one frame interval → stale game state delivered late is worse than no delivery
- Application-level selective reliability: position updates = unreliable (player will send next position anyway); critical events (respawn, ability use, damage) = reliable (application retransmits until ACK'd)
- Library: ENet, GameNetworkingSockets (Valve), or custom UDP with sequence numbers + selective ACK

**Player ↔ AWS Entry Point:**

- AWS Global Accelerator: anycast UDP entry at nearest AWS edge PoP
- UDP 7000-8000 → NLB in each region → EC2 game servers
- NLB: UDP listener, preserves source IP (game servers need player IP for anti-cheat)
- NLB static EIP: players in some countries firewall everything except known IPs

**Game Server Mesh (state synchronization between game servers):**

- Protocol: TCP + gRPC (reliable, ordered state sync between authoritative servers)
- Rationale: inter-server state sync is not latency-critical; correctness is paramount
- AWS: Private NLB or direct Service Mesh (App Mesh) over TCP

**Match-making and REST API (pre-game):**

- Protocol: HTTPS (TCP, ALB, HTTP/2)
- Rationale: non-real-time, reliability critical (payment, authentication, match history)

**Architecture diagram:**

```
Player → [Global Accelerator anycast IP] → nearest AWS PoP
       → AWS backbone → NLB (UDP:7000) → Game Server EC2
                                          ↕ TCP gRPC
                                     Game State Sync Server
       → ALB (HTTPS) → Game REST API → DynamoDB (game state)
```

**Q8: A company runs a real-time IoT sensor platform collecting 10 million short (50-byte) measurements per second from sensors globally. Every measurement from every sensor must be processed. Engineers proposed using UDP for collection. What are the risks and how would you design the collection layer?**

A: UDP for high-volume IoT collection introduces three major risks:

**Risk 1: Data loss undetected at collection layer**
UDP provides no delivery confirmation. A 1% packet drop → 100,000 lost measurements per second. System appears healthy (no errors) but data is silently missing.

**Risk 2: Ordering issues for time-series analysis**
UDP delivers out-of-order. Sensor measurements arriving out-of-order can cause incorrect aggregations (average, min, max across a time window) without explicit timestamps.

**Risk 3: UDP reflection/amplification if endpoint is publicly discoverable**
Attackers can spoof source IPs of sensors to send to your endpoint → responses (if any) go to forged addresses. If your endpoint responds with large payloads, you become an amplifier.

**Recommended design:**

Given "every measurement must be processed":

Option A: TCP with connection pooling (recommended for 99.99% delivery SLA):

```
Sensors → AWS IoT Core (TCP/TLS → MQTT) → Kinesis Data Streams
         MQTT QoS 1 (at-least-once delivery)
         Kinesis: ordered per partition, retained 7 days
         Lambda: processes streams → DynamoDB/TimestreamDB
```

Option B: UDP with application-level ACK and deduplication (for ultra-low-latency sensors):

```
Sensors → NLB (UDP) → Kafka consumer EC2 cluster
          Sensors embed: device_id, sequence_number, timestamp
          Consumer: tracks last_seq per device
          If gap detected: request retransmission (application-level)
          Deduplication: Kafka idempotent producer key = device_id+seq
```

Real-world verdict: AWS IoT Core (MQTT over TCP/TLS) is the production answer for "every measurement must be processed" at scale. MQTT QoS 2 (exactly-once) can be used for critical measurements where duplicates are also problematic.

---

**Continue to File 03** for AWS SAA exam traps, 5 comparison tables, quick revision memory tricks (RUOC/FRE mnemonics), and the architect exercise: diagnosing a production issue where an application fails after 6 minutes of idle connection time on an NLB.
