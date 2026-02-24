# Database Basics: Tables & Schema — Part 2 of 3

### Sections: 5 (Bad vs Correct Schema), 6 (Performance Impact), 7 (Concurrency & Corruption), 8 (Optimization & Indexing)

**Series:** Databases & Data Modeling → Topic 01

---

## SECTION 5 — Bad Schema vs Correct Schema

### Case 1: The Over-Denormalized Order Table

```sql
-- ❌ BAD SCHEMA: Everything in one table
CREATE TABLE orders (
  id            SERIAL PRIMARY KEY,
  customer_name VARCHAR(200),          -- duplicated across every order
  customer_email VARCHAR(200),         -- update email → update 10,000 rows
  customer_phone VARCHAR(20),          -- or miss some → stale data forever
  product_name  VARCHAR(200),          -- product renamed → partial update risk
  product_sku   VARCHAR(50),
  unit_price    DECIMAL(10,2),         -- is this current price or purchase price? ambiguous
  quantity      INT,
  shipping_addr TEXT,                  -- same address duplicated across many orders
  status        VARCHAR(50),
  created_at    TIMESTAMP
);

-- PROBLEMS:
-- 1. customer_email change → UPDATE orders SET customer_email = ... WHERE customer_email = ...
--    If 1M orders and UPDATE times out: partial update, data inconsistency
-- 2. No FK constraint: orders.product_sku can reference a product that doesn't exist
-- 3. product_name is a snapshot OR current? Code has to guess. Both interpretations exist in codebase.
-- 4. No way to get "all orders for customer X" efficiently without full scan (no customer_id FK)
-- 5. Reporting: "What is our most popular product?" — GROUP BY product_name.
--    Product renamed halfway through year: split into two groups in reports.
```

```sql
-- ✅ CORRECT SCHEMA: Normalized with intentional denormalization where justified
CREATE TABLE customers (
  id         SERIAL PRIMARY KEY,
  email      VARCHAR(254) NOT NULL UNIQUE,   -- constraint enforced at DB level
  name       VARCHAR(200) NOT NULL,
  phone      VARCHAR(20),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE products (
  id           SERIAL PRIMARY KEY,
  sku          VARCHAR(50) NOT NULL UNIQUE,
  name         VARCHAR(200) NOT NULL,
  current_price DECIMAL(10,2) NOT NULL,
  is_active    BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE orders (
  id          SERIAL PRIMARY KEY,
  customer_id INT NOT NULL REFERENCES customers(id),   -- FK: enforced referential integrity
  status      VARCHAR(20) NOT NULL DEFAULT 'PENDING'
                CHECK (status IN ('PENDING','PROCESSING','SHIPPED','DELIVERED','CANCELLED')),
  shipping_addr_snapshot JSONB NOT NULL,    -- INTENTIONAL snapshot: address at order time
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE order_items (
  id                SERIAL PRIMARY KEY,
  order_id          INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id        INT NOT NULL REFERENCES products(id),
  quantity          INT NOT NULL CHECK (quantity > 0),
  unit_price_at_purchase DECIMAL(10,2) NOT NULL,  -- INTENTIONAL snapshot: price history preserved
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- INDEXES for hot query paths:
CREATE INDEX idx_orders_customer_id  ON orders(customer_id);
CREATE INDEX idx_orders_status       ON orders(status) WHERE status != 'DELIVERED';  -- partial index
CREATE INDEX idx_order_items_order   ON order_items(order_id);
CREATE INDEX idx_orders_created_at   ON orders(created_at DESC);

-- WHY THIS DESIGN IS BETTER:
-- 1. customer email update: UPDATE customers SET email = ... WHERE id = ?  → 1 row
-- 2. product_id FK: DELETE product → DB raises FK violation. No orphaned order_items.
-- 3. unit_price_at_purchase: explicitly named — intent is clear. Historical accuracy preserved.
-- 4. shipping_addr_snapshot JSONB: address is point-in-time, not linked to current address.
--    If customer moves, old orders show delivery address correctly.
-- 5. CHECK constraint on status: DB enforces valid states. App code cannot insert 'SHIPPED2'.
-- 6. Partial index on orders(status): only indexes non-delivered orders (hot set).
--    Delivered orders (majority after 6 months) excluded. Index stays small and fast.
```

