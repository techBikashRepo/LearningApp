# Load Balancers — Part 1 of 3

### Topic: Foundations — Intuition, Core Concepts, Architecture & Data Flow

**Series:** Scalability & Performance → Topic 04

---

## SECTION 1 — Intuition (Explain Like a 12-Year-Old)

### The Airport Gate Agent

```
AIRPORT WITHOUT A LOAD BALANCER:

  One ticket counter. One agent. One queue.
  100 passengers per hour handled.
  200 passengers arrive during a peak flight rush.

  Queue backs up. Wait times: 2 hours.
  Half the passengers miss their flights.
  Agent becomes overwhelmed. Makes errors. Gates wrong people.
  System breaks down not from malice but from being a single point of capacity.

  If that ONE agent is sick today: ALL check-ins stop.
  The single agent is both a capacity ceiling AND a single point of failure.

AIRPORT WITH A LOAD BALANCER (the gate coordinator):

  Terminal has one main entrance.
  10 check-in agents available.

  A gate COORDINATOR stands at the entrance:
    "Agent 3 is free — please go to counter 3."
    "Agent 7 has the shortest queue — counter 7, please."
    Some passengers are TSA PreCheck → directed to shorter PreCheck lane.

  THE COORDINATOR IS THE LOAD BALANCER.

  Coordinator properties:
  → Passengers know ONE location: the entrance. They don't know which agent they'll get.
  → Coordinator tracks which agents are available (health checks).
  → If Agent 5 is on break (unhealthy): coordinator stops directing to counter 5.
  → New agent opens counter 11: coordinator immediately starts directing people there.
  → Coordinator doesn't DO the check-in (no work processing).
     Coordinator ONLY ROUTES. Pure traffic direction.

WHAT HAPPENS WHEN THE COORDINATOR IS ABSENT:
  Passengers flood all 10 counters randomly.
  Some agents are overwhelmed. Some are idle.
  A long break? All 10 agents are idle. No passengers know where to go.
  The coordinator's failure stops the whole terminal.

  This is why load balancers are deployed in PAIRS (active-passive HA).
```

---

### The Traffic Signal Analogy

```
Single intersection without a traffic light:
  Cars from all 4 directions simultaneously.
  Result: gridlock, accidents, everything stops.

Traffic signal = simple load balancer:
  Gives ONE direction right-of-way at a time.
  Other directions wait.
  Pattern rotates (round-robin by time).
  System flows at maximum safe throughput.

Advanced traffic intelligence system = L7 load balancer:
  Knows: truck → wider lane. Bicycle → bike lane. Ambulance → clear all lanes.
  Content-aware routing based on request type.

  In software:
  L4 load balancer: sees IP packets, routes by IP/port. Like a basic traffic signal.
  L7 load balancer: sees HTTP headers, reads /api/v1/orders, routes intelligently.
```

---

## SECTION 2 — Core Technical Explanation

### Single Server: SPOF + Capacity Ceiling

```
SINGLE SERVER SYSTEM (before load balancer):

  All users → one server → one process.

  Problem 1: Capacity ceiling
    Server handles 1,000 req/sec at 70% CPU.
    Traffic grows to 1,500 req/sec.
    CPU: 100%. Request queue builds up.
    P99 latency: 2s → 10s → timeouts.
    Server becomes non-functional under load.
    Adding more RAM or CPU (vertical scaling) has limits (largest instance type).

  Problem 2: Single point of failure
    The server process crashes at 2AM. One bad deploy. One OOM.
    System: DOWN. Until the process restarts (30s-2min).

    For a system processing $100K/min in payments:
    2 minutes of downtime = $200K of failed transactions.

    With 2+ servers behind a LB: one server can crash.
    LB detects health check failure → stops routing to it.
    Other servers absorb traffic. Some degraded capacity, but NOT down.

  Problem 3: Deployment downtime
    To deploy new code: restart the server process.
    Users get 0 responses during restart (30-60 seconds).
    With load balancer: rolling deploy across N servers.
    Users always get 1+(N-1) servers running. Zero downtime.
```

---

## SECTION 3 — Architecture Diagram (MANDATORY)

### Layer 4 vs Layer 7 Load Balancers

