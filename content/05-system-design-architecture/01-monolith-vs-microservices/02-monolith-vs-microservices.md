# Monolith vs Microservices — Part 2 of 3

### Sections: 5 (Request Flow), 6 (What Breaks When Responsibilities Mix), 7 (Team Scaling Impact), 8 (Monolith vs Distributed Implications)

**Series:** System Design & Architecture → Topic 01

---

## SECTION 5 — Request Flow Through Components

### Monolith: Checkout Request Flow

```
USER clicks "Place Order" at checkout.

1. Browser → HTTP POST /checkout
   │
   ▼
2. Load Balancer → routes to Monolith Process (instance A)
   │
   ▼
3. Web Layer (Controller)
   │  • Parse HTTP body: { cart_id, payment_token, address }
   │  • Validate: is user authenticated? (middleware)
   │  • Call CheckoutService.process(user, cart, payment_token, address)
   │
   ▼
4. CheckoutService.process() [Business Logic Layer]
   │
   ├─► InventoryModule.reserve(items)
   │     SQL: SELECT qty FROM products WHERE id IN (...)
   │     SQL: UPDATE products SET reserved = reserved + qty WHERE id = ...
   │
   ├─► PaymentModule.charge(user, total, payment_token)
   │     External HTTP call: POST https://api.stripe.com/v1/charges
   │     SQL: INSERT INTO payment_attempts (...)
   │
   ├─► OrderModule.create(user, items, payment_id, address)
   │     SQL: INSERT INTO orders (...)
   │     SQL: INSERT INTO order_items (...)
   │
   └─► NotificationModule.sendOrderConfirmation(order)
         Push to job queue: { type: 'order_confirmation', order_id: 123 }
         (async — does not block response)

   All DB operations above: ONE DATABASE TRANSACTION
   BEGIN → reserve → charge recorded → order created → COMMIT
   If stripe call fails: entire transaction rolls back. Clean.

5. Return HTTP 200: { order_id: 123, status: 'confirmed' }

Total: 1 process. 1 database. ~8 SQL queries. ~150ms.
Debug: one stack trace. grep one log file.
```

---

### Microservices: Checkout Request Flow (Synchronous Path)

```
USER clicks "Place Order" at checkout.

1. Browser → HTTP POST /checkout
   │
   ▼
2. API Gateway
   │  • Validates JWT token (introspects UserService or local cache)
   │  • Routes /checkout → Order Service
   │  • Injects correlation-id header: X-Trace-ID: abc-123
   │
   ▼
3. Order Service receives request
   │  • Calls Inventory Service: POST /reservations
   │  │   → HTTP hop, 5-15ms, can timeout, can 503
   │  │   → Inventory Service: UPDATE stock_levels SET reserved += qty
   │  │
   │  • Calls Payment Service: POST /charges
   │  │   → HTTP hop, 5-15ms + Stripe external call, can timeout, can 503
   │  │   → Payment Service: INSERT payment_attempts, call Stripe
   │  │
   │  • Creates order: INSERT INTO orders (DB write local to Orders Service)
   │  │
   │  • Publishes event to Kafka: topic=order.created
   │       payload: { order_id, user_id, items, payment_id, address }
   │
   ▼
4. Kafka broker stores event. Returns ack to Order Service.

5. Return HTTP 200: { order_id: 123, status: 'confirmed' }

6. (Async) Notification Service consumes order.created event
   → Renders email template
   → Sends via SendGrid

Total: 3 HTTP hops + 1 Kafka publish + 3 DB writes (in 3 separate DBs).
~200-400ms. 8+ network calls.

Debug: correlation-id abc-123. Check in:
  API Gateway logs (was the request routed?)
  Order Service logs (did it reach inventory?)
  Inventory Service logs (did stock reservation succeed?)
  Payment Service logs (did charge succeed?)
  Kafka consumer lag (did notification service consume the event?)
```

---

### Microservices: Checkout Request Flow (Saga / Async Path)

For higher resilience, the synchronous calls are replaced with a Saga:

```
Order Service publishes: "ReserveInventory" command to Saga orchestrator.
  │
  ▼
Inventory Service processes command. Publishes "InventoryReserved" event.
OR publishes "InventoryReservationFailed" and compensation begins.
  │
  ▼
Payment Service receives "InventoryReserved". Processes charge.
Publishes "PaymentCompleted" or "PaymentFailed".
  │
  ▼
If "PaymentFailed":
  Saga publishes "CancelInventoryReservation" command.
  Inventory Service releases reservation.
  User gets error response.
  │
  ▼
If "PaymentCompleted":
  Order Service finalizes order status.
  Notification Service notified.

Trade-off: higher resilience, no distributed transaction.
Cost: eventual consistency (order status is "pending" for 100-2000ms).
Complexity: each step needs compensation logic.
```

---

## SECTION 6 — What Breaks When Responsibilities Mix

### Violation 1: Business Logic in the Web Layer

```python
# BAD: Business rule lives in the controller
@app.route('/checkout', methods=['POST'])
def checkout():
    # Business logic: checking inventory availability is NOT a controller concern
    available = db.execute("SELECT qty FROM products WHERE id = %s", [product_id]).scalar()
    if available < requested_qty:
        return jsonify({"error": "out of stock"}), 400
    # Now: every other endpoint that needs inventory check must duplicate this.
    # Or: imports it from the controller (wrong direction).
    # Testing this: requires spinning up a web server.
    ...
```

**Production problem this causes:** Inventory check is duplicated in 4 endpoints. One is updated (adds a "reserved" quantity check). Three are not. Customers buy out-of-stock items. Overselling incident.

---

### Violation 2: Direct Database Access Across Service Boundaries

```python
# BAD: Order Service reading directly from User Service's database
# (Distributed monolith pattern)
class OrderService:
    def create_order(self, user_id, items):
        # Why is Orders reading the users table?
        # This creates cross-service coupling at the DATABASE level — the worst coupling.
        user = users_db.execute("SELECT * FROM users WHERE id = %s", [user_id]).fetchone()
        shipping_address = user['default_address']
        ...
```

**What breaks:** The User team changes the `users` schema — renames `default_address` to `shipping_address_id` (now a FK to an addresses table). Orders service crashes. At 3am. On a Friday. The User team had no idea Orders was reading their database. There was no contract, no versioning, no warning.

**Production incident template:** "Service X failed after unrelated Service Y schema migration." Published cause: hidden cross-service database coupling. This is one of the most common microservices outage patterns.

---

### Violation 3: Notification Logic Embedded in Business Logic

```python
# BAD: Payment service directly sending emails
class PaymentService:
    def process_payment(self, order):
        charge_result = stripe.charge(...)
        db.insert_payment(charge_result)
        # Why does Payment know about email templates?
        send_email(order.user.email, "payment_confirmation", {...})  # ← wrong
```

**What breaks:** Email provider (SendGrid) goes down. `payment_confirmation` email fails. Unhandled exception propagates. `process_payment()` returns error. Order is NOT marked as paid because the email failure was treated as a payment failure. Users charged but no order. Revenue vs. fulfillment discrepancy.

**Correct pattern:** Payment emits an event. Notification service—which owns the email responsibility—consumes it. If email fails: only the Notification service is degraded. Payment: unaffected.

---

### Violation 4: Sharing a Database Between Microservices

```
                  ┌──────────┐     ┌──────────┐
                  │ Order    │     │ Shipping │
                  │ Service  │     │ Service  │
                  └────┬─────┘     └────┬─────┘
                       │               │
                       └───────┬───────┘
                               │
                        ┌──────▼─────┐
                        │ Shared DB  │  ← ANTI-PATTERN
                        └────────────┘
```

Both services share the `orders` table. The Shipping team adds a column: `shipped_at`. They change the column type. They add a NOT NULL constraint. Orders team's service fails at INSERT because they don't set `shipped_at`. The "independent" services are not independent — they're a distributed monolith.

**Rule:** One service. One database. The database is private. Nobody else touches it.

---

## SECTION 7 — Team Scaling Impact

### Conway's Law in Practice

> "Any organization that designs a system will produce a design whose structure is a copy of the organization's communication structure." — Mel Conway, 1967

