# Packet & Packet Switching — Part 1 of 3

### Topic: What a Packet Is, How It Moves, and Why the Internet Uses Packet Switching

**Series:** Networking Fundamentals → System Design → AWS Solutions Architect
**Audience:** 14-Year Experienced Full-Stack Developer → Becoming an Architect
**Sections Covered:** 1, 2, 3, 4

---

## SECTION 1 — Intuition First (ELI12 Version)

### The Jigsaw Puzzle Postal Analogy

Imagine you want to send a 1,000-piece jigsaw puzzle to a friend across the country. The puzzle is too big and fragile to send in one box — it could get lost, dropped, or stuck in customs. Instead, a smart shipping company says: "Break the puzzle into 10 bags of 100 pieces each. Put them in 10 separate envelopes. Each envelope gets a label: 'From: Alice, To: Bob, Envelope 3 of 10, pieces 201–300.' Ship each envelope independently."

Each envelope can take different routes — envelope 1 goes via FedEx through Dallas, envelope 2 goes via UPS through Chicago, envelope 7 takes a scenic route through Phoenix. They might arrive out of order. But Bob has instructions: "When all 10 envelopes arrive, sort them by number and reassemble the puzzle."

This is **packet switching**. Your data file (video, webpage, email) is broken into **packets** — small, independently routable chunks. Each packet has a label (header) with addressing information. Each packet travels independently through the internet, potentially via different routes. At the destination, the OS reassembles them in order.

The alternative — **circuit switching** — is like hiring a dedicated private road from Alice's house to Bob's house. It's reserved exclusively for them, ready before they send anything, and stays up until they're done. Nobody else can use that road while Alice and Bob have it reserved. This is wasteful — most of the time, Alice isn't even talking.

The phone system was circuit-switched. The internet is packet-switched. The internet won because packet switching is massively more efficient with shared infrastructure.

### Why "Packet" and Not "Message"?

A message could be any size — 1 byte or 1 gigabyte. Routing systems need predictable, bounded units to process fairly and efficiently. Packets:

- Have a **maximum size (MTU: Maximum Transmission Unit)** — typically 1,500 bytes on Ethernet
- Allow interleaving of multiple conversations: Alice's video and Bob's email share the same physical cable by taking turns at the packet level — not at the conversation level
- Enable error recovery per packet rather than retransmitting the entire file
- Allow routers to process uniformly-sized units instead of variable-length messages

---

## SECTION 2 — Core Technical Deep Dive

### Anatomy of a Packet

A packet is structured in layers, reflecting the OSI model. Each layer adds its own header (and sometimes trailer) around the payload from the layer above:

```
┌─────────────────────────────────────────────────────────────────┐
│                    ETHERNET FRAME (L2)                          │
│  ┌────────────┬───────────────────────────────────────────────┐ │
│  │ Ethernet   │              IP PACKET (L3)                   │ │
│  │ Header     │  ┌─────────────────────────────────────────┐  │ │
│  │            │  │  IP Header  │     TCP SEGMENT (L4)      │  │ │
│  │            │  │             │  ┌───────────┬──────────┐  │  │ │
│  │            │  │             │  │TCP Header │ PAYLOAD  │  │  │ │
│  │            │  │             │  │           │ (HTTP,   │  │  │ │
│  │            │  │             │  │           │  data)   │  │  │ │
│  │            │  │             │  └───────────┴──────────┘  │  │ │
│  │            │  └─────────────────────────────────────────┘  │ │
│  └────────────┴───────────────────────────────────────────────┘ │
│  FCS (Frame Check Sequence — L2 error detection)                │
└─────────────────────────────────────────────────────────────────┘
```

This is called **encapsulation** — each layer wraps the layer above. On receipt, each layer strips its own header and passes the payload up (**decapsulation**).

---

### Ethernet Frame Structure (Layer 2)

| Field                       | Size           | Purpose                                                     |
| --------------------------- | -------------- | ----------------------------------------------------------- |
| Preamble                    | 7 bytes        | Synchronization — "a frame is coming"                       |
| SFD (Start Frame Delimiter) | 1 byte         | Marks start of frame                                        |
| Destination MAC             | 6 bytes        | Recipient's hardware address                                |
| Source MAC                  | 6 bytes        | Sender's hardware address                                   |
| EtherType                   | 2 bytes        | Protocol inside: 0x0800 = IPv4, 0x0806 = ARP, 0x86DD = IPv6 |
| Payload                     | 46–1,500 bytes | The IP packet being carried                                 |
| FCS                         | 4 bytes        | CRC error detection (receiver recalculates and compares)    |

