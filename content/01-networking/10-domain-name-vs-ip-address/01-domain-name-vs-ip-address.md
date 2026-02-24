# Domain Name vs IP Address — Part 1 of 3

### Topic: Why Human Names Exist, URL Anatomy, FQDN, and the Architecture of Names

**Series:** Networking Fundamentals → System Design → AWS Solutions Architect
**Audience:** 14-Year Experienced Full-Stack Developer → Becoming an Architect
**Sections Covered:** 1, 2, 3, 4

---

## SECTION 1 — Intuition First (ELI12 Version)

### Analogy 1 — Phone Contacts vs Phone Numbers

Imagine your phone has no contacts app. To call your mom, you must memorize her 11-digit number: `+1-206-555-0147`. To call your bank: `+1-800-867-5309`. To call your doctor: `+1-425-555-2281`.

Now multiply that by every website, API, and service your systems interact with. That's IP addresses alone.

Now add the contacts app. You just say "call Mom" and the phone looks up the number for you. The number can change (new SIM card → new number) but "Mom" always stays Mom. You update once in your contacts, and all future calls work.

Domain names ARE the contacts app for the internet. The IP address is the actual phone number. The domain name is the memorable label that maps to it, and DNS is the contacts lookup system.

The crucial difference from a simple contacts app: **one name can map to multiple numbers** (load balancing), **multiple names can map to the same number** (virtual hosting), and the mapping can change transparently (zero-downtime migration).

### Analogy 2 — Company Department Numbers

A large corporation has internal extension numbers for each department:

- Extension 3301 = HR
- Extension 3302 = Legal
- Extension 4401 = Payroll

But employees don't remember numbers — they call "dial HR" on the intercom. The operator translates "HR" → Extension 3301 every time.

Now imagine the company reorganizes. HR moves to 3450. Nobody needs to update any of their "dial HR" references — just the operator's lookup table gets updated. All calls route correctly starting from the next call.

This is exactly how a web application handles IP changes:

- Your servers get new IPs (cloud migration, datacenter move, scaling event)
- Only the DNS record needs updating
- All user bookmarks, API client configurations, partner integrations — unchanged
- They all resolve the domain name → get the new IP → connect successfully

This abstraction layer is one of DNS's most critical architectural features.

---

## SECTION 2 — Core Technical Deep Dive

### What is an IP Address (the number)

An **IPv4 address** is a 32-bit unsigned integer, written in dotted-decimal notation:

```
192.168.1.1 = 11000000.10101000.00000001.00000001 (binary)
            = 3232235777 (decimal)
```

A computer only speaks the 32-bit integer. The dotted-decimal is just a human display convention.

An **IPv6 address** is a 128-bit value:

```
2001:0db8:85a3:0000:0000:8a2e:0370:7334
  → 128 bits grouped into 8 groups of 16 bits
  → 340,282,366,920,938,463,463,374,607,431,768,211,456 possible addresses
```

IPs identify network interfaces — not physical devices, not logical services, not organizations. A server with 4 network interfaces has 4 IPs. An application can move to a different server and get a different IP instantly.

### What is a Domain Name (the label)

A domain name is a **hierarchical, human-readable label** that maps to one or more IP addresses (or other endpoints) through DNS.

```
Structure of a Fully Qualified Domain Name (FQDN):

  subdomain.secondleveldomain.toplevelDomain.  ← trailing dot = root
  ─────────  ──────────────── ─────────────  ─
  api        payments         example         com   .
   │              │              │              │    │
   │              │              │              │    │
   4th level  3rd level (SLD)  2nd level (TLD) Root
   label       label            label           zone

  Full FQDN: api.payments.example.com.
  Resolved by: authoritative NS for example.com zone
```

### URL Anatomy — The Complete Map

A URL (Uniform Resource Locator) is a superset of the domain name:

```
 https://api.payments.example.com:443/v2/transactions?status=pending&limit=50#page2
  │        │                        │    │               │                       │
  │        │                        │    │               │                       │
scheme  hostname                  port  path           query string           fragment

scheme:   Protocol used (https, http, wss, grpc, s3, ftp)
hostname: The domain name (resolved by DNS to an IP)
port:     TCP port number (443 for HTTPS; omitted if default)
path:     Resource path on the server (/v2/transactions)
query:    Key-value parameters (?status=pending&limit=50)
fragment: Client-side reference to section on page (#page2)
          ← NOT sent to server, interpreted only by browser
```

**Key architectural nuance:** The **path, query, and fragment** are NOT part of the hostname. They are processed by the HTTP layer, not DNS. DNS only resolves the hostname portion. Your load balancer, API gateway, or web server handles routing based on path and query.

**Subdomain vs path-based routing:**

```
Subdomain routing (DNS-based):
  api.example.com → DNS → different IP or ALB per service
  admin.example.com → DNS → different IP or ALB per service

Path-based routing (application-layer):
  example.com/api/... → single IP → ALB rule → API target group
  example.com/admin/... → single IP → ALB rule → Admin target group
```

Subdomain routing has an overhead: DNS resolution per subdomain. Path-based has no additional DNS cost — same hostname, same IP. You choose based on isolation needs.

