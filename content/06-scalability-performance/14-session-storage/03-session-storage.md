# Session Storage — Part 3 of 3

### Topic: AWS Certification Focus, Comparison Tables, Quick Revision & Architect Exercise

**Series:** Scalability & Performance → Topic 14

---

## SECTION 9 — Certification Focus (AWS SAA)

### Calibrating Expiry to Application Type and Risk

```
THE RIGHT SESSION LIFETIME BALANCES:
  User experience (don't force re-login too often) vs. security (limit exposed window).

ABSOLUTE EXPIRY MATRIX:

  APPLICATION TYPE      ABSOLUTE TTL    SLIDING TTL    REASONING
  ─────────────────────────────────────────────────────────────────────────────────────────
  Banking / Finance     30 min          n/a            PCI-DSS / compliance. Even active users re-auth.
  Healthcare (PHI)      8h              30 min idle    HIPAA. Short idle. Absolute covers work shift.
  E-commerce            30 days         30 min idle    Remember-me common. Sliding = good UX.
  SaaS / Enterprise     8h              4h idle         Work-day model. Absolute = 1 work shift.
  Consumer social app   30 days         7 days idle    Users hate re-login. Long sessions = retention.
  Admin / internal      8h              1h idle         Stricter than user-facing. Admin = high risk.
  API (service account) 365 days        n/a            Machines authenticate programmatically.
  Payment checkout      30 min          n/a            Absolute only. Abandon = expire.
  Email verification    24h             n/a            One-time token. Short window. No renewal.

SLIDING TTL IMPLEMENTATION IN REDIS:

  Express + ioredis example:

  const SESSION_SLIDING_TTL = 7200;    // 2 hours inactivity
  const SESSION_ABSOLUTE_TTL = 86400;  // 24-hour hard cap

  app.use(async (req, res, next) => {
    const sid = req.cookies.sessionId;
    if (!sid) return next();

    const key = `sess:v1:${sid}`;

    // Single atomic operation: check existence + get fields + refresh TTL
    const [session, ttlRemaining] = await redis.pipeline()
      .hgetall(key)
      .ttl(key)
      .exec();

    const sessionData = session[1];
    const currentTtl = ttlRemaining[1];

    if (!sessionData?.userId) {
      res.clearCookie('sessionId');
      return next();  // unauthenticated
    }

    // Check absolute expiry
    const createdAt = parseInt(sessionData.createdAt);
    const absoluteAge = Math.floor(Date.now() / 1000) - createdAt;
    if (absoluteAge > SESSION_ABSOLUTE_TTL) {
      await redis.del(key);
      res.clearCookie('sessionId');
      return res.status(401).json({ error: 'Session expired. Please log in.' });
    }

    // Refresh sliding TTL on every request
    // Only refresh if current TTL is less than SLIDING_TTL to avoid redundant EXPIRE calls
    if (currentTtl < SESSION_SLIDING_TTL - 60) {
      await redis.expire(key, SESSION_SLIDING_TTL);
    }

    req.session = sessionData;
    req.userId = sessionData.userId;
    next();
  });

MEMORY MANAGEMENT WITH SESSION TTL:

  Without TTL: sessions accumulate indefinitely. Redis OOM.
  With TTL + sliding: active users keep sessions alive. Inactive: expire naturally.

  ESTIMATION:
  E-commerce app: 100K daily active users. Average session: 2h.
  Peak concurrent sessions: ~100K × (2h / 24h) = ~8,300 concurrent.
  Session size: ~1KB each.
  Redis memory: 8,300 × 1KB = 8.3MB. Trivial.

  Large consumer app: 10M DAU. Average session: 30 min.
  Concurrent sessions: ~10M × (0.5h / 24h) = ~208,000.
  Session size: 2KB.
  Redis memory: ~416MB. One ElastiCache cache.r7g.large handles this.

  "Remember me" sessions (30-day tokens): different scale.
  10M users with remember-me: 10M × 30 days = long-lived.
  If all logged in concurrently: 10M × 2KB = 20GB. Consider:
    1. Are remember-me tokens IN Redis? Or just in DB?
    2. Only ACTIVE sessions (opened in last 24h) need to be in Redis.
    3. Inactive sessions: can be stored in DB, lazily loaded back to Redis on use.
```

---

## SECTION 10 — Comparison Table

