# Domain Name vs IP Address — Part 2 of 3

### Topic: Real-World Patterns, AWS Domain Management, and Interview Mastery

**Series:** Networking Fundamentals → System Design → AWS Solutions Architect
**Sections Covered:** 5, 6, 7, 8

---

## SECTION 5 — Real-World Examples

### Analogy 1 — The Office Building Address vs Floor Extension

A company occupies a 30-floor skyscraper at 123 Main Street (the IP address). But internally, every department has a named extension: "Marketing on 12," "Engineering on 18," "Executive Suite on 30."

When a visitor arrives at 123 Main Street, the lobby directory (virtual hosting / HTTP routing) tells them which floor (path/service) to go to. Knowing only "123 Main Street" isn't enough — they need a name ("visit Engineering") to get the right floor.

Now the company moves to 456 Innovation Blvd (new IP after cloud migration). Old visitors still know "Engineering department at MyCompany" — their address books didn't reference the street address. The company just updates the corporate directory once (DNS update), and all visitors automatically route to the new building.

### Analogy 2 — API Versioning as Path, Brand as Domain

Two software companies both exposing payment APIs:

- Company A: `https://203.0.113.5/api/v2/payments` (IP in docs)
- Company B: `https://payments.stripe.com/v1/charges` (domain in docs)

When Company A re-provisions their server (common with cloud instances):

- All clients with `203.0.113.5` hardcoded get immediate failure
- Engineers scramble to notify all API consumers with new IP
- SLA breach, customer calls, incident report

