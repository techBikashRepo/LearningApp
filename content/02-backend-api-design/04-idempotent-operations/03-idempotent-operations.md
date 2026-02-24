# Idempotent Operations — Part 3 of 3

### Sections: 9 (Interview Prep), 10 (Comparison Tables), 11 (Quick Revision), 12 (Architect Thinking Exercise)

**Series:** Backend & API Design → REST APIs → System Design

---

## SECTION 9 — Interview Preparation

### Beginner Questions

**Q1: What does "idempotent" mean in REST? Why does it matter?**

_What the interviewer is testing:_ Foundational understanding of idempotency and its operational significance.

**Ideal Answer:**

An operation is idempotent if applying it multiple times produces the same result as applying it once.

```
Idempotent: PUT /users/123 {email: "new@x.com"}
  Call 1: email changed to new@x.com ✅
  Call 2: email is already new@x.com → changes to new@x.com ✅ (no change, same result)
  Call 100: same result every time ✅

NOT idempotent: POST /orders
  Call 1: creates order ORD-001 ✅
  Call 2: creates order ORD-002 ← DIFFERENT outcome
  Call 100: 100 orders created ❌
```

Why it matters: **networks fail, clients retry**. If a client sends a POST payment request and the network drops before the response arrives, the client doesn't know if the payment succeeded. It retries. Without idempotency: two payments. With idempotency: first payment returned again, no duplicate.

By HTTP spec:

- Idempotent: GET, HEAD, PUT, DELETE, OPTIONS
- Not idempotent: POST, PATCH (unless designed carefully)

---

**Q2: Why is DELETE considered idempotent even though the second call returns 404?**

_What the interviewer is testing:_ Precise understanding vs memorized definition.

**Ideal Answer:**

Idempotency is about the **state of the server**, not the status code in the response.

```
DELETE /orders/123

First call:
  - Server state: order 123 exists → deleted
  - Response: 204 No Content
  - Server state AFTER: order 123 does not exist

Second call (retry):
  - Server state: order 123 already doesn't exist
  - Response: 404 Not Found
  - Server state AFTER: order 123 still does not exist

Both calls result in the same server state: ORDER 123 DOES NOT EXIST.
That makes it idempotent, even though the HTTP status codes differ.
```

Practical implication: client retry code for DELETE should treat `404` as success, not as failure. If you get 404 on a DELETE retry, the resource is already gone — which is exactly what you wanted.

---

**Q3: Your colleague suggests: "Let's make POST idempotent by just ignoring duplicate requests that arrive within 30 seconds." What's wrong with this approach?**

_What the interviewer is testing:_ Critical thinking about idempotency implementation.

**Ideal Answer:**

Several problems:

1. **Time window is arbitrary and wrong**: What if the network failure lasts 31 seconds? The retry arrives just outside the window and creates a duplicate. What if processing takes 35 seconds? The retry arrives while the first is still processing.

2. **What defines "duplicate"?**: Without an idempotency key, how do you identify that two requests are the same? By matching all request fields? What if the user legitimately places two identical orders (same product, same amount) 5 seconds apart? Both should succeed.

3. **Window doesn't survive server restarts**: In-memory deduplication window disappears if the server restarts during the 30-second window.

4. **No distributed awareness**: If request 1 goes to Server A and the retry goes to Server B (load balanced), Server B has no knowledge of Server A's 30-second window.

Correct approach: **client-generated UUID idempotency key** stored in Redis. The key identifies a specific user intent (not just request matching). Same key + different body = error. Key TTL = 24 hours. Redis is distributed, persistent (AOF), and works across server restarts and load balancing.

---

### Intermediate Questions

**Q4: You're building a subscription management API. A user clicks "Subscribe to Pro Plan" on the UI. The frontend sends POST /subscriptions. Design idempotency for this flow from client to server, handling all error cases.**

_What the interviewer is testing:_ End-to-end idempotency design, not just server-side implementation.

**Complete Design:**