### ElastiCache for Session Storage on AWS

```
ELASTICACHE CONFIGURATION FOR SESSION STORAGE:

  EVICTION POLICY: volatile-lru (CRITICAL difference from pure cache)
    Sessions have TTLs → they're "volatile" (have EXPIRE set).
    On memory pressure: evict LRU sessions (ones not accessed recently).
    NEVER use allkeys-lru for sessions: could evict active user sessions.
    volatile-lru: protects keys without TTL (if any), evicts only TTL-bearing keys.

    Recommendation: sessions should ALL have TTL → volatile-lru = allkeys-lru in practice.
    But: if accidentally mixing session keys with permanent keys → volatile-lru is safer.

  PERSISTENCE:
    For sessions: AOF everysec recommended.
    Without persistence: Redis restart = all users logged out.
    In multi-AZ setup: backup restored from replica. OK for normal operations.
    But: standalone Redis + no AOF + node failure = complete logout of all users.

    AOF everysec: at most 1 second of sessions lost on crash. One second of logins to re-do.
    On ElastiCache: enable "Append Only File (AOF) backup".

  SEPARATE CLUSTER FROM APP CACHE:
    Session Redis: volatile-lru, AOF enabled, separate from pure cache cluster.
    Cache Redis: allkeys-lru, no persistence (pure cache, re-warmable from DB).
    Why separate:
      Different eviction policies (can't mix policies on one cluster).
      Different persistence requirements.
      Different scaling characteristics.
      Session store failure: logs everyone out (critical). Cache failure: higher DB load (recoverable).
      Isolate failure domains.

  ELASTICACHE PARAMETER GROUP FOR SESSIONS:
    maxmemory-policy: volatile-lru
    appendonly: yes
    appendfsync: everysec
    tcp-keepalive: 60
    lazyfree-lazy-eviction: yes  (async eviction — prevents latency spikes from eviction)

  NODE SIZING for sessions:
    Working set = CONCURRENT_SESSIONS × AVG_SESSION_SIZE × 1.3 (fragmentation buffer).
    For 100K concurrent sessions × 2KB = 200MB × 1.3 = 260MB.
    ElastiCache cache.t4g.medium: 3.09GB RAM → comfortable.
    Monitor FreeableMemory. Alert at < 30% free.

STICKY SESSIONS VS. ELASTICACHE (AWS APPLICATION LOAD BALANCER):

  ALB supports sticky sessions via a AWSALB cookie.
  ALB pins a user to the same backend target.

  WHEN TO USE ALB STICKY SESSIONS:
    Legacy app using local memory sessions. Can't refactor yet.
    Short-term migration path while adding Redis.

  PROBLEMS WITH ALB STICKY SESSIONS:
    Target (EC2 instance) health check failure: user loses session.
    ALB deregisters target: new target gets the request. No session.
    Auto-scaling: new target added, old sticky routes don't transfer.
    This is exactly the problem ElastiCache sessions solves.

  ALB STICKY SESSIONS: acceptable as a temporary measure.
  ElastiCache Redis sessions: the production target architecture.

MULTI-REGION SESSION STRATEGY:

  Challenge: user in US logs in. Session in us-east-1 Redis.
  User now makes request routed to eu-west-1 (Cloudflare routing, VPN, etc.).
  eu-west-1: no session. User appears logged out.

  SOLUTIONS:

  1. STICKY GEOGRAPHIC ROUTING (simple but limited):
     Route users to the same region consistently.
     Cloudflare: IP-based routing. User from NYC: always us-east-1.
     Problem: traveling users, VPN users, global clients.

  2. ELASTICACHE GLOBAL DATASTORE:
     Redis Global Datastore: replicates data across multiple regions.
     Active primary: one region. Passive replicas: other regions.
     Replication lag: typically < 1 second.
     Reads: from nearest region. Writes: to primary.

     Session writes (login): go to primary region. ~100ms extra latency.
     Session reads (every request): from nearest region. Fast.

     Session data: eventually consistent across regions. Acceptable for sessions.

  3. JWT + SESSION HYBRID (most common for multi-region):
     JWT for identity (stateless, valid in any region).
     Redis session only for mutable state (cart, wizard).

     For most requests: JWT verification (no I/O) + Redis session read if mutable state needed.
     JWT: available in any region without replication.
     Redis session: only called when mutable state is needed (not on every request).

     Mutable state reads: 80% of API calls are GETs that don't need mutable session data.
     Remaining 20%: cart/wizard interactions → tolerate the cross-region session read latency.
```

