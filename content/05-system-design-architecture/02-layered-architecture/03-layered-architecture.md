# Layered Architecture — Part 3 of 3

### Sections: 9 (Cloud Mapping), 10 (Tradeoff Analysis), 11 (System Design Interview), 12 (Design Exercise)

**Series:** System Design & Architecture → Topic 02

---

## SECTION 9 — Cloud Mapping

### AWS Deployment of a Layered Architecture

```
┌─────────────────────────────────────────────────────┐
│                  CLIENT TIER                         │
│   Browser / Mobile App / Partner API                 │
└──────────────────────────┬──────────────────────────┘
                           │ HTTPS
                           ▼
┌─────────────────────────────────────────────────────┐
│              PRESENTATION LAYER (AWS)                │
│                                                      │
│   Amazon CloudFront (CDN + WAF)                      │
│     • Edge caching for static assets                 │
│     • DDoS protection                                │
│     • SSL termination                                │
│              │                                       │
│   Application Load Balancer (ALB)                    │
│     • Routes /api/* to backend service               │
│     • Routes /static/* to S3                        │
│     • Health checks on /health endpoint              │
│              │                                       │
│   AWS ECS Fargate (containers) or EC2 Auto Scaling   │
│     Runs: Express/Fastify Node.js app                │
│       ├─ Presentation Layer: Controllers, Routes     │
│       ├─ Auth Middleware (JWT validation)            │
│       └─ Input validation (Zod/Joi)                  │
└──────────────────────────┬──────────────────────────┘
                           │ (in-process function calls — no network hop)
                           ▼
┌─────────────────────────────────────────────────────┐
│            BUSINESS LOGIC LAYER (in-process)         │
│                                                      │
│   OrderService, UserService, PaymentService          │
│     • Domain entities                                │
│     • Business rules                                 │
│     • Repository and gateway interfaces              │
│                                                      │
│   Note: BLL runs inside the SAME process as          │
│   Presentation Layer. No network overhead.           │
│   Separation is architectural, not deployment.       │
└──────────────────────────┬──────────────────────────┘
                           │ (in-process calls to repository implementations)
                           ▼
┌─────────────────────────────────────────────────────┐
│              DATA ACCESS LAYER (in-process)          │
│                                                      │
│   OrderRepository (Prisma ORM / pg driver)           │
│   UserRepository                                     │
│   StripeAdapter → calls Stripe API (external)        │
│   SendGridAdapter → calls SendGrid API (external)    │
│   CacheRepository → calls Redis (ElastiCache)        │
└────────┬────────────────┬──────────────┬────────────┘
         │                │              │
         ▼                ▼              ▼
┌──────────────┐  ┌───────────────┐  ┌──────────────┐
│ Amazon RDS   │  │ Amazon        │  │ External APIs│
│ (PostgreSQL) │  │ ElastiCache   │  │ Stripe API   │
│ Multi-AZ     │  │ (Redis)       │  │ SendGrid API │
│ Primary +    │  │ Cache layer   │  │ Twilio, etc. │
│ Read Replica │  │ Session store │  └──────────────┘
└──────────────┘  └───────────────┘

AWS SERVICES SUMMARY:
  Compute:     ECS Fargate (recommended) or EC2 Auto Scaling Group
  ALB:         Application Load Balancer (HTTP routing, health checks)
  CDN:         Amazon CloudFront (static assets + edge caching)
  Database:    Amazon RDS Aurora PostgreSQL (Multi-AZ)
  Cache:       Amazon ElastiCache Redis (session cache, query cache)
  Secrets:     AWS Secrets Manager (DB passwords, Stripe keys, JWT secrets)
  Logs:        Amazon CloudWatch Logs (application logs aggregated)
  Monitoring:  Amazon CloudWatch Metrics + Alarms
  Deployments: AWS CodePipeline → ECS rolling update or blue/green deploy
  CI/CD:       GitHub Actions → ECR image push → ECS deploy
```

---

### Infrastructure as Code (Terraform) — What You'd Provision

```hcl
# Conceptual structure of IaC for layered architecture

module "network" {
  # VPC, subnets (public/private), security groups
  # App servers in PRIVATE subnets (not internet-accessible directly)
  # RDS in isolated subnets (only accessible from app tier)
}

module "compute" {
  # ECS Fargate cluster
  # Task definition: 1 container per service (presentation + BLL + DAL all in 1 image)
  # Auto-scaling: scale on CPU > 70% or request count > 1000/min
}

module "database" {
  # RDS Aurora PostgreSQL
  # Multi-AZ: automatic failover
  # Read replica for read-heavy endpoints
  # Automated backups (7-day retention)
}

module "cache" {
  # ElastiCache Redis (cluster mode)
  # Used by DAL: cache user sessions, frequent product lookups
}

module "load_balancer" {
  # ALB with target group pointing to ECS service
  # Health check: GET /health → expect 200
  # SSL certificate via ACM
}
```

