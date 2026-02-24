# Path vs Query Parameters — Part 1 of 3

### Sections: 1 (Intuition), 2 (Why It Exists), 3 (Core Technical Deep Dive), 4 (Real-World API Contract & Request Flow)

**Series:** Backend & API Design → REST APIs → System Design
**Topic:** Path vs Query Parameters — knowing which belongs where, and why it matters for caching, security, and clarity

---

## SECTION 1 — Intuition: Build the Mental Model First

### Analogy 1: The Physical Address vs Room Service

You call a hotel reception and say: **"Room 412 — please send coffee."**

- **"Room 412"** = path parameter → identifies _which specific resource_ you're talking about. Without this, there's no request. The destination IS the identity.
- **"please send coffee"** = query/body parameter → _how you want it, what options apply_. The room exists regardless of whether you order coffee or not.

```
Hotel address: Room 412, Morning call at 7am, Hypoallergenic pillow
               ↓                ↓                   ↓
REST URL:    /rooms/412     ?time=07:00          &pillow=hypoallergenic
                                └─────── query params (options, not identity) ─────┘
Path param: 412 (identifies the room — without it, you're talking to no one)
```

### Analogy 2: The Library Catalog System

You walk into a library. You're looking for books by Hemingway published after 1930, sorted by title.

- **Which section?** "Fiction, American Literature, H shelf" → **path** — this is where you physically navigate. The section's existence is independent of your search.
- **What specific filter?** "By Hemingway, after 1930, sorted by title" → **query** — these are filters/modifiers you apply to what's already at the shelf location.

```
/library/fiction/american-literature?author=hemingway&after=1930&sort=title

Path:        /fiction/american-literature   ← where you go (identity of the collection)
Query:       ?author=hemingway              ← who wrote it (filter)
             &after=1930                    ← when it was written (filter)
             &sort=title                    ← how to order results (modifier)
```

The American Literature section exists whether you search for Hemingway or not. The path names a stable location. The query personalizes the view of that location.

### Analogy 3: The Spreadsheet Column Filter

Think of a collection endpoint (`GET /products`) as a spreadsheet with all products.

- **Path params** = which spreadsheet you open (the identity of the data source)
- **Query params** = which rows you show, which columns, in which order

```
/products             ← open the Products spreadsheet (identity)
?category=electronics ← show only Electronics rows (filter)
&minPrice=100         ← show only rows where price ≥ 100 (filter)
&sort=price           ← order rows by price (sort)
&limit=20&page=2      ← show only 20 rows, page 2 (pagination)
&fields=id,name,price ← show only these columns (projection)
```

The spreadsheet exists without the filters. The filters just control what you see.

---

## SECTION 2 — Why It Exists: The Problem History

### The Two Original URL Constructs (RFC 3986)

The distinction between path and query parameters is baked into the URL specification itself (RFC 3986, 1994):

```
URI = scheme://authority/path[?query][#fragment]

Example: https://api.shop.com/v1/products/123?color=blue&size=M

Scheme:    https
Authority: api.shop.com
Path:      /v1/products/123       ← hierarchical identifier
Query:     color=blue&size=M      ← non-hierarchical, optional modifiers
Fragment:  (none)
```

The inventors of the URL spec made a deliberate distinction:

- **Path**: hierarchical, positional, part of the resource's fundamental identity
- **Query**: key-value modifiers, filters, options — non-hierarchical, supplementary

This distinction is the foundation of every HTTP cache, every CDN, every router, and every API framework.

### The Problems That Emerge When You Ignore This Distinction

#### Problem 1: You break CDN caching

CDN cache keys are derived from the URL. The path and query string behave differently across CDN systems.

**Scenario:** An e-commerce site with 1M product pages.

```
# Developer ignores convention:
GET /products?id=12345           ← id is a query param (wrong!)

# CloudFront behavior:
# Query strings are forwarded to origin BY DEFAULT in some CDN configs
# Cache key might include ALL query params
# GET /products?id=12345&session=abc ← different cache key!
# GET /products?id=12345&utm_source=email ← yet another cache key!
# Result: zero CDN cache hits for product pages, 100% origin traffic

# With path param (correct):
GET /products/12345              ← id is a path param
# Cache key: /products/12345
# Query params stripped: UTM params, session params don't affect cache key
# CDN hit ratio: 90%+
```

Query strings contaminate cache keys with tracking params, session IDs, A/B test flags — things that don't affect the response but destroy cache efficiency. Path params are clean, fixed identity.

#### Problem 2: Log analysis and monitoring break

