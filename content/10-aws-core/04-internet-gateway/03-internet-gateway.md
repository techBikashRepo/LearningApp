# Internet Gateway

## FILE 03 OF 03 — Design Decisions, SAA Exam Traps, Scenarios & Architect's Mental Model

> **Architect Training Mode** | Senior Principal Architect Perspective
> _Optimized for: design judgement · tradeoff evaluation · failure prediction · production debugging_

---

## SECTION 9 — Certification Focus (AWS SAA-C03)

```
DO YOU NEED AN INTERNET GATEWAY?

YES, if any of these are true:
  ├── You have an ALB that serves internet traffic
  ├── You have EC2 instances with public IPs that must be reachable from internet
  ├── You have a NAT Gateway (NAT GW itself needs IGW to send traffic outbound)
  ├── Your VPC needs ANY inbound or outbound internet connectivity
  └── You have a Bastion Host / Jump Box for SSH from internet

NO (skip IGW if these are ALL true):
  ├── VPC is fully private (internal corporate network, connected via Direct Connect/VPN)
  ├── All resources accessed via VPN or Direct Connect only
  ├── No outbound internet calls needed (all services internal or via PrivateLink)
  └── Compliance requires: no internet gateway (maximum isolation environments)

  Pure private VPC use cases:
    ├── Internal microservices in corporate network (no customer-facing APIs)
    ├── Processing environments where internet = data exfiltration risk
    ├── Air-gapped systems (government, defense, financial core systems)
    └── Development environments with Direct Connect from office

SINGLE IGW PER VPC:
  AWS limits: 1 IGW per VPC. This is FINE because:
  IGW is region-wide, horizontally scaled, has no bandwidth limit
  You never need 2 IGWs for performance or HA reasons
  For multi-region HA: each region has its own VPC and its own IGW
```

---

## SECTION 10 — Comparison Table

```
PATH TO INTERNET            IGW INVOLVED   USE CASE
────────────────────────────────────────────────────────────────────────────────
Public subnet EC2 + EIP     YES (1:1 NAT)  Load balancer, bastion
ALB (internet-facing)       YES (via EIP)  Application load balancing
NAT Gateway                 YES (NAT GW    Private subnet outbound
                            uses IGW)
VPN Gateway (VGW)           NO             On-premises connectivity (MPLS/BGP)
Direct Connect              NO             Dedicated physical circuit to AWS
AWS PrivateLink             NO             Service-to-service via AWS backbone
VPC Peering                 NO             Inter-VPC (stays on AWS network)
Transit Gateway (TGW)       NO             Hub-and-spoke VPC connectivity
S3/DynamoDB Gateway Endpt   NO             AWS service access via internal AWS route
────────────────────────────────────────────────────────────────────────────────

KEY INSIGHT: VPN, Direct Connect, PrivateLink, Peering, TGW, and VPC Endpoints
             all bypass the Internet Gateway entirely — they use AWS private backbone.
             IGW is ONLY for actual internet traffic (public internet, not AWS-internal).
```

---

## SECTION 11 — Quick Revision

### Trap 1: IGW Does NOT Provide Filtering

```
Exam scenario: "A company wants to prevent the internet from reaching their
                application servers on port 3306 (MySQL)."
Incorrect answer: "Remove the Internet Gateway" (breaks ALL internet access)
Correct answer: "Configure Security Groups to deny inbound on port 3306"
                OR "Move MySQL to DB subnet (no internet route)"

IGW has NO built-in filtering. All traffic passes through unless:
  - Route table has no route (packet dropped before reaching IGW)
  - Security Group blocks the traffic
  - NACL blocks the traffic at subnet boundary
The IGW itself is transparent — it just routes and NATs.
```

### Trap 2: One IGW per VPC Is the Hard Limit

```
Exam: "A VPC needs redundant internet connectivity. How many Internet Gateways
       can be attached for HA?"
Answer: Maximum 1 IGW per VPC. IGW itself is HA by AWS design (no need for 2).
        For multi-region HA: two separate VPCs each with their own IGW,
        with Route 53 routing between them.
```

