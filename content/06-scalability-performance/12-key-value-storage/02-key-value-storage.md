# Key-Value Storage — Part 2 of 3

### Topic: Real World Examples, System Design Importance, AWS Mapping & Interview Prep

**Series:** Scalability & Performance → Topic 12

---

## SECTION 5 — Real World Example

### When One Key Receives Disproportionate Traffic

```
THE HOT KEY SCENARIO:

  Product catalog in Redis. 100,000 products.
  Normal: requests spread evenly → 100 requests/sec per product on average.

  EXCEPTION:
  Celebrity endorses product:99. Goes viral.
  Suddenly: 500,000 requests/second to product:99.
  Other 99,999 products: not affected.

  Redis node throughput: ~1,000,000 operations/second total.
  500,000 ops/sec for ONE key = 50% of ALL Redis capacity consumed by ONE product.
  Other 99,999 products + all other cache reads: fighting for the remaining 50%.

  Symptoms:
    Redis CPU: 80%+ sustained.
    Latency: P99 spikes (commands queue behind the flood of product:99 reads).
    If Redis saturates: reads fail → fall through to DB → DB saturated too.
    Cascading failure from one viral product.

DETECTING HOT KEYS:

  Method 1: Redis --hotkeys (Redis 4.0+)
    redis-cli -h endpoint --hotkeys
    Scans the LFU (frequency) counter built into each key.
    Returns keys with highest access frequency.
    Note: requires maxmemory-policy = allkeys-lfu or volatile-lfu.

  Method 2: Monitor at application level.
    Track per-key hit count in your cache layer.
    Alert when any single key exceeds N% of total Redis requests.

  Method 3: redis-cli MONITOR (emergency only)
    Streams every command in real-time.
    You'll see: 500,000 GET product:99 commands per second.
    WARNING: MONITOR itself adds significant overhead. Use briefly only.

SOLUTIONS:

  SOLUTION 1: LOCAL IN-PROCESS CACHE (L1) FOR HOT KEYS
    Every app server keeps a local cache with a short TTL.
    Hot key: served from L1 cache. Zero Redis network calls.

    const l1Cache = new LRUCache({ max: 1000, ttl: 5000 }); // 5s TTL

    On read:
      if (l1Cache.has(key)) return l1Cache.get(key);
      const val = await redis.get(key);
      l1Cache.set(key, val);
      return val;

    10 app servers: each have L1. Product:99 hits Redis once per 5s per server.
    10 servers × 500,000 req/sec: shared across servers → 50,000/server.
    With L1: Redis receives: 10 requests per 5s = 2 req/sec for product:99.
    Impact: eliminated 99.9996% of Redis traffic for this key.

    Staleness: L1 TTL = 5 seconds. Product:99 may be 5s stale.
    For a viral product page: 5 seconds of price staleness = acceptable.

  SOLUTION 2: KEY SHARDING (REPLICATION ACROSS MULTIPLE KEYS)

    Instead of one key: replicate to N keys.
    Key: product:99:shard:{0..N-1}

    Write:
      On update: SET product:99 + SET product:99:shard:0 + ... + product:99:shard:9
      TTL: all shards invalidated together.

    Read:
      shardIndex = Math.floor(Math.random() * 10);
      const val = redis.get(`product:99:shard:${shardIndex}`);

    Effect: 500,000 req/sec distributed across 10 keys.
    50,000 req/sec per key. Still on same Redis node if no cluster.

    REQUIRES: Redis Cluster with hash tags to spread shards across nodes.
    product:99:shard:{0} on shard key "0" → different Redis primary per shard.
    BUT: hash tags don't work this way. {0} would hash to the same slot.

    FIX: explicitly distribute to different prefixes.
    shard0:product:99, shard1:product:99, ..., shard9:product:99
    Each has a different hash slot. Different Redis primary in a cluster.
    10× distribution across cluster primaries.

  SOLUTION 3: READ-THROUGH LOCAL CACHE WITH CIRCUIT BREAKER
    If Redis is overwhelmed: circuit breaks Redis → all hot key reads served from DB.
    DB read: more expensive (5ms vs 0.3ms) but corrects the failure mode.
    Cache repopulated after circuit closes.
    Short-term traffic spike: DB absorbs it. Cache recovers at lower TTL rate.
```

---

## SECTION 6 — System Design Importance

### The Only Safe Way to Iterate Redis Keys

