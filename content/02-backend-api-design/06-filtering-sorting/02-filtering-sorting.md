# Filtering & Sorting — Part 2 of 3

### Sections: 5 (Architecture Diagram), 6 (Production Scenarios), 7 (Scaling & Reliability), 8 (AWS Mapping)

**Series:** Backend & API Design → REST APIs → System Design

---

## SECTION 5 — Architecture & System Diagram

### MarketPulse Full Filtering Architecture

```
                    MARKETPULSE FILTERING & SORTING ARCHITECTURE
                    =============================================

Enterprise Client                     MarketPulse API
(Dashboard / SDK)
        │
        │  GET /v1/events?symbol=AAPL&event_type=trade
        │  &occurred_after=...&sort=-occurred_at
        ▼
┌──────────────────────────────────────────────────────────────┐
│                       CloudFront CDN                         │
│                                                              │
│  Cache keying strategy:                                      │
│  • All query params affect the response → include ALL in key │
│  • Normalize before caching:                                 │
│    symbol=AAPL,MSFT → sort params alphabetically → AAPL,MSFT│
│    (MSFT,AAPL and AAPL,MSFT are the same query)             │
│  • TTL: 5 minutes for market data (stale data acceptable)    │
│  • Bypass cache header: Cache-Control: no-cache              │
│  • Very high cache miss rate expected (each query unique)    │
│    → Mostly pass-through to origin for market data          │
└──────────────────────────┬───────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────┐
│                        API Gateway                           │
│                                                              │
│  Request validation (before hitting application):            │
│  • Verify Authorization (Bearer token → verify JWT)          │
│  • Rate limit: 1000 req/min per API key                      │
│  • Required filters enforcement (prevent unbounded queries): │
│    Must have: symbol OR event_type OR occurred_after         │
│  • Parameter coercion: ?limit=50000 → reject (max 10000)    │
│  • WAF: block parameter tampering / SQLi patterns           │
└──────────────────────────┬───────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────┐
│             Events API Service (Node.js / Go)                │
│                                                              │
│  FILTER VALIDATION LAYER:                                    │
│  1. Parse & type-check all params                            │
│  2. Whitelist sort fields                                    │
│  3. Validate date range (after < before, within 90-day max) │
│  4. Validate min ≤ max for range filters                     │
│  5. Sanitize comma-separated lists: deduplicate, max 50 items│
│                                                              │
│  QUERY BUILDER LAYER:                                        │
│  6. Construct parameterized WHERE clause                     │
│  7. Determine optimal query path:                            │
│     → Simple filters: PostgreSQL (Aurora)                    │
│     → Full-text search: Elasticsearch                        │
│     → Complex analytics: Athena (S3 Parquet)                │
│  8. Decode cursor (if provided)                              │
│  9. Append ORDER BY + LIMIT to query                         │
│                                                              │
│  EXECUTION LAYER:                                            │
│  10. Execute against appropriate data store                  │
│  11. Encode next_cursor from last result                     │
│  12. Return response + query_metadata                        │
└───────────────┬──────────────────┬───────────────┬──────────┘
                │                  │               │
                ▼                  ▼               ▼
┌──────────────────┐  ┌───────────────────┐  ┌──────────────┐
│  Aurora          │  │  Elasticsearch    │  │  Athena      │
│  PostgreSQL      │  │  (OpenSearch)     │  │  (S3 Parquet)│
│                  │  │                   │  │              │
│  Recent events:  │  │  Full-text:       │  │  Historical  │
│  last 90 days    │  │  ?q=wireless      │  │  analytics   │
│  (hot data)      │  │  Fuzzy matching   │  │  >90 days    │
│                  │  │  Relevance sort   │  │  Aggregates  │
│  Indexes:        │  │                   │  │              │
│  • symbol+time   │  │  Used for:        │  │  SQL on      │
│  • type+time     │  │  ?q= text search  │  │  Parquet     │
│  • time only     │  │  parameter        │  │  files       │
└──────────────────┘  └───────────────────┘  └──────────────┘

QUERY ROUTING DECISION:

  Request has ?q= (text search)?
    YES → Elasticsearch
    NO  → Is occurred_before > 90 days ago?
          YES → Athena (cold storage)
          NO  → Aurora PostgreSQL (hot storage)

  This routing is transparent to the API client.
  One endpoint, multiple backend systems, unified response format.

FILTER EXECUTION FLOW:

API Service                  Aurora PostgreSQL
    │                              │
    │─── Parameterized Query ──────▶
    │    SELECT id, symbol, ...    │
    │    FROM events               │
    │    WHERE symbol = ANY($1)    │ ← $1 = ['AAPL', 'MSFT']
    │    AND event_type = $2       │ ← $2 = 'trade'
    │    AND occurred_at > $3      │ ← $3 = timestamp
    │    AND occurred_at < $4      │ ← $4 = timestamp
    │    AND volume >= $5          │ ← $5 = 10000
    │    AND (occurred_at, id)     │
    │        < ($6, $7)            │ ← cursor (if provided)
    │    ORDER BY occurred_at DESC,│
    │             id DESC          │
    │    LIMIT $8                  │ ← limit+1
    │                              │
    │◀─── Result rows ─────────────│
    │    (using idx_symbol_time    │
    │     index, ~12ms)            │
```

