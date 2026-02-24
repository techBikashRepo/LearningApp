# CORS — Part 1 of 3

### Topic: Cross-Origin Resource Sharing (CORS) — Concepts, Architecture, and Deep Dive

**Series:** Networking Fundamentals → System Design → AWS Solutions Architect
**Sections Covered:** 1, 2, 3, 4

---

## SECTION 1 — ELI12: Explain Like I'm 12

### What Is CORS?

Imagine you're at school (school.com) and you want to borrow supplies from another school across town (api.shop.com). The rule is: **you can only take supplies from your OWN school unless the other school explicitly says you're allowed to visit.**

Web browsers enforce a very similar rule called the **Same-Origin Policy**. By default, JavaScript running on `https://shop.com` cannot fetch data from `https://api.different.com`. The browser blocks it — not the server.

CORS (Cross-Origin Resource Sharing) is the mechanism that lets `api.different.com` say: "Yes, I allow JavaScript from `https://shop.com` to access my data." The server puts a note on its door (HTTP response headers) saying which origins are allowed in.

If the server doesn't put that note up, the browser refuses to share the response with the JavaScript — even if the network request technically succeeded.

Important: **CORS is enforced by the browser, not by the server or network.** Server-to-server calls have no CORS restriction. curl has no CORS restriction. Only browser JavaScript is subject to CORS.

---

### Analogy 1 — The Bouncer at the Club (Same-Origin Policy)

You're standing outside a club. The bouncer has a rule: **only people who arrived from the same neighborhood are allowed in this VIP section.** If you arrived from a different neighborhood (different origin), you need a SPECIAL PERMISSION SLIP from the club owner.

JavaScript on `https://shop.com` = You standing at the door  
Browser = The bouncer  
`https://api.shop.com` = The server (the club VIP section)  
CORS headers = The permission slip from the club owner

If the api.shop.com server doesn't send the right permission slip (CORS headers), the bouncer (browser) stops the JavaScript from seeing the response.

The attack this prevents: a malicious website (`https://evil.com`) running JavaScript that silently calls `https://your-bank.com/transfer-money` using YOUR browser cookies. Without Same-Origin Policy, every website you open could make authenticated requests to every other service in your browser session.

### Analogy 2 — The Visitor Badge System at a Corporate Office

A large company has multiple buildings: `headquarters.corp.com`, `research.corp.com`, `cafe.corp.com`.

By default: visitors can only freely walk into the building they entered through. If you entered through headquarters, you need a visitor badge issued by research to enter the research building.

A CORS preflight = The security guard at research calling headquarters to ask: "Is this visitor (browser at https://shop.com) allowed to come in, and which specific rooms (methods/headers) can they access?"

If headquarters says "Yes, they can enter rooms GET and POST, and they can carry a badge labeled Authorization" → the visitor can proceed.

If headquarters doesn't respond or says "No" → the visitor is turned away at the door, even if they physically walked into the lobby.

---

## SECTION 2 — Core Technical Deep Dive

### Origin Definition

An origin is the combination of **protocol + hostname + port**. ALL three must match for two URLs to be the "same origin":

```
Examples:

https://shop.com/cart   and   https://shop.com/api/orders
  → Same origin (same protocol, hostname, port)
  → No CORS restriction

https://shop.com   and   https://api.shop.com
  → DIFFERENT origin (different subdomain = different hostname)
  → CORS required

https://shop.com   and   http://shop.com
  → DIFFERENT origin (different protocol)
  → CORS required

https://shop.com   and   https://shop.com:8080
  → DIFFERENT origin (different port)
  → CORS required
```

### Simple vs Preflighted Requests

Not all cross-origin requests trigger a preflight. CORS has two modes:

**Simple Requests (no preflight):**
Request is sent directly. Browser adds `Origin` header. Server responds (optionally) with CORS headers. Browser checks headers and decides whether to expose response to JavaScript.

Conditions for a "simple" request:

- Method: GET, HEAD, or POST only
- Headers: Only standard simple headers (Accept, Accept-Language, Content-Language, Content-Type)
- Content-Type (for POST): only `application/x-www-form-urlencoded`, `multipart/form-data`, or `text/plain`

**Preflighted Requests:**
Browser first sends a "preflight" `OPTIONS` request to ASK the server whether the real request is allowed. Only if the server says yes does the real request proceed.

Triggered by ANY of:

- Methods other than GET/HEAD/POST (PUT, DELETE, PATCH)
- Custom headers (Authorization, X-Custom-Header, X-API-Key, Content-Type: application/json, etc.)
- Any non-simple header values

### The Preflight Exchange

```
Real request browser WANTS to make:
  DELETE https://api.shop.com/orders/123
  Headers: Authorization: Bearer xxx
  Origin: https://shop.com

Browser sends PREFLIGHT first:
  OPTIONS https://api.shop.com/orders/123
  Origin: https://shop.com
  Access-Control-Request-Method: DELETE
  Access-Control-Request-Headers: Authorization

Server responds to preflight:
  HTTP/1.1 204 No Content
  Access-Control-Allow-Origin: https://shop.com
  Access-Control-Allow-Methods: GET, POST, DELETE, PATCH
  Access-Control-Allow-Headers: Authorization, Content-Type
  Access-Control-Max-Age: 86400     ← cache preflight for 24 hours

Browser: "Preflight passed — the real request is allowed"

Browser sends the real request:
  DELETE https://api.shop.com/orders/123
  Authorization: Bearer xxx
  Origin: https://shop.com

Server responds:
  HTTP/1.1 200 OK
  Access-Control-Allow-Origin: https://shop.com
  { "deleted": true }

Browser: exposes response to JavaScript ✓
```

### Complete CORS Response Header Reference

```
Response headers (server → browser):

Access-Control-Allow-Origin: https://shop.com
  OR
Access-Control-Allow-Origin: *
  • Which origin is allowed. Wildcard * means any origin.
  • CANNOT be * if Access-Control-Allow-Credentials: true
    (browser rejects configuration: "wildcard origin + credentials")

Access-Control-Allow-Methods: GET, POST, PUT, DELETE, PATCH, OPTIONS
  • Comma-separated list of allowed HTTP methods
  • Only in preflight response

Access-Control-Allow-Headers: Authorization, Content-Type, X-Custom-Header
  • Headers the client is allowed to send
  • Must explicitly list all custom headers used in request
  • Only in preflight response

Access-Control-Expose-Headers: X-RateLimit-Remaining, X-Request-ID
  • Headers the browser will expose to JavaScript
  • By default, only simple response headers are accessible: Cache-Control, Content-Language,
    Content-Length, Content-Type, Expires, Last-Modified, Pragma
  • Any custom header you want JS to read must be in Expose-Headers

Access-Control-Allow-Credentials: true
  • Allow cookies, Authorization header to be sent with the request
  • Browser sends cookies ONLY if: this header is true AND request was made
    with credentials: 'include'
  • REQUIRES: Access-Control-Allow-Origin must be exact origin (not *)

Access-Control-Max-Age: 86400
  • How long preflight results can be cached by browser
  • Default varies by browser (5 seconds in Chrome, 600 seconds in Firefox)
  • Set to 86400 (24h) to avoid repeated preflight overhead
```

### Credentials and Cookies with CORS

This is one of the most misunderstood pieces of CORS:

```
Scenario: api.shop.com sets a session cookie after login.
The shop.com frontend needs to send that cookie on all API calls.

Browser's default: cross-origin requests do NOT include cookies or auth headers.
Even if api.shop.com sets a cookie → it won't be sent in the next cross-origin request.

To include credentials in a cross-origin request:

Fetch API:
  fetch("https://api.shop.com/orders", {
    credentials: "include"  ← This tells browser to send cookies
  })

Axios:
  axios.get("https://api.shop.com/orders", { withCredentials: true })

Server MUST respond with:
  Access-Control-Allow-Origin: https://shop.com  ← EXACT origin (no wildcard *)
  Access-Control-Allow-Credentials: true

If server uses *:
  Browser error: "The value of the 'Access-Control-Allow-Origin' header in the response
  must not be the wildcard '*' when the request's credentials mode is 'include'"
```

