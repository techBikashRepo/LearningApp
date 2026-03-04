# Session Storage — Part 1 of 3

### Topic: Foundations — Intuition, Core Concepts, Architecture & Data Flow

**Series:** Scalability & Performance → Topic 14

---

## SECTION 1 — Intuition (Explain Like a 12-Year-Old)

```
THE HOTEL KEY CARD MODEL:

  You check into a hotel. Front desk verifies your ID, takes payment, assigns room 302.
  They hand you a key card.

  The key card:
    Encodes: room number, check-out date, access permissions (pool, gym).
    Does NOT work without the hotel's door lock system to validate it.
    When you swipe at room 302: the lock reads the card AND validates it locally.
    The lock doesn't call the front desk every time you enter. Self-contained.

  But: "every time you open the minibar" behavior.
    You take a soda from the minibar. The hotel tracks that in their system (the session store).
    When you check out: the front desk looks up your minibar charges.
    The RECORD of what you did: stored on their server, not on your key card.
    The key card just proves who you are.

IN SOFTWARE TERMS:

  KEY CARD = SESSION TOKEN (or JWT):
    Proof of identity. Opaque to the user in practice.
    Server reads it to know WHO you are.
    Doesn't contain: what's in your cart, your wizard step, your preferences.

  MINIBAR LEDGER = SESSION DATA (on the server):
    The mutable state the server tracks for you.
    Shopping cart: 3 items.
    Multi-step form progress: step 3 of 5, with data from steps 1-2.
    CSRF token for current session.
    Recent activity for fraud detection.

  KEY INSIGHT:
    JWT/token = KEY CARD. Proves identity. Can be self-contained (contains userId, role).
    Session store (Redis) = THE LEDGER. Holds mutable state tied to this "visit."
    They solve DIFFERENT problems. Many applications need BOTH.

WHY NOT PUT EVERYTHING IN THE TOKEN?

  Option: put cart items, wizard state, preferences in JWT payload.

  Problem 1: Size. JWT base64 encoded. 10 cart items × 200 bytes each = 2KB JWT.
  Sent on EVERY request in the Authorization header.
  100 requests per page load × 2KB = 200KB overhead per page.

  Problem 2: Mutability. To invalidate specific JWT data: you must issue a new token.
  Cart changes → new JWT → client stores new JWT → next request uses it.
  Or: re-issue JWT on every state change. High overhead.

  Problem 3: Immutability is JWT's strength AND its weakness.
  JWT is signed. Any party with the public key can verify it WITHOUT calling the server.
  That validation independence means you can't revoke a JWT until it expires.
  Set a short expiry (15 min) + refresh tokens to mitigate.
  Session store: revoke a session instantly by DEL session:{token}.
```

---

## SECTION 2 — Core Technical Explanation

### Why Server-Side Sessions Need a Shared Store

```
THE STICKY SESSION TRAP:

  Before distributed session stores:

  User A logs in. Server 1 authenticates, creates session in LOCAL MEMORY.
  User A's next request: hits Server 1 → session found → authorized. ✅

  Scale event: load increased. Added Server 2 and Server 3.

  User A's NEXT request: load balancer routes to Server 2.
  Server 2: local memory has NO session for User A.
  Server 2: "who are you? please log in again." ✅ (from Server 2's perspective)
  User A: "I just logged in! This app is broken."

  STICKY SESSIONS "SOLUTION":
    Load balancer: pin a user to the same server (by cookie or IP hash).
    Server 1 always handles User A. Session lives there.

  PROBLEMS WITH STICKY SESSIONS:
    1. Failed server → users on that server LOSE SESSION. Must log in again.
    2. Hot servers: uneven distribution. Server 1 handles 30% of sessions (more logged-in users by coincidence).
    3. Auto-scaling: when Server 4 added, sticky routing continues to avoid Servers 1-3 even if they're overloaded.
    4. Blue-green deployments: old server has sessions, new doesn't. Forced to drain to force users to re-login.

THE CORRECT SOLUTION: EXTERNAL SESSION STORE

  Sessions stored in Redis (or other external store, not local memory).
  Every server reads/writes sessions from the SAME Redis cluster.

  User A logs in. Server 1 creates session.
  Session: stored in Redis. Key: sess:{tokenId} → data.

  User A's next request → Server 2.
  Server 2: reads sess:{tokenId} from Redis → session found. ✅

  User A's next request → Server 3.
  Server 3: reads sess:{tokenId} from Redis → session found. ✅

  Server 1 crashes: User A's next request → Server 4.
  Server 4: reads sess:{tokenId} from Redis → session found. ✅

  ADD ANY NUMBER OF SERVERS: all read from same Redis.
  Zero session loss from horizontal scaling or server failures.
```

