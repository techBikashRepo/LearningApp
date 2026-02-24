# HTTP Methods — Part 2 of 3

### Topic: HTTP Methods in Production Systems and AWS

**Series:** Networking Fundamentals → System Design → AWS Solutions Architect
**Audience:** 14-Year Experienced Full-Stack Developer → Becoming an Architect
**Sections Covered:** 5, 6, 7, 8

---

## SECTION 5 — Real World Examples

### Analogy 1 — The Contract Amendment Process

A law firm handles contracts with strict procedures:

- **GET:** "Give me a copy of contract #1001 to read." (No changes — safe)
- **POST:** "File a new contract for client ABC." (Creates new record; filing twice = two contracts)
- **PUT:** "Replace contract #1001 entirely with this updated version." (Whole document replaced)
- **PATCH:** "Amendment #3: update only clause 5.2 of contract #1001." (Surgical change)
- **DELETE:** "Terminate contract #1001." (Removes it; terminating again = no further effect)
- **HEAD:** "Does contract #1001 exist? When was it last modified?" (Check without retrieval)
- **OPTIONS:** "What actions are allowed on contract #1001 for my role?" (Capability discovery)

The amendment (PATCH) metaphor is especially useful: you don't retype the entire 100-page contract to change one clause. You write an amendment that identifies the location and the change. This is why PATCH is preferred over PUT for partial updates in high-traffic APIs — less data transferred, less chance of concurrent update conflicts.

### Analogy 2 — The Construction Site Permit Office

- **GET:** Viewing posted permit applications on the board
- **POST:** Submitting a new permit application (each submission creates a new ticket)
- **PUT:** Replacing your application entirely with a corrected version
- **PATCH:** Correcting just the address on your existing application
- **DELETE:** Withdrawing your application
- **OPTIONS:** Asking the clerk: "What can I do today? Are you accepting PUT requests?" (CORS preflight)

The permit office analogy shows idempotency clearly: if you submit the same corrected address twice (PATCH), the result is the same address — second PATCH changed nothing. But submitting the same new application twice (POST) creates two tickets.

### Real Software Example — Stripe Payment API Method Design

Stripe's API is a reference implementation of correct HTTP method semantics:

```
STRIPE API METHOD DECISIONS AND WHY:

CREATE a payment intent:
  POST /v1/payment_intents
  {amount: 2000, currency: "usd"}

  Returns: {id: "pi_abc123", status: "requires_payment_method"}

  Why POST: creates a new resource each call.
  Stripe also requires Idempotency-Key header:
    Idempotency-Key: client-generated-uuid
  Why: mobile apps lose network, retry POST, must not double-charge.

CONFIRM payment intent (trigger charge):
  POST /v1/payment_intents/pi_abc123/confirm

  Why POST: it's an ACTION (trigger charge) on a resource, not a CRUD update.
  Pattern: nested POST for actions → /resource/{id}/action

UPDATE just the amount:
  POST /v1/payment_intents/pi_abc123   (Stripe uses POST for updates too!)
  {amount: 2500}

  Why POST instead of PATCH?
  Stripe notes that their API predates widespread PATCH adoption.
  Both are acceptable; the important thing is documentation and idempotency keys.
  Modern APIs should prefer PATCH for partial updates.

RETRIEVE payment intent:
  GET /v1/payment_intents/pi_abc123
  Returns: full object

CANCEL payment intent:
  POST /v1/payment_intents/pi_abc123/cancel
  Why: cancellation is an ACTION that transitions state — POST to sub-resource

LIST payment intents:
  GET /v1/payment_intents?customer=cus_xyz&limit=10
  Query params filter the collection — no body needed (GET is appropriate)

WEBHOOK events (Stripe → your server):
  POST /webhooks/stripe
  Content-Type: application/json
  Stripe-Signature: t=timestamp,v1=signature
  {type: "payment_intent.succeeded", data: {...}}

  Stripe uses POST for webhooks: it's creating an event notification in your system.
  Your server must return 200 quickly (< 30s) or Stripe retries (exponential backoff).
  Idempotency: Stripe may deliver the same event multiple times → your handler must be
  idempotent (check if already processed before acting).
```

---

## SECTION 6 — System Design Importance

### 1. Method Idempotency as a Retry Safety Contract

In distributed systems, network failures are normal. Retry logic is essential. Method semantics determine when it's safe to retry:

```
Safe to auto-retry:
  GET, HEAD, PUT, DELETE, OPTIONS
  → Proxy, client, ALB can transparently retry on network failure
  → Same result regardless of how many times executed

NOT safe to auto-retry:
  POST
  → Each retry may create a duplicate resource or trigger duplicate action
  → Requires application-level idempotency key
  → OR: idempotency must be designed into the operation itself

Example — order processing:
  POST /orders → creates order
  If network drops: client doesn't know if server created it
  Without idempotency key: retry → two orders (customer charged twice)
  With idempotency key: retry → server returns same order (one charge)

  Pattern: always include idempotency keys on financial POST requests
  Implementation: store hash(idempotency_key) → {response, created_at}
                  TTL: 24h (per Stripe's recommendation)
                  If key exists: return same response immediately
```

### 2. Method Tunneling Anti-Pattern

Some legacy systems "tunnel" all requests through POST:

```
Anti-pattern (method tunneling):
  POST /rpc  {"method": "getUser", "id": 123}
  POST /rpc  {"method": "deleteUser", "id": 123}
  POST /rpc  {"method": "updateUser", "id": 123, "email": "new@ex.com"}

Problems:
  - HTTP caching doesn't work (POST not cacheable)
  - CDN can't cache anything → every request hits origin
  - Monitoring by HTTP method meaningless
  - ALB path-based routing useless (all same path /rpc)
  - Load testing unclear (is this read or write traffic?)

This is essentially what XML-RPC and SOAP did. GraphQL also uses POST for all queries
(though there are reasons: complex query parameters don't fit in URL query strings).

GraphQL compromise:
  POST /graphql  {"query": "{ user(id: 123) { name email } }"}
  → Mutable (mutation): always POST
  → Reads (query): should be GET but often POST for complex queries
  → Caching: requires query-level caching (Apollo Client, query signatures)
  → Persisted queries: cache by query hash
```

### 3. REST vs GraphQL Method Semantics

```
REST (HTTP methods carry semantic meaning):
  GET    /users/123         → cache-control works natively
  PATCH  /users/123         → partial update, clear intent
  DELETE /users/123/posts/5 → clear resource addressing

GraphQL (all through POST /graphql):
  Mutation (create/update/delete): POST /graphql + mutation query
  Query (read): POST /graphql + query

  Problem: HTTP caching breaks for reads (POST = not cached)
  Solution: Persisted queries (hash query, send GET /{hash}?variable=...)

  Apollo: automatic persisted queries (APQ)
    First time: POST with full query → server stores hash → sends hash
    Subsequent: GET /graphql?operationName=GetUser&extensions={persisted:{hash:"abc"}}
    CDN can now cache GETs by query hash
```

### 4. Designing for Safe Web Crawlers

HTTP method safety has a real consequence: web crawlers and prefetchers call GET/HEAD links freely. If you use GET for destructive operations, bots will destroy data:

**Historical disaster:**
Django/Rails had a built-in logout link: `<a href="/logout">Logout</a>`. Google's web accelerator (a browser extension that prefetched all links) sent GET to `/logout` for every page visited. Users were logged out automatically. The fix: make logout a POST (requires user action, not crawlable).

**Rule:** Never use GET for any state-changing operation. GET must be safe.

```
Bad:  <a href="/account/delete">Delete Account</a>
      → Any crawler/prefetcher will DELETE accounts

Good: <form method="POST" action="/account/delete">
        <button type="submit">Delete Account</button>
      </form>
      → Requires explicit user form submission;
        CSRF token in hidden field prevents CSRF attacks
```

### 5. CORS and OPTIONS in Microservices

In a microservices environment:

```
React SPA calls multiple APIs:
  api.users.company.com
  api.orders.company.com
  api.payments.company.com

Each is a different origin → each needs CORS headers.

Anti-pattern: Add CORS middleware to every microservice
  Each service handles OPTIONS preflight independently
  Headers may be inconsistent across services

Better pattern: API Gateway handles CORS centrally
  Single point for CORS policy
  All microservices behind the gateway don't need CORS headers

AWS API Gateway CORS:
  HTTP API: Enable CORS in one click (console)
            Internally responds to OPTIONS with correct headers
            Passes actual request to Lambda/backend
  REST API: Enable CORS per method or per resource
            Can use mock integration for OPTIONS (no lambda invocation)

CloudFront + API Gateway:
  CloudFront distribution in front of API Gateway
  CloudFront configured to PASS CORS headers through (don't cache OPTIONS)
  OPTIONS: Cache-Control: max-age=0 (don't cache preflight at CloudFront level)
  Actual GET/POST: cache based on your policy
```

