# TCP 3-Way Handshake — Part 1 of 3

### Topic: The Exact Mechanics of TCP Connection Establishment

**Series:** Networking Fundamentals → System Design → AWS Solutions Architect
**Audience:** 14-Year Experienced Full-Stack Developer → Becoming an Architect
**Sections Covered:** 1, 2, 3, 4

---

## SECTION 1 — Intuition First (ELI12 Version)

### Analogy 1 — The Telephone Operator Introduction

Imagine two strangers, Alice and Bob, trying to have a private conversation over a noisy phone line. Before they can exchange any information, they need to verify:

1. Both parties are listening and ready
2. Both parties understand each other (can hear and be heard)
3. Both parties have agreed on a code (so messages are trackable)

The handshake:

- Alice calls Bob: "Hello Bob! I'm Alice, my tracking number starts from 1000. Are you ready?" (SYN)
- Bob replies: "Hello Alice! I heard you — your tracking number is 1001 now. I'm Bob, my tracking number starts from 5000. Are you ready?" (SYN-ACK)
- Alice replies: "Hello Bob! I heard you — your tracking number is 5001 now. Ready to start!" (ACK)

Now they both know:

- Both sides are alive and can hear (and be heard by) each other
- Both sides have a shared code system (sequence numbers) to ensure nothing is missed
- Which number to use for the next message (ISN)

Only after all three exchanges can they begin their actual conversation. This overhead is deliberate — without it, Alice might send data to Bob who isn't listening, or Bob might lose data with no way to detect what was missed.

### Analogy 2 — Two Pilots Doing Pre-Flight Communication Checklist

Before a plane taxis, pilots do a communication check with air traffic control:

- Pilot: "Tower, this is Flight 42, requesting departure check. Over." (SYN)
- Tower: "Flight 42, tower acknowledges. Runway 3 clear. Squawk code 4521. Over." (SYN-ACK)
- Pilot: "Tower, Flight 42 received runway 3 and squawk 4521. Ready for taxi. Over." (ACK)

Neither party starts actual operations (taxiing) until this exchange is complete. The exchange confirms:

- The radio works both ways (bidirectionality)
- Both parties agree on identifying codes (sequence numbers)
- The channel is dedicated and established (stateful connection)

A one-way broadcast ("I'm taking off now!") without confirmation is dangerous — the tower might be on a different frequency, might not have heard, might have critical information to share first. The handshake pays a small upfront cost for a guaranteed foundation.

---

## SECTION 2 — Core Technical Deep Dive

### Initial Sequence Number (ISN)

Before the handshake begins, each side independently generates an **Initial Sequence Number (ISN)** — a 32-bit random number that identifies the starting point for that side's byte stream.

**Why random?**

- Prevents **TCP session hijacking**: if ISNs were predictable (e.g., always start at 0), an attacker who knows the 4-tuple (src IP, src port, dst IP, dst port) could forge ACK packets with the correct sequence number and inject data into your connection
- Prevents **ghost packets**: old packets from a previous connection (same 4-tuple) with low sequence numbers could match the new connection if ISNs weren't randomized
- RFC 6528 mandates: ISNs must be generated using a cryptographically secure method. Modern Linux uses a hash of the connection 4-tuple + a per-system secret key + a timestamp component

**ISN range:**

- 32-bit: values 0 to 4,294,967,295
- Sequence numbers wrap around: after reaching maximum, they start from 0 again
- Wrap-around protection: TCP PAWS (Protection Against Wrapped Sequence numbers) extension uses timestamps to distinguish old vs new wrapped numbers

### The Three Steps — Byte-Level Detail

