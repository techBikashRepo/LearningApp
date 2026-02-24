# Filtering & Sorting — Part 3 of 3

### Sections: 9 (Interview Prep), 10 (Comparison Tables), 11 (Quick Revision), 12 (Architect Thinking Exercise)

**Series:** Backend & API Design → REST APIs → System Design

---

## SECTION 9 — Interview Preparation

### Beginner Questions

**Q1: Why should filtering happen on the server side, not the client side?**

_What the interviewer is testing:_ Fundamental understanding of where computation belongs.\*

**Ideal Answer:**

Filtering at the database layer is always preferable to filtering in application or client code because:

1. **Volume**: `GET /orders` might return 5 million rows without filtering. Transferring 5M rows to the client to filter for one customer's 47 orders is catastrophic — 10GB transfer vs 94KB.

2. **Indexes**: Databases have B-tree and other indexes specifically designed to find matching rows without scanning the entire table. `WHERE customer_id = 42` on an indexed column → O(log N) lookup. Client-side filter → O(N) scan of everything returned.

3. **Bandwidth**: Mobile clients on 4G have limited bandwidth. Transferring 10GB then filtering in the app will drain the battery and exhaust data plans.

4. **Memory**: An API server or client cannot hold 5M rows in memory without crashing. The database can handle this data volume because it wasn't loaded into RAM.

The principle: **push computation to where the data lives**. The database is optimized to filter. Use it.

---

**Q2: A client asks: "Can I just do GET /products and filter the results myself?" What do you say?**

_What the interviewer is testing:_ Ability to explain server-side filtering business value.\*

**Ideal Answer:**

"You can, but at scale it becomes impractical or impossible. Let me show you why."

For small datasets (< 1000 products), yes — it might work fine. But consider:

- **Today**: 1K products → `GET /products` returns 50KB → client filters → works
- **Year 2**: 100K products → `GET /products` returns 5MB → slower but manageable
- **Year 5**: 10M products → `GET /products` → never completes (timeout)

Also: pagination makes it impossible. When we paginate results (which we must at scale), you can only see 20 products per page. If you filter client-side on page 1, you miss products on pages 2-10,000. You'd need to download all 10M products to filter — which is exactly what I just said you can't do.

Server-side filtering with the right indexes means `GET /products?category=electronics` returns only the 2,341 electronics products instantly, without touching the other 9,997,659 rows.

---

**Q3: Why do we whitelist allowed sort fields instead of passing them directly to SQL ORDER BY?**

_What the interviewer is testing:_ Security awareness around injection vulnerabilities.\*

**Ideal Answer:**

SQL injection through `ORDER BY` is a real attack vector:

```
Client sends: GET /orders?sort=name; DROP TABLE orders;--

Without whitelist:
  SQL: SELECT * FROM orders ORDER BY name; DROP TABLE orders;--
  Result: parameter injection drops the table.

Even "safer" patterns still leak data:
  GET /orders?sort=IF(1=1,password,name)
  SQL: SELECT * FROM orders ORDER BY IF(1=1,password,name)
  → Sorts by password field, leaking data in sort order timing

With whitelist:
  Allowed: ['created_at', 'price', 'status', 'id']
  'name; DROP TABLE orders;--' not in allowed set → 400 error
  User-provided value never reaches SQL string
```

Also: whitelisting prevents accidentally exposing internal field names. An attacker requesting `sort=internal_score` or `sort=stripe_customer_id` would learn your schema. The whitelist controls what's visible.

Implementation: NEVER interpolate `ORDER BY ${userInput}`. Always use a whitelist Map: `const sqlSort = SORT_MAP[userInput]` where `SORT_MAP` is a trusted object.

---

### Intermediate Questions

**Q4: Design the filtering API for a multi-tenant SaaS application where each tenant can only see their own data. How do you prevent a tenant from filtering other tenants' data?**

_What the interviewer is testing:_ Security model for multi-tenant filtering.\*

