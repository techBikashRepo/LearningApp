# DNS — What It Is — Part 1 of 3

### Topic: Core Concepts, Architecture, and How DNS Works

**Series:** Networking Fundamentals → System Design → AWS Solutions Architect
**Audience:** 14-Year Experienced Full-Stack Developer → Becoming an Architect
**Sections Covered:** 1, 2, 3, 4

---

## SECTION 1 — Intuition First (ELI12 Version)

### The Phone Book Analogy

Before smartphones, every house had a physical phone book — a thick directory listing every person and business in the city with their phone number. You'd look up "Pizza Palace" and find "555-0182." You didn't need to memorize 555-0182 — you just remembered "Pizza Palace."

DNS (Domain Name System) is the internet's phone book. The internet speaks in IP addresses: `142.250.80.46`. Humans speak in names: `google.com`. DNS translates one to the other. When you type `amazon.com` into a browser, your computer asks the DNS system: "What IP address is amazon.com?" DNS answers: "54.239.28.85." Your browser connects to that IP.

Without DNS, you'd need to memorize the IP address of every website you visit. DNS lets the internet stay human-friendly while computers operate on numerical addresses.

### The GPS / Contacts Analogy

Your phone's contacts list maps "Mom" to +1-617-555-0101. You don't dial "+1-617-555-0101" — you tap "Mom." If Mom gets a new phone number, you update the contacts list, and you still just tap "Mom" to reach her.

DNS works exactly this way. When a company moves its servers and gets new IP addresses, they update their DNS records. Everyone who visits `company.com` (the name) is automatically routed to the new IP. The name persists even as the underlying address changes. This is a critical design principle: DNS decouples the human-readable name from the physical server address.

### Why This Is Foundational

Without DNS, the entire internet as we know it would be unusable:

- You can't memorize IP addresses for 2 billion websites
- If a company changes servers (IP changes), everyone bookmarking the old IP breaks
- Load balancing across multiple servers via a single name is impossible without DNS
- Microservices within a cloud (EC2 instance names, RDS endpoints, ELB DNS names) all rely on DNS internally

DNS is not just a convenience — it is a foundational infrastructure component. Every single network request starts with a DNS lookup.

---

## SECTION 2 — Core Technical Deep Dive

### What DNS Is

DNS (Domain Name System) is a distributed, hierarchical, globally replicated database that maps human-readable **domain names** to machine-readable **IP addresses** (and other resource records). It is defined in RFC 1034 (1987) and RFC 1035 (1987) — the foundational protocol for the internet's naming infrastructure.

DNS is:

- **Distributed** — no single server holds all mappings; delegated across thousands of servers
- **Hierarchical** — tree-structured namespace (root → TLD → domain → subdomain)
- **Redundant** — multiple servers at each level; no single point of failure
- **Cached** — responses are cached at multiple levels to reduce load and latency
- **Eventually consistent** — changes propagate based on TTL values (seconds to 48 hours)

---

### DNS Namespace Hierarchy

```
. (Root — the implicit dot at the end of every domain name)
├── com (Top-Level Domain)
│   ├── amazon (Second-Level Domain)
│   │   ├── www (Subdomain)
│   │   ├── api (Subdomain)
│   │   └── s3 (Subdomain)
│   └── google
│       ├── www
│       └── mail
├── org
│   └── wikipedia
├── io
│   └── github
├── net
│   └── cloudflare
├── uk (Country Code TLD)
│   └── co
│       └── bbc
└── aws (Generic TLD)
    └── ...
```

**Fully Qualified Domain Name (FQDN):** A complete domain name including all levels: `www.amazon.com.` (the trailing dot is the root; browsers omit it but DNS resolvers add it internally).

Reading right to left: `. → com → amazon → www`

---

### DNS Server Types

There are four distinct types of DNS servers, each playing a different role:

**1. DNS Resolver (Recursive Resolver)**

- The client's first point of contact
- Provided by your ISP (default) or public resolvers (Google 8.8.8.8, Cloudflare 1.1.1.1)
- In AWS: VPC DNS resolver at `VPC_CIDR + 2` (e.g., 10.0.0.2 for VPC 10.0.0.0/16)
- Does the "heavy lifting" — queries other DNS servers on your behalf
- Caches responses → answers repeated queries without contacting authoritative servers

**2. Root Name Servers**

- 13 logical server clusters (labeled A through M): a.root-servers.net, b.root-servers.net, ...
- Each is actually hundreds of servers distributed globally via anycast
- Know only WHERE to find TLD servers — delegate to TLD servers
- Operated by ICANN, Verisign, NASA, and others
- There are 1,000+ physical root server instances globally

