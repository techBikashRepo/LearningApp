# Session Storage — Part 2 of 3

### Topic: Real World Examples, System Design Importance, AWS Mapping & Interview Prep

**Series:** Scalability & Performance → Topic 14

---

## SECTION 5 — Real World Example

### Absolute vs Sliding Expiry

```
TWO TYPES OF SESSION EXPIRY:

  ABSOLUTE EXPIRY:
    Session expires exactly N hours after CREATION, regardless of activity.

    Redis: SETEX key N value (N set at creation time, never extended).

    Use for: payment flows, checkout sessions, high-security operations.
    Rationale: user abandons session mid-checkout, comes back hours later.
    You want the session (with cart + payment info) to expire regardless.

    Banking: absolute 30-minute session. Even if user is typing, session expires.
    Forces re-authentication after 30 minutes from login.

  SLIDING EXPIRY:
    Session expires N minutes after LAST ACTIVITY.
    Each request: refreshes the TTL. Session stays alive while user is active.

    Redis: EXPIRE session:{sid} N on every request (or HSET resets the TTL via EXPIRE call).

    Use for: long-lived user sessions where active users should stay logged in.
    E-commerce: user doing research, switching between pages for 2 hours.
    Absolute expiry: force re-login after 1 hour even while browsing.
    Sliding expiry: session alive as long as user is active. Expires after N mins of inactivity.

  IMPLEMENTATION (sliding TTL middleware):

  const SLIDING_TTL_SECONDS = 7200;  // 2 hours of inactivity = expired

  app.use(async (req, res, next) => {
    const sessionId = req.cookies.sessionId;
    if (!sessionId) return next();

    const sessionKey = `sess:v1:${sessionId}`;
    const session = await redis.hgetall(sessionKey);

    if (!session || !session.userId) {
      res.clearCookie('sessionId');
      return res.status(401).json({ error: 'Session expired' });
    }

    // Refresh TTL on every request (sliding window)
    await redis.expire(sessionKey, SLIDING_TTL_SECONDS);

    req.session = session;
    req.userId = session.userId;
    next();
  });

  COMBINING BOTH (real-world pattern):

  const ABSOLUTE_EXPIRY = 8 * 3600;   // 8 hours from login
  const SLIDING_EXPIRY  = 2 * 3600;   // 2 hours of inactivity

  On login:
    session.createdAt = Math.floor(Date.now() / 1000);
    session.absoluteExpiresAt = session.createdAt + ABSOLUTE_EXPIRY;
    redis.hset(sessionKey, {...session});
    redis.expire(sessionKey, SLIDING_EXPIRY);  // initial: 2h from now

  On each request (middleware):
    const session = redis.hgetall(sessionKey);
    if (Date.now() / 1000 > session.absoluteExpiresAt) {
      // Absolute expiry reached: kill session regardless of activity
      redis.del(sessionKey);
      return res.status(401).json({ error: 'Session expired. Please log in again.' });
    }
    // Still within absolute window: refresh sliding TTL
    redis.expire(sessionKey, SLIDING_EXPIRY);

  This pattern: supports 8h hard limit + 2h idle timeout.
  User idle for 2h: session expires (sliding).
  User active all day (> 8h): session expires (absolute).

REMEMBER-ME TOKENS:

  Standard session: expires after idle (closed browser = session cookie gone).
  Remember me: persistent token placed in long-lived cookie (30 days).

  Remember-me token: different from session.
    Not a session — contains no mutable state.
    Contains: userId + familyToken (rotation identifier).
    Stored in DB: remember_me_tokens table.
    Not in Redis (needs durability — must survive Redis restart).

  Flow:
    User logs in with "remember me" checked.
    Server: creates reminder token, stores in DB, sets 30-day HttpOnly cookie.
    User returns after browser close (session cookie gone).
    Server sees no session cookie BUT sees remember-me cookie.
    Server validates remember-me token from DB.
    Server creates NEW session in Redis, issues new session cookie.

  Token rotation: after each use, invalidate old token and issue new one.
  Authentication token theft: detected (attacker uses token → server sees old token being reused → all sessions for user revoked).
```

---

## SECTION 6 — System Design Importance

### Limiting the Number of Active Sessions Per User

