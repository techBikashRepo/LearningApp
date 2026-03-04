# Redis Basics — Part 3 of 3

### Topic: AWS Certification Focus, Comparison Tables, Quick Revision & Architect Exercise

**Series:** Scalability & Performance → Topic 11

---

## SECTION 9 — Certification Focus (AWS SAA)

### Scaling Reads and Writes

```
SINGLE REDIS INSTANCE:
  One primary. No replicas. No sharding.
  Max working set: limited by one node's RAM.
  Max throughput: ~1M ops/sec on modern hardware.
  Availability: single point of failure. No auto-recovery.
  Use for: development, staging, non-critical workloads.

REDIS REPLICATION (PRIMARY + REPLICAS):

  One writable primary. One or more read-only replicas.
  Replicas sync from primary via replication stream.

  PURPOSE: Read scalability + high availability.

  TOPOLOGY:
    primary ──► replica-1 (read load)
           ──► replica-2 (read load)
    ElastiCache: reader endpoint round-robins across replicas.

  Write operations: primary only.
  Read operations: replicas (for non-critical paths).

  REPLICATION LAG:
    Replication is asynchronous.
    Primary commits write → sends to replica → replica applies.
    Lag: typically 1–100ms. Under load: can reach seconds.

    If you write to primary then immediately read from replica:
    the replica might not have the write yet.
    SOLUTION: read-your-own-writes → always read from primary for N ms after a write.
    OR: use write-through (primary for write + cache), read from primary for that key.

  FAILOVER:
    Primary fails.
    Sentinel or ElastiCache automatically promotes a replica.
    DNS endpoint update: ~30–60 seconds.
    During failover: write operations fail. Read operations may stall.

  CAPACITY LIMIT:
    Working set limited to single primary's RAM.
    All replicas are FULL copies of the primary.
    Adding replicas: increases read capacity, not write capacity, not storage capacity.

REDIS CLUSTER (SHARDING):

  Data sharded across N primaries (each responsible for a key range).
  16,384 hash slots: each key maps to a slot.
  Slot = CRC16(key) % 16384.

  Example: 3 primaries.
    Primary 0: slots 0–5460.
    Primary 1: slots 5461–10922.
    Primary 2: slots 10923–16383.

  Each primary can have its own replicas.
  3 primaries × 1 replica each = 6 nodes (minimum recommended).

  CAPACITY:
    Each primary: handles its portion of the data.
    Total capacity: N × primary_RAM.
    Write throughput: N × single_primary_throughput.

  HASH TAGS (for multi-key transactions):
    MGET product:99 product:100  → different slots (different shards).
    Cluster: MGET across slots = requires cross-shard coordination = NOT supported.

    FIX: use hash tags. Keys with {tag} use only the tag for slot computation.
    product:{99} → slot = CRC16("99") % 16384.
    product:{99}:detail
    product:{99}:price
    → same slot (because both hash to CRC16("99")).
    → guaranteed on same shard.
    → MGET on same shard = atomic.

    Use `{entityId}` in key names when you need multi-key operations.

DECIDING BETWEEN REPLICATION AND CLUSTER:

  Working set FITS in one node + need HA → REPLICATION.
  Working set DOESN'T FIT in one node → CLUSTER.
  Write throughput EXCEEDS single node → CLUSTER.

  ElastiCache names:
    Replication: ReplicationGroup (primary + replicas, no sharding).
    Cluster: Cluster mode enabled ElastiCache (sharded across multiple nodes).
```

---

## SECTION 10 — Comparison Table

### ElastiCache for Redis on AWS