**3. TLD Name Servers (Top-Level Domain)**

- One set per TLD (.com, .org, .net, .io, .uk, .aws, etc.)
- Operated by TLD registry operators (Verisign runs .com; PIR runs .org)
- Know only WHERE to find authoritative name servers for each registered domain
- Delegate to authoritative name servers

**4. Authoritative Name Servers**

- The final authority for a specific domain
- Contain the actual DNS records (A, AAAA, CNAME, MX, etc.)
- Operated by the domain owner or their DNS provider (AWS Route 53, Cloudflare, etc.)
- Returns the actual answer: "api.example.com is at 192.168.1.50"

---

### DNS Record Types

| Record Type       | Purpose                                                 | Example                                                |
| ----------------- | ------------------------------------------------------- | ------------------------------------------------------ |
| **A**             | Maps domain → IPv4 address                              | `api.example.com → 93.184.216.34`                      |
| **AAAA**          | Maps domain → IPv6 address                              | `api.example.com → 2606:2800:220:1:248:1893:25c8:1946` |
| **CNAME**         | Alias — maps domain → another domain name               | `www.example.com → example.com`                        |
| **MX**            | Mail exchange — where email should be delivered         | `example.com → mail.example.com (priority 10)`         |
| **TXT**           | Arbitrary text (used for verification, SPF, DKIM)       | `example.com → "v=spf1 include:google.com ~all"`       |
| **NS**            | Specifies authoritative name servers for the domain     | `example.com → ns1.awsdns-01.com`                      |
| **SOA**           | Start of Authority — metadata about the zone            | Serial, refresh interval, retry, expire, minimum TTL   |
| **PTR**           | Reverse DNS — maps IP → domain name                     | `34.216.184.93.in-addr.arpa → api.example.com`         |
| **SRV**           | Service location — IP + port for specific services      | `_http._tcp.example.com → 5 priority, port 80, host`   |
| **CAA**           | Certificate Authority Authorization                     | Which CAs can issue TLS certs for this domain          |
| **ALIAS / ANAME** | Route 53 specific — maps domain → AWS resource DNS name | `example.com → alb-123.us-east-1.elb.amazonaws.com`    |

**Critical distinction — CNAME vs A record:**

- A record: Maps name directly to IP. `api.example.com → 1.2.3.4`
- CNAME: Maps name to another name (which must ultimately resolve to an IP). `api.example.com → api-prod.alb.amazonaws.com → (A record) → 1.2.3.4`
- CNAMEs cannot be used at the zone apex (root domain). You cannot have `example.com CNAME something.else.com`. This is why AWS invented the **ALIAS record** — it behaves like CNAME but is allowed at the zone apex and resolves at DNS server level.

---

### TTL — Time To Live

Every DNS record has a TTL (Time To Live) — a number of seconds that resolvers should cache the record before re-querying:

```
api.example.com.   300   IN   A   93.184.216.34
                   ↑
               TTL = 300 seconds (5 minutes)
```

**TTL = 300**: Resolvers cache this answer for 5 minutes. After 5 minutes, they re-query the authoritative server for a fresh answer.

**Trade-offs:**

| TTL Value      | Propagation Time | Cache Hit Rate     | Use Case                           |
| -------------- | ---------------- | ------------------ | ---------------------------------- |
| 30–60s         | Fast (1 minute)  | Low (more queries) | During active migrations/incidents |
| 300s (5 min)   | Medium           | Medium             | Most application records           |
| 3600s (1 hr)   | Medium-slow      | High               | Stable records (MX, NS)            |
| 86400s (24 hr) | Slow             | Very high          | Almost never-changing records      |

**Production practice:** Before a planned migration (changing IP), reduce TTL to 60s 24–48 hours before the change. Old TTL caches expire. Change IP. After successful migration, increase TTL back to 300+.

---

### DNS Caching at Multiple Levels

DNS responses are cached at four distinct levels:

```
Browser DNS cache        → Windows: "ipconfig /displaydns"; Chrome: chrome://net-internals/#dns
    ↓ miss
OS DNS cache             → Windows: DNS Client Service; Linux: nscd or systemd-resolved
    ↓ miss
Recursive Resolver cache → ISP's resolver or 8.8.8.8 caches millions of lookups
    ↓ miss
Authoritative server     → Final source of truth — always has the answer
```

At each level, the TTL counts down. A 300-second TTL record might already have 250 seconds remaining in a resolver cache — your client gets a cached response in <1ms instead of the full resolution chain (~100ms).

The result: the vast majority of DNS queries are answered by caches. The authoritative servers see only a fraction of the queries that clients make.

---

## SECTION 3 — Architecture Diagram

