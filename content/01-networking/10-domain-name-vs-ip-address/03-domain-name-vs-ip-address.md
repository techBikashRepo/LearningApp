# Domain Name vs IP Address — Part 3 of 3

### Topic: AWS SAA Exam Traps, Comparison Tables, and Architecture Exercise

**Series:** Networking Fundamentals → System Design → AWS Solutions Architect
**Sections Covered:** 9, 10, 11, 12

---

## SECTION 9 — AWS SAA Certification Focus

### Core AWS Service Mapping

| Concept                        | AWS Service/Feature                                 | Key Detail                                         |
| ------------------------------ | --------------------------------------------------- | -------------------------------------------------- |
| Domain registration            | Route 53 Registrar                                  | Pays ICANN/registry fee; manages contacts/WHOIS    |
| DNS hosting (authoritative NS) | Route 53 Hosted Zones                               | Public (internet) or Private (VPC-internal)        |
| Static custom domain for ALB   | Route 53 ALIAS A record                             | Free; apex-safe; auto-follows ALB IP changes       |
| Custom domain for CloudFront   | ACM cert (us-east-1 region only) + CloudFront CNAME | ACM cert MUST be in us-east-1 for CloudFront       |
| Custom domain for API Gateway  | ACM cert (same region as API) + Custom Domain Name  | Regional or Edge-optimized (edge = us-east-1 cert) |
| Multi-tenant custom domains    | CloudFront + SNI + ACM                              | Free SNI certs per distribution                    |
| Domain transfer to Route 53    | Route 53 domain transfer                            | Requires EPP/auth code from current registrar      |
| DNS validation for TLS certs   | ACM DNS validation via CNAME                        | Auto-renews; preferred over email validation       |

---

### Critical Exam Traps

**Trap 1 — ACM Certificate Region for CloudFront MUST Be us-east-1**

This is the #1 ACM exam trap. CloudFront is a global service that only reads ACM certificates from **us-east-1 (N. Virginia)**, regardless of where your origin or users are.

If you create an ACM cert in ap-southeast-1 and try to attach it to CloudFront → it won't appear in the dropdown.

Correct workflow:

```
AWS Console → Switch to us-east-1 region → ACM → Request certificate
→ Add domain names → Choose DNS validation
→ Go to CloudFront distribution → ACM Certificates → cert now appears
```

For ALB and API Gateway (non-CloudFront): use ACM cert in the **same region as the service**. Only CloudFront has the us-east-1 requirement.

**Trap 2 — Route 53 ALIAS vs CNAME at Zone Apex**

The exam frequently presents scenarios where you must attach a custom domain to an ALB at the root/apex level:

- `example.com` (not `www.example.com`) → ALB

CNAME at apex is **not allowed** by DNS standards (RFC 1912). `example.com CNAME alb-xxx.amazonaws.com` is invalid.

Solution: Route 53 **ALIAS record**. ALIAS is a Route 53 extension that behaves like an A record but resolves dynamically to the underlying resource's IPs.

`example.com ALIAS → alb-xxx.us-east-1.elb.amazonaws.com`

