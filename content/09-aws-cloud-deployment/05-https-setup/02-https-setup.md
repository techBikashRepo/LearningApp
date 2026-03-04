# HTTPS Setup

## FILE 02 OF 03 — Certificate Expiry Incidents, Mixed Content, HSTS & Production Failures

> **Architect Training Mode** | Senior Principal Architect Perspective
> _Optimized for: design judgement · tradeoff evaluation · failure prediction · production debugging_

---

## SECTION 5 — Real World Example

### How Certificate Expiry Incidents Happen (Despite Automation)

```
Let's Encrypt certificate lifecycle (90-day certs):

certbot auto-renewal (how it should work):
  systemd timer (daily) → certbot renew → checks expiry → if < 30 days: renews
  Hook (deploy-hook): nginx -s reload ← reload Nginx to pick up new certs

  Works perfectly IF:
  ✅ systemd timer still enabled
  ✅ certbot can still reach Let's Encrypt (port 80 open for HTTP-01)
  ✅ deploy-hook script runs successfully
  ✅ Nginx has permission to read new cert files

────────────────────────────────────────────────────────────────────

INCIDENT PATTERN 1: Port 80 accidentally closed

  Timeline:
  Month 1: Certs issued, certbot renewing every 60 days, all fine
  Month 3: Security audit → "close all unnecessary ports" → engineer closes port 80
             (thinking: "we redirect everything to HTTPS anyway, port 80 not needed")
  Month 5: certbot renewal attempt → HTTP-01 challenge fails (port 80 closed!)
             certbot logs error but server keeps running with STILL-VALID cert
  Month 5 + 30 days: cert expires
  Month 5 + 30 days + 01:00: HTTPS completely broken. ALL users get security error.

  Fix: Port 80 MUST remain open for HTTP-01 renewal
  Better fix: Switch to DNS-01 challenge (no port 80 required)

────────────────────────────────────────────────────────────────────

INCIDENT PATTERN 2: certbot timer not re-enabled after OS reinstall

  Timeline:
  Week 1: Server OS reinstalled + Nginx configured + certs obtained
  Week 1: Developer FORGETS to enable certbot renewal timer
  Week 13: Cert expires

  Verify: systemctl list-timers | grep certbot
          systemctl status certbot.timer

  Enable: systemctl enable certbot.timer
          systemctl start certbot.timer

────────────────────────────────────────────────────────────────────

INCIDENT PATTERN 3: deploy-hook not configured

  certbot renews cert → writes new files to /etc/letsencrypt/live/
  BUT Nginx is still serving the OLD cert files from memory!

  How: Nginx loads cert files at startup and caches in memory
       certbot renewing the files doesn't reload Nginx's in-memory cert

  Result: valid cert on disk, old (expired) cert in Nginx memory
          Users still see cert error even though files are correct

  Fix: certbot deploy-hook
  # /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
  #!/bin/bash
  nginx -s reload   ← or: systemctl reload nginx

  chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh

────────────────────────────────────────────────────────────────────

ACM: all three patterns are impossible (because AWS manages everything)
  ACM renews 60 days before expiry (no timer to maintain)
  ACM renews directly without HTTP challenge (Route 53 DNS validation)
  ALB automatically picks up renewed cert (no reload required)
```

---

## SECTION 6 — System Design Importance

```
ACTIVE MONITORING (detect before users do):

1. certbot certificates (see all managed certs + expiry dates):
   certbot certificates
   # Output:
   # Certificate Name: myapp.com
   #   Domains: myapp.com www.myapp.com
   #   Expiry Date: 2025-03-15 (VALID: 45 days)
   #   Certificate Path: /etc/letsencrypt/live/myapp.com/fullchain.pem

2. OpenSSL check from command line:
   echo | openssl s_client -connect myapp.com:443 -servername myapp.com 2>/dev/null \
     | openssl x509 -noout -dates
   # notBefore=Jan  1 00:00:00 2025 GMT
   # notAfter=Apr  1 00:00:00 2025 GMT  ← expiry date

3. CloudWatch alert for ACM certs:
   ACM automatically publishes CloudWatch metric:
     Namespace: AWS/CertificateManager
     Metric: DaysToExpiry

   Create CloudWatch alarm:
     DaysToExpiry < 30 → SNS notification → email/PagerDuty

4. Third-party monitoring:
   StatusCake, Uptime Robot, HetrixTools — check cert expiry daily
   Alert at: 30 days, 14 days, 7 days before expiry

5. Internal dashboard: expose cert expiry as a health check metric
   /health endpoint includes: { "cert_expiry_days": 45 }
   Grafana dashboard tracks this over time
```

