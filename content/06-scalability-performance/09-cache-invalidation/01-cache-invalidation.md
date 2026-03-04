# Cache Invalidation — Part 1 of 3

### Topic: Foundations — Intuition, Core Concepts, Architecture & Data Flow

**Series:** Scalability & Performance → Topic 09

---

## SECTION 1 — Intuition (Explain Like a 12-Year-Old)

```
THE NEWSPAPER RACK PROBLEM:

  Coffee shop. Newspaper rack at the entrance.
  Every morning: today's paper placed on the rack.
  Customers: walk in, grab a paper, read the news.

  THE PROBLEM:
  Tomorrow morning: new papers arrive.
  Staff member: places new papers on ANOTHER rack.
  Yesterday's papers: still on the original rack.

  Customers: walk in, grab from original rack.
  They read yesterday's news all day.
  Staff never removed the old papers.

  This is a cache without invalidation.
  The data exists. It's accessible. It's wrong.

  STRATEGY 1 — TTL (time-based expiry):
    Each paper: has a printed date.
    Policy: "Any paper older than today's date: discard automatically."
    Result: papers are auto-discarded after 24 hours.

    Downside: for 23 hours and 59 minutes, yesterday's paper is valid.
    Major breaking news at 2PM: the morning paper says nothing about it.
    Users read all day: outdated news for up to 24h.

    For most content: acceptable.
    For stock prices: unacceptable. For emergency alerts: dangerous.

  STRATEGY 2 — Active Invalidation (staff removes when new arrives):
    Staff policy: when new papers arrive, IMMEDIATELY remove all old ones.
    New papers replace old papers in real time.

    Advantage: users always see current paper.
    Requires: staff to actively manage the rack.
    Application equivalent: code that explicitly DELetes cache keys on update.

  STRATEGY 3 — Event-Driven Invalidation:
    Newspaper office publishes a "new edition available" signal.
    Coffee shop: receives signal → sends staff to remove old papers → places new ones.

    Application equivalent: DB publishes change events (CDC) → cache invalidation service
    subscribes → removes affected cache keys automatically.

  THE CRITICAL INSIGHT:
    In all three strategies: there's a WINDOW between the old paper being on the rack
    and the new paper replacing it. Even with active invalidation:

    t=0: staff starts removing old papers (takes 10 seconds).
    t=5: customer grabs old paper (still on rack).

    This is the WINDOW OF INCONSISTENCY.
    Every caching system has it. The goal: MINIMIZE it, not eliminate it.

    The only way to eliminate it: don't cache at all.
    The engineering question: what is the acceptable window for each data type?
```

---

## SECTION 2 — Core Technical Explanation

### Three Strategies, Three Tradeoffs

```
THE FUNDAMENTAL CHALLENGE:
  Databases are authoritative. Caches are mirrors.
  When the authority changes, the mirror must change too.
  The mechanism for updating the mirror = cache invalidation.

  Phil Karlton (Netscape): "There are only two hard things in Computer Science:
  cache invalidation, and naming things."

  This is only half a joke. Cache invalidation IS genuinely difficult because:
    - It's distributed: cache and DB are different systems.
    - It's asynchronous: "update DB → invalidate cache" is two operations, not one.
    - Race conditions exist in the gap between the two operations.
    - Fanout is complex: one DB row can affect many cache keys.

STRATEGY 1: TTL-ONLY INVALIDATION
  Mechanism: set a TTL when caching. Cache auto-expires after TTL.
  No explicit invalidation code.

  Simplicity: maximum. No invalidation code to maintain or debug.
  Consistency: bounded. Stale window = TTL.
  TTL = 60s: worst case 60 seconds of wrong data.

  WHEN IT'S SUFFICIENT:
    Product thumbnail images: change rarely. Staleness OK.
    Category lists: change once a day. TTL 1hr is fine.
    Public blog posts: once published, rarely modified. TTL 24hr.
    Sports scores: real-time value, but 30-second staleness acceptable to fans.

  WHEN IT'S BROKEN:
    User account: user changes email. TTL 1hr.
    For 1 hour: user receives emails at OLD address (from cached old email).
    Password reset: sent to old email. User can't log in. Support ticket.
    MUST use active invalidation here.

STRATEGY 2: ACTIVE INVALIDATION (Explicit DEL on Write)
  Mechanism: on DB write, explicitly DEL the affected cache key.
  Application code manages all invalidation explicitly.

  TTL: still present as safety net. But set long (1–24hr).
  The DEL handles immediate invalidation.
  TTL handles: race condition fallback, missed DELs, and memory limits.

  Consistency: near-instant (gap = DB write to cache DEL execution time = ~1ms).
  Complexity: every write path must know which cache keys to invalidate.

  THE PROBLEM WITH ACTIVE INVALIDATION AT SCALE:
  Simple case: update product:99 → del("product:99"). Easy.

  Complex case: update a user's subscription tier.
  What cache keys are affected?
    user:{id}:profile
    user:{id}:features (feature flags change per tier)
    user:{id}:limits (API rate limits change per tier)
    user:{id}:billing_info
    user:{id}:dashboard_data
    checkout:{activeSessionId}:pricing (if user is mid-checkout)
    ... possibly more

  The application must know ALL of these and DEL them ALL atomically.
  If one DEL is missing: that view shows stale tier data.
  If a new cache key is added later by another developer:
    they MUST remember to update the invalidation code.
    If they forget: silent bug. Stale data. Hard to detect.

STRATEGY 3: EVENT-DRIVEN INVALIDATION
  Mechanism: DB publishes change events via CDC (e.g., Debezium), message queue, or triggers.
  Invalidation service: subscribes to events → determines affected keys → issues DELs.

  Advantage: invalidation logic centralized. Not scattered across write paths.
  Advantage: database-driven (no write path needs to "know" to invalidate).

  Complexity: need CDC pipeline (Debezium + Kafka), or event publishing logic.
  Latency: event propagation delay. 100ms–2s before invalidation fires.
  For eventual consistency: acceptable.
```

