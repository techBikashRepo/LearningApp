# JWT Authentication — Part 2 of 3

### Sections: 5 (Defense Mechanisms), 6 (Architecture Diagram), 7 (Production Scenarios), 8 (AWS Mapping)

**Series:** Authentication & Security → Topic 03

---

## SECTION 5 — Defense Mechanisms

### Defense 1: Mandatory Claim Validation — The Full Checklist

```javascript
// Every JWT consumer in your system MUST validate ALL of these.
// Skip one → exploit surface opens.

function validateToken(token, expectedAudience) {
  let payload;

  try {
    payload = jwt.verify(token, PUBLIC_KEY, {
      // 1. ALGORITHM: Never derive from token header. Hard-code RS256.
      //    Prevents: alg:none bypass, RS256→HS256 confusion attack.
      algorithms: ['RS256'],

      // 2. ISSUER: Token must come from YOUR auth server, not a different one.
      //    Prevents: tokens from other tenants or services being replayed here.
      issuer: 'https://auth.myapp.com',

      // 3. AUDIENCE: Token must be intended for THIS service.
      //    Prevents: token for ServiceA used on ServiceB (different permissions).
      audience: expectedAudience,

      // 4. EXPIRY: Token must not be expired. (jwt.verify() checks exp automatically)
      //    clockTolerance: allow up to 30 seconds clock skew between servers.
      clockTolerance: 30,
    });
    // jwt.verify() also automatically checks:
    //   exp > now() (expiry)
    //   nbf <= now() (not-before, if present)
    //   Signature validity against PUBLIC_KEY

  } catch (err) {
    // 5. HANDLE ERRORS EXPLICITLY — never swallow JWT errors silently
    if (err.name === 'TokenExpiredError')     throw new AuthError('TOKEN_EXPIRED');
    if (err.name === 'NotBeforeError')        throw new AuthError('TOKEN_NOT_YET_VALID');
    if (err.name === 'JsonWebTokenError')     throw new AuthError('TOKEN_INVALID');
    if (err.name === 'SyntaxError')           throw new AuthError('TOKEN_MALFORMED');
    throw err; // Re-throw unexpected errors
  }

  // 6. ADDITIONAL BUSINESS LOGIC CHECK: is the account still active?
  //    JWT does not know if the user was banned after token issuance.
  //    Optional: check revocation blocklist by jti.
  if (payload.jti) {
    const revoked = await jtiBlocklist.exists(payload.jti);
    if (revoked) throw new AuthError('TOKEN_REVOKED');
  }

  return payload;
}
```

### Defense 2: Key Management — Public/Private Key Rotation

```javascript
// JWK Set (JSON Web Key Set) — the standard for publishing public keys
// URL: https://auth.myapp.com/.well-known/jwks.json
// Format:
{
  "keys": [
    {
      "kty": "RSA",
      "use": "sig",
      "kid": "key-2025-01",           // Key ID — matches kid in token header
      "n":   "...(RSA modulus)...",
      "e":   "AQAB"                    // RSA exponent
    },
    {
      "kty": "RSA",
      "use": "sig",
      "kid": "key-2024-07",           // Old key still here during rotation window
      "n":   "...(old RSA modulus)...",
      "e":   "AQAB"
    }
  ]
}

// KEY ROTATION PROCEDURE (zero-downtime):
//
// Day 0: Current key: key-2024-07 (used to sign all tokens)
// Day 1: Generate new key pair: key-2025-01
//         Publish BOTH keys in JWKS endpoint.
//         Old tokens: kid=key-2024-07 → verified with old public key (still trusted)
//         New tokens: kid=key-2025-01 → verified with new public key
// Day 16: All tokens signed with key-2024-07 have expired (assuming max 15-day lifetime)
//          Remove key-2024-07 from JWKS endpoint.
//          Only new key remains.
//
// Rotation frequency: every 90 days (common standard) or on suspected compromise.

// Verifier using JWKS (fetches public keys automatically):
import jwksRsa from 'jwks-rsa';

const jwksClient = jwksRsa({
  jwksUri: 'https://auth.myapp.com/.well-known/jwks.json',
  cache: true,
  cacheMaxEntries: 5,
  cacheMaxAge: 600000, // 10 minutes cache
});

function getSigningKey(header, callback) {
  jwksClient.getSigningKey(header.kid, (err, key) => {
    if (err) return callback(err);
    callback(null, key.getPublicKey());
  });
}

// jwt.verify with dynamic key lookup by kid:
jwt.verify(token, getSigningKey, { algorithms: ['RS256'] }, (err, payload) => { ... });
```

