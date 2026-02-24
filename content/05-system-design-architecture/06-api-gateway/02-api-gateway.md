# API Gateway — Part 2 of 3

### Sections: 5 (Request Flow), 6 (What Breaks When Responsibilities Mix), 7 (Team Scaling Impact), 8 (Architectural Implications)

**Series:** System Design & Architecture → Topic 06

---

## SECTION 5 — Request Flow Through the Gateway

### Annotated: POST /orders (Happy Path)

```
MOBILE APP
  │
  │  POST https://api.myapp.com/orders
  │  Authorization: Bearer <jwt>
  │  Content-Type: application/json
  │  Body: { "items": [{"productId": "prod_1", "qty": 2}] }
  ▼
  DNS RESOLUTION: api.myapp.com → CloudFront IP

  CloudFront:
    Cache check: POST /orders → not cacheable → pass through.
    WAF: header scan, payload size check (reject if > 1MB), known bad IPs.
    Forward to ALB (API Gateway tier).

  ENTER API GATEWAY:
  ───────────────────────────────────────────────────────────────────────
  [Stage 1: Rate Limit]
    Redis INCR "ratelimit:usr_abc:POST /orders:minute:1715000000" → 3
    TTL: 60 seconds.
    3 < 10 (POST /orders limit for free tier). ✅ Proceed.

  [Stage 2: Auth — JWT]
    Bearer token decoded: header.claims.signature
    Claims: { sub: "usr_abc", iat: ..., exp: ..., roles: ["customer"] }
    Signature verified against JWK cached public key. ✅
    Token not expired. ✅
    Inject: X-User-Id: usr_abc, X-User-Roles: customer

  [Stage 3: Route Match]
    POST /orders → Order Service cluster (v1.8.2 → 90%, v1.9.0-canary → 10%)
    Consistent hash on X-User-Id → usr_abc → routes to v1.8.2. (stable)

  [Stage 4: Header Transform]
    Add X-Trace-Id: "trace-2024-abc-001"
    Add X-Forwarded-For: 203.0.113.45
    Add X-Request-Id: "req-2024-xyz"
    Remove: Authorization header (Order Service trusts X-User-Id)
  ───────────────────────────────────────────────────────────────────────

  Order Service (v1.8.2, internal):
    Receives: POST /orders
      X-User-Id: usr_abc
      X-Trace-Id: trace-2024-abc-001
      Body: { items: [...] }

    No JWT validation needed (trusts Gateway).
    Calls Inventory Service internally (passes X-Trace-Id).
    Calls Payment Service internally (passes X-Trace-Id).
    Returns: HTTP 201, { orderId: "ord_999", status: "confirmed" }

  RETURN THROUGH GATEWAY:
    Add to response:
      X-Request-Id: req-2024-xyz
      X-RateLimit-Remaining: 7
    Log: {ts:"2024-01-15T10:00:00Z", user:"usr_abc", route:"POST /orders",
          status:201, latency_ms:94, trace:"trace-2024-abc-001"}

  MOBILE APP RECEIVES:
    HTTP 201
    { "orderId": "ord_999", "status": "confirmed" }
    Header: X-Request-Id: req-2024-xyz   ← for support ticket correlation
```

---

### Annotated: Rate-Limited Request (429 Path)

```
  ATTACKER (or buggy client):
  Sending 1000 POST /orders in 60 seconds (10/minute limit for free tier).

  Request #11 arrives at Gateway:

  [Stage 1: Rate Limit]
    Redis INCR "ratelimit:usr_abc:POST /orders:minute:1715000000" → 11
    11 > 10. ❌ Limit exceeded.

  Gateway returns IMMEDIATELY (Order Service never touched):
    HTTP 429 Too Many Requests
    {
      "error": "rate_limit_exceeded",
      "message": "You have exceeded the rate limit for this operation.",
      "retryAfter": 47
    }
    Headers:
      Retry-After: 47
      X-RateLimit-Limit: 10
      X-RateLimit-Remaining: 0
      X-RateLimit-Reset: 1715000060

  The Order Service is NEVER called.
  Database is NEVER hit.
  The rate limiter absorbs the load at the gateway layer.
```

---

## SECTION 6 — What Breaks When Responsibilities Mix

### Anti-Pattern 1: Authentication in Each Microservice

```javascript
// BAD: Every microservice validates the JWT independently

// user-service/src/middleware/authMiddleware.js
async function authenticate(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  req.userId = decoded.sub;
  next();
}

// order-service/src/middleware/authMiddleware.js
async function authenticate(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  // COPY-PASTED. Now diverges:
  // - Order Service forgets to check token expiry
  // - User Service updates JWT algo to RS256; Order Service still uses HS256
  // - Payment Service uses a different version of the JWT library
  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => { ... });
}

// 8 services × copy-pasted auth = 8 places to update when you rotate JWT secrets,
// change algorithms, or add new claims.
// One service forgets → security vulnerability in prod.
```

