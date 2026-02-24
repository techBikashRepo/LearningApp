# Login Rate Limiting — Part 3 of 3

### Sections: 9 (Interview Prep), 10 (Common Mistakes), 11 (Quick Revision), 12 (Security Exercise)

**Series:** Authentication & Security → Topic 09

---

## SECTION 9 — Interview Preparation

### Beginner Level

**Q: What is login rate limiting and why does the login endpoint specifically need it?**

```
ANSWER:
Rate limiting means restricting how many requests a client can make in a given time window.
Login endpoints need it because they are the public gateway to private accounts.

Without rate limiting:
  - An attacker can try 500 passwords per second.
  - A 6-character password with lowercase only: 308 million combinations.
  - At 500/sec: cracked in 10 minutes.

With a 5-failure-per-account lockout:
  - Attacker gets 5 guesses then waits 30 minutes.
  - 500 passwords × 30 minutes = 25,000 minutes = 17+ days for the same 500 passwords.

Login is different from other endpoints because:
  1. Correctness of response can be inferred by attacker (200 = valid, 401 = wrong password).
  2. Success = money, data, or impersonation — much higher value target.
  3. Credentials are often reused from other breaches.
  4. No authentication required to hit the endpoint (chicken-and-egg: need auth to get auth).
```

**Q: What's the difference between rate limiting and account lockout?**

```
RATE LIMITING:
  - Throttles the request rate (X requests per time window).
  - Affects the source (IP, account) globally.
  - Does NOT permanently block — window expires and count resets.
  - Applied BEFORE authentication attempt.

ACCOUNT LOCKOUT:
  - Blocks a specific account after N consecutive failures.
  - Applied AFTER each failed authentication.
  - Requires explicit unlock (email link, time expiry, admin action).
  - More disruptive to legitimate user if triggered.

BEST PRACTICE: use both.
  Rate limit: catches fast attacks early (before bcrypt is called repeatedly).
  Lockout: catches slow attacks and distributed attacks (different IPs, same account).
```

---

### Intermediate Level

**Q: Why does IP-only rate limiting fail for distributed attacks? How do you fix it?**

```
IP-ONLY FAILURE:
  Modern credential stuffing tools (OpenBullet, Sentry MBA) come with proxy support.
  A threat actor can rent residential proxy pools: 1,000+ residential IPs for $50-200/month.
  Each proxy sends 1-2 requests then rotates to next IP.

  Example:
    Your limit: 20 requests per minute per IP.
    Attacker: 200 IPs, each sends 1 request per minute.
    Throughput: 200 credentials/minute = 12,000/hour = well within your IP limits.

  Residential proxies look like real home users — no bot signatures.
  IP reputation lists: ineffective since IPs are legitimate residential addresses.

THE FIX — Per-Account Rate Limiting:
  Regardless of which IP the request comes from, track:
    "How many failed attempts has account X received?"

  Implementation:
    ZADD login:fail:{email} {timestamp} {timestamp}

    After 5 failures (from any IPs):
    → Account locked regardless of IP.

  Result:
    Attacker sends 200 requests to alice@company.com from 200 different IPs.
    5th failure: alice@company.com locked.
    Attacker can no longer attempt alice@company.com regardless of IPs used.

COMPLETE STRATEGY (both layers required):
  [ ] Per-IP: blocks high-volume attacks from single source
  [ ] Per-account: blocks distributed attacks (different IPs, same account)
  [ ] CAPTCHA at threshold: blocks automation even under soft limits
  [ ] Lockout with email unlock: hard stop after threshold
  [ ] Global anomaly monitoring: alert when global failure rate spikes
```

**Q: How do you design a login rate limiter that works across multiple app server instances?**

```
PROBLEM:
  Two app server instances, each with in-memory rate counters.
  Attacker sends 20 requests to instance A, 20 requests to instance B.
  Both think: "this IP has made 20 requests — fine."
  Real count: 40 — should have been blocked.

SOLUTION: Centralized Redis store.
  All instances share a single Redis cluster.
  Rate counter lives in Redis, not in any single server's memory.

  Atomic increment with Lua:
    Redis Lua scripts run atomically — no race condition where two servers
    simultaneously read "count=19", both add 1, both write "20",
    effectively skipping count 20.

    The Lua script: ZREMRANGEBYSCORE → ZCARD → ZADD — all atomic.
    Guarantees: exactly one entry added per request, no double-counting.

HANDLING REDIS FAILURE:
  Redis goes down or becomes unreachable.
  Options:
    a) Fail OPEN: allow all requests (normal UX, but attack window during outage).
    b) Fail CLOSED: reject all login requests (blocks attack, but also blocks users).
    c) Fail OPEN + immediate alert: best for most apps.
       → Alert ops team immediately (PagerDuty/Slack).
       → Log all login attempts to CloudWatch during outage.
       → Redis cluster: primary + replica for high availability (ElastiCache Cluster Mode).
```

