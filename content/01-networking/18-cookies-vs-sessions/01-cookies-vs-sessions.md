# Cookies vs Sessions — Part 1 of 3

### Topic: Cookies vs Sessions — Fundamentals, Mechanics, and Auth Flows

**Series:** Networking Fundamentals → System Design → AWS Solutions Architect
**Sections Covered:** 1, 2, 3, 4

---

## SECTION 1 — ELI12: What Are Cookies and Sessions?

### The Big Problem: HTTP Is Stateless

HTTP has a memory problem — it forgets you after every request. When you log in to a website, the next request the browser makes is brand new, and the server has no idea you already logged in. It's like going to the same store cashier every day, and every time, they look at you blankly and say "I've never seen you before."

Cookies and sessions are how websites give HTTP a memory.

### Analogy 1 — The Hotel Key Card and the Numbered Locker

Imagine checking into a hotel:

**Session approach (server stores the state):**

1. You check in at the front desk and show your passport (username + password)
2. Front desk assigns you Room 412 and gives you a KEY CARD
3. The key card has no information about you — it's just a number: `CARD-7723`
4. Every time you want room service, you show your card. Front desk looks up `CARD-7723` in the computer and finds: "Room 412, John, VIP guest, no nut allergy"
5. They serve you based on the information THEY stored
6. When you check out, they invalidate `CARD-7723` in their computer. The physical card is now useless.

**Cookie approach (client stores the state):**
Instead of a key card that unlocks a server-side record, imagine if the front desk gave you a slip of paper that said: "Name: John, VIP, Room 412, Dinner preference: vegetarian." You carry all your information with you. On each request, you hand the paper to the server.

Pros: Front desk doesn't need to maintain a lookup table.
Cons: You could alter the paper. If you lose it, someone else becomes "John."

**JWT (signed token — a tamper-proof slip of paper):**
The slip of paper is sealed with wax. The wax seal can only be made with the hotel's special stamp. You can READ the paper but you can't CHANGE it without breaking the seal. If the seal is intact, the front desk trusts what's written.

### Analogy 2 — The Membership Badge System

**Cookie = The badge you carry everywhere.**
When you join a gym, they give you a plastic badge. You put it in your wallet and bring it every visit. When you scan in, the scanner reads the badge. The gym doesn't call headquarters to verify you — the badge IS your proof.

**Session = Your number in the gym's system.**
Different gyms give you just a member number (like a locker key). Every time you arrive, they look up your number in their database: active, unlimited plan, last visit Tuesday. All the information lives at the gym; you just carry an ID number.

**JWT = A cryptographically-signed certificate.**
Like a government ID card with a hologram. You carry it. Anyone can READ it (see your name, expiry date). But if you try to alter it, the hologram breaks. No one needs to call the government to check if the ID is real — they just check the hologram (cryptographic signature).

### Three Approaches to HTTP State:

```
1. COOKIES (client-stored state):
   Server sets cookie → browser stores it → browser sends it on every request
   What's in the cookie: the USER DATA or a SESSION ID

2. SERVER SESSIONS (server-stored state, cookie carries only ID):
   Login → server creates session record in memory/DB → returns opaque session ID as cookie
   Per request: server looks up session ID to find user data

3. JWT TOKENS (self-contained signed tokens):
   Login → server creates signed token containing user data → client stores it (memory, localStorage, or cookie)
   Per request: client sends JWT → server verifies signature → reads user from token (no DB lookup)
```

---

## SECTION 2 — Core Technical Deep Dive

### How Cookies Work

Cookie lifecycle:

**Setting a cookie (server response):**

```
HTTP/1.1 200 OK
Set-Cookie: session_id=abc123def456; HttpOnly; Secure; SameSite=Strict; Max-Age=86400; Path=/
Set-Cookie: user_pref=dark_mode; Max-Age=31536000; Path=/; SameSite=Lax
Set-Cookie: cart_id=xyz789; Max-Age=3600; Path=/shop; Domain=.shop.com
```

Each `Set-Cookie` header creates one cookie. The browser stores all three separately.

**Cookie attributes:**