---

## SECTION 11 — Quick Revision

**Scenario:** You're designing authentication for a multi-device consumer app: web, iOS, Android. Requirements: (1) Users can be signed in on UNLIMITED devices simultaneously. (2) Users can view and individually terminate any session from a "My Devices" page. (3) Sessions expire after 90 days of inactivity or 365 days absolute. (4) Suspicious login detection: new login from a new device type + new geography within 1 hour of the previous login → flag it. Design the Redis data model.

---

**Answer:**

```
ENTITY 1: SESSION DATA
  Key: sess:v1:{sessionId}
  Type: HASH
  TTL: 7776000 seconds (90 days — sliding via EXPIRE on each request)

  Fields:
    userId             → "u123"
    deviceId           → "dev_chrome_abc"      (stable per device/browser)
    deviceType         → "web"                  (web/ios/android)
    deviceName         → "Chrome on Mac"        (user-facing label)
    ipAtLogin          → "1.2.3.4"
    countryAtLogin     → "US"                   (GeoIP lookup at login time)
    cityAtLogin        → "New York"
    createdAt          → "1720000000"            (absolute expiry calculation)
    lastSeenAt         → "1720086400"            (updated on each request)
    isFlagged          → "0"                    ("1" if suspicious activity detected)

  SLIDING TTL BEHAVIOR:
    On each authenticated request:
    HSET sess:v1:{sid} lastSeenAt {now}     (update lastSeen)
    EXPIRE sess:v1:{sid} 7776000            (reset 90-day inactivity timer)

    Check absolute expiry:
    if (now - parseInt(session.createdAt) > 365 * 86400) → expire session.

ENTITY 2: SESSION TRACKING PER USER
  Key: user:sessions:{userId}
  Type: SORTED SET
  Score: session createdAt timestamp
  Members: session IDs
  TTL: 365 days (set to user's longest possible session)

  Purpose: enumerate all sessions for "My Devices" page.

  On session create:
    ZADD user:sessions:{userId} {now} {sessionId}
    EXPIRE user:sessions:{userId} 31536000  (refresh: 1 year)

  On session expire/logout:
    ZREM user:sessions:{userId} {sessionId}

  CLEANUP: expired sessions remain in the set unless DEL'd explicitly.
  Use: scheduled job to ZRANGEBYSCORE user:sessions:{uid} 0 {90DaysAgo} → DEL expired.
  Or: on any request: ZRANGEBYSCORE to remove members pointing to expired keys.

ENTITY 3: "MY DEVICES" VIEW (reading)

  GET /api/sessions (authenticated):
    userId = req.userId;
    sessionIds = await redis.zrange(`user:sessions:${userId}`, 0, -1);

    // Pipeline: fetch all session hashes in one round-trip
    const pipeline = redis.pipeline();
    sessionIds.forEach(sid => pipeline.hgetall(`sess:v1:${sid}`));
    const results = await pipeline.exec();

    // Filter out expired sessions (key no longer exists)
    const activeSessions = results
      .map(([err, data]) => data)
      .filter(session => session !== null && session.userId === userId);

    return activeSessions.map(session => ({
      sessionId: session.sessionId,
      deviceName: session.deviceName,
      deviceType: session.deviceType,
      location: `${session.cityAtLogin}, ${session.countryAtLogin}`,
      loginTime: new Date(parseInt(session.createdAt) * 1000).toISOString(),
      lastSeen: new Date(parseInt(session.lastSeenAt) * 1000).toISOString(),
      isCurrent: session.sessionId === req.sessionId,
      isFlagged: session.isFlagged === '1'
    }));

  DELETE /api/sessions/{targetSessionId} (terminate a specific session):
    // Verify the session belongs to this user
    const targetSession = await redis.hgetall(`sess:v1:${targetSessionId}`);
    if (targetSession.userId !== req.userId) return 403;

    await redis.del(`sess:v1:${targetSessionId}`);
    await redis.zrem(`user:sessions:${req.userId}`, targetSessionId);
    return { message: 'Session terminated' };

ENTITY 4: SUSPICIOUS LOGIN DETECTION

  At login time: compare new session location + device against recent sessions.

  Key: user:recentLogins:{userId}
  Type: SORTED SET
  Score: login timestamp
  Members: JSON strings: {ip, country, city, deviceType}
  TTL: 3600 (1 hour — only check logins in the last 1 hour)

  On new login:
    const oneHourAgo = Date.now() / 1000 - 3600;
    const recentLogins = await redis
      .zrangebyscore(`user:recentLogins:${userId}`, oneHourAgo, '+inf')
      .then(items => items.map(JSON.parse));

    const isSuspicious = (newLogin, recentLogins) => {
      // Flag if: NEW country AND (different device type from recent logins)
      const knownCountries = new Set(recentLogins.map(l => l.country));
      const knownDeviceTypes = new Set(recentLogins.map(l => l.deviceType));

      const newCountry = !knownCountries.has(newLogin.country);
      const newDeviceType = !knownDeviceTypes.has(newLogin.deviceType);

      return newCountry && newDeviceType;  // both new = suspicious
    };

    if (recentLogins.length > 0 && isSuspicious({ country, deviceType }, recentLogins)) {
      // Flag the new session
      await redis.hset(`sess:v1:${sessionId}`, 'isFlagged', '1');

      // Notify user (email: "New sign-in from Paris on Android")
      await emailService.sendLoginAlert(userId, { city, country, deviceType });
    }

    // Add to recent logins
    await redis.zadd(`user:recentLogins:${userId}`, Date.now() / 1000,
      JSON.stringify({ ip, country, city, deviceType }));
    await redis.expire(`user:recentLogins:${userId}`, 3600);  // 1-hour window

COMPLETE KEY SPACE:
  sess:v1:{sessionId}              → HASH, 90-day sliding TTL
  user:sessions:{userId}           → SORTED SET, 365-day TTL
  user:recentLogins:{userId}       → SORTED SET, 1-hour TTL
```

