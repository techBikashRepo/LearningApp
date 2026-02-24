# TCP vs UDP — Part 1 of 3

### Topic: Connection-Oriented vs Connectionless — The Fundamental Transport Layer Trade-off

**Series:** Networking Fundamentals → System Design → AWS Solutions Architect
**Audience:** 14-Year Experienced Full-Stack Developer → Becoming an Architect
**Sections Covered:** 1, 2, 3, 4

---

## SECTION 1 — Intuition First (ELI12 Version)

### Analogy 1 — Certified Mail vs Flyers in a Mailbox

You need to send 100 pages of an important contract to your lawyer.

**Certified Mail (TCP):**

1. You take the pages to the post office
2. Post office registers the package, gives you a tracking number
3. Lawyer must sign for delivery
4. If the lawyer doesn't receive page 47, the post office notices (tracking) and resends page 47
5. Pages arrive in the correct order (1, 2, 3... 100)
6. You're guaranteed: every page arrives, in order, and the lawyer confirms receipt

Cost: more time, more overhead (the signing, the registration, the confirmation)

**Flyers in Mailbox (UDP):**

1. You print 100 individual flyers (event announcements)
2. You stuff mailboxes in your neighborhood — no names, no tracking
3. Some mailboxes are full → flyer gets lost. Wind blows some away. Some arrive crumpled.
4. You don't know which ones arrived. You don't check.
5. No confirmation, no retry, no ordering guarantee

Cost: almost zero overhead — just stuffing and dropping

**When do you want UDP?** When you're broadcasting "tonight's concert is at 7pm." If 80 of 100 people get the flyer, close enough. The concert happens whether or not every person knew. Trying to track 100 certified deliveries for an event announcement is insane overhead.

**When do you want TCP?** When you're sending a contract where every clause matters and the wrong order changes meaning entirely.

