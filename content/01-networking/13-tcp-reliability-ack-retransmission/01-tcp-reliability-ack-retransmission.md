# TCP Reliability (ACK, Retransmission) — Part 1 of 3

### Topic: How TCP Guarantees Every Byte Arrives, In Order, Exactly Once

**Series:** Networking Fundamentals → System Design → AWS Solutions Architect
**Audience:** 14-Year Experienced Full-Stack Developer → Becoming an Architect
**Sections Covered:** 1, 2, 3, 4

---

## SECTION 1 — Intuition First (ELI12 Version)

### Analogy 1 — Book Delivery by Page

Imagine you're sending a 500-page book to a friend, but you can only send 5 pages at a time via a postal system that sometimes loses packages.

Your strategy:

1. Number every page (1, 2, 3... 500)
2. Send pages 1-5 in envelope labeled "Packet #1"
3. Wait for your friend to reply: "Got packet #1, all pages 1-5 received. Send packet #2."
4. Send pages 6-10 in envelope labeled "Packet #2"
5. If your friend doesn't reply within 30 seconds: you resend packet #1 (maybe it got lost)
6. If your friend received packet #1 AND packet #3 but NOT packet #2: they tell you the exact page they're missing. You resend only page 6-10. They don't need 1-5 again.

This is exactly TCP:

- Page numbers = TCP sequence numbers
- "Got up to page X" reply = acknowledgment (ACK)
- Resending if no ACK = retransmission
- "I got page 1-5 and 11-15 but missing 6-10" = Selective Acknowledgment (SACK)
- Waiting 30 seconds before resending = Retransmission Timeout (RTO)

The overhead is the constant "confirm receipt" replies. But when a page is lost, you never send the whole book again — just the missing pages. This is why TCP is both reliable AND efficient.

### Analogy 2 — Warehouse Receiving Department

A warehouse receives shipments from a supplier. The receiving protocol:

1. Every box has a serial number (sequence number)
2. The receiving desk sends a receipt for every batch: "Received all boxes up to serial 1000"
3. If box #850 arrives damaged (checksum failure): it's discarded, not signed for
4. Supplier notices: "I sent box #850 but haven't received receipt. Timer expired. Resending #850."
5. New staff moves faster: "We can receive 5 boxes at a time" → window opens up
6. When warehouse floor is full (slow processing): "pause shipments, buffer full" → zero window → sender stops

This models TCP's flow control AND reliability together: the window size (how many unacknowledged boxes can be "in transit") adapts to the warehouse's processing speed. The ACKs drive the sending rate.

---

## SECTION 2 — Core Technical Deep Dive

### Sequence Numbers and Acknowledgments

**The byte-stream model:**
TCP treats data as a continuous stream of bytes. Every byte has an offset position in this stream. The sequence number in a TCP segment header indicates the position of the FIRST byte of that segment's data.

```
If sender sends:
  Segment 1: seq=1001, data=500 bytes (bytes 1001–1500)
  Segment 2: seq=1501, data=500 bytes (bytes 1501–2000)
  Segment 3: seq=2001, data=500 bytes (bytes 2001–2500)

Receiver's ACK response:
  ACK=1501 means: "I have all bytes up to 1500; send byte 1501 next"
  ACK=2001 means: "I have all bytes up to 2000; send byte 2001 next"
  ACK=2501 means: "I have all bytes up to 2500; all segments received"
```

**Cumulative ACK:** The acknowledgment number in TCP is the next byte the receiver EXPECTS. It is cumulative (covers all bytes before that point). If segment with seq=1501 is lost:

- Receiver gets segment 1 (seq=1001) → sends ACK=1501
- Receiver gets segment 3 (seq=2001) → can't advance ACK past 1501 (seq=1501 gap)
  → sends ACK=1501 again (duplicate ACK)
- Sender receives ACK=1501 three times → "fast retransmit" trigger

### Retransmission Timeout (RTO) Calculation

RTO is how long the sender waits before concluding a segment was lost and retransmitting it.

**Too short RTO:** unnecessary retransmissions (segment was just delayed, not lost)
**Too long RTO:** excessive wait before recovering lost data → poor throughput

**RFC 6298 — RTO calculation using EWMA (Exponentially Weighted Moving Average):**