### Defense 3: Token Storage Security

```
STORAGE OPTIONS — ranked from most secure to least:

1. HttpOnly Cookie (RECOMMENDED):
   Set-Cookie: access_token=<JWT>; HttpOnly; Secure; SameSite=Lax; Path=/api; Max-Age=900
   - JavaScript CANNOT read: XSS cannot steal the token value.
   - Sent automatically by browser to your domain.
   - CSRF risk: mitigated by SameSite=Lax + CSRF token for state-changing requests.
   - Works for: web applications, same-domain APIs.

2. Memory (in-variable, not persisted):
   const accessToken = await loginAndGetToken();
   // Store only in a closure or React state — NOT in localStorage/sessionStorage
   - Lost on page refresh → user must re-authenticate or use refresh token.
   - XSS can still read in-memory variables if they're reachable.
   - Reduces the attack surface from "any XSS ever runs" to "XSS in your exact execution context".

3. sessionStorage:
   sessionStorage.setItem('token', jwt);
   - Cleared when tab closes — slightly better than localStorage.
   - Still accessible via document.sessionStorage from XSS.
   - Not acceptable for sensitive tokens.

4. localStorage (NEVER for auth tokens):
   localStorage.setItem('token', jwt);
   - Persists indefinitely.
   - Accessible from ANY script on the page.
   - Any third-party library you load can exfiltrate it.
   - The risk is not hypothetical: Magecart attacks specifically target localStorage.
```

### Defense 4: Token Expiry and Refresh Strategy

```
SHORT-LIVED ACCESS TOKEN + REFRESH TOKEN pattern:

Access token:
  Lifetime: 15 minutes
  Storage: HttpOnly cookie (or memory for SPA)
  Content: user claims (sub, role, tenant_id, etc.)
  Verifiable: by any service with the public key (no DB call)

Refresh token:
  Lifetime: 7-30 days
  Storage: HttpOnly cookie (separate, more restricted path /auth/refresh)
  Content: opaque random string (not JWT) — just a reference
  Stored: in database (with user_id, expiry, device info)

FLOW:
  1. Login → issue access token (15min) + refresh token (30 days)
  2. Client makes API calls with access token: works for 15 minutes
  3. Access token expires → client POSTs refresh token to /auth/refresh
  4. Server validates refresh token (DB lookup) → issues NEW access token
  5. Refresh token rotation: new refresh token issued, old one deleted
     (If old refresh token is used again after rotation → REPLAY DETECTION → revoke all)

REFRESH TOKEN ROTATION WITH REPLAY DETECTION:
  Each refresh token has a "family" (chain of rotations).
  If a refresh token is used that has already been rotated:
    Someone is replaying a stolen token.
    IMMEDIATELY revoke all tokens in that family (= logout all devices for this user).
    Alert: security anomaly notification to user.
```

---

## SECTION 6 — Architecture Diagram

