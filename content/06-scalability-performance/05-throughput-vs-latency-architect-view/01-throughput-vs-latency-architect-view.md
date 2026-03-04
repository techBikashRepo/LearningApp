# Throughput vs Latency (Architect View) — Part 1 of 3

### Topic: Foundations — Intuition, Core Concepts, Architecture & Data Flow

**Series:** Scalability & Performance → Topic 05

---

## SECTION 1 — Intuition (Explain Like a 12-Year-Old)

### The Highway vs the Sports Car

```
THROUGHPUT = how many cars cross a checkpoint per hour.
LATENCY    = how long it takes one car to travel from A to B.

SCENARIO A: 10-lane highway, 60mph speed limit.
  Throughput: 10,000 cars/hour (10 lanes × 1,000 cars each)
  Latency:    30 minutes per car (100km at 60mph)

SCENARIO B: 2-lane autobahn, no speed limit (150mph average).
  Throughput: 2,000 cars/hour
  Latency:    12 minutes per car (100km at 150mph)

Scenario A has 5× higher throughput.
Scenario B has 2.5× lower latency.

THESE OPTIMIZE FOR DIFFERENT THINGS:
  The 10-lane highway solves: "How do we move the most cargo?"
  The autobahn solves: "How fast can a single car complete a journey?"

IMPROVING ONE DOES NOT AUTOMATICALLY IMPROVE THE OTHER:
  Add 10 more lanes to the highway: throughput doubles. Latency unchanged.
  Speed up cars on the highway (60 → 75mph): latency drops 20%. Throughput unchanged.

IN SOFTWARE:
  Add more servers (horizontal scaling): throughput increases. Latency unchanged.
  Optimize your SQL query (N+1 → 1 query): latency decreases. Throughput unchanged.

  These require DIFFERENT solutions. Conflating them leads to the wrong fix.
```

---

### The Restaurant Kitchen Analogy

```
A restaurant takes 30 minutes to serve a party of 4 (LATENCY).
The restaurant serves 200 customers per evening (THROUGHPUT).

To improve THROUGHPUT:
  Open a second kitchen (more servers).
  Serve tables in parallel (more concurrency).
  Add tables (scale capacity).

  Each customer's dinner still takes 30 minutes. LATENCY UNCHANGED.
  But total customers served per evening: 400. THROUGHPUT DOUBLED.

To improve LATENCY:
  Streamline the menu (reduce decision logic).
  Pre-prep ingredients (pre-computation / caching).
  Train chefs to cook faster (algorithm optimization).
  Get a faster stove (better hardware per unit).

  Still only one kitchen. But each customer's dinner: 15 minutes. LATENCY HALVED.
  Total customers per evening: 400 (same capacity, each table turns over faster).
  Wait — latency improvements CAN increase throughput: faster service → table turns over faster
  → at fixed capacity, more customers in the same time.

  This is the relationship: Throughput = Concurrency / Latency (Little's Law).
  Improving latency DOES improve throughput if concurrency is fixed.
  But improving throughput (adding capacity) does NOT improve per-request latency.

THE CONFUSION:
  "We added 3 more servers. Why is it still slow?"
  Answer: 3 more servers increased your throughput capacity.
  If your problem was that each request takes 4 seconds because of a slow query:
  3 more servers still answer each query in 4 seconds.
  You now handle 3× more slow queries simultaneously.
  Latency is unchanged. Users still wait 4 seconds.
```

---

## SECTION 2 — Core Technical Explanation

### Misdiagnosis = Wrong Fix = Wasted Cost

