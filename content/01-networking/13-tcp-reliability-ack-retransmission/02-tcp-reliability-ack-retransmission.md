# TCP Reliability (ACK, Retransmission) — Part 2 of 3

### Topic: TCP Reliability in Production Systems and AWS

**Series:** Networking Fundamentals → System Design → AWS Solutions Architect
**Audience:** 14-Year Experienced Full-Stack Developer → Becoming an Architect
**Sections Covered:** 5, 6, 7, 8

---

## SECTION 5 — Real World Examples

### Analogy 1 — The Court Reporter Transcript

A court reporter is transcribing a deposition. The attorney is speaking quickly. The reporter has a protocol:

- Reporter writes down every word in a numbered pad (sequence numbers)
- Every few minutes, reporter says: "Confirmed through statement #47" (cumulative ACK)
- If she misses words #33-35 (network noise), she immediately writes: "CONFIRM #32. Also have #36-#51, missing #33-35" (SACK)
- Attorney doesn't re-read from word #1 — just repeats the three missing statements
- If attorney stops and hears nothing for 30 seconds: assumes reporter is overwhelmed, slows down (congestion control / backpressure)

The court reporter's confirmation protocol is exactly how a high-throughput file server knows which TCP segments need retransmission.

### Analogy 2 — Airline Baggage Check

You check 10 bags at the counter. Each bag gets a unique tag number (sequence number).

At your destination carousel:

- Bags 1, 2, 4, 5, 6 arrive (3 is still in transit)
- You scan your app: "Missing bag #3, have bags 4-6" (SACK blocks)
- Airline doesn't refly bags 3-10. Airline searches for bag #3 only (targeted retransmission)
- You stand at the carousel. More bags arrive: #7, #8
- You continue scanning: "Still missing #3, now have 4-8" (cumulative dup ACKs + updated SACK)
- Bag #3 finally arrives → you walk away with all 10 (stream is complete)

This illustrates why SACK dramatically improves performance on high-loss links (satellite, wireless, long-distance fiber). Without it, losing one bag means rechecking all subsequent ones.

### Real Software Example — QUIC and Per-Stream Reliability

**The TCP Head-of-Line Blocking Problem (HOL blocking):**

HTTP/2 multiplexes multiple requests over a single TCP connection:

```
Client ──── TCP connection ────► Server
  Stream 1: GET /api/users      (in-flight)
  Stream 2: GET /api/products   (in-flight)
  Stream 3: GET /api/orders     (in-flight)
```

If one TCP segment for Stream 1 is lost:

```
Segment for Stream 1 (bytes 1501-2000) dropped by router

Receiver gets all Stream 2 and 3 data
But TCP ACK can only advance to 1500 (gap at 1501)
Result: ALL data for Streams 2 and 3 sits in receive buffer
        Application cannot read any stream
        Stream 2 and 3 are BLOCKED by Stream 1's loss
        This is TCP Head-of-Line Blocking
```

**QUIC's solution (used by HTTP/3):**

```
QUIC runs over UDP
Each stream has its own reliability mechanism WITHIN QUIC
A lost QUIC packet for Stream 1:
  - Blocks Stream 1 only
  - Streams 2 and 3 continue delivering data unaffected
  - Stream 1 recovers independently via QUIC retransmission

Result: HTTP/3 over QUIC performs significantly better than
        HTTP/2 over TCP on mobile/lossy networks
        Google measured ~30% lower mean page load time
```

QUIC also improves on TCP reliability in:

- **Connection migration:** if the IP address changes (WiFi → 4G), the QUIC connection survives using connection IDs. TCP would break (connection identified by 4-tuple: srcIP, srcPort, dstIP, dstPort)
- **0-RTT resumption:** client sends data in first packet to a previously-visited server
- **Mandatory TLS 1.3:** no plaintext QUIC; security is built into the transport layer

---

## SECTION 6 — System Design Importance

### 1. Understanding TCP Reliability Prevents Over-Engineering

