# Prevent Duplicate Payments — Part 1 of 3

### Sections: 1 (Intuition & Analogy), 2 (Why This Exists), 3 (Internal Working), 4 (Query Execution Flow)

**Series:** Databases & Data Modeling → Topic 18

---

## SECTION 1 — Intuition & Analogy

### The Duplicate Check Problem

Imagine you're paying a restaurant bill. You tap your card. The terminal freezes. You're unsure if it went through. You tap again. The restaurant charges you twice. The bank sees two identical transactions — $47.50, same merchant, same card, 4 seconds apart. Unless the payment processor or the bank has a deduplication mechanism, you've been charged twice for one meal.

This exact scenario plays out in distributed systems at scale, every day. The difference: instead of $47.50, it might be $47,500 — and instead of one customer, it might be 10,000 simultaneous users hitting a payment endpoint during a flash sale.

```
The idempotent cheque metaphor:

Old-school bank cheques had a cheque NUMBER printed on them.
If you accidentally gave the same cheque to a vendor twice:
  the bank: "I already processed cheque #1847. Refusing the duplicate."
  Cheque number = idempotency key.
  The bank database: UNIQUE constraint on (account_number, cheque_number).
  Second attempt: rejected at the database layer, no double charge.

Modern payment duplicate prevention is the same idea:
  Your application generates a unique key per payment intent.
  Database stores that key with a UNIQUE constraint.
  Second attempt with same key: rejected before any money moves.
  Result: exactly-once payment semantics, regardless of retries.
```

The core challenge: networks are unreliable. Clients retry. Users double-click. Background jobs re-run. The application WILL see the same payment request more than once. The question is: does your database layer enforce that it only processes it once?

---

## SECTION 2 — Why This Problem Exists (Production Failures)

### Real-World Incidents: The Cost of Missing Duplicate Prevention

**Incident 1: E-commerce Flash Sale — 3,200 Double Charges**
Platform: mid-sized Southeast Asian e-commerce. Event: Mega Sale Day. Volume: 180K orders/hour at peak.
Problem: payment service was deployed behind a load balancer. Client-side `XMLHttpRequest` timeout: 5 seconds. Server processing time: ~4-7 seconds at peak. Result: client timed out before response, retried, server processed original request AND retry. 3,247 duplicate charges. Average order: $24. Total duplicate charges: $77,928. Refund processing time: 6 days.

Root cause: no idempotency key validation at the database layer. Only application-level "check if order exists" which had a race condition under load. Two concurrent retry requests: both passed the check before either committed.

---

**Incident 2: Subscription Renewal Service — Monthly Double Billing**
Platform: SaaS subscription service, 45,000 paying customers. Problem: a background billing job ran on a cron schedule. Job was taking longer than the cron interval (35 minutes vs 30-minute schedule). Two instances of the job overlapped. Both queried all users with `renewal_date <= NOW()`. Both found the same 12,000 users. Both charged them. ~4,200 users who received their invoice before the duplicate completed support tickets. $2.1M in duplicate charges identified in audit.

Root cause: no database-level protection against duplicate billing for the same (user_id, billing_period). Job-level deduplication was application logic that had a race condition due to overlapping job instances.

---

**Incident 3: Mobile App — Network Retry Storm**
Platform: ride-sharing app. Event: brief API gateway outage (90 seconds). Mobile clients: implemented aggressive retry with no idempotency key. During the 90-second outage: 800,000 payment requests queued in retry buffers. When gateway recovered: 800,000 requests fired simultaneously. 40% were duplicate (same underlying payment). 320,000 duplicate charges processed. Support ticket volume: 14x normal.

---

**What ALL three incidents share:** no UNIQUE constraint at the database layer enforcing that one payment intent = one charge. Application logic (checks, flags, locks) failed under concurrent load. Database constraints would have held.

---

## SECTION 3 — Internal Working

### How Duplicate Payment Prevention Works in PostgreSQL

**Core mechanism: Idempotency Keys + UNIQUE Constraint**

```sql
CREATE TABLE payment_attempts (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    idempotency_key     TEXT NOT NULL,            -- client-generated UUID per payment intent
    user_id             INTEGER NOT NULL,
    amount_cents        INTEGER NOT NULL,
    currency            CHAR(3) NOT NULL,
    status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'processing', 'succeeded', 'failed')),
    external_charge_id  TEXT,                     -- Stripe/payment gateway charge ID
    request_payload     JSONB,                    -- full request stored for idempotent response
    response_payload    JSONB,                    -- stored response to replay on duplicate
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at        TIMESTAMPTZ,

    CONSTRAINT uq_idempotency_key UNIQUE (idempotency_key)
    -- UNIQUE INDEX: B-tree on idempotency_key. Second attempt = duplicate key violation.
);

-- Partial index for active lookups (pending/processing only):
CREATE INDEX idx_payment_attempts_active
  ON payment_attempts (idempotency_key)
  WHERE status IN ('pending', 'processing');

-- For billing deduplication by period:
CREATE UNIQUE INDEX uq_user_billing_period
  ON payment_attempts (user_id, date_trunc('month', created_at))
  WHERE status = 'succeeded';
-- Prevents double billing for the same user in the same billing period.
```

---

**How PostgreSQL enforces the UNIQUE at the engine level:**

When `INSERT INTO payment_attempts (idempotency_key, ...) VALUES ('idem-UUID-abc', ...)` is executed:

1. PostgreSQL computes the B-tree key: `hash/sort value of 'idem-UUID-abc'`.
2. Descends the B-tree index on `idempotency_key` to locate the leaf page where this value belongs.
3. Before inserting: checks if the key already exists on that leaf page.
4. If key EXISTS: raises `ERROR 23505: duplicate key value violates unique constraint "uq_idempotency_key"`.
5. The INSERT never reaches the heap page. The transaction is rolled back (or can be caught via `ON CONFLICT`).

**Critical: this check is atomic and lock-protected.** Two concurrent INSERTs with the same key will race for the same B-tree leaf page. PostgreSQL's B-tree locking ensures only one succeeds. The second receives the duplicate key error — even if both arrive simultaneously.

---

**ON CONFLICT for idempotent response replay:**

```sql
-- The correct idempotent insert pattern:
INSERT INTO payment_attempts (
    idempotency_key, user_id, amount_cents, currency, request_payload
)
VALUES (
    $1, $2, $3, $4, $5
)
ON CONFLICT (idempotency_key) DO UPDATE
    SET response_payload = payment_attempts.response_payload  -- no-op (keep existing)
RETURNING id, status, response_payload, amount_cents;

-- Second request with same idempotency_key:
-- → hits ON CONFLICT clause
-- → returns the ORIGINAL response (stored in response_payload)
-- → application layer: detect "this is a replay" → return stored response to client
-- → NO second charge. NO error to client. Transparent deduplication.
```

---

**Two-phase pattern for safe payment execution:**

```sql
-- Phase 1: Reserve the idempotency slot (before calling payment gateway)
INSERT INTO payment_attempts (idempotency_key, user_id, amount_cents, currency, status)
VALUES ($key, $user_id, $amount, $currency, 'processing')
ON CONFLICT (idempotency_key) DO NOTHING
RETURNING id;
-- If returns NULL: duplicate. Look up existing record, return stored response.
-- If returns id: we own this slot. Proceed to Phase 2.

-- Phase 2: Call external payment gateway (Stripe, PayPal, etc.)
-- external_charge = stripe.charges.create(amount=$amount, ...)

-- Phase 3: Record outcome
UPDATE payment_attempts
SET status = 'succeeded',
    external_charge_id = $charge_id,
    response_payload = $response,
    completed_at = NOW()
WHERE id = $id;
```

This three-phase pattern ensures: even if the server crashes between Phase 2 and Phase 3, the idempotency slot is held (status='processing'). On retry: the conflict is detected, the status='processing' entry is found. A reconciliation job resolves 'processing' records by querying the payment gateway for their status. Never charges twice.

---

## SECTION 4 — Query Execution Flow

### Tracing an Idempotency Check Through PostgreSQL

**Scenario:** Client submits payment with idempotency key `idem-sale-9817ab`. This is the second attempt — the first succeeded 200ms ago.

```
Client → Application Server → PostgreSQL:
  INSERT INTO payment_attempts (idempotency_key, ...) VALUES ('idem-sale-9817ab', ...)
  ON CONFLICT (idempotency_key) DO UPDATE SET response_payload = payment_attempts.response_payload
  RETURNING id, status, response_payload;

PostgreSQL Execution Plan:
  INSERT ON CONFLICT DO UPDATE
    → Conflict Resolution: (idempotency_key)
    → Arbiter Index: uq_idempotency_key (B-tree on idempotency_key)

Step 1: Parse + Plan
  Parser: recognizes ON CONFLICT clause, identifies arbiter constraint uq_idempotency_key.
  Planner: generates "speculative insert" plan.
    Speculative insert: INSERT that atomically checks the constraint before committing.
    Lock mode: takes a speculative insertion lock on the key value before attempting.
    This prevents two concurrent inserts from both passing the uniqueness check.

Step 2: Speculative Insert
  Acquire speculative lock on 'idem-sale-9817ab' in the B-tree.
  Check B-tree for existing entry: found (page 7, slot 4).
  Determine: CONFLICT detected.
  Switch to UPDATE path (ON CONFLICT DO UPDATE).

Step 3: Execute Conflict Action
  DO UPDATE: SET response_payload = payment_attempts.response_payload
  This is a no-op assignment (sets to its own current value).
  But executes UPDATE to fire any ON CONFLICT triggers.
  Acquires ROW EXCLUSIVE lock on the conflicting row.

Step 4: RETURNING clause
  Reads current row values: id=48291, status='succeeded', response_payload='{charge_id:...}'.

Step 5: Return to Application
  Application receives: status='succeeded', stored response_payload.
  Detection: if status is already 'succeeded' → this is a replay, return stored response.
  Client receives: same response as original request. No second charge. No error.

Total latency: 1-2ms (B-tree lookup + no heap write needed for no-op).
```

**EXPLAIN ANALYZE output for the conflict-detected path:**

```sql
EXPLAIN ANALYZE
INSERT INTO payment_attempts (idempotency_key, user_id, amount_cents, currency)
VALUES ('idem-sale-9817ab', 42, 4750, 'USD')
ON CONFLICT (idempotency_key) DO NOTHING;

-- Insert on Conflict Do Nothing  (cost=0.43..0.45 rows=1 width=0) (actual time=0.312..0.312 rows=0)
--   Conflict Resolution: NOTHING
--   Conflicting Tuples: 1
--   ->  Index Scan using uq_idempotency_key on payment_attempts
--         (cost=0.43..0.44 rows=1 width=...) (actual time=0.281..0.281 rows=1)
--         Index Cond: (idempotency_key = 'idem-sale-9817ab')

-- "rows=0" in the INSERT node + "rows=1" in the Index Scan = conflict resolved.
-- Execution time: 0.312ms. No heap write. No duplicate charge.
```
