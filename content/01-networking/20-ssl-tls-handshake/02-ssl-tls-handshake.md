# SSL/TLS Handshake — Part 2 of 3

### Topic: SSL/TLS Handshake in Production Systems and AWS

**Series:** Networking Fundamentals → System Design → AWS Solutions Architect
**Sections Covered:** 5, 6, 7, 8

---

## SECTION 5 — Real World Examples

### Analogy 1 — The Combination Lock That Nobody Handed Over

Imagine two strangers need to put something in a shared combination lock — but they must agree on the combination without meeting privately and without anyone listening to their phone call being able to figure out the combination.

Here is how they do it (Diffie-Hellman logic translated to everyday objects):

1. They agree publicly on a starting number, say 7.
2. Alice picks a secret number (say, 3). She computes 7³ = 343. She announces 343.
3. Bob picks a secret number (say, 5). He computes 7⁵ = 16807. He announces 16807.
4. Alice computes 16807³. Bob computes 343⁵. Both arrive at the same number: 7¹⁵.
5. Nobody listening to the public announcements (343 and 16807) can easily compute 7¹⁵ without knowing at least one of the private numbers (3 or 5).

They set the lock to 7¹⁵. The combination was never spoken aloud. This is what ECDH achieves in TLS — just with elliptic curve math that is computationally infeasible to reverse.

### Analogy 2 — The Passport and the Local Voucher System

In some countries, new residents don't automatically have a government ID. But they need one to access services. The system works like this:

- A national passport (Root CA) is trusted by everyone.
- Local councils (Intermediate CAs) are vouched for by the national passport authority.
- Local councils issue resident cards (Leaf Certificates) to individuals.

When you present your resident card at the library, the librarian doesn't call the national passport office. They verify: "This resident card was signed by the local council. The local council was authorized by the national passport authority. The national passport authority is in our known-trust database." All verification is done locally, with cryptographic signatures — no network round trip to the CA needed (except for revocation checks).

### Real Software Example — Cloudflare's TLS Observatory

**Before 2016: Internet-wide TLS problems**

```
2015-2016 widespread issues found by security researchers:
  "FREAK attack": Servers accepting export-grade RSA (512-bit keys)
    → attackers could factor the key in hours on a rented cloud server
  "POODLE attack": SSLv3 downgrade → padding oracle
  "DROWN attack": SSLv2 still enabled on servers → attacker could decrypt RSA sessions
    Note: even if YOUR server didn't use SSLv2, if your RSA private key
    was ALSO used on an SSLv2-enabled server → all your sessions vulnerable

2016 aftermath:
  All major CAs stopped issuing certs with SHA-1 signatures
  Browsers forced minimum TLS 1.0 (then 1.2, then deprecating 1.0/1.1 in 2020)
  PCI DSS 3.2: mandated TLS 1.2 minimum by June 2018

Current state (2024+):
  TLS 1.3 share: ~70% of all HTTPS connections (Chrome telemetry)
  TLS 1.2 share: ~29%
  TLS 1.0/1.1: <1% (deprecated in all modern browsers)
```

**Cloudflare TLS at scale:**

```
Cloudflare handles: millions of TLS handshakes per second
Key engineering challenges and solutions:

  Session ticket key rotation (every few hours):
    → Session tickets from old key can't be resumed: fallback to full handshake
    → Solution: 48-hour grace period with old keys during rotation

  0-RTT replay protection:
    Cloudflare maintains a distributed anti-replay cache
    First 0-RTT request: stored in cache (Redis-like)
    Second 0-RTT with same nonce: blocked
    Non-idempotent endpoints (POST): 0-RTT disabled at Cloudflare edge

  Certificate issuance latency (Universal SSL):
    New customer domain → cert issued in <2 minutes (Let's Encrypt ACME or DigiCert)
    Deployed to 200+ edge PoPs via dist-sys replication
    Cert appears "valid" to all users within 5 minutes of DNS pointing to Cloudflare

  Hardware acceleration:
    AES-NI CPU instructions: encrypt/decrypt at memory bus speed (~10 Gbps per core)
    Kernel TLS (kTLS): TLS encryption in kernel space, skips userspace copy → enormous throughput
```

---

## SECTION 6 — System Design Importance

### 1. TLS Handshake Cost in High-Traffic Systems

