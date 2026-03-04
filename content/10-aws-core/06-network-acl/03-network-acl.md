# Network ACL (Access Control List)

## FILE 03 OF 03 — Design Decisions, SAA Exam Traps, Scenarios & Architect's Mental Model

> **Architect Training Mode** | Senior Principal Architect Perspective
> _Optimized for: design judgement · tradeoff evaluation · failure prediction · production debugging_

---

## SECTION 9 — Certification Focus (AWS SAA-C03)

```
WHEN TO ADD CUSTOM NACLs:

Tier 1 (Default NACL — allow all):
  Most small-to-medium production setups
  Security Groups handle all access control
  No IP blocklist requirements
  Operational simplicity matters more than NACL-level control

Tier 2 (Custom NACLs per subnet tier):
  Regulated environments (PCI-DSS, HIPAA)
  Defense-in-depth requirement for audit/compliance
  Need to block specific IP ranges across subnet
  Want subnet-level policy enforcement independent of Security Groups

Tier 3 (Custom NACLs + AWS WAF + GuardDuty + Shield):
  Enterprise, financial services, government
  Active DDoS mitigation strategy
  IP reputation blocking at multiple layers
  Automated incident response (Lambda triggered by GuardDuty → add NACL DENY)

DECISION GUIDE:
  "Do I need to DENY specific IP addresses?" → YES → Custom NACL required (SG can't do it)
  "Do I need defense-in-depth for compliance?" → YES → Custom NACL per subnet tier
  "Am I managing SGs well already?" → YES → Consider if NACL adds value before adding complexity
  "Do I want subnet-level policy independent of ENI SGs?" → YES → Custom NACL
```

---

## SECTION 10 — Comparison Table

```
ARCHITECTURE A: Default NACL (allow-all) + Custom Security Groups
  NACLs: default for all subnets (allow everything)
  Security Groups: custom per service, chained (sg-alb → sg-app → sg-rds)

  ✅ Simple to manage
  ✅ SG chaining provides strong micro-segmentation
  ✅ No ephemeral port headaches from NACLs
  ❌ No IP-based blocking capability
  ❌ May fail compliance audits requiring "two independent network layers"

  Best for: startups, SaaS, standard three-tier web app, teams < 10 engineers

ARCHITECTURE B: Custom NACLs per tier + Security Groups
  NACLs: custom per subnet tier (public, private, DB)
  Security Groups: custom per service

  ✅ Two-layer defense (NACL + SG) for compliance
  ✅ IP blocking possible at subnet level
  ✅ Subnet-level audit visibility
  ❌ Must maintain ephemeral port rules
  ❌ NACL changes must be coordinated with SG changes
  ❌ More complex to change (both NACL and SG must be updated for new ports)

  Best for: regulated industries, enterprises, teams with dedicated platform/security engineering

ARCHITECTURE C: WAF + NACLs + Security Groups (full stack)
  WAF: L7 rules, OWASP rules, rate limiting, IP reputation
  NACLs: subnet-level IP blocking for DDoS sources
  Security Groups: service-to-service access control

  ✅ Maximum defense depth
  ✅ WAF handles application-layer attacks (SQL injection, XSS)
  ✅ NACL handles flood attacks at network layer
  ✅ SG handles service-level access control
  ❌ Complexity: three systems to coordinate and audit
  ❌ Cost: WAF adds $5+/month base + query charges

  Best for: financial services, healthcare, e-commerce (high PCI/HIPAA requirements)
```

---

## SECTION 11 — Quick Revision

### Trap 1: NACL Rule Evaluation — First Match Wins (NOT most specific)

```
SG: all rules evaluated, most permissive wins
NACL: numbered rules, FIRST MATCH wins — evaluation stops immediately

Example:
  Rule 100: ALLOW TCP 0.0.0.0/0 port 443
  Rule 200: DENY TCP 10.10.0.0/16 port 443

Traffic from 10.10.1.5 on port 443:
  Rule 100 evaluated first: 10.10.1.5 matches 0.0.0.0/0 → ALLOW → STOP
  Rule 200 never reached → traffic ALLOWED (even though a deny exists at 200)

If you want to block 10.10.0.0/16 and allow everything else:
  Rule 100: DENY TCP 10.10.0.0/16 port 443   (specific DENY first)
  Rule 200: ALLOW TCP 0.0.0.0/0 port 443     (broad ALLOW second)

Exam trap: will show you rules in wrong order and ask "is traffic allowed?"
           Remember: lowest number wins, first match ends evaluation.
```

### Trap 2: NACLs Are Stateless — Response Traffic Needs Separate Rule

