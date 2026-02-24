# Cookies vs Sessions — Part 3 of 3

### Topic: AWS Certification, Comparison Tables, Quick Revision, Architect Exercise

**Series:** Networking Fundamentals → System Design → AWS Solutions Architect
**Sections Covered:** 9, 10, 11, 12

---

## SECTION 9 — AWS SAA Certification Focus

### Core Exam Concepts

The SAA exam tests session management in the context of scalable architectures. Key themes:

1. **Sticky sessions are an anti-pattern** for high-availability, scalable architectures
2. **ElastiCache Redis** is the recommended solution for distributed session storage
3. **Cognito** issues JWTs (ID token, access token, refresh token) for user pool auth
4. **DynamoDB TTL** can replace Redis for serverless/lower-traffic scenarios

### AWS SAA Exam Trap 1 — Sticky Sessions Don't Survive Instance Failure

**Scenario:** E-commerce site uses ALB with sticky sessions enabled. Traffic is healthy. During peak shopping season, one EC2 instance fails a health check and is removed from the target group. Users start reporting they've been "logged out." Why?

**Answer:** ALB sticky sessions bind a user to a specific target via the `AWSALB` cookie. When the target is removed (health check failure, scale-in), the cookie value points to a dead target. ALB cannot resolve this — it picks a NEW target and sets a NEW `AWSALB` cookie.

If sessions are in the dead server's memory: they're gone. Users are logged out. Shopping carts are lost.

**Fix:** Move sessions to ElastiCache Redis. When the target instance fails, the new target can look up the session in Redis — user experience is uninterrupted.

**Exam key:** Sticky sessions are not HA. Session persistence requires a centralized data store (ElastiCache/DynamoDB), not load balancer affinity.

### AWS SAA Exam Trap 2 — AWSALB and AWSALBCORS Are Both Required

**Scenario:** Users on mobile apps that make API calls get logged out even with sticky sessions enabled on the ALB. Desktop web users are fine. What is happening?

**Answer:** Mobile apps and JavaScript SPAs making cross-origin API requests don't include the `AWSALB` stickiness cookie when the request is cross-origin — unless `AWSALBCORS` is also issued.

When CORS is involved (Origin header present in request), browsers include cookies based on `SameSite` policy. ALB sets `AWSALB` with `SameSite=None; Secure` but ALSO sets `AWSALBCORS` — they're both needed for the stickiness to work in cross-site contexts.

With stickiness enabled, if `AWSALBCORS` is not being set properly (older ALB configurations), CORS requests don't maintain stickiness even though same-origin requests do.

**Fix:** This is usually automatically handled when you enable stickiness via the console or CloudFormation. The root fix is getting rid of sticky sessions entirely and using Redis.

**Exam key:** ALB sets two stickiness cookies: `AWSALB` (same-site) and `AWSALBCORS` (cross-site). Both needed for full stickiness.

### AWS SAA Exam Trap 3 — Cognito Token Types

**Scenario:** You build an API with API Gateway + Lambda. The frontend uses Amazon Cognito for auth. Your Lambda function needs to know the user's email address. Which token should you use?

**Answer:** The **ID token**, not the access token.

```
Cognito ID Token:  Contains identity claims
  {
    "sub": "user-pool-id-here",
    "email": "alice@example.com",
    "name": "Alice Smith",
    "email_verified": true,
    "cognito:username": "alice",
    "custom:tenant_id": "acme-corp",  ← custom attributes
    "aud": "your-app-client-id"
  }

Cognito Access Token: Contains authorization scopes
  {
    "sub": "user-pool-id-here",
    "scope": "openid email profile",
    "token_use": "access"              ← "access" not "id"
  }
  NOTE: Access token does NOT contain email, name, or custom attributes!

Cognito Refresh Token: Opaque (not JWT)
  Used server-to-Cognito to get new ID+access tokens
  Not sent to API; stored securely client-side
```

**For API Gateway + Cognito Authorizer:** API Gateway validates the token and passes claims via `$context.authorizer.claims` — you can access `email`, `sub`, and custom attributes in Lambda.

**Exam key:** ID token = who the user IS (use for user info). Access token = what the user CAN DO (use for authorizing API access). Only ID token has custom attributes.

### AWS SAA Exam Trap 4 — ElastiCache Redis vs Memcached for Sessions

**Scenario:** You need session storage for a web application requiring high availability and data persistence. ElastiCache offers Redis and Memcached. Which do you choose?

**Answer:** Redis, every time for sessions. Here's why:

