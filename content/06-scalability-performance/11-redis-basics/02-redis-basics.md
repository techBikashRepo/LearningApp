# Redis Basics — Part 2 of 3

### Topic: Real World Examples, System Design Importance, AWS Mapping & Interview Prep

**Series:** Scalability & Performance → Topic 11

---

## SECTION 5 — Real World Example

### Why Redis Is Single-Threaded and Why That's a Feature

```
THE COMMON MISCONCEPTION:
  "Single-threaded = slow and limited."

  Redis: single thread for command processing.
  But: can handle ~1,000,000 operations/second on modern hardware.

  WHY IS IT FAST DESPITE SINGLE THREAD?

  1. ALL DATA IN MEMORY.
     No disk I/O on the command path (only for persistence, async).
     Memory access: nanoseconds. Disk access: microseconds to milliseconds.
     A Redis command: memory lookup (~100ns) + command execution (~100ns) + response write (~100ns).
     Total: ~1 microsecond. 1,000,000 operations/second follows naturally.

  2. NO LOCKING.
     No mutex, no semaphore, no deadlock investigation.
     Only ONE thread modifies data → no competing writes → no synchronization needed.
     Lock overhead: eliminated.

  3. ATOMIC COMMANDS.
     INCR key: guaranteed to be atomic. No read-modify-write race.
     MULTI/EXEC block: guaranteed to execute without interruption.
     GETSET: atomic GET and SET in one operation.
     These atomicity guarantees ONLY work because of single-threading.

  4. EVENT LOOP (I/O MULTIPLEXING).
     Redis uses epoll/kqueue: one thread handles many socket connections.
     Client connection 1 sends a command → Redis starts processing.
     Client connection 2's data arrives → epoll wakes Redis → queued.
     Single thread: processes queued commands sequentially.
     All N connections served. No N threads needed.

WHERE SINGLE THREAD IS A LIMITATION:

  1. CPU-BOUND OPERATIONS BLOCK ALL CLIENTS:
     KEYS "*" on 10M keys: scans entire keyspace.
     Takes ~2 seconds. Redis is BLOCKED for 2 seconds.
     All other commands: queued. P99 latency: 2 seconds. Service appears hung.

     Solution: use SCAN (cursor-based, non-blocking batches).

  2. EXPENSIVE SINGLE COMMANDS:
     SORT with 1M elements. ZUNIONSTORE of two 100K sorted sets.
     O(N log N) operations on large data: block the event loop.

     Solution: offload heavy computation to application code.
     Read with SCAN, sort/aggregate in application layer.
     Redis for access, not computation.

  3. DOESN'T SCALE ACROSS CPU CORES (for single-thread command processing):
     Redis 6.0+: I/O threading for reading/parsing requests and writing responses.
     But: command execution still single-threaded.

     This means: one Redis process ≈ one CPU core for command execution.
     For more throughput: Redis Cluster (multiple shards, each single-threaded).
     Or: separate read load to replicas (reader endpoint).

  REDIS 6.0+ THREADED I/O:
    Multiple I/O threads: handle parsing incoming requests, writing responses.
    Single execution thread: still runs commands.
    Benefit: removes I/O parsing as bottleneck at very high QPS.
    Net: Redis 6+ can sustain 2–3× higher throughput on I/O-bound workloads.
    Command execution: still serial. Atomicity guarantees unchanged.
```

---

## SECTION 6 — System Design Importance

### How Redis Manages RAM

