# TCP Reliability (ACK, Retransmission) — Part 3 of 3

### Topic: Certification Focus, Tables, Revision, and Architect Exercise

**Series:** Networking Fundamentals → System Design → AWS Solutions Architect
**Audience:** 14-Year Experienced Full-Stack Developer → Becoming an Architect
**Sections Covered:** 9, 10, 11, 12

---

## SECTION 9 — AWS SAA Certification Focus

### Core Exam Facts to Memorize

**Enhanced Networking (ENA):**

- ENA = Elastic Network Adapter. AWS's current-generation SR-IOV implementation.
- Previous generation: Intel 82599 VF (ixgbevf driver). ENA is higher performance.
- To use ENA: BOTH the instance type must support it AND the AMI must have the ENA driver installed.
  - If you create a custom AMI from an ENA-capable instance, the driver is automatically included.
  - If you import a VM from on-premises (VM Import/Export) without ENA driver → no ENA.
  - Fix: install ENA driver before exporting, OR install after import and create new AMI.
- **Exam trap:** "We migrated a VM to EC2 using VM Import but network performance is poor." → ENA driver missing in imported AMI.

**Placement Groups:**

| Type          | Where                          | Purpose                         | TCP Implication                        |
| ------------- | ------------------------------ | ------------------------------- | -------------------------------------- |
| **Cluster**   | Single rack, single AZ         | Max throughput, lowest latency  | Sub-ms RTT, 25-100 Gbps with ENA       |
| **Spread**    | Different racks, different AZs | Max availability                | Standard network, no latency advantage |
| **Partition** | Separate racks (partition)     | Large scale + partial isolation | Kafka/HDFS topology awareness          |

- **Cluster placement group failure risk:** all instances in same rack → single rack failure takes all instances → NOT suited for high availability workloads
- **Exam trap:** "Need both maximum network throughput AND high availability" → Cluster PG gives throughput but NOT HA. Answer: Auto Scaling Group spanning multiple AZs (accepts lower throughput, not cluster PG)
- **Exam trap:** Can you move a running instance into a placement group? → NO. Must stop instance, modify placement, restart.

**EBS-Optimized:**

