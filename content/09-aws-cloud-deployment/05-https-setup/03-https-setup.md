# HTTPS Setup

## FILE 03 OF 03 — ACM vs Certbot, Cost, Exam Traps, Scenario Exercise & Architect's Mental Model

> **Architect Training Mode** | Senior Principal Architect Perspective
> _Optimized for: design judgement · tradeoff evaluation · failure prediction · production debugging_

---

## SECTION 9 — Certification Focus (AWS SAA-C03)

```
┌────────────────────────────────────────────────────────────────────────────────────────────┐
│                        ACM vs LET'S ENCRYPT COMPARISON                                     │
├─────────────────────────────┬──────────────────────────┬──────────────────────────────────┤
│ Factor                      │ AWS ACM                   │ Let's Encrypt / certbot          │
├─────────────────────────────┼──────────────────────────┼──────────────────────────────────┤
│ Cost                        │ Free (certs themselves)  │ Free (always)                    │
├─────────────────────────────┼──────────────────────────┼──────────────────────────────────┤
│ Where certs can be used     │ ALB, CloudFront, API      │ Anywhere (Nginx, Apache,          │
│                             │ Gateway, AppSync only     │ HAProxy, Docker, K8s, etc.)      │
├─────────────────────────────┼──────────────────────────┼──────────────────────────────────┤
│ Can export private key      │ ❌ Never (ACM-managed)   │ ✅ Yes (files on disk)           │
├─────────────────────────────┼──────────────────────────┼──────────────────────────────────┤
│ Cert validity               │ 13 months                 │ 90 days                          │
├─────────────────────────────┼──────────────────────────┼──────────────────────────────────┤
│ Auto-renewal                │ ✅ Managed by AWS        │ ✅ certbot renew (you set up)     │
├─────────────────────────────┼──────────────────────────┼──────────────────────────────────┤
│ Renewal failure risk        │ Near-zero (AWS manages)  │ Exists (port 80, timer, hooks)   │
├─────────────────────────────┼──────────────────────────┼──────────────────────────────────┤
│ Wildcard support            │ ✅ Yes (DNS validation)  │ ✅ Yes (DNS-01 only)             │
├─────────────────────────────┼──────────────────────────┼──────────────────────────────────┤
│ Validation method           │ DNS or email             │ HTTP-01 or DNS-01                │
├─────────────────────────────┼──────────────────────────┼──────────────────────────────────┤
│ Private subnet support      │ DNS validation (yes)     │ DNS-01 only (no port 80 needed)  │
├─────────────────────────────┼──────────────────────────┼──────────────────────────────────┤
│ Operational overhead        │ Zero                     │ Low-medium (timer, hooks, monitor)│
├─────────────────────────────┼──────────────────────────┼──────────────────────────────────┤
│ Works for non-AWS deploys   │ ❌ No                    │ ✅ Yes                           │
└─────────────────────────────┴──────────────────────────┴──────────────────────────────────┘
```

### Decision Rule (simple)

```
Does your HTTPS traffic terminate at an AWS service (ALB, CloudFront, API GW)?
├── YES → AWS ACM. Period. Zero operational overhead. Auto-renews.
│         Attach cert to ALB/CloudFront in the console or via Terraform.
│
└── NO → Let's Encrypt with certbot.
         Examples: EC2 with Nginx (no ALB in front), self-hosted K8s,
                   Docker Compose on a VPS, hybrid on-prem servers
         Use: DNS-01 challenge if possible (no port 80 dependency)
```

---

## SECTION 10 — Comparison Table

### Step-by-Step: ACM + ALB