**What breaks:**

- Algorithm migration (HS256 → RS256): update 8 services. One service misses the deployment. It still accepts HS256-signed tokens even after the migration. Attackers can forge tokens with the old algorithm.
- JWT secret rotation: same problem. One service is still accepting old-key tokens.
- Adding `organizationId` claim: 8 services must all be updated to read the new claim.
- Each service has a different `jwt.verify` error message — different HTTP 401 response bodies confuse clients.

**With API Gateway:** JWT validation is in ONE place. Rotate keys in the Gateway's JWK endpoint. Update JWT algorithm in the Gateway. All services benefit instantly with zero code changes.

---

### Anti-Pattern 2: Business Logic in the Gateway

```javascript
// BAD: Order discount logic lives in the API Gateway plugin
// (Kong plugin, AWS Lambda Authorizer, nginx Lua script)

// Kong plugin: pre-request hook
function before_order_request(request)
  local userId = request.headers["X-User-Id"]
  local tier = getUserTier(userId)  // database call from gateway!

  if tier == "gold" then
    request.body.discountPercentage = 0.10
  elseif tier == "silver" then
    request.body.discountPercentage = 0.05
  end
end
```

**What breaks:**

- Discount logic now lives in the Gateway plugin. Order Service also has discount logic (because it needed it independently). Two systems — one canonical truth? Which one wins?
- Gateway is now hitting a database on EVERY order request to check user tier. The gateway is now a bottleneck with DB load.
- Changing the discount rule requires a Gateway deployment, not just an Order Service deployment. Platform team (who owns the gateway) blocks the product team.

**Rule:** Gateways should be policy enforcement points, not business logic engines. If it's a business rule: it belongs in a domain service.

---

### Anti-Pattern 3: API Gateway as Service Mesh

```
MISCONCEPTION: "API Gateway handles service-to-service communication too."

WHAT SHOULD HAPPEN:

  External:   Client → API GATEWAY → Order Service
  Internal:   Order Service → Inventory Service (service-to-service)

  The API Gateway handles NORTH-SOUTH traffic (external → internal).
  A SERVICE MESH handles EAST-WEST traffic (internal ↔ internal).

  Order Service calling Inventory Service SHOULD NOT go through the API Gateway.
  It would add:
    - Unnecessary network hops (double the latency: Order → Gateway → Inventory)
    - Gateway as a bottleneck for all internal traffic
    - All internal traffic visible to the Gateway (privacy, trust model violation)

WHAT ACTUALLY HANDLES EAST-WEST:
  Service Mesh (Istio, AWS App Mesh, Linkerd):
    - mTLS between services (not JWT — certificates)
    - Service discovery (Inventory Service is at inventory.internal:8080)
    - Circuit breaking between services
    - Internal rate limiting between services

GATEWAY ≠ SERVICE MESH.
Gateway = public boundary (North-South).
Service Mesh = internal communication layer (East-West).
```

---

## SECTION 7 — Team Scaling Impact

### Who Owns the Gateway?

```
THE PLATFORM TEAM OWNS THE API GATEWAY.

  Platform team responsibilities:
    ✅ Maintain the gateway infrastructure (Kong, AWS API Gateway, nginx, Envoy)
    ✅ Define gateway standards (JWT validation approach, rate limit tiers)
    ✅ Manage TLS certificates and DDoS protection
    ✅ Set up observability pipeline (routing logs to Splunk/Datadog)
    ✅ Define security policies (blocked IPs, WAF rules)

  Product service teams responsibilities (self-service):
    ✅ Register their route in the gateway config (not a manual Platform ticket)
    ✅ Specify their rate limit requirements
    ✅ Request special per-route auth requirements (if any)

THE GOLDEN RULE:
  Service teams should not need to file a ticket with the Platform team
  to add a new route. Self-service route registration is essential
  for team velocity at scale.

  Pattern at large companies (Netflix, Uber):
    Service teams submit a Pull Request to the gateway config repository.
    Platform team reviews for security concerns.
    Approved PR is auto-deployed to the gateway.
    No manual steps.

ANTI-PATTERN:
  "Platform team must manually configure every new route."
  At 50 microservices: Platform team becomes the bottleneck for every launch.
  Product teams wait 1 week to get a new endpoint exposed externally.
```

---

### Gateway Ownership at Different Scales