```
Step 1 — SYN (Client → Server):

TCP Header sent by client:
  SYN flag = 1  (initiating connection)
  ACK flag = 0  (no acknowledgment yet)
  Sequence Number = ISN_client (e.g., 1000)
  Acknowledgment Number = 0 (unused)
  Source Port = 54321 (ephemeral, OS-assigned)
  Destination Port = 443 (target service)
  Window Size = 65535 (max bytes client can receive)
  Options: MSS=1460, SACK permitted, Window Scale

Key: the SYN segment itself "consumes" 1 sequence number even though it carries
     no application data. Next byte from client will be sent with seq=1001.

Step 2 — SYN-ACK (Server → Client):

TCP Header sent by server:
  SYN flag = 1  (server initiating its own direction)
  ACK flag = 1  (acknowledging client's SYN)
  Sequence Number = ISN_server (e.g., 5000)
  Acknowledgment Number = ISN_client + 1 = 1001
    → "I received up to byte 1000 from you; expecting byte 1001 next"
  Source Port = 443
  Destination Port = 54321
  Window Size = 65535 (max bytes server can receive)
  Options: MSS=1460, SACK permitted, Window Scale

The SYN-ACK simultaneously:
  - Acknowledges client's ISN (via ACK flag + ack=1001)
  - Proposes server's own ISN (via SYN flag + seq=5000)
  This is why we need 3 segments, not 2 — the server's SYN must also be ACK'd.

Step 3 — ACK (Client → Server):

TCP Header sent by client:
  SYN flag = 0  (connection setup phase complete)
  ACK flag = 1  (acknowledging server's SYN-ACK)
  Sequence Number = 1001 (ready to send data)
  Acknowledgment Number = ISN_server + 1 = 5001
    → "I received up to byte 5000 from you; expecting byte 5001 next"

  This final ACK is sent but carries no data.
  After this, the application can send application data immediately
  (client can "piggyback" the first HTTP request in this ACK segment if using TCP Fast Open)
```

### Why 3 Steps and Not 2?

A 2-way handshake (SYN → SYN-ACK) would establish ONE direction: server knows client is ready. But:

- Client never confirmed that IT received the server's ISN
- If the SYN-ACK was lost and client retransmits SYN: server has a "half-open" connection with no way to detect it

A 4-way handshake isn't needed because the server can combine its ACK-of-client's-SYN + its own SYN into a single SYN-ACK segment.

The 3-way handshake is the minimum number of exchanges to achieve:

1. Client → Server: "I'm ready, here's my ISN" (SYN)
2. Server → Client: "I received your ISN, I'm ready, here's my ISN" (SYN-ACK)
3. Client → Server: "I received your ISN" (ACK)

### TCP Options Negotiated During Handshake

Several critical TCP features are negotiated via options in the SYN and SYN-ACK:

| Option                     | Purpose                          | Details                                                                |
| -------------------------- | -------------------------------- | ---------------------------------------------------------------------- |
| MSS (Maximum Segment Size) | Agree on max payload per segment | Typically 1460 bytes for Ethernet (1500 MTU - 40 bytes TCP+IP headers) |
| Window Scale               | Extend 16-bit window to 30-bit   | Allows windows > 65535 bytes; essential for high-bandwidth links       |
| SACK Permitted             | Enable selective acknowledgment  | Receiver can ACK non-contiguous ranges; reduces retransmissions        |
| Timestamps                 | Enable RTT estimation, PAWS      | Prevents sequence number wrapping issues on high-speed links           |
| TCP Fast Open (TFO)        | Enable data in SYN               | Reduces connection setup to 0 extra RTT for repeat connections         |

### TCP Connection States During Handshake

```
CLIENT STATE:          PACKETS:              SERVER STATE:

CLOSED                                        LISTEN
    │                                           │
    │ client calls connect()                    │ server calls listen()
    ▼                                           ▼
SYN_SENT             ──SYN──►►►──►             SYN_RECEIVED
    │                                           │
    │                ◄─SYN+ACK─◄──◄            │
    ▼                                           │
ESTABLISHED          ──ACK──►►►──►             │
    │                                           ▼
    │ connection established               ESTABLISHED
    ▼                                           │
 [APPLICATION DATA CAN FLOW BOTH DIRECTIONS]
```

**Server-side note:** The server transitions to SYN_RECEIVED before it receives the final ACK. This period between receiving SYN and receiving ACK is the **half-open connection** window — exploited in SYN flood attacks.

### The Half-Open Connection Queue (SYN Queue + Accept Queue)

The Linux TCP stack maintains two queues on the listening server:

**SYN Queue (incomplete connection queue):**

- Contains entries for connections that have received SYN, sent SYN-ACK, but NOT yet received ACK
- Size: `/proc/sys/net/ipv4/tcp_max_syn_backlog` (default 128–512 depending on distro)
- Each entry requires ~280 bytes of kernel memory

**Accept Queue (complete connection queue):**

- Contains fully established connections (3-way handshake complete) waiting for `accept()` call by application
- Size: `backlog` parameter passed to `listen()` syscall, capped at `net.core.somaxconn`
- If full: new completed connections are dropped (not refused — silently dropped)

**SYN Flood attack mechanism:**
Attacker sends millions of SYN packets with spoofed source IPs. Server allocates SYN queue entry for each, sends SYN-ACK to spoofed address, waits for ACK that never comes. SYN queue fills completely. Legitimate connection SYNs land on full queue → dropped.

