# Subnets (Public vs Private)

## FILE 01 OF 03 — Core Concepts, Architecture, Components & Cost

> **Architect Training Mode** | Senior Principal Architect Perspective
> _Optimized for: design judgement · tradeoff evaluation · failure prediction · production debugging_

---

## SECTION 1 — Intuition (Explain Like a 12-Year-Old)

```
PHYSICAL NETWORK EQUIVALENT:
  Subnet     → VLAN (Virtual LAN) segment
  Public subnet → DMZ (Demilitarized Zone) — internet-facing segment
  Private subnet → Internal LAN — application server segment
  DB subnet   → Secure internal segment — data segment, no external access

  Physical DMZ:
    Internet → Firewall → DMZ (web servers, load balancers)
    DMZ → Internal Firewall → App LAN (app servers)
    App LAN → DB Firewall → DB Segment (database servers)

    Three physical firewalls, physical switches, physical VLANs
    Change management: 1-2 week lead time per VLAN change

  AWS Subnet Equivalent:
    Same three-tier design
    Route tables (not firewalls) enforce the tier separation
    Security Groups + NACLs provide the access control
    Provisioned instantly via API

SUBNET = IP ADDRESS RANGE within a VPC, scoped to ONE AZ:
  VPC: 10.10.0.0/16 (spans entire region)
  Subnet: 10.10.1.0/24 (lives in ap-south-1a ONLY)
  One subnet cannot span multiple AZs
  Multiple subnets can exist in the same AZ
```

---

## SECTION 2 — Core Technical Explanation

```
THE MYTH: "Public subnet = EC2 has a public IP"
THE TRUTH: "Public subnet = the subnet has a route to an Internet Gateway"

A subnet is PUBLIC if its route table contains: 0.0.0.0/0 → igw-xxxx
A subnet is PRIVATE if its route table has NO route to an Internet Gateway

WHAT MAKES AN EC2 INSTANCE IN A PUBLIC SUBNET "INTERNET-REACHABLE":
  1. Subnet is public (route table → IGW) ✅
  2. EC2 has a public IP or Elastic IP assigned ✅
  3. Security Group allows inbound on desired port ✅
  All three required. Missing any one = not reachable from internet.

WHAT HAPPENS IN EACH SUBNET TYPE:

Public Subnet (10.10.1.0/24 in ap-south-1a):
  Route table:
    10.10.0.0/16 → local (VPC traffic stays local)
    0.0.0.0/0    → igw-xxxx (everything else goes to internet)
  You put here:
    ├── ALB nodes (need internet inbound)
    ├── NAT Gateway (needs internet outbound, itself needs public subnet)
    ├── Bastion Host / Jump Box (SSH access from office)
    └── EC2 with public IP (if directly internet-facing — unusual for production)
  You NEVER put here:
    ├── Application servers (they should be private)
    ├── Databases (must be private)
    └── Cache servers (must be private)

Private Subnet (10.10.11.0/24 in ap-south-1a):
  Route table:
    10.10.0.0/16 → local
    0.0.0.0/0    → nat-gw-xxxx (outbound internet via NAT)
  You put here:
    ├── ECS/EKS pods and tasks
    ├── EC2 application servers
    ├── Lambda functions (when VPC access needed)
    └── Internal load balancers (ALB with scheme: internal)
  Cannot receive inbound from internet (NAT blocks inbound, only allows response)

DB Subnet (10.10.21.0/24 in ap-south-1a):
  Route table:
    10.10.0.0/16 → local ONLY (no 0.0.0.0/0 route at all)
  You put here:
    ├── RDS instances
    ├── ElastiCache clusters
    └── OpenSearch domains
  Principle: if the DB tier has no internet route, even a fully compromised application server
             cannot exfiltrate data to the internet from the DB layer
```

---

## SECTION 3 — Architecture Diagram (MANDATORY)