The handshake is not free. At scale:

```
Cost breakdown per TLS 1.3 handshake:
  CPU (server):
    ECDH computation: ~100,000 operations/second per CPU core (P-256 curve)
    RSA signature verification (client verifying server cert): ~10,000 ops/sec per core
    AES-256-GCM encryption: negligible with AES-NI hardware (10+ Gbps/core)

  Latency:
    1 RTT (TLS 1.3): adds ~20ms on same-continent connections
    2 RTT (TLS 1.2): adds ~40ms

  At scale:
    1,000 new connections/second → 1,000 ECDH computations/second
    10 CPU cores → 1M ECDH ops/second capacity → can handle 10,000 new TLS/sec

  Mitigation strategies:
    Session resumption: re-use previous session → 0 ECDH computation for returning users
    TLS hardware offload: dedicated crypto hardware (AWS uses this in ALB/CloudFront)
    Connection pooling: one TLS connection, many HTTP/2 requests (multiplexing)
    Keep-alive: don't close TCP connections between requests
```

### 2. Mutual TLS (mTLS) in Microservices

Standard TLS: only SERVER presents a certificate (server authentication).
Mutual TLS (mTLS): BOTH server AND client present certificates (bilateral authentication).

```
Standard TLS (most HTTPS sites):
  Browser (client): no cert       Server: presents cert
  I trust the server is real. Server doesn't need to know WHO I am (use session/JWT instead)

mTLS (zero-trust microservices):
  Service A (client): presents cert      Service B (server): presents cert
  Both verify each other before any request

  Why: In microservices, any service inside the VPC could be compromised.
  If Service A is compromised and there's no auth between services:
    Compromised A can call Service B (user database), Service C (payment) freely
  With mTLS:
    Compromised Service A has a cert identifying it as "service-a"
    Service B only accepts calls from "service-a" IF the call is for /load-balancer/health
    Service B denies calls from "service-a" to /admin/user-export (wrong cert for this endpoint)

mTLS handshake additions:
  After ServerHelloDone (TLS 1.2) or after exchanging certs (TLS 1.3):
    Server sends: CertificateRequest to client
    Client sends: its own Certificate + CertificateVerify
    Server verifies client certificate against trusted CA (same validation process)

Service Mesh mTLS (Istio/Envoy):
  Sidecar proxies handle mTLS transparently
  Application code sees plain HTTP to sidecar
  Sidecar → sidecar: full mTLS with auto-rotated certs (every 24h)
  Amazon App Mesh, AWS PrivateLink, AWS Cloud Map can use similar patterns
```

### 3. Certificate Rotation Without Downtime

```
Challenge: Rotate TLS cert every year (or 90 days for Let's Encrypt) without downtime

Problem if done naively:
  1. Remove old cert
  2. Install new cert
  → Window where cert is missing = TLS errors

Correct rotation procedure:
  1. Request new certificate (while old is still valid)
  2. Add new cert to server alongside old cert
     → Both certs active: SNI-based selection or dual binding
  3. Verify new cert works: curl --cacert new-root.pem https://shop.com
  4. Remove old cert

  With ALB (zero-downtime):
  1. Add new ACM cert to ALB listener (can have multiple certs)
  2. Set new cert as "default"
  3. Remove old cert
  → ALB serves new cert for new connections immediately, old connections unaffected

  With CloudFront (managed by ACM, fully automatic):
  → No manual rotation needed if DNS-validated ACM cert
  → ACM rotates cert ~60 days before expiry
  → CloudFront picks up new cert without any configuration change
```

### 4. Debugging TLS Issues

```
Common TLS problems and diagnostics:

Problem: "SSL handshake failed" (vague)
Diagnosis: openssl s_client -connect shop.com:443 -debug 2>&1 | head -50
          Look for: "alert handshake failure" → cipher or version mismatch

Problem: "certificate verify failed"
Diagnosis: openssl verify -CAfile /etc/ssl/certs/ca-bundle.crt shop.com.crt
          Common cause: missing intermediate CA in certificate chain

Problem: "certificate has expired"
Diagnosis: openssl x509 -in shop.com.crt -noout -dates
          Fix: renew cert; check ACM DaysToExpiry alarm

Problem: "hostname mismatch"
Diagnosis: openssl x509 -in shop.com.crt -noout -text | grep -A1 "Subject Alternative"
          Fix: reissue cert with correct SAN entries

Problem: Performance — TLS handshake taking >200ms
Diagnosis:
  curl -w "time_appconnect=%{time_appconnect}\n" https://shop.com
  time_appconnect includes TLS handshake time
  High value (>100ms): check if OCSP stapling is enabled (saves a CA round-trip)
  Check: echo | openssl s_client -connect shop.com:443 -status 2>&1 | grep "OCSP"

Problem: Clients using old TLS version
Diagnosis:
  ALB → CloudWatch → ClientTLSNegotiationErrorCount
  Filter by: access logs field "ssl_protocol" → count occurrences of TLSv1, TLSv1.1
```

