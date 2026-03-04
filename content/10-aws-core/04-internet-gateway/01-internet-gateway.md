# Internet Gateway

## FILE 01 OF 03 — Core Concepts, Architecture, Components & Cost

> **Architect Training Mode** | Senior Principal Architect Perspective
> _Optimized for: design judgement · tradeoff evaluation · failure prediction · production debugging_

---

## SECTION 1 — Intuition (Explain Like a 12-Year-Old)

```
PHYSICAL EQUIVALENT:
  Internet Gateway → Edge Router + NAT appliance + Internet-facing firewall

  Physical setup:
    ISP → BGP peering → Edge router (Cisco/Juniper) → Firewall (Palo Alto, Fortinet)
    → Core switch → DMZ segment → Internet-facing servers

    Infrastructure:
      Edge router: $50,000–$200,000 hardware
      Firewall appliance: $20,000–$100,000
      Redundant pair: 2× everything
      BGP configuration: specialized network engineer
      Failover: manual or HSRP/VRRP (complex)
      Bandwidth: fixed purchase (1Gbps commit = pay whether used or not)

    Ops reality:
      Firmware patches: change management, planned downtime
      DDoS mitigation: separate $$$$ service or appliance
      BGP route advertisement: dedicated network team

  AWS Internet Gateway:
    Fully managed: no hardware, no patches, no BGP config
    Horizontally scalable: no bandwidth limit (AWS manages the scaling)
    HA by design: spans all AZs in the region
    Redundant: AWS SLA 99.99%
    Cost: $0 for the IGW itself (pay only for data transfer)
    DDoS: AWS Shield Standard (basic) built-in, free

IGW HANDLES:
  1. Bidirectional routing between VPC public subnets and the internet
  2. 1:1 NAT for instances with public IPs (translates public IP → private IP)
  3. No firewall functionality (Security Groups and NACLs do that)
  4. No traffic inspection (WAF or third-party appliances do that)
```

---

## SECTION 2 — Core Technical Explanation

```
WHAT AN IGW IS:
  A VPC component that enables communication between VPC resources
  and the internet (bidirectional).

  Properties:
    ├── Region-scoped (not AZ-specific — spans all AZs in the region)
    ├── 1 IGW per VPC maximum
    ├── Horizontally scaled, redundant, highly available by AWS
    ├── No bandwidth limits — scales automatically
    ├── Stateless at IGW level (stateful firewall = Security Groups/NACLs)
    └── Free to create — costs are data transfer only

HOW IT WORKS — NAT FUNCTION:
  When EC2 instance (10.10.1.25) with Elastic IP (34.224.55.12) sends to internet:

  1. EC2 sends packet: src=10.10.1.25, dst=api.stripe.com
  2. Packet hits route table: 0.0.0.0/0 → igw-xxxx
  3. IGW: maps 10.10.1.25 → 34.224.55.12 (translates source IP to EIP)
  4. Packet sent to internet: src=34.224.55.12, dst=api.stripe.com
  5. Response arrives at IGW: dst=34.224.55.12
  6. IGW: reverse maps 34.224.55.12 → 10.10.1.25
  7. Packet delivered to EC2

  KEY POINT: The EC2 instance itself does NOT know about its public IP.
  IGW holds the mapping table (EIP → private IP).
  Inside the OS: only the private IP (10.10.1.25) is visible on the interface.

  Proof: run `ip addr` on a public EC2 → shows only 10.10.x.x
         run `curl ifconfig.me` → shows the EIP (IGW-translated address)

DETACHED STATE:
  IGW can be created but NOT attached to any VPC
  Detached IGW: "detached" state. Costs $0. Does nothing.
  Must attach: aws ec2 attach-internet-gateway --vpc-id vpc-xxx --internet-gateway-id igw-xxx
  VPC: can only have 1 IGW attached at a time
  To replace: detach old → attach new (no downtime if subnets keep same routes)
```

