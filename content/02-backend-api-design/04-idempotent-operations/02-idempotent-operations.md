# Idempotent Operations — Part 2 of 3

### Sections: 5 (Architecture Diagram), 6 (Production Scenarios), 7 (Scaling & Reliability), 8 (AWS Mapping)

**Series:** Backend & API Design → REST APIs → System Design

---

## SECTION 5 — Architecture Diagram: Idempotency Layer in Production

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                   IDEMPOTENCY LAYER — PRODUCTION ARCHITECTURE                    │
│                                                                                   │
│  CLIENT (mobile/web)                                                              │
│  ┌──────────────────────────────────────────────────────────────────────────┐   │
│  │ 1. Generate UUID per user action (ONCE — stored locally)                  │   │
│  │ 2. POST /payments  Idempotency-Key: uuid-v4                               │   │
│  │ 3. On timeout/5xx: retry with SAME UUID (not new)                         │   │
│  │ 4. On 200/201: clear stored UUID                                          │   │
│  └─────────────────────┬────────────────────────────────────────────────────┘   │
│                         │                                                         │
│                         ▼                                                         │
│  ┌────────────────────────────────────────────────────────────────────────────┐  │
│  │                          API GATEWAY                                       │  │
│  │  Validates: Idempotency-Key header present (400 if missing for PUT /pay)   │  │
│  │  Validates: UUID v4 format (400 if invalid)                                │  │
│  │  Rate limiting per API key                                                 │  │
│  │  Passes header to Lambda via event.headers                                 │  │
│  └───────────────────────┬────────────────────────────────────────────────────┘  │
│                           │                                                       │
│                           ▼                                                       │
│  ┌────────────────────────────────────────────────────────────────────────────┐  │
│  │                    PAYMENT LAMBDA / ECS SERVICE                            │  │
│  │                                                                             │  │
│  │  ┌─────────────────────────────────────────────────────────────────────┐  │  │
│  │  │  IDEMPOTENCY CHECK (Step A — BEFORE any processing)                  │  │  │
│  │  │                                                                       │  │  │
│  │  │  const key = event.headers['Idempotency-Key'];                        │  │  │
│  │  │                                                                       │  │  │
│  │  │  const lock = await redis.set(                                        │  │  │
│  │  │    `idem:${key}:lock`, 'processing', 'NX', 'EX', 86400               │  │  │
│  │  │  );                                                                   │  │  │
│  │  │                                                                       │  │  │
│  │  │  if (!lock) {                   ← duplicate!                         │  │  │
│  │  │    const stored = await redis.get(`idem:${key}:response`);            │  │  │
│  │  │    if (stored) return JSON.parse(stored);                              │  │  │
│  │  │    return { status: 409, body: { error: 'processing' } };             │  │  │
│  │  │  }                                                                    │  │  │
│  │  └─────────────────────────────────────────────────────────────────────┘  │  │
│  │                                                                             │  │
│  │  ┌─────────────────────────────────────────────────────────────────────┐  │  │
│  │  │  BUSINESS LOGIC (Step B — only if idempotency check passed)          │  │  │
│  │  │                                                                       │  │  │
│  │  │  1. Validate payment request                                          │  │  │
│  │  │  2. Check card is active and has funds                                │  │  │
│  │  │  3. Call Stripe API (Stripe payment_intent also has idempotency key)  │  │  │
│  │  │  4. INSERT payment record in Aurora (in transaction with idempotency  │  │  │
│  │  │     check to survive DB failover during processing)                   │  │  │
│  │  │  5. Publish PaymentCreated event to EventBridge                       │  │  │
│  │  └─────────────────────────────────────────────────────────────────────┘  │  │
│  │                                                                             │  │
│  │  ┌─────────────────────────────────────────────────────────────────────┐  │  │
│  │  │  STORE RESPONSE (Step C — after successful processing)               │  │  │
│  │  │                                                                       │  │  │
│  │  │  await redis.set(                                                     │  │  │
│  │  │    `idem:${key}:response`,                                            │  │  │
│  │  │    JSON.stringify({ status: 201, body: paymentResponse }),            │  │  │
│  │  │    'EX', 86400     ← same TTL as lock                                 │  │  │
│  │  │  );                                                                    │  │  │
│  │  └─────────────────────────────────────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────────────────────────────────────┘  │
│                           │                                                       │
│           ┌───────────────┼──────────────────┐                                   │
│           ▼               ▼                  ▼                                   │
│  ┌───────────────┐ ┌─────────────┐ ┌───────────────────────────────────────┐   │
│  │  ElastiCache  │ │  Stripe API │ │      Aurora PostgreSQL                 │   │
│  │  Redis        │ │             │ │                                         │   │
│  │               │ │  Also uses  │ │  payments table:                        │   │
│  │  idem:{key}:  │ │  idempotency│ │    idempotency_key UNIQUE               │   │
│  │  lock         │ │  key from   │ │    (DB-level safety net)                │   │
│  │  idem:{key}:  │ │  same UUID  │ │                                         │   │
│  │  response     │ └─────────────┘ │  If Redis fails, DB constraint          │   │
│  └───────────────┘                 │  prevents duplicate payments            │   │
│                                    └───────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────────────┘
```

### Defense-in-Depth Idempotency

```
Layer 1: Redis NX atomic check (fast, O(1))
  → Catches 99.9% of duplicates before touching DB
  → Risk: Redis failure → fall through to Layer 2

