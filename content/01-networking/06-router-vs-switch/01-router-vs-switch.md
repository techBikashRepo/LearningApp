# Router vs Switch — Part 1 of 3

### Topic: Core Concepts, Architecture, and How Data Actually Moves Through a Network

**Series:** Networking Fundamentals → System Design → AWS Solutions Architect
**Audience:** 14-Year Experienced Full-Stack Developer → Becoming an Architect
**Sections Covered:** 1, 2, 3, 4

---

## SECTION 1 — Intuition First (ELI12 Version)

### The Amazon Warehouse Analogy — Switch

Imagine a massive Amazon fulfillment warehouse. Inside, there are hundreds of workers at different stations. The **warehouse floor supervisor** knows exactly where every worker sits — "John is at station 14, Sarah is at station 27, Ravi is at station 52." When a package needs to go from John to Sarah, the supervisor says "go to station 27" and it goes there directly — not via the post office, not via any other building — purely inside the warehouse.

That warehouse floor supervisor is a **Switch**. Everything it manages is inside one building (one local network / one subnet). It knows workers by their **badge numbers** (MAC addresses — physical hardware identifiers). It doesn't know or care about the outside world.

### The Post Office Router Analogy — Router

Now imagine you need to send that same package to a customer in another city. You can't use the warehouse floor supervisor — they have no idea about other cities. Instead, you hand the package to the **post office**. The post office looks at the **ZIP code** (IP address) on the label and decides: "This goes to the Atlanta distribution center, which then routes to ZIP code 30301." The Atlanta center routes it further. Each postal hub makes a **routing decision** based on the destination address. Eventually, it arrives at the destination city's local delivery office, and a local carrier (another switch) delivers to the specific house.

That postal routing system is a **Router**. Routers make decisions based on **IP addresses** (logical addresses), route traffic between different networks (subnets), and hand traffic off to the next "hop" until it reaches the destination network. Then the local switch delivers to the specific device.

### The Key Distinction

- **Switch:** "Who is on my local network and where do they sit?" — Layer 2, MAC addresses, same subnet only
- **Router:** "Which network should this go to next?" — Layer 3, IP addresses, between different subnets/networks

A device sending data to another device on the same subnet → Switch handles it alone.
A device sending data to a device on a different subnet / internet → must first go to the Router.

---

## SECTION 2 — Core Technical Deep Dive

### OSI Model Context

Understanding where each device operates in the OSI model is foundational:

| OSI Layer | Name        | Device                            | Address Used       |
| --------- | ----------- | --------------------------------- | ------------------ |
| Layer 7   | Application | Firewall (L7), Load Balancer (L7) | HTTP headers, URLs |
| Layer 4   | Transport   | Firewall (L4), Load Balancer (L4) | TCP/UDP ports      |
| Layer 3   | Network     | **Router**                        | IP address         |
| Layer 2   | Data Link   | **Switch**                        | MAC address        |
| Layer 1   | Physical    | Hub, Repeater, Cable              | Electrical signals |

Routers and switches are the two most critical devices for understanding how real network infrastructure works.

---

### What is a Switch — Technical Detail

A switch is a Layer 2 (Data Link layer) device that forwards **Ethernet frames** within a local network. An Ethernet frame carries:

- Destination MAC address (6 bytes)
- Source MAC address (6 bytes)
- EtherType (2 bytes — identifies the protocol e.g. IPv4)
- Payload (data being carried, e.g., an IP packet)
- FCS (Frame Check Sequence — error detection)

**MAC Address Table (CAM Table):**
A switch maintains a MAC address table mapping MAC addresses to switch ports. When a frame arrives:

1. Switch reads the **source MAC** → records "this MAC is on port X" (MAC learning)
2. Switch reads the **destination MAC** and looks it up in the table
3. If found → forward frame out the specific port (unicast)
4. If not found → flood frame out ALL ports except the incoming one (unknown unicast flood)
5. Once the destination device replies, the switch learns its MAC and makes future traffic unicast

