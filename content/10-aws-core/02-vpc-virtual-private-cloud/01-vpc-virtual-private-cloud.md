# VPC (Virtual Private Cloud)

## FILE 01 OF 03 — Core Concepts, Architecture, Components & Cost

> **Architect Training Mode** | Senior Principal Architect Perspective
> _Optimized for: design judgement · tradeoff evaluation · failure prediction · production debugging_

---

## SECTION 1 — Intuition (Explain Like a 12-Year-Old)

```
BEFORE VPC (Physical Network Reality):
  Your data center:
    Physical switches → VLANs → firewall appliances → routers
    BGP peering to ISP for internet
    MPLS circuits for office-to-DC connectivity
    Manual VLAN provisioning: raise a ticket → 2-week wait
    Firewall rules: managed by a dedicated network team
    ACL changes: change management window, nights and weekends only

  Problems:
    ├── Overprovisioned (buy $200K router for peak that never comes)
    ├── Human error (typo in firewall rule = breach or outage)
    ├── No isolation between teams (finance app shares network with dev app)
    └── DR network: duplicate hardware sitting idle in second site

WITH VPC (Software-Defined Networking):
  Virtual switch: defined in CIDR block notation
  Virtual firewall: Security Groups (stateful) + Network ACLs (stateless)
  Virtual router: Route Tables (each subnet gets one)
  Internet edge: Internet Gateway (managed, no hardware)
  Private exit: NAT Gateway (managed, AZ-scoped)
  Connectivity: VPC Peering, Transit Gateway, VPN, PrivateLink

  Provisioning: API call → instant
  Isolation: each VPC is hermetically sealed by default
  Cost: no upfront hardware, pay per data transfer and managed components

COMPARISON TABLE:
  Physical               → VPC Equivalent
  ─────────────────────────────────────────────────────────
  Data center            → VPC (CIDR block = your IP space)
  VLAN                   → Subnet (AZ-scoped)
  Firewall appliance     → Security Group + NACL
  Core router            → Route Table
  Internet edge router   → Internet Gateway
  NAT appliance          → NAT Gateway
  MPLS / leased line     → VPN Gateway / Direct Connect
  DMZ segment            → Public Subnet
  Internal segment       → Private Subnet
  VLAN peering           → VPC Peering / Transit Gateway
```

---

## SECTION 2 — Core Technical Explanation

```
VPC = Virtual Private Cloud
  Your isolated, logically separate network within an AWS Region
  CIDR block: IPv4 address range you own within this VPC
    Example: 10.0.0.0/16 → 65,536 IP addresses

  Key properties:
    ├── Region-scoped (VPC spans entire region, NOT one AZ)
    ├── AZ-scoped subnets (subnets live in one AZ)
    ├── Fully private by default (no internet access until you add IGW)
    ├── Multiple VPCs per account per region (default limit: 5, soft limit)
    └── Default VPC: AWS creates one per region per account automatically

DEFAULT VPC vs CUSTOM VPC:
  Default VPC:
    CIDR: 172.31.0.0/16
    Has subnets in every AZ (created automatically)
    Has Internet Gateway attached (all subnets are public by default)
    Purpose: quick experiments, non-production prototyping
    NEVER use default VPC for production: no isolation design, all public

  Custom VPC:
    You choose CIDR (plan carefully — cannot change later without rebuild)
    You design subnet structure (public/private, multi-AZ)
    You control routing, IGW, NAT, security layers
    Production systems: always custom VPC

CIDR PLANNING (do this before you start):
  /16: 65,536 addresses (large VPC — good for enterprise)
  /20: 4,096 addresses (medium VPC — good for single product)
  /24: 256 addresses (small — good for individual microservice or test)

  Rule: pick a range that doesn't overlap with:
    ├── Your on-premises network (if you'll use VPN/Direct Connect)
    ├── Other VPCs in your organization (if you'll use VPC Peering)
    └── Partner networks (if you'll have VPC Peering with vendors)

  Common mistake: use 10.0.0.0/16 for everything → conflicts everywhere
  Better practice: use a CIDR allocation plan
    Production: 10.10.0.0/16
    Staging:    10.20.0.0/16
    Dev:        10.30.0.0/16
    On-prem:    192.168.0.0/16 (different range entirely)
```

---

## SECTION 3 — Architecture Diagram (MANDATORY)

