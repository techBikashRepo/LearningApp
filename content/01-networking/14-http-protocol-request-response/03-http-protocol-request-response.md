# HTTP Protocol (Request/Response) — Part 3 of 3

### Topic: Certification Focus, Tables, Revision, and Architect Exercise

**Series:** Networking Fundamentals → System Design → AWS Solutions Architect
**Audience:** 14-Year Experienced Full-Stack Developer → Becoming an Architect
**Sections Covered:** 9, 10, 11, 12

---

## SECTION 9 — AWS SAA Certification Focus

### Exam-Critical Facts

**ALB vs NLB protocol support:**

- ALB = Layer 7 HTTP/HTTPS/gRPC only. Cannot pass raw TCP or UDP.
- NLB = Layer 4 TCP/UDP/TLS. No HTTP awareness.
- **Exam trap:** "IoT devices send telemetry over UDP" → ALB cannot handle UDP → use NLB.
- **Exam trap:** "Application needs WebSocket support" → ALB supports WebSocket. NLB also works. Both are valid but ALB preferred (HTTP-aware, idle timeout configurable).

**ALB idle connection timeout:**

- Default: 60 seconds
- Range: 1 to 4,000 seconds
- **Exam trap:** "WebSocket connections drop after 60 seconds with ALB" → increase ALB idle timeout via `Connection Settings` to cover expected WebSocket session duration.
- Application server keep-alive MUST be set higher than ALB idle timeout (e.g., 75s) to avoid connection race condition.

**CloudFront and HTTP caching:**

- CloudFront default cache: TTL 24 hours if no `Cache-Control` header
- `Cache-Control: no-store` → CloudFront does NOT cache
- `Cache-Control: max-age=0` → CloudFront caches but ALWAYS revalidates (conditional GET)
- Vary header: `Vary: Accept-Encoding` → CloudFront caches separate copies for gzip vs non-gzip
- **Exam trap:** "Users see stale content after a deployment" → CloudFront cached old files → use versioned filenames (`app.v2.js`) OR invalidate CloudFront (`/static/*` invalidation costs $0.005 per path).

**HTTP to HTTPS redirect:**

- ALB: Listener Rule — Action = Redirect → HTTP 301 to HTTPS (no backend hit)
- CloudFront: configure "Redirect HTTP to HTTPS" viewer protocol policy
- API Gateway: HTTP APIs enforce HTTPS automatically
- **Exam trap:** "User enters http:// URL, gets 200 over HTTP (not redirected)" → ALB HTTP listener lacks redirect rule → add redirect action.

**API Gateway timeout limits:**

- HTTP API: 30 seconds maximum integration timeout (total Lambda/HTTP integration time)
- REST API: 29 seconds maximum
- **Exam trap:** "Long-running report generation fails after 29 seconds" → API Gateway timeout → decouple with SQS + async pattern (return 202 Accepted, poll for result).

**X-Forwarded-For header (and client IP in logs):**

- ALB adds `X-Forwarded-For: {client-ip}` header to every request
- Backend sees ALB's IP as source IP (TCP connection source)
- To get real client IP: read `X-Forwarded-For` header in application
- NLB: does NOT modify headers; backend sees actual client IP (IP passthrough)
- **Exam trap:** "Need backend to rate-limit by client IP" → ALB: must read X-Forwarded-For; NLB: native client IP passthrough.

### Potential Exam Trap Summary

| Trap                                  | Wrong Assumption          | Correct Answer                                           |
| ------------------------------------- | ------------------------- | -------------------------------------------------------- |
| WebSocket drops at 60s                | Application bug           | ALB idle timeout = 60s → increase it                     |
| Stale CloudFront content after deploy | CloudFront auto-refreshes | Need versioned filenames OR CloudFront invalidation      |
| ALB access logs have ALB IP as client | X-Forwarded-For not set   | ALB sets X-Forwarded-For; read it in app                 |
| API times out at 29s                  | Lambda too slow           | API Gateway hard 29s limit → async SQS pattern           |
| HTTP/2 needed → use NLB               | NLB supports HTTP/2       | NLB is pass-through TCP; HTTP/2 framing invisible to NLB |
| ALB + UDP required                    | ALB handles all protocols | ALB = HTTP only; UDP → NLB                               |
| CloudFront ignores Cache-Control      | CloudFront overrides      | CloudFront respects Cache-Control; use it correctly      |

---

## SECTION 10 — Comparison Tables

### Table 1 — HTTP/1.1 vs HTTP/2 vs HTTP/3