This is not theoretical. It is mechanically true.

```
If your org looks like this:           Your system will look like this:

┌─────────────────────────┐           ┌──────────────────────────┐
│   Single Engineering    │           │   Monolith with modules  │
│       Team (8 ppl)      │     →     │   (shared codebase)      │
└─────────────────────────┘           └──────────────────────────┘

┌──────────┐  ┌──────────┐            ┌──────────┐  ┌──────────┐
│ Orders   │  │Payments  │            │ Orders   │  │Payments  │
│  Team    │  │  Team    │     →      │ Service  │  │ Service  │
│ (5 ppl)  │  │ (4 ppl)  │           └──────────┘  └──────────┘
└──────────┘  └──────────┘
```

**Implication for architects:** If you design microservices before the teams exist to own them, you've coupled code architecture to an organizational structure you don't yet have. The services will leak into each other because the same developers own multiple services and take shortcuts.

---

### Team Autonomy Requirements for Microservices

Before splitting a monolith into microservices, each service must have:

```
REQUIREMENT 1: Team Ownership
  Each service owned by exactly one team.
  That team can deploy without coordinating with other teams.
  If Service A's deploy requires Service B team's approval: not autonomous.

REQUIREMENT 2: Independent Release Cadence
  Orders team ships 3x/week. Payments team ships 1x/week.
  Neither blocks the other.
  Requires: backward-compatible API versioning. Old clients still work
  after new service version deploys.

REQUIREMENT 3: On-Call Responsibility
  The team that owns the service is paged when it fails.
  "Microservices require you to own the service through the night" — Netflix CTO, 2015.
  At 10 engineers and 1 on-call rotation: 10 microservices = impossible support burden.

REQUIREMENT 4: Separate CI/CD Pipelines
  Order service deploys when its tests pass.
  It does NOT wait for Payments service tests to pass.

TEAM SIZE RULE (Amazon's "Two Pizza Teams"):
  Each microservice team: 5-8 people.
  Fewer than 5: not enough capacity to maintain a service independently.
  More than 8: communication overhead recreates the monolith problem within the team.
```

---

### When Microservices Hinder Team Velocity

```
Scenario: 12-engineer startup decides to build "microservices from day one."

Month 1: 4 services defined. Each engineer owns parts of multiple services.
Month 2: Adding a feature requires changes to 3 services simultaneously.
         Deploys require coordinating 3 service pipelines.
         Integration tests between services: flaky network timeouts.
Month 3: Engineers spending 40% of time on infrastructure (Kubernetes, service
         discovery, distributed tracing setup) instead of features.
Month 6: Product ships 50% fewer features than a comparable monolith-first team.
         Lead engineer: "We're building infrastructure, not a product."

Root cause: The organizational structure (1 team) didn't justify the architecture
(12 independent services). Architecture was premature.

Correct call: Modular monolith for the first 18-24 months and first 3M users.
              Split into services only when: (a) a specific bottleneck demands it,
              or (b) team grows past 20 engineers across 3+ feature domains.
```

---

## SECTION 8 — Monolith vs Distributed: Implications

### Failure Mode Comparison

```
┌────────────────────────────────────────────────────────────────┐
│              FAILURE MODE COMPARISON                           │
├──────────────────────┬─────────────────────────────────────────┤
│     MONOLITH         │           MICROSERVICES                 │
├──────────────────────┼─────────────────────────────────────────┤
│ Memory leak in one   │ Memory leak in Analytics service:       │
│ module:              │ Analytics crashes. Orders, Payments,    │
│ Entire process OOMs. │ Users: all continue serving traffic.    │
│ All features down.   │ Partial outage only.                    │
├──────────────────────┼─────────────────────────────────────────┤
│ Bad deployment:      │ Bad Orders service deployment:          │
│ 1 rollback of 1      │ Rollback Orders service only.           │
│ artifact. Fast.      │ Other services: unaffected.             │
├──────────────────────┼─────────────────────────────────────────┤
│ DB migration:        │ DB migration in Orders service:         │
│ Entire app must be   │ Orders service migration only.          │
│ coordinated.         │ Other services see no change.           │
│ Potential downtime.  │                                         │
├──────────────────────┼─────────────────────────────────────────┤
│ Cascading failure:   │ Cascading failure:                      │
│ Module A failing     │ Service A fails → Service B calls       │
│ = other modules see  │ Service A → Service B hangs (no         │
│ exception locally.   │ timeout) → Service B's thread pool      │
│ Same process: fast   │ exhausted → Service B fails → Service   │
│ failure detection.   │ C depends on B → C fails.               │
│                      │ Circuit breaker prevents this.          │
│                      │ Without circuit breaker: cascading      │
│                      │ failure brings down ENTIRE system.      │
│                      │ Worse than the monolith failure mode.   │
└──────────────────────┴─────────────────────────────────────────┘
```

