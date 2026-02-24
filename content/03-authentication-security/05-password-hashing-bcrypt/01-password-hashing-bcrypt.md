# Password Hashing (bcrypt) — Part 1 of 3

### Sections: 1 (Attacker Intuition), 2 (Why It Exists), 3 (Core Technical), 4 (Attack Flows)

**Series:** Authentication & Security → Topic 05

---

## SECTION 1 — Attacker Intuition

### How an Attacker Thinks About Password Storage

```
"Your database WILL be breached. The question is: what happens to the passwords?"

Attacker's goal: obtain working credentials.
  Not just the passwords for THIS service.
  Credentials for every service that user has an account on.
  (Password reuse is ~60-65% across users — research consistently shows this)

Attacker's thought process after a database dump:
  Option A — plaintext: "I have every password right now. Done."
  Option B — MD5/SHA1: "GPU cracking. 50 billion MD5/second. 8-char passwords: 3 minutes."
  Option C — Unsalted SHA256: "Rainbow tables. Pre-computed. Instant lookup for common passwords."
  Option D — bcrypt cost=10: "~250 hashes/second per GPU. 10M passwords: 11 hours per GPU.
              Not impossible, but the economics are terrible and ROI drops fast."
  Option E — bcrypt cost=12: "~60 hashes/second. 10M passwords: 46 hours per GPU.
              For targeted high-value accounts only."
  Option F — Argon2id (memory-hard): "GPU barely helps. ASIC barely helps.
              Memory bandwidth is the bottleneck. Even nation-state actors struggle at scale."

Attacker's economics:
  Time-to-crack determines whether breach is profitable.
  Short crack time: sell all 10M credentials within hours of breach.
  Long crack time: target only the highest-value accounts (CEOs, admins) — not mass crack.

Password hashing is NOT about making it impossible.
Password hashing is about making it economically unviable at scale.
```

### The Real Threat

```
DATABASE BREACH SCENARIO:
  - 10M user accounts
  - Plaintext passwords stored

  Attacker's execution:
  Day 1: Download database dump (hours via SQL injection or backup file exposure)
  Day 1: Sell complete credential set on dark web: ~$50,000 (market rate for 10M)
  Day 2: Credential stuffing attacks against: Gmail, Amazon, banking apps, Netflix
          using automated tools (OpenBullet, SentryMBA)
  Day 2-7: Account takeovers begin at scale

  REAL FINANCIAL IMPACT:
  Your users' bank accounts, tax refunds, cryptocurrency wallets, Amazon gift cards —
  all at risk because of how YOU stored a password.
  YOUR breach enables financial harm at millions of OTHER services.

  This is why password hashing is an ethical obligation, not just a security feature.
```

---

## SECTION 2 — Why It Exists

### The Evolution of Password Storage (A History of Failures)

```
STAGE 1 — Plaintext (1970s–1990s):
  Storage: password = 'hunter2'
  Breach: immediate. Every account compromised from the dump.
  Why it happened: "Our database is secure. No one will breach us."
  Real example: RockYou (2009) — 32 million passwords in plaintext.
                These 32M passwords ARE the "rockyou.txt" dictionary used in attacks today.
                15 years later, attackers still use this file.

STAGE 2 — MD5 / SHA1 (2000s):
  Storage: hash = md5(password) = '5f4dcc3b5aa765d61d8327deb882cf99' (MD5 of 'password')
  Problem: deterministic. Same password = same hash.
  Problem: design flaw — MD5/SHA1 are fast by design (file verification, checksums).
           "Fast" is the enemy for password hashing.
           Fast hash = fast cracking.

  GPU cracking speed (2024 estimate):
    MD5:  ~70 billion hashes/second (RTX 4090)
    SHA1: ~25 billion hashes/second (RTX 4090)

  An 8-character lowercase+uppercase+digit password has ~218 trillion combinations.
  At 70B/sec: 218 trillion / 70 billion = ~51 minutes.

  Breach → all 8-char passwords cracked within an hour.

STAGE 3 — Salted MD5/SHA1:
  Storage: hash = md5(password + random_salt)
  Fix: prevents rainbow table attacks (pre-computed hash tables).
  Still broken: each password individually brute-forceable at 70B/sec.
  Salt prevents batch attacks. Does NOT fix the speed problem.

STAGE 4 — bcrypt (1999–present):
  Designed by Niels Provos + David Mazières for OpenBSD.
  Key insight: a password hashing function should be DELIBERATELY SLOW.
  Speed: ~250 hashes/second per GPU (cost=10).
  70B/sec vs 250/sec = bcrypt is 280 million times slower than MD5.
  8-char password: 51 minutes (MD5) vs 4.5 million years (bcrypt/cost=10).

STAGE 5 — Argon2id (2015–present):
  Winner: Password Hashing Competition (2015).
  Improvement over bcrypt: memory-hard (GPU/ASIC advantage dramatically reduced).
  Current OWASP recommendation for new systems.
```

