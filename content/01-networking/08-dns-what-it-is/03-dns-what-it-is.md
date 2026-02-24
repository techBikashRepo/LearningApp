# DNS — What It Is — Part 3 of 3

### Topic: AWS Certification Focus, Comparison Tables, Quick Revision, Architect Exercise

**Series:** Networking Fundamentals → System Design → AWS Solutions Architect
**Audience:** 14-Year Experienced Full-Stack Developer → Becoming an Architect
**Sections Covered:** 9, 10, 11, 12

---

## SECTION 9 — AWS & Certification Focus

### AWS SAA Exam — DNS Must-Know Facts

**Route 53 Hosted Zones:**

- A **Public Hosted Zone** serves DNS for internet-facing domains
- A **Private Hosted Zone** serves DNS only within associated VPCs (internal naming)
- You are **charged per hosted zone per month** (currently $0.50/month per hosted zone after the first 25)
- You can associate a PHZ with VPCs in **different accounts** (via CLI/SDK — cross-account PHZ association)

**Route 53 Health Checks:**

- Route 53 sends health check requests from multiple locations globally
- Health check can verify: HTTP response code (200 = healthy), string in response body, TCP connection
- A record is only returned in DNS responses if the associated health check is passing
- **Exam trap:** Health checks for private resources (EC2 in private subnet) cannot be reached directly by Route 53 health checkers (they come from the internet). Solution: health check a CloudWatch alarm that monitors the private resource, then configure Route 53 to evaluate the CloudWatch alarm status.

**VPC DNS Settings (common exam scenario):**

- `enableDnsSupport = true`: VPC uses Route 53 Resolver at VPC+2 address
- `enableDnsHostnames = true`: EC2 instances receive public DNS hostnames (only works if enableDnsSupport is also true)
- **Exam scenario:** "EC2 instances cannot resolve each other's hostnames" → Check both settings are true

**Route 53 Resolver Rules (Hybrid DNS):**

- Forward rules: Forward specific domains to on-prem DNS servers
- System rules: Override default behavior for specific domains
- Auto-defined rules: AWS handles `amazonaws.com`, EC2 internal hostnames automatically
- **Exam scenario:** "On-prem servers need to resolve RDS endpoint names" → Create Route 53 Resolver Inbound Endpoint; configure on-prem DNS to forward `amazonaws.com` queries to the inbound endpoint IP

---

### Exam Traps and Edge Cases

**Trap 1 — CNAME vs ALIAS at zone apex:**
Cannot use CNAME for `example.com` (zone apex). Must use Route 53 ALIAS record for ALB, CloudFront, S3 website endpoints, or another Route 53 record.

- **Exam question:** "You need example.com to point to your ALB. Which record type?" → ALIAS (not A, not CNAME)

**Trap 2 — Route 53 does NOT cache TTL for Private Hosted Zones:**
PHZ records are always served fresh from Route 53. Client-side caching still applies.

**Trap 3 — Route 53 is global (not regional):**
Route 53 is NOT deployed per-region — it's a global service. You don't select an AWS region when creating a hosted zone (it appears in us-east-1 in console but serves globally).

**Trap 4 — Geolocation vs Geoproximity:**

- Geolocation: Route based on exact country/continent classification
- Geoproximity: Route based on geographic distance, with optional bias (increase/decrease effective area of a region)
- Geolocation requires a "Default" record for traffic from locations not explicitly defined

**Trap 5 — DNS propagation after NS record change:**
Changing the NS records (delegating DNS to a new provider) takes up to 48 hours because NS records have very high TTLs (typically 172800s = 48 hours) set by the TLD servers. This is not under your control.

---

### Route 53 Pricing Notes (Exam Awareness)

- ALIAS queries to AWS resources: **FREE** (S3, CloudFront, ALB, other Route 53 records)
- Standard queries: $0.40 per million queries (first 1 billion)
- Health checks: ~$0.50/month per health check (basic HTTP/HTTPS/TCP)
- Latency-based, geolocation, failover, multivalue routing: extra charge per query on top of standard
- Hosted zones: $0.50/month per zone (first 25 free)

---

## SECTION 10 — Comparison Tables

### Table 1: DNS Record Types

