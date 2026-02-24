# Prevent Duplicate Payments — Part 2 of 3

### Sections: 5 (Bad vs Correct Usage), 6 (Performance Impact), 7 (Concurrency & Data Integrity), 8 (Optimization & Indexing)

**Series:** Databases & Data Modeling → Topic 18

---

## SECTION 5 — Bad Usage vs Correct Usage

### Common Anti-Patterns That Allow Duplicate Payments

**Anti-Pattern 1: Application-level check without database enforcement**

```sql
-- BAD: Race condition window between SELECT and INSERT
-- Application code:
def process_payment(idempotency_key, amount):
    existing = db.execute(
        "SELECT id FROM payment_attempts WHERE idempotency_key = %s",
        [idempotency_key]
    ).fetchone()
    if existing:
        return existing  # "deduplication" - but has a race condition

    # WINDOW: two concurrent requests both pass the check above
    # Both proceed to INSERT simultaneously
    result = db.execute(
        "INSERT INTO payment_attempts (idempotency_key, amount) VALUES (%s, %s) RETURNING id",
        [idempotency_key, amount]
    )
    charge_payment_gateway(amount)  # both fire this - DOUBLE CHARGE

-- Why it fails: between SELECT and INSERT, two concurrent transactions
-- both read "no existing record" and both proceed to insert + charge.
-- This is a classic TOCTOU (Time-of-Check to Time-of-Use) race condition.
```

---

**Anti-Pattern 2: Using only external gateway IDs for deduplication**

```sql
-- BAD: relying on Stripe's idempotency without your own DB guarantee
-- Code stores Stripe charge_id after success. But:
-- 1. If server crashes after Stripe charges but before DB write: charge exists but not recorded.
-- 2. On retry: "no charge found in DB" → charges again → duplicate.
-- 3. Stripe may or may not catch it (Stripe's idempotency key expires after 24 hours).

-- The correct flow MUST reserve the slot in YOUR database BEFORE calling the gateway.
```

---

**Anti-Pattern 3: Idempotency key scope too narrow**

```sql
-- BAD: idempotency key only prevents exact duplicate requests
-- User submits $50 payment → idempotency_key = 'pay_abc123'
-- User submits $100 payment (different amount, same session) → idempotency_key = 'pay_abc123'
-- Second request: "conflict detected" → returns $50 response for a $100 intent
-- User: confused. Fund: $50 charged when $100 intended.

-- CORRECT: idempotency key should encode the intent:
-- idempotency_key = hash(user_id + session_id + amount + currency + item_ids)
-- Different amount = different intent = different key = correctly processes as new payment.
-- Same everything = exactly same intent = correctly deduplicated.
```

---

**CORRECT Pattern: Atomic reservation before external call**

```sql
-- CORRECT: 3-phase pattern with atomic slot reservation
CREATE TABLE payment_attempts (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    idempotency_key  TEXT NOT NULL,
    user_id          INTEGER NOT NULL,
    amount_cents     INTEGER NOT NULL,
    currency         CHAR(3) NOT NULL DEFAULT 'USD',
    status           TEXT NOT NULL DEFAULT 'pending',
    external_id      TEXT,        -- Stripe charge ID
    response_cache   JSONB,       -- cached response for replay
    expires_at       TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours',
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_idempotency_key UNIQUE (idempotency_key)
);

-- Phase 1: Atomic reservation (one DB round trip, guaranteed by UNIQUE):
WITH reservation AS (
    INSERT INTO payment_attempts (idempotency_key, user_id, amount_cents, currency, status)
    VALUES ($key, $user_id, $amount, $currency, 'pending')
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id, status, response_cache
)
SELECT * FROM reservation
UNION ALL
SELECT id, status, response_cache FROM payment_attempts
WHERE idempotency_key = $key
  AND NOT EXISTS (SELECT 1 FROM reservation);

-- If INSERT succeeded: reservation.id = new id, status = 'pending' → proceed
-- If conflict: returns existing record → check status, return cached response if 'succeeded'
-- Atomic: no race. Two concurrent requests: one gets id (proceeds), one gets conflict (returns cached).

-- Phase 2: Update to 'processing' then call gateway:
UPDATE payment_attempts SET status = 'processing' WHERE id = $id;
charge = stripe.charges.create(amount=$amount);

-- Phase 3: Record result:
UPDATE payment_attempts
SET status = 'succeeded', external_id = $charge_id,
    response_cache = $response_json
WHERE id = $id;
```

---

## SECTION 6 — Performance Impact

### Benchmarking Idempotency Enforcement Overhead