```
Most tested NACL concept after rule ordering.

Outbound NACL allows: port 443 dst 0.0.0.0/0 (outbound HTTPS)
Inbound must allow: port 1024-65535 src 0.0.0.0/0 (return traffic from server)

Without the inbound ephemeral rule: HTTPS response packets blocked by NACL inbound
Symptom: can INITIATE connection, but response never arrives

Exam question: "EC2 can make HTTPS requests but never receives responses.
                The Security Group is correctly configured. What is the issue?"
Answer: NACL is missing an inbound allow rule for ephemeral ports 1024-65535
```

### Trap 3: NACL Operates Per Subnet, Not Per Instance

```
You cannot use a NACL to block traffic to one specific EC2 in a subnet
while allowing traffic to another EC2 in the same subnet.

NACL applies to ALL traffic entering/leaving the SUBNET.
Per-instance control: Security Groups (attached to individual ENIs)

Exam: "Block HTTP access to only DB instance X in the DB subnet, not instance Y."
Answer: Security Group on instance X (remove inbound port 80 allow)
NOT: NACL (would affect all instances in the subnet)
```

### Trap 4: Default vs Custom NACL Behavior

```
Default NACL (created with VPC):
  Has rule * ALLOW ALL inbound AND outbound
  Newly created subnets: automatically associated with default NACL
  Behavior: allow everything (permissive)

Custom NACL (you create it):
  Has only rule * DENY ALL inbound AND outbound
  No allow rules by default
  If attached to subnet before adding rules: BLOCKS ALL TRAFFIC

Exam: "A new custom NACL was attached to a subnet. All instances became unreachable. Why?"
Answer: Custom NACL by default denies all traffic. No allow rules were added.
Must add explicit allow rules for desired traffic + ephemeral port rules.
```

### Trap 5: NACL Rule Limit — Soft Service Limit

```
Default limits:
  20 inbound rules per NACL
  20 outbound rules per NACL

  Rule *  (implicit DENY) doesn't count toward the limit
  Each explicit rule (ALLOW or DENY) counts

Large IP blocklists (DDoS response): 20 rules = max 20 CIDR blocks
To block 1000 IPs: request limit increase OR use AWS WAF IP set (much better)

Exam: "Company needs to block 500 IP addresses from accessing their VPC."
Answer: AWS WAF IP set (supports up to 1 million IPs), not NACL (limited rules)
NACL appropriate: blocking a handful of large CIDRs in an emergency.
```

---

## SECTION 12 — Architect Thinking Exercise

```
SCENARIO: Financial services app — PCI DSS compliance requiring two-layer network control

Requirement:
  - All cardholder data environment (CDE) subnets must have NACL + SG (two independent controls)
  - Internet traffic must be explicitly restricted at subnet level
  - DB tier must explicitly deny all internet originating traffic
  - Ability to block known fraud IP ranges quickly

DESIGN:

NACL: nacl-public-cde
  Inbound:
    Rule 50: DENY TCP [fraud-ip-list-1] ports 0-65535 — emergency blocklist
    Rule 100: ALLOW TCP 0.0.0.0/0 port 443
    Rule 110: ALLOW TCP 0.0.0.0/0 port 80
    Rule 120: ALLOW TCP 0.0.0.0/0 ports 1024-65535 (ephemeral return)
    Rule *: DENY ALL
  Outbound:
    Rule 100: ALLOW TCP 10.10.11.0/24 port 8080 (to app tier)
    Rule 110: ALLOW TCP 10.10.12.0/24 port 8080
    Rule 120: ALLOW TCP 0.0.0.0/0 ports 1024-65535 (response to clients)
    Rule *: DENY ALL

NACL: nacl-private-cde
  Inbound:
    Rule 100: ALLOW TCP 10.10.1.0/24 port 8080 (from public subnet)
    Rule 110: ALLOW TCP 10.10.2.0/24 port 8080
    Rule 120: ALLOW TCP 0.0.0.0/0 ports 1024-65535 (return from external APIs)
    Rule *: DENY ALL
  Outbound:
    Rule 100: ALLOW TCP 10.10.21.0/24 port 5432 (to DB)
    Rule 110: ALLOW TCP 10.10.22.0/24 port 5432
    Rule 120: ALLOW TCP 0.0.0.0/0 port 443 (external APIs)
    Rule 130: ALLOW TCP 10.10.1.0/24 ports 1024-65535 (response to public subnet)
    Rule *: DENY ALL

NACL: nacl-db-cde
  Inbound:
    Rule 100: ALLOW TCP 10.10.11.0/24 port 5432
    Rule 110: ALLOW TCP 10.10.12.0/24 port 5432
    Rule *: DENY ALL (no internet-originating traffic ever reaches here)
  Outbound:
    Rule 100: ALLOW TCP 10.10.11.0/24 ports 1024-65535 (response)
    Rule 110: ALLOW TCP 10.10.12.0/24 ports 1024-65535
    Rule *: DENY ALL

Security Groups:
  sg-alb: 443 from 0.0.0.0/0
  sg-app: 8080 from sg-alb
  sg-rds: 5432 from sg-app

PCI DSS AUDIT EVIDENCE:
  Two independent network controls: NACL (documented) + SG (documented)
  DB tier: NACL explicitly blocks internet, SG allows only app tier
  Fraud IP blocking: NACL rule 50 updated in < 5 minutes by on-call
  VPC Flow Logs: 90-day retention in S3, Athena for queries
```

