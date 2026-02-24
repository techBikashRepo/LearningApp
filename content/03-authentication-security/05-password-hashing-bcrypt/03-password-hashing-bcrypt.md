# Password Hashing (bcrypt) — Part 3 of 3

### Sections: 9 (Interview Prep), 10 (Common Developer Mistakes), 11 (Quick Revision), 12 (Security Thinking Exercise)

**Series:** Authentication & Security → Topic 05

---

## SECTION 9 — Interview Prep: Layered Answers

### Beginner Level

**Q: Why can't we use MD5 or SHA256 to store passwords?**

```
MD5 and SHA256 are designed for SPEED.
A modern GPU can compute 70 billion MD5 hashes per second.
If your database is breached, an attacker can try 70B password guesses per second.
A 10-character lowercase password (26^10 ≈ 1.4 trillion) falls in ~20 seconds.

bcrypt is designed to be SLOW.
With cost=12: ~75 hashes/second/GPU.
Same 10-character password: ~6 months.
The attacker gives up and moves to faster targets.

Speed is a feature for file hashing. Speed is a vulnerability for password hashing.
```

**Q: What is a salt and why does bcrypt include it automatically?**

```
A salt is a random value added to each password before hashing.
Purpose: make every hash unique, even if two users have the same password.

Example WITHOUT salt:
  alice (password: "cat123") → hash: 7a3bc...
  bob   (password: "cat123") → hash: 7a3bc...
  Attacker cracks one → cracks both simultaneously. Builds rainbow tables once for all.

Example WITH salt (bcrypt generates 16 random bytes per password):
  alice (password: "cat123", salt: X9mP...) → hash: $2b$12$X9mP...<hash>
  bob   (password: "cat123", salt: k8Qr...) → hash: $2b$12$k8Qr...<hash>
  Different hashes. Rainbow tables are useless. Each password must be cracked individually.

bcrypt stores the salt IN the hash output (the 22 base64 chars after the cost factor).
You don't manage salts manually. bcrypt.hash() generates and embeds the salt.
bcrypt.compare() extracts the salt from the stored hash automatically.
```

**Q: What is the cost factor in bcrypt?**

```
Cost factor controls how slow bcrypt is. Expressed as an exponent: cost = N means 2^N iterations.
cost=10: 1,024 iterations
cost=12: 4,096 iterations (4× more work than cost=10)
cost=14: 16,384 iterations (4× more work than cost=12)

Higher cost: harder to brute-force after breach. Also slower for your legitimate users.
Target: 100-300ms on your production hardware.
Too low (<8): fast to crack.
Too high (>14 on weak servers): creates DoS risk (login endpoint times out under load).

Tune by benchmarking YOUR hardware. Hardware gets faster every year: revisit annually.
```

---

### Intermediate Level

**Q: How do you migrate 10 million users from MD5 to bcrypt without forcing a password reset?**

```
Lazy migration on next login. No forced reset needed.

PREPARATION:
  1. Add column: hash_algorithm VARCHAR(20) DEFAULT 'bcrypt'
  2. Update existing rows: SET hash_algorithm = 'md5_legacy'
  3. Deploy updated login logic:

LOGIN LOGIC:
  a. Find user by email.
  b. If hash_algorithm = 'md5_legacy':
       Compute md5(entered_password).
       Compare with stored hash.
       If match: IMMEDIATELY bcrypt.hash(entered_password, cost=12).
                 UPDATE users SET password_hash = new_hash, hash_algorithm = 'bcrypt'.
  c. If hash_algorithm = 'bcrypt': normal bcrypt.compare.
  d. Return result.

AFTER 6 MONTHS:
  All active users: bcrypt.
  Remaining md5_legacy: inactive accounts.
  Force password reset for all remaining md5_legacy accounts.
  DELETE all md5_legacy hashes (they're crackable).

RESULT: Zero user disruption. Security improved incrementally.
        Active users get bcrypt hashes within first login after deployment.
```

**Q: What is a timing attack and how does bcrypt.compare help?**

```
TIMING ATTACK ON LOGIN:
  Path A: user email not found → return 401 immediately → <1ms
  Path B: user found, bcrypt.compare runs → return 401 → ~300ms

Attacker sends 1000 login requests with random passwords.
Fast responses: those email addresses DON'T exist.
Slow responses: those email addresses DO exist.
User database enumerated silently without any actual authentication.

DEFENSE — Constant-time path:
  Always run bcrypt.compare, even when user isn't found.
  Use DUMMY_HASH (a pre-computed bcrypt hash) as the target when user is absent.

  const match = await bcrypt.compare(password, user?.hash ?? DUMMY_HASH);

  Both paths now take ~300ms. Attacker cannot distinguish user existence from response time.

bcrypt.compare itself IS timing-safe (constant-time bitwise compare internally).
But you must ensure the CODE PATH leading to bcrypt.compare is also constant-time.
```

