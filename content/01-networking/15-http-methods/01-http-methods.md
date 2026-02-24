# HTTP Methods — Part 1 of 3

### Topic: GET, POST, PUT, PATCH, DELETE — The Vocabulary of the Web

**Series:** Networking Fundamentals → System Design → AWS Solutions Architect
**Audience:** 14-Year Experienced Full-Stack Developer → Becoming an Architect
**Sections Covered:** 1, 2, 3, 4

---

## SECTION 1 — Intuition First (ELI12 Version)

### Analogy 1 — A Library With Rules

Imagine a library with strict rules for how you can interact with books:

- **GET:** "I want to READ this book." You look at it, copy notes, but the book stays on the shelf unchanged. You can come back 10 times — same book, same shelf. (Safe + Idempotent)
- **POST:** "I want to DONATE this new book to the library." Every time you donate, a new copy is added. Donate twice = two copies. (Not safe, not idempotent)
- **PUT:** "I want to REPLACE this book with a new edition." If the slot exists, put the new book there. If it doesn't exist, create it. Do this 10 times → same result (last write wins). (Idempotent)
- **PATCH:** "I want to UPDATE just the author's name in this book." Partial change — don't rewrite the whole book. (Partial update)
- **DELETE:** "I want to REMOVE this book from the library." If you delete the same book twice: second time it's already gone (nothing changes — idempotent in practice).
- **HEAD:** "I want to check IF this book exists and its publication date." No copy of the book given — just the card catalogue info. (Safe + Idempotent)
- **OPTIONS:** "What can I do with this shelf? Can I put books here from a different library?" Answer: "This shelf accepts GET and POST only." Used for CORS preflight.

The key rule: if your action could change library state (add/modify/delete books), it's NOT safe. If doing it multiple times has the same result as doing it once, it's idempotent.

### Analogy 2 — A Bank Teller

You go to a bank with different requests:

- **GET:** "Tell me my balance." (Read-only, ask 100 times, same answer if nothing changed)
- **POST:** "Transfer $100 to my friend." (Creates a transaction — each request creates a new transfer — NOT idempotent: POST twice = two $100 transfers)
- **PUT:** "Set my contact phone to +1-555-0100." (Replacing a field: do it 10 times → same phone number in system)
- **PATCH:** "Update just my email address." (Change one field of my profile without replacing entire profile)
- **DELETE:** "Close this savings account." (Removes resource; doing it twice → second time: account already gone, no new effect)

The critical implication for distributed systems: **POST is NOT idempotent** → network retries can cause duplicate operations (duplicate payments, duplicate orders). This is why payment systems require idempotency keys with POST, or prefer PUT.

---

## SECTION 2 — Core Technical Deep Dive

### Method Properties: Safety and Idempotency

Two crucial properties defined in RFC 7231:

**Safe:** A method is safe if it does not modify server state. Safe methods can be cached, prefetched, and called freely by browsers and CDNs without side effects.

**Idempotent:** A method is idempotent if calling it multiple times produces the same server state as calling it once. Idempotent methods are safe to retry on network failure.

```
┌──────────┬────────┬─────────────┬──────────────────────────────────┐
│ Method   │ Safe   │ Idempotent  │ Typical Use                      │
├──────────┼────────┼─────────────┼──────────────────────────────────┤
│ GET      │ Yes    │ Yes         │ Retrieve resource(s)             │
│ HEAD     │ Yes    │ Yes         │ Check existence, headers only    │
│ OPTIONS  │ Yes    │ Yes         │ Discover capabilities, CORS      │
│ DELETE   │ No     │ Yes         │ Remove a resource                │
│ PUT      │ No     │ Yes         │ Create or replace resource       │
│ PATCH    │ No     │ No*         │ Partial update                   │
│ POST     │ No     │ No          │ Create resource, trigger action  │
│ CONNECT  │ No     │ No          │ Tunnel (HTTP proxy, WebSockets)  │
└──────────┴────────┴─────────────┴──────────────────────────────────┘
*PATCH can be made idempotent with careful implementation but isn't by default
```

### GET — Retrieve a Resource

```
GET /products/42 HTTP/1.1
Host: api.shop.com
Accept: application/json
If-None-Match: "abc123"          (conditional GET — return 304 if unchanged)

Rules:
  ✓ No body (technically allowed but strongly discouraged — many tools strip it)
  ✓ Cacheable: CDNs, browsers, proxies cache GET responses
  ✓ Bookmarkable: URL encodes all state (query params)
  ✓ Safe to repeat: clicking back button on GET = no side effect

URL encoding state:
  GET /products?category=electronics&sort=price&page=2
  All query params are URL-encoded: space = %20, & separates params
```

