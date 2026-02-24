# Resource Naming — Part 1 of 3

### Sections: 1 (Intuition), 2 (Why It Exists), 3 (Core Technical Deep Dive), 4 (Real-World API Contract & Request Flow)

**Series:** Backend & API Design → REST APIs → System Design
**Topic:** Resource Naming — how URIs communicate meaning, structure, and contract to every client forever

---

## SECTION 1 — Intuition: Build the Mental Model First

### Analogy 1: The Library Filing System

Walk into any library on the planet. The shelves are organized: **Fiction → Author Last Name → Title**. Not "Fiction → GetBookById → Hemingway → FetchTitle". The shelf _location_ describes **what is there**, not _what operation you're performing_.

REST URIs are your library shelves. They name **resources** (nouns) — the things that exist in your system. The operation you perform on them (read, create, update, delete) is expressed by the HTTP method, not the URL.

```
Bad library:
  Fiction shelf > "GetHemingwayBook" > "DeleteHemingwayBook"
  (The shelf name changes every time you want to do something different)

Good library:
  /books/hemingway-sun-also-rises     ← the shelf location (resource)
  GET  that shelf → you're reading    ← operation via HTTP method
  POST to the shelf → you're adding   ← operation via HTTP method
  DELETE from shelf → you're removing ← operation via HTTP method
```

The shelf doesn't know (or care) what you do to it. The shelf just **names a location**.

### Analogy 2: The Physical Address System

**"123 Baker Street, London"** — this is a noun that identifies a physical location. It doesn't say "Go To 123 Baker Street" or "Deliver Package To 123 Baker Street". The address just names the **thing**. What you _do_ at that address is a separate concern.

Your API resource path is the address. HTTP method is what you're doing there.

```
Address:  /api/v1/orders/ORD-9821         ← just identifies the resource
GET       /api/v1/orders/ORD-9821         ← retrieve this order
DELETE    /api/v1/orders/ORD-9821         ← cancel this order
PATCH     /api/v1/orders/ORD-9821         ← update this order
```

Change the address and clients break. Change the HTTP method and only that operation changes. **Stability of the noun = stability of the API contract.**

### Analogy 3: Grammar Lesson — Nouns vs Verbs

In English grammar, a noun is a person, place, or thing. A verb is an action.

```
Good sentence: "I deleted the order."
  → Noun: order (/orders/123)
  → Verb: deleted (HTTP DELETE)

Bad sentence: "I deleteOrdered."
  → Noun-verb mashup: /deleteOrder/123
  → HTTP method forced to: GET (because it's all in the URL anyway)
```

REST APIs that put verbs in URLs are like writing "I goShopped the market-buy-apples" — it creates a new word for every operation, and the grammar has no rules.

---

## SECTION 2 — Why It Exists: The Problem History

### The Pre-REST World: RPC-Style URLs

Before REST conventions became widespread (early 2000s), APIs were designed as **Remote Procedure Call (RPC)** endpoints. Every operation got its own URL:

```
# Real examples from pre-REST SOAP APIs and custom HTTP APIs (pre-2005)
/getUserByEmail?email=john@company.com
/createNewUser
/updateUserProfile
/deleteUserById?id=123
/getUserOrders
/cancelOrder?orderId=456
/getOrderItems?orderId=456
/markOrderAsShipped
/getShippedOrders
/searchProductsByCategory
/getProductDetails?productId=789
/addProductToCart
/removeProductFromCart
/getCartItems
/checkoutCart
```

**The problems this created:**

#### 1. Namespace explodes as features grow

A new junior developer joins. They need to add "suspend user" functionality. Without a naming convention, they add:

```
/suspendUser?userId=123         # joins the API
```

Six months later, another dev adds:

```
/deactivateAccount?userId=123   # same operation, different URL
/disableUser?userId=123         # yet another
```

Now you have three endpoints that do vaguely the same thing. No one knows which to call. Clients use all three. You can't deprecate any because some client is always using it.

#### 2. HTTP caching stops working

CDNs cache responses based on URL. When your URL is `/getProduct?id=123` (with a verb), every HTTP cache in the chain gets confused: "Is this GET-only? Can I cache this? Will a future request to this URL return different data?"

With noun-based URLs:

- `GET /products/123` → CDN knows: "This is a read; cache it"
- `DELETE /products/123` → CDN knows: "This modifies state; don't cache"

The HTTP method is the signal. Verbs in URLs break the signal.

#### 3. Security surface area explodes

Every RPC-style URL is an independent endpoint security engineers must audit. With **resource-based URLs + standard HTTP methods**, you have O(resources × 5 methods) endpoints in a well-defined pattern. With RPC-style, you have O(number of operations) and every new developer adds more.

#### 4. No discoverability

A new developer joining your team needs to learn 200 bespoke URLs. With REST resource naming, they learn: "We have these resources: users, orders, products, payments. GET = read, POST = create, PUT = replace, PATCH = update, DELETE = remove. Apply that to any resource." They can **predict** the API.

### The Roy Fielding PhD (2000) Impact

Roy Fielding's 2000 dissertation: "Resources are the key abstraction of information in REST. Any concept that might be the target of a hypertext reference must fit within the definition of a resource."

The key insight: **identify the resource (thing), not the operation (action)**. This made HTTP semantics meaningful instead of ceremonial.

### Twitter's Public API Lesson (2012)

Twitter's original API had inconsistent naming — a mix of verb-based and noun-based endpoints:

```
/1/statuses/update       (verb)
/1/direct_messages/new   (verb)
/1/users/show            (verb)
/1/friendships/create    (verb)
/1/statuses/home_timeline (noun-ish)
```

When they rewrote to v2 (2020), they introduced strict resource naming:

```
/2/tweets          (plural noun)
/2/users/{id}      (singular with ID)
/2/users/{id}/tweets  (nested collection)
```

Migration cost: years of documentation rewrite + breaking every integration. The lesson: **get naming right before first public release**.

---

## SECTION 3 — Core Technical Deep Dive

### Rule 1: Use Nouns, Not Verbs

The HTTP method is the verb. The URL is the noun.

```
# BAD — verbs in URLs
GET  /getUsers
POST /createUser
GET  /fetchUserOrders
POST /deleteUser          ← GET + DELETE on POST?!
GET  /searchProducts?q=shoes

# GOOD — nouns in URLs
GET    /users             ← list all users
POST   /users             ← create a user
GET    /users/123         ← get user 123
DELETE /users/123         ← delete user 123
GET    /products?q=shoes  ← search is a query param on the collection
```

**Exception — Actions that don't map to CRUD:**
Some real-world operations don't fit neatly into resource CRUD. Handle them with sub-resource verbs (sparingly):

```
# Acceptable action sub-resources
POST /orders/123/cancel        ← triggering state change (cancel is the action)
POST /users/123/activate       ← state transition
POST /payments/123/refund      ← financial operation
POST /emails/123/send          ← side-effect operation

# Why this is OK:
# The parent resource (/orders/123) is still a noun.
# The sub-resource (/cancel) is an operation on it — like pressing a button.
# Alternative: PATCH /orders/123 {status: "cancelled"} — but "cancel" is safer
# because it can have richer validation logic beyond just setting a field.
```

### Rule 2: Use Plural Nouns for Collections

```
# WRONG (singular creates inconsistency)
GET /user          # is this THE user or ALL users?
GET /user/123      # inconsistent with collection

# RIGHT (plural, always consistent)
GET /users         # collection
GET /users/123     # specific resource in collection

# Consistency matters more than the noun form:
GET /companies/456/employees    # employees in company 456
GET /companies/456/employees/789  # specific employee

# Industry standard: plural wins universally
/orders      /users      /products      /payments
/reviews     /comments   /notifications /invoices
```

### Rule 3: Use Hierarchical Nesting for Relationships (But Only 2 Levels Deep)

```
# One level deep
GET /users/123/orders              # all orders for user 123
GET /users/123/orders/ORD-456      # specific order belonging to user 123
GET /products/789/reviews          # all reviews for product 789

# Two levels deep (maximum practical)
GET /users/123/orders/ORD-456/items      # items in a specific order

# TOO DEEP — URL becomes unmanageable
GET /users/123/companies/456/departments/789/employees/321/addresses
#   ↑ breaks bookmarking, logging, debugging, documentation

# Fix deep nesting: use query params or flatten
GET /addresses?employeeId=321        # flat with filter
GET /employees/321/addresses         # kept at 2 levels from the relevant root
```

