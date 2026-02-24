# HTTP Headers — Part 1 of 3

### Topic: HTTP Headers — Fundamentals, Structure, and Core Reference

**Series:** Networking Fundamentals → System Design → AWS Solutions Architect
**Sections Covered:** 1, 2, 3, 4

---

## SECTION 1 — ELI12: What Are HTTP Headers?

### Analogy 1 — The Envelope and Letter

When you mail a physical letter, the content goes INSIDE the envelope. But the outside of the envelope carries everything the postal system needs to do its job:

- Destination address
- Return address
- Postage stamps (proof of payment)
- "Fragile" sticker (handling instructions)
- Certified mail number (tracking)
- "Airmail" marking (delivery priority)

None of that information is the actual letter. But without it, the postal system doesn't know how to deliver the letter, how to handle it, or what to do if delivery fails.

HTTP headers are exactly this — the envelope information. The letter body (HTML, JSON, image data) is the payload. Headers carry everything the server and client need to correctly deliver, interpret, handle, and cache that payload.

```
┌─────────────────────────────────────────────────────┐
│  ENVELOPE (HTTP Headers)                            │
│                                                     │
│  To: api.shop.com (Host)                            │
│  From: Chrome/120 on Mac (User-Agent)               │
│  Language: English preferred (Accept-Language)      │
│  Format: I speak JSON (Accept, Content-Type)        │
│  Auth: My badge number (Authorization)              │
│  Handling: Use HTTPS only (Strict-Transport-Security│
│                                                     │
│  ┌───────────────────────────────────────────────┐  │
│  │  LETTER (HTTP Body)                           │  │
│  │                                               │  │
│  │  {"product_id": 42, "quantity": 1}            │  │
│  │                                               │  │
│  └───────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

### Analogy 2 — The Package Manifest on a Shipping Container

A cargo ship carries thousands of containers. On the outside of each container is a manifest:

- What's inside (Content-Type)
- How many kilograms (Content-Length)
- How it was packed (Content-Encoding)
- What language the documentation is in (Content-Language)
- Don't open until destination (Cache-Control)
- Handle with care — affects caching (Vary)

The manifest doesn't change what's in the container. But it's what customs, workers, and robots use to make decisions about the container without opening it.

Your CDN (like CloudFront) reads only HTTP headers — it never parses the body — to decide whether to cache, compress, or forward. `Cache-Control: max-age=3600, public` tells CloudFront to cache. `Cache-Control: no-store` tells it to never cache. Same body, completely different behavior, all from headers.

### What makes headers special:

1. **Order doesn't matter** (mostly): `Content-Type` on line 1 or line 20 has same effect
2. **Case-insensitive** (by spec): `Content-Type` = `content-type` = `CONTENT-TYPE` — in HTTP/2, all headers are lowercased by protocol
3. **Can be repeated**: multiple `Set-Cookie` headers are all processed; multiple `Accept` values can be comma-separated
4. **Header content is text**: even numbers are text strings (`Content-Length: 1024` not a binary int)
5. **Custom headers use X- prefix** (historically; RFC 6648 deprecated this in 2012 but pattern persists): `X-Request-ID`, `X-Correlation-ID`

---

## SECTION 2 — Core Technical Deep Dive

### HTTP Header Anatomy

Every HTTP header follows the same format:

```
Header-Name: Header-Value\r\n
```

The `:` (colon) separates name from value. The `\r\n` (CRLF) terminates each header. A blank line (`\r\n`) signals the end of headers and the start of the body.

```
POST /orders HTTP/1.1\r\n
Host: api.shop.com\r\n
Content-Type: application/json\r\n
Content-Length: 34\r\n
Authorization: Bearer eyJhbGci...\r\n
Accept: application/json\r\n
Accept-Encoding: gzip, deflate, br\r\n
User-Agent: ShopApp/2.1 iOS/17.0\r\n
\r\n                               ← END OF HEADERS
{"product_id": 42, "quantity": 1}  ← BODY STARTS HERE
```

### Request Headers

Headers sent by the CLIENT to the SERVER:

**Content Negotiation Headers (client tells server what it can handle):**

```
Accept: application/json, text/html;q=0.9, */*;q=0.8
  → "I prefer JSON, will accept HTML, will accept anything else"
  → q=quality factor: 1.0=most preferred, 0.1=least preferred, 0=refuse

Accept-Encoding: gzip, deflate, br, zstd
  → "I can decompress these algorithms"
  → Server picks best it supports; responds with Content-Encoding header

Accept-Language: en-US,en;q=0.9,hi;q=0.7
  → "I prefer US English, fallback to any English, then Hindi"
  → Server uses for i18n (internationalization) of responses

Accept-Charset: utf-8, iso-8859-1;q=0.7
  → "I prefer UTF-8" (mostly irrelevant now; UTF-8 is the default)
```

**Authentication Headers:**

```
Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...
  → JWT or OAuth 2.0 token in Bearer scheme

Authorization: Basic dXNlcjpwYXNz
  → Username:password base64-encoded (INSECURE over HTTP, only use with HTTPS)

Authorization: AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20240101/us-east-1/s3/aws4_request...
  → AWS Signature Version 4 for direct AWS API calls

API-Key: sk_test_EXAMPLE123456789abcdefghijklmn
  → Custom header for API key auth (use X-API-Key by convention)
```

**Caching Hint Headers:**

```
If-None-Match: "33a64df551425fcc55e4d42a148795d9f25f89d4"
  → "Send me the resource ONLY IF its ETag has changed from this value"
  → Server returns 304 Not Modified (with no body) if ETag matches

If-Modified-Since: Mon, 23 Feb 2026 10:00:00 GMT
  → "Send me the resource ONLY IF it changed after this date"
  → Server returns 304 if Last-Modified is before this date

Cache-Control: no-cache
  → "Check if this is still fresh before using cached copy"
  → (Does NOT mean "don't cache" — that's no-store)
```

**Context Headers:**

```
Host: api.shop.com
  → MANDATORY in HTTP/1.1. Enables virtual hosting (multiple domains on one IP)
  → HTTP/2: equivalent is :authority pseudo-header

Origin: https://shop.com
  → Sent in fetch requests; enables CORS. Different from Referer: Referer includes path

Referer: https://shop.com/products/shirt
  → Where the user came from (misspelling in HTTP spec, forever incorrect)
  → Used for analytics and Referer-Policy enforcement

User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/537.36...
  → String identifying browser/client. Used for analytics; avoid user-agent sniffing for feature detection

Request-Id: 7f3d9a12-4c6e-4a8b-9b3c-1234567890ab
X-Correlation-ID: 7f3d9a12-4c6e-4a8b-9b3c-1234567890ab
  → Unique identifier for distributed tracing; propagate through all service calls
```

### Response Headers

Headers sent by the SERVER to the CLIENT:

**Content Metadata:**

```
Content-Type: application/json; charset=utf-8
  → MIME type of body + character encoding
  → Common types: text/html, application/json, image/webp, application/pdf

Content-Length: 1234
  → Exact byte count of body
  → Required when body present and not using chunked encoding

Content-Encoding: gzip
  → Compression applied to body (client must decompress using Accept-Encoding match)

Content-Language: en-US

Content-Disposition: attachment; filename="report.pdf"
  → Tell browser to download (attachment) instead of display inline

Transfer-Encoding: chunked
  → Body is sent in chunks (Content-Length unknown at time of response start)
```

**Caching Response Headers:**

```
Cache-Control: max-age=3600, public
  → Cache for 3600 seconds; public CDNs can cache this

Cache-Control: no-store
  → Never cache (bank statements, auth pages)

ETag: "33a64df551425fcc55e4d42a148795d9f25f89d4"
  → Hash/version of resource. Client sends in If-None-Match on next request.

Last-Modified: Mon, 23 Feb 2026 10:00:00 GMT
  → When resource last changed. Client sends in If-Modified-Since.

Vary: Accept-Encoding, Accept-Language
  → "My response differs based on these request headers"
  → CDNs MUST store separate cache entry per variation of these headers
  → Vary: * means response is unique per request (effectively disables CDN caching)
```

**Auth Response Headers:**

```
WWW-Authenticate: Bearer realm="api.shop.com"
  → REQUIRED with 401 response; tells client how to authenticate

Set-Cookie: session_id=abc123; HttpOnly; Secure; SameSite=Strict; Max-Age=86400
  → Sets a cookie on the client; HttpOnly = no JavaScript access

Location: /orders/789
  → Used with 201 (new resource URL) and 3xx redirects (destination URL)
```

**Security Response Headers:**

```
Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
  → Tells browser: always use HTTPS for this domain for the next year

Content-Security-Policy: default-src 'self'; img-src *; script-src 'self' cdn.shop.com
  → Restricts which origins can load scripts, images, fonts, etc.

X-Frame-Options: DENY
  → Prevent this page from being loaded in an iframe (clickjacking defense)

X-Content-Type-Options: nosniff
  → Prevent browser from guessing MIME type (force use of Content-Type header)

Referrer-Policy: strict-origin-when-cross-origin
  → What URL to send in Referer header on navigation
```

---

## SECTION 3 — ASCII Diagram

### Request + Response Header Flow

```
CLIENT                                         SERVER
  │                                              │
  │  POST /orders HTTP/1.1                       │
  │  Host: api.shop.com           ← Required     │
  │  Authorization: Bearer eyJ... ← Who I am     │
  │  Content-Type: application/json ← Body type  │
  │  Content-Length: 34           ← Body size     │
  │  Accept: application/json     ← Want JSON     │
  │  Accept-Encoding: gzip, br    ← Can inflate   │
  │  User-Agent: ShopApp/2.1      ← Client info   │
  │  X-Request-ID: uuid-here      ← For tracing   │
  │  [blank line]                                 │
  │  {"product_id": 42, "qty": 1} ← BODY         │
  │ ─────────────────────────────────────────► │  │
  │                                              │  Parse headers
  │                                              │  Verify auth
  │                                              │  Route by path
  │                                              │  Process
  │                                              │
  │  HTTP/1.1 201 Created                        │
  │  Location: /orders/789        ← New URL      │
  │  Content-Type: application/json; charset=utf-8
  │  Content-Length: 52           ← Body size     │
  │  Cache-Control: no-store      ← No caching    │
  │  ETag: "abc123def456"         ← Resource hash │
  │  Set-Cookie: cart=cleared;HttpOnly;Secure     │
  │  X-Request-ID: uuid-here      ← Echo back     │
  │  [blank line]                                 │
  │  {"orderId": 789, "status": "confirmed"}      │
  │ ◄─────────────────────────────────────────   │
  │                                              │
```

### Conditional GET with ETag (Caching Flow)

```
FIRST REQUEST:                    SECOND REQUEST (re-validation):
Client                Server       Client                Server
  │                     │            │                     │
  │  GET /logo.png      │            │  GET /logo.png      │
  │  (no cache headers) │            │  If-None-Match:     │
  │ ──────────────────► │            │  "abc123"           │
  │                     │            │ ──────────────────► │
  │  200 OK             │            │                     │  ETag still
  │  Content-Length:8KB │            │                     │  "abc123"?
  │  ETag: "abc123"     │            │                     │  Yes → same
  │  Cache-Control:     │            │  304 Not Modified   │
  │  max-age=3600       │            │  (ZERO BODY BYTES)  │
  │ ◄────────────────── │            │ ◄────────────────── │
  │                     │            │                     │
  Cache logo for 3600s               Use cached copy
  Store ETag: "abc123"               Bandwidth saved: 8KB
```

### Content Negotiation Flow

```
Client sends:
  Accept: application/json, text/html;q=0.9

Server logic:
  I can serve: application/json ← matches first preference (q=1.0)
              text/html         ← could serve (q=0.9)

  Serve: application/json

Response:
  Content-Type: application/json; charset=utf-8
  Vary: Accept                          ← Cache must bucket by Accept header
```

### Security Headers in Browser Defense

```
                   BROWSER
                      │
                      ▼
          ┌───────────────────────┐
          │ HTML page loads       │
          │ → Script tag appears  │
          │ → Check CSP:          │
          │   script-src 'self'   │
          │   cdn.shop.com        │
          └───────────────────────┘
                 │           │
         Allowed?            Blocked?
          ↙                     ↘
  cdn.shop.com               evil.com/steal.js
  (in CSP list)              (not in CSP list)
  Download OK                Browser blocks silently
                             Console: CSP violation
                             Report-URI: notify server
```

---

## SECTION 4 — Step-by-Step Flows

### Flow 1 — ETag Cache Validation

A client visits your website twice. Second visit should use cached data when unchanged:

```
Step 1: First GET request
  Client → GET /products/42 HTTP/1.1
           Host: api.shop.com

Step 2: Server responds with ETag
  Server → 200 OK
           Content-Type: application/json
           Cache-Control: max-age=300, public
           ETag: "sha256-AbCdEfGh12345678"
           Last-Modified: Mon, 23 Feb 2026 10:00:00 GMT
           Body: {"id": 42, "name": "Blue Shirt", "price": 29.99, "inventory": 50}

  Client: Caches response body + ETag + Last-Modified

Step 3: 5 minutes later, max-age expires. Client re-validates:
  Client → GET /products/42 HTTP/1.1
           Host: api.shop.com
           If-None-Match: "sha256-AbCdEfGh12345678"
           If-Modified-Since: Mon, 23 Feb 2026 10:00:00 GMT

Step 4a: Resource UNCHANGED on server
  Server → 304 Not Modified
           ETag: "sha256-AbCdEfGh12345678"
           Cache-Control: max-age=300, public
           (NO BODY — zero bytes transferred)

  Client: Uses cached body (saved bandwidth + time)

Step 4b: Resource CHANGED on server (inventory now 49)
  Server → 200 OK
           Content-Type: application/json
           Cache-Control: max-age=300, public
           ETag: "sha256-XyZaBcDe98765432"  ← NEW ETag
           Body: {"id": 42, "name": "Blue Shirt", "price": 29.99, "inventory": 49}

  Client: Replaces cache with new content + new ETag
```

### Flow 2 — CORS Preflight with Headers

Cross-origin requests require browsers to send a preflight to check server permissions:

```
Step 1: JavaScript on shop.com calls API on api.shop.com
  React app: fetch('https://api.shop.com/orders', {method:'POST', body:...})

Step 2: Browser auto-generates OPTIONS preflight
  Browser → OPTIONS /orders HTTP/1.1
            Host: api.shop.com
            Origin: https://shop.com
            Access-Control-Request-Method: POST
            Access-Control-Request-Headers: Content-Type, Authorization

Step 3: Server responds with CORS permission headers
  Server → 204 No Content
            Access-Control-Allow-Origin: https://shop.com
            Access-Control-Allow-Methods: GET, POST, PUT, DELETE
            Access-Control-Allow-Headers: Content-Type, Authorization
            Access-Control-Max-Age: 86400     ← Cache preflight for 24 hours
            Access-Control-Allow-Credentials: true

Step 4: Browser allows the actual POST request
  Browser → POST /orders HTTP/1.1
            Host: api.shop.com
            Origin: https://shop.com
            Authorization: Bearer eyJ...
            Content-Type: application/json
            Body: {"product_id": 42, "quantity": 1}

Step 5: Server responds with actual data
  Server → 201 Created
            Access-Control-Allow-Origin: https://shop.com
            Access-Control-Expose-Headers: Location, X-Request-ID
            Location: /orders/789

  Note: Access-Control-Allow-Origin must be present on EVERY CORS response,
        not just the preflight. Missing it on the 201 = CORS error even after
        successful preflight.
```

### Flow 3 — Security Headers Protecting a Production App

```
Step 1: Browser requests your app (first visit, HTTP)
  Browser → GET http://shop.com/ HTTP/1.1

Step 2: Server responds with HSTS redirect
  Server → 301 Moved Permanently
            Location: https://shop.com/
            Strict-Transport-Security: max-age=31536000; includeSubDomains

Step 3: Browser follows HTTPS redirect, server sends page with all security headers
  Server → 200 OK (HTTPS only)
            Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
            Content-Security-Policy: default-src 'self';
                                     script-src 'self' https://cdn.shop.com;
                                     img-src * data:;
                                     font-src 'self' https://fonts.gstatic.com;
                                     connect-src 'self' https://api.shop.com
            X-Frame-Options: DENY
            X-Content-Type-Options: nosniff
            Referrer-Policy: strict-origin-when-cross-origin
            Permissions-Policy: camera=(), microphone=(), geolocation=(self)

Step 4: Browser enforces each security header
  HSTS: Browser will automatically upgrade all future http:// requests to https://
        (even typed directly in address bar — no round-trip to server)
  CSP: Any <script src="https://evil.com/tracker.js"> blocked at browser level
       Injected scripts (XSS payload) from outside allowed origins blocked
  X-Frame-Options DENY: Page cannot be embedded in <iframe> on any site
        (clickjacking: attacker overlays invisible iframe over fake "click here" button)
  nosniff: Browser ignores what it thinks the file is; trusts Content-Type header
        Prevents: serving a .jpg that contains JavaScript, browser executing it
```

---

## File Summary

This file covered:

- Envelope + shipping manifest analogies (headers = metadata, body = content)
- Headers are text key-value pairs, case-insensitive, terminated by blank CRLF line
- Request headers: Accept (negotiation), Authorization (identity), If-None-Match/If-Modified-Since (caching), Host (mandatory virtual hosting), Origin (CORS), User-Agent, X-Correlation-ID
- Response headers: Content-Type/Length/Encoding (payload description), Cache-Control/ETag/Last-Modified/Vary (caching), WWW-Authenticate/Set-Cookie/Location (auth/state), security headers (HSTS, CSP, X-Frame-Options, nosniff, Referrer-Policy)
- ASCII diagrams: request/response header flow, ETag conditional GET, content negotiation, CSP browser enforcement
- Step-by-step ETag re-validation (saves 304 with zero body), CORS preflight (Access-Control-Allow-Origin required on ALL responses), security headers (HSTS browser upgrade, CSP XSS defense, clickjacking protection)

**Continue to File 02** for real-world analogies, system design architecture patterns, AWS mapping, and 8 Q&As.