### Trap 3: EC2 in Public Subnet Does NOT Have Internet Access Without Public IP

```
EC2 in public subnet (subnet has 0.0.0.0/0 → IGW) but NO public IP assigned.
Question: "Can this EC2 reach the internet?"
Answer: NO for OUTBOUND. IGW 1:1 NAT requires a public IP to translate.
        Without public IP: packets from this EC2 going to internet have private source IP.
        Internet won't route back to 10.x.x.x private addresses.

EXCEPTION: If a NAT Gateway is in the public subnet and private subnet routes through NAT,
           then private-subnet instances CAN reach internet via NAT (not via IGW directly).

PUBLIC SUBNET EC2 internet access requirements: ALL three needed:
  1. IGW attached to VPC AND route table has 0.0.0.0/0 → IGW
  2. EC2 has public IP (auto-assigned or Elastic IP)
  3. Security Group allows outbound (default SG allows all outbound — check if modified)
```

### Trap 4: Egress-Only IGW Is IPv6 Only

```
Question: "Which gateway allows EC2 instances in private subnets to initiate
           outbound IPv6 connections while blocking IPv6 inbound?"
Answer: Egress-Only Internet Gateway

NOT: NAT Gateway (IPv4 only)
NOT: Internet Gateway (allows BOTH inbound and outbound — no restriction)
NOT: NAT Instance (legacy, IPv4, not IPv6 equivalent)

Egress-Only IGW is the IPv6-specific resource for private subnet outbound.
Cost: FREE (unlike NAT Gateway at $32/month). Pure route traffic.
```

### Trap 5: IGW and VPC Must Be in Same Region

```
You cannot attach an IGW from us-east-1 to a VPC in ap-south-1.
IGWs are region-scoped resources.
Each region's VPCs have their own IGWs.
Cross-region connectivity: VPC Peering / TGW / Direct Connect — not shared IGW.
```

---

## SECTION 12 — Architect Thinking Exercise

```
SCENARIO: SaaS company adding private connectivity to enterprise customers

Current setup:
  VPC with IGW — customer API accessed via internet (HTTPS)
  5 new enterprise customers requirement:
    - Do NOT want their traffic going over public internet
    - Want private IP connectivity (they use AWS too — same or different account)
    - Should NOT require changes to company's VPC CIDR

Options to AVOID IGW for enterprise traffic:

OPTION A: AWS PrivateLink (recommended)
  Create Network Load Balancer (NLB) as endpoint service
  Enterprise customer: creates VPC Interface Endpoint in their VPC
  Traffic: Enterprise VPC → PrivateLink → Company NLB → Application
  Advantages:
    ├── No CIDR overlap issues (PrivateLink uses private IP from their VPC CIDR)
    ├── Company doesn't open VPC to customer's VPC (not full VPC peering)
    ├── Company exposes just ONE service, not whole VPC
    ├── Traffic: AWS backbone, never internet
    └── Scalable: each customer creates their own endpoint
  Cost: $0.01/hour per endpoint per AZ + $0.01/GB

OPTION B: VPC Peering per customer
  Peer company VPC with each customer VPC
  Requires non-overlapping CIDRs
  Customer can reach all company resources (not just the API) unless SGs restrict
  Scales poorly: 100 customers = 100 peering connections

RECOMMENDATION: PrivateLink for enterprise API access (designed for this use case)

ARCHITECTURE:
  Internet users → IGW → ALB (internet-facing) → ECS
  Enterprise users → PrivateLink Interface Endpoint → NLB → ECS
  DB → private subnet, no IGW involvement
```

---

### Interview Q&A

**Q: "What is an Internet Gateway and what does it do?"**

