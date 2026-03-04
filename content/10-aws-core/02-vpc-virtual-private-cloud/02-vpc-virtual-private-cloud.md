# VPC (Virtual Private Cloud)

## FILE 02 OF 03 — Production Failures, Incidents, Debugging & Operations

> **Architect Training Mode** | Senior Principal Architect Perspective
> _Optimized for: design judgement · tradeoff evaluation · failure prediction · production debugging_

---

## SECTION 5 — Real World Example

```
INCIDENT TIMELINE:
T+0:   Dev deploys Lambda function. Works in us-east-1 (default VPC).
T+1:   Lambda placed in private VPC for company compliance policy.
T+5:   Lambda deployed to production. First invocation: timeout after 30s.
T+10:  Alert fires: payment processing Lambda failing 100% of invocations.
T+15:  On-call engineer checks Lambda logs: "Task timed out after 30s"
T+20:  No error — just timeout. External API call (Stripe) never returns.
T+45:  Root cause identified: Lambda in private subnet, no NAT Gateway,
        no internet route, Stripe API call silently hangs.

ROOT CAUSE CHAIN:
  Lambda in private subnet
  → Route Table for private subnet: only 10.10.0.0/16 → local
  → 0.0.0.0/0 route: MISSING (no NAT Gateway configured)
  → Stripe API call (outbound to stripe.com) → no route → packet dropped
  → Lambda waits for TCP response → timeout after 30 seconds

FIX:
  Option A: Add NAT Gateway in public subnet, add 0.0.0.0/0 → NAT GW route to private subnet
  Option B: Use VPC Endpoint for AWS services (S3, DynamoDB, SQS — no NAT needed)
  Option C: Move Lambda outside VPC if it doesn't need VPC resources (no ENI overhead)

PREVENTION CHECKLIST:
  Before placing anything in a private subnet:
  ✅ Outbound internet needed? → NAT GW in public subnet + route table entry
  ✅ Only needs AWS services (S3/DynamoDB/SQS)? → VPC Gateway/Interface Endpoint
  ✅ No VPC resource access needed? → run outside VPC entirely
```

---

## SECTION 6 — System Design Importance

```
INCIDENT:
  Company A acquires Company B. Both run on AWS.
  Network team creates VPC Peering between A's VPC and B's VPC.
  Status: ACTIVE. But services CANNOT communicate.

TIMELINE:
T+0:   VPC Peering connection created. Status: Active.
T+10:  Engineers test: ping from Company A ECS → Company B RDS: 100% packet loss
T+30:  AWS Console checked: VPC Peering = Active, Security Groups = allow all (test mode)
T+60:  Root cause found: route tables NOT updated

ROOT CAUSE:
  VPC Peering is ACTIVE (handshake done) but traffic still fails because:

  Company A VPC: 10.10.0.0/16
  Company B VPC: 10.20.0.0/16

  Company A private subnet route table:
    10.10.0.0/16 → local        ✅
    0.0.0.0/0    → nat-gw     ✅
    10.20.0.0/16 → ???        ❌ MISSING — traffic to Company B has no route

  Company B private subnet route table:
    10.20.0.0/16 → local        ✅
    0.0.0.0/0    → nat-gw     ✅
    10.10.0.0/16 → ???        ❌ MISSING — return traffic has no route either

  VPC Peering does NOT auto-update route tables.
  You must manually (or via Terraform) add routes in BOTH VPCs.

FIX:
  Company A private subnet RT: add 10.20.0.0/16 → pcx-xxxxxxxx (peering connection)
  Company B private subnet RT: add 10.10.0.0/16 → pcx-xxxxxxxx (peering connection)
  Also update Security Groups to allow the specific port from the peer CIDR

LESSON:
  VPC Peering status = Active means ONLY that the peering handshake succeeded
  Route tables and Security Groups are ALWAYS manual (or Terraform-managed)
  Test connectivity after every peering setup with nc -zv <ip> <port>
```

