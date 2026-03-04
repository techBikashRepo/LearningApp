# Key-Value Storage — Part 3 of 3

### Topic: AWS Certification Focus, Comparison Tables, Quick Revision & Architect Exercise

**Series:** Scalability & Performance → Topic 12

---

## SECTION 9 — Certification Focus (AWS SAA)

### The Most Common Advanced Use Case for KV Stores

```
RATE LIMITING: WHERE KV STORES SHINE

  Goal: limit user to N requests per time window.

  Two classic algorithms using Redis key-value operations:

ALGORITHM 1: FIXED WINDOW COUNTER

  Window: each time period is a distinct counter.
  Key: rate:v1:{userId}:{endpoint}:{window_start}
  Window start: Math.floor(Date.now() / windowMs) × windowMs

  On each request:
    const key = `rate:v1:${userId}:api:${windowStart}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, windowDuration / 1000);  // set on first increment
    return count <= LIMIT;

  Problem: boundary burst.
    Window: 100 requests per minute.
    User sends 100 requests at 11:59:59.
    Window resets at 12:00:00.
    User sends 100 more at 12:00:01.
    200 requests in 2 seconds. Both windows: fully within limit.
    The boundary allows 2× burst.

ALGORITHM 2: SLIDING WINDOW LOG

  Key: rate:v1:{userId}:{endpoint} — stores timestamps of recent requests.
  Data type: SORTED SET (score = timestamp, member = request ID).

  On each request:
    const key = `rate:v1:${userId}:api`;
    const now = Date.now();
    const windowStart = now - windowMs;

    // Atomic Lua script (avoids race between ZREMRANGEBYSCORE, ZADD, ZCARD):
    const script = `
      local key = KEYS[1]
      local windowStart = ARGV[1]
      local now = ARGV[2]
      local limit = tonumber(ARGV[3])
      local requestId = ARGV[4]
      local windowMs = ARGV[5]

      redis.call('ZREMRANGEBYSCORE', key, 0, windowStart)      -- remove old requests
      local count = redis.call('ZADD', key, now, requestId)    -- add current request
      local total = redis.call('ZCARD', key)                   -- count requests in window
      redis.call('EXPIRE', key, windowMs / 1000 + 1)           -- auto-expire unused keys
      return total
    `;

    const total = await redis.eval(script, 1, key, windowStart, now, LIMIT, uuid(), windowMs);
    return total <= LIMIT;

  Advantage: no boundary burst. Exact rolling window.
  Disadvantage: memory grows with requests per user (each request = one sorted set member).
                For 1000 req/min limit × 50K users: significant sorted set memory.

ALGORITHM 3: TOKEN BUCKET

  Each user has a bucket with N tokens.
  Tokens refill at rate R per second.
  Each request consumes 1 token.

  Redis implementation: store {tokens, last_refill_time} as a Hash or atomic Float.

  Lua script (atomic fetch-and-update):
    local bucket = redis.call('HMGET', KEYS[1], 'tokens', 'last_refill')
    local tokens = tonumber(bucket[1]) or CAPACITY
    local lastRefill = tonumber(bucket[2]) or ARGV[1]
    local now = tonumber(ARGV[1])
    local refillRate = tonumber(ARGV[2])
    local capacity = tonumber(ARGV[3])

    -- Refill tokens based on elapsed time
    local elapsed = now - lastRefill
    tokens = math.min(capacity, tokens + elapsed * refillRate)

    if tokens < 1 then return 0 end  -- no tokens: reject

    tokens = tokens - 1  -- consume one token
    redis.call('HMSET', KEYS[1], 'tokens', tokens, 'last_refill', now)
    redis.call('EXPIRE', KEYS[1], capacity / refillRate + 1)  -- auto-expire when refilled
    return 1  -- allowed

  Token bucket: handles bursts gracefully (can burst up to capacity, then throttled).
  Leaky bucket: smooths output (fixed rate). Token bucket: allows burst.

  Choosing between fixed window, sliding log, and token bucket:
    Fixed window: simplest. Acceptable for most cases. Boundary burst tolerable.
    Sliding window: exact accuracy. Higher memory.
    Token bucket: burst-friendly APIs. Complex state.

