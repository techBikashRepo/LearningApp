# HTTP Status Codes — Part 1 of 3

### Topic: 200 OK to 503 Unavailable — The Language of Server Responses

**Series:** Networking Fundamentals → System Design → AWS Solutions Architect
**Audience:** 14-Year Experienced Full-Stack Developer → Becoming an Architect
**Sections Covered:** 1, 2, 3, 4

---

## SECTION 1 — Intuition First (ELI12 Version)

### Analogy 1 — The Post Office Response System

You send letters to different addresses and the post office gives you back receipts:

- **1xx — "We got it, hang on":** Post office received your letter, still processing it internally. Not done yet.
- **2xx — "Delivered successfully":**
  - **200 OK:** "Delivered and accepted."
  - **201 Created:** "Delivered and something new was created because of it." (You mailed an application and got accepted.)
  - **204 No Content:** "Done, nothing to add." (You asked them to cancel your subscription — confirmed, no response needed.)
- **3xx — "Go somewhere else":**
  - **301 Moved Permanently:** "This address no longer exists. The business moved to 456 New Street. Update your address book." (Permanent redirect — browser bookmarks new URL)
  - **302 Found:** "Try this other address for now, but keep this one." (Temporary redirect)
  - **304 Not Modified:** "The letter you're asking about hasn't changed. You already have a copy." (Conditional GET — use your cache)
- **4xx — "You made a mistake":**
  - **400 Bad Request:** "Your letter was illegible — rewrite it."
  - **401 Unauthorized:** "You haven't introduced yourself. Show ID."
  - **403 Forbidden:** "I know who you are, but you're not allowed here."
  - **404 Not Found:** "No one at this address."
  - **429 Too Many Requests:** "You've sent 100 letters today. Limit is 10. Wait until tomorrow."
- **5xx — "We made a mistake":**
  - **500 Internal Server Error:** "Our staff dropped your letter. Our fault."
  - **502 Bad Gateway:** "Our post office tried to forward your letter to a partner office, but they're broken."
  - **503 Service Unavailable:** "We're overwhelmed today / undergoing renovation. Try later."
  - **504 Gateway Timeout:** "Our partner office took too long to respond. We gave up."

The first digit tells you WHO is responsible: 4xx = client's problem; 5xx = server's problem. This distinction is critical for monitoring and alerting.

### Analogy 2 — Human Traffic Control Signals

A traffic controller uses signals to communicate with drivers:

- **200 series:** Green light — proceed as expected
- **300 series:** Yellow arrow — go in a different direction
- **400 series:** Red light with YOU symbol — your vehicle doesn't qualify (wrong type, no permit)
- **500 series:** Red light with ROAD CLOSED sign — infrastructure problem, not your fault

The key insight for system design: when you see 4xx errors spike in your dashboards, investigate your CLIENTS (wrong requests, expired auth tokens, bad data). When 5xx spike: investigate your SERVERS (crashes, DB failures, memory exhaustion). The distinction drives your alerting and on-call runbooks differently.

---

## SECTION 2 — Core Technical Deep Dive

### Status Code Structure

HTTP status codes are 3-digit integers. The first digit is the class:

```
1xx — Informational:  Request received, processing continues
2xx — Successful:     Request received, understood, and accepted
3xx — Redirection:    Further action needed
4xx — Client Error:   Request contains bad syntax or cannot be fulfilled
5xx — Server Error:   Server failed to fulfill a valid request
```

### The Essential 2xx Codes

**200 OK** — Universal success for GET, PUT, PATCH, DELETE with body

```
GET /products/42 → 200 OK + {id:42, name:"Headphones"}
PUT /products/42 → 200 OK + {id:42, updated fields...}
```

**201 Created** — Success for POST that created a resource

```
POST /orders → 201 Created
Location: /orders/5678        (MANDATORY — tell client WHERE the new resource is)
Body: {id: 5678, status: "pending"}
```

Missing `Location` header on 201 is a common API design mistake.

**202 Accepted** — Request accepted for async processing

```
POST /reports/generate → 202 Accepted
Location: /reports/status/abc123   (polling URL)
Body: {"job_id": "abc123", "status": "queued"}
```

Used when processing takes too long (exceeds timeout). Client polls `/reports/status/abc123` until complete.

**204 No Content** — Success with no response body

```
DELETE /orders/5678 → 204 No Content
PUT /users/123/settings → 204 No Content (when server doesn't need to return the modified resource)
```

Client should not expect a body. JavaScript `fetch()`: response body will be empty — calling `response.json()` on 204 throws an error.

**206 Partial Content** — Partial response for range request

