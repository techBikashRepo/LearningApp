# Controller-Service-Repository Pattern — Part 2 of 3

### Sections: 5 (Request Flow), 6 (What Breaks When Layers Mix), 7 (Team Scaling Impact), 8 (Architectural Implications)

**Series:** System Design & Architecture → Topic 03

---

## SECTION 5 — Request Flow Through Components

### Annotated Flow: PATCH /orders/{id}/cancel

```
CLIENT
  PATCH /api/v1/orders/ord_abc123/cancel
  Body: { "reason": "changed my mind" }
  Authorization: Bearer eyJh...

─── CONTROLLER LAYER ────────────────────────────────────────────────────────

  1. Router matches → OrderController.cancel(req, res)

  2. AuthMiddleware (already ran as app-level middleware)
     req.user = { id: "usr_42", role: "customer" }

  3. OrderController.cancel():
     │
     │  a. Extract path param: orderId = req.params.id  (= "ord_abc123")
     │     Validate: is it a valid UUID format?
     │     If not: return HTTP 400 { error: "Invalid order ID format" }
     │
     │  b. Parse body: Zod validates { reason: string, optional }
     │
     │  c. Delegate: orderService.cancelOrder(orderId, userId, reason)
     │
     │  d. Map result:
     │       ok(order)      → HTTP 200 { order_id, status: "cancelled", ... }
     │       err(NotFound)  → HTTP 404
     │       err(NotOwner)  → HTTP 403
     │       err(CantCancel)→ HTTP 409 ("Order already shipped")

─── SERVICE LAYER ────────────────────────────────────────────────────────

  4. OrderService.cancelOrder(orderId, userId, reason):
     │
     │  a. order = await orderRepository.findById(orderId)
     │     If null: return err({ type: 'NotFound' })
     │
     │  b. BUSINESS RULE: Caller must own the order
     │     If (order.userId !== userId): return err({ type: 'NotOwner' })
     │
     │  c. BUSINESS RULE: Order must be in a cancellable state
     │     if (!['pending', 'confirmed'].includes(order.status))
     │       return err({ type: 'CantCancel', message: `Cannot cancel a ${order.status} order` })
     │
     │  d. BUSINESS RULE: Full refund if cancelled within 1 hour of creation
     │     refundAmount = Date.now() - order.createdAt < 3600000 ? order.total : 0
     │
     │  e. If refundAmount > 0:
     │       paymentGateway.refund(order.chargeId, refundAmount)
     │
     │  f. order.cancel(reason)  ← domain method that applies status = 'cancelled',
     │                             sets cancelledAt, reason
     │
     │  g. await orderRepository.save(order)  ← persist new state
     │
     │  h. eventBus.publish(new OrderCancelledEvent(order, refundAmount))
     │
     │  Return: ok(order)

─── REPOSITORY LAYER ────────────────────────────────────────────────────────

  5. orderRepository.findById("ord_abc123"):
     SQL: SELECT o.*, oi.* FROM orders o
          JOIN order_items oi ON oi.order_id = o.id
          WHERE o.id = 'ord_abc123'
     Maps result → Order domain object.

  6. orderRepository.save(order):
     SQL: UPDATE orders SET status = 'cancelled', cancelled_at = NOW(),
          cancellation_reason = $1 WHERE id = $2
     Returns updated Order domain object.

─── RESPONSE PATH ────────────────────────────────────────────────────────

  Controller receives ok(order) from service.
  Maps: OrderMapper.toResponseDTO(order)
    → { order_id: "ord_abc123", status: "cancelled", refunded: true, refund_amount: 8995, ... }
  Returns HTTP 200.

CLIENT receives cancellation confirmation.

CROSS-CUTTING CONCERNS (handled outside the CSR triad):
  Logging:     LoggerMiddleware intercepts all requests, logs req/res after controller
  Tracing:     OpenTelemetry middleware injects trace-id into each request context
  Error catch: Global error handler catches unhandled exceptions → HTTP 500
```

