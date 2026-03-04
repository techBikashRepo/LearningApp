# Network ACL (Access Control List)

## FILE 02 OF 03 — Production Failures, Incidents, Debugging & Operations

> **Architect Training Mode** | Senior Principal Architect Perspective
> _Optimized for: design judgement · tradeoff evaluation · failure prediction · production debugging_

---

## SECTION 5 — Real World Example

```
INCIDENT TIMELINE:
T+0:   Security team requests: "Add NACL to production DB subnets for compliance audit."
T+5:   Engineer creates custom NACL in Terraform. terraform apply runs.
T+6:   Terraform creates NACL resource. aws_network_acl_association applied.
T+7:   All RDS connections fail. ECS tasks: "could not connect to server: Connection timed out"
T+8:   100% error rate on all API endpoints. Monitoring fires.
T+15:  Rollback started. terraform destroy on aws_network_acl_association.
T+17:  Connectivity restored. Default NACL reattached to DB subnets.
T+20:  Root cause investigation.

ROOT CAUSE:
  Custom NACL when created: default states are rule * DENY ALL (inbound and outbound)
  No allow rules were added yet (Terraform aws_network_acl_rule resources hadn't been applied yet)

  NACL association applied BEFORE rules: subnet immediately under deny-all NACL
  Even though the aws_network_acl_rule resources were in the same Terraform plan,
  the association was applied first because of implicit dependency ordering

  Result: DB subnets refused all traffic — RDS unreachable — full API failure

ACTUAL TERRAFORM MISTAKE:
  # BAD ordering
  resource "aws_network_acl_association" "db" {
    subnet_id      = aws_subnet.db.id
    network_acl_id = aws_network_acl.db.id
  }

  resource "aws_network_acl_rule" "db_inbound" {
    network_acl_id = aws_network_acl.db.id
    # ... rules
  }
  # Terraform may apply association BEFORE rules (no explicit dependency)

CORRECT PATTERN:
  resource "aws_network_acl_rule" "db_inbound" {
    network_acl_id = aws_network_acl.db.id
    rule_number    = 100
    protocol       = "tcp"
    rule_action    = "allow"
    cidr_block     = "10.10.11.0/24"
    from_port      = 5432
    to_port        = 5432
  }

  resource "aws_network_acl_association" "db" {
    subnet_id      = aws_subnet.db.id
    network_acl_id = aws_network_acl.db.id
    depends_on     = [aws_network_acl_rule.db_inbound]  # EXPLICIT DEPENDENCY
  }

  OR: use aws_network_acl resource with inline_ingress/ingress blocks (single resource)

PREVENTION:
  ├── Always add rules BEFORE associating NACL with subnet
  ├── Use explicit depends_on in Terraform
  ├── Test NACL changes in non-production first
  └── Add to deployment runbook: "validate DB connectivity after NACL change"
```

---

## SECTION 6 — System Design Importance

```
INCIDENT:
  Team adds NACLs to public subnets for the first time (compliance requirement).
  Tightened public NACL inbound: allow 443, 80, deny all.
  Tightened public NACL outbound: allow 8080 to app subnets, deny all.

  After deploy: ALB health checks fail. 50% of user connections drop mid-session.

SYMPTOMS:
  ├── TCP connection established (three-way handshake completes)
  ├── HTTPS request sent (SSL handshake completes... sometimes)
  ├── Response begins but connection drops
  ├── Some requests intermittently succeed, most fail

WHY INTERMITTENT?
  Clients use different ephemeral ports. Some happen to fall in ranges that are allowed.
  Pure luck — some users succeed, most don't.

ROOT CAUSE:
  Public NACL outbound: only allows 8080 to app subnet.
  Response traffic to internet clients: source=ALB:443, destination=client:4925x
  The client's ephemeral port (49xxx) is NOT in the outbound allow list.
  NACL drops the response packet.

  Client: sends request → TCP handshake → request received by ALB → ALB processes
          → ALB tries to respond → response packet blocked at NACL outbound → client waits
          → TCP retransmits → still blocked → connection timeout

FIX:
  Add to public NACL outbound rules:
  Rule 500: ALLOW TCP 1024-65535 → 0.0.0.0/0 (return traffic to internet clients)

  NOTE: This looks "permissive" but TCP sessions are initiated by clients.
        The internet cannot initiate connections TO your servers on 1024-65535
        because no server is LISTENING on those ports. SG controls the listening ports.

TESTING TOOL — Detect NACL issues:
  tcpdump on EC2: sudo tcpdump -i eth0 -n 'tcp port 443'
  If you see: SYN, SYN-ACK, ACK (handshake), PSH (data) but no response → NACL outbound dropping response

  VPC Flow Logs: action=REJECT on outbound → responsible NACL identified
```