### Case 2: The God Table (Single Table for Everything)

```sql
-- ❌ ANTI-PATTERN: Generic entity-attribute-value (EAV) table
-- Seen in CMS systems, "flexible" platforms, and multi-tenant nightmares
CREATE TABLE entity_attributes (
  id          SERIAL PRIMARY KEY,
  entity_type VARCHAR(50),     -- 'user', 'product', 'order', 'article'
  entity_id   INT,
  attr_name   VARCHAR(100),    -- 'email', 'price', 'status', 'title'
  attr_value  TEXT             -- everything is TEXT. No types. No constraints.
);

-- "Get user 42's email":
SELECT attr_value
FROM entity_attributes
WHERE entity_type = 'user' AND entity_id = 42 AND attr_name = 'email';

-- PROBLEMS:
-- No FK constraints. No type safety. No unique constraints.
-- Query to get ONE user profile: 10+ rows joined in application code.
-- Cannot write: WHERE price > 100 (price is TEXT — cast fails for bad data)
-- Index on (entity_type, entity_id, attr_name): works but bloated for all entity types
-- Schema migrations: add a new attribute? No migration needed → no documentation either
-- Production: data corruption accumulates silently over years

-- WHEN EAV IS JUSTIFIED (rare):
-- User-defined custom fields (e.g., HubSpot lets users create custom CRM fields)
-- Truly sparse, unknown-at-design-time attributes
-- Even then: prefer JSONB column on a typed table over a separate EAV table
```

```sql
-- ✅ CORRECT ALTERNATIVE: JSONB for flexible attributes, typed table for core fields
CREATE TABLE users (
  id            SERIAL PRIMARY KEY,
  email         VARCHAR(254) NOT NULL UNIQUE,
  name          VARCHAR(200) NOT NULL,
  custom_fields JSONB DEFAULT '{}',         -- user-defined flexible fields here
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Query typed fields with full SQL power:
SELECT id, email FROM users WHERE email = 'alice@co.com';

-- Query flexible fields with JSON operators:
SELECT id, custom_fields->>'industry' FROM users WHERE custom_fields->>'plan' = 'enterprise';

-- Index on JSON field:
CREATE INDEX idx_users_plan ON users ((custom_fields->>'plan'));
```

### Case 3: The Wrong Primary Key Choice

```sql
-- ❌ USING NATURAL KEY AS PRIMARY KEY
CREATE TABLE employees (
  ssn         CHAR(9) PRIMARY KEY,   -- "SSN is unique, why add surrogate key?"
  name        VARCHAR(200),
  department  VARCHAR(100)
);
-- Problem: SSN can change (data entry error correction, legal name change records)
-- Problem: FKs everywhere hold SSN. Cascading update = massive lock across all tables.
-- Problem: SSN is PII. Now your FKs and indexes expose PII data.
-- Problem: International employees have no SSN.

-- ❌ SEQUENTIAL INT IN DISTRIBUTED SYSTEMS
CREATE TABLE orders (
  id  SERIAL PRIMARY KEY   -- auto-increment integer
);
-- Problem: Multiple application servers → each needs a DB roundtrip to get next ID before INSERT.
-- Problem: ID reveals business information (competitor: "my order ID is 1M, theirs is 900K").
-- Problem: Merge/shard: two databases both have order_id = 5832.

-- ✅ UUID v7 (time-ordered UUID) as PRIMARY KEY
CREATE TABLE orders (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- OR: use uuid_generate_v7() for time-ordered (better index locality than v4)
  customer_id INT NOT NULL REFERENCES customers(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- UUID v7 benefits:
-- Time-ordered: new rows insert near end of index → minimal index fragmentation
-- Application can generate ID before INSERT (no DB roundtrip)
-- Safe to expose in URLs (no sequential business intelligence leak)
-- Works across shards and merged databases
-- UUID v4 downside: random → inserts scatter across index pages → write amplification
```

---

## SECTION 6 — Performance Impact

### Table Scans: When They Kill You

