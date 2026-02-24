# Monolith vs Microservices — Part 1 of 3

### Sections: 1 (Real-World Analogy), 2 (Problem Solved), 3 (Component Responsibilities), 4 (Architecture Diagram)

**Series:** System Design & Architecture → Topic 01

---

## SECTION 1 — Real-World Analogy: Company Departments

### The 10-Person Startup vs the 500-Person Corporation

Imagine a **10-person startup**.

One person handles sales, invoicing, customer support, and product demos — sometimes in the same hour. There's no formal handoff process. When a customer calls, anyone picks up. Decisions happen in seconds. A bug in invoicing is fixed by the same engineer who wrote the checkout flow. Everyone knows everything.

This is a **monolith**. One codebase. One deployment. One team. Shared everything.

Now imagine that startup grew to **500 people**.

The company has a Sales department, a Finance department, a Customer Support department, a Legal team, and a Product team. Each has its own manager, its own processes, its own tools, and its own budget. Sales doesn't need to know how Finance processes payroll. Finance can switch their accounting software without asking Sales to redeploy anything. A bug in Legal's document system doesn't bring down the product.

This is **microservices**. Autonomous teams owning discrete domains with explicit, documented contracts between them.

---

**The critical insight:**

The decision to split departments wasn't made on day one. It was made when:

- The 10-person team grew to 30, and deploying one feature meant 10 people waiting on 2 others.
- A bug in billing was blocking a customer support fix.
- Two engineers kept overwriting each other's code in the same file.

**Same rule for software.** You split a monolith when the organization outgrows it — not before.

---

**The department contract analogy:**

In a 500-person company:

- Sales hands a signed contract to Finance. Finance doesn't read sales emails to understand what was sold.
- Legal produces a PDF. Finance reads the PDF. Legal doesn't need Finance to understand legal statuses.

In microservices:

- The Orders service publishes an event: `{"order_id": 42, "total_cents": 9900, "status": "paid"}`.
- The Fulfillment service reads that event. It doesn't read the Orders service's database.
- The Notification service reads that event. It doesn't call the Fulfillment service.

**Explicit contracts (APIs, events) between services = well-defined departmental interfaces.**

