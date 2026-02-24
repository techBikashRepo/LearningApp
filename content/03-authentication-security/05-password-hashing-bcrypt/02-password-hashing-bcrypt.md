# Password Hashing (bcrypt) — Part 2 of 3

### Sections: 5 (Defense Mechanisms), 6 (Architecture Diagram), 7 (Production Scenarios), 8 (AWS Mapping)

**Series:** Authentication & Security → Topic 05

---

## SECTION 5 — Defense Mechanisms

### Defense 1: Choosing the Right Cost Factor

```javascript
// Cost factor calibration: target ~100-300ms on your server hardware.
// Too low: fast cracking after breach.
// Too high: login endpoint becomes a DoS vector (slow your own server).

// Run this benchmark on YOUR specific server to find the right cost:
async function calibrateBcryptCost() {
  let cost = 10; // Start here

  while (cost <= 16) {
    const start = Date.now();
    await bcrypt.hash("benchmark-password-8chars", cost);
    const elapsed = Date.now() - start;

    console.log(`cost=${cost}: ${elapsed}ms`);

    if (elapsed >= 100 && elapsed <= 300) {
      console.log(`✓ Recommended cost: ${cost}`);
      return cost;
    }

    cost++;
  }
}

// OWASP 2024 recommendations:
//   bcrypt:    cost ≥ 10 (minimum), prefer 12+ if server handles the load
//   Argon2id:  m=19456 (19 MiB), t=2, p=1
//   PBKDF2:    310,000 iterations with SHA-256 (FIPS-compliant environments)
//   scrypt:    N=32768, r=8, p=1 (older recommendation)

// Hardware-based cost increase schedule:
// Revisit annually. If login time falls below 100ms: increase cost.
// Hardware doubles in speed every ~2 years → increase cost by 1 every 2 years
// to maintain constant work time.

// Cost factor vs operations/second (approximate, RTX 4090):
// cost=10: ~300 hashes/sec/GPU
// cost=12: ~75 hashes/sec/GPU
// cost=14: ~19 hashes/sec/GPU
// cost=16: ~5 hashes/sec/GPU
```

### Defense 2: Constant-Time Comparison and Timing Attack Prevention

```javascript
// TIMING ATTACK:
// If you short-circuit on "user not found" — response in <1ms.
// If user exists, bcrypt.compare runs — response in ~300ms.
// Attacker sends 1000 requests per email → fast response = email doesn't exist.
// Enumerates user base silently.

// WRONG APPROACH (timing leak):
async function badLogin(email, password) {
  const user = await findByEmail(email);
  if (!user) return res.status(401).json({ error: "Invalid" }); // <1ms response!

  const match = await bcrypt.compare(password, user.hash); // ~300ms response
  if (!match) return res.status(401).json({ error: "Invalid" });
  // ...
}
// Timing difference: attacker discovers which emails exist in your system.
// Your user list has value on dark web. Enables targeted phishing.

// CORRECT APPROACH (constant time):
const DUMMY_HASH = await bcrypt.hash("__dummy__never__matches__", 12);

async function goodLogin(email, password) {
  const user = await findByEmail(email);

  const hashToCheck = user?.passwordHash ?? DUMMY_HASH;
  const match = await bcrypt.compare(password, hashToCheck);

  // Even if user doesn't exist, bcrypt.compare still runs (~300ms).
  // Response time: always ~300ms regardless of email existence.
  // Timing is now identical for all login outcomes.

  if (!user || !match) {
    return { success: false }; // Same error for both: user not found AND wrong password
  }

  return { success: true, user };
}

// ALSO: Use crypto.timingSafeEqual for your own string comparisons
import { timingSafeEqual } from "crypto";

function safeStringCompare(a, b) {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");

  if (bufferA.length !== bufferB.length) {
    // Compare against a dummy to avoid early return timing leak
    timingSafeEqual(bufferA, Buffer.alloc(bufferA.length));
    return false;
  }
  return timingSafeEqual(bufferA, bufferB);
}
```

### Defense 3: Migrating Legacy Hashes Without Disruption