```
REGION: ap-south-1
VPC: 10.10.0.0/16
│
├── INTERNET GATEWAY (igw-xxxx)
│     "Front door to the internet — attached to VPC, created separately"
│
├── AVAILABILITY ZONE: ap-south-1a
│   ├── Public Subnet: 10.10.1.0/24
│   │     Route Table:  0.0.0.0/0 → igw-xxxx  (internet access)
│   │                   10.10.0.0/16 → local  (VPC-internal)
│   │     Resources: ALB node, NAT Gateway
│   │
│   ├── Private Subnet: 10.10.11.0/24
│   │     Route Table:  0.0.0.0/0 → nat-gw-az-a  (outbound internet via NAT)
│   │                   10.10.0.0/16 → local
│   │     Resources: ECS tasks, EC2 app servers
│   │
│   └── DB Subnet: 10.10.21.0/24
│         Route Table:  10.10.0.0/16 → local  (NO internet route — fully isolated)
│         Resources: RDS primary instance
│
├── AVAILABILITY ZONE: ap-south-1b
│   ├── Public Subnet: 10.10.2.0/24
│   │     Route Table:  0.0.0.0/0 → igw-xxxx
│   │     Resources: ALB node, NAT Gateway
│   │
│   ├── Private Subnet: 10.10.12.0/24
│   │     Route Table:  0.0.0.0/0 → nat-gw-az-b
│   │     Resources: ECS tasks, EC2 app servers
│   │
│   └── DB Subnet: 10.10.22.0/24
│         Route Table:  10.10.0.0/16 → local
│         Resources: RDS Multi-AZ standby
│
└── AVAILABILITY ZONE: ap-south-1c
    ├── Public Subnet: 10.10.3.0/24
    ├── Private Subnet: 10.10.13.0/24
    └── DB Subnet: 10.10.23.0/24
          (empty, reserved for future scale or ElastiCache replica)

VPC COMPONENTS MAP:
  Internet Gateway: 1 per VPC (attached, not AZ-scoped)
  NAT Gateway: 1 per AZ (AZ-scoped — critical for HA)
  Route Tables: separate per subnet tier (public, private, db)
  Security Groups: virtual firewalls on ENI level
  Network ACLs: subnet-level stateless firewall
  VPC Flow Logs: captures IP traffic — goes to CloudWatch or S3
```

---

## SECTION 4 — Request Flow (MANDATORY FLOWCHART)

```
Step-by-step request path:

  1. User request: https://api.myapp.com → DNS lookup → Route 53
  2. Route 53: returns ALB DNS endpoint IP (in ap-south-1)
  3. Internet: TCP connection established to ALB IP

  4. Internet Gateway (igw-xxxx):
     - Traffic enters VPC through IGW
     - IGW performs NAT: translates internet IP → ALB private IP
     - Routes to ALB node in Public Subnet 10.10.1.0/24

  5. ALB (Application Load Balancer) in Public Subnet:
     - Receives HTTPS request (terminates TLS here with ACM cert)
     - Evaluates listener rules (path, host-based routing)
     - Target group lookup: picks ECS target in Private Subnet

  6. ALB → ECS Task (Private Subnet 10.10.11.0/24):
     - ALB to ECS: private IP within VPC (cross-AZ if needed, $0.02/GB)
     - Security Group on ECS task: must allow inbound from ALB's SG
     - ECS task processes request

  7. ECS Task → RDS (DB Subnet 10.10.21.0/24):
     - Private subnet → DB subnet (same VPC, route table: local)
     - Security Group on RDS: allows inbound 5432 from ECS task's SG
     - Never expose DB subnet to internet (no 0.0.0.0/0 route)

  8. Outbound from ECS → external API (Stripe, etc.):
     - ECS task → Private Subnet → Route Table: 0.0.0.0/0 → NAT GW
     - NAT GW (in Public Subnet) → Internet Gateway → Internet
     - Source IP seen by Stripe: NAT Gateway Elastic IP
```

---

### VPC Connectivity Options

