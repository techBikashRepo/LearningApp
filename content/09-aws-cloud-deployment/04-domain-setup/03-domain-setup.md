# Domain Setup

## FILE 03 OF 03 — Route 53 Routing Policies, Cost, Exam Traps, Scenario Exercise & Architect's Mental Model

> **Architect Training Mode** | Senior Principal Architect Perspective
> _Optimized for: design judgement · tradeoff evaluation · failure prediction · production debugging_

---

## SECTION 9 — Certification Focus (AWS SAA-C03)

### Six Routing Policies — When to Use Each

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│ SIMPLE routing                                                                   │
│ Single record → single value (or multiple IPs)                                   │
│                                                                                  │
│ Use: one server, one IP. No health checks. No routing logic.                     │
│ With multiple IPs: returns all IPs in random order (client picks one)            │
└──────────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────────────┐
│ WEIGHTED routing                                                                 │
│ Multiple records, each with a weight. Traffic distributed by weight ratio.       │
│                                                                                  │
│ Use: canary deployments, A/B testing, gradual traffic shift                      │
│                                                                                  │
│ Example:                                                                         │
│   myapp.com  A  52.14.35.67  Weight: 90  (production)                           │
│   myapp.com  A  52.14.35.68  Weight: 10  (new version canary)                   │
│   → 90% traffic to prod, 10% to canary                                          │
│                                                                                  │
│ Shift gradually:                                                                 │
│   Day 1: 90/10 → Day 2: 80/20 → Day 3: 50/50 → Day 4: 0/100 (full cutover)    │
│                                                                                  │
│ With health checks: if canary fails health check, ALL traffic goes to prod       │
└──────────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────────────┐
│ LATENCY routing                                                                  │
│ Multiple records in different regions. User routed to lowest-latency region.    │
│                                                                                  │
│ Use: multi-region deployments for global user base                               │
│                                                                                  │
│ myapp.com  A  52.14.35.67   ap-south-1  (Mumbai)                                │
│ myapp.com  A  18.234.56.78  us-east-1   (Virginia)                              │
│ myapp.com  A  63.32.45.67   eu-west-1   (Ireland)                               │
│                                                                                  │
│ User in India → ap-south-1 (lowest latency)                                     │
│ User in NYC   → us-east-1                                                        │
│                                                                                  │
│ Route 53 uses internal latency measurements (not real-time ping)                 │
│ Updates periodically, not instantaneous                                          │
└──────────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────────────┐
│ FAILOVER routing                                                                 │
│ Primary + secondary (standby). Traffic to primary. If primary fails health      │
│ check: automatically switch to secondary.                                        │
│                                                                                  │
│ Active-Passive DR:                                                               │
│   PRIMARY:   myapp.com  A  52.14.35.67  Health check: /health                   │
│   SECONDARY: myapp.com  A  52.14.35.68  (static S3 maintenance page, or DR site) │
│                                                                                  │
│ Health check fails for primary → Route 53 returns secondary IP                  │
│ DNS TTL = 60s → within 60 seconds, most users routing to secondary               │
│                                                                                  │
│ Use: DR (Disaster Recovery), maintenance windows, blue/green switchover          │
└──────────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────────────┐
│ GEOLOCATION routing                                                              │
│ Route based on WHERE the user is. Not latency — location.                       │
│                                                                                  │
│ Use: data residency (GDPR), region-specific content, regulatory compliance       │
│                                                                                  │
│ Example:                                                                         │
│   Users in EU     → eu.myapp.com (data stored in Frankfurt, GDPR compliant)     │
│   Users in USA    → us.myapp.com                                                 │
│   All others      → global.myapp.com (default — MUST have default or others fail)│
│                                                                                  │
│ Granularity: continent, country, US state                                        │
│ Requires default record: if no geolocation match, use default                   │
└──────────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────────────┐
│ MULTIVALUE ANSWER routing                                                        │
│ Returns up to 8 healthy records. Like Simple with health checks.                │
│                                                                                  │
│ Use: basic load distribution WITH health checks (Simple has no health checks)   │
│                                                                                  │
│ Returns only HEALTHY IPs (up to 8)                                              │
│ Client performs load balancing by connecting to one of the returned IPs         │
│                                                                                  │
│ NOT a replacement for ALB (no sophisticated balancing, no connection draining)   │
│ Use for: lightweight distribution of traffic across 2-8 servers                  │
└──────────────────────────────────────────────────────────────────────────────────┘
```

---

## SECTION 10 — Comparison Table

```
Health checks can be attached to routing policy records.
Health check = Route 53 agents periodically poll your endpoint.

Types:
  HTTP/HTTPS health check: Route 53 probes /health, expects 2xx response
  TCP health check: just checks TCP port is open (no HTTP)
  Calculated health check: OR/AND logic across multiple health checks
  CloudWatch metric health check: "healthy if PendingJobs CloudWatch metric < 100"

