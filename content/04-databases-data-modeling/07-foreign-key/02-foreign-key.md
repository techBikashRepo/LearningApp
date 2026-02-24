# Foreign Key — Part 2 of 3

### Sections: 5 (Bad vs Correct), 6 (Performance Impact), 7 (Concurrency), 8 (Optimization & Indexing)

**Series:** Databases & Data Modeling → Topic 07

---

## SECTION 5 — Bad Usage vs Correct Usage

### Pattern 1: Disabling FK Constraints "For Performance"

```sql
-- ❌ THE MOST COMMON AND MOST DANGEROUS ANTI-PATTERN:
ALTER TABLE orders DISABLE TRIGGER ALL;  -- MySQL: SET FOREIGN_KEY_CHECKS = 0;
-- "We disabled FKs because they were slowing down bulk inserts."

-- THE TRUE COST:
-- 1. Data integrity: any INSERT can now silently store orphaned references.
-- 2. Application bugs: code assumes FK prevents bad data → assumption now wrong.
-- 3. Audit failures: compliance requires referential integrity.
-- 4. Silent accumulation: orphaned rows build up over months undetected.
-- 5. When you re-enable: millions of orphaned rows found → FK re-enable FAILS.

-- ✅ CORRECT: Use DEFERRABLE FK during bulk loads, then re-enable.
-- For Postgres bulk load:
BEGIN;
SET CONSTRAINTS ALL DEFERRED;  -- defer FK checks to end of transaction
COPY orders FROM '/tmp/bulk_orders.csv' CSV;
COPY order_items FROM '/tmp/bulk_items.csv' CSV;
-- FK check happens at COMMIT. If any orphaned FK found: entire COPY rolls back.
COMMIT;
-- Result: either all data in OR all rolled back. No partial orphaned state. No disabling.

-- For MySQL bulk load:
SET FOREIGN_KEY_CHECKS = 0;
LOAD DATA INFILE '/tmp/orders.csv' INTO TABLE orders;
LOAD DATA INFILE '/tmp/items.csv' INTO TABLE order_items;
SET FOREIGN_KEY_CHECKS = 1;
-- Re-enable IMMEDIATELY after load. Not globally, in the same session.
-- Verify: SELECT COUNT(*) FROM order_items oi LEFT JOIN orders o ON o.id = oi.order_id WHERE o.id IS NULL;
-- If > 0: data integrity issue. Investigate before proceeding.
```

### Pattern 2: ON DELETE CASCADE on Business-Critical Data

```sql
-- ❌ BAD: CASCADE on relationships where child data has independent value
CREATE TABLE customers (id SERIAL PRIMARY KEY);
CREATE TABLE invoices (
  id         SERIAL PRIMARY KEY,
  customer_id INT REFERENCES customers(id) ON DELETE CASCADE  -- DANGEROUS
);

-- A customer requests GDPR deletion.
-- Staff deletes customer: DELETE FROM customers WHERE id = 42;
-- CASCADE triggers immediately: all invoices for customer 42 deleted.
-- Tax records: gone. Audit trail: gone. Accounts receivable: corrupted.
-- Invoice total that should appear in quarterly filing: missing.
-- GDPR requires deleting PII, not entire business records.

-- ✅ CORRECT: Model deletions explicitly. Multiple options:
-- Option A: Soft delete on customers (set deleted_at, anonymize PII)
ALTER TABLE customers ADD COLUMN deleted_at TIMESTAMPTZ;
ALTER TABLE customers ADD COLUMN anonymized BOOL DEFAULT FALSE;
-- GDPR: UPDATE customers SET name=NULL, email='anonymized', anonymized=TRUE WHERE id=42;
-- Invoices: intact. Invoice references customer_id=42. Lookup returns anonymized customer.

-- Option B: ON DELETE SET NULL (invoices preserved, customer reference nullified)
CREATE TABLE invoices (
  id         SERIAL PRIMARY KEY,
  customer_id INT REFERENCES customers(id) ON DELETE SET NULL
);
-- Invoice preserved. customer_id = NULL. Invoice still queryable; customer reference lost.

-- Option C: ON DELETE RESTRICT (force application to handle deletion explicitly)
-- Safest: deletion fails until application explicitly handles all child records.
```