**Common mistake:** Implementing application-level ACKs and retry logic when communicating over TCP.

```
Bad pattern (seen in production):
  Client sends HTTP POST /payment → Server
  Server processes, but response arrives after client-side timeout (5 seconds)
  Client: "TCP might have failed, let me retry"
  Client sends second POST /payment
  Server processes BOTH (payment created twice)
  Customer charged twice

Misunderstanding: "Maybe TCP failed silently"
Reality: TCP guarantees delivery or explicit failure (RST/timeout exception)
  If the HTTP response arrived late, TCP delivered it correctly
  The timeout was an application-level timeout, not TCP failure
  TCP itself would have retransmitted reliably

Fix: Make payment endpoint idempotent (idempotency key + server-side deduplication)
  Because the problem is not TCP reliability — it's at-least-once vs exactly-once semantics
  at the APPLICATION layer, not transport layer
```

### 2. TCP Retransmissions Are Visible and Measurable

When latency spikes occur in production without obvious cause:

```
Symptoms:
  - 99th percentile latency suddenly increases
  - CPU and DB query times look fine
  - Some requests take 200ms, most take 10ms

Investigation:
  CloudWatch → Network metrics → TCP Retransmit Count
  OR
  ss -s  (show TCP statistics including retransmits)
  netstat -s | grep retransmit

Root causes:
  - Network congestion between AZs (cross-AZ traffic at peak)
  - MTU mismatch causing fragmentation/loss
  - NIC flap causing brief packet loss
  - Overloaded receiver (receive buffer full → dropped packets)

Fix:
  - Same-AZ communication (reduce cross-AZ)
  - Jumbo frames (MTU 9001 on VPC, requires instances to support)
  - ENA Enhanced Networking
  - Increase receive buffer: net.core.rmem_max = 134217728
```

### 3. Congestion Collapse and the Importance of AIMD

**Congestion collapse (1986 Internet crisis):**
Without congestion control, senders send at full speed. When packets drop:

- Classic bug: "Retransmit immediately if ACK not received"
- This means EVERY sender retransmits as fast as possible
- Network gets more congested → more drops → more retransmissions
- Result: network throughput drops to near zero despite everyone sending
- In 1986, ARPANET throughput dropped from 32 Kbps to 40 bps due to this

**Jacobson's fix (1988):** TCP congestion control (slow start + AIMD). The algorithm forces senders to probe for available bandwidth rather than assume it.

This is why modifying TCP congestion control is dangerous:

- UDP-based applications that don't implement AIMD are "network unfriendly"
- They take bandwidth without backing off, causing congestion collapse at scale
- This is why video streaming apps that use UDP still implement AIMD internally (WebRTC REMB, Google Congestion Control)

### 4. Throughput Formula and Buffer Sizing

**Mathis formula for TCP throughput:**
$$\text{Throughput} \leq \frac{MSS}{RTT \cdot \sqrt{p}}$$

Where:

- MSS = Maximum Segment Size (bytes, typically 1460)
- RTT = Round-trip time
- p = packet loss rate (probability 0.0 to 1.0)

For 20ms RTT and 1% packet loss:
$$\text{Throughput} \leq \frac{1460}{0.02 \cdot \sqrt{0.01}} = \frac{1460}{0.002} = 730\text{ KB/s} \approx 5.8\text{ Mbps}$$

This is why satellite internet (500ms RTT, 1% loss) achieves terrible TCP throughput. QUIC with BBR congestion control dramatically improves this.

**Socket buffer sizing for high-throughput:**

