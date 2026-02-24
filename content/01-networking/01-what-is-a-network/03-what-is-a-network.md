# What is a Network — Part 3 of 3

### Topic: AWS Certification Focus, Comparison Tables, Quick Revision & Architect Exercise

**Series:** Networking Fundamentals → System Design → AWS Solutions Architect
**Audience:** 14-Year Experienced Full-Stack Developer → Becoming an Architect
**Sections Covered:** 9, 10, 11, 12

---

## SECTION 9 — Certification Focus: AWS Solutions Architect Associate (SAA-C03)

This section focuses on what the AWS SAA exam specifically tests about networking concepts, including common traps and confusing points. These are not theoretical — they are patterns that appear repeatedly in real exam questions.

---

### Exam-Critical Fact 1 — VPC is the Foundation of Everything

Every AWS resource — EC2 instances, RDS databases, Lambda functions, ECS containers — lives inside a VPC. The exam assumes you know how to design a VPC from scratch. You must know:

- A VPC spans all Availability Zones in a region
- A Subnet is scoped to ONE Availability Zone only
- To deploy across multiple AZs for fault tolerance, you need multiple subnets in different AZs
- You can have multiple VPCs per region (soft limit: 5 default, can request more)
- VPCs are region-specific — a VPC in us-east-1 is completely separate from one in ap-southeast-1

---

### Exam-Critical Fact 2 — Internet Gateway vs NAT Gateway

This is a heavily tested distinction:

**Internet Gateway (IGW)**

- Attached to the VPC (not to a subnet)
- Required for any resource to have direct internet access
- Both inbound AND outbound traffic — resources must also have a public IP (Elastic IP or auto-assigned public IP)
- Resources in **public subnets** use the IGW

**NAT Gateway**

- Deployed in a PUBLIC subnet
- Allows resources in **private subnets** to initiate outbound internet connections (example: EC2 downloading software updates)
- Does NOT allow inbound connections initiated from the internet — private resources stay private
- Managed service — AWS handles availability and scaling
- You pay per hour AND per GB of data processed

**Common Trap:** Students confuse "a private subnet with a NAT Gateway" with "a public subnet." The private subnet's resources don't have public IPs. The NAT Gateway sits in the public subnet and translates private IPs to its own public IP for outbound traffic.

```
Private Subnet (EC2 wants to download a patch)
    │
    └─ Route Table: 0.0.0.0/0 → NAT Gateway (in public subnet)
                                      │
                               NAT Gateway (has public IP)
                                      │
                               Internet Gateway
                                      │
                                  Internet
```

---

### Exam-Critical Fact 3 — Security Groups vs NACLs

This is one of the most commonly confused topics, and the exam loves to test it.

| Property         | Security Group                           | NACL                                              |
| ---------------- | ---------------------------------------- | ------------------------------------------------- |
| Level            | Instance level (attached to NIC)         | Subnet level                                      |
| State            | Stateful                                 | Stateless                                         |
| Rules            | Allow rules only                         | Allow AND Deny rules                              |
| Rule evaluation  | All rules evaluated together             | Rules evaluated in number order, first match wins |
| Default behavior | All inbound denied, all outbound allowed | All traffic allowed                               |
| Return traffic   | Automatically allowed (stateful)         | Must explicitly allow return traffic              |

**The Statefulness Trap:** With Security Groups, if you allow inbound HTTP on port 80, the response traffic automatically flows back out — you don't need an outbound rule for port 80 responses. With NACLs, you must explicitly allow the **ephemeral port range** (1024–65535) in the outbound direction so that response packets can leave the subnet.

**The Deny Trap:** Security Groups cannot create deny rules. You cannot say "block this specific IP." If you need to block traffic from specific IPs or CIDR ranges, you must use a NACL (or AWS WAF for HTTP traffic).

---

### Exam-Critical Fact 4 — VPC Peering

VPC Peering allows two VPCs to communicate as if they are on the same private network, without routing through the internet.

Important rules:

- **Non-transitive**: If VPC-A is peered with VPC-B, and VPC-B is peered with VPC-C, then VPC-A CANNOT communicate with VPC-C through VPC-B. You need a direct peer between A and C.
- IP address ranges cannot overlap between peered VPCs
- Peering works cross-region and cross-account (with permissions)

