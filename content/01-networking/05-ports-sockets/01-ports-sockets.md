# Ports & Sockets — Part 1 of 3

### Topic: Foundations — Intuition, Core Concepts, Architecture & Data Flow

**Series:** Networking Fundamentals → System Design → AWS Solutions Architect
**Audience:** 14-Year Experienced Full-Stack Developer → Becoming an Architect
**Sections Covered:** 1, 2, 3, 4

---

## SECTION 1 — Intuition: Explain Like a 12-Year-Old

Imagine you live in a big apartment building. The building has one street address — "100 Tech Street." That's like the IP address — it identifies the building (the computer).

But inside the building, there are many floors and apartments. The front desk (operating system) receives a package and must know: is this package for the restaurant on floor 1, the dentist on floor 2, or the school on floor 3? The **floor number** is the **port**. Each service running on a computer has been assigned a specific floor (port) where it "listens" for incoming visitors.

- Floor 80 = HTTP web server
- Floor 443 = HTTPS web server
- Floor 22 = SSH (remote login)
- Floor 3306 = MySQL database

Now imagine you (a client) call the restaurant on floor 1. The conversation is: you calling FROM your phone (your phone number = your port) TO the restaurant's number (their port). That two-way connection — two phone numbers (IP + port pairs) talking to each other — is a **socket**.

A **socket** is the combination of: IP address + Port number. It's the complete address of a specific process on a specific machine on the network.

The complete connection (from client socket to server socket) is a **socket pair** — and that's what makes two computers able to have a conversation while potentially having thousands of other conversations happening simultaneously.

---

## SECTION 2 — Core Technical Explanation

### What is a Port?

A **port** is a 16-bit number (0–65535) that identifies a specific process or service on a computer. When data arrives at an IP address, the operating system uses the port number to determine which application should receive it.

Think of the IP address as the city and the port as the specific department inside a company in that city. Without ports, a server couldn't run a web server AND an SSH server AND a database simultaneously — the OS wouldn't know which application should receive incoming connections.

**Port number ranges:**

| Range       | Name                      | Description                                                 |
| ----------- | ------------------------- | ----------------------------------------------------------- |
| 0–1023      | Well-Known Ports          | Reserved for standard protocols; require root/admin to bind |
| 1024–49151  | Registered Ports          | Registered with IANA for specific applications              |
| 49152–65535 | Ephemeral (Dynamic) Ports | Assigned by OS to client connections                        |

---

### Critical Well-Known Ports You Must Memorize

| Port    | Protocol | Service                              |
| ------- | -------- | ------------------------------------ |
| 20      | TCP      | FTP Data Transfer                    |
| 21      | TCP      | FTP Control                          |
| 22      | TCP      | SSH (Secure Shell)                   |
| 23      | TCP      | Telnet (insecure, avoid)             |
| 25      | TCP      | SMTP (Email sending)                 |
| 53      | TCP/UDP  | DNS (Domain Name System)             |
| 80      | TCP      | HTTP                                 |
| 110     | TCP      | POP3 (Email retrieval)               |
| 143     | TCP      | IMAP (Email retrieval)               |
| 443     | TCP      | HTTPS (HTTP over TLS)                |
| 465/587 | TCP      | SMTP over TLS                        |
| 993     | TCP      | IMAPS (IMAP over TLS)                |
| 1433    | TCP      | Microsoft SQL Server                 |
| 3306    | TCP      | MySQL / MariaDB                      |
| 3389    | TCP      | RDP (Remote Desktop Protocol)        |
| 5432    | TCP      | PostgreSQL                           |
| 5672    | TCP      | RabbitMQ AMQP                        |
| 6379    | TCP      | Redis                                |
| 8080    | TCP      | HTTP Alternate / Application servers |
| 8443    | TCP      | HTTPS Alternate                      |
| 9092    | TCP      | Apache Kafka                         |
| 27017   | TCP      | MongoDB                              |

---

### What is a Socket?

A **socket** is a software endpoint for communication, defined by:

- **IP address** — which machine
- **Port number** — which service on that machine
- **Protocol** — TCP or UDP

Written as: `IP:Port` — e.g., `54.72.18.9:443` or `192.168.1.10:3306`

A **socket pair** (the complete connection) has FOUR elements:

- Client IP
- Client Port (ephemeral)
- Server IP
- Server Port (well-known/registered)

```
Client Socket:  192.168.1.5:54321  (ephemeral port assigned by OS)
Server Socket:  54.72.18.9:443     (HTTPS server)
```

This 4-tuple uniquely identifies ONE TCP connection. A server can have thousands of simultaneous connections to the same port (443) because the client IPs and client ports differ — each connection has a unique 4-tuple.

---

### Socket Types