---

### Tracing Request Errors Across Layers

```
SCENARIO: Payment fails during order creation.
How does the error propagate cleanly through CSR?

STRIPE API:   Returns 402 Insufficient Funds error
      │
ADAPTER:      StripeAdapter.charge() catches Stripe error
              Returns: { success: false, error: 'InsufficientFunds', raw: StripeError }
      │
SERVICE:      paymentGateway.charge() returns failure result
              OrderService: rolls back inventory reservation
              Returns: err({ type: 'PaymentFailed', message: 'Card declined: insufficient funds' })
      │
CONTROLLER:   Receives err({ type: 'PaymentFailed' })
              Maps to HTTP 402 Payment Required
              Returns: { error: "Payment failed", detail: "Card declined: insufficient funds" }
      │
CLIENT:       Receives HTTP 402 with actionable error message.

WHAT DOESN'T HAPPEN:
  ❌ The Stripe error object doesn't leak to the client (internal implementation detail)
  ❌ The SQL error from a failed DB rollback doesn't become an HTTP 500 error message
  ❌ Stack traces don't reach the client response
  Each layer translates errors into its own vocabulary.
```

---

## SECTION 6 — What Breaks When Components Mix

### Anti-Pattern 1: The Service That Knows About HTTP

```typescript
// BAD: Service accepts and returns HTTP objects
class OrderService {
  async cancelOrder(req: Request, res: Response) {
    // ← HTTP types in Service
    const orderId = req.params.id;
    const userId = req.user.id;

    const order = await this.orderRepo.findById(orderId);

    if (order.userId !== userId) {
      return res.status(403).json({ error: "Not authorized" }); // ← HTTP response in Service
    }

    // ...
    return res.status(200).json(order); // ← Service is now coupled to Express
  }
}
```

**Production problem this creates:**

A new requirement: background job that auto-cancels unpaid orders after 24 hours. The job calls `OrderService.cancelOrder(???)` — but it has no HTTP request, no Express response. You either:
(a) Construct a fake `req` and `res` object for the background job — absurd
(b) Duplicate the cancellation logic in a new `AutoCancelOrderService` — business logic diverges

**Timeline:** 6 months later, the HTTP cancellation and the background auto-cancel apply different refund rules. Production incident: some users get double refunds, some get none.

**Fix:** Service accepts and returns plain domain objects and error types. Zero HTTP knowledge.

---

### Anti-Pattern 2: The Controller That Orchestrates

```typescript
// BAD: Business orchestration in the Controller
class OrderController {
  async create(req: Request, res: Response) {
    const user = await this.userService.findById(req.user.id); // service call A
    const items = req.body.items;

    // Business rule in controller
    if (user.isBlocked) return res.status(403).json({ error: "Blocked" });

    // Calling multiple services from the controller (orchestration)
    const stockCheck = await this.inventoryService.check(items); // service call B
    if (!stockCheck.ok) return res.status(409).json({ error: "Out of stock" });

    const charge = await this.paymentService.charge(user, req.body.total); // service call C
    if (!charge.ok) return res.status(402).json({ error: "Payment failed" });

    const order = await this.orderService.create(user.id, items, charge.id); // service call D

    return res.status(201).json(order);
  }
}
```

**Production problem:**

The inventory was reserved (step B) and payment was charged (step C). After step C, the server crashes. The controller catches no errors on step D (the crash). Result: user was charged, inventory was reserved, but no order was created. No compensating action was taken because the controller scattered the orchestration across 4 independent service calls with no transactional boundary.

**What the controller is missing:** A single `OrderService.createOrder()` that wraps all of these steps in a managed unit of work with proper compensation logic.

**Rule:** Controllers call exactly ONE service per operation. If you find yourself calling 3 services from one controller action, those calls belong inside a Service method.