---

### Senior/Advanced Level

**Q: How would you implement password hashing in a system with 10M users, offline breach risk, and regulatory compliance?**

```
IMPLEMENTATION:

1. ALGORITHM: Argon2id (preferred) or bcrypt cost=12 minimum.
   Argon2id is memory-hard (resists GPU/ASIC cracking).
   bcrypt is CPU-bound (still solid, widely supported).

2. PEPPER: Server-side secret from AWS Secrets Manager, combined with password before hashing.
   HMAC(password, pepper) → hash with bcrypt/Argon2id.
   DB breach alone: attacker can't crack without pepper.
   Pepper stored separately: compromise requires DB + secrets manager access.

3. TIMING SAFETY: DUMMY_HASH for consistent response time. All paths ~300ms.

4. BREACH DETECTION: HaveIBeenPwned API on registration.
   k-anonymity: SHA1(password) → send first 5 chars → receive ~500 matching hashes.
   Check if full hash is in the list. Password never sent to external service.

5. UPGRADE PATH: If bcrypt.getRounds(stored_hash) < CURRENT_COST on login:
   Freshly re-hash with current cost factor. Update stored hash.
   Cost increases applied to active users automatically over time.

6. MONITORING: CloudWatch alarm on > 100 login failures/minute (credential stuffing detection).
   PCI-DSS: log every authentication attempt (not the password). Retain logs 1 year.

7. RATE LIMITING: 5 failed attempts → progressive delay → account lockout with email unlock.
   IP-based rate limit AND per-account rate limit (different attack vectors).
```

---

## SECTION 10 — 10 Common Developer Mistakes

### Mistake 1: Using MD5, SHA1, or SHA256 for Passwords

```javascript
// WRONG: Fast general-purpose hashes
const hash = crypto.createHash("md5").update(password).digest("hex"); // 70B/sec GPU
const hash = crypto.createHash("sha1").update(password).digest("hex"); // 10B/sec GPU
const hash = crypto.createHash("sha256").update(password).digest("hex"); // 4B/sec GPU

// RIGHT: Slow password-specific hash
const hash = await bcrypt.hash(password, 12); // 75/sec GPU
// Or:
const hash = await argon2.hash(password, { type: argon2.argon2id });
```

### Mistake 2: Missing the Timing Attack Fix

```javascript
// WRONG: Short-circuit on user not found leaks email existence
if (!user) return res.status(401).json({ error: "Invalid credentials" }); // <1ms
const match = await bcrypt.compare(password, user.hash); // <300ms  ← DIFFERENT TIMES

// RIGHT: Always run bcrypt.compare
const hashToCompare = user?.hash ?? DUMMY_HASH; // DUMMY_HASH for absent users
const match = await bcrypt.compare(password, hashToCompare);
if (!user || !match)
  return res.status(401).json({ error: "Invalid credentials" });
```

### Mistake 3: Too Low a Cost Factor

```javascript
// WRONG: Default examples use cost=10 — might be too low for 2025 hardware
const hash = await bcrypt.hash(password, 8); // RTX 4090: ~25,000 hashes/sec
const hash = await bcrypt.hash(password, 10); // RTX 4090: ~300 hashes/sec

// RIGHT: Benchmark first, use cost=12+ minimum for new systems
const hash = await bcrypt.hash(password, 12); // RTX 4090: ~75 hashes/sec (better)
// Argon2id: even better — memory-hard, resists GPU scaling
```

### Mistake 4: Logging the Plaintext Password

```javascript
// WRONG: Express error handlers and logging middleware can capture req.body
app.post("/login", async (req, res) => {
  console.log("Login attempt:", req.body); // { email: ..., password: 'abc123' } IN LOGS!
  // ...
});

// OR: Unhandled exception logger captures error.stack WITH request details:
process.on("uncaughtException", console.error); // might log entire req including password

// RIGHT: Strip sensitive fields before logging
const { password, ...safeBody } = req.body;
console.log("Login attempt:", safeBody); // Only logs email, not password

// Use pino with redact option:
const logger = pino({
  redact: ["req.body.password", "req.body.passwordConfirm"],
});
```

### Mistake 5: Passwords in Query Parameters

