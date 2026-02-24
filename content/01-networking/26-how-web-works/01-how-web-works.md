# How Web Works — Part 1 of 3

### Topic: What Really Happens When You Type a URL and Press Enter

**Series:** Networking Fundamentals → System Design → AWS Solutions Architect
**Sections Covered:** 1, 2, 3, 4

---

## SECTION 1 — ELI12 Explanation

### The Big Question That Covers Everything

"What happens when you type `https://www.google.com` and press Enter?"

This one question is the final exam of networking. To answer it fully, you need to understand:

- DNS, TCP, TLS, HTTP, CDN, Load Balancers, Web Servers, Databases, Caches, Browser Rendering

Let me walk you through it like a story.

### The Story: Sending a Letter to the Most Popular Person in the World

Imagine the internet is a massive city. You want to send a letter to Google.

**Step 1 — Finding the address (DNS)**

You know the name "Google" but not the street address (IP address). You go to the local post office directory (DNS resolver). The post office checks its book: "Google? Oh yes, their IP is 142.250.80.46. Write that on your envelope."

This step: 20–200 milliseconds (your first ever lookup; often 2ms after first lookup because the answer is cached).

**Step 2 — Building the road (TCP)**

You need to establish a connection. Think of this as knocking on Google's door and waiting for them to say "yes, come in" before you say anything.

Knock (SYN) → Google says "I hear you, come in" (SYN-ACK) → You say "thanks, I'm coming" (ACK). This handshake takes one round trip: ~30ms if Google is nearby, ~200ms if halfway across the world.

**Step 3 — The private conversation (TLS)**

Before you say anything important, you and Google agree on a secret code so nobody else can read your conversation. This takes one more round trip to exchange keys and agree on encryption.

**Step 4 — Your request (HTTP)**

Now you speak: "Hello Google, may I have your home page please?" (HTTP GET request)

**Step 5 — The journey there and back (Transit)**

Your request travels through cables, routers, and Google's data centers. Google processes it (checks caches, generates HTML). Google's response travels back to you.

**Step 6 — Your browser builds the page (Rendering)**

The browser receives Google's response and starts building the visual page — parsing HTML, downloading CSS and JavaScript, calculating layouts, and finally painting pixels on screen.

### The Two Analogies

**Analogy 1 — The Restaurant Meal**

Typing a URL is like ordering at a fancy restaurant:

- **DNS**: maitre d' finds your table (resolves your name to a location)
- **TCP handshake**: waiter introduces himself, you confirm you're ready to order
- **TLS**: you and the waiter speak in a private language so no one else hears your order
- **HTTP request**: "I'll have the homepage, please"
- **Server processing**: kitchen receives order, chef (web server) prepares it, retrieves ingredients (database), assembles the dish (HTML response)
- **HTTP response**: waiter delivers the dish
- **Browser rendering**: you see the meal presented, you can eat it (interact with the page)

The full meal: ~80-300ms from "I'll have the homepage" to tasting food. Feels instant.

**Analogy 2 — The Emergency Dispatch System**

Your request is an emergency call:

- **DNS**: 911 identifies your location (IP address lookup)
- **TCP**: dispatcher confirms connection, "I can hear you, go ahead"
- **TLS**: secure channel established, all communications encrypted
- **HTTP request**: "There's a fire at X address, send help"
- **Server processing**: dispatch center routes to the right department, multiple handlers coordinate (load balancer → web server → database → cache → content assembly)
- **HTTP response**: "Help is on the way, here's what you need to know" (HTML, CSS, JS files)
- **Browser rendering**: emergency responders arrive and handle the situation (scripts run, page becomes interactive)

---

## SECTION 2 — Core Technical Deep Dive

### The 8 Phases in Full Technical Detail