| Property                 | HTTP/1.1                                          | HTTP/2                          | HTTP/3                           |
| ------------------------ | ------------------------------------------------- | ------------------------------- | -------------------------------- |
| **Year**                 | 1997                                              | 2015                            | 2022                             |
| **Format**               | Text (ASCII)                                      | Binary frames                   | Binary frames (QUIC)             |
| **Transport**            | TCP                                               | TCP (TLS in practice)           | QUIC (UDP)                       |
| **Multiplexing**         | No (1 req per connection, or pipelining with HOL) | Yes (multiple streams, 1 TCP)   | Yes (independent streams, QUIC)  |
| **HOL blocking**         | HTTP-level AND TCP-level                          | TCP-level only (HTTP HOL fixed) | None (QUIC per-stream)           |
| **Header compression**   | None                                              | HPACK (table-based)             | QPACK (similar, reordering-safe) |
| **Server push**          | No                                                | Yes (largely deprecated)        | No (removed from spec)           |
| **Connection setup**     | TCP + TLS separate                                | TCP + TLS separate              | Always encrypted, 1-RTT or 0-RTT |
| **Connection migration** | No                                                | No                              | Yes (QUIC connection IDs)        |
| **AWS ALB support**      | Yes                                               | Yes (ALB ↔ client)              | No (as of 2026)                  |

### Table 2 — HTTP Request Methods (Preview — detailed in Topic 15)

| Method  | Purpose                                   | Has Body | Idempotent | Safe |
| ------- | ----------------------------------------- | -------- | ---------- | ---- |
| GET     | Retrieve resource                         | No       | Yes        | Yes  |
| POST    | Create resource / submit data             | Yes      | No         | No   |
| PUT     | Replace resource entirely                 | Yes      | Yes        | No   |
| PATCH   | Partial update                            | Yes      | No         | No   |
| DELETE  | Remove resource                           | Optional | Yes        | No   |
| HEAD    | Like GET but no body (metadata only)      | No       | Yes        | Yes  |
| OPTIONS | Discover allowed methods (CORS preflight) | No       | Yes        | Yes  |

### Table 3 — ALB vs NLB vs CloudFront for HTTP Traffic

| Property            | ALB                      | NLB                   | CloudFront                |
| ------------------- | ------------------------ | --------------------- | ------------------------- |
| **OSI Layer**       | 7 (HTTP)                 | 4 (TCP/UDP)           | 7 (HTTP/CDN)              |
| **HTTP routing**    | Yes (path, header, host) | No (TCP only)         | Yes (path, host)          |
| **TLS termination** | Yes                      | Yes (optional)        | Yes                       |
| **HTTP/2 support**  | Yes (client-facing)      | Pass-through          | Yes                       |
| **gRPC**            | Yes                      | Pass-through          | No                        |
| **Idle timeout**    | 60s (default)            | 350s (TCP)            | 60s (origin)              |
| **Client IP**       | X-Forwarded-For header   | Native IP passthrough | CloudFront-Viewer-Address |
| **Cost model**      | Per LCU                  | Per LCU               | Per request + transfer    |
| **WebSocket**       | Yes                      | Yes                   | Yes                       |
| **Cache**           | No                       | No                    | Yes                       |

### Table 4 — HTTP Connection Lifecycle States

| State                 | Description                                 | Client / Server Side | Timeout                 |
| --------------------- | ------------------------------------------- | -------------------- | ----------------------- |
| **CONNECTING**        | TCP + TLS in progress                       | Both                 | Varies by OS            |
| **IDLE (keep-alive)** | Connected, no active request                | Both                 | ALB: 60s; NGINX: 75s    |
| **ACTIVE**            | Request in flight                           | Both                 | Application/ALB timeout |
| **HALF-CLOSED**       | Server sent FIN; waiting for client FIN     | Server-side          | TIME_WAIT               |
| **CLOSED**            | All data exchanged, 4-way teardown complete | Both                 | —                       |
| **TIME_WAIT**         | Local socket holding last FIN info          | Client-side          | 2×MSL (~60s)            |

### Table 5 — HTTP Caching Headers Quick Reference