```
THE PROBLEM WITH KEYS:

  KEYS pattern:
    Scans the entire key dictionary. O(N).
    N = total number of keys in the database.
    Example: 10 million keys → ~1–2 second scan.
    Redis main thread: BLOCKED for 1–2 seconds.
    All other clients: queued. SLA violated.

  WHEN KEYS IS USED (antipatterns in real code):
    Admin panel: "show all product cache keys" → redis.keys("product:*")
    Batch invalidation: "invalidate all search results" → redis.keys("search:*")
    Debug script: "count all user sessions" → redis.keys("user:*:session").length

  All of these: will cause production incidents when run on a large Redis instance.

SCAN: THE CORRECT APPROACH

  SCAN cursor MATCH pattern COUNT hint

  cursor: starts at 0. Returns next cursor. Iterate until cursor returns 0.
  COUNT:  hint for how many elements to return per call. Not guaranteed exact.
          Set to 100–1000 for reasonable batch sizes.

  SCAN 0 MATCH "product:v1:*" COUNT 100
  → Returns: [next_cursor, [key1, key2, ...]]

  If next_cursor != 0: call SCAN again with next_cursor.
  Repeat until cursor = 0 (full iteration complete).

  WHY SCAN IS SAFE:
    Implemented as a cursor-based iteration over the hash table buckets.
    Each SCAN call: processes a small batch of buckets.
    Returns control to the event loop between each call.
    Other commands: execute between your SCAN iterations.
    No blocking of Redis main thread beyond a single SCAN's execution time (~1ms).

  PRODUCTION IMPLEMENTATION:

  async function* scanKeys(redis, pattern, count = 100) {
    let cursor = '0';
    do {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', count);
      cursor = nextCursor;
      if (keys.length > 0) yield keys;
    } while (cursor !== '0');
  }

  // Usage: process in batches, add pauses between batches
  for await (const keyBatch of scanKeys(redis, 'search:v1:*')) {
    await redis.del(...keyBatch);
    await new Promise(resolve => setTimeout(resolve, 10)); // 10ms pause between batches
  }

  The 10ms pause: gives Redis breathing room. Other commands execute during pause.
  No pause: rapid SCAN + DEL iterations still stress Redis.

HSCAN, SSCAN, ZSCAN (Field-Level Iterators):

  For large Hashes, Sets, or Sorted Sets:
    HGETALL huge_hash → O(N) where N = number of fields. Blocks.
    HSCAN huge_hash 0 COUNT 100 → iterates fields in batches.

  HSCAN sessionData:user123 0 COUNT 50
  → returns cursor + batch of field:value pairs.

  Use when a single Hash/Set/SortedSet has thousands of members.
  For moderate sizes (< 1000 members): HGETALL/SMEMBERS/ZRANGE are fine.
  For very large collections: always HSCAN/SSCAN/ZSCAN.
```

---

## SECTION 7 — AWS & Cloud Mapping

### Two Different KV Systems for Two Different Use Cases

```
┌─────────────────────────────┬───────────────────────┬───────────────────────────────┐
│ DIMENSION                   │ Redis                 │ DynamoDB                      │
├─────────────────────────────┼───────────────────────┼───────────────────────────────┤
│ Storage                     │ In-memory (RAM)        │ Disk (SSD-backed)             │
│ Durability                  │ Optional (RDB/AOF)     │ Built-in, multi-AZ default    │
│ Read latency                │ 0.1–0.5ms             │ 1–5ms (single-digit)          │
│ Max value size              │ 512MB                  │ 400KB per item                │
│ Data types                  │ String, Hash, Set,    │ String, Number, Binary,       │
│                             │ List, ZSet, Stream    │ StringSet, Map, List          │
│ Range queries               │ ZSet (by score),      │ Sort key range queries        │
│                             │ Stream (by ID)        │ (Query API)                   │
│ Secondary indexes           │ ❌ (none built-in)    │ LSI / GSI (limited)           │
│ Throughput model            │ Cluster (horizontal)  │ Auto-scaling RCU/WCU          │
│ Persistence                 │ Optional (configure)  │ Always on. Not optional.      │
│ Cost model                  │ Pay per node (RAM)    │ Pay per operation + storage   │
│ Typical workload            │ Sub-ms hot cache,     │ Durable primary DB,           │
│                             │ session, pub/sub      │ at-scale KV without ops       │
│ Multi-region                │ Multi-replica (manual)│ Global Tables (built-in)      │
│ Max item/value size         │ 512MB string          │ 400KB (hard limit)            │
│ Transactions                │ MULTI/EXEC            │ TransactGetItems/             │
│                             │ (single node)         │ TransactWriteItems (cross-key)│
└─────────────────────────────┴───────────────────────┴───────────────────────────────┘

DECISION FRAMEWORK:

  Use Redis when:
  ✅ Sub-millisecond latency is required (session reads under 0.5ms).
  ✅ Data access patterns require Redis data types (sorted set for leaderboard, list for queue).
  ✅ Pub/sub messaging is needed.
  ✅ Working set FITS in RAM cost-effectively.
  ✅ Data is caching a DB — Redis is the acceleration layer, not the primary store.
  ✅ Short-lived data (sessions, rate limit counters, temporary flags).

  Use DynamoDB when:
  ✅ Data must be durable — it's a primary data store, not a cache.
  ✅ Working set EXCEEDS feasible in-memory capacity.
  ✅ You want fully managed, no-ops, auto-scaling RCU/WCU.
  ✅ Multi-region Global Tables needed.
  ✅ 1–5ms latency is acceptable (most application use cases).
  ✅ Item size up to 400KB (Redis 512MB, but DynamoDB is durable for those large items).

  COMMON ARCHITECTURE (combining both):

  DynamoDB: primary store (always durable, no ops, auto-scale).
  ElastiCache (Redis): cache layer in front of DynamoDB.

  Hot paths: hit ElastiCache first. Miss → DynamoDB → populate ElastiCache.
  This is the classic cache-aside pattern at AWS-native scale.

  DAX (DynamoDB Accelerator): managed in-memory cache for DynamoDB.
  Transparent: app sends requests to DAX. DAX serves from cache or passes to DynamoDB.
  Use DAX when: your data model is DynamoDB and you want read acceleration without cache-aside code.
  Limitation: only works with DynamoDB. No multi-tier architecture flexibility.
```

