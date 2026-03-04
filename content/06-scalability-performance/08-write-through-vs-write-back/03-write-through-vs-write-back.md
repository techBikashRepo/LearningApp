# Write-Through vs Write-Back — Part 3 of 3

### Topic: AWS Certification Focus, Comparison Tables, Quick Revision & Architect Exercise

**Series:** Scalability & Performance → Topic 08

---

## SECTION 9 — Certification Focus (AWS SAA)

### TTL Behaves Differently Per Write Pattern

```
WRITE-THROUGH TTL STRATEGY:

  Since cache is always current (matches DB at write time):
  TTL is NOT for freshness — it's for memory management.

  TTL = "How long should this item stay in cache after the last write?"

  User profile: write-through on every update.
    Last update: 6 months ago. Nobody's accessed this profile since.
    Without TTL: profile stays in cache forever. Memory wasted.
    TTL = 7 days: profile stays 7 days after last write. Then auto-evicted.

  User profile that's READ frequently:
    Problem: each read should reset TTL (keep hot items in cache).
    Solution: SETEX on every WRITE + reset TTL on READS.

    On read (cache hit):
      EXPIRE user:usr_a1 86400   // reset TTL to 24h on each access
    This is the "sliding expiry" or "read-extending TTL" pattern.
    Hot items: TTL never expires (kept alive by reads).
    Cold items: TTL expires (evicted after no reads for 24h).

WRITE-BACK TTL STRATEGY:

  TTL can cause data loss in write-back if not handled carefully.

  Scenario: SETEX leaderboard_entry:player_abc 60 { score: 9500 }
  At t=59s: flush worker hasn't run yet.
  At t=60s: TTL expires. Key deleted from Redis.
  At t=61s: flush worker runs: key not found. Nothing to flush.
  DATA LOST.

  FIX 1: NEVER set TTL on the write-back buffer itself.
  The buffer key should persist until explicitly flushed.
  TTL = infinity (no EXPIREAT).
  After flush: explicitly DEL the key (or LTRIM the list).

  FIX 2: Buffer in a persistent data structure + separate the display cache.
    Write-back BUFFER: Redis LIST write_queue:{entity} — NO TTL. Must flush.
    Display CACHE: Redis key product:{id} — WITH TTL. Used for reads.
    These are separate keys with different semantics.

    Flush worker: reads from write_queue:* (durable buffer), writes to DB,
                  then updates display cache key with result.
    The display cache: can expire. If expired, re-read from DB.
    The write buffer: must NOT expire — it holds unflushed writes.
```

---

## SECTION 10 — Comparison Table

### ElastiCache Patterns for Write-Through and Write-Back

```
WRITE-THROUGH ON AWS:

  Pattern: App writes to RDS Aurora + ElastiCache Redis simultaneously.

  Infrastructure:
    Aurora Multi-AZ: handles writes, auto-failover.
    ElastiCache Replication Group: stores cached writes.

  Write path:
    1. POST /api/users/profile
    2. App: BEGIN; UPDATE users ...; COMMIT; (Aurora Primary)
    3. App: redis.SETEX user:{id} 3600 {payload} (Redis Primary)
    4. Return 200.

  Aurora Write Failover impact on write-through:
    Aurora primary fails → DNS failover → new primary in ~30s.
    During 30s: DB writes fail → write-through also fails (no DB write = no cache write).
    This is CORRECT: write-through should not update cache if DB write failed.

  Redis node failure impact:
    Primary fails → ElastiCache promotion of replica (~10–60s).
    During promotion: writes fail to Redis.
    Implementation: catch Redis error → log → return success anyway (DB write succeeded).
    On recovery: Redis is empty for any keys that were being written-through.
    Cache-aside fallback: reads miss cache → re-populate from DB writes going forward.

WRITE-BACK ON AWS:

  Pattern: App writes to ElastiCache → SQS/Kinesis queue → Lambda/ECS flush consumer.

  Infrastructure:
    ElastiCache: accepts high-volume writes.
    SQS → Lambda: flush worker with DLQ.
    Aurora: receives batches from flush Lambda.

  Write-back flush architecture:

  ┌──────────┐   ZADD/LPUSH   ┌───────────────┐
  │  App     │───────────────►│ ElastiCache   │
  └──────────┘                │ Redis         │
                              └───────┬───────┘
                                      │
                                      │ Every 30s
                                      │ (EventBridge Scheduler)
                              ┌───────▼───────┐
                              │ Flush Lambda  │
                              │ • ZSCAN data  │
                              │ • batch UPSERT│
                              │ • idempotent  │
                              └───────┬───────┘
                                      │ on failure
                              ┌───────▼───────┐
                              │ DLQ (SQS)     │   Alert on DLQ depth > 0.
                              │              │   Retry with backoff.
                              └──────────────┘
                                      │ on success
                              ┌───────▼────────┐
                              │ Aurora RDS     │
                              │ INSERT ON      │
                              │ CONFLICT UPDATE│
                              └────────────────┘

  LAMBDA FLUSH WORKER (idempotent batch):
    exports.handler = async () => {
      const items = await redis.zscan('leaderboard:scores', 0, 'COUNT', 10000);
      if (!items.length) return;

      const batch = items.map(([memberId, score]) => ({
        playerId: memberId,
        score: parseFloat(score),
        updatedAt: new Date()
      }));

      // Idempotent: ON CONFLICT (player_id) DO UPDATE
      await db.batchUpsert('leaderboard', batch, ['player_id'], ['score', 'updated_at']);

      // Only clear after DB confirms
      await redis.zremrangebyrank('leaderboard:scores', 0, batch.length - 1);
    };

  DLQ alarm: failures > 0 for > 5 minutes → PagerDuty alert.
  Manual recovery: Lambda re-runs from DLQ messages.
```

