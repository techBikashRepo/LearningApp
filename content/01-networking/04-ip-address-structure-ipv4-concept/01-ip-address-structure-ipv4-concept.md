# IP Address Structure (IPv4 Concept) — Part 1 of 3

### Topic: Foundations — Intuition, Core Concepts, Architecture & Data Flow

**Series:** Networking Fundamentals → System Design → AWS Solutions Architect
**Audience:** 14-Year Experienced Full-Stack Developer → Becoming an Architect
**Sections Covered:** 1, 2, 3, 4

---

## SECTION 1 — Intuition: Explain Like a 12-Year-Old

Imagine you want to send a letter to your friend. The address on the envelope has multiple parts: Country → State → City → Street → House Number. Each part narrows down the location. First, the postal service routes the letter to the right country, then the right state, then city, then street, and finally the house.

Now imagine a world with billions of houses. You can't just say "send to house 42" — there are millions of "house 42" across the world. You need a complete, hierarchical address that uniquely identifies one location.

An **IPv4 address** works exactly like this — it's a 4-part address that uniquely identifies a device's location on a network.

`192.168.1.45` is like:

- `192` = Country
- `168` = State
- `1` = City / Street
- `45` = House number

The first parts identify the **network** (the neighborhood). The last part identifies the specific **device** (the house) within that network. The boundary between "which part is network" and "which part is device" is flexible — and that flexibility is controlled by something called the **subnet mask** or **CIDR notation**.

This hierarchical design is what allows billions of devices to be addressed and for routers to efficiently decide "this packet should go in THIS direction" — without needing to know every single device address. A router only needs to know which networks exist in which direction, not every individual device.

---

## SECTION 2 — Core Technical Explanation

### IPv4 Address Structure

An IPv4 address is a **32-bit number**. It's written as four groups of 8 bits (called octets), each converted to decimal, separated by dots.

```
Binary:   11000000.10101000.00000001.00101101
Decimal:  192     . 168    . 1      . 45
```

Each octet has 8 bits. Each bit is either 0 or 1. So each octet can represent values from 0 to 255 (2^8 = 256 possible values).

**Full IPv4 Range:** 0.0.0.0 to 255.255.255.255 → 2^32 = 4,294,967,296 possible addresses.

---

### Network Part vs Host Part

An IP address has two parts:

1. **Network part** — identifies which network the device belongs to (like the city/street)
2. **Host part** — identifies the specific device within that network (like the house number)

The dividing line is determined by the **subnet mask**.

**Example:**

- IP address: 192.168.1.45
- Subnet mask: 255.255.255.0 (or /24 in CIDR notation)

Applying the subnet mask (bitwise AND):

```
IP:    192.168.1.45   = 11000000.10101000.00000001.00101101
Mask:  255.255.255.0  = 11111111.11111111.11111111.00000000
                       ─────────────────────────────────────
Network: 192.168.1.0  = 11000000.10101000.00000001.00000000
Host:    .45          = .00101101
```

The first 24 bits (255.255.255) = network. Last 8 bits (.0) = host range. In this network, hosts can be from .1 to .254 (.0 is network address, .255 is broadcast).

---

### CIDR Notation (Classless Inter-Domain Routing)

CIDR notation replaces the older class-based system with a flexible prefix length.

Format: `IP_address/prefix_length`

- The prefix length tells you how many leading bits are the network part.
- The remaining bits are the host part.

```
192.168.1.0/24
  └── /24 means first 24 bits are network → last 8 bits are hosts
  └── Available hosts: 2^8 = 256 addresses (254 usable, 2 reserved)

10.0.0.0/16
  └── /16 means first 16 bits are network → last 16 bits are hosts
  └── Available hosts: 2^16 = 65,536 addresses (65,534 usable)

10.0.0.0/8
  └── /8 means first 8 bits are network → last 24 bits are hosts
  └── Available hosts: 2^24 = 16,777,216 addresses
```

---

### Calculating Addresses from CIDR — The Formula

**Total addresses** = 2^(32 - prefix_length)

| CIDR | Total Addresses | Usable Hosts     | Subnet Mask     |
| ---- | --------------- | ---------------- | --------------- |
| /8   | 16,777,216      | 16,777,214       | 255.0.0.0       |
| /16  | 65,536          | 65,534           | 255.255.0.0     |
| /24  | 256             | 254              | 255.255.255.0   |
| /25  | 128             | 126              | 255.255.255.128 |
| /26  | 64              | 62               | 255.255.255.192 |
| /27  | 32              | 30               | 255.255.255.224 |
| /28  | 16              | 14               | 255.255.255.240 |
| /30  | 4               | 2                | 255.255.255.252 |
| /32  | 1               | 1 (just that IP) | 255.255.255.255 |

