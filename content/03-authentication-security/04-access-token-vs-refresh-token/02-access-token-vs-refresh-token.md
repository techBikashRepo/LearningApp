# Access Token vs Refresh Token — Part 2 of 3

### Sections: 5 (Defense Mechanisms), 6 (Architecture Diagram), 7 (Production Scenarios), 8 (AWS Mapping)

**Series:** Authentication & Security → Topic 04

---

## SECTION 5 — Defense Mechanisms

### Defense 1: Token Rotation with Replay Detection (Full Pattern)

```javascript
// The three-part contract of secure refresh token rotation:
// 1. Every refresh token use → old token deleted, new one issued (rotation)
// 2. If a REVOKED token is presented → entire family revoked (replay detection)
// 3. Cookie restriction → refresh token only sent to /auth/refresh, not to all APIs

// Key insight about replay detection:
// Scenario A — Attacker steals refresh token, attacks first:
//   Attacker: POST /auth/refresh + stolen token → success, gets new token pair
//   Old token: REVOKED in DB (rotation)
//   Victim: POST /auth/refresh + original (now-revoked) token
//   System: token found in DB + is_revoked = true → FAMILY REVOCATION → force logout
//   Result: victim gets logged out, notified. Attacker's new tokens also revoked.
//
// Scenario B — Victim rotates first, attacker replays:
//   Victim: POST /auth/refresh → success, new token pair generated
//   Old token: REVOKED (rotation)
//   Attacker: POST /auth/refresh + stolen old token
//   System: token found + is_revoked = true → FAMILY REVOCATION → force logout
//   Result: both tokens dead, victim notified, attacker loses access
//
// Both scenarios: detect and terminate. The victim notices (forced logout).
// No silent long-term access is possible.

class RefreshTokenService {
  async revokeFamily(familyId, reason) {
    await db.query(
      `UPDATE refresh_tokens 
       SET is_revoked = true, revoked_at = NOW(), revoke_reason = $1
       WHERE family_id = $2`,
      [reason, familyId],
    );

    // Notify user: "Suspicious activity detected. All sessions terminated."
    const userId = await this.getUserIdForFamily(familyId);
    await notificationService.sendSecurityAlert(userId, {
      event: "TOKEN_REPLAY_DETECTED",
      action: "ALL_SESSIONS_REVOKED",
      message:
        "Please log in again. If you did not trigger this, change your password.",
    });
  }
}
```

### Defense 2: Separate Cookie Paths — The Critical Isolation Trick

```
PROBLEM: If refresh token is sent with every request (same path=/):
  Every XSS-triggered request carries the refresh token automatically.
  Attacker's injected script: fetch('/api/data') → refresh token included.

  But wait — the refresh token is HttpOnly, so JavaScript can't READ it.
  BUT: the browser still SENDS the cookie with every request to that domain.

  Attacker could trigger: fetch('/auth/refresh') → browser sends refresh cookie.
  Result: attacker gets a new access token from the browser itself.

SOLUTION: Restrict refresh token to /auth path:
  Set-Cookie: __Host-rt=<token>; HttpOnly; Secure; SameSite=Lax; Path=/auth; Max-Age=...

  Now: the browser only includes the refresh token in requests to /auth/*
  GET /api/invoices → refresh token NOT sent (path mismatch)
  POST /auth/refresh → refresh token sent (path matches)

  Attacker's XSS-triggered fetch('/api/anything') → refresh token NOT included.
  Attacker would need to explicitly fetch('/auth/refresh') — which requires knowing
  the endpoint AND the CSRF token if one is enforced. Much harder and noisier.

COOKIE PATH COMPARISON:
  Path=/           → sent to ALL routes on this domain
  Path=/api        → sent only to /api/* routes
  Path=/auth       → sent only to /auth/* routes
  Path=/auth/refresh → sent only to exactly /auth/refresh
```

### Defense 3: Token Comparison — Access vs Refresh Token Properties

