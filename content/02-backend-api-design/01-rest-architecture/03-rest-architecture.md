# REST Architecture — Part 3 of 3

### Topic: Interview Preparation, Comparison Tables, Quick Revision, Architect Thinking Exercise

**Series:** Backend & API Design → System Design → AWS Solutions Architect
**Sections Covered:** 9, 10, 11, 12

---

## SECTION 9 — Interview Preparation

### Beginner Questions (Foundational Thinking)

**Q1: What is REST and what makes an API "RESTful"?**

_What the interviewer is actually testing:_ Do you understand REST as architectural constraints, or do you think "REST = JSON over HTTP"?

**Ideal Answer:**

REST is an architectural style defined by 6 constraints. An API is RESTful when it satisfies:

1. **Stateless**: Each request is self-contained. Server stores no session state. User identity travels in every request (JWT token). This is what enables horizontal scaling — any server can process any request.

2. **Uniform Interface**: Resources identified by URIs (nouns, not verbs). HTTP methods define the operation (GET reads, POST creates, PUT replaces, PATCH partial-updates, DELETE removes). Responses carry representations of resources (JSON, XML).

3. **Client-Server separation**: Client and server evolve independently. Frontend team can deploy without backend team approval, as long as the API contract is respected.

4. **Cacheable**: Responses explicitly declare whether they're cacheable (Cache-Control headers). GET responses to public data can be cached by CDN → dramatic origin load reduction.

5. **Layered System**: Client doesn't know if it's talking directly to the origin or through multiple proxies, CDNs, and load balancers.

6. **Code on Demand** (optional): Server can send executable code to clients (JavaScript).

Most "REST APIs" you see in production are actually **REST-ish** — they use HTTP and JSON but may violate statelessness (server-side sessions) or uniform interface (verb in URL, 200 for errors). True REST gives you: free CDN caching, horizontal scalability without sticky sessions, and client-server independence.

---

**Q2: Why should you use HTTP status codes correctly instead of always returning 200?**

_What the interviewer is actually testing:_ Do you understand how the HTTP ecosystem (CDN, monitoring, LBs) relies on status codes? Or do you treat HTTP as a transport layer you can ignore?

**Ideal Answer:**

Status codes are the communication protocol of the HTTP ecosystem. When you break them, you break everything that depends on them:

1. **Monitoring lies to you**: If errors return 200, your error rate metric shows 0%. Your PagerDuty never fires. An incident that's been running for 6 hours goes undetected because the monitoring graphs look healthy. You find out from a customer tweet.

2. **CDN caches your errors forever**: CloudFront caches 200 responses based on TTL. `GET /orders/123` returns 200 with `{"error": "not_found"}`. CDN caches it for 5 minutes. Even after the order IS found (application bug fixed), the next 10,000 users still get the cached "not found" error. Fix: return 404 → CDN doesn't cache 4xx by default.

3. **Load balancer health checks fail silently**: ALB health check sees 200 → marks target healthy. Your application's DB connection pool is full → every real request fails → but health check still sees 200. Traffic continues to a broken target.

4. **Client retry logic breaks**: HTTP clients know to retry on 503 (service unavailable) but not on 200. If you use 200 for "try again later", clients don't know to retry.

5. **Rate limiting signals lost**: 429 tells SDKs and clients to back off with exponential backoff. If you return 200 with `{"error":"rate_limited"}`, automated clients continue hammering at full rate.

Correct mapping: 404 = not found; 401 = not authenticated; 403 = not authorized; 409 = conflict; 422 = validation error; 429 = rate limited; 500 = server bug; 503 = overloaded.

---

**Q3: What is idempotency in REST? Give a concrete example of why it matters.**

_What the interviewer is actually testing:_ Can you connect idempotency to real production behavior (network retries, distributed systems)?

**Ideal Answer:**

Idempotency means: calling the same operation 1 time or N times produces the same result.

