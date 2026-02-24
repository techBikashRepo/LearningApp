# N+1 Query Problem — Part 1 of 3

### Sections: 1 (Intuition & Analogy), 2 (Why This Exists), 3 (Internal Working), 4 (Query Execution Flow)

**Series:** Databases & Data Modeling → Topic 24

---

## SECTION 1 — Intuition & Analogy

### The Librarian Who Fetches Books One by One

Imagine visiting a library to collect reading lists for 100 students. The efficient approach: "Give me all the books on reading lists for these 100 students" — one request, one trip to the stacks, all 100 reading lists returned together.

The N+1 approach: go to the librarian, ask for Student 1's reading list. Get it. Go back to the librarian, ask for Student 2's reading list. Get it. Go back... 100 times. 101 total trips (1 to get the list of students, then 1 per student).

**The N+1 query problem is this exact pattern applied to databases.** The application:

1. Executes 1 query to fetch N records ("get all orders").
2. Then executes N additional queries — one per record — to fetch related data ("get the customer for order 1", "get the customer for order 2", ... "get the customer for order N").

```
N = 1,000 orders loaded.
N+1 = 1,001 total queries:
  Query 1: SELECT * FROM orders WHERE status = 'pending'    → 1,000 rows
  Query 2: SELECT * FROM customers WHERE id = 1            → for order 1
  Query 3: SELECT * FROM customers WHERE id = 2            → for order 2
  ...
  Query 1001: SELECT * FROM customers WHERE id = 1000      → for order 1000

Each query: 1-2ms round-trip time.
Total: 1,001 × 1.5ms = 1,502ms ≈ 1.5 seconds for what could be a 5ms JOIN.
```

The problem: it's invisible until you reach scale. At 10 records: takes 15ms. Feels fine. At 10,000 records: takes 15 seconds. Production incident.

---

## SECTION 2 — Why This Problem Exists (Production Failures)

### Real-World Incidents: N+1 in Production

**Incident 1: API Endpoint — 12 Seconds for 200 Records**
Platform: e-commerce backend, Node.js + Sequelize ORM. Endpoint: `GET /admin/orders` — admin dashboard listing recent orders with customer names. ORM code: `Order.findAll({ where: { status: 'pending' } })` — loaded 200 orders. Then for each order: `order.getCustomer()` — a separate query. Production: 201 queries. Average query latency: 60ms (overloaded DB plus connection pool contention). Total endpoint time: 201 × 60ms = 12,060ms. Admin dashboard: completely unusable.

Root cause: Sequelize lazy-loading. `getCustomer()` is a promise that executes a separate SELECT per call. Developer tested with 5 rows; didn't notice the linear scaling.

Fix: `Order.findAll({ include: [{ model: Customer }] })` → generates a JOIN. 1 query instead of 201. Endpoint time: 180ms.

---

**Incident 2: Rendering Blog — 1,200 Queries Per Page Load**
Platform: content management system, PHP. Page: "blog with 12 recent posts, each showing author name, category, and tag list." Code: loop over 12 posts. For each post: fetch author (1 query), fetch category (1 query), fetch tags (1 query). Total: 12 × 3 = 36 extra queries + 1 initial = 37 queries for 12 posts. At scale (100 listed posts): 301 queries. Shared database with 18 other sites: 301 queries × concurrent users = database saturation. Site down at 800 concurrent users.

Fix: `SELECT posts.*, authors.*, categories.* FROM posts JOIN ... JOIN ...` + separate tags query with `WHERE post_id IN (...)`. 2 queries for all 100 posts.

---

**Incident 3: Mobile App — Battery Drain and Slow Sync**
Platform: React Native mobile app with GraphQL API. GraphQL resolver: `posts` resolver didn't batch resolver calls. Each `Post.author` field resolver executed: `User.findById(post.authorId)`. At 50 posts in feed: 51 GraphQL resolvers fired, 51 database queries. Mobile battery drain: each query required network roundtrip. User sessions took 8 seconds to load feed. 40% of users abandoned before feed loaded.

Fix: DataLoader batching. All `User.findById(id)` calls within one tick: batched into one `SELECT * FROM users WHERE id IN (ids...)`. 51 queries → 2 queries.

---

## SECTION 3 — Internal Working

### Why ORMs Generate N+1 and How to Detect Them

**The ORM lazy-loading mechanism:**

```python
# Python SQLAlchemy example:
# Lazy loading (default — N+1 generator):
orders = session.query(Order).filter(Order.status == 'pending').all()
# SQL: SELECT * FROM orders WHERE status = 'pending'  → returns 500 rows

for order in orders:
    print(order.customer.name)   # ← accesses the relationship
    # SQLAlchemy: fires a new query for each access:
    # SQL: SELECT * FROM customers WHERE id = {order.customer_id}
    # × 500 orders = 500 additional queries
# Total: 501 queries. N+1 problem.

# Eager loading (fix):
orders = session.query(Order).options(joinedload(Order.customer)).filter(...).all()
# SQL: SELECT orders.*, customers.*
#      FROM orders JOIN customers ON customers.id = orders.customer_id
#      WHERE orders.status = 'pending'
# 1 query. N relationships loaded in the same round trip.

# Sub-query load (alternative for large datasets where JOINs multiply rows):
orders = session.query(Order).options(subqueryload(Order.items)).filter(...).all()
# SQL 1: SELECT * FROM orders WHERE status = 'pending'
# SQL 2: SELECT * FROM order_items WHERE order_id IN (1,2,3,...500)
# 2 queries. No row multiplication from 1:many JOIN.
```

