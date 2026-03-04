# Redis Basics — Part 1 of 3

### Topic: Foundations — Intuition, Core Concepts, Architecture & Data Flow

**Series:** Scalability & Performance → Topic 11

---

## SECTION 1 — Intuition (Explain Like a 12-Year-Old)

```
THE SINGLE-PURPOSE TOOL PROBLEM:

  Most people who first learn about Redis think of it as a key-value store.
  They use it like this:

    redis.set("product:99", JSON.stringify(product))    // store JSON blob
    redis.get("product:99")                              // fetch JSON blob

  This is using Redis as a butter knife.
  It cuts bread. It works.
  But you're ignoring the rest of the Swiss Army knife.

  The Swiss Army Knife's actual tools:

  BLADE (String):
    The simple tool. Stores any scalar value.
    Counter: INCR (atomic increment without read-modify-write).
    Lock: SETNX (set if not exists — distributed lock primitive).
    Simple cache: SETEX key TTL value.

  SCISSORS (Hash):
    Cut specific parts. Named fields.
    User profile: individual fields (name, email, preferences).
    Update one field: HSET user:123 email "new@example.com" — change 1 field.
    Without Hash: GET full JSON → parse → update field → serialize → SET.
    With Hash: HSET in ONE operation. No serialization. Fields are first-class.

  SAW (List):
    Sequential. Ordered. Push/pop from either end.
    Task queue: LPUSH jobs {...task...} → BRPOP jobs 30
    (BRPOP = blocking pop, waits up to 30s for new item)
    Activity feed: LPUSH feed:123 event → LRANGE feed:123 0 49 (last 50 events).
    Circular buffer: LPUSH + LTRIM (max N items — automatic overflow pruning).

  CAN OPENER (Set):
    Membership. No duplicates. Efficient intersection/union/difference.
    Online users: SADD online:users userId. SCARD online:users (count).
    Mutual friends: SINTER friends:user1 friends:user2.
    Tags: SADD tags:product:99 "electronics" "sale" "new" → SMEMBERS.

  COMPASS (Sorted Set):
    Ordered by score. Precise position lookup.
    Leaderboard: ZADD scores 9500 player123 → ZRANGE 0 9 REV WITHSCORES (top 10).
    Delayed queue: ZADD jobs <unix_timestamp> jobId → ZRANGEBYSCORE 0 now (due jobs).
    Rate limiting: sliding window counter per user.

  CLOCK (Stream):
    Append-only log. Consumer groups. At-least-once delivery guarantee.
    Event sourcing: XADD events * {type: "order_placed", orderId: 99}
    IoT sensor data: continuous ingestion and consumer group processing.

IN SOFTWARE: Using Redis only for string blobs is like using a Swiss Army knife only as a butter knife.
The other tools are ALREADY THERE. You're paying Redis's memory overhead regardless.
Not using them means you're implementing worse versions in application code.
```

---

## SECTION 2 — Core Technical Explanation

### The Decision Point That Led to Selecting Redis

