# REST Architecture — Part 1 of 3

### Topic: Intuition, Why It Exists, Core Technical Deep Dive, API Contract & Request Flow

**Series:** Backend & API Design → System Design → AWS Solutions Architect
**Sections Covered:** 1, 2, 3, 4

---

## SECTION 1 — Intuition (Non-Technical First)

### The Restaurant Order System

Imagine a busy restaurant. There are customers, waiters, and a kitchen.

Before they standardized their process, every waiter had their own way of communicating with the kitchen:

- Waiter A shouted orders in a specific code only he understood
- Waiter B passed handwritten notes in a format only she knew
- Waiter C walked directly into the kitchen and spoke to specific cooks
- When a new waiter joined, they couldn't communicate with the kitchen at all
- When cook #3 went on vacation, orders that went to cook #3 were just lost

**The kitchen was completely dependent on knowing who was asking and how they asked.**

The restaurant owner finally said: **"From today, every order goes on a standard order slip. It says WHAT table, WHAT item, WHAT quantity. The kitchen doesn't care which waiter brought it. The waiter doesn't care which cook fulfills it. The slip is the contract."**

Now:

- Any waiter can take any order
- Any cook can fulfill any slip
- You can hire new waiters in 10 minutes — they just learn the slip format
- If cook #3 is absent, cook #4 picks up the same slip
- The kitchen can be completely rebuilt without waiters ever knowing

**That is REST.** The "slip" is the HTTP contract. The waiter is the client. The kitchen is the server. The rule that the kitchen doesn't remember which waiter brought the last order is **statelessness**. The rule that the slip format is universal is **uniform interface**.

### The Second Insight — The Postal System

Think about how the postal system works at scale:

- You write a letter and put the address on the envelope
- You don't call the post office and say "hey it's me, remember I sent a letter last week?"
- Every letter is self-contained: sender, recipient, content
- The post office doesn't need a "session" with you to process your letter
- This is why the postal system scales to billions of letters — no memory per customer

**REST works the same way.** Every HTTP request must carry everything the server needs. No "I'm the same person from 2 minutes ago" context. This is why REST can run on 1,000 servers — any server can handle any request.

---

## SECTION 2 — Why This Concept Exists

### The Pre-REST World: RPC and SOAP (and the chaos it caused)

Before REST became dominant (early-to-mid 2000s), two major patterns ran the internet's backend communication:

**1. RPC (Remote Procedure Call):**

```
Client called: getOrderStatus(sessionId=12345, orderId=67890)
  → Server looked up session 12345 → found user context → processed order 67890

Problem:
  Session 12345 only exists on SERVER-1
  If SERVER-1 goes down → session 12345 is gone
  CLIENT must reconnect and re-authenticate
  LOAD BALANCER must send the same client to the same server (sticky sessions)
  5,000 users × 5 servers = 1,000 sessions per server
  Scaling becomes: more sessions = more memory = bigger servers (vertical only)
  Cannot horizontally scale without complex session synchronization
```

**2. SOAP (Simple Object Access Protocol):**

```xml
<!-- Every request looked like this: -->
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <GetOrderStatusRequest>
      <SessionToken>abc123</SessionToken>
      <OrderId>67890</OrderId>
    </GetOrderStatusRequest>
  </soap:Body>
</soap:Envelope>

Problem:
  WSDL files described every operation (50KB XML to describe 5 API methods)
  Client code was generated from WSDL → tightly coupled
  Change WSDL → regenerate all client code → redeploy all consuming teams
  Cross-platform integration (Java server ↔ Python client): months of work
  No standard for error handling → every team invented their own error codes
```

### What Was Actually Breaking in Production

1. **Scaling walls**: sticky sessions meant you couldn't scale stateless. Black Friday hits → can't add servers quickly enough because session state is stuck to existing servers.

2. **Deployment coupling**: 1 team changed an API → 8 consumer teams had to redeploy. Coordinating 8 teams for a field name change took weeks.

3. **Discovery problems**: You couldn't tell what an API did without calling the vendor. No uniform way to describe "what operations exist on this resource."

