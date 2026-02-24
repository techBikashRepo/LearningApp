# Layered Architecture — Part 2 of 3

### Sections: 5 (Request Flow), 6 (What Breaks When Layers Mix), 7 (Team Scaling Impact), 8 (Architectural Implications)

**Series:** System Design & Architecture → Topic 02

---

## SECTION 5 — Request Flow Through Layers

### Flow: POST /orders (Create Order)

```
CLIENT
  HTTP POST /api/v1/orders
  Body: { "items": [{"product_id": "p1", "qty": 2}], "shipping_address": "..." }
  Header: Authorization: Bearer eyJh...

  │
  ▼
── PRESENTATION LAYER ──────────────────────────────────────────────────

  1. AuthMiddleware
     │  Reads Authorization header
     │  Decodes JWT → { userId: "u1", role: "customer" }
     │  Attaches to req.user
     │
  2. Router: POST /orders → OrderController.create
     │
  3. OrderController.create(req, res)
     │  Parses body: const dto = req.body
     │  Validates DTO (Zod/Joi):
     │    - items: array, non-empty, each item has product_id (string) and qty (number > 0)
     │    - shipping_address: string, required
     │  If validation fails: returns HTTP 422 immediately. Does NOT call service.
     │
     │  Calls: orderService.createOrder(dto, req.user.userId)
     │
── BUSINESS LOGIC LAYER ──────────────────────────────────────────────────

  4. OrderService.createOrder(dto, userId)
     │
     │  a. userRepository.findById(userId)
     │       → Returns User domain object.
     │       If not found: throws UserNotFoundError → Controller catches → HTTP 404
     │
     │  b. Business rule: is user allowed to place orders?
     │       if (user.isBlocked) throw OrderNotAllowedError  → HTTP 403
     │       if (user.unpaidInvoices.length >= 3) throw PaymentRequiredError → HTTP 402
     │
     │  c. inventoryService.checkAndReserve(dto.items)
     │       → For each item: checks available stock.
     │       If any item insufficient: throws InsufficientStockError → HTTP 409
     │
     │  d. Calculate order total
     │       total = sum(item.qty * productPriceCache.get(item.product_id))
     │       discount = discountPolicy.calculate(user, total)  ← pure function, testable
     │       finalTotal = total - discount
     │
     │  e. paymentGateway.charge(user.paymentMethodId, finalTotal)
     │       → Calls StripeAdapter.charge(...)
     │       If charge fails: release inventory reservation. Throw PaymentFailedError.
     │
     │  f. order = new Order({ userId, items, finalTotal, shippingAddress })
     │     order.status = 'confirmed'
     │
     │  g. orderRepository.save(order)  ← persist to DB
     │
     │  h. eventBus.publish(new OrderPlacedEvent(order))
     │       → Notification service picks up (async, does not block response)
     │
     │  Returns: Order domain object

── DATA ACCESS LAYER ──────────────────────────────────────────────────

  5. orderRepository.save(order)  [executes in step 4g above]
     │  Maps Order domain object → ORM entity (or SQL params)
     │  SQL: INSERT INTO orders (user_id, total, status, ...) VALUES ($1, $2, $3, ...)
     │  Returns saved Order with generated id, created_at

── PRESENTATION LAYER (response path) ──────────────────────────────────────────────────

  6. OrderController.create receives Order domain object from service
     │  Maps domain Order → HTTP response DTO
     │    { order_id: "ord_abc", status: "confirmed", total: 89.95, estimated_delivery: "..." }
     │  Returns HTTP 201 Created with JSON body

CLIENT receives 201 response with order confirmation.

Total layers crossed (down): 3 (Presentation → BLL → DAL)
Total layers crossed (up):   3 (DAL → BLL → Presentation)
DB calls: 2-4 (user lookup, inventory check, order insert)
External calls: 1 (Stripe)
```

---

### Flow: GET /orders/{id} (Simple Read — Relaxed Layering)

```
CLIENT
  HTTP GET /api/v1/orders/ord_abc
  Header: Authorization: Bearer eyJh...

  │
  ▼

  1. AuthMiddleware → decodes JWT → userId: "u1"

  2. OrderController.getById(req, res)
     │  Validates: req.params.id is a valid UUID
     │
     │  Option A (STRICT layering):
     │    Calls orderService.getOrder(id, userId)
     │    Service: verifies user owns the order (business rule)
     │    Service calls orderRepository.findById(id)
     │    Returns DTO.
     │
     │  Option B (RELAXED layering — valid for read-only, no business rule):
     │    Calls orderRepository.findByIdAndUserId(id, userId) directly
     │    Skips service layer. Less indirection. Acceptable for pure reads.
     │    RISK: if a business rule appears later (e.g., "premium users see more fields"),
     │           you'll need to introduce the service layer then.

  Returns HTTP 200 with order details.
```

---

## SECTION 6 — What Breaks When Layers Mix

### Violation 1: Database Query in the Controller

