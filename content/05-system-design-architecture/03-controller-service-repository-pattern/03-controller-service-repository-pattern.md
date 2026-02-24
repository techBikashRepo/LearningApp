# Controller-Service-Repository Pattern — Part 3 of 3

### Sections: 9 (Cloud Mapping), 10 (Tradeoff Analysis), 11 (System Design Interview), 12 (Design Exercise)

**Series:** System Design & Architecture → Topic 03

---

## SECTION 9 — Cloud Mapping

### CSR Pattern Deployed on AWS

```
The Controller-Service-Repository pattern is an in-process code pattern.
All three components run inside the SAME deployed process.
Cloud infrastructure runs and scales the PROCESS — not the individual components.

─────────────────────────────────────────────────────────────────────
DEPLOYMENT UNIT: One Docker container (Node.js/Java/.NET app)
Contents of the container:
  ├── Controller Layer (Express routes / Spring @RestController)
  ├── Service Layer (OrderService, UserService, etc.)
  └── Repository Layer (Prisma/Hibernate/EF Core + external adapters)

AWS deploys this container via:
  • ECS Fargate (serverless containers — recommended)
  • EKS (Kubernetes — for larger scale)
  • EC2 with Docker (self-managed)
─────────────────────────────────────────────────────────────────────

INBOUND:
  Route 53 (DNS)
      → CloudFront (CDN + WAF + DDoS protection)
      → Application Load Balancer (SSL termination, health checks)
      → ECS Service (target group, multiple tasks for HA)

CONTROLLER LAYER interactions (within process, no network):
  └── Calls Service Layer → instant (in-process function call)

SERVICE LAYER interactions:
  └── Calls Repository interfaces → in-process → repository calls:
        ├── Amazon RDS (PostgreSQL) via Prisma/TypeORM/Hibernate
        │     VPC endpoint — stays within private subnet
        ├── Amazon ElastiCache (Redis) for cache reads
        │     Used by caching repository wrappers
        └── External APIs via HTTP adapters:
              ├── Stripe (via StripeAdapter → api.stripe.com)
              ├── SendGrid (via EmailAdapter → api.sendgrid.com)
              └── Twilio (via SmsAdapter → api.twilio.com)

SECRETS MANAGEMENT (critical):
  Each credential used by the Repository/Adapter layer is stored in:
  AWS Secrets Manager (not in env vars, not in code)

  App startup:
    SecretsManager.getSecretValue("prod/orders-service/db-password")
    SecretsManager.getSecretValue("prod/orders-service/stripe-api-key")

  Rotation: Secrets Manager rotates DB passwords automatically.
            Repository connection string updated without code deploy.

CONFIGURATION:
  Controller: Port, CORS origins, allowed HTTP methods → AWS Parameter Store
  Service:    Feature flags (loyalty points % rate) → AWS Parameter Store
  Repository: DB connection string, Redis URL, max pool size → Secrets Manager

LOGGING (from Controller, Service, Repository):
  All layers write structured JSON logs to stdout.
  ECS → CloudWatch Logs (log group per service).
  CloudWatch Insights: query by trace_id to retrieve the full request lifecycle.

OBSERVABILITY per layer:
  Controller layer metric: HTTP request count, HTTP 4xx rate, HTTP 5xx rate
  Service layer metric:    Business operation success/failure rate, latency
  Repository layer metric: DB query duration, DB connection pool utilization,
                           External API call latency (Stripe p99)
```

---

### ECS Task Definition Alignment with CSR

```json
{
  "family": "orders-service",
  "containerDefinitions": [
    {
      "name": "orders-service",
      "image": "123456.dkr.ecr.us-east-1.amazonaws.com/orders-service:v1.4.2",
      "portMappings": [{ "containerPort": 3000 }],
      "environment": [
        { "name": "NODE_ENV", "value": "production" },
        { "name": "PORT", "value": "3000" }
      ],
      "secrets": [
        {
          "name": "DATABASE_URL",
          "valueFrom": "arn:aws:secretsmanager:...orders-service/db-url"
        },
        {
          "name": "STRIPE_API_KEY",
          "valueFrom": "arn:aws:secretsmanager:...orders-service/stripe-key"
        },
        {
          "name": "REDIS_URL",
          "valueFrom": "arn:aws:secretsmanager:...orders-service/redis-url"
        }
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": { "awslogs-group": "/ecs/orders-service" }
      },
      "healthCheck": {
        "command": [
          "CMD-SHELL",
          "curl -f http://localhost:3000/health || exit 1"
        ]
      }
    }
  ],
  "cpu": "512",
  "memory": "1024"
}
```

---

