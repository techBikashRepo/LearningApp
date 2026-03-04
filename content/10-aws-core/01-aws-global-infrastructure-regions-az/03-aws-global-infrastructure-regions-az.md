# AWS Global Infrastructure (Regions & Availability Zones)

## FILE 03 OF 03 — Multi-Region Design, Cost, SAA Exam Traps, Scenario Exercise & Architect's Mental Model

> **Architect Training Mode** | Senior Principal Architect Perspective
> _Optimized for: design judgement · tradeoff evaluation · failure prediction · production debugging_

---

## SECTION 9 — Certification Focus (AWS SAA-C03)

```
MULTI-AZ
  Protects against: single data center failure (hardware, power, network)
  Recovery: automatic, < 5 minutes
  Data residency: all data stays in one region
  Cost: moderate (cross-AZ data transfer + redundant NAT GW)
  Complexity: low-medium (ECS spread + RDS Multi-AZ + multi-AZ NAT)

  Use when: you need high availability, data must stay in one country/region,
            standard enterprise SLA (99.9% → 99.99%)

MULTI-REGION (Active-Active)
  Protects against: entire region failure (rare), data residency requirements across geographies
  Recovery: automatic traffic failover (Route 53) + data sync
  Data: replicated across regions (DynamoDB Global Tables, Aurora Global Database)
  Cost: high (cross-region data transfer + duplicate infrastructure + replication)
  Complexity: high (data consistency, conflict resolution, deployment pipelines for 2+ regions)

  Use when:
    ├── Global user base (users in Asia AND USA AND Europe — latency matters)
    ├── Regulatory: data must be in specific countries (EU data in Frankfurt, US data in Virginia)
    ├── SLA requirements: 99.999% uptime (five nines — regional outages would break this)
    └── Business: "we cannot afford a regional AWS outage to affect our service"

MULTI-REGION (Active-Passive / Pilot Light / Warm Standby)
  Primary region: full stack running
  Secondary region: DR only (some infra pre-deployed, some turned off)

  Pilot Light: core DB replicated to DR, app tier shut down
    Recovery: start app tier in DR, point DNS → 15-30 minute RTO

  Warm Standby: scaled-down full stack in DR
    Recovery: scale up DR stack, point DNS → 5-10 minute RTO

  Use when: company policy requires DR, but full active-active cost is unjustifiable
            Internal systems, B2B tools where 15-30 min RTO is acceptable
```

---

## SECTION 10 — Comparison Table

```
AS OF 2024:
  Regions:          34 launched (34 available to general customers)
  AZs:              108 AZs across all regions
  Edge Locations:   400+ (CloudFront PoPs — NOT regions, do NOT run applications here)
  Local Zones:      33 (AWS infrastructure placed closer to metro areas — for latency < 10ms)
  Wavelength Zones: Telco partner locations (for ultra-low latency mobile applications)
  Outposts:         AWS hardware installed in YOUR data center (hybrid cloud)

KEY GOTCHA: Edge Locations vs Regions
  Edge Locations: CloudFront CDN nodes
    Purpose: serve cached content closer to users
    Cannot run: EC2, RDS, ECS, Lambda *deployments*
    Can run: Lambda@Edge (per-request compute within CloudFront pipeline only)

  Region: where you deploy your application
    Has: EC2, RDS, ECS, Lambda, every AWS service
    Has: 3+ AZs

  Exam trap: "reduce latency for global users → deploy to more edge locations"
  Correct: deploy to more REGIONS (not edge locations — edge is cache/CDN only)

Local Zones:
  Example: us-east-1 is the region, us-east-1-bos-1a is Boston Local Zone
  Extends the parent region's VPC
  Lower latency to Boston metro users (< 10ms vs 80ms to N.Virginia)
  NOT all AWS services available (subset: EC2, EBS, ELB, RDS)
  Use case: video rendering, gaming, live media production requiring < 10ms
  Cost: EC2 in Local Zone is more expensive than parent region
```

---

## SECTION 11 — Quick Revision