**Ideal Answer:**

```
PATTERN: Tenant ID is NEVER a filter parameter — it's always derived from auth

WRONG approach:
  GET /orders?tenant_id=acme&status=shipped
  → Tenant sends any tenant_id → can query other tenants' data

RIGHT approach:
  JWT: { sub: "user_123", tenant_id: "acme_corp", roles: ["admin"] }

  Server extracts tenant_id from JWT (server-validated, cannot be tampered):
  const tenantId = req.auth.tenant_id;  // from verified JWT

  SQL: WHERE tenant_id = $1 AND status = $2
       Params: [tenantId, params.status]

  The tenant filter is injected BY THE SERVER, not read from user input.
  User cannot change it regardless of what they send in query params.

Additional defense:
  Even if tenant_id were somehow injectable, defense-in-depth:
  Row-level security in PostgreSQL:

  CREATE POLICY tenant_isolation ON orders
    USING (tenant_id = current_setting('app.current_tenant'));

  ALTER TABLE orders ENABLE ROW LEVEL SECURITY;

  Application: SET LOCAL app.current_tenant = 'acme_corp' at start of query
  PostgreSQL: automatically adds tenant_id filter to EVERY query on that table
  Even if application code forgets to add it, RLS catches it

Monitoring:
  Log every cross-tenant access attempt (if tenant_id in their request != JWT tenant_id)
  Alarm if any such attempt → potential account takeover attempt
```

---

**Q5: A PM asks you to add a "sort by relevance" feature to your product search. What changes does this require to your API and database architecture?**

_What the interviewer is testing:_ Understanding that relevance sorting requires different infrastructure.\*

**Ideal Answer:**

"Sort by relevance" requires full-text search, which is fundamentally different from B-tree indexed sorting:

```
Current architecture: PostgreSQL with columns indexed for B-tree ranges:
  ORDER BY price ASC → uses index → 8ms
  ORDER BY name ASC → uses index → 8ms
  ORDER BY relevance → no concept of relevance in PostgreSQL B-tree

What "relevance" actually means:
  User queries "wireless noise-cancelling headphones"
  Match scoring: Bose QC45 scores 0.95 (matches all 3 words in title+description)
                 Sony WH-1000XM5 scores 0.93
                 Generic AC headphones scores 0.20 (only "headphones" matches)
  Sort: highest score first

Required changes:

1. DATA LAYER: Add Elasticsearch/OpenSearch index
   Products are DUAL-WRITTEN: PostgreSQL (source of truth) + Elasticsearch (search index)
   Elasticsearch stores: product title, description, tags, brand, category
   Elasticsearch computes: TF-IDF or BM25 relevance score per query

2. API LAYER: Route based on sort param
   ?sort=price → PostgreSQL query → O(log N), 8ms
   ?sort=relevance → Elasticsearch query → 50-100ms (acceptable for search)
   ?sort=created_at → PostgreSQL query → O(log N), 8ms

   Uniform response format regardless of backend used.

3. SYNC: Keep Elasticsearch in sync with PostgreSQL
   Option A: Dual-write on product create/update (synchronous)
   Option B: Change Data Capture (CDC) — Debezium reads PostgreSQL WAL → streams to Elasticsearch
   CDC is preferred: no chance of forgetting to update search index, decoupled

4. PAGINATION: Elasticsearch uses search_after (cursor-based) for pagination
   Elasticsearch's sort-by-relevance + cursor requires consistent sort keys
   Add ?cursor handling for Elasticsearch search_after values

Estimated timeline: 2-3 weeks for basic implementation, 1-2 months for production quality.
```

---

### Advanced Question

**Q6: You have a geospatial query requirement: "Find all restaurants within 5km of a user's location, sorted by distance." How do you design the API filter and implement it efficiently?**

_What the interviewer is testing:_ Specialized filter types beyond simple B-tree.\*

**Discussion:**