### Real Breaches Showing Hashing Differences

```
LinkedIn (2012):
  6.5 million hashed SHA1 passwords (unsalted) leaked.
  Within days: >90% cracked by the community.
  Unsalted SHA1: rainbow tables hit immediately.

Adobe (2013):
  153 million records. 3DES encryption (not hashing — completely wrong concept).
  Passwords were ENCRYPTED, not HASHED.
  Encryption is reversible with the key. Hashing is not.
  The key was in the same system. All passwords decrypted.
  Lesson: encryption is NOT a substitute for hashing.

Dropbox (2012, disclosed 2016):
  68 million bcrypt+SHA1 hashes.
  In 4 years since breach: very few cracked.
  bcrypt worked: breach impact dramatically limited.
  Lesson: proper hashing = breach is survivable.
```

---

## SECTION 3 — Core Technical Deep Dive

### How bcrypt Works Internally

```
bcrypt is based on the Blowfish cipher, adapted for password hashing.

COMPONENTS:
  1. Cost factor (work factor): 2^cost iterations
     cost=10: 2^10 = 1024 iterations
     cost=12: 2^12 = 4096 iterations
     cost=14: 2^14 = 16,384 iterations

  2. Salt: 16 random bytes (128 bits) generated per password.
     Built INTO the bcrypt algorithm — you don't manage it separately.
     The salt is embedded in the output hash string.

  3. Output: 60-character string
     $2b$12$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy
     │   │  │                   │
     │   │  └─ Salt (22 chars)  └─ Hash (31 chars)
     │   └─ Cost factor (12)
     └─ Algorithm version ($2b$ is current)

BCRYPT VERIFICATION PROCESS:
  Stored: $2b$12$<salt>.<hash>
  Input: plaintext password

  1. Extract salt from stored hash (first 22 chars after cost factor)
  2. Run bcrypt(plaintext, extracted_salt, cost=12) → candidate hash
  3. Compare candidate hash with stored hash (constant-time comparison)
  4. Match: password correct

  Key: you NEVER need to see the plaintext password again.
       The salt is stored with the hash. Verification is self-contained.
```

### bcrypt vs Argon2 vs PBKDF2 — Full Comparison

```
┌────────────────┬───────────────────┬───────────────────┬──────────────────────┐
│ Algorithm      │ Speed Control     │ GPU Resistance    │ OWASP Recommendation │
├────────────────┼───────────────────┼───────────────────┼──────────────────────┤
│ MD5 / SHA1     │ None (fast)       │ None — GPU excels │ NEVER use            │
├────────────────┼───────────────────┼───────────────────┼──────────────────────┤
│ bcrypt         │ Cost factor       │ Moderate          │ Acceptable           │
│                │ (CPU time)        │ GPUs help ~4-8×   │ cost ≥ 10            │
│                │                   │ ASIC: ~50× faster │ Legacy/existing apps │
├────────────────┼───────────────────┼───────────────────┼──────────────────────┤
│ PBKDF2         │ Iteration count   │ Low resistance    │ Acceptable with      │
│                │ (HMAC iterations) │ GPU very helpful  │ 310,000 iterations   │
├────────────────┼───────────────────┼───────────────────┼──────────────────────┤
│ scrypt         │ Cost + memory     │ High              │ Acceptable           │
│                │ (N, r, p params)  │ Memory limits GPU │ N=2^17, r=8, p=1    │
├────────────────┼───────────────────┼───────────────────┼──────────────────────┤
│ Argon2id       │ Time + Memory     │ Very high         │ RECOMMENDED          │
│ (PHC winner)   │ + Parallelism     │ Memory-hard       │ For new systems      │
│                │ (t, m, p params)  │ ASIC advantage    │ m=19MiB, t=2, p=1   │
│                │                   │ minimal           │ or m=64MiB, t=1, p=1│
└────────────────┴───────────────────┴───────────────────┴──────────────────────┘

WHY MEMORY-HARDNESS MATTERS:
  GPU cracking: GPU has thousands of cores but limited VRAM per core.
  bcrypt: CPU-bound → GPU gets 4-8× speedup.
  Argon2id: requires significant RAM per hash computation.
  A GPU with 10GB VRAM can compute:
    bcrypt:   ~250 hashes/second/GPU (limited by CPU-like bcrypt computations)
    Argon2id: ~50 hashes/second/GPU (memory bandwidth is the bottleneck)

  But also: the 10GB VRAM is split across all parallel cores.
  If Argon2 needs 64MB per hash: 10,000MB / 64MB = ~156 parallel computations.
  If bcrypt needs 4KB: 10,000,000KB / 4KB = 2.5M parallel computations.
  Memory-hardness dramatically limits GPU parallelism.
```