```javascript
// WRONG: Password in URL — logged in access logs, browser history, CDN logs, Referer headers
app.get('/auth?email=alice@co.com&password=abc123', ...)
// → Apache: GET /auth?email=alice&password=abc123 200 - logged forever

// RIGHT: Always POST with passwords in request body
// Body is NOT logged by default access log formats (CLF, JSON).
app.post('/auth', (req, res) => { /* req.body.password */ })
```

### Mistake 6: "User Not Found" vs "Wrong Password" Error Messages

```javascript
// WRONG: Different error messages = user enumeration
if (!user) return res.json({ error: "User not found" }); // Reveals email exists
if (!match) return res.json({ error: "Incorrect password" }); // Reveals email DOES exist

// RIGHT: Same message for both cases (combine with timing fix):
if (!user || !match)
  return res.status(401).json({ error: "Invalid email or password" });
// Attacker learns nothing about whether the email is in your system.
```

### Mistake 7: Not Upgrading At Login

```javascript
// WRONG: bcrypt cost stays at original value forever even as hardware advances
async function login(password, storedHash) {
  return bcrypt.compare(password, storedHash); // Uses whatever cost is in the stored hash
  // If hash was created at cost=10 in 2019, stays at cost=10 in 2025. Gradually weakens.
}

// RIGHT: Re-hash if current cost is below target
async function login(password, storedHash, userId) {
  const match = await bcrypt.compare(password, storedHash);

  if (match) {
    const currentCost = bcrypt.getRounds(storedHash);
    if (currentCost < CURRENT_BCRYPT_COST) {
      const newHash = await bcrypt.hash(password, CURRENT_BCRYPT_COST);
      await db.query("UPDATE users SET password_hash = ? WHERE id = ?", [
        newHash,
        userId,
      ]);
    }
  }
  return match;
}
```

### Mistake 8: Blocking the Node.js Event Loop

```javascript
// WRONG: bcrypt.hashSync in synchronous context — blocks entire event loop for ~300ms
app.post("/login", (req, res) => {
  const hash = bcrypt.hashSync(password, 12); // BLOCKS. All other requests wait.
  // ...
});
// 50 concurrent logins: 50 × 300ms in series = 15 SECONDS wait for last user

// RIGHT: Always use async bcrypt
app.post("/login", async (req, res) => {
  const hash = await bcrypt.hash(password, 12); // Non-blocking. Event loop continues.
  // ...
});
// Node.js handles all 50 concurrent logins via event loop. Each runs ~300ms independently.
```

### Mistake 9: Comparing with == Instead of bcrypt.compare

```javascript
// WRONG: Re-hashing and comparing hashes with ==
const newHash = crypto.createHash('sha256').update(password).digest('hex');
if (newHash == user.storedHash) { ... }  // Non-constant-time comparison + wrong algorithm

// ALSO WRONG: Even with bcrypt:
const newHash = await bcrypt.hash(password, 12);
if (newHash === user.storedHash) { ... }  // WRONG: bcrypt generates different hash each time!
                                          // Two bcrypt hashes of the same password NEVER match.
                                          // bcrypt.compare extracts the salt from storedHash.

// RIGHT: Always use bcrypt.compare (not hash comparison)
const match = await bcrypt.compare(password, user.storedHash);  // Correct
```

### Mistake 10: Encrypting Passwords Instead of Hashing

```javascript
// WRONG: AES encryption for passwords (reversible)
const cipher = crypto.createCipheriv("aes-256-gcm", KEY, IV);
const encrypted = cipher.update(password, "utf8", "hex");
// → "We can decrypt if the user forgets their password!"
// → Also: if KEY is ever exposed, ALL passwords decryptable instantly.
// → Adobe 2013: same mistake. 153M users compromised simultaneously.

// RIGHT: One-way bcrypt hash (irreversible)
const hash = await bcrypt.hash(password, 12);
// Forgot password? → Send password RESET LINK. Not the password.
// You never need to know the original password. Hash comparison is enough.
```

---

## SECTION 11 — Quick Revision

### 10 Key Takeaways

1. **Speed is the enemy**: MD5 = 70B/sec GPU. bcrypt cost=12 = 75/sec GPU. Same hardware, 1-billion-times difference.

2. **bcrypt = hash + salt + cost in one call**: `bcrypt.hash(password, cost)` → random salt generated, embedded in output. You don't manage salts.

3. **Cost factor = 2^N iterations**: cost=12 → 4,096 iterations. Increase by 1 → 2× more work. Benchmark to 100-300ms on your server.

4. **Always use `bcrypt.compare()`**: Two bcrypt hashes of the same password are different. Compare extracts salt from stored hash internally.

