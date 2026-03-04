# HTTPS Setup

## FILE 01 OF 03 — Physical Infrastructure Replaced, TLS Architecture & Core Concepts

> **Architect Training Mode** | Senior Principal Architect Perspective
> _Optimized for: design judgement · tradeoff evaluation · failure prediction · production debugging_

---

## SECTION 1 — Intuition (Explain Like a 12-Year-Old)

### Before TLS: Plaintext HTTP and Hardware SSL Terminators

**The Plaintext HTTP Problem (pre-1994)**

Early web (1989–1993): everything sent as readable text over the network:

```
GET /banking/transfer?amount=5000&to=123456 HTTP/1.0
Authorization: Basic dXNlcjpwYXNzd29yZA==   ← base64 (not encrypted!)
Cookie: session=REAL_USER_SESSION_TOKEN
```

Any device on the network path (routers, ISPs, coffee shop Wi-Fi hotspot) could:

- **Read** every byte of the request and response
- **Steal** session cookies, passwords, form data (credit card numbers)
- **Inject** content into responses (ISPs inserting ads into pages = REAL thing that happened)
- **Modify** data in transit (man-in-the-middle attacks)

**SSL (Secure Sockets Layer, Netscape, 1994) → TLS (Transport Layer Security, IETF, 1999)**:

- Encrypts the communication channel between browser and server
- Authenticates the server's identity (proves you're talking to amazon.com not an impersonator)
- Ensures data integrity (in-flight modification detected and rejected)

**Hardware SSL Terminators (replaced by software TLS)**:

- Before 2008: SSL handshake was computationally expensive (RSA key exchange)
- Dedicated hardware: F5 BIG-IP with SSL acceleration cards, Citrix NetScaler
- Cost: $10,000–$50,000 per device, needed in HA pairs
- Function: decrypt HTTPS at the edge, pass plaintext HTTP to application servers
- Private keys stored in hardware security modules (HSMs)

**What replaced hardware SSL terminators:**
| Old Hardware | Modern Replacement |
|---|---|
| F5 BIG-IP SSL accelerator | AWS ALB with ACM (managed certs, auto-renew) |
| Physical HSM for private key storage | AWS CloudHSM / ACM's managed key storage |
| Manual cert purchase + installation | Let's Encrypt (free, automated) or ACM (free with AWS) |
| CSR → CA → signed cert → upload process | `aws acm request-certificate` (minutes) |
| Annual cert renewal (often forgotten) | ACM: auto-renew, no human required |
| Wildcard cert for all subdomains | Let's Encrypt wildcard (`*.myapp.com`), or ACM wildcard |

---

## SECTION 2 — Core Technical Explanation

```
Browser                         Server
  │                               │
  │──────── ClientHello ─────────►│
  │  TLS version: 1.3             │
  │  Supported cipher suites:     │
  │    TLS_AES_256_GCM_SHA384     │
  │    TLS_CHACHA20_POLY1305      │
  │  Client random: [32 bytes]    │
  │  SNI: myapp.com ←─────────── │ Server Name Indication:
  │                               │ browser tells server WHICH domain
  │                               │ (needed when one IP hosts many domains)
  │                               │
  │◄──────── ServerHello ─────────│
  │  Selected cipher: AES_256_GCM │
  │  Certificate: [signed cert]   │ ← contains public key + identity
  │  Server random: [32 bytes]    │
  │  (TLS 1.3: also includes      │
  │   key material for session)   │
  │                               │
  │  [Browser validates cert]     │
  │  ├── Is cert signed by a      │
  │  │   trusted CA?              │
  │  ├── Is cert for myapp.com?   │
  │  ├── Is cert expired?         │
  │  └── Is cert revoked?         │
  │    (OCSP stapling or CRL)     │
  │                               │
  │  [Derive session keys]        │
  │  Both sides compute the same  │
  │  symmetric key from:          │
  │   - Client random             │
  │   - Server random             │
  │   - Key exchange (Diffie-Hellman)
  │                               │
  │──── Finished (encrypted) ────►│
  │◄─── Finished (encrypted) ─────│
  │                               │
  ═══════════ TLS connection established ═══════════
  │                               │
  │  GET /api/users HTTP/1.1      │ ← encrypted, integrity-protected
  │  Authorization: Bearer eyJ... │ ← safe
  │◄─────── 200 OK ───────────────│
```

**TLS 1.3 improvements over TLS 1.2:**

- Eliminates insecure cipher suites (RSA key exchange, MD5, SHA-1)
- 1-RTT handshake (reduced from 2-RTT in TLS 1.2 — one fewer round trip)
- 0-RTT resumption for repeat connections (risky, disabled by default — replay attack risk)
- Forward secrecy: each session uses ephemeral keys, past sessions cannot be decrypted if server key is later compromised

---

## SECTION 3 — Architecture Diagram (MANDATORY)

