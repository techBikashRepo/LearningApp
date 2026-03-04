# Elastic IP (EIP)

## FILE 02 OF 03 — Production Incidents, Failure Patterns & Debugging

> **Architect Training Mode** | Senior Principal Architect Perspective
> _Optimized for: design judgement · tradeoff evaluation · failure prediction · production debugging_

---

## SECTION 5 — Real World Example

```
INCIDENT:
  Monthly AWS bill shows $180 unexpected charge.
  Team investigates: finds 50 unassociated EIPs across 3 regions.

ROOT CAUSE:
  Sprint velocity practice: dev team spins up EC2 experiments → allocates EIPs.
  EC2 "terminated" (cost ends for instance) → but EIP NOT released.
  Team assumes terminate = release everything. It does not for EIP.

  Lifecycle confusion:
    EC2 terminate → instance deleted. EBS deleted (if flag set). EIP → STAYS allocated.
    EIP: owned by account, not by instance. Explicit release required.

  50 EIPs × $0.005/hr × 720 hr = $180/month for doing nothing.

FIX:
  Immediate: find and release all unassociated EIPs

  # List all unassociated EIPs (being charged, not in use)
  aws ec2 describe-addresses \
    --query 'Addresses[?AssociationId==null].[AllocationId,PublicIp,Tags]' \
    --output table

  # Release a specific EIP
  aws ec2 release-address --allocation-id eipalloc-xxxxxxxx

PREVENTION:
  AWS Config rule: eip-attached → alert on non-attached EIPs > 24 hours
  Terraform: manage EIP as resource (tf destroy releases it)
  CloudFormation: EIP in stack → stack delete releases it
  IaC enforcement: no manual EIP allocation in production account

  Budget alert: set $5 alert for EC2-Other (EIP charges appear here)
```

---

## SECTION 6 — System Design Importance

```
INCIDENT TIMELINE:
  T+0:  On-call engineer patches EC2. Old instance: i-aaa. New instance: i-bbb.
  T+5:  Old instance terminated. New instance i-bbb running and healthy.
  T+10: Customers reporting "cannot reach api.example.com"
  T+15: Engineer checks: EC2 is running, application is running.
  T+20: Root cause found: EIP still associated to old terminated instance's allocation.

ROOT CAUSE:
  Process error: engineer forgot to reassociate EIP from i-aaa to i-bbb.

  What happened:
    i-aaa terminated → EIP disassociated automatically (goes back to account, unassociated)
    api.example.com → A record → 54.100.200.50 (EIP)
    54.100.200.50 → now unassociated → traffic dropped at AWS network layer
    EC2 i-bbb has NO public IP (no EIP, no auto-assigned public IP in private subnet)

FIX:
  # Reassociate EIP immediately (takes 10-30 seconds to propagate)
  aws ec2 associate-address \
    --instance-id i-bbb \
    --allocation-id eipalloc-xxxxxxxx

PREVENTION:
  Runbook: instance replacement MUST include EIP reassociation step
  Better: use ENI-based EIP pattern
    EIP associated to ENI (eni-xxxx), not directly to instance
    Instance replacement: reattach same ENI to new instance
    EIP follows ENI automatically. No manual reassociation.

  Best: don't use EIP for public-facing application
    Use ALB (DNS alias) → Route 53 health check → auto-failover
    EIP only for bastion/VPN/NAT (non-user-facing)
```

---

## SECTION 7 — AWS & Cloud Mapping

```
INCIDENT:
  Company exposes API to financial partner. Partner requires 2 static IPs to allowlist.
  Team creates ALB (incorrectly) and gives partner ALB DNS hostname.
  Partner reports: IP addresses keep changing, they can't maintain their firewall rules.

ROOT CAUSE:
  ALB: DNS-based, dynamic IPs. AWS can change ALB IP addresses at any time.
  Each ALB DNS lookup can return different IP(s).
  Partner firewall: requires static IPs in allowlist. Dynamic IPs break this.

FIX:
  Replace ALB with NLB in the path for the partner endpoint.
  NLB: supports assigning EIP per AZ → static IPs.

  Architecture:
    Route53: partner-api.example.com → NLB DNS
    NLB (us-east-1a): EIP = 54.100.200.50  ← partner allowlists this
    NLB (us-east-1b): EIP = 54.100.200.51  ← partner allowlists this
    NLB → target group → EC2/ECS (unchanged backend)

  Cost: 2 EIPs on NLB = free while in use (associated to running NLB)
  NLB cost: $0.008/hour + $0.006/LCU-hour

ALTERNATIVE: Global Accelerator
  Provides 2 static Anycast IPs (from AWS edge network)
  Routes to ALB/NLB in target region
  Use when: global clients, static IPs + low-latency routing needed
  Cost: $0.025/hour + data transfer
```

---

## SECTION 8 — Interview Preparation

**Beginner:**

**Q: What is an Elastic IP and why do you need one?**
**A:** When you stop and restart an EC2 instance, its public IP address changes (AWS reclaims the old one). If your domain's DNS record points to the old IP â€” your site becomes unreachable. An Elastic IP is a static public IPv4 address you own in your AWS account â€” it stays the same until you release it. You can associate it with an EC2 instance, and if that instance is replaced, you re-associate the same Elastic IP to the new instance. DNS doesn't change. Elastic IPs are free ONLY while associated with a running instance. You pay .005/hour when allocated but NOT associated (to discourage hoarding).

