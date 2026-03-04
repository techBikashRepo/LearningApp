# Domain Setup

## FILE 01 OF 03 — Physical Infrastructure Replaced, DNS Architecture & Core Concepts

> **Architect Training Mode** | Senior Principal Architect Perspective
> _Optimized for: design judgement · tradeoff evaluation · failure prediction · production debugging_

---

## SECTION 1 — Intuition (Explain Like a 12-Year-Old)

### Before DNS: Static Host Files and Telephone Operators

**1970s–1980s: The HOSTS.TXT Problem**

Before DNS (1983), every computer on the internet (ARPANET) maintained a file called `HOSTS.TXT`:

- Maintained centrally at Stanford Research Institute (SRI)
- Every host on the network downloaded this file periodically via FTP
- File contained: every computer name → IP address mapping in the world

```
Host: ARPA
IP: 10.0.0.1

Host: MIT-AI
IP: 10.0.0.2

... [every computer on the internet]
```

**Why this broke down:**

- By 1983: thousands of computers, downloading a file from one server
- Synchronization: if MIT adds a new computer, all other computers don't know until next download
- Naming conflicts: MIT and Stanford both had a computer named "AI"
- Single point of failure: SRI goes down = nobody can resolve new names

**DNS (Domain Name System, 1983, Paul Mockapetris)**:

- Distributed, hierarchical, delegated naming
- No central server that knows everything
- Delegated: ICANN controls ".com", Amazon controls "amazon.com", you control "yourapp.com"
- Cached: responses cached for TTL duration, reducing load on authoritative servers

**What DNS replaced (and what Nginx/AWS inherits):**

| Old Method                              | DNS+Cloud Equivalent                         |
| --------------------------------------- | -------------------------------------------- |
| HOSTS.TXT on every computer             | DNS resolver cache (periodic TTL expiry)     |
| Calling IT helpdesk for IP of server    | DNS lookup (automatic, milliseconds)         |
| Manual IP changes on every client       | Update DNS record → propagates via TTL       |
| Physical phone directory                | DNS = Internet's phone book for IP addresses |
| Military: hardwired communication paths | DNS: distributed with fallback resolvers     |

**Today's equivalent still exists:** `/etc/hosts` on every computer is the modern HOSTS.TXT. Used for:

- Local development: `127.0.0.1 api.myapp.local`
- Docker/Kubernetes: service discovery within container networks
- Blocking ads: `0.0.0.0 ads.tracking.evil.com`
- Corporate: override DNS for internal services

---

## SECTION 2 — Core Technical Explanation

```
DNS HIERARCHY — delegated from top to bottom
════════════════════════════════════════════════════════════════════

ROOT (.)
  13 root server clusters worldwide (A-M)
  Don't know content of any zone
  Only know: "for .com, ask these nameservers"

    │
    ▼
  .com TLD (Top-Level Domain)
  Operated by Verisign
  13 anycast addresses
  Only knows: "for amazon.com, ask these nameservers"

    │
    ▼
  amazon.com Authoritative Name Servers
  Amazon's nameservers (ns1.amazon.com, ns2.amazon.com...)
  Know ALL records for amazon.com and subdomains

    │
    ▼
  www.amazon.com → 205.251.242.103

════════════════════════════════════════════════════════════════════

YOUR DOMAIN SETUP (myapp.com):

   Register domain: yourregistrar.com (GoDaddy, Namecheap, Route 53 Registrar)
   ↓
   Registrar tells .com TLD: "myapp.com nameservers are:
     ns-1234.awsdns-56.org
     ns-789.awsdns-10.co.uk"
   ↓
   Route 53 Hosted Zone for myapp.com:
     Contains all DNS records you define
   ↓
   You create records in Route 53:
     myapp.com       A        52.14.35.67   (EC2/ALB IP)
     www.myapp.com   CNAME    myapp.com
     api.myapp.com   A        52.14.35.68
     mail.myapp.com  MX       10 mail.provider.com
```

---

## SECTION 3 — Architecture Diagram (MANDATORY)

```
A Record — Address (IPv4)
  Type:  A
  Name:  myapp.com
  Value: 52.14.35.67    ← IP address
  TTL:   300            ← seconds before clients re-query

  Use: map domain to IPv4. The most fundamental record.

  AWS: For ALB/CloudFront, use ALIAS not A (ALIAS updates automatically when AWS changes IPs)

AAAA Record — Address (IPv6)
  Type:  AAAA
  Name:  myapp.com
  Value: 2001:0db8::1   ← IPv6 address
  Use:   IPv6 clients; modern best practice to add alongside A record

CNAME Record — Canonical Name (alias to another name)
  Type:  CNAME
  Name:  www.myapp.com
  Value: myapp.com      ← points to another domain name (not IP)

  Rules:
  ✅ CNAME can point to another domain name
  ❌ CNAME cannot be set on the root/apex domain (myapp.com ← this breaks CNAME)
     Reason: root domain must have SOA + NS records; CNAME would conflict
             (Use ALIAS record instead for apex → CloudFront/ALB)
  ❌ CNAME cannot co-exist with other records on same name

  Common use: www → root domain, or dev.myapp.com → ALB DNS hostname

ALIAS Record (Route 53 specific — not standard DNS)
  Type:  A (looks like A record but functions as alias)
  Name:  myapp.com
  Value: dualstack.myalb-123456.ap-south-1.elb.amazonaws.com  ← ALB DNS name

  Why ALIAS over CNAME for root domain:
  ├── ALIAS works on apex domain (myapp.com) — CNAME cannot
  ├── No extra DNS lookup (resolved within Route 53, zero added latency)
  ├── Automatically updates IPs when ALB/CloudFront IPs change
  └── Free to query (CNAME queries to external services cost per query)

  Use: apex → ALB, apex → CloudFront, apex → S3 website endpoint

MX Record — Mail Exchange
  Type:  MX
  Name:  myapp.com
  Priority: 10
  Value: mail.myapp.com

  Multiple MX records = mail server fallback chain
  Lowest priority number = tried first
  Used by: email delivery (SMTP servers look up MX to find where to send mail)

TXT Record — Text (verification + configuration)
  Type:  TXT
  Name:  myapp.com
  Value: "v=spf1 include:_spf.google.com ~all"

  Uses:
  ├── Domain ownership verification (AWS ACM, Google Search Console)
  ├── SPF (who can send email on behalf of your domain)
  ├── DKIM (cryptographic email signing)
  └── DMARC (email authentication policy)

NS Record — Name Servers (delegation)
  Type:  NS
  Name:  myapp.com
  Values:
    ns-1234.awsdns-56.org
    ns-789.awsdns-10.co.uk   (Route 53 assigns 4 nameservers per hosted zone)

  Critical: NS records at your REGISTRAR must match NS records in Route 53
            Mismatch = DNS not working (most common setup mistake)

SOA Record — Start of Authority (auto-managed)
  Auto-created by Route 53, don't modify manually
  Contains: primary nameserver, admin email, serial number, refresh/retry intervals
```

