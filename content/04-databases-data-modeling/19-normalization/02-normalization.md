# Normalization — Part 2 of 3

### Sections: 5 (Bad vs Correct Usage), 6 (Performance Impact), 7 (Concurrency & Data Integrity), 8 (Optimization & Indexing)

**Series:** Databases & Data Modeling → Topic 19

---

## SECTION 5 — Bad Usage vs Correct Usage

### Common Normalization Anti-Patterns

**Anti-Pattern 1: Storing arrays of foreign keys in a column**

```sql
-- BAD: storing related IDs as a comma-separated string or array
CREATE TABLE projects_bad (
    id          INTEGER PRIMARY KEY,
    name        TEXT,
    member_ids  TEXT  -- '1,5,12,89,203' — violates 1NF
);
-- Cannot enforce that member IDs reference real users (no FK).
-- Cannot query "which projects is user 5 a member of?" without slow LIKE '%5%' scan.
-- Cannot add attributes to the membership (e.g., role, joined_at).
-- "Can user 5 see project 42?" requires application parsing.

-- Also bad: PostgreSQL array — slightly better but still problematic:
CREATE TABLE projects_array (
    id          INTEGER PRIMARY KEY,
    member_ids  INTEGER[]  -- {1,5,12,89,203}
);
-- Still cannot enforce FK references on individual array elements.
-- Still no membership attributes.

-- CORRECT: junction table (3NF), proper many-to-many:
CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE project_members (
    project_id  INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
    role        TEXT NOT NULL DEFAULT 'member',
    joined_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (project_id, user_id)
);
-- "Which projects is user 5 a member of?" → fast index scan on user_id.
-- FK constraints enforced. Attributes possible. Queryable.
```

---

**Anti-Pattern 2: Over-normalizing to the point of impracticality**

```sql
-- BAD: 5th Normal Form for a simple address (theoretical purity vs practical cost):
CREATE TABLE countries  (id INT PK, name TEXT);
CREATE TABLE states     (id INT PK, country_id INT FK, name TEXT);
CREATE TABLE cities     (id INT PK, state_id INT FK, name TEXT);
CREATE TABLE zip_codes  (id INT PK, city_id INT FK, code CHAR(5));
CREATE TABLE addresses  (id INT PK, zip_id INT FK, street TEXT);
CREATE TABLE user_addresses (user_id INT FK, address_id INT FK);
-- 6-table JOIN to get a user's full address.
-- For "display the user's city": 5 JOINs.
-- Over-normalized: address atomicity not needed at this granularity for most apps.

-- PRACTICAL 3NF:
CREATE TABLE addresses (
    id          INTEGER PRIMARY KEY,
    street      TEXT,
    city        TEXT,
    state       CHAR(2),
    zip_code    CHAR(5),
    country     CHAR(2) DEFAULT 'US'
);
-- 3NF violation: zip → city, state. BUT: addresses are immutable once written.
-- Update anomaly risk: near zero in practice (addresses don't change retroactively).
-- Pragmatic trade-off: accepted.
```

---

**Anti-Pattern 3: Repeated groups in JSONB as a normalization escape hatch**

```sql
-- BAD: using JSONB to avoid creating proper tables
CREATE TABLE orders_bad (
    id       INTEGER PRIMARY KEY,
    items    JSONB  -- [{"product_id": 1, "qty": 2}, {"product_id": 5, "qty": 1}]
);
-- Cannot enforce FK: product_id in JSON doesn't reference products table.
-- Cannot aggregate "total quantity sold by product" without unnesting.
-- Cannot add constraints (qty > 0).
-- Querying specific items: requires GIN index + @> operator (heavy).

-- CORRECT: normalized order_items table:
CREATE TABLE order_items (
    order_id    INTEGER REFERENCES orders ON DELETE CASCADE,
    product_id  INTEGER REFERENCES products ON DELETE RESTRICT,
    quantity    INTEGER NOT NULL CHECK (quantity > 0),
    unit_price  INTEGER NOT NULL,    -- price at time of order (intentional denorm)
    PRIMARY KEY (order_id, product_id)
);
```

