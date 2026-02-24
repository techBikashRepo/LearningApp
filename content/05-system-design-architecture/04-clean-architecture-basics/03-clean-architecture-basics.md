# Clean Architecture Basics — Part 3 of 3

### Sections: 9 (Cloud Mapping), 10 (Tradeoff Analysis), 11 (System Design Interview), 12 (Design Exercise)

**Series:** System Design & Architecture → Topic 04

---

## SECTION 9 — Cloud Mapping

### Clean Architecture Deployed on AWS

```
Clean Architecture describes how code is ORGANIZED inside a deployment unit.
The cloud infrastructure deploys the OUTER RING (Ring 4 — Frameworks & Drivers).
The inner rings are invisible to AWS — they are just code within a process.

  AWS deploys:   the ECS task (Node.js process running Ring 4 + Ring 3 + Ring 2 + Ring 1)
  AWS does NOT know: that there is a PlaceOrderUseCase or an IOrderRepository

DEPLOYMENT:
                    Route 53 → CloudFront → ALB
                                                  │
                    ECS Fargate Task ◄─────────────┘
                    ┌──────────────────────────┐
                    │  Ring 4: Infrastructure  │  Express server, Prisma client,
                    │                          │  Stripe SDK initialization
                    │  Ring 3: Adapters        │  Controllers, Repositories
                    │  Ring 2: Use Cases       │  PlaceOrderUseCase, etc.
                    │  Ring 1: Entities        │  Order, User, Money
                    └──────────────────────────┘
                           │           │
                    ┌──────▼──┐  ┌─────▼────────┐
                    │ RDS     │  │ ElastiCache  │
                    │ Aurora  │  │ Redis        │
                    └─────────┘  └──────────────┘

ENVIRONMENT CONFIG PER RING:

  Ring 4 (infrastructure) reads secrets:
    DATABASE_URL         → AWS Secrets Manager
    STRIPE_KEY           → AWS Secrets Manager
    REDIS_URL            → AWS Secrets Manager
    LOG_LEVEL            → AWS Parameter Store

  Ring 3 (adapters) gets config injected via DI container (Ring 4 wires it).
  Ring 2 (use cases) gets only interface implementations — no secrets, no URLs.
  Ring 1 (entities) gets nothing — pure business logic, no config required.

DEPENDENCY INJECTION CONTAINER (Ring 4 — container.ts):
  This is the ONLY place where concrete implementations cross boundaries.

  // Ring 4 creates concretions and injects them inward:
  const prisma = new PrismaClient();                               // Ring 4
  const orderRepo = new PrismaOrderRepository(prisma);            // Ring 3
  const paymentGateway = new StripePaymentGateway(stripeClient);  // Ring 3
  const placeOrderUseCase = new PlaceOrderUseCase(               // Ring 2
    orderRepo,        // IOrderRepository ← concrete implementation
    userRepo,         // IUserRepository
    paymentGateway,   // IPaymentGateway
  );
  const orderController = new OrderController(placeOrderUseCase); // Ring 3
  app.post('/orders', orderController.handle.bind(orderController)); // Ring 4
```

---

### Testing Infrastructure per Ring

```
Ring 1 (Entities) tests:
  Tool: Jest / JUnit / pytest unit tests
  Infrastructure: NONE — only the project's own entity classes
  Run environment: local machine, CI runner
  Speed: < 1ms per test

Ring 2 (Use Cases) tests:
  Tool: Jest / JUnit unit tests
  Infrastructure: In-memory repository implementations (InMemoryOrderRepository)
                  MockPaymentGateway (Jest mock / Mockito)
  No database. No network. No Docker.
  Speed: 1-5ms per test

Ring 3 (Adapters) integration tests:
  Tool: Jest / JUnit integration tests
  Infrastructure: Test database (PostgreSQL in Docker Compose)
                  Stripe test mode (sandboxed, no real charges)
  Run: on PR merge or pre-deploy. NOT on every commit.
  Speed: 200ms-2s per test

Ring 4 + all rings (E2E tests):
  Tool: Supertest / Cypress / REST Assured
  Infrastructure: Full app stack in Docker Compose
  Speed: 2-10s per test
  Run: nightly or pre-prod

AWS CI/CD pipeline:
  commit → GitHub Actions → unit tests (rings 1+2) → integration tests (ring 3)
         → build Docker image → push to ECR → ECS rolling deploy
```