```
PROBLEM: You have 10M users with MD5/SHA1 hashes.
         You cannot re-hash them without their plaintext passwords.
         You cannot ask 10M users to change their password immediately.

SOLUTION: Double-hash on the fly (lazy migration)

STEP 1: Add column: hash_algorithm (default 'bcrypt')
        Existing rows: hash_algorithm = 'md5_legacy'

STEP 2: At login:
  If hash_algorithm == 'bcrypt': normal bcrypt.compare (new path)
  If hash_algorithm == 'md5_legacy':
    a. Verify: md5(password) === stored_hash? If yes: authenticated.
    b. On successful auth: IMMEDIATELY hash plaintext with bcrypt.
    c. UPDATE users SET password_hash = bcrypt_hash, hash_algorithm = 'bcrypt'
    d. User now has bcrypt next time.

STEP 3: 6 months later: all active users now have bcrypt hashes.
        Remaining 'md5_legacy' accounts: users who haven't logged in.
        Force password reset for them (security + cleanup).

ALTERNATIVE DOUBLE-HASH (if you CAN'T get plaintext):
  bcrypt(MD5(legacy_password)) — wrapping the existing hash

  new_hash = bcrypt(existing_md5_hash)

  On login:
  candidate_md5 = MD5(user_input_password)
  verify: bcrypt.compare(candidate_md5, stored_bcrypt_of_md5)

  Tradeoff: MD5 output is now the "password" input to bcrypt.
  MD5 is still in the pipeline but bcrypt wraps it — cracking now requires
  bcrypt time × the md5 keyspace. Still vastly better than naked MD5.
```

### Defense 4: Peppers (Optional Hardening)

```javascript
// SALT vs PEPPER:
// Salt: random per-password value stored WITH the hash (visible in DB dump)
// Pepper: secret random value stored OUTSIDE the database (e.g., secrets manager)

// With salt only: if DB is breached, attacker can crack offline (slow due to bcrypt)
// With pepper: if DB is breached, attacker ALSO needs the pepper to crack.
//              Pepper is stored separately → in a DB-only breach, attacker can't crack.
//              Even knows the hash algorithm and cost → useless without the SECRET pepper.

const PEPPER = process.env.PASSWORD_PEPPER; // 32-byte random from Secrets Manager
// NEVER in the database. NEVER in code.

async function hashWithPepper(plainTextPassword) {
  // Apply pepper before bcrypt
  const pepperedPassword = plainTextPassword + PEPPER;
  return bcrypt.hash(pepperedPassword, BCRYPT_COST);
}

async function verifyWithPepper(plainTextPassword, storedHash) {
  const pepperedPassword = plainTextPassword + PEPPER;
  return bcrypt.compare(pepperedPassword, storedHash);
}

// TRADEOFFS:
// Benefit: DB dump alone is useless. Attacker needs DB + pepper.
// Risk: if pepper changes (rotation) — all passwords need re-hashing at next login.
// Risk: if pepper is lost — all passwords permanently unverifiable (catastrophic).
// Mitigation: store pepper in Secrets Manager with versioning + never delete old versions.

// PRODUCTION TIP:
// bcrypt's output embeds the salt but not the pepper.
// If you rotate the pepper, you must store the pepper version with the hash,
// and use the correct pepper version for verification.
// Complexity is real — weigh benefits vs operational risk.
```

---

## SECTION 6 — Architecture Diagram

```
PASSWORD HASHING ARCHITECTURE — REGISTRATION + LOGIN FLOW

REGISTRATION:
┌───────────┐  POST /register    ┌──────────────────────────────────────────────┐
│  Client   │──────────────────→ │           Application Server                │
│           │  { email,          │                                              │
│           │    password }      │  1. validatePasswordStrength(password)       │
│           │                    │     ↳ length, complexity, HIBP check         │
│           │                    │                                              │
│           │                    │  2. bcrypt.hash(password + pepper, cost=12)  │
│           │                    │     ↳ generates random salt internally       │
│           │                    │     ↳ ~300ms computation                     │
│           │                    │     ↳ returns: $2b$12$<salt><hash>           │
│           │                    │                                              │
│           │                    │  3. INSERT users (email, password_hash)      │
│           │                    │     password field: NEVER stored             │
│           │  201 Created       │                                              │
│           │  { userId } ←───── │  4. password = null (destroy reference)     │
└───────────┘                    └──────────────────────────────────────────────┘

LOGIN:
┌───────────┐  POST /login       ┌───────────────────────────────────────────────┐
│  Client   │──────────────────→ │          Application Server                  │
│           │  { email,          │                                               │
│           │    password }      │  1. SELECT user WHERE email = ?               │
│           │                    │  2. If not found:                             │
│           │                    │       bcrypt.compare(password, DUMMY_HASH)    │
│           │                    │       → ~300ms (timing attack prevention)     │
│           │                    │       return 401 INVALID_CREDENTIALS          │
│           │                    │                                               │
│           │                    │  3. If found:                                 │
│           │                    │       bcrypt.compare(                         │
│           │                    │         password + pepper,                    │
│           │                    │         user.password_hash                    │
│           │                    │       ) → ~300ms                              │
│           │                    │                                               │
│           │                    │  4. Match: issue session/token pair           │
│           │                    │     No match: increment fail_count             │
│           │                    │               lock after N failures →         │
│           ← 200 + auth cookie ─│               force unlock via email          │
└───────────┘ (or 401)           └───────────────────────────────────────────────┘
                                                   │
                                                   ↓
                                         ┌──────────────────────┐
                                         │  AWS Secrets Manager  │
                                         │  /app/password-pepper │
                                         │  /app/dummy-hash      │
                                         └──────────────────────┘

UPGRADE ON LOGIN (MD5 legacy accounts):
  bcrypt.compare fails on legacy hash → detect algorithm → try MD5 → success
  → immediately bcrypt.hash(password, cost=12) → UPDATE users SET password_hash = new
  → future logins: bcrypt only.
```

