# HTTPS vs HTTP — Part 3 of 3

### Topic: HTTPS vs HTTP — AWS SAA Certification, Revision & Architecture

**Series:** Networking Fundamentals → System Design → AWS Solutions Architect
**Sections Covered:** 9, 10, 11, 12

---

## SECTION 9 — AWS SAA Certification Focus

### What the Exam Tests (and the Traps)

AWS SAA questions on HTTPS and TLS fall into predictable patterns. Most test whether you know the certificate deployment constraints, understand TLS termination options, and can identify why something would fail or break.

### Trap 1: ACM Certificate Region Requirements

**The single most frequently tested ACM rule:**

| Service                    | Certificate must be in                     |
| -------------------------- | ------------------------------------------ |
| **CloudFront**             | **us-east-1 (N. Virginia) — ALWAYS**       |
| ALB                        | Same region as the ALB                     |
| API Gateway Regional       | Same region as the API                     |
| API Gateway Edge-optimized | us-east-1 (Edge-optimized uses CloudFront) |

```
Exam scenario (word-for-word pattern):
  "A solutions architect has requested an ACM certificate for shop.com
   to use with a CloudFront distribution. The certificate was issued
   in ap-southeast-1. The CloudFront distribution in us-east-1 cannot
   find the certificate. What is the cause?"

  Answer: ACM certificates for CloudFront MUST be requested in us-east-1.
  The certificate must be re-issued in us-east-1 and the CloudFront
  distribution updated to reference it.

Common wrong answer: "Enable certificate replication across regions"
  (ACM public certs are NOT replicated — you must create in the right region)

Memory trick: CloudFront is a GLOBAL service → its "home region" = us-east-1.
All global AWS services (IAM, CloudFront, Route 53) work from us-east-1.
```

### Trap 2: ACM Auto-Renewal Requires DNS Validation

```
Exam scenario:
  "A company has ACM certificates that keep expiring despite auto-renewal
   being enabled. What is the most likely cause?"

  Answer: The certificates use email validation. Email-validated certificates
  require manual intervention for renewal — ACM sends a validation email that
  must be manually approved. If the email goes unnoticed or to a stale inbox,
  the cert expires.

  Correct fix: Re-issue all certificates using DNS validation (adding CNAME
  records to Route 53 or external DNS). DNS-validated certs auto-renew silently
  as long as the CNAME record remains in place.

DNS Validation CNAME:
  ACM creates a record like: _abc123.shop.com CNAME _xyz789.acm-validations.aws.
  ACM queries this CNAME every few hours to verify you still own the domain
  If CNAME exists: ACM re-issues automatically before expiry (no action needed)
  If CNAME is removed: ACM cannot renew → cert expires

  Best practice: Never delete the ACM validation CNAME record.
  If managing via Route 53: ACM can add the record automatically (one click).
```

### Trap 3: SNI Custom SSL vs Dedicated IP (and the $600/month Trap)

```
Exam scenario:
  "Users of an older Windows XP Internet Explorer 8 browser report they
   cannot access a CloudFront distribution with HTTPS. Other browsers work.
   What is the cheapest solution?"

  Answer choices typically:
  A. Enable TLS 1.0 support in CloudFront → WRONG (SNI issue, not TLS version)
  B. Switch to Dedicated IP SSL ($600/month per distribution) → CORRECT
  C. Issue a new certificate with extended validation → WRONG
  D. Enable HTTP fallback → WRONG (not a CloudFront feature)

  Root cause: Windows XP IE8 does NOT support SNI.
  SNI custom SSL = free, works for all modern clients (post-2012)
  Dedicated IP SSL = $600/month, works for legacy clients without SNI

  Exam pattern: If "old client" + "Windows XP / legacy browser" → Dedicated IP SSL
  If "all modern clients fail" → different issue (cert, TLS policy, etc.)

Important: Dedicated IP SSL is LEGACY. Modern recommendation is always SNI custom SSL.
Most exam questions testing this distinguish between the two options by client age.
```

### Trap 4: NLB TCP Passthrough for mTLS

