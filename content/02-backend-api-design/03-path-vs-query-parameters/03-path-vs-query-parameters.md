# Path vs Query Parameters — Part 3 of 3

### Sections: 9 (Interview Prep), 10 (Comparison Tables), 11 (Quick Revision), 12 (Architect Thinking Exercise)

**Series:** Backend & API Design → REST APIs → System Design

---

## SECTION 9 — Interview Preparation

### Beginner Questions

**Q1: What is the difference between a path parameter and a query parameter? Give an example of when you'd use each.**

_What the interviewer is testing:_ Basic REST API design literacy.

**Ideal Answer:**

A **path parameter** is part of the URL's resource path. It identifies a specific resource. The request is meaningless without it.
A **query parameter** comes after the `?` in the URL. It filters, sorts, paginates, or otherwise modifies the response. It's optional — the endpoint works without it.

```
Path parameter example:
  GET /users/123                     ← 123 identifies which user
  Without 123: GET /users/  ← invalid route

Query parameter example:
  GET /users?role=admin&sort=name    ← filter and sort
  Without params: GET /users          ← still valid, returns all users
```

Simple decision rule: **"If removing this parameter breaks the request semantically, it's a path param. If the endpoint still makes sense without it, it's a query param."**

---

**Q2: When should you NOT use a query parameter for something that feels optional?**

_What the interviewer is testing:_ Understanding of edge cases and security implications.

**Ideal Answer:**

Three cases where something is "optional" but shouldn't be a query param:

1. **API versioning**: `/v1/products` not `/products?version=1`. Version is not a optional modifier — it specifies which contract applies. Query string versioning is unreliable (clients forget it, CDNs cache without it).

2. **Authentication tokens**: Never in query strings. `GET /admin?token=secret123` — tokens in query strings appear in browser history, server access logs, proxy logs, CDN logs in plaintext. Always use Authorization header.

3. **Tenant identifiers in multi-tenant systems**:

```
BAD:   GET /products?tenantId=acme-corp
GOOD:  GET /products  (tenant extracted from JWT claim)
       OR: GET /tenants/acme-corp/products (path param)
```