```
# Bad — id in query string:
GET /products?id=123 → your logs show access to "/products"
GET /products?id=456 → your logs show access to "/products"  (same URL string!)

Consequence:
  - "What's the most-accessed product?" → can't answer from path alone, must parse query string
  - "Monitor GET /products/123 latency trends" → impossible with query-string IDs
  - Distributed tracing: trace shows "/products" for every product request → useless

# Good — id as path param:
GET /products/123 → logs show "/products/123"
GET /products/456 → logs show "/products/456"  (distinct URLs!)

Consequence:
  - "Most accessed product": count by URL path → immediate answer
  - "P99 latency for product 123": filter by path /products/123 → instant
  - Alert: "GET /products/123 response time > 500ms" → specific, actionable
```

#### Problem 3: Authorization enforcement at the gateway level breaks

API Gateway and Lambda Authorizers extract path parameters easily from URL routing patterns. Query parameters require body/query-string parsing — more complex and error-prone.

```
# Path param — clean authorization:
GET /vendors/VND-abc/products

Lambda Authorizer:
  event.pathParameters.vendor_id = "VND-abc"   ← clean extraction
  check: JWT claim vendor_id == "VND-abc"       ← simple comparison

# Query param — messy authorization:
GET /products?vendor_id=VND-abc

Lambda Authorizer:
  event.queryStringParameters.vendor_id = "VND-abc"
  BUT: what if client omits vendor_id? → null pointer
  AND: what if client includes vendor_id in body instead? → not visible to authorizer
  RISK: client passes vendor_id=VND-abc in query + different vendor_id in POST body
       → authorization gate sees correct, service gets malicious value
```

#### Problem 4: REST clients and tools break

```
# Popular REST clients (Postman, Insomnia, curl) understand path params distinctly:
GET /products/{product_id}    ← path param — UI shows "fill in product_id"
                                 curl: auto-replaced as part of the URL

# Not true for query params — they're optional modifiers, not required identifiers
GET /products?id={product_id}  ← query param — looks optional, not part of identity

SDK generation (from OpenAPI spec):
  Path param: generated as required argument  → client.getProduct(productId)
  Query param: generated as optional         → client.getProduct({productId: ...})  ← wrong semantics
```

---

## SECTION 3 — Core Technical Deep Dive

### Decision Framework: Path vs Query Parameter

```
Use PATH parameter when:
  ✅ The value is required (request is meaningless without it)
  ✅ The value identifies a specific resource or a specific named collection
  ✅ The value is fixed and stable (changes would mean a different resource)
  ✅ The endpoint should be bookmarkable/shareable as-is
  ✅ Different values represent different resources (not different views of same resource)

Use QUERY parameter when:
  ✅ The value is optional (endpoint works without it — just less filtered)
  ✅ The value filters, sorts, paginates, or shapes the response
  ✅ The value can vary without changing which resource is addressed
  ✅ Multiple values of the parameter can coexist
  ✅ The value represents input to computation (format, language, currency)
  ✅ The value is for analytics/tracking (UTM params, etc.)
```

### Full Decision Table

| Parameter Role          | Type  | Example                                 | Why                                                         |
| ----------------------- | ----- | --------------------------------------- | ----------------------------------------------------------- |
| Resource ID             | Path  | `/users/{user_id}`                      | Identifies the resource — request is meaningless without it |
| Nested collection owner | Path  | `/users/{user_id}/orders`               | Parent ID is part of the resource path, not an option       |
| Action target           | Path  | `/orders/{order_id}/cancel`             | The specific resource being acted on                        |
| API version             | Path  | `/v1/products`                          | Version identifies which API contract applies               |
| Collection filter       | Query | `/products?category=electronics`        | Optional — all products exist even without filter           |
| Pagination              | Query | `/products?page=2&limit=20`             | Optional — endpoint works on page 1 by default              |
| Sort order              | Query | `/products?sort=price&order=asc`        | Optional modifier, doesn't change which products            |
| Search/text filter      | Query | `/products?q=headphones`                | Optional — filter narrows the collection                    |
| Response fields         | Query | `/users?fields=id,name`                 | Optional — shapes the response, doesn't change resource     |
| Language/locale         | Query | `/products/{id}?lang=es`                | Optional — same resource, different representation language |
| Format                  | Query | `/reports/{id}?format=pdf`              | Optional — same data, different format                      |
| Date range filter       | Query | `/orders?from=2026-01-01&to=2026-01-31` | Optional filter on the collection                           |

### The "Required vs Optional" Test

The most reliable mental test:

```
If you remove this parameter, does the request still make sense?

GET /users/ ← (path param removed)
  → "Get...which user?" → request makes no sense without path param
  → VERDICT: belongs in PATH

GET /users/123 (no query params) → "Get user 123" → perfectly valid request
  → category, sort, fields are all optional
  → VERDICT: filters/modifiers belong in QUERY STRING

POST /orders (no body) ← would create what?
  → POST body contains the resource's data → belongs in body
  → VERDICT: resource data belongs in REQUEST BODY
```

