# TCP 3-Way Handshake — Part 2 of 3

### Topic: Real-World Connection Patterns, Security Implications, and Interview Mastery

**Series:** Networking Fundamentals → System Design → AWS Solutions Architect
**Sections Covered:** 5, 6, 7, 8

---

## SECTION 5 — Real-World Examples

### Analogy 1 — Bank Vault Entry Protocol

A bank has a secure vault entry system requiring verification before access:

1. You submit your badge (SYN): "I'm employee ID 1000, requesting vault access"
2. The system sends a one-time code to your registered phone (SYN-ACK): "I see your ID 1000. My access token is 5000. Enter the code I just sent you."
3. You enter the code (ACK): "I received your token 5000. Code confirmed: 5001."

Now you're inside the vault. Both parties have verified identities. If step 2 never reached your phone, the vault doesn't open — there's no unauthorized half-entry. The system's challenge-response prevents someone from simply announcing "I'm Employee 1000" without proving they can receive responses at the correct address.

This is exactly TCP's defense: an attacker can SEND SYNs with any source IP, but cannot receive the SYN-ACK to complete the handshake (the SYN-ACK goes to the spoofed IP, not the attacker) — unless the attacker is on the path and can intercept traffic.

### Analogy 2 — Film Clapperboard (Synchronization Before Action)

On a film set, before every take, the clapper loader synchronizes audio and video:

- Shows clapperboard (visual mark) — seen on video track
- Claps the sticks (audio mark) — heard on audio track
- Post-production aligns both tracks within milliseconds

No filming begins until this sync is done. The moment of the clap is the "handshake" — everyone agrees on the starting point. A scene filmed without a clapperboard is unusable — there's no way to know where audio and video are relative to each other.

TCP's handshake is the clapperboard: both sides agree on starting sequence numbers BEFORE any data flows. Without agreed ISNs, there's no way to detect missing data, order segments, or know where data starts.

### Real Software Example — SYN Flood Attack in the Wild: GitHub 2018 DDoS

In February 2018, GitHub experienced the largest DDoS attack seen at that time: **1.35 Tbps peak** using Memcached reflection (not pure SYN flood, but the principle applies). The attack phase relevant to connection establishment:

**How SYN floods happen in practice:**

```
Attacker controls: botnet of 10,000 compromised IoT devices
                   OR uses IP spoofing from reflectors

Attack traffic:
  Rate: 5 million SYN packets/second
  Source IPs: spoofed (randomized)
  Destination: target-server.com:443

At target server:
  Normal SYN queue capacity: 512 entries
  5,000,000 SYN/sec → queue fills in 0.0001 seconds
  Each queue entry: 280 bytes × 512 = 143 KB → small, but...
  SYN-ACKs sent to 5M spoofed IPs → wasted bandwidth
  SYN-ACKs never answered → queue entries age for 60s before timeout
  Legitimate SYN packets: queue full → dropped
  Net effect: service is unreachable for legitimate users

Defense mechanisms:
  1. SYN cookies (Linux net.ipv4.tcp_syncookies=1): eliminates queue memory issue
  2. AWS Shield: absorbs volumetric SYN flood at network layer (1+ Tbps capacity)
  3. CloudFront: edge caching absorbs traffic before reaching origin
  4. Rate limiting per source IP: blocked at network ACL/WAF level
  5. SYN proxy (ALB/NLB behavior): load balancer proxies TCP — completes 3-way handshake on behalf of backend. Backend only sees connections that completed the handshake. SYN floods die at the LB.
```

AWS ALB and NLB act as **SYN proxies** — they absorb the TCP handshake. The backend only ever receives a completed TCP connection, having never seen the individual SYN packets from attackers.

---

## SECTION 6 — Why This Matters for System Design

### Problem 1 — Connection Setup Latency in Microservice Architectures

Every microservice call that creates a new TCP connection pays the handshake tax:

- 1 RTT for TCP SYN/SYN-ACK/ACK
- 1 RTT for TLS handshake (TLS 1.3)
- Total: 2 RTT per new connection before any application data

For services within the same AWS region, latency between services is typically 0.5–2ms. So:

- TCP + TLS: 1–4ms overhead per new connection
- Multiply by 100 microservice calls per request: 100–400ms in pure handshake overhead

**Solution: connection pooling**
Reuse established TCP connections for multiple requests. HTTP/2 multiplexes all requests over one connection. Database connection pools maintain 20–100 persistent pre-established connections.

**Connection pool sizing calculation:**

```
Target: handle 1000 concurrent requests to a database
Query latency: 5ms average
Pool needed: max_concurrent = pending_requests × latency
           = 1000 × 0.005 seconds = 5 connections (steady state)
           But with spikes: multiply by 2–3× → pool size = 10–15 connections

If pool size too small: requests queue waiting for a connection → latency spike
If pool size too large: database memory exhausted (each Postgres connection = ~10MB)
```

### Problem 2 — TIME_WAIT Accumulation at High Scale

A high-traffic web server (ALB target, 100,000 requests/second) with HTTP/1.1 clients that don't use keep-alive:

- Each request: new TCP connection → new 3-way handshake → request/response → 4-way close
- Client-side TIME_WAIT: port stays in TIME_WAIT for 60 seconds after close
- 100,000 connections/second × 60 seconds = 6,000,000 ports in TIME_WAIT
- Linux port range: 28,232 ports available (`ip_local_port_range`)

Result: **port exhaustion** — OS cannot assign ephemeral source ports for new connections. Error: "Cannot assign requested address" (EADDRNOTAVAIL).

**Solutions:**

1. HTTP keep-alive (persistent connections): reuses TCP connections for multiple requests, dramatically reducing new connection rate
2. HTTP/2 multiplexing: single connection for all requests to same server
3. Increase ephemeral port range: `net.ipv4.ip_local_port_range = 1024 65535` (61,511 ports)
4. Enable `tcp_tw_reuse`: allows reusing TIME_WAIT sockets for new outbound connections (safe when timestamps option is used)
5. Reduce TIME_WAIT duration: generally NOT recommended (defeats the purpose)
6. Multiple source IPs: scale-out NAT using multiple Elastic IPs

### Problem 3 — SYN Flood and Service Availability

Your publicly exposed TCP service (game server, custom protocol) is under SYN flood:

- Legitimate players: cannot connect
- Infrastructure logs: SYN queue full errors
- CPU: low (the attack isn't CPU-intensive — it's memory/queue state)

Diagnostic:

```bash
# See current TCP connection states on Linux:
ss -ant | awk '{print $1}' | sort | uniq -c | sort -rn

# Output during SYN flood:
# 500000 SYN-RECV   ← SYN queue entries (should be near 0 normally)
#      5 ESTABLISHED
#      1 LISTEN

# Check SYN cookie status:
cat /proc/sys/net/ipv4/tcp_syncookies  # should be 1

# Check SYN queue size:
cat /proc/sys/net/ipv4/tcp_max_syn_backlog
```

SYN floods are the most fundamental TCP-level DDoS. Every publicly exposed TCP service must have SYN cookie protection and, ideally, an upstream SYN proxy (NLB/ALB) absorbing the flood before it reaches your application.

---

## SECTION 7 — AWS Mapping

### ALB and NLB as SYN Proxies

Both ALB and NLB act as TCP SYN proxies:

- Client connects to ALB/NLB: full 3-way handshake with the load balancer
- ALB/NLB then makes a SEPARATE TCP connection to the backend target
- Backend never sees the client's SYN directly

Benefits:

1. **SYN flood protection:** ALB/NLB absorb all SYN packets. Backends only see established connections. SYN queue on backend = near-empty always.
2. **TLS termination:** ALB terminates TLS with ACM cert. Backends can use plaintext HTTP (no cert management needed on EC2).
3. **Connection reuse:** ALB maintains persistent connection pools to backends. Many client connections reuse a smaller number of backend connections (connection multiplexing).

### ALB Connection Handling

```
Client (browser)          ALB                    Backend EC2

Client → ALB:             ALB → EC2:
TCP SYN                   (connection pooled or new)
TCP SYN-ACK               TCP SYN
TCP ACK                   TCP SYN-ACK
                          TCP ACK

TLS ClientHello           TLS ClientHello (or none if plaintext target)
TLS ServerHello           TLS ServerHello
TLS Finished              TLS Finished

HTTP/2 GET /api           HTTP/1.1 GET /api    (ALB translates HTTP/2 → HTTP/1.1)
HTTP/2 200 response   ◄── HTTP/1.1 200         (ALB translates back)
```

