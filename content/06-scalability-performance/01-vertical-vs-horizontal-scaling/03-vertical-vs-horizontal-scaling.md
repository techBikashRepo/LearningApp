# Vertical vs Horizontal Scaling — Part 3 of 3

### Topic: AWS Certification Focus, Comparison Tables, Quick Revision & Architect Exercise

**Series:** Scalability & Performance → Topic 01

---

## SECTION 9 — Certification Focus (AWS SAA)

### ALB + Auto Scaling Group Architecture

```
INTERNET
    │
    ▼
Route 53 (DNS)
    │  Weighted routing: 100% → primary region, 0% → DR region normally
    ▼
Amazon CloudFront (optional CDN layer)
    │  Static assets cached at edge. API requests passed through.
    ▼
Application Load Balancer (ALB)
    │
    │  ALB CONFIGURATION:
    │  • Listener: HTTPS :443 → Target Group: app-servers
    │  • Health check: GET /health → expect HTTP 200 within 5s
    │  • Health check: 3 consecutive successes = healthy
    │              5 consecutive failures = unhealthy (not 1!)
    │  • Routing: path-based or weighted for canary deployments
    │  • Idle timeout: 60 seconds (adjust for WebSocket: 3600s)
    │
    ▼
AUTO SCALING GROUP (ASG)
    │
    │  ASG CONFIGURATION:
    │  • Min capacity: 2 (always at least 2 instances across 2 AZs)
    │  • Desired capacity: 4 (normal traffic)
    │  • Max capacity: 20 (cost ceiling)
    │
    │  SCALING POLICIES (production-grade, not just CPU):
    │
    │  Policy 1: CPU-based (built-in, easy)
    │    Scale OUT: Average CPU > 70% for 3 minutes → add 2 instances
    │    Scale IN:  Average CPU < 30% for 10 minutes → remove 1 instance
    │    (asymmetric: scale in slowly to avoid flapping)
    │
    │  Policy 2: Request count (more direct than CPU)
    │    ALB metric: RequestCountPerTarget > 500/min per target → add 2 instances
    │    This directly correlates with user-visible load.
    │
    │  Policy 3: Custom metric — P99 latency (best for user experience)
    │    CloudWatch custom metric: ALB TargetResponseTime P99 > 500ms → add 2 instances
    │    This catches DB-latency-driven overload that CPU metrics miss.
    │
    │  SCALE-IN PROTECTION:
    │    Cooldown period: 300s after scale-out before scale-in evaluates.
    │    (Prevent: scale out → scale in → overload → scale out loop)
    │
    │  LIFECYCLE HOOKS:
    │    Before termination: drain connections (60s drain timeout).
    │    ALB deregisters instance → waits for in-flight requests to complete.
    │    Then terminates. Zero dropped requests on scale-in.
    │
    ▼
EC2 INSTANCES (or ECS Fargate tasks)
    │  AMI / Docker image: pre-baked (not installing packages on startup — too slow)
    │  Instance type selection:
    │    CPU-bound: c7i.2xlarge (compute optimized)
    │    Memory-bound: r7i.2xlarge (memory optimized)
    │    Balanced: m7i.2xlarge (general purpose)
    │  EBS: gp3 volumes for fast I/O
    │
    ▼
PRIVATE SUBNET RESOURCES:
    │
    ├──► RDS Aurora (Multi-AZ — automatic failover across AZs)
    │     + Reader endpoint → read replicas (auto routes read traffic)
    │     + Writer endpoint → primary (auto fails over, new primary in ~30s)
    │     + RDS Proxy: connection pooling (solves Lambda/ECS connection storms)
    │
    ├──► ElastiCache Redis (Cluster Mode Enabled)
    │     • Cluster: 3 shards × 2 nodes (primary + replica per shard)
    │     • Session storage, rate limiting counters, caching
    │     • Auto-failover: if primary node fails, replica promoted in ~10s
    │
    └──► SQS Queues (for async work offloaded from synchronous requests)
          ECS consumer service: auto-scales based on queue depth
          SQS attribute: ApproximateNumberOfMessagesVisible > 1,000 → +2 consumers
```

---

### Auto Scaling: Predictive vs Reactive

