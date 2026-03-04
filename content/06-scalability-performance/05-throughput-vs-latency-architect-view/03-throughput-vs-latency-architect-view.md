# Throughput vs Latency (Architect View) — Part 3 of 3

### Topic: AWS Certification Focus, Comparison Tables, Quick Revision & Architect Exercise

**Series:** Scalability & Performance → Topic 05

---

## SECTION 9 — Certification Focus (AWS SAA)

### AWS Observability Stack for Throughput AND Latency

```
METRIC 1: THROUGHPUT (AWS CloudWatch)

ALB Metrics (north-south traffic):
  RequestCount (Sum, 1min):
    What: Requests processed by ALB per interval.
    Throughput signal: is traffic growing?
    Alert: > 150% of baseline → potential capacity event.

  TargetGroup RequestCountPerTarget (individual server metrics):
    What: Requests per backend instance.
    Use: detect uneven distribution (sticky session whale problem).
    Healthy: within 20% of each other across instances.

ECS/EC2 Metrics:
  CPUUtilization (Average across ASG):
    Proxy for throughput capacity saturation.
    > 70% sustained: approach scaling threshold.
    < 20%: latency problem (not throughput — servers are idle).

  Auto-scaling policy using RequestCount:
    "Scale out when ALBRequestCountPerTarget > 1000 requests per 1-minute period"
    Better than CPU scaling for stateless HTTP services.

SQS (if using async):
  ApproximateNumberOfMessagesVisible:
    Queue depth = backlog of work = throughput gap (producers faster than consumers).
    Alert: queue depth growing continuously.
    Auto-scaling trigger: scale consumers when queue > X for Y minutes.

────────────────────────────────────────────────────────────────────────────

METRIC 2: LATENCY (AWS CloudWatch + X-Ray)

ALB Metrics:
  TargetResponseTime (p50, p95, p99):
    What: Time from LB to backend and back.
    Alert: p99 > your SLO threshold sustained for > 2 min.
    Dashboard: show p50 (typical), p99 (worst), P99.9 if SLO requires it.

  CRITICAL RULE: CloudWatch ALB TargetResponseTime statistics:
    "Average" → use p50 metric instead (less misleading)
    "Maximum" → nearly useless (always shows the worst ever outlier)
    "p99" → the metric you care about for user experience
    Configure explicitly: CloudWatch → ALB → TargetResponseTime → select "p99"

X-RAY (distributed tracing):
  Purpose: break down latency by COMPONENT within a request.
  Without X-Ray: "P99 is 4s" — but you don't know WHERE.
  With X-Ray: "P99 is 4s. 3.2s of that is the exchange rate external API."

  Setup in Node.js:
    const AWSXRay = require('aws-xray-sdk');

    app.use(AWSXRay.express.openSegment('PaymentService'));

    // Instrument HTTP calls automatically:
    const https = AWSXRay.captureHTTPs(require('https'));

    // Manual subsegment for a specific operation:
    const segment = AWSXRay.getSegment();
    const sub = segment.addNewSubsegment('bcrypt-hash');
    const hash = await bcrypt.hash(password, 12);
    sub.close();

    app.use(AWSXRay.express.closeSegment());

  X-Ray Service Map in Console:
    Visual graph of all services.
    Edge latency p50/p99 between each service pair.
    Identifies the most latency-contributing component immediately.

  X-Ray Analytics:
    Filter traces by: URL, status code, user agent.
    Compare: latency distribution for /api/checkout vs /api/search.
    Find: which user segment has the worst P99 (platform? mobile? region?).

CLOUDWATCH CONTRIBUTOR INSIGHTS:
  Find the top contributors to high latency.
  Example rule: "Show top 10 clientIPs generating the most 5XX responses."
  Example rule: "Show top 10 user agents with P99 > 2000ms."
  This surfaces specific clients, routes, or regions with anomalous performance
  before you spend hours guessing.
```

---

## SECTION 10 — Comparison Table