When contracts are violated (a service directly reads another's database), you don't have microservices — you have a **distributed monolith**: all the operational complexity of microservices with none of the independence.

---

## SECTION 2 — What Problem Does This Pattern Solve?

### The Monolith's Ceiling

A **monolith** is a single deployable unit. Every component — web layer, business logic, data access — is compiled and deployed together. One codebase, one database schema, one deploy.

**Monolith solves:**

- Time-to-productivity for small teams (1-5 engineers). No infrastructure overhead.
- Simple debugging: one log stream, one code path, one database transaction.
- Easy refactoring: rename a function — your IDE finds every call site. No cross-service contract breakage.
- Low operational cost: one EC2 instance, one RDS database, one deployment pipeline.

**Monolith breaks down when:**

```
Problem 1: Deployment coupling
  Team A merges a feature for feature A.
  Team B has an unrelated bug in feature B.
  Deploy is blocked: Team B's code must also ship (or be reverted) for Team A to release.
  At 5 teams × 10 deploys/week: constant collision. Feature velocity drops.

Problem 2: Scaling the wrong layer
  Product search needs 20 CPU cores (heavy query load).
  The user authentication service needs 2 CPU cores.
  Monolith: you scale BOTH together. You pay for 20 cores for everything.
  Correct: scale only the search component. Microservices enables this.

Problem 3: Tech debt in one area freezes the whole system
  Payments component uses an old Java 8 library with a critical CVE.
  Upgrading it requires touching shared utilities used by 15 other components.
  The upgrade takes 4 months. During those 4 months: the CVE is live.
  Microservices: upgrade the payments service in isolation. Ship in 2 weeks.

Problem 4: A single bad deploy brings down everything
  A memory leak in the analytics reporting component OOMs the server.
  User authentication: also down. Checkout: also down. Not related. All dead.
  Microservices: analytics crashes. Everything else: unaffected.
```

---

**Microservices solves:**

- Independent deployment: teams ship on their own schedule.
- Targeted scaling: scale the bottleneck, not the whole system.
- Fault isolation: a crash in one service doesn't cascade to unrelated services.
- Technology flexibility: Payments in Go, Recommendations in Python, Admin in Rails — each chooses the right tool.

**Microservices breaks down when:**

```
Problem 1: Distributed transactions
  Monolith: BEGIN; deduct inventory; charge card; create order; COMMIT.
  Atomic. Either all succeed or all roll back.
  Microservices: Inventory service, Payment service, Orders service are separate.
  You CANNOT have a single database transaction across them.
  Failure between steps: you've charged the card but inventory wasn't decremented.
  Fix requires: Saga pattern, compensation transactions, eventual consistency.
  Complexity: 10x higher than a monolith transaction.

Problem 2: Distributed debugging
  Monolith: one stack trace. Bug found in 5 minutes.
  Microservices: request touches 8 services. Error is in service 5.
  Requires: distributed tracing (Jaeger/Zipkin/X-Ray), correlation IDs, centralized logs.
  Without these: debugging takes hours. With them: still slower than a monolith.

Problem 3: Network as a new failure mode
  Function call between two modules in a monolith: sub-microsecond. Never fails.
  HTTP call between two microservices: 1-10ms. Can timeout. Can 503. Can hang.
  Every inter-service call requires: timeouts, retries, circuit breakers, fallbacks.
  Building this correctly requires engineering time that adds zero business value.
```

---

## SECTION 3 — Component Responsibilities

### Monolith Component Map

In a monolith, these are **modules within one codebase** — not separate processes.

```
MODULE: Web Layer (Controllers / Routes)
  Responsibility: Accept HTTP, parse request, validate input, return response.
  Owns: Request/response formatting, input validation, authentication middleware.
  Does NOT own: Business rules, database queries, external API calls.

MODULE: Business Logic (Services / Domain)
  Responsibility: Enforce domain rules — what is and isn't allowed.
  Owns: Checkout rules, inventory validation, pricing logic, discount application.
  Does NOT own: How to persist data, how to format the HTTP response.

MODULE: Data Access Layer (Repositories / DAOs)
  Responsibility: Read and write to the database.
  Owns: SQL queries, ORM mappings, transaction management.
  Does NOT own: Business rules, HTTP formatting.

MODULE: Background Jobs (Workers)
  Responsibility: Async tasks — emails, report generation, data sync.
  Owns: Job queue consumption, retry logic.
  Does NOT own: Web layer, real-time request handling.
```

When modules respect these boundaries in a monolith: extracting one module to a microservice later is a 2-week project, not a 6-month project. **Modular monolith first** is the correct default.

---

### Microservices Component Map

In microservices, each of these is a **separate deployable process** with its own database.

```
SERVICE: API Gateway
  Responsibility: Single entry point for all external traffic.
  Owns: Routing, auth token validation, rate limiting, TLS termination.
  Does NOT own: Business logic, database queries, service health decisions.
  Contract: Forwards authenticated requests to downstream services. Returns aggregated response.

SERVICE: User Service
  Responsibility: Everything about identity — registration, login, profile.
  Owns: users database table, password hashing, JWT issuance.
  Does NOT own: Orders, payments, products — anything that is not identity.

SERVICE: Order Service
  Responsibility: Lifecycle of an order — creation, status, history.
  Owns: orders + order_items tables. Order state machine (pending→paid→shipped→delivered).
  Does NOT own: How the user looks up their profile, how payment is processed.

SERVICE: Payment Service
  Responsibility: Charging cards, refunds, payment status.
  Owns: payment_attempts table, Stripe/gateway integration.
  Does NOT own: What was ordered, who the user is beyond a user_id.

SERVICE: Inventory Service
  Responsibility: Track available stock. Reserve stock during checkout.
  Owns: products table, stock_levels, reservations.
  Does NOT own: Payments, orders, users.

SERVICE: Notification Service
  Responsibility: Send emails, SMS, push notifications.
  Owns: notification_log, template rendering.
  Does NOT own: The business event that triggered the notification.
  Receives: Events from other services ("OrderPaid" → send receipt email).
```

---

**The single most important rule for service boundaries:**

> A service owns its data. If Service A must read Service B's database to do its job, either: the service boundary is wrong, or Service B needs to expose an API/event for that data.

---

## SECTION 4 — ASCII Architecture Diagrams

### Monolith Architecture

```
                          CLIENT (Browser / Mobile App)
                                      │
                                      ▼
                            ┌─────────────────┐
                            │   Load Balancer  │
                            │  (nginx / ALB)   │
                            └────────┬────────┘
                                     │
                                     ▼
                  ┌──────────────────────────────────────┐
                  │           MONOLITH PROCESS            │
                  │  (Single Deployable Unit - one JVM    │
                  │   / Node process / Rails app)         │
                  │                                       │
                  │  ┌─────────────┐  ┌───────────────┐  │
                  │  │ Web Layer   │  │  Auth Module  │  │
                  │  │ (Routes /   │  │  (JWT/Session)│  │
                  │  │  Controllers│  └───────────────┘  │
                  │  └──────┬──────┘                     │
                  │         │                            │
                  │         ▼                            │
                  │  ┌──────────────────────────────┐   │
                  │  │       Business Logic Layer    │   │
                  │  │  ┌──────────┐ ┌───────────┐  │   │
                  │  │  │ Orders   │ │ Payments  │  │   │
                  │  │  │ Service  │ │ Service   │  │   │
                  │  │  └──────────┘ └───────────┘  │   │
                  │  │  ┌──────────┐ ┌───────────┐  │   │
                  │  │  │Inventory │ │ Notif.    │  │   │
                  │  │  │ Service  │ │ Service   │  │   │
                  │  │  └──────────┘ └───────────┘  │   │
                  │  └──────────────────┬───────────┘   │
                  │                     │               │
                  │  ┌──────────────────▼───────────┐   │
                  │  │       Data Access Layer       │   │
                  │  │     (ORM / Repository)        │   │
                  │  └──────────────────┬───────────┘   │
                  │                     │               │
                  └─────────────────────┼───────────────┘
                                        │
                          ┌─────────────▼──────────┐
                          │    Single Database      │
                          │  (PostgreSQL / MySQL)   │
                          │  All tables, one schema │
                          └────────────────────────┘
                                        │
                          ┌─────────────▼──────────┐
                          │   Background Job Queue  │
                          │    (Sidekiq / Celery)   │
                          └────────────────────────┘
```

---

### Microservices Architecture

```
                          CLIENT (Browser / Mobile App)
                                      │
                                      ▼
                  ┌───────────────────────────────────┐
                  │            API GATEWAY             │
                  │  • Auth token validation           │
                  │  • Rate limiting                   │
                  │  • Routing to services             │
                  │  • SSL termination                 │
                  └──┬──────┬──────┬──────┬──────┬────┘
                     │      │      │      │      │
            ┌────────▼─┐ ┌──▼───┐ ┌▼───┐ ┌──▼──┐│
            │  USER    │ │ORDER │ │PAY │ │INV  ││
            │ SERVICE  │ │SERV. │ │SERV│ │SERV ││
            │          │ │      │ │    │ │     ││
            │ ┌──────┐ │ │┌────┐│ │┌──┐│ │┌───┐││
            │ │users │ │ ││ord.││ ││pay││ ││inv│││
            │ │  DB  │ │ ││ DB ││ ││DB ││ ││DB │││
            │ └──────┘ │ │└────┘│ │└──┘│ │└───┘││
            └──────────┘ └──────┘ └────┘ └─────┘│
                                                 │
                  ┌──────────────────────────────▼──┐
                  │         MESSAGE BUS / EVENT       │
                  │       STREAM (Kafka / SQS)        │
                  │                                   │
                  │  Topics/Queues:                   │
                  │  • order.created                  │
                  │  • payment.completed              │
                  │  • inventory.reserved             │
                  └──────────────┬────────────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │   NOTIFICATION SERVICE   │
                    │  Subscribes to events.   │
                    │  Sends email/SMS/push.   │
                    │  ┌─────────────────────┐ │
                    │  │  notification_log DB │ │
                    │  └─────────────────────┘ │
                    └─────────────────────────┘

         INFRASTRUCTURE (cross-cutting):

         ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
         │ SERVICE MESH │  │  DISTRIBUTED │  │  CENTRALIZED │
         │  (Istio /    │  │   TRACING    │  │    LOGGING   │
         │   Linkerd)   │  │ (Jaeger/X-Ray│  │(CloudWatch / │
         │  mTLS, retry │  │  trace IDs)  │  │ Elasticsearch│
         │  circuit-brk │  └──────────────┘  └──────────────┘
         └──────────────┘
```

---

### The Distributed Monolith Anti-Pattern (What to Avoid)

```
  ┌─────────────────────────────────────────────────────────┐
  │           DISTRIBUTED MONOLITH (BAD)                    │
  │  Separate deployments BUT shared state and tight        │
  │  coupling — worst of both worlds                        │
  │                                                         │
  │  Order Service ──reads directly──► Users DB             │
  │       │                              ▲  ▲              │
  │       └──reads directly──────────────┘  │              │
  │                                         │              │
  │  Payment Service ──reads directly───────┘              │
  │                                                         │
  │  Problems:                                              │
  │  • Cannot deploy Order Service without Users DB change  │
  │  • Cannot change Users DB schema without all services   │
  │  • "Independent" services with implicit coupling        │
  │  • All the latency cost of microservices                │
  │  • None of the autonomy benefit                         │
  └─────────────────────────────────────────────────────────┘
```

---

_→ Continued in: [02-Monolith vs Microservices.md](02-Monolith%20vs%20Microservices.md)_