```
For session storage, you need:

1. Persistence: Session data should survive cache restart
   Redis: ✅ Optional persistence (RDB snapshots, AOF logs)
   Memcached: ❌ In-memory only, no persistence

2. Replication / Multi-AZ HA:
   Redis: ✅ Primary-replica replication, automatic failover
   Memcached: ❌ No replication between nodes

3. Complex data structures:
   Redis: ✅ Hashes, sorted sets, lists (natural for session data)
   Memcached: ❌ Simple key-value only

4. TTL on individual keys:
   Redis: ✅ EXPIRE command (per-key TTL)
   Memcached: ✅ Also supports TTL per item

Session use case = Redis always. Memcached = simple high-performance cache for frequently-read data with no persistence requirement.
```

**Exam key:** Redis for sessions (Multi-AZ, persistence, replication). Memcached for simple volatile caching.

### AWS SAA Exam Trap 5 — DynamoDB TTL for Serverless Session Storage

**Scenario:** You're building a serverless application (Lambda + API Gateway). You want per-user sessions but don't want to manage ElastiCache Redis clusters. What's the alternative?

**Answer:** DynamoDB with TTL attribute for session storage.

```
Setup:
  Table: sessions
  Partition key: session_id (String)
  Attributes:
    user_id: String
    email: String
    roles: List
    created_at: Number (Unix timestamp)
    expires_at: Number (Unix timestamp) ← TTL attribute

Enable TTL:
  DynamoDB Console → Table → Time to Live → Attribute: expires_at
  DynamoDB automatically deletes items when current_time > expires_at
  (Deletion happens within 48h of expiry, not necessarily instant)

Read/Write in Lambda:
  Create session: PutItem with expires_at = now + 86400
  Validate session: GetItem by session_id, check expires_at > now
  Invalidate session: DeleteItem (logout), or UpdateItem to set expires_at = now - 1

Trade-offs vs Redis:
  Redis: < 1ms latency, in-memory, persistence optional
  DynamoDB: 1-10ms latency, fully managed, serverless native, pay-per-request

  For Lambda: DynamoDB preferred (no VPC required, no idle cost, no cluster maintenance)
  For EC2/ECS apps: Redis preferred (lower latency, connection pooling)
```

---

## SECTION 10 — Comparison Tables

### Table 1: Cookies vs Session Tokens vs JWT — Core Comparison

| Dimension             | Cookies (raw)                             | Server Sessions                          | JWT                                     |
| --------------------- | ----------------------------------------- | ---------------------------------------- | --------------------------------------- |
| Where state lives     | CLIENT (browser)                          | SERVER (Redis/DB)                        | CLIENT (signed token)                   |
| What's in cookie      | User data directly                        | Opaque session ID only                   | N/A (token in Auth header or cookie)    |
| Revocation            | Delete cookie (client-side, not enforced) | Delete server session (instant)          | Hard (wait for expiry or use blocklist) |
| Size                  | Up to 4KB                                 | ~40 bytes (ID only)                      | 500B–2KB (payload-dependent)            |
| DB lookup per request | No                                        | Yes (Redis O(1))                         | No (signature verify only)              |
| Horizontal scaling    | Easy (cookie follows client)              | Requires shared session store            | Easy (any server verifies)              |
| Security on theft     | Attacker has user data                    | Attacker has opaque ID → can impersonate | Attacker can use until expiry           |
| Cross-domain auth     | Same domain only                          | Same domain only                         | Any domain accepting the public key     |
| Best for              | Preferences, cart (unsigned = risky)      | User login (high security)               | Microservices API auth, mobile          |

### Table 2: Cookie Security Flags — Choose Correctly

| Scenario                            | Correct Flags                                     | Reasoning                                                                                                 |
| ----------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Session ID for authenticated user   | `HttpOnly; Secure; SameSite=Lax; Max-Age=86400`   | HttpOnly = no XSS theft; Secure = HTTPS only; Lax = CSRF protection while allowing login links from email |
| Banking/financial session           | `HttpOnly; Secure; SameSite=Strict; Max-Age=1800` | Strict = never cross-site; 30 min = short timeout                                                         |
| Remember Me token                   | `HttpOnly; Secure; SameSite=Lax; Max-Age=2592000` | As secure as session; 30-day expiry                                                                       |
| User preference (dark mode)         | `Secure; SameSite=Lax; Max-Age=31536000`          | No HttpOnly needed (UI needs to read it); 1 year expiry                                                   |
| Shopping cart (anonymous)           | `Secure; SameSite=Lax; Max-Age=86400`             | Anonymous cart fine to read via JS; 24h expiry                                                            |
| Third-party widget / payment iframe | `SameSite=None; Secure`                           | Must work in cross-site iframe; Secure required with None                                                 |