```
BUSINESS REQUIREMENT: "Each user can be logged in on at most 3 devices simultaneously."

  WHY THIS EXISTS:
  Account sharing prevention (Netflix model): no more than N concurrent viewers.
  Security policy: admin accounts limited to 1 active session.
  Compliance: PCI-DSS for payment systems may require limiting concurrent sessions.

IMPLEMENTATION WITH SORTED SET:

  SORTED SET per user tracking active sessions:
  Key: user:sessions:{userId}
  Members: session IDs.
  Score: session creation timestamp (for ordering by age).

  On Login (create session):

  const sessionId = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  const MAX_SESSIONS = 3;

  // Add new session to user's session set
  await redis.zadd(`user:sessions:${userId}`, now, sessionId);

  // Count sessions. If over limit: remove oldest.
  const sessionCount = await redis.zcard(`user:sessions:${userId}`);
  if (sessionCount > MAX_SESSIONS) {
    // Remove the MAX_SESSIONS+1 oldest (sessions that exceed limit)
    const excessCount = sessionCount - MAX_SESSIONS;
    const oldestSessions = await redis.zrange(`user:sessions:${userId}`, 0, excessCount - 1);

    // Delete the old session data
    for (const oldSessionId of oldestSessions) {
      await redis.del(`sess:v1:${oldSessionId}`);
    }
    // Remove from tracking set
    await redis.zremrangebyrank(`user:sessions:${userId}`, 0, excessCount - 1);
  }

  // Create the actual session data
  await redis.hset(`sess:v1:${sessionId}`, {
    userId: userId,
    createdAt: now,
    deviceType: req.headers['user-agent'] || 'unknown',
    ip: req.ip
  });
  await redis.expire(`sess:v1:${sessionId}`, SESSION_TTL);

  On Logout (destroy session):

  await redis.del(`sess:v1:${sessionId}`);
  await redis.zrem(`user:sessions:${userId}`, sessionId);

  SHOW ALL ACTIVE SESSIONS TO USER:

  const sessionIds = await redis.zrange(`user:sessions:${userId}`, 0, -1);
  const sessions = await Promise.all(
    sessionIds.map(id => redis.hgetall(`sess:v1:${id}`))
  );
  return sessions.filter(s => s !== null);  // filter out expired sessions

  FORCE LOGOUT ALL OTHER SESSIONS:
  (Used in "secure account" flows after password change)

  const allSessions = await redis.zrange(`user:sessions:${userId}`, 0, -1);
  const otherSessions = allSessions.filter(id => id !== currentSessionId);
  for (const id of otherSessions) {
    await redis.del(`sess:v1:${id}`);
  }
  await redis.zrem(`user:sessions:${userId}`, ...otherSessions);

  // Re-expire the tracking set (aligned with user's last session)
  await redis.expire(`user:sessions:${userId}`, SESSION_TTL);

DEVICE TRACKING IN SESSION:

  Session Hash: Include device fingerprint.
    HSET sess:v1:{sid} userId 123 device "Chrome/Mac" ip "1.2.3.4" createdAt 1720000000

  Show user active sessions:
    Session 1: Chrome on Mac, logged in 2 hours ago, from New York (GeoIP lookup).
    Session 2: Safari on iPhone, logged in 5 days ago, from Paris.
    Session 3: Android app, logged in 1 day ago, from London.
    [Terminate all other sessions] button → deactivates sessions 2 and 3 via Redis DEL.

  SECURITY ALERT: New session from unusual location.
    On session creation: compare IP geolocation to recent sessions.
    New session from different country → send email alert. "New sign-in from Paris."
    Store IP and timestamp in session Hash for this reason.
```

---

## SECTION 7 — AWS & Cloud Mapping

### Security Vulnerabilities in Session Management