## SECTION 10 — Tradeoff Analysis

### Where CSR Excels

```
✅ CRUD-heavy domains (e-commerce, SaaS dashboards, admin portals)
   "80% of web apps are CRUD with some business rules."
   CSR shines here: the pattern is built for exactly this.

✅ Teams of 2-15 engineers
   Enough structure to stay organized.
   Not enough overhead to require a dedicated platform engineer.
   Onboarding time: 1-2 hours for any backend engineer familiar with the pattern.

✅ APIs consumed by multiple clients
   Service layer is client-agnostic: same OrderService called from
   REST controller, gRPC handler, background worker, CLI tool.
   Once the service is written, any new client surface is a thin controller.

✅ High test coverage requirements
   Pure service unit tests = fast CI.
   Repository integration tests = focused DB testing.
   E2E tests = minimal, highest-confidence smoke tests.
```

---

### Where CSR Struggles

```
❌ Very complex domains with intricate entity relationships
   When Order touches 10 aggregates and 15 services interact,
   a flat Service class becomes a 3,000-line orchestration monstrosity.
   Move to: Clean Architecture (explicit Use Cases) or Domain-Driven Design
   with Aggregates, Value Objects, and domain event-driven orchestration.

❌ Event-driven and streaming systems
   A Kafka consumer processes millions of events.
   The "controller" concept doesn't map cleanly to message consumption.
   A Kafka consumer IS a controller equivalent — but the mental model shifts.
   Services and Repositories still apply. Controller = consumer handler.

❌ Read-heavy reporting/analytics paths
   A reporting query: joins 7 tables, applies 15 filters, aggregates millions of rows.
   Forcing this through a Service layer adds indirection with no benefit.
   Solution: CQRS (Command Query Responsibility Segregation).
   The "command" path (writes) uses CSR. The "query" path (reads) bypass
   the Service layer and use dedicated read models or query objects.

❌ Performance-critical hot paths
   In-process function calls cost nanoseconds. Mapping objects costs microseconds.
   At 50,000 RPS with a deep object graph, mapping overhead becomes measurable.
   Solution: profile first. If mapping IS the bottleneck:
   use optimized DTOs, projection queries, or skip the domain entity layer for reads.
```

---

### Common Variant: CQRS Applied to CSR

```
COMMAND path (mutations — writes):
  POST/PUT/PATCH/DELETE
  Controller → CommandService → Repository (write DB)
  Full CSR. Business rules enforced. Domain events emitted.

QUERY path (reads):
  GET
  Controller → QueryService (or direct QueryRepository) → Read DB / Read Replica
  Skip domain entity mapping. Return DTOs directly from SQL projections.
  Use: SELECT specific_column_a, specific_column_b FROM orders WHERE...
  Do NOT: fetch the full Order entity and map it if only 3 fields are needed.

BENEFIT: Read paths are optimized for performance.
         Write paths are optimized for correctness and business rule enforcement.
```

---

## SECTION 11 — System Design Interview Discussion

### Interview Framing for CSR

**Q: "Walk me through how you'd structure a backend API for a task management app."**

**Answer template:**

> "I'd use a Controller-Service-Repository architecture. For the task creation endpoint (POST /tasks), the controller parses the request body, validates it with a schema validator, and delegates to TaskService. The controller handles no business logic — only input validation and HTTP protocol concerns.
>
> TaskService.createTask() handles all the business rules: does the user's plan allow creating more tasks? Is the due date valid? Is an assigned user in the same workspace? Once those rules pass, it calls TaskRepository.save() to persist the task.
>
> The repository layer uses an ORM — the service never writes a SQL query directly. This way, changing the ORM or the database schema is a repository-only change.
>
> The service depends on ITaskRepository and INotificationGateway — interfaces, not concrete. In unit tests: I inject an in-memory repository and stub the notification gateway. Full business rule coverage without a live database."

---

**Q: "What's the difference between your service layer and your controller?"**

> "The controller's job is entirely about the transport protocol — HTTP. It reads from the request, validates the shape of the input, and writes to the response. It knows status codes, headers, and request bodies. When I test a controller, I'm testing 'does a bad input return 422?' and 'does a 404 from the service map to HTTP 404?' — nothing more.
>
> The service's job is entirely about the domain. It encodes the business rules of the system — what is allowed, what is computed, what must happen in what order. The service has no concept of HTTP, no concept of which database is being used. When I test a service, I'm testing 'does placing an order with an out-of-stock item return InsufficientStockError?' with pure function calls, no infrastructure."

---

**Q: "How would you test the business logic that a user can only have 3 active projects?"**