---

## SECTION 7 — AWS & Cloud Mapping

```
Mixed content = HTTPS page loads HTTP resources
Browser behavior: modern browsers BLOCK mixed content (since ~2020)
Even if page loads: browser console shows red errors, users might see "not secure"

Types of mixed content:
─────────────────────────────────────────────────────────────────
Active mixed content (blocked always):
  ├── <script src="http://cdn.example.com/app.js">
  ├── <link rel="stylesheet" href="http://cdn.example.com/style.css">
  ├── XMLHttpRequest to http://api.example.com
  └── fetch('http://api.example.com/users')

  → Browser blocks entirely. Scripts and XHR don't execute.

Passive mixed content (warns, sometimes blocks):
  ├── <img src="http://assets.example.com/logo.png">
  ├── <video src="http://media.example.com/video.mp4">
  └── <audio src="http://media.example.com/audio.mp3">

  → Browser may display with warning, or block in strict mode.
─────────────────────────────────────────────────────────────────

How mixed content sneaks in:
  1. Old hardcoded API URL in code:
       fetch('http://api.myapp.com/users')  ← was HTTP before HTTPS migration
  2. CDN resource with http:// schema in HTML template
  3. User-generated content: user posts <img src="http://...">
  4. Third-party widget that loads additional resources over HTTP
  5. Backend generates redirect to HTTP version of resource

Fix: Upgrade-Insecure-Requests header
  Content-Security-Policy: upgrade-insecure-requests;

  Browser automatically upgrades http:// resource requests to https://
  Simple fix: works for most cases where the resource IS available at https://

  Add in Nginx:
  add_header Content-Security-Policy "upgrade-insecure-requests;" always;

Fix: Find all mixed content issues
  Browser DevTools → Console + Security tab → shows exact resources blocked

  Grep codebase:
  grep -r "http://" src/  --include="*.html" --include="*.js" --include="*.jsx"

  Look for: any http:// URL that isn't:
    - http://localhost (ok for local dev)
    - http://127.0.0.1 (ok for local dev)
    → Everything else: change to https:// or protocol-relative //
```

---

## SECTION 8 — Interview Preparation

**Beginner:**

**Q: What is HTTPS and why is it required for every website today?**
**A:** HTTPS is HTTP with encryption added (TLS layer). Without HTTPS, everything sent between your browser and the server is plain text â€” anyone on the same network (coffee shop WiFi, ISP) can read your passwords, credit card numbers, and personal data. With HTTPS, all data is encrypted and only you and the server can read it. Modern browsers show "Not Secure" for HTTP sites; search engines rank HTTPS sites higher; it's required for cookies with Secure flag; and payment processors mandate it.

**Q: What is an SSL/TLS certificate and what does it prove?**
**A:** A certificate is a digital document that: (1) contains the public key for encrypting data to your server, (2) is signed by a trusted Certificate Authority (CA) like Let's Encrypt or AWS ACM, proving it was issued to the actual owner of the domain. When you visit https://bank.com, the browser checks the certificate: is it signed by a trusted CA? Does the domain match? Is it not expired? If all yes â†’ secure connection. This prevents attackers from pretending to be ank.com.

**Q: What is the difference between Let's Encrypt (certbot) and AWS Certificate Manager (ACM)?**
**A:** Both are free SSL certificates, but: *Let's Encrypt/certbot:* works anywhere (any server, any cloud), requires renewal every 90 days (can be automated), certificate files stored on your server. *AWS ACM:* certificates are managed entirely by AWS â€” no renewal needed, can't be exported (used only within AWS services), no cost. Use ACM for ALB/CloudFront deployments (easiest). Use Let's Encrypt for non-AWS or self-managed Nginx servers that need certificate files.

