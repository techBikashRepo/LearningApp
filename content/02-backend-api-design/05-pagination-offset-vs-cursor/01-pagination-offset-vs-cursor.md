# Pagination (Offset vs Cursor) — Part 1 of 3

### Sections: 1 (Intuition), 2 (Why It Exists), 3 (Core Technical Deep Dive), 4 (Real-World API Contract & Request Flow)

**Series:** Backend & API Design → REST APIs → System Design

---

## SECTION 1 — Building Intuition First

### The Library Analogy

Imagine a library with 2 million books, sorted alphabetically. A librarian is helping you browse sci-fi novels.

**Offset approach — "Jump to shelf 500, hand me the next 20 books":**

```
Request: "Start from book number 10,000, give me 20 books"

What the librarian does:
  → Walks to the BEGINNING of the sci-fi section
  → Counts to book 10,000 (counts every single one)
  → Picks up books 10,001 through 10,020
  → Hands them to you

Problem: To get to page 500, the librarian STILL walks books 1-9,999.
  Page 1 (books 1-20):    fast — librarian walks 0 books
  Page 100 (books 1981-2000): librarian walks 1,980 books
  Page 500 (books 9981-10000): librarian walks 9,980 books
  Page 5000 (books 99,981-100,000): librarian walks 99,980 books

  The further back in the collection, the slower it gets.
```

**Cursor approach — "Continue from where you left off, using the bookmark I gave you":**

```
First request: "Give me the first 20 books"
Response: [Book 1...Book 20] + bookmark: "ABK-LAST-ISBN: 978-0-7432-7356-5"

Second request: "Give me the next 20 books after ISBN 978-0-7432-7356-5"

What the librarian does:
  → Finds book with ISBN 978-0-7432-7356-5 in the catalog (indexed lookup!)
  → Picks up the next 20 books after that point
  → Hands them to you + new bookmark

Speed:
  Any page: the librarian finds the bookmark using the index — O(log N)
  No counting from the beginning. Constant-time regardless of page depth.
```

### The Database Reality

|                       | Offset                                          | Cursor                                           |
| --------------------- | ----------------------------------------------- | ------------------------------------------------ |
| SQL equivalent        | `LIMIT 20 OFFSET 10000`                         | `WHERE id > 10000 ORDER BY id LIMIT 20`          |
| Rows touched          | All 10,020 rows                                 | ~20 rows (index seek)                            |
| Deep page performance | O(N) scans                                      | O(log N) index seek                              |
| Suitable for          | Small datasets (<1000 rows), analytical reports | Large datasets, real-time feeds, infinite scroll |

---

## SECTION 2 — Why Pagination Exists

### The Direct Answer

Without pagination, every list endpoint returns ALL matching records:

```
GET /posts → 50 million rows
             ↓
             Full table scan
             8 GB of data transferred
             30-second query
             Out-of-memory error in API server
             Client browser crashes trying to render 50M rows
```

Pagination exists because **lists are unbounded** and every layer of the stack has limits:

```
Database:    Query execution time limit, connection timeout, max result size
Network:     Bandwidth cost, mobile data limits, transfer time
API Server:  Memory limit (can't hold 50M objects in NestJS memory)
Client:      DOM cannot render 50M rows, mobile app memory limit ~200MB
User:        Cannot process 50M rows visually — cognitive limit
```

### What Goes Wrong Without It — Real Incidents

**"Admin dashboard incident" (common in SaaS):**

> A startup's admin dashboard loaded all users with `GET /admin/users`. For a year, this worked fine (10K users). On the day they hit 100K users, the dashboard stopped loading entirely. Response was 180MB, API timed out, DB query took 45 seconds. The fix took 3 days of emergency pagination work.

**"Infinite scroll broke at depth" (common in content apps):**

> A social app used offset pagination for their feed: `OFFSET 500`. At 500 posts, the query took 800ms. At 2000 posts (heavy users with old feeds), it took 3,200ms. Users who scrolled far saw the app freeze. The fix required a full cursor-based rebuild of the pagination system.

**"Ghost records in offset pagination" (subtle correctness bug):**

> An e-commerce site used offset pagination for order listings. While a user browsed page 3, admin deleted an order from page 1. Every record shifted forward by 1. The user never saw one record (it "fell between" pages). This is a correctness issue, not just performance.

---

## SECTION 3 — Core Technical Deep Dive

### Offset Pagination

```sql
-- Client request: page=3, size=20
SELECT * FROM posts
WHERE user_id = 42
ORDER BY created_at DESC
LIMIT 20
OFFSET 40;   -- (page-1) * size = (3-1) * 20 = 40
```