**Usable hosts = Total - 2** (subtract network address and broadcast address).

---

### Subnetting — Dividing a Network

Subnetting is the process of dividing a larger network into smaller sub-networks. This is crucial for:

- **Security** — isolate departments or tiers (web, app, DB)
- **Performance** — reduce broadcast domain size
- **IP management** — efficient allocation of address space

**Example:** You have the network 192.168.1.0/24 and want to split it into 2 equal subnets.

Borrow 1 bit from the host part:

- /24 → /25 (prefix grows by 1)
- Subnet 1: 192.168.1.0/25 (addresses .0 to .127)
- Subnet 2: 192.168.1.128/25 (addresses .128 to .255)

Split into 4 subnets: borrow 2 bits → /26:

- 192.168.1.0/26 (.0 to .63)
- 192.168.1.64/26 (.64 to .127)
- 192.168.1.128/26 (.128 to .191)
- 192.168.1.192/26 (.192 to .255)

---

### Network Address and Broadcast Address

For any subnet, two addresses are reserved and not assignable to hosts:

1. **Network Address** — all host bits = 0. Identifies the subnet itself.
   - Example for 192.168.1.0/24: 192.168.1.**0**
2. **Broadcast Address** — all host bits = 1. Sends to all devices on the subnet.
   - Example for 192.168.1.0/24: 192.168.1.**255**

**For a /24 subnet:** 256 total, 2 reserved = **254 usable host addresses** (.1 to .254)

In AWS, additionally, x.x.x.1 (router), x.x.x.2 (DNS), x.x.x.3 (reserved) are also taken → 251 usable per /24 in AWS.

---

### IP Address Classes (Historical Context)

Before CIDR, addresses were divided into fixed classes. Knowing this helps you understand legacy systems and exam questions:

| Class | First Octet Range | Default Mask | Network/Host split | Typical Use            |
| ----- | ----------------- | ------------ | ------------------ | ---------------------- |
| A     | 1–126             | /8           | N.H.H.H            | Government, large orgs |
| B     | 128–191           | /16          | N.N.H.H            | Universities, ISPs     |
| C     | 192–223           | /24          | N.N.N.H            | Small businesses       |
| D     | 224–239           | N/A          | N/A                | Multicast              |
| E     | 240–255           | N/A          | N/A                | Reserved/Research      |

