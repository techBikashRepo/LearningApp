# LAN vs WAN vs Internet — Part 2 of 3

### Topic: Real World Systems, System Design Impact, AWS Mapping & Interview Prep

**Series:** Networking Fundamentals → System Design → AWS Solutions Architect
**Audience:** 14-Year Experienced Full-Stack Developer → Becoming an Architect
**Sections Covered:** 5, 6, 7, 8

---

## SECTION 5 — Real World Examples

### Real-Life Analogy 1 — Your Apartment Building vs Your City vs The Country

Think of a 20-floor apartment building. All apartments share the building's internal intercom system — they can call any apartment by pressing a number. That's fast, private, and only works inside the building. That is a **LAN**.

Now the city has a postal service connecting every building. You can send a letter to any building in the city. The postal service manages the routes — you just drop the letter. That city-wide connection is a **WAN**.

Now the national courier network connects all cities to all villages across the entire country — even internationally. Anyone with a valid address gets delivery. That's the **Internet**.

Each layer depends on the previous. You can't get a national delivery if your building's postal slot is broken. You can't send a cross-country package if your city's roads are blocked. Same with networks — your internet experience depends on your LAN (home Wi-Fi), your WAN link (ISP connection), and the internet backbone.

---

### Real-Life Analogy 2 — The Phone Call Analogy

When you make a call between two phones on the same office floor — that's internal (LAN-equivalent, PBX system). When the same company makes a call between its New York office and London office over a private leased line — that's WAN. When you call a random person anywhere in the world using the public telephone network — that's Internet-equivalent.

Notice: reliability, cost, and performance degrade as you move from internal → WAN → public internet. Architects always prefer keeping communication within the same LAN when possible, using WAN only when necessary, and the internet as the last resort for sensitive internal traffic.

---

### Real Software Example — Netflix's Network Architecture

Netflix is one of the most network-sophisticated companies on earth, responsible for ~15% of all global internet traffic at peak hours.

**The problem they solved:**
As Netflix grew to 200+ million subscribers globally, routing all video from centralized data centers over the public internet was:

- Expensive (paying ISPs for transit)
- Quality-degrading (too many hops = buffering)
- Latency-heavy (cross-continental routing for every stream)

**Their solution: Collapse the WAN distance with embedded CDN**

Netflix built the **Open Connect CDN** — over 1,000 server appliances deployed **inside ISP data centers** globally. When a Jio Fiber subscriber in Mumbai streams a movie, the video is served from Open Connect appliances sitting inside Jio's Mumbai data center — effectively making it a **LAN hop** from the ISP to the viewer.

```
Without Open Connect:
[App: Mumbai] → [Internet backbone] → [Netflix US datacenter] → [back across internet] → [Mumbai user]
Latency: 200ms+ | Transit cost: high | Quality: variable

With Open Connect (ISP-embedded):
[Mumbai user] → [Jio internal network] → [Netflix Open Connect inside Jio Mumbai]
Latency: <5ms | Transit cost: near-zero | Quality: consistent high bitrate
```

**The architect's lesson:** When WAN latency is killing your product's quality, the answer is not "make the WAN faster" — it's "eliminate the WAN by moving the content closer." Netflix turned a WAN problem into a LAN problem by embedding hardware inside ISPs. This is the same mental model behind AWS CloudFront.

---

## SECTION 6 — System Design Importance

### Impact on Scalability

Understanding LAN vs WAN drives how you distribute systems at scale.

**LAN-scale decisions (Intra-data-center):**
When services talk to each other within the same data center, they're on a LAN. You can assume:

- Sub-millisecond latency
- High throughput (10–100 Gbps between servers)
- Low packet loss

This allows you to make many service-to-service calls that would be unacceptable over WAN. A microservice calling a cache 50 times per request is fine if cache and service are in the same LAN. Move that cache to another data center (WAN) and you've just added 50 × 20ms = 1 second of forced latency.

**WAN-scale decisions (Multi-region):**
When you scale to multiple AWS regions (us-east-1, ap-south-1, eu-west-1), every cross-region call is a WAN call. Architects who don't respect this boundary build multi-region systems that are actually slower than single-region ones.

Rule: **Data that changes together should live together (same LAN/region). Data accessed globally should be cached at the edge (CDN).**

---

### Impact on Latency and Performance

The latency gap between LAN and WAN is enormous and often underestimated:

| Communication Type                     | Typical Latency |
| -------------------------------------- | --------------- |
| Same server (loopback)                 | <0.1ms          |
| Same LAN (same data center)            | 0.5–1ms         |
| Same AWS region, different AZ          | 1–2ms           |
| Different AWS regions (same continent) | 20–40ms         |
| Cross-continental WAN (US to Europe)   | 80–120ms        |
| Cross-oceanic WAN (US to Asia)         | 150–250ms       |

