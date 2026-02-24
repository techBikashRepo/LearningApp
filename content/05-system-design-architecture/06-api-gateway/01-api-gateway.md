# API Gateway — Part 1 of 3

### Sections: 1 (Real-World Analogy), 2 (Problem Solved), 3 (Component Responsibilities), 4 (ASCII Diagrams)

**Series:** System Design & Architecture → Topic 06

---

## SECTION 1 — Real-World Analogy

### The Hotel Concierge Desk

```
HOTEL WITHOUT A CONCIERGE DESK:
  Guest arrives and needs to:
  1. Check in → finds the check-in counter (Room 101, left wing)
  2. Get restaurant reservation → finds the restaurant (3rd floor, East?)
  3. Get a taxi → finds the doorman (outside, back entrance)
  4. Problem with room Wi-Fi → finds IT support (basement, Building B)
  5. Book a spa → finds the spa desk (2nd floor, West wing)

  The guest must:
  - Know where each department is located
  - Present ID to each department separately
  - Figure out the "language" each department speaks
  - If the restaurant is closed, handle that failure themselves

HOTEL WITH A CONCIERGE DESK:
  One desk. One contact.

  "I need a taxi, dinner reservation at 8PM, and my Wi-Fi isn't working."

  The concierge:
  → Verifies your guest identity (checks keycard once)
  → Queues the taxi request → routes to doorman
  → Makes the dinner reservation → routes to restaurant
  → Escalates the Wi-Fi issue → routes to IT
  → Returns all confirmations to the guest in one interaction

  The guest never knows about the doorman, the IT basement,
  or how to reach the restaurant department.

  The concierge also:
  → Enforces hotel rules: "No external services after 11PM" (rate limits)
  → Translates: takes verbal request, formats it for each department
  → Logs all guest interactions for management (observability)
  → Can temporarily redirect: "Spa is full, I've booked you at the hotel next door"
     (service routing/fallback)
```

**In software:** Your API Gateway is the concierge. Clients (mobile apps, web browsers, partner systems) interact with ONE endpoint. The Gateway authenticates them once, routes their request to the correct microservice, and enforces cross-cutting policies (rate limiting, TLS, logging) without each service needing to implement them independently.

---

### The Airport Security Checkpoint

```
AIRPORT SECURITY (another lens on the same concept):

  Without security: every gate, every restaurant, every lounge
  checks your boarding pass and ID independently.
  13 checks for one flight. Each one with a different system. Chaos.

  With security checkpoint:
  → ONE centralized check at the entrance.
  → Once through: you have access to all gates, all lounges, all restaurants.
  → Checkpoint enforces rules for the ENTIRE airport (carry-on limits = rate limits)
  → If you have a Premium boarding pass: you go to Priority Security (rate tier)

  API GATEWAY = SECURITY CHECKPOINT:
  → One entry point. Authenticate once.
  → Once authenticated: request is routed to appropriate backend service.
  → Rate limits enforced per client tier at the checkpoint.
  → Internal services don't re-authenticate (they trust requests that passed the gateway).
```

---

## SECTION 2 — Problem Solved

### Without a Gateway: The N × M Problem

```
MICROSERVICES WITHOUT API GATEWAY:

  Mobile App ──────────────────────────────► User Service :3001
  Mobile App ──────────────────────────────► Order Service :3002
  Mobile App ──────────────────────────────► Payment Service :3003
  Web Browser ─────────────────────────────► User Service :3001
  Web Browser ─────────────────────────────► Order Service :3002
  Partner API ──────────────────────────────► Order Service :3002
  Partner API ──────────────────────────────► Inventory Service :3004

  PROBLEMS:

  1. Discovery: Client must know the IP/hostname of EVERY service it needs.
     "What's the Order Service address?" It's 10.0.4.52, unless it scaled out
     and now it's a load balancer at internal-lb-orders.internal. When it moves?
     Update ALL clients. Bug-prone.

  2. Cross-cutting concerns duplicated in every service:
     Every service must implement:
     ✗ JWT validation (8 services × 50 lines each = 400 lines of auth code)
     ✗ Rate limiting (how does Order Service know this IP is abusing the API?)
     ✗ TLS termination (each service manages its own certificate?)
     ✗ CORS headers (misconfigured in 2/8 services — production bug)
     ✗ Request logging (different log format per service — hard to correlate)
     ✗ API versioning (each service has /v1, /v2 independently)

  3. Security surface area:
     8 services, all publicly addressable → 8 attack surfaces.
     If Order Service has a security misconfiguration: directly exploitable.
     If it's behind a Gateway: the Gateway is the ONLY public surface.

  4. The N × M problem:
     N clients × M services = N × M direct connections.
     4 clients, 8 services: 32 potential connections to manage.
     Each connection may need its own auth, rate limit, protocol handling.
```

---

### What the API Gateway Solves

