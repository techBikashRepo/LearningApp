# Clean Architecture Basics — Part 1 of 3

_→ Continued in: [02-Clean Architecture Basics.md](02-Clean%20Architecture%20Basics.md)_---`        └── container.ts             Composition Root — wires everything    └── di/    │   └── prisma.client.ts         PrismaClient singleton    ├── database/    │   └── server.ts                Express app setup, routes    ├── http/└── infrastructure/                  ← RING 4: Frameworks & Drivers││       └── StripePaymentGateway.ts  ← implements IPaymentGateway│   └── gateways/│   │   └── PrismaOrderRepository.ts ← implements IOrderRepository│   ├── repositories/│   │   └── OrderController.ts│   ├── controllers/├── adapters/                        ← RING 3: Interface Adapters││       └── IPaymentGateway.ts│       ├── IUserRepository.ts│       ├── IOrderRepository.ts│   └── ports/                       ← Interfaces (owned by Ring 2)│   │   └── RegisterUserUseCase.ts│   │   ├── CancelOrderUseCase.ts│   │   ├── PlaceOrderUseCase.ts│   ├── use-cases/├── application/                     ← RING 2: Use Cases││       └── DomainErrors.ts          InvalidOrderError, etc.│   └── errors/│   │   └── Email.ts                 Validated email value object│   │   ├── OrderId.ts               Typed ID (wraps string UUID)│   │   ├── Money.ts                 Value object: amount + currency│   ├── value-objects/│   │   └── User.ts│   │   ├── OrderItem.ts│   │   ├── Order.ts                 Order entity with business invariants│   ├── entities/├── domain/                          ← RING 1: Entitiessrc/`### Folder/Module Structure Mapping---`  This is the Dependency Inversion Principle (DIP) in practice.  At RUNTIME, the use case calls the concrete implementation via the interface.  The source code dependency points INWARD (Ring 3 → Ring 2 interface).  The REPOSITORY IMPLEMENTATION (Ring 3) conforms to it.  The USE CASE (Ring 2) owns the interface.                              (lives in Ring 3, knows about Prisma)                              PrismaOrderRepository                                     │ implements                                     ▲  Use Case ──── defines ────► IOrderRepository (interface, lives in Ring 2)CLEAN ARCHITECTURE (dependency inversion):  ↑ Use Case depends on outer-ring implementation — wrong!                                              outer ring)  (inner ring)                               (knows about Prisma,  Use Case ──────────────────────────────────► OrderRepositoryTRADITIONAL (layered):`### Dependency Inversion Across the Ring Boundary---`Ring 1 → Ring 4:   NEVER.Ring 1 → Ring 3:   NEVER.Ring 1 → Ring 2:   NEVER. Entities know nothing about Use Cases.                   Ring 3 provides the implementation. Dependency inverted.Ring 2 → Ring 3:   NEVER. Use Case defines IOrderRepository (interface).Ring 2 → Ring 1:   PlaceOrderUseCase calls Order.create(), Order.cancel()                   PlaceOrderController instantiates PlaceOrderUseCaseRing 3 → Ring 2:   PrismaOrderRepository implements IOrderRepositoryRing 4 → Ring 3:   Express imports and calls PlaceOrderController                    ═══════════                    DEPENDENCIES╚══════════════════════════════════════════════════════════════════╝║  └──────────────────────────────────────────────────────────┘    ║║  │  └────────────────────────────────────────────────┘     │    ║║  │  │  └──────────────────────────────────────────┘  │     │    ║║  │  │  │   ZERO external imports                  │  │     │    ║║  │  │  │   Domain errors: InvalidOrderError       │  │     │    ║║  │  │  │   Value Objects: OrderId, UserId         │  │     │    ║║  │  │  │   Order, OrderItem, User, Money          │  │     │    ║║  │  │  │  RING 1: ENTITIES                        │  │     │    ║║  │  │  ┌──────────────────────────────────────────┐  │     │    ║║  │  │   IPaymentGateway  (interface — defined here)  │     │    ║║  │  │   IOrderRepository (interface — defined here)  │     │    ║║  │  │   RegisterUserUseCase                          │     │    ║║  │  │   CancelOrderUseCase                           │     │    ║║  │  │   PlaceOrderUseCase                            │     │    ║║  │  │  RING 2: USE CASES                             │     │    ║║  │  ┌────────────────────────────────────────────────┐     │    ║║  │   External Service Adapters (StripeAdapter, etc.)       │    ║║  │   Controllers, Presenters, Repository Implementations   │    ║║  │  RING 3: INTERFACE ADAPTERS                              │    ║║  ┌──────────────────────────────────────────────────────────┐    ║║   Express / Fastify    PostgreSQL    Redis    Stripe SDK         ║║  RING 4: FRAMEWORKS & DRIVERS                                    ║╔══════════════════════════════════════════════════════════════════╗`### The Full Concentric Circle Diagram## SECTION 4 — ASCII Architecture Diagrams---`  app.listen(3000);  app.post('/orders', placeOrderController.handle);  app.use(express.json());  const app = express();Most of Ring 4 is configuration, not logic:provides the runtime environment for the inner rings.This is the "glue" ring. It wires everything together and   • Domain entities  • Use case logic  • Business rulesWHAT THEY DO NOT CONTAIN:  • ORM model definitions / schema files  • Database connection management  • Dependency injection container / Composition Root  • Framework configuration (Express app setup, middleware stack)WHAT THEY CONTAIN:  Jest, JUnit (test framework)  PostgreSQL, Redis, MongoDB (databases)  Stripe SDK, SendGrid SDK (external service clients)  Prisma, TypeORM, Hibernate (ORM)  Express, Fastify, NestJS (HTTP framework)WHAT THEY ARE:`### Ring 4: Frameworks & Drivers---`}  }    return record ? OrderMapper.toDomain(record) : null;    });      include: { items: true }      where: { id: id.value },    const record = await this.prisma.order.findUnique({  async findById(id: OrderId): Promise<Order | null> {  }    return OrderMapper.toDomain(record);    });      include: { items: true }      data: OrderMapper.toPrismaModel(order),    const record = await this.prisma.order.create({  async save(order: Order): Promise<Order> {  constructor(private prisma: PrismaClient) {}class PrismaOrderRepository implements IOrderRepository {// Implementation lives in Ring 3 (Interface Adapters)}  findById(id: OrderId): Promise<Order | null>;  save(order: Order): Promise<Order>;interface IOrderRepository {// Interface defined in Ring 2 (Use Case ring)GATEWAY in Clean Architecture:}  }    res.status(201).json({ order_id: output.orderId });    }      return;      res.status(statusMap[output.error] ?? 500).json({ error: output.error });      const statusMap = { USER_NOT_FOUND: 404, INSUFFICIENT_STOCK: 409, PAYMENT_FAILED: 402 };    if (!output.success) {    // Translation: Use Case Output → HTTP Response    const output = await this.placeOrderUseCase.execute(input);    // Execute    };      })),        quantity: item.qty,        productId: item.product_id,      items: req.body.items.map(item => ({      userId: req.user.id,    const input: PlaceOrderInput = {    // Translation: HTTP → Use Case Input  async handle(req: Request, res: Response): Promise<void> {  constructor(private placeOrderUseCase: PlaceOrderUseCase) {}class PlaceOrderController {CONTROLLER in Clean Architecture:                 (Repository implementations, external service adapters)    Gateways:    Implement the interfaces defined by Use Cases    Presenters:  Convert Use Case Output → View Model                 Convert Use Case Output → HTTP Response    Controllers: Convert HTTP Request → Use Case Input  Types:    to the format the inner rings (Use Cases, Entities) can use.  Translators. They convert data from the format of the outer ringWHAT THEY ARE:`### Ring 3: Interface Adapters---`  ✅ One class = one use case = one unit of testability  ✅ Depends ONLY on interfaces (Ring 3 provides implementations)  ✅ NOT Express Request/Response  ✅ Input/Output types are own domain types (PlaceOrderInput, PlaceOrderOutput)KEY PROPERTIES:}  }    return { success: true, orderId: savedOrder.id };    const savedOrder = await this.orderRepository.save(order);    // Save the order (via interface — Use Case doesn't know it's PostgreSQL)    if (!charge.success) return { success: false, error: 'PAYMENT_FAILED' };    const charge = await this.paymentGateway.charge(user.paymentMethodId, order.total);    // Application-level rule: process payment    if (!available) return { success: false, error: 'INSUFFICIENT_STOCK' };    const available = await this.inventoryGateway.checkAvailability(input.items);    // Application-level rule: check inventory    const order = Order.create({ userId: input.userId, items: input.items });    // Application-level rule: create order entity (entity validates its own invariants)    if (!user) return { success: false, error: 'USER_NOT_FOUND' };    const user = await this.userRepository.findById(input.userId);    // Application-level rule: user must exist  async execute(input: PlaceOrderInput): Promise<PlaceOrderOutput> {  ) {}    private inventoryGateway: IInventoryGateway,    private paymentGateway: IPaymentGateway,    private userRepository: IUserRepository,    private orderRepository: IOrderRepository,    // ← interface (Ring 2/3 boundary)  constructor(class PlaceOrderUseCase {EXAMPLES:  They change when the APPLICATION's rules change (not when infra changes).  They orchestrate entities and define interactions with gateways.  NOT a service class with 20 methods — ONE class per use case.  Explicit objects that represent ONE specific application action.WHAT THEY ARE:`### Ring 2: Use Cases (Application Business Rules)---`  ✅ Can be shared across multiple applications/use cases  ✅ Captures invariants that must ALWAYS be true  ✅ Testable with new Order() — no mock needed  ✅ No imports from outer ringsKEY PROPERTIES:}  }    // ...    if (amount < 0) throw new InvalidMoneyError("Amount cannot be negative");  static of(amount: number, currency: string): Money {  // Enterprise rule: money cannot be negative  // Value object (no identity, defined by value)class Money {}  }    // ...    }      throw new InvalidOrderError("Order must have at least one item");    if (params.items.length === 0) {  static create(params: CreateOrderParams): Order {  // Enterprise rule: validation in the entity constructor/factory  }    this._cancellationReason = reason;    this._status = OrderStatus.Cancelled;    }      throw new InvalidOperationError("Cannot cancel a shipped order");    if (this._status === OrderStatus.Shipped) {  cancel(reason: string): void {  // Enterprise rule: encapsulated in the entity  private _total: Money;  private _status: OrderStatus;  readonly items: OrderItem[];  readonly userId: UserId;  readonly id: OrderId;class Order {EXAMPLES:  They have NO dependencies on frameworks, databases, or UI.  They change the LEAST — only if the fundamental business rules change.  Plain objects that encapsulate the most general, high-level rules.WHAT THEY ARE:`### Ring 1: Entities (Enterprise Business Rules)---`                 Nothing in an inner ring knows about an outer ring.DEPENDENCY RULE: Source code dependencies can only point INWARD.└───────────────────────────────────────────────────────────┘│  └───────────────────────────────────────────────────┘    ││  │  └──────────────────────────────────────────┘     │    ││  │  │  └──────────────────────────────────────┘│     │    ││  │  │  │  RING 1: ENTITIES (Enterprise Rules)  ││     │    ││  │  │  ┌──────────────────────────────────────┐│     │    ││  │  │  RING 2: USE CASES (Application Rules)   │     │    ││  │  ┌──────────────────────────────────────────┐     │    ││  │  RING 3: INTERFACE ADAPTERS                       │    ││  ┌───────────────────────────────────────────────────┐    ││  RING 4: FRAMEWORKS & DRIVERS (outermost)                 │┌───────────────────────────────────────────────────────────┐`### The Four Rings of Clean Architecture## SECTION 3 — Component Responsibilities---`  It is necessary for applications that will grow beyond framework scope.  Clean Architecture is not necessary for every application.  For these: Controller-Service-Repository is sufficient and faster.    ❌ Short-lived project (< 6 months lifespan)  ❌ The domain has no real business logic (pure data passthrough)  ❌ Team < 6 engineers (cognitive overhead slows everyone down)  ❌ Writing a 3-route CRUD API for an MVP (overhead outweighs benefit)DO NOT use Clean Architecture when:  ✅ Compliance / enterprise environment where domain logic auditability matters     (the same use cases called from 4 different interfaces)  ✅ Multiple delivery mechanisms: HTTP API + gRPC + CLI + message queue handlers     (you KNOW you'll eventually migrate from Express to a newer framework)  ✅ The application will outlive its original framework   ✅ Team > 15-20 engineers on the same codebase  ✅ The domain is genuinely complex (50+ business rules, multiple aggregates)USE Clean Architecture when:`### When Clean Architecture Is Justified---`  These tests are deterministic, fast (< 1ms each), and comprehensive.  without starting a server, without a database, without any external service.  You can run ALL of your core business logic testsRESULT:        - Business logic is unit-testable at nanosecond speed        - External service swaps are infrastructure-only changes        - Database migrations don't affect business rules        - Framework upgrades don't touch core logic      If your core business logic is clean of these imports:              - Your test framework (Jest, JUnit)        - Your external service SDKs (Stripe, SendGrid, Twilio)        - Your ORM (Prisma, Hibernate, SQLAlchemy)        - Your HTTP framework (Express, FastAPI, Spring)      that have ZERO imports from:      as a set of plain TypeScript/Java/Python classesGOAL: The business logic of your application should be expressible`### What Clean Architecture Solves---- The business rules of your application are **entangled** with the version of a third-party library.- Upgrade Express v4 → v5 (breaking changes): grep all services for `Request` usage.- Swap PostgreSQL for MongoDB: modify every line in `OrderService` that calls `this.prisma`.- To test `createOrder`, you must have Express, a running PostgreSQL (Prisma), and a Stripe test account.**What this means:**`}  }    const charge = await this.stripe.charges.create({...});  // ← Stripe SDK in service    // ...    });      where: { id: req.user.id }                      // ← req.user (Express concept) in service    const user = await this.prisma.user.findUnique({  // ← Prisma ORM in service  async createOrder(req: Request) {  // ← Express Request in the service  private stripe = new Stripe(process.env.STRIPE_KEY);  private prisma = new PrismaClient();  // Prisma client hardcoded in the serviceclass OrderService {import Stripe from 'stripe';import { PrismaClient } from '@prisma/client';  // ← ORM in the serviceimport { Request } from 'express';// "Service" layer that imports Express`typescriptAfter 3 years, most "well-structured" codebases look like this under the hood:### The Problem: Framework Dependency Infection## SECTION 2 — Problem Solved---`               OrderRepository (outer ring) ──implements──► IOrderRepository  In Clean:    UseCase ──imports──► IOrderRepository (interface, inner ring)  In Layered:  BLL    ──imports──► OrderRepository (concrete, SQL)  The DEPENDENCY IS INVERTED:    The repository implementation (outer ring) implements the interface (inner ring).  The Use Case does NOT know if IOrderRepository is backed by PostgreSQL or MongoDB.  Business Logic (Use Cases) defines an interface: IOrderRepository.  All outer rings depend on inner rings — never the reverse.CLEAN ARCHITECTURE:  If you add a MongoDB adapter, the BLL must import something different.  Problem: the BLL "knows about" the repository.  Business Logic → Data Access Layer → Database  Top → Bottom (one direction of calls)LAYERED ARCHITECTURE:`### Contrast with Layered Architecture---**This is the Dependency Rule:** Dependencies can only point INWARD. The outermost ring (infrastructure) depends on the inner rings. The inner rings know NOTHING about the outer rings.**The key insight:** The innermost ring (Constitution) knows NOTHING about the outer rings. The Constitution was written before the IRS existed. It doesn't reference any government department. It is the most stable, most fundamental layer — and it changes the least.`               is behind the scenes — the application rules operate the same.               These are DETAILS. The business doesn't care which database  In software: Express, Prisma, Stripe SDK, PostgreSQL, React.    stored on paper or in a computer system.  These are interchangeable. The constitution doesn't care if records are  The POST OFFICE (SendGrid), the FEDERAL COURTHOUSE DATABASE (PostgreSQL).  The buildings, post offices, computer systems, roads.LAYER 4: THE PHYSICAL INFRASTRUCTURE (Frameworks & Drivers)               They translate Use Case output → HTTP response.               They translate HTTP → Use Case input.  In software: Controllers, Presenters, Gateway adapters.     the format the law requires."  "We accept paper FORMS (HTTP requests) and translate them into    and the internal federal processes.  The DMV, IRS, Post Office — they translate between citizens' needsLAYER 3: THE GOVERNMENT DEPARTMENTS (Interface Adapters)               This process doesn't change when you swap from Stripe to Braintree.  In software: "To place an order: validate cart → check inventory → charge card → create order"    The process is the same whether Immigration uses Oracle or PostgreSQL.  But they do NOT change based on what software system processes the applications.  These rules CAN change by act of Congress.    "To become a citizen, you must: [specific process]."  Laws specific to HOW the government operates.LAYER 2: THE FEDERAL LAWS (Use Cases / Application Rules)               These are enterprise-level rules that survive any tech migration.               "A User cannot have duplicate email addresses."  In software: "An Order cannot have a negative total."    This rule DOES NOT CHANGE when infrastructure changes.  This is not tied to whether the court system uses paper files or digital records.  This is not tied to the Department of Labor's software system.  Example: "All citizens have the right to liberty."    or whether the government is a democracy or republic.  which software system the government uses,  These rules exist regardless of who the president is,  The fundamental laws of the land.LAYER 1: THE CONSTITUTION (Entities / Enterprise Rules)`Clean Architecture (Robert C. Martin, "Uncle Bob," 2012) is often called "the architecture that makes your business logic independent of everything else." To understand why, think about how a country's laws are organized.### A Nation-State with Its Constitution## SECTION 1 — Real-World Analogy---**Series:** System Design & Architecture → Topic 04### Sections: 1 (Real-World Analogy), 2 (Problem Solved), 3 (Component Responsibilities), 4 (ASCII Diagrams)### Sections: 1 (Real-World Analogy), 2 (Problem Solved), 3 (Component Responsibilities), 4 (ASCII Diagrams)
**Series:** System Design & Architecture → Topic 04