```typescript
// BAD — OrderController directly uses ORM
class OrderController {
  async create(req: Request, res: Response) {
    // Direct Prisma call from the controller
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });

    // Business rule: discount logic
    const discount = user.totalOrders > 10 ? 0.1 : 0;

    // Another direct DB call
    const order = await prisma.order.create({
      data: { userId: user.id, total: req.body.total * (1 - discount) },
    });
    return res.json(order);
  }
}
```

**What breaks:**

1. **Testing requires a live database.** The controller test must spin up PostgreSQL, seed a user row, then test discount logic. Test time: 2-5 seconds per test. At 500 tests: 10-25 minutes CI pipeline.

2. **Discount logic is now in the controller.** When the admin panel also needs to calculate discounts: it either duplicates this logic or imports from the controller (wrong direction). Six months later, two copies of the discount rule diverge. Finance reports incorrect revenue.

3. **Swap Prisma for raw SQL?** Modify every controller that has Prisma calls. 40 controllers. High risk. Long refactor.

---

### Violation 2: Business Logic in the Data Access Layer

```typescript
// BAD — Repository calculating discounts
class OrderRepository {
  async createOrder(userId: string, items: Item[]) {
    const user = await db.query("SELECT * FROM users WHERE id = $1", [userId]);

    // WRONG: business rule inside the data layer
    const discount = user.rows[0].total_orders > 10 ? 0.1 : 0;
    const total = items.reduce((sum, i) => sum + i.price * i.qty, 0);

    return db.query("INSERT INTO orders (user_id, total) VALUES ($1, $2)", [
      userId,
      total * (1 - discount),
    ]);
  }
}
```

**What breaks:**

1. **The repository now embeds pricing policy.** When the discount rule changes (new threshold, new rate), you must find it in repositories—not in services. Developers look in the wrong place. Bugs introduced.

2. **This repository cannot be reused for scenarios where discount does NOT apply** (admin manual order creation, refund recalculation). Every caller gets the discount applied whether they want it or not.

3. **Unit testing the discount rule** requires mocking the database. The business rule and the DB call cannot be separated.

---

### Violation 3: Presentation Logic Leaking into Business Logic

```typescript
// BAD — Service depends on HTTP request object
class OrderService {
  async createOrder(req: Request) {
    // ← takes Express Request object
    const userId = req.user.id;
    const items = req.body.items;
    const userAgent = req.headers["user-agent"]; // ← why does service know about HTTP headers?

    // Logic dependent on HTTP context
    if (userAgent.includes("Mobile")) {
      // Different pricing for mobile? This is a presentation concern.
    }
  }
}
```

**What breaks:**

1. **The service cannot be called from a CLI job, gRPC endpoint, or background worker** without constructing a fake HTTP Request object.

2. **Testing the service requires constructing an Express Request** instead of calling `orderService.createOrder(userId, items)` with plain data.

3. **The service is now coupled to Express.** Switch to Fastify or gRPC: the service must change.

**Rule:** The Business Logic Layer accepts and returns **plain domain objects**. Never HTTP objects, never database row objects.

---

### Violation 4: Skipping the Interface — Direct Concrete Dependency

```typescript
// BAD — Service directly imports StripeAdapter (concrete class)
import { StripeAdapter } from '../infra/stripe.adapter';

class OrderService {
  private stripe = new StripeAdapter();  // ← hardcoded concrete dependency

  async createOrder(...) {
    await this.stripe.charge(...);  // ← cannot swap at test time
  }
}

// ────────────────────────────────────────────────────────────────

// GOOD — Service depends on interface (injected)
interface IPaymentGateway {
  charge(paymentMethodId: string, amount: number): Promise<ChargeResult>;
}

class OrderService {
  constructor(private paymentGateway: IPaymentGateway) {}

  async createOrder(...) {
    await this.paymentGateway.charge(...);  // ← real Stripe in prod, mock in tests
  }
}
```

**What breaks without interfaces:** Every unit test of `OrderService` calls the real Stripe API. Tests are slow (network calls), expensive ($0.30 per test charge), and non-deterministic (Stripe downtime = CI failure). You cannot simulate "what happens when payment fails" without Stripe's test mode.

---

## SECTION 7 — Team Scaling Impact

### Ownership Alignment with Layers

```
SMALL TEAM (4-8 engineers, full-stack):
  All engineers work across all layers.
  Layering provides discipline — not team separation.
  Benefit: Bus factor mitigation. Any engineer can work on any layer.
  One codebase, clear module structure.

MEDIUM TEAM (8-20 engineers, partial specialization):
  Frontend engineers: own Presentation Layer (controllers, DTOs, view models)
  Backend engineers: own Business Logic Layer (services, domain entities)
  DB/Platform engineers: own Data Access Layer (repositories, migrations)

  Clear layer boundaries = clear ownership = clear PR review scope
  "This change touches the BLL. Tag backend team in review."
  "This change is controller-only. Frontend team can approve."

LARGE TEAM (20+ engineers, service-based):
  At this scale, layered architecture within a single service
  is STILL the correct internal structure of each microservice.
  Teams might own an entire vertical slice (one microservice)
  that internally follows layered architecture.
```

---

### Parallel Development Without Conflicts