**What the database actually does:**

```
1. Apply WHERE user_id = 42
2. Sort by created_at DESC (uses index if exists)
3. Scan rows 1 through 60  ← scans ALL rows up to OFFSET + LIMIT
4. Discard rows 1-40 (OFFSET)
5. Return rows 41-60 (LIMIT 20)

PostgreSQL "rows removed by filter" will show 40 rows scanned and thrown away.
For OFFSET 10000: 10,020 rows scanned, 10,000 discarded.
```

**Performance at scale (PostgreSQL benchmarks):**

```
Table: 10M orders, indexed by created_at
  OFFSET 0:     8ms    ← fast
  OFFSET 1000:  12ms
  OFFSET 10000: 89ms
  OFFSET 100000: 780ms ← painful
  OFFSET 500000: 3,940ms ← unacceptable
  OFFSET 1000000: 7,800ms ← app is broken
```

**The races condition problem:**

```
User loads page 1 (posts 1-20):  [P1][P2][P3]...[P20]
  Someone posts a new post [P0] at the top of the feed.
  New post becomes position 1, P1 becomes position 2...

User loads page 2 (OFFSET 20): [P20][P21]...
  But P20 has shifted to position 21.
  Result: user sees P20 TWICE (once on page 1, once as first entry of page 2).
  AND the original P21 was pushed to position 22 → user MISSES it.
```

### Cursor Pagination

```sql
-- First page (no cursor):
SELECT * FROM posts
WHERE user_id = 42
ORDER BY created_at DESC, id DESC  ← IMPORTANT: secondary sort for duplicate timestamps
LIMIT 20;

-- Next page (cursor provided):
-- cursor = base64("2024-01-15T10:30:00Z:12345")  ← encodes last item's sort key
SELECT * FROM posts
WHERE user_id = 42
  AND (created_at, id) < ('2024-01-15T10:30:00Z', 12345)  ← keyset pagination
ORDER BY created_at DESC, id DESC
LIMIT 20;
```

**Why compound sort key matters:**

```
Problem with single-field cursor:
  created_at = '2024-01-15T10:30:00Z' for posts 100, 101, 102 (same second)
  Cursor = '2024-01-15T10:30:00Z'
  Query: WHERE created_at < '2024-01-15T10:30:00Z'
  → SKIPS posts 100, 101, 102 if they were at the boundary ❌

Solution:
  Cursor = '2024-01-15T10:30:00Z:100' (timestamp + id)
  Query: WHERE (created_at, id) < ('2024-01-15T10:30:00Z', 100)
  → Uses row comparison, works correctly ✅
```

**Index requirements for cursor pagination:**

```sql
-- The query must use an index or it degrades to full table scan
-- Index needed:
CREATE INDEX idx_posts_user_cursor
  ON posts (user_id, created_at DESC, id DESC);

-- The WHERE clause must be index-sargable (can use the index):
WHERE user_id = 42           ← index seek on user_id
AND (created_at, id) < (?, ?)  ← range scan from cursor position

-- PostgreSQL EXPLAIN should show: Index Scan (not Seq Scan)
-- Rows examined: ~20 (not ~10,000)
```

### Cursor Encoding (Production Pattern)

Never expose raw database fields as cursors. Encode opaquely:

```javascript
// Encoding the cursor
const encodeCursor = (post) => {
  const cursorData = {
    created_at: post.created_at.toISOString(),
    id: post.id,
  };
  return Buffer.from(JSON.stringify(cursorData)).toString("base64url");
  // Result: "eyJjcmVhdGVkX2F0IjoiMjAyNC0wMS0xNVQxMDozMDowMFoiLCJpZCI6MTIzNDV9"
};

// Decoding the cursor (server-side ONLY, never trust client-constructed cursors)
const decodeCursor = (cursor) => {
  try {
    const decoded = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    );
    // Validate shape
    if (!decoded.created_at || !decoded.id) throw new Error("Invalid cursor");
    if (typeof decoded.id !== "number")
      throw new Error("Invalid cursor id type");
    return decoded;
  } catch (e) {
    throw new ApiError(
      400,
      "INVALID_CURSOR",
      "The pagination cursor is invalid or expired",
    );
  }
};
```

Why opaque cursors?

1. Schema changes: if you change the sort column, old cursors still decode cleanly
2. Security: clients cannot construct cursors to page into arbitrary positions
3. Flexibility: cursor can encode additional state (shard ID, sort direction, etc.)

### Response Shape Conventions

**Offset pagination response:**