5. **DUMMY_HASH prevents timing attack**: User-not-found path must also run bcrypt. Otherwise: response time reveals email existence.

6. **Same error message**: "Invalid email or password" — never distinguish between "not found" and "wrong password" in responses.

7. **Async only in Node.js**: `bcrypt.hashSync()` blocks the event loop for ~300ms. With 50 concurrent logins: 15 seconds. Use `await bcrypt.hash()`.

8. **Passwords are never stored**: Only the bcrypt hash. No encryption (reversible). No MD5 (fast). No SHA256 (fast). bcrypt (slow, correct).

9. **Lazy migration for legacy hashes**: On successful MD5/SHA1 login → immediately re-hash with bcrypt → update stored hash. Zero user disruption.

10. **Argon2id for new systems**: More modern than bcrypt, memory-hard (resists GPU/ASIC), no 72-character truncation limit. OWASP's first recommendation.

---

### 30-Second Interview Answer

**"How do you store passwords securely?"**

```
"I never store passwords — only their bcrypt hashes with cost factor 12 or higher.
bcrypt is deliberately slow: ~300ms per hash, which makes offline brute-forcing impractical
after a DB breach.

bcrypt automatically handles salting: each hash gets a unique random salt,
so identical passwords produce different hashes, ruling out rainbow tables.

For login, I use bcrypt.compare — never hash-matching — since bcrypt generates
unique hashes every time. I also apply the DUMMY_HASH pattern: run bcrypt.compare
even when the user doesn't exist, so response time is identical for all login outcomes,
preventing email enumeration via timing.

For new systems I prefer Argon2id — it's memory-hard and OWASP's top recommendation."
```

---

### Mnemonics

```
SLOW (Why bcrypt):
  S — Salt (built-in, per-password, random)
  L — Load factor (cost = computational work, 2^N iterations)
  O — One-way (irreversible — cannot decrypt a hash)
  W — Work over time (increase cost as hardware improves)

SALT (bcrypt properties):
  S — Salt auto-generated (you don't manage it)
  A — Adaptive (cost factor adjustable)
  L — Logged in hash ($2b$12$<salt><hash>)
  T — Timing safe + Truncation warning (72-char limit)

PEPPER (optional hardening):
  P — Pepper is a server-side secret
  E — External to database (different breach vector)
  P — Pre-hashing: applied before bcrypt
  E — Extra layer: DB dump alone insufficient to crack
  R — Rotation: use Secrets Manager versioning
```

---

## SECTION 12 — Security Thinking Exercise

### Scenario: AuthGuard SaaS

A security review of a startup's authentication service reveals the following code:

```javascript
// auth.service.js
import crypto from "crypto";
import bcrypt from "bcrypt";

const BCRYPT_COST = 6; // "Faster logins = better UX" — Engineering team note

async function registerUser(email, password) {
  const hash = await bcrypt.hash(password, BCRYPT_COST);
  await db.insert("users", { email, password_hash: hash });
}

async function loginUser(req, res) {
  const { email, password } = req.body;

  console.log(`Login attempt: email=${email}, password=${password}`); // For debugging

  const user = await db.query("SELECT * FROM users WHERE email = ?", [email]);

  if (!user) {
    return res.status(401).json({ message: "Email not found." });
  }

  const rounds = bcrypt.getRounds(user.password_hash);
  const match = await bcrypt.compare(password, user.password_hash);

  if (!match) {
    return res.status(401).json({ message: "Wrong password." });
  }

  if (rounds < 10) {
    const newHash = await bcrypt.hash(password, 10); // "Upgrade if we remember"
    db.query("UPDATE users SET password_hash = ? WHERE id = ?", [
      newHash,
      user.id,
    ]);
    // Note: fire-and-forget (no await), not critical
  }

  const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, {
    expiresIn: "30d",
  });
  return res.json({ token });
}
```

---

### Your Task

**Identify every security problem and explain the impact. Then rewrite the service correctly.**

---

### Analysis: Problems Found

