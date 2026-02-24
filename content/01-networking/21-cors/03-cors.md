# CORS — Part 3 of 3

### Topic: CORS — AWS SAA Certification, Revision & Architecture

**Series:** Networking Fundamentals → System Design → AWS Solutions Architect
**Sections Covered:** 9, 10, 11, 12

---

## SECTION 9 — AWS SAA Certification Focus

### What the Exam Tests

AWS SAA tests CORS primarily through S3, API Gateway, and CloudFront. Questions typically describe a broken web application and ask why it fails or how to fix it. The patterns are highly predictable.

### Trap 1: S3 Static Website + Cross-Origin JavaScript

```
Exam scenario:
  "A static website is hosted on S3 bucket 'www.shop.com'. The website's
   JavaScript loads product data from S3 bucket 'data.shop.com'. Users
   report the product list fails to load with an error in browser console.
   What is the cause and fix?"

Analysis:
  www.shop.com (JS origin) ≠ data.shop.com.s3.amazonaws.com (API origin)
  → Cross-origin fetch → CORS validation → S3 returns no CORS headers → blocked

Answer: Add a CORS policy to the 'data.shop.com' S3 bucket:
  [
    {
      "AllowedMethods": ["GET", "HEAD"],
      "AllowedOrigins": ["https://www.shop.com"],
      "AllowedHeaders": ["*"],
      "MaxAgeSeconds": 3000
    }
  ]

Wrong answers:
  "Make the bucket public" → unrelated; CORS is separate from bucket access
  "Add bucket policy allowing s3:GetObject" → unrelated; CORS is browser-access, not IAM
  "Enable CloudFront" → doesn't disable CORS requirement; CF itself has CORS config too

Key: S3 CORS policy ≠ S3 bucket policy ≠ S3 ACL. They are three separate things.
  Bucket policy: IAM permission (who can access the S3 resource)
  CORS policy: Browser CORS behavior (which origins can read responses in browser JS)
```

### Trap 2: API Gateway CORS + Lambda Integration Error Response

```
Exam scenario:
  "A developer enabled CORS on an API Gateway REST API. The API works for
   successful calls, but reports a CORS error when the Lambda function returns
   an error. Why?"

Root cause: CORS headers are returned by the Lambda integration, not by API Gateway.
When Lambda returns a response: Lambda explicitly includes CORS headers → works.
When Lambda throws an error OR API Gateway returns a gateway-level error (401, 403, 429, 502):
  The response comes from API Gateway itself, not Lambda
  API Gateway's gateway-level error responses don't include CORS headers
  → Browser sees error response with no CORS header → "CORS error"
  → Developer thinks it's a CORS bug; actually it's an authentication/rate-limit error
  BUT they can't see the real error because CORS blocks the response

Fix:
  In API Gateway console → Gateway Responses → DEFAULT_4XX → Edit
  Add response header: Access-Control-Allow-Origin = 'https://shop.com'
  Also add for DEFAULT_5XX

  This ensures ALL error responses from API Gateway also include CORS headers
  → Browser accepts the error response → JS can read the 401/403 status code → proper error handling

Exam answer pattern:
  "Configure Gateway Responses to include CORS headers in ALL error responses"
```

### Trap 3: CloudFront Caching + CORS Headers

```
Exam scenario:
  "A web application retrieves API data through CloudFront. After adding CORS
   support to the backend API, some users still experience CORS errors. The
   CORS errors are intermittent and clear up after a CloudFront cache invalidation.
   What is the root cause?"

Root cause: CloudFront is caching responses WITHOUT the Origin header in the cache key.
  - First request to CloudFront (no Origin header): CloudFront fetches from origin, caches
    the response (which may have CORS headers or may not)
  - Second request with Origin: https://shop.com → CloudFront serves the cached response
    from cache key that doesn't include the Origin → cached response may have WRONG or
    NO CORS headers

Fix:
  Method 1: CloudFront Cache Policy includes Origin in cache key
    → Separate cache entries per Origin value → each returns correct CORS headers

  Method 2: Add Vary: Origin response header from the origin
    → CloudFront respects Vary header → varies cache per Origin value

  Method 3: Use CloudFront Response Headers Policy (Managed-CORS-Allow-All-Origins)
    → CloudFront adds CORS headers itself at edge, regardless of origin's response
    → All origins allowed (wildcard) — use only for public content

Exam answer:
  "Configure CloudFront to forward the Origin header to the API origin"
  OR "Include Origin in the CloudFront cache key using a custom cache policy"
```