**GET body problem:** Some systems send GET with a body (Elasticsearch `_search` endpoint uses `GET /index/_search` with JSON body). This is technically legal but many HTTP proxies, CDNs, and ALBs strip the body. Better practice: use POST for complex queries, or use `_search` endpoint with POST.

### POST — Create or Submit

```
POST /orders HTTP/1.1
Host: api.shop.com
Content-Type: application/json
Content-Length: 78
Idempotency-Key: f47ac10b-58cc-4372-a567-0e02b2c3d479

{"product_id": 42, "quantity": 2, "shipping_address_id": "addr_001"}

Response: 201 Created
Location: /orders/1234                   (URL of newly created resource)
```

**POST is NOT idempotent — this matters:**

```
Mobile client submits order → POST /orders
  Network drops AFTER server processed but BEFORE response received
  Client retry: POST /orders again
  Without idempotency key: two orders created (customer charged twice)

  With Idempotency-Key:
  Server stores: idempotency_key → order_id + response
  Second POST with same key: server returns cached response (no new order)
  Client receives: 201 + same order ID (transparent retry safety)
```

Stripe, Twilio, PayPal all use idempotency keys on POST for exactly this reason.

### PUT — Create or Replace (Idempotent)

```
PUT /users/123/profile HTTP/1.1
Content-Type: application/json

{"name": "Bikash", "email": "bikash@example.com", "phone": "+1-555-0100"}

Rules:
  - The client specifies the resource URL (PUT /users/123/profile)
  - Server creates if not exists, replaces entirely if exists
  - Response: 200 OK (replaced) or 201 Created (new)
  - Idempotent: PUT the same body 10 times → same final state

Problem with PUT for partial updates:
  User has 20 fields; client wants to update only email
  Client must PUT all 20 fields (or fetch first, modify email, PUT back)
  Extra round-trip (GET → modify → PUT) wastes bandwidth and creates race conditions
```

### PATCH — Partial Update

```
PATCH /users/123/profile HTTP/1.1
Content-Type: application/json

{"email": "new@example.com"}         (only the changed fields)

Response: 200 OK
{"name": "Bikash", "email": "new@example.com", "phone": "+1-555-0100", ...}

Why PATCH is not idempotent by default:
  Consider: PATCH {"counter": +1}   (increment counter)
  Do this 3 times → counter += 3 (not idempotent)

  But: PATCH {"email": "new@example.com"}  (set to specific value)
  Do this 3 times → email still "new@example.com" (idempotent in practice)

JSON Patch (RFC 6902) — structured PATCH operations:
  [
    {"op": "replace", "path": "/email", "value": "new@example.com"},
    {"op": "add", "path": "/tags/-", "value": "premium"}
  ]
  More explicit about operations; clients must know current state or use optimistic locking
```

### DELETE — Remove

```
DELETE /orders/1234 HTTP/1.1
Authorization: Bearer token

Response: 204 No Content    (deleted, no body)
      OR: 200 OK + body    (deleted, return final state)

Second DELETE of same resource:
  Idempotent approach: return 404 (resource gone)
  OR: return 204 again (operation already achieved)
  RFC says DELETE is idempotent: server state after first and second delete is the same
  (resource absent) — even though the HTTP response code may differ

Soft delete (common in production):
  DELETE /users/123 → marks user as deleted (deleted_at = now), returns 200
  Subsequent GET /users/123 → 404 (acts as if deleted)
  Actual DB row retained for audit log
```

### HEAD — Metadata Without Body

```
HEAD /files/report.pdf HTTP/1.1

Response: 200 OK
Content-Length: 45230000        (45 MB)
Content-Type: application/pdf
Last-Modified: Mon, 23 Feb 2026 10:00:00 GMT
ETag: "d41d8cd98f00b204e9800998ecf8427e"
           (NO BODY — just headers)

Use cases:
  - Check if a file exists before downloading (avoid 404 after 30-second wait)
  - Get Content-Length before starting large download (show progress bar)
  - Check Last-Modified to decide if cache is still valid
  - Pre-flight check on APIs before implementing full client
```

### OPTIONS — Capabilities and CORS Preflight