```
REDIS MEMORY ALLOCATOR:
  Redis uses jemalloc (default on Linux) for memory allocation.
  jemalloc: reduces fragmentation better than system malloc.

  MEMORY FRAGMENTATION:
    Over time: Redis allocates and frees small objects constantly.
    Holes appear in memory (freed space that can't be reused for larger objects).
    fragmentation_ratio = used_memory_rss / used_memory

    Healthy: < 1.3 (30% overhead maximum).
    Concerning: > 1.5 (50% overhead — significant waste).
    Critical: > 2.0 (doubling of memory usage due to fragmentation alone).

    Check: redis-cli INFO memory | grep fragmentation
    Fix: redis-cli MEMORY PURGE (triggers jemalloc defragmentation)
    Auto-fix: activedefrag yes (background defragmentation — adds CPU overhead).

  MEMORY OBJECT TYPES AND SIZES:

    String "hello world": ~56 bytes total overhead (SDS + hash table entry + pointer + alignment).
    "hello world" data:   11 bytes.
    Redis overhead ratio: 5:1 for tiny strings.

    This is why: HSET user:123 name "Alice" age "30" department "Engineering"
    is MORE memory-efficient than:
    SET user:123:name "Alice"
    SET user:123:age "30"
    SET user:123:department "Engineering"

    The Hash (listpack encoding): stores all 3 fields as a packed array.
    Total overhead: ~1 object (hash) + 3 fields as bytes.
    Three separate keys: 3 × 56 bytes overhead + data.
    Savings: 100+ bytes per user. At 5M users: 500MB saved.

EVICTION POLICIES:

  When maxmemory is reached: Redis must evict keys OR reject writes.

  Policy: maxmemory-policy <value>

  EVICTION ALGORITHMS:

  noeviction:
    Writes return OOM error when maxmemory is full.
    Reads: still work.
    Use for: write-back buffers (never evict unflushed data).
    Use for: durable data that must not be lost.

  allkeys-lru:
    Evict LEAST RECENTLY USED key from ALL keys.
    Best for: pure cache where all keys can be re-fetched.
    Note: not a true LRU — Redis samples N keys (default 5) and evicts the LRU among the sample.
    Set maxmemory-samples 10 for better approximation (trades CPU for accuracy).

  allkeys-lfu:
    Evict LEAST FREQUENTLY USED from ALL keys.
    Better than LRU for workloads where some keys are hot despite not being recent.
    E.g., daily report cache: accessed once per day but very important.
    LRU: evicts it (not recently accessed). LFU: keeps it (accessed predictably).

  volatile-lru:
    Evict LRU key FROM KEYS WITH TTL ONLY.
    Keys without TTL: protected (never evicted).
    Use for: mixed cache + write-back pattern.
    Write-back buffers (no TTL): safe. Cache entries (have TTL): subject to eviction.

  volatile-lfu:
    LFU from TTL-bearing keys only.

  volatile-ttl:
    Evict key with shortest remaining TTL first.
    Intuition: near-expiry keys are "almost useless anyway."
    In practice: near-expiry keys might be hot. Often worse than LRU/LFU.

  allkeys-random:
    Random eviction. Rarely appropriate. Included for completeness.

PRACTICAL MEMORY SIZING:

  Target: maxmemory = working_set_size × 1.3 (30% headroom for fragmentation + eviction space).

  Working set estimation:
    hot product catalog: 5,000 products × 2KB = 10MB
    user sessions: 50,000 active × 500B = 25MB
    rate limit counters: 10,000 users × 200B = 2MB
    search cache: 100 popular queries × 5KB = 500KB

    Total: ~38MB. maxmemory: 50MB recommended.

  Monitor: CurrItems + BytesUsedForCache. Alert on > 80% of maxmemory.
```

---

## SECTION 7 — AWS & Cloud Mapping

### Choosing Durability for Your Use Case

