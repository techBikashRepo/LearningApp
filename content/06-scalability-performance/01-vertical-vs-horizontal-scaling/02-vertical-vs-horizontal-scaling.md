# Vertical vs Horizontal Scaling — Part 2 of 3

### Topic: Real World Examples, System Design Importance, AWS Mapping & Interview Prep

**Series:** Scalability & Performance → Topic 01

---

## SECTION 5 — Real World Example

### Where Traffic Goes Under Normal and Spike Conditions

```
NORMAL TRAFFIC FLOW (100 req/sec):

  CLIENTS (100 req/sec)
       │
       ▼
  ┌────────────────────────┐
  │   Load Balancer (ALB)  │  — Routes: round-robin or least-connections
  └─────────┬──────────────┘
            │  distributes evenly
    ┌────────┼────────┐
    ▼        ▼        ▼
 ┌──────┐ ┌──────┐ ┌──────┐
 │ App  │ │ App  │ │ App  │   3 instances × 33 req/sec each
 │ Srv1 │ │ Srv2 │ │ Srv3 │   CPU: ~20% each
 │ 20%  │ │ 20%  │ │ 20%  │   Response: 80ms
 └──┬───┘ └──┬───┘ └──┬───┘
    └─────────┼────────┘
              │  all routes to same
              ▼
  ┌───────────────────────┐
  │   RDS PostgreSQL      │   20 active connections / 100 pool
  │   CPU: 15%            │   Query time: 12ms avg
  └───────────────────────┘

─────────────────────────────────────────────────────────────────────────────

TRAFFIC SPIKE (600 req/sec — 6× normal, no scaling yet):

  CLIENTS (600 req/sec)
       │
       ▼
  ┌────────────────────────┐
  │   Load Balancer (ALB)  │  — Same 3 backend instances registered
  └─────────┬──────────────┘
            │  distributes evenly
    ┌────────┼────────┐
    ▼        ▼        ▼
 ┌──────┐ ┌──────┐ ┌──────┐
 │ App  │ │ App  │ │ App  │   3 instances × 200 req/sec each
 │ Srv1 │ │ Srv2 │ │ Srv3 │   CPU: ~95% each
 │ 95%  │ │ 95%  │ │ 95%  │   Queue building: 80 req waiting per server
 │ QUEUE│ │ QUEUE│ │ QUEUE│   Response: 2,400ms P99
 └──┬───┘ └──┬───┘ └──┬───┘
    └─────────┼────────┘
              │  3× more DB queries — each instance hitting DB harder
              ▼
  ┌───────────────────────┐
  │   RDS PostgreSQL      │   95 active connections / 100 pool
  │   CPU: 90%            │   BOTTLENECK: Connection pool nearly exhausted
  │   5 connections left  │   Query time: 380ms avg (I/O saturation)
  └───────────────────────┘

─────────────────────────────────────────────────────────────────────────────

AUTO-SCALED STATE (600 req/sec — new instances launched):

  CLIENTS (600 req/sec)
       │
       ▼
  ┌────────────────────────┐
  │   Load Balancer (ALB)  │  — 9 instances registered (6 new, added in ~4min)
  └─────────┬──────────────┘
            │  distributes evenly across all 9
    ┌────────┼─────────────┬────────┐
    ▼        ▼             ▼        ▼
 ┌──────┐ ┌──────┐  ...  ┌──────┐ ┌──────┐
 │ App1 │ │ App2 │       │ App8 │ │ App9 │   9 instances × 67 req/sec each
 │ 25%  │ │ 25%  │       │ 25%  │ │ 25%  │   CPU: ~25% each
 └──┬───┘ └──┬───┘       └──┬───┘ └──┬───┘   Response: 90ms (normal restored)
    └─────────┴──────────────┘────────┘
              │
              ▼
  ┌───────────────────────┐
  │   RDS PostgreSQL      │   But now: 9 instances × 10 connections each = 90
  │                       │   DB still stressed (more app instances = more DB load)
  │   CPU: 75%            │   DB IS STILL THE BOTTLENECK LONG-TERM
  └───────────────────────┘

KEY INSIGHT FROM DIAGRAM:
  App servers scale horizontally → bottleneck shifts to the database.
  The database is the component that CANNOT easily scale horizontally for writes.
  This is WHY read replicas, connection pooling (PgBouncer), and caching (Redis)
  are required alongside horizontal app scaling.
```

---

## SECTION 6 — System Design Importance