---

### Senior / System Design Level

**Q: Design rate limiting for a login service handling 10,000 requests/second at peak. What are the trade-offs?**

```
SCALE CONTEXT:
  10,000 req/sec = 600,000 req/min.
  Multiple app server instances (ECS Fargate, Auto Scaling Group).
  Redis: needs to handle 10,000 Redis operations/second for rate checks alone.

REDIS SCALING:
  ElastiCache Redis cluster mode: shard data across multiple nodes.
  Rate limit keys naturally shard by IP/email hash — good distribution.

  Key design:
    rl:ip:{ip} → sharded by IP hash → distributed across nodes.
    rl:acct:{email_hash} → sharded by email hash → distributed across nodes.
    No hotspot: no single Redis key gets all 10,000 operations.

  Memory calculation:
    Per-entry: ~50 bytes (sorted set entry).
    1,000,000 active IPs × 20 entries × 50 bytes = ~1GB Redis memory.
    Add replicas: 2-3GB for HA cluster → small and cheap (cache.r6g.large).

LUA SCRIPT ATOMIC CONCERN AT SCALE:
  Lua scripts block Redis while executing (single-threaded Redis).
  Short scripts: executed in microseconds. At 10K/sec: fine.
  If Lua script runtime grows: risk of Redis latency spikes.
  ALTERNATIVE at extreme scale: Sorted Set pipeline (ZADD + ZCARD) with optimistic
    concurrency. Slightly more complex but avoids Lua blocking.

SHARDING CONCERN:
  Redis Cluster and Lua: keys must be on the same shard for Lua to work.
  Rate limit keys: one key per entity (one sorted set per IP) — no multi-key Lua needed.
  Conclusion: standard Redis Cluster works fine.

CAPTCHA TRADE-OFF:
  CAPTCHA adds 5-10 seconds of human interaction time.
  At 10K/sec, most are legitimate users not attackers.
  Triggering CAPTCHA TOO eagerly: bad UX for everyone.
  Strategy: CAPTCHA only AFTER multiple failures per account or anomaly detection score.

BYPASS TECHNIQUES AND RESPONSES:
  IPv6 rotation: attacker generates new /64 prefix per request.
    Response: rate limit by /24 for IPv4, /48 for IPv6 (CIDR-level).

  Residential proxies: legitimate-looking IPs.
    Response: behavioral analysis (typing speed, mouse movement via device fingerprint).

  Distributed slow attack (1 attempt/hour/account):
    Response: per-account lockout catches this (5 failures over any timespan).
    Lifetime failure count: even 1 failure per day → locked after 5 days.

  CAPTCHA solving farms ($1/1000 solves):
    Response: hCaptcha/Cloudflare Turnstile Enterprise tier (ML-based bot detection
    beyond simple click; legitimate users pass, farm workers still slow and expensive).
```

---

## SECTION 10 — 10 Common Developer Mistakes

### Mistake 1: Rate Limiting Only by IP

```javascript
// ❌ VULNERABLE: IP-only rate limiting
const rateLimit = require("express-rate-limit");
app.use("/auth/login", rateLimit({ windowMs: 60000, max: 20 }));
// Bypassed by: residential proxy rotation (200 IPs = 4,000 req/min)

// ✅ CORRECT: Both IP and per-account limits
app.post("/auth/login", ipRateLimiter, accountRateLimiter, loginHandler);
// Even with 200 IPs: each account locked at 5 failures regardless of IP diversity
```

### Mistake 2: Forgetting Account-Level Failure Tracking