---

## SECTION 7 — AWS Mapping

### API Gateway: Routing by HTTP Method

```
REST API Gateway resource configuration:
  Resource: /orders
    GET  → Lambda: ListOrdersFunction
    POST → Lambda: CreateOrderFunction

  Resource: /orders/{orderId}
    GET    → Lambda: GetOrderFunction
    PUT    → Lambda: ReplaceOrderFunction
    PATCH  → Lambda: UpdateOrderFunction
    DELETE → Lambda: DeleteOrderFunction

HTTP API Gateway (simpler, preferred for new APIs):
  Route: GET /orders → Lambda
  Route: POST /orders → Lambda
  Route: ANY /orders/{proxy+} → Lambda (catch-all)

Method-level authorization (REST API):
  GET /products → No auth (public catalog)
  POST /orders  → JWT Authorizer (must be logged in)
  DELETE /admin → AWS IAM Authorization (only admin role)
```

### ALB: Method-Based Routing Rules

ALB listener rules can route by HTTP method (less common but available):

```
ALB Rules (evaluated top to bottom):
  Rule 1: IF Method=POST AND Path=/orders → Forward to: OrderCreationTargetGroup
  Rule 2: IF Method=GET AND Path=/orders* → Forward to: OrderReadTargetGroup (read replicas)
  Rule 3: IF Path=/admin/* → Forward to: AdminTargetGroup
  Rule 4: Default → ForwardMainTargetGroup

Use case: write/read separation
  GET requests → read replica backed service (can scale independently)
  POST/PUT/PATCH/DELETE → primary service (writes to main DB)

Condition types ALB supports:
  - HTTP method (GET, POST, etc.)
  - Host header
  - Path pattern (/api/v2/*)
  - HTTP header (X-Feature-Flag: beta)
  - Query string (?version=2)
  - Source IP CIDR
```

### Lambda and API Gateway Method Handling

```javascript
// Lambda function handling multiple HTTP methods
exports.handler = async (event) => {
  const { httpMethod, path, pathParameters, body } = event;

  switch (httpMethod) {
    case "GET":
      const id = pathParameters?.orderId;
      if (id) {
        const order = await db.getOrder(id);
        return { statusCode: 200, body: JSON.stringify(order) };
      }
      const orders = await db.listOrders();
      return { statusCode: 200, body: JSON.stringify(orders) };

    case "POST":
      const input = JSON.parse(body);
      const idempotencyKey = event.headers["Idempotency-Key"];
      const existing = await cache.get(`idem:${idempotencyKey}`);
      if (existing) return existing; // Return cached response

      const newOrder = await db.createOrder(input);
      const response = {
        statusCode: 201,
        body: JSON.stringify(newOrder),
        headers: { Location: `/orders/${newOrder.id}` },
      };
      await cache.set(`idem:${idempotencyKey}`, response, 86400);
      return response;

    case "DELETE":
      await db.deleteOrder(pathParameters.orderId);
      return { statusCode: 204, body: "" };

    case "OPTIONS":
      // Handled by API Gateway CORS (shouldn't reach Lambda)
      return {
        statusCode: 204,
        headers: { "Access-Control-Allow-Origin": "*" },
      };

    default:
      return {
        statusCode: 405,
        body: "Method Not Allowed",
        headers: { Allow: "GET, POST, DELETE, OPTIONS" },
      };
  }
};
```

---

## SECTION 8 — Interview Q&As

### Beginner Questions

**Q1: What is the difference between PUT and PATCH?**

A: Both modify a resource, but differ in scope. PUT replaces the entire resource with the provided payload. If you PUT a user profile with only `{email: "new@ex.com"}`, the result is a user profile with ONLY an email field — all other fields (name, phone, address) are deleted. PUT requires the client to send the complete resource state.

PATCH applies partial changes. A PATCH with `{email: "new@ex.com"}` updates only the email field, leaving all other fields unchanged. PATCH is more bandwidth-efficient and less prone to concurrency issues (reading the full resource, modifying, writing back). The trade-off: PATCH requires the server to understand how to merge the partial payload into the existing resource.

**Q2: Why is POST not idempotent, and how do you handle POST retries safely?**

