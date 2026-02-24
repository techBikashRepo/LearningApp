# Normalization — Part 3 of 3

### Sections: 9 (AWS Mapping), 10 (Interview Q&A), 11 (Debugging Exercise), 12 (Architect's Mental Model)

**Series:** Databases & Data Modeling → Topic 19

---

## SECTION 9 — AWS Service Mapping

### How AWS Services Relate to Normalization

| Layer          | AWS Service                      | Normalization Relevance                                                                                                                                                              |
| -------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Relational DB  | Amazon RDS / Aurora              | Full normalization supported: FK constraints, JOINs, transactions. Aurora PostgreSQL: same normalization capabilities as on-premise.                                                 |
| Serverless DB  | Amazon Aurora Serverless v2      | Normalized schemas work identically. Auto-scales compute, not schema design.                                                                                                         |
| DynamoDB       | Amazon DynamoDB                  | NoSQL: denormalization required. Single-table design pattern. No JOINs, no FK constraints. Normalization tradeoffs conscious for access patterns.                                    |
| Data Warehouse | Amazon Redshift                  | Star schema (partially denormalized): fact tables + dimension tables. Redshift does NOT enforce FK constraints (performance reason), but they're declared for query optimizer hints. |
| ETL            | AWS Glue                         | Normalizes raw data during ETL: Glue jobs extract, transform (deduplicate, split columns), load into normalized RDS tables.                                                          |
| Schema Mgmt    | AWS SCT (Schema Conversion Tool) | Analyzes source schema normalization level. Recommends transformations when migrating Oracle/MySQL to PostgreSQL.                                                                    |
| Lake           | Amazon S3 + Athena               | Raw data: often denormalized (as-landed JSON/CSV). Normalization optional depending on query pattern. Athena handles JOINs via SQL on S3.                                            |

---

**Normalized schema on Aurora PostgreSQL:**

```sql
-- Aurora PostgreSQL supports all normalization features:
-- FK constraints with ON DELETE CASCADE / RESTRICT.
-- Partial indexes.
-- CHECK constraints.
-- GENERATED columns (computed from others: virtual normalization).

-- Example: 3NF on Aurora:
CREATE TABLE products (
    id          SERIAL PRIMARY KEY,
    name        TEXT NOT NULL,
    category_id INTEGER NOT NULL REFERENCES categories(id),
    price_cents INTEGER NOT NULL
);

-- Aurora specific: Global Database replicates this normalized schema across regions.
-- Reads: any region serves normalized JOINs.
-- Writes: primary region only.
```

---

## SECTION 10 — Interview Q&A

### Beginner Questions

**Q1: What is normalization and what problem does it solve?**

Normalization is the process of structuring a relational database to reduce data redundancy and improve data integrity. It solves three anomalies that occur in flat, denormalized tables: (1) Update anomaly — if the same data is stored in multiple places, updating one copy leaves others stale; (2) Deletion anomaly — deleting a row can lose other unrelated data that was stored alongside it; (3) Insertion anomaly — you can't insert partial information without supplying all other unrelated columns. Normalization eliminates these by ensuring each fact is stored in exactly one place.

---

**Q2: What is the difference between 1NF, 2NF, and 3NF?**

**1NF** — First Normal Form: each column contains atomic (indivisible) values. No arrays or comma-separated lists in a single column. Each row is uniquely identifiable.

**2NF** — Second Normal Form: must be in 1NF plus no partial dependencies. In a table with a composite primary key, every non-key column must depend on the ENTIRE key, not just part of it.

**3NF** — Third Normal Form: must be in 2NF plus no transitive dependencies. No non-key column should depend on another non-key column. Every non-key attribute must depend directly on the primary key, nothing else.

---

**Q3: Why do we add indexes on foreign key columns?**

PostgreSQL does NOT automatically create indexes on foreign key columns (only the referenced primary key has an index). Without an index on the FK column, queries that JOIN on the FK or use it in a WHERE clause require a full sequential scan of the child table. For example, `SELECT * FROM orders WHERE user_id = 42` on a 10M row orders table without an index on `user_id` would scan all 10M rows. With the index: direct lookup in milliseconds. Additionally, FK constraint checks on INSERT/UPDATE look up the parent row — without an index on the FK column in the child table, ON DELETE operations on the parent are O(n) scans.

---

### Intermediate Questions

