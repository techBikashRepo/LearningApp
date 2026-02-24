# Clean Architecture Basics — Part 2 of 3

### Sections: 5 (Request Flow), 6 (What Breaks When Layers Mix), 7 (Team Scaling Impact), 8 (Architectural Implications)

**Series:** System Design & Architecture → Topic 04

---

## SECTION 5 — Request Flow Through Clean Architecture

### POST /orders — The Complete Clean Architecture Flow

```
CLIENT
  POST /api/v1/orders
  Body: { "items": [{ "product_id": "p1", "qty": 2 }] }
  Authorization: Bearer <jwt>

─── RING 4: FRAMEWORKS & DRIVERS ───────────────────────────────────────

  Express server receives HTTP request.
  AuthMiddleware (Ring 4): validates JWT, extracts userId.
  Routes request to OrderController.handle(req, res).

─── RING 3: INTERFACE ADAPTERS (Controller) ─────────────────────────────

  OrderController.handle(req, res):
  │
  │  1. Build Use Case Input (REQUEST MODEL)
  │     const input: PlaceOrderInput = {
  │       userId: req.user.id,                     // from JWT (Ring 4 concern)
  │       items: req.body.items.map(i => ({
  │         productId: i.product_id,               // camelCase conversion
  │         quantity: i.qty,
  │       })),
  │     };
  │     Note: PlaceOrderInput is a PLAIN DATA OBJECT.
  │           Not an Express Request. Not a Prisma type.
  │
  │  2. Execute Use Case (cross ring boundary into Ring 2)
  │     const output = await this.placeOrderUseCase.execute(input);
  │
  │  3. Build HTTP Response from Use Case Output (RESPONSE MODEL)
  │     if (!output.success) → map error code → HTTP status → res.json
  │     if (output.success)  → HTTP 201 { order_id: output.orderId }

─── RING 2: USE CASES ────────────────────────────────────────────────────

  PlaceOrderUseCase.execute(input: PlaceOrderInput):
  │
  │  4. Load user (via interface — Ring 2 doesn't know it's PostgreSQL)
  │     const user = await this.userRepository.findById(input.userId);
  │     if (!user) return { success: false, error: 'USER_NOT_FOUND' };
  │
  │  5. Check inventory (via interface)
  │     const stock = await this.inventoryGateway.checkAvailability(input.items);
  │     if (!stock.available) return { success: false, error: 'INSUFFICIENT_STOCK' };
  │
  │  6. Construct domain entity (cross ring boundary into Ring 1)
  │     const order = Order.create({ userId: input.userId, items: input.items });
  │     ← Order validates its own invariants (items non-empty, etc.)
  │
  │  7. Process payment (via interface)
  │     const charge = await this.paymentGateway.charge(
  │       user.defaultPaymentMethodId, order.total
  │     );
  │     if (!charge.success) {
  │       await this.inventoryGateway.releaseReservation(input.items);  // compensate
  │       return { success: false, error: 'PAYMENT_FAILED' };
  │     }
  │
  │  8. Save order (via interface)
  │     const saved = await this.orderRepository.save(order.withChargeId(charge.id));
  │
  │  9. Return OUTPUT MODEL (plain data — not a domain entity exposed raw)
  │     return { success: true, orderId: saved.id.value };

─── RING 1: ENTITIES (called at step 6) ─────────────────────────────────

  Order.create():
  │  - Validates: items.length > 0 (throws InvalidOrderError if not)
  │  - Assigns new OrderId (UUID v4)
  │  - Sets initial status = OrderStatus.Pending
  │  - Calculates total = sum(item.qty × item.unitPrice)
  │  Returns: Order entity

─── RING 3: INTERFACE ADAPTERS (Repositories — at steps 4, 7, 8) ─────────

  PrismaUserRepository.findById(userId):
    prisma.user.findUnique({ where: { id: userId } })
    → maps Prisma record → User entity

  StripePaymentGateway.charge(paymentMethodId, amount):
    stripe.paymentIntents.create({ amount: amount.inCents(), ... })
    → wraps Stripe response → ChargeResult

  PrismaOrderRepository.save(order):
    prisma.order.create({ data: OrderMapper.toPrismaModel(order), ... })
    → maps Prisma record → Order entity

─── RING 3 → RING 4: BACK TO HTTP ───────────────────────────────────────

  Controller receives PlaceOrderOutput { success: true, orderId: "ord_abc" }
  Returns HTTP 201 { "order_id": "ord_abc" }

CLIENT receives 201.
```

---