```
OPTIONS /api/payments HTTP/1.1
Host: api.shop.com
Origin: https://checkout.shop.com
Access-Control-Request-Method: POST
Access-Control-Request-Headers: Authorization, Content-Type

Response: 204 No Content
Allow: GET, POST, DELETE, OPTIONS
Access-Control-Allow-Origin: https://checkout.shop.com
Access-Control-Allow-Methods: GET, POST, DELETE
Access-Control-Allow-Headers: Authorization, Content-Type
Access-Control-Max-Age: 86400                (cache this preflight for 24h)
```

OPTIONS is the backbone of CORS (Cross-Origin Resource Sharing). Before a browser makes a cross-origin POST, it sends an OPTIONS preflight to ask: "Can my JavaScript at origin X call you with method Y and headers Z?" The server's CORS headers answer. If allowed, the actual request proceeds. If not, browser blocks the request.

### REST Resource Design: URL + Method Combinations

```
Resource: Orders

GET    /orders              → List all orders (200 OK + array)
POST   /orders              → Create order (201 Created + Location header)
GET    /orders/1234         → Get specific order (200 OK)
PUT    /orders/1234         → Replace order 1234 completely (200 OK)
PATCH  /orders/1234         → Update order 1234 partially (200 OK)
DELETE /orders/1234         → Delete order 1234 (204 No Content)

Nested resources:
GET    /orders/1234/items        → List items in order 1234
POST   /orders/1234/items        → Add item to order 1234
DELETE /orders/1234/items/5      → Remove item 5 from order 1234

Anti-patterns to avoid:
  POST /getOrder      (method is already GET — don't verb the URL)
  GET  /deleteOrder   (GET should never delete — catastrophic if crawled)
  POST /orders/update (PATCH or PUT is correct)
```

---

## SECTION 3 — Architecture Diagram

```
╔══════════════════════════════════════════════════════════════════╗
║            HTTP METHODS: CRUD MAPPING AND FLOW                  ║
╚══════════════════════════════════════════════════════════════════╝

REST API DESIGN — /products resource:

CLIENT              ALB                APP SERVER          DATABASE
  │                  │                    │                    │
  │─ GET /products ─►│─ GET /products ───►│─ SELECT * ────────►│
  │                  │                    │◄── rows ───────────│
  │◄─ 200 [array] ──│◄── 200 ────────────│                    │
  │                  │                    │                    │
  │─ POST /products ►│─ POST /products ──►│─ INSERT ──────────►│
  │  {name,price}    │  {name,price}      │◄── id=42 ──────────│
  │◄─ 201 Created ──│◄── 201 ────────────│                    │
  │   Location: /42  │   Location: /42    │                    │
  │                  │                    │                    │
  │─ PUT /products/42►│─ PUT /products/42►│─ UPSERT ──────────►│
  │  {complete body} │  {complete body}   │◄── ok ─────────────│
  │◄─ 200 OK ───────│◄── 200 ────────────│                    │
  │                  │                    │                    │
  │─ PATCH /prod/42 ►│─ PATCH /prod/42 ──►│─ UPDATE partial ──►│
  │  {email only}    │  {email only}      │◄── ok ─────────────│
  │◄─ 200 OK ───────│◄── 200 ────────────│                    │
  │                  │                    │                    │
  │─ DELETE /prod/42►│─ DELETE /prod/42 ─►│─ DELETE id=42 ────►│
  │                  │                    │◄── ok ─────────────│
  │◄─ 204 No Content│◄── 204 ────────────│                    │

CORS PREFLIGHT FLOW:

Browser (react-app.com)        API (api.shop.com)
  │                                   │
  │─ OPTIONS /orders ────────────────►│   (preflight: can I POST from react-app.com?)
  │  Origin: https://react-app.com    │
  │  Access-Control-Request-Method: POST
  │                                   │
  │◄── 204 No Content ────────────────│
  │  Access-Control-Allow-Origin: https://react-app.com
  │  Access-Control-Allow-Methods: GET, POST, DELETE
  │  Access-Control-Max-Age: 86400    │
  │                                   │
  │─ POST /orders ───────────────────►│   (actual request — browser allows it)
  │  Origin: https://react-app.com    │
  │  Content-Type: application/json   │
  │◄── 201 Created ───────────────────│

IDEMPOTENCY KEY PATTERN (POST recovery):

Client                                API Server
  │─ POST /payments ─────────────────►│
  │  Idempotency-Key: uuid-1          │─► DB: INSERT payment, store key+result
  │                                   │
  │  (network timeout — client retries)│
  │─ POST /payments ─────────────────►│
  │  Idempotency-Key: uuid-1 (same!)  │─► DB: SELECT existing result for uuid-1
  │◄── 201 Created (same response) ───│      Return cached response (no new INSERT)
  │   (no duplicate charge!)          │
```

