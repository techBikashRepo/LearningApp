# Normalization — Part 1 of 3

### Sections: 1 (Intuition & Analogy), 2 (Why This Exists), 3 (Internal Working), 4 (Query Execution Flow)

**Series:** Databases & Data Modeling → Topic 19

---

## SECTION 1 — Intuition & Analogy

### The Address Book That Contains Itself

Imagine a spreadsheet tracking customer orders:

```
| OrderID | CustomerName | CustomerEmail      | CustomerCity | ProductName | ProductPrice | Qty |
|---------|--------------|--------------------|--------------|--------------:|-------------|-----|
| 001     | Alice Smith  | alice@corp.com     | Seattle      | Widget Pro   | $29.99      | 2   |
| 002     | Alice Smith  | alice@corp.com     | Seattle      | Gadget Plus  | $49.99      | 1   |
| 003     | Bob Jones    | bob@startup.io     | Austin       | Widget Pro   | $29.99      | 3   |
```

Alice appears in rows 1 and 2. "Widget Pro" appears in rows 1 and 3. Everything is duplicated. Now:

- Alice moves to Portland. You update row 1 but forget row 2. Now two conflicting addresses for Alice. **Update anomaly.**
- You delete order 001. Suddenly you have no record that Widget Pro costs $29.99. **Deletion anomaly.**
- You want to add a new product to the catalog, but you have no order for it yet — so you can't insert it. **Insertion anomaly.**

**Normalization is the process of structuring tables to eliminate these anomalies by ensuring each piece of information is stored in exactly one place.**

```
Normalized equivalent:

  customers table:
    customer_id | name       | email          | city
    1           | Alice Smith| alice@corp.com | Seattle

  products table:
    product_id | name        | price
    10         | Widget Pro  | $29.99
    11         | Gadget Plus | $49.99

  orders table:
    order_id | customer_id | ordered_at
    001      | 1           | 2024-01-15

  order_items table:
    order_id | product_id | qty
    001      | 10         | 2
    001      | 11         | 1

Now: Alice's city stored once. Widget Pro's price stored once. Update, delete, insert anomalies: gone.
```

The analogy: normalization is like a well-organized filing system where each fact lives in exactly one folder. Denormalized data is like photocopying the same document and filing it in every folder that might need it — faster to access, but you must update every copy when the fact changes.

---

## SECTION 2 — Why This Problem Exists (Production Failures)

### Real-World Incidents: The Cost of Missing Normalization

**Incident 1: E-commerce — Price Inconsistency at Scale**
Platform: online marketplace, 12 million products. Architecture: product price stored directly in the `order_items` table at the time of order creation AND in a `products` table. Over 3 years of development, two code paths diverged — one updated prices in `products`, the other forgot to sync `order_items` pricing. Audit discovered: 847,000 historical orders showed prices that never matched the product catalog. Tax calculations based on order_items had been incorrect for 18 months. Tax correction filing: $2.3M adjustment.

Root cause: price stored in two places. One wasn't kept in sync. Update anomaly in production.

---

**Incident 2: Healthcare Platform — Duplicate Patient Records**
Platform: EHR (Electronic Health Records) system. Data model: patient name, DOB, and insurance ID stored in both the `appointments` table and the `patients` table. A tool allowed administrative staff to update the appointment directly without updating the `patients` table. Result: 23,000 records where appointment table showed a different name than the patients table (name changes after marriage, typo corrections applied to one but not both). Regulatory audit: HIPAA compliance violation. Remediation: 6 months of data cleaning, $180K in contractor costs.

---

**Incident 3: CRM — Update Anomaly Under Load**
Platform: sales CRM, 300 sales reps. Company name stored in both `contacts` table and `deals` table. When a company rebranded, the CRM update flow updated `contacts` but not `deals`. Active deals: still showed the old company name. During an acquisition negotiation, a buyer's lawyer received documents referencing two different company names. Deal nearly fell through.

---

**The common thread:** data stored in more than one place will diverge. Normalization eliminates the divergence by design — not by discipline. Discipline fails under deadline pressure, new engineers, and concurrent development. Schema-enforced single-source-of-truth does not.

---

## SECTION 3 — Internal Working

### The Normal Forms: From 1NF to BCNF

**First Normal Form (1NF) — Eliminate Repeating Groups**

Rule: every cell contains exactly one atomic value. No arrays, no comma-separated lists, no repeating column groups.

```sql
-- Violates 1NF: comma-separated tags stored in one column
CREATE TABLE articles_bad (
    id      INTEGER PRIMARY KEY,
    title   TEXT,
    tags    TEXT   -- 'postgresql, indexing, performance' -> NOT 1NF
);

-- 1NF compliant: one value per cell
CREATE TABLE articles (id INTEGER PRIMARY KEY, title TEXT);
CREATE TABLE article_tags (
    article_id  INTEGER REFERENCES articles(id),
    tag         TEXT,
    PRIMARY KEY (article_id, tag)
);
```

PostgreSQL arrays technically violate strict 1NF but can be practical. The key criterion: can you query and enforce constraints on individual values? Arrays with GIN indexes: workable. But arrays don't enforce FK relationships, uniqueness of elements, or referential integrity.

---

**Second Normal Form (2NF) — Eliminate Partial Dependencies**

Applies to tables with composite primary keys. Every non-key column must depend on the WHOLE primary key, not just part of it.