```sql
-- QUERY THAT CAUSES A TABLE SCAN:
SELECT * FROM orders WHERE LOWER(customer_email) = 'alice@co.com';
--                         ^^^^^^^^^^^^^^^^^^^
--                         Function applied to column:
--                         Index on customer_email is USELESS here.
--                         Index stores raw values. LOWER() transforms them.
--                         Planner: "I can't use the index. Sequential scan."
--
-- AT SCALE:
--   1M rows × 200 bytes average = 200MB scan per query.
--   At 100 requests/second: 20GB/second disk reads. Server on fire.

-- FIX: Store canonical form OR use functional index.
ALTER TABLE orders ADD COLUMN customer_email_lower
  VARCHAR(254) GENERATED ALWAYS AS (LOWER(customer_email)) STORED;
CREATE INDEX idx_orders_email_lower ON orders(customer_email_lower);

-- OR: Functional index (Postgres only):
CREATE INDEX idx_orders_email_ci ON orders (LOWER(customer_email));
SELECT * FROM orders WHERE LOWER(customer_email) = 'alice@co.com'; -- NOW uses index

-- OTHER COMMON TABLE SCAN TRIGGERS:
-- WHERE status != 'ACTIVE'              -- negation: index can't help
-- WHERE created_at::date = '2026-01-01' -- casting indexed column
-- WHERE description LIKE '%keyword%'    -- leading wildcard: use full-text search instead
-- WHERE id IN (SELECT ...)             -- correlated subquery: may cause repeated scans
```

### Lock Contention: The Silent Killer

```sql
-- SCENARIO: E-commerce checkout. 500 concurrent users checking out simultaneously.
-- Bad pattern:
BEGIN;
  SELECT * FROM inventory WHERE product_id = 42 FOR UPDATE;  -- EXCLUSIVE LOCK
  -- ... application code runs for 200ms ...
  -- ... payment API call: 500ms ...
  -- ... LOCK HELD FOR 700ms while payment processes ...
  UPDATE inventory SET quantity = quantity - 1 WHERE product_id = 42;
COMMIT;

-- AT 500 CONCURRENT USERS:
-- 499 users queued behind the first lock holder.
-- Lock holder takes 700ms → queue degrades: last user waits 500 × 700ms = 350 SECONDS.
-- DB connection pool (20 connections): exhausted in seconds.
-- Application: "connection timeout" errors. All checkouts failing.

-- CORRECT PATTERN: Minimize lock hold time
-- Move payment call OUTSIDE the transaction.
-- Acquire lock only for the actual DB operation:

-- Step 1: Process payment (OUTSIDE transaction, no lock held):
const paymentResult = await stripe.charge(amount);

-- Step 2: Short transaction for inventory update only:
BEGIN;
  UPDATE inventory
  SET quantity = quantity - 1
  WHERE product_id = 42 AND quantity > 0
  RETURNING quantity;
  -- If rows affected = 0: oversold, handle gracefully
COMMIT;
-- Lock held for: ~5ms instead of 700ms. 140x reduction.

-- OPTIMISTIC LOCKING (alternative for low-contention scenarios):
BEGIN;
  SELECT quantity, version FROM inventory WHERE product_id = 42;
  -- version = 7

  -- ... prepare order record ...

  UPDATE inventory
  SET quantity = quantity - 1, version = version + 1
  WHERE product_id = 42 AND version = 7;  -- Only updates if version unchanged
  -- If 0 rows updated: another transaction modified it. Retry.
COMMIT;
-- No SELECT FOR UPDATE lock. Multiple transactions proceed concurrently.
-- Retry on conflict: fine for low-contention. Bad for high-contention (thundering retry storm).
```

### CPU Spikes from Schema Design

```sql
-- WIDE ROWS + SELECT * = unnecessary data transfer + CPU deserialization
CREATE TABLE events (
  id          UUID PRIMARY KEY,
  user_id     INT,
  payload     JSONB,        -- sometimes 100KB of nested JSON
  raw_html    TEXT,         -- sometimes 500KB
  metadata    JSONB,
  created_at  TIMESTAMPTZ
);

-- This query causes a CPU spike:
SELECT * FROM events WHERE user_id = 42 ORDER BY created_at DESC LIMIT 10;
-- Reads 100KB-600KB per row × 10 rows = up to 6MB of data transfer.
-- Deserializes all that JSONB on every row.
-- At 1,000 requests/second: 6GB/sec of unnecessary data.

-- FIX: Project only needed columns
SELECT id, user_id, created_at, payload->>'event_type' as event_type
FROM events
WHERE user_id = 42
ORDER BY created_at DESC
LIMIT 10;
-- Returns ~100 bytes per row instead of 600KB.
-- 6,000x reduction in data transfer.
-- CPU: no 100KB JSONB deserialization per row.
```

