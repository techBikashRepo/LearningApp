# Throughput vs Latency (Architect View) — Part 2 of 3

### Topic: Real World Examples, System Design Importance, AWS Mapping & Interview Prep

**Series:** Scalability & Performance → Topic 05

---

## SECTION 5 — Real World Example

### Dissecting Where Time Is Spent

```
REQUEST: POST /api/v1/reports/generate

Total observed: 4.2 seconds (P50)

BREAKDOWN via X-Ray trace:

  │◄──────────────────────── 4,200ms ──────────────────────────►│
  │                                                              │
  │◄─1ms►│◄───────────────── 4,195ms ────────────────────────►│◄─4ms►│
  │ ALB  │                  Backend                            │ ALB  │
  │rout. │                                                      │ resp │

  ALB routing:         1ms    ← NOP: load balancing overhead
  Backend total:    4,195ms   ← THE PROBLEM IS IN HERE

  BACKEND BREAKDOWN (X-Ray segments):

  ┌─ Lambda: handler start          2ms
  ├─ Redis: check cache hit         0.5ms  → MISS (first load)
  ├─ DB: fetch user config          8ms
  ├─ DB: fetch report parameters   12ms
  ├─ External API: exchange rates  3,200ms ← 76% of total time!
  ├─ DB: load report data         180ms
  ├─ Compute: format report        620ms
  ├─ S3: write output file         140ms
  └─ DB: save report record        32ms
  ─────────────────────────────────────
  Total:                         4,194ms

  DIAGNOSIS:
  External API (exchange rates): 3,200ms = 76% of request time.
  This is a LATENCY problem driven by one synchronous dependency.

  WRONG FIX: Add 3 more servers.
    Each server still waits 3.2s for the exchange rate API.
    You triple your throughput capacity. Latency unchanged.

  RIGHT FIX (multiple options):
    1. Cache exchange rates: rates change slowly (every 10 min is fine for reports).
       Redis TTL = 300s. First request: 4.2s. Every subsequent request: ~1s.
    2. Pre-fetch: background job updates exchange rate cache every minute.
       Report request: always hits cache. Latency: ~1s.
    3. Async: make report generation asynchronous.
       Request returns: HTTP 202 { jobId: "job_abc123" }
       Client polls for completion or receives webhook.
       User UX: "Your report is being generated" → ready in seconds, no timeout risk.
```

---

### Throughput-Constrained vs Latency-Constrained: Side-by-Side

```
THROUGHPUT-CONSTRAINED REQUEST FLOW:

  Time →   0ms                        1000ms
           │                                    │
  Request: ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░◄wait►███████████
                                         │      │
                        Waiting in queue │      │ Actual
                        (no worker free) │      │ processing
                                                  (just 35ms)

  The request spends 965ms WAITING and 35ms PROCESSING.
  The server is not slow. The system is overloaded.

  Observable signals:
    ALB TargetResponseTime high AND CPU high AND Queue depth building.

  Fix: More capacity. Add servers or scale up existing servers.

─────────────────────────────────────────────────────────────────────────

LATENCY-CONSTRAINED REQUEST FLOW:

  Time →   0ms                   4200ms
           │                          │
  Request: ████████████████████████████
           │    (all of this is       │
           │     processing time,     │
           │     no waiting at all)   │

  The request starts processing immediately (no queue, worker available).
  But takes 4.2 seconds to complete.

  Observable signals:
    ALB TargetResponseTime high BUT CPU is low AND Queue depth = 0.

  Fix: Find the slow operation. Code profiling. Query analysis. Cache.
```

---

## SECTION 6 — System Design Importance

### Optimizing Throughput When Latency Is the Problem