DNS announcement: UDP. Bank transaction: TCP. Live video stream: UDP (you'd rather have a slightly blurry frame than a 3-second freeze while TCP retransmits). File download: TCP (you need every byte, in order).

### Analogy 2 — Phone Call vs Radio Broadcast

**TCP = Phone Call:**

- You dial, they answer (connection established — 3-way handshake)
- Both parties know each other throughout (stateful)
- If one person misses something: "Sorry, could you repeat that?" (retransmission)
- There's a clear start and end (connection teardown)

**UDP = Radio Broadcast:**

- Station just broadcasts — doesn't know who's listening
- Listeners tune in whenever (no connection state)
- If the signal breaks for 3 seconds, those 3 seconds are just gone
- The station doesn't retry the words that were static — it just keeps broadcasting
- Thousands of listeners receive the same broadcast simultaneously (multicast/broadcast capability)

The radio station doesn't care if 1 person or 1 million people are listening — same transmission overhead. A phone call would require individual connections to each person — impossibly expensive to call 1 million people simultaneously.

---

## SECTION 2 — Core Technical Deep Dive

### TCP — Transmission Control Protocol

TCP is a **connection-oriented, reliable, ordered, error-checked** transport protocol (Layer 4 of OSI / Transport layer of TCP/IP).

**Core guarantees TCP provides:**

1. **Reliable delivery:** every segment that the sender sends is acknowledged by the receiver. Unacknowledged segments are retransmitted.
2. **Ordered delivery:** data arrives in the exact order it was sent. TCP assigns sequence numbers to bytes; the receiver buffers out-of-order segments and delivers them in order.
3. **Error detection:** every TCP segment has a checksum. Corrupted segments are discarded and retransmitted.
4. **Flow control:** receiver advertises a "receive window" — how many bytes it can accept. Sender never overwhelms the receiver.
5. **Congestion control:** sender detects network congestion (packet loss / RTT increase) and reduces sending rate. Prevents network collapse.
6. **Full-duplex:** simultaneous bidirectional communication on a single connection.

**How TCP achieves this (mechanically):**

- Connection state: both endpoints maintain state (current sequence numbers, window sizes, connection status)
- Sequence numbers: every byte of data is assigned a position; enables ordering and gap detection
- Acknowledgment numbers: receiver confirms receipt of all bytes up to a given position
- Retransmission timeout (RTO): sender waits; if ACK not received, retransmits

### UDP — User Datagram Protocol

UDP is a **connectionless, unreliable, unordered** transport protocol that provides only the minimum service: getting a datagram from one port to another.

**What UDP provides:**

1. **Port multiplexing:** like TCP, UDP uses source/destination ports so multiple applications can use the network on one machine
2. **Checksum (optional):** basic error detection; receiver can discard corrupted datagrams
3. **Length field:** datagram knows its own size
4. **No state:** every UDP datagram is independent — no connection to establish or tear down

**What UDP deliberately omits (to gain performance):**

- No handshake (no connection setup latency)
- No acknowledgment (no waiting for confirmations)
- No sequence numbers (no ordering)
- No retransmission (lost = gone)
- No flow control (sender can flood receiver)
- No congestion control (sender doesn't back off) — **this can be dangerous on network congestion**

### Header Size Comparison

```
TCP Header (20 bytes minimum, up to 60 bytes with options):
┌─────────────────────────────────────────────────────────┐
│ Source Port (16)      │ Destination Port (16)           │
├─────────────────────────────────────────────────────────┤
│ Sequence Number (32)                                    │
├─────────────────────────────────────────────────────────┤
│ Acknowledgment Number (32)                              │
├─────────────────────────────────────────────────────────┤
│ Data  │ Reserved │ Control Flags (9)  │ Window Size(16) │
│ Offset│          │ URG ACK PSH RST SYN FIN              │
├─────────────────────────────────────────────────────────┤
│ Checksum (16)        │ Urgent Pointer (16)              │
├─────────────────────────────────────────────────────────┤
│ Options (0–40 bytes) ...                                │
└─────────────────────────────────────────────────────────┘
Total: 20 bytes + optional extensions

UDP Header (8 bytes — always fixed):
┌─────────────────────────────────────────────────────────┐
│ Source Port (16)      │ Destination Port (16)           │
├─────────────────────────────────────────────────────────┤
│ Length (16)          │ Checksum (16)                    │
└─────────────────────────────────────────────────────────┘
Total: 8 bytes. Always.
```

TCP header overhead is 2.5× UDP header overhead. For small messages (DNS queries: ~32 bytes), this matters. For large data transfers (1 MB file), 20 vs 8 bytes is negligible.

### TCP Control Flags

The 9-bit control flags field in TCP headers is critical for understanding connection lifecycle:

| Flag | Name                      | Purpose                                                  |
| ---- | ------------------------- | -------------------------------------------------------- |
| SYN  | Synchronize               | Initiates a connection; contains initial sequence number |
| ACK  | Acknowledge               | Confirms receipt of data or SYN/FIN                      |
| FIN  | Finish                    | Initiates graceful connection teardown                   |
| RST  | Reset                     | Abrupt connection termination (error condition)          |
| PSH  | Push                      | Tell receiver to pass data to application immediately    |
| URG  | Urgent                    | Urgent data pointer is valid                             |
| ECE  | ECN-Echo                  | Congestion notification (used with ECN)                  |
| CWR  | Congestion Window Reduced | Acknowledges ECN notification                            |
| NS   | Nonce Sum                 | ECN-related                                              |

In practice: SYN, ACK, FIN, RST are by far the most important for architecture discussions.

### TCP State Machine

TCP maintains a well-defined state machine on both client and server sides:

```
CLIENT STATE TRANSITIONS:

CLOSED
  │ app calls connect() → send SYN
  ▼
SYN_SENT
  │ receive SYN-ACK → send ACK
  ▼
ESTABLISHED  ←←←←← (data flows here) →→→→→
  │ app calls close() → send FIN
  ▼
FIN_WAIT_1
  │ receive ACK of FIN
  ▼
FIN_WAIT_2
  │ receive FIN from server → send ACK
  ▼
TIME_WAIT  (waits 2×MSL before fully closing — typically 60–120 seconds)
  │ timeout expires
  ▼
CLOSED

SERVER STATE TRANSITIONS:

CLOSED
  │ app calls listen()
  ▼
LISTEN
  │ receive SYN → send SYN-ACK
  ▼
SYN_RECEIVED
  │ receive ACK
  ▼
ESTABLISHED
  │ receive FIN from client → send ACK
  ▼
CLOSE_WAIT    (app hasn't called close() yet)
  │ app calls close() → send FIN
  ▼
LAST_ACK
  │ receive ACK
  ▼
CLOSED
```

**TIME_WAIT explained:** After the client sends the final ACK in the 4-way close, it must wait 2×MSL (Maximum Segment Lifetime, typically 60s) before declaring the port closed. Why?

- The final ACK may be lost → server resends FIN → client in TIME_WAIT can handle it
- Prevents old "ghost" packets from a previous connection with same ports from being misinterpreted as new connection data

**High-traffic servers** can exhaust local ports due to TIME_WAIT accumulation. Linux `net.ipv4.tcp_tw_reuse` allows reusing TIME_WAIT sockets for new connections (safe in most cases).

### When to Use TCP vs UDP

| Use TCP When                                              | Use UDP When                                             |
| --------------------------------------------------------- | -------------------------------------------------------- |
| Every byte must arrive (file transfers, database queries) | Some loss is acceptable (video streaming, audio)         |
| Order matters (command sequences, session state)          | Order irrelevant or application handles it               |
| Two endpoints (unicast)                                   | Broadcast or multicast required                          |
| Connection-level security (TLS runs over TCP)             | Minimal latency is critical (gaming, real-time control)  |
| Long-lived persistent connections                         | Short, frequent small messages (DNS queries)             |
| Error recovery needed                                     | Retransmission would make data stale (live stock prices) |

---

## SECTION 3 — Architecture Diagram

### Protocol Comparison: Side by Side

```
TCP CONNECTION LIFECYCLE:

Client              Network              Server
  │                                         │
  │─── SYN ────────────────────────────────►│  │
  │◄── SYN+ACK ─────────────────────────────│  │ Connection
  │─── ACK ────────────────────────────────►│  │ Setup
  │                                         │  │ (3-way handshake)
  │─── DATA [seq=1000, 500 bytes] ─────────►│
  │◄── ACK [ack=1500] ──────────────────────│
  │─── DATA [seq=1500, 500 bytes] ─────────►│
  │   (packet lost in network)              │
  │   (retransmission timeout)
  │─── DATA [seq=1500, 500 bytes] ─────────►│  (retransmitted)
  │◄── ACK [ack=2000] ──────────────────────│
  │─── FIN ────────────────────────────────►│  │
  │◄── ACK ─────────────────────────────────│  │ Connection
  │◄── FIN ─────────────────────────────────│  │ Teardown
  │─── ACK ────────────────────────────────►│  │ (4-way)
  │ [TIME_WAIT 60s]                         │
  │                                         │


UDP — NO CONNECTION:

Client              Network              Server
  │                                         │
  │─── datagram [query 1] ─────────────────►│
  │◄── datagram [response 1] ───────────────│
  │─── datagram [query 2] ─────────────────►│
  │    (lost in network)                    │
  │    (nothing happens — no retry)         │
  │─── datagram [query 3] ─────────────────►│
  │◄── datagram [response 3] ───────────────│
  │
  No setup. No teardown. Each datagram independent.


FLOW CONTROL WITH RECEIVE WINDOW:

Sender                                  Receiver
  │                                         │
  │  Window = 3 segments allowed            │ recv buffer
  │─── seg 1 ──────────────────────────────►│ [seg1      ]
  │─── seg 2 ──────────────────────────────►│ [seg1,seg2 ]
  │─── seg 3 ──────────────────────────────►│ [seg1,2,3  ] ← buffer full
  │                                         │
  │  (app reads data from buffer)           │
  │◄── ACK 3 + Window = 2 ─────────────────│ [         ] ← buffer freed
  │─── seg 4 ──────────────────────────────►│
  │─── seg 5 ──────────────────────────────►│
  │  (window = 0 from receiver)             │
  Wait until window opens again...
```

---

## SECTION 4 — Request Flow — Step by Step

### Scenario A: TCP — HTTP Request from Browser to Web Server

```
╔══════════════════════════════════════════════════════════════════╗
║     TCP FULL LIFECYCLE: HTTP REQUEST                            ║
╚══════════════════════════════════════════════════════════════════╝

Browser (10.0.1.5:54321)          Web Server (198.51.100.10:443)

[CONNECTION SETUP]
Step 1: Browser picks random ephemeral source port (54321)
        Sends TCP SYN:
          src=10.0.1.5:54321, dst=198.51.100.10:443
          flags=SYN, seq=1000

Step 2: Server receives SYN, sends SYN+ACK:
          src=198.51.100.10:443, dst=10.0.1.5:54321
          flags=SYN+ACK, seq=5000, ack=1001

Step 3: Browser sends ACK:
          seq=1001, ack=5001, flags=ACK
        --- TCP CONNECTION ESTABLISHED ---

[TLS HANDSHAKE (on top of TCP)]
Step 4: Browser → ClientHello (TLS 1.3)
Step 5: Server → ServerHello + Certificate + Finished
Step 6: Browser → Finished (keys exchanged)
        --- TLS SESSION ESTABLISHED ---

[HTTP/2 REQUEST DATA]
Step 7: Browser sends HTTP GET (encrypted, inside TCP):
          seq=1001, data=480 bytes (HTTP headers + request)
          flags=ACK+PSH

Step 8: Server ACKs the data:
          ack=1481

Step 9: Server sends HTTP response (compressed HTML):
          seq=5001, data=8000 bytes (split across multiple TCP segments)
          Segment 1: bytes 5001-6460 (1460 bytes — max segment size)
          Segment 2: bytes 6461-7920 (1460 bytes)
          Segment 3: bytes 7921-9000 (1080 bytes, last)

Step 10: Browser ACKs all segments (cumulative):
          ack=9001

[CONNECTION TEARDOWN — HTTP/1.1 close or HTTP/2 keeps alive]
Step 11: Server sends FIN (or stays open for keep-alive)
Step 12: Browser sends ACK
Step 13: Browser sends FIN (when done)
Step 14: Server sends ACK
Step 15: Browser enters TIME_WAIT (60 seconds)
```

### Scenario B: UDP — DNS Query

```
╔══════════════════════════════════════════════════════════════════╗
║     UDP DNS QUERY: COMPLETE FLOW                                ║
╚══════════════════════════════════════════════════════════════════╝

Application (10.0.1.5:random)     DNS Resolver (10.0.0.2:53)

Step 1: Application sends DNS query datagram:
          src=10.0.1.5:54980, dst=10.0.0.2:53
          UDP header: 8 bytes
          DNS payload: ~32 bytes query
          Total: ~40 bytes UDP datagram

          No connection. No SYN. Just sent.

Step 2: Resolver processes query immediately
        Resolver responds:
          src=10.0.0.2:53, dst=10.0.1.5:54980
          UDP header: 8 bytes
          DNS response: ~80 bytes (answer + TTL)
          Total: ~88 bytes UDP datagram

Step 3: Application receives response
        No ACK, no connection teardown.

        If the response is lost (network glitch):
          Application's DNS library waits ~2 seconds
          Resends the exact same DNS query (application-level retry)
          Resolver answers again
          Application uses the response

        Total round trips: 1 (in happy path)
        Total bytes exchanged: ~128 bytes

        Compare with TCP equivalent:
          3 SYN packets + actual data = 5+ round trips minimum

╔══════════════════════════════════════════════════════════════════╗
║  UDP DNS: 1 RTT, 128 bytes total                                ║
║  TCP DNS: 2 RTT minimum (handshake + query/response), 400+ bytes║
╚══════════════════════════════════════════════════════════════════╝
```

### Why Video Streaming Uses UDP (or QUIC)

```
Live video stream scenario:
  Video frames: 30fps → 1 frame every 33ms
  Frame size: ~100KB
  TCP retransmission can add: 100ms–3 seconds

Timeline issue:
  Frame at T=0ms: sent, received ✓
  Frame at T=33ms: sent, LOST
  Frame at T=66ms: sent, received ✓
  Frame at T=99ms: TCP retransmits T=33ms frame...

  What should the player show at T=66ms?
  Option A (TCP behavior): wait for T=33ms to arrive → freeze for 100ms–3s
  Option B (UDP behavior): show T=66ms now → T=33ms is gone, move on
                           Player shows "slight stutter" or "macroblocking"
                           but never freezes

With UDP: worst case = brief visual artifact
With TCP: worst case = stream freezes for RTO duration

This is why YouTube, Netflix (QUIC), Zoom, WebRTC all use UDP or
UDP-based protocols for media streams.
```

---

## File Summary

This file covered:

- TCP = certified mail (reliable, ordered, connection-oriented); UDP = radio broadcast (best-effort, connectionless)
- TCP provides: reliable delivery, ordered delivery, error detection, flow control, congestion control, full-duplex
- UDP provides: port multiplexing, optional checksum — nothing else
- TCP header: 20 bytes minimum (with seq numbers, ACK, window, flags); UDP header: 8 bytes always
- TCP control flags: SYN, ACK, FIN, RST are the critical four
- TCP state machine: CLOSED → SYN_SENT → ESTABLISHED → FIN_WAIT → TIME_WAIT → CLOSED
- TIME_WAIT: 2×MSL duration prevents ghost packets from previous connections
- UDP wins when: broadcast/multicast, loss-tolerant real-time streams, small high-frequency messages (DNS)
- TCP wins when: every byte matters, ordering critical, two-party communication, file transfers

**Continue to File 02** for real-world examples (QUIC, WebRTC, gaming protocols), system design considerations (TCP HOL blocking, UDP security risks, DTLS), AWS NLB TCP vs UDP support, and interview Q&As.
