# JWT Authentication — Part 3 of 3

### Sections: 9 (Interview Prep), 10 (Common Developer Mistakes), 11 (Quick Revision), 12 (Security Thinking Exercise)

**Series:** Authentication & Security → Topic 03

---

## SECTION 9 — Interview Preparation

### Beginner Questions

**Q1: What is a JWT and what does it contain?**

```
JWT = JSON Web Token. RFC 7519.
A self-contained, cryptographically signed token that carries user claims.

Structure: three base64url-encoded parts separated by dots:
  HEADER.PAYLOAD.SIGNATURE

Header: algorithm + token type + optional key ID (kid)
  { "alg": "RS256", "typ": "JWT", "kid": "key-2025" }

Payload: claims about the user
  Registered: sub (user id), iss (issuer), aud (audience), exp (expiry), iat (issued at)
  Custom: role, tenant_id, email, permissions

Signature: cryptographic proof that header+payload haven't been modified.
  RS256: signed with private key, verified with public key.
  Anyone can READ the payload — it's just base64url (not encrypted).
  Only the signature holder can modify the payload legitimately.

Key practical point:
  Never store passwords, credit card numbers, SSNs in JWT payload.
  Anyone who captures the token can decode and read the payload (base64url decode is trivial).
  JWT provides integrity (tamper-proof), not confidentiality (secret).
```

**Q2: Why is JWT preferred over sessions in microservices?**

```
SESSION PROBLEM:
  Sessions require a central shared store.
  ServiceA creates session → ServiceA must validate it.
  ServiceB receives a request → must call ServiceA (or access shared Redis) to validate.
  This creates network dependency, single point of failure, and added latency.

JWT SOLUTION:
  Token is self-contained and cryptographically verifiable.
  Any service with the public key can verify the JWT signature independently.
  No network call to an auth service.
  No shared database.

Practical advantage:
  50 microservices. Each receives JWTs.
  Each verifies the signature locally (public key already loaded at startup).
  Auth service is NOT in the request path after token issuance.

Tradeoff:
  Sessions: instant revocation (delete from store).
  JWT: no revocation by default. Must wait for exp or maintain a revocation blocklist.
```

---

### Intermediate Questions

**Q1: How do you handle JWT revocation given JWTs are stateless?**

```
THE PROBLEM:
  JWTs are verify-without-lookup. There's no "session record" to delete.
  User logs out → access token still technically valid until it expires.
  User account banned → JWT with valid claims still accepted.

STRATEGIES:

1. Short expiry (15 minutes) + refresh token rotation:
   Access token: 15 minutes → maximum window of post-logout validity.
   User logout: delete refresh token from DB → user cannot get a new access token.
   Attacker who stole the access token: has at most 15 minutes.
   Tradeoff: 15-minute window of exposure is acceptable for most apps.

2. JTI blocklist (Redis):
   On revocation (logout, ban, password change):
   Redis: SET jti:uuid 'revoked' EX <seconds_until_token_expiry>
   On every token verification: check if jti exists in Redis blocklist.
   If found: reject immediately.
   Tradeoff: Re-introduces statefulness. Redis is now in the critical path.
   The TTL equals the token's remaining lifetime → no growing list problem.

3. Token versioning:
   User record has: token_version INT (default 0).
   JWT carries: tv claim = current token_version at issuance.
   On security event (password change, suspicious activity): increment token_version.
   On verification: compare jwt.tv with db.user.token_version.
   Mismatch → reject token.
   Tradeoff: one DB lookup per request (partial statefulness). Quick to implement.

RECOMMENDATION: Short expiry (15min) + refresh token rotation handles 90% of cases.
  Only add JTI blocklist for regulated/high-security use cases.
```

**Q2: Explain the difference between RS256 and HS256 and when to use each.**