```
MULTI-AZ COST MODEL (ap-south-1, typical production web app)
─────────────────────────────────────────────────────────────────
Component                           Monthly Cost
─────────────────────────────────────────────────────────────────
NAT Gateway (1 per AZ, 2 AZs)      2 × $32 = $64
NAT Gateway data processing         ~$10/TB ($0.045/GB × ~222GB)
RDS Multi-AZ vs Single-AZ          Multi-AZ = 2× instance cost
  e.g., db.t3.medium Single: $55   Multi-AZ: $110 (+$55/month)
Cross-AZ data transfer             $0.02/GB round trip (workload dependent)
Additional ECS tasks (spare AZ)    Charged only for running tasks
─────────────────────────────────────────────────────────────────
Typical overhead for Multi-AZ:     $100–$300/month depending on traffic
─────────────────────────────────────────────────────────────────

MULTI-REGION COST MODEL (active-active, ap-south-1 + us-east-1)
─────────────────────────────────────────────────────────────────
Duplicate full stack                2× all compute + DB costs
Cross-region data transfer          $0.086/GB (ap-south-1 ↔ us-east-1)
DynamoDB Global Tables replication  $0.175/million replicated writes
Aurora Global DB replication        $0.20/million replicated I/O
Route 53 health checks             $0.50-$0.75/check/month + query cost
─────────────────────────────────────────────────────────────────
Typical overhead for Multi-Region:  2–3× total infrastructure cost
─────────────────────────────────────────────────────────────────

DECISION HEURISTIC:
  Revenue loss per minute of downtime > Multi-AZ overhead/month?
  → Multi-AZ is justified (almost always yes for production systems)

  Revenue from global users in secondary region > 2× infrastructure cost?
  → Multi-Region active-active may be justified

  Contractual SLA requires 99.99%+ SLA?
  → Multi-AZ minimum. 99.999% → Multi-Region required.
```

---

## SECTION 12 — Architect Thinking Exercise

```
1. MVP / EARLY STAGE STARTUP
   Multi-region adds: 2× infra cost, deployment pipeline complexity,
                      data consistency challenge, team maintenance burden
   Risk: you over-engineer before product-market fit
   Use: single-region multi-AZ instead
   Exception: if your first major customer is a multinational with data residency requirements

2. WHEN YOUR USERS AREN'T GLOBAL
   Most startups: users in one country
   Multi-region latency benefit: irrelevant if all users are in India
   Use: single-region with good CDN (CloudFront for static assets)
   Revisit: when you genuinely expand to other geographies

3. WHEN YOUR DB WRITES ARE NOT IDEMPOTENT / CONFLICT-SAFE
   Active-active multi-region requires: write conflict resolution
   DynamoDB Global Tables: last-write-wins (may lose data in partition)
   Aurora Global: only one primary write region (active-passive, not truly active-active writes)
   If your data model doesn't tolerate conflicts: stick to single primary region

4. WHEN THE TEAM DOESN'T HAVE MULTI-REGION OPERATIONAL EXPERIENCE
   Multi-region failure modes are complex:
   Split-brain scenarios, partial replication lag, region-specific bugs
   Ops complexity: deploy to 2 regions, monitor 2 regions, incident response in 2 regions
   Cost: not just infrastructure, but team time and expertise

5. WHEN RTO/RPO REQUIREMENTS DON'T JUSTIFY IT
   Your business: internal tool, 100 users, 24-hour RTO acceptable
   Multi-region for this = massive over-engineering
   Match recovery requirements to business requirements, not engineering anxiety
```

---

### AWS SAA Exam Traps

### Trap 1: "Highly Available" vs "Fault Tolerant"

```
Exam will present scenarios; you must distinguish:

Highly Available (HA):
  Service remains available with minimal interruption
  Brief downtime IS acceptable (< 5 minutes for AZ failover)
  RDS Multi-AZ: 60-120 second failover = HA, not fault tolerant

Fault Tolerant:
  Service continues with ZERO interruption (zero downtime)
  Achieved through: active redundancy, no single point of failure
  Much more expensive and complex
  Example: multi-reader RDS Cluster (Aurora) where reads never fail
           because there are always healthy read replicas

Exam trap:
  "A company needs highly available web application" → Multi-AZ ECS + RDS Multi-AZ
  "Application requires zero recovery time for database failure" → Aurora Multi-AZ with writer failover + reader connections unaffected, or Aurora Global Database
```

