# TTL Strategy — Part 1 of 3

### Topic: Foundations — Intuition, Core Concepts, Architecture & Data Flow

**Series:** Scalability & Performance → Topic 10

---

## SECTION 1 — Intuition (Explain Like a 12-Year-Old)

```
THE GROCERY STORE EXPIRY DATE PROBLEM:

  A grocery store manager sets expiry dates on all products.

  WRONG APPROACH — ONE TTL FOR EVERYTHING:
  Manager's policy: "Everything expires in 7 days. Simple."

  Fresh milk: 7-day label → Actually spoils in 3 days.
  Customers: buy "fresh" milk on day 5. Milk is 2 days gone.

  Honey: 7-day label → Honey lasts 3000 years biologically.
  Store discards 300 jars of perfect honey weekly. Wasteful.

  Bread: 7-day label → Stale in 3 days. 7-day label = misleading.

  The manager optimized for SIMPLICITY (one rule) at the cost of CORRECTNESS.

  CORRECT APPROACH — PER-PRODUCT EXPIRY:
  Dairy: 3–5 days.
  Bread: 2–3 days.
  Frozen goods: 6–12 months.
  Canned goods: 2–5 years.
  Honey: no expiry needed.

  EACH PRODUCT: expiry date = how long it ACTUALLY stays good.
  Not a fixed duration applied uniformly to everything.

  IN SOFTWARE (cache TTL):
  User session token → expires when session auth window closes.
  Product price → expires in 5 minutes (changes with promotions).
  Product description → expires in 24 hours (stable content).
  API response from third party → expires in 10 minutes (external rate limits).
  Static country list → expires in 7 days (changes almost never).

  THE ANTI-PATTERN: Setting cache TTL to 3600 (1 hour) for everything.

  Effect on price (flash sale):
    Price changes every 5 minutes during a sale.
    Cache TTL 1 hour → users see wrong prices for up to 1 hour.

  Effect on static country list:
    Data changes at most once per year.
    Cache TTL 1 hour → re-fetched from DB every hour needlessly.
    1 hour vs 7 days: 168× more DB queries per week. For nothing.

  THE CORRECT MENTAL MODEL:
  TTL = how stale can this data be without causing business harm?
  Not: what's a reasonable time interval for caching?
```

---

## SECTION 2 — Core Technical Explanation

### TTL Is a Business Constraint, Not a Technical Knob

```
WHY TTL MATTERS:

Problem 1: TTL TOO LONG — BUSINESS HARM FROM STALE DATA

  Healthcare billing system. Insurance eligibility cached.
  TTL 24 hours. Patient's insurance cancelled at 9 AM.

  At 2 PM: doctor checks eligibility from cache.
  Cache says: "Eligible." Cache is 5 hours stale.
  Service rendered.

  At billing: insurance company rejects. "Coverage ended 9 AM."
  Hospital absorbs the cost. The 24-hour TTL caused a billing loss.

  Correct TTL for insurance eligibility: 5 minutes.
  Or better: active invalidation on change + 5-minute safety net TTL.

Problem 2: TTL TOO SHORT — PERFORMANCE HARM FROM OVER-FETCHING

  Static configuration data. Supported currencies list.
  Changes: once per year.
  TTL: 30 seconds (team was being "safe").

  Traffic: 5,000 requests/second.
  Each request: 1 Redis GET (hit 99.9% of the time), 1 Redis SETEX (every 30s on miss).
  Actually: 30s TTL → 1 miss every 30s per key. 1/30 = 0.033 misses/second.

  OK — this one doesn't matter much. But multiply by 100 different config keys
  all with 30s TTLs: 100 × 0.033 = 3.3 DB queries/second for config that NEVER CHANGES.

  With 7-day TTL: 100/(7×86400) = 0.000165 DB queries/second for same config.
  A 20,000× reduction. For data that's functionally immutable.

Problem 3: ALL KEYS SAME TTL — CACHE STAMPEDE

  10,000 product pages all cached at application startup.
  All given TTL = 3600 (1 hour). All expire at the exact same time.

  At t=3600: 10,000 simultaneous cache misses.
  10,000 concurrent DB queries.
  Even at 100ms each: DB handles 100 concurrent queries max.
  Queue depth: 10,000 items. Response time: seconds.
  Service appears down.

  Same pattern: scheduled jobs that batch-cache entities → synchronized TTL expiry.
  Fix: jitter. Not a trivial detail. A requirement at scale.

THE CORRECT PROCESS FOR SETTING TTL:

  For each cached entity, answer:

  1. What is the maximum acceptable staleness?
     (Ask the product owner, not another engineer)
     "If a user sees this data 5 minutes after it changed, is that a problem?"
     "What about 30 minutes? 1 hour? 24 hours?"

  2. Do we have active invalidation in place?
     YES: TTL is a safety net. Set it at 10× the maximum acceptable staleness.
          Active invalidation handles the common case. TTL handles edge cases.
     NO: TTL IS the mechanism. Set it ≤ maximum acceptable staleness.

  3. How often does this data actually change in production?
     If TTL > actual change interval: you're serving stale data regularly.
     If TTL << actual change interval: you're over-fetching from DB.
     Ideal: TTL ≈ acceptable staleness, with active invalidation if needed.

  4. Is this data personalized per user?
     Personalized: N users × M entities → high key cardinality.
     Short TTLs + high cardinality: high miss rate (keys expire before re-accessed).
     Evaluate: is the cache benefit worth the complexity for this entity?
```