```
MEMCACHED: THE BASELINE
  Memcached: pure key-value string cache.
  Extremely fast (single-purpose, optimized for one thing).
  Multi-threaded: can use multiple CPU cores for parallel reads.
  No persistence. No replication. No data structures.
  Cache key → string value. That's it.

  Use when: pure caching with string values, multi-threaded throughput matters,
             and you need nothing else. Memcached is faster than Redis for this specific workload.

REDIS: WHEN IT WINS

  CASE 1: COUNTER WITHOUT RACE CONDITION
    Memcached: no atomic increment.
    Application: GET value → parse → increment → SET.
    With concurrent requests: read-modify-write race.
    Two threads read "42" simultaneously → both write "43" → counter missed a count.

    Redis: INCR key → atomic. Server-side increment. No race. Single command.
    For: page views, API call counts, inventory decrements, vote counts.

  CASE 2: LEADERBOARD
    Memcached: no sorted data type.
    Application: GET all scores (string) → deserialize → sort → take top N.
    At 1M players: fetching + sorting 1M records → seconds of work.

    Redis Sorted Set: ZADD scores score userId → ZRANGE size-10 size-1 REV WITHSCORES.
    Returns top 10 in O(log N) + O(K) where K=10. Milliseconds for 1M players.

  CASE 3: PUB/SUB
    Memcached: no pub/sub.
    Application: polling loop to check for new messages.
    Redis: PUBLISH / SUBSCRIBE. Push-based. Clients receive messages as published.
    For: real-time notifications, chat, cache invalidation broadcast.

  CASE 4: DISTRIBUTED LOCK
    Memcached: SETNX-equivalent (CAS), but no expiry guarantee.
    Redis: SET key value NX EX seconds → atomic set-if-not-exists with TTL.
    TTL ensures locks auto-release on holder crash.
    The gold standard for distributed locking with Redis (Redlock algorithm).

  CASE 5: QUEUES AND STREAMS
    Memcached: can't act as a queue.
    Redis List: LPUSH + BRPOP = blocking queue. Fast. Simple.
    Redis Stream: persistent log with consumer groups. Kafka-lite for simple workloads.

  CASE 6: GEOSPATIAL QUERIES
    Memcached: no geospatial.
    Redis GEOADD: GEOADD restaurants longitude latitude restaurantId.
    GEORADIUS restaurants 40.7128 -74.0060 5 km → restaurants within 5km of NYC.
    Used by: food delivery apps, ride-sharing, logistics.

THE TRADE-OFF TABLE:

  FEATURE                    REDIS    MEMCACHED
  ──────────────────────────────────────────────
  Pure cache hit-rate perf   ✅       ✅✅ (faster)
  Multi-threaded reads       ❌       ✅
  Data structures            ✅       ❌
  Persistence (RDB/AOF)      ✅       ❌
  Replication                ✅       ❌
  Pub/Sub                    ✅       ❌
  Lua scripting              ✅       ❌
  Sorted data                ✅       ❌
  Transactions (MULTI/EXEC)  ✅       ❌
  Cluster mode               ✅       ✅

  WHEN TO CHOOSE MEMCACHED:
    Pure cache. Single data type (strings/blobs). Nothing else needed.
    Want maximum single-purpose throughput.
    Have team expertise with Memcached already deployed.

  WHEN TO CHOOSE REDIS (default for all new projects):
    Need any data structure beyond string blobs.
    Need persistence (surviving Redis restarts without full DB repopulation).
    Need replication (ElastiCache ReplicationGroup, not standalone).
    Need pub/sub (cache invalidation, real-time notifications).
    Need scripting (complex atomic operations via Lua or Redis Functions).
    Want a unified system for caching, queuing, session storage, and pub/sub.
```

---

## SECTION 3 — Architecture Diagram (MANDATORY)

### How Each Redis Data Type Is Stored Internally

```
STRINGS:
  SDS (Simple Dynamic String) — not C strings.
  SDS stores: length, free_space_ahead, buffer (no NULL terminator needed).

  Encoding for small integers: shared integer objects (0–9999 stored as pointers).
  redis.set("counter", "42")  → actually points to the number 42 object. No allocation.

  Encoding for small strings: EMBSTR (≤ 44 bytes). Single allocation. CPU cache-friendly.
  Encoding for larger strings: raw SDS buffer (separate allocation).

  CHECK ENCODING: OBJECT ENCODING keyname
    → "int" / "embstr" / "raw"

HASHES:
  Two internal encodings based on size:

  Small hash (≤ 128 fields, all values ≤ 64 bytes by default):
    Encoding: LISTPACK (Redis 7.0+) or ZIPLIST (Redis < 7.0).
    Stored as: compact array of alternating key-value byte sequences.
    Memory: very compact. No per-entry pointers. Cache-friendly.
    Lookup: O(N) scan of the compact array. Acceptable when N is small.

  Large hash (> 128 fields OR any value > 64 bytes):
    Encoding: HASHTABLE.
    Stored as: standard hash table with chaining.
    Lookup: O(1) average.
    Memory: significantly more than listpack (pointers, per-entry overhead).

  IMPORTANT ARCHITECTURAL IMPLICATION:
    Small user profiles in Redis Hashes: stored as listpack → very memory-efficient.
    Add field 129+: auto-converted to hashtable → memory jumps.
    If you have 5M users × (listpack: 200 bytes) = 1GB
    vs  5M users × (hashtable: 600 bytes) = 3GB
    Keep fields < 128 for memory efficiency at scale.
    Threshold configurable: hash-max-listpack-entries 128

LISTS:
  Small list (≤ 128 elements, all ≤ 64 bytes):
    Encoding: LISTPACK
  Large list (> 128 elements OR any element > 64 bytes):
    Encoding: QUICKLIST (doubly-linked list of listpack nodes).
    Quicklist: pages of listpack data, connected by pointers.
    Each page: 64+ entries (configurable). Balance between memory and access speed.

  LPUSH / RPUSH: O(1).
  LRANGE 0 9: O(10) — just reads 10 items from head. Fast.
  LRANGE 0 -1 (all): O(N). Avoid on large lists.

SETS:
  Small set (≤ 128 integers OR ≤ 128 small strings):
    Integer elements only: INTSET (sorted array of 16/32/64-bit integers. Very compact.)
    String elements: LISTPACK
  Large set: HASHTABLE.

  SINTERSTORE (set intersection to new key):
    O(N×M) where N = smallest set size, M = number of sets.
    For friend-of-friend queries on large sets: expensive. Profile before deploying.

SORTED SETS (ZSET):
  Small sorted set (≤ 128 members, all ≤ 64 bytes):
    LISTPACK.
  Large sorted set: SKIPLIST + HASHTABLE.
    SKIPLIST: allows O(log N) insertion and range queries.
    HASHTABLE: O(1) lookup by member (for ZSCORE and ZRANK commands).
    Uses BOTH structures to support all access patterns efficiently.

  WHY SKIPLIST NOT RED-BLACK TREE:
    Skiplist: simpler to implement. Lock-free friendly. Range queries are natural.
    Red-black tree: equivalent algorithmic complexity. More complex code.
    Simon Zawinski and Salvatore Sanfilippo chose skiplist pragmatically.
```

