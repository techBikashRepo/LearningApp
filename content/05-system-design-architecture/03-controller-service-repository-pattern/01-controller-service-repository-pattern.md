# Controller-Service-Repository Pattern — Part 1 of 3

### Sections: 1 (Real-World Analogy), 2 (Problem Solved), 3 (Component Responsibilities), 4 (ASCII Diagrams)

**Series:** System Design & Architecture → Topic 03

---

## SECTION 1 — Real-World Analogy

### A Hospital Emergency Department

Controller-Service-Repository is not a theoretical abstraction — it's the structure of nearly every production web API written in Node.js, Java Spring, .NET, Ruby on Rails's service objects, or Python Django/FastAPI. It's so common it has a name.

```
PATIENT (HTTP Client)
  Arrives at the ER with a complaint ("I need POST /prescriptions")
  Talks only to the RECEPTIONIST.
  Never walks into the lab or the storage room.
  │
  ▼
RECEPTIONIST (Controller)
  • Takes down the patient's information (parses request body)
  • Checks if the patient has an appointment / is allowed (authentication)
  • Verifies the form is filled out correctly (input validation)
  • Hands off to the DOCTOR with the verified information
  • When the doctor is done, delivers the result back to the patient (HTTP response)
  • DOES NOT make any medical decisions
  │
  ▼
DOCTOR (Service)
  • Applies medical knowledge (business rules)
  • Decides what treatment is needed (orchestrates the domain logic)
  • Orders tests: "Get a blood sample" (calls Repository)
  • Orders medications: "Retrieve this drug from the pharmacy" (calls Repository)
  • Makes the final decision (creates/updates domain objects)
  • DOES NOT interact with the patient directly
  • DOES NOT physically retrieve records from filing cabinets
  │
  ▼
FILING CLERK / PHARMACIST (Repository)
  • Stores and retrieves records and medications (database queries)
  • Knows WHERE things are stored (which table, which index, which cache)
  • Returns exactly what the Doctor asked for
  • DOES NOT know why the Doctor needs it
  • DOES NOT make any clinical decisions
```

**The critical rule:** Each role knows only what it needs to. The receptionist doesn't know medical procedures. The doctor doesn't file paperwork. The clerk doesn't diagnose patients.

**What goes wrong when roles blur:** In small hospitals (small companies), the doctor sometimes does their own filing. Fine at 2 doctors, 100 patients. At 50 doctors, 5,000 patients, everyone is inconsistently filing records, using different systems, in different places. Chaos.

---

### Another Analogy: A Hotel

```
GUEST → FRONT DESK (Controller)
  Checks in: verifies reservation, validates ID, collects payment.
  Routes requests: "I need room service" → calls Room Service dept.
  Never personally makes food or cleans rooms.

FRONT DESK → DEPARTMENT MANAGERS (Services)
  Room Service Manager: decides what menu items are available,
  handles substitutions, applies loyalty discounts.
  Housekeeping Manager: schedules cleaning, assigns rooms to staff.
  Neither manager talks directly to guests.

DEPARTMENT MANAGERS → STAFF (Repositories)
  Housekeeping staff: physically retrieve/update room status.
  Kitchen staff: retrieve ingredients from storage, prepare food.
  Storage staff: manage physical record of room availability.
```

The Controller-Service-Repository pattern is exactly this: a **request-handling layer** (Controller), a **business-logic layer** (Service), and a **data-access layer** (Repository). It is the most frequently implemented concrete version of Layered Architecture.

---

## SECTION 2 — Problem Solved

### The Concrete Problem: Fat Controllers

In frameworks like Express, Laravel, Django, or Spring MVC, the first temptation is to put everything in the route handler or controller action. This is the path of least resistance:

```javascript
// REAL pattern from 3-year-old Express apps
// This is one route handler. 80 lines. Does everything.

router.post("/users/:id/orders", async (req, res) => {
  // 1. Auth check (presentation concern)
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "No token" });
  const decoded = jwt.verify(token, process.env.JWT_SECRET);

  // 2. Validation (presentation concern — at least it's here)
  if (!req.body.items || req.body.items.length === 0) {
    return res.status(400).json({ error: "Items required" });
  }

  // 3. Direct DB query (data access concern in the route handler)
  const user = await db.query("SELECT * FROM users WHERE id = $1", [
    req.params.id,
  ]);
  if (!user.rows[0]) return res.status(404).json({ error: "User not found" });

  // 4. Business logic (service concern in the route handler)
  let discount = 0;
  if (user.rows[0].loyalty_tier === "gold") discount = 0.15;
  if (user.rows[0].loyalty_tier === "platinum") discount = 0.25;
  const total =
    req.body.items.reduce((s, i) => s + i.price * i.qty, 0) * (1 - discount);

  // 5. Another direct DB query
  const inventory = await db.query(
    "SELECT * FROM inventory WHERE product_id = ANY($1)",
    [req.body.items.map((i) => i.product_id)],
  );
  if (
    inventory.rows.some(
      (inv) =>
        inv.qty <
        req.body.items.find((i) => i.product_id === inv.product_id).qty,
    )
  ) {
    return res.status(409).json({ error: "Insufficient stock" });
  }

  // 6. External service call (infrastructure concern in the route handler)
  const charge = await stripe.charges.create({
    amount: Math.round(total * 100),
  });

  // 7. DB write
  const order = await db.query(
    "INSERT INTO orders (user_id, total, stripe_charge_id) VALUES ($1, $2, $3) RETURNING *",
    [req.params.id, total, charge.id],
  );

  // 8. Email (notification concern in the route handler)
  await sendgrid.send({
    to: user.rows[0].email,
    subject: "Order confirmed",
    text: `Order #${order.rows[0].id}`,
  });

  res.status(201).json(order.rows[0]);
});
```

**Problems:**

- 8 concerns in one function. Zero testability without a live DB + Stripe + SendGrid.
- Discount logic duplicated in 3 other places that also need it.
- To change the DB query for users, find all route handlers that do `SELECT * FROM users`.
- New joiner: no mental model for where anything lives.

---

### What the Pattern Solves

```
PROBLEM 1: Untestable route handlers
→ SOLUTION: Controller calls Service with validated data. Service is testable
            without HTTP. Repository is testable without full stack.

PROBLEM 2: Scattered business logic
→ SOLUTION: All domain logic lives in Service methods.
            One canonical location. Change it once.

PROBLEM 3: Raw SQL scattered across routes
→ SOLUTION: All DB interactions in Repository methods.
            Change DB schema: change only the Repository.

PROBLEM 4: No reusability
→ SOLUTION: OrderService.createOrder() called from HTTP controller,
            from a CLI script, from a cron job, from a gRPC handler —
            all use the same service, same business rules.

PROBLEM 5: Cognitive overload navigating the codebase
→ SOLUTION: Predictable structure. Every developer knows:
            "To find the discount logic: OrderService.
             To find the SQL for orders: OrderRepository.
             To find the POST /orders handler: OrderController."
```

---

## SECTION 3 — Component Responsibilities

### The Controller

```typescript
// ✅ CORRECT: Lean Controller
export class OrderController {
  constructor(private orderService: IOrderService) {}

  async create(req: Request, res: Response): Promise<void> {
    // ── RESPONSIBILITY 1: Parse and validate input ──
    const parseResult = CreateOrderSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(422).json({ errors: parseResult.error.flatten() });
      return;
    }

    // ── RESPONSIBILITY 2: Extract identity from auth context ──
    const userId = req.user.id; // set by AuthMiddleware upstream

    // ── RESPONSIBILITY 3: Delegate to service ──
    const result = await this.orderService.createOrder(
      parseResult.data,
      userId,
    );

    // ── RESPONSIBILITY 4: Handle application errors → HTTP status codes ──
    if (result.isErr()) {
      const statusMap: Record<string, number> = {
        UserNotFound: 404,
        InsufficientStock: 409,
        PaymentFailed: 402,
        OrderNotAllowed: 403,
      };
      res
        .status(statusMap[result.error.type] ?? 500)
        .json({ error: result.error.message });
      return;
    }

    // ── RESPONSIBILITY 5: Format and return response ──
    res.status(201).json(OrderResponseMapper.toDTO(result.value));
  }
}

// THE CONTROLLER:
//   ✅ Handles HTTP protocol (status codes, headers)
//   ✅ Validates raw input shape (Zod/Joi)
//   ✅ Extracts identity from auth middleware
//   ✅ Delegates ALL logic to Service
//   ✅ Maps service errors to HTTP status codes
//   ✅ Maps domain objects to response DTOs
//
//   ❌ No SQL queries
//   ❌ No business rules
//   ❌ No Stripe calls
//   ❌ No domain entity construction
```

---

### The Service

```typescript
// ✅ CORRECT: Service owns ALL business logic
export class OrderService implements IOrderService {
  constructor(
    private orderRepository: IOrderRepository,
    private userRepository: IUserRepository,
    private inventoryRepository: IInventoryRepository,
    private paymentGateway: IPaymentGateway,
    private eventBus: IEventBus,
  ) {}

