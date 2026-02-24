# API Gateway — Part 3 of 3

### Sections: 9 (Cloud Mapping), 10 (Tradeoff Analysis), 11 (System Design Interview), 12 (Design Exercise)

**Series:** System Design & Architecture → Topic 06

---

## SECTION 9 — Cloud Mapping

### AWS API Gateway and Related Services

```
AWS PROVIDES MULTIPLE GATEWAY OPTIONS:

┌──────────────────────────────────────────────────────────────────────────┐
│                    AWS API GATEWAY (REST API type)                       │
│  Best for: Public APIs, complex routing, Lambda integrations             │
│  Features: Full request/response transformation, custom authorizers,     │
│             usage plans, caching (up to 300s TTL per route)              │
│  Auth: Cognito User Pools, Lambda Authorizer, IAM, API keys              │
│  Pricing: $3.50 / million API calls + data transfer                      │
│  Cold start: Lambda integrations have cold starts — not ultra-low latency│
│  Added latency: ~5-10ms per request (managed infra overhead)             │
└──────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────┐
│                    AWS API GATEWAY (HTTP API type)                       │
│  Best for: Lower cost, lower latency, simple APIs                        │
│  Features: JWT authorizers, CORS, VPC links. FEWER features than REST.  │
│  Auth: JWT only (no custom Lambda authorizers without workaround)        │
│  Pricing: $1.00 / million API calls (3.5× cheaper than REST API type)   │
│  Added latency: ~2-3ms per request (lighter weight than REST type)       │
└──────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────┐
│                  AWS API GATEWAY (WebSocket API type)                    │
│  Best for: Real-time bidirectional apps (chat, dashboards, gaming)       │
│  Features: Persistent WebSocket connections, connection management,      │
│             route selection expressions, Lambda handlers per message type│
└──────────────────────────────────────────────────────────────────────────┘
```

---

### Full AWS Production Architecture

```
                         Route 53 (Weighted routing / health checks)
                              │
                    ┌─────────▼──────────┐
                    │  Amazon CloudFront  │
                    │  (CDN + edge cache) │
                    │  AWS WAF attached   │
                    │  (OWASP rules,      │
                    │   rate-based rules, │
                    │   ip reputation)    │
                    └─────────┬──────────┘
                              │ HTTPS
                    ┌─────────▼──────────────────────────┐
                    │      Amazon API Gateway             │
                    │      (HTTP API type)                │
                    │                                     │
                    │  JWT Authorizer → AWS Cognito        │
                    │  or Lambda Authorizer (for custom   │
                    │   tokens or API key → partner maps) │
                    │                                     │
                    │  Usage Plans + API Keys             │
                    │  (partner tier rate limits)         │
                    │                                     │
                    │  Routes:                            │
                    │  /users/*    → UserSvc VPC Link      │
                    │  /orders/*   → OrderSvc VPC Link     │
                    │  /products/* → CatalogSvc VPC Link   │
                    └──────┬─────────────────────────────┘
                           │ VPC Link (private traffic)
                    ┌──────▼─────────────────────────────────────────┐
                    │           PRIVATE VPC                          │
                    │                                                │
                    │   NLB (Network Load Balancer)                  │
                    │    → ECS Service (User Service)                │
                    │    → ECS Service (Order Service)               │
                    │    → ECS Service (Catalog Service)             │
                    │                                                │
                    │   ElastiCache Redis (rate limit counters,      │
                    │                     JWT public key cache)      │
                    │                                                │
                    │   RDS Aurora (domain databases)                │
                    └────────────────────────────────────────────────┘

KEY AWS DESIGN DECISIONS:

1. CloudFront + WAF IN FRONT of API Gateway:
   - CloudFront caches GET responses (product catalog: 60s TTL), reducing
     API Gateway invocations (cost savings + latency reduction).
   - WAF absorbs DDoS traffic before reaching API Gateway.
   - CloudFront geographic restrictions (block by country if needed).

2. LAMBDA AUTHORIZER for custom auth:
   // authorizer.js — deployed as Lambda, invoked by API Gateway
   exports.handler = async (event) => {
     const token = event.authorizationToken.replace('Bearer ', '');
     const decoded = await verifyJWT(token);       // fetches JWK set from cache
     return {
       principalId: decoded.sub,
       policyDocument: generatePolicy('Allow', event.methodArn),
       context: {
         userId: decoded.sub,
         roles: decoded.roles.join(','),
         tier: decoded.tier
       }
     };
   };

   API Gateway caches Lambda Authorizer results by token (up to 300s).
   This means: ONE Lambda invocation per token per TTL period → cost efficiency.

3. VPC LINK:
   External: API Gateway lives in AWS-managed infrastructure (outside your VPC).
   Internal: Your ECS services live in your private VPC.
   VPC Link creates a private connection between them.
   ECS services have no public IP. Only reachable via VPC Link → API Gateway.

4. USAGE PLANS + API KEYS (for partner API tier):
   // Programmatic setup via AWS SDK
   const plan = await apigateway.createUsagePlan({
     name: 'PartnerProTier',
     throttle: { rateLimit: 100, burstLimit: 200 },  // req/sec
     quota: { limit: 50000, period: 'MONTH' }
   });
   // Assign API key to usage plan → partner gets their rate-limited API key
```

