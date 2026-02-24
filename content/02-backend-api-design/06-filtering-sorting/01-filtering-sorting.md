# Filtering & Sorting — Part 1 of 3

### Sections: 1 (Intuition), 2 (Why It Exists), 3 (Core Technical Deep Dive), 4 (Real-World API Contract & Request Flow)

**Series:** Backend & API Design → REST APIs → System Design

---

## SECTION 1 — Building Intuition First

### The Spreadsheet Analogy

You have a spreadsheet with 1 million rows of sales data: customer name, product, price, date, status, region.

**Filtering** is applying column filters: "Show me only rows where region = 'West' AND status = 'shipped' AND price > 100."

**Sorting** is clicking a column header: "Sort by date, newest first."

**Together**: "Show me shipped orders from the West region, priced over $100, sorted from newest to oldest."

The spreadsheet returns only the matching, ordered subset — not all 1 million rows.

That's exactly what API filtering and sorting does, except:

- The "spreadsheet" is your database
- The "column filter" is a query parameter like `?status=shipped&region=west&min_price=100`
- The "column header click" is a query parameter like `?sort=created_at&order=desc`

Without filtering and sorting, the API must return ALL rows (millions) and the client does the filtering and sorting locally in memory. This is like downloading the entire spreadsheet and filtering in Excel — catastrophically inefficient at scale.

### The Database Pushdown Principle

```
CLIENT-SIDE FILTERING (wrong):
  API → fetch 1,000,000 orders → return to client → client filters for status = 'shipped'

  Network cost: 1M rows × 2KB = 2GB transfer
  Result: 50,000 shipped orders (client threw away 950,000)
  Total waste: 95% of data transferred served no purpose

SERVER-SIDE FILTERING (right):
  Client requests: GET /orders?status=shipped
  API → WHERE status = 'shipped' → 50,000 orders → return to client

  Network cost: 50,000 rows × 2KB = 100MB
  Result: all shipped orders
  Waste: 0%

  "Push the filtering down to where the data lives"
  That's why filtering is a core design concern, not an afterthought.
```

---

## SECTION 2 — Why Filtering & Sorting Exists

### The Direct Answer

Filtering and sorting exist because **clients need subsets of data in specific order**, and computing this at the database layer (with indexes) is 100-1000x more efficient than returning all data and computing it at the application or client layer.

### What Goes Wrong Without It

**Without filtering — the "give me everything" problem:**

```
SaaS support dashboard: "Show me all open tickets for customer Acme Corp"
Without filtering: GET /tickets → returns all 500,000 tickets for all customers
  → 500K rows, 400MB response, 12-second query
  → Acme Corp has 47 open tickets — 500K records downloaded for 47
  → Application filters in memory: O(500K) per request

With filtering: GET /tickets?customer_id=acme&status=open
  → 47 rows, 94KB response, 8ms query (index hit)
  → 5,000x less data, 1,500x faster
```

**Without sorting — the "random order" problem:**

```
User's email inbox: without sorting, emails appear in random DB storage order.
The user wants newest first. Without API sorting:
  → Client downloads all emails, sorts in JavaScript
  → For 50,000 emails: 50K sort on client on every page refresh
  → Mobile app: sorts 50K objects → 300ms CPU spike → battery drain → ANR (app not responding)

With API sorting: GET /emails?sort=received_at&order=desc
  → DB sorts using index, returns newest first, client renders immediately
```

### The SQL Injection Concern

Filtering and sorting are also the #1 injection attack surface in REST APIs:

```
DANGEROUS (direct string interpolation):
  GET /orders?sort=created_at; DROP TABLE orders;--

  SQL: SELECT * FROM orders ORDER BY created_at; DROP TABLE orders;--
  Result: table deleted

SAFE (whitelist validation):
  Allowed sort fields: ['created_at', 'price', 'status', 'id']
  GET /orders?sort=created_at; DROP TABLE orders;--
  → Server: 'created_at; DROP TABLE orders;--' not in allowed list → 400 error
  → Never interpolated into SQL
```

This is why filtering and sorting require careful server-side validation, not pass-through to SQL.

---

## SECTION 3 — Core Technical Deep Dive

### Filtering Design Patterns

**Simple equality filter:**

```
GET /orders?status=shipped&customer_id=cust_123

SQL: WHERE status = 'shipped' AND customer_id = 'cust_123'

Use case: exact match on categorical/ID fields
Design choice: multiple params = AND semantics (default, most intuitive)
```

**Range filters:**

```
GET /orders?min_price=100&max_price=500
GET /orders?created_after=2024-01-01T00:00:00Z&created_before=2024-12-31T23:59:59Z

SQL: WHERE price BETWEEN 100 AND 500
     WHERE created_at >= '2024-01-01' AND created_at <= '2024-12-31'

Naming convention options:
  min_/max_  prefix → min_price=100&max_price=500
  [field][_gte/_lte] → price_gte=100&price_lte=500
  [field][after/before] → created_after=2024-01-01

Best practice: use semantic names matching the domain:
  "after" and "before" for dates (more natural language)
  "min" and "max" for numeric ranges
```

