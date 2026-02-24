# Router vs Switch — Part 3 of 3

### Topic: AWS Certification Focus, Comparison Tables, Quick Revision, Architect Exercise

**Series:** Networking Fundamentals → System Design → AWS Solutions Architect
**Audience:** 14-Year Experienced Full-Stack Developer → Becoming an Architect
**Sections Covered:** 9, 10, 11, 12

---

## SECTION 9 — AWS & Certification Focus

### AWS SAA Exam — Router/Switch Concepts Must-Know

**VPC Route Table — The Most Tested Concept:**

Every subnet must be associated with a route table. If unassociated, it uses the VPC's "main" route table. Key exam points:

- A subnet can be associated with **only one** route table at a time
- One route table can be associated with **multiple** subnets
- The `local` route (`VPC CIDR → local`) is immutable — cannot be modified or deleted
- The local route handles all within-VPC routing — this is "switch-like" behavior in software

**Public vs Private Subnet is determined by the route table:**
A subnet is "public" ONLY if it has a route to an Internet Gateway (IGw) in its route table. There is no "Public Subnet" checkbox — it's defined entirely by whether the routing table has `0.0.0.0/0 → igw-xxxxx`.

A subnet is "private" if:

- It has `0.0.0.0/0 → nat-xxxxx` (can reach internet via NAT, but not reachable from internet)
- OR it has no default route at all (completely isolated — only intra-VPC communication)

**The exam trap:** Many questions ask about a subnet that "should be public" but instances can't be reached from the internet. The common causes:

1. Route table has no IGW route
2. EC2 instance has no public IPv4 address (subnet auto-assign disabled; no EIP)
3. Security group blocks the required inbound port

---

### Route Priority and Longest Prefix Match in AWS

AWS VPC route tables use the same longest prefix match rule as physical routers:

```
Route Table:
10.0.0.0/16    local              ← matches any 10.0.x.x traffic
10.0.2.0/24    pcx-xxxxx          ← more specific: matches 10.0.2.x (peered VPC)
0.0.0.0/0      igw-xxxxx          ← matches everything else

Traffic to 10.0.2.50:
  Matches 10.0.0.0/16 (16-bit match)
  Matches 10.0.2.0/24 (24-bit match) ← WINS — most specific
  → Sent via VPC peering connection
```

**AWS-specific route priorities (when prefixlengths are equal):**

1. Local routes (cannot be overridden even by more specific)
2. Static routes (manually added)
3. Propagated routes from VPN/Direct Connect (lower priority than static)

**Exam scenario:** "Traffic to an on-premises host (192.168.1.10) should use Direct Connect, not VPN."
Answer: Add a more specific static route for 192.168.1.10/32 pointing to the DX attachment. Longest prefix match will prefer the /32 over any /24 propagated route.

---

### Transit Gateway — Exam Details

**TGW key facts:**

- Regional service — a TGW belongs to one region but can peer with TGWs in other regions
- Supports: VPC attachments, VPN attachments, Direct Connect Gateway attachments, TGW Peering attachments
- Maximum bandwidth: 50 Gbps per VPC attachment (burst)
- Supports multiple route tables — enables isolation and segmentation

**TGW route tables vs VPC route tables:**

- VPC route table controls where traffic from a subnet goes (e.g., traffic → TGW)
- TGW route table controls where traffic arriving at TGW goes (e.g., traffic from Prod VPC → goes to Shared Services VPC)

This two-table system is the most complex concept in VPC networking. On the exam, trace traffic through both tables.

**TGW vs VPC Peering — when to use which:**
| Scenario | Use |
|----------|-----|
| 2–3 VPCs that need full mesh connectivity | VPC Peering (cheaper, simpler) |
| 5+ VPCs, hub-and-spoke model | Transit Gateway |
| Cross-account connectivity | Both support it; TGW simpler for many accounts |
| On-premises connectivity to multiple VPCs | TGW (one DX/VPN attachment, routes to all VPCs) |
| Need traffic inspection between VPCs | TGW + Gateway Load Balancer (route through inspection appliance) |

---

### AWS Direct Connect — Routing Details

Direct Connect (DX) uses BGP to exchange routes:

- AWS advertises VPC CIDRs to your on-premises router via BGP
- Your on-premises router advertises your corporate CIDR(s) to AWS via BGP
- VPC route table gains propagated routes from the VGW (Virtual Private Gateway) or TGW DX attachment