```
SESSION FIXATION ATTACK:

  ATTACK FLOW:
    Step 1: Attacker visits your site. Receives session ID: sid_attacker123.
    Step 2: Attacker tricks victim into using the same session ID.
            (Trick: "click this link: yoursite.com?sessionId=sid_attacker123")
            Pre-authentication: many apps accept any session ID parameter.
    Step 3: Victim logs in. App authenticates session sid_attacker123.
            Session is now authenticated as victim.
    Step 4: Attacker uses their copy of sid_attacker123.
            Attacker is now authenticated as victim.

  THE PROBLEM: Same session ID used for both unauthenticated and authenticated state.

  THE FIX: SESSION REGENERATION ON LOGIN.

  BEFORE LOGIN: session might hold pre-auth data (CSRF token, cart from anonymous browsing).
  ON SUCCESSFUL LOGIN: generate NEW session ID. Migrate data from old to new. Delete old.

  const oldSessionId = req.cookies.sessionId;
  const newSessionId = crypto.randomBytes(32).toString('hex');

  // Migrate pre-auth session data (cart, csrf token, etc.)
  const oldSession = await redis.hgetall(`sess:v1:${oldSessionId}`);

  // Create new session with proper auth data
  await redis.hset(`sess:v1:${newSessionId}`, {
    ...oldSession,
    userId: authenticatedUser.id,
    authenticatedAt: Date.now(),
    regeneratedAt: Date.now()
  });
  await redis.expire(`sess:v1:${newSessionId}`, SESSION_TTL);

  // Remove old unauthenticated session
  await redis.del(`sess:v1:${oldSessionId}`);
  if (oldSessionId) await redis.zrem(`user:sessions:${userId}`, oldSessionId);

  // Issue new session cookie
  res.cookie('sessionId', newSessionId, {
    httpOnly: true, secure: true, sameSite: 'Lax', maxAge: SESSION_TTL * 1000
  });

  After regeneration: attacker's copy of sid_attacker123 is DELETED.
  Even if attacker has the old session ID: it no longer exists in Redis. Useless.

CSRF PROTECTION WITH SESSIONS:

  CSRF: Cross-Site Request Forgery.
  Attacker's site: contains a form that submits to yoursite.com.
  Victim (logged into yoursite.com) visits attacker's site.
  Browser: automatically includes yoursite.com cookies on the cross-site request.
  Your app: sees valid session cookie → thinks authenticated request → processes it.

  FIX: CSRF tokens.
    On page load: generate cryptographically random CSRF token.
    Store in session: HSET sess:v1:{sid} csrfToken {randomToken}.
    Embed in form: <input type="hidden" name="_csrf" value="{csrfToken}">

    On POST: compare form csrfToken with session csrfToken.
    If mismatch: reject request.

    Attacker's cross-site form: doesn't have the CSRF token (can't read your cross-origin cookies).
    Even though browser sends session cookie: CSRF token missing → request rejected.

  SameSite=Strict on session cookie: provides CSRF protection at browser level.
  Use SameSite=Lax or Strict + application CSRF tokens for defense in depth.
  Never rely on only one mechanism.

SESSION INVALIDATION ON SECURITY EVENTS:

  Force invalidate ALL sessions:
  - Password change.
  - Email change.
  - Account compromise detected.
  - Admin-triggered lockout.

  Pattern: User version counter.
    HSET user:{userId}:meta sessionVersion 1
    Each session: stores the sessionVersion at creation time.

    On security event:
    INCR user:{userId}:meta sessionVersion

    On each request: compare session's stored version with current version.
    If mismatched: session invalidated. Force re-login.

    Advantage: no need to enumerate and DEL all sessions.
    Single INCR invalidates all existing sessions globally.
    Sessions: continue to exist in Redis but are rejected on next use.
    (They expire naturally via TTL. No need for explicit DEL.)
```

---

## SECTION 8 — Interview Preparation

**Beginner:**

**Q: What is session storage and why do we need it?**
**A:** HTTP is stateless â€” every request is independent with no memory of previous requests. Session storage gives users an identity that persists across multiple requests. When you log in, the server creates a "session" (a small file/record of who you are), gives you a session ID, and stores that ID in your browser cookie. On every subsequent request, you send the session ID and the server knows who you are. Without sessions, you'd have to log in on every single page.

**Q: What is the difference between storing sessions in memory vs. in a database vs. in Redis?**
**A:** *In-memory (server RAM):* Fastest but sessions die when the server restarts. Only works with one server â€” load balancing breaks it. *In a database (PostgreSQL table):* Persistent and works across servers, but adds a DB query to every request. Becomes a bottleneck as user count grows. *In Redis:* Fast (in-memory), persistent (with AOF), and shared across all servers. Best of both worlds. Redis is the standard production session store.

