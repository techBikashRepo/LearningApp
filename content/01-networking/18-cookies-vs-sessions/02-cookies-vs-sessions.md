# Cookies vs Sessions — Part 2 of 3

### Topic: Cookies vs Sessions in Production Systems and AWS

**Series:** Networking Fundamentals → System Design → AWS Solutions Architect
**Sections Covered:** 5, 6, 7, 8

---

## SECTION 5 — Real World Examples

### Analogy 1 — The VIP Concert Wristband System

**Server Session = Wristband with database:**
At a concert, the bouncer stamps a number on your wrist. The number itself tells them nothing — they have to look it up in a tablet: "Wristband #4521: Alice, VIP backstage access, bought 2 beers already."

Remove Alice from the tablet? Wristband #4521 is useless. Instant revocation. Works for highly-sensitive contexts.

**JWT = Wristband with QR code (self-verifying):**
A more modern concert prints a QR code on your wristband. When scanned, the QR code says: "Alice, VIP, valid until 11 PM, signed by EventCo." Any bouncer with a scanner can verify authenticity ON THE SPOT — no tablet lookup needed. 10,000 people arriving at once, every gate can verify independently.

But: If you give your wristband to your friend after you leave, their entry is valid until 11 PM. There's no revoking the QR code without calling every scanner in the venue (blocklist).

### Analogy 2 — Library Card vs Day Pass Sticker

**Session token = Library card (opaque ID):**
Your library card number is 00042. It means nothing on its own. Librarian scans it → database says: "Member since 2015, has 3 books checked out, owes $0.50 in fines, premium member." The entire context is SERVER-SIDE. If you're banned, they delete your record. Your card is immediately invalid.

**Cookie with user data = Day pass sticker (carries info):**
Concert day pass sticker: "Alice, Rockzone, Beers: 2." The sticker shows your limits. Problem: You can peel the sticker off and hand it to others, or alter the number. Solution? A tamper-evident hologram (JWT signature) that breaks if altered.

### Real Software Example — GitHub OAuth Token vs AWS Session Credentials

Two real-world authentication systems that demonstrate cookie/session/token concepts:

**GitHub Personal Access Token (PAT):**

```
Type: Long-lived API token (opaque, like a session ID)
Storage: GitHub's database (hashed)
Where client stores: Developer stores in ~/.gitconfig or environment variable
Usage:
  Authorization: token ghp_xxxxxxxxxxxxxxxxxxxxx

Revocation: Github.com → Settings → Developer settings → Personal access tokens
            Click revoke → token immediately invalid (server-side deletion)

Security: Never expires by default! → Recent change: fine-grained PATs expire after 1 year
          Can be scoped to specific repos/permissions (repo:read, issues:write, etc.)
```

**AWS STS Temporary Credentials (JWT-like):**

```
Type: Short-lived credentials (similar to JWT — self-contained, signed)
Structure: AccessKeyId + SecretAccessKey + SessionToken (the "JWT" equivalent)
Issued by: STS AssumeRole call
Lifetime: 15 minutes to 12 hours (configurable)

How AWS services verify (no STS call needed!):
  Every API call includes AWS Signature v4 (HMAC over request + credentials)
  AWS services validate signature locally using the session token claims
  No central auth lookup per request at scale!

Revocation (like JWT revocation problem):
  STS credentials cannot be revoked mid-lifetime
  STS docs: "Credentials are valid until the expiration time"
  Workaround: keep credential lifetime short (default 1h for assumed roles)
  If compromised: rotate the underlying IAM role's policies, not the credentials

Session cookies on AWS Console:
  When you log into AWS Console:
  - AWS creates a session cookie (HttpOnly, Secure)
  - Session stored server-side at AWS IAM
  - Logout → session invalidated immediately
```

---

## SECTION 6 — System Design Importance

### 1. The Horizontal Scaling Problem With Sessions

This is THE most common architectural mistake with sessions:

```
BROKEN (single server in-memory sessions):

  Server 1 (memory): {session "abc": user42}
  Server 2 (memory): {}

  Request 1: POST /login → hits Server 1 → session "abc" created in Server 1 memory
  Request 2: GET /profile → ALB routes to Server 2 → "No session 'abc'" → 401!

  User experience: "I just logged in, why am I being asked to log in again???"

FIXED — Option A: Sticky Sessions (temporary fix, not recommended):
  ALB sends all requests from the same client to the SAME server.
  Set-Cookie: AWSALB=session-binding-cookie → sent by ALB

  Problem: If Server 1 goes down, all its users are logged out.
           Uneven load distribution (popular users = busy server)

  Use for: Legacy applications you can't modify (temporary solution only)

FIXED — Option B: Distributed Session Store (correct solution):

  ALL servers read/write sessions from SHARED Redis cluster:

  Server 1 writes: HSET sessions:abc user_id "42"
  Server 2 reads:  HGET sessions:abc → "42" → success!

  Request can hit any server → same session data available everywhere
  Scale servers horizontally without affecting sessions

  Infrastructure: ElastiCache Redis (Multi-AZ, clustered for HA)

FIXED — Option C: JWT (stateless, no shared store):
  No session store needed. Any server verifies JWT signature independently.
  Perfect horizontal scaling by design.
  Trade-off: revocation complexity (see refresh token pattern).
```

### 2. Session Fixation Attack (Often Overlooked)

```
ATTACK: Session fixation exploits session IDs that don't rotate after login

Step 1: Attacker visits /login → server assigns session ID to pre-auth visitor
        Server sets: Set-Cookie: sid=attacker-knows-this-value

Step 2: Attacker tricks victim into visiting:
        https://bank.com/login?session_id=attacker-knows-this-value
        (Or attacker has physical access to victim's browser)

Step 3: Victim logs in using the attacker-known session ID
        Server upgrades the session to authenticated (marks it as logged-in user 42)
        But session ID remains: "attacker-knows-this-value"

Step 4: Attacker uses their known session ID
        GET /account → Cookie: sid=attacker-knows-this-value
        Server: session is authenticated as user 42 → attacker is in!

DEFENSE: Regenerate session ID immediately after successful login:

  // After successful password validation:
  const oldSession = req.session
  req.session.regenerate(() => {    // NEW session ID issued
    req.session.userId = user.id    // Transfer user data to new session
    res.redirect('/dashboard')
  })

  // Old session ID is now invalid
  // Attacker's known session ID: returns nothing from Redis
```

### 3. JWT Security Anti-Patterns to Avoid

```
ANTI-PATTERN 1: Storing JWT in localStorage
  localStorage.setItem('jwt', token)

  Problem: localStorage is accessible by ANY JavaScript on the page.
  If your site has XSS vulnerability → attacker injects JS → reads localStorage → steals JWT
  HttpOnly cookie: JavaScript CANNOT access it (XSS-proof storage)

  Fix: Store JWT in HttpOnly Secure cookie (yes, JWT can be in a cookie)
       Then use CSRF protection (double-submit cookie or SameSite=Strict)

ANTI-PATTERN 2: None algorithm JWT
  JWT header: {"alg": "none"}

  CVSS 9.8 vulnerability in early JWT libraries:
  Some JWT libraries accepted "alg: none" and skipped signature verification entirely
  Attacker: modify payload, set alg=none, no signature needed → forge any token

  Fix: Explicitly specify allowed algorithms in jwt.verify():
  jwt.verify(token, key, {algorithms: ['RS256']})  ← NEVER allow 'none'

ANTI-PATTERN 3: Using HS256 (symmetric) in microservices
  HS256: HMAC-SHA256 — uses ONE shared secret to sign AND verify
  Problem: Every microservice that verifies JWT needs the SECRET KEY
           If any service is compromised → attacker has your key → forge any token

  Fix: Use RS256 or ES256 (asymmetric):
  Auth service: signs with PRIVATE KEY (one service, secret)
  All other services: verify with PUBLIC KEY (can be downloaded from JWKS endpoint)
  Public key exposure is FINE — it can only verify, not sign

ANTI-PATTERN 4: Not validating aud (audience) claim
  If service A issues a JWT with aud: ["service-a"] and
  service-b doesn't validate the aud claim,
  attacker can use a service-a token to authenticate to service-b

  Fix: ALWAYS validate audience claim:
  jwt.verify(token, publicKey, {audience: 'service-b'})
```

### 4. OAuth 2.0 and Session Management at Scale

Most modern logins use OAuth 2.0, which combines cookies, sessions, and JWTs:

```
OAuth 2.0 Authorization Code flow (e.g., "Login with Google"):

Step 1: User clicks "Login with Google" on shop.com
  shop.com: Redirect to Google with:
    client_id: shop-com-client-id
    redirect_uri: https://shop.com/auth/callback
    state: random_csrf_value (stored in session)
    scope: openid email profile
    code_challenge: PKCE value (mobile security)

Step 2: User authenticates with Google
  Google: shows their login page
  User: enters Google password (NOT your server's concern — Google handles it)

Step 3: Google sends authorization code to your server
  GET https://shop.com/auth/callback?code=4/P7q7W91...&state=random_csrf_value

  Your server: validate state matches stored CSRF value
               exchange code for tokens via Google's token endpoint

Step 4: Token exchange (server-to-server)
  POST https://oauth2.googleapis.com/token
  Body: code=4/P7q7W91...&redirect_uri=...&client_secret=your-secret

  Response: {
    access_token: "ya29...",             ← Google's short-lived access token
    id_token: "eyJhbGci...",            ← JWT with user info (email, name, Google ID)
    refresh_token: "1//...",             ← Long-lived token to get new access tokens
    expires_in: 3600
  }

Step 5: Create YOUR own session
  Verify id_token signature (using Google's public keys from JWKS URI)
  Extract: {sub: "10769150350006150715113082367", email: "alice@gmail.com", ...}

  Find or create user in YOUR database by Google sub (permanent identifier)
  Create YOUR session: {user_id: YOUR_DB_ID, email: alice@gmail.com}
  Set YOUR session cookie (don't store Google's tokens in the session cookie)

  YOUR session cookie = HttpOnly Secure
  Google's tokens = server-side only (never exposed to browser)
```

---

## SECTION 7 — AWS Mapping

### ALB Sticky Sessions

```
Configuration:
  Target Group → Attributes → Stickiness: Enabled
  Duration: 1 second to 7 days

ALB sets two cookies:
  AWSALB=H4sIAAAAAAAEA5VVWQ...; Expires=...; Path=/; SameSite=None; Secure
  AWSALBCORS=H4sIAAAAAAAEA5VV...; Expires=...; Path=/; SameSite=None; Secure

  (AWSALBCORS is needed for CORS requests — without it, cross-origin requests
   don't include AWSALB and stickiness breaks for API calls from different origins)

ALB routing with sticky sessions:
  First request → no AWSALB cookie → ALB uses normal routing (least connections)
  Subsequent requests → AWSALB cookie present → ALB sends to same registered target
  If target deregisters/fails → ALB picks new target, sets new AWSALB cookie

WARNING: Sticky sessions create uneven load:
  "Hot" users (multiple tabs, heavy API usage) = one server at 90% CPU
  Other servers at 30% CPU
  Auto-scaling helps less — always prefer stateless architecture + distributed session store
```

### ElastiCache Redis for Session Storage

```
Architecture:

  ┌─────────────┐      ┌─────────────┐
  │   EC2 App   │      │   EC2 App   │
  │   Server 1  │      │   Server 2  │  (any server can handle any request)
  └──────┬──────┘      └──────┬──────┘
         │                    │
         └────────┬───────────┘
                  │
         ┌────────▼────────┐
         │  ElastiCache    │
         │  Redis Cluster  │  sessions:abc123 → {user_id: 42, ...}
         │  (Multi-AZ)     │
         └─────────────────┘

Configuration in Node.js (connect-redis):
  const redis = new Redis.Cluster([
    {host: 'my-cluster.abc123.0001.use1.cache.amazonaws.com', port: 6379}
  ])

  app.use(session({
    secret: process.env.SESSION_SECRET,   // From Secrets Manager
    store: new RedisStore({client: redis}),
    cookie: {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      maxAge: 86400 * 1000  // 24 hours in milliseconds
    },
    resave: false,
    saveUninitialized: false
  }))

Redis Multi-AZ setup:
  Primary node: handles writes (SET, DEL)
  Replica(s): handle reads (GET)
  Automatic failover: if primary fails, replica promoted in ~30 seconds
  For HA, use Redis Cluster mode with multiple shards
```

### Amazon Cognito

Cognito manages users and issues JWTs (both sessions and JWT tokens, managed service):

