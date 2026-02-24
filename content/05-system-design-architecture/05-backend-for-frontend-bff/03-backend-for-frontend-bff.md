# Backend-for-Frontend (BFF) — Part 3 of 3

### Sections: 9 (Cloud Mapping), 10 (Tradeoff Analysis), 11 (System Design Interview), 12 (Design Exercise)

**Series:** System Design & Architecture → Topic 05

---

## SECTION 9 — Cloud Mapping

### BFF Architecture on AWS

```
                        Route 53 (DNS)
                              │
                     CloudFront (CDN + WAF)
                              │
              ┌───────────────▼──────────────────┐
              │       API Gateway (AWS)           │
              │  Routes:                          │
              │    /mobile/* → Mobile BFF ALB    │
              │    /web/*    → Web BFF ALB        │
              │    /partner/*→ Partner API BFF    │
              │  Auth: JWT validation (Lambda     │
              │         Authorizer per BFF)       │
              └──┬──────────────┬────────────────┘
                 │              │
  ┌──────────────▼──┐    ┌──────▼──────────┐   ┌──────────────────┐
  │  Mobile BFF     │    │   Web BFF        │   │  Partner BFF     │
  │  ECS Fargate    │    │  ECS Fargate     │   │  ECS Fargate     │
  │  Task: Node.js  │    │  Task: Node.js   │   │  Task: Node.js   │
  │  ALB in front   │    │  ALB in front    │   │  ALB in front    │
  │  Auto-scaling   │    │  Auto-scaling    │   │  Auto-scaling    │
  │  HPA on CPU 70% │    │  HPA on CPU 70%  │   │  (scale slowly)  │
  └──────┬──────────┘    └───────┬──────────┘   └──────────────────┘
         │                       │
         └────────────┬──────────┘
                      │
         ┌────────────▼────────────────────────────────────┐
         │            INTERNAL SERVICE MESH                 │
         │   (AWS App Mesh or Kubernetes Istio)             │
         │   Service-to-service mTLS                        │
         └────────┬──────────┬──────────┬──────────────────┘
                  │          │          │
         ┌────────▼──┐  ┌────▼──┐  ┌───▼──────────┐
         │UserService│  │Order  │  │Notification  │
         │ECS Fargate│  │Service│  │  Service     │
         └───────────┘  └───────┘  └──────────────┘

KEY DECISIONS:

SEPARATE ALBs per BFF:
  Mobile BFF and Web BFF get their own ALBs.
  This enables: independent health checks, independent security groups,
  different TLS certificates per domain (api-mobile.myapp.com vs api.myapp.com).

ECS AUTO-SCALING TARGETS:
  Mobile BFF: scales aggressively (mobile traffic peaks at 8am, 6pm)
  Web BFF: scales moderately (business hours traffic)
  Partner BFF: scales conservatively (SLA-bound, predictable traffic)

CACHING LAYER:
  Mobile BFF: Amazon CloudFront cache (GET /mobile/catalog/*: 5-minute CDN cache)
              ElastiCache Redis (user session + recently viewed: 30-second cache)
  Web BFF:    ElastiCache Redis (user dashboard data: 10-second cache)
  Partner BFF: No aggressive caching (partners need fresh data for B2B operations)

CI/CD INDEPENDENCE:
  Mobile team's GitHub repository → GitHub Actions → builds Mobile BFF image
  → pushes to ECR mobile-bff:v1.2.3 → deploys to ECS mobile-bff service

  Web team's GitHub repository → separate pipeline → Web BFF ECR → Web BFF ECS

  Teams deploy independently. Zero coordination required between teams.
```

---

### Cloud Cost Considerations

```
BFF ADDS:
  + N additional ECS services (N = number of BFFs)
  + N additional ALBs
  + N additional ECR repositories
  + Inter-service network traffic (BFF → microservices, within VPC = cheap)

BFF REMOVES:
  - Reduced bandwidth to clients (600x less data to mobile = cost savings at scale)
  - Fewer client-side API calls (1 BFF call vs 5 direct calls = less ALB traffic)
  - Reduced downstream service load (BFF can cache aggressively)

TYPICAL AWS COST DELTA for mid-scale app:
  3 BFF ECS services (minimal instances): +$200-400/month
  3 extra ALBs: +$60/month
  ElastiCache (Redis for BFF caching): +$100/month
  Bandwidth savings (mobile): -$500-2000/month at 1M active users

  NET: BFF pattern is typically cost-neutral to cost-positive at scale.
```