```
REACTIVE AUTO-SCALING (default):
  Trigger: Metric threshold breached → launch new instance.
  Lag: 3-5 minutes (instance start + health check + warm-up).

  Problem: Traffic spikes faster than instances start.
  At 9:00AM Black Friday: spike is instantaneous.
  New instances ready at 9:04AM. Damage already done at 9:01AM.

PREDICTIVE AUTO-SCALING (production recommendation for known patterns):
  AWS feature: Predictive Scaling (uses ML on historical data).

  "Every day at 9AM there's a traffic spike. Pre-warm at 8:50AM."

  Pre-scaling runs 10 minutes before the expected spike.
  New instances are registered with ALB and warm BEFORE traffic arrives.
  The spike hits a system that's already at capacity.

  USE when: traffic follows predictable daily/weekly patterns.
  COMBINE with reactive scaling for unpredictable spikes (product launches).

SCHEDULED SCALING (for known events):
  # Before a scheduled product launch:
  aws autoscaling put-scheduled-update-group-action \
    --auto-scaling-group-name production-asg \
    --scheduled-action-name pre-launch-scale-out \
    --start-time "2026-03-01T08:45:00Z" \
    --desired-capacity 20 \
    --min-size 20

  # After the expected launch peak:
  aws autoscaling put-scheduled-update-group-action \
    --auto-scaling-group-name production-asg \
    --scheduled-action-name post-launch-scale-in \
    --start-time "2026-03-01T14:00:00Z" \
    --desired-capacity 6 \
    --min-size 2

  This is mandatory for Black Friday, planned product launches,
  scheduled email campaigns (your marketing team sends an email at 9AM
  — that's a predictable traffic spike — pre-scale for it).
```

---

### ECS Fargate Auto-Scaling (Containers)

```
Fargate advantage over EC2 ASG:
  EC2 ASG launches a VM (3-4 minutes: instance start + OS boot + app start).
  Fargate launches a container (45-90 seconds: container pull + app start).

  Faster scale-out = smaller window of overload during sudden spikes.

ECS SERVICE AUTO-SCALING:

  # Application Auto Scaling target
  resource_id = "service/my-cluster/my-api-service"

  # Scale out: CPU > 70%
  TargetTrackingScalingPolicy:
    MetricType: ECSServiceAverageCPUUtilization
    TargetValue: 70
    ScaleOutCooldown: 60   # seconds (fast scale-out)
    ScaleInCooldown: 300   # seconds (slow scale-in — avoid flapping)

  # Scale out: P99 latency (using ALB metric)
  TargetTrackingScalingPolicy:
    CustomMetric: ALBRequestCountPerTarget  (or custom CloudWatch metric)
    TargetValue: 300  # requests per target per minute

ECS + CAPACITY PROVIDERS:
  For mixed EC2 + Fargate:
    - Baseline: On-Demand EC2 (cheapest for steady-state)
    - Burst: Fargate Spot (70% cheaper, but can be interrupted — OK for stateless apps)
    - Critical: On-Demand Fargate (for minimum always-on capacity)

  Cost optimization result:
    At steady state: 90% EC2 On-Demand, 10% Fargate On-Demand
    During spike: 60% EC2 On-Demand, 40% Fargate Spot
    Average cost savings vs all On-Demand: ~30%
```

---

## SECTION 10 — Comparison Table

### Exercise: Plan Capacity for an E-Commerce Launch

**Given Data:**

- Current daily active users (DAU): 100,000
- Expected launch traffic: 5× normal
- Current single app server handles: 150 req/sec at 60% CPU
- Average response time: 120ms
- DB: PostgreSQL, each request makes 2 queries averaging 40ms each
- Expected concurrent users at peak: 15,000

**Work through the estimation:**

---

**Step 1: Calculate peak request rate**