**Stream Socket (SOCK_STREAM) — TCP**

- Connection-oriented: establish connection first (TCP handshake), then exchange data
- Reliable, ordered, error-checked delivery
- Used for: HTTP, HTTPS, SSH, databases, email
- Like a phone call — you establish a connection and have a sustained conversation

**Datagram Socket (SOCK_DGRAM) — UDP**

- Connectionless: send data without prior connection
- Unreliable, unordered, no error correction
- Used for: DNS queries, video streaming, gaming, VoIP
- Like dropping a letter in a mailbox — no handshake, no acknowledgment

**Raw Socket**

- Bypasses transport layer; directly accesses IP layer
- Used for: network scanning tools (ping uses raw ICMP), custom protocols, wireshark
- Requires root/admin privileges

---

### Ephemeral Ports — How the Client Side Works

When your browser makes a request to `https://amazon.com:443`, your browser (the client) also needs a port — so the server knows where to send the response. The OS automatically assigns a temporary port from the **ephemeral port range** (49152–65535 on modern systems, though 1024–65535 on Linux).

This is important because:

- You can have 10 browser tabs open, each with its own connection to the same server
- Each tab has a different ephemeral port → different 4-tuple → different socket → different connection
- When the connection closes, the OS releases the ephemeral port for reuse

**TIME_WAIT state:**
After a TCP connection closes, the port doesn't immediately become available. It enters a **TIME_WAIT** state (typically 2 × MSL, where MSL = 60 seconds → 120 seconds total). This prevents stale packets from a previous connection being confused with a new connection on the same port.

**Production issue:** High-traffic services that open and close many connections rapidly can exhaust the ephemeral port range. 65535 - 49152 = 16,383 ephemeral ports. If your service opens and closes 200 connections/second, each TIME_WAIT lasting 60 seconds → 12,000 ports in TIME_WAIT simultaneously → approaching the limit. Solutions: reduce TIME_WAIT duration, use connection pooling, enable SO_REUSEADDR.

---

### How Servers Listen on Ports

A server process binds to a port to listen for incoming connections:

```
1. Server creates a socket (socket() system call)
2. Server binds to an address:port (bind() system call) — e.g., 0.0.0.0:8080
3. Server starts listening (listen() system call) — max queue size set here
4. Server accepts connections (accept() system call) — returns new socket per client
5. Server reads/writes data on accepted socket
6. Connection closed (close() system call)
```

`0.0.0.0` as the bind address means "listen on all network interfaces." `127.0.0.1` means "listen only on loopback" — local connections only, not accessible from network. This is why some database configurations say: "bind-address = 127.0.0.1" — the database only accepts local connections; no external access possible.

---

## SECTION 3 — Architecture Diagram

### Port-Level Architecture of a 3-Tier Web Application

```
                     INTERNET
                        │
                        │ Port 443 (HTTPS)
                 ┌──────▼──────┐
                 │  Load       │
                 │  Balancer   │
                 │  54.72.1.1  │
                 └──────┬──────┘
                        │
         Port 8080 (internal HTTP, no TLS overhead)
         ┌──────────────┼──────────────┐
         │              │              │
  ┌──────▼─────┐ ┌──────▼─────┐ ┌─────▼──────┐
  │ App Server │ │ App Server │ │ App Server │
  │ 10.0.1.10  │ │ 10.0.1.11  │ │ 10.0.1.12  │
  │  :8080     │ │  :8080     │ │  :8080     │
  └──────┬─────┘ └──────┬─────┘ └─────┬──────┘
         │              │              │
         └──────────────┼──────────────┘
                        │
                Port 6379 (Redis Cache)
                 ┌──────▼──────┐
                 │  Redis      │
                 │  10.0.2.20  │
                 │   :6379     │
                 └──────┬──────┘
                        │
                Port 3306 (MySQL)
                 ┌──────▼──────┐
                 │  MySQL RDS  │
                 │  10.0.3.10  │
                 │   :3306     │
                 └─────────────┘
```

---

### Socket-Level View of a Single Request

```
Client Browser              Load Balancer              App Server
192.168.1.5                 54.72.1.1                  10.0.1.10
      │                          │                          │
      │  SYN → 54.72.1.1:443    │                          │
      │  SourcePort: 54321       │                          │
      ├─────────────────────────►│                          │
      │                          │  CONNECT → 10.0.1.10:8080│
      │                          ├─────────────────────────►│
      │  SYN-ACK ◄──────────────┤                          │
      │  ACK ──────────────────►│                          │
      │                          │  [TLS Handshake if SSL termination] │
      │  GET /api/products       │                          │
      ├─────────────────────────►│                          │
      │                          ├─────────────────────────►│
      │                          │  10.0.1.10 → 10.0.2.20:6379 │
      │                          │            (Redis lookup)│
      │                          │  10.0.1.10 → 10.0.3.10:3306 │
      │                          │            (MySQL query) │
      │  HTTP 200 Response       │                          │
      │◄─────────────────────────┤◄─────────────────────────┤
```

