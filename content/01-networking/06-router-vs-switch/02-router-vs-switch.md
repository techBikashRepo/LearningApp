# Router vs Switch — Part 2 of 3

### Topic: Real World Systems, System Design Impact, AWS Mapping & Interview Prep

**Series:** Networking Fundamentals → System Design → AWS Solutions Architect
**Audience:** 14-Year Experienced Full-Stack Developer → Becoming an Architect
**Sections Covered:** 5, 6, 7, 8

---

## SECTION 5 — Real World Examples

### Real-Life Analogy 1 — City Roads and Traffic Lights

Within a single city block, roads connect buildings directly. When you walk from your house to your neighbor's house, you go directly — no signage, no decision-making needed. That's a **switch** — direct delivery within the local zone.

But when you need to drive from New York to Boston, you hit highway systems. Every highway intersection (router) has signs pointing you toward the next decision point. You follow "Boston → I-95 North." At the next junction, another sign. At each junction, a routing decision is made. You never get a direct path — you hop through intermediate nodes. Each node knows which direction to forward you based on your destination.

That highway routing network is the **router** system. The city block is the switch network. They work together — highway delivers you to the city, city roads deliver to the door.

### Real-Life Analogy 2 — Building Intercom vs City Postal System

In an apartment building, the intercom system connects apartments directly: press "302" and apartment 302 rings. No external routing. This is a **switch** — all communication stays inside the building, addressed by apartment number (MAC address).

If you need to send a letter to someone in another building across town, you use the postal system. Your letter has a full address: "123 Main St, Apt 302, Boston, MA 02101." The postal system (router) makes routing decisions: bag goes to Boston sorting center → Boston local office → letter carrier for that ZIP code → building → floor → mailbox. Multi-hop, address-based routing. That's a **router**.

---

### Real Software Example — Docker Networking (Switch and Router Working Together)

Docker's networking model perfectly illustrates switch vs router:

**Docker Bridge Network (Switch behavior):**
When you run `docker network create myapp-network`, Docker creates a virtual bridge (software switch). Containers on the same bridge network communicate directly via virtual MAC addresses — no routing needed:

```
Container A: 172.18.0.2
Container B: 172.18.0.3
  → A to B: direct via bridge (software switch) — no gateway involved
```

**Docker Routing (Router behavior) — between bridge networks:**
Docker creates an isolated bridge network for each `docker-compose` project by default. Containers on different compose networks (different subnets) can't communicate directly — they're on different networks:

```
docker-compose project 1: bridge network 172.18.0.0/16
docker-compose project 2: bridge network 172.19.0.0/16
  → Network 1 to Network 2: requires routing (Docker's container gateway / iptables)
```

**The Docker `docker0` bridge:**
The host machine acts as the router. The `docker0` interface is 172.17.0.1 — it's the default gateway for all containers. When a container (172.17.0.2) wants to reach the internet (e.g., 142.250.80.46):

1. Container checks: 142.250.80.46 not in 172.17.0.0/16 → send to gateway 172.17.0.1
2. Docker0 bridge (host Linux kernel) receives packet
3. Host's routing table: no specific route → default gateway (host's ISP router)
4. Host's iptables performs NAT: source IP 172.17.0.2 → host's public IP
5. Packet goes to internet

The host machine's network stack is acting as a **router** between Docker's internal bridge network and the external internet.

**Kubernetes networking uses the same model** — each Node has a virtual bridge for pods, and kube-proxy/CNI plugins route traffic between nodes. Pods on the same node → switch. Pods on different nodes → routing (usually via overlay network or BGP).

---

## SECTION 6 — System Design Importance

### Why the Router/Switch Distinction Matters at Scale

**1. Broadcast Domain Segmentation:**
Switches extend the broadcast domain — every device on a switch receives ARP broadcasts. At scale, broadcast storms or excessive ARP traffic can degrade performance. A network with 5,000 devices on one flat switch segment would see every device receiving all broadcasts from all 5,000 others.

Routers (and VLANs) segment broadcast domains. Each subnet/VLAN is its own broadcast domain. A router NEVER forwards broadcasts between subnets — by design. This is why large networks are segmented into many subnets.

**Rule of thumb:** Each broadcast domain (VLAN/subnet) should have ≤500 hosts. Beyond that, broadcast traffic becomes significant overhead.

**2. Security Segmentation:**
The ability to route (or block) traffic between subnets is the foundation of network security architecture:

- Public-facing web servers → DMZ subnet
- Application servers → private subnet (only accessible from web server subnet)
- Database servers → most private subnet (only accessible from app server subnet)

A router (or firewall acting as a router) enforces these boundaries. If web servers were on the same flat subnet as databases (same switch segment), a compromised web server has direct Layer 2 access to the database — no router/firewall to block it.

**3. Traffic Engineering and Load Distribution:**
Routers support protocols like OSPF, BGP, and ECMP (Equal Cost Multi-Path) for load distribution across multiple paths. In a data center, traffic can be distributed across multiple spine switches using ECMP for both fault tolerance and bandwidth aggregation — impossible with Layer 2 switches alone (STP blocks redundant paths).

Modern "spine-leaf" data center architecture uses Layer 3 routing between all nodes — eliminating STP entirely and enabling every path to carry traffic simultaneously.

---

### What Breaks Without This Knowledge

| Misunderstanding                                | Production Consequence                                                                                                                               |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Putting all servers on one flat subnet          | Security breach: compromised server has L2 access to all others; ARP spoofing attacks                                                                |
| Not configuring VLANs properly                  | Network traffic leaks between segments; compliance violations (PCI-DSS requires isolation)                                                           |
| Forgetting default gateway in app server config | App server can reach same-subnet devices but cannot reach internet or other subnets                                                                  |
| Broadcast storm from misconfigured switch       | Network performance collapses as all bandwidth consumed by broadcasts                                                                                |
| No route for return traffic in routing table    | Asymmetric routing causes intermittent connection failures (connection established, packets return via different path, stateful firewall drops them) |
| VLAN misconfiguration on trunk ports            | Traffic from one VLAN visible on another (VLAN hopping security attack)                                                                              |

---

### Impact on Reliability — Redundant Routing

Production networks are designed with no single points of failure:

- **Dual switches** with LACP (Link Aggregation Control Protocol) bonded uplinks for bandwidth + failover
- **Dual routers** with VRRP (Virtual Router Redundancy Protocol) or HSRP — a virtual IP shared between two routers; if primary fails, backup assumes the virtual IP within seconds
- **BGP multi-homing** — enterprise edge routers connect to two ISPs; if one ISP fails, BGP routes all traffic through the other

The systems architect's job is to ensure every routing decision has a failover path.

---

## SECTION 7 — AWS & Cloud Mapping

### VPC = Your Software-Defined Network

AWS VPC (Virtual Private Cloud) is a software-defined version of your physical network. The physical router and switch hardware is abstracted away, but the same principles apply:

| Physical Concept        | AWS Equivalent                                               |
| ----------------------- | ------------------------------------------------------------ |
| Router                  | VPC Router (implicit, always exists) + Route Tables          |
| Switch                  | Subnet (Layer 2 domain within AWS)                           |
| Routing Table           | VPC Route Table (per subnet or main)                         |
| Default Gateway         | 0.0.0.0/0 → Internet Gateway or NAT Gateway                  |
| VLAN                    | Subnet (each subnet is its own broadcast/isolation domain)   |
| Firewall/ACL on router  | Network ACL (subnet-level) + Security Group (instance-level) |
| Inter-office WAN router | AWS Transit Gateway or VPC Peering                           |

---

### VPC Route Tables — The Software Router

Every subnet in a VPC is associated with a route table. The route table IS the router — it makes the forwarding decisions:

```
Route Table for Public Subnet (10.0.1.0/24):
Destination         Target
10.0.0.0/16         local          ← All VPC traffic → stay inside VPC (switch behavior)
0.0.0.0/0           igw-xxxxx      ← Internet traffic → Internet Gateway (router to internet)

Route Table for Private Subnet (10.0.2.0/24):
Destination         Target
10.0.0.0/16         local          ← VPC-internal traffic stays inside
0.0.0.0/0           nat-xxxxx      ← Internet-bound traffic → NAT Gateway (no inbound)

Route Table for Database Subnet (10.0.3.0/24):
Destination         Target
10.0.0.0/16         local          ← Only VPC-internal traffic allowed
(no default route)                 ← No internet access at all — fully private
```

The `local` entry is the "switch" behavior — traffic within the VPC CIDR stays within the VPC fabric without going through an explicit gateway. Different subnets in the same VPC communicate via the implicit VPC router (local route).

---

### AWS Transit Gateway — The Core Router for Multi-VPC Architecture

When you have multiple VPCs (production, staging, shared services) and on-premises networks, you need to route between them. AWS Transit Gateway is the central hub router:

```
┌──────────────────────────────────────────────────┐
│                AWS TRANSIT GATEWAY                │
│           (Central routing hub)                   │
│                                                   │
│  Routing table:                                   │
│  10.0.0.0/16 (Prod VPC)  → VPC attachment-1     │
│  10.1.0.0/16 (Dev VPC)   → VPC attachment-2     │
│  10.2.0.0/16 (Shared)    → VPC attachment-3     │
│  192.168.0.0/16 (On-Prem)→ DX/VPN attachment   │
└──────┬──────────┬──────────┬──────────┬──────────┘
       │          │          │          │
  Prod VPC   Dev VPC   Shared VPC  On-Premises
  10.0.0.0   10.1.0.0  10.2.0.0   (Direct Connect
   /16         /16       /16       or VPN Gateway)
```

**Without Transit Gateway:** Full mesh VPC peering — 10 VPCs = 45 peering connections to manage. With Transit Gateway: 10 VPC attachments to one TGW = simple hub-and-spoke. TGW acts as the enterprise core router.

**TGW Route Tables:** TGW supports multiple route tables, enabling routing policies:

- Prod VPC can route to Shared Services VPC
- Dev VPC can route to Shared Services VPC
- Dev VPC CANNOT route to Prod VPC (different TGW route table, no propagation)
- This mirrors VLAN isolation but at VPC scale

---

### Security Groups and NACLs as Virtual Firewalls on the AWS Router

The VPC route table gets traffic to the right subnet (router function). Before the traffic reaches the EC2 instance, it passes through two more filtering layers:

1. **NACL (Network ACL):** Applied at the subnet boundary. Rules evaluated in order by number. Stateless.
   - Analogy: firewall rules on the interface of a physical router
2. **Security Group:** Applied at the ENI (instance network interface). Stateful — return traffic automatically allowed.
   - Analogy: host-based firewall on each server

Together, they provide defense-in-depth — compromise one and the other still blocks.

---

### AWS Direct Connect — The Dedicated WAN Link to AWS

Direct Connect is AWS's equivalent of a dedicated WAN circuit (MPLS or leased line in traditional networking). Instead of VPN over the internet:

- A physical fiber connection from your data center to an AWS Direct Connect location
- Routing via BGP (same protocol enterprise routers use)
- Predictable latency, dedicated bandwidth (1 Gbps to 100 Gbps)
- Used for hybrid cloud architectures where on-premises workloads connect to AWS

Your on-prem router and AWS's virtual router exchange BGP route advertisements. On-prem router advertises your internal prefixes; AWS advertises VPC CIDRs. Both sides update their routing tables automatically.

---

## SECTION 8 — Interview Preparation

### BEGINNER LEVEL

**Q1: What is the difference between a router and a switch?**

_Answer:_ A switch operates at Layer 2 (Data Link) and forwards Ethernet frames within a local network using MAC addresses. It maintains a CAM table (MAC address table) learned by observing source MAC addresses on each port. Traffic stays within the same subnet. A router operates at Layer 3 (Network) and forwards IP packets between different networks using IP addresses. It maintains a routing table and makes per-packet forwarding decisions based on the destination IP address. Together: switch delivers locally, router delivers globally.

---

**Q2: What is the default gateway and when is it used?**

_Answer:_ The default gateway is the IP address of the router interface on your local subnet — it's the router's "door" into your network. When a device wants to send traffic to an IP address outside its own subnet, it doesn't know the direct path, so it sends all such traffic to the default gateway. The router then makes intelligent routing decisions to forward the traffic toward the destination. Without a correctly configured default gateway, a device can only communicate with other devices on its own subnet — it becomes isolated from the internet and other subnets. Technically, the default gateway corresponds to the `0.0.0.0/0` (default route) entry in the device's routing table.

---

**Q3: What is ARP and why is it needed?**

_Answer:_ ARP (Address Resolution Protocol) maps an IP address (Layer 3) to a MAC address (Layer 2). When a device wants to send an IP packet to another device on the same subnet, it must wrap the IP packet in an Ethernet frame — and Ethernet frames use MAC addresses, not IP addresses, for delivery on the local network. If the device doesn't know the MAC address for the destination IP, it broadcasts an ARP Request: "Who has IP 10.0.1.20?" The device with that IP responds with its MAC address via ARP Reply. The requester caches this in its ARP table for future use. ARP is one of the most fundamental protocols in networking — without it, IP over Ethernet wouldn't work.

