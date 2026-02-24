# Idempotent Operations — Part 1 of 3

### Sections: 1 (Intuition), 2 (Why It Exists), 3 (Core Technical Deep Dive), 4 (Real-World API Contract & Request Flow)

**Series:** Backend & API Design → REST APIs → System Design
**Topic:** Idempotent Operations — engineering safety for retries in distributed systems

---

## SECTION 1 — Intuition: Build the Mental Model First

### Analogy 1: The Light Switch

Flipping a light switch **on**: the first flip turns it on. Flipping it on again: it's still on. Flipping it on a third time: still on. No matter how many times you "turn it on", the outcome is always "the light is on".

This is **idempotent**: applying the same operation multiple times produces the same result as applying it once.

Now imagine if the light switch were a **toggle** instead. Every flip changes state. On → Off → On → Off. This is **NOT idempotent**: the result depends on how many times you apply the operation.

```
Idempotent:   TURN ON  →  TURN ON  →  TURN ON    = LIGHT IS ON (same every time)
Not idempotent: TOGGLE → TOGGLE → TOGGLE → TOGGLE  = LIGHT IS ON, OFF, ON, OFF (depends on count)
```

In REST APIs:

- `PUT /lights/123` with body `{status: "on"}` = idempotent (always sets it on)
- `POST /lights/123/toggle` = NOT idempotent (result depends on current state)

### Analogy 2: The Bank Teller vs ATM

Walk up to a bank teller and say: "Withdraw $100. Check number 1041."

The teller sees check #1041 and searches their ledger: "Has check #1041 been processed before?"

- No: process the withdrawal. Record check #1041 in ledger as processed.
- Yes (duplicate): "This check was already cashed yesterday. Here's your original receipt."

**The check number makes the withdrawal idempotent.** Even if the same check is presented twice, the bank's system processes the effect once. The check number is the **idempotency key**.

Without the check number: "Withdraw $100" — no reference. Bank can't know if you already asked for this. Each request creates a new withdrawal. Submit twice → two $100 withdrawals.

### Analogy 3: The Exact-Same Letter

You mail yourself a letter: "My address is 123 Baker St."

The letter gets lost in the post office. You mail the same letter again. And again. You send 5 copies.

Eventually all 5 arrive. What's the final state of your knowledge? **"My address is 123 Baker St."** — same regardless of whether you received 1 letter or 5. Idempotent.

Now imagine instead: "Add $100 to my bank account." You write this and send 5 copies because the first seems lost. All 5 arrive. Your balance went up by $500. **Not idempotent** — the number of successful deliveries changed the outcome.

---

## SECTION 2 — Why It Exists: The Problems Without Idempotency

### Reality #1: Networks Always Fail Eventually

```
Client  ───────────────────────────────────────  Server
  |                                                |
  |  POST /payments {amount: 9999, card: "..."}   |
  |───────────────────────────────────────────────▶
  |                                                |  Server processes payment
  |                                                |  COMMITS charge to Stripe
  |                                                |  Creates ORDER record in DB
  |                                                |  Attempts to send HTTP response...
  |                                 [NETWORK DROPS]
  |◀──────────────────────────── CONNECTION RESET
  |
  |  Client thinks: "Request failed! Must retry!"
  |
  |  POST /payments {amount: 9999, card: "..."}   |
  |───────────────────────────────────────────────▶
  |                                                |  Server processes payment AGAIN
  |                                                |  COMMITS second charge to Stripe
  |◀──────────────────────────── 201 Created (2nd)|
  |
RESULT: Customer charged TWICE for ONE order
```

**Network partitions are not rare.** Mobile networks: packet loss 2-5%. CDN to origin: TCP timeouts happen. Lambda cold starts + timeouts: client gives up and retries. AWS API Gateway: 29s timeout → client retries.

Every production system assumes retries will happen.

### Reality #2: Distributed System Failures Are Partial