Configuration:
  Endpoint: 52.14.35.67 (or domain name)
  Port: 443
  Path: /health
  Interval: 30 seconds (standard) or 10 seconds (fast, extra cost)
  Failure threshold: 3 consecutive failures = unhealthy
  Success threshold: 2 consecutive successes = healthy again

State machine:
  HEALTHY → fails 3× in a row → UNHEALTHY → Route 53 stops routing to this record
  UNHEALTHY → passes 2× in a row → Route 53 resumes routing to this record

Time to detect failure: up to 30s × 3 = 90 seconds (standard)
                         or 10s × 3 = 30 seconds (fast — costs more)
Time to recover routing: up to 30s × 2 = 60 seconds additional after server recovers

Total recovery cycle: detection + propagation + recovery = up to ~3-5 minutes
This is NOT zero-downtime. Use multiple AZs with ALB for faster failover.

Notification:
  Health check → SNS topic → PagerDuty/email alert
  You're notified when primary enters UNHEALTHY state (before failover maybe takes effect)
```

---

## SECTION 11 — Quick Revision

```
Route 53: What You Pay For

1. Hosted Zones
   Public hosted zone:  $0.50/month (first 25 zones)
   Private hosted zone: $0.50/month

   Typical production setup: 1 public + 1 private = $1.00/month

2. DNS Queries
   Standard queries:       $0.400 per million queries, first 1 billion
   Latency routing queries: $0.600 per million (extra cost for routing evaluation)
   Geo routing queries:    $0.700 per million

   Example: medium-sized app, 10M queries/month:
     Simple A record: 10M × $0.40/M = $4.00/month
     Latency routing: 10M × $0.60/M = $6.00/month

3. Health Checks
   AWS endpoint health check:          $0.50/health check/month
   Non-AWS endpoint health check:      $0.75/health check/month
   Fast interval (10s):                +$1.00/health check/month
   HTTPS health check (vs HTTP):       +$1.00/health check/month

   Typical: 3 health checks (primary + 2 regional backups) × $0.75 = $2.25/month

4. Domain Registration
   .com: ~$12-14/year
   .io: ~$40/year
   .org: ~$10-12/year

5. Traffic Flow (visual routing policy editor, optional)
   $50/month per traffic flow policy record (skip unless you need complex routing)

Real-world total for a typical web application:
  1 public + 1 private zone: $1.00
  10M queries (latency routing): $6.00
  3 health checks: $2.25
  Total: ~$10-$12/month for DNS infrastructure

  DNS is cheap. This entire section of your stack = less than one Lambda cold start cost.
```

---

## SECTION 12 — Architect Thinking Exercise

```
1. WHEN YOU NEED FAST DDoS MITIGATION AT DNS LEVEL

   Cloudflare DNS provides:
   ├── Anycast DNS with DDoS protection included
   ├── DNS response time typically 30-50% faster than Route 53
   ├── Free tier includes all routing features
   └── Cloudflare Magic Transit: network-level DDoS protection

   Route 53 + AWS Shield Standard: moderate DDoS protection
   Route 53 + AWS Shield Advanced: $3,000/month minimum

   For DDoS-sensitive services: Cloudflare DNS may be better choice
   You can still use Route 53 for private/internal DNS while routing public through Cloudflare

2. WHEN COST MATTERS AT VERY HIGH QUERY VOLUMES

   At 10 billion+ queries/month: Route 53 becomes expensive
   Cloudflare Free DNS: $0 for public DNS (unlimited queries)

   Most SaaS products don't reach this scale for years
   But if you're building a CDN or extremely high-query service: evaluate alternatives

3. WHEN SWITCHING DNS PROVIDERS FREQUENTLY

   Route 53 does not support DNSSEC delegation signing with external parent zones as cleanly
   Some enterprise setups have complex DNSSEC chains
   Azure DNS, Google Cloud DNS, or Cloudflare may fit better in certain enterprise setups

4. WHEN YOUR DOMAIN IS REGISTERED ELSEWHERE AND TEAM ISN'T AWS-NATIVE

   If team is already using Cloudflare for CDN + security:
   Adding Cloudflare DNS means one less AWS service to manage
   Centralized dashboard = simpler operations

   Route 53 makes sense when: team is AWS-native, using ALB/CloudFront heavily,
   need private hosted zones within VPC, need Route 53 Resolver for hybrid connectivity
```

---

### AWS SAA Exam Traps

### Trap 1: Latency vs Geolocation Routing Confusion

```
Exam question:
  "A user in Germany connects to your app. GDPR requires data to stay in eu-west-1.
   Which routing policy?"

Trap: Latency routing (because Germany wants low latency)
Actually: LATENCY routing routes to lowest latency → might be us-east-1 if that's faster
          GEOLOCATION routing routes based on WHERE user is (Germany → EU region)

