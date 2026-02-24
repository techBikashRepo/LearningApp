# Prevent Duplicate Payments — Part 3 of 3

### Sections: 9 (AWS Mapping), 10 (Interview Q&A), 11 (Debugging Exercise), 12 (Architect's Mental Model)

**Series:** Databases & Data Modeling → Topic 18

---

## SECTION 9 — AWS Service Mapping

### How AWS Services Handle Duplicate Payment Prevention

| Layer           | AWS Service           | How It Relates to Idempotency                                                                                                                                                          |
| --------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API Gateway     | Amazon API Gateway    | Built-in idempotency key support for HTTP APIs. Returns cached response for duplicate requests within 1-minute TTL.                                                                    |
| Lambda          | AWS Lambda            | Invocations are at-least-once. Idempotency in function logic (or PowerTools) required to prevent duplicate execution.                                                                  |
| SQS             | Amazon SQS            | Standard queues: at-least-once delivery (duplicates possible). FIFO queues: exactly-once delivery within a deduplication window (5 minutes). MessageDeduplicationId = idempotency key. |
| Database        | Amazon RDS / Aurora   | UNIQUE constraint + ON CONFLICT on RDS PostgreSQL/Aurora: same pattern as on-premise. Aurora: supports transactions with SERIALIZABLE isolation.                                       |
| PowerTools      | AWS Lambda Powertools | Python/TypeScript library with `@idempotent` decorator backed by DynamoDB. Handles concurrent executions, TTL, and status tracking automatically.                                      |
| DynamoDB        | Amazon DynamoDB       | Conditional writes (`ConditionExpression: attribute_not_exists(idempotency_key)`) provide idempotent writes. DynamoDB TTL purges old keys automatically.                               |
| Step Functions  | AWS Step Functions    | Standard Workflows: exactly-once execution per state. Built-in deduplication for long-running payment flows (order → payment → fulfillment).                                           |
| Payment Partner | Stripe, Adyen         | Stripe's `idempotency_key` header: any two requests with the same key return the same response. 24-hour TTL. Native gateway idempotency.                                               |

---

**AWS Lambda Powertools idempotency example:**

```python
from aws_lambda_powertools.utilities.idempotency import (
    idempotent, DynamoDBPersistenceLayer
)

persistence_layer = DynamoDBPersistenceLayer(table_name="IdempotencyTable")

@idempotent(persistence_store=persistence_layer)
def lambda_handler(event, context):
    # This entire function is idempotent.
    # If called twice with same event: second call returns first result.
    # DynamoDB stores result keyed by event hash.
    charge_customer(event['user_id'], event['amount_cents'])
    return {"status": "charged"}
```

---

## SECTION 10 — Interview Q&A

### Beginner Questions

**Q1: What is an idempotency key and why do payments need one?**

An idempotency key is a unique token attached to a payment request that lets the server identify duplicate requests. Payments need it because networks are unreliable: a client can send a request that the server processes successfully, but the acknowledgment never reaches the client. Without an idempotency key, the client's retry creates a second charge. With an idempotency key, the server detects the retry, finds the already-completed payment, and returns the previous result — charging the customer exactly once regardless of how many retries occur.

---

**Q2: What database constraint prevents duplicate payments?**

A `UNIQUE` constraint on the `idempotency_key` column, combined with PostgreSQL's `ON CONFLICT DO NOTHING` or `ON CONFLICT DO UPDATE`. When two concurrent requests carry the same idempotency key, the database serializes them: the first INSERT succeeds, the second INSERT hits the UNIQUE violation and takes the `ON CONFLICT` path — returning the existing payment result without creating a new charge. The constraint is the last line of defence that no application bug can bypass.

---

**Q3: Why is SELECT-then-INSERT a bad pattern for duplicate prevention?**

Because it has a time-of-check/time-of-use (TOCTOU) race condition. At read-committed isolation, two concurrent requests can both execute `SELECT WHERE idempotency_key = $x`, both find zero rows, and both proceed to INSERT — creating two duplicate payments. The gap between the SELECT and INSERT is a window where another transaction can slip through. A UNIQUE constraint eliminates this window because the check and the reservation happen atomically within a single INSERT statement.