**Array filters (IN query):**

```
GET /orders?status=shipped,processing,pending
GET /orders?status[]=shipped&status[]=processing&status[]=pending  ← bracket notation

SQL: WHERE status IN ('shipped', 'processing', 'pending')

Which format to choose:
  Comma-separated: simpler URLs, less elegant for encoding
  Bracket notation: more explicit, clear that it's multi-value
  Best practice: pick one and document it; Stripe uses comma-separated
```

**Search (text search):**

```
GET /products?q=wireless+headphones&sort=relevance
GET /products?search=wireless+headphones

Maps to: full-text search, not simple LIKE
  PostgreSQL: WHERE to_tsvector('english', title || ' ' || description) @@ plainto_tsquery('wireless headphones')
  Elasticsearch: { "query": { "multi_match": { "query": "wireless headphones" } } }

Never use: WHERE title LIKE '%wireless headphones%'
  → Full table scan, no index, catastrophic at scale
  → Use full-text search (PostgreSQL tsvector) or Elasticsearch
```

**Nested/relational filters:**

```
GET /orders?customer.country=US
GET /orders?include=customer&customer_country=US

Challenge: filtering across joins requires careful index and query design.

Product orders from US customers:
  SQL: WHERE EXISTS (SELECT 1 FROM customers c WHERE c.id = orders.customer_id AND c.country = 'US')
  Or: JOIN customers c ON c.id = orders.customer_id WHERE c.country = 'US'

Performance consideration:
  If filtering by related entity is common, consider denormalization:
  Add customer_country column to orders table (updated by trigger or event)
  Then: WHERE customer_country = 'US' → direct index hit

Denormalization is acceptable when query performance outweighs write complexity.
```

### Sorting Design

**Basic sort:**

```
GET /orders?sort=created_at&order=desc
GET /orders?sort=-created_at  ← minus prefix for descending (GitHub convention)
GET /orders?sort_by=created_at&sort_direction=desc

Which convention?
  Explicit: sort=created_at&order=desc → most readable, verbose
  Prefix: sort=-created_at → concise, common in GitHub, Django REST Framework
  Best practice: be consistent across all endpoints in your API

SQL: ORDER BY created_at DESC
```

**Multi-field sort:**

```
GET /orders?sort=status,-created_at
// Sort by status ASC, then created_at DESC within each status group

SQL: ORDER BY status ASC, created_at DESC

Use case: show items grouped by status, newest in each group first.
Limit multi-sort to 2-3 fields maximum (beyond that, complexity outweighs value).
```

**Sort field whitelist:**

```javascript
const ALLOWED_SORT_FIELDS = new Set([
  "created_at",
  "price",
  "status",
  "customer_name",
  "id",
]);
const ALLOWED_SORT_DIRECTIONS = new Set(["asc", "desc"]);

const validateSort = (sortParam) => {
  if (!sortParam) return { field: "created_at", direction: "desc" }; // default

  const prefix = sortParam.startsWith("-") ? "desc" : "asc";
  const field = sortParam.replace(/^-/, "");

  if (!ALLOWED_SORT_FIELDS.has(field)) {
    throw new ApiError(
      400,
      "INVALID_SORT_FIELD",
      `Sort field '${field}' is not allowed. Valid fields: ${[...ALLOWED_SORT_FIELDS].join(", ")}`,
    );
  }

  return { field, direction: prefix };
};

// SQL construction using parameterized field name (safe — whitelist validated)
const query = `SELECT * FROM orders ORDER BY ${validated.field} ${validated.direction}`;
// Safe: field comes from whitelist, not user input directly
```

**Sort and cursor pagination compatibility:**

```
CRITICAL: The sort field MUST be included in the cursor.

Sort by price, paginate:
  GET /orders?sort=price&order=asc&limit=20
  Returns 20 orders, cheapest first. Cursor = {price: 49.99, id: 12345}

  Next page cursor query:
  WHERE (price, id) > (49.99, 12345)
  ORDER BY price ASC, id ASC
  LIMIT 20

Implication: the API must build the cursor from whatever fields are being sorted.
Default sort (created_at, id) is simplest.
Custom sort fields make cursor encoding more complex — encode all sort fields in cursor.
```

### Filter Query Design: Complex Expressions

**The problem: AND is easy, OR is hard**