```
STEP 1: Request ACM Certificate

Via AWS Console:
  ACM → Request certificate → Public certificate
  Domain names: myapp.com, *.myapp.com  (request both: apex + wildcard)
  Validation method: DNS validation (preferred) or Email

Via AWS CLI:
  aws acm request-certificate \
    --domain-name myapp.com \
    --subject-alternative-names "*.myapp.com" \
    --validation-method DNS \
    --region us-east-1   # ← CRITICAL if using CloudFront!

STEP 2: DNS Validation

ACM generates a CNAME record you must add to your DNS:
  _abc123.myapp.com → _def456.acm-validations.aws.

  For Route 53 hosted zone: ACM can add this automatically
    ACM console → "Create record in Route 53" button → one click done

  For other DNS providers: copy-paste the CNAME record

  Validation check: ACM queries that CNAME record
                    Once found: cert issued within minutes
                    The same CNAME record continues to be used for auto-renewal

STEP 3: Attach to ALB (Terraform)

  resource "aws_lb_listener" "https" {
    load_balancer_arn = aws_lb.main.arn
    port              = "443"
    protocol          = "HTTPS"
    ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"  # enables TLS 1.2 + 1.3
    certificate_arn   = aws_acm_certificate.main.arn

    default_action {
      type             = "forward"
      target_group_arn = aws_lb_target_group.main.arn
    }
  }

  # HTTP → HTTPS redirect listener
  resource "aws_lb_listener" "http_redirect" {
    load_balancer_arn = aws_lb.main.arn
    port              = "80"
    protocol          = "HTTP"

    default_action {
      type = "redirect"
      redirect {
        port        = "443"
        protocol    = "HTTPS"
        status_code = "HTTP_301"
      }
    }
  }

STEP 4: Verify

  curl -I https://myapp.com
  # Check: HTTP/2 200 OK
  # And: openssl s_client -connect myapp.com:443 | grep "issuer"
  #      Should show: issuer=C = US, O = Amazon, CN = Amazon RSA 2048 M01
```

---

## SECTION 11 — Quick Revision

### The Most Common CloudFront HTTPS Mistake

```
THE RULE:
  ACM certificates for CloudFront MUST be created in us-east-1 (N. Virginia)
  This is the ONLY exception to "use resource in your application's region"

WHY:
  CloudFront is a GLOBAL service
  Its control plane lives in us-east-1
  It can only read ACM certs from us-east-1

  If you create cert in ap-south-1 (Mumbai):
    Certificate exists in Mumbai region
    CloudFront (global/us-east-1) cannot see it
    When you try to select cert in CloudFront distribution: it WON'T APPEAR in the dropdown
    Error: "No ACM certificates found"
    Very confusing if you don't know this rule

THE FIX (Terraform):
  # For CloudFront — must specify us-east-1 even if your stack is in ap-south-1:
  provider "aws" {
    alias  = "us_east_1"
    region = "us-east-1"
  }

  resource "aws_acm_certificate" "cloudfront_cert" {
    provider    = aws.us_east_1    # ← CRITICAL: forces cert creation in us-east-1
    domain_name = "myapp.com"
    subject_alternative_names = ["*.myapp.com"]
    validation_method = "DNS"
  }

  # Cert for ALB in ap-south-1 (your regular region):
  resource "aws_acm_certificate" "alb_cert" {
    domain_name = "myapp.com"   # No provider override → uses default provider region
    subject_alternative_names = ["*.myapp.com"]
    validation_method = "DNS"
  }

ARCHITECTURE WITH BOTH:
  Internet → CloudFront (us-east-1 cert) → ALB in ap-south-1 (ap-south-1 cert) → ECS

  CloudFront: terminates TLS at edge, uses us-east-1 cert
  ALB: terminates TLS from CloudFront to origin, uses ap-south-1 cert
  Both ACM managed, both auto-renew, both zero-operational-overhead
```

---

## SECTION 12 — Architect Thinking Exercise

```
AWS ALB SSL Security Policies:
  Determines: which TLS versions + cipher suites are allowed

Recommended policies:
  ELBSecurityPolicy-TLS13-1-2-2021-06
    ✅ TLS 1.2 + TLS 1.3
    ✅ Modern, strong ciphers only
    ✅ Good compatibility (TLS 1.2 = 99%+ client support)
    ✅ PCI compliant
    This is what you should use for production

  ELBSecurityPolicy-TLS13-1-3-2021-06
    TLS 1.3 ONLY (no TLS 1.2)
    Slightly more secure
    Risk: some older HTTP clients don't support TLS 1.3
    Use only if you control all clients (internal APIs, B2B)

Don't use (legacy policies):
  ELBSecurityPolicy-2016-08 (default, old)  ← allows TLS 1.0 (insecure)
  ELBSecurityPolicy-TLS-1-0-2015-04         ← TLS 1.0 allowed (PCI fail)
  ELBSecurityPolicy-TLS-1-1-2017-01         ← TLS 1.1 allowed (deprecated)

Check your current policy:
  aws elbv2 describe-listeners --load-balancer-arn <arn> \
    --query 'Listeners[*].{Port:Port,SSL:SslPolicy}'
```

