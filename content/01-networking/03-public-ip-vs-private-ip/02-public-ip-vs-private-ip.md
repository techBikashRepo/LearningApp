# Public IP vs Private IP — Part 2 of 3

### Topic: Real World Systems, System Design Impact, AWS Mapping & Interview Prep

**Series:** Networking Fundamentals → System Design → AWS Solutions Architect
**Audience:** 14-Year Experienced Full-Stack Developer → Becoming an Architect
**Sections Covered:** 5, 6, 7, 8

---

## SECTION 5 — Real World Examples

### Real-Life Analogy 1 — Hotel Room Numbers vs Hotel's Street Address

Imagine a large hotel. The hotel has one street address — "123 Main Street, New York." That's the public address the whole world knows. Any taxi driver, delivery service, or visitor can find the hotel using that address.

Inside the hotel, every room has a number — Room 101, 205, 312. These room numbers means nothing outside the hotel. You can't tell a taxi "take me to Room 205" — you need the hotel's street address first.

When a guest in Room 101 orders pizza, the delivery arrives at "123 Main Street." The hotel's front desk (the NAT router) knows Room 101 ordered it and delivers it to the right room.

This is exactly Public IP (hotel address) vs Private IP (room number) and NAT (front desk routing).

---

### Real-Life Analogy 2 — Phone Extension Numbers

A large corporation has one main phone number that the public knows, say (800) 555-0100. Inside the company, employees have extension numbers — ext. 1001, 1002, 2034. Customers call the main number; the switchboard routes the call to the right extension.

From outside, you can only reach the company through the main number. You can't directly dial an extension. The main number is the Public IP. Extensions are Private IPs. The PBX switchboard is the NAT router.

---

### Real Software Example — How Uber Uses Public and Private IPs

Uber's architecture involves millions of driver and rider apps communicating with Uber's backend. Here's how IP addressing plays a critical role:

**Driver/Rider apps (private IPs behind mobile carrier NAT):**
Every phone on a mobile network has a private IP assigned by the carrier (in the carrier's huge internal network — typically 100.64.0.0/10, a special "shared address space" for carrier-grade NAT). The carrier's NAT translates millions of private addresses to a smaller pool of public IPs.

**The problem this creates:**
Uber's server cannot initiate a connection to a driver's phone — the phone's private IP is not reachable from the internet. The phone must always connect out first (maintaining a persistent connection), so Uber's servers can push updates back through the established connection.

This is why all mobile apps maintain a persistent long-lived connection (WebSocket or long polling) to their servers. Without it, the server has no way to send push updates to a private IP device behind carrier NAT.

**Uber's Servers (Public + Private IPs):**

- Load balancers and API gateways have **public IPs** — they accept internet connections
- Internal microservices (dispatch engine, pricing engine, map service) have **private IPs only** — they only communicate within Uber's private network
- Databases and data stores have **private IPs only** — completely isolated from internet connectivity

**The architecture insight:**
Uber's private services can have duplicate IP ranges from other networks — it doesn't matter because they never talk to the outside world. The only things with public IPs are the minimum necessary surfaces: load balancers and API gateways. This minimizes the attack surface.

---

## SECTION 6 — System Design Importance

### Impact on Security Architecture

The single most important security benefit of private IPs is **attack surface reduction**.

Every publicly accessible IP is a potential attack target. Port scanners, vulnerability scanners, and brute-force bots continuously scan all known public IP ranges. The moment a device has a public IP, it is under constant probing.

**The principle:** Give a public IP ONLY to what absolutely needs to be reached from the internet.

In a well-designed 3-tier architecture:

- Load Balancer: Public IP required (it accepts user connections)
- Application Servers: Private IP only (they receive connections from the load balancer — no direct internet access needed)
- Database: Private IP only (it receives connections from app servers only)

By removing public IPs from the application and database tiers, you eliminate direct internet exposure for those systems entirely. Even if your web application has a vulnerability that could provide a shell, the attacker cannot exfiltrate data by connecting out from the database — because the database has no internet route.

---

### Impact on Scalability

**Private IPs enable internal network scalability without exhausting public IP space.**

When a service needs 500 application servers, each server has a private IP. You need only ONE public IP (on the load balancer) to serve all 500 servers. Without NAT/private IPs, you'd need 500 public IPs — impossible as IPv4 exhaustion is real.

**Microservices:**
In a microservices architecture with 50 services, each service runs in containers/VMs with private IPs. They communicate internally via private IPs with sub-millisecond latency. External consumers reach only through API gateway public endpoints. Without private IP addressing, you'd need 50 public IPs and expose 50 attack surfaces.

---

### Impact on Cost

In AWS:

- **Private IP network traffic** within the same AZ is free
- **Elastic IPs** (public IPs) cost money when not in use (to discourage hoarding)
- **NAT Gateway** charges per GB of data processed (private subnets accessing internet through NAT Gateway)
- **Data transfer out** to the internet is charged per GB; internal (private IP to private IP, same region) data transfer is much cheaper

Architects design systems to maximize private IP communication and minimize internet egress:

- Put services that talk frequently in the same AZ (same private LAN) — free internal traffic
- Use VPC endpoints so private EC2 doesn't need NAT Gateway to reach S3 — saves NAT Gateway data charges
- Cache aggressively to reduce outbound internet traffic — saves egress fees

---

### What Breaks in Production If Misunderstood

| Misunderstanding                    | Production Consequence                                                                   |
| ----------------------------------- | ---------------------------------------------------------------------------------------- |
| Database given a public IP          | Database exposed to internet — catastrophic security breach risk                         |
| Hardcoding private IPs              | Service breaks when instance is replaced and new private IP is assigned                  |
| Not understanding NAT timeouts      | Long-lived TCP connections drop silently through NAT (keepalive packets required)        |
| App server given public IP directly | Bypassing load balancer, exposing server directly — bypasses DDoS protection             |
| Wrong subnet CIDR planning          | Running out of private IP space for new instances; overlapping CIDRs prevent VPC peering |

---

## SECTION 7 — AWS & Cloud Mapping

### Public and Private IPs in AWS EC2

When you launch an EC2 instance, it gets:

1. **Private IP** — always. Assigned from the subnet's CIDR range. Persists across stop/start.
2. **Public IP** — optional. Auto-assigned if enabled on the subnet or explicitly requested. This IP is **dynamic** — it changes every time the instance stops and starts.
3. **Elastic IP (EIP)** — optional, you allocate explicitly. This is a **static public IP** that you own until you release it. Persists across stop/start.

```
EC2 Instance:
  Private IP:  10.0.1.45    (always present, stable)
  Public IP:   54.72.18.9   (changes on stop/start — avoid for DNS)
  Elastic IP:  34.220.14.5  (static, yours until released)
```

**Rule of thumb for architects:**

- Use private IP for internal service-to-service communication always
- Use Elastic IP (not dynamic public IP) when a server must have a stable internet-facing address
- Prefer DNS names (not IPs) everywhere — DNS can be updated, IPs cannot be swapped in existing connections

---

### VPC CIDR Planning — Critical for Production

The VPC CIDR you choose at creation **cannot be changed** (you can add secondary CIDRs, but shrinking or replacing is not possible). This is a critical planning decision.

**AWS VPC CIDR Best Practices:**

Use **10.0.0.0/16** as your VPC CIDR (65,536 addresses). Then divide into subnets:

```
VPC: 10.0.0.0/16
│
├── Public Subnet AZ-a:   10.0.0.0/24   (256 addresses, 251 usable)
├── Public Subnet AZ-b:   10.0.1.0/24
├── Private Subnet AZ-a:  10.0.10.0/24
├── Private Subnet AZ-b:  10.0.11.0/24
├── DB Subnet AZ-a:       10.0.20.0/24
├── DB Subnet AZ-b:       10.0.21.0/24
└── Spare:                10.0.100.0/24  (for future use)
```

**Why this matters:**

- If you start with 10.0.0.0/24 for your VPC (only 256 addresses), you'll run out quickly as you scale
- If two VPCs have overlapping CIDRs (both 10.0.0.0/16), you CANNOT peer them — this is a hard AWS restriction
- Plan CIDR ranges across all VPCs and AWS accounts upfront for large organizations

**AWS reserves 5 addresses per subnet:**
In a /24 subnet (256 total):

- x.x.x.0 — Network address
- x.x.x.1 — VPC router
- x.x.x.2 — DNS server
- x.x.x.3 — AWS reserved for future
- x.x.x.255 — Broadcast address

251 usable addresses per /24 subnet.

---

### EC2 Instance Metadata Service (IMDS) — 169.254.169.254

This is a critical AWS-specific concept. The Instance Metadata Service runs at the link-local address **169.254.169.254** — accessible only from within the EC2 instance itself.

It provides:

- Instance ID, instance type, AMI ID
- IAM role credentials (temporary AWS credentials)
- User data (bootstrap scripts)
- Network interface information

```bash
# From inside an EC2 instance:
curl http://169.254.169.254/latest/meta-data/instance-id
curl http://169.254.169.254/latest/meta-data/iam/security-credentials/MyRole
```

**Why the 169.254.x.x address?** It's a link-local address — only accessible from the local machine, not routed externally. It's a secure channel between the instance and AWS's hypervisor.

**Security concern (SSRF):** If your application is vulnerable to SSRF (Server-Side Request Forgery), an attacker can make your server fetch http://169.254.169.254/ and return IAM credentials. This is how the 2019 Capital One breach happened. **IMDSv2** (instance metadata service version 2) requires a session token (a PUT request first), making SSRF attacks significantly harder.

---

### Elastic IP (EIP) — Static Public IP for Production

Use cases for Elastic IP:

1. You have a DNS record pointing to a server — you need the IP to never change even when the server is replaced
2. A partner/customer has your IP whitelisted on their firewall — IP change would break connectivity
3. A NAT instance needs a stable public IP

**EIP Behavior:**

- Allocated to your AWS account — you own it
- Not charged when associated with a running instance
- Charged ~$0.005/hour when not associated, or when associated with a stopped instance
- Can be remapped to a different instance — useful for zero-downtime failover (remap EIP from failed instance to replacement instance)

---

## SECTION 8 — Interview Preparation

### BEGINNER LEVEL

**Q1: What are the RFC 1918 private IP ranges?**

_Answer:_ RFC 1918 defines three ranges of IP addresses reserved for private network use, not routable on the public internet:

- 10.0.0.0/8 — Class A range, 16.7 million addresses, used for large networks like enterprise environments and AWS VPCs
- 172.16.0.0/12 — Class B range (172.16.0.0 to 172.31.255.255), about 1 million addresses, often used by Docker and some enterprise networks
- 192.168.0.0/16 — Class C range, 65,536 addresses, the most common for home and small office networks

These addresses are free to use internally without registration. Multiple organizations worldwide can use the same private IPs — they're only meaningful within their own network.

---

**Q2: What happens if two devices on the same network have the same IP address?**

_Answer:_ This is an IP conflict. Both devices will experience intermittent connectivity issues. When another device sends data to that IP, the network may deliver it to either device unpredictably based on which one responded to ARP (Address Resolution Protocol) most recently. Modern operating systems detect IP conflicts and warn users. The second device to claim the IP typically loses connectivity. In a DHCP-managed network, the DHCP server should prevent this — conflicts usually occur when someone manually assigns a static IP that's already in the DHCP pool, or when DHCP scope management is poor.

---

**Q3: What is the difference between a static IP and a dynamic IP?**

_Answer:_ A **static IP** is manually assigned and never changes — a server that needs to always be reachable at the same address needs a static IP. A **dynamic IP** is assigned automatically by DHCP and can change every time the device connects. For servers, static IPs are preferred. For client devices (phones, laptops), dynamic IPs are simpler to manage because DHCP handles assignment automatically. In AWS, an EC2 instance's **private IP is static for its lifetime** (doesn't change on restart). The **public IP is dynamic** (changes on stop/start). An **Elastic IP is a static public IP** you allocate permanently.

