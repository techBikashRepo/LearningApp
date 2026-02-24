# Session Authentication — Part 2 of 3

### Sections: 5 (Defense Mechanisms), 6 (Architecture Diagram), 7 (Production Scenarios), 8 (AWS Mapping)

**Series:** Authentication & Security → Topic 02

---

## SECTION 5 — Defense Mechanisms

### Defense 1: Cryptographically Secure Session ID Generation

```javascript
import crypto from 'crypto';

function generateSessionId(): string {
  // 32 bytes = 256 bits of entropy from OS CSPRNG
  // .toString('hex') = 64-character hex string
  // 2^256 possible values — computationally unguessable
  return crypto.randomBytes(32).toString('hex');
}

// NEVER use:
const badId1 = Date.now().toString();                    // predictable
const badId2 = Math.random().toString(36);               // Math.random is NOT cryptographic
const badId3 = `sess_${userId}_${timestamp}`;            // derived from known values
const badId4 = require('uuid').v4();                     // UUID v4 is fine but uses less entropy
                                                          // than crypto.randomBytes(32)
// uuid v4 = 122 bits of randomness — acceptable but not ideal
// crypto.randomBytes(32) = 256 bits — preferred
```

### Defense 2: Complete Cookie Configuration

```javascript
const SESSION_COOKIE_OPTIONS = {
  httpOnly: true, // No JavaScript access → XSS cannot steal cookie
  secure: true, // HTTPS only → no cleartext transmission
  sameSite: "lax", // Blocks cross-site POST CSRF; allows top-level GET navigation
  // Use 'strict' for highest security (breaks some OAuth redirects)
  path: "/", // Available for all routes
  maxAge: 24 * 60 * 60, // 24 hours in seconds (Max-Age header)
  // Do NOT use 'expires' — relative to server clock, not client
};

// Setting the session cookie after successful login
function setSessionCookie(res, sessionId) {
  res.cookie("sessionId", sessionId, SESSION_COOKIE_OPTIONS);
}

// Clearing the session cookie on logout
function clearSessionCookie(res) {
  res.clearCookie("sessionId", {
    path: "/", // Must match the path used when setting
    httpOnly: true,
    secure: true,
    sameSite: "lax",
  });
  // Note: clearCookie sets the cookie value to '' and Max-Age to 0
  // The browser deletes the cookie on receipt
}
```

### Defense 3: Session Regeneration on Privilege Escalation

```javascript
// RULE: Any time privilege changes — new session ID, old session deleted.
// Events requiring regeneration:
//   - Successful login (password → authenticated)
//   - MFA completion (partially authenticated → fully authenticated)
//   - Sudo/admin mode activation
//   - Role change (user → admin)

async function regenerateSession(req, res, additionalData = {}) {
  const oldSessionId = req.cookies.sessionId;

  // 1. Generate new session ID
  const newSessionId = generateSessionId();

  // 2. Copy data from old session to new (if old session exists)
  let sessionData = {};
  if (oldSessionId) {
    const oldSession = await redis.get(`session:${oldSessionId}`);
    if (oldSession) sessionData = JSON.parse(oldSession);
    // 3. Delete old session immediately
    await redis.del(`session:${oldSessionId}`);
  }

  // 4. Create new session with updated data
  const newSession = {
    ...sessionData,
    ...additionalData,
    regeneratedAt: new Date().toISOString(),
  };

  await redis.setex(
    `session:${newSessionId}`,
    24 * 60 * 60, // TTL: 24 hours
    JSON.stringify(newSession),
  );

  // 5. Set new cookie
  setSessionCookie(res, newSessionId);
  return newSessionId;
}

// Usage in login handler:
async function loginHandler(req, res) {
  const { email, password } = req.body;

  const user = await UserRepository.findByEmail(email);
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({ error: "INVALID_CREDENTIALS" });
  }

  // Regenerate session (fixes session fixation, elevates from anon to authenticated)
  await regenerateSession(req, res, {
    userId: user.id,
    email: user.email,
    role: user.role,
    loginAt: new Date().toISOString(),
  });

  return res.json({ success: true, user: { id: user.id, email: user.email } });
}
```

