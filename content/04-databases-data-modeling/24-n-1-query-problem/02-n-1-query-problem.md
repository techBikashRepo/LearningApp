# N+1 Query Problem — Part 2 of 3

### Sections: 5 (Bad vs Correct Usage), 6 (Performance Impact), 7 (Concurrency & Data Integrity), 8 (Optimization & Indexing)

**Series:** Databases & Data Modeling → Topic 24

---

## SECTION 5 — Bad Usage vs Correct Usage

### Common N+1 Anti-Patterns

**Anti-Pattern 1: ORM default lazy loading**

```python
# BAD: SQLAlchemy default lazy loading
class User(Base):
    posts = relationship("Post")  # default: lazy="select" (lazy loading)

# Application code:
users = session.query(User).limit(100).all()  # Query 1: SELECT * FROM users LIMIT 100
for user in users:
    print(user.posts)  # Query 2, 3, 4... 101: SELECT * FROM posts WHERE user_id = $x
# Total: 101 queries. Each 0.8ms. Total: 80.8ms for 100 users.

# CORRECT: declare eager loading relationship:
class User(Base):
    posts = relationship("Post", lazy="joined")  # or lazy="subquery"

# OR: per-query eager loading override:
users = session.query(User).options(joinedload(User.posts)).limit(100).all()
# Query 1: SELECT users.*, posts.* FROM users JOIN posts ... LIMIT 100
# Total: 1 query. 4.8ms. 17x faster.
```

---

**Anti-Pattern 2: Django ORM N+1 — forgetting `select_related` / `prefetch_related`**

```python
# BAD: Django lazy loading
posts = Post.objects.filter(published=True)[:100]
for post in posts:
    print(post.author.name)    # N queries: SELECT * FROM users WHERE id = $author_id
    print(post.category.name)  # N more queries: SELECT * FROM categories WHERE id = $cat_id
# Total: 1 + 100 + 100 = 201 queries.

# CORRECT: select_related for FK/OneToOne (SQL JOIN):
posts = Post.objects.filter(published=True).select_related('author', 'category')[:100]
# 1 query with JOINs. Author and category loaded in the same SQL.

# CORRECT: prefetch_related for reverse FK / M2M (separate batch query):
posts = Post.objects.filter(published=True).prefetch_related('tags')[:100]
# Query 1: SELECT * FROM posts WHERE published = TRUE LIMIT 100
# Query 2: SELECT * FROM tags WHERE post_id IN (1, 2, 3, ... 100)  ← 1 query for all tags
# Total: 2 queries vs 101. Correct.
```

---

**Anti-Pattern 3: GraphQL resolvers without DataLoader**

```javascript
// BAD: GraphQL resolver fetches parent for each child
const resolvers = {
  Post: {
    author: async (post) => {
      // Called once per post. For 100 posts: 100 separate DB queries.
      return await User.findById(post.authorId);
    },
  },
};

// CORRECT: DataLoader batches within a single request tick
const DataLoader = require("dataloader");
const userLoader = new DataLoader(async (userIds) => {
  // Called ONCE per tick with ALL collected IDs:
  const users = await db.query("SELECT * FROM users WHERE id = ANY($1)", [
    userIds,
  ]);
  // Must return in same order as userIds array:
  return userIds.map((id) => users.find((u) => u.id === id));
});

const resolvers = {
  Post: {
    author: (post) => userLoader.load(post.authorId), // batched automatically
  },
};
// For 100 posts: 1 IN-clause query for 100 user IDs. Not 100 separate queries.
```

---

**Anti-Pattern 4: "It works in dev" — small dataset hides N+1**

```python
# Development: users table has 5 rows.
# N+1 loop issues 6 queries: 5 * 1ms = 5ms total. "Fast enough."
# Production: users table has 5,000 rows.
# N+1 loop issues 5,001 queries: 5,000 * 1ms = 5,000ms total. Page timeout.

# Detection must happen in development, not production.
# Tool (Python): sqlalchemy-query-counter or similar.
# Tool (Django): django-silk or django-debug-toolbar.
# Tool (Rails): bullet gem.

# The N+1 detection principle: if query count scales with result count, it's N+1.
# 5 users → 6 queries (N+1).
# 5,000 users → 5,001 queries (N+1, but now your page times out).
```

---

## SECTION 6 — Performance Impact

### N+1 Benchmarks Across Scale

```
Table: orders (500K rows), users (50K rows).
Query: "Get 100 most recent orders with customer name."

Strategy 1: N+1 (application loop)
  Query 1: SELECT * FROM orders ORDER BY created_at DESC LIMIT 100     → 100 rows
  Queries 2-101: SELECT name FROM users WHERE id = $x (once per order)  → 100 queries
  Total: 101 queries
  Total time: 0.4ms (orders query) + 100 × 1.2ms (user lookups) = 120.4ms
  Connection pool usage: 101 round trips (TCP overhead accumulates)

Strategy 2: JOIN (1 query)
  SELECT o.*, u.name FROM orders o
  JOIN users u ON u.id = o.user_id
  ORDER BY o.created_at DESC LIMIT 100
  Total: 1 query
  Total time: 4.8ms
  Improvement: 25x faster.

Strategy 3: IN-batch (2 queries)
  Query 1: SELECT * FROM orders ORDER BY created_at DESC LIMIT 100
  Query 2: SELECT id, name FROM users WHERE id = ANY($1::int[])  -- 100 IDs as array
  Total: 2 queries
  Total time: 0.4ms + 2.9ms = 3.3ms
  Improvement: 36x faster than N+1.

At 1,000 records:
  N+1:      1,001 queries × 1.2ms = 1,201ms  (20 seconds at 1K records = page timeout)
  JOIN:     1 query = 15ms
  IN-batch: 2 queries = 18ms
  At scale: JOIN/batch = 80x faster.

Connection pool exhaustion risk:
  App server: 20 connection pool size.
  20 concurrent requests each issuing N+1 (100 records):
    Each request: 101 queries in series.
    Each query: holds connection for 1.2ms.
    Effective connection time per request: 121ms.
    Pool exhaustion: waiting requests queue up, latency p99 → 10+ seconds.
```