---

### Anti-Pattern 3: The Repository That Applies Business Rules

```typescript
// BAD: Repository filters by business rule
class OrderRepository {
  // Business logic in a repository method name = red flag
  async findCancellableOrdersForCustomer(userId: string): Promise<Order[]> {
    // "Cancellable" is a business concept — not a data concept!
    return this.prisma.order.findMany({
      where: {
        userId,
        status: { in: ["pending", "confirmed"] }, // ← business rule: what statuses are cancellable?
        createdAt: { gte: new Date(Date.now() - 24 * 3600 * 1000) }, // ← another business rule: 24hrs
      },
    });
  }
}
```

**Problem:** The business rule ("an order is cancellable if it's pending/confirmed AND less than 24 hours old") now lives inside the repository.

- When the rule changes (new status, new time window, exception for premium users), a developer looks in the Service layer first. Doesn't find it. Eventually finds it buried in a repository method name.
- When the Admin team needs to cancel ANY order regardless of these rules: they call this repository and get the filtered result. They have to write a DIFFERENT repository method for admin cancellation, duplicating the data access logic.

**Correct split:**

```
OrderRepository.findByUserId(userId)         ← data concern: find all orders for user
OrderRepository.findByIds(ids)               ← data concern: find by list of IDs

OrderService.getCancellableOrders(userId)    ← business concern: filter by "cancellable" rules
  → calls orderRepository.findByUserId()
  → filters in code: order.isCancellable()   ← business method on Order domain entity
```

---

### Anti-Pattern 4: Repository Used as a Transaction Coordinator

```typescript
// BAD: Repository manages the cross-entity transaction
class OrderRepository {
  async createOrderWithInventoryAndPayment(dto) {
    await this.prisma.$transaction(async (tx) => {
      // WRONG: orchestrating multiple business concerns inside a repository
      const inv = await tx.inventory.update({ ... });  // inventory concern
      const payment = await tx.payment.create({ ... }); // payment concern (!!!)
      const order = await tx.order.create({ ... });
      await tx.notification.create({ ... });            // notification concern (!!)
    });
  }
}
```

**What breaks:** This repository now knows about and directly manipulates 4 different domain concepts. Any business rule change to inventory, payment, or notification requires modifying the Order repository. The Payments team now has to coordinate with the Orders repository owner on every change.

**Fix:** Transaction coordination is a Service responsibility. Use a Unit of Work pattern or pass the transaction context down from the Service.

---

## SECTION 7 — Team Scaling Impact

### Feature Team Structure with CSR

```
FEATURE REQUEST: "Add loyalty points calculation to orders"

WITHOUT CSR (everything in route handlers):
  Engineer A: adds points calculation to POST /orders route handler
  Engineer B: adds points redemption to GET /orders/{id} route handler
  Engineer C: adds points display to the user profile handler

  3 months later: 3 different implementations of "how many points per dollar."
  One was updated after a product change. Two weren't. Customer complaints.
  Debugging requires reading 3 different route handlers.

WITH CSR:
  Engineer A: adds LoyaltyPointsService with calculatePoints() and redeemPoints()
  Engineer B: calls LoyaltyPointsService.calculatePoints() in OrderService.createOrder()
  Engineer C: calls LoyaltyPointsService.getBalance() in UserService.getProfile()

  ONE implementation. ONE place to update. THREE surfaces consume it.
  Test: LoyaltyPointsService unit tests cover all scenarios.
  Change: edit one file, all three endpoints automatically updated.
```

---

### Ownership Contracts Between Teams

