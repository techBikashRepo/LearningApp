# TTL Strategy — Part 3 of 3

### Topic: AWS Certification Focus, Comparison Tables, Quick Revision & Architect Exercise

**Series:** Scalability & Performance → Topic 10

---

## SECTION 9 — Certification Focus (AWS SAA)

```
COMPREHENSIVE TTL STRATEGY BY DATA CATEGORY:

┌──────────────────────────────┬──────────────┬──────────────────┬──────────────────────────────────┐
│ Data Category                │ TTL          │ Invalidation     │ Rationale                        │
├──────────────────────────────┼──────────────┼──────────────────┼──────────────────────────────────┤
│ IDENTITY & AUTH                                                                                    │
│ user:profile                 │ 24h + jitter │ Active DEL       │ Long TTL safe with active inval  │
│ user:email/phone             │ 1h           │ Active DEL       │ Used for notifications — shorter  │
│ user:permissions             │ 15min        │ Active DEL       │ Security-critical; short required │
│ session:token:{jti}          │ = session TTL│ On logout DEL    │ Match auth system's session life  │
│ blocked:token:{jti}          │ = token TTL  │ Never (keep it)  │ Revoked tokens; must stay until   │
│                              │              │                  │ original expiry passes            │
│ auth:failed:{ip}             │ 15min        │ TTL only         │ Brute force window                │
├──────────────────────────────┼──────────────┼──────────────────┼──────────────────────────────────┤
│ PRODUCT & CATALOG                                                                                  │
│ product:{id}:detail          │ 1h + jitter  │ Active DEL       │ Changes occasionally              │
│ product:{id}:price           │ 5min         │ Active DEL       │ Flash sale changes are rapid      │
│ product:{id}:inventory       │ 30–60s       │ Active DEL       │ Real-time stock requires short    │
│ product:{id}:reviews_summary │ 4h + jitter  │ Active on review │ Reviews slow-changing post-launch │
│ category:{id}:listing        │ 2h + jitter  │ Active on edit   │ Category layouts stable           │
│ search:{query}:{page}        │ 30min        │ Dep. registry    │ Results change as catalog changes │
├──────────────────────────────┼──────────────┼──────────────────┼──────────────────────────────────┤
│ CONFIG & FEATURE FLAGS                                                                             │
│ config:feature_flags         │ 5min         │ Pub/sub L1 inval │ Flags must propagate in minutes   │
│ config:rate_limits           │ 5min         │ Pub/sub inval    │ Rate limit changes need propagation│
│ config:country_list          │ 7d           │ Manual flush     │ Near-immutable reference data     │
│ config:supported_currencies  │ 7d           │ Manual flush     │ Changes rarely (regulatory)       │
│ config:payment_providers     │ 1h           │ Active DEL       │ Provider status can change        │
├──────────────────────────────┼──────────────┼──────────────────┼──────────────────────────────────┤
│ COMPUTED / AGGREGATED DATA                                                                         │
│ user:{id}:recommendations    │ 10min        │ Active on prefs  │ ML recompute cycle = 10min        │
│ project:{id}:stats           │ 60s          │ Write-back INCR  │ Updated in Redis directly         │
│ leaderboard:global:top100    │ 30s          │ Active refresh   │ Near-real-time                    │
│ analytics:{date}:pageviews   │ Write-back   │ None (buffer)    │ No TTL — flush job clears         │
├──────────────────────────────┼──────────────┼──────────────────┼──────────────────────────────────┤
│ NEGATIVES (null results)                                                                           │
│ product:{id}:null            │ 60s          │ DEL on create    │ Prevents repeated DB miss hammering│
│ user:{id}:profile:null       │ 30s          │ DEL on create    │ For signup flows                  │
└──────────────────────────────┴──────────────┴──────────────────┴──────────────────────────────────┘

IMPLEMENTING THE MATRIX IN CODE:

const TTL_CONFIG = {
  'user:profile':         { base: 86400, jitter: 3600, invalidationType: 'active' },
  'user:permissions':     { base: 900,   jitter: 60,   invalidationType: 'active' },
  'product:detail':       { base: 3600,  jitter: 600,  invalidationType: 'active' },
  'product:price':        { base: 300,   jitter: 30,   invalidationType: 'active' },
  'product:inventory':    { base: 60,    jitter: 10,   invalidationType: 'active' },
  'config:feature_flags': { base: 300,   jitter: 30,   invalidationType: 'pubsub' },
  'config:country_list':  { base: 604800,jitter: 0,    invalidationType: 'manual' },
  'negative:product':     { base: 60,    jitter: 0,    invalidationType: 'active_on_create' },
};

function getTTL(entityType) {
  const config = TTL_CONFIG[entityType];
  if (!config) throw new Error(`No TTL config for entity: ${entityType}`);
  return config.base + Math.floor(Math.random() * config.jitter);
}

// Usage:
await redis.setex(`product:${id}:detail`, getTTL('product:detail'), JSON.stringify(data));
```