### DNS Global Infrastructure

```
                        INTERNET
                           │
        ┌──────────────────┼──────────────────┐
        ▼                  ▼                  ▼
  ROOT SERVER A      ROOT SERVER E      ROOT SERVER M
  a.root-servers.net  e.root-servers.net  m.root-servers.net
  (Operated by        (Operated by        (Operated by
   Verisign)           NASA)               WIDE Project)
        │
        │ "I don't know api.example.com, but .com NS is:"
        ▼
   .COM TLD SERVER
   (a.gtld-servers.net)
   Managed by Verisign
        │
        │ "I don't know api.example.com, but example.com NS is:"
        ▼
   AUTHORITATIVE NS for example.com
   ns1.awsdns-01.com  (AWS Route 53)
   ns2.awsdns-01.net
        │
        │ "api.example.com = 93.184.216.34, TTL=300"
        ▼
   RECURSIVE RESOLVER
   (8.8.8.8 Google / 1.1.1.1 Cloudflare / ISP resolver)
   Caches the answer
        │
        │ Returns answer to client
        ▼
   CLIENT APPLICATION
   Browser → IP 93.184.216.34 → TCP connect → HTTP GET
```

---

## SECTION 4 — Request Flow — A to Z DNS Resolution

### Scenario: First-time browser visit to `api.example.com`

```
Step 1: User types "api.example.com" in browser
        Browser checks its own DNS cache → MISS (first visit)

Step 2: Browser asks the OS resolver
        OS checks its cache → MISS
        OS sends UDP query to configured DNS resolver (e.g., 8.8.8.8 or VPC+2 in AWS)
        UDP port 53

Step 3: Recursive Resolver (8.8.8.8) checks its cache
        Cache → MISS for api.example.com
        Resolver must start from scratch

Step 4: Resolver queries a Root Name Server
        Request: "Who is responsible for api.example.com?"
        Root server response: "I don't know, but .com TLD server is at:
          192.5.6.30 (a.gtld-servers.net)"

Step 5: Resolver queries the .com TLD Server
        Request: "Who is responsible for example.com?"
        TLD response: "I don't know, but example.com's authoritative NS is:
          ns1.awsdns-01.com, ns2.awsdns-01.org, ns3.awsdns-01.co.uk"

Step 6: Resolver queries the Authoritative Name Server (Route 53)
        Request: "What is the A record for api.example.com?"
        Authoritative response:
          "api.example.com  300  IN  A  93.184.216.34"
          TTL = 300 seconds

Step 7: Recursive Resolver caches the answer for 300 seconds
        Returns the answer to the OS

Step 8: OS DNS cache stores the answer
        Returns to browser

Step 9: Browser connects to 93.184.216.34 via TCP
        HTTP/HTTPS request begins

Total DNS resolution time: ~50–150ms (first time, cold cache)
Subsequent requests (within TTL): < 1ms (from cache)
```

### Request Flow Summary Table

| Step | Actor              | Action                           | Latency                  |
| ---- | ------------------ | -------------------------------- | ------------------------ |
| 1    | Browser            | Check browser cache              | < 0.1ms                  |
| 2    | OS                 | Check OS cache; send to resolver | < 1ms                    |
| 3–4  | Resolver → Root    | Query root server                | 10–30ms                  |
| 5    | Resolver → TLD     | Query .com TLD server            | 10–30ms                  |
| 6    | Resolver → Auth NS | Query authoritative NS           | 20–60ms                  |
| 7–8  | Resolver → OS      | Cache + return to client         | < 1ms                    |
| 9    | Browser            | TCP connect to IP                | 10–200ms (RTT dependent) |

**Total first-load DNS time:** ~50–150ms one-time cost
**Cached DNS time:** < 1ms — effectively free

---

## File Summary

This file established the foundational understanding of DNS:

- DNS = internet's phone book + GPS contacts: names map to IPs, abstracts physical addresses
- Four DNS server types: Recursive Resolver, Root, TLD, and Authoritative — each plays a distinct delegation role
- DNS namespace hierarchy: root → TLD → domain → subdomain (reading right-to-left)
- Key record types: A (IPv4), AAAA (IPv6), CNAME (alias), MX (email), TXT (verification), NS (delegation), PTR (reverse), ALIAS (Route 53 apex alias)
- TTL: cache lifetime; reduce before migrations; trade-off between propagation speed and server load
- DNS cached at 4 levels: browser → OS → recursive resolver → authoritative
- Full 9-step cold-cache resolution flow: ~50–150ms; warm cache: < 1ms

**Continue to File 02** for real-world examples, system design importance (DNS as abstraction layer), AWS Route 53 deep dive, and interview Q&As.