```
Simple AND (most APIs support this):
  GET /orders?status=shipped&region=west
  → status = 'shipped' AND region = 'west'

OR (many APIs don't support this well):
  "Show orders that are either shipped OR processing"

  Option A: repeated param
  GET /orders?status=shipped&status=processing  (ambiguous)

  Option B: comma-separated
  GET /orders?status=shipped,processing
  → status IN ('shipped', 'processing')

  Option C: Named filter params
  GET /orders?status_any=shipped,processing  ("_any" suffix = OR semantics)

  Option D: Filter DSL (advanced, rarely needed in REST)
  GET /orders?filter=(status:shipped OR status:processing) AND region:west
  (Used by Elasticsearch, Salesforce SOSL — complex to implement and validate)

Best practice: for most REST APIs, support AND + IN (comma-separated = OR for same field).
Reserved for GraphQL: complex boolean filter expressions.
```

---

## SECTION 4 — Real-World API Contract & Request Flow

### MarketPulse — B2B Analytics API

MarketPulse serves business intelligence dashboards to 3,000 enterprise clients. Data: 500M market events per day. Clients filter, sort, and export market data.

```
CORE FILTER ENDPOINT:
──────────────────────────────────────────────────────────────────────────
GET /v1/events
──────────────────────────────────────────────────────────────────────────

Supported filter parameters:
  event_type       string or comma-separated list   e.g. trade,quote,order
  symbol           string or comma-separated list   e.g. AAPL,MSFT,GOOG
  market           string                           e.g. NYSE, NASDAQ
  min_volume       integer                          minimum trade volume
  max_volume       integer                          maximum trade volume
  occurred_after   ISO8601 datetime                 e.g. 2024-01-15T09:30:00Z
  occurred_before  ISO8601 datetime                 e.g. 2024-01-15T16:00:00Z
  min_price        decimal                          minimum price (cents)
  max_price        decimal                          maximum price (cents)

Supported sort parameters:
  sort             field name, prefix - for desc    e.g. -occurred_at, volume
  Allowed values:  occurred_at, volume, price, symbol (strict whitelist)

Pagination:
  limit            integer 1-10000, default 100
  cursor           opaque cursor for subsequent pages

Example request:
  GET /v1/events
    ?event_type=trade
    &symbol=AAPL,MSFT
    &occurred_after=2024-01-15T09:30:00Z
    &occurred_before=2024-01-15T16:00:00Z
    &min_volume=10000
    &sort=-occurred_at
    &limit=100

Response 200:
{
  "data": [
    {
      "id": "evt_f47ac10b-2b0a-4e2f",
      "event_type": "trade",
      "symbol": "AAPL",
      "price_cents": 18250,
      "volume": 52300,
      "market": "NASDAQ",
      "occurred_at": "2024-01-15T15:59:58Z"
    }
    // ... 99 more events
  ],
  "pagination": {
    "has_more": true,
    "next_cursor": "eyJvY2N1cnJlZF9hdCI6Ij...",
    "items_count": 100
  },
  "query_metadata": {
    "total_matched_estimate": 47382,  ← approximate count (cached)
    "filters_applied": ["event_type", "symbol", "occurred_after", "occurred_before", "min_volume"],
    "sort": "-occurred_at",
    "execution_time_ms": 12
  }
}
```

**Error responses for invalid filters:**

```json
// Invalid sort field:
GET /v1/events?sort=secret_internal_field
→ 400 Bad Request
{
  "error": "INVALID_SORT_FIELD",
  "message": "Sort field 'secret_internal_field' is not supported",
  "allowed_sort_fields": ["occurred_at", "volume", "price", "symbol"],
  "documentation": "https://api.marketpulse.com/docs/events#sorting"
}

// Invalid date range:
GET /v1/events?occurred_after=2024-01-15&occurred_before=2024-01-01
→ 400 Bad Request
{
  "error": "INVALID_DATE_RANGE",
  "message": "occurred_after must be before occurred_before",
  "occurred_after": "2024-01-15T00:00:00Z",
  "occurred_before": "2024-01-01T00:00:00Z"
}

// Too broad a query (no filters, would return all 500M events):
GET /v1/events?sort=-occurred_at
→ 400 Bad Request
{
  "error": "QUERY_TOO_BROAD",
  "message": "At least one filter is required (symbol, event_type, or time range)",
  "hint": "Add ?occurred_after=<ISO8601> to scope your query to a time range"
}
```

**Index design to support these filters:**

```sql
-- Time-range queries (most common)
CREATE INDEX idx_events_time ON events (occurred_at DESC, id DESC);

-- Symbol + time (most selective combination)
CREATE INDEX idx_events_symbol_time
  ON events (symbol, occurred_at DESC, id DESC);

-- Type + time
CREATE INDEX idx_events_type_time
  ON events (event_type, occurred_at DESC, id DESC);

-- Composite (symbol + type + time) for complex filters
-- But only create if query pattern justifies the storage cost
CREATE INDEX idx_events_symbol_type_time
  ON events (symbol, event_type, occurred_at DESC, id DESC);

-- PostgreSQL query planner chooses the best index per query.
-- Use EXPLAIN ANALYZE to verify index usage.
-- pg_stat_user_indexes to monitor which indexes are actually used.
```
