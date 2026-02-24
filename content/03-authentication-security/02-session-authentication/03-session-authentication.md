# Session Authentication — Part 3 of 3

### Sections: 9 (Interview Prep), 10 (Common Developer Mistakes), 11 (Quick Revision), 12 (Security Thinking Exercise)

**Series:** Authentication & Security → Topic 02

---

## SECTION 9 — Interview Preparation

### Beginner Questions

**Q1: What is a session and how does session-based authentication work?**

```
A session is a server-side record that maps a random token (session ID)
to a specific authenticated user's context.

Flow:
  1. User submits credentials → server verifies → creates session record
  2. Server sends session ID to browser as a cookie
  3. Browser automatically attaches cookie to every subsequent request
  4. Server looks up the session ID → identifies the user → processes request
  5. On logout: server deletes session record → cookie becomes useless

Key insight: The trust lives on the SERVER.
  The client only carries a pointer (session ID) not the actual identity data.
  This means: server can invalidate the session at any time, from any cause.

Compare to JWT: JWT trust is DISTRIBUTED — the token carries the data.
  No server lookup needed, but also no revocation without extra infrastructure.
```

**Q2: What cookies attributes are required for secure session cookies?**

```
Minimum required:
  HttpOnly  → JavaScript cannot read it → XSS-resistant
  Secure    → HTTPS transmission only → MITM-resistant
  SameSite=Lax → Cross-site POST not sent → CSRF-resistant

Recommended additions:
  Path=/               → cookie scoped to all paths
  Max-Age=86400        → explicit 24h expiry (not Expires= which uses absolute time)
  __Host- prefix       → cookie cannot be overwritten by subdomains

Full example:
  Set-Cookie: __Host-sid=<random>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=86400
```

**Q3: What is the difference between session expiry and session deletion on logout?**

```
SESSION EXPIRY:
  Passive: session record has an expires_at timestamp.
  After that time, validation check fails → treated as not logged in.
  Record may still exist in database until a cleanup job removes it.

SESSION DELETION ON LOGOUT:
  Active: server immediately removes the session record from the store.
  On next request with that cookie: lookup fails → 401 immediately.

  Why both are needed:
  If only expiry: attacker with stolen 30-day cookie has 30 days of access
  even after the real user "logs out". Logout only clears the browser cookie.
  The server-side record still exists and is still valid.

  Correct logout: DELETE session FROM store + clear browser cookie.

  Real-world failure: GitHub's session persistence bug (2012) —
  logout cleared client cookie but left server-side session alive.
```

---

### Intermediate Questions

**Q1: A user logs in from a new device. How do you handle session management securely?**

```
New login scenario — decisions to make:

1. Notify via email: "New sign-in from Chrome on Windows, San Francisco"
   User can review devices and revoke sessions they don't recognize.

2. New session ID generated (always): crypto.randomBytes(32) per device/login.
   Sessions are NOT shared between devices or logins.

3. Session inventory per user:
   Allow users to view all active sessions:
   - Browser type
   - Rough IP geolocation
   - Last active time
   - "Sign out this session" button per session

   Implementation:
   Redis SET key: user_sessions:{userId} → SADD with new session ID
   User session list: SMEMBERS → return metadata for each session

4. Concurrent session policy (depends on product):
   Banking: one active session (new login = previous session invalidated)
   Consumer app: unlimited concurrent sessions (view all, revoke per session)

5. Device trust / step-up auth:
   Known device (cookie matches stored fingerprint): direct login
   New device: email verification required before session fully authenticated
   (partial session: state "PENDING_DEVICE_VERIFY" until user clicks email link)
```

**Q2: How do you scale session authentication across multiple servers?**