```
WITHOUT CSR:
  The rule is in the route handler.
  Test requires: HTTP server, live database, seed user with 3 projects, make HTTP call.
  Test runs in ~2 seconds. Flaky on CI if DB is slow.

WITH CSR:
  The rule lives in ProjectService:
    if (user.activeProjectCount >= 3) return err({ type: 'PlanLimitReached' })

  Test:
    const mockRepo = new InMemoryUserRepository();
    mockRepo.setUserProjects(userId, 3);  // seed: user has 3 active projects
    const service = new ProjectService(mockRepo, ...);
    const result = await service.createProject(dto, userId);
    expect(result.isErr()).toBe(true);
    expect(result.error.type).toBe('PlanLimitReached');

  Test runs in < 1ms. No database. No HTTP.
```

---

**Red Flags in Candidate Answers:**

```
❌ "The controller queries the database for the user before passing to the service."
   → Controller should never query the database.

❌ "The service takes the Express request object as a parameter."
   → Service is coupled to HTTP. Cannot be tested or reused without Express.

❌ "The repository decides whether the user can perform the action."
   → Business rules belong in the service, not the repository.

❌ "I just put everything in the model." (Rails-style fat model)
   → No separation between domain logic and persistence concerns.
   → Untestable business rules.

❌ "We don't use services — we call the repository directly from the controller."
   → Business logic in the controller. Duplication inevitable.
```

---

## SECTION 12 — Design Exercise

### Exercise: Refactor to Controller-Service-Repository

**Given this Express route handler (156 lines condensed):**

```javascript
router.post("/signup", async (req, res) => {
  // Check all fields present
  if (!req.body.email || !req.body.password || !req.body.name) {
    return res.status(400).json({ error: "All fields required" });
  }

  // Business rule: email must be unique
  const existing = await db.query("SELECT id FROM users WHERE email = $1", [
    req.body.email,
  ]);
  if (existing.rows.length > 0) {
    return res.status(409).json({ error: "Email already registered" });
  }

  // Business rule + infra: hash password
  const hash = await bcrypt.hash(req.body.password, 10);

  // Business rule: generate email verification token
  const token = crypto.randomBytes(32).toString("hex");

  // DB write
  const user = await db.query(
    "INSERT INTO users (email, password_hash, name, verification_token) VALUES ($1, $2, $3, $4) RETURNING id, email, name",
    [req.body.email, hash, req.body.name, token],
  );

  // Send email directly in route handler
  await sendgrid.send({
    to: req.body.email,
    from: "noreply@myapp.com",
    subject: "Verify your email",
    text: `Click here to verify: https://myapp.com/verify/${token}`,
  });

  res
    .status(201)
    .json({ user: user.rows[0], message: "Check your email to verify" });
});
```

**Think through the refactor before reading the answers.**

---

**Answer: How to distribute this across Controller, Service, Repository**

```
CONTROLLER (UserController.signup):
  Parse: extract email, password, name from req.body
  Validate shape: Zod schema — email format, password min length, name non-empty
  If validation fails: HTTP 422 with field errors

  Call: userService.registerUser({ email, password, name })

  Map result:
    ok(user)              → HTTP 201 { user: { id, email, name }, message: "Check email" }
    err(EmailTaken)       → HTTP 409 { error: "Email already registered" }
    err(RegistrationFailed)→ HTTP 500 (log internally, return generic error)

──────────────────────────────────────────────────────────────────
SERVICE (UserService.registerUser):
  1. Check uniqueness: userRepository.existsByEmail(email)
     If exists: return err({ type: 'EmailTaken' })

  2. Hash password: await bcrypt.hash(password, BCRYPT_ROUNDS)
     (bcrypt is an infrastructure concern — injectable via IPasswordHasher)

  3. Generate verification token: crypto.randomBytes(32).toString('hex')

  4. Create User domain entity:
     user = User.create({ email, passwordHash, name, verificationToken, status: 'unverified' })

  5. Save: await userRepository.save(user)

  6. Publish event (or call notification adapter directly):
     await emailGateway.sendVerificationEmail(user.email, user.verificationToken)
     (Do NOT sendgrid directly — use IEmailGateway interface)

  7. Return ok(user)  ← domain user object, no password hash included

──────────────────────────────────────────────────────────────────
REPOSITORY (UserRepository):
  existsByEmail(email: string): Promise<boolean>
    SQL: SELECT EXISTS(SELECT 1 FROM users WHERE email = $1)

  save(user: User): Promise<User>
    SQL: INSERT INTO users (id, email, password_hash, name, verification_token, status)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, email, name, status, created_at
    Maps result row → User domain object (WITHOUT password_hash)