---

## SECTION 7 — AWS & Cloud Mapping

```
INCIDENT: RDS hostname resolves to public IP from within VPC

SYMPTOMS:
  ECS task tries to connect to RDS endpoint: mydb.xxxx.ap-south-1.rds.amazonaws.com
  Connection succeeds in testing, fails intermittently in production
  Security team flags: database connection leaving VPC boundary

ROOT CAUSE:
  RDS hostname resolves to PUBLIC IP when:
    VPC settings: "enableDnsResolution" = false OR "enableDnsHostnames" = false

  With defaults OFF: DNS queries for AWS resources resolve to public IPs
  even from inside the VPC. Traffic leaves VPC → internet → back to AWS.
  Security Group on RDS blocks this (because source is internet, not VPC CIDR)

  With both settings ON: RDS DNS resolves to PRIVATE IP within VPC.
  Traffic stays within VPC. Security group allows VPC CIDR.

FIX:
  Enable both VPC DNS settings:

  AWS Console: VPC → Your VPC → Actions → Edit VPC Settings
    ✅ Enable DNS resolution (enableDnsResolution)
    ✅ Enable DNS hostnames (enableDnsHostnames)

  Terraform:
    resource "aws_vpc" "main" {
      cidr_block           = "10.10.0.0/16"
      enable_dns_support   = true   # enableDnsResolution
      enable_dns_hostnames = true   # enableDnsHostnames
    }

  BOTH must be true for private DNS to work. They are INDEPENDENT settings.
  enable_dns_support: enables DNS resolution within VPC (Route 53 Resolver)
  enable_dns_hostnames: assigns DNS hostnames to EC2 instances (needed for RDS resolution)
```

---

## SECTION 8 — Interview Preparation

**Beginner:**

**Q: What is a VPC and why do you need one?**
**A:** A VPC (Virtual Private Cloud) is your own private, isolated section of the AWS cloud â€” like having your own private network inside AWS. Without a VPC, all your resources would be on a shared public network accessible from the internet. With a VPC: you control what's public-facing and what's internal-only, you define IP address ranges, you control routing. Every AWS account comes with a default VPC in each region. For production: always create a custom VPC with carefully designed subnets instead of using the default (default VPC has everything public-facing by default).

**Q: What is a CIDR block and how does it define the IP address range of a VPC?**
**A:** CIDR (Classless Inter-Domain Routing) notation defines a range of IP addresses. Example: 10.0.0.0/16 means: start at 10.0.0.0, the /16 means the first 16 bits are fixed, leaving 16 bits variable = 65,536 possible IP addresses (10.0.0.0 through 10.0.255.255). For a VPC: /16 is standard â€” gives you enough addresses to split into many subnets. For subnets: /24 gives 256 addresses (10.0.1.0 through 10.0.1.255). AWS reserves 5 IPs per subnet (first 4 + last 1) for internal use.

**Q: Can resources in two different VPCs communicate with each other by default?**
**A:** No. VPCs are completely isolated by default â€” even if in the same AWS account and region. To allow communication: *VPC Peering* â€” direct private connection between two VPCs (non-transitive). *AWS Transit Gateway* â€” hub-and-spoke network connecting many VPCs. *VPC Endpoints* â€” private connections to specific AWS services without leaving AWS network. Without these, traffic between two VPCs would have to go over the public internet (through an Internet Gateway) â€” undesirable for private database or service-to-service communication.

---

**Intermediate:**

**Q: What is the difference between a default VPC and a custom VPC, and why should production use a custom VPC?**
**A:** Default VPC (created by AWS in each region): all subnets are public (have a route to an Internet Gateway), instances get public IPs by default. Convenient for getting started, terrible for production security. Custom VPC: you define public and private subnets, control routing, no instances get public IPs unless explicitly configured. Production best practice: create a custom VPC with private subnets for your application servers and databases (no internet access to those resources) and public subnets only for your load balancers and NAT Gateways. This is the defense-in-depth principle â€” databases should never be directly accessible from the internet.

