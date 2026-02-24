# Resource Naming — Part 3 of 3

### Sections: 9 (Interview Prep), 10 (Comparison Tables), 11 (Quick Revision), 12 (Architect Thinking Exercise)

**Series:** Backend & API Design → REST APIs → System Design

---

## SECTION 9 — Interview Preparation

### Beginner Questions

**Q1: What's wrong with this API: `GET /getUserById?id=123` and how would you fix it?**

_What the interviewer is testing:_ Do you understand that HTTP method carries the verb, not the URL?

**Ideal Answer:**

Three problems:

1. **Verb in URL**: `get` is redundant — `GET` (HTTP method) already says "retrieve". The URL should be a noun identifying the resource.
2. **`ById` in URL**: The path parameter mechanism (`/users/{id}`) already implies you're identifying by ID. Spelling it out is noise.
3. **Query param for a resource identifier**: `?id=123` should be a path param because 123 is part of the resource's identity, not a filter.

Correct form: `GET /users/123`

The rule: **HTTP method = verb, URL path = noun, path param = identity, query param = filter.**

```
# Before (bad)       → After (good)
GET /getUserById?id=123  → GET /users/123
POST /createUser         → POST /users
GET /deleteUser?id=123   → DELETE /users/123
POST /updateUserProfile  → PATCH /users/123
GET /getUserOrders?id=123 → GET /users/123/orders
```

---

**Q2: Should resource names be singular or plural? Why?**

_What the interviewer is testing:_ Awareness of naming conventions and their impact on consistency.

**Ideal Answer:**

**Always plural for collections.** The industry consensus (GitHub, Stripe, AWS, Google) is plural nouns.

Why plural wins:

```
GET /users       ← reading a collection  (plural: makes obvious sense — multiple users)
GET /users/123   ← reading one user     (still uses /users as the collection path)
POST /users      ← creating in the collection
```

If you use singular:

```
GET /user        ← ambiguous — is this THE user (me) or ALL users?
GET /user/123    ← inconsistent with collection path
```

Plural is unambiguous: `/users` is always the collection. `/users/123` is always one member.

Special case: singleton resources (resources that exist exactly once per parent):

```
GET /users/123/profile    ← one profile per user (singleton sub-resource, can be singular)
GET /users/123/settings   ← settings object (singleton, singular acceptable)
```

---

**Q3: How do you represent a "search" operation in REST? You can't create a `/searchProducts` URL.**

_What the interviewer is testing:_ Understanding of query parameters vs path parameters.

**Ideal Answer:**

Search is a **filter on a collection**. Collections already exist at `/products`. Search filters the collection using query parameters:

```
GET /products?q=noise+cancelling+headphones    ← full-text search
GET /products?category=electronics&minPrice=100&maxPrice=500  ← faceted filter
GET /products?vendor=acme&sort=price&order=asc  ← filter + sort
GET /products?tag=wireless&tag=premium         ← multiple values same param
```

The collection endpoint (`/products`) accepts filters via query params. No new URL needed. The HTTP framework, CDN, and clients all understand this pattern.

For complex searches that don't fit GET query params (e.g., large nested filter objects, binary payloads in filter criteria): use POST to a dedicated search resource:

```
POST /products/search
Body: { "filters": { "price": {"min": 100, "max": 500}, "categories": [...] }, "sort": ... }
```

This is acceptable when filter complexity requires a request body. The `/search` sub-resource name makes intent explicit even though POST is used.

---

### Intermediate Questions

**Q4: You're building an API where users can follow other users (like Twitter). How do you model the "follow" relationship as a REST resource?**

_What the interviewer is testing:_ Modeling relationships as resources, not just CRUD entities.

**Ideal Answer:**

The follow relationship is itself a resource. It's a **relationship entity** between two users.

```
Resource: /users/{followerId}/following/{followeeId}

# Follow a user (create the relationship)
PUT /users/alice/following/bob
→ 201 Created (first time) or 204 No Content (already following, idempotent)
Body: empty or { "followed_at": "2026-02-23T..." }

# Unfollow
DELETE /users/alice/following/bob
→ 204 No Content

# List who alice follows
GET /users/alice/following              → [ { user_id: "bob", ... }, ... ]

# List alice's followers
GET /users/alice/followers              → people following alice

# Check if alice follows bob
GET /users/alice/following/bob         → 200 (exists) or 404 (not following)
```