### Pattern 3: FK Without Index on Child Column

```sql
-- ❌ MISSING: No index on FK column of large child table
CREATE TABLE events (
  id         BIGSERIAL PRIMARY KEY,
  session_id INT NOT NULL REFERENCES sessions(id),  -- FK, no index
  event_type TEXT,
  created_at TIMESTAMPTZ
);
-- events: 500M rows.

-- EVERY TIME a session is deleted or updated:
-- DB checks: are there events with session_id = $deleted_session_id?
-- Without index: SeqScan on events (500M rows). Seconds. Holds locks. Blocks.

-- EVERY TIME a session expires batch job runs: DELETE FROM sessions WHERE expires_at < NOW();
-- Deletes 100,000 sessions. For each: full scan of 500M event rows.
-- 100,000 × SeqScan = essentially permanent table lock on events.

-- ✅ FIX: Always index FK columns on child tables.
CREATE INDEX idx_events_session_id ON events(session_id);
-- FK check: O(log N) index lookup instead of O(N) sequential scan.
-- Deletion of 100,000 sessions: 100,000 × 0.3ms = 30 seconds. Acceptable. No table locks.

-- FINDING ALL UNINDEXED FK COLUMNS (Postgres):
SELECT tc.table_name, kcu.column_name
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
WHERE tc.constraint_type = 'FOREIGN KEY'
AND NOT EXISTS (
  SELECT 1 FROM pg_indexes
  WHERE tablename = tc.table_name
  AND indexdef ILIKE '%' || kcu.column_name || '%'
);
```

---

## SECTION 6 — Performance Impact

### FK Check Overhead Per Insert

```
BENCHMARK: INSERT into order_items (order_id FK → orders, product_id FK → products)

Without FK constraints:
  INSERT time: 0.15ms (heap write + index update only)

With FK constraints (both FK columns have parent tables with PK index):
  INSERT time: 0.47ms
  Breakdown:
    Heap write + PK index update:           0.15ms
    FK check order_id → orders PK:          0.16ms (index lookup + ShareLock acquisition)
    FK check product_id → products PK:      0.16ms (same)

  OVERHEAD: 0.32ms per INSERT = 213% of baseline.
  At 1,000 inserts/second: 320ms/second additional wait. Negligible (0.032% CPU).
  At 100,000 inserts/second: 32 seconds/second → bottleneck! But only if parent rows
    are NOT in buffer cache (cold cache scenario).
  With hot parent tables in cache: overhead drops to ~0.05ms per FK. Acceptable at any OLTP rate.

CONCLUSION:
  FK overhead is negligible for OLTP rates with warm cache.
  Bulk loads (millions of inserts): use DEFERRABLE constraints or disable temporarily with verification.
  "FK is too slow" is almost always: cold cache, missing index on FK column, or bulk load scenario.
  None of these justify DISABLING FK permanently.
```

### ON DELETE CASCADE Performance at Scale

```
DELETE FROM users WHERE id = 42 (CASCADE to orders → order_items → shipments):

Cascade chain:
  users: 1 row deleted              → 0.1ms
  orders: CASCADE: 150 orders       → requires index on orders.user_id
    order_items: CASCADE on each order → requires index on order_items.order_id
      shipments: CASCADE: 1 shipment/order → requires index on shipments.order_id

WITH ALL FK INDEXES:
  orders: INDEX lookup of user_id=42 → 150 rows. Index deletes.       ~2ms
  order_items: INDEX lookup of order_id IN (150 IDs) → 750 rows.      ~5ms
  shipments: INDEX lookup → 150 rows.                                  ~2ms
  Total: ~9ms + WAL writes.

WITHOUT INDEXES:
  orders: SeqScan 50M rows to find user_id=42.                         ~30s
  order_items: SeqScan 500M rows for each order_id.                    ~minutes
  This is catastrophic. Not theoretical — happens in production.

DEEP CASCADE RISK:
  CASCADE depth > 3: performance degrades multiplicatively.
  Cascades within transactions: all cascaded deletes must commit atomically.
  Long cascade: large transaction → long-held row locks → lock contention.
  SAFEGUARD: Count rows before deleting. If > 10,000 cascade rows: batch delete manually.
```