---

## SECTION 3 — Architecture Diagram (MANDATORY)

### When to Use Server-Side Sessions vs Self-Contained Tokens

```
DIMENSIONS TO COMPARE:

┌─────────────────────────────┬──────────────────────┬──────────────────────────────────┐
│ DIMENSION                   │ SERVER-SIDE SESSION  │ JWT (Self-Contained Token)       │
├─────────────────────────────┼──────────────────────┼──────────────────────────────────┤
│ Storage location            │ Server (Redis)       │ Client (browser, mobile app)     │
│ State on server             │ YES (session data)   │ NO (stateless)                   │
│ Revocation                  │ Instant (DEL key)    │ Impossible until expiry          │
│                             │                      │ (without a blocklist, which adds │
│                             │                      │ server state and defeats purpose) │
│ Horizontal scaling          │ Requires shared store│ Any server validates with pubkey  │
│ Network overhead            │ 1 Redis read/request │ Zero extra requests (verify only) │
│ Token size                  │ Small (~20 char ID)  │ Larger (encoded payload + sig)   │
│ Mutable state               │ ✅ Easy (HSET field) │ ❌ Must re-issue token           │
│ Cross-service auth          │ Service must query   │ Any service with pubkey validates │
│                             │ session store        │ without calling auth service      │
│ Offline validation          │ ❌ Needs store access│ ✅ Public key is sufficient      │
│ Inter-service propagation   │ Token not readable   │ Claims readable by all services  │
└─────────────────────────────┴──────────────────────┴──────────────────────────────────┘

WHAT BELONGS IN SESSION vs JWT:

  JWT CLAIMS (static identity facts):
    userId: "12345"
    email: "alice@example.com"
    roles: ["user", "admin"]
    organizationId: "org_99"
    tier: "premium"

    Characteristics: don't change frequently. All services need to know.
    Impact of stale value: user keeps old roles for 15 min if JWT short-lived. Acceptable.
    NOT in JWT: cart, wizard progress, anything that changes per interaction.

  SESSION DATA (mutable interaction state):
    Shopping cart: [{productId: 99, qty: 2}, {productId: 101, qty: 1}]
    Checkout wizard step: {step: 3, shippingAddress: {...}, billingAddress: {...}}
    CSRF nonce: "csrf_token_abc"
    Last page before auth redirect: "/settings/billing"
    Recent actions for fraud detection: [{action: "view_checkout", ts: ...}, ...]

    Characteristics: change frequently. Specific to this "session"/visit.
    Must be mutable. Must be revocable (user logs out → DEL session).
    Not appropriate for JWT (size, mutability).

THE COMBINED ARCHITECTURE (production standard):

  JWT: for authentication persistence and cross-service identity.
    Access token: 15 minute expiry (short). Self-contained.
    Refresh token: 7 days. Stored as HttpOnly cookie. Server-side tracked (allows revocation).

  Redis Session: for user-specific mutable application state.
    Cart, wizard, preferences, recent browsing state.
    Key: sess:v1:{sessionId}

  On each request:
    1. Verify JWT signature (no I/O). Extract userId, roles. Sub-millisecond.
    2. If mutable state needed: HGETALL sess:v1:{sessionId} from Redis. 0.5ms.
    3. Both done: authorized and have user state.

  On logout:
    DEL sess:v1:{sessionId} → mutable state gone.
    Refresh token invalidated on server (blocklist or DB update).
    Access token: still technically valid for up to 15 min. Accept this limitation.
    If immediate revocation needed: use session-only auth (no JWT). One Redis read per request.

WHEN TO USE ONLY SESSION STORE (no JWT):

  SCENARIO: Internal corporate app. All users on same network. Must revoke instantly.
    Admin user demoted. Must lose admin access IMMEDIATELY, not in 15 minutes.
    Session store: DEL session → next request: session gone → re-auth → no admin access.
    JWT: demoted user keeps admin JWT for up to 15 min. Unacceptable in some compliance contexts.

  SCENARIO: Monolith application. No microservices. All auth by one service.
    No cross-service validation needed. JWT's stateless advantage is irrelevant.
    Simpler architecture: just sessions. One Redis cluster. No token signing/verification complexity.

  WHEN JWT CLEARLY WINS:
    Microservices: 5 different services need to validate identity.
    JWT: each service has public key. No auth service call per request. Scales.
    Session: each of 5 services must call session store OR session store must be shared across services.
    Shared session store: coupling between services. JWT: decoupled.
```