```
LAYER 4 (Transport Layer — TCP/UDP):

  SEES:
    Source IP, Destination IP, Source Port, Destination Port
    Byte count. Connection state (SYN, ACK, FIN).
    Does NOT read TCP payload.
    Does NOT see HTTP headers, cookies, URLs.

  DOES:
    Forward TCP packets to backend server.
    Maintain connection mapping: client_ip:port ↔ backend_ip:port
    Health check: TCP connection (can it connect on port 80?)

  ALGORITHMS:
    IP Hash: same client IP always routes to same backend
              (pseudo-sticky without cookies — works for non-HTTP)
    Round Robin at TCP connection level.
    Least Connections: fewest active TCP connections.

  PERFORMANCE:
    Ultra-low latency: ~50–100 microseconds
    Processes millions of connections per second.
    No TLS termination (by default) — TLS passthrough to backend.
    Backend must handle its own TLS.

  USE WHEN:
    Non-HTTP protocols: gRPC, MQTT, custom TCP, gaming protocols.
    TLS passthrough required (end-to-end encryption, server cert at backend).
    Latency is critical (< 100 microseconds).
    High connection volume (millions of concurrent connections).
    Static IP required (NLB provides Elastic IPs).

────────────────────────────────────────────────────────────────────────────

LAYER 7 (Application Layer — HTTP/HTTPS):

  SEES:
    Everything L4 sees, PLUS:
    HTTP method (GET, POST), Path (/api/v1/orders), Query string
    HTTP headers (Host, Content-Type, Accept, Authorization)
    Cookies (AWSALB for sticky sessions)
    HTTP response codes from backend (monitors application health, not just TCP)

  DOES:
    Content-based routing:
      /api/* → API server target group
      /static/* → CDN or S3 (no backend needed)
      Host: admin.example.com → Admin server target group
    TLS termination (decrypts HTTPS at the LB, sends HTTP to backend)
    Request manipulation (add headers: X-Forwarded-For, X-Real-IP)
    Response manipulation (GZIP compression, response caching)
    Sticky sessions (reads AWSALB cookie)
    WAF integration (AWS WAF rules applied before forwarding to backend)
    Authentication offloading (OIDC auth at ALB level before request reaches backend)

  PERFORMANCE:
    Higher latency than L4: ~0.5–5ms per request (parsing HTTP headers)
    AWS ALB hardware: handles 25,000+ requests/second per instance, auto-scales

  USE WHEN:
    HTTP/HTTPS applications (almost everything web-based).
    Multiple services behind one load balancer (path-based routing).
    Sticky sessions required (needs HTTP cookie access).
    TLS termination needed (simplifies backends — no TLS on backend).
    WAF, DDoS protection, OIDC auth at the edge.
```

---

### Load Balancing Algorithms

```
ROUND ROBIN (default):
  Request 1 → Server A
  Request 2 → Server B
  Request 3 → Server C
  Request 4 → Server A (cycle repeats)

  Assumption: all requests have roughly equal cost.
  Reality: a "generate PDF" request is 100× heavier than "fetch user profile."
  If Server A happens to get all the PDF requests in a cycle: Server A is overloaded.
  Server B and C serving lightweight requests: idle.

  GOOD FOR: stateless services with homogeneous request cost.
  BAD FOR: heterogeneous workloads where request cost varies widely.

LEAST CONNECTIONS:
  Track: how many active connections does each server currently have?
  Route new request to the server with FEWEST active connections.

  Better for: long-lived connections (WebSockets, file downloads).
  A server with 5 active downloads is busier than one with 50 quick API calls
  that all finish in < 100ms.

  Round-robin: ignores connection duration.
  Least-conn: accounts for it.

WEIGHTED ROUND ROBIN:
  Server A: weight 3 (gets 3 of every 5 requests)
  Server B: weight 2 (gets 2 of every 5 requests)

  USE WHEN: instances are different sizes.
  New server (smaller): give lower weight initially.
  After warm-up: increase weight.
  Also useful for canary deploy: new version gets weight=1, old version weight=9.

IP HASH:
  Hash(client_IP) % N_servers = always same server.
  Same client IP: always same server.

  LIMITATION: if client is behind NAT (thousands of users share one IP):
  all traffic from that IP routes to ONE server.
  → Sticky for a different reason than you intended.
  → Makes one server handle a corporate office's entire user base.
```