---

## SECTION 7 — Concurrency & Data Corruption

### Race Condition: Duplicate Record Creation

```sql
-- SCENARIO: User clicks "Create Account" twice (double-click or retry).
-- Both requests hit server at the same time.

-- ❌ APPLICATION-LEVEL UNIQUENESS CHECK (BROKEN):
-- Request 1:
SELECT id FROM users WHERE email = 'alice@co.com';
-- Returns 0 rows. Proceed.

-- Request 2 (simultaneous):
SELECT id FROM users WHERE email = 'alice@co.com';
-- ALSO returns 0 rows (Request 1 hasn't committed yet).

-- Request 1: INSERT INTO users (email) VALUES ('alice@co.com'); -- succeeds
-- Request 2: INSERT INTO users (email) VALUES ('alice@co.com'); -- ALSO succeeds

-- Result: two user records for same email. Downstream: payments split, data inconsistency.

-- ✅ CORRECT: DB-LEVEL UNIQUE CONSTRAINT
ALTER TABLE users ADD CONSTRAINT uq_users_email UNIQUE (email);
-- OR (preferred - clearer intent):
CREATE UNIQUE INDEX idx_users_email ON users(email);

-- Now:
-- Request 1: INSERT succeeds.
-- Request 2: INSERT raises: ERROR: duplicate key value violates unique constraint "idx_users_email"
-- Catch in application: 23505 error code (PostgreSQL) → return "Email already in use."
-- Zero race condition. DB enforces it atomically.
```

### Lost Update: Concurrent Balance Modifications

```sql
-- SCENARIO: Flight booking — two agents book the last seat simultaneously.

-- ❌ READ-MODIFY-WRITE (LOST UPDATE BUG):
-- Agent 1 reads: available_seats = 1
-- Agent 2 reads: available_seats = 1 (same point in time)
-- Agent 1 writes: UPDATE flights SET available_seats = 0 WHERE id = 42; -- books it
-- Agent 2 writes: UPDATE flights SET available_seats = 0 WHERE id = 42; -- ALSO "books" it
-- Both agents get confirmation. 2 people in 1 seat.

-- ✅ FIX 1: Atomic UPDATE with CHECK
UPDATE flights
SET available_seats = available_seats - 1
WHERE id = 42 AND available_seats > 0;
-- RETURNING available_seats;  ← check if rowcount = 1 (success) or 0 (oversold)

-- The UPDATE is atomic. DB acquires row lock, decrements, releases.
-- Agent 1: available_seats 1→0. Returns 1 row.
-- Agent 2: WHERE available_seats > 0 is false (it's 0). Returns 0 rows.
-- Application sees 0 rows affected → seat unavailable.

-- ✅ FIX 2: SELECT FOR UPDATE (pessimistic lock)
BEGIN;
SELECT available_seats FROM flights WHERE id = 42 FOR UPDATE;
-- Row is now locked. Agent 2's identical query: waits here.
IF available_seats > 0
  UPDATE flights SET available_seats = available_seats - 1 WHERE id = 42;
  -- book the reservation...
COMMIT;
-- Lock released. Agent 2's query now proceeds with updated value (0). Returns safely.

-- WHEN TO USE WHICH:
-- Atomic UPDATE: preferred when business logic is simple (decrement counter)
-- SELECT FOR UPDATE: needed when decision logic between read and write is complex
--                    (e.g., read seat, apply business rules, write reservation + seat update)
```

### The Phantom Read Problem (Why REPEATABLE READ Matters)