**Total Ethernet frame overhead:** ~18 bytes for headers + 4 bytes FCS = ~22 bytes overhead per frame.

**MTU (Maximum Transmission Unit):** 1,500 bytes is the standard Ethernet payload limit. This isn't arbitrary — it balances efficiency (larger = fewer frames per message) vs latency/error handling (smaller = individual frame errors are cheaper to retransmit). **Jumbo frames** (up to 9,000 bytes) are used within data centers where network quality is controlled and larger payloads increase throughput.

---

### IPv4 Packet Structure (Layer 3)

| Field               | Size     | Purpose                                                                         |
| ------------------- | -------- | ------------------------------------------------------------------------------- |
| Version             | 4 bits   | IPv4 = 4, IPv6 = 6                                                              |
| IHL (Header Length) | 4 bits   | Header size in 32-bit words (minimum 5 = 20 bytes)                              |
| DSCP (Formerly ToS) | 8 bits   | QoS marking — priority for traffic shaping                                      |
| Total Length        | 16 bits  | Total packet size including header (max 65,535 bytes)                           |
| Identification      | 16 bits  | Unique ID for packet fragments belonging to same datagram                       |
| Flags               | 3 bits   | DF (Don't Fragment), MF (More Fragments)                                        |
| Fragment Offset     | 13 bits  | Position of this fragment in the original datagram                              |
| TTL (Time To Live)  | 8 bits   | Decremented at each router hop; packet discarded at 0 (prevents infinite loops) |
| Protocol            | 8 bits   | Layer 4 protocol: 6=TCP, 17=UDP, 1=ICMP                                         |
| Header Checksum     | 16 bits  | Error detection for IP header only                                              |
| Source IP           | 32 bits  | Sender's IP address                                                             |
| Destination IP      | 32 bits  | Recipient's IP address                                                          |
| Options             | Variable | Rarely used; security/routing options                                           |
| Payload             | Variable | TCP/UDP segment or other L4 data                                                |

**Minimum IP header size:** 20 bytes. Maximum (with options): 60 bytes.

**TTL — why it matters:**
Every router decrements TTL by 1. If TTL reaches 0, the router discards the packet and sends an ICMP "Time Exceeded" message back to the source. This prevents routing loops from circulating packets forever. Default TTL values:

- Windows: 128
- Linux/macOS: 64
- Network equipment: 255

`traceroute`/`tracert` exploits TTL: it sends packets with TTL=1 (first router discards it, responds), TTL=2 (second router discards), and so on — mapping each hop to the destination.

---

### TCP Segment Structure (Layer 4)

| Field                 | Size     | Purpose                                                     |
| --------------------- | -------- | ----------------------------------------------------------- |
| Source Port           | 16 bits  | Originating application port                                |
| Destination Port      | 16 bits  | Target application port                                     |
| Sequence Number       | 32 bits  | Position of first byte in this segment (enables reordering) |
| Acknowledgment Number | 32 bits  | Next expected byte from the other side                      |
| Data Offset           | 4 bits   | Header size in 32-bit words                                 |
| Flags                 | 9 bits   | SYN, ACK, FIN, RST, PSH, URG (connection management)        |
| Window Size           | 16 bits  | Flow control — how many bytes receiver can accept           |
| Checksum              | 16 bits  | Error detection for header + data                           |
| Urgent Pointer        | 16 bits  | Used if URG flag set                                        |
| Options               | Variable | MSS, timestamps, window scaling, SACK                       |
| Payload               | Variable | Application data (HTTP, JSON, binary)                       |

**Sequence and Acknowledgment Numbers:**
These are what enable TCP reliability:

```
Sender: "Here is data starting at byte 1000, length 500 bytes"
  → Sequence Number: 1000
Receiver: "Got it. I expect next byte 1500"
  → ACK Number: 1500
Sender: "Here is data starting at byte 1500, length 500 bytes"
  → Sequence Number: 1500
```

If segment 1500-2000 is lost (network drops it), the receiver sends ACK 1500 again ("still waiting for 1500"). The sender retransmits. This is TCP's reliability mechanism.

---

### IP Fragmentation and MTU Discovery

When an IP packet (say 4,000 bytes) needs to cross a link with MTU of 1,500 bytes, it must be fragmented:

- Original packet: 4,000 bytes payload + 20-byte header
- Fragment 1: bytes 0–1479 of payload (1,500 bytes total)
- Fragment 2: bytes 1480–2959 of payload
- Fragment 3: bytes 2960–3999 of payload

All fragments carry the same Identification field (so the destination can group them). The MF (More Fragments) flag is 1 on all fragments except the last. Fragment Offset indicates where each fragment's data belongs.

**Fragmentation is undesirable in modern networks:**

- Routers must buffer incomplete datagrams
- If one fragment is lost, entire datagram must be retransmitted
- Processing overhead at each fragmenting router

**PMTUD (Path MTU Discovery):** TCP and applications use PMTUD to discover the minimum MTU along the entire path. They set the DF (Don't Fragment) bit on packets. If a router can't forward the packet due to MTU, it sends back ICMP "Fragmentation Needed" with the link's MTU. The sender reduces its packet size accordingly.

**In AWS:** All instances support standard 1,500-byte MTU. For high-throughput workloads within a VPC, Jumbo Frames (9,001 bytes) are supported on most instance types and Elastic Network Interfaces — reducing header overhead percentage and improving throughput.

---

## SECTION 3 — Architecture Diagram

### Full Packet Journey: Browser to Web Server (All OSI Layers)

```
USER'S BROWSER (Chrome on 192.168.1.10)
Wants to load: https://api.example.com/users

Layer 7 (Application): HTTP GET /users
Layer 6 (Presentation): TLS encryption applied
Layer 5 (Session): TLS session established
Layer 4 (Transport): TCP Segment
  [Src: 54321 | Dst: 443 | Seq: 1 | ACK: 0 | SYN]
Layer 3 (Network): IP Packet
  [Src: 192.168.1.10 | Dst: 93.184.216.34 | TTL: 64 | Proto: TCP]
Layer 2 (Data Link): Ethernet Frame
  [Src: AA:BB:CC | Dst: 11:22:33 (router MAC) | EtherType: 0x0800]
Layer 1 (Physical): Electrical signals on cable / WiFi radio waves

──────────── travels to HOME ROUTER ────────────

HOME ROUTER (192.168.1.1 / 203.103.44.5 public)
Layer 3: Reads IP dst 93.184.216.34 → routes to ISP (default route)
Layer 3: NAT: rewrites Src IP to public IP (203.103.44.5:38001)
Layer 2: Strips old Ethernet frame, builds new one to ISP router MAC
         [Src: router-WAN-MAC | Dst: ISP-router-MAC]
Layer 1: Packet travels fiber line to ISP

──────────── hops through 3–8 INTERNET ROUTERS ────────────

Each intermediate router:
  Layer 3: Reads Dst IP 93.184.216.34 → longest prefix match → next hop
  Layer 2: Decapsulate, build new Ethernet frame to next-hop MAC
  Layer 1: Transmit
  (TTL decremented at each hop: 64 → 63 → 62 → ... → 56)

──────────── arrives at AWS EDGE ROUTER ────────────

AWS EDGE ROUTER
Layer 3: 93.184.216.34 → routes to ALB endpoint (10.0.1.5 internal)
Layer 2: Encapsulate in new frame to ALB ENI MAC

──────────── arrives at AWS ALB (Application Load Balancer) ────────────

ALB (Layer 7 Load Balancer)
Layer 7: Reads HTTP headers: "GET /users, Host: api.example.com"
  → Route to target group EC2 instances by path/host
Layer 4: Terminates client TCP connection, establishes new connection to backend
Layer 3: Src IP = ALB IP, Dst = EC2 private IP (10.0.2.50)
Layer 2: New frame to EC2 ENI MAC

──────────── arrives at EC2 INSTANCE (10.0.2.50) ────────────

EC2 Instance
Layer 2: ENI receives Ethernet frame, strips MAC header
Layer 3: IP stack receives packet, strips IP header
Layer 4: TCP stack receives segment, strips TCP header, passes to app
Layer 7: Application (Node.js) receives: "GET /users HTTP/1.1"
         → Queries database → Returns JSON → Layer 7 HTTP 200 OK response
```

**Key observations from this diagram:**

- Ethernet frame (L2) is rebuilt at every router hop
- IP packet (L3) source/destination remain unchanged end-to-end until NAT
- TCP segment (L4) ports remain unchanged until ALB terminates the connection
- Each layer adds/removes headers as data moves up/down the stack
- The ALB terminates L4+L7 — it creates two separate TCP connections (client ↔ ALB, ALB ↔ EC2)

---

## SECTION 4 — Request Flow — How One HTTP Request Becomes Many Packets

### Scenario: Browser sends 1 KB HTTP request, server returns 2 MB response

**Step 1 — Fragmentation at the Application → Network boundary**

2 MB response = 2,097,152 bytes. With 1,500-byte MTU:

- IP payload = 1,480 bytes (1,500 MTU - 20 IP header = 1,480 IP payload)
- TCP header = 20 bytes (minimum) → TCP payload = 1,460 bytes
- Number of segments: 2,097,152 / 1,460 = ~1,436 TCP segments = 1,436 packets

```
Step 1: App writes 2MB into TCP send buffer
Step 2: TCP segments the data → 1,436 segments of ~1,460 bytes each
Step 3: Each segment gets a TCP header (src port, dst port, sequence number)
Step 4: Each segment wrapped in IP packet (src/dst IP, TTL)
Step 5: Each IP packet wrapped in Ethernet frame (src/dst MAC)
Step 6: 1,436 frames transmitted on the wire
```

**Step 2 — In-Flight: Sliding Window and Acknowledgment**

TCP doesn't wait for each packet to be ACK'd before sending the next. It uses a **sliding window**: send up to window-size bytes without waiting for ACK:

```
Initial Window Size: 65,535 bytes
Sender sends: packets 1–45 (65,535 / 1,460 = 44.8 ≈ 45 packets)
ACK received for packets 1–10 → window slides → send packets 46–55
(Continuous pipeline — never waiting idle)

If packet 23 is dropped:
  Receiver: ACKs everything up to 22, then duplicate ACKs for 22
  Sender: receives 3 duplicate ACKs → fast retransmit packet 23
  Window temporarily reduced (TCP congestion control)
```

**Step 3 — Reordering at Destination**

Packets can arrive out of order (different routing paths, variable queuing at routers). TCP's receiver buffer handles this:

- Maintain buffer of received segments
- Sequence numbers identify correct order
- Deliver to application only when contiguous data received

```
Received order:  1, 2, 4, 5, 3, 6  (packet 3 arrived late)
Sequence buffer: [1][2][_][4][5][3]
When 3 arrives:  buffer now 1..6 contiguous → deliver to app
ACK sent for 6+1=7 (next expected)
```

**Step 4 — Packet Drop and Recovery Summary**

| Event                       | Detection                    | Recovery                                                  |
| --------------------------- | ---------------------------- | --------------------------------------------------------- |
| Packet drop (congestion)    | 3 duplicate ACKs or timeout  | Fast retransmit (3 dup ACKs) or full retransmit (timeout) |
| Corrupted packet (FCS fail) | Ethernet FCS mismatch        | Frame silently dropped → TCP timeout and retransmit       |
| Out-of-order arrival        | Sequence number gap          | Buffered; ACK holds at last contiguous byte               |
| Duplicate packet            | Sequence number already seen | Simply discarded by TCP                                   |

---

## File Summary

This file established the foundational understanding of packets:

- Packet switching: jigsaw puzzle analogy — break data into independent chunks, route separately, reassemble at destination
- Why packets: bounded size enables fair multiplexing; efficient error recovery; shared infrastructure
- Ethernet frame anatomy: MAC addresses, EtherType, FCS
- IPv4 packet anatomy: TTL preventing loops, fragmentation flags, source/destination IP
- TCP segment anatomy: sequence/ACK numbers enabling reliability and reordering
- MTU and fragmentation: why 1,500 bytes; jumbo frames in data centers; PMTUD
- Full OSI-layer packet journey from browser to AWS web server
- How 2 MB response becomes 1,436 TCP segments; sliding window; in-flight reliability

**Continue to File 02** for real-world examples, circuit switching vs packet switching analysis, AWS packet-level behavior, and interview preparation.