**The Transit Gateway Alternative (Exam Favorite):** For connecting many VPCs (imagine 20 VPCs across teams), VPC Peering becomes messy — you need N\*(N-1)/2 peering connections. **Transit Gateway** acts as a central hub: all VPCs connect to the Transit Gateway, which routes traffic between them. One Transit Gateway instead of dozens of peering connections. This is a hub-and-spoke model.

---

### Exam-Critical Fact 5 — Elastic IP vs Public IP

- A **Public IP** assigned to an EC2 instance is dynamic — it changes every time you stop and restart the instance. This breaks DNS records that point to it.
- An **Elastic IP (EIP)** is a static public IP that you allocate and associate to an EC2 instance. It persists through stop/start cycles.
- EIPs are free as long as they are **associated with a running instance**. If you allocate an EIP and don't use it (or attach it to a stopped instance), AWS charges you per hour — to discourage hoarding scarce IPv4 addresses.

---

### Exam-Critical Fact 6 — Route 53 Routing Policies

The exam tests which routing policy fits which scenario:

| Policy                | Use Case                                                                    |
| --------------------- | --------------------------------------------------------------------------- |
| **Simple**            | Single resource, no health checks possible                                  |
| **Weighted**          | Split traffic between versions: 90% production, 10% canary                  |
| **Failover**          | Primary-secondary setup: if primary fails health check, switch to secondary |
| **Latency**           | Route users to the region with lowest latency to them                       |
| **Geolocation**       | Route based on user's geographic location (country/continent)               |
| **Geoproximity**      | Like geolocation but with a bias to expand/shrink regions                   |
| **Multivalue Answer** | Return multiple IPs (basic health-checked round-robin)                      |

**Exam Trap:** Geolocation is NOT the same as latency. If you have strict data residency requirements (EU users must only hit EU servers — GDPR), use Geolocation. If you just want the best performance, use Latency-based routing.

---

### Exam-Critical Fact 7 — CloudFront Behaviours and Origin Types

CloudFront is a CDN but the exam tests its nuances:

- CloudFront can have multiple origins (S3, ALB, EC2, external HTTP)
- **Cache behaviors** control which URL patterns go to which origin. Example: `/static/*` goes to S3, `/api/*` goes to ALB
- **OAI (Origin Access Identity)** and its replacement **OAC (Origin Access Control)** restrict direct S3 access — only CloudFront can fetch from the S3 bucket, not users directly
- CloudFront supports **custom SSL/TLS certificates** via AWS Certificate Manager (ACM) — but the certificate MUST be in `us-east-1` regardless of where your application is deployed. This is a famous exam trap.
- **CloudFront Functions** and **Lambda@Edge** run code at edge locations — use for request/response manipulation at low latency

---

### Exam-Critical Fact 8 — Direct Connect vs VPN

|                 | VPN (Site-to-Site)                    | Direct Connect                                  |
| --------------- | ------------------------------------- | ----------------------------------------------- |
| Connection type | Encrypted tunnel over public internet | Dedicated private fiber                         |
| Latency         | Variable (depends on internet)        | Consistent, low                                 |
| Setup time      | Hours                                 | Weeks to months                                 |
| Cost            | Low                                   | High                                            |
| Bandwidth       | Up to ~1.25 Gbps (IPSec limit)        | 1 Gbps to 100 Gbps                              |
| Use case        | Quick setup, moderate bandwidth       | High throughput, consistent latency, compliance |

**The hybrid scenario exam question:** "Company needs to connect their 50TB on-premises data center to AWS. They need consistent low latency for real-time reporting and cannot route sensitive data through the public internet." → Answer: **AWS Direct Connect**

---

## SECTION 10 — Comparison Table: Commonly Confused Networking Concepts

### Table 1 — Switch vs Router vs Gateway