---

**The IN-clause batching pattern (DataLoader):**

```javascript
// JavaScript DataLoader pattern (used in GraphQL):
const userLoader = new DataLoader(async (userIds) => {
  // userIds: array of all IDs requested within one event loop tick
  const users = await db.query("SELECT * FROM users WHERE id = ANY($1)", [
    userIds,
  ]);
  // Return in same order as requested:
  return userIds.map((id) => users.find((u) => u.id === id));
});

// In GraphQL resolvers:
const resolvers = {
  Post: {
    author: (post) => userLoader.load(post.authorId),
    // 50 posts: 50 calls to userLoader.load()
    // DataLoader: batches all 50 into one SQL query at end of tick
    // SQL: SELECT * FROM users WHERE id = ANY(ARRAY[1,2,3,...50])
    // 50 calls → 1 SQL query
  },
};
```

---

**Detection: counting queries in development:**

```python
# SQLAlchemy query counter:
import sqlalchemy.event as event
query_count = 0

@event.listens_for(engine, "before_cursor_execute")
def count_queries(conn, cursor, statement, parameters, context, executemany):
    global query_count
    query_count += 1

# Test N+1 detection:
query_count = 0
load_orders_page(page=1)
print(f"Queries executed: {query_count}")
# Expected: 2-5. If > 50: N+1 problem detected.
```

```sql
-- PostgreSQL: detect N+1 in production via pg_stat_statements:
SELECT query, calls, mean_exec_time,
       calls / (SELECT COUNT(*) FROM orders WHERE status='pending') AS calls_per_order
FROM pg_stat_statements
WHERE query LIKE '%SELECT%customers%WHERE id%'
  AND calls > 1000
ORDER BY calls DESC;
-- If "SELECT * FROM customers WHERE id = $1" has 50,000 calls per hour
-- while "SELECT * FROM orders WHERE status = $1" has 100 calls per hour:
-- ratio = 500 queries per order list load → N+1 confirmed.
```

---

## SECTION 4 — Query Execution Flow

### N+1 vs JOIN vs IN-batch: Execution Comparison

**Scenario:** load 100 orders and their customers. 10M orders table, 1M customers table.

```sql
-- N+1 pattern: 101 separate queries
-- Query 1:
SELECT id, customer_id, total_cents FROM orders WHERE status = 'pending' LIMIT 100;
-- → returns 100 rows, each round-trip: 1.2ms
-- Query 2-101 (one per order):
SELECT id, name, email FROM customers WHERE id = $1;
-- × 100 = 100 queries × 1.2ms = 120ms
-- Total: 121.2ms (network round-trips dominate)
-- Real-world with connection pool contention: 800ms+

-- JOIN pattern: 1 query
SELECT o.id, o.total_cents, c.id AS cust_id, c.name, c.email
FROM orders o
JOIN customers c ON c.id = o.customer_id
WHERE o.status = 'pending'
LIMIT 100;

-- Execution plan:
-- Limit (rows=100)
--   Hash Join (cost=1200..8800 rows=100)
--     Hash Cond: (o.customer_id = c.id)
--     → Index Scan on orders (status='pending') using idx_orders_status → 100 rows
--     → Hash on customers: build hash table of customers matching the 100 IDs
--        (PostgreSQL: batched_inner_join with 100-element hash)
-- Execution time: 4.8ms. 25x faster.
-- Rows transmitted to application: 100 (not 100 + 100 separate responses)

-- IN-batch pattern: 2 queries (best for 1:many relationships)
-- Query 1: fetch orders
SELECT id, customer_id, total_cents FROM orders WHERE status = 'pending' LIMIT 100;
-- → 100 rows. Extract customer_ids: [1,3,7,8,9,...100 unique IDs]

-- Query 2: batch fetch all needed customers
SELECT id, name, email FROM customers WHERE id = ANY(ARRAY[1,3,7,8,9,...]);
-- Index Scan using customers_pkey → exact lookups for 100 IDs
-- Execution time: 2.1ms (100 PK lookups vs hash join overhead)
-- Total: 1.2ms + 2.1ms = 3.3ms. Slightly faster than JOIN for this shape.

-- When to use JOIN vs IN-batch:
-- JOIN: when you need columns from both tables in a WHERE/ORDER BY.
-- IN-batch: when the parent query is complex and you want to avoid JOIN row multiplication
--           (especially for 1:many: JOIN creates N×M rows, IN-batch returns M separately).
```