Layer 2: DB UNIQUE constraint on idempotency_key column
  → Catches duplicates that slip through if Redis is down
  → INSERT fails with unique violation → return stored response from DB
  → Risk: DB slower; unique constraint catches but requires reading stored response too

Layer 3: Downstream service idempotency (Stripe)
  → Stripe: pass same Idempotency-Key to Stripe API calls
  → Stripe deduplicates on their end
  → Even if OUR idempotency layer is bypassed, Stripe won't double-charge

Layer 4: Audit log + reconciliation
  → Payment audit log: every payment_id + idempotency_key pair recorded
  → Daily reconciliation job: find duplicate payment amounts + cards in 5 min window
  → Alert: "Possible duplicate charges detected for customer X"
  → Gives team visibility for operational support

Defense-in-depth: no single layer failure = data corruption
```

---

## SECTION 6 — Production Scenarios

### Stripe's Idempotency Implementation (Gold Standard)

```
Stripe's API: idempotency is mandatory for POST requests to write endpoints.

Client code (Stripe SDK):
  const charge = await stripe.charges.create({
    amount: 2000,
    currency: 'usd',
    source: 'tok_visa',
  }, {
    idempotencyKey: 'order_123_charge_attempt_1',  ← required
  });

Stripe's behavior:
  First request: processes charge, stores result
  Duplicate (same key): returns exact same charge object (same charge_id, same amount)
  Same key + different body: 422 "Idempotent key reuse with different request body"
  Key TTL: 24 hours
  After 24h: same key treated as new request

Stripe's key naming recommendation:
  Use order_id or user intent identifier, not random UUID:
  `order-${orderId}-payment-${attemptNumber}`

  Why: debugging. "Why was customer charged twice?" → Find key `order-123-payment-1`
  Can lookup exact timeline in Stripe dashboard.

  Random UUID: harder to trace (need to store UUID → orderId mapping)
  Meaningful key: directly queryable in Stripe dashboard

Response headers Stripe adds:
  Idempotent-Replayed: true   ← when response is from cache, not fresh processing
  Original-Request: req_3Mq8K2  ← ID of the original request

  Use case: client SDK can detect "this is a replay" vs "this was freshly processed"
  → Different logging behavior in client
```

### AWS SDK Retry Behavior and Idempotency

```
AWS SDK automatically retries on:
  - Transient errors: RequestThrottled, PriorRequestNotComplete, TransientError
  - Network errors: connection timeout, read timeout
  - 5xx errors: InternalError, ServiceUnavailable

Default retry config (AWS SDK v3):
  maxAttempts: 3
  retryStrategy: adaptive  ← SDK slows down as throttling increases

PROBLEM WITHOUT IDEMPOTENCY:
  CreatePaymentIntent → Lambda → Aurora INSERT
  Lambda: 29s timeout → client retries 2 more times
  If Lambda was slow (cold start) but DID process:
    3 payment intents created for 1 customer action

