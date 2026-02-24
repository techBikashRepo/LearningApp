# CSRF Attack — Part 1 of 3

### Sections: 1 (Attacker Intuition), 2 (Why It Exists), 3 (Core Technical), 4 (Attack Flows)

**Series:** Authentication & Security → Topic 06

---

## SECTION 1 — Think Like an Attacker First

### The Attacker's Mental Model

Before implementing CSRF protection, understand exactly what the attacker is exploiting. CSRF isn't about stealing credentials — it's about **borrowing the victim's browser as a puppet**.

```
ATTACKER'S CORE INSIGHT:

Your browser automatically attaches cookies to every request to a domain.
The server sees a valid session cookie → it trusts the request.
The server does NOT verify who INITIATED that request.

ATTACK SURFACE:
  * The victim is logged into bank.com (has valid session cookie).
  * The victim visits attacker.com (an evil website).
  * attacker.com contains a hidden form that submits to bank.com/transfer.
  * The victim's browser submits the form — automatically including bank.com cookies.
  * bank.com sees: valid session + valid request = executes transfer.
  * Victim never clicks anything deliberately. Attacker never needed the password.

THE ATTACKER ASKS:
  1. Does the target site use cookies for session? (Most do)
  2. Does the target site have state-changing endpoints (transfer, update, delete)?
  3. Can I get an authenticated user to visit a page I control?
  4. Does the target site validate WHERE requests originate from?

If 1-3 are yes and 4 is no: VULNERABLE.
```

### Attack Scope

```
WHAT A CSRF ATTACK CAN DO (if endpoint is vulnerable):
  * Transfer money: POST /api/transfer?to=attacker&amount=9000
  * Change email address: POST /account/update-email (can lock user out of account)
  * Change password: POST /account/change-password (full account takeover)
  * Enable admin: POST /admin/promote-user?id=attacker_id
  * Delete data: POST /api/posts/delete-all
  * Send messages as victim: POST /api/messages/send

WHAT CSRF CANNOT DO (despite the confused browser):
  * Read responses (it's a cross-origin REQUEST, not cross-origin READ)
  * Steal session cookies (attacker triggers request but never sees server response)
  * Bypass HTTPS (the browser encrypts the CSRF request too)

CSRF = WRITE access via forged requests. Not READ access to responses.
This distinction matters: GET requests with CSRF can't read data,
but can trigger state changes if the server uses GET for mutations (OWASP A01).
```

---

## SECTION 2 — Why This Exists: The Historical and Technical Problem

### The Browser's Original Design

```
HTTP was designed as a stateless document-fetching protocol.
Cookies were added (1994, Lou Montulli) to add stateful sessions.

The cookie model:
  "When I receive a cookie for domain X, I will send it with ALL future requests to X."

This was a feature, not a bug: it enables login states across page navigations.
BUT: the cookie is sent for ALL requests to X — including those INITIATED by attacker.com.

BROWSER SAME-ORIGIN POLICY (SOP):
  JavaScript cannot READ cross-origin responses (XHR, fetch to different domain blocked).
  BUT: HTML forms, img tags, and link navigations CAN SEND cross-origin requests.

  <form action="https://bank.com/transfer" method="POST">  ← No SOP restriction on SENDING
  <img src="https://bank.com/delete-account?id=123">       ← Browser fetches, sends cookies

  SOP restricts reading. It does NOT restrict sending.
  CSRF exploits the gap between "can't read responses" and "can still trigger requests."
```

### Real Incidents

**The Samy Worm — MySpace, 2005:**

```
Author: Samy Kamkar
Impact: 1 million MySpace profiles compromised in 20 hours (fastest-spreading worm in history)

HOW CSRF WAS INVOLVED:
  Samy found that MySpace allowed certain HTML in profiles.
  He embedded JavaScript that (among other things):
    - Sent a CSRF request to add him as a friend on everyone who viewed his profile.
    - Copied itself to the viewer's profile (combining XSS + CSRF).

  When you viewed Samy's profile → browser ran his script →
  script sent a request to MySpace's "add friend" endpoint (with YOUR cookies) →
  Samy added as YOUR friend → your profile now contains the same script →
  everyone who views YOUR profile is also infected.

  Result: 1 million friend requests to Samy in 20 hours. MySpace shut down for 12 hours.
  Samy Kamkar: probation + 90 days community service.
```

