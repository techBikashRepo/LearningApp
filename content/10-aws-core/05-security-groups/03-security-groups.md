# Security Groups

## FILE 03 OF 03 — Design Decisions, SAA Exam Traps, Scenarios & Architect's Mental Model

> **Architect Training Mode** | Senior Principal Architect Perspective
> _Optimized for: design judgement · tradeoff evaluation · failure prediction · production debugging_

---

## SECTION 9 — Certification Focus (AWS SAA-C03)

```
PATTERN 1: CHAINED SECURITY GROUPS (layered trust model)
  Used by: all production multi-tier architectures

  Internet → sg-alb → ALB → sg-app (allows from sg-alb) →
  App → sg-rds (allows from sg-app) → DB

  Each tier only trusts the SG of the tier directly above it.
  No tier has direct access bypassing the chain.

PATTERN 2: SELF-REFERENCING SG (cluster members communicate freely)
  Used by: ECS services, EKS nodes, Kafka brokers, Redis clusters

  sg-kafka: inbound from sg-kafka on ports 9092-9094 (self-reference)
  Any Kafka broker can communicate with any other Kafka broker.
  New brokers: attach sg-kafka → immediately can communicate with peers.
  Same for ECS tasks that do peer-to-peer gRPC within a cluster.

PATTERN 3: BASTION HOST SG (controlled admin access)
  sg-bastion: inbound 22 from [your office IP CIDR only] or corporate VPN
  sg-app: inbound 22 from sg-bastion (app servers accept SSH only from bastion)

  Nobody can SSH to app servers directly from internet.
  All SSH goes through bastion, creating an audit trail.

  Modern replacement: remove SSH entirely, use SSM Session Manager.
  Then sg-bastion is deleted and sg-app has no port 22 rule.

PATTERN 4: MANAGED PREFIX LIST FOR CLOUDFRONT ORIGIN PROTECTION
  Problem: ALB has direct internet endpoint — attackers bypass CloudFront, hit origin directly

  sg-alb: inbound 443 from aws-managed-prefix-list-cloudfront (com.amazonaws.global.cloudfront.origin-facing)
  Result: only CloudFront IPs can reach ALB on 443
  All direct internet access to ALB: blocked by SG
  Attackers cannot bypass CloudFront to reach origin

PATTERN 5: SEPARATED ADMIN SG (least privilege for admin operations)
  sg-admin: inbound 8443 from [admin tool SG]
  sg-app: attach both sg-app-standard AND sg-admin when doing admin tasks
  Remove sg-admin attachment when not needed

  Admin ports not permanently open — attached only during maintenance windows
```

---

## SECTION 10 — Comparison Table

```
USE SECURITY GROUPS WHEN:            USE NACLs WHEN:
──────────────────────────────────   ──────────────────────────────────
Controlling access per resource      Controlling access per subnet (all resources in subnet)
Stateful filtering needed            Stateless filtering needed
Referencing AWS resource identity    Blocking specific IP ranges
(SG-to-SG rules)                    BLOCKING specific IPs (SG can't deny)
Per-ENI granularity required         Subnet-level blanket policies
                                    Emergency IP blocklist (NACL deny wins fast)

COMBINED USE:
  SG: allow port 443 from 0.0.0.0/0 (broad allow for HTTPS)
  NACL: deny all inbound from 203.0.113.0/24 (block specific attacker range)
  Result: all internet can reach via SG, but the blocked CIDR is blocked by NACL
  SGs can't do this (SG has only allow rules — no deny specific range)

  Use NACL for ip-blocking, SG for port/service access control
```

---

## SECTION 11 — Quick Revision

### Trap 1: Security Groups Are Stateful, NACLs Are Stateless

```
Most tested concept on SAA. Know it cold.

Security Group (stateful):
  Rule: inbound 443 allowed
  Effect: response traffic (outbound ephemeral) automatically allowed
  You do NOT need an outbound rule for return traffic

NACL (stateless):
  Rule: inbound 443 allowed
  Effect: response traffic NOT automatically allowed
  You MUST add outbound rule for ephemeral ports (1024-65535)
  Missing outbound ephemeral rule: requests come in but responses are blocked

Exam scenario: "NACL has inbound rule allow port 443 but users experience connection drops."
Answer hint: missing outbound rule for ephemeral ports 1024-65535.
```