**Q: What is the difference between a session and a JWT?**
**A:** *Session:* server stores the user data; client just holds an ID (cookie). To check who you are, server looks up the ID. Can be invalidated instantly (delete from Redis). *JWT:* all user data is in the token on the client; server doesn't store anything. Server only verifies the cryptographic signature. Can't be invalidated before expiry â€” once issued, valid until expired. Use sessions when you need instant revocation (admin-forced logout). Use JWTs for stateless APIs, microservices, or mobile apps.

---

**Intermediate:**

**Q: What are the security requirements for production session storage?**
**A:** (1) *Session IDs must be cryptographically random* â€” at least 128 bits of entropy. Predictable IDs allow session hijacking. (2) *HTTPS only* â€” set cookie: {secure: true} so session cookie is never sent over HTTP. (3) *HttpOnly flag* â€” httpOnly: true prevents JavaScript from reading the cookie (blocks XSS session theft). (4) *SameSite flag* â€” sameSite: 'strict' or 'lax' prevents CSRF attacks. (5) *Session rotation* â€” generate a new session ID on login to prevent session fixation attacks. (6) *Reasonable expiry* â€” expire inactive sessions after 30 minutes for sensitive apps (banking: 15 min).

**Q: How do you implement Redis-backed sessions in a Node.js Express app with proper configuration?**
**A:** Use express-session with connect-redis store. Critical config: esave: false (don't re-save session if unmodified â€” prevents race conditions), saveUninitialized: false (don't create session until something is stored â€” reduces Redis writes), olling: true (extend TTL on every request â€” sliding TTL for "keep me logged in"), cookie.maxAge set to session expiry in milliseconds, store.ttl matching cookie maxAge. In Redis: ensure session keys have proper TTL so abandoned sessions are auto-cleaned.

**Q: What is session data that should NOT be stored in a session?**
**A:** (1) Passwords (ever). (2) Full credit card numbers. (3) Large blobs of data (images, documents) â€” bloats Redis and increases cookie/header size. (4) Data that changes frequently (shopping cart quantity in high-traffic scenarios â€” use dedicated cart service). Store in sessions: user ID, role/permissions, display name, preferred language, CSRF token, and other small identity/preference values. Large objects belong in the database, retrieved on demand.

---

**Advanced (System Design):**

**Scenario 1:** Design the session management system for a banking application with these requirements: (1) Sessions expire after 15 minutes of inactivity, (2) Users can be logged out instantly by admin, (3) Concurrent logins from two different devices allowed, (4) Login must survive a Redis failover without users being logged out.

*Redis with replication and AOF persistence:* sessions survive Redis failover (replica promotes, AOF ensures durability). Redis Sentinel or ElastiCache with Multi-AZ for automatic failover.
*15-min inactivity:* Each request extends TTL (EXPIRE session:{id} 900). No request for 15 min â†’ TTL expires â†’ session gone.
*Admin forced logout:* Store all active session IDs per user: user:sessions:{userId} â†’ set of session IDs. On admin logout: fetch all session IDs â†’ delete all session keys from Redis â†’ user's next request finds no session â†’ forced to re-authenticate.
*Multi-device:* Each device gets its own session ID (stored in the user:sessions:{userId} set). Max active sessions: 5 (oldest session evicted on login if exceeded).

**Scenario 2:** Your app currently stores 500GB of session data in Redis. Average session size is 50KB. You realize most of this is cached user profile data attached to sessions. How do you reduce Redis memory usage by 80% while maintaining the same user experience?

*Problem:* 50KB sessions = bloated. Most data is recomputable from DB.
*Solution:* Store only the minimum session identifier (user ID, role, CSRF token): ~200 bytes per session. Load user profile lazily from DB or a separate shorter TTL cache on first request. Total: 500GB Ã— (200 bytes / 50KB) = 500GB Ã— 0.004 = **2GB** (99.6% reduction). User experience: first request after cold cache adds 20ms. Subsequent requests: profile served from the profile-specific Redis cache (separate key space, shorter TTL).

