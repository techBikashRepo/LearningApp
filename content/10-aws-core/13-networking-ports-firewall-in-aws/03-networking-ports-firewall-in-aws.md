# Networking Ports & Firewall in AWS

## FILE 03 OF 03 — Design Decisions, Exam Traps & Architect's Mental Model

> **Architect Training Mode** | Senior Principal Architect Perspective
> _Optimized for: design judgement · tradeoff evaluation · failure prediction · production debugging_

---

## SECTION 9 — Certification Focus (AWS SAA-C03)

```
WHICH FIREWALL LAYER SOLVES WHICH PROBLEM?

PROBLEM: Block specific bad IP addresses (DDoS, scrapers, known attackers)
  Layer: NACL (fast, stateless block — no connection established even)
  OR: WAF IP Set (if traffic comes through ALB/CloudFront)

PROBLEM: Ensure only ALB can reach EC2 (service-to-service control)
  Layer: Security Group (SG-to-SG reference — sg-alb allowed in sg-app inbound)
  NACL cannot do SG-to-SG references. SG is the right tool.

PROBLEM: Block SQL injection in HTTP request body
  Layer: AWS WAF (inspects Layer 7 — HTTP request content)
  Security Groups: Layer 4 only (IP + port). Cannot inspect request content.

PROBLEM: Protect entire subnet from east-west traffic
  Layer: NACL (applies to entire subnet, not per-instance)

PROBLEM: DDoS attack on application (volumetric + application layer)
  L3/L4 volumetric: AWS Shield Standard (free, automatic)
  L7 application DDoS: AWS WAF rate limiting + Shield Advanced

PROBLEM: Deep packet inspection, intrusion detection (IDS/IPS)
  Layer: AWS Network Firewall (Suricata rules, DNS filtering, stateful inspection)
  Most expensive option. For compliance/enterprise environments.

DECISION MATRIX:
  Type             | Security Group | NACL | WAF | Network Firewall
  -----------------|---------------|------|-----|------------------
  IP blocking      | Partial (SG)  | ✓    | ✓   | ✓
  Port filtering   | ✓             | ✓    | —   | ✓
  HTTP inspection  | —             | —    | ✓   | ✓
  SG-to-SG rules   | ✓             | —    | —   | —
  DDoS (L3/L4)     | —             | ✓    | —   | ✓
  DDoS (L7)        | —             | —    | ✓   | ✓
  IDS/IPS          | —             | —    | —   | ✓
  Cost             | Free          | Free | $   | $$$
```

---

## SECTION 10 — Comparison Table

```
PRODUCTION SECURITY ARCHITECTURE (layered):

  Internet
     │
  AWS Shield (always-on, free L3/L4 DDoS protection)
     │
  Route 53 (Shield integration — DNS flood protection)
     │
  CloudFront + AWS WAF
     │ WAF rules: SQL injection, XSS, rate limiting, geo-blocking
     │ CloudFront: TLS termination, caching, DDoS absorption at edge
     │
  ALB + AWS WAF (if WAF on ALB, not CloudFront)
     │ SG inbound: 443 from 0.0.0.0/0 (or CloudFront managed prefix list only)
     │
  NACL (web subnet)
     │ Inbound: 443, 80 allowed
     │ Deny rules for known bad CIDR blocks
     │
  Application EC2/ECS
     │ SG: allow 8080 from sg-alb ONLY
     │ SG: allow 443 outbound (AWS APIs, external calls)
     │
  NACL (app subnet)
     │
  RDS / ElastiCache
     │ SG: allow 5432 from sg-app ONLY
     │ No public access. Private subnet only.
     │
  NACL (db subnet)

ZERO-TRUST ADDITIONS:
  VPC Endpoints: S3, DynamoDB, Secrets Manager — keep traffic within AWS network (no internet)
  PrivateLink: for SaaS services → no public IP traversal
  GuardDuty: ML-based threat detection (port scans, unusual login, crypto mining)
  Security Hub: centralized security findings (GuardDuty + Config + WAF + Inspector)
```

