# Monolith vs Microservices — Part 3 of 3

### Sections: 9 (Cloud Mapping), 10 (Tradeoff Analysis), 11 (System Design Interview), 12 (Design Exercise)

**Series:** System Design & Architecture → Topic 01

---

## SECTION 9 — Cloud Mapping

### AWS Architecture for a Monolith

```
                        ┌────────────────────────────┐
                        │   Route 53 (DNS)           │
                        └──────────────┬─────────────┘
                                       │
                        ┌──────────────▼─────────────┐
                        │   Application Load Balancer │
                        │   (ALB) — HTTP/HTTPS        │
                        └────┬──────────────┬─────────┘
                             │              │
                  ┌──────────▼──┐      ┌────▼──────────┐
                  │  EC2 / ECS  │      │  EC2 / ECS    │
                  │  Instance A │      │  Instance B   │
                  │  (Monolith) │      │  (Monolith)   │
                  └──────────┬──┘      └────┬──────────┘
                             │              │
                             └──────┬───────┘
                                    │
                    ┌───────────────▼──────────────┐
                    │   Amazon RDS (Aurora PG)      │
                    │   Multi-AZ — Single DB        │
                    │   All tables, one schema      │
                    └──────────────────────────────┘
                                    │
                    ┌───────────────▼──────────────┐
                    │   Amazon ElastiCache (Redis)  │
                    │   Session store, app cache    │
                    └──────────────────────────────┘
                                    │
                    ┌───────────────▼──────────────┐
                    │   Amazon SQS                  │
                    │   Background jobs queue       │
                    │   (emails, reports, exports)  │
                    └──────────────────────────────┘

Key AWS services for monolith:
  Compute:   EC2 Auto Scaling Group or ECS Service (1 task definition)
  Database:  Amazon RDS Aurora PostgreSQL (Multi-AZ for HA)
  Cache:     Amazon ElastiCache Redis (sessions + query cache)
  Storage:   Amazon S3 (file uploads, static assets)
  Queue:     Amazon SQS (async background jobs)
  Deploy:    AWS CodeDeploy or GitHub Actions → ECS rolling update
  Logs:      Amazon CloudWatch Logs (one log group)
  Monitor:   Amazon CloudWatch (one dashboard, one alarm set)

Scaling strategy:
  Horizontal: Auto Scaling Group adds EC2 instances behind ALB.
  Vertical: Increase instance type (t3.large → m5.xlarge) for memory-bound workloads.
  DB: RDS Read Replicas for read-heavy endpoints.
```

---

### AWS Architecture for Microservices