### Decision Map: When to Use What

```
VERTICAL SCALING (scale up):
─────────────────────────────────────────────────────────────────────────
USE when:
  ✅ Single-threaded processes that can't parallelize (some legacy apps)
  ✅ Stateful services that are hard to shard (primary database writes)
  ✅ You need quick relief in < 5 minutes (resize EC2, no code change)
  ✅ The bottleneck is a single highly-coupled operation (ML model inference)
  ✅ Early-stage startup: complexity of distributed systems not yet justified

DO NOT USE when:
  ❌ You need to survive instance failures (single SPOF)
  ❌ Cost efficiency matters (idle capacity expensive on large instances)
  ❌ You're hitting hardware ceiling (c6i.32xlarge is the biggest AWS gets)
  ❌ You want zero-downtime scaling (vertical requires restart/stop)

HORIZONTAL SCALING (scale out):
─────────────────────────────────────────────────────────────────────────
USE when:
  ✅ Stateless services (every request is independent — no local state)
  ✅ You need fault tolerance (no single point of failure)
  ✅ Traffic is variable and unpredictable (auto-scaling justified)
  ✅ You're handling more than ~2,000 req/sec (vertical ceiling approaches)
  ✅ Different components need different scaling (API tier vs worker tier)

DO NOT USE when:
  ❌ The service has unshared mutable state (every instance needs to be equivalent)
  ❌ Coordination cost exceeds parallelization benefit (fine-grained locking)
  ❌ Infrastructure cost of N instances > benefit (small traffic, simple app)
  ❌ You haven't made the service stateless first
     (horizontal scaling of a stateful service = data inconsistency bugs)
```

---

### The Stateless Requirement for Horizontal Scaling

```
STATEFUL SERVICE (cannot scale horizontally):

  User logs in to App Server 1.
  App Server 1 stores session in LOCAL MEMORY.
  { userId: "usr_abc", cart: ["item1", "item2"], authenticated: true }

  Next request: Load balancer sends to App Server 2.
  App Server 2 has NO session → "You're not logged in."
  User is logged out. Data loss.

  "Solution" (wrong): sticky sessions — pin each user to one server.
  Problem: one server gets all "heavy" users. Uneven load.
  Problem: If App Server 1 crashes: all its users lose sessions.
  Problem: You've negated the benefit of horizontal scaling.

STATELESS SERVICE (can scale horizontally):

  User logs in to any server.
  Server validates password. Creates JWT or session token.

  Option A: JWT (stateless token)
    JWT contains the session data, signed by server key.
    Any server can validate the JWT signature and read the data.
    No shared state needed. ANY instance handles ANY request.

  Option B: External session store (Redis/ElastiCache)
    Session stored in Redis: { session_id: "sess_xyz", userId: "usr_abc", ... }
    Any server: "lookup sess_xyz in Redis" → gets the session.
    ANY instance handles ANY request. Redis is the shared state.

  The stateless instance: handles request, reads state from Redis or JWT,
  writes state back to Redis if changed. Then forgets everything.
  The next request can go to ANY instance.
```

---

### Database Scaling Strategies (The Hardest Part)

```
The app tier is easy to scale horizontally.
The database is where scaling gets hard.

OPTION 1: Read Replicas
  Primary DB: handles all writes.
  Replica DB: copy of primary, handles read-only queries.

  Before: 100% of queries hit primary.
  After: writes → primary; reads → replica.

  If 80% of your queries are reads: offload 80% of DB load.
  This scales read throughput. Write throughput is unchanged.

  Limitation: Replication lag. Replica may be 50-500ms behind primary.
  Read-your-own-writes problem: User writes data, immediately reads it.
  If read goes to replica (which hasn't received the write yet): stale data.
  Solution: Route writes AND the immediate reads-after-write to primary.

OPTION 2: Connection Pooling (PgBouncer / RDS Proxy)
  Problem: PostgreSQL: each connection = 10MB RAM + background process.
  100 app instances × 10 connections each = 1,000 connections.
  PostgreSQL degrades beyond ~300-400 connections.

  PgBouncer sits between app and DB:
  App → PgBouncer (handles 1,000 "virtual" connections) → PostgreSQL (30 real connections)

  App instances think they have their own connections.
  PgBouncer multiplexes them to a much smaller real connection pool.
  PostgreSQL now sees 30 connections instead of 1,000.

  This solves the "more app instances = more DB connections = DB overload" problem.

OPTION 3: Caching (Redis)
  For frequently-read, rarely-changed data:
  Product catalog, user profiles, configuration: cache in Redis.

  Read flow:
    1. Check Redis cache (< 1ms)
    2. Cache hit? Return cached value.
    3. Cache miss? Query DB (50ms). Store result in Redis. Return.

  If 40% of reads are for cached data: 40% reduction in DB read load.
  DB CPU drops proportionally.

OPTION 4: Sharding (for very large scale)
  Split the database into N shards, each owning a portion of the data.
  Shard by userId: users 0-9999→ Shard 1, 10000-19999 → Shard 2.

  Impact: Each shard handles 1/N of the write load.
  Complexity: Cross-shard queries (joins across shards) are expensive/impossible.
  Used by: Large-scale systems (Slack, Instagram, Notion) when single DB reaches limits.
  When to consider: When single primary DB CPU > 70% at moderate load after all other options exhausted.
```

