# Networking Ports & Firewall in AWS

## FILE 02 OF 03 — Production Incidents, Failure Patterns & Debugging

> **Architect Training Mode** | Senior Principal Architect Perspective
> _Optimized for: design judgement · tradeoff evaluation · failure prediction · production debugging_

---

## SECTION 5 — Real World Example

```
INCIDENT:
  Security operations center alert: high volume of SSH authentication failures on 3 EC2 instances.
  CloudTrail + VPC Flow Logs: thousands of connection attempts from multiple IPs.
  1 EC2 instance: SSH success from unknown IP at 3AM (developer had weak password).
  Intruder: installed crypto-miner. EC2 CPU = 100%.

ROOT CAUSE:
  Security Group on all production EC2 instances:
    Inbound: TCP 22 from 0.0.0.0/0   ← INTERNET-WIDE SSH access
  Developer justification: "easier to SSH from anywhere without VPN"

FIX (immediate):
  # Update SG to remove 0.0.0.0/0 SSH rule
  aws ec2 revoke-security-group-ingress \
    --group-id sg-xxxx \
    --protocol tcp --port 22 --cidr 0.0.0.0/0

  # Add: only allow SSH from specific IP (corporate VPN range)
  aws ec2 authorize-security-group-ingress \
    --group-id sg-xxxx \
    --protocol tcp --port 22 --cidr 10.0.0.0/8

FIX (correct architecture — eliminate SSH entirely):
  Use SSM Session Manager:
    aws ssm start-session --target i-xxxx
    → Terminal session over HTTPS port 443 (already open outbound)
    → No port 22 needed. No SSH keys. Full audit trail in CloudTrail.
    → GuardDuty: alerts if SSH connections still attempted after closure

PREVENTION:
  AWS Config rule: restricted-ssh → alert if security group allows 0.0.0.0/0 port 22
  SCP policy: deny s3:... (block adding 0.0.0.0/0 inbound 22 to SGs at account level)

RULE: In 2025, there is no valid reason to open port 22 to the internet. Use SSM.
```

---

## SECTION 6 — System Design Importance

```
INCIDENT:
  Security team adds NACL rule to block specific IP range (DDoS mitigation).
  Change: add DENY rule to NACL on web tier subnet.
  Post-change: ALL connections to the web tier fail (full outage), not just the blocked IPs.

ROOT CAUSE:
  NACL rules: NUMBER-ordered. First matching rule wins.

  Before change:
  Rule 100: ALLOW all inbound (0.0.0.0/0)
  Rule 32767: DENY all (implicit)

  After change (wrong insertion):
  Rule 10: DENY 203.0.113.0/24 (added as low number)
  Rule 100: ALLOW all inbound (0.0.0.0/0)

  Wait... this should still work. What went wrong?

  ACTUAL MISTAKE: Engineer inserted DENY rule 10 AND accidentally modified rule 100 to DENY.

  OR: a common mistake with Terraform:
  Rule 100: DENY 203.0.113.0/24  ← intended
  Terraform state shows rule 100 was ALLOW all → Terraform plan DELETES ALLOW 100 → adds DENY 100
  Full outage: DENY 203.0.113.0/24 caught all traffic (if ALLOW rule removed).

FIX:
  NACL blocking a specific IP range correctly:
  Rule 50: DENY 203.0.113.0/24 (added at rule number LOWER than the ALLOW rule)
  Rule 100: ALLOW 0.0.0.0/0 (remains — allows all others)

  Separate low numbers for DENY blocks: Rule 50-99 for DENY rules
  Keep ALLOW rules at Rule 100+ (well-known position in runbook)

TERRAFORM PATTERN (safe NACL management):
  # Use separate resource for each rule with explicit rule_number
  # Avoid: aws_network_acl with inline ingress/egress blocks (recreates all rules on any change)
  # Use: aws_network_acl_rule resources (additive, granular, safe)
```

---

## SECTION 7 — AWS & Cloud Mapping