---

## SECTION 7 — AWS & Cloud Mapping

```
SCENARIO: Production ALB under high-volume request flood

2:47 AM: CloudWatch alarm — ALB RequestCount 10x normal
CloudFront logs: 96% of spike from 3 source IP ranges:
  44.196.0.0/22, 52.201.128.0/18, 185.220.101.0/24

IMMEDIATE RESPONSE USING NACL:

# Add DENY rules for attacking CIDRs (low rule numbers to evaluate first)
aws ec2 create-network-acl-entry \
  --network-acl-id acl-public-xxxx \
  --ingress \
  --rule-number 10 \
  --protocol tcp \
  --rule-action deny \
  --cidr-block 44.196.0.0/22 \
  --port-range From=0,To=65535

aws ec2 create-network-acl-entry \
  --network-acl-id acl-public-xxxx \
  --ingress \
  --rule-number 11 \
  --protocol tcp \
  --rule-action deny \
  --cidr-block 52.201.128.0/18 \
  --port-range From=0,To=65535

aws ec2 create-network-acl-entry \
  --network-acl-id acl-public-xxxx \
  --ingress \
  --rule-number 12 \
  --protocol tcp \
  --rule-action deny \
  --cidr-block 185.220.101.0/24 \
  --port-range From=0,To=65535

WHY NACL NOT SECURITY GROUP FOR THIS?
  ├── SG: allow-only, no DENY → cannot block specific CIDRs
  ├── WAF: IP set rule (can also do this, better for L7 — but slower to propagate)
  ├── NACL: stateless, subnet-level, very fast packet drop
  └── NACL DENY: most resource-efficient (drops before ALB even sees the packet)

RESULT:
  Blocking at NACL: packets dropped at subnet boundary
  ALB: no longer processes flood requests
  CPU/connection table: drops to normal
  Recovery: 3 minutes from NACL rule add to traffic normalization

CLEANUP AFTER INCIDENT:
  Remove the DENY rules once attack subsides
  Or: use AWS WAF Managed Rules + rate limiting for persistent protection
  NACL DENY is a good emergency response, not a permanent solution

LIMITATION:
  NACL: max 20 inbound rules (default), soft limit increase to 40
  For large-scale blocklists (1000s of IPs): use AWS WAF IP set instead
  WAF can handle large IP lists efficiently (up to 1 million IPs in managed lists)
```

---

## SECTION 8 — Interview Preparation

**Beginner:**

**Q: What is a Network ACL and how is it different from a Security Group?**
**A:** A Network ACL (Access Control List) is a stateless firewall at the subnet level. Key differences from Security Groups: (1) *Scope:* Security groups protect individual resources (one EC2); NACLs protect an entire subnet (all resources in it). (2) *Stateless:* NACLs don't track connections â€” you must explicitly allow both request AND response traffic. (3) *Rule evaluation:* NACLs have numbered rules evaluated in order (lowest number first). First matching rule wins. Security groups evaluate ALL rules. (4) *Explicit deny:* NACLs can explicitly block traffic. Security groups can only allow â€” everything not explicitly allowed is denied.

**Q: Why do NACLs require you to explicitly allow return traffic (ephemeral ports)?**
**A:** NACLs are stateless â€” they don't remember that you allowed an inbound connection when evaluating the outbound response. Example: you allow inbound HTTP (port 80). When the server responds, it sends traffic FROM port 80 TO the client's ephemeral port (a random high port, usually 1024-65535). Without an outbound rule allowing this response traffic â€” your NACL drops the response. The fix: add an outbound rule allowing ports 1024-65535 (ephemeral port range) to  .0.0.0/0. Security groups handle this automatically (stateful), NACLs don't.

**Q: What is the default NACL that comes with a VPC and is it safe to use?**
**A:** Each VPC has a default NACL that allows ALL inbound and ALL outbound traffic (rules * deny, but explicit rules 100 allow all). If your subnets are associated with the default NACL â€” NACLs provide zero protection. This is fine because Security Groups provide the protection. The default NACL is intentionally permissive so you don't need to think about ephemeral ports or response traffic. A custom NACL starts with DENY ALL â€” you must explicitly add all allow rules including ephemeral port responses. Only use custom NACLs for specific scenarios (blocking a specific IP range, explicit compliance requirement).

---

**Intermediate:**