```
HttpOnly       → JavaScript cannot read/modify this cookie
               (document.cookie won't return HttpOnly cookies)
               Critical: prevents XSS tokens theft

Secure         → Only sent over HTTPS connections
               (browser will not include this cookie in HTTP requests)

SameSite=Strict → Cookie NEVER sent on cross-origin requests
               (not on form submits from other sites, AJAX from other sites,
                not even when user clicks a link FROM another site to your site)

SameSite=Lax   → Cookie sent on top-level navigation (link click) from other sites
               Cookie NOT sent in background requests (images, AJAX, iframes)
               Default in modern browsers

SameSite=None  → Cookie sent on ALL cross-site requests (required for third-party use)
               MUST use Secure flag when SameSite=None

Max-Age=86400  → Cookie expires in 86400 seconds (24 hours) from now
Expires=date   → Cookie expires at specific date (both do same thing; Max-Age preferred)
No Max-Age     → Session cookie (deleted when browser is closed)

Path=/         → Cookie sent for ALL paths on this domain
Path=/shop     → Cookie only sent for requests to /shop/* paths

Domain=.shop.com → Cookie sent to shop.com AND all subdomains (api.shop.com, admin.shop.com)
No Domain      → Cookie only sent to exact domain that set it (no subdomains)
```

**Browser sending cookies (automatic):**

```
GET /dashboard HTTP/1.1
Host: shop.com
Cookie: session_id=abc123def456; user_pref=dark_mode
```

The browser automatically includes cookies in `Cookie` header. Client-side JavaScript CANNOT set `HttpOnly` cookies (only server via `Set-Cookie` response header can).

### Server Sessions Deep Dive

```
Session lifecycle:

STEP 1 — Login creates session:
  POST /login, body: {email: "alice@example.com", password: "hunter2"}

  Server validates credentials → SUCCESS
  Server creates session record:
    session_id: "abc123def456xyz789"   (cryptographically random, unpredictable)
    user_id: 42
    email: "alice@example.com"
    roles: ["user", "premium"]
    last_activity: 2026-02-23T10:00:00Z
    ip_address: 1.2.3.4
    created: 2026-02-23T10:00:00Z
    expires: 2026-02-24T10:00:00Z

  Store in: Redis / DynamoDB / In-memory (in-memory only works single-server!)
  Response: Set-Cookie: session_id=abc123def456xyz789; HttpOnly; Secure; SameSite=Lax

STEP 2 — Subsequent requests:
  GET /profile HTTP/1.1
  Cookie: session_id=abc123def456xyz789

  Server: 1. Read session_id from Cookie header
            2. Look up in Redis: O(1) lookup
            3. Session found? Check expiry.
            4. Load user context → handle request

STEP 3 — Logout invalidates session:
  POST /logout

  Server: Delete session record from Redis.
          Return: Set-Cookie: session_id=; Max-Age=0  ← deletes cookie

  Effect: session_id cookie is cleared from browser.
          Even if someone stole the old session_id,
          looking it up in Redis returns nothing → unauthorized.
```

**Session security properties:**

- Session ID must be cryptographically random (not guessable, not sequential)
- Store only the OPAQUE ID in the cookie (not user data)
- Session store must be shared across all web servers (must use Redis, not memory)
- Session should be regenerated after privilege change (login: new session ID to prevent session fixation)

### JWT (JSON Web Tokens) Deep Dive

```
JWT structure: header.payload.signature
(Each section is base64url-encoded, separated by dots)

HEADER:
{
  "alg": "RS256",   ← Signature algorithm (RS256 = RSA + SHA-256)
  "typ": "JWT"
}

PAYLOAD (CLAIMS):
{
  "sub": "42",                           ← Subject (user ID)
  "email": "alice@example.com",
  "roles": ["user", "premium"],
  "iss": "https://auth.shop.com",        ← Issuer
  "aud": "https://api.shop.com",         ← Audience (who should accept this)
  "iat": 1740290400,                     ← Issued At (Unix timestamp)
  "exp": 1740376800                      ← Expiry (Unix timestamp)
}

SIGNATURE:
  RS256: RSA signature of (base64Header + "." + base64Payload) using private key
  Verified by anyone holding the corresponding public key (publishable)

Full JWT example:
eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.
eyJzdWIiOiI0MiIsImVtYWlsIjoiYWxpY2VAZXhhbXBsZS5jb20ifQ.
SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c
```