---

## SECTION 6 — Production Scenarios

### Scenario A: Shopify's Filter Pattern — Structured Field Whitelists

Shopify's Admin API serves 1.7M merchants. Products endpoint:

```
GET /admin/api/2024-01/products.json
  ?status=active
  &product_type=Snowboard
  &vendor=Apple
  &title=iPhone
  &created_at_min=2021-01-01T10:00:00-04:00
  &created_at_max=2021-01-01T10:00:00-04:00
  &updated_at_min=2021-01-01T10:00:00-04:00
  &limit=250

Notable patterns:
  _min / _max suffix for range filters (consistent naming)
  Flat parameter structure (no nested objects in query string)
  limit max = 250 (enforced bound prevents abuse)
  No general-purpose ?q= search on the products list endpoint
  → Shopify has dedicated /search endpoints for full-text search
  → Keeps the filter endpoint predictable and fast (no search index needed)
```

The lesson: **separate concerns between filtering (exact/range match using DB indexes) and search (full-text using search index)**. One endpoint trying to do both introduces complexity and performance unpredictability.

---

### Scenario B: GitHub's Filter + Sort Excellence

GitHub serves 100M+ repositories with comprehensive filtering:

```
List repository issues:
GET /repos/{owner}/{repo}/issues
  ?state=open
  &labels=bug,enhancement  ← comma-separated, multi-value
  &assignee=username
  &creator=username
  &mentioned=username
  &milestone=1
  &since=2024-01-01T00:00:00Z
  &sort=created       ← values: created, updated, comments
  &direction=desc     ← asc or desc
  &per_page=30
  &page=1

Response headers (Link-based pagination):
  Link: <https://api.github.com/...&page=2>; rel="next"
  Link: <https://api.github.com/...&page=10>; rel="last"

GitHub patterns to copy:
1. Consistent filter field names across resources (state, created, updated used everywhere)
2. since parameter pattern for incremental sync
3. Explicit sort + direction (separate params — clear semantics)
4. Label filter uses repeated param OR comma-separated (flexible)
5. Link header for pagination (standard RFC 5988 — no proprietary pagination object)
```

---

### Scenario C: Elasticsearch — Filter DSL for Complex Queries

When REST query strings become insufficient for complex filter logic:

```javascript
// Elasticsearch filter DSL (when REST params aren't expressive enough)
// Used for: complex boolean logic, nested field filtering, aggregations

POST /events/_search
{
  "query": {
    "bool": {
      "must": [
        { "term": { "event_type": "trade" } },
        { "terms": { "symbol": ["AAPL", "MSFT"] } },
        { "range": { "occurred_at": { "gte": "2024-01-15T09:30:00Z" } } }
      ],
      "should": [
        { "term": { "market": "NYSE" } },
        { "term": { "market": "NASDAQ" } }
      ],
      "minimum_should_match": 1,
      "filter": [
        { "range": { "volume": { "gte": 10000 } } }
      ]
    }
  },
  "sort": [
    { "occurred_at": { "order": "desc" } },
    { "id": { "order": "desc" } }
  ],
  "size": 100,
  "search_after": ["2024-01-15T10:30:00Z", 12345]  ← cursor equivalent
}
```

When to route to Elasticsearch vs PostgreSQL:

- Full-text search (`?q=`) → Elasticsearch
- Relevance scoring (best match first) → Elasticsearch
- Faceted aggregations (counts by category) → Elasticsearch
- Simple field equality/range filters → PostgreSQL (cheaper, less infra)
- Joining across tables → PostgreSQL

---

## SECTION 7 — Scaling & Reliability

### Index Strategy for Filter Performance

Adding every possible filter combination as an index is wrong — indexes have write-amplification cost. Strategy:

```
Index selection framework:

1. MANDATORY: Index fields used in cursor (sort order + id)
   Rationale: every paginated query uses this
   Index: (sort_field DESC, id DESC)

2. HIGH PRIORITY: Equality filters on high-cardinality fields
   Rationale: filters that reduce result set by >90%
   Examples: (customer_id), (symbol), (tenant_id)
   Index: (customer_id, created_at DESC, id DESC)
   Compound: the sort fields follow the equality filter in the index

3. MEDIUM PRIORITY: Range filters on time fields
   Rationale: time filters are universal in APIs
   Index: (created_at DESC, id DESC)

4. LOW PRIORITY: Status/category filters alone
   Rationale: low cardinality (10 statuses) → filters by only 10%
   Strategy: combine with high-cardinality: (customer_id, status, created_at DESC, id DESC)
   Alone: (status) → scan 10% of table → might not help enough to justify index

5. AVOID: Index on free-text fields
   Rationale: full-text needs tsvector/Elasticsearch, not a regular B-tree index
   Use: CREATE INDEX ... USING GIN (to_tsvector('english', description))
        for full-text, otherwise route to Elasticsearch

Monitoring:
  SELECT * FROM pg_stat_user_indexes ORDER BY idx_scan ASC;
  → Indexes with idx_scan = 0: never used → drop them (they slow down writes for no gain)
  → Indexes with idx_scan > 1M/day: critical → ensure they stay
```

### The N+1 Problem in Filtered APIs

A subtle performance killer when filters trigger additional queries:

```
GET /orders?status=shipped&include=customer,shipping_address
→ Returns 100 orders... then for each order:
    SELECT * FROM customers WHERE id = ?      ← 100 queries
    SELECT * FROM addresses WHERE id = ?      ← 100 queries
= 201 total queries for one API request (N+1 problem)

Fix: eager loading with JOIN or batched fetch
  // PostgreSQL: JOIN
  SELECT o.*, c.name, c.email, a.street, a.city
  FROM orders o
  JOIN customers c ON c.id = o.customer_id
  JOIN addresses a ON a.id = o.shipping_address_id
  WHERE o.status = 'shipped'
  ORDER BY o.created_at DESC, o.id DESC
  LIMIT 101;

  OR batched:
  orderIds = [1, 2, 3, ...100]
  customers = SELECT * FROM customers WHERE id = ANY(orderIds)  ← 1 query, not 100
  addresses = SELECT * FROM addresses WHERE id = ANY(orderIds)  ← 1 query, not 100
  Map and merge in application code.
```

### Protecting Against Filter Abuse

```javascript
// Query complexity limiting — prevent clients from creating expensive queries

const MAX_FILTER_COMPLEXITY = 10;
const MAX_IN_CLAUSE_VALUES = 50;
const REQUIRED_NARROW_FILTER = true; // Must have at least one selective filter

const validateFilterComplexity = (filters) => {
  // Count total filter conditions applied
  let complexity = 0;

  // Date range: costs 1 unit
  if (filters.occurred_after || filters.occurred_before) complexity += 1;

  // Each symbol: costs 1 unit (index lookup per symbol)
  if (filters.symbols) {
    if (filters.symbols.length > MAX_IN_CLAUSE_VALUES) {
      throw new ApiError(
        400,
        "TOO_MANY_FILTER_VALUES",
        `Maximum ${MAX_IN_CLAUSE_VALUES} values allowed in symbol filter`,
      );
    }
    complexity += filters.symbols.length;
  }

  // Each additional filter type: costs 1 unit
  if (filters.event_type) complexity += 1;
  if (filters.market) complexity += 1;
  if (filters.min_volume || filters.max_volume) complexity += 1;

  if (complexity > MAX_FILTER_COMPLEXITY) {
    throw new ApiError(
      400,
      "QUERY_TOO_COMPLEX",
      "Filter combination is too complex. Reduce the number of symbols or filter conditions.",
    );
  }

  // Require at least one narrow filter
  if (REQUIRED_NARROW_FILTER && !filters.symbols && !filters.occurred_after) {
    throw new ApiError(
      400,
      "QUERY_TOO_BROAD",
      "At least one of: symbol or occurred_after is required",
    );
  }
};
```

