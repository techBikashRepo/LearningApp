# HTTPS vs HTTP — Part 2 of 3

### Topic: HTTPS vs HTTP in Production Systems and AWS

**Series:** Networking Fundamentals → System Design → AWS Solutions Architect
**Sections Covered:** 5, 6, 7, 8

---

## SECTION 5 — Real World Examples

### Analogy 1 — The Notary and the Wax Seal

Imagine a medieval royal court where messengers delivered letters between kingdoms. The problem: how did recipients know a letter was genuinely from the King and not a forgery?

The King used a **private wax seal**. He'd press his unique signet ring into hot wax on the letter. To read the letter, you broke the seal. If the seal arrived broken: someone else opened it (in HTTP terms: compromised). If the seal was intact but didn't match the King's ring shape: forgery.

**The TLS Certificate = The royal seal.**
The Certificate Authority (DigiCert, Let's Encrypt) is like the kingdom's official seal registry. They verify "this IS the King" before assigning a seal pattern. Now when you receive a letter with "shop.com" seal, you check the registry: "Yes, that's the real shop.com seal, issued by a trusted authority."

The crucial difference: in TLS, you can verify the seal without contacting the registry every time — you already have a catalog of trusted patterns (root certificates). The verification is done locally, in milliseconds, cryptographically.

### Analogy 2 — The Armored Car vs Open Pickup Truck

**HTTP = Open pickup truck:**
Shipping cash in an open pickup truck. Anyone watching the road can see what's in the truck, grab the money, replace it with counterfeit, and put it back. The recipient doesn't know it was tampered with.

**HTTPS = Armored car with locked container:**
Cash is in a locked steel container. The lock uses a key that only the sender and recipient have (agreed in private before the shipment). The container is physically sealed with a tamper-evident mechanism. Even the truck driver can't see or modify the contents.

The armored car company (Certificate Authority) has verified the identities of both sender and recipient before issuing the lock and keys.

### Real Software Example — Let's Encrypt and ACM Adoption

**The pre-2015 world:** TLS certificates cost $100-500/year from commercial CAs. Purchasing, generating CSRs, waiting for validation, and manually installing certs was a laborious process. Many smaller sites simply didn't bother — HTTP was the default.

**2015: Let's Encrypt launched (free, automated certificates):**

```
Impact on HTTPS adoption:
  2016: ~50% of web traffic HTTPS
  2018: ~75%
  2021: ~90%+
  2024: ~95%+ (Chrome marks HTTP as "Not Secure")

Let's Encrypt key facts:
  Free: $0 per certificate
  Automated: ACME protocol, certbot tool
  Duration: 90 days (auto-renew prevents expiry)
  Trusted: Root cert in all major browsers and OS
  Scale: 400+ million active certificates (as of 2024)

ACME automation (certbot one-liner):
  certbot certonly --webroot -w /var/www/html -d shop.com -d www.shop.com
  # Downloads cert, validates via HTTP challenge, installs, schedules renewal
  # Human interaction: zero (after first setup)
```

**AWS ACM (AWS Certificate Manager):**

```
ACM certificates:
  Free: No charge for certs issued by ACM (for use with AWS services)
  Duration: 13 months (auto-renewed)
  Validation: DNS validation (recommended) or email validation
  Auto-renewal: YES for DNS-validated certs (ACM handles it silently)
  Use with: ALB, CloudFront, API Gateway, AppSync, CloudMap
  Cannot export: ACM certs are managed-service-only (can't install on EC2 directly)

  For EC2 / custom servers: Use ACM Private CA or Let's Encrypt

DNS validation (recommended):
  ACM gives you a CNAME record to add to your DNS:
    _abc123.shop.com → _xyz789.acm-validations.aws.
  ACM checks this CNAME periodically to validate domain control
  As long as CNAME exists: ACM can auto-renew silently forever

Email validation (avoid if possible):
  ACM sends validation email to domain admin contacts
  Must MANUALLY click approval link
  Auto-renewal: ACM sends email again 30-45 days before expiry
  If nobody clicks: certificate expires → production outage!
  Real incident pattern: email goes to generic inbox → missed → expired cert → OUTAGE
```

---

## SECTION 6 — System Design Importance

### 1. TLS Termination Architecture

Where you terminate TLS matters for both security and performance:

```
Option A: Edge TLS termination (ALB or CloudFront)

Browser ──[HTTPS]──► CloudFront ──[HTTPS]──► ALB ──[HTTP]──► Application
                   or
Browser ──[HTTPS]──► ALB ──[HTTP]──► Application server

Benefits:
  - TLS offloaded from application servers (CPU savings)
  - ALB/CloudFront handles TLS negotiation efficiently at scale
  - Application sees plain HTTP internally (simpler code)
  - Certificate management centralized at ALB/ACM

Security trade-off:
  - Traffic inside VPC is unencrypted HTTP
  - Acceptable IF VPC security groups enforce origin is ALB only
  - Insufficient if security/compliance requires encryption "in-transit" at all layers

Option B: End-to-end TLS (re-encryption)

Browser ──[HTTPS]──► ALB ──[HTTPS]──► Application server

ALB terminates HTTPS from clients, then creates a NEW HTTPS connection to backends.
Benefits: Traffic encrypted all the way to application server
Trade-off: Backend must have a certificate (can be self-signed or private CA cert)
Use when: PCI DSS, HIPAA, or other compliance mandates in-transit encryption everywhere

Option C: TLS passthrough (NLB)

Browser ──[HTTPS]──► NLB ──[HTTPS (unchanged)]──► Application server

NLB doesn't inspect or terminate TLS — passes raw TCP bytes through.
Application server handles TLS termination.
Trade-off: Cannot route based on HTTP headers (NLB sees only TCP, not HTTP)
           Cannot add X-Forwarded-For or use WAF
Use when: Custom TLS logic, certificate pinning enforced end-to-end, mutual TLS throughout
```

### 2. Perfect Forward Secrecy

A critical security property in modern TLS:

```
WITHOUT Perfect Forward Secrecy (old TLS with RSA key exchange):
  Client generates pre-master secret
  Client encrypts it with server's RSA PUBLIC KEY
  Client sends encrypted pre-master secret to server
  Server decrypts with RSA PRIVATE KEY → shared session key

  Vulnerability:
    Attacker records ALL encrypted traffic from 2020
    In 2025, attacker obtains the server's RSA private key (leaked, stolen, court order)
    Attacker decrypts the 2020 traffic retroactively → all past sessions exposed

WITH Perfect Forward Secrecy (Ephemeral Diffie-Hellman, used in TLS 1.3):
  Client and server each generate TEMPORARY (ephemeral) key pairs
  Exchange public portions → compute shared secret (Diffie-Hellman)
  The ephemeral private keys are DISCARDED after handshake
  Session keys derived from ephemeral exchange → used to encrypt session

  Security property:
    Even if server's LONG-TERM private key is compromised:
    → Ephemeral session keys are gone (never stored)
    → Past sessions CANNOT be decrypted
    → Each session has independent, temporary keys

TLS 1.3 MANDATES perfect forward secrecy:
  All TLS 1.3 cipher suites use ECDHE (Elliptic Curve Diffie-Hellman Ephemeral)
  TLS 1.2+ with ECDHE/DHE cipher suites: also PFS
  TLS 1.2 with RSA key exchange: no PFS (deprecated, disable)
```

### 3. OCSP Stapling — Certificate Revocation Without Latency

```
Problem: How does browser know if cert was revoked (before expiry)?

Option A: CRL (Certificate Revocation List)
  Browser downloads a list of revoked serial numbers from CA
  Problems: Large files (millions of entries), checked infrequently, latency

Option B: OCSP (Online Certificate Status Protocol)
  Browser asks CA: "Is cert #12345 still valid?"
  CA responds: "Valid" or "Revoked"
  Problems: Extra DNS + HTTP round-trip per HTTPS connection (+latency)
             Privacy issue: CA learns every website you visit
             CA OCSP server outage → browser can't check → soft-fail = proceed anyway

Option C: OCSP Stapling (solution)
  Server periodically requests its own certificate status from CA (every few hours)
  CA sends back a signed, timestamped OCSP response
  Server "staples" this response to the TLS handshake
  Client receives the OCSP response WITH the certificate (no extra round-trip needed)
  Client: "CA signed this 2 hours ago, says cert is valid" → trusted (within freshness window)

  NGINX config:
    ssl_stapling on;
    ssl_stapling_verify on;
    resolver 8.8.8.8 8.8.4.4 valid=300s;  ← DNS for OCSP lookup by server
```

### 4. HTTPS Performance (Dispelling the Myth That HTTPS Is "Slow")

Common misconception: "HTTPS adds significant latency." The reality in 2024:

```
Latency overhead (modern TLS 1.3):
  Extra round trip: 1 RTT for TLS handshake (after TCP's 1 RTT)
  CPU for encryption: negligible on modern hardware with AES-NI hardware acceleration

Real timing (typical web request in 2024):
  HTTP:  DNS(20ms) + TCP(20ms) + HTTP(50ms) = 90ms
  HTTPS: DNS(20ms) + TCP(20ms) + TLS(20ms) + HTTP(50ms) = 110ms
  Overhead: ~22% for first connection only

  With connection reuse (TLS session resumption):
  Subsequent requests reuse existing TLS session — 0ms additional overhead
  HTTP/2+HTTPS: Multiplexed requests over single TLS connection

TLS Session Resumption:
  After first handshake, server issues a Session Ticket (TLS 1.3) or Session ID
  Next connection: client presents ticket → server resumes → skips full handshake
  Reduces TLS overhead to ~0 for returning users

0-RTT (TLS 1.3 Early Data):
  Returning clients can send HTTP data BEFORE TLS handshake completes
  Uses session ticket to derive key → encrypt first request immediately
  Trade-off: No forward secrecy for 0-RTT data (replay attacks possible)
  Use cautiously: only for safe GET requests, not POSTs with side effects
```

---

## SECTION 7 — AWS Mapping

### AWS Certificate Manager (ACM)

```
ACM Certificate Types:
1. Public certificate (from ACM public CA):
   Free, browser-trusted, automatically renewed
   Available for: ALB, CloudFront, API Gateway, AppSync

2. Private certificate (from ACM Private CA):
   For internal services, microservices, VPN clients
   ACM Private CA: ~$400/month for the CA, plus per-cert fee
   Use for: Internal mTLS between microservices, IoT devices

Certificate deployment:
  Create cert → validate domain → deploy to service

ALB with ACM:
  Listeners → Add HTTPS listener (port 443) → Select ACM certificate
  ALB terminates TLS, adds X-Forwarded-Proto: https header
  Backend receives plain HTTP (or HTTPS if re-encryption configured)

CloudFront with ACM:
  MUST use us-east-1 region (N. Virginia) for CloudFront distributions
  Even if your origin is in ap-southeast-1 → cert must be in us-east-1
  Exam trap: Creating cert in wrong region → cannot attach to CloudFront

Certificate renewal:
  DNS-validated certs: auto-renewed silently (CNAME stays in DNS)
  Email-validated certs: manual click required → recommend DNS validation always

Multiple domains on one cert:
  SAN (Subject Alternative Name): add multiple domains in one cert
  *.shop.com covers: api.shop.com, admin.shop.com, www.shop.com
  Does NOT cover: shop.com itself (wildcard doesn't match apex) → add both *.shop.com AND shop.com
  Does NOT cover: sub.api.shop.com (wildcard is single level only)
```

### ALB TLS Policies

```
ALB supports multiple TLS security policies. Exam question patterns:
  "Which TLS policy should you choose for PCI DSS compliance?"
  "Customer using Windows XP IE8 can't connect to ALB. Why?"

Common TLS policies:
  ELBSecurityPolicy-TLS13-1-2-2021-06 (recommended):
    Supports: TLS 1.2 and TLS 1.3
    Cipher suites: ECDHE with AES-256-GCM (PFS)

  ELBSecurityPolicy-TLS13-1-3-2021-06 (most secure):
    Supports: TLS 1.3 ONLY
    Old clients (pre-TLS 1.3 support) cannot connect

  ELBSecurityPolicy-2016-08 (legacy support):
    Supports: TLS 1.0, 1.1, 1.2
    Allows old clients but weak cipher suites
    Use ONLY if you must support very old clients (Windows XP etc.)

When old client breaks: switch to policy supporting lower TLS version
When security audit requires: switch to TLS 1.3-only or TLS 1.2+ policy

HTTPS health checks:
  ALB → backend via HTTPS: ALB uses certificate on backend
  For self-signed certs on backend: enable "HTTPS" protocol but disable cert validation
  (ALB doesn't validate backend cert by default — use ACM or your own CA cert for full validation)
```

### CloudFront HTTPS Configuration

```
CloudFront viewer protocol policy:
  HTTP and HTTPS: allows both (not recommended)
  Redirect HTTP to HTTPS: redirect → 301 → HTTPS (recommended)
  HTTPS only: return 403 for HTTP requests (strictest)

CloudFront origin protocol policy:
  HTTP only: CloudFront → origin via HTTP (origin doesn't need cert)
  HTTPS only: CloudFront → origin via HTTPS (origin cert must be CA-trusted or ACM)
  Match viewer: CloudFront uses same protocol as viewer request (not recommended — complicates)

SNI vs Dedicated IP:
  SNI (default): Free. Requires client to support SNI (all modern clients do).
  Dedicated IP ($600/month per distribution): For clients that don't support SNI (old IE on XP).
  Modern recommendation: Always use SNI (dedicated IP is legacy/compliance edge case)

CloudFront custom SSL certificate:
  Default CloudFront domain: *.cloudfront.net cert (automatic, no custom cert needed)
  Custom domain (shop.com via CloudFront): ACM cert in us-east-1 required
  Add custom domain: CloudFront → General → Alternate domain names → add shop.com
```

### Route 53 HTTPS + Health Checks

```
Route 53 health checks for HTTPS endpoints:
  Create health check → HTTPS → https://shop.com/health → expect 200
  Check interval: 30s (standard) or 10s (fast, higher cost)
  Failure threshold: 3 consecutive failures → mark unhealthy

  Route 53 health check IPs:
    If you have an IP-allow list on your firewall, you must allow Route 53
    health check IP ranges: 54.228.16.0/26, 54.232.40.64/26 (and others, see docs)
    Forgetting this = health check fails → DNS failover triggers incorrectly

Route 53 DNS failover with HTTPS:
  Primary: ALB in us-east-1 (health check attached)
  Secondary: ALB in us-west-2 (failover)
  If health check fails on primary → Route 53 switches DNS to secondary in ~30s
  Both must be HTTPS with valid certs
```

---

## SECTION 8 — Interview Q&As

### Beginner Questions

**Q1: What is the difference between HTTP and HTTPS?**

A: HTTP (Hypertext Transfer Protocol) transmits data in plaintext — all request and response content is visible to anyone on the network path between client and server.

HTTPS is HTTP secured with TLS (Transport Layer Security). TLS adds three properties:

1. **Confidentiality**: traffic is encrypted — network observers see random bytes, not content
2. **Integrity**: every message has a cryptographic MAC — any tampering in transit is detected and rejected
3. **Authentication**: the server presents a TLS certificate signed by a trusted Certificate Authority, proving identity (prevents impersonation)

HTTPS operates on port 443 by convention (HTTP uses port 80). Functionally, HTTP protocol semantics are identical — GET, POST, status codes, headers all work the same. TLS is a layer beneath HTTP that encrypts the HTTP stream before it leaves the machine.

In 2024, HTTPS is effectively mandatory: Chrome marks HTTP sites as "Not Secure", browsers restrict HTTP APIs (geolocation, service workers, web crypto), and search engines rank HTTPS sites higher.

**Q2: What is a TLS certificate and who issues it?**

A: A TLS certificate is a digital document that binds a public key to a domain name, issued and signed by a Certificate Authority (CA) that browsers trust.

The certificate contains: the domain name (CN and SAN fields), the certificate's public key, validity period (start and end dates), the issuing CA's name, and the CA's digital signature over all of this.

When you connect to https://shop.com, the server presents this certificate. Your browser verifies:

1. The signature is valid (really issued by the stated CA)
2. The CA is in the browser's trusted root store (pre-installed by OS/browser vendors)
3. The domain in the certificate matches the site you're connecting to
4. The certificate hasn't expired
5. The certificate hasn't been revoked

Certificate Authorities: DigiCert, Let's Encrypt (free), Comodo, AWS ACM. Let's Encrypt changed the landscape by providing free, automated certificates — raising HTTPS adoption to 95%+.

**Q3: Why is "Not Secure" shown for HTTP sites in Chrome? Does this mean the site is dangerous?**

A: Chrome shows "Not Secure" for HTTP sites to indicate that any data submitted on that page (form inputs including passwords, credit cards, personal information) is transmitted in plaintext and could be read by anyone on the network.

"Not Secure" doesn't mean the site has vulnerabilities or a bad reputation — only that the connection itself is unencrypted. An HTTP news website with only public content poses minimal risk from the transport layer.

However, the warning IS significant for:

- Login forms (passwords go in plaintext to anyone on your WiFi)
- Payment forms (card numbers visible to network observers)
- User profile forms (PII transmitted unencrypted)

There are two threat models: (1) passive eavesdropping (someone recording traffic), easily defeated by HTTPS; (2) active MITM (someone between you and server injecting content), also defeated by HTTPS with HSTS. The "Not Secure" indicator is browser's way of surfacing this context.

### Intermediate Questions

**Q4: What is Perfect Forward Secrecy and why does it matter?**

A: Perfect Forward Secrecy (PFS) is a TLS property that ensures compromising the server's long-term private key does NOT allow decryption of past recorded traffic.

Without PFS (RSA key exchange in TLS 1.2): The client encrypted the session key using the server's RSA public key. The server's RSA private key decrypts it. If an adversary recorded all your HTTPS traffic for years and later obtained the server's private key (breach, legal discovery, five-years-later leak): they can decrypt everything retroactively.

With PFS (Ephemeral Diffie-Hellman): Both client and server generate TEMPORARY key pairs for each session. They exchange public portions and independently compute the same shared secret via Diffie-Hellman math. The ephemeral private keys are DISCARDED after the session ends. The server's long-term private key is NOT involved in key exchange — only in signing the certificate to prove identity.

Result: Even with the server's private key, recorded traffic cannot be decrypted (the ephemeral keys are gone).

TLS 1.3 mandates PFS — ALL cipher suites use ECDHE. TLS 1.2 supports PFS if you configure ECDHE/DHE cipher suites (disable RSA key exchange cipher suites).

**Q5: How does SNI work and why does it matter for CDN and multi-tenant systems?**

A: SNI (Server Name Indication) is a TLS extension where the client sends the target hostname in the first TLS message (ClientHello), BEFORE the TLS handshake completes.

The problem SNI solves: normal TLS requires the server to present a certificate before any HTTP headers are exchanged. But the HTTP `Host` header (which tells the server which site you want) comes AFTER TLS completes. Without SNI, each HTTPS website needed a dedicated IP address.

With SNI: Client sends "I want shop.com" in the ClientHello → server selects the correct certificate from its pool → presents it to the client → TLS handshake completes for the right domain.

Practical implications:

1. **CDN multi-tenancy**: CloudFront serves thousands of customer domains from the same IP addresses. SNI tells CloudFront which customer's cert to present.
2. **Cost**: Before SNI, each domain needed a dedicated IP on CloudFront ($600/month per distribution). With SNI (all modern clients support it): free.
3. **Privacy gap**: SNI is in PLAINTEXT in the ClientHello (before encryption). Network observers can see WHICH DOMAIN you're connecting to even on HTTPS connections. Encrypted Client Hello (ECH, in TLS 1.3 variants) addresses this.

**Q6: What happens when a TLS certificate expires in production? Walk through the impact.**

A: Certificate expiry is one of the most common, entirely preventable production incidents:

**Timeline of impact:**

```
T+0 (cert expiry):
  Server still works (it continues presenting the expired cert to clients)

T+0 + first client connection:
  Browser: "Certificate valid until 2026-01-01, today is 2026-01-02"
  Browser: NET::ERR_CERT_DATE_INVALID
  User sees: Red padlock, "Your connection is not private" full-page error
  User cannot proceed (by design — no "Advanced → Proceed" is shown for expired certs in latest browsers)

  API clients (mobile app, partner API):
  TLS library: ssl.SSLCertVerificationError: certificate has expired
  API calls fail → orders fail → transactions fail → revenue stops
```

**Detection:**

```
CloudWatch → ALB → HTTPCode_ELB_5XX_Count? No — client doesn't even reach ALB
Route 53 health check → HTTPS → fails immediately
Synthetic monitoring (CloudWatch Synthetics / Pingdom): first to alert
Customer support: "Site is broken, security warning"
```

**Recovery:**

1. Issue new certificate (Let's Encrypt: minutes, ACM: depends on validation)
2. Deploy to ALB/CloudFront
3. Verify with openssl: `openssl s_client -connect shop.com:443 | openssl x509 -noout -dates`

**Prevention (the correct solution):**

```
CloudWatch alarm on ACM certificate expiry:
  Metric: aws/acm DaysToExpiry
  Threshold: < 30 days → SNS alarm

Or use ACM DNS validation → auto-renews silently, never expires unintended

Let's Encrypt: certbot checks and renews every day if < 30 days remaining
Monitor: https://letsencrypt.org/docs/expiration-emails/
```

### Advanced System Design Questions

**Q7: Design the TLS architecture for a multi-tier application: CloudFront → ALB → ECS Fargate containers. What are the encryption options at each layer and what would you choose?**

A: Complete TLS architecture for multi-tier design:

**Layer 1: Client → CloudFront (always HTTPS)**

```
Viewer Protocol Policy: Redirect HTTP to HTTPS
TLS Policy: TLS 1.2+ (for compatibility) or TLS 1.3 (for strictest security)
Certificate: ACM cert in us-east-1 for custom domain
SNI: Yes (default)

CloudFront handles TLS termination here. Client only communicates over HTTPS.
```

**Layer 2: CloudFront → ALB (Origin)**

```
Origin Protocol Policy: HTTPS only (encrypt CloudFront-to-ALB traffic)
Certificate on ALB: ACM cert in same region as ALB (e.g., us-east-1)

Why: VPC traffic is generally private, but if compliance requires in-transit
encryption everywhere (HIPAA, PCI DSS): HTTPS from CloudFront to ALB is mandatory
```

**Layer 3: ALB → ECS Fargate containers**

```
Protocol: HTTPS (end-to-end encryption) OR HTTP (TLS termination at ALB)

Option A — HTTP from ALB to containers (most common):
  Simpler: no cert on containers
  ALB adds X-Forwarded-Proto: https header (app knows original was HTTPS)
  Acceptable if: VPC security groups prevent direct container access (only ALB can reach containers)

Option B — HTTPS from ALB to containers (end-to-end):
  Container runs NGINX with self-signed cert (or private CA cert from ACM Private CA)
  ALB HTTPS health check: enable, don't validate cert (or use ACM Private CA for full validation)
  Use when: PCI DSS Level 1, HIPAA, DoD IL4/IL5 requires encryption at every hop
```

**Decision matrix:**

```
Standard web app (E-commerce, SaaS):   CloudFront HTTPS → ALB HTTPS → HTTP containers
Compliance-heavy (healthcare, finance): CloudFront HTTPS → ALB HTTPS → HTTPS containers
Cost-sensitive:                         CloudFront HTTPS → ALB HTTP (cheaper by 1 TLS layer)
```

**Q8: A client reports they periodically receive TLS errors from your API. The errors only happen sporadically and resolve on retry. What are the likely causes?**

A: Sporadic TLS errors that resolve on retry suggest a few failure modes:

**Root Cause 1: Certificate mismatch behind load balancer**

```
Symptom: Some requests fail TLS verification, some succeed
Cause: Multiple servers behind ALB have different certificates
  Server A: cert for api.shop.com (valid)
  Server B: cert for old.api.shop.com (or self-signed)
  Some requests land on B → TLS error

Diagnosis: ssh to each target, run:
  openssl s_client -connect localhost:443 2>/dev/null | openssl x509 -noout -subject -dates
  Check all targets have same cert
Fix: Standardize certs (ACM-managed recommended)
```

**Root Cause 2: DNS cache TTL race with cert update**

```
Symptom: Errors during and shortly after cert rotation
Cause: Client cached old IP → new IP has new cert → mismatch
  (More common during migrations, rare in steady state)
```

**Root Cause 3: TLS session ticket key rotation**

```
Symptom: 0-RTT or session resumption fails → full handshake succeeds
Cause: TLS session ticket encryption keys rotated; client presents old ticket;
  some backends have old key version, some have new
  → 0-RTT fails silently → should fall back to full handshake
Fix: Ensure coordinated key rotation, verify clients do fall back gracefully
```

**Root Cause 4: Clock skew causing certificate validity check failure**

```
Symptom: Error "certificate is not yet valid" or similar
Cause: Server or client clock significantly incorrect
  Cert valid from 2026-01-01 → server clock says 2025-12-31 → "not yet valid!"
Fix: Ensure NTP sync on all servers; AWS instances: use Amazon Time Sync Service (169.254.169.123)
```

**Debugging approach:**

```
Capture the exact TLS error from client library:
  "certificate has expired" → wrong/expired cert on a backend
  "unknown CA" → cert chain incomplete (missing intermediate CA)
  "certificate name mismatch" → wrong domain in cert
  "handshake failure" → TLS version or cipher mismatch

OpenSSL diagnostic:
  openssl s_client -connect api.shop.com:443 -tls1_3 -status
  # Shows: cert chain, expiry, OCSP stapling, TLS version negotiated
```

---

## File Summary

This file covered:

- Notary wax seal + armored car analogies (CA verifies identity; TLS secures content in transit)
- Let's Encrypt's impact on HTTPS adoption (free certs, ACME automation, 90-day certs)
- ACM auto-renewal: DNS validation = fully automatic; email validation = human required → use DNS always
- TLS termination architecture: edge termination (ALB/CloudFront), end-to-end re-encryption, NLB passthrough
- Perfect Forward Secrecy: ephemeral keys per session → past traffic safe even if private key compromised
- OCSP stapling: server fetches and caches OCSP response → no client round-trip to CA needed
- HTTPS performance: 1 RTT overhead for first connection only; session resumption = 0 overhead
- AWS: ACM cert deployment (CloudFront = us-east-1 ONLY), ALB TLS policies, CloudFront viewer/origin protocol policies, SNI vs dedicated IP, Route 53 health checks for HTTPS
- 8 Q&As: HTTP vs HTTPS, TLS cert process, "Not Secure" explanation, PFS mechanism, SNI importance, cert expiry impact, multi-tier TLS architecture, sporadic TLS error diagnosis

**Continue to File 03** for AWS SAA certification traps, 5 comparison tables, Quick Revision mnemonics, and Architect Exercise: production cert expiry incident root-cause.