```json
{
  "data": [...20 items...],
  "pagination": {
    "page": 3,
    "per_page": 20,
    "total_items": 1847,
    "total_pages": 93,
    "has_previous_page": true,
    "has_next_page": true
  }
}
```

**Cursor pagination response:**

```json
{
  "data": [...20 items...],
  "pagination": {
    "has_next_page": true,
    "has_previous_page": false,
    "next_cursor": "eyJjcmVhdGVkX2F0Ijoi...",
    "previous_cursor": null,
    "page_size": 20
  }
}
```

Design note: cursor pagination intentionally **omits total_count**. Getting the total count requires `SELECT COUNT(*)` which often requires a full table scan. This would eliminate the performance advantage of cursor pagination. If you need total count, use a cached/async count (updated by worker) rather than computing it on every paginated request.

---

## SECTION 4 — Real-World API Contract & Request Flow

### ProductStream — E-commerce Catalog API

ProductStream is a B2B API serving product catalogs to 2,000 retail partners. Product catalog: 50 million SKUs. Partners browse and sync product data.

**Use case 1 — Admin UI (fixed pages, needs totals):**
Uses offset pagination. Admin browses specific pages: "Go to page 47". Needs "showing 940-960 of 1,847 results".

**Use case 2 — Partner sync (bulk export, infinite scroll direction):**
Uses cursor pagination. Partner syncs all products changed since last sync. Cannot afford deep-offset scans on 50M rows.

**API design:**

```
Offset Pagination (Admin UI):
GET /v1/products?page=1&per_page=20&category=electronics&sort=name&direction=asc

Request headers:
  Authorization: Bearer <token>

Response 200:
{
  "data": [
    {
      "id": "prod_f47ac10b",
      "sku": "ELEC-TV-55-4K-001",
      "name": "55-inch 4K Smart TV",
      "category": "electronics",
      "price_cents": 49999,
      "updated_at": "2024-01-15T10:30:00Z"
    }
    // ... 19 more
  ],
  "pagination": {
    "page": 1,
    "per_page": 20,
    "total_items": 1283459,
    "total_pages": 64173,
    "has_next_page": true,
    "has_previous_page": false
  }
}

Note: total_items count is CACHED (updated every 5 minutes by background job).
     Not computed on every request. Admin UI shows "~1.2M items" — approximate is fine.

---

Cursor Pagination (Partner Sync):
GET /v1/products/sync?limit=1000&updated_after=2024-01-14T00:00:00Z&cursor=<cursor>

Response 200:
{
  "data": [...1000 products...],
  "sync": {
    "has_more": true,
    "next_cursor": "eyJ1cGRhdGVkX2F0IjoiMjAyNO...",
    "items_in_page": 1000,
    "sync_timestamp": "2024-01-15T12:00:00Z"
  }
}

Partner iterates:
  1. GET /v1/products/sync?limit=1000&updated_after=2024-01-14T00:00:00Z
     → Response: 1000 items + cursor A + has_more: true
  2. GET /v1/products/sync?limit=1000&cursor=A
     → Response: 1000 items + cursor B + has_more: true
  3. ... continues until has_more: false
  4. Partner stores sync_timestamp of last response for next daily sync

Note: cursor pagination with updated_after = change-feed pattern.
     This is how DynamoDB Streams, Stripe event pagination, and GitHub events work.
```

**Error cases for pagination:**

```json
// Invalid page number:
GET /v1/products?page=-1
→ 400 Bad Request
{
  "error": "INVALID_PAGINATION",
  "message": "page must be a positive integer",
  "field": "page"
}

// Out-of-range page:
GET /v1/products?page=999999
→ 200 OK (not 404!)
{
  "data": [],
  "pagination": {
    "page": 999999,
    "per_page": 20,
    "total_items": 1283459,
    "total_pages": 64173,
    "has_next_page": false,
    "has_previous_page": true
  }
}
Note: out-of-range page returns empty data array, not 404.
The resource collection exists; there just aren't items at that page.

// Invalid cursor:
GET /v1/products/sync?cursor=INVALID_BASE64!!
→ 400 Bad Request
{
  "error": "INVALID_CURSOR",
  "message": "The pagination cursor is invalid or has expired. Start a new sync from the beginning.",
  "resolution": "Begin a fresh sync without providing a cursor parameter"
}

// Limit too large:
GET /v1/products/sync?limit=100000
→ 400 Bad Request
{
  "error": "LIMIT_TOO_LARGE",
  "message": "Maximum allowed limit is 1000",
  "max_allowed": 1000,
  "recommendation": "Use cursor pagination for bulk data export"
}
```
