# VPC (Virtual Private Cloud)

## FILE 03 OF 03 — Design Decisions, SAA Exam Traps, Scenarios & Architect's Mental Model

> **Architect Training Mode** | Senior Principal Architect Perspective
> _Optimized for: design judgement · tradeoff evaluation · failure prediction · production debugging_

---

## SECTION 9 — Certification Focus (AWS SAA-C03)

```
HOW MANY VPCs DO YOU NEED?

Single VPC (simple):
  ✅ Single product team
  ✅ All environments (prod/staging/dev) separated by subnet tagging
  ❌ No environment isolation — a dev experiment can DDoS production
  ❌ Security blast radius: compromised dev instance can reach prod DB
  Use: small teams, MVPs, internal tools

Per-Environment VPC (recommended for most teams):
  Prod VPC, Staging VPC, Dev VPC (separate accounts ideally)
  ✅ Full blast radius containment
  ✅ IAM permission boundaries at account level
  ✅ Compliance: audit prod independently
  ❌ VPC Peering or Transit Gateway needed for shared services
  Use: standard production setup for companies > 20 engineers

Multi-Account + Multi-VPC (enterprise):
  AWS Organizations: each team/product gets own account
  Each account has its own VPCs
  Shared services VPC connected via Transit Gateway
  ✅ Maximum isolation, blast radius = one team
  ✅ Cost attribution per team/product
  ✅ Regulatory compliance per environment
  ❌ Complexity: TGW, centralized DNS, cross-account IAM
  Use: regulated industries (fintech, healthcare), large organizations

CIDR SIZING RULES:
  VPC: /16 minimum (65K IPs — subnets will subdivide this)
  Public subnets: /24 (251 IPs — ALB ENIs, NAT GW — small footprint needed)
  Private subnets: /20 (4K IPs — ECS, EC2, Lambda ENIs — needs room to grow)
  DB subnets: /24 (251 IPs — RDS instances, ElastiCache nodes — small count)

  Subnet count: 1 public + 1 private + 1 DB per AZ × 3 AZs = 9 subnets minimum
```

---

## SECTION 10 — Comparison Table

```
SCENARIO → SOLUTION

Connect two internal teams' VPCs (same region):
  → VPC Peering (simple, low cost, no bandwidth limit hardware)
  → Transit Gateway if > 5 VPCs or if transitive routing needed

Connect on-premises to AWS:
  < 1 Gbps, variable workload, getting started:
    → Site-to-Site VPN ($36/month + $0.05/GB)
  > 1 Gbps, consistent high throughput, latency-sensitive:
    → AWS Direct Connect (4-12 week provisioning, $0.03/GB)
  Both (for HA — VPN as failover for Direct Connect):
    → Direct Connect + VPN backup

Expose one specific service to another VPC or account:
  → AWS PrivateLink (Interface VPC Endpoint)
  → Only that service is reachable, not the entire VPC

Lambda accessing AWS services (S3, DynamoDB) inside a VPC:
  → VPC Gateway Endpoint for S3/DynamoDB (FREE, no data transfer charges)
  → Interface Endpoint for other services (e.g., SSM, Secrets Manager)
  → Avoid: Lambda → private subnet → NAT GW → internet → AWS service = expensive

Lambda to RDS (must be VPC):
  → Lambda in same VPC, same private subnet tier, Security Group allows 5432
  → RDS Proxy in front of RDS to manage connection pool exhaustion
    (Lambda cold starts create connection spikes — RDS Proxy absorbs this)
```

---

## SECTION 11 — Quick Revision

### Trap 1: VPC Peering is NOT Transitive

```
Setup: VPC-A ↔ VPC-B (peered), VPC-B ↔ VPC-C (peered)
Question: "Can VPC-A reach VPC-C via VPC-B?"
Answer: NO. VPC Peering is not transitive.

To enable A↔C: create a THIRD peering connection directly between A and C.
At scale: use Transit Gateway for hub-and-spoke transitivity.

Exam trap: AWS shows all 3 VPCs connected through B and asks if A can reach C.
Correct answer: no direct route unless A↔C peering exists or TGW used.
```

### Trap 2: Security Groups vs NACLs in VPC Peering