```
VPC: 10.10.0.0/16
Region: ap-south-1
─────────────────────────────────────────────────────────────────────────────

AZ: ap-south-1a                   AZ: ap-south-1b                   AZ: ap-south-1c
─────────────────────           ─────────────────────           ─────────────────────

[PUBLIC SUBNET]                 [PUBLIC SUBNET]                 [PUBLIC SUBNET]
10.10.1.0/24                   10.10.2.0/24                   10.10.3.0/24
RT: 0.0.0.0/0 → IGW            RT: 0.0.0.0/0 → IGW            RT: 0.0.0.0/0 → IGW
  ┌───────────────┐               ┌───────────────┐               ┌───────────────┐
  │  ALB Node     │               │  ALB Node     │               │  ALB Node     │
  │  NAT-GW-AZ-A  │               │  NAT-GW-AZ-B  │               │  NAT-GW-AZ-C  │
  └───────────────┘               └───────────────┘               └───────────────┘
           ↕ ALB routes                   ↕ ALB routes                   ↕ ALB routes
[PRIVATE SUBNET]                [PRIVATE SUBNET]                [PRIVATE SUBNET]
10.10.11.0/24                  10.10.12.0/24                  10.10.13.0/24
RT: 0.0.0.0/0 → NAT-GW-AZ-A   RT: 0.0.0.0/0 → NAT-GW-AZ-B   RT: 0.0.0.0/0 → NAT-GW-AZ-C
  ┌───────────────┐               ┌───────────────┐               ┌───────────────┐
  │ ECS Task 1,2  │               │ ECS Task 3,4  │               │ ECS Task 5,6  │
  └───────────────┘               └───────────────┘               └───────────────┘
           ↕ DB calls                     ↕ DB calls                     ↕ DB calls
[DB SUBNET]                     [DB SUBNET]                     [DB SUBNET]
10.10.21.0/24                  10.10.22.0/24                  10.10.23.0/24
RT: 10.10.0.0/16 → local ONLY  RT: 10.10.0.0/16 → local ONLY  RT: 10.10.0.0/16 → local ONLY
  ┌───────────────┐               ┌───────────────┐               ┌───────────────┐
  │ RDS Primary   │               │ RDS Standby   │               │ (reserved)    │
  └───────────────┘               └───────────────┘               └───────────────┘

─────────────────────────────────────────────────────────────────────────────
INTERNET GATEWAY (spans all AZs — VPC-level resource)
─────────────────────────────────────────────────────────────────────────────

SUBNET CIDR ALLOCATION STRATEGY:
  /24 for public (251 IPs — ALB ENIs + NAT GW — small footprint)
  /20 for private (4,091 IPs — ECS tasks can be 100s-1000s)
  /24 for DB (251 IPs — usually < 20 DB endpoints per AZ)
  Reserve: /20 blocks for future expansion in secondary CIDR
```

---

## SECTION 4 — Request Flow (MANDATORY FLOWCHART)

```
TWO LAYERS OF CONTROL ON SUBNETS:

1. ROUTE TABLE (what traffic is routable):
   Determines WHERE packets CAN go (routing decision)
   No route = packet silently dropped
   Public subnet: can route to internet (0.0.0.0/0 → IGW)
   Private subnet: can route to internet via NAT only (0.0.0.0/0 → NAT GW)
   DB subnet: can only route within VPC (no external route)

2. NETWORK ACL (what traffic is allowed at subnet boundary):
   Stateless packet filter applied at the subnet edge
   Separate inbound and outbound rules (must allow BOTH directions for stateful connections)
   Numbered rules: lower number evaluated first, first match wins
   Default NACL: allow all inbound and outbound (permissive)

   Layer interaction:
   Route table evaluated FIRST → NACLs evaluated → Security Groups evaluated
   If route table drops the packet: NACLs and SGs never see it

WHAT CANNOT BE DONE AT SUBNET LEVEL:
  ├── Subnets cannot block traffic to specific IPs within the same subnet
      (Security Group or instance-level filtering handles intra-subnet)
  ├── Subnet route tables cannot override AWS internal routing for the VPC local CIDR
      (local routes are always present and cannot be deleted)
  └── NACLs cannot inspect packet contents (application layer) — use WAF + ALB for that
```

---

### Auto-Assign Public IP Setting