---

## SECTION 11 — Quick Revision

```
TRAP 1: Security Groups are stateful, NACLs are stateless
  SG: allow inbound 443 → return traffic (outbound) automatically allowed
  NACL: allow inbound 443 → must ALSO allow outbound 1024-65535 for return traffic
  Exam: "connectivity fails after adding NACL rule" → forgot ephemeral ports outbound

TRAP 2: NACL rules are evaluated in number order (first match wins)
  Rule 90: DENY 0.0.0.0/0 port 443
  Rule 100: ALLOW 0.0.0.0/0 port 443
  → Port 443 blocked (rule 90 matches first, DENY wins before reaching rule 100)

  Correct: DENY rules need LOWER numbers than ALLOW rules they're meant to override
  Exam: "specific DENY rule not working" → check if there's a lower-numbered ALLOW

TRAP 3: Default NACL allows all. Custom NACL denies all by default.
  Default NACL (auto-created with VPC): ALLOW all IN + ALLOW all OUT
  Custom NACL (you create): no rules → implicit DENY all
  Exam: "created new NACL and associated → traffic stopped" → add ALLOW rules + ephemeral port outbound

TRAP 4: WAF is not enabled by default — must explicitly attach to ALB/CloudFront
  ALB created: no WAF protection by default
  Exam: "protect ALB from SQL injection" → create WAF WebACL + attach to ALB (not enabled automatically)

TRAP 5: Security Groups do NOT have explicit DENY rules (only ALLOW)
  SG: you can only ADD allow rules. Cannot write "DENY this IP"
  If IP not in any allow rule → implicitly denied
  To block a specific IP: use NACL (which supports DENY)
  Exam: "block specific abusive IP from reaching EC2" → NACL DENY rule (not SG)

TRAP 6: AWS WAF cannot protect EC2 directly — only through ALB/CloudFront/API GW
  WAF attachment points: ALB, CloudFront, API Gateway, AppSync, Cognito
  EC2 with public IP direct: WAF cannot be attached directly
  Exam: "protect direct EC2 from SQL injection" → put ALB in front, attach WAF to ALB
```

---

## SECTION 12 — Architect Thinking Exercise

```
REQUIREMENT:
  Fintech app: user data, payment processing. Must comply with PCI-DSS.
  Current: ALB → EC2 → RDS. No WAF. SGs have overly permissive rules.

HARDENING PLAN:

  Step 1: Close all unnecessary ports
  # Audit all security groups:
  # ALB SG: keep 443 inbound only (disable port 80, force HTTPS redirect at ALB)
  # App EC2 SG: keep 8080 from sg-alb only. Remove 22 from internet.
  # RDS SG: keep 5432 from sg-app only.
  # REMOVE: any 0.0.0.0/0 on non-HTTP ports

  Step 2: Enable SSM Session Manager (eliminate SSH entirely)
  # Install SSM agent on EC2 AMI
  # Grant EC2 IAM role: AmazonSSMManagedInstanceCore
  # Remove all port 22 inbound rules from all SGs

  Step 3: Deploy AWS WAF on ALB
  # Create WebACL with managed rule groups:
  - AWSManagedRulesCommonRuleSet (OWASP Top 10 coverage)
  - AWSManagedRulesSQLiRuleSet (SQL injection specific)
  - AWSManagedRulesAmazonIpReputationList (known bad IPs)
  # Rate limiting rule: 2000 requests per IP per 5 minutes
  # Start in COUNT mode → review false positives → enable BLOCK after 1 week

  Step 4: Restrict CloudFront → ALB (ALB only accepts traffic from CloudFront)
  # Add custom header from CloudFront (X-CF-Secret: random-value)
  # ALB WAF rule: block requests without this header
  # Result: direct-to-ALB attacks bypassed; CloudFront absorbs DDoS

  Step 5: Enable GuardDuty + Security Hub
  # GuardDuty: VPC Flow Logs + DNS logs + CloudTrail → threat detection
  # Security Hub: aggregate findings, compliance scoring (PCI-DSS standard)

  Step 6: NACL hardening
  # Web subnet NACL: DENY known bad CIDR blocks (IP list from threat intelligence)
  # DB subnet NACL: DENY all inbound except from app subnet CIDR (belt and suspenders)

  RESULT: 6-layer defense (Shield→CloudFront WAF→ALB WAF→SG→NACL→SSM audit)
```

