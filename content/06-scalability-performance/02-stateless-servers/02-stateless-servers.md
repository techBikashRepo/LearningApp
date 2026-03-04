# Stateless Servers — Part 2 of 3

### Topic: Real World Examples, System Design Importance, AWS Mapping & Interview Prep

**Series:** Scalability & Performance → Topic 02

---

## SECTION 5 — Real World Example

### Annotated: User Checkout (Redis Session Pattern)

```
────────────────────────────────────────────────────────────────────────────
REQUEST 1: POST /cart/add  (Browser on mobile, 4G)
────────────────────────────────────────────────────────────────────────────

BROWSER:
  POST /api/cart/add
  Cookie: session_id=sess_7f3a9b   ← secure HttpOnly cookie, 30-day TTL
  Body: { "productId": "prod_99", "qty": 1 }

ALB → routes to App Server 2 (currently least busy)

APP SERVER 2 (stateless):
  ① Extract session_id=sess_7f3a9b from cookie
  ② Redis GET session:sess_7f3a9b
     → { userId: "usr_a1", cart: [], roles: ["customer"], tier: "free" }
     → Latency: 0.4ms (Redis in same VPC, same AZ)
  ③ Validate: session found, not expired ✅
  ④ Business logic:
     - Look up product prod_99 in DB → price: $29.99, in stock ✅
     - Append to cart: [{ productId: "prod_99", qty: 1, price: 29.99 }]
  ⑤ Redis SETEX session:sess_7f3a9b 86400
       { userId: "usr_a1", cart: [{...}], roles: [...], tier: "free" }
     → Writes updated session back. TTL reset to 24h.
  ⑥ Return HTTP 200: { "cartSize": 1, "total": 29.99 }

Total time: 38ms (DB: 25ms + Redis: 0.8ms + logic: 12ms)

────────────────────────────────────────────────────────────────────────────
REQUEST 2: GET /cart  (Same browser, 200ms later)
────────────────────────────────────────────────────────────────────────────

ALB → routes to App Server 1 (different server! round robin)

APP SERVER 1 (stateless):
  ① Extract session_id=sess_7f3a9b from cookie (same cookie)
  ② Redis GET session:sess_7f3a9b
     → { userId: "usr_a1", cart: [{ productId: "prod_99", qty: 1 }], ... }
     → Cart IS there. Set by Server 2 moment ago. Shared Redis.
  ③ Return HTTP 200: cart contents

Server 1 had never seen this user before. It didn't need to.
The state lived in Redis, not in Server 2's memory.
Round-robin works perfectly. Any server, any request.
```

---

### What Makes a Server "Stateful" Without You Realizing It

```
HIDDEN STATE SOURCES — CHECK THESE:

1. In-process cache (Map / LRU cache in code):

   // BAD: Server-local product cache
   const productCache = new Map();  // lives in THIS server's memory

   app.get('/products/:id', async (req, res) => {
     if (productCache.has(req.params.id)) {
       return res.json(productCache.get(req.params.id));  // only works on THIS instance
     }
     const product = await db.findProduct(req.params.id);
     productCache.set(req.params.id, product);  // other instances don't see this
     res.json(product);
   });

   Problem: Cache miss on every request to every DIFFERENT server.
   Cache hit rate: 1/N where N = number of instances.
   The "cache" helps less as you scale out.

   Fix: Move to Redis. All instances share the same cache.

2. File system writes:

   // BAD: Saving user upload to local disk
   app.post('/upload', (req, res) => {
     fs.writeFile('/tmp/uploads/user_123.jpg', req.file.buffer);
   });

   Server 1 saves /tmp/uploads/user_123.jpg.
   User requests the file: GET /uploads/user_123.jpg → routes to Server 2.
   Server 2: file not found. 404.

   Fix: Write to S3. All servers access from same source.

3. WebSocket / long-running connection state:

   Server 1 holds open WebSocket for user Alice.
   Alice receives real-time order updates via this socket.
   Server 1 scales in (terminates). Alice's WebSocket drops.

   Fix: Use a pub/sub broker (Redis Pub/Sub, AWS IoT, Socket.io with Redis adapter).
   The WebSocket connection can be on any server.
   Updates flow through Redis → broadcast to the correct connection.
```