---

## SECTION 10 — Tradeoff Analysis

### Decision Matrix

```
┌──────────────────────┬──────────────────────────────────────────────────┐
│  DIMENSION           │  CLEAN ARCHITECTURE                              │
├──────────────────────┼──────────────────────────────────────────────────┤
│ Domain isolation     │ ✅ Maximum possible isolation.                   │
│                      │ No framework imports in Ring 1 or Ring 2.        │
│                      │ The core is a pure domain model.                 │
├──────────────────────┼──────────────────────────────────────────────────┤
│ Framework migration  │ ✅ Swapping Express → Fastify affects Ring 4 only│
│                      │ Swapping Prisma → Drizzle affects Ring 3 only    │
│                      │ Ring 1 + Ring 2: zero changes                    │
├──────────────────────┼──────────────────────────────────────────────────┤
│ Unit test speed      │ ✅ Ring 1 and Ring 2 tests: no I/O               │
│                      │ Entire business logic suite runs in < 5 seconds  │
│                      │ Catches business rule regressions instantly       │
├──────────────────────┼──────────────────────────────────────────────────┤
│ Use case visibility  │ ✅ One file per use case                         │
│                      │ "What can a user do?" = list application/ folder │
├──────────────────────┼──────────────────────────────────────────────────┤
│ Boilerplate          │ ❌ SIGNIFICANT overhead                          │
│                      │ Each feature needs: Entity + Use Case + 2x ports │
│                      │ + controller + 2x adapters + 2x mappers          │
│                      │ Simple CRUD feature: 8-10 files                  │
│                      │ (vs 3 files in CSR)                              │
├──────────────────────┼──────────────────────────────────────────────────┤
│ Learning curve       │ ❌ Steep                                         │
│                      │ DIP, ports & adapters, input/output boundaries,  │
│                      │ mapper pattern — all require deliberate learning  │
│                      │ Onboarding junior engineers: 1-2 weeks           │
├──────────────────────┼──────────────────────────────────────────────────┤
│ Premature complexity │ ❌ REAL RISK                                     │
│                      │ On a 2-developer startup CRUD app:               │
│                      │ 80% of engineering time is architecture overhead │
│                      │ instead of features.                             │
│                      │ "We're building the most elegant architecture    │
│                      │  for a product that doesn't have users yet."     │
│                      │                                                  │
│                      │ RULE: Earn this complexity through growth.       │
│                      │ Don't start here without clear justification.    │
└──────────────────────┴──────────────────────────────────────────────────┘
```

---

### The Practical Balance: "Light Clean Architecture"

Many teams adopt the principles without strict ring enforcement:

```
"LIGHT" APPROACH:
  1. Keep Entities (domain objects) framework-free. Always.
  2. Use explicit Use Case classes for complex operations (5+ steps).
     For simple CRUD: Service methods in CSR are fine.
  3. Define interfaces for all external dependencies (Repositories, Gateways).
  4. Don't mandate separate "Input/Output" models for every use case.
     For simple reads, return the domain entity (minimize boilerplate).
  5. Organize by domain, not by layer type.
     ❌ /controllers/ /services/ /repositories/  (layer-oriented)
     ✅ /orders/ /users/ /payments/              (domain-oriented, each with own controller/service/repo)

This gives you 80% of Clean Architecture's benefits with 40% of the boilerplate.
```

---

## SECTION 11 — System Design Interview Discussion

**Q: "What's the difference between Clean Architecture and a regular layered architecture?"**

> "Both separate presentation, business logic, and data access. The key difference is the Dependency Rule and interface ownership.
>
> In a standard layered architecture, the Business Logic Layer imports the Data Access Layer — it knows which repository class it's calling. The dependency goes top-to-bottom.
>
> In Clean Architecture, the Use Case layer defines an interface (IOrderRepository) and depends only on that. The repository implementation (Prisma, TypeORM, etc.) lives in an outer ring and conforms to the interface. Source code dependencies only point inward — the outer ring depends on inner ring interfaces, never the reverse.
>
> The practical consequence: In Clean Architecture, the entire business logic is testable with zero infrastructure. In standard layered, if a service imports Prisma, testing requires a running database. In Clean Architecture, the Use Case imports an interface — you provide an in-memory implementation in tests."