Why `PUT` instead of `POST` for following?

- PUT is idempotent: "PUT this relationship in place". Following alice when you already follow alice is a no-op. POST would create a duplicate.
- The resource path fully identifies the relationship: `PUT /users/alice/following/bob` — no request body needed to identify it.

Why not `POST /users/alice/follow`?

- Verb (`follow`) in URL violates REST naming
- POST is not idempotent — second call might create a duplicate follow record

Why not a separate `/follows` top-level resource?

- Could work: `POST /follows {follower: "alice", followee: "bob"}`
- Less discoverable: harder to go from `/users/alice` to "what does she follow?"
- Sub-resource is more aligned with user-centric navigation

---

**Q5: A legacy service uses `/api/getProduct?productId=abc` and you need to add a v2 that follows proper REST naming. How do you migrate without breaking existing clients?**

_What the interviewer is testing:_ Backward compatibility strategy, versioning, migration planning.

**Ideal Answer:**

This requires running both the old and new patterns simultaneously. Migration strategy:

**Phase 1 — Add new URLs alongside old (no changes to old):**

```
# Old (keep working forever during migration)
GET /api/getProduct?productId=abc      ← still works, returns deprecation headers

# New (proper REST)
GET /api/v2/products/abc              ← new path
```

**Phase 2 — Deprecation headers on old path:**

```http
HTTP/1.1 200 OK
Deprecation: true
Sunset: Mon, 01 Sep 2026 00:00:00 GMT
Link: </api/v2/products/abc>; rel="successor-version"
X-API-Migration-Guide: https://docs.api.com/migration/v1-to-v2
```

Client SDKs monitoring response headers get automated warnings.

**Phase 3 — Active migration support (90 days):**

- Migration guide with before/after examples
- Client libraries updated to point to new paths
- Monitoring: track % traffic still on old path; alert when > 5% after sunset

**Phase 4 — Permanent redirect (optional):**

```
GET /api/getProduct?productId=abc
→ 301 Moved Permanently
Location: /api/v2/products/abc
```

Note: 301 caches permanently in browser → risky if URL ever changes again. Use 302 if unsure.

**Phase 5 — Sunset old URL:**
After sunset date + confirmation client traffic is < 1%: return 410 Gone (not 404 — 410 explicitly means "permanently removed").

---

### Advanced Questions

**Q6: You're designing a REST API for a healthcare system managing patients, doctors, appointments, prescriptions, and lab results. Design the resource hierarchy and justify every nesting decision.**

_What the interviewer is testing:_ Ability to model complex domain relationships as a REST resource tree, making principled decisions.

**Discussion:**