```
Bandwidth-Delay Product (BDP) = bandwidth × RTT
For 10 Gbps link, 10ms RTT:
  BDP = 10 × 10^9 × 0.01 = 100,000,000 bytes = ~95 MB

TCP socket buffer must be at least BDP to keep the pipe full:
  net.core.rmem_max = 134217728  (128MB)
  net.core.wmem_max = 134217728
  net.ipv4.tcp_rmem = 4096 87380 134217728
  net.ipv4.tcp_wmem = 4096 65536 134217728
  net.ipv4.tcp_window_scaling = 1  # required for >64KB windows

These settings matter for:
  - Data transfer between EC2 instances (especially cross-region)
  - S3 large object uploads (multipart upload parallelism compensates)
  - Direct Connect circuits (10Gbps, low latency)
  - EC2 Cluster Placement Groups (25-100 Gbps with ENA)
```

### 5. TCP Reliability vs Message Durability — A Critical Distinction

Architects frequently confuse these two:

**TCP reliability:** guarantees bytes get from sender's write() to receiver's read(). It does NOT guarantee:

- Data was written to disk on the receiver
- Application processed the data
- Application didn't crash after receiving but before persisting

**Example:** Your application writes a payment event to a Kafka broker over TCP. TCP delivers the bytes to Kafka's socket buffer. If Kafka crashes before it flushes the socket buffer to disk → that data is lost.

**Solution:** Kafka's `acks=all` + `min.insync.replicas=2` ensures data is ALSO replicated and fsynced before ACK is returned to the producer. This is message-level durability, not TCP-level reliability.

**Design rule:** Use TCP for transport reliability. Use application-level acknowledgments (database commit, queue ACK, two-phase commit) for durability guarantees.

---

## SECTION 7 — AWS Mapping

### Enhanced Networking (ENA)

**The problem:** EC2 instances are virtual machines. Without special networking, every packet goes through the hypervisor:

```
EC2 Instance → hypervisor virtual NIC → hypervisor network stack → physical NIC → network
```

This adds latency and CPU overhead for network I/O. At high packet rates (100K+ PPS), the hypervisor becomes a bottleneck.

**Solution — SR-IOV (Single Root I/O Virtualization):**
Physical NIC presents multiple "virtual functions" directly to VMs. EC2 gets a direct hardware queue bypassing the hypervisor:

```
EC2 Instance → ENA driver → hardware queue on physical NIC → network
        (hypervisor completely bypassed for data path)
```

**AWS ENA (Elastic Network Adapter):**

- Required for modern EC2 instance types (all current generation: M5, C5, R5, etc.)
- Provides up to 100 Gbps (on some instance sizes)
- High PPS rates: up to 14.5 million PPS
- Consistent low latency (microseconds, not milliseconds)
- Automatically used when ENA is supported by both instance type AND AMI

**Impact on TCP reliability:**

- Fewer dropped packets in normal operation → fewer retransmissions
- Better timing accuracy for RTO calculations (consistent latency)
- At high request rates: more consistent TCP behavior under load

### EC2 Placement Groups

| Placement Group Type | Network Performance              | Use Case                                |
| -------------------- | -------------------------------- | --------------------------------------- |
| **Cluster**          | Up to 100 Gbps between instances | HPC, distributed ML, financial systems  |
| **Spread**           | Standard                         | High availability, max 7 per AZ         |
| **Partition**        | Standard                         | Large distributed systems (Kafka, HDFS) |

For TCP-intensive workloads (inter-service communication, data pipelining):

- Cluster Placement Group + ENA = minimum TCP retransmissions
- Same AZ = no cross-AZ TCP latency spikes
- Trade-off: cluster PG = single rack = correlated hardware failure risk

### Route Between Services: Same VPC vs Cross-AZ vs Cross-Region

Impact on TCP reliability and latency:

```
Same AZ, same VPC:
  Latency: sub-millisecond
  TCP retransmit rate: very low (<0.01%)
  Bandwidth: up to instance ENA limit

Cross-AZ (same region):
  Latency: ~1-3ms
  TCP retransmit rate: still low
  Cost: $0.01/GB data transfer

Cross-Region (VPC peering or TGW):
  Latency: 50-200ms depending on regions
  TCP retransmit rate: higher due to long RTT exposing intermittent loss
  RTO: auto-adapts (SRTT grows, RTO grows proportionally)
  Bandwidth: limited by inter-region capacity

Internet (no Direct Connect):
  Latency: variable (30-300ms)
  TCP retransmit rate: 0.01-1% typical
  Use BBR where possible for better performance on variable-latency paths
```