```
CLIENT SIDE (React/mobile app):

1. User clicks "Subscribe to Pro"
   → Generate UUID: subscriptionKey = crypto.randomUUID()
   → Store in sessionStorage: sessionStorage.setItem('sub-attempt', subscriptionKey)
   → (survives page refresh, lost on tab close — acceptable for subscriptions)

2. Submit request:
   POST /v1/subscriptions
   Idempotency-Key: <subscriptionKey>
   Body: { plan: "pro", billing_cycle: "monthly", payment_method_id: "pm_xxx" }

3. Response handling:
   201 Created → success! Clear stored key. Show "Subscription active" UI.
   200 OK (Idempotent-Replayed: true) → already subscribed. Show "already active" message.
   400 → validation error. DON'T retry. Show error to user. Clear stored key.
   402 Payment Required → payment failed. DON'T retry. Show payment error.
   429 Rate Limited → wait Retry-After seconds, then retry with SAME key.
   500/503 → retry with SAME key after exponential backoff.
   Network timeout → retry with SAME key from sessionStorage.

SERVER SIDE:

1. Extract Idempotency-Key header (400 if missing)
2. Redis NX: SET idem:{key}:lock 'processing' NX EX 86400
   → Lock acquired: proceed to processing
   → Lock exists with response: return stored response (200)
   → Lock exists without response (concurrency): return 409
3. Check: does this user already have a Pro subscription?
   → If yes: return 200 with existing subscription (business idempotency)
4. Process Stripe subscription (with Stripe idempotency key = same UUID)
5. INSERT subscription record in DB
6. Store response in Redis: SET idem:{key}:response {status:201, body:...} EX 86400
7. Return 201

STRIPE INTEGRATION — layered idempotency:
  stripe.subscriptions.create({
    customer: customerId,
    items: [{ price: 'price_pro_monthly' }],
  }, {
    idempotencyKey: subscriptionKey    ← SAME UUID passed to Stripe
  });

  Result: Even if our server crashes between Stripe call and DB insert,
  on retry: same idempotencyKey to Stripe → Stripe returns the existing
  subscription object (no duplicate charge).
  Our server: finds existing subscription → stores it → continues.

Error recovery for partial failure (Stripe success + DB failure):
  On retry: Redis lock exists? No (was removed on failure). Start fresh.
  Call Stripe with same idempotencyKey → Stripe returns existing subscription.
  DB insert → succeeds this time.
  Result: correct end state, no duplicate Stripe subscription.
```

---

**Q5: Explain the "exactly-once processing" guarantee. Can REST APIs truly achieve exactly-once?**

_What the interviewer is testing:_ Deep distributed systems understanding. Does the candidate know the difference between exactly-once delivery and exactly-once processing?\*

**Ideal Answer:**

Exactly-once is a spectrum with nuance.

**True exactly-once delivery is impossible** in distributed systems with unreliable networks (proven by the Two Generals Problem). A message can always be lost or duplicated by the network.

**Exactly-once processing is achievable** with the right design:

```
"At-least-once delivery + idempotent consumer = exactly-once effect"

At-least-once: we guarantee the request eventually reaches the server (retrying on failure)
Idempotent consumer: we guarantee the server processes the effect only once (idempotency key)
Result: the payment is charged exactly once, despite potential duplicate deliveries
```

The distinction:

- **Delivery**: acknowledgment of the request (network layer concern)
- **Processing**: execution of business logic (application layer concern)
- **Effect**: state change in your system (database layer concern)

```
Example:
  Request delivered: 3 times (2 retries)
  Request processed: 1 time (idempotency key deduplicated)
  Effect created: 1 time (one payment, one charge, one subscription)

  This is "exactly-once effect" — the goal.
  Not "exactly-once delivery" — impossible.
```

What we cannot guarantee even with idempotency:

- If the idempotency store (Redis) fails between lock acquisition and response storage → the effect is recorded in the primary DB but the lock is lost → retry creates a second attempt that might fail at DB level (unique constraint protects) but Stripe already has the first charge. Recovery requires reconciliation.