```
STEP 1: Identify the entities (resources)
  Patients, Doctors, Appointments, Prescriptions, LabResults, Medications

STEP 2: Identify relationships
  Patient HAS MANY appointments
  Appointment HAS ONE patient, HAS ONE doctor
  Appointment MAY HAVE prescriptions (written at appointment)
  Patient HAS MANY lab results
  Prescription HAS ONE medication

STEP 3: Decide top-level vs nested
  Rule: Top-level if it can exist independently and has meaningful identity alone

  Top-level resources:
    /patients/{pat_id}        ← core domain entity
    /doctors/{doc_id}         ← core domain entity
    /appointments/{apt_id}    ← meaningful without per-patient context (admin views all)
    /prescriptions/{rx_id}    ← pharmacy needs to look up by prescription ID without patient
    /lab-results/{result_id}  ← lab system queries by result ID
    /medications/{med_id}     ← reference data (lookup without patient context)

  Nested access paths (aliases to above - same resource, different navigation path):
    /patients/{pat_id}/appointments   ← patient's appointments (filter by patient)
    /patients/{pat_id}/lab-results    ← patient's lab results
    /doctors/{doc_id}/appointments    ← doctor's schedule
    /appointments/{apt_id}/prescriptions  ← prescriptions written at this appointment

  NOT nested (because they're independently identifiable):
    /prescriptions/{rx_id}            ← pharmacy fills by rx_id, doesn't know patient_id
    /lab-results/{result_id}          ← lab system references by result id

RESULTING API:
  # Patient management
  GET    /patients/{pat_id}
  GET    /patients/{pat_id}/appointments?status=upcoming&limit=10
  GET    /patients/{pat_id}/lab-results?from=2026-01-01
  GET    /patients/{pat_id}/prescriptions?status=active

  # Appointment lifecycle
  POST   /appointments                ← create (with patient_id + doctor_id in body)
  GET    /appointments/{apt_id}
  PATCH  /appointments/{apt_id}       ← reschedule, update notes
  POST   /appointments/{apt_id}/cancel
  POST   /appointments/{apt_id}/check-in    ← patient arrives
  POST   /appointments/{apt_id}/complete    ← doctor marks complete

  # Prescription
  POST   /appointments/{apt_id}/prescriptions      ← written at appointment
  GET    /prescriptions/{rx_id}                    ← pharmacy lookup
  POST   /prescriptions/{rx_id}/fill               ← pharmacy fills it
  GET    /patients/{pat_id}/prescriptions?status=active  ← patient's active scripts

  # Lab results
  POST   /orders/lab-tests                         ← order a lab test (new resource: lab test order)
  GET    /lab-results/{result_id}                  ← result by ID
  GET    /patients/{pat_id}/lab-results            ← all results for patient

CRITICAL DESIGN DECISION: Why no /patients/{id}/doctors?
  A patient doesn't "own" their doctors — it's many-to-many via appointments.
  Relationship model: appointment links patient and doctor.
  /patients/{id}/appointments → include doctor info in appointment response.
  /patients/{id}/doctors would be derived data (list of unique doctors from appointments).
  Better: GET /patients/{id}/care-team → dedicated endpoint for "related doctors" concept.
```

---

## SECTION 10 — Comparison Tables

### Resource Naming Patterns: Correct vs Anti-Patterns

| Scenario          | Anti-Pattern               | REST Standard                          | Why Standard Wins                 |
| ----------------- | -------------------------- | -------------------------------------- | --------------------------------- |
| List collection   | `GET /getUsers`            | `GET /users`                           | HTTP GET is already the verb      |
| Create resource   | `POST /createUser`         | `POST /users`                          | POST on collection = create       |
| Read one resource | `GET /fetchUser?id=1`      | `GET /users/1`                         | Path param = resource identity    |
| Update partial    | `POST /updateEmail`        | `PATCH /users/1`                       | HTTP PATCH = partial update       |
| Replace full      | `POST /replaceProduct`     | `PUT /products/1`                      | HTTP PUT = full replace           |
| Delete            | `GET /deleteUser?id=1`     | `DELETE /users/1`                      | HTTP DELETE is the verb           |
| Nested resource   | `GET /getUserOrders?uid=1` | `GET /users/1/orders`                  | Hierarchy in URL = relationship   |
| State transition  | `POST /cancelOrder?id=1`   | `POST /orders/1/cancel`                | Action sub-resource               |
| Search/filter     | `GET /searchProducts?q=x`  | `GET /products?q=x`                    | Query param filters collection    |
| Activate state    | `GET /activateUser?id=1`   | `POST /users/1/activate`               | GET must be safe/idempotent       |
| Count             | `GET /countOrders`         | `GET /orders` + `X-Total-Count` header | Count is metadata, not a resource |

### Path Parameters vs Query Parameters Decision Table

| Type of data                  | Use                      | Example                          |
| ----------------------------- | ------------------------ | -------------------------------- |
| **Identifies the resource**   | Path param               | `/orders/{order_id}`             |
| **Filters a collection**      | Query param              | `/orders?status=pending`         |
| **Pagination control**        | Query param              | `/orders?page=2&limit=20`        |
| **Sort/order**                | Query param              | `/products?sort=price&order=asc` |
| **Search**                    | Query param              | `/products?q=headphones`         |
| **Response shaping**          | Query param              | `/users?fields=id,name,email`    |
| **Nested resource ownership** | Path param               | `/users/123/orders`              |
| **Action/operation**          | Path sub-resource + POST | `/orders/123/cancel`             |
| **Version**                   | Path prefix              | `/v1/users`                      |
| **Format**                    | Query param              | `/reports/123?format=pdf`        |