| Concept       | Works At             | Uses                | Purpose                                    |
| ------------- | -------------------- | ------------------- | ------------------------------------------ |
| Switch        | Layer 2 (Data Link)  | MAC address         | Connect devices in the same LAN            |
| Router        | Layer 3 (Network)    | IP address          | Connect different networks                 |
| Gateway       | Layer 3-7 (Multiple) | IP + Protocol       | Entry/exit point between different systems |
| Load Balancer | Layer 4 or Layer 7   | Port / HTTP headers | Distribute traffic across servers          |

---

### Table 2 — Public IP vs Private IP vs Elastic IP

| Type       | Scope             | Changes?         | Cost                                 | When to Use                          |
| ---------- | ----------------- | ---------------- | ------------------------------------ | ------------------------------------ |
| Private IP | Internal VPC only | No               | Free                                 | Internal service communication       |
| Public IP  | Internet-routable | Yes (on restart) | Free (while instance runs)           | Temporary internet access            |
| Elastic IP | Internet-routable | No (static)      | Free while in use; charged when idle | DNS, NAT instances, stable endpoints |

---

### Table 3 — TCP vs UDP Protocol Comparison

| Property           | TCP                                  | UDP                                  |
| ------------------ | ------------------------------------ | ------------------------------------ |
| Connection         | Connection-oriented (handshake)      | Connectionless                       |
| Delivery guarantee | Yes (ACK + retransmit)               | No                                   |
| Ordering           | Yes (sequence numbers)               | No                                   |
| Speed overhead     | Higher                               | Lower                                |
| Use cases          | HTTP, database, email, file transfer | VoIP, gaming, DNS, video streaming   |
| Failure behavior   | Retransmits → can cause delay spikes | Drops packet → caller decides action |

---

### Table 4 — VPC Peering vs Transit Gateway vs PrivateLink

| Feature       | VPC Peering              | Transit Gateway                | PrivateLink                        |
| ------------- | ------------------------ | ------------------------------ | ---------------------------------- |
| Purpose       | Connect two VPCs         | Connect many VPCs centrally    | Expose a service privately         |
| Transitivity  | Non-transitive           | Transitive (hub-and-spoke)     | N/A                                |
| Scale         | Good for few VPCs        | Good for many VPCs             | Service exposure to many consumers |
| Cost          | Low (just data transfer) | Per attachment + data transfer | Per endpoint hour + data           |
| Cross-account | Yes                      | Yes                            | Yes (primary use case)             |
| Cross-region  | Yes                      | Yes (via inter-region peering) | No (same region)                   |

---

### Table 5 — Security Group vs NACL (Exam Favorite)

| Property        | Security Group                    | Network ACL                               |
| --------------- | --------------------------------- | ----------------------------------------- |
| Attached to     | EC2 instance / ENI                | Subnet                                    |
| Statefulness    | Stateful                          | Stateless                                 |
| Rule types      | Allow only                        | Allow and Deny                            |
| Rule evaluation | All rules together                | Ordered (lowest number first)             |
| Default         | Deny all inbound                  | Allow all                                 |
| Return traffic  | Automatically allowed             | Must be explicitly allowed                |
| Good for        | Fine-grained per-instance control | Broad subnet-level blocking / IP blocking |

---

### Table 6 — OSI Model Layers (Quick Reference)

| Layer | Name         | What it does                 | Examples                     |
| ----- | ------------ | ---------------------------- | ---------------------------- |
| 7     | Application  | User-facing protocols        | HTTP, HTTPS, DNS, SMTP, FTP  |
| 6     | Presentation | Data formatting/encryption   | TLS/SSL, JPEG compression    |
| 5     | Session      | Connection sessions          | Authentication sessions      |
| 4     | Transport    | End-to-end delivery          | TCP, UDP                     |
| 3     | Network      | Logical addressing + routing | IP, ICMP, BGP                |
| 2     | Data Link    | Physical addressing + frames | Ethernet, MAC, Switches      |
| 1     | Physical     | Bits over medium             | Cables, Fiber, Wi-Fi signals |

**Memory Trick:** "**P**lease **D**o **N**ot **T**hrow **S**ausage **P**izza **A**way" (Physical → Data Link → Network → Transport → Session → Presentation → Application)

---

## SECTION 11 — Quick Revision

### 10 Key Points to Remember Always