---

### When NOT to Use HTTPS Termination at ALB

```
1. END-TO-END ENCRYPTION REQUIRED (PCI DSS Level 1, HIPAA strict)

   Some compliance frameworks require: data encrypted at every hop

   ALB → backend over plaintext HTTP = plaintext on internal network
   Even if VPC is "trusted": compliance auditors may require encryption everywhere

   Solution: End-to-end TLS
     ALB with HTTPS to backend targets (backend runs HTTPS on port 443)
     Use ACM cert on ALB, use self-signed or ACM Private CA cert on backend instances
     OR: Use NLB (Network Load Balancer) in TCP passthrough mode:
         NLB doesn't terminate TLS → passes raw TCP to backend
         Backend terminates TLS with its own cert
         NLB can't do path routing but can do port/protocol routing

2. mTLS REQUIREMENTS

   ALB cannot do mTLS (client certificate validation)
   If you need each client to present a certificate:
   Use: Nginx with ssl_verify_client on (see File 02)
        Or: API Gateway with mutual TLS truststore
        Or: AWS App Mesh with Envoy proxy (service mesh mTLS)

3. CUSTOM TLS TERMINATION LOGIC

   ACM/ALB SSL policy is fixed (select from AWS policy list)
   If you need: specific cipher ordering for compatibility with legacy clients,
                custom certificate revocation workflows,
                multi-tenancy where each tenant has their own cert (SNI routing)

   Use: Nginx with full ssl_ciphers configuration control
        Or: Envoy proxy (very configurable)

4. NON-AWS INFRASTRUCTURE

   ACM only works with AWS services
   Any on-prem, DigitalOcean, GCP, Azure hybrid workload:
   Let's Encrypt / certbot (or managed cert service of that provider)
```

---

### AWS SAA Exam Traps

### Trap 1: CloudFront + ACM Region

```
Exam question:
  "A company creates an ACM certificate in ap-southeast-1 for their CloudFront
   distribution. The certificate cannot be selected in CloudFront settings. Why?"

Answer: ACM certificates for CloudFront must be created in us-east-1 region.
        Certificates in other regions are not visible to CloudFront.

Wrong answers:
  - "The domain is not validated" (if it were, it still wouldn't appear unless in us-east-1)
  - "CloudFront doesn't support custom SSL certificates" (it does, via ACM in us-east-1)
```

### Trap 2: ACM Cert Cannot Be Used on EC2 Directly

```
Exam question:
  "A developer requests an ACM certificate and needs to install it on an EC2
   instance running Nginx. What is the process to export the certificate from ACM?"

Answer: ACM public certificates CANNOT be exported.
        The private key is managed by AWS and never accessible to customers.

        Correct approach: Use Let's Encrypt on EC2
                         OR: put ALB in front of EC2 and attach ACM cert to ALB
                         OR: use ACM Private CA (private certs CAN be exported, at cost)
```

### Trap 3: Certificate + Load Balancer Security Policy

```
Exam question:
  "Security audit requires disabling TLS 1.0 on ALB. Where is this configured?"

Answer: SSL Security Policy in the LISTENER configuration (not the certificate)
  The ACM certificate does not control TLS versions
  The SSL Policy attached to the HTTPS listener controls TLS versions and ciphers

  Incorrect: "Replace the ACM certificate with one that disables TLS 1.0"
  Correct: Change listener SSL policy to ELBSecurityPolicy-TLS13-1-2-2021-06
```

### Trap 4: SNI (Server Name Indication)

```
Exam question:
  "A single ALB needs to serve multiple domains (api.myapp.com, admin.myapp.com)
   each with different SSL certificates. How?"

Concept: SNI = Server Name Indication
  Browser sends the target domain name in the TLS ClientHello (before encryption)
  ALB reads SNI → selects appropriate cert for that domain

  ALB: supports multiple certificates on one HTTPS listener via SNI
  Add additional certificates to ALB listener (up to 25 certs per listener)
  ALB selects correct cert based on domain name in request

  All certs must be in ACM (same region as ALB for non-CloudFront use)
```

### Trap 5: HTTP-01 Challenge and Port 80