**Why switches are efficient:** Traffic between two devices on the same network stays on those two ports only — no other devices see it (unlike hubs which broadcast everything to everyone). This creates per-port collision domains.

**VLAN (Virtual Local Area Network):**
Switches can be configured with VLANs to partition one physical switch into multiple isolated virtual networks. Devices on VLAN 10 cannot communicate directly with devices on VLAN 20 even though they're plugged into the same physical switch. This is used to isolate:

- VLAN 10: Engineering workstations
- VLAN 20: Finance workstations
- VLAN 30: IP cameras / IoT devices

Traffic between VLANs requires a router (or Layer 3 switch).

---

### What is a Router — Technical Detail

A router is a Layer 3 (Network layer) device that forwards **IP packets** between networks. A router has multiple network interfaces, each on a different network/subnet.

**Routing Table:**
A router's primary data structure is the routing table. Each entry defines:

- Destination network (IP prefix / CIDR)
- Next hop (IP address of the next router or "directly connected")
- Interface (which physical/logical interface to use)
- Metric (cost/preference — lower is better)

```
Destination         Gateway/Next Hop    Interface    Metric
10.0.1.0/24         locally connected   eth0         0
10.0.2.0/24         locally connected   eth1         0
192.168.1.0/24      10.0.1.254          eth0         10
0.0.0.0/0           203.0.113.1         eth2         100    ← Default route (internet)
```

**Default Route:** The `0.0.0.0/0` entry (also called the "default gateway") matches any destination not found in the table. All internet-bound traffic goes here.

**Longest Prefix Match Rule:**
When multiple routing table entries match a destination, the router picks the **most specific** (longest prefix):

- Packet to `10.0.1.50`
- Matches `10.0.0.0/8` (8-bit prefix)
- Matches `10.0.1.0/24` (24-bit prefix)
- Matches `10.0.1.50/32` (32-bit prefix — exact)
- Router picks `/32` (most specific). If no /32, picks /24. If no /24, picks /8. If none, uses default route.

---

### ARP — The Bridge Between Layer 3 and Layer 2

When a device wants to send a packet to another IP address on the same subnet, it knows the destination IP but needs the destination **MAC address** to construct the Ethernet frame. ARP (Address Resolution Protocol) resolves IP → MAC.

**ARP Process:**

```
Device A (10.0.1.5) wants to reach Device B (10.0.1.20)
1. A checks its ARP cache — no entry for 10.0.1.20
2. A broadcasts ARP Request:
   "Who has 10.0.1.20? Tell 10.0.1.5"
   Ethernet dst: FF:FF:FF:FF:FF:FF (broadcast — all devices on LAN receive this)
3. Device B (10.0.1.20) responds ARP Reply:
   "10.0.1.20 is at [B's MAC address]" — sent unicast back to A
4. A caches: 10.0.1.20 → AA:BB:CC:DD:EE:FF
5. A sends Ethernet frame to B's MAC with the IP packet inside
```

**ARP for different-subnet communication:**
When Device A (10.0.1.5) wants to reach Device C (10.0.2.10 — different subnet):

1. A checks routing table — 10.0.2.10 is not local; gateway is 10.0.1.1 (the router)
2. A sends ARP Request for the **router's IP** (10.0.1.1), not Device C's IP
3. Router responds with its MAC address
4. A sends frame to router's MAC, but IP destination is still Device C's IP (10.0.2.10)
5. Router receives frame, removes Ethernet header, sees IP destination 10.0.2.10
6. Router looks up 10.0.2.10 in its routing table → found on eth1 (10.0.2.0/24 subnet)
7. Router ARPs for Device C's MAC address on its eth1 interface
8. Router forwards packet to Device C wrapped in a new Ethernet frame using C's MAC address

**Critical insight:** MAC addresses change at every hop; IP addresses stay the same end-to-end. Ethernet frames carry the packet one hop at a time; IP addresses in the packet header remain constant from source to destination.

---