### Complete Implementation

```javascript
import bcrypt from "bcrypt";

const BCRYPT_COST = 12; // ~300ms per hash on a modern server
// Adjust: target ~100-300ms verification time per your server specs
// Check periodically as hardware improves — may need to increase

// ─────────────────────────────────────────────────────────────────────────────
// REGISTRATION: Hash password before storing
// ─────────────────────────────────────────────────────────────────────────────
async function registerUser(email, plainTextPassword) {
  // 1. Validate password strength BEFORE hashing
  validatePasswordStrength(plainTextPassword); // throws if too weak

  // 2. Hash password (bcrypt auto-generates cryptographic salt)
  const passwordHash = await bcrypt.hash(plainTextPassword, BCRYPT_COST);

  // 3. Store ONLY the hash — NEVER store plaintext
  const user = await db.query(
    "INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id",
    [email, passwordHash],
  );

  // 4. Immediately destroy the plaintext variable (JS garbage collection)
  // (In compiled languages you'd zero-fill the memory; in JS this is best-effort)
  plainTextPassword = null;

  return user.rows[0].id;
}

// ─────────────────────────────────────────────────────────────────────────────
// LOGIN: Verify password against stored hash
// ─────────────────────────────────────────────────────────────────────────────
async function verifyPassword(email, plainTextPassword) {
  const user = await db.query(
    "SELECT id, email, password_hash, account_status FROM users WHERE email = $1",
    [email],
  );

  // TIMING ATTACK PREVENTION:
  // If user not found, run a dummy bcrypt comparison anyway.
  // If we return early on "user not found," response time is: <1ms.
  // If user exists: response time is: ~300ms (bcrypt verification).
  // Timing difference reveals whether an email exists in the system.
  if (!user.rows[0]) {
    // Run bcrypt anyway to normalize response time
    await bcrypt.compare(plainTextPassword, DUMMY_HASH);
    return { success: false, reason: "INVALID_CREDENTIALS" };
  }

  const match = await bcrypt.compare(
    plainTextPassword,
    user.rows[0].password_hash,
  );
  if (!match) {
    return { success: false, reason: "INVALID_CREDENTIALS" };
  }

  if (user.rows[0].account_status === "locked") {
    return { success: false, reason: "ACCOUNT_LOCKED" };
  }

  return { success: true, user: user.rows[0] };
}

// DUMMY_HASH: a pre-computed bcrypt hash to use in timing-safe comparisons
// Run once at startup: bcrypt.hashSync('dummy-value-never-matches', BCRYPT_COST)
const DUMMY_HASH =
  "$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewYpwBAM8nqIHSI6";

// ─────────────────────────────────────────────────────────────────────────────
// PASSWORD UPGRADE: If user has old algorithm (MD5), upgrade on login
// ─────────────────────────────────────────────────────────────────────────────
async function loginWithPossibleUpgrade(email, plainTextPassword) {
  const user = await getUserWithHashAlgorithm(email);

  if (user.hashAlgorithm === "md5_legacy") {
    // Verify with old algorithm
    const legacyMatch = md5(plainTextPassword) === user.passwordHash;
    if (!legacyMatch) return { success: false };

    // Upgrade to bcrypt on the spot (user is authenticated)
    const newHash = await bcrypt.hash(plainTextPassword, BCRYPT_COST);
    await upgradeUserHash(user.id, newHash, "bcrypt");

    return { success: true, user };
  }

  // Normal bcrypt verification
  return verifyPassword(email, plainTextPassword);
}

// ─────────────────────────────────────────────────────────────────────────────
// PASSWORD STRENGTH VALIDATION
// ─────────────────────────────────────────────────────────────────────────────
function validatePasswordStrength(password) {
  const errors = [];

  if (password.length < 12) errors.push("Must be at least 12 characters");
  if (!/[A-Z]/.test(password)) errors.push("Must contain an uppercase letter");
  if (!/[a-z]/.test(password)) errors.push("Must contain a lowercase letter");
  if (!/[0-9]/.test(password)) errors.push("Must contain a number");
  if (!/[^A-Za-z0-9]/.test(password))
    errors.push("Must contain a special character");

  // Check against HaveIBeenPwned API (k-anonymity model — safe to call)
  // (async version would be preferred in production)

  if (errors.length > 0) throw new ValidationError("WEAK_PASSWORD", errors);
}
```