```
BY VALIDATION LEVEL:
─────────────────────────────────────────────────────────────────
DV (Domain Validated)
  What CA verifies: you control the domain (DNS or file challenge)
  What browser shows: padlock 🔒
  Time to issue: minutes
  Cost: $0 (Let's Encrypt) to $100/year
  Use: any web application, APIs, most SaaS products

OV (Organization Validated)
  What CA verifies: domain control + business identity (documents)
  What browser shows: padlock 🔒 (same as DV for users)
  Time to issue: 1-3 business days
  Cost: $100-$400/year
  Use: corporate websites wanting to show OU in cert details

EV (Extended Validation)
  What CA verifies: domain + business + legal identity (extensive docs)
  What browser USED TO show: green bar with company name (removed in 2019!)
  Modern browsers: just a padlock (same as DV)
  Cost: $400-$1,200/year
  Status: largely deprecated as UX benefit was removed

  Architect opinion: EV certs are no longer worth the cost or complexity
  DV from Let's Encrypt or ACM is what production services use

BY SCOPE:
─────────────────────────────────────────────────────────────────
Single domain:     myapp.com only (http://www.myapp.com NOT included)
Multi-domain (SAN): myapp.com + www.myapp.com + api.myapp.com + ...
                   Subject Alternative Name — list of included domains
Wildcard:          *.myapp.com covers ALL one-level subdomains
                   Covers: www.myapp.com, api.myapp.com, staging.myapp.com
                   Does NOT cover: myapp.com (naked domain) — must add separately
                   Does NOT cover: deep.api.myapp.com (2 levels deep)

BY ISSUER:
─────────────────────────────────────────────────────────────────
Let's Encrypt (free, automated, 90-day):
  ├── Issued by: Internet Security Research Group (IETF-chartered nonprofit)
  ├── Trusted by: all major browsers and OSes
  ├── Duration: 90 days (by design — forces automation, limits exposure)
  ├── Automation: certbot, cert-manager (K8s), nginx plugin
  ├── Wildcard: supported via DNS-01 challenge (requires DNS API access)
  └── Rate limits: 50 certs per domain per week (production scale: no issue)

AWS ACM (free with AWS services):
  ├── Issued by: Amazon Trust Services
  ├── Duration: 13 months (auto-renewed by AWS before expiry)
  ├── Cost: certificates themselves are FREE
  │          You pay for the LoadBalancer/CloudFront using the cert
  ├── Wildcard: supported
  ├── Limitation: ONLY usable with AWS services (ALB, CloudFront, API GW, etc.)
  │               Cannot export private key to install on EC2 manually
  └── Best for: ALB and CloudFront SSL termination — zero operational work
```

---

## SECTION 4 — Request Flow (MANDATORY FLOWCHART)

```
OPTION 1: TERMINATE AT ALB (most common, recommended)
─────────────────────────────────────────────────────────────────
Internet
  │ HTTPS (encrypted)
  ▼
[AWS ALB]          ← SSL terminated here (ACM cert)
  │ HTTP (plaintext)
  ▼
[ECS containers]   ← communicate over internal VPC network (trusted)
  │ HTTP
  ▼
[RDS]

Pros:
  ✅ ACM cert auto-renews — zero operation
  ✅ EC2/containers don't need TLS libraries configured
  ✅ Internal traffic encrypted anyway by VPC network isolation
  ✅ ALB sees full plaintext request for routing decisions
Cons:
  ❌ Internal traffic between ALB and EC2 is plaintext
  ❌ PCI/compliance: "encryption required at all times" → needs end-to-end

─────────────────────────────────────────────────────────────────
OPTION 2: END-TO-END TLS (ALB → backend TLS)
─────────────────────────────────────────────────────────────────
Internet
  │ HTTPS
  ▼
[AWS ALB]          ← Re-encrypts to backend
  │ HTTPS
  ▼
[ECS/EC2]          ← Application handles TLS, has its own cert

Required by: PCI DSS ("protect cardholder data in transit")
             Some HIPAA interpretations
Complexity: backend needs cert management too (or use ACM with NLB passthrough)

─────────────────────────────────────────────────────────────────
OPTION 3: TERMINATE AT NGINX (EC2 without ALB)
─────────────────────────────────────────────────────────────────
Internet
  │ HTTPS
  ▼
[Nginx on EC2]     ← SSL terminated (Let's Encrypt cert)
  │ HTTP
  ▼
[App server :3000]

Requires:
  - Let's Encrypt cert with auto-renewal (certbot cron/systemd timer)
  - nginx.conf SSL configuration
  - Port 443 open in security group
  - Managing cert renewal (common failure point — see File 02)

─────────────────────────────────────────────────────────────────
OPTION 4: CLOUDFRONT SSL TERMINATION (global edge)
─────────────────────────────────────────────────────────────────
User anywhere
  │ HTTPS
  ▼
[CloudFront edge] ← SSL terminated at nearest edge location (200+ worldwide)
  │ HTTPS or HTTP  ← configurable: CloudFront → origin
  ▼
[ALB or S3 origin]

Benefits: TLS session established at edge (50ms from user vs 200ms to origin)
          Global SSL = dramatically lower perceived latency
ACM requirement: CloudFront certs MUST be in us-east-1 (regardless of your stack region)
                 ← This is a critical SAA exam trap
```

---

### Nginx HTTPS Configuration