### Common CORS Misconfigurations

```
1. Reflecting the Origin header back blindly:
   BAD:
     const corsOrigin = req.headers.origin;
     res.setHeader("Access-Control-Allow-Origin", corsOrigin);  // ANY origin allowed!
   This is the same as *, but worse — it allows credentialed requests from any origin.
   Fix: Maintain an explicit allowlist, check against it.

2. Including the null origin:
   Origin: null is sent by:
     - Sandboxed iframes
     - Local files (file://)
     - data: URLs
   BAD: Access-Control-Allow-Origin: null
   This allows sandboxed attacker iframes on any site to make credentialed requests.

3. Trusting *.attacker.com:
   BAD regex: /^https?:\/\/.*\.shop\.com$/
   This matches: https://evil.shop.com → attacker registers evil.shop.com → bypasses CORS
   Fix: Use exact match against an allowlist, not regex.

4. CORS not the same as authentication:
   Misconception: "CORS protects our API from unauthorized access"
   Reality: CORS prevents browser JavaScript from READING responses.
   Server-to-server calls (Postman, curl, any non-browser tool): COMPLETELY UNAFFECTED by CORS
   CORS is about browser privacy, not API security.
   Real security: API keys, JWTs, OAuth, rate limiting — these are independent of CORS.
```

---

## SECTION 3 — ASCII Diagram

### CORS Preflight Flow

```
 https://shop.com (frontend)              https://api.shop.com (backend)
         │                                          │
         │ User clicks "Delete Order"               │
         │ JS: fetch(DELETE /orders/123, {          │
         │       headers: {Authorization: "..."}   │
         │     })                                   │
         │                                          │
         │──── OPTIONS /orders/123 ────────────────►│  PREFLIGHT
         │     Origin: https://shop.com             │
         │     Access-Control-Request-Method: DELETE│
         │     Access-Control-Request-Headers:      │
         │       Authorization                      │
         │                                          │
         │         [Server checks CORS policy]      │
         │         "https://shop.com is in my list" │
         │         "DELETE is allowed"              │
         │         "Authorization header is allowed"│
         │                                          │
         │◄─── 204 No Content ─────────────────────│  PREFLIGHT RESPONSE
         │     Access-Control-Allow-Origin:         │
         │       https://shop.com                   │
         │     Access-Control-Allow-Methods:        │
         │       GET, POST, DELETE, PATCH           │
         │     Access-Control-Allow-Headers:        │
         │       Authorization, Content-Type        │
         │     Access-Control-Max-Age: 86400        │
         │                                          │
         │ Browser: ✓ Preflight passed              │
         │ Browser stores result for 24h            │
         │                                          │
         │──── DELETE /orders/123 ─────────────────►│  ACTUAL REQUEST
         │     Origin: https://shop.com             │
         │     Authorization: Bearer eyJ...         │
         │                                          │
         │◄─── 200 OK ─────────────────────────────│  ACTUAL RESPONSE
         │     Access-Control-Allow-Origin:         │
         │       https://shop.com                   │
         │     {"deleted": true}                    │
         │                                          │
         │ Browser: ✓ Origin matches                │
         │ JS receives: {"deleted": true}           │
         ▼                                          ▼

If preflight FAILS (server sends wrong or missing CORS headers):
         │◄─── 204 No Content ─────────────────────│
         │     (no Access-Control-Allow-Origin)     │
         │                                          │
         │ Browser: ✗ CORS check FAILED            │
         │ Console: "CORS error: No 'Access-Control-│
         │ Allow-Origin' header present"            │
         │ JS receives: TypeError (fetch failed)    │
         │ Note: Network request was SENT and       │
         │ server may have processed it — browser   │
         │ just hides the response from JS!         │
```