The practical guarantee: **"With idempotency keys and defense-in-depth layers, duplicate charges have probability < 0.001% rather than probability 1% on 10% network fault rate."**

---

### Advanced Questions

**Q6: Design idempotency for a distributed transaction that spans three services: Order Service, Inventory Service, and Payment Service. How do you ensure the composite operation is idempotent?**

_What the interviewer is testing:_ Combining idempotency with the Saga pattern for distributed transactions.\*

**Discussion:**

```
PROBLEM: Creating an order requires:
  1. Inventory Service: reserve the item
  2. Payment Service: charge the card
  3. Order Service: create the order record

These are three separate services. A network failure after step 1 or 2
leaves partial state. How do you handle retries for the composite operation?

SOLUTION: Saga + Idempotency Keys

Pattern used: CHOREOGRAPHY SAGA with idempotent steps

Step 1: Client sends POST /orders with Idempotency-Key: ORDER-uuid

Step 2: Order Service as orchestrator (ORCHESTRATION SAGA):
  a. Insert "order" with status "pending" + idempotency_key in DB
     ON CONFLICT (idempotency_key) DO UPDATE SET ... RETURNING *
     → If key exists: return existing order (safe)

  b. Call Inventory Service:
     POST /reservations  Idempotency-Key: ORDER-uuid-inventory
     (Derived idempotency key: same UUID + service suffix)
     → Inventory Service: idempotent on ORDER-uuid-inventory key

  c. Call Payment Service:
     POST /charges  Idempotency-Key: ORDER-uuid-payment
     (Derived idempotency key: same UUID + service suffix)
     → Payment Service: idempotent on ORDER-uuid-payment key

  d. Update order status to "confirmed" in DB
  e. Return 201 with order object

RETRY SCENARIO:
  Client retries with ORDER-uuid (same key).
  Order Service: finds existing order (idempotency_key match) → checks status.
    Status "pending": order being processed → 409 (in-flight)
    Status "confirmed": order complete → return 200 with existing order
    Status "failed": order failed → attempt fresh processing? OR return 200 with failure?
    → Best: return the previous failure response (200 with status "failed")
       Client shows "payment failed" again. User tries again with NEW key.

COMPENSATING TRANSACTIONS (failure recovery):
  Step 1 (inventory) succeeds.
  Step 2 (payment) fails with 402 Payment Failed.

  Compensation: POST /reservations/RESV-uuid/release
    Idempotency-Key: ORDER-uuid-inventory-release
    → Idempotent: can be called multiple times safely

  Order status → "failed"

Key naming convention:
  {business-key}-{service}-{action}
  ORDER-f47ac10b-inventory-reserve
  ORDER-f47ac10b-payment-charge
  ORDER-f47ac10b-inventory-release  ← for compensation

This ensures that even if the orchestrator crashes and restarts:
  It can resume by re-calling each service with the derived idempotency keys.
  Services return existing responses (not reprocessing). Orchestrator continues from where it left off.
```

---

## SECTION 10 — Comparison Tables

### HTTP Methods: Idempotency and Safety Reference

| Method      | Idempotent? | Safe?  | Cacheable? | When to Use                     | Idempotency Implementation            |
| ----------- | ----------- | ------ | ---------- | ------------------------------- | ------------------------------------- |
| **GET**     | ✅ Yes      | ✅ Yes | ✅ Yes     | Read resource/collection        | Built-in (no writes)                  |
| **HEAD**    | ✅ Yes      | ✅ Yes | ✅ Yes     | Check existence/metadata        | Built-in                              |
| **OPTIONS** | ✅ Yes      | ✅ Yes | ❌ No      | CORS preflight                  | Built-in                              |
| **PUT**     | ✅ Yes      | ❌ No  | ❌ No      | Replace full resource           | Built-in (same body = same state)     |
| **DELETE**  | ✅ Yes      | ❌ No  | ❌ No      | Remove resource                 | Built-in (404 on second = same state) |
| **PATCH**   | ⚠️ Maybe    | ❌ No  | ❌ No      | Partial update                  | Depends on patch document semantics   |
| **POST**    | ❌ No       | ❌ No  | ❌ No      | Create resource, trigger action | Must add Idempotency-Key header       |

