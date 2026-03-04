# Network ACL (Access Control List)

## FILE 01 OF 03 — Core Concepts, Architecture, Components & Cost

> **Architect Training Mode** | Senior Principal Architect Perspective
> _Optimized for: design judgement · tradeoff evaluation · failure prediction · production debugging_

---

## SECTION 1 — Intuition (Explain Like a 12-Year-Old)

```
PHYSICAL EQUIVALENT:
  Network ACL → Stateless packet-filter firewall / ACL on a router/switch

  Physical: Cisco router ACL
    ip access-list extended INBOUND-FILTER
      permit tcp 203.0.113.0 0.0.0.255 any eq 443
      deny tcp 198.51.100.0 0.0.0.255 any
      permit ip any any
    Applied: inbound on physical interface facing DMZ segment

  Characteristics:
    Stateless: each packet evaluated independently
    Ordered rules: first match wins
    Bidirectional: must configure both directions for two-way communication

  AWS Network ACL:
    Same stateless numbered-rule model
    Applied at subnet boundary (all ENIs in subnet use the same NACL)
    Separate inbound AND outbound rule sets
    Numbers 1-32766 (lower number = evaluated first)
    Has both ALLOW and DENY rules (unlike Security Groups which are allow-only)

KEY DIFFERENCE FROM SECURITY GROUPS:
  Security Group: stateful, per-ENI, allow-only
  NACL: stateless, per-subnet, allow + deny

  NACL is the second line of defense BEFORE traffic reaches the Security Group
  Order: NACL (subnet boundary) → Security Group (ENI level)
```

---

## SECTION 2 — Core Technical Explanation

```
NACL PROPERTIES:

Stateless:
  Inbound rule allows HTTPS (443) incoming
  Response traffic (TCP on ephemeral ports 1024-65535) is NOT automatically allowed
  Must add explicit OUTBOUND rule: allow TCP 1024-65535 to 0.0.0.0/0
  (This is the #1 NACL gotcha that causes "requests work but responses drop")

Numbered rules:
  Rules evaluated in order from lowest to highest number
  FIRST matching rule wins — evaluation stops
  Rule 100: DENY TCP 203.0.113.0/24 ANY port 443
  Rule 200: ALLOW TCP 0.0.0.0/0 ANY port 443
  Result: 203.0.113.0/24 is DENIED (rule 100 matches first)

  AWS recommendation: use increments of 100 (100, 200, 300...)
  This leaves room to insert rules between existing ones without renumbering

Default NACL (every VPC has one):
  Inbound: rule 100 ALLOW ALL → rule * DENY ALL (but 100 wins for all traffic)
  Outbound: rule 100 ALLOW ALL → rule * DENY ALL
  Effectively: allows ALL traffic in both directions
  Every subnet starts with the default NACL (permissive by default)

Custom NACL:
  When first created: has only rule * DENY ALL (deny everything)
  Must add explicit ALLOW rules for traffic to flow
  Action: create custom NACL → attach to subnet → subnet now denies all traffic
  This is a common mistake: create NACL and attach before adding allow rules → outage

VPC-level scope:
  NACL belongs to a VPC
  Can be associated with multiple subnets in that VPC
  Each subnet has exactly ONE NACL (last association wins)
  Changing NACL association: immediate effect
```

---

## SECTION 3 — Architecture Diagram (MANDATORY)