4. **Load balancer complexity**: HAProxy with sticky session config, complex health checks, session drain logic — all because servers had memory about who was talking to them.

5. **Caching impossible**: Because responses were tied to sessions, CDNs and proxies couldn't cache anything. Every request was unique context.

### Roy Fielding's Insight (2000)

Roy Fielding published his PhD dissertation defining REST as a style of architectural constraints for hypermedia systems. He was one of the authors of HTTP/1.1 and observed: **"HTTP already has everything we need — we just need to use it correctly."**

The insight: **The web itself (HTML pages, browsers) had already solved these problems.** Browsers don't maintain sessions for pages. Each page request is independent. Pages are cacheable. URLs name resources. Links tell you what you can do next. Just apply these same principles to data APIs.

### What Happens in Production If You Ignore REST Constraints

**Real incident pattern** (happens in every large team that skips statelessness):

```
Monday: 50K users → 2 app servers (works fine)
Friday (sale): 500K users → need 20 app servers → auto-scale adds 18 servers
Problem: 50K existing users have sessions ONLY on original 2 servers
         → 90% of auto-scaled capacity is useless for existing sessions
         → Load balancer routes by session affinity → 2 servers die under load
         → 500K users: cart lost, orders lost, re-authentication required
         → Site appears down even though 18 servers are idle

Root cause: Violated statelessness constraint
Fix: Move session to external store (Redis) + make servers truly stateless
Result: any of 20 servers can process any request → scale freely
```

---

## SECTION 3 — Core Technical Explanation

### REST Is Not a Protocol — It's a Set of Constraints

**REST (Representational State Transfer)** is an architectural style defined by 6 constraints. When all 6 are satisfied, the system gains specific properties (scalability, visibility, reliability). Violate any constraint and you lose specific properties.

```
Constraint                    Property Gained
─────────────────────────────────────────────────────────
1. Stateless                  Horizontal scalability, reliability
2. Client-Server              Separation of concerns, independent evolution
3. Cacheable                  Efficiency, performance, CDN compatibility
4. Uniform Interface          Simplicity, discoverability, loose coupling
5. Layered System             Security, load balancing, CDN insertion
6. Code on Demand (optional)  Extensibility (JavaScript delivery)
```

### Constraint 1 — Stateless (THE Most Important)

```
Definition: Each request from client to server MUST contain all information needed
            to understand the request. Server stores NO session state.

What this means in code:

BAD (Stateful API):
  POST /login          → server creates session_id=abc123, stores user_id=42 in memory
  GET /orders          → client sends cookie: session_id=abc123
                       → server looks up session_id=abc123 → gets user_id=42
                       → reads user 42's orders

  Problems:
    Server must store session. 10K users = 10K sessions in RAM.
    Session lives on SERVER-1. Load balancer must always send you to SERVER-1.
    SERVER-1 dies → your session dies → you're logged out.

GOOD (Stateless API):
  POST /login          → server creates JWT token containing {user_id: 42, role: "user", exp: 1h}
                       → token signed with server's private key
                       → returns token to client
  GET /orders          → client sends: Authorization: Bearer eyJhbGc...
                       → ANY server receives → decodes JWT → extracts user_id=42
                       → reads user 42's orders

  Benefits:
    Any server can process any request.
    Add 100 servers → all can serve all users immediately.
    Server restart → no sessions lost.
    CDN, proxies, load balancers can route freely.
```

### Constraint 2 — Uniform Interface (The 4 Sub-constraints)

