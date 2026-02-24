# REST Architecture — Part 2 of 3

### Topic: Architecture Diagram, Production Scenarios, Scaling & Reliability, AWS Mapping

**Series:** Backend & API Design → System Design → AWS Solutions Architect
**Sections Covered:** 5, 6, 7, 8

---

## SECTION 5 — Architecture Diagram

### Production REST API System Architecture

```
                        ┌─────────────────────────────────────────────────────────┐
                        │                    EXTERNAL CLIENTS                       │
                        │                                                           │
                        │  [Mobile App]  [Web SPA]  [Partner API]  [Internal Svc] │
                        └──────────────────────┬──────────────────────────────────┘
                                               │ HTTPS
                                               ▼
                        ┌─────────────────────────────────────────────────────────┐
                        │                    CLOUDFRONT CDN                        │
                        │                                                           │
                        │  - Static assets cached at edge (JS, CSS, images)       │
                        │  - API responses cached for GET endpoints (max-age)     │
                        │  - DDoS absorption at edge (Shield Standard)            │
                        │  - Geo-restriction, WAF rules                           │
                        └──────────────────────┬──────────────────────────────────┘
                                               │ Cache MISS or non-cacheable
                                               ▼
                        ┌─────────────────────────────────────────────────────────┐
                        │                   API GATEWAY                            │
                        │                                                           │
                        │  - JWT / OAuth2 token validation                        │
                        │  - Rate limiting: 1000 req/min per user                 │
                        │  - Request/response transformation                       │
                        │  - API versioning: /v1/, /v2/                           │
                        │  - Usage plans + API keys for partners                  │
                        │  - Access logging → CloudWatch                          │
                        └──────────┬─────────────────────────┬────────────────────┘
                                   │ /orders, /users          │ /products, /catalog
                                   ▼                          ▼
              ┌────────────────────────────┐  ┌─────────────────────────────────────┐
              │   APPLICATION LOAD BALANCER│  │   APPLICATION LOAD BALANCER         │
              │   (Order Service Fleet)    │  │   (Product Service Fleet)           │
              │   - Health checks          │  │   - Health checks                   │
              │   - AZ distribution        │  │   - Path-based routing              │
              └──────────┬─────────────────┘  └───────────────┬─────────────────────┘
                         │                                     │
                         ▼                                     ▼
     ┌───────────────────────────────────┐   ┌────────────────────────────────────┐
     │  ORDER SERVICE (ECS Fargate)      │   │  PRODUCT SERVICE (ECS Fargate)     │
     │  - Stateless REST API             │   │  - Stateless REST API              │
     │  - POST /orders                   │   │  - GET /products (cacheable)       │
     │  - GET /orders/{id}               │   │  - GET /products/{id}              │
     │  - Input validation (Pydantic)    │   │  - Search /products?q=             │
     │  - Business logic                 │   │  - Read-heavy: hits read replica   │
     │  - Idempotency key checks         │   │                                    │
     │  - Min 3 tasks / AZ              │   │  Min 2 tasks / AZ                  │
     └───────┬───────────┬───────────────┘   └─────────────┬──────────────────────┘
             │           │                                   │
             ▼           ▼                                   ▼
   ┌──────────────┐  ┌──────────────┐              ┌──────────────────────────────┐
   │ ELASTICACHE  │  │ ELASTICACHE  │              │      ELASTICACHE REDIS       │
   │ REDIS        │  │ REDIS        │              │   (Product catalog cache)    │
   │ (Idempotency │  │ (Rate limits │              │   - Cache-aside pattern      │
   │  key store)  │  │  + Sessions) │              │   - TTL: 300s per product    │
   │ TTL: 24h     │  │ TTL: 60s     │              │   - Hit rate target: 90%+    │
   └──────────────┘  └──────────────┘              └──────────────────────────────┘
             │                                                   │
             ▼                                                   ▼
   ┌──────────────────────────────────────────────────────────────────────────────┐
   │                        AURORA POSTGRESQL (Multi-AZ)                          │
   │                                                                               │
   │  Primary (us-east-1a): Writes (INSERT/UPDATE/DELETE)                        │
   │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────────────────┐  │
   │  │  orders     │  │  inventory  │  │  users / payment_methods / sessions  │  │
   │  │  order_items│  │  reservations│  │                                     │  │
   │  └─────────────┘  └─────────────┘  └─────────────────────────────────────┘  │
   │                                                                               │
   │  Read Replica (us-east-1b): GET queries, reporting queries                  │
   │  Read Replica (us-east-1c): Analytics queries, backup                       │
   └──────────────────────────────────────────────────────────────────────────────┘
             │
             ▼
   ┌──────────────────────────────────────────────────────────────────────────────┐
   │                    ASYNC LAYER (SQS + EventBridge)                           │
   │                                                                               │
   │  order.confirmed event →  [Email Service Lambda]                            │
   │                        →  [Inventory Service: finalize reservation]         │
   │                        →  [Analytics Service: conversion tracking]          │
   │                        →  [Notification Service: push notification]         │
   │                                                                               │
   │  Dead Letter Queue (DLQ): failed messages → alert → manual remediation      │
   └──────────────────────────────────────────────────────────────────────────────┘
```