---

## SECTION 7 — AWS Mapping

### AWS Certificate Manager (ACM) and Certificate Lifecycle

```
ACM Certificate Issuance Flow:
  Request public cert in ACM console or CLI:
    aws acm request-certificate \
      --domain-name "*.shop.com" \
      --subject-alternative-names "shop.com" \
      --validation-method DNS

  ACM returns: CertificateArn + CNAME record to add to DNS

  After CNAME added:
    ACM polls CNAME record every few minutes
    Validation detected → ACM Internal CA signs certificate → STATUS: Issued
    Time to issue: 5-30 minutes for DNS validation

  Certificate auto-renewal:
    ACM checks expiry continuously
    ~60 days before expiry: ACM verifies CNAME still in DNS
    If valid: re-issues cert → silently replaces on attached ALB/CloudFront
    If CNAME gone: ACM sends alert email → cert will expire if not fixed

ACM Private CA (for internal TLS):
  Used for:
    - mTLS in microservices (issue client + server certs from private CA)
    - Internal ALB / internal NLB with HTTPS
    - VPN client certificates
    - IoT device certificates

  Cost: ~$400/month per CA + $0.75 per certificate generated

  Integration with ACM:
    Create Private CA → Issue certs from it → Deploy to services
    aws acm-pca issue-certificate --certificate-authority-arn arn:... --csr file://csr.pem
```

### ALB TLS Configuration

```
ALB TLS policies control allowed TLS versions and cipher suites:

Recommended production policies (2024):
  ELBSecurityPolicy-TLS13-1-2-2021-06:
    Allows: TLS 1.2, TLS 1.3
    Cipher suites: ECDHE only (PFS mandatory)
    Disables: RSA key exchange, 3DES, RC4

  ELBSecurityPolicy-TLS13-1-3-2021-06:
    Allows: TLS 1.3 ONLY
    Use when: all clients are modern (2019+)
    Denies legacy clients gracefully

ALB Mutual TLS (mTLS):
  Added by AWS in 2023: ALB natively supports mTLS
  Configuration:
    Create Trust Store: upload CA cert bundles (PEM) that issued client certs
    Attach Trust Store to ALB HTTPS listener
    Mode:
      verify (mandatory): reject any client without valid cert
      passthrough: forward TLS handshake to targets (NLB-style)

  Client cert forwarded as HTTP header:
    X-Amzn-Mtls-Clientcert: <URL-encoded PEM>
    X-Amzn-Mtls-Clientcert-Serial-Number: 1234ABCD
    X-Amzn-Mtls-Clientcert-Subject: CN=service-a,O=MyOrg
  Application reads headers to extract client identity

ALB access logs showing TLS details:
  Field: ssl_protocol → TLSv1.3, TLSv1.2
  Field: ssl_cipher → ECDHE-RSA-AES128-GCM-SHA256
  Field: chosen_cert_arn → which cert was selected (SNI)
  Useful for audit: count TLSv1 connections, identify clients needing upgrade
```

### CloudFront TLS Deep Dive