### Table 3: Session Storage Options

| Storage Option       | Latency  | HA Support            | Serverless-Friendly | Cost                   | Best For               |
| -------------------- | -------- | --------------------- | ------------------- | ---------------------- | ---------------------- |
| Server memory        | < 0.1ms  | ❌ No (single server) | ❌ No               | Free                   | Development only       |
| Redis (self-managed) | < 1ms    | Manual                | ❌ No               | Low (EC2)              | Advanced control       |
| ElastiCache Redis    | < 1ms    | ✅ Multi-AZ           | Needs VPC           | Low-Med                | EC2/ECS stateful apps  |
| DynamoDB             | 1-10ms   | ✅ Built-in           | ✅ Yes              | Variable (per-request) | Lambda/serverless      |
| RDS PostgreSQL       | 5-50ms   | ✅ Multi-AZ           | ❌ Slow             | Medium                 | Sessions + other data  |
| Cognito              | External | ✅ Managed            | ✅ Yes              | Per MAU                | Full managed user pool |

### Table 4: JWT Security Checklist

| Security Check         | Right Approach                            | Wrong Approach                                                     |
| ---------------------- | ----------------------------------------- | ------------------------------------------------------------------ |
| Algorithm              | `RS256` or `ES256` (asymmetric)           | `HS256` in microservices, `none`, `RS256` but not validating       |
| Expiry                 | Short (5-15 min) + refresh token          | Long-lived (24h+) access tokens                                    |
| Storage                | HttpOnly cookie or secure memory          | `localStorage` (XSS risk)                                          |
| Audience validation    | Always check `aud` claim                  | Accepting tokens from any audience                                 |
| Issuer validation      | Always check `iss`                        | Trusting any issuer                                                |
| Signature verification | Always verify, use correct key            | `jwt.decode()` without verification (real bug in prod apps)        |
| Revocation             | Refresh token DB + short access token TTL | No revocation mechanism                                            |
| Sensitive claims       | User ID, roles, tenant ID only            | Passwords, secrets, PII in payload (JWT is base64, not encrypted!) |

### Table 5: Auth Scenarios → Recommended AWS Architecture

| Use Case                       | Recommended Pattern           | AWS Services                                            |
| ------------------------------ | ----------------------------- | ------------------------------------------------------- |
| Web app login (10K-100K users) | Server session + Redis        | ALB + EC2/ECS + ElastiCache Redis                       |
| SPA/mobile app auth            | JWT (Cognito) + refresh token | Cognito User Pool + API Gateway JWT authorizer          |
| Serverless API auth            | JWT (Cognito)                 | API Gateway HTTP API + Cognito authorizer               |
| Microservices internal auth    | JWTs or IAM roles             | IAM roles for service-to-service; Cognito for user JWTs |
| Multi-tenant SaaS              | JWT with tenant claim         | Cognito + custom attribute `custom:tenant_id` in JWT    |
| B2B SSO                        | SAML 2.0 or OIDC federation   | Cognito identity pool or IAM Identity Center            |
| Admin console access           | IAM Identity Center           | AWS SSO with SAML integration                           |

---

## SECTION 11 — Quick Revision

### 10 Key Points

1. **HTTP is stateless — cookies and sessions give it memory.** Every HTTP request is independent. Cookie in `Cookie` header carries state back to server on every request to the same domain.

2. **Opaque session ID > user data in cookie.** Session cookie should contain only a random ID. Server looks up the ID in Redis/DB to find actual user data. Storing user data directly means client can potentially alter it.

3. **HttpOnly prevents XSS token theft.** JavaScript cannot read HttpOnly cookies. Even if an XSS payload runs, it cannot steal the session cookie via `document.cookie`.

4. **SameSite=Lax is the modern default.** Prevents CSRF POST attacks while still allowing normal link navigation from external sites. `SameSite=Strict` blocks even legit link navigation (like clicking an email link to your site).

5. **Three scaling options: JWT (stateless), Redis (shared), sticky sessions (anti-pattern).** Only the first two are production-appropriate. Sticky sessions are fragile and create hot spots.

6. **JWT payload is base64-encoded, NOT encrypted.** Anyone can decode it (but not forge it). Never put passwords, secrets, or sensitive PII in JWT payload. It's like writing in invisible ink that everyone has a UV light for.

7. **JWT revocation is hard — use short access tokens + refresh tokens.** 5-15 minute access tokens expire fast enough that revocation is rarely needed. Refresh tokens in DB provide actual revocation control.

