# AWS Global Infrastructure (Regions & Availability Zones)

## FILE 01 OF 03 — Physical Infrastructure Replaced, Architecture Position & Core Concepts

> **Architect Training Mode** | Senior Principal Architect Perspective
> _Optimized for: design judgement · tradeoff evaluation · failure prediction · production debugging_

---

## SECTION 1 — Intuition (Explain Like a 12-Year-Old)

### Before Cloud: The Single Data Center Model

Pre-cloud enterprise architecture (2000s):

- **One primary data center**: company-owned or collocated in a third-party facility
- **One DR site**: geographically separate (often 50–100 miles away) — manually maintained, rarely tested
- **BGP/MPLS leased lines**: private WAN links between primary and DR — $5,000–$50,000/month
- **Hardware procurement**: buying servers took 6–12 weeks — capacity planning was a guessing game
- **Disaster recovery**: typically RTO of 24–72 hours (how long to restore service), RPO of 4–8 hours (data loss window)

**The failure mode that destroyed companies:**

```
[Single Data Center]
        │
   Power outage?    → entire company offline
   Fiber cut?       → entire company offline
   Hurricane/flood? → entire company offline, possibly permanently

Examples:
  9/11 data center outages: dozens of financial firms lost primary DC permanently
  Hurricane Sandy (2012): flooded data centers in lower Manhattan → 60+ hours of outage
  Ice storm (2021, Texas): entire data centers went cold → AWS customers NOT affected
                           On-prem customers in Texas data centers: offline for days
```

**What AWS Regions + AZs replace:**

| Legacy Architecture                    | AWS Equivalent                                   |
| -------------------------------------- | ------------------------------------------------ |
| Primary data center                    | Availability Zone (AZ-a)                         |
| DR data center                         | Availability Zone (AZ-b, AZ-c)                   |
| BGP leased line between sites          | AWS backbone network (inter-AZ link, < 2ms)      |
| DR failover: manual, 24–72 hours       | Multi-AZ ECS service: automatic, < 60 seconds    |
| Physical DR test: risky, expensive     | Can test failover anytime (no hardware risk)     |
| Geographic expansion: 12-month project | Deploy to new AWS region: hours                  |
| Single point of failure: power/cooling | AZs use independent power, cooling, and networks |

---

## SECTION 2 — Core Technical Explanation

### The Three-Layer AWS Infrastructure Model

```
GLOBAL
══════════════════════════════════════════════════════════
  AWS Global Network (backbone)
    Ultra-low latency fiber connecting all regions
    Your traffic stays on AWS backbone, NOT public internet
    (S3 Transfer Acceleration, CloudFront, Global Accelerator use this)

  CloudFront PoPs (Points of Presence) — 400+ globally
    CDN edge nodes, NOT full regions
    Serve cached content, terminate TLS near users
    NOT where you deploy applications
══════════════════════════════════════════════════════════

REGION LEVEL (e.g., ap-south-1 = Mumbai)
══════════════════════════════════════════════════════════
  A region = a geographic location with:
    ├── 3+ Availability Zones (AZs)
    ├── Region-scoped services: IAM, Route 53, CloudFront (actually global)
    ├── Region-scoped data stores: S3 buckets, DynamoDB tables
    └── Region control plane: all API calls go here

  Data sovereignty: data at rest in a region does NOT leave that region
                    unless you explicitly replicate it
══════════════════════════════════════════════════════════

AVAILABILITY ZONE LEVEL (e.g., ap-south-1a, ap-south-1b, ap-south-1c)
══════════════════════════════════════════════════════════
  An AZ = one or more physical data centers
    Physically separate: different buildings, different city blocks
    Independent power: separate utility substations, backup generators
    Independent cooling: no shared HVAC systems
    Independent network: separate upstream ISP connections
    Connected: via redundant fiber to other AZs in region (< 2ms latency)

  AZ name-to-ID quirk (CRITICAL for exam):
    Your account: ap-south-1a = physical data center #2 (randomized per account)
    Other account: ap-south-1a = physical data center #1 (different physical facility!)

    Use AZ ID (not AZ name) for cross-account coordination:
    ap-south-1a (your account) → aps1-az1 (AZ ID — stable across accounts)
══════════════════════════════════════════════════════════
```