```
Phase 1: DNS Resolution

  Browser cache (0ms): Did you visit google.com in the last 300s?
    YES: use cached IP → skip to TCP
    NO: continue

  OS/hosts file check (0ms): /etc/hosts (Linux) or C:\Windows\System32\drivers\etc\hosts
    Used for local development: 127.0.0.1 myapp.local

  OS → Recursive DNS Resolver (your ISP's or 8.8.8.8 or 1.1.1.1): ~20ms
    Resolver cache hit: "I looked this up recently" → return cached A record → done
    Resolver cache miss: continue →

  Recursive resolver → Root DNS server (.): 12 root server clusters, anycast
    "Who handles .com zones?" → returns address of .com TLD servers

  Recursive resolver → .com TLD server:
    "Who handles google.com?" → returns Google's authoritative name server (ns1.google.com)

  Recursive resolver → Google's authoritative NS (ns1.google.com):
    "What is the IP for www.google.com?" → "142.250.80.46" (A record)
    TTL: 300s → resolver caches this for 5 minutes

  Total DNS time: 20-200ms first lookup, 0-2ms subsequent (from cache)

  What actually comes back:
    A record: www.google.com → 142.250.80.46 (IPv4)
    AAAA record: www.google.com → 2607:f8b0:4004:c1b::67 (IPv6)
    (Browser connects to whichever resolves faster via "Happy Eyeballs" algorithm)
```

```
Phase 2: TCP Connection (3-Way Handshake)

  Browser → Google server (SYN): "I want to connect, my sequence starts at 38473"
  Google server → Browser (SYN-ACK): "OK, your seq+1=38474. My seq starts at 92010"
  Browser → Google server (ACK): "Got it, your seq+1=92011. Ready!"

  Time cost: 1 RTT
  Example: Browser in London → Google us-east-1: 80ms RTT → 80ms for handshake
  Example: Browser in Tokyo → Google's Tokyo PoP: 5ms RTT → 5ms for handshake

  After handshake: connection established. Data can flow.

  TCP Slow Start begins IMMEDIATELY:
    Initial congestion window: 10 segments (~14KB)
    Doubles every RTT until loss or explicit congestion signal
    First request before TCP warms up:  fits in 1 RTT
    Large files (>14KB): need multiple RTTs for TCP to reach full throughput
```

```
Phase 3: TLS Handshake (HTTPS)

  TLS 1.3 (current standard):
    → Client Hello: "I speak TLS 1.3, here are my cipher suites and a key_share"
    ← Server Hello + Certificate + Finished: "OK, here's my cert+public key, here's Finished"
    → Client Finished: "I verified your cert, let's encrypt"

    Cost: 1 RTT (TLS 1.3). Then ENCRYPTED data can flow.
    TLS 1.2: 2 RTTs (one more negotiation round). Modern sites use TLS 1.3.
    TLS 0-RTT (session resumption): 0 RTTs for returning users in same session.

  What browser verifies during TLS:
    1. Certificate is signed by a trusted CA (in browser's trust store)
    2. Certificate's Common Name / SAN matches the requested domain
    3. Certificate is not expired
    4. Certificate is not revoked (OCSP check or CRL — can add ~100ms RTT)

  After TLS: Symmetric encryption established (AES-256-GCM typically)
             All HTTP data encrypted with session keys
```

```
Phase 4: HTTP Request

  Browser builds the GET request:

    GET / HTTP/2
    Host: www.google.com
    User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36
    Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,*/*;q=0.8
    Accept-Language: en-US,en;q=0.5
    Accept-Encoding: gzip, br (Brotli preferred)
    Cookie: [Google cookies]
    Sec-Fetch-Site: none
    Sec-Fetch-Mode: navigate
    Connection: keep-alive (implicit in HTTP/2)

  HTTP/2 framing:
    Compressed headers (HPACK compression — headers can be 50-60% smaller than HTTP/1.1)
    Single TCP connection (multiplexed — can handle dozens of parallel resource loads)
    Server can PUSH related resources: Google might send preemptive CSS before browser asks
```

```
Phase 5: Transit

  Request travels:
    Browser → OS TCP stack → NIC → Local router → ISP → IXP (Internet Exchange Point)
    → CDN PoP / Google's Edge PoP → Google's backbone → Google data center

  Google is a TIER 1 network: they own physical fiber cables (trans-Pacific, trans-Atlantic)
    London to Mountain View direct: Google's own fiber → less congestion than public internet

  Modern CDN (including Google's own edge):
    Google has 100+ "Google Front End" (GFE) edge PoPs worldwide
    TLS terminates at nearest GFE, not Mountain View
    HTTP/2 connection: London user → London GFE (~2ms)
    London GFE → Mountain View backend: Google's private low-latency backbone network

  Speeds:
    Browser → Nearest PoP: 2-50ms depending on geography
    PoP → Origin data center: 10-100ms (internal backbone, well-optimized)
    Total transit: 50-200ms round-trip for most users globally
```