```
HS256 (HMAC-SHA256):
  Symmetric — one shared secret used for both signing and verifying.
  Any service that can verify tokens must know the secret.

  Vulnerability: If you share the secret with 10 services and one is compromised,
  the attacker can SIGN new tokens (because verify secret = sign secret).

  When to use: single-service applications. Secret never leaves one codebase.

RS256 (RSA-SHA256):
  Asymmetric — two different keys.
  Private key: signs tokens. Only your auth service holds this.
  Public key: verifies tokens. Can be shared with every service worldwide.

  Guarantee: possession of the public key = can verify tokens.
             possession of the public key ≠ can issue new tokens.

  Even if the public key is compromised or extracted from a service,
  attacker cannot forge tokens — they need the private key.

  When to use: microservices, third-party token verification, production at scale.

ES256 (ECDSA P-256):
  Also asymmetric like RS256 but uses elliptic curves instead of RSA.
  Same security model. Shorter keys. Faster operations. Smaller tokens.
  Preferred for mobile and IoT (battery/bandwidth conservation).

RULE OF THUMB:
  Building a prototype or single-service app: HS256 is fine.
  Building microservices, distributing tokens to external consumers: RS256.
  Building for mobile at scale: ES256.
```

---

### Advanced Questions

**Q1: You're issuing JWTs from a custom auth service and need zero-downtime key rotation. Design the process.**

```
WHY KEY ROTATION MATTERS:
  If private key is compromised: attacker can issue arbitrary tokens indefinitely.
  Rotation limits the window — compromised key only valid until next rotation.
  Regulatory: PCI-DSS, SOC 2 require evidence of key rotation procedures.

ZERO-DOWNTIME ROTATION PROCESS:

Phase 1 — Preparation (Day 0):
  1. Generate new RSA key pair (kid: "key-2025-04")
  2. Store private key in AWS Secrets Manager: /jwt/signing-key --> "key-2025-04"
  3. Add NEW public key to JWKS endpoint (keep OLD public key too):
     JWKS now has: [key-2025-01, key-2025-04]
  4. JWT verifiers across all services start caching both keys.

Phase 2 — Cut-over (Day 1):
  5. Update auth service configuration: sign new tokens with key-2025-04.
     Tokens issued now: header.kid = "key-2025-04"
  6. Old tokens (kid: key-2025-01) still accepted: old public key still in JWKS.

Phase 3 — Clean-up (Day 16 — after old tokens expire):
  7. Maximum token lifetime: 15-day refresh token (worst case).
     All tokens signed with key-2025-01 have expired.
  8. Remove key-2025-01 from JWKS endpoint.
  9. Remove old private key from Secrets Manager (add deletion protection window).

AUTOMATION:
  - CloudWatch Events trigger rotation Lambda every 90 days.
  - Lambda: generates key pair, updates Secrets Manager, updates JWKS DynamoDB record.
  - No manual steps. Rotation is verifiable and auditable.

CLIENT BEHAVIOR (best practice):
  Verifiers: do not hard-code public keys.
  Use: jwks-rsa library that fetches from JWKS endpoint and caches.
  Cache TTL: 10-30 minutes. New keys picked up within cache window.
  kid mismatch: attempt JWKS refresh. If still not found: reject token.
```

---

## SECTION 10 — Common Developer Mistakes