**Banking CSRF Attack Pattern:**

```
DOCUMENTED ATTACK PATTERN (multiple incidents, not one company):

Attacker sets up a website (e.g., free-movie-stream.evil)
Embeds hidden iframe:
  <iframe style="display:none" src="https://yourbank.com/transfer?to=1234&amount=5000">

User receives phishing email: "Watch the new movie..."
User is logged into their bank in a background tab (common)
User clicks link → browser loads evil site → iframe fires →
→ Bank receives: POST /transfer with valid session cookie
→ Transfer completes

VARIANT: Auto-submitting form on page load:
  <body onload="document.forms[0].submit()">
    <form action="https://bank.com/transfer" method="POST" style="display:none">
      <input name="to" value="attacker_account">
      <input name="amount" value="9000">
    </form>
  </body>
```

**Netflix CSRF, 2006:**

```
Researcher (GNUCITIZEN): Netflix had no CSRF protection on critical account operations.
Discovered that visiting a crafted URL would:
  - Add a DVD to the queue (GET endpoint — misuse of GET for state change)
  - Change billing email to attacker's email
  - Ship the DVD to a new address

All without any user interaction beyond visiting a single link.
Netflix patched within days. Demonstrated CSRF on a high-profile consumer service.
```

---

## SECTION 3 — Core Technical Deep Dive

### How Browsers Decide to Send Cookies: SameSite Attribute

```
SAMSITE = browser-side first line of defense against CSRF (modern browsers)

Cookie without SameSite:
  Set-Cookie: sessionId=abc; HttpOnly; Secure
  → Browser default (older): "Lax" in Chrome since 2021, but legacy: "None" (unsafe)
  → Sent on ALL cross-site requests including img tags, form POSTs from attacker.com

SameSite=Strict:
  Set-Cookie: sessionId=abc; HttpOnly; Secure; SameSite=Strict
  → Cookie NEVER sent on cross-site requests.
  → Result: CSRF impossible using this cookie as auth.
  → Tradeoff: If user clicks a link from email/external site to YOUR site:
               cookie is NOT sent → user appears logged out on first request.
               Next page load: cookie sent (now same-site).
               Breaks: OAuth flows, payment redirects, external links.

SameSite=Lax:
  Set-Cookie: sessionId=abc; HttpOnly; Secure; SameSite=Lax
  → Cookie sent on TOP-LEVEL navigations (clicking a link → GET request).
  → Cookie NOT sent on cross-origin POSTs, image loads, subrequests.
  → Breaks: POST-based OAuth flows? Some edge cases. Generally fine for most apps.
  → Browser default since Chrome 80 (2020): if you don't set SameSite, you get Lax.
  → STILL VULNERABLE TO: GET-based CSRF (if your server changes state on GET requests)

SameSite=None:
  Set-Cookie: sessionId=abc; HttpOnly; Secure; SameSite=None
  → Cookie sent on ALL cross-site requests (old behavior, explicitly opted in)
  → REQUIRES Secure flag. Without Secure: browser rejects the cookie entirely.
  → Use case: third-party embedded iframes (payment widgets, embedded video players)
  → DO NOT USE for primary auth cookies unless you need cross-site embedding.

SUMMARY:
  Best for most apps: SameSite=Lax (balance of security and UX)
  Best for high-security apps: SameSite=Strict + token for OAuth flows
  Avoid: SameSite=None for auth cookies
```

### Synchronizer Token Pattern (CSRF Tokens)

