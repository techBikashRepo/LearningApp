# Pagination (Offset vs Cursor) — Part 2 of 3

### Sections: 5 (Architecture Diagram), 6 (Production Scenarios), 7 (Scaling & Reliability), 8 (AWS Mapping)

**Series:** Backend & API Design → REST APIs → System Design

---

## SECTION 5 — Architecture & System Diagram

### ProductStream Full Pagination Architecture

```
                        PRODUCTSTREAM PAGINATION ARCHITECTURE
                        =====================================

Partners / Admin UI
        |
        | HTTP requests
        v
┌─────────────────────────────────────────────────────────┐
│                   CloudFront CDN                        │
│  Cache behavior:                                        │
│  • GET /v1/products?page=X → CACHE (TTL: 60 seconds)   │
│    (page-based queries are cacheable — stable offset)   │
│  • GET /v1/products/sync?cursor=X → NO CACHE           │
│    (cursors are one-time-use; caching breaks next page) │
│  • Cache key: method + path + query string              │
└─────────────────┬───────────────────────────────────────┘
                  │
                  v
┌─────────────────────────────────────────────────────────┐
│                   API Gateway                           │
│  Request validation:                                    │
│  • page: integer ≥ 1 (if present)                      │
│  • per_page: integer 1-100 (if present)                 │
│  • limit: integer 1-1000 for cursor endpoint            │
│  • cursor: base64url string (if present)                │
│  Rate limiting: 100 req/min per API key                 │
└─────────────────┬───────────────────────────────────────┘
                  │
                  v
┌─────────────────────────────────────────────────────────┐
│              Products API Service                       │
│  (Node.js, 3 instances behind ALB)                      │
│                                                         │
│  Offset handler:                                        │
│    1. Parse page, per_page params                       │
│    2. Calculate OFFSET = (page-1) * per_page            │
│    3. Check Redis cache for total_count                 │
│    4. Query PostgreSQL (offset query)                   │
│    5. Return data + pagination metadata                 │
│                                                         │
│  Cursor handler:                                        │
│    1. Parse cursor (decode base64url)                   │
│    2. Extract (updated_at, id) from cursor              │
│    3. Query PostgreSQL (keyset query)                   │
│    4. Encode next cursor from last result               │
│    5. Return data + cursor metadata                     │
└────────┬──────────────────────────┬────────────────────┘
         │                          │
         v                          v
┌──────────────────┐     ┌──────────────────────────────┐
│  Redis Cluster   │     │  PostgreSQL (RDS Aurora)      │
│                  │     │                               │
│ Cached values:   │     │  products table               │
│ total_count:     │     │  (50M rows)                   │
│  products:elec   │     │                               │
│  = 1,283,459     │     │  Indexes:                     │
│  (TTL: 5 min)    │     │  PRIMARY: id                  │
│                  │     │  idx_products_offset: (       │
│ Page cache:      │     │    category, name, id         │
│  products:       │     │  )                            │
│  page=1:elec     │     │  idx_products_cursor: (       │
│  = JSON response │     │    updated_at DESC, id DESC   │
│  (TTL: 60s)      │     │  )                            │
└──────────────────┘     └──────────────────────────────┘

CURSOR PAGINATION QUERY FLOW:
──────────────────────────────

Partner SDK                 Products API           PostgreSQL
    │                           │                      │
    │─GET /sync?limit=1000──────▶                      │
    │  updated_after=2024-01-14  │                      │
    │                           │─SELECT * FROM────────▶
    │                           │ products             │
    │                           │ WHERE updated_at >   │
    │                           │ '2024-01-14'         │
    │                           │ ORDER BY updated_at  │
    │                           │ DESC, id DESC        │
    │                           │ LIMIT 1001           │ ← fetch 1001 to know if has_more
    │                           │                      │
    │                           │◀─1001 rows───────────│
    │                           │                      │
    │                           │ (has_more = true      │
    │                           │  because got 1001)   │
    │                           │ next_cursor = encode(│
    │                           │   row 1000's values) │
    │                           │ return rows 1-1000   │
    │                           │                      │
    │◀─200 + 1000 items─────────│                      │
    │  + next_cursor            │                      │
    │                           │                      │
    │─GET /sync?cursor=<X>──────▶                      │
    │                           │─SELECT * FROM────────▶
    │                           │ products WHERE       │
    │                           │ (updated_at, id) <   │
    │                           │ (<cursor_values>)    │
    │                           │ ORDER BY updated_at  │
    │                           │ DESC, id DESC        │
    │                           │ LIMIT 1001           │
    │                           │                      │

NOTE: Fetch LIMIT+1 trick:
  Request limit=1000 → query LIMIT 1001
  If we get 1001 rows → has_more = true, return first 1000
  If we get ≤ 1000 rows → has_more = false, return all rows
  Never run a separate COUNT(*) query for "has next page"
```