```
GET /videos/movie.mp4 HTTP/1.1
Range: bytes=0-1048575       (first 1MB)

HTTP/1.1 206 Partial Content
Content-Range: bytes 0-1048575/52428800   (1MB of 50MB file)
Content-Length: 1048576
Accept-Ranges: bytes          (server supports range requests)
```

Used by: video streaming (seek to any position), resume interrupted downloads, parallel download managers.

### The Essential 3xx Codes

**301 Moved Permanently** — Resource has a new permanent URL

```
HTTP/1.1 301 Moved Permanently
Location: https://www.newdomain.com/products/42

SEO implication: Google passes PageRank through 301
Browser caches indefinitely (very aggressive — can't easily undo)
Use for: HTTP → HTTPS upgrade, domain migration, URL restructuring
```

**302 Found** — Temporary redirect (legacy)

```
HTTP/1.1 302 Found
Location: /maintenance.html
```

Historical problem: browsers often converted POST → GET when following 302. Caused data loss.

**307 Temporary Redirect** — Temporary redirect, preserve method

```
HTTP/1.1 307 Temporary Redirect
Location: /api/v2/orders
```

Like 302 but GUARANTEES: if the original request was POST, the redirect ALSO uses POST. Use 307 instead of 302 when method preservation matters.

**308 Permanent Redirect** — Permanent redirect, preserve method

```
HTTP/1.1 308 Permanent Redirect
Location: https://api.newdomain.com/orders
```

Like 301 but method-preserving. Prefer 308 over 301 when clients may POST to old endpoint.

**304 Not Modified** — Cache is still valid (conditional GET)

```
Client sends:
  GET /products/42 HTTP/1.1
  If-None-Match: "abc123"

Server checks: ETag still "abc123"? Yes.
  HTTP/1.1 304 Not Modified
  (no body — client uses its cache)

Network saved: 0 bytes of response body transferred.
```

### The Essential 4xx Codes

**400 Bad Request** — Malformed request syntax or invalid parameters

```
POST /orders
{"quantity": "two"}    (should be integer, not string)
→ 400 Bad Request
{"error": "quantity must be an integer", "field": "quantity"}
```

Include specific error details in the body — "400 Bad Request" alone is useless for debugging.

**401 Unauthorized** — Authentication required (misleading name: should be "Unauthenticated")

```
GET /orders
→ 401 Unauthorized
WWW-Authenticate: Bearer realm="api.shop.com"   (required by RFC — tells client HOW to authenticate)
{"error": "Authentication required"}
```

Difference from 403: 401 means "who are you?" — provide credentials and try again. The `WWW-Authenticate` header in the response is REQUIRED per RFC 7235.

**403 Forbidden** — Authenticated but not authorized

```
GET /admin/reports       (user is logged in but not admin role)
→ 403 Forbidden
{"error": "Admin role required for this resource"}
```

Server KNOWS who the user is (valid JWT) but that user doesn't have permission. Unlike 401, sending credentials again won't help.

**404 Not Found** — Resource doesn't exist (or server intentionally hides it)

```
GET /products/99999
→ 404 Not Found
```

Security note: return 404 (not 403) for resources the user shouldn't know exist. If you return 403 for `/admin/secrets`, you reveal that the resource exists. 404 reveals nothing.

**405 Method Not Allowed** — Method not supported for this resource

```
DELETE /products         (server doesn't allow bulk delete)
→ 405 Method Not Allowed
Allow: GET, POST         (REQUIRED header — RFC 7231)
```

**409 Conflict** — Request contradicts current server state

```
PUT /users/123 {"email": "duplicate@example.com"}  (email already taken by user 456)
→ 409 Conflict
{"error": "Email already in use by another account"}
```

**410 Gone** — Resource permanently deleted (stronger than 404)

```
GET /products/42   (product deleted 6 months ago, intentionally removed)
→ 410 Gone
```

410 tells caches and search engines: remove this URL permanently. 404 says "might come back." Use 410 for intentional permanent removal.

**422 Unprocessable Entity** — Valid syntax but semantic error (WebDAV, adopted by REST)

```
POST /orders {"product_id": 99999, "quantity": -1}
Body is valid JSON, but business logic fails:
→ 422 Unprocessable Entity
{"errors": [{"field": "quantity", "message": "must be positive"}, {"field": "product_id", "message": "not found"}]}
```

Distinction from 400: 400 = can't parse the request (syntax error); 422 = parsed but invalid semantics.

**429 Too Many Requests** — Rate limit exceeded

```
POST /api/send-sms    (after 100 calls in 1 minute)
→ 429 Too Many Requests
Retry-After: 60       (wait 60 seconds before retrying)
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1740301200    (epoch timestamp when limit resets)
```