### Trap 2: AZ Capacity Reservation and Local Zones

```
Exam question:
  "Company needs to reduce latency to under 10ms for users in a specific metro area
   that is 500km from the nearest AWS Region. What architecture?"

Answer: AWS Local Zones
  Local Zone places AWS compute in that metro area
  EC2, EBS, VPC extend to Local Zone
  Application data fetched from parent region but rendered locally

  NOT: adding another full region (no partial region in that city)
  NOT: CloudFront (can cache static content but can't run application logic)
  NOT: Wavelength Zone (that's for 5G carrier networks, not general metro latency)
```

### Trap 3: Data Replication vs Data Backup

```
Exam question:
  "Company needs RDS database to survive a full region failure with no data loss."

Trap answer: Enable automated backups (backups are region-local)
Real answer: Aurora Global Database (cross-region replication, RPO < 1 second)

  Automated backups: stored in S3 IN THE SAME REGION
    If region is unavailable: you can't access the backup
    RPO: depends on backup frequency (up to 5 minutes for automated)
    RTO: restore = new instance creation (30-90 minutes for large DBs)

  Aurora Global Database:
    Replicates to secondary regions with < 1 second RPO
    Secondary region has read-only replica — promote to primary in < 1 minute
    RPO: seconds. RTO: < 1 minute.

  Cross-region backup copy (for backups, not HA):
    You CAN copy RDS snapshots to another region
    But: that's asynchronous (lag = time since last snapshot) + restore takes time
    Use for: compliance requirement to have DR copy of backups
             NOT for: real-time RPO requirements
```

### Trap 4: Region-Scoped vs Global Services

```
Exam frequently tests: which services are global vs region-scoped?

GLOBAL (one instance, shared across all regions):
  ✅ IAM (users, roles, policies)
  ✅ Route 53
  ✅ CloudFront (though edge locations are distributed)
  ✅ AWS Organizations
  ✅ AWS WAF (when attached to CloudFront — global)

REGION-SCOPED (separate instance per region):
  ✅ EC2, ECS, EKS, Lambda
  ✅ RDS, DynamoDB, ElastiCache
  ✅ S3 (buckets are regional, though namespace is global)
  ✅ VPC, Subnets, Security Groups
  ✅ KMS keys
  ✅ ACM certificates (EXCEPT CloudFront requires us-east-1)
  ✅ CloudWatch metrics and alarms
  ✅ AWS WAF when attached to ALB (regional WAF)

Exam trap: "create IAM role in eu-west-1 for GDPR" → WRONG, IAM is global
           IAM role created once, used everywhere
           Data residency is controlled at the resource level (S3 bucket region, RDS region)
           NOT by IAM configuration
```

### Trap 5: AZ Names Are Account-Specific

```
Exam question (indirect):
  "Two teams in different AWS accounts need to place resources in the same
   physical AZ for low-latency communication. Both teams select ap-south-1a.
   Will they be in the same physical location?"

Answer: NOT NECESSARILY. AZ names (ap-south-1a) are mapped to physical facilities
        differently per account. They may or may not be in the same physical location.

        Use AZ ID (aps1-az1) which maps consistently to the same physical facility
        across all accounts in the same region.

        To find AZ IDs:
        aws ec2 describe-availability-zones --region ap-south-1 \
          --query 'AvailabilityZones[*].[ZoneName,ZoneId]'
```

### Trap 6: EC2 Reserved Instances Are AZ or Region-Scoped

```
Exam question:
  "Company purchases EC2 Reserved Instance for ap-south-1a.
   An instance runs in ap-south-1b due to capacity issues. Does RI discount apply?"

Answer: NO — AZ-scoped RIs apply only in that AZ
        Regional RIs (scope = Region) apply to any AZ in the region

        AZ-scoped RI: discount + capacity reservation in that specific AZ
        Regional RI: discount only, no capacity reservation, applies across all AZs in region

        For flexibility: Regional RI (no capacity guarantee but discount anywhere in region)
        For guaranteed capacity launch: AZ-scoped RI (must run IN that AZ to get discount)
```