```
Order Service called:
  Step 1: Validate inventory ────────────── ✅
  Step 2: Reserve inventory ─────────────── ✅
  Step 3: Charge payment ─────────────────── ✅ (Stripe charged!)
  Step 4: Create order record ────────────── ❌ (DB timeout!)

  Order service returns: 500 Internal Server Error

  Client retries:
  Step 1: Validate inventory ────────────── ✅
  Step 2: Reserve inventory ─────────────── ❌! (already reserved — 409 conflict)

Without idempotency:
  - Customer has been charged (step 3 succeeded) but has no order
  - Retry fails at step 2 or creates a second charge
  - Support ticket + manual refund + brand damage
```

### Reality #3: Client Retry Logic is Everywhere and Necessary

```
ALL of these retry without being asked:
  - HTTP clients with retry-on-5xx (axios, requests, fetch with retry)
  - AWS SDK: automatic retries on throttling (429) and transient errors (503)
  - Mobile apps: retry on network reconnect
  - API Gateway: no retry, but client SDKs do
  - Kubernetes: retries on readiness probe failures
  - Message queue consumers: retry on processing failure

These client-side retries are CORRECT behavior. The problem is when the SERVER isn't ready for them.
```

### The Business Impact of Not Having Idempotency

Real incidents from companies that learned the hard way:

```
INCIDENT 1 — E-commerce checkout (2021, unnamed retailer):
  During Black Friday, AWS API Gateway response times spiked to 28s (near the 29s timeout).
  Client SDKs timed out and retried. Same payment processed 2-3x for ~3,000 orders.
  Result: $180,000 in duplicate charges. 2-week refund processing effort.

INCIDENT 2 — Fintech mobile app (2020):
  iOS app retry logic fired on "request timed out" at 10s.
  AWS Lambda was actually just slow (cold start + heavy compute).
  Lambda responded at 12s — client had already retried at 10s.
  Both Lambda invocations completed. Two money transfers per user tap.
  Result: Users discovered duplicates after seeing their balance wrong.

INCIDENT 3 — SaaS billing system:
  Webhook from Stripe fired twice (Stripe retries webhooks for 72 hours).
  "Invoice paid" event processed twice → subscription extended twice →
  accounting records doubled → month-end reconciliation couldn't balance.
```

---

## SECTION 3 — Core Technical Deep Dive

### HTTP Method Idempotency by Specification

| Method      | Idempotent? | Safe?  | Rationale                                                                                                                      |
| ----------- | ----------- | ------ | ------------------------------------------------------------------------------------------------------------------------------ |
| **GET**     | ✅ Yes      | ✅ Yes | Reading doesn't change state. Call 1000 times → same result.                                                                   |
| **HEAD**    | ✅ Yes      | ✅ Yes | Same as GET but no body.                                                                                                       |
| **OPTIONS** | ✅ Yes      | ✅ Yes | Returns server capabilities — no state change.                                                                                 |
| **PUT**     | ✅ Yes      | ❌ No  | Replaces resource with the given representation. 100 PUTs with same body = same final state.                                   |
| **DELETE**  | ✅ Yes      | ❌ No  | First call: deletes, returns 200/204. Second call: resource gone, returns 404. But end state is same: resource does not exist. |
| **PATCH**   | ⚠️ Maybe    | ❌ No  | Depends on the patch semantics. `{email: "new@x.com"}` is idempotent. `{$increment: amount}` is not.                           |
| **POST**    | ❌ No       | ❌ No  | Creates new resources. Calling twice → two resources. Must add idempotency externally.                                         |

### The Idempotency Key Pattern

The industry-standard solution for making POST requests idempotent:

```
CLIENT SIDE:
  1. Generate a UUID when the user initiates an action (once per user intent)
  2. Send it as: Idempotency-Key: <uuid-v4>
  3. On retry (network failure, timeout): SAME UUID, same request body
  4. Never generate a new UUID on retry — new UUID = new independent request

SERVER SIDE:
  1. Extract Idempotency-Key from header
  2. Check Redis/DB: have we seen this key before?
     IF YES: return the EXACT same response as before (no processing)
     IF NO:  process the request, store result with the key, return response

IMPLEMENTATION:
  function handlePostPayment(req, res) {
    const idempotencyKey = req.headers['idempotency-key'];

    // Validate key exists and looks like UUID
    if (!idempotencyKey || !isValidUUID(idempotencyKey)) {
      return res.status(400).json({ error: 'Idempotency-Key header required' });
    }

    // Atomic check-and-lock in Redis
    const lockResult = await redis.set(
      `idem:${idempotencyKey}:lock`,
      'processing',
      'NX',           // Only set if Not eXists
      'EX', 86400     // TTL: 24 hours
    );

    if (lockResult === null) {
      // Key exists — check if we have a stored response
      const stored = await redis.get(`idem:${idempotencyKey}:response`);
      if (stored) {
        const { statusCode, body } = JSON.parse(stored);
        return res.status(statusCode).json(body);
      }
      // Key exists but no response yet — concurrent duplicate in flight
      return res.status(409).json({
        error: 'duplicate_request',
        message: 'An identical request is currently being processed'
      });
    }

    try {
      // Process the payment
      const payment = await processPayment(req.body);
      const responseBody = { payment_id: payment.id, status: payment.status };

      // Store result under idempotency key
      await redis.set(
        `idem:${idempotencyKey}:response`,
        JSON.stringify({ statusCode: 201, body: responseBody }),
        'EX', 86400     // Same TTL as the lock
      );

      return res.status(201).json(responseBody);

    } catch (error) {
      // Remove lock on failure so client can retry with same key
      await redis.del(`idem:${idempotencyKey}:lock`);
      throw error;
    }
  }
```

### Key Edge Cases to Handle

```
EDGE CASE 1: What if the same Idempotency-Key is used with different request body?
  Client sends:
    POST /payments  Idempotency-Key: uuid-1  Body: { amount: 100 }
    POST /payments  Idempotency-Key: uuid-1  Body: { amount: 999 }   ← different body!

  Server should: return 422 Unprocessable Entity
  "The Idempotency-Key was used with a different request body."

  Detection: Hash the request body (SHA-256), store alongside idempotency key.
  On subsequent request: compare body hash. If different → error (not a retry, an abuse).

  Code:
    const bodyHash = crypto.createHash('sha256').update(JSON.stringify(req.body)).digest('hex');
    const stored = await redis.get(`idem:${idempotencyKey}:hash`);
    if (stored && stored !== bodyHash) {
      return res.status(422).json({ error: 'idempotency_key_reuse_mismatch' });
    }
    await redis.set(`idem:${idempotencyKey}:hash`, bodyHash, 'EX', 86400);

EDGE CASE 2: What if the first request fails?
  Client sends request. Server starts processing. DB fails at the last step.
  Server: removes lock from Redis, returns 500.
  Client: retries with SAME idempotency key.
  Server: key not in Redis (was removed) → processes as new request.
  → CORRECT: Failed requests can be retried.

  Only SUCCESSFUL operations are stored under the idempotency key.
  Failed operations: remove the lock, let client retry.

EDGE CASE 3: What if two requests with the same key arrive simultaneously?
  (Client sends two requests simultaneously due to a race condition)
  Request 1: NX set succeeds → starts processing
  Request 2: NX set fails (key exists) → returns 409 Conflict
  "A request with this key is currently in flight. Retry in a moment if you're not already getting a response."

EDGE CASE 4: TTL expiry
  Idempotency key expires after 24 hours.
  Client retries a 25-hour-old request with the same key.
  → Server treats as new request (key expired → no stored response).
  → This is the intended behavior: after 24 hours, we consider the original request abandoned.
  → Client should not retry after 24 hours with the same key.

  For financial operations: longer TTL (7 days) recommended.
  Business rule: "A payment attempt is considered unique for 7 days."

EDGE CASE 5: DELETE idempotency treatment
  DELETE /orders/ORD-123
    First call: 204 No Content (order deleted)
    Second call (retry): 404 Not Found

  Technically the response is different (204 vs 404).
  BUT: the semantic state is the same ("order does not exist").

  Best practice for DELETE retries: treat 404 as success.
  Client retry code: if (statusCode === 404 || statusCode === 204) → success

  Do NOT add idempotency keys to DELETE — it's over-engineering.
  DELETE is already idempotent in effect; 404 on retry is acceptable.
```

