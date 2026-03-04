# Subnets (Public vs Private)

## FILE 03 OF 03 — Design Decisions, SAA Exam Traps, Scenarios & Architect's Mental Model

> **Architect Training Mode** | Senior Principal Architect Perspective
> _Optimized for: design judgement · tradeoff evaluation · failure prediction · production debugging_

---

## SECTION 9 — Certification Focus (AWS SAA-C03)

```
HOW MANY SUBNET TIERS DO YOU NEED?

Two-tier (simple / cost-constrained):
  Public: ALB + NAT GW
  Private: everything else (app + DB together)
  ❌ DB in "private" subnet has NAT route (can reach internet outbound — weaker isolation)
  ✅ Only 2 route tables, simpler to manage
  Use for: non-regulated workloads, prototypes, MVPs

Three-tier (recommended production standard):
  Public: ALB + NAT GW
  Private: Application (ECS, EC2, Lambda)
  DB: Data (RDS, ElastiCache) — no internet route
  ✅ Full network isolation of data layer
  ✅ Compliance-ready (PCI-DSS, SOC 2 often require network segmentation)
  Use for: production systems, regulated industries, anything handling PII or financials

Four-tier (advanced):
  Public: ALB + NAT GW
  DMZ: WAF + API Gateway private endpoints
  Private: Application
  DB: Data
  Use for: highly regulated (banking, healthcare), when WAF/DDoS is a separate compute tier

NUMBER OF AZs:
  Minimum 2 AZs per tier for HA
  Recommended 3 AZs (us-east-1, ap-south-1 have 3+ AZs — use them)
  Why 3: during maintenance, AWS can reduce an AZ to "impaired" — with only 2 AZs,
         you're fully dependent on the remaining 1 during failover

TOTAL SUBNET COUNT (3 AZs, 3 tiers):
  3 public + 3 private + 3 DB = 9 subnets minimum
  This is the production standard starting layout
```

---

## SECTION 10 — Comparison Table

```
RESOURCE         SUBNET TYPE   REASON
─────────────────────────────────────────────────────────────────────
ALB (internet)   Public        Needs internet-reachable IP for inbound
ALB (internal)   Private       Internal services, no internet exposure
NAT Gateway      Public        Needs IGW access for outbound internet
EC2 Bastion      Public        Needs inbound SSH from internet (or use SSM instead)
EC2 App Server   Private       Internet access via NAT, not directly accessible
ECS Fargate      Private       Same as EC2 app server
Lambda (VPC)     Private       VPC resources via local route, internet via NAT
RDS              DB Subnet     No internet route, isolated data tier
ElastiCache      DB Subnet     Same as RDS
OpenSearch       DB Subnet     Same as RDS
EC2 NAT Inst.    Public        Legacy NAT method, replaced by managed NAT GW
VPN Gateway      VPC-level     Not subnet-specific, attached to VPC
Direct Connect   VPC-level     GW resource, not in a subnet
PrivateLink Ep.  Private       Interface endpoint — private subnet ENI
S3 Gateway Ep.   VPC-level     Route-based, not subnet-specific
─────────────────────────────────────────────────────────────────────
```

---

## SECTION 11 — Quick Revision

### Trap 1: "Public Subnet" Definition

```
Exam will test: "Which subnet is a public subnet?"
Do NOT look for: "subnet with public IP assigned to resources"
DO look for: "subnet whose route table has 0.0.0.0/0 → Internet Gateway"

That is the ONLY definition AWS uses. A subnet with a public IP but no IGW route
is NOT a public subnet. A subnet with an IGW route but no resources with public
IPs IS a public subnet (it has the capability for public access even if unused).
```

### Trap 2: AWS Reserved IPs — 5 Not 4

```
/28 subnet: 16 IPs − 5 reserved = 11 usable
/27 subnet: 32 IPs − 5 reserved = 27 usable
/24 subnet: 256 IPs − 5 reserved = 251 usable

The 5 reserved IPs: .0, .1, .2, .3, .255
Common exam question: "How many IP addresses are available in a 10.0.1.0/28 subnet?"
Answer: 11 (NOT 12, NOT 14)

This catches people who subtract 2 (network + broadcast) = 14. Wrong. AWS subtracts 5.
```

### Trap 3: Subnets Cannot Span AZs

```
"A company needs a subnet that spans two AZs for redundancy."
Answer: IMPOSSIBLE. AWS subnets are bounded to ONE AZ.
For redundancy: create identical subnets IN EACH AZ and use multi-AZ services
(ALB, ECS spread, RDS Multi-AZ) that distribute across those subnets.
```

### Trap 4: private subnet vs isolated subnet

```
AWS documentation terminology:
  "Private subnet": has route to NAT Gateway (can reach internet outbound)
  "Isolated subnet" (or "DB subnet"): no internet route at all

  These are NOT the same! Exam may present:
  "Which subnet type should databases be placed in for maximum isolation?"
  Answer: subnet with NO internet route (no 0.0.0.0/0 → anywhere)
  NOT: standard "private" subnet (which has NAT route — still internet connectivity)
```

### Trap 5: Subnet NACL vs Security Group for Allowing Traffic

```
NACLs are STATELESS:
  You open port 443 inbound → response traffic (ephemeral ports 1024-65535)
  needs OUTBOUND rule too.

  Exam trap: NACL has inbound allow 443 but no outbound rule for ephemeral ports
  Result: request enters subnet but response is BLOCKED by NACL outbound

Security Groups are STATEFUL:
  You allow inbound port 443 → response traffic automatically allowed outbound
  No separate outbound rule needed for return traffic

Key rule: NACLs block both directions independently. Security Groups track state.
```

---

## SECTION 12 — Architect Thinking Exercise