```javascript
// ❌ VULNERABLE: Tracking only in Redis per IP, not per account
// Password spray: attacker tries 1 password each against 10,000 accounts
// Each account: 1 attempt. IP never hits rate limit. Account never tracks failures.

// ✅ CORRECT: Track failures per account (email hash)
const failKey = `login:fail:${hashEmail(email)}`;
await redis.incr(failKey);
```

### Mistake 3: Lockout Without Unlock Mechanism

```javascript
// ❌ ANTI-PATTERN: Permanent lock with no unlock path
if (failures >= 5) {
  return res.status(423).json({ error: "ACCOUNT_PERMANENTLY_LOCKED" });
  // User is now stuck. Cannot login. Support ticket = hours/days of wait.
}

// ✅ CORRECT: TTL-based auto-unlock + email unlock link
await redis.pexpire(failKey, 30 * 60 * 1000); // Auto-unlock after 30 minutes
if (newFailures === MAX_FAILURES && user) {
  const token = crypto.randomBytes(32).toString("hex");
  await sendUnlockEmail(user.email, token); // Immediate unlock available via email
}
```

### Mistake 4: No User Notification on Lockout

```javascript
// ❌ SILENT LOCK: User's account locked, no email sent
// User cannot log in. Has no idea why. Assumes site is broken. Churns.

// ✅ NOTIFY: Send email at lockout threshold
if (newFailures === MAX_FAILURES && user) {
  await sendAccountLockedEmail(user.email, {
    subject: "Your account has been temporarily locked",
    body: `We detected ${MAX_FAILURES} failed login attempts on your account.
           If this was you, click here to unlock: ${unlockUrl}
           If this was NOT you, change your password immediately.`,
  });
}
```

### Mistake 5: Instant Hard 429 (No Progressive Difficulty)

```javascript
// ❌ INSTANT BLOCK: Attacker gets instant 429, moves to next proxy immediately.
// No cost imposed. Retry with next credential is instant.

// ✅ PROGRESSIVE DELAY: Makes each attempt expensive for automated tools.
const delays = [0, 0, 1000, 2000, 4000, 8000]; // Exponential delay per failure count
const delay = delays[Math.min(failures, delays.length - 1)];
await new Promise((r) => setTimeout(r, delay)); // Slows automation significantly
// Still return 401 after delay (attacker can't know about delay in advance)
```

### Mistake 6: In-Memory Rate Limiter (Resets on Deploy)

```javascript
// ❌ IN-MEMORY: Resets on every server restart, deploy, or crash.
import rateLimit from "express-rate-limit";
app.use(rateLimit({ windowMs: 60000, max: 5 }));
// express-rate-limit uses in-memory storage by default
// Deploy at 3 AM → all counters reset → attack window reopens

// ✅ REDIS-BACKED: Persistent across deploys
import { RedisStore } from "rate-limit-redis";
app.use(
  rateLimit({
    windowMs: 60000,
    max: 5,
    store: new RedisStore({
      sendCommand: (...args) => redis.sendCommand(args),
    }),
  }),
);
```

### Mistake 7: Rate Limiter Check AFTER bcrypt (Wasted Compute)

```javascript
// ❌ WRONG ORDER: Rate limiter runs after bcrypt.compare()
app.post("/auth/login", async (req, res) => {
  const user = await User.findByEmail(req.body.email);
  const valid = await bcrypt.compare(req.body.password, user.passwordHash); // ~300ms CPU

  if (failureCount > 5) return res.status(429).json({ error: "RATE_LIMITED" }); // too late!
  // Attacker already consumed 300ms of bcrypt compute before being blocked
});

// ✅ CORRECT ORDER: Rate check runs BEFORE bcrypt
app.post("/auth/login", ipRateLimiter, accountRateLimiter, loginHandler);
// ipRateLimiter runs first: O(1) Redis read. If blocked: 429 immediately, no DB, no bcrypt.
// accountRateLimiter runs second: another Redis read. If blocked: 429 immediately.
// loginHandler runs last: DB + bcrypt only for requests that pass both rate checks.
```

### Mistake 8: Exposing X-RateLimit-Remaining to Attacker

```javascript
// ❌ LEAKS INFORMATION: Tells attacker exactly how many guesses remain
res.setHeader("X-RateLimit-Remaining", remaining);
// Attacker strategy: stop at 1 remaining, rotate proxy, start again from 20.
// Result: effective limit is never hit. Rate limiting is bypassed.

// ✅ CORRECT: Expose limit and window, but NOT remaining count for auth endpoints
res.setHeader("X-RateLimit-Limit", max);
res.setHeader("X-RateLimit-Window-Seconds", windowMs / 1000);
// Do NOT expose: X-RateLimit-Remaining for login endpoints
// (Remaining is useful for API endpoints, not authentication endpoints)
```