```
PROBLEM:
  Server A creates session "sess_abc" → stored in Server A's memory.
  Next request routes to Server B → Server B has no record of "sess_abc" → 401.

SOLUTION 1 — Sticky sessions (not recommended):
  Load balancer routes all requests from same IP to same server.
  Breaks: server failure loses all sessions. Uneven load distribution.

SOLUTION 2 — Centralized Redis session store (recommended):
  All servers share one Redis cluster.
  Session created on Server A: stored in Redis.
  Next request to Server B: looks up Redis → found → authenticated.

SOLUTION 3 — Database-backed sessions:
  Same principle as Redis but using PostgreSQL.
  Slower (disk I/O on every request) but full audit history.
  Hybrid: Redis for active sessions, Postgres for audit log.

SOLUTION 4 — Cookie-based encrypted sessions:
  No server-side store at all.
  Session data encrypted (AES-GCM) and stored IN the cookie.
  Server decrypts, verifies HMAC, reads data.
  Limitation: cannot revoke individual sessions (short expiry is only mitigation).

INTERVIEW ANSWER:
  "For production at scale: Redis cluster (AWS ElastiCache).
   It provides sub-millisecond lookup, automatic TTL for expiry,
   and enables instant revocation. All application servers share the store
   so there's no affinity requirement on the load balancer."
```

---

### Advanced Questions

**Q1: Design a session management system for a banking application with regulatory compliance.**

```
REQUIREMENTS (banking-specific):
  - Absolute session timeout: 8 hours (regulatory)
  - Idle timeout: 10 minutes (common regulatory requirement)
  - Full audit trail: who, when, from where (SOX, PCI-DSS)
  - Concurrent session limit: 1 per user (fraud prevention)
  - Re-authentication for sensitive operations (transactions > $1000)

DESIGN:

Session record:
{
  id: "sess_<32 bytes hex>",
  userId: "usr_...",
  createdAt: timestamp,        // Absolute expiry: createdAt + 8h
  lastSeenAt: timestamp,       // Idle expiry: lastSeenAt + 10min
  ipAddress: "...",
  userAgent: "...",
  mfaVerifiedAt: timestamp,    // When MFA was last completed
  stepupRequired: boolean,     // High-value transaction needs re-auth
  deviceFingerprint: "...",
}

Concurrent session enforcement:
  On new login:
    1. Check user_sessions:{userId} in Redis → if any exist → revoke all
    2. Create new session
    3. Add to user_sessions:{userId} SET
    4. Send notification: "New sign-in detected. Previous session terminated."

Step-up authentication for transactions > $1000:
  Check: session.mfaVerifiedAt is within last 5 minutes
  If not: return 403 STEP_UP_REQUIRED
  Client: prompt for TOTP/biometric
  POST /auth/step-up with TOTP code → verifies → updates mfaVerifiedAt
  Original transaction: retry → now allowed

Audit log (immutable, write-only):
  Stored in PostgreSQL append-only table:
  INSERT INTO session_audit (session_id, user_id, event, ip, user_agent, timestamp)
  Events: SESSION_CREATED, SESSION_ACCESSED, SESSION_EXPIRED, SESSION_REVOKED,
          STEP_UP_INITIATED, STEP_UP_COMPLETED, STEP_UP_FAILED

  CloudTrail: all API calls for regulatory evidence.
  Log retention: 7 years (PCI-DSS requirement).
```

---

## SECTION 10 — Common Developer Mistakes