```sql
-- SCENARIO: Finance: generate monthly invoice.
-- Transaction: calculate total, count transactions, generate summary — must be consistent.

-- READ COMMITTED ISOLATION (default in most DBs):
-- Transaction T1:
BEGIN;
SELECT SUM(amount) FROM transactions WHERE account_id = 5 AND month = '2026-01';
-- Returns: $10,000

-- Meanwhile, Transaction T2 commits: INSERT a new transaction for account 5.
-- T1 queries again:
SELECT COUNT(*) FROM transactions WHERE account_id = 5 AND month = '2026-01';
-- Returns: 101 rows (includes new row from T2!)

-- Invoice: SUM from 100 rows, COUNT from 101 rows. Inconsistent. Invoice is wrong.
-- This is a PHANTOM READ: T2's new row "appeared" mid-transaction.

-- ✅ FIX: REPEATABLE READ isolation
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ;
SELECT SUM(amount) FROM transactions WHERE account_id = 5 AND month = '2026-01';
-- Snapshot taken at transaction start.
SELECT COUNT(*) FROM transactions WHERE account_id = 5 AND month = '2026-01';
-- SAME SNAPSHOT. T2's new row invisible. Count = 100. Consistent.
COMMIT;

-- ISOLATION LEVELS (from weakest to strongest):
-- READ UNCOMMITTED: can see uncommitted data (dirty reads) — almost never use
-- READ COMMITTED:   see only committed data, but data can change between queries in same tx
-- REPEATABLE READ:  snapshot taken at tx start — same rows visible throughout
-- SERIALIZABLE:     transactions behave as if run sequentially — strongest, highest cost
```

---

## SECTION 8 — Optimization & Indexing

### When Indexing Helps

```sql
-- RULE: Index benefits queries that SELECT a small fraction of the table.
-- If your query returns >15-20% of rows, sequential scan often beats index.

-- THESE QUERIES BENEFIT FROM INDEXES:
-- 1. Primary key lookup: 1 row from 10M → index essential
SELECT * FROM orders WHERE id = 38291;

-- 2. High-cardinality filter: customer_id has millions of unique values
SELECT * FROM orders WHERE customer_id = 42;

-- 3. Range scan on timestamp: last 24 hours of events from 1 year of data
SELECT * FROM events WHERE created_at > NOW() - INTERVAL '24 hours';

-- 4. Composite index: multi-column filter used together frequently
CREATE INDEX idx_orders_customer_status ON orders(customer_id, status);
SELECT * FROM orders WHERE customer_id = 42 AND status = 'PENDING';
-- Index covers both columns → index-only scan possible (no heap read)

-- 5. Covering index: index contains all columns needed by query
CREATE INDEX idx_orders_covering ON orders(customer_id) INCLUDE (status, created_at);
-- Query: SELECT status, created_at FROM orders WHERE customer_id = 42
-- Index satisfies entire query without touching heap pages.
```

### When Indexing HURTS

```sql
-- ❌ INDEXING LOW-CARDINALITY COLUMNS
CREATE INDEX idx_users_is_active ON users(is_active);
-- is_active: only 2 values (true/false). 95% of users are active.
-- Query: SELECT * FROM users WHERE is_active = true → 95% of table.
-- Sequential scan faster than reading 95% via random index lookups.
-- Disk: random I/O per index pointer = slower than sequential scan for large result sets.

-- FIX: PARTIAL INDEX (only index the interesting minority)
CREATE INDEX idx_users_inactive ON users(id) WHERE is_active = false;
-- Only 5% of users. Small, fast. Unused for is_active = true queries (correct).

-- ❌ TOO MANY INDEXES ON HIGH-WRITE TABLE
CREATE TABLE events (id UUID PRIMARY KEY, user_id INT, type VARCHAR, payload JSONB, created_at TIMESTAMPTZ);
CREATE INDEX idx1 ON events(user_id);
CREATE INDEX idx2 ON events(type);
CREATE INDEX idx3 ON events(created_at DESC);
CREATE INDEX idx4 ON events(user_id, type);
CREATE INDEX idx5 ON events(user_id, created_at);
-- 5 indexes on a table receiving 50,000 inserts/second.
-- Every INSERT: update 5 B-tree index structures.
-- Write throughput: 50K inserts/sec → effectively 250K B-tree operations/sec.
-- Impact: insert latency 5-10x higher. WAL volume 5x. Replication lag increases.

-- RULE: Each index costs ~10-30% write overhead on that table.
--       Benchmark before adding. Remove unused indexes.

-- CHECK UNUSED INDEXES (Postgres):
SELECT schemaname, tablename, indexname, idx_scan
FROM pg_stat_user_indexes
WHERE idx_scan = 0  -- Never used since last stats reset
  AND schemaname = 'public'
ORDER BY pg_relation_size(indexrelid) DESC;

-- ❌ INDEXING ON THE WRONG COLUMN ORDER (COMPOSITE INDEX)
CREATE INDEX idx_orders_status_customer ON orders(status, customer_id);
-- Query: SELECT * FROM orders WHERE customer_id = 42 AND status = 'PENDING'
-- Does this use the index? ONLY if planner can use prefix (status).
-- customer_id is not the leading column → full index scan or ignored.

-- RULE: Composite index (A, B): index used for queries on A alone OR A+B.
--       NOT for queries on B alone.
-- Order by selectivity: most selective column first (or match query pattern).

CREATE INDEX idx_orders_customer_status ON orders(customer_id, status);
-- customer_id: high cardinality → used first to narrow to 5-50 rows.
-- status: narrows those rows further. Efficient.
```