**ALB connection settings (adjustable):**

- Idle timeout: 60 seconds default (increase to 4000s for long-polling, WebSockets)
- HTTP keep-alive: default ON toward both client and backend
- Backend connection reuse: ALB reuses backend TCP connections when possible

### TCP Fast Open (TFO) in AWS Context

TCP Fast Open allows data to be sent in the SYN packet itself (0-RTT data for repeat connections):

Traditional TCP: 1 RTT for handshake, then data (minimum 2 RTT for first request)
TFO round 1 (first connection): same as normal (1 RTT handshake, then data)
TFO round 2+ (repeat connection): TFO cookie included in SYN + first HTTP request data
→ Server can begin processing HTTP request data before ACK arrives
→ Saves 1 RTT for repeat connections = improved page load time

**Security concern:** data in SYN can be replayed (attacker resends old SYN with data → server processes request twice). TFO mitigates via the TFO cookie (proves authenticity). But for non-idempotent requests (POST/PUT), TFO replay can cause duplicate mutations.

AWS: ALB does not currently expose TFO configuration. Linux EC2 instances can enable it at the OS level for direct TCP connections.

### Connection Draining During Deployments

During a rolling deployment, you deregister EC2 instances from the target group. The 3-way handshake affects the graceful shutdown:

**What ALB does:**

1. Mark target as "draining"
2. Stop sending NEW connections to this target (no new 3-way handshakes initiated to this target)
3. Existing established connections (already past handshake) are maintained until they close or timeout (deregistration delay, default 300s)

**Your application's responsibility:**

- Finish processing all in-flight HTTP requests on existing connections
- Send proper HTTP response (not just close TCP connection mid-response)
- ALB waits for in-flight requests to complete before fully removing target

This is why connection draining time matters — if your longest requests take 120 seconds, set deregistration delay to at least 150 seconds.

---

## SECTION 8 — Interview Q&As

### Beginner Questions

**Q1: Why do we need 3 steps in the TCP handshake? Why not 2?**

A: We need 3 steps to achieve **bidirectional sequence number agreement**.

- Step 1 (SYN): Client proves it can send, and proposes its ISN
- Step 2 (SYN-ACK): Server proves it can receive AND send, confirms client's ISN, proposes its own ISN
- Step 3 (ACK): Client proves it can receive AND confirms server's ISN

With only 2 steps (SYN + SYN-ACK, no final ACK):

- The server doesn't know if the client received the SYN-ACK (client might not have gotten the server's ISN)
- Half-open connections accumulate — server has state for connections the client doesn't know about
- No confirmation that server's ISN was received → server can't track what client has acknowledged

The 3rd step (ACK) completes the mutual verification. It's the minimum exchange needed for both sides to have confirmed the other received their initial sequence number.

**Q2: What is the SYN-ACK and what information does it contain?**

A: The SYN-ACK is the server's response to the client's SYN. It is a TCP segment with both the SYN and ACK flags set.

Key fields:

- **SYN flag = 1:** server is also initiating its side of the connection (proposing its own ISN)
- **ACK flag = 1:** server is acknowledging the client's SYN
- **Acknowledgment number = client ISN + 1:** "I received your byte at position `client_ISN`, expecting byte `client_ISN + 1` next"
- **Sequence number = server's ISN:** server's random starting sequence number for its byte stream

The SYN-ACK is efficient because it combines two messages that would otherwise require two separate segments: (1) "here's my ISN" (SYN) and (2) "I received your ISN" (ACK). This is why 3 segments (not 4) are sufficient.

**Q3: What is a SYN flood attack and how does SYN cookies defend against it?**

A: A SYN flood sends millions of TCP SYN packets (usually with spoofed source IPs) to fill the server's SYN queue. Each SYN queue entry represents a half-open connection waiting for the final ACK. When the queue is full, legitimate SYN packets are dropped — the server is unreachable.