---

## SECTION 10 — Tradeoff Analysis

### Decision Matrix

```
┌─────────────────────┬─────────────────────────────────────────────────┐
│    DIMENSION        │                 LAYERED ARCHITECTURE            │
├─────────────────────┼─────────────────────────────────────────────────┤
│ Testability         │ ✅ EXCELLENT                                     │
│                     │ BLL is fully unit-testable: pure functions,      │
│                     │ mocked interfaces, no infrastructure needed.     │
│                     │ Fast CI pipeline (hundreds of unit tests in <1s) │
├─────────────────────┼─────────────────────────────────────────────────┤
│ Maintainability     │ ✅ GOOD                                          │
│                     │ Business rule location is predictable.           │
│                     │ New engineer: "where does discount logic live?"  │
│                     │ Answer: always in OrderService. Never elsewhere. │
├─────────────────────┼─────────────────────────────────────────────────┤
│ Infrastructure      │ ✅ GOOD                                          │
│ Replaceability      │ Swap PostgreSQL for MySQL: change only DAL.      │
│                     │ Swap Stripe for Adyen: change only StripeAdapter.│
│                     │ BLL and Presentation: unchanged.                 │
├─────────────────────┼─────────────────────────────────────────────────┤
│ Initial Boilerplate │ ❌ MEDIUM-HIGH                                   │
│                     │ Must define interfaces for each abstraction.     │
│                     │ Repository pattern requires mapping functions.   │
│                     │ For small teams, can feel over-engineered early. │
├─────────────────────┼─────────────────────────────────────────────────┤
│ Cross-Layer         │ ❌ RISK (requires discipline)                    │
│ Discipline          │ Without code review enforcement or linting rules,│
│                     │ developers naturally take shortcuts:             │
│                     │ "I'll just query the DB from the controller —    │
│                     │ it'll be quicker." Layer violations accumulate.  │
├─────────────────────┼─────────────────────────────────────────────────┤
│ Performance         │ ✅ NEUTRAL (no deployment overhead)              │
│                     │ All layers in-process. No network hops.          │
│                     │ Cost: 1-2 object mappings per request (< 1ms).  │
├─────────────────────┼─────────────────────────────────────────────────┤
│ Onboarding          │ ✅ EXCELLENT                                     │
│                     │ Industry-standard pattern. Any backend engineer  │
│                     │ with 2+ years experience recognizes it.          │
│                     │ Route to learning: "find the controller, follow  │
│                     │ the call into the service, then the repository." │
├─────────────────────┼─────────────────────────────────────────────────┤
│ Scalability         │ ✅ HORIZONTAL (standard)                        │
│ (deployment)        │ Add more EC2/ECS instances behind ALB.           │
│                     │ Stateless application tier scales trivially.     │
│                     │ Bottleneck: usually the database, not the app.   │
├─────────────────────┼─────────────────────────────────────────────────┤
│ Complex Domains     │ ⚠️ GROWS DIFFICULT over time                     │
│ (advanced DDD)      │ OrderService grows to 3,000 lines over 3 years. │
│                     │ Solution: split into finer-grained services, or  │
│                     │ adopt Clean Architecture / domain-driven design. │
│                     │ Layered architecture is a stepping stone.        │
└─────────────────────┴─────────────────────────────────────────────────┘
```

---

### Layered Architecture vs Alternatives

```
Layered Architecture vs Hexagonal (Ports & Adapters):
  Both have the same goal: separate business logic from infrastructure.
  Hexagonal is MORE strict: even the "direction" of the dependency is enforced.
  Layered: top-down hierarchy (Presentation → BLL → DAL).
  Hexagonal: BLL at the center; HTTP and DB both "ports" used by adapters.
  Choose Hexagonal when: you expect multiple delivery mechanisms
  (HTTP AND gRPC AND CLI AND message queue handlers).

Layered Architecture vs Clean Architecture:
  Clean Architecture is an evolution of Layered Architecture.
  Adds: Entities (enterprise rules) as a separate inner layer.
  Adds: Use Cases as explicit objects (not just service methods).
  Adds: Dependency Rule (strict inward-only dependencies).
  Choose Clean Architecture when: domain complexity requires
  enterprise-rule/application-rule distinction, or team >25 engineers.

Layered Architecture vs Transaction Script:
  Transaction Script: one function per use case, no layering, all logic in one place.
  Valid for: very simple CRUD apps, 1-2 engineers, short lifespan.
  Layered Architecture: when the codebase must outlive its original authors.
```