---

## SECTION 10 — Comparison Table

### ElastiCache TTL Monitoring and Optimization

```
CLOUDWATCH METRICS FOR TTL HEALTH:

  CacheMisses: absolute count.
  CacheHits: absolute count.
  CacheHitRate: CacheHits / (CacheHits + CacheMisses).

  ALERT STRATEGY:

  1. HIT RATE DROP:
     Alarm: CacheHitRate < 0.80 for 5 minutes.
     Cause: TTL too short → high miss rate.
     OR:    Eviction happening → memory pressure → LRU evicting useful keys.
     Action: check Evictions metric simultaneously.

  2. EVICTIONS ALERT:
     Alarm: Evictions > 100 per minute.
     Cause: maxmemory reached → eviction policy firing.
     TTL impact: if TTLs are too long → memory fills with old data → evictions of useful data.
     Action: shorten TTL for less-critical data. OR increase node size.

  3. MISS COUNT SPIKE:
     Alarm: CacheMisses increases 5× over baseline.
     Cause: possible stampede (TTL expiry at scale).
     Action: investigate jitter configuration. Add XFetch or mutex pattern.

CLOUDWATCH DASHBOARD: TTL HEALTH PANEL
  - CacheHitRate (should be > 0.85)
  - Evictions (should be ≈ 0 for well-sized clusters)
  - CurrItems (track growth — unbounded growth = no TTL on some keys)
  - BytesUsedForCache vs MaximumUsedMemory (headroom monitoring)

EXPIRING LARGE KEY SETS ON AWS:

  Scenario: need to expire all "search:v1:*" keys after a schema migration.
  Cannot flush all keys (cluster is shared with other data).

  Option A: SCAN + DEL via Lambda.
    Lambda function: SCAN 0 MATCH "search:v1:*" COUNT 1000
    Iterates through all matching keys in batches.
    DEL each batch.
    Could take minutes for millions of keys.
    Impact: SCAN + DEL CPU load on Redis during operation.

  Option B: Version bump (preferred, zero Redis load).
    All new reads use "search:v2:*" keys.
    "search:v1:*" keys: self-expire via their TTLs (30min–2h).
    Zero Redis operation needed. Zero cluster impact.

  Option C: Short TTL + deployment.
    Before deploying new schema: reduce TTL of all v1 search keys to 5 minutes.
    After 5 minutes: all v1 keys expired.
    Deploy new code that uses v2 keys.

    Implementation: periodic TTL reduction job:
    SCAN 0 MATCH "search:v1:*" COUNT 100 → EXPIRE each key 300 (5 min max).
```

---

## SECTION 11 — Quick Revision

**Scenario:** A financial services dashboard displays: account balance (from core banking, updated in real-time), transaction history (paginated, last 30 days), and exchange rates (for foreign currency accounts, from FX provider). Design the TTL strategy. Requirements: balance must never be more than 30 seconds stale. Transaction history: 5 minutes staleness OK. Exchange rates: 10 minutes staleness OK (FX provider updates every 10 minutes). All three are read on every dashboard load. Traffic: 50,000 DAU, peak 5,000 concurrent.

---

**Answer:**