```
PEAK REQUESTS PER SECOND:
  15,000 concurrent users.
  Each user makes a request every... how often?
  Typical e-commerce browsing: 1 page view every 5 seconds (clicking around).

  Peak req/sec = 15,000 concurrent / 5 seconds = 3,000 req/sec

VERIFY WITH LITTLE'S LAW:
  If avg response time = 120ms = 0.12s
  L = λ × W
  15,000 (concurrent requests in flight) = λ × 0.12
  λ = 15,000 / 0.12 = 125,000 req/sec  ← too high!

  Correction: "concurrent users" ≠ "concurrent requests in flight."
  Users are think time + request time. Think time: 5 seconds.
  Actual concurrent requests in flight: 15,000 × (0.12 / 5.12) ≈ 350 concurrent

  λ = L / W = 350 / 0.12 ≈ 2,917 req/sec ≈ 3,000 req/sec ✅ (matches estimate)
```

---

**Step 2: Calculate required app server capacity**

```
SINGLE SERVER CAPACITY:
  At 60% CPU: handles 150 req/sec.
  At 100% CPU: would handle ~250 req/sec (but we don't run at 100%).
  Safe operating point: 70% CPU → 175 req/sec per server.

REQUIRED SERVERS FOR 3,000 REQ/SEC:
  3,000 / 175 = 17.1 → 18 app servers (round up)

ADD 30% HEADROOM (for estimation error — it's always higher than expected):
  18 × 1.3 = 23.4 → 25 app servers

  (This is why the post-incident team said "plan for 3×" — they estimated 5,000 req/sec
   and got 8,000 req/sec in the real incident. Estimate high.)

COST ESTIMATE:
  c6i.xlarge (4 vCPU, 8GB RAM): $0.17/hour
  25 servers × $0.17/hour × peak duration 8 hours = $34

  Savings from not running 25 servers 24/7:
  Scale in after peak: 25 → 6 servers.
  Daily cost without auto-scaling: 25 × $0.17 × 24h = $102/day
  Daily cost with auto-scaling: (6 × 20h + 25 × 4h) × $0.17 = $37.40/day
  Monthly savings: ~$1,940
```

---

**Step 3: Calculate DB capacity requirements**

```
DB CONNECTION REQUIREMENT:
  25 app servers × 10 connections each = 250 connections minimum.
  Under peak: each server needs more connections simultaneously.
  25 servers × 20 connections each = 500 connections.

  PostgreSQL safe max connections: ~300-400 (beyond this: performance degrades).

  500 connections requested > 300 postgres limit → PROBLEM.

SOLUTION: RDS Proxy or PgBouncer
  AWS RDS Proxy pools connections:
  - App servers think they have 500 connections.
  - RDS Proxy maintains 30-50 real connections to PostgreSQL.

  PostgreSQL sees 30-50 connections. No problem.
  Cost: RDS Proxy ~ $0.015/connection-hour → 50 connections × $0.015 = $0.75/hr

DB QUERY LOAD AT PEAK:
  3,000 req/sec × 2 queries/request = 6,000 queries/sec to DB.

  Can PostgreSQL handle 6,000 queries/sec?
  Rule of thumb: simple queries (index lookup): ~5,000-10,000/sec on modern hardware.
  Our queries average 40ms → Little's Law: concurrent queries = 6,000 × 0.04 = 240 concurrent.

  240 concurrent active queries is HIGH. PostgreSQL will show stress.

  MITIGATION: Read replicas.
  If 70% of queries are reads: 4,200 reads/sec → read replicas.
  DB primary sees: 1,800 writes/sec only. Much healthier.
```

---

**Step 4: Final capacity plan**

```
COMPONENT             NORMAL STATE    PEAK STATE    CONFIGURATION
─────────────────────────────────────────────────────────────────────
App Servers           4 instances     25 instances  c6i.xlarge
                                                    Auto-scale: CPU > 70%
                                                    Pre-scale 30min before launch

Load Balancer         1 ALB           1 ALB         No changes needed
                                                    (ALB scales automatically)

DB Primary            db.r6g.2xlarge  db.r6g.2xlarge No changes
                      (no resize)     (no resize)   Use RDS Proxy for connections

DB Read Replicas      1 replica       3 replicas    Add 2 read replicas before launch
                                                    Point 70% of read traffic there

Redis Cache           cache.r6g.large  cache.r6g.large  Pre-warm cache before launch
                                                         Seed product catalog data

RDS Proxy             Not used        Enabled       Pool app→DB connections

ESTIMATED PEAK COST DELTA (4h peak launch window):
  Additional 21 app servers × $0.17 × 4h = $14.28
  2 additional read replicas × $0.20 × 4h = $1.60
  RDS Proxy: $0.75/h × 4h = $3.00
  Total additional cost for 4h peak: ~$19

  This is trivial. The real cost is the INCIDENT if you don't scale.
```