---

## SECTION 11 — System Design Interview Discussion

### How to Discuss Layered Architecture in Interviews

**Common triggers:**

- "How would you structure a REST API?"
- "Walk me through how your backend is organized."
- "What patterns do you use to keep code maintainable?"
- "How do you test business logic without hitting the database?"

---

**Q: "How do you organize the backend of a web API?"**

**Weak answer:** "I use MVC — Model, View, Controller."
_(MVC is a UI pattern from the 1970s. It doesn't address service layers, repository patterns, or business logic separation. This answer signals you're thinking about it at a framework level, not an architectural level.)_

**Strong answer:**

> "I use a Layered Architecture with three primary layers: a Presentation layer (controllers, input validation, HTTP adapters), a Business Logic layer (services, domain entities, business rules), and a Data Access layer (repositories, external gateway adapters). Business rules live exclusively in the service layer and depend only on interfaces — never on ORM objects or HTTP request objects directly. This means I can unit-test all business logic by mocking the repository and gateway interfaces, without a live database or external services. Infrastructure is interchangeable: swapping PostgreSQL or Stripe is a DAL-only change."

---

**Q: "What if a business rule needs data from multiple repositories?"**

```
Example: Placing an order requires checking:
  1. User exists and isn't blocked (UserRepository)
  2. Items are in stock (InventoryRepository)
  3. Payment method is valid (PaymentGateway)

Answer:
  The OrderService (BLL) orchestrates these.
  It depends on all three interfaces.
  It coordinates the calls, applies business rules, and manages the
  overall transaction.

  This is the purpose of the Service layer: orchestrate multiple
  data sources and apply cross-entity business rules.

  Anti-pattern to call out: Don't put this orchestration in the controller.
  Don't put it in the repository. Orchestration belongs in the service.
```

---

**Q: "What happens when OrderService grows to 5,000 lines?"**

> "That's the signal the service has too many responsibilities. I'd split by domain concept: `PlaceOrderService`, `CancelOrderService`, `OrderHistoryService`. Each handles a distinct use case. Within each, the pattern stays the same. If the domain is truly complex, this is also the point where I'd consider migrating to Clean Architecture — introducing explicit Use Case objects — or extracting a separate microservice if a team is ready to own it."

---

## SECTION 12 — Design Exercise

### Exercise: Audit This Architecture

**Given code structure (Node.js, Express):**

```
routes/
  orders.routes.js          ← 400 lines total
  users.routes.js           ← 300 lines total

models/
  order.model.js            ← Sequelize ORM model
  user.model.js             ← Sequelize ORM model

helpers/
  stripe.js                 ← Stripe initialization + direct calls
  email.js                  ← SendGrid direct integration

routes/orders.routes.js (excerpt):
  router.post('/orders', async (req, res) => {
    const user = await User.findOne({ where: { id: req.body.userId } });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const discount = user.totalOrders > 10 ? 0.1 : 0;  // business rule
    const total = req.body.items.reduce((s, i) => s + i.price, 0);
    const finalTotal = total * (1 - discount);

    const charge = await stripe.charges.create({ amount: finalTotal });
    const order = await Order.create({ userId: user.id, total: finalTotal });

    await sendEmail(user.email, 'Order confirmed', `Your order #${order.id}`);

    return res.status(201).json(order);
  });
```

**Think before reading answers:**

---

**Answer 1: Layer violations present**

```
VIOLATION 1: Business rule in route handler
  discount = user.totalOrders > 10 ? 0.1 : 0
  → This is a business rule. Lives in the route. Cannot be reused.
  → Fix: Move to OrderService.calculateDiscount(user)

VIOLATION 2: ORM model used as domain entity
  Order.create({...}) uses the Sequelize model directly in the route.
  → The route is coupled to Sequelize. Swap ORM = change all routes.
  → Fix: Repository pattern. OrderRepository.create(orderData).

VIOLATION 3: External service called from route
  stripe.charges.create(...) directly in route handler.
  → Tests must mock Stripe at the global level.
  → Fix: IPaymentGateway interface, StripeAdapter implements it, injected.

VIOLATION 4: Email sent from route handler
  SendGrid email is a notification side-effect. The route handler
  doesn't know (or care) about HOW notification happens.
  → Fix: OrderService publishes OrderPlaced event. NotificationService handles email.

VIOLATION 5: No input validation before DB calls
  req.body.userId used directly without validation.
  → SQL injection risk if not using parameterized queries everywhere.
  → Fix: Zod/Joi schema validation before calling service.
