# IP Address Structure (IPv4 Concept) — Part 3 of 3

### Topic: AWS Certification Focus, Comparison Tables, Quick Revision & Architect Exercise

**Series:** Networking Fundamentals → System Design → AWS Solutions Architect
**Audience:** 14-Year Experienced Full-Stack Developer → Becoming an Architect
**Sections Covered:** 9, 10, 11, 12

---

## SECTION 9 — Certification Focus: AWS Solutions Architect Associate (SAA-C03)

### Exam-Critical Fact 1 — Subnet Address Calculation

The exam frequently includes questions requiring CIDR calculations. You must be able to quickly determine:

1. Number of hosts in a subnet
2. First usable / last usable address
3. Broadcast address
4. Whether a given host count fits a given prefix

**Universal formula:**

- Total addresses = 2^(32 - prefix)
- Usable hosts (generic) = Total - 2
- Usable hosts (AWS) = Total - 5

**Rapid CIDR reference for exams:**

| Prefix | Total | AWS Usable | Block Size (increment) |
| ------ | ----- | ---------- | ---------------------- |
| /20    | 4,096 | 4,091      | 4,096                  |
| /21    | 2,048 | 2,043      | 2,048                  |
| /22    | 1,024 | 1,019      | 1,024                  |
| /23    | 512   | 507        | 512                    |
| /24    | 256   | 251        | 256                    |
| /25    | 128   | 123        | 128                    |
| /26    | 64    | 59         | 64                     |
| /27    | 32    | 27         | 32                     |
| /28    | 16    | 11         | 16                     |
| /29    | 8     | 3          | 8                      |

**The "block size" trick:** When finding the next subnet address, add the block size to the current network address. For /26: 10.0.0.0, 10.0.0.64, 10.0.0.128, 10.0.0.192.

---

### Exam-Critical Fact 2 — VPC CIDR Constraints in AWS

- **VPC CIDR range:** /16 to /28. You cannot create a VPC smaller than /28 or larger than /16.
- **Subnet CIDR range:** /16 to /28. Same limits apply.
- **VPC can have up to 5 CIDR blocks** (1 primary + 4 secondary). You add secondary CIDRs to expand the VPC without recreating it.
- **Subnets must be within the VPC CIDR.** A subnet 10.1.0.0/24 cannot exist in a VPC with CIDR 10.0.0.0/16.

**Exam trap:** "A company's VPC is 10.0.0.0/16 and they're running out of addresses. What should they do?" → Add a secondary CIDR block to the VPC (e.g., 10.1.0.0/16), then create new subnets in the new range.

---

### Exam-Critical Fact 3 — Security Group vs Subnet-Level IP Rules

Security groups support CIDR notation in their rules. For example:

```
Inbound Rule: Port 3306 from 10.0.10.0/24
```

This allows MySQL connections only from IPs in the range 10.0.10.0 to 10.0.10.255 — the App Tier subnet. This is subnet-to-subnet security using CIDR matching.