SDK-level idempotency (client_request_token):
  Some AWS services have built-in idempotency:
    DynamoDB: TransactWriteItems → ClientRequestToken
    SFN CreateExecution → name parameter is idempotency key
    SQS SendMessage → MessageDeduplicationId (for FIFO queues)

  For YOUR Lambda APIs: you must implement yourself.

CONFIG: disable automatic retries for non-idempotent operations:
  const client = new LambdaClient({
    maxAttempts: 1,   ← NO automatic retry for payment initiation
  });
  // Handle retries manually with idempotency key at application layer

  Safe to retry automatically (idempotent): GET, HEAD, DELETE
  NOT safe to auto-retry: POST, PATCH (unless you have idempotency key)
```

### PayPal's Double-Charge Incident and Fix

```
Historical context: PayPal's idempotency evolution (public post-mortem knowledge)

Pre-2015:
  PayPal processed duplicate payments during network partition events.
  Each API retry created a new charge.
  Manual reconciliation team processed thousands of duplicate charge reports per week.
  Fix: Manual customer support. Cost: $300K/year in support operations.

Post-2015 (PayPal Correlation-Id):
  All PayPal write APIs require:
    Header: PayPal-Request-Id: <uuid>

  PayPal stores all request IDs with TTL 30 days (financial compliance window).
  Duplicate: returns 200 with original response (headers + body identical to first).

  Their public guideline: "Store the PayPal-Request-Id in your database BEFORE sending
  the request, not after. This way, if your server crashes after sending but before
  storing, you have a record and can check PayPal's response for that request ID."

  Pre-store pattern:
    1. INSERT pending_payment (request_id, status='pending') into your DB
    2. Call PayPal API with that request_id
    3. PayPal processes → you update status to 'complete' or 'failed'
    4. If crash: on restart, find pending_payment records → check PayPal's status API

  This is the "pre-registration" idempotency pattern — safer than post-store.

Lesson: Register the intent BEFORE making the external call. If you crash between call
and storage, you can reconcile the intent rather than discovering a charge with no record.
```

---

## SECTION 7 — Scaling & Reliability

### 1. Redis Cluster Design for Idempotency Keys

```
SCALE: FleetPay processes 10M payments/day.
At peak: 500 payments/second.
Each payment: 2 Redis operations (NX set on arrival, SET on completion).
  Total: 1,000 Redis ops/second at peak.

Redis throughput: ~100K ops/second per node (well within capacity).

Storage calculation:
  Key name: "idem:{uuid}:lock" + "idem:{uuid}:response"
  UUID: 36 chars
  Key name: ~50 bytes
  Value: response JSON ~1KB
  Per payment: ~1.1KB

  10M payments × 1.1KB = 11 GB of idempotency data per day.
  With 24-hour TTL: max 11 GB retained at any time.

  Redis cluster: 3 nodes × 8 GB = 24 GB capacity → comfortable margin

  Replication: 3 shard × 1 replica = 6 total nodes
  Failover: replica promoted in <30s if primary fails

  CRITICAL: Redis AOF (Append Only File) persistence enabled.
  Why: If Redis node restarts and loses all idempotency keys →
       all in-flight retries become new requests → duplicate processing risk.

  Config: appendonly yes  + appendfsync everysec (performance vs durability tradeoff)

ALTERNATIVE: DynamoDB for idempotency keys (AWS-native, no maintenance)
  Table: IdempotencyKeys
  PK: idempotency_key
  TTL attribute: expires_at (Unix timestamp)
  DynamoDB auto-deletes items when TTL expires.

  PutItem with ConditionExpression: "attribute_not_exists(pk)"
  → Atomic: if key exists, condition fails (no write) → return existing item

  Latency: DynamoDB single-digit milliseconds vs Redis sub-millisecond
  For payments: DynamoDB is fast enough (10ms extra per payment acceptable)
  For ultra-low-latency: Redis preferred
```

### 2. What Happens When the Idempotency Store Fails?

```
SCENARIO: Redis ElastiCache cluster is unavailable (maintenance, network partition)