**SYN Cookies defense:**
When the SYN queue is full, the server can enable SYN cookies:

- Instead of allocating a queue entry, server encodes connection parameters into the ISN (SYN cookie)
- The SYN-ACK contains the encoded ISN
- When the legitimate client responds with ACK (containing ISN+1), server decodes the connection parameters from the ACK number
- Connection established WITHOUT ever allocating a SYN queue entry
- SYN flood becomes harmless — attacker consumes no server memory

Linux: `net.ipv4.tcp_syncookies=1` (should always be enabled on production servers)

---

## SECTION 3 — Architecture Diagram

### Complete 3-Way Handshake with Packet Details

```
╔══════════════════════════════════════════════════════════════════════╗
║       TCP 3-WAY HANDSHAKE WITH TIMING AND PACKET DETAILS            ║
╚══════════════════════════════════════════════════════════════════════╝

CLIENT                     Network                      SERVER
(10.0.1.5:54321)         (RTT ~20ms)              (10.0.2.10:443)
                                                   [LISTEN state]
│                                                         │
│ T=0ms  Calls connect()                                  │
│ State: CLOSED → SYN_SENT                                │
│                                                         │
├──── [SYN] ──────────────────────────────────────────────►│
│  seq=1000, ack=0                                         │ T=10ms received
│  flags=SYN                                               │ State: LISTEN → SYN_RECEIVED
│  win=65535                                               │ Allocates SYN queue entry
│  MSS=1460, SACK, WS=7                                    │
│                                                         │
│                    ◄──────────────────── [SYN+ACK] ─────┤
│  T=20ms received                    seq=5000, ack=1001  │
│  State: SYN_SENT → ESTABLISHED      flags=SYN+ACK       │
│  (client is ESTABLISHED after        win=65535           │
│   receiving valid SYN-ACK)           MSS=1460, SACK, WS=7│
│                                                         │
├──── [ACK] ──────────────────────────────────────────────►│
│  seq=1001, ack=5001                                      │ T=30ms received
│  flags=ACK                                               │ State: SYN_RECEIVED → ESTABLISHED
│  (no data — pure ACK)                                    │ Moves from SYN queue → Accept queue
│                                                         │ Application's accept() returns
│                                                         │
│ [TOTAL HANDSHAKE: 1 RTT = ~20ms]                        │
│                                                         │
│ [APPLICATION DATA NOW FLOWS]                            │
├──── HTTP GET /api/data (seq=1001, 500 bytes) ──────────►│
│                                                         │
│                    ◄──── HTTP 200 OK (seq=5001, 2000 bytes) ──┤
│                                                         │


HALF-OPEN CONNECTION WINDOW:
Server SYN Queue (after receiving SYN, before final ACK)

Client IP   Client Port   ISN    State        Timer
10.0.1.5    54321         1000   SYN_RECEIVED 60s timeout
10.0.1.6    54322         2000   SYN_RECEIVED 60s timeout
(spoofed)   (various)     rand   SYN_RECEIVED (SYN flood entries)


SYN COOKIES MECHANISM:
                                                Server (SYN cookies enabled)
  Attacker SYN (spoofed src IP)
  ─────────────────────────────────────────►   NO queue entry allocated
                                               ◄── SYN+ACK (ISN=encoded params)
  (sent to spoofed IP — never returns)

  Legitimate client SYN                        NO queue entry allocated
  ─────────────────────────────────────────►   ◄── SYN+ACK (ISN=hash(4-tuple+time+secret))
  Client sends ACK (ack=server_ISN+1)
  ─────────────────────────────────────────►   Decode connection params from ack number
                                               → ESTABLISHED (allocates memory now)
```

---

## SECTION 4 — Request Flow — Step by Step

### Scenario: Full HTTPS Connection (TCP Handshake + TLS Handshake Layered)

