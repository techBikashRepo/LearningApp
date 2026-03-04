# Key-Value Storage — Part 1 of 3

### Topic: Foundations — Intuition, Core Concepts, Architecture & Data Flow

**Series:** Scalability & Performance → Topic 12

---

## SECTION 1 — Intuition (Explain Like a 12-Year-Old)

```
THE LOCKER ROOM MODEL:

  A gym locker room. 10,000 lockers. Each has a number (the key).
  Each holds whatever the member chose to put in (the value).

  To get your stuff: you need the locker number. That's all.
  No index. No category. No search. Just "give me locker 4,892."

  WHAT KEY-VALUE STORAGE IS GREAT AT:

  "Give me exactly what's in locker 4,892." → O(1). Instant.
  "Show me all lockers belonging to members named 'Alice.'" → ❌ can't. No index on names.
  "How many lockers are in use?" → ❌ must count all. Not cheap.
  "Find all members who visited in the last hour." → ❌ not designed for this.

  THE DESIGN CONTRACT:
  You trade query flexibility for extreme access speed.

  If you'll always fetch by a known ID: locker room is perfect.
  If you'll query by different attributes: you need a different system.

  RELATIONAL DB (alternative):
  Like a library. Organized by category, author, title, year.
  You can find books by any attribute. Rich queries.
  But: every query needs index traversal. Slower than locker #4892.

  COMBINED APPROACH (production reality):
  RDBMS stores your data. Organized. Queryable. Authoritative.
  Key-value store (Redis/DynamoDB): serves the hot paths.
    "Give me user 4892's profile" → known ID → locker lookup → instant.

  The key-value store is the "frequently accessed lockers" room.
  The database is the main warehouse where everything lives.
```

---

## SECTION 2 — Core Technical Explanation

### When to Use Key-Value Storage (and When Not To)

```
THE CORE STRENGTH: O(1) LOOKUP BY KNOWN KEY

  Any data where you always retrieve it by a known, deterministic identifier:
    User profile → lookup by userId.
    Session data → lookup by session token.
    Product detail → lookup by productId.
    API rate limit → lookup by userId:endpoint:window.

  For all these: you have the key. You just need the value. Fast.
  Key-value stores: designed exactly for this. Hash table underneath. O(1).

  Relational DB alternative:
    SELECT * FROM users WHERE id = 12345.
    With index: also O(log N) or O(1) via B-tree/hash index. Also fast.
    But: DB has overhead (SQL parsing, optimizer, connection management).
    Redis GET: no SQL parsing. No query optimizer. Direct hash table lookup.
    Redis: ~0.1–0.3ms. Postgres with index: ~1–10ms. 10–100× faster.

  For read-heavy workloads where latency matters:
    10ms × 100 reads = 1 second total read time.
    0.3ms × 100 reads = 30ms total read time.
    The difference is user-perceptible.

WHERE KEY-VALUE STORES FAIL:

  ❌ PATTERN 1: Query by non-key attributes.
  "Find all users in California who signed up in the last 30 days."
  No key covers this. Key-value stores: can't execute this query.
  Must scan all keys — O(N). Not designed for this.
  Use: relational DB with proper indexes.

  ❌ PATTERN 2: Range queries on values.
  "Find all orders with total > $500."
  Key-value: no index on "total". Must fetch all orders and filter.
  Redis Sorted Set: range query by SCORE (a number). Can answer "score > 500".
  But the score is a number you assign to each key — not an arbitrary value field.
  For flexible range queries: relational DB or Elasticsearch.

  ❌ PATTERN 3: Complex relationships.
  "Find a user's orders, each order's items, and each item's current inventory level."
  This is a relational join. Primary key lookups: 3 key-value reads per item.
  For 20 items: 60 key-value reads. Each is fast, but complexity grows with joins.
  Relational DB: single JOIN query. More appropriate structurally.

  ❌ PATTERN 4: Schema-dependent aggregate queries.
  "Average order value by user cohort."
  This is OLAP. Key-value stores serve OLTP point lookups.
  Use: data warehouse (Redshift, BigQuery, Snowflake).

KEY-VALUE WITHIN A LARGER SYSTEM (THE CORRECT USE):

  ┌──────────────────────────────────────────────────────────────────┐
  │  USER REQUEST: GET /users/12345/profile                           │
  │                                                                   │
  │  1. Application: key = "user:v1:12345"                           │
  │  2. Redis GET "user:v1:12345"                                    │
  │  3a. Hit: return cached profile (0.3ms). Done.                   │
  │  3b. Miss:                                                        │
  │      SELECT id, name, email, preferences                          │
  │      FROM users WHERE id = 12345                                  │
  │      Result: found (5ms).                                         │
  │      redis.SETEX "user:v1:12345" 3600 JSON.stringify(profile)    │
  │      Return profile.                                              │
  │                                                                   │
  │  Key-value: the access layer. DB: the source of truth.           │
  └──────────────────────────────────────────────────────────────────┘
```