---

## SECTION 7 — Production Scenarios

### Scenario 1: The "We'll Encrypt It" Design Meeting Mistake

**Context:** Engineering team meeting, schema design phase.

```
Engineer A: "We need to store passwords. Let's use AES-256 encryption."
Security Engineer: "Why not hashing?"
Engineer A: "We need to recover passwords for the 'forgot password, email me my password' feature."

THIS IS THE WORST POSSIBLE DESIGN.

PROBLEMS WITH ENCRYPTION FOR PASSWORDS:
  1. "Email me my password" = you are storing retrievable passwords = catastrophic breach risk.
     The encryption KEY is in your system. DB breach + key extraction = all passwords exposed.

  2. Correct design: You should NEVER know the user's password after registration.
     Forgot password flow: email a TIME-LIMITED password RESET LINK, not the password.

  3. If multiple users have the same password: AES gives different ciphertext (with IV).
     Good. But bcrypt gives different hash (with salt). Same property.
     Encryption's "advantage" doesn't exist here.

  4. Keys must be managed, rotated, secured. If key is compromised: all passwords decryptable.
     bcrypt breach: attacker must crack each hash individually (300ms each).
     AES breach: attacker decrypts entire table in seconds.

WHAT HAPPENED (similar real-world incident: Adobe 2013):
  Adobe used 3DES (reversible encryption) on 153 million passwords.
  The encryption key was in the same system (~normal for operational reasons).
  Breach: 153 million passwords decrypted. All users compromised simultaneously.
  bcrypt: even after breach, individual cracking required. Most never cracked.

CORRECT DESIGN:
  Storage: bcrypt hash. You cannot reverse it. Neither can the attacker.
  Forgot password: send a one-time reset link. Expires in 1 hour. Signed. Single-use.
  The user resets their own password. You never need to know their original password.
```

### Scenario 2: bcrypt 72-Character Truncation Bug

**Context:** A real bcrypt limitation that causes silent security failures.

```
BCRYPT TECHNICAL LIMITATION:
  bcrypt was designed in 1999 for password inputs.
  Maximum input: 72 bytes. Anything beyond 72 bytes is SILENTLY TRUNCATED.

PASSWORD IMPACT:
  User sets password: "correct horse battery staple renewable energy california sunshine!"
  → 68 characters. Fine.

  User sets password: 80-character passphrase.
  bcrypt hashes only the first 72 characters.
  Later: user logs in with different 80-char passphrase but IDENTICAL first 72 chars.
  bcrypt.compare: MATCH. Login succeeds with a "wrong" password.

  Worse: attacker who knows the first 72 chars can try all 8-char suffixes.
  Effective keyspace for 80-char password: 8 chars (not 80).

  YOUR PASSWORD POLICY SAYS: "Max 128 characters."
  bcrypt: "I only check the first 72." — silently.

SOLUTIONS:
  Option 1: Limit passwords to 72 bytes (clear in UI) — awkward UX

  Option 2: Pre-hash before bcrypt (with SHA-512)
    const sha = crypto.createHash('sha512').update(password).digest('base64');
    // sha is always 88 bytes (base64 of 64 bytes)
    // But: this is still <72 bytes... wait.
    // SHA-512 digest is 64 bytes. base64 of 64 bytes = 88 bytes.
    // 88 > 72. We need the raw bytes: sha is 64 bytes raw. That's WITHIN 72.

    const sha = crypto.createHash('sha512').update(password).digest();  // Buffer, 64 bytes
    return bcrypt.hash(sha.toString('base64').slice(0, 60), cost);  // 60 base64 chars < 72
    // OR: use a hash that produces ≤ 72 bytes

  Option 3: Use Argon2id instead (no length limitation)
    import argon2 from 'argon2';
    const hash = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 2**16 });
    // No truncation. Handles arbitrary length passwords.
    // Recommended for new systems: just use Argon2id and skip this problem entirely.
```