Good answer: "An Internet Gateway is a VPC component that enables bidirectional communication between resources in public subnets and the internet. It performs 1:1 NAT — when an EC2 instance with an Elastic IP sends traffic out, the IGW translates the private IP to the public IP and vice versa for responses. The IGW itself is fully managed, horizontally scaled, has no bandwidth limit, and spans all AZs in the region — it's inherently highly available. You need exactly one per VPC. The IGW doesn't do any filtering; that's the job of Security Groups and NACLs. For private subnets that need outbound internet, you pair the IGW with a NAT Gateway: private subnet → NAT GW → IGW → internet."

---

## === ARCHITECT'S MENTAL MODEL ===

### 5 Decision Rules for Internet Gateway

1. **IGW is the front door. It does NOT lock or screen visitors — Security Groups do that.** A common belief is "attach IGW = internet exposure." Wrong. A VPC can have an IGW and still have all resources fully private if no Security Group allows inbound and no resource has a public IP. IGW is infrastructure. Security is your responsibility on top of it.

2. **NAT Gateway needs IGW, but not vice versa.** NAT Gateway lives in a public subnet and routes through the IGW. If you remove the IGW, NAT Gateway goes down and all private-subnet outbound traffic dies. But the reverse is not true — you can have an IGW-attached VPC with no NAT Gateway (fully public resources). Understand the dependency direction: private subnet → NAT GW → IGW → internet.

3. **One IGW, no bandwidth limits, no HA concerns for the IGW itself.** AWS manages IGW availability. You never need to think about IGW scaling or redundancy — AWS has solved this. Your HA concerns are at the NAT Gateway level (one per AZ), the ALB level (multi-AZ), and the application level. Not at the IGW level.

4. **For enterprise/private connectivity: skip the IGW entirely.** When customers want private connectivity, don't route through internet (IGW path). Use PrivateLink, VPC Peering, Direct Connect, or Transit Gateway. All of these bypass the IGW. Routing sensitive enterprise data over internet (even HTTPS) is architecturally weaker than private backbone routing.

5. **IPv6 on AWS: use Egress-Only IGW for private subnet outbound, not NAT Gateway.** IPv6 has no NAT (all IPv6 is globally unique and routable). Egress-Only IGW blocks inbound IPv6 while allowing outbound — this is the "NAT Gateway equivalent" for IPv6, and it's FREE. A future-looking architecture keeps IPv4 NAT Gateway for legacy and uses Egress-Only IGW for IPv6 traffic.

### 3 Common Mistakes

1. **Forgetting to attach the IGW after creating it.** IGW creation and attachment are two operations. Terraform requires `aws_internet_gateway_attachment` resource separately (or you embed it in `aws_internet_gateway`). CloudFormation VPC templates often miss this. Post-deploy validation must check: IGW attachment state = "available" on the correct VPC.

2. **Pointing private or DB subnet route tables to IGW.** Private subnets should route 0.0.0.0/0 → NAT GW. DB subnets should have NO 0.0.0.0/0 route. Either accidental route or Terraform copy-paste error that adds an IGW route to the wrong route table creates security exposure. Audit route tables regularly with `describe-route-tables`.

3. **Expecting IGW to protect against DDoS or filter traffic.** IGW passes everything through. Basic DDoS protection requires AWS Shield Standard (free, enabled automatically) + CloudFront + WAF + ALB. For higher protection: AWS Shield Advanced ($3,000/month). Teams that expect IGW to "handle" security attacks are mistaken — the protection stack is above the IGW.

### 1 Clear Interview Answer (30 Seconds)

> "The Internet Gateway is the VPC's connection point to the public internet. It's a managed, horizontally-scaled resource with no bandwidth limit that spans all AZs — you never worry about its availability. It does 1:1 NAT between Elastic IPs and private IPs for EC2 instances. For public subnets to use it, the route table needs 0.0.0.0/0 pointing to the IGW and resources need public IPs. For private subnets, you don't use IGW directly — you use a NAT Gateway in the public subnet, which itself routes through the IGW. IGW does no filtering — that's entirely Security Groups and NACLs."

---

_End of Internet Gateway 3-File Series_