---

### Scenario Design Exercise

### Scenario: Global Fintech SaaS with Data Residency and HA Requirements

**Problem Statement:**

You are the AWS architect for an India-headquartered fintech SaaS company:

- Primary customers: India, Southeast Asia
- New contract: EU customers (GDPR requires EU data stays in EU)
- Upcoming: US market expansion
- SLA requirement: 99.99% availability
- DB workload: PostgreSQL, 10,000 transactions/minute, financial transactions must not be lost (RPO = 0 in same region)
- Team: 6 engineers, moderate AWS experience
- Budget: limited — only spend what delivers clear value

**Design the infrastructure layout: Regions, AZs, and data architecture.**

**Solution:**

```
PHASE 1: India launch (current — build this first)
  Region: ap-south-1 (Mumbai)
  AZs: ap-south-1a, ap-south-1b (multi-AZ)

  Stack:
    ALB (multi-AZ): spans both AZs
    ECS Fargate: spread placement strategy → 50/50 across AZ-a and AZ-b
    RDS Aurora PostgreSQL: Multi-AZ (writer in AZ-a, reader in AZ-b)
      Aurora chosen over RDS PostgreSQL: faster failover (< 30 seconds vs 60-120 seconds)
    ElastiCache (Redis): Multi-AZ cluster mode enabled
    NAT Gateway: one per AZ (critical — see NAT misconfiguration pattern)

  Data residency: India financial data stays in ap-south-1 ✅

PHASE 2: EU market (add this when first EU customer signs)
  New region: eu-central-1 (Frankfurt, Germany — preferred for GDPR strict jurisdictions)
  AZs: eu-central-1a, eu-central-1b

  Separate full stack in eu-central-1:
    Same architecture replica as ap-south-1
    EU customer data: ONLY written to eu-central-1
    NO cross-region data replication for PII (GDPR compliance)

  Routing:
    Route 53 Geolocation policy:
    EU users → eu-central-1 ALB
    Asia users → ap-south-1 ALB

  Shared non-PII data (e.g., product catalog, pricing):
    DynamoDB Global Tables: eu-central-1 ↔ ap-south-1 replicated
    Application: reads from local region (low latency), writes auto-replicated

PHASE 3: US expansion
  New region: us-east-1 (N. Virginia)
  Same replica architecture
  Route 53: North America → us-east-1

DOES THIS MEET 99.99% SLA?
  Each region: multi-AZ = ~99.99% within a region
  Full region failure: users in that region degraded (cross-region failover not configured here)

  If 99.99 includes cross-region: add Route 53 health checks + failover routing
    India primary fails → Route 53 routes India users to us-east-1 (degraded UX, latency)
    Known tradeoff: data residency vs availability during regional event
    For fintech: data residency is non-negotiable → document as "regional failover not available
                                                      to maintain compliance, users see service unavailable"
                                                      this is an accepted business decision

TEAM SIZING NOTE:
  6 engineers → start with just ap-south-1 multi-AZ
  Add regions only when business requires it
  Each region multiplies your deployment, monitoring, and incident response burden
  Don't pre-build for Day 2 until Day 1 is stable
```

---

### Interview Q&A

**Q: "Explain the difference between an AWS Region and an Availability Zone."**

Good answer: "A Region is a geographic area like ap-south-1 in Mumbai — it's a collection of 3 or more Availability Zones, provides the control plane for all regional services, and data stays within the region unless explicitly replicated. An AZ is the physical redundancy unit — it's one or more isolated data centers within the region with independent power, cooling, and networking, connected to other AZs via low-latency fiber. You design for AZ failure (it happens) but design plans for regional failure (it's rare and much more expensive to handle)."

**Q: "When would you go multi-region vs. just multi-AZ?"**