---

## SECTION 3 — Architecture Diagram (MANDATORY)

```
REGION: ap-south-1 (Mumbai)
═══════════════════════════════════════════════════════════════════════

  ┌─────────────────────────────────────────────────────────────────┐
  │                        VPC (10.0.0.0/16)                       │
  │                                                                 │
  │  ┌─────────────────────┐    ┌─────────────────────┐            │
  │  │  AZ: ap-south-1a    │    │  AZ: ap-south-1b    │            │
  │  │                     │    │                     │            │
  │  │ ┌─────────────────┐ │    │ ┌─────────────────┐ │            │
  │  │ │ Public Subnet   │ │    │ │ Public Subnet   │ │            │
  │  │ │ 10.0.1.0/24     │ │    │ │ 10.0.2.0/24     │ │            │
  │  │ │                 │ │    │ │                 │ │            │
  │  │ │  [NAT Gateway]  │ │    │ │  [NAT Gateway]  │ │            │
  │  │ └─────────────────┘ │    │ └─────────────────┘ │            │
  │  │                     │    │                     │            │
  │  │ ┌─────────────────┐ │    │ ┌─────────────────┐ │            │
  │  │ │ Private Subnet  │ │    │ │ Private Subnet  │ │            │
  │  │ │ 10.0.3.0/24     │ │    │ │ 10.0.4.0/24     │ │            │
  │  │ │                 │ │    │ │                 │ │            │
  │  │ │ [ECS Task A-1]  │ │    │ │ [ECS Task B-1]  │ │            │
  │  │ │ [ECS Task A-2]  │ │    │ │ [ECS Task B-2]  │ │            │
  │  │ └─────────────────┘ │    │ └─────────────────┘ │            │
  │  │                     │    │                     │            │
  │  │ ┌─────────────────┐ │    │ ┌─────────────────┐ │            │
  │  │ │ DB Subnet       │ │    │ │ DB Subnet       │ │            │
  │  │ │ 10.0.5.0/24     │ │    │ │ 10.0.6.0/24     │ │            │
  │  │ │                 │ │    │ │                 │ │            │
  │  │ │ [RDS Primary]   │ │◄──►│ │ [RDS Standby]   │ │            │
  │  │ │                 │ │sync│ │ (Multi-AZ)      │ │            │
  │  │ └─────────────────┘ │    │ └─────────────────┘ │            │
  │  └─────────────────────┘    └─────────────────────┘            │
  │                                                                 │
  │  [ALB] ← spans both AZs, distributes to both sets of ECS tasks │
  └─────────────────────────────────────────────────────────────────┘

  ALB → ECS A-1, A-2 (in AZ-a), ECS B-1, B-2 (in AZ-b)
  RDS: primary in AZ-a, synchronous standby in AZ-b
  NAT Gateway: one per AZ (if AZ-a fails, tasks in AZ-a use AZ-a NAT; AZ-b tasks use AZ-b NAT)

  AZ-a power outage scenario:
    ECS A-1, A-2: unreachable → ALB health check fails → ALB stops routing to them
    ECS B-1, B-2: still serving 100% of traffic (they were already active)
    RDS: primary fails → automatic failover to standby in AZ-b → ~60-120 seconds reconnect
    NAT-a: offline → tasks in AZ-b use NAT-b (their dedicated NAT, unaffected)
    ALB: still operational (ALB nodes in AZ-b continue serving)
    Result: brief DB reconnect pause, then full service from AZ-b alone
```

---

## SECTION 4 — Request Flow (MANDATORY FLOWCHART)