---

## SECTION 3 — Architecture Diagram (MANDATORY)

### What Makes a Good Cache Key

```
THE KEY IS THE ONLY QUERY MECHANISM.

  In a relational DB: if you design a bad schema, you can add indexes later.
  In a key-value store: if you design a bad key naming convention:
    You can't find data without knowing the exact key.
    You can't invalidate related keys efficiently.
    You leak implementation details across services.
    You can't migrate without a full data scan.

PRINCIPLE 1: HIERARCHICAL NAMESPACE

  Format: {namespace}:{version}:{entityType}:{entityId}[:{subType}]

  Examples:
    catalog:v1:product:99          → product detail
    catalog:v1:product:99:price    → just the price sub-section
    user:v2:profile:12345          → user profile (v2 schema)
    auth:v1:session:sess_abc123    → session
    rate:v1:limit:user_12345:api   → rate limit counter

  WHY EACH PART:

  Namespace (catalog:, user:, auth:, rate:):
    Which service owns this data.
    Allows per-service Redis key patterns.
    On Redis Cluster: if you want all catalog keys on one shard:
    ZADD catalog:{*} → hash tag {catalog} routes all to same shard.
    Wait — namespace-level sharding forces all catalog data to one shard.
    Usually: DON'T use namespace as hash tag. Let keys distribute by entityId.

  Version (v1, v2):
    Schema migration without cache flush.
    Old code: reads v1. New code: reads v2. Both coexist during rolling deploy.
    v1 keys: expire naturally. v2: populated as new code deploys.
    Bump version when: key structure changes, value schema changes, TTL strategy changes.

  EntityType (product, user, session, limit):
    Human readable. Useful for debugging.
    Useful for operations: SCAN MATCH "catalog:v1:product:*" → get all product keys.
    (SCAN, not KEYS — never use KEYS in production.)

  EntityId (99, 12345, sess_abc123):
    The actual discriminator. The "locker number."
    Use the same ID the DB uses. Consistent across codebase.

PRINCIPLE 2: KEY LENGTH

  Redis key: any binary-safe string up to 512MB. Technical limit: not practical concern.

  Performance concern:
    Key is stored in memory. Key is compared on every lookup (hash + comparison).
    Longer key = slightly more memory + slightly more comparison work.

  Practical guideline:
    Keep keys under 100 characters. This is comfortable.
    Under 1KB: no measurable performance difference.
    Over 1KB per key + millions of keys: memory adds up.

  BAD (too verbose): catalog:version1:products:productid:99:details:full_object
  GOOD: catalog:v1:product:99
  BAD (too terse): c:1:p:99 (unreadable, unmaintainable)

PRINCIPLE 3: DETERMINISTIC KEYS

  For a given entity, the key must always be constructible from the entity's ID.
  No time-based components. No randomness.

  WHY:
  On write: you must know the key to DEL it (invalidation).
  On read: you must know the key to GET it.
  Both must agree.

  BAD: key = "product:99:" + Math.random()  → can never find it again
  BAD: key = "product:99:" + Date.now()     → new key every second — cacheless
  GOOD: key = "catalog:v1:product:99"       → always the same for product 99

PRINCIPLE 4: KEY CARDINALITY ANALYSIS

  "How many unique keys does this pattern generate?"

  product:{id}: 1 million products → 1M keys.
  search:{query}:{page}: 10B possible query combinations → 10B possible keys.
  user:{id}:session: 50K active users → 50K keys.

  HIGH CARDINALITY KEYS IN REDIS:
    1M product keys × 2KB average = 2GB Redis memory. Manageable.
    10B search keys IF all cached: impossible. Redis would need petabytes.

  CONCLUSION: do not cache every possible search query.
  Cache only: top N most-queried patterns. Use a frequency threshold.

  DETECTING CARDINALITY EXPLOSION:
    Watch CurrItems in CloudWatch.
    If CurrItems grows unboundedly: high-cardinality keys being added.
    Run: redis-cli --scan --pattern "search:*" | wc -l → count search keys.
    If growing: add a frequency threshold before caching search results.
```