```
PROBLEM 1: BCRYPT_COST = 6 (CRITICAL)
  Cost=6 → 2^6 = 64 iterations.
  Modern GPU: ~300,000 bcrypt-cost-6 hashes/second.
  10M user database breach: 10M passwords cracked in ~30 seconds per 10M wordlist item.
  Entire rockyou.txt (14M passwords): ~47 seconds to try against entire user base.
  Impact: Database breach → most common passwords cracked almost immediately.

PROBLEM 2: Logging plaintext password (CRITICAL)
  console.log(`password=${password}`) → plaintext passwords in log files.
  Log files: often shipped to Datadog, Splunk, CloudWatch Log Groups.
  Log access is broader than DB access. SRE team, on-call engineers, log aggregation services.
  Impact: Passwords visible to anyone with log access.
  PCI-DSS violation. GDPR breach notification required if logs were accessed.

PROBLEM 3: Different error messages (HIGH)
  "Email not found" vs "Wrong password" → user enumeration.
  Attacker learns which emails exist in your system.
  Enables targeted phishing. Enables credential stuffing (confirmed active accounts).
  OWASP Authentication Cheat Sheet: always return identical errors.

PROBLEM 4: Timing attack (HIGH)
  "Email not found" path: <1ms (no bcrypt).
  "Wrong password" path: ~300ms (bcrypt runs).
  Response time reveals email existence without reading error messages.
  Fix: always run bcrypt.compare using DUMMY_HASH for absent users.

PROBLEM 5: Cost upgrade is fire-and-forget (MEDIUM)
  db.query() without await → unhandled promise rejection if update fails.
  Upgrade also only runs if rounds < 10, but BCRYPT_COST is 6 — so it would upgrade.
  But: without await, request completes before upgrade. If process exits, upgrade lost.
  Fix: await the update, log failure, don't block login return.

PROBLEM 6: 30-day JWT (MEDIUM)
  Not directly related to password hashing but in the same service.
  30-day access tokens → long window if compromised.
  Covered in JWT section — should be AT (15min) + RT (7 days with rotation).
```

---

### Secure Rewrite

```javascript
// auth.service.js — SECURE VERSION
import bcrypt from "bcrypt";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

const BCRYPT_COST = 12; // Benchmarked: ~280ms on our t3.medium instances
let DUMMY_HASH = null; // Pre-computed once at startup

// STARTUP: pre-compute dummy hash to prevent timing attacks
async function initialize() {
  DUMMY_HASH = await bcrypt.hash("__dummy__never__matches__", BCRYPT_COST);
  console.log("Auth service initialized. DUMMY_HASH ready.");
}

async function registerUser(email, rawPassword) {
  // 1. Validate password strength (not shown — see Section 3)
  // 2. Check HaveIBeenPwned (optional, privacy-preserving)

  const hash = await bcrypt.hash(rawPassword, BCRYPT_COST);

  await db.insert("users", { email, password_hash: hash });

  // rawPassword goes out of scope. GC handles it. Never logged.
}

async function loginUser(req, res) {
  const { email, password } = req.body;

  // NEVER log password. Log only the email (if even that is acceptable under your policy).
  logger.info({ event: "login_attempt", email });

  const user = await db.query(
    "SELECT id, password_hash FROM users WHERE email = $1",
    [email],
  );
  // Select ONLY needed fields — not SELECT *

  // Timing-safe: always run bcrypt.compare, even if user not found
  const hashToCompare = user ? user.password_hash : DUMMY_HASH;
  const match = await bcrypt.compare(password, hashToCompare);

  // SAME error for both: user not found AND wrong password
  if (!user || !match) {
    logger.warn({ event: "login_failed", email });
    return res.status(401).json({ error: "INVALID_CREDENTIALS" });
  }

  // Upgrade cost factor on login if below current target
  const storedCost = bcrypt.getRounds(user.password_hash);
  if (storedCost < BCRYPT_COST) {
    const upgradedHash = await bcrypt.hash(password, BCRYPT_COST);
    await db.query("UPDATE users SET password_hash = $1 WHERE id = $2", [
      upgradedHash,
      user.id,
    ]);
    logger.info({
      event: "password_hash_upgraded",
      userId: user.id,
      from: storedCost,
      to: BCRYPT_COST,
    });
  }

  logger.info({ event: "login_success", userId: user.id });

  // Issue short-lived AT + long-lived RT (see Topic 04)
  const { accessToken, refreshToken } = await issueTokenPair(user.id);

  res.cookie("refreshToken", refreshToken, {
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    path: "/auth",
  });
  return res.json({ accessToken });
}

export { initialize, registerUser, loginUser };

// CHANGES MADE:
// 1. BCRYPT_COST: 6 → 12  (cracking time: seconds → months)
// 2. console.log removed  (passwords never in logs)
// 3. Error messages unified  (no user enumeration)
// 4. DUMMY_HASH timing attack fix  (consistent ~300ms for all paths)
// 5. await on hash upgrade  (no fire-and-forget, no lost upgrades)
// 6. SELECT only required fields  (not SELECT *)
// 7. AT + RT instead of 30-day JWT  (short-lived access, rotatable refresh)
```