When Stripe migrates their backend (which they've done many times):

- `payments.stripe.com` DNS record updated → points to new IP
- All clients using the domain name: zero action needed
- Zero downtime visible to users

Using domain names in external-facing APIs is not just a preference — it's a **correctness requirement** for any service with more than one consumer.

### Real Software Example — GitHub Pages and CNAME Chains

Millions of developers host personal sites via GitHub Pages with custom domains. Here's how the complete domain → IP chain works:

```
# Developer configures:
# DNS Record: bikash.example.com CNAME bikashrai.github.io.
# GitHub Pages settings: "Custom domain: bikash.example.com"

# What happens when a user visits https://bikash.example.com:

1. Browser resolves bikash.example.com
   → DNS: CNAME → bikashrai.github.io
   → DNS: bikashrai.github.io CNAME → github.io
   → DNS: github.io A → 185.199.108.153 (GitHub's CDN IP)

2. TCP + TLS to 185.199.108.153:443
   TLS SNI: "bikash.example.com" (original domain, not github.io)

3. GitHub's CDN receives request:
   SNI: bikash.example.com → looks up which repository this maps to
   Serves: bikashrai/bikashrai.github.io repository content

4. GitHub generates/uses a TLS cert for bikash.example.com
   (Let's Encrypt via GitHub's ACME automation)
   Proves ownership via TXT record: _acme-challenge.bikash.example.com
```

Key architecture lessons:

- CNAME chains mean the domain name travels through multiple resolution steps
- The original domain name (not the final CNAME target) is used in TLS SNI
- This allows third-party infrastructure to serve your custom domain without owning its DNS
- Wildcard certs (`*.github.io`) don't solve multi-tenant custom domains — per-domain certs required

---

## SECTION 6 — Why This Matters for System Design

### Design Principle 1 — Never Hardcode IPs in Application Configuration

```python
# WRONG — brittle, breaks on infra changes
DATABASE_HOST = "10.0.3.47"
PAYMENT_API = "198.51.100.5"

# RIGHT — infrastructure can change without code deployment
DATABASE_HOST = "payments-db-primary.internal.example.com"
PAYMENT_API = "api.paymentprovider.com"
```

Any IP address in application configuration is a time bomb. Cloud instances are ephemeral. IPs change. The service contract is the domain name — use it everywhere.

**Exception:** some high-performance systems (HFT, gaming) deliberately bypass DNS and hardcode IPs for microsecond-level control after initial lookup. This is a specialized optimization, not a general pattern.

### Design Principle 2 — Domain Strategy for Multi-Tenant SaaS

Three common domain patterns for SaaS products:

**Pattern 1 — Shared domain with path:**

```
app.yourproduct.com/acme-corp/dashboard
app.yourproduct.com/techco/settings
```

- Single SSL cert, single DNS entry
- Tenant ID in URL path
- Simplest to operate
- Less white-label feel for enterprise customers

**Pattern 2 — Subdomain per tenant:**

```
acme-corp.yourproduct.com
techco.yourproduct.com
```

- Wildcard cert (`*.yourproduct.com`)
- DNS: `*.yourproduct.com` → ALB IP (single record, all subdomains)
- Tenant extracted from `Host` header
- Feels slightly more custom per tenant

**Pattern 3 — Custom domain per tenant (white-label):**

```
portal.acme-corp.com → your infrastructure
dashboard.techco.io → your infrastructure
```

- Tenant owns domain, sets CNAME to your infrastructure
- Your infrastructure: detects custom domain via SNI, routes to correct tenant
- Requires TLS cert per custom domain (automated via Let's Encrypt ACME)
- AWS: use ACM with CloudFront (SNI-based, free certs per distribution)
- Most enterprise/white-label SaaS products implement this

### Design Principle 3 — Zero-Downtime Blue/Green via DNS

```
Before migration:
  api.example.com A → 198.51.100.10 (blue env)  TTL=3600

Step 1 (48h before cutover): Lower TTL
  api.example.com A → 198.51.100.10  TTL=60
  Wait 3600s for old TTL to expire everywhere

Step 2: Deploy green environment at new IP 198.51.100.20
  Test green thoroughly using IP directly

Step 3: Cutover (near-instant for new connections)
  api.example.com A → 198.51.100.20  TTL=60
  Within 60s: all new connections go to green
  Old connections on TCP already open: still on blue, drain naturally

Step 4: Monitor for 30 minutes
  If issues: revert api.example.com A → 198.51.100.10
  Takes effect within 60s (TTL=60)

Step 5: After stable, raise TTL back
  api.example.com A → 198.51.100.20  TTL=3600
```

Without domain names, this pattern is impossible — there's no abstraction layer to switch.

---

## SECTION 7 — AWS Mapping

### Route 53 and Domain Management

**Domain Registration vs DNS Hosting:**
These are two different services that are often conflated:

- **Domain Registration:** paying for the right to use a domain name, recorded in ICANN/Verisign's global registry. Route 53 Registrar handles this.
- **DNS Hosting:** running the name servers that answer queries for your domain. Route 53 Hosted Zones handles this. Cloudflare, GoDaddy, and others also provide DNS hosting.

You can register a domain at GoDaddy and host DNS at Route 53 (or vice versa). They're independent services connected only by NS records.

```
Route 53 Domain Registration flow:
  1. Check availability: route53.amazonaws.com/register
  2. Pay ICANN/registry fee (~$12/year for .com)
  3. Route 53 creates a Hosted Zone automatically
  4. Route 53 sets NS records at registry pointing to Route 53 name servers

Domain transferred from GoDaddy to Route 53:
  1. Get auth/EPP code from current registrar
  2. Initiate transfer in Route 53 (up to 7 days for ICANN process)
  3. Update NS records in Route 53 to match your Route 53 Hosted Zone NS
```

### ACM (AWS Certificate Manager) and Domain Names

TLS certificates are tied to domain names. ACM automates cert issuance and renewal:

```
ACM cert request for api.example.com:
  Option A — DNS validation:
    ACM gives you: _abc123.api.example.com CNAME xyz456.acm-validations.aws.
    You add this CNAME to Route 53 (or ACM does it automatically if R53-managed)
    ACM proves you control the domain → cert issued
    Auto-renews as long as CNAME stays present

  Option B — Email validation:
    ACM sends email to admin@example.com, webmaster@example.com, etc.
    Someone clicks the approval link
    Cert issued, but renewal is manual/email-based
```

**DNS validation is strongly preferred** — it's automated, survives account team changes, and enables auto-renewal without human interaction.

**ACM cert coverage:**

- `api.example.com` — exact match
- `*.example.com` — wildcard (not multi-level: doesn't cover `sub.api.example.com`)
- Combination: both `example.com` AND `*.example.com` in same cert (apex + wildcard)

### CloudFront + Custom Domains (SNI-based multi-tenant)

CloudFront uses SNI (Server Name Indication) to host unlimited custom domains on shared IP addresses:

```
Customer A: portal.acme-corp.com → CNAME → d1234abcd.cloudfront.net
  CloudFront distribution serves: ACM cert for portal.acme-corp.com

Customer B: shop.techco.io → CNAME → d5678efgh.cloudfront.net
  CloudFront distribution serves: ACM cert for shop.techco.io

Both resolve to CloudFront's shared anycast IPs.
SNI in TLS ClientHello tells CloudFront which cert to present.
Zero IP conflicts, no dedicated IPs needed.

Exception: Legacy clients not supporting SNI can use CloudFront's
"Dedicated IP" option (+$600/month) — they get a dedicated IP per distribution.
```

### Elastic IPs and Why They Exist

EC2 instances get a new public IP every time they stop/start. Problem: any client using the IP directly (hardcoded) breaks.

Elastic IP = a static IPv4 address allocated to your AWS account, associated with an instance. The instance IP stays the same across stop/start cycles.

But best practice: **don't use Elastic IPs with domain names** unless forced to. Instead:

- Put EC2 behind an ALB → use the ALB DNS name (stable CNAME target)
- Use Route 53 ALIAS to ALB → your domain → stable, even if ALB IPs change
- Reserve Elastic IPs for egress (outbound traffic from NAT Gateway) or for IP allow-listing with partners

---

## SECTION 8 — Interview Q&As

### Beginner Questions

**Q1: What is the difference between a domain name and a URL?**

A: A **domain name** is the human-readable hostname portion of a network address (e.g., `api.example.com`). A **URL** (Uniform Resource Locator) is the full address of a specific resource and includes: scheme, domain name, port, path, query parameters, and fragment.

`https://api.example.com:443/v2/orders?status=open#details`
↑ scheme ↑ domain name ↑port ↑path ↑query ↑fragment

DNS only processes the domain name portion. The rest (path, query, fragment) is handled at the application layer by the web server, load balancer, or API gateway.

**Q2: What is SNI and why does it matter for domain names and TLS?**

A: SNI (Server Name Indication) is a TLS extension where the client includes the domain name it's connecting to in the TLS ClientHello message. This allows a single server IP to host TLS certificates for multiple domains.

Without SNI: the server must present a cert before knowing which domain the client wants → only one cert possible per IP → one domain per IP.

With SNI: the client says "I want `api.example.com`" in the TLS handshake → the server picks the correct cert for that domain and responds appropriately.

SNI is how CloudFront, ALBs, and web servers (Nginx, Apache) serve multiple HTTPS domains on a single IP. It's fundamental to modern multi-tenant hosting. All modern clients support SNI (SNI is in every browser since 2011, all modern OS TLS stacks).

**Q3: Why should you never hardcode IP addresses in application configuration?**

A: IP addresses are infrastructure implementation details that change frequently: cloud instances get new IPs on restart, load balancers scale and get new IPs, migrations change endpoints, CDNs rotate IPs for performance. IP-hardcoded applications break silently or visibly when any of these changes happen.

Domain names provide an **abstraction layer** — when the underlying IP changes, updating a single DNS record propagates the change to all clients. The application code, CI/CD pipelines, partner integrations, and client SDKs are all decoupled from infrastructure changes.

Additionally, IP hardcoding breaks TLS (cert is for domain name, not IP), breaks CDN routing, and breaks virtual hosting (server can't determine which service to route to without a domain name).

---

### Intermediate Questions

**Q4: How does virtual hosting work, and what happens when the server receives an HTTP request with an IP in the Host header instead of a domain name?**

A: Virtual hosting allows one server (or load balancer) to serve multiple domains. The server determines which application/tenant to route to based on the HTTP `Host` header and the TLS SNI value.

```
Request: GET /dashboard HTTP/1.1
Host: admin.example.com
→ Routes to admin application

Request: GET /dashboard HTTP/1.1
Host: app.example.com
→ Routes to user application

Same server IP: same TCP destination, different routing outcome
```

When a client sends an IP address in the Host header (or connects by IP without an SNI):

- The server has no domain context → uses the "default" virtual host
- TLS cannot verify: certificate is issued for a domain name, not an IP, so the browser rejects it (cert mismatch error)
- Virtual hosting breaks — server can't identify which tenant to serve
- Result: misconfigured, insecure, broken request handling

This is why IP-direct connections to multi-tenant servers always fail with cert errors.

**Q5: Explain how CDNs use DNS for global load balancing and geographic routing.**

A: CDNs like CloudFront, Akamai, and Fastly use DNS as the primary mechanism for directing users to the nearest Point of Presence (PoP).

The CDN controls the authoritative name servers for CDN hostnames (e.g., `d1234.cloudfront.net`). When a user resolves this name:

1. Their recursive resolver queries CloudFront's authoritative NS
2. CloudFront's NS checks the resolver's IP address (→ infers geographic region)
3. Returns the IP of the nearest CloudFront PoP

```
NYC recursive resolver → CloudFront NS → NYC PoP IP (203.0.113.10)
Tokyo recursive resolver → CloudFront NS → Tokyo PoP IP (198.51.100.5)
Frankfurt recursive resolver → CloudFront NS → Frankfurt PoP IP (192.0.2.5)
```

This is **DNS-based anycast steering**. The user gets a geographically close IP without any client-side logic. The TTL on these records is often very short (60s) to allow re-steering if a PoP goes down.

Route 53 Latency routing works similarly — it measures latency from the user's resolver location to AWS regions and returns the IP of the lowest-latency region.

**Q6: What is the Public Suffix List (PSL) and why does it matter for cookie isolation between SaaS tenants?**

A: The Public Suffix List (PSL) is a maintained list (mozilla.org/en-US/about/governance/policies/security-group/cname-cookies/) of domain suffixes under which registrations are made — effectively, "where a domain boundary exists for security purposes."

For regular domains: `example.com` is the boundary. `blog.example.com` and `api.example.com` can share cookies set on `.example.com`.

For cloud services, PSL entries prevent subdomain cookie leakage:

- `s3.amazonaws.com` is in the PSL
- So `tenantA.s3.amazonaws.com` and `tenantB.s3.amazonaws.com` cannot share cookies
- Without this: a cookie set by one S3 tenant could leak to another tenant on the same parent domain

Application impact for SaaS builders:
If you run `tenantA.yourapp.com` and `tenantB.yourapp.com`:

- A cookie set on `.yourapp.com` is accessible to ALL tenants — major security risk
- You must set cookies scoped to the exact subdomain, not the parent domain
- OR register `yourapp.com` in the PSL to enforce tenant isolation at the browser level
- GitHub did this for github.io (it's in the PSL), preventing cross-repository cookie attacks

---

### Advanced System Design Questions

**Q7: Design the DNS and domain strategy for a global B2B SaaS platform that needs to support 10,000+ customer custom domains (white-label), 99.99% uptime, and sub-50ms DNS resolution worldwide.**

A: This requires 4 layers working together:

**Layer 1 — Authoritative DNS (your primary domains):**

- Route 53 with 4 NS records spanning 4 different TLDs (.com, .net, .org, .co.uk)
- 100% uptime SLA from Route 53 — authoritative layer is not a SPOF
- All core records: `*.yourapp.com`, health checks with failover routing

**Layer 2 — Custom domain onboarding:**

- Customer sets CNAME: `portal.acme.com CNAME custom.yourapp.com`
- `custom.yourapp.com` is a CNAME to your CloudFront distribution or Global Accelerator
- SNI-based cert: auto-provisioned per customer via ACM ACME DNS validation
- Lambda function triggered on new customer CNAME: calls ACM, creates CloudFront behavior, validates cert, activates

**Layer 3 — Global geo-steering (<50ms requirement):**

- Route 53 Latency routing for `custom.yourapp.com` → nearest regional endpoint
- Or AWS Global Accelerator (anycast IPs, BGP-based steering, faster than DNS TTL changes)
- CloudFront PoP in 400+ locations for static assets — sub-10ms for cached content

**Layer 4 — High availability at authoritative layer:**

- Route 53 health checks on each regional endpoint
- Failover routing: Primary (us-east-1) → Secondary (eu-west-1) → Tertiary (ap-southeast-1)
- TTL=60s on active-passive records; health check interval=30s; 3 failures = failover
- Customer custom domains via CNAME inherit this HA automatically (their CNAME resolves to your resilient domain)

**Q8: An enterprise customer reports that after your application calls `https://api.thirdparty.com`, the first connection from each new service pod takes 3 seconds. All subsequent calls are fast (<10ms). How do you diagnose and fix this at the DNS level?**

A: The 3-second first-call latency from fresh pods is a classic DNS cold-start problem.

**Diagnosis:**

```bash
# On a fresh pod:
time curl -w "%{time_namelookup} %{time_connect} %{time_total}\n" \
  -o /dev/null https://api.thirdparty.com

# Output: 2.987 3.024 3.105
# 97% of time in name lookup → cold DNS resolution
```

Root cause analysis:

1. Pod started fresh → no OS DNS cache
2. Kubernetes `ndots:5` setting: `api.thirdparty.com` (2 dots < 5) → tries search domains first:
   - `api.thirdparty.com.default.svc.cluster.local` → NXDOMAIN
   - `api.thirdparty.com.svc.cluster.local` → NXDOMAIN
   - `api.thirdparty.com.cluster.local` → NXDOMAIN
   - THEN tries: `api.thirdparty.com.` → hits Route 53 resolver → 50ms
   - 3 NXDOMAIN queries first × 1s timeout each = 3s total
3. Third-party API endpoint may have a legitimately long TTL (e.g., 300s) → every 5 minutes, cold-start repeats

**Fix:**

Option A: Use FQDN with trailing dot in application config:

```yaml
# k8s ConfigMap
env:
  - name: PAYMENT_API_HOST
    value: "api.thirdparty.com." # trailing dot = FQDN, skips search domains
```

Option B: Set `ndots:2` in pod DNS config:

```yaml
spec:
  dnsConfig:
    options:
      - name: ndots
        value: "2" # only append search domains if ≤1 dot
```

Option C: Pre-warm DNS cache at startup (for connection pooling):

```python
# On pod startup, before accepting traffic:
import socket
socket.getaddrinfo("api.thirdparty.com", 443)  # warm the cache
# Now all subsequent calls hit OS cache, not DNS stack
```

Option D: Sidecar DNS cache (for high-volume deployments):

- Run `dnsmasq` or `NodeLocal DNSCache` (Kubernetes addon) as a sidecar
- All DNS queries hit local sidecar cache first
- Eliminates CoroDNS latency even for first queries after startup

---

**Continue to File 03** for AWS SAA exam traps, 5 comparison tables, quick revision memory tricks, and the architect exercise: designing a domain migration from on-premises to AWS with zero downtime for a company with 50+ subdomain-based services.