---

## SECTION 3 — Architecture Diagram (MANDATORY)

### Active Invalidation Architecture

```
ACTIVE INVALIDATION — CORRECT ORDERING

                    APPLICATION SERVER

        WRITE PATH (CORRECT ORDER):
        ┌────────────────────────────────────────────────────────┐
        │                                                          │
        │  1. BEGIN DB TRANSACTION                                 │
        │                         ┌──────────┐                    │
        │  2. UPDATE DB ─────────►│ Database │ ← Source of Truth │
        │                         │ COMMIT   │                    │
        │                         └──────────┘                    │
        │                                                          │
        │  3. redis.DEL key ─────►┌──────────┐                    │
        │     (AFTER DB commit)   │  Redis   │ key removed        │
        │                         └──────────┘                    │
        │                                                          │
        │  4. Return 200 to client                                 │
        └────────────────────────────────────────────────────────┘

        WHY THIS ORDER MATTERS:
        ↓
        See Section 4 for the race condition when DEL comes BEFORE DB update.

FANOUT INVALIDATION DIAGRAM:

        ONE WRITE EVENT → MULTIPLE CACHE KEYS TO INVALIDATE

        ┌─────────────────┐
        │ DB: UPDATE      │
        │ subscriptions   │
        │ SET tier='pro'  │
        │ WHERE user=123  │
        └────────┬────────┘
                 │ Write committed
                 ▼
        ┌────────────────────────────────────────────────────────┐
        │              INVALIDATION COORDINATOR                   │
        │                                                          │
        │  keys_to_invalidate = [                                  │
        │    "user:123:profile",                                   │
        │    "user:123:features",                                  │
        │    "user:123:limits",                                    │
        │    "user:123:billing",                                   │
        │    "user:123:dashboard",                                 │
        │    "checkout:sess_abc:pricing"                           │
        │  ]                                                       │
        │  redis.del(...keys_to_invalidate)   ← MULTI-DEL in ONE round-trip │
        └────────────────────────────────────────────────────────┘
                 │
                 ▼
        ┌──────────────┐
        │  Redis       │
        │  All 6 keys  │
        │  removed     │
        └──────────────┘

EVENT-DRIVEN INVALIDATION ARCHITECTURE:

        ┌────────────┐
        │  Database  │──── CDC (Debezium captures row change)
        └────────────┘
                 │
                 ▼
        ┌─────────────────────┐
        │  Kafka / EventBridge│  Topic: db.subscriptions.changes
        └──────────┬──────────┘
                   │
                   ▼
        ┌──────────────────────────────────────────────────────┐
        │  Cache Invalidation Service                           │
        │                                                        │
        │  event = { table: "subscriptions", userId: 123,       │
        │            changedFields: ["tier", "expires_at"] }    │
        │                                                        │
        │  keys = invalidationMap["subscriptions"](event)       │
        │  → Returns: ["user:123:profile", "user:123:limits", ...]│
        │                                                        │
        │  redis.del(...keys)                                    │
        └──────────────────────────────────────────────────────┘
```