### Trap 2: Security Groups Are Allow-Only

```
SGs have ONLY allow rules. There is no "deny" rule type.
Everything not explicitly allowed is implicitly denied.

Exam scenario: "Block SSH (port 22) for all EC2 in a VPC except the bastion host.
               What is the most efficient approach?"
Answer: you can't "deny" with SG — you don't put a port 22 allow rule on any SG
         except the bastion's SG. Port 22 is blocked by default (no allow = block).

If you need an explicit DENY: use NACL with a DENY rule.
Exam: "Block all traffic from a specific IP range" → NACL DENY rule
       SG cannot explicitly deny; it can just not allow.
```

### Trap 3: SG Rules Are Evaluated as a Set (Not First-Match)

```
NACLs: numbered rules, lowest number evaluated first, FIRST MATCH WINS.
       If rule 100 allows, rule 200 deny — traffic is ALLOWED (100 matched first).

Security Groups: ALL rules evaluated together.
                 If ANY rule allows traffic, it's allowed.
                 A more restrictive rule cannot "override" a permissive rule.

Exam trap: "SG has rule 1: allow all outbound. Rule 2: deny outbound port 22."
Answer: Rule 2 "deny" is not a valid SG rule. SGs don't have deny.
        If you have allow-all outbound, ALL outbound is allowed.
        The only way to restrict outbound: remove the allow-all rule.
```

### Trap 4: SG for RDS Subnet Group

```
When creating RDS in a subnet group, the SG attached is on the RDS ENI.
Exam scenario: "EC2 in private subnet cannot connect to RDS in DB subnet. Both in same VPC."

Checklist:
  1. SG on RDS: inbound port 5432 from EC2's SG (not EC2's IP — SG reference)
  2. SG on EC2: outbound port 5432 allowed (if default outbound restricted)
  3. Route tables: both subnets have 10.x.x.x → local route (intra-VPC always works)
  4. NACL: both subnets allow the traffic (inbound on DB subnet, outbound on DB subnet for return)

Most common miss: SG on RDS references wrong CIDR or wrong SG ID.
Use SG reference (not CIDR) for maintainability.
```

---

## SECTION 12 — Architect Thinking Exercise

```
SCENARIO: Zero-Trust internal microservices architecture

5 services: api-gateway, user-service, order-service, payment-service, notification-service
Rules:
  - api-gateway: receives traffic from internet (ALB)
  - user-service, order-service: called only by api-gateway
  - payment-service: called only by order-service (NOT by api-gateway directly)
  - notification-service: called by order-service and payment-service
  - No service can call another service not in its allowed list

SECURITY GROUP DESIGN:

sg-alb:
  Inbound: 443 from 0.0.0.0/0
  Outbound: 8080 from sg-api-gateway

sg-api-gateway:
  Inbound: 8080 from sg-alb
  Outbound: 8080 to sg-user-service
            8080 to sg-order-service
            (NO: sg-payment-service — api-gateway cannot call payment directly)

sg-user-service:
  Inbound: 8080 from sg-api-gateway
  Outbound: 443 (external APIs if needed)

sg-order-service:
  Inbound: 8080 from sg-api-gateway
  Outbound: 8080 to sg-payment-service
            8080 to sg-notification-service

sg-payment-service:
  Inbound: 8080 from sg-order-service
           (NOT from sg-api-gateway — cannot be called directly)
  Outbound: 8080 to sg-notification-service
            443 to 0.0.0.0/0 (Stripe API)

sg-notification-service:
  Inbound: 8080 from sg-order-service
           8080 from sg-payment-service
  Outbound: 443 (email/SMS APIs like SendGrid, Twilio)

RESULT:
  api-gateway CANNOT call payment-service directly — SG blocks it
  payment-service CANNOT receive calls from api-gateway — intention enforced by SG
  Every service boundary is explicit, auditable, and not dependent on application code
  Security policy is enforced at infrastructure level (can't be bypassed by code bug)
```

---

### Interview Q&A

**Q: "What are Security Groups in AWS and how are they different from NACLs?"**

