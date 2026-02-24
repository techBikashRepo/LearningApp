# Login Rate Limiting — Part 1 of 3

### Sections: 1 (Attacker Intuition), 2 (Why It Exists), 3 (Core Technical), 4 (Attack Flows)

**Series:** Authentication & Security → Topic 09

---

## SECTION 1 — Think Like an Attacker First

### The Attacker's Mental Model

Authentication endpoints are high-value targets because **if the login endpoint has no limits, the attacker has unlimited guesses**. Rate limiting is the difference between a brute-force that takes 8 seconds and one that takes 1,300 years.

```
ATTACKER'S CORE INSIGHT:

An unprotected login endpoint is a lock with infinite tries.
Without rate limiting, the attacker has:
  * Unlimited credential stuffing: try every credential pair from breach databases
  * Unlimited brute force: try every password from a wordlist
  * Unlimited enumeration: probe whether emails exist (timing attack)

ATTACKER'S MATH — CREDENTIAL STUFFING:
  Collection #1 breach (2019): 773 million credentials (email + password pairs)
  OpenBullet (free tool): 500 requests/second against a login endpoint

  773M credentials / 500/sec = ~17 days to try every credential.
  Average reuse rate: users reuse passwords on 14+ sites.
  Expected successful logins from 773M credentials against a new site: tens of thousands.

  With rate limiting (10 req/min/IP or 5 failures/account):
  Throughput: 10/min from any single IP → 500 IPs needed to hit 500/sec.
  Most credential stuffing toolkits: a few hundred proxies at most.
  Effective throughput slashed to hundreds/hour.
  773M credentials: 1,300+ years. Attacker moves to easier target.

ATTACKER'S MATH — BRUTE FORCE:
  6-character lowercase password: 26^6 = ~308 million combinations.
  At 1,000 logins/sec (no rate limit): 308,000 seconds = ~3.5 days.
  At 1 login/second (after rate limit): 308,000,000 / 1 = ~9.7 years.
  At 1 login/10 min (account lockout): 308,000,000 × 10 min = 5,863 years.
```

### Dimensions of Defense

```
ATTACKER APPROACHES + SPECIFIC COUNTERS:

1. BRUTE FORCE (one account, try many passwords):
   Counter: Per-account lockout (5 failures → lock)
   Attacker workaround: very slow (1 password/month → bypasses most lockouts)
   Counter-counter: per-account progressive delay even without lockout

2. CREDENTIAL STUFFING (many accounts, each tried with 1-2 known passwords):
   Counter: IP-based rate limit (block IPs after 10 failures/min)
   Attacker workaround: rotate through thousands of residential proxies
   Counter-counter: device fingerprinting, CAPTCHA on suspicious patterns, bot score

3. PASSWORD SPRAYING (few common passwords tried against many accounts):
   Counter: Global rate limit across all accounts from same origin
   Identifies: high failure rate across many different usernames from one IP

4. DISTRIBUTED ATTACK (thousands of IPs, each tries once):
   Counter: Per-account limit regardless of IP (5 global failures per account)
   CAPTCHA on new IPs, behavioral analysis, bot detection ML models

LAYERS NEEDED:
  [ ] Per-IP rate limit (throttle volume per source)
  [ ] Per-account failure counter (detect enumeration of specific accounts)
  [ ] Global anomaly detection (unusual failure spike across all accounts)
  [ ] CAPTCHA on suspicious patterns (bot mitigation)
  [ ] Account lockout or progressive delay
  [ ] Notification to user on many failures
```

---

## SECTION 2 — Why This Exists: The Historical and Technical Problem

### Why Unlimited Login Attempts Are Dangerous

```
HTTP was designed without built-in attempt limiting.
A POST /login endpoint is, by default, callable unlimited times per second.

THE MATH OF WEAK PASSWORDS:
  Most users choose from a limited password space:
    - Top 10,000 passwords cover ~70% of all user accounts (NCSC research).
    - Password "123456" is used by ~23 million users (HaveIBeenPwned data).
    - Single password spray against "123456" alone → millions of successful logins globally.

  If you can try 10,000 passwords per second:
    Top 10K passwords against one account: 1 second.
    Against 1M accounts: still only seconds if parallelized per-account logic runs.

  If limited to 5 attempts per account:
    Attacker can only try: 5 passwords total before lockout.
    Top 5 passwords: "123456", "password", "123456789", "12345678", "12345".
    Coverage: ~5% of user accounts might be broken with 5 guesses.
    Without rate limit: EVERY account vulnerable to automated testing.
```