8. **Session fixation: always regenerate session ID after login.** Pre-auth session ID must be discarded. New session ID issued post-authentication. Prevents session fixation attacks.

9. **ElastiCache Redis for stateful apps; DynamoDB for serverless.** Redis = sub-millisecond, requires VPC and cluster management. DynamoDB = serverless native, 1-10ms, TTL for auto-cleanup.

10. **Cognito ID token has user attributes; access token does not.** Use ID token to get user's email, name, custom attributes. Access token for authorization scopes. Refresh token (opaque) for getting new tokens.

### 30-Second "I Know This" Explanation

Cookies and sessions solve HTTP's statelessness problem — the fact that every HTTP request is independent with no memory. A cookie is a small piece of data in a `Set-Cookie` header that the browser stores and sends back automatically on every subsequent request. A session uses a cookie to store only an opaque random ID; the real user data lives server-side in Redis. JWTs flip this: all user data is in the token itself, signed cryptographically so it can't be tampered with, and any server can verify it without a central lookup. The key architectural choice is: server sessions need a shared Redis store for horizontal scaling, while JWTs are stateless by design but hard to revoke. In AWS: ALB sticky sessions are a band-aid that breaks on instance failure; ElastiCache Redis is the correct session store; Cognito is the managed user pool that issues JWTs for serverless auth.

### Mnemonics

**"HISS" for cookie security flags:**

- **H**ttpOnly (no JavaScript theft)
- **I**s Secure (HTTPS only)
- **S**ameSite=Lax (CSRF protection)
- **S**hort Max-Age (limit exposure window)

**"JWT = Just Without Trust (until verified)"**

- Anyone CAN read the payload (base64 encoded, not encrypted)
- But cannot FORGE it (signature protects integrity)
- Server TRUSTS it only AFTER verifying signature

**"Sessions REDIS, JWTs REFRESH"**

- Sessions need REDIS to scale
- JWTs need REFRESH tokens to revoke

**"The Three Rs of Session Security"**

- **R**andom ID (not predictable, not sequential)
- **R**egenerate after login (prevent session fixation)
- **R**evoke on logout (delete from Redis immediately)

**"Cognito Token Roles"**

- **I**D token = **I**dentity (who you are — email, name, custom attributes)
- **A**ccess token = **A**uth scope (what you can do — scope, token_use=access)
- **R**efresh token = **R**enew (opaque, long-lived, stored securely)

---

## SECTION 12 — Architect Thinking Exercise

### The Problem

**Production Incident — Session Data Visible Across Tenants**

You run a multi-tenant SaaS HR platform. Customers include Acme Corp, BetaCo, and GammaCorp. Each company's HR administrators log in with their company credentials to manage their own employees.

On a Monday morning, you receive the following support ticket:

> "I'm the HR admin at Acme Corp. When I logged in this morning, I could see employee data from what appears to be another company. I saw emails with @betaco.com domains. This is a serious data breach concern."

Your CTO immediately escalates. You check monitoring: no unusual traffic spikes, no 5xx errors, no unusual external IPs. The HR admin at Acme was legitimately authenticated (user 1042, Acme Corp tenant). No signs of external intrusion.

What is likely happening and how do you diagnose it?

---

_Think through the problem before reading further._

---

_What can cause one tenant to see another tenant's data without any hacking involved?_

---

_Think about session storage, caching, and data boundaries._

---

### The Solution

**Root Cause: Session Data Bleed via Cache Key Collision**

After investigation, the root cause was a combination of two bugs:

**Bug 1: Incorrect cache key in Redis for employee lists**

```javascript
// BROKEN code — cache key doesn't include tenant ID
app.get("/employees", async (req, res) => {
  const cacheKey = "employee_list"; // ← same key for ALL tenants!
  const cached = await redis.get(cacheKey);

  if (cached) {
    return res.json(JSON.parse(cached)); // returns first tenant's data to ALL tenants!
  }

  const employees = await db.query(
    "SELECT * FROM employees WHERE tenant_id = ?",
    [req.user.tenantId],
  );

  await redis.setex(cacheKey, 300, JSON.stringify(employees));
  res.json(employees);
});
```

**What happened:**

1. BetaCo admin logs in at 9:00 AM → calls GET /employees → cache miss → DB query returns BetaCo employees → stored in Redis as `employee_list`
2. Acme Corp admin logs in at 9:02 AM → calls GET /employees → cache HIT (from step 1) → gets BetaCo's employee list

**Fix:**