```
MISTAKE 1: No expiry on JWT (expiresIn omitted from jwt.sign())
──────────────────────────────────────────────────────────────────
What happens: jwt.sign({ sub: userId }, secret) — no expiresIn option.
              Token is valid FOREVER. Deleted users can still authenticate.
              Compromised tokens: valid indefinitely.

Real incident: Contractor's token used 400 days after account deletion (fintech).
               3 months of silent data exfiltration discovered via log analysis.

Fix: ALWAYS provide expiresIn. Access tokens: 15m. Refresh tokens: 7-30d.

MISTAKE 2: Algorithm not hard-coded (alg:none or RS256→HS256 confusion possible)
───────────────────────────────────────────────────────────────────────────────────
What happens: Server uses algorithm from token header.
              Attacker changes to alg:none → no signature required.
              Or changes to HS256 → uses the PUBLIC key as HS256 secret.

Fix: jwt.verify(token, key, { algorithms: ['RS256'] }) — ALWAYS.

MISTAKE 3: JWT payload contains sensitive data
────────────────────────────────────────────────
What happens: { password: plaintext, ssn: "123-45-6789", creditCard: "..." } in payload.
              JWT payload is BASE64URL ENCODED, not encrypted.
              Anyone who captures the token decodes payload instantly.
              Tokens in logs, URL params, error reports → immediate data leak.

Fix: JWT contains identifiers (sub, tenant_id, role) — never secrets or sensitive PII.

MISTAKE 4: Missing issuer (iss) and audience (aud) validation
───────────────────────────────────────────────────────────────
What happens: Token from auth.service-a.com accepted by service-b.com.
              Token intended for mobile app accepted by admin API.
              Token from a DIFFERENT SYSTEM's auth issued to a user accepted by yours.

Fix: jwt.verify(token, key, { issuer: EXPECTED_ISS, audience: EXPECTED_AUD })

MISTAKE 5: JWT stored in localStorage
────────────────────────────────────────
What happens: Any XSS → localStorage.getItem('token') → exfiltration.
              Third-party JS libraries included on the page can access it.
              Browser extensions in development can read it.

Fix: HttpOnly cookie. JS cannot access HttpOnly cookies, period.

MISTAKE 6: Weak HS256 secret
──────────────────────────────
What happens: secret = 'password123' or secret = 'jwt_secret' or app name.
              Any captured JWT → offline brute-force with jwt-cracker/hashcat.
              At 1B /second GPU: 8-char secrets cracked in minutes.
              All tokens forgeable with cracked secret.

Fix: SECRET = crypto.randomBytes(32).toString('base64')  // 256 bits of entropy.
     Or: switch to RS256 (private key is 2048-bit RSA — not brute-forceable).

MISTAKE 7: Logging full JWT
────────────────────────────
What happens: logger.info('Request received', { headers: req.headers })
              Authorization: Bearer <JWT> → logged to CloudWatch.
              CloudWatch log access = token exfiltration.
              Tokens valid for hours after being logged.

Fix: Scrub Authorization header from logs. Log only: jti, sub (user ID), not full token.

MISTAKE 8: Not verifying token signature before decoding (jwt.decode vs jwt.verify)
─────────────────────────────────────────────────────────────────────────────────────
What happens: jwt.decode(token) → returns payload WITHOUT signature verification.
              Many developers use decode to extract claims and then do their own checks.
              But they may miss the signature step entirely.

              Vulnerable pattern:
              const payload = jwt.decode(token);  // No signature check!
              if (payload.sub && payload.exp > Date.now()/1000) { ... }

Fix: ALWAYS use jwt.verify() — never jwt.decode() for authentication decisions.

MISTAKE 9: Accepting JWT in URL query parameters
─────────────────────────────────────────────────
What happens: GET /download?token=eyJ...
              URL gets logged in: proxy logs, CDN logs, browser history, Referer headers.
              Token exfiltrated from any of these sources.

Fix: JWTs in Authorization header or HttpOnly cookies only. Never URL params.

MISTAKE 10: No jti claim for revocation-capable tokens
────────────────────────────────────────────────────────
What happens: Tokens can never be individually revoked (only whole-key rotation).
              Logout cannot be enforced before expiry.
              Admin cannot ban a single user's active token.

Fix: Include jti: crypto.randomUUID() in every token.
     Maintain a Redis blocklist for revocation by jti.
```

---

## SECTION 11 — Quick Revision

### 10 Core Takeaways