```
┌────────────────────┬──────────────────────────────┬──────────────────────────────┐
│ Property           │ Access Token                 │ Refresh Token                │
├────────────────────┼──────────────────────────────┼──────────────────────────────┤
│ Format             │ JWT (signed)                 │ Opaque random string         │
│                    │ Readable if decoded          │ Meaningless bytes            │
├────────────────────┼──────────────────────────────┼──────────────────────────────┤
│ Lifetime           │ 15 minutes                   │ 7-30 days                    │
│                    │ (never extend for UX reasons)│ (product decision)           │
├────────────────────┼──────────────────────────────┼──────────────────────────────┤
│ Verification       │ Cryptographic (no DB)        │ Database lookup (hash check) │
├────────────────────┼──────────────────────────────┼──────────────────────────────┤
│ Frequency of use   │ Every API request            │ Every ~15 minutes only       │
├────────────────────┼──────────────────────────────┼──────────────────────────────┤
│ Accepted by        │ All API endpoints            │ Only /auth/refresh           │
├────────────────────┼──────────────────────────────┼──────────────────────────────┤
│ Cookie path        │ Path=/                       │ Path=/auth                   │
├────────────────────┼──────────────────────────────┼──────────────────────────────┤
│ Revocable?         │ Not directly (or via JTI)    │ Yes, immediately (delete DB) │
├────────────────────┼──────────────────────────────┼──────────────────────────────┤
│ Contents           │ User claims (role, tenant)   │ DB pointer only              │
├────────────────────┼──────────────────────────────┼──────────────────────────────┤
│ Stored in DB?      │ No (stateless verification)  │ Yes (hashed)                 │
├────────────────────┼──────────────────────────────┼──────────────────────────────┤
│ Impact if stolen   │ 15-min window                │ Detectable via rotation      │
└────────────────────┴──────────────────────────────┴──────────────────────────────┘
```

### Defense 4: Handling 401 on the Client (Silent Refresh)

```javascript
// Client-side: intercept 401 responses and silently refresh access token
// This gives users a seamless experience without re-login prompts

// Axios interceptor pattern
let isRefreshing = false;
let failedQueue = []; // Queue requests that came in while refresh was in progress

const processQueue = (error, token = null) => {
  failedQueue.forEach((prom) => {
    if (error) prom.reject(error);
    else prom.resolve(token);
  });
  failedQueue = [];
};

apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;

    // Only intercept 401 (not 403) and only if not already retried
    if (error.response?.status === 401 && !originalRequest._retry) {
      if (isRefreshing) {
        // Another refresh is already in progress — queue this request
        return new Promise((resolve, reject) => {
          failedQueue.push({ resolve, reject });
        }).then(() => apiClient(originalRequest));
      }

      originalRequest._retry = true;
      isRefreshing = true;

      try {
        // POST to /auth/refresh — refresh cookie is sent automatically (path=/auth)
        await apiClient.post("/auth/refresh");
        processQueue(null);
        return apiClient(originalRequest); // Retry original request with new access token
      } catch (refreshError) {
        processQueue(refreshError);
        // Refresh failed — user must log in again
        window.location.href = "/login";
        return Promise.reject(refreshError);
      } finally {
        isRefreshing = false;
      }
    }

    return Promise.reject(error);
  },
);

// User experience:
// Request fails with 401 (access token expired)
// Interceptor silently calls /auth/refresh
// New access token cookie set
// Original request retried automatically
// User sees: a brief 100-200ms delay. No login prompt.
// Multiple simultaneous 401s: queued and replayed after ONE refresh call.
```

---

## SECTION 6 — Architecture Diagram