---

## SECTION 10 — Tradeoff Analysis

### Decision Matrix

```
┌──────────────────────────────┬──────────────────────────────────────────────┐
│  DIMENSION                   │  API GATEWAY                                 │
├──────────────────────────────┼──────────────────────────────────────────────┤
│ Cross-cutting concerns       │ ✅ Implemented ONCE. Auth, rate limiting,    │
│ centralized                  │ TLS, logging: changes in one place,          │
│                              │ propagate to all routes automatically.        │
├──────────────────────────────┼──────────────────────────────────────────────┤
│ Security surface reduction   │ ✅ Downstream services are NOT publicly      │
│                              │ addressable. Only the Gateway is exposed.    │
│                              │ 8 services → 1 public attack surface.        │
├──────────────────────────────┼──────────────────────────────────────────────┤
│ DDoS + rate limit protection │ ✅ Centralized. All abuse blocked at the     │
│                              │ Gateway before hitting any service.          │
├──────────────────────────────┼──────────────────────────────────────────────┤
│ Observability                │ ✅ Every external request logged in ONE place │
│                              │ with consistent format. Correlation IDs      │
│                              │ injected for distributed tracing.            │
├──────────────────────────────┼──────────────────────────────────────────────┤
│ Added latency                │ ❌ Every request: +2-10ms overhead           │
│                              │ (managed gateways: ~5-10ms;                 │
│                              │  self-hosted nginx/Kong: ~1-2ms).            │
│                              │ Usually acceptable (<5% of typical response  │
│                              │ time). Matters for sub-10ms SLA targets.     │
├──────────────────────────────┼──────────────────────────────────────────────┤
│ Single Point of Failure      │ ❌ If Gateway fails: ENTIRE API fails.       │
│                              │ Even if all downstream services are healthy. │
│                              │ MITIGATION: Multi-AZ HA deployment.         │
│                              │ Cost: 3+ instances always running.           │
├──────────────────────────────┼──────────────────────────────────────────────┤
│ "God Gateway" anti-pattern   │ ❌ RISK: Teams start adding business logic   │
│                              │ to the gateway (discount rules, feature     │
│                              │ flags, user-tier routing).                   │
│                              │ Gateway becomes a deployment bottleneck.     │
│                              │ MITIGATION: Strict "no business logic"       │
│                              │ policy enforced in code reviews.             │
├──────────────────────────────┼──────────────────────────────────────────────┤
│ Vendor lock-in (managed)     │ ❌ AWS API Gateway has proprietary config    │
│                              │ format. Migrating to Kong/nginx requires     │
│                              │ rewriting all route configuration.           │
│                              │ MITIGATION: Abstract with IaC (Terraform)   │
│                              │ or accept the trade-off.                     │
└──────────────────────────────┴──────────────────────────────────────────────┘
```

---

### API Gateway Product Comparison