```
Cognito User Pool:
  Manages: User directory, password policies, MFA, email verification
  Issues:  3 JWTs per login:
    ID token     → Contains user attributes (email, name, custom attributes)
    Access token → Used to call API Gateway / other AWS services
    Refresh token → Used to get new ID/access tokens (30 days default)

  Token format: JWTs signed with Cognito's RSA key pair
  JWKS endpoint: https://cognito-idp.{region}.amazonaws.com/{userPoolId}/.well-known/jwks.json

API Gateway + Cognito JWT authorizer:
  HTTP API: Built-in JWT authorizer
    Configure: Issuer = Cognito User Pool URL, Audience = App Client ID
    API Gateway validates JWT on every request (no Lambda involved for auth!)

  REST API: Cognito User Pool Authorizer
    Same validation but through REST API mechanism

Common Cognito pitfalls:
  1. Refresh token: default 30 days, configurable. Revoking = sign out all devices
  2. ID token vs Access token: Use ID token for user info; access token for API auth
  3. Cognito sends tokens to browser: store in memory (SPA) or HttpOnly cookie (server-side)
  4. Session persistence in mobile: Amplify library handles token storage in Keychain/Keystore

DynamoDB session table (alternative to Redis):
  Table: sessions
  PK: session_id
  Attributes: user_id, email, roles, created_at
  TTL attribute: expires_at (DynamoDB auto-deletes expired items)

  Advantage: No separate Redis cluster to manage
  Disadvantage: Higher latency than Redis (milliseconds vs sub-millisecond)
  Use for: Serverless architectures (Lambda + API Gateway) where Redis is overkill
```

### AWS Secrets Manager for Session Secrets

```
Session secret must be:
  1. Long (>= 32 bytes)
  2. Cryptographically random
  3. Rotatable without downtime
  4. NEVER hardcoded in source code

AWS Secrets Manager pattern:
  # Store: aws secretsmanager create-secret --name "prod/session-secret" --secret-string "$(openssl rand -base64 32)"

  # Application retrieves at startup:
  const secret = await secretsmanager.getSecretValue({
    SecretId: 'prod/session-secret'
  }).promise()
  app.use(session({secret: secret.SecretString}))

  # Rotation:
  # Secrets Manager can auto-rotate (Lambda-based rotation)
  # New secret deployed to new instances; old instances use old secret during transition
  # Use multiple secrets during rotation: current + previous (accept both for overlap period)
```

---

## SECTION 8 — Interview Q&As

### Beginner Questions

**Q1: What is the difference between session cookies and persistent cookies?**

A: The distinction is about lifetime, controlled by the `Max-Age` or `Expires` attribute on the `Set-Cookie` header.

Session cookies (no `Max-Age` or `Expires`): Exist only in browser memory. When the browser is closed, all session cookies are deleted. Next time the browser opens, they're gone — user is logged out.

Persistent cookies (with `Max-Age` or `Expires`): Written to disk. Survive browser restarts. When you check "Remember me" on a login form, typically the server issues a persistent cookie with 30-day `Max-Age`. The session persists across browser restarts.

Security consideration: Persistent cookies are riskier because:

1. Stored on disk (potentially recoverable from filesystem forensics)
2. Valid for long periods (longer window for theft/reuse)
3. Anyone with physical device access can potentially extract them

For authentication: session cookies (no expiry) are generally safer for high-security apps. For convenience/UX: persistent cookies with reasonable expiry (14-30 days) and `HttpOnly; Secure; SameSite=Lax` are standard practice.

**Q2: Why can't you just store the user ID directly in the cookie instead of using a session ID?**

A: Storing the user ID directly in an unsigned cookie is exploitable: anyone can change the cookie value to any user ID they want.

Example:

```
Set-Cookie: user_id=42  ← never do this!
User opens DevTools → changes user_id to 1 (admin) → Cookie: user_id=1
Server reads user_id from cookie: "user 1! Welcome, admin."
Account takeover with zero hacking skills.
```

If you want to store data client-side: sign it cryptographically. Signed cookies (Rails signed session, Flask signed cookies) use HMAC-SHA256: `user_id=42.HMAC(42, secret_key)`. Tampering with `42` breaks the signature → server rejects.

If you want full security: use an opaque session ID that maps to server-side data (pure session approach). The session ID `3a9b2c...` is meaningless to an attacker even if they see it — there's no way to derive user 1's session ID from user 42's session ID (cryptographically random).

**Q3: What is the SameSite cookie attribute and which value should you use by default?**

A: SameSite controls whether a cookie is sent on cross-site requests — requests that originate from a different domain than the cookie's domain.

Three values:

- `SameSite=Strict`: Never sent on cross-site requests (most restrictive). Even clicking a link to your site from another site won't include the cookie until the page loads.
- `SameSite=Lax`: Sent on top-level navigation (link clicks) but not on subrequests (AJAX, images, iframes) from other sites. **Default in modern Chrome, Edge, Firefox.**
- `SameSite=None; Secure`: Always sent, including cross-site subrequests. Required for third-party cookies (payment iframes, embedded widgets).

**Default recommendation:** `SameSite=Lax` for most session cookies — provides good CSRF protection while allowing normal link navigation from external sites (like from email links or search results).

Use `SameSite=Strict` when: your app never needs cross-site link navigation to work (e.g., banking app with no external entry points).

Use `SameSite=None; Secure` when: your cookie must work in cross-site iframes (payment SDKs, embedded widgets) or third-party contexts.

### Intermediate Questions

**Q4: A user reports that they get logged out every few requests at random. The app is deployed on 3 EC2 instances. What's the most likely cause?**

A: Classic horizontal scaling problem with in-memory session storage.

The application is storing sessions in server memory (the default in Node.js `express-session` without a store). With 3 EC2 instances behind a load balancer:

- Login request hits Server 1 → session created in Server 1's memory
- Profile request hits Server 2 (ALB's least-connections routing picked Server 2) → "No session found" → 401 → redirect to login

The user logs in again → their next request hits Server 3 → logged out again → cycle.

**Diagnosis:** Check if sticky sessions are enabled (they're not, or they're silently failing). Check where session data is stored.

**Fix:** Move session storage to ElastiCache Redis. With Redis as the session store, all three servers write and read from the same location. Any server can serve any request. ALB can freely distribute load.

Short-term emergency fix (don't keep this): Enable ALB sticky sessions (`AWSALB` cookie). Reduces the symptom but creates hotspots and doesn't solve the root cause.

**Q5: How do you securely implement "Remember Me" functionality?**

A: "Remember Me" is trickier than it appears because it extends the session lifetime significantly, increasing the risk window.

Recommended implementation:

```
1. Regular login (no remember me):
   Session cookie (no Max-Age) → expires when browser closes

2. "Remember me" checked:
   Issue a SEPARATE long-lived persistent cookie with a DIFFERENT mechanism:

   remember_token = crypto.randomBytes(32).toString('hex')
   store_in_db: {
     token_hash: sha256(remember_token),  (store hash, not plaintext)
     user_id: 42,
     expires: 30 days from now,
     created_from_ip: req.ip
   }

   Set-Cookie: remember=42:${remember_token}; HttpOnly; Secure; Max-Age=2592000; SameSite=Lax

3. When user returns (no active session):
   Browser sends: Cookie: remember=42:abc123...
   Server: parse user_id=42, token=abc123
           hash the token, look up hash in DB for user 42
           if found and not expired: create new session
           ROTATE the remember token (new token issued, old invalidated)
           → Token rotation prevents reuse of stolen tokens

4. Logout: Delete both session AND remember token from DB
```

Why not just use a long-lived session cookie? If the session secret rotates (security practice), all long-lived sessions are invalidated. Having a separate "remember me" mechanism in the database makes it easier to manage independently.

**Q6: What is the difference between using RS256 and HS256 for JWT signing, and when would you choose each?**

A: HS256 uses a SYMMETRIC key (one shared secret to both sign and verify). RS256 uses an ASYMMETRIC key pair (private key to sign, public key to verify).

**HS256 (HMAC-SHA256):**

- One secret key used for both signing and verification
- Anyone who can verify JWTs also has the ability to FORGE JWTs (same key)
- Secure ONLY if you keep the key to a single trusted system
- Good for: monolith applications where one service both issues and verifies tokens

**RS256 (RSA-SHA256):**

- Private key (secret): only the Auth Service needs it (only one place to protect)
- Public key (publishable): ANY service can use it to verify, but CANNOT forge tokens
- Ideal for microservices architecture: 20 microservices can all verify JWTs independently
- Multiple services can download the public key from a JWKS endpoint (standard, rotatable)
- Private key compromise = single point of failure → protect it in Secrets Manager / KMS

**Practical choice:**

- Single-service or monolith: HS256 (simpler, equally secure in context)
- Microservices / multi-service: RS256 (public key distribution without risking forgery)
- AWS Cognito: uses RS256 (correctly chosen for multi-service audiences)

### Advanced System Design Questions

**Q7: Design the authentication architecture for a high-traffic SaaS platform serving 10 million users. Include session strategy, scaling approach, and revocation mechanism.**

A: Architecture for 10M users:

**Token strategy: JWT access token (5 minutes) + Refresh token (7 days)**

```
Why 5 minutes for access token:
  Short enough that stolen tokens are useful for very little time
  No need for blocklist (just wait 5 minutes for expiry)

Why 7 days for refresh token (stored server-side):
  7 days = reasonable "stay logged in" UX
  Server-side = INSTANT revocation capability
  Refresh tokens validated once per 5 minutes (not every request)
```

**Refresh token storage:**

```
DynamoDB table (not Redis — lower ops burden at 10M users):
  PK: user_id
  SK: token_id (UUID)
  Attributes: token_hash, device_info, created_at
  TTL: expires_at (auto-cleanup)

  Capacity: 10M users × 3 devices avg × ~200 bytes = ~6GB (trivial in DynamoDB)
  Read: Once per 5 minutes per active user (far less than 10M/5min in practice)
```

**Infrastructure:**

```
Layer 1: CloudFront (edge)
  - Validates static/public requests
  - Cache public API responses

Layer 2: API Gateway (HTTP API)
  - JWT Authorizer: validates access token signature and expiry (built-in, no Lambda)
  - Throttling: 10K req/sec per stage

Layer 3: Auth Lambda (only called for token refresh)
  - Called at most once per 5 minutes per active user
  - Validates refresh token vs DynamoDB
  - Issues new JWT access token

Layer 4: Application services (microservices on ECS)
  - Verify JWT access token independently (RS256 public key from JWKS endpoint)
  - No auth service call per request

Revocation:
  Logout: Delete specific refresh token from DynamoDB → user needs to re-authenticate within 5 minutes
  Revoke all sessions: Delete ALL refresh tokens for user_id → all sessions expire within 5 min
  Security incident (compromised account): Delete all tokens + force password reset
```

**Q8: Your CTO asks: "Why should we use JWT when we can juse use session tokens? JWTs are bigger, harder to revoke, and feel riskier." How do you respond?**

A: The CTO is right that JWTs have real trade-offs. The answer depends on architecture:

**When your CTO is right (prefer sessions):**

- Monolith or single-service application
- Instant revocation is hard requirement (government, banking, healthcare)
- Session store (Redis) is already in infrastructure
- Security review requires auditability of every active session

**When JWT wins:**

- Microservices spread across multiple services
- Each microservice doesn't want to call a central session store (latency, coupling, SPOF)
- Millions of req/sec where session store becomes bottleneck
- Mobile clients that need offline claims (JWT payload readable without network call)
- Cross-organization auth (service B in another company can verify your JWT using your public key)

**The hybrid (best of both worlds):**

- JWT for API-to-API (service mesh authentication) — stateless, fast
- Server session for user browser login — revocable, HttpOnly cookie, stateful
- Most mature architectures use BOTH: Cognito-issued JWTs for service-to-service, server sessions for human users

Concrete answer: "For our user-facing web sessions — sessions in Redis. For service-to-service auth and mobile API access — JWTs. The risk profile and revocation requirements are different."

---

## File Summary

This file covered:

- Concert wristband + library card analogies (session = opaque ID with server lookup; JWT = self-verifying QR code)
- GitHub PAT vs AWS STS credentials as real-world examples of server-side token revocation vs short-lived JWT-like credentials
- Horizontal scaling problem: in-memory sessions break with multiple servers → fix with Redis (or JWT)
- Session fixation attack: always regenerate session ID after login
- JWT security anti-patterns: localStorage (XSS risk), `alg: none` (critical vuln), HS256 in microservices (secret sharing risk), missing `aud` validation
- OAuth 2.0 flow: Google auth → authorization code → token exchange → YOUR session creation
- AWS: ALB sticky sessions (`AWSALB` + `AWSALBCORS` cookies), ElastiCache Redis setup, Cognito User Pool (3 JWT types), DynamoDB TTL for sessions, Secrets Manager for session secrets
- 8 Q&As: session vs persistent cookies, why not user_id in cookie, SameSite default, horizontal scaling symptom, remember-me security, HS256 vs RS256, 10M user session design, session vs JWT trade-offs

**Continue to File 03** for AWS SAA certification traps, 5 comparison tables, Quick Revision mnemonics, and Architect Exercise: session data leakage between tenants.