### Mistake 9: Same Rate Limit for Login and Password Reset

```javascript
// ❌ INCONSISTENT PROTECTION: Password reset has no rate limit
app.use("/auth/login", ipRateLimiter); // Protected
app.post("/auth/reset-password", resetHandler); // Unprotected!
// Attacker: bypasses login rate limit by abusing password reset to enumerate emails.
// "Email not found" vs "Email sent" reveals whether account exists.

// ✅ CONSISTENT: Rate limit ALL authentication-adjacent endpoints
app.post("/auth/login", ipRateLimiter, loginHandler);
app.post("/auth/reset-password", ipRateLimiter, resetHandler);
app.post("/auth/verify-mfa", ipRateLimiter, mfaHandler);
// All auth endpoints: rate limited, consistent error messages (no enumeration)
```

### Mistake 10: No CAPTCHA Escalation (Pure Rate Limit Without Bot Detection)

```javascript
// ❌ INSUFFICIENT: Rate limiting alone doesn't stop slow, distributed bots
// Attacker: 10 requests/hour/IP × 1000 IPs = 10,000/hour. Under any IP rate limit.
// Per-account: 10 IPs × 1 attempt each → account never hits per-account limit of 5.
// Result: slow credential stuffing bypasses both rate limits.

// ✅ ADD CAPTCHA TRIGGER: Require CAPTCHA on suspicious patterns
if (failures >= CAPTCHA_THRESHOLD) {
  if (!captchaToken || !(await verifyCaptcha(captchaToken, req.ip))) {
    return res.status(400).json({
      error: "CAPTCHA_REQUIRED",
      captchaSiteKey: process.env.HCAPTCHA_SITE_KEY,
    });
  }
}
// CAPTCHA after N failures: bot fails → stops; human passes → continues.
// hCaptcha/Cloudflare Turnstile: machine learning-based, hard to automate.
```

---

## SECTION 11 — Quick Revision & Mnemonics

### 10 Key Takeaways

```
1. IP-only rate limiting fails against distributed attacks (botnet, proxy rotation).
   You MUST add per-account failure tracking alongside IP limiting.

2. Rate limiting belongs in the middleware pipeline BEFORE authentication logic.
   Do not run bcrypt before checking rate limits — it wastes CPU.

3. Redis is the correct backing store. In-memory resets on deploy.
   Use sliding window (ZADD/ZREMRANGEBYSCORE) for accuracy.
   Use Lua scripts for atomic operations.

4. Progressive delays impose cost on automation without blocking legitimate users.
   Delay before responding (not after) — automation slowdown is immediate.

5. CAPTCHA escalation catches bots that stay under rate limits via slow drip attacks.
   Trigger after N failures per account. hCaptcha/Cloudflare Turnstile Enterprise.

6. Account lockout without unlock = voluntary DoS on your own users.
   Always provide: TTL-based auto-unlock AND email unlock link.

7. Notify users on lockout. Silent lockout → user confusion → churn.

8. Never expose X-RateLimit-Remaining to attackers on login endpoints.
   It tells them exactly how many guesses they have left before rotation.

9. Every auth-adjacent endpoint needs rate limiting: login, password reset,
   MFA verification, account unlock — not just /auth/login.

10. Defense in depth: WAF (IP reputation) + IP rate limit + per-account failure counter
    + CAPTCHA + lockout + MFA. Each layer catches what the previous layer misses.
```

### 30-Second Interview Answer

```
"To rate-limit login securely, I implement two independent layers in Redis:
IP rate limiting (e.g., 20 failures/minute per IP) to block volume attacks from
a single source, and per-account failure tracking (5 failures/15 minutes per email)
to catch distributed attacks that rotate through many IPs.

I apply these BEFORE bcrypt runs — O(1) Redis checks first, 300ms bcrypt only
for requests that pass both. I add progressive delays on failures to slow automation,
CAPTCHA at the soft-lock threshold for bot detection, and account lockout at the
hard-lock threshold with email unlock. All counters live in Redis (not in-memory)
so they survive deploys and work across multiple server instances.

I don't expose X-RateLimit-Remaining on auth endpoints, and I apply the same
protection to password reset and MFA endpoints to prevent bypass via adjacent endpoints."
```