---

## SECTION 3 — Architecture Diagram (MANDATORY)

```
COMPLETE REQUEST PATH (HTTPS user → ALB → ECS → RDS):

[User Browser]
   │ HTTPS request to api.myapp.com
   │
[Route 53]
   │ DNS lookup → returns ALB's IPv4 address (54.x.x.x)
   │
[Internet]
   │ TCP/IP to 54.x.x.x on port 443
   │
[Internet Gateway] ──── ATTACHED TO VPC (ap-south-1)
   │ Inbound: maps 54.x.x.x (ALB public IP) → 10.10.1.45 (ALB private ENI)
   │ Route table: 0.0.0.0/0 → igw-xxxx present in ALB's public subnet
   │
[ALB Node] ── in PUBLIC subnet 10.10.1.0/24
   │ TLS termination (ACM certificate)
   │ Security Group: inbound 443 from 0.0.0.0/0 allowed
   │ Listener rule: forward to target group "ecs-tasks"
   │
[ECS Task] ── in PRIVATE subnet 10.10.11.0/24
   │ Security Group: inbound 8080 from ALB Security Group
   │ Application processes request, needs to call Stripe API
   │ Route: 0.0.0.0/0 → nat-gw-az-a (outbound via NAT)
   │
NAT Gateway ── in PUBLIC subnet 10.10.1.0/24
   │ Translates ECS task IP (10.10.11.15) → NAT Gateway EIP (13.x.x.x)
   │ Route: 0.0.0.0/0 → igw-xxx
   │
[Internet Gateway] (outbound)
   │ ECS task → Stripe: src=13.x.x.x dst=stripe.com
   │
[RDS call from ECS]
   │ 10.10.11.15 → 10.10.21.8 (DB subnet) — STAYS WITHIN VPC (local route)
   │ Does NOT go through IGW (intra-VPC traffic)
   │

KEY INSIGHT:
  Internet Gateway is involved ONLY in public subnet traffic.
  ECS → RDS communication never touches the IGW.
  ECS → internet (via NAT) touches IGW, but traffic exits from NAT GW's EIP,
  NOT from the ECS task's private IP.
```

---

## SECTION 4 — Request Flow (MANDATORY FLOWCHART)

```
EGRESS-ONLY INTERNET GATEWAY:
  IPv6-only resource
  Allows instances with IPv6 addresses to initiate outbound internet traffic
  BLOCKS all inbound internet-initiated IPv6 traffic
  Equivalent of NAT Gateway but for IPv6
  (IPv6 addresses are public by default — Egress-Only IGW provides the "private outbound only" behavior)

  When to use:
    VPC with IPv6 CIDR enabled
    Resources have IPv6 addresses (e.g., EC2 dual-stack)
    Want IPv6 outbound without exposing IPv6 address to inbound connections

  vs NAT Gateway:
    NAT Gateway: IPv4 only, translates private → public IP
    Egress-Only IGW: IPv6 only, no translation (IPv6 are public), just blocks inbound

  Normal IGW vs Egress-Only IGW:
    Normal IGW: allows BOTH inbound and outbound IPv6
    Egress-Only IGW: ONLY outbound IPv6

PRACTICAL USE:
  Most teams: still IPv4-only production → skip Egress-Only IGW
  Future: as IPv6 becomes standard, this becomes the NAT Gateway equivalent
  Cost: FREE (unlike NAT Gateway which is $32/month)
```

---

### Common IGW Misconfigurations