---

### Same-Origin Policy: What Is (and Isn't) Blocked

```
BLOCKED by Same-Origin Policy (requires CORS to allow):
  JavaScript fetch() / XMLHttpRequest to different origin
  Reading response from cross-origin fetch (even if request went through)
  Canvas cross-origin pixel access

NOT BLOCKED by Same-Origin Policy:
  <script src="https://cdn.example.com/lib.js">  ← loads scripts from any origin
  <link href="https://fonts.googleapis.com/..."  ← loads CSS from any origin
  <img src="https://other.com/img.png">          ← displays images from any origin
  <video src="https://cdn.com/video.mp4">        ← embeds video from any origin
  form submission to any origin (POST to any domain works! → CSRF risk)
  Server-to-server HTTP calls (no browser = no CORS enforcement)
  curl, Postman, AWS Lambda → all unaffected by CORS
```

---

## SECTION 4 — Step-by-Step Flows

### Flow 1: React frontend → Node.js API (Different Subdomain)

```
Architecture:
  Frontend: https://shop.com (React, served from S3+CloudFront)
  Backend API: https://api.shop.com (Node.js on EC2/ECS behind ALB)

  → Different origins (different subdomains) → CORS required

Step 1: Browser loads https://shop.com (React app)
  Origin of all JS in this page = https://shop.com

Step 2: User logs in → React calls POST https://api.shop.com/login
  Request has Content-Type: application/json → triggers preflight!

  Preflight:
    OPTIONS https://api.shop.com/login
    Origin: https://shop.com
    Access-Control-Request-Method: POST
    Access-Control-Request-Headers: Content-Type

Step 3: Node.js API processes preflight
  Using 'cors' npm package (most common):
    const cors = require('cors');
    app.use(cors({
      origin: ['https://shop.com', 'https://admin.shop.com'],
      methods: ['GET', 'POST', 'PUT', 'DELETE'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      credentials: true,
      maxAge: 86400
    }));

  Preflight response:
    HTTP 204
    Access-Control-Allow-Origin: https://shop.com
    Access-Control-Allow-Methods: GET, POST, PUT, DELETE
    Access-Control-Allow-Headers: Content-Type, Authorization
    Access-Control-Allow-Credentials: true
    Access-Control-Max-Age: 86400
    Vary: Origin

Step 4: Browser verifies preflight → sends real POST request
  POST https://api.shop.com/login
  Content-Type: application/json
  Origin: https://shop.com
  {"email": "user@shop.com", "password": "..."}

Step 5: API processes login → sets cookie + responds
  HTTP 200 OK
  Set-Cookie: session=abc123; HttpOnly; Secure; SameSite=None; Domain=api.shop.com
  Access-Control-Allow-Origin: https://shop.com
  Access-Control-Allow-Credentials: true
  {"user": "John"}

  Note: SameSite=None is required for cross-origin cookies
        Requires Secure attribute (HTTPS)

Step 6: Browser receives cookie. Future API calls include it:
  fetch("https://api.shop.com/orders", { credentials: "include" })
  → Cookie: session=abc123 sent automatically
  → API reads cookie → identifies user → returns their orders
```

---

### Flow 2: Debugging a CORS Error

