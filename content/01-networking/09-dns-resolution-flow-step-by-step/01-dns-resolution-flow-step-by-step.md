# DNS Resolution Flow (Step by Step) — Part 1 of 3

### Topic: The Exact Mechanics of How Every DNS Query Gets Resolved

**Series:** Networking Fundamentals → System Design → AWS Solutions Architect
**Audience:** 14-Year Experienced Full-Stack Developer → Becoming an Architect
**Sections Covered:** 1, 2, 3, 4

---

## SECTION 1 — Intuition First (ELI12 Version)

### The Mystery Prize Hunt Analogy

Imagine a school organizes a mystery prize hunt. The organizer knows where the prize is, but nobody asks the organizer directly. Instead:

1. You ask the teacher: "Where is the prize?"
2. Teacher doesn't know, but says: "Ask the librarian — she handles all treasure hunts."
3. Librarian doesn't know the location, but says: "Ask the PE teacher — she knows about outdoor activities."
4. PE teacher says: "Go to the storage room. Ask Coach Jenkins in there."
5. Coach Jenkins KNOWS: "The prize is in locker 42B!"
6. You run back: "Locker 42B!"
7. The teacher writes down "Locker 42B" so next time any student asks about this prize, she already knows.

DNS resolution works EXACTLY this way:

- You = the application (browser)
- Teacher = the OS resolver (your first local contact)
- Librarian = the recursive resolver (your ISP's or Google's 8.8.8.8)
- PE teacher = root name server (delegates to TLD)
- Coach Jenkins = authoritative name server (the final, definitive answer)
- Teacher writing it down = DNS caching (TTL)

The key insight: **nobody does it all alone**. Each party knows who to ask next — they delegate. Once resolved, the answer is written down so no one repeats the full journey.

### Why Step-by-Step Resolution Matters for You as an Architect

When your application response time suddenly jumps by 100ms, one culprit is **cold DNS resolution**. Your app connects to a database using its hostname — if the OS's DNS cache expired an hour ago, you pay 50–150ms for a fresh DNS lookup before the connection even starts.

When your company deploys a new service endpoint, and some users get a "host not found" error for 10 minutes while others are fine — that's **negative caching** (NXDOMAIN cached during the brief period when the new DNS record wasn't yet live).

Knowing exactly how DNS resolution flows lets you optimize, predict, and debug these issues with precision.

---

## SECTION 2 — Core Technical Deep Dive

### Recursive vs Iterative Resolution

There are two modes of DNS resolution. Understanding both is critical.

**Iterative (the server just gives a referral):**
In iterative resolution, the server responds with the best answer it has — either the final IP or a referral to another server that might know more. The **querying client** is responsible for following each referral.

```
Client → Root: "What is api.example.com?"
Root → Client: "I don't know, but try: a.gtld-servers.net"
Client → TLD: "What is api.example.com?"
TLD → Client: "I don't know, but try: ns1.awsdns-01.com"
Client → Auth NS: "What is api.example.com?"
Auth NS → Client: "api.example.com = 93.184.216.34"
```

The client (or resolver) does all the legwork — follows each referral until it gets the final answer.

**Recursive (the server does all the work):**
In recursive resolution, the server you ask promises to get you a complete answer. They make all the intermediate queries themselves and return only the final IP to you.

```
Client → Recursive Resolver: "What is api.example.com?"
  (Resolver internally does all iterative queries)
Recursive Resolver → Client: "api.example.com = 93.184.216.34"
```

**In practice:**

- Your OS sends a **recursive query** to its configured recursive resolver (8.8.8.8, 1.1.1.1, or VPC+2)
- The recursive resolver makes **iterative queries** to root, TLD, and authoritative servers
- This hybrid is the standard in production

---

### DNS Query Protocol

DNS queries use **UDP port 53** by default for standard queries (<512 bytes). **TCP port 53** is used for:

- Responses larger than 512 bytes (zone transfers, large DNSSEC responses)
- Zone transfers (AXFR/IXFR — full replication of DNS zone between primary and secondary NS)
- When the server responds with a "truncated" flag set → client retries with TCP

**DNS over HTTPS (DoH):** DNS queries over HTTPS (port 443), encrypted, preventing ISP sniffing of DNS queries. Supported by Chrome, Firefox, and systemd-resolved. Cloudflare (1.1.1.1) and Google (8.8.8.8) support it. Changes the resolver to an HTTPS endpoint.

**DNS over TLS (DoT):** DNS queries over TLS (port 853), encrypted. Similar goals to DoH but at the transport layer.

---

### Detailed DNS Resolver Behavior