---

## SECTION 11 — Quick Revision

**Scenario:** A SaaS project management tool. Users update task status (drag-and-drop) very frequently — up to 50 updates/second during business hours. Also: a team dashboard shows aggregate stats (open tasks, completed tasks per project) — very high read frequency, computed from task status. Design the write strategy for task status + dashboard stats.

---

**Answer:**

```
ENTITY 1: Task Status Updates

  ANALYSIS:
    50 updates/second can go directly to RDS Aurora (handles ~2,000 writes/s).
    Not a throughput problem. But: there's a UI concern.

    User drags task to "Done". UI needs to reflect immediately.
    Request: PATCH /tasks/task_abc { status: "done" }

    IF using cache-aside:
      PATCH → DB UPDATE → DEL cache: task:task_abc
      User's next GET → cache miss → DB read → ✅ fresh.
      But: client optimistically shows "done" already.
      Server cache miss is fine — it's a server-side concern.

    IF using write-through:
      PATCH → DB UPDATE → SETEX task:task_abc 3600 {status: "done"}
      User's next GET → cache HIT → ✅ fresh.

  DECISION: Cache-Aside (simpler) for individual task reads.
    Reason: task reads are by ID (already O(1)), drag-and-drop is not a throughput
    problem, and write-through would pollute cache with the other 90% of task data
    that users never visit again.

  KEY: task:{taskId}
  TTL: 1 hour + jitter
  On write: DEL task:{taskId}

ENTITY 2: Dashboard Aggregate Stats

  ANALYSIS:
    "Open tasks: 42. Completed: 117. In progress: 23."
    Computed: SELECT status, COUNT(*) FROM tasks WHERE project_id=? GROUP BY status.

    If this runs on every dashboard load:
    1,000 users checking dashboards every 30 seconds = 33 queries/sec.
    Each: GROUP BY aggregation, not a simple PK lookup.
    At scale: hundreds of queries/sec of GROUP BY = DB under pressure.

    These stats: acceptable to be 30 seconds stale.
    Users tolerate "approximately current" dashboards.

  DECISION: Write-Back / Pre-Computed Stats in Redis.

    On EVERY task status change:
      HINCRBY project:stats:proj_xyz done 1
      HINCRBY project:stats:proj_xyz total 0  (no change)

    On task status CHANGE (e.g., open → done):
      HINCRBY project:stats:proj_xyz open -1
      HINCRBY project:stats:proj_xyz done +1

    Dashboard read:
      HGETALL project:stats:proj_xyz → { open: 42, done: 117, in_progress: 23 }
      0 DB reads. 0.5ms.

    DB sync (write-back flush):
      Background job: every 60s → read Redis stats → UPDATE project_stats table.
      Also: on critical events (project export, billing, reporting) → always read DB.

    COLD START RECOVERY:
      Redis empty on restart:
        Dashboard read: cache miss → DB GROUP BY → populate Redis.
        For N projects missing stats: N GROUP BY queries on startup.
        Mitigation: lazy per-project rebuild on first miss. Non-simultaneous.

    DRIFT CORRECTION:
      Redis counters drift over time due to:
        Race conditions during concurrent increments (HINCRBY is atomic — no race).
        But: the flush worker crashing mid-cycle.

      Daily reconciliation job:
        Recompute all project stats from DB.
        SET Redis stats = verified DB stats.
      This prevents months of accumulated drift.
```

---

## SECTION 12 — Architect Thinking Exercise

**Q: "When would you use write-back over write-through and what's the risk?"**