### Idempotency Key Requirements

```
Key format: UUID v4 (RFC 4122)
  f47ac10b-58cc-4372-a567-0e02b2c3d479

Why UUID v4:
  - Random → globally unique with negligible collision probability (2^122 possible values)
  - Client-generated → server doesn't need to issue keys in advance
  - Standard → every language/platform has UUID v4 generation built-in

Key storage: Redis with TTL
  Why Redis:
    - atomic NX operation (check-and-set with no race condition)
    - Auto-expiry with TTL
    - Fast enough: O(1) get/set
    - Distributed: multiple servers share the same key store

  DynamoDB as alternative:
    - PutItem with ConditionExpression: attribute_not_exists(PK)
    - TTL attribute for auto-expiry
    - Conditional write IS the idempotency check (one atomic operation)

  PostgreSQL as alternative:
    - INSERT INTO idempotency_keys (key, response, expires_at) VALUES (...)
       ON CONFLICT (key) DO NOTHING
    - RETURNING id to check if insert happened (0 rows = duplicate)
    - Slower than Redis but consistent with your transactional DB

Default TTL: 24 hours for most APIs
Financial APIs: 7 days (match standard bank settlement windows)
Background job triggers: 1 hour (job usually completes faster)
```

---

## SECTION 4 — Real-World API Contract: Payment Processing System

### Scenario

You're designing the payment API for FleetPay, a fleet management company. Drivers create expense payments (fuel, tolls, repairs). Mobile apps on unreliable cellular networks.

### Full API Design with Idempotency

```
Payment Creation (must be idempotent — most critical operation)
POST /v1/payments
Headers:
  Authorization: Bearer <jwt>
  Idempotency-Key: <uuid-v4>   ← REQUIRED
  Content-Type: application/json
  X-Request-ID: <uuid>          ← tracing

Body:
  {
    "type": "fuel",
    "amount": {
      "value": 8547,         ← cents to avoid float precision issues
      "currency": "USD"
    },
    "merchant": {
      "id": "MERCH-Shell-1234",
      "name": "Shell Station #1234",
      "mcc": "5541"           ← merchant category code
    },
    "card_id": "CARD-f47ac10b",
    "vehicle_id": "VEH-abc123",
    "receipt_photo_id": "MEDIA-xyz789",
    "captured_at": "2026-02-23T14:23:00Z"
  }

Success response: 201 Created
  {
    "payment_id": "PAY-9821abc",
    "idempotency_key": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    "status": "approved",
    "amount": { "value": 8547, "currency": "USD" },
    "approved_at": "2026-02-23T14:23:02Z",
    "authorization_code": "AUTH-12345",
    "_links": {
      "self": "/v1/payments/PAY-9821abc",
      "receipt": "/v1/payments/PAY-9821abc/receipt"
    }
  }

Duplicate request (same Idempotency-Key): 200 OK (not 201)
  Same response body as the first call.
  Idempotent-Replayed: true   ← header indicating this is a replayed response

  Why 200 not 201?
    201 = Created (something was created this request)
    200 = OK (here's the resource, but it already existed)
    Duplicate idempotent response = 200 to signal no creation occurred.
    Stripe and most financial APIs follow this convention.
```

### Complete Request Flow with Idempotency