```
Variables:
  RTT     = measured round-trip time for a segment
  SRTT    = smoothed RTT estimate (moving average)
  RTTVAR  = RTT variance (measures how variable RTT is)
  RTO     = retransmission timeout

Initialization (first measurement):
  SRTT = RTT_sample
  RTTVAR = RTT_sample / 2
  RTO = SRTT + max(G, 4×RTTVAR)  where G = clock granularity (usually 1ms)

Subsequent measurements:
  RTTVAR = (1 - β) × RTTVAR + β × |SRTT - RTT_sample|  where β = 0.25
  SRTT   = (1 - α) × SRTT + α × RTT_sample              where α = 0.125
  RTO    = SRTT + max(G, 4×RTTVAR)

Minimum RTO: 1 second
Maximum RTO: 60 seconds

Example:
  Baseline: SRTT=20ms, RTTVAR=5ms
  RTO = 20 + max(1, 4×5) = 20 + 20 = 40ms

  If network conditions change: SRTT=50ms, RTTVAR=20ms
  RTO = 50 + 80 = 130ms (adapts to more variable network)
```

**Karn's Algorithm:** When a segment is retransmitted and then ACK'd, you can't tell if the ACK is for the original or the retransmission. If you calculate RTT from a retransmission ACK, you get an incorrect measurement. Karn's algorithm: **don't use retransmitted segments for RTT calculation**. Only measure RTT from non-retransmitted segments.

**Exponential backoff:** After each retransmission timeout:

- RTO doubles (exponential backoff)
- Prevents flooding an already-congested network with retransmissions
- After max retransmissions (default 15 on Linux for data; 6 for SYN): connection reset

### Fast Retransmit (3 Duplicate ACKs)

Waiting for RTO (40ms+) before retransmitting is slow. Fast retransmit detects loss faster:

```
Sender sends: seg1 (seq=1001), seg2 (seq=1501), seg3 (seq=2001), seg4 (seq=2501)

Network drops seg2. Receiver gets seg1, seg3, seg4:
  Receive seg1 → send ACK=1501 ✓
  Receive seg3 → gap detected! Can't advance ACK. Send ACK=1501 again (dup ACK 1)
  Receive seg4 → still gap. Send ACK=1501 again (dup ACK 2)
  [one more dup ACK arrives]

Sender receives:
  ACK=1501 (normal)
  ACK=1501 (dup ACK 1)
  ACK=1501 (dup ACK 2)
  ACK=1501 (dup ACK 3)

After 3 duplicate ACKs → FAST RETRANSMIT: sender immediately retransmits seq=1501

Why 3? One or two dup ACKs might be from reordering (packets taking different paths).
Three means almost certainly loss. The threshold is a balance between false positives
(reordering) and slow loss detection.
```

### Selective Acknowledgment (SACK)

Cumulative ACK has a problem: if seg2 of 10 is lost, even though segs 3-10 arrived:

- Without SACK: sender only knows "receiver has up to seq 1500" → may retransmit segs 2-10 all over again
- With SACK: receiver tells sender exactly which ranges it has

**SACK in TCP headers (negotiated in SYN options):**

```
Receiver receives: seg1, seg3, seg4, seg5 (seg2 lost)

Without SACK:
  ACK = 1501 (only says "have up to 1500")
  Sender doesn't know if 3-5 arrived
  Sender retransmits seg2, seg3, seg4, seg5 (wasteful)

With SACK:
  ACK = 1501
  SACK block 1: left=2001, right=3001 (bytes 2001-3000 received)
  "I have bytes 1001-1500 AND 2001-3000"
  Sender retransmits ONLY seg2 (bytes 1501-2000)
  Much more efficient on high-loss networks
```

SACK is negotiated in the SYN handshake options. If both sides support it (virtually all modern implementations do), it's used automatically.

### Congestion Control: The TCP Self-Throttling Mechanism

Flow control handles receiver buffer capacity. Congestion control handles network capacity. TCP must not overwhelm the network — every sender cooperating prevents global network collapse (the "tragedy of the commons" problem).

**Congestion Window (cwnd):**
A sender-side variable that limits how much unacknowledged data can be in-flight:

```
actual_send_rate = min(receive_window, congestion_window)
```

**Slow Start:**

```
Initial cwnd = 1 MSS (Maximum Segment Size = 1460 bytes typically)

Each ACK received → cwnd += 1 MSS
  After round 1: 1 MSS → sent 1 segment → got 1 ACK → cwnd = 2
  After round 2: 2 MSS → sent 2 segments → got 2 ACKs → cwnd = 4
  After round 3: 4 MSS → got 4 ACKs → cwnd = 8
  → Exponential growth (doubles each RTT)
  → Continues until cwnd reaches ssthresh (slow start threshold)

When cwnd reaches ssthresh → enter Congestion Avoidance:
  Each RTT: cwnd += 1 MSS (linear growth, not exponential)

When loss detected (timeout or 3 dup ACKs):
  ssthresh = cwnd / 2
  cwnd = 1 (or cwnd/2 for fast recovery)
  Restart slow start or congestion avoidance
```