**Q: When should you use a Network ACL vs relying solely on Security Groups?**
**A:** Security groups are sufficient for most applications. Use NACLs ADDITIONALLY when: (1) *Explicit IP blocking:* you want to block a specific IP range associated with a DDoS attack or known bad actor â€” NACLs can explicitly DENY 203.0.113.0/24. Security groups can only ALLOW â€” they can't deny a specific IP. (2) *Subnet-level isolation:* completely isolate the data subnet so even if a security group misconfiguration happens, the NACL is a second layer that blocks unauthorized access. (3) *Compliance:* some frameworks require network-layer controls in addition to resource-level controls. Defense in depth: NACLs as the outer layer, Security Groups as the inner layer.

**Q: What is the order of traffic evaluation when both NACL and Security Group rules apply?**
**A:** When traffic enters a subnet: (1) NACL inbound rule evaluated first â€” traffic ALLOWED or DENIED at subnet boundary. (2) If allowed by NACL: Security Group inbound rule evaluated â€” traffic ALLOWED or DENIED at the resource. (3) Response traffic leaving the resource: Security Group outbound evaluated first â€” then NACL outbound evaluated. For traffic to reach your EC2: it must pass BOTH the NACL AND the Security Group inbound rules. To block traffic: you can block at either layer. The NACL is the first line of defense â€” blocking at NACL prevents traffic from even reaching resource-level Security Group evaluation.

**Q: What is a NACL rule number and what best practices should you follow when numbering rules?**
**A:** NACL rules are evaluated in ascending numeric order. Rule 100 is evaluated before Rule 200. First match wins â€” if rule 100 allows traffic, rules 200, 300 etc. are not checked. Best practices: (1) Start at 100, increment by 100 (leave gaps for insertion). (2) More specific rules get LOWER numbers (evaluated first). Example: block specific IP (rule 50) before the general allow all HTTPS (rule 100). (3) Never use consecutive numbers (101, 102) â€” you can't insert between them later. (4) Always end with a * (implied) or explicit DENY ALL â€” both inbound and outbound. (5) Keep rules < 20 per NACL for maintainability.

---

**Advanced (System Design):**

**Scenario 1:** Your application is under a DDoS attack. A particular IP range 198.51.100.0/24 is generating 90% of the malicious traffic. Your security team wants to immediately block this range. Describe the fastest way to do this with NACLs and the limitations of this approach.

*NACL-based block:*
(1) Go to VPC â†’ Network ACLs â†’ select the NACL associated with your public subnets.
(2) Add inbound rule: Rule Number 50 (lower than existing Allow rules), Protocol ALL, Source 198.51.100.0/24, Action: DENY.
(3) This immediately blocks all traffic from that range at the subnet boundary â€” before it even reaches ALB or EC2.

*Limitations:*
- NACL max 20 rules (default: can request increase to 40) â€” if attacker uses many /32 IPs, you'll hit the limit.
- The attack may rotate IPs quickly, making this a whack-a-mole problem.
- Better long-term solutions: AWS WAF (Web Application Firewall) â€” can block based on IP, rate rules (block IPs making > 2000 requests/5min), and geo-blocking. AWS Shield Advanced â€” automatic DDoS mitigation. CloudFront + AWS WAF â€” absorbs traffic at edge.
- NACL is a blunt tool; use it for immediate triage while setting up WAF rules.

**Scenario 2:** A junior engineer accidentally deleted the NACL allow rules for the public subnet, leaving only the implicit DENY ALL. The ALB is now unreachable. Walk through diagnosing and fixing this without taking any resources offline.

*Diagnosis:*
(1) Check NACL associated with the public subnet: ws ec2 describe-network-acls. Confirm rules are missing.
(2) VPC Flow Logs: traffic to ALB shows REJECT at NACL level.

*Fix â€” add back required rules:*
Inbound rules (re-add):
- Rule 100: Allow TCP, port 443 (HTTPS), source 0.0.0.0/0
- Rule 110: Allow TCP, port 80 (HTTP), source 0.0.0.0/0
- Rule 120: Allow TCP, ports 1024-65535, source 0.0.0.0/0 (return traffic for outbound connections)

Outbound rules (re-add):
- Rule 100: Allow TCP, port 443, destination 0.0.0.0/0 (HTTPS to internet)
- Rule 110: Allow TCP, ports 1024-65535, destination 0.0.0.0/0 (responses to inbound requests)
- Rule 120: Allow TCP, port 5432 (or app port), destination private subnet CIDR

NACLs take effect immediately â€” ALB is accessible as soon as rules are re-added. Lesson: use IaC (Terraform) to manage NACLs so they can be restored with 	erraform apply.