```
ACCESS TOKEN + REFRESH TOKEN ARCHITECTURE

     ┌─────────────────────────────────────────────────────────────────────┐
     │                     CLIENT (Browser SPA)                            │
     │                                                                     │
     │  Cookies (set by server — client cannot read them):                 │
     │  __Host-at: access_token  (Path=/, Max-Age=900, HttpOnly, Secure)  │
     │  __Host-rt: refresh_token (Path=/auth, Max-Age=2592000, HttpOnly)  │
     │                                                                     │
     │  JavaScript:                                                        │
     │  - Axios interceptor: detects 401, silently calls /auth/refresh    │
     │  - No token values ever visible to JS code                         │
     └──────────┬──────────────────────────────────┬───────────────────────┘
                │                                  │
                │ All API requests                 │ Only to /auth/* routes
                │ (access token auto-attached)     │ (refresh token auto-attached)
                ▼                                  ▼
     ┌──────────────────────┐         ┌─────────────────────────────────┐
     │   API GATEWAY        │         │      AUTH SERVICE               │
     │                      │         │                                 │
     │ JWT Authorizer:      │         │ POST /auth/login:               │
     │ - Verify access token│         │   Verify credentials            │
     │ - Check exp, iss, aud│         │   Issue token pair              │
     │ - Inject claims      │         │   Set both cookies              │
     │                      │         │                                 │
     │ 401 if token invalid │         │ POST /auth/refresh:             │
     │ or expired           │         │   Hash raw refresh token        │
     │                      │         │   Lookup in DB                  │
     │ Client retries with  │         │   Check is_revoked              │
     │ refreshed token      │         │   If revoked: family revocation │
     │ (interceptor handles)│         │   If valid: rotate tokens       │
     └──────────┬───────────┘         │   Issue new access token JWT    │
                │                     │   Issue new refresh token       │
                ▼                     │   Update cookies                │
     ┌──────────────────────┐         │                                 │
     │   LAMBDA FUNCTIONS   │         │ POST /auth/logout:              │
     │   (Business Logic)   │         │   Delete refresh token from DB  │
     │                      │         │   Clear both cookies            │
     │ Uses claims from API │         │                                 │
     │ Gateway context only │         │ POST /auth/logout-all:          │
     │ No JWT re-verify     │         │   Delete ALL user refresh tokens│
     │                      │         │   (all-device logout)           │
     └──────────┬───────────┘         └──────────────┬──────────────────┘
                │                                    │
                ▼                                    ▼
     ┌──────────────────────┐         ┌──────────────────────────────────┐
     │   RDS Aurora         │         │   PostgreSQL (Auth DB)           │
     │   (Application Data) │         │                                  │
     │                      │         │   refresh_tokens table:          │
     │   Tenant-scoped data │         │   - token_hash (SHA-256)         │
     │                      │         │   - user_id, family_id           │
     └──────────────────────┘         │   - is_revoked, expires_at       │
                                      │   - ip_address, user_agent       │
                                      └──────────────────────────────────┘

TOKEN LIFECYCLE:
  Login        →  New family issued. AT cookie: 15min. RT cookie: 30days.
  API request  →  AT cookie sent. API GW verifies. Lambda runs.
  AT expires   →  Request returns 401. Client interceptor calls /auth/refresh.
  Refresh      →  Old RT revoked in DB. New RT issued same family. New AT issued.
  Logout       →  Current RT deleted from DB. Both cookies cleared.
  Logout-all   →  All user RT records deleted. All sessions terminated.
  Replay detected → Entire family revoked. Security alert sent to user.
```

---

## SECTION 7 — Production Scenarios

### Scenario 1: The "Extend Access Token for UX" Mistake

**Context:** A startup PM says: "Users are complaining they keep getting logged out. Extend the access token to 8 hours."