---

## SECTION 8 — AWS Mapping

### AWS Services for Password Security

```
┌──────────────────────────┬─────────────────────────────────────────────────────┐
│ AWS Service              │ Role in Password Hashing                            │
├──────────────────────────┼─────────────────────────────────────────────────────┤
│ Cognito User Pools       │ Manages password hashing internally                │
│                          │ Uses SRP (Secure Remote Password) + bcrypt         │
│                          │ You never touch the password hash                   │
│                          │ Built-in: password policies, breach notifications  │
├──────────────────────────┼─────────────────────────────────────────────────────┤
│ AWS Secrets Manager      │ Store password pepper value                        │
│                          │ Store dummy_hash for timing-safe comparisons       │
│                          │ Auto-rotation: custom Lambda for pepper rotation   │
├──────────────────────────┼─────────────────────────────────────────────────────┤
│ AWS KMS                  │ If using PBKDF2: use KMS for key derivation        │
│                          │ Envelope encryption: KMS encrypts the pepper        │
├──────────────────────────┼─────────────────────────────────────────────────────┤
│ RDS Aurora               │ Stores hashed passwords (NEVER plaintext)          │
│                          │ Encryption at rest: AES-256 (KMS-managed keys)     │
│                          │ Field-level encryption optional for extra defense  │
├──────────────────────────┼─────────────────────────────────────────────────────┤
│ IAM + VPC                │ Application servers: only they can call DB         │
│                          │ No direct access to password_hash column from      │
│                          │ analytics tools, read replicas, external services  │
├──────────────────────────┼─────────────────────────────────────────────────────┤
│ CloudWatch               │ Alert on dump-like patterns:                       │
│                          │ SELECT * FROM users WHERE ... (no WHERE clause)    │
│                          │ Alert: query results > 10,000 rows from one query  │
│                          │ RDS Enhanced Monitoring for query analysis         │
├──────────────────────────┼─────────────────────────────────────────────────────┤
│ AWS GuardDuty            │ Detect: unusual bulk data access                   │
│                          │ Detect: access from unusual IPs to RDS             │
│                          │ Detect: calls from outside VPC (if misconfigured)  │
└──────────────────────────┴─────────────────────────────────────────────────────┘
```

### Lambda Function for bcrypt Verification (Serverless Context)

```javascript
// AWS Lambda consideration: concurrency vs bcrypt cost

// bcrypt cost=12 ≈ 300ms per verification
// Lambda: billed per 100ms × memory
// Implication: login Lambda should have adequate memory to prevent slow downs

// Lambda function config for auth service:
const loginLambdaConfig = {
  FunctionName: "AuthService-Login",
  Runtime: "nodejs20.x",
  MemorySize: 1024, // Higher memory = more CPU = faster bcrypt
  Timeout: 10, // Must exceed bcrypt time (300ms + DB query + network)
  // DO NOT use 128MB default: bcrypt is CPU-bound, will timeout at cost=12 with 128MB

  // Concurrency consideration:
  // Each Lambda invocation: one bcrypt call = ~300ms = unavailable for 300ms.
  // 1000 concurrent login requests: need 1000 Lambda instances.
  // Reserved concurrency for auth: set to max expected concurrent logins.
};

// Handler:
export const handler = async (event) => {
  const { email, password } = JSON.parse(event.body);

  // Input validation first (fail fast, cheap)
  if (!email || !password || password.length > 72 || password.length < 8) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "INVALID_INPUT" }),
    };
  }

  // Retrieve pepper from cache or Secrets Manager
  const pepper = await getSecret("password-pepper");

  // bcrypt verification with timing-safe behavior
  const result = await verifyPassword(email, password + pepper);

  if (!result.success) {
    return {
      statusCode: 401,
      body: JSON.stringify({ error: "INVALID_CREDENTIALS" }),
    };
  }

  // Issue tokens...
};
```