```
MICROSERVICES WITH API GATEWAY:

  Mobile App ──────────┐
  Web Browser ─────────┤
  Partner API ─────────┤──► API GATEWAY ──► User Service     (internal)
  3rd Party ───────────┘         │       ──► Order Service    (internal)
                                 │       ──► Payment Service  (internal)
                                 │       ──► Inventory Service(internal)
                                 │
                   ┌─────────────▼─────────────┐
                   │  Gateway cross-cutting     │
                   │  concerns (ONE place):     │
                   │  • Authentication          │
                   │  • Rate limiting           │
                   │  • TLS termination         │
                   │  • CORS                    │
                   │  • Request logging         │
                   │  • Distributed trace IDs   │
                   │  • Protocol translation    │
                   │  • Response caching        │
                   └───────────────────────────┘

  WHAT'S SOLVED:
  ✅ Single entry point. N clients connect to ONE address.
  ✅ Cross-cutting concerns implemented ONCE, applied to ALL services.
  ✅ Internal services not publicly addressable.
  ✅ Authentication done once at the Gateway; services trust the Gateway.
  ✅ Rate limiting enforced centrally; services don't need their own quotas.
  ✅ N × M wiring reduced to N × 1 (clients) + 1 × M (gateway → services).
```

---

## SECTION 3 — Component Responsibilities

### What the API Gateway Owns

```
FUNCTION 1: ROUTING
─────────────────────────────────────────────────────────────────────────
  Method + Path → Upstream Service

  GET  /users/{id}      → User Service
  POST /orders          → Order Service
  GET  /products        → Catalog Service
  DELETE /orders/{id}   → Order Service
  POST /payments/charge → Payment Service (internal, behind extra auth)

  Routing rules can include:
  • Path-based routing (most common)
  • Header-based routing (X-Version: v2 → v2 cluster)
  • Weight-based routing (10% traffic to canary deployment, 90% to stable)

  Weight-based routing enables canary releases:
    "Send 5% of POST /orders to the new Order Service v2.
    Monitor error rate. If OK, increase to 20%, then 50%, then 100%."
    The Gateway controls this. The clients never know.

FUNCTION 2: AUTHENTICATION + AUTHORIZATION
─────────────────────────────────────────────────────────────────────────
  Every incoming request goes through auth before hitting a service.

  JWT Validation:
    Gateway intercepts request.
    Extracts Bearer token from Authorization header.
    Validates signature against public key (JWK endpoint of Auth Service).
    If invalid: returns 401 Unauthorized immediately.
    If valid: extracts claims (userId, roles, tier).
    Injects claims as request headers before forwarding:
      X-User-Id: usr_abc
      X-User-Roles: customer,loyalty-gold
      X-Tenant-Id: tenant_123
    Upstream services trust these headers (they're set by the gateway, not by clients).

  API Key Validation:
    Partner API requests: validate API key in header.
    Map API key to partner account ID.
    Inject X-Partner-Id header.
    Apply partner-specific rate limits and routing rules.

FUNCTION 3: RATE LIMITING
─────────────────────────────────────────────────────────────────────────
  Per-client, per-route rate limits.

  Examples:
    Free tier:    100 requests/minute per API key
    Pro tier:     1000 requests/minute per API key
    Enterprise:   10000 requests/minute (or custom SLA)
    Un-authed:    10 requests/minute per IP (for public endpoints)

  Gateway returns HTTP 429 Too Many Requests with:
    Retry-After: 15           (seconds until quota resets)
    X-RateLimit-Limit: 100
    X-RateLimit-Remaining: 0
    X-RateLimit-Reset: 1715000000 (epoch when quota resets)

  Preventing DDoS:
    A single IP sending 10,000 requests/second?
    Gateway rejects after the first N requests.
    None of those requests reach the backend services.

FUNCTION 4: REQUEST/RESPONSE TRANSFORMATION
─────────────────────────────────────────────────────────────────────────
  Modify requests before forwarding, or responses before returning.

  Common transformations:
    • Header injection: add X-Request-ID, X-Correlation-ID to every request
    • Header stripping: remove internal headers before sending to clients
    • Protocol translation: Client sends REST, service expects gRPC
                            Gateway translates (REST → gRPC → REST)
    • Response compression: gzip responses for clients that support it
                            (Accept-Encoding: gzip → Content-Encoding: gzip)
    • SSL termination: Gateway handles TLS; internal traffic may be plain HTTP
                       (within a trusted VPC)

FUNCTION 5: OBSERVABILITY
─────────────────────────────────────────────────────────────────────────
  Every request through the Gateway is logged:
    timestamp, client IP, route, response status, latency, user ID, request ID

  Distributed trace injection:
    Gateway generates X-Trace-Id: abc-123-xyz for every request.
    Injects it as a header to all upstream services.
    Services pass it to downstream calls.
    Entire request chain: traceable in Jaeger/X-Ray/Zipkin by one trace ID.

  Metrics:
    Requests per second, error rate, latency P50/P95/P99 per route.
    Alert: "POST /orders error rate > 1% for 3 minutes → page on-call."
```

---

## SECTION 4 — ASCII Architecture Diagrams

### API Gateway End-to-End Architecture

