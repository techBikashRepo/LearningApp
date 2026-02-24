# CORS — Part 2 of 3

### Topic: CORS in Production Systems and AWS

**Series:** Networking Fundamentals → System Design → AWS Solutions Architect
**Sections Covered:** 5, 6, 7, 8

---

## SECTION 5 — Real World Examples

### Analogy 1 — The Restaurant That Only Takes Reservations From Its Own App

A restaurant runs a website (restaurant.com) and a mobile app. They built a new dessert ordering feature. The JavaScript on restaurant.com calls the dessert API at desserts-api.restaurant.com. Without CORS configured, the browser blocks the JS from reading the API response — even though both are "restaurant.com" properties — because they are on different subdomains.

The chef (server) has to explicitly write a note on the kitchen window: "YES, I accept orders from restaurant.com AND from m.restaurant.com AND from admin.restaurant.com." Without that note, the maitre d' (browser) won't let those websites see the kitchen's responses.

Even after the note is up: a random customer opening evil.com in their browser — that website's JavaScript cannot trick the restaurant's kitchen into serving it by pretending to be restaurant.com, because the Origin header is set by the browser automatically and cannot be forged by JavaScript.

### Analogy 2 — Corporate Building Visitor System (Cross-Departmental Access)

Imagine a large headquarters with different departments on different floors:

- Floor 1: Public reception (https://shop.com)
- Floor 5: Customer data API (https://api.shop.com)
- Floor 9: Analytics dashboard (https://analytics.shop.com)

Each floor has a guard. The guards follow one rule: **people from a different floor must show a permission slip issued by that floor's manager.**

If a visitor from Floor 1 wants to access Floor 5's data, Floor 5's manager must have signed a permission slip: "Visitors from Floor 1 may access rooms GET-orders, POST-cart."

If the manager never signed any slip: Floor 5's guard turns away the Floor 1 visitor. The visitor (JavaScript) can't read anything from Floor 5, even if Floor 5 already processed their request.

### Real Software Example — Stripe's Embedded Checkout

Stripe's JavaScript (loaded from `https://js.stripe.com`) runs inside YOUR website (`https://yourshop.com`). When the user clicks "Pay," Stripe's JS needs to call `https://api.stripe.com` to tokenize the card.

The challenge: Stripe's JS is executing in your domain's context, but needs to call Stripe's API.

```
Problem flow:
  Your page: https://yourshop.com
  Script loaded: https://js.stripe.com/stripe.js

  Where does this script's JS "run"?
  → The Origin is yourshop.com (NOT js.stripe.com)
    because the script is LOADED INTO your page

  But Stripe needs to call https://api.stripe.com
  → Cross-origin: yourshop.com calling api.stripe.com
  → CORS required!

Stripe's CORS configuration:
  Access-Control-Allow-Origin: * (for public endpoints like /v1/tokens)
    Why *: Card tokenization is public (anyone can call it)
           The token has no value without your API key (server-side)

  Access-Control-Allow-Origin: [specific merchant origin] (for authenticated endpoints)
    Stripe reads your registered domain from API key → returns exact origin match

How Stripe handles CORS at scale:
  Stripe serves ~1M API requests/second
  CORS validation is handled at their edge infrastructure (Envoy-based)
  Custom allowlist per API key (merchant registers their domain in Stripe dashboard)
  If your domain isn't registered: CORS blocked → card capture fails → security feature!

Real attack prevention:
  Attacker creates evil.com, copies your Buy button, loads your Stripe public key
  User enters card on evil.com
  Stripe JS calls api.stripe.com with evil.com as Origin
  Stripe's CORS policy: evil.com is NOT in your registered domains → blocked
  Card tokenization fails → attack prevented
```

---

## SECTION 6 — System Design Importance

### 1. CORS and CDN Caching Conflict

One of the most problematic production issues:

```
Scenario without Vary:
  First request:
    GET https://cdn.shop.com/api/products
    Origin: <absent> (direct CDN hit, not cross-origin)
    ↓
    CDN caches: {"products": [...]} with NO Access-Control-Allow-Origin header

  Second request (minutes later, from cross-origin JS):
    GET https://cdn.shop.com/api/products
    Origin: https://shop.com
    ↓
    CDN serves cached response (no CORS header!) → Browser CORS error!

  The user: "Why does the app work for some users and not others?!"
  Answer: Race condition between CORS and non-CORS cached versions

Fix: Server must include Vary: Origin in ALL responses (even non-CORS):
  Vary: Origin

  This tells the CDN: "Cache a SEPARATE copy of this response for each distinct Origin value"
  CDN: one cache entry per (URL, Origin) pair

  CDN behavior with Vary: Origin:
    Request with Origin: https://shop.com → cache key: URL + "https://shop.com"
    Request with no Origin → cache key: URL + ""
    These are DIFFERENT cache entries → no conflict!

  Side effect: multiple cache copies = lower cache hit rate (each unique origin is a miss)
  Accept this tradeoff — correctness > cache efficiency
```

### 2. API Gateway CORS Configuration

When building a REST API behind API Gateway:

```
API Gateway CORS modes:
  Option A: Enable CORS on API Gateway (API Gateway handles OPTIONS preflight)
    → API Gateway auto-generates OPTIONS method for each endpoint
    → API Gateway adds CORS headers to ALL responses
    → Backend never receives OPTIONS requests (API GW handles them)

  Option B: Pass through to Lambda/backend to handle CORS
    → Lambda function handles OPTIONS method manually
    → Lambda adds CORS headers in every response
    → More control but more code in every function

  When Option A breaks:
    Gateway Responses (e.g., 403, 429, 502) don't go through your Lambda
    → These error responses have NO CORS headers (API GW default)
    → Browser sees 403 with no CORS header → CORS error (hides the real 403!)

    Fix: Configure Gateway Responses with CORS headers:
    API Gateway → Gateway Responses → DEFAULT_4XX / DEFAULT_5XX
    Add: Access-Control-Allow-Origin: '*'
    This ensures error responses also have CORS headers

    Common exam/interview trap: "Why does my 403 show as a CORS error?"
    Answer: 403 from API Gateway has no CORS headers → looks like CORS failure to browser
```

### 3. CORS in Microservices

```
Problem: 50 microservices, each handling CORS independently
  Risk: Inconsistent CORS configs → some services too permissive, some too restrictive
  Risk: Config drift → someone adds * accidentally

Solution: Centralize CORS handling at the API Gateway or load balancer layer

Option A: API Gateway
  Single API Gateway with CORS policy → routes to microservices
  Microservices never see Origin headers, never configure CORS
  CORS is a gateway-level concern

Option B: Service mesh (Nginx/Envoy)
  Envoy sidecar in each service handles CORS via shared config
  Config pushed from central config store (Consul, Vault, S3)
  Services get uniform CORS behavior without embedding it in code

Option C: BFF (Backend for Frontend)
  Dedicated Node.js BFF layer between React frontend and microservices
  BFF = same origin as frontend (OR explicit CORS handle centrally)
  All microservice calls from BFF = server-to-server = no CORS
  Frontend → BFF: either same origin (no CORS) or one well-managed CORS config

The key principle: CORS belongs at the boundary of your system (API Gateway, BFF),
not scattered across every microservice.
```

### 4. CORS and Security (What CORS Is NOT)

```
Critical misunderstanding: "We added CORS to secure our API"

What CORS does:
  ✓ Prevents browser JavaScript on other origins from READING your API responses
  ✓ Prevents cross-origin credentialed requests (with cookies) from unknown origins
  ✓ Protects users against certain CSRF patterns via SameSite=Strict complement

What CORS does NOT do:
  ✗ Does not prevent curl/Postman/server-to-server calls (they have no CORS)
  ✗ Does not authenticate users (use OAuth, API keys, JWTs)
  ✗ Does not prevent an attacker from forging requests manually
  ✗ Does not prevent XSS from the same origin (same-origin JS can do anything)
  ✗ Does not prevent CSRF if response access isn't needed (form submits still work!)

Real API security stack:
  Authentication: JWTs, API keys, OAuth 2.0 → who are you?
  Authorization: IAM, RBAC, ABAC → what can you do?
  Rate limiting: token bucket → prevent abuse
  Input validation: schema validation → prevent injection
  CORS: browser-context cross-origin isolation → one layer of defense in depth

Quote to remember: "CORS is ISP, not security" (It's Separation, Primarily)
  It separates browser contexts. It is not an access control mechanism.
```

---

## SECTION 7 — AWS Mapping

### API Gateway CORS Configuration

```
Method 1: AWS Console (REST API)
  API Gateway → Resource → Actions → Enable CORS
  Configure:
    Access-Control-Allow-Origin: 'https://shop.com'
    Access-Control-Allow-Headers: 'Content-Type,Authorization,X-Amz-Date'
    Access-Control-Allow-Methods: 'OPTIONS,GET,POST,DELETE'

  This creates an OPTIONS mock integration for each selected resource.

Method 2: HTTP API (v2) — built-in CORS config
  Simpler, native CORS support:
  aws apigatewayv2 update-api \
    --api-id abc123xyz \
    --cors-configuration \
      AllowOrigins=https://shop.com,\
      AllowMethods=GET POST DELETE,\
      AllowHeaders=Content-Type Authorization,\
      AllowCredentials=true,\
      MaxAge=86400

  HTTP API CORS: applies to ALL routes automatically
  REST API CORS: must be configured per-resource

Method 3: serverless.yml (Serverless Framework)
  functions:
    getOrders:
      handler: handlers/orders.get
      events:
        - http:
            method: GET
            path: /orders
            cors:
              origin: 'https://shop.com'
              headers:
                - Content-Type
                - Authorization
              allowCredentials: true

Gateway Response CORS (CRITICAL — don't forget):
  Even with CORS enabled on resources, 4XX/5XX Gateway Responses
  won't have CORS headers unless explicitly configured:

  REST API → Gateway Responses → DEFAULT_4XX and DEFAULT_5XX:
    Add header:
      Access-Control-Allow-Origin: 'https://shop.com'
    (or '*' for development)

  Without this: 403 Unauthorized appears as "CORS error" to the browser
```

### CloudFront CORS Configuration

```
CloudFront must forward the Origin header to the origin:
  Without this: CloudFront caches one response regardless of Origin
  CORS response headers from origin are ignored or returned to wrong client

Cache Policy (recommended):
  Create cache policy that includes Origin in cache key:
    Cache key headers: Origin

  Or use: CachingDisabled for API responses (no cache, all requests reach origin)

Origin Request Policy:
  AllHeaders or UserAgent-Referer-Headers include Origin
  → Origin header forwarded to ALB/S3/EC2 origin

cors with CORS response:
  Origin S3 must have CORS policy
  CloudFront forwards Origin → S3 evaluates → responds with CORS headers
  CloudFront MUST have Vary: Origin in cache behavior to cache per-origin

CloudFront managed Response Headers Policy:
  AWS provides: Managed-CORS-Allow-All-Origins
    → Adds CORS headers at the edge (no need to configure in your backend)
    → Use for: static assets from S3 where you need CORS headers
    → Be careful: AllowAllOrigins = * (no credentials possible)

  Custom Response Headers Policy:
    Create with specific AllowedOrigins list
    Add custom headers to every response
    CloudFront adds these AFTER receiving origin response (not passed to origin)
```

### ALB + CORS

```
ALB does NOT natively add CORS headers.
CORS headers must be added by your backend application (Nginx, Node.js, etc.)

Common patterns:
  Option A: Nginx adds CORS headers (before backend application):
    location /api {
      add_header 'Access-Control-Allow-Origin' $http_origin always;
      add_header 'Access-Control-Allow-Credentials' 'true' always;
      add_header 'Vary' 'Origin' always;
      if ($request_method = 'OPTIONS') {
        add_header 'Access-Control-Allow-Methods' 'GET, POST, DELETE, OPTIONS';
        add_header 'Access-Control-Allow-Headers' 'Authorization, Content-Type';
        add_header 'Access-Control-Max-Age' 86400;
        return 204;
      }
      proxy_pass http://app:8080;
    }

  Option B: Application-level (Express.js):
    app.use(cors({
      origin: function(origin, callback) {
        const allowlist = ['https://shop.com', 'https://admin.shop.com'];
        if (!origin || allowlist.includes(origin)) {
          callback(null, true);
        } else {
          callback(new Error('CORS blocked: ' + origin));
        }
      },
      credentials: true
    }));

  Option C: CloudFront Response Headers Policy (recommended for static/API edge):
    Attach to CloudFront distribution
    CloudFront adds specified CORS headers to ALL responses from that origin
    ALB/backend doesn't need to handle CORS
```

### S3 CORS for Static Assets

```
S3 CORS applies when:
  JavaScript tries to read S3 object data (canvas drawing, data fetch)
  NOT for simple <img>, <script>, <link> tags (browsers allow these cross-origin)

S3 CORS Configuration (in bucket Permissions tab):
  [
    {
      "AllowedHeaders": ["Authorization", "Content-Type"],
      "AllowedMethods": ["GET", "HEAD", "PUT"],
      "AllowedOrigins": [
        "https://shop.com",
        "https://www.shop.com"
      ],
      "ExposeHeaders": ["ETag", "x-amz-version-id"],
      "MaxAgeSeconds": 3000
    }
  ]

S3 presigned URLs and CORS:
  Presigned URL allows direct PUT from browser to S3:
    Frontend gets presigned URL from backend
    Browser PUTs file directly to S3 (not through backend)
    Origin: https://shop.com → S3 must have CORS allowing PUT from shop.com

  Common mistake: S3 CORS only allows GET/HEAD → presigned PUT fails with CORS error
  Fix: Add "PUT" to AllowedMethods in S3 CORS config
```

---

## SECTION 8 — Interview Q&As

### Beginner Questions

**Q1: What is the Same-Origin Policy and why does it exist?**

A: The Same-Origin Policy is a browser security model that prevents JavaScript from one origin from reading content fetched from a different origin. Two origins are the same only if their protocol, hostname, AND port all match.

It exists because browsers are trusted to hold sensitive state: session cookies, stored credentials, authenticated DOM content. Without Same-Origin Policy, any website you visit could run JavaScript that silently reads your bank account balance, sends emails from your Gmail, or transfers money — using YOUR authenticated session cookies that the browser automatically sends with every request.

Example: You're logged into mybank.com. You open evil.com. evil.com's JavaScript tries to fetch https://mybank.com/balance. The browser blocks evil.com's JavaScript from reading the response, even though the HTTP request succeeds and the server returns the balance. The browser never shows that data to evil.com's JavaScript.

Note: Same-Origin Policy restricts JavaScript from READING cross-origin responses. It doesn't prevent cross-origin requests from being made (the request still reaches the server). This is why security can't be fully outsourced to CORS.

**Q2: Why does a CORS "error" appear in the browser even when the server received and processed the request?**

A: CORS is a browser-enforcement mechanism, not a network-level block. The HTTP request is sent to the server regardless. The server processes it, sends a response. The browser receives the response, checks for CORS headers, and if they're missing or incorrect — the browser silently discards the response and gives the JavaScript an error.

This creates an important production safety issue: if your DELETE request fails with a CORS error, the DELETE may have ALREADY EXECUTED on the server. The browser just didn't let the JavaScript know whether it succeeded.

This is why:

1. Distinguish "CORS error" from "server-side error" when debugging (CORS error = headers issue, not necessarily a server-side failure)
2. Design APIs to be idempotent for requests that might be retried after a CORS failure
3. Fix CORS before users can trigger repeated side effects from confused retry behavior

**Q3: When should you use `Access-Control-Allow-Origin: *` vs. a specific origin?**

A: Use `*` (wildcard): for truly public APIs where you want any origin to be able to read the response, AND you don't need cookies or Authorization headers. Examples: public CDN files, publicly-accessible JSON APIs (weather data, public GitHub API), font files.

Use a specific origin: whenever you're dealing with authenticated APIs, cookie-based sessions, or sensitive data. Also use specific origins when you want to control which applications can consume your API from the browser context.

Critical constraint: You CANNOT combine `*` with `Access-Control-Allow-Credentials: true`. Browsers explicitly reject this combination. If your API needs `credentials: 'include'` on the frontend, the server must return the exact requesting origin, not `*`.

Rule of thumb: If your API endpoint touches user data, use an explicit allowlist of origins. If it's publicly readable data with no user context, `*` is fine and simpler.

---

### Intermediate Questions

**Q4: Your API works in Postman and curl, but fails with CORS errors in the browser. Explain why and how you'd fix it.**

A: Postman and curl are not browsers. They don't enforce Same-Origin Policy. They send requests and show you every response, regardless of CORS headers. The CORS enforcement mechanism only exists in web browsers.

When you run `curl https://api.shop.com/data`, curl sends the request, server responds, curl shows you the response. No Origin header is sent. No CORS check happens.

When JavaScript in the browser does `fetch("https://api.shop.com/data")`, the browser:

1. Adds `Origin: https://yoursite.com` to the request automatically
2. Makes the request
3. Receives the response
4. Checks the response for `Access-Control-Allow-Origin` header
5. If missing or doesn't match: blocks JS from reading the response

Fix: Add CORS headers to the server response. For Express: install and configure the `cors` npm package with your origin allowlist. For Nginx: add `add_header` directives. For API Gateway: enable CORS on each resource.

**Q5: You added CORS headers to your Express app but half your users still report CORS errors. The other half work fine. What could cause this?**

A: The most common cause is an ordering bug in Express middleware combined with error responses from API Gateway, or a caching issue at the CDN level.

**Cause 1: Middleware ordering in Express:**

```
// BUG: router before cors
app.get('/api/products', productHandler);  // no CORS yet
app.use(cors({ origin: 'https://shop.com' }));  // too late!

// FIX: cors middleware must be BEFORE routes
app.use(cors({ origin: 'https://shop.com' }));
app.get('/api/products', productHandler);
```

**Cause 2: Error responses bypass middleware:** Express returns 500 errors before CORS headers are added. OR API Gateway 4XX/5XX responses come directly from the gateway — with no CORS headers. Fix: configure Gateway Responses in API Gateway.

**Cause 3: CDN caching without Vary: Origin:** The CDN cached a response without CORS headers (first request was from a direct non-CORS client). Subsequent CORS requests get the cached response — no CORS headers. Fix: add `Vary: Origin` to all responses. Invalidate CDN cache.

**Cause 4: Some routes handle CORS, others don't:** Not all routes have CORS applied. Fix: ensure cors middleware is applied globally (`app.use(cors(...))` before all routes).

Why "half the users"? Likely a subset is hitting paths that return early (auth failure → 401 → no CORS header) or are getting cached responses.

**Q6: What is the CORS `Vary: Origin` header and why is it critical for CDNs?**

A: `Vary` tells HTTP intermediaries (CDN, proxies, browser cache): "This response varies depending on the value of the listed request headers. Cache a separate entry for each unique value."

Without `Vary: Origin`:

- CDN caches one copy of the response (first response it sees)
- If first response had no CORS headers (direct request, no Origin) → CDN stores that version
- Next request comes with `Origin: https://shop.com` → CDN serves cached version (no CORS headers) → CORS error

With `Vary: Origin`:

- CDN creates one cache entry per unique Origin value
- `Origin: https://shop.com` → cache key: URL + "https://shop.com"
- No Origin → cache key: URL + ""
- These are separate entries → correct CORS headers returned every time

Downside: Vary: Origin multiplies cache entries. If your site is accessed from 10 different allowed origins, each URL has 10 cached versions. This lowers cache hit rate. For most APIs, this is an acceptable tradeoff.

---

### Advanced System Design Questions

**Q7: Design a multi-tenant SaaS platform where each tenant has a custom domain (tenant1.io, tenant2.com) and they all call a shared API at api.yourplatform.com. How do you handle CORS?**

A: Dynamic CORS with a tenant allowlist:

**Architecture:**

```
Tenant registration:
  When a tenant onboards: they provide their frontend domain
  You store: tenant_id → [allowed_origins]
  Example: tenant-123 → ["https://tenant1.io", "https://www.tenant1.io"]

Server-side CORS validation:
  CORS middleware reads Origin header from request
  Extracts api key or tenant ID from request (from sub-path, JWT, API key header)
  Looks up tenant's allowed origins
  If request Origin is in that list → respond with exact Origin in Allow-Origin
  If not → return no CORS headers (browser blocks it)

  Implementation:
    const origin = req.headers.origin;
    const tenantId = extractTenantId(req);
    const allowedOrigins = await getTenantOrigins(tenantId);  // from DB or cache

    if (allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }

Caching strategy:
  Tenant origin lists: hot cache (Redis, 1-minute TTL)
  Low latency on every API call
  Updates propagated within 1 minute of tenant domain change

CloudFront (if applicable):
  With custom origins per tenant: CloudFront can use Lambda@Edge to:
    - Read Origin header
    - Check Redis/DynamoDB allowlist
    - Inject correct CORS headers at edge
  This handles CORS at CDN without reaching origin servers
```

**Q8: A security audit flags your API because it reflects the `Origin` header directly into `Access-Control-Allow-Origin` without validation. What is the risk and how do you fix it?**

A: Blindly reflecting the Origin header is a critical misconfiguration equivalent to `Access-Control-Allow-Origin: *` with credentials:

```
Vulnerable code:
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin);  // INSECURE!
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    next();
  });

Attack scenario:
  Attacker creates: https://evil.com
  Hosts JavaScript that calls https://api.yourplatform.com/user/export
  User who is logged into yourplatform.com visits evil.com
  Browser adds Origin: https://evil.com to the request
  Server reflects it: Access-Control-Allow-Origin: https://evil.com
  Browser: this specific evil.com is explicitly allowed → releases response to evil.com's JS
  evil.com reads the user data → exfiltration complete

Risk level: CRITICAL. This breaks the Same-Origin isolation model entirely.

Fix:
  const ALLOWED_ORIGINS = new Set([
    'https://app.yourplatform.com',
    'https://www.yourplatform.com',
    'https://admin.yourplatform.com'
  ]);

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
    }
    // If NOT in allowlist: no CORS headers → browser blocks the response
    next();
  });

Secondary fix: Add CORS security scanning to CI/CD pipeline:
  Tools: OWASP ZAP, cors-tester npm package
  Alert on: wildcard with credentials, origin reflection
```

---

## File Summary

This file covered:

- Restaurant CORS note analogy + corporate visitor badge analogy for cross-departmental access
- Stripe embedded checkout: dynamic CORS allowlist per merchant, \* for public tokenization endpoints
- CDN/CORS caching conflict: Vary: Origin prevents serving cached non-CORS response to CORS request
- API Gateway CORS: rest vs HTTP API configuration, Gateway Responses must also have CORS headers
- CORS in microservices: centralize at API Gateway / service mesh / BFF layer (not per-service)
- CORS ≠ security: doesn't block server-to-server, curl, Postman
- AWS: API Gateway (REST vs HTTP API CORS), CloudFront managed/custom response headers policy, ALB+Nginx CORS, S3 CORS for presigned PUT
- 8 Q&As: Same-Origin Policy purpose, request still executes on CORS error, \* vs specific origin, Postman vs browser, half-users bug, Vary: Origin, multi-tenant CORS, Origin reflection vulnerability

**Continue to File 03** for AWS SAA exam traps, 5 comparison tables, Quick Revision mnemonics, and Architect Exercise.