---

### INTERMEDIATE LEVEL

**Q4: Explain the difference between VPC peering, Transit Gateway, and AWS PrivateLink. When would you use each?**

_Answer:_

**VPC Peering:** Direct Layer 3 routing connection between exactly two VPCs. Traffic stays on AWS backbone. Non-transitive — if VPC A peers with VPC B, and VPC B peers with VPC C, VPC A cannot reach VPC C through B (must peer directly). Use when: ≤5 VPCs, simple connectivity requirements, cost-sensitive (no TGW per-attachment fee).

**Transit Gateway:** Central hub router connecting multiple VPCs, on-premises networks (via VPN or Direct Connect), and other accounts. Supports transitive routing. Maintains its own routing tables with flexible traffic policies. Use when: many VPCs (5+), shared services that many VPCs access, centralized outbound internet routing, complex routing policies needed.

**AWS PrivateLink:** Creates a private endpoint inside your VPC for accessing AWS services (S3, DynamoDB, etc.) or third-party services without traffic traversing the internet. Uses an Elastic Network Interface (ENI) in your subnet. Not a routing mechanism but a service access pattern. Use when: accessing AWS services from private subnets without internet exposure, avoiding data transfer costs through NAT Gateway, regulatory compliance requiring no internet exposure.

---

**Q5: What is BGP and why do large cloud providers use it?**

_Answer:_ BGP (Border Gateway Protocol) is the routing protocol that powers the entire internet. It's a path-vector protocol — routers exchange "I can reach these prefixes via this path" information. BGP is used when routing between independently administered networks (autonomous systems), unlike OSPF which is used within one organization's network.

Large cloud providers (AWS, Google, Azure) use BGP because:

1. **Scale:** BGP handles the full internet routing table (900,000+ prefixes) efficiently
2. **Policy control:** BGP allows fine-grained control over which routes are accepted and preferred — essential for traffic engineering at cloud scale
3. **Multi-homing:** AWS connects to hundreds of ISPs globally via BGP. BGP enables traffic to automatically fail over and route around ISP outages
4. **Direct Connect:** Customers connecting via AWS Direct Connect use BGP to exchange routes between their corporate network and AWS VPC, enabling automatic propagation of new VPC CIDRs to on-premises routers

For AWS SAA: Transit Gateway uses BGP with Direct Connect; Route 53 uses BGP for AnycastDNS; AWS Backbone uses BGP between AWS regions.

---

**Q6: In AWS, if an EC2 instance in a private subnet cannot reach the internet, what are the possible causes?**

_Answer:_ Systematic diagnosis of private subnet internet connectivity (via NAT Gateway):

1. **No default route to NAT Gateway:** The private subnet's route table must have `0.0.0.0/0 → nat-xxxxxxxx`. If missing, internet traffic has no route. Fix: add the route.

2. **NAT Gateway is in private subnet:** NAT Gateway itself must be in a **public subnet** (a subnet with an IGW route). If NAT Gateway is in a private subnet, it also can't reach the internet. Fix: recreate NAT Gateway in public subnet.

3. **NAT Gateway subnet has no IGW route:** The public subnet containing the NAT Gateway must have a route `0.0.0.0/0 → igw-xxxxxxxx`. Fix: add IGW route to public subnet's route table.

4. **Security Group blocks outbound:** Security groups allow all outbound by default, but if explicitly restricted, outbound HTTPS (443) or HTTP (80) might be blocked. Fix: allow required outbound ports.

5. **NACL blocks traffic:** The NACL on the private subnet must allow outbound traffic on required ports AND inbound ephemeral ports (1024–65535) for return traffic (NACLs are stateless). Fix: add appropriate NACL rules.

6. **DNS not resolving:** The instance can route but can't resolve hostnames. Ensure VPC DNS settings (`enableDnsHostnames`, `enableDnsSupport`) are enabled. Fix: check VPC DNS settings; ensure route to AmazonProvidedDNS (VPC+2 address) exists.

---

### ADVANCED SYSTEM DESIGN LEVEL

**Q7: Design the network architecture for a multi-region SaaS application that must achieve < 50ms latency globally, has strict data residency requirements, and must handle 10M requests/day.**

_Ideal Thinking Approach:_

**Core insight:** You can't put data in one region and serve globally with <50ms latency. Latency from US to Europe is ~80-100ms by physics alone (speed of light across 10,000km). Therefore, the architecture must distribute both compute AND data across regions.