```
Route 53 → CloudFront (CDN + WAF) → API Gateway (HTTP API or REST API)
    │
    ▼
API Gateway routes:
    /users/*    → User Service
    /orders/*   → Order Service
    /payments/* → Payment Service
    /inventory/*→ Inventory Service

┌──────────────────────────────────────────────────────────┐
│                    EKS (Kubernetes)                       │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │
│  │ User Service│  │Order Service│  │ Pay Service │ ...  │
│  │  (Pods)     │  │  (Pods)     │  │  (Pods)     │     │
│  │             │  │             │  │             │     │
│  │  Deployment │  │  Deployment │  │  Deployment │     │
│  │  HPA enabled│  │  HPA enabled│  │  HPA enabled│     │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘     │
│         │                │                │             │
│  ┌──────▼──────┐  ┌──────▼──────┐  ┌──────▼──────┐     │
│  │  Istio      │  │  Istio      │  │  Istio      │     │
│  │  Sidecar    │  │  Sidecar    │  │  Sidecar    │     │
│  │ (mTLS,retry,│  │ (mTLS,retry,│  │ (mTLS,retry,│     │
│  │  circuit-br)│  │  circuit-br)│  │  circuit-br)│     │
│  └─────────────┘  └─────────────┘  └─────────────┘     │
└──────────────────────────────────────────────────────────┘
         │                │                │
  ┌──────▼───┐    ┌───────▼──┐    ┌────────▼──┐
  │ RDS      │    │ RDS      │    │ RDS       │
  │ (Users   │    │ (Orders  │    │(Payments  │
  │  Schema) │    │  Schema) │    │ Schema)   │
  └──────────┘    └──────────┘    └───────────┘

Event Bus:
┌──────────────────────────────────────────────┐
│          Amazon MSK (Kafka)                  │
│  Topics: order.created, payment.completed,   │
│          inventory.reserved, user.updated    │
│                                              │
│  Producers: Order Service, Payment Service   │
│  Consumers: Notification Service, Analytics  │
└──────────────────────────────────────────────┘

Observability Stack:
┌──────────────────────────────────────────────┐
│  AWS X-Ray: distributed tracing              │
│  Amazon CloudWatch Container Insights: metrics│
│  Amazon OpenSearch: centralized log search   │
│  AWS Managed Grafana: dashboards             │
└──────────────────────────────────────────────┘

AWS Services per microservices concern:
  Container Orchestration: Amazon EKS (Kubernetes) or ECS Fargate
  Service Mesh:            AWS App Mesh (Envoy) or Istio on EKS
  API Management:          Amazon API Gateway (HTTP API)
  Event Streaming:         Amazon MSK (Managed Kafka) or Amazon EventBridge
  Service Discovery:       AWS Cloud Map + Route 53
  Secrets:                 AWS Secrets Manager (each service gets its own secret)
  CI/CD:                   AWS CodePipeline per service, or GitHub Actions per repo
  Tracing:                 AWS X-Ray (trace IDs propagated across service hops)
  Logs:                    Amazon CloudWatch Logs + Container Insights
  Alerting:                Amazon CloudWatch Alarms + SNS + PagerDuty
  Load Balancing:          AWS ALB per service (or AWS NLB for gRPC)
```

---

### Cost Comparison: AWS Monolith vs Microservices

```
E-commerce SaaS: 500K users, 50K orders/day

MONOLITH on AWS (estimated monthly):
  EC2 (3× m5.2xlarge behind ALB):        $1,200
  RDS Aurora PostgreSQL (r5.2xlarge):     $900
  ElastiCache Redis (r5.large):           $150
  ALB, data transfer, S3, SQS:           $200
  CloudWatch basic monitoring:            $50
  TOTAL:                                  ~$2,500/month

MICROSERVICES on AWS (same traffic):
  EKS cluster (3× m5.2xlarge workers):   $1,200
  RDS × 5 services (smaller instances):  $2,000 (5× r5.large)
  MSK Kafka (3-broker cluster):          $800
  API Gateway (10M req/month):           $350
  AWS App Mesh / Istio overhead:         $200 (extra CPU)
  AWS X-Ray, CloudWatch enhanced:        $300
  S3, data transfer, SQS, Secrets Mgr:  $400
  TOTAL:                                  ~$5,250/month

Infrastructure cost difference:          +110% for microservices
Engineering setup overhead:              2-4 months of platform work
Ongoing platform maintenance:            1 dedicated SRE minimum

BREAK-EVEN point: When the BUSINESS value of independent scaling,
deployment autonomy, and fault isolation outweighs the ~2× infra cost
and platform engineering investment.
```

---

## SECTION 10 — Tradeoff Analysis

### Decision Matrix