1. A **network** is two or more connected devices that communicate to share data and resources.

2. **Switches** work within a LAN using MAC addresses. **Routers** connect networks using IP addresses.

3. Data travels in **packets** — not as one blob. Each packet independently routes through the network.

4. **TCP** guarantees delivery and order. **UDP** is fast but unreliable — choose based on whether correctness or speed matters more.

5. **DNS** is the phone book of the internet — it converts human-readable domain names into machine-readable IP addresses. If DNS fails, nothing works.

6. In AWS, a **VPC** is your private isolated network. A **Subnet** is a subdivision of the VPC scoped to one Availability Zone.

7. **Security Groups** are stateful instance-level firewalls with Allow rules only. **NACLs** are stateless subnet-level firewalls that support Deny rules.

8. **NAT Gateway** in a public subnet enables private subnet resources to access the internet outbound — without ever being reachable from the internet inbound.

9. **Route 53 routing policies** control how user traffic is distributed: Latency (performance), Failover (disaster recovery), Geolocation (compliance), Weighted (canary deploys).

10. **Network design decisions** — number of round trips, geographic distribution of servers, choice of TCP vs UDP, caching strategy — are the difference between a 50ms response and a 2-second response at scale.

---

### 30-Second Interview Explanation

_"A computer network is a system where devices are connected and can communicate with each other using agreed-upon rules called protocols. Data doesn't travel as one block — it's broken into packets that independently route through switches and routers, then get reassembled. TCP gives you guaranteed delivery for correctness-critical traffic; UDP gives you speed for latency-critical traffic like video calls. In AWS, your network is a VPC — an isolated cloud network divided into subnets, protected by Security Groups and NACLs, and exposed to the internet through an Internet Gateway. The key insight for system design is that every network call carries a latency cost and a failure risk — good architects minimize remote calls, choose the right protocols, distribute data geographically, and design for network failure from day one."_

---

### Memory Tricks

**For OSI Layers (bottom to top):** "**P**lease **D**o **N**ot **T**hrow **S**ausage **P**izza **A**way"
Physical → Data Link → Network → Transport → Session → Presentation → Application

**For Security Group vs NACL:**

- Security Group = **S**tateful = think of **S**ession that remembers
- NACL = **N**ACL = **N**ever remembers (stateless)

**For TCP vs UDP:**

- **T**CP = **T**rustworthy (guaranteed delivery, like registered mail)
- **U**DP = **U**nreliable but **U**ltrafast (like shouting in a crowd)

**For VPC CIDR blocks:**

- /16 = 65,536 addresses (entire VPC — large enough to never run out)
- /24 = 256 addresses (typical subnet — AWS reserves 5, leaving 251 usable)
- /32 = 1 specific IP address (used in security group rules to allow one IP)

---

## SECTION 12 — Architect Thinking Exercise

### The Scenario

Read this carefully and spend 2-3 minutes thinking before reading the solution below.

---

**You are the Lead Solutions Architect at a fintech startup. The company processes credit card transactions.**

**Current setup:**

- Single EC2 web server with a public IP address
- MySQL database on the same EC2 server
- Average 1,000 transactions/day
- No backup, no redundancy

**New business requirement:**

- The company just partnered with a major retailer. Traffic is expected to hit **500,000 transactions/day** within 3 months.
- The payment processor (third-party API) mandates that all communication must happen **over private network connections only** — no public internet for card data transmission.
- PCI-DSS compliance requires that card data at rest is isolated from the web tier.
- Zero-downtime requirement during peak hours.

**Questions to think about:**

1. What's the first thing that will break in the current architecture when traffic increases 500x?
2. How do you meet the "private network only" requirement for the payment processor communication?
3. How do you isolate card data from the web tier using network architecture?
4. How do you achieve zero-downtime deployments?

---

### Solution and Reasoning

**Problem 1 — What breaks first at 500x traffic?**

Everything breaks simultaneously, but in this order:

- The **database and web server sharing the same EC2** means they compete for CPU, memory, and I/O. At 500x load, the server collapses before you can diagnose which component failed.
- The **single server = single point of failure**. One hardware issue and you're down.
- A **public IP on the server** means every time you redeploy, the IP changes — clients may lose connectivity.