```
Team A owns: OrderController, OrderService, OrderRepository
Team B owns: UserController, UserService, UserRepository
Team C owns: PaymentService, StripeAdapter

Contract between Team A and Team C:
  IPaymentGateway interface (defined and committed to)
  Method signature: charge(paymentMethodId: string, amount: Money): Promise<ChargeResult>

  Team A can implement and test OrderService using MockPaymentGateway.
  Team C can change StripeAdapter implementation (even swap to Braintree)
    without touching Team A's code — as long as IPaymentGateway is honored.

  Breaking change to IPaymentGateway: both teams must agree and coordinate.
  Non-breaking change to StripeAdapter: Team C deploys independently.
```

---

## SECTION 8 — Architectural Implications

### CSR and Testing Strategy

```
TEST TYPE        │ TESTS                    │ WHAT IS REAL / WHAT IS MOCKED
─────────────────┼──────────────────────────┼─────────────────────────────────────
Unit Tests       │ OrderService.test.ts     │ REAL: OrderService business logic
(no I/O)         │ ─ createOrder            │ MOCKED: OrderRepository, PaymentGateway
                 │ ─ cancelOrder            │         UserRepository, EventBus
                 │ ─ calculateRefund        │ Speed: < 5ms per test
─────────────────┼──────────────────────────┼─────────────────────────────────────
Unit Tests       │ OrderController.test.ts  │ REAL: Controller route handling,
(no I/O)         │ ─ create: returns 201    │       status code mapping, DTO parsing
                 │ ─ create: 422 on bad body│ MOCKED: OrderService
                 │ ─ cancel: 403 on non-own │ Speed: < 5ms per test
─────────────────┼──────────────────────────┼─────────────────────────────────────
Integration Tests│ OrderRepository.test.ts  │ REAL: Repository + PostgreSQL (test DB)
(DB required)    │ ─ save then findById     │ MOCKED: Nothing (it's an infra test)
                 │ ─ pagination works       │ Speed: 200-500ms per test (DB startup)
─────────────────┼──────────────────────────┼─────────────────────────────────────
E2E Tests        │ order-flow.e2e.test.ts   │ REAL: Full stack (HTTP → DB → Stripe test mode)
(full stack)     │ ─ complete order flow    │ Speed: 2-10s per test
                 │ ─ cancel + refund flow   │ Run: Pre-deploy only, not every commit
─────────────────┼──────────────────────────┼─────────────────────────────────────
```

**Result:** 80% of tests are unit tests (fast), 15% integration (medium), 5% E2E (slow). PRs get a full unit test run in under 30 seconds.

---

### CSR in Different Languages / Frameworks

```
NODE.JS (Express / Fastify / NestJS):
  Controller: Express Router handler or NestJS @Controller class
  Service:    TypeScript class marked @Injectable() (NestJS DI)
  Repository: TypeScript class using Prisma/TypeORM, @InjectRepository()

JAVA (Spring Boot):
  Controller: @RestController class with @GetMapping / @PostMapping
  Service:    @Service class, injected via constructor
  Repository: @Repository interface extending JpaRepository<Order, UUID>

  Spring generates the repository implementation automatically.
  OrderRepository extends JpaRepository → save(), findById(), etc. for free.
  Custom queries via @Query annotation or findBy* method name convention.

PYTHON (FastAPI / Django):
  FastAPI: APIRouter function as controller, plain class as service,
           SQLAlchemy/repository class for data access
  Django:  View (or ViewSet in DRF) as controller, forms/model managers
           as light service layer, Django ORM models as repositories

C# (.NET):
  Controller: [ApiController] class with [HttpPost] action methods
  Service:    Interface IOrderService + OrderService class (injected)
  Repository: IOrderRepository interface + Entity Framework Core implementation

RUBY (Rails):
  Controller: ApplicationController subclass, routes.rb
  Service:    Service Objects gem or plain POROs in app/services/
  Repository: ActiveRecord model (Rails conflates the domain object with the DB record
              — "skinny model, fat nothing" is a common Rails anti-pattern;
               Service Objects solve this)
```

---

_→ Continued in: [03-Controller-Service-Repository Pattern.md](03-Controller-Service-Repository%20Pattern.md)_
