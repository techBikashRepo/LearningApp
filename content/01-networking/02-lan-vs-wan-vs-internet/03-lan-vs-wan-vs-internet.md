# LAN vs WAN vs Internet — Part 3 of 3

### Topic: AWS Certification Focus, Comparison Tables, Quick Revision & Architect Exercise

**Series:** Networking Fundamentals → System Design → AWS Solutions Architect
**Audience:** 14-Year Experienced Full-Stack Developer → Becoming an Architect
**Sections Covered:** 9, 10, 11, 12

---

## SECTION 9 — Certification Focus: AWS Solutions Architect Associate (SAA-C03)

### Exam-Critical Fact 1 — VPC is Your LAN; Subnets Are Isolated Segments

The AWS SAA exam frequently tests VPC design. Core rules:

- A VPC spans all AZs within a single region — it's a region-level LAN
- A subnet exists in exactly ONE Availability Zone
- Public subnet = has route to Internet Gateway (can receive inbound from internet)
- Private subnet = no route to Internet Gateway (cannot receive inbound internet connections)
- A "database subnet" is simply a private subnet where you place RDS — AWS doesn't have a special DB subnet type; it's a design convention

**The subnets-per-AZ exam pattern:**
When the exam says "highly available" or "fault tolerant," always deploy at least 2 subnets in 2 different AZs. If one AZ goes down, the other continues. A single-AZ deployment is never "highly available" in AWS terminology.

---

### Exam-Critical Fact 2 — VPN vs Direct Connect (WAN to AWS)

This is tested frequently:

|                     | Site-to-Site VPN              | AWS Direct Connect                       |
| ------------------- | ----------------------------- | ---------------------------------------- |
| Goes over           | Public Internet (encrypted)   | Dedicated private fiber                  |
| Setup time          | Hours                         | Weeks to months                          |
| Bandwidth           | Up to ~1.25 Gbps              | 1 Gbps, 10 Gbps, 100 Gbps                |
| Latency             | Variable (internet dependent) | Consistent, low                          |
| Cost                | Low                           | High (port hours + data)                 |
| BGP support         | Yes                           | Yes                                      |
| Encryption built-in | Yes (IPSec)                   | No (must add VPN over DX for encryption) |

**Important trap:** Direct Connect does NOT encrypt traffic by default. If compliance requires encryption in transit AND private connectivity, you run a VPN tunnel over the Direct Connect link (VPN over Direct Connect). This gives you both encryption AND private WAN characteristics.

**Another trap:** If a company needs to set up AWS connectivity "immediately" for a temporary workload — answer is VPN. If they need "consistent high bandwidth, private, regulatory compliance" — answer is Direct Connect.

---

### Exam-Critical Fact 3 — Transit Gateway

The exam loves Transit Gateway for large-scale connectivity:

- Connects many VPCs (same account + cross-account) and on-premises networks in a hub-and-spoke topology
- Replaces N\*(N-1)/2 VPC peering connections with N TGW attachments
- Supports route tables — you control which VPCs can communicate with which
- Supports multicast (one VPC sends to many)
- Supports inter-region peering (connect Transit Gateways across regions)

**The exam scenario:** "Company has 50 VPCs across 10 AWS accounts and needs all VPCs to communicate with each other and with on-premises through a single managed connection." → answer: Transit Gateway + Direct Connect Gateway.

---

### Exam-Critical Fact 4 — CloudFront Is the Internet's Edge

CloudFront operates at the internet layer, caching content at 450+ edge locations globally.

Key exam points:

- CloudFront reduces load on your origin (LAN/VPC) by serving cached responses from the edge
- CloudFront origins can be: S3, ALB, EC2, API Gateway, or any HTTP endpoint
- OAC (Origin Access Control) restricts S3 buckets to only allow CloudFront access — prevents users from bypassing the CDN and directly accessing S3
- SSL certificates for CloudFront MUST be in `us-east-1` (N. Virginia) — exam trap question
- CloudFront supports custom TLS certificates, custom headers, Lambda@Edge (compute at edge), and CloudFront Functions
- Use **CloudFront + S3** for static website hosting at global scale with no origin server needed