```
MANAGED (fully hosted by cloud provider):

  AWS API GATEWAY:
    + Zero infra management
    + Scales automatically to millions of req/sec
    + Native Lambda, ECS, ALB, EC2 integrations
    - Proprietary config → lock-in
    - Higher latency than self-hosted (~5ms overhead)
    - Cost can be significant at high volume ($3.50/million calls)

  Azure API Management:
    + Same benefits as AWS for Azure workloads
    + Developer portal built-in (API documentation, subscription management)
    - Very expensive compared to AWS

  Google Cloud API Gateway / Apigee:
    + Apigee has advanced analytics, monetization
    - Apigee is enterprise-priced

SELF-HOSTED (you run it):

  Kong Gateway (Open Source):
    + Runs on any infra (ECS, K8s, VM)
    + Plugin ecosystem (150+ plugins: rate limiting, auth, caching, transforms)
    + Lower latency than managed (Lua plugins, ~1ms overhead)
    + No per-request cost
    - You manage infra, HA, upgrades
    - Steep learning curve for plugin development

  NGINX + Lua / OpenResty:
    + Most battle-tested, lowest latency (<1ms overhead)
    + Full configuration control
    - Manual HA, manual scaling
    - Complex configuration
    - Requires nginx expertise

  Envoy (base for Istio, solo):
    + High performance, L7 capabilities
    + gRPC support native
    - Configuration is verbose (YAML heavy)
    - Primarily designed as a sidecar (service mesh); API Gateway use requires extra setup

DECISION FRAMEWORK:
  Starting up / small team:     AWS API Gateway HTTP API (simplest, cheapest to operate)
  Medium scale (< 5M req/day):  AWS API Gateway REST API or Kong on ECS
  Large scale (> 100M req/day): Kong or Envoy self-hosted on Kubernetes
  Low-latency SLA (< 5ms total):Self-hosted nginx or Envoy
```

---

## SECTION 11 — System Design Interview Discussion

**Q: "You have 10 microservices. How do you handle authentication across all of them?"**

> "Without a centralized auth mechanism, each service would need to validate JWTs independently — duplicated across 10 services. When we rotate keys or change algorithms, 10 deployments required simultaneously.
>
> The answer is to move authentication to the API Gateway. Every external request passes through the Gateway first. The Gateway validates the JWT (checking signature against our JWKS endpoint, verifying expiry, checking issuer). Once validated, the Gateway injects the claims as trusted headers — X-User-Id, X-User-Roles — before forwarding to the downstream service.
>
> Downstream services trust these headers. They don't re-validate the JWT. This is safe because downstream services are NOT publicly accessible — they only receive traffic via the Gateway (running in a private VPC subnet with security groups that block all traffic except from the Gateway's security group).
>
> Auth logic changes happen in ONE place. Key rotation: update the Gateway's JWK endpoint reference. New claim added: update the Gateway's header injection config. All 10 services benefit without any deployment."

---

**Q: "How would you prevent a single client from hammering your checkout API?"**

> "Rate limiting at the API Gateway layer. Every POST /checkout request carries an authenticated user identity (the Gateway extracted it from the JWT). The Gateway checks a counter in Redis: 'How many times has usr_abc called POST /checkout in the last 60 seconds?' If it exceeds the threshold (say, 5 per minute for the checkout endpoint), the Gateway returns HTTP 429 immediately — before the request ever reaches the Order Service.
>
> This protects downstream services from load spikes. Even if a client sends 1,000 checkout requests per second, only the first 5 per minute reach the Order Service. The Gateway absorbs the other 995.
>
> Rate limits can be tiered: free users get 5/minute, Pro users get 30/minute. We encode the user tier in the JWT claim, and the Gateway applies the corresponding limit per tier."

---

**Q: "What's the difference between an API Gateway and a Service Mesh?"**