---

## SECTION 4 — Request Flow (MANDATORY FLOWCHART)

```
TTL = Time To Live (in seconds)
  How long a DNS resolver is allowed to CACHE your record before re-querying

TTL=300 (5 minutes):
  DNS resolver queries Route 53 → gets IP → caches it for 5 minutes
  For 5 minutes: all queries from that resolver return cached IP (no Route 53 query)
  At 5:01: cache expires → resolver re-queries Route 53 → gets new IP

TTL=86400 (24 hours):
  Resolver queries Route 53 → caches for 24 hours
  If you change the IP record: old IP served for up to 24 more hours

  ← This is why "DNS propagation takes 24–48 hours" — it's TTL expiry, not propagation delay

TTL=30 (30 seconds):
  Expensive: many queries to Route 53 (each $0.40/million queries)
  Fast switching: change takes effect for most users within 30 seconds
  When to use: during active migration or incident response

MIGRATION STRATEGY (professional):
  ───────────────────────────────────────────────────────────────
  1 WEEK BEFORE MIGRATION:
    Lower TTL from 86400 → 300 (5 minutes)
    Wait for old TTL to expire (86400 seconds = 24 hours after lowering)
    Now all resolvers will re-query frequently

  MIGRATION DAY:
    Current: myapp.com A 52.14.35.67 (OLD server) TTL=300
    Update:  myapp.com A 52.14.35.68 (NEW server) TTL=300

    Maximum time old IP still served: 5 minutes (TTL=300)
    After 5 minutes: all new queries get new IP

    (Keep old server running until TTL expires and traffic fully migrates)

  AFTER SUCCESSFUL MIGRATION:
    Raise TTL back to 3600 or 86400 (reduce Route 53 query costs)
```

---

### Route 53 Hosted Zones

### What a Hosted Zone Is

```
A Hosted Zone is Route 53's equivalent of a zone file:
  Container for all DNS records for one domain

Two types:
┌──────────────────────────────────────────────────────────────────┐
│ PUBLIC Hosted Zone                                               │
│   Visible to the entire internet                                 │
│   Answers: "what is the IP of api.myapp.com?"                   │
│   Anyone can query it from anywhere                              │
│   Cost: $0.50/hosted zone/month + $0.40/million queries          │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│ PRIVATE Hosted Zone                                              │
│   Only visible from within associated VPC(s)                    │
│   Answers: "what is the IP of user-service.internal?"           │
│   Internet cannot query it                                       │
│   Uses: internal service discovery, split-horizon DNS            │
│   Associate with one or multiple VPCs                            │
│   Cost: $0.50/hosted zone/month                                  │
└──────────────────────────────────────────────────────────────────┘

Split-horizon DNS:
  Public hosted zone:  myapp.com → 52.14.35.67  (public ALB IP)
  Private hosted zone: myapp.com → 10.0.1.100   (internal service IP)

  Result:
  - Internet requests to myapp.com → public IP → goes through ALB, WAF, public internet
  - EC2 instances inside VPC querying myapp.com → private IP → stays in VPC
                                                               no internet roundtrip
```

---

## KEY TAKEAWAYS — FILE 01

- DNS replaced HOSTS.TXT — a single centrally-maintained file downloaded by every computer. DNS is distributed, delegated, and cached. TTL controls cache duration, not "propagation speed."
- **CNAME cannot be on apex domain** (myapp.com). Use Route 53 ALIAS record for apex → ALB/CloudFront. ALIAS resolves within Route 53 (no added lookup), auto-tracks IP changes, and is free to query.
- **NS records at registrar must match Route 53 NS records.** This is the #1 setup mistake. Register domain → check which nameservers Route 53 assigned → paste those into your registrar's NS fields.
- **Lower TTL before migration** (to 300s), wait 24h for old TTL to expire, then migrate. Raise TTL back after. Never migrate with TTL=86400 — it locks users to the old IP for a day.
- **Private Hosted Zone** = DNS only visible inside your VPC. Use for internal service discovery (user-service.internal → 10.0.1.100) so services communicate over internal network, not the public internet.

---

_Continue to File 02 → DNS failures, propagation debugging, SOA/NS traps & split-horizon incidents_