```
THE ENGINEER'S MISTAKE: Extends access token lifetime to 8 hours.
THE SECURITY CONSEQUENCE:
  The "keep getting logged out" was actually correct security behavior.
  Users were noticing their 15-minute tokens expiring AND the silent refresh failing
  (because they had no refresh token rotation + client-side interceptor).

  The RIGHT fix: implement silent refresh (Axios interceptor pattern above).
  The WRONG fix: extend access token to 8 hours.

  After the change:
    Stolen access token window: 8 hours instead of 15 minutes.
    32× larger attack window.

  3 months later: breach detected.
    CloudWatch: API calls from IP geolocated to Eastern Europe at 3am.
    All calls to GET /users/*/export (bulk data endpoint).
    Session appeared to belong to a senior data engineer who was asleep.

  Investigation:
    The data engineer's laptop was on a hotel WiFi 6 months ago.
    A phishing site harvested their access token from localStorage.
    8-hour access token → attacker waited until 3am (low risk of detection).
    Refresh token was in HttpOnly cookie (that was correctly set up) but
    the server also had a CORS misconfiguration that allowed the attacker's
    origin to make credentialed requests → they could refresh tokens too.

FIX (root cause, not symptom):
  1. Silent refresh interceptor: users experience smooth sessions without 8-hour tokens.
  2. Access token: 15 minutes. Non-negotiable for sensitive apps.
  3. Refresh token: HttpOnly cookie, restricted path, with rotation + replay detection.
  4. CORS: restrict allowed origins to production domain only.
```

### Scenario 2: Refresh Token Rotation Catching an Active Attack

**Context:** MedConnect — a healthcare communications platform. Production incident.

```
Timeline:
  09:15 — Dr. Chen logs in on their hospital laptop. AT (15min) + RT (30days) issued.
  09:30 — Dr. Chen uses the app normally. AT expired → client refreshes silently.
           RT rotated: RT_v1 revoked, RT_v2 issued in same family.
  10:00 — RT_v2 → RT_v3. Normal rotation.

  10:15 — ATTACK: Attacker has somehow obtained RT_v2 (old, already rotated/revoked).
           Attacker: POST /auth/refresh with RT_v2
           System looks up RT_v2 hash in DB: is_revoked = TRUE (rotated at 10:00)
           REPLAY DETECTION TRIGGERED.
           System: revoke entire token family (RT_v3 also revoked).
           Security alert: emailed and pushed to Dr. Chen:
           "Your session was terminated due to suspicious activity."

  10:15 — Dr. Chen's existing session in the browser becomes invalid.
           Next request: 401 → client tries silent refresh → 401 → redirect to login.
           Dr. Chen sees: "Your session was terminated for security reasons. Please log in again."

  10:16 — Dr. Chen logs in again. New family issued. Attacker's access is dead.

  10:30 — Security team reviews:
           Attacker had RT_v2 (issued 09:30, rotated at 10:00, reused at 10:15).
           RT_v2 source: identified as stolen from Dr. Chen's personal iPhone
                         (hospital email account also compromised in a phishing campaign).
           Action: Dr. Chen's account forced to change password, MFA enrolled.

KEY LESSON:
  Without rotation: attacker uses RT from 09:30 indefinitely for 30 days silently.
  With rotation + replay detection: discovered and stopped within 15 minutes.
  The physician was notified within seconds. Regulatory breach window: < 15 minutes.
  HIPAA breach notification threshold: not triggered (no data exfiltration detected).
```

---

## SECTION 8 — AWS Mapping

### AWS Services for Token Pair Management

