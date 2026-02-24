# Layered Architecture — Part 1 of 3

### Sections: 1 (Real-World Analogy), 2 (Problem Solved), 3 (Component Responsibilities), 4 (ASCII Diagrams)

**Series:** System Design & Architecture → Topic 02

---

## SECTION 1 — Real-World Analogy

### A Restaurant Kitchen

Walk into any large restaurant. There are strict, invisible walls between three worlds — and the system only works because those walls exist.

```
CUSTOMER (the client)
  │  orders food, receives food, never enters the kitchen
  │  communicates only via the WAITER
  ▼
WAITER (Presentation Layer)
  │  takes orders, presents dishes, handles complaints
  │  knows what to show the customer
  │  does NOT know how to cook — has no idea what happens in the kitchen
  │  communicates only via kitchen orders (TICKETS)
  ▼
CHEF / KITCHEN (Business Logic Layer)
  │  decides HOW the dish is made: the recipe, the sequence, the timing
  │  does NOT stock the pantry and does NOT talk to the customer directly
  │  communicates only via the pantry request system
  ▼
PANTRY / SUPPLIER (Data Access Layer)
    stores raw ingredients (data)
    responds to requests: "give me 200g tomatoes", "store these leftovers"
    does NOT decide what dish to cook
    does NOT interact with the customer
```

**The layering rule:** Each layer speaks only to the layer directly below it. A waiter never walks into the pantry. The pantry never speaks to the customer.

**What happens when layers blur:**

- Waiter starts cooking → customers wait while waiters make decisions they're not trained for
- Chef starts talking directly to customers → 40 chefs, 40 versions of "this dish is almost ready"
- Pantry starts deciding the menu → the restaurant now serves "whatever we have too much of"

**This is exactly what happens to codebases that don't enforce layer boundaries.**

---

### Another Analogy: A Bank

```
TELLER (Presentation)
  Accepts deposit requests. Verifies identity. Prints receipts.
  Does NOT know how the money is invested or recorded in ledgers.

BANK OFFICER (Business Logic)
  Decides: is this transaction allowed? Are fraud rules satisfied?
  Applies business rules: withdrawal limits, interest calculations, compliance checks.
  Does NOT know what database stores the account balances.

LEDGER SYSTEM (Data Access)
  Records transactions. Retrieves account balances.
  Does NOT know why the transaction is happening.
  Does NOT interact with customers.
```

When a customer requests a $10,000 withdrawal:

1. Teller receives → validates identity → passes to Officer
2. Officer: checks balance, checks daily limit, checks fraud flags → approves or denies
3. Ledger: records the debit, returns new balance to Officer
4. Officer returns result to Teller
5. Teller prints receipt, hands cash over

Each layer has exactly one job. Each layer can be changed independently.

---

## SECTION 2 — Problem Solved by Layered Architecture

### The Problem: Spaghetti Code at Scale

Without layering, a 2-year-old web application looks like this:

```php
// REAL production code pattern from un-layered systems
// This is ONE "controller" file. This is a 400-line function.
function handleCheckout($request) {
    // Validation mixed with business logic
    if (empty($request->email)) return error("email required");

    // Direct database query in the controller
    $user = mysqli_query($conn, "SELECT * FROM users WHERE email='{$request->email}'");

    // Business rule: is the user eligible for a discount?
    // (This is now locked inside this one function. Cannot be reused.)
    $discount = 0;
    if ($user['total_orders'] > 10) $discount = 0.1;

    // Stripe call directly in the controller
    $charge = \Stripe\Charge::create(['amount' => $total * (1 - $discount)]);

    // Sending email directly from controller (3rd responsibility)
    mail($user['email'], "Your order", "Order confirmed");

    // Another direct DB query, mid-function
    mysqli_query($conn, "INSERT INTO orders (user_id, total) VALUES ({$user['id']}, {$total})");

    return success();
}
// Result after 2 years:
// - Cannot test business logic without a real database and a real Stripe account
// - Cannot change the discount logic without finding every function that duplicates it
// - Cannot swap MySQL for PostgreSQL without touching 200 functions
// - Cannot reuse the discount calculation in an admin API
```

---

### What Layered Architecture Solves

**Problem 1: Everything is entangled.**
Layered architecture enforces **separation of concerns**. HTTP handling lives in one place. Business rules live in another. Database queries live in a third. A change to the HTTP framework doesn't require touching business logic.

**Problem 2: Business logic cannot be tested without the full stack.**
In a layered system, the Business Logic Layer depends only on an abstraction of the data layer (an interface). In tests, you replace the real database with a mock. Business logic tests run in milliseconds without a live DB.

**Problem 3: Same business logic is duplicated across the app.**
In a layered system, the BLL is a single canonical source for "how discount is calculated." Every surface (web API, admin API, batch job) calls the same function. Change it once, it changes everywhere.

**Problem 4: You cannot swap infrastructure components.**
With layered architecture and a proper Data Access Layer (DAL), swapping MySQL for PostgreSQL means changing only the DAL. The Business Logic Layer never knew it was talking to MySQL — it only knew about an `IOrderRepository` interface.