Correct: Geolocation routing
  Germany (or EU continent) → eu-west-1
  GDPR compliance requires geolocation, not just preference

Remember:
  Latency routing = "fastest server"
  Geolocation routing = "correct server for where you ARE"
  These can be the same server, but the policy intent and behavior differ
```

### Trap 2: CNAME on Apex Domain

```
Exam question:
  "Company wants to point example.com (zone apex) to their ALB DNS name.
   How should they configure the Route 53 record?"

Trap: CNAME record pointing to ALB hostname
Actually: CNAME on zone apex is INVALID (RFC prohibits it)
          It conflicts with SOA and NS records required at apex

Correct: ALIAS record (Route 53-specific)
  Type: A (ALIAS)
  Name: example.com
  Value: myalb-123456.ap-south-1.elb.amazonaws.com

Why ALIAS works where CNAME doesn't:
  ALIAS is resolved by Route 53 internally before sending DNS response
  Route 53 returns actual IP addresses of ALB (as an A record response)
  No RFC violation — response is an A record
  ALIAS also: free queries, auto-updates when ALB IPs change
```

### Trap 3: Failover Routing Requires Health Checks

```
Exam question:
  "What Route 53 routing policy should be used to route traffic to a secondary server
   only when the primary server becomes unavailable?"

Correct: Failover routing WITH a health check on the primary record
   Primary record: A record + health check configured
   Secondary record: A record marked as secondary

Trap: Failover routing works without health checks
Actually: Without a health check on the primary, Route 53 NEVER routes to secondary
          Health check is what triggers the failover

          Even if primary server is completely down, Route 53 keeps routing to it
          if no health check is configured
```

### Trap 4: Geolocation Default Record Required

```
Exam question:
  "Company deploys geolocation routing for US and EU. Users from Japan cannot access
   the service. What is the problem?"

Answer: Missing DEFAULT geolocation record
  Without a default: users from unmatched locations (anywhere not US or EU) → NODATA response
  They get DNS lookup failure — the record doesn't exist for them

Fix: Add a record with Location = Default
  Any user whose location doesn't match explicit rules → routes to Default
  Default = global fallback
```

### Trap 5: Route 53 Health Checks Cannot Check EC2 in Private Subnets

```
Route 53 health check agents are on the public internet
They CANNOT reach EC2 instances in private subnets (no public IP, no internet access)

Workaround 1: Route 53 checks ALB health endpoint (ALB is public)
  ALB health-checks the private EC2 → Route 53 checks ALB
  Route 53 → ALB → EC2 (indirectly)

Workaround 2: CloudWatch metric health check
  EC2 publishes custom CloudWatch metric: "isHealthy = 1 or 0"
  Route 53 health check watches CloudWatch metric (not the EC2 directly)

Exam trap: "Route 53 health check probes private EC2 directly" — FALSE
           Must use ALB or CloudWatch metric as intermediary
```

---

### Scenario Design Exercise

### Scenario: Global SaaS with GDPR Compliance

**Problem Statement:**

Your B2B SaaS platform serves:

- EU customers (GDPR: data must stay in eu-west-1)
- US customers (no data residency requirement)
- APAC customers (no data residency requirement, but want low latency)

Requirements:

- EU data must physically stay in eu-west-1 (Frankfurt)
- US and APAC customers should get lowest-latency routing
- Must handle primary region failure (EU → US not allowed for EU data)
- Domain: myapp.com

**Design the Route 53 configuration.**

**Solution:**

```
STEP 1: Subdomain architecture for routing

  Create subdomains that map to specific regions:
    us.myapp.com    → us-east-1 ALB
    eu.myapp.com    → eu-west-1 ALB
    ap.myapp.com    → ap-southeast-1 ALB

STEP 2: Route 53 records for main domain (myapp.com)

  Geolocation routing for EU users (GDPR compliance):
    Record 1:
      Name: myapp.com
      Type: A (ALIAS)
      Value: eu-west-1 ALB
      Routing: Geolocation — Location: Europe (continent)
      Health check: attached to eu-west-1 ALB /health
      ID: "EU-primary"

    Record 2 (GDPR failover — within EU):
      Name: myapp.com
      Type: A (ALIAS)
      Value: eu-central-1 ALB (Frankfurt — 2nd EU region)
      Routing: Geolocation — Location: Europe
      With failover from EU-primary (if eu-west-1 fails → eu-central-1)

    Note: EU customers CANNOT fail over to US per GDPR
          If both EU regions fail → service unavailable is correct (vs GDPR violation)

  Latency routing for US and APAC:
    Record 3:
      Name: myapp.com
      Type: A (ALIAS)
      Value: us-east-1 ALB
      Routing: Latency — Region: us-east-1
      Health check: attached

    Record 4:
      Name: myapp.com
      Type: A (ALIAS)
      Value: ap-southeast-1 ALB
      Routing: Latency — Region: ap-southeast-1
      Health check: attached

  Default (catches all unmatched geographies):
    Record 5:
      Name: myapp.com
      Routing: Latency or Geolocation Default
      Value: us-east-1 ALB (global default)