```
Phase 6: Server Processing

  Google's request handling (simplified, not all details public):

  GFE (Google Front End):
    TLS termination
    HTTP/2 → HTTP/1.1 translation to backend
    Load balancing: Maglev (Google's custom L4 LB) → selects backend server

  Web Server (Jetty / custom HTTP server):
    Parse request
    Check user authentication (cookie verification → session store lookup)
    Route to appropriate handler: /search, /, /maps...

  Application Layer:
    Home page: personalized for logged-in users
    Calls Bigtable / Spanner (Google's internal databases) for user preferences
    Calls internal services for Doodle, news suggestions
    Assembles HTML template with dynamic data

  Caching layers (preventing full DB hits):
    Memcache: frequently accessed content (popular searches, trending topics)
    Protocol Buffers: serialized data between internal services

  Response assembly:
    HTML document generated
    Compressed (Brotli); ~14KB compressed (fits in ~10 TCP segments)
    HTTP/2 server push: browser hasn't asked yet but Google sends /logo.png, main.css
```

```
Phase 7: HTTP Response

  Server → Browser response:

    HTTP/2 200 OK
    content-type: text/html; charset=UTF-8
    content-encoding: br (Brotli compressed)
    cache-control: private, max-age=0
    content-security-policy: [extensive CSP headers]
    strict-transport-security: max-age=31536000 (HSTS: browser must use HTTPS forever)
    x-frame-options: SAMEORIGIN (anti-clickjacking)
    x-xss-protection: 0 (deprecated; CSP handles this)
    server: gws (Google Web Server)
    date: Tue, 21 Mar 2024 10:30:00 GMT

  Server push (HTTP/2 PUSH_PROMISE):
    Server proactively sends: /xjs/_/ss/k=... (critical CSS) before browser parses HTML
    Browser gets CSS before it would have asked for it → faster rendering

  Data flow:
    14KB compressed HTML arrives (10 segments, 1-2 TCP RTTs)
    Browser decompresses (Brotli): 85KB HTML
    Browser begins parsing while data still arrives (streaming parsing)
```

```
Phase 8: Browser Rendering

  HTML Parsing:
    Tokenize HTML → build DOM tree
    <html><head><body><div id="main">...
    Async/defer JS doesn't block parsing

  CSS (CSSOM):
    Inline <style> blocks: parsed immediately
    External CSS <link>: blocking! Browser pauses rendering until CSS downloaded
    Google inlines critical CSS to prevent this block

  Critical Rendering Path:
    DOM + CSSOM → Render Tree (only visible elements)
    Layout: calculate exact positions and sizes
    Paint: render pixels to layers
    Composite: combine layers → final frame pushed to display

  JavaScript Execution:
    Parser hits <script> tag (without defer/async): PAUSE DOM parsing, execute JS
    Google's scripts: all deferred or async → don't block first paint

  Resource Loading (parallel, HTTP/2 multiplexed):
    Browser discovers: <img src="/logo.png">, <link href="/styles.css">, <script src="/app.js">
    HTTP/2: requests all in parallel on same TCP connection
    No 6-connection-per-domain limit of HTTP/1.1

  Visual Timeline (Google home page, local ISP, rough estimates):
    0ms:      Enter pressed
    20ms:     DNS resolved (from cache)
    25ms:     TCP SYN sent
    55ms:     TCP established (30ms RTT)
    90ms:     TLS complete (1 more RTT)
    100ms:    HTTP GET request sent
    180ms:    First byte received (TTFB = 80ms server processing + 10ms transit)
    195ms:    Full HTML received (14KB fits in ~2 RTTs)
    210ms:    DOM parsed, CSS downloaded (pushed by server)
    250ms:    Render tree built, layout calculated
    280ms:    First Contentful Paint (user sees search bar)
    400ms:    Fully Interactive (JS loaded, search works)

  Total: ~400ms from Enter to interactive. Feels instant to humans (< 1 second).
```

---