```
SCENARIO: Auth service P99 latency = 800ms. Traffic: 200 req/sec. CPU: 15%.

Team decides: "We need more servers. Auto-scale from 2 to 6 instances."
Cost: +$400/month. Time: 1 sprint.

RESULT:
  Traffic: 200 req/sec (unchanged — traffic hasn't grown).
  Servers: 6 instances.
  CPU per instance: 5% (even more idle now).
  P99 latency: 820ms (unchanged — possibly slightly worse due to overhead).

  Money: +$400/month wasted.
  Engineers: sprint spent on infrastructure instead of the real problem.
  Users: still experiencing slow logins.

WHAT THE INVESTIGATION SHOULD HAVE FOUND:
  X-Ray trace on auth/login:
    - Parse request:            1ms
    - Hash password (bcrypt):   780ms ← THERE IT IS
    - DB lookup:                 18ms
    - Generate JWT:               1ms

  bcrypt with cost factor 14: takes 780ms on current instance type.
  This is per request. Adding more servers: each request still hashes for 780ms.

  ACTUAL FIX OPTIONS:
    1. Reduce bcrypt cost factor from 14 to 12 (halves time, still secure in 2025)
       P99: 780ms → ~200ms. Done.
    2. Cache bcrypt result against rate-limited login attempts
       (controversial for security — don't do this blindly).
    3. Upgrade to Argon2id with tuned parameters.
    4. Dedicated auth service on compute-optimized instances (c7g vs general purpose m7g)
       — bcrypt is CPU-bound, gets 40% speedup on c-family.

  The throughput capacity increase was orthogonal to the actual problem.
  Investigation, not scaling, was the correct first step.
```

---

### Optimizing Latency When Throughput Is the Problem

```
SCENARIO: Payment API P99 = 220ms. Traffic: 800 req/sec (up from 400 last month).
          CPU: 88%. Queue depth: building.

Team decides: "Let's optimize code. The payment query takes 50ms — we can db-optimize it."
Engineering effort: 2 weeks SQL tuning. Result: 50ms → 25ms.

Team analysis: payment query 2× faster!

RESULT:
  P99 latency: 220ms → 195ms. Slight improvement.
  CPU: 88% → 85%. Slight improvement.
  But: queue depth still building. System still buckling at 800 req/sec.

  WHY:
  Little's Law: Throughput = Concurrency / Latency
  Before: 800 req/sec = 40 concurrent connections / 0.050s (50ms query)
  After:  800 req/sec → still 40 concurrent connections / 0.025s = 1600 capacity

  Wait — throughput capacity DID double... but the bottleneck calculation was wrong.
  The query was only 50ms of a 220ms request.

  FULL TIMING BEFORE:
    - Input validation:     5ms
    - Auth check:          60ms
    - DB payment query:    50ms  ← optimized
    - Risk assessment API: 90ms  ← the real bottleneck
    - Response serialized:  15ms
    Total:                220ms

  After query optimization:
    - Input validation:     5ms
    - Auth check:          60ms
    - DB payment query:    25ms  ← optimized
    - Risk assessment API: 90ms  ← still 90ms
    - Response serialized:  15ms
    Total:                195ms

  The query was NOT the bottleneck. Risk assessment API (90ms) was.
  Optimizing the second-worst component barely moved the needle.
  The correct approach: fix risk assessment API OR make it async.
  OR: the system needs more capacity (scale out) AND async risk assessment.

  LESSON: Profile BEFORE optimizing. Use X-Ray or similar to get the full breakdown.
          Amdahl's Law: the speedup of the whole system is limited by the fraction
          of time spent in the component you improve.
          Improving a component that represents 20% of total time:
          even infinite speedup of that component → only 20% total improvement.
```

---

## SECTION 7 — AWS & Cloud Mapping

### Setting SLOs That Match the Right Metric

```
SLO DESIGN FRAMEWORK — THROUGHPUT vs LATENCY:

LATENCY SLO (user experience):
  "99% of /api/checkout requests must complete within 500ms."

  Measured: ALB TargetResponseTime p99 per route.
  Error budget: 1% of requests can exceed 500ms.
  At 1,000 req/sec: up to 10 requests/sec can be > 500ms before budget burns.

  Alert: When error budget burn rate > 6× (will exhaust budget in 1 day).
  Alert action: investigate latency root cause.
  Not: add more servers.

THROUGHPUT SLO (system capacity):
  "The system must handle 5,000 req/sec sustained with < 0.1% error rate."

  Measured: ALB RequestCount + HTTPCode_Target_5XX_Count.
  Error budget: 0.1% of requests can fail.
  At 5,000 req/sec: up to 5 errors/sec before budget burns.

  Alert: When error rate > 1% during high-traffic periods (throughput saturation).
  Alert action: scale out. Check auto-scaling configuration.
  Not: optimize code (code is probably fine — it's a capacity problem).

HOW TO SPOT WHICH SLO IS BURNING:

  Both burning simultaneously:
    Throughput saturation → queue buildup → high latency as SYMPTOM.
    Fix: throughput (scale out).

  Only latency SLO burning, throughput fine:
    Latency root cause: slow code, external dependency, bad query.
    Fix: profiling → code optimization.

  Only throughput SLO burning (errors), latency fine:
    Unusual: might be a specific error condition.
    Investigate error details: what endpoints? What error codes?
    Might be a bug, not a capacity issue.
```