### Idempotency Key Storage Options

| Option                      | Latency       | Durability             | Cost | Complexity            | Best For                                      |
| --------------------------- | ------------- | ---------------------- | ---- | --------------------- | --------------------------------------------- |
| **Redis (ElastiCache)**     | < 1ms         | Medium (AOF optional)  | $$   | Low                   | High-throughput APIs, payment systems         |
| **DynamoDB**                | 5-10ms        | High (managed)         | $$$  | Very Low (Powertools) | Serverless Lambda, no ops overhead            |
| **PostgreSQL**              | 5-20ms        | High (ACID)            | $$   | Medium                | When you want idempotency in same TX as order |
| **In-memory (single node)** | < 0.1ms       | None (lost on restart) | Free | None                  | Dev/test only — never production              |
| **DynamoDB + ElastiCache**  | < 1ms (cache) | High (DB fallback)     | $$$  | High                  | Mission-critical financial APIs               |

### Idempotency Key TTL Guidelines

| Domain                    | Recommended TTL | Reasoning                         |
| ------------------------- | --------------- | --------------------------------- |
| Payment charging          | 7 days          | Bank hold and settlement windows  |
| Subscription creation     | 24 hours        | Sufficient for retry storms       |
| Order creation            | 24 hours        | Same-day fulfillment window       |
| Report generation trigger | 1 hour          | Reports complete quickly          |
| Email/notification send   | 24 hours        | Deduplication window              |
| Webhook event processing  | 7 days          | Stripe/Shopify retry for 72 hours |
| Database backup trigger   | 1 hour          | Don't run twice in same cycle     |
| File upload creation      | 1 hour          | Upload sessions are short-lived   |

---

## SECTION 11 — Quick Revision

### 10 Key Takeaways

1. **Idempotent = same result regardless of how many times you call it**: GET, PUT, DELETE are idempotent by HTTP spec. POST is NOT — you must add idempotency externally.

2. **Networks always fail eventually**: Mobile apps lose connectivity, Lambda times out, API Gateway has a 29s hard limit. Retry logic is correct client behavior. Your server must handle retries safely.

3. **Client generates the idempotency key ONCE**: UUID v4, generated when the user takes the action. Stored locally. Same UUID on every retry. Never generate a new UUID for a retry.

4. **Redis NX = atomic check-and-set**: `SET key value NX EX 86400` either succeeds (first request) or fails (duplicate). Atomic — no race condition between check and set.

5. **Store response, not just a flag**: On second request, return the EXACT same HTTP status code and body as the first. `200 OK` (not `201 Created`) for replays, with `Idempotent-Replayed: true` header.

6. **Fail closed vs open on Redis failure**: For payments, fail closed (503) rather than allow potential duplicates. DB unique constraint as secondary defense.

7. **Same key + different body = error**: Client is misusing the key — two different operations with the same idempotency key. Return `422 Unprocessable` with explanation.

8. **Webhooks need idempotency too**: Stripe retries webhooks for 72 hours. Use event ID as idempotency key. Return 200 even for duplicates (otherwise the provider keeps retrying).

9. **Defense-in-depth**: Redis (fast) → DB unique constraint (fallback) → audit log (detection). No single layer failure should cause duplicate business effects.

10. **"At-least-once delivery + idempotent consumer = exactly-once effect"**: Exactly-once delivery is impossible. Exactly-once effect is achievable. This is the distributed systems idiom that solves the problem.

### 30-Second Explanation

"Idempotency means repeating an operation produces the same result as doing it once. GET, PUT, and DELETE are idempotent by HTTP spec. POST is not — each call creates a new resource. In distributed systems, clients always retry on network failures, so for POST operations (payments, orders, subscriptions) we add an Idempotency-Key header: a client-generated UUID per user action, reused on retries. The server uses Redis atomic NX to check if it's seen the key; if yes, returns the stored response without reprocessing. TTL is 24 hours (7 days for payments). This gives us exactly-once processing even with at-least-once delivery."