```
API DESIGN:
GET /restaurants
  ?lat=37.7749
  &lng=-122.4194
  &radius_km=5
  &sort=distance
  &cuisine=italian
  &min_rating=4.0

Response includes computed distance:
{
  "data": [
    {
      "id": "rest_123",
      "name": "Trattoria Milano",
      "cuisine": "italian",
      "rating": 4.7,
      "distance_meters": 342,
      "location": { "lat": 37.772, "lng": -122.416 }
    }
  ]
}

DATABASE IMPLEMENTATION — PostgreSQL with PostGIS:

CREATE EXTENSION IF NOT EXISTS postgis;

ALTER TABLE restaurants
  ADD COLUMN location GEOGRAPHY(POINT, 4326);

UPDATE restaurants SET location = ST_MakePoint(longitude, latitude)::geography;

CREATE INDEX idx_restaurants_location
  ON restaurants USING GIST(location);

Query:
  SELECT
    id, name, cuisine, rating,
    ST_Distance(location, ST_MakePoint($1, $2)::geography) AS distance_meters
  FROM restaurants
  WHERE
    ST_DWithin(
      location,
      ST_MakePoint($1, $2)::geography,  -- user's location
      $3 * 1000                          -- radius in meters
    )
    AND cuisine = $4     -- combine with regular filters
    AND rating >= $5
  ORDER BY distance_meters ASC, id ASC
  LIMIT $6;

ST_DWithin uses the GIST index → O(log N) spatial lookup.
Without index: full table scan, computing distance for every restaurant → O(N).

AWS ALTERNATIVE: Amazon Location Service
  If PostGIS setup is too heavy (serverless, no RDS control):
  → Store restaurant locations in DynamoDB
  → Use Amazon Location Service geocoding + routing APIs
  → Lambda: call Location Service for proximity search, then filter DynamoDB by returned IDs

CURSOR FOR GEOSPATIAL PAGINATION:
  Sort by distance means the cursor must encode distance + id:
  cursor = {distance_meters: 342, id: "rest_123"}
  Next page: WHERE distance_meters > 342 OR (distance_meters = 342 AND id > 'rest_123')
  Note: distance changes if the database record's location is updated.
  Use id + snapshot distance in cursor (distance at time of first query, not recomputed).
```

---

## SECTION 10 — Comparison Tables

### Filter Parameter Naming Conventions

| Pattern                      | Example                         | Used By                | Pros                        | Cons                               |
| ---------------------------- | ------------------------------- | ---------------------- | --------------------------- | ---------------------------------- |
| **min*/max* prefix**         | `min_price=100&max_price=500`   | Django REST, Shopify   | Intuitive, natural language | Verbose                            |
| **\_gte/\_lte suffix**       | `price_gte=100&price_lte=500`   | Stripe, DRF            | Chainable, database-like    | Unfamiliar to non-devs             |
| **[after/before] for dates** | `created_after=2024-01-01`      | GitHub, Stripe         | Semantic, natural           | Time-specific convention           |
| **Bracket notation**         | `status[]=open&status[]=closed` | PHP, Ruby on Rails     | Explicit multi-value        | URL-encoding complexity            |
| **Comma-separated**          | `status=open,closed`            | Stripe, GitHub         | Concise                     | Ambiguous if values contain commas |
| **Filter DSL in body**       | POST body with filter object    | GraphQL, Elasticsearch | Arbitrarily complex         | Not RESTful (GET with body)        |

### Filtering Approach by Use Case