### Component Responsibilities Explained

**CloudFront (Edge Layer)**

- Caches `GET /products/{id}` responses at edge — 90% of product reads never hit origin
- Does NOT cache `POST /orders` — POST is not cacheable (modifies state)
- Absorbs DDoS at edge — SYN floods, volumetric HTTP attacks handled before reaching origin
- `Cache-Control: public, max-age=300` on product responses = 300s cache at edge per PoP

**API Gateway (Contract Enforcement Layer)**

- Single entry point for all API clients — hides internal service topology
- JWT validation: decodes + verifies signature → extracts `user_id`, `role` → passes in request header to downstream
- Rate limiting: per-user token bucket (1000 req/min) → 429 response before any compute costs
- API versioning: `/v1/orders` and `/v2/orders` can coexist → enables backward-compatible evolution
- Access logs: every request logged → Request ID → end-to-end trace correlation

**Application Load Balancer (Availability Layer)**

- Distributes across 3 AZs → no single AZ failure takes down service
- Health checks every 10s → unhealthy task removed in under 30s → ~0% requests to bad instances
- Connection draining: 30s to complete in-flight requests before removing task from rotation

**Order Service (Business Logic Layer)**

- Stateless: reads everything needed from the JWT + request body
- No server-side sessions: user_id comes from JWT, not from memory
- Idempotency: checks Redis before processing — prevents double charges
- Validation: schema validation (400) → authorization check (403) → business rules (409)
- Transaction management: inventory reserve + order create in single DB transaction

**ElastiCache Redis (State & Caching Layer)**

- Idempotency store: key = Idempotency-Key header value, value = completed response, TTL = 24h
- Rate limit counters: atomic INCR + EXPIRE → correct counting under concurrent requests
- Product cache: cache-aside pattern — app reads cache → miss → read DB → write cache
- Session data: if you do use sessions (for WebSocket apps), Redis ensures sessions survive pod restarts

**Aurora Multi-AZ (Persistence Layer)**

- **Primary writes** go to one instance → synchronously replicated to standby in different AZ
- AZ failure: automatic failover to standby in ~30s (< 60s with Aurora)
- **Read replicas** absorb read traffic → product catalog reads don't compete with order writes
- Connection pool: RDS Proxy in front of Aurora → Lambda/serverless can connect without exhausting DB connections

**SQS + EventBridge (Decoupling Layer)**

- `POST /orders` completes in 122ms → returns 201 to user → async work starts in background
- Email failure: order still valid → DLQ catches failed jobs → team alerted → reprocess
- Downstream services (analytics, notifications) can fail without affecting order API reliability

---

## SECTION 6 — Real Production Scenarios

### Scenario 1 — Stripe Payment API: REST Design That Handles Network Chaos

Stripe is the gold standard for REST API design. They serve 250,000+ businesses and process hundreds of billions per year. Their APIs demonstrate how to design for network unreliability.