### Memory Tricks

**"GPD-HO" — idempotent HTTP methods:**

- **G**ET, **P**UT, **D**ELETE, **H**EAD, **O**PTIONS = idempotent
- **P**OST = not idempotent (needs Idempotency-Key)
- **P**ATCH = **P**robably not (depends on patch document)

**"GLOSS" — idempotency key lifecycle:**

- **G**enerate UUID ONCE per user intent
- **L**ocally store (survives network timeout)
- **O**nly same UUID on retries (never new UUID)
- **S**end as header every request
- **S**ucceed and clear: remove from local storage on 200/201

**Redis NX pattern: "Only if New, eXpire fast"**
`SET key value NX EX 86400`

- NX = only set if Not eXists (atomic idempotency check)
- EX = EXpire after 86400 seconds (24 hours)

---

## SECTION 12 — Architect Thinking Exercise

### The Problem

You're the Backend Architect at **MediClaim**, a health insurance claims processing company. When a patient visits a doctor, they submit a claim: doctor submits `POST /claims` with diagnosis codes, procedure codes, and billing amounts.

**Current situation:**

- 50,000 claims/day
- Mobile app used by doctors in hospitals with spotty Wi-Fi
- Current API: no idempotency (each POST creates a new claim)
- Problem: doctors see "spinner" for 10 seconds, think it failed, submit again → duplicate claims
- Average duplicates: 800/day (1.6% rate)
- Cost per duplicate: $35 claims processing + $150 manual review = $185/duplicate
- Total cost: $148,000/month in duplicate claim processing

**Your task:**

1. Design the idempotency system end-to-end
2. Estimate the infrastructure cost
3. Address the edge case: doctor legitimately submits two identical claims (same patient, same codes, same day — possible for multiple visits)
4. Design the monitoring strategy

---

_Think through the design. Then read the solution._

---

### Solution

#### 1. End-to-End Idempotency Design

```
CLIENT (doctor's mobile app — React Native):

Key generation strategy:
  // NOT random UUID — use content-based key with timestamp
  // Random UUID: two identical claims on same day would get different keys (wrong)
  // Content-based: two identical claims = same key = deduplicated (correct)

  BUT WAIT: Edge case #3 — doctor legitimately submits two identical claims?
  Content-based key would deduplicate them! That's WRONG.

  SOLUTION: Hybrid key strategy

  const claimKey = `${doctorId}-${patientId}-${visitDate}-${procedureCodes.sort().join(',')}-${attemptId}`;

  attemptId = UUID generated by the DOCTOR when they BEGIN filling out the form
  (stored in form state, survives network retries, reset when doctor starts a NEW claim form)

  Two different claim form instances by same doctor for same patient on same day:
    Form 1 opened at 9am: attemptId = uuid-A → claimKey = "D001-P123-2026-02-23-99213-uuid-A"
    Form 2 opened at 2pm: attemptId = uuid-B → claimKey = "D001-P123-2026-02-23-99213-uuid-B"
    → Different keys → both processed independently ✅

  Network retry of form 1 after timeout:
    Same attemptId = uuid-A → same claimKey → idempotent ✅

Retry logic:
  const MAX_RETRIES = 5;
  const RETRY_DELAYS = [2, 4, 8, 16, 32];  // seconds; exponential backoff

  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      const response = await submitClaim(claimKey, claimData);
      if (response.ok || response.status === 200) return response;
      if ([400, 422].includes(response.status)) break;  // validation error, don't retry
    } catch (networkError) {
      if (i < MAX_RETRIES - 1) await sleep(RETRY_DELAYS[i] * 1000);
    }
  }

SERVER SIDE:

API Gateway:
  → Require Idempotency-Key header (400 if missing)
  → Request validation against schema
  → Forward to Claims Lambda

Claims Lambda:
  1. Extract Idempotency-Key
  2. Redis NX check:
     SET idem:{key}:lock 'processing' NX EX 604800  ← 7 DAYS (insurance compliance)
     Reason: insurance claims can be reviewed/resubmitted within 7 days

  3. Business idempotency check (additional layer):
     Check if claim with same content hash exists for this doctor-patient-date combination
     within the last 5 minutes AND status is 'submitted' or 'processing'
     → Possible indication of aggressive retry without idempotency key
     → If found: check idempotency key
       Same key: return existing claim (idempotent replay)
       Different key: proceed (intentional second claim — possible legitimate)
     → If not found: proceed

  4. INSERT claim with idempotency_key (UNIQUE constraint in RDS)
  5. Submit to claims processing queue (SQS FIFO with deduplication)
  6. Store response in Redis with 7-day TTL
  7. Return 201 Created

EDGE CASE (legitimate duplicate claims same-day):
  Doctor opens Form 1 (morning visit), doctor opens Form 2 (afternoon visit).
  Both for patient P123, same codes (simple consultation - 99213).

  Different attemptIds → different idempotency keys → both succeed.
  System creates two claim records.
  Downstream claims processor: checks for same-day duplicate claim policy.
  Insurance business rule: "Two 99213 codes, same provider, same day, same patient → flag for review"
  → CLAIMS PROCESSING flags it, not our API layer.

  The API is not responsible for insurance business rules about claim frequencies.
  Only responsible for: do not create duplicate claims due to NETWORK ERRORS.
  Legitimate business duplicates pass through to the claims processor for review.
```