---

## SECTION 6 — Production Scenarios

### Scenario A: Twitter/X Timeline Feed (Why Cursor Won)

Twitter's core timeline is 300M+ tweets/day. Early implementation used offset pagination.

**The offset problem at Twitter scale:**

```
User loads more tweets (scroll down):
  Request 1: OFFSET 0, LIMIT 20 → 8ms
  Request 5: OFFSET 80, LIMIT 20 → 12ms
  Request 50: OFFSET 980, LIMIT 20 → 89ms
  Request 200: OFFSET 3980, LIMIT 20 → 780ms

Heavier users (checking timeline multiple times/day, scrolling deep):
  OFFSET 10,000: 2,300ms
  User sees lag. Tweets appear slowly. UX degrades.

New tweet problem:
  User at OFFSET 200 (200 tweets deep in their feed).
  500 new tweets arrive at the top of their timeline.
  Next request: OFFSET 220 → returns a tweet they already saw 20 tweets ago.
  User sees duplicate tweets when scrolling.
```

**Cursor solution:**

```
Timeline cursor = tweet ID of the last tweet seen.

GET /timeline?max_id=1234567890  ← tweet ID as cursor

SQL: WHERE id < 1234567890 ORDER BY id DESC LIMIT 20

  New tweets arrive at top (higher IDs).
  Scrolling down = lower IDs.
  max_id cursor stays at the tweet where the user left off.
  No scanning from OFFSET 0 every time.
  No duplicate tweets regardless of new tweets arriving.
  Consistent performance at any scroll depth.
```

---

### Scenario B: GitHub API — Hybrid Approach

GitHub serves repos (30M+), issues (500M+), commits (billions). They use cursor-based pagination:

```
GitHub Link header pattern (RFC 5988 Web Linking):

GET https://api.github.com/repos/microsoft/vscode/issues?per_page=30

Response headers:
  Link: <https://api.github.com/repos/microsoft/vscode/issues?per_page=30&page=2>; rel="next",
        <https://api.github.com/repos/microsoft/vscode/issues?per_page=30&page=834>; rel="last"

The "next" link contains everything needed for the next page.
Client doesn't need to construct URLs — just follow the next link.
```

GitHub's page-based pagination uses sequential page numbers (page=1, page=2) but internally uses keyset pagination on the database. The page number in the URL is user-facing, but the actual SQL uses indexed seeks not OFFSET. This is the sweet spot: user-friendly URLs with cursor performance.

---

### Scenario C: Stripe's Cursor Pagination — Industry Gold Standard

Stripe serves the most developer-friendly pagination in the industry:

```
GET /v1/charges?limit=3

{
  "object": "list",
  "url": "/v1/charges",
  "has_more": true,
  "data": [
    {"id": "ch_3abc", "amount": 2000, ...},
    {"id": "ch_3def", "amount": 5000, ...},
    {"id": "ch_3ghi", "amount": 1500, ...}
  ]
}

GET /v1/charges?limit=3&starting_after=ch_3ghi  ← last ID as cursor

{
  "object": "list",
  "has_more": true,
  "data": [
    {"id": "ch_3jkl", ...},
    ...
  ]
}

Additionally: ending_before for previous page:
GET /v1/charges?limit=3&ending_before=ch_3jkl
```

Why Stripe's approach is excellent:

1. Cursor is the **resource ID itself** — no encoding/decoding needed
2. `starting_after` and `ending_before` for bi-directional pagination
3. `has_more` boolean instead of total count (avoids COUNT query)
4. Stable: if a new charge appears, navigation doesn't break
5. IDs are time-ordered (Stripe IDs are prefixed with object type + time component)

---

## SECTION 7 — Scaling & Reliability

### Deep Offset Performance Problem — Numbers at Scale

