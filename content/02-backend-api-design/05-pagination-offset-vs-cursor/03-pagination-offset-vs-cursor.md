# Pagination (Offset vs Cursor) — Part 3 of 3

### Sections: 9 (Interview Prep), 10 (Comparison Tables), 11 (Quick Revision), 12 (Architect Thinking Exercise)

**Series:** Backend & API Design → REST APIs → System Design

---

## SECTION 9 — Interview Preparation

### Beginner Questions

**Q1: What is pagination and why does every list endpoint need it?**

_What the interviewer is testing:_ Foundational understanding of why we paginate.\*

**Ideal Answer:**

Pagination is splitting a large result set into smaller pages that are fetched incrementally, rather than returning all results at once.

Every list endpoint needs it because:

1. **Database**: Full table scans return millions of rows, taking seconds or minutes
2. **Network**: Returning 10M records in one response transfers gigabytes of data
3. **Memory**: API server runs out of RAM trying to hold 10M JSON objects
4. **Client**: Browser crashes; mobile app throws OOM error on 10M items
5. **User**: No human can process 10M items in one view

Without pagination, any API endpoint that returns a growing collection will eventually fail. A startup might handle 10K users without pagination, but at 100K users the endpoint times out and the business is in crisis.

---

**Q2: What is the difference between `LIMIT 20 OFFSET 40` and cursor-based pagination?**

_What the interviewer is testing:_ Precise SQL understanding.\*

**Ideal Answer:**

```
LIMIT 20 OFFSET 40:
  Database instruction: "scan from the beginning, skip the first 40 rows, return 20"
  → Database scans ALL 40 rows to discard them
  → For OFFSET 100,000: database scans 100,020 rows, discards 100,000, returns 20
  → Performance degrades linearly: O(N) where N = offset

Cursor pagination (keyset):
  Client says: "give me 20 records after the record with id=12345"
  SQL: WHERE id > 12345 ORDER BY id LIMIT 20
  → Database uses index seek: jump directly to id=12345 using B-tree index
  → Fetches only the 20 records needed
  → O(log N) regardless of depth

Analogy:
  OFFSET = counting from page 1 of a book every time
  Cursor = using a bookmark to jump to the exact page
```

---

**Q3: Your API returns a `total_count` field in every paginated response. A DBA says this is killing performance. Why, and what's the fix?**

_What the interviewer is testing:_ Understanding the performance cost of COUNT queries.\*

**Ideal Answer:**

A `SELECT COUNT(*) FROM orders WHERE user_id=42` query must scan every row matching that condition to count them. On a table with millions of rows, this can take hundreds of milliseconds — and you're running it on EVERY paginated request.

Example: 50M orders table, user has 10K orders:

```
SELECT count(*) FROM orders WHERE user_id = 42;
→ scans all 10K orders for user 42
→ ~45ms per request
→ At 1,000 req/sec: 45ms × 1,000 = 450 CPU-seconds/second dedicated to counting
```

Fixes:

1. **Cache the count**: Background job runs `COUNT(*)` every 5 minutes → stores in Redis → API reads from Redis (1ms). Show "~10,247 orders (updated 3 minutes ago)".
2. **Use approximate count**: PostgreSQL's `pg_class.reltuples` (updated by VACUUM) is fast and accurate within 10-20%. Good enough for "showing ~10K results".
3. **Drop the total count**: Cursor pagination with `has_more: true/false` is often sufficient. Twitter, Stripe, GitHub don't show total counts on most endpoints.
4. **Async count + optimistic UI**: Return page immediately, total count arrives in a separate async query response.

The business question: does the user NEED to know "10,247 orders"? For a search results page showing "~10K results" — approximate is fine. For an invoice "you have 247 unpaid charges" — exact count needed (use cached/precomputed).

---

### Intermediate Questions

**Q4: Explain the "ghost record" problem with offset pagination and how cursor pagination solves it.**