**Q4: When should you NOT normalize — when is partial denormalization appropriate?**

Denormalization is appropriate when: (1) read performance on a hot query path is consistently too slow despite proper indexing, and profiling confirms the JOIN is the bottleneck; (2) the column being denormalized is immutable or rarely changes (e.g., `price_at_order_time` in order_items); (3) the staleness cost of denormalized data is acceptable for the use case (e.g., cached counter in a dashboard). Denormalize the specific access pattern, not the whole schema. The rule: always start normalized, profile under production load, then denormalize precisely what's too slow. Never denormalize speculatively.

---

**Q5: What is BCNF and when does it apply beyond 3NF?**

Boyce-Codd Normal Form (BCNF) is a slightly stricter version of 3NF. A table is in BCNF if and only if every determinant (a column that determines another column's value) is a candidate key. 3NF allows non-candidate-key determinants if the dependent column is part of a candidate key. BCNF eliminates this exception. BCNF matters when a table has multiple overlapping candidate keys (composite keys that partially overlap). In practice, most 3NF schemas are already in BCNF. It becomes relevant in scheduling and assignment tables with complex multi-attribute keys.

---

### Advanced Questions

**Q6: How do you handle normalization in a microservices architecture where each service owns its own database?**

In microservices, normalization applies within each service's database boundary — not across services. A User service maintains a normalized users table. An Orders service has its own normalized orders tables. Cross-service joins are not possible (different databases). Instead, you denormalize strategically at service boundaries: Orders service stores `customer_email` (denormalized from Users) so it can send order confirmation emails without calling the User service. You accept that this denormalized copy can become stale and handle it via domain events (when User updates email, it publishes a `UserEmailChanged` event; Orders service updates its local copy). This is intentional cross-service denormalization with eventual consistency.

---

**Q7: A normalized schema is causing 300ms JOINs on a 5-table query. What is your diagnosis and fix strategy?**

First, run `EXPLAIN ANALYZE` on the query to identify which node is slow. Check: (1) Are all FK columns indexed? Missing FK index is the most common cause of slow normalized JOINs. (2) What are the estimated vs actual row counts? Large mismatch = stale statistics. Run `ANALYZE` on affected tables. (3) Which join algorithm is chosen? Hash Join with large hash tables may spill to disk — check `work_mem`. (4) Is there a Nested Loop with many iterations? Consider re-writing as a CTE or using `enable_nestloop = off` temporarily to diagnose. Only after exhausting index and statistics fixes should you consider denormalization. If denormalization is necessary: materialize a pre-joined view with `REFRESH CONCURRENTLY` — preserving the normalized source tables while serving the fast read.

---

## SECTION 11 — Debugging Exercise

### Production Incident: Tax Calculation Error at Month-End

**Scenario:**
Your SaaS billing system sends invoices on the 1st of each month. Finance reports that 3,400 invoices had incorrect tax amounts. Some showed 0% tax, some showed wrong rates. Total discrepancy: $2.3M in under-collected taxes. Regulators are involved.

**Initial investigation:**

```sql
-- Compare invoice tax vs current tax configuration:
SELECT
    i.id AS invoice_id,
    i.customer_id,
    i.tax_amount_cents,
    (i.subtotal_cents * t.rate / 100) AS expected_tax_cents,
    t.rate AS current_tax_rate,
    i.created_at
FROM invoices i
JOIN customers c ON c.id = i.customer_id
JOIN tax_rates t ON t.country_code = c.country_code
WHERE ABS(i.tax_amount_cents - (i.subtotal_cents * t.rate / 100)) > 100  -- >$1 discrepancy
  AND i.created_at >= '2024-01-01';
-- Returns: 3,400 rows with discrepancies.
```

**Finding the denormalization bug:**

```sql
-- Investigate the schema:
\d invoices
-- invoices table:
--   id, customer_id, subtotal_cents, tax_rate, tax_amount_cents, created_at
-- tax_rate column is STORED in invoices (denormalized copy from tax_rates table)

-- The bug: tax calculation at invoice generation time:
-- BAD application code:
def generate_invoice(customer_id, subtotal):
    customer = db.query("SELECT * FROM customers WHERE id = %s", customer_id)
    # BUG: reading current tax rate at time of invoice generation
    tax_rate = db.query("SELECT rate FROM tax_rates WHERE country = %s", customer.country)
    # But: invoice stores tax_rate as a column
    # When tax_rates.rate was updated (country tax change), historical invoices still
    # have old_tax_rate in their rows BUT the query now calculates expected tax with NEW rate.

-- The fix: invoices should NOT store raw tax_rate as a recalculated field.
-- They should store tax_amount_cents as an immutable snapshot calculated ONCE at invoice time.
-- The tax_rate column in invoices was used for re-calculation, creating a moving target.
```

**Root cause:**
The `tax_rate` column in `invoices` was a denormalized copy used for recalculation. When tax rates changed (5 countries changed VAT rates on Jan 1st), the live `tax_rates` table updated to new rates. The invoice validation code re-calculated `expected_tax` using the current (new) rate but compared it to amounts computed with the old rate — showing 3,400 "discrepancies" that were actually correct at time of billing.

**Normalization fix:**

```sql
-- Store taxes as immutable snapshot with explicit versioning:
CREATE TABLE tax_rate_snapshots (
    id          SERIAL PRIMARY KEY,
    country     TEXT NOT NULL,
    rate        NUMERIC(5,2) NOT NULL,
    effective_from DATE NOT NULL,
    effective_to   DATE,
    UNIQUE (country, effective_from)
);

ALTER TABLE invoices
    ADD COLUMN tax_rate_snapshot_id INTEGER REFERENCES tax_rate_snapshots(id);
-- Now: invoice stores which tax rate was in effect at billing time.
-- Historical re-calculation: uses snapshot, not current rate.
-- Tax audit: show exact rate in effect for each invoice. Defensible.
```

---

## SECTION 12 — Architect's Mental Model

### 5 Decision Rules

1. **Start in 3NF by default.** Every new table: ask "does every non-key column depend on the whole key, nothing but the key?" If no: split the table. 3NF is the baseline for correct data. Deviate intentionally with a documented reason.

2. **Every foreign key column needs an index.** PostgreSQL does not auto-index FK columns. For every `REFERENCES` in your schema: `CREATE INDEX ON child_table(fk_column_id)`. Run the un-indexed FK audit query monthly.

3. **Immutable point-in-time data should always be stored as a snapshot, not as a FK to a mutable table.** Price at order time, tax rate at invoice time, product name at review time: copy the value. Don't FK to a table that can change.

4. **Join performance issues: exhaustively try indexes before denormalizing.** The sequence: add missing FK indexes → run ANALYZE → increase work_mem for large joins → covering index for hot query columns. Only if performance is still unacceptable after all of these: denormalize that specific column.

5. **Document every intentional denormalization.** A comment in the schema, a README entry. Why it exists, what stays in sync, how. Undocumented denormalization becomes a maintenance trap for the next engineer.

---

### 3 Common Mistakes

**Mistake 1: Storing arrays of foreign keys as a TEXT column or ARRAY column.** Example: `tag_ids TEXT DEFAULT ''`. This destroys the ability to enforce referential integrity, query efficiently, or use indexes. Always use a junction table with proper PKs and FKs.

**Mistake 2: Over-normalizing to the point of unusability.** Splitting `address` into 6 tables (street, city, state, country, postal_code, address_type) creates 6-table JOINs for every customer query. 3NF: address belongs in the customer or order row unless addresses are shared across entities. Don't normalize things that don't have redundancy problems.

**Mistake 3: Equating "normalized" with "good" in all contexts.** DynamoDB, Cassandra, and data warehouses (Redshift) are intentionally denormalized. Knowing WHEN the normalized model is the right tool requires understanding your access patterns, consistency requirements, and query volume — not just applying 3NF everywhere.

---

### 30-Second Interview Answer

> "Normalization means storing each fact in exactly one place. The levels — 1NF: atomic values; 2NF: full key dependency in composite-key tables; 3NF: no transitive dependencies — progressively eliminate update, delete, and insertion anomalies. In production, I default to 3NF: single source of truth means a tax rate change updates one row, not millions of invoice rows. The most common mistake I see is missing indexes on FK columns, which is a silent performance killer. When a normalized JOIN is genuinely slow after proper indexing, I denormalize the specific column — but always as an immutable snapshot, never as a live FK to a mutable table."

---

_→ Next: [03-Denormalization.md](../20 - Denormalization/03-Denormalization.md)_
