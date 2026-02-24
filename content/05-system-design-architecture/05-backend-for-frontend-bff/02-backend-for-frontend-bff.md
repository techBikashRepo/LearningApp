# Backend-for-Frontend (BFF) — Part 2 of 3

### Sections: 5 (Request Flow), 6 (What Breaks When Responsibilities Mix), 7 (Team Scaling Impact), 8 (Architectural Implications)

**Series:** System Design & Architecture → Topic 05

---

## SECTION 5 — Request Flow Through BFF

### Mobile App: Load User Dashboard (Single BFF Call)

```
MOBILE REQUEST:
  GET /mobile/dashboard
  Authorization: Bearer <firebase-jwt>
  User-Agent: MyApp/iOS/2.3.1

─── API GATEWAY ─────────────────────────────────────────────────────────

  1. Route: /mobile/* → Mobile BFF
  2. Rate limiting: 60 req/min for this client IP
  3. TLS termination
  4. Forward to Mobile BFF with original headers

─── MOBILE BFF (orchestration layer) ────────────────────────────────────

  5. Authentication:
     Validate Firebase JWT token.
     Extract: userId = "usr_abc", deviceId = "iphone_xyz"

  6. Fan-out to downstream services IN PARALLEL:
     Promise.all([
       UserService.GET /users/usr_abc           → { name, avatar, loyaltyTier }
       OrderService.GET /orders?userId=usr_abc  → last 3 orders summary
       NotificationService.GET /notifications/count?userId=usr_abc → unread count
     ])

     All 3 calls execute simultaneously.
     Downstream latency: max(UserSvc latency, OrderSvc latency, NotifSvc latency)
     Typical: max(50ms, 60ms, 30ms) = 60ms

     Without BFF parallel fan-out:
     Client would call 3 services sequentially: 50 + 60 + 30 = 140ms

  7. Aggregate and shape response:
     {
       user: {
         displayName: `${user.firstName} ${user.lastName}`,
         avatarUrl: CDN_URL + user.avatarPath,
         loyaltyTier: user.loyaltyTier      // "Gold"
       },
       recentOrders: orders.slice(0, 3).map(o => ({
         orderId: o.id,
         status: o.status,
         total: formatCurrency(o.totalCents, o.currency),
         date: formatRelativeDate(o.createdAt)  // "2 days ago"
       })),
       unreadNotifications: notifCount
     }

     Response size: ~400 bytes (vs 12KB if client fetched everything raw)

  8. Set HTTP headers:
     Cache-Control: private, max-age=30   (30-second client cache)
     X-Response-Time: 68ms

─── CLIENT RECEIVES ─────────────────────────────────────────────────────

  HTTP 200, 400 bytes.
  Mobile app renders dashboard.
  1 API call. 3 services queried in parallel. Client sees 68ms total.
```

---

### What Happens When One Downstream Service Fails

```
SCENARIO: NotificationService is down (returns 503).

NAIVE BFF (no resilience):
  BFF waits for NotificationService. 30-second timeout.
  Mobile user sees blank dashboard for 30 seconds.
  Then gets 500 error.

RESILIENT BFF (production pattern):
  5. Fan-out with timeout + fallback per service:

     const [user, orders, notifCount] = await Promise.allSettled([
       UserService.GET /users/usr_abc         + 5s timeout,
       OrderService.GET /orders?userId=usr_abc + 5s timeout,
       NotificationService.GET /notifications/count + 2s timeout (less critical)
     ]);

  7. Aggregate with graceful degradation:
     {
       user: user.status === 'fulfilled' ? user.value : null,
       recentOrders: orders.status === 'fulfilled' ? orders.value : [],
       unreadNotifications: notifCount.status === 'fulfilled'
                            ? notifCount.value
                            : 0,    ← fallback value — dashboard still renders
       _partialResponse: notifCount.status === 'rejected'  ← hint to client
     }

  Response sent in 68ms (not waiting for NotificationService timeout).
  Mobile dashboard still shows user + orders.
  Notification badge shows 0 (with "_partialResponse" flag — client can show "—" badge).

  This is the BFF's responsibility: graceful degradation per client's UX requirements.
  The upstream services don't know how to degrade — the BFF does.
```