SYN cookies remove the need for a SYN queue entry. Instead of allocating memory for the half-open connection, the server encodes all necessary connection parameters (ISN, MSS, timestamps) into a cryptographic hash and uses that as the server's ISN in the SYN-ACK.

When a legitimate client sends the final ACK (containing the server's ISN + 1), the server recovers all connection parameters by reversing the hash — and establishes the connection without ever having allocated a queue entry. Spoofed SYNs never complete the handshake (attacker can't receive the SYN-ACK at the spoofed IP) → no memory consumed → SYN flood becomes harmless.

---

### Intermediate Questions

**Q4: What happens when the final ACK in the handshake is lost? How does TCP handle this?**

A: If the final ACK (Step 3) is lost, the server remains in SYN_RECEIVED state. The server will retransmit the SYN-ACK after a timeout (typically doubling with each retry — exponential backoff), waiting for either:

- The client's ACK to arrive (if it was just slow or took a different path)
- The retransmitted SYN-ACK to trigger a new ACK from the client

The client, having sent the final ACK and transitioned to ESTABLISHED, can immediately send application data. When the server receives application data (sequence numbers are valid even without the ACK having been received), the server interprets the application data's ACK field as the final connection ACK.

So in practice: the client sends ACK + (optionally) the first HTTP request together. Even if the standalone ACK is lost, the application data's ACK field completes the server's state transition.

**Q5: How does TLS 1.3 handshake work on top of TCP, and why is TLS 1.3 faster than TLS 1.2?**

A: TLS 1.3 handshake adds 1 RTT on top of TCP's 1 RTT:

**TLS 1.3 (1 RTT after TCP):**

```
Client → ClientHello + KeyShare (sends ECDHE public key immediately)
Server → ServerHello + Certificate + CertificateVerify + Finished
         (Server picks matching key share, derives session keys immediately)
Client → Finished (derives session keys, confirms)
         Application data can begin from here
```

Server has application data from client in NEXT round trip after TCP handshake = total 2 RTT (TCP + TLS) before first application byte.

**TLS 1.2 (2 RTT after TCP = 3 RTT total):**

```
Client → ClientHello (supported ciphers only, no key yet)
Server → ServerHello + Certificate (picks cipher, sends cert)
Client → Key exchange (sends encrypted pre-master secret)
Server → Change cipher spec + Finished
Client → Change cipher spec + Finished
```

TLS 1.2 required an extra round trip because the client had to wait for the server's cipher selection before sending key material. TLS 1.3 eliminates this by sending key material speculatively in the first ClientHello.

**TLS 1.3 0-RTT resumption:**
For reconnecting clients, TLS 1.3 session tickets allow the client to send application data immediately in the first flight (0 additional RTT after TCP). The server decrypts using the previous session's ticket. Total: TCP handshake (1 RTT) + immediate application data = 2 RTT total for first byte (vs 3 RTT total for TLS 1.2 fresh connection).

**Q6: What is the ephemeral port range and what happens when it's exhausted?**

A: When a client (or server acting as client for outbound connections) initiates a TCP connection, the OS assigns a random source port from the **ephemeral port range** (`/proc/sys/net/ipv4/ip_local_port_range`, default 32768–60999 = ~28,000 ports).

When exhausted:

- `connect()` syscall returns **EADDRNOTAVAIL** (Error: Address Not Available)
- Application: "failed to connect to X"
- No new TCP connections can be established (existing ones still work)

This happens at VERY high connection rates or when many connections are in TIME_WAIT (each consumes a port).

**Production scenario:** a Lambda function making 30,000 new database connections per second to an RDS instance via NLB would exhaust the ~28,000 port range within ~1 second if connections aren't being reused.

**Fixes:**

1. `ip_local_port_range = 1024 65535` → 64,511 ports
2. Enable connection reuse (`tcp_tw_reuse=1`)
3. Use connection pools (most important fix — reduces new connection rate to near-zero once pool is warm)
4. Scale horizontally across multiple source IPs (each EC2 instance has its own port range)

---

### Advanced System Design Questions

**Q7: Design a highly available API service that minimizes TCP handshake latency globally for users in 5 continents. What infrastructure decisions reduce the TCP handshake cost?**