A: POST is not idempotent because each call may create a new resource. If you POST to `/payments` twice with the same body, you get two payment transactions — potentially charging a customer twice.

In production, POST retries are handled with idempotency keys:

1. Client generates a unique UUID per logical operation (not per HTTP request)
2. Client includes it as a header: `Idempotency-Key: uuid-abc`
3. Server stores the mapping: `idempotency_key → {response_code, response_body}` with a TTL
4. If server receives POST with a known idempotency key: returns the stored response immediately, no new resource created
5. Client can retry as many times as needed — always gets the same result

This pattern is used by every payment processor (Stripe, Adyen, PayPal) as a fundamental reliability mechanism.

**Q3: What is a CORS preflight request, and when does the browser send it?**

A: A CORS preflight is an automatic OPTIONS request the browser sends before a "non-simple" cross-origin request, to ask the server if the actual request is allowed.

A simple request (no preflight) must be: GET/POST/HEAD + only allowed headers (Content-Type: text/plain or form types) + no custom headers. Most API calls are NOT simple: they use `Content-Type: application/json` or `Authorization` header.

Non-simple request → browser sends OPTIONS with:

- `Origin`: the requesting origin
- `Access-Control-Request-Method`: the intended method
- `Access-Control-Request-Headers`: the intended custom headers

Server responds with `Access-Control-Allow-*` headers indicating what's permitted. Browser checks the response — if allowed, proceeds with the actual request; if not, blocks it and throws a CORS error.

Critical: CORS is enforced ONLY by browsers. `curl`, Postman, and server-to-server calls bypass CORS entirely. CORS protects users, not APIs.

### Intermediate Questions

**Q4: You have an e-commerce API. A mobile client updates a product — should it use PUT or PATCH? What are the concurrency implications?**

A: Use PATCH for a mobile client updating a product. Reasons:

**Bandwidth:** A product object may have 30 fields (name, description, price, SKU, images array, category, tags, inventory count, etc.). Mobile app edits only the price. PUT requires sending all 30 fields; PATCH sends only `{price: 99.99}`. On mobile networks, this matters.

**Concurrency (lost update problem):**

```
User A (mobile) loads product (name="Headphones", price=89.99, stock=10)
User B (admin) updates stock to 8
User A edits price, sends PUT: {name="Headphones", price=99.99, stock=10}
→ stock reverted to 10 (User B's update lost!)

With PATCH: User A sends {price: 99.99}
→ Only price changes; stock=8 (User B's update preserved)
```

For concurrent updates, use optimistic locking: include `If-Match: "{etag}"` header with PATCH/PUT. Server returns 412 Precondition Failed if resource changed since client read it. Client must re-fetch and retry.

**Q5: How does HTTP method choice affect CDN caching?**

A: CDN caching eligibility is directly determined by HTTP method:

- GET and HEAD responses are cacheable (CDN can store and serve them)
- POST, PUT, PATCH, DELETE responses are NOT cached by CDN (mutations should not be cached)

Implications:

- Read-heavy APIs (product catalog, user profiles) → use GET → CDN caches → origin protected
- Write APIs → POST/PUT → always hits origin → autoscale to handle
- Hybrid: GET for reads even if query is complex (encode in URL query params or use POST for queries and implement CDN-level caching with query-aware cache keys)
- GraphQL challenge: uses POST for all operations → CDN can't cache queries → requires persisted queries + GET for reads

For CloudFront specifically: you can configure a cache behavior that caches POST responses (not recommended — only when POST is truly idempotent and safe to cache, rare edge case).

**Q6: What does `Allow: GET, POST, DELETE` in an HTTP 405 response mean, and how is it used?**

A: When a client sends a request using a method not supported by a resource, the server returns `405 Method Not Allowed`. RFC 7231 requires the server to include an `Allow` header listing all valid methods for that resource.

Example: Client sends `PATCH /orders/1234` to a service that doesn't support PATCH. Server returns:

```
HTTP/1.1 405 Method Not Allowed
Allow: GET, POST, DELETE
Content-Type: application/problem+json

{"title": "Method Not Allowed", "status": 405, "detail": "PATCH is not supported on /orders/{id}. Use POST to create, GET to retrieve, DELETE to cancel."}
```

The `Allow` header is machine-readable: API clients, SDKs, and documentation generators can use it to enumerate supported methods without reading documentation. It's also the response to an OPTIONS request for a specific resource. AWS API Gateway automatically returns 405 with an `Allow` header when the method isn't configured for a route.