---

**Intermediate:**

**Q: What is SSL termination and where should it happen in a typical AWS deployment?**
**A:** SSL termination = where the TLS encryption is decrypted. Options: (1) At the ALB (most common) â€” ALB handles SSL, traffic from ALB to EC2/ECS is HTTP (internal network, considered safe). Pros: simple, centralizes cert management in ACM, ALB handles cipher negotiation. (2) At Nginx on the EC2 instance â€” end-to-end encrypted. Pros: traffic encrypted even inside VPC. More complex. (3) End-to-end mutual TLS (mTLS) â€” both client and server have certificates, used for service-to-service authentication. For most apps: ALB SSL termination is the right choice.

**Q: What is HSTS (HTTP Strict Transport Security) and should you enable it?**
**A:** HSTS is a response header (Strict-Transport-Security: max-age=31536000; includeSubDomains) that tells browsers: "Never connect to this domain over HTTP â€” always use HTTPS, even if the user types http://." Once a browser sees this header with a long max-age, it will automatically upgrade all connections to HTTPS for that duration. This prevents downgrade attacks. Caution: once you set a long HSTS max-age, you CANNOT easily switch back to HTTP (all users will have HTTPS enforced cached). Test thoroughly before deploying. includeSubDomains affects ALL subdomains â€” ensure they all have HTTPS.

**Q: How do you prevent certificate expiry from causing a production outage?**
**A:** Certificate expiry is one of the most common self-inflicted outages (it's always preventable). Prevention: (1) AWS ACM certificates auto-renew â€” use ACM for zero-expiry risk. (2) Let's Encrypt: run certbot with --deploy-hook to restart Nginx after renewal. Set up cron:   0,12 * * * certbot renew --quiet. (3) Monitor expiry: CloudWatch alarm on ACM certificate expiry < 30 days. Datadog/Grafana panel for cert expiry dates. (4) Test renewal in staging. (5) If cert expires: ALB returns SSL_ERROR_RX_RECORD_TOO_LONG â€” users can't connect at all.

---

**Advanced (System Design):**

**Scenario 1:** Design the HTTPS setup for a multi-service platform where: (a) the main API runs on ALB in AWS, (b) a static React frontend is on CloudFront with S3, (c) microservices communicate internally over HTTPS (mTLS). Cover certificate management for each layer, including certificate rotation without downtime.

*Public-facing:* ACM certificate for pi.example.com â†’ attached to ALB. ACM certificate for *.example.com â†’ attached to CloudFront distribution. Route 53 A/ALIAS records. ACM auto-renews both.
*Internal mTLS:* AWS Private CA (ACM PCA) issues short-lived certificates (24h) for each microservice. Service mesh (AWS App Mesh/Istio) handles mTLS negotiation and rotation transparently. Individual services don't manage certificates â€” the mesh does.
*Rotation:* ACM certificates: automatic. Private CA certificates: automatic via mesh rotation. Never manual certificate management in production.

**Scenario 2:** Users are reporting that your website occasionally shows a security warning in their browser ("NET::ERR_CERT_DATE_INVALID" or "Your connection is not private"). It affects ~5% of users. The certificate was renewed last week. What could cause this, and how do you debug it?

*Possible causes:* (1) *Multiple servers, only some with new cert:* if Nginx is on multiple EC2 instances (behind ALB that terminates at instance level, not ALB itself), did you update all instances? (2) *Clock skew:* certificate validators check current time. If users' clocks are wrong (or server clock is wrong) the cert appears expired. (3) *Intermediate certificate chain missing:* server sends leaf cert but not the intermediate CA cert â€” some browsers (mobile) can't resolve the chain. Fix: include full chain in ssl_certificate (ullchain.pem not cert.pem). (4) *Old cert cached in aggressive DNS/CDN:* CDN may be serving old content including old cert on some edge nodes.