```
ENTITY ANALYSIS:

1. ACCOUNT BALANCE
   Staleness requirement: 30 seconds MAX.
   Change frequency: every transaction (could be multiple per second for active accounts).
   Risk of stale data: user sees wrong balance. Financial harm possible.

   TTL: 30 seconds (the requirement, not a performance choice).
   Active invalidation: YES — every transaction committed → redis.del(balance:{accountId}).

   Stampede concern:
     5,000 concurrent users. Each account has 1 balance key.
     At any given second: very few accounts expire simultaneously (staggered activity).
     Stampede unlikely. But: on startup/Redis restart → cold start.
     Cold start: 50,000 accounts → 50,000 simultaneous missed.
     DB: 50K balance queries simultaneously = severe overload.

   COLD START PROTECTION:
     On Redis restart: limit concurrent balance DB queries.
     Implement: mutex-per-account (lock:balance:{accountId}).
     First miss: acquires lock → DB query → SET cache → release.
     Concurrent misses for DIFFERENT accounts: parallel (no shared lock).
     Concurrent misses for SAME account: wait on lock.

     Realistic: 50,000 concurrent DIFFERENT accounts = 50,000 parallel DB queries.
     Need: DB connection pool = 50,000? No — this is unrealistic.
     Redis restart scenarios: handled by circuit breaker (serve stale from L1
     during Redis recovery). L1 in-process cache: TTL = 15 seconds.
     Stale during recovery: up to 15 seconds. Within 30-second requirement.

2. TRANSACTION HISTORY (paginated list)
   Staleness requirement: 5 minutes.
   Change frequency: per transaction (new transactions appear).
   Key: txns:{accountId}:{page}

   TTL: 5 minutes + jitter(0–30s).
   Active invalidation: YES — on new transaction → del(txns:{accountId}:*) (all pages).

   PAGINATION INVALIDATION:
     Account has 10 pages of transaction history.
     New transaction added → page 1 changes. Pages 2–10 unchanged.
     But: page numbers shift (newest-first pagination).
     Safer: invalidate all pages for the account on any new transaction.
     Pages invalidated: those actually fetched are re-populated.
     Pages not fetched: not re-populated (on-demand only).

   TTL: 5 minutes ensures even if active invalidation has a race,
         history is at most 5 minutes stale.

3. EXCHANGE RATES
   Staleness requirement: 10 minutes.
   Change frequency: FX provider updates every 10 minutes.

   KEY: fx:rate:{fromCurrency}:{toCurrency}
   Example: fx:rate:USD:EUR

   TTL: 10 minutes + jitter(0–60s).
   Fetch source: HTTP call to FX provider API.
   Active invalidation: NOT practical (provider doesn't push changes; we poll).

   Strategy: SHORT TTL (10 min) IS the mechanism. No active invalidation needed.
             TTL = polling interval = acceptable staleness. All three match.

   STAMPEDE RISK:
     All N currency pairs expire at similar times (all cached on first load).
     FX rate for USD:EUR requested by thousands of users simultaneously.
     On expiry: stampede → many simultaneous FX API calls.

     FX API may be rate-limited! One stampede = rate limit exceeded = all fail.

   FIX: FX rates fetched by a BACKGROUND JOB, not on-demand.
     Background job: runs every 9 minutes (before 10-min TTL expires).
     Calls FX API for all supported currency pairs.
     Updates Redis: SETEX fx:rate:USD:EUR 600 "{rate: 0.92}"
     Dashboard: reads from Redis. Always a cache hit (background job keeps it warm).
     If background job fails: TTL = 10min → within staleness requirement.

     This is the "refresh-ahead" pattern.
     Background refresh decouples user request latency from FX API latency.
     Users never wait for FX API. Always served from Redis (<1ms).

COMBINED TTL SUMMARY:
  balance:{id}       TTL=30s + Active DEL on transaction
  txns:{id}:{page}   TTL=5min + Active DEL on new transaction
  fx:rate:{X}:{Y}    TTL=10min + Background refresh every 9min

  Redis instance sizing:
    50K accounts × balance (50B each) = 2.5MB (trivial).
    50K accounts × 5 pages average × 2KB each = 500MB for transaction pages.
    200 currency pairs × 100B = 20KB for FX rates.
    Total: ~500MB. ElastiCache cache.r7g.large (6.4GB) is more than sufficient.
```

---

## SECTION 12 — Architect Thinking Exercise

**Q: "How do you choose TTL values for different types of cached data?"**

> "I start with a business question, not a technical one: 'If this cached data is stale, what is the worst business outcome?' The answer determines the TTL ceiling. If stale insurance eligibility causes a billing error, TTL must be minutes, not hours. If a stale country list is served, the impact is minimal — TTL can be days.
>
> Then I consider whether active invalidation is in place. If yes, TTL is a safety net — I can set it long (hours or days) because invalidation handles freshness. If no active invalidation: TTL IS the freshness mechanism, so it must equal the maximum acceptable staleness.
>
> Finally, I add jitter — a random offset to the TTL to prevent synchronized expiry storms when multiple keys are cached in batch. The formula: TTL = base_seconds + random(0, 10% of base)."

---

**Q: "What is a cache stampede and how do you prevent it?"**

> "A cache stampede happens when a cache key expires — or is cold — and many concurrent requests simultaneously discover the miss and all trigger the same expensive DB query. With 500 concurrent users hitting an expired hot key, you get 500 parallel DB queries for the same row.
>
> Three prevention strategies: First, mutex locking — the first request that misses acquires a Redis lock, others wait or serve stale data. Simplest, introduces lock contention. Second, serve-stale under lock — expired key is served stale to all waiters while the lock holder recomputes. Zero added latency, minimal staleness window. Third, XFetch or probabilistic early recomputation — with some probability, requests proactively refresh the cache before TTL expires, spreading the refresh work over time instead of concentrating it at TTL boundary. For hot keys at scale, I prefer serve-stale-under-lock combined with TTL jitter — it eliminates the stampede without adding user-visible latency."