---

## SECTION 4 — Request Flow: Step-by-Step

**Scenario:** You open a browser and go to `https://api.myapp.com/products` (resolves to 54.72.1.1).

---

**Step 1 — DNS Resolution**
Browser resolves `api.myapp.com` → 54.72.1.1. The hostname doesn't include a port — browser assumes port 443 for HTTPS, port 80 for HTTP.

**Step 2 — OS Assigns Ephemeral Port**
Your OS randomly assigns an ephemeral source port from the available range, say 54321. Now the full socket pair is defined:

- Client socket: 192.168.1.5:54321
- Server socket: 54.72.1.1:443

**Step 3 — TCP Three-Way Handshake**

- SYN: Client → Server (I want to connect)
- SYN-ACK: Server → Client (Acknowledged, I'm ready)
- ACK: Client → Server (Connection established)

The server's kernel accepts the connection. The listening socket on 443 spawns a new dedicated socket for this specific client-server pair. The listening socket on 443 remains open to accept more connections.

**Step 4 — TLS Handshake (port 443 = HTTPS)**
TLS negotiation occurs over the established TCP connection. Certificate exchange, cipher negotiation, session key establishment. This takes 1-2 round trips.

**Step 5 — HTTP Request Transmitted**
Over the established encrypted TCP connection, the HTTP request is sent:

```
GET /products HTTP/1.1
Host: api.myapp.com
Authorization: Bearer eyJhbGci...
```

**Step 6 — Load Balancer Forwards to Backend**
The load balancer receives on port 443, terminates TLS, and opens a new connection to one of the app servers: 10.0.1.10:8080. Note: the load balancer is both a client (to backend) and a server (to client), maintaining two socket pairs simultaneously.

**Step 7 — App Server Connects to Cache (Port 6379)**
App server at 10.0.1.10 opens a connection to Redis at 10.0.2.20:6379 to check for cached products. This is an internal socket pair: 10.0.1.10:57890 ↔ 10.0.2.20:6379.

**Step 8 — App Server Connects to Database (Port 3306)**
Cache miss → app server connects to MySQL: 10.0.1.10:57891 ↔ 10.0.3.10:3306. Query executes, results returned.

**Step 9 — Response Returns**
Assembled JSON response travels back through all socket pairs in reverse. Each layer removes its wrapper (HTTP response → TLS decryption → TCP segment assembly → IP packet delivery).

**Step 10 — Connection Handling**

- HTTP/1.1: Connection might be kept alive (Keep-Alive header) for subsequent requests
- HTTP/2: Multiplexing — multiple requests/responses over one connection simultaneously
- After closure: client port 54321 enters TIME_WAIT state (~120 seconds) before being reusable

---

### Port States and What They Mean for Debugging

| State        | Meaning                                       | Implication                           |
| ------------ | --------------------------------------------- | ------------------------------------- |
| LISTEN       | Server waiting for connections                | Port is open and service is running   |
| ESTABLISHED  | Active connection                             | Data is flowing                       |
| TIME_WAIT    | Connection recently closed                    | Port temporarily unavailable; normal  |
| CLOSE_WAIT   | Remote closed, local hasn't                   | Application bug — not calling close() |
| SYN_SENT     | Client waiting for server SYN-ACK             | Firewall blocking? Server down?       |
| SYN_RECEIVED | Server got SYN, sent SYN-ACK, waiting for ACK | Under SYN flood attack?               |
| FIN_WAIT     | Initiating close sequence                     | Normal close sequence                 |

```bash
# View all listening ports on Linux
ss -tlnp
netstat -tlnp

# View all established connections
ss -tnp state established

# Check if specific port is open
curl -v telnet://hostname:port
nc -zv hostname port
```

---

## File Summary

This file covered the complete foundation of Ports and Sockets:

- Port = floor in an apartment building (service identifier 0–65535)
- Well-known ports memorized: 22 (SSH), 80 (HTTP), 443 (HTTPS), 3306 (MySQL), 5432 (PostgreSQL), 6379 (Redis), 9092 (Kafka)
- Socket = IP:Port combination (the complete address of a process)
- Socket pair (4-tuple) = client IP:port + server IP:port — uniquely identifies a TCP connection
- Ephemeral ports, TIME_WAIT, port exhaustion
- 3-tier architecture showing all ports
- 10-step request flow from browser to database with socket-level detail

**Continue to File 02** for Real-World Examples, System Design Importance, AWS Mapping, and Interview Preparation.