  async createOrder(
    dto: CreateOrderDTO,
    userId: string,
  ): Promise<Result<Order, AppError>> {
    // ── Business rule 1: User must exist ──
    const user = await this.userRepository.findById(userId);
    if (!user) return err({ type: "UserNotFound", message: "User not found" });

    // ── Business rule 2: User must be allowed to order ──
    if (user.isBlocked)
      return err({ type: "OrderNotAllowed", message: "Account suspended" });

    // ── Business rule 3: All items must be in stock ──
    const stockCheck = await this.inventoryRepository.checkAvailability(
      dto.items,
    );
    if (!stockCheck.allAvailable)
      return err({ type: "InsufficientStock", message: stockCheck.reason });

    // ── Business rule 4: Calculate price with discount policy ──
    const total = PricingPolicy.calculate(dto.items, user.loyaltyTier);

    // ── Business rule 5: Reserve inventory ──
    await this.inventoryRepository.reserve(dto.items);

    // ── Business rule 6: Charge payment ──
    const chargeResult = await this.paymentGateway.charge(
      user.defaultPaymentMethodId,
      total,
    );
    if (chargeResult.failed) {
      await this.inventoryRepository.releaseReservation(dto.items); // compensate
      return err({ type: "PaymentFailed", message: chargeResult.errorMessage });
    }

    // ── Business rule 7: Create the order record ──
    const order = Order.create({
      userId,
      items: dto.items,
      total,
      chargeId: chargeResult.chargeId,
    });
    const saved = await this.orderRepository.save(order);

    // ── Side effect: publish domain event asynchronously ──
    await this.eventBus.publish(new OrderPlacedEvent(saved));

    return ok(saved);
  }
}

// THE SERVICE:
//   ✅ All business rules live here
//   ✅ Orchestrates repository and gateway calls
//   ✅ Constructs and validates domain entities
//   ✅ Handles cross-entity consistency (inventory + payment + order)
//   ✅ Emits domain events
//
//   ❌ No HTTP concerns (never sees req or res)
//   ❌ No SQL (calls repository interfaces only)
//   ❌ No Stripe SDK directly (calls IPaymentGateway interface)
```

---

### The Repository

```typescript
// ✅ CORRECT: Repository owns ALL data access
export class OrderRepository implements IOrderRepository {
  constructor(private prisma: PrismaClient) {}

  async save(order: Order): Promise<Order> {
    // ── Responsibility: Map domain entity to DB schema ──
    const record = await this.prisma.order.create({
      data: {
        id: order.id,
        userId: order.userId,
        totalAmount: order.total.amount,
        currency: order.total.currency,
        chargeId: order.chargeId,
        status: order.status,
        items: {
          createMany: {
            data: order.items.map((item) => ({
              productId: item.productId,
              quantity: item.quantity,
              unitPrice: item.unitPrice,
            })),
          },
        },
      },
      include: { items: true },
    });

    // ── Responsibility: Map DB record back to domain entity ──
    return OrderMapper.toDomain(record);
  }

  async findById(id: string): Promise<Order | null> {
    const record = await this.prisma.order.findUnique({
      where: { id },
      include: { items: true, user: { select: { id: true, email: true } } },
    });
    return record ? OrderMapper.toDomain(record) : null;
  }

  async findByUserId(userId: string, pagination: Pagination): Promise<Order[]> {
    const records = await this.prisma.order.findMany({
      where: { userId },
      skip: pagination.offset,
      take: pagination.limit,
      orderBy: { createdAt: "desc" },
      include: { items: true },
    });
    return records.map(OrderMapper.toDomain);
  }
}

// THE REPOSITORY:
//   ✅ All SQL/ORM queries live here
//   ✅ Maps between domain objects and DB records (OrderMapper)
//   ✅ Abstracts pagination, filtering, sorting
//   ✅ Implements the IOrderRepository interface
//
//   ❌ No business rules
//   ❌ No HTTP concerns
//   ❌ No knowledge of WHY the data is being fetched
```

---

## SECTION 4 — ASCII Architecture Diagrams

### Full Request Flow Diagram (POST /orders)

```
CLIENT HTTP REQUEST
POST /orders
{ items: [...], shipping_address: "..." }
Authorization: Bearer <jwt>
      │
      ▼