---

## SECTION 6 — System Design Importance

### The Deployment Break

```
SCENARIO: Team has a stateful app. Does a rolling deploy.

10:00AM: Rolling deploy starts.
  App Server 1: Kill → redeploy → come back up (new version)
  During 5-minute restart:
    Server 1 had 150 active sessions in its memory.
    ALL 150 users are logged out.
    "Your session expired. Please log in again."

    If this is: a social platform → users annoyed, log back in.
    If this is: a checkout flow → user was mid-payment.
                "Please re-enter your payment details."
                50% of them don't come back. Lost conversions.

  ALB draining helps for in-flight requests (60s drain).
  But it does NOT preserve the memory between old process and new process.
  The session data in RAM dies with the process.

WHAT THE TEAM DISCOVERS:
  "We can never do a rolling deploy without logging users out."
  "We need a maintenance window at 3AM."
  "Our deploy was just blocked because we can't log users out at 2PM."

  This is how stateful servers stop your team from deploying freely.
  Every deploy becomes a risk event. Deployment frequency drops.
  The business suffers.
```

---

### The Auto-Scaling Break

```
AUTO-SCALING WITH STATEFUL SERVERS:

  Traffic spike detected at 2PM. Auto-scaling adds Server 4 and Server 5.

  Server 1: 400 active sessions (from before the spike)
  Server 2: 350 active sessions
  Server 3: 380 active sessions
  Server 4: 0 sessions (NEW — just started)
  Server 5: 0 sessions (NEW — just started)

  ALB routes new requests to Server 4 and Server 5 (round robin).
  New users log in fine. Their sessions go to 4 and 5.

  4PM: Spike subsides. Auto-scaling scales IN.
  Auto-scaling chooses to terminate Server 4 (newest, least active).

  Server 4 had 120 sessions. All 120 users lose sessions. Logged out.

  This is the auto-scaling session loss problem.
  Systems solve it by:
  a) Sticky sessions (pins users to specific servers — prevents scale-in)
  b) Session drain timeout (give users 5 minutes to complete before termination)
  c) CORRECT FIX: stateless servers with external session store

  With external session store: Server 4 can be terminated anytime.
  Its users redirect to Server 1, 2, 3. Redis has their sessions. No logout.
```

---

## SECTION 7 — AWS & Cloud Mapping

### What Stateless Architecture Enables for Engineering Teams

```
WHAT STATELESS UNLOCKS FOR YOUR TEAM:

Feature 1: CONTINUOUS DEPLOYMENT
  Stateful: deploy → user disruption → need maintenance windows.
  Stateless: deploy any time. Rolling deploys. Zero user impact.

  "Move fast" is possible because you're not afraid of disruption.
  Teams at Netflix, Amazon deploy thousands of times per day.
  This is only possible with stateless services.

Feature 2: BLUE/GREEN DEPLOYMENTS
  Old version (Blue):  3 servers running v1.2.3
  New version (Green): 3 servers running v1.3.0

  ALB: shift 10% of traffic to Green.
  Monitor error rates and latency.
  Green looks good? Shift 100% of traffic.
  Instant rollback: shift traffic back to Blue (still running).

  Blue/Green requires stateless: users shift from Blue to Green without session loss.
  Their Redis sessions work on Green because Green reads the same Redis.

Feature 3: CANARY RELEASES
  Route 5% of traffic to new version. Monitor. Expand if healthy.
  Users on old version, users on new version — sometimes the SAME user
  hits different versions across multiple requests.

  This is safe ONLY if there's no server-side state that diverges between versions.

Feature 4: DISASTER RECOVERY
  Primary region fails. Traffic fails over to DR region.
  If sessions were in primary region's servers: all users logged out.
  If sessions are in Redis (replicated to DR region): seamless failover.
  Users don't know a regional failover happened.
```