> "Write-back is for write-volume that exceeds what the DB can safely absorb synchronously. Gaming scores, like counts, view counters, analytics events — all extremely write-heavy, all acceptable to lose a small window of data if the cache crashes. You write to Redis immediately (sub-millisecond), and a background worker flushes to the DB in batches periodically.
>
> The risk is data loss. Any writes in Redis that haven't been flushed to DB when Redis crashes are gone permanently. This is why write-back is never appropriate for financial transactions, audit records, or any data where 'we lost 30 seconds of state' is an incident. The design rule: if data loss of one flush interval would cause a business or compliance incident, don't use write-back."

---

**Q: "What's the problem with write-through if your system has many write-only entities?"**

> "Cache pollution. Write-through populates the cache on every write, regardless of whether that data will ever be read. If your users generate event logs, click tracking, or any data written once and never queried, write-through fills your cache with data that has 0% hit rate. Meanwhile, LRU eviction starts removing YOUR frequently-read product catalog and user profiles to make room.
>
> The symptom: cache hit rate drops, DB load rises, even though you've added caching everywhere. The fix: selective write-through — only apply it to entities where the same user reads the data they just wrote. For append-only, write-once data: use cache-aside or don't cache at all."

---

## === Architect's Mental Model ===

### 5 Decision Rules

**Rule 1: Write-through for read-your-own-writes flows; write-back for write volume exceeding DB capacity.**
These patterns solve fundamentally different problems. Write-through solves the UX problem of users seeing stale data after their own write. Write-back solves the infrastructure problem of write throughput exceeding the DB's write limit. Pick based on the actual problem, not preference.

**Rule 2: Write-back requires idempotent DB flush operations.**
If your flush worker can crash and retry, the DB must tolerate duplicate writes. INSERT ... ON CONFLICT (unique_id) DO UPDATE is not optional for write-back. Without idempotency, a crash and retry causes duplicate records, violated unique constraints, and stuck retry loops. Design idempotency before you design the flush logic.

**Rule 3: Never use write-back for financial data, audit records, or compliance-required writes.**
The loss window is real. Redis OOM eviction, hardware failure, or a network partition between cache and flush worker can and will cause data loss. For any data where "we can't find that record" leads to a regulatory or financial consequence: synchronous DB writes are mandatory. No exceptions.

**Rule 4: Write-through should be selective — not applied to all writes.**
Applying write-through to every entity means cache pollution for write-heavy, read-rarely data. Identify the entities where read-after-write is the actual user pattern (profiles, settings, cart, preferences). Apply write-through there. For high-volume events and analytics: never write-through.

**Rule 5: Always have a drift correction mechanism for write-back counters.**
Redis counters (INCR, HINCRBY) are atomic and won't have race conditions. But the cumulative flush-to-DB path is fallible. Over weeks, counters can drift from DB values due to unprocessed retries, partial flushes, or Redis node replacements. A weekly or daily reconciliation job that resets Redis counter values from DB is a mandatory component of any write-back counter architecture.

---

### 3 Common Mistakes

**Mistake 1: Using write-through without handling the DB-succeeds/Redis-fails case.**
Team implements: DB update + Redis SETEX in a transaction. Redis write fails. Team throws an error and returns 500 to the user — even though the DB write succeeded. The user retries. Potentially writes the same data twice. The DB is the source of truth. A Redis write failure in a write-through operation should be logged, metrics should be incremented, but the operation should succeed (DB write determines success). Cache will self-heal on the next read.

**Mistake 2: Write-back buffers with TTLs.**
Setting an expiry on your Redis write buffer is the same as accepting data loss on a timer. If the flush worker falls behind or misses a run, your unflushed data simply disappears when the TTL fires. Write buffers must have no TTL — only be cleared explicitly after the flush confirms the DB write. Display caches can have TTLs. Write buffers cannot.

**Mistake 3: Not monitoring write-back queue depth as a first-class metric.**
Write-back queue (Redis LIST or Sorted Set containing unflushed writes) is the risk accumulator. Every item in the queue is a pending data loss if the cache crashes. Teams instrument "items flushed per cycle" but not "items waiting to be flushed." An unbounded growing queue means your flush worker is slower than your write rate — you're accumulating increasing risk with every passing second. Alert on queue depth > 2× your flush cycle capacity. This is a more important alert than Redis CPU or memory.

---

### 30-Second Interview Answer

> "Write-through and write-back solve different problems. Write-through updates both cache and DB synchronously on every write — it solves the read-your-own-writes problem where users see stale data immediately after their own update. The cost is write latency grows and cache can get polluted with write-only data. Write-back writes to cache immediately and flushes to DB asynchronously in batches — it solves write throughput problems when your write rate exceeds what the DB can absorb in real time. The critical tradeoff is data loss: the unflushed window between cache write and DB flush is permanently lost if the cache crashes. Use write-through for user-facing entities where UX consistency matters. Use write-back only for data where bounded data loss, like a few seconds of counters or scores, is acceptable. Never use write-back for financial or audit data."

---

_End of Topic 08 — Write-Through vs Write-Back_