```
User reports: "The checkout page gives a blank error. Console shows:
   Access to fetch at 'https://api.shop.com/cart' from origin
   'https://shop.com' has been blocked by CORS policy"

Step 1: Open browser DevTools → Network tab → find the failing request
  Look for the OPTIONS preflight request
  Or look for the actual GET/POST that has error: "CORS"

Step 2: Check the ACTUAL request Chrome shows
  Request headers:
    Origin: https://shop.com           ← browser set this
    Access-Control-Request-Method: GET

  Response headers (if server responded):
    HTTP 200 OK
    Content-Type: application/json
    [no Access-Control-Allow-Origin header]   ← THIS IS THE PROBLEM

Step 3: The server has no CORS headers configured
  Common cause A: Node.js cors() middleware not added
  Common cause B: cors() middleware is added AFTER the route
    app.get('/cart', handler);  ← CORS not applied
    app.use(cors());            ← too late!
  Common cause C: Different webserver behind API (nginx) ignores CORS headers from app
    Fix: add add_header 'Access-Control-Allow-Origin' $http_origin in nginx.conf

Step 4: Important observation about CORS errors:
  The request WAS sent and the server DID respond.
  The server may have PROCESSED the request (inserted to DB, charged the card, etc.).
  The browser just blocks JavaScript from READING the response.
  → Idempotency matters: if you're confused why a CORS-failing request ran twice,
    it's because the human is retrying something that already executed server-side.

Step 5: Fix and verify
  Add CORS headers on server
  Verify with curl:
    curl -H "Origin: https://shop.com" \
         -H "Access-Control-Request-Method: GET" \
         -X OPTIONS \
         https://api.shop.com/cart \
         -v 2>&1 | grep -i "access-control"

  Expected output:
    < Access-Control-Allow-Origin: https://shop.com
    < Access-Control-Allow-Methods: GET, POST
    < Access-Control-Max-Age: 86400
```

---

### Flow 3: S3 Static Website with Cross-Origin Image Access

```
Scenario: Frontend at https://shop.com loads product images from S3 bucket
  S3 Bucket: https://images.shop.com.s3.amazonaws.com
  Origin: https://shop.com is different from the S3 bucket origin

Step 1: Configure S3 CORS policy
  Go to S3 bucket → Permissions → CORS configuration

  [
    {
      "AllowedHeaders": ["*"],
      "AllowedMethods": ["GET", "HEAD"],
      "AllowedOrigins": ["https://shop.com", "https://www.shop.com"],
      "ExposeHeaders": ["ETag"],
      "MaxAgeSeconds": 3600
    }
  ]

Step 2: JavaScript loads image
  <img src="https://images.shop.com.s3.amazonaws.com/product-123.jpg">
  → img tags DON'T use CORS (browser displays them regardless)

  BUT if you try to draw the image on a Canvas or read pixel data:
  const img = new Image();
  img.crossOrigin = "anonymous";  ← tells browser to request with CORS
  img.src = "https://images.shop.com.s3.amazonaws.com/product-123.jpg";
  // Only allowed if S3 CORS policy allows https://shop.com

Step 3: CloudFront + CORS caching issue (important!)
  If shop.com uses CloudFront to cache S3 images:
  CloudFront should forward the Origin header to S3:
    Cache Policy: Include Origin in cache key (or custom cache policy)
    If Origin not forwarded: CloudFront serves one response to all origins
      → If first response was for non-CORS request (no CORS headers)
         subsequent CORS requests from shop.com also get non-CORS response!
    Fix: CloudFront origin request policy forwards headers including Origin
         Vary: Origin on cached responses ensures per-origin caching
```

---

## File Summary

This file covered:

- School supplies / bouncer / visitor badge analogies
- Origin definition: protocol + hostname + port (all three must match)
- Simple vs preflighted requests (when preflight is triggered)
- Full preflight exchange: OPTIONS request + 204 response + real request
- Complete CORS response header reference with semantics
- Credentials with CORS: withCredentials + exact origin required (no wildcard)
- Common CORS misconfigurations: reflect origin blindly, null origin, regex bypass, CORS ≠ security
- ASCII: preflight flow diagram, Same-Origin Policy scope (what is/isn't blocked)
- Step-by-step: React → Node.js API with session cookies across subdomains
- Debugging flow: CORS error investigation process, key insight (request still executed on server!)
- S3 CORS config + CloudFront Vary: Origin caching interaction

**Continue to File 02** for real-world examples, system design, AWS mapping, and 8 Q&As.