---

## SECTION 8 — Interview Preparation

**Beginner:**

**Q: What does it mean for a server to be "stateless"?**
**A:** A stateless server doesn't remember anything between requests. Every request must carry all the information the server needs. Like a vending machine â€” it doesn't know who you are, it just responds to the button you press right now. This is the opposite of a cashier who remembers every customer.

**Q: If the server doesn't store anything, where does user data like login sessions go?**
**A:** In an external shared store that *every* server can access: a database (PostgreSQL), a cache (Redis), or inside the request itself as a JWT token. The server reads state when it needs it, processes the request, and optionally writes updated state back â€” but holds nothing in memory between requests.

**Q: Why is stateless design important for scaling?**
**A:** Because any server can handle any request. You can add 10 more servers and route traffic to any of them â€” they all behave identically because none of them store user-specific data. If one server crashes, users just get routed to another server with no data loss. This is impossible with stateful servers.

---

**Intermediate:**

**Q: What is a JWT and how does it enable stateless authentication?**
**A:** A JWT (JSON Web Token) encodes the user's identity, roles, and expiry time inside a cryptographically signed string. The server creates it on login, the client stores it, and sends it back on every request. The server verifies the signature (no DB lookup needed) and extracts the user info. Downside: JWTs can't be invalidated before expiry unless you maintain a blocklist â€” which re-introduces state. Use short-lived access tokens (15 min) + refresh tokens to mitigate.

**Q: What are the tradeoffs between storing more vs. less data in a JWT?**
**A:** Large JWT = all user data instantly available (no DB call) but adds 2-5KB to every HTTP request header, increases bandwidth usage, and exposes more user data if the token is intercepted. Small JWT (just user ID) = minimum exposure but requires a Redis/DB lookup on every request to fetch user roles/preferences. Best practice: store user ID + roles in JWT; load user preferences lazily on first request and cache.

**Q: How do you handle WebSocket connections in a stateless architecture?**
**A:** WebSockets are inherently stateful â€” a persistent TCP connection to one specific server. Strategies: (1) Use sticky sessions for WebSocket connections so the same user always routes to the same server. (2) Use a pub/sub layer (Redis pub/sub or AWS API Gateway WebSocket API) so messages can be published from any server and delivered over any connection. (3) Move real-time logic to a dedicated WebSocket service behind a separate ALB target group.

---

**Advanced (System Design):**

**Scenario 1:** Your app currently stores user sessions in Express express-session with in-memory storage. Users are reporting getting logged out randomly. You're about to add auto-scaling. How do you migrate to stateless sessions without downtime?

*Root cause:* In-memory sessions mean User A's session exists on Server 1. When routed to Server 2, session not found â†’ logged out.
*Migration plan (zero downtime):* (1) Provision Redis cluster (ElastiCache). (2) Switch express-session store to connect-redis â€” one config change, backward compatible. (3) Deploy with rolling update â€” new instances connect to Redis, old instances gradually retire. (4) Optionally migrate to JWTs in a second phase for fully stateless auth.

**Scenario 2:** Design an authentication service that handles 5 million daily active users, supports single sign-on (SSO) across 20 microservices, and allows immediate session revocation (for "log out all devices" feature).

*Architecture:* Short-lived JWTs (15-min expiry) issued by auth service. Refresh tokens stored in Redis with user ID â†’ token ID mapping. Each microservice verifies JWT signature locally (no auth service call on every request). On "log out all" â†’ delete all token IDs for that user in Redis. Refresh token rotation prevents reuse. OAuth 2.0 + OIDC for SSO. Rate limiting on login endpoint.