---

### When Layered Architecture Is the Right Tool

```
USE IT when:
  ✅ Building a web API or web application (99% of web backends use some form of this)
  ✅ Team size: 2-20 engineers (gets them organized without over-engineering)
  ✅ CRUD-heavy domain (user management, content management, dashboards)
  ✅ You need testable business logic
  ✅ You want to be able to swap database implementations

DO NOT USE strict 4-layer architecture when:
  ❌ Your "business logic" is actually pure data transformation (use pipeline pattern instead)
  ❌ You're building a real-time event-driven system at Netflix scale
  ❌ You're building a CLI tool or a script (overkill)
  ❌ You need extreme performance in hot paths (added indirection = function call overhead)
```

---

## SECTION 3 — Component Responsibilities

### The Four Layers

```
Layer 1: PRESENTATION LAYER (a.k.a. Interface Adapters, Web Layer, API Layer)
─────────────────────────────────────────────────────────────────────────────
OWNS:
  • HTTP request parsing (headers, body, query params)
  • Input validation (is the email field present? is the amount > 0?)
  • Authentication middleware (is this user logged in? extract JWT claims)
  • HTTP response formatting (serialize objects to JSON, set status codes)
  • Route definitions (POST /orders → OrderController.create)
  • Request/Response DTOs (Data Transfer Objects — the shape of HTTP input/output)

DOES NOT OWN:
  • Business rules (discount calculation, fraud detection, order validity)
  • Database queries
  • External service calls (Stripe, SendGrid)
  • Domain entities (the canonical Order object with all its fields)

EXAMPLES: Controllers, Route Handlers, Middleware, GraphQL Resolvers,
          gRPC endpoint handlers, WebSocket message handlers

───────────────────────────────────────────────────────────────────────────

Layer 2: APPLICATION / SERVICE LAYER (a.k.a. Business Logic Layer)
─────────────────────────────────────────────────────────────────────────────
OWNS:
  • Business rules and domain logic
    ("An order cannot be placed if the user has 3 unpaid invoices")
  • Use case orchestration ("to place an order: validate cart → reserve inventory
    → charge payment → create order record → send confirmation")
  • Transaction management (begin/commit/rollback wrapping a use case)
  • Domain events ("OrderPlaced" event published after successful checkout)
  • Domain entities (Order, User, Product — the domain model)

DOES NOT OWN:
  • HTTP concerns (how did the request arrive? JSON? gRPC? CLI?)
  • SQL queries (it talks to a Repository interface, not to a DB)
  • External service SDK specifics (it calls a PaymentGateway interface, not Stripe directly)

EXAMPLES: OrderService, UserService, PaymentService, Domain entities,
          Value objects, Domain event publishers

───────────────────────────────────────────────────────────────────────────

Layer 3: DATA ACCESS LAYER (a.k.a. Infrastructure Layer, Persistence Layer)
─────────────────────────────────────────────────────────────────────────────
OWNS:
  • SQL queries / ORM usage
  • Database connection management
  • Repository implementations (OrderRepository: SQL-backed implementation of IOrderRepository)
  • Mapping between domain objects and database rows (ORM entities or manual mappers)
  • Cache interaction (Redis read/write)
  • External API client implementations (StripeAdapter implements IPaymentGateway)

DOES NOT OWN:
  • Business rules
  • HTTP concerns
  • Domain event logic

EXAMPLES: UserRepository, OrderRepository, StripeAdapter, EmailAdapter,
          Redis cache wrapper, raw SQL query functions

───────────────────────────────────────────────────────────────────────────

Layer 4: DATABASE / EXTERNAL SYSTEMS (not really a "code layer" — the boundary)
─────────────────────────────────────────────────────────────────────────────
  PostgreSQL, MySQL, MongoDB, Redis, Elasticsearch
  Stripe API, SendGrid, Twilio, S3
  The DAL wraps these. The BLL never touches them directly.
```

---

### Strict vs Relaxed Layering

```
STRICT LAYERING:
  Presentation → Business Logic → Data Access → Database
  Each layer may ONLY call the layer directly below it.
  Presentation cannot call Data Access directly (must go through BLL).

  Advantage: Complete isolation. BLL is fully unaware of HTTP or DB.
  Disadvantage: For trivial read operations, you add unnecessary indirection.
                A GET /users/{id} goes through Controller → Service → Repository
                when it could skip the Service entirely.

RELAXED LAYERING (most common in practice):
  Presentation may call any lower layer, but business logic and
  data access are still strictly separated.
  A read-only query endpoint can call the Repository directly from the Controller
  when there is no business logic to apply.

  Advantage: Less boilerplate for simple CRUD.
  Disadvantage: Easy to let business logic creep into controllers over time.

RECOMMENDATION: Start with relaxed. Enforce strictly only when you find yourself
                writing significant logic in a controller (that's the migration signal).
```