---

## SECTION 1 — Real-World Analogy

### A Country's Legal System

Robert C. Martin (Uncle Bob) published Clean Architecture in 2017, but the concept predates it — it's the same principle that makes any stable institution outlive its tools.

```
INNER RING: Constitutional Law (Entities)
─────────────────────────────────────────
  The fundamental rights and principles that define the country.
  These never change based on who is in power.
  "Murder is prohibited." "Citizens have the right to trial."
  Independent of: which government is in charge, what technology courts use,
                  what president signed which bill.

  In software: Enterprise-wide business rules. "An Order must have at least one item."
               "A User cannot have negative account balance." Pure domain logic.
               Depends on NOTHING external.

SECOND RING: Application Law (Use Cases)
─────────────────────────────────────────
  How constitutional principles are applied in specific processes.
  "To extradite a criminal: the requesting country submits a treaty request.
   The court reviews constitutional eligibility. The minister approves."
  Uses: Constitutional law (inner ring). Knows: the process to execute.
  Independent of: whether the request came by fax, email, or hand-delivered.

  In software: Use Cases. "RegisterNewUser: validate email uniqueness, hash password,
               create User entity, send verification email."
               Orchestrates Entities (inner ring). Defines app-specific workflow.
               Does NOT know: Express, PostgreSQL, Stripe.

THIRD RING: Administrative Process (Interface Adapters)
─────────────────────────────────────────────────────────
  The courts, police, civil servants who translate between
  the outer world and the inner legal system.
  "A judge translates a citizen's testimony (HTTP request)
   into a formal deposition (Use Case input DTO)."
  "A clerk translates a legal ruling into a public record (DB row)."

  In software: Controllers, Presenters, Repository implementations, Gateways.
               Convert between external formats (HTTP, JSON, SQL rows)
               and the internal domain format (Entities, Use Case DTOs).

OUTER RING: The World (Frameworks & Drivers)
─────────────────────────────────────────────
  The physical tools: courtrooms, paper forms, filing cabinets, fax machines.
  These change constantly. Fax → email → digital portal.
  The laws inside don't change when the filing system changes.

  In software: Express, PostgreSQL, React, Stripe API, Redis, Kafka.
               These are PLUGINS to the business logic.
               The business logic doesn't know or care which framework is in use.
```