### Defense 4: Session Revocation Strategies

```javascript
// STRATEGY A: Single session logout
async function logout(req, res) {
  const sessionId = req.cookies.sessionId;
  if (sessionId) {
    await redis.del(`session:${sessionId}`);
  }
  clearSessionCookie(res);
  return res.json({ success: true });
}

// STRATEGY B: Logout all devices ("kick all sessions")
async function logoutAllSessions(userId) {
  // Requires tracking session IDs per user
  // Option 1: User-session index in Redis
  const sessionIds = await redis.smembers(`user_sessions:${userId}`);
  const pipeline = redis.pipeline();
  for (const sid of sessionIds) {
    pipeline.del(`session:${sid}`);
  }
  pipeline.del(`user_sessions:${userId}`);
  await pipeline.exec();
}

// STRATEGY C: Forced revocation on security event (password change, account compromise)
// Same as logoutAllSessions — call it on:
//   - Password change
//   - Email change
//   - Suspicious activity detected
//   - Account locked by admin

// STRATEGY D: Token version approach (optimistic — avoids storing session list)
// Add session_version to user record. Increment on password change.
// Include session_version in session data. Compare on every request.
// Mismatch → revoke. No need to track all session IDs.
async function validateSessionVersion(session, userId) {
  const user = await UserRepository.findById(userId);
  if (session.sessionVersion !== user.sessionVersion) {
    return false; // Stale session — password was changed after this session was created
  }
  return true;
}
```

### Defense 5: Idle Timeout vs Absolute Timeout

```
Two types of session expiry — both required for different threat models:

ABSOLUTE TIMEOUT:
  Session expires X hours after creation regardless of activity.
  Purpose: Limits damage from a stolen session (attacker has max X hours).
  Example: Banking requires 8-hour max. E-commerce: 30 days is common.

  Implementation: expires_at set at CREATE time. Never extended.
  Redis: TTL set once at creation, never reset.

IDLE TIMEOUT:
  Session expires if no activity for Y minutes.
  Purpose: Protects shared computers (user forgets to log out).
  Example: Banking: 10 minutes idle. Admin dashboards: 30 minutes idle.

  Implementation: last_seen_at update on every request.
  Check: if (now() - last_seen_at > idleLimit) → expire session.
  Redis: update TTL on every request (EXPIRE command). Higher I/O cost.

PRODUCTION COMBINATION (typical web app):
  Absolute: 30 days (remember me) or 24 hours (standard session)
  Idle: 60 minutes (prompt user after 45 min warning)

  Banking:
  Absolute: 8 hours
  Idle: 10 minutes (regulatory requirement in many jurisdictions)

// Implementation
async function getSession(sessionId) {
  const session = await redis.get(`session:${sessionId}`);
  if (!session) return null;

  const data = JSON.parse(session);
  const now = Date.now();

  // Check idle timeout (30 minutes)
  const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
  if (now - data.lastSeenAt > IDLE_TIMEOUT_MS) {
    await redis.del(`session:${sessionId}`);
    return null; // Expired by idle
  }

  // Update lastSeenAt (sliding window)
  data.lastSeenAt = now;
  await redis.setex(`session:${sessionId}`, 24 * 60 * 60, JSON.stringify(data));

  return data;
}
```

---

## SECTION 6 — Architecture Diagram