### The Essential 5xx Codes

**500 Internal Server Error** — Generic unhandled server exception

```
GET /products/42
→ 500 Internal Server Error
{"error": "An unexpected error occurred"}  (don't expose stack traces in production!)
```

Monitor 500s closely — each one represents a bug or unhandled edge case.

**502 Bad Gateway** — Proxy received invalid response from upstream

```
ALB → EC2 instance crashed → no response
→ ALB returns 502 to client
"The target returned an invalid response."
```

In AWS context: ALB returns 502 when backend target sends a malformed HTTP response, crashes mid-response, or the response violates HTTP spec.

**503 Service Unavailable** — Server temporarily unable to handle requests

```
HTTP/1.1 503 Service Unavailable
Retry-After: 30
{"error": "Service temporarily unavailable for maintenance"}
```

Sources: all backends unhealthy, deployment in progress, circuit breaker open, DB unavailable.

**504 Gateway Timeout** — Proxy upstream timed out

```
ALB → EC2 instance → DB query taking 65 seconds (ALB timeout = 60s)
→ ALB returns 504 to client
```

In AWS: ALB idle timeout (60s default) exceeded while waiting for backend response. Fix: optimize DB query + increase ALB timeout + implement async processing for long operations.

---

## SECTION 3 — Architecture Diagram

```
╔══════════════════════════════════════════════════════════════════╗
║           HTTP STATUS CODE FLOW DIAGRAM                         ║
╚══════════════════════════════════════════════════════════════════╝

CLIENT REQUEST → SERVER RESPONSE FLOW:

   Request         Decision Tree              Response
   ─────────       ─────────────────          ────────

   POST /orders ──► Request parseable?
                      │ No ──────────────────► 400 Bad Request
                      │ Yes
                      ▼
                   Auth token present?
                      │ No ──────────────────► 401 Unauthorized
                      │ Yes                    WWW-Authenticate: Bearer
                      ▼
                   Token valid, not expired?
                      │ No ──────────────────► 401 Unauthorized
                      │ Yes
                      ▼
                   User has permission?
                      │ No ──────────────────► 403 Forbidden
                      │ Yes
                      ▼
                   Resource exists?
                      │ No (for GET/PATCH) ──► 404 Not Found
                      │ Yes (or POST new)
                      ▼
                   Business validation ok?
                      │ No ──────────────────► 422 Unprocessable Entity
                      │ Yes
                      ▼
                   Rate limit ok?
                      │ No ──────────────────► 429 Too Many Requests
                      │ Yes
                      ▼
                   DB/external service ok?
                      │ No ──────────────────► 503 Service Unavailable
                      │ Yes
                      ▼
                   Server exception?
                      │ Yes ─────────────────► 500 Internal Server Error
                      │ No
                      ▼
                   POST created new? ─────────► 201 Created + Location
                   PUT/PATCH? ────────────────► 200 OK
                   DELETE? ───────────────────► 204 No Content

═══════════════════════════════════════════════════════════════════

AWS ALB STATUS CODE SOURCES:

Browser ──► ALB ──► Target Group (EC2)
              │            │
              │            │── Target returns 200 → ALB forwards 200
              │            │── Target returns 500 → ALB forwards 500
              │            │── Target returns nothing (crash) → ALB ──► 502 Bad Gateway
              │            └── Target takes > 60s → ALB ──► 504 Gateway Timeout
              │
              │── No healthy targets in group ──────────────────► 503 Service Unavailable
              │── Listener rule action: fixed response ──────────► 200/301/302/etc. (no backend hit)
              └── TLS cert invalid or client cert required ──────► 400 Bad Request (TLS error)

═══════════════════════════════════════════════════════════════════

REDIRECT CHAIN (301 and 302):

Browser requests: http://shop.com/products
  │
  │◄── 301 Moved Permanently: https://shop.com/products   (HTTP→HTTPS)
  │
  │── sends: GET https://shop.com/products
  │
  │◄── 301 Moved Permanently: https://www.shop.com/products  (naked→www)
  │
  │── sends: GET https://www.shop.com/products
  │
  │◄── 200 OK (final destination)

Each redirect = 1 RTT overhead.
Google follows up to 5 redirects before treating as broken link.
Minimize redirect chains for SEO and performance.
```

---

## SECTION 4 — Request Flow: Step by Step

### Real World Production Scenario — All Status Codes in Action