### Layer 3 Switch — The Hybrid

A **Layer 3 switch** (also called a multilayer switch) combines switch and router functionality in one device. It can:

- Switch traffic within VLANs at hardware speed (L2)
- Route traffic between VLANs without needing a separate router (L3 routing engine in silicon)
- Maintain routing tables and participate in routing protocols (OSPF, BGP)

Used extensively in enterprise data center cores where you need wire-speed routing between many VLANs without the latency of software-based routing. Modern data center switches (Cisco Nexus, Arista, Juniper) are all Layer 3 switches.

---

## SECTION 3 — Architecture Diagram

### Physical Network Topology: Enterprise Office + Data Center

```
INTERNET
    │
    │ (Public IP: 203.0.113.1)
    ▼
┌─────────────────────────────────────────────────────────────────┐
│  EDGE ROUTER (Router #1)                                        │
│  Layer 3 — Routes between Internet and corporate WAN           │
│  Interface: eth0 → Internet (Public IP)                         │
│  Interface: eth1 → Corporate WAN (172.16.0.1/30)               │
└─────────────────────────────────────────────────────────────────┘
    │
    │ WAN Link (172.16.0.x/30)
    ▼
┌─────────────────────────────────────────────────────────────────┐
│  CORE ROUTER (Router #2)                                        │
│  Layer 3 — Routes between all office subnets and data center    │
│  Routing Table: 10.0.1.0/24 → eth1, 10.0.2.0/24 → eth2        │
│                 10.0.10.0/24 → eth3 (Data Center)              │
└────────────────┬──────────────────────────────┬─────────────────┘
                 │                              │
        ┌────────▼────────┐           ┌─────────▼────────┐
        │  FLOOR 1 SWITCH │           │  FLOOR 2 SWITCH  │
        │  Layer 2        │           │  Layer 2         │
        │  VLAN 10: ENG   │           │  VLAN 20: SALES  │
        │  (10.0.1.0/24)  │           │  (10.0.2.0/24)  │
        └────┬────────┬───┘           └────┬─────────┬───┘
             │        │                    │         │
        ┌────▼─┐  ┌───▼──┐           ┌────▼─┐  ┌───▼──┐
        │ ENG  │  │ ENG  │           │SALES │  │SALES │
        │ PC-1 │  │ PC-2 │           │ PC-1 │  │ PC-2 │
        │.1.10 │  │.1.11 │           │.2.10 │  │.2.11 │
        └──────┘  └──────┘           └──────┘  └──────┘

                  Data Center (10.0.10.0/24)
                  ┌────────────────────────────┐
                  │  DATA CENTER SWITCH (L3)   │
                  │  Routes between server VLANs│
                  ├───────────┬────────────────┤
                  │ Web VLAN  │  DB VLAN       │
                  │ .10.10/24 │  .10.20/24     │
                  │ Web-01    │  DB-01         │
                  │ Web-02    │  DB-02         │
                  └───────────┴────────────────┘
```

**Legend:**

- Squares = switches (MAC-based, same-network forwarding)
- Rounded = routers (IP-based, between-network forwarding)
- L3 Switch at DC core = both (inter-VLAN routing at hardware speed)
- `/30` = 2 usable IPs — used for point-to-point router links (no need for larger subnet)

---

## SECTION 4 — Request Flow — Step by Step

### Scenario: Engineer PC (10.0.1.10) Fetches a Web Page from Web-01 (10.0.10.10)

These are on different subnets — both a switch AND a router are involved.