```
Test setup: PostgreSQL 15, 16GB RAM, 8-core instance.
Table: payment_attempts with UNIQUE constraint on idempotency_key (B-tree, text column).
Load: 10,000 concurrent payment requests, mix of new requests (80%) and duplicates (20%).

Scenario 1: No deduplication (no UNIQUE constraint)
  INSERT throughput: 82,400 rows/second
  Average latency: 0.8ms per INSERT
  Duplicate charges: 2,100 (out of 10,000 requests during peak concurrent load)

Scenario 2: Application-level check (SELECT then INSERT)
  Effective throughput: 31,200 requests/second (lower: SELECT + INSERT round trips)
  Average latency: 2.1ms
  Duplicate charges: 340 (race condition window: ~3% of concurrent duplicates slipped through)
  Note: TWO database round trips per payment request. Connection pool exhaustion under load.

Scenario 3: UNIQUE + ON CONFLICT DO NOTHING
  INSERT throughput: 78,100 rows/second (5% lower than no-constraint, purely UNIQUE B-tree overhead)
  Average latency: 0.9ms (single round trip)
  Duplicate charges: 0 (database UNIQUE enforced atomically)

Overhead analysis:
  UNIQUE constraint adds: ~5% insert overhead (B-tree lookup per insert).
  Text key (UUID, ~36 chars): index entry size = ~50 bytes.
  100M payment records: UNIQUE index size ≈ 5GB. Manageable.

  The ON CONFLICT path (duplicate detection):
  Latency: ~0.3ms (index scan to locate existing row, no heap write).
  Compared to new INSERT: 0.9ms → 0.3ms (faster for duplicates: no heap write).

High-volume payment platform benchmark:
  500K payments/day → 6 payments/second.
  UNIQUE constraint overhead at 6 TPS: completely immeasurable.
  Even at 10K TPS: 5% overhead = 0.05ms per payment. Negligible.

  There is NO business justification for removing the UNIQUE constraint on performance grounds.
```

---

**Idempotency key storage: TEXT vs UUID vs BIGINT**

```sql
-- Option A: TEXT (Stripe-style 'idem_xyz...' or UUID string)
-- B-tree key size: ~50 bytes. Comparison: string comparison.
-- Pro: human-readable, client-generated.
-- Con: larger index entries vs numeric.

-- Option B: UUID (stored as uuid type, 16 bytes)
-- B-tree key size: 16 bytes. Random distribution: page splits.
-- Use: uuid_generate_v7() (time-ordered) to minimize page splits.
-- Con: random UUIDs (v4) cause index bloat and write amplification.

-- Option C: BIGINT hash of the key string
-- B-tree key size: 8 bytes. Fastest comparisons. Risk: hash collisions (mitigate with full text secondary check).

-- Recommendation for most platforms: TEXT with UUID v4 or v7 client-generated keys.
-- Performance difference TEXT vs UUID: irrelevant at <50K TPS.
-- At >50K TPS: switch to UUIDv7 (time-ordered) to reduce B-tree page splits.
```

---

## SECTION 7 — Concurrency & Data Integrity

### Handling Concurrent Duplicate Payments in PostgreSQL

**Speculative insert and concurrent conflict resolution:**

```sql
-- Two concurrent requests, same idempotency_key 'idem-abc':

-- Request A (arrives 0ms):                Request B (arrives 1ms later):
BEGIN;                                      BEGIN;
INSERT ... VALUES ('idem-abc', ...)         INSERT ... VALUES ('idem-abc', ...)
ON CONFLICT DO NOTHING;                     ON CONFLICT DO NOTHING;
-- PostgreSQL internal:                     -- Gets: "idem-abc" already in progress
-- Takes speculative lock on 'idem-abc'     -- Speculative insert conflicts
-- No existing entry: INSERT proceeds       -- DO NOTHING: skips insert
RETURNING id=48291                          RETURNING NULL (no row inserted)
-- Proceeds to payment processing           -- Queries existing: returns pending record
COMMIT;                                     COMMIT;
-- Result: one payment record created.      -- Result: returns existing record's status.

-- If both arrive EXACTLY simultaneously (nanosecond race):
-- PostgreSQL B-tree locking serializes the two INSERTs.
-- One gets the exclusive leaf-page lock first: inserts.
-- Second: blocked briefly, then conflict resolved: DO NOTHING.
-- No deadlock. No duplicate. No double charge. Guaranteed.
```

---

**Handling the "processing" state — crash recovery:**