```
SCENARIO: Global SaaS with users in India and USA

User in Mumbai (India)           User in New York (USA)
        │                                 │
        │ DNS lookup: myapp.com           │ DNS lookup: myapp.com
        ▼                                 ▼
[Route 53 Latency Routing]       [Route 53 Latency Routing]
  → ap-south-1 ALB                  → us-east-1 ALB
        │                                 │
        ▼                                 ▼
[ALB: ap-south-1]                [ALB: us-east-1]
  Distributes across:              Distributes across:
  ap-south-1a ECS tasks            us-east-1a ECS tasks
  ap-south-1b ECS tasks            us-east-1b ECS tasks
        │                                 │
        ▼                                 ▼
[RDS Mumbai ap-south-1]          [RDS Virginia us-east-1]
    primary + standby                primary + standby
        │                                 │
        └──────────────┬──────────────────┘
                       │ (DynamoDB Global Tables: bi-directional replication)
                       │ (or Aurora Global Database: primary writes → 5 region replicas)
              [Shared global data layer for user sessions, product catalog]

KEY PRINCIPLE: Requests stay within the region they enter.
  Mumbai user data stays in ap-south-1 → GDPR/data residency friendly.
  Circuit breaker: if ap-south-1 degrades, Route 53 health check detects
  → Route 53 routes Mumbai users to us-east-1 (cross-region failover)
  → latency increases (300ms instead of 30ms) but service is available
```

---

### Security: The AZ and Region Trust Boundary

```
AZ-LEVEL SECURITY:
  AZs share the same VPC — subnet routing, NACLs, and Security Groups apply across AZ boundaries
  An EC2 in AZ-a and EC2 in AZ-b in the same VPC/subnet can talk freely

  Best practice: subnet-level isolation per AZ
    ├── public-subnet-a + public-subnet-b (ALB nodes)
    ├── private-subnet-a + private-subnet-b (app layer)
    └── db-subnet-a + db-subnet-b (data layer)

  Security Groups: source can be another Security Group (AZ-agnostic)
    → "Allow port 5432 from rds-client-sg" works regardless of which AZ the connection comes from

REGION-LEVEL SECURITY (data residency):
  IAM: global service — same roles/policies apply in all regions
  S3 bucket: region-scoped — data does NOT leave the region
  RDS: region-scoped — backups stay in the same region
  KMS keys: region-scoped — a KMS key in ap-south-1 CANNOT decrypt data encrypted in us-east-1

  CRITICAL: if you replicate S3 or RDS to another region, you are moving data across regions
            → check data sovereignty laws (GDPR, India PDPB, etc.)

BETWEEN-REGION SECURITY:
  Traffic between regions: always traverses AWS backbone (not public internet)
  UNLESS you use public endpoints for cross-region calls (e.g., calling ap-south-1 API from us-east-1 EC2)

  IAM permissions can scope actions to specific regions:
    "Condition": {"StringEquals": {"aws:RequestedRegion": "ap-south-1"}}
    → Prevents IAM user from launching EC2 in unapproved regions (cost control + compliance)

  AWS Organizations SCP (Service Control Policy):
    Limit all accounts to specific regions
    "Effect": "Deny", "Action": "*", "Condition": region NOT IN approved_list
    → Common in financial services with strict data residency requirements
```

---

### Common Misconfigurations

### Misconfiguration 1: Single-AZ Deployment Disguised as Multi-AZ

```
The deceptive setup:
  Engineer creates:
    - ALB (spans multiple AZs — correct)
    - ECS service with tasks in BOTH AZ-a and AZ-b — looks correct
    - Single NAT Gateway in AZ-a only

  What happens on AZ-a failure:
    - ALB routes to AZ-b tasks ✅
    - AZ-b tasks try to reach the internet (e.g., call external API)
    - NAT Gateway is in AZ-a — offline ❌
    - All outbound internet calls from AZ-b tasks fail
    - 500 errors for all operations needing external API access

  Rule: EVERY component in your stack needs multi-AZ coverage.
        1 NAT Gateway = 1 AZ = NOT multi-AZ for outbound traffic.
        1 NAT Gateway per AZ costs ~$32/month each. Non-negotiable for HA.
```