**The key insight:** The Constitution (Entities) has never been rewritten because fax machines became email. Your business rules should never need to change because PostgreSQL was replaced with MongoDB or Express was replaced with Fastify.

---

### The Plugin Analogy

```
Think of your business rules as a power outlet.

The outlet (business rules, use cases) has a standard interface.
Plugs (frameworks, databases, UIs) come in many shapes.

You can plug in:
  └── An Express REST API
  └── A gRPC server
  └── A CLI command
  └── A cron job
  └── A Kafka consumer
  └── A test harness

None of these change what the outlet IS — only how it's accessed.

When you run the application:
  WRONG: "My app is an Express app that does some business logic."
  RIGHT: "My app is a business logic system. Express happens to be one delivery mechanism."

This distinction becomes critical when:
  • You need to expose the same logic via gRPC AND REST
  • You want to write business logic tests at 1ms speed (no HTTP, no DB)
  • You need to replace PostgreSQL with DynamoDB for one service
  • You want to run business logic in a Lambda function AND a traditional server
```

---

## SECTION 2 — Problem Solved

### The Problem: Framework-Coupled Core Logic

Without Clean Architecture, the business logic becomes entangled with the framework:

```typescript
// BEFORE CLEAN ARCHITECTURE — "Express App with Business Logic"
// The domain entities know about Sequelize
@Table({ tableName: "orders" })
class Order extends Model {
  @Column userId: string;
  @Column total: number;
  @Column status: string; // 'pending' | 'confirmed' | 'cancelled'

  // Business method mixed with ORM model
  async cancel(): Promise<void> {
    if (this.status !== "pending") {
      throw new Error("Can only cancel pending orders");
    }
    this.status = "cancelled";
    await this.save(); // ← Order entity directly calls DB. Business rule + DB coupled.
  }
}

// The use case is scattered between the ORM model and the route handler
router.post("/orders/:id/cancel", async (req, res) => {
  const order = await Order.findByPk(req.params.id); // ORM in controller
  await order.cancel(); // Business rule + DB save in one call
  res.json(order);
});
```