| Record | Maps                  | Example                                    | Zone Apex? | Notes                                      |
| ------ | --------------------- | ------------------------------------------ | ---------- | ------------------------------------------ |
| A      | Domain → IPv4         | `api.ex.com → 93.184.216.34`               | Yes        | Most common                                |
| AAAA   | Domain → IPv6         | `api.ex.com → 2606:...`                    | Yes        | IPv6 equivalent of A                       |
| CNAME  | Domain → Domain       | `www.ex.com → ex.com`                      | **No**     | Cannot mix with other records at same name |
| ALIAS  | Domain → AWS DNS      | `ex.com → alb.us-east-1.elb.amazonaws.com` | **Yes**    | Route 53 only; free queries; auto-resolves |
| MX     | Domain → Mail server  | `ex.com → 10 mail.ex.com`                  | Yes        | Priority-ordered; CNAME target not allowed |
| TXT    | Domain → Text         | `ex.com → "v=spf1 ..."`                    | Yes        | SPF, DKIM, domain verification             |
| NS     | Domain → Name servers | `ex.com → ns1.awsdns-01.com`               | Yes        | Delegation; do NOT modify without care     |
| SOA    | Zone metadata         | Serial, TTLs, admin email                  | Yes        | Auto-managed by Route 53                   |
| PTR    | IP → Domain           | `34.216.184.93.in-addr.arpa → ex.com`      | N/A        | Reverse DNS; used by email servers         |
| SRV    | Service location      | `_sip._tcp.ex.com → priority port host`    | No         | Used by SIP, XMPP, some databases          |
| CAA    | CA authorization      | `ex.com → 0 issue "letsencrypt.org"`       | Yes        | Restricts which CAs can issue certs        |

---

### Table 2: Route 53 Routing Policies Compared

| Policy       | Returns                                         | Health Check Support | Use Case                                     |
| ------------ | ----------------------------------------------- | -------------------- | -------------------------------------------- |
| Simple       | Single record or all IPs (random client choice) | No                   | Single endpoint; basic                       |
| Weighted     | IP proportional to weight value                 | Yes                  | A/B testing; canary; gradual migration       |
| Latency      | Record with lowest RTT to client                | Yes                  | Performance optimization; multi-region       |
| Failover     | Primary unless unhealthy, then secondary        | **Required**         | Active-passive disaster recovery             |
| Geolocation  | Record matching client's country/continent      | Yes                  | Data residency; localized content            |
| Geoproximity | Based on distance + bias                        | Yes                  | Fine-grained geographic control              |
| IP-based     | Based on client CIDR                            | Yes                  | Known network routing (ISP, corporate)       |
| Multivalue   | Up to 8 random healthy records                  | Yes                  | Simple LB without ALB; improves availability |

---

### Table 3: Public Hosted Zone vs Private Hosted Zone

| Dimension                 | Public Hosted Zone             | Private Hosted Zone                             |
| ------------------------- | ------------------------------ | ----------------------------------------------- |
| Scope                     | Answers globally from internet | Answers only within associated VPCs             |
| Use case                  | Public-facing websites, APIs   | Internal service names, split-horizon DNS       |
| Visibility                | Anyone can query               | Only VPC resources                              |
| Can override public DNS   | No                             | Yes — same name resolves differently inside VPC |
| Cost                      | $0.50/month + query charges    | $0.50/month + query charges                     |
| Cross-account association | N/A                            | Yes — via CLI/SDK (not console)                 |
| VPC prerequisites         | None                           | `enableDnsSupport = true` on VPC                |

---

### Table 4: DNS vs Load Balancer for Traffic Distribution

| Dimension          | DNS Round Robin                                     | Load Balancer (ALB/NLB)                |
| ------------------ | --------------------------------------------------- | -------------------------------------- |
| Layer              | Layer 3/DNS                                         | Layer 4 / Layer 7                      |
| Health awareness   | Not by default (dead IPs still returned)            | Yes — health checks per target         |
| Sticky sessions    | No                                                  | Yes (ALB cookie-based)                 |
| SSL termination    | No                                                  | Yes (ALB)                              |
| Path-based routing | No                                                  | Yes (ALB rules)                        |
| Failover speed     | TTL-bound (30s–5min)                                | Seconds (ELB health check interval)    |
| Cost               | Free (Route 53 queries)                             | Per hour + LCU charges                 |
| Backend discovery  | Static DNS records                                  | Dynamic target registration (ECS, ASG) |
| Best for           | Coarse geographic routing, primary region selection | Within-region traffic distribution     |

---

### Table 5: On-Premises DNS Integration Patterns

| Pattern                        | Mechanism                                                                                       | Direction     | Use Case                              |
| ------------------------------ | ----------------------------------------------------------------------------------------------- | ------------- | ------------------------------------- |
| Forward on-prem queries to AWS | Route 53 Inbound Endpoint                                                                       | On-prem → AWS | On-prem servers resolve AWS resources |
| Forward AWS queries to on-prem | Route 53 Outbound Endpoint + Forwarding Rule                                                    | AWS → On-prem | EC2 resolves internal corporate names |
| Bidirectional                  | Both endpoints + rules in both directions                                                       | Both          | Full hybrid DNS; same DNS namespace   |
| Conditional forwarder on-prem  | Configure on-prem DNS server to forward `aws.internal.` queries to Route 53 Inbound Endpoint IP | On-prem → AWS | Simpler; one-directional              |