---

### Interview Q&A

**Q: "When would you use a NACL versus a Security Group?"**

Good answer: "Both can control traffic, but they serve different purposes. Security Groups are per-ENI, stateful, allow-only — they're the primary access control between services, and I use SG-to-SG references for service-level micro-segmentation. NACLs are per-subnet, stateless, and crucially can have explicit DENY rules, which Security Groups cannot. I reach for NACLs in three situations: emergency IP blocking during a DDoS or fraud incident, compliance requirements for two independent network control layers like PCI-DSS, or subnet-wide policies where I want a blanket rule that applies regardless of how individual Security Groups are configured. The gotcha with NACLs is they're stateless — you must add outbound rules for ephemeral ports 1024-65535 to allow return traffic or connections will hang."

---

## === ARCHITECT'S MENTAL MODEL ===

### 5 Decision Rules for Network ACLs

1. **NACLs for DENY; Security Groups for ALLOW.** Security Groups can only allow. NACLs can block. The most practical use of a NACL in production is the DENY rule: blocking a specific CIDR range during a DDoS incident, blocking compliance-violating source ranges, or emergency fraud IP blocking. For normal access control, SGs are better because they're stateful and per-ENI. NACLs don't replace SGs — they add the DENY capability that SGs lack.

2. **Always add ephemeral port rules (1024-65535) to custom NACLs.** This is the single most common NACL mistake. Every custom NACL that allows inbound connections needs an outbound rule for ephemeral ports, and vice versa. Without it, TCP handshake completes but no data flows. Memorize: TCP is stateful, NACLs are not — you must explicitly allow both halves of every conversation.

3. **Lower rule number wins. Put specific DENYs before broad ALLOWs.** NACL rule evaluation stops at the first match. If you want to deny 10.x.x.x but allow 0.0.0.0/0, the DENY for 10.x.x.x must have a LOWER rule number than the ALLOW for 0.0.0.0/0. This is opposite to most firewall mental models where "deny-specific before allow-broad" seems counterintuitive until you internalize first-match semantics.

4. **Attach NACL AFTER adding rules. Never the reverse.** Custom NACLs default to deny-all. Associating a new NACL with a subnet before its rules are configured = immediate outage for all resources in that subnet. In Terraform: use `depends_on` to enforce rule creation before association. In manual deployments: add all rules, verify in console, then type the association.

5. **For large IP blocklists, use AWS WAF, not NACLs.** NACLs default to 20 rules per direction. During a DDoS with 50 attacker CIDRs, NACLs become unwieldy. WAF IP sets handle thousands of IPs efficiently and integrate with CloudFront and ALB. NACLs are for emergency first response (blocking 3-5 large CIDRs in minutes); WAF handles systematic, large-scale IP reputation management.

### 3 Common Mistakes

1. **Attaching a custom NACL to a production subnet without adding rules first.** Immediate deny-all. All traffic blocked. Every service in the subnet goes down. No grace period, no gradual rollout — one API call and the subnet is dark. Always verify rule count > 0 (beyond the \* catch-all) before associating.

2. **Missing outbound ephemeral port rules.** The symptom is mysterious: connections establish but data doesn't flow, or connections drop after TLS handshake. Engineers spend hours debugging application code and Security Groups. The fix is one NACL outbound rule: allow TCP 1024-65535 to the appropriate destination. Add this rule by default whenever you have any inbound connection allowed.

3. **Using NACLs for per-instance control.** NACLs are subnet-wide. "I want to block this one IP from reaching my Redis instance, not my RDS" → cannot be done with NACL (affects all resources in the subnet). Security Groups on the specific ENI are the correct mechanism. Know the boundary: NACL for subnet policy, SG for resource policy.

### 1 Clear Interview Answer (30 Seconds)

> "Network ACLs are subnet-level stateless packet filters with numbered rules evaluated in order — first match wins. Unlike Security Groups, they have explicit DENY rules, which is why I use them in two scenarios: emergency IP blocking during incidents (Security Groups can't deny specific CIDRs) and defense-in-depth for compliance where two independent network control layers are required. The key operational gotcha is statefulness: NACLs are stateless, so I must add outbound rules for ephemeral ports 1024-65535 to allow return traffic for any inbound connection I permit, or the connection hangs after handshake. Security Groups are my primary access control layer; NACLs add subnet-level DENY capability on top."

---

_End of Network ACL 3-File Series_