### The Input/Output Boundary (Critical Detail)

```
RULE: Use Cases communicate with the outer world through plain data objects.
      They never expose domain entities directly as return values.

WHY:
  If UseCase returns an Order entity to the Controller,
  and the controller reaches into Order.items[0].price,
  then the controller has a dependency on the Order entity's structure.
  Change the Order entity (rename .price to .unitPrice):
  every controller using it must change.

CORRECT:

  // Use Case defines its own output type
  interface PlaceOrderOutput {
    success: boolean;
    orderId?: string;
    error?: 'USER_NOT_FOUND' | 'INSUFFICIENT_STOCK' | 'PAYMENT_FAILED';
  }

  // Controller only sees PlaceOrderOutput — never the Order domain entity
  const output: PlaceOrderOutput = await useCase.execute(input);

RESULT:
  Domain entity can evolve independently of the API contract.
  Output model is the stable contract. Entity is an internal implementation.
```

---

## SECTION 6 — What Breaks When the Dependency Rule Is Violated

### Violation 1: Entity Imports a Framework

```typescript
// BAD: Entity imports from Prisma
import { Prisma } from '@prisma/client';

class Order {
  // Prisma type used as a field type in the entity
  readonly prismaId: Prisma.OrderGetPayload<{}>;  // ← Ring 1 importing Ring 4

  async save(): Promise<void> {                    // ← Entity has a save() method??
    await prisma.order.update({ ... });            // Entity talks to the DB directly!
  }
}
```

**Production consequence:** To run any test that involves `Order`:

- Must import Prisma
- Must have a DATABASE_URL environment variable set
- Must have a running PostgreSQL

Every domain test becomes an integration test. CI time: 10-30 minutes. Flaky tests.

**Framework upgrade:** Prisma v4 → v5 changes the `Prisma.OrderGetPayload` type signature. Now ALL entity tests fail. To update a framework: you must touch business logic.

---

### Violation 2: Use Case Imports Concrete Infrastructure

```typescript
// BAD: Use Case knows about Stripe
import Stripe from 'stripe';  // ← Ring 2 importing Ring 4

class PlaceOrderUseCase {
  private stripe = new Stripe(process.env.STRIPE_KEY!);  // ← hardcoded

  async execute(input) {
    // ...
    const charge = await this.stripe.charges.create({...});  // ← Stripe in Use Case
  }
}
```

**Production consequence:** To test this use case, you need:

- `STRIPE_KEY` environment variable
- Network access to Stripe (or Stripe mock server running)
- Risk of accidentally charging real cards in non-production environments

**Migration problem:** Switching from Stripe to Braintree requires modifying the Use Case — business orchestration code must change because payment infrastructure changed. The Dependency Rule violation caused coupling between the business rule ("process payment") and the infrastructure ("Stripe API").

---

### Violation 3: Use Case Returns a Framework Type

```typescript
// BAD: Use Case returns a Prisma type
class PlaceOrderUseCase {
  async execute(input): Promise<Prisma.Order> {  // ← Ring 4 type in Ring 2 return
    const order = await prisma.order.create({...});
    return order;  // ← Prisma record returned as output
  }
}
```

**Controller code that breaks when Prisma schema changes:**

```typescript
// Controller
const order = await placeOrderUseCase.execute(input);
res.json({ order_id: order.id, total: order.total_amount });
//                                           ↑
// Prisma changed this column from total_amount to amount_total
// → Controller crashes at runtime
// → But the business logic didn't change!
// The controller is now coupled to a schema detail it shouldn't know about.
```

---

## SECTION 7 — Team Scaling Impact

### Feature Teams with Clean Architecture

```
Large engineering org: 40 engineers, 5 teams.

Team 1: Orders domain
  owns: domain/entities/Order.ts
        application/use-cases/PlaceOrderUseCase.ts
        application/use-cases/CancelOrderUseCase.ts
        application/ports/IOrderRepository.ts
        adapters/repositories/PrismaOrderRepository.ts

Team 2: Users domain
  owns: domain/entities/User.ts
        application/use-cases/RegisterUserUseCase.ts
        application/ports/IUserRepository.ts

Team 3: Payments infrastructure
  owns: adapters/gateways/StripePaymentGateway.ts
        adapters/gateways/BraintreePaymentGateway.ts

  CONTRACT: Team 3 must implement IPaymentGateway (defined by Team 1).
  Team 3 can change StripePaymentGateway internals freely.
  Team 3 cannot change the IPaymentGateway interface without Team 1 approval.

Team 4: HTTP + Infrastructure
  owns: infrastructure/http/server.ts
        infrastructure/di/container.ts
        infrastructure/database/migrations/

Team 5: Platform / DevOps
  owns: deployment, kubernetes, monitoring
  Doesn't touch application code.
```