### CloudWatch TCP Metrics

Key metrics for diagnosing TCP reliability issues in production:

| Metric                                             | Where    | What It Means                                         |
| -------------------------------------------------- | -------- | ----------------------------------------------------- |
| `NetworkPacketsIn/Out`                             | EC2      | Total PPS; compare to instance limits                 |
| `NetworkIn/Out` (bytes)                            | EC2      | Bandwidth; compare to instance max                    |
| `ethtool -S` / TCP retransmit via `/proc/net/snmp` | OS level | Raw TCP retransmit counts                             |
| NLB: `TCP_ELB_Reset_Count`                         | NLB      | NLB injected RSTs (idle timeout, backend error)       |
| NLB: `TCP_Target_Reset_Count`                      | NLB      | Backend sent RST                                      |
| NLB: `TCP_Client_Reset_Count`                      | NLB      | Client sent RST                                       |
| `TargetResponseTime` P99                           | ALB      | Latency spikes often correlate with retransmit storms |

### Direct Connect and TCP Reliability

AWS Direct Connect provides a dedicated network path between on-premises and AWS:

```
On-Premises → Direct Connect → AWS VPC
  Latency: deterministic (typically 2-20ms depending on distance)
  No internet congestion
  TCP retransmit rate: near zero (fiber-level reliability)
  Bandwidth: 1 Gbps or 10 Gbps hosted connections
```

Without Direct Connect over VPN:

```
On-Premises → Public Internet → VPN endpoint → AWS VPC
  Latency: variable (50-300ms)
  TCP retransmit rate: 0.01-0.5% typical
  RTO adapts but sawtooth throughput remains
```

This is why Direct Connect is the answer for:

- Database replication between on-prem and AWS (low-latency, no retransmit overhead)
- Large data migration (predictable throughput, no TCP retransmit storms)
- Real-time financial data feeds (consistent sub-10ms latency)

---

## SECTION 8 — Interview Q&As

### Beginner Questions

**Q1: What is a TCP sequence number, and why is it a byte count rather than a segment count?**

A: A TCP sequence number identifies the position of the first byte of a segment in the byte stream. It starts at the ISN (Initial Sequence Number) and increments by the number of bytes sent.

Using byte counting rather than segment counting solves a key problem: if a sender retransmits a segment with different sizes (due to path MTU discovery or fragmentation), the receiver can still identify exactly which bytes it has and which are missing. Segment-level counting would fail in this case. Additionally, the receiver can coalesce bytes arbitrarily, and sequence numbers remain meaningful regardless of how data is segmented.

**Q2: What is the difference between cumulative ACK and SACK?**

A: Cumulative ACK says "I have all bytes up to position N-1; send me N next." It cannot express gaps. If segments 1 and 3 arrive but not 2, the ACK can only say 1 arrived — the sender doesn't know segment 3 is already buffered.

SACK (Selective Acknowledgment, RFC 2018) adds blocks to the ACK that tell the sender exactly which non-contiguous ranges the receiver holds. The sender can compute the exact gap and retransmit only the missing bytes. On high-loss networks (satellite, mobile), this can improve throughput by an order of magnitude versus cumulative-only ACK.

**Q3: What does "3 duplicate ACKs triggers fast retransmit" mean?**

A: When a segment is lost, all subsequent segments from the sender still arrive at the receiver. For each out-of-order segment, the receiver repeats the same ACK (acknowledging the last in-sequence byte), because it can't advance past the gap. These repetitions are called duplicate ACKs.

When the sender sees the same ACK three times (three duplicates after the original), it infers a loss event. The threshold of 3 (rather than 1 or 2) tolerates normal packet reordering (short-lived when packets take different paths). On receiving 3 dup ACKs, the sender immediately retransmits the missing segment without waiting for the RTO timer. Fast retransmit recovers from loss in ~1 RTT vs the RTO which might be 200ms+.