---

## SECTION 7 — Concurrency

### Deadlock Patterns with Foreign Keys

```
CLASSIC FK DEADLOCK:

Thread 1 (order placement):
  BEGIN;
  INSERT INTO orders (customer_id=5, ..) → acquires RowExclusiveLock on orders.
  FK check: SELECT ... FROM customers WHERE id=5 FOR SHARE → acquires ShareLock on customers row 5.

Thread 2 (customer update):
  BEGIN;
  UPDATE customers SET tier='premium' WHERE id=5 → acquires RowExclusiveLock on customers row 5.
  WAITS: Thread 1 holds ShareLock on row 5. Update blocked.

  Thread 2 then tries: INSERT INTO customer_audit (customer_id=5)
  FK check: SELECT FROM customers WHERE id=5 FOR SHARE → TRY to acquire ShareLock.
  DEADLOCK: Thread 2 holds RowExclusiveLock on customers row 5 (update).
            Thread 1 holds ShareLock on customers row 5 (FK check).
            Thread 1 needs nothing from Thread 2.
            Thread 2 needs nothing from Thread 1 directly, but their row-lock requests conflict.

            Depending on timing: Thread 2's UPDATE blocked by Thread 1's ShareLock →
            Thread 2 also needs ShareLock for audit FK check → cannot acquire while holding XLock.
            → Postgres detects deadlock: aborts one transaction.

SOLUTION: Consistent lock ordering. Always lock parent before child.
  Or: Use SELECT ... FOR NO KEY UPDATE instead of FOR UPDATE where possible (PostgreSQL).
  FOR NO KEY UPDATE: doesn't conflict with FK ShareLock. Designed for this pattern.
  UPDATE customers SET tier='premium' WHERE id=5;  → uses NO KEY UPDATE internally (Postgres)
```

---

## SECTION 8 — Optimization & Indexing

### Composite FK Index Strategy

```sql
-- TABLE: order_items (order_id, product_id, qty, price)
-- FKs: order_id → orders, product_id → products
-- Common queries:
--   "All items in order X": WHERE order_id = $1
--   "All orders containing product Y": WHERE product_id = $1
--   "Item for specific order+product": WHERE order_id = $1 AND product_id = $2

-- INDEX STRATEGY:
-- 1. PK or UNIQUE ensures uniqueness (choose based on use case):
--    Option A: PRIMARY KEY (order_id, product_id) — covers both FK check directions? No.
--    PK on (order_id, product_id) covers: order → items direction (prefix scan).
--    product_id direction: NOT covered by this composite index.

-- 2. Always add reverse direction index:
CREATE INDEX idx_order_items_order   ON order_items(order_id, product_id);  -- from PK
CREATE INDEX idx_order_items_product ON order_items(product_id, order_id);  -- reverse direction

-- 3. FK check by DB engine:
--    DELETE FROM orders WHERE id = $1: uses idx_order_items_order. Fast.
--    DELETE FROM products WHERE id = $1: uses idx_order_items_product. Fast.

-- 4. COVERING INDEX for hot read paths:
CREATE INDEX idx_order_items_covering ON order_items(order_id) INCLUDE (product_id, qty, price);
-- "All items in order X" → Index Only Scan. Zero heap reads.
-- EXPLAIN: Index Only Scan using idx_order_items_covering. Heap Fetches: 0.
```
