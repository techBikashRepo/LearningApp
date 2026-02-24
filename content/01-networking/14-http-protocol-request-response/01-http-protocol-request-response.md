# HTTP Protocol (Request/Response) — Part 1 of 3

### Topic: How Browsers and Servers Speak to Each Other

**Series:** Networking Fundamentals → System Design → AWS Solutions Architect
**Audience:** 14-Year Experienced Full-Stack Developer → Becoming an Architect
**Sections Covered:** 1, 2, 3, 4

---

## SECTION 1 — Intuition First (ELI12 Version)

### Analogy 1 — Ordering at a Restaurant

You walk into a restaurant and want a burger. You don't just grab it from the kitchen — there's a protocol:

1. **You (client) make a request:** "Can I have a cheeseburger with fries, please?" (HTTP Request)
2. **Waiter (server) processes and responds:** "Here is your cheeseburger and fries." (HTTP Response)
3. Each order is completely independent — the waiter doesn't remember your last visit (stateless)
4. You can make multiple orders during the same visit (keep-alive connection)
5. If the kitchen is out of burgers: "Sorry, item unavailable" (404 Not Found)
6. If you order something from the restricted menu without permission: "Members only" (403 Forbidden)

The restaurant analogy breaks down at one point: in HTTP, each request carries everything needed to fulfill it — you re-introduce yourself (send headers) with EVERY order, because the waiter has no memory. This statelessness is a fundamental design choice, not a limitation.

### Analogy 2 — Sending a Letter with a Reply Envelope

Before email, you could send letters with a pre-stamped reply envelope:

1. You write your letter using a specific **format**: your address, their address, subject, body (HTTP request format)
2. You specify what format you want the reply in: "Please reply in English, typed" (Accept headers)
3. The other person writes back using the same format: their address (response headers), your answer (body)
4. The envelope itself carries routing information (IP/TCP) — you don't write routing tables on the letter
5. If both agree upfront to use a translated letter service, all letters are scrambled in transit but decoded at each end (HTTPS/TLS)

HTTP is exactly this: a **text-based, human-readable message format** layered on top of TCP (which handles the envelope routing). HTTP defines HOW you write the message. TCP defines HOW it gets delivered.

---

## SECTION 2 — Core Technical Deep Dive

### What HTTP Is

HTTP (HyperText Transfer Protocol) is an **application-layer, stateless, request-response protocol** designed to transfer hypermedia (HTML, JSON, images, video) over TCP/IP.

Key properties:

- **Text-based** (HTTP/1.x): requests and responses are human-readable ASCII text (unlike binary protocols)
- **Stateless:** each request stands alone; server retains no memory between requests (cookies/sessions layer state on top)
- **Request-response:** client always initiates; server always responds; not bidirectional like WebSockets
- **Layered on TCP:** HTTP doesn't define how bytes travel (TCP does); HTTP only defines message format and semantics

### HTTP Request Structure

Every HTTP request has three parts:

```
REQUEST LINE:   METHOD  SP  Request-URI  SP  HTTP-Version  CRLF
HEADERS:        Field-Name: Field-Value  CRLF  (one per line)
                ...
EMPTY LINE:     CRLF   (marks end of headers)
BODY:           optional message body (for POST/PUT)
```

**Concrete example — A browser fetching a product page:**

```
GET /products/42 HTTP/1.1\r\n
Host: api.shop.com\r\n
Accept: text/html,application/json;q=0.9\r\n
Accept-Encoding: gzip, br\r\n
Accept-Language: en-US,en;q=0.9\r\n
Connection: keep-alive\r\n
Cookie: session=abc123\r\n
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)\r\n
\r\n
(no body for GET)
```

Breaking this down:

- `GET` — the method (what action)
- `/products/42` — the request URI (which resource)
- `HTTP/1.1` — protocol version
- `Host: api.shop.com` — **mandatory in HTTP/1.1**; needed for virtual hosting (one IP, many domains)
- `Accept: text/html,application/json;q=0.9` — content negotiation; client says what it can handle
- `\r\n` (CRLF) — HTTP line endings are carriage-return + newline, not just newline
- Blank line — MANDATORY separator between headers and body

**POST request example — submitting an order:**