---

## SECTION 4 — Request Flow (MANDATORY FLOWCHART)

### Choosing the Right Data Type

```
DECISION FLOWCHART:

  NEED TO STORE:

  ┌─ A single value identified by key?
  │    (Cache value, counter, flag, lock)
  │    → STRING / SETEX / INCR / SETNX
  │
  ├─ Records with named fields (object/struct)?
  │    (User profile, configuration, product attributes)
  │    → HASH
  │    Benefit: update individual fields without fetching full object.
  │    Benefit: memory-efficient for small profiles (listpack encoding).
  │
  ├─ Ordered sequence (preserving insertion order)?
  │    (Activity feed, task queue, recent history)
  │    → LIST
  │    LPUSH = add to front. RPOP = dequeue from back.
  │    LRANGE 0 49 = last 50 items.
  │    LTRIM 0 99 = keep only last 100 items (sliding window).
  │
  ├─ Collection of unique items (membership test)?
  │    (Online users, user tags, visited pages)
  │    → SET
  │    SADD / SISMEMBER / SCARD (count) / SINTER (intersection).
  │
  ├─ Items with a numeric score or ranking?
  │    (Leaderboard, priority queue, delayed jobs by timestamp)
  │    → SORTED SET
  │    ZADD / ZRANGE / ZRANK / ZRANGEBYSCORE.
  │    ZADD jobs <unix_timestamp> jobId → range query by time.
  │
  ├─ Append-only event log with consumer groups?
  │    (Event sourcing, audit trail, async job processing)
  │    → STREAM
  │    XADD / XREAD / XREADGROUP.
  │    Consumer groups: multiple consumers process different entries.
  │
  └─ Approximate count with tiny memory footprint?
       (Approximate unique visitor count, cardinality estimation)
       → HYPERLOGLOG
       PFADD visitors userId → PFCOUNT visitors.
       12KB memory for any cardinality. 0.81% standard error.
       Cannot retrieve individual elements. Only count.

PRACTICAL EXAMPLES BY USE CASE:

  USE CASE              DATA TYPE     COMMANDS USED
  ──────────────────────────────────────────────────────────────────────────────
  Page cache            String        SETEX, GET
  Distributed counter   String        INCR, INCRBY, DECR
  Session storage       Hash          HSET, HGETALL, HDEL, HEXISTS
  User profile cache    Hash          HSET, HGET, HMGET
  Task queue            List          LPUSH, BRPOP (blocking dequeue)
  Activity feed         List          LPUSH, LRANGE, LTRIM
  Online user tracking  Set           SADD, SCARD, SISMEMBER, SMEMBERS
  Friend connections    Set           SINTER (mutual friends), SDIFF (suggestions)
  Leaderboard           Sorted Set    ZADD, ZRANGE, ZREVRANGE, ZRANK
  Rate limiting         Sorted Set    ZADD timestamp requestId + ZCOUNT range
  Job scheduler         Sorted Set    ZADD schedule_time jobId + ZRANGEBYSCORE
  Event log             Stream        XADD, XREAD, XREADGROUP
  Unique visitors       HyperLogLog   PFADD, PFCOUNT
  Nearby search         Geo           GEOADD, GEODIST, GEORADIUS
  Feature flag cache    String        SETEX, GET, pub/sub on change
  Autocomplete          Sorted Set    prefix scoring trick (lexicographic range query)
  Bloom filter (2025)   Bloom Filter  BF.ADD, BF.EXISTS (RedisBloom module)
```

---

_→ Continued in: [02-Redis Basics.md](02-Redis%20Basics.md)_