```
SCENARIO: Fintech startup, strict compliance, multi-AZ, limited engineering resources

Requirements:
  - PCI DSS compliance: cardholder data environment (CDE) must be network-isolated
  - Two services: payments-api (CDE) and user-api (non-CDE)
  - APIs must not cross-communicate unless explicitly allowed
  - engineers: 4 people, want simplicity
  - 2 AZs (minimum for compliance)

DESIGN:

Option A: Two separate VPCs (maximum isolation)
  VPC-CDE: 10.10.0.0/16 — payments-api only
    Private subnet: 10.10.11.0/24, 10.10.12.0/24 (2 AZs)
    DB subnet: 10.10.21.0/24, 10.10.22.0/24
    Public subnet: 10.10.1.0/24, 10.10.2.0/24 (ALB only)

  VPC-NonCDE: 10.20.0.0/16 — user-api
    Same layout

  VPC Peering: NonCDE → CDE (only for specific service-to-service call)
               Route only for specific private subnet CIDR
               Security Group: allow only port 8080 from user-api SG

  Audit: CDE VPC has separate CloudTrail, VPC Flow Logs, AWS Config
  No cross-environment pollution even in logging

Option B: Single VPC with strict subnet tagging (simpler for 4-person team)
  VPC: 10.10.0.0/16
  CDE private subnet: 10.10.11.0/24 (tagged: Environment=CDE)
  NonCDE private subnet: 10.10.12.0/24 (tagged: Environment=NonCDE)
  CDE DB subnet: 10.10.21.0/24

  Security Group on payments-api: only allow inbound from user-api SG on port 8080
  Security Group on CDE DB: only allow from payments-api SG on port 5432
  NACL on CDE subnets: block all traffic from NonCDE CIDR except 8080

  Simpler for small team. May not satisfy auditors who want VPC-level isolation.

RECOMMENDATION: Option A for actual PCI DSS (auditors check VPC isolation).
                Option B as starting point, migrate to Option A before first audit.
```

---

### Interview Q&A

**Q: "What's the difference between a public and private subnet on AWS?"**

Good answer: "A public subnet has a route in its route table pointing 0.0.0.0/0 to an Internet Gateway, which means resources with public IPs in that subnet can communicate directly with the internet. A private subnet routes outbound traffic through a NAT Gateway, so resources can initiate internet connections but cannot receive inbound from the internet. I add a third tier — what I call a DB subnet — with no internet route at all, routing only within the VPC. That's where databases and caches go. The isolation is enforced entirely through route tables: each tier has its own route table. Security Groups then layer on top for port-level control."

---

## === ARCHITECT'S MENTAL MODEL ===

### 5 Decision Rules for Subnet Design

1. **Three subnet tiers: public, private, DB. Minimum. Non-negotiable for production.** Route tables enforce tier isolation — not Security Groups alone. If DB subnet has 0.0.0.0/0 route, it can reach the internet even if a Security Group blocks inbound. Defense-in-depth requires BOTH route table isolation AND Security Group control.

2. **Subnet size: oversize private, undersize nothing.** Use /20 for private app subnets (4K IPs). ECS Fargate awsvpc mode consumes 1 IP per task. 200 tasks + rolling deploys + Lambda ENIs will exhaust a /24 in months. You can add secondary CIDRs later but it's operationally messy. Get it right on day one.

3. **Per-AZ NAT Gateway with per-AZ route tables. No exceptions.** Private subnet in AZ-a must 0.0.0.0/0 route to NAT GW IN AZ-a. If it crosses AZs to reach NAT GW, you pay cross-AZ transfer AND create an AZ dependency. Verify this with `describe-route-tables` + `describe-nat-gateways` cross-check.

4. **"Public subnet" is about the route table, not about assigned public IPs.** The definition is: has 0.0.0.0/0 → IGW. Resources don't automatically get public IPs unless auto-assign is enabled. Disable auto-assign public IP on all subnets. Assign Elastic IPs only to what explicitly needs to be internet-reachable (NAT GW, Bastion).

5. **Monitor AvailableIPAddressCount for every subnet. Alert before it hits zero.** IP exhaustion causes silent failures — ECS tasks can't start, Lambda can't create ENI, no error message explains why. Set CloudWatch alarms at 50 IPs remaining. Act at 100.

### 3 Common Mistakes

1. **One route table for all subnets.** The moment you apply a route table with 0.0.0.0/0 → IGW to your DB subnet, your databases have an internet route. Every engineer with access to the route table can accidentally (or maliciously) add a route that destroys your security posture. Separate route tables per tier is mandatory.

2. **/24 subnets for app tier.** 251 usable IPs sounds like a lot until you have 150 ECS tasks, rolling deploys doubling tasks temporarily, Lambda ENIs, and future growth. /20 for app subnets costs nothing — IP addresses in a subnet are free.

3. **Treating "private subnet" as equivalent to "no internet access."** A private subnet has NAT Gateway internet access. Only a DB/isolated subnet (no 0.0.0.0/0 route) has no internet access. When compliance requires "no internet access from the data tier," that means no NAT route, not just "put it in the private subnet."

### 1 Clear Interview Answer (30 Seconds)

> "I design subnets in three tiers: public for internet-facing load balancers and NAT Gateways, private for application workloads with outbound internet via NAT, and a DB tier with no internet route at all. Each tier has its own route table — that's what enforces the isolation. I use /24 for public and DB tiers and /20 for private app subnets to avoid IP exhaustion as ECS tasks scale. One NAT Gateway per AZ maps to each AZ's private route table. And I keep auto-assign public IP disabled on all subnets — only explicitly assigned Elastic IPs land on resources that need internet exposure."

---

_End of Subnets (Public vs Private) 3-File Series_