### Trap 4: Preflight Cache and OPTIONS Method on API Gateway

```
Exam scenario:
  "A React application makes many API calls. Performance tests show there are
   twice as many network requests as expected. CORS preflights are identified
   as the cause. How can this be fixed?"

Analysis: Every cross-origin request with custom headers triggers an OPTIONS preflight.
  If max-age is 0 or not set: every request gets a preflight → doubles network calls

Fix options:
  1. Set Access-Control-Max-Age: 86400 (24 hours)
     → Browser caches preflight result for 24h
     → Only one OPTIONS call per (endpoint, method) per 24 hours

  2. Simple requests (avoid `Content-Type: application/json` → use form encoding)
     → Eliminates preflight entirely (not practical for modern JSON APIs)

  3. Enable HTTP/2 or HTTP/3
     → Multiplexed connections — preflight and main request can share same connection
     → Reduces latency even if preflight exists

  4. Use same origin (BFF pattern)
     → Backend For Frontend on same domain → no CORS → no preflight

API Gateway OPTIONS handling:
  REST API: Enable CORS → creates mock OPTIONS response → include max-age in config
  HTTP API v2: native CORS config includes maxAge field
```

### Trap 5: CORS vs Authentication (They're Independent)

```
Exam scenario (test your understanding of what CORS does/doesn't do):
  "A security team requires that the API only be accessible from applications
   hosted on company-owned domains. They implement CORS with an allowlist of
   company domains. Is this sufficient for API security?"

Answer: NO. CORS restriction alone is NOT sufficient for API security.
  CORS prevents BROWSER JavaScript from other origins from reading responses.
  CORS does not prevent:
    - Direct API calls using curl, Postman, server SDKs
    - Automated scripts, bots
    - API calls from server-side code (Lambda, EC2, on-premises)
    - Any non-browser HTTP client

  An attacker can bypass CORS completely by calling the API directly (not from a browser)

  Correct security approach:
    CORS: add as one layer for browser-context isolation
    PLUS: API keys, OAuth 2.0 tokens, IP whitelisting, WAF rules
    PLUS: Rate limiting, request validation
    PLUS: AWS API Gateway usage plans, resource policies

  Exam trap: Questions that present CORS as a security control → always add
  "CORS alone is insufficient; authentication and authorization are also required"
```

---

## SECTION 10 — 5 Comparison Tables

### Table 1: CORS Request Scenarios

| Scenario                                  | Preflight?   | Example                                                 | Fix if blocked                                               |
| ----------------------------------------- | ------------ | ------------------------------------------------------- | ------------------------------------------------------------ |
| Same origin fetch                         | No           | shop.com → shop.com                                     | N/A                                                          |
| Cross-origin GET (simple headers)         | No preflight | shop.com → cdn.shop.com, Accept header                  | Add Access-Control-Allow-Origin on cdn.shop.com              |
| Cross-origin POST with `application/json` | YES          | shop.com → api.shop.com, Content-Type: application/json | Allow Content-Type in CORS policy                            |
| Cross-origin DELETE                       | YES          | shop.com → api.shop.com, DELETE method                  | Add DELETE to Allow-Methods                                  |
| Cross-origin with Authorization header    | YES          | shop.com → api.shop.com, Authorization: Bearer          | Add Authorization to Allow-Headers                           |
| Cross-origin with cookies (credentials)   | YES          | shop.com → api.shop.com, withCredentials: true          | Allow-Origin must be exact (not \*), Allow-Credentials: true |
| Server-to-server (Lambda → api.shop.com)  | No           | Lambda calling 3rd party API                            | No CORS ever (no browser)                                    |
| Curl / Postman                            | No           | Developer testing                                       | No CORS ever                                                 |

### Table 2: CORS Headers Reference