Reason: tenantId in query param can be forgotten (missing → wrong tenant's data returned), manipulated (client passes different tenantId → wrong data), and is harder for API Gateway to enforce as an authorization gate.

---

### Intermediate Questions

**Q3: Your API endpoint `GET /orders` needs to support filtering by status, date range, customer ID, and pagination. Design the complete URL structure.**

_What the interviewer is testing:_ Practical query parameter design skills.

**Ideal Answer:**

```
GET /orders
  ?status=pending                    ← filter by status (can repeat: ?status=pending&status=confirmed)
  &from=2026-01-01                   ← date range start
  &to=2026-01-31                     ← date range end
  &customerId=CUST-abc123            ← filter by customer
  &sort=created_at                   ← sort field
  &order=desc                        ← sort direction (default: desc)
  &limit=20                          ← page size (default: 20, max: 100)
  &page=1                            ← page number (default: 1)

Full example:
  GET /orders?status=pending&from=2026-01-01&to=2026-01-31&sort=created_at&order=desc&limit=20&page=1

Design decisions:
1. customerId as query — not path — because orders are top-level; customer is a filter, not owner
   (An admin can view any customer's orders without changing the resource structure)
2. status can repeat: ?status=pending&status=confirmed → filter for "pending OR confirmed"
3. Always validate sort field against whitelist: ['created_at', 'total', 'status']
4. Enforce limit max: client sends limit=10000 → server caps at 100 → prevents denial of service
5. Return pagination metadata in response body AND Link header:
   X-Total-Count: 347
   Link: </orders?page=2&limit=20&status=pending>; rel="next"
```

---

**Q4: You have two API designs for accessing a specific user's profile:
Option A: `GET /users/123/profile`
Option B: `GET /profile?userId=123`
Which is better and why?**

_What the interviewer is testing:_ Understanding resource identity and nesting.

**Ideal Answer:**

**Option A is better** for almost all cases. Here's why:

1. **Identity belongs in the path**: `123` identifies which user — it IS the resource identity. Resources are addressed via path, not via query filter.

2. **Security enforcement**: API Gateway can extract `123` from path param and compare with JWT `sub` claim. Clean authorization gate. With query param, authorizer must parse query string.

3. **Caching**: `GET /users/123/profile` → clean cache key. `GET /profile?userId=123` → query-param cache key (less reliable if other query params are added).

4. **REST semantics**: `/profile?userId=123` implies "filter profiles by userId" — but a user has exactly one profile. It's not a filtered collection.

**Exception — when Option B is valid:**

```
GET /profile?userId=123   ← acceptable ONLY when:
  - There's no pre-known profile ID (just have userId)
  - Profile is a singleton (not a collection, no nesting needed)
  - The primary use case is: "look up a profile by external ID"
  - Example: admin lookup: GET /profiles?externalId=github-user-123
```

The key question: "Is this a filter on a collection, or is it identifying a specific resource?" Profile for user 123 is a specific resource, so path param wins.

---

**Q5: A developer on your team suggests: "Let's pass the authorization token as a query param `?auth_token=Bearer xxx` so it's easier to test in the browser." How do you respond?**

_What the interviewer is testing:_ Security awareness around parameter placement.

**Ideal Answer:**

This should never go to production. Tell them (diplomatically) that this is a security vulnerability:

```
Why token-in-query-param is dangerous:

1. LOGS: Server access logs record the full URL including query params.
   GET /admin?auth_token=super_secret_jwt
   → This JWT appears in:
     - Your API Gateway access logs
     - CloudFront logs (stored in S3)
     - ALB access logs
     - Your application's debug logs
     - Reverse proxy/nginx logs
     - Any third-party monitoring tool receiving your logs
   All of these could be accessed by people who shouldn't have auth tokens.

2. BROWSER HISTORY: The URL (with token) appears in browser history,
   auto-complete, can be re-shared accidentally.

3. REFERER HEADER: If the page with this URL links to another resource,
   the Referer header sends the FULL URL (including token) to the next server.

4. SHARING: "Share this URL" includes the auth token. Shared with a colleague,
   screenshot, in a bug report — all expose the token.

Correct way to test in browser: Use browser extensions like ModHeader to add
Authorization: Bearer <token> header. Or use Postman/Insomnia with header auth.
One-time test URLs: use short-lived signed URLs (AWS pre-signed URLs)
where the signing is via HMAC, not raw bearer tokens.
```

---

### Advanced Questions

**Q6: Design the URL and parameter structure for a multi-tenant SaaS analytics API where tenants are identified by subdomain AND path, and users query time-series data with complex filtering.**

_What the interviewer is testing:_ Complex parameter design, multi-tenant architecture, performance awareness.\*

**Complete Design:**

```
Multi-tenant access patterns:

Option A: Subdomain-based tenant identification
  acme.api.datapulse.com/v1/metrics/{metric_id}?from=...

Option B: Path-based tenant identification
  api.datapulse.com/v1/tenants/{tenant_id}/metrics/{metric_id}?from=...

CHOSEN: Path-based (Option B) for primary API, subdomain as optional convenience alias
Reason: Path-based works with single CloudFront distribution; tenant_id extractable by API GW;
        subdomain-based requires wildcard certificate + per-tenant routing complexity

Full parameter design:

GET /v1/tenants/{tenant_id}/metrics/{metric_id}
    ?from=2026-01-01T00:00:00Z        ← ISO 8601 datetime (required for time series)
    &to=2026-01-31T23:59:59Z          ← end datetime (required for time series)
    &granularity=hour                  ← aggregation granularity: minute|hour|day|week|month
    &dimensions[]=region               ← group by dimensions (repeatable)
    &dimensions[]=product_id
    &filter=region:us-east-1           ← dimension filter (key:value)
    &filter=status:active
    &aggregation=sum                   ← aggregation function: sum|avg|min|max|count
    &timezone=America/New_York         ← display timezone for bucketing

Route path parameters:
  /v1/tenants/{tenant_id}    → tenant_id: authorization boundary
  /metrics/{metric_id}       → metric_id: identifies the specific metric definition

Lambda Authorizer:
  1. Extract tenant_id from path
  2. Extract sub from JWT
  3. Verify user belongs to tenant: SELECT 1 FROM memberships WHERE user=sub AND tenant=tenant_id
  4. Verify user has read:metrics permission in their role
  5. Inject tenant_id into Lambda event context (so Lambda trusts this, not re-extracts from URL)

Query parameter validation:
  from, to: required, must be valid ISO 8601, from < to, range ≤ 366 days
  granularity: whitelist enum, validate against range (hour granularity for 1-year range → 8760 points → cap or require day granularity)
  dimensions: whitelist per metric definition (can't group by arbitrary fields)
  filter: parse key:value, validate key is a valid dimension for this metric
  aggregation: whitelist enum

For complex filters (many dimensions, nested AND/OR):
  POST /v1/tenants/{tenant_id}/metrics/{metric_id}/query
  Body: {
    "from": "2026-01-01T00:00:00Z",
    "to": "2026-01-31T23:59:59Z",
    "granularity": "day",
    "filters": {
      "and": [
        { "dimension": "region", "operator": "in", "values": ["us-east-1", "us-west-2"] },
        { "dimension": "status", "operator": "eq", "value": "active" }
      ]
    },
    "group_by": ["region", "product_id"],
    "aggregation": "sum"
  }

  Rule: When filter complexity exceeds what fits cleanly in query params,
        expose a /query sub-resource accepting POST with body.
        Keep the GET endpoint for simple cases (single filters).
```

---

## SECTION 10 — Comparison Tables

### Path vs Query Parameter Decision Reference

| Characteristic       | Path Parameter                  | Query Parameter                               |
| -------------------- | ------------------------------- | --------------------------------------------- |
| **Required?**        | Always required                 | Usually optional                              |
| **Purpose**          | Identifies a resource           | Filters/modifies the response                 |
| **URL position**     | Before `?`                      | After `?`                                     |
| **Cache key**        | Always included                 | Configurable (include/exclude per CDN policy) |
| **Authorization**    | Easy (API GW extracts reliably) | Complex (requires query string parsing)       |
| **REST semantics**   | "Navigate to this resource"     | "Apply this option to the view"               |
| **Logging**          | Clean path-level grouping       | Appears inline with path in logs              |
| **Security risk**    | Path traversal                  | SQLi, XSS, parameter pollution, PII in logs   |
| **Missing behavior** | 404 (route not matched)         | Server uses default value                     |
| **Multiple values**  | N/A (single value per segment)  | Repeated key or CSV                           |
| **URL readability**  | High (clean hierarchy)          | Medium (key=value syntax)                     |

### Common Parameter Placement Mistakes and Corrections

| Mistake                                      | Corrected Version                                  | Reason                                              |
| -------------------------------------------- | -------------------------------------------------- | --------------------------------------------------- |
| `GET /users?id=123`                          | `GET /users/123`                                   | ID is resource identity → path                      |
| `GET /orders?sort=recent` → no default       | `GET /orders?sort=created_at&order=desc`           | Always provide explicit defaults                    |
| `GET /users?auth_token=Bearer_xxx`           | Authorization header                               | Token in URL = security risk                        |
| `GET /products?version=2`                    | `GET /v2/products`                                 | Version is contract, not filter                     |
| `GET /users?page=1&pageSize=10&totalPages=5` | Request carries page/limit; response carries total | Total pages is response metadata, not request param |
| `GET /items?tenantId=abc`                    | JWT claim or `/tenants/abc/items`                  | Tenant ID should not be client-controlled filter    |
| `DELETE /users?id=123`                       | `DELETE /users/123`                                | All methods use path for resource ID                |
| `GET /search?query=shoes&customerId=123`     | `GET /products?q=shoes` (auth from JWT)            | Customer ID from auth, not param                    |

### Query Parameter Types Reference

| Type                     | Pattern               | Example                            | Notes                                            |
| ------------------------ | --------------------- | ---------------------------------- | ------------------------------------------------ |
| **Single value**         | `?key=value`          | `?status=active`                   | Most common                                      |
| **Enum value**           | `?key=a\|b\|c`        | `?order=asc`                       | Validate against whitelist                       |
| **Number**               | `?key=integer`        | `?limit=20`                        | Validate min/max                                 |
| **Boolean**              | `?key=true/false`     | `?includeDeleted=true`             | Explicit true/false preferred over presence-only |
| **Date**                 | `?key=ISO8601`        | `?from=2026-01-01`                 | ISO 8601 format, UTC recommended                 |
| **Multi-value (repeat)** | `?key=v1&key=v2`      | `?status=pending&status=confirmed` | Framework parses as array                        |
| **Multi-value (CSV)**    | `?key=v1,v2,v3`       | `?fields=id,name,email`            | Simpler URL, but commas in values need escaping  |
| **Range**                | `?min=x&max=y`        | `?minPrice=100&maxPrice=500`       | Two params for ranges                            |
| **Cursor**               | `?after=cursor_token` | `?after=eyJpZCI6MTIzfQ==`          | For cursor-based pagination                      |

---

## SECTION 11 — Quick Revision

### 10 Key Takeaways

1. **Path param = identity**: If the request makes no sense without it, it belongs in the path. `GET /users/` to do what? Nothing without the ID.

2. **Query param = optional modifier**: If the endpoint works without it (just returning unfiltered / unsorted / default data), it's a query param.

3. **Never put auth tokens in query strings**: URLs appear in logs, browser history, Referer headers. Authorization belongs in the `Authorization` header, always.

4. **Version is a path prefix, not a query param**: `/v1/users` freezes a contract. `?version=1` is too easily forgotten and not cache-friendly.

5. **Query param normalization = cache efficiency**: Same data, different param orders → different cache keys by default. Normalize alphabetically at CDN or middleware.

6. **Exclude tracking params from cache key**: UTM params, analytics IDs, session IDs → never affect response content → exclude from CDN cache key.

7. **Security gates use path, not query**: API Gateway/Lambda Authorizer can reliably enforce auth based on path segments. Query param enforcement is fragile.

8. **For complex filters, use POST with body**: When filter logic exceeds what fits cleanly in query params (nested AND/OR, arrays of objects), use `POST /resource/query` with a JSON filter body.

9. **Validate all query params at the boundary**: Whitelist allowed values, set min/max on numbers, validate date formats. Never trust raw query params.

10. **PII in query params = compliance risk**: Search queries like `?email=john@company.com` may land in CDN logs, access logs, traces. Handle PII with POST body or consider tokenized search.

### 30-Second Explanation

"Path parameters identify a resource — they're required and are part of the URL route. Query parameters filter, sort, paginate, or shape the response — they're optional and come after the `?`. The decision rule: if removing the parameter makes the request meaningless, it's a path param; if the endpoint still works without it, it's a query param. Never put auth tokens in query strings — they end up in logs. Always normalize query param order for CDN cache efficiency. For complex query structures that don't fit in query params, use a POST body on a dedicated `/query` sub-resource."

### Memory Tricks

**"ROOF" — path parameter must be REQUIRED, points to One specific resource, part Of the Foundation of the URL**

**Safe → Query. Specific → Path.**

- Safe to omit? → Query param
- Specific resource identity? → Path param

**PII never flies in Query**
(PII should never be in query params because they end up in logs)

**Authentication = Authorize (header), never Appear in URL**

---

## SECTION 12 — Architect Thinking Exercise

### The Problem

You're the API architect at **SwiftDelivery**, a logistics platform. The platform has:

- **Drivers** who are employees
- **Deliveries** (packages with routes and status)
- **Routes** (sets of deliveries for one driver + time window)
- **Customers** (who placed orders)

Here's what a junior developer proposed for the API:

```
GET  /api/getDriverDeliveries?driverId=D001&status=pending&date=2026-02-23
GET  /api/getDeliveryById?id=DEL-123
POST /api/assignDeliveryToDriver?deliveryId=DEL-123&driverId=D001
PUT  /api/updateDeliveryStatus?id=DEL-123&status=delivered
GET  /api/searchDeliveries?customerId=C456&from=2026-01-01&to=2026-01-31
GET  /api/getRouteForDriver?driverId=D001&date=2026-02-23
POST /api/createRoute       Body: { driverId, date, deliveryIds }
```

**Problems:**

1. Operations team can't set up CDN caching on the delivery details (uses query param for ID)
2. Security audit failed: tenant isolation not enforced at gateway level
3. New mobile client needs delivery tracking without driver context — current API impossible
4. Log monitoring can't set up per-delivery latency alerts

**Redesign the API.** Address all 4 problems with your design.

---

_Work through it before reading the solution._

---

### Wrong Approach

```
"Just move the ids from query params to path params":
  GET /api/drivers/{driverId}/deliveries?status=pending&date=2026-02-23

But this doesn't solve:
  - "New mobile client needs delivery tracking without driver context"
    → If delivery is always under /drivers/{id}/deliveries, you NEED the driver ID
    → Mobile app has delivery_id (from QR scan or customer's email) — not driver_id
  - Tenant isolation still not addressed (what IS the tenant here?)
  - Action endpoints still have verbs: /assignDeliveryToDriver
```

---

### Correct Redesign

#### Step 1: Identify Resources and Their Correct Access Patterns

```
Resources:
  - Driver (company employee, known by driver ID)
  - Delivery (a package with status, addressee, route assignment)
  - Route (a set of deliveries for a driver on a date)
  - Customer (placed the order; has deliveries destined for them)

Access patterns:
  - Driver views their own deliveries for today → GET /routes/{date}?driverId=... NO
    → Better: the route for a driver on a date IS a specific resource
    → GET /routes/{driver_id}/{date} OR GET /drivers/{driver_id}/routes/{date}

  - Operations assigns delivery to route → PATCH /deliveries/{id} OR POST /routes/{id}/deliveries

  - Customer tracks delivery by tracking code → GET /deliveries/{tracking_code}
    → tracking code is identity — path param, no driver context needed (solves problem 3)

  - Operations searches deliveries by customer + date range → GET /deliveries?customerId=C456&from=...
```

#### Step 2: Redesigned API

```
BASE: /v1

DELIVERIES (top-level — trackable without driver context → solves problem 3 + 4):
  GET  /deliveries                          ← list deliveries (admin/ops context)
  GET  /deliveries/{delivery_id}            ← get by ID (path param → CDN cacheable → solves 1)
  GET  /deliveries/{tracking_code}          ← customer-facing tracking (same endpoint, slug ID)
  PATCH /deliveries/{delivery_id}           ← update delivery (status, notes)
  GET  /deliveries?customerId=C456&from=2026-01-01&to=2026-01-31  ← search by customer

  # Status update (state transition with business logic)
  POST /deliveries/{delivery_id}/status-updates    ← log a status change
  Body: { "status": "delivered", "timestamp": "...", "location": {...}, "signature": "..." }

  # CloudFront caching:
  GET /deliveries/{id} → Cache-Control: public, max-age=10, stale-while-revalidate=30
  (Short TTL: delivery status changes frequently; but CDN helps with burst traffic to same delivery)

DRIVERS:
  GET  /drivers/{driver_id}                  ← driver profile
  GET  /drivers/{driver_id}/routes           ← all routes for driver
  GET  /drivers/{driver_id}/routes/{date}    ← specific day's route (date = path, not query)
  ← Addresses problem 4: alerts on GET /drivers/D001/routes/2026-02-23 → specific monitoring

ROUTES:
  POST /routes                               ← create a route
  GET  /routes/{route_id}                    ← specific route
  POST /routes/{route_id}/deliveries         ← add delivery to route (assignment)
  DELETE /routes/{route_id}/deliveries/{delivery_id}   ← remove from route
  POST /routes/{route_id}/start              ← driver starts route (state transition)
  POST /routes/{route_id}/complete           ← route completed
```

#### Step 3: Solving Problem 2 (Tenant Isolation at Gateway)

```
Tenant = the logistics company using SwiftDelivery as a platform.

Path-based tenant isolation:
  /v1/tenants/{tenant_id}/drivers/{driver_id}
  /v1/tenants/{tenant_id}/deliveries/{delivery_id}

  Lambda Authorizer:
    pathParameters.tenant_id → must match JWT claim tenant_id
    → if mismatch: 403 immediately, no Lambda invocation

  EXCEPTION: Customer tracking is cross-tenant (customer doesn't have tenant context):
  /track/{tracking_code}   ← public-facing, no tenant in path
    → server resolves tenant from tracking_code (opaque code includes tenant shard info)
    → no tenant isolation needed (tracking codes are per-delivery, no cross-tenant risk)
```

#### Step 4: Mapping Old → New with Migration Headers

```
Old URL → New URL (add Deprecation headers to old responses):

GET /api/getDeliveryById?id=DEL-123
→ Redirect (301) to: GET /v1/deliveries/DEL-123
  Deprecation: true
  Sunset: 2026-09-01
  Link: </v1/deliveries/DEL-123>; rel="successor-version"

GET /api/getDriverDeliveries?driverId=D001&status=pending
→ New: GET /v1/drivers/D001/deliveries?status=pending&date=2026-02-23

POST /api/updateDeliveryStatus?id=DEL-123&status=delivered
→ New: POST /v1/deliveries/DEL-123/status-updates
       Body: { "status": "delivered" }
```

#### Key Principles Applied

```
1. Deliveries are top-level (not nested under drivers) → any client can access by ID
   → Solved mobile app problem (problem 3)
   → Solved CDN caching (path ID → clean cache key) (problem 1)
   → Solved monitoring (GET /deliveries/DEL-123 → specific URL to alert on) (problem 4)

2. Tenant in path → API Gateway enforces isolation at the route level (problem 2)

3. Date as path param in /routes/{date} → the route for a specific date is a specific resource
   Compared to: /routes?date=2026-02-23 → date as filter → ambiguous (all routes on date)

4. Status changes as action sub-resource → PATCH /deliveries/{id} would just set a field
   → POST /deliveries/{id}/status-updates → creates a status change record with metadata
      (who made the change, when, GPS location, signature) — richer than a field update
```
