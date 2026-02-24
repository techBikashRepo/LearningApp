# API Versioning — Part 1 of 3

### Sections: 1 (Intuition), 2 (Why It Exists), 3 (Core Technical Deep Dive), 4 (Real-World API Contract & Request Flow)

**Series:** Backend & API Design → REST APIs → System Design

---

## SECTION 1 — Building Intuition First

### The Mobile App Analogy

Imagine you ship a mobile app. Version 1.0 is on the App Store. Three months later, you redesign the API:

- Rename `user.full_name` → `user.display_name`
- Change orders response: array of items → nested object with `items` key
- Remove the `legacy_customer_type` field entirely

If you make these changes on the live API: **every user still running version 1.0 of the app breaks immediately**. Their app tries to access `user.full_name` → undefined. Tries to iterate the orders list → crashes (it's now an object). The field they stored locally no longer exists.

Not every user updates their app the day you ship. Some users never update. Enterprise clients might be pinned to a specific version. Embedded devices check for updates only monthly.

**API versioning solves this**: both versions coexist simultaneously. Old clients use v1, new clients use v2. You sunset v1 when client adoption of v2 reaches an acceptable threshold.

### The Library Upgrade Analogy

Think of API versions like library package versions:

- `lodash@3.x` and `lodash@4.x` coexist in npm
- A project can migrate at its own pace
- Breaking changes happen in major versions, not patch versions
- The old version is maintained (security patches) until officially deprecated

Your API is the same: v1 is a supported library. v2 is the next major version. Breaking changes only in major version bumps.

---

## SECTION 2 — Why API Versioning Exists

### The Core Problem: Breaking Changes

A breaking change is any change that makes existing correct client code fail:

```
BREAKING CHANGES:
  - Removing a field that clients depend on
  - Renaming a field
  - Changing a field's type (string → integer)
  - Changing the structure of a response (flat → nested)
  - Changing a URL path that clients have hardcoded
  - Adding a new required request parameter
  - Changing HTTP method for an endpoint
  - Changing error codes that clients catch

NON-BREAKING CHANGES (additive):
  - Adding a NEW optional field to response
  - Adding a NEW optional query parameter
  - Adding a NEW endpoint entirely
  - Expanding enum values (if client ignores unknown values)
  - Performance improvements
  - Bug fixes (unless the bug is something clients depended on — "Hyrum's Law")
```

### Hyrum's Law

> "With a sufficient number of users of an API, it does not matter what you promise in the contract: all observable behaviors of your system will be depended upon by somebody."

— Hyrum Wright, Google

```
Example: You had a bug where the API always returned addresses sorted alphabetically.
         You fix the bug so addresses return in insertion order.

         Some client had code that assumed alphabetical order.
         Their tests pass in the bug-having version.
         They don't notice the "fix" broke their app.

         This is a breaking change — even though it was a bug fix.

         At Google scale (thousands of internal consumers), every observable
         behavior has at least one consumer depending on it.
         This is why Google is extremely cautious about any API change.
```

### What Happens Without Versioning

```
Option A: Never break the API (additive-only forever)
  - Response bodies grow indefinitely with deprecated fields
  - Technical debt accumulates
  - Impossible to clean up bad design decisions
  - After 5 years: 200-field responses with 60 deprecated fields, all still live

Option B: Break it without versioning
  - Every client breaks on deployment day
  - Enterprise clients cannot patch their code in time
  - SLA violations, customer churn, legal liability
  - For financial APIs: regulatory concerns about breaking live integrations

Option C: API versioning (right answer)
  - Breaking changes isolated to new version
  - Old clients keep working on old version
  - Clients migrate on their own schedule
  - Old version sunset after sufficient time (6-24 months)
```

---

## SECTION 3 — Core Technical Deep Dive

### Versioning Strategies

**Strategy 1 — URL path versioning (most common):**

```
GET /v1/users/123
GET /v2/users/123

Advantages:
  ✅ Visible in URL — easy to see which version you're on
  ✅ Easy to route at proxy/gateway level: /v1/* → v1 service
  ✅ Browser-compatible (bookmarkable)
  ✅ Log filtering: grep /v1 to see all v1 traffic
  ✅ CDN cache keys naturally include version

Disadvantages:
  ❌ "Not RESTful" — URL should represent a resource, not a version of the API
  ❌ Multiple versions in one project: https://api.x.com/v1, /v2, /v3... feels messy

Used by: Stripe, Twilio, GitHub, AWS, most public APIs
```

**Strategy 2 — Header versioning:**

```
GET /users/123
API-Version: 2024-01-15

Server reads header to determine which version to serve.

Advantages:
  ✅ "Clean" URLs — resource path is the same across versions
  ✅ Truly RESTful (URL = resource identity)
  ✅ Easy to add via client SDK without changing URLs

Disadvantages:
  ❌ Not visible in URL — can't tell version from a link
  ❌ CDN caching must vary on the header (Vary: API-Version)
  ❌ Harder to test in browser (can't just type a URL)
  ❌ Easier to forget — clients might omit the header, fall to default

Used by: Stripe (uses BOTH — URL prefix + version header), GitHub (for minor versions)
```

**Strategy 3 — Query parameter versioning:**

```
GET /users/123?api_version=2

Advantages:
  ✅ Easy to add to any URL
  ✅ Default version fallback when param omitted

Disadvantages:
  ❌ Must be excluded from CDN cache key or causes cache pollution
  ❌ Messy URLs mixing pagination/filter params with version
  ❌ Easy to accidentally include in URLs that get cached without it

Used by: Some internal APIs, YouTube Data API (version in URL path but version as param)
Not recommended for public APIs.
```

**Strategy 4 — Content negotiation (Accept header):**

```
GET /users/123
Accept: application/vnd.myapi.v2+json

HTTP-standard way of versioning using media types.

Advantages:
  ✅ Most "RESTful" approach — separates resource from representation
  ✅ Can serve different formats (JSON v1, JSON v2, XML) from same URL

Disadvantages:
  ❌ Extremely verbose
  ❌ Not practical for most developers — unfamiliar syntax
  ❌ Testing requires tools that set Accept headers
  ❌ Virtually no major public API uses this in practice

Used by: Rarely. GitHub v3 uses Accept: application/vnd.github+json but not for versioning
```

### Semantic Versioning vs Calendar Versioning

```
SEMANTIC VERSIONING (v1, v2, v3):
  Major.Minor.Patch concept applied to APIs:
  /v1 = stable, breaking changes allowed from v0
  /v2 = new major version with breaking changes from v1
  Minor/patch = non-breaking, no new version needed (just /v1 with additions)

  Used by: Stripe, Twilio, GitHub

CALENDAR VERSIONING (Stripe header style):
  API-Version: 2024-01-15

  Each date is a new version.
  Clients specify the exact date they want the API behavior locked to.
  The API evolves internally; client's behavior is frozen to their specified date.

  Stripe model: every change is versioned by date.
  Client says: "I want the API as it was on 2023-01-15, forever."
  Stripe commits to supporting that exact behavior until sunset date.

  Advantages: granular, clients can adopt incremental changes
  Disadvantages: complex to implement — must maintain many dated behaviors

HYBRID (most practical):
  URL version: /v1 for the path ← major API families
  Date header: for minor behavior changes within v1
  Stripe uses this hybrid. Most startups use URL-only.
```

### Backward Compatibility Rules

```
ADDITIVE CHANGES — always safe (never need a new version):
  Response: add new optional field
  Request: add new optional parameter (with sensible default)
  Endpoints: add new URL paths entirely
  Enums: add new values (server-to-client, if client ignores unknowns)

  Client contracts: MUST tolerate unknown fields in JSON
  Use: JSON parsing that ignores extra keys (default in JavaScript, Python)
  Avoid: exact row counting validation that would fail on new fields

BREAKING CHANGES — require new version:
  Remove field from response
  Rename field
  Change field type (string → integer)
  Change response structure (flat → nested)
  Remove endpoint
  Change HTTP method for an endpoint
  Make optional parameter required
  Change error response structure
  Change pagination format

HYPERMEDIA as migration tool:
  HATEOAS links in response help clients discover new endpoints:
  {
    "data": {...},
    "links": {
      "self": "/v1/orders/123",
      "payment": "/v2/orders/123/payment"  ← new v2 sub-resource
    }
  }
  Client follows links → naturally discovers v2 endpoints when ready
```

---

## SECTION 4 — Real-World API Contract & Request Flow

### BillingCore — SaaS Payment API

BillingCore is a B2B payment infrastructure API used by 10,000 SaaS companies. They have v1 serving 6,000 active integrations and are launching v2 with a redesigned payment model.

```
V1 RESPONSE (legacy flat structure):
GET /v1/payments/pay_abc123

{
  "id": "pay_abc123",
  "amount": 5000,
  "currency": "usd",
  "status": "succeeded",
  "customer_id": "cust_456",
  "customer_email": "user@example.com",    ← flat customer fields
  "customer_name": "Jane Smith",
  "card_last4": "4242",
  "card_brand": "visa",
  "card_exp_month": 12,                    ← flat card fields
  "card_exp_year": 2027,
  "created_at": "2024-01-15T10:30:00Z",
  "legacy_processor_id": "stripe_ch_xxx"  ← internal ID, exposed accidentally
}

V2 RESPONSE (clean nested structure):
GET /v2/payments/pay_abc123

{
  "id": "pay_abc123",
  "amount_cents": 5000,                    ← renamed: amount → amount_cents (explicit)
  "currency": "usd",
  "status": "succeeded",
  "customer": {                            ← nested object (not flat)
    "id": "cust_456",
    "email": "user@example.com",
    "name": "Jane Smith"
  },
  "payment_method": {                      ← nested, named properly
    "type": "card",
    "card": {
      "last4": "4242",
      "brand": "visa",
      "exp_month": 12,
      "exp_year": 2027
    }
  },
  "created_at": "2024-01-15T10:30:00Z"
  // legacy_processor_id: removed — was never in public contract
}

WHY THIS REQUIRES A VERSION BUMP:
  1. amount renamed to amount_cents → client code breaks
  2. customer_email/customer_name → customer.email/customer.name (structural change)
  3. card_last4/card_brand → payment_method.card.last4/brand (structural change)
  4. legacy_processor_id removed → any client using it breaks

V1 RESPONSE HEADERS (deprecation signaling):
  Deprecation: true
  Sunset: Sat, 31 Dec 2025 23:59:59 GMT
  Link: <https://developer.billingcore.com/migration/v2>; rel="deprecation"

ROUTING AT API GATEWAY LEVEL:
  /v1/* → Lambda:billing-v1 (frozen endpoint, no new features)
  /v2/* → Lambda:billing-v2 (active development)

  v1 receives only: security patches, critical bug fixes
  v2 receives: all new features

V2 LAUNCH COMMUNICATION:
  6 months before: announce v2 beta in changelog
  3 months before: announce v1 sunset date in email + API response headers
  1 month before: migration webinar for enterprise clients
  Sunset day: v1 endpoints return 410 Gone with documentation link
```

**Versioning errors:**

```json
// Client hits v1 after sunset:
GET /v1/payments/pay_abc123  (after sunset date)
→ 410 Gone
{
  "error": "VERSION_SUNSET",
  "message": "API v1 was sunset on 2025-12-31. Please upgrade to v2.",
  "sunset_date": "2025-12-31",
  "migration_guide": "https://developer.billingcore.com/migration/v2",
  "v2_equivalent": "GET /v2/payments/pay_abc123"
}

// Client omits version:
GET /payments/pay_abc123
→ 400 Bad Request
{
  "error": "VERSION_REQUIRED",
  "message": "API version is required in the URL path",
  "hint": "Use /v2/payments/pay_abc123",
  "documentation": "https://developer.billingcore.com/versioning"
}
```