---

**Detecting N+1 in production via pg_stat_statements:**

```sql
-- N+1 signature: same parameterized query with very high call count
SELECT
    query,
    calls,
    mean_exec_time,
    calls * mean_exec_time AS total_time_ms
FROM pg_stat_statements
WHERE query ILIKE '%FROM users WHERE id%'
ORDER BY calls DESC
LIMIT 10;

-- N+1 signal:
-- query: SELECT * FROM users WHERE id = $1
-- calls: 847,293   ← suspiciously high for a single-row lookup
-- mean_exec_time: 1.1ms
-- total_time_ms: 932,022ms (15.5 minutes of DB time in one hour!)

-- Compare call_ratio to expected:
-- If users table has 50K rows and app handles 10K requests/hour:
--   Expected: 10K calls to the user query (one per request).
--   Actual: 847K calls = 84.7 per request on average. Classic N+1.
```

---

## SECTION 7 — Concurrency & Data Integrity

### N+1 Under Load — Amplification Effects

```sql
-- Connection pool starvation under N+1 load:
-- Pool size: 20 connections.
-- Traffic: 50 concurrent users.
-- N+1 per request: 100 queries (100 record page, 1 user lookup each).
-- Each connection: held for duration of the N+1 chain.
-- Effective hold time: 100 × 1ms round trip = 100ms per request.
-- Available parallelism: 20 connections / 100ms hold = 200 requests/second.
-- But: 50 concurrent users × 100ms = each user needs 5 connections on average at peak.
-- 50 × 5 = 250 connections needed. Pool: 20. Result: 230 requests waiting.
-- Queue build-up: latency p50 = 1s. p99 = 30s. Cascading timeout. Outage.

-- Same workload with JOIN (1 query per request, 5ms):
-- Pool: 20 connections × (1000ms/5ms) = 4,000 req/s capacity.
-- 50 concurrent users × 5ms = each needs 0.25 connections on average.
-- 50 × 0.25 = 12.5 connections. Pool of 20: fine.
-- Conclusion: N+1 reduces effective connection pool throughput by ~100x at this ratio.
```

---

**DataLoader batching tick alignment:**

```javascript
// DataLoader batches all .load() calls within the same "tick" (microtask queue drain).
// This means: all resolver calls in one GraphQL response are batched.
// But: if a resolver is async and awaits something before calling .load():

// CORRECT (all in same tick):
const resolvers = {
  Post: {
    author: (post) => userLoader.load(post.authorId), // synchronous .load() call
  },
};
// All 100 Post.author resolvers: call .load() synchronously → 1 batch.

// PROBLEMATIC (async breaks batching):
const resolvers = {
  Post: {
    author: async (post) => {
      await someCacheCheck(); // ← async await here splits ticks
      return userLoader.load(post.authorId); // now each resolvers calls in different ticks
    },
  },
};
// May degrade to 5-10 separate batches instead of 1. Not N+1 but still suboptimal.
// Fix: load from DataLoader first, then apply local logic without awaiting DB.
```

---

## SECTION 8 — Optimization & Indexing

### Index Strategy to Eliminate N+1 Impact

```sql
-- Even after fixing N+1: ensure batch/JOIN queries are optimally indexed.

-- Pattern 1: JOIN on FK column
-- Query: SELECT o.*, u.name FROM orders o JOIN users u ON u.id = o.user_id
-- Required index: PRIMARY KEY on users(id) — usually exists.
--   But also: index on orders(user_id) for reverse-direction JOIN:
CREATE INDEX ON orders(user_id);
-- Without this: Seq scan of orders to find all orders for one user.

-- Pattern 2: IN-clause batch query
-- Query: SELECT * FROM users WHERE id = ANY($1::int[])
-- Index: PRIMARY KEY on users(id) handles this with Bitmap Index Scan.
-- PostgreSQL: automatically uses BitmapOr across PK for large IN arrays.
-- For small arrays (< 100): Index Scan per ID. For large arrays: Bitmap Index Scan.
-- Both are efficient with the PK index in place.

-- Pattern 3: subqueryload (SQLAlchemy) pattern
-- Query: SELECT * FROM posts WHERE user_id IN (SELECT id FROM users WHERE ...)
-- Index needed: posts(user_id) for the inner loop join.
CREATE INDEX ON posts(user_id);

-- Query logging to catch N+1 in development:
-- PostgreSQL: log_min_duration_statement = 100  (log queries >100ms)
-- But N+1 individual queries each take 1ms → none logged, yet sum is 1000ms.
-- Better: log_min_duration_statement = 0 + pg_stat_statements to catch by volume.

-- Application-level logging (Django example):
# settings.py:
LOGGING = {
    'loggers': {
        'django.db.backends': {
            'level': 'DEBUG',
            'handlers': ['console'],
        }
    }
}
# In development: prints every SQL query. N+1 immediately visible in output.
# 101 SELECT statements for one page load: obvious.
# Always enable in development. Never in production (log volume).
```
