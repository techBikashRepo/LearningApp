# Resource Naming — Part 2 of 3

### Sections: 5 (Architecture Diagram), 6 (Production Scenarios), 7 (Scaling & Reliability), 8 (AWS Mapping)

**Series:** Backend & API Design → REST APIs → System Design

---

## SECTION 5 — Architecture Diagram: Resource Naming in a Real Production System

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        SHOPWAVE API PLATFORM                                 │
│                                                                               │
│  ┌──────────────────┐   ┌─────────────────────────────────────────────────┐  │
│  │   CloudFront CDN  │   │              API GATEWAY LAYER                  │  │
│  │                   │──▶│  /v1/products/**  (public, cacheable)           │  │
│  │  Cache:           │   │  /v1/vendors/**   (authenticated, no cache)     │  │
│  │  GET /products**  │   │  /v1/orders/**    (authenticated, no cache)     │  │
│  │  max-age=300      │   │                                                 │  │
│  │  (public data)    │   │  Route by path prefix → target service          │  │
│  └──────────────────┘   └────────────────────┬────────────────────────────┘  │
│                                               │                               │
│                          ┌────────────────────▼────────────────────────────┐  │
│                          │              LOAD BALANCER (ALB)                │  │
│                          │   Path-based routing:                           │  │
│                          │   /v1/products/** → Product Service (ECS)       │  │
│                          │   /v1/vendors/**  → Vendor Service (ECS)        │  │
│                          │   /v1/orders/**   → Order Service (ECS)         │  │
│                          │   /v1/reviews/**  → Review Service (ECS)        │  │
│                          └────────────────────┬────────────────────────────┘  │
│                                               │                               │
│         ┌─────────────────┬─────────────────┬─┴────────────────────┐         │
│         ▼                 ▼                 ▼                      ▼         │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐  ┌──────────────┐   │
│  │  PRODUCT    │  │  VENDOR     │  │  ORDER SERVICE  │  │  REVIEW      │   │
│  │  SERVICE    │  │  SERVICE    │  │                 │  │  SERVICE     │   │
│  │             │  │             │  │  POST /orders   │  │              │   │
│  │  GET        │  │  CRUD on    │  │  GET /orders    │  │  GET/POST on │   │
│  │  /products  │  │  /vendors   │  │  POST .../cancel│  │  /reviews    │   │
│  │  /products/ │  │  /vendors/  │  │                 │  │              │   │
│  │  {id}       │  │  {id}/prods │  │                 │  │              │   │
│  └──────┬──────┘  └──────┬──────┘  └────────┬────────┘  └──────┬───────┘   │
│         │                │                   │                   │           │
│         ▼                ▼                   ▼                   ▼           │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │                    PERSISTENCE LAYER                                    │  │
│  │                                                                         │  │
│  │  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────────┐  │  │
│  │  │  Products DB     │  │  Orders DB       │  │  Vendors DB          │  │  │
│  │  │  (Aurora PG)     │  │  (Aurora PG)     │  │  (Aurora PG)         │  │  │
│  │  │  PRIMARY KEY:    │  │  PRIMARY KEY:    │  │  PRIMARY KEY:        │  │  │
│  │  │  product_id UUID │  │  order_id UUID   │  │  vendor_id UUID      │  │  │
│  │  │                  │  │  + slug index    │  │  + slug index        │  │  │
│  │  └──────────────────┘  └──────────────────┘  └──────────────────────┘  │  │
│  │                                                                         │  │
│  │  ┌──────────────────────────────────────────────────────────────────┐  │  │
│  │  │  ElastiCache Redis: URL-keyed cache                              │  │  │
│  │  │  Key: "product:{product_id}" → product JSON (TTL: 5 min)         │  │  │
│  │  │  Key: "products:list:{hash_of_filters}" → list JSON (TTL: 1 min) │  │  │
│  │  └──────────────────────────────────────────────────────────────────┘  │  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘

API Gateway Resource Path → Service Routing:
  /v1/products              → Product Service: GET (public, cached at CDN)
  /v1/products/{id}         → Product Service: GET, PUT, PATCH, DELETE
  /v1/vendors               → Vendor Service: GET (admin), POST
  /v1/vendors/{id}          → Vendor Service: GET, PATCH, DELETE
  /v1/vendors/{id}/products → Product Service: POST, GET (vendor scope)
  /v1/orders                → Order Service: GET (user-scoped by JWT), POST
  /v1/orders/{id}/cancel    → Order Service: POST (special route, state transition)
```

### How Resource Naming Drives Infrastructure Decisions

```
URL PREFIX → CDN CACHING RULE:
  /v1/products/**        → Cache-Control: public, max-age=300 (5 min TTL)
  /v1/products/{id}/reviews → Cache-Control: public, max-age=60 (1 min, changes more)

  /v1/vendors/**         → Cache-Control: private, no-store (auth required)
  /v1/orders/**          → Cache-Control: private, no-store (user-specific data)

URL STRUCTURE → AUTHORIZATION RULES:
  Path segment contains vendor_id → extract, verify JWT sub matches vendor_id
  /v1/vendors/{vendor_id}/products → only that vendor can create products here
  ALB + Lambda Authorizer: if URL matches /v1/vendors/{vendor_id}/*,
    check JWT claim "vendor_id" == URL vendor_id, else 403

URL STRUCTURE → SERVICE ROUTING:
  ALB Listener Rules (priority order):
    1. Path /v1/orders/* AND method POST/GET/PATCH → Order Service TG
    2. Path /v1/vendors/*/products/* → Product Service TG
    3. Path /v1/products/* → Product Service TG
    4. Path /v1/vendors/* → Vendor Service TG
```

---

## SECTION 6 — Production Scenarios: Real Companies' Naming Patterns

### GitHub REST API (Gold Standard for Resource Naming)

```
GitHub API v3 → consistent resource naming since 2011.

Resource hierarchy:
  /repos/{owner}/{repo}                    ← owner + repo = resource identity
  /repos/{owner}/{repo}/commits            ← nested collection
  /repos/{owner}/{repo}/commits/{sha}      ← specific commit
  /repos/{owner}/{repo}/pulls              ← pull requests (not "pullRequests")
  /repos/{owner}/{repo}/pulls/{number}     ← specific PR
  /repos/{owner}/{repo}/issues             ← issues
  /repos/{owner}/{repo}/branches           ← branches
  /repos/{owner}/{repo}/releases           ← releases

Actions (non-CRUD operations):
  PUT  /repos/{owner}/{repo}/collaborators/{username}  ← add collaborator
  DELETE /repos/{owner}/{repo}/collaborators/{username} ← remove collaborator
  POST /repos/{owner}/{repo}/forks         ← trigger a fork (action, not CRUD)
  PUT  /user/starred/{owner}/{repo}        ← star a repo (toggle via PUT/DELETE)
  GET  /repos/{owner}/{repo}/stargazers    ← who starred (noun for the relationship)

ID design:
  Repository: /repos/microsoft/vscode  ← slug-based (owner/repo combo is the ID)
  Commit: SHA-based (globally unique)
  Issues: /issues/123 ← sequential within repo OK (not globally guessable)

What GitHub does right:
  1. Plural nouns throughout
  2. Hierarchical nesting reflects ownership
  3. Actions use appropriate HTTP method on the resource (PUT to star, not POST /star)
  4. No verbs in paths
  5. Consistent naming: "pulls" not "pull_requests" everywhere
```

### Stripe REST API (Gold Standard for Financial APIs)

```
Stripe's naming philosophy: prefixed IDs + clear resource names

Resource naming:
  /v1/customers/{cus_id}
  /v1/customers/{cus_id}/sources          ← payment methods
  /v1/customers/{cus_id}/subscriptions    ← subscriptions for customer
  /v1/charges/{ch_id}                     ← individual charges
  /v1/payment_intents/{pi_id}             ← new payment flow
  /v1/invoices/{inv_id}
  /v1/invoices/{inv_id}/pay               ← action sub-resource (pay an invoice)
  /v1/invoices/{inv_id}/lines             ← line items

Prefixed ID system:
  cus_K6W5JLLtkzPJ9E84    ← customer
  ch_3MqN8mKqDPRHc        ← charge
  pi_3MqRGmKqDPRHc        ← payment intent
  sub_HTRbkXqBzwBMlI      ← subscription
  in_1LkpBe              ← invoice

Why prefixed IDs matter:
  1. A developer looking at a log sees "pi_3Mq..." and immediately knows it's a PaymentIntent
  2. If wrong ID type is passed to wrong endpoint:
     GET /v1/customers/ch_3MqN8m  → 400 "resource_not_found: expected customer ID, got charge ID"
     vs: GET /v1/customers/123    → 404 or 200 wrong object (silent bug)
  3. No crossover bugs: customer IDs can't be used as charge IDs accidentally

Stripe's action resources:
  POST /v1/invoices/{id}/pay           ← pay an invoice
  POST /v1/invoices/{id}/send          ← email the invoice
  POST /v1/invoices/{id}/void          ← void it
  POST /v1/invoices/{id}/mark_uncollectible  ← business state
  POST /v1/charges/{id}/refunds        ← create a refund (refund is a sub-resource)

  Pattern: POST to action = trigger, POST to noun = create
```

### Slack REST API (Inconsistency Warning)

```
Slack's older API (pre-2018): violated resource naming conventions.

Bad examples from Slack API v1:
  POST /api/channels.create           ← verb in URL!
  POST /api/channels.invite           ← verb again
  POST /api/channels.archive          ← and again
  GET  /api/channels.list             ← NOT /channels
  GET  /api/users.info                ← NOT /users/{id}
  POST /api/chat.postMessage          ← camelCase + verb

Consequence:
  - Can't cache any responses (no noun-based URLs for CDN)
  - Every new operation = new URL (50+ message-related URLs)
  - Can't predict API from patterns (must memorize every endpoint)
  - Broke REST conventions → had to build their own documentation tooling because
    standard OpenAPI tooling couldn't represent their RPC-style URLs well

Slack's new API (2020 onwards) fixed this:
  GET  /conversations.history    → not /messages (but they kept backward compat)
  They acknowledge this is a mistake they can't fully fix due to backward compat constraints.

Lesson: Wrong naming decisions made early = permanent technical debt you can never pay off
        because breaking public API contracts destroys integrations.
```

---

## SECTION 7 — Scaling & Reliability Implications of Resource Naming

### 1. Cache Key Design

HTTP caches (CDN, browser, proxy) use the URL as the cache key. Your resource naming design IS your caching architecture.

```
SCENARIO: Product catalog with 10 million products, 50M reads/day, 99% are GETs

Good resource naming enables tiered caching:

CDN layer (CloudFront):
  GET /v1/products/PRD-abc123
  Cache-Control: public, max-age=300, s-maxage=300, stale-while-revalidate=60

  Cache key: "GET /v1/products/PRD-abc123"
  CDN hit ratio: 85% (most product reads are cache hits)

  If URL was: GET /v1/getProduct?id=PRD-abc123
  Cache key includes query string: inconsistent caching behavior across CDNs
  CloudFront: caches if ForwardQueryStrings=false (strips query → same cache key!)
  → DANGEROUS: /getProduct?id=abc and /getProduct?id=xyz → same cache key → wrong product served!

Application layer cache (Redis):
  Cache key pattern: "product:{product_id}:v1"   ← namespace + resource ID + version
  On PATCH /products/{id}: DEL "product:{id}:*"   ← invalidate all versions of this product
  On GET /products/{id}: GET "product:{id}:v1" || fetch DB → SET "product:{id}:v1" EX 300

  Clean nouns → clean cache keys → predictable invalidation
  Verbs in URLs → "what is the cache key for /getProduct vs /fetchProduct?"

QUERY PARAM ORDERING PROBLEM:
  GET /products?category=electronics&sort=price    ← one cache key
  GET /products?sort=price&category=electronics    ← DIFFERENT cache key, same data

  Fix: normalize query params alphabetically at API Gateway level
  AWS CloudFront: cache key policy → include query strings, alphabetically sorted
  Without this: 2× cache misses for the same data
```

### 2. Authorization and Namespace Isolation

```
Multi-tenant systems: resource naming drives security boundaries

Path-based authorization (extract tenant from URL):
  /v1/vendors/{vendor_id}/products/**

  Lambda Authorizer:
    1. Extract vendor_id from URL path
    2. Extract JWT claim vendor_id
    3. If they don't match: 403 Forbidden
    4. If they match: allow + set vendorId context

vs Flat naming (/v1/products/**) with body params for vendor_id:
    Risk: client could pass any vendor_id in POST body
    Body params are not reliably extractable by Lambda Authorizer (body parsing in authorizer is complex and error-prone)
    URL path params are reliable for authorization gates

Security principle: authorization-relevant identifiers belong in the URL path (reliably extractable),
not in request headers or body (requires parsing, less reliable for gateway-level enforcement).
```

### 3. API Gateway Routing Complexity

```
Path-based routing performance:

API Gateway evaluates routes in order. Too many unstructured routes = O(n) route matching.
Structured resource naming enables prefix-based routing (O(1) routing via ALB target groups).

UNSTRUCTURED (RPC-style, 50 endpoints):
  API GW Resources:
    /getUser
    /createUser
    /deleteUser
    /getUserOrders
    /cancelOrder
    /getProduct
    ... (50 more)
  Routing: each request scans all 50 rules → slow + hard to maintain

STRUCTURED (resource-based, 8 prefix rules cover 50 operations):
  ALB Listener Rules:
    /v1/users/*   → User Service
    /v1/orders/*  → Order Service
    /v1/products/* → Product Service
  Routing: 3 rules, instant match by prefix → simpler, faster, cleaner

Impact at 100K req/sec:
  Route matching savings: ~0.1ms × 100,000 = 10 seconds of compute/second saved
  (Small per request, significant aggregate)
```

### 4. Logging, Tracing, and Debugging

```
Resource naming makes logs queryable and meaningful:

STRUCTURED URL in access log:
  {
    "method": "GET",
    "path": "/v1/orders/ORD-9821",
    "resource_type": "order",       ← extracted from /v1/{resource_type}/...
    "resource_id": "ORD-9821",      ← extracted from URL
    "status_code": 200,
    "latency_ms": 45
  }

Query: "Show all operations on order ORD-9821"
  WHERE path LIKE '/v1/orders/ORD-9821%'
  → Instant: all GET, PATCH, POST .../cancel for this order ID

Query: "Show all creation events (POST to collections) in the last hour"
  WHERE method='POST' AND path REGEXP '/v1/[^/]+$'  ← POST to collection = create
  → Instant event stream of all resource creations

RPC-STYLE URL in access log:
  { "path": "/createOrder", "method": "POST" }
  { "path": "/cancelOrder?id=ORD-9821", "method": "GET" }

Query: "Show all operations on order ORD-9821"
  → Must know: createOrder, cancelOrder, updateOrderStatus, markOrderShipped, etc.
  → Requires knowing all possible operation names and checking each
  → Error-prone: what if a new URL was added? Your query misses it.
```

---

## SECTION 8 — AWS Mapping: Resource Naming in Practice

### API Gateway: Path Hierarchies to Services

```
AWS API Gateway resource tree (mirrors your REST resource hierarchy):

API: ShopWave API v1
  Resource: /v1
    Resource: /products                          ← collection
      Method: GET → Lambda:ListProducts
      Method: POST → Lambda:CreateProduct (admin)
      Resource: /{product_id}                   ← individual resource
        Method: GET → Lambda:GetProduct
        Method: PATCH → Lambda:UpdateProduct
        Method: DELETE → Lambda:DeleteProduct
        Resource: /reviews                       ← nested collection
          Method: GET → Lambda:ListReviews
          Method: POST → Lambda:CreateReview

    Resource: /users
      Resource: /{user_id}
        Resource: /orders                        ← user's orders (alternative path)
          Method: GET → Lambda:ListUserOrders

    Resource: /orders                            ← top-level orders
      Method: GET → Lambda:ListOrders
      Method: POST → Lambda:CreateOrder
      Resource: /{order_id}
        Method: GET → Lambda:GetOrder
        Resource: /cancel                        ← action sub-resource
          Method: POST → Lambda:CancelOrder

Pro tip: Mirror your REST resource tree in API GW's resource structure.
API GW path hierarchy IS your resource naming architecture in infrastructure code.
```

### DynamoDB: Resource IDs as Partition Keys

```
Resource naming → DynamoDB table design:

Table: Products
  Partition key: product_id (UUID string)
  Sort key: none (single-entity table)

  Access patterns:
    GET /products/{product_id}          → GetItem(PK="PRD-f47ac10b")
    GET /vendors/{v_id}/products        → GSI on vendor_id
    DELETE /products/{product_id}       → DeleteItem(PK="PRD-f47ac10b")
    PATCH /products/{product_id}        → UpdateItem(PK="PRD-f47ac10b", ...)

  GSI (Global Secondary Index) for vendor's products:
    GSI partition key: vendor_id
    GET /vendors/VND-abc123/products    → Query(GSI, vendor_id="VND-abc123")

Table: Orders
  Partition key: order_id (UUID)
  GSI: user_id (for GET /orders → user's orders)

  Items:
    { order_id: "ORD-9821", user_id: "USR-xx", status: "confirmed", ... }

  Access patterns:
    GET /orders/{order_id}              → GetItem(PK="ORD-9821")
    GET /orders (user scope from JWT)   → Query(GSI, user_id="USR-xx")

The resource_id IS the DynamoDB partition key.
Random UUIDs = even DynamoDB partition distribution (no hot partitions).
Sequential IDs = today's IDs all land on same partition = hot partition = throttling.
```

### CloudFront: Cache Behaviors by Resource Path

```
CloudFront Distribution behaviors for ShopWave:

Behavior 1: /v1/products* (public, cacheable)
  Path pattern: /v1/products*
  Cache policy: CachingOptimized
  TTL: 300 seconds (default), min 60, max 86400
  Query strings: Include (for ?q=search&category=electronics, cache per query)
  Headers: None forwarded to origin
  Query string normalization: Yes (sort alphabetically)

Behavior 2: /v1/products/*/reviews* (shorter TTL, user-generated content)
  Path pattern: /v1/products/*/reviews*
  Cache policy: Custom
  TTL: 60 seconds

Behavior 3: /v1/orders* (private, no cache)
  Path pattern: /v1/orders*
  Cache policy: CachingDisabled
  Headers forward: Authorization (cache varies per user)

Behavior 4: /v1/vendors* (authenticated write operations)
  Path pattern: /v1/vendors*
  Cache policy: CachingDisabled
  Headers forward: Authorization

Default: /* (catch-all, cached moderately)

The resource naming convention (/v1/{resource-type}/**) makes
CloudFront behavior assignment by path prefix trivial.
A single path pattern catches all operations on that resource type.
```

### Route 53 + API Gateway: Custom Domain Resource Routing

```
Custom domain: api.shopwave.com

Route 53 → CloudFront → API Gateway

URL structure enables subdomain routing by API version:
  api.shopwave.com/v1/**   → API GW Stage: prod-v1
  api.shopwave.com/v2/**   → API GW Stage: prod-v2 (new version)

CDK/Terraform: resource naming = infrastructure as code parameters
  # All products endpoints share one cache policy rule
  const productsCache = new CachePolicy(this, 'ProductsCache', {
    cachePolicyName: 'ShopwaveProductsCache',
    defaultTtl: Duration.seconds(300),
    // Resource name in URL = cache policy name convention
    // /v1/products → ProductsCache
    // /v1/orders → no cache (different behavior)
  });

Consistent resource naming = consistent infrastructure policy application.
Random URLs = manual exception list for every infrastructure rule.
```