Alternatively, Security Group references allow "from App-Tier-SG" — this is more dynamic (doesn't break if the subnet CIDR changes) and is the preferred approach.

**When to use CIDR in SG rules:**

- Allowing a specific on-premises IP range
- Allowing corporate VPN IP range
- Allowing a monitoring tool's known IP range

**When to use SG reference in SG rules:**

- Service-to-service communication within AWS (preferred — doesn't hardcode IP ranges)

---

### Exam-Critical Fact 4 — Route Table Propagation and Specificity

**Route Table Basics:**

- Each subnet is associated with exactly one route table
- A route table can be associated with multiple subnets
- Route tables are evaluated using longest prefix match
- Local route (VPC CIDR → local) always exists and cannot be deleted

**Route priority:** More specific routes always win. If you have:

```
10.0.0.0/8   → vpn-connection
10.0.1.0/24  → local
```

Traffic to 10.0.1.50 matches BOTH routes, but /24 is longer (more specific) than /8 → local route wins.

**Propagated routes:** When you attach a Virtual Private Gateway (VPN), you can enable route propagation — the on-premises routes are automatically added to the route table. If these overlap with VPC subnets, it can cause routing issues. Always review auto-propagated routes.

---

### Exam-Critical Fact 5 — IP CIDR in AWS WAF, Security Groups, and NACLs

All three AWS controls accept CIDR-based IP matching:

**AWS WAF IP Sets:** Block or allow specific IP CIDRs at the CloudFront/ALB layer. Example: Block all traffic from known botnet CIDR ranges. Maximum 10,000 IP addresses per IP set.

**Security Group rules:** Accept CIDR or SG reference. /32 for a specific IP (e.g., allow only the office IP 203.0.113.42/32). /0 for all IPs (0.0.0.0/0 means allow all — use with extreme caution on inbound rules).

**NACLs:** Same CIDR support but with stateless evaluation and both allow+deny rules. Use NACLs to block specific hostile CIDRs at the subnet boundary.

**Shield Advanced + Global Threat Dashboard:** AWS curates threat intelligence of malicious IP ranges — can be applied to WAF IP sets automatically when Shield Advanced is enabled.

---

### Exam-Critical Fact 6 — Elastic IPs and Customer-Brought IP (BYOIP)

Large enterprises can bring their own IP addresses to AWS (BYOIP — Bring Your Own IP):

- Advertise your existing public IP ranges through AWS infrastructure using BGP
- Eliminates need to update partner whitelists or DNS when migrating to AWS
- Supports IPv4 and IPv6

For the exam: BYOIP enables organizations to migrate to AWS without changing public IP addresses — critical when those IPs are whitelisted with regulators, financial partners, or government systems.

---

## SECTION 10 — Comparison Tables

### Table 1 — CIDR Reference — Complete Cheatsheet

| Prefix | Hosts (standard) | Hosts (AWS)       | Block Size | Use Case                    |
| ------ | ---------------- | ----------------- | ---------- | --------------------------- |
| /8     | 16,777,214       | 16,777,211        | 16,777,216 | Entire RFC 1918 Class A     |
| /16    | 65,534           | 65,531            | 65,536     | VPC (max recommended)       |
| /17    | 32,766           | 32,763            | 32,768     | Half of a VPC               |
| /18    | 16,382           | 16,379            | 16,384     | Regional allocation         |
| /19    | 8,190            | 8,187             | 8,192      | EKS pod CIDR                |
| /20    | 4,094            | 4,091             | 4,096      | Large subnet                |
| /24    | 254              | 251               | 256        | Standard subnet             |
| /25    | 126              | 123               | 128        | Half subnet                 |
| /26    | 62               | 59                | 64         | Small subnet                |
| /27    | 30               | 27                | 32         | Very small (public subnets) |
| /28    | 14               | 11                | 16         | Tiny (management, GW)       |
| /30    | 2                | (not used in AWS) | 4          | P2P links                   |
| /32    | 1                | 1 specific IP     | 1          | Host route, EIP, SG rules   |

---

### Table 2 — Classful vs CIDR (Classless)

| Property        | Classful (Old)                               | CIDR (Current)                                   |
| --------------- | -------------------------------------------- | ------------------------------------------------ |
| Subnet sizes    | Fixed per class (A=/8, B=/16, C=/24)         | Any prefix length /0 to /32                      |
| Flexibility     | None                                         | Full                                             |
| Address waste   | Very high (Class B for 300 hosts wastes 65K) | Minimal (right-size each subnet)                 |
| Routing entries | Fewer (only A/B/C blocks)                    | More (but aggregation/supernetting reduces this) |
| Used today      | No (legacy only)                             | Yes (everything modern)                          |

---

### Table 3 — Subnet Components for Any Network

| Component         | Formula                    | Example for 10.0.1.0/26 |
| ----------------- | -------------------------- | ----------------------- |
| Network address   | First address              | 10.0.1.0                |
| First usable host | Network + 1                | 10.0.1.1                |
| Last usable host  | Broadcast - 1              | 10.0.1.62               |
| Broadcast         | Network + (block size - 1) | 10.0.1.63               |
| Total addresses   | 2^(32-prefix)              | 2^6 = 64                |
| Usable (standard) | Total - 2                  | 62                      |
| Usable (AWS)      | Total - 5                  | 59                      |
| Subnet mask       | 32-prefix bits set         | 255.255.255.192         |

---

### Table 4 — VPC Design CIDR Guidelines

| Use Case                 | Recommended VPC CIDR                      | Reasoning                                            |
| ------------------------ | ----------------------------------------- | ---------------------------------------------------- |
| Small startup            | 10.0.0.0/16                               | 65K addresses, room to scale                         |
| EKS cluster              | 10.0.0.0/16 + secondary /16               | VPC CNI needs large pod address space                |
| Multi-account enterprise | One /16 per account from 10.0.0.0/8       | 256 accounts possible without overlap                |
| Hybrid cloud (DX + VPCs) | 10.0-49.x for cloud, 10.100.x for on-prem | Clear separation prevents routing confusion          |
| Multi-region             | Different /16 per region per account      | Same-named subnets in different regions are distinct |

---

### Table 5 — Common Exam Scenarios and Answers

| Scenario                                        | Answer                           |
| ----------------------------------------------- | -------------------------------- |
| Need 50 hosts in a subnet. Smallest AWS subnet? | /26 (59 usable in AWS ≥ 50)      |
| Need 100 hosts. Smallest?                       | /25 (123 usable ≥ 100)           |
| Need 250 hosts. Smallest?                       | /24 (251 usable ≥ 250)           |
| VPC is 10.0.0.0/16. Valid subnet?               | 10.0.5.0/24 ✓ (within VPC CIDR)  |
| VPC is 10.0.0.0/16. Valid subnet?               | 10.1.0.0/24 ✗ (outside VPC CIDR) |
| Two VPCs: both 10.0.0.0/16. Can you peer them?  | No — overlapping CIDR            |
| Smallest possible AWS subnet?                   | /28 (11 usable)                  |
| Can a VPC be /8?                                | No — max is /16                  |

---

## SECTION 11 — Quick Revision

### 10 Key Points to Remember Always

1. **IPv4 = 32 bits** written as 4 octets (0–255 each), e.g., 192.168.1.45. Total possible: 4.3 billion addresses.

2. **Network part + Host part**. The subnet mask (or CIDR prefix) defines the boundary. Same network means same first N bits.

3. **CIDR formula**: Total addresses = 2^(32 - prefix). Usable = Total - 2 (standard) or Total - 5 (AWS).

4. **Subnetting** = borrowing host bits to create smaller networks. Each borrowed bit doubles the number of subnets, halves their size.

5. **Longest prefix match** = the routing rule. More specific routes always win. A /32 beats a /24 beats a /8.

6. **AWS VPC CIDR** must be between /16 and /28. Subnet CIDR must be within the VPC CIDR. Cannot be changed after creation.

7. **AWS reserves 5 addresses** per subnet: .0 (network), .1 (router), .2 (DNS), .3 (reserved), .255 (broadcast).

8. **Overlapping CIDR blocks cannot be peered** in AWS. Plan CIDR space upfront using a company-wide CIDR allocation scheme.

9. **0.0.0.0/0 in a route table** = default route — matches all destinations. Used to send all unmatched traffic to the Internet Gateway or VPN.

10. **BYOIP** (Bring Your Own IP) is available in AWS — enterprises can migrate to AWS without changing their public IP addresses.

---

### 30-Second Interview Explanation

_"An IPv4 address is 32 bits written as four decimal octets — like 10.0.1.45. It's divided into a network part and a host part, defined by the CIDR prefix length. /24 means the first 24 bits identify the network, last 8 bits identify the host — giving 256 addresses, 254 usable. Subnetting borrows additional host bits to create smaller networks for tier isolation. In AWS, VPCs are assigned a /16 CIDR block, divided into /24 subnets per tier per Availability Zone. AWS reserves 5 addresses per subnet. The critical routing principle is longest prefix match — more specific routes override general ones. Never use overlapping CIDRs across VPCs you plan to peer, and always design your CIDR hierarchy upfront — it cannot be changed after VPC creation."_

---

### Memory Tricks

**CIDR formula — "32 minus, then 2 to the power"**

- Total = 2^(32 - prefix): "32 minus the prefix gives the power of 2"
- /24 → 32-24=8 → 2^8 = 256

**AWS reserved addresses — "NRDRB" = 5 addresses**

- **N**etwork, **R**outer, **D**NS, **R**eserved, **B**roadcast

**Subnetting rule — "Borrow bits → halve the size, double the count"**

- Each bit borrowed: subnet size halves, subnet count doubles
- /24 → borrow 2 bits → /26 → 4 subnets, each 64 addresses

**Longest prefix match — "More specific wins"**

- Like GPS: "Turn at Main Street" vs "Turn at 123 Main Street San Francisco" → more specific directions win

**VPC size limits — "/16 is the max, /28 is the min"**

- /16 = max VPC (big house) → /28 = min VPC (tiny closet)

---

## SECTION 12 — Architect Thinking Exercise

### The Scenario

Read carefully and think for 2-3 minutes before reading the solution.

---

**You are the infrastructure architect at a fintech company that just acquired two smaller companies.**

**Situation:**

- Your company uses AWS with VPC CIDR: **10.0.0.0/16** across 3 accounts (prod, staging, dev)
- Acquired Company A (also on AWS) uses VPC CIDR: **10.0.0.0/16** (same as yours)
- Acquired Company B uses on-premises networking with: **10.0.0.0/16** and **192.168.0.0/16**

**Business requirements:**

1. All three companies must be able to communicate internally within 6 months
2. All data exchange between companies must stay off the public internet
3. Cost must be optimized — minimize re-IP work where possible
4. Looking forward: a new greenfield cloud environment needs to be set up for the joint venture, ensuring no CIDR conflicts with any of the existing three environments

**The problem:** All three environments use overlapping IP space. You cannot directly peer VPCs or connect Direct Connect with overlapping CIDRs.

**Questions to think through:**

1. What are your options when CIDR space overlaps?
2. How do you enable Communication A ↔ B and A ↔ C without full re-IP?
3. What CIDR should the new joint venture environment use?

---

### Solution and Reasoning

**Understanding the constraints:**

Overlapping CIDRs block direct peering. But there are several architectural options that avoid full re-IP while still enabling communication:

---

**Option 1 — AWS Transit Gateway with NAT (Overlapping CIDR solution)**

AWS Transit Gateway supports a technique called **appliance mode + NAT** to handle overlapping CIDR VPC connections. Using NAT instances or AWS NAT at the TGW attachment level, you translate IPs before routing:

Company (10.0.0.0/16) talks to Acquired A (10.0.0.0/16):

- Company's IPs are translated to 100.64.1.0/24 before entering Acquired A's network
- Acquired A's IPs are translated to 100.64.2.0/24 before entering Company's network

Both sides see translated (non-overlapping) IPs. True source IPs are hidden by NAT.

Tradeoff: Appliance NAT for TGW is complex to manage. Application-level firewall rules based on IPs become unreliable (because IPs are translated). Good for temporary connectivity; not ideal long-term.

---

**Option 2 — Re-IP Acquired Company A (Recommended)**

Since Company A is newly acquired and its cloud environment is presumably smaller than the parent company's, it's more practical to re-IP Company A's VPC rather than build complex NAT infrastructure.

Strategy for minimizing re-IP work:

1. Assign Company A a non-overlapping CIDR: **10.2.0.0/16** (clearly separated)
2. Use cloud migration tools (CloudEndure, MGN) to lift-and-shift instances from old VPC to new VPC — tools handle IP reassignment at the OS level
3. Update DNS instead of updating application configs: applications call `db.companyA.internal` (DNS name), DNS is updated to resolve to the new IP. Zero application code changes.
4. Run old and new VPC in parallel during migration; use Route 53 DNS cutover

Key insight: DNS-first architecture makes re-IP far cheaper because no code changes are needed — only DNS record updates.

---

**Option 3 — Connecting Company B (On-Premises) via Direct Connect + NAT**

Company B uses 10.0.0.0/16 and 192.168.0.0/16 on-premises. Connecting via Direct Connect to the parent company's AWS (also 10.0.0.0/16) would create routing conflicts.

Solution: **CGW (Customer Gateway) + Virtual Private Gateway with BGP + NAT at the edge**

Deploy a NAT-capable firewall/router at the Direct Connect entry point that translates Company B's 10.0.x.x addresses to a non-overlapping range before they enter the parent VPC. Same technique as Option 1 but at the DX gateway level.

Long-term: Plan to re-IP Company B's on-premises network to a distinct range (10.3.0.0/16 for example) as part of their eventual cloud migration roadmap.

---

**The New Joint Venture CIDR — Greenfield Planning**

With three environments using 10.0.0.0/16, 10.1.0.0/16 (staging), 10.2.0.0/16 (dev), and Acquired A being moved to 10.3.0.0/16, the joint venture should get addresses that don't conflict with any present OR future environment.

**Recommendation:**

- Allocate the entire **10.10.0.0/14** block to the joint venture environment (10.10.x.x through 10.13.x.x)
- This gives 262,144 addresses — room for 4 full /16 VPCs (prod, staging, dev, DR)
- Completely separate from main company's 10.0.0.0/8 range used in lower octets
- Document this in AWS IPAM with "Joint Venture" ownership tag

**Final CIDR Map:**

```
10.0.0.0/16   — Parent Company: Production
10.1.0.0/16   — Parent Company: Staging
10.2.0.0/16   — Parent Company: Development
10.3.0.0/16   — Acquired Company A (re-IP'd)
10.4.0.0/16   — Acquired Company B (on-premises, planned re-IP)
10.10.0.0/14  — Joint Venture (4 × /16 available)
10.100.0.0/16 — Future acquisitions reserve
```

---

### Architect's Takeaway

CIDR conflicts are not a technical curiosity — they are a real, expensive organizational problem that every company discovering its M&A strategy causes. The solution is always the same: treat IP address space as a first-class infrastructure resource, plan it up-front with a company-wide CIDR registry, and use DNS over hardcoded IPs everywhere so that re-IP efforts only require DNS changes, not code changes.

---

## Complete Series Summary

| File    | Sections | Core Learning                                                                                                                     |
| ------- | -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| File 01 | 1–4      | IPv4 structure, binary-decimal, CIDR math, subnetting, network/host/broadcast, routing flow                                       |
| File 02 | 5–8      | ZIP code / building analogy, Netflix/AWS CIDR planning case studies, EKS pod IP scaling, enterprise CIDR design, 8 interview Q&As |
| File 03 | 9–12     | AWS SAA exam CIDR tables, VPC constraints, route table rules, BYOIP, 5 comparison tables, M&A CIDR conflict resolution exercise   |

**Next Topic:** Ports & Sockets