```
╔══════════════════════════════════════════════════════════════════╗
║     HTTPS = TCP 3-WAY + TLS 1.3 HANDSHAKE + HTTP REQUEST        ║
╚══════════════════════════════════════════════════════════════════╝

Browser (10.0.1.5)                    ALB (10.0.2.200:443)

─────────── DNS RESOLUTION (Topic 9) ───────────
Step 1: Resolve api.example.com → 10.0.2.200 [~50ms cold]

─────────── TCP 3-WAY HANDSHAKE ───────────
Step 2 [T=50ms]: Browser sends TCP SYN
  src=10.0.1.5:54321, dst=10.0.2.200:443
  flags=SYN, seq=1000, win=65535, MSS=1460

Step 3 [T=60ms]: ALB sends TCP SYN-ACK
  src=10.0.2.200:443, dst=10.0.1.5:54321
  flags=SYN+ACK, seq=8000, ack=1001, win=65535

Step 4 [T=70ms]: Browser sends TCP ACK
  seq=1001, ack=8001, flags=ACK
  TCP CONNECTION ESTABLISHED [consumed 1 RTT]

─────────── TLS 1.3 HANDSHAKE (on top of TCP) ───────────
Step 5 [T=70ms]: Browser sends TLS ClientHello (inside TCP data)
  Contains: supported cipher suites, TLS version, SNI="api.example.com"
  Client also sends key share for ECDHE (anticipates TLS 1.3)
  seq=1001, data=~300 bytes

Step 6 [T=80ms]: ALB sends ServerHello + Certificate + Finished (inside TCP data)
  ServerHello: selected cipher suite (TLS_AES_256_GCM_SHA384)
  Certificate: api.example.com cert chain
  CertificateVerify: server's signature proves cert ownership
  Finished: session keys derived, encryption begins
  ALB ack=1301, seq=8001, data=~2000 bytes

Step 7 [T=90ms]: Browser verifies cert, sends Finished
  Application data can begin immediately after this
  Browser ack=10001, seq=1301, flags=ACK+data
  TLS SESSION ESTABLISHED [1 RTT after TCP connection]

─────────── HTTP/2 REQUEST (encrypted inside TLS, inside TCP) ───────────
Step 8 [T=90ms]: Browser sends HTTP/2 HEADERS frame (encrypted)
  :method: GET
  :path: /api/payment/status
  :authority: api.example.com
  authorization: Bearer eyJhbGc...

Step 9 [T=100ms]: ALB decrypts, forwards to target EC2
  (ALB terminates TLS, re-establishes fresh TLS to backend if configured)

Step 10 [T=150ms]: EC2 processes request, returns response
  ALB encrypts, sends HTTP/2 DATA frame to browser

─────────── TOTAL TIME BREAKDOWN ───────────
DNS resolution:     50ms  (cold cache)
TCP handshake:      20ms  (1 RTT)
TLS 1.3 handshake:  20ms  (1 RTT)
Application logic:  50ms
───────────────────────────────────────────
Total first request: ~140ms

For subsequent requests (same TCP+TLS connection):
  DNS:              <1ms (cached)
  TCP:              0ms (reused)
  TLS:              0ms (reused)
  Application:      50ms
  Total:            ~51ms (HTTP/2 connection reuse)
```

### Why Connection Reuse Matters

| Scenario                 | DNS  | TCP  | TLS  | App  | Total |
| ------------------------ | ---- | ---- | ---- | ---- | ----- |
| First request (cold)     | 50ms | 20ms | 20ms | 50ms | 140ms |
| Subsequent (reuse)       | 0ms  | 0ms  | 0ms  | 50ms | 50ms  |
| TLS 1.3 0-RTT resumption | 0ms  | 20ms | 0ms  | 50ms | 70ms  |

HTTP/1.1 opened a new TCP+TLS connection per request. HTTP/2 multiplexes all requests over one connection. This change alone reduced web application latency by 60% for active users.

---

## File Summary

This file covered:

- The 3-way handshake (SYN→SYN-ACK→ACK) establishes mutual sequence number agreement before data flows
- ISN (Initial Sequence Number): randomly generated per RFC 6528 to prevent TCP hijacking and ghost packets
- SYN: client's ISN. SYN-ACK: server ACKs client + sends server's ISN. ACK: client ACKs server's ISN
- SYN segment "consumes" 1 sequence number even with no data payload (same for FIN)
- 3 steps = minimum to prove bidirectional communication + exchange both ISNs
- TCP options in handshake: MSS (max segment size), Window Scale, SACK, Timestamps, TFO
- SYN queue (half-open) → Accept queue (fully established) → application's accept()
- SYN flood: fills SYN queue; SYN cookies: mitigate by encoding params in ISN — no queue allocation
- Full HTTPS = DNS + TCP handshake (1 RTT) + TLS 1.3 (1 RTT) → reuse eliminates both for subsequent requests

**Continue to File 02** for real-world examples (SYN flood attacks, TLS handshake optimization, TCP Fast Open), system design considerations (connection pooling latency, TIME_WAIT at scale), AWS ALB connection management, and interview Q&As.