```
INCIDENT:
  E-commerce site: during sale event, AWS WAF rate limiting rule fires.
  Rule: "block IP if more than 1,000 requests in 5 minutes"
  Problem: mobile app users behind corporate NAT share 1 IP.
  100 employees at large company → 1 IP to WAF → 1,000+ requests → IP blocked.
  Company's IT team: calls support. "Your website is blocking our entire company."

ROOT CAUSE:
  Rate limit per IP = blunt instrument.
  Large NAT: thousands of users share 1 public IP.
  Rule threshold too low for NAT IP scenarios.

FIX:
  Increase threshold for legitimate traffic pattern.
  Better: rate limit by IP + header combination (IP + User-Agent + custom header).

  WAF rate limit options:
    IP: simple, catches single-IP bots
    IP + HTTP header: customize scope (e.g., X-Forwarded-For if using reverse proxy)
    Custom aggregate key (WAF v2): combine IP + URI + querystring → more granular

  Allowlist: create WAF IP set for known corporate IPs → ALLOW rule overrides rate limit

  Rule order: WAF rules evaluated in order by PRIORITY number
    Priority 1: ALLOW known-corporate-IPs (IP set rule) → skip rate limit
    Priority 2: Rate limit (applies to everyone else)
    Priority 3: AWS managed rules (SQL injection, XSS)

TUNING WAF:
  WAF logging: enable full request logging to S3 or CloudWatch Logs
  Athena queries: analyze WAF logs to understand traffic patterns before setting thresholds
  Dry run (COUNT mode): set rule to COUNT before enabling BLOCK → see impact before enforcement
```

---

## SECTION 8 — Interview Preparation

**Beginner:**

**Q: What are the most important port numbers every backend developer should know?**
**A:** Essential ports: 22 (SSH â€” remote server access), 80 (HTTP), 443 (HTTPS), 3000-3100 (common Node.js/Express development ports), 5432 (PostgreSQL), 3306 (MySQL), 6379 (Redis), 27017 (MongoDB), 5672 (RabbitMQ), 9092 (Kafka), 8080 (common app server alternate HTTP), 25 (SMTP email â€” often blocked by ISPs and AWS by default). In AWS security group rules: you specify which ports to allow â€” knowing these prevents "why can't my app connect to port 5432?" troubleshooting confusion.

**Q: What is the difference between a TCP port and a UDP port?**
**A:** TCP (Transmission Control Protocol): connection-oriented, guaranteed delivery, ordered packets. Used for: HTTP, HTTPS, PostgreSQL, SSH â€” anything where data integrity matters. UDP (User Datagram Protocol): connectionless, no delivery guarantee, lower overhead. Used for: DNS queries (fast, small, can afford retries), video streaming (latency matters more than every packet), game data. In AWS security groups: you specify protocol (TCP/UDP) and port in rules. Most web services use TCP. DNS uses UDP/53. If you're troubleshooting "can't connect to DB": you're almost always dealing with TCP.

**Q: What ports should NEVER be open to 0.0.0.0/0 (internet) in production?**
**A:** Never expose to the internet: 22 (SSH â€” brute force target, use IP restriction or SSM instead), 5432 (PostgreSQL), 3306 (MySQL), 6379 (Redis â€” no authentication by default in older versions), 27017 (MongoDB), 25 (SMTP â€” spam relay risk), 2375/2376 (Docker daemon API â€” catastrophic if exposed: full container access). Acceptable to open to internet: 443 (HTTPS â€” this is your public API), 80 (HTTP â€” redirect to HTTPS). Everything else: internal only, or restricted to your VPN/company IP.

---

**Intermediate:**

**Q: What is AWS WAF and how does it differ from security groups?**
**A:** Security groups operate at Layer 4 (TCP/UDP) â€” they filter by IP address and port, but they can't inspect the content of HTTP requests. AWS WAF (Web Application Firewall) operates at Layer 7 (HTTP) â€” it inspects the actual content of HTTP requests: URL paths, headers, query strings, request body. WAF can block: SQL injection attempts ('; DROP TABLE in query parameters), XSS patterns, bad bots, requests from specific countries, rate-limit IPs making too many requests. Place WAF in front of ALB or CloudFront. Security groups block at network level; WAF blocks at application content level. Use both: security groups for network isolation, WAF for application-layer protection.