Good answer: "Multi-AZ solves data center failure — automatic, < 5 minutes, within one geography. I'd start there for almost any production system. Multi-Region solves two different problems: global latency for international users, and regional-level AWS events for extreme availability requirements. The trigger points are: users in multiple geographies who need sub-100ms latency, regulatory data residency across countries, or contractual 99.999% SLA requirements. Multi-Region adds 2× cost and significant operational complexity — I'd only justify it when one of those specific drivers is present."

---

## === ARCHITECT'S MENTAL MODEL ===

### 5 Decision Rules for AWS Global Infrastructure

1. **Multi-AZ is the baseline. Not a premium.** Any production service handling real users or revenue must be multi-AZ. The cost premium ($100–300/month for NAT + RDS Multi-AZ overhead) is trivially small against the revenue impact of a single data center outage. The question is never "do we need multi-AZ?" — it's "are ALL components in our stack multi-AZ?"

2. **Single NAT Gateway = Single AZ = NOT multi-AZ for outbound traffic.** The most common multi-AZ theater: ECS tasks across both AZs, but one NAT Gateway. AZ fails → NAT fails → all outbound internet from that AZ goes down. One NAT Gateway per AZ is mandatory for genuine HA. At $32/month each, this is one of the cheapest reliability investments.

3. **Check AZ spread for every stateful component independently.** ECS being spread across AZs doesn't protect you if your cache (ElastiCache), message queue (SQS is regional ✅, but MSK Kafka broker nodes are AZ-specific), or any dependency is single-AZ. Map your entire request path and verify AZ redundancy at every hop.

4. **Multi-Region solves a different problem than Multi-AZ.** Multi-AZ = hardware failure protection. Multi-Region = geography + extreme availability. Don't go multi-region because you're "worried about AWS being down." AWS regional events are rare and usually service-specific. Go multi-region when users are genuinely global, data must reside in specific countries, or your SLA is 99.999%.

5. **Use AZ IDs (aps1-az1), not AZ names (ap-south-1a), for cross-account coordination.** AZ names are mapped to different physical facilities per AWS account (to distribute load evenly). AZ IDs are stable and map to the same physical location across all accounts. When coordinating with partners or second accounts, AZ IDs are the only reliable reference.

### 3 Common Mistakes

1. **Forgetting that RDS Multi-AZ is not the default.** Console, CLI, and Terraform all default to single-AZ for RDS. It's a separate checkbox or `multi_az = true` flag. Teams discover this mistake when the primary fails at 3 AM and there's no standby to fail over to. Automate an AWS Config rule: `required-tag multi-az = true` on all production RDS instances.

2. **Treating "highly available" and "fault tolerant" as synonyms.** Multi-AZ RDS has 60–120s failover — that's HA (brief interruption acceptable). Aurora writer failover is 30s — still not zero. "Fault tolerant" means zero-interruption, which requires active-active read with Aurora multi-region or DynamoDB. Design to the actual business requirement, not the aspirational one.

3. **Deploying multi-region before resolving write conflict strategy.** The hardest problem in multi-region is not infrastructure — it's data writes. DynamoDB Global Tables uses last-write-wins, which can silently lose data in a partition event. Aurora Global Database has only one primary write region (single region for writes, others are read). Teams go multi-region without deciding their consistency model, hit a partition event, and discover data loss.

### 1 Clear Interview Answer (30 Seconds)

> "AWS Regions are geographic locations, each containing 3 or more Availability Zones — isolated data centers with independent power, cooling, and networking connected by low-latency fiber. For production systems, multi-AZ is the minimum: I distribute compute with ECS spread strategy, use RDS Multi-AZ, and deploy one NAT Gateway per AZ — that last one is what most 'multi-AZ' architectures get wrong. Multi-region is a different tier: it solves global latency for international users and meets extreme SLA requirements, but it doubles infrastructure cost, requires a data consistency strategy for writes, and multiplies operational complexity. I go multi-region when users are in multiple geographies, data residency laws require it, or the SLA is 99.999%."

---

_End of AWS Global Infrastructure (Regions & AZ) 3-File Series_
