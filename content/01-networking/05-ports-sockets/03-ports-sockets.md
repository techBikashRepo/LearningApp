# Ports & Sockets — Part 3 of 3

### Topic: AWS Certification Focus, Comparison Tables, Quick Revision, Architect Exercise

**Series:** Networking Fundamentals → System Design → AWS Solutions Architect
**Audience:** 14-Year Experienced Full-Stack Developer → Becoming an Architect
**Sections Covered:** 9, 10, 11, 12

---

## SECTION 9 — AWS & Certification Focus

### AWS SAA Exam — Ports Must-Know Facts

**Security Group Rules — Port Behavior:**

Security groups are **stateful** — you only need to define inbound rules for accepted connections; return traffic is automatically allowed. This is the opposite of NACLs which are stateless.

Key exam point: Security Groups have NO DENY rules — they only allow. If a port is not explicitly allowed, it is implicitly denied. To compare: NACLs have both allow and deny rules, evaluated in order by rule number.

**Port 22 (SSH) — Exam Danger:**

- NEVER open port 22 to 0.0.0.0/0 in a security group — this is a major exam red flag
- Correct answer: use AWS Systems Manager Session Manager (no inbound ports needed at all)
- Alternative: open port 22 only to specific admin IP/VPN CIDR
- AWS Config rule `restricted-ssh` flags security groups with port 22 open to 0.0.0.0/0

**Port 3389 (RDP) — Exam Danger:**

- Same rule as SSH — never open to 0.0.0.0/0
- Use SSM Session Manager for Windows too (RDP over SSM)

**NACLs and Ephemeral Ports (Common Exam Trap):**
When NACLs are configured, students often allow inbound port 443 but forget the outbound ephemeral port range. This causes one-way communication failures:

- Client sends request → arrives on port 443 → NACL allows it
- Server responds → destination port is ephemeral 49152–65535 → outbound NACL blocks it
- Connection times out

Correct NACL configuration for a public web server subnet:

```
Inbound:  TCP 443 from 0.0.0.0/0 → ALLOW
Inbound:  TCP 1024-65535 from 0.0.0.0/0 → ALLOW  (return traffic for outbound requests)
Outbound: TCP 1024-65535 to 0.0.0.0/0 → ALLOW   (ephemeral ports for response)
Outbound: TCP 443 to 0.0.0.0/0 → ALLOW           (for outbound HTTPS calls)
```

---

### ALB and NLB Port Exam Points

**Application Load Balancer (ALB):**

- Operates at Layer 7 (HTTP/HTTPS). Terminates TLS at the ALB.
- Listeners are configured on specific ports (80, 443)
- Routes requests to target groups based on rules (URL path, host header, HTTP method, query string)
- Target group health checks use a specific port
- You can configure ALB to listen on 80 and redirect to 443 (HTTP → HTTPS redirect)
- **Not suitable for non-HTTP protocols** (cannot front a MySQL connection on port 3306)

**Network Load Balancer (NLB):**

- Operates at Layer 4 (TCP/UDP/TLS). Passes traffic directly without inspecting HTTP headers.
- Supports ANY port — can front MySQL (3306), Kafka (9092), custom TCP services
- Static IP per AZ — important for whitelisting in corporate firewalls
- Ultra-low latency — passes through without deep packet inspection
- Source IP preserved — the backend sees the actual client IP (ALB replaces it with ALB IP unless X-Forwarded-For is used)

**Exam scenario:** "You need to whitelist a fixed IP for a partner company to send TCP data on port 9092 to your Kafka cluster." → Answer: **NLB** (static IP support, TCP/Layer 4, custom port)

---

### ECS Dynamic Port Mapping

When running containerized applications on ECS with EC2 launch type, each container needs a port. The challenge: if all containers want to bind to port 8080 on the host, only one container can (port conflict). Solution: **dynamic port mapping**.

ECS assigns a random host port from the ephemeral range (1024–65535) for each container. The host port is mapped to the container's internal port 8080:

```
Container 1: host port 32768 → container port 8080
Container 2: host port 32769 → container port 8080
Container 3: host port 32770 → container port 8080
```