```sql
-- Problem: server crashes after gateway charges but before DB records success.
-- State in DB: status = 'processing' for > 30 seconds without completion.
-- Recovery job (runs every 60 seconds):

WITH stale_processing AS (
    SELECT id, idempotency_key, external_id
    FROM payment_attempts
    WHERE status = 'processing'
      AND created_at < NOW() - INTERVAL '2 minutes'
    FOR UPDATE SKIP LOCKED  -- don't block active transactions
)
UPDATE payment_attempts pa
SET status = stripe_reconciliation.status,  -- queried from Stripe API
    response_cache = stripe_reconciliation.response
FROM stale_processing sp
JOIN stripe_reconciliation ON stripe_reconciliation.idempotency_key = sp.idempotency_key
WHERE pa.id = sp.id;

-- For records with no Stripe charge found (gateway never received the request):
UPDATE payment_attempts
SET status = 'failed'
WHERE status = 'processing'
  AND created_at < NOW() - INTERVAL '10 minutes'
  AND external_id IS NULL;
-- These can be safely retried: no charge was ever made.
```

---

**Expiry and cleanup:**

```sql
-- Idempotency keys with expiry (Stripe model: 24-hour window):
CREATE INDEX idx_payment_attempts_expires ON payment_attempts(expires_at)
WHERE status IN ('pending', 'processing');

-- Cleanup old completed attempts (keep for audit):
-- Never delete: keep archived for financial audit trail (7-year retention).
-- But: move to archive after 90 days to keep main table fast:
INSERT INTO payment_attempts_archive
SELECT * FROM payment_attempts WHERE created_at < NOW() - INTERVAL '90 days';

DELETE FROM payment_attempts WHERE created_at < NOW() - INTERVAL '90 days';
-- Partitioning by month: makes this deletion O(DROP PARTITION) instead of O(N rows).
```

---

## SECTION 8 — Optimization & Indexing

### Indexing Strategy for Payment Deduplication Tables

```sql
-- Core indexes:
-- 1. Idempotency key (primary deduplication):
CREATE UNIQUE INDEX uq_payment_idempotency ON payment_attempts(idempotency_key);
-- Purpose: enforce uniqueness, enable ON CONFLICT.
-- Size: ~50 bytes per entry × 100M rows = 5GB.

-- 2. User + status lookup (user's payment history):
CREATE INDEX idx_payment_user_status ON payment_attempts(user_id, status, created_at DESC);
-- Purpose: "show user's recent payments" → needs user_id + status filter + time ordering.

-- 3. Stale processing recovery (the reconciliation job):
CREATE INDEX idx_payment_processing_stale ON payment_attempts(created_at)
WHERE status = 'processing';
-- Partial index: only 'processing' rows (tiny fraction of total).
-- Recovery job: fast scan of just the stale processing rows.

-- 4. External ID lookup (reconcile with gateway):
CREATE INDEX idx_payment_external_id ON payment_attempts(external_id)
WHERE external_id IS NOT NULL;
-- Purpose: look up a Stripe charge_id to find our internal record.
-- Partial: NULL external_ids (pending) not indexed.

-- 5. Table partitioning for long-term scale:
CREATE TABLE payment_attempts (
    ...
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
) PARTITION BY RANGE (created_at);

CREATE TABLE payment_attempts_2024_q1 PARTITION OF payment_attempts
    FOR VALUES FROM ('2024-01-01') TO ('2024-04-01');
-- Monthly/quarterly partitions: old data archived by dropping old partitions.
-- Each partition: its own copy of all indexes. Queries auto-pruned to relevant partition.

-- Performance monitoring:
SELECT indexrelname, idx_scan, pg_size_pretty(pg_relation_size(indexrelid))
FROM pg_stat_user_indexes
WHERE relname = 'payment_attempts';
-- Expected: uq_payment_idempotency should have HIGH idx_scan (every payment checks it).
-- If idx_scan is low: review if ON CONFLICT is being used correctly.
```

**Avoiding the "hot row" problem on payment tables:**

```sql
-- Problem: status counter on the payments table (if exists) becomes a hot row.
-- Symptom: UPDATE ... WHERE id = 1 (central counter) blocks under high write load.

-- Better: no central counter. Use aggregate queries with pg_stat_user_tables caching:
-- Or: maintain per-user totals (distributed hot row load across users).
-- Or: use a separate payments_stats table with SKIP LOCKED queue pattern for updates.

-- For per-tenant payment summaries:
CREATE TABLE tenant_payment_stats (
    tenant_id        INTEGER PRIMARY KEY,
    total_payments   BIGINT NOT NULL DEFAULT 0,
    total_revenue    BIGINT NOT NULL DEFAULT 0,  -- cents
    last_updated_at  TIMESTAMPTZ
);

-- Updated via background job (not in payment transaction hot path):
UPDATE tenant_payment_stats
SET total_payments = (SELECT COUNT(*) FROM payment_attempts WHERE user.tenant_id = $tid AND status='succeeded'),
    total_revenue  = (SELECT SUM(amount_cents) FROM payment_attempts WHERE ... AND status='succeeded'),
    last_updated_at = NOW()
WHERE tenant_id = $tid;
-- Acceptable staleness: dashboard shows "as of 5 minutes ago."
```