```
When traffic crosses a VPC Peering connection:
  The DESTINATION VPC's Security Groups and NACLs evaluate the traffic.
  The source VPC's controls are irrelevant at the destination.

Exam trap: "Traffic from VPC-A passes the source Security Group.
            Will it reach the instance in VPC-B?"
Answer: Only if VPC-B's Security Group allows inbound from VPC-A's CIDR
        AND VPC-B's NACL allows the traffic (both inbound AND outbound,
        since NACLs are stateless — return traffic needs explicit outbound rule).
```

### Trap 3: 5 IPs Reserved per Subnet (Not 4)

```
Common mistake: thinking AWS reserves 4 IPs (broadcast + 3 management)
Actual: AWS reserves 5 IPs per subnet:
  .0   → Network address
  .1   → VPC router (your default gateway)
  .2   → AWS DNS (Route 53 Resolver)
  .3   → Reserved for future AWS use
  .255 → Broadcast (not used in VPC but reserved)

Impact: /28 subnet = 16 IPs − 5 = 11 usable
        Exam loves to test: "how many IPs are available in a /28 subnet?" → 11
```

### Trap 4: Internet Gateway vs NAT Gateway

```
Internet Gateway:
  Attached to VPC (regional resource)
  Allows BOTH inbound internet → public subnet AND outbound from public subnet
  Does NOT provide internet access to private subnets
  EC2 in public subnet needs: IGW attached to VPC + public IP or EIP + route 0.0.0.0/0 → IGW

NAT Gateway:
  Lives in PUBLIC subnet (needs to reach IGW for outbound)
  Allows ONLY outbound from private subnet → internet
  Blocks ALL inbound from internet (stateful — only allows response traffic)
  Route: private subnet → NAT GW → IGW → internet

Exam trap: "Which service allows EC2 instances in a private subnet to download updates
            from the internet while remaining unreachable from outside?"
Answer: NAT Gateway (NOT Internet Gateway — IGW would make them public)
```

### Trap 5: VPC Endpoints Do Not Require NAT Gateway

```
Scenario: Lambda in private subnet needs to access S3.
Without endpoint: Lambda → private subnet → NAT GW → internet → S3 (paid, slow)
With S3 Gateway Endpoint: Lambda → private subnet → VPC Endpoint → S3 (FREE)

Gateway Endpoints (FREE): S3, DynamoDB (only two)
Interface Endpoints ($0.01/hour each): all other AWS services (SSM, SQS, SNS, etc.)

Exam trap: "Most cost-effective way to allow EC2 in private subnet to access S3
            without internet connectivity?"
Answer: VPC Gateway Endpoint for S3 (FREE, no NAT required)
NOT: NAT Gateway (works but costs money and routes through internet)
```

---

## SECTION 12 — Architect Thinking Exercise

```
SCENARIO: Multi-tenant SaaS platform, single AWS account, 3 environments

Requirements:
  - Production must be isolated from development (dev cannot reach prod DB)
  - Shared authentication service (used by prod and staging)
  - On-premises LDAP synchronization required
  - 2 AWS regions: ap-south-1 (primary), ap-southeast-1 (DR)
  - Budget-conscious: minimize Transit Gateway costs

DESIGN:

OPTION A: 3 VPCs + VPC Peering (recommended for this scale)
  Prod VPC:     10.10.0.0/16 in ap-south-1
  Staging VPC:  10.20.0.0/16 in ap-south-1
  Shared VPC:   10.30.0.0/16 in ap-south-1 (auth service lives here)

  Peerings:
    Prod    ↔ Shared (for auth service access)
    Staging ↔ Shared (for auth service access)
    Prod    ↗ Staging (NO — intentional isolation, no peering)

  Route tables updated with /16 routes for each peering.
  Security Groups: allow only 8080 (auth service port) from prod/staging CIDR.
  NO full VPC opening — only auth service ENI is reachable.

On-Premises Connection:
  Site-to-Site VPN → Prod VPC VPN Gateway
  LDAP sync only needs Shared VPC → route LDAP traffic via Prod VPC's VGW
  (OR: Direct Connect if > 1 Gbps needed)

DR Region (ap-southeast-1):
  Mirror of Prod VPC: 10.40.0.0/16 (different CIDR to avoid overlap if peered)
  RDS cross-region replication → ap-southeast-1 read replica
  Route 53 health check + failover policy

WHY NOT TRANSIT GATEWAY?
  $36/month per VPC attachment = $108/month for 3 VPCs
  VPC Peering: data transfer in same region $0.01/GB (similar cost, simpler)
  TGW justified at > 6 VPCs or when transitive routing required
```