**DX vs VPN — exam must-know:**
| Feature | Direct Connect | Site-to-Site VPN |
|---------|---------------|-----------------|
| Bandwidth | 1–100 Gbps dedicated | Up to 1.25 Gbps (per tunnel) |
| Latency | Consistent, low (physical fiber) | Variable (over internet) |
| Setup time | Weeks to months (physical circuit) | Minutes (software config) |
| Cost | Higher (port hours + data transfer) | Lower |
| Redundancy | Requires 2 DX connections for HA | Two tunnels per VPN connection (automatic) |
| Use case | Production workloads requiring consistent latency | Backup, dev/test, initial migration |

**Best practice:** Primary = Direct Connect; Backup = Site-to-Site VPN. When DX fails, traffic falls back to VPN. Configure BGP MED (Multi-Exit Discriminator) to prefer DX routes.

---

### Key Exam Scenarios

**Scenario 1:** "EC2 in private subnet can reach NAT Gateway but traffic doesn't reach the internet."
→ Check: Is the NAT Gateway in a public subnet? Does the NAT Gateway's subnet have an IGW route?

**Scenario 2:** "VPC A and VPC B are peered but instances cannot communicate."
→ Check: Does A's route table have a route for B's CIDR pointing to the peering connection? Does B's route table have a route for A's CIDR pointing to the peering connection? Are security groups allowing cross-VPC traffic?

**Scenario 3:** "You need to connect 20 VPCs and on-premises to each other."
→ Answer: AWS Transit Gateway. One attachment per VPC, one DX/VPN attachment for on-premises.

**Scenario 4:** "After adding a new subnet to a VPC, instances can reach other VPC resources but not the internet."
→ Answer: New subnet uses the VPC's main route table which might not have an IGW route. Associate the subnet with the public route table that has IGW route.

---

## SECTION 10 — Comparison Tables

### Table 1: Switch vs Router — Core Differences

| Dimension        | Switch                                        | Router                                                 |
| ---------------- | --------------------------------------------- | ------------------------------------------------------ |
| OSI Layer        | Layer 2 (Data Link)                           | Layer 3 (Network)                                      |
| Addressing       | MAC address (48-bit, hardware-assigned)       | IP address (32-bit, logically assigned)                |
| Decision basis   | Destination MAC in CAM table                  | Destination IP — longest prefix match in routing table |
| Scope            | Same network/subnet only                      | Between different networks/subnets                     |
| Broadcasts       | Forwards broadcasts to all ports in same VLAN | Does NOT forward broadcasts (blocks them)              |
| Learns addresses | By observing source MAC on incoming frames    | Static config or routing protocols (OSPF, BGP)         |
| Key table        | CAM / MAC address table                       | Routing table                                          |
| Typical failure  | MAC table overflow → broadcast mode           | Routing table missing entry → traffic dropped          |

---

### Table 2: VPC Routing Components Compared

| Component                     | Purpose                                    | Controls                                   | Scope         |
| ----------------------------- | ------------------------------------------ | ------------------------------------------ | ------------- |
| Route Table                   | Subnet-level routing decisions             | Where outbound traffic goes                | Per subnet    |
| Internet Gateway (IGW)        | Connects VPC to internet                   | Bidirectional internet access              | VPC-wide      |
| NAT Gateway                   | Outbound-only internet for private subnets | Private → internet, not internet → private | Per AZ        |
| VPC Peering                   | Direct routing between two VPCs            | Peer-to-peer, non-transitive               | Two VPCs      |
| Transit Gateway               | Hub routing for many VPCs + on-premises    | Transitive, supports multi-VPC + DX + VPN  | Regional hub  |
| VGW (Virtual Private Gateway) | Connects VPC to on-premises via VPN or DX  | BGP route propagation                      | Per VPC       |
| PrivateLink / VPC Endpoint    | Private access to AWS services or SaaS     | No internet, no NAT needed                 | ENI in subnet |

---

### Table 3: Site-to-Site VPN vs Direct Connect vs TGW Routing