**Class A** starts at 1 (not 0 — that's reserved). 127 is reserved for loopback (127.0.0.1 = localhost). So Class A: 1–126.

CIDR replaced classful networking because it was wasteful. A small company needing 300 IPs would get a Class B (/16 = 65,534 usable) — wasting 65,000+ addresses.

---

## SECTION 3 — Architecture Diagram

### IP Address Structure in a Multi-Tier AWS VPC

```
AWS VPC: 10.0.0.0/16  (65,536 total addresses)
│
│  NETWORK PART (first 16 bits): 10.0  =  00001010.00000000
│  HOST PART (last 16 bits): flexible — assigned to subnets
│
├── PUBLIC SUBNETS (Web Tier)
│   ├── AZ-a: 10.0.0.0/24   → .0 is network, .255 is broadcast
│   │         Hosts: 10.0.0.1 to 10.0.0.254 (251 usable in AWS)
│   │         [ALB: 10.0.0.10]  [NAT Gateway: 10.0.0.11]
│   │
│   └── AZ-b: 10.0.1.0/24
│             Hosts: 10.0.1.1 to 10.0.1.254
│
├── PRIVATE SUBNETS (Application Tier)
│   ├── AZ-a: 10.0.10.0/24
│   │         [App Server 1: 10.0.10.50]
│   │         [App Server 2: 10.0.10.51]
│   │
│   └── AZ-b: 10.0.11.0/24
│             [App Server 3: 10.0.11.50]
│
└── PRIVATE SUBNETS (Database Tier)
    ├── AZ-a: 10.0.20.0/24
    │         [RDS Primary: 10.0.20.100]
    │
    └── AZ-b: 10.0.21.0/24
              [RDS Standby: 10.0.21.100]
```

---

### Subnet Mask Visualization

```
IP:   10  . 0   . 10  . 50
Bits: 00001010 00000000 00001010 00110010

Mask: /24
Bits: 11111111 11111111 11111111 00000000
       └─────────────────────┘  └───────┘
              Network Part       Host Part
          (10.0.10 — fixed)   (0-255 — variable)
```

Devices 10.0.10.50 and 10.0.10.51 are on the **same subnet** — they can communicate directly (Layer 2) without going through a router.

Devices 10.0.10.50 and 10.0.20.100 are on **different subnets** — they must go through a router (the VPC's default router at .1 of each subnet).

---

## SECTION 4 — Request Flow: Step-by-Step — How a Device Uses Its IP

**Scenario:** App Server (10.0.10.50) wants to connect to the RDS database (10.0.20.100).

---

**Step 1 — Application Initiates Connection**
The app code calls `db.connect("10.0.20.100", port=3306)`. The OS network stack creates a packet with:

- Source IP: 10.0.10.50
- Source port: 50000 (ephemeral)
- Destination IP: 10.0.20.100
- Destination port: 3306

**Step 2 — Subnet Check (Is it local?)**
The OS performs the subnet check: "Is 10.0.20.100 on my same subnet (10.0.10.0/24)?"

10.0.20.100 AND 255.255.255.0 = 10.0.20.0 → This is subnet 10.0.20.0
My subnet is 10.0.10.0

Different subnets → must send to the default gateway (router).

**Step 3 — ARP for Gateway MAC Address**
The app server needs the MAC address of the router (10.0.10.1 — the VPC router). It sends an ARP (Address Resolution Protocol) broadcast: "Who has IP 10.0.10.1? Tell 10.0.10.50."

The router replies with its MAC address. The ARP result is cached locally.

**Step 4 — Packet Sent to Router**
The packet is sent with:

- Destination MAC: Router's MAC (Layer 2)
- Destination IP: 10.0.20.100 (Layer 3 — doesn't change)

**Step 5 — Router Makes Routing Decision**
The VPC router receives the packet. It checks the VPC route table:

```
Destination     Target
10.0.0.0/16     local  ← matches! 10.0.20.100 is within the VPC
0.0.0.0/0       igw-xxx  ← only for internet traffic
```

Since 10.0.20.100 is within 10.0.0.0/16, it routes the packet locally to the 10.0.20.0/24 subnet.

**Step 6 — Packet Arrives at RDS Subnet**
The router sends the packet to the subnet containing 10.0.20.100. Another ARP lookup finds the RDS instance's MAC address.

**Step 7 — Security Group Checked at RDS**
Before the packet reaches the RDS instance, AWS's virtual firewall checks the Security Group:

- Does the RDS security group allow port 3306 from 10.0.10.0/24 (or from the App Server's Security Group)?
- If yes → packet delivered. If no → silently dropped.

**Step 8 — RDS Receives the Connection**
The database receives the TCP connection on port 3306 and starts the MySQL handshake.

---

### The Key Insight — Same Subnet vs Different Subnet

```
SAME SUBNET (10.0.10.0/24):
App Server → [Direct Layer 2] → Other App Server
No router involved. Just switch. Sub-millisecond.

DIFFERENT SUBNET (10.0.10.x → 10.0.20.x):
App Server → [Layer 3 Router] → DB Server
Router involvement. Still fast (within VPC) but requires routing decision.

DIFFERENT NETWORK (10.0.x.x → 54.72.18.9):
EC2 → [VPC Router] → [Internet Gateway] → [Public Internet]
Multiple hops. Latency depends on geographic distance.
```

---

### Where Failures Occur in IP Addressing

| Failure                   | Root Cause                                       | Symptom                                            |
| ------------------------- | ------------------------------------------------ | -------------------------------------------------- |
| Wrong subnet mask         | Device thinks remote host is local; skips router | Can't reach devices outside own subnet             |
| Overlapping CIDRs         | Two networks claim same IP space                 | Routing ambiguity, packets go to wrong destination |
| IP exhaustion             | DHCP pool runs out                               | New devices can't get an IP (169.254.x.x APIPA)    |
| Wrong default gateway     | Device sends packets to wrong router             | Can reach local subnet, nothing beyond             |
| Incorrect VPC route table | No route to target subnet                        | Connection drops at VPC router; not a SG issue     |

The most common production debugging error: confusing a **routing issue** (wrong route table) with a **security group issue** (blocked by firewall). Systematic debugging: first confirm routing (can packets even reach the target network?), then check security groups.

---

## File Summary

This file established a complete understanding of IPv4 structure:

- IPv4 is a 32-bit address in 4 octets (0–255 each)
- Network vs host part separation via subnet mask and CIDR notation
- CIDR prefix math: total addresses = 2^(32 - prefix), usable = total - 2
- Subnetting: borrowing host bits to create smaller networks
- IP classes historical context (Class A/B/C)
- Multi-tier VPC subnetting architecture diagram
- Step-by-step routing flow: same subnet (Layer 2 direct) vs different subnet (through router)

**Continue to File 02** for Real-World Examples, System Design Importance, AWS Mapping, and Interview Questions.