**Q: What is the most common mistake with Elastic IPs and how do you avoid it?**
**A:** Allocating Elastic IPs and forgetting about them â€” paying for unused IPs. Each unattached Elastic IP costs ~.60/month. After any infrastructure cleanup (deleted EC2, changed architecture), check for unattached Elastic IPs: AWS Console â†’ EC2 â†’ Elastic IPs â†’ filter "Not associated." Release unused ones immediately. Also: limit of 5 Elastic IPs per region per account by default (must request increase). Better practice: use Route 53 ALIAS records pointing to an ALB (which has its own stable DNS hostname) instead of Elastic IPs for production web traffic. Elastic IPs are more relevant for legacy single-instance setups.

**Q: Can you associate one Elastic IP with multiple EC2 instances simultaneously?**
**A:** No â€” one Elastic IP can be associated with exactly ONE network interface (ENI) at a time. To switch: disassociate from old instance, associate with new instance. This process takes seconds but the old instance temporarily loses its public IP during the switch. For high availability: don't use Elastic IPs as the entry point for production traffic. Use an ALB instead â€” it distributes traffic across multiple instances and handles failover. Use Elastic IPs for: bastion hosts (one IP to whitelist in corporate firewall), legacy applications that require a fixed IP, NAT Gateway (every NAT GW has an associated Elastic IP).

---

**Intermediate:**

**Q: What is the Elastic IP reassociation pattern for zero-downtime failover and what are its limitations?**
**A:** Pattern: maintain two EC2 instances (primary, standby). Primary has Elastic IP. Monitoring detects primary failure â†’ script re-associates Elastic IP to standby instance (ws ec2 associate-address --instance-id i-standby --allocation-id eipalloc-xxx). Reassociation takes ~30 seconds. During that time: TCP connections to old IP fail. DNS still points to the Elastic IP (which is now on standby).
*Limitations:* 30-second outage window during failover. Manual (or automation-required) failover. Doesn't scale (one Elastic IP = one instance). Better alternative: Multi-AZ ALB handles failover automatically in < 5 seconds without Elastic IPs.

**Q: How is an Elastic IP different from an IPv6 address in AWS?**
**A:** *Elastic IP:* static IPv4 public address, allocated to your account, manually assigned. .005/hr unattached. *IPv6:* globally routable IPv6 addresses assigned from AWS's IPv6 pool. Free permanent allocation. EC2 in dual-stack VPC (IPv4+IPv6) gets a persistent IPv6 address that doesn't change on stop/start â€” you don't need an Elastic IP if you use IPv6. IPv6 adoption on the internet is still growing (~40% of internet traffic). Production consideration: for pure IPv6 backend (no public IPv4 needed) â€” free static addressing. For public-facing services: dual-stack (IPv4+IPv6) is the modern approach.

**Q: What is the Elastic IP limit per AWS account and how do you request an increase?**
**A:** Default: 5 Elastic IPs per Region. To request more: AWS Support â†’ Service Limit Increase â†’ EC2 Elastic IPs â†’ specify region and desired limit + business justification. Typically approved for legitimate use cases. Better question: if you need many Elastic IPs, question the architecture. If you have 50 EC2 instances as web servers, you don't need 50 Elastic IPs â€” you need ONE ALB DNS name. Elastic IPs per service = architectural anti-pattern for modern cloud design. Legitimate needs for many EIPs: NAT Gateways per AZ (3-6 EIPs in multi-AZ setups), outbound IP allow-listing for third-party APIs.

---

**Advanced (System Design):**

**Scenario 1:** A third-party payment processor requires that all requests from your application come from a fixed IP address for allow-listing. Your application runs on ECS Fargate with 5-15 tasks (variable). Each Fargate task gets a different IP. Design a solution that presents a fixed IP to the payment processor while maintaining Fargate's elasticity.

*NAT Gateway with Elastic IP:*
(1) Place all ECS Fargate tasks in private subnets.
(2) NAT Gateway in each AZ has an Elastic IP (static), e.g., 52.1.2.3.
(3) All outbound traffic from Fargate tasks routes through NAT Gateway â†’ appears as 52.1.2.3 to the payment processor.
(4) Register 52.1.2.3 with the payment processor's allow-list.
(5) Fargate can scale to any number of tasks â€” all outbound traffic exits through the same 1-3 NAT Gateway EIPs.
*Multi-AZ variant:* 2-3 NAT Gateways (one per AZ) = 2-3 different EIPs. Register all of them with the payment processor.

**Scenario 2:** A developer has been manually managing Elastic IP associations via the AWS console. Now you're migrating to infrastructure-as-code (Terraform). What problems can arise when importing existing Elastic IPs into Terraform state and how do you handle them?

*Problems:*
(1) *Import process:* 	erraform import aws_eip.main eipalloc-xxxxx. If you forget to import before applying, Terraform sees the EIP in code but not in state â†’ tries to create a NEW EIP â†’ you now have a duplicate.
(2) *Association import:* separately import ws_eip_association resource if it exists: 	erraform import aws_eip_association.main {association-id}.
(3) *Destroy danger:* if you add an EIP to Terraform but accidentally run 	erraform destroy on just that resource, you lose the IP and DNS pointing to it breaks.
(4) *Lifecycle rule nudge:* for Elastic IPs that MUST NOT be accidentally destroyed: add lifecycle { prevent_destroy = true } in Terraform resource.
*Process:* (1) Import existing EIPs first. (2) Run 	erraform plan â€” should show zero changes if imported correctly. (3) Add prevent_destroy = true. (4) Code review every change that touches EIP resources.