```
Aurora PostgreSQL, table: 50M orders, indexed by created_at

Query: SELECT * FROM orders WHERE user_id=? ORDER BY created_at DESC LIMIT 20 OFFSET ?

OFFSET        Query time    Rows scanned    Rows discarded
─────────────────────────────────────────────────────────
0             8ms           20              0
1,000         14ms          1,020           1,000
10,000        89ms          10,020          10,000
100,000       780ms         100,020         100,000
500,000       3,940ms       500,020         500,000
1,000,000     7,800ms       1,000,020       1,000,000
5,000,000     39,000ms      5,000,020       5,000,000   ← TIMEOUT
```

**Same data with cursor pagination (keyset):**

```
Query: SELECT * FROM orders
       WHERE user_id=? AND (created_at, id) < (?, ?)
       ORDER BY created_at DESC, id DESC LIMIT 20

Index: idx_orders_user_cursor (user_id, created_at DESC, id DESC)

Any depth:    ~8ms     21 rows scanned     1 discarded (the cursor row)
```

### Solutions for Deep Offset (When You Can't Switch to Cursor)

**Pattern 1: Deferred Join (PostgreSQL)**

```sql
-- SLOW: full scan then fetch all columns for every row
SELECT * FROM orders
WHERE user_id = 42
ORDER BY created_at DESC
LIMIT 20 OFFSET 100000;

-- FAST: scan only the index to find IDs, then fetch only those 20 rows
SELECT o.*
FROM (
  SELECT id FROM orders
  WHERE user_id = 42
  ORDER BY created_at DESC
  LIMIT 20 OFFSET 100000
) AS subq
JOIN orders o ON o.id = subq.id;

-- The subquery scans a narrow index (id + created_at only)
-- The JOIN fetches full rows for only 20 records
-- 3-10x faster for wide tables with many columns
```

**Pattern 2: Limit Maximum Pages**

```
Business rule: "API only supports up to 1000 items (page 1-50 at 20/page)"
Users beyond that: search/filter to narrow results

Justification: No legitimate use case for browsing to page 5,000.
If a user needs deeper access, they should use bulk export (cursor pagination).

Implementation: Validate max_offset = max(page) × per_page
If offset > 10000: 400 Bad Request "Use filters to narrow results,
                   or use the /export endpoint for bulk access"
```

**Pattern 3: Approximate Total Count**

```
Exact COUNT(*): SELECT COUNT(*) — full table scan unless maintained separately
Approximate count: PostgreSQL reltuples (updated by VACUUM/ANALYZE)

SELECT reltuples::BIGINT AS estimate
FROM pg_class
WHERE relname = 'products';

Fast (milliseconds). Accuracy: within 10-20%.
For analytics/admin UI showing "~1.2M products": acceptable.
For billing or compliance: not acceptable (use exact count with caching).

Cache strategy:
  1. Background job: exact COUNT(*) → store in Redis → TTL 5 minutes
  2. API reads from Redis (fast)
  3. Display: "1,283,459 products (updated 2 minutes ago)"
```

### Cursor Stability During Updates

**Problem: records change while user is paginating**

```
User paginating products sorted by name (A→Z):
  Page 1: Apple TV, Bose Speaker, Canon Camera (cursor = Canon Camera)

  WHILE USER READS: Canon Camera is renamed to "Z-Cam Ultra"

  Page 2 (cursor = Canon Camera ID):
    Query: WHERE name > 'Canon Camera' ORDER BY name, id
    → Starts from where it was, but "Canon Camera" no longer exists at that name
    → Might skip records or return unexpected results

SOLUTION: Sort by immutable field as primary sort key

Bad:  ORDER BY name, id       ← name can change
Bad:  ORDER BY price, id      ← price can change
Bad:  ORDER BY updated_at, id ← changes on every update (cursor immediately breaks)
Good: ORDER BY created_at DESC, id DESC  ← created_at never changes after creation
Good: ORDER BY id DESC        ← ID never changes
Good: ORDER BY external_ref, id (if external_ref is immutable)

Best practice: use created_at + id for content feeds (chron order, stable)
               use id alone for streaming/event feeds (simplest, most stable)
```

---

## SECTION 8 — AWS Implementation

### Aurora PostgreSQL with Optimized Pagination