### Caching Strategy for Filtered Queries

```
CHALLENGE: Every unique filter combination is a unique cache key.
  symbol=AAPL + event_type=trade + occurred_after=2024-01-15T09:30:00Z
  = unique key, very low cache hit rate

  This is why CDN caching doesn't help much for filtered APIs.

Strategy:

LAYER 1 — Application-level result cache (Redis)
  Key: hash(normalized_filter_params)
  TTL: short (30 seconds for real-time data, 5 minutes for analytics)
  Warming: pre-compute popular queries (top 100 symbol+type combinations)

  Cache key normalization:
  symbol=MSFT,AAPL&event_type=trade
  symbol=AAPL,MSFT&event_type=trade
  → Both normalize to: event_type=trade&symbol=AAPL,MSFT (sorted)
  → Same cache key → one hot path

LAYER 2 — Database query cache (Aurora read replicas)
  Route read queries to read replica → separate read/write load
  Aurora: 15 read replicas max, up to 10x the primary's connections
  Filter queries: always read-only → always go to read replica

LAYER 3 — Pre-materialized views (for dashboards)
  Common dashboard queries: "total trades by symbol for today"
  → Don't compute on the fly
  → Background job materializes every 5 minutes into Redis
  → Dashboard reads pre-computed aggregates (< 1ms) not raw events
```

---

## SECTION 8 — AWS Implementation

### API Gateway Request Validation

```yaml
# OpenAPI spec with API Gateway validation for filter params
/events:
  get:
    parameters:
      - name: symbol
        in: query
        schema:
          type: string
          pattern: "^[A-Z,]{1,200}$" # Only uppercase letters and commas, max 200 chars
      - name: sort
        in: query
        schema:
          type: string
          enum:
            [
              occurred_at,
              "-occurred_at",
              volume,
              "-volume",
              price,
              "-price",
              symbol,
              "-symbol",
            ]
      - name: limit
        in: query
        schema:
          type: integer
          minimum: 1
          maximum: 10000
          default: 100
      - name: occurred_after
        in: query
        schema:
          type: string
          format: date-time
      - name: min_volume
        in: query
        schema:
          type: integer
          minimum: 0
    # API Gateway validates before hitting Lambda
    # Invalid params → 400 returned by API GW, Lambda never invoked
    x-amazon-apigateway-request-validator: params-only
```

### Lambda Filter Handler with Parameterized SQL

```javascript
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.AURORA_URL });

const ALLOWED_SORT_MAP = {
  occurred_at: "occurred_at ASC",
  "-occurred_at": "occurred_at DESC",
  volume: "volume ASC",
  "-volume": "volume DESC",
  price: "price ASC",
  "-price": "price DESC",
};

export const handler = async (event) => {
  const params = event.queryStringParameters || {};

  // Validate sort
  const sortClause = ALLOWED_SORT_MAP[params.sort || "-occurred_at"];
  // API GW enum validation means we can trust this value

  const queryParams = [];
  const conditions = [];

  // Symbol filter (IN clause, parameterized)
  if (params.symbol) {
    const symbols = [...new Set(params.symbol.split(","))].slice(0, 50);
    queryParams.push(symbols);
    conditions.push(`symbol = ANY($${queryParams.length})`);
  }

  // Event type filter
  if (params.event_type) {
    const types = [...new Set(params.event_type.split(","))].slice(0, 20);
    queryParams.push(types);
    conditions.push(`event_type = ANY($${queryParams.length})`);
  }

  // Time range filters
  if (params.occurred_after) {
    queryParams.push(params.occurred_after);
    conditions.push(`occurred_at >= $${queryParams.length}`);
  }
  if (params.occurred_before) {
    queryParams.push(params.occurred_before);
    conditions.push(`occurred_at < $${queryParams.length}`);
  }

  // Volume range
  if (params.min_volume) {
    queryParams.push(parseInt(params.min_volume));
    conditions.push(`volume >= $${queryParams.length}`);
  }

  // Cursor (for keyset pagination)
  if (params.cursor) {
    const { occurred_at, id } = decodeCursor(params.cursor);
    queryParams.push(occurred_at, id);
    // Direction depends on sort order
    const op = sortClause.includes("DESC") ? "<" : ">";
    conditions.push(
      `(occurred_at, id) ${op} ($${queryParams.length - 1}, $${queryParams.length})`,
    );
  }

  const limit = Math.min(parseInt(params.limit || 100), 10000);
  queryParams.push(limit + 1); // +1 for has_more detection

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  // FULLY PARAMETERIZED — no string interpolation of user input
  // sortClause comes from whitelist map (safe)
  // conditions use $N placeholders (safe)
  const sql = `
    SELECT id, symbol, event_type, price_cents, volume, market, occurred_at
    FROM events
    ${whereClause}
    ORDER BY ${sortClause}, id ${sortClause.includes("DESC") ? "DESC" : "ASC"}
    LIMIT $${queryParams.length}
  `;

  const result = await pool.query(sql, queryParams);
  const rows = result.rows;
  const hasMore = rows.length > limit;
  if (hasMore) rows.pop();

  return {
    statusCode: 200,
    body: JSON.stringify({
      data: rows,
      pagination: {
        has_more: hasMore,
        next_cursor: hasMore ? encodeCursor(rows[rows.length - 1]) : null,
        items_count: rows.length,
      },
    }),
  };
};
```

