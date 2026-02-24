# DNS Resolution Flow (Step by Step) — Part 2 of 3

### Topic: Real-World Impact, AWS Resolver Architecture, and Interview Mastery

**Series:** Networking Fundamentals → System Design → AWS Solutions Architect
**Sections Covered:** 5, 6, 7, 8

---

## SECTION 5 — Real-World Examples

### Analogy 1 — The Restaurant Maître d' and the Chain of Bookings

A 5-star restaurant has a central reservation system, but it doesn't know individual table availability. When you call:

1. You call the central line (recursive resolver)
2. Central line says "let me check" — asks the head booking desk for fine dining (root)
3. Head booking desk says "call the Italian wing manager" (TLD)
4. Italian wing manager says "call Luigi, the host for tables 1-50" (authoritative NS)
5. Luigi says "Table 12 is free at 7pm — confirmed" (A record answer)
6. Central line relays back to you AND writes it in today's log

Tomorrow, if you call back and ask about the same table at 7pm, the central line checks its log first — instant answer. No chain of calls needed.

The key: the central line (resolver) owns the cache. The original sources (Luigi/auth NS) never push updates — they just answer when asked, and TTL controls how long the cached answer stays valid.

### Analogy 2 — Relay Race with Batons of Knowledge

DNS is a relay race where each runner carries a baton (referral/delegation) to the next runner, but only the final runner (authoritative NS) carries the actual prize (IP address).

- Root server = the starter gun — tells you which lane the TLD runner is in
- TLD server = the first runner — passes the baton (NS records) pointing to the domain's own team
- Authoritative server = the anchor runner — crosses the finish line with the actual IP

The resolver just coordinates — it waits at the finish line, sending runners back and forth until the anchor arrives.

### Real Software Example — Chrome's DNS Prefetching

Chrome doesn't wait for you to click a link before resolving its DNS. It prefetches DNS for:

- All links visible on the current page (anchor tags with href)
- Domains found in resources loaded on the page (fonts, scripts, images)
- Domains you've visited recently that predict your next navigation

**How it works technically:**

```
User lands on news.example.com
Chrome renderer finds: <a href="https://video.partner.com/watch?id=123">
Chrome makes LOW-PRIORITY DNS query for video.partner.com in background
  → resolver returns: 198.51.100.10 (cached for 60s internally by Chrome)
User clicks link → Chrome already has the IP → TCP connect begins immediately
  → ~100ms faster user experience (DNS cost eliminated from click path)
```

Chrome maintains its own DNS cache (`chrome://net-internals/#dns`) separate from the OS. This cache uses a **60-second TTL** cap regardless of the DNS record's TTL, preventing Chrome from holding stale addresses too long.

**Impact on production:** when a developer uses `chrome://net-internals/#dns` → Clear host cache, Chrome flushes its own internal DNS cache, but the OS cache, the router cache, and the ISP resolver cache are unaffected.

---

## SECTION 6 — Why This Matters for System Design

### Problem 1 — DNS as a Hidden Performance Bottleneck

In microservice architectures, each internal service call often uses a hostname:

```
Order Service → calls → payment-service.internal.svc.cluster.local
Payment Service → calls → fraud-db.rds.internal.us-east-1.amazonaws.com
```

Each hostname lookup adds latency. Multiply by:

- 10 microservices each making 5 external calls per request
- Cold DNS cache (e.g., pod just started, 5-min container TTL expired)
- Result: 50 DNS lookups × 5ms each = **250ms hidden overhead per request**

**Solutions:**

1. Use connection pooling with long-lived connections (hostname resolved once on connect, reused for thousands of requests)
2. Keep TTL at 60–300s for internal services — short enough to enable fast failover, long enough to avoid constant re-resolution
3. Use AWS PrivateLink for RDS endpoints — stable private IP, eliminates DNS resolution overhead for cold connections

### Problem 2 — DNS as a Single Point of Failure

Your app reaches out to `api.payments.provider.com`. Your service's SLA is 99.99%. But:

- If the provider's authoritative NS goes down
- And your resolver's cache has expired
- Your app suddenly fails to resolve the hostname — 100% failure for that dependency

**Design mitigations:**

- Cache IP addresses in your own application configuration as fallback (circuit breaker with hardcoded IP)
- Use multiple authoritative NS (Route 53 always has 4 NS servers per hosted zone across different TLDs)
- Implement DNS-level health checks — if authoritative NS is slow, fall back to secondary resolver
- Set application-level DNS cache warmup during startup, before accepting traffic