```
┌─────────────────────┬─────────────────────┬─────────────────────┐
│    DIMENSION        │     MONOLITH        │   MICROSERVICES     │
├─────────────────────┼─────────────────────┼─────────────────────┤
│ Development Speed   │ ✅ Faster early on   │ ❌ Slower early on   │
│ (feature velocity)  │ Single codebase,    │ Cross-service       │
│                     │ simple deploys      │ coordination        │
├─────────────────────┼─────────────────────┼─────────────────────┤
│ Debugging           │ ✅ Single stack trace│ ❌ Multi-service     │
│                     │ One grep, one log   │ tracing required    │
├─────────────────────┼─────────────────────┼─────────────────────┤
│ Data Consistency    │ ✅ ACID transactions │ ❌ Eventual          │
│                     │ across all modules  │ consistency.        │
│                     │                     │ Saga pattern needed │
├─────────────────────┼─────────────────────┼─────────────────────┤
│ Fault Isolation     │ ❌ One crash = all   │ ✅ One crash =       │
│                     │ modules affected    │ one service only    │
├─────────────────────┼─────────────────────┼─────────────────────┤
│ Independent Scale   │ ❌ Scale everything  │ ✅ Scale bottleneck  │
│                     │ or nothing          │ service only        │
├─────────────────────┼─────────────────────┼─────────────────────┤
│ Team Autonomy       │ ❌ Deploy coupling   │ ✅ Independent       │
│                     │ Between teams       │ team releases       │
├─────────────────────┼─────────────────────┼─────────────────────┤
│ Tech Flexibility    │ ❌ Locked to 1 stack │ ✅ Per-service stack │
│                     │                     │ choice              │
├─────────────────────┼─────────────────────┼─────────────────────┤
│ Infrastructure Cost │ ✅ Low (1 app,       │ ❌ High (N apps,     │
│                     │ 1 DB, simple ops)   │ N DBs, mesh, tracing│
├─────────────────────┼─────────────────────┼─────────────────────┤
│ Operational         │ ✅ Low complexity    │ ❌ High complexity   │
│ Complexity          │                     │ (requires platform  │
│                     │                     │ team to manage it)  │
├─────────────────────┼─────────────────────┼─────────────────────┤
│ Latency             │ ✅ In-process calls  │ ❌ Network overhead  │
│                     │ (nanoseconds)       │ per service hop     │
│                     │                     │ (5-50ms/hop)        │
├─────────────────────┼─────────────────────┼─────────────────────┤
│ Onboarding          │ ✅ Single repo,      │ ❌ Multiple repos,   │
│ New Engineers       │ one IDE context     │ distributed local   │
│                     │                     │ setup complexity    │
└─────────────────────┴─────────────────────┴─────────────────────┘
```

---

### The Spectrum — From Monolith to Microservices

```
SPECTRUM: Not a binary choice. A progression.

Monolith          Modular           Macro-services    Microservices
(1 codebase,  →   Monolith      →   (2-5 large    →   (8-50+ small
 1 DB)            (bounded           services)         services,
                   modules,          domain-level      sub-domain
                   1 DB)             split)            level split)

WHEN TO MOVE RIGHT on the spectrum:
  Monolith → Modular Monolith:  Always. Do this first. Free performance and clarity
  Modular Monolith → Macro:     Team > 15 engineers. Clear domain boundaries.
                                 Specific module consistently 10× more CPU than others.
  Macro → Micro:                Team > 40 engineers across 5+ domains.
                                 Individual domain teams have conflicting release cadences.
                                 Platform team (SRE) exists to own infrastructure.

MOST COMPANIES SHOULD TARGET: Modular Monolith or 3-5 Macro-services.
  "Monolith-first" approach (Martin Fowler): start simple, refactor to services
  when pain is proven—not prophylactically.
```

---

## SECTION 11 — System Design Interview Discussion

### How Interviewers Probe Architectural Judgment

**What they're really testing:** Can you recognize when microservices are the wrong choice? Do you understand the cost? Will you blindly recommend Netflix-scale architecture for a 5-engineer startup?

---

**Q: "Should we build this with microservices?"**