**The Problem Stripe Solves:**

```
Timeline of typical payment:
  Client → POST /charges → Server processes (charges card) → Client connection drops

  Client doesn't know:
    a) Did the charge succeed?
    b) Did the charge fail?
    c) Did the request even reach Stripe?

  Without idempotency: Client retries → DOUBLE CHARGE → customer angry → refund required
  With Stripe's approach:
```

**Stripe's Idempotency-Key Implementation:**

```http
POST /v1/charges
Authorization: Bearer sk_live_...
Idempotency-Key: order_123_attempt_1
Content-Type: application/x-www-form-urlencoded

amount=5000&
currency=usd&
source=tok_visa&
description=Order+123
```

```python
# Stripe's server-side logic (simplified):
def create_charge(request):
    idempotency_key = request.headers.get('Idempotency-Key')

    if idempotency_key:
        # Check if we've seen this key before
        existing = redis.get(f"stripe:idem:{idempotency_key}")
        if existing:
            # Return EXACT SAME response as original
            # Same status code, same response body, same headers
            return existing.response

    # Process the charge
    charge = process_payment(request.data)

    # Store result with 24h TTL
    redis.setex(
        f"stripe:idem:{idempotency_key}",
        86400,  # 24 hours
        serialize_response(charge, status=201)
    )

    return charge, 201

# CRITICAL INSIGHT:
# Stripe returns THE EXACT SAME RESPONSE (including same charge ID) on retry
# This means: client can safely retry indefinitely without fear of double-charging
```

**Stripe's Error Response Design:**

```json
{
  "error": {
    "type": "card_error",
    "code": "card_declined",
    "decline_code": "insufficient_funds",
    "message": "Your card has insufficient funds.",
    "param": "source",
    "charge": "ch_3MlmkY2eZvKYlo2C1234abcd",
    "doc_url": "https://stripe.com/docs/error-codes/insufficient-funds"
  }
}
```

Notice:

- Machine-readable `code` and `decline_code` (not just a string message)
- `doc_url` for debugging — human-readable explanation in browser
- Even for errors, the charge ID is returned — so you can query its full status
- HTTP status 402 (Payment Required) — correct semantic code, not 400 or 500

**What This Teaches You:**

1. Idempotency keys are non-optional for payment APIs — make them mandatory
2. Error responses need machine-readable codes (not just human messages)
3. Include enough context in error responses that clients can self-diagnose

---

### Scenario 2 — GitHub REST API: Versioning, Pagination, and Deprecation

GitHub serves millions of developers and has maintained API backward compatibility since 2010. Their REST API design is a masterclass in sustainable API evolution.

**Versioning Strategy:**

```
GitHub API URL: https://api.github.com/repos/torvalds/linux/issues

Header-based versioning (preferred pattern for mature APIs):
  GET /repos/torvalds/linux/issues
  Accept: application/vnd.github.v3+json   (explicit version in Accept header)

Path-based versioning (simpler for new APIs):
  GET /v1/repos/torvalds/linux/issues
  GET /v2/repos/torvalds/linux/issues      (new behavior, backward-incompatible)
```

**GitHub's Pagination (Link Header Pattern):**

```http
GET /repos/torvalds/linux/issues?page=1&per_page=30
Authorization: Bearer ghp_...

Response:
HTTP/1.1 200 OK
X-GitHub-Request-Id: BF8A:12345:67890
X-RateLimit-Limit: 5000
X-RateLimit-Remaining: 4987
X-RateLimit-Reset: 1709251200
Link: <https://api.github.com/repos/torvalds/linux/issues?page=2>; rel="next",
      <https://api.github.com/repos/torvalds/linux/issues?page=478>; rel="last"
```

Why `Link` header instead of in-body pagination:

- Response body contains pure data (issues array) — no metadata mixed in
- Link headers follow RFC 5988 (standard) — any HTTP client can parse
- `rel="next"` cursor tells client exactly where to go → stateless pagination
- Works with cursor-based pagination too (for large datasets where offset pagination fails)