_What the interviewer is testing:_ Understanding the correctness issues of offset pagination.\*

**Ideal Answer:**

```
GHOST RECORD PROBLEM:

Page 1 (OFFSET 0): User sees records A, B, C, D, E  (D and E will be on page 2 too?)
                    ↓
Concurrent delete: Record B is deleted from the database.
                    ↓
Page 2 (OFFSET 5): Records that WERE at positions 6-10 are now at positions 5-9.
                    The user SKIPS record F (it was at position 6, now at 5,
                    but the user starts from position 6 → misses it).

Similarly, if a new record A0 is INSERTED at the top:
                    Records shift forward by 1.
                    OFFSET 5 now shows the last record from page 1 again → DUPLICATE.

CURSOR SOLVES IT:

User's cursor = ID of the last record seen (regardless of position).
New records at top? User's cursor still points to the right record.
Deletions below cursor? Unaffected — cursor seeks by ID, not by position.

Example:
  Page 1: User sees records 1,2,3,4,5. Cursor = 5.
  Record 3 is deleted.
  Page 2: WHERE id > 5 → returns records 6,7,8,9,10. Correct.
  No skipping. No duplicates.

Trade-off: Cursor pagination cannot support "jump to page 47" or random access.
           Perfect for infinite scroll; not suitable for "page X of Y" navigation.
```

---

**Q5: Design pagination for a notification inbox where users need both "load more older notifications" and "check for newer notifications since I last loaded."**

_What the interviewer is testing:_ Bi-directional cursor pagination.\*

**Ideal Answer:**

```
This requires TWO cursors:
  1. before_id cursor: for loading older notifications (scroll down)
  2. after_id cursor: for checking newer notifications (refresh/polling)

API design:
  GET /v1/notifications?limit=20
    → returns newest 20 notifications
    → response includes:
      { oldest_id: 150, newest_id: 169 }

  LOAD OLDER (scroll down, infinite scroll):
  GET /v1/notifications?limit=20&before_id=150
    → SQL: WHERE id < 150 ORDER BY id DESC LIMIT 20
    → returns notifications 130-149
    → new oldest_id = 130

  POLL FOR NEWER (refresh on app resume):
  GET /v1/notifications?after_id=169
    → SQL: WHERE id > 169 ORDER BY id ASC
    → returns NEW notifications 170, 171, 172...
    → no limit (or large limit) — user wants all new notifications
    → response: { unread_count: 3, notifications: [...] }

Client stores both newest_id (for polling) and oldest_id (for scroll).
Polling uses after_id. Scrolling uses before_id.

Stripe uses this pattern: starting_after and ending_before parameters.
GitHub uses this: since and until parameters on events endpoints.
```

---

### Advanced Question

**Q6: You inherit an e-commerce system with 200M orders. The existing API uses offset pagination. Deep pages (page > 1000) now take 15+ seconds. You cannot do a full rewrite. Design an incremental migration to cursor-based pagination while keeping backward compatibility for existing clients.**

_What the interviewer is testing:_ Real-world migration planning, backward compatibility, feature flags.\*

**Complete Migration Plan:**