RATE LIMITING AT SCALE:

  50M users × 1 rate limit key each.
  Key: rate:v1:{userId}:api → small counter value.

  Memory: hash (50M × ~50 bytes average) = 2.5GB.
  Manageable on a cache.m7g.xlarge.

  BUT: 50M × 1 request/second = 50M INCR/sec → massively overloaded.

  DISTRIBUTION STRATEGY:
    Shard rate limiting across multiple Redis instances.
    Shard by userId % NUM_SHARDS.
    Each Redis instance: handles 1/NUM_SHARDS of users.
    10 shards: 5M INCR/sec each. Still high.
    100 shards: 500K INCR/sec each. Comfortable.

  Or: use a specialized rate limiting service (AWS WAF, CloudFront rate limiting).
  For application-level rate limits (per-user per-endpoint): Redis is appropriate.
  For DDoS-level rate limits (millions of IPs): use infrastructure layer.
```

---

## SECTION 10 — Comparison Table

### DynamoDB, ElastiCache, and DAX for Key-Value Workloads

```
ELASTICACHE FOR REDIS AS PRIMARY KV STORE:

  Use cases where ElastiCache Redis IS the data store (not just a cache):
    - Session storage (data also in DB? No — sessions are ephemeral. Redis IS the store.)
    - Rate limit counters (no DB equivalent. Redis is primary.)
    - Distributed locks (no DB equivalent. Redis is primary.)
    - Pub/sub event bus (no DB equivalent. Redis pub/sub.)

  For these: persistence matters.
    Recommended: ElastiCache with AOF enabled (everysec).
    Provides: at-most-1-second data loss on node failure.
    For session data: losing 1 second of sessions → users briefly re-login. Acceptable.
    For rate limit counters: losing 1 second resets some counters. Per-user impact: negligible.

  Multi-AZ:
    ElastiCache ReplicationGroup with Multi-AZ: automatic failover on primary failure.
    Replica in a different AZ: promoted in ~60 seconds.
    During failover: reads may fail briefly. Retries with exponential backoff.

DYNAMODB AS PRIMARY KEY-VALUE DATABASE:

  For data that:
    Must be durable (not a cache layer).
    Exceeds Redis RAM capacity.
    Needs horizontal scale (DynamoDB auto-scales RCU/WCU).

  Access pattern design for DynamoDB:
    Primary key design is CRITICAL.
    DynamoDB: scans are expensive (O(N) read the whole table).
    Must design access patterns around primary key (PK) and sort key (SK).

  Single-table design:
    PK = entity type + ID: "USER#12345"
    SK = attribute: "PROFILE", "SESSION#sess_abc", "PREFERENCE#theme"

    All user data: { PK: "USER#12345", SK: "PROFILE", name: "Alice", email: "..." }
    User's session:{ PK: "USER#12345", SK: "SESSION#sess_abc", expires: 1720000000 }

    Query all data for user: PK = "USER#12345" → returns all items with that PK.
    ONE table. No JOINs.

  DAX (DynamoDB Accelerator):
    Managed in-memory caching for DynamoDB.
    Transparent cache: app sends request to DAX endpoint. DAX checks cache.
    Hit: DAX returns value (microseconds).
    Miss: DAX queries DynamoDB, caches result, returns.

    Application code: no changes needed (same DynamoDB SDK calls).
    Performance: 10× faster reads vs DynamoDB directly.

    WHAT DAX DOES NOT DO:
      Not a general-purpose Redis.
      Only works with DynamoDB queries.
      No pub/sub. No sorted sets. No Lua scripting.
      No session storage capabilities beyond what DynamoDB provides.

    Use DAX when: AWS-native DynamoDB stack, standard CRUD patterns, want managed accekeration.
    Use ElastiCache when: need Redis data types, or caching non-DynamoDB data sources.