---

## SECTION 3 — Architecture Diagram (MANDATORY)

### TTL Decision Tree and Key Design

```
TTL SELECTION DECISION TREE:

                           ┌─────────────────────┐
                           │ How often does the    │
                           │ data change?          │
                           └──────────┬────────────┘
                                      │
           ┌──────────────────────────┼────────────────────────────┐
           ▼                          ▼                             ▼
    Rarely / never             Periodically               Frequently
    (config, country          (product desc,              (price, stock,
     lists, enum values)       blog posts)                 session state)
           │                          │                             │
           ▼                          ▼                             ▼
    TTL = 7 days +            TTL = 4–24 hours           TTL = 30s–15 min
    active inval on           + active inval             MUST have active
    change event              on edit                    invalidation
    (change is so rare:       (change is expected:       (cannot rely on TTL
     TTL almost irrelevant)    TTL as safety net)         alone for freshness)
           │                          │                             │
           └──────────────────────────┼─────────────────────────────┘
                                      │
                                      ▼
                           ┌─────────────────────┐
                           │ Is this personalized  │
                           │ per user?             │
                           └──────────┬────────────┘
                                      │
                 ┌────────────────────┼──────────────────────┐
                 ▼                    ▼                       ▼
            Not personalized    Lightly personalized    Highly personalized
            (product catalog,   (search with user's     (custom dashboards,
             public content)     preferred category)     AI recommendations)
                 │                   │                       │
                 ▼                   ▼                       ▼
            Normal TTL          Normal TTL +             Shorter TTL OR
            strategy            user-segment key         don't cache at all
                                 (not per-user-ID)       (cache benefit low
                                                          from high cardinality)

TTL REFERENCE TABLE (what cache key serves what TTL):

  ENTITY/KEY TYPE                  TTL        NOTES
  ─────────────────────────────────────────────────────────────────────────
  user:{id}:profile                24h        Active inval on profile update
  user:{id}:permissions            15min      Security-critical; short TTL required
  user:{id}:session                = session  Match session auth window
  product:{id}:detail              1h         Active inval on edit
  product:{id}:price               5min       Short TTL; active inval on change
  product:{id}:inventory           60s        Near-real-time
  product:{id}:reviews_summary     4h         Changes rarely after initial burst
  category:{id}:products           2h         Active inval when category updated
  search:{query}:{page}            30min      Bounded freshness for results
  config:feature_flags             5min       Short; must reflect flag changes
  config:country_list              7days      Near-immutable
  cdn:asset:{hash}                 forever    Content-addressable (hash in key = immutable)
  auth:token:{jti}:blacklist       = token TTL Revoked tokens stay in blacklist
  rate_limit:{userId}:{window}     = window   Expires with the rate window
  negative:product:{id} (null)     60s        Prevents DB hammering for missing IDs
```

---

## SECTION 4 — Request Flow (MANDATORY FLOWCHART)

### Four Essential Patterns Every Architect Needs