A single LAN database call is ~1ms. A WAN database call to another region is ~100ms. If your app makes 20 DB calls per request and you accidentally put that DB in a different region — your app went from 20ms to 2000ms (2 seconds) just from that one architecture mistake.

---

### Impact on Reliability

LAN failure and WAN failure have very different blast radii:

- **LAN failure** — affects only the devices on that network. Your office floor goes offline. Other floors/buildings unaffected.
- **WAN failure** — affects entire regions or countries. The 2021 Fastly CDN outage took down large parts of the internet (Reddit, GitHub, Twitch, NY Times) simultaneously because they all relied on the same WAN-level CDN paths.
- **Internet Exchange failure** — affects multiple ISPs and their customers simultaneously. One misconfigured BGP announcement at a major IXP can reroute global traffic through wrong paths.

Architects build fault tolerance at each layer:

- LAN redundancy: dual-attached servers, multiple switches, bonded network interfaces
- WAN redundancy: multiple ISP connections (multi-homing), SD-WAN for automatic failover
- Internet redundancy: CDN + multi-region deployment + BGP Anycast routing

---

### What Breaks in Production If Misunderstood

| Misunderstanding                            | Production Consequence                                         |
| ------------------------------------------- | -------------------------------------------------------------- |
| Treating WAN calls like LAN calls           | Cascading latency failures in microservices                    |
| Single ISP connection                       | Office/data center goes offline when ISP has outage            |
| No LAN redundancy                           | Single switch failure takes down entire floor                  |
| Routing sensitive data over public internet | Compliance violations, eavesdropping risk                      |
| Not understanding NAT                       | Debugging why "server is running but unreachable from outside" |
| Confusing private and public subnets on AWS | Database accidentally exposed to internet                      |

---

## SECTION 7 — AWS & Cloud Mapping

### AWS Maps Directly to LAN / WAN / Internet Concepts

```
Physical World          →    AWS Cloud Equivalent
──────────────────────────────────────────────────
LAN                     →    VPC (Virtual Private Cloud)
LAN Subnet              →    VPC Subnet
WAN between offices     →    VPC Peering / Transit Gateway
Private leased WAN      →    AWS Direct Connect
ISP-managed WAN         →    Internet via Internet Gateway
Internet                →    Public internet via Internet Gateway
Home router NAT         →    NAT Gateway (for private subnets)
Corporate firewall      →    Security Groups + NACLs
Global CDN              →    CloudFront
ISP peering             →    AWS Global Accelerator
```

---

### VPC as Your Private LAN in the Cloud

A VPC (Virtual Private Cloud) is your private LAN in AWS. When you launch EC2 instances, RDS databases, Lambda functions — they communicate inside the VPC over AWS's internal high-speed network. This is LAN-equivalent: low latency, no internet exposure, no transit costs for internal traffic.

**Public Subnet = LAN connected to the internet** (has a route through Internet Gateway)
**Private Subnet = Pure LAN, isolated from internet** (no internet route)

---

### AWS Direct Connect as Enterprise WAN

When enterprises need to connect their on-premises LAN/WAN to AWS, they use **Direct Connect** — a dedicated physical fiber connection from their data center (or a colocation facility) directly into AWS. This avoids the public internet entirely:

```
[Corporate HQ — LAN]
        │
[MPLS WAN — Corporate WAN]
        │
[Direct Connect Location — Cross-connect]
        │
[AWS Direct Connect → VPC Private Subnet]
```

This is architecturally identical to an enterprise WAN connecting two offices — except one "office" is AWS. Transit costs drop, latency stabilizes, and compliance requirements for keeping data off the public internet are met.

---

### AWS Global Accelerator — Optimizing WAN Paths

The public internet uses BGP routing, which is optimized for reliability, not performance. Traffic between two points can take suboptimal paths based on BGP policies that have nothing to do with latency.

**AWS Global Accelerator** fixes this by:

1. Routing users to the nearest AWS edge location using Anycast
2. From there, forwarding traffic over **AWS's private global backbone** (a private WAN) rather than the public internet
3. Only leaving AWS's private network at the destination region

```
Without Global Accelerator:
[User in India] → [Public Internet BGP routing — ~15 hops] → [AWS us-east-1]

With Global Accelerator:
[User in India] → [AWS Mumbai Edge (nearest)] → [AWS Private Backbone] → [AWS us-east-1]
```

Latency reduction: typically 20–60% for cross-continental traffic. This is the cloud equivalent of having your own private WAN — paying to avoid the unpredictable public internet.

---

### When to Use What — AWS Architecture Decision Table