### Mnemonics

```
RATE — the 4 components of a rate-limiting system:
  R — Redis-backed (not in-memory, survives deploys)
  A — Account + IP layers (both required; neither alone is sufficient)
  T — Throttle before lockout (progressive delay → CAPTCHA → hard lock)
  E — Escalate to CAPTCHA (add bot detection, not just request counting)

BLOCK — the 5 properties of a proper account lockout:
  B — Backoff progressively (delay before 401, not just hard 423)
  L — Lock with limited duration (auto-TTL: 30 minutes, not forever)
  O — Observe anomalies (CloudWatch alarms on failure spikes)
  C — Counter per account AND per IP (dual-layer required)
  K — Keep counters in Redis (distributed, persistent, TTL-aware)
```

---

## SECTION 12 — Security Thinking Exercise

### The Scenario: AuthService with Multiple Vulnerabilities

A startup built their login service. Review the code below and identify ALL security problems.
Then write the secure version.

```javascript
// ❌ VULNERABLE: auth.js — Find all the problems
const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const db = require("./db");

const app = express();
app.use(express.json());

// In-memory rate limiter
const requestCounts = {};

function checkLimit(req, res, next) {
  const ip = req.ip;
  const now = Date.now();

  if (!requestCounts[ip]) {
    requestCounts[ip] = { count: 1, windowStart: now };
    return next();
  }

  if (now - requestCounts[ip].windowStart > 60000) {
    requestCounts[ip] = { count: 1, windowStart: now };
    return next();
  }

  requestCounts[ip].count++;

  if (requestCounts[ip].count > 10) {
    return res.status(429).json({
      error: "Too many requests",
      remaining: 0,
      retryAfter: Math.ceil(
        (60000 - (now - requestCounts[ip].windowStart)) / 1000,
      ),
    });
  }

  res.setHeader("X-RateLimit-Remaining", 10 - requestCounts[ip].count);
  next();
}

app.post("/auth/login", checkLimit, async (req, res) => {
  const { email, password } = req.body;

  const user = await db.query("SELECT * FROM users WHERE email = $1", [email]);

  if (!user.rows[0]) {
    return res.status(401).json({ error: "User not found" });
  }

  const match = await bcrypt.compare(password, user.rows[0].password_hash);

  if (!match) {
    return res.status(401).json({ error: "Wrong password" });
  }

  const token = jwt.sign(
    { userId: user.rows[0].id, email: user.rows[0].email },
    "secretkey",
    { expiresIn: "30d" },
  );

  return res.json({ token, remaining: 10 - requestCounts[req.ip].count });
});

app.listen(3000);
```

---

### Vulnerability Analysis