---

## SECTION 11 — Quick Revision & Memory Tricks

### 10 Key Points — DNS

1. **DNS = Internet's Phone Book** — translates human-readable domain names to machine-readable IP addresses; ~100ms cold, <1ms cached

2. **Four DNS server types** — Recursive Resolver (does the work, caches), Root (13 clusters, delegates to TLD), TLD (.com, .org — delegates to authoritative), Authoritative (final answer for your domain)

3. **Query is right-to-left** — `api.example.com` → resolve `.` → `.com` → `example` → `api`; each level delegates to the next

4. **TTL controls propagation speed** — reduce to 60s before migrations; increase to 300–3600s for stable records; some ISPs ignore TTL (cache longer)

5. **A = IPv4 address; AAAA = IPv6; CNAME = alias to another name; ALIAS = Route 53 CNAME-at-apex workaround**

6. **CNAME cannot be at zone apex** — cannot mix CNAME with NS/SOA/MX at root; use Route 53 ALIAS record for ALB, CloudFront, S3 at zone apex

7. **Route 53 routing policies** — Simple (one IP), Weighted (A/B test), Latency (nearest), Failover (active-passive DR), Geolocation (data residency), Geoproximity (distance + bias)

8. **Private Hosted Zone = internal VPC DNS** — same name resolves to private IP inside VPC, public IP outside; requires `enableDnsSupport=true`

9. **Route 53 Resolver for hybrid DNS** — Inbound Endpoints (on-prem → AWS), Outbound Endpoints + Forwarding Rules (AWS → on-prem)

10. **ALIAS queries to AWS resources are FREE** — always prefer ALIAS over CNAME when pointing to ALB, CloudFront, S3, or other Route 53 records

---

### 30-Second Explanation

"DNS is the internet's phone book — it translates domain names like `google.com` to IP addresses like `142.250.80.46`. DNS is hierarchical: your resolver queries root servers, which delegate to TLD servers (.com), which delegate to authoritative name servers for the specific domain. Responses are cached at browser, OS, and resolver level by TTL. In AWS, Route 53 is the authoritative DNS service — it supports routing by latency, geography, health, and weight. Private Hosted Zones provide internal DNS within VPCs. ALIAS records solve CNAME-at-apex restrictions. Always reduce TTL before migrations."

---

### Memory Tricks

**"RANT = Record types order of frequency"**

- **R**esolve with A (most common)
- **A**lias for AWS apex
- **N**ame alias with CNAME
- **T**ext for verification (TXT)

**"DNS = Don't Need Servers (it's distributed)"**

- No single server; hierarchical delegation means no central bottleneck

**"TTL = Time To Lower (before migrations)"**

- Lower TTL first, wait, then make change, then restore

**"Route 53 routing: SWLFGGIM"**

- Simple, Weighted, Latency, Failover, Geolocation, Geoproximity, IP-based, Multivalue

**"ALIAS = ALways-Intuitively-At-Apex-Safe"**

- ALIAS is the only record type that works at zone apex AND points to AWS resources for free

---

### Exam Quick-Fire

- What port does DNS use? UDP/TCP port 53 (UDP for queries <512 bytes; TCP for larger responses and zone transfers)
- What is the maximum number of health checks for a Route 53 failover record? 1 primary, 1 secondary
- Can you use CNAME for the root domain (zone apex)? No — use Route 53 ALIAS
- Which Route 53 record type charges zero for queries to ALB? ALIAS
- What must be enabled on a VPC for EC2 to have resolvable hostnames? `enableDnsSupport=true` AND `enableDnsHostnames=true`
- What is the Route 53 DNS resolver IP in a VPC with CIDR 172.31.0.0/16? 172.31.0.2
- How do you make on-premises DNS resolve AWS RDS/EC2 hostnames? Route 53 Resolver Inbound Endpoint
- What's the maximum TTL a DNS record can have? 2,147,483,647 seconds (practical max: 86400 = 24 hours)
- Geolocation required record when no specific location matches? Default record (otherwise non-matching clients get NXDOMAIN)

---

## SECTION 12 — Architect Thinking Exercise

### Exercise: Migrate `payments.oldcompany.com` to AWS With Zero Downtime

Your company has acquired a payments provider. Their API (`payments.oldcompany.com`) serves 50M API calls/day to 3,000 partner companies. The API is currently hosted on bare-metal servers in a co-location data center at IP `198.51.100.10`.