```
SESSION AUTHENTICATION ARCHITECTURE — PRODUCTION

┌─────────────────────────────────────────────────────────────────────────────────┐
│                           CLIENT (Browser)                                      │
│  Stores: sessionId cookie (HttpOnly, Secure, SameSite=Lax)                     │
│  Cannot read cookie via JS — no XSS risk for cookie value                      │
└──────────────────────────┬──────────────────────────────────────────────────────┘
                           │ HTTPS only (Secure flag enforces this)
                           │ Cookie auto-attached to requests within domain
                           ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                        CLOUDFRONT + WAF                                         │
│  Rate limits: 5 login attempts/IP/minute (WAF rule)                            │
│  Bot detection: AWS managed rules                                               │
│  HTTPS termination + TLS 1.2+ enforcement                                      │
│  No session-awareness — passes cookies through unchanged                        │
└──────────────────────────┬──────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                     APPLICATION LOAD BALANCER (ALB)                             │
│  Sticky sessions: NOT recommended (breaks horizontal scaling)                  │
│  Route to any instance: all instances share Redis → any server can validate    │
│  Health checks: /health endpoint (no session required)                          │
└─────────────┬─────────────────────────────────────────┬───────────────────────┘
              │                                         │
              ▼                                         ▼
┌─────────────────────────┐               ┌─────────────────────────┐
│   APP SERVER Instance 1 │               │   APP SERVER Instance 2 │
│   (Express/Node.js)     │               │   (Express/Node.js)     │
│                         │               │                         │
│ sessionMiddleware:       │               │ sessionMiddleware:       │
│ 1. Read cookie           │               │ 1. Read cookie           │
│ 2. GET session:${id}     │               │ 2. GET session:${id}     │
│ 3. Validate expiry       │               │ 3. Validate expiry       │
│ 4. Attach req.user       │               │ 4. Attach req.user       │
│ 5. UPDATE last_seen      │               │ 5. UPDATE last_seen      │
└────────────┬────────────┘               └────────────┬────────────┘
             │                                         │
             └──────────────────┬──────────────────────┘
                                │ Redis GET/SET commands
                                ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│              AWS ElastiCache Redis (Cluster Mode)                               │
│                                                                                 │
│  Key format:  session:{sessionId}                                               │
│  Value:       JSON { userId, email, role, loginAt, lastSeenAt, ipAddress,      │
│                      sessionVersion }                                           │
│  TTL:         86400 seconds (24 hours)                                          │
│                                                                                 │
│  user_sessions:{userId}  →  SET of session IDs (for all-device logout)         │
│                                                                                 │
│  Multi-AZ: Primary + 2 replicas                                                 │
│  Reads from replica, writes to primary                                          │
│  Failover: automatic (60 seconds) via ElastiCache auto-failover                │
└───────────────────────────┬─────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                  PostgreSQL RDS (User Account Store)                            │
│                                                                                 │
│  Queried on login only (credential verification + session version check)        │
│  NOT queried on every request (Redis handles that)                              │
│  Contains: users.session_version (incremented on password change)              │
└─────────────────────────────────────────────────────────────────────────────────┘

RESPONSIBILITY SPLIT:
┌─────────────────────┬────────────────────────────────────────────────────────┐
│ Layer               │ Responsibility                                         │
├─────────────────────┼────────────────────────────────────────────────────────┤
│ WAF                 │ Rate limit /login; block known malicious IPs          │
│ CloudFront          │ TLS, geographic routing                                │
│ ALB                 │ Load distribution (no session stickiness needed)       │
│ App Server          │ Session creation, validation, regeneration, revocation │
│ Redis               │ Session store: fast lookup, automatic TTL expiry      │
│ PostgreSQL          │ User identity, password hash, session_version          │
│ CloudWatch          │ Alert on high login failure rate (credential stuffing) │
│ CloudTrail          │ Admin session access audit for compliance              │
└─────────────────────┴────────────────────────────────────────────────────────┘
```

---

## SECTION 7 — Production Scenarios

### Scenario 1: RetailPro — Session Not Invalidated on Password Change

**Context:** RetailPro is an e-commerce platform with 2M users. A user discovers their account was compromised and changes their password.

**What happened:**

