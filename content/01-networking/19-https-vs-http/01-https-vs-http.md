# HTTPS vs HTTP — Part 1 of 3

### Topic: HTTPS vs HTTP — TLS, Certificates, and Secure Communication

**Series:** Networking Fundamentals → System Design → AWS Solutions Architect
**Sections Covered:** 1, 2, 3, 4

---

## SECTION 1 — ELI12: What Is HTTPS?

### The Core Problem: HTTP Is a Transparent Postcard

When you send a regular HTTP request, imagine writing your message on a postcard and dropping it in the mail. Every postal worker who handles it — at every sorting facility, every truck, every mailbox — can read exactly what's on it. Your login details, your search queries, your banking transactions — all visible to anyone handling the "mail."

HTTPS puts that postcard into a tamper-evident, opaque, sealed envelope — one that only the intended recipient can open.

### Analogy 1 — Transparent Postcard vs Sealed Envelope

**HTTP:**

```
Your laptop → Your WiFi router → ISP → Backbone routers → Web server
    │               │              │          │
    └─────────────── CAN READ MESSAGE AT EVERY HOP ────────────────┘

Contents visible: "User: alice@gmail.com, Password: hunter2, Card: 4532..."
```

**HTTPS:**

```
Your laptop                                           Web server
    │                                                      │
    ├── TLS Handshake: Exchange encryption keys ──────────┤
    │   (only you and server can crack this open)          │
    │                                                      │
Your laptop → WiFi → ISP → Backbone → Web server
    │           │      │       │
    └─ All they see: ─────────────────────────────────────┘
       "encrypted gibberish" (cannot read without key)
```

HTTPS = HTTP + TLS (Transport Layer Security). TLS handles the envelope — HTTP still works exactly the same way inside. Your GET requests, POST with JSON body, response codes: all unchanged. They're just encrypted in transit.

### Analogy 2 — A Phone Call vs an Encrypted Walkie-Talkie

**HTTP = Phone call you can overhear:**
Imagine a phone call in an open office. Anyone nearby can hear both sides. The office could be your coffee shop WiFi, your company's network, or a malicious hotspot named "FreeAirportWiFi."

**HTTPS = Encrypted walkie-talkie with a code book:**
Before the call starts, you and the recipient privately establish a shared code book — one that only the two of you know. Now you speak in code. Anyone overhearing hears nothing useful. Even if they record the entire conversation, they can't decode it later because the code book was negotiated privately and is never transmitted.

The "code book negotiation" is the TLS handshake. The code changes every session (perfect forward secrecy) so even if a key is compromised later, past conversations remain secure.

### Three Properties HTTPS Provides

```
1. CONFIDENTIALITY (privacy):
   Traffic is encrypted → eavesdroppers see only random bytes
   "What did Alice order?" → unknowable to anyone between client and server

2. INTEGRITY (tamper detection):
   Every TLS record has a cryptographic MAC (Message Authentication Code)
   If anyone modifies a single bit of the ciphertext in transit:
   → MAC verification fails → receiver detects tampering
   → Connection aborted (not used)
   Prevents: ISP injecting ads into HTTP responses (common on unencrypted connections)

3. AUTHENTICATION (server identity):
   Certificate issued by trusted Certificate Authority (CA)
   Browser verifies: "Is this really api.shop.com?"
   Prevents: Man-in-the-middle where attacker intercepts and pretends to be the server
```

---

## SECTION 2 — Core Technical Deep Dive

### TLS Architecture

TLS (Transport Layer Security) sits between TCP and HTTP:

```
Application Layer    HTTP (GET /orders, 200 OK, headers, body)
                          ↕
TLS Layer            Encrypt, authenticate, integrity-check
                          ↕
TCP Layer            Ordered, reliable byte stream
                          ↕
IP Layer             Packet routing
```

TLS versions:

- **TLS 1.0** (1999): deprecated, broken (POODLE, BEAST attacks)
- **TLS 1.1** (2006): deprecated
- **TLS 1.2** (2008): still widely used, 2-RTT handshake
- **TLS 1.3** (2018): 1-RTT handshake, removed weak algorithms, mandatory forward secrecy

### TLS 1.3 Handshake (Modern)

TLS 1.3 completes in a single round-trip (1-RTT):