**What is wrong:**

- Testing `Order.cancel()` requires a database (it calls `this.save()`)
- Swap Sequelize for Prisma → `Order` entity must change (it extends `Model`)
- The "cancel an order" use case is split between the model and the route — no single place to look at the full logic
- Run the cancellation logic in a background job (no HTTP context): impossible cleanly

---

### What Clean Architecture Solves

```
PROBLEM 1: Business rules are tightly coupled to the database ORM
→ SOLUTION: Entities are plain objects. They know NOTHING about databases.
            Order.cancel() updates state in memory. The Repository saves to DB.
            Swap Sequelize for Prisma: zero impact on business rules.

PROBLEM 2: Business rules are coupled to the web framework
→ SOLUTION: Use Cases receive plain input DTOs. Return plain output DTOs.
            They never receive Express Request objects.
            Swap Express for Fastify: zero impact on use cases.

PROBLEM 3: No single place to understand what the application does
→ SOLUTION: Use Cases are explicit named objects.
            Looking at the use-cases/ folder tells you exactly what the system does:
              RegisterUser, PlaceOrder, CancelOrder, ProcessRefund, GenerateInvoice
            No need to read routes, controllers, or SQL to understand the business logic.

PROBLEM 4: The test suite requires a running server and database
→ SOLUTION: Use Cases depend on Repository interfaces.
            In tests: inject InMemoryUserRepository, InMemoryOrderRepository.
            Business rule tests: 0 infrastructure, sub-millisecond execution.

PROBLEM 5: Frameworks change, but business rules don't
→ SOLUTION: The Dependency Rule: code dependencies point INWARD only.
            Entities (innermost ring) depend on nothing external.
            Use Cases depend only on Entities and interfaces.
            Frameworks depend on Use Cases — not the reverse.
```