```
VULNERABILITY 1: In-Memory Rate Limiter (Critical)
  requestCounts = {}  — lives in process memory.
  On deploy, crash, or restart: cleared. Attack window reopens.
  With multiple instances: each has its own counter. 10-instance cluster = 100 req/min effective limit.
  EXPLOIT: Deploy at night, attack immediately after.
  FIX: Redis sliding window rate limiter.

VULNERABILITY 2: IP-Only Rate Limiting (High)
  Only tracks by IP. No per-account failure counter.
  EXPLOIT: Password spray from 200 IPs (1 request each, 200 attempts in a minute).
  FIX: Add per-account failure counter in Redis: login:fail:{email_hash}.

VULNERABILITY 3: Account Enumeration via Different Error Messages (High)
  "User not found" → email not registered (tells attacker which emails exist)
  "Wrong password" → email IS registered (attacker now has valid email list)
  EXPLOIT: Send 1M emails to /login, collect "User not found" vs "Wrong password" →
    know exactly which emails have accounts → sell to spammers or use for targeted attack.
  FIX: Always return "INVALID_CREDENTIALS" regardless of which check failed.

VULNERABILITY 4: No Account Lockout (High)
  After N failed attempts: no lockout. checkLimit resets every 60 seconds.
  EXPLOIT: Slow brute force (9 attempts/minute → unlimited total attempts).
  FIX: Track failures per account, lockout at threshold.

VULNERABILITY 5: X-RateLimit-Remaining Exposed (Medium)
  res.setHeader('X-RateLimit-Remaining', 10 - requestCounts[req.ip].count)
  EXPLOIT: Attacker makes 9 requests (remaining=1 shown), rotates IP, starts again.
    Effective rate limit: infinite with enough IPs.
  FIX: Don't expose remaining count on auth endpoints.

VULNERABILITY 6: Hardcoded JWT Secret (Critical)
  jwt.sign(..., 'secretkey', ...)
  'secretkey' — if leaked (GitHub, pastebin, error log), ALL JWT tokens are forgeable.
  An attacker who knows the secret can sign: { userId: adminId, email: 'admin@co.com' }
    and get admin access without a password.
  FIX: process.env.JWT_SECRET (256-bit random from Secrets Manager).

VULNERABILITY 7: 30-Day JWT Expiry (High)
  { expiresIn: '30d' }
  If token is stolen (XSS, log leak, network interception): valid for 30 days.
  No logout mechanism (stateless JWT with 30-day TTL = logout doesn't actually work).
  FIX: Short-lived access token (15 minutes) + refresh token (7 days, httpOnly cookie).

VULNERABILITY 8: Returning Token Info in Body That Leaks State (Low)
  return res.json({ token, remaining: 10 - requestCounts[req.ip].count });
  Token should be returned, but "remaining" in success response is unnecessary leakage.
  FIX: Return only { accessToken }.

VULNERABILITY 9: No CAPTCHA or Progressive Delay (Medium)
  No mechanism to slow automated attacks. Each attempt gets instant response.
  EXPLOIT: CPU-efficient automation — try credentials as fast as bcrypt allows (~300ms/attempt).
  FIX: Progressive delay + CAPTCHA after N failures.

VULNERABILITY 10: No Security Headers (Low-Medium)
  No helmet(). No X-Content-Type-Options, X-Frame-Options, etc.
  FIX: app.use(helmet()) as first middleware.
```

---

### Secure Rewrite

