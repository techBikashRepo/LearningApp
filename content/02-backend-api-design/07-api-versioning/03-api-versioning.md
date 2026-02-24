# API Versioning — Part 3 of 3

### Sections: 9 (Interview Prep), 10 (Comparison Tables), 11 (Quick Revision), 12 (Architect Thinking Exercise)

**Series:** Backend & API Design → REST APIs → System Design

---

## SECTION 9 — Interview Preparation

### Beginner Questions

**Q1: What is a breaking change in an API? Give three examples.**

_What the interviewer is testing:_ Ability to identify what affects client contracts.\*

**Ideal Answer:**

A breaking change is any change that makes existing, correct client code fail or produce wrong results.

Three examples:

1. **Removing a field**: Your response had `amount`. You rename it to `amount_cents`. Clients that read `response.amount` now get `undefined`. Their payment logic uses `undefined` in arithmetic → NaN results → silent data corruption or crashes.

2. **Changing response structure**: Your response was a flat object. You nest customer fields under a `customer` key. Client code that reads `response.customer_email` now fails — it's now `response.customer.email`. Object structure change = breaking.

3. **Making an optional parameter required**: A client calls `POST /payments` with just `{amount, currency}`. You add `payment_method` as required. Now the client's request fails with 400 — they were never asked to provide it before.

Non-breaking examples for contrast: adding a NEW optional field to the response (clients ignore it), adding a NEW optional request parameter with a default value, adding a NEW endpoint.

---

**Q2: Compare URL versioning (`/v1/`) vs header versioning (`API-Version: 2024-01-15`). Which would you recommend for a new public API?**

_What the interviewer is testing:_ Understanding of trade-offs, ability to make reasoned recommendations.\*

**Ideal Answer:**

|                  | URL (`/v1/`)                  | Header (`API-Version: date`) |
| ---------------- | ----------------------------- | ---------------------------- |
| Visibility       | Visible in URL                | Hidden in header             |
| Cacheable by CDN | Native (version in path)      | Requires `Vary: API-Version` |
| Browser testable | Yes (type URL directly)       | No (need Postman)            |
| REST purity      | No (version in resource path) | Yes                          |
| Simplicity       | High                          | Medium                       |

For a new public API: **URL versioning (`/v1/`)**. Here's why:

1. **Developer experience**: devs can type `/v2/payments` in a browser or curl. No header setup.
2. **CDN caching works naturally**: `/v1/` and `/v2/` are distinct paths — different cache keys automatically.
3. **Log analysis**: `grep /v1` shows exactly which requests are on which version.
4. **Industry standard**: Stripe, Twilio, AWS, GitHub — all major public APIs use URL versioning. Developers expect it.

The "not RESTful" argument is theoretical. Practical developer experience wins.