---

### When Clean Architecture Is the Right Choice

```
USE IT when:
  ✅ Domain complexity is high (many business rules, many entity relationships)
  ✅ Long-lived application (5+ years expected)
  ✅ Multiple delivery mechanisms needed (REST + gRPC + CLI + messaging)
  ✅ Large teams (10+ engineers) who need strict boundaries
  ✅ Regulatory domain requiring full auditability and testability of rules
     (fintech, healthcare, insurance)
  ✅ Codebase will outlive the framework it was built on

DO NOT USE when:
  ❌ Simple CRUD app (CSR/Layered Architecture is sufficient and leaner)
  ❌ Small team (2-4 engineers) — overhead to maintain explicit Use Case objects
  ❌ Short-lived project (prototype, MVP, script)
  ❌ The domain has no business rules — just reads/writes

PRACTICAL RECOMMENDATION:
  Start with Controller-Service-Repository (Topic 03).
  Migrate toward Clean Architecture when ANY of these appear:
    • Service classes exceeding 500 lines
    • Business rules that need to run outside of HTTP context
    • Need to add a second delivery mechanism (gRPC, CLI, queue consumer)
    • Test suite requires a live database to test business logic
```

---

## SECTION 3 — Component Responsibilities

### The Four Concentric Rings

```
RING 1 — ENTITIES (Enterprise Business Rules)
─────────────────────────────────────────────────────────────────────
CONTAINS:
  • Business objects that embody the most general and high-level rules
  • Can be used across multiple applications in the company
  • Encapsulate data + the business rules that operate on that data
  • Pure objects: no framework dependency, no DB dependency

EXAMPLES:
  class Order {
    private status: OrderStatus;
    private items: OrderItem[];

    cancel(reason: string): void {
      if (!this.isCancellable()) throw new OrderCancellationError('Order cannot be cancelled');
      this.status = OrderStatus.CANCELLED;
      this.cancellationReason = reason;
      this.addDomainEvent(new OrderCancelledEvent(this));
    }

    isCancellable(): boolean {
      return [OrderStatus.PENDING, OrderStatus.CONFIRMED].includes(this.status)
        && !this.hasShipped();
    }

    // No .save(), no prisma.order.update, no express.send()
    // Pure domain logic. Testable with zero infrastructure.
  }

DOES NOT KNOW ABOUT:
  • Databases (no ORM inheritance, no .save())
  • HTTP (no Request, no Response)
  • Frameworks (no Express, no NestJS decorators*)
  • External services (no Stripe, no SendGrid)

  * NestJS entity decorators (@Entity, @Column) are a framework intrusion.
    Clean Architecture proponents argue against this.
    Pragmatic teams accept @Entity decorators but keep business methods framework-free.

───────────────────────────────────────────────────────────────────────

RING 2 — USE CASES (Application Business Rules)
─────────────────────────────────────────────────────────────────────
CONTAINS:
  • Application-specific business rules
  • Orchestrate the flow to and from Entities
  • One Use Case class = one user action or system operation
  • Carry the full audit trail: "what does this application allow users to do?"

STRUCTURE:
  class CancelOrderUseCase {
    constructor(
      private orderRepository: IOrderRepository,  // ← interface (not Prisma)
      private paymentGateway: IPaymentGateway,     // ← interface (not Stripe)
      private eventBus: IEventBus,
    ) {}

    async execute(input: CancelOrderInput): Promise<CancelOrderOutput> {
      // 1. Retrieve entity
      const order = await this.orderRepository.findById(input.orderId);
      if (!order) return { success: false, error: 'OrderNotFound' };

      // 2. Check authorization (application rule: only owner can cancel)
      if (order.userId !== input.requestingUserId) {
        return { success: false, error: 'Unauthorized' };
      }

      // 3. Delegate to entity (enterprise rule: is it cancellable?)
      order.cancel(input.reason);  // throws if not cancellable

      // 4. Handle refund (application orchestration)
      if (order.isEligibleForRefund()) {
        await this.paymentGateway.refund(order.chargeId, order.total);
      }

      // 5. Persist
      await this.orderRepository.save(order);

      // 6. Notify
      await this.eventBus.publish(order.pullDomainEvents());

      return { success: true, order: CancelOrderOutput.fromDomain(order) };
    }
  }

DOES NOT KNOW ABOUT:
  • HTTP (no Request/Response)
  • Which database is used (depends on IOrderRepository interface)
  • Which payment provider (depends on IPaymentGateway interface)
  • How the result will be rendered (returns plain DTO)

───────────────────────────────────────────────────────────────────────

RING 3 — INTERFACE ADAPTERS (Controllers, Presenters, Gateways)
─────────────────────────────────────────────────────────────────────
CONTAINS:
  • Controllers: Convert incoming data (HTTP, gRPC, CLI) → Use Case input DTO
  • Presenters: Convert Use Case output → outgoing format (JSON, HTML, protobuf)
  • Repository implementations: Convert DB rows ↔ Domain entities
  • Gateway implementations: Wrap external APIs (Stripe, SendGrid)

JOBS:
  Controller (HTTP adapter):
    HTTP Request → parse/validate → CancelOrderInput → execute → CancelOrderOutput → HTTP Response

  Repository implementation:
    IOrderRepository.findById(id) → Prisma query → ORM row → Order entity
    IOrderRepository.save(order) → Order entity → Prisma entity → DB write

  StripeAdapter:
    IPaymentGateway.refund(chargeId, amount) → Stripe SDK call → RefundResult

───────────────────────────────────────────────────────────────────────

RING 4 — FRAMEWORKS & DRIVERS (Express, PostgreSQL, React, Redis)
─────────────────────────────────────────────────────────────────────
  The outermost ring. Contains the glue code that makes the outside world
  talk to the Interface Adapters.

  • Express router setup
  • Prisma client initialization
  • Redis connection config
  • React component tree
  • Kafka consumer setup

  This ring is replaceable. If you swap Express for Fastify, only this ring changes.
  Entities, Use Cases, and most Interface Adapters: unchanged.
```