---

## SECTION 4 — Request Flow (MANDATORY FLOWCHART)

### The Most Misunderstood Bug in Caching

```
THE CLASSIC RACE CONDITION — Step by step:

  Two concurrent requests. T1 = thread/request 1. T2 = thread/request 2.
  Starting state: Redis has NO entry for product:99 (either never cached or recently DELeted).

  WRONG IMPLEMENTATION (DEL before DB write):

  T1 (Read):    │ T2 (Write):
  ──────────────┼──────────────────────────────────
  t=0.0         │
  GET product:99│
  → MISS        │
                │ t=0.1
                │ redis.DEL product:99 ← too early (DEL before DB update)
                │ ( key didn't exist anyway — DEL is a no-op here )
                │
                │ t=0.2
                │ UPDATE products SET price=19 WHERE id=99
                │ DB commit.
                │ (Price is now $19 in DB)
  t=0.3         │
  DB SELECT:    │
  price=?       │
  → $19 ← Wait!│
    DB already  │
    has new price│
    (read after │
    commit)     │
  t=0.5         │
  redis.SETEX   │
  product:99    │
  { price: $19 }│
  ← Correct!    │

  ACTUALLY: this scenario produces the correct result.
  DEL before write doesn't cause a problem when T1 reads AFTER T2 writes.

  THE ACTUAL PROBLEM — more subtle race:

  T1 (Read):    │ T2 (Write):
  ──────────────┼──────────────────────────────────
  t=0.0         │
  GET product:99│
  → MISS        │
  t=0.1         │
  DB SELECT:    │ ← T1 reads from DB (BEFORE T2's write)
  price=$29     │
  (T2 hasn't    │
   written yet) │
                │ t=0.2
                │ UPDATE products SET price=$19 WHERE id=99
                │ DB commit.
                │
                │ t=0.3
                │ redis.DEL product:99
                │ (key doesn't exist yet — T1 hasn't SET it)
                │ DEL is a no-op.
  t=0.4         │
  redis.SETEX   │
  product:99    │
  { price: $29 }│← T1 writes OLD value ($29) AFTER T2 already DELeted!
                │  T2's DEL was useless.
                │  Cache now has: $29. DB has: $19.
                │  WIN FOR STALENESS. Will persist until TTL.

  THE ROOT CAUSE:
    The race window is: T1's DB read → T2's cache DEL → T1's cache SET.
    T2's DEL fires when there's nothing to delete.
    T1's SET fires AFTER the DEL with old data.

  FREQUENCY: This race requires specific timing. In low-traffic systems: rare.
             At 10,000 concurrent requests/sec: happens dozens of times per minute.

  PRACTICAL MITIGATIONS:

  MITIGATION 1: SHORT TTL (safety net, not prevention)
    Stale data expires within TTL regardless.
    For price: TTL=5min → max staleness = 5min.
    Not prevention, but limits damage.

  MITIGATION 2: "CACHE INVALIDATION THEN READ" PATTERN
    After a write: DEL the key.
    Then: issue a READ from DB → re-populate cache.
    This purposely populates cache with fresh data immediately after invalidation.
    Called "cache warming on write."
    Cost: one extra DB read per write. Usually worth it for hot keys.

  MITIGATION 3: REDIS WATCH + TRANSACTION (optimistic locking)
    Before doing DB read:
      redis.WATCH product:99              ← notify me if this key changes
    Do DB read.
    Build new value.
    redis.MULTI
    redis.SETEX product:99 TTL newValue
    result = redis.EXEC                  ← returns nil if someone modified key between WATCH and EXEC

    If EXEC returns nil: someone DELeted or SET the key between your DB read and SET.
    That means a write happened. Your old value is stale. Abort the SET.
    Retry: re-read from DB and try again.

  MITIGATION 4: VERSION/TIMESTAMP CHECK
    Cache stores: { data: {...}, updatedAt: "2025-01-10T14:30:00Z" }
    Before cache SET: check if your DB read's updated_at > cache's updatedAt.
    If not: cache is already newer than your read. Discard your SET.
```

---

_→ Continued in: [02-Cache Invalidation.md](02-Cache%20Invalidation.md)_
