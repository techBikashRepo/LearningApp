# Path vs Query Parameters — Part 2 of 3

### Sections: 5 (Architecture Diagram), 6 (Production Scenarios), 7 (Scaling & Reliability), 8 (AWS Mapping)

**Series:** Backend & API Design → REST APIs → System Design

---

## SECTION 5 — Architecture Diagram: How Parameters Flow Through the Stack

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                      REQUEST FLOW: PATH vs QUERY PARAMETERS                      │
│                                                                                   │
│                                                                                   │
│  CLIENT REQUEST:                                                                  │
│  GET /v1/products/PRD-abc123?lang=es&fields=id,name,price                        │
│       ─────────────────────  ──────────────────────────────                      │
│       path with path param   query string                                         │
│                                                                                   │
│  ┌────────────────────────────────────────────────────────────────────────────┐  │
│  │                         CLOUDFRONT CDN                                     │  │
│  │  Cache Key Policy:                                                         │  │
│  │  Path: /v1/products/PRD-abc123    ← ALWAYS part of cache key               │  │
│  │  Query: lang=es                   ← INCLUDED (affects response content)    │  │
│  │         fields=id,name,price      ← EXCLUDED (only selects fields, same    │  │
│  │                                     underlying data — optional exclusion)   │  │
│  │                                                                             │  │
│  │  Effective cache key: "GET /v1/products/PRD-abc123?lang=es"                │  │
│  │  UTM params (utm_source, utm_campaign): ALWAYS EXCLUDED from cache key     │  │
│  └────────────────────┬───────────────────────────────────────────────────────┘  │
│                       │ Cache MISS → forward to origin                            │
│                       ▼                                                           │
│  ┌────────────────────────────────────────────────────────────────────────────┐  │
│  │                         API GATEWAY                                        │  │
│  │                                                                             │  │
│  │  Route matching:                                                            │  │
│  │  GET /v1/products/{product_id}    ← path param extracted                   │  │
│  │                                                                             │  │
│  │  event.pathParameters:                                                     │  │
│  │    { "product_id": "PRD-abc123" }  ← from URL path                         │  │
│  │                                                                             │  │
│  │  event.queryStringParameters:                                              │  │
│  │    { "lang": "es", "fields": "id,name,price" }  ← from query string       │  │
│  │                                                                             │  │
│  │  Lambda Authorizer:                                                         │  │
│  │    pathParameters.product_id → check user has access to this product       │  │
│  │    (authorization gate uses PATH param — reliable, always present)         │  │
│  └────────────────────┬───────────────────────────────────────────────────────┘  │
│                       │                                                           │
│                       ▼                                                           │
│  ┌────────────────────────────────────────────────────────────────────────────┐  │
│  │                      LAMBDA / APPLICATION LAYER                            │  │
│  │                                                                             │  │
│  │  async function getProduct(event) {                                        │  │
│  │    // Path parameter — REQUIRED (validated by route, always present)       │  │
│  │    const productId = event.pathParameters.product_id;                      │  │
│  │                                                                             │  │
│  │    // Query parameters — OPTIONAL (must handle absence)                    │  │
│  │    const lang = event.queryStringParameters?.lang ?? 'en';                 │  │
│  │    const fields = event.queryStringParameters?.fields?.split(',') ?? null; │  │
│  │                                                                             │  │
│  │    // Build cache key including ONLY content-affecting params              │  │
│  │    const cacheKey = `product:${productId}:${lang}`;                        │  │
│  │    const cached = await redis.get(cacheKey);                               │  │
│  │    if (cached) {                                                            │  │
│  │      let response = JSON.parse(cached);                                    │  │
│  │      if (fields) response = pick(response, fields);  // fields never cached│  │
│  │      return response;                                                       │  │
│  │    }                                                                        │  │
│  │                                                                             │  │
│  │    // DB query                                                              │  │
│  │    const product = await db.query(                                         │  │
│  │      'SELECT * FROM products WHERE id = $1',                               │  │
│  │      [productId]                                                            │  │
│  │    );                                                                       │  │
│  │    if (!product) throw new NotFoundError();                                 │  │
│  │                                                                             │  │
│  │    const translated = await translate(product, lang);   // if lang != 'en' │  │
│  │    await redis.set(cacheKey, JSON.stringify(translated), 'EX', 300);       │  │
│  │                                                                             │  │
│  │    // Apply field projection (after caching full document)                 │  │
│  │    return fields ? pick(translated, fields) : translated;                  │  │
│  │  }                                                                          │  │
│  └────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                   │
│  KEY INSIGHT: Path param → identity → required → cache key root                  │
│               Query param → option   → optional → may extend cache key           │
│                                                 → may be excluded from cache key  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### Parameter Handling by Infrastructure Layer