```
┌──────────────────────────┬──────────────────────────────────────────────┐
│ OPTIMIZATION TYPE        │ IMPACT                                       │
├──────────────────────────┼──────────────────────────────────────────────┤
│ Horizontal Scaling       │ Throughput: ✅ linear increase               │
│ (add more servers)       │ Latency: ❌ unchanged (each server          │
│                          │           processes at same speed)           │
│                          │ Cost: ❌ linear cost increase               │
│                          │ Right when: CPU high, queue building         │
├──────────────────────────┼──────────────────────────────────────────────┤
│ Vertical Scaling         │ Throughput: ✅ increases (more threads/cores)│
│ (bigger instances)       │ Latency: ✅ may decrease (faster CPU        │
│                          │           for compute-bound operations)      │
│                          │ Cost: ❌ expensive; SPOF risk increases     │
│                          │ Right when: single-threaded bottleneck       │
├──────────────────────────┼──────────────────────────────────────────────┤
│ Caching                  │ Throughput: ✅ reduces origin load          │
│ (Redis, CDN)             │ Latency: ✅ cache hits: sub-ms              │
│                          │ Cost: ✅ cheaper than scaling origin        │
│                          │ Right when: read-heavy, cacheable content    │
├──────────────────────────┼──────────────────────────────────────────────┤
│ Async + Queue            │ Throughput: ✅ decouples producer/consumer  │
│                          │ Latency: ❌ per-operation latency increases │
│                          │           (async = not immediate response)   │
│                          │ Right when: workload can tolerate delay      │
├──────────────────────────┼──────────────────────────────────────────────┤
│ Batching                 │ Throughput: ✅ significant increase          │
│                          │ Latency: ❌ first item waits for full batch │
│                          │ Right when: bulk writes, ML inference, ETL  │
├──────────────────────────┼──────────────────────────────────────────────┤
│ Query Optimization       │ Throughput: ✅ secondary benefit            │
│ (index, N+1 fix)         │ Latency: ✅ directly reduces latency        │
│                          │ Cost: ✅ no infrastructure cost             │
│                          │ Right when: profiling reveals DB as hotspot  │
├──────────────────────────┼──────────────────────────────────────────────┤
│ CQRS                     │ Throughput: ✅ read/write scale independently│
│                          │ Latency: ✅ reads from optimized read model │
│                          │ Complexity: ❌ significant                  │
│                          │ Right when: high read:write ratio           │
└──────────────────────────┴──────────────────────────────────────────────┘
```

---

## SECTION 11 — Quick Revision

**Q: "Our P99 latency is 4 seconds but our throughput SLO is being met. What do you do?"**

