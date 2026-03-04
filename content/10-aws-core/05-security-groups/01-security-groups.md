# Security Groups

## FILE 01 OF 03 — Core Concepts, Architecture, Components & Cost

> **Architect Training Mode** | Senior Principal Architect Perspective
> _Optimized for: design judgement · tradeoff evaluation · failure prediction · production debugging_

---

## SECTION 1 — Intuition (Explain Like a 12-Year-Old)

```
PHYSICAL EQUIVALENT:
  Security Group → Host-based firewall (iptables, Windows Firewall)
                   + micro-segmentation firewall rules

  Physical setup:
    Physical firewall (Palo Alto, Cisco ASA) → applies rules between VLANs
    Host-level: iptables rules on each Linux server
    Problem: firewall rules = IP-based (10.10.1.x allowed)
            When IPs change → rules become stale, incorrect access

    Enterprise micro-segmentation:
      Dedicated hardware: $100,000+ for VMware NSX, Cisco ACI
      Complexity: VLAN tagging per app tier, SDN overlays
      Team: dedicated network security team to manage

  AWS Security Group:
    Applied at the ENI (Elastic Network Interface) level — every EC2, ECS task,
    Lambda, RDS endpoint has an ENI, Security Group attaches to it
    Identity-based: allow inbound from "security group X" not "IP 10.10.1.x"
    When IPs change (autoscaling, redeploy): if SG reference is used, rules stay valid
    Rules: evaluated as a set (all rules evaluated, most permissive wins)
    Stateful: connection tracking (return traffic auto-allowed)
    Cost: FREE

SECURITY GROUP AS IDENTITY:
  Physical: "allow app server IP range" → breaks when IPs change
  AWS: "allow from sg-app-server" → works regardless of what private IPs are in use
  This is the paradigm shift. Reference security groups by ID, not by IP.
```

---

## SECTION 2 — Core Technical Explanation

```
SECURITY GROUP = Virtual stateful firewall attached to an ENI

KEY PROPERTIES:

Stateful:
  You allow inbound port 443 → response traffic on ephemeral ports auto-allowed
  You don't need a separate outbound rule for return traffic
  Compare: NACL is stateless — response traffic needs explicit outbound rule

Allow-only:
  Security Groups only have ALLOW rules (no DENY rules)
  Everything not explicitly allowed is IMPLICITLY DENIED
  You cannot create a rule that DENIES specific traffic while allowing everything else
  For DENY capability: need NACL (which has explicit deny rules)

Evaluated as a set:
  Multiple rules: all rules evaluated
  First match does NOT win — all rules evaluated
  Most permissive rule wins
  Example: rule allows port 443 from 0.0.0.0/0 AND rule allows all ports from sg-xxxx
           Both apply to the matching traffic

Attached to ENI, not instance:
  Instance can have multiple ENIs, each with its own SG
  Multiple SGs can be attached to one ENI (up to 5 SGs per ENI by default)
  SG rules from ALL attached SGs are unioned (combined)

Region-scoped:
  Security Group belongs to a specific VPC in a specific region
  Cannot reference SG from another VPC in a rule (unless using VPC Peering — CIDR only)
  Cannot reference SG from another region

DEFAULT SECURITY GROUP:
  Every VPC has a default SG
  Default inbound: ALLOW all inbound from same SG (self-referencing)
  Default outbound: ALLOW all (0.0.0.0/0 all ports)
  NEVER use default SG for production resources: no descriptive name, hard to audit
  Best practice: create named SGs per resource type (sg-alb, sg-app, sg-rds)
```

---

## SECTION 3 — Architecture Diagram (MANDATORY)

```
LAYERED SECURITY GROUP ARCHITECTURE (production standard):

sg-alb (Internet-facing ALB):
  INBOUND:
    443  TCP   0.0.0.0/0   (HTTPS from internet)
    80   TCP   0.0.0.0/0   (HTTP from internet — redirects to 443)
  OUTBOUND:
    8080 TCP   sg-app       (to app tier on application port)

sg-app (ECS Tasks / EC2 App Servers):
  INBOUND:
    8080 TCP   sg-alb       (only from ALB — not from internet directly)
  OUTBOUND:
    5432 TCP   sg-rds       (to PostgreSQL DB)
    6379 TCP   sg-cache     (to Redis)
    443  TCP   0.0.0.0/0   (HTTPS to external APIs: Stripe, etc.)

sg-rds (RDS PostgreSQL):
  INBOUND:
    5432 TCP   sg-app       (only from app tier)
  OUTBOUND:                 (RDS outbound — usually empty unless needed)

sg-cache (ElastiCache Redis):
  INBOUND:
    6379 TCP   sg-app       (only from app tier)
  OUTBOUND:                 (empty)

CHAIN OF TRUST:
  Internet
    → [sg-alb allows 443 from internet]
    → ALB
    → [sg-app allows 8080 from sg-alb only]
    → ECS Task
    → [sg-rds allows 5432 from sg-app only]
    → RDS

  A compromised internet user CANNOT reach RDS directly
  Even if they bypass ALB (hard) — sg-rds only allows from sg-app

  This is micro-segmentation through Security Group chaining.
  Each tier only trusts the specific SG of the tier above it.
```

---

## SECTION 4 — Request Flow (MANDATORY FLOWCHART)

