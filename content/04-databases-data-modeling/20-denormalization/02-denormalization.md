# Denormalization — Part 2 of 3

### Sections: 5 (Bad vs Correct Usage), 6 (Performance Impact), 7 (Concurrency & Data Integrity), 8 (Optimization & Indexing)

**Series:** Databases & Data Modeling → Topic 20

---

## SECTION 5 — Bad Usage vs Correct Usage

### Common Denormalization Anti-Patterns

**Anti-Pattern 1: Denormalizing mutable data without a sync mechanism**

```sql
-- BAD: product price embedded in order_items WITHOUT capturing price at time of order
CREATE TABLE order_items (
    order_id    INTEGER,
    product_id  INTEGER,
    qty         INTEGER,
    -- No price stored here — relies on joining to products.price_cents
    PRIMARY KEY (order_id, product_id)
);
-- Problem 1: if product price changes, historical order totals change → wrong.
-- Problem 2: JOIN required for every order total calculation.

-- Also BAD: storing current product name in order_items (mutable data that changes):
CREATE TABLE order_items (
    order_id      INTEGER,
    product_id    INTEGER,
    product_name  TEXT,   -- ← DENORMALIZED: gets stale when product is renamed
    qty           INTEGER
);
-- When product is renamed: all historical order_items show wrong name.
-- "Your order contained 'Widget Pro 2.0'" — but you ordered 'Widget Pro'. Confusing.

-- CORRECT: capture immutable snapshot at write time + FK for live data:
CREATE TABLE order_items (
    order_id         INTEGER,
    product_id       INTEGER REFERENCES products,
    qty              INTEGER NOT NULL,
    unit_price_cents INTEGER NOT NULL,  -- ← price at time of order: intentional immutable snapshot
    -- product_name NOT stored: join to products for current name,
    --   accept that historical display shows current product name (usually correct behavior)
    PRIMARY KEY (order_id, product_id)
);
-- unit_price intentionally denormalized: it should NOT change when product price changes.
-- product_id FK: still maintained for referential integrity and current product data.
```

---

**Anti-Pattern 2: Counter cache without atomic update**

```sql
-- BAD: non-atomic counter update (read-compute-write pattern):
-- Application code:
user = db.execute("SELECT * FROM users WHERE id = 42").fetchone()
new_count = user.follower_count + 1
db.execute("UPDATE users SET follower_count = %s WHERE id = 42", [new_count])
-- Race condition: two concurrent follows both read follower_count = 5, both write 6.
-- One follow is lost. Counter drifts from reality.

-- CORRECT: atomic increment:
db.execute("UPDATE users SET follower_count = follower_count + 1 WHERE id = 42")
-- Single statement: read-and-increment is atomic in PostgreSQL.
-- No race. No drift.

-- Also CORRECT: update counter IN THE SAME TRANSACTION as the follow INSERT:
BEGIN;
INSERT INTO follows (follower_id, followed_id) VALUES (99, 42);
UPDATE users SET follower_count = follower_count + 1 WHERE id = 42;
COMMIT;
-- Both committed atomically. Counter increases by exactly 1 per real follow.
-- If either fails: both rolled back. Perfect consistency.
```

---

**Anti-Pattern 3: Materialized view without CONCURRENTLY — blocking reads**

```sql
-- BAD: REFRESH without CONCURRENTLY on a view used by live queries
REFRESH MATERIALIZED VIEW order_summary_mv;
-- Takes: ExclusiveLock on the materialized view.
-- Blocks: ALL reads from the view during refresh.
-- Refresh time: 30 seconds on 500M rows.
-- Effect: dashboard blank / error for 30 seconds during every refresh.

-- CORRECT: always use CONCURRENTLY for live views:
REFRESH MATERIALIZED VIEW CONCURRENTLY order_summary_mv;
-- Requires: a UNIQUE index on the view.
-- Behavior: computes new data in a temp table, swaps rows, releases lock per batch.
-- Reads: continue during refresh (reads slightly stale data until refresh completes).
-- Lock: ShareUpdateExclusiveLock — allows concurrent reads and single-row writes.
-- Same 30 seconds: users see view data, never a blank screen.

-- Required setup for CONCURRENTLY:
CREATE UNIQUE INDEX ON order_summary_mv(order_id);  -- must exist
```

---

**CORRECT Pattern: denormalization with explicit staleness contract**

```sql
-- Dashboard summary table with explicit staleness metadata:
CREATE TABLE daily_stats (
    stat_date       DATE PRIMARY KEY,
    total_orders    INTEGER,
    total_revenue   BIGINT,
    refreshed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- UI shows: "Last updated: 5 minutes ago".
-- User expectation: set correctly. "Approximate, not real-time."
-- No user confusion about stale data because the staleness is explicit and communicated.
```

---

## SECTION 6 — Performance Impact

### Benchmarking Denormalization Patterns

```
Test: "Top 10 products by revenue, last 30 days" on 10B row events/order system.
Setup: PostgreSQL 15, 64GB RAM. Normalized vs 3 denormalization strategies.

NORMALIZED (runtime aggregation across raw tables):
  Query: 5-table JOIN + GROUP BY + ORDER BY + LIMIT 10
  Execution time: 340 seconds (5.7 minutes). Run once nightly max.

DENORMALIZED — Materialized View (refreshed every hour):
  Query: SELECT FROM mv WHERE date_range LIMIT 10
  Execution time: 180ms.
  Refresh time: 4 minutes (runs CONCURRENTLY, reads unblocked during refresh).
  Staleness: up to 1 hour.

DENORMALIZED — Summary Table (batch-written every 15 minutes):
  Query: SELECT FROM daily_revenue WHERE ... GROUP BY ... LIMIT 10
  Execution time: 8ms.
  Refresh time: 90 seconds (incremental: only yesterday's data).
  Staleness: up to 15 minutes.

DENORMALIZED — Counter Cache (real-time inline update):
  Maintained via triggers/transactions.
  Query: SELECT revenue_today FROM product_stats WHERE product_id = $x
  Execution time: 0.5ms (single PK lookup).
  Staleness: 0 (real-time).
  Cost: every INSERT/UPDATE to order_items triggers a counter update.
       Write overhead: +15-25% on order_items writes.

Choosing strategy by use case:
  Real-time dashboard: Counter Cache (accept write overhead).
  Near-real-time (5-15 min): Summary Table.
  Hourly refresh acceptable: Materialized View.
  Historical/analytics: Normalized (batch daily jobs, not user-facing).
```