---

## SECTION 4 — Request Flow (MANDATORY FLOWCHART)

### Structuring Session Data in Redis

```
DATA TYPE CHOICE: HASH vs STRING

  OPTION A: STRING (JSON serialized)
    Key: sess:v1:{sessionId} → Value: JSON.stringify(sessionData)

    Read: GET sess:v1:{sid} → JSON.parse() → use session.
    Update cart: GET → parse → modify cart → stringify → SET.

    For small sessions (< 1KB): acceptable.

    For large sessions (many cart items, wizard data): expensive on frequent updates.
    Each cart update: parse entire session + modify array + serialize entire session + SET.

  OPTION B: REDIS HASH (recommended)
    Key: sess:v1:{sessionId}
    Fields: userId, cart (JSON), step, csrfToken, redirectAfterLogin

    HSET sess:v1:{sid} userId 12345
    HSET sess:v1:{sid} cart '[{"productId":99,"qty":2}]'
    HSET sess:v1:{sid} step "3"
    HSET sess:v1:{sid} csrfToken "csrf_abc"

    Read all: HGETALL sess:v1:{sid} → all fields at once.
    Read one field: HGET sess:v1:{sid} userId → just userId.
    Update one field: HSET sess:v1:{sid} cart '[{"productId":99,"qty":3}]'
                      No need to touch other fields. Atomic.

  MEMORY COMPARISON:
    JSON string session (listpack encoding not used): overhead of one Redis key.
    Hash session (listpack encoding if < 128 fields): compact listpack encoding.

    For 5-10 field sessions (typical):
    Hash (listpack): ~300 bytes total.
    JSON string: ~150 bytes data + ~56 bytes key overhead = ~206 bytes.
    Hash wins on update ergonomics and partial reads. String slightly smaller memory.

    Decision: use Hash for sessions that are updated field-by-field.
              Use String if session is always read/written atomically (never partial update).

SESSION ID GENERATION:

  Session ID = a random, unguessable, cryptographically secure token.

  const sessionId = crypto.randomBytes(32).toString('hex');
  // 64 hex characters. 32 bytes of entropy. 2^256 possibilities.
  // Brute-force search: infeasible. At 1B guesses/sec: 10^58 years.

  NEVER use:
  - Predictable IDs: sequential integers (1, 2, 3), UUIDs v1 (time-based).
  - Short IDs: 8 characters is 2^64 (less secure) with parallel attack tooling.
  - User attributes: hash of userId + IP (deterministic, exploitable).

SESSION COOKIE SETTINGS:

  Set-Cookie: sessionId=abc123; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=86400

  HttpOnly: JavaScript cannot read the cookie. XSS can't steal session IDs.
  Secure: cookie only sent over HTTPS. No accidental HTTP session ID leakage.
  SameSite=Strict: cookie not sent on cross-site requests. Mitigates CSRF.
  Max-Age: browser-side expiry (7 days for "remember me", session cookie = no Max-Age).

  NOTE: SameSite=Strict breaks certain OAuth flows (redirect back to your site from IdP).
        SameSite=Lax: allow GET cross-site requests. Compromise.
        Check your auth flow compatibility before choosing Strict.
```

---

_→ Continued in: [02-Session Storage.md](02-Session%20Storage.md)_