```
Exam scenario:
  "A microservices architecture requires that each service authenticate to
   every other service using mutual TLS (mTLS), with client certificates
   validated by all services. Which load balancer configuration enables this?"

  Trap: Most architects default to ALB.

  ALB limitation: ALB TERMINATES TLS. It cannot pass through the client certificate
  to the backend unchanged. While ALB supports mutual TLS via certificate headers
  (X-Amzn-Mtls-Clientcert), the TLS session ends at the ALB — the backend only
  sees the certificate forwarded as an HTTP header, not an actual TLS client cert.

  True end-to-end mTLS: Use NLB in TCP listener mode (pass-through):
    NLB TCP listener → raw TCP forwarded to backend → backend handles complete TLS
    including verifying client certificate from the original client

  ALB mutual TLS (supported in newer ALB feature):
    ALB validates client cert → forwards cert info as header
    Backend verifies header (simpler end-to-end)
    This is a newer ALB feature that some exam versions already test

  Exam rule of thumb:
    True TLS passthrough required → NLB (TCP mode)
    TLS termination + optional mutual auth header forwarding → ALB
```

### Trap 5: ALB Backend Certificate Validation

```
Exam scenario:
  "An ALB is configured with an HTTPS listener and forwards traffic to ECS
   containers over HTTPS. The ALB health checks return Unhealthy for all targets.
   The containers are running correctly. What is wrong?"

  Likely cause: The backend containers have self-signed certificates.
  ALB can be configured to:
    A. NOT validate backend certificates (default behavior for some configurations)
    B. Validate backend certificates against trusted CAs

  If ALB is set to validate and backend has self-signed cert → Health Check fails → Unhealthy

  Fix option 1: Disable backend certificate verification on ALB target group
    (For internal traffic within VPC where identity is established via security groups)

  Fix option 2: Issue backend certs from ACM Private CA
    ACM Private CA cert can be trusted by ALB → validation passes
    (For environments requiring full cert validation, e.g., PCI DSS)

  Fix option 3: Use HTTP for ALB-to-backend (accept TLS termination at ALB)
    Only viable if security posture allows internal HTTP within VPC

Backend HTTPS health check != Frontend HTTPS:
  Frontend: ALB validates NOTHING about client certs (ALB is server)
  Backend: ALB IS the client → ALB validates server (backend) cert
```

### Trap 6: CloudFront + WAF Requires HTTPS

```
Exam scenario:
  "A company wants to use AWS WAF to protect their web application. The
   CloudFront distribution currently has a viewer protocol policy of
   'HTTP and HTTPS'. SQL injection attempts succeed through the HTTP path.
   What is happening?"

  Answer: WAF inspects HTTP payloads, but HTTP payloads arrive unencrypted.
  Actually — WAF CAN inspect HTTP requests. But the real issue is:

  WAF cannot inspect ENCRYPTED payloads without TLS termination.
  WAF on CloudFront sees decrypted content (CloudFront terminates TLS first).

  The actual exam trap is different:
  "WAF rule is passing HTTP requests without inspection because HTTP is
  not being redirected to HTTPS → attacker uses HTTP endpoint to bypass WAF rule
  that was configured expecting HTTPS behavior"

  Fix: Set viewer protocol policy to "Redirect HTTP to HTTPS" or "HTTPS Only"
  This ensures ALL traffic goes through HTTPS → WAF sees all traffic uniformly
  HTTP bypass = real attack vector if WAF rules reference HTTPS-specific headers
```

---

## SECTION 10 — 5 Comparison Tables

### Table 1: HTTP vs HTTPS

| Dimension              | HTTP                                                        | HTTPS                                                   |
| ---------------------- | ----------------------------------------------------------- | ------------------------------------------------------- |
| Port                   | 80 (default)                                                | 443 (default)                                           |
| Encryption             | None                                                        | TLS (AES-256-GCM in TLS 1.3)                            |
| Authentication         | None                                                        | Server cert (+ client cert in mTLS)                     |
| Data integrity         | None                                                        | MAC per TLS record                                      |
| Certificate required   | No                                                          | Yes (public CA or private CA)                           |
| Browser indicator      | "Not Secure" warning (Chrome 68+)                           | Padlock icon                                            |
| Performance            | Baseline                                                    | +1 RTT (first connection); ~0 overhead after resumption |
| SEO                    | Neutral / slight penalty                                    | Slight ranking boost (Google)                           |
| Browser API access     | Blocked: Service Workers, Geolocation, Web Crypto, Push API | Allowed                                                 |
| AWS ALB requirement    | No                                                          | Yes (need HTTPS listener + cert)                        |
| HTTP/2 in browsers     | Not supported                                               | Required (browsers only do HTTP/2 over HTTPS)           |
| Cookie SameSite=Secure | N/A                                                         | Required for Secure-flagged cookies                     |