---

**Q: "When would you NOT use Clean Architecture?"**

> "For a 3-table CRUD API with 2 engineers, Clean Architecture would produce 3× the file count with no business rules to protect. The boilerplate would consume more time than features.
>
> I'd avoid it when: the team is small (under 6 engineers), the domain is simple (mostly data passthrough), the app is short-lived, or the team isn't familiar with DIP and ports-and-adapters. In those cases, Controller-Service-Repository with proper interfaces gives most of the testability benefit at much lower complexity.
>
> I'd adopt it when: the domain is genuinely complex with 50+ rules across multiple aggregates, multiple delivery mechanisms need the same use cases, or a framework migration is planned."

---

## SECTION 12 — Design Exercise

### Exercise: Add a New Use Case — "Suspend User Account"

**Requirement:** Admin can suspend a user account. A suspended user cannot place orders. All suspended-user actions are logged to an audit log. The suspension can include an expiry date.

**Task:** Design how this feature would be structured across the four rings of Clean Architecture.

**Think through it before reading the answer:**

---

**Answer:**

```
RING 1: Entities—

  User entity changes:
    + status: UserStatus (enum: Active | Suspended | Deleted)
    + suspendedUntil: Date | null
    + suspensionReason: string | null

    + suspend(reason: string, until: Date | null): void
        // Entity invariant: cannot suspend an already-deleted user
        if (this.status === UserStatus.Deleted)
          throw new InvalidOperationError("Cannot suspend a deleted user")
        this.status = UserStatus.Suspended
        this.suspendedUntil = until
        this.suspensionReason = reason

    + isCurrentlySuspended(): boolean
        return this.status === UserStatus.Suspended &&
               (this.suspendedUntil === null || this.suspendedUntil > new Date())

  No changes to Order entity (doesn't know about user suspension).

─────────────────────────────────────────────────────────────────
RING 2: Use Cases—

  New file: application/use-cases/SuspendUserUseCase.ts

  Input:  { adminId: string, targetUserId: string, reason: string, until?: Date }
  Output: { success: boolean; error?: 'USER_NOT_FOUND' | 'NOT_AUTHORIZED' | 'ALREADY_SUSPENDED' }

  execute(input):
    1. admin = await userRepository.findById(input.adminId)
       if (!admin || !admin.hasRole('admin')) return err('NOT_AUTHORIZED')

    2. target = await userRepository.findById(input.targetUserId)
       if (!target) return err('USER_NOT_FOUND')

    3. target.suspend(input.reason, input.until ?? null)
       // entity method validates its own invariants

    4. await userRepository.save(target)

    5. await auditLogger.log({       // ← IAdminAuditLogger interface
         action: 'SUSPEND_USER',
         performedBy: input.adminId,
         targetUserId: input.targetUserId,
         reason: input.reason,
       })

    6. return { success: true }

  New interface: application/ports/IAdminAuditLogger.ts
    log(entry: AuditEntry): Promise<void>

  Existing use case change: PlaceOrderUseCase
    After loading user:
      if (user.isCurrentlySuspended()) return err('USER_SUSPENDED')

─────────────────────────────────────────────────────────────────
RING 3: Interface Adapters—

  New: adapters/controllers/AdminUserController.ts
    PATCH /admin/users/:id/suspend → SuspendUserUseCase

  New: adapters/gateways/CloudWatchAuditLogger.ts
    implements IAdminAuditLogger
    Writes to CloudWatch Logs (structured JSON, separate log group)

  Existing: PrismaUserRepository
    + save() already handles status changes via Prisma ORM mapping
    + may need a DB migration: alter users add column suspended_until, suspension_reason

─────────────────────────────────────────────────────────────────
RING 4: Frameworks & Drivers—

  Update DI container to inject CloudWatchAuditLogger into SuspendUserUseCase.
  Register route: PATCH /admin/users/:id/suspend → AdminUserController.
  Auth middleware: this route must require admin JWT role check.
```