The ALB (or NLB) integrates with ECS to automatically discover these dynamic ports. ECS registers each container with the load balancer target group using the dynamically assigned host port.

**Security group requirement:** The EC2 instance's security group must allow the ALB's security group to send traffic on any port in the 32768–61000 range.

**Fargate differs:** Each Fargate task gets its own ENI (Elastic Network Interface) and IP address. There's no port mapping conflict issue — each task has its own IP:port combination. Fargate containers bind directly to their container port on their own IP.

---

### Lambda and Ports

Lambda functions do NOT have ports in the traditional sense. They are invoked through event sources:

- API Gateway or Function URLs (HTTP events)
- SQS, SNS, Kinesis, DynamoDB Streams (queue/stream events)
- EventBridge (scheduled or custom events)
- Direct SDK invocation

**Lambda Function URLs** do expose an HTTPS endpoint on port 443. But Lambda itself doesn't bind to a port — the Function URL endpoint handles port management at the Lambda service level.

**The Lambda + RDS socket problem** (covered in File 02): Lambda's connection to RDS opens a TCP socket to the RDS port (e.g., 5432 for PostgreSQL). Each Lambda invocation may open a new socket, leading to connection storms. Fix: RDS Proxy.

**Key exam point:** For Lambda connecting to databases:

- VPC-enabled Lambda → RDS Proxy → RDS (for connection pooling)
- Lambda security group must allow outbound on the DB port (5432, 3306)
- RDS security group must allow inbound on the DB port from Lambda security group

---

## SECTION 10 — Comparison Tables

### Table 1: Port Range Categories

| Range         | Name                | Ports  | Assignment                          | Examples                                                                       |
| ------------- | ------------------- | ------ | ----------------------------------- | ------------------------------------------------------------------------------ |
| 0 – 1023      | Well-Known / System | 1,024  | IANA-assigned; requires root        | 22 (SSH), 80 (HTTP), 443 (HTTPS), 3306 (MySQL), 5432 (PostgreSQL)              |
| 1024 – 49151  | Registered          | 48,128 | IANA-registered; user-space         | 8080 (alt HTTP), 8443 (alt HTTPS), 6379 (Redis), 9092 (Kafka), 27017 (MongoDB) |
| 49152 – 65535 | Ephemeral / Dynamic | 16,384 | OS-assigned; temporary client ports | Assigned automatically per connection                                          |

---

### Table 2: TCP vs UDP — When to Use Which

| Dimension          | TCP                                           | UDP                                           |
| ------------------ | --------------------------------------------- | --------------------------------------------- |
| Connection         | Connection-oriented (3-way handshake)         | Connectionless — send and forget              |
| Reliability        | Guaranteed delivery, ordering, no duplication | Best-effort, no guarantee                     |
| Error handling     | Retransmission of lost packets                | Application-level or none                     |
| Speed              | Slower (overhead for reliability)             | Faster (minimal overhead)                     |
| Use cases          | HTTP, HTTPS, SSH, FTP, SMTP, databases        | DNS, video streaming, VoIP, gaming, NTP       |
| Well-known ports   | 80, 443, 22, 3306, 5432                       | 53, 123, 161, 514, 4500                       |
| Congestion control | Yes (AIMD, TCP New Reno)                      | No                                            |
| Overhead           | 20-byte header minimum                        | 8-byte header only                            |
| AWS example        | ALB (HTTP/HTTPS), RDS                         | Route 53 DNS resolution, NTP to AWS Time Sync |

---

### Table 3: HTTP Ports and Protocol Comparison

| Protocol  | Default Port | Transport  | Connection                                 | Use Case                   |
| --------- | ------------ | ---------- | ------------------------------------------ | -------------------------- |
| HTTP/1.0  | 80           | TCP        | Close after each response                  | Legacy, deprecated         |
| HTTP/1.1  | 80           | TCP        | Keep-Alive (persistent)                    | Most web traffic today     |
| HTTPS     | 443          | TCP + TLS  | Keep-Alive + encrypted                     | Secure web communications  |
| HTTP/2    | 443          | TCP + TLS  | Multiplexed streams on one socket          | Modern APIs, browsers      |
| HTTP/3    | 443          | UDP (QUIC) | Multiple streams, no head-of-line blocking | YouTube, Google services   |
| WebSocket | 80 / 443     | TCP        | Persistent bidirectional                   | Chat, live updates, gaming |
| gRPC      | 443          | HTTP/2     | Long-lived multiplexed                     | Microservice communication |