```
ANALYSIS FIRST:
  Monitor existing usage: what pages are clients actually requesting?
  Often: >90% usage is page 1-10. Page > 100 is rare, > 1000 is negligible except bots.

PHASE 1: Emergency stop-gap (Week 1)
  Add hard limit: return 400 if offset > 100,000 (page > 5000 at 20/page)
  Stops the worst queries immediately.
  Add Retry-After header suggesting the use of search to narrow results.

PHASE 2: Deferred join optimization (Week 2)
  Replace current query with deferred join (no API change):

  BEFORE: SELECT * FROM orders WHERE user_id=? ORDER BY created_at LIMIT 20 OFFSET ?
  AFTER:  SELECT o.*
          FROM (
            SELECT id FROM orders WHERE user_id=? ORDER BY created_at LIMIT 20 OFFSET ?
          ) sub JOIN orders o ON o.id = sub.id

  3-10x faster for any offset depth. Zero API changes. Deploy as hotfix.

PHASE 3: Add cursor endpoint (Month 1-2)
  Add NEW endpoint: GET /v2/orders with cursor-based pagination.
  Old endpoint: GET /v1/orders (unchanged, offset-based).
  New SDK, documentation, migration guide for clients.

PHASE 4: Hybrid endpoint (Month 2-3)
  On GET /v1/orders, add optional cursor support:

  If cursor param provided → use keyset internally (fast)
  If page param provided → use offset internally (slow but compatible)

  Add X-Pagination-Type: cursor response header to new clients.
  Response body adds (but doesn't break): "next_cursor": "eyJ..."
  Old clients ignore the new field (JSON is additive).

PHASE 5: Deprecation (Month 3-6)
  Add Deprecation header on deep offset requests:
    Deprecation: true
    Sunset: Sat, 31 Dec 2025 23:59:59 GMT
    Link: <https://api.productstream.com/migration/cursor>; rel="deprecation"

  Monitor X-API-Version headers — when no clients use offset-only paths, sunset.

PHASE 6: Index optimization
  Add cursor-optimized index (can be done in Phase 1 with CONCURRENTLY):
  CREATE INDEX CONCURRENTLY idx_orders_cursor ON orders (user_id, created_at DESC, id DESC);
  CONCURRENTLY = no table lock, runs in background, safe for production.
```

---

## SECTION 10 — Comparison Tables

### Offset vs Cursor: Complete Comparison

| Dimension                          | Offset Pagination                  | Cursor Pagination                     |
| ---------------------------------- | ---------------------------------- | ------------------------------------- |
| **SQL**                            | `LIMIT N OFFSET M`                 | `WHERE (col, id) < (val, id) LIMIT N` |
| **Performance at scroll depth**    | O(N) — degrades with depth         | O(log N) — constant                   |
| **Random page access**             | ✅ Yes (`?page=47`)                | ❌ No                                 |
| **Total count support**            | ✅ Yes (expensive)                 | ❌ No (or approximate)                |
| **Stable under concurrent writes** | ❌ Gap/duplicate risk              | ✅ Stable                             |
| **Implementation complexity**      | Low                                | Medium                                |
| **Good for**                       | Admin UIs, small datasets, reports | Feeds, sync APIs, infinite scroll     |
| **Max practical depth**            | ~10K rows                          | Unlimited                             |
| **URL bookmarkable**               | ✅ Yes (`/page=3` works)           | ❌ Cursors expire                     |
| **Pagination direction**           | Both (prev/next)                   | Both (with two cursors)               |

### Cursor Storage Options

| Cursor Type         | Example                            | Pros                                | Cons                              |
| ------------------- | ---------------------------------- | ----------------------------------- | --------------------------------- |
| **Opaque base64**   | `eyJ1cGRhdGVkX2F0IjoiMjAyNCI...`   | Schema agnostic, extensible, secure | Verbose                           |
| **Integer ID**      | `after=12345`                      | Simple, readable, debuggable        | Exposes internal IDs              |
| **Timestamp**       | `after=2024-01-15T10:30:00Z`       | Human readable                      | Collision risk on same timestamp  |
| **Compound: ts+id** | `after=2024-01-15T10:30:00Z:12345` | Accurate, human-readable            | Encoding edge cases, URL encoding |
| **DynamoDB key**    | `{"PK":"USER#42","SK":"ORD#100"}`  | Native to DynamoDB                  | DB-specific, not portable         |

### When to Use Each Approach

