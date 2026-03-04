# Networking Ports & Firewall in AWS

## FILE 01 OF 03 — Core Concepts, Architecture & Production Patterns

> **Architect Training Mode** | Senior Principal Architect Perspective
> _Optimized for: design judgement · tradeoff evaluation · failure prediction · production debugging_

---

## SECTION 1 — Intuition (Explain Like a 12-Year-Old)

```
MENTAL MODEL:
  IP Address: the building address (finds the server)
  Port number: the door number in the building (finds the service on that server)

  Traffic arriving at: 54.100.200.50:443
    → IP 54.100.200.50: routes to the EC2 instance
    → Port 443: delivered to the process listening on port 443 (HTTPS/TLS)

PORT RANGES:
  Well-known ports: 0-1023      (reserved: HTTP=80, HTTPS=443, SSH=22, DNS=53)
  Registered ports: 1024-49151  (applications: PostgreSQL=5432, Redis=6379, MySQL=3306)
  Dynamic/ephemeral: 49152-65535 (OS-assigned for client-side connections)

CRITICAL PORTS FOR AWS ARCHITECTS:
  Port  | Protocol  | Service
  ------|-----------|------------------------------------------
  22    | TCP       | SSH (remote shell — should be CLOSED in prod, use SSM)
  80    | TCP       | HTTP (redirect to 443 in production)
  443   | TCP       | HTTPS (all web traffic, API traffic)
  3306  | TCP       | MySQL / Aurora MySQL
  5432  | TCP       | PostgreSQL / Aurora PostgreSQL / RDS
  6379  | TCP       | Redis (ElastiCache, local Redis)
  27017 | TCP       | MongoDB
  2181  | TCP       | ZooKeeper (Kafka controller)
  9092  | TCP       | Apache Kafka
  2049  | TCP       | NFS (EFS mounts)
  8080  | TCP       | Common alt-HTTP for application servers
  3000  | TCP       | Node.js dev server (common convention)
  8443  | TCP       | HTTPS alt port (internal services)
  53    | UDP/TCP   | DNS (Route 53 resolver queries)
  123   | UDP       | NTP (time sync — EC2 uses Amazon Time Sync Service)
```

---

## SECTION 2 — Core Technical Explanation

```
LAYER 1: AWS WAF (Web Application Firewall)
  Position: in front of ALB, CloudFront, API Gateway
  What it inspects: HTTP/S request headers, body, URI, query strings
  What it blocks: OWASP Top 10 attacks (SQL injection, XSS), rate limiting, geo-blocking
  Rule types:
    Managed rules: AWS-maintained (AWSManagedRulesCommonRuleSet, AWSManagedRulesSQLiRuleSet)
    Custom rules: rate limit by IP, block specific user agents, header matching
  Cost: $5/WebACL/month + $1/rule/month + $0.60/million requests

LAYER 2: AWS Shield
  Standard: free. Automatic protection against common DDoS (L3/L4 attacks) for all AWS resources.
  Advanced: $3,000/month. Enhanced protection, 24/7 DDoS response team (DRT), cost protection.
  Activated by: associating resources (ALB, CloudFront, EIP, Route 53) with Shield Advanced.

LAYER 3: Security Groups (VPC-level, stateful)
  Position: attached to EC2 ENI, RDS, ECS task ENI, Lambda VPC ENI
  Scope: per network interface
  Behavior: stateful — allow inbound → return traffic automatically allowed
  Direction: separate inbound and outbound rules
  Default: allow all outbound, deny all inbound

LAYER 4: Network ACLs (subnet-level, stateless)
  Position: attached to VPC subnet
  Scope: all traffic entering/leaving the subnet
  Behavior: stateless — must allow both inbound and outbound (including ephemeral ports)
  Direction: numbered rules, first match wins
  Default: default NACL allows all inbound and outbound

LAYER 5: AWS Network Firewall
  Position: centralized in inspection VPC (or directly in each VPC)
  Scope: deep packet inspection (Suricata-compatible rules), DNS filtering
  What it adds: Layer 7 filtering (stateful rules), intrusion detection/prevention
  Cost: $0.395/hour per AZ + $0.065/GB processed
  Use when: enterprise compliance requiring IDS/IPS, AWS Shield Advanced complement

TRAFFIC FLOW (inbound HTTPS request):
  Internet → Route 53 → CloudFront (WAF rules applied) → ALB → Security Group check
  → NACL inbound check → EC2/ECS → application
```