```javascript
// THE GOLD STANDARD: per-session (or per-request) unpredictable token.
// Server generates it. Server validates it. Attacker can't read it (SOP blocks reads).

import crypto from "crypto";
import { createClient } from "redis";

const redis = createClient();

// MIDDLEWARE: Generate CSRF token for a session
async function generateCsrfToken(req, res, next) {
  const sessionId = req.cookies.sessionId;
  if (!sessionId) return next();

  // Check if session already has a CSRF token
  let csrfToken = await redis.get(`csrf:${sessionId}`);

  if (!csrfToken) {
    csrfToken = crypto.randomBytes(32).toString("hex"); // 256 bits of entropy
    await redis.setex(`csrf:${sessionId}`, 3600, csrfToken); // TTL = session TTL
  }

  // Expose token via cookie (readable by same-origin JavaScript)
  // OR embed in HTML response
  res.cookie("XSRF-TOKEN", csrfToken, {
    httpOnly: false, // Must be readable by JS (unlike session cookie)
    secure: true,
    sameSite: "Strict",
    path: "/",
  });

  next();
}

// MIDDLEWARE: Validate CSRF token on state-changing requests
async function validateCsrfToken(req, res, next) {
  // Only validate for state-changing methods
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();

  const sessionId = req.cookies.sessionId;
  const tokenFromHeader = req.headers["x-csrf-token"]; // Frontend must include this
  const tokenFromBody = req.body?._csrf; // Alternative: hidden form field
  const submittedToken = tokenFromHeader || tokenFromBody;

  if (!submittedToken || !sessionId) {
    return res.status(403).json({ error: "CSRF_TOKEN_MISSING" });
  }

  const storedToken = await redis.get(`csrf:${sessionId}`);

  if (!storedToken) {
    return res.status(403).json({ error: "CSRF_SESSION_EXPIRED" });
  }

  // MUST use constant-time comparison to prevent timing attack on CSRF tokens
  const submitted = Buffer.from(submittedToken, "hex");
  const stored = Buffer.from(storedToken, "hex");

  if (
    submitted.length !== stored.length ||
    !crypto.timingSafeEqual(submitted, stored)
  ) {
    return res.status(403).json({ error: "CSRF_TOKEN_INVALID" });
  }

  next();
}

// FRONTEND (React/Axios): Read cookie and include in header
function getCsrfToken() {
  const match = document.cookie
    .split(";")
    .find((c) => c.trim().startsWith("XSRF-TOKEN="));
  return match ? decodeURIComponent(match.split("=")[1]) : null;
}

// Axios interceptor: auto-include CSRF token on non-GET requests
axios.interceptors.request.use((config) => {
  if (!["get", "head", "options"].includes(config.method)) {
    config.headers["X-CSRF-Token"] = getCsrfToken();
  }
  return config;
});
```

### Double-Submit Cookie Pattern (Stateless Alternative)

```javascript
// When you don't want server-side CSRF token storage (stateless APIs, microservices):

// SERVER: On session creation
function issueSessionWithCsrf(res, sessionId) {
  const csrfToken = crypto.randomBytes(32).toString('hex');

  // Session cookie (HttpOnly, not readable by JS)
  res.cookie('sessionId', sessionId, { httpOnly: true, secure: true, sameSite: 'Lax' });

  // CSRF cookie (NOT HttpOnly — must be readable by JS to include in header)
  res.cookie('csrfToken', csrfToken, { httpOnly: false, secure: true, sameSite: 'Lax' });

  // Embed CSRF token in JWT or session data for server-side comparison
  await storeSession(sessionId, { userId, csrfToken });
}

// VALIDATION: Compare cookie value with header value
function validateDoubleSubmit(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

  const cookieToken = req.cookies.csrfToken;           // Browser sent from cookie
  const headerToken = req.headers['x-csrf-token'];     // Frontend copied from cookie → header

  // Attacker.com can send POST with cookies (CSRF attempt)
  // BUT: Attacker.com JS cannot read the csrfToken cookie (SOP prevents reading)
  // THEREFORE: Attacker cannot set X-CSRF-Token header to match the cookie value

  if (!cookieToken || !headerToken) {
    return res.status(403).json({ error: 'CSRF_MISSING' });
  }

  const bufA = Buffer.from(cookieToken);
  const bufB = Buffer.from(headerToken);

  if (bufA.length !== bufB.length || !crypto.timingSafeEqual(bufA, bufB)) {
    return res.status(403).json({ error: 'CSRF_MISMATCH' });
  }

  next();
}
```