```
LAYER         │ PATH PARAMETER                    │ QUERY PARAMETER
──────────────┼───────────────────────────────────┼──────────────────────────────
CloudFront    │ Always in cache key               │ Configurable: include/exclude/normalize
API Gateway   │ Route matching (required)         │ Passed to backend (optional)
ALB           │ Route target selection            │ Forwarded, not used for routing
Lambda Authorizer│ Available: pathParameters      │ Available: queryStringParameters
Application   │ Always present (validated)        │ Must handle null/undefined
Redis cache   │ Part of cache key root            │ Only content-affecting params
Access logs   │ Visible in path directly          │ In query string portion of URL
WAF rules     │ Easy path-based blocking/allow    │ Query injection attack surface
```

---

## SECTION 6 — Production Scenarios

### Scenario 1: GitHub's Parameter Design Patterns

```
GitHub REST API v3 — textbook path vs query parameter usage:

PATH PARAMETERS (resource identity):
  /repos/{owner}/{repo}            ← owner + repo identify the repository
  /repos/{owner}/{repo}/commits/{sha}  ← sha identifies the commit
  /repos/{owner}/{repo}/pulls/{pull_number}  ← pull_number within repo
  /users/{username}                ← username identifies the user

QUERY PARAMETERS (filters, pagination, options):
  /repos/{owner}/{repo}/commits
    ?sha=main                      ← filter by branch/sha (optional)
    &path=src/main.py              ← filter by file path (optional)
    &since=2026-01-01T00:00:00Z    ← since timestamp (optional)
    &until=2026-02-01T00:00:00Z    ← until timestamp (optional)
    &per_page=30                   ← pagination (optional)
    &page=2                        ← page number (optional)

  /search/repositories
    ?q=node+stars:>1000            ← search query (required for search, but search is the resource)
    &sort=stars                    ← sort by (optional)
    &order=desc                    ← order direction (optional)
    &per_page=10                   ← pagination (optional)

INTERESTING DESIGN DECISION — /search endpoints:
  GitHub uses: GET /search/repositories?q=node+language:javascript

  Why is `q` a query param even though it seems "required"?
  Because /search/repositories is the search RESOURCE (endpoint exists)
  `q` is the query modifier on that resource.
  Calling /search/repositories without q → 422 Unprocessable (server validates it's present)
  But conceptually it's optional (you COULD get all repos if you had permission)

  Pattern: required validation ≠ should-be-path-param
  If the parameter is "conceptually a filter/modifier", use query — even if the server requires it.
```

### Scenario 2: Stripe's Path Parameter Strict Practice

```
Stripe enforces strict path parameter discipline throughout their API.

Every resource has an opaque prefixed ID in the path:
  /v1/customers/cus_K6W5JLLtkzPJ9E84
  /v1/payment_intents/pi_3MqRGmKqDPRHc
  /v1/invoices/in_1LkpBe2eZvKYlo2CiuU

They NEVER use IDs as query params for resource access.
Even sub-resource filtering uses path params where appropriate:
  /v1/customers/cus_K6W5/subscriptions    ← customer as path (not ?customer=cus_K6W5)
  /v1/customers/cus_K6W5/payment_methods  ← nested collection

But: listing/filtering uses query params:
  GET /v1/charges
    ?customer=cus_K6W5JLLtkzPJ9E84   ← filter all charges by customer (query)
    &limit=10                          ← pagination
    &starting_after=ch_abc            ← cursor for cursor-based pagination
    &created[gte]=1600000000          ← timestamp range filter

Two ways to get charges for a customer:
  Option A: /v1/customers/{id}/charges   ← nested collection (hierarchical)
  Option B: /v1/charges?customer={id}   ← filtered collection (flat + query)

Stripe provides BOTH, with Option B more commonly used because:
  - Easier to implement cross-cutting filters: ?customer=x&status=succeeded&created_gte=...
  - Doesn't require knowing the customer ID to start browsing (admin use case)
  - Consistent with their pagination cursor pattern (starting_after cursor on the top-level resource)
```