| Scenario                       | LAN (VPC)          | WAN (Direct Connect / Peering) | Internet (IGW / CloudFront) |
| ------------------------------ | ------------------ | ------------------------------ | --------------------------- |
| App server → DB                | Yes (same VPC)     | No                             | Never                       |
| User → Web App                 | No                 | No                             | Yes (via ALB + IGW)         |
| Office → AWS sensitive data    | No                 | Yes (Direct Connect)           | No                          |
| Multi-region replication       | VPC in each region | VPC Peering / TGW              | No                          |
| Static assets to global users  | No                 | No                             | Yes (CloudFront CDN)        |
| Two AWS accounts same workload | No                 | Yes (VPC Peering)              | Never                       |

---

## SECTION 8 — Interview Preparation

### BEGINNER LEVEL

**Q1: What is the difference between LAN and WAN?**

_Answer:_ A LAN (Local Area Network) is a network confined to a small geographic area — a building, floor, or campus — where the organization owns all the infrastructure, and speeds are typically 1–10 Gbps with sub-millisecond latency. A WAN (Wide Area Network) connects multiple geographically separated LANs across cities, countries, or continents. WAN links are either leased from telecom providers or built on owned long-haul fiber. WANs have higher latency (reflects geographic distance) and lower managed throughput per customer compared to LAN. The internet is the largest WAN — a publicly accessible network of all networks.

---

**Q2: What is NAT and why is it necessary?**

_Answer:_ NAT (Network Address Translation) allows multiple devices with private IP addresses to share a single public IP address for internet access. Private IP ranges (10.x.x.x, 172.16-31.x.x, 192.168.x.x) are not routable on the internet — they're reserved for internal use. When a device on a private network sends a request to the internet, the NAT device (typically the router) replaces the private source IP with the public IP, records the mapping (private IP + port → public IP + port), and forwards the packet. When the response returns, it reverses the mapping and delivers to the correct internal device. NAT is why IPv4 addresses haven't run out despite having billions of internet-connected devices — thousands of private devices share one public IP.

---

**Q3: What is an Internet Exchange Point (IXP)?**

_Answer:_ An IXP is a physical infrastructure through which different internet networks (called Autonomous Systems) connect and exchange traffic directly with each other, rather than routing through third-party transit ISPs. IXPs are typically housed in neutral colocation data centers. When an ISP peers with another at an IXP, traffic between their customers takes a direct, low-latency path rather than traversing multiple ISP hops. This reduces latency, reduces transit costs, improves performance, and increases internet resilience. Major IXPs include AMS-IX (Amsterdam), DE-CIX (Frankfurt), and Equinix data centers in Ashburn, Virginia.

---

### INTERMEDIATE LEVEL

**Q4: How does BGP (Border Gateway Protocol) relate to the internet's structure?**

_Answer:_ BGP is the routing protocol of the internet. The internet consists of thousands of independently managed networks called Autonomous Systems (AS) — each ISP, enterprise, cloud provider, or CDN is an AS with a unique AS number. BGP allows Autonomous Systems to announce which IP prefixes they own and can route to, and to exchange this reachability information with neighboring ASes. Routers use BGP to build a map of the internet and make routing decisions. BGP is called a "path vector" protocol — it selects routes based on AS path length and policy attributes, not just latency. BGP's decentralized design makes the internet resilient, but a misconfigured BGP announcement (like advertising someone else's IP space) can cause major outages — as happened with the 2010 China Telecom incident where large amounts of internet traffic were accidentally re-routed through China.

---

**Q5: A company has offices in 5 cities and needs reliable, low-latency connectivity between all of them. What WAN options would you recommend and what are the tradeoffs?**

_Answer:_ Three main options:

**Option 1 — MPLS (Multiprotocol Label Switching):** Traditional enterprise WAN. Leased from telecom providers. Provides guaranteed bandwidth, low latency, QoS (can prioritize voice/video over bulk data), private (data never on public internet). Expensive and inflexible — months to provision new circuits.

**Option 2 — VPN over Internet:** Site-to-Site IPSec VPN tunnels between offices over the public internet. Cheap, fast to set up. But performance depends on public internet health — variable latency, no guarantees. Fine for non-latency-sensitive traffic.

**Option 3 — SD-WAN (Software Defined WAN):** Modern hybrid approach. Uses multiple links simultaneously (MPLS, broadband, LTE) and uses software to intelligently route traffic. Voice/video gets MPLS; bulk transfers get cheaper broadband. Automatic failover between links. Lower cost than pure MPLS with better flexibility. This is what most enterprises are migrating to today.

**Recommendation for the scenario:** Start with SD-WAN using dual links (broadband + MPLS) per office for cost-performance balance. As AWS adoption grows, augment with Direct Connect for cloud connectivity.

---

**Q6: What is the "last mile problem" and how does it affect user experience?**