---

## SECTION 10 — Tradeoff Analysis

### Decision Matrix

```
┌─────────────────────┬──────────────────────────────────────────────────┐
│  DIMENSION          │  BFF PATTERN                                     │
├─────────────────────┼──────────────────────────────────────────────────┤
│ Reduced Over-fetch  │ ✅ BFF returns ONLY the fields the client needs  │
│                     │ Mobile gets 400 bytes instead of 8KB             │
│                     │ Massive bandwidth savings on mobile/IoT           │
├─────────────────────┼──────────────────────────────────────────────────┤
│ Reduced Under-fetch │ ✅ BFF aggregates multiple services into one call │
│                     │ Eliminates client-side waterfall API calls        │
│                     │ Dashboard: 1 call vs 5 sequential calls          │
├─────────────────────┼──────────────────────────────────────────────────┤
│ Team Autonomy       │ ✅ Each client team owns + deploys their BFF      │
│                     │ Mobile team ships independently of web team.      │
│                     │ No cross-team API coordination for UI changes.   │
├─────────────────────┼──────────────────────────────────────────────────┤
│ Client-specific     │ ✅ BFF implements client-specific error handling, │
│ Optimization        │ caching, authentication, protocol.               │
│                     │ TV BFF: slow responses OK. Mobile: 300ms budget. │
├─────────────────────┼──────────────────────────────────────────────────┤
│ Code Duplication    │ ❌ Multiple BFFs may duplicate similar logic      │
│                     │ "Get user with orders" logic: in Mobile BFF,     │
│                     │ Web BFF, TV BFF — all slightly different.        │
│                     │ MITIGATION: shared SDK / common library for      │
│                     │ downstream service calls (not for logic)         │
├─────────────────────┼──────────────────────────────────────────────────┤
│ Operational Load    │ ❌ N more services to deploy, monitor, scale      │
│                     │ At 4 BFFs: 4 more CI pipelines, 4 more services, │
│                     │ 4 more on-call runbooks.                         │
│                     │ Only justified if teams ARE autonomous.          │
├─────────────────────┼──────────────────────────────────────────────────┤
│ Business Logic      │ ❌ RISK: Logic can creep into BFFs               │
│ Governance          │ "If we can change the BFF without asking backend,│
│                     │ let's put the discount logic here too."          │
│                     │ MITIGATION: strict code review rule:             │
│                     │ "BFF contains no if-statements about domain."   │
├─────────────────────┼──────────────────────────────────────────────────┤
│ Consistency         │ ❌ RISK: Different BFFs can expose inconsistent  │
│                     │ data if one BFF's cache is stale.               │
│                     │ Mobile: shows 3 unpaid orders.                   │
│                     │ Web: shows 2 (BFF cache not yet invalidated).   │
│                     │ MITIGATION: coordinated cache invalidation via   │
│                     │ events, or short TTLs.                          │
└─────────────────────┴──────────────────────────────────────────────────┘
```

---

### When NOT to Use BFF

```
DO NOT use BFF when:
  ❌ Small team (< 5 engineers): operational overhead outweighs benefit
  ❌ Only one client type: no need for a "backend FOR frontend" when there's one frontend
  ❌ GraphQL in use: GraphQL already solves over/under-fetching
  ❌ Monolith architecture: BFF makes most sense in a microservices context
     (if there's one monolith, just add a client-specific view layer)
  ❌ All clients have similar data needs (no differentiation needed)

USE BFF when:
  ✅ 3+ client types with fundamentally different UX requirements
  ✅ Mobile optimization is critical (bandwidth, battery)
  ✅ Different teams own different client surfaces
  ✅ You want to decouple client-specific presentation from domain logic
  ✅ Microservices architecture is already in place
```

---

## SECTION 11 — System Design Interview Discussion

**Q: "Design the backend architecture for a streaming platform like Spotify, which has a web app, mobile app, desktop app, and smart TV app."**

**Where BFF fits in the answer:**