### Table 2: TLS 1.2 vs TLS 1.3

| Dimension               | TLS 1.2                                 | TLS 1.3                                              |
| ----------------------- | --------------------------------------- | ---------------------------------------------------- |
| Handshake RTT           | 2 RTT (TCP) + 2 additional = slow       | 1 RTT (1 additional after TCP)                       |
| Session resumption      | Session ID / Session Ticket (1 RTT)     | Session Ticket (0-RTT possible)                      |
| 0-RTT                   | No                                      | Yes (with replay risk)                               |
| Perfect Forward Secrecy | Optional (ECDHE cipher suites)          | Mandatory (always PFS)                               |
| Cipher suites           | Many (some weak): RSA, DHE, ECDHE, 3DES | 5 (all strong): AES-128-GCM, AES-256-GCM, CHACHA20   |
| RSA key exchange        | Allowed (no PFS)                        | Removed completely                                   |
| Deprecated ciphers      | Requires manual config to disable       | Removed by spec                                      |
| Browser support         | All modern browsers                     | All modern browsers (Chrome 66+, Firefox 63+)        |
| AWS ALB support         | Yes                                     | Yes (ELBSecurityPolicy-TLS13-\* policies)            |
| Middlebox inspection    | Works (RSA exchange visible)            | Often breaks enterprise MITM proxies (intentionally) |
| Encrypted handshake     | Partial (cert exposed in plaintext)     | More protected (most fields encrypted earlier)       |

### Table 3: Certificate Options Comparison

| Option                 | Cost                        | Validity     | Auto-renewal                      | Browser-trusted    | Use case                                                |
| ---------------------- | --------------------------- | ------------ | --------------------------------- | ------------------ | ------------------------------------------------------- |
| **ACM Public Cert**    | Free                        | 13 months    | Yes (DNS validation) / No (email) | Yes (public)       | ALB, CloudFront, API Gateway on AWS                     |
| **Let's Encrypt**      | Free                        | 90 days      | Yes (certbot cron)                | Yes                | EC2, on-premise, non-AWS services                       |
| **Commercial CA (DV)** | ~$50-300/yr                 | 1-2 years    | Varies                            | Yes                | General purpose, non-AWS environments                   |
| **Commercial CA (OV)** | ~$200-800/yr                | 1-2 years    | Varies                            | Yes                | Shows org name in cert; business sites                  |
| **Commercial CA (EV)** | ~$300-1500/yr               | 1-2 years    | Manual                            | Yes                | Green bar (mostly deprecated); regulated industries     |
| **ACM Private CA**     | $400/mo for CA + $0.75/cert | Configurable | Configurable                      | No (private trust) | Microservices, internal services, mTLS, VPN             |
| **Self-signed**        | Free                        | Configurable | No                                | No (manual only)   | Development, internal testing, ALB backend certs in VPC |

### Table 4: TLS Termination Strategies

| Strategy            | Where TLS ends                    | Frontend            | Backend                         | Security level | Use case                               |
| ------------------- | --------------------------------- | ------------------- | ------------------------------- | -------------- | -------------------------------------- |
| **Edge only**       | CloudFront                        | HTTPS               | HTTP to ALB, then HTTP to EC2   | Medium         | Simple public web apps                 |
| **Edge + ALB**      | ALB                               | HTTPS               | HTTP to containers/EC2          | Medium-high    | Standard production architecture       |
| **End-to-end**      | Application server                | HTTPS               | HTTPS at every layer            | Highest        | PCI DSS, HIPAA, financial services     |
| **NLB passthrough** | Application server                | HTTPS               | Same TLS session passes through | Highest + mTLS | True mTLS, protocol-specific TLS       |
| **Mutual TLS**      | ALB (with client cert forwarding) | HTTPS + client cert | HTTP + cert header forwarded    | High           | Service mesh, API auth, financial APIs |