---

## SECTION 4 — Attack Flows

### Attack 1: Rainbow Table Attack on Unsalted Hashes

```
PRECONDITION: Passwords hashed with SHA256 (unsalted).
              Attacker has the database dump.

WHAT A RAINBOW TABLE IS:
  A pre-computed lookup table mapping hash → plaintext.
  Built once, used forever against unsalted hashes.

  Online: crackstation.net maintains 15 billion entries.
  File: passwords123.db — 300GB of chain tables.

STEP 1: Extract password hashes from database.
  user_id | email               | password_hash (SHA256)
  --------+---------------------+------------------------------------------------------------------
  1       | alice@example.com   | 5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8
  2       | bob@example.com     | 9b74c9897bac770ffc029102a200c5de

STEP 2: Look up hash in rainbow table or online service.
  SHA256('password') = 5e884898da...
  Look up: 5e884898da... → "password"   ← found instantly

STEP 3: Alice's password: "password". Bob's hash unrecognized → try other tables/crack.

WITH SALTING:
  hash = SHA256(password + $2a$12$N9qo8uLOickgx2ZMRZoMyeI)   ← salt per user
  Different salt per user = different hash even for same password.
  Pre-computed rainbow tables useless — would need a separate table per unique salt.
  Salt eliminates rainbow table attacks.

WHY bcrypt IS BETTER STILL:
  bcrypt uses a per-user salt (built in) + slow computation.
  Even with the salt, each bcrypt hash takes 300ms to verify.
  To crack one password: average 50% of keyspace = 5M attempts.
  5M × 300ms = 1.5 million seconds = 17 days per password (single CPU thread).
```

### Attack 2: Credential Stuffing Pipeline

```
PRECONDITION: Attacker has "combo list" from previous breach (e.g., RockYou.txt).
              Attacker has your application's login endpoint.

CONTEXT:
  This attack does NOT require cracking your hashes.
  It uses OTHER services' breached plaintext credentials.
  ~65% of users reuse passwords across sites.

STEP 1: Attacker obtains combo list: email:password pairs from unrelated breach.
  Example: Collection#1 (2019) — 773 million unique credentials.

STEP 2: Build automation (OpenBullet config for target site):
  For each (email, password) pair:
    POST /auth/login { "email": ..., "password": ... }
    Check response: 200 with access token = success; 401 = failure

STEP 3: Run against your application.
  At 1000 requests/second (without rate limiting):
  1 billion combo attempts = 11 days.
  Even at 1% success rate: 7.73 million accounts compromised.

SCALE:
  This attack doesn't involve your password hashing at all.
  It's why rate limiting on login endpoints is a separate critical defense.
  But password hashing matters WHEN YOUR OWN database is breached —
  your users' passwords don't go into the attacker's combo lists.

DEFENSE LAYERS:
  1. Rate limiting: 5 attempts per IP per minute (defeats high-speed stuffing).
  2. CAPTCHA after 3 failures.
  3. IP reputation (block known data center IP ranges used by stuffing tools).
  4. MFA: even correct password + correct email → second factor required.
  5. Breach monitoring: check user email against HIBP on login — warn if in breach list.
```