**Solution:**

- Separate web server and database onto different EC2/RDS instances immediately.
- Move to **RDS Multi-AZ** for the database — automatic failover to a standby in a different AZ in under 2 minutes.
- Put an **Application Load Balancer** in front of multiple web servers. The ALB IP stays constant while server IPs change behind it.

---

**Problem 2 — Private network for payment processor communication**

The payment processor's requirement means you cannot send card data over the public internet, even encrypted. There are two options:

**Option A — AWS VPN (Site-to-Site VPN):** Establish an IPSec VPN tunnel from your VPC to the payment processor's network. Traffic stays encrypted inside a dedicated tunnel rather than traveling as public internet packets. Setup takes hours to days.

**Option B — AWS Direct Connect + Virtual Private Gateway:** If the payment processor also has an AWS presence (many do), you can peer VPCs directly. If they're on-premises, you establish a Direct Connect connection to their facility. This provides dedicated bandwidth with consistent latency — ideal for high-volume transaction traffic.

**For a fintech startup at this stage:** Start with Site-to-Site VPN (fast to set up, lower cost), plan migration to Direct Connect as transaction volume justifies the cost.

---

**Problem 3 — Isolate card data using network architecture**

This is a classic **network segmentation** pattern, required by PCI-DSS:

```
VPC: 10.0.0.0/16
│
├── PUBLIC SUBNET (10.0.1.0/24)
│      └── Application Load Balancer
│      └── NAT Gateway
│
├── PRIVATE SUBNET — WEB TIER (10.0.2.0/24)
│      └── EC2 Web Servers (Auto Scaling Group)
│      Security Group: Allow inbound from ALB SG only
│
├── PRIVATE SUBNET — APP TIER (10.0.3.0/24)
│      └── Payment Processing Service
│      Security Group: Allow inbound from Web Tier SG only
│      └── VPN connection to payment processor
│
└── PRIVATE SUBNET — DATA TIER (10.0.4.0/24)
       └── RDS (Cardholder Data Environment)
       Security Group: Allow inbound from App Tier SG only
       └── Encryption at rest: AES-256 (RDS encryption on)
```

The key principle: each tier can ONLY communicate with the adjacent tier. Web servers cannot directly reach the database. This is enforced at the network level through Security Group rules — not at the application level (which can have bugs). Even if the web server is compromised, an attacker cannot query the database directly.

---

**Problem 4 — Zero-downtime deployments**

Network architecture enables this through an **ALB + Auto Scaling + Blue-Green deployment** pattern:

1. Create a new "green" fleet of EC2 instances with the new application version.
2. Register the green fleet with the ALB target group.
3. Use **weighted target groups** in the ALB: send 10% of traffic to green, 90% to blue.
4. Monitor error rates and latency. If healthy, shift to 50/50, then 100% green.
5. Deregister and terminate the old "blue" fleet.

At no point is the application unavailable. The ALB handles the transition seamlessly. This is impossible without understanding how load balancers and target groups work at the network level.

---

### Architect's Takeaway

Notice that every solution in this exercise was a **network design decision**:

- Separation of tiers using subnet segmentation
- Security enforcement using Security Groups
- Zero downtime through ALB routing
- Private connectivity through VPN/Direct Connect
- High availability through Multi-AZ

This is why networking knowledge is not optional for architects. It is the foundation on which every scalable, secure, and reliable system is built.

---

## Complete Series Summary

| File    | Sections | Core Learning                                                                                |
| ------- | -------- | -------------------------------------------------------------------------------------------- |
| File 01 | 1–4      | What a network is, how it works, architecture diagram, step-by-step request flow             |
| File 02 | 5–8      | Real-world systems, system design impact, AWS networking stack, interview questions          |
| File 03 | 9–12     | AWS SAA certification facts and traps, comparison tables, quick revision, architect exercise |

**Series: Networking Fundamentals**
**Next Topic:** OSI Model — The 7 Layers of the Network Stack

---

_You now have both the intuition and the depth to answer every networking question — in an AWS exam, in a system design interview, and in real production architecture decisions._