```

---

**Answer 2: Target Architecture After Refactor**

```
src/
  presentation/
    routes/
      orders.routes.ts        ← register routes, call controller
    controllers/
      order.controller.ts     ← parse HTTP, validate, call service, format response
    dtos/
      create-order.dto.ts     ← Zod schema: validate req.body shape

  application/
    services/
      order.service.ts        ← orchestrate: check user, reserve, charge, save, emit event
    interfaces/
      IOrderRepository.ts     ← interface: findById, save, listByUser
      IPaymentGateway.ts      ← interface: charge(paymentMethodId, amount)
    domain/
      Order.ts                ← domain entity (plain class, no ORM decorator)
      User.ts                 ← domain entity

  infrastructure/
    repositories/
      order.repository.ts     ← implements IOrderRepository using Prisma/Sequelize
      user.repository.ts      ← implements IUserRepository
    adapters/
      stripe.adapter.ts       ← implements IPaymentGateway, wraps Stripe SDK
      sendgrid.adapter.ts     ← implements IEmailGateway, wraps SendGrid SDK

  di/
    container.ts              ← Composition Root: wires all dependencies together
```

---

## === Architect's Mental Model ===

### 5 Decision Rules

**Rule 1: Business rules live in exactly one place — the Service Layer.**
If you find yourself writing an `if` statement that implements a business constraint (discount threshold, fraud rule, eligibility check) anywhere other than the Service Layer, you've placed it incorrectly. The Service Layer is the canonical home. Any duplication of business rules is a future bug.

**Rule 2: Layers communicate through interfaces, not through concrete implementations.**
The Service Layer must not import Prisma, Sequelize, Stripe SDK, or Express directly. It imports interfaces. This is the single rule that makes the architecture testable. If you can write a unit test for a Service that doesn't start a database, you've implemented this correctly.

**Rule 3: Controllers are thin. If a controller is doing more than: validate input → call service → format response, it has absorbed logic it shouldn't own.**
The test for this: how many lines does your controller's method have? Over 30 lines suggests business logic has crept in. Over 100 lines and the service layer has likely been bypassed.

**Rule 4: Repositories return domain objects, not ORM entities.**
The Service Layer does not know what database is in use. It receives `Order` domain objects, not `Sequelize.Model` instances or `PrismaPromise` objects. The mapping from ORM row to domain object is the repository's job. This is what makes infrastructure swappable.

**Rule 5: Define layer boundaries before writing code on any new project.**
Create the folder structure and the interfaces first. `IOrderRepository`, `IUserRepository`, `IPaymentGateway` — write these empty interfaces on day 1. This commits the architecture before the pressure to take shortcuts appears.

---

### 3 Common Mistakes

**Mistake 1: "Smart controller, dumb service."**
Teams under deadline pressure put logic in controllers because it's faster. Business rule in the controller means: cannot be reused by CLI, cannot be unit-tested easily, grows without bound. "I'll refactor it later" — and the controller grows to 600 lines. Refactoring at 600 lines costs 10× what writing it correctly at 50 lines would have.

**Mistake 2: Repository knows too much.**
Repositories that apply business filters ("only return active orders for non-blocked users") are mixing the data concern with the business concern. The repository should provide raw access primitives. The service decides which records are valid in a given context. A repository method `getActiveOrdersForNonBlockedUsers()` is a violation — that filtering belongs in the service.

**Mistake 3: Skipping the interface for "simple" cases.**
"This service only ever uses PostgreSQL, so why define IOrderRepository?" Six months later: you're writing integration tests and realize you can't mock the database. You're writing a new use case and realize ALL your test scenarios require database seed data. The interface adds 10 lines of boilerplate and saves 40+ hours of test infrastructure fixes.

---

### 30-Second Interview Answer

> "I use a three-layer architecture: a Presentation layer that handles HTTP concerns — routing, input validation, authentication middleware; a Business Logic layer containing services and domain entities where all business rules live, depending only on repository and gateway interfaces; and a Data Access layer implementing those interfaces — repositories for the database, adapters for external services like Stripe or SendGrid. The key invariant is that the Business Logic layer never imports infrastructure directly. It only depends on interfaces, which means it's fully unit-testable without standing up a database or external services. Controllers are thin — validate, call service, return response. Services contain all the logic. Repositories contain all the SQL. This pattern is predictable enough that any engineer joining can find any logic in under 30 seconds."

---

_End of Topic 02 — Layered Architecture_
_→ Next: Topic 03 — Controller-Service-Repository Pattern_