```
Exam question:
  "Let's Encrypt certificate auto-renewal fails in a security-hardened environment
   where port 80 is blocked. What solution doesn't require opening port 80?"

Answer: DNS-01 challenge
  Let's Encrypt creates a TXT record in your DNS zone
  No HTTP connection required
  Works even for:
    - Port 80 blocked firewall rules
    - Resources in private subnets
    - Resources not accessible from public internet
    - Wildcard certificates

Wrong: "Use email validation" — email validation is for ACM, not Let's Encrypt/ACME
```

---

### Scenario Design Exercise

### Scenario: Full HTTPS Stack for a Multi-Tier SaaS Application

**Problem Statement:**

You are deploying a SaaS application:

- React frontend (served from S3 via CloudFront)
- Node.js API (ECS Fargate behind ALB in ap-south-1)
- Admin panel (separate domain: admin.myapp.com, same ALB)
- Internal microservices (ECS, private subnet, no public access)
- Compliance: PCI-DSS (payment data, encryption required everywhere)
- Domain: myapp.com registered in Route 53

**Design the complete HTTPS certificate and termination architecture.**

**Solution:**

```
CERTIFICATES NEEDED:

1. CloudFront cert (us-east-1 — MANDATORY):
   Domain: myapp.com, *.myapp.com
   Type: ACM public cert
   Region: us-east-1
   Validation: DNS (Route 53 CNAME added automatically)

2. ALB cert (ap-south-1):
   Domain: myapp.com, *.myapp.com
   Type: ACM public cert
   Region: ap-south-1
   Validation: DNS (same Route 53 validation CNAME — works for both certs)

3. Internal mTLS cert (private CA — PCI requirement):
   ACM Private CA in ap-south-1 (private CA, $400/month — PCI requirement)
   Issued: per-service client certs for service-to-service mTLS

ARCHITECTURE:

  Users
    │ HTTPS (myapp.com)
    ▼
  CloudFront (cert #1 — us-east-1)
    │ HTTPS (origin protocol: HTTPS)
    ▼
  ALB (cert #2 — ap-south-1)
  SSL Policy: ELBSecurityPolicy-TLS13-1-2-2021-06
  Listener rules:
    │ ├─ Host: myapp.com    → frontend-tg: ECS Frontend service :8080
    │ └─ Host: admin.myapp.com → admin-tg: ECS Admin service :8081
    │ (SNI: both certs on same listener, ALB selects by host SNI)
    │ HTTPS (to backend targets — end-to-end for PCI)
    ▼
  ECS services (run HTTPS on :8443)
  Use self-signed or ACM Private CA issued certs
  ALB → ECS: HTTPS, ALB does NOT verify backend cert (ssl_verify = false for internal)

  Internal microservices (private subnet):
    service-a → service-b: mTLS using ACM Private CA issued client certs
    Each service presents its cert signed by private CA
    Receiving service validates: cert signed by our CA + correct service identity

PORT CONFIGURATION (Security Groups):
  ALB:          inbound 80 (→ redirect), 443 from 0.0.0.0/0
  ECS services: inbound 8443 from ALB security group only
                inbound 8080 (if internal HTTP needed) from VPC CIDR only
  Internal µsvc: inbound their port from this VPC CIDR only — NO public access

HTTP → HTTPS REDIRECT:
  ALB: port 80 listener → redirect to 443 (301)
  CloudFront: redirect HTTP to HTTPS in distribution settings

HSTS:
  Add to ALB response (via ECS app code or Lambda@Edge):
  Strict-Transport-Security: max-age=31536000; includeSubDomains
  (Deployed gradually: start at max-age=300, increase over 4 weeks)

MONITORING:
  CloudWatch Alarm: ACM DaysToExpiry < 30 for both certs
  CloudWatch Alarm: ACM DaysToExpiry < 14 (critical — PagerDuty)
  SSL Labs scan: monthly automated Qualys SSL Labs test (target A+)
  Internal CA: ACM Private CA CRL available to all services (cert revocation)
```

---

### Interview Q&A

**Q: "How does HTTPS work and what does a certificate prove?"**

