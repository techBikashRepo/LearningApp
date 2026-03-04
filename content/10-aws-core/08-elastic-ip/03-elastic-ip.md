# Elastic IP (EIP)

## FILE 03 OF 03 — Design Decisions, Exam Traps & Architect's Mental Model

> **Architect Training Mode** | Senior Principal Architect Perspective
> _Optimized for: design judgement · tradeoff evaluation · failure prediction · production debugging_

---

## SECTION 9 — Certification Focus (AWS SAA-C03)

```
DECISION TREE:

"Do I need a fixed public IP address?"
  │
  ├── Is this for a LOAD BALANCER (ALB/NLB)?
  │     ALB: never needs EIP. Use Route 53 alias record → always works.
  │     NLB: needs EIP ONLY if external partners require static IPs to allowlist.
  │
  ├── Is this for a USER-FACING application on EC2?
  │     No. Use ALB in front → Route 53 alias → no fixed IP needed on EC2.
  │     EC2 private IP + ALB = correct pattern. No EIP.
  │
  ├── Is this a BASTION HOST or ADMIN server?
  │     Possibly yes. EIP ensures consistent IP for your own VPN/firewall allowlist.
  │     Better: replace bastion entirely with SSM Session Manager (no public IP needed).
  │
  ├── Is this a VPN ENDPOINT (self-managed VPN on EC2)?
  │     Yes. VPN endpoint must have fixed IP for peer configuration.
  │     EIP is correct here.
  │
  ├── Is this an OUTBOUND IP for API calls to 3rd party?
  │     Use NAT Gateway EIP (in private subnet architecture).
  │     NAT GW gets EIP. EC2 in private subnet. No EC2 EIP needed.
  │
  └── Is this LEGACY (on-prem allowlist requires specific IP)?
        EIP is acceptable for migration phase. Plan DNS-based architecture long-term.

SUMMARY TABLE:
  Scenario                  | EIP Needed? | Better Alternative
  --------------------------|-------------|-------------------------------
  User-facing web app       | No          | ALB + Route 53 alias
  B2B API static IPs        | Yes (NLB)   | NLB EIP per AZ
  Bastion host              | Optional    | SSM Session Manager (no EIP)
  Self-managed VPN          | Yes         | AWS Managed VPN (no EC2 needed)
  Private subnet outbound   | No (NAT GW) | NAT GW automatically gets EIP
  High availability failover| ENI+EIP     | ALB with multiple AZ targets
```

---

## SECTION 10 — Comparison Table

```
EIP vs Route 53 Alias (for public-facing apps):
  EIP: fixed IP → DNS A record. Problem: manual reassociation on EC2 replace.
  Route 53 Alias → ALB: ALB handles instance health + replacement automatically.
  Winner: Route 53 + ALB for applications. EIP for infrastructure endpoints.

EIP vs Global Accelerator (for global static IPs):
  EIP: single Region, 1 IP per AZ
  Global Accelerator: 2 static Anycast IPs globally → routes to nearest healthy Region
  Use Global Accelerator when: need static IPs + multi-Region failover + low latency

EIP on EC2 vs EIP on ENI:
  EIP on EC2: simple, but reassociation required on instance replacement
  EIP on ENI: EIP follows ENI, ENI can be detached and reattached to new instance
  Win: ENI pattern for faster, more reliable failover (30s vs minutes)

EIP vs NAT Gateway (for outbound static IP):
  Don't create EC2 NAT instance with EIP — operational overhead, no HA.
  Use AWS Managed NAT Gateway (inherits EIP automatically, fully managed, HA per AZ).
```

---

## SECTION 11 — Quick Revision