| Scenario                      | Recommendation                    | Reason                                                 |
| ----------------------------- | --------------------------------- | ------------------------------------------------------ |
| Admin panel with page numbers | Offset                            | User expects "page 3 of 47", random access, small data |
| Social feed (infinite scroll) | Cursor                            | Real-time updates, deep scrolling, performance         |
| Bulk data export/sync         | Cursor                            | Must traverse all records efficiently                  |
| Search results (< 100 pages)  | Offset                            | Stable results (search snapshots), total count needed  |
| Real-time event log           | Cursor                            | Events always growing, no random access needed         |
| Report with "row 1-50 of 250" | Offset + cached count             | User needs total, count is cacheable                   |
| Webhook replay                | Cursor                            | Sequential, all records needed, unbounded              |
| Autocomplete dropdown         | Neither (limit=10, no pagination) | User sees top 10, refines query to narrow              |

---

## SECTION 11 — Quick Revision

### 10 Key Takeaways

1. **Offset pagination scans ALL rows up to the offset**: `LIMIT 20 OFFSET 10000` makes the database scan 10,020 rows and discard 10,000. Performance is O(N) — gets slower with page depth.

2. **Cursor pagination seeks by index**: `WHERE id > 12345 LIMIT 20` uses a B-tree index seek — O(log N). Constant performance at any depth.

3. **Offset has the ghost record problem**: Concurrent inserts/deletes while a user paginates causes duplicate or skipped records. Cursor pagination is immune because it anchors to a specific record, not a position.

4. **`SELECT COUNT(*) is expensive`**: A full count requires scanning all matching rows. Cache it with Redis (5-minute TTL). For cursor pagination, use `has_more: true/false` instead of total count.

5. **Fetch LIMIT+1 to detect has_more**: Request `LIMIT 21` when client asks for 20. If you get 21 rows → `has_more: true`, return first 20. Avoids a separate COUNT query.

6. **Encode cursors opaquely (base64url)**: Never expose raw DB fields in cursors. Encoding allows schema changes without breaking existing cursors, and prevents clients from constructing arbitrary cursors.

7. **Always include a secondary sort key**: `ORDER BY created_at DESC` breaks if two records share the same timestamp. Use `ORDER BY created_at DESC, id DESC`. The compound key makes the cursor unambiguous.

8. **Use immutable fields for sort order**: Sort by `created_at` (never changes) not `updated_at` (changes on every update). A cursor based on `updated_at` immediately becomes invalid when the record is modified.

9. **DynamoDB only supports cursor pagination**: No `OFFSET` in DynamoDB. `LastEvaluatedKey` IS the cursor. This is a design feature — DynamoDB is optimized for cursor-style key lookups.

10. **Deferred join is the emergency fix for offset pain**: `SELECT * FROM (SELECT id FROM t ORDER BY col LIMIT 20 OFFSET 100000) sub JOIN t ON t.id = sub.id` — indexes narrow IDs first, then fetches full rows for only 20. 3-10x faster, zero API changes.

### 30-Second Explanation

"Pagination splits large result sets into pages. Offset pagination uses `LIMIT M OFFSET N` — simple, supports random page access, but performance degrades because the database scans all rows up to the offset. At deep pages (OFFSET 100,000+), queries take seconds. Cursor pagination uses a keyset: `WHERE id > last_seen_id LIMIT N` — the database does an index seek to the cursor position and returns exactly N rows. O(log N) at any depth. Trade-off: cursor pagination can't support `jump to page 47` or total counts efficiently. Use offset for admin UIs and small datasets; use cursor for feeds, sync APIs, and infinite scroll on large datasets."

### Memory Tricks

**"SCROLL needs a Cursor, SEARCH needs an Offset"**

- Infinite scroll (feeds, timelines) = cursor
- Search results with page numbers = offset

**"OFFSET = Old-Fashioned, Slow, Expensive, Treacherous"**

- Old-Fashioned: simple but outdated for large datasets
- Slow: O(N) at depth
- Expensive: COUNT(\*) overhead
- Treacherous: ghost record / duplicate problem under concurrent writes

**The +1 trick: "Fetch one more to detect has_more"**