### Resource ID Types Comparison

| ID Type                | Example                                       | Pros                                              | Cons                                                                            | Best For                                                   |
| ---------------------- | --------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| **Sequential integer** | `/users/1`                                    | Human-readable, compact, sortable                 | Enumerable (security risk), hot partition in distributed DB, leaks record count | Internal admin APIs, non-sensitive IDs (blog post numbers) |
| **UUID v4**            | `/users/f47ac10b-58cc-4372-a567-0e02b2c3d479` | Non-guessable, globally unique, safe for sharding | Long, not human-memorable, not sortable                                         | Most production APIs, cross-system entities                |
| **Prefixed ID**        | `/customers/cus_K6W5`                         | Type-safe, human-friendly, non-guessable          | Requires ID generation service                                                  | Financial APIs, multi-entity systems (Stripe model)        |
| **Slug**               | `/products/iphone-15-pro`                     | Readable, SEO-friendly, bookmarkable              | Requires unique constraint, breaks on rename                                    | Public-facing content, CMS, product catalogs               |
| **Composite**          | `/repos/microsoft/vscode`                     | Natural identity for some domains                 | Complex routing, URL encoding issues                                            | Code repos, user-namespaced resources                      |
| **Hash/SHA**           | `/commits/abc123def`                          | Content-addressable, self-verifying               | Long, not human-readable                                                        | Git objects, content-based systems                         |

### Nesting Depth Decision Framework

| Depth                     | Pattern                          | When to Use                                                            | Example                                             |
| ------------------------- | -------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------- |
| **0** (top-level)         | `/resources`                     | Resource has independent identity; can be found without parent context | `/orders`, `/users`, `/products`                    |
| **1** (nested collection) | `/parent/{id}/resources`         | Resource conceptually belongs to parent; usually accessed via parent   | `/users/123/orders`, `/products/456/reviews`        |
| **2** (nested resource)   | `/parent/{id}/child/{id}`        | Specific item in a nested collection; item identity includes parent    | `/users/123/orders/ORD-456`                         |
| **2 + action**            | `/parent/{id}/child/{id}/action` | State transition on nested resource                                    | `/users/123/orders/ORD-456/cancel`                  |
| **3+**                    | Avoid                            | Overly deep coupling                                                   | Break into independent resources with query filters |

---

## SECTION 11 — Quick Revision

### 10 Key Takeaways

1. **URL = noun, HTTP method = verb**: Never put `get`, `create`, `delete`, `update`, `fetch` in a URL path. The HTTP method carries that meaning.

2. **Collections are always plural**: `/users`, `/orders`, `/products` — consistency matters more than grammar rules.

3. **Resource IDs in path, filters in query string**: `/users/123` (identity) vs `/users?role=admin` (filter).

4. **Nesting max 2 levels deep**: `/users/123/orders/ORD-456` is fine. Deeper than that — flatten and use query params.

5. **Non-CRUD operations → action sub-resource**: `POST /orders/123/cancel` for operations that go beyond field updates.

6. **Never sequential IDs in public APIs**: Use UUIDs or prefixed IDs — enumeration attacks, hot partitions, and business data leakage are all prevented.

7. **`/v1/` prefix freezes the contract**: Everything under `/v1/` is a promise you make to clients forever. Breaking changes need `/v2/`.

8. **Your URL is your cache key**: Random/inconsistent URLs destroy CDN cache efficiency. Clean nouns = predictable cache keys.

9. **Naming is your security boundary**: Path params (not body params) for tenant/authorization identifiers — API Gateway can enforce auth on path params without body parsing.

10. **Wrong naming is permanent technical debt**: Slack built 50+ verb-URL endpoints before REST conventions; they can never rename without breaking thousands of integrations. Get it right before first release.

### 30-Second Explanation

"REST resource naming means your URLs identify things (nouns), and HTTP methods describe the action (verbs). Always use plural nouns — `/users`, `/orders` — with the resource ID as a path parameter: `/users/123`. Nesting represents relationships: `/users/123/orders`. Non-CRUD operations go to action sub-resources: `POST /orders/123/cancel`. Filters and search use query parameters. Never put verbs in URLs — that's RPC-style and breaks HTTP caching, security enforcement, and API discoverability."