**Nesting rule of thumb:** Only nest when a resource's existence is meaningless without its parent. An `order item` without an `order` doesn't make sense. A `user` without a `company` can exist independently — don't nest them.

### Rule 4: Use Lowercase with Hyphens (kebab-case)

```
# BAD — inconsistent, ambiguous
/userOrders         # camelCase — URL case sensitivity issues on Linux
/user_orders        # snake_case — uncommon in URLs
/UserOrders         # PascalCase — wrong convention
/USERORDERS         # UPPERCASE — shouting

# GOOD — lowercase with hyphens (RFC 3986 recommendation)
/user-orders        # if you must combine words in a segment
/order-items        # hyphen-separated for compound resource names

# Better — avoid compound names by restructuring
/users/{id}/orders  # compound word avoided via hierarchy
/orders/{id}/items  # cleaner, more discoverable
```

**Why hyphens over underscores:**
Search engines and some log systems treat underscores as word-joining but hyphens as word-separating. More importantly: RFC 3986 shows hyphens as the standard path separator in compound terms. Stripe, GitHub, AWS all use hyphens.

### Rule 5: Use Meaningful, Consistent IDs

```
# DANGEROUS — sequential integers
GET /users/1
GET /users/2
GET /users/3
# ← Enumeration attack: attacker iterates all IDs, scrapes all users
# ← Leaks business data: "we have X users"
# ← No shard/partition awareness

# GOOD — UUIDs (v4 random)
GET /users/f47ac10b-58cc-4372-a567-0e02b2c3d479
# ← Not guessable
# ← No order information leaked
# ← Safe across distributed systems (no collision on merge)

# ALSO GOOD — prefixed IDs (Stripe's approach)
GET /customers/cus_K6W5JLLtkzPJ9E84
GET /payments/pay_3MqN8mKqDPRHc
# ← Type information in ID (can't accidentally use a customer ID as a payment ID)
# ← Globally unique
# ← Developer-friendly debugging ("this is obviously a customer")

# For B2B/internal APIs — slug-based (slug = human-readable identifier)
GET /companies/acme-corp
GET /products/macbook-pro-14-m3
# ← Human-readable URLs for display
# ← SEO-friendly
# ← Must enforce uniqueness constraint in DB
```

### Rule 6: Versioning Lives in the URL Root

```
# Version in URL (most common for public APIs)
/v1/users/123        ← v1 is frozen when published
/v2/users/123        ← v2 can introduce breaking changes

# NOT in the middle of the path
/users/v2/123        ← confusing, inconsistent
/users/123/v2        ← wrong — this implies version is a sub-resource
```

### Rule 7: Query Parameters for Non-Identifying Attributes

```
# Path param = identifies a specific resource (part of its identity)
GET /users/123              ← 123 is the resource identity

# Query param = filters/modifies the response (not part of identity)
GET /users?role=admin       ← filter the collection
GET /users?sort=name&order=asc   ← sort parameters
GET /users?page=2&limit=20       ← pagination
GET /products?category=electronics&minPrice=100  ← filtering
```

### Complete Resource Naming Reference Table