---

### Why IP Addresses Cannot Replace Domain Names

Several architectural requirements make domain names irreplaceable:

**1. Multi-tenancy and Virtual Hosting**
A single IP (server or load balancer) can host thousands of different domains:

```
IP 198.51.100.10:443 hosts:
  shopA.com → tenant A's store
  shopB.com → tenant B's store
  api.shopC.io → tenant C's API
```

Without domain names, the server has no way to distinguish which tenant the client wants. HTTP/1.1's `Host` header (carrying the domain name) and Server Name Indication (SNI) in TLS both rely on the domain name being present in the request — not just the IP.

**2. TLS Certificate Binding**
TLS certificates are issued for domain names, not IPs (with rare exceptions). Your cert says "this is api.example.com" — when a client connects and presents the certificate, the browser verifies the cert matches the domain name it dialed, not the IP it connected to.

If you connected by IP alone (no domain name), the browser would reject the TLS handshake because there's no domain in the request to validate the cert against.

**3. Content Delivery Networks (CDNs)**
CloudFront, Akamai, and Fastly use DNS for global load distribution. When you resolve `assets.example.com`:

- A user in Tokyo → DNS → CDN's Tokyo PoP IP
- A user in Frankfurt → DNS → CDN's Frankfurt PoP IP

CDN "steering" happens through DNS. Without domain names, CDNs break entirely.

**4. Human Operability and Branding**
`192.168.1.1` is not a brand. `payments.example.com` is. Nobody puts an IP address on a business card, in documentation, or in a press release. The domain name is the interface between the internet and the organization — it represents the service contract independent of physical infrastructure.

---

### FQDN vs Relative Domain Name

```
FQDN (Fully Qualified Domain Name):
  www.example.com.   ← trailing dot explicitly marks root
  ← Never ambiguous — always starts from root zone

Relative / partially qualified:
  www.example.com    ← trailing dot absent, technically relative
  ← In practice, resolvers treat this the same as FQDN
  ← BUT in /etc/resolv.conf with 'search' directives, relative names
     get the search domain appended:
     search corp.internal
     → query for "myservice" becomes "myservice.corp.internal"

```

Kubernetes relies on this heavily:

```
# Inside a pod, querying a service:
my-svc                     → resolves to my-svc.default.svc.cluster.local.
my-svc.namespace           → my-svc.namespace.svc.cluster.local.
my-svc.namespace.svc       → my-svc.namespace.svc.cluster.local.
```

The `ndots:5` setting in Kubernetes pod DNS config controls when the resolver tries absolute lookup vs appending search domains. This is a source of many Kubernetes DNS performance issues.

---

### Internationalized Domain Names (IDN)

Plain ASCII domain names exclude billions of users who don't type Latin characters. IDN extends DNS to support Unicode labels:

```
Arabic: مثال.com
Chinese: 例子.公司
Emoji: 🍕.ws (yes, this works)

All encoded using Punycode for DNS wire format:
مثال.com → xn--mgbh0fb6449c.com
例子.公司 → xn--fsqu00a.xn--55qx5d
```

Punycode (RFC 3492) converts Unicode into ASCII-compatible encoding (ACE) that existing DNS infrastructure can handle without modification. The browser handles the conversion transparently — you type Unicode, browser sends Punycode, DNS resolves, connection made.

**Homograph attacks:** IDN enables phishing via visually identical but different Unicode characters:

- `example.com` (Latin)
- `exаmple.com` (Cyrillic 'а' looks identical to Latin 'a')

Modern browsers display Punycode for suspicious IDN domains to alert users.

---

## SECTION 3 — Architecture Diagram

```
URL COMPONENTS AND WHERE THEY'RE PROCESSED

https://api.payments.example.com:443/v2/orders?status=open#filters
│         │                         │    │               │       │
│         │                         │    │               │       │
│         ▼                         │    │               │       │
│    ┌─────────────────┐            │    │               │       │
│    │  DNS RESOLUTION  │           │    │               │       │
│    │                 │            │    │               │       │
│    │ api.payments.   │            │    │               │       │
│    │ example.com     │            │    │               │       │
│    │   → 198.51.100.2│            │    │               │       │
│    └────────┬────────┘            │    │               │       │
│             │                     │    │               │       │
▼             ▼                     ▼    │               │       │
CLIENT      TCP CONNECTION       TLS    │               │       │
establishes to                  SNI    │               │       │
TLS         198.51.100.2:443   "api.payments.example.com"      │
            (IP from DNS)                │               │       │
                                         ▼               │       │
                                    HTTP REQUEST         │       │
                                    GET /v2/orders       │       │
                                    Host: api.payments.example.com
                                    (domain name in     │       │
                                     Host header)        ▼       │
                                                     QUERY    Not sent
                                                     PARAMS   to server
                                                     (server  (browser
                                                     processes) only)


DOMAIN NAME HIERARCHY:

                         . (root)
                         │
          ┌──────────────┼───────────────┐
         com            net             org
          │
     example.com    (you own this zone)
          │
    payments.example.com   (subdomain you control)
          │
    api.payments.example.com  (leaf record → A → 198.51.100.2)


IP vs DOMAIN MAPPING:

                ┌─────────┐                    ┌──────────┐
  Name →  DNS → │ 198.51. │  ← all these names │api.app.co│
                │ 100.2   │    resolve to same  │www.app.co│
  (1 IP,        │         │    IP               │app.co    │
 many names)    └─────────┘    (virtual hosting)└──────────┘

                ┌────────────┐
 Name →  DNS ─► │IP: 203.0.  │ (Round-robin load balance)
                │    .113.10 │
 (1 name,  ─►  │IP: 203.0.  │ Multiple A records for same name
 many IPs)      │    .113.11 │
           ─►  │IP: 203.0.  │
                │    .113.12 │
                └────────────┘
```