```
The "uniform interface" is what makes REST uniquely REST.
It has 4 sub-constraints:

(a) Resource Identification via URIs:
    Resources are nouns, not verbs. URIs name things.

    BAD  (RPC-style URIs):
      POST /getOrder           ← verb in URI
      POST /createOrder        ← resource unclear
      GET  /processPayment     ← action in URI
      GET  /deleteUser?id=5    ← dangerous: GET should not modify

    GOOD (REST URIs):
      GET    /orders           ← collection of orders
      GET    /orders/123       ← specific order
      POST   /orders           ← create a new order
      PUT    /orders/123       ← full replacement of order 123
      PATCH  /orders/123       ← partial update of order 123
      DELETE /orders/123       ← remove order 123

(b) Manipulation via Representations:
    Client has a representation (JSON, XML) of the resource.
    Modifying the representation and sending it back modifies the resource.

    GET /users/42 → returns { "name": "Alice", "email": "alice@co.com" }
    PATCH /users/42 with body { "email": "new@co.com" } → updates just email

(c) Self-Descriptive Messages:
    Each message includes enough information to describe how to process it.
    Content-Type: application/json tells the server how to parse the body.
    Accept: application/json tells the server what format to return.

(d) HATEOAS (Hypermedia As The Engine Of Application State):
    Responses include links to related actions/resources.
    (Rarely fully implemented in practice, but the ideal):

    GET /orders/123 returns:
    {
      "id": 123,
      "status": "confirmed",
      "_links": {
        "self":   { "href": "/orders/123" },
        "cancel": { "href": "/orders/123/cancel", "method": "POST" },
        "items":  { "href": "/orders/123/items" }
      }
    }
    Client navigates the API via links → no hardcoded endpoint knowledge
```

### Constraint 3 — Cacheable

```
HTTP defines caching semantics. REST leverages them.

GET /products/456
  Response:
    Cache-Control: public, max-age=300   ← cacheable for 5 minutes
    ETag: "abc123hash"                   ← content fingerprint

  Second request (within 5 minutes):
    Client or CDN returns cached response → origin never called

  After 5 minutes, conditional request:
    GET /products/456
    If-None-Match: "abc123hash"

    If unchanged: 304 Not Modified (no body) → save bandwidth
    If changed: 200 with new content + new ETag

POST/PUT/DELETE: NOT cacheable by default (modifying state)
Only GET and HEAD should be cached.

Production impact:
  Product catalog: Cache-Control: public, max-age=300
  → 1,000 users request same product in 5 minutes
  → 1 actual database query → 999 cache hits (CDN or ElastiCache)
  → 99.9% load reduction for reads
```

### Constraint 4 — Stateless HTTP Methods and Their Semantics

```
HTTP Method    Safe?  Idempotent?   Use Case
─────────────────────────────────────────────────────────────────
GET            YES    YES           Read resource (no side effects)
HEAD           YES    YES           Get headers only (check existence)
OPTIONS        YES    YES           Discover allowed methods (CORS preflight)
POST           NO     NO            Create resource / send data (not idempotent!)
PUT            NO     YES           Full replace resource (idempotent)
PATCH          NO     NO *          Partial update (idempotent if designed right)
DELETE         NO     YES           Remove resource (idempotent)

Safe: Request causes no side effects on server
Idempotent: Sending the same request N times = same effect as sending it once

WHY idempotency matters:
  Network failure → retry logic → duplicate requests

  PUT /orders/123/status with body {"status": "shipped"}
    Call it once: order status = "shipped" ✅
    Call it again (retry): order status = "shipped" ✅ (same result)
    Call it 10 times: order status = "shipped" ✅ (safe to retry)

  POST /orders (create new order)
    Call it once: order 123 created ✅
    Call it again (retry): order 124 created ❌ (DUPLICATE ORDER)
    Call it 10 times: 10 duplicate orders ❌❌❌

  This is why idempotency keys exist for POST operations.
```

### Good vs Bad REST Implementation