```
ELASTICACHE REPLICATION GROUP (NON-CLUSTERED):

  Multi-AZ enabled: primary in one AZ, replica in another.
  Automatic failover: on primary failure, replica promoted (~60s).

  Endpoints:
    Primary endpoint: always points to current primary (writable).
    Reader endpoint: round-robin across replicas (read-only load distribution).

  Application config:
    Write client: connect to primary endpoint.
    Read client: connect to reader endpoint.

  Node types (2025):
    cache.r7g.large: 6.4GB, 2 vCPU. Good for medium workloads.
    cache.r7g.xlarge: 13.1GB, 4 vCPU. For large working sets.
    cache.r7g.4xlarge: 52.4GB. For very large caches.

ELASTICACHE CLUSTER MODE ENABLED:

  Sharded. Up to 500 shards (as of 2024).
  Each shard: one primary + up to 5 replicas.

  Endpoints:
    Configuration endpoint: client discovers all shards automatically.
    Cluster-aware clients (ioredis, lettuce, JedisCluster): required.

  When to use:
    Data > single node capacity.
    Write throughput > single node capacity.
    Partitioned access pattern (different shards get different users' data).

PARAMETER GROUPS (KEY SETTINGS ON AWS):

  maxmemory-policy: set to match your eviction requirements.
    Cache: allkeys-lru.
    Cache + write-back mix: volatile-lru.

  notify-keyspace-events: disabled by default. Enable selectively.

  tcp-keepalive: 60 (default, detect dead connections).

  lazyfree-lazy-eviction yes: async eviction (reduces latency spikes from eviction).
  lazyfree-lazy-expire yes: async TTL expiry cleanup.

CLOUDWATCH ALERTS FOR ELASTICACHE:

  Alarm: FreeableMemory < 20% of node RAM → scale up or reduce TTL.
  Alarm: Evictions > 0 for sustained 5 min → memory pressure. Investigate.
  Alarm: CacheHitRate < 0.85 → TTL too short or key cardinality too high.
  Alarm: ReplicationLag > 500ms → replica lagging. Read routing may return stale data.
  Alarm: CurrConnections > 80% of max → connection pool exhaustion approaching.
          ElastiCache connection limit: depends on node type. cache.r7g.large: ~65,000.

ENCRYPTION IN TRANSIT + AT REST:

  In transit: TLS between app and ElastiCache.
    Cost: ~15% CPU overhead on Redis node. Worth it for any production workload.
    ioredis: { tls: { rejectUnauthorized: true, servername: 'cluster.xxx.use1.cache.amazonaws.com' } }

  At rest: ElastiCache encrypts RDB snapshots and AOF files on disk.

  AUTH: Redis AUTH (password) via ElastiCache auth token.
    RBAC (Redis 6+): granular permissions per user.
    ElastiCache RBAC: configured via AWS console, applied via parameter group.
```

---

## SECTION 11 — Quick Revision

**Scenario:** A real-time multiplayer game needs: player profile (display name, avatar, stats), in-game currency balance, a global leaderboard of top 100 players (updated after every match), and a matchmaking queue (FIFO with priority tiers). Design the Redis data model using appropriate data types for each.

---

**Answer:**