---

## SECTION 8 — Interview Preparation

**Beginner:**

**Q: What is key-value storage?**
**A:** The simplest possible data model: every piece of data has a unique name (the key) and a value. Like a dictionary or a real-world locker room: you need locker number 47 (the key) to get your bag (the value). No complex tables, no relationships, no queries. Just: get(key) â†’ value, and put(key, value). This simplicity is what makes it incredibly fast.

**Q: What can a "value" be in a key-value store?**
**A:** Anything: a string, a number, a JSON blob, a binary file, an image. The store doesn't care about the structure of the value â€” that's up to your application. This flexibility is both a strength (no schema to define) and a weakness (you can't query based on fields inside the value â€” you must know the exact key).

**Q: When would you choose a key-value store over a relational database?**
**A:** When you always access data by a single ID and don't need to search or filter by attributes. User sessions (key = session ID), configuration (key = config name), cache entries (key = cache key), rate limiting counters (key = user ID + minute). For anything requiring "show me all products where price < 50," you need a relational or search database.

---

**Intermediate:**

**Q: What is consistent hashing and why do distributed key-value stores use it?**
**A:** In a distributed key-value store with N nodes, naive approach: 
ode = hash(key) % N. Problem: adding or removing one node changes % N â†’ almost all keys remap to different nodes â†’ massive cache invalidation (everyone re-fetches from DB simultaneously). Consistent hashing: nodes and keys are placed on a virtual ring. Adding a node only remaps keys nearest to it (~1/N of all keys), not all keys. The result: adding capacity causes minimal disruption. Used by: DynamoDB, Cassandra, Redis Cluster.

**Q: What are hot keys in a distributed key-value store and how do you handle them?**
**A:** A hot key is one single key accessed millions of times per second â€” e.g., product:trending_now during a flash sale. In a sharded store, this one key lives on one shard â†’ that shard becomes a bottleneck while others are idle. Solutions: (1) *Key replication:* cache product:trending_now across multiple Redis replicas, read from any. (2) *Key sharding:* create multiple copies with index suffixes â€” product:trending_now:0, product:trending_now:1 â€” and route reads randomly across them. (3) *Local caching:* cache the hot key in app server memory (reducing Redis hits to near zero for that key).

**Q: How does TTL work in distributed key-value stores like DynamoDB?**
**A:** DynamoDB supports TTL as a native feature: you specify a Unix timestamp attribute name (e.g., expires_at). DynamoDB automatically deletes items within ~48 hours of expiry (TTL deletion is background/eventually consistent â€” items may still appear in reads for up to 24 hours after the TTL timestamp). DynamoDB Streams captures TTL deletions â€” useful for cleanup jobs triggered on item expiry.

---

**Advanced (System Design):**

**Scenario 1:** Design the key-value data model for a URL shortener (like bit.ly) that must: (1) look up a long URL from a short code in < 5ms, (2) track click counts per URL, (3) support URL expiry.

*Short code â†’ long URL:* Redis: short:{code} â†’ {longUrl, ownerId, expiry_timestamp} (JSON string). TTL set to expiry time. Hit rate lookup: INCR clicks:{code} (atomic counter). Batch-write click counts to PostgreSQL every 60 seconds for persistence (write-back). Key design: short code is 7 alphanumeric chars (62^7 = 3.5 trillion possible URLs). Collision handled by checking before inserting.

**Scenario 2:** You're building a feature flag system where each feature flag can be enabled/disabled per user, per region, and per percentage rollout (e.g., "show new checkout UI to 20% of users in India"). You have 500 feature flags and 10 million users. Design the key-value schema.

*Don't store per-user flag state* (10M users Ã— 500 flags = 5 billion records). Instead: store flag configuration in Redis (500 keys, each a few hundred bytes = <1MB total). At request time, evaluate flags client-side: lag:{name} â†’ {enabled: true, regions: ["IN"], rollout_percent: 20, hash_key: "user_id"}. Consistent rollout: hash(userId + flagName) % 100 < rollout_percent â†’ deterministic, same user always gets same experience. Update flag = 1 Redis write, immediately effective for all users.