### Intermediate Questions

**Q4: Explain Karn's Algorithm. Why does it matter?**

A: When a TCP sender retransmits a segment and receives an ACK, it cannot tell whether the ACK is for the original transmission or the retransmission. If you assume it's for the original, you calculate a very long RTT — artificially inflating SRTT, causing future RTOs to be too large. If you assume it's for the retransmission, you may calculate a very short RTT — making future RTOs too aggressive.

Karn's algorithm solves this ambiguity by a simple rule: **do not update RTT estimates for retransmitted segments.** Only use ACKs for segments that were NOT retransmitted to update SRTT and RTTVAR. Additionally, Karn specifies that each time a retransmission occurs, the RTO is doubled (exponential backoff) — and this doubled RTO is used until a non-retransmitted segment is successfully ACKed.

This prevents a feedback loop where incorrect RTT measurements cause excessive retransmissions which cause more incorrect RTT measurements.

**Q5: What is TCP congestion collapse and how does AIMD prevent it?**

A: Congestion collapse happens when network load exceeds capacity:

1. Router queues fill → packets drop
2. Senders don't receive ACKs → they retransmit
3. Retransmissions add more traffic to an already-congested network
4. More drops → more retransmissions → throughput approaches zero

Observed on ARPANET in 1986: throughput dropped from 32 Kbps to 40 bps.

AIMD (Additive Increase Multiplicative Decrease) breaks the feedback loop:

- On ACK: increase cwnd by 1 MSS per RTT (gentle increase)
- On loss: halve cwnd (aggressive decrease)
- The asymmetry means a congested network quickly forces senders to back off
- Globally, all TCP senders backing off simultaneously un-congests the network
- The sawtooth cwnd pattern probes for available bandwidth without triggering sustained collapse

AIMD is also fair: multiple TCP flows sharing a bottleneck link converge to equal bandwidth allocation.

**Q6: How does QUIC fix TCP Head-of-Line Blocking?**

A: HTTP/2 multiplexes many streams over a single TCP connection. TCP sees only a byte stream — it doesn't know which bytes belong to which HTTP stream. When a TCP segment is lost, all data after that gap sits in the receiver's buffer until the gap is filled. Even if Streams 2 and 3 have complete data, the application can't read them because Stream 1 has a gap earlier in the byte offset sequence. All streams block.

QUIC runs over UDP and implements reliability per-stream. Each QUIC stream tracks its own offset sequence. A lost UDP packet containing Stream 1 data:

- Triggers retransmission only for Stream 1
- Streams 2 and 3 continue delivering data immediately (different stream ID, independent offset space)
- The QUIC layer knows which stream bytes were in the lost packet and retransmits only those

Result: a 1% packet loss rate that stalls HTTP/2 for ~20ms stalls only the affected HTTP/3 stream while other streams continue.

### Advanced System Design Questions

**Q7: You're building a real-time analytics pipeline that receives 1M events/second from IoT devices over TCP. You notice 99th percentile latency spikes to 500ms every few minutes, but median latency is 1ms. What is likely happening, and how do you diagnose and fix it?**

A: This pattern (low median, intermittent high P99) is a classic TCP retransmit storm signature.

**Likely causes:**