---

### Intermediate Questions

**Q4: How does the 3-phase reservation pattern prevent duplicate payments under a crash?**

The 3-phase pattern is: (1) Reserve — INSERT a `processing` status row, (2) Execute — call the external payment gateway, (3) Confirm — UPDATE the row to `completed` with the gateway transaction ID. If the server crashes between phases 2 and 3, the idempotency key row exists with status `processing` and no gateway transaction ID. A background reconciliation job (using `FOR UPDATE SKIP LOCKED`) finds stale `processing` rows and queries the gateway to determine if the charge actually succeeded — then sets the final status. This means no transaction is permanently stuck and no double charge occurs even across crashes.

---

**Q5: What is speculative insert locking and how does it work?**

When two concurrent transactions try to INSERT the same unique key value, PostgreSQL doesn't immediately raise an error. Instead, it uses a speculative insert: the first transaction writes a tentative row and places a transient lock on that index entry. The second transaction detects the lock, waits briefly, and re-checks after the first transaction commits or rolls back. If the first committed (row exists), the second transaction takes the ON CONFLICT path. If the first rolled back (row gone), the second proceeds with its own INSERT. This happens entirely within the storage engine — no application code needed.

---

### Advanced Questions

**Q6: How do you design idempotency for a distributed microservice payment flow where 5 services each might process the same payment event?**

Each service maintains its own idempotency table keyed by `(service_name, idempotency_key)`. The orchestrator (e.g., Step Functions) assigns a single UUID per payment attempt and passes it through all services. Each service stores `(key, status, result)` and applies `ON CONFLICT DO NOTHING` on first write. If a service receives the same event twice, it finds its stored result and returns it without re-executing. The gateway's own idempotency key prevents double charges at the payment processor layer. Saga compensation handles partial failures: if service 3 fails, the compensating transaction in service 2 is also idempotent (keyed by `compensate-{original_key}`).

---

**Q7: At 500K transactions per second, UUID v4 idempotency keys cause index hot spots. How do you solve this?**

UUID v4 is random — inserts scatter uniformly across the B-tree index, causing high cache miss rates and page splits. At 500K TPS, this becomes a bottleneck. Solutions: (1) Switch to UUIDv7 (timestamp-prefixed, monotonically increasing) — inserts go to the rightmost leaf of the B-tree, maximizing buffer cache hit rate. (2) Use a `BIGINT` composite key: `(user_id, timestamp_ms, random_suffix)` — keeps inserts tenant-local and sequential. (3) Hash-partition the idempotency table on the leading bytes of the key — spreads hot leaf pages across partitions, each with its own autovacuum worker. UUIDv7 is the recommended default for >100K TPS.

---

## SECTION 11 — Debugging Exercise

### Production Incident: Double Charges on Mobile App Retry

**Scenario:**
Your fintech app sends push notifications for successful payments. The mobile team added a "retry on timeout" feature: if a payment API doesn't respond within 3 seconds, the SDK retries up to 3 times. Three days after deployment, the fraud team reports 1,847 duplicate charges in 72 hours.

**Evidence:**

```sql
-- How many duplicate charges occurred?
SELECT payment_gateway_txn_id, COUNT(*)
FROM payment_attempts
WHERE status = 'completed' AND created_at > NOW() - INTERVAL '3 days'
GROUP BY payment_gateway_txn_id
HAVING COUNT(*) > 1;
-- Returns: 1,847 rows. Each gateway_txn_id has 2 completed rows.

-- Check: are idempotency keys present on these duplicates?
SELECT idempotency_key, COUNT(*)
FROM payment_attempts
WHERE status = 'completed' AND created_at > NOW() - INTERVAL '3 days'
GROUP BY idempotency_key
HAVING COUNT(*) > 1;
-- Returns: 0 rows. Each idempotency key is UNIQUE across duplicates.
-- Implication: the mobile SDK is generating a NEW idempotency key on each retry!
```

**Root cause identification:**