---

## SECTION 6 — What Breaks When BFF Responsibilities Mix

### Anti-Pattern 1: Business Logic in the BFF

```javascript
// BAD: BFF contains order eligibility logic
// Mobile BFF endpoint: GET /mobile/checkout/eligibility
async function checkCheckoutEligibility(userId) {
  const user = await userService.getUser(userId);
  const orders = await orderService.getActiveOrders(userId);
  const wallet = await paymentService.getWallet(userId);

  // BUSINESS RULE — belongs in OrderService, not the BFF
  const canCheckout =
    user.status === "active" &&
    orders.filter((o) => o.status === "unpaid").length < 3 &&
    wallet.balance >= 0;

  return { eligible: canCheckout };
}
```

**What breaks:**

1. The Web BFF also needs to check checkout eligibility. It duplicates the same logic.
2. A business rule changes: unpaid orders threshold increases from 3 to 5. Both BFFs must be updated. One team forgets. Web users can checkout. Mobile users can't. Support tickets flood in.
3. The correct home for "can this user checkout?" is OrderService.canUserCheckout(userId) — one place, consumed by all BFFs.

---

### Anti-Pattern 2: One BFF Serving All Clients

```
BAD: "Let's just have one BFF and add query parameters for client type."

GET /api/dashboard?clientType=mobile
GET /api/dashboard?clientType=web
GET /api/dashboard?clientType=tv

BFF code:
  if (clientType === 'mobile') { return compactPayload(); }
  if (clientType === 'web')    { return richPayload(); }
  if (clientType === 'tv')     { return tvPayload(); }
```

**What you've built:** Not a BFF. A single backend that's trying to be all things to all clients. This recreates the original problem. Now the mobile team can't deploy their BFF changes without the TV team approving the PR. The "BFF" is owned by nobody in particular, and therefore optimized for nobody.

**Production consequence:** Every client change requires a coordination meeting. Every deployment risks breaking another client. The Mobile team is blocked waiting for the Web team's approval on their BFF changes.

---

### Anti-Pattern 3: BFF With Its Own Database

```
BAD: Mobile BFF writes to its own database
  MobileBFF → POST /orders → writes to mobile_bff.orders table
  MobileBFF → GET /orders  → reads from mobile_bff.orders table
```

**What breaks:**

- The canonical order state now lives in BOTH the Order Service AND the BFF database.
- The BFF database is a cache that grows stale. Mobile users see different orders than web users.
- Consistency between BFF database and Order Service database requires synchronization — an entirely new problem.

**Rule:** BFFs are stateless aggregators. They read from downstream services and compose responses. They do NOT write to their own databases. The only acceptable storage in a BFF is an ephemeral read cache (Redis), never a writes source of truth.

---

## SECTION 7 — Team Scaling Impact

### The Conway's Law Alignment

```
TRADITIONAL BACKEND API TEAM:

  Mobile Team: "We need these 3 fields added to the /me endpoint."
  Backend Team: "That's sprint 6. We have other priorities."
  Mobile Team: waits 6 weeks. Ships mobile feature late.

  Problem: Mobile development velocity coupled to Backend team velocity.

BFF PATTERN TEAM ALIGNMENT:

  Mobile Team OWNS Mobile BFF.
    → Can deploy new endpoints anytime (no backend team approval)
    → Adds new fields by calling an existing upstream service endpoint
    → Full stack team: mobile engineers own the full mobile experience
       including the server-side composition layer

  Web Team OWNS Web BFF.
    → Independently evolves web API without breaking mobile
    → Can deprecate old fields on their own schedule

  Backend Teams OWN domain services (User, Order, Payment, etc.)
    → Focused on domain logic, not on client-specific presentation
    → Their API stabilizes because they're not constantly adding
       client-specific fields to a generic API
    → Clients call via BFFs, not directly
```

---

### BFF Team Structure at Scale