```
JWT AUTHENTICATION ARCHITECTURE — PRODUCTION MICROSERVICES

┌─────────────────────────────────────────────────────────────────────────────────┐
│                           CLIENT (Browser / Mobile)                             │
│                                                                                 │
│  Stores: Access Token  → HttpOnly cookie (short-lived, 15 min)                 │
│          Refresh Token → HttpOnly cookie (long-lived, 30 days, path=/auth)     │
│  JavaScript: CANNOT READ either token value (HttpOnly)                         │
└───────────────────────────────┬─────────────────────────────────────────────────┘
                                │ HTTPS — TLS 1.3
                                ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                         CLOUDFRONT + WAF                                        │
│  Rate limit: /auth/login 5/IP/min, /auth/refresh 20/IP/min                    │
│  HTTPS enforcement: redirect HTTP to HTTPS                                      │
│  HSTS header: Strict-Transport-Security: max-age=63072000; includeSubDomains  │
└────────────────────────┬──────────────────────────────────────────────────────┘
                         │
              ┌──────────┴──────────┐
              ▼                     ▼
┌─────────────────────┐  ┌──────────────────────────────────────────────────────┐
│   AUTH SERVICE      │  │              API GATEWAY                             │
│   (Token Issuer)    │  │  JWT Authorizer Lambda                               │
│                     │  │                                                      │
│ /auth/login         │  │  Per-request for every API call:                    │
│  → verify password  │  │  1. Extract JWT from cookie or Authorization header │
│  → issue JWT pair   │  │  2. Verify signature (RS256 public key)             │
│  → sign with        │  │  3. Check exp, iss, aud — hard-coded in authorizer  │
│    RSA private key  │  │  4. Check jti blocklist (Redis) — optional          │
│                     │  │  5. If valid: inject claims into Lambda event       │
│ /auth/refresh       │  │  6. If invalid: 401 — Lambda never invoked          │
│  → validate refresh │  │                                                      │
│  → rotate tokens    │  │  Public key: fetched from JWKS endpoint             │
│  → revocation DB    │  │  Cached 10 min (no network call per request)        │
│                     │  │                                                      │
│ /auth/revoke        │  │  Result: Lambda receives:                           │
│  → add jti to Redis │  │  event.requestContext.authorizer.jwt.claims:        │
│    blocklist        │  │  { sub, role, tenant_id, email, exp, iat, jti }     │
└──────────┬──────────┘  └────────────────────────┬─────────────────────────────┘
           │                                       │ Claims injected (no re-verify)
           ▼                                       ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                       DOWNSTREAM MICROSERVICES                                  │
│                  (Invoices, Reports, Users, Notifications)                      │
│                                                                                 │
│  Each Lambda function: NO JWT verification code.                                │
│  API Gateway already verified. Claims are trusted.                             │
│                                                                                 │
│  Code uses: event.requestContext.authorizer.jwt.claims.sub                     │
│            event.requestContext.authorizer.jwt.claims.role                    │
│            event.requestContext.authorizer.jwt.claims.tenant_id               │
│                                                                                 │
│  Authorization is still YOUR JOB in each Lambda:                               │
│  - ownership: WHERE id=$1 AND user_id=$sub AND tenant_id=$tenant_id           │
│  - RBAC: if (claims.role !== 'admin') return 403                               │
└────────────────────────────────────────────┬────────────────────────────────────┘
                                             │
               ┌─────────────────────────────┼──────────────────────────┐
               ▼                             ▼                          ▼
    ┌──────────────────┐        ┌────────────────────┐     ┌────────────────────┐
    │ RDS Aurora       │        │ ElastiCache Redis   │     │ Auth Service DB    │
    │ (App Data)       │        │                     │     │ (Refresh Tokens)   │
    │                  │        │ JTI blocklist:       │     │                    │
    │ Tenant-scoped    │        │ SET jti → TTL=exp   │     │ refresh_tokens:    │
    │ queries only     │        │ O(1) revocation      │     │ token_hash, user,  │
    └──────────────────┘        │ check               │     │ family, expires_at │
                                └─────────────────────┘     └────────────────────┘

PRIVATE KEY:
  Stored in AWS Secrets Manager.
  Only the Auth Service has access (IAM policy: deny all other roles).
  Rotated every 90 days via automated rotation Lambda.

PUBLIC KEY:
  Published at: https://auth.myapp.com/.well-known/jwks.json
  Cached by API Gateway Authorizer: refreshed every 10 minutes.
  Can be shared publicly — there is no security risk.
```

