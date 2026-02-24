# DNS — What It Is — Part 2 of 3

### Topic: Real World Systems, System Design Impact, AWS Mapping & Interview Prep

**Series:** Networking Fundamentals → System Design → AWS Solutions Architect
**Audience:** 14-Year Experienced Full-Stack Developer → Becoming an Architect
**Sections Covered:** 5, 6, 7, 8

---

## SECTION 5 — Real World Examples

### Real-Life Analogy 1 — The Library Card Catalog

Before digital search, every library had a card catalog — a large cabinet of index cards, each listing a book's title, author, and physical shelf location (Dewey Decimal number). You look up "Harry Potter" → find Card → Card says "Shelf F3, Box 27."

DNS is the internet's card catalog:

- Book title = domain name (google.com)
- Card catalog = DNS system
- Dewey Decimal / shelf location = IP address (142.250.80.46)
- The book itself = the web server

The card catalog doesn't contain the book — it just tells you where to find it. DNS doesn't contain the website — it just tells your browser the IP address to connect to.

Just as a library can have the physical collection reorganized (books moved to new shelves) without changing the catalog titles, a company can move servers to new IPs by updating DNS records — domain names remain the same.

---

### Real-Life Analogy 2 — The Franchise Headquarters

A McDonald's franchise has one national number: 1-800-244-6227. Calling that number routes you to HQ, which knows every location. "Find me the nearest McDonald's to ZIP 90210." HQ looks up their database and gives you "Sunset Blvd location: 555-0131."

DNS hierarchy mirrors this:

- Your phone's contacts app = browser DNS cache
- "Call McDonald's" → 1-800 number = querying the root DNS resolver
- HQ = TLD server (knows all .com domains + their NS records)
- "Location manager knows their menu" = authoritative name server (knows all records for that specific domain)

The national number (root) delegates to regional (TLD), which delegates to local (authoritative). No single entity knows everything — each level delegates to the next most specific level.

---

### Real Software Example — GitHub Pages and DNS

GitHub Pages illustrates how real-world DNS configuration works:

A developer has `myblog.github.io` (GitHub's domain). They want it accessible at `blog.myname.com` (their custom domain). They:

1. Buy domain `myname.com` from a registrar (Namecheap, GoDaddy, Route 53)
2. In GitHub Settings → set custom domain: `blog.myname.com`
3. At their DNS registrar, add:
   ```
   blog.myname.com.   CNAME   myaccount.github.io.   TTL: 3600
   ```
4. GitHub verifies ownership via a TXT record:
   ```
   _github-pages-challenge-myaccount.myname.com.   TXT   "abc123verificationtoken"
   ```

What happens at DNS level when someone visits `blog.myname.com`:

- Resolver queries authoritative NS for `myname.com`
- Gets back: `blog.myname.com CNAME myaccount.github.io`
- Resolver then resolves `myaccount.github.io` → A record → `185.199.108.153`
- Browser connects to `185.199.108.153`
- GitHub's server receives the request, reads the `Host: blog.myname.com` header, serves the correct blog

**Key insight:** The CNAME creates a chain. GitHub can change the IP behind `myaccount.github.io` (185.199.108.153 → new IP) and `blog.myname.com` instantly resolves to the new IP — the developer never touches their DNS record.

---

## SECTION 6 — System Design Importance

### DNS as the Abstraction Layer for Everything

DNS is the most important abstraction layer in distributed systems. It decouples **service names** from **server locations**. This enables:

**1. Zero-downtime migrations:**
You have 10M clients connecting to `payments.mycompany.com` → 18.211.x.x (old server).
Migration plan:

- Spin up new payment server at 54.210.x.x
- Reduce DNS TTL from 3600s to 60s (wait 1 hour for old TTL caches to expire)
- Update `payments.mycompany.com` A record → 54.210.x.x
- All new connections go to new server
- Old connections on old server complete naturally
- Zero downtime; zero client-side changes

**2. DNS-based load balancing:**

```
api.mycompany.com   A   54.210.1.1   (Server 1)
api.mycompany.com   A   54.210.1.2   (Server 2)
api.mycompany.com   A   54.210.1.3   (Server 3)
```

Multiple A records for the same name — clients receive all three and typically use the first. Resolvers often rotate the order (round-robin DNS). Simplest form of load balancing; no dedicated load balancer needed (but lacks health checks — dead servers still returned).

**3. Blue/Green deployments via DNS:**

```
# Before deployment (all traffic to blue):
app.mycompany.com   CNAME   blue.app.mycompany.com   TTL: 60

# After successful staging test (cut traffic to green):
app.mycompany.com   CNAME   green.app.mycompany.com  TTL: 60

# On problem — instant rollback:
app.mycompany.com   CNAME   blue.app.mycompany.com   TTL: 60
```

With 60-second TTL, cut-over takes 60 seconds to propagate globally. Rollback also 60 seconds.

**4. Microservice discovery:**
In Kubernetes: every Service gets a DNS name. `payments-svc.default.svc.cluster.local` resolves to the ClusterIP of the payments service. Pods call each other by name — Kubernetes DNS (CoreDNS) resolves them. If the payments service re-deploys to a new pod IP, DNS is updated automatically. Clients reconnect to the new pod without knowing the IP changed.

---

### What Breaks Without DNS Knowledge

| Misunderstanding                                 | Production Consequence                                                                                                    |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Setting TTL=86400 before migration               | DNS change takes 24+ hours to propagate; old IP serves traffic for a day                                                  |
| Using IP addresses instead of DNS in app configs | Server IP changes → all app configs need manual update → downtime                                                         |
| CNAME at zone apex                               | Breaks email (MX records don't work with CNAME apex), some DNS providers reject it — use ALIAS/ANAME                      |
| Negative caching ignored                         | "Name not found" errors cached; fixing DNS doesn't immediately help clients that cached NXDOMAIN                          |
| Low TTL permanently                              | Excessive recursive resolver queries; higher latency for most users; increased cost                                       |
| DNS as bottleneck in microservices               | Without DNS caching in pod, every service call makes DNS query; at 10K req/s = 10K DNS queries/s; overwhelms internal DNS |

---

## SECTION 7 — AWS & Cloud Mapping

### AWS Route 53 — Full DNS Service

Route 53 is AWS's authoritative DNS service. Named after port 53 (DNS port). It provides:

**1. Domain Registration:** Buy and register domain names directly in AWS (`mycompany.com` → Route 53 becomes the registrar)

**2. Hosted Zones:** A Route 53 Hosted Zone contains DNS records for one domain:

- Public Hosted Zone: answers DNS queries from the internet
- Private Hosted Zone: answers DNS queries only within associated VPCs (internal service names)

**3. Health Checks:** Route 53 can monitor endpoint health (HTTP/HTTPS/TCP on any port). Records marked unhealthy are excluded from DNS responses — effectively DNS-based failover.

**4. Routing Policies:**

| Policy            | Behavior                                                             | Use Case                                         |
| ----------------- | -------------------------------------------------------------------- | ------------------------------------------------ |
| Simple            | Returns single record (or multiple IPs round-robin)                  | Single server, basic distribution                |
| Weighted          | Returns record proportional to assigned weights                      | A/B testing; gradual traffic migration (10%/90%) |
| Latency-based     | Returns record for region with lowest measured latency to client     | Multi-region; closest = fastest                  |
| Failover          | Returns primary; switches to secondary if primary health check fails | Active-passive DR                                |
| Geolocation       | Returns different record based on client's geographic location       | Data residency; localized content                |
| Geoproximity      | Returns based on geographic proximity, adjustable bias               | Fine-grained geographic distribution             |
| IP-based          | Returns based on client's IP CIDR ranges                             | Direct traffic from specific networks            |
| Multivalue Answer | Returns up to 8 healthy records, randomly; client chooses            | Simple L4 load balancing without ALB             |

---

### Route 53 ALIAS Record — AWS-Specific Innovation

Traditional DNS doesn't allow CNAME at zone apex (`example.com` cannot be a CNAME). But you often want `example.com` (not `www.example.com`) to point to an ALB or CloudFront.

AWS invented the **ALIAS record** to solve this:

```
example.com   ALIAS   alb-123456.us-east-1.elb.amazonaws.com
```

ALIAS record differences from CNAME:

- Allowed at zone apex (CNAME is not)
- Route 53 resolves the ALIAS target internally — returns the actual IPs, not the CNAME chain
- **Free** — no charge for ALIAS queries to AWS resources (ALB, CloudFront, S3, other Route 53 records)
- Automatically reflects changes in the target's IP (if ALB adds/removes IPs, ALIAS stays accurate)

**Never use**: A record pointing to ALB IP directly — ALBs change IPs without notice. Always use ALIAS or CNAME to ALB DNS name.

---

### AWS VPC DNS — Internal Resolution

Every VPC has a built-in DNS resolver at `VPC_CIDR_base + 2`:

- VPC CIDR: 10.0.0.0/16 → VPC DNS resolver: 10.0.0.2
- VPC CIDR: 172.31.0.0/16 → VPC DNS resolver: 172.31.0.2
- Also accessible at `169.254.169.253` (link-local within any VPC)

**VPC DNS settings:**

- `enableDnsSupport` = true: VPC uses Amazon's DNS resolver
- `enableDnsHostnames` = true: EC2 instances get internal DNS hostnames (`ip-10-0-1-5.us-east-1.compute.internal`)
- Both must be true for EC2 instances to have resolvable hostnames

**Route 53 Resolver (Hybrid DNS):**
For hybrid cloud (on-premises + AWS), Route 53 Resolver provides:

- **Inbound Endpoints**: Allow on-premises DNS servers to forward queries for AWS resources to Route 53 Resolver
- **Outbound Endpoints**: Allow VPC resources to forward DNS queries for on-premises domains to on-premises DNS servers
- **Forwarding Rules**: "For queries to corp.internal.mycompany.com, forward to 192.168.1.53 (on-prem DNS)"

This enables seamless name resolution across hybrid networks — an EC2 instance can resolve `payments.corp.internal.mycompany.com` (on-prem resource) and `rds.us-east-1.amazonaws.com` (AWS resource) with the same DNS configuration.

---

## SECTION 8 — Interview Preparation

### BEGINNER LEVEL

**Q1: What is DNS and why is it necessary?**

_Answer:_ DNS (Domain Name System) is the internet's distributed directory service that translates human-readable domain names (like `www.google.com`) into machine-readable IP addresses (like `172.217.14.238`). It's necessary because: (1) IP addresses are difficult for humans to memorize and use directly, (2) DNS allows server IP addresses to change without affecting users — the domain name stays constant while the underlying IP can be updated, and (3) DNS enables sophisticated traffic management — one domain name can map to different IPs based on geography, health status, or load balancing policies. Without DNS, the web would require bookmarking numeric IP addresses and any server change would break all existing links.

---

**Q2: What is the difference between an A record and a CNAME record?**

_Answer:_ An **A record** maps a domain name directly to an IPv4 address: `api.example.com → 93.184.216.34`. An **AAAA record** does the same for IPv6. A **CNAME record** creates an alias — it maps one domain name to another domain name: `www.example.com → example.com`. The resolver then resolves `example.com` (following the CNAME chain) until it reaches an A record with an actual IP.

Key restrictions: (1) CNAMEs cannot be used at the zone apex — you cannot have `example.com CNAME something.else.com` because RFC prohibits mixing CNAME with other records (especially MX and NS records which are needed at the root). Workaround: AWS Route 53 ALIAS records. (2) CNAME chains add resolution latency — each link requires another DNS lookup. Limit chains to 1–2 levels.

---

**Q3: What is DNS TTL and how does it affect website migrations?**

_Answer:_ DNS TTL (Time To Live) is the number of seconds a DNS resolver should cache a DNS response before re-querying the authoritative name server. TTL=300 means resolvers keep the cached IP for 5 minutes. During migrations, TTL matters critically: if you change a DNS record with TTL=86400 (24 hours), clients with cached entries keep connecting to the old server for up to 24 hours — your migration won't take effect immediately for all users. Best practice: reduce TTL to 60 seconds 24–48 hours before the migration (giving old high-TTL caches time to expire). Execute migration. Increase TTL back to 300+ after the migration is confirmed stable.

---

### INTERMEDIATE LEVEL

**Q4: Explain Route 53 routing policies and when you'd use latency-based vs geolocation routing.**

_Answer:_ **Latency-based routing** returns the DNS record pointing to the region with the lowest measured network latency for the client's location. It optimizes for performance — client gets the fastest server regardless of geographic borders. A client in Mumbai might be routed to `ap-southeast-1` (Singapore) if latency there is lower than `ap-south-1` (Mumbai).

**Geolocation routing** returns records based on the geographic origin of the DNS query. A client in Germany always gets the EU server; a client in Japan always gets the AP server — regardless of latency.

Use **latency-based** when: your primary goal is performance (gaming, real-time APIs, streaming).
Use **geolocation** when: data residency matters legally (GDPR requires EU user data stays in EU); you want localized content (German-language site for German users); you need regulatory compliance by region.

A common production pattern: combine both — geolocation for data residency compliance, with multiple servers per region using latency-based routing within the allowed region.

---

**Q5: What is a Route 53 Private Hosted Zone and when would you use it?**

_Answer:_ A Route 53 Private Hosted Zone (PHZ) is a container of DNS records that only resolves within one or more associated VPCs. It's invisible to the public internet. Use cases:

1. **Internal service naming:** `payments.internal.mycompany.com → 10.0.2.50` — only resolvable from within the VPC. Microservices call each other by meaningful names instead of IPs.

2. **Override public DNS:** You can have a PHZ for `api.mycompany.com` that returns private IPs (10.0.x.x) for internal callers, while the public hosted zone returns public IPs. Split-horizon DNS — same name resolves differently based on whether you're inside or outside the VPC.

3. **RDS and ELB internal names:** RDS endpoint names (`mydb.cluster-xxxxx.us-east-1.rds.amazonaws.com`) are resolvable within the VPC via the VPC DNS resolver — this works because Route 53 automatically registers these names in the VPC's private DNS namespace.

4. **Multi-VPC private DNS:** Associate a PHZ with multiple VPCs (including cross-account, via RAM sharing) — all associated VPCs can resolve the private names.

---

**Q6: How does DNS-based failover work and what are its limitations?**

_Answer:_ Route 53 failover routing uses health checks to remove unhealthy endpoints from DNS responses. Configuration: Primary record + Secondary record, both pointing to different IPs. Route 53 health checks the primary (HTTP GET every 10–30 seconds). If the primary fails checks consecutively, Route 53 stops returning the primary IP — clients get the secondary IP on next DNS query.

**Limitations:**

1. **TTL lag:** Even after failover triggers, clients with cached DNS continue connecting to the failed primary for up to TTL seconds. At TTL=300, some users see 5 minutes of failure before getting the secondary IP.
2. **DNS-level only:** DNS failover switches which IP is returned; it doesn't know about application-layer failures (DB connection errors, 500 responses). Health checks must be configured to test meaningful endpoints.
3. **Not instant:** Health check failure threshold (default 3 consecutive fails × 10s interval = 30 seconds) + DNS TTL = minimum 30–300 seconds of potential downtime.
4. **Client DNS caching bypass:** Mobile apps and non-browser clients sometimes cache DNS aggressively, ignoring TTL. Failover doesn't help clients that cached the wrong IP and refuse to re-query.

**For <5 second failover:** Use load balancer health checks (ALB/NLB) + AWS Global Accelerator — not DNS-level failover.

---

### ADVANCED SYSTEM DESIGN LEVEL

**Q7: Design the DNS architecture for a global SaaS platform that must serve 100M users across 6 AWS regions with data residency compliance (EU data stays in EU, APAC data stays in APAC) and <10ms DNS resolution time.**

_Ideal Thinking Approach:_

**Requirements breakdown:**

- 100M users = massive DNS query volume (assume 500M DNS queries/day = ~5,800 queries/second peak)
- 6 regions: us-east-1, us-west-2, eu-west-1, eu-central-1, ap-southeast-1, ap-northeast-1
- Data residency: DNS must route EU users only to EU regions, APAC to APAC
- <10ms DNS resolution: impossible with full recursive resolution (takes 50–150ms); must use caching + proximity

**Layer 1 — Route 53 Geolocation Routing for Data Residency:**

```
app.mycompany.com:
  Europe (EU) → eu-west-1 ALB DNS (ALIAS)
  Asia Pacific (AP) → ap-southeast-1 ALB DNS (ALIAS)
  Default → us-east-1 ALB DNS (ALIAS)
```

Geolocation ensures EU users always route to EU servers. This is the compliance requirement non-negotiable.

**Layer 2 — Latency Routing Within Regions:**
For each region, use latency-based routing across AZ-specific endpoints for performance optimization within the compliant region.

**Layer 3 — Achieving <10ms DNS:**
Full recursive resolution = 50–150ms. To achieve <10ms:

- Route 53 is globally distributed via anycast — nearest Route 53 edge serves responses from edge cache (not full recursive resolution)
- Route 53 resolves from ~220 edge locations (via Route 53 Resolver infrastructure)
- With geolocation, Route 53 edge in Frankfurt serves EU users → DNS answer in <5ms
- TTL=60 for geolocation records: low enough for quick failover, high enough for caching

**Layer 4 — Health Checks and Failover:**
Each regional ALB endpoint has Route 53 health checks. If eu-west-1 ALB fails: Route 53 automatically falls back to eu-central-1. Both are EU-compliant. Never fall back to US or APAC for EU-tagged users.

**Layer 5 — Private DNS for Inter-Service:**
Each VPC has Route 53 Private Hosted Zones for internal microservice naming. Services call `payments.internal.eu.mycompany.com` — resolves to internal load balancer. Never traverse public DNS for internal traffic.

This architecture is used by Spotify, SAP, and enterprise SaaS companies with strict data residency requirements.

---

**Q8: A developer reports that after deploying a DNS change (A record update), 30% of users still see the old server after 1 hour. Why and how do you fix it for future changes?**

_Ideal Thinking Approach:_

**Why 30% see old server after 1 hour:**

1. **Previous TTL was 3600s (1 hour):** The old record had 1-hour TTL. Users whose resolvers cached it at the start of the hour still have 3,600 seconds of cache remaining when you made the change. They won't re-query until their cache expires. Some will cache for exactly 1 hour; others cached it 59 minutes ago — they'll see old IP for 59 more minutes.

2. **ISP resolvers ignore TTL:** Some ISPs override TTL and cache longer than specified (illegal per RFC but common). Clients behind these ISPs see old records indefinitely.

3. **Browser DNS cache:** Chrome and Firefox have their own DNS caches separate from OS DNS. They may cache the old IP even after OS cache expires.

4. **Application-level DNS caching:** Java applications with direct DNS resolution cache results in JVM for 30 seconds by default (`networkaddress.cache.ttl=30`). Long-lived server processes may cache DNS results for their entire lifetime. Some ORM connection pools cache DB hostname resolution.

**Fix for future changes:**

1. **Reduce TTL 48 hours before migration:** Change TTL to 60s. Wait 48 hours (2× the old TTL maximum) ensuring all caches have expired with the low TTL. Then make your change — propagation is now 60 seconds.
2. **Monitor DNS propagation:** Use dnschecker.org to verify propagation globally before switching.
3. **Force application DNS refresh:** Restart long-lived processes post-migration (JVM, Node.js with cached DNS, etc.)
4. **Use ALIAS records for AWS resources:** AWS ALIAS records don't have caching at the Route 53 level — changes are near-instant for ALIAS targets.
5. **Health check for validation:** Set up Route 53 health check on new IP before migrating. Only cut over when health check is green.

---

## File Summary

This file covered real-world DNS applications and AWS implementation:

- Library/franchise analogies: DNS as delegation hierarchy, not one central database
- GitHub Pages custom domain: CNAME chaining, TXT verification, IP abstraction
- DNS as critical abstraction: zero-downtime migrations, blue/green deploys, microservice discovery
- Route 53 routing policies: Simple, Weighted, Latency, Failover, Geolocation, Multivalue
- ALIAS record: Route 53's apex-safe CNAME alternative; free queries; auto-reflects target IP changes
- VPC DNS resolver (VPC+2); Private Hosted Zones; Route 53 Resolver for hybrid DNS
- DNS-based failover limitations: TTL lag, client caching, health check delay
- Global SaaS DNS with geolocation for compliance + <10ms via Route 53 edge caching
- DNS change propagation debugging: TTL pre-reduction, ISP override, JVM caching

**Continue to File 03** for AWS Certification Focus, Comparison Tables, Quick Revision, and the Architect Thinking Exercise.