```
SUBNET-LEVEL SETTING: "Auto-assign public IPv4 address"

When ENABLED (default for public subnets in default VPC):
  Every EC2 launched in this subnet gets a public IP automatically
  Dangerous: if you accidentally launch DB here, it gets a public IP

When DISABLED (correct for production):
  No auto-public IP. Explicit Elastic IP must be assigned if needed.
  Production standard: disable on ALL subnets, assign Elastic IPs only where needed

IMPLICATION: A "public subnet" by route table definition with auto-assign DISABLED:
  → EC2 launched here has NO public IP, cannot receive inbound from internet
  → But it CAN reach internet (via IGW route in route table + NAT)
  Wait — that's not quite right. EC2 (not behind NAT) needs public IP to reach internet via IGW.
  EC2 without public IP in public subnet: can't use IGW (IGW needs public IP for 1:1 NAT)

PRACTICAL RULE:
  Public subnet: auto-assign public IP = DISABLED
                 Only NAT Gateway and ALB go here (they get EIP automatically)
  Private subnet: auto-assign = DISABLED (no public IP ever — route through NAT)
  DB subnet: auto-assign = DISABLED (no public IP ever)

  Manual Elastic IP assignment: only for long-lived infra like NAT GW, Bastion Host
```

---

### Common Subnet Misconfigurations

```
MISCONFIGURATION 1: All Subnets Share One Route Table (single route table)
  Problem: public subnet route accidentally applied to private/DB subnets
  Result: DB instances get a route to the internet
  Fix: explicit route table per tier. Minimum 3 route tables (public, private, db).

MISCONFIGURATION 2: Private Subnet Routes to NAT Gateway in Different AZ
  Setup: ap-south-1a private subnet RTB: 0.0.0.0/0 → nat-gw in ap-south-1b
  Problem: cross-AZ data transfer charges ($0.02/GB) + if ap-south-1b NAT fails, ap-south-1a outbound dies
  Fix: each AZ's private subnet routes to its own AZ's NAT Gateway

MISCONFIGURATION 3: Subnet CIDR Too Small for ECS Fargate
  ECS Fargate (awsvpc mode): each task gets a separate ENI and private IP
  /24 subnet = 251 IPs. 200 ECS tasks + 51 other ENIs → exhausted
  New task launches fail silently with "no available IPs" error
  Fix: use /20 for private subnets (4,091 IPs). Monitor AvailableIpAddressCount.

MISCONFIGURATION 4: DB Subnet Accidentally Has Internet Route
  Someone adds "0.0.0.0/0 → NAT GW" to DB subnet route table for "debugging"
  Now DB subnet can reach the internet (outbound) — malware, data exfiltration risk
  Fix: DB subnet route table should ONLY contain the local VPC route
       Tag it and enforce with AWS Config rule: DB subnets must not have internet routes

MISCONFIGURATION 5: Missing Subnet in One AZ for RDS Multi-AZ
  RDS Multi-AZ requires a DB Subnet Group with subnets in at least 2 AZs
  If you only create DB subnets in 2 out of 3 AZs and RDS tries to place standby in the 3rd, it fails
  Fix: create DB subnets in all 3 AZs proactively, add all to DB Subnet Group
```

---

### Cost Model

```
SUBNETS THEMSELVES: FREE
  Creating subnets, route tables, subnet associations: $0

COST IS DRIVEN BY RESOURCES IN SUBNETS:

NAT Gateway (1 per AZ for HA):
  $0.045/hour = $32.40/month × 2 AZs = $64.80/month
  Data processing: $0.045/GB (goes through NAT)
  Optimization: S3 → Gateway Endpoint (free, bypasses NAT)

Cross-AZ Data Transfer:
  Traffic between resources in different AZs: $0.02/GB
  ALB routing request from AZ-a to ECS in AZ-b: $0.01/GB each direction
  Minimize: use sticky sessions or AZ-local routing where acceptable

Elastic IPs (for NAT Gateway):
  First EIP per instance: FREE (when associated)
  Unassociated EIP: $0.005/hour (~$3.65/month waste — release unused EIPs)

MONITORING COST DRIVERS:
  aws ec2 describe-subnets --query 'Subnets[*].[SubnetId,AvailableIpAddressCount,CidrBlock]'
  Check: CloudWatch Metric → AWS/NATGateway → BytesOutToDestination (NAT data processed billing)
```