**AIMD (Additive Increase Multiplicative Decrease):**

- Additive increase: increase cwnd by 1 MSS per RTT during congestion avoidance
- Multiplicative decrease: halve cwnd on loss detection
- This produces the sawtooth pattern of TCP throughput over time

Modern alternatives to AIMD:

- **CUBIC (default Linux since 2.6.19):** Uses a cubic function for cwnd growth; better for high-bandwidth, high-latency links
- **BBR (Bottleneck Bandwidth and RTT):** Google's algorithm; doesn't use loss as congestion signal; measures actual throughput and RTT to model the network bottleneck; up to 2700× higher throughput on high-loss satellite links
- **QUIC (HTTP/3):** Also supports BBR and other modern congestion algorithms

---

## SECTION 3 — Architecture Diagram

### Complete TCP Reliability Mechanism

```
╔══════════════════════════════════════════════════════════════════╗
║        TCP RELIABILITY: FULL MECHANISM DIAGRAM                  ║
╚══════════════════════════════════════════════════════════════════╝

SENDER                                      RECEIVER
(cwnd=4 after slow start)

│─── seg1 [seq=1001, 500B] ─────────────────────────────────────►│
│─── seg2 [seq=1501, 500B] ─────────────────────────────────────►│
│─── seg3 [seq=2001, 500B] ──────── LOST (network drop) ─── ✗   │
│─── seg4 [seq=2501, 500B] ─────────────────────────────────────►│

│◄─── ACK=1501 (normal) ──────────────────────────────────────────│ (got seg1)
│◄─── ACK=2001 (normal) ──────────────────────────────────────────│ (got seg2)
│◄─── ACK=2001 (dup ACK 1) ───────────────────────────────────────│ (got seg4, gap at 2001)
                                     With SACK: {2501-3000 received}
│
│ [3 dup ACKs → FAST RETRANSMIT]
│
│─── seg3 [seq=2001, 500B] RETRANSMIT ─────────────────────────►│
│◄─── ACK=3001 ──────────────────────────────────────────────────│ (gap filled, all received)

RETRANSMISSION TIMEOUT (RTO) SCENARIO:

│─── seg5 [seq=3001, 500B] ──────── LOST ─── ✗                  │
│                                                                 │
│ [RTO timer expires (~40ms)]                                     │
│ [ssthresh = cwnd/2 = 2, cwnd reset to 1]                       │
│─── seg5 [seq=3001, 500B] RETRANSMIT ─────────────────────────►│
│◄─── ACK=3501 ──────────────────────────────────────────────────│
│ [Slow start restarts from cwnd=1]

CONGESTION WINDOW EVOLUTION (AIMD / Slow Start):

cwnd
  16│         *
  15│       * * *
  14│     *       *
  12│   *           *         *
   8│ *               *     *
   4│                   * *
   2│                        *
   1│start            loss →  slow start restart
     ─────────────────────────────────────────► RTT

     ↑              ↑
  slow start  congestion avoidance
  (exponential)  (linear growth)


SACK BLOCKS VISUALIZATION:

Receiver buffer state (missing seg at 1501-2000):
  ┌──────────┬────────┬──────────────────────────────┐
  │ 1001-1500│ [GAP]  │ 2001-2500 │ 2501-3000        │
  │ received │missing │ received  │ received          │
  └──────────┴────────┴──────────────────────────────┘
  ACK = 1501 (cumulative: only up to 1500 confirmed)
  SACK block 1: 2001-3000 (receiver tells sender this range arrived)

  Sender knows: retransmit ONLY 1501-2000. All else safe.
```

---

## SECTION 4 — Request Flow — Step by Step

### Scenario: Large File Download (1 MB) with Loss Recovery

