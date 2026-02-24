# Denormalization — Part 1 of 3

### Sections: 1 (Intuition & Analogy), 2 (Why This Exists), 3 (Internal Working), 4 (Query Execution Flow)

**Series:** Databases & Data Modeling → Topic 20

---

## SECTION 1 — Intuition & Analogy

### The Pre-Computed Cheat Sheet

A student studying for an exam from a perfectly normalized textbook would need to cross-reference dozens of chapters to answer a single question. So before the exam, they create a "cheat sheet" — a single page that combines the key facts from many chapters in the exact format needed to answer exam questions quickly.

The cheat sheet is redundant — all information already exists in the textbook. But for the exam (a time-constrained read operation), the cheat sheet is vastly faster than the textbook.

**Denormalization is creating database cheat sheets.** You deliberately store redundant, pre-combined, or pre-aggregated data to make reads faster — at the cost of more complex writes and the risk of the cheat sheet going stale.

```
Normalized (textbook):
  orders table: order_id, customer_id, ordered_at
  order_items: order_id, product_id, quantity
  products: product_id, name, price_cents

  To show an order summary: 3-table JOIN every time.
  At 50,000 requests/second: 150,000 table accesses per second just for order summaries.

Denormalized (cheat sheet):
  order_summaries table:
    order_id | customer_name | total_items | total_price_cents | status | last_updated_at

  To show an order summary: single row lookup by order_id.
  At 50,000 requests/second: 50,000 table accesses. 3x reduction.
  Cost: every time an order is updated, this summary row must also be updated.
```

The fundamental trade-off: **write complexity and data consistency risk in exchange for read performance.** The right answer depends entirely on your read:write ratio and your consistency requirements.

---

## SECTION 2 — Why This Problem Exists (Production Failures)

### Real-World Incidents: When Normalization Hits the Wall

**Incident 1: Social Platform — Profile Page Rendering at 100M Users**
Platform: social network, 100M active users. Problem: user profile page required counting followers, following, posts, and total likes across 4 normalized tables. Each profile page load: 4 aggregate COUNT queries. At 5M profile views/second during peak: 20M COUNT queries/second hitting a normalized schema. Average COUNT query on 100M-row tables: 800ms. Database CPU: 100%. Site: effectively down.

Fix: denormalized `user_stats` table with `follower_count`, `following_count`, `post_count` maintained via triggers and background jobs. Profile page load: single row lookup, 2ms. 400x improvement.

---

**Incident 2: Analytics Dashboard — 3-Second Load Time Blocking Product**
Platform: B2B SaaS analytics dashboard. Problem: "Sales Summary" widget ran 6 JOINs across 4 billion rows at query time. Every dashboard load: 3-4 seconds. Sales team was using Excel exports instead of the live dashboard. Product team: "the dashboard is unusable."

Fix: materialized view refreshed every 5 minutes. Dashboard loads: <100ms. Sales team: adopted the dashboard. Annual contract renewal rate improved.

---

**Incident 3: E-commerce — Search Latency from 8 Joined Tables**
Platform: marketplace, 50M products. Product search returned results enriched with seller name, rating, shipping speed, discount percentage — all from different tables. JOIN-based approach: 8-table join, 400-800ms per search. Users: abandoning search after 1 second.

Fix: denormalized search index table with all display fields pre-computed. Search query: single table scan + filter. 15-25ms. Conversion rate: +18%.

---

**Incidents where OVER-denormalization caused problems:**

**Incident 4: Cache Stampede from Stale Denormalized Data**
Platform: ticket booking. Denormalized `available_seats` column on events table. When a seat was booked, a background job updated `available_seats`. Background job: running every 30 seconds. During a popular event sale: the `available_seats` column showed 50 available for 28 seconds after actual availability reached 0. 4,200 users completed purchases for seats that didn't exist. 100% had to be refunded with $25 vouchers ($105K compensation).

Root cause: denormalized column was stale. Real-time accuracy required the normalized count.

---

## SECTION 3 — Internal Working

### Denormalization Techniques

**Technique 1: Redundant Columns (Inline Summary)**
Store computed or related values directly in the row:

```sql
-- Normalized: to get customer's country for an order, join customers → addresses → countries.
-- Denormalized: store country_code directly on orders:
ALTER TABLE orders ADD COLUMN customer_country_code CHAR(2);
-- Written at order creation. Never changes. No JOIN needed.
-- Cost: extra 2 bytes per row. Benefit: eliminates join for 50M order rows.

-- Triggered maintenance:
CREATE OR REPLACE FUNCTION denorm_order_country() RETURNS TRIGGER AS $$
BEGIN
  NEW.customer_country_code := (
    SELECT country_code FROM customers c
    JOIN addresses a ON a.customer_id = c.id
    WHERE c.id = NEW.customer_id
    LIMIT 1
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_order_country_fill
BEFORE INSERT ON orders
FOR EACH ROW EXECUTE FUNCTION denorm_order_country();
```

---

**Technique 2: Counter Caches**
Store running aggregates to avoid COUNT queries:

```sql
CREATE TABLE users (
    id           BIGINT PRIMARY KEY,
    username     TEXT UNIQUE NOT NULL,
    follower_count    INTEGER NOT NULL DEFAULT 0,  -- denormalized counter
    following_count   INTEGER NOT NULL DEFAULT 0,
    post_count        INTEGER NOT NULL DEFAULT 0
);

-- Maintain atomically:
-- When a follow is created:
UPDATE users SET follower_count = follower_count + 1 WHERE id = $followed_id;
UPDATE users SET following_count = following_count + 1 WHERE id = $follower_id;

-- Atomic and consistent: updated in the same transaction as the follows INSERT.
-- Profile page: SELECT follower_count FROM users WHERE id = $id → single row lookup, 1ms.

-- Risk: counter drift from bugs or crashes between the follow INSERT and the counter UPDATE.
-- Mitigation: nightly reconciliation job:
UPDATE users u
SET follower_count = (SELECT COUNT(*) FROM follows WHERE followed_id = u.id)
WHERE follower_count != (SELECT COUNT(*) FROM follows WHERE followed_id = u.id);
```

---

**Technique 3: Materialized Views**
PostgreSQL-native: execute a query once, store the result set as a physical table:

```sql
CREATE MATERIALIZED VIEW order_summary_mv AS
SELECT
    o.id AS order_id,
    c.name AS customer_name,
    c.email AS customer_email,
    SUM(oi.quantity * p.price_cents) AS total_cents,
    COUNT(DISTINCT oi.product_id) AS distinct_products,
    o.ordered_at,
    o.status
FROM orders o
JOIN customers c    ON c.id = o.customer_id
JOIN order_items oi ON oi.order_id = o.id
JOIN products p     ON p.id = oi.product_id
GROUP BY o.id, c.name, c.email, o.ordered_at, o.status
WITH DATA;  -- populate immediately

CREATE UNIQUE INDEX ON order_summary_mv(order_id);  -- for fast lookups

-- Refresh strategies:
REFRESH MATERIALIZED VIEW CONCURRENTLY order_summary_mv;
-- CONCURRENTLY: allows reads during refresh (requires unique index).
-- Schedule: pg_cron, external scheduler, or after key write transactions.
```

---

**Technique 4: Summary/Rollup Tables**
Pre-aggregated analytics data:

```sql
CREATE TABLE daily_revenue (
    revenue_date    DATE NOT NULL,
    product_id      INTEGER REFERENCES products NOT NULL,
    total_orders    INTEGER NOT NULL DEFAULT 0,
    total_revenue   BIGINT NOT NULL DEFAULT 0,  -- in cents
    PRIMARY KEY (revenue_date, product_id)
);

-- Updated at end of each day via batch job or trigger:
INSERT INTO daily_revenue (revenue_date, product_id, total_orders, total_revenue)
SELECT
    DATE(ordered_at) AS revenue_date,
    oi.product_id,
    COUNT(DISTINCT o.id),
    SUM(oi.quantity * p.price_cents)
FROM orders o
JOIN order_items oi ON oi.order_id = o.id
JOIN products p      ON p.id = oi.product_id
WHERE DATE(ordered_at) = CURRENT_DATE - 1
GROUP BY DATE(ordered_at), oi.product_id
ON CONFLICT (revenue_date, product_id) DO UPDATE
SET total_orders = EXCLUDED.total_orders,
    total_revenue = EXCLUDED.total_revenue;

-- Query: "revenue for last 30 days by product"
-- Normalized: scan 4 billion row orders table + joins. Hours.
-- Denormalized: scan 30 × N_products rows in daily_revenue. Milliseconds.
```

---

## SECTION 4 — Query Execution Flow

### Normalized vs Denormalized Query Plan Comparison

**Scenario:** "Get top 10 products by revenue in the last 7 days"

```sql
-- NORMALIZED QUERY (no summary table):
EXPLAIN ANALYZE
SELECT p.name, SUM(oi.quantity * p.price_cents) AS revenue
FROM orders o
JOIN order_items oi ON oi.order_id = o.id
JOIN products p     ON p.id = oi.product_id
WHERE o.ordered_at >= NOW() - INTERVAL '7 days'
GROUP BY p.id, p.name
ORDER BY revenue DESC
LIMIT 10;

-- Execution plan on 500M row orders + 2B row order_items:
-- Limit  (actual time=34,291..34,291 rows=10)
--   Sort  (actual time=34,280..34,281 rows=10)
--     HashAggregate  (actual time=20,100..20,800 rows=80,000)
--       Hash Join on products  (actual time=1,200..18,000)
--         Hash Join on order_items  (actual time=800..15,000)
--           Index Scan on orders (ordered_at >= ...)  → 40M rows returned in 7 days
--           Seq Scan on order_items (40M rows worth)
--         Seq Scan on products (small)
-- Execution time: 34.3 seconds. Unusable for live dashboards.

-- DENORMALIZED QUERY (using daily_revenue summary table):
EXPLAIN ANALYZE
SELECT p.name, SUM(dr.total_revenue) AS revenue
FROM daily_revenue dr
JOIN products p ON p.id = dr.product_id
WHERE dr.revenue_date >= CURRENT_DATE - 7
GROUP BY p.id, p.name
ORDER BY revenue DESC
LIMIT 10;

-- Execution plan:
-- Limit  (actual time=8.2..8.2 rows=10)
--   Sort  (actual time=8.1..8.1 rows=10)
--     HashAggregate  (actual time=7.1..7.8 rows=80,000)
--       Hash Join on products  (actual time=0.4..4.2)
--         Index Scan on daily_revenue (revenue_date >= ...)
--           → 7 × 80,000 products = 560,000 rows (vs 2 BILLION)
--         Seq Scan on products
-- Execution time: 8.2ms. Production-ready.

-- Improvement: 34,300ms → 8ms = 4,287x faster.
-- Trade-off: daily_revenue table must be maintained correctly.
--            7-day window has at most 1-day stale data (acceptable for a dashboard).
```