```
Timeline:
  Day 1 14:00 — Attacker steals Bob's session cookie via XSS in comment field.
  Day 1 14:05 — Attacker logs in as Bob using stolen cookie.
                 Attacker changes Bob's shipping address to a drop address.
  Day 1 18:00 — Bob notices unauthorized activity. Changes password.
  Day 1 18:01 — Password change handler updates password hash.
                 MISSING: session invalidation.
  Day 1 18:05 — Bob thinks he's safe (new password = new security).
  Day 3 09:00 — Attacker still has the original session cookie.
                 Cookie is NOT expired (7-day sessions).
                 Password change did NOT kill the attacker's session.
  Day 3 09:01 — Attacker places $4,500 order to the drop address.
  Day 3 09:05 — Attacker changes email on the account.
                 Bob is now locked out of his own account again.

ROOT CAUSE:
  Password change handler:
    BEFORE: await user.update({ passwordHash });
    MISSING: await deleteAllSessions(user.id);

  Password change provides false security if sessions are not terminated.
  The attacker holds an authentication credential (session) that is INDEPENDENT
  of the password. They are different credentials — changing one doesn't affect the other.

FIX:
  async function changePassword(userId, newPassword, currentSessionId) {
    const hash = await bcrypt.hash(newPassword, 12);
    await db.transaction(async (trx) => {
      await trx('users').where({ id: userId }).update({ password_hash: hash });
      // Revoke ALL sessions except the current one
      // (Keep current so user doesn't have to immediately log back in)
      await trx('sessions')
        .where({ user_id: userId })
        .whereNot({ id: currentSessionId })
        .delete();
    });
    // Notify user: "Password changed. All other sessions logged out."
  }
```

### Scenario 2: FinancialApp — Session Concurrent Use Anomaly

**Context:** FinancialApp is a personal finance tracking app (bank-linked). Account has PII + linked bank credentials.

**Incident: Account takeover via session sharing (credential leak)**

```
What happened:
  User stored their session cookie in browser profile synced to cloud.
  Browser profile was compromised via a separate vulnerability.
  Session cookie (non-expired, 30-day "remember me") was extracted.

  Session was used concurrently:
  - London IP (victim, normal usage)
  - Lagos IP (attacker, identical session cookie)

  System had NO concurrent session detection.
  Both connections used the same session_id simultaneously.
  Attacker viewed all linked accounts, exported transaction history.

DETECTION (what the system lacked):
  On each session access, compare:
  1. IP address (significant geolocation change = anomaly if not VPN)
  2. User-Agent string (different device/browser = potential theft)
  3. Concurrent active connections (> 1 IP per session simultaneously)

  IMPLEMENTATION:
  async function detectSessionAnomaly(session, req) {
    const anomalies = [];

    // IP address change
    if (session.lastIp && session.lastIp !== req.ip) {
      const geoDistance = await calculateGeoDistance(session.lastIp, req.ip);
      if (geoDistance > 500) { // More than 500km change between requests
        anomalies.push({ type: 'IMPOSSIBLE_TRAVEL', distance: geoDistance });
      }
    }

    // User-Agent change
    if (session.userAgent && session.userAgent !== req.headers['user-agent']) {
      anomalies.push({ type: 'USER_AGENT_CHANGE' });
    }

    if (anomalies.length > 0) {
      await securityAlert.raise({
        userId: session.userId,
        sessionId: session.id,
        anomalies,
        currentRequest: { ip: req.ip, userAgent: req.headers['user-agent'] },
      });
      // Decision: step-up auth (MFA) vs immediate session invalidation
      // For financial app: immediate invalidation + email alert + require re-login
      return { suspicious: true, action: 'REQUIRE_REAUTH' };
    }

    return { suspicious: false };
  }
```

---

## SECTION 8 — AWS Mapping

### AWS Services for Session Authentication