### Memory Tricks

**"NAVI"** — the 4 resource naming rules:

- **N**ouns only in URL (no verbs)
- **A**ll collections plural
- **V**alid IDs in path (non-sequential)
- **I**dentity = path param, Filter = query param

**ID selection: "SPUH"**

- **S**equential: internal only (dangerous public)
- **P**refixed: financial/multi-type systems
- **U**UID: general purpose safe default
- **H**uman slug: public content/SEO

**Nesting depth rule: "Two is through"**

- Zero levels: top-level entity
- One level: nested collection
- Two levels: specific resource in nested collection
- Three+: you've gone too deep, flatten it

**Anti-pattern detector — URL alarm words:**
If your URL contains any of these words, it's wrong:
`get, fetch, list, create, add, update, delete, remove, search, find, check, calculate, process, send, cancel`
(These words belong in the HTTP method or request body, not the URL)

---

## SECTION 12 — Architect Thinking Exercise

### The Problem

You're the API Architect at **TalentLink**, a job platform (like LinkedIn Jobs). The existing API was built 3 years ago by a fast-moving startup team and looks like this:

```
GET  /api/getJobs?employerId=123
POST /api/createJob
GET  /api/getJobById?id=456
POST /api/applyToJob       Body: { jobId: 456, applicantId: 789 }
GET  /api/getApplicationsForJob?jobId=456
GET  /api/getApplicationsForApplicant?applicantId=789
POST /api/updateApplicationStatus   Body: { appId: 111, status: "interview" }
GET  /api/searchJobs?keywords=python&location=remote
POST /api/withdrawApplication  Body: { appId: 111 }
GET  /api/getEmployerProfile?id=123
GET  /api/getSavedJobs?applicantId=789
POST /api/saveJob          Body: { jobId: 456, applicantId: 789 }
```

**The problem:** A major enterprise client (10,000 seats) wants to integrate via your API but their legal and security team requires:

1. "Standard REST API" — they'll reject RPC-style URL patterns in security audit
2. CDN caching for job listings (their platform will display real-time job feeds)
3. Per-client rate limiting (they have 10,000 users generating concurrent traffic)
4. Clear versioning so your future changes don't break their integration

You have 2 months. **Design the new API.** Address:

- Resource hierarchy design
- What stays the same (non-breaking)
- What needs new versioning
- How you handle migration

---

_Think through your design. Then read the solution below._

---

### Wrong Approach

```
"Just rename the endpoints and release":
  GET /jobs       (renamed from /getJobs)
  POST /jobs      (renamed from /createJob)

→ Breaks every existing client immediately. No migration period. Enterprise client you were
  trying to impress now can't integrate because their dev team was already building against
  the old URLs.

"Wrap the old API with a facade that translates":
  New: GET /v2/jobs
  Facade: internally calls GET /api/getJobs

→ Creates technical debt forever. Two representations of same data. Bugs in both paths.
  Performance hit from double routing. You still need to maintain the old API.

"Add /v2 prefix to everything and leave v1 alone":
  Without deprecation strategy: v1 and v2 both maintained indefinitely.
  Eventually: supporting 3 versions, diverging behavior, impossible to maintain.
```

---

### Correct Architectural Approach

#### Step 1: Design the New Resource Hierarchy

```
Base: https://api.talentlink.com/v2

EMPLOYERS (companies posting jobs)
  GET    /employers/{employer_id}            Profile
  PATCH  /employers/{employer_id}            Update profile

JOBS (job postings)
  GET    /jobs                               All active jobs (public, CDN-cacheable)
  POST   /employers/{employer_id}/jobs       Create job (employer context required)
  GET    /jobs/{job_id}                      Job details (public, CDN-cacheable)
  PATCH  /jobs/{job_id}                      Update job posting
  DELETE /jobs/{job_id}                      Close/remove job posting
  POST   /jobs/{job_id}/close                Explicitly close a job (state transition)

APPLICATIONS (job-applicant relationships)
  POST   /jobs/{job_id}/applications         Apply to job
  GET    /jobs/{job_id}/applications         Employer views applicants for a job
  GET    /applications                       Applicant views their own applications (JWT-scoped)
  GET    /applications/{app_id}              Specific application
  PATCH  /applications/{app_id}              Employer updates status (interview, reject, offer)
  POST   /applications/{app_id}/withdraw     Applicant withdraws application

SAVED JOBS (bookmarks)
  GET    /users/me/saved-jobs                Applicant's saved jobs
  PUT    /users/me/saved-jobs/{job_id}       Save a job (PUT = idempotent)
  DELETE /users/me/saved-jobs/{job_id}       Unsave
```