```
POST /orders HTTP/1.1\r\n
Host: api.shop.com\r\n
Content-Type: application/json\r\n
Content-Length: 58\r\n
Authorization: Bearer eyJhbGciOiJSUzI1NiJ9...\r\n
\r\n
{"product_id": 42, "quantity": 2, "shipping": "express"}
```

Notable: `Content-Length` is required when there's a body (server needs to know when body ends).

### HTTP Response Structure

```
STATUS LINE:    HTTP-Version  SP  Status-Code  SP  Reason-Phrase  CRLF
HEADERS:        Field-Name: Field-Value  CRLF
                ...
EMPTY LINE:     CRLF
BODY:           response content (HTML, JSON, image bytes, etc.)
```

**Concrete response example:**

```
HTTP/1.1 200 OK\r\n
Date: Mon, 23 Feb 2026 10:00:00 GMT\r\n
Content-Type: application/json; charset=utf-8\r\n
Content-Length: 142\r\n
Cache-Control: max-age=60, public\r\n
ETag: "a1b2c3d4"\r\n
X-Request-ID: 7f3d9a12-...\r\n
Connection: keep-alive\r\n
\r\n
{"id": 42, "name": "Wireless Headphones", "price": 79.99, "stock": 14, "category": "electronics"}
```

### HTTP Versions Evolution

| Version      | Year | Transport                      | Key Feature                                                                         | Problem                                                   |
| ------------ | ---- | ------------------------------ | ----------------------------------------------------------------------------------- | --------------------------------------------------------- |
| **HTTP/0.9** | 1991 | TCP                            | GET only, no headers                                                                | Trivial                                                   |
| **HTTP/1.0** | 1996 | TCP                            | Headers added, status codes                                                         | New TCP connection per request (3-way handshake overhead) |
| **HTTP/1.1** | 1997 | TCP                            | Persistent connections, pipelining, chunked transfer, virtual hosting (Host header) | HOL blocking in pipelining; 6 connections per origin      |
| **HTTP/2**   | 2015 | TCP (TLS required in practice) | Binary framing, multiplexing, header compression (HPACK), server push               | TCP HOL blocking (one lost packet stalls all streams)     |
| **HTTP/3**   | 2022 | QUIC (UDP)                     | Per-stream reliability (no HOL blocking), 0-RTT resumption, connection migration    | UDP blocked by some firewalls/enterprise networks         |

### HTTP/1.1 Persistent Connections

HTTP/1.0: Every request opened a new TCP connection (3-way handshake + TLS if HTTPS = 2-3 RTT overhead per request).

HTTP/1.1 keeps the TCP connection open:

```
Client ─────── TCP connect (SYN/SYN-ACK/ACK) ──────► Server
Client ─── GET /page ─────────────────────────────► Server
Server ─── 200 OK (HTML) ◄──────────────────────── Server
Client ─── GET /style.css ────────────────────────► Server
Server ─── 200 OK (CSS) ◄──────────────────────── Server
Client ─── GET /app.js ───────────────────────────► Server
Server ─── 200 OK (JS) ◄─────────────────────────Server
                         [connection reused — no re-handshake]
```

`Connection: keep-alive` (HTTP/1.1 default). `Connection: close` tells server to close after this request.

**HTTP/1.1 Pipelining Problem:**
Pipelining: send multiple requests without waiting for each response. But responses must come back IN ORDER. If the server is slow on request #2, requests #3, #4, #5 are blocked even though they're ready. This is HTTP-level Head-of-Line (HOL) blocking.

### HTTP/2 Multiplexing

HTTP/2 uses a binary framing layer. Each request/response is split into frames tagged with a Stream ID. Multiple streams interleave on one TCP connection — no ordering requirement:

```
TCP Connection: one persistent connection
  ├── Stream 1: GET /api/users     → frames with stream_id=1
  ├── Stream 3: GET /api/products  → frames with stream_id=3
  ├── Stream 5: GET /api/orders    → frames with stream_id=5
  └── All streams interleave freely; no ordering constraint
```

HTTP/2 also compresses headers with HPACK (referencing a shared header table — repeated `Host: api.shop.com` on every request becomes a 1-byte table index after first use).

### Chunked Transfer Encoding

When the server doesn't know the response size upfront (streaming responses, server-side rendering):