### Scenario 3: The Instagram/Meta Query Param Complexity Problem

```
Meta's Graph API demonstrates what happens when query params become too complex:

Standard approach for field selection:
  GET /v12.0/{user-id}?fields=name,email,picture

But their "edge" fields become deeply nested:
  GET /v12.0/{user-id}?fields=posts{message,story,likes{summary},comments{message,from{name}}}

Problems this created:
  1. URL length limit (browsers: 2048 chars, servers typically 8192 chars)
     Complex nested field queries → URL too long → 414 URI Too Long

  2. CDN can't cache effectively (massive unique query strings per user's field selection)

  3. Query param parsing is non-standard (custom { } syntax within query params)

  4. Debugging: pasting URL doesn't reproduce exact request (URL encoding of { } is complex)

Meta's eventual fix:
  Accept field selection in POST body for complex queries:
  POST /graphql
  Body: { "query": "{ user(id: 123) { posts { message likes { count } } } }" }

  This evolved into GraphQL — born from the limits of complex query params in REST.

LESSON: When query params become deeply nested/complex, it's a signal you need
  either a dedicated query language (GraphQL) or explicit filter resources.
  REST query params work best for simple key=value filters, not nested structures.
```

---

## SECTION 7 — Scaling & Reliability Implications

### 1. Cache Efficiency: Query Param Normalization

```
PROBLEM: Same logical request, different query param order = different cache keys

GET /products?sort=price&category=electronics&page=1     ← cache entry A
GET /products?category=electronics&sort=price&page=1     ← cache entry B (SAME data!)
GET /products?page=1&sort=price&category=electronics     ← cache entry C (SAME data!)

All three URLs return identical responses.
All three create separate cache entries.
CDN cache hit rate tanks because clients generate params in different orders.

FIX 1: CloudFront cache key normalization
  Cache Key Policy → Query Strings → "Include specified query strings"
  → Sort query strings alphabetically in cache key
  CloudFront normalizes: category=electronics&page=1&sort=price (alphabetical)
  All three requests → same cache key → 3× more cache hits

FIX 2: Middleware normalization at API Gateway (Lambda Authorizer or middleware)
  function normalizeQueryParams(url) {
    const [path, query] = url.split('?');
    if (!query) return url;
    const sorted = query.split('&').sort().join('&');
    return `${path}?${sorted}`;
  }
  // Cache key always uses normalized URL

FIX 3: Canonical URL generation in SDK
  SDK sorts params before sending:
    client.getProducts({sort: 'price', category: 'electronics'})
    → always sends: ?category=electronics&sort=price (sorted)
    → consistent cache keys

TRACKING PARAMS MUST BE EXCLUDED FROM CACHE KEY:
  ?utm_source=email&utm_campaign=promo2026&utm_medium=cta

  These change per marketing campaign but return the SAME product data.
  Include in CloudFront cache key → 100% cache misses for marketing traffic
  Exclude from CloudFront cache key → still forwarded to origin if needed,
                                       but don't affect caching

  CloudFront allow list: only include params that affect response content:
    Include: category, sort, page, limit, lang, q (search)
    Exclude: utm_*, session_id, fbclid, gclid, _ga (tracking)
```

### 2. Security: Query Param Vulnerabilities