```python
# BAD REST Implementation — violates multiple constraints

# BAD: Using GET to modify state (not safe)
GET /deleteOrder?id=123      # WRONG: GET is safe; this modifies data

# BAD: Verbs in URI
POST /order/createNewOrder   # WRONG: verb in URI
GET  /order/getOrderById/123 # WRONG: verb in URI, redundant

# BAD: Inconsistent resource naming
GET /Order/123               # WRONG: singular, capitalized
GET /orders/123              # RIGHT: plural, lowercase
GET /get-order-by-id/123     # WRONG: verb, inconsistent

# BAD: Returning 200 for errors
@app.route('/orders/<order_id>')
def get_order(order_id):
    order = db.find(order_id)
    if not order:
        return {"status": "error", "message": "not found"}, 200  # WRONG: 200 for error!

# BAD: Exposing database IDs directly
GET /users/1          # Auto-increment ID leaks your user count
GET /users/2          # Sequential IDs = enumeration attack vector

# ─────────────────────────────────────────────────────
# GOOD REST Implementation

# GOOD: Resources as nouns, HTTP verbs as actions
GET    /orders                    # List orders (paginated)
GET    /orders/{uuid}             # Get specific order
POST   /orders                    # Create order
PUT    /orders/{uuid}             # Full replace order
PATCH  /orders/{uuid}             # Partial update
DELETE /orders/{uuid}             # Delete order

# GOOD: Nested resources for relationships
GET  /users/{uuid}/orders         # Orders belonging to user
GET  /orders/{uuid}/items         # Items in an order
POST /orders/{uuid}/items         # Add item to order

# GOOD: Correct HTTP status codes
@app.route('/orders/<order_id>')
def get_order(order_id):
    order = db.find(order_id)
    if not order:
        return {"error": "order_not_found", "message": "Order does not exist"}, 404
    return order.to_dict(), 200

# GOOD: Using UUIDs to avoid enumeration
GET /orders/f47ac10b-58cc-4372-a567-0e02b2c3d479   # UUID: no enumeration
```

### HTTP Status Code Reference for REST APIs

```
2xx — Success
  200 OK              GET success, PATCH success, PUT success
  201 Created         POST success: new resource created
                      Response MUST include Location: /orders/uuid header
  204 No Content      DELETE success, PUT success with no response body

3xx — Redirection
  301 Moved Permanently   Resource moved to new URI (update your bookmarks)
  304 Not Modified        Conditional GET: content unchanged (use cached version)

4xx — Client Error (YOU did something wrong)
  400 Bad Request         Malformed JSON, missing required field, validation failure
  401 Unauthorized        Not authenticated (no token or invalid token)
  403 Forbidden           Authenticated but not authorized (valid token, wrong role)
  404 Not Found           Resource doesn't exist
  405 Method Not Allowed  PUT on /orders (collection); use POST
  409 Conflict            Create resource that already exists; optimistic lock conflict
  422 Unprocessable       Syntactically valid but semantically wrong (birthday in future)
  429 Too Many Requests   Rate limit exceeded

5xx — Server Error (WE did something wrong)
  500 Internal Server Error   Unhandled exception, bug
  502 Bad Gateway             Upstream service returned invalid response
  503 Service Unavailable     Server overloaded, maintenance
  504 Gateway Timeout         Upstream service timed out
```

---

## SECTION 4 — API Contract & Request Flow

### Real API Example: E-Commerce Order Placement

**Scenario**: User places an order with multiple items. Inventory must be checked, payment authorized, order created, email sent.

#### The HTTP Contract

```
POST /api/v1/orders
Host: api.shopnow.com
Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.eyJ1c2VyX2lkIjoiZjQ3YWMxMGIiLCJleHAiOjE3MDkwMDAwMDB9.sig
Content-Type: application/json
Idempotency-Key: 7f8b9c0d-1e2f-3a4b-5c6d-7e8f9a0b1c2d
Accept: application/json
X-Request-ID: req_20240301_abc123

{
  "items": [
    { "product_id": "prod_abc123", "quantity": 2, "unit_price": 29.99 },
    { "product_id": "prod_def456", "quantity": 1, "unit_price": 49.99 }
  ],
  "shipping_address": {
    "line1": "123 Main St",
    "city": "Austin",
    "state": "TX",
    "zip": "78701",
    "country": "US"
  },
  "payment_method_id": "pm_visa_ending_4242"
}
```

#### Server Processing Flow