You must migrate to AWS ECS + ALB in `us-east-1` within 60 days. Requirements:

- Zero downtime for partners — they cannot change their config
- Partners have hard-coded `payments.oldcompany.com` in their applications
- DNS TTL is currently 3600s (1 hour)
- You don't control the partner's DNS caching or application restart schedules
- After migration, you want the ability to send 5% of traffic to new AWS infra for testing before full cutover

**Before reading solution, think about:**

1. How do you reduce DNS propagation time without partners noticing?
2. How do you test before full cutover?
3. What Route 53 configurations enable gradual traffic shift?
4. How long does the full migration need to be staged?
5. What's your rollback plan?

---

### Solution Walkthrough

**Phase 1 — Preparation (Days 1–3): TTL Reduction**

Current state: 3600s TTL. If we change DNS now, it takes 1 hour for new IP to propagate. Some partners have sticky ISP caches that extend beyond TTL.

Action: Change `payments.oldcompany.com` A record TTL from 3600s to 60s. Make ONLY this change — IP stays the same. Partners see no disruption.

Wait 48 hours → All previously cached records (with old TTL=3600s) have now expired. Maximum cache age is now 60 seconds.

**Phase 2 — AWS Infrastructure Setup (Days 4–20)**

- Set up ECS cluster + ALB in us-east-1
- Deploy containerized payments API
- Configure TLS certificate (ACM) for `payments.oldcompany.com`
- Run load tests at 2× expected traffic

Get the ALB DNS name: `alb-12345.us-east-1.elb.amazonaws.com`

**Phase 3 — Route 53 Weighted Routing (Days 21–40): Gradual Traffic Shift**

Transfer DNS hosting to Route 53 (update NS records at registrar → Route 53 nameservers). Create weighted routing records:

```
payments.oldcompany.com  WEIGHTED  5  →  AWS ALB (ALIAS to alb-12345.us-east-1.elb.amazonaws.com)
payments.oldcompany.com  WEIGHTED  95 →  Old server IP (A record 198.51.100.10)
```

5% of DNS queries return AWS ALB IP; 95% return old server IP.

Monitor: error rates, latency on both targets. Route 53 health checks on both.

Gradually shift weight over 2 weeks:

```
Day 21: 5% AWS / 95% old
Day 25: 25% / 75%
Day 28: 50% / 50%
Day 32: 75% / 25%
Day 35: 100% / 0%
```

**Phase 4 — Full Cutover and Cleanup (Day 35–60)**

At 100% weighted to AWS ALB, remove the old server record. Keep old server running cold standby for 2 weeks (partners with very long-lived DNS caches → their cached old IP → still works if old server is up).

After 2 weeks at 100% AWS with zero errors: decommission old server.

**Rollback at any phase:**

- Weighted routing: shift weight back to old server within 60 seconds (TTL=60s)
- Keep old server running throughout the migration window
- Route 53 health check: if AWS fails health check, automatically falls back to old server

**Final architecture:**

```
payments.oldcompany.com (Route 53, TTL=300)
  ALIAS → alb-12345.us-east-1.elb.amazonaws.com
  → ECS Service (3 tasks, multi-AZ)
  → RDS Aurora (migrated from co-lo DB during Phase 2 via DMS)
```

This pattern is used by every company migrating production APIs to AWS — gradual, observable, reversible.

---

## Complete Series Summary — DNS What It Is

| File    | Sections | Key Takeaways                                                                                                                                                                                                             |
| ------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File 01 | 1–4      | DNS = internet phone book; 4 server types (resolver/root/TLD/authoritative); hierarchy; record types (A/AAAA/CNAME/MX/TXT/NS/PTR/ALIAS); TTL trade-offs; 4-level caching; 9-step resolution flow                          |
| File 02 | 5–8      | Library/franchise analogies; GitHub Pages CNAME chain; DNS as abstraction for zero-downtime migration and blue/green; Route 53 routing policies; ALIAS at apex; VPC DNS; hybrid Route 53 Resolver; global SaaS DNS design |
| File 03 | 9–12     | Route 53 exam traps (CNAME apex, health check for private resources, geolocation default); 5 comparison tables; RANT/SWLFGGIM memory tricks; weighted routing migration exercise                                          |

**Next Topic → Topic 09: DNS Resolution Flow (Step by Step)**
Now that you know what DNS is, let's trace every step of DNS resolution in exhaustive detail — recursive vs iterative, caching mechanics, negative caching, DNS security (DNSSEC), and how Route 53 Resolver handles queries for hybrid environments.