---

## SECTION 7 — Production Scenarios

### Scenario 1: Startup Using JWT Without Expiry

**Context:** A fintech startup built their JWT auth. Tokens have no expiry claim. "We'll add it later."

```
DISCOVERY:
  Security audit finds: tokens issued to users on Day 1 of the platform launch
  are STILL VALID on Day 400.

  A user who left the company (contractor) still has a valid API token.
  A user whose account was suspended still has a valid token.
  A token leaked in a Slack message from 6 months ago still works.

HOW THEY DISCOVERED IT:
  CloudWatch logs analysis: API call from a user account that was deleted 3 months ago.
  Account: deleted from users table.
  Token: still valid (no expiry).
  500 API calls to the data export endpoint in the past week.

IMPACT:
  The deleted user (ex-contractor) had been silently exporting customer data
  for 3 months after their account was deleted.

ROOT CAUSE:
  jwt.sign({ sub: userId, role: 'vendor' }, secret)  // No expiresIn option
  jwt.verify(token, secret)                           // No exp check (nothing to check)

  jwt.sign without expiresIn: the token never expires. It is valid indefinitely.
  jwt.verify: exp check is only performed if the exp claim exists in the token.

FIX (emergency + permanent):
  Emergency: rotate the JWT signing secret immediately.
             All existing tokens → invalidated (signature no longer verifiable).
             All users must re-authenticate.

  Permanent:
    jwt.sign({ ... }, secret, { expiresIn: '15m' })           // Access token
    jwt.sign({ jti: uuid(), ... }, secret, { expiresIn: '30d' })  // Refresh token

    Verify: jwt.verify(token, secret, { complete: true })
    // Throws TokenExpiredError if exp < now()
```

### Scenario 2: RS256 → HS256 Algorithm Confusion in Production

**Context:** A developer implements JWT verification by reading the algorithm from the token.

```javascript
// VULNERABLE CODE (found in production code reviews)
function verifyJWT(token) {
  const decoded = jwt.decode(token); // No verification — just decode
  const algorithm = decoded.header.alg; // Trust the ATTACKER-controlled header

  let key;
  if (algorithm === "RS256") {
    key = PUBLIC_KEY;
  } else if (algorithm === "HS256") {
    key = SECRET_KEY;
  }

  return jwt.verify(token, key, { algorithms: [algorithm] });
  //     ^^^^^^^^ algorithm from token header, not from hard-coded config
}

// WHY THIS IS EXPLOITABLE:
// 1. Attacker changes token header: { "alg": "HS256" }
// 2. Code enters the HS256 branch: key = SECRET_KEY
//    Wait — what IS hs256Secret in this context?
//    In some implementations the "fallback" secret is the public key string.
//    In others it's an env var that might be known or guessable.
// 3. Even without knowing the secret: Attacker can set alg to HS256 and
//    the public key is AVAILABLE PUBLICLY at the JWKS endpoint.
//    RSA public key as HS256 secret = complete signature forgery.

// CORRECTLY FIXED:
function verifyJWT(token) {
  return jwt.verify(token, PUBLIC_KEY, {
    algorithms: ["RS256"], // HARD-CODED. Token header is irrelevant.
    issuer: EXPECTED_ISS,
    audience: EXPECTED_AUD,
  });
  // If the token says alg:HS256, RS256, or none → rejected because it's not RS256.
}
```

---

## SECTION 8 — AWS Mapping

### AWS Services for JWT Authentication