```
MISTAKE 1: Using express-session default MemoryStore in production
───────────────────────────────────────────────────────────────────
What happens: Default store is in-memory on one server.
              Multiple servers = sessions only valid on the server that created them.
              Server restart = all sessions lost. All users logged out.
Problem in production: "Users keep getting randomly logged out" complaints.
              Often first discovered post-deployment under load.
Fix: Configure a real session store: connect-redis, connect-pg-simple, etc.

MISTAKE 2: Not regenerating session ID after login (session fixation)
──────────────────────────────────────────────────────────────────────
What happens: Unauthenticated session ID from before login is elevated.
              Attacker can pre-plant a session ID and wait for victim to log in.
Fix: Call req.session.regenerate() (express-session) after verifying credentials.

MISTAKE 3: Logout only clears browser cookie but not server session
────────────────────────────────────────────────────────────────────
What happens: res.clearCookie('sessionId') removes cookie from browser.
              But server-side session record still exists and still valid.
              Stolen cookie (obtained before logout) still works.
Fix: DELETE session from store FIRST, then clear cookie.

MISTAKE 4: Sessions not invalidated on password change
─────────────────────────────────────────────────────
What happens: User changes password (because account was compromised).
              Old sessions (attacker's stolen session) remain active indefinitely.
              Password change provides false sense of security.
Fix: On password change: revoke all OTHER sessions. Keep only current session.

MISTAKE 5: Long session TTL on sensitive applications
──────────────────────────────────────────────────────
What happens: 30-day or 1-year "remember me" sessions for banking, health, financial apps.
              Stolen session = 30 days of access.
              User may not notice the compromise for weeks.
Fix: Separate session from "remember me" token.
     Session: short (1-4 hours).
     Remember me: long-lived opaque token stored separately → issues new session on use.

MISTAKE 6: No idle timeout for sensitive applications
──────────────────────────────────────────────────────
What happens: User leaves computer unlocked. Session never times out.
              Any person at the computer can access the account indefinitely.
Fix: Track last_seen_at. If now() - last_seen_at > 30 minutes → revoke session.

MISTAKE 7: Session secret hardcoded or weak
────────────────────────────────────────────
What happens: SESSION_SECRET = 'mysecret123'
              Session secret is used to sign/verify the session ID cookie.
              Weak or leaked secret = attacker can forge cookies.
Fix: 64+ chars random string. Store in AWS Secrets Manager, not in code or .env in repo.

MISTAKE 8: No concurrent session detection for high-security apps
─────────────────────────────────────────────────────────────────
What happens: User session stolen. Both user and attacker use the session simultaneously.
              No detection. No alert. Attacker has indefinite access.
Fix: Track IP + user-agent per session. Alert on significant geolocation changes.
     For banking: allow only one concurrent session.

MISTAKE 9: Session cookies accessible from subdomains
──────────────────────────────────────────────────────
What happens: Cookie set with Domain=.example.com → accessible from sub.example.com.
              If sub.example.com is compromised (or user-controlled content there):
              cookie can be read or overwritten by that subdomain.
Fix: Use __Host- prefix → cookie locked to exact host, non-transferable to subdomains.
     Remove Domain= attribute → cookie only sent to exact host.

MISTAKE 10: Redis session store without TLS
─────────────────────────────────────────────
What happens: Application connects to Redis over plaintext TCP.
              All session data (including user IDs, roles) transmitted unencrypted.
              Network-level attacker in the same VPC can read all sessions.
Fix: Enable transit_encryption_enabled on ElastiCache.
     Use TLS in Redis client connection options.
```

---

## SECTION 11 — Quick Revision

### 10 Core Takeaways

```
1. Session ID must be cryptographically random — 256 bits (crypto.randomBytes(32)).
   Never derive from user ID, timestamp, or any predictable data.

2. Session security is entirely dependent on the cookie flags:
   HttpOnly + Secure + SameSite=Lax is the non-negotiable minimum.

3. Server-side session deletion IS logout. Clearing the cookie is client convenience.
   A stolen cookie ignores the browser's cleared cookie — only server deletion stops it.

4. Session ID MUST be regenerated after every privilege change.
   Login, MFA completion, sudo activation — all require a new session ID.

5. Session store for production = external shared store (Redis).
   In-memory store = development only. Zero production value.

6. Password change must revoke all sessions (except current).
   Sessions and passwords are independent credentials — changing one doesn't affect the other.

7. Implement both absolute timeout (hard cap) + idle timeout (inactivity cap).
   Different threat models: absolute = stolen token; idle = unattended computer.

8. return 401 for invalid/expired sessions. Never redirect to /dashboard.
   Clear the cookie before returning 401 (don't keep dead cookies on client).

9. For multi-tenant apps: session must contain tenant_id.
   All resource queries must include tenant boundary for this value.

10. Monitor login failure rates. Spike = credential stuffing. Alert at > 50/min from one IP.
```