> "They solve different traffic problems. An API Gateway handles NORTH-SOUTH traffic — requests coming from external clients (mobile apps, browsers, partners) into your services. A Service Mesh handles EAST-WEST traffic — service-to-service communication inside your cluster.
>
> The API Gateway authenticates using JWT or API keys — user identity. The Service Mesh authenticates using mTLS — service identity. 'Is this really the Order Service talking to the Inventory Service, or an impersonator?'
>
> They're not alternatives — in a mature microservices deployment, you typically have both. The API Gateway sits at the public boundary. The Service Mesh handles internal communication, circuit breaking, retries, and observability between services.
>
> For small teams or early-stage: start with just the API Gateway. Add the Service Mesh when internal service communication complexity warrants it."

---

## SECTION 12 — Design Exercise

### Exercise: Design the API Gateway Strategy

**Scenario:**
You're designing the backend for a ride-sharing platform. You have these clients:

- Rider mobile app (iOS + Android)
- Driver mobile app (separate app)
- Partner API (for corporate accounts to book rides programmatically)
- Internal admin dashboard (used by customer support and ops team)

You have these backend services:

- Auth Service (issues JWTs)
- Rider Service (rider profiles, payment methods)
- Driver Service (driver profiles, vehicle info, earnings)
- Trip Service (create trip, match driver, track, complete)
- Pricing Service (surge pricing, estimates)
- Payment Service (charge rider, pay driver)

**Design the API Gateway strategy: what routes exist, what auth applies, what rate limits, what special policies?**

---

**Answer:**

```
CHOICE: 2 separate gateways (two different trust domains)

GATEWAY 1: api.rideshare.com (mobile + partner — external facing)
GATEWAY 2: admin-api.rideshare.com (internal admin — restricted access)

─── GATEWAY 1: api.rideshare.com ────────────────────────────────────────────

AUTH STRATEGY:
  /rider/*    → JWT validation (Firebase Auth, Rider JWT claims)
  /driver/*   → JWT validation (Firebase Auth, Driver JWT claims)
  /partner/*  → OAuth 2.0 bearer token validation (issued by Auth Service)
              + API key for request identification
  /public/*   → No auth (pricing estimates, service availability checks)

RATE LIMITS:
  Service       | Rider Free | Rider Pro | Driver  | Partner  | Public
  /trips/create | 5/min      | 30/min    | N/A     | 100/min  | N/A
  /pricing/est  | 60/min     | 200/min   | 100/min | 500/min  | 20/min
  /driver/*     | N/A        | N/A       | 120/min | N/A      | N/A

ROUTING:
  GET  /rider/profile          → Rider Service
  GET  /rider/trips            → Trip Service
  POST /trips                  → Trip Service (rate-limited: 5/min free)
  GET  /pricing/estimate       → Pricing Service (public, cached 30s in gateway)
  GET  /driver/earnings        → Driver Service (JWT must have role=driver)
  POST /driver/availability    → Driver Service (JWT must have role=driver)
  POST /partner/trips          → Trip Service (OAuth 2.0 corporate token)

SPECIAL POLICIES:
  POST /trips (create trip):
    After routing: inject X-Surge-Active header (Pricing Service consulted in gateway
    pre-flight — if surge > 3×, add warning header for downstream to log)

    Wait — this is business logic! WRONG to put in gateway.
    Correct: Trip Service checks surge status by calling Pricing Service.
    Gateway routes. No surge logic in gateway.

  WebSocket: GET /trips/{id}/track → Trip Service WebSocket endpoint
    (Riders track real-time driver location)
    Gateway maintains WebSocket connection, authenticates once on upgrade.

─── GATEWAY 2: admin-api.rideshare.com ──────────────────────────────────────

AUTH: Okta SSO + MFA required (ops team employees only)
     IP allowlist: only office IPs + VPN IPs (block all others at WAF level)

RATE LIMITS: More permissive (internal ops tools, not external clients)
  Admin endpoints: 1000/min per admin user

ROUTING: Broader access — admin can reach all services with elevated claims
  ALL internal services available, with admin JWT claims

NO PUBLIC INTERNET ACCESS:
  This gateway sits behind VPN. CF distribution restricted to VPN exit IPs.
  Even if someone finds the URL, they can't access without VPN + MFA Okta SSO.
```

---

## === Architect's Mental Model ===