---

## SECTION 12 — Architect Thinking Exercise

**Q: "Why use Redis for sessions instead of local server memory?"**

> "Local server memory breaks horizontal scaling. When you have one server, local sessions work fine. Add a second server and the load balancer routes the user's next request to server 2 — no session there, user appears logged out. Sticky sessions (pin a user to the same server) are a band-aid: the session dies when the server dies, and auto-scaling is complicated by routing constraints. Redis as an external session store makes sessions independent of individual servers. Any server reads the session from Redis — scale to 100 servers, sessions work identically. The session survives server failures. Combined with Redis's sub-millisecond read latency, there's no meaningful performance penalty versus local memory for session lookups."

---

**Q: "When would you use JWT for auth instead of server-side sessions?"**

> "It depends on whether you need stateless validation or mutable session state. JWT is ideal for microservices where multiple services need to validate identity without calling a central session store. Each service holds the public key, verifies the signature, and extracts claims — zero network I/O. It's also good for mobile/single-page apps where the token needs to be stored client-side and sent in API requests across domains.
>
> Server-side sessions are better when you need instant revocation, when sessions hold mutable state that changes frequently, or when you're operating a monolith where stateless validation offers no architectural benefit.
>
> In practice most production systems use both: short-lived JWT for stateless auth propagation across services, plus a Redis session for mutable user-specific state — cart, wizard progress, CSRF tokens. The JWT handles 'who are you', the session handles 'what are you doing'."

---

## === Architect's Mental Model ===

### 5 Decision Rules

**Rule 1: Session regeneration on login is mandatory — not optional hardening.**
Session fixation is a direct attack path from unauthenticated to authenticated without knowing credentials. The fix — generating a new session ID on successful authentication and deleting the old one — costs one extra Redis DEL and one SET. Not implementing it costs your users their accounts. Add session regeneration to your login code at the earliest stage of development and treat it as a blocking defect if ever found missing in code review.

**Rule 2: The eviction policy for your session store must be volatile-lru, not allkeys-lru.**
allkeys-lru on a session store: can evict ACTIVE sessions under memory pressure. User in the middle of checkout: their session disappears. They're suddenly logged out. Their cart is gone. This is a revenue and trust incident. volatile-lru: only evicts keys with TTL (sessions). Keys without TTL (if any permanent data is in the same cluster, which shouldn't happen but often does): protected. Better still: keep session store on a dedicated Redis instance, not a shared cluster.