---

### Architect's Mental Model

```
5 RULES I NEVER VIOLATE:

1. "Security Groups are the primary control. NACLs are the backup."
   SG: per-ENI, stateful, SG-to-SG references — most expressive and precise.
   NACL: per-subnet, stateless, blunt — good for IP CIDR blocking and subnet isolation.
   Don't over-invest in NACL complexity when SGs cover 90% of access control.

2. "Port 22 open to 0.0.0.0/0 is a critical finding. SSM Session Manager eliminates it."
   Every open port is an attack surface. SSH to internet = invitation for brute force.
   SSM: audited, no open ports, no key management, works without bastion.
   Org-level policy: deny port 22 to 0.0.0.0/0 via SCP + AWS Config rule.

3. "WAF starts in COUNT mode, never jump straight to BLOCK"
   First deploy: COUNT mode logs every rule match without blocking.
   Analyze 7-14 days of production traffic → tune false positives → enable BLOCK.
   Jumping to BLOCK immediately: risks blocking legitimate users (mobile NATs, APIs, CDNs).

4. "Defense in depth: assume every layer will be bypassed — design for it"
   WAF bypassed by sophisticated attacker → SG stops them at EC2.
   SG misconfigured → NACL blocks subnet.
   All three bypassed: GuardDuty detects unusual API calls, triggers incident response.
   Security is layers, not a single control.

5. "NACLs with DENY: specific IPs only — never use overly broad DENY rules"
   Broad DENY: can block legitimate traffic (CloudFront IPs, AWS service ranges).
   Specific DENY: block known bad CIDR blocks from threat feeds.
   Ephemeral ports: always allow outbound 1024-65535 in NACL or you break all connections.

3 MISTAKES JUNIOR ARCHITECTS MAKE:

1. Using NACL for fine-grained access control (should use SG instead)
   NACL: evaluates ALL traffic to subnet (blunt). Cannot reference other SGs.
   SG: evaluates per ENI. Can reference other SGs (sg-alb → sg-app → sg-rds chain).
   NACL for: IP blocking, subnet isolation. SG for: service-to-service control.

2. Not allowing ephemeral ports outbound in NACL
   Symptom: connection TCP handshake succeeds (port 443 allowed IN)
   But: response data never arrives (outbound ephemeral 1024-65535 blocked)
   Looks like: random intermittent drops after connection established. Hard to diagnose.

3. Assuming WAF or Shield protects everything by default
   Shield Standard: auto, free — yes, basic L3/L4 DDoS.
   WAF: NOT automatic. Must create WebACL and attach to each ALB/CloudFront.
   GuardDuty: NOT automatic. Must enable per region, per account.
   SecurityHub: NOT automatic. Must enable + link accounts.
   Activation required for all advanced security features.

30-SECOND MENTAL MODEL (Say this in an interview):
  "AWS network security has 5 layers: Shield (DDoS), WAF (L7 HTTP inspection),
   Security Groups (stateful per-ENI), NACLs (stateless per-subnet), Network Firewall (IDS/IPS).
   Security Groups: primary. NACLs: blunt IP blocking. WAF: SQL injection, rate limiting.
   Key rules: no port 22 to internet (use SSM), SGs for service-to-service control,
   NACL requires ephemeral port outbound rules (stateless = both directions explicit)."
```