**Q: What is AWS Network Firewall and when would you use it over security groups?**
**A:** AWS Network Firewall is a managed stateful network firewall deployed at VPC level â€” between subnets or at the internet gateway. Unlike security groups (per-resource, up to 60 rules): Network Firewall supports thousands of rules, domain-based filtering (allow-list by domain name), protocol inspection, IDS/IPS (intrusion detection/prevention) with Suricata-compatible rules. Use cases: compliance requirements for network-level inspection, restrict outbound traffic to allow-listed domains only (prevent data exfiltration), environments requiring IDS/IPS (financial, healthcare). For most web apps: security groups + WAF is sufficient. Network Firewall for: strict compliance, high-security environments.

**Q: What is ephemeral port range and why must it be considered in NACL rules but not security group rules?**
**A:** When a client (browser, server) initiates a TCP connection, it's assigned a random source port in the ephemeral port range (1024-65535, Linux defaults to 32768-60999). The server responds FROM its service port (e.g., 443) TO the client's ephemeral port. Security groups: stateful â€” if inbound HTTPS (443) is allowed, the response to the ephemeral port is automatically allowed. NACLs: stateless â€” you must explicitly add an outbound rule allowing TCP destination ports 1024-65535 to  .0.0.0/0 for HTTPS responses to reach clients. Forgetting ephemeral ports is the #1 NACL misconfiguration â€” all TCP responses are silently dropped, causing connections to timeout.

---

**Advanced (System Design):**

**Scenario 1:** Design a defense-in-depth network security architecture for a financial services application. Requirements: (1) All outbound traffic from app servers must be restricted to an allow-list of domains. (2) SQL injection and XSS attempts must be detected and blocked. (3) Brute force login (> 100 attempts/min from one IP) must be blocked. (4) All traffic to port 22 must be audited. (5) Database is never accessible from internet under any circumstances.

*Layer 1 â€” Network boundary (VPC):*
- Internet Gateway controlled by AWS Network Firewall: domain-based allow-list for outbound (only pi.stripe.com, smtp.sendgrid.com, egistry.npmjs.org allowed outbound).
- Private subnets for all app servers and databases. Public subnets only for ALB.

*Layer 2 â€” Application layer (WAF):*
- AWS WAF on ALB: AWS Managed Rules (SQLi, XSS rule groups) + custom rate rule: >100 req/min from same IP on /auth/login â†’ block for 10 minutes.

*Layer 3 â€” Resource level (Security Groups):*
- SG-RDS: inbound 5432 only from SG-API. No internet route in private data subnet.

*Layer 4 â€” Access control (SSH audit):*
- No SSH (port 22) open anywhere. All EC2/ECS access via AWS SSM Session Manager. CloudTrail logs every session start/end. No VPN or bastion needed.

*Layer 5 â€” Monitoring:*
- Amazon GuardDuty: ML-based threat detection on VPC Flow Logs, CloudTrail events.

**Scenario 2:** After a security audit, you discover that your production ECS tasks have outbound  .0.0.0/0 Allow All in their security group. The security team wants to restrict outbound. Walk through the process of identifying all legitimate outbound traffic and safely implementing allow-list rules without breaking the application.

*Discovery phase (before changing anything):*
(1) VPC Flow Logs: enable on the app subnets for 48 hours. Query CloudWatch Insights: ilter interfaceId in [app-task-enis] | stats count() by dstAddr, dstPort | sort count desc. This reveals every destination IP + port combination your tasks actually connect to.
(2) CloudTrail API calls: what AWS services do the tasks call (STS, SQS, ECR, Secrets Manager)?
(3) Application code review: grep for equire('https'), xios.get, SDK clients, hardcoded external URLs.

*Consolidate legitimate destinations:*
- AWS services via VPC endpoints (no outbound needed): S3, SQS, SSM, Secrets Manager, ECR.
- Remaining outbound: third-party APIs (Stripe, SendGrid), npm registry during builds.

*Implement incrementally:*
(1) Create new outbound rules restricting to confirmed destinations.
(2) Keep existing Allow All rule in place TEMPORARILY.
(3) Deploy with new security group having BOTH rules â†’ verify application works â†’ remove Allow All rule.
(4) Monitor VPC Flow Logs for REJECT entries â†’ indicates legit traffic missed â†’ add rule.
(5) After 48h clean run: remove old Allow All rule permanently.