### Real Incidents

**GitHub 2013 — Brute Force Attack:**

```
Attackers ran a distributed brute force against GitHub login.
Used thousands of compromised servers to avoid single-IP blocking.
GitHub: had rate limiting per IP, but not per account.
Impact: ~250 GitHub accounts compromised before detected.

ROOT CAUSE: No per-account lockout. IP rotation bypassed IP rate limits.
LESSON: Rate limiting must include BOTH per-IP and per-account dimensions.
```

**Snapchat 2014 — API Scraping + Account Enumeration:**

```
Attackers exploited Snapchat's find-friends API.
The API accepted a phone number and returned whether a Snapchat account existed.
No rate limiting. Attackers scraped 4.6 million phone number → username pairs.

ROOT CAUSE: No rate limiting on lookup/enumeration endpoint.
LESSON: Enumeration APIs (check if username/email exists) need rate limiting
        as much as password verification endpoints.
```

**Zoom 2020 — Credential Stuffing (529,000 accounts):**

```
A massive credential stuffing attack against Zoom used credentials from
prior breaches (LinkedIn, Dropbox, etc.) — different service, same user passwords.

The attack:
  1. Downloaded existing credential stuffing lists (email + password from other breaches)
  2. Automated login attempts against Zoom
  3. Successful logins: re-sold accounts on dark web
  4. Some accounts: business meetings, private calls, confidential content

529,000 accounts compromised. Some sold for $0.001–$0.01 each.
Zoom had SOME rate limiting but bot detection was insufficient for residential proxies.

LESSON: Multi-factor authentication would have stopped this ENTIRELY.
        Rate limiting + MFA together: defense in depth.
```

---

## SECTION 3 — Core Technical Deep Dive

### Rate Limiting Algorithms Compared

```
ALGORITHM 1: FIXED WINDOW COUNTER
  How: Count requests per IP per 60-second window. Reset at window boundary.
  Example: window start 12:00:00. Requests: 10 allowed per minute.
           11 requests at 12:00:59: 11th blocked.
           1 request at 12:01:01: new window → allowed regardless.

  PROBLEM (boundary attack):
    Attacker: 10 requests at 12:00:58, 10 requests at 12:01:02.
    Result: 20 requests in 4 seconds — double the intended limit.
    The attacker exploits the window reset.

ALGORITHM 2: SLIDING WINDOW COUNTER
  How: Count requests in a rolling window (last 60 seconds from NOW).
  Every new request: count requests in [now - 60s, now].
  Example: 10 allowed in any 60-second window.
           Attacker: 10 requests at 12:00:58–59.
           Next request at 12:01:01: look back 60s → 12:00:01 to 12:01:01 = 10 requests → blocked.
           At 12:02:00: look back 60s → 12:01:00 to 12:02:00 = 0 requests → allowed.

  ADVANTAGE: No boundary attack. Smooth limit enforcement.
  COST: Requires storing timestamps of recent requests per key.

ALGORITHM 3: TOKEN BUCKET
  How: Bucket holds N tokens. Each request consumes 1 token. Tokens refill at rate R/sec.
  If bucket is empty: request rejected.
  Example: bucket capacity=10, refill rate=1/sec.
           Burst allowed: first 10 requests instantly → then 1/second steady state.

  ADVANTAGE: Allows burst (good UX — first few rapid requests allowed).
  USE CASE: API endpoints where occasional bursts are legitimate.

ALGORITHM 4: LEAKY BUCKET
  How: Requests enter a queue (bucket). Processed at fixed rate R/sec.
       If queue is full: request dropped.

  ADVANTAGE: Smooths out request rate. Good for protecting backend from spikes.
  USE CASE: Downstream service protection (not ideal for login: queued login = bad UX).

ALGORITHM 5: SLIDING LOG (Exact Rate Limiting)
  How: Store timestamp of every request. On each request: count timestamps in window.
  Most accurate but highest memory cost.

RECOMMENDATION FOR LOGIN ENDPOINTS:
  Sliding Window Counter (Redis-based): accurate, scalable, no boundary attack.
  OR: Token Bucket for small burst allowance (login from mobile with slow network).
```

### Redis-Based Sliding Window Rate Limiter