> "Each of these four clients has fundamentally different UX requirements.
>
> The iOS app is on cellular data — it needs compact payloads, < 300ms responses, and aggressive caching of the catalog (which changes rarely). The web app runs in a browser with fast WiFi and needs rich metadata for the player, album art in high resolution, and social features like follower activity feeds. The Smart TV app needs the exact 3 currently-featured albums and nothing else — and it renders differently, so it doesn't need album art at full resolution.
>
> Having a single generic API serve all four would mean: desktop and web overfetch (images, social data that TV doesn't need), mobile over-fetches on cellular data, and each client needs 4-6 API calls for one screen where one BFF call would suffice.
>
> I'd use a BFF per client surface: Mobile BFF (owned by mobile team), Web BFF (owned by web team), TV BFF (owned by TV team). Each BFF aggregates catalog data, playback state, and personalization in parallel, returning a shaped payload for exactly what that client needs.
>
> The downstream services — Catalog, Playback, Personalization, Social — remain unchanged. They serve a canonical data format. The BFFs handle all client-specific presentation concerns."

---

**Red Flags in Candidate Answers:**

```
❌ "We'd build one API that returns all the data and let the client filter."
   → This is the over-fetching problem. Cellular mobile users don't want to
     download unused data.

❌ "We'd add a query parameter ?client=mobile and branch the response."
   → This is "one BFF for all clients" — the anti-pattern. Teams can't
     deploy independently.

❌ "The BFF would handle order validation and discount rules."
   → Business logic in the BFF — a governance violation. The BFF aggregates
     and shapes; it doesn't contain domain rules.

✅ GREEN FLAGS:
   "Each BFF is owned by the frontend team that uses it."
   "BFFs fan-out to downstream services in parallel."
   "BFFs are stateless — they aggregate, not store."
   "Business rules stay in the downstream domain services."
```

---

## SECTION 12 — Design Exercise

### Exercise: Redesign for Mobile Performance

**Current state:** A fintech mobile app makes 5 sequential API calls on home screen load:

```
1. GET /api/users/{id}            → 45ms   (full user profile, 6KB)
2. GET /api/accounts/{userId}     → 60ms   (all accounts with full transaction history, 80KB)
3. GET /api/cards/{userId}        → 40ms   (all cards with full card details, 5KB)
4. GET /api/notifications/{userId}→ 35ms   (all notifications, 8KB)
5. GET /api/offers/{userId}       → 55ms   (personalized offers, 12KB)

Total: 235ms sequential API time (each waits for previous)
Total data: 111KB (on 3G: 180ms additional transfer time)
P95 page load: 580ms (235ms API + 180ms transfer + 165ms rendering)
```

**The home screen only needs:**

- User: display name, avatar, user tier
- Accounts: last 4 account balances only (no transaction history)
- Cards: card type, last 4 digits, balance for each card
- Notifications: unread count only
- Offers: top 1 featured offer (title + image URL)

**Think through the BFF redesign before reading the answer:**

---

**Answer: Mobile BFF Design**

```
MOBILE BFF ENDPOINT:
  GET /mobile/v1/home
  Authorization: Bearer <mobile-app-jwt>

BFF ORCHESTRATION:
  // Fan-out: all 5 calls in parallel
  const [user, accounts, cards, notifications, offers] = await Promise.all([
    userService.GET /users/{id}?fields=id,firstName,lastName,avatarPath,tier,
    accountService.GET /accounts/summary?userId={id},  // new summary-only endpoint
    cardService.GET /cards/summary?userId={id},        // new summary-only endpoint
    notificationService.GET /notifications/count?userId={id},
    offerService.GET /offers/featured?userId={id}&limit=1
  ]);

  // Graceful degradation
  if (offers.status === 'rejected') offers = { value: null };
  if (notifications.status === 'rejected') notifications = { value: 0 };

RESPONSE SHAPE:
  {
    "user": {
      "displayName": "Alice S.",              // first name + last initial
      "avatarUrl": "https://cdn.../alice.jpg",
      "tier": "Gold"
    },
    "accounts": [                             // summary only, no transactions
      { "accountId": "acc_1", "type": "checking", "balance": "$4,231.50" },
      { "accountId": "acc_2", "type": "savings",  "balance": "$12,800.00" }
    ],
    "cards": [
      { "cardId": "card_1", "type": "Visa", "lastFour": "4242", "balance": "$1,200.00" }
    ],
    "unreadNotifications": 3,
    "featuredOffer": {
      "title": "5% cashback on groceries",
      "imageUrl": "https://cdn.../offer.jpg",
      "offerId": "off_abc"
    }
  }

PERFORMANCE RESULT:
  API time: max(45ms, 60ms, 40ms, 35ms, 55ms) = 60ms (parallel, not sequential!)
  Data: ~500 bytes (vs 111KB)
  Transfer on 3G: ~0.8ms (vs 180ms)

  P95 page load: 60ms + 0.8ms + 100ms rendering = 161ms

  IMPROVEMENT:
    Load time: 580ms → 161ms (-72%)
    Data transferred: 111KB → 0.5KB (-99.5%)
    API calls made by mobile client: 5 → 1 (-80%)
```

---

## === Architect's Mental Model ===

### 5 Decision Rules

**Rule 1: One BFF per client type (not per page, not per API consumer).**
A BFF is not fine-grained — it serves an entire client's surface (iOS + Android share one Mobile BFF). Creating a BFF per page is over-engineering. Creating one BFF for all clients defeats the purpose. The right granularity is: one BFF per client surface that has meaningfully different UX and performance requirements.

**Rule 2: The BFF is owned by the frontend team, not the backend team.**
This is the rule that gives the pattern its value. If a dedicated backend "BFF team" owns all BFFs, you've recreated the "backend team is the bottleneck" problem. The Mobile team should be able to add a new field to the Mobile BFF dashboard endpoint in a single sprint, without any backend team approval.

**Rule 3: Business logic belongs in domain services, not in BFFs.**
The BFF's job description: aggregate, filter, transform, cache. If a BFF contains an `if` statement implementing a business rule (discount logic, eligibility check, fraud rule), it's wrong. That rule belongs in a domain service. The BFF calls the service and surfaces the result.

**Rule 4: BFFs must degrade gracefully — partial responses are better than total failures.**
When NotificationService is down, the Mobile BFF should return the dashboard without the notification count (showing 0 or "—"), not return HTTP 500. Each downstream service's failure should be handled independently. `Promise.allSettled()` not `Promise.all()`. The BFF decides the criticality of each service: user + accounts = critical (fail the request); notifications = non-critical (degrade gracefully).

**Rule 5: Fan-out, don't waterfall.**
If your BFF calls 5 services sequentially (each waiting for the previous), you've created a server-side waterfall. The whole point of the BFF is to move the waterfall FROM the client TO the server where it can be parallelized. Use `Promise.all()` (or `Promise.allSettled()` for resilience). Total latency = max(individual latencies), not sum.

---

### 3 Common Mistakes

**Mistake 1: Making BFFs stateful.**
Teams start caching in the BFF's memory (an in-process Map). This works until the BFF has more than one instance (horizontal scaling). Instance A has the cache. Instance B doesn't. Client gets inconsistent results depending on which instance handles the request. Use a shared external cache (Redis/ElastiCache), never in-process memory caching.

**Mistake 2: Creating a BFF for an integrated monolith.**
BFF is a microservices-era pattern. If your backend is a monolith with a single API, a BFF just adds an unnecessary hop. The correct approach: add client-specific response transformations within the monolith (a "view layer" in the service). Apply BFF when your backend is already multiple independent services.

**Mistake 3: Not versioning BFF endpoints.**
The mobile app ships a version. Version 2.1.0 of the app calls `/mobile/v1/dashboard`. Version 2.2.0 expects a different response shape. You deploy the BFF change and break all users on version 2.1.0 (which is still installed on millions of devices). BFF endpoints must be versioned. Old versions must be maintained until the old app version has < 5% of active traffic.

---

### 30-Second Interview Answer

> "The BFF pattern addresses the over-fetching and under-fetching problem for multiple client types. Instead of one generic API that serves mobile, web, and smart TV all identically — giving each client too much or too little data — you build a dedicated backend layer for each client surface. The Mobile BFF fetches from multiple downstream microservices in parallel and returns a compact, shaped payload optimized for mobile bandwidth. The Web BFF returns a richer, aggregated payload without waterfall client-side calls. Each BFF is owned by the frontend team that uses it, so they can evolve the API contract independently. Critical rules: BFFs contain no business logic (that lives in domain services), BFFs are stateless (no writes database), BFFs degrade gracefully on partial downstream failure."

---

_End of Topic 05 — Backend-for-Frontend (BFF)_
_→ Next: Topic 06 — API Gateway_