```
MISCONFIGURATION 1: No IGW Attached But Route Table Points to IGW
  Route table: 0.0.0.0/0 → igw-xxxx (in "detached" state)
  Result: route exists but traffic has no gateway to exit through
  Error: connections to internet time out silently
  Fix: aws ec2 attach-internet-gateway --internet-gateway-id igw-xxxx --vpc-id vpc-xxxx

MISCONFIGURATION 2: IGW Attached But Route Table Missing
  IGW attached to VPC. Public subnet exists. EC2 has public IP.
  Missing: route table entry 0.0.0.0/0 → igw-xxxx on the public subnet
  Result: traffic from EC2 never exits to internet (no route)
  Debugging: check route table for the specific subnet, not just the VPC
  Fix: aws ec2 create-route --route-table-id rtb-xxxx \
         --destination-cidr-block 0.0.0.0/0 --gateway-id igw-xxxx

MISCONFIGURATION 3: Security Group Blocking Despite IGW and Route Being Correct
  All IGW, route table, and public IP configured correctly
  EC2 unreachable from internet
  Root cause: Security Group has no inbound rule for the target port
  IGW allows traffic in — Security Group is the next line of defense
  Fix: add inbound rule to Security Group for the required port and source

MISCONFIGURATION 4: Private Subnet Route Table Accidentally Points to IGW
  Private subnet route table: 0.0.0.0/0 → igw-xxxx (should be → NAT GW)
  Result: private subnet resources try to use IGW (need public IP — they don't have one)
  Outbound from private instances → fails (no public IP for IGW 1:1 NAT)
  More dangerous: if resource has EIP, it can be internet-accessible unintentionally
  Fix: private subnet route → NAT GW, never → IGW directly

MISCONFIGURATION 5: Route to IGW in DB Subnet
  Absolute prohibition: DB subnet should NEVER have 0.0.0.0/0 → IGW
  Result: databases with public IPs (if assigned) become internet-accessible
  Compliance failure: most frameworks require data tier to have no internet route
```

---

### IGW vs NAT Gateway: Comprehensive Comparison

```
FEATURE              INTERNET GATEWAY          NAT GATEWAY
─────────────────────────────────────────────────────────────────────────
Direction            Bi-directional (in + out) Outbound only (blocks inbound)
IP Translation       1:1 (EIP ↔ private IP)   Many:1 (all private → 1 EIP)
Subnet placement     VPC-level (not in subnet) Public subnet (AZ-scoped)
Who uses it directly EC2 with public IP        Private subnet resources
Bandwidth limit      None (AWS managed)        45 Gbps max
Connection table     N/A                       ~55,000 simultaneous connections
HA design            Inherently HA             1 per AZ for HA
Cost                 $0                        $32/month + $0.045/GB
IPv6 support         Yes (full bi-directional) No (use Egress-Only IGW for IPv6)
Managed by AWS       Yes                       Yes
─────────────────────────────────────────────────────────────────────────

MENTAL MODEL:
  IGW = the "front door" of the VPC — anyone can knock (if allowed by SG)
  NAT GW = the "side exit" — residents can go out, nobody comes in that way

  You need BOTH for a full production setup:
  IGW: so ALB can receive internet traffic
  NAT GW: so app servers can initiate outbound (API calls, package downloads)
```

---

### Cost Model

```
INTERNET GATEWAY:
  Creation: FREE
  Hourly charge: FREE
  Data transfer IN (into AWS): FREE
  Data transfer OUT (to internet): charged by EC2/NAT data transfer rates
    First 100GB/month: $0.09/GB
    Next 9.9TB/month:  $0.085/GB
    Beyond 10TB/month: $0.07/GB

  Note: The IGW itself costs nothing. You pay for DATA TRANSFER charged to
        the EC2 instance or NAT Gateway using the IGW.

COST OPTIMIZATION:
  ├── CloudFront for static content: data transfer to CloudFront from origin = $0.008/GB
      instead of $0.09/GB direct, and CloudFront serves users from edge (less origin traffic)
  ├── S3 Gateway Endpoint: S3 traffic via endpoint → $0 (no IGW data transfer for S3)
  ├── Compress API responses (gzip) → reduces bytes transferred
  └── Check: AWS Cost Explorer → filter by "Data Transfer" to identify top origins
```