---

**CORRECT: When JSONB IS appropriate (semi-structured data without FK needs):**

```sql
-- User preferences: no FK references, no aggregations needed, frequently varies per user:
CREATE TABLE user_preferences (
    user_id     INTEGER PRIMARY KEY REFERENCES users,
    preferences JSONB NOT NULL DEFAULT '{}'
    -- OK: {"theme": "dark", "language": "en", "notifications": {"email": true, "sms": false}}
    -- No FK relationships needed. No aggregations. Format varies per user. JSONB is correct.
);
```

---

## SECTION 6 — Performance Impact

### Normalization's Performance Trade-offs

```
Benchmark: Order history query across 3 normalized tables vs denormalized single table.
Setup: 50M orders, 10M customers, 200M order_items. PostgreSQL 15, 32GB RAM.

NORMALIZED QUERY (3-table JOIN):
SELECT c.name, o.id, SUM(oi.qty * oi.unit_price) AS total
FROM orders o
JOIN customers c    ON c.id = o.customer_id
JOIN order_items oi ON oi.order_id = o.id
WHERE o.customer_id = 84732
GROUP BY c.name, o.id
ORDER BY o.created_at DESC
LIMIT 20;

Execution plan:
  Limit (rows=20)
    Sort by created_at
      HashAggregate (groups=280 orders for this customer)
        Hash Join (customers × order lookup)
          →  Index Scan on orders (customer_id=84732): 280 rows, 2.1ms
          →  Index Scan on order_items (order_id IN 280): 4,200 rows, 8.4ms
          →  Index Scan on customers (id=84732): 1 row, 0.2ms
Total: 18ms

DENORMALIZED QUERY (single orders_with_totals table, totals pre-computed):
SELECT customer_name, id, total_cents
FROM orders_denorm
WHERE customer_id = 84732
ORDER BY created_at DESC
LIMIT 20;

Index Scan on orders_denorm(customer_id, created_at DESC): 20 rows
Total: 0.8ms

Winner: denormalized on reads (22x faster for this query).
BUT: every update to customer name → update ALL their orders. 280 rows × 50M customers.
Every order total change → recompute. Every product price change → cascade recompute.
```

**Where normalization WINS on performance:**

```sql
-- UPDATE performance:
-- Normalized: UPDATE products SET price = 2999 WHERE id = 101; → 1 row modified.
-- Denormalized (price embedded in order_items): UPDATE order_items SET unit_price = 2999
--   WHERE product_id = 101;  → potentially millions of rows modified.
-- Normalized: 0.1ms. Denormalized: minutes on large datasets.

-- Storage efficiency:
-- Customer name "Acme Corporation Ltd" (20 bytes) stored once in normalized schema.
-- In denormalized orders: stored in every order row. Average 50 orders per customer:
-- 20 bytes × 50 = 1,000 bytes vs 20 bytes = 98% storage waste for that field alone.
-- 50M orders × "Acme Corporation Ltd" type names repeated = significant storage cost.

-- Cache efficiency:
-- Normalized: small focused tables → pages packed with useful data → higher cache hit rate.
-- Denormalized: wide rows → more pages → more memory needed for same useful data.
```

---

## SECTION 7 — Concurrency & Data Integrity

### How Normalization Prevents Concurrent Anomalies

**Update anomaly under concurrent writes (denormalized):**