- Separate network bandwidth for EBS I/O (doesn't compete with instance network traffic)
- On current-generation instances: EBS-optimized is enabled by default at no extra charge
- Older generation: must explicitly enable, may have extra charge
- **Exam trap:** "TCP throughput dropped after adding heavy EBS workload" → If not EBS-optimized, EBS I/O competes with network → enable EBS-optimized OR upgrade to current generation instance

**TCP Keepalive and NLB Health:**

- TCP keepalive is an OS-level mechanism: sends a probe segment when connection is idle
- NLB health check: can use HTTP or TCP (sends TCP SYN, expects SYN-ACK → healthy; RST/timeout → unhealthy)
- NLB idle timeout: 350 seconds (TCP), 120 seconds (UDP)
- **Exam trap:** Sessions dropping after 5 minutes with NLB → idle timeout exceeded → enable TCP keepalives in application (interval < 350s)
- **Exam trap:** ALB health check fails but instance is healthy → security group on instance doesn't allow ALB CIDR on health check port

**TCP and Security Groups (NLB-specific):**

- When using NLB: source IP preservation means the backend sees the actual client IP as source
- Security group on backend instances MUST allow the client IP range, NOT the NLB IP
- ALB terminates TCP: backend sees ALB IP as source (ALB injects X-Forwarded-For header for original client IP)
- **Exam trap:** "NLB backend is rejecting connections" → most common cause: SG allows ALB CIDR but not client CIDR → add client IP range (or 0.0.0.0/0 for internet-facing) to backend SG

**BBR vs CUBIC (not directly tested but relevant for performance questions):**

- Linux default congestion control: CUBIC (since kernel 2.6.19)
- BBR available since kernel 4.9 (Amazon Linux 2023 includes it)
- For high-latency, high-loss links (Direct Connect failures, satellite backup): BBR outperforms CUBIC
- Enable: `sysctl -w net.ipv4.tcp_congestion_control=bbr`
- **SAA exam note:** AWS doesn't test specific congestion algorithms; but BDR/Direct Connect performance questions may reference optimizing OS-level TCP settings

### Potential Exam Trap Summary

| Trap                                   | Wrong Assumption               | Correct Answer                                                      |
| -------------------------------------- | ------------------------------ | ------------------------------------------------------------------- |
| VM Import + slow network               | Instance type supports ENA     | ENA driver must also be in AMI                                      |
| Cluster PG + HA requirement            | Cluster PG = high availability | Cluster PG = same rack = lower HA                                   |
| NLB health check fails                 | NLB IP in SG                   | Client IP range must be in backend SG for NLB                       |
| Latency after moving to NLB            | NLB terminates TCP             | NLB is pass-through; backend SG must be updated                     |
| TCP sessions drop at exactly 350s      | Application bug                | NLB idle timeout; enable TCP keepalives                             |
| Poor throughput on large files via VPN | VPN bandwidth limit            | Socket buffers too small for high BDP; tune tcp_rmem/wmem           |
| Cross-AZ retransmits spike             | Network hardware issue         | Cross-AZ latency increases RTO response time; keep services same-AZ |

---

## SECTION 10 — Comparison Tables

### Table 1 — Cumulative ACK vs SACK

| Property                      | Cumulative ACK                                  | SACK (Selective ACK)                                                          |
| ----------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------- |
| **RFC**                       | Base TCP (RFC 793)                              | RFC 2018 (extension)                                                          |
| **What it tells sender**      | "Received all bytes up to N"                    | "Received all up to N AND these specific ranges beyond N"                     |
| **Negotiation**               | Always present                                  | SYN options must advertise SACK support                                       |
| **On single packet loss**     | Sender may retransmit from loss onward          | Sender retransmits only missing segment                                       |
| **On multiple packet losses** | Very inefficient (may retransmit many segments) | Can report up to 4 SACK blocks per ACK; handles multiple losses               |
| **Header overhead**           | Zero                                            | 8 bytes per SACK block (up to 4 blocks = 32 bytes overhead)                   |
| **Benefit on lossy links**    | Low                                             | High (order-of-magnitude throughput improvement)                              |
| **D-SACK**                    | N/A                                             | Reports already-delivered segments (helps sender detect spurious retransmits) |
| **Modern OS default**         | Yes                                             | Yes (virtually all OSs support SACK)                                          |

### Table 2 — RTO Timer vs Fast Retransmit Trigger

| Property                 | RTO Timeout                                | Fast Retransmit                                            |
| ------------------------ | ------------------------------------------ | ---------------------------------------------------------- |
| **Trigger**              | Timer expires with no ACK                  | 3 duplicate ACKs received                                  |
| **Typical wait time**    | 200ms - 1s (adaptive)                      | ~1 RTT (just 3 more segments needed)                       |
| **cwnd after recovery**  | Reset to 1 MSS (slow start)                | Halved (fast recovery)                                     |
| **ssthresh after**       | Set to cwnd/2                              | Set to cwnd/2                                              |
| **Throughput impact**    | Severe (slow start from cwnd=1)            | Moderate (halved but no slow start restart)                |
| **When triggered**       | Lost segment + no following segments       | Lost segment with subsequent segments arriving             |
| **Tail packet loss**     | Only detectable by RTO                     | Can't detect (no subsequent segments to generate dup ACKs) |
| **Network implication**  | Connection was likely completely congested | One isolated loss (receiver getting other data)            |
| **Congestion algorithm** | CUBIC/BBR enters recovery differently      | CUBIC enters fast recovery                                 |

### Table 3 — TCP Congestion Control Algorithms

| Algorithm      | Standard           | cwnd Growth                    | Loss Response     | Best For                            | AWS Relevance                    |
| -------------- | ------------------ | ------------------------------ | ----------------- | ----------------------------------- | -------------------------------- |
| **Reno**       | RFC 2581           | Linear (CA)                    | Halve cwnd        | Baseline                            | Legacy, rarely used              |
| **CUBIC**      | RFC 8312           | Cubic curve (faster recovery)  | Halve cwnd        | High-BDP wired links                | Default Linux ≥2.6.19; most EC2  |
| **BBR v1**     | Google (2016)      | Bandwidth×RTT model            | Does NOT use loss | High-loss, high-latency             | Amazon Linux 2023 (kernel 6.1)   |
| **BBR v2**     | Google (2019)      | BBRv1 + fairness improvement   | Loss + BW model   | Better coexistence with CUBIC flows | Kernel ≥5.19                     |
| **QUIC CC**    | Per-implementation | Pluggable (CUBIC or BBR)       | Per-stream        | HTTP/3                              | AWS ALB supports HTTP/3          |
| **Slow Start** | RFC 5681           | Exponential (cwnd doubles/RTT) | → ssthresh        | Cold starts                         | Every TCP connection starts here |

### Table 4 — TCP Reliability vs QUIC Stream Reliability

| Property                     | TCP Reliability                   | QUIC Stream Reliability                    |
| ---------------------------- | --------------------------------- | ------------------------------------------ |
| **Scope**                    | Entire connection (byte stream)   | Per-stream (independent)                   |
| **Head-of-line blocking**    | Yes: one loss blocks all streams  | No: only the affected stream blocks        |
| **Retransmission unit**      | TCP segments (byte ranges)        | QUIC frames (can be re-framed)             |
| **Connection migration**     | Breaks on IP change (new 4-tuple) | Survives (connection ID-based)             |
| **TLS**                      | Separate negotiation (adds RTT)   | Mandatory, integrated (1-RTT)              |
| **0-RTT data**               | TCP Fast Open (replay risk)       | QUIC 0-RTT (better security model)         |
| **Congestion control**       | OS-level                          | Application-level (more tunable)           |
| **OS kernel implementation** | Yes (battle-tested)               | Mostly userspace (evolving)                |
| **Connection setup**         | 1 RTT (TCP) + 1-2 RTT (TLS)       | 1 RTT first visit, 0 RTT resumption        |
| **Protocol**                 | TCP port 443 or any               | UDP port 443 (may be blocked by firewalls) |

### Table 5 — Normal TCP State vs Congested TCP State vs Retransmit Storm

| State                        | cwnd Behavior                 | ACK Pattern          | Throughput  | Latency             | CPU Impact                 |
| ---------------------------- | ----------------------------- | -------------------- | ----------- | ------------------- | -------------------------- |
| **Slow start**               | Exponential growth (×2/RTT)   | Steady ACK stream    | Ramping up  | Increasing          | Low                        |
| **Congestion avoidance**     | Linear growth (+1 MSS/RTT)    | Steady ACK stream    | Stable      | Stable              | Low                        |
| **Fast retransmit/recovery** | Halved; cwnd=ssthresh         | Dup ACKs then normal | Brief dip   | Brief spike         | Moderate                   |
| **RTO timeout**              | Reset to 1 MSS (slow start)   | ACK gap then burst   | Severe drop | Spike               | Low                        |
| **Retransmit storm**         | Oscillating; never stabilizes | Dup ACKs dominate    | Near zero   | Very high (seconds) | High (retransmit overhead) |
| **Zero window**              | Paused (rwnd=0)               | Window probes only   | Zero        | Infinite (stall)    | Low (idle)                 |

---

## SECTION 11 — Quick Revision and Memory Tricks

### 10 Key Points — TCP Reliability

1. **Sequence numbers count bytes, not segments.** ACK = next byte expected (cumulative).
2. **3 dup ACKs → fast retransmit.** Retransmit immediately without waiting for RTO timer.
3. **SACK tells sender exactly which ranges arrived.** Only retransmit gaps, not everything after loss.
4. **Karn's algorithm:** Never use retransmitted segment's RTT for SRTT update. Prevents RTT corruption.
5. **RTO = SRTT + 4×RTTVAR.** Doubles on each timeout (exponential backoff). Min=1s on Linux.
6. **Slow start:** cwnd doubles each RTT until ssthresh. Then linear (congestion avoidance).
7. **AIMD:** Additive increase (1 MSS/RTT), multiplicative decrease (halve cwnd on loss). Internet cooperation.
8. **CUBIC** is default Linux congestion control. **BBR** uses bandwidth×RTT model, not loss-based.
9. **ENA:** hypervisor bypass. Need ENA driver in BOTH instance type support AND AMI.
10. **NLB idle timeout = 350s.** Applications must send TCP keepalives every <350s to prevent silent drops.

### 30-Second Explanation (Interview or Presentation)

> "TCP reliability works through sequence numbers and acknowledgments. The sender numbers every byte. The receiver ACKs each in-sequence byte it receives. If something is lost, the receiver keeps sending the same ACK — the 'duplicate ACK' — for the byte it's waiting for. Three duplicate ACKs triggers fast retransmit: the sender retransmits that exact segment without waiting for a timeout. If the sender gets no ACK at all, a timer called the RTO fires after SRTT + 4×RTTVAR and retransmission happens with the window reset. SACK enables the receiver to tell the sender exactly which ranges it already has, so only the actual missing bytes are retransmitted.
>
> On top of all this is congestion control: TCP starts slow (exponential cwnd growth) then grows linearly. On loss, it halves the window. This AIMD pattern keeps the internet from collapsing — all TCP senders cooperatively back off when the network is congested."

### Mnemonics

**SAFE** — The Four TCP Reliability Mechanisms:

- **S** — Sequence numbers (byte-level numbering)
- **A** — Acknowledgments (cumulative ACKs, fast retransmit on 3 duplicates)
- **F** — Forward retransmission: Fast retransmit (3 dup ACKs, no RTO wait)
- **E** — Enhanced SACK (selective recovery, only retransmit the gap)

**KART** — Karn's Algorithm Rule:

- **K** — Karn says:
- **A** — Avoid
- **R** — RTT from
- **T** — re-Transmitted segments

**CUBIC vs BBR in one line:**

- CUBIC = "sees **loss**, backs off" (reactive)
- BBR = "measures **bandwidth×RTT**, probes gently" (model-based)

**NLB SG Rule:**

- ALB → backend SG allows **ALB CIDR** (ALB terminates TCP, backend sees ALB IP)
- NLB → backend SG allows **CLIENT CIDR** (NLB is pass-through, backend sees client IP)
- Memory: "NLB is **Naked** — no clothes (no TCP termination) — backend sees the real IP"

**ENA = Both Sides:**

- Instance type must support ENA **AND** AMI must have ENA driver
- Like needing BOTH the right socket AND the right plug — one side isn't enough

### Quick-Fire Facts for AWS SAA Exam

- ENA provides up to **100 Gbps** on some instance types
- Cluster Placement Group: single AZ, single rack, max throughput, **NOT HA**
- NLB idle timeout: **350 seconds** (TCP), **120 seconds** (UDP)
- ALB idle timeout: **60 seconds** (default, configurable up to 4000s)
- EBS-Optimized: separate network for EBS I/O, **default on current-gen instances**
- SACK negotiated in **SYN options** (like window scaling, MSS, timestamps)
- Minimum TCP buffer for 10 Gbps at 10ms RTT: **BDP = 12.5 MB**
- `net.ipv4.tcp_congestion_control=bbr` enables BBR on Amazon Linux 2023
- RTO minimum in Linux: **1 second** (configurable via `tcp_rto_min`)
- VM Import: custom AMIs need ENA driver installed before import for Enhanced Networking

---

## SECTION 12 — Architect Thinking Exercise

### Scenario: Black Friday Retransmit Storm

**Background:**
You are the lead architect for a large e-commerce platform running on AWS. The platform uses:

- ALB → 20 EC2 application servers (m5.xlarge) in us-east-1
- Application servers connected to Aurora PostgreSQL (Multi-AZ, r5.2xlarge)
- Deployed across 3 AZs: us-east-1a, 1b, 1c
- Application servers use HikariCP connection pool: min=5, max=20, connectionTimeout=30s

On Black Friday at 8:00 AM (before the planned traffic peak at 10:00 AM), the team starts seeing:

```
ERROR: javax.persistence.PersistenceException: Could not open connection
ERROR: HikariPool-1 - Connection is not available, request timed out after 30000ms
WARN:  Retrying transaction... attempt 2/3
WARN:  Retrying transaction... attempt 3/3
ERROR: Transaction failed permanently, order not placed
```

Customer orders are failing. Latency at P99 is 15 seconds. P50 is still 200ms.

**Symptoms collected (5 minutes into incident):**

- ALB request count: 8,000 req/sec (normal for this time; peak hasn't started yet)
- ALB target response time P50: 180ms, P99: 14,000ms
- ALB 5xx error rate: 18% (normally <0.01%)
- EC2 CPU: 35% (not CPU-bound)
- Aurora CPU: 40% (not DB CPU-bound)
- Aurora connection count: 380/max 400 (near limit)
- Aurora IOPS: normal
- CloudWatch metric: `NetworkPacketsIn` on app servers: normal
- CloudWatch metric: TCP retransmit rate (custom metric via CloudWatch agent): **820 retransmits/second** (baseline is ~2/second)

**Stop here. Before reading the solution, think:**

1. What is the root cause?
2. What should you do in the next 5 minutes to stop the bleeding?
3. What is the permanent fix for next Black Friday?

---

_(Solution follows — attempt your own analysis first)_

---

### Solution

**Root Cause Analysis:**

The key clue is: `Aurora connection count: 380/max 400` combined with `HikariCP connection timeout` errors and `820 TCP retransmits/second`.

At 8 AM (pre-peak), only 20 app servers × 20 max connections = 400 connections maximum possible. Aurora is at 380. This means the connection pool is nearly exhausted. But why at pre-peak?

**What happened overnight:**

1. Black Friday hype caused a gradual traffic ramp beginning at 1 AM (international customers)
2. Each app server slowly increased its HikariCP pool from min=5 to max=20
3. By 7 AM: all 400 connections established — 20 connections × 20 servers
4. Some connections established overnight (6+ hours idle) — well beyond NLB idle timeout (350s) AND Aurora's `wait_timeout` (28800s by default in MySQL-compatible Aurora — 8 hours, actually fine here)

**But here's what actually caused it:**

At 7:45 AM, the Aurora cluster automatically patched to a minor version (AWS had a scheduled maintenance window). The Multi-AZ failover took 30 seconds.

During 30-second failover:

- Aurora writer endpoint changed (new primary)
- All 400 existing TCP connections to old primary: **RST** by Aurora
- All 400 HikariCP connections: now invalid (pointing to old primary)
- HikariCP does NOT detect dead connections immediately — it only discovers them when next used

At 8:00 AM: Black Friday traffic arrives:

1. App server grabs connection from pool → sends query
2. TCP write succeeds (kernel buffers it) — socket still looks alive from app perspective
3. Aurora responds with RST (connection was killed during failover)
4. TCP RST received → connection closed
5. HikariCP: `getConnection()` fails → exception
6. Every connection in pool fails at once → pool empties → `connectionTimeout=30s` wait
7. While waiting 30s: more requests arrive → MORE pool exhaustion → queue backs up → 15s P99

The 820 TCP retransmits: dead-connection queries being resent before TCP realizes the connection is dead (RST not yet received — RST doesn't cause retransmit, it causes immediate close, but the data in-flight before RST is what retransmits).

Actually, the retransmit storm is caused by: new connections being opened to Aurora, all hitting slow start simultaneously (cwnd=1) while Aurora is processing the flood of reconnections. 400 simultaneous slow-start reconnections × small cwnd = high retransmit rate.

**5-Minute Immediate Mitigation:**

```bash
# Step 1: Bounce the HikariCP pool — force immediate reconnect
# If app has a health endpoint that reinitializes the pool:
for server in $(aws ec2 describe-instances --filter "tag:Role=app" --query "Reservations[].Instances[].PrivateIpAddress" --output text); do
  curl -X POST http://$server:8080/actuator/health-pool-invalidate
done

# Step 2: If no such endpoint, rolling restart of app servers (fast — 20 servers × ~30s each)
# Use ASG instance refresh with minHealthyPercentage=75

# Step 3: Temporarily reduce connection pool max from 20 to 10 per server
# to give Aurora time to handle reconnects without hitting 400 limit
# (Aurora max_connections defaults at r5.2xlarge are actually ~3000, not 400)
# → Wait: if Aurora max is 3000, how are we at 380/400?
# Check: what is the custom Aurora parameter group setting?

# Actually: ops team had manually set max_connections=400 "to prevent runaway connections"
# This is the real capacity constraint
# Step 3: Modify Aurora parameter group: max_connections = 3000, apply immediately
aws rds modify-db-cluster-parameter-group \
  --db-cluster-parameter-group-name prod-aurora-pg \
  --parameters "ParameterName=max_connections,ParameterValue=3000,ApplyMethod=immediate"
```

**Root Cause Confirmation:**

```sql
-- On Aurora: check connection state
SHOW PROCESSLIST;
-- Expect to see 380+ Sleep connections + new incoming
-- Confirms all connections held, no room for new

-- Check recent failover
SHOW GLOBAL STATUS LIKE 'Com_connect';
SHOW GLOBAL STATUS LIKE 'Aborted_connects';
-- High aborted connects confirms the flood of rejected connections
```

**Permanent Fix for Next Year:**

```java
// 1. Enable HikariCP connection validation on borrow
HikariConfig config = new HikariConfig();
config.setConnectionTestQuery("SELECT 1");          // Test on borrow
config.setKeepaliveTime(60_000);                     // Keepalive every 60s (well under NLB 350s AND maintenance window max)
config.setMaxLifetime(300_000);                      // 5-minute max connection age (forces reconnect before failover window)
config.setValidationTimeout(5_000);                  // Don't wait 30s to detect dead connection — detect in 5s
config.setConnectionTimeout(3_000);                  // Fail fast if Aurora unavailable

// 2. Aurora parameter
// Use read replica endpoint for read-only queries → reduces writer load
// Use Amazon RDS Proxy → handles connection pooling at infrastructure level
//   → Multiplexes thousands of app connections onto dozens of Aurora connections
//   → RDS Proxy survives Aurora failover transparently (reconnects on your behalf)
```

**RDS Proxy Architecture (the correct solution):**

```
20 app servers × 20 HikariCP connections = 400 connections to RDS Proxy
RDS Proxy maintains: 10-20 connections to Aurora (multiplexed)
Aurora failover: RDS Proxy reconnects automatically
App servers: never see the failover (RDS Proxy handles it)
Aurora max_connections: use for actual business logic, not app-server overhead

Additional benefit:
  RDS Proxy: holds connection during Aurora failover
  App server: sends query → RDS Proxy queues it → Aurora comes up → executes query
  Instead of: connection breaks → HikariPool exception → order fails
```

**AWS Services to Enable Before Next Black Friday:**

| Action                                                    | What It Prevents                                                 |
| --------------------------------------------------------- | ---------------------------------------------------------------- |
| Enable **RDS Proxy** for Aurora                           | Transparent failover reconnection; connection pool consolidation |
| Set Aurora `max_connections` to hard limit 3000           | Previous artificial cap at 400                                   |
| Enable **Aurora Zero-Downtime Patching**                  | Minimize failover windows for minor patches                      |
| HikariCP `keepaliveTime=60000`                            | NLB and Aurora idle timeout connection drops                     |
| HikariCP `maxLifetime=300000`                             | Stale connections replaced before they fail under load           |
| Set **maintenance window** to Tuesday 3-4 AM              | No Black Friday surprises from AWS patching                      |
| **CloudWatch Alarm**: `HikariCP active connections > 80%` | Alert before exhaustion, not after                               |
| **Pre-warm** connection pool on deploy                    | Don't let Black Friday be the first time pool reaches max        |

---

## Complete Networking Series Summary

| Topic | Title                   | Key Takeaway                                                                       |
| ----- | ----------------------- | ---------------------------------------------------------------------------------- |
| 01    | What is a Network       | Physical + logical paths for data; packets not circuits                            |
| 02    | LAN vs WAN vs Internet  | Scale determines protocol choice and latency expectations                          |
| 03    | Public IP vs Private IP | NAT hides private networks; public IPs route across internet                       |
| 04    | IPv4 Structure          | 32-bit address; CIDR; subnetting; reserved ranges                                  |
| 05    | Ports and Sockets       | OS multiplexes connections; 4-tuple uniquely identifies each session               |
| 06    | Router vs Switch        | Switch = MAC/Layer2 (same network); Router = IP/Layer3 (cross-network)             |
| 07    | Packet Switching        | Packets routed independently; no dedicated circuit; efficient but variable latency |
| 08    | DNS — What It Is        | Hierarchical distributed database: names to IPs; TTL-based caching                 |
| 09    | DNS Resolution Flow     | Recursive → iterative; resolver caches all hops; SACK at UDP level                 |
| 10    | Domain Name vs IP       | FQDN = SNI + Host header + Cert CN; IP = TCP connect only                          |
| 11    | TCP vs UDP              | TCP = reliable ordered; UDP = fast unordered; QUIC = UDP + per-stream reliability  |
| 12    | TCP 3-Way Handshake     | SYN→SYN-ACK→ACK; ISN randomization; SYN cookies defend floods; TLS adds 1 RTT      |
| 13    | TCP Reliability         | Seq numbers → dup ACKs → fast retransmit; SACK; AIMD; BBR; socket buffers          |

---

**Congratulations — you have completed the Networking Fundamentals series.** You now have the deep foundation needed to reason from first principles in system design interviews, AWS architecture reviews, and on-call incident triage. The next series covers System Design Patterns — building on this networking layer to design distributed systems that are fast, reliable, and cost-effective at scale.