---

### Exam-Critical Fact 5 — VPC Endpoints (Keep Traffic on AWS LAN)

A critical concept: when an EC2 in a private subnet needs to talk to S3 or DynamoDB, by default this traffic routes through the NAT Gateway → Internet Gateway → public internet → AWS service endpoint.

**VPC Endpoints** keep this traffic entirely within AWS's internal network (never touching the internet):

- **Gateway Endpoint** — for S3 and DynamoDB only. Free. Adds route entries to your Route Table. Traffic stays on AWS private network.
- **Interface Endpoint (PrivateLink)** — for 100+ AWS services. Creates an ENI with a private IP in your subnet. Usage costs apply. Traffic stays on AWS private network.

**Why this matters in exams:**

- Security: Prevents data exfiltration through public internet
- Compliance: "Data must never leave AWS network"
- Performance: Lower latency than routing through NAT Gateway
- Cost: NAT Gateway charges per GB of data. A Gateway Endpoint to S3 is free and removes that NAT Gateway data processing cost for high-volume S3 access.

---

### Exam-Critical Fact 6 — Bandwidth vs Latency vs Throughput (Frequently Confused)

| Term       | Definition                                              | Analogy                                  |
| ---------- | ------------------------------------------------------- | ---------------------------------------- |
| Bandwidth  | Maximum data transfer rate of the link                  | Width of a highway                       |
| Latency    | Time for one packet to travel from A to B               | Speed limit on the highway               |
| Throughput | Actual data transferred per second (always ≤ bandwidth) | Actual cars passing the toll per second  |
| Jitter     | Variation in latency between packets                    | Inconsistent car speeds causing bunching |

**Exam trap:** A direct connect 10 Gbps link has high bandwidth but still has ~20ms latency to a far region. High bandwidth does NOT mean low latency. Latency is limited by speed of light and geographic distance.

---

### Exam-Critical Fact 7 — AWS Global Network Backbone

When the exam asks about the AWS internal network:

- AWS regions are connected by AWS's **private global fiber backbone** — not the public internet
- Traffic between AZs in the same region travels over redundant, dedicated fiber — not internet
- AWS Global Accelerator uses this backbone to give user traffic a "private internet" experience
- Data replication between S3 Cross-Region Replication, RDS Multi-AZ standby communications, and DynamoDB Global Tables all travel over this private backbone

This is why AWS inter-region communication is more reliable and consistent than general internet connectivity — AWS owns the WAN between its regions.

---

## SECTION 10 — Comparison Tables

### Table 1 — LAN vs MAN vs WAN vs Internet

| Property         | LAN               | MAN               | WAN              | Internet         |
| ---------------- | ----------------- | ----------------- | ---------------- | ---------------- |
| Geographic scope | Building / Campus | City              | Country / Globe  | Global           |
| Typical speed    | 1–100 Gbps        | 100 Mbps–10 Gbps  | 10 Mbps–100 Gbps | Variable         |
| Latency          | <1ms              | 1–10ms            | 10–150ms         | 5–300ms          |
| Ownership        | You               | ISP / City        | Telecom / ISP    | No single owner  |
| Privacy          | Private           | Private/Leased    | Private/Leased   | Public           |
| AWS equivalent   | VPC               | Regional backbone | Direct Connect   | Internet Gateway |

---

### Table 2 — Site-to-Site VPN vs Direct Connect vs VPN over Direct Connect