**BAD Pagination (commonly copied but wrong):**

```json
{
  "data": [...],
  "pagination": {
    "current_page": 1,
    "total_pages": 478,
    "next_page": 2,
    "total_count": 14340
  }
}
```

Problem with this:

- `total_count` requires `COUNT(*)` query on every list request → expensive on large tables
- `total_pages` leaks internal data structure
- Offset-based pagination breaks under concurrent writes (rows shift → duplicate/missing items)

**GOOD: Cursor-Based Pagination (production-grade):**

```http
GET /api/v1/orders?limit=20
Response:
{
  "data": [...20 orders...],
  "next_cursor": "eyJpZCI6IjEwMDIwIiwiY3JlYXRlZF9hdCI6IjIwMjQtMDMtMDFUMTI6MDA6MDBaIn0=",
  "has_more": true
}

GET /api/v1/orders?limit=20&cursor=eyJpZCI6IjEwMDIwIi4uLg==
(Cursor decodes to: {id: "10020", created_at: "2024-03-01..."})
Server: WHERE (created_at, id) < ('2024-03-01...', '10020') ORDER BY created_at DESC
```

Why cursor-based:

- Stable across inserts/deletes (offset shifts, cursor doesn't)
- O(1) query (indexed column comparison vs `OFFSET 5000` which scans 5000 rows)
- Cannot leak total count (privacy-safe for competitive data)
- Works seamlessly with DynamoDB's `LastEvaluatedKey` (same pattern)

---

## SECTION 7 — Scaling & Reliability Impact

### Horizontal Scaling: Why REST Enables It

```
REST statelessness constraint → horizontal scaling is trivially possible.

Proof:
  Old stateful system:
    10 servers → each has 1,000 active sessions = 10,000 total sessions
    Add 10 more servers → new servers have 0 sessions
    Problem: only 10 original servers can serve existing users
    Sticky sessions: load balancer must route user A always to server 3
    Auto-scaling during spike: new servers useless until sessions migrate
    RTO for stateful scale-out: 5-15 minutes of degraded performance

  REST stateless system:
    10 servers → each has NO sessions (sessions in Redis)
    Add 10 more servers → all 20 servers can serve any user immediately
    Load balancer: pure round-robin, any server any user
    Auto-scaling during spike: new servers productive in 60-90 seconds
    RTO for stateless scale-out: 60-90 seconds (ECS task launch time)

  Numbers at peak:
    Stateful at 10× load: 2 original servers handling what 20 should → response time 500ms → 5000ms
    Stateless at 10× load: 20 servers each handling equal share → response time 500ms → 550ms
```

### Retries and Idempotency: The Correctness Contract

```
Network reality: ~0.1-1% of requests fail at the network layer (connection reset, timeout)
Client behavior: retry (automatically in most HTTP clients and SDKs)
Server behavior: depends on whether the endpoint is idempotent

Safe retries (idempotent):
  GET /orders/123        → retry safely, read is idempotent
  PUT /orders/123/status → retry safely, PUT is idempotent (same result each time)
  DELETE /orders/123     → retry safely, 404 on second call (resource already deleted)
                           BUT your code must treat 404 as success for DELETE retries

Unsafe retries (non-idempotent):
  POST /orders           → EACH retry creates a NEW order
  POST /payments         → EACH retry creates a NEW charge

  Solution: Idempotency-Key header + server-side deduplication

  Retry strategy with exponential backoff:
    Attempt 1: immediate
    Attempt 2: 1s delay
    Attempt 3: 2s delay
    Attempt 4: 4s delay
    Attempt 5: 8s delay  ← give up, return error to user

    With jitter: delay = min(cap, base * 2^attempt) + random(0, base)
    Prevents thundering herd: all retries not hitting server at exactly same time
```

### Distributed Systems Behavior: The Double-Write Problem

```
What breaks when engineers misunderstand REST statelessness in distributed systems:

Pattern: Order service writes to DB AND publishes event to SQS
  Step 1: INSERT order into DB
  Step 2: PUBLISH order.created to SQS

  Problem: What if Step 1 succeeds but Step 2 fails?
    Order exists in DB: user can retrieve it
    Event NOT in SQS: inventory/email/analytics never processes it
    No email → user thinks order failed → contacts support → confusion

  This is "dual write problem" — not a REST problem specifically,
  but triggered by REST because REST is synchronous (requires immediate response).

Solutions:
  Option A: Transactional Outbox Pattern
    Step 1: DB transaction: INSERT order + INSERT into outbox table
            Both committed atomically (one DB transaction)
    Step 2: Separate background process reads outbox table → publishes to SQS → deletes row
    Guarantee: Either both committed or neither (ACID)

  Option B: Change Data Capture (CDC)
    Write only to DB
    Debezium/DMS reads DB transaction log (binlog) → publishes events to Kafka
    No dual write risk: events sourced from DB commits

  Wrong solution: try-catch around SQS publish → silently fail on SQS error
    Result: ghost orders (in DB, no downstream processing)
    These are the incidents that wake you up at 3am
```

### Caching Layers and Cache Coherence

```
REST's "cacheable" constraint means you MUST think about cache invalidation.

Concrete scenario:
  Product price changes from $29.99 to $24.99 (flash sale at 2pm)

  Without cache invalidation strategy:
    CDN: cached /products/123 for 5 minutes (max-age=300)
    ElastiCache: cached product:123 for 5 minutes
    App-level: no cache

    User at 2:05pm (5 min after price update):
      CDN cache: still shows $29.99 (TTL not expired yet) ← WRONG
      User buys at $29.99 → order charged $29.99
      Expected price: $24.99
      Support ticket: "I saw $29.99, expected $24.99"

  Correct strategy: Cache invalidation on price change
    OPTION A: Short TTL (max-age=30s): tolerate 30s staleness
      Simple, no invalidation logic, small risk window
      Price update → max 30s until all caches expire → fresh data

    OPTION B: Cache-busting on write
      Price update → DELETE product:123 from ElastiCache
                   → CloudFront invalidation: aws cloudfront create-invalidation --paths "/products/123"
      Immediate consistency, slightly complex write path

    OPTION C: Event-driven invalidation
      Price update → publish event → cache invalidation Lambda →
        DELETE ElastiCache key → CloudFront invalidation
      Most robust, fully async, works across multiple cache layers

  Rule: Cache TTL = acceptable staleness window.
        If "stale price for 1 minute is fine": max-age=60.
        If "no stale prices ever": no caching on price field; use ETags only.
```

### What Breaks When Engineers Misunderstand REST

```
Misunderstanding 1: "REST means I use HTTP"
  Reality: You can use HTTP and violate every REST constraint:
    POST /getUser            ← verb in URL, wrong method
    GET /deleteUser?id=5     ← GET modifying state
    POST /login and store server-side session ← not stateless

  Production impact: Teams copy "REST-ish" patterns without getting benefits.
    Result: sticky sessions, scaling walls, tightly-coupled deployments.

Misunderstanding 2: "GET is safe, I'll use it everywhere"
  Engineers use GET for search queries with JSON body (e.g., POST-heavy search filters)
  Reality:
    GET + large query body = many CDNs and ALBs strip the body
    Solution: POST /search or GET /search?filters=... (query params for filters)
    Or: POST /search for complex queries (accept that it's not cacheable)

Misunderstanding 3: "HTTP 200 for everything, errors in body"
  {
    "status": "error",
    "code": "ORDER_NOT_FOUND",
    "message": "Order not found",
    "httpStatus": 200  ← WHY?
  }

  Impact:
    CDN caches 200 responses → caches your "not found" error forever
    Monitoring: error rate shows 0% (all requests are 200) → alerts don't fire
    Clients: can't use simple HTTP status check → must parse every response body
    Load balancer health checks: sees 200 when service is broken

Misunderstanding 4: "PUT and PATCH are the same"
  Engineer uses PUT with partial fields:
    PUT /users/123 { "email": "new@co.com" }
    → Correct REST: replaces ENTIRE user record with just email field
    → Result: name=null, address=null, phone=null — ALL OTHER FIELDS WIPED

  Reality: PUT = full replacement, PATCH = partial update
  Bug: Users losing data because engineer said "PUT" when they meant "PATCH"

Misunderstanding 5: "REST is stateless, so I don't need to handle the session anywhere"
  Engineer stores nothing in Redis, nothing in JWT
  "Authentication" on every request: DB lookup for session token

  Impact: Every single authenticated request hits DB
    100K users × 10 req/sec = 1M DB reads/sec just for session validation
    Aurora falls over. Site goes down.

  Fix: JWT (stateless, no DB lookup) or Redis session (fast, shared across pods)
```

---

## SECTION 8 — AWS Mapping

### REST API on AWS: Service-by-Service Mapping

**API Gateway — The Front Door**

```
AWS API Gateway plays two distinct roles for REST APIs:

REST API (v1) — full REST API with:
  - Usage plans (API keys + quota enforcement for partners)
  - Request/response transformation (mapping templates)
  - Per-stage throttling (dev: 100 req/s, prod: 10,000 req/s)
  - Resource policies (IP-based access control)
  - Custom domain names + ACM certificates
  - Built-in caching: up to 3600s per endpoint (in-memory cache in API GW itself)

HTTP API (v2) — lighter, faster, cheaper:
  - ~70% cheaper than REST API
  - Lower latency (~6ms vs ~10ms)
  - JWT authorizer natively (no custom Lambda authorizer needed)
  - No request transformation (just proxy to backend)
  - Use for: internal microservices, Lambda-backed APIs, no complex transforms needed

When to choose which:
  REST API (v1): partner integrations, OAuth scopes, request transforms, caching
  HTTP API (v2): high-volume internal APIs, simple Lambda backends, lower cost priority
```

**ALB — When API Gateway Isn't Needed**

```
Use ALB directly (not API Gateway) when:
  - Monolithic or traditional web app (not serverless)
  - WebSocket connections (ALB natively supports WebSocket)
  - gRPC (ALB supports HTTP/2 + gRPC natively)
  - High throughput (>29s timeout needed — API GW hard limit is 29s)
  - ECS or EC2 backend (ALB integrates natively with ECS service discovery)

  Difference:
    API Gateway: 29s max timeout (hard limit, non-negotiable)
    ALB: 4,000s idle timeout (configurable up to 4000s)

  For long-running requests (video processing, reports): ALB → async SQS pattern anyway
  For < 29s synchronous requests: either works; API GW adds auth/rate-limiting easier
```

**Lambda — Serverless REST Endpoints**

```
Serverless REST API pattern:
  API Gateway → Lambda (per HTTP method + path)

  Mapping:
    GET  /products     → Lambda GetProducts
    POST /orders       → Lambda CreateOrder
    GET  /orders/{id}  → Lambda GetOrder

  Lambda REST considerations:
    Cold start: 200ms-2s for first invocation (Python/Node: ~200ms; Java: ~2s)
    Mitigation: Provisioned concurrency for latency-sensitive endpoints

    Connection pools: Lambda creates new DB connection per execution
    Mitigation: RDS Proxy (manages connection pool, Lambda connects through proxy)

    Timeout: set to 3-10s for API endpoints (API GW cuts connection at 29s anyway)

  Cost comparison at 10M requests/month:
    Lambda (128MB, 500ms avg): ~$1.09/month (ideal for low-medium traffic)
    ECS Fargate (1 task, 0.25 vCPU): ~$10.70/month (fixed regardless of requests)

    Break-even: ~2M requests/month → Fargate becomes cheaper at high sustained traffic
```

**SQS — Decoupling REST API from Async Work**

```
Pattern: API Gateway → SQS (direct integration, no Lambda between them)

POST /orders → API Gateway (validation) → SQS → Lambda Consumer

Benefits:
  API Gateway returns 202 Accepted immediately (< 5ms)
  No Lambda cold start in the critical path
  SQS buffers spikes: 10,000 orders in 2s → SQS queues them → Lambda processes at 100/s
  At-least-once delivery + DLQ for failed orders

AWS Direct Integration (no Lambda middle tier):
  API Gateway POST /orders → SQS SendMessage (direct, no Lambda)
  SQS → Lambda Consumer (separate trigger)

  Cost saving: remove 1 Lambda invocation per request in the request path
  Latency: API GW → SQS is ~2ms (direct service integration, no cold start)

  Response: 202 Accepted + queue message ID
  Client polls: GET /orders/{id} → returns "pending", "processing", "complete"

When NOT to use API GW → SQS:
  User needs synchronous response (cart calculations, price checks)
  Request is idempotent and fast (< 100ms)
  Simple CRUD on small datasets (just use API GW → Lambda → DynamoDB)
```

**DynamoDB — REST API Data Storage**

```
DynamoDB is naturally REST-aligned:
  - HTTP-based API (all DynamoDB calls are HTTP requests to AWS endpoints)
  - Stateless operations (GetItem, PutItem, UpdateItem, DeleteItem)
  - Single-digit millisecond latency (< 5ms P99)

REST resource → DynamoDB mapping:
  GET /users/{id}        → GetItem(pk=USER#{id})
  POST /users            → PutItem (conditionExpression: attribute_not_exists(pk))
  PATCH /users/{id}      → UpdateItem(pk, ExpressionAttributeValues)
  DELETE /users/{id}     → DeleteItem(pk)
  GET /users/{id}/orders → Query(pk=USER#{id}, sk begins_with "ORDER#")

DynamoDB for idempotency:
  PutItem with ConditionExpression: attribute_not_exists(order_id)
  → First POST /orders: writes order record
  → Second POST (retry): ConditionExpression fails → ConditionalCheckFailedException
  → App catches exception → returns same 201 response → idempotent!

DynamoDB Optimistic Locking for PUT:
  GET /orders/123 → returns { ..., "version": 5 }
  Client modifies → PUT /orders/123 with version: 5
  Server: UpdateItem with ConditionExpression: version = 5
  If another client updated between GET and PUT: version is now 6 → condition fails
  Return: 409 Conflict → client re-fetches → retries with version 6
```

**CloudFront — REST Response Caching at Edge**

```
Map REST verbs to CloudFront caching behavior:

GET /products/{id}  → CloudFront CAN cache (safe + idempotent)
  Cache-Control: public, max-age=300 → cached for 5 minutes

GET /users/{id}/profile → CloudFront MUST NOT cache (user-specific private data)
  Cache-Control: private, no-store → CloudFront passes through every time

POST /orders → CloudFront DOES NOT cache (non-safe)
  CloudFront forwards all POST/PUT/PATCH/DELETE to origin (no caching possible)

CloudFront Cache Key for REST APIs:
  Default cache key: URL + Host header
  Problem: GET /products?sort=price&filter=electronics vs GET /products?filter=electronics&sort=price
           → same resource, different query string order → different cache keys → duplicate entries

  Fix: CloudFront Cache Policy → normalize query strings (sort alphabetically)
       → same resource always hits same cache entry regardless of query param order

  Real gotcha: if endpoint has Vary: Accept-Encoding header
    → CloudFront creates separate cache entry per encoding (gzip, br, identity)
    → This is CORRECT behavior (different bytes per encoding)
    → But it explains why you see lower-than-expected cache hit rate
    → Solution: always return consistent encoding (always Brotli for browsers)
```

**ElastiCache — REST API Caching Patterns**

```
Two caching patterns for REST APIs:

Pattern 1: Cache-Aside (Lazy Loading)
  GET /products/123:
    1. Check Redis: GET product:123
    2. HIT → return cached JSON immediately (< 1ms)
    3. MISS → query Aurora → store in Redis (SET product:123 ... EX 300) → return

  Write operation (price update):
    1. UPDATE products SET price = 24.99 WHERE id = 123
    2. DEL product:123 from Redis (invalidate)

  Tradeoff:
    First request after invalidation: cache miss → DB read → slightly higher latency
    Subsequent requests: cache hit → fast
    Cache staleness: only during TTL window if you don't explicitly invalidate

Pattern 2: Write-Through
  Every write updates both DB and cache simultaneously

  UPDATE products SET price = 24.99 WHERE id = 123
  SET product:123 (new JSON with updated price)

  Tradeoff:
    Reads: always cache hits (no cold cache after write)
    Writes: slightly slower (must update both DB and cache)
    Risk: DB write succeeds + cache write fails → inconsistency
    Mitigation: accept eventual consistency OR use Lua script for atomicity

When to choose:
  Cache-aside: read-heavy, write-heavy-invalidation OK, simpler implementation
  Write-through: write-tolerable latency, need read consistency, low cache miss tolerance
```

### Complete AWS REST Architecture Example

```
Use case: E-commerce product catalog API (read-heavy, global)

  1M users/day, 30 product reads per user, 50K products in catalog
  = 30M product reads/day = 347 reads/second average (1,000/s peak)

  Architecture:

    Route 53 (Latency routing) → users go to nearest AWS region

    CloudFront Distribution:
      GET /api/v1/products/* → Cache-Control: public, max-age=300
      GET /api/v1/products?search=* → Cache-Control: public, max-age=60
      ALL POST/PUT/PATCH/DELETE → forward to ALB (no caching)

    API Gateway (HTTP API v2):
      JWT Authorizer (for authenticated endpoints)
      Rate limiting: 100 req/s per user (products catalog: public, no auth)

    ALB + ECS Fargate (product-service):
      2 tasks in us-east-1a, 2 tasks in us-east-1b
      auto-scale on ALBRequestCountPerTarget > 500

    ElastiCache Redis (cache-aside):
      Cache key: product:{id}
      TTL: 300s
      HIT rate target: 95% (with CloudFront absorbing 80%, ElastiCache handles remaining)

    Aurora PostgreSQL:
      1 write instance (admins updating products)
      2 read replicas (api reads)

  Traffic math:
    347 reads/sec →
      CloudFront absorbs: 347 × 80% = 278 req/s (cache hits at edge)
      ElastiCache absorbs: 347 × 19% = 66 req/s (cache hits in-VPC)
      Aurora reads: 347 × 1% = 3.47 req/s (only cold cache misses hit DB)

  Cost (monthly):
    CloudFront (30M GETs × 5KB avg): $12 data + $3 requests = ~$15/month
    API Gateway (6M origin requests): $21/month
    ECS Fargate (4 tasks × 0.25vCPU): $43/month
    ElastiCache (cache.r6g.large): $115/month
    Aurora (db.r6g.large + 1 replica): $280/month
    Total: ~$474/month for 30M reads/day at < 10ms P95 globally
```

---

## File Summary

This file covered:

- Full ASCII production architecture: CDN → API GW → ALB → Services → Redis → Aurora → SQS
- Component responsibilities: why each layer exists, what it decides/enforces
- Stripe: idempotency-key implementation, machine-readable error codes, the payment retry problem
- GitHub: versioning strategy, Link header pagination, cursor-based vs offset pagination tradeoffs
- Horizontal scaling: stateless services scale in 60s vs stateful services with sticky-session walls
- Retry and idempotency: exponential backoff with jitter, safe vs unsafe retries by HTTP method
- Dual write problem: transactional outbox pattern, CDC with Debezium — don't do ad-hoc dual writes
- 5 "what breaks" misunderstandings: GET for mutations, 200 for errors, PUT vs PATCH confusion, sessions in code vs Redis
- AWS service mapping: API Gateway v1 vs v2, ALB vs API GW decision, Lambda cold starts + RDS Proxy, SQS decoupling, DynamoDB idempotency, CloudFront cache key normalization, ElastiCache cache-aside vs write-through
- Full cost breakdown: 30M reads/day at $474/month with 95% cache hit rate

**Continue to File 03** for Interview Preparation, Comparison Tables, Quick Revision, and the Architect Thinking Exercise.