```
STEP 1: Client generates idempotency key
  const idempotencyKey = crypto.randomUUID();  // ONCE per user action
  localStorage.set(`payment-attempt-${expenseId}`, idempotencyKey);
  // Store to survive app crash/restart

STEP 2: Send request
  POST /v1/payments
  Idempotency-Key: f47ac10b-58cc-4372-a567-0e02b2c3d479
  Body: { amount: 8547, ... }

STEP 3: Network drops at T+8s (API GW timeout is 29s, mobile SDK timeout is 10s)

STEP 4: Client retry
  const storedKey = localStorage.get(`payment-attempt-${expenseId}`);
  // SAME KEY — not a new UUID
  POST /v1/payments
  Idempotency-Key: f47ac10b-58cc-4372-a567-0e02b2c3d479   ← same
  Body: { amount: 8547, ... }                              ← same

STEP 5: Server receives retry
  redis.get('idem:f47ac10b-58cc-4372:response')
  → Returns stored response from step 2
  → Returns 200 with existing payment (not 201 — nothing new created)
  → NO second charge to card

STEP 6: Client receives 200
  Payment ID: PAY-9821abc (same as before)
  App confirms: payment already processed
  localStorage.remove(`payment-attempt-${expenseId}`);
```

### Failure Scenarios and Recovery

```
SCENARIO A: Payment succeeds but response never reaches client
  T+0ms: POST /payments arrives at server
  T+5ms: Server charges card ✅
  T+6ms: Server inserts payment record in DB ✅
  T+7ms: Server stores idempotency response in Redis ✅
  T+8ms: Server sends HTTP response
  [NETWORK: response packet dropped]
  Client: timeout at T+10ms → "error: network"

  Client retry: POST with same idempotency key
  Server: reads from Redis → returns stored 201/200 response
  Client receives: payment confirmed
  Card: charged ONCE ✅ (idempotency key ensures)

SCENARIO B: Server fails DURING processing (partial failure)
  T+0ms: POST /payments arrives
  T+3ms: Redis NX set succeeds (processing started)
  T+5ms: Card charged ✅
  T+7ms: DB INSERT fails ❌ (write timeout)
  Server: rolls back, removes idempotency lock from Redis, returns 500

  Client retry: POST with same key
  Server: Redis check → key gone (was removed) → start fresh
  Server processes from scratch: card charge created again
  THIS MEANS: The Stripe charge from T+5ms was not refunded automatically!

  CRITICAL LESSON: The idempotency lock removal in the error case is DANGEROUS
  for external payment processors (Stripe, etc.).

  CORRECT PATTERN:
    Before charging: generate a Stripe payment intent ID
    Store: idem_key → stripe_payment_intent_id BEFORE charging
    If DB fails after charge: retry will find the existing Stripe charge intent
    No double charge because Stripe payment intent is idempotent too

SCENARIO C: Idempotency key expires between request and retry
  T+0s: Request fails before processing (server error before charge)
  T+87000s (24+ hours): Client retries with same key
  Server: key expired from Redis → treats as new request → processes fresh

  Result: May process twice if FIRST request actually succeeded (Stripe took longer to respond)

  LESSON: Set TTL to beyond the maximum reasonable processing time.
  For payments: 7 days (bank hold windows, delayed captures).
  Log all idempotency key usage → audit trail for compliance.
```

### Idempotency for Webhook Events

```
Problem: Webhook providers (Stripe, Shopify, GitHub) retry webhooks for 72+ hours.
Every retry is a duplicate event delivery.

Solution: Treat event_id as idempotency key.

POST /webhooks/stripe
Body: {
  "id": "evt_3Mq8K2LkdIwHu7iDE02iD1X",   ← Stripe event ID
  "type": "payment_intent.succeeded",
  "data": { ... }
}

Handler:
  const eventId = req.body.id;
  const processed = await redis.set(
    `webhook:processed:${eventId}`,
    'true',
    'NX',
    'EX', 604800  // 7 days (Stripe retries for 72h, extra buffer)
  );

  if (!processed) {
    // Already processed this event_id
    return res.status(200).json({ received: true });  // 200 to stop retries
  }

  // Process the event (update subscription, send email, etc.)
  await processStripeEvent(req.body);
  return res.status(200).json({ received: true });

IMPORTANT: Return 200 even for duplicates!
  If you return 4xx for a duplicate: Stripe thinks it failed → keeps retrying → infinite duplicates
  If you return 200: Stripe knows it succeeded → stops retrying
```