| Header                             | Direction            | Purpose                                         | Important Notes                                 |
| ---------------------------------- | -------------------- | ----------------------------------------------- | ----------------------------------------------- |
| `Origin`                           | Request              | Browser sets automatically to requesting origin | Cannot be overridden by JS                      |
| `Access-Control-Allow-Origin`      | Response             | Which origin is permitted                       | `*` or exact origin; `*` disallows credentials  |
| `Access-Control-Allow-Methods`     | Response (preflight) | Allowed HTTP methods                            | Only in preflight response                      |
| `Access-Control-Allow-Headers`     | Response (preflight) | Allowed request headers                         | Must list all custom headers client sends       |
| `Access-Control-Expose-Headers`    | Response             | Response headers readable by JS                 | Only needed for custom headers JS needs to read |
| `Access-Control-Allow-Credentials` | Response             | Allow cookies/auth headers                      | Requires exact origin (not \*)                  |
| `Access-Control-Max-Age`           | Response (preflight) | Preflight cache duration (seconds)              | Browser may cap at 7200s; set 86400             |
| `Access-Control-Request-Method`    | Preflight request    | Method of the real request                      | Set by browser in OPTIONS preflight             |
| `Access-Control-Request-Headers`   | Preflight request    | Headers of the real request                     | Set by browser in OPTIONS preflight             |
| `Vary: Origin`                     | Response             | CDN caching instruction                         | ALWAYS include when using dynamic origin        |

### Table 3: AWS Service CORS Configurations

| Service                 | How CORS is Configured                               | Key Notes                                             |
| ----------------------- | ---------------------------------------------------- | ----------------------------------------------------- |
| **S3**                  | Bucket CORS configuration JSON                       | Separate from bucket policy; configure per bucket     |
| **API Gateway REST**    | Enable CORS per resource (auto-creates OPTIONS)      | Must also configure Gateway Responses for 4XX/5XX     |
| **API Gateway HTTP v2** | API-level CORS config (single config for all routes) | Simpler; cannot per-route; auto-handles OPTIONS       |
| **CloudFront**          | Response Headers Policy (managed or custom)          | Origin must be forwarded to backend; add Vary: Origin |
| **ALB**                 | Not natively supported                               | Handle in application code (Nginx, Express, etc.)     |
| **AppSync**             | Enable CORS in settings; configure allowed origins   | Managed; auto-handles preflight                       |
| **Amplify Hosting**     | Built-in CORS for API proxy; env-based config        | Handles CORS when hosting frontend + proxying to API  |

### Table 4: CORS vs SameSite Cookies vs CSRF Tokens

| Mechanism                      | What It Prevents                                                         | How                                                     | Enforced By |
| ------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------- | ----------- |
| **CORS**                       | Cross-origin JS reading responses                                        | Browser blocks response if no CORS headers              | Browser     |
| **SameSite=Strict**            | Cookies sent on cross-origin requests                                    | Browser doesn't attach cookie if Origin ≠ cookie domain | Browser     |
| **SameSite=Lax**               | Cookie sent on dangerous cross-site navigation (POST form from external) | Cookie not sent for cross-site sub-requests             | Browser     |
| **SameSite=None; Secure**      | Cookie IS sent cross-origin (for embedded apps, CORS APIs)               | Requires HTTPS (Secure flag mandatory)                  | Browser     |
| **CSRF Token**                 | Form submissions / state-changing requests from attacker pages           | Token in hidden field must match server session token   | Server      |
| **Origin Check (server-side)** | Any cross-origin request                                                 | Server reads Origin header, rejects if not in allowlist | Server      |
| **Double Submit Cookie**       | CSRF on single-domain apps                                               | Cookie value echoed as request header; server compares  | Server      |

### Table 5: Common CORS Bugs and Fixes

| Bug Symptom                                    | Root Cause                                      | Fix                                                              |
| ---------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------- |
| CORS error for successful requests only        | Middleware after route registration             | Move `app.use(cors())` before all routes                         |
| CORS error on 401/403/502 responses only       | Gateway responses lack CORS headers             | Configure API Gateway Gateway Responses                          |
| Intermittent CORS errors from CDN              | CDN not including Origin in cache key           | Add Vary: Origin; include Origin in CloudFront cache policy      |
| CORS works without credentials, fails with     | Using `*` with `credentials: include`           | Change to exact origin; add Allow-Credentials: true              |
| Preflight failing but real request should work | OPTIONS method not configured                   | Add OPTIONS handler / enable CORS (creates OPTIONS mock)         |
| Works on desktop, fails on mobile              | Mobile browser has stricter CORS implementation | Ensure exact match, not regex; test with mobile browser DevTools |
| CORS only fails for specific subpaths          | CORS middleware applied per-route, not globally | Apply cors() at application level, not route level               |
| S3 images render but canvas read fails         | img tag doesn't use CORS; canvas drawImage does | Add `crossOrigin="anonymous"` to img element + S3 CORS policy    |