**Development independence:**

- Team 3 migrates from Stripe to Braintree by implementing a new `BraintreePaymentGateway`.
- Team 3 updates the DI container to inject the new gateway.
- Teams 1, 2, 4, 5: zero code changes. Zero coordination required.
- PlaceOrderUseCase unit tests: still pass (they mock IPaymentGateway).
- Only Team 3's integration tests run against Braintree.

---

### Pull Request Scope in Clean Architecture

```
PR TYPE: "Add loyalty discount to order placement"

Files changed:
  domain/entities/Order.ts
    + getDiscountableTotal(): Money — new method on entity
  domain/entities/User.ts
    + loyaltyTier: LoyaltyTier — new field on User entity
  application/use-cases/PlaceOrderUseCase.ts
    + calls LoyaltyDiscountPolicy.apply(user.loyaltyTier, order.total)
  application/ports/IUserRepository.ts
    + findByIdWithLoyalty(id): Promise<User | null> — new port method
  adapters/repositories/PrismaUserRepository.ts
    + implements findByIdWithLoyalty using Prisma

PR scope: domain + use case + one repository implementation.
No HTTP changes. No Express changes. No database schema visible to PR.

PR reviewer checklist:
  ✅ LoyaltyDiscountPolicy is in the application/domain ring (no outer deps)
  ✅ No Prisma imports in domain or use-case files
  ✅ New unit tests for PlaceOrderUseCase with loyalty tier scenarios
  ✅ IUserRepository interface updated before implementation (ports first)
```

---

## SECTION 8 — Architectural Implications

### Comparing Clean Architecture vs Controller-Service-Repository

```
┌─────────────────────┬──────────────────────┬──────────────────────┐
│  DIMENSION          │  CONTROLLER-SERVICE  │  CLEAN ARCHITECTURE  │
│                     │    -REPOSITORY       │                      │
├─────────────────────┼──────────────────────┼──────────────────────┤
│ Domain isolation    │ Good (depends on     │ Excellent (Use Cases  │
│                     │ discipline/interfaces│ define interfaces in  │
│                     │ — but services often │ Ring 2; outer rings   │
│                     │ import ORM directly) │ MUST conform)        │
├─────────────────────┼──────────────────────┼──────────────────────┤
│ Boilerplate         │ Medium               │ High                 │
│                     │ 3 classes per        │ 5-6 files per        │
│                     │ feature area         │ feature area         │
│                     │                      │ (entity + use case + │
│                     │                      │ ports + adapter +    │
│                     │                      │ controller + mapper) │
├─────────────────────┼──────────────────────┼──────────────────────┤
│ Use Case clarity    │ Implicit             │ Explicit             │
│                     │ "There's a method    │ File = use case      │
│                     │  in OrderService"    │ PlaceOrderUseCase.ts │
│                     │                      │ = 1 class, 1 purpose │
├─────────────────────┼──────────────────────┼──────────────────────┤
│ Framework migration │ Difficult            │ Easy                 │
│                     │ Services may import  │ Ring 1 + Ring 2 have │
│                     │ ORM/HTTP types       │ ZERO framework imports│
│                     │                      │ Swap Express→Fastify: │
│                     │                      │ only Ring 4 changes  │
├─────────────────────┼──────────────────────┼──────────────────────┤
│ Test isolation      │ Good with interfaces │ Excellent            │
│                     │ Some services test   │ Ring 1 + Ring 2:     │
│                     │ against real infra   │ pure unit tests only │
│                     │ in practice          │ guaranteed           │
├─────────────────────┼──────────────────────┼──────────────────────┤
│ Entry barrier       │ Low                  │ Medium-High          │
│                     │ Any backend engineer │ Requires DIP, ports &│
│                     │ recognizes the       │ adapters, input/output│
│                     │ pattern immediately  │ boundary discipline  │
└─────────────────────┴──────────────────────┴──────────────────────┘

RECOMMENDATION:
  Start with Controller-Service-Repository.
  Migrate toward Clean Architecture per domain, as needed, when:
    (a) Service classes exceed 500 lines and multiple use cases are tangled
    (b) Framework migration is on the roadmap
    (c) Test suites are slow because services import infrastructure directly
```

---

_→ Continued in: [03-Clean Architecture Basics.md](03-Clean%20Architecture%20Basics.md)_