> "First, I'd confirm the diagnosis: throughput SLO met means the system is handling the incoming volume without saturation. CPU is likely low and the queue depth is near zero — if either were elevated, the 4-second P99 would be a byproduct of queuing, not a latency root cause.
>
> Since throughput looks healthy, this is a pure latency problem: something inside the request path is slow. I'd start with distributed tracing — AWS X-Ray or equivalent — to break down where those 4 seconds are going. The typical culprits are a synchronous external API call, an N+1 database query, a missing index causing a full table scan, or a CPU-bound operation on an under-resourced instance.
>
> Once X-Ray shows the breakdown, fix the largest contributor first (Amdahl's Law). If the external API is taking 3 of the 4 seconds: cache its output in Redis if it's cacheable, or make the operation asynchronous so the user gets an immediate 202 and a webhook or poll result later. Do NOT add more servers — at 22% CPU, that just means more idle servers with the same slow requests."

---

**Q: "How do you improve throughput without hurting latency?"**

> "The safest way is horizontal scaling with stateless services — add more identical instances behind a load balancer. Each request is processed at the same speed (latency unchanged) but more requests can be processed simultaneously (throughput increases). This works as long as the bottleneck is pure compute capacity and the service has no shared-state dependencies.
>
> Caching is even better — it reduces origin load AND reduces latency simultaneously. It's not a tradeoff, it's a win-win for the right workload.
>
> The tension comes with batching and async processing. Both dramatically increase throughput but increase per-operation latency (batching waits for a full batch; async doesn't give an immediate response). I use these only when the workload tolerates delay: bulk data ingestion, background jobs, ML inference. For user-facing real-time interactions, I avoid batching at the cost of some throughput efficiency."

---

## SECTION 12 — Architect Thinking Exercise

**Scenario:** A payment processor currently handles 50 requests/sec with 800ms P99. Your target for the next quarter: 500 requests/sec with 200ms P99. Design the full optimization strategy. You have 3 months.

---

**Answer:**

```
STEP 1: DIAGNOSE BEFORE DESIGNING (Week 1)

  Current state at 50 req/sec:
    CPU utilization: ~30% (servers not saturated — this is a latency problem first)
    ALB queue depth: near zero

  Enable X-Ray on all services. Run 24h of traces.

  HYPOTHETICAL TRACE BREAKDOWN of current 800ms P99:
    Input validation:           5ms
    JWT verification:          40ms
    DB: load account balance:  200ms  ← probably missing index
    External fraud check API:  350ms  ← synchronous external dependency
    DB: write transaction:     140ms
    DB: emit audit record:      55ms
    Response serialization:     10ms
    Total:                     800ms

STEP 2: FIX LATENCY FIRST (Weeks 1-4)
  If we hit 500 req/sec with 800ms P99 — we need CAPACITY AND SPEED.
  Fix latency first: then capacity is cheaper to add.

  A: Add DB index on account balance lookup (2 hours work):
     account balance query: 200ms → 8ms.

  B: Make fraud check asynchronous (Week 2-3):
     Current: wait 350ms for fraud API before responding.
     New flow:
       - Accept payment, respond HTTP 202 { transactionId }
       - Submit fraud check job to SQS queue
       - Consumer service calls fraud API
       - If fraud detected: reverse the transaction (compensating action)
         This is the SAGA pattern — accept optimistically, compensate if needed.

     User-visible latency: 800ms drops to ~400ms.
     Risk: brief window where a fraudulent transaction exists.
     Mitigation: low-value transactions proceed; transactions > $1000 remain sync.

  C: Connection pooling for DB (if not already in place, 1 hour):
     Each query: eliminates 50ms connection overhead.
     All DB queries: ~50ms each improvement.
     account write: 140ms → 90ms.
     audit write:    55ms → 12ms.

  PROJECTED P99 AFTER LATENCY FIXES:
    Input validation:           5ms
    JWT verification:          40ms
    DB: load account balance:   8ms  (was 200ms — index added)
    Fraud check:                0ms  (async — removed from critical path)
    DB: write transaction:     90ms  (was 140ms — connection pooling)
    DB: emit audit record:     12ms  (was 55ms — connection pooling)
    Serialization:             10ms
    Total P99:                ~165ms  ← well below 200ms target!

STEP 3: SCALE THROUGHPUT (Weeks 4-8)

  Current: 2 app servers. Each now handles 50/2 = 25 req/sec at P99 165ms.
  Target: 500 req/sec. Need 10× current throughput.

  Auto-scaling configuration:
    Min instances: 4
    Max instances: 20
    Scale-out trigger: ALB RequestCountPerTarget > 200/min
    Scale-in trigger: ALB RequestCountPerTarget < 60/min for 15min

  Load testing (Week 5):
    Gradually increase from 50 → 500 req/sec over 1 hour.
    Monitor: does auto-scaling respond? P99 still within 200ms at 500 req/sec?

STEP 4: DATABASE THROUGHPUT (Weeks 6-8)

  At 500 req/sec: 1,500 DB queries/sec (3 per payment).

  Current RDS instance: can handle ~2,000 queries/sec. Acceptable but tight.
  Add: RDS Proxy (connection pooling at DB level — critical at 500 req/sec).
  Add: Read replica for the balance read query (lighten primary).

  Route balance reads → read replica.
  Route writes (transaction, audit) → primary.

  If primary becomes a bottleneck: Aurora Serverless v2 (auto-scales capacity units).

STEP 5: VALIDATE TARGETS (Weeks 9-12)

  Load test: 500 req/sec sustained for 30 minutes.
  Verify:
    P99 latency < 200ms ✅ (target)
    Error rate < 0.01% ✅
    Auto-scaling works correctly ✅
    CPU stays below 70% at 500 req/sec ✅ (leaves headroom for spikes)

  Chaos test: kill one app server mid-load test.
  Verify: auto-scaling recovers within 90 seconds. P99 briefly spikes but recovers.

RESULT:
  50 req/sec, 800ms P99 → 500 req/sec, ~165ms P99.
  Latency improvement: 4.8× better (code + DB optimization)
  Throughput improvement: 10× better (horizontal scaling + DB scaling)
  Key insight: fixed latency first → required FEWER servers for the same throughput.
  Cost of extra servers offset by the efficiency gain of each server processing faster.
```

---

## === Architect's Mental Model ===

### 5 Decision Rules

**Rule 1: Diagnose with the CPU + Queue signal before deciding throughput vs latency.**
CPU high AND queue building = throughput problem → scale out. CPU low AND queue empty = latency problem → find the slow code. Misidentifying which problem you have leads to spending money on the wrong fix. One 30-second look at CPU + queue depth metrics gives you the answer before any analysis begins.

**Rule 2: Latency optimization is usually cheaper than throughput scaling.**
Adding 5 servers to handle the same load costs $5× today and compounds. Finding and fixing a slow query that makes each request 4× faster means you need 4× fewer servers to handle the same load. The best throughput improvement is often a latency improvement. Always look for the query or external call that dominates the X-Ray trace before reaching for more capacity.

**Rule 3: Never cite average latency in architecture discussions — always use percentiles.**
Average latency hides the worst user experiences and can decline while P99 is worsening. In a system serving 1,000 req/sec, P99 = 2 seconds means 10 users per second experience 2-second responses. Average of 90ms looks healthy. SLOs, dashboards, and incident triggers must be percentile-based. P99 for user-interactive operations. P99.9 or P99.99 for financial transactions.

**Rule 4: Use Little's Law to estimate capacity needs: L = λ × W.**
Before any architecture discussion: state the throughput target (λ) and latency target (W). Derive L (required concurrency = λ × W). From L, size your connection pools, worker threads, and instance counts. Example: 500 req/sec target, 200ms P99 target → L = 500 × 0.2 = 100 concurrent requests in-flight at any moment. Size your system to comfortably handle 100 concurrent at 70% utilization: need ~143 concurrency capacity → translate to instance count.

**Rule 5: Async processing is a throughput optimization at the cost of latency — use it intentionally.**
Converting a synchronous operation to async always increases perceived latency (user doesn't get the result immediately). It dramatically increases throughput by decoupling producer speed from consumer speed. Before making something async, confirm the user can tolerate the delayed response. "Your report is being generated" → acceptable. "Your payment is being processed" → usually NOT acceptable (user needs the confirmation). Use async where the UX allows; don't apply it uniformly.

---

### 3 Common Mistakes

**Mistake 1: Auto-scaling on CPU alone when the bottleneck is I/O-bound.**
"CPU < 30% — we don't need to scale." But the service is making 200ms DB calls per request. At 500 req/sec with 200ms latency: Little's Law says 100 concurrent requests in-flight. Workers are not CPU-bound — they're waiting on I/O. CPU stays low. But requests queue up waiting for DB responses. Auto-scaling on CPU misses this entirely. Use ALB RequestCountPerTarget or queue depth for auto-scaling in I/O-bound services, not CPU.

**Mistake 2: Adding caching to solve a throughput problem instead of a latency problem.**
Cache hit rates are high → latency is low → great. But throughput capacity hasn't changed if each cached request still requires CPU and coordination. Caching reduces DB load (effectively giving DB more throughput headroom). But if your servers themselves are the bottleneck, caching individual values doesn't help: you still need more server capacity. Caching + horizontal scaling are complementary: caching extends how far you can go before scaling; scaling is needed when you've maxed out caching's benefits.

**Mistake 3: Not setting a throughput SLO, only a latency SLO.**
"Our P99 must be under 300ms." No throughput SLO defined. Traffic doubles. Team adds servers to maintain P99 < 300ms. Costs double. No alarm triggered (P99 is fine). Six months later: bill has tripled and nobody noticed because the only SLO was latency. Dual SLOs are necessary: latency SLO (user experience) AND cost per request metric (efficiency). Alternatively: throughput SLO defines the minimum capacity the system must handle at target latency — which bounds the cost of the architecture.

---

### 30-Second Interview Answer

> "Throughput is how much work a system completes per second — a rate. Latency is how long a single unit of work takes to complete — a duration. They fail differently and require different fixes. If CPU is high and requests are queuing: throughput problem, fix by adding capacity (horizontal scaling). If CPU is low, queue is empty, but requests are slow: latency problem, fix by finding and optimizing the slow operation (profile with X-Ray, fix the query, cache the external call). Conflating them leads to the most common expensive mistake in performance engineering: adding servers when the problem is a slow database query — you just made the same query run on more idle servers. Measure first: CPU + queue depth tells you which dimension is failing in under 30 seconds."

---

_End of Topic 05 — Throughput vs Latency (Architect View)_