---

## SECTION 11 — Quick Revision

### 10 Key Points to Memorize

1. **CORS = browser-enforced, not network-enforced.** curl and server-to-server calls are never blocked by CORS. Only browser JavaScript is affected.

2. **Same origin = protocol + hostname + port.** shop.com and api.shop.com are DIFFERENT origins. https:// vs http:// are different. :80 vs :8080 are different.

3. **Preflight triggered by: custom methods (PUT/DELETE/PATCH), custom headers (Authorization, X-anything), or non-simple Content-Type (application/json).** GET + Accept header = no preflight.

4. **`Access-Control-Allow-Origin: *` cannot be combined with `Allow-Credentials: true`.** Browser rejects it. If cookies/auth header needed: use exact origin.

5. **Request executes on server even if CORS blocks browser JS from reading it.** Broken CORS = silent side effects for state-changing operations.

6. **Always include `Vary: Origin` in responses.** Without it, CDN may cache a non-CORS response and serve it to CORS requests.

7. **API Gateway Gateway Responses must ALSO have CORS headers.** Without them: 401, 403, 429 appear as CORS errors in the browser, hiding the real error.

8. **S3 CORS policy ≠ S3 bucket policy.** Bucket policy = IAM access. CORS policy = browser cross-origin behavior. Both required for cross-origin fetch from S3.

9. **`Access-Control-Max-Age: 86400` caches preflight for 24 hours.** Reduces OPTIONS request overhead on repeat calls.

10. **CORS is not security.** It's same-origin browser context isolation. Always add authentication (API keys, JWT, OAuth) independently of CORS.

---

### 30-Second Explanation (for interview)

> "CORS is the mechanism that lets servers tell browsers which cross-origin JavaScript is allowed to read their responses. Browsers enforce Same-Origin Policy which blocks JavaScript from reading responses from different origins by default. To allow it, the server adds Access-Control-Allow-Origin headers. For requests with custom headers or non-GET/POST methods, the browser first sends a preflight OPTIONS request to check permission. The server must respond with the allowed origin, methods, and headers. CORS doesn't affect curl or server-to-server calls — only browser JavaScript. A common production mistake is forgetting Vary: Origin on CDN-cached responses, which causes intermittent CORS errors when cached non-CORS responses are served to cross-origin clients."

---

### Mnemonics

**CORS = "Coffee Or Regular Service?"**

```
Coffee = Preflight (OPTIONS check first)
Or Regular Service = Simple request (no preflight)
Decision: does the request have custom methods or custom headers? Yes → Coffee (preflight) first
```

**Preflight triggers: "PUMP"**

```
P — PUT / PATCH / DELETE methods (non-simple)
U — Unusual Content-Type (application/json, not form/text)
M — Methods beyond GET/HEAD/POST
P — Properties (headers) like Authorization, X-anything custom
```

**CORS Security Mantra: "CORS Isn't A Lock, It's A Label"**

```
CORS = shows browser which origins can read
Lock = authentication (JWT, API key, OAuth)
Always need both: the label (CORS) AND the lock (auth)
```

**Vary: Origin = "Very Original Caching"**

```
Vary: Origin tells CDN caches: cache separate versions "per origin"
Miss this: CDN serves wrong cached version to CORS requests
```

---

## SECTION 12 — Architect Thinking Exercise

_Design a solution before scrolling to the answer._

---

### The Scenario

You are building a SaaS product: `DashPlatform`. Clients embed your analytics widget on their own websites. The widget (JavaScript loaded from `https://widget.dashplatform.com`) makes API calls to `https://api.dashplatform.com`.

Your clients' websites have their own domains: client1.com, client2.io, bigcorp.com, startup.dev, etc. There are currently 500 client domains. You expect to grow to 10,000.

**Requirements:**

1. Each API call must be authenticated (clients use API keys issued at signup)
2. Only client-registered domains should be allowed to make browser CORS calls to your API
3. CORS configuration must update within 60 seconds when a client adds/changes their domain
4. The solution must not add more than 5ms to request latency
5. The system must handle 100,000 requests/second

**Design questions before scrolling:**

1. Where do you store the CORS allowlist? How do you keep it fast?
2. How do you validate the Origin header against the allowlist on every request?
3. What happens for fraudulent API keys used from unregistered domains?
4. How do you scale the CORS check to 100K RPS without it becoming a bottleneck?