```
1. JWT is NOT a session. It's a signed self-contained credential.
   Server doesn't look it up — it mathematically verifies it.

2. JWT payload is base64url-encoded, NOT encrypted.
   Anyone with the token can read all claims. Never put secrets in JWT.

3. Always hard-code the expected algorithm. Never trust the token's alg header.
   { algorithms: ['RS256'] } is your single line of defense against alg:none and alg confusion.

4. Validate ALL five: signature, expiry, algorithm, issuer, audience.
   Each one closes a different attack vector. All five are required.

5. SHORT-LIVED access tokens are the primary security control for JWT.
   15 minutes limits the damage from any token theft. Design for this window.

6. Refresh token rotation + replay detection: if old refresh token used again,
   revoke the entire token family. That's a theft indicator.

7. RS256 for microservices: private key stays with auth service.
   Public key distributed freely. Services can verify but never forge.

8. HttpOnly cookies for JWT storage: eliminates localStorage XSS risk entirely.
   Combined with SameSite=Lax: covers CSRF too.

9. Never log full JWTs. Log jti or user_id for debugging.
   Logs are often less-secured than your application. A token in a log = a token for sale.

10. Rotate private keys regularly (every 90 days). Use JWKS endpoint.
    Zero-downtime rotation: publish new key while keeping old key until old tokens expire.
```

### 30-Second Interview Answer

> "A JWT is a cryptographically signed token with three parts: a header specifying the algorithm, a payload containing user claims, and a signature proving those claims haven't been tampered with. The server verifies the signature mathematically — no database lookup needed. That's why JWT is ideal for microservices: any service with the public key can verify the token independently. The critical security controls are: always hard-code the expected algorithm to prevent alg:none and confusion attacks, validate all five claim fields — signature, expiry, issuer, audience, and algorithm — use short-lived access tokens of 15 minutes, and store tokens in HttpOnly cookies to block XSS theft. The main JWT tradeoff versus sessions is revocation: you can't instantly invalidate a JWT unless you add a JTI blocklist, which partially reintroduces statefulness."

### Memory Tricks

```
JWT attack types — "SAFE":
  S — Signature bypass (alg:none)
  A — Algorithm confusion (RS256→HS256 with public key as HMAC secret)
  F — Forgery from weak secret (brute-force offline)
  E — Exfiltration from localStorage (XSS theft)

JWT validation checklist — "SEAIE" (pronounce "see-eye"):
  S — Signature (verify against public key)
  E — Expiry (exp > now — automatic in jwt.verify)
  A — Algorithm (hard-code RS256 — never from token)
  I — Issuer (iss === expected issuer URL)
  E — Audience (aud === this service's URL)

HS256 vs RS256 — "SHare vs PriVate":
  HS256 = SHared secret — one key, single service
  RS256 = PRiVate key signs, public key verifies — microservices
```

---

## SECTION 12 — Security Thinking Exercise

### Scenario: BlogCraft — A Publishing Platform

**Context:**

BlogCraft is a multi-tenant blogging platform. Each media company (tenant) has editors and admins. Architecture uses JWT for auth. A security researcher submits this report:

> "I can access any article in draft status for any tenant. I can also elevate my role to admin. Steps to reproduce: see attached."

**JWT implementation found in the codebase:**

```javascript
// Login handler — token issuance
app.post("/auth/login", async (req, res) => {
  const user = await User.findOne({ email: req.body.email });
  const valid = await bcrypt.compare(req.body.password, user.passwordHash);
  if (!valid) return res.status(401).send("Invalid");

  const token = jwt.sign(
    { userId: user.id, role: user.role, tenantId: user.tenantId },
    process.env.JWT_SECRET,
    { expiresIn: "7d" },
  );
  res.json({ token });
});

// Auth middleware
app.use((req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).send();

  const decoded = jwt.decode(token); // <— Note: decode, not verify
  req.user = decoded;
  next();
});

// Get article
app.get("/articles/:id", async (req, res) => {
  const article = await Article.findById(req.params.id);
  res.json(article);
});
```

**Researcher's attack — identify what they did before reading.**

---

### Analysis: Three Simultaneous Vulnerabilities