```javascript
// rate-limiter.js — Production Redis sliding window implementation
import { createClient } from "redis";

const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();

/**
 * Sliding window rate limiter using Redis sorted sets.
 * Key: stores set of request timestamps.
 * On each request: remove old entries (outside window), count remaining, add new.
 *
 * @param {string} key - e.g., ip:192.168.1.1 or account:alice@co.com
 * @param {number} max - max requests allowed in window
 * @param {number} windowMs - window size in milliseconds
 * @returns {{ allowed: boolean, remaining: number, retryAfter?: number }}
 */
async function checkRateLimit(key, max, windowMs) {
  const now = Date.now();
  const windowStart = now - windowMs;

  // Atomic block via pipeline (all-or-nothing for consistency):
  const pipeline = redis.multi();

  pipeline.zRemRangeByScore(key, 0, windowStart); // Remove entries before window
  pipeline.zCard(key); // Count remaining
  pipeline.zAdd(key, { score: now, value: `${now}` }); // Add current request
  pipeline.expire(key, Math.ceil(windowMs / 1000) + 1); // TTL: auto-cleanup

  const results = await pipeline.exec();
  const currentCount = results[1] + 1; // After adding current request

  if (currentCount > max) {
    // Calculate when the oldest entry exits the window (retry then)
    const oldestTimestamp = await redis.zRange(key, 0, 0, { withScores: true });
    const retryAfterMs = oldestTimestamp?.[0]?.score
      ? Number(oldestTimestamp[0].score) + windowMs - now
      : windowMs;

    return {
      allowed: false,
      remaining: 0,
      retryAfter: Math.ceil(retryAfterMs / 1000),
    };
  }

  return {
    allowed: true,
    remaining: max - currentCount,
  };
}

// RATE LIMIT MIDDLEWARE FACTORY
function createRateLimiter({
  max,
  windowMs,
  keyFn,
  errorCode = "RATE_LIMITED",
}) {
  return async (req, res, next) => {
    const key = keyFn(req);
    const result = await checkRateLimit(key, max, windowMs);

    // Add rate limit info to response headers (good API citizenship)
    res.setHeader("X-RateLimit-Limit", max);
    res.setHeader("X-RateLimit-Remaining", result.remaining);
    res.setHeader("X-RateLimit-Window", windowMs / 1000);

    if (!result.allowed) {
      res.setHeader("Retry-After", result.retryAfter);
      return res.status(429).json({
        error: errorCode,
        message: "Too many requests",
        retryAfter: result.retryAfter,
      });
    }

    next();
  };
}

// CONFIGURED LIMITERS FOR LOGIN:
export const ipRateLimiter = createRateLimiter({
  max: 20,
  windowMs: 60 * 1000, // 20 requests per minute per IP
  keyFn: (req) => `rl:ip:${req.ip}`,
});

export const accountRateLimiter = createRateLimiter({
  max: 5,
  windowMs: 15 * 60 * 1000, // 5 failures per 15 minutes per account
  keyFn: (req) => `rl:account:${String(req.body.email).toLowerCase().trim()}`,
  errorCode: "ACCOUNT_TEMPORARILY_LOCKED",
});

// APPLY TO LOGIN ROUTE (order matters: IP check first, then account check):
app.post("/auth/login", ipRateLimiter, accountRateLimiter, loginHandler);
```

### Progressive Delays + Account Lockout