---

**Counter cache write overhead measurement:**

```
Table: posts (1M rows). followers (50M rows). likes (200M rows).
Scenario: adding/removing follower triggers follower_count update on users table.

Without counter cache:
  Follow INSERT: 0.8ms (just the follows row).
  Unfollow DELETE: 0.6ms.
  "User profile follower count": SELECT COUNT(*) FROM follows WHERE followed_id = $x
    → 150ms on 50M follows (no index on followed_id → added index → 3ms).

With counter cache + atomic UPDATE:
  Follow INSERT: 0.8ms + 0.7ms (counter UPDATE) = 1.5ms. 88% write overhead per follow.
  Unfollow DELETE: 1.3ms.
  "User profile follower count": SELECT follower_count FROM users WHERE id = $x → 0.3ms.

  Trade-off: 88% write overhead per follow operation (0.7ms absolute).
  Gain: profile loads 10x faster.
  At 100K follows/second: 70 seconds of extra write time per 100K operations.
  At 50 profile loads/follow (ratio): 50 × 2.7ms saved / 0.7ms cost = 193x more latency saved than added.
  Worth it. Clear positive ROI.
```

---

## SECTION 7 — Concurrency & Data Integrity

### Maintaining Consistency in Denormalized Data

**Counter cache drift prevention:**

```sql
-- Problem: counter drift occurs when:
-- 1. Bug in counter update code missed a case.
-- 2. Server crash between INSERT and counter UPDATE (even in same transaction: impossible if atomic).
-- 3. Direct database changes bypassing application code.

-- Mitigation: nightly reconciliation job:
WITH accurate_counts AS (
    SELECT followed_id AS user_id, COUNT(*) AS real_count
    FROM follows
    GROUP BY followed_id
)
UPDATE users u
SET follower_count = ac.real_count
FROM accurate_counts ac
WHERE u.id = ac.user_id
  AND u.follower_count != ac.real_count;  -- only update drifted rows
-- Report count of rows updated: if > 0 on any day → investigation needed.
-- Schedule: nightly 2am, low traffic window.
```

---

**Materialized view consistency under concurrent writes:**

```sql
-- During REFRESH MATERIALIZED VIEW CONCURRENTLY:
-- The view serves old data until the refresh completes.
-- Application behavior requirement: tolerate up to N minutes of stale data.
-- If a user inserts an order and immediately loads the dashboard:
--   the new order may not appear in the MV for up to refresh_interval.
-- Application must communicate this: "Dashboard data is updated every 15 minutes."

-- For stronger consistency: don't use MV. Use live aggregates on smaller, indexed tables.
-- For analytics dashboards: MV staleness is always an acceptable trade-off.

-- CONFLICT between REFRESH and DDL on the view:
-- REFRESH MATERIALIZED VIEW needs ExclusiveLock for non-CONCURRENTLY.
-- ALTER TABLE underlying_table also needs ExclusiveLock.
-- Avoid: schema changes during scheduled MV refresh windows.
-- Recommendation: maintenance window for DDL changes on heavily-refreshed MVs.
```

---

## SECTION 8 — Optimization & Indexing

### Indexing Denormalized Structures

```sql
-- Materialized view: index every column used in WHERE or JOIN:
CREATE MATERIALIZED VIEW order_summary_mv AS
SELECT o.id, c.id AS customer_id, c.name, c.email,
       o.status, o.ordered_at,
       SUM(oi.qty * oi.unit_price) AS total_cents
FROM orders o JOIN customers c ON c.id = o.customer_id
              JOIN order_items oi ON oi.order_id = o.id
GROUP BY o.id, c.id, c.name, c.email, o.status, o.ordered_at
WITH DATA;

-- Required for CONCURRENTLY:
CREATE UNIQUE INDEX ON order_summary_mv(id);

-- Additional query-serving indexes:
CREATE INDEX ON order_summary_mv(customer_id, ordered_at DESC);
CREATE INDEX ON order_summary_mv(status, ordered_at DESC);
CREATE INDEX ON order_summary_mv(ordered_at DESC);
-- These allow the MV to serve multiple query patterns efficiently.

-- Summary table partition strategy:
CREATE TABLE daily_revenue (
    revenue_date    DATE NOT NULL,
    product_id      INTEGER NOT NULL,
    total_revenue   BIGINT,
    PRIMARY KEY (revenue_date, product_id)
) PARTITION BY RANGE (revenue_date);

-- Monthly partitions:
CREATE TABLE daily_revenue_2024_01 PARTITION OF daily_revenue
    FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');
-- Query for "last 7 days": partition pruning accesses only current-month partition.
-- Old partitions: can be moved to cold storage (tablespace) without affecting performance.

-- Refresh monitoring:
CREATE TABLE mv_refresh_log (
    view_name   TEXT,
    started_at  TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    rows_updated INTEGER
);
-- After each refresh: INSERT timing data.
-- Monitor: if refresh time > half the refresh interval → reduce scope or increase hardware.
```