---

## SECTION 4 — ASCII Architecture Diagrams

### Standard Layered Web API (Node.js / Express)

```
HTTP REQUEST
    │
    ▼
┌─────────────────────────────────────────────────────────┐
│                 PRESENTATION LAYER                       │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │   Router    │  │  Middleware   │  │  Validators   │  │
│  │             │  │  (auth, cors) │  │  (Joi/Zod)    │  │
│  │ POST /orders│  │               │  │               │  │
│  └──────┬──────┘  └──────────────┘  └───────────────┘  │
│         │                                               │
│  ┌──────▼─────────────────────────────────────────┐    │
│  │              OrderController                    │    │
│  │  • Parses req.body → CreateOrderDTO             │    │
│  │  • Calls orderService.createOrder(dto, userId)  │    │
│  │  • Maps service result → HTTP 201 response      │    │
│  └──────┬──────────────────────────────────────────┘    │
└─────────┼───────────────────────────────────────────────┘
          │  (passes DTO — no DB objects, no HTTP objects)
          ▼
┌─────────────────────────────────────────────────────────┐
│               BUSINESS LOGIC LAYER                       │
│  ┌────────────────────────────────────────────────┐     │
│  │                OrderService                    │     │
│  │  • Validates business rules                    │     │
│  │    (user not blocked, items in stock)          │     │
│  │  • Calculates total (applies discount rules)   │     │
│  │  • Calls IPaymentGateway.charge(total)         │     │
│  │  • Calls IOrderRepository.save(order)          │     │
│  │  • Publishes OrderPlaced domain event          │     │
│  │  Returns: Order domain object                  │     │
│  └──────┬───────────────┬───────────────┬─────────┘     │
│         │               │               │               │
│  ┌──────▼──────┐ ┌──────▼──────┐ ┌─────▼────────┐      │
│  │IOrderRepo   │ │IUserRepo    │ │IPaymentGateway│      │
│  │(interface)  │ │(interface)  │ │(interface)    │      │
│  └──────┬──────┘ └──────┬──────┘ └─────┬─────────┘      │
└─────────┼───────────────┼──────────────┼────────────────┘
          │               │              │ (implementations injected via DI)
          ▼               ▼              ▼
┌─────────────────────────────────────────────────────────┐
│                DATA ACCESS LAYER                         │
│  ┌──────────────────┐  ┌──────────────────┐            │
│  │ OrderRepository  │  │  UserRepository   │            │
│  │ (implements      │  │  (implements      │            │
│  │  IOrderRepo)     │  │   IUserRepo)      │            │
│  │  Prisma ORM /    │  │   Prisma ORM /    │            │
│  │  raw SQL         │  │   raw SQL         │            │
│  └────────┬─────────┘  └────────┬──────────┘            │
│           │                     │                       │
│  ┌────────▼──────────────────────▼────────────────┐     │
│  │           StripeAdapter (implements             │     │
│  │           IPaymentGateway — calls Stripe SDK)  │     │
│  └────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────┘
          │                     │               │
          ▼                     ▼               ▼
   ┌──────────┐          ┌──────────┐    ┌──────────┐
   │PostgreSQL│          │  Redis   │    │  Stripe  │
   │(primary) │          │  Cache   │    │   API    │
   └──────────┘          └──────────┘    └──────────┘
```

---

### Dependency Direction (Critical)

```
     DEPENDENCY DIRECTION
     (what each layer imports / knows about)

     Presentation  ──imports──►  Business Logic
     Business Logic ──imports──► Data Access INTERFACES (abstractions)
     Data Access   ──imports──►  Data Access INTERFACES (implements them)

     What Business Logic does NOT import:
       ✗ Express/Fastify (HTTP framework)
       ✗ Prisma/TypeORM directly
       ✗ Stripe SDK directly

     Business Logic only imports:
       ✓ Domain entities (Order, User)
       ✓ Repository interfaces (IOrderRepository)
       ✓ Gateway interfaces (IPaymentGateway)

     This means: you can run ALL business logic tests
     without a database, without an HTTP server, without Stripe.
     Tests are fast. Tests cannot have false positives from infra.
```

---

### Anti-Pattern: Broken Layering

```
WRONG: Business logic bleeding into the controller

  OrderController (Presentation Layer)
    │
    ├─► Direct SQL query: db.query("SELECT * FROM users WHERE...")
    │   ← VIOLATION: Controller knows about database
    │
    ├─► Discount calculation: if (user.orders > 10) discount = 10%
    │   ← VIOLATION: Business rule in Presentation Layer
    │
    └─► Stripe.charges.create(...)
        ← VIOLATION: Infrastructure concern in Presentation Layer

RESULT:
  • Testing the controller requires a real DB and a real Stripe account
  • The discount logic is in the controller. Another endpoint needs the same
    discount logic → duplicates it → two places to update when rules change
  • Impossible to unit-test business rules
```

---

_→ Continued in: [02-Layered Architecture.md](02-Layered%20Architecture.md)_