#### 2. Infrastructure Cost Estimate

```
Redis (ElastiCache r6g.large, 13GB RAM):
  Key size: ~2KB per claim (key + lock + response)
  50,000 claims × 2KB × 7 days retention = 700 MB
  r6g.large primary + 1 replica = $380/month
  Well within capacity for 50,000 claims/day

DynamoDB fallback (for Redis failure):
  On-demand pricing: ~$0.25 per million writes
  50,000 items/day × 30 = 1.5M writes/month = $0.375/month (negligible)
  Storage: 50,000 × 7 days × 30 × 2KB = 21 GB × $0.25/GB = $5.25/month

Total infrastructure cost: ~$390/month

ROI:
  Current cost of duplicates: $148,000/month
  Infrastructure cost: $390/month
  Monthly savings: $147,610
  ROI: 378× (37,800% return)
```

#### 3. Monitoring Strategy

```
CloudWatch Custom Metrics:

1. claims.idempotency_replays
   Monitor: count of 200 (replayed) vs 201 (new) responses
   Alarm: if replay rate > 5% of total POSTs → unusual retry pattern → investigate
   Dashboard: replay rate by doctor ID → identify problematic client versions

2. claims.duplicate_key_mismatch
   Monitor: count of 422 (same key + different body)
   Alarm: if > 0 per hour → client bug (key reuse logic broken)
   Action: push update to mobile app (force update if count spikes)

3. claims.redis_fallthrough
   Monitor: count of fallthrough to DynamoDB (Redis unavailable)
   Alarm: if > 0 → page on-call → investigate Redis health

4. claims.genuine_duplicates_prevented
   Monitor: claims where idempotency key matched existing claim
   KPI: this metric should grow as clients adopt new mobile version

5. claims.monthly_duplicate_cost_saved
   Business KPI derived from (idempotency replays × $185)
   Report to CTO quarterly to justify infrastructure investment
```

#### Final Architecture Principle

```
The key insight:
  "Idempotency is not about preventing retries — it's about making retries safe."

Doctors with slow hospital Wi-Fi WILL retry. Mobile apps WILL lose connectivity.
API Gateways WILL time out. The question is not "how do we stop retries?"
The question is: "given that retries will always happen, how do we make them harmless?"

The Idempotency-Key pattern + Redis NX + DB unique constraint = retries that are harmless.
$390/month of infrastructure → $148,000/month in prevented duplicate processing costs.
This is the business case for idempotency, not just an engineering nicety.
```