```
PATTERN 1: JITTER (Required for Any System That Batch-Caches)

  WHY NEEDED:
    Batch cache population (startup, scheduled refresh) → synchronized TTL expiry.
    Synchronized expiry → simultaneous miss storm → DB overload.

  IMPLEMENTATION:
    Base TTL: 3600 (desired).
    Jitter: random(0, 600) (10% of base TTL is a good starting range).

    const ttl = 3600 + Math.floor(Math.random() * 600);
    await redis.setex(key, ttl, value);

  EFFECT:
    1,000 keys with TTL 3600–4200: expire over a 10-minute window.
    Instead of 1,000 simultaneous misses: ~1.67 misses/second.
    DB receives a smooth trickle instead of a flood.

  JITTER SIZING GUIDELINE:
    TTL jitter window ≈ time_for_cache_to_fully_warm_up_after_empty
    If cache of 10,000 items warms at 100 misses/second = 100 seconds.
    Jitter window: 100 seconds. Items expire spread over 100s → warm-up rate matches expiry rate.

PATTERN 2: SLIDING EXPIRY (Keep Hot Items Alive)

  PROBLEM WITH FIXED TTL:
    User accesses their dashboard every 2 minutes.
    Dashboard cached with TTL 10 min.
    At t=10: TTL expires. Miss. DB query. Re-cache for 10 more minutes.
    At t=20: same. At t=30: same.
    User accesses dashboard 10 times/hour. 6 of those = cache hit. 4 = miss.
    60% hit rate. Below target.

  SLIDING EXPIRY:
    On every cache HIT: EXPIRE key 600  ← reset TTL to 600s.
    Key stays alive as long as it's being accessed.
    User accessing every 2 min: key stays alive forever (accessed every 2 min, reset every access).
    Cache miss: ONLY for the very first access after a period of inactivity.

  IMPLEMENTATION:
    On read (cache hit):
      const data = await redis.get(key);
      if (data) {
        await redis.expire(key, 600);  // sliding TTL reset
        return JSON.parse(data);
      }

    REDIS 6+ SHORTCUT:
    GETEX key EX 600   ← GET and set new expiry atomically (single command = single RTT).
    Eliminates the separate EXPIRE call.

  WHEN NOT TO USE SLIDING EXPIRY:
    High-cardinality keys (millions of users, each unique key).
    EXPIRE on every read = overhead for every hit.
    At 1M reads/second: 1M EXPIRE commands. Consider the overhead.
    For moderate cardinality (< 100K hot keys): sliding expiry is fine.
    For very high cardinality: use fixed TTL, accept occasional misses.

PATTERN 3: PROBABILISTIC (XFetch / Early Recomputation)

  THE THUNDERING HERD (CACHE STAMPEDE) PROBLEM:
    Popular item. Many concurrent reads.
    TTL expires. First concurrent request: misses → triggers DB query.
    While DB query runs (200ms): 500 more requests arrive.
    All 500: hit the same expired key. All miss. All trigger DB query.
    501 simultaneous DB queries for the same row.

  NAIVE FIX — MUTEX/LOCK:
    First miss: acquire Redis lock ("recomputing:product:99") → DB query → SET → release lock.
    Subsequent misses: see lock → wait → repeat check → eventually get value.
    Downside: waiters are blocked. Latency spikes under high concurrency.

  BETTER FIX — PROBABILISTIC EARLY RECOMPUTATION (XFetch):
    Insight: instead of waiting for TTL to expire, PROACTIVELY recompute
    with increasing probability as TTL approaches expiry.

    Formula: if (current_time - ttl_remaining) > β × δ × log(uniform_random())
    Where:
      β = statistical parameter (≈ 1)
      δ = time needed to recompute the cached value (DB query time in seconds)

    Simplified practical version:

    const [value, ttlRemaining] = await Promise.all([redis.get(key), redis.ttl(key)]);
    const earlyRecompute = ttlRemaining < 30 &&       // within 30s of expiry
                           Math.random() < (30 - ttlRemaining) / 30;  // probability rises as expiry approaches

    if (!value || earlyRecompute) {
      const fresh = await db.getProduct(id);
      await redis.setex(key, 3600 + jitter(), JSON.stringify(fresh));
      return fresh;
    }
    return JSON.parse(value);

  EFFECT: cache is transparently refreshed by random requests before expiry.
  When TTL finally reaches zero: cache already has fresh data.
  Zero miss storm. Zero user-perceived latency spike.

  USE WHEN: key is extremely hot AND TTL expiry causes measurable stampede.
  Don't apply universally — adds DB read overhead BEFORE expiry.

PATTERN 4: VERSIONED KEYS (Zero-Downtime TTL strategy for schema migration)

  SCENARIO: Schema change requires new cache key format.
    Old: product:v1:99 → { id, name, price } (flat JSON)
    New: product:v2:99 → { id, name, pricing: { base, discount, currency }}

  MIGRATION WITHOUT VERSIONING:
    Deploy new code → reads new format → old cache has old format → parse error.
    OR: flush all caches before deploy → 100% miss rate → DB overwhelmed.

  MIGRATION WITH VERSIONING:
    New code reads: product:v2:99.
    Old code reads: product:v1:99.
    Both deployed simultaneously (rolling deploy):
      Old instances: read v1 keys. New instances: read v2 keys.

    v1 keys: expire naturally via TTL (no flush needed, no stampede).
    v2 keys: populate on first miss (gradual warm-up).

    Zero downtime. Zero miss storm. Zero cache flush coordination.

  TTL selection for versioned key migration:
    Old version TTL: ideally shorter during migration window.
    Set all v1 keys to TTL = max_rolling_deploy_duration + buffer (e.g., 30 min).
    v1 keys become dead within 30 minutes after rolling deploy completes.
```

---

_→ Continued in: [02-TTL Strategy.md](02-TTL%20Strategy.md)_