```sql
-- Schema with cursor-optimized indexes
CREATE TABLE products (
    id          BIGSERIAL PRIMARY KEY,
    sku         VARCHAR(200) NOT NULL,
    category    VARCHAR(100) NOT NULL,
    name        VARCHAR(500) NOT NULL,
    price_cents INTEGER NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at  TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- Offset pagination index (category filter + name sort)
CREATE INDEX idx_products_offset
    ON products (category, name, id);

-- Cursor pagination index (bulk sync by update time)
CREATE INDEX idx_products_cursor
    ON products (updated_at DESC, id DESC);
-- Partial index if only active items needed:
CREATE INDEX idx_products_cursor_active
    ON products (updated_at DESC, id DESC)
    WHERE status = 'active';
```

### Lambda Function — Pagination Handler

```javascript
// Node.js Lambda handler for ProductStream pagination
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const redis = createClient({ url: process.env.REDIS_URL });

// ─────────────────────────────────────────────────────────
// OFFSET PAGINATION HANDLER
// ─────────────────────────────────────────────────────────
export const getProductsOffset = async (event) => {
  const {
    page = 1,
    per_page = 20,
    category,
  } = event.queryStringParameters || {};

  // Validate
  const pageNum = parseInt(page, 10);
  const perPage = Math.min(parseInt(per_page, 10), 100);
  if (pageNum < 1 || isNaN(pageNum)) {
    return { statusCode: 400, body: JSON.stringify({ error: "INVALID_PAGE" }) };
  }
  const maxOffset = 10000;
  const offset = (pageNum - 1) * perPage;
  if (offset > maxOffset) {
    return {
      statusCode: 400,
      body: JSON.stringify({
        error: "PAGE_TOO_DEEP",
        message: `Maximum supported offset is ${maxOffset}. Use filters to narrow results.`,
      }),
    };
  }

  // Get total count from Redis cache
  const cacheKey = `count:products:${category || "all"}`;
  let totalItems = await redis.get(cacheKey);
  if (!totalItems) {
    const countResult = await pool.query(
      `SELECT COUNT(*) FROM products WHERE ($1::text IS NULL OR category = $1)`,
      [category || null],
    );
    totalItems = parseInt(countResult.rows[0].count, 10);
    await redis.setEx(cacheKey, 300, totalItems.toString()); // Cache 5 minutes
  } else {
    totalItems = parseInt(totalItems, 10);
  }

  // Fetch page
  const result = await pool.query(
    `SELECT id, sku, name, category, price_cents, created_at
     FROM products
     WHERE ($1::text IS NULL OR category = $1)
     ORDER BY name ASC, id ASC
     LIMIT $2 OFFSET $3`,
    [category || null, perPage, offset],
  );

  return {
    statusCode: 200,
    body: JSON.stringify({
      data: result.rows,
      pagination: {
        page: pageNum,
        per_page: perPage,
        total_items: totalItems,
        total_pages: Math.ceil(totalItems / perPage),
        has_next_page: offset + perPage < totalItems,
        has_previous_page: pageNum > 1,
      },
    }),
  };
};

// ─────────────────────────────────────────────────────────
// CURSOR PAGINATION HANDLER
// ─────────────────────────────────────────────────────────
const encodeCursor = (row) =>
  Buffer.from(
    JSON.stringify({
      updated_at: row.updated_at,
      id: row.id,
    }),
  ).toString("base64url");

const decodeCursor = (cursor) => {
  try {
    const data = JSON.parse(Buffer.from(cursor, "base64url").toString());
    if (!data.updated_at || typeof data.id !== "number") throw new Error();
    return data;
  } catch {
    throw { statusCode: 400, error: "INVALID_CURSOR" };
  }
};

export const getProductsSync = async (event) => {
  const {
    limit = 100,
    cursor,
    updated_after,
  } = event.queryStringParameters || {};
  const limitNum = Math.min(parseInt(limit, 10), 1000);

  let rows;
  if (cursor) {
    const { updated_at, id } = decodeCursor(cursor);
    const result = await pool.query(
      `SELECT id, sku, name, category, price_cents, updated_at
       FROM products
       WHERE (updated_at, id) < ($1::timestamptz, $2::bigint)
       ORDER BY updated_at DESC, id DESC
       LIMIT $3`,
      [updated_at, id, limitNum + 1], // fetch +1 to know if has_more
    );
    rows = result.rows;
  } else {
    const afterDate = updated_after || "1970-01-01T00:00:00Z";
    const result = await pool.query(
      `SELECT id, sku, name, category, price_cents, updated_at
       FROM products
       WHERE updated_at > $1::timestamptz
       ORDER BY updated_at DESC, id DESC
       LIMIT $2`,
      [afterDate, limitNum + 1],
    );
    rows = result.rows;
  }

  const hasMore = rows.length > limitNum;
  if (hasMore) rows = rows.slice(0, limitNum);

  return {
    statusCode: 200,
    body: JSON.stringify({
      data: rows,
      sync: {
        has_more: hasMore,
        next_cursor: hasMore ? encodeCursor(rows[rows.length - 1]) : null,
        items_in_page: rows.length,
      },
    }),
  };
};
```