```
INBOUND RULE COMPONENTS:
  Type: SSH, HTTP, HTTPS, Custom TCP, Custom UDP, All traffic, etc.
  Protocol: TCP, UDP, ICMP, All
  Port range: single (443) or range (1024-65535)
  Source:
    IPv4 CIDR: 203.0.113.0/24 (specific IP range)
    IPv6 CIDR: ::/0 (all IPv6)
    Security Group: sg-xxxx (traffic from instances with that SG)
    Managed Prefix List: aws-managed list (e.g., CloudFront IP ranges)

OUTBOUND RULE COMPONENTS:
  Same as inbound but Destination instead of Source

SECURITY GROUP REFERENCE (SG-to-SG):
  Most powerful AWS-specific feature
  "Allow inbound 5432 from sg-app" means:
    Any ENI with sg-app attached can connect to port 5432
    Works with autoscaling (new tasks automatically in scope)
    Works across subnets and AZs within same VPC
    IPs are irrelevant — identity is the SG ID

  Cross-account SG reference (VPC Peering):
    You CAN reference SGs from a peered VPC:
    Source: sg-xxxx (from Account 123456789012) in peer VPC
    Requires: active peering + cross-account SG ID
    But: easier to use CIDR of peer VPC subnet for simplicity

MANAGED PREFIX LISTS:
  AWS-maintained lists of IP ranges for AWS services
  Example: CloudFront IP ranges (600+ CIDRs managed by AWS):
    aws-managed-prefix-list for CloudFront (pl-xxxx in your region)
    ALB SG inbound: allow 443 from this prefix list
    Result: only CloudFront (not arbitrary internet users) can hit ALB directly
    Benefit: bypass direct-to-origin attacks (attackers discover origin IP and bypass CloudFront)
```

---

### Inbound vs Outbound Rules Best Practices

```
DEFAULT OUTBOUND RULE: Allow All (0.0.0.0/0 all ports)
  AWS default: all outbound is allowed
  Most teams keep this default — simpler, and inbound controls are the security focus

RESTRICTIVE OUTBOUND (Zero Trust Network):
  Remove default outbound allow-all
  Explicitly allow only required outbound:
    443 → external APIs
    5432 → sg-rds
    6379 → sg-cache
  Benefit: if instance is compromised, cannot call back to attacker's C&C server
           (outbound to arbitrary IPs on arbitrary ports blocked)
  Tradeoff: operational overhead — every new dependency requires outbound rule
  Use for: regulated environments (PCI-DSS, healthcare), high-security systems

DENY BY DEFAULT OUTBOUND FLOW:
  App server → calls unexpected port 22 (SSH) outbound → C2 server
  With restrictive outbound SG: this attempt is blocked → security wins
  Without restriction: breach exfiltrates data via legitimate-looking outbound HTTPS

PRACTICAL RECOMMENDATION:
  ├── App tier outbound: allow 443 (HTTPS), 5432, 6379 — restrict rest
  ├── DB tier outbound: empty (RDS should never initiate outbound connections)
  ├── Lambda outbound: allow 443 for APIs, specific ports for VPC resources
  └── ALB outbound: allow target port (8080) to app SG, nothing else
```

---

### Common Security Group Misconfigurations

```
MISCONFIGURATION 1: 0.0.0.0/0 Open Port on Database
  sg-rds inbound: 5432 TCP 0.0.0.0/0 — the worst misconfiguration
  Result: PostgreSQL accessible from entire internet
  Exploitation: brute force passwords, CVE exploits on PostgreSQL version
  AWS Security Hub: flags this as CRITICAL finding
  Fix: sg-rds inbound: 5432 from sg-app only

MISCONFIGURATION 2: All Ports Open Between Tiers (Overly Permissive)
  sg-app inbound: ALL traffic from sg-alb
  Result: if attacker controls ALB or forges SG, can reach any port on app server
  Correct: only port 8080 (or whatever app port) from sg-alb

MISCONFIGURATION 3: SSH/RDP Port Open to 0.0.0.0/0
  sg-bastion inbound: 22 TCP 0.0.0.0/0
  Result: SSH exposed to internet brute force and credential stuffing
  Fix: 22 from YOUR office IP CIDR only, OR use AWS Systems Manager Session Manager
       and remove port 22 entirely (SSM Session Manager = no SSH port needed)

MISCONFIGURATION 4: Stale Security Group Rules for Deleted Resources
  Old rule: allow inbound from sg-old-service (deleted 6 months ago)
  Problem: rule references non-existent SG — no security function
  Worse: if SG ID is reused in future for different service: accidental access
  Fix: regular SG audit, remove dangling rules
  Tool: AWS Config, SecurityHub rule: sg-not-attached-to-any-eni → candidates for cleanup

MISCONFIGURATION 5: Multiple Teams Using Default SG
  Default SG is self-referencing: all resources with default SG talk to each other
  When 5 teams use default SG: all their resources can talk to each other
  Finance app DB accessible from marketing EC2 (both on default SG)
  Fix: custom named SGs per team and service, enforce via SCP:
       Deny ec2:AuthorizeSecurityGroupIngress on security group named "default"
```

---

### Cost Model

```
SECURITY GROUPS: FREE
  Creating security groups, adding rules, attaching to ENIs: $0
  No limit on number of rules (default: 60 inbound + 60 outbound per SG, soft limit)
  Default: 5 SGs per ENI (soft limit, can increase)

INDIRECT COSTS:
  VPC Flow Logs for security group analysis: CloudWatch ingestion $0.50/GB
  AWS Security Hub (for SG monitoring): $0.001 per security check per resource
  AWS Config (for SG compliance rules): $0.003 per configuration item recorded
  GuardDuty (detects unusual traffic patterns): pricing per GB analyzed

COST OPTIMIZATION:
  → Use SG references not CIDRs where possible (fewer rules, easier maintenance)
  → Flow Logs to S3 not CloudWatch for high-volume environments
  → Security Hub: use findings only, not all checks if cost-sensitive
  → Consolidate overly specific rules: fewer rules = easier management
    (not a cost factor but an ops efficiency factor)
```