```
CloudFront TLS termination:
  - Terminates TLS at edge PoP (~400 worldwide)
  - Client → CloudFront: full TLS (cert for your domain)
  - CloudFront → Origin: new TLS session (cert for your origin domain)

Security policies (Viewer Protocol):
  Redirect-HTTP-To-HTTPS: 301 all HTTP → HTTPS
  HTTPS-Only: 403 for HTTP (strictest)
  HTTP-And-HTTPS: allow both (not recommended)

Origin TLS settings:
  Minimum Origin SSL Protocol: TLS 1.2 (recommended default)
  Origin Protocol Policy:
    https-only → origin MUST have CA-trusted cert
    http-only → CloudFront→origin is plain HTTP (origin doesn't need cert)
    match-viewer → mirrors client's protocol (rarely useful)

  Important: CloudFront validates origin's TLS cert by default
  If origin cert is self-signed or expired → CloudFront error 502 or 525

TLS 1.3 on CloudFront:
  CloudFront automatically uses TLS 1.3 when client supports it
  No configuration needed
  Verified by: openssl s_client -connect shop.cloudfront.net:443 | grep "Protocol"

Field-Level Encryption:
  CloudFront can encrypt specific form fields at the edge using your RSA public key
  Only application possessing the RSA private key can decrypt the fields
  Use case: Credit card numbers stay encrypted all the way through CloudFront → ALB → App
  App at backend decrypts only the sensitive field, never decrypted by load balancer or edge
```

### AWS IoT and mTLS

```
AWS IoT Core uses mTLS exclusively:
  Every IoT device has a unique X.509 certificate
  Device connects to AWS IoT broker via TLS with its cert
  AWS IoT verifies device cert against IoT CA

  Device onboarding:
    aws iot create-keys-and-certificate --set-as-active > cert_and_key.json
    Returns: certificateArn, certificateId, keyPair (pub+priv), certificatePem

  Device policy (JSON): controls what MQTT topics device can publish/subscribe
  If device cert is revoked: policy denies all operations → device locked out

  Certificate rotation:
    Fleet provisioning: new cert pushed via IoT Job
    Just-in-time provisioning: device registers its own cert at first connect
```

---

## SECTION 8 — Interview Q&As

### Beginner Questions

**Q1: What is the difference between SSL and TLS? What does "SSL certificate" mean today?**

A: SSL (Secure Sockets Layer) was the original protocol created by Netscape in the mid-1990s. TLS (Transport Layer Security) is its successor, first standardized as TLS 1.0 in 1999 as a significant re-design of SSL 3.0.

SSL versions 1.0, 2.0, and 3.0 are all deprecated and cryptographically broken. TLS 1.0 and 1.1 are also deprecated and disabled in all modern browsers as of 2020. TLS 1.2 (2008) and TLS 1.3 (2018) are the current standards.

The term "SSL certificate" is colloquial and technically incorrect — the certificates used today are X.509 certificates, issued under TLS infrastructure. The certificate format hasn't changed significantly from SSL to TLS. When vendors say "buy an SSL certificate," they mean a TLS certificate. The backward-compatible naming stuck because of market familiarity.

Practically: when someone says SSL, they mean TLS. When you see "SSL/TLS," treat it as "TLS."

**Q2: What does "end-to-end encryption" mean, and does HTTPS provide it?**

A: End-to-end encryption (E2EE) means only the communicating endpoints (sender and recipient) can read the messages. Intermediaries (ISPs, service providers, CDN edges, load balancers) cannot read the content.

HTTPS/TLS does NOT provide true end-to-end encryption in most deployments. Why:

- TLS terminates at the edge (CloudFront, ALB, Nginx)
- The intermediate server sees the plaintext
- CloudFront decrypts your HTTPS request, reads the HTTP headers, then creates a NEW TLS connection to the origin

True E2EE: Signal protocol (messaging), PGP email (email), WhatsApp. In these cases, messages are encrypted on the sender's device and can only be decrypted by the recipient's device. Even the service provider's servers cannot read the content.