```

---

## SECTION 11 — Quick Revision

**Scenario:** Social media platform. Need to implement: (1) Distributed rate limiting for the Feed API (authenticated user, 100 requests/minute), (2) Online presence tracking (are user's friends online now?), (3) "Recent visitors" for each profile (last 20 unique users who visited, shown to profile owner). Choose data types and design the Redis implementation.

---

**Answer:**

```
FEATURE 1: FEED API RATE LIMITING

  ALGORITHM CHOICE: Fixed window (simplest) with Lua script for atomicity.
  Boundary burst: 2× for 1-second window at boundary. Acceptable for a social feed.

  Key: rate:v1:feed:{userId}:{windowId}
  WindowId: Math.floor(Date.now() / 60000) — changes every 60 seconds.

  Lua script (atomic from Redis perspective):
    local count = redis.call('INCR', KEYS[1])
    if count == 1 then
      redis.call('EXPIRE', KEYS[1], 60)
    end
    return count

  EVAL script 1 "rate:v1:feed:{userId}:{windowId}"
  → Returns current count. If count > 100: reject with 429.

  Memory per user per window: 1 key × ~50 bytes = 50 bytes.
  50M users: 2.5GB. One ElastiCache cache.r7g.xlarge (13.1GB) handles this.

  Key expires: automatically after 60s. No manual cleanup needed.

FEATURE 2: ONLINE PRESENCE TRACKING

  "Which of user X's friends are currently online?"

  Data type: SORTED SET per user (presence set), or SET (simpler).

  APPROACH A — Global online users set:
    Key: presence:online
    Type: SET

    User comes online: SADD presence:online userId
    User goes offline: SREM presence:online userId
    User times out (no heartbeat 90s): SREM (background job)

    Check if friend is online: SISMEMBER presence:online friendId → O(1).

    Problem: "Which of user X's 500 friends are online?"
    SINTER presence:online friendsOf:X
    → Requires loading user's friend list as a Redis SET.
    SMEMBERS friendsOf:X → SINTER.
    At 500 friends: manageable. At 10,000 friends: SMEMBERS and SINTER are O(N).

  APPROACH B — Per-user presence key with short TTL (heartbeat pattern):
    Key: presence:{userId}
    Type: STRING ("1")
    TTL: 90 seconds (refreshed every 60s by client heartbeat)

    User online: SET presence:{userId} 1 EX 90
    User heartbeat: SET presence:{userId} 1 EX 90 (refreshed)
    User offline/timeout: key expires naturally after 90s.
    No explicit logout needed.

    Check single friend online:
    EXISTS presence:{friendId} → O(1). Fast.

    Check which of 500 friends online:
    Pipeline: EXISTS presence:{friend1}, EXISTS presence:{friend2}, ...
    500 EXISTS commands in one pipeline → one round-trip.

    RECOMMENDED: Approach B.
    Simpler. No explicit online/offline tracking. Heartbeat = presence.
    Each user: 1 small key (less overhead than set membership tracking).
    TTL handles cleanup automatically.

    Memory: 50K online users × 30 bytes per key = 1.5MB. Trivial.