| Header                        | Direction | Example                      | Effect                                     |
| ----------------------------- | --------- | ---------------------------- | ------------------------------------------ |
| `Cache-Control: max-age=3600` | Response  | Server → Client & CloudFront | Cache for 3600 seconds                     |
| `Cache-Control: no-cache`     | Response  | Server → Client              | Must revalidate before using cache         |
| `Cache-Control: no-store`     | Response  | Server → Client              | Never cache (PII, auth pages)              |
| `Cache-Control: private`      | Response  | Server → Client              | Only browser can cache; NOT CDN            |
| `Cache-Control: public`       | Response  | Server → Client              | CDN and browser can cache                  |
| `ETag: "abc123"`              | Response  | Server → Client              | Version token for conditional GET          |
| `If-None-Match: "abc123"`     | Request   | Client → Server              | Conditional GET (returns 304 if unchanged) |
| `Last-Modified`               | Response  | Server → Client              | Timestamp for conditional GET              |
| `If-Modified-Since`           | Request   | Client → Server              | Conditional GET by date                    |
| `Vary: Accept-Encoding`       | Response  | Server → CDN                 | Cache separate copies per encoding         |

---

## SECTION 11 — Quick Revision and Memory Tricks

### 10 Key Points — HTTP Protocol

1. **HTTP = application-layer, stateless, request-response protocol over TCP.** Format: method + URI + headers + body.
2. **`Host` header is mandatory in HTTP/1.1.** Without it: virtual hosting breaks (one IP, many domains).
3. **HTTP/1.1 persistent connections** (keep-alive): default. Eliminates per-request TCP + TLS overhead.
4. **HTTP/2 = binary + multiplexed streams + HPACK.** Solves HTTP-level HOL blocking; TCP HOL blocking remains.
5. **HTTP/3 = QUIC (UDP) + per-stream reliability.** Solves TCP HOL blocking; connection migration; 0-RTT.
6. **Chunked transfer encoding** allows streaming responses when size is unknown upfront.
7. **ALB idle timeout = 60 seconds** (default). Application keep-alive must exceed this to avoid race conditions.
8. **HPACK prevents CRIME attack** (old DEFLATE compression on secrets revealed by size analysis).
9. **NGINX reverse proxy buffers** requests + responses: decouples fast backends from slow internet clients.
10. **API Gateway max timeout = 29-30 seconds.** Long ops → decouple with SQS + async Lambda.

### 30-Second Explanation

> "HTTP is a text-based request-response protocol where clients send a method, URI, headers, and optional body, and servers return a status code, headers, and body. HTTP is stateless — every request is independent. HTTP/1.1 added persistent connections (keep-alive) to avoid reconnecting for every resource. HTTP/2 went binary, added multiplexing and header compression (HPACK), solving HTTP-level head-of-line blocking. HTTP/3 moved to QUIC over UDP, solving TCP-level HOL blocking as well.
>
> In AWS, ALB terminates HTTP at Layer 7, routes by URL/headers, and adds X-Forwarded-For. CloudFront caches HTTP responses at edge locations using Cache-Control headers. API Gateway has a hard 29-30 second timeout — long operations need async patterns."

### Mnemonics

**MUSH** — HTTP request structure order:

- **M** — Method (GET, POST, etc.)
- **U** — URI (the resource path)
- **S** — Status version (HTTP/1.1 or 2)
- **H** — Headers (Host, Accept, Content-Type...)

**SHREB** — HTTP/2 improvements over HTTP/1.1:

- **S** — Single connection (multiplexed streams)
- **H** — Header compression (HPACK)
- **R** — Remove text (binary framing)
- **E** — Eliminate HOL blocking at HTTP level
- **B** — Binary frames

**ALB idle 60, NLB idle 350:**

- "ALB is a **minute** man (60s)"
- "NLB is nearly **6 minutes** (350s)"

**HPACK vs CRIME:**

- HPACK = "Harriet PACKS smartly" (table-based, no compression on secrets)
- CRIME = "Compressing Reveals Intimate Message Everything" (old DEFLATE → side channel)

---

## SECTION 12 — Architect Thinking Exercise

### Scenario: Migrating a High-Traffic API from HTTP/1.1 to HTTP/2

**Background:**
You are the architect of a SaaS analytics platform. The API serves 200,000 requests/second during business hours. Currently:

- ALB → EC2 instances (c5.2xlarge, 20 instances)
- HTTP/1.1 between all components (built in 2018)
- Average request: 6 headers, 200-byte body
- Average response: 15 headers, 800-byte body
- Current P99 TTFB: 85ms
- Current bandwidth cost: $12,000/month (high egress on header data)

The team wants to migrate to HTTP/2 to reduce header overhead and improve performance.

**Stop here. Think:**