---

## SECTION 7 — AWS & Cloud Mapping

### How Systems Die Under Traffic

```
FAILURE MODE 1: TIMEOUT CASCADE
─────────────────────────────────────────────────────────────────────────
Trigger: DB slows down (high load, slow queries).

Sequence:
  1. DB queries take 2 seconds instead of 50ms.
  2. App server threads blocked, waiting for DB responses.
  3. App server thread pool exhausted. New requests queue.
  4. ALB health check: app server takes 3s to respond → marked UNHEALTHY.
  5. ALB removes that instance from rotation.
  6. Remaining instances now receive MORE traffic.
  7. Those instances also hit slow DB → also time out → also hit health check threshold.
  8. ALB removes those instances too.
  9. All instances marked unhealthy. ALB returns 503 to all clients.

This is the TIMEOUT CASCADE (also called "thundering herd" on DB).
The DB slowness killed ALL app instances, not just the slow ones.

Prevention:
  • DB query timeout (max 500ms, not 30s) — fail fast
  • Circuit breaker on DB calls — fail fast when DB is unhealthy
  • Keep ALB health check threshold HIGHER than max acceptable DB query time
    (Don't let DB latency trigger health check failures — they're separate concerns)

FAILURE MODE 2: QUEUE BUILDUP / BACK-PRESSURE
─────────────────────────────────────────────────────────────────────────
Trigger: Async consumers falling behind producers.

Sequence:
  1. Publisher sends 10,000 messages/sec to SQS/Kafka.
  2. Consumer processes 1,000 messages/sec. Queue depth grows: 9,000/sec.
  3. After 10 minutes: 5,400,000 messages in queue.
  4. Lag: 9 minutes behind real-time.
  5. If messages are order notifications: "Your order is confirmed" arrives 9 minutes late.
  6. Users hit "check status" repeatedly → more load on API → more messages → worse.
  7. Consumer catches up with lag never decreases → incident.

Prevention:
  • Monitor queue depth as a scaling metric (not CPU).
  • Auto-scale consumers on queue depth: depth > 1,000 → launch 5 more consumers.
  • Dead letter queue (DLQ): messages that fail N times → separate queue for inspection.

FAILURE MODE 3: MEMORY LEAK UNDER LOAD
─────────────────────────────────────────────────────────────────────────
Trigger: Small memory leak in application code.

At normal load: leak is 1MB/hour. Insignificant. Server restarted weekly.
At 10× traffic: leak is 10MB/hour. Server OOM in 12 hours during a sale event.

Sequence:
  1. Memory climbs slowly: 40% → 50% → 70% over several hours.
  2. GC runs more frequently (JVM full GC; Node global GC).
  3. GC pauses cause latency spikes: every 30 minutes, P99 spikes to 5 seconds.
  4. At 80% memory: GC overhead > 50% of CPU. App becomes unresponsive.
  5. OOM kill. Restart. Memory starts climbing again immediately.

Prevention:
  • Heap profiling in staging under sustained load (not just short load tests).
  • Restart schedule for known leaky services (scheduled ECS task restart: every 24h).
  • Memory-based auto-scaling trigger (scale out when memory > 70%, not just CPU).

FAILURE MODE 4: THUNDERING HERD
─────────────────────────────────────────────────────────────────────────
Trigger: Cache expiration + high traffic.

Sequence:
  1. Product catalog cached in Redis. TTL: 1 hour.
  2. Cache expires at exactly 10:00:00AM.
  3. At 10:00:00AM, 500 requests arrive simultaneously.
  4. All 500 find cache miss.
  5. All 500 query the DB simultaneously.
  6. DB receives 500 concurrent queries for the same data.
  7. DB saturates. All 500 requests slow down. Cache not yet repopulated.
  8. Next 500 requests also find cache miss (still being populated).
  9. 1,000 concurrent DB queries. DB crashes.

Prevention:
  • Cache stampede protection: only ONE request rebuilds the cache,
    others wait or get stale data.
    Technique: "probabilistic early expiration" — start refreshing before TTL expires.
  • Jitter: randomize TTL (3600 ± 300 seconds) so mass expiration doesn't align.
  • Stale-while-revalidate: serve stale data while cache refreshes in background.
```