- Request 20 items? Query for 21.
- Got 21? has_more = true, return first 20 + next_cursor.
- Got ≤ 20? has_more = false, return all + no cursor.
- Never run a second COUNT(\*) query.

---

## SECTION 12 — Architect Thinking Exercise

### The Problem

You're the API Architect at **FeedForge**, a B2B content curation platform. Publishers create articles, and 5,000 enterprise clients integrate via API to pull content into their CMS.

Current situation:

- 200M articles, growing at 500K/day
- Current API: `GET /v1/articles?page=X&per_page=100`
- 700 enterprise clients doing full syncs daily: pulling all articles updated in last 24h
- 200 clients browsing via UI (admin, editorial)
- Daily sync query: `SELECT * FROM articles WHERE updated_at > NOW()-INTERVAL '24h' ORDER BY updated_at LIMIT 100 OFFSET 0`, then OFFSET 100, 200, 300...
- Database CPU is at 85% every morning between 06:00-09:00 (sync window)
- At 3 million updated articles per day, clients doing deep syncs hit OFFSET 30,000 → takes 8-12 seconds per page
- Three enterprise clients have complained their syncs timeout after 6 hours

**Your task:**

1. Diagnose the root cause and calculate the database impact
2. Design a new sync API with cursor-based pagination that solves the performance problem
3. Design the backward compatibility strategy (700 clients cannot all migrate immediately)
4. Define the optimal cursor design for this specific use case (time-based sync with ordered traversal)

---

_Think through the design. Then read the solution._

---

### Solution

#### 1. Root Cause Diagnosis

```
Current daily sync by 700 clients:
  3M articles updated in 24h
  Per-page size: 100
  Total pages per full sync: 3M / 100 = 30,000 pages

  Average OFFSET for a full sync:
    Page 1:      OFFSET 0     → 8ms
    Page 100:    OFFSET 9,900  → 89ms
    Page 1,000:  OFFSET 99,900 → 780ms
    Page 10,000: OFFSET 999,900 → 7,800ms
    Page 30,000: OFFSET 2,999,900 → 23,400ms ← TIMEOUT

  Average query time per page: ~780ms (median page is #15,000, OFFSET 1.5M)

  One client's full sync: 30,000 pages × 780ms = 23,400 seconds = 6.5 hours
  Matches client complaint exactly.

  700 clients × 30,000 queries/day = 21,000,000 queries during 3-hour window
  At average 780ms: 21M × 780ms = 16,380,000 seconds of DB CPU
  In 3 hours (10,800 seconds): 16,380,000 / 10,800 = 1,516 concurrent CPU-seconds/second
  Aurora: 8 vCPU × 10,800 = 86,400 CPU-seconds available
  Utilization: 16,380,000 / 86,400 = 190% of capacity ← overloaded, explains 85% CPU
  (Some queries queue, some timeout — hence 85% sustained, with spikes to 100%)
```

#### 2. Cursor-Based Sync API Design