---

## SECTION 4 — ASCII Architecture Diagrams

### The Concentric Rings (Clean Architecture Classic View)

```
╔═══════════════════════════════════════════════════════════════╗
║                 FRAMEWORKS & DRIVERS                          ║
║   Express   PostgreSQL   Redis   Stripe   React   Kafka       ║
║                                                               ║
║  ┌─────────────────────────────────────────────────────┐      ║
║  │              INTERFACE ADAPTERS                     │      ║
║  │  Controllers  Repositories  Gateways  Presenters   │      ║
║  │                                                     │      ║
║  │  ┌───────────────────────────────────────────┐     │      ║
║  │  │             USE CASES                     │     │      ║
║  │  │    Application-specific business rules    │     │      ║
║  │  │    CancelOrder, RegisterUser, PlaceOrder  │     │      ║
║  │  │                                           │     │      ║
║  │  │  ┌─────────────────────────────────────┐  │     │      ║
║  │  │  │           ENTITIES                  │  │     │      ║
║  │  │  │  Enterprise business rules          │  │     │      ║
║  │  │  │  Order, User, Payment, Invoice      │  │     │      ║
║  │  │  │  Pure domain objects                │  │     │      ║
║  │  │  └─────────────────────────────────────┘  │     │      ║
║  │  └───────────────────────────────────────────┘     │      ║
║  └─────────────────────────────────────────────────────┘      ║
╚═══════════════════════════════════════════════════════════════╝

THE DEPENDENCY RULE (mandatory):
  Source code dependencies can only point INWARD.

  ✅ ALLOWED:         ❌ FORBIDDEN:
  Framework → Adapter    Entity → Use Case
  Adapter → Use Case     Entity → Framework
  Use Case → Entity      Use Case → Framework
                         Use Case → Adapter (concrete)
                         Use Case imports Prisma/Express/Stripe directly
```