```
NACL: nacl-public (attached to public subnets — ALB, NAT GW)
────────────────────────────────────────────────────────────────────────────
INBOUND RULES:
Rule  | Type        | Protocol | Port Range  | Source        | Action
──────┼─────────────┼──────────┼─────────────┼───────────────┼────────
100   | HTTPS       | TCP      | 443         | 0.0.0.0/0     | ALLOW
110   | HTTP        | TCP      | 80          | 0.0.0.0/0     | ALLOW
120   | Custom TCP  | TCP      | 1024-65535  | 0.0.0.0/0     | ALLOW  ← Return traffic
*     | All Traffic | All      | All         | 0.0.0.0/0     | DENY   ← Implicit catch-all

OUTBOUND RULES:
Rule  | Type        | Protocol | Port Range  | Destination   | Action
──────┼─────────────┼──────────┼─────────────┼───────────────┼────────
100   | Custom TCP  | TCP      | 8080        | 10.10.11.0/24 | ALLOW  ← To app subnet
110   | Custom TCP  | TCP      | 8080        | 10.10.12.0/24 | ALLOW  ← To app subnet AZ-b
120   | HTTPS       | TCP      | 443         | 0.0.0.0/0     | ALLOW  ← NAT GW outbound
130   | Custom TCP  | TCP      | 1024-65535  | 0.0.0.0/0     | ALLOW  ← Response to clients
*     | All Traffic | All      | All         | 0.0.0.0/0     | DENY

────────────────────────────────────────────────────────────────────────────
NACL: nacl-private (attached to private subnets — ECS/EC2 app tier)
────────────────────────────────────────────────────────────────────────────
INBOUND RULES:
Rule  | Protocol | Port  | Source              | Action
──────┼──────────┼───────┼─────────────────────┼────────
100   | TCP      | 8080  | 10.10.1.0/24        | ALLOW  ← From public subnet AZ-a
110   | TCP      | 8080  | 10.10.2.0/24        | ALLOW  ← From public subnet AZ-b
120   | TCP      | 1024-65535 | 0.0.0.0/0     | ALLOW  ← Return traffic from internet
*     | All      | All   | 0.0.0.0/0           | DENY

OUTBOUND RULES:
Rule  | Protocol | Port  | Destination         | Action
──────┼──────────┼───────┼─────────────────────┼────────
100   | TCP      | 5432  | 10.10.21.0/24       | ALLOW  ← To DB subnet AZ-a
110   | TCP      | 5432  | 10.10.22.0/24       | ALLOW  ← To DB subnet AZ-b
120   | TCP      | 443   | 0.0.0.0/0           | ALLOW  ← External API calls
130   | TCP      | 1024-65535 | 10.10.1.0/24  | ALLOW  ← Response to public subnet
140   | TCP      | 1024-65535 | 10.10.2.0/24  | ALLOW
*     | All      | All   | 0.0.0.0/0           | DENY

────────────────────────────────────────────────────────────────────────────
NACL: nacl-db (attached to DB subnets — RDS, ElastiCache)
────────────────────────────────────────────────────────────────────────────
INBOUND RULES:
Rule  | Protocol | Port  | Source              | Action
──────┼──────────┼───────┼─────────────────────┼────────
100   | TCP      | 5432  | 10.10.11.0/24       | ALLOW  ← From private subnet AZ-a
110   | TCP      | 5432  | 10.10.12.0/24       | ALLOW  ← From private subnet AZ-b
*     | All      | All   | 0.0.0.0/0           | DENY   ← Everything else blocked

OUTBOUND RULES:
Rule  | Protocol | Port       | Destination         | Action
──────┼──────────┼────────────┼─────────────────────┼────────
100   | TCP      | 1024-65535 | 10.10.11.0/24       | ALLOW  ← Response to app subnet
110   | TCP      | 1024-65535 | 10.10.12.0/24       | ALLOW
*     | All      | All        | 0.0.0.0/0           | DENY
```

---

## SECTION 4 — Request Flow (MANDATORY FLOWCHART)

```
WHAT ARE EPHEMERAL PORTS?
  When a client initiates a TCP connection, it uses:
    Destination port: the service port (443, 5432, etc.)
    Source port: a randomly chosen ephemeral (temporary) port (OS-selected)

  Range: 1024-65535 (Linux default: 32768-60999)
  AWS recommends: cover 1024-65535 for broad compatibility

WHY NACL NEEDS EPHEMERAL PORT RULES:
  Client (browser) → Server (ALB) on port 443
    Client source port: 49521 (ephemeral, chosen by browser's OS)

  ALB processes request, sends response:
    Source: ALB (43.x.x.x:443)
    Destination: client (203.x.x.x:49521) ← the ephemeral port

  Public subnet NACL outbound rule: must allow TCP 1024-65535 dst 0.0.0.0/0
  If missing: response packets to client's ephemeral port are blocked by NACL
  User sees: request hangs, times out, or connection drops after TCP handshake

PRACTICAL IMPACT:
  Forget ephemeral port outbound rule → every connection mysteriously drops after handshake
  Very common NACL misconfiguration
  Symptoms: TCP connects (3-way handshake), then data transfer fails

SECURITY NOTE: You might think "allowing 1024-65535 outbound is a huge range — security risk?"
  Not really. These are RESPONSE ports, not server listening ports.
  A server on port 443 responds from port 443, not ephemeral ports.
  Ephemeral ports are client-side: short-lived, OS-chosen.
  Opening 1024-65535 outbound only allows response traffic to complete — not new inbound.
```