```
PRODUCTION SCENARIO:
  SaaS platform. Engineering team gets an urgent request:
  "The app is slow. Fix it."

  WHAT IS ACTUALLY HAPPENING? There are two very different situations:

SITUATION A: Throughput Problem
  Metrics:
    ALB RequestCount: 15,000/min (3× last week)
    CPU across all servers: 85%
    Queue depth: building
    ALB TargetResponseTime p50: 120ms (was 110ms last week — barely changed)
    ALB TargetResponseTime p99: 4,800ms (was 200ms last week — massive change)

  What's happening:
    The system is SATURATED. More requests than servers can process.
    Most requests are fast (p50 = 120ms) — individual request logic is fine.
    But requests are WAITING IN QUEUE before getting a server.
    P99 is high because the 99th percentile request waited 4.6 seconds in queue
    before it was even picked up.

  CORRECT FIX: More capacity (horizontal scaling, auto-scaling, bigger instances).
  WRONG FIX: Optimize queries — individual queries run fast already.
             Add caching — the problem is volume, not speed.

SITUATION B: Latency Problem
  Metrics:
    ALB RequestCount: 5,000/min (normal)
    CPU across all servers: 22% (low! servers are bored)
    Queue depth: 0 (no waiting)
    ALB TargetResponseTime p50: 4,200ms (was 180ms last week)
    ALB TargetResponseTime p99: 12,000ms (was 500ms last week)

  What's happening:
    Traffic is completely normal. Servers are mostly idle.
    But each request takes forever.
    The bottleneck is NOT capacity — it's something inside the request path.
    (slow DB query, N+1 queries, missing index, synchronous external API call,
     code regression introduced in last deploy)

  CORRECT FIX: Find the slow operation. Profile. Fix the code or schema.
  WRONG FIX: Add more servers — servers are already idle at 22% CPU.
             Adding 5 more servers: 5 servers now idle at 5% CPU each.
             Each request still takes 4.2 seconds.

THE DECISION TREE:
  "The app is slow"
       │
       ├─ CPU high + queue building + p50 also elevated (but less than p99)?
       │    → THROUGHPUT PROBLEM → Scale out
       │
       └─ CPU low + no queue + p50 high (not just p99)?
            → LATENCY PROBLEM → Find and fix the slow operation
```

---

## SECTION 3 — Architecture Diagram (MANDATORY)

### Precise Definitions for System Design Interviews

```
THROUGHPUT:
  Definition: The rate at which a system completes work.
  Units: requests/second, messages/second, bytes/second, transactions/second

  Web API example: 1,000 req/sec
  Database: 5,000 queries/sec
  Message queue: 100,000 messages/sec
  Network: 1 Gbps

  Throughput is a RATE (work per unit time).
  It's a property of the SYSTEM (not of individual requests).

LATENCY:
  Definition: The time elapsed for a single unit of work to complete.
  Units: milliseconds, microseconds, seconds

  Web request: 85ms
  Database query: 4ms
  Network round-trip: 1.2ms
  Redis GET: 0.4ms

  Latency is a DURATION (time for one item).
  It's typically measured across a DISTRIBUTION (P50, P95, P99, P99.9).

WHY PERCENTILES MATTER MORE THAN AVERAGES:
  Your API processes 100 requests.
  99 requests: 10ms each.
  1 request: 91,000ms (91 seconds — stuck on a full table scan).

  Average latency: (99 × 10 + 1 × 91000) / 100 = 919ms.
  "Our average latency is 919ms."

  P50 (median): 10ms (50th percentile request = 10ms)
  P99: 91,000ms (wait — this is the slow one)

  Reality: 99% of users get 10ms responses.
           1% of users get 91-second responses.
           Averages hide this completely.

  "We need to fix the average" → wrong target.
  "We need to fix P99" → correct.

  At 1,000 req/sec: 10 requests/second are hitting 91-second latency.
  10 users PER SECOND experiencing near-complete unresponsiveness.
  The average looks fine. P99 reveals catastrophe.

LITTLE'S LAW (the bridge between throughput and latency):

  L = λ × W

  Where:
    L = average number of requests in the system (length/depth)
    λ = throughput (arrival rate = departure rate at steady state)
    W = latency (average time a request spends in the system)

  Rearranged:
    λ = L / W       (throughput = concurrency / latency)
    W = L / λ       (latency = queue depth / throughput)

  PRACTICAL IMPLICATION:
  If your server handles 100 concurrent requests (L=100)
  and P50 latency is 200ms (W=0.2s):
  Throughput: λ = 100 / 0.2 = 500 req/sec

  Now something makes latency 400ms (W=0.4s):
  Throughput drops to: λ = 100 / 0.4 = 250 req/sec
  At the SAME concurrency, you handle HALF the requests.
  Latency regression = throughput regression.
  This is why latency is not just a user experience problem — it also kills capacity.
```

---

## SECTION 4 — Request Flow (MANDATORY FLOWCHART)

### The Queue Model: Throughput vs Latency Visualization