---

## SECTION 4 — Request Flow (MANDATORY FLOWCHART)

### Full Load Balancer Architecture

```
INTERNET
    │
    │  Single public endpoint: api.example.com → resolves to ALB DNS
    │
    ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  APPLICATION LOAD BALANCER (AWS ALB)                                     │
│                                                                          │
│  Listeners:                                                              │
│   :443 HTTPS → Terminate TLS → Forward HTTP to target groups             │
│   :80 HTTP  → Redirect to HTTPS (301)                                    │
│                                                                          │
│  Routing Rules (evaluated top to bottom):                                │
│   1. Host: api.example.com  + Path: /admin/*  → Target Group: Admin     │
│   2. Host: api.example.com  + Path: /api/*    → Target Group: API       │
│   3. Host: ws.example.com  + Path: /socket/*  → Target Group: WS        │
│   4. Default                                  → Target Group: API       │
│                                                                          │
│  Health Check per Target Group:                                          │
│   GET /health → HTTP 200 required                                        │
│   Interval: 30s, Timeout: 5s                                             │
│   Healthy threshold: 3 consecutive 200s                                  │
│   Unhealthy threshold: 5 consecutive failures                            │
└────┬───────────────────────┬──────────────────────────┬──────────────────┘
     │                       │                          │
     ▼                       ▼                          ▼
┌────────────┐        ┌────────────┐            ┌────────────┐
│ Target Grp │        │ Target Grp │            │ Target Grp │
│   API      │        │   Admin    │            │   WS       │
│            │        │            │            │            │
│ ┌────────┐ │        │ ┌────────┐ │            │ ┌────────┐ │
│ │ API-01 │ │        │ │ Adm-01 │ │            │ │  WS-01 │ │
│ │(healthy│ │        │ │(healthy│ │            │ │(healthy│ │
│ └────────┘ │        │ └────────┘ │            │ └────────┘ │
│ ┌────────┐ │        │            │            │ ┌────────┐ │
│ │ API-02 │ │        │  (admin    │            │ │  WS-02 │ │
│ │(healthy│ │        │   needs    │            │ │(healthy│ │
│ └────────┘ │        │   fewer    │            │ └────────┘ │
│ ┌────────┐ │        │   servers) │            │            │
│ │ API-03 │ │        └────────────┘            └────────────┘
│ │ (UNHEALTHY)│
│ │ ⚠ removed│
│ └────────┘ │
└────────────┘
    ALB has removed API-03 from rotation.
    Traffic only goes to API-01 and API-02.
    API-03 is rebooting. When health checks pass again: automatically re-added.
```

---

### L4 vs L7 Decision Diagram

```
                  What protocol?
                       │
           HTTP/HTTPS?─┤─Non-HTTP (gRPC, TCP, UDP, MQTT)?
                │                   │
                ▼                   ▼
         Need HTTP-aware          Need static IP?
         routing?                      │
         (path, headers,     YES ──────┤──── NO
          cookies, WAF?)               ▼        ▼
                │               NLB          L4 NLB or
           YES──┤──NO           (static IP + custom TCP LB
                │       │       TLS passthrough)
                ▼       ▼
              ALB    NLB        Need latency < 1ms?
            (HTTP   (TCP           │
             layer  passthrough,     YES → NLB
             rules) or TLS           NO → ALB
                    termination)

AWS MAPPING:
  ALB  = Layer 7, HTTP/HTTPS, path routing, sticky sessions, WAF, OIDC
  NLB  = Layer 4, TCP/UDP/TLS, ultra-low latency, static IPs, millions of req/s
  CLB  = Layer 4/7 hybrid — LEGACY. Do not use for new systems.

  COMMON STACKS:
  Web API: ALB → ECS/EKS services
  WebSocket real-time: NLB (keeps connection alive without ALB's idle timeout) OR
                       ALB with idle timeout extended to match WS lifetime
  gRPC microservices: ALB (gRPC is HTTP/2 — ALB supports it natively)
  Database TCP proxy: NLB → RDS Proxy (L4, no HTTP parsing overhead)
```

---

_→ Continued in: [02-Load Balancers.md](02-Load%20Balancers.md)_