```
Step 1: ENG PC-1 (10.0.1.10) wants to reach Web-01 (10.0.10.10)
        → Checks local routing: 10.0.10.10 is NOT in subnet 10.0.1.0/24
        → Must go through default gateway (Core Router: 10.0.1.1)
        → ARP: "Who has 10.0.1.1?" → Router replies with its MAC: AA:BB:CC:00:00:01

Step 2: PC-1 constructs Ethernet Frame + IP Packet:
        Ethernet: src=PC1-MAC, dst=Router-MAC (AA:BB:CC:00:00:01)
        IP Packet: src=10.0.1.10, dst=10.0.10.10
        (Note: Ethernet dst = ROUTER MAC, but IP dst = FINAL DESTINATION)

Step 3: Floor 1 Switch receives frame
        → Looks up MAC AA:BB:CC:00:00:01 in CAM table → port 24 (uplink to router)
        → Forwards frame out port 24 to Core Router

Step 4: Core Router (Router #2) receives frame
        → Strips Ethernet header (Ethernet frame's job is done — reached router)
        → Reads IP: src=10.0.1.10, dst=10.0.10.10
        → Looks up 10.0.10.10 in routing table
        → Matches 10.0.10.0/24 → via interface eth3
        → ARP: "Who has 10.0.10.10 on eth3?" → Data Center Switch responds

Step 5: Core Router constructs NEW Ethernet Frame for next hop:
        Ethernet: src=Router-eth3-MAC, dst=DC-Switch-MAC
        IP Packet: src=10.0.1.10, dst=10.0.10.10 (UNCHANGED)
        Note: IP packet is identical — only Ethernet frame changed!

Step 6: Data Center L3 Switch receives frame
        → Routes to correct VLAN (Web VLAN: 10.0.10.0/24) via L3 routing table
        → Forwards to Web VLAN via its L2 switching fabric
        → ARP for 10.0.10.10 → Web-01 responds
        → Delivers frame to Web-01

Step 7: Web-01 (10.0.10.10) receives Ethernet frame
        → IP packet: src=10.0.1.10, dst=10.0.10.10
        → HTTP server processes request, generates response

Step 8: Return path — same process in reverse
        → Web-01 frames packet to Data Center L3 Switch MAC
        → L3 Switch routes to Core Router
        → Core Router routes to Floor 1 Switch
        → Switch delivers to PC-1 (10.0.1.10)
```

### Key Takeaways from Flow

| Hop                        | What Changed                              | What Stayed the Same        |
| -------------------------- | ----------------------------------------- | --------------------------- |
| PC → Floor Switch          | Nothing                                   | Ethernet frame + IP packet  |
| Floor Switch → Core Router | Nothing (switch just forwards)            | Ethernet frame + IP packet  |
| Core Router decapsulates   | Ethernet header consumed, new one created | IP packet src/dst unchanged |
| DC Switch → Web-01         | Final Ethernet frame with Web-01's MAC    | IP packet src/dst unchanged |

**The consistent pattern:** MAC addresses change at every router hop (each hop builds a new Ethernet frame). IP addresses never change in transit (they're end-to-end). This is the essence of Layer 2 vs Layer 3 separation.

### Spanning Tree Protocol (STP) — Brief Note

Switches don't understand routing — they just flood unknown frames. In a network with redundant switch links (for fault tolerance), this creates a problem: flooded frames circulate forever (broadcast storm). **Spanning Tree Protocol (STP)** detects loops and blocks redundant ports to create a loop-free logical topology. When a link fails, STP unblocks a previously blocked port. Modern data centers use RSTP (Rapid STP) or ECMP-based L3 designs that don't require STP.

---

## File Summary

This file established the foundational understanding of routers and switches:

- The warehouse supervisor (switch) knows everyone locally; the post office (router) delivers across cities
- Switches operate at Layer 2 with MAC addresses and CAM (MAC address) tables
- Routers operate at Layer 3 with IP addresses and routing tables
- ARP bridges Layer 3 IP addresses to Layer 2 MAC addresses — critical for both same-subnet and cross-subnet communication
- MAC addresses change hop-by-hop; IP addresses remain constant end-to-end
- Layer 3 switches combine both and are the backbone of modern data centers
- VLANs partition physical switches into isolated virtual networks
- Full step-by-step walk through a cross-subnet request flow

**Continue to File 02** for real-world examples, system design impact (AWS VPC routing, Transit Gateway), and interview preparation.