---

### INTERMEDIATE LEVEL

**Q4: Why can't two VPCs with overlapping CIDR ranges be peered in AWS?**

_Answer:_ VPC peering enables traffic routing between two VPCs by adding routes in each VPC's route table pointing to the other VPC. When both VPCs have the same or overlapping CIDR ranges (e.g., both are 10.0.0.0/16), there is an ambiguity: if a packet is destined for 10.0.1.45, which VPC does it belong to? The router can't determine this — the destination exists in both networks. AWS prevents you from creating peering between overlapping CIDRs to avoid this routing ambiguity. This is why CIDR planning across all VPCs in an organization is critical from day one. Use a CIDR allocation strategy: account A gets 10.0.0.0/16, account B gets 10.1.0.0/16, account C gets 10.2.0.0/16, etc.

---

**Q5: What is CGNAT (Carrier-Grade NAT) and how does it affect application design?**

_Answer:_ CGNAT (Carrier-Grade NAT, also known as Large-Scale NAT) is NAT performed by mobile carriers and ISPs, not just home routers. Because of IPv4 exhaustion, carriers assign private IPs (specifically the 100.64.0.0/10 shared address space, per RFC 6598) to their customers' devices, then NAT those to a small pool of public IPs. Many customers share one public IP. This has several implications for application design:

1. You cannot use a public IP to reliably identify a user — many users may share the same public IP
2. Rate limiting by IP is ineffective — blocking one IP blocks all users behind that carrier NAT
3. Long-lived TCP connections may be dropped by carrier NAT tables (carriers use aggressive NAT timeouts for connection table management) — applications need TCP keepalive packets
4. Peer-to-peer connectivity is nearly impossible (gaming, video calls) — both parties are behind NAT, neither can initiate to the other. Applications use STUN/TURN servers as intermediaries.

---

**Q6: How would you design IP addressing for a company with 20 AWS accounts, multiple regions, and on-premises data centers that all need to communicate?**

_Answer:_ This requires an organization-wide IP addressing plan (sometimes called an "IP Address Management" strategy — IPAM):

1. **Assign unique CIDR blocks per account:** No two accounts can have overlapping ranges if they ever need to peer. Example: account-prod-001 gets 10.0.0.0/16, account-prod-002 gets 10.1.0.0/16, etc.

2. **Reserve blocks per region:** Within account-prod-001, us-east-1 uses 10.0.0.0/18, eu-west-1 uses 10.0.64.0/18, ap-south-1 uses 10.0.128.0/18.

3. **Separate on-premises from cloud:** Give on-premises networks a completely different RFC 1918 block (e.g., on-premises uses 172.16.0.0/12, cloud uses 10.0.0.0/8). This prevents conflicts when Direct Connect connects them.

4. **Use AWS VPC IP Address Manager (IPAM):** AWS's managed IPAM service tracks all allocated CIDRs across accounts and regions, raises alerts for conflicts, and automates allocation.

5. **Plan for growth:** A /16 per account gives 65,536 addresses. For large accounts, consider /15 or /14 to allow multiple VPCs.

The failure mode of poor IP planning: you discover two critical VPCs have overlapping CIDRs only when you try to peer them. The only fix is re-IP all resources in one VPC — a massive, risky operation.

---

### ADVANCED SYSTEM DESIGN LEVEL