**Q: What is VPC Flow Logs and when is it useful?**
**A:** VPC Flow Logs capture metadata about IP traffic to/from network interfaces in your VPC: source IP, destination IP, port, protocol, bytes transferred, whether traffic was accepted or rejected by security groups. Useful for: (1) *Security investigation*: "Which IP addresses have been hitting port 22?" (2) *Traffic analysis*: "Why is my NAT Gateway costing so much? Who is generating this traffic?" (3) *Compliance*: network audit trail. (4) *Debugging connectivity*: "Is traffic reaching my instance at all, or is it being blocked by a security group?" Logs go to CloudWatch Logs or S3. Query with CloudWatch Insights or Athena.

**Q: What is a VPC Endpoint and why is it important for S3 and DynamoDB access from private subnets?**
**A:** By default, accessing S3 from an EC2 in a private subnet routes traffic out through the NAT Gateway, then to S3's public endpoint â€” you pay NAT Gateway data processing fees (~.045/GB) for every byte to S3. A VPC Gateway Endpoint for S3/DynamoDB creates a private route directly from the private subnet to S3/DynamoDB within the AWS network â€” no internet, no NAT Gateway, no data processing cost. This is free. For any application that frequently reads/writes S3 from private subnets: VPC Endpoint saves significant cost (and improves security â€” S3 traffic never leaves AWS network).

---

**Advanced (System Design):**

**Scenario 1:** Design the VPC architecture for a 3-tier web application (public web layer, private app layer, private data layer) across 2 AZs for high availability. Specify CIDR ranges, subnet types, and routing.

*VPC: 10.0.0.0/16 (us-east-1)*
`
Public subnets (for ALB, NAT Gateway):
  10.0.1.0/24  (us-east-1a) â€” ALB, NAT GW
  10.0.2.0/24  (us-east-1b) â€” ALB

Private app subnets (for ECS tasks):
  10.0.10.0/24 (us-east-1a) â€” ECS tasks
  10.0.11.0/24 (us-east-1b) â€” ECS tasks

Private data subnets (for RDS, ElastiCache):
  10.0.20.0/24 (us-east-1a) â€” RDS primary
  10.0.21.0/24 (us-east-1b) â€” RDS standby

Routing:
  Public subnet â†’ Internet Gateway (for inbound traffic to ALB)
  Private app subnet â†’ NAT Gateway (for outbound: npm registry, S3 API)
  Private data subnet â†’ No internet route (data layer = no outbound internet)
  All subnets â†’ VPC Gateway Endpoint for S3/DynamoDB
`

**Scenario 2:** Your security audit reveals that your production RDS database is in a public VPC subnet and has a public IP. Engineers argue "it's protected by security groups" â€” the security group only allows port 5432 from your application's IP. Explain why this is still a risk and how you migrate it to a private subnet with zero downtime.

*Risks even with security groups:*
(1) Security groups can be misconfigured accidentally (someone adds  .0.0.0/0 for debugging, forgets to revert).
(2) The public IP is visible to internet scanners. CVEs in PostgreSQL could be exploited if the security group rules have any gap.
(3) Compliance auditors will flag this regardless of security group rules.
(4) No defense in depth â€” one misconfiguration = database exposed.

*Zero-downtime migration:*
(1) Create new private subnet in the same AZ. Create new DB subnet group including private subnets.
(2) Take RDS snapshot â†’ restore to new instance in private subnet. Update the restored instance's security group identically.
(3) Test application connectivity to new instance from the private app subnet (ensure routing works: app subnet â†’ private data subnet via VPC internal routing).
(4) In Route 53 or application config: update DB endpoint to new instance. Weighted routing: 10% â†’ new instance, monitor errors, gradually shift to 100%.
(5) Delete old public RDS instance.