```javascript
// CORRECT — cache key includes tenant ID
const cacheKey = `employee_list:${req.user.tenantId}`;
// BetaCo: "employee_list:betaco-corp-id"
// Acme: "employee_list:acme-corp-id"
// Separate cache entries per tenant → no cross-tenant bleed
```

**Bug 2 (contributing factor): Session not checking tenant isolation**

```javascript
// BROKEN — session validation only checks user auth, not tenant context
function requireAuth(req, res, next) {
  const session = await redis.hgetall(`sessions:${req.cookies.sid}`)
  if (!session || session.expired) return res.status(401).send()

  req.user = { id: session.user_id }  // ← missing: tenantId not loaded!
  next()
}

// CORRECT — session includes tenant context
function requireAuth(req, res, next) {
  const session = await redis.hgetall(`sessions:${req.cookies.sid}`)
  if (!session || session.expired) return res.status(401).send()

  req.user = {
    id: session.user_id,
    tenantId: session.tenant_id  // ← tenant ID always carried in session
  }
  next()
}
```

### Incident Response Steps

**Immediate (within 30 minutes):**

1. Flush the problematic cache keys: `redis-cli --scan --pattern "employee_list*" | xargs redis-cli del`
2. Temporarily disable the cache (return direct DB results while fix is deployed)
3. Identify all affected sessions: check Redis and application logs for which users saw cross-tenant data
4. Notify affected customers (legal/compliance obligation)

**Short-term fix (deploy within hours):** 5. Fix cache key to include tenantId in ALL cache keys (search codebase for any other missing tenant isolation) 6. Add tenant ID to session middleware (always carry tenantId in `req.user`) 7. Add integration test: log in as Tenant A user, verify GET /employees returns ONLY Tenant A data

**Long-term prevention:** 8. Add tenant isolation as a middleware-level enforcement (not just convention):

```javascript
// Every DB query goes through this wrapper:
async function tenantSafeQuery(sql, params, tenantId) {
  // Automatically append AND tenant_id = ? to all WHERE clauses
  // This is a database-level row-security pattern
  // Alternative: PostgreSQL Row Level Security (RLS)
}
```

9. Add automated test: multi-tenant isolation test suite runs on every PR (simulates two tenants and verifies no data cross-contamination)
10. Code review checklist: any new endpoint that retrieves data must have tenant_id in cache key AND in WHERE clause

### Architecture Lesson

Multi-tenant session security requires THREE separate layers of isolation:

**Layer 1 — Session isolation:** Session A cannot access Session B's data (basic — enforced by session ID)

**Layer 2 — Tenant isolation in queries:** Database queries MUST filter by `tenant_id`. Row-Level Security in PostgreSQL enforces this at the DB level regardless of application code.

**Layer 3 — Tenant isolation in cache:** Cache keys MUST include tenant identifier. `employee_list` is wrong. `employee_list:{tenantId}` is correct. Without this, shared caches become cross-tenant information leaks.

This is a class of bug that unit tests routinely miss (they test one tenant in isolation). Multi-tenant integration tests that specifically test cross-tenant isolation are essential for SaaS platforms.

---

## File Summary — Topic 18 Complete

**All three files together cover:**

**File 01 (Sections 1-4):** HTTP statelessness problem; hotel key card + membership badge analogies; cookie anatomy (HttpOnly/Secure/SameSite/Max-Age); server session lifecycle (random ID → Redis storage → lookup → invalidate); JWT structure (header.payload.signature, RS256 asymmetric verification, revocation via refresh tokens); when to use each; ASCII diagrams for session flow, JWT refresh token flow, CSRF + SameSite defense; step-by-step session and JWT flows.

**File 02 (Sections 5-8):** Concert wristband + library card analogies; GitHub PAT vs AWS STS as real examples; horizontal scaling problem (in-memory sessions break with multiple servers); session fixation attack + fix; JWT anti-patterns (localStorage, alg:none, HS256 in microservices, missing aud); OAuth 2.0 flow with Google; AWS ALB sticky sessions, ElastiCache setup, Cognito tokens, DynamoDB TTL, Secrets Manager; 8 Q&As.

**File 03 (Sections 9-12):** AWS SAA traps (sticky sessions not HA, AWSALB+AWSALBCORS pair, Cognito ID vs access token, Redis vs Memcached, DynamoDB TTL serverless sessions); 5 comparison tables (cookies vs sessions vs JWT, cookie flags, session storage options, JWT security checklist, architecture by use case); HISS/Three Rs mnemonics; Architect Exercise — multi-tenant cache key collision causing cross-tenant employee data leak → root cause: missing `tenantId` in Redis cache keys and session middleware.