1. Kernel receive buffer overflow: 1M events/sec arriving faster than application reads → receive buffer fills → OS drops new packets → TCP retransmits flood in
2. Cross-AZ traffic with occasional packet loss → RTO timeout (if loss rate is too low to trigger fast retransmit's 3 dup ACK threshold, you fall through to RTO)
3. GC pause on consumer service → 20-50ms pause → receive window goes to zero → connection stalls → window opens → burst → congestion

**Diagnosis:**

```bash
# Per-process socket statistics
ss -tipm | grep -A2 <pid>
# Look for: retrans, rcv_space, snd_buf, rcv_wnd

# System-wide TCP stats
netstat -s | grep -E "retransmit|failed"

# Real-time monitoring
watch -n1 'cat /proc/net/snmp | grep Tcp'

# CloudWatch: TCP retransmits (custom metric via collectd or cwagent)
```

**Fix options:**

1. Increase receive buffer: `net.core.rmem_max=134217728`; `net.ipv4.tcp_rmem=4096 87380 134217728`
2. Reduce GC pause: tune JVM (G1GC, smaller regions); switch to async processing
3. Use UDP with application-level loss tolerance for analytics (can tolerate 0.01% event loss)
4. Use Kafka between IoT → analytics: decouple producer TCP backpressure from analytics processing
5. Horizontal scale: distribute events across multiple consumers, reduce per-connection rate

**Q8: A financial trading system runs on EC2 Cluster Placement Group with ENA. Engineers report that TCP throughput between two instances drops dramatically at market open (9:30 AM) but is fine other times. All instances have Enhanced Networking enabled. What causes this and how do you fix it?**

A: Market open creates traffic bursts — not steady-state load. The issue is likely TCP slow start kicking in repeatedly on short-lived connections.

**Root analysis:**

```
At 9:30 AM:
  Thousands of new TCP connections opened simultaneously (every strategy starts polling)
  Each new connection starts cwnd=10 MSS (modern Linux, RFC 6928 initial cwnd increase)
  With 100µs RTT (cluster PG, ENA): 10 MSS = 14,600 bytes → per-connection rate starts at:
    14,600 × 8 / 0.0001 = 1.168 Gbps per connection
  → Actually not slow start at typical trade-system message sizes (small messages)

Actual culprit: Nagle's algorithm batching small messages
  Typical order: 100-500 bytes (FIX protocol message)
  Nagle's algorithm: don't send small segment if there's unacknowledged data in flight
  At market open: 20 messages queued, all waiting for ACK of first
  Result: 100µs RTT × batching = 1-5ms effective latency spike
```

**Fix:**

```python
# On every financial TCP socket:
import socket
sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
# Disables Nagle's algorithm — sends immediately regardless of size

# Optionally: TCP_QUICKACK on Linux (disable delayed ACKs)
sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_QUICKACK, 1)
```

Plus:

- Pre-warm connections before market open (connection pool, never let connections go cold)
- Use persistent connections (keep sockets in ESTABLISHED state over lunch)
- TCP_CORK alternative: batch intentionally when you want batching, TCP_NODELAY when you don't
- Monitor with `tcpdump` at market open — look for delayed ACKs and Nagle batching in wireshark

---

## File Summary

This file covered:

- Book delivery / baggage claim analogies for sequence numbers, SACK, and targeted retransmission
- QUIC HTTP/3 per-stream reliability vs TCP head-of-line blocking: a concrete QUIC advantage
- Application-layer ACKs vs TCP reliability: TCP delivers bytes, not durability guarantees
- Congestion collapse (1986 ARPANET) and AIMD as the cooperative solution for the internet
- Mathis throughput formula: $\text{BW} \leq \frac{MSS}{RTT \cdot \sqrt{p}}$ — why packet loss cripples TCP
- Socket buffer sizing: bandwidth-delay product = minimum buffer for full pipe utilization
- AWS: ENA/SR-IOV for hypervisor bypass, Cluster Placement Group for low-latency inter-instance
- CloudWatch NLB TCP Reset metrics and EC2 network metrics for retransmit diagnosis
- Direct Connect as the solution for deterministic TCP performance between on-prem and AWS
- 8 interview Q&As covering Karn's algorithm, AIMD, QUIC HOL blocking, P99 spike diagnosis, Nagle's algorithm at market open

**Continue to File 03** for AWS SAA certification traps, 5 comparison tables, Quick Revision with mnemonics, and the Architect Thinking Exercise: diagnosing a retransmit storm causing database write failures during a Black Friday traffic surge.
