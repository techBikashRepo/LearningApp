# Stateless Servers — Part 3 of 3

### Topic: AWS Certification Focus, Comparison Tables, Quick Revision & Architect Exercise

**Series:** Scalability & Performance → Topic 02

---

## SECTION 9 — Certification Focus (AWS SAA)

### AWS Architecture for Stateless Servers

```
ECS FARGATE (stateless app containers):
  Each task: reads from Redis on startup per request, writes back.
  Task definition:
    Environment variables: REDIS_URL = (from Secrets Manager)
    NO persistent volumes (no EFS mount for session data)
    ephemeralStorage: 20GB (temp only — not for session data)

  ECS Service:
    desiredCount: 4
    Auto-scaling: CPU > 70% OR ALB RequestCountPerTarget > 400/min
    deploymentConfiguration:
      maximumPercent: 200      # can run double instances during deploy
      minimumHealthyPercent: 50  # half the fleet always healthy

ELASTICACHE REDIS (external session store):

  Configuration for session storage:
    Engine: Redis 7.x
    Mode: Cluster Mode Disabled (simpler) or Cluster Mode Enabled (> 26GB)
    Multi-AZ: YES (required — Redis is a hard dependency)
    Automatic Failover: YES

    Node type:
      < 10,000 concurrent sessions at ~2KB each ≈ 20MB: cache.t4g.medium
      ~100,000 concurrent sessions at ~2KB each ≈ 200MB: cache.r7g.large

    Parameter group tuning:
      maxmemory-policy: allkeys-lru    (evict least recently used sessions first)
      timeout: 300                      (close idle client connections after 5min)
      tcp-keepalive: 60

    Session key TTL strategy:
      SETEX session:{id} 86400 {data}   # 24h TTL. Reset on activity.
      Background: if user inactive 24h → key expires → next request: re-login needed

    Monitoring (CloudWatch alarms):
      CacheMisses > 5% sustained: investigate session eviction
      DatabaseMemoryUsagePercentage > 80%: scale up Redis node
      CurrConnections spike: app reconnection storm (circuit breaker needed)

JWT STRATEGY ON AWS:
  Private key: AWS Secrets Manager or AWS KMS
  Public key: distributed to all services via environment variable or
              fetched from a JWKS endpoint (hosted by Auth Service)

  Lambda Authorizer caches JWT validation results:
    Cache key: token hash
    Cache TTL: 300s (don't re-validate same token every request)

  Rotation: RSA key pair rotation every 90 days
    Old key JWKs still served for 1 period (tokens issued just before rotation
    must still be valid during their TTL after rotation)
```

---

## SECTION 10 — Comparison Table

```
┌────────────────────────┬──────────────────────────────────────────────────┐
│ DIMENSION              │ STATELESS SERVERS                                │
├────────────────────────┼──────────────────────────────────────────────────┤
│ Horizontal scaling     │ ✅ Any server handles any request.               │
│                        │ Add N more servers → N× capacity instantly.      │
│                        │ No session pre-warming, no coordination.         │
├────────────────────────┼──────────────────────────────────────────────────┤
│ Deployments            │ ✅ Rolling deploys with zero session loss.        │
│                        │ Blue/green, canary — all work cleanly.           │
│                        │ Deploy any time, no maintenance windows.         │
├────────────────────────┼──────────────────────────────────────────────────┤
│ Failover               │ ✅ Instance failure: all users transparent       │
│                        │ redirect. No forced logouts.                     │
├────────────────────────┼──────────────────────────────────────────────────┤
│ New hard dependency    │ ❌ Redis becomes a critical dependency.          │
│                        │ Redis outage = all sessions fail.                │
│                        │ More infrastructure to monitor and operate.      │
├────────────────────────┼──────────────────────────────────────────────────┤
│ Per-request overhead   │ ❌ 0.3–1ms Redis latency per request.           │
│                        │ Acceptable for most apps. Visible at P99 < 5ms. │
├────────────────────────┼──────────────────────────────────────────────────┤
│ JWT revocation         │ ❌ JWTs can't be revoked until expiry.          │
│                        │ Mitigation: short TTL (15 min) + refresh tokens.│
│                        │ For instant revocation: Redis-backed token list. │
└────────────────────────┴──────────────────────────────────────────────────┘
```