```
VULNERABILITY 1 — jwt.decode() instead of jwt.verify()

  jwt.decode(token): Base64URL decode ONLY. No signature check. No expiry check.

  Attack execution:
  Step 1: Attacker creates their OWN JWT (any JWT signing tool, any secret):
          const fakeToken = jwt.sign(
            { userId: 'user_admin', role: 'admin', tenantId: 'tenant_victimB' },
            'attacker_arbitrary_secret'
          );
  Step 2: Attach forged token to request Authorization header.
  Step 3: Server: jwt.decode(fakeToken) → returns { userId, role: 'admin', tenantId: 'tenant_victimB' }
          NO SIGNATURE CHECK. req.user = { role: 'admin', tenantId: 'tenant_victimB' }
  Step 4: Attacker is now "admin" at tenant_victimB.
          Can access ALL articles across ALL tenants. Can modify any article.

  This is a COMPLETE authentication bypass. The auth middleware does nothing.
  Any attacker can claim ANY identity without any valid credentials whatsoever.

VULNERABILITY 2 — No ownership check on GET /articles/:id

  Even if authentication were fixed (jwt.verify used), the article endpoint has no check:
  Article.findById(id) → returns the article to whoever asks.
  No check: does this user's tenantId match the article's tenantId?
  No check: is the article published or draft?

  Any authenticated user at Tenant A can read all draft articles at Tenant B.

VULNERABILITY 3 — Token returned in JSON response body (not HttpOnly cookie)

  res.json({ token }) → token returned as JSON → client stores in localStorage (typical SPA).
  XSS vulnerability anywhere → token exfiltrated instantly.

  7-day token lifetime × XSS surface area × localStorage = high-impact theft window.
```

### Correct Secure Implementation

```javascript
// FIXED auth middleware — verify, not decode
app.use((req, res, next) => {
  const token =
    req.headers.authorization?.split(" ")[1] || req.cookies["__Host-bcsid"]; // Also accept from HttpOnly cookie
  if (!token) return res.status(401).json({ error: "UNAUTHENTICATED" });

  try {
    const payload = jwt.verify(token, PUBLIC_KEY, {
      algorithms: ["RS256"], // Hard-coded
      issuer: "https://auth.blogcraft.com",
      audience: "https://api.blogcraft.com",
    });
    req.user = {
      id: payload.userId,
      role: payload.role,
      tenantId: payload.tenantId,
    };
    next();
  } catch (err) {
    return res.status(401).json({ error: "TOKEN_INVALID" });
  }
});

// FIXED article retrieval — ownership check
app.get("/articles/:id", async (req, res) => {
  const article = await Article.findOne({
    _id: req.params.id,
    tenantId: req.user.tenantId, // Tenant boundary enforced at query level
  });

  if (!article) return res.status(404).json({ error: "NOT_FOUND" });

  // Draft articles: only editors/admins of this tenant can see them
  if (article.status === "draft" && req.user.role === "reader") {
    return res.status(404).json({ error: "NOT_FOUND" });
  }

  return res.json(article);
});

// FIXED login — short-lived token in HttpOnly cookie
app.post("/auth/login", async (req, res) => {
  const user = await User.findOne({ email: req.body.email });
  if (!user || !(await bcrypt.compare(req.body.password, user.passwordHash))) {
    return res.status(401).json({ error: "INVALID_CREDENTIALS" });
  }

  const accessToken = jwt.sign(
    { userId: user.id, role: user.role, tenantId: user.tenantId },
    PRIVATE_KEY,
    { algorithm: "RS256", expiresIn: "15m", issuer: "...", audience: "..." },
  );

  // Token in HttpOnly cookie — NOT in JSON response body
  res.cookie("__Host-bcsid", accessToken, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 15 * 60 * 1000,
    path: "/",
  });

  // Return only non-sensitive user info in the response body
  return res.json({
    user: { id: user.id, email: user.email, role: user.role },
  });
});
```

_End of Topic 03: JWT Authentication_