```
╔══════════════════════════════════════════════════════════════════╗
║     1 MB FILE DOWNLOAD: TCP RELIABILITY IN ACTION               ║
╚══════════════════════════════════════════════════════════════════╝

Setup:
  MSS = 1460 bytes
  1 MB file = 1,048,576 bytes
  Total segments: 1,048,576 / 1460 = ~718 segments
  RTT = 20ms
  Packet loss rate: 0.1% (typical internet)

SLOW START PHASE:
  RTT 1: cwnd=1  → send 1 seg  → 1 ACK  → cwnd=2
  RTT 2: cwnd=2  → send 2 segs → 2 ACKs → cwnd=4
  RTT 3: cwnd=4  → send 4 segs → 4 ACKs → cwnd=8
  RTT 4: cwnd=8  → send 8 segs           → cwnd=16
  RTT 5: cwnd=16 → send 16 segs          → cwnd=32  [reaches ssthresh]

  After 5 RTTs (100ms): cwnd=32, throughput = 32×1460 bytes/RTT
  Bandwidth at this point: 32×1460×8 / 0.02 = ~18.7 Mbps

CONGESTION AVOIDANCE PHASE (cwnd linear growth):
  Each RTT: cwnd += 1
  RTT 6: cwnd=33
  RTT 7: cwnd=34
  ... (continuing)

  Without loss: cwnd grows until receive window (65535 bytes) is the limit
  Window limited: 65535 / 1460 = 44 segments per window
  Max throughput without scaling: 44×1460 bytes/RTT = 64,240 bytes/20ms = ~25 Mbps

WITH WINDOW SCALING OPTION (negotiated in handshake):
  Window = 65535 × 2^7 = 8,388,480 bytes (scale factor 7)
  Max cwnd limited by: min(receive_window, cwnd)
  For 1GB link at 20ms RTT: bandwidth-delay product = 1Gbps × 0.02s = 25 MB
  → Need rwnd=25MB for full pipe utilization
  → Window scaling essential for high-bandwidth links

LOSS EVENT AT SEGMENT 100 (seq = 147,000):
  Step 1: Segs 99, 101, 102 arrive. Seg 100 missing.
          Receiver sends ACK=147000 (dup ACK 1)
          Receiver sends ACK=147000 (dup ACK 2) for each out-of-order seg
          SACK block: {149920-152840} (segs 101-102 received)

  Step 2: Sender receives 3 dup ACKs
          → FAST RETRANSMIT: retransmit seg 100 immediately (no RTO wait)
          → cwnd = cwnd/2 (AIMD multiplicative decrease)
          → ssthresh = new cwnd
          → Enter FAST RECOVERY (continue sending new data, don't reset cwnd to 1)

  Step 3: Retransmitted seg 100 arrives at receiver
          → Receiver now has continuous run from start through 102
          → Sends ACK=149920 (covering all three segments 100, 101, 102)
          → Fast recovery exits, enter linear congestion avoidance

TOTAL DOWNLOAD TIME ESTIMATE:
  718 segments × 1460 bytes = 1,048,280 bytes
  At steadystate cwnd=44 (rwnd limited), RTT=20ms:
  718 segments / 44 per window = ~17 windows
  17 windows × 20ms RTT = 340ms + slow start overhead (~100ms) = ~440ms total

  Plus 1 loss event (fast retransmit → 1 RTT): +20ms
  Total: ~460ms for 1MB download at 25 Mbps with 20ms RTT

╔══════════════════════════════════════════════════════════════════╗
║  Without TCP reliability: would need application-level          ║
║  checksums, sequence numbers, retransmission — every app        ║
║  reinventing TCP's wheel. TCP does it once, correctly, for all. ║
╚══════════════════════════════════════════════════════════════════╝
```

### Why Packet Loss Does Not Corrupt Data (Even at 0% SACK)

At the application layer, no matter what happens in the network:

- Bytes delivered to `read()` are always in order
- No gaps — if byte 1001–1500 arrives before 501–1000, the application never sees it that way
- The TCP stack buffers out-of-order data and only delivers it after filling all gaps

This is the contract TCP provides to applications. HTTP, database protocols, SSH all rely on this. Without it, every protocol would need its own ordering and error recovery — the internet's protocol complexity would be unmanageable.

---

## File Summary

This file covered:

- Sequence numbers: every byte numbered; ACK = next byte expected (cumulative)
- Duplicate ACKs: out-of-order arrival causes receiver to repeat last ACK; 3 dup ACKs triggers fast retransmit
- RTO calculation: SRTT + 4×RTTVAR (RFC 6298); adapts to network conditions, doubles on each timeout
- Karn's algorithm: never use retransmitted segment timing for RTT calculation
- Fast retransmit: retransmit on 3 dup ACKs without waiting for RTO → much faster loss recovery
- SACK: receiver reports non-contiguous received ranges; sender retransmits only missing segments
- Congestion control: slow start (exponential cwnd growth) → ssthresh → congestion avoidance (linear)
- AIMD: additive increase / multiplicative decrease — the cooperative self-throttling algorithm
- CUBIC (modern Linux default) and BBR (Google, latency-based, not loss-based)
- 1MB download simulation: slow start → avoidance → loss → fast retransmit → recovery

**Continue to File 02** for real-world examples (QUIC selective reliability, TCP over satellite links, congestion collapse events), system design considerations, AWS Enhanced Networking (ENA, SR-IOV), and interview Q&As.