```
STARTUP (1 team, 5 services):
  Use AWS API Gateway (managed) or a single nginx instance.
  One team owns everything.
  Focus: get it working, not optimize the ownership model.
  Kong/Envoy adds operational complexity not justified at this scale.

GROWING COMPANY (3-5 teams, 15-20 services):
  Introduce Platform team that owns the gateway.
  Start self-service route configuration (YAML files, GitHub PRs).
  Introduce consistent JWT validation at the gateway.
  Monitor: latency added by gateway (should be < 5ms P99 overhead).

LARGE COMPANY (10+ teams, 50+ services):
  Multiple gateways by domain: public-api gateway (external clients),
  partner-api gateway (B2B), admin-api gateway (internal tools).
  Each gateway has different SLAs, rate limits, auth requirements.
  Platform team SRE team maintains 99.99%+ availability.
  Route configuration via GitOps pipeline with approval workflows.
  Feature flags per route: "Enable new rate limit for GET /products":
  roll out to 10% of traffic, monitor, then 100%.
```

---

## SECTION 8 — Architectural Implications

### API Gateway Single Point of Failure

```
THE SPOF PROBLEM:

  All traffic goes through the Gateway.
  If the Gateway goes down: the ENTIRE API is unavailable.
  Even if all 8 downstream services are healthy — clients can't reach them.

  This is the most critical availability concern with the API Gateway pattern.

MITIGATING THE SPOF:

  HA GATEWAY DEPLOYMENT (production requirement):

  Route 53 (DNS)
    │
    ▼
  CloudFront (regional redundancy built in)
    │
    ├─────────────────────────────────────────┐
    ▼                                         ▼
  API Gateway instance 1                  API Gateway instance 2
  (AZ us-east-1a)                         (AZ us-east-1b)
    └───────────────────────────────────────┘
    ALB health checks both instances
    Auto-scales horizontally (target 60% CPU)
    If instance fails: ALB routes to remaining instances instantly

  MINIMUM: 2 instances across 2 availability zones.
  PRODUCTION: 3+ instances across 3 AZs.

  Gateway instance CRASHES: other instances absorb traffic.
  Entire AZ fails: other AZ instances absorb traffic.
  Full region fails: Route 53 failover to secondary region.

STATELESS GATEWAY (required for HA scaling):
  Gateway instances CANNOT store per-request state locally.
  Rate limit counters: stored in Redis (shared across all instances).
  JWT validation: stateless (signature verification — no DB lookup).
  Session state: stored in external Redis, not in gateway memory.
```

---

### API Gateway vs Service Mesh vs BFF

```
┌─────────────────┬────────────────────────┬───────────────────────────────┐
│                 │  API GATEWAY           │  SERVICE MESH                 │
├─────────────────┼────────────────────────┼───────────────────────────────┤
│ Traffic type    │ External (client →     │ Internal (service ↔ service)  │
│                 │ services)              │                               │
├─────────────────┼────────────────────────┼───────────────────────────────┤
│ Auth method     │ JWT / API keys         │ mTLS certificates between     │
│                 │ (user identity)        │ services (service identity)   │
├─────────────────┼────────────────────────┼───────────────────────────────┤
│ Rate limiting   │ Per external client    │ Per service-to-service pair   │
├─────────────────┼────────────────────────┼───────────────────────────────┤
│ Observability   │ Request log per        │ Service-level metrics +       │
│                 │ external request       │ distributed tracing           │
├─────────────────┼────────────────────────┼───────────────────────────────┤
│ Technology      │ Kong, AWS API Gateway, │ Istio, Linkerd, AWS App Mesh  │
│                 │ nginx, Envoy, Traefik  │ (sidecar proxy model)         │
├─────────────────┼────────────────────────┼───────────────────────────────┤
│ Ownership       │ Platform team          │ Platform / Infra team         │
└─────────────────┴────────────────────────┴───────────────────────────────┘

┌─────────────────┬────────────────────────┬───────────────────────────────┐
│                 │  API GATEWAY           │  BFF                          │
├─────────────────┼────────────────────────┼───────────────────────────────┤
│ Primary purpose │ Route + enforce policy │ Aggregate + shape data        │
│                 │ for ALL clients        │ for ONE specific client       │
├─────────────────┼────────────────────────┼───────────────────────────────┤
│ Business logic  │ NONE                   │ NONE (aggregation is layout   │
│                 │                        │ logic, not business logic)    │
├─────────────────┼────────────────────────┼───────────────────────────────┤
│ Ownership       │ Platform team          │ Frontend team per client type │
├─────────────────┼────────────────────────┼───────────────────────────────┤
│ Relationship    │ Gateway → BFF → services (they work together, not      │
│                 │ as alternatives)                                       │
└─────────────────┴────────────────────────┴───────────────────────────────┘

COMBINED PATTERN (common in production):
  Client → API Gateway (auth, rate limit, route) → BFF (aggregate, shape) → Services
  Gateway handles policies. BFF handles composition. Services handle domain.
```

---

_→ Continued in: [03-API Gateway.md](03-API%20Gateway.md)_