```
QUERY PARAMETER INJECTION:
Path parameters are part of the route — they're validated by route matching.
Query parameters are freeform — they must be validated by application logic.

VULNERABILITY: Mass assignment via query params
  Bad pattern:
    GET /users/123?role=admin    ← passing role as a query param
    Server code:
      const user = await db.getUser(userId);
      const overrides = req.query;     // ALL query params applied as updates
      const merged = { ...user, ...overrides };  // DANGEROUS
      // role=admin now overrides the database value

  Attacker: GET /users/123?role=admin&is_superuser=true
  Result: Attacker elevates own privileges

VULNERABILITY: Parameter pollution
  Server expects: ?order=asc
  Attacker sends: ?order=asc&order=sqlinjection
  Node.js: req.query.order = ['asc', 'sqlinjection'] (array, not string)
  Server code: ORDER BY ${req.query.order}  → SQL injection if not parameterized

BEST PRACTICES:
  1. Whitelist valid query params (reject unknown params with 400 Bad Request)
  2. Validate types strictly (order must be 'asc' or 'desc', not arbitrary string)
  3. Never use query params directly in SQL — always use parameterized queries
  4. Log all unknown query params → security alerting for probing attempts
  5. Use query param schema validation (OpenAPI spec + request validation in API GW)

API GATEWAY REQUEST VALIDATION:
  Enable parameter validation in API GW:
    - Required query params: 400 if missing
    - Invalid query param values: 400 before reaching Lambda
    - Unknown query params: configurable (warn or reject)
```

### 3. Logging and Observability

```
PATH PARAM in logs:
  Access log: GET /products/PRD-abc123 200 45ms
  → Immediately queryable: "All requests for product PRD-abc123"
  → CloudWatch Insights: filter @requestId where url like '/products/PRD-abc123'
  → Can set alarms: if /products/PRD-abc123 returns 5xx > threshold → alert

QUERY PARAM privacy concern:
  GET /users/search?email=john%40company.com  ← email in query param
  Access log contains email in plaintext: "email=john@company.com"
  → PII in access logs → compliance risk (GDPR, HIPAA)
  → Access logs might be stored in S3 without encryption

  Mitigation options:
    1. POST body for sensitive search criteria (body not logged by default in API GW)
    2. Tokenized search: POST /search-tokens {email: "..."} → returns token
                         GET /results/{search_token} ← token in path, email never in log
    3. CloudWatch log filtering: exclude specific query params from logs
    4. Hashing PII in custom access log format

QUERY PARAM LOGGING IN DISTRIBUTED TRACING:
  X-Ray / OpenTelemetry: spans include URL
  Ensure PII query params are sanitized from trace spans
  Solution: custom span processor that strips sensitive params before export
```

---

## SECTION 8 — AWS Mapping

### API Gateway: Path and Query Parameter Handling

```
API GATEWAY REST API — Route Configuration:

Resource path: /products/{product_id}
Method: GET

In API GW console / CloudFormation:
  PathParameters:
    - Name: product_id
      In: path
      Required: true
      Schema: { type: string, pattern: "^PRD-[a-z0-9]+" }

  QueryStringParameters:
    - Name: lang
      In: query
      Required: false
      Schema: { type: string, enum: [en, es, fr, de] }
    - Name: fields
      In: query
      Required: false
      Schema: { type: string }

Enable Request Validation:
  ValidateRequestParameters: true ← validate path + query params against schema
  → Returns 400 Bad Request automatically for invalid values
  → Lambda never called with invalid input

Mapping Template (pass parameters to Lambda):
  {
    "pathParameters": {
      "product_id": "$input.params('product_id')"
    },
    "queryStringParameters": {
      "lang": "$input.params('lang')",
      "fields": "$input.params('fields')"
    }
  }

Lambda Proxy Integration (simpler — passes full event):
  event.pathParameters.product_id = "PRD-abc123"
  event.queryStringParameters = { lang: "es", fields: "id,name" }
  event.multiValueQueryStringParameters = { fields: ["id", "name"] }  ← multi-value
```

### CloudFront: Cache Key Policies for Query Parameters