```
NORMAL OPERATION (Throughput < Capacity):

  Arrivals:  ──► ──► ──►                  λ = 100 req/sec
                           │
                     ┌─────▼──────┐
                     │   QUEUE    │  depth = 0-2 (near empty)
                     │  [empty]   │  waiting time ≈ 0ms
                     └─────┬──────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
         ┌─────────┐  ┌─────────┐  ┌─────────┐
         │ Worker 1│  │ Worker 2│  │ Worker 3│  capacity = 150 req/sec
         │ 33ms avg│  │ 31ms avg│  │ 35ms avg│
         └─────────┘  └─────────┘  └─────────┘

         User observes: P50 = 33ms. P99 = 90ms. Healthy.
         Throughput delivered: 100 req/sec (= what's asked)

────────────────────────────────────────────────────────────────────────────────

THROUGHPUT SATURATION (Arrivals > Capacity):

  Arrivals:  ──► ──► ──► ──► ──► ──► ──►  λ = 180 req/sec (capacity = 150)
                                        │
                                  ┌─────▼──────────────────────┐
                                  │       QUEUE               │  queue GROWING
                                  │  [■■■■■■■■■■■■■■■■■■■■■■] │  now 200 deep
                                  │  waiting time: 1.3 seconds │  and growing
                                  └─────┬──────────────────────┘
                                        │
                         ┌──────────────┼──────────────┐
                         ▼              ▼              ▼
                    ┌─────────┐   ┌─────────┐   ┌─────────┐
                    │ Worker 1│   │ Worker 2│   │ Worker 3│   all 3 at 100% capacity
                    │ 33ms    │   │ 31ms    │   │ 35ms    │   (CPU 90%+)
                    └─────────┘   └─────────┘   └─────────┘

  User observes: P50 = 33ms + 1300ms wait = 1333ms
                 P99 = varies wildly based on where in queue you land.

  The INDIVIDUAL REQUEST is still processed in 33ms by the worker.
  The 1.3s "latency" is QUEUING DELAY — not request processing delay.

  FIX: Add more workers (horizontal scaling / bigger instances).
  NOT: optimize the 33ms per-request processing time.

────────────────────────────────────────────────────────────────────────────────

LATENCY PROBLEM (Throughput normal, but each request is slow):

  Arrivals:  ──► ──►                      λ = 50 req/sec (normal, not a spike)
                      │
                ┌─────▼──────┐
                │   QUEUE    │  depth = 0 (always empty! No backlog)
                │  [empty]   │
                └─────┬──────┘
                      │
         ┌────────────┼────────────┐
         ▼            ▼            ▼
    ┌─────────┐  ┌─────────┐  ┌─────────┐   Workers are NOT busy.
    │ Worker 1│  │ Worker 2│  │ Worker 3│   CPU: 15%.
    │ 4200ms  │  │ 4350ms  │  │ 4100ms  │   Each request takes > 4 seconds.
    │ per req │  │ per req │  │ per req │   Why? Something IN the request is slow.
    └─────────┘  └─────────┘  └─────────┘

  User observes: P50 = 4200ms. P99 = 12000ms.
  Adding more workers: doesn't help. Each one processes slowly.

  FIX: Find the slow code. Profile. Instrument. Fix the query / API call / algorithm.
  Adding more workers: "Now 6 workers, each spending 4200ms per request."
  Throughput capacity: 6/4.2s = 1.4 req/sec per worker. Not better.

────────────────────────────────────────────────────────────────────────────────

THE KNEE OF THE CURVE:

  Latency (ms)
       │
  4000 │                              **** (latency explodes at saturation)
  3000 │                         ****
  2000 │                    *
  1000 │               *
   500 │          *
   200 │     **
   100 │***
     0 └──────────────────────────────→
       0%   20%  40%  60%  80%  100% 120%

       System utilization (%)

  The knee: beyond ~70-80% utilization, latency climbs NON-LINEARLY.
  At 100% utilization: every new request is queued. Latency explodes.

  This is why capacity planning targets 60-70% utilization, not 95%.
  The extra 30-40% is not waste — it absorbs variance without queue buildup.
```

---

_→ Continued in: [02-Throughput vs Latency (Architect View).md](02-Throughput%20vs%20Latency%20%28Architect%20View%29.md)_