```
TRAP 1: EIP is free only when associated to a running instance
  Associated to STOPPED instance: billed ($0.005/hour)
  NOT associated: billed ($0.005/hour)
  Associated to RUNNING instance: FREE
  Exam: "how to avoid EIP charges?" → Release it, or keep it associated to running instance

TRAP 2: EIP is Region-scoped (cannot move cross-region)
  EIP allocated in us-east-1 → cannot use in eu-west-1
  Solution: allocate a new EIP in the target region
  Exam: "static IP for multi-region DR" → Global Accelerator provides 2 Anycast IPs globally

TRAP 3: Default limit is 5 EIPs per Region
  Exam: "need 10 static IPs for NLB across 5 AZs in 2 regions" → request limit increase
  Soft limit: request via Support or Service Quotas console

TRAP 4: EC2 inside OS sees its private IP only (not the EIP)
  curl http://169.254.169.254/latest/meta-data/public-ipv4 → returns EIP
  ip addr show eth0 → returns private IP (10.x.x.x) only
  Exam: "application reads its own IP from OS, gets private IP, but should report public"
  → read from instance metadata service (IMDS)

TRAP 5: ALB does NOT support EIP
  ALB: dynamic IPs, DNS-based only
  NLB: supports EIP per AZ (1 per subnet/AZ)
  Exam: "client requires static IP for ALB" → replace ALB with NLB + EIP
```

---

## SECTION 12 — Architect Thinking Exercise

```
REQUIREMENT:
  Financial data company exposes REST API to 3 enterprise clients.
  Each client requires 2 static IPs to allowlist in their corporate firewall.
  System must be highly available across 2 AZs.

SOLUTION DESIGN:
  1. Network Load Balancer (NLB) — not ALB
     NLB supports assigning 1 EIP per AZ

  2. EIP allocation:
     EIP-1 (54.100.200.50) → assigned to NLB in us-east-1a
     EIP-2 (54.100.200.51) → assigned to NLB in us-east-1b

  3. Give clients both IPs to allowlist:
     54.100.200.50 and 54.100.200.51
     NLB DNS resolves to both (health-checked)

  4. Backend: ECS Fargate tasks registered in NLB target group
     Port 443 (HTTPS). TLS termination at NLB or application.

  5. Future-proofing:
     Add us-east-1c → allocate EIP-3, notify clients to add 3rd IP
     Or: use Global Accelerator (2 Anycast IPs, fixed, regardless of AZ count)

COST:
  NLB: $0.008/hour = $5.76/month base + LCU charges
  EIPs: free while associated to running NLB
  Compare to Global Accelerator: $18/month + $0.025/hour + data transfer
  Decision: NLB+EIP for single-region, GA for multi-region failover requirement
```

---

### Architect's Mental Model

```
5 RULES I NEVER VIOLATE:

1. "Release EIPs immediately when no longer in use — they charge even while idle"
   EIP is not free like S3 or SG. It costs $3.60/month per unused IP.
   IaC: only way to guarantee EIPs are managed (Terraform/CloudFormation auto-release).

2. "Never put EIP directly on a user-facing application server"
   ALB + Route 53 is the correct pattern. EIP = infrastructure layer only.
   EIP on app server → can't horizontally scale (1 EIP = 1 instance).

3. "Associate EIP to ENI, not directly to the instance, for HA failover"
   ENI can be detached and reattached in <30 seconds.
   EIP on ENI = instant failover without DNS TTL wait.

4. "NLB is the only load balancer that supports static IPs"
   When anyone says 'we need a fixed IP for our load balancer' → NLB + EIP or Global Accelerator.
   Not ALB. ALB's dynamic IPs are by design.

5. "Default 5 EIP limit per Region is hit faster than you think on large accounts"
   Plan EIP usage. Document all allocations. Request quota increase proactively.
   One NLB with 3 AZs = 3 EIPs. Two such NLBs = 6 EIPs = over default limit.

3 MISTAKES JUNIOR ARCHITECTS MAKE:

1. Forgetting to release EIPs after test/dev teardown
   "I terminated the EC2, billing should stop." EIP billing continues.
   Always: terminate EC2 + release EIP. Or use IaC (terraform destroy handles both).

2. Using EIP for horizontal scaling
   1 EIP → 1 instance. Load-balanced systems can't share 1 EIP across 3 instances.
   Use ALB for horizontal scale. EIP is point-to-point.

3. Confusing EIP cost model (charged when NOT in use)
   The unusual pricing: charged when NOT associated, free when running.
   Counterintuitive: running costs $0, idle costs $3.60/month.

30-SECOND MENTAL MODEL (Say this in an interview):
  "Elastic IP is a static public IPv4 address you own in a region.
   It's free when associated to a running instance, but charges when idle.
   Use cases: bastion hosts, VPN endpoints, NLB static IPs for B2B partners.
   Most modern applications don't need EIP — use ALB + Route 53 instead.
   Core principle: EIP is an infrastructure tool, not an application tool."
```