| Scenario          | Anti-Pattern (Don't)                       | Canonical Pattern (Do)            |
| ----------------- | ------------------------------------------ | --------------------------------- |
| List all users    | `GET /getUsers`                            | `GET /users`                      |
| Create a user     | `POST /createUser`                         | `POST /users`                     |
| Get specific user | `GET /getUser?id=123`                      | `GET /users/123`                  |
| Update a user     | `POST /updateUser/123`                     | `PATCH /users/123`                |
| Delete a user     | `GET /deleteUser?id=123`                   | `DELETE /users/123`               |
| User's orders     | `GET /getUserOrders?userId=123`            | `GET /users/123/orders`           |
| Specific order    | `GET /getOrder?userId=123&orderId=ORD-456` | `GET /users/123/orders/ORD-456`   |
| Cancel an order   | `POST /cancelOrder?id=ORD-456`             | `POST /orders/ORD-456/cancel`     |
| Search products   | `GET /searchProducts?q=shoes`              | `GET /products?q=shoes`           |
| Nested too deep   | `GET /users/1/orders/2/items/3/meta/4`     | `GET /order-items/3?include=meta` |
| Activate account  | `POST /activateUser?id=123`                | `POST /users/123/activate`        |
| Send email        | `GET /sendEmail?to=a@b.com`                | `POST /emails` (with body)        |

---

## SECTION 4 — Real-World API Contract: E-Commerce Platform Resource Design

### Scenario

You're designing the REST API for ShopWave, a multi-vendor e-commerce platform. You need to define resources for: Vendors, Products, Orders, Reviews, Inventory, and Promotions.

### Full Resource Map

```
Base URL: https://api.shopwave.com/v1

VENDORS (top-level resource)
  GET    /vendors                       List all vendors (paginated)
  POST   /vendors                       Create a vendor account
  GET    /vendors/{vendor_id}           Get vendor profile
  PATCH  /vendors/{vendor_id}           Update vendor profile
  DELETE /vendors/{vendor_id}           Deactivate vendor

PRODUCTS (vendor's products)
  GET    /vendors/{vendor_id}/products        All products by vendor
  POST   /vendors/{vendor_id}/products        Create product for vendor
  GET    /vendors/{vendor_id}/products/{product_id}  Get specific product
  PUT    /vendors/{vendor_id}/products/{product_id}  Replace product listing
  PATCH  /vendors/{vendor_id}/products/{product_id}  Update product fields
  DELETE /vendors/{vendor_id}/products/{product_id}  Remove product

  # Global product discovery (without vendor context)
  GET    /products                      All products across all vendors
  GET    /products/{product_id}         Product by ID (resolves to vendor's product)

INVENTORY (product inventory)
  GET    /vendors/{vendor_id}/products/{product_id}/inventory  Current stock
  PUT    /vendors/{vendor_id}/products/{product_id}/inventory  Set inventory level
  POST   /vendors/{vendor_id}/products/{product_id}/inventory/adjustments
          Body: { "quantity": -5, "reason": "sale", "reference": "ORD-12345" }

REVIEWS (customer reviews on products)
  GET    /products/{product_id}/reviews           All reviews for a product
  POST   /products/{product_id}/reviews           Create a review
  GET    /products/{product_id}/reviews/{review_id}  Get specific review
  PATCH  /products/{product_id}/reviews/{review_id}  Update review (own review)
  DELETE /products/{product_id}/reviews/{review_id}  Delete review (own/admin)

ORDERS (customer orders — NOT nested under user; orders are first-class)
  POST   /orders                        Place an order (Idempotency-Key required!)
  GET    /orders                        Get caller's orders (JWT identifies user)
  GET    /orders/{order_id}             Get specific order
  POST   /orders/{order_id}/cancel      Cancel an order (state transition)
  GET    /orders/{order_id}/items       Order line items
  GET    /orders/{order_id}/timeline    Order status history events

PROMOTIONS
  GET    /promotions                    Active promotions
  POST   /promotions                    Create promotion (admin)
  GET    /promotions/{promo_id}         Get promotion details
  POST   /promotions/{promo_id}/apply   Apply promo to cart/order
  POST   /promotions/{promo_id}/deactivate  Deactivate promotion
```

### Design Decisions Explained

```
Decision 1: Why are Orders NOT nested under /users/{id}/orders?

Option A: GET /users/123/orders         ← nested
Option B: GET /orders                   ← flat with JWT auth

Chosen: Option B (flat + JWT)

Why:
  - An order exists independently. It can be partially owned by multiple users (gifting)
    or transferred. Nesting couples order identity to user identity permanently.
  - JWT already identifies the requesting user. GET /orders returns THEIR orders.
    No need to put userId in URL (it's in the token).
  - Admin use case: GET /orders?userId=123 — admin views any user's orders via filter,
    not by URL nesting. Clean separation: your orders vs viewing orders.
  - Order ID is globally unique. A customer support link directly to
    /orders/ORD-12345 without requiring knowledge of which user placed it.

Decision 2: Why is Inventory a sub-resource of Products?

GET /vendors/{vendor_id}/products/{product_id}/inventory

Because:
  - Inventory is meaningless without the product it belongs to
  - Each SKU has exactly one inventory record (1:1)
  - Inventory cannot exist in isolation — it IS a property of the product listing
  - This is 2 levels deep (vendor → product → inventory), acceptable for this relationship

Decision 3: Why does /products exist globally AND under /vendors?

  - /vendors/{id}/products → vendor-management operations (create, update, delete products)
    Only the vendor (or admin) uses these.
  - /products → customer-facing discovery (browse all products, search)
    Customers don't care which vendor owns a product when browsing.
  - The product_id is the same object, just accessed via different paths.
    Both paths are valid. The response is the same object.

  This pattern is called "aliased resources" — multiple paths to the same resource.
  Backend resolves to the same service/record.

Decision 4: POST /orders/{id}/cancel vs PATCH /orders/{id} {status: "cancelled"}

Both are defensible. Chosen: POST /orders/{id}/cancel because:
  - Cancel is a business operation, not just a field update
  - Cancel may trigger: refund + inventory release + notification + analytics event
  - Using POST signals "this has side effects beyond setting a field"
  - PATCH is better for "update this field's value"; POST/sub-resource is better for
    "trigger this business process"
  - Idempotency: cancelling an already-cancelled order = 200 (no error, no side-effect repeat)
```

### Request/Response Examples

```http
# Create a product
POST /v1/vendors/VND-abc123/products
Authorization: Bearer eyJhbGci...
Content-Type: application/json
Idempotency-Key: 7f3d8a2e-1b4c-4f9a-8e6d-2c5a9b7e3f1d

{
  "name": "Wireless Noise-Cancelling Headphones",
  "sku": "WNC-HP-001",
  "description": "Premium over-ear headphones with 30-hour battery",
  "price": {
    "amount": 29999,
    "currency": "USD"
  },
  "category": "electronics/audio",
  "tags": ["wireless", "noise-cancelling", "premium"]
}

HTTP/1.1 201 Created
Location: /v1/vendors/VND-abc123/products/PRD-f47ac10b
Content-Type: application/json

{
  "product_id": "PRD-f47ac10b",
  "vendor_id": "VND-abc123",
  "name": "Wireless Noise-Cancelling Headphones",
  "sku": "WNC-HP-001",
  "status": "draft",
  "price": { "amount": 29999, "currency": "USD" },
  "created_at": "2026-02-23T10:15:00Z",
  "_links": {
    "self": "/v1/vendors/VND-abc123/products/PRD-f47ac10b",
    "inventory": "/v1/vendors/VND-abc123/products/PRD-f47ac10b/inventory",
    "reviews": "/v1/products/PRD-f47ac10b/reviews",
    "vendor": "/v1/vendors/VND-abc123"
  }
}
```

```http
# Cancel an order
POST /v1/orders/ORD-9821/cancel
Authorization: Bearer eyJhbGci...
Content-Type: application/json

{
  "reason": "customer_request",
  "note": "Customer changed their mind before shipping"
}

HTTP/1.1 200 OK
Content-Type: application/json

{
  "order_id": "ORD-9821",
  "status": "cancelled",
  "cancelled_at": "2026-02-23T10:22:00Z",
  "cancellation": {
    "reason": "customer_request",
    "initiated_by": "customer",
    "refund": {
      "status": "processing",
      "amount": 29999,
      "refund_id": "REF-7f3d8a2e",
      "expected_by": "2026-02-28"
    }
  },
  "_links": {
    "self": "/v1/orders/ORD-9821",
    "refund": "/v1/payments/REF-7f3d8a2e"
  }
}
```

### Naming Consistency Checklist (Print Before Every API Review)

```
Before shipping any REST endpoint, verify:

☐ URL contains only nouns (no getX, createX, deleteX, fetchX verbs)
☐ Collections are plural (/orders not /order)
☐ Resource IDs are non-sequential (UUID, prefixed ID, or slug)
☐ Nesting depth ≤ 2 levels (exception: last segment is action sub-resource)
☐ Lowercase with hyphens only (no camelCase, underscores, uppercase)
☐ HTTP method carries the verb (GET read, POST create, PUT replace, PATCH update, DELETE remove)
☐ State transitions use POST to action sub-resource (/orders/123/cancel)
☐ Collection searches use query params (/products?category=electronics)
☐ Version number in URL root (/v1/...)
☐ Response includes _links for related resources (HATEOAS)
☐ Error response matches standard format (see Standard Error Responses topic)
```