| Feature       | Site-to-Site VPN    | Direct Connect  | VPN over Direct Connect         |
| ------------- | ------------------- | --------------- | ------------------------------- |
| Path          | Public internet     | Dedicated fiber | Dedicated fiber                 |
| Encryption    | Yes (IPSec)         | No              | Yes (IPSec over DX)             |
| Latency       | Variable            | Consistent      | Consistent                      |
| Bandwidth max | ~1.25 Gbps          | 100 Gbps        | Limited by VPN overhead         |
| Setup time    | Hours               | Weeks           | Weeks (need DX first)           |
| Cost          | Low                 | High            | High + VPN cost                 |
| Use for       | Quick setup, backup | Production WAN  | Compliant + private + encrypted |

---

### Table 3 — Internet Gateway vs NAT Gateway vs Virtual Private Gateway

| Gateway Type                  | Direction            | Used For                               | In Subnet                      |
| ----------------------------- | -------------------- | -------------------------------------- | ------------------------------ |
| Internet Gateway (IGW)        | Inbound + Outbound   | Public-facing resources                | Public subnet has route to IGW |
| NAT Gateway                   | Outbound only        | Private resources need internet access | Deployed IN public subnet      |
| Virtual Private Gateway (VGW) | Inbound + Outbound   | VPN or Direct Connect entry point      | Attached to VPC edge           |
| Egress-Only IGW               | Outbound only (IPv6) | IPv6 resources in private subnets      | Route table entry              |

---

### Table 4 — VPC Peering vs Transit Gateway vs PrivateLink vs VPN

| Feature           | VPC Peering        | Transit Gateway       | PrivateLink          | Site-to-Site VPN    |
| ----------------- | ------------------ | --------------------- | -------------------- | ------------------- |
| Connects          | 2 VPCs             | Many VPCs             | Service to consumers | On-premises to VPC  |
| Transitive        | No                 | Yes                   | N/A                  | No                  |
| Scale             | Few VPCs           | Hundreds of VPCs      | Many consumers       | One on-prem network |
| Cross-account     | Yes                | Yes                   | Yes                  | Yes                 |
| Cross-region      | Yes                | Yes (via peering)     | No                   | No                  |
| Internet involved | No                 | No                    | No                   | Yes (encrypted)     |
| Cost              | Data transfer only | Per attachment + data | Per endpoint + data  | Per VPN hour + data |

---

### Table 5 — CloudFront vs Global Accelerator vs Route 53 Latency Routing

| Feature             | CloudFront                        | Global Accelerator           | Route 53 Latency                     |
| ------------------- | --------------------------------- | ---------------------------- | ------------------------------------ |
| What it accelerates | HTTP/HTTPS content (with caching) | Any TCP/UDP traffic          | DNS resolution only                  |
| Caching             | Yes (content cached at edge)      | No                           | No                                   |
| Static IP?          | No (uses domain names)            | Yes (2 static Anycast IPs)   | No                                   |
| Best for            | Web content, APIs, media          | Gaming, IoT, non-HTTP        | Basic geo-based routing              |
| Uses AWS backbone   | Yes                               | Yes                          | No (DNS only, client takes own path) |
| DDoS protection     | AWS Shield Standard built-in      | AWS Shield Standard built-in | Standard                             |

---

## SECTION 11 — Quick Revision

### 10 Key Points to Remember Always

1. **LAN** = small geographic area, you own it, high speed (1–100 Gbps), sub-ms latency.

2. **WAN** = connects multiple LANs across cities/countries, leased from telecom or built on owned fiber.

3. **Internet** = network of all networks. No single owner. Uses TCP/IP. Governed by BGP between Autonomous Systems.

4. **NAT** = allows many private IP devices to share one public IP. Your router does NAT. AWS NAT Gateway does NAT for AWS private subnets.

5. **Private IP ranges** (10.x, 172.16-31.x, 192.168.x) are NOT routable on the internet. NAT translates them.

6. **In AWS**, a **VPC = your LAN**. **Direct Connect = your private WAN to AWS.** **Internet Gateway = your internet connection.**

7. **NAT Gateway** goes in a **public subnet**. Private subnet resources route through it for outbound internet. It does NOT allow inbound connections.

8. **VPC Endpoints** keep traffic to AWS services (S3, DynamoDB, etc.) on AWS's private network — never touching the internet.