```
SMALL COMPANY (1 team, 2 clients):
  1 backend team, 1 BFF that serves both mobile and web.
  Acceptable tradeoff: team is too small to split.
  Risk: the "one BFF for all" anti-pattern creeps in.
  Mitigation: separate route files /mobile/* and /web/* even in one BFF.

MEDIUM COMPANY (2 teams, 3 clients):
  Mobile team: owns Mobile BFF + mobile app
  Web team:    owns Web BFF + web frontend

  Backend API team: owns User, Order, Payment, Catalog microservices.
  Each BFF team can deploy independently.

LARGE COMPANY (6+ teams, 5+ clients):
  Each product area has their BFF aligned with their client:
    Mobile team: Mobile BFF (iOS + Android share one BFF)
    Web team:    Web BFF
    TV team:     Smart TV BFF
    Partner team:Partner API BFF (with SLA, versioning, OAuth)
    Internal:    Internal Tools BFF (admin dashboard)
```

---

## SECTION 8 — Architectural Implications

### BFF vs GraphQL

```
GraphQL is often proposed as an alternative to BFF. Let's compare.

GRAPHQL:
  Client sends a query describing EXACTLY what fields it needs.
  Server returns only those fields.
  Solves: over-fetching and under-fetching in one mechanism.

  "We don't need BFF — the client can just query what it needs via GraphQL."

  WHERE GRAPHQL WORKS WELL:
    ✅ Rapid UI iteration where data requirements change frequently
    ✅ Multiple clients with very different field needs
    ✅ One team managing the GraphQL schema can serve multiple product teams

  WHERE GRAPHQL STRUGGLES:
    ❌ N+1 query problem (each field resolver is a potential DB query)
        Requires DataLoader batching — non-trivial to implement correctly
    ❌ Caching is harder (POST requests, dynamic queries → CDN caching breaks)
    ❌ Introspection leaks schema details to attackers
    ❌ Schema governance: 6 teams contributing to one schema → coordination overhead
    ❌ Rate limiting: hard to limit "expensive" dynamic queries
    ❌ Mobile: flexible queries mean mobile devs must know the schema deeply

BFF VS GRAPHQL — THEY'RE NOT MUTUALLY EXCLUSIVE:

  Common pattern: BFF EXPOSES a REST or GraphQL API to the frontend.
  BFF INTERNALLY calls downstream microservices via REST/gRPC.

  Option A: BFF = REST API (tailored, fixed endpoints per page/feature)
    + Simple caching, predictable performance, easy to CDN-cache
    - Requires a BFF change for every new data requirement

  Option B: BFF exposes GraphQL to the frontend
    + Frontend team controls data needs without BFF change
    - Requires GraphQL knowledge on frontend team, DataLoader, schema management

  COMMON HYBRID:
    Web BFF: exposes limited GraphQL for flexible web UI
    Mobile BFF: exposes fixed REST endpoints (for simplicity, caching, performance)
```

---

### Performance and Network Implications

```
CLIENT WITHOUT BFF:

  Mobile app dashboard load:
  1. GET /users/{id}       → 50ms
  2. GET /orders?userId={id}—►waits for (1)→ 60ms  (sequential if dependent on userId)
  3. GET /notifications/count → 30ms (could be parallel, but client-side code is sequential)

  Total waterfall: 140ms of API calls + rendering time.
  Data transferred: 12KB (full objects with all fields).

CLIENT WITH BFF:

  Mobile app dashboard load:
  1. GET /mobile/dashboard  → BFF fans out to all 3 services in parallel → 60ms

  Total: 60ms of API calls (parallel fan-out).
  Data transferred: 400 bytes (shaped response).

  Performance gain:
  - Latency: 140ms → 60ms (-57%)
  - Bandwidth: 12KB → 400 bytes (-97%)

  ON CELLULAR (3G, 5 Mbps):
  12KB download: ~20ms additional transfer time
  400 bytes download: ~0.6ms additional transfer time

  At 1M mobile users × 10 dashboard loads/day:
  Without BFF: 1M × 10 × 12KB = 120GB/day in API responses
  With BFF:    1M × 10 × 0.4KB = 4GB/day
  CDN/bandwidth cost saved: significant at scale.
```

---

_→ Continued in: [03-Backend-for-Frontend (BFF).md](<03-Backend-for-Frontend%20(BFF).md>)_