| Dimension        | Site-to-Site VPN                       | Direct Connect             | Transit Gateway                    |
| ---------------- | -------------------------------------- | -------------------------- | ---------------------------------- |
| Layer            | Layer 3 (IPsec tunnels)                | Layer 1/3 (physical + BGP) | Layer 3 (TGW routing)              |
| Bandwidth        | Up to 1.25 Gbps                        | 1–100 Gbps                 | 50 Gbps per VPC                    |
| Latency          | Variable (~50–150ms)                   | Consistent (5–20ms)        | Internal AWS (sub-ms)              |
| Routing protocol | BGP (static also supported)            | BGP (mandatory)            | Internal TGW routing tables        |
| Failover         | Automatic (two tunnels per connection) | Manual / DX + VPN backup   | Automatic via multiple attachments |
| Use case         | Dev, backup, burst connectivity        | Production hybrid cloud    | Multi-VPC connectivity             |

---

### Table 4: Layer 2 vs Layer 3 in Physical and AWS Contexts

| Concept              | Physical L2 (Switch)              | Physical L3 (Router)           | AWS Equivalent                                 |
| -------------------- | --------------------------------- | ------------------------------ | ---------------------------------------------- |
| Addressing           | MAC address                       | IP address                     | ENI MAC / Private IP                           |
| Unit of transmission | Ethernet frame                    | IP packet                      | Frame within EC2 hypervisor / IP packet in VPC |
| Decision             | CAM table lookup                  | Routing table lookup           | VPC route table lookup                         |
| Broadcast domain     | Same switch/VLAN                  | No broadcast forwarding        | Same subnet                                    |
| Address resolution   | Switch doesn't need ARP for local | Router needs ARP per interface | VPC hypervisor performs ARP transparently      |
| Scaling              | Limited by broadcast storms       | Limited by routing table size  | VPC scales to 65k subnets                      |

---

### Table 5: Common Connectivity Patterns and AWS Architecture Choices

| Connectivity Need                     | Solution                                                     | Key Config Points                                          |
| ------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------- |
| Private subnet → Internet (one-way)   | NAT Gateway in public subnet + route in private subnet       | Must be in public subnet; route 0.0.0.0/0 → NAT-GW         |
| Internal AWS service without internet | VPC Endpoint (Gateway for S3/DynamoDB; Interface for others) | Add endpoint route to route table                          |
| Two VPCs same account / region        | VPC Peering                                                  | Route each CIDR in both route tables; non-transitive       |
| Many VPCs + on-premises               | Transit Gateway                                              | TGW route table; propagation from VGW/DX; TGW associations |
| External SaaS service privately       | AWS PrivateLink (Interface Endpoint)                         | ServiceEndpoint in VPC; DNS resolves to private IP         |
| Cross-region VPC connectivity         | TGW with inter-region peering                                | Two TGWs peered; route static prefixes across peering      |

---

## SECTION 11 — Quick Revision & Memory Tricks

### 10 Key Points — Router vs Switch

1. **Switch = Layer 2 = MAC addresses = same subnet delivery** — The switch never touches IP addresses. It reads the destination MAC address in the Ethernet frame and forwards accordingly. Traffic stays within the local broadcast domain.

2. **Router = Layer 3 = IP addresses = between-subnet routing** — The router reads the IP packet header, performs a longest-prefix-match lookup in its routing table, and forwards to the next hop.

3. **MAC addresses change at each router hop; IP addresses stay end-to-end** — Each router builds a new Ethernet frame for each hop. The IP packet inside is untouched from source to destination.

4. **ARP bridges Layer 3 → Layer 2** — You can't send an IP packet without knowing the MAC address of the next hop. ARP discovers it by broadcasting on the local segment. Cached in ARP table.

5. **VLANs partition one physical switch into multiple isolated Layer 2 domains** — Devices in VLAN 10 are completely isolated from VLAN 20 at Layer 2. Inter-VLAN traffic requires a router or Layer 3 switch.

6. **Default gateway = the router's IP on your local subnet** — All traffic for destinations outside your subnet goes to the default gateway first. Without it, you're isolated to your local subnet.

7. **AWS Route Table = software router** — The `local` route handles intra-VPC routing (switch-like). Routes to IGW, NAT-GW, TGW, or endpoints handle everything else. Public vs private subnet is defined by route table, not by any subnet type setting.

8. **Transit Gateway = AWS enterprise core router** — Replaces full-mesh VPC peering for organizations with 5+ VPCs. Supports BGP via DX and VPN attachments. Routing is transitive between attachments in the same TGW route table.

9. **Direct Connect uses BGP** — Routes are dynamically exchanged. On-prem routes propagate to VPC route table via VGW propagation. More specific static routes override propagated routes.

10. **Security groups + NACLs are virtual firewalls layered on top of routing** — Routing gets the packet to the right place; security controls determine if the packet is admitted. NACL = stateless (both directions needed); Security Group = stateful (return traffic automatic).