Options:
  A. FAIL OPEN: Process without idempotency check (risk of duplicates)
  B. FAIL CLOSED: Return 503 (no payment possible, but no duplicate risk)
  C. FALL THROUGH TO DB: Use DB unique constraint as fallback

RECOMMENDATION FOR PAYMENTS: Option B (fail closed) + Option C as backup

Implementation:
  try {
    const lock = await redis.set(`idem:${key}:lock`, 'processing', 'NX', 'EX', 86400);
    // ... normal flow
  } catch (redisError) {
    // Redis unavailable — fall through to DB check
    logger.warn('Redis idempotency unavailable, falling through to DB', { key, redisError });

    try {
      // Attempt DB-level idempotency insert
      await db.query(
        'INSERT INTO idempotency_keys (key, created_at) VALUES ($1, NOW())',
        [idempotencyKey]
      );
      // Unique constraint: if this succeeds, we're the first
    } catch (dbError) {
      if (dbError.code === '23505') {  // Unique violation in Postgres
        const stored = await db.query(
          'SELECT response FROM idempotency_keys WHERE key = $1', [idempotencyKey]
        );
        if (stored.rows[0]?.response) {
          return JSON.parse(stored.rows[0].response);
        }
        return { status: 409, body: { error: 'processing_in_flight' } };
      }
      throw dbError;
    }

    // ... process and store response in DB
  }

Alert: Redis unavailable → page on-call immediately.
       DB fallback adds latency but maintains correctness.
       SLA: "zero duplicate payments, even during Redis maintenance."
```

### 3. Monitoring Idempotency Effectiveness

```
METRICS TO TRACK:

1. idempotency.cache_hit_rate
   = duplicates_served_from_cache / total_duplicate_attempts
   Alert: if < 99% → something wrong with key storage

2. idempotency.key_reuse_body_mismatch
   = requests where same key + different body
   Alert: if > 0 → client bug (generating same key for different requests)

3. idempotency.retry_rate
   = requests with seen idempotency keys / total POST requests
   Baseline: 2-3% (normal retry rate due to transient failures)
   Alert: if > 10% → systemic failure causing high retry rate → investigate

4. idempotency.concurrent_duplicate
   = 409 responses for "in-flight" duplicates
   Expected: very low (<0.1%)
   Alert: if spikes → client is sending concurrent duplicates (race condition on client)

5. duplicate_payment_caught
   = payments prevented because idempotency key matched an existing charge
   BUSINESS KPI: should go UP as clients adopt idempotency keys
   Monitor: clients NOT sending idempotency keys (reject with 400, alert team)
```

---

## SECTION 8 — AWS Mapping

### DynamoDB Idempotency (Powertools for Lambda)

```python
# AWS Lambda Powertools makes idempotency trivial

from aws_lambda_powertools.utilities.idempotency import (
    idempotent, IdempotencyConfig
)
from aws_lambda_powertools.utilities.idempotency.persistence.dynamodb import (
    DynamoDBPersistenceLayer
)

# Configure DynamoDB persistence
persistence_layer = DynamoDBPersistenceLayer(
    table_name="PaymentIdempotency",
    key_attr="pk",               # partition key attribute name
    expiry_attr="expiry",        # TTL attribute (DynamoDB auto-deletes)
    status_attr="status",        # processing status
    data_attr="data",            # stored response
    validation_key_jmespath="powertools_json(body).amount"  # validate body hash
)

config = IdempotencyConfig(
    event_key_jmespath='headers."Idempotency-Key"',  # extract key from header
    expires_after_seconds=86400,          # 24 hours
    raise_on_no_idempotency_key=True,     # 400 if header missing
)

@idempotent(config=config, persistence_store=persistence_layer)
def handler(event, context):
    # This entire function is idempotent
    # Powertools handles: key check, lock, response storage, replay

    payment_data = json.loads(event['body'])
    payment = process_payment(payment_data)

    return {
        'statusCode': 201,
        'body': json.dumps({
            'payment_id': payment.id,
            'status': payment.status
        })
    }