_Answer:_ The "last mile" refers to the final leg of the network that connects an ISP's infrastructure to the end user's home or business. Despite backbone networks being extremely fast (100 Gbps fiber), the connection from the ISP's local Central Office to homes is typically much slower — historically copper DSL, cable coax, or early fiber with lower speeds at the customer endpoint. The last mile is the bottleneck for most consumer internet experiences. Even if a server responds in 5ms and all backbone routing takes 20ms, a congested or slow last-mile DSL link can add 50–200ms. Architects account for this by: placing content close to users with CDNs (so even if last-mile latency is high, the content source is nearby), using adaptive bitrate streaming (Netflix, YouTube) to dynamically reduce quality when bandwidth is low, and building applications that are resilient to high-latency connections (pagination, lazy loading, offline capabilities).

---

### ADVANCED SYSTEM DESIGN LEVEL

**Q7: Design a globally distributed SaaS application that must store data in compliance with regional data residency laws (EU data must stay in EU, India data must stay in India), while still providing a single global portal for users to log in.**

_Ideal Thinking Approach:_

This is a **data gravity + data sovereignty** problem that maps directly to LAN/WAN/Internet concepts.

**Core insight:** The application plane (what users see) can be global. The data plane (where data lives) must be regional.

**Architecture:**

1. **Global entry point:** Route 53 with Geolocation routing. EU users → eu-west-1. India users → ap-south-1. This ensures users interact with the nearest region's application servers.

2. **Regional stacks:** Deploy a complete application stack in each compliant region — its own VPC, application servers, database. EU stack in eu-west-1 or eu-central-1 (Frankfurt, within EU GDPR jurisdiction). India stack in ap-south-1 (Mumbai, compliant with India's PDPB).

3. **Global authentication layer:** User identity (login/auth) can be global and stateless using JWT tokens. AWS Cognito with a globally replicated user pool — auth tokens don't contain regulated personal data, so cross-region replication is safe.

4. **Global portal:** A static landing page served from CloudFront globally. After authentication, the portal redirects the user to their region-specific application endpoint.

5. **No cross-region data flow:** EU customer's data never leaves eu-west-1. India customer's data never leaves ap-south-1. Applications communicate with their regional database only. WAN links between regions are used only for control plane traffic (health checks, deployment coordination) — not customer data.

6. **Data residency verification:** Enable AWS Config rules to detect if any data store (S3, RDS, DynamoDB) in the wrong region holds tagged "EU-personal" or "India-personal" data.

**The network layer's role:** Regional VPCs act as LAN isolation per jurisdiction. Internet entry points (Route 53 + CloudFront) provide the global facade. No data ever traverses WAN links across jurisdictions.

---

**Q8: Your microservices architecture response time degraded from 120ms to 800ms after moving the caching layer to a different AWS region for "cost optimization." Diagnose and fix.**

_Ideal Thinking Approach:_

This is a classic **LAN-to-WAN migration mistake.**

**Diagnosis:**

- Before: Application server → Cache → both in same region (same VPC, same AZ ideally). Cache call = ~1ms. 100 cache calls = 100ms.
- After: Application server in us-east-1. Cache in us-west-2. Cross-region latency = ~65ms per call. 100 cache calls = 6,500ms. Even with 10 cache calls, that's 650ms of added latency.

**Why someone thought it was a good idea:** Cache instances in us-west-2 "have spare capacity" and are "cheaper to run." True for cost, catastrophically wrong for performance. They operated on LAN assumptions in a WAN topology.

**Fix options (in order of preference):**

1. **Move the cache back to the same region as the application.** Cost of cross-region latency in revenue and user experience always exceeds the saving on instance costs.

2. **If multi-region is required:** Deploy a cache cluster in EACH region where applications run. Accept that caches are regional, not global. Use cache invalidation patterns (write-through from source of truth) to keep caches in sync asynchronously — not synchronously.

3. **Reduce the number of cache calls:** If latency is unavoidable, batch read/write operations to minimize round trips.

4. **Switch to an in-process cache:** If the data is truly global and static (like configuration), use an in-memory cache inside the application process — zero network cost.

**The principle:** Every hop from LAN to WAN adds a latency floor that cannot be optimized away. Always co-locate compute with its data.

---

## File Summary

This file covered LAN vs WAN vs Internet through the lens of real systems and architectural thinking:

- Netflix's strategy to eliminate WAN latency by embedding CDN inside ISPs
- How LAN/WAN boundaries drive scalability, latency, and reliability in production
- The complete AWS mapping: VPC as LAN, Direct Connect as WAN, IGW as Internet
- When to use Global Accelerator to replace public internet transit with private WAN
- 8 interview questions from beginner to advanced system design level

**Continue to File 03** for AWS Certification Focus, Comparison Tables, Quick Revision, and the Architect Thinking Exercise.