STEP 3: Result mapping

  User in Berlin    → Geolocation-Europe → eu-west-1 ✅ (GDPR compliant)
  User in NYC       → Latency → us-east-1 (lowest latency)
  User in Singapore → Latency → ap-southeast-1 (lowest latency)
  User in Brazil    → no geo match → Default → us-east-1

STEP 4: Private hosted zone for internal routing

  Private zone: myapp.internal
    api.myapp.internal       → 10.0.1.100 (internal ECS service)
    db.myapp.internal        → 10.0.2.50  (RDS endpoint)
    cache.myapp.internal     → 10.0.3.20  (ElastiCache)

  EC2/ECS services call each other via .internal names → stays in VPC
```

---

### Interview Q&A

**Q: "How does DNS work, in 30 seconds?"**

Good answer: "Your browser queries a local resolver which queries the DNS hierarchy: root servers → TLD nameservers → your domain's authoritative nameserver (like Route 53). The authoritative server returns the IP. Everyone caches the result for the TTL duration. That's why DNS 'propagation' is really just waiting for cache expiry — if your TTL is 3600, old records can be cached for up to an hour after you update them."

**Q: "When would you use Route 53 geolocation routing vs latency routing?"**

Good answer: "Latency routing routes users to the fastest server — great for performance but it doesn't respect where the user IS. Geolocation routing routes by location regardless of latency — essential for GDPR compliance where EU user data must stay in EU. For a globally distributed app with compliance needs, I'd combine them: geolocation to enforce data residency rules, and latency routing for everyone else to get the best performance."

---

## === ARCHITECT'S MENTAL MODEL ===

### 5 Decision Rules for Domain Setup

1. **NS records at registrar must match Route 53.** After every hosted zone creation, immediately verify: `dig NS myapp.com @a.gtld-servers.net` returns your Route 53 nameservers. Mismatch = silent total failure. This is the #1 domain setup failure.

2. **CNAME on apex = broken.** Use ALIAS record (Route 53 specific) for root domain → ALB/CloudFront. ALIAS resolves internally in Route 53, returns A record to clients, auto-tracks IP changes, and costs zero per query. CNAME on apex violates RFC and will not work.

3. **Lower TTL before migration, raise it after.** Standard procedure: 1 week before change, drop TTL to 300s, wait 24h for old TTL to expire globally. After successful migration, raise back to 3600+. Never change a record with TTL=86400 and expect users to see it within minutes.

4. **Geolocation routing for compliance, latency routing for performance.** GDPR, CCPA, data residency laws → geolocation (enforces WHERE traffic goes). Speed optimization for global users → latency (routes to fastest server). These serve different requirements and can coexist in the same hosted zone.

5. **Private Hosted Zone for every internal service.** `db.myapp.internal`, `cache.myapp.internal`, `api.myapp.internal` → services communicate by name without hardcoded IPs. When you replace the DB server, update one DNS record. VPC must have "DNS Resolution" enabled and be associated with the private hosted zone.

### 3 Common Mistakes

1. **Forgetting the Default record in geolocation routing.** If a user's location doesn't match any geolocation rule, they get a DNS NODATA response — effectively invisible. Always add a Default record that handles all unmatched locations, even if it just points to your primary region.

2. **Attaching health checks to wrong record type.** Route 53 health checks probe endpoints on the public internet. They cannot reach private subnet resources directly. Attach health checks to ALB endpoints (which ARE public), not directly to EC2 in private subnets. Failover routing without a working health check does nothing — primary must fail the check to trigger failover.

3. **Treating DNS change as instant.** Even after lowering TTL to 300s and waiting: some ISP resolvers violate TTL (cache longer than specified). Some corporate resolvers aggressively cache. Never plan zero-buffer migrations. Always check from multiple resolvers (dnschecker.org) and keep old infrastructure alive for 2× TTL past your DNS change.

### 1 Clear Interview Answer (30 Seconds)

> "For domain setup in AWS, I use Route 53 with separate public and private hosted zones. Public zone handles internet traffic with ALIAS records pointing to ALB (not CNAME — CNAME doesn't work on apex domains). Private zone handles internal service discovery using `.internal` names so microservices communicate within the VPC. For routing policy: latency-based for global performance, geolocation-based when data residency compliance requires users in specific regions to hit specific infrastructure. Standard setup procedure: buy domain, update NS records at registrar to match Route 53's 4 nameservers, verify delegation with `dig NS @a.gtld-servers.net`, then create records."

---

_End of Domain Setup 3-File Series_