```
INTERNET
  │
  ▼
┌─────────────────────────────────────────────────────────────────────┐
│                       D N S + C D N                                 │
│   api.myapp.com  →  CloudFront  →  WAF (DDoS protection, OWASP     │
│                                    rules, IP reputation filtering)  │
└───────────────────────────────┬─────────────────────────────────────┘
                                │  HTTPS :443
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         API   GATEWAY                               │
│                                                                     │
│  ┌──────────────┐   ┌──────────────┐  ┌──────────────────────────┐ │
│  │ TLS          │   │ Rate Limiter │  │  JWT / API Key           │ │
│  │ Termination  │   │ (per client  │  │  Validator               │ │
│  │              │   │  per route)  │  │  (injects X-User-Id hdr) │ │
│  └──────┬───────┘   └──────┬───────┘  └───────────┬──────────────┘ │
│         └──────────────────┼─────────────────────┘                 │
│                            │                                         │
│  ┌─────────────────────────▼──────────────────────────────────────┐ │
│  │                    ROUTING ENGINE                              │ │
│  │  GET  /users/*    → User Service                               │ │
│  │  *    /orders/*   → Order Service (v2: 10% canary)             │ │
│  │  POST /payments/* → Payment Service (extra auth required)      │ │
│  │  GET  /products/* → Catalog Service                            │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  ┌──────────────┐   ┌──────────────────┐  ┌──────────────────────┐ │
│  │ Request      │   │ Correlation ID   │  │  Response Cache      │ │
│  │ Transform    │   │ Injection        │  │  (GET /products/*:  │ │
│  │ (headers,    │   │ X-Trace-Id gen   │  │   60s TTL)           │ │
│  │  protocol)   │   │                  │  │                      │ │
│  └──────┬───────┘   └──────┬───────────┘  └───────────┬──────────┘ │
└─────────┼──────────────────┼─────────────────────────────────────── ┘
          │                  │                           │
          ▼                  ▼                           ▼
┌──────────────────── PRIVATE VPC / SERVICE MESH ───────────────────── ┐
│                                                                      │
│  ┌─────────────┐  ┌─────────────┐  ┌──────────────┐  ┌──────────┐  │
│  │ User Service│  │Order Service│  │Payment Svc  │  │Catalog   │  │
│  │  :8080      │  │  :8080      │  │  :8080       │  │  Service │  │
│  │ ECS Fargate │  │ ECS Fargate │  │ ECS Fargate  │  │  :8080   │  │
│  │ (trusts     │  │  (trusts    │  │  (extra auth │  │          │  │
│  │  X-User-Id) │  │  X-User-Id) │  │  required)   │  │          │  │
│  └─────────────┘  └─────────────┘  └──────────────┘  └──────────┘  │
│                                                                      │
│  NOT PUBLICLY ADDRESSABLE. Only reachable via API Gateway.           │
└──────────────────────────────────────────────────────────────────────┘
```

---

### Gateway Request Lifecycle

```
CLIENT REQUEST: POST /orders
Authorization: Bearer eyJhbGci...
Content-Type: application/json
Body: { "productId": "prod_123", "quantity": 2 }

STEP 1 — TLS TERMINATION:
  Gateway decrypts HTTPS → HTTP internally.
  Client gets certificate validation.
  Internal traffic doesn't carry that overhead.

STEP 2 — RATE LIMIT CHECK:
  Extract client IP + API key/JWT from request.
  Check Redis counter: "usr_abc has made 45/100 requests this minute."
  Allow (counter incremented to 46).
  If limit exceeded: return 429 immediately. Request stops here.

STEP 3 — AUTHENTICATION:
  Extract Bearer eyJhbGci...
  Validate JWT signature (cached JWK public key, refreshed hourly).
  Claims: { userId: "usr_abc", roles: ["customer"], tier: "free" }
  If invalid: return 401. Request stops here.

STEP 4 — AUTHORIZATION:
  POST /payments/* requires role "payment-verified".
  POST /orders requires role "customer". ✅
  If unauthorized: return 403. Request stops here.

STEP 5 — HEADER INJECTION:
  Add to forwarded request:
    X-User-Id: usr_abc
    X-User-Roles: customer
    X-User-Tier: free
    X-Trace-Id: trace-789-abc-xyz  (newly generated)
    X-Request-Id: req-456-def      (newly generated)
    X-Forwarded-For: 203.0.113.45  (client's real IP)
  Strip from forwarded request:
    Authorization: Bearer ...      (internal services don't need the raw JWT)

STEP 6 — ROUTING:
  POST /orders → Order Service instance (chosen by load balancer).
  Forward request with injected headers.

STEP 7 — UPSTREAM RESPONSE:
  Order Service returns HTTP 201 Created.

  Gateway adds to response:
    X-Request-Id: req-456-def     (so client can correlate support tickets)
    X-RateLimit-Remaining: 54     (client rate limit status)

  Gateway logs the transaction:
    { ts, client: "usr_abc", route: "POST /orders", status: 201, ms: 87 }

STEP 8 — CLIENT RECEIVES 201 Created.
```

---

_→ Continued in: [02-API Gateway.md](02-API%20Gateway.md)_