**What the exercise demonstrates:**

- New use case → new file, not a new method on UserService
- Entity owns the domain invariant (cannot suspend deleted user)
- New infrastructure concern (audit log) → new interface in Ring 2, new adapter in Ring 3
- Existing use case (PlaceOrderUseCase) updated minimally: one guard added
- No changes to Ring 4 frameworks or HTTP server setup (only DI container and one route)

---

## === Architect's Mental Model ===

### 5 Decision Rules

**Rule 1: If a Ring 1 or Ring 2 file has an `import` from Express, Prisma, Stripe, or any third-party infra library — that is a Dependency Rule violation. Fix it before the PR merges.**
Create a linting rule (eslint-plugin-import with path restrictions) to enforce this automatically. Do not rely on code review discipline alone.

**Rule 2: Interfaces (ports) are owned by the inner ring that uses them — NOT by the outer ring that implements them.**
`IOrderRepository` lives in `application/ports/`, not in `adapters/repositories/`. The Use Case is the consumer. The consumer defines the contract. The adapter conforms to it. This is the Dependency Inversion Principle in action.

**Rule 3: One Use Case class = one named user action = one testable unit.**
`PlaceOrderUseCase`, not `OrderUseCase` with 8 methods. Explicit Use Case classes make the application's capabilities self-documenting. The `application/use-cases/` directory IS the feature list.

**Rule 4: Use Cases communicate through Input/Output models — never expose entities at ring boundaries.**
The Controller never touches the Order entity directly. It sees only PlaceOrderOutput. This decouples the domain model from the API contract — you can evolve both independently.

**Rule 5: The Composition Root (dependency injection container) is the only place outside the domain that is allowed to know about every concrete implementation.**
If your OrderController somehow knows it's using PrismaOrderRepository — that's a violation. It should only know about IOrderRepository. Only the DI container knows about Prisma.

---

### 3 Common Mistakes

**Mistake 1: Applying Clean Architecture to every project by default.**
Clean Architecture has a real cost: 3-4× the file count of simple CSR. On a 2-person team building an MVP, this overhead kills feature velocity. Framework-independence is only valuable if you plan to change frameworks. "We'll never migrate from PostgreSQL" means the Repository abstraction has no ROI. Apply Clean Architecture proportionally to domain complexity and team size.

**Mistake 2: Putting business logic in "mappers."**
Mappers (transforming between domain objects and DB/API shapes) sometimes grow to include validation, default values, or computation. "The mapper set order.status to 'active' if paymentDate is set" — this is a business rule that belongs in the entity or use case, not in a mapper. Mappers should be pure structural transformations with no conditional logic.

**Mistake 3: Creating thin Use Cases that just delegate to repositories.**

```
// WRONG: Use Case with no logic
class GetOrderUseCase {
  execute(id) { return this.orderRepository.findById(id); }
}
// This is not a use case. It's an unnecessary layer.
// Just call the repository from the controller for simple reads.
```

A Use Case earns its existence by encapsulating application logic, business rules, or orchestration across multiple gateways. A Use Case that is a one-line repository call is indirection without value.

---

### 30-Second Interview Answer

> "Clean Architecture organizes code into four concentric rings: Entities contain enterprise-wide business rules with no external dependencies; Use Cases contain application-specific rules and orchestrate entities; Interface Adapters translate between the protocol (HTTP, gRPC, CLI) and the use case layer; Frameworks and Drivers contain Express, Prisma, Stripe — the infrastructure details. The Dependency Rule is absolute: source code dependencies can only point inward. Outer rings conform to interfaces defined by inner rings — never the reverse. The payoff: every business rule in Ring 1 and Ring 2 is unit-testable without a database, without an HTTP server, without any external service. The cost: significant boilerplate and a steeper learning curve. Justified when the domain is complex, the codebase will outlive its framework, or multiple delivery mechanisms share the same business logic."

---

_End of Topic 04 — Clean Architecture Basics_
_→ Next: Topic 05 — Backend-for-Frontend (BFF)_
