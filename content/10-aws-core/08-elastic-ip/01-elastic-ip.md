# Elastic IP (EIP)

## FILE 01 OF 03 — Core Concepts, Architecture & Production Patterns

> **Architect Training Mode** | Senior Principal Architect Perspective
> _Optimized for: design judgement · tradeoff evaluation · failure prediction · production debugging_

---

## SECTION 1 — Intuition (Explain Like a 12-Year-Old)

```
PHYSICAL WORLD EQUIVALENT:
  Data center: server has a static IP from the ISP permanently assigned to a NIC
  AWS without EIP: EC2 public IP = dynamically assigned, changes on STOP/START

WITHOUT ELASTIC IP:
  EC2 → start: public IP = 52.23.14.7
  EC2 → stop/start: public IP = 54.198.22.91 (different IP every time)

  Problem: DNS A record → 52.23.14.7 → EC2 stops for maintenance → new IP
  DNS TTL expires (300s) → clients resolve again → new IP
  But: customers with cached DNS → still hitting old dead IP

WITH ELASTIC IP:
  EIP = a static IPv4 address you own in your AWS account
  EIP persists until you release it (not until you stop the instance)
  Associate EIP to EC2: the public address is now fixed
  EC2 stops/starts/replaced → reassociate EIP → same IP address maintained

REAL-WORLD USE:
  DNS A record: api.myapp.com → 54.100.200.50 (EIP)
  EC2 replaced (AMI update, instance type change): reassociate EIP
  External clients, partner firewall allowlists: same IP, zero change needed
```

---

## SECTION 2 — Core Technical Explanation

```
TECHNICAL DEFINITION:
  Elastic IP = static IPv4 address in a Region
  You allocate it from AWS IPv4 pool (or your own BYOIP range)
  You associate it with: EC2 instance | ENI (Elastic Network Interface)

ALLOCATION vs ASSOCIATION:
  Allocate: reserve the IP in your account (cost starts if unassociated)
  Associate: link the IP to a specific EC2 instance or ENI
  Disassociate: unlink (IP remains in account, cost continues)
  Release: permanently return the IP to AWS pool

EIP NAT FUNCTION (same as IGW → EIP maps to private IP):
  EC2 private IP: 10.0.1.50
  EC2 EIP: 54.100.200.50
  Inbound packet to 54.100.200.50 → AWS translates → delivered to 10.0.1.50
  Outbound from 10.0.1.50 → translated to 54.100.200.50 for external delivery

  Inside the EC2 instance: eth0 shows private IP (10.0.1.50) only
  The public IP translation happens at the AWS network layer (outside OS)
  Exception: EIP on ENI with source/dest check disabled (VPN/NAT appliances)

LIMITS:
  Default: 5 EIPs per Region per account (soft limit, can request increase)
  Each EIP = 1 IPv4 address
  EIP can be moved between instances (not simultaneously)
  Cross-Region: NOT possible (EIP is Region-scoped)
```

---

## SECTION 3 — Architecture Diagram (MANDATORY)

```
PATTERN 1: EC2 with Elastic IP (classic, direct access)

  Internet
     │
  [EIP: 54.100.200.50]
     │ (AWS NAT — external)
  [EC2: 10.0.1.50] — private subnet or public subnet

  Use case: NAT instance, bastion host, self-hosted VPN endpoint

PATTERN 2: EIP on ENI (flexible, portable across instances)

  ENI (eni-xxxx) ← EIP associated to ENI
     └── attached to EC2-A

  EC2-A fails → detach ENI → attach to EC2-B
  EIP moves with ENI. No reassociation needed.

  Use case: high-availability failover (EIP + ENI failover = faster than reassociation)
  Failover time: < 30 seconds (NIC swap vs instance replacement)

PATTERN 3: NLB with EIP (static IP for load balanced traffic)

  No EIP needed on EC2 directly.
  Network Load Balancer: supports assigning an EIP per AZ

  NLB in us-east-1a: EIP = 54.100.200.50
  NLB in us-east-1b: EIP = 54.100.200.51
  NLB in us-east-1c: EIP = 54.100.200.52

  Result: 3 static IPs for the NLB (for partner allowlisting)
  Use case: B2B APIs where partners must allowlist specific IPs
  ALB: does NOT support EIP (dynamic IPs only — use NLB for static)

PATTERN 4: NAT Gateway with EIP

  Private subnet EC2 → NAT Gateway (EIP: 54.200.100.30) → Internet

  Outbound traffic from private subnet appears as the NAT GW EIP
  Useful: third-party APIs requiring your IP whitelisted (call from private subnet)
  EIP on NAT GW: 1-to-1 per AZ NAT GW
```

---

## SECTION 4 — Request Flow (MANDATORY FLOWCHART)

```
MODERN ARCHITECTURE: most services don't need EIP directly

Load Balanced Applications:
  ALB: use Route 53 alias record (handles dynamic ALB IPs automatically)
  EIP not applicable to ALB (ALB has multiple dynamic IPs by design)

DNS-addressed Services:
  EC2 with Route 53 record: use an alias or A record with low TTL
  Each start: update Route 53 A record (automation with scripts or Lambda)
  Health checks: Route 53 health check → auto-failover to standby EC2

Containers on ECS Fargate:
  Tasks use ENI with private IP. External access: via ALB/NLB, not EIP.

RDS, ElastiCache, Other Managed Services:
  AWS-managed DNS endpoints only. No public IP exposure needed.

WHEN EIP IS ACTUALLY NEEDED:
  ✓ Bastion host with fixed IP (for security group allowlist)
  ✓ Self-managed VPN endpoint (strongSwan, WireGuard on EC2)
  ✓ NLB for B2B API (static IPs for partner allowlisting)
  ✓ NAT Gateway (always uses EIP internally for outbound)
  ✓ Legacy systems that require fixed IP instead of DNS
```

---

### Cost Model

```
PRICING:
  EIP in-use (associated to running EC2/ENI): FREE
  EIP allocated but NOT associated: $0.005/hour = $3.60/month
  EIP associated to stopped instance: $0.005/hour = $3.60/month
  Additional EIPs on same instance (>1): $0.005/hour each

COST TRAPS:
  ✗ Developer allocates 20 EIPs for testing. Never releases them.
    → 20 × $3.60 = $72/month for unused IPs
  ✗ EC2 stopped for weekend — EIP still charged (instance stopped, not released)
    → Stop EC2 Friday PM: disassociate EIP OR terminate (if not needed)

COST OPTIMIZATION:
  Tag all EIPs with owner and purpose
  AWS Config rule: eip-attached → alert on unattached EIPs
  Cleanup automation:
    aws ec2 describe-addresses --query 'Addresses[?AssociationId==null].[AllocationId,PublicIp]'
    # Shows all unassociated (charged) EIPs
```