**GET** is always idempotent (reading doesn't modify state). **PUT** and **DELETE** are idempotent by definition. **POST** is NOT — each POST creates a new resource.

**Why it matters concretely:**

Networks fail unpredictably. A mobile app places an order: the server processes the payment, commits the order to the database, but the response packet gets dropped by the network. The app thinks "request failed" and retries. Without idempotency handling:

- Two orders created
- Customer charged twice
- Support ticket + refund required + brand damage

The fix is an `Idempotency-Key: <uuid>` header that the client sends. Server checks: have I seen this UUID before? If yes: return the exact same response as last time (no processing). If no: process and store result.

Stripe makes this mandatory for their `/charges` endpoint. Amazon uses it for order creation. Any endpoint that processes money, sends messages, or creates unique records MUST be idempotent.

Side note: **DELETE idempotency requires special handling**. `DELETE /orders/123` the first time returns 200 or 204. The second time (retry), the order is already gone → returns 404. Your retry logic must treat 404 as success for DELETE operations, or you'll incorrectly detect a successful delete as a failure.

---

### Intermediate Questions (System Design Thinking)

**Q4: Design the API layer for a ride-hailing app (like Uber). What REST endpoints would you define, and what are the key reliability concerns?**

_What the interviewer evaluates:_ Resource modeling, state machine design, idempotency awareness, async patterns — not just "list all endpoints."

**Reasoning:**

```
Core resources and their REST representations:

Rides (state machine: REQUESTED → ACCEPTED → STARTED → COMPLETED/CANCELLED)
  POST /rides                          → request a ride (NOT idempotent → idempotency key required)
  GET  /rides/{ride_id}                → get ride status (polling for driver acceptance)
  PATCH /rides/{ride_id}/cancel        → cancel ride
  PATCH /rides/{ride_id}/start         → driver marks ride started
  PATCH /rides/{ride_id}/complete      → driver marks ride complete

Drivers
  GET    /drivers/{driver_id}/location → get driver's current location (sub-second cache needed)
  POST   /drivers/{driver_id}/location → update driver location (high frequency: every 5s)
  GET    /drivers/nearby?lat=30.2&lng=-97.7&radius=3km → find nearby drivers

Payments
  POST /rides/{ride_id}/payment        → trigger payment after completion
  GET  /rides/{ride_id}/receipt        → get ride receipt

Key reliability concerns:

1. POST /rides MUST have idempotency key:
   User taps "Request Ride" button → app sends POST → network timeout → user panics, taps again
   Without idempotency: 2 ride requests placed → 2 drivers dispatched → chaos
   With idempotency key: second request returns the first ride

2. Location updates are not REST-native — they're streaming:
   Driver location changes every 3-5 seconds
   GET /drivers/{id}/location (polling every 5s): 1,000 drivers × 200 riders polling = 200,000 req/min
   Better: WebSocket for driver location streaming to rider app
   REST API: fine for one-time queries; wrong for continuous streaming

3. Ride state transitions need optimistic locking:
   Driver A and Driver B both try to ACCEPT ride 123 simultaneously
   Without concurrency control: both accepted → two drivers for one ride
   With optimistic locking:
     GET /rides/123 → returns version: 1
     PATCH /rides/123/accept with version: 1
     → DB: UPDATE WHERE status='REQUESTED' AND version=1 → rows affected: 1 (success or 0 (conflict)
     First driver wins; second driver gets 409 Conflict

4. Payment is async:
   PATCH /rides/123/complete → ride marked complete
   Payment: POST /rides/123/payment → should be async (card processing takes time)
   Pattern: POST returns 202 Accepted → SQS → payment processor → webhook callback
   Rider app: polls GET /rides/123/receipt until it appears (or webhook push)
```

---

**Q5: Your REST API needs to handle 100,000 concurrent users. What architectural decisions ensure it stays stateless at scale?**

_What the interviewer evaluates:_ Whether you understand the operational implications of statelessness and where state inevitably lives in large systems.\*

**Reasoning:**

Statelessness is a spectrum. The goal isn't "no state" — it's "state in the right place":

**Authentication state → JWT (inside the request)**
Decode JWT with public key → extract user_id, role, permissions → no DB lookup on every request. Public key cached in-process (512-byte ECDSA key, 1ms to load). JWT expiry: 15 minutes. Refresh: separate endpoint `/auth/refresh` with Redis-backed refresh token (Redis gives you revocation capability).

**Session state → ElastiCache Redis (external, shared)**
If you need sessions (e.g., cart contents during checkout): store in Redis cluster with key `session:{session_token}`. Any of 100 Fargate tasks can read any session. Redis replication ensures session survives individual node failure. TTL: 30 minutes of inactivity.

**Rate limit counters → Redis (atomic INCR in Redis cluster)**
Per-user counters: `INCR ratelimit:{user_id}:{window}` with `EXPIRE ratelimit:{user_id}:{window} 60`. Atomic in Redis → no race conditions. Distributed across tasks without coordination.

**Idempotency keys → Redis with 24h TTL**
`SET idem:{key} {response_json} EX 86400 NX` — NX means only set if Not eXists → atomic check-and-set. No risk of two tasks writing different responses for the same key.

**Database connections → RDS Proxy (connection pool per task)**
100,000 concurrent requests across 50 Fargate tasks = 50 connection pools. Aurora max connections: ~5,000. With RDS Proxy: 50 tasks → Proxy → 100 DB connections (multiplex 50 tasks' connections into 100 DB connections). Stateless task restarts don't lose connection pools.

**What you NEVER store in application memory for stateless operation:**

- User sessions (dies with pod restart)
- Rate limit counters (each pod sees different count)
- Product/config cache that diverges between pods (stale cache in some pods, fresh in others)
- In-flight request state that needs to survive pod restarts

---

**Q6: A client team complains that your REST API keeps breaking their integration every few weeks. What went wrong architecturally and how do you fix it?**

_What the interviewer evaluates:_ API versioning strategy, backward compatibility rules, contract management, team dynamics.\*

**Reasoning:**

This is an **API contract violation problem**, not a technical bug.

**Root cause:** No version management + no backward compatibility discipline.

**What was probably happening:**

- Team adding required fields to POST bodies (existing clients don't send them → 400)
- Team renaming fields (client sends `user_name`, server now expects `username` → 400)
- Team removing fields from responses (client code reads `user.phone` → null suddenly)
- Team changing endpoint paths without redirects
- No API changelog or consumer notifications

**The fix is a combination of:**

1. **Semantic versioning in URLs**: `/v1/orders` is frozen. New breaking change goes to `/v2/orders`. Both coexist. Clients migrate on their own timeline. v1 sunset announced 6 months in advance with deprecation headers.

2. **Backward compatibility rules** (never break these):
   - Never remove a field from a response (add to new version instead)
   - Never rename a field (add new name, deprecate old, remove in v+2)
   - Never make an optional request field required (add to v+1 as required)
   - Adding new optional fields to request: safe
   - Adding new fields to response: safe (clients ignore unknown fields)

3. **Consumer-Driven Contract Testing**: consuming team defines the contract they expect → your CI pipeline runs their contract tests against your API on every deploy → build fails if their contract breaks before it reaches production.

4. **Deprecation headers**: Add `Deprecation: true`, `Sunset: Mon, 01 Jan 2025 00:00:00 GMT`, `Link: </v2/orders>; rel="successor-version"` to v1 responses. Clients monitoring response headers get automated warnings.

---

### Advanced Questions (Architecture Discussion)

**Q7: You're designing a public REST API for a platform (like Twilio or Stripe) that thousands of external developers will integrate with. What are your top 5 architectural concerns and how do you address them?**

_What the interviewer evaluates:_ Platform API design thinking, ecosystem impact, SLA reliability, developer experience, monetization alignment.\*

**Discussion Points:**

```
1. BACKWARD COMPATIBILITY IS SACRED
   Unlike internal APIs, external API changes break code you don't control.
   You cannot grep for all usages. You cannot coordinate a deployment.
   External developer upgrades happen on their timeline, not yours.

   Decision:
     - HTTP API versioning (/v1, /v2) with 12-month sunset SLA
     - NEVER remove a field; only add, deprecate, sunset
     - Consumer contract testing is non-negotiable (Pact testing framework)
     - Version sunset emails 90 days, 30 days, 7 days before cutoff
     - Legacy version sunset requires response body warning for 30 days:
       X-API-Deprecation-Warning: v1 will be discontinued on 2025-06-01. Migrate to /v2.

2. IDEMPOTENCY AS A FIRST-CLASS FEATURE
   External developers will have unreliable networks, retry logic, webhooks.
   Make Idempotency-Key mandatory for all mutating operations.
   Document it prominently. Stripe lost this battle early; they now call it their most
   important API design decision.

3. DEVELOPER EXPERIENCE = ADOPTION
   Error messages must be self-diagnosable:
     Bad: {"error": "invalid_request"}
     Good: {
             "error": "validation_failed",
             "message": "phone_number format invalid. Expected E.164 (e.g. +14155552671)",
             "param": "phone_number",
             "doc_url": "https://docs.your-api.com/errors/E001"
           }
   Every error must point to documentation.
   Every error must have a machine-readable code (for SDK automation).

4. RATE LIMITING + FAIR USAGE
   One bad client (or malicious script by a legitimate developer) should not
   impact other developers' API availability.

   Rate limiting per API key (not per IP):
     Free tier: 100 req/min
     Growth: 1,000 req/min
     Enterprise: custom

   Response:
     X-RateLimit-Limit: 1000
     X-RateLimit-Remaining: 347
     X-RateLimit-Reset: 1709251260
   On limit: 429 with Retry-After: 42 (seconds until reset)
   SDK auto-retries on 429 with Retry-After delay.

5. OBSERVABILITY PER TENANT
   You must be able to answer: "Why is developer X experiencing errors at 3pm?"
   Every request must be logged with:
     API key hash (not the key itself — privacy)
     Request ID (developer includes in support ticket)
     Endpoint + HTTP method + status code
     Latency (p50/p95/p99 per API key over time)

   Developer dashboard: show their own API metrics, error rates, quota usage.
   When they contact support: support team says "I see 47 failed requests on your
   key between 14:23-14:31 UTC, all 422 validation errors on /messages,
   the error is missing 'to' field in your payload."
   → 10-second diagnosis vs 2-hour debugging session.
```

---

**Q8: Your microservices system has 30 services, each with its own REST API. Teams constantly break each other's APIs. How do you architect a solution?**

_What the interviewer evaluates:_ API governance, contract-driven development, service mesh concepts, inner platform effect.\*

**Discussion Points:**

```
This is an organizational + technical problem. Technical solutions alone won't work.

Root cause analysis:
  - 30 teams, each "owning" their service's API
  - No shared contract enforcement
  - Integration testing is manual and infrequent
  - API changes deployed independently without notifying consumers

Architectural solutions:

1. API CONTRACT REGISTRY (Backstage or Confluence + automation)
   Every service publishes its OpenAPI spec to a central registry.
   Registry version-controls all specs.
   "API spec change" is a PR → consumers review → contract tests run → merge.

2. CONSUMER-DRIVEN CONTRACT TESTING (Pact)
   Consumer team writes Pact tests:
     "I expect /orders/{id} to return { order_id: string, status: string, items: array }"
   These tests run in CI of the PRODUCER (order service) on every deploy.
   If producer removes "items" from response → Pact test fails → build blocked.

   Impact: No integration test environment needed for basic contract validation.
   Breaking change detected in seconds (CI), not weeks (when consumer deploys).

3. API GATEWAY AS ENFORCEMENT LAYER
   All inter-service traffic routes through internal API Gateway (Kong, AWS API GW).
   Request/response schema validation in Gateway:
     Consumer sends request missing required field → Gateway rejects (400) BEFORE reaching producer
     Producer returns response with wrong schema → Gateway rejects (500) BEFORE reaching consumer

   Prevents partial failure propagation: schema bugs caught at the boundary.

4. VERSIONING CONVENTION (team-wide rule)
   Rule: Any breaking change MUST increment version.
   Breaking change definition (documented, agreed):
     - Remove any response field
     - Rename any field
     - Change field type
     - Add required request field
     - Change status codes on existing behavior

   Non-breaking (no version increment needed):
     - Add optional field to request
     - Add new field to response
     - Add new endpoint

   Enforcement: linting tool (Spectral) runs against OpenAPI diff in CI.
   Alerts: "Your PR introduces a breaking change in /v1/orders → you MUST use /v2/orders."

5. INTERNAL DEVELOPER PORTAL
   Not just docs. Searchable catalog: "who owns /payments/refund?"
   Subscription notifications: "Order service updated their API → you're a consumer → review changelog."
   Error budget per service: consumer-visible SLA.

   Team accountability: if your service's API causes downstream failures,
   it shows on your team's error budget dashboard.
```

---

## SECTION 10 — Comparison Table

### REST vs. Common Alternatives

| Dimension          | REST                                  | GraphQL                                      | gRPC                                | WebSockets                            | SOAP                      |
| ------------------ | ------------------------------------- | -------------------------------------------- | ----------------------------------- | ------------------------------------- | ------------------------- |
| **Protocol**       | HTTP/1.1 + HTTP/2                     | HTTP/1.1 + HTTP/2                            | HTTP/2 (binary)                     | TCP (upgrade from HTTP)               | HTTP/1.1 (XML)            |
| **Data format**    | JSON, XML (usually JSON)              | JSON                                         | Protocol Buffers (binary)           | Any (JSON, binary)                    | XML only                  |
| **Schema**         | OpenAPI spec (optional)               | SDL (required, type-safe)                    | .proto files (required)             | None (ad-hoc)                         | WSDL (required, verbose)  |
| **Caching**        | ✅ Native HTTP caching (CDN, browser) | ❌ Hard (POST, no standard URL)              | ❌ Not standard                     | ❌ Stateful connection                | ❌ Verbose, no standard   |
| **Performance**    | Good (text overhead)                  | Good (single round trip)                     | Excellent (binary, HTTP/2)          | Excellent (low-latency bidirectional) | Poor (XML verbosity)      |
| **Type safety**    | ❌ Not unless using OpenAPI codegen   | ✅ Strongly typed schema                     | ✅ Strongly typed .proto            | ❌ No schema                          | ✅ WSDL-enforced          |
| **Learning curve** | Low (HTTP semantics = familiar)       | Medium (SDL, resolvers, N+1)                 | Medium (.proto, codegen)            | Low (but connection management hard)  | High (XML, WS-Security)   |
| **Mobile use**     | ✅ Universal                          | ✅ Fits mobile (fetch exactly what you need) | ✅ Efficient payload                | ✅ Real-time apps                     | ❌ Rarely used on mobile  |
| **Browser native** | ✅ fetch(), XMLHttpRequest            | ✅ fetch()                                   | ❌ Needs grpc-web proxy             | ✅ WebSocket API                      | ❌ Library needed         |
| **Real-time**      | ❌ Polling only (or SSE)              | ✅ Subscriptions (WebSocket)                 | ✅ Bidirectional streaming          | ✅ Native real-time                   | ❌ No                     |
| **Versioning**     | URL-based (/v1, /v2)                  | Field deprecation + schema evolution         | .proto versioning (field numbers)   | No standard                           | WSDL version              |
| **Best for**       | CRUD APIs, public APIs, general web   | Mobile/complex queries, flexible clients     | Internal microservices, performance | Chat, live data, games                | Legacy enterprise systems |

### When to Choose Each

```
Choose REST when:
  - Public API (external developers): familiar, well-tooled, HTTP-native
  - Simple CRUD operations: products, users, orders — standard resource manipulation
  - CDN caching needed: product catalogs, content delivery — GET caching is native to REST
  - Team is not all in one language: REST is language-agnostic
  - Need browser compatibility without proxies

Choose GraphQL when:
  - Multiple clients with different data needs (mobile needs 3 fields, web needs 15)
    → REST would need multiple endpoints or over-fetching
  - Deeply nested data: social graph, product + reviews + seller + recommendations
    → REST N+1 problem (GET /products → GET /reviews for each → GET /seller for each)
    → GraphQL: one query, one round trip
  - Rapid frontend iteration: frontend changes data requirements without backend deploy
  - API for a BFF (Backend for Frontend) layer

Choose gRPC when:
  - Internal microservice communication: low latency, binary, efficient
  - Strongly-typed contracts critical: .proto files = compile-time contract enforcement
  - Streaming needed: server push, client push, bidirectional stream
  - High throughput: 10× smaller payload (Protobuf vs JSON) matters at scale
  - All services in one language ecosystem (or code generation acceptable)

Choose WebSockets when:
  - Real-time bidirectional: chat, collaborative editing, multiplayer games
  - Sub-100ms latency required for many events: stock tickers, live dashboards
  - Server-push-heavy patterns (much more server→client than client→server)

Hybrid (common in production):
  REST for CRUD + public APIs
  + GraphQL for complex frontend queries
  + gRPC for internal microservice calls
  + WebSocket for real-time notifications
```

### REST Anti-Patterns vs Correct Patterns

| Anti-Pattern                                        | What's Wrong                                                       | Correct Pattern                                                              |
| --------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `GET /deleteOrder?id=123`                           | GET is idempotent + safe; URL has verb                             | `DELETE /orders/123`                                                         |
| `POST /getUser`                                     | POST creates resources; GET retrieves                              | `GET /users/{id}`                                                            |
| `200 OK` for "Order Not Found"                      | CDN caches error; monitoring masked                                | `404 Not Found`                                                              |
| `PUT /users/123 {email:"new@x.com"}`                | PUT replaces full resource; other fields NULLed                    | `PATCH /users/123 {email:"new@x.com"}`                                       |
| Session in application memory                       | Pod restart loses session; no horizontal scale                     | Session in Redis with TTL                                                    |
| Sequential IDs: `/users/1`, `/users/2`              | Enumeration attack; leaks business data                            | UUID: `/users/f47ac10b-58cc-...`                                             |
| Returning all fields always (`SELECT *`)            | Over-fetching; response bloat; DB overhead                         | Projection fields: `?fields=id,name,email`                                   |
| Versioning via custom header only                   | Browsers can't cache differentiated versions; debugging hard       | URL segment: `/v1/orders`                                                    |
| `POST /orders` without idempotency                  | Network retry = duplicate order                                    | Require `Idempotency-Key` header                                             |
| Ignoring `Content-Type` header                      | Server guesses format; breaks for non-JSON clients                 | Enforce `Content-Type: application/json`; return 415 Unsupported Media Type  |
| Large un-paginated lists: `GET /orders` returns all | 10M orders in response body; timeout; memory crash                 | `GET /orders?limit=20&cursor=...`; always paginate                           |
| Hardcoded CORS: `Access-Control-Allow-Origin: *`    | Security issue for credentialed requests; allows any script access | Dynamic CORS allowlist: validate Origin against list, return specific origin |

---

## SECTION 11 — Quick Revision

### 10 Key Takeaways

1. **REST = 6 constraints, not "JSON over HTTP"**: Stateless, Client-Server, Cacheable, Uniform Interface, Layered System, Code on Demand. Violating any constraint loses specific properties.

2. **Statelessness unlocks horizontal scaling**: JWT in every request → any server handles any user → add servers freely → no sticky sessions → no session migration lag during scale-out.

3. **HTTP methods carry semantics the ecosystem depends on**: GET = safe + idempotent, PUT = idempotent, POST = neither. CDNs, monitoring, and retry logic all depend on these semantics being honored.

4. **Status codes are the communication protocol**: 404 → CDN doesn't cache; 503 → SDK retries; 429 → SDK backs off; 200-for-error breaks all of these and lies to your monitoring.

5. **POST is not idempotent — that's your responsibility to fix**: Idempotency-Key header + Redis deduplication = safe retries for payment, order creation, message sending.

6. **Cursor-based pagination beats offset at scale**: Offset=5000 scans 5000 rows; cursor uses index; stable across concurrent writes; no total count required.

7. **Cache-Control is your CDN instruction manual**: `public, max-age=300` = edge-cacheable for 5 minutes; `private, no-store` = never touches CDN; `no-cache` = cached but always validated.

8. **Versioning is your contract with consuming teams**: `/v1/orders` is frozen. Breaking changes go to `/v2/`. Additive changes (new optional fields) don't require version bump. Sunset with 6-month notice.

9. **Backward compatibility rules**: Never remove a response field; never rename; never make optional fields required — until version increment with sunset window.

10. **API Gateway is not optional at scale**: Rate limiting, JWT validation, usage plans, request logging, versioning routing — all belong in a single entry point, not duplicated across every microservice.

### 30-Second Interview Explanation

"REST is an architectural style for distributed hypermedia systems, defined by 6 constraints. The most important are: statelessness (each request carries everything needed — JWT not sessions — enabling horizontal scaling), uniform interface (resources are nouns, HTTP verbs are actions, status codes carry meaning), and cacheability (GET responses can have CDN cache TTLs, reducing origin load 90%+). In production, REST APIs go wrong when engineers use GET to delete things, return 200 for errors, or store sessions in application memory. The most critical operational pattern is idempotency — POST creates are not idempotent by definition; you must use Idempotency-Key headers to prevent duplicate orders or double-charges when clients retry on network failures."

### Memory Tricks

**REST Constraints: "SCULC"** (Stateless Code Uniform Layered Client)

- **S**tateless: JWT in every request
- **C**acheable: Cache-Control headers
- **U**niform Interface: nouns in URLs, verbs as HTTP methods
- **L**ayered System: CDN → Gateway → LB → Service (client doesn't know)
- **C**lient-Server separation: independent deployment

**HTTP Methods: "GPDPU D"** (Get Paid, Put Down, Delete)

- **G**ET → Read, safe, idempotent, cacheable
- **P**OST → Create, NOT idempotent, NOT safe (add Idempotency-Key!)
- **P**UT → Full replace, idempotent
- **P**ATCH → Partial update, NOT idempotent by default
- **D**ELETE → Remove, idempotent (second call = 404, treat 404 as success)

**Status code memory:**

- 2xx → You got it
- 3xx → Go there instead
- 4xx → You messed up
- 5xx → We messed up

**REST anti-patterns: "VERS"** (Violates Everything REST Stands for)

- **V**erb in URL (getUser, deleteOrder)
- **E**rrors as 200 OK
- **R**emoved fields without version bump
- **S**ession state in app memory (not Redis)

**Idempotency: Think "Stamps"**
Like a postage stamp on a letter — you can stamp the same letter 100 times, but the post office only processes it once. Idempotency-Key = the stamp.

---

## SECTION 12 — Architect Thinking Exercise

_Read the problem. Design your solution. Then read the analysis._

---

### The Problem

You are the Principal Backend Architect at **PayFlow**, a B2B payment processing company.

**Current situation:**

- 200 enterprise clients integrate via your REST API to process payments
- Your API: `POST /v1/payments` creates a payment, returns payment ID and status
- Monthly volume: 50 million payment requests
- Current architecture: AWS API Gateway → Lambda → DynamoDB
- P99 latency: 180ms (acceptable today)
- Error rate: 0.02% (acceptable today)

**Incident last Friday:**
A large client (20% of your volume) deployed new code. Their code has a bug: on HTTP 5xx responses, it retries immediately (no backoff), looping 10 times per second per failure. A network blip caused 3% of their requests to fail for 45 seconds. During those 45 seconds: their retry loop generated 500× their normal request rate → your Lambda concurrency limit hit → 80% of ALL clients' payments failed → $2.3M in lost transactions for your clients → 3 clients threatening to cancel contracts.

**Two weeks from now:**
Client A (10% of volume) wants to migrate to your `/v2/payments` endpoint (which you're building with new behavior). Client B (5% of volume) is staying on `/v1/payments` permanently. 25 other clients have said nothing.

**Your board wants:**

1. This incident must never happen again (one client cannot bring down all others)
2. V1 and V2 must coexist indefinitely
3. P99 under 100ms (current: 180ms)
4. A "client misbehavior detected" alert within 60 seconds of anomaly

**Design the new architecture. Specifically address:**
A. How you prevent one client from impacting others
B. How you achieve P99 < 100ms
C. How V1 and V2 coexist
D. How you detect client misbehavior in < 60 seconds
E. One risk you'd highlight to the board before implementing

---

_Think about it before reading the solution below._

---

### Wrong Answer (Typical Junior/Mid Response)

```
"I'd add retry logic with backoff to API Gateway."
  → API Gateway rate limits at the endpoint level, not per-client-key level.
  → Rate limiting all clients equally penalizes good clients for bad ones.
  → Doesn't address P99 latency.

"I'd add more Lambda concurrency."
  → Solves capacity but not isolation. One bad client still consumes all capacity.
  → 10,000 Lambda concurrent = 10,000× your Lambda bill.
  → Doesn't address root cause: no client isolation.

"I'd deprecate V1 and force everyone to V2."
  → Violates backward compatibility contract (enterprise clients have 12-month migration SLA).
  → "25 clients said nothing" doesn't mean "25 clients are ready to migrate."
  → Forced migration = client trust damage = potential contract cancellations.

"I'd rewrite it in gRPC for performance."
  → gRPC would break your 200 existing REST integrations immediately.
  → Over-engineering: 180ms → 100ms gap doesn't require protocol change.
  → Root issue is Lambda cold starts + DynamoDB write latency, not HTTP overhead.
```

---

### Correct Architectural Thinking

#### A. Client Isolation (Tenant Isolation)

```
The root cause: no resource isolation between clients (tenants).
One client's load saturates shared Lambda concurrency → all clients fail.

Solution: Per-client reserved Lambda concurrency + API key-scoped rate limiting

API Gateway Usage Plans:
  Create a Usage Plan per client:
    Client A: 10,000 req/min, burst 1,000/sec, throttle at 1,001/sec → 429
    Client B: 5,000 req/min, burst 500/sec
    Default: 1,000 req/min per API key

  Result: Client with bug triggers their own 429 before impacting shared resources.
  Client A in retry storm: their 500× traffic → hits 429 after 1,001/sec → stays on 429
  Other clients: unaffected (their quota not consumed by Client A)

Lambda Reserved Concurrency:
  Lambda:CreatePaymentV1: reserved = 500 (V1 clients)
  Lambda:CreatePaymentV2: reserved = 500 (V2 clients)
  Total Lambda concurrency: 1,000 (soft account limit default 3,000)

  Client A's retry storm: saturates V1 concurrency → V1 throttled → V2 unaffected
  Result: one version doesn't take down the other

SQS Buffer (for burst absorption):
  API Gateway → SQS FIFO queue (per client, separate queue) → Lambda Consumer

  During Client A retry storm:
    API Gateway: accepts requests up to rate limit → beyond that → 429
    Within rate limit: SQS buffers the burst → Lambda processes at sustainable rate
    Lambda: never overloaded → P99 stable even during client traffic spikes

  Tradeoff: Async pattern → API returns 202 Accepted + task_id
            Client polls GET /payments/{id} for final status
            Not suitable if client needs synchronous sub-second response

  Decision: Keep synchronous Lambda for P99 SLA (< 100ms requires synchronous)
            Add rate limiting as primary protection (simpler, lower latency impact)
```

#### B. P99 < 100ms (Current: 180ms)

```
Latency breakdown analysis (where the 180ms comes from):
  API Gateway overhead: ~10ms
  Lambda cold start: ~150ms (cold) / ~3ms (warm) → P99 includes cold starts
  DynamoDB PutItem: ~5ms

The P99 is dominated by Lambda cold starts (P99 = cold start scenario).

Solution: Provisioned Concurrency for Payment Lambda
  AWS Lambda Provisioned Concurrency: keep N Lambda instances pre-warmed
  No cold start for provisioned instances.

  Cost: $0.015 per GB-hour provisioned (vs $0.00001667/GB-second on-demand)
  For payments API: 50 provisioned instances × 512MB = 25GB-hours = $0.375/hour = $270/month

  Result:
    Cold start: 150ms → 0ms (provisioned)
    P99: 180ms → 10ms (API GW) + 3ms (Lambda) + 5ms (DynamoDB) = ~18ms
    Well under 100ms target.

Alternative for P99 at higher scale: ECS Fargate (always warm)
  If Lambda cost + provisioned concurrency > ECS: switch to Fargate
  Fargate: no cold start, consistent latency, predictable billing at high volume
  At 50M req/month: Lambda ~$150/month; Fargate (3 tasks) ~$120/month
  Break-even favors Fargate at this volume (similar cost, no cold starts)

DynamoDB DAX:
  Current: DynamoDB PutItem 5ms
  With DAX: write through (5ms) → read GetItem: 0.3ms (microseconds for cache hits)
  Impact: POST /payments (write) unchanged; GET /payments/{id} (read) drops from 5ms → 0.3ms
  GET /payments/{id} status polling: 80% traffic → DAX cuts total average latency significantly
```

#### C. V1 and V2 Coexistence

```
API Gateway Stage + Lambda Alias pattern:

API Gateway:
  /v1/payments → Lambda:CreatePayment:v1 (alias pointing to V1 behavior code)
  /v2/payments → Lambda:CreatePayment:v2 (alias pointing to V2 behavior code)

  Both routes exist simultaneously in the same API Gateway "API"
  OR: Two separate API Gateway APIs (cleaner isolation):
    v1-payments-api.execute-api.us-east-1.amazonaws.com → V1
    v2-payments-api.execute-api.us-east-1.amazonaws.com → V2
    Custom domains: api.payflow.com/v1/ and api.payflow.com/v2/ (Route 53 + CloudFront routing)

Lambda Aliases:
  Lambda function: CreatePayment
  Alias: "v1" → points to Lambda version 12 (last V1-compatible code)
  Alias: "v2" → points to Lambda version 20 (V2 code)

  New bug in V2: rollback alias "v2" to point to Lambda version 19
  V1 clients: completely unaffected (alias "v1" unchanged)

Deprecation headers on V1 responses:
  Deprecation: true
  Sunset: Tue, 01 Jun 2026 00:00:00 GMT
  Link: <https://api.payflow.com/v2/payments>; rel="successor-version"

  Client SDKs emit warnings when they see these headers → developers get notified
  Log % of traffic still on V1 → track migration progress → trigger reminders to slow movers
```

#### D. Client Misbehavior Detection in < 60 Seconds

```
CloudWatch metric math + anomaly detection:

Custom metric: PayflowClientRequestRate
  Emit metric per API key per minute (API Gateway access logs → CloudWatch metric filter):
  Logs: { "apiKey": "key_clientA", "requestCount": 1, "statusCode": 200 }

  API Gateway access log pattern → CloudWatch Metric Filter:
    Namespace: PayflowAPI
    Metric: ClientRequestCount
    Dimensions: {ApiKey: $context.identity.apiKey}
    Unit: Count

CloudWatch Alarm (per API key):
  Metric: ClientRequestCount for key_clientA
  Threshold: > 3× average of last 7 days for same 5-minute window
  Evaluation: 1 datapoint over 1 period (5-minute evaluation → detects within 5 min)

  But target is 60 seconds → need shorter evaluation period

CloudWatch Anomaly Detection (real-time):
  Alarm: ANOMALY_DETECTION_BAND on ClientRequestCount
  Period: 1 minute
  Band width: 2 standard deviations from historical pattern

  Client A normal: 500 req/min
  Client A storm start: 50,000 req/min → anomaly detected within 60 seconds
  Alarm → SNS → PagerDuty → On-call engineer
  Alarm → Lambda → Auto-action: reduce Client A's API key throttle limit temporarily

  Alert message:
    "Client A (key_abc123) exceeded anomaly threshold.
     Current: 50,000 req/min. Expected: 400-600 req/min.
     Client is in AUTOMATIC throttle reduction.
     Contact: client-a-sre@partner.com per escalation policy."

Log analysis (second signal within 60s):
  API Gateway logs → Kinesis Data Firehose → S3 + Lambda (real-time)
  Lambda runs every 60s: SELECT apikey, COUNT(*) as cnt FROM recent_60s GROUP BY apikey
                         WHERE cnt > 5× avg 7-day baseline ORDER BY cnt DESC
  Alert if any key exceeds threshold
```

#### E. Risk for the Board

```
Primary risk: The SQS async pattern (Option B above) changes the API contract fundamentally.

Current synchronous behavior:
  Client sends POST /payments → waits → receives {"payment_id": "...", "status": "approved"}
  Client's code: if status == "approved": fulfill order

If we switch to async (SQS buffer) for burst protection:
  Client sends POST /payments → receives 202 Accepted + task_id
  Client must: poll GET /payments/{task_id} until status is terminal

  Impact:
    200 enterprise clients have production integrations expecting synchronous response
    Migration to async polling: requires code change on every client's side
    Some clients may not have build resources to migrate (legacy systems, low-staffed teams)
    Contract violation: we'd be changing the implied API contract without version bump

Board decision required:
    A. Synchronous pattern with better rate limiting + provisioned concurrency (lower isolation)
    B. Async pattern with required client migration (better isolation, contractual risk)
    C. Offer both: synchronous for legacy clients, async for new V2 clients
       → Recommended: C. V1 stays synchronous (with rate limiting + provisioned concurrency)
                          V2 is designed async-first (new clients learn the pattern)
                          V1 isolation: per-client rate limits prevent the Friday incident
                          V2 isolation: SQS buffer provides burst protection

Recommendation: Implement per-client rate limiting + Lambda provisioned concurrency for V1 immediately (1-week sprint). V2 design: async pattern for new clients onboarding. Board approval needed for V1 sunset timeline (recommendation: 18 months from V2 GA).
```

---

## Topic 01 Complete — REST Architecture

**Across all 3 files:**

| File | Sections | Core Content                                                                                                                                                                                                                         |
| ---- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 01   | 1-4      | Restaurant/postal analogies, RPC/SOAP failures, 6 REST constraints with code, HTTP methods + idempotency, order placement API with full failure analysis                                                                             |
| 02   | 5-8      | Production ASCII architecture, Stripe idempotency pattern, GitHub pagination design, stateless scaling math, what breaks under misunderstanding, AWS service mapping (API GW v1/v2, Lambda, SQS, DynamoDB, CloudFront + ElastiCache) |
| 03   | 9-12     | 8 interview Q&As (BEG/INT/ADV), REST vs GraphQL vs gRPC vs WebSocket comparison, anti-patterns table, 10 key takeaways + mnemonics, PayFlow architect exercise: client isolation + P99 optimization + V1/V2 coexistence              |

**Next recommended topic in Backend & API Design:** API Versioning & Evolution — the full lifecycle of a production API from design to deprecation.