### Table 5: Certificate Validation Types (DV vs OV vs EV)

| Dimension             | DV (Domain Validation)                 | OV (Organization Validation)          | EV (Extended Validation)                              |
| --------------------- | -------------------------------------- | ------------------------------------- | ----------------------------------------------------- |
| What CA verifies      | Domain control only                    | Domain + org legal existence          | Domain + org + full vetting                           |
| Verification time     | Minutes (automated)                    | 1-5 days                              | 1-7 days                                              |
| Browser padlock       | Standard padlock                       | Standard padlock                      | Standard padlock (EV green bar removed in Chrome 69+) |
| Certificate SAN       | Domain names                           | Domain names + org details            | Domain names + legal entity                           |
| Cost                  | Free (Let's Encrypt, ACM) to ~$300/yr  | ~$200-800/yr                          | ~$300-1500/yr                                         |
| Auto-renewable        | Yes (DV, with ACME)                    | Difficult to fully automate           | Rarely automated (human review)                       |
| Best for              | Most websites, APIs, internal services | Business sites where org name matters | High-value financial, banking (subjective benefit)    |
| ACM supports          | Yes (ACM = DV certificates)            | No (ACM does not issue OV certs)      | No (ACM does not issue EV certs)                      |
| Modern recommendation | Default choice for 95% of use cases    | If contractual/compliance requirement | Legacy compliance requirement only                    |

---

## SECTION 11 — Quick Revision

### 10 Key Points to Memorize

1. **HTTPS = HTTP + TLS.** TLS adds: Confidentiality (encrypt), Integrity (MAC), Authentication (cert). Three properties, memorize CIA.

2. **TLS 1.3: 1 RTT handshake.** Ephemeral ECDH key in ClientHello → server responds with ServerHello + Cert + Finished → 1 RTT total. PFS mandatory.

3. **Certificate chain: Leaf → Intermediate → Root.** Root CA is physically offline (hardware security module in a vault). Intermediate CA signs leaf certs.

4. **SNI = multi-HTTPS per IP.** Client sends target hostname in ClientHello (plaintext). Server selects matching cert. Enables CloudFront to serve thousands of domains from shared IP.

5. **HSTS: browser enforces HTTPS.** `Strict-Transport-Security: max-age=31536000` → browser never sends HTTP to this domain for 1 year. Preload = hardcoded in browser binary.

6. **ACM CloudFront cert MUST be in us-east-1.** Always. No exceptions. Most tested ACM rule on AWS SAA.

7. **ACM auto-renews ONLY with DNS validation.** DNS-validated cert + CNAME in place = auto-renew forever. Email-validated cert = human must click renewal email → expiry risk.

8. **PFS: ephemeral keys per session.** Session keys derived from temporary ECDH exchange. Old sessions cannot be decrypted even if server's private key is later compromised.

9. **NLB TCP passthrough for true mTLS.** ALB terminates TLS (cannot pass client cert through unchanged). NLB in TCP mode passes raw TLS — backend performs full TLS including client cert validation.

10. **Certificate expiry → monitor DaysToExpiry.** CloudWatch metric `aws/acm DaysToExpiry`. Set alarm at 30 days (warning) and 14 days (critical). Alert to SNS → PagerDuty.

---

### 30-Second Explanation (for interview "Explain HTTPS")

> "HTTPS is HTTP carried over TLS. TLS adds three things: encryption so network observers see only random bytes, integrity so any tampering in transit is detected, and authentication via a certificate issued by a trusted Certificate Authority that proves the server is who it claims to be. The TLS handshake uses ephemeral Elliptic Curve Diffie-Hellman to agree on a session key — this gives forward secrecy, meaning past sessions can't be decrypted even if the server's key is later stolen. The certificate is a chain: your cert is signed by an intermediate CA, which is signed by a root CA pre-installed in your browser. Modern TLS 1.3 adds only 1 round-trip of overhead and is effectively free performance-wise due to session resumption."

---

### Mnemonics

**CIA for HTTPS Properties:**

```
C — Confidentiality (encryption: attacker sees ciphertext, not plaintext)
I — Integrity (MAC: tampering detected, connection terminated)
A — Authentication (certificate: you know the server is real, not impersonated)
```

**TLS 1.3: "1-FAST-PFS"**

```
1      — 1 RTT handshake (vs 2 for TLS 1.2)
F      — Forward secrecy mandatory
A      — All weak cipher suites removed
S      — Shorter certificate chain (reduced optional messages)
T      — TLS 1.0/1.1 support removed
PFS    — Perfect Forward Secrecy in every cipher suite
```

**ACM Region Rule: "CloudFront Eats Only Northeastern Pie"**

```
CloudFront
East (us-east-1)
Only — certs in other regions not accepted
Northeastern — us-east-1 = N. Virginia (Northeastern US)
Pie — ACM Public (starts with "P") certs free
```

**ACM Renewal: "DNS = Done, Email = Error"**

```
DNS validation → Done forever (silent auto-renewal)
Email validation → Error risk (manual approval required)
```

**Certificate Chain: "Leaves Grow from Intermediate Roots"**

```
Leaf cert → signed by Intermediate CA → signed by Root CA
Root = offline (in a vault), Intermediate = online CA services
```

---

## SECTION 12 — Architect Thinking Exercise

_Read the problem. Architect a solution. Then reveal the post-mortem below._

---

### The Scenario

You are the on-call engineer for a major e-commerce platform. At 02:14 AM, PagerDuty fires:

- **Alert:** `Route53HealthCheck/prod-shop-api FAILED`
- **Alert:** `Synthetics/checkout-flow FAILED`
- **Alert:** `CloudWatch/5XX_rate > 5%`

You open your laptop. CloudWatch shows that the ALB is receiving requests but approximately 40% of them are failing with connection errors before reaching the application layer. The application logs are clean — the errors are not reaching the application.

You check the ALB metrics: `HTTPCode_ELB_5XX_Count = 0`. The errors are not HTTP errors from the ALB. They are TLS-layer failures — client connections are being rejected before HTTP negotiation begins.

You run: `curl -v https://api.shop.com/health`

```
* Server certificate:
*  subject: CN = api.shop.com
*  start date: Jan 1 2025 00:00:00 GMT
*  expire date: Jan 1 2026 00:00:00 GMT
*  date in the past, won't connect
* SSL certificate problem: certificate has expired
* Closing connection 0
curl: (60) SSL certificate problem: certificate has expired
```

The cert expired 14 minutes ago. Today is January 1, 2026 at 02:14 AM. This cert was issued on January 1, 2025 with a 1-year validity (classic commercial CA term).

**Questions to answer:**

1. Why didn't this cert auto-renew?
2. What is the fastest path to recovery?
3. What is the long-term architectural fix so this NEVER happens again?
4. What monitoring should have caught this 30 days before expiry?

_Think through your answers before scrolling to the post-mortem._

---

---

---

### Post-Mortem: Certificate Expiry at 02:14 AM

#### Root Cause Analysis

**Why didn't it auto-renew?**

Investigation of the certificate history reveals:

```
Certificate issued: January 1, 2025
Issuer: Commercial CA (Sectigo)
Validation type: Email validation (DV)

ACM configuration:
  Certificate imported via: "Import certificate" (manual upload)
  → IMPORTED certificates do NOT have ACM-managed renewal
  → Only ACM-ISSUED certificates (created within ACM console) are auto-renewed

The ops engineer who set this up in 2024:
  1. Purchased cert from Sectigo manually (1-year, $149)
  2. Received cert files (cert.pem, chain.pem, key.pem)
  3. Imported to ACM console: ACM → Import certificate → paste files

  This creates an "Imported certificate" in ACM:
  - ACM tracks the expiry date
  - ACM sends email alerts to the account root email 45, 30, 15 days before expiry
  - ACM does NOT auto-renew (it didn't issue the cert; it can't renew it)

  The 45-day email went to the AWS root account email: aws-root@shop.com
  That email alias was created when the AWS account was opened in 2019
  It was a shared inbox that nobody actively monitored
  The email sat unread
```

**Secondary failure: No CloudWatch alarm**

```
ACM exposes DaysToExpiry metric:
  Namespace: aws/certificatemanager
  MetricName: DaysToExpiry
  Dimension: CertificateArn: arn:aws:acm:us-east-1:123456789:certificate/abc123

No alarm was configured. Nobody was alerted at 30 days, 14 days, or 1 day.
```

#### Immediate Recovery (02:18 AM — 4 minutes into incident)

```
Step 1: Issue ACM-native certificate (replaces imported cert)
  AWS Console → ACM → Request certificate → Public certificate
  Domain: api.shop.com
  Validation: DNS validation

  ACM immediately provides validation CNAME record to add

Step 2: Add CNAME to Route 53 (domain is in Route 53)
  ACM → Show CNAME → Add in Route 53 (one-click from ACM console)
  ACM detects CNAME → validates → STATUS changes to "Issued" in ~3-5 minutes

Step 3: Deploy cert to ALB
  ALB → Listeners → HTTPS:443 → Edit → Change certificate to new ACM cert
  No downtime — ALB switches certs for new connections; in-flight connections use old cert

Step 4: Verify
  openssl s_client -connect api.shop.com:443 2>/dev/null | openssl x509 -noout -dates
  # notAfter=Jan 14 00:00:00 2027 GMT  ← new 13-month ACM cert

  curl -w "%{ssl_verify_result}\n" https://api.shop.com/health
  # Returns 0 (success) and correct response

Total recovery time: ~12 minutes (02:14 AM outage → 02:26 AM resolved)
Business impact: ~$87,000 in lost orders at $7,250/minute average transaction rate
```

#### Long-Term Architectural Fix

```
Never use imported certificates in production (unless absolutely required):

Policy: All production HTTPS must use ACM-issued certificates with DNS validation
  Benefits:
    Fully automated: ACM renews 60 days before expiry, silently
    No human action required: ACM queries CNAME, confirms domain control, issues new cert
    Zero downtime rotation: ACM updates attached services automatically
    No key management: ACM manages private keys (you never have access to private key)
    Multi-region: Issue cert per region (no cross-region cert sharing)

Exception handling (when you must import):
  Legacy certificates: still must be renewed manually
  Third-party PKI certs (OV, EV): need commercial CA for org name in cert
  Private CA certs: use ACM Private CA instead of importing

If you must import a cert:
  Set personal calendar reminder 60 days before expiry
  Configure CloudWatch alarm on DaysToExpiry < 30
  Document renewal procedure AND runbook location in incident response wiki
```

#### Monitoring Fix

```
CloudWatch Alarm Configuration (should have existed from day 1):

Alarm 1: Early Warning (45 days)
  Namespace: aws/certificatemanager
  Metric: DaysToExpiry
  Statistic: Minimum
  Threshold: < 45 days
  Period: 1 day
  Action: SNS → Email → team

Alarm 2: Critical Alert (14 days)
  Same metric, threshold < 14 days
  Action: SNS → PagerDuty → On-call wake-up call

Alarm 3: Catastrophic Alert (2 days)
  Threshold < 2 days
  Action: SNS → PagerDuty P1 → Automated Slack and SMS notification

Terraform example:
  resource "aws_cloudwatch_metric_alarm" "cert_expiry_critical" {
    alarm_name          = "certificate-expires-in-14-days"
    comparison_operator = "LessThanThreshold"
    evaluation_periods  = "1"
    metric_name         = "DaysToExpiry"
    namespace           = "AWS/CertificateManager"
    period              = "86400"   # 1 day
    statistic           = "Minimum"
    threshold           = "14"
    alarm_description   = "TLS certificate expires in less than 14 days"
    alarm_actions       = [aws_sns_topic.pagerduty.arn]
    dimensions = {
      CertificateArn = aws_acm_certificate.api.arn
    }
  }
```

#### Lessons Encoded Into Team Runbook

```
1. Certificate lifecycle policy:
   "ACM-issued with DNS validation" is the ONLY acceptable production certificate
   type for all ALB, CloudFront, and API Gateway endpoints.

2. No imported certificates in production unless exceptions are documented
   and signed off by the security team with compensating monitoring controls.

3. DNS-validation CNAME records have a mandatory "do not delete" tag in Route 53:
   Key: Purpose, Value: "ACM-certificate-validation - DO NOT DELETE"
   Documented in team knowledge base with why it must not be deleted.

4. New AWS accounts and projects must run certificate-audit-automation:
   Lambda function runs daily → lists all ACM certs → finds any expiring in 30 days
   → posts to #ops-alerts Slack channel regardless of CloudWatch alarm state.

5. Post-mortem shared company-wide:
   Subject: "How 4 minutes of HTTPS downtime cost $87K at 2 AM (and how to prevent it)"
   Shared in all-hands engineering meeting.
   Root cause clearly documented: "Imported cert + no monitoring + dead email inbox"
```

#### Architecture Diagram (Post-Fix State)

```
shop.com (Route 53)
  └── CNAME: _acm-validation.shop.com → _abc.acm-validations.aws.
                                        (NEVER DELETE — enables ACM auto-renewal)

CloudFront Distribution
  ├── ACM Certificate: *.shop.com (issued in us-east-1, DNS-validated)
  ├── Viewer Protocol: Redirect HTTP to HTTPS
  └── Origin: ALB (origin protocol: HTTPS)

ALB (us-east-1)
  ├── ACM Certificate: api.shop.com (issued in us-east-1, DNS-validated)
  ├── HTTPS:443 listener → target group
  └── HTTP:80 redirect → HTTPS:443

CloudWatch Alarm: DaysToExpiry < 45 → SNS email
CloudWatch Alarm: DaysToExpiry < 14 → SNS → PagerDuty
CloudWatch Alarm: DaysToExpiry < 2  → SNS → PagerDuty P1 + SMS
```

---

### What an Architect Learns from This

The failure was not technical — TLS, certificates, and ACM are well-documented and reliable. The failure was **operational**: a process that worked in development (manually import cert, manually renew) was carried to production without hardening.

Architectural principle: **Infrastructure that requires human memory for safety is infrastructure waiting to fail.** Replace:

- "Remember to renew the cert" → ACM DNS-validated auto-renewal (machine handles it)
- "Check if cert is expiring" → CloudWatch alarm (machine detects it)
- "Email to aws-root@ for renewal" → PagerDuty to on-call (right person woken up)

This pattern applies beyond certificates: every manual, periodic, human-memory-dependent operation is a risk. Replace manual operations with automation + monitoring wherever the failure cost exceeds the automation cost.

---

## Complete Topic Summary: HTTPS vs HTTP (All 3 Files)

| Section | Content                                                                                                                                            |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1       | Postcard vs sealed envelope, phone vs encrypted walkie-talkie analogies                                                                            |
| 2       | TLS architecture, 1.3 1-RTT handshake, cert chain, SNI, HSTS preload, mTLS, CT logs                                                                |
| 3       | ASCII: HTTP vs HTTPS observer view, TLS record structure, cert chain validation                                                                    |
| 4       | Full HTTPS timing (80ms), ACME auto-renewal flow, mixed content issue + fix                                                                        |
| 5       | Notary wax seal + armored car analogies; Let's Encrypt adoption history, ACM overview                                                              |
| 6       | TLS termination strategies (edge/end-to-end/passthrough), PFS, OCSP stapling, HTTPS performance                                                    |
| 7       | AWS: ACM cert deployment, ALB TLS policies, CloudFront HTTPS config, SNI vs dedicated IP, Route 53                                                 |
| 8       | 8 Q&As: HTTP vs HTTPS, TLS certs, Not Secure, PFS, SNI, cert expiry, multi-tier TLS design, sporadic errors                                        |
| 9       | AWS SAA traps: ACM region rules, DNS vs email validation, SNI vs dedicated IP, NLB mTLS, backend cert validation                                   |
| 10      | 5 tables: HTTP vs HTTPS, TLS 1.2 vs 1.3, cert options, TLS termination strategies, DV vs OV vs EV                                                  |
| 11      | 10 key points, CIA mnemonic, 1-FAST-PFS, DNS=Done/Email=Error, 30-sec explanation                                                                  |
| 12      | Architect exercise: $87K cert expiry incident at 02:14 AM → imported cert + dead email inbox → ACM DNS-validation + CloudWatch DaysToExpiry alarms |