### Problem 3 — DNS Amplification DDoS Attack

DNS amplification exploits three properties:

1. DNS uses UDP (source IP is easily forged/spoofed)
2. DNS queries are small (32 bytes)
3. DNS responses can be large (3,000+ bytes for DNSSEC-enabled records)

**Attack flow:**

```
Attacker spoofs source IP → Victim's IP (e.g., 1.2.3.4)
Attacker sends: UDP query to open resolver (8.8.8.8)
  "Give me ALL records for attackzone.com" (ANY query)
  Source: forged to 1.2.3.4
Open resolver responds to 1.2.3.4 with 3000-byte response
  Amplification ratio: 3000/32 = 93x
Attacker sends 1 Gbps of spoofed queries
  Victim receives: 93 Gbps of DNS response traffic
```

**AWS defenses:** Route 53 automatically blocks reflection attacks. AWS Shield Standard (free) mitigates Layer 3/4 attacks. CloudFront + Shield Advanced provides DDoS protection at the edge.

**Why ANY queries are gone:** Major resolvers (Cloudflare, Google, Route 53) block or ignore DNS ANY queries today to prevent amplification. RFC 8482 officially deprecated them (2019).

---

## SECTION 7 — AWS Mapping

### Route 53 Resolver Architecture

Every VPC gets a built-in Route 53 Resolver at `VPC_CIDR + 2`:

- VPC CIDR 10.0.0.0/16 → Resolver at `10.0.0.2`
- This resolver handles all DNS queries from EC2 instances, Lambda, ECS, EKS
- It knows about Route 53 Private Hosted Zones associated with your VPC
- It resolves Route 53 Public Hosted Zones and public internet domains recursively

```
                        ┌─────────────────────────────────┐
                        │              AWS VPC             │
                        │                                  │
  EC2/Lambda ──────────►│  Route 53 Resolver (10.0.0.2)   │
                        │         ┌────────────┐           │
                        │         │ PHZ: rds.  │           │
                        │         │ internal   │           │
                        │         └────────────┘           │
                        │              │                   │
                        └──────────────┼───────────────────┘
                                       │
                              ┌────────┴────────┐
                              │                 │
                     Route 53 Public     Internet recursive
                     Hosted Zones        resolution (root/TLD/auth)
```

### Route 53 Resolver DNS Firewall

You can create rules to **block DNS queries for malicious domains** at the resolver level — before the query even leaves your VPC:

```
Rule example:
  Action: BLOCK
  Domain list: AWS-managed-threat-intel-list (updated by AWS Managed Lists)
  Response: NXDOMAIN (return "domain doesn't exist")

Effect: Malware on an EC2 instance tries to contact C2 server.
  EC2 → 10.0.0.2 (Resolver): "What is c2-server.malicious.io?"
  Resolver checks DNS Firewall rules
  → BLOCKED → returns NXDOMAIN
  Malware cannot reach C2 server → lateral movement prevented
```

**DNS Firewall rule groups:** can use AWS-curated lists (updated automatically) or custom domain lists.

### Route 53 Resolver for Hybrid DNS (On-Premises Integration)

When you have on-premises infrastructure and AWS:

**Inbound Endpoint (On-prem→AWS):**

- Creates Route 53 Resolver endpoints in your VPC with ENIs
- On-prem DNS servers forward queries for internal AWS domains to these IPs
- On-prem server can resolve `myapp.internal.aws.mycompany.com` → IP of EC2 in VPC

**Outbound Endpoint (AWS→On-prem):**

- Creates resolver endpoints for forwarding rules
- EC2 in VPC queries `ldap.corp.mycompany.com` → forwarded to on-prem DNS server
- Enables EC2 to access Active Directory, on-prem databases by hostname

```
ON-PREMISES                         AWS VPC
──────────                         ──────────
On-prem DNS ─── Inbound Endpoint ──► Route 53
server       (forward to ENI IPs)    Resolver
                                       │
EC2 traffic  ◄── Outbound Endpoint ───┘
response        (forward to on-prem)   │
                                   On-prem DNS
```

### Route 53 Resolver Query Logging

Enable query logging to CloudWatch Logs or S3:

- Every DNS query made from your VPC is logged
- Log includes: query name, type, response code, source IP, timestamp
- Use for: security audits, detecting DNS exfiltration, debugging connectivity issues

**DNS Exfiltration signature in logs:**