```
HTTP/1.1 200 OK
Transfer-Encoding: chunked
Content-Type: text/plain

7\r\n         (hex byte count of next chunk)
Mozilla\r\n   (chunk data)
9\r\n
Developer\r\n
5\r\n
Network\r\n
0\r\n         (zero-length chunk = end of stream)
\r\n
```

This avoids buffering the entire response before sending — critical for large file downloads and streaming APIs.

---

## SECTION 3 — Architecture Diagram

```
╔══════════════════════════════════════════════════════════════════════╗
║         HTTP REQUEST/RESPONSE: FULL TRANSACTION DIAGRAM             ║
╚══════════════════════════════════════════════════════════════════════╝

BROWSER (CLIENT)                            WEB SERVER / ALB
     │                                            │
     │──── 1. DNS lookup: api.shop.com ──────────►│(DNS resolver, not shown)
     │◄─── 1. Returns IP: 54.x.x.x ──────────────│
     │                                            │
     │──── 2. TCP SYN ───────────────────────────►│
     │◄─── 2. TCP SYN-ACK ────────────────────────│
     │──── 2. TCP ACK ───────────────────────────►│  [TCP handshake = 1 RTT]
     │                                            │
     │──── 3. TLS ClientHello ───────────────────►│
     │◄─── 3. TLS ServerHello + Cert ─────────────│
     │──── 3. TLS Finished ──────────────────────►│  [TLS 1.3 = 1 RTT]
     │                                            │
     │                                            │
     │──── 4. HTTP REQUEST ──────────────────────►│
     │      GET /products/42 HTTP/1.1             │
     │      Host: api.shop.com                    │
     │      Accept: application/json              │
     │      Authorization: Bearer abc...          │
     │                                  ┌─────────┘
     │                                  │ Server processing:
     │                                  │ - Parse request
     │                                  │ - Auth middleware
     │                                  │ - DB query
     │                                  │ - Serialize JSON
     │                                  └─────────┐
     │◄─── 5. HTTP RESPONSE ──────────────────────│
     │      HTTP/1.1 200 OK                       │
     │      Content-Type: application/json        │
     │      Cache-Control: max-age=60             │
     │      ETag: "a1b2c3"                        │
     │      {"id":42,"name":"Headphones",...}      │
     │                                            │
     │──── 6. NEXT REQUEST (same TCP connection) ►│  [persistent connection]
     │      GET /cart HTTP/1.1                    │
     │      ...                                   │

═══════════════════════════════════════════════════════════════

HTTP/1.1 vs HTTP/2 PARALLELISM:

HTTP/1.1 (6 parallel connections max per browser):
  Conn 1: GET /page.html ─────────────────────── wait ── GET /component1
  Conn 2: GET /main.css ────────────────────────────── GET /component2
  Conn 3: GET /app.js ──────────────────────────────── GET /component3
  Conn 4: GET /hero.jpg ────────────────────────────── (idle)
  Conn 5: GET /font.woff ───────────────────────────── (idle)
  Conn 6: GET /icon.svg ────────────────────────────── (idle)
  [6 TCP connections × 6-way handshakes × overhead]

HTTP/2 (1 connection, unlimited streams):
  Conn 1:
    Stream 1: GET /page.html ─────────── response
    Stream 3: GET /main.css ──────────── response
    Stream 5: GET /app.js ────────────── response
    Stream 7: GET /hero.jpg ──────────── response
    Stream 9: GET /font.woff ─────────── response
    Stream 11: GET /icon.svg ─────────── response
  [1 TCP connection, all resources in parallel, HPACK compresses repeated headers]

═══════════════════════════════════════════════════════════════

PROTOCOL STACK:

   Application   │  HTTP/1.1 (text)  │  HTTP/2 (binary)  │  HTTP/3     │
   ───────────── │ ════════════════ │ ════════════════  │ ═══════════ │
   Security      │  TLS 1.3         │  TLS 1.3          │  QUIC+TLS   │
   Transport     │  TCP             │  TCP              │  UDP        │
   Network       │  IP              │  IP               │  IP         │
```

---

## SECTION 4 — Request Flow: Step by Step

### Complete HTTP/1.1 HTTPS Transaction (from browser address bar to rendered page)