### Misconfiguration 2: RDS "Multi-AZ" Not Enabled

```
RDS instance: deployed in ap-south-1a (single-AZ)
  Dev said: "Multi-AZ is ON — I checked the checkbox"

  Actually: When restoring from snapshot or creating a new instance,
            "Multi-AZ" option defaults to NO in console
            Terraform: multi_az = false by default

  Result: RDS primary in ap-south-1a
          ap-south-1a has hardware failure at 3 AM
          RDS unreachable
          No standby to fail over to
          DB restore from backup: 30–90 minutes depending on DB size

  Verify: aws rds describe-db-instances \
            --query 'DBInstances[*].[DBInstanceIdentifier,MultiAZ]'
```

### Misconfiguration 3: Assuming AZ Names Are Consistent Across Accounts

```
Team A (AWS account 111):
  ap-south-1a → Physical facility: data center #2

Team B (AWS account 222):
  ap-south-1a → Physical facility: data center #1

Problem:
  Teams coordinate: "we're in the same AZ for latency"
  Reality: they're in DIFFERENT physical data centers by AZ name

  Fix: use AZ ID (not AZ name) for cross-account coordination
  aws ec2 describe-availability-zones --query 'AvailabilityZones[*].[ZoneName,ZoneId]'
  # ap-south-1a  →  aps1-az1
  # ap-south-1b  →  aps1-az2
  # ap-south-1c  →  aps1-az3

  Coordinate using aps1-az1, aps1-az2 — these map to the same physical facility across accounts
```

---

### Cost Implications

### The Multi-AZ Cost Model

```
Cost component: Data transfer

WITHIN AN AZ: FREE
  EC2 → RDS (same AZ) = $0
  EC2 → ElastiCache (same AZ) = $0

BETWEEN AZs (within same region): $0.01/GB each way ($0.02/GB round trip)
  Example: 10 TB/month cross-AZ data transfer = $200/month
  Your ECS tasks in AZ-a → RDS primary in AZ-b = cross-AZ charges apply

BETWEEN REGIONS: $0.02–$0.09/GB (varies by region pair)
  ap-south-1 → us-east-1: $0.086/GB
  Example: 10 TB/month cross-region = $860+/month

Cost-aware architecture decisions:
  ├── Place ECS and RDS primary in same AZ when possible
  │   → WRONG: if AZ-a fails, ECS tasks in AZ-a AND RDS primary are both gone
  │   → Debatable: cost optimization vs blast radius alignment
  │
  ├── For read replicas: place in different AZ, accept small cross-AZ transfer cost
  │
  └── For cross-region replication (Aurora Global Table, DynamoDB Global Tables):
        data transfer cost + replication storage cost
        evaluate: is this cheaper than recovery time if region goes down?

Hidden cost: NAT Gateway
  $0.045/GB data processed through NAT Gateway
  Each request your ECS task makes outbound: charged
  Large data pipelines through NAT: significant cost
  Fix: use VPC endpoints for AWS services (S3, DynamoDB) — bypasses NAT, cheaper
```

---

## KEY TAKEAWAYS — FILE 01

- A **Region** is a geographic area. An **AZ** is an isolated physical data center (or cluster of DCs) within a region. AZs are the building blocks of high availability.
- **AZ name ≠ same physical facility across accounts.** Always use AZ IDs (e.g., `aps1-az1`) when coordinating across AWS accounts.
- **Multi-AZ = redundancy at every layer.** ALB + multi-AZ ✅, but single NAT Gateway = single AZ for outbound traffic = not truly multi-AZ.
- **Cross-AZ data transfer costs money** ($0.02/GB round trip). Architect data flows to minimize unnecessary cross-AZ traffic, particularly for high-throughput services.
- **Data residency**: data at rest in a region stays there unless you explicitly replicate it. KMS keys are region-scoped — cannot decrypt across regions.

---

_Continue to File 02 → Region failure incidents, AZ outage debugging, partial failure patterns & production war stories_