### 30-Second Interview Answer

> "Session authentication works by storing user identity on the server and giving the client an opaque random token — the session ID — in an HttpOnly, Secure cookie. Every request, the server looks up that token in a shared store like Redis to identify the user. The key security controls are: cryptographically random session IDs to prevent prediction, HttpOnly and Secure cookie flags to prevent theft, session regeneration after login to prevent fixation, and server-side deletion on logout so clearing the browser cookie isn't the only defense. The main tradeoff versus JWT is that sessions require a shared server-side store, which adds a Redis dependency, but in return you get instant revocation at any time — which is why banking and high-security systems prefer sessions."

### Memory Tricks

```
Session security checklist — "RICE":
  R — Random session ID (crypto.randomBytes(32))
  I — Immediate delete on logout (server-side, not just cookie clear)
  C — Cookie flags: HttpOnly + Secure + SameSite=Lax
  E — Expire: both absolute timeout AND idle timeout

Session attack types — "FIXED":
  F — Fixation (plant session ID before login)
  I — Interception (steal session via XSS or network)
  X — eXpiry not enforced (session lives forever)
  E — Enumeration (sequential IDs guessable)
  D — Double session (no concurrent session control)
```

---

## SECTION 12 — Security Thinking Exercise

### Scenario: TeamFlow — Project Management SaaS

**Context:**

TeamFlow is a B2B SaaS project management tool (competitor to Jira). Architecture:

- Multi-tenant: each company is a tenant. Tenant isolation is a core contract.
- Auth: session-based with express-session using the default MemoryStore.
- Deployed to 3 EC2 instances behind an ALB (no sticky sessions).
- Session cookie: just `cookie: { maxAge: 86400000 }` (no Secure, HttpOnly, or SameSite specified).
- Login handler: verifies credentials → sets `req.session.userId = user.id` → returns 200.
- Logout handler: `res.clearCookie('connect.sid')` → returns 200.

**Before reading the analysis — identify all security vulnerabilities in this setup.**

---

### Analysis: What's Wrong and Why

```
VULNERABILITY 1 — Default MemoryStore in production
  Symptom: Users randomly get logged out, especially after deployments.
  Request goes to Server A (session created) → next request goes to Server B →
  session not found → 401 → user logged out.

  With 3 EC2 instances and no sticky sessions: 2/3 of requests fail to find session.
  Production will be non-functional for sessions once traffic is load-balanced.

  Fix: RedisStore with ElastiCache backend.

VULNERABILITY 2 — Cookie settings missing HttpOnly, Secure, SameSite
  cookie: { maxAge: 86400000 } only.

  Missing HttpOnly: document.cookie can read the session ID.
  Any XSS on the application → attacker exfiltrates all session cookies of all users.
  This is not a theoretical vulnerability for a project management tool:
  user-generated content (task descriptions, comments) is common XSS surface.

  Missing Secure: Session cookie transmitted over HTTP (before HTTPS redirect).
  Man-in-the-middle can capture session cookie from the first HTTP request.

  Missing SameSite: Session cookie sent on cross-site POST requests.
  CSRF attack: attacker's page makes POST requests to TeamFlow with victim's session.

  Fix: httpOnly: true, secure: true, sameSite: 'lax'.

VULNERABILITY 3 — Logout only clears cookie
  res.clearCookie('connect.sid') → removes cookie from browser.
  Server-side session record: untouched.

  Scenario: Attacker has stolen the session cookie.
  User logs out (thinking they're safe).
  Attacker continues using the cookie → session still valid on server.
  Access continues until session expires (24 hours later).

  Fix: req.session.destroy() first, then clearCookie.

VULNERABILITY 4 — No session regeneration after login
  Code sets req.session.userId but does NOT call req.session.regenerate().

  If an attacker sets a known session ID before login (via URL injection, etc.)
  and the victim logs in carrying that session → session is now authenticated
  with the attacker-known ID. Attacker uses it immediately.

  Fix: call req.session.regenerate() on successful login.
  This creates a new session ID and discards the old one.

VULNERABILITY 5 — No session invalidation on sensitive actions
  If a user changes their password → their existing sessions remain active.
  If an attacker had a stolen session → they survive the password change.

  Fix: on password change → req.session.destroy() for ALL sessions for this user.
  Requires tracking all sessions per user (Redis SET of session IDs per userId).
```