---

## SECTION 3 — Architecture Diagram (MANDATORY)

```
THE PROBLEM:
  Client initiates connection to server:
    Client: picks RANDOM ephemeral source port (e.g., 52,341)
    Server: listens on well-known port (e.g., 443)

  Packet: Source=client:52341, Destination=server:443

  RETURN PACKET: Source=server:443, Destination=client:52341

  NACL is STATELESS:
    Inbound NACL on server subnet: must allow 443 (request arrives) ✓
    Outbound NACL on server subnet: must allow 1024-65535 (response to client's ephemeral port)

    If outbound NACL missing ephemeral port range:
      Request: gets in (443 allowed)
      Response: BLOCKED (52,341 is in ephemeral range, not explicitly allowed)
      Result: client gets no response. Looks like timeout. Connection drops.

SOLUTION:
  NACL outbound rules: always include ephemeral port range 1024-65535 for return traffic
  Or: TCP port range 0-65535 outbound (allow all, relying on Security Groups for restriction)

PRACTICAL RULE FOR NACL:
  Inbound: restrict to needed ports (443, 80, 22, 5432)
  Outbound: allow 1024-65535 to all CIDR that can initiate connections to this subnet
  Security Groups: apply precise restrictions (stateful — no ephemeral port concern)

  This is why: Security Groups for most access control, NACL for gross subnet-level blocking
```

---

## SECTION 4 — Request Flow (MANDATORY FLOWCHART)

```
ALB SECURITY GROUP (Public-facing):
  Inbound:
    TCP 443 from 0.0.0.0/0   (HTTPS from internet)
    TCP 80  from 0.0.0.0/0   (HTTP, to redirect to HTTPS at ALB level)
  Outbound:
    TCP 8080 to sg-app        (forward to application tier on app port)

APPLICATION SECURITY GROUP:
  Inbound:
    TCP 8080 from sg-alb      (traffic from ALB only — not from internet directly)
    TCP 22   from sg-bastion  (SSH from bastion only — or remove if using SSM)
  Outbound:
    TCP 5432 to sg-rds        (connect to database)
    TCP 6379 to sg-redis      (connect to cache)
    TCP 443 to 0.0.0.0/0      (HTTPS to AWS APIs, external services)
    TCP 53  to 0.0.0.0/0      (DNS resolution)

RDS SECURITY GROUP:
  Inbound:
    TCP 5432 from sg-app      (only application tier can connect to DB)
    TCP 5432 from sg-admin    (DBA access from admin/bastion SG — optional)
  Outbound:
    (none required — RDS doesn't initiate connections)

REDIS SECURITY GROUP:
  Inbound:
    TCP 6379 from sg-app      (only application can connect to cache)
  Outbound:
    (none required)

BASTION HOST (or replace with SSM Session Manager to eliminate entirely):
  Inbound:
    TCP 22 from COMPANY_VPN_IP/32   (allow SSH from corporate VPN only)
  Outbound:
    TCP 22 to sg-app                (SSH to application instances)
    TCP 5432 to sg-rds              (DB admin access)
```

---

### Cost Model

```
AWS WAF:
  WebACL: $5/month per WebACL
  Rules: $1/month per rule
  Requests: $0.60/million web requests

  For 10M requests/month: $5 + (10 rules × $1) + (10 × $0.60) = $21/month

AWS Network Firewall:
  Endpoint: $0.395/hour × AZ count × 720 = $285/month for 1 AZ
  Traffic: $0.065/GB processed
  High cost: only for enterprise/compliance environments

Security Groups and NACLs: FREE
  Most firewall enforcement in AWS: Security Groups and NACLs cost nothing.
  The most impactful security controls: free. Invest in architecture, not tooling cost.

AWS Shield Standard: FREE for all AWS customers (automatic DDoS protection)
AWS Shield Advanced: $3,000/month + 1-year commitment
  Use when: critical revenue-generating applications, gaming (UDP floods), financial services
```