## SECTION 3 — ASCII Diagram

```
╔════════════════════════════════════════════════════════════════════════════════╗
║              COMPLETE WEB REQUEST FLOW: GOOGLE.COM                            ║
╚════════════════════════════════════════════════════════════════════════════════╝

YOUR COMPUTER                     INTERNET                    GOOGLE

[Browser]
    │
    │ "www.google.com" ?
    ▼
[OS DNS Cache] ─── Hit? ──────────────────────────────────── Return IP
    │ Miss
    ▼
[Recursive DNS]──────────────── [Root NS (13 clusters)]
    │                                    │ .com?
    │                            [.com TLD NS]
    │                                    │ google.com?
    │                           [ns1.google.com]
    │◄────────────────────────── 142.250.80.46 (A record, TTL=300s)
    │ DNS costs: 0-200ms
    │
    ▼
[OS TCP Stack]
    │
    │ ──SYN──────────────────────────────────────────► [GFE Edge PoP]
    │ ◄──SYN-ACK─────────────────────────────────────         │
    │ ──ACK──────────────────────────────────────────►         │
    │ TCP costs: 1 RTT (30ms local, 200ms cross-ocean)         │
    │                                                          │
    │ ══TLS ClientHello══════════════════════════════►         │
    │ ◄══TLS ServerHello+Certificate+Finished════════         │
    │ ══TLS ClientFinished═══════════════════════════►         │
    │ TLS costs: 1 RTT (TLS 1.3)                               │
    │                                                 [GFE verifies cert,
    │                                                  terminates TLS,
    │                                                  forwards over backbone]
    │                                                          │
    │                                               [Google Backbone Network]
    │                                                          │
    │ ══[encrypted] HTTP GET / ══════════════════════►  [Load Balancer]
    │                                                    [Maglev LB]
    │                                                          │
    │                                                    [Web Server]
    │                                                          │
    │                                            ┌─────────────┤
    │                                            │             │
    │                                     [Cache (Memcache)]  [App Layer]
    │                                            │        [Bigtable/Spanner]
    │                                            │             │
    │                                            └─────────────┤
    │                                                    [Response Assembly]
    │                                                          │
    │ ◄══[encrypted] HTTP 200 OK + HTML (14KB br)══════════════╛
    │ HTTP GET → Response: ~80-200ms total (TTFB)
    │
    │
    ▼
[Browser Parser]
    │
    ├── HTML → DOM Tree
    ├── CSS → CSSOM Tree (parallel download, HTTP/2)
    ├── JS → Parse + Execute (deferred: after parsing)
    ├── Images → Decode + Display (lazy loaded)
    │
    ▼
[Render Tree]
    │
    ▼
[Layout Engine]
    │
    ▼
[Paint Engine]
    │
    ▼
[Compositor]
    │
    ▼
[GPU → Display] ◄── First Pixel! (~280ms after Enter)
    │
    ▼
[JavaScript Engine]
    │
    ▼
[Interactive Page] ◄── Fully Interactive (~400ms after Enter)


╔════════════════════════════════════════════════════════════════════════════════╗
║                     TIMING SUMMARY (London User, Google)                      ║
╠══════════════╦═══════════════╦════════════════════════════════════════════════╣
║ Phase        ║ Time          ║ Where Time Goes                                ║
╠══════════════╬═══════════════╬════════════════════════════════════════════════╣
║ DNS          ║ 0–20ms        ║ Cache hit (0ms) or full resolution (20-200ms)  ║
║ TCP          ║ 30ms          ║ 1 RTT: London → London GFE                     ║
║ TLS 1.3      ║ 30ms          ║ 1 RTT: 1 additional round trip                 ║
║ HTTP transit ║ 30ms          ║ Request → Response (GFE → backend → GFE)       ║
║ Server proc  ║ 50ms          ║ Auth check + cache lookup + HTML generation     ║
║ Download     ║ 10ms          ║ 14KB compressed HTML (fast on modern broadband) ║
║ DOM parse    ║ 15ms          ║ Build DOM+CSSOM (85KB HTML post-decompress)     ║
║ Render       ║ 30ms          ║ Layout + Paint + Composite → GPU               ║
╠══════════════╬═══════════════╬════════════════════════════════════════════════╣
║ TOTAL        ║ ~195–280ms    ║ Enter pressed → first pixel                    ║
╚══════════════╩═══════════════╩════════════════════════════════════════════════╝
```