```
CURSOR DESIGN for time-based sync:

Core insight: the natural cursor for a sync API is (updated_at, id).
  - updated_at: the change detection field clients already filter on
  - id: secondary tie-breaker for records updated at the exact same second
  - Both are immutable from the sync direction standpoint
    (updated_at changes on update, but a synced record won't be re-processed
    until it changes again — which is the desired behavior)

New endpoint:
───────────────────────────────────────────────────
GET /v2/articles/sync
───────────────────────────────────────────────────
Query parameters:
  updated_since  ISO8601 timestamp (required for first page)
  cursor         opaque cursor for subsequent pages (mutually exclusive with updated_since)
  limit          integer 100-1000, default 1000

FIRST PAGE:
GET /v2/articles/sync?updated_since=2024-01-14T00:00:00Z&limit=1000

SQL:
  SELECT id, title, body, category, updated_at, content_hash
  FROM articles
  WHERE updated_at >= '2024-01-14T00:00:00Z'
  ORDER BY updated_at ASC, id ASC
  LIMIT 1001  ← fetch +1 for has_more detection

Index needed:
  CREATE INDEX CONCURRENTLY idx_articles_sync
    ON articles (updated_at ASC, id ASC);
  (CONCURRENTLY = zero downtime index creation)

RESPONSE:
{
  "sync_metadata": {
    "has_more": true,
    "next_cursor": "eyJ1cGRhdGVkX2F0IjoiMjAyNi0wMS0xNFQwMToxNTowMFoiLCJpZCI6MTIzNDU2Nzg5fQ",
    "items_count": 1000,
    "sync_hint": "Store next_cursor for subsequent pages. When has_more=false, store sync_completed_at for your next daily sync."
  },
  "articles": [...]
}

SUBSEQUENT PAGES:
GET /v2/articles/sync?cursor=eyJ1cGRhdGVkX2F0Ijoi...

SQL:
  SELECT ...
  FROM articles
  WHERE (updated_at, id) > (<cursor_updated_at>, <cursor_id>)
  ORDER BY updated_at ASC, id ASC
  LIMIT 1001

This is O(log N) index seek.
Page 30,000 is as fast as page 1.

Expected performance:
  Any page depth: ~10ms (vs 8-23 seconds for deep offset pages)

One client full sync: 3,000 pages (at 1000/page) × 10ms = 30 seconds
                      vs 30,000 pages × 780ms = 6.5 hours previously
  Improvement: 780x faster per client.
  700 clients × 30 seconds = 21,000 seconds / 3-hour window = 1.9 clients/second concurrent
  DB CPU impact: 3,000 queries/client × 700 clients = 2.1M queries × 10ms = 21,000 CPU-seconds
  In 10,800 seconds: 1.9 concurrent DB CPU utilization → ~15% CPU
  vs current 85% CPU → CPU reduction by ~70%
```

#### 3. Backward Compatibility Strategy

```
PHASE 1: Parallel endpoint (Month 1) — no disruption
  Keep /v1/articles (offset) unchanged
  Launch /v2/articles/sync (cursor)
  Send migration email: "Your sync endpoint will be deprecated Dec 31, 2025"

  Early adopters: 50 high-volume clients (contributing most CPU)
  Priority migration: manually onboard these 50 clients
  Expected CPU reduction: 50 clients × 70% improvement each = immediate relief

PHASE 2: Response header nudge (Month 2) — on v1
  Add to every v1 /articles response:
    Deprecation: true
    Sunset: Mon, 31 Dec 2025 23:59:59 GMT
    Link: <https://feedforge.com/migration/v2>; rel="deprecation"
  Visible in client logs, triggers developer attention.

PHASE 3: Throttle deep offsets (Month 3) — v1 only
  offset > 50,000: 429 Too Many Requests with Retry-After: 3600
  Reason: the "you must migrate" forcing function for high-volume clients
  Add X-Upgrade-Required: /v2/articles/sync header on 429 responses

PHASE 4: Migration tooling (Month 2-3)
  Publish migration guide, SDKs for Python/JavaScript/Ruby/PHP
  Offer free live migration support sessions for enterprise clients
  v1 → v2 migration takes <1 day for most clients

PHASE 5: Sunset (End of Year 1)
  v1 offset-based /v1/articles returns 410 Gone with migration URL
  All 700 clients now on v2.
```

#### Architecture Principle

```
The insight: sync APIs and real-time feeds are the WORST use case for offset pagination.
             They have exactly the properties that break offset:
               → Deep traversals (entire dataset)
               → Concurrent writes (articles being updated during sync)
               → Reliability requirements (sync must complete, not timeout)

             Cursor pagination was literally designed for this pattern.
             Every major data sync API (Stripe, Shopify, Salesforce, HubSpot, GitHub)
             uses cursor-based pagination for bulk data export.

             FeedForge's problem is not unique or unusual.
             The solution is well-established.
             The only question is: how fast can you migrate 700 clients?
```