### ElasticSearch (OpenSearch) for Full-Text Filter

```javascript
// When ?q= text search param is present, route to OpenSearch
import { Client } from "@opensearch-project/opensearch";

const os = new Client({ node: process.env.OPENSEARCH_ENDPOINT });

export const searchEvents = async ({
  q,
  symbols,
  occurred_after,
  sort,
  limit,
  search_after,
}) => {
  const must = [];
  const filter = [];

  // Full-text query
  if (q) {
    must.push({
      multi_match: {
        query: q,
        fields: ["symbol^3", "description", "market"],
        type: "best_fields",
      },
    });
  }

  // Structured filters (use filter context = no relevance scoring, cacheable)
  if (symbols?.length) filter.push({ terms: { symbol: symbols } });
  if (occurred_after)
    filter.push({ range: { occurred_at: { gte: occurred_after } } });

  const sortField = sort?.replace(/^-/, "");
  const sortDir = sort?.startsWith("-") ? "desc" : "asc";

  const body = {
    query: { bool: { must, filter } },
    sort: [
      { [sortField || "occurred_at"]: sortDir },
      { id: sortDir }, // tie-breaker
    ],
    size: limit + 1,
    ...(search_after && { search_after }), // cursor for OpenSearch
  };

  const response = await os.search({ index: "events", body });
  const hits = response.body.hits.hits;
  const hasMore = hits.length > limit;
  if (hasMore) hits.pop();

  return {
    data: hits.map((h) => h._source),
    has_more: hasMore,
    next_search_after: hasMore ? hits[hits.length - 1].sort : null,
  };
};
```

### CloudWatch Alarms for Filter Health

```javascript
// Metrics to emit for filter usage monitoring
const emitFilterMetrics = async (filters, executionMs, rowCount, dataStore) => {
  await cloudwatch.putMetricData({
    Namespace: "MarketPulse/Filtering",
    MetricData: [
      {
        MetricName: "FilterQueryDuration",
        Value: executionMs,
        Unit: "Milliseconds",
        Dimensions: [
          { Name: "DataStore", Value: dataStore }, // aurora, opensearch, athena
          { Name: "HasSymbolFilter", Value: String(!!filters.symbols) },
        ],
      },
      {
        MetricName: "FilterResultCount",
        Value: rowCount,
        Unit: "Count",
      },
      {
        MetricName: "UnboundedQueryAttempt",
        Value: !filters.symbols && !filters.occurred_after ? 1 : 0,
        Unit: "Count",
        // Alarm if > 0: validate logic should catch these, this metric catches gaps
      },
    ],
  });
};

// CloudWatch Alarms:
// P99 FilterQueryDuration > 1000ms → page on-call → investigate missing index
// UnboundedQueryAttempt > 0 → page security → investigate validation bypass
// FilterResultCount P99 > 50000 → page → abnormally large result sets
```