#### Step 2: Map Old → New (Migration Mapping Document)

```
Old URL                              → New URL                              Status
---------------------------------------------------------------------------
GET /api/getJobs?employerId=123      → GET /jobs?employerId=123             ✅ v2
POST /api/createJob                  → POST /employers/{id}/jobs            ✅ v2
GET /api/getJobById?id=456           → GET /jobs/456                        ✅ v2
POST /api/applyToJob                 → POST /jobs/456/applications          ✅ v2
GET /api/getApplicationsForJob       → GET /jobs/456/applications           ✅ v2
GET /api/getApplicationsForApplicant → GET /applications (JWT-scoped)       ✅ v2
POST /api/updateApplicationStatus    → PATCH /applications/111              ✅ v2
GET /api/searchJobs?keywords=python  → GET /jobs?q=python&location=remote   ✅ v2
POST /api/withdrawApplication        → POST /applications/111/withdraw      ✅ v2
GET /api/getEmployerProfile?id=123   → GET /employers/123                   ✅ v2
GET /api/getSavedJobs?applicantId=789 → GET /users/me/saved-jobs            ✅ v2
POST /api/saveJob                    → PUT /users/me/saved-jobs/{job_id}    ✅ v2
```

#### Step 3: CloudFront Cache Strategy (Addresses Enterprise Requirement)

```
/v2/jobs*               → Cache-Control: public, max-age=60, s-maxage=120
/v2/jobs/{id}           → Cache-Control: public, max-age=300, stale-while-revalidate=60
/v2/applications*       → Cache-Control: private, no-store
/v2/users/me/*          → Cache-Control: private, no-store

Enterprise client benefit:
  Their platform fetches /v2/jobs for feed display → CloudFront cache hit ratio 90%+
  → 10K users hitting job feed = ~1K origin requests/min (vs 10K without CDN)
  → Their rate limit consumption drops 90%
```

#### Step 4: Per-Client Rate Limiting (API Gateway Usage Plans)

```
Enterprise client: API key = apikey_enterprise_talentlink
  Usage Plan: 50,000 req/hour, burst 500/sec

Free tier: 100 req/hour
Standard: 5,000 req/hour

Enterprise client's 10K users behind one API key:
  50,000 req/hour = ~14/sec average, burst 500/sec peak
  Rate limit headers in every response:
    X-RateLimit-Limit: 50000
    X-RateLimit-Remaining: 49453
    X-RateLimit-Reset: 1709251260   ← Unix timestamp for hourly reset
```

#### Step 5: Migration Timeline (2 months)

```
Month 1, Week 1-2:  Build /v2 API alongside /v1 API (both running)
Month 1, Week 3-4:  Documentation + migration guide published
                    Enterprise client starts integration testing against /v2
Month 2, Week 1-2:  Deprecation headers on all /v1 responses:
                      Deprecation: true
                      Sunset: 2026-09-01T00:00:00Z
                    Monitor: v1 traffic % per client
Month 2, Week 3-4:  Enterprise client live on /v2
                    Other clients migrating
                    v1 sunset date announced to all clients via email

After 2 months:
  v1: returns Deprecation headers + warning for 6 more months
  v1 sunset: 301 → /v2 equivalent for GET requests (can auto-redirect reads)
              POST/PATCH/DELETE: return 410 Gone with migration guide URL
```

#### Final Principles Demonstrated

```
1. Never break existing clients — run both versions in parallel during migration
2. Resource naming is a public contract — fix it before enterprise adoption locks it in forever
3. Clean REST naming + CDN = 90% cache hit ratio for public data
4. Path structure drives security: /jobs/{id}/applications → employer must own the job
   (JWT claim company_id must match job's company_id, enforced by API Gateway authorizer)
5. State transitions (withdraw, close) are POST to action sub-resources —
   they're business operations, not field updates
```