---

## SECTION 8 — Interview Preparation

**Beginner:**

**Q: What is the difference between vertical and horizontal scaling?**
**A:** Think of it like building a restaurant. Vertical scaling means replacing your small kitchen with a huge commercial kitchen â€” same one location, bigger equipment. Horizontal scaling means opening 10 identical small restaurants across town â€” same size, more locations. In tech: vertical = bigger single server; horizontal = more servers working together.

**Q: Which type of scaling should I use for a new startup?**
**A:** Start vertical â€” it's simpler (no code changes, no load balancer needed). Once you hit the ceiling of that instance type, or need high availability (so your app stays up even if one server dies), move to horizontal. Many teams run on a single server until they hit a real bottleneck.

**Q: What does "single point of failure" mean, and why does it matter?**
**A:** If your entire app runs on one server and that server crashes, your app goes down for everyone. That one server is the "single point of failure." Horizontal scaling solves this â€” if one server dies, the others keep serving traffic. Critical for production systems that need to be up 24/7.

---

**Intermediate:**

**Q: What changes must you make to your application before it can scale horizontally?**
**A:** Your app must become *stateless*: no user sessions stored in the server's memory. Move sessions to Redis or use JWTs. Uploaded files must go to S3 (not local disk). Database connections must use a pool (PgBouncer) so 10 servers don't each open 100 DB connections. Configuration must come from environment variables, not hardcoded paths.

**Q: Why is CPU utilization a bad metric for auto-scaling, and what should you use instead?**
**A:** CPU at 40% might still mean your users are waiting 3 seconds per request if the bottleneck is I/O (database waits, external API calls). Use P99 response latency or ALB TargetResponseTime as the scale metric. Latency tells you what users actually experience. CPU tells you what the processor is doing â€” those are different things.

**Q: What is the thundering herd problem during a scale-out event?**
**A:** When traffic spikes and 5 new servers launch simultaneously, they all start with cold caches, opening new database connection pools at the same time. This creates a brief surge of DB connections (5 Ã— 100 = 500 new connections opened in seconds), potentially overwhelming the database. Mitigate with RDS connection pooling (PgBouncer), staggered instance launch, and pre-warming caches before sending traffic.

---

**Advanced (System Design):**

**Scenario 1:** Your Node.js API is running on a single 	3.xlarge (4 vCPU, 16GB RAM) and hitting 85% CPU at 1,000 concurrent users. The CTO wants it fixed in 4 hours. Walk through your response.

*Immediate (under 30 min):* Vertical scale to 	3.2xlarge (8 vCPU) â€” single click, ~3 min downtime. Buys time.
*Within 4 hours:* Identify what is consuming CPU (profiling, not guessing). If compute-bound: add ALB + clone instance. If DB-bound: add read replica + connection pooler.
*Prevent recurrence:* Auto-scaling group with target tracking on P99 latency. Session state moved to Redis. Load test at 3Ã— peak before next release.

**Scenario 2:** Design an e-commerce checkout system that handles 100 req/sec on a normal day but 10,000 req/sec during a Black Friday sale â€” with zero downtime during scale-out.

*Architecture:* ALB â†’ Auto-Scaling Group of stateless EC2 instances â†’ RDS with read replicas + PgBouncer â†’ ElastiCache for session/product cache â†’ SQS for order processing queue (decouple payment from checkout response).
*Auto-scaling:* Target tracking policy: scale when P99 > 300ms. Min=3, Max=50. Use pre-warming: schedule scaling action at 8AM on sale day.
*Zero downtime:* Blue/green deployment so new instances register before old ones drain. Health check with 3-attempt grace period.
*Database:* Checkout writes go to primary. Product lookups â†’ cache first, read replica fallback.