---

### 30-Second Explanation

"A switch operates at Layer 2 and forwards Ethernet frames within the same network using MAC addresses — think of it as the local building's intercom. A router operates at Layer 3 and forwards IP packets between different networks using IP addresses — think of the postal system delivering across cities. MAC addresses change at each router hop; IP addresses remain constant end-to-end. In AWS, VPC route tables are software routers — the local route handles intra-VPC traffic, while routes to Internet Gateway, NAT Gateway, or Transit Gateway handle everything else. A subnet's route table defines whether it's public or private."

---

### Memory Tricks

**"Switch = Same Street, Router = Roads Between Cities"**

- Switch stays in the same neighborhood (same subnet/VLAN)
- Router navigates between cities (different subnets/networks)

**"MAC = Mother's ACcount (Hardware birth)" / "IP = Issued Post (logical assignment)"**

- MAC addresses are burned into hardware at manufacturing (physical, permanent)
- IP addresses are logically assigned and can change (like a mailing address)

**"ARP = Ask the Room for the Person"**

- ARP broadcasts to the whole local network: "Who has this IP?" — just like shouting in a room

**"Local Route = Local Elevator" (within VPC)**

- The `local` route in AWS is like the building elevator — gets you anywhere inside the building without going outside

**"TGW = The Grand Wheel (Hub and Spoke)"**

- Transit Gateway is the center wheel — all VPCs (spokes) connect to the hub

**NACL stateless trap: "NACL = Need A COMPLETE Label"**

- NACLs need rules in both directions (inbound + outbound) because they're stateless

---

### Exam Quick-Fire

- What layer do routers operate at? Layer 3 (Network)
- What layer do switches operate at? Layer 2 (Data Link)
- What protocol resolves IP → MAC? ARP
- What makes a subnet "public" in AWS? Route table has `0.0.0.0/0 → Internet Gateway`
- What protocol do Direct Connect and routers use to exchange routes? BGP
- Can VPC peering be transitive? No — VPC A peered with B, B peered with C: A cannot reach C via B
- What AWS service replaces full-mesh peering? Transit Gateway
- Maximum VPC peering connections per VPC? 125 (soft limit)
- What TGW feature allows isolation between Dev and Prod VPCs? Separate TGW route tables
- Can you change or delete the `local` route in a VPC route table? No — it is immutable

---

## SECTION 12 — Architect Thinking Exercise

### Exercise: Design ACME Corp's AWS Network for 12 Microservices Across 4 Environments

ACME Corp is migrating to AWS. Requirements:

- 4 environments: Production, Staging, Development, Shared-Services
- 12 microservices per environment (frontend, API, notification, auth, payment, reporting, etc.)
- On-premises data center must connect to Production (hybrid workloads, database migration ongoing)
- Shared-Services environment hosts: internal DNS, ActiveDirectory/LDAP, CI/CD, container registry
- Dev cannot access Production data — strict isolation
- All environments need outbound internet for package installs, API calls, etc.
- Production must have < 10ms latency to Shared-Services

**The challenge:** How do you design the VPC architecture, routing, and security boundaries?

Before reading the solution, think about:

1. How many VPCs? One big VPC or multiple VPCs?
2. How do environments connect to Shared-Services?
3. How does on-premises connect?
4. How do you enforce Dev → Prod isolation?
5. How do you handle internet access for 4 VPCs without 4 separate NAT Gateways per AZ?

---

### Solution Walkthrough

**Step 1 — VPC Per Environment**

Each environment gets its own VPC:

- `vpc-prod`: 10.0.0.0/16 (65,534 IPs)
- `vpc-staging`: 10.1.0.0/16
- `vpc-dev`: 10.2.0.0/16
- `vpc-shared`: 10.3.0.0/16

Why separate VPCs? Security boundaries. A compromised service in Dev cannot reach Prod databases at Layer 3 — they're in different VPCs with no peering. NACL misconfiguration in Dev doesn't affect Prod.

Why not one VPC with subnets? Subnets in the same VPC share the VPC's local route — all subnets in a VPC can communicate unless explicitly blocked by security groups/NACLs. This is manageable for small deployments but error-prone at scale. Separate VPCs provide architectural isolation, not just policy-based isolation.

**Step 2 — Transit Gateway as Core Router**

Set up one Transit Gateway in the same region:

- Attach all 4 VPCs
- Attach VPN Gateway for on-premises connectivity (production only — strict routing)
- Create two TGW route tables:

```
TGW Route Table "shared-rt":
  10.0.0.0/16 (prod)    → vpc-prod attachment
  10.1.0.0/16 (staging) → vpc-staging attachment
  10.2.0.0/16 (dev)     → vpc-dev attachment
  10.3.0.0/16 (shared)  → vpc-shared attachment
  Associated with: Shared-Services attachment only
  (Shared-Services can reach all environments — needed for CI/CD deploying to all envs)

TGW Route Table "prod-rt":
  10.3.0.0/16 (shared)  → vpc-shared attachment
  192.168.0.0/16 (on-prem) → vpn-attachment
  Associated with: Prod VPC attachment only
  (Prod goes to shared-services and on-premises only — NOT to Dev or Staging)

TGW Route Table "dev-staging-rt":
  10.3.0.0/16 (shared)  → vpc-shared attachment
  Associated with: Dev + Staging attachments
  (Dev and Staging reach only shared-services — NOT each other, NOT prod)
```

This TGW route table design enforces isolation. Dev cannot reach Prod — there's no route in their TGW route table. Security isn't just policy — it's routing architecture.

**Step 3 — Centralized Outbound Internet (Cost Optimization)**

Instead of NAT Gateways in every VPC (4 VPCs × 2 AZs = 8 NAT Gateways = ~$270/month just for NAT), use centralized internet egress:

- vpc-shared contains NAT Gateways (one per AZ for HA)
- All other VPC route tables: `0.0.0.0/0 → TGW`
- TGW routes `0.0.0.0/0 → vpc-shared attachment`
- vpc-shared routes to NAT Gateway → Internet Gateway

```
Dev EC2 → internet request
  → private route table: 0.0.0.0/0 → TGW
  → TGW: 0.0.0.0/0 → vpc-shared
  → vpc-shared: 0.0.0.0/0 → NAT-GW in AZ-1
  → NAT-GW → IGW → Internet
```

This pattern saves ~$200/month and centralizes egress for monitoring/filtering.

**Step 4 — On-Premises Connectivity**

Site-to-Site VPN initially (fast setup, minutes); Direct Connect ordered for production workloads (takes weeks):

- DX connects to TGW DX attachment
- TGW propagates on-prem routes to vpc-prod route table only (TGW route table isolation)
- On-premises BGP advertises 192.168.0.0/16; AWS advertises 10.0.0.0/16 (prod) and 10.3.0.0/16 (shared-services) to on-prem

**Final Architecture:**

```
On-Premises (192.168.0.0/16)
    │ Direct Connect (BGP)
    ▼
┌──────────────────────────────────┐
│     AWS TRANSIT GATEWAY          │
│  (Central Hub Router)            │
│                                  │
│  3 TGW Route Tables              │
│  - shared-rt (sees all VPCs)     │
│  - prod-rt (sees shared + on-prem│
│  - dev-staging-rt (sees shared)  │
└──┬──────┬──────┬──────┬──────────┘
   │      │      │      │
vpc-prod  vpc-stag vpc-dev vpc-shared
10.0/16  10.1/16  10.2/16  10.3/16
   │                         │
On-prem                   NAT-GW → IGW (internet)
(via DX)                  All VPCs egress here
                          DNS/AD/CI-CD services
```

This is textbook enterprise AWS architecture used at scale by fintechs, healthcare companies, and government AWS workloads.

---

## Complete Series Summary — Router vs Switch

| File    | Sections | Key Takeaways                                                                                                                                                                                    |
| ------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| File 01 | 1–4      | Switch=L2+MAC; Router=L3+IP; ARP bridges L2/L3; MAC changes per hop IP stays constant; VLANs partition L2; Spanning Tree prevents loops                                                          |
| File 02 | 5–8      | Docker bridge/routing as concrete example; broadcast domain = security boundary; VPC route table as software router; TGW as core router; BGP for DX routing; multi-region <50ms design           |
| File 03 | 9–12     | Route table public/private logic; longest prefix match in AWS; TGW route tables for isolation; DX vs VPN comparison; 5 comparison tables; memory tricks; 4-environment enterprise network design |

---

**Next Topic → Topic 07: Packet & Packet Switching**
What actually flows through all these routers and switches? A deep dive into the anatomy of a network packet — header, payload, trailer — and how packet switching enabled the modern internet versus the circuit-switched telephone network it replaced.