---

---

---

### Solution: Edge-Aware Dynamic CORS Validation

#### Architecture Overview

```
                       Widget runs on:    client1.com
                       API call to:       api.dashplatform.com
                       Origin header:     https://client1.com
                                 ↓
                    ┌─── CloudFront Edge PoP ──────────────┐
                    │  Lambda@Edge: ValidateCORSOrigin     │
                    │  1. Extract: api_key FROM request     │
                    │  2. Lookup:  allowlist[api_key]       │
                    │             (local cache in Lambda)   │
                    │  3. Check:  Origin ∈ allowlist?       │
                    │  4. Yes → add CORS headers to req     │
                    │  5. No  → return 403                  │
                    └──────────────────┬───────────────────┘
                                       ↓
                              api.dashplatform.com
                              (ALB → ECS API servers)
```

#### Component 1: Allowlist Storage

```
Primary store: DynamoDB (single-digit ms reads)
  Table: cors_allowlists
  Key: api_key (String)
  Attribute: allowed_origins (StringSet): ["https://client1.com", "https://www.client1.com"]
  TTL: not needed (data persists until client changes domain)

  Update path:
    Client updates their domain in DashPlatform dashboard
    API writes to DynamoDB (< 10ms)
    DynamoDB Streams → Lambda → CloudFront cache invalidation
    Lambda@Edge caches the allowlist per api_key (1-minute TTL)

  Max latency for propagation:
    DynamoDB write: 5ms
    Stream to Lambda: 500ms
    Lambda@Edge cache TTL: 60s
    Total: max 61 seconds → meets the 60-second requirement (edge case: 59s on old cache)

  To guarantee <60s: set Lambda@Edge cache TTL to 45s (safe margin)
```

#### Component 2: Lambda@Edge CORS Validation

```
Lambda@Edge deployed at every CloudFront PoP (400+ locations):

exports.handler = async (event) => {
  const request = event.Records[0].cf.request;
  const headers = request.headers;

  // 1. Get origin and API key
  const origin = headers['origin']?.[0]?.value;
  const apiKey = headers['x-api-key']?.[0]?.value || getQueryParam(request.querystring, 'api_key');

  // 2. Handle preflight
  if (request.method === 'OPTIONS') {
    return buildPreflightResponse(origin, apiKey);
  }

  // 3. Check origin against allowlist
  const allowedOrigins = await getAllowedOrigins(apiKey);  // cached in Lambda memory

  if (!origin || !allowedOrigins.has(origin)) {
    return {
      status: '403',
      statusDescription: 'Forbidden',
      headers: {
        'content-type': [{ key: 'Content-Type', value: 'application/json' }]
      },
      body: JSON.stringify({ error: 'Origin not allowed' })
    };
  }

  // 4. Add CORS headers to request that CloudFront will pass through to response
  request.headers['x-cors-validated'] = [{ key: 'X-Cors-Validated', value: origin }];
  return request;  // allow request through
};

// Cache: Lambda execution environment persists between warm invocations
const originCache = new Map();  // api_key → { origins: Set, exp: Date }

async function getAllowedOrigins(apiKey) {
  const cached = originCache.get(apiKey);
  if (cached && cached.exp > Date.now()) return cached.origins;

  // Fetch from DynamoDB
  const response = await dynamo.getItem({
    TableName: 'cors_allowlists',
    Key: { api_key: { S: apiKey } }
  }).promise();

  const origins = new Set(response.Item?.allowed_origins?.SS || []);
  originCache.set(apiKey, { origins, exp: Date.now() + 45_000 });  // 45s cache
  return origins;
}
```

#### Component 3: CloudFront Response Headers Policy

```
After Lambda@Edge passes the request to origin:
  Origin (ALB/ECS) sets:
    Vary: Origin (required!)

  CloudFront Response Headers Policy adds:
    Access-Control-Allow-Origin: <from X-Cors-Validated header set by Lambda@Edge>
    Access-Control-Allow-Credentials: true
    Access-Control-Allow-Methods: GET, POST, DELETE, PATCH
    Access-Control-Allow-Headers: Content-Type, Authorization, X-API-Key
    Access-Control-Max-Age: 86400

  Note: Custom policy reads X-Cors-Validated header and uses it as the Allow-Origin value
  (Since Lambda@Edge already validated it, we know it's safe to reflect)
```