**Layer 1 — Traffic Routing (Global Router):**
AWS Route 53 with latency-based routing acts as the global router — directs users to the nearest regional endpoint. Alternatively, AWS Global Accelerator provides anycast IPs that direct users to the nearest AWS edge, then routes over AWS private backbone (much lower latency than public internet).

**Layer 2 — Regional Architecture:**
Each major region (US-East, EU-West, AP-Southeast) runs a full stack:

- ALB (Application Load Balancer) — routes HTTP/HTTPS by path and host header
- ECS/EKS application tier in private subnets
- Route tables: public subnets → IGW; private subnets → NAT Gateway; no route to other regions (isolation)

**Layer 3 — Data Residency (per-Region Data):**
RDS/Aurora Multi-AZ in each region, storing only that region's user data. No data replication across region boundaries for data residency.

**Layer 4 — Cross-Region Shared Services (Transit Traffic):**
For services that must be centralized (authentication/IAM, audit logging), use AWS Transit Gateway with inter-region peering + PrivateLink for service endpoints. Route only the necessary traffic cross-region.

**Network topology:**

```
Users worldwide → Route 53 / Global Accelerator
  → US-East (ALB → Private Subnet → RDS)
  → EU-West  (ALB → Private Subnet → RDS)  ← Data stays in EU (GDPR)
  → AP-SE    (ALB → Private Subnet → RDS)

Cross-region (auth only):
US Auth Service → PrivateLink → EU Auth (mTLS, port 443, VPC Endpoint)
```

**Exam trap:** Don't propose cross-region VPC peering for routing ALL traffic — this adds latency, cost, and breaks data residency. Keep regional data isolated, route only necessary micro-service traffic cross-region via PrivateLink.

---

**Q8: Your application team reports intermittent database connection failures. Network team says all routes look correct. How would you systematically diagnose this?**

_Ideal Thinking Approach:_

**1. Gather evidence first:**

- What's the error? "Connection refused" (port unreachable), "Connection timed out" (port filtered), or "Connection reset" (connection was established then dropped)?
  - Connection refused → nothing listening on that port OR security group blocking
  - Connection timed out → NACL blocking, or routing issue (packet goes nowhere)
  - Connection reset → load balancer idle timeout, or connection pool issue

**2. VPC Flow Logs analysis:**
Enable VPC Flow Logs on the database's ENI. Look for:

- REJECT entries (SG or NACL blocking traffic)
- Asymmetric flow (traffic in one direction but not the other)
- Source IPs that are unexpected

**3. Security Group audit:**
Verify the RDS security group allows inbound port 5432 (or 3306) from the application server's security group (or CIDR). Not from `0.0.0.0/0` — that's a security issue. Not from instance IP — that changes. Must be security group reference or stable CIDR.

**4. Route table verification:**

- App server subnet: can reach RDS subnet via `local` route (same VPC) — no explicit route needed for same VPC traffic
- If RDS is in a different VPC (peering): verify VPC peering route exists in both route tables

**5. Connection pool exhaustion check:**
If connections work sometimes but fail under load, it's likely RDS connection limit exhaustion. Check `DatabaseConnections` CloudWatch metric. If at max, deploy RDS Proxy.

**6. NACL ephemeral port check:**
If connections work at low traffic but fail intermittently, NACLs blocking return traffic is a likely culprit. Return traffic from RDS comes back on ephemeral ports — ensure NACL allows 1024–65535 inbound to the app server subnet.

**7. DNS resolution:**
App servers using RDS endpoint hostname — verify DNS resolution works. VPC DNS (`enableDnsSupport`) must be true. After RDS failover, DNS TTL must have expired for app to connect to new primary.

---

## File Summary

This file covered the real-world patterns and AWS implementation of router and switch concepts:

- Docker bridge = software switch; host routing table = software router — same principles at lower scale
- Broadcast domain segmentation as security foundation
- AWS VPC route tables as software-defined routers
- Transit Gateway as the enterprise core router for multi-VPC architectures
- BGP: the internet's routing protocol and how AWS uses it
- Direct Connect: dedicated WAN link with BGP route advertising
- Multi-region architecture for <50ms latency with data residency
- Systematic database connectivity troubleshooting via VPC Flow Logs, NACLs, security groups, and DNS

**Continue to File 03** for AWS Certification Focus, all comparison tables, Quick Revision, and the Architect Thinking Exercise.