FEATURE 3: RECENT PROFILE VISITORS (Last 20 Unique)

  "Show profile owner the last 20 unique people who visited their profile."

  Requirements:
    Unique visitors (same person visiting twice: shown once).
    Last 20 (ordered by most recent).
    Per profile.

  DATA TYPE: SORTED SET
  Key: visitors:recent:{profileId}
  Score: Unix timestamp (ms) of last visit.
  Member: visitor's userId.

  When user A visits profile of user B:
    ZADD visitors:recent:{userB} {timestamp_ms} {userA}
    → If userA already in set: ZADD updates score (overwrites with newest timestamp).
    → Automatically updates recency. Natural deduplication (set members are unique).

    LTRIM equivalent for sorted set:
    After ZADD:
    const size = await redis.zcard(key);
    if (size > 20) {
      await redis.zremrangebyrank(key, 0, size - 21);  // remove oldest entries, keep top 20 newest
    }

    Or use ZREMRANGEBYRANK to trim to 20 members:
    ZREMRANGEBYRANK visitors:recent:{userB} 0 -21
    → Keep only elements from rank -20 to -1 (20 newest, removing everything before that).

  Read visitor list:
    ZRANGE visitors:recent:{userB} 0 -1 REV WITHSCORES
    → Returns [(userId, timestamp), ...] 20 most recent visitors, newest first.

  TTL: 7 days (visitors older than 7 days not shown — add via ZREMRANGEBYSCORE on read or separate cleanup).

  COMBINED CLEANLY:
    ZADD visitors:recent:{profileOwnerId} {nowMs} {visitorId}
    ZREMRANGEBYRANK visitors:recent:{profileOwnerId} 0 -21  ← atomic trim to 20
    EXPIRE visitors:recent:{profileOwnerId} 604800           ← 7 day TTL (rolling on activity)

    Note: EXPIRE on each ZADD: always refreshes the TTL. Profile with active visitors: stays alive.
    Profile not visited for 7 days: key expires. If visited again: starts fresh.