- No CNAME limitation — works at apex
- Free queries to AWS resources (ALIAS to ALB/CloudFront/S3 don't incur per-query charges)
- Auto-reflects IP changes if the target's IPs change

**Trap 3 — Elastic IP vs ALB DNS Name**

When should you use an Elastic IP vs an ALB DNS name?

Use Elastic IP when:

- You need IP allow-listing with a partner (they whitelist specific IPs)
- SMTP (port 25) — static IP required for email reputation
- Network Load Balancer with static IPs (NLB supports EIPs on fixed IP NLB endpoints)

Use ALB DNS name when:

- Web applications (HTTP/HTTPS)
- Path-based routing between multiple microservices
- Elastic, auto-scaling backend

Exam pattern: "partner needs to whitelist your outbound IP" → Elastic IP on NAT Gateway, NOT on ALB.

**Trap 4 — Custom Domain for API Gateway Edge-Optimized vs Regional**

API Gateway has two endpoint types affecting cert region:

- **Edge-optimized:** requests go through CloudFront edge → cert must be in **us-east-1**
- **Regional:** deployed in a specific region → cert must be in the **same region as the API**

Exam question: Company has users in Asia and deploys API Gateway in ap-northeast-1. Which cert region? → **ap-northeast-1** (regional endpoint, not edge-optimized unless explicitly stated).

**Trap 5 — Route 53 Transfer Lock**

When transferring a domain away from Route 53 (to another registrar), you must first **disable the transfer lock**. Route 53 has "Transfer Lock" enabled by default on all registered domains to prevent unauthorized transfers.

Exam scenario: "domain transfer is failing" → check if transfer lock is enabled and disable it.

---

### Route 53 Domain Registration Pricing (Exam-Relevant)

| Domain TLD    | Annual Cost (approx)                              |
| ------------- | ------------------------------------------------- |
| .com          | $13/year                                          |
| .net          | $11/year                                          |
| .org          | $12/year                                          |
| .io           | $39/year                                          |
| .aws          | Not available for general registration            |
| Transfer fee  | $13/year for .com (includes 1-year extension)     |
| Private WHOIS | Free with Route 53 (automatic privacy protection) |

---

## SECTION 10 — Comparison Tables

### Table 1 — Domain Name vs IP Address

| Attribute                  | Domain Name                           | IP Address                             |
| -------------------------- | ------------------------------------- | -------------------------------------- |
| Human readable             | Yes — `api.example.com`               | No — `198.51.100.42`                   |
| Changes when infra changes | No (abstraction)                      | Yes (new instance = new IP)            |
| Required for TLS           | Yes — cert binds to domain name       | IP SANs rare and expensive             |
| Virtual hosting            | Yes — via Host header and SNI         | No — server can't distinguish tenants  |
| CDN geo-routing            | Yes — DNS-based steering              | Not possible (no name = no DNS)        |
| Length                     | Up to 253 chars, labels ≤63 chars     | IPv4: 7-15 chars; IPv6: up to 39 chars |
| Protocol level             | Application (DNS) and Transport (SNI) | Network (IP) and Transport (TCP)       |
| Ownership                  | Registered with ICANN registrars      | Assigned by ISP/cloud provider         |
| Stability                  | Highly stable (you own the name)      | Variable (changes with infra)          |

---

### Table 2 — URL Components and Processing Layer

| Component    | Example           | Processed By             | Sent in DNS?              |
| ------------ | ----------------- | ------------------------ | ------------------------- |
| Scheme       | `https`           | Browser/client TLS stack | No                        |
| Hostname     | `api.example.com` | DNS + TCP + TLS SNI      | Yes (DNS only)            |
| Port         | `:443`            | TCP layer                | No                        |
| Path         | `/v2/orders`      | Web server / ALB rule    | No                        |
| Query params | `?status=open`    | Application server       | No                        |
| Fragment     | `#details`        | Browser only             | No (never sent to server) |

---

### Table 3 — ACM Certificate Types and Region Requirements

| Use Case                        | Certificate Type  | Required Region                |
| ------------------------------- | ----------------- | ------------------------------ |
| CloudFront distribution         | ACM public cert   | **us-east-1 ONLY**             |
| ALB (Application Load Balancer) | ACM public cert   | Same region as ALB             |
| API Gateway (Edge-optimized)    | ACM public cert   | **us-east-1** (via CloudFront) |
| API Gateway (Regional)          | ACM public cert   | Same region as API Gateway     |
| Elastic Beanstalk               | ACM public cert   | Same region as environment     |
| Imported external cert          | ACM imported cert | Any region (import per region) |
| Private CA internal certs       | ACM Private CA    | Any region                     |

---

### Table 4 — Domain Routing Strategies

| Strategy                  | How It Works                   | Pros                              | Cons                                  | Best For                |
| ------------------------- | ------------------------------ | --------------------------------- | ------------------------------------- | ----------------------- |
| Single domain, path-based | `app.com/api/*` → service A    | No extra DNS, single cert         | Tight coupling, hard to split teams   | Monoliths, simple apps  |
| Subdomain per service     | `api.app.com`, `admin.app.com` | Clear separation, different certs | DNS management overhead               | Microservices           |
| Subdomain wildcard        | `*.app.com` → single ALB       | Simple DNS, wildcard cert         | Can't route by subdomain at DNS level | Multi-tenant same-infra |
| Custom domain per tenant  | `portal.acme.com` → CNAME      | Enterprise white-label            | Cert automation required              | B2B SaaS                |
| Regional subdomains       | `us.app.com`, `eu.app.com`     | GDPR data residency               | More DNS records, client config       | Global compliance       |

---

### Table 5 — IP Address Types in AWS

| IP Type            | Persistence                     | Use Case                          | Domain Name Applicable?                    |
| ------------------ | ------------------------------- | --------------------------------- | ------------------------------------------ |
| EC2 public IP      | Lost on stop/start              | Ephemeral testing                 | No — use EIP or put behind ALB             |
| Elastic IP         | Persistent (until released)     | Static outbound, IP allow-listing | Yes — but ALB preferred for inbound        |
| Private IP (VPC)   | Persistent (while ENI attached) | Internal communication            | Yes — via Private Hosted Zone              |
| ALB DNS name       | Stable — IPs can change         | Web app inbound                   | Yes — use ALIAS record                     |
| NLB static IP      | Persistent per AZ               | IP allow-listing + LB             | Yes — use ALIAS or direct                  |
| CloudFront IPs     | Anycast, AWS-managed            | CDN content delivery              | Yes — CNAME to \*.cloudfront.net           |
| Global Accelerator | 2 static Anycast IPs            | Multi-region latency optimization | Yes — ALIAS to \*.awsglobalaccelerator.com |

---

## SECTION 11 — Quick Revision & Memory Tricks

### 10 Key Points to Remember

1. **Domain name = contracts, IP = implementation.** The domain name is the stable service contract; IP is the transient infrastructure detail. Never expose IPs in APIs, docs, or customer configurations.

2. **URL anatomy: scheme → host → port → path → query → fragment.** Only the host portion goes to DNS. Everything else is HTTP/application layer.

3. **SNI = "tell the server which domain you want" in TLS ClientHello.** Enables unlimited HTTPS domains per IP. Without SNI, only one cert per IP.

4. **Virtual hosting requires a domain name** — the server reads the HTTP Host header (which carries the domain name), not the destination IP, to decide which application to serve.

5. **ACM cert for CloudFront = us-east-1 ONLY.** This is the most tested ACM fact on the SAA exam. ALB and API Gateway (regional) use certs in their own regions.

6. **ALIAS at zone apex, not CNAME.** `example.com` cannot have a CNAME (RFC violation). Use Route 53 ALIAS → ALB/CloudFront/S3. Free queries to AWS targets.

7. **DNS validation preferred over email validation for ACM.** DNS validation auto-renews via CNAME presence; email validation requires human intervention every 13 months.

8. **CDN geo-routing is DNS-based.** CloudFront returns different IPs to different geographic resolvers. TTL=60s allows rapid re-steering on PoP failures.

9. **Kubernetes ndots:5 causes DNS search-domain explosion.** External domains with <5 dots trigger 3–5 NXDOMAIN queries before the real lookup. Fix: use FQDN (trailing dot) or set `ndots:2`.

10. **Public Suffix List (PSL) isolates cookie scope between tenants.** Register your SaaS suffix in PSL if you serve multi-tenant on subdomains of your domain.

---

### 30-Second Explanation (Memorize This)

"A domain name is the human-readable, stable identifier for a service — like a brand name. An IP address is the physical location of the server — it changes with deployments, migrations, and scaling. Domain names appear in TLS certificates, HTTP Host headers, TLS SNI, and DNS queries. IPs appear only in the TCP connection. This separation enables virtual hosting, CDN geographic routing, zero-downtime migrations, and TLS security. In AWS, ALIAS records attach domain names to ALBs and CloudFront at the zone apex where CNAME is forbidden. ACM certificates bind TLS to domain names, and for CloudFront the cert must always be in us-east-1 regardless of where your users are."

---

### Memory Mnemonics

**SHIP = Scheme Host(domain) Is Path (query fragment)**
URL components in order: Scheme, Host, Is (port), Path, query, #fragment. Only Host → DNS.

**ACM CloudFront = Always us-east-1 (ACE rule):**

- A = ACM cert
- C = CloudFront distribution
- E = East-1 (us-east-1 only)

**SANTA = SNI Allows N-domains To Authenticate:**
SNI lets one IP host N domains with their own TLS certs. Without SNI, one IP = one cert = one domain.

**"ALIAS not CRIME at apex":**
CRIME = CNAME at apex = RFC violation. Use ALIAS instead. ALI-AS: "ALwAys uSe ALIAS at apex."

**Quick-Fire Exam Facts:**

- Custom CloudFront domain? → CNAME + ACM cert in us-east-1
- ALB at apex (example.com)? → Route 53 ALIAS record
- S3 website custom domain? → Route 53 ALIAS → S3 website endpoint
- Domain transfer failing? → Check transfer lock status
- Partner whitelisting IPs? → Elastic IP on NAT Gateway (not ALB)
- Wildcard cert `*.example.com` → covers `api.example.com`, NOT `api.sub.example.com`

---

## SECTION 12 — Architect Thinking Exercise

### The Problem (Read carefully — take 5 minutes to think before viewing the solution)

**Scenario:**
MegaCorp is migrating from on-premises to AWS. They have:

- 50+ public-facing subdomains: `www.megacorp.com`, `api.megacorp.com`, `login.megacorp.com`, `cdn.megacorp.com`, etc.
- DNS currently hosted on-premises (BIND servers, on two physical servers in their DC)
- The BIND servers resolve both internal hostnames (`ldap.corp.internal`, `jenkins.corp.internal`) and external hostnames
- Migration plan: move all services to AWS (EC2, ALB, CloudFront, S3) over 6 months
- Zero tolerance for downtime during migration
- Team wants a strategy for migrating DNS alongside services — not all at once

**What is your DNS migration strategy? How do you ensure zero downtime? How do you handle the split between internal and external DNS during migration?**

_(Think through your approach before scrolling)_

---

↓

↓

↓

↓

---

### Solution — Phased DNS Migration with Zero Downtime

**Constraint Analysis:**

- Single BIND cluster = SPOF (physical servers in on-prem DC)
- Both internal and external DNS on same servers = mixed responsibility
- 50+ services = can't migrate all at once
- Zero downtime = can't do big-bang cutover

**Phase 0 — Pre-Migration (Week 1–2): Baseline and Inventory**

```
1. Export all DNS zone files from BIND:
   named-checkzone megacorp.com /etc/bind/db.megacorp.com

2. Inventory every record:
   - How many unique A/AAAA records? → number of services to migrate
   - Current TTLs? (if all are 86400=24h, reduce immediately)
   - Which records point to on-prem IPs? → will change as services migrate
   - Which records are internal-only? → need Private Hosted Zone treatment

3. Immediately: lower all TTLs to 300 seconds (5 minutes)
   → Wait 24 hours for old 86400s TTLs to expire everywhere
   → From this point: DNS changes propagate within 5 minutes globally

4. Establish Route 53 as secondary authoritative NS (parallel operation):
   → Create Route 53 Public Hosted Zone for megacorp.com
   → Import all DNS records into Route 53
   → Do NOT change NS records at registrar yet (BIND still primary)
   → Validate Route 53 responds correctly by querying Route 53 NS directly:
      dig @ns-1234.awsdns-56.org www.megacorp.com A
```

**Phase 1 — Internal DNS Separation (Week 2–3)**

```
Goal: separate internal DNS from external DNS before migrating anything

1. Create Route 53 Private Hosted Zone: corp.internal
   + Associate with all future AWS VPCs

2. Create Route 53 Resolver Outbound Endpoint
   → Forward queries for corp.internal from VPC to on-prem BIND
   → Allows EC2 instances (migrated) to still resolve ldap.corp.internal

3. Create Route 53 Resolver Inbound Endpoint
   → On-prem servers can resolve aws.megacorp.corp.internal → EC2 private IPs
   → Allows on-prem systems to reach migrated AWS systems by hostname

4. Update on-prem BIND: delegate corp.internal sub-subdomain to Route 53 Resolver IPs
   → On-prem clients: unaffected (BIND still handles megacorp.com)
   → EC2 instances: resolve both worlds (Route 53 for external, outbound endpoint for on-prem)
```

**Phase 2 — Service-by-Service Migration (Weeks 3–24)**

```
For each service migration (e.g., cdn.megacorp.com):

Day 0: Ensure TTL = 60s on cdn.megacorp.com (already done in Phase 0)

Day 1: Deploy CloudFront distribution with S3 origin
       Test by: curl -H "Host: cdn.megacorp.com" https://dXXXX.cloudfront.net
       → Works → proceed

Day 2: Update Route 53 record (which is already provisioned, just wrong IP):
       cdn.megacorp.com CNAME dXXXX.cloudfront.net   (in Route 53 zone)
       cdn.megacorp.com A → old-on-prem-IP            (in BIND — unchanged)
       NS at registrar: still points to BIND → users using BIND (no change yet)

Day 2: Cutover NS (per-service staging isn't possible — NS is zone-level)
       Wait: must do ALL services before NS cutover OR accept running parallel for a while.

Final NS cutover (after all services are in Route 53):
  1. At domain registrar: change NS records from BIND IPs → Route 53 NS (4 servers)
  2. NS TTL is 48h → takes up to 48h to propagate globally
  3. After propagation: Route 53 is authoritative for megacorp.com
  4. BIND continues running for internal queries (corp.internal) only
```

**Phase 3 — Decommission BIND (Month 6+)**

```
1. All external DNS on Route 53
2. Internal DNS:
   - Route 53 Private Hosted Zone (corp.internal on AWS)
   - On-prem servers use Route 53 Resolver Inbound Endpoint for AWS hostnames
3. BIND reduced to on-prem-only internal hostnames
4. Eventually: migrate remaining on-prem services → BIND fully decommissioned
5. Enable Route 53 Resolver DNS Firewall for all VPCs
6. Enable Route 53 query logging for all VPCs → CloudWatch
```

**Migration Safety Checklist:**

- [ ] All record TTLs reduced to 60–300s before any NS changes
- [ ] Route 53 zone fully populated and validated BEFORE NS cutover
- [ ] Negative cache cleared from all internal test machines before validation
- [ ] Health checks configured on Route 53 for all critical records
- [ ] Rollback plan: keep BIND running for 30 days post-migration as standby
- [ ] Rollback trigger: if Route 53 responds incorrectly → revert NS at registrar within 60s
- [ ] Monitor: Route 53 health dashboard + CloudWatch DNS metrics

---

## Complete Series Summary — Topic 10

| File    | Sections | Core Content                                                                                                                                                                   |
| ------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| File 01 | 1–4      | IP vs domain name abstraction, URL anatomy (6 components), FQDN structure, virtual hosting requirement, CDN geo-routing, FQDN vs relative names, IDN / Punycode                |
| File 02 | 5–8      | Blue/green via DNS, multi-tenant SaaS domain patterns, GitHub Pages CNAME chain, ACM DNS validation, CloudFront SNI multi-tenant, ndots:5 Kubernetes DNS fix, 8 interview Q&As |
| File 03 | 9–12     | AWS exam traps (us-east-1 ACM, ALIAS at apex, transfer lock), 5 comparison tables, SHIP/ACE/SANTA/ALIAS mnemonics, phased on-prem → AWS DNS migration exercise                 |

**Next Topic →** Topic 11: TCP vs UDP — Connection-oriented vs connectionless protocols, the TCP state machine, UDP's design trade-offs, when to choose each, and how AWS services map to TCP and UDP.