---

## SECTION 4 — Attack Flows

### Attack Flow 1: Classic Form-Based CSRF

```
ATTACK: Transfer money from victim's bank account.

SETUP:
  Attacker hosts: https://win-a-prize.evil/
  Bank's vulnerable endpoint: POST /api/transfer (no CSRF protection, only session cookie)

ATTACK PAGE (attacker's site):
┌──────────────────────────────────────────────────────────┐
│ <body onload="document.steal.submit()">                  │
│   Welcome! Click here to claim your prize!               │
│   (hidden below)                                         │
│   <form name="steal" action="https://bank.com/transfer"  │
│         method="POST" style="display:none">              │
│     <input name="recipient" value="attacker_account">    │
│     <input name="amount" value="5000">                   │
│     <input name="currency" value="USD">                  │
│   </form>                                                │
│ </body>                                                  │
└──────────────────────────────────────────────────────────┘

EXECUTION:
  1. Victim clicks phishing link → navigates to win-a-prize.evil
  2. Page loads → onload fires → form.submit() called
  3. Browser creates POST request to bank.com
  4. Browser attaches bank.com cookies automatically (victim is logged in)
  5. bank.com receives: POST /api/transfer with valid session cookie
  6. No CSRF check → transfer executes
  7. Victim's account debited. Attacker receives $5,000.
  8. Victim: never clicked anything on the bank site. Attack complete.

WHY VICTIM DOESN'T SEE IT:
  The form is display:none.
  The response from bank.com is handled by the browser — attacker's JS can't read it (SOP).
  Victim sees the "prize" page content. No visible indication.
```

### Attack Flow 2: JSON API CSRF with Custom Content-Type Bypass

```
COMMON MISCONCEPTION: "My API uses JSON (Content-Type: application/json). CSRF can't happen."

THIS IS WRONG for two reasons:

REASON 1: HTML forms can send application/x-www-form-urlencoded or multipart/form-data.
  If your server parses form data OR doesn't validate content-type strictly — vulnerable.

REASON 2: XMLHttpRequest/fetch CAN send non-simple content-types — but this TRIGGERS a CORS preflight.
  If your CORS config allows the attacker's origin → preflight passes → JSON CSRF succeeds.

  CORS misconfiguration: Access-Control-Allow-Origin: * AND cors allows all origins
  → fetch from attacker.com to api.bank.com: preflight succeeds → CSRF via JSON API.

REAL ATTACK (content-type bypass):
  Attacker uses text/plain content type (a "simple" request — no CORS preflight):

  fetch('https://api.bank.com/transfer', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },  // Simple request → no preflight
    body: '{"recipient":"attacker","amount":5000}',
  });

  IF server parses body regardless of content-type:
  → Request sent with victim's cookies → CSRF successful
  → Server must validate: Content-Type === 'application/json' AND correct CSRF token

LESSON: CSRF is not auto-prevented by JSON APIs unless you validate Origin/CSRF token.
```

### Attack Flow 3: GET-Based CSRF (Misuse of GET for State Changes)

```
OWASP says: GET requests should be idempotent (no state changes).
Many APIs violate this for convenience.

VULNERABLE ENDPOINT:
  GET /api/admin/delete-user?userId=victim_123
  GET /api/subscribe?plan=premium
  GET /friend-request/accept?userId=attacker_id

ATTACK via HTML IMAGE TAG:
  <img src="https://victim-app.com/api/admin/delete-user?userId=123" style="display:none">

  Browser loads all img tags automatically (to render the page).
  Browser attaches victim-app.com cookies.
  DELETE executes. Image returns 200 (or any status — browser doesn't care about img errors).

SameSite=Lax DOES NOT protect against this:
  Lax allows cookies on top-level GET navigations but NOT on img/script/iframe subrequests.
  img src: IS a subrequest → SameSite=Lax should NOT send the cookie.

  HOWEVER: Some older browsers or inconsistent SameSite=Lax implementations vary.
  DO NOT RELY ON SAMESITE ALONE. USE CSRF TOKENS TOO.
```