---

## SECTION 4 — Request Flow — Step by Step

### Scenario: User types `https://shop.mycompany.com/products?category=electronics` in browser

```
╔══════════════════════════════════════════════════════════════════╗
║        URL → IP → RESOURCE: COMPLETE FLOW                       ║
╚══════════════════════════════════════════════════════════════════╝

Step 1 — URL Parsing
  Browser parses URL:
    scheme   = https
    hostname = shop.mycompany.com
    port     = 443 (default for https)
    path     = /products
    query    = category=electronics
    fragment = (none)

Step 2 — DNS Resolution for hostname
  Browser checks Chrome DNS cache → miss
  OS resolver called with "shop.mycompany.com"
  OS checks /etc/hosts → miss → queries VPC Resolver (10.0.0.2)

  VPC Resolver → root → TLD (.com) → mycompany.com auth NS
  Auth NS responds:
    shop.mycompany.com  CNAME  alb-12345.us-east-1.elb.amazonaws.com
    alb-12345.us-east-1.elb.amazonaws.com  A  198.51.100.55
    alb-12345.us-east-1.elb.amazonaws.com  A  198.51.100.56

  OS returns: [198.51.100.55, 198.51.100.56]
  Browser picks: 198.51.100.55 (first in list)

Step 3 — TCP 3-Way Handshake
  Browser → TCP SYN → 198.51.100.55:443
  ALB → TCP SYN-ACK → Browser
  Browser → TCP ACK → ALB
  Connection established.

Step 4 — TLS Handshake
  Browser → ClientHello (SNI="shop.mycompany.com", ALPN="h2")
  ALB presents TLS cert for shop.mycompany.com (or *.mycompany.com)
  Browser verifies:
    - Cert CN or SAN matches "shop.mycompany.com" ✓
    - Cert signed by trusted CA ✓
    - Cert not expired ✓
  TLS session established.

Step 5 — HTTP/2 Request
  Browser sends:
    :method: GET
    :path: /products?category=electronics
    :scheme: https
    :authority: shop.mycompany.com
    user-agent: Chrome/115
    accept: text/html

  Fragment (#) is NOT included — it's client-side only

Step 6 — ALB Routing Decision
  ALB receives request:
    Host header: shop.mycompany.com  → matches listener rule
    Path: /products                  → routes to Target Group "frontend"

  ALB forwards to Target Group:
    EC2 i-0abc123 (10.0.2.5:8080)

Step 7 — Application Processing
  EC2 receives:
    GET /products?category=electronics
    Host: shop.mycompany.com
    X-Forwarded-For: <user's real IP>

  App reads query param: category=electronics
  App queries DB, returns HTML

Step 8 — Response Chain
  EC2 → ALB → TLS encrypted → Browser
  Browser renders HTML

╔══════════════════════════════════════════════════════════════════╗
║  Domain Name used in: DNS lookup, TLS SNI, HTTP Host header     ║
║  IP Address used in: TCP connection only                        ║
║  Port: Only in TCP layer, not visible to application code       ║
╚══════════════════════════════════════════════════════════════════╝
```

### Key Insight from This Flow

The domain name appears in **4 different places**:

1. **DNS query** — resolved to an IP
2. **TLS SNI** — server certificate validation
3. **HTTP Host header** — virtual hosting / routing decisions
4. **TLS certificate** — must match the name in the request

The IP address appears in **only 1 place**:

1. **TCP connection** — the actual network-layer destination

This is why domain names are fundamentally architectural, not just cosmetic.

---

## File Summary

This file covered:

- IP address = 32-bit (IPv4) or 128-bit (IPv6) integer identifying a network interface
- Domain name = hierarchical label resolving to IPs through DNS — separates service identity from infrastructure
- URL anatomy: scheme → hostname → port → path → query → fragment (only hostname goes to DNS)
- Why IPs can't replace names: virtual hosting (Host header/SNI), TLS certificate binding, CDN geo-steering, human operability
- FQDN structure and trailing dot (root zone), Kubernetes search domain behavior
- IDN (internationalized domain names) via Punycode encoding, homograph attack surface
- Domain name appears 4 times per request (DNS, SNI, Host header, cert); IP appears once (TCP connect)

**Continue to File 02** for real-world examples (cloud migration patterns, CDN domain strategies, SaaS multi-tenant), system design importance, AWS domain management with Route 53, and interview Q&As.