---

## SECTION 4 — Step-by-Step Flow

### Complete End-to-End Flow With Every Decision Point

```
USER ACTION: Types "https://www.google.com" → presses Enter
                          │
                          ▼
           ┌─────────────────────────────┐
           │  PARSE THE URL             │
           │  Scheme: https             │
           │  Host: www.google.com      │
           │  Path: / (default)         │
           │  Port: 443 (https default) │
           └─────────────────────────────┘
                          │
                          ▼
           ┌─────────────────────────────────────────────────────────────┐
           │  PHASE 1: DNS RESOLUTION                                    │
           │                                                             │
           │  Step 1.1 — Browser DNS cache lookup                        │
           │    Key: "www.google.com"                                    │
           │    TTL not expired? → Use cached IP → SKIP TO PHASE 2       │
           │    Expired or missing? → Continue →                         │
           │                                                             │
           │  Step 1.2 — OS DNS cache / hosts file                       │
           │    Found? → Return IP → SKIP TO PHASE 2                     │
           │    Not found? → Query configured DNS resolver →             │
           │                                                             │
           │  Step 1.3 — Recursive Resolver (8.8.8.8)                   │
           │    Cache hit? → Return A/AAAA → TTL cached → IP returned    │
           │    Cache miss? → Walk DNS hierarchy:                        │
           │      → Root (.) → TLD (.com) → Authoritative (google.com)   │
           │      ← A record: 142.250.80.46, TTL=300s                   │
           │    Return IP to browser                                     │
           └─────────────────────────────────────────────────────────────┘
                          │ have: IP = 142.250.80.46
                          ▼
           ┌─────────────────────────────────────────────────────────────┐
           │  PHASE 2: TCP CONNECTION                                    │
           │                                                             │
           │  Step 2.1 — Check Connection Pool                          │
           │    Existing open TCP connection to 142.250.80.46:443?       │
           │    YES → reuse → SKIP TO PHASE 3 (or Phase 4 if TLS done)  │
           │    NO → new TCP handshake →                                 │
           │                                                             │
           │  Step 2.2 — TCP 3-Way Handshake                            │
           │    Browser: SYN (Seq=X, window=65535, MSS=1460)            │
           │    Server:  SYN-ACK (Seq=Y, Ack=X+1, window=65535)         │
           │    Browser: ACK (Seq=X+1, Ack=Y+1)                         │
           │    Connection ESTABLISHED. Initial cwnd = 10 MSS (~14KB)   │
           └─────────────────────────────────────────────────────────────┘
                          │
                          ▼
           ┌─────────────────────────────────────────────────────────────┐
           │  PHASE 3: TLS HANDSHAKE                                     │
           │                                                             │
           │  Step 3.1 — TLS Session Resume?                            │
           │    Browser: has cached session ticket for this server?      │
           │    YES → TLS 0-RTT or 1-RTT session resumption → faster     │
           │    NO → full TLS 1.3 handshake:                            │
           │                                                             │
           │  Step 3.2 — TLS 1.3 Handshake                              │
           │    Browser → Client Hello: TLS 1.3, cipher list, key_share  │
           │    Server → ServerHello+Certificate+CertVerify+Finished     │
           │    Browser verifies:                                        │
           │      • Cert signed by trusted CA? YES: continue            │
           │      • Cert matches "www.google.com"? YES: continue        │
           │      • Cert expired? NO (Google auto-renews): continue      │
           │    Browser → Finished: "trusted you, let's encrypt"        │
           │    Both sides derive symmetric keys (HKDF from ECDH)       │
           │    Encryption using: AES-256-GCM with ECDHE                │
           └─────────────────────────────────────────────────────────────┘
                          │
                          ▼
           ┌─────────────────────────────────────────────────────────────┐
           │  PHASE 4: HTTP/2 REQUEST                                    │
           │                                                             │
           │  Step 4.1 — HTTP/2 Connection Preface                      │
           │    (First connection only): ALPN negotiation during TLS     │
           │    ALPN extension: "I support h2, http/1.1" → server: "h2" │
           │                                                             │
           │  Step 4.2 — SETTINGS frames exchanged (1 RTT)              │
           │    Client SETTINGS: max concurrent streams=100             │
           │    Server SETTINGS: initial window size, header table size  │
           │                                                             │
           │  Step 4.3 — HTTP/2 GET Request                             │
           │    HEADERS frame (Stream ID=1):                             │
           │      :method: GET                                           │
           │      :path: /                                               │
           │      :scheme: https                                         │
           │      :authority: www.google.com                             │
           │      [HPACK compressed headers — 70% smaller than HTTP/1.1] │
           └─────────────────────────────────────────────────────────────┘
                          │
                          ▼
           ┌─────────────────────────────────────────────────────────────┐
           │  PHASE 5: TRANSIT                                           │
           │                                                             │
           │  Step 5.1 — IP Routing (7 hops typical)                    │
           │    Browser OS → default gateway (home router)              │
           │    Router → ISP access node → ISP backbone                 │
           │    ISP → Internet Exchange Point (IXP) or direct peering   │
           │    Google has extensive peering: ISPs connect directly      │
           │    ISP → Google network → Google's GFE PoP                 │
           │                                                             │
           │  Step 5.2 — Google's Edge                                  │
           │    GFE (Google Front End) receives TLS-encrypted request    │
           │    Decrypts (TLS terminates here, not at Mountain View)     │
           │    Routes over Google's private backbone to appropriate DC  │
           └─────────────────────────────────────────────────────────────┘
                          │
                          ▼
           ┌─────────────────────────────────────────────────────────────┐
           │  PHASE 6: SERVER PROCESSING                                 │
           │                                                             │
           │  Step 6.1 — Load Balancer (Maglev)                         │
           │    Consistent hashing → select backend server              │
           │    Health check: is this server healthy? YES → forward     │
           │                                                             │
           │  Step 6.2 — Web Server (GWS)                               │
           │    Parse HTTP request                                       │
           │    Authentication: verify Google cookies → user logged in? │
           │    Route to handler: "/" → homepage handler                │
           │                                                             │
           │  Step 6.3 — Application Logic                              │
           │    Check Memcache: is home page HTML cached?               │
           │      HIT: return cached HTML (skip DB)                     │
           │      MISS: query user preferences (Bigtable)               │
           │            query trending topics, news (Bigtable)          │
           │            query Doodle/holiday display (Spanner)          │
           │            assemble HTML template with dynamic data        │
           │            cache assembled HTML in Memcache                │
           │                                                             │
           │  Step 6.4 — Response Preparation                           │
           │    Compress HTML: Brotli (better than gzip on text)        │
           │    85KB HTML → 14KB compressed (83% reduction)             │
           │    Set headers: Cache-Control, HSTS, CSP, Content-Type     │
           └─────────────────────────────────────────────────────────────┘
                          │
                          ▼
           ┌─────────────────────────────────────────────────────────────┐
           │  PHASE 7: HTTP/2 RESPONSE                                   │
           │                                                             │
           │  Step 7.1 — Response travels back                          │
           │    GFE → Google backbone → GFE → browser                   │
           │                                                             │
           │  Step 7.2 — HTTP/2 Server Push (optional)                  │
           │    Server sends PUSH_PROMISE before browser asks:           │
           │    Push: /xjs/_/ss/k=...(critical CSS)                      │
           │    Push: /images/branding/googleg/...(logo)                 │
           │                                                             │
           │  Step 7.3 — DATA frames received                           │
           │    Browser receives: HTTP/2 HEADERS frame (200 OK)         │
           │    Then: DATA frames (14KB compressed body, multiple chunks)│
           │    Decompresses: 14KB → 85KB HTML                          │
           └─────────────────────────────────────────────────────────────┘
                          │
                          ▼
           ┌─────────────────────────────────────────────────────────────┐
           │  PHASE 8: BROWSER RENDERING                                 │
           │                                                             │
           │  Step 8.1 — HTML Parsing (streaming)                       │
           │    Tokenizer → DOM tree construction (top-down)            │
           │    Encounters <link rel="stylesheet"> → fetch CSS (async)  │
           │    Encounters <script> (deferred) → fetch JS, DON'T block  │
           │                                                             │
           │  Step 8.2 — CSS Processing                                 │
           │    Critical CSS: inlined in <head> (no network round trip) │
           │    External CSS: fetched, parsed → CSSOM tree              │
           │    RENDER BLOCKING: rendering waits for all CSS            │
           │    (Google inlines critical CSS → immediate unblocked paint)│
           │                                                             │
           │  Step 8.3 — Render Tree Construction                       │
           │    DOM + CSSOM merge → Render Tree (visible nodes only)    │
           │    Nodes with display:none excluded                        │
           │                                                             │
           │  Step 8.4 — Layout (Reflow)                                │
           │    Calculate exact position + size of every visible element│
           │    Box model: content + padding + border + margin          │
           │    Flexbox/Grid: complex relative calculations              │
           │                                                             │
           │  Step 8.5 — Paint                                          │
           │    Rasterize: text, borders, shadows drawn as pixels       │
           │    Separate layers for animated elements (GPU optimization)│
           │                                                             │
           │  Step 8.6 — Composite                                      │
           │    GPU combines layers in correct order                    │
           │    Frame pushed to display buffer: USER SEES THE PAGE       │
           │                                                             │
           │  Step 8.7 — JavaScript Execution (deferred)                │
           │    Download complete → V8 engine parses JS                 │
           │    JIT compilation (Just-In-Time): hot code paths compiled  │
           │    Event listeners attached: click, submit, scroll          │
           │    PAGE IS NOW FULLY INTERACTIVE                            │
           └─────────────────────────────────────────────────────────────┘
                          │
                          ▼
                   [USER CAN USE GOOGLE]
```