---

## SECTION 11 — Quick Revision

**Q: "What does it mean for a server to be stateless, and why does it matter for scaling?"**

> "A stateless server holds no information about previous requests in its own memory. Every request arrives with all the context needed to process it — either in the request itself (JWT) or in a shared external store (Redis). The server processes the request and discards all request-specific state when done.
>
> It matters for scaling because: any instance can serve any request. You can add 10 more instances at peak and immediately route requests to them — they don't need to know anything about existing user sessions. You can terminate instances during a scale-in without users losing sessions. You can roll deploy at any time without maintenance windows. The stateless property is what makes horizontal auto-scaling actually work in practice."

---

**Q: "What are the tradeoffs between JWTs and server-side sessions?"**

> "JWTs are cryptographically self-contained — the server validates the signature locally, reads the claims, zero network calls. Fast, scales infinitely, no external dependency. The weakness: you can't revoke them until they expire. If a JWT has a 2-hour TTL and a user is compromised, that JWT is valid for up to 2 hours after detection.
>
> Server-side sessions in Redis: the session ID is opaque — the server looks up the session in Redis on every request. Revocation is instant (delete the Redis key). Mutable session data (shopping cart, wizard state) is natural here. The weakness: Redis is now a hard dependency with a latency cost per request. Redis failure mode = all users effectively logged out.
>
> I use JWTs for service-to-service auth (stateless, scales naturally, no shared store needed between services) and Redis sessions for user-facing apps that need instant revocation or mutable session state."

---

## SECTION 12 — Architect Thinking Exercise

**Scenario:** A multi-region SaaS analytics platform. The app currently stores sessions in-process. Expanding from 1 region (us-east-1) to 3 regions (us-east-1, eu-west-1, ap-southeast-1). Design the session management strategy.

**Consider:** A user in Singapore might hit ap-southeast-1. Then VPN routes shift and they hit us-east-1. Their session must still work.

---

**Answer:**

```
CROSS-REGION STATELESS STRATEGY:

CHOSEN APPROACH: JWT for authentication + Redis for mutable application state
Reasoning:
  - Pure JWT: can't invalidate on logout or compromise → not acceptable for SaaS
  - Single global Redis: cross-region latency (Singapore → us-east-1: 180ms) → too slow
  - Per-region Redis with sync: replication lag → stale session data risk

CORRECT DESIGN:

1. AUTHENTICATION: Short-lived JWT (15 min) issued by Auth Service
   - JWT claims: { userId, tenantId, roles, region-hint }
   - Any region validates JWT locally — zero cross-region calls for auth
   - Refresh token stored in global Redis (us-east-1, primary)
   - Refresh happens every 15 min (background, client-transparent)

2. APPLICATION SESSION STATE: Per-region Redis + write-through
   - Each region has its own ElastiCache cluster
   - Read session from local region Redis (< 1ms)
   - Write session: write to local Redis + publish change event to SNS/SQS
   - Other regions subscribe: update their local Redis cache
   - Replication lag: 100–500ms (acceptable for non-critical mutable state)

3. TENANCY: Tenant data isolated by tenantId in JWT claims
   - Multi-tenant SaaS: session keys prefixed: session:{tenantId}:{sessionId}
   - Prevents cross-tenant session collisions

4. FAILOVER:
   - If ap-southeast-1 Redis fails: fall back to session-less JWT-only mode
     (degraded: no mutable app state, but authentication still works)
   - Alert and restore; state reconstructed from DB on recovery

RESULT:
  - User in Singapore hits ap-southeast-1: 0.5ms Redis read, 180ms JWT validation skipped
  - VPN shifts user to us-east-1: JWT still valid, us-east-1 Redis has replicated session
  - Cross-region failover: seamless authentication, brief state degradation acceptable
```