```
E-commerce checkout flow — all status code paths:

HAPPY PATH:
  POST /orders {"product_id": 42, "quantity": 2, "payment_token": "tok_abc"}
  → 201 Created
    Location: /orders/5678
    {id: 5678, status: "processing", estimated_delivery: "2026-02-26"}

  GET /orders/5678
  → 200 OK
    {id: 5678, status: "shipped", tracking: "1Z999AA10123456784"}

AUTHENTICATION FAILURE:
  POST /orders (expired JWT, 2 hours old)
  → 401 Unauthorized
    WWW-Authenticate: Bearer error="invalid_token", error_description="Token expired"
  Client: refresh access token using refresh token → retry with new access token

AUTHORIZATION FAILURE:
  GET /orders (admin query — all orders)
  (logged in as regular user, not admin)
  → 403 Forbidden
    {error: "Insufficient permissions", required_role: "admin"}
  Client: show "Access Denied" message; no point retrying with same credentials

VALIDATION FAILURE:
  POST /orders {"product_id": 42, "quantity": -1, "payment_token": ""}
  → 422 Unprocessable Entity
    {errors: [
      {field: "quantity", message: "Must be between 1 and 100"},
      {field: "payment_token", message: "Required"}
    ]}
  Client: highlight form fields with errors; user corrects and resubmits

NOT FOUND:
  GET /orders/99999  (non-existent order ID)
  → 404 Not Found
    {error: "Order not found", order_id: 99999}
  (If user_id doesn't own order: return 404 not 403 — don't reveal existence)

CONFLICT:
  POST /cart/items {product_id: 42}  (product already in cart)
  → 409 Conflict
    {error: "Product already in cart", existing_item_id: "cart_item_789"}
  Client: offer "increase quantity" instead

RATE LIMIT:
  POST /checkout  (12th attempt in 1 minute — limit is 10)
  → 429 Too Many Requests
    Retry-After: 47
    X-RateLimit-Reset: 1740301247
  Client: show "Too many requests. Please wait 47 seconds."

SERVER ERROR:
  POST /orders  (DB connection pool exhausted)
  → 503 Service Unavailable
    Retry-After: 10
    {error: "Service temporarily unavailable"}
  Client: retry after 10 seconds (server hints wait time)

  (vs. 500: don't set Retry-After — it's a bug, not a capacity issue)

GATEWAY TIMEOUT:
  POST /orders  (payment provider API took 65s, ALB timeout 60s)
  → 504 Gateway Timeout
    {error: "Request timed out. Please check your order status."}
  Client: check /orders (order may or may not have been created!)
  Important: 504 means UNCERTAIN state — do NOT retry without checking!
  504 ≠ safe to retry (the backend may have processed it)
```

### The 504 Uncertainty Problem

```
CLIENT        ALB           APP SERVER        PAYMENT API
  │────POST /orders─────────►│                   │
  │             │────────────►│ begins processing │
  │             │             │────────POST charge►│
  │             │             │   (15 seconds later)
  │             │             │◄──── 200 charge created──│
  │             │             │  begins writing to DB...
  │             │     [60 SECONDS — ALB TIMEOUT EXPIRES]
  │◄────504─────│             │  ...DB write completes
  │             │             │  ...tries to send 201 to ALB
  │             │             │◄── connection closed (ALB gave up)

Result: Order WAS created (payment charged, DB written)
        Client GOT 504 (thinks it failed!)
        Client shows "Order failed" but customer IS charged!

Correct client behavior on 504:
  1. Do NOT retry immediately (would create duplicate)
  2. Poll /orders?reference={client_reference} to check if order exists
  3. If exists: show success
  4. If not: safe to retry (payment gateway also idempotent? Check first!)

This is why 504 is more dangerous than 503:
  503 = server was down before processing → safe-ish to retry
  504 = server MAY have processed → check before retry
```

---

## File Summary

This file covered:

- Post office receipts and traffic signals as natural status code analogies
- Status code classes: 1xx=inform, 2xx=success, 3xx=redirect, 4xx=client fault, 5xx=server fault
- 2xx: 200/201/202/204/206 with `Location` header requirement on 201 and `Retry-After` on 202
- 3xx: 301/302/307/308 redirect types; method preservation (307/308 vs 301/302); 304 conditional GET
- 4xx: 400/401/403/404/405/409/410/422/429 with semantic distinctions (401 vs 403, 404 vs 410, 400 vs 422)
- 5xx: 500/502/503/504 with AWS ALB sources; 502=bad response, 504=timeout
- Decision tree: auth → validation → rate limit → server error → success
- The 504 uncertainty problem: backend may have processed before ALB timeout → check before retry

**Continue to File 02** for real-world examples (GitHub API error codes, how ALB uses 5xx for health routing), system design considerations (error code monitoring, alerting on 5xx vs 4xx spikes), AWS-specific status codes (CloudFront, ALB, API Gateway), and 8 interview Q&As.