---

## SECTION 8 — Interview Preparation

**Beginner:**

**Q: What is the difference between latency and throughput?**
**A:** Latency is how fast one thing happens. Throughput is how many things happen in a given time. Example: a highway. Latency = how long it takes ONE car to drive from start to finish. Throughput = how many cars per hour pass through the highway. A wide highway (many lanes) has high throughput but a car still takes 2 hours to cross â€” same latency.

**Q: Which matters more for a typical web app user: latency or throughput?**
**A:** Users care about latency â€” they notice if a page takes 3 seconds to load. They don't notice if your server handles 500 vs. 1000 requests per second overall. But your *system* needs adequate throughput to serve all users simultaneously. Rule of thumb: optimize latency first (user experience), then throughput (capacity to serve many users).

**Q: What is P99 latency and why is it more useful than average latency?**
**A:** P99 (99th percentile) is the latency experienced by 9 out of every 10 users â€” it's the worst-case for most users. Average latency hides the fact that 1% of users might wait 10 seconds while the average is 200ms. In a system with 10,000 users, "1% slow" means 100 users are having a terrible experience right now. Engineers monitor P99 and P95 to catch outliers that averages miss.

---

**Intermediate:**

**Q: Why does adding more servers improve throughput but not necessarily latency?**
**A:** More servers means more parallel request handling capacity â€” throughput increases. But each individual request still goes through the same path: client â†’ load balancer â†’ one server â†’ database â†’ response. If the database takes 200ms, adding app servers doesn't reduce that 200ms. Latency is determined by the longest path in the request chain (the critical path). Improving latency requires optimizing or caching the slowest step.

**Q: What is the relationship between concurrency, latency, and throughput (Little's Law)?**
**A:** Little's Law: Throughput = Concurrency / Latency. If your server handles 100 concurrent requests and each takes 0.1 seconds, throughput = 1,000 req/sec. To double throughput: either double concurrency (add more servers) or halve latency (optimize code/queries). This is why caching is so powerful: if a DB query takes 100ms but cache returns in 1ms, you can serve 100Ã— more requests with the same server count.

**Q: What causes the "latency cliff" during traffic spikes and how do you prevent it?**
**A:** At low load: database queries run with plenty of connection capacity â†’ 10ms. Under high load: connection pool exhausted â†’ requests queue â†’ queue time adds 2000ms. The system still technically handles the requests (throughput is OK) but latency spikes from 10ms to 2010ms. Prevention: (1) PgBouncer to reduce connection consumption. (2) Scale application servers earlier (scale on queue depth, not CPU). (3) Circuit breakers to fail-fast when downstream services are slow.

---

**Advanced (System Design):**

**Scenario 1:** Your payment API has an SLA of P99 < 500ms. For three months it met the SLA. Last week, P99 jumped to 2,100ms. Nothing was deployed. Diagnose the issue systematically.

*Step 1 â€” Check if it's infrastructure:* Is there an EC2 instance with degraded network? EBS burst credits exhausted on RDS? (gp2 volumes lose burst after sustained I/O)
*Step 2 â€” Correlate with data growth:* Is the slow-query table 3Ã— larger this month? Check pg_stat_user_tables for table size. Missing index on new query path?
*Step 3 â€” External dependency:* Did a third-party payment gateway change their response time? Add per-dependency P99 dashboards.
*Resolution pattern:* Always start with data (metrics, traces) before guessing. P99 spikes with no deploy often = data growth hitting an index threshold or external dependency degradation.

**Scenario 2:** Design a real-time analytics dashboard that must show live metrics with <1 second latency for 50,000 concurrent viewers during a major product launch. The underlying data comes from a database that receives 10,000 writes per second.

*Problem:* You can't query the DB 50,000 times per second with sub-second latency â€” the DB would be overwhelmed.
*Architecture:* Writes â†’ database (source of truth) AND â†’ stream processor (Kafka/Kinesis). Stream processor aggregates metrics in-memory. Aggregated results pushed to Redis every 100ms. Dashboard clients poll Redis or receive WebSocket push. Result: DB does heavy lifting on writes; Redis handles 50,000 concurrent read requests. Latency: 100ms (stream aggregation) + 5ms (Redis read) = ~105ms end-to-end.