```
ENTITY 1: PLAYER PROFILE

  Data type: HASH
  Key: player:{playerId}:profile
  Fields: name, avatar_url, level, region, joined_at

  HSET player:p123:profile name "DragonSlayer" avatar_url "cdn.game/avatars/p123.png" level 42 region "na-east"

  Why Hash not String (JSON blob):
    Individual field reads: HGET player:p123:profile name → O(1), no deserialize.
    Individual field updates: HSET player:p123:profile level 43 → no fetch-parse-modify-serialize.
    Memory: listpack encoding for small profiles (< 128 fields, < 64B values). Very tight.

  TTL: 24h (active DEL on profile update)
  Eviction: volatile-lru (profile has TTL, safe to evict)

ENTITY 2: IN-GAME CURRENCY BALANCE

  Data type: String (integer counter via INCRBY)
  Key: player:{playerId}:currency
  Value: integer (current balance in coins)

  INCRBY player:p123:currency 500     ← award coins after match
  DECRBY player:p123:currency 200      ← spend on item purchase
  GET    player:p123:currency          ← display balance

  Why NOT HSET with a "currency" field:
    Atomicity: INCRBY on a string is atomic.
    HINCRBY on a hash field is ALSO atomic.
    Both work. String is simpler and cleaner for a single scalar.
    HINCRBY player:p123:profile currency 500 would work too.
    Preference: separate key for currency (different TTL/eviction policy).

  TTL: No TTL. This is real game data (write-back pattern).
    Currency balance written to Redis immediately.
    DB sync: every minute OR on significant events (login, logout, purchase).
    Eviction: noeviction (cannot afford to lose balances).

    NOTE: For real money (not soft currency): absolute must → direct DB writes. No write-back.
    For soft in-game currency (farmable, not purchased): write-back acceptable.

ENTITY 3: GLOBAL LEADERBOARD

  Data type: Sorted Set
  Key: leaderboard:global
  Members: player IDs. Scores: total_wins * 1000 + avg_score (composite score).

  On match complete:
    winner_new_score = ZINCRBY leaderboard:global (+1000 for win) playerId
    loser_new_score  = ZINCRBY leaderboard:global (+avg_score) loserId

  Read top 100:
    ZRANGE leaderboard:global 0 99 REV WITHSCORES
    → returns [(p456, 9500), (p123, 9100), ...] top 100 players, highest score first.

  Read player's rank:
    ZREVRANK leaderboard:global p123
    → returns 0-indexed rank. Add 1 for display.

  TOTAL PLAYERS: at 1M players, sorted set: ~50MB (skiplist encoding for large sets).
  ZRANGE top 100: O(log N + 100) ≈ O(20 + 100) = fast.

  TTL: No TTL on global leaderboard (persistent in Redis, write-back to DB).
  DB sync: flush top 1000 player positions every minute.
  Full DB sync: nightly batch job computes exact DB-consistent rankings.

ENTITY 4: MATCHMAKING QUEUE

  Requirements: FIFO within each tier. Multiple priority tiers (Bronze, Silver, Gold, Diamond).

  Data type: Multiple sorted sets (one per tier) + a global "match me" set.
  Key: matchqueue:{tier}   (e.g., matchqueue:diamond, matchqueue:gold)
  Score: timestamp of joining queue (UNIX ms) → FIFO ordering by entry time.

  Player enters queue:
    ZADD matchqueue:diamond 1720000000123 p123
    → score = timestamp(ms). Earliest time = lowest score = first dequeued.

  Matchmaker dequeues two players (1v1):
    ZPOPMIN matchqueue:diamond 2
    → returns 2 players with lowest scores (earliest queue entries). Atomic removal.
    → these two are matched.

  If not enough diamond players: fall back to adjacent tiers.
    ZCARD matchqueue:diamond < 2: check matchqueue:platinum, etc.

  Matchmaking timeout (player waits > 3 min without match):
    Background scan: ZRANGEBYSCORE matchqueue:diamond 0 (now-180000) → players waiting > 3min.
    These players: moved down one tier for expanded matching.

  TTL for queue membership:
    If player disconnects without leaving queue: key stays.
    ZADD with score = join_timestamp. Background: check timestamps.
    Player heartbeat: ZADD matchqueue:diamond (refresh timestamp) p123.
    If timestamp not refreshed in 60s: consider player disconnected.
    Use membership expiry via separate EXPIREAT: player:p123:in_queue expiry=60s.
    Background: if player:p123:in_queue gone → ZREM matchqueue:diamond p123.

COMPLETE REDIS KEY NAMESPACE:
  player:{playerId}:profile        → HASH, 24h TTL
  player:{playerId}:currency       → STRING, no TTL (write-back)
  player:{playerId}:in_queue       → STRING "yes", 60s TTL (presence key)
  leaderboard:global               → SORTED SET, no TTL (persistent record)
  leaderboard:weekly:{weekNum}     → SORTED SET, 7d TTL (weekly reset)
  matchqueue:{tier}                → SORTED SET, no TTL (active queue)
  match:{matchId}:state            → HASH, 1h TTL (active match data)
```

---

## SECTION 12 — Architect Thinking Exercise

**Q: "Why is Redis single-threaded but still so fast?"**

> "All data lives in memory, so every operation is a memory access — no disk I/O, no page faults. A typical get-or-set completes in under a microsecond. Single-threaded means no locking overhead — there's no context switching, no mutex contention, no deadlock debugging. Redis also uses event-driven I/O multiplexing (epoll), so one thread handles thousands of simultaneous client connections. The result: a million operations per second from one thread. The bottleneck isn't the CPU — it's the network. Redis 6+ added multithreaded I/O for network read/write parsing to address that, but command execution remains single-threaded to preserve atomicity guarantees."

---

**Q: "When would you use a Sorted Set vs a List in Redis?"**

> "Lists are for ordered sequences where elements are processed or displayed in insertion order — task queues, activity feeds, circular buffers. Sorted Sets are for ordered collections where the order is by a numeric score and you need random access by rank — leaderboards, delayed job queues ordered by execution timestamp, rate limiting with sliding window counters. A List gives you push-and-pop semantics efficiently. A Sorted Set gives you rank queries, range queries by score, and atomic increment/insert. Pick List when order = insertion time and you process from the head or tail. Pick Sorted Set when order = a score you assign, and you need queries like 'top 10' or 'everything between score X and Y'."

---

## === Architect's Mental Model ===

### 5 Decision Rules