**JWT Verification (no database needed):**

```
Server receives request:
  Authorization: Bearer eyJhbGci...

Server verifies:
  1. Split JWT into header.payload.signature
  2. Verify signature using PUBLIC KEY (no DB lookup!)
     If tampered: signature verification fails → 401
  3. Check expiry (exp claim) → expired → 401
  4. Check audience (aud) matches expected audience → else → 401
  5. Check issuer (iss) matches trusted issuer → else → 401
  6. Read user from payload → process request
```

**JWT Trade-offs:**

```
ADVANTAGE:
  Stateless: no session store, scales horizontally trivially
  Self-contained: user info in token = no DB lookup per request
  Cross-domain: works across multiple services with same public key

DISADVANTAGE:
  Cannot revoke: once issued, token is valid until exp
  Token theft = valid until expiry (no session invalidation)

Mitigation strategies for JWT revocation:
  Option A: Short expiry (15 minutes) + refresh token (30 days in DB)
    Access token expires in 15min → not harmful if stolen (short window)
    Refresh token in HttpOnly cookie → client uses to get new access token
    Revoke: delete refresh token from DB → user cannot get new access tokens

  Option B: Token blocklist (Redis)
    Store revoked JWT IDs (jti claim) in Redis with TTL = token expiry
    Check blocklist per request: if jti in Redis → reject
    Trade-off: partial DB lookup (defeats stateless advantage)
```

### Session vs Cookies vs JWT — When to Use What

```
SERVER SESSION (Redis-backed):
  Use when: Security is paramount, need instant revocation, B2C banking/healthcare
  Size: Only session ID in cookie (~40 bytes)
  Revoke: Instant (delete from Redis)
  Scale: Requires Redis cluster (but Redis easily scales)
  Stateless? No — Redis required

JWT (short-lived access + refresh token):
  Use when: Microservices need to verify identity without calling central auth service
            API consumed by mobile clients and SPAs
  Size: Token is 500-2KB (larger than session ID)
  Revoke: Hard (need refresh token invalidation)
  Scale: Excellent — any server can verify with public key
  Stateless? Yes (for access tokens)

SIMPLE COOKIE:
  Use when: Simple stateful data (shopping cart for anonymous users, preferences, A/B test assignment)
  Store: Small data directly in cookie (under 4KB limit)
  Don't store: Passwords, SSN, payment data (cookies travel in every request unencrypted body)
  Sign cookies: Use HMAC signature to prevent tampering (Flask/Rails do this automatically)
```

---

## SECTION 3 — ASCII Diagram

### Cookie-Based Session Flow

```
BROWSER                                      SERVER (pool)
  │                                              │
  │  1. POST /login                              │
  │  Body: {email, password}                     │
  │ ──────────────────────────────────────────► │
  │                                              │  Validate credentials
  │                                              │  Create session in Redis:
  │                                              │    session_id → {user_id, roles, exp}
  │                                              │
  │  2. 200 OK                                   │
  │  Set-Cookie: sid=abc123; HttpOnly; Secure    │
  │ ◄────────────────────────────────────────── │
  │                                              │
  │  Browser stores cookie                       │
  │                                              │
  │  3. GET /dashboard                           │
  │  Cookie: sid=abc123    ← auto-sent           │
  │ ──────────────────────────────────────────► │  Lookup session
  │                                              │    "abc123" → {user42, admin}
  │  4. 200 OK + Dashboard HTML                  │
  │ ◄────────────────────────────────────────── │
  │                                              │
  │  5. POST /logout                             │
  │  Cookie: sid=abc123                          │
  │ ──────────────────────────────────────────► │  DELETE "abc123" from Redis
  │                                              │
  │  6. 200 OK                                   │
  │  Set-Cookie: sid=; Max-Age=0 ← clear cookie  │
  │ ◄────────────────────────────────────────── │
  │                                              │
  │  Browser deletes cookie                      │  session_id is dead
```