──────────────────────────────────────────────────────────────────
ADAPTER (EmailAdapter implements IEmailGateway):
  sendVerificationEmail(email: string, token: string): Promise<void>
    sendgrid.send({ to: email, from: ..., subject: ..., text: ... })
```

**What the refactor enables:**

```
UNIT TEST: userService.registerUser with duplicate email
  mockRepo.existsByEmail() returns true
  → expect result.error.type === 'EmailTaken'
  → no DB, no SendGrid, runs in < 1ms

UNIT TEST: password is hashed before save
  mockHasher.hash() returns known value "hashed_pw"
  → expect mockRepo.save() was called with passwordHash === "hashed_pw"
  → verified the service calls the hasher

UNIT TEST: verification email sent after save
  mockEmailGateway.sendVerificationEmail called with correct email and token
  → assert called once with user.email

INTEGRATION TEST: UserRepository.save() + existsByEmail() against test DB
  create user → existsByEmail → true
  attempt duplicate → existsByEmail → true → service returns err

E2E: Full signup flow via HTTP → DB → mock email in test mode
```

---

## === Architect's Mental Model ===

### 5 Decision Rules

**Rule 1: One HTTP route handler calls one service method.**
This is the rule that prevents "orchestration in the controller." If your controller calls `userService.find()`, then `orderService.createOrder()`, then `inventoryService.reserve()` — that orchestration belongs inside a single service method. The controller should not know that three services are involved.

**Rule 2: Services return domain results, never throw HTTP exceptions.**
`throw new HttpException(403, 'Forbidden')` inside a service is a coupling violation. Services throw domain errors (`UserBlockedError`, `InsufficientStockError`) or return typed Result objects. The controller is the ONLY layer that translates domain errors to HTTP status codes. This keeps services reusable outside of HTTP contexts.

**Rule 3: Define the IRepository interfaces before writing any Service.**
Writing the interface first forces you to think: "What does the service actually need from the data layer?" The result is a minimal, purposeful interface — not a God repository with 30 methods. If you can't define the interface without writing the SQL first, you haven't thought through the domain model.

**Rule 4: If two controllers call the same business logic — extract it to a shared Service, not a shared helper function.**
"Helper functions" in the presentation layer are a code smell — they often contain business rules that escaped the service layer. If `applyLoyaltyDiscount()` is in `helpers/pricing.js` and is called from 3 controllers — it belongs in `PricingService.applyLoyaltyDiscount()`.

**Rule 5: Repository methods are named after data operations, not business operations.**
`findById()`, `save()`, `findByEmail()`, `findByUserIdPaginated()` — these are data access names. `getCancellableOrders()`, `getEligibleDiscountUsers()`, `findOrdersReadyToShip()` — these are business operation names. If you're writing business names on repository methods, the business logic has leaked into the data layer.

---

### 3 Common Mistakes

**Mistake 1: Creating a "God Service" that wraps the entire application.**
`ApplicationService` with 200 methods — one per route — is a service in name only. It's moved the route handler body into a class without adding any useful abstraction. Real services are bounded by domain responsibility: `UserRegistrationService`, `OrderFulfillmentService`, `PaymentProcessingService`. One service per domain concern.

**Mistake 2: Making the service stateful.**
A Service class should have no instance state beyond its injected dependencies. No `this.currentOrder = ...`. Stateful services are not safe for concurrent requests. Services are stateless orchestrators. Domain objects (Order, User) carry state. Services manipulate domain objects and pass them to repositories.

**Mistake 3: Treating Repository as an ORM wrapper instead of a domain abstraction.**
`OrderRepository extends PrismaRepository` — the repository exposes `prisma.order.findMany()` publicly. It's not a repository; it's a Prisma wrapper with extra steps. A proper repository presents a domain API: `findByUserId(userId, pagination)`. The Prisma-specific query is an internal implementation detail — invisible to the Service layer.

---

### 30-Second Interview Answer

> "Controller-Service-Repository is how I structure any backend API: the Controller handles the HTTP protocol — route matching, input validation, auth middleware, response formatting; the Service owns the domain — all business rules, orchestration across multiple repositories, domain event publishing; the Repository abstracts all database access — one interface per aggregate, one concrete implementation that knows about the ORM. The Service depends on interfaces only, never on concrete infrastructure. This makes every business rule unit-testable with mocked dependencies in under 10 milliseconds. The controller calls one service method per action. The service never sees HTTP objects. The repository never applies business rules. Three layers, three clear responsibilities, deterministic ownership of every line of logic."

---

_End of Topic 03 — Controller-Service-Repository Pattern_
_→ Next: Topic 04 — Clean Architecture Basics_