```sql
-- Denormalized: product_name stored in both products and order_items.
-- Two concurrent transactions:
--   Tx A: UPDATE products SET name = 'Widget Pro 2.0' WHERE id = 10  → commits
--   Tx B: SELECT name FROM order_items WHERE product_id = 10          → returns 'Widget Pro'
-- Now: products says 'Widget Pro 2.0'. order_items says 'Widget Pro'. Inconsistent.
-- In a normalized schema: there's exactly one source. No inconsistency possible.

-- The normalized FK ensures integrity under delete:
CREATE TABLE order_items (
    product_id INTEGER REFERENCES products(id) ON DELETE RESTRICT
    -- ON DELETE RESTRICT: prevents deleting a product that has order_items.
    -- Ensures referential integrity. A product can't "disappear" from an existing order.
);
-- Concurrent delete attempt on products:
DELETE FROM products WHERE id = 10;
-- PostgreSQL: "ERROR: update or delete on table 'products' violates foreign key constraint..."
-- Integrity maintained under concurrent deletes.
```

**FK enforcement and lock behavior:**

```sql
-- FK checks acquire ShareRowExclusiveLock on the referenced row (not the table).
-- INSERT INTO order_items (product_id = 10): takes ShareLock on products row 10.
-- Concurrent DELETE from products WHERE id = 10: blocked.
-- Once order_items INSERT commits: the delete can check if any order_items reference id=10.
-- This is correct behavior: FK prevents orphaned order_items referencing a deleted product.

-- High-volume inserts with FK checks:
-- INSERT INTO order_items: 10K rows/second. FK check on products.id: each insert acquires
-- a brief ShareLock. No contention if products are not being deleted simultaneously.
-- FK overhead on INSERT: typically 5-15% (an index scan on the referenced table per row).
-- Optimization: ensure the referenced column has a PK or UNIQUE index (PostgreSQL requires this).
```

---

## SECTION 8 — Optimization & Indexing

### Indexing Normalized Schemas for Join Performance

```sql
-- The join-acceleration rule: every FK column must be indexed.
-- Without index: nested loop join reads ALL rows of inner table per outer row → O(N×M).
-- With index: nested loop join uses index lookup per outer row → O(N×log M).

-- For the orders + customers + order_items schema:

-- 1. FK on orders.customer_id (join customers to orders):
CREATE INDEX idx_orders_customer_id ON orders(customer_id);
-- Enables: Index Scan for Hash Join / Nested Loop Join inner side.

-- 2. FK on order_items.order_id (join order_items to orders):
CREATE INDEX idx_order_items_order_id ON order_items(order_id);
-- Critical: order_items is the largest table. Without this: SeqScan of 200M rows per join.

-- 3. FK on order_items.product_id:
CREATE INDEX idx_order_items_product_id ON order_items(product_id);
-- Enables: look up "all orders containing product X."

-- Covering index for common lookup (avoids heap access entirely):
CREATE INDEX idx_orders_customer_covering ON orders(customer_id, created_at DESC)
    INCLUDE (id, status, total_cents);
-- Query: SELECT id, status, total_cents FROM orders WHERE customer_id = $x ORDER BY created_at DESC
-- Index-only scan: all needed columns in the index. Never touches heap.
-- 100x faster than SeqScan for single-customer order history.

-- N+1 prevention via check:
-- Verify all FK columns have indexes:
SELECT
    conname AS fk_name,
    conrelid::regclass AS table_name,
    a.attname AS column_name,
    CASE WHEN idx.indexname IS NOT NULL THEN 'indexed' ELSE 'MISSING INDEX' END AS index_status
FROM pg_constraint c
JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
LEFT JOIN (
    SELECT t.relname, ix.relname AS indexname, a2.attname
    FROM pg_index i
    JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_class ix ON ix.oid = i.indexrelid
    JOIN pg_attribute a2 ON a2.attrelid = t.oid AND a2.attnum = ANY(i.indkey)
) idx ON idx.relname = conrelid::regclass::text AND idx.attname = a.attname
WHERE c.contype = 'f'
ORDER BY index_status DESC, table_name;
-- Rows with "MISSING INDEX": high join-performance risk. Add indexes immediately.
```