```
Step 1: API Gateway receives request
  ↓ Rate limit check: user f47ac10b → 8 requests in last minute → OK (limit: 60/min)
  ↓ JWT validation: decode token → verify signature → check expiry
  ↓ Extract: user_id = "f47ac10b", role = "customer"
  ↓ Route to: Order Service (POST /orders)

Step 2: Idempotency Key Check (CRITICAL)
  ↓ Check Redis: key "idempotency:7f8b9c0d-1e2f-3a4b-5c6d-7e8f9a0b1c2d" exists?
    → EXISTS with value {"order_id": "ord_xyz", "status": 201}: return cached response
      (This request was already processed — client retried due to network timeout)
    → NOT EXISTS: proceed with processing; set key with 24h TTL AFTER processing

Step 3: Request Validation
  ↓ Schema validation (Pydantic/Marshmallow):
    items: array, min 1, max 50 items
    quantity: integer, min 1, max 100
    unit_price: decimal, min 0.01
    shipping_address: all fields required
    payment_method_id: string, format validated
  ↓ Business validation:
    user f47ac10b: account active? not suspended?
    payment_method_id pm_visa_4242: belongs to user f47ac10b? ← AUTHORIZATION CHECK

Step 4: Inventory Check
  ↓ SELECT stock FROM inventory WHERE product_id IN ('prod_abc123', 'prod_def456')
       FOR UPDATE SKIP LOCKED;  ← pessimistic lock to prevent oversell
    prod_abc123: stock=50, requested=2 → OK
    prod_def456: stock=0,  requested=1 → INSUFFICIENT STOCK
  ↓ Return 409 Conflict:
    {
      "error": "insufficient_stock",
      "message": "Product prod_def456 is out of stock",
      "out_of_stock_items": ["prod_def456"]
    }

  (Assume both in stock → continue)

Step 5: Reserve Inventory (database transaction starts)
  BEGIN TRANSACTION;
  UPDATE inventory SET reserved = reserved + 2 WHERE product_id = 'prod_abc123';
  UPDATE inventory SET reserved = reserved + 1 WHERE product_id = 'prod_def456';

Step 6: Payment Authorization
  ↓ Call Payment Service: authorize $109.97 on pm_visa_4242
    → External call to Stripe/Braintree
    → Returns: authorization_code = "auth_abc987"
  ↓ If payment fails:
    ROLLBACK TRANSACTION; (release reserved inventory)
    Return 402 Payment Required

Step 7: Create Order Record
  INSERT INTO orders (id, user_id, status, total, created_at)
    VALUES ('ord_xyz789', 'f47ac10b', 'CONFIRMED', 109.97, NOW());
  INSERT INTO order_items (order_id, product_id, quantity, unit_price)
    VALUES ('ord_xyz789', 'prod_abc123', 2, 29.99),
           ('ord_xyz789', 'prod_def456', 1, 49.99);
  COMMIT TRANSACTION;

Step 8: Post-Order Async Tasks (fire-and-forget via SQS/EventBridge)
  → Publish event: order.confirmed { order_id: "ord_xyz789" }
    Email service: sends confirmation email (async, non-blocking)
    Analytics service: records conversion event (async)
    Inventory service: finalizes reservation to deduction (async)

Step 9: Store Idempotency Key
  Redis SET "idempotency:7f8b9c0d..." '{"order_id": "ord_xyz789", "status": 201}' EX 86400

Step 10: Return Response
  HTTP/1.1 201 Created
  Location: /api/v1/orders/ord_xyz789
  Content-Type: application/json
  X-Request-ID: req_20240301_abc123

  {
    "order_id": "ord_xyz789",
    "status": "CONFIRMED",
    "total": 109.97,
    "estimated_delivery": "2024-03-05",
    "items": [
      { "product_id": "prod_abc123", "quantity": 2, "subtotal": 59.98 },
      { "product_id": "prod_def456", "quantity": 1, "subtotal": 49.99 }
    ],
    "_links": {
      "self":   "/api/v1/orders/ord_xyz789",
      "cancel": "/api/v1/orders/ord_xyz789/cancel",
      "track":  "/api/v1/orders/ord_xyz789/tracking"
    }
  }
```

#### Where Failures Occur (and What Happens)