Good answer: "Security Groups are stateful virtual firewalls that attach to individual ENIs — every EC2, ECS task, RDS instance, and Lambda function in a VPC has an ENI with Security Groups. They're allow-only (no deny rules), and because they're stateful, return traffic for allowed connections is automatically permitted without needing outbound rules. The key power is SG-to-SG references: I can say 'allow inbound port 5432 from the security group attached to my ECS tasks' — so it works correctly regardless of IPs and autoscaling. NACLs are stateless, apply at the subnet level to all resources in the subnet, and they DO have deny rules, making them useful for blocking specific IP ranges. My production pattern: SGs for per-service access control with SG chaining, NACLs only for subnet-wide IP blocking when needed."

---

## === ARCHITECT'S MENTAL MODEL ===

### 5 Decision Rules for Security Groups

1. **Use SG-to-SG references, not CIDRs, for internal VPC traffic.** "Allow 5432 from sg-app" is robust — it works regardless of autoscaling, redeployments, and IP changes. "Allow 5432 from 10.10.11.0/24" breaks if the app moves to a different subnet. SG references are the identity-based approach that makes micro-segmentation scalable.

2. **Chain security groups through tiers. DB tier only trusts app tier SG, not internet SG.** The architecture is NOT "ALB SG allows all, everything else allows all." It's a trust chain: internet→SG-ALB→SG-app→SG-rds. Each hop only trusts the hop above it. If the ALB is compromised, it can't directly reach the DB — it can only reach the app tier. This is defense in depth at the network identity level.

3. **Security Groups are allow-only. For explicit DENY, use NACLs.** A common mistake: trying to add a "deny rule" to a Security Group. It doesn't exist. If you need to block a specific IP range (attacker, fraudulent source), NACLs are the mechanism. NACL deny rules end the connection before it reaches the Security Group.

4. **Remove the default outbound allow-all for sensitive services.** Default outbound is allow-all, which means a compromised EC2 can call any port anywhere. For payment services, admin tools, and data processing that handles PII: restrict outbound to only known necessary destinations. Yes, it adds operational overhead — it's worth it for the blast radius reduction.

5. **SG naming is your audit trail. Never reuse or share SGs across unrelated services.** When sg-xyz appears in 15 different inbound rules across 8 services, auditing questions like "what can access my payment DB?" become impossible. One SG per logical service, descriptive names (sg-payments-api-prod), and enforce in Terraform. IaC means the SG design is codified and reviewable.

### 3 Common Mistakes

1. **Opening port 5432, 3306, or 6379 to 0.0.0.0/0 "for development."** It never stays "for development." Add a reminder to revert, it doesn't happen, the instance expires from a sprint, and 3 months later your database is on Shodan. Use AWS Config `rds-instance-public-access-check` and Security Hub to automatically alert on this the moment it's created.

2. **Referencing deleted SGs in inbound rules.** When you delete a service and create a new one, the upstream SG rules referencing the old SG become dangling. The new service's SG is silently blocked. This causes "service works in dev, fails in prod" confusion. Terraform output: track all SG IDs as variables. Deployment runbook: "update upstream SG rules" as an explicit step.

3. **Treating Security Groups as the ONLY security layer and skipping NACLs, WAF, and CloudTrail.** Security Groups are your strongest per-resource control, but they're one layer. Defense in depth means: NACLs at subnet level, WAF at application layer, CloudTrail for API auditing, GuardDuty for threat detection, VPC Flow Logs for traffic forensics. Security Groups alone don't detect or respond to threats — they only prevent unauthorized access.

### 1 Clear Interview Answer (30 Seconds)

> "Security Groups are stateful virtual firewalls attached to ENIs — every EC2, ECS task, RDS instance has one. They're allow-only and stateful, so you only write inbound rules and return traffic is handled automatically. The key feature is SG-to-SG references: I allow inbound port 5432 from the app server's security group ID, not its IP, which makes the rules robust to autoscaling and redeployments. My production design chains SGs: internet connects to ALB's SG, ALB's SG is the only allowed source for the app tier's SG, app tier's SG is the only allowed source for the DB SG. Each layer only trusts the layer directly above it. For explicit IP blocking, I pair Security Groups with NACLs, which do have deny rules."

---

_End of Security Groups 3-File Series_