---

## === Architect's Mental Model ===

### 5 Decision Rules

**Rule 1: TTL is a business staleness contract, not a performance tuning parameter.**
Every TTL decision starts with: "Who is harmed by stale data, and for how long?" Not: "What's a reasonable cache duration?" The product team answers the first question. The engineering team translates that into a seconds value. Once the business answers "10 minutes is acceptable", the TTL is set. If it's not acceptable, the team must add active invalidation.

**Rule 2: Add jitter to all batch-populated TTL values.**
Any time you cache multiple keys in a loop (startup warm-up, scheduled batch, API response caching bulk queries), add random TTL jitter. Without jitter: keys expire in sync → stampede. The jitter magnitude should be roughly proportional to the time it takes to re-warm all the keys at your expected miss rate. This isn't optional — it's as mandatory as error handling.

**Rule 3: Write-back buffer keys have no TTL. Display cache keys have TTL. Never conflate them.**
These are different keys with different semantics. Write-back buffers hold data that hasn't been written to the DB yet — expiring them means data loss. Display caches hold data that IS in the DB — expiring them means a DB read on miss. Treating both as "Redis cache keys with TTL" is the source of a class of data loss bugs that are hard to reproduce and catastrophic when they happen.

**Rule 4: Use background refresh (refresh-ahead) for external API-sourced data.**
When your cache entries are populated from external services (FX rates, payment provider status, weather data), never let TTL expiry trigger an external API call on the user request path. External APIs: slow, rate-limited, unpredictable. Background job: runs before TTL expires, calls external API, updates Redis. Users: always served from Redis (fast, no rate limit impact). TTL becomes a fallback for background job failure, not the standard operating mechanism.

**Rule 5: CurrItems growth over time = missing TTLs somewhere.**
In a healthy cache system, CurrItems is bounded. Keys expire, new ones are created, the steady-state size is approximately constant. If CurrItems grows monotonically over weeks: keys without TTLs are accumulating. These become ghost entries (stale user profiles, old search results, deleted entities) that waste RAM and eventually trigger eviction. Monthly audit: check for key patterns with no TTL (`SCAN ... OBJECT ENCODING ... TTL`). Every cache key type should have a documented TTL policy.

---

### 3 Common Mistakes

**Mistake 1: Setting the same TTL for all data regardless of change rate.**
One team sets TTL = 3600 for everything: product prices (change every 5 minutes during sales → wrong for 55 minutes), country lists (change once a year → re-fetched 8,760 times/year for nothing), user permissions (change on admin action → first action should be effective instantly, not 1 hour later with cache-aside). TTL must be per-entity-type, derived from actual change rate and acceptable staleness. A global TTL constant is a code smell — not a policy.

**Mistake 2: Not accounting for TTL expiry under traffic spikes.**
Team sizes Redis correctly for average load. TTLs set correctly. At 10× traffic spike (product launch, Black Friday): keys that normally expire and re-warm smoothly under low traffic now expire into a wall of concurrent requests. What was 10 misses per second becomes 100 misses per second. DB query rate spikes 10×. Team adds servers but forgets: more app servers = more concurrent DB queries per cache miss. The solution is XFetch or mutex — not more servers.

**Mistake 3: Using KEYS "pattern:\*" to audit or flush TTLs in production Redis.**
`KEYS "product:*"` scans the entire keyspace. On a 10 million key Redis instance: blocks the main thread for hundreds of milliseconds. During this time: ALL Redis operations queue. Application P99 latency spikes. `KEYS` is a debugging tool for development only. In production: use `SCAN` with cursors (non-blocking, batched iteration). When you need to set TTL on existing no-TTL keys: `SCAN 0 MATCH "product:v1:*" COUNT 100` → process batch → continue cursor. Never KEYS in production.

---

### 30-Second Interview Answer

> "TTL is a business contract, not a technical preference. The right question is: what's the worst outcome if this cache entry is stale, and for how long? That answer gives you the TTL ceiling. Then check if you have active invalidation — if yes, set a longer TTL as a safety net. If no, TTL IS your freshness mechanism and must be set tight. Two rules apply universally: add jitter to batch-populated keys (random offset prevents synchronized expiry storms), and never put TTL on write-back buffers (TTL expiry on unflushed writes means data loss). The hardest TTL mistakes are silent — either users see stale data without knowing it (TTL too long), or DB load is higher than necessary (TTL too short) without any obvious symptom."

---

_End of Topic 10 — TTL Strategy_