---

### Request Flow: Cancel Order (Clean Architecture)

```
HTTP REQUEST: POST /orders/ord_123/cancel
Body: { reason: "changed my mind" }

RING 4 — FRAMEWORK:
  Express router receives request
  Passes to CancelOrderController.handle(req, res)

RING 3 — INTERFACE ADAPTERS:
  CancelOrderController:
    Parses: orderId = req.params.id, reason = req.body.reason
    Auth:   requestingUserId = req.user.id

    Builds input DTO: CancelOrderInput { orderId, requestingUserId, reason }

    Calls: cancelOrderUseCase.execute(cancelOrderInput)

    Receives: CancelOrderOutput { success: true, order: {...} }

    Presents: HTTP 200 { order_id, status: "cancelled", ... }

RING 2 — USE CASES:
  CancelOrderUseCase.execute(CancelOrderInput):
    Calls: IOrderRepository.findById(orderId)      ← calls Ring 3 (adapter, not Prisma directly)
    Calls: order.cancel(reason)                    ← calls Ring 1 entity
    Calls: IPaymentGateway.refund(...)             ← calls Ring 3 (adapter)
    Calls: IOrderRepository.save(order)            ← calls Ring 3 (adapter)
    Returns: CancelOrderOutput

RING 1 — ENTITIES:
  Order.cancel(reason):
    if (!this.isCancellable()) throw OrderCancellationError
    this.status = CANCELLED
    this.addDomainEvent(new OrderCancelledEvent(this))
    (Pure in-memory operation. No DB. No HTTP. No Stripe.)

RING 3 back to RING 4 — ADAPTERS → INFRASTRUCTURE:
  OrderRepository (adapter):
    IOrderRepository.findById → Prisma query → maps row to Order entity → returns entity
    IOrderRepository.save(order) → maps entity to Prisma data → db.order.update(...)

  StripeAdapter:
    IPaymentGateway.refund → stripe.refunds.create(...)
```

---

_→ Continued in: [02-Clean Architecture Basics.md](02-Clean%20Architecture%20Basics.md)_