```
THREE PERSISTENCE OPTIONS:

1. RDB (Redis Database Snapshot)

   Mechanism: periodic full snapshot of dataset to a binary file (dump.rdb).
   Frequency: configurable triggers (e.g., save 900 1 = save if 1 key changed in 900s).

   CREATE SNAPSHOT PROCESS:
   Redis forks. Child process: serializes entire dataset to disk.
   Parent: continues serving requests (writes are copy-on-write).
   Fork: near-instantaneous (page table copy, not data copy).
   Child: writes snapshot in background. Completes in seconds to minutes.

   DATA LOSS WINDOW: from last snapshot to crash.
     Snapshot every 5 min + crash at 4:59 = ~5 min of lost writes.
     For cache: acceptable.
     For session storage: losing last 5 min of session data → users logged out. Might be acceptable.
     For write-back buffers: losing unflushed writes. Usually NOT acceptable.

   PERFORMANCE:
     Fork: fast (milliseconds).
     Child writing: consumes disk I/O. On busy systems: may compete with application.
     CPU: low (snapshot writing is child process, parent unaffected).
     Memory: during snapshot, copy-on-write pages may increase memory ~30%.

   USE FOR: Pure caches where some data loss is acceptable.
             Fast restart (loads RDB at startup without replaying logs).

2. AOF (Append-Only File)

   Mechanism: every write command appended to aof file.
   On restart: replay all commands to rebuild state.

   FSYNC OPTIONS (critical choice):

   appendfsync always:
     Every command: force fsync to disk before returning to client.
     Durability: maximum. No data loss.
     Performance: drastically reduced (every write = disk sync ≈ 1ms).
     Throughput: ~10,000 writes/sec maximum (disk I/O bound).

   appendfsync everysec (RECOMMENDED DEFAULT):
     Fsync every second.
     Durability: at most 1 second of data loss on crash.
     Performance: good. Fsync in background thread. Commands don't wait.
     Throughput: ~100,000 writes/sec possible.

   appendfsync no:
     OS decides when to flush (usually every 30s).
     Durability: up to 30s of data loss.
     Performance: best (no explicit fsync).
     Suitable: when even AOF "no" data loss window is acceptable.

   AOF REWRITE:
     Over time: AOF file grows. "SET x 1; SET x 2; SET x 3" = 3 commands.
     All setting the same key. Only the last matters.
     AOF rewrite: compacts to current state (just "SET x 3").
     Triggered: auto-rewrite when file doubles in size (auto-aof-rewrite-min-size).

   USE FOR: Sessions, write-back audit trails, data that must survive restarts.

3. RDB + AOF (Hybrid)

   Both enabled simultaneously:
   RDB file: loaded on startup (fast recovery).
   AOF: replayed on top of RDB (fills in last N seconds of writes after snapshot).

   Best of both:
     Fast startup (RDB loads instead of replaying full AOF).
     Near-zero data loss (AOF everysec = 1s maximum).

   Cost: both consumption on disk. More complex.
   Recommended for: production systems where both restart speed AND data durability matter.

4. NO PERSISTENCE (Pure Cache)

   Save "" (disable RDB save rule).
   appendonly no.

   On Redis restart: empty. Application must re-warm from DB.

   USE FOR: Pure cache-aside use cases where re-warming from DB is fast and acceptable.
             Maximum write throughput (no disk I/O on any path).
             Most common for ElastiCache in pure caching roles.

PERSISTENCE DECISION GUIDE:

  "Is this data also in the DB?" YES → no persistence (pure cache). Re-warm on restart.
  "Is this data ONLY in Redis?" YES → at minimum RDB. Consider AOF everysec.
  "Write-back buffer?" → AOF always OR RDB with very frequent saves.
  "Session data?" → RDB + AOF hybrid OR accept ~1s loss with AOF everysec.
```

---

## SECTION 8 — Interview Preparation

**Beginner:**

**Q: What makes Redis different from a regular database like PostgreSQL?**
**A:** Redis keeps ALL its data in RAM (memory), while PostgreSQL keeps data on disk. RAM access = ~100 nanoseconds. Disk access = ~100 microseconds (1,000Ã— slower). This is why Redis can handle 100,000+ operations per second and return results in under 1 millisecond. The tradeoff: RAM is expensive and limited, disk is cheap and abundant. So Redis stores only the most-needed hot data; PostgreSQL stores everything persistently.