### Multi-Value Query Parameters

```
# Multiple values for same parameter:

Option 1: Repeated key
GET /products?tag=wireless&tag=premium&tag=noise-cancelling
→ tags = ["wireless", "premium", "noise-cancelling"]

Option 2: Comma-separated
GET /products?tags=wireless,premium,noise-cancelling
→ server splits on comma

Option 3: Bracket notation (PHP-style)
GET /products?tags[]=wireless&tags[]=premium
→ less common in REST APIs

# RECOMMENDATION: Repeated key (Option 1)
  - Standard across HTTP frameworks (Java, Node, Python all parse this natively)
  - No ambiguity with values that might contain commas
  - Most consistent with HTTP spec mechanics

# Boolean flags:
GET /products?inStock=true         ← standard
GET /products?onSale=1             ← acceptable alternative
GET /products?featured             ← presence-only (no value) ← avoid (ambiguous)
```

### Special Cases and Edge Cases

```
# Case 1: ID can also be a query param for search/lookup
GET /users?email=john@company.com         ← query param OK (email is a filter, not path segment)
GET /users/john@company.com               ← NOT recommended (@ requires encoding in path)
→ Email is a filter criteria, not the primary resource ID
   Even though it uniquely identifies a user, it contains special chars better suited to query

# Case 2: Embedded filters in path (bad)
GET /products/electronics/under-50         ← NOT recommended
→ "electronics" and "under-50" are filter values, not distinct resource names
→ Would require new route for every combination
→ Correct: GET /products?category=electronics&maxPrice=50

# Case 3: Date-based resources (blog posts, reports)
GET /reports/2026/02/23                   ← acceptable (date = part of report identity)
GET /reports/2026-02-23                   ← better (single path segment)
GET /reports?date=2026-02-23              ← query param also acceptable for date-scoped

Rule of thumb: if the date IS the resource (the report FOR that date has unique content),
               use path. If date is a filter on a collection of reports, use query.

# Case 4: Version in path vs version in query string
GET /v2/users/123                         ← CORRECT (path prefix)
GET /users/123?version=2                  ← WRONG (version is not a modifier, it's a contract)
GET /users/123?api-version=2026-02-01    ← Azure's approach (acceptable, debated)

# Case 5: Language/locale
GET /products/123?lang=es                 ← CORRECT (same product, different language representation)
GET /es/products/123                      ← also acceptable for content-heavy sites (SEO benefit)
GET /products/es/123                      ← WRONG (implies different collection/resource)
```

### URL Encoding Implications

```
Path parameters are percent-encoded per RFC 3986.
Some characters are reserved in paths and MUST be encoded:
  / → %2F   (slash: would be misinterpreted as path separator)
  ? → %3F   (question mark: would start query string)
  # → %23   (hash: would start fragment)
  @ → %40   (at sign: usually OK in path but can confuse parsers)
  space → %20 or +

Query parameters also encoded, but + is commonly accepted for space in query strings.

PRACTICAL IMPLICATIONS:
  Email as path param: john@company.com → john%40company.com
  → URL becomes: /users/john%40company.com (ugly, error-prone in logs)
  → Better as query param: /users?email=john@company.com (cleaner, client encodes automatically)

  UUID as path param: f47ac10b-58cc-4372-a567-0e02b2c3d479
  → Hyphens are safe in paths (no encoding needed) ← one reason UUIDs work well

Safe path param characters (no encoding needed): a-z, A-Z, 0-9, -, _, ., ~
Everything else should be validated/encoded carefully.
```

---

## SECTION 4 — Real-World API Contract: Reporting Platform

### Scenario

You're building the REST API for DataPulse, an analytics/reporting platform. The API must support: report management, data export, dashboard widgets, shared links, and filtered data views.

### Full API Design with Parameter Placement Reasoning