9. **Transit Gateway** is the scalable hub for connecting many VPCs. VPC Peering doesn't scale beyond ~10 VPCs.

10. **BGP** is the routing protocol that holds the internet together. ISPs exchange routing information via BGP. A misconfigured BGP announcement can reroute global internet traffic.

---

### 30-Second Interview Explanation

_"LAN is a high-speed private network you own inside a building or campus — think your office's internal network. WAN connects multiple LANs across geographic distances — either leased private lines or managed fiber networks. The Internet is the global public network of all networks, using TCP/IP and BGP for routing between independently managed Autonomous Systems. In AWS, these map directly: a VPC is your LAN — isolated, private, fast. Direct Connect is your private WAN — dedicated fiber between your office and AWS. The Internet Gateway is your internet connection. The critical design principle is: keep traffic on the LAN wherever possible, use private WAN for sensitive cross-location traffic, and only use the public internet for public-facing workloads — because every layer adds latency, cost, and risk."_

---

### Memory Tricks

**LAN vs WAN scope:**

- **L**AN = **L**ocal = **L**imited (your building)
- **W**AN = **W**ide = **W**orld (spans distance)
- **I**nternet = **I**nfinite connections (global)

**NAT Gateway placement:**

- NAT Gateway lives in a **PUBLIC** subnet even though it serves **PRIVATE** subnet resources
- Think: "The Guard (NAT) stands at the Public Gate, protecting the Private residents"

**AWS Gateway types:**

- **I**nternet Gateway = **I**n and Out for public resources
- **NAT** Gateway = **N**ot Accessible from internet (outbound only for private)
- **V**irtual Private Gateway = **V**PN entry point

**Direct Connect vs VPN:**

- **D**irect Connect = **D**edicated fiber (like **D**irect dial to AWS)
- **V**PN = **V**ia public internet (encrypted tunnel, **V**ariable performance)

---

## SECTION 12 — Architect Thinking Exercise

### The Scenario

Read carefully and think for 2-3 minutes before reading the solution.

---

**You are the cloud architect at a healthcare company with the following setup:**

- 3 hospitals across different cities, each with its own on-premises LAN running legacy systems (EMR — Electronic Medical Records)
- Central IT office in the company headquarters manages all systems
- The company is migrating to AWS but must complete within 18 months
- Requirements:
  1. Hospital staff must access AWS-hosted applications during migration with the same performance as their current LAN experience
  2. Patient data (PHI — Protected Health Information under HIPAA) must NEVER transit the public internet
  3. Hospitals must continue to operate even if the AWS connection fails (local fallback)
  4. All 3 hospital LANs must be able to communicate with each other after migration
  5. Cost must be controlled — this is a non-profit hospital network

**Questions to think about:**

1. How do you connect 3 hospital LANs to AWS while ensuring PHI never hits the public internet?
2. How do you provide local fallback if AWS connectivity fails?
3. How do you enable hospital-to-hospital communication after migration?
4. What's the cost-optimized approach for a non-profit with limited budget?

---

### Solution and Reasoning

**Problem 1 — Connecting to AWS Without Public Internet for PHI**

Three hospital LANs must connect to AWS privately. Options:

**Full Direct Connect (ideal but expensive):**
Deploy a Direct Connect at a carrier-neutral colocation facility near each hospital. Each hospital MPLS WAN connects to the colo, which connects to AWS. All PHI travels on dedicated fiber, never on the internet.

**Cost-optimized for non-profit: Shared Direct Connect via hosted connection:**
Instead of each hospital having a full Direct Connect port (expensive), use a **Direct Connect Hosted Connection** through a partner (like Equinix or Megaport). The partner has a large Direct Connect port; the hospital buys a shared slice (100 Mbps or 1 Gbps). Lower cost, still private.

```
Hospital A LAN ──┐
Hospital B LAN ──┤──[MPLS WAN]──[DX Partner Location]──[AWS Direct Connect]──[VPC]
Hospital C LAN ──┘
HQ LAN ──────────┘
```