---

## SECTION 11 — Quick Revision

---

**Q: "Walk me through how you would handle a sudden 10× traffic spike."**

> "First, distinguish between immediate response and root cause. In the moment: check if auto-scaling has engaged — if not, manually trigger it. Check the bottleneck: is it app CPU, DB connections, or an external dependency? Most spikes die at the database, not the app servers. Adding more app servers to a DB-bottlenecked system makes it worse — they each try to grab DB connections.
>
> Immediate relief: scale up DB connections via PgBouncer or RDS Proxy, activate read replicas, check for missing indexes in slow query logs. Enable any caching you have available.
>
> Long-term: post-incident analysis on what the actual bottleneck was. Instrument P99 latency breakdown by component (app processing vs DB query vs external API). Fix the root cause, then validate by load testing at 3× expected peak."

---

**Q: "What's the difference between vertical and horizontal scaling? Which would you choose?"**

> "Vertical: bigger machine — more CPU, RAM, network. Fast to apply, no code changes, works for stateful components like primary databases. Ceiling is hardware limits and takes downtime to apply.
>
> Horizontal: more machines — works for stateless services, provides fault tolerance, no ceiling (keep adding machines), costs less at idle (turn off unused instances). Requires the service to be stateless — sessions in Redis, no local state.
>
> In practice: I vertically scale the database when it becomes the bottleneck first (faster, simpler). I horizontally scale app servers (they're stateless). For high scale: I combine — vertical for the DB to buy time, read replicas to offload reads, connection pooling (PgBouncer) to prevent connection storms, then sharding if single-primary write throughput maxes out."

---

**Q: "Your app is slow under load but CPU is only at 30%. What do you look at?"**

> "Low CPU + high latency means the bottleneck is somewhere you're WAITING, not COMPUTING. The three usual suspects: the database (lock contention, slow queries, connection pool exhaustion), an external API that's slow or rate-limiting you, or network I/O (slow downstream service, database in a different AZ).
>
> I'd first look at DB slow query logs and active connections. Then trace one slow request end-to-end — which component is taking the time? P99 latency broken down by segment: time in app code vs time in DB query vs time in external call. The 30% CPU tells me it's probably not the app itself doing expensive computation — it's waiting on something else."

---

## === Architect's Mental Model ===

### 5 Decision Rules

**Rule 1: Identify the bottleneck BEFORE choosing a scaling strategy.**
App servers are almost never the bottleneck. The database almost always is. Adding more app servers to a DB-bottlenecked system increases DB connection pressure and makes the incident worse. Profile first: DB CPU, slow query log, connection pool utilization. Then scale the correct component.

**Rule 2: Stateless is a prerequisite, not a nice-to-have, for horizontal scaling.**
Before you horizontally scale ANY service, confirm: does it hold any state in local memory? Does it write to local disk and read from it on the next request? If yes, fix that first. External state store (Redis for sessions, S3 for files, DB for persistent data). All state external. Then horizontal scaling works without data consistency nightmares.

**Rule 3: Scale OUT to handle traffic. Scale UP to buy time.**
When a prod incident is happening and you need 5 minutes of relief: resize the instance (vertical — no code change, quick). When building for next month: architect for horizontal scaling. Vertical scaling is an emergency lever, not a growth strategy. Its ceiling is too low and it introduces downtime.

**Rule 4: Auto-scaling policies should be based on latency, not just CPU.**
CPU at 30% with 5-second response times means: the system is broken, but auto-scaling won't trigger because CPU looks "fine." The performance problem is I/O-bound (DB, network). Add a complementary scaling policy based on ALB P99 `TargetResponseTime` exceeding your SLA. CPU + latency together prevent the "low CPU, system still down" failure mode.

**Rule 5: Plan for 3× your peak estimate. Load test at 3× before launches.**
Every post-incident review of a traffic-induced outage includes "traffic was higher than expected." Marketing's 5,000-user estimate is a guess. The actual peak was 8,000. Plan capacity for 15,000 (the 3× rule). Pre-scale before scheduled events (email campaigns, product launches, marketing pushes). Reactive auto-scaling is too slow for instantaneous spikes.

---

### 3 Common Mistakes

**Mistake 1: Treating a latency problem as a scaling problem.**
"P99 is 4 seconds — add more servers." Added 3×. P99 still 3.8 seconds. The problem was a missing DB index. Adding servers just meant more requests finding the same slow query. Scaling amplifies the bottleneck if the bottleneck is a shared resource (the DB) rather than per-instance compute capacity. Always find the bottleneck first.

**Mistake 2: Setting ALB health check sensitivity too high.**
Health check: "fail after 1 consecutive failure." Under load, the first DB query is sometimes slow — app takes 6 seconds to respond to health check. ALB marks it unhealthy. Removes from rotation. Remaining instances now handle 33% more traffic. They also hit the slow DB. Also fail health check. Cascade. Everything down. Fix: require 3-5 consecutive failures before marking unhealthy, and set health check timeout to a value higher than your normal P99 latency.

**Mistake 3: Horizontally scaling the wrong component.**
"The DB is slow — let's add a read replica for every feature." But 90% of load is write-heavy (order creation, inventory updates, payment records). Read replicas don't help write throughput. Doubling the number of app servers just doubles write traffic to the single primary. The solution for write-heavy bottlenecks: connection pooling, write-path optimization (batching, async writes to SQS), or vertical scaling of the primary first — not read replicas.

---

### 30-Second Interview Answer

> "Vertical scaling — bigger machine — is fast to apply and works for stateful components like primary databases, but it has a hardware ceiling, causes downtime to apply, and wastes money at idle. Horizontal scaling — more machines — is the production answer for stateless services: it provides fault tolerance, scales linearly with demand, and costs nothing when traffic drops. The prerequisite is statelessness: sessions in Redis, no local disk state. In practice I combine both: vertically scale the database to buy time, horizontally scale the app tier as the growth strategy, and use connection pooling so that more app instances don't linearly increase DB connections. The most important rule: find the bottleneck first — adding more app servers to a DB-bottlenecked system makes it worse."

---

_End of Topic 01 — Vertical vs Horizontal Scaling_
_Series: Scalability & Performance_
## SECTION 12 — Architect Thinking Exercise

**Scenario:**
You are the lead architect at a fintech startup. Your Node.js API server currently runs on a single EC2 	3.xlarge instance (4 vCPU, 16GB RAM). The application handles payment processing and user authentication. Over the last 3 months, traffic has grown 5x and you're hitting 80% CPU utilization at peak hours. The CTO wants a solution deployed within 2 weeks.

**Think before reading the solution:**
- Should you scale vertically (upgrade to 	3.2xlarge or 5.4xlarge) or horizontally (add more 	3.xlarge instances behind a load balancer)?
- What are the constraints of each approach given this is a payment service?
- What changes would be required to the application itself?

---

**Architect's Solution:**

**Step 1 â€” Identify the bottleneck type:**
CPU-bound at 80% suggests compute saturation, not memory pressure. Payments + auth suggests stateful session concerns.

**Step 2 â€” Evaluate vertical scaling:**
- Pro: zero code changes, deploy in minutes
- Con: single point of failure, EC2 size limits, diminishing returns, expensive
- Verdict: use as a short-term bridge (buy 2 weeks), not a long-term solution

**Step 3 â€” Plan horizontal scaling:**
- Stateless API: extract session state to ElastiCache (Redis) or use JWT (stateless tokens)
- Idempotency: ensure payment endpoints are idempotent (add idempotency_key column)
- ALB: add Application Load Balancer with health checks
- Auto Scaling Group: min=2, desired=3, max=10 based on CPUUtilization > 70%

**Step 4 â€” Database consideration:**
- Single RDS instance becomes the next bottleneck â€” add read replicas for auth reads
- Payment writes must still hit primary

**Final architecture:** ALB â†’ ASG (3 Ã— t3.xlarge) â†’ RDS Primary + 1 Read Replica + ElastiCache

**Timeline:** Vertical scale today (30 min). Horizontal architecture: 2 weeks parallel to vertical.