# DynamoDB Table CloudFormation:
# Type: AWS::DynamoDB::Table
# Properties:
#   TableName: PaymentIdempotency
#   BillingMode: PAY_PER_REQUEST
#   AttributeDefinitions: [{AttributeName: pk, AttributeType: S}]
#   KeySchema: [{AttributeName: pk, KeyType: HASH}]
#   TimeToLiveSpecification:
#     AttributeName: expiry
#     Enabled: true   ← auto-clean expired keys
```

### SQS FIFO: Built-in Message Deduplication

```
SQS FIFO queues have built-in idempotency for message delivery.

Standard SQS: at-least-once delivery → consumer must handle duplicates
SQS FIFO: deduplication window (5 minutes) + MessageDeduplicationId

Producer (API Gateway → SQS):
  aws sqs send-message \
    --queue-url https://sqs.us-east-1.amazonaws.com/123/PaymentEvents.fifo \
    --message-body '{"event": "payment_created", "payment_id": "PAY-123"}' \
    --message-group-id "payment-PAY-123" \
    --message-deduplication-id "payment-PAY-123-v1"  ← idempotency key for SQS

SQS behavior:
  Same MessageDeduplicationId within 5-minute window → second message DROPPED (not processed)
  Consumer receives each message EXACTLY ONCE per 5-minute window.

USE CASE: When the payment API receives a duplicate POST request:
  Option A: Check idempotency in Lambda BEFORE enqueuing → don't even enqueue the duplicate
  Option B: Enqueue with MessageDeduplicationId → SQS deduplicates → consumer sees once

  Option A: better for atomic check (no duplicate even reaches SQS)
  Option B: useful if Lambda crashed after enqueuing but before responding
             Re-send same MessageDeduplicationId → SQS won't enqueue again
             Provides end-to-end idempotency even across service failures

CAUTION: SQS FIFO deduplication window is only 5 MINUTES.
If client retries after 5 minutes, the message IS redelivered.
SQS FIFO deduplication ≠ 24-hour idempotency guarantee.
Combine with application-level idempotency for longer windows.
```

### API Gateway Request Validation for Idempotency

```yaml
# OpenAPI spec for API Gateway — enforce idempotency key
/payments:
  post:
    parameters:
      - name: Idempotency-Key
        in: header
        required: true
        schema:
          type: string
          format: uuid
          description: "UUID v4 idempotency key. Generate once per payment intent, reuse on retries."
    x-amazon-apigateway-request-validator: all

# API Gateway validates: if Idempotency-Key missing → 400 Bad Request (before Lambda invocation)
# API Gateway validates: format uuid → if not valid UUID → 400
# Lambda never called with invalid/missing idempotency key

# x-amazon-apigateway-request-validator: "all" = validate both headers and body

# CloudFormation:
# RequestValidators:
#   IdempotencyValidator:
#     ValidateRequestBody: true
#     ValidateRequestParameters: true
# MethodSettings:
#   RequestValidatorId: !Ref IdempotencyValidator
```

### Lambda Powertools Idempotency with Redis (Custom Persistence)

```python
# For lower latency than DynamoDB: custom Redis persistence layer

import redis
import json
import hashlib
from aws_lambda_powertools.utilities.idempotency.persistence.base import (
    BasePersistenceLayer, DataRecord
)

class RedisPersistenceLayer(BasePersistenceLayer):
    def __init__(self, host, port=6379, ttl=86400):
        self.client = redis.Redis(host=host, port=port)
        self.ttl = ttl

    def _get_record(self, idempotency_key: str) -> DataRecord:
        item = self.client.get(f"idem:{idempotency_key}:data")
        if not item:
            raise ItemNotFound()
        return DataRecord(**json.loads(item))

    def _put_record(self, data_record: DataRecord):
        key = f"idem:{data_record.idempotency_key}:data"
        self.client.set(key, json.dumps(data_record.__dict__), ex=self.ttl, nx=True)

    def _update_record(self, data_record: DataRecord):
        key = f"idem:{data_record.idempotency_key}:data"
        self.client.set(key, json.dumps(data_record.__dict__), ex=self.ttl)

    def _delete_record(self, data_record: DataRecord):
        self.client.delete(f"idem:{data_record.idempotency_key}:data")

# Usage: same @idempotent decorator with Redis persistence
persistence_layer = RedisPersistenceLayer(
    host=os.environ['REDIS_ENDPOINT'],
    ttl=86400
)
```