| Use Case             | Recommended Approach                             | Backend                           | Why                             |
| -------------------- | ------------------------------------------------ | --------------------------------- | ------------------------------- |
| Exact field match    | `?status=active`                                 | PostgreSQL index                  | Simple, indexed, fast           |
| Range filter         | `?min_price=100&max_price=500`                   | PostgreSQL range                  | B-tree covers range scans       |
| Multi-value OR       | `?status=open,closed`                            | PostgreSQL IN                     | `ANY($1)` with array            |
| Full-text search     | `?q=wireless headphones`                         | Elasticsearch                     | Relevance scoring, tokenization |
| Geospatial radius    | `?lat=37.7&lng=-122.4&radius_km=5`               | PostGIS / Amazon Location         | GIST spatial index              |
| Nested field filter  | `?customer.country=US`                           | JOIN query or denormalized column | Index on denormalized field     |
| Complex boolean      | `(status:open AND region:west) OR priority:high` | Elasticsearch/GraphQL             | Boolean logic needs query DSL   |
| Faceted aggregations | `GET /products?facets=category,brand`            | Elasticsearch aggregations        | Bucket aggregations             |

### Sort Field Conventions

| Convention            | Example                        | Used By                 | Notes                         |
| --------------------- | ------------------------------ | ----------------------- | ----------------------------- |
| **Separate params**   | `sort=price&order=desc`        | Shopify, many REST APIs | Explicit, verbose             |
| **Minus prefix**      | `sort=-price`                  | GitHub, Django REST     | Concise, widely adopted       |
| **Plus/minus prefix** | `sort=+price` or `sort=-price` | Some APIs               | + rarely used, minus standard |
| **Dot notation**      | `sort=created_at.desc`         | Custom APIs             | Less common                   |
| **Multiple fields**   | `sort=-status,created_at`      | GitHub, DRF             | Comma-separated multi-sort    |

---

## SECTION 11 — Quick Revision

### 10 Key Takeaways

1. **Always filter at the database**: Network bandwidth, memory, and CPU all favor pushing filter predicates into SQL WHERE clauses. Never return all rows and filter in application code at scale.

2. **Whitelist sort fields, always**: `ORDER BY ${userInput}` is SQL injection. Map user-provided sort names to whitelisted SQL fragments. The user value never touches the SQL string directly.

3. **Separate filtering from full-text search**: Equality/range filters belong in PostgreSQL with B-tree indexes. Text search (`?q=`) belongs in Elasticsearch. They're different problems requiring different solutions.

4. **Tenant ID comes from JWT, never from query params**: Multi-tenant security means the server injects the tenant filter from the authenticated token — users can never filter other tenants' data.

5. **Composite indexes follow the filter order**: If you filter by `customer_id` and sort by `created_at`, the index should be `(customer_id, created_at DESC, id DESC)` — equality filter first, sort columns follow.

6. **Count unused indexes**: `SELECT * FROM pg_stat_user_indexes WHERE idx_scan = 0` finds indexes that are never used. Every unused index costs write performance with no read benefit — drop them.

7. **Prevent unbounded queries**: Require at least one selective filter, or implement query complexity scoring. A filter API without required bounds query is a full table scan waiting to happen.

8. **AND semantics for multiple params, OR via comma-separated**: `?status=open&region=west` = AND. `?status=open,closed` = OR (IN clause). Document this clearly. Stripe and GitHub use this convention.

9. **Normalize filter params before caching**: Sort comma-separated values alphabetically before using as cache key. `symbol=MSFT,AAPL` and `symbol=AAPL,MSFT` are the same query — should share a cache entry.

10. **Geospatial filters need spatial indexes**: PostGIS GIST index enables O(log N) `ST_DWithin` queries. Without the spatial index, every `radius_km` query scans the entire table.

### 30-Second Explanation

"Filtering and sorting are how REST APIs return relevant subsets of data in a specific order. Filters map to SQL WHERE clauses — always parameterized, with whitelisted field names to prevent injection. Sort parameters map to ORDER BY, always from a whitelist, never interpolated directly. Multiple filter params default to AND; comma-separated values in one param mean OR (IN clause). For text search use Elasticsearch, not LIKE. For geospatial radius, use PostGIS with a spatial index. The golden rule: all filtering happens at the database layer, with indexes — never return all data and filter in application or client code."

### Memory Tricks

**"WISP" — filter safety checklist:**