```
User types: https://shop.example.com/products/42
Press Enter

STEP 1 — URL PARSING
  Browser parses: scheme=https, host=shop.example.com, path=/products/42
  Port: implied 443 (HTTPS default)

STEP 2 — DNS RESOLUTION
  Browser cache miss → OS DNS resolver → Route 53 (or ISP resolver)
  shop.example.com → A record → 54.239.28.85
  Time: 10-50ms (cached: <1ms)

STEP 3 — TCP CONNECTION
  Browser initiates TCP to 54.239.28.85:443
  SYN → SYN-ACK → ACK
  Time: 1 RTT (~20ms for same-region)

STEP 4 — TLS 1.3 HANDSHAKE
  ClientHello (TLS version, cipher suites, SNI=shop.example.com, key share)
  ServerHello + Certificate + Finished (TLS 1.3 = 1 RTT)
  Browser validates cert chain against trusted CA roots
  Time: 1 RTT (~20ms)
  [Total so far: DNS + TCP + TLS = ~50-90ms before first byte sent]

STEP 5 — HTTP REQUEST
  Browser sends (encrypted via TLS):
    GET /products/42 HTTP/1.1
    Host: shop.example.com
    Accept: text/html,application/xhtml+xml
    Accept-Encoding: gzip, deflate, br
    Accept-Language: en-US
    Cookie: session=abc123; cart_id=xyz789
    Connection: keep-alive

STEP 6 — SERVER PROCESSING
  ALB receives request → routes to EC2 target
  EC2: Express.js router → /products/:id handler
  DB query: SELECT * FROM products WHERE id=42
  Response: 200 OK + JSON body (or HTML if SSR)
  Server time: 20-100ms typical

STEP 7 — HTTP RESPONSE
  Server sends (encrypted via TLS):
    HTTP/1.1 200 OK
    Content-Type: text/html; charset=utf-8
    Content-Length: 12480
    Cache-Control: private, max-age=0
    Set-Cookie: viewed_42=1; Path=/; HttpOnly
    X-Request-ID: 7f3d9a12-...

STEP 8 — BROWSER RENDERING
  Browser receives HTML → parses DOM
  Discovers sub-resources: CSS, JS, images
  Sends new HTTP requests for each (reusing same TCP connection!)
  OR opens new connections for parallel requests

STEP 9 — SUBSEQUENT REQUESTS (keep-alive)
  Same TCP connection reused for:
    GET /static/main.css HTTP/1.1
    GET /static/app.js HTTP/1.1
    GET /images/product/42.jpg HTTP/1.1
  [No new TCP or TLS handshake — 0 RTT overhead]

  Connection: keep-alive timeout = 75s (Apache default) after last request

STEP 10 — CONNECTION CLOSE
  Server sends: Connection: close (or timeout expires)
  FIN → FIN-ACK → ACK → FIN → FIN-ACK → ACK
  TCP 4-way teardown

TOTAL FIRST REQUEST LATENCY (typical):
  DNS lookup:        20ms
  TCP handshake:     20ms
  TLS 1.3:           20ms
  Server processing: 50ms
  Data transfer:     10ms
  ─────────────────
  Total:            ~120ms to first byte (TTFB)

With HTTP/2 + TLS 1.3 session resumption (repeat visit):
  DNS:     <1ms (cached)
  TCP:     20ms
  TLS:     0ms (0-RTT session resumption in TLS 1.3)
  Server:  50ms
  Total:  ~71ms TTFB
```

---

## File Summary

This file covered:

- Restaurant (stateless ordering) and letter-with-reply-envelope analogies for HTTP request/response
- HTTP request structure: request line, headers, blank line, optional body (CRLF delimiters)
- HTTP response structure: status line, headers, blank line, body
- Critical HTTP/1.1 headers: `Host` (mandatory), `Content-Type`, `Content-Length`, `Connection`
- HTTP version evolution: 1.0 (new TCP per request) → 1.1 (persistent connections, pipelining) → 2 (binary multiplexing, HPACK) → 3 (QUIC, per-stream reliability)
- HTTP/1.1 HOL blocking in pipelining; HTTP/2 solves at HTTP level but not TCP level
- Chunked transfer encoding for unknown-size streaming responses
- Full HTTPS transaction timing: DNS + TCP + TLS + server + transfer = ~120ms TTFB

**Continue to File 02** for real-world examples (how ALB handles HTTP, how reverse proxies buffer responses), system design considerations (connection pooling, response size, streaming APIs), AWS ALB/CloudFront HTTP features, and 8 interview Q&As.