---

## SECTION 4 — Request Flow (MANDATORY FLOWCHART)

### How to Structure the Data You Store

```
PATTERN 1: FLAT JSON STRING (simplest, most common)

  Value: JSON.stringify({ id: 99, name: "Widget", price: 19.99 })

  Pros:
    Simple. Fetch whole object in one command.
    Works for any Redis client (no special encoding).

  Cons:
    Update one field: must deserialize → modify → serialize → SET.
    Multiple concurrent writers: last-write-wins race.
    The entire value transferred on every GET, even if you only need one field.
    Large JSON values: more memory, more network transfer per read.

  Best for: infrequently updated objects that are always read as a whole (product detail).

PATTERN 2: REDIS HASH

  HSET product:99 name "Widget" price "19.99" stock "42"

  Pros:
    Update one field: HSET product:99 price "17.99" — atomically. No race with other fields.
    Read all fields: HGETALL product:99.
    Read one field: HGET product:99 price — minimal data transfer.
    Memory: listpack encoding for small hashes = compact.

  Cons:
    All values must be strings (no nested objects natively).
    Nested structures: serialize sub-objects as string values.

  Best for: objects with fields that are updated individually (profile, settings, user state).

  MIXED APPROACH — top-level as Hash, nested as serialized string:
    HSET user:12345 name "Alice" email "alice@example.com" preferences '{"theme":"dark","lang":"en"}'
    Most fields: directly accessible.
    Preferences: serialized (changed as a unit, not field-by-field).

PATTERN 3: SEPARATE KEYS PER FIELD (anti-pattern for most cases)

  SET product:99:name "Widget"
  SET product:99:price "19.99"
  SET product:99:stock "42"

  Read all 3 fields: 3 GET commands → 3 network round-trips.
  (Can pipeline, but still 3 keys vs 1 HGETALL for Hash.)

  Memory overhead: 3 hash table entries, 3 SDS key allocations vs 1 Hash entry.
  Memory: significantly more than Hash. 3× overhead at minimum.

  WHEN IT'S JUSTIFIED (rare):
    Each field has a DIFFERENT TTL.
    Hash fields can't have individual TTLs (only the whole Hash key has a TTL).
    If price needs TTL=5min and description needs TTL=24h:
    Store as separate keys:
      product:99:price (TTL=300)
      product:99:description (TTL=86400)
    Hash: can't do this per-field.

PATTERN 4: MSGPACK OR PROTOBUF INSTEAD OF JSON

  JSON: human-readable, larger footprint.
  MessagePack: binary serialization. ~30–50% smaller than JSON. Faster parse.
  Protobuf: schema-defined binary. Most compact. Requires schema files.

  For high-throughput, memory-constrained caching:
    JSON product object: 400 bytes.
    MsgPack equivalent: 260 bytes.
    Protobuf equivalent: 180 bytes.

  At 1M products cached:
    JSON: 400MB.
    MsgPack: 260MB. 35% savings.
    Protobuf: 180MB. 55% savings.

  Trade-off: not human-readable in redis-cli. Debugging harder.
  Use: when memory savings are worth the tooling complexity.

  Most teams: JSON in development, consider MsgPack in production if memory is tight.

ATOMIC OPERATIONS ON VALUES:

  INCR / INCRBY / DECR / DECRBY:
    Server-side atomic increment. No read-modify-write.
    For: view counts, API call counters, inventory decrements.

    Counter with expiry (daily counter auto-reset):
      local current = redis.call('INCR', key)
      if current == 1 then
        redis.call('EXPIREAT', key, next_midnight_unix_timestamp)
      end
      return current
      ← This Lua script: atomic INCR + first-time EXPIREAT. No race.

  SETNX (SET if Not eXists):
    SET key value NX → returns OK if key was set (didn't exist). Null if already existed.
    The primitive for distributed locks:
      SET lock:resource_id "my_process_id" NX EX 10
      → Succeeds for FIRST caller only. Lock expires in 10s automatically.

  GETSET (deprecated) / GETDEL:
    GETDEL key: GET and DELETE atomically.
    Use: one-time use tokens (verification codes, OAuth nonces).
    Consume-and-delete in one operation. No race where two processes both consume.
```

---

_→ Continued in: [02-Key-Value Storage.md](02-Key-Value%20Storage.md)_