- **W**hitelist: only allow known field names for sort
- **I**nject via params: all values via `$N` placeholders, never string interpolation
- **S**erver-side: filtering happens on the DB, not in application memory
- **P**ush down: computation lives where the data lives

**"LIKE is Lethal"** — never use `LIKE '%text%'` for real search

- LIKE = full table scan, no index
- Use full-text: `to_tsvector` (PostgreSQL) or Elasticsearch

**Sort direction: "minus means most recent / most"**

- `-created_at` = newest first (descending)
- `-price` = most expensive first (descending)
- `price` = cheapest first (ascending)

---

## SECTION 12 — Architect Thinking Exercise

### The Problem

You're the API architect at **TalentHub**, a recruiting platform connecting 50,000 companies with candidates. The talent search API is the core product:

Current state:

- `GET /candidates` with basic filtering: `?skills=python,react&min_experience=3&location=remote`
- Table: 8 million candidate profiles
- Top companies run talent searches every 2 minutes, automated, during business hours
- P50 response time: 340ms. P99: 8,200ms (unacceptable)
- Candidate profiles contain: skills (array), experience (years), location, salary expectation, availability, languages, recent job title, summary text

**Issues reported:**

1. Recruiters want: "Search for backend engineers with Python and Kubernetes, NOT PHP, within 50km of Seattle, sorted by 'best match' to a job description" — current API cannot handle this
2. Database CPU spikes to 95% during morning hours (simultaneous talent searches)
3. A recruiter accidentally sent `GET /candidates` without any filters — returned all 8M candidates, crashed the API server (OOM error)
4. Skills filter uses `LIKE '%python%'` — returns "Python-lovers" and "Monty Python fans" equally

**Your task:**

1. Fix the unbounded query vulnerability immediately
2. Redesign the filter API to support the recruiter requirements
3. Architect the backend for the "best match" relevance sort
4. Design the indexing strategy

---

_Think through the design. Then read the solution._

---

### Solution

#### 1. Immediate Fix (Unbounded Query)

```javascript
// Emergency middleware — deploy in < 1 hour
const requireSelectiveFilter = (req, res, next) => {
  const { skills, location, min_experience, title, q, company_type } =
    req.query;
  const hasFilter =
    skills || location || min_experience || title || q || company_type;

  if (!hasFilter) {
    return res.status(400).json({
      error: "QUERY_TOO_BROAD",
      message:
        "At least one filter is required: skills, location, title, or q (text search)",
      documentation:
        "https://api.talenthub.com/docs/candidates#required-filters",
    });
  }
  next();
};

// Also: add hard limit to prevent huge responses even with filter
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;
```

#### 2. Redesigned Filter API

```
GET /v2/candidates
  Query Parameters:

  INCLUSION FILTERS (must have, at least one):
    skills_all      comma-separated   all skills must match (AND)   e.g. python,kubernetes
    skills_any      comma-separated   any skill matches (OR)        e.g. react,vue,angular
    title           string            current/recent job title      e.g. backend+engineer
    q               string            full-text search on summary+title

  EXCLUSION FILTERS:
    skills_not      comma-separated   exclude candidates with skill e.g. php,cobol

  RANGE FILTERS:
    min_experience  integer           years of experience minimum   e.g. 3
    max_experience  integer           years of experience maximum   e.g. 10
    min_salary      integer           minimum salary expectation    e.g. 100000
    max_salary      integer           maximum salary expectation    e.g. 200000

  LOCATION:
    location        string OR "remote"                              e.g. remote, Seattle+WA
    lat             decimal           for radius search             e.g. 47.6062
    lng             decimal           for radius search             e.g. -122.3321
    radius_km       integer           combined with lat/lng         e.g. 50

  CATEGORICAL:
    availability    available, open, not-looking
    languages       comma-separated spoken languages                e.g. english,spanish

  SORT:
    sort  = best_match | experience | salary | recently_active
    (best_match requires q= or job_description= to be meaningful)

  Example — recruiter's complex request:
  GET /v2/candidates
    ?skills_all=python,kubernetes
    &skills_not=php
    &lat=47.6062&lng=-122.3321&radius_km=50
    &sort=best_match
    &q=backend+engineer+microservices
    &min_experience=3
    &availability=available

  Canonical form (internal routing):
    Has ?q= OR ?sort=best_match → Elasticsearch
    Otherwise → PostgreSQL
```