---

## === Architect's Mental Model ===

### 5 Decision Rules

**Rule 1: State belongs in Redis or a database — never in the app server's process memory.**
If state lives in the server's RAM between requests, the server is stateful. Stateful servers can't be auto-scaled, can't be deployed without maintenance windows, and create single points of failure. The standard: server RAM holds state only for the duration of processing one request, then is discarded. Persistent state: external store.

**Rule 2: JWT for auth identity; Redis for mutable application state.**
These solve different problems. JWT is perfect for carrying immutable signed claims (who you are, your role, your tier). Redis is perfect for mutable state that changes during a session (cart, wizard progress, notification preferences). Don't put a shopping cart in a JWT — the cart changes constantly and the JWT would need to be reissued on every add-to-cart action.

**Rule 3: Redis HA is not optional when it holds sessions.**
Redis is a critical dependency the moment it holds sessions. A single Redis node going down logs out every active user simultaneously. Worse than one app server failing. Minimum: Multi-AZ ElastiCache with automatic failover. At scale: Redis Cluster mode. Budget for this upfront.

**Rule 4: At migration time, externalizing sessions cannot be done per-feature.**
"We'll just externalize the shopping cart session — keep auth session local for now." This doesn't work. The auth session state is also local, so you still can't roll deploy. The migration must be total: ALL session state moved to external store before the system behaves correctly as stateless. Do it in one focused sprint, not incrementally feature by feature.

**Rule 5: Detect hidden statefulness before it reaches production.**
In-process Maps (product caches, rate limit counters), local file writes, WebSocket state, JVM singleton state — all make your "stateless" service stateful. Add a "statelessness audit" to code review: "Does this PR introduce ANY state that lives between requests?" Run two instances locally pointing at the same Redis and test every feature: any failures are state bugs.

---

### 3 Common Mistakes

**Mistake 1: Externalizing session data but keeping an in-process cache for "performance."**
"We moved sessions to Redis, but the product catalog is in a local Map for speed." Now 10 app servers have 10 different product catalog states. One instance gets updated catalog. Others still serve stale data. The "cache" provides inconsistency, not just performance. Move the cache to Redis; accept the 0.5ms network hit; gain consistency.

**Mistake 2: Long-lived JWTs without a revocation mechanism.**
"JWTs are stateless — that's the whole point, no revocation needed." Customer reports their account was compromised. You want to revoke the token. Token has 12-hour TTL. You can't. For 12 hours that attacker has a valid session. Short JWTs (15 min) with refresh token rotation is the production answer. The refresh token in Redis IS the revocation handle.

**Mistake 3: Not testing failover of the session store.**
"Redis is fine, it's never gone down." Until it does, at peak traffic, during a sale event. The first time your team discovers what happens when Redis goes down should be a planned chaos engineering exercise — not a prod incident at midnight. Run the drill: kill the Redis primary, watch the automatic failover, measure the 10 seconds of elevated errors, ensure the fallback behavior is acceptable.

---

### 30-Second Interview Answer

> "A stateless server processes each request entirely from information in the request itself or from a shared external store — it holds nothing in local memory between requests. This is the prerequisite for reliable horizontal scaling: any server can handle any request, you can add or remove instances with no user disruption, and rolling deploys work without maintenance windows. In practice: authentication via JWTs (self-contained claims, validated locally) or session IDs pointing to a Redis store (shared across all instances). The critical tradeoff: Redis becomes a hard dependency — it must be HA. A Redis failure is worse than an app server failure because it affects every active user simultaneously."

---

_End of Topic 02 — Stateless Servers_