```
┌──────────────────────────┬─────────────────────────────────────────────────────┐
│ AWS Service              │ Role in Token Pair Architecture                     │
├──────────────────────────┼─────────────────────────────────────────────────────┤
│ Cognito User Pools       │ Manages token pair issuance natively               │
│                          │ Issues: ID + access (JWT) + refresh (opaque) tokens │
│                          │ Refresh token rotation: configurable in console     │
│                          │ Rotation + revocation: built-in                     │
├──────────────────────────┼─────────────────────────────────────────────────────┤
│ API Gateway JWT          │ Verifies access token signature + claims            │
│ Authorizer               │ Refresh token: never seen by API Gateway            │
│                          │ Refresh endpoint: routed to Auth Service Lambda     │
├──────────────────────────┼─────────────────────────────────────────────────────┤
│ RDS Aurora               │ Refresh token store (hashed tokens, family chains)  │
│ (or DynamoDB)            │ DynamoDB alternative: TTL attribute for auto-expiry │
│                          │ Audit trail: full rotation history queryable        │
├──────────────────────────┼─────────────────────────────────────────────────────┤
│ ElastiCache Redis        │ Access token JTI revocation blocklist               │
│                          │ Recent rotation record cache (fast replay check)    │
├──────────────────────────┼─────────────────────────────────────────────────────┤
│ SES (Simple Email)       │ Security alert: "Suspicious session activity"       │
│                          │ Triggered on: replay detection, impossible travel   │
├──────────────────────────┼─────────────────────────────────────────────────────┤
│ CloudWatch Metrics       │ token_refresh_count, token_replay_detected_count    │
│                          │ Dashboard: refresh failure rate per user/tenant     │
├──────────────────────────┼─────────────────────────────────────────────────────┤
│ Secrets Manager          │ RSA private key for access token signing            │
│                          │ Refresh token encryption key (if encrypting at rest)│
└──────────────────────────┴─────────────────────────────────────────────────────┘
```

### DynamoDB as Refresh Token Store (Alternative to RDS)

```javascript
// DynamoDB benefits for refresh tokens:
// - TTL attribute: auto-deletion of expired tokens (no cron job needed)
// - Single-table design: token lookups by hash O(1)
// - Family queries: GSI on family_id for batch revocation

// DynamoDB table design
const refreshTokensTableSchema = {
  TableName: "RefreshTokens",
  KeySchema: [{ AttributeName: "tokenHash", KeyType: "HASH" }],
  GlobalSecondaryIndexes: [
    {
      IndexName: "FamilyIndex",
      KeySchema: [{ AttributeName: "familyId", KeyType: "HASH" }],
      Projection: { ProjectionType: "ALL" },
    },
    {
      IndexName: "UserIndex",
      KeySchema: [{ AttributeName: "userId", KeyType: "HASH" }],
      Projection: { ProjectionType: "ALL" },
    },
  ],
  // TTL: DynamoDB automatically deletes items after expiresAt timestamp
  TimeToLiveSpecification: {
    AttributeName: "expiresAt", // Unix epoch timestamp
    Enabled: true,
  },
};

// Store new refresh token
async function storeRefreshToken(
  userId,
  tokenHash,
  familyId,
  expiresInDays = 30,
) {
  await dynamodb
    .put({
      TableName: "RefreshTokens",
      Item: {
        tokenHash,
        userId,
        familyId,
        parentId: null,
        isRevoked: false,
        createdAt: Math.floor(Date.now() / 1000),
        expiresAt: Math.floor(Date.now() / 1000) + expiresInDays * 86400, // TTL
      },
    })
    .promise();
}

// Revoke entire family (replay detection or logout-all)
async function revokeFamilyTokens(familyId) {
  // Query all tokens in this family
  const result = await dynamodb
    .query({
      TableName: "RefreshTokens",
      IndexName: "FamilyIndex",
      KeyConditionExpression: "familyId = :fid",
      ExpressionAttributeValues: { ":fid": familyId },
    })
    .promise();

  // Batch update: set isRevoked = true for all
  const writes = result.Items.filter((t) => !t.isRevoked).map((token) => ({
    Update: {
      TableName: "RefreshTokens",
      Key: { tokenHash: token.tokenHash },
      UpdateExpression:
        "SET isRevoked = :true, revokedAt = :now, revokeReason = :reason",
      ExpressionAttributeValues: {
        ":true": true,
        ":now": Math.floor(Date.now() / 1000),
        ":reason": "replay_attack",
      },
    },
  }));

  if (writes.length) {
    await dynamodb.transactWrite({ TransactItems: writes }).promise();
  }
}
```