### CloudFront Cache Configuration

```yaml
# CDN caching strategy for pagination
CacheBehaviors:
  # Offset pagination: cacheable (stable page numbers)
  - PathPattern: "/v1/products"
    CachePolicyId: !Ref OffsetPaginationCachePolicy
    OriginRequestPolicyId: !Ref ForwardQueryStringPolicy

  # Cursor sync: never cache (cursors are one-time tokens)
  - PathPattern: "/v1/products/sync"
    CachePolicyId: !Ref NoCachePolicy # Managed-CachingDisabled policy

OffsetPaginationCachePolicy:
  Type: AWS::CloudFront::CachePolicy
  Properties:
    CachePolicyConfig:
      Name: OffsetPaginationPolicy
      DefaultTTL: 60 # 60 seconds — fresh enough for catalog browsing
      MaxTTL: 300 # 5 minutes max
      MinTTL: 0
      ParametersInCacheKeyAndForwardedToOrigin:
        QueryStringsConfig:
          QueryStringBehavior: Whitelist
          QueryStrings:
            Items: ["page", "per_page", "category", "sort"]
            # Include all query params that affect the response content
            # EXCLUDE: tracking params (utm_source, ref, etc.)
```

### DynamoDB Pagination (for Serverless Workloads)

```javascript
// DynamoDB uses its own cursor: LastEvaluatedKey
import { DynamoDB } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";

const ddb = DynamoDBDocumentClient.from(new DynamoDB());

export const getOrders = async (userId, cursorToken, limit = 20) => {
  const params = {
    TableName: "Orders",
    KeyConditionExpression: "userId = :uid",
    ExpressionAttributeValues: { ":uid": userId },
    ScanIndexForward: false, // DESC order (newest first)
    Limit: limit + 1, // +1 to detect has_more
  };

  // DynamoDB cursor = ExclusiveStartKey (the last evaluated key from previous page)
  if (cursorToken) {
    params.ExclusiveStartKey = JSON.parse(
      Buffer.from(cursorToken, "base64url").toString(),
    );
  }

  const response = await ddb.send(new QueryCommand(params));
  const items = response.Items || [];
  const hasMore = items.length > limit;
  if (hasMore) items.pop();

  // Encode the next cursor (DynamoDB's LastEvaluatedKey)
  const nextCursor = hasMore
    ? Buffer.from(JSON.stringify(response.LastEvaluatedKey)).toString(
        "base64url",
      )
    : null;

  return { items, has_more: hasMore, next_cursor: nextCursor };
};
```

DynamoDB note: DynamoDB `LastEvaluatedKey` is already a cursor. Do not use `OFFSET`-style thinking with DynamoDB — there is no OFFSET in DynamoDB. Cursor (keyset) pagination is the only option, which is the right default.

### CloudWatch Metrics to Monitor Pagination Health

```javascript
// Instrument pagination for observability
import { CloudWatch } from "@aws-sdk/client-cloudwatch";

const cw = new CloudWatch({ region: "us-east-1" });

// After each paginated query, emit metrics
await cw.putMetricData({
  Namespace: "ProductStream/Pagination",
  MetricData: [
    {
      MetricName: "OffsetDepth",
      Value: offset,
      Unit: "Count",
      Dimensions: [{ Name: "Endpoint", Value: "/v1/products" }],
    },
    {
      MetricName: "QueryDurationMs",
      Value: queryDurationMs,
      Unit: "Milliseconds",
      Dimensions: [
        { Name: "PaginationType", Value: cursor ? "cursor" : "offset" },
      ],
    },
  ],
});

// Alarm: if P99 query duration > 1000ms for offset queries → time to migrate
// Alarm: if max offset depth > 5000 → investigate deep pagination usage patterns
```