**Q: What data types does Redis support and why does it matter?**
**A:** Redis isn't just key-value strings. It supports: Strings (text, numbers, binary), Lists (ordered, like a queue), Sets (unique items, like tags), Sorted Sets (ranked leaderboards), Hashes (object fields), and Geo (geographic coordinates). This matters because you get efficient built-in operations: LPUSH/RPOP for message queues, ZADD/ZRANGE for leaderboards, GEOADD/GEORADIUS for location â€” instead of writing complex query logic.

**Q: Is data lost if Redis restarts?**
**A:** By default, yes â€” Redis is in-memory. But Redis supports persistence: RDB snapshots (periodic full dump to disk, minor data loss on crash) and AOF (append-only file that logs every write command, recoverable to within 1 second). For cache use cases, data loss on restart is acceptable (cache is rebuilt from DB). For Redis as a primary store (sessions, queues), enable AOF persistence.

---

**Intermediate:**

**Q: Why is Redis single-threaded, and how does it still handle 100,000+ ops/second?**
**A:** Redis uses a single thread for command execution because: (1) RAM operations are so fast that multi-threading overhead (locks, context switches) would slow it down. (2) Single-threaded means no concurrency bugs â€” all operations are inherently atomic. It achieves high throughput through: *I/O multiplexing* (one thread handles thousands of network connections using epoll/kqueue), *pipelining* (clients batch multiple commands in one TCP round trip), and the fact that most commands complete in microseconds.

**Q: What is Redis pipelining and when should you use it?**
**A:** Pipelining lets you send multiple commands to Redis in one batch without waiting for individual responses. Normal: send command â†’ wait â†’ send command â†’ wait (RTT adds up). Pipelined: send 100 commands â†’ receive 100 responses in one round trip. Use when you need to execute multiple independent Redis operations: bulk cache warming, initializing multiple cache keys from DB results, or processing a batch of changes. Not suitable when each command depends on the previous command's result.

**Q: What is Redis Cluster and when do you need it?**
**A:** Redis Cluster shards data across multiple Redis nodes â€” each node owns a subset of the 16,384 hash slots. Use when: (1) Data exceeds RAM of a single Redis node (>32GB cache). (2) You need higher write throughput than one Redis can provide. (3) You need automatic failover without manual intervention. Cluster complicates multi-key operations (keys must be on the same shard for transactions). Use Redis Cluster for large-scale production; single Redis with replica is sufficient for most apps.

---

**Advanced (System Design):**

**Scenario 1:** Design a real-time leaderboard for a mobile game with 1 million daily players. The leaderboard shows the top 100 players globally with live rank updates. Score updates arrive at 500,000/second during peak hours.

*Redis Sorted Set solution:* ZADD leaderboard:{todays_date} score userId on every score event. Top 100 leaderboard: ZREVRANGE leaderboard:{date} 0 99 WITHSCORES (O(log N + 100)). User's own rank: ZREVRANK leaderboard:{date} userId (O(log N)). Atomic: no race conditions in Redis.
*Scale for 500K updates/second:* Single Redis node handles ~150K writes/sec. For 500K: shard by user range (Redis Cluster, 4 nodes) OR use Kafka â†’ aggregate scores â†’ batch-update Redis every 100ms. Batch updates reduce Redis ops from 500K to ~10K per second.

**Scenario 2:** Your existing Redis deployment is running at 85% memory utilization (out of 32GB). You're onboarding a new customer that will add 20% more data. You have two options: (a) increase Redis instance size (vertical), or (b) add Redis clustering (horizontal). Analyze the tradeoffs and make a recommendation.

*Vertical (instance resize):* Zero code changes. AWS ElastiCache: change from r6g.2xlarge (32GB) to r6g.4xlarge (64GB). Downtime: ~seconds for failover. Cost: ~2Ã— instance cost. Simple.
*Horizontal (cluster):* More complex (multi-shard aware client code, no cross-shard multi-key commands). Requires testing. But: linear scalability beyond what vertical can offer. No single point of memory failure.
*Recommendation:* Vertical scale for immediate need (simple, fast, maintainable). Plan for cluster migration at 70% of the new instance's capacity â€” don't wait for a second emergency.