```
# Normal traffic:
source_ip=10.0.1.5  query=api.payments.com  type=A  response=NOERROR
source_ip=10.0.1.5  query=s3.amazonaws.com  type=A  response=NOERROR

# Exfiltration (data encoded in DNS subdomain):
source_ip=10.0.1.5  query=c3Vwc3VwJHN1cHN1cA==.c2.evil.io  type=A
source_ip=10.0.1.5  query=dGhpcyBpcyBzdG9sZW4=.c2.evil.io  type=A
# Base64 encoded data in subdomains → queries to attacker's authoritative NS
# DNS traffic exits even if web port 80/443 is blocked → bypasses firewall
```

---

## SECTION 8 — Interview Q&As

### Beginner Questions

**Q1: What is the difference between a recursive resolver and an authoritative name server?**

A: A **recursive resolver** is a caching intermediary that resolves DNS on behalf of clients. When you query DNS, you always reach the recursive resolver first (your ISP's, or 8.8.8.8). It handles the full resolution chain — querying root, TLD, and authoritative servers — and caches results. You configure it in `/etc/resolv.conf` or via DHCP.

An **authoritative name server** is the source of truth for a specific domain. It doesn't cache or resolve other domains — it holds the zone file for `example.com` and authoritatively answers queries about records in that zone. You configure your authoritative NS when you buy a domain and point it to Route 53 (or Cloudflare, etc.).

**Q2: Why does DNS use UDP instead of TCP?**

A: DNS queries are small, connectionless, and tolerance for a single retry is fine. UDP eliminates TCP's 3-way handshake overhead — DNS resolution latency would roughly double with TCP for every cache-miss query. DNS was designed for sub-10ms responses at scale; TCP overhead is unacceptable.

TCP IS used when responses exceed 512 bytes (zone transfers, DNSSEC), when the server sets the truncated (TC) bit, or for DNS over TLS (DoT). The DNS spec requires clients to retry with TCP if they receive a truncated UDP response.

**Q3: What is a DNS TTL and who controls it?**

A: TTL (Time to Live) is a per-record field in DNS, set by the domain owner on their authoritative name server. It tells resolvers, OSes, and browsers how long to cache the record before re-querying.

The domain owner controls it. Cloudflare, Route 53, and other DNS providers let you set TTL per record. The cached copies (resolver, OS) honor the TTL — they can't extend it, they just keep the record until TTL expires.

You can't force a remote resolver to expire a cache entry early. Your only lever is setting a short TTL BEFORE you need flexibility.

---

### Intermediate Questions

**Q4: Explain negative caching and a scenario where it caused a production incident.**

A: Negative caching stores the fact that a DNS name or record does NOT exist (NXDOMAIN response). The resolver caches this for the SOA record's minimum TTL field — typically 300–900 seconds.

Production incident scenario:

```
09:00 — Team deploys new service: newapi.payments.internal.com
        DNS record not yet created (infra team is busy)
09:01 — Load tests hit newapi.payments.internal.com → get NXDOMAIN
        Resolver caches NXDOMAIN for 600 seconds
09:08 — Infra team creates DNS record → actual IP now answerable
09:09 — QA team retests → STILL gets NXDOMAIN (cached until 09:11)
        QA thinks deployment is broken, opens P1 incident
09:11 — Cache expires → NXDOMAIN cache cleared → query hits auth NS → works
```

Prevention: create DNS records BEFORE deploying the services that use them. "DNS first, service second" is a real SRE principle.

**Q5: What is DNS amplification and how do AWS customers protect against it?**

A: DNS amplification is a DDoS reflection attack. The attacker sends small UDP DNS queries to open resolvers (or authoritative NS servers) with the victim's IP as the forged source. The resolver sends large responses to the victim — amplifying small attack traffic into massive response floods.

Key enablers: UDP spoofing (no connection verification), large response sizes (ANY queries can be 3000+ bytes), open resolvers that answer without authentication.

AWS protections:

- Route 53 service-level mitigations against reflection abuse
- AWS Shield Standard (free, automatic) absorbs SYN floods and UDP reflection at the network edge
- AWS Shield Advanced: provides 24/7 DDoS response team + cost protection for traffic spikes caused by DDoS
- CloudFront + WAF: filters malformed requests before origin
- VPC Route 53 Resolver blocks ANY queries by default

**Q6: How does split-horizon DNS work and when would you use it?**

A: Split-horizon DNS serves different answers for the same hostname depending on the query source — internal clients get internal IPs, external clients get public IPs.

Example: `api.yourapp.com`

- External world queries → get `203.0.113.10` (public ALB IP)
- Internal VPC queries → get `10.0.2.50` (private ALB IP, traffic stays inside VPC)

How it's implemented:

- Route 53 Private Hosted Zone: `api.yourapp.com` A → `10.0.2.50` (only VPC-internal)
- Route 53 Public Hosted Zone: `api.yourapp.com` A → `203.0.113.10` (public internet)
- VPC-associated queries hit PHZ first → private answer
- Public queries hit the public zone → public answer

When to use:

- Cost optimization: internal traffic to ALB doesn't cross internet
- Security: internal services never expose their actual private IPs publicly
- Performance: internal traffic routes over AWS backbone, not internet

---

### Advanced System Design Questions

**Q7: Design a globally resilient DNS architecture for a fintech company with services on AWS, Azure, and 2 on-premises data centers. The company requires <10ms DNS resolution globally and zero DNS-related downtime.**

A: This is a multi-cloud, hybrid DNS design problem. Here's the architecture:

**Authoritative Layer (source of truth):**

- Primary: AWS Route 53 (global, 4+ NS servers across TLDs .awsdns-01.com, .awsdns-02.net, .awsdns-03.org, .awsdns-04.co.uk)
- No single SPOF at the authoritative layer — Route 53 has 100% uptime SLA

**Global Caching Strategy (<10ms target):**

- Route 53 uses anycast routing — queries route to nearest PoP (200+ globally)
- CloudFront DNS caching at edge — all Route 53 public records near users
- Short TTL = 60s on health-check-monitored records
- Long TTL = 3600s on stable infrastructure records (blob storage, static assets)

**Hybrid DNS Integration:**

- Route 53 Resolver Inbound Endpoints: on-prem DNS forwards `*.aws.corp.com` → Inbound Endpoint IP → Route 53 PHZ
- Route 53 Resolver Outbound Endpoints: EC2 queries `*.azure.corp.com` or `*.dc1.corp.com` → Outbound Endpoint → on-prem DNS → Azure DNS

**Zero-Downtime:**

- All service records backed by Route 53 health checks with failover routing
- Primary: AWS ALB → Secondary: Azure Traffic Manager → Tertiary: DC1 IP
- Health check: HTTP health endpoint, 30s interval, 3 failures = failover, 2 successes = failback

**Azure DNS integration:**

- Azure Private DNS zones for internal Azure resources
- Azure DNS forwarding zone for `*.aws.corp.com` → Route 53 Resolver Inbound IP

**Q8: A service you own sees intermittent connection failures that appear to correlate with ~90-minute intervals. All logs show successful responses, but suddenly 3-5% of requests get "name resolution failed" for 30 seconds before recovering. How do you diagnose and fix this?**

A: The 90-minute interval is a critical clue — it matches a TTL of 5400 seconds. Here's the diagnostic process:

**Step 1 — Identify TTL:**

```bash
dig +nocmd api.dependency.com A +noall +answer +ttl
# Check what TTL is currently being served
# 90 minutes = 5400s → confirms TTL hypothesis
```

**Step 2 — Check application DNS cache:**

- JVM applications: `InetAddress.getByName()` caches forever by default, or per `networkaddress.cache.ttl` security property. If JVM cached a bad IP during a previous TTL cycle, it'll fail for exactly the TTL duration.
- Is this a Node.js service? Node.js has NO internal DNS cache — every hostname call hits the OS resolver.
- Connection pools: if pool was created with an old IP and the connection timed out, pool will try to reconnect → resolves new IP → works again after ~30s (pool reconnection timeout)

**Step 3 — Check the dependency's DNS change pattern:**

```bash
# Query DNS directly (bypass all caches) at various intervals
while true; do
  dig +short @8.8.8.8 api.dependency.com A;
  sleep 60;
done
```

Are IPs changing every 90 minutes? That's Elastic IP rotation or ALB IP rotation.

**Fix options:**

1. If JVM: set `networkaddress.cache.ttl=30` in JVM security properties (or `sun.net.inetaddr.ttl=30` as system property)
2. If connection pool issue: implement retry logic with fresh DNS resolution on connection failure
3. If dependency's TTL is problematic: request they lengthen TTL or use a stable CNAME
4. Add circuit breaker: detect 3+ consecutive NXDOMAIN/resolution-failures → open circuit → serve cached fallback → retry with exponential backoff

---

**Continue to File 03** for AWS SAA exam traps, 5 comparison tables, quick revision memory tricks, and the architect exercise: detecting and stopping a DNS exfiltration attack on your AWS infrastructure.