**Rule 3: The "My Devices" feature requires the session tracking sorted set — it's not derivable without it.**
Without `user:sessions:{userId}` sorted set, you can't enumerate a user's active sessions without a full SCAN of all session keys (O(N) across the entire keyspace). The Sorted Set is the inverse index: given userId, find all sessionIds. Build this tracking set at login, maintain it through logout and expiry — it's the only efficient way to power session management features and the "log out all other sessions" security action.

**Rule 4: Absolute expiry enforcement must be in application code, not just TTL.**
Redis TTL handles the "no activity for N days" case perfectly. But Redis TTL can't distinguish "user has been continuously active for 400 days" (absolute expiry must fire) from "user is normally active" (TTL should keep refreshing). Absolute expiry requires storing `createdAt` in the session and checking it on every authenticated request. Many implementations set a long Redis TTL and assume users will eventually stop — resulting in "forever sessions" for highly active users, which is a security antipattern for any sensitive application.

**Rule 5: Session data should be the minimum necessary to serve requests — not a general-purpose user store.**
Teams add fields to the session because "it's convenient" — user preferences, feature flags, computed data. The session grows to 50KB. Now every request fetches and parses 50KB from Redis. At 100K requests/second: 5GB/s of Redis data transfer, excessive CPU for deserialization, and any session update requires writing the full payload. Sessions should contain only: userId, roles, CSRF token, wizard/cart state. Anything that rarely changes: in a separate per-user Redis Hash with its own TTL. Anything that's immutable: in the JWT. Session size budget: < 5KB.

---

### 3 Common Mistakes

**Mistake 1: Storing authentication state AND application state in the JWT, leading to stale permissions.**
Teams put userId, roles, AND subscription tier, AND feature flags in the JWT. JWT expiry: 24 hours. User is downgraded from "premium" to "free" at t=0. Their JWT still says "premium" until t+24h. They keep accessing premium features for 24 hours after downgrading. The fix: JWT should contain only stable identity claims (userId, email, organizationId). Dynamic state (roles, tier, feature access) that can change and must take effect quickly: Redis session or Redis per-user cache with short TTL. JWT covers "who are you." Dynamic state covers "what can you do right now."

**Mistake 2: Not invalidating session tracking sets when sessions expire naturally.**
Session TTL expires. Redis auto-DELetes `sess:v1:{sid}`. But: `user:sessions:{userId}` Sorted Set still contains that expired session ID. The "My Devices" page fetches the Sorted Set, pipelines HGETALL for all member IDs, and gets `null` for the expired ones. Code handles this fine — null sessions are filtered out. But over time: the Sorted Set accumulates thousands of dead session IDs. ZRANGE returns thousands of IDs, pipelining thousands of HGETALL calls, almost all null. Background cleanup: ZRANGEBYSCORE for members older than 90 days and remove them. Run this cleanup on login or on the "My Devices" page load.

**Mistake 3: Using HTTP cookies without Secure, HttpOnly, and SameSite.**
A session ID in a cookie is the most sensitive credential on your site — it represents logged-in access to the user's account. Without `HttpOnly`: JavaScript (including injected XSS scripts) can read `document.cookie` and exfiltrate the session ID. Without `Secure`: the session ID is transmitted in plaintext over HTTP connections (accidentally visited HTTP URL, mixed-content redirect). Without `SameSite`: CSRF attacks can submit forms with the user's session cookie. All three attributes are non-negotiable for session cookies in production. Add them as the absolute default in your session middleware and treat missing attributes as a security defect.

---

### 30-Second Interview Answer

> "Session storage in Redis solves the horizontal scaling problem of local-memory sessions. Every app server reads from the same Redis cluster, so any server can serve any user's session — no sticky sessions, no session loss on server failure. The data model is a Hash per session (for field-level updates without fetching the whole object) plus a Sorted Set per user tracking their session IDs (for the My Devices feature and force-logout-all-sessions). The TTL strategy combines sliding expiry for user experience (session alive while user is active) with absolute expiry for security (hard cutoff regardless of activity). On logout, DEL the session key instantly — unlike JWT which can't be revoked until expiry. The key configuration choices on ElastiCache: volatile-lru eviction policy (never evict active sessions), AOF persistence (prevent logout-all-users on node failure), and a dedicated cluster separate from the application cache."

---

_End of Topic 14 — Session Storage_