```
# Report management
GET    /reports                               ← list caller's reports
GET    /reports?type=sales&period=monthly     ← filter reports by type and period
POST   /reports                               ← create report (params in body)
GET    /reports/{report_id}                   ← get specific report (id = path)
PATCH  /reports/{report_id}                   ← update report (id = path)
DELETE /reports/{report_id}                   ← delete (id = path)
POST   /reports/{report_id}/run               ← trigger report execution (action)
GET    /reports/{report_id}/runs              ← execution history
GET    /reports/{report_id}/runs/{run_id}     ← specific run result

# Data export (same report, different format)
GET /reports/{report_id}/export?format=csv
GET /reports/{report_id}/export?format=xlsx
GET /reports/{report_id}/export?format=pdf

# Why format is a query param (not path):
#   /reports/{id}/export/csv   ← format as path = implies format is a sub-resource (wrong)
#   /reports/{id}/csv          ← format in path = implies different resource (wrong)
#   /reports/{id}/export?format=csv ← format is a representation option (query param = correct)

# Dashboard and widgets
GET    /dashboards/{dashboard_id}
GET    /dashboards/{dashboard_id}/widgets
GET    /dashboards/{dashboard_id}/widgets/{widget_id}
GET    /dashboards/{dashboard_id}/widgets/{widget_id}/data
         ?from=2026-01-01&to=2026-01-31   ← date range filter (query)
         &granularity=day                 ← aggregation granularity (query)
         &metric=revenue                  ← which metric (query)

# Shared report links (public access via token)
POST   /reports/{report_id}/share          ← generate share link
GET    /shared/{share_token}               ← public access via token (token is identity = path)
# Note: share_token is NOT a query param: /reports?token=xyz
# Because: the token IS the resource identity for the public URL
# The entire shared report is identified by the token — it's a path, not a modifier

# Data querying
GET /datasets/{dataset_id}/query
    ?select=revenue,date,region      ← column projection
    &from=2026-01-01                 ← date filter
    &to=2026-01-31                   ← date filter
    &group_by=region                 ← grouping
    &order_by=revenue                ← sort
    &order=desc                      ← sort direction
    &limit=100                       ← result limit
    &offset=0                        ← pagination offset
```

### Request/Response Examples

```http
# Get filtered, paginated, sorted list of reports
GET /v1/reports?type=sales&period=monthly&sort=created_at&order=desc&limit=10&page=1
Authorization: Bearer eyJhbGci...
Accept: application/json

HTTP/1.1 200 OK
Content-Type: application/json
X-Total-Count: 47
Link: </v1/reports?page=2&limit=10&type=sales&period=monthly>; rel="next",
      </v1/reports?page=5&limit=10&type=sales&period=monthly>; rel="last"

{
  "data": [
    {
      "report_id": "RPT-f47ac10b",
      "name": "Q1 2026 Sales Summary",
      "type": "sales",
      "period": "monthly",
      "created_at": "2026-02-23T09:00:00Z",
      "last_run": "2026-02-23T08:00:00Z",
      "_links": {
        "self": "/v1/reports/RPT-f47ac10b",
        "run": "/v1/reports/RPT-f47ac10b/run",
        "export": "/v1/reports/RPT-f47ac10b/export?format=csv"
      }
    }
  ],
  "meta": {
    "page": 1,
    "limit": 10,
    "total": 47
  }
}
```

```http
# Export report as PDF
GET /v1/reports/RPT-f47ac10b/export?format=pdf&timezone=America/New_York
Authorization: Bearer eyJhbGci...
Accept: application/pdf

HTTP/1.1 200 OK
Content-Type: application/pdf
Content-Disposition: attachment; filename="Q1-2026-Sales-Summary.pdf"
Content-Length: 245890

[binary PDF data]

# Parameter placement reasoning:
# report_id = PATH  (identifies which report)
# format = QUERY    (representation option: same report, different format)
# timezone = QUERY  (affects date rendering in the report — presentation option)
```

```http
# Widget data with time range
GET /v1/dashboards/DB-abc123/widgets/WGT-789/data?from=2026-01-01&to=2026-01-31&granularity=week
Authorization: Bearer eyJhbGci...

HTTP/1.1 200 OK
Content-Type: application/json

{
  "widget_id": "WGT-789",
  "metric": "revenue",
  "granularity": "week",
  "from": "2026-01-01",
  "to": "2026-01-31",
  "data_points": [
    { "week": "2026-W01", "value": 145230.00 },
    { "week": "2026-W02", "value": 162840.00 },
    { "week": "2026-W03", "value": 178920.00 },
    { "week": "2026-W04", "value": 193150.00 }
  ],
  "total": 680140.00,
  "currency": "USD"
}
```

### Complete Parameter Reasoning Documentation

```
When documenting API parameters, ALWAYS include reasoning in OpenAPI spec:

/reports/{report_id}/export:
  parameters:
    - name: report_id
      in: path              ← explicitly "path"
      required: true
      description: "Unique identifier of the report. Required — identifies which report to export."
      schema:
        type: string
        pattern: "^RPT-[a-f0-9]+"

    - name: format
      in: query             ← explicitly "query"
      required: false
      description: "Export format. Defaults to CSV. Same report data, different representation."
      schema:
        type: string
        enum: [csv, xlsx, pdf, json]
        default: csv

    - name: timezone
      in: query
      required: false
      description: "IANA timezone for date rendering. Affects presentation only, not data."
      schema:
        type: string
        example: "America/New_York"
        default: "UTC"
```