```python
# Mobile SDK code (buggy):
def charge_customer(amount_cents):
    for attempt in range(3):
        # BUG: new UUID generated on every retry attempt
        idempotency_key = str(uuid.uuid4())  # ← new key each time!
        response = api.post('/charge',
            headers={'X-Idempotency-Key': idempotency_key},
            body={'amount': amount_cents})
        if response.status_code == 200:
            return response
        # Timeout: retry with NEW idempotency key → bypass server-side deduplication
```

**Fix:**

```python
# Correct: generate idempotency key ONCE per payment intent, retry with SAME key:
def charge_customer(amount_cents):
    idempotency_key = str(uuid.uuid4())  # ← generated ONCE before retry loop
    for attempt in range(3):
        response = api.post('/charge',
            headers={'X-Idempotency-Key': idempotency_key},  # same key every retry
            body={'amount': amount_cents})
        if response.status_code == 200:
            return response
        time.sleep(2 ** attempt)  # exponential backoff
```

**Server-side second layer (defense in depth):**

```sql
-- Also add gateway_txn_id UNIQUE constraint as a second prevention layer:
ALTER TABLE payment_attempts ADD CONSTRAINT uq_gateway_txn UNIQUE (payment_gateway_txn_id);
-- Even if a duplicate reaches the DB with a different idempotency key:
-- the gateway transaction ID constraint blocks it.
-- Two charges cannot have the same gateway txn ID.
```

---

## SECTION 12 — Architect's Mental Model

### 5 Decision Rules

1. **Idempotency key scope must match the user's intent, not the technical retry.** Key for "Alice buys shoes" = one UUID generated when she clicks "Pay". Not one per network retry. Generate once, reuse N times.

2. **The UNIQUE constraint is the guarantee; application checks are optimizations.** Any SELECT-before-INSERT check can fail under concurrency. The only true guarantee is the database UNIQUE constraint + ON CONFLICT inside a single atomic statement.

3. **Always use atomic updates for counter caches and status fields.** `UPDATE ... SET status = 'completed', txn_id = $x WHERE idempotency_key = $k AND status = 'processing'` — the WHERE clause is the guard. Two calls: only one succeeds. The other finds `status != processing` and stops. This is the idempotent update pattern.

4. **3-phase reservation beats 1-phase for external API calls.** You cannot make external calls (Stripe, Adyen, bank) inside a database transaction. Always: reserve slot first, call gateway, then confirm. Build reconciliation for the gap between phases 2 and 3.

5. **Idempotency keys expire — set a sensible TTL.** Stripe uses 24 hours. The key's purpose is to protect against network retries, not against re-payments days later. A 24-hour TTL covers 99.99% of retry scenarios while preventing the idempotency table from growing unboundedly.

---

### 3 Common Mistakes

**Mistake 1: Applying idempotency only to the payment step, not to all downstream effects.** Charging the card is idempotent, but what about the "send email receipt" step? Or "increment purchase count" step? Each downstream effect needs its own idempotency protection.

**Mistake 2: Storing idempotency keys in a different database than the payment record.** If the key database is down, you can't check for duplicates — you either block all payments or charge without checking. Keep the idempotency key in the same PostgreSQL database as the payment_attempts table so they're transactionally consistent.

**Mistake 3: Using customer+amount as the idempotency key instead of a UUID.** A customer can legitimately buy the same item for the same amount twice in quick succession. Using `(user_id, amount)` as the key would reject the second legitimate purchase. Always use a UUID generated per purchase intent.

---

### 30-Second Interview Answer

> "Duplicate payment prevention relies on idempotency keys — UUIDs generated once per payment intent by the client and sent with every retry. On the server, a `payment_attempts` table has a UNIQUE constraint on the idempotency key. Any INSERT with a duplicate key takes the ON CONFLICT path: returns the existing result without creating a new charge. The key insight is that the database constraint is the real guarantee — not application-level checks, which have TOCTOU race conditions. For calls to external gateways, I use a 3-phase pattern: reserve a database slot, call the gateway, then confirm — with a reconciliation job to handle crashes between phases 2 and 3."

---

_→ Next: [03-Normalization.md](../19 - Normalization/03-Normalization.md)_