Use header versioning only if: you want to evolve behavior incrementally within a major version (Stripe's date-based header approach) — but that requires significant infrastructure.

---

**Q3: What is Hyrum's Law? Why does it make API versioning harder?**

_What the interviewer is testing:_ Deep understanding of the real complexity of "non-breaking" changes.\*

**Ideal Answer:**

Hyrum's Law: "With a sufficient number of users of an API, it does not matter what you promise in the contract: all observable behaviors of your system will be depended upon by somebody."

It means that even supposedly safe changes can break clients:

Example: You fixed a bug where your `/products` endpoint always returned results in alphabetical order. You never documented this — the products should return in insertion order. You fix it. A client had code that assumed alphabetical order and didn't sort the results locally. Their app breaks silently after your "bug fix."

The fix was:

- Not in your API contract
- Not documented
- Not intentional
- A bug by your definition

But a client depended on it and now their code breaks. **By Hyrum's Law, that behavioral change was effectively a breaking change** regardless of intent.

Why it makes versioning harder:

1. You need to version even "bug fixes" if they change observable behavior
2. You cannot know all behaviors clients depend on (especially undocumented ones)
3. At large scale (Google, Stripe), even the response time characteristics and error message wording get depended upon
4. Contract tests help — but clients test against their usage, not the full spec

The mitigation: treat every observable change as potentially breaking, communicate changes in changelog, use Pact/contract tests to catch regressions before deployment.

---

### Intermediate Questions

**Q4: You're launching v2 of your API. 800 clients are on v1. How do you drive migration? What's your sunset plan?**

_What the interviewer is testing:_ Practical migration planning.\*

**Complete Migration Plan:**

```
MIGRATION PLAYBOOK FOR V1→V2:

PHASE 1 — V2 LAUNCH (Month 0)
  • Release v2 in beta: /v2/* available but marked "beta" in docs
  • Keep v1 fully active (no changes to v1)
  • Announce v2 in developer newsletter + changelog
  • Provide migration guide: v1 field → v2 equivalent mapping
  • Offer early migration incentive: 3-month rate discount for early v2 adopters

PHASE 2 — V2 STABLE (Month 1-3)
  • Remove beta label from v2 documentation
  • All new features added to v2 ONLY (not backported to v1)
  • Self-service migration guide available
  • v1 response: add Deprecation header
    Deprecation: true
    Sunset: (TBD)
    Link: <https://developer.example.com/migrate>; rel="deprecation"

PHASE 3 — SUNSET ANNOUNCEMENT (Month 6)
  • Monitor: v1 traffic is at 30% of total → safe to announce sunset
  • Send email to all clients with v1 API traffic in last 30 days
  • Announce sunset date: Month 9 (3 months from announcement)
  • Update Sunset response header with the concrete date
  • Host migration webinar for enterprise clients

PHASE 4 — GENTLE ENFORCEMENT (Month 8)
  • 30 days before sunset: second email reminder — more urgent
  • v1: rate limit reduced to 500 req/min (was 1000) — performance nudge
  • v1: response includes X-Migration-Urgency: high header
  • Support team actively contacts top 20 by v1 traffic volume

PHASE 5 — SUNSET (Month 9)
  • v1: return 410 Gone with migration documentation URL
  • Keep 410 ACTIVE (not 404 Not Found) — tells clients the resource existed
  • Maintain /v1 path returning 410 forever (don't remove — bad for clients)

SUCCESS METRICS:
  Target: < 5% of total API traffic on v1 before announcing sunset
  If > 20% still on v1 at Month 6: delay sunset, investigate migration blockers

  Track: unique client IDs on v1 per week
  Track: v1 traffic as % of total
  Alarm: v1 traffic spike → v2 has a bug causing clients to fall back → investigate
```

---

### Advanced Question

**Q5: Design a versioning strategy for an internal microservices API where Service A calls Service B. Service B wants to make breaking changes. How is this different from public API versioning?**

_What the interviewer is testing:_ Applying versioning concepts to internal service communication.\*

**Ideal Answer:**

```
Internal microservices versioning is DIFFERENT from public API versioning in key ways:

PUBLIC API:
  External clients: unknown, autonomous, slow to update
  Deprecation window: 6-24 months
  Communication: email, changelog, developer portal
  You cannot force them to update

INTERNAL SERVICES:
  Consumers: known, owned by your team/org
  Deprecation window: days to weeks (not months)
  Communication: internal Slack, engineering all-hands, direct coordination
  You CAN force them to update (code ownership)

APPROACHES FOR INTERNAL:

Option A: EXPAND/CONTRACT pattern (preferred)
  Instead of versioning, make the change in phases:

  1. EXPAND: Add new field/endpoint alongside old one
     Service B adds: customer.display_name (new) alongside customer.name (old)
     Both fields exist simultaneously

  2. MIGRATE: Service A team migrates to new field
     Service A switches to reading customer.display_name
     This happens in one sprint (internal = fast migrations)

  3. CONTRACT: Remove old field
     Service B removes customer.name after Service A has migrated

  Total time: 2-4 weeks. No versioned endpoints needed.

Option B: Consumer-driven contract tests (Pact)
  Service A publishes its contract: "I depend on these fields with these types"
  Service B's CI runs Service A's contract tests before every deploy
  If Service B's change breaks Service A's contract → CI fails → deployment blocked
  Developer sees exactly which consumer is broken → coordinates fix

  This is the Google-scale approach: hundreds of internal consumers protected by
  contract tests. No versioning needed — you know immediately when you break someone.

Option C: API versioning IF services are team-independent
  If Service B is owned by a completely separate team/org:
  Internal URL versioning: /internal/v1/
  Sunset window: 4-6 weeks (much shorter than external)
  Migration: team B coordinates directly with team A

WHICH TO CHOOSE:
  Same team or close collaboration → Expand/Contract (faster, less overhead)
  Different teams, same org → Contract tests (automated, scales)
  Platform team serving many internal teams → Internal versioning with 4-6 week sunset
  External-facing or partner APIs → Full versioning per public API best practices
```

---

## SECTION 10 — Comparison Tables

### Versioning Strategy Comparison

| Strategy           | URL Example               | Cache-Friendly  | Browser Testable | REST Purity | Industry Usage              |
| ------------------ | ------------------------- | --------------- | ---------------- | ----------- | --------------------------- |
| **URL path**       | `/v2/payments`            | ✅ Native       | ✅ Yes           | ❌ No       | Stripe, Twilio, GitHub, AWS |
| **Query param**    | `/payments?v=2`           | ⚠️ Needs config | ✅ Yes           | ⚠️ Marginal | Some internal APIs          |
| **Request header** | `API-Version: 2024-01-15` | ⚠️ Vary header  | ❌ No            | ✅ Yes      | Stripe (hybrid), GitHub     |
| **Accept header**  | `Accept: vnd.api.v2+json` | ⚠️ Vary header  | ❌ No            | ✅ Best     | Rarely used in practice     |

### Breaking vs Non-Breaking Changes

| Change Type                    | Breaking?   | Why                                      |
| ------------------------------ | ----------- | ---------------------------------------- |
| Remove response field          | ✅ Breaking | Clients reading it get undefined/null    |
| Rename response field          | ✅ Breaking | Client code breaks on old name           |
| Change field type (string→int) | ✅ Breaking | Type coercion fails or silently corrupts |
| Add required request param     | ✅ Breaking | Old requests now return 400              |
| Change HTTP method             | ✅ Breaking | Clients hardcode method (GET/POST)       |
| Change 200 → 201 status        | ✅ Breaking | If client checks for exact status code   |
| Remove endpoint                | ✅ Breaking | Client gets 404/410                      |
| Add optional response field    | ❌ Safe     | Clients ignore unknown fields            |
| Add optional query parameter   | ❌ Safe     | Old requests still work (param defaults) |
| Add new endpoint               | ❌ Safe     | Existing client code unaffected          |
| Performance improvement        | ❌ Safe     | Unless latency was depended upon (Hyrum) |
| Fix unintentional sort order   | ⚠️ Possibly | If clients depend on the "buggy" order   |

### Sunset Timeline by API Type

| API Type                     | Recommended Sunset Window | Reasons                                 |
| ---------------------------- | ------------------------- | --------------------------------------- |
| Public consumer API          | 12-24 months              | External clients slow to update         |
| B2B / developer API          | 6-12 months               | Technical teams faster, B2B contracts   |
| Mobile app backend           | 18-24 months              | Users don't update apps                 |
| Internal service (same team) | 1-2 weeks                 | Direct communication, fast cycle        |
| Internal service (diff team) | 4-6 weeks                 | Coordinated sprint planning             |
| Partner/webhook API          | 6-12 months               | Partner engineering teams have backlogs |

---

## SECTION 11 — Quick Revision

### 10 Key Takeaways

1. **URL versioning is the industry standard**: `/v1/`, `/v2/` in the URL path. Used by Stripe, Twilio, GitHub, AWS. Simple, visible, cache-friendly, browser-testable.

2. **Non-breaking = additive only**: Adding new optional fields/endpoints is safe. Removing, renaming, or restructuring anything is breaking.

3. **Version at major breaking changes only**: Don't create v3 for every change. Additive changes go into current version. Only true breaking changes warrant a version bump.

4. **Hyrum's Law**: Even unintentional behaviors get depended upon. Bug fixes can be breaking changes. Document intended behavior explicitly; communicate any behavioral change.

5. **v1 adapter pattern**: Don't maintain two codebases. Keep ONE business logic layer (v2-native). v1 Lambda transforms v2 response → v1 shape. Bug fixes apply to both automatically.

6. **Deprecation headers are client signals**: `Deprecation: true`, `Sunset: <date>`, `Link: <migration-url>` in response headers. SDKs and dev tools surface these to developers.

7. **Sunset timeline depends on client type**: Public API: 12-24 months. B2B: 6-12 months. Internal services: 1-6 weeks. Mobile apps require longest windows.

8. **Consumer-driven contract tests prevent accidents**: Pact library. Consumers declare their contract. Provider CI fails if any consumer's contract breaks. Catches breaking changes before deployment, not after.

9. **Traffic monitoring drives sunset decisions**: Sunset when v1 traffic drops below 5-10% of total. CloudWatch dashboards for version traffic split. Never sunset by calendar date alone.

10. **410 Gone, never 404**: When v1 is sunset, return `410 Gone` with migration documentation URL. 404 implies it never existed (confusing). 410 acknowledges the client is using something that was retired.

### 30-Second Explanation

"API versioning lets you make breaking changes without breaking existing clients. URL versioning (`/v1/`, `/v2/`) is the standard: visible in URLs, CDN-friendly, browser-testable. Breaking changes (removing/renaming fields, restructuring responses) require a new version. Non-breaking changes (adding new optional fields/endpoints) don't. The adapter pattern keeps one business logic codebase: v1 Lambda transforms the v2 response to v1 shape. Sunset timelines depend on client type — 6-24 months for external, 1-6 weeks for internal. Always signal deprecation via Sunset headers, drive migration by monitoring version traffic split."

### Memory Tricks

**"ARR" — when do you need a new version?**

- **A**dding optional fields: safe, no new version needed
- **R**emoving/renaming anything: breaking, bump version
- **R**estructuring responses: breaking, bump version

**"PAST" — sunset planning steps:**

- **P**ublish v2 (stable)
- **A**nnounce deprecation (headers + email)
- **S**et sunset date (concrete date in headers)
- **T**urn off v1 on sunset day (410 Gone)

**v1 adapter = "translate, not duplicate"**

- Business logic lives in v2 service
- v1 is just a translation layer
- Translation layer = simple, test-covered, deletable at sunset

---

## SECTION 12 — Architect Thinking Exercise

### The Problem

You're the API architect at **DataBridge**, a B2B data integration platform. Companies connect DataBridge to their CRMs, ERPs, and databases to sync data between systems.

Current state:

- 1,200 enterprise clients using your API v1 (18 months live)
- v1 has critical design flaws:
  - All entity fields are flat (no nesting) — causes 200-field responses for complex objects
  - `amount` fields use floating-point (dollars) → cent rounding errors in financial data
  - `created_timestamp` field is Unix epoch (integer) → should be ISO 8601 string
  - The sync endpoint returns different structures for different entity types
- Legal and compliance requirement: new clients must use only v2
- 3 enterprise clients (generating 40% of ARR) are deeply integrated with v1 and say migration will take 12 months minimum
- Engineering team wants to sunset v1 within 6 months to reduce maintenance overhead

**Your task:**

1. Resolve the conflict between engineering's 6-month target and the 3 key clients' 12-month timeline
2. Design the v2 API changes and migration path
3. Define what v1 support looks like post-v2 launch (minimal maintenance mode)
4. Ensure legal compliance: new signups must use v2

---

_Think through the design. Then read the solution._

---

### Solution

#### 1. Resolving the Timeline Conflict

```
FRAME THE DECISION CORRECTLY:

Engineering wants: 6 months (reduce maintenance cost)
3 key clients need: 12 months (40% ARR risk if forced early)

Wrong question: "Who wins?"
Right question: "What's the minimum v1 investment to safely reach 12-month sunset
                while unblocking engineering from maintaining two codebases?"

SOLUTION — V1 ADAPTER PATTERN:

Month 1: Implement v2 as native, clean API
Month 2: Re-implement v1 as thin adapter layer on top of v2 core logic
  v1 responses = v2 responses transformed by adapter
  v1 AND v2 share the same:
    - Database models
    - Business logic
    - Bug fixes
    - Security patches
  v1 ONLY has: response transformer code

Engineering cost of v1 after adapter: 20 hours/year (adapter maintenance only)
vs current: 200+ hours/year (maintaining two separate implementations)

Now the 6-month vs 12-month conflict dissolves:
  Engineering restructures to single codebase in Month 2.
  v1 adapter costs almost nothing to maintain.
  3 key clients get their 12-month window.
  Legal compliance: new clients → v2 by policy enforcement in API Gateway.

12-month sunset for all clients. Engineering team satisfied (low maintenance cost).
3 key clients satisfied (no forced early migration). Legal satisfied.
```

#### 2. V2 API Design Changes

```
V1 → V2 CHANGES (all breaking, justified):

1. FLAT → NESTED STRUCTURE
   v1: { "contact_first_name": "Jane", "contact_last_name": "Smith",
         "contact_email": "jane@x.com", "account_name": "Acme Corp" }
   v2: {
     "contact": { "first_name": "Jane", "last_name": "Smith", "email": "jane@x.com" },
     "account": { "name": "Acme Corp" }
   }

2. FLOAT → INTEGER CENTS
   v1: { "amount": 49.99 }  ← floating point, rounding nightmare
   v2: { "amount_cents": 4999, "currency": "usd" }  ← lossless integer

3. UNIX EPOCH → ISO 8601
   v1: { "created_timestamp": 1705312200 }
   v2: { "created_at": "2024-01-15T10:30:00Z" }

4. UNIFORM SYNC RESPONSE STRUCTURE
   v1: Different response shape per entity type (contacts vs orders vs products)
   v2: Uniform envelope:
       {
         "entity_type": "contact",
         "id": "...",
         "data": {...},
         "metadata": { "created_at": "...", "updated_at": "..." }
       }

   Same structure for every entity type. Client SDK can handle generically.

V1 ADAPTER TRANSFORMATIONS:
  const toV1ContactShape = (v2Response) => ({
    contact_first_name: v2Response.contact.first_name,
    contact_last_name: v2Response.contact.last_name,
    contact_email: v2Response.contact.email,
    account_name: v2Response.account.name,
    amount: v2Response.amount_cents / 100,    // integers → float (v1 format)
    created_timestamp: Math.floor(new Date(v2Response.metadata.created_at).getTime() / 1000)
  });
```

#### 3. V1 Minimal Maintenance Mode

```
AFTER v1 adapter is in place:

V1 RECEIVES:
  ✅ Security patches (applied once in v2 core → automatically in v1)
  ✅ Critical bug fixes (same — v2 core fix covers v1)
  ❌ No new features
  ❌ No performance optimization beyond what v2 gets
  ❌ No new entity types
  ❌ No v1-specific changes

V1 ENGINEERING COST POST-ADAPTER:
  v1 adapter code: ~300 lines of transform functions
  Maintenance: only if v2 core response changes in a way that breaks adapter
  (Rarely happens — adapter is defensive: new v2 fields just get ignored)

V1 SLA (stated in contract with the 3 key clients):
  Uptime: 99.9% (same as v2)
  Support: P1/P2 security incidents only
  Changes: none (frozen API)
  Sunset date: committed in writing to Month 12

This is a "frozen but maintained" state — not "slowly degrading."
Clients get stability promise. Engineering gets low burden.
```

#### 4. Legal Compliance: New Signups → V2 Only

```
IMPLEMENTATION:
  API Gateway v1 middleware: check if account was created before v2 launch date

  const V2_LAUNCH_DATE = new Date('2024-03-01');

  if (req.auth.account_created_at >= V2_LAUNCH_DATE) {
    return res.status(403).json({
      error: 'V1_NOT_AVAILABLE',
      message: 'New accounts must use v2 of the API. Please update your integration.',
      v2_documentation: 'https://developer.databridge.com/v2',
      migration_guide: 'https://developer.databridge.com/migration'
    });
  }

  // Existing pre-launch accounts: proceed with v1 (adapter path)

ONBOARDING FLOW:
  New signup → API keys generated → v2 keys only
  Documentation: only v2 shown by default
  v1 docs: archive tag on all content, "v1 is sunset — use v2" banner

  Legal documentation:
  Terms of Service updated: "v1 end-of-life date: [Month 12 of v2 launch]"
  Enterprise contract addendum: specific sunset date for the 3 key clients
  Security compliance docs: reference v2 only
```

#### Architecture Principle

```
The key insight:
  "API versioning conflicts (engineering wants fast sunset vs clients need time)
   are almost always resolvable by separating IMPLEMENTATION from EXPOSURE.

   The adapter pattern lets you:
     - Unify the implementation (v2 codebase) immediately
     - Maintain the exposure (v1 response format) as long as needed

   These are independent concerns.
   You don't need to run TWO services to support two API versions.
   You need ONE service and a translation layer.

   This is how Stripe maintains 60+ API behavior versions simultaneously
   without maintaining 60 separate codebases."
```