### JWT Auth Flow with Refresh Token

```
MOBILE APP                  AUTH SERVICE              API SERVICE
     │                           │                         │
     │  1. POST /auth/login       │                         │
     │  {email, password}         │                         │
     │ ─────────────────────────► │                         │
     │                            │  Validate credentials    │
     │                            │  Create:                │
     │                            │   access_token (15min)  │
     │                            │   refresh_token (30days)│
     │  2. 200 OK                 │                         │
     │  {access_token: "eyJ..."   │                         │
     │   refresh_token: "eyK..."}  │                         │
     │ ◄───────────────────────── │                         │
     │                            │                         │
     │  3. GET /api/profile                                  │
     │  Authorization: Bearer eyJ... (access_token)         │
     │ ────────────────────────────────────────────────────► │
     │                            │  Verify JWT signature   │
     │                            │  Check expiry           │
     │  4. 200 OK + Profile data                             │
     │ ◄──────────────────────────────────────────────────── │
     │                            │                         │
     │  (15 minutes later)        │                         │
     │  5. GET /api/orders        (access token has expired)│
     │  Authorization: Bearer eyJ...
     │ ────────────────────────────────────────────────────► │
     │                            │  Verify signature ✓     │
     │                            │  Check expiry ✗ EXPIRED  │
     │  6. 401 Unauthorized                                  │
     │ ◄──────────────────────────────────────────────────── │
     │                            │                         │
     │  7. POST /auth/refresh     │                         │
     │  {refresh_token: "eyK..."}  │                         │
     │ ─────────────────────────► │                         │
     │                            │  Verify refresh token   │
     │                            │  Issue new access token │
     │  8. 200 OK {access_token: "eyJ...new..."}            │
     │ ◄───────────────────────── │                         │
     │                            │                         │
     │  9. GET /api/orders (retry with new token)           │
     │ ────────────────────────────────────────────────────► │
     │  10. 200 OK + Orders                                  │
     │ ◄──────────────────────────────────────────────────── │
```

### CSRF Attack + SameSite Cookie Defense

```
WITHOUT SameSite protection:

  User: logged into bank.com (has valid session cookie)
  Attacker: evil.com has a form that submits to bank.com/transfer

  EVIL.COM:
  <form method="POST" action="https://bank.com/transfer">
    <input name="amount" value="10000">
    <input name="to_account" value="attacker-account">
  </form>
  <script>document.forms[0].submit()</script>  ← auto-submits silently

  Browser: "POST bank.com/transfer — do I have a bank.com cookie? YES → send it"
  Bank server: "Valid session cookie → process transfer → $10,000 sent"

  WHY IT WORKS: Browser sends cookies on cross-site form submits by default.

WITH SameSite=Strict:

  Browser: "POST bank.com/transfer — request is from evil.com (cross-site)"
           "bank.com cookie has SameSite=Strict → do NOT send cookie"
  Bank server: "No cookie → 401 Unauthorized → transfer denied"

  CSRF ATTACK DEFEATED by one cookie attribute

WITH SameSite=Lax (default in Chrome):
  POST cross-site forms → cookie NOT sent (CSRF protected)
  GET link navigation → cookie IS sent (user clicks real bank.com link = works)
```

---

## SECTION 4 — Step-by-Step Flows

### Flow 1 — Complete Login → Use → Logout (Session-Based)