```nginx
server {
    listen 443 ssl http2;
    server_name myapp.com www.myapp.com;

    # ─────────────────────────────────────────────────────────────
    # CERTIFICATE FILES (Let's Encrypt)
    # ─────────────────────────────────────────────────────────────
    ssl_certificate     /etc/letsencrypt/live/myapp.com/fullchain.pem;  # cert + chain
    ssl_certificate_key /etc/letsencrypt/live/myapp.com/privkey.pem;

    # ─────────────────────────────────────────────────────────────
    # PROTOCOL AND CIPHER CONFIGURATION
    # ─────────────────────────────────────────────────────────────
    ssl_protocols TLSv1.2 TLSv1.3;    # Disable TLS 1.0, 1.1 (both deprecated, insecure)

    # Mozilla Intermediate compatibility (supports modern browsers):
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305;
    ssl_prefer_server_ciphers off;    # TLS 1.3: client chooses cipher anyway

    # ─────────────────────────────────────────────────────────────
    # PERFORMANCE OPTIMIZATIONS
    # ─────────────────────────────────────────────────────────────
    ssl_session_timeout 1d;
    ssl_session_cache shared:MozSSL:10m;    # ~40,000 sessions
    ssl_session_tickets off;                # security: disable session tickets (TLS 1.2)

    # OCSP Stapling: Nginx fetches cert revocation status, presents to client
    # (faster than client fetching from CA's OCSP server)
    ssl_stapling on;
    ssl_stapling_verify on;
    ssl_trusted_certificate /etc/letsencrypt/live/myapp.com/chain.pem;  # CA chain for verification
    resolver 8.8.8.8 1.1.1.1 valid=300s;   # DNS for OCSP query
    resolver_timeout 5s;

    # DH params (pre-compute to speed up DHE cipher suites):
    # openssl dhparam -out /etc/nginx/dhparam.pem 2048
    ssl_dhparam /etc/nginx/dhparam.pem;

    # ─────────────────────────────────────────────────────────────
    # SECURITY HEADERS
    # ─────────────────────────────────────────────────────────────
    add_header Strict-Transport-Security "max-age=63072000" always;  # HSTS: 2 years
    add_header X-Frame-Options DENY;
    add_header X-Content-Type-Options nosniff;

    location / {
        proxy_pass http://backend;
    }
}

# HTTP → HTTPS redirect
server {
    listen 80;
    server_name myapp.com www.myapp.com;
    return 301 https://$host$request_uri;
}
```

---

### Let's Encrypt Certificate Issuance: How ACME Works

```
ACME (Automatic Certificate Management Environment) — RFC 8555

Two challenge types for proving domain control:

HTTP-01 CHALLENGE:
  1. certbot requests cert for myapp.com
  2. Let's Encrypt gives certbot a token: Abcdef12345
  3. certbot places file at: http://myapp.com/.well-known/acme-challenge/Abcdef12345
  4. Let's Encrypt fetches that URL from the public internet
  5. If file is there with correct content: domain control proven
  6. Let's Encrypt signs and returns certificate

  Requirements: port 80 open, server running, domain resolves to this server
  Cannot use for: wildcard certs

DNS-01 CHALLENGE (required for wildcards):
  1. certbot requests cert for *.myapp.com
  2. Let's Encrypt gives certbot a token
  3. certbot creates DNS TXT record: _acme-challenge.myapp.com = "token"
  4. Let's Encrypt queries DNS for this TXT record
  5. If found: domain control proven (you control DNS → you control domain)
  6. Certificate issued (including wildcard)

  Requirements: DNS API access (Route 53 API, Cloudflare API, etc.)
  Benefit: works even when server is not publicly accessible (internal services)

  certbot with Route 53:
    pip install certbot certbot-dns-route53
    certbot certonly \
      --dns-route53 \
      -d myapp.com \
      -d *.myapp.com \
      --agree-tos \
      --email admin@myapp.com

    certbot uses AWS credentials to create the TXT record automatically
```

---

## KEY TAKEAWAYS — FILE 01

- HTTPS replaced hardware SSL terminators ($50K+ appliances) with software-based TLS (free software, $0 certs from Let's Encrypt or ACM).
- **TLS handshake**: ClientHello (client offers cipher suites) → ServerHello (server sends cert + agrees cipher) → both derive same session key → encrypted channel. ~250ms including network.
- **ACM = use when SSL terminates at AWS service** (ALB, CloudFront, API GW). Cannot export private key. Auto-renews. Zero operational work. **Let's Encrypt = use on EC2/self-managed** Nginx with certbot.
- **CloudFront certs MUST be in us-east-1** (N. Virginia region) — regardless of where your origin/ALB is. Creating ACM cert in ap-south-1 and attaching to CloudFront = will not work.
- **Wildcard certs** (`*.myapp.com`): do NOT cover apex domain (add `myapp.com` as SAN). Do NOT cover multilevel subdomains (`api.v2.myapp.com`). Let's Encrypt requires DNS-01 challenge for wildcards.

---

_Continue to File 02 → Certificate expiry incidents, mixed content, HSTS pitfalls, mTLS & debugging_