---

### Interview Q&A

**Q: "Walk me through designing a VPC for a production application."**

Good answer: "I start with CIDR planning — I use a /16 block that doesn't conflict with on-premises and allocate non-overlapping ranges for prod, staging, and dev. Inside the VPC, I layer three subnet tiers per AZ: public (ALB and NAT Gateway), private (application tier), and DB (data tier with no internet route). I keep separate route tables per tier so private and DB subnets can never accidentally get an internet route. For outbound from private subnets, I deploy one NAT Gateway per AZ — not one shared — to avoid both the single-AZ dependency and connection table exhaustion. I always enable VPC DNS resolution and DNS hostnames so RDS endpoints resolve to private IPs. And I enable VPC Flow Logs to S3 from day one for security forensics."

---

## === ARCHITECT'S MENTAL MODEL ===

### 5 Decision Rules for VPC Design

1. **Subnet tiers = security zones. Route tables enforce isolation.** Three tiers minimum: public (internet-facing), private (application), DB (data — no internet route ever). Each tier has its own route table. A DB subnet that accidentally gets a 0.0.0.0/0 route is a breach waiting to happen. Route table separation is your most important security control in a VPC.

2. **One NAT Gateway per AZ is not optional for production.** A single NAT Gateway is a single-AZ dependency AND a connection table bottleneck. It's $32/month per AZ — the cheapest HA investment in AWS. Any "multi-AZ" architecture with a single NAT Gateway is not actually multi-AZ for outbound traffic.

3. **Plan your CIDR before you start. You cannot undo it.** VPC primary CIDR is permanent. If you run out of IPs or create conflicts with on-premises, you rebuild. Use /16 for VPC, /20 for application subnets, /24 for small tiers. Leave room in your allocation scheme for peered VPCs and on-premises networks.

4. **Use VPC Gateway Endpoints for S3 and DynamoDB. Free routing path.** Every EC2 or Lambda call to S3 that goes through NAT Gateway costs $0.045/GB in NAT processing fees. Gateway Endpoints are free and route traffic within the AWS backbone. This is one of the most overlooked cost optimizations in AWS.

5. **VPC Peering is not transitive. Transit Gateway is.** At 5 or fewer VPCs where you need specific connections, peering is cheaper and simpler. At 6+ VPCs or when transitivity is needed, Transit Gateway is worth the $36/month per attachment. Know your scale before choosing.

### 3 Common Mistakes

1. **Using the Default VPC in production.** The default VPC has all subnets public, Internet Gateway attached, and auto-assigned public IPs. Teams who skip VPC setup launch RDS or ElastiCache into a public network and wonder why they fail security audits. Default VPC is for demos and experiments only.

2. **Forgetting to update route tables after creating VPC Peering.** VPC Peering status "Active" means the handshake was accepted — it does NOT mean traffic flows. Both sides need explicit routes added. Most "VPC Peering doesn't work" tickets are simply missing route table entries.

3. **Blocking DNS by disabling `enable_dns_hostnames` or `enable_dns_support`.** Both must be true for RDS, ECS, and other AWS resource DNS names to resolve to private IPs within your VPC. Without this, DNS resolves to public IPs, traffic leaves the VPC, Security Groups reject it, and you get mysterious connection failures with no clear error message.

### 1 Clear Interview Answer (30 Seconds)

> "A VPC is your isolated virtual network within an AWS Region. I design them with three subnet tiers per AZ — public for internet-facing load balancers, private for application servers, and a DB tier with no internet route. Each tier has a separate route table: public subnets route to the Internet Gateway, private subnets route to a per-AZ NAT Gateway, DB subnets route locally only. I enable DNS resolution and hostnames so resource endpoints resolve to private IPs. VPC Flow Logs go to S3 from day one for security. And I use VPC Gateway Endpoints for S3 and DynamoDB to eliminate unnecessary NAT Gateway data transfer costs."

---

_End of VPC (Virtual Private Cloud) 3-File Series_