┌─────────────────────────────────────────────────────────┐
│                    CONTROLLER LAYER                      │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │               AuthMiddleware                     │   │
│  │  jwt.verify(token) → { userId, role }            │   │
│  │  Attaches: req.user = { id, role }               │   │
│  └──────────────────────────────────────────────────┘   │
│                          │                              │
│  ┌──────────────────────────────────────────────────┐   │
│  │              OrderController.create()            │   │
│  │                                                  │   │
│  │  1. Zod.parse(req.body) → CreateOrderDTO         │   │
│  │     If invalid → return HTTP 422                 │   │
│  │                                                  │   │
│  │  2. orderService.createOrder(dto, req.user.id)   │   │
│  │                                                  │   │
│  │  3. Result<Order, AppError>                      │   │
│  │     → ok:  HTTP 201 + OrderResponseDTO           │   │
│  │     → err: HTTP 4xx based on error type          │   │
│  └──────────────────────────────────────────────────┘   │
└────────────────────────┬─────────────────────────────────┘
                         │ createOrder(dto, userId)
                         ▼
┌─────────────────────────────────────────────────────────┐
│                    SERVICE LAYER                         │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │              OrderService.createOrder()          │   │
│  │                                                  │   │
│  │  userRepo.findById(userId)                       │   │
│  │    ──► check user.isBlocked                     │   │
│  │    ──► check user.unpaidInvoices                │   │
│  │                                                  │   │
│  │  inventoryRepo.checkAvailability(items)          │   │
│  │    ──► all items in stock?                      │   │
│  │                                                  │   │
│  │  PricingPolicy.calculate(items, loyaltyTier)     │   │
│  │    ──► pure function: no DB, no network         │   │
│  │                                                  │   │
│  │  inventoryRepo.reserve(items)                    │   │
│  │                                                  │   │
│  │  paymentGateway.charge(paymentMethodId, total)   │   │
│  │    ──► calls StripeAdapter                      │   │
│  │                                                  │   │
│  │  orderRepo.save(order)                           │   │
│  │                                                  │   │
│  │  eventBus.publish(OrderPlacedEvent)              │   │
│  └──────┬──────────────┬────────────────┬───────────┘   │
│         │              │                │               │
│    IOrderRepo    IInventoryRepo   IPaymentGateway        │  ← interfaces
└─────────┼──────────────┼────────────────┼───────────────┘
          │ implements   │ implements     │ implements
          ▼              ▼                ▼
┌─────────────────────────────────────────────────────────┐
│                  REPOSITORY LAYER                        │
│                                                          │
│  ┌──────────────────┐  ┌──────────────────┐            │
│  │  OrderRepository │  │InventoryRepository│            │
│  │  ─────────────── │  │──────────────────│            │
│  │  .save(order)    │  │.checkAvailability│            │
│  │  .findById(id)   │  │.reserve(items)   │            │
│  │  (Prisma ORM)    │  │(raw SQL / Prisma) │            │
│  └────────┬─────────┘  └────────┬──────────┘            │
│           │                     │                       │
│  ┌────────────────────────────────────────────────┐     │
│  │          StripeAdapter                         │     │
│  │  implements IPaymentGateway                    │     │
│  │  .charge() → stripe.charges.create(...)        │     │
│  └────────────────────────────────────────────────┘     │
└───────────┬─────────────────────────────────────────────┘
            │
            ▼
     ┌─────────────┐   ┌──────────────┐   ┌──────────────┐
     │ PostgreSQL  │   │  Redis Cache │   │  Stripe API  │
     └─────────────┘   └──────────────┘   └──────────────┘
```

---

### Interface Dependency Diagram

```
DEPENDENCY GRAPH (arrows = "imports / depends on")

OrderController     ──depends on──►  IOrderService
                                          │
                                          │ implements
                                          ▼
OrderService        ──depends on──►  IOrderRepository
                                     IUserRepository
                                     IInventoryRepository
                                     IPaymentGateway

OrderRepository     ──implements──►  IOrderRepository
  (uses Prisma inside)

StripeAdapter       ──implements──►  IPaymentGateway
  (uses Stripe SDK inside)

KEY RULE:
  OrderService NEVER imports OrderRepository directly.
  OrderService NEVER imports StripeAdapter directly.

  This means: in tests, swap them with:
    OrderService(new InMemoryOrderRepository(), new MockPaymentGateway())
  No database. No Stripe. Test runs in < 10ms.
```

---

_→ Continued in: [02-Controller-Service-Repository Pattern.md](02-Controller-Service-Repository%20Pattern.md)_