---

## SECTION 4 — Request Flow: Step by Step

### CORS Preflight + Actual Request (React SPA calling REST API)

```
Setup:
  React app served from: https://app.frontend.com
  REST API at:           https://api.backend.com
  These are DIFFERENT origins → browser CORS policy applies

STEP 1 — User clicks "Submit Order"
  JavaScript: fetch('https://api.backend.com/orders', {method: 'POST', ...})
  Browser detects: different origin + custom header (Authorization) → MUST preflight

STEP 2 — OPTIONS Preflight Request
  Browser sends automatically:
    OPTIONS /orders HTTP/1.1
    Host: api.backend.com
    Origin: https://app.frontend.com
    Access-Control-Request-Method: POST
    Access-Control-Request-Headers: authorization, content-type

STEP 3 — Server OPTIONS Response
  Server responds:
    HTTP/1.1 204 No Content
    Access-Control-Allow-Origin: https://app.frontend.com
    Access-Control-Allow-Methods: GET, POST, PUT, DELETE, PATCH
    Access-Control-Allow-Headers: Authorization, Content-Type
    Access-Control-Max-Age: 86400
    Vary: Origin

  Browser: "Allowed! Caching this preflight for 86400 seconds."

STEP 4 — Actual POST Request
  Browser sends:
    POST /orders HTTP/1.1
    Host: api.backend.com
    Origin: https://app.frontend.com
    Authorization: Bearer eyJhbGci...
    Content-Type: application/json
    Content-Length: 87

    {"product_id": 42, "quantity": 2, "address_id": "addr_001"}

STEP 5 — Server Processes POST
  Validate JWT → extract user_id
  Validate product_id exists
  CREATE order in database
  Return 201 Created

STEP 6 — Server POST Response
  HTTP/1.1 201 Created
  Location: https://api.backend.com/orders/5678
  Access-Control-Allow-Origin: https://app.frontend.com  (required on actual response too)
  Content-Type: application/json

  {"id": 5678, "status": "pending", "total": 159.98}

STEP 7 — Next Request (cached preflight)
  User immediately checks order status:
  GET /orders/5678
    → No OPTIONS preflight (cached for 86400s)
    → Browser sends GET directly
    → ~1 RTT saved

STEP 8 — Method Not Allowed
  User somehow tries: DELETE /orders/5678 (from frontend code bug)
  Server returns: 405 Method Not Allowed
  Browser: Cross-origin 405 → still shows error (but CORS headers included —
           server should include CORS headers even on error responses)

KEY INSIGHT:
  OPTIONS is BROWSER-ONLY enforcement.
  curl, Postman, server-to-server calls skip CORS entirely.
  CORS protects users from malicious JavaScript; it does NOT protect APIs from attackers.
  Server-side authentication (JWT, API keys) is the real security layer.
```

---

## File Summary

This file covered:

- Library borrowing (Safe/Idempotent distinctions) and bank teller analogies for all HTTP methods
- GET: read-only, cacheable, bookmarkable; GET body problem (strip in proxies)
- POST: creates resource, NOT idempotent → idempotency keys required for payment/financial POST
- PUT: create or REPLACE entirely (idempotent); PATCH: partial update (not idempotent by default)
- DELETE: idempotent (second delete finds resource absent → no new state change)
- HEAD: headers-only GET (check existence, get Content-Length before download)
- OPTIONS: CORS preflight mechanism; browser determines if cross-origin request is allowed
- REST URL + Method matrix: GET/POST/PUT/PATCH/DELETE on collections and individual resources
- CORS flow: OPTIONS preflight → server CORS headers → browser allows actual request
- `Access-Control-Max-Age: 86400` — cache preflight to avoid OPTIONS on every request

**Continue to File 02** for real-world examples (Stripe idempotency keys, GitHub REST API method conventions), system design considerations (method tunneling, idempotency patterns, GraphQL vs REST method usage), AWS API Gateway method routing, and 8 interview Q&As.