Good answer: "HTTPS uses TLS to encrypt the connection. During the TLS handshake, the server presents its certificate — a document signed by a Certificate Authority (CA) that browsers trust. The cert proves: this server legitimately controls myapp.com, and the browser trusts the CA's signature. Both sides then derive a shared symmetric encryption key using Diffie-Hellman key exchange. The important property is forward secrecy: each session gets fresh keys, so compromising the server's private key later doesn't expose past sessions."

**Q: "ACM or Let's Encrypt — which would you use, and when?"**

Good answer: "If HTTPS terminates at an AWS service — ALB, CloudFront, API Gateway — I'd use ACM without hesitation. It's free, auto-renews without any operational involvement, and attaches with one ARN. If I'm running Nginx directly on EC2, or need the cert outside AWS, I'd use Let's Encrypt with certbot and DNS-01 challenge for reliable renewal regardless of port 80 availability. The one critical rule for CloudFront: ACM cert must be in us-east-1 — regardless of where the rest of your stack lives."

---

## === ARCHITECT'S MENTAL MODEL ===

### 5 Decision Rules for HTTPS Setup

1. **ACM for AWS services, Let's Encrypt for everything else.** ACM attaches directly to ALB/CloudFront/API GW, auto-renews, and has zero operational cost. For self-managed servers, Let's Encrypt is the right tool. Never pay for a DV certificate in 2025.

2. **CloudFront cert = us-east-1, always.** No exception. Request the ACM cert with `--region us-east-1` (or with a provider override in Terraform). Cert in any other region is invisible to CloudFront. This trips up experienced engineers regularly.

3. **SSL terminates at the ALB except when PCI/compliance requires end-to-end.** ALB → backend over plaintext internal HTTP is secure enough for virtually all use cases (VPC network is isolated). When compliance explicitly requires encryption at every hop, use ALB with HTTPS to backend targets or NLB TCP passthrough.

4. **Monitor cert expiry at 30 days and 14 days.** Even with ACM and certbot auto-renewal, monitoring is mandatory. ACM renewal can fail if the DNS validation CNAME was deleted. certbot renewal can fail if port 80 was closed. CloudWatch alarms on `DaysToExpiry` metric catch both before users see cert errors.

5. **HSTS deployment is one-way — plan the rollback.** Once you set `max-age=31536000`, browsers enforce HTTPS for a year even if you remove the header. Deploy with max-age=300 first, verify all subdomains work on HTTPS, then increase over several weeks. Never add `includeSubDomains` until every subdomain has HTTPS. Never add `preload` unless you're committed to HTTPS forever.

### 3 Common Mistakes

1. **Using HTTP-01 challenge in environments where port 80 will be blocked.** Security hardening scripts commonly block port 80 at the OS or firewall level. certbot renewal silently fails, cert expires 30 days later. Use DNS-01 challenge everywhere — it has no port dependency, supports wildcards, and works from private subnets.

2. **Requesting ACM cert in the application region for CloudFront use.** The architect sets up their stack in ap-south-1, requests ACM cert in ap-south-1, tries to attach to CloudFront distribution — cert doesn't appear in the list. Solution: always request a separate ACM cert in us-east-1 specifically for CloudFront. It's common to have two ACM certs for the same domain (one in us-east-1 for CloudFront, one in your app region for ALB).

3. **Forgetting to add the apex domain when requesting a wildcard cert.** `*.myapp.com` covers `www.myapp.com`, `api.myapp.com`, `admin.myapp.com`. It does NOT cover `myapp.com` itself. Always request both in the same cert: `--domain-name myapp.com --subject-alternative-names "*.myapp.com"`. This is a single cert, validated once, covering both.

### 1 Clear Interview Answer (30 Seconds)

> "For HTTPS in AWS, I use ACM certificates attached to ALB via the HTTPS listener with policy ELBSecurityPolicy-TLS13-1-2-2021-06 — that enables TLS 1.2 and 1.3 while blocking older insecure versions. For CloudFront, the ACM cert must be specifically created in us-east-1 — that's a hard AWS requirement. For EC2 with Nginx, I use Let's Encrypt with certbot and DNS-01 challenge, which doesn't depend on port 80 and supports wildcard certs. I always set up expiry monitoring via CloudWatch at 30 days and use gradual HSTS rollout starting at max-age=300 to avoid locking users out of subdomains before all of them are covered by HTTPS."

---

_End of HTTPS Setup 3-File Series_