### Correct Secure Design

```javascript
// FIXED TeamFlow session configuration
import session from "express-session";
import RedisStore from "connect-redis";
import { createClient } from "redis";
import crypto from "crypto";

const redisClient = createClient({ url: process.env.REDIS_URL });
await redisClient.connect();

app.use(
  session({
    store: new RedisStore({ client: redisClient, prefix: "tf_sess:" }),
    secret: process.env.SESSION_SECRET, // 64+ char random — loaded from Secrets Manager
    name: "__Host-tfsid", // Non-default name + __Host- prefix
    resave: false,
    saveUninitialized: false,
    genid: () => crypto.randomBytes(32).toString("hex"),
    cookie: {
      httpOnly: true, // XSS-resistant
      secure: true, // HTTPS-only
      sameSite: "lax", // CSRF-resistant
      maxAge: 86400000, // 24 hours
      path: "/",
    },
  }),
);

// FIXED login handler
async function loginHandler(req, res) {
  const { email, password } = req.body;
  const user = await UserRepository.findByEmail(email);
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({ error: "INVALID_CREDENTIALS" });
  }

  // Session regeneration: prevent fixation
  await new Promise((resolve, reject) => {
    req.session.regenerate((err) => (err ? reject(err) : resolve()));
  });

  req.session.userId = user.id;
  req.session.tenantId = user.tenantId;
  req.session.role = user.role;
  req.session.loginAt = Date.now();

  // Track session for per-user revocation
  await redisClient.sAdd(`user_sessions:${user.id}`, req.session.id);

  return res.json({ success: true });
}

// FIXED logout handler
async function logoutHandler(req, res) {
  const sessionId = req.session.id;
  const userId = req.session.userId;

  // Server-side deletion FIRST
  await new Promise((resolve) => req.session.destroy(resolve));

  // Remove from per-user session index
  if (userId) {
    await redisClient.sRem(`user_sessions:${userId}`, sessionId);
  }

  // Clear browser cookie
  res.clearCookie("__Host-tfsid", { path: "/" });
  return res.json({ success: true });
}

// FIXED password change handler
async function changePasswordHandler(req, res) {
  const userId = req.session.userId;
  const currentSessionId = req.session.id;
  const { currentPassword, newPassword } = req.body;

  const user = await UserRepository.findById(userId);
  if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
    return res.status(403).json({ error: "CURRENT_PASSWORD_INVALID" });
  }

  const newHash = await bcrypt.hash(newPassword, 12);
  await UserRepository.updatePassword(userId, newHash);

  // Revoke all sessions except current
  const allSessionIds = await redisClient.sMembers(`user_sessions:${userId}`);
  const otherSessions = allSessionIds.filter((sid) => sid !== currentSessionId);

  if (otherSessions.length > 0) {
    const pipeline = redisClient.pipeline();
    for (const sid of otherSessions) {
      pipeline.del(`tf_sess:${sid}`);
    }
    await pipeline.exec();
    await redisClient.sRem(`user_sessions:${userId}`, ...otherSessions);
  }

  return res.json({
    success: true,
    message: "Password updated. Other sessions revoked.",
  });
}
```

_End of Topic 02: Session Authentication_