**Weak answer:** "Yes, microservices give us scalability and fault isolation."
_(This reveals you haven't thought about the cost side.)_

**Strong answer:**

> "That depends on three things: team size, domain separation clarity, and operational maturity.
>
> If the team is under 15 engineers and you don't have dedicated platform/SRE engineering: a well-structured monolith will outship microservices. You want engineers building product, not debugging distributed systems.
>
> If there's a specific scaling bottleneck — for example, a recommendation engine that needs 40 GPU instances while everything else needs 3 — extract THAT into a service. Don't extract everything.
>
> If you're at 30+ engineers with 3+ independent feature teams who are actively blocking each other's releases: now microservices solve a real problem. I'd start with 3-5 services aligned to core domain boundaries, not 15 fine-grained services."

---

**Q: "Design the architecture for an e-commerce platform at 10M users."**

**When to bring up microservices vs monolith:**

```
Frame 1: Start with clarifying questions:
  "What's the team size? 15 engineers or 150?"
  "What are the top 3 scaling concerns — read-heavy catalog? High-write checkout?"
  "Is there a current system we're migrating, or greenfield?"

Frame 2: Propose a pragmatic starting architecture:
  "For a greenfield 15-engineer team, I'd start with a modular monolith:
   separate modules for catalog, checkout, user, payments — same codebase,
   clean interfaces, single DB. This eliminates distributed systems complexity
   while preserving refactoring optionality."

Frame 3: Show you understand when to extract:
  "The catalog module is read-only and can be cached aggressively.
   If it represents 80% of traffic and needs independent scaling,
   I'd extract it to a dedicated catalog service first —
   with a CDN in front and its own read-replica DB."

Frame 4: Acknowledge the distributed systems cost:
  "The checkout flow spans inventory, payment, and orders.
   If these are separate services, I need a Saga pattern for consistency.
   The complexity is justified ONLY if the teams deploying these
   are genuinely independent."
```

---

**Q: "Netflix runs microservices. Why can't we?"**

**Strong reframe:**

> "Netflix runs 1000+ microservices with a 2,000-engineer platform team and their own tooling infrastructure. They also spent 7 years migrating from a monolith and built Netflix OSS (Hystrix, Eureka, Ribbon) along the way. The tooling that makes Netflix's microservices work is itself a product maintained by hundreds of engineers.
>
> The question isn't 'should we copy Netflix?' The question is: 'What architecture matches our team's current capability to operate it?' For a 20-person team, the answer is almost never the Netflix model."

---

## SECTION 12 — Design Exercise

### Exercise: Classify This Architecture

**Scenario:** You join a company as Staff Engineer. The system looks like this:

```
Current state:
  • 12 separately deployed "services" (one per feature area)
  • All 12 services connect to the SAME PostgreSQL database
  • They call each other's APIs synchronously in chains of 4-6 hops
  • Each service has its own CI pipeline but shares the same database schema
  • Engineers say "we're microservices" — but every deploy causes cascading failures
  • Debugging requires reading 6 services' logs to trace one request
  • P95 checkout latency: 2,400ms. Expected: under 400ms.
```

**Think before reading the answers:**

---

**Answer 1: Is this microservices?**

No. This is a **distributed monolith**. The defining characteristic: shared database. All 12 services are coupled at the data layer — the worst kind of coupling. Schema changes break multiple services simultaneously. You have all the operational complexity of microservices (12 deployables, distributed debugging) with none of the benefits (no data isolation, no true independence).

---

**Answer 2: What is causing the P95 2,400ms latency?**

```
Synchronous call chains of 4-6 hops:
  Service A → Service B → Service C → Service D → Service E → DB query

Each hop: 15-50ms.
6 hops × 30ms avg = 180ms in network overhead alone.
Each service doing its own DB query: 6 × 50ms SQL = 300ms.
Serialization, deserialization per hop: 6 × 10ms = 60ms.
Total floor: ~540ms. With retries, lock contention, shared DB hot spots: 2,400ms.

Root cause: synchronous dependency chains with a shared DB = network latency
            compounding on top of database lock contention.
```

---

**Answer 3: What would you fix first?**

```
Priority 1 (week 1-4): Eliminate deep synchronous call chains.
  Identify the checkout path's service dependency graph.
  Add async: instead of Service A calling B calling C in sequence,
  have A write to DB and publish an event. B and C react to events.
  Cut synchronous chain depth to maximum 2 hops.
  Expected impact: P95 drops from 2,400ms → 800ms.

Priority 2 (month 1-3): Separate databases per domain boundary.
  Group the 12 services by domain: Users, Orders, Catalog, Payments.
  Give each domain its own schema (or separate database).
  This is the actual microservices prerequisite.
  This is a 3-6 month migration. Plan data migration carefully.

Priority 3 (month 3-6): Consolidate over-split services where teams are small.
  If 3 "services" are owned by 1 team: merge them back into 1.
  They have zero deployment independence—they're a distributed module.
  "Microservices" that can't be independently deployed by independent teams
  are just complexity with no upside.
```

---

## === Architect's Mental Model ===

### 5 Decision Rules

**Rule 1: Team topology drives service topology — not the other way around.**
If you don't have a team to independently own, deploy, and page-support a service at 3am: you shouldn't have that service. The number of services you can sustainably run = (number of engineering teams × team size) / operational burden per service. Don't design an architecture you can't staff.

**Rule 2: Shared database = monolith. No exceptions.**
Two services sharing a database table are a distributed monolith. They have implicit coupling at the schema level. You cannot call this microservices. The "databases per service" rule is non-negotiable — it is the definition of service independence.

**Rule 3: Extract a service when you have a proven, specific pain — not speculatively.**
Valid reasons to extract: (a) this module needs 10× the CPU of everything else; (b) two teams are blocked on each other's deploys weekly; (c) this module has a different security/compliance boundary that requires isolation. Not a valid reason: "microservices are modern" or "Netflix does it."

**Rule 4: Synchronous call chains of depth > 2 are a design smell.**
Every additional synchronous hop adds latency, failure probability, and debugging complexity. If a checkout flow calls 6 services in sequence: either those don't need to be separate services, or the communication pattern should be event-driven with async composition instead of synchronous chaining.

**Rule 5: Before microservices, build a modular monolith.**
Clean module boundaries within a monolith give you 90% of the organizational benefit of microservices with 10% of the operational cost. Modules with clean interfaces can be extracted to services in weeks when the need arises. Modules with tangled dependencies take months. Start modular. Extract when pain demands it.

---

### 3 Common Mistakes

**Mistake 1: Decomposing by technical layer instead of by domain.**
"Frontend service, API service, Database service" — this is not microservices, it's a tiered monolith distributed across three processes. Every feature change touches all three. Correct decomposition: by business domain ("User service, Order service, Payment service"). Each domain owns its own web layer, business logic, and database.

**Mistake 2: Building microservices without distributed tracing, centralized logging, and circuit breakers from day one.**
These three are not optional features — they are prerequisites. Without tracing: you cannot debug failures across services. Without centralized logging: incident response time triples. Without circuit breakers: one failing service cascades and brings down the entire mesh. Teams that ship microservices without these tools are creating future incidents.

**Mistake 3: Treating microservices as a performance optimization.**
Microservices add latency (network hops), not remove it. The performance benefit is targeted scaling — but that benefit comes at the cost of 5-50ms per inter-service call. If your current monolith is slow: the cause is almost certainly a missing index, an N+1 query, or a bad caching strategy — not the monolithic architecture. Fix the actual bottleneck.

---

### 30-Second Interview Answer

> "A monolith is the right default for teams under 15-20 engineers: single codebase, single database, simple operations, fast feature delivery. I'd build it with clean module boundaries from day one — that's a modular monolith. I'd extract to services only when I have proven pain: a module that legitimately needs 10× more compute than the rest, or two teams actively blocking each other's deploy cadence. The cost of microservices is real — distributed transactions, network latency, operational complexity, required platform engineering — and it only pays off when you have independent teams, proven bottlenecks, and the infrastructure discipline to run it. Most companies should be at 3-5 macro-services aligned to business domains, not 30 fine-grained services they saw on a Netflix blog post in 2015."

---

_End of Topic 01 — Monolith vs Microservices_
_→ Next: Topic 02 — Service Discovery_