### Advanced System Design Questions

**Q7: Design an idempotent order creation system that handles mobile network retries safely, using AWS services.**

A: The challenge: mobile network drops POST /orders mid-flight after server creation. Client must retry but exactly-once semantics matter.

**Architecture:**

```
Mobile App
  │
  │ POST /orders
  │ Idempotency-Key: UUID (generated on first attempt, reused on retries)
  │ Retry-After: 1s (client-controlled retry interval)
  ▼
API Gateway (HTTP API)
  │ Route: POST /orders → CreateOrderLambda
  ▼
CreateOrderLambda:
  1. Extract Idempotency-Key header
  2. Check DynamoDB: SELECT * FROM idempotency_keys WHERE key = {Idempotency-Key}
     - Found → return cached response (include Idempotency-Replayed: true header)
     - Not found → proceed
  3. INSERT into Orders table (conditional: IF NOT EXISTS order_id)
  4. Publish to SQS OrderCreated event (downstream processing)
  5. INSERT into idempotency_keys: {key, order_id, response_body, expires_at: now+24h}
  6. Return 201 Created + Location header

DynamoDB Idempotency Table:
  Partition Key: idempotency_key (UUID)
  TTL: 24 hours (auto-delete after 24h)
  Attributes: order_id, status_code, response_body, created_at

Race condition (two simultaneous retries arrive at same time):
  DynamoDB conditional write: PutItem with ConditionExpression: attribute_not_exists(#key)
  First write succeeds → second write throws ConditionalCheckFailedException
  Lambda catches exception → reads the first write's data → returns same response
```

This gives exactly-once processing: any number of retries with the same idempotency key always returns the same response and creates exactly one order.

**Q8: A team is building a REST API and debating: should bulk operations (delete 500 users at once) use DELETE with a body, or POST to a `/bulk-delete` endpoint? What are the trade-offs?**

A: Both approaches have legitimate use cases. Here is the full trade-off analysis:

**Option A: `DELETE /users` with body `{ids: [1,2,...,500]}`**

- Semantically correct (DELETE is the right method for deletion)
- Problem: HTTP spec says DELETE body "has no defined semantics" — many HTTP libraries, CDNs, and proxies discard request bodies on DELETE
- AWS API Gateway: strips DELETE body in some configurations
- Caching infrastructure may behave unpredictably

**Option B: `POST /users/bulk-delete` with body `{ids: [1,2,...,500]}`**

- Not RESTfully "pure" (POST for deletion)
- But: completely reliable — every HTTP stack treats POST body correctly
- Can add idempotency key (POST + idempotency key = safe retry)
- Consistent with industry practice (many APIs use this)
- Can make it idempotent: if same IDs sent twice, second DELETE of already-deleted users returns same 200 (soft-delete)

**My recommendation:** `POST /users/bulk-delete` for pure HTTP reliability, with documentation clearly stating the intent. REST purists prefer `DELETE /users` with body, but real-world HTTP infrastructure makes this risky. The pragmatic choice is POST for bulk operations.

A third option emerging in REST design: `POST /batch` with an operations array (similar to JSON:API atomic operations), which handles any combination of bulk operations in one request.

---

## File Summary

This file covered:

- Contract amendment (PATCH = amend specific clause) and construction permit analogies for method semantics
- Stripe's API as a reference implementation: POST for creation, idempotency keys, POST for actions
- POST retry safety: idempotency keys stored with 24h TTL in DynamoDB/Redis — fundamental reliability pattern
- Method tunneling anti-pattern (all POST /rpc): breaks CDN caching, monitoring, and HTTP semantics
- GraphQL POST trade-offs and APQ (Apollo Persisted Queries) for CDN cacheability
- GET for destructive operations causes crawler/bot disasters (Django logout link history)
- API Gateway: route by method per resource; Lambda: switch on httpMethod; ALB: method-based routing rules
- 8 Q&As: PUT vs PATCH concurrency, POST idempotency, CORS browser-only enforcement, bulk operations design, CDN caching by method

**Continue to File 03** for AWS SAA certification traps (CORS misconfiguration patterns, API Gateway method authorization), comparison tables, mnemonics (SIPD — Safe/Idempotent/Purpose/Delete semantics), and Architect Exercise: diagnosing a production double-charge bug traced to missing idempotency on POST.