**Problem 2 — Local Fallback If AWS Connectivity Fails**

Deploy a **Site-to-Site VPN as backup** alongside Direct Connect. This is a standard pattern:

- Primary path: Direct Connect (private, consistent)
- Backup path: Site-to-Site VPN (over internet, encrypted)
- Route configuration: BGP prefer DX route; VPN route has lower preference
- When DX fails, BGP automatically fails over to VPN within seconds

Local applications (EMR legacy systems) can also operate in local-only mode — the hospital LAN can function without AWS for emergency operations. The fallback VPN gives architects time to restore DX without a service cliff.

**Problem 3 — Hospital-to-Hospital Communication**

After migration, all hospitals connect to the same AWS VPC (or separate VPCs in the same region). To enable inter-hospital communication:

**Option A — Transit Gateway:**
All hospital-connected VPCs attach to a single Transit Gateway. Route tables control which hospitals can communicate with which. Hospital A can reach Hospital B through: Hospital A LAN → Direct Connect → AWS VPC-A → Transit Gateway → AWS VPC-B → Direct Connect → Hospital B LAN.

**Option B — Shared Services VPC:**
Instead of direct hospital-to-hospital routing, deploy a shared services VPC with common applications (PACS imaging, shared records). Each hospital connects to the shared VPC through Transit Gateway. Hospitals don't talk directly — they communicate through shared services.

For a non-profit, Option B reduces complexity and cost — no need for many Transit Gateway attachments.

**Problem 4 — Cost Control**

Cost priorities for a non-profit:

1. Use **Direct Connect Hosted connections** (partner-provided) instead of dedicated ports — significantly cheaper
2. Use one **Transit Gateway** per region instead of multiple VPC Peering connections
3. Use **VPC Gateway Endpoints** (free) for S3 and DynamoDB — removes NAT Gateway data processing charges
4. Use **Savings Plans or Reserved Instances** for EC2 (1-year or 3-year) — 40-60% savings over on-demand
5. During migration, keep legacy EMR systems on-premises and only migrate as ready — don't pay for cloud AND legacy full infrastructure simultaneously

**Final Architecture:**

```
[Hospital A LAN] ──┐
[Hospital B LAN] ──┤──[Shared Direct Connect (Partner)]──[Virtual Private Gateway]
[Hospital C LAN] ──┘                                              │
[HQ LAN] ──────────┘                                             │
                                                           [Central VPC]
                                                                  │
                                                       [Transit Gateway]
                                                        /    |    \
                                                   [VPC-A][VPC-B][VPC-C]
                                                   (App)  (EMR)  (Shared)
                                                                  │
                                          [VPC Gateway Endpoint (S3 — PHI storage)]
```

Site-to-Site VPN runs in parallel as a backup path. All PHI stays on private network. Hospitals can communicate via Transit Gateway. Non-profit cost is controlled through hosted connections and share architecture.

---

### Architect's Takeaway

The entire solution was driven by one fundamental concept: **knowing which traffic belongs on LAN, which on WAN, and which on the internet.** PHI belongs on private WAN (Direct Connect). Internal application traffic belongs on LAN (VPC). Public-facing stuff (if any) goes through Internet Gateway. Every architecture decision flowed from this classification.

---

## Complete Series Summary

| File    | Sections | Core Learning                                                                                                                         |
| ------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| File 01 | 1–4      | Intuition, LAN/WAN/Internet definitions, NAT explanation, architecture diagram, Netflix request flow with latency analysis            |
| File 02 | 5–8      | Netflix CDN strategy, system design impact, full AWS mapping (VPC/Direct Connect/TGW/CloudFront/Global Accelerator), 8 interview Q&As |
| File 03 | 9–12     | AWS SAA exam traps, 5 comparison tables, quick revision with memory tricks, healthcare architect exercise with full solution          |

**Next Topic:** Public IP vs Private IP