#### 3. Backend Architecture

```
DUAL DATA STORE:

PostgreSQL (Aurora):
  candidates table
  skills stored as JSONB array: {"skills": ["python", "kubernetes", "go"]}

  Index for skills:
  CREATE INDEX idx_candidates_skills ON candidates USING GIN(skills jsonb_path_ops);
  Query: WHERE skills ?& array['python','kubernetes']  -- contains all (AND)
         WHERE skills ?| array['react','vue','angular'] -- contains any (OR)
         WHERE NOT (skills ? 'php')                     -- excludes skill

  Index for location radius:
  CREATE INDEX idx_candidates_location ON candidates USING GIST(location);

  Use for: range filters + skills (no text search, no relevance sort)

Elasticsearch (OpenSearch):
  Candidate documents indexed with:
    - title, summary, skills_text (searchable text)
    - skills [array] (keyword field for exact match + aggregations)
    - experience (integer, filterable)
    - location (geo_point for radius filter)
    - availability (keyword)

  Use for: ?q= text search + best_match sort (BM25 scoring)

  Combined query (ES handles both relevance AND structured filters):
  {
    "query": {
      "bool": {
        "must": [{ "match": { "summary": "backend engineer microservices" } }],
        "filter": [
          { "terms": { "skills": ["python", "kubernetes"] } },
          { "geo_distance": { "distance": "50km", "location": { "lat": 47.6, "lon": -122.3 } } },
          { "range": { "experience": { "gte": 3 } } }
        ],
        "must_not": [{ "term": { "skills": "php" } }]
      }
    },
    "sort": ["_score", { "recently_active": "desc" }]
  }

SYNC strategy:
  CDC via Debezium: PostgreSQL WAL → Kafka → Elasticsearch indexer
  Latency: ~10 seconds (acceptable for talent profiles)
  Source of truth: PostgreSQL
```

#### 4. Indexing Strategy

```
PostgreSQL indexes:
  1. (skills jsonb_path_ops) GIN index     ← skills_all, skills_any, skills_not
  2. GIST(location)                         ← lat/lng radius filter
  3. (experience DESC, id DESC)             ← sort by experience
  4. (availability, experience DESC, id DESC)  ← availability filter + sort
  5. (salary_min, id DESC)                  ← salary range filter

Elasticsearch mapping:
  skills: keyword (exact match) + text (analyzed for full-text)
  title: text (analyzed) with keyword sub-field for exact sort
  summary: text (analyzed, BM25 full-text)
  location: geo_point (enables geo_distance filter)
  experience: integer (range filter)
  availability: keyword (exact filter)

Monitor:
  CloudWatch: P50/P99 search latency by route (postgres vs elasticsearch)
  Alert: if postgres route P99 > 500ms → review indexes
  Alert: if elasticsearch route P99 > 2000ms → review ES cluster sizing

CPU spike solution:
  Route search queries to Aurora Read Replica (separate from write traffic)
  Elasticsearch cluster scales horizontally (add data nodes during peak hours)
  Auto-scaling: CloudWatch CPU > 60% → add ES data node → scale down at 20%
```

#### Core Principle

```
The key insight in this exercise:
  "Different filter types require different backend systems.
   Fields/range filters: PostgreSQL with B-tree/GIN/GIST indexes.
   Full-text + relevance: Elasticsearch.

   One API endpoint, intelligent routing, unified response format.
   The client doesn't need to know or care which backend answered."

The unbounded query crash was a validation gap, not a query optimization problem.
Always validate that at least one filter is present before executing any database query.
```