---

## Connection to Previous Topics

This section is the capstone — every concept we've studied appears here:

| What you learned           | Where it appears in This Flow                                       |
| -------------------------- | ------------------------------------------------------------------- |
| DNS                        | Phase 1: A/AAAA resolution, recursive queries, TTL                  |
| TCP                        | Phase 2: 3-way handshake, slow start, RTT impact                    |
| TLS/SSL                    | Phase 3: Full TLS 1.3 handshake, cipher suites                      |
| HTTP                       | Phase 4 & 7: GET request, HTTP/2 multiplexing, headers              |
| Latency vs Throughput      | Every phase: RTT per phase, bandwidth for download                  |
| RTT                        | TCP (1), TLS (1), HTTP (1) = 3+ RTTs minimum, each measured in ping |
| CDN                        | Transit: Google GFE edge PoPs serve TLS termination, caching        |
| Load Balancing             | Server: Maglev LB routes to healthy backend                         |
| Caching                    | Server: Memcache avoids DB; Browser: DNS cache, response cache      |
| Auth/Security              | Server: Cookie → session verification; TLS → encrypted channel      |
| CORS                       | Not applicable to first-party request; relevant for sub-resources   |
| Request-Response Lifecycle | This entire document IS the lifecycle in exhaustive detail          |

---

## File Summary

This file covered:

- The 8 phases explained for a 12-year-old with restaurant and emergency dispatch analogies
- DNS: full resolution walk (browser cache → OS → recursive → root → TLD → authoritative), first lookup 20-200ms, cached 0-2ms
- TCP: 3-way handshake, 1 RTT, slow start, connection reuse eliminates overhead for repeat requests
- TLS 1.3: 1 RTT, certificate verification steps, session resumption = 0 RTT, AES-256-GCM encryption
- HTTP/2: ALPN negotiation, HPACK header compression, multiplexed streams, SETTINGS frames
- Transit: 7 hops, Google's peering/private backbone, GFE edge termination
- Server processing: Maglev LB → GWS → Memcache → Bigtable/Spanner → Brotli compression
- HTTP/2 response: Server Push for critical resources, DATA frames
- Browser rendering: HTML parsing → CSSOM → Render Tree → Layout → Paint → Composite → JS execution
- Full ASCII flow diagram covering all 8 phases with decision points
- Timing table: DNS+TCP+TLS+HTTP+Transit+Server+Download+Render totaling ~280ms to first paint

**Continue to File 02** for how Google vs Amazon vs Netflix differ in their web stack, AWS full stack walkthrough, system design patterns, and interview Q&As.