```
Failure Point 1 — JWT Expired
  Symptom: 401 Unauthorized, {"error": "token_expired"}
  Client behavior: use refresh token → get new access token → retry
  Server behavior: stateless, checks exp claim, no server-side session to invalidate

Failure Point 2 — Validation Failure
  Symptom: 400 Bad Request with field-level errors
  {
    "error": "validation_failed",
    "details": [
      {"field": "items[0].quantity", "message": "must be at least 1"},
      {"field": "shipping_address.zip", "message": "invalid US zip code format"}
    ]
  }
  Client behavior: show errors to user → user corrects → resubmit
  Safe: no DB writes happened yet

Failure Point 3 — Network Timeout AFTER payment but BEFORE order saved
  Scenario: client sends request → server charges payment auth → DB write fails
  Client sees: connection timeout → retries with same Idempotency-Key

  Without idempotency key: SECOND charge authorization attempted →
                            two authorizations, one order (money debited twice potential)
  With idempotency key: server checks Redis → key NOT set (because we set it AFTER success)
                        → detects duplicate → COMPENSATING TRANSACTION:
                          find pending auth auth_abc987 → void it → return 500 to client
                          OR: complete the original operation (upsert logic)

  Correct pattern:
    1. Check idempotency key FIRST
    2. Process payment (get auth code)
    3. Try to create order record
    4. If DB fails: void payment authorization
    5. Set idempotency key ONLY after full success

Failure Point 4 — Partial Success (Email Fails)
  Order created → payment charged → SQS message published → Email service crashes
  Consequence: order exists, payment charged, no email sent
  Correct behavior: This is ACCEPTABLE. Email is async and non-critical.
    SQS: dead-letter queue catches failed email → retry up to 3 times → alert ops team
    Order is still valid. User is not double-charged.

Failure Point 5 — Double POST (client clicks "Place Order" twice)
  Without idempotency: two orders created, two charges
  With idempotency key: second request → Redis hit → return original 201 response → no duplicate

  UI-side mitigation: disable button on first click
  Server-side mitigation: idempotency key (more reliable, handles JS errors/network retries)
```

#### Complete Request → Response Timeline

```
Timeline for single order placement (latency breakdown):

  T+0ms    Client sends POST /orders
  T+5ms    API Gateway: JWT validation (cached public key: 0ms; new key fetch: 50ms)
  T+6ms    Rate limiter: Redis check (1ms)
  T+7ms    Idempotency key check: Redis check (1ms)
  T+8ms    Request validation: in-memory, sync (1ms)
  T+9ms    Inventory check: DB query (1ms same-AZ read replica)
  T+15ms   Reserve inventory: DB write + lock (6ms primary write, including disk flush)
  T+110ms  Payment authorization: Stripe API call (95ms external, P50)
  T+120ms  Order INSERT + items INSERT: DB transaction commit (10ms)
  T+121ms  SQS publish: fire-and-forget (1ms enqueue, non-blocking)
  T+122ms  Redis set idempotency key (1ms)
  T+122ms  Response returned to client

  Total: ~122ms P50
  P95: ~250ms (Stripe P95 ~180ms + DB write variance)
  P99: ~500ms (Stripe P99 + DB lock contention under load)

  Timeout budget:
    API Gateway: 29s max (AWS hard limit)
    Order service: 10s internal timeout
    Payment call: 5s timeout with 1 retry (total 11s max for payment)
    DB transaction: 3s timeout
```

---

## File Summary

This file covered:

- Restaurant order slip analogy: standardized interface = any waiter, any cook, stateless
- Postal system analogy: self-contained requests = horizontal scalability
- Pre-REST world: RPC (sticky sessions, scaling walls) and SOAP (WSDL coupling, deployment lock-in)
- Roy Fielding's 6 constraints: stateless, client-server, cacheable, uniform interface, layered, code-on-demand
- Stateless: JWT vs sessions; why statelessness enables horizontal scaling
- Uniform interface: resource naming (nouns not verbs), HTTP methods and their semantics
- Idempotency: GET/PUT/DELETE are idempotent; POST is not; why this matters for retries
- HTTP status codes: 2xx/3xx/4xx/5xx with correct usage
- Order placement API: full request/response contract, 10-step server processing flow
- Failure modes: JWT expiry, validation, payment timeout, partial success, double-POST protection via idempotency key

**Continue to File 02** for Architecture Diagram, Production Scenarios, Scaling & Reliability Impact, and AWS Mapping.