```
┌──────────────────────────┬──────────────────────────────────────────────────────┐
│ AWS Service              │ Role in Session Authentication                       │
├──────────────────────────┼──────────────────────────────────────────────────────┤
│ ElastiCache Redis        │ Session store — fast lookup, auto TTL expiry         │
│ (cluster mode enabled)   │ Stores: session key/value with user context          │
│                          │ Built-in expiry: no cron needed for cleanup          │
├──────────────────────────┼──────────────────────────────────────────────────────┤
│ RDS Aurora               │ User identity + password hash + session_version      │
│ (PostgreSQL)             │ Queried only at login — not per request              │
├──────────────────────────┼──────────────────────────────────────────────────────┤
│ AWS WAF                  │ Rate limit /login endpoint                           │
│                          │ Rule: 5 requests per IP per minute → 429 response   │
│                          │ AWS Managed Rules: bot detection, known bad IPs      │
├──────────────────────────┼──────────────────────────────────────────────────────┤
│ AWS Secrets Manager      │ Store Redis connection string and credentials        │
│                          │ Rotate automatically (no hardcoded credentials)      │
├──────────────────────────┼──────────────────────────────────────────────────────┤
│ CloudFront               │ HTTPS enforcement, TLS 1.2+ minimum policy           │
│                          │ HSTS via response headers (Strict-Transport-Security)│
├──────────────────────────┼──────────────────────────────────────────────────────┤
│ CloudWatch Logs          │ Session creation/deletion events (structured JSON)   │
│                          │ Alarm: > 100 failed logins/minute per source IP      │
├──────────────────────────┼──────────────────────────────────────────────────────┤
│ CloudTrail               │ Admin session access audit trail (compliance)        │
│                          │ Immutable log: who accessed what, when, from where  │
├──────────────────────────┼──────────────────────────────────────────────────────┤
│ Security Hub + GuardDuty │ Anomaly detection on session patterns                │
│                          │ GuardDuty: impossible travel, compromised credential │
└──────────────────────────┴──────────────────────────────────────────────────────┘
```

### Production Session Architecture (AWS Full Stack)

```javascript
// connect-redis session store (Express.js + AWS ElastiCache)
import session from "express-session";
import RedisStore from "connect-redis";
import { createClient } from "redis";

const redisClient = createClient({
  url: process.env.REDIS_URL, // From Secrets Manager: redis://elasticache-endpoint:6379
  socket: {
    tls: true, // ElastiCache in-transit encryption
    rejectUnauthorized: true,
  },
});
await redisClient.connect();

const sessionStore = new RedisStore({
  client: redisClient,
  prefix: "session:", // Keys: session:sess_abc123...
  ttl: 86400, // 24 hours TTL matches cookie Max-Age
});

app.use(
  session({
    store: sessionStore,
    secret: process.env.SESSION_SECRET, // From Secrets Manager — 64+ char random string
    name: "__Host-sid", // __Host- prefix: cookie locked to current host
    // Cannot be set by a subdomain (subdomain takeover defense)
    resave: false, // Don't save session if not modified
    saveUninitialized: false, // Don't create session until something is stored
    cookie: {
      httpOnly: true,
      secure: true, // Requires HTTPS
      sameSite: "lax",
      maxAge: 86400 * 1000, // connect-redis expects milliseconds
      path: "/",
    },
    genid: () => crypto.randomBytes(32).toString("hex"), // Override default ID generator
  }),
);

// __Host- prefix security:
// Requires: Secure flag, no Domain attribute, Path=/
// Benefit: Cookie cannot be overwritten by a compromised subdomain
// (subdomain can't set __Host- cookies for the apex domain)
```

### ElastiCache Redis Configuration (Terraform snippet)

```hcl
resource "aws_elasticache_replication_group" "sessions" {
  replication_group_id       = "session-store"
  description                = "Session store for auth service"

  node_type                  = "cache.r7g.large"
  num_cache_clusters         = 3          # 1 primary + 2 read replicas
  automatic_failover_enabled = true       # Auto-promote replica on primary failure
  multi_az_enabled           = true

  at_rest_encryption_enabled  = true      # AES-256 encryption at rest
  transit_encryption_enabled  = true      # TLS in-transit

  auth_token                 = var.redis_auth_token   # From Secrets Manager

  snapshot_retention_limit   = 1           # 1-day snapshot (for disaster recovery)

  # No persistence for pure session use case
  # Redis doesn't need to survive restarts — sessions have TTLs
  # Users will just re-authenticate
}
```