### The Index Bloat Problem

```sql
-- SCENARIO: orders table. customer_id indexed.
--           Orders deleted frequently (GDPR right-to-erasure, test data cleanup).
--
-- B-tree behavior on DELETE:
--   Row deleted from heap → index entry marked as "dead" (not removed immediately).
--   Dead entries accumulate. Index size grows. B-tree depth grows.
--   Query: traverses more levels. Performance degrades 2-5x over 6 months.

-- CHECK INDEX BLOAT:
SELECT
  schemaname || '.' || tablename AS table,
  indexname,
  pg_size_pretty(pg_relation_size(indexrelid)) AS index_size,
  idx_scan AS scans
FROM pg_stat_user_indexes
ORDER BY pg_relation_size(indexrelid) DESC;

-- FIX: REINDEX CONCURRENTLY (no lock, safe for production)
REINDEX INDEX CONCURRENTLY idx_orders_customer_id;
-- Rebuilds index without locking table. Takes minutes. Run during low traffic.

-- PREVENTIVE: pg_cron or scheduled maintenance for high-churn tables.
```

### Query Rewrite Before Adding an Index

```sql
-- BEFORE adding an index, check if the query can be rewritten.
-- Index solves the symptom. Query rewrite solves the cause.

-- ORIGINAL SLOW QUERY:
SELECT o.*, c.email, c.name
FROM orders o
LEFT JOIN customers c ON o.customer_id = c.id
WHERE DATE(o.created_at) = '2026-02-01';  -- ← function on indexed column: index ignored

-- REWRITE 1: Remove function from indexed column
SELECT o.*, c.email, c.name
FROM orders o
LEFT JOIN customers c ON o.customer_id = c.id
WHERE o.created_at >= '2026-02-01 00:00:00'
  AND o.created_at <  '2026-02-02 00:00:00';
-- Now: range scan on created_at index. No table scan.

-- REWRITE 2: Avoid SELECT * on joined tables
SELECT o.id, o.status, o.created_at, c.email, c.name
FROM orders o
LEFT JOIN customers c ON o.customer_id = c.id
WHERE o.created_at >= '2026-02-01'
  AND o.created_at <  '2026-02-02';
-- Projecting only needed columns = smaller result set, less memory, faster network transfer.

-- REWRITE 3: Use EXISTS instead of IN for subquery
-- ❌ SLOW:
SELECT * FROM customers WHERE id IN (SELECT customer_id FROM orders WHERE status = 'PENDING');
-- The subquery runs first, returns potentially millions of IDs, then outer query filters.

-- ✅ FASTER:
SELECT * FROM customers c WHERE EXISTS (
  SELECT 1 FROM orders o WHERE o.customer_id = c.id AND o.status = 'PENDING'
);
-- EXISTS short-circuits: stops searching as soon as one match found. Correlates per row.
-- With index on orders(customer_id, status): each EXISTS check = 1 index lookup.
```