---

### Table 4: Server vs Client Socket Comparison

| Aspect    | Server Socket                                 | Client Socket                               |
| --------- | --------------------------------------------- | ------------------------------------------- |
| Port type | Well-known or registered (80, 443, 3306)      | Ephemeral (49152–65535), OS-assigned        |
| Binding   | Explicitly binds to a fixed port (`bind()`)   | OS assigns ephemeral port automatically     |
| State     | Stays in LISTEN state waiting for connections | Connects to a remote server                 |
| Lifecycle | Long-lived (lives as long as server runs)     | Connection lifetime = request lifetime      |
| Count     | One listening socket per port                 | One socket per connection                   |
| Example   | nginx listening on `0.0.0.0:443`              | Browser connecting from `192.168.1.5:54321` |

---

### Table 5: AWS Load Balancer Port Characteristics

| Feature                | ALB                        | NLB                                      | GLB                     |
| ---------------------- | -------------------------- | ---------------------------------------- | ----------------------- |
| Layer                  | L7 (HTTP/HTTPS)            | L4 (TCP/UDP/TLS)                         | L3+L4                   |
| Supported ports        | 80, 443 (HTTP/HTTPS only)  | Any TCP/UDP port                         | All ports (transparent) |
| TLS termination        | Yes — at ALB               | Yes — at NLB, pass-through, or at target | No                      |
| Static IP              | No — uses DNS              | Yes — per AZ                             | Yes                     |
| Source IP preservation | Via X-Forwarded-For header | Native (client IP preserved)             | Native                  |
| Use case               | Web apps, microservices    | Kafka, databases, fixed-IP requirements  | Security appliances     |

---

## SECTION 11 — Quick Revision & Memory Tricks

### 10 Key Points — Ports & Sockets

1. **A port is a 16-bit number (0–65535)** identifying a service/process on a host; it's the "apartment number" on top of the IP address "building"

2. **A socket = IP address + port** — the complete destination address for a network connection; a socket pair (4-tuple: src-IP, src-port, dst-IP, dst-port) uniquely identifies every active TCP connection on the internet

3. **Well-known ports (0–1023) require root privileges** to bind; this prevents unprivileged users from hijacking system services; all critical internet services live here

4. **Ephemeral ports (49152–65535) are temporary** — OS assigns one per outbound connection; at high connection rates, these can be exhausted → connection exhaustion; solution: connection pooling

5. **TIME_WAIT state holds a socket open for 2×MSL (approx 60–120 seconds)** after closing to absorb any delayed packets; prevents old packets from corrupting new connections on the same port pair

6. **Connection pooling reuses sockets** instead of open/close per request; essential for database connections — prevents "Too many connections" errors and eliminates handshake latency per query

7. **NACLs are stateless** — return traffic on ephemeral port range (1024–65535) must be explicitly allowed in outbound rules; Security Groups are stateful — return traffic is automatically allowed

8. **ALB terminates TLS on port 443; NLB can forward any TCP port** without inspection — use NLB for non-HTTP protocols (Kafka, databases, custom TCP)

9. **ECS dynamic port mapping assigns random host ports per container** — the ALB discovers these dynamically via ECS service discovery; Fargate eliminates this complexity with per-task ENIs

10. **Lambda + RDS requires RDS Proxy** to avoid connection storms — Lambda's stateless scaling model is incompatible with database persistent connection models without a proxy

---

### 30-Second Explanation

"Ports are numbers 0 to 65535 that identify which service on a server should receive a network packet. A socket combines an IP address with a port into a complete endpoint. Every TCP connection is defined by four things: source IP, source port, destination IP, destination port. Clients use temporary ephemeral ports; servers use stable well-known ports like 443 for HTTPS. For system design, always use connection pooling for database access — it reuses sockets instead of opening new ones per request, preventing database connection limit exhaustion at scale."

---

### Memory Tricks

**Well-known ports: "SSHing FROM the Web Always Makes Perfect Sense"**