---

### When to Use NACL vs Security Group

```
USE NACL FOR:
  ┌── Blocking specific IP ranges across an entire subnet
  │     Example: block known malicious CIDR 203.0.113.0/24 from reaching ALL resources
  │     NACL DENY rule: blocks at subnet boundary before SG is evaluated
  │     SG alternative: add deny... wait, SG can't deny. NACL is required.
  │
  ├── Subnet-level blanket policies
  │     "No subnet in the DB tier should accept traffic from the internet"
  │     NACL enforces this at subnet boundary, regardless of individual SG configurations
  │
  ├── Emergency IP blocking
  │     DDoS source IPs identified → add NACL DENY rule immediately
  │     Faster than WAF rule propagation, stops traffic at subnet edge
  │
  └── Compliance: defense-in-depth requirement
        PCI DSS requires two layers of network controls
        Layer 1: NACL (subnet-level packet filter)
        Layer 2: Security Group (instance-level stateful filter)

USE SECURITY GROUPS ONLY (skip custom NACL) FOR:
  ┌── Applications without IP blocklist requirements
  ├── All traffic control is service-to-service (SG references sufficient)
  ├── Small teams without dedicated security operations
  └── Standard three-tier architecture where SG chaining covers all cases

LEAVE DEFAULT NACL (allow-all) WHEN:
  Security Groups handle all access control
  No external IP blocklist requirement
  Adding NACL complexity for no security gain just adds operational burden
```

---

### Common NACL Misconfigurations

```
MISTAKE 1: Missing ephemeral port outbound rules
  Where to add: any NACL that receives inbound connections
  Public subnet NACL outbound: allow TCP 1024-65535 → 0.0.0.0/0
  Symptom: TCP connects, data transfer fails or times out
  Diagnosis: try with default NACL (allow-all) → if it works, missing ephemeral rule

MISTAKE 2: Creating custom NACL without adding rules
  Custom NACL default: DENY ALL (rule * only)
  Attaching custom NACL to subnet: ALL traffic immediately blocked
  Common: Terraform creates NACL + subnet association in one apply
           If rules resource has dependency error → NACL attached, rules not created → outage
  Prevention: use Terraform explicit depends_on or combine rules in same resource

MISTAKE 3: NACL rule overlap hiding intended behavior
  Rule 100: DENY all TCP from 10.0.0.0/8 on any port
  Rule 200: ALLOW TCP 5432 from 10.10.11.0/24
  Result: Rule 100 matches 10.10.11.0/24 traffic (it's within 10.0.0.0/8) → DENIED
          Rule 200 never reached
  Fix: either put the more specific ALLOW rule at lower number than the DENY
        OR make the DENY more specific so it doesn't match the allowed traffic

MISTAKE 4: NACL association covers multiple subnets — broad impact
  Same NACL attached to 5 subnets
  You add DENY rule for incident response
  Forgot: this affects ALL 5 subnets, not just the one under attack
  Fix: create separate NACLs per subnet tier, don't share incident-response NACLs
```

---

### Cost Model

```
NETWORK ACLs: FREE
  Creating NACLs, adding rules, associating with subnets: $0
  No limit on rules (default 20 inbound + 20 outbound, increase via support request)

OPERATIONAL COST:
  Managing NACLs adds complexity → engineer time → indirect cost
  For most production setups:
    Simple three-tier with Security Group chaining: custom NACLs add little security value
    Regulated environments (PCI, HIPAA): NACLs required for defense-in-depth

  Use NACLs when you have:
    ├── IP-based blocking requirements (SG can't do this)
    ├── Regulatory requirement for two separate network control layers
    └── DDoS mitigation needs (block attacker CIDRs at subnet level)
```