```
┌──────────────────────────┬──────────────────────────────────────────────────────┐
│ AWS Service              │ Role in JWT Authentication                           │
├──────────────────────────┼──────────────────────────────────────────────────────┤
│ Cognito User Pools       │ Managed JWT issuer. Handles login, MFA, email verify │
│                          │ Issues: ID token + Access token + Refresh token      │
│                          │ JWKS: published automatically at Cognito URL         │
├──────────────────────────┼──────────────────────────────────────────────────────┤
│ API Gateway JWT          │ Built-in JWT verification per route                  │
│ Authorizer               │ No Lambda needed. No DB lookup. Signature + claims.  │
│                          │ Configure: issuerUrl, audience, identity source      │
├──────────────────────────┼──────────────────────────────────────────────────────┤
│ Lambda Authorizer        │ Custom token validation logic                        │
│                          │ Useful when: non-standard claims, DB lookup needed,  │
│                          │ custom headers, API key + JWT combination            │
├──────────────────────────┼──────────────────────────────────────────────────────┤
│ AWS Secrets Manager      │ Store RSA private key (if building custom auth svc)  │
│                          │ Secrets Manager rotation Lambda: auto key rotation   │
├──────────────────────────┼──────────────────────────────────────────────────────┤
│ AWS KMS                  │ Asymmetric key for JWT signing via KMS API           │
│                          │ KMS signs the JWT — private key NEVER leaves KMS    │
│                          │ Highest security: HSM-backed key material           │
├──────────────────────────┼──────────────────────────────────────────────────────┤
│ ElastiCache Redis        │ JTI revocation blocklist                             │
│                          │ jtiBlocklist.set(jti, 'revoked', TTL=token.exp)     │
│                          │ O(1) lookup per request                              │
├──────────────────────────┼──────────────────────────────────────────────────────┤
│ CloudFront               │ HTTPS enforcement, edge caching of JWKS endpoint     │
├──────────────────────────┼──────────────────────────────────────────────────────┤
│ WAF                      │ Rate limit /auth/* endpoints                         │
│                          │ Block requests with malformed JWT patterns           │
└──────────────────────────┴──────────────────────────────────────────────────────┘
```

### Cognito-Specific JWT Configuration

```javascript
// API Gateway JWT Authorizer with Cognito (CDK)
const httpApi = new HttpApi(this, "Api");

const authorizer = new HttpJwtAuthorizer(
  "CognitoAuthorizer",
  `https://cognito-idp.${region}.amazonaws.com/${userPool.userPoolId}`,
  {
    identitySource: ["$request.header.Authorization"],
    jwtAudience: ["your-app-client-id"],
  },
);

httpApi.addRoutes({
  path: "/invoices/{id}",
  methods: [HttpMethod.GET],
  integration: new HttpLambdaIntegration("InvoicesIntegration", invoicesLambda),
  authorizer,
});
// API GW automatically: verifies sig using Cognito JWKS, checks exp, checks aud
// Lambda receives: event.requestContext.authorizer.jwt.claims (all Cognito claims)

// In Lambda — claims are already verified, trust them:
export const handler = async (event) => {
  const claims = event.requestContext.authorizer.jwt.claims;
  const userId = claims.sub;
  const tenantId = claims["custom:tenant_id"];
  const role = claims["custom:role"];

  // Authorization is still your responsibility:
  const invoice = await db.query(
    "SELECT * FROM invoices WHERE id=$1 AND user_id=$2 AND tenant_id=$3",
    [event.pathParameters.id, userId, tenantId],
  );
  if (!invoice)
    return { statusCode: 404, body: JSON.stringify({ error: "NOT_FOUND" }) };
  return { statusCode: 200, body: JSON.stringify(invoice) };
};

// Cognito Pre-Token Generation Lambda (custom claims injection):
export const preTokenHandler = async (event) => {
  const user = await UserRepository.findBySub(event.request.userAttributes.sub);

  event.response.claimsOverrideDetails = {
    claimsToAddOrOverride: {
      "custom:role": user.role,
      "custom:tenant_id": user.tenantId,
      "custom:plan": user.subscriptionPlan,
    },
    // claimsToSuppress: ['email'] — use this to remove sensitive claims from token
  };
  return event;
};
```