1. What exactly changes (and what doesn't) when ALB enables HTTP/2?
2. What header optimization opportunity does HTTP/2 open?
3. What risks does this migration carry?
4. What is the correct migration sequence?

---

_(Solution follows)_

---

### Solution

**What Actually Changes with HTTP/2:**

```
BEFORE (HTTP/1.1):
  Browser ←──── HTTP/1.1 text ──── ALB ←──── HTTP/1.1 text ──── EC2
  [6 parallel connections per browser]
  [each request: full header text, ~300 bytes per request]

AFTER (HTTP/2):
  Browser ←──── HTTP/2 binary ──── ALB ←──── HTTP/1.1 text ──── EC2
                                    ↑
              ALB upgrades client to HTTP/2 but STILL USES HTTP/1.1 to backends
              (HTTP/2 backend connections require explicit configuration)
```

Key insight: ALB supports HTTP/2 for clients, but by **default continues using HTTP/1.1 to backends**. The HTTP/2 multiplexing and HPACK compression happens between the browser and ALB only. The ALB-to-backend segment still uses HTTP/1.1 unless you opt into HTTP/2 (ALB target group attribute: `Protocol Version = HTTP/2`).

**Header Compression Benefit Calculation:**

```
Current HTTP/1.1 per request:
  Headers: 6 headers × ~50 bytes = ~300 bytes of headers
  At 200,000 req/sec: 300 × 200,000 = 60 MB/sec just in headers

With HTTP/2 HPACK (after first request, headers compressed ~90%):
  Compressed headers: ~30 bytes per request (1-byte indices for repeated values)
  At 200,000 req/sec: 30 × 200,000 = 6 MB/sec
  Saving: 54 MB/sec = ~4.5 TB/day = $4,500/month egress reduction (at $0.09/GB)
```

**Risks:**

1. **HTTP/2 single connection can mask application-level connection issues:** HTTP/1.1 has 6 connections per browser; HTTP/2 has 1. If that single connection has issues (HOL at TCP level), ALL streams block. Monitor TCP retransmit rates after migration.

2. **Server push complexity:** HTTP/2 server push is now deprecated in Chrome and Safari. Do not implement it. Use `<link rel=preload>` headers instead.

3. **HTTP/2 doesn't compress bodies** — only headers. If your bottleneck is response body size, HTTP/2 alone won't help. Use gzip/Brotli compression on bodies.

4. **gRPC dependencies:** HTTP/2 backend connections are required for gRPC. If any service uses gRPC behind ALB, it already needs HTTP/2 target group setting.

**Migration Sequence:**

```
Phase 0: Measurement (1 week)
  Enable ALB access logs → capture current P99, header sizes, connection patterns
  Baseline CloudWatch: NetworkIn/Out, request count, error rates

Phase 1: ALB → Client HTTP/2 (zero risk)
  ALB automatically negotiates HTTP/2 with supporting clients (via ALPN in TLS)
  No configuration change needed — ALB supports HTTP/2 by default if HTTPS listener
  Monitor: connection count should drop (browsers use 1 instead of 6)
  Expect: 5-15% P99 latency improvement from HPACK + multiplexing

Phase 2: ALB → Backend HTTP/2 (moderate risk, canary first)
  Update 2 of 20 target group instances to HTTP/2 protocol version
  Monitor: error rate, P99, connection pool behavior
  If stable after 24h: roll to all 20 instances

  Backend must support HTTP/2:
    Node.js: http2 module or node-http2 library
    Spring Boot: use Undertow or include tomcat-embed-core with http/2 support
    NGINX upstream: proxy_http_version 1.1; (default) → change to http2 not trivial

Phase 3: HPACK optimization
  Enable CloudFront in front of ALB for frequently repeated header caching

Phase 4: HTTP/3 consideration
  CloudFront supports HTTP/3 (QUIC) for browser → CloudFront connections (enable in distribution settings)
  CloudFront → ALB remains HTTP/2 (ALB doesn't support HTTP/3 as origin protocol)
  Benefit: mobile users on lossy networks get QUIC's HOL-blocking fix
```

**Expected Final State:**

```
Browser ←── HTTP/3 (QUIC) ──► CloudFront ←── HTTP/2 ──► ALB ←── HTTP/2 ──► EC2
              (mobile+lossy)          (persistent pool)       (persistent pool)

P99 improvement target: 85ms → 60ms (28% reduction)
Bandwidth cost reduction: $12,000 → $7,500/month
Connection count reduction: 6N → N (6:1 at browser layer)
```

---

**Next Topic →** Topic 15: HTTP Methods — the vocabulary of the web: GET, POST, PUT, PATCH, DELETE, idempotency, safety, REST conventions, CORS preflight with OPTIONS, and how AWS API Gateway and ALB route by HTTP method.