HTTPS provides: transport security (safe from eavesdropping between participants), authentication (you're talking to the real server), and integrity. It does not prevent the server itself from reading your data.

**Q3: What happens if a website's TLS certificate is signed by an unknown CA?**

A: The browser shows a warning page: "Your connection is not private" / "NET::ERR_CERT_AUTHORITY_INVALID" and blocks the page load (with an option to "Proceed Anyway" — not shown for expired certs, but shown for unknown CA).

Root CAs must be manually trusted by the browser/OS vendor:

- Apple, Microsoft, Mozilla, Google each maintain their own root CA stores
- CA programs have strict auditing requirements (WebTrust, ETSI)
- If a CA is caught misbehaving (issuing fraudulent certs), it's removed from all root stores instantly → all its certs become untrusted

Common legitimate cases for non-trusted CA warnings:

- Self-signed certificates (development/internal use)
- Corporate MITM proxies (intentionally MITM HTTPS to inspect enterprise traffic) — IT teams push the company root CA to all enterprise devices, making the warning disappear
- Test environments

---

### Intermediate Questions

**Q4: What is the TLS "downgrade" attack and how does TLS 1.3 prevent it?**

A: A downgrade attack: adversary sits between client and server, intercepts the TLS ClientHello, and strips out TLS 1.3 support → forcing negotiation to TLS 1.2 or older → TLS 1.2 may have exploitable weaknesses (POODLE with CBC, BEAST attack, etc.).

In TLS 1.2: Both parties send their preferred cipher suites and version, then pick the highest common one. An attacker who can modify the ClientHello in transit could downgrade the version.

TLS 1.3 downgrade prevention:

1. **Downgrade sentinel in ServerRandom**: If a TLS 1.3-capable server is forced to negotiate TLS 1.2 (by a ClientHello that claimed to only support 1.2), the server embeds a special marker in the last 8 bytes of server_random: the bytes "DOWNGRD\x01". A TLS 1.3-capable client MUST check for this sentinel and MUST abort if found — proving the downgrade was forced, not legitimate.

2. **Negotiation authenticated by Finished**: The Finished message is an HMAC of ALL handshake messages. Any tampering with version negotiation would change the hash → Finished would fail → connection terminated.

3. **Removed cipher suites**: TLS 1.3 removed all cipher suites vulnerable to known downgrade attacks (no CBC, no RC4, no RSA key exchange).

**Q5: Your HTTPS API has high latency on the first request from new clients, but fast on subsequent requests. What is likely happening and how do you fix it?**

A: The first request incurs:

1. DNS lookup (~10-50ms)
2. TCP handshake (~20-100ms)
3. TLS handshake (~20-100ms) ← the bottleneck
4. HTTP request/response (~10-50ms)

Total first request: 60-300ms. Subsequent requests in same session: only HTTP time (10-50ms).

The TLS handshake delay is: 1 RTT (TLS 1.3) or 2 RTT (TLS 1.2). If your API server is on TLS 1.2 with no session resumption, every new TCP connection requires 2 TLS RTTs.

Fixes:

1. **Upgrade to TLS 1.3**: reduces TLS from 2 RTT to 1 RTT → cuts TLS overhead in half
2. **Enable TLS session tickets**: returning clients skip the full handshake entirely
3. **Enable OCSP stapling**: removes the ~50ms OCSP lookup the client would otherwise make
4. **Use HTTP/2**: multiplexes multiple API calls over one TLS connection → amortizes handshake cost across many requests
5. **Enable connection keep-alive**: keeps TCP+TLS connection open → reused for subsequent requests
6. **Measure**: `curl -w "time_namelookup=%{time_namelookup}\ntime_connect=%{time_connect}\ntime_appconnect=%{time_appconnect}\n" https://api.shop.com`

**Q6: What is a Certificate Transparency (CT) log and what problem does it solve?**

A: Certificate Transparency (CT) is a public, append-only log system (Merkle tree based) where every publicly issued TLS certificate MUST be recorded. Browsers (Chrome since 2018) refuse to accept certificates that haven't been logged.

Problem it solves: Rogue CA certificate issuance. Before CT:

- A CA (or government with CA access) could issue a valid certificate for google.com
- This certificate would be trusted by all browsers (signed by a trusted root CA)
- Attacker could perform MITM on Google's traffic — and targeted victims would see no warning
- Nobody would know it happened

With CT:

- The rogue cert must be submitted to public logs before browsers accept it
- Google (and others) run "log monitors" that scan all CT logs for unexpected certs for their domains
- Rogue cert for google.com → Google's monitors detect it within minutes → emergency: revoke CA certificate or report to browser vendors
- You can set up cert-spotter.io to email you when any cert for your domain is logged
- Also enables auditing: "what certificates were issued for my domain in the last year?"

---

### Advanced System Design Questions

**Q7: Design TLS infrastructure for 10,000 microservices using mTLS, where certs must auto-rotate every 24 hours without service restarts.**

A: This is a service mesh certificate management problem:

```
Architecture: HashiCorp Vault PKI + Envoy Sidecar (or AWS Certificate Manager Private CA + AWS App Mesh)

Component 1: Certificate Authority
  HashiCorp Vault PKI engine (OR ACM Private CA)
  Root CA: offline, air-gapped
  Intermediate CA: online, in Vault
  Vault issues 24-hour certs for each service identity

Component 2: SPIFFE/SPIRE (workload identity)
  Each workload gets a SPIFFE ID: spiffe://shop.com/service/payments
  SPIRE agent on each node: proves workload identity to SPIRE server via node attestation
  SPIRE server: verified identity → SVID (SPIFFE Verifiable Identity Document) = X.509 cert

Component 3: Envoy sidecar (handles TLS transparently)
  Application: writes to localhost:8080 (plain HTTP)
  Envoy intercepts → wraps in mTLS → sends to target service's Envoy
  Target Envoy: terminates mTLS → delivers plain HTTP to application
  Application: never handles certs

Component 4: Certificate hot-reload
  Envoy SDS (Secret Discovery Service) protocol:
    SPIRE pushes new cert to Envoy via SDS gRPC stream
    Envoy atomically replaces cert for NEW connections
    In-flight connections complete with old cert
    No restart, no dropped connections

Component 5: mTLS policy
  Istio AuthorizationPolicy:
    service A → service B: allowed
    service A → service C: denied (not in policy)
    Any service without valid cert: denied

Monitoring:
  Prometheus: cert_expiry_seconds gauge per service
  Alert: cert_expiry < 12h (should never happen with 24h certs + hourly rotation)
  Audit log: all cert issuances → Vault audit log → S3 → analyze with Athena
```

**Q8: A financial services company wants to ensure TLS private keys are never exposed — even to their own engineers. How would you architect this?**

A: Private key protection requires hardware-backed key storage:

**Option 1: AWS CloudHSM (hardware security module)**

```
CloudHSM: dedicated hardware cryptographic module
  - Keys CANNOT be exported, not even by AWS employees
  - FIPS 140-2 Level 3 certified
  - Application uses CloudHSM for all signing operations:
    - TLS handshake: CloudHSM signs the CertificateVerify message using private key
    - Application never sees private key bytes

Integration:
  nginx/OpenSSL → OpenSSL engine for CloudHSM → key reference (not key material)
  All crypto operations happen inside HSM hardware

Cost: ~$1.45/hour per HSM (minimum 2 for HA) = ~$2,000/month minimum
```

**Option 2: ACM (AWS Certificate Manager)**

```
ACM's key design: private keys are NEVER accessible to customers
  When ACM issues a cert:
    ACM generates key pair entirely within AWS KMS (HSM-backed)
    Private key: never exported, never viewable
    Cert deployment: ACM deploys cert+key reference to ALB/CloudFront
    ALB/CloudFront do TLS operations using key reference (not key bytes)

  Even if your engineers have full AWS console access:
    They can see the certificate, not the private key
    aws acm export-certificate → returns cert + chain, BUT private key export
      requires a passphrase AND is only possible for private CA-issued certs
      (public ACM certs: private key is NEVER exportable, by design)

  This is exactly the architecture financial services needs:
    Compliance evidence: "Private keys reside in FIPS 140-2 validated HSMs.
    No human or automated process can retrieve private key material."
    SOC2/PCI DSS audit: ACM's compliance documentation covers this claim.
```

---

## File Summary

This file covered:

- Diffie-Hellman as everyday objects (7³ × 7⁵ = 7¹⁵ shared number)
- Passport chain of trust analogy (national CA → local council → resident card)
- Cloudflare TLS at scale: session ticket key rotation, 0-RTT replay protection, hardware crypto
- TLS handshake CPU cost analysis and mitigations at scale
- Mutual TLS (mTLS) in microservices: why, how, and ALB native mTLS support
- Certificate rotation without downtime: ALB multi-cert technique
- TLS debugging tools: openssl s_client, curl timing variables
- AWS: ACM cert lifecycle, ACM Private CA, ALB TLS policies + mTLS, CloudFront TLS config
- 8 Q&As: SSL vs TLS naming, HTTPS vs E2EE, unknown CA behavior, TLS downgrade attacks, first-request latency, CT logs, mTLS at 10K services, private key protection with CloudHSM and ACM

**Continue to File 03** for AWS SAA exam traps, 5 comparison tables, Quick Revision mnemonics, and Architect Exercise.