```
1. VPC PEERING
   Connect two VPCs (same account or cross-account, same or cross-region)
   Traffic: private, stays on AWS backbone
   NOT transitive: if A↔B and B↔C, A cannot reach C via B
   Use: connecting prod VPC to shared-services VPC
   Problem at scale: N VPCs = N(N-1)/2 peering connections = unwieldy

2. TRANSIT GATEWAY (TGW)
   Hub-and-spoke model: all VPCs attach to TGW
   Transitive routing: A→TGW→C works
   Cost: $0.05/hour per attachment + $0.02/GB data processed
   Use: enterprises with 10+ VPCs, multi-account organizations

3. VPN GATEWAY (VGW)
   IPSec tunnel between AWS VPC and your on-premises network
   Performance: ~1.25 Gbps per tunnel (two tunnels for HA)
   Latency: internet-based → variable (not for low-latency requirements)
   Cost: $0.05/hour + $0.05/GB
   Use: hybrid cloud, office connectivity, initial migration

4. DIRECT CONNECT
   Dedicated fiber from your DC to AWS (via colocation facility)
   Performance: 1Gbps or 10Gbps, consistent, low-latency
   Cost: $0.03/GB transfer (vs $0.09/GB internet) — BUT port hours add up
   Lead time: 4-12 weeks to provision physical circuit
   Use: high-throughput hybrid workloads, financial services, large data pipelines

5. AWS PRIVATELINK
   Expose your service to other VPCs via private endpoint
   Traffic: never crosses internet, stays on AWS network
   Use: multi-tenant SaaS products, shared services
   Better than VPC Peering when: you want to expose ONE service, not open the whole VPC
```

---

### Common Misconfigurations

```
MISCONFIGURATION 1: Overlapping CIDR Blocks
  Problem: VPC A: 10.0.0.0/16, VPC B: 10.0.0.0/20 (subset of A)
  Result: you cannot create VPC Peering between A and B
           you cannot connect A to on-prem if on-prem uses 10.x.x.x
  Prevention: CIDR allocation plan before creating any VPC

MISCONFIGURATION 2: Single Route Table for All Subnets
  Problem: public subnet and private subnet share same route table
           → private subnet accidentally gets 0.0.0.0/0 → IGW route
           → DB instances get public internet route
  Result: DB becomes internet-accessible (security failure)
  Fix: separate route table per subnet tier (public / private / db)

MISCONFIGURATION 3: Using Default VPC in Production
  Problem: default VPC has all subnets public, no network segmentation
           resources launched here are internet-routable by default
  Result: RDS, ElastiCache, other services accidentally exposed
  Fix: always create custom VPC with proper subnet design for production

MISCONFIGURATION 4: Not Enabling VPC Flow Logs
  Problem: no visibility into traffic patterns, no forensics capability
           when security incident occurs or connectivity issue arises
  Fix: enable VPC Flow Logs → CloudWatch Logs or S3
       set retention to 90 days minimum
       use Athena to query S3 flow logs for large-scale analysis
  Cost: ~$0.50/GB for CloudWatch ingestion (can be significant — sample if needed)

MISCONFIGURATION 5: CIDR block too small
  Problem: VPC CIDR /24 = 256 IPs → minus AWS reserved = 251 usable
           ECS + RDS + NAT + ALB ENIs exhaust addresses quickly
           AWS reserves 5 IPs per subnet (cannot change)
  Fix: plan generously (prefer /16 for production), you can ADD secondary CIDR later
       but cannot REMOVE or CHANGE primary CIDR
```

---

### Cost Model

```
VPC ITSELF: FREE
  Creating a VPC, subnets, route tables, security groups → $0

PAID COMPONENTS WITHIN VPC:

  NAT Gateway:
    $0.045/hour = ~$32/month per NAT GW
    $0.045/GB data processed
    (1 NAT GW per AZ for HA = $64/month for 2 AZs)

  VPC Peering:
    Data transfer in same region: $0.01/GB
    Cross-region: $0.02/GB + regional data transfer rates

  Transit Gateway:
    Attachment: $0.05/hour per VPC attachment (~$36/month per VPC)
    Data processing: $0.02/GB

  VPN Gateway:
    Connection: $0.05/hour (~$36/month)
    Data transfer: $0.05/GB

  Direct Connect:
    Port hours: $0.03–$0.30/hour depending on speed
    1Gbps dedicated: ~$216/month (port only, add cross-connect fees)
    Data transfer: $0.02–$0.03/GB (cheaper than internet)

  VPC Flow Logs:
    CloudWatch ingestion: ~$0.50/GB
    S3 delivery: ~$0.02/GB storage (much cheaper, use Athena for queries)

  AWS PrivateLink (Interface Endpoint):
    $0.01/hour per endpoint per AZ (~$7/month for 1 AZ)
    $0.01/GB data processed

COST OPTIMIZATION TIPS:
  ├── Use S3/DynamoDB Gateway Endpoints (FREE — no data transfer to NAT GW for S3)
  ├── Place Lambda in VPC only if it needs VPC resources (avoid unnecessary ENI creation)
  ├── VPC Flow Logs → S3 (not CloudWatch) for high-volume environments
  └── Check NAT GW data: EC2 calling S3 via NAT = expensive. Use S3 Gateway Endpoint instead.
```