**Rule 1: Choose Redis data type based on access pattern, not data shape.**
Data can often be stored in multiple formats (JSON string, Hash, individual string keys). The right choice is based on HOW you'll access it: update one field → Hash. Atomic increment → String INCR. Ordered rank query → Sorted Set. Membership test → Set. The data structure determines the efficiency of the operations, not just what you can store.

**Rule 2: Keep Hash field count below the listpack/ziplist threshold (128 fields by default).**
A Hash under 128 fields uses compact listpack encoding — extremely memory-efficient. Above 128 fields: automatic conversion to hashtable encoding — 3–5× more memory per entry. At millions of users, this difference is hundreds of megabytes. Audit your Hash field counts at design time. If you have 150 user fields: either split into two Hashes or raise the threshold if most values are small (hash-max-listpack-entries).

**Rule 3: Never use KEYS pattern:\* in production. Always use SCAN.**
KEYS blocks the Redis main thread for the entire keyspace scan duration. On a large Redis instance: blocks for seconds. Causes massive latency spikes across ALL clients. SCAN is cursor-based, returns a small batch per call, and never blocks for more than a few milliseconds. There is no performance-appropriate use case for KEYS in production. Block it at the team policy level.

**Rule 4: Use connection pools correctly sized to Redis's thread model.**
Redis doesn't benefit from large connection counts for throughput (single execution thread). Excessive connections add overhead (each consumes Redis memory and event loop iteration). Recommendation: 10–50 connections per app instance is usually sufficient. At very high async QPS: up to 100–200. More than that: usually counterproductive. Monitor CurrConnections and set an alert at 70% of the node's max connection limit.

**Rule 5: Persistence choice depends on whether Redis holds data that's also in the DB.**
If ALL Redis data can be re-fetched from DB: no persistence. Restart = cold cache, warms naturally. If Redis holds data NOT in the DB (write-back buffers, sessions, counters): persistence is required. Choose AOF everysec for at-most-1-second data loss window. Add RDB for fast restart. The common mistake: enabling RDB with 5-minute save intervals for write-back buffers and accepting 5 minutes of data loss as known risk — then being surprised when a crash causes exactly that.

---

### 3 Common Mistakes

**Mistake 1: Storing everything as a flat JSON string when Hashes provide better ergonomics and memory efficiency.**
Teams learn Redis as "key-value store" and store all objects as `JSON.stringify(obj)`. Profile update: GET → deserialize → modify one field → serialize → SET — four steps for what should be one HSET field update. At 100 user profile updates per second: 400 Redis operations instead of 100. And for small objects: Hash(listpack) encoding is more memory-compact than a JSON string blob. Audit your most-used cache patterns: if you're serializing objects with named fields, use Hash.

**Mistake 2: Using INCR counters without planning for overflow or resets.**
Redis INCR can increment a 64-bit integer — overflow requires astronomical values (9.2 × 10^18). Not a practical concern. But: what happens at counter reset? Daily view count: should reset at midnight. If you use INCR without expiry or reset logic, the counter grows across days. Use INCR + EXPIREAT (expire at next midnight) for daily counters. Alternatively: include the date in the key (views:2025-07-15:{articleId}) — natural daily reset via TTL, no explicit reset code.

**Mistake 3: Routing all Redis reads/writes to the primary endpoint.**
Teams configure one Redis connection string (primary endpoint) for both reads and writes. Under read load: primary is overwhelmed. Replicas: idle. ElastiCache reader endpoint is provided specifically for read distribution. Any read that can tolerate a small replication lag (typically <<100ms): should go to the reader endpoint. For cache-aside reads: perfect for reader endpoint. For write-through read-your-own-writes: must use primary. Explicitly route to reader for reads, primary for writes. Don't default to primary for everything.

---

### 30-Second Interview Answer

> "Redis is an in-memory data structure store. The key word is 'data structure' — it's not just a key-value cache. It gives you strings for counters and simple caching, hashes for object fields with partial update support, lists for queues and feeds, sets for membership and intersection queries, and sorted sets for leaderboards and ordered collections. Being single-threaded with all data in memory gives sub-millisecond operation latency and atomic command execution without locks. The architecture choice for Redis is when you need more than string blobs — when you need sorted data, atomic increments, pub/sub messaging, or efficient membership queries. It wins over Memcached for almost all production use cases because it solves multiple infrastructure problems with one system: caching, queuing, pub/sub, session storage, and distributed locking."

---

_End of Topic 11 — Redis Basics_