With properly defined interfaces between layers, two engineers can work in parallel:

```
Engineer A is building the Presentation Layer:
  OrderController.create()
  Input validation, request/response DTOs
  Unit tests: mock IOrderService interface
  Does NOT need Engineer B's work to write tests.

Engineer B is building the Business Logic Layer:
  OrderService.createOrder()
  Discount rules, inventory check, payment flow
  Unit tests: mock IOrderRepository and IPaymentGateway
  Does NOT need Engineer A or Engineer C's work.

Engineer C is building the Data Access Layer:
  OrderRepository (SQL implementation of IOrderRepository)
  StripeAdapter (implementation of IPaymentGateway)
  Integration tests against a test database

All three can work in parallel because:
  The INTERFACES were defined first (IOrderService, IOrderRepository, IPaymentGateway).
  Each engineer mocks the interface layer they depend on.
  Integration testing comes last — after all three layers are implemented.
```

---

### Code Review Scope by Layer

```
PRESENTATION LAYER change (new controller endpoint):
  Review checklist:
  ✅ Validates all inputs before passing to service
  ✅ Does NOT contain business logic
  ✅ Returns correct HTTP status codes
  ✅ Does NOT directly query the database
  ✅ Controller is thin — delegates to service immediately after validation

BUSINESS LOGIC LAYER change (new service method):
  Review checklist:
  ✅ Only depends on interfaces (not concrete Stripe, not Prisma directly)
  ✅ Contains all business rules — not split across controller/repository
  ✅ Fully unit-testable (no external calls, no DB, no HTTP)
  ✅ Domain objects are returned, not raw DB rows or HTTP bodies

DATA ACCESS LAYER change (new repository method):
  Review checklist:
  ✅ Implements the pre-defined interface (matches signature exactly)
  ✅ Does NOT contain business rules
  ✅ Maps between domain objects and DB rows correctly
  ✅ Handles connection errors, returns typed errors, never leaks DB exceptions upward
```

---

## SECTION 8 — Architectural Implications

### Testability Pyramid in Layered Architecture

```
                    ┌────────────┐
                    │    E2E     │  5-10 tests
                    │   Tests    │  Full stack: HTTP → DB → real services
                    │ (slow, $$) │  Confirms all layers work together
                    └─────┬──────┘
               ┌──────────┴──────────┐
               │  Integration Tests  │  20-50 tests
               │  Controller +       │  Test controller → real service → mock repo
               │  Service layer      │  Or: Service → real repository → test DB
               └────────┬────────────┘
          ┌─────────────┴────────────┐
          │       Unit Tests         │  100-500 tests (majority)
          │  BLL: pure functions,    │  All mocked dependencies
          │  all business rules      │  Millisecond execution
          └──────────────────────────┘

Goal: ~70% unit tests (BLL), ~20% integration tests, ~10% E2E tests.
Layered architecture enables this pyramid.
Un-layered code forces you into the inverted pyramid (mostly E2E) = slow CI.
```

---

### Dependency Injection in Layered Architecture

```typescript
// Composition Root (main.ts or app bootstrap) — wires everything together
const db = new PrismaClient();

// Build DAL
const orderRepository = new OrderRepository(db);
const userRepository = new UserRepository(db);
const stripeAdapter = new StripeAdapter(process.env.STRIPE_KEY);

// Build BLL — inject DAL interfaces
const orderService = new OrderService(
  orderRepository, // IOrderRepository
  userRepository, // IUserRepository
  stripeAdapter, // IPaymentGateway
  eventBus, // IEventBus
);

// Build Presentation — inject BLL interfaces
const orderController = new OrderController(orderService);

// Register routes
app.post("/orders", orderController.create.bind(orderController));

// In tests:
const mockRepo = new InMemoryOrderRepository(); // implements IOrderRepository
const mockPayment = new MockPaymentGateway(); // implements IPaymentGateway
const orderService = new OrderService(
  mockRepo,
  mockUserRepo,
  mockPayment,
  mockEventBus,
);
// Now test business rules without DB or Stripe.
```

---

### Performance Implications

```
COST OF LAYERING:
  Each layer boundary = 1 additional function call.
  In Node.js: function call overhead ≈ 0.001ms (negligible).

  Real overhead:
    • Mapping between DTO → Domain Object → DB entity: 0.01–0.1ms per request
    • Memory allocation for intermediate objects: minor

  VERDICT: Negligible. The cost of layering is architectural (indirection,
  boilerplate), not performance-critical.

WHEN LAYERING HURTS PERFORMANCE:
  1. Chatty repository calls: service calls repository in a loop (N+1 queries)
     FIX: add a bulk-fetch method to the repository (getBulkByIds)

  2. Mapping large object graphs repeatedly (deep domain objects):
     FIX: use projections (repository returns only the fields needed for this use case)

  3. Too many layers with too little logic:
     A 4-layer architecture for a 3-route CRUD app = unnecessary cognitive overhead.
     FIX: Use a simpler structure. Layered architecture scales with complexity.
```

---

_→ Continued in: [03-Layered Architecture.md](03-Layered%20Architecture.md)_