```
CloudFront Cache Key Policy: "ProductsCachePolicy"

  QueryStringsConfig:
    QueryStringBehavior: whitelist
    QueryStrings:
      Items:
        - lang          ← include (affects response content — translation)
        - category      ← include (affects which products returned)
        - sort          ← include (affects order of products)
        - page          ← include (affects which page of results)
        - limit         ← include (affects how many results)
        - q             ← include (search query — affects results)
        - fields        ← EXCLUDE (only shapes response format, doesn't change data)
        - utm_source    ← EXCLUDE (tracking only)
        - utm_campaign  ← EXCLUDE (tracking only)
        - session_id    ← EXCLUDE (session, not content-affecting)

  This policy:
    - Cache key: /products?category=electronics&lang=en&page=1&sort=price
    - Ignores: &utm_source=email&fields=id,name
    - All requests with same content-affecting params share one cache entry
    - UTM-tagged marketing requests don't create separate cache entries

OriginRequestPolicy: "ForwardAllQueryStrings"
  Even excluded params are STILL forwarded to origin (for analytics logging)
  Excluding from CACHE KEY ≠ dropping the param for the origin
  The param reaches Lambda; Lambda can use it for field projection or analytics
  But CDN cache doesn't split on it → high cache hit ratio maintained
```

### Lambda: Query Parameter Handling Best Practices

```javascript
// Lambda handler with correct path/query parameter pattern
exports.handler = async (event) => {
  // PATH PARAMETERS — required, validated by API GW route
  const { product_id } = event.pathParameters;

  // QUERY PARAMETERS — optional, must have defaults
  const queryParams = event.queryStringParameters || {};
  const lang = queryParams.lang || "en";

  // Multi-value query params (e.g., ?tag=wireless&tag=premium)
  const multiParams = event.multiValueQueryStringParameters || {};
  const tags = multiParams.tags || [];

  // Field projection from comma-separated string
  const fieldsParam = queryParams.fields;
  const requestedFields = fieldsParam
    ? fieldsParam.split(",").map((f) => f.trim())
    : null;

  // Pagination with defaults and validation
  const page = Math.max(1, parseInt(queryParams.page || "1", 10));
  const limit = Math.min(
    100,
    Math.max(1, parseInt(queryParams.limit || "20", 10)),
  );

  // Sort validation — whitelist allowed sort fields
  const ALLOWED_SORT_FIELDS = ["price", "name", "created_at", "rating"];
  const sortField = ALLOWED_SORT_FIELDS.includes(queryParams.sort)
    ? queryParams.sort
    : "created_at";
  const sortOrder = ["asc", "desc"].includes(queryParams.order)
    ? queryParams.order
    : "desc";

  // Build Redis cache key — only content-affecting params
  const cacheKey = `product:${product_id}:${lang}`;

  // ... rest of handler
};
```

### WAF: Path and Query Parameter Security Rules

```
AWS WAF rules targeting query parameters:

Rule: Block SQLi in Query Strings
  Statement:
    SqliMatchStatement:
      FieldToMatch:
        QueryString: {}
      TextTransformations:
        - Priority: 0, Type: URL_DECODE
        - Priority: 1, Type: LOWERCASE
  Action: Block

Rule: Block XSS in Query Strings
  Statement:
    XssMatchStatement:
      FieldToMatch:
        QueryString: {}
  Action: Block

Rule: Block oversized query strings
  Statement:
    SizeConstraintStatement:
      FieldToMatch:
        QueryString: {}
      ComparisonOperator: GT
      Size: 2048    ← block if query string > 2KB
  Action: Block

Rule: Rate limit by path (not query)
  Statement:
    RateBasedStatement:
      # Rate limit based on IP + path identifier (not query string)
      # /v1/products/** → 1000/5min per IP
      AggregateKeyType: FORWARDED_IP
      Limit: 1000
      ScopeDownStatement:
        ByteMatchStatement:
          FieldToMatch:
            UriPath: {}
          SearchString: /v1/products
  Action: Block

Why WAF rules target path and query differently:
  Path: route integrity (block attempts to access admin paths, traversal attacks)
  Query: injection attacks (SQL, XSS, parameter pollution)
```