A: The TCP handshake cost is fundamentally bounded by the speed of light (RTT to server). For a server in us-east-1, a user in Sydney faces ~200ms RTT for the handshake alone. Here's how to reduce it:

**Strategy 1 — Global anycast edge termination:**

- CloudFront (global CDN with 400+ PoPs) or Global Accelerator terminates TCP at the nearest edge
- Sydney user → Sydney CloudFront PoP: ~5ms RTT for handshake
- CloudFront → us-east-1 origin: ~170ms RTT over AWS backbone (already established, pooled)
- Net win: Sydney user pays 5ms instead of 200ms for TCP handshake
- CloudFront reuses the existing TCP connection to origin for thousands of concurrent users

**Strategy 2 — HTTP/2 multiplexing for subsequent requests:**

- After the first connection (DNS + TCP + TLS = ~30ms within a region), all subsequent requests reuse the connection
- HTTP/2 HEADERS frame instead of new TCP connection = ~0 RTT overhead
- Long-lived connections (browsers keep connection alive for session duration)

**Strategy 3 — TLS 1.3 session resumption:**

- For returning users (same browser session), 0-RTT session resumption eliminates TLS overhead
- Saves 1 RTT per reconnection (user closes and re-opens tab, etc.)

**Strategy 4 — Multi-region active-active deployment:**

- Deploy full stack in us-east-1, eu-west-1, ap-southeast-1, ap-northeast-1, sa-east-1
- Route 53 latency routing: each user queries the nearest region's ALB
- Sydney → ap-southeast-1 Singapore: ~30ms RTT (much better than us-east-1)
- Active-active requires data synchronization (DynamoDB Global Tables, Aurora Global, Elasticache Global)

**Cost-optimal approach:** CloudFront + ALB in 2–3 regions. CloudFront provides edge termination, origin shield, and HTTP/3 support. Total handshake latency from anywhere: 10–30ms (vs 50–200ms without CDN).

**Q8: During a load test, you notice that your application server creates millions of connections in TIME_WAIT state. Explain the cause, whether this is a problem, and what to do.**

A: TIME_WAIT on the client side is expected and often normal. Here's the analysis:

**Why TIME_WAIT accumulates during load test:**

- Your load test creates new TCP connections for each request (no keep-alive, or HTTP/1.0 behavior)
- Each connection after close enters TIME_WAIT for 60 seconds (2×MSL)
- At 10,000 req/sec: 600,000 ports in TIME_WAIT simultaneously

**Is this a problem?**

- **Memory:** each TIME_WAIT socket uses ~400 bytes (tiny). 1 million = 400 MB. Could matter on small instances.
- **Port exhaustion:** ~28,000 ports in default range. 10,000 req/sec would exhaust ports in ~3 seconds → EADDRNOTAVAIL errors

**What to do:**

Option A (Preferred): Fix the root cause — enable HTTP keep-alive

```
# All modern HTTP clients default to keep-alive
# Verify your load test tool is using keep-alive:
curl -H "Connection: keep-alive" https://...
# HTTP/2 clients reuse connections automatically
```

Option B: Increase port range

```bash
echo "1024 65535" > /proc/sys/net/ipv4/ip_local_port_range
# 64,511 ports instead of 28,232
```

Option C: Enable TIME_WAIT socket reuse

```bash
echo 1 > /proc/sys/net/ipv4/tcp_tw_reuse
# Allows reuse of TIME_WAIT sockets for new outbound connections
# Safe when timestamps option enabled (prevents ghost packet issues)
```

Option D: Check if TIME_WAIT is on server or client

```bash
ss -ant | grep TIME-WAIT | wc -l
# If on load test server (client): port exhaustion risk → Options A-C
# If on application server (passive closer): usually fine (server has more IPs available)
```

Real production verdict: if you see TIME_WAIT on your app server's side, it usually means your server is actively closing connections. For REST APIs, server should generally let client close → TIME_WAIT stays on client side. Verify connection close behavior in your framework.

---

**Continue to File 03** for AWS SAA exam traps, 5 comparison tables, quick revision memory tricks, and the architect exercise: designing a resilient connection handling strategy for a high-frequency trading platform where TCP handshake latency directly impacts revenue.