**Q7: Design the network address architecture for a zero-trust security platform where every service must prove identity, regardless of IP address, and no lateral movement is possible even if one service is compromised.**

_Ideal Thinking Approach:_

The key insight: **IP addresses are a weak identity mechanism**. In traditional architectures, "internal IP = trusted" is the assumption. Zero-trust rejects this entirely.

**Why IP-based trust is dangerous:**
If attacker compromises Service A (private IP 10.0.1.10), in a traditional network, that attacker can now make requests to Service B with a trusted source IP. Firewalls and security groups allow it because the IP is "internal."

**Zero-trust network design:**

1. **mTLS everywhere (Mutual TLS):** Every service call requires both sides to present a certificate. The service's identity is its certificate, not its IP. Even if an attacker has network access, they cannot forge a valid certificate. Use a service mesh (Istio, AWS App Mesh, Envoy) to enforce mTLS automatically at the sidecar proxy layer.

2. **Micro-segmentation:** Each service in its own security group. Security group rules allow communication only between specific services — not "all internal traffic." Service A can call Service B, but Service A cannot call the database directly.

3. **Service identity, not IP identity:** Use IAM roles (AWS), SPIFFE/SPIRE (standard), or Kubernetes service accounts for identity. Policies are written as "Service A is allowed to call Service B" — enforced by the service mesh and IAM, not IP rules.

4. **No long-lived credentials:** All credentials are short-lived (rotated every 15 minutes, like AWS STS tokens). IP addresses are ignored in policy.

5. **Network logging:** All network flows are logged (VPC Flow Logs → SIEM). Anomalous patterns (service A suddenly talking to service D it never talked to before) trigger alerts — regardless of IPs involved.

**The shift:** From "this IP is trusted" to "this certificate + signature + identity is trusted." IP addresses become irrelevant for security decisions.

---

**Q8: How does NAT affect peer-to-peer applications, and what are the standard solutions?**

_Ideal Thinking Approach:_

P2P challenge: Both peers (Player A and Player B in an online game) are behind home NAT. Neither has a public IP. Neither can receive unsolicited inbound connections.

**Techniques to establish P2P through NAT:**

1. **STUN (Session Traversal Utilities for NAT):** A STUN server (runs publicly) tells each client their external public IP and port. Both clients learn each other's external addresses. They simultaneously send packets to each other — the simultaneous sends punch a "hole" in each NAT table, allowing the return packets through. Called **UDP hole punching**.

2. **TURN (Traversal Using Relays around NAT):** When hole punching fails (symmetric NAT), a TURN server relays traffic between peers. Both connect outbound to the TURN server; it forwards to the other peer. Higher latency but guaranteed to work. Used as fallback.

3. **ICE (Interactive Connectivity Establishment):** Used in WebRTC. Tries all methods in order: direct connection → STUN hole punch → TURN relay. Takes the first one that works.

**Applications:** WebRTC (browser video calls), all multiplayer games (PlayStation Network, Xbox Live, Steam), BitTorrent, VoIP (STUN is how SIP phones work behind NAT).

**In AWS:** When designing a service that peers with on-premises systems that are behind NAT, the AWS side typically has a public EIP. The on-premises side initiates outbound to the EIP. AWS side receives the connection and the NAT state table on-premises allows return traffic.

---

## File Summary

This file covered real-world and architectural implications of Public vs Private IPs:

- Hotel/phone extension analogies making NAT intuitive
- Uber's architecture: why mobile apps need persistent connections due to carrier NAT
- Security architecture: minimizing public IP attack surface
- AWS EC2 public/private/EIP behavior and VPC CIDR planning
- IMDS (169.254.169.254) and the SSRF security risk it creates
- 8 interview questions from beginner to advanced

**Continue to File 03** for AWS Certification Focus, Comparison Tables, Quick Revision, and the Architect Thinking Exercise.