---

### Data Consistency Implications

```
MONOLITH:
  Orders and Payments share one database.
  BEGIN;
    INSERT INTO orders (user_id, total) VALUES (42, 9900);
    UPDATE payment_attempts SET status='completed' WHERE id=88;
  COMMIT;
  ACID guaranteed. Either both committed or both rolled back.
  Consistency: immediate.

MICROSERVICES:
  Orders and Payments have separate databases.
  There is NO distributed transaction (2PC is impractical at scale).

  Pattern: Saga (Choreography)
  1. Orders service creates order with status=PENDING.
  2. Publishes OrderCreated event to Kafka.
  3. Payments service processes payment.
  4. Publishes PaymentCompleted event.
  5. Orders service consumes event, updates status=CONFIRMED.

  Time to consistency: 50ms–2000ms (depends on queue lag).

  Failure scenario: Orders service crashes after step 4 but before step 5.
  Payment: completed. Order: still PENDING.
  User: sees "payment processing" forever.
  Fix: idempotent event consumer + retry mechanism.
  Complexity: 5-10x vs monolith transaction.

  RULE: If you need strong consistency between two data entities,
  that is evidence they belong in the SAME service.
```

---

### Latency Implications

```
Function call within monolith:
  OrderService.create() → InventoryModule.reserve()
  Time: nanoseconds. No serialization. No network.

HTTP call between microservices:
  Orders Service → HTTP POST → Inventory Service
  Time: 5-50ms per hop.
  Breakdown:
    • TCP connection overhead: 1-5ms (or 0ms with keep-alive)
    • Serialization (JSON encode/decode): 0.1-1ms
    • Network traversal (within same AZ): 0.1-0.5ms
    • Receiver deserialization + processing + response serialization: 2-20ms

  Checkout flow with 4 synchronous service calls:
  4 × 15ms average = 60ms JUST in service-to-service overhead.
  Vs monolith: 0ms for the same cross-module calls.

  At 10,000 RPS with 4-hop checkout:
  Microservices overhead: 10,000 × 60ms × 4 connections worth of sockets
                          = significant infrastructure cost just for coordination.

  Mitigation: gRPC instead of HTTP/JSON (3-5x faster), service mesh with
  connection pooling, async patterns to eliminate synchronous dependency chains.
```

---

### Operational Complexity Comparison

```
                    MONOLITH          MICROSERVICES
─────────────────────────────────────────────────────
Deploy artifact:    1                 1 per service (N)
CI pipelines:       1                 N
Container images:   1                 N
Databases:          1                 N (1 per service)
Log streams:        1                 N (requires aggregation)
Metrics endpoints:  1                 N (requires aggregation)
On-call runbooks:   1 app             N apps + service mesh
                                      + event bus + gateway
k8s services:       1                 N
Health checks:      1                 N
Service discovery:  Not needed        Required
Distributed tracing:Not needed        Required
Circuit breakers:   Not needed        Required per dependency

OPERATIONAL BURDEN MULTIPLIER ≈ 6–10× per service added
```

This is why microservices require a **platform team** (DevOps / SRE team) dedicated to building and maintaining the infrastructure that makes the services operational. Without this team, microservices infrastructure becomes a tax paid by every feature team.

---

_→ Continued in: [03-Monolith vs Microservices.md](03-Monolith%20vs%20Microservices.md)_