#### Performance Analysis

```
100,000 RPS across 400+ CloudFront PoPs:
  Per PoP average: 100,000 / 400 = 250 RPS per PoP
  Lambda@Edge per-invocation: ~1ms (warm, cache hit)
  DynamoDB call (cache miss): ~5ms (rare, every 45s per api_key)

  Added latency: 1ms (meets the 5ms requirement)

  Cost:
    Lambda@Edge: $0.60 / 1M requests + $0.00005001/GB-second
    100K RPS × 86400s = ~8.6 billion requests/day → ~$5,200/day
    Acceptable for a 10,000-client SaaS with proper pricing

  Alternative if cost is concern: validate at ALB, accept ~5ms added latency from VPC call
```

#### Security Properties

```
1. Fraud scenario: Attacker steals client1.io's API key, uses it from evil.com
   → evil.com Origin header not in client1's allowlist
   → Lambda@Edge returns 403
   → No data leakage to evil.com (CORS blocked + 403 response)

2. Is authentication still needed? YES.
   CORS only prevents browser origin misuse.
   Server-side calls (curl with API key from evil server):
     → No Origin header → Lambda@Edge treats as server-to-server → allows through
     → Regular API key auth (beyond CORS) handles authorization at the ECS API level

3. What about X-Cors-Validated forgery?
   Request comes from: client → CloudFront → Lambda@Edge → Origin
   Client can't inject headers through CloudFront (headers are controlled by Lambda@Edge)
   Origin (ECS) only trusts X-Cors-Validated from Lambda@Edge (internal header, not client-settable)
```

---

### What the Architect Learned

CORS at scale is not "add a header." It is an edges-and-cache problem:

1. **Allowlist updates** in the database need to propagate to 400 edge locations within your SLA — Lambda@Edge memory cache TTL is the controlling variable.
2. **CDN caching** makes CORS correctness non-trivial: Vary: Origin is mandatory, and cache invalidation on origin change is part of the correctness contract.
3. **CORS is one layer of a defense-in-depth security model.** The platform needs API key authentication, rate limiting, and WAF rules independently.

**Design principle:** "Validate at the closest point to the user, but derive trust from the central authority." Lambda@Edge is the enforcement point; DynamoDB is the authority. Separation allows the authority to change without re-deploying enforcement.

---

## Complete Topic Summary — CORS (All 3 Files)

| Section | Content                                                                                                                                                                                   |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1       | School supplies / bouncer / visitor badge analogies; Same-Origin Policy purpose                                                                                                           |
| 2       | Origin definition (protocol+host+port); simple vs preflight; preflight exchange; all CORS headers; credentials + exact origin; common misconfigurations                                   |
| 3       | ASCII: preflight flow with PASS/FAIL outcomes; Same-Origin Policy scope (what's blocked/not)                                                                                              |
| 4       | React → Node flow with withCredentials; CORS error debugging (request still executes!); S3 CORS + CloudFront Vary interaction                                                             |
| 5       | Restaurant/corporate-floors analogies; Stripe embedded checkout + dynamic CORS allowlist per merchant                                                                                     |
| 6       | CDN/CORS Vary conflict; API Gateway Gateway Responses trap; microservices CORS centralization; CORS ≠ security                                                                            |
| 7       | AWS: API Gateway (REST vs HTTP v2), Gateway Responses, CloudFront Response Headers Policy, ALB+Nginx, S3 presigned PUT CORS                                                               |
| 8       | 8 Q&As: Same-Origin Policy, request executes on CORS error, \* vs specific origin, Postman vs browser, half-users bug, Vary: Origin, multi-tenant design, Origin reflection vulnerability |
| 9       | AWS SAA traps: S3 CORS vs bucket policy, API Gateway Gateway Responses, CloudFront cache + CORS, Max-Age for preflight caching, CORS ≠ authentication                                     |
| 10      | 5 tables: CORS request scenarios, header reference, AWS service config, CORS vs SameSite vs CSRF, common bugs                                                                             |
| 11      | 10 key points; PUMP/CORS=label/Vary=Very Original mnemonics; 30-second explanation                                                                                                        |
| 12      | Architect exercise: 10,000-client SaaS widget platform — Lambda@Edge + DynamoDB + 45s TTL cache → dynamic CORS validation at edge, <1ms latency, <60s update propagation                  |