```javascript
// login.handler.js — Login with progressive delay and lockout tracking
const FAILURE_LIMITS = {
  softLock: 5, // Trigger CAPTCHA after 5 failures
  hardLock: 10, // Lock account after 10 failures (requires email unlock)
};

const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes
const PROGRESSIVE_DELAYS = [0, 0, 1000, 2000, 4000, 8000, 15000]; // ms per fail count

async function loginHandler(req, res) {
  const { email, password, captchaToken } = req.body;
  const key = `login:failures:${email.toLowerCase()}`;

  // Get current failure count
  const failures = parseInt((await redis.get(key)) || "0");

  // Check if hard-locked
  if (failures >= FAILURE_LIMITS.hardLock) {
    const lockExpiry = await redis.pttl(key);
    return res.status(423).json({
      error: "ACCOUNT_LOCKED",
      message:
        "Account temporarily locked due to too many failed attempts. Check your email.",
      retryAfter: Math.ceil(lockExpiry / 1000),
    });
  }

  // Require CAPTCHA after soft lock threshold
  if (failures >= FAILURE_LIMITS.softLock) {
    if (!captchaToken || !(await verifyCaptcha(captchaToken))) {
      return res.status(400).json({ error: "CAPTCHA_REQUIRED" });
    }
  }

  // Progressive delay: slow down repeated failures
  const delayMs =
    PROGRESSIVE_DELAYS[Math.min(failures, PROGRESSIVE_DELAYS.length - 1)];
  if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));

  // Attempt authentication
  const user = await findUserByEmail(email);
  const dummyHash = await getDummyHash();
  const hashToCheck = user?.passwordHash ?? dummyHash;
  const match = await bcrypt.compare(password, hashToCheck);

  if (!user || !match) {
    // Increment failure counter
    const newCount = await redis.incr(key);
    await redis.pexpire(key, LOCKOUT_DURATION_MS);

    // Send lockout notification email at threshold
    if (newCount === FAILURE_LIMITS.hardLock && user) {
      await sendLockoutEmail(user.email, user.id);
    }

    return res.status(401).json({ error: "INVALID_CREDENTIALS" });
  }

  // Success: reset failure counter
  await redis.del(key);

  // Issue tokens...
  const { accessToken, refreshToken } = await issueTokenPair(user.id);
  res.cookie("refreshToken", refreshToken, {
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    path: "/auth",
  });
  return res.json({ accessToken });
}
```

---

## SECTION 4 — Attack Flows

### Attack Flow 1: Credential Stuffing Without Rate Limiting

```
TOOLS: OpenBullet2 (free, open source), Sentry MBA, Woxy
CREDENTIALS: Collection #1 (773M), Combolist from dark web

ATTACK EXECUTION:
  1. Attacker downloads credential list: 500k email:password pairs for a target industry.
  2. Configures OpenBullet with target: POST https://yourapp.com/auth/login
     Config: email/password body params, success = HTTP 200 with "accessToken" in response.
  3. Loads 50 SOCKS5 proxies (residential proxies: $50-200/month subscription).
  4. Runs: 50 proxies × 10 req/sec each = 500 credentials/second.

WITHOUT RATE LIMITING:
  500k credentials in ~17 minutes.
  Typical success rate: 0.5-2% (credential reuse across breaches).
  500k × 1% = 5,000 valid account logins for the attacker.
  Attacker sells: 5,000 accounts at $5-50 each depending on app.

WITH RATE LIMITING:
  IP-based (20/min per IP): 50 IPs × 20/min = 1000/min = ~8 days for 500k.
  Per-account (5 failures): each account is tried max 5 times then locked.
  CAPTCHA after 3 failures: bot fails CAPTCHA → manual CAPTCHA solving service costs $1/1000.
  500k CAPTCHA solves × $0.001 = $500 additional cost for attacker.
  Attack economics: no longer profitable for $50 account value batch.

Result: Rate limiting shifts the attacker's cost-benefit analysis.
        Attacker moves to easier (unprotected) target.
```

### Attack Flow 2: Password Spraying Bypass via Distributed IPs

```
SCENARIO: A company with 10,000 employee accounts.
          IP rate limit: 20 req/min per IP.
          No per-account failure tracking.

ATTACK (Password Spray):
  Attacker rents 200 residential proxy IPs.
  Each IP tries 10 accounts × 1 time = 10 requests.
  200 IPs × 10 accounts = 2,000 account-password combinations.

  Password list: ["Summer2024!", "Company2024!", "Welcome1!", "Password1!"]
  → 4 passwords × 10,000 accounts = 40,000 combinations total.
  → 200 IPs: 200 combinations/pass → all done in about 200 rounds.
  → Each IP: never exceeds 20 req/min. IP rate limit: never triggered.

  Result: attacker tests 4 passwords against 10,000 accounts.
  Expected success rate for corporate accounts: ~5%
  → 500 valid employee accounts compromised.

WHY IP LIMITING ALONE FAILS:
  Residential proxies: rotating IPs that look like real home users.
  Cost: ~$50/month for 1000 IPs.
  Each IP stays within limit.

CORRECT DEFENSE:
  Per-account failure counter: any IP triggering 5 failed attempts for account X
    → account X locked regardless of which IP tried it.
  Global failure rate monitor: if company sees 500 failures/minute across many accounts:
    → Alert. Trigger CAPTCHA for all login attempts globally.
    → Block detected bot IPs at WAF.
  MFA: even with correct password → second factor blocks access.
```