### 5 Decision Rules

**Rule 1: The Gateway's job is to enforce policies, not implement domain logic.**
Authentication = policy (who are you?). Rate limiting = policy (how much can you use?). TLS = policy (how is this transmitted?). Routing = policy (who handles this?). Discount rules, order eligibility, loyalty tier calculations = domain logic. Domain logic belongs in domain services. The moment you put an `if tier === 'gold'` rule in the Gateway, you've made the Platform team the bottleneck for product changes. Strictly: Gateway enforces; services decide.

**Rule 2: Downstream services are never publicly addressable.**
The entire value of the security model depends on this. If Order Service is also accessible at order-service.myapp.com directly (bypassing the gateway), all your centralized auth and rate limiting is meaningless. Security groups / firewall rules must enforce: "Order Service accepts traffic ONLY from the Gateway security group." Internal services live strictly in private subnets.

**Rule 3: The Gateway must be stateless with HA.**
Rate limit counters: Redis (shared external store). JWT public keys: cached from JWKS endpoint with refresh. Session data: not in the gateway, in an external store. With stateless + multi-AZ deployment, losing a gateway instance never affects users. No gateway instance is irreplaceable. All state is external.

**Rule 4: JWT validation at the Gateway means downstream services can trust injected headers — but only if the network enforces it.**
"Trust but verify" is wrong here. "Trust because the network guarantees it" is right. Downstream services trust `X-User-Id` because it's IMPOSSIBLE for an external client to set that header (the Gateway strips and re-injects it). If for any reason a service is externally accessible (Rule 2 violated), the injected-header trust model collapses. Rules 2 and 4 are symbiotic.

**Rule 5: Self-service route registration for product teams.**
If every new API route requires a Platform team ticket, the Gateway becomes a product velocity bottleneck. The right model: product teams submit a GitHub PR to the gateway config repo (OpenAPI spec, Kong Declarative config, API Gateway OpenAPI import). Platform team reviews for security. PR auto-merged → auto-deployed. Product teams ship independently.

---

### 3 Common Mistakes

**Mistake 1: Treating the API Gateway as the only security layer.**
"Our JWT is validated at the Gateway — services don't need to think about security." True for auth. False for other concerns. Services must still: validate input (injection attacks), handle authorization at the data level (can THIS user access THAT order? — the Gateway only knows the user is authenticated, not whether they own order_123), apply application-level rate limiting for expensive internal operations. The Gateway is the first security layer, not the only one.

**Mistake 2: Running a single instance in production.**
"We'll add HA when we need it." In a demo: one gateway instance works fine. In production at midnight: the gateway instance's host has a memory leak → OOM killer → instance restart → 30 seconds of downtime for the entire API → angry users, lost orders, incident review. Minimum viable production: 2 instances across 2 AZs from day one for any customer-facing API.

**Mistake 3: Choosing REST API type when HTTP API type would suffice.**
AWS API Gateway REST API type has extensive features but is 3.5× more expensive and adds more latency than HTTP API type. Most APIs only need: JWT auth, CORS, VPC routing, basic request mapping. HTTP API type handles all of this cheaper and faster. Use REST API type only when you specifically need: request/response body mapping transforms, usage plans for API key management, Lambda proxy integration with legacy patterns, or caching.

---

### 30-Second Interview Answer

> "An API Gateway solves the cross-cutting concerns problem in microservices. Without it, every service independently implements authentication, rate limiting, and logging — logic duplicated across dozens of services, drifting out of sync. The Gateway is a single entry point for all external traffic. It validates JWTs once, enforces rate limits per client tier, handles TLS termination, injects correlation IDs for distributed tracing, and routes requests to the appropriate downstream service. Downstream services are private — not publicly addressable — so the Gateway is the only public attack surface. Key constraints: the Gateway must be stateless (rate limit counters in Redis, not local memory) and deployed in HA mode across availability zones, since it's a single point of failure. The Gateway enforces policies; business logic stays in domain services."

---

_End of Topic 06 — API Gateway_
_Series: System Design & Architecture — Topics 01-06 complete._