```javascript
// ✅ SECURE: auth.js — Fixed version
import express from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import helmet from "helmet";
import { z } from "zod";
import { redis } from "./lib/redis.js";
import { db } from "./lib/db.js";
import { verifyCaptcha } from "./lib/captcha.js";
import { sendAccountLockedEmail, sendUnlockEmail } from "./lib/email.js";
import { createRateLimiter } from "./lib/rate-limiter.js";
import crypto from "crypto";

const app = express();
app.use(helmet());
app.use(express.json({ limit: "10kb", strict: true }));

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET; // 256-bit from Secrets Manager
const JWT_EXPIRY = "15m"; // Short-lived access token
const REFRESH_EXPIRY = 7 * 24 * 60 * 60 * 1000; // 7 days
const DUMMY_HASH = process.env.DUMMY_HASH; // Pre-baked bcrypt hash
const MAX_SOFT_LOCK = 3; // CAPTCHA after 3 failures
const MAX_HARD_LOCK = 5; // Lock after 5 failures
const LOCK_DURATION_MS = 30 * 60_000; // 30-minute lockout
const DELAYS_MS = [0, 0, 1_000, 2_000, 4_000, 8_000]; // Progressive delays

// ─── RATE LIMITERS ─────────────────────────────────────────────────────────
const ipLimiter = createRateLimiter({
  max: 20,
  windowMs: 60_000,
  keyFn: (req) => `rl:ip:login:${req.ip}`,
});

const accountLimiter = createRateLimiter({
  max: 5,
  windowMs: 15 * 60_000,
  keyFn: (req) => {
    const email = String(req.body?.email ?? "")
      .toLowerCase()
      .trim();
    return `rl:acct:login:${crypto.createHash("sha256").update(email).digest("hex").slice(0, 16)}`;
  },
});

// ─── VALIDATION SCHEMA ─────────────────────────────────────────────────────
const LoginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(1024),
  captchaToken: z.string().optional(),
});

function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res
        .status(400)
        .json({ error: "VALIDATION_ERROR", issues: result.error.issues });
    }
    req.validatedBody = result.data;
    next();
  };
}

// ─── LOGIN HANDLER ──────────────────────────────────────────────────────────
async function loginHandler(req, res) {
  const { email, password, captchaToken } = req.validatedBody;
  const normalizedEmail = email.toLowerCase().trim();
  const failKey = `login:fail:${crypto.createHash("sha256").update(normalizedEmail).digest("hex").slice(0, 32)}`;

  // 1. FAILURE COUNT
  const failures = parseInt((await redis.get(failKey)) ?? "0");

  if (failures >= MAX_HARD_LOCK) {
    const ttlMs = await redis.pttl(failKey);
    return res.status(423).json({
      error: "INVALID_CREDENTIALS", // No account enumeration — same error as wrong password
      retryAfterSeconds: ttlMs > 0 ? Math.ceil(ttlMs / 1000) : 0,
    });
  }

  // 2. CAPTCHA GATE
  if (failures >= MAX_SOFT_LOCK) {
    if (!captchaToken || !(await verifyCaptcha(captchaToken, req.ip))) {
      return res.status(400).json({
        error: "CAPTCHA_REQUIRED",
        captchaSiteKey: process.env.HCAPTCHA_SITE_KEY,
      });
    }
  }

  // 3. PROGRESSIVE DELAY
  const delayMs = DELAYS_MS[Math.min(failures, DELAYS_MS.length - 1)];
  if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));

  // 4. AUTHENTICATION (constant-time regardless of user existence)
  const result = await db.query(
    "SELECT id, email, password_hash FROM users WHERE email = $1",
    [normalizedEmail],
  );
  const user = result.rows[0];
  const hashToCompare = user?.password_hash ?? DUMMY_HASH; // FIX: timing attack prevention
  const isValid = await bcrypt.compare(password, hashToCompare);

  if (!user || !isValid) {
    const newFailures = await redis.incr(failKey);
    await redis.pexpire(failKey, LOCK_DURATION_MS);

    if (newFailures === MAX_HARD_LOCK && user) {
      const unlockToken = crypto.randomBytes(32).toString("hex");
      const tokenHash = crypto
        .createHash("sha256")
        .update(unlockToken)
        .digest("hex");
      await db.query(
        "INSERT INTO unlock_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '15 minutes')",
        [user.id, tokenHash],
      );
      await sendAccountLockedEmail(user.email, unlockToken);
    }

    return res.status(401).json({ error: "INVALID_CREDENTIALS" }); // FIX: one error message
  }

  // 5. SUCCESS
  await redis.del(failKey);

  const accessToken = jwt.sign(
    { sub: user.id, email: user.email },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRY, algorithm: "HS256" }, // FIX: short-lived, env secret
  );

  const refreshToken = crypto.randomBytes(64).toString("hex");
  const refreshHash = crypto
    .createHash("sha256")
    .update(refreshToken)
    .digest("hex");
  await db.query(
    "INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '7 days')",
    [user.id, refreshHash],
  );

  res.cookie("refreshToken", refreshToken, {
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    path: "/auth",
    maxAge: REFRESH_EXPIRY,
  });

  return res.json({ accessToken }); // FIX: only accessToken, no internal state leakage
}

// ─── ROUTES ─────────────────────────────────────────────────────────────────
// FIX: ipLimiter → accountLimiter → validation → handler (rate check before bcrypt)
app.post(
  "/auth/login",
  ipLimiter,
  accountLimiter,
  validate(LoginSchema),
  loginHandler,
);

// FIX: password reset also rate limited (same protection)
app.post("/auth/reset-password", ipLimiter, validate(/* ... */), resetHandler);

app.listen(3000);
```

---

### Summary: What Was Fixed

```
Before → After

1. In-memory counters      → Redis sliding window (persistent across deploys/instances)
2. IP-only limits          → IP + per-account failure tracking (both required)
3. "User not found" /      → Always "INVALID_CREDENTIALS" (no account enumeration)
   "Wrong password"
4. No account lockout      → Hard lock at 5 failures + email unlock link
5. Exposed Remaining       → Only expose Limit and Window (not Remaining) on auth endpoints
6. Hardcoded 'secretkey'   → process.env.JWT_SECRET (256-bit, from Secrets Manager)
7. 30-day JWT              → 15-minute access token + 7-day refresh token (httpOnly cookie)
8. Instant 401             → Progressive delay (0→8sec) + CAPTCHA at soft threshold
9. No security headers     → helmet() as first middleware
10. No input validation    → Zod schema enforced before any business logic
```