```
CLIENT                                              SERVER

1. ClientHello:
   TLS version: 1.3
   Supported cipher suites: TLS_AES_256_GCM_SHA384, TLS_CHACHA20_POLY1305_SHA256
   key_share: client's ephemeral ECDH public key  ← Enables Diffie-Hellman
   server_name: "shop.com"                         ← SNI extension
   ────────────────────────────────────────────────────────►

                                              2. ServerHello:
                                                 Chosen cipher: TLS_AES_256_GCM_SHA384
                                                 key_share: server's ephemeral ECDH public key
                                                 (Both sides now compute shared secret independently)

                                              3. {EncryptedExtensions}
                                                 Certificate (for "shop.com")
                                                 CertificateVerify (proof server has private key)
                                                 Finished (MAC over handshake)
   ◄────────────────────────────────────────────────────────

4. Client verifies certificate:
   - cert signed by trusted CA?
   - cert CN/SAN matches "shop.com"?
   - cert not expired?
   - cert not revoked? (CRL or OCSP)

5. Client: {Finished}
   ────────────────────────────────────────────────────────►

6. Encrypted HTTP begins immediately:
   GET /orders HTTP/1.1 [encrypted with derived key]
   ────────────────────────────────────────────────────────►

                                              7. 200 OK [encrypted]
   ◄────────────────────────────────────────────────────────

Total additional latency: 1 RTT (TLS 1.3) vs 2 RTT (TLS 1.2)
Combined with TCP handshake: TCP SYN/SYN-ACK/ACK (1 RTT) + TLS (1 RTT) = 2 RTT total before HTTP
QUIC (HTTP/3): 0-RTT or 1-RTT including transport — TLS built into QUIC
```

### Certificate Chain of Trust

TLS authentication works through a hierarchy:

```
Root CA (DigiCert, Let's Encrypt, Amazon)
    └── Intermediate CA (issued by Root CA)
        └── Leaf Certificate (issued for "shop.com")
            ├── Subject: CN=shop.com, SAN=*.shop.com, api.shop.com
            ├── Valid: 2026-01-01 to 2027-01-01
            ├── Public Key: RSA 2048-bit or ECDSA P-256
            └── Issuer Signature: signed by Intermediate CA private key

Browser has Root CA certificates pre-installed:
  Windows: Computer Certificate Store → Trusted Root Certification Authorities
  macOS: Keychain Access → System Roots
  Firefox: Bundled Mozilla root store (independent of OS)

Verification chain:
  "shop.com" cert signed by Intermediate CA? ✓
  Intermediate CA cert signed by DigiCert Root CA? ✓
  DigiCert Root CA in browser's trust store? ✓
  → Server identity verified

Why 3 levels (not just 2)?
  Root CA private keys are stored OFFLINE (physically in secure facilities)
  If Intermediate CA is compromised: revoke just the Intermediate CA cert
  Root CA key remains safe → issue new Intermediate CA → re-issue leaf certs
  If Root CA key were used directly: compromise = catastrophic
```

### Key Concepts

**Server Name Indication (SNI):**
Allows multiple HTTPS websites to share one IP address. Client sends the target hostname in the ClientHello BEFORE encryption. CDNs (CloudFront, Fastly) serve thousands of sites from the same IP pools — SNI tells them which certificate to present.

```
Without SNI: One TLS certificate per IP address
  ip: 1.2.3.4 → must serve cert for exactly one domain

With SNI: Multiple TLS certificates per IP address
  Client: "I'm connecting to shop.com" (in ClientHello before encryption)
  Server: "Here's shop.com's certificate (not other.com's)"
```

**HSTS and HSTS Preload:**

```
First visit: HTTP → 301 → HTTPS (one unencrypted request visible to network)
With HSTS header: Strict-Transport-Security: max-age=31536000
  → Browser notes: shop.com = HTTPS-only for 31536000 seconds
  → All subsequent HTTP requests auto-upgraded to HTTPS BEFORE leaving browser
  → No unencrypted request ever leaves the machine

HSTS Preload: Submit domain to hstspreload.org
  → Domain hardcoded in browser source code
  → Zero-trust even on FIRST visit (browser ships with domain in preload list)
  → Cannot be undone quickly: requires Chrome/Firefox/Edge code change + months to roll out
```

**Certificate Transparency (CT):**
All publicly-trusted certificates must be logged in CT logs (Merkle tree structure). Browsers reject certificates not in CT logs. This allows:

- Detection of misissued certificates (someone got a cert for YOUR domain you didn't authorize)
- Monitoring: cert-spotter.io notifies when new certs are issued for your domain

**mTLS (Mutual TLS):**
Normal TLS: only SERVER presents a certificate (client trusts server).
mTLS: BOTH parties present certificates (server also verifies client identity).
Used for: service-to-service authentication in microservices, VPN clients, API clients with machine identity.

```
Normal TLS:
  Client → "Who are you?" → Server presents cert → Client verifies

Mutual TLS:
  Client → "Who are you?" → Server presents cert → Client verifies
  Server → "Who are YOU?" → Client presents cert → Server verifies
  Only clients with valid certificates can connect
```

---

## SECTION 3 — ASCII Diagram

### HTTP vs HTTPS — What Network Observers Can See

```
HTTP (exposed):                     HTTPS (encrypted):

Client → Attacker → Server         Client → Attacker → Server

Network observer sees:             Network observer sees:
  Host: shop.com               →     TLS encrypted connection to shop.com
  GET /checkout?                     (ONLY the IP:port is visible,
  Cookie: session_id=abc123          not the path, headers, or body)
  Authorization: Bearer eyJ...
  Body: {card: "4532...",
         cvv: "123",
         amount: 99.99}

100% of sensitive data exposed.    Server IP visible, NOTHING ELSE.
```

### TLS Record Layer Structure

```
TLS Record (each HTTP message wrapped in TLS record):
┌─────────────────────────────────────────────┐
│ Content Type: Application Data (0x17)       │ (1 byte)
│ TLS Version: 1.2 (0x0303)                  │ (2 bytes)
│ Length: 1024                                │ (2 bytes)
├─────────────────────────────────────────────┤
│ Encrypted Application Data:                 │
│   [HTTP headers, body, etc., encrypted with │
│    AES-256-GCM or ChaCha20-Poly1305]        │
│                                             │
│ Authentication Tag (MAC):                   │
│   [16 bytes: proves data not tampered]      │
└─────────────────────────────────────────────┘

Nonce: unique per record (prevents replay attacks)
Key: derived from TLS handshake (unique per session, rotatable)
AEAD cipher: Authenticated Encryption with Additional Data
  → Encrypts AND authenticates simultaneously
  → Tampering with ciphertext = authentication tag mismatch = reject
```

### Certificate Chain Validation

```
                     ┌─────────────────┐
                     │   Root CA       │
                     │   (self-signed) │
                     │   Stored in     │
                     │   Browser/OS    │
                     └────────┬────────┘
                              │ signs
                     ┌────────▼────────┐
                     │ Intermediate CA │
                     │ Valid 2022-2032  │
                     │ Kept online     │
                     └────────┬────────┘
                              │ signs
                     ┌────────▼────────┐
                     │  shop.com Leaf  │
                     │  Valid 90 days  │  ← Sent by server in TLS handshake
                     │  SAN: shop.com  │
                     │  api.shop.com   │
                     └─────────────────┘

Browser:
  ① Verify leaf cert signed by Intermediate → ✓
  ② Verify Intermediate cert signed by Root → ✓
  ③ Root in my trust store? → ✓
  ④ Cert not revoked? (OCSP stapling) → ✓
  ⑤ SAN matches "shop.com"? → ✓
  → Certificate valid. Proceed with TLS.
```

---

## SECTION 4 — Step-by-Step Flows

### Flow 1 — Full HTTPS Connection from Browser to Server

```
Step 1: User types https://shop.com in browser
  Browser: DNS query for shop.com → 1.2.3.4 (20ms)

Step 2: TCP handshake (3-way)
  Browser → SYN → Server                    (1 packet)
  Browser ← SYN-ACK ← Server
  Browser → ACK → Server
  TCP established. (~20ms RTT)

Step 3: TLS 1.3 Handshake (1-RTT)
  Browser → ClientHello (SNI: shop.com, key_share, cipher list)
  Browser ← ServerHello + Certificate + Finished
  Browser verifies certificate chain:
    cert valid, not expired, signed by trusted CA, SAN matches shop.com
  Browser → Finished
  TLS established. (~20ms more)

Step 4: HTTP request (now encrypted)
  Browser → GET / HTTP/1.1 [encrypted]
  Browser ← 200 OK [encrypted] + HTML
  First byte received: ~10ms (server processing) + ~10ms (transfer)

Total time from typing URL to first byte: DNS(20) + TCP(20) + TLS(20) + server(10) + xfer(10) = ~80ms
HTTPS adds only ONE RTT (TLS handshake) vs HTTP (one TCP handshake less secure)
```

### Flow 2 — Certificate Renewal (Let's Encrypt ACME Protocol)

How modern TLS certificates are automatically issued and renewed (no manual process):

```
Step 1: Domain validation challenge
  Let's Encrypt CA sends ACME challenge:
  "Prove you control shop.com. Place this file:
   http://shop.com/.well-known/acme-challenge/TOKEN_VALUE"

  Your ACME client (certbot, ACM) creates the file at that path.

  Let's Encrypt visits http://shop.com/.well-known/acme-challenge/TOKEN_VALUE
  File found with correct content → domain validated

  Alternative: DNS challenge (create TXT record in DNS):
   _acme-challenge.shop.com → TXT: "randomtoken123"
   Let's Encrypt checks DNS → TXT record found → validated
   (DNS challenge required for wildcard certs: *.shop.com)

Step 2: Certificate issuance
  ACME client generates RSA/ECDSA key pair
  Sends Certificate Signing Request (CSR) to Let's Encrypt
  Let's Encrypt signs → issues leaf certificate (90-day validity)

  Why 90 days? Short lifetime reduces damage from compromise.
  Auto-renewal means this isn't a burden — certbot renewal runs daily.

Step 3: Auto-renewal (certbot cronjob or ACM managed)
  # Certbot: runs twice daily (cron), renews if < 30 days remaining
  certbot renew

  ACM (AWS Certificate Manager): completely managed
  ACM renews automatically → re-validates domain → installs new cert on ALB/CloudFront
  Zero human action required IF DNS validation was used at initial setup

Step 4: Reload web server with new certificate
  certbot post-hook: systemctl reload nginx
  (ACM handles this automatically for ALB and CloudFront)
```

### Flow 3 — HTTPS Mixed Content Problem and Fixing It

```
Scenario: Your site is HTTPS but an asset is loaded over HTTP

Page HTML (served via HTTPS):
  <script src="http://cdn.shop.com/analytics.js"></script>
  ↑ HTTP in an HTTPS page = MIXED CONTENT

Browser behavior:
  Active mixed content (scripts, CSS, iframes):
    Chrome/Firefox: BLOCK the HTTP resource entirely
    Console: "Mixed Content: The page at 'https://shop.com' was loaded over HTTPS,
             but requested an insecure resource 'http://cdn.shop.com/...' This
             request has been blocked; the content must be served over HTTPS."

  Passive mixed content (images, audio, video):
    Some browsers warn, some upgrade to HTTPS automatically

Fix options:
  ① Change the resource URL to HTTPS: <script src="https://cdn.shop.com/analytics.js">
  ② Use protocol-relative URL: <script src="//cdn.shop.com/analytics.js">
     (inherits protocol of parent page — HTTPS if page is HTTPS)
  ③ Add upgrade-insecure-requests CSP directive:
     Content-Security-Policy: upgrade-insecure-requests
     (Browser auto-upgrades HTTP resource requests to HTTPS)

Why mixed content is dangerous:
  If any resource loads over HTTP: network observer CAN read/modify that resource
  Injected JavaScript in HTTP response = attacker can control page behavior
  "Your page is as secure as its least-secure resource"
```

---

## File Summary

This file covered:

- Transparent postcard (HTTP) vs sealed envelope (HTTPS); phone call vs encrypted walkie-talkie analogies
- Three properties of HTTPS: confidentiality (encryption), integrity (MAC), authentication (certificate)
- TLS 1.3 handshake: 1-RTT, ECDH key exchange, client verifies certificate chain
- Certificate chain: leaf → intermediate CA → root CA (why 3 levels; root stored offline)
- SNI: multiple HTTPS sites on one IP — hostname sent before encryption in ClientHello
- HSTS and preload: auto-upgrade HTTP→HTTPS in browser, zero unencrypted requests
- Certificate Transparency: all certs must be logged; detects misissued certs
- mTLS: mutual authentication (both sides present certs) for service-to-service security
- ASCII diagrams: HTTP vs HTTPS attacker viewpoint, TLS record structure, certificate chain validation
- Step-by-step: full HTTPS timing (~80ms), ACME auto-renewal (Let's Encrypt/ACM), mixed content detection and fix

**Continue to File 02** for real-world analogies, system design patterns, AWS mapping, and 8 Q&As.