```
Step 1: User submits login form
  POST /login HTTP/1.1
  Content-Type: application/x-www-form-urlencoded
  Body: email=alice%40example.com&password=hunter2

Step 2: Server validates credentials
  SELECT * FROM users WHERE email = 'alice@example.com'
  → Password hash comparison (bcrypt.compare)
  → Match found → user = {id: 42, email: alice, roles: ['admin']}

Step 3: Server creates session
  session_id = crypto.randomBytes(32).toString('hex')
  → "3a9b2c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0"

  HSET sessions:3a9b2c... user_id "42" roles "admin" expires "1740377000"
  EXPIRE sessions:3a9b2c... 86400  ← Redis TTL = 24 hours

Step 4: Set cookie and redirect
  HTTP/1.1 302 Found
  Location: /dashboard
  Set-Cookie: sid=3a9b2c...; HttpOnly; Secure; SameSite=Strict; Max-Age=86400; Path=/

Step 5: Browser follows redirect (with cookie)
  GET /dashboard HTTP/1.1
  Cookie: sid=3a9b2c...

Step 6: Server loads session
  HGETALL sessions:3a9b2c...
  → {user_id: "42", roles: "admin", expires: "1740377000"}
  Check: current_time < 1740377000? YES → session valid
  Load user: req.user = {id: 42, email: alice, roles: ['admin']}

Step 7: Render dashboard (user sees their data)
  HTTP/1.1 200 OK
  Content-Type: text/html
  Cache-Control: private, no-store  ← NEVER cache user-specific HTML
  Body: <html>Welcome Alice...</html>

Step 8: Logout
  POST /logout HTTP/1.1  (POST not GET — logout must be non-idempotent)
  Cookie: sid=3a9b2c...

  Server: DEL sessions:3a9b2c...     ← Invalidate immediately in Redis
  Response: 200 OK
  Set-Cookie: sid=; Max-Age=0; Path=/  ← Clear cookie from browser

  Effect: Even if someone has the old session ID, it's gone from Redis.
          No valid session → no access.
```

### Flow 2 — JWT Issuance and Verification in Microservices

```
Step 1: Login → Auth Service issues JWT
  Auth service:
    user = authenticate(email, password)     → {id: 42, roles: ['user']}
    payload = {
      sub: "42",
      roles: ["user"],
      iss: "https://auth.shop.com",
      aud: ["api.shop.com", "cart.shop.com"],
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 900  ← expires in 15 minutes
    }
    token = jwt.sign(payload, private_key, {algorithm: 'RS256'})

    Return: {access_token: token, expires_in: 900}

Step 2: Client stores token and sends on API calls
  JavaScript (SPA): localStorage.setItem('token', token) OR memory variable
  Mobile app: Keychain (iOS) / Keystore (Android) — secure storage
  Server-side client: memory variable

  Sending:
  GET /orders HTTP/1.1
  Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...

Step 3: API Service verifies JWT (no Auth Service involved)
  jwt.verify(token, public_key, {algorithms: ['RS256'], audience: 'api.shop.com'})

  Library checks:
  ✓ Signature valid (computed using public key)
  ✓ exp > current_time (not expired)
  ✓ iss = "https://auth.shop.com" (trusted issuer)
  ✓ aud includes "api.shop.com" (this service is the intended audience)

  → All pass: req.user = {id: "42", roles: ["user"]}
  → Any fail: throw JsonWebTokenError → 401 response

Step 4: Request processed, response returned (based on token claims)
  Order service: "User 42, roles ['user'] → can read own orders → return orders"

Step 5: Token expires (after 15 minutes)
  Client detects: 401 response OR checks exp before request
  Client: POST /auth/refresh with refresh_token
  Auth service: validates refresh token → issues new access token
  → Transparent to user (automatic in most SDKs)
```

---

## File Summary

This file covered:

- Stateless HTTP problem + three solutions: cookies, server sessions, JWTs
- Hotel key card (session = opaque ID the server looks up) + wax seal on paper (JWT = tamper-proof self-contained token) analogies
- Cookie anatomy: HttpOnly/Secure/SameSite/Max-Age/Path/Domain attributes and what each prevents
- Server session lifecycle: login → random ID → Redis storage → cookie → lookup → logout (delete from Redis)
- JWT structure: header.payload.signature (base64url-encoded); claims (sub/iss/aud/iat/exp); RS256 verification without DB lookup
- JWT revocation strategies: short expiry + refresh token (recommended), or token blocklist in Redis
- When to use each: session for B2C banking (instant revoke), JWT for microservices (stateless verification), cookies for simple state (preferences, cart)
- ASCII diagrams: cookie session flow, JWT refresh token flow, CSRF attack + SameSite defense
- Step-by-step: complete session login/use/logout with Redis, JWT microservice verify flow

**Continue to File 02** for real-world analogies, system design patterns, AWS mapping, and 8 Q&As.