The recursive resolver (your ISP's, Google 8.8.8.8, Cloudflare 1.1.1.1, or AWS VPC+2) is the most complex piece in the DNS chain. Here is its exact algorithm:

```
FUNCTION resolve(name):

  1. CHECK own cache for exact match (name + type)
     → If found and TTL > 0: return cached answer immediately
     → If found and TTL = 0: mark as expired, proceed to step 2

  2. CHECK own cache for partial delegation information
     (e.g., cache already has NS records for "example.com"
      even if this specific record wasn't cached)
     → Skip to closest known delegation point

  3. Start from root (or closest known delegation):
     SEND ITERATIVE QUERY to root/TLD/auth NS

  4. Process response:
     ANSWER section: final record found → cache + return to client
     AUTHORITY section: delegation NS records → follow next hop
     ADDITIONAL section: glue records (IP of the NS server itself)

  5. CACHE the response (both positive and negative) per TTL

  6. Return final answer to client
```

**Glue Records — The Chicken-and-Egg Problem:**
What if a name server's hostname is in the same domain it serves?

- `example.com` NS = `ns1.example.com`
- To resolve `ns1.example.com`, you need to query the NS for `example.com` — which IS `ns1.example.com`
- Infinite loop!

Solution: **glue records** — the TLD server includes the IP address of `ns1.example.com` in the "additional" section of its response, even though it's not authoritative for it. The resolver gets the NS name AND its IP in one response.

---

### Negative Caching (NXDOMAIN)

When a domain or record doesn't exist, the authoritative server responds with **NXDOMAIN** (Non-Existent Domain). This is also cached — for the duration of the **SOA's minimum TTL field** (often 300–600 seconds).

Impact: if you query `newapi.example.com` before the record is created, and the resolver caches "newapi.example.com doesn't exist" for 300 seconds, adding the record won't help those clients for 5 minutes — they keep getting NXDOMAIN from cache.

Production impact: during a deployment where a new DNS name is introduced, clients that query before the record is live will get NXDOMAIN cached. Their experience: "host not found" for TTL seconds, even after the record exists.

Mitigation: create DNS records BEFORE deploying the service that uses them. "DNS first, service second."

---

### DNS Cache Coherence

All DNS caches are **eventually consistent**. There is no mechanism to force-flush a resolver's cache centrally. You cannot call Google's 8.8.8.8 and say "please drop your cache for example.com."

**To flush your own caches:**

- Windows: `ipconfig /flushdns`
- macOS: `sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder`
- Linux: `sudo systemd-resolve --flush-caches` or `sudo service nscd restart`
- Chrome browser: `chrome://net-internals/#dns` → Clear host cache

You can flush **your own** caches, but you cannot flush resolver caches of your users, partners, or third-party CDNs. This is why TTL management is critical — it's your only lever for controlling propagation speed globally.

---

## SECTION 3 — Architecture Diagram

### Full DNS Resolution Chain with Caching Layers

```
APPLICATION ON EC2 (in VPC 10.0.0.0/16)
Calls: getaddrinfo("api.partner.com")
          │
          │ 1. Check /etc/hosts → miss
          │
          ▼
    OS DNS RESOLVER
    glibc → /etc/resolv.conf → nameserver 10.0.0.2
          │
          │ 2. Check OS DNS cache → miss
          │ 3. UDP query to 10.0.0.2
          ▼
    VPC DNS RESOLVER (10.0.0.2)
    "Amazon Route 53 Resolver"
          │
          │ 4. Check Route 53 Resolver cache → miss
          │ 5. Check forwarding rules → none for partner.com
          │ 6. Begin iterative queries
          ▼
    ROOT NAME SERVERS (anycast, nearest PoP)
    a.root-servers.net → b.root-servers.net etc.
    Response: "For .com, query: a.gtld-servers.net"
          │
          │ 7. Iterative query to TLD server
          ▼
    .COM TLD SERVER (a.gtld-servers.net)
    Response:
      AUTHORITY: partner.com NS = ns1.cloudflare.com
      AUTHORITY: partner.com NS = ns2.cloudflare.com
      ADDITIONAL: ns1.cloudflare.com A = 108.162.192.1 (glue)
          │
          │ 8. Iterative query to auth NS
          ▼
    AUTHORITATIVE NAME SERVER (ns1.cloudflare.com)
    Response:
      ANSWER: api.partner.com A 93.184.216.34 TTL=300
          │
          │ 9. Route 53 Resolver caches → 300s
          │ 10. OS caches → 300s
          │ 11. Returns to application
          ▼
    APPLICATION: ip = 93.184.216.34
    TCP connect to port 443 → HTTP GET
```

---

## SECTION 4 — Request Flow — Exhaustive Step-by-Step

### Scenario: EC2 instance in VPC queries `api.payments.external.com` for the first time

```
╔═══════════════════════════════════════════════════════════════╗
║              DNS RESOLUTION — COMPLETE FLOW                   ║
╚═══════════════════════════════════════════════════════════════╝

Step 0 — Application initiates hostname resolution
  Python: socket.getaddrinfo("api.payments.external.com", 443)
  Node.js: dns.lookup("api.payments.external.com", callback)
  → Calls OS glibc resolver function

Step 1 — OS checks /etc/hosts
  File: 127.0.0.1 localhost, 10.0.1.5 myserver → no match
  → Proceed to DNS

Step 2 — OS checks Name Service Switch (/etc/nsswitch.conf)
  "hosts: files dns" → checked files (/etc/hosts) first, now DNS

Step 3 — OS sends DNS query to configured resolver
  Source: 10.0.1.50:random_port_54321
  Destination: 10.0.0.2:53 (VPC DNS Resolver)
  Protocol: UDP
  Query type: A record for api.payments.external.com

Step 4 — VPC Resolver checks its cache
  Cache miss. Checks forwarding rules.
  No forwarding rule for external.com → resolve recursively.

Step 5 — VPC Resolver queries Root Name Server
  VPC Resolver → nearest root server (anycast)
  Query: "A record for api.payments.external.com?"
  Root response (REFERRAL):
    AUTHORITY section:
      com. NS a.gtld-servers.net
      com. NS b.gtld-servers.net
      (remaining 11 .com TLD servers)
    ADDITIONAL section (glue):
      a.gtld-servers.net A 192.5.6.30

Step 6 — VPC Resolver queries .com TLD Server
  VPC Resolver → 192.5.6.30 (a.gtld-servers.net)
  Query: "A record for api.payments.external.com?"
  TLD response (REFERRAL):
    AUTHORITY section:
      external.com NS ns1.externalhost.com
      external.com NS ns2.externalhost.com
    ADDITIONAL section (glue):
      ns1.externalhost.com A 72.32.12.1

Step 7 — VPC Resolver queries Authoritative Name Server
  VPC Resolver → 72.32.12.1 (ns1.externalhost.com)
  Query: "A record for api.payments.external.com?"
  Auth NS response (ANSWER):
    ANSWER section:
      api.payments.external.com  300  IN  A  198.51.100.42
  (TTL = 300 seconds = 5 minutes)

Step 8 — VPC Resolver stores in cache
  key: api.payments.external.com + A
  value: 198.51.100.42
  expires_at: now() + 300 seconds
  Also caches: TLD NS delegation, Auth NS delegation (for future queries)

Step 9 — VPC Resolver responds to EC2 instance
  DNS Response UDP packet back to 10.0.1.50:54321
  Answer: api.payments.external.com → 198.51.100.42  TTL=300

Step 10 — OS DNS cache stores result
  TTL=300 starts counting down in OS cache.

Step 11 — Application receives IP
  socket.getaddrinfo() returns [(AF_INET, SOCK_STREAM, 0, '', ('198.51.100.42', 443))]
  → TCP 3-way handshake begins to 198.51.100.42:443

╔═══════════════════════════════════════════════════════════════╗
║        TOTAL RESOLUTION TIME: ~80–150ms (cold cache)         ║
║        CACHED RESPONSE TIME: < 1ms                           ║
╚═══════════════════════════════════════════════════════════════╝
```

### What Gets Cached at Each Level

| Resolver Level        | What Gets Cached                                      | Duration                            |
| --------------------- | ----------------------------------------------------- | ----------------------------------- |
| Root server referral  | TLD server IPs for .com, .org, etc.                   | 48–172800s (very long)              |
| TLD server referral   | NS records for specific domains                       | 172800s = 48 hours typically        |
| Auth NS answer        | Specific record (api.payments.external.com → IP)      | Record's TTL (e.g., 300s)           |
| Recursive resolver    | All of the above, plus NXDOMAIN responses             | Per-record TTL                      |
| OS DNS cache          | Final answer for resolved names                       | Per-record TTL                      |
| Browser DNS cache     | Final answer for recently visited domains             | 60s (Chromium default, ignores TTL) |
| Application DNS cache | Varies — JVM (30s default), Node.js (none by default) | Varies                              |

---

## File Summary

This file provided the complete mechanics of DNS resolution:

- Recursive vs iterative resolution: your resolver makes iterative queries on your behalf
- DNS uses UDP port 53 for queries; TCP for large responses and zone transfers
- Resolver algorithm: check cache → follow closest delegation → iterative queries → cache all results
- Glue records solve the chicken-and-egg problem for ns1.yourdomain.com NS auth loops
- Negative caching (NXDOMAIN) persists for SOA minimum TTL — "DNS first, service second" rule
- Cache levels: root referral (48h) → TLD NS (48h) → auth answer (record TTL) → OS → browser → app
- Full 11-step UDP query trace from EC2 instance to external authoritative name server

**Continue to File 02** for real-world examples (DNS prefetching, split-horizon, DNS amplification attacks), AWS Route 53 Resolver deep dive, and interview Q&As.