```sql
-- Violates 2NF: ProductName depends only on ProductID, not on (OrderID, ProductID)
CREATE TABLE order_items_bad (
    order_id    INTEGER,
    product_id  INTEGER,
    product_name TEXT,    -- depends only on product_id: PARTIAL DEPENDENCY
    quantity    INTEGER,
    PRIMARY KEY (order_id, product_id)
);

-- 2NF compliant: product_name moves to products table
CREATE TABLE products (product_id INTEGER PRIMARY KEY, product_name TEXT, price NUMERIC);
CREATE TABLE order_items (
    order_id    INTEGER,
    product_id  INTEGER REFERENCES products,
    quantity    INTEGER,
    PRIMARY KEY (order_id, product_id)
    -- quantity depends on (order_id, product_id) → full dependency ✓
);
```

---

**Third Normal Form (3NF) — Eliminate Transitive Dependencies**

Every non-key column must depend directly on the primary key — not on another non-key column.

```sql
-- Violates 3NF: zip → city, state (transitive dependency through zip)
CREATE TABLE employees_bad (
    employee_id  INTEGER PRIMARY KEY,
    name         TEXT,
    zip_code     CHAR(5),
    city         TEXT,    -- depends on zip_code, not employee_id → TRANSITIVE
    state        CHAR(2)  -- depends on zip_code, not employee_id → TRANSITIVE
);

-- 3NF compliant:
CREATE TABLE zip_codes (
    zip_code CHAR(5) PRIMARY KEY,
    city     TEXT NOT NULL,
    state    CHAR(2) NOT NULL
);
CREATE TABLE employees (
    employee_id  INTEGER PRIMARY KEY,
    name         TEXT,
    zip_code     CHAR(5) REFERENCES zip_codes
);
```

---

**Boyce-Codd Normal Form (BCNF) — Stricter 3NF**

Every determinant must be a candidate key. Handles edge cases 3NF misses (multiple overlapping candidate keys).

```sql
-- Violates BCNF: courses table where (student, course) and (student, teacher) are candidate keys
-- but teacher → course (a teacher teaches only one course), and teacher is NOT a candidate key alone.
-- Full BCNF decomposition:
CREATE TABLE teacher_course (teacher_id INTEGER PRIMARY KEY, course_id INTEGER NOT NULL);
CREATE TABLE student_teacher (
    student_id  INTEGER,
    teacher_id  INTEGER REFERENCES teacher_course,
    PRIMARY KEY (student_id, teacher_id)
);
```

---

**PostgreSQL's role in enforcing normalization:**

```sql
-- FK constraints enforce that related data EXISTS in the referenced table:
ALTER TABLE order_items ADD CONSTRAINT fk_product
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT;
-- Deletion anomaly prevented: can't delete a product if order_items reference it.

-- UNIQUE constraint on natural key prevents duplicate entities:
ALTER TABLE customers ADD CONSTRAINT uq_customer_email UNIQUE (email);
-- Insertion anomaly prevented: can't create two customer records for the same person.

-- NOT NULL + FK: ensures every order_item references a real product.
-- NO orphaned data without a cause. Referential integrity = normalization enforcement.
```

---

## SECTION 4 — Query Execution Flow

### How JOINs Reconstruct Normalized Data

**Schema:**

```sql
customers(id PK, name, email, city)
orders(id PK, customer_id FK→customers, total_cents, ordered_at)
order_items(order_id FK→orders, product_id FK→products, quantity)
products(id PK, name, price_cents)
```

**Query: get all orders with customer names and product details:**

```sql
EXPLAIN ANALYZE
SELECT c.name, c.email, o.id AS order_id, p.name AS product, oi.quantity, p.price_cents
FROM orders o
JOIN customers c    ON c.id = o.customer_id
JOIN order_items oi ON oi.order_id = o.id
JOIN products p     ON p.id = oi.product_id
WHERE c.city = 'Seattle'
  AND o.ordered_at >= '2024-01-01';
```

**PostgreSQL planner execution:**

```
Hash Join  (cost=1420..8932 rows=847 width=72) (actual time=12.4..89.3 rows=923)
  Hash Cond: (oi.product_id = p.id)
  →  Hash Join  (cost=820..5200 rows=2100 width=48)
       Hash Cond: (oi.order_id = o.id)
       →  Seq Scan on order_items oi  (scan all items for matching orders)
       →  Hash
            →  Hash Join  (cost=210..780 rows=412)
                 Hash Cond: (o.customer_id = c.id)
                 →  Index Scan on orders (using idx_orders_ordered_at)
                      Index Cond: ordered_at >= '2024-01-01'
                 →  Hash
                      →  Seq Scan on customers
                           Filter: (city = 'Seattle')
  →  Hash
       →  Seq Scan on products p (small table, full scan = fast)
```

**What this tells us:**

1. PostgreSQL starts from the most filtered table: `orders` filtered by `ordered_at` (uses index).
2. Builds a hash of matching customers in Seattle.
3. Joins orders to customers via hash.
4. Joins to order_items (all, then filtered by join condition).
5. Joins to products (small table, hash in memory).

**Performance of normalized data:**

- Each table is small and focused: autovacuum is efficient.
- Indexes on each FK: joins are fast.
- Updates to `products.price_cents`: one row updated, immediately reflected everywhere.
- The "cost" of normalization: joins. The "benefit": data consistency, smaller individual tables, efficient single-row updates.

**Index strategy for normalized queries:**

```sql
-- FK columns should ALL be indexed for join performance:
CREATE INDEX idx_orders_customer_id ON orders(customer_id);
CREATE INDEX idx_order_items_order_id ON order_items(order_id);
CREATE INDEX idx_order_items_product_id ON order_items(product_id);
-- Without these: Hash Join degrades to nested loop with SeqScan on large tables.
```