```

---

## SECTION 12 — Architect Thinking Exercise

**Q: "What's the difference between key-value stores and relational databases? When do you use each?"**

> "Key-value stores are hash tables: O(1) lookup by known key, no query flexibility beyond that single lookup. They're optimized for one access pattern — give me the value for this specific key — and they execute that pattern in sub-millisecond time. Relational databases are indexed tables that support rich queries by any combination of attributes, with full SQL join capabilities. The latency is higher (5–10 ms) but the query expressiveness is unlimited.
>
> In practice: relational databases are the source of truth for structured data with relationships. Key-value stores (Redis, DynamoDB) are the serving layer for hot paths where you always fetch by a known ID. User profile by user ID: key-value is ideal. Reporting query by cohort, date range, and product category: relational DB. Most production systems use both."

---

**Q: "How would you implement a distributed lock using Redis?"**

> "Use SET with NX and EX flags: `SET lock:resource_id unique_value NX EX 30`. NX means 'only set if key doesn't exist' — only the first caller gets the lock. EX 30 sets a 30-second TTL so the lock automatically releases if the holder crashes before explicitly releasing it. The value must be unique per lock attempt — a UUID — so when releasing, you verify the value matches before DELeting. This prevents a late-waking process from deleting a lock that another process legitimately acquired after the TTL expired. Release is done with a Lua script: check value, if matches then DEL — that comparison-and-delete must be atomic. For cross-entity scheduled jobs: this pattern works reliably. For financial-grade coordination: RedLock (quorum across multiple Redis nodes) or Zookeeper are stronger options."

---

## === Architect's Mental Model ===

### 5 Decision Rules

**Rule 1: Key-value stores require the key design to be the access plan.**
In a relational DB, you can add indexes after the fact to support new query patterns. In a key-value store, the key IS the query. If you need to find data by an attribute that isn't in the key, you can't — short of a full SCAN. Design keys for every access pattern you need BEFORE writing data. If you discover a new access pattern later, you either need a secondary index (DynamoDB GSI), a complementary data structure (Redis Set of IDs), or you redesign your key naming.

**Rule 2: Namespace + Version in every key is non-optional in production.**
namespace:version:entity:id. The version is why. When you change how a value is structured — adding fields, changing format, migrating encoding — you need to be able to run old and new code simultaneously during rolling deploys. Old code reads v1, new code reads v2. Without the version, all cached data must be flushed atomically during deployment — which means a thundering herd migration window. With the version, old keys expire naturally via TTL while new keys populate organically. Ship the version on day one.

**Rule 3: Atomic operations are what make key-value stores useful beyond simple caching.**
INCR, SETNX, GETDEL, Lua scripts — these atomic primitives are what enable distributed rate limiting, distributed locking, and atomic counter management. Almost every Redis pattern beyond simple GET/SET relies on one of these. When designing a Redis-based feature, the first question is: which atomic operation supports this access pattern? If no single atomic operation covers it, you need a Lua script. If Lua can't express it: reconsider whether Redis is the right tool.

**Rule 4: Never use Redis as the sole store for critical business data unless you have AOF persistence enabled.**
Redis without persistence: a crash loses all data. For pure caches: fine, re-warm from DB. For session data: fine, users re-login. For rate limit counters: fine, they start fresh (some users get their limits reset unfairly, but not a business incident). For billing state, payment records, or any data that can't be reconstructed: NOT fine. Either use a persistent database or enable AOF everysec explicitly. Teams add Redis for caching and gradually accumulate critical state in it without realizing they have no durability. Audit what data in Redis cannot be reconstructed from another source.

**Rule 5: SCAN, never KEYS. Pipeline, never sequential. These are non-negotiable rules.**
KEYS blocks Redis. At production scale: blocks it for seconds. This is a team-level policy, not a code review comment. Make it impossible to deploy code that calls KEYS — add a lint rule, a PR check, or a runtime block on the Redis client configuration. The same principle applies to sequential single-command sends: if you have 10 Redis operations that don't depend on each other, pipeline them. The performance difference at scale is an order of magnitude.

---

### 3 Common Mistakes

**Mistake 1: Storing extremely large JSON values as single Redis entries.**
Redis: supports values up to 512MB. Technical limit is not a practical guide. A 5MB JSON blob stored as a single Redis string: transferred entirely to the application on every read, even if you only need one field. Also: a single large value evicted by LRU means the entire 5MB must be re-fetched from DB. Use Hash for large objects with many fields (partial field reads and updates). For truly large payloads: store in S3, cache only the metadata in Redis.

**Mistake 2: Using Redis as a message queue without consumer group semantics.**
LPUSH + BRPOP is a simple queue. It works. But: single consumer. If you need multiple consumers to process different messages in a queue (fan-out), LPUSH + BRPOP won't do it — each message is consumed by exactly one BRPOP. For multiple consumers: use Redis Streams with XREADGROUP (consumer groups — each consumer gets unique messages). Teams deploy LPUSH/BRPOP and add a "second worker" only to discover both workers race for the same message pool, creating duplicate processing. Design the consumer pattern before building the queue.

**Mistake 3: Implementing rate limiting at the wrong layer.**
Application-level rate limiting in Redis: correct for per-user business logic (100 API calls per user per hour). What it doesn't protect against: a DDoS that sends 1M requests per second from 100K IPs, each under the per-user limit. Redis receives 1M rate-limit INCR commands per second — overwhelmed before any limits fire. Infrastructure-level rate limiting (AWS WAF, CloudFront, API Gateway request throttling) handles DDoS-scale protection without touching application code or Redis. Layer your rate limiting: infrastructure for volumetric, Redis for per-user business rules.

---

### 30-Second Interview Answer

> "Key-value stores trade query flexibility for speed. You can fetch data in O(1) sub-millisecond time if you have the key. You can't query by arbitrary attributes without the key. The design challenge is: build the key around your access patterns. The standard for any production key is: namespace, version, entity type, entity ID. Namespace for ownership, version for schema migration compatibility, entity type for operational clarity, entity ID for the actual lookup. Use Redis when data is in memory and sub-millisecond latency matters — sessions, rate limits, distributed locks, cache layers. Use DynamoDB when data must be durable, exceed in-memory capacity, or needs fully-managed auto-scaling without ops overhead. Most production systems use both."

---

_End of Topic 12 — Key-Value Storage_