- **S** = SSH → 22
- **F** = FTP → 21
- **W** = Web (HTTP) → 80
- **A** = Always (HTTPS) → 443
- **M** = MySQL → 3306
- **P** = PostgreSQL → 5432
- **S** = (Redis) Sorted Sets → 6379

**Socket 4-tuple: "SSDD" — Source Source Destination Destination**

- Source IP, Source Port, Destination IP, Destination Port

**NACL trick: "Stateless = Say Both Ways"**

- NACLs (stateless) require rules in BOTH directions (inbound + outbound)
- Security Groups (stateful) = set it once for inbound, return is automatic

**Port ranges: "W-R-E" = Well, Registered, Ephemeral**

- Well-known: 0–1023 (needs root)
- Registered: 1024–49151 (application ports)
- Ephemeral: 49152–65535 (temporary client assignments)

**TIME_WAIT: "After Goodbye, Wait and Listen"**

- After a connection closes, the socket waits 2×MSL (~120s) — preventing phantom packet confusion

**ECS port mapping: "Many Containers, Many Ports, One ALB Knows All"**

- Each container gets a random host port → ALB dynamically registers them

---

### Exam Quick-Fire Facts

- Can two processes share the same port on the same server? No — only with `SO_REUSEPORT` (advanced; used by nginx for multi-worker)
- What port does SMTP use? 25 (sending), 587 (submission with auth), 465 (SMTPS)
- What port does LDAP use? 389 (LDAP), 636 (LDAPS)
- What port does Elasticsearch use? 9200 (HTTP API), 9300 (node communication)
- Maximum connections to a single server:port from one client IP? Limited by ephemeral port range (~16,384 with default Linux settings; can be increased)
- RDS Proxy — which Lambda scenario needs it? Lambda → RDS because Lambda's auto-scaling creates too many connections

---

## SECTION 12 — Architect Thinking Exercise

### Exercise: Design a Real-Time Collaborative Code Editor (Like VS Code Live Share)

You are the lead architect. A startup wants to build a collaborative code editing platform (think: multiple users editing the same file in real-time, like Google Docs but for code). Target: 500,000 simultaneous editing sessions, each session with 2–8 participants.

**Calculate the problem:**

- 500,000 sessions × 4 average users = 2,000,000 simultaneously connected users
- Each user has a persistent WebSocket connection
- Keystrokes must be broadcast to all users in the same session (Operational Transformation or CRDT algorithm)
- Latency requirement: < 100ms for a keystroke to appear on all users' screens globally

**Design the port and socket architecture:**

Before reading the solution below, think about:

1. How many WebSocket servers do you need, and what port do they run on?
2. Where does the message routing happen (from user A's keystroke to user B, C, D)?
3. How do session participants find each other?
4. What happens when the WebSocket server holding one user's connection fails?
5. What AWS services would you use?

---

### Solution Walkthrough

**Step 1 — WebSocket Server Layer**

Dedicated WebSocket connection servers running on port 443 (wss:// — secure WebSocket, works through all corporate firewalls and proxies). Never use port 80 for WebSockets in production.

- Each server can handle ~50,000 concurrent WebSocket connections (tuned file descriptors, event-driven I/O)
- 2,000,000 connections / 50,000 per server = 40 WebSocket servers minimum
- Add 50% headroom = 60 servers deployed (Aurora of ECS tasks or EC2 behind NLB)
- Use NLB (not ALB) — WebSocket connections are long-lived (hours); NLB has no connection timeout by default; ALB has 4000s idle timeout which may close inactive editors. More importantly, NLB passes actual TCP connections through.

**Step 2 — Session Pub/Sub Layer**

When User A types a character in Session #8829:

- A's WebSocket connection is on Server #12
- B, C, D in the same session might be on Server #12, #34, #7
- The keystroke event must reach all of them regardless of which server they're on

Use Redis Pub/Sub per session:

- User A connects to Server 12 → Server 12 subscribes to Redis channel "session:8829"
- User B connects to Server 34 → Server 34 subscribes to Redis channel "session:8829"
- When A sends a keystroke, Server 12 publishes to "session:8829" channel in Redis
- Both Server 12 and Server 34 receive the publish event
- Server 12 sends it to all local users in session 8829
- Server 34 sends it to all its local users in session 8829

For global sub-100ms latency: use Redis clusters in multiple AWS regions, with CRDT for eventual consistency across regions. Alternatively, use AWS's ElastiCache for Redis (in-memory, microsecond pub/sub).

**Step 3 — Session Routing and Discovery**

Users connecting to the editor URL must reach a WebSocket server. NLB doesn't have application-level routing, so session routing must happen at the application protocol level during WebSocket handshake:

- Client sends connection request to `wss://collab.mycompany.com` (NLB endpoint)
- NLB routes to one of 60 WebSocket servers (round-robin or least-connections)
- WebSocket server receives upgrade request, notes the session ID from the URL path
- Subscribes to the appropriate Redis channel

**Step 4 — Failure Handling**

If Server #12 fails:

- 50,000 users lose their WebSocket connection
- Clients are configured to reconnect automatically (exponential backoff: 1s, 2s, 4s, 8s)
- NLB health checks detect the failed server within 10 seconds and stop routing to it
- Reconnecting users are distributed across remaining servers
- Redis pub/sub subscription on Server 12 is gone — clients reconnect and re-subscribe

Key: **WebSocket servers must be stateless** for this to work. No session state on the server itself — document state is in Redis/DynamoDB, not in server memory.

**Step 5 — Socket Port Architecture Summary**

```
+-----------------------------------------------+
|  User's Browser                               |
|  WebSocket client → ephemeral src port ~54xxx  |
+------------------+----------------------------+
                   | wss:// (port 443)
                   ▼
+------------------+----------------------------+
|  AWS NLB (Network Load Balancer)              |
|  Static IP, TCP pass-through on port 443      |
+------------------+----------------------------+
                   | Port 443 (TLS-terminated at server)
          ┌────────┼────────┐
          ▼        ▼        ▼
  ┌───────────┐ ┌──────┐ ┌──────┐
  │ WS Server │ │ WS   │ │ WS   │
  │ Port 443  │ │ Port │ │ Port │
  │ 50k conns │ │ 443  │ │ 443  │
  └─────┬─────┘ └──┬───┘ └──┬───┘
        └──────────┼─────────┘
                   ▼ Port 6379 (Redis)
          ┌────────────────┐
          │  ElastiCache   │
          │  Redis Cluster │
          │  Pub/Sub Layer │
          └───────┬────────┘
                  ▼ Port 443 (HTTPS)
          ┌────────────────┐
          │  DynamoDB      │
          │  (doc storage) │
          └────────────────┘
```

**Port/Security Group summary:**

- NLB → WebSocket Servers: Port 443 inbound open to 0.0.0.0/0
- WebSocket Servers → ElastiCache Redis: Port 6379 inbound from WebSocket server SG
- WebSocket Servers → DynamoDB: Port 443 via VPC endpoint (no internet exposure)
- No SSH ports open — use SSM Session Manager for admin access

This architecture powers Figma, VS Code Live Share, Google Docs, and collaborative tools at massive scale.

---

## Complete Series Summary — Ports & Sockets

| File    | Sections | Key Takeaways                                                                                                                                                                                    |
| ------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| File 01 | 1–4      | Port = apartment number on IP building; 0-65535 ranges; socket = IP:Port; 4-tuple uniqueness; ephemeral ports; TIME_WAIT; 3-tier port architecture                                               |
| File 02 | 5–8      | Airport/switchboard analogies; C10K event-driven model; connection pooling prevents DB overload; AWS SG port rules; NACL ephemeral port trap; NLB vs ALB; RDS Proxy for Lambda                   |
| File 03 | 9–12     | AWS SAA exam traps (SSH port 22, NACL stateless, ECS dynamic mapping, RDS Proxy); 5 comparison tables; memory tricks (SSDD, WRE, Stateless=Say Both Ways); collaborative editor WebSocket design |

**Next Topic → Topic 06: Router vs Switch**
How does data actually move through a network? When a packet leaves your machine, how does the infrastructure decide where to send it? Router vs Switch, Layer 2 vs Layer 3, MAC addresses, ARP, VLANs, and how AWS VPC routing tables mirror physical routers.
