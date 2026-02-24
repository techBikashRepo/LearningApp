# SSL/TLS Handshake — Part 3 of 3

### Topic: SSL/TLS Handshake — AWS SAA Certification, Revision & Architecture

**Series:** Networking Fundamentals → System Design → AWS Solutions Architect
**Sections Covered:** 9, 10, 11, 12

---

## SECTION 9 — AWS SAA Certification Focus

### What the Exam Tests

AWS SAA questions on TLS focus on: certificate deployment constraints, detecting TLS errors via CloudWatch, choosing the right security policy, mTLS configuration, and understanding what breaks when TLS is misconfigured.

### Trap 1: ClientTLSNegotiationErrorCount vs TargetTLSNegotiationErrorCount

```
Two distinct TLS error metrics on ALB — commonly confused in exam questions:

ClientTLSNegotiationErrorCount:
  What: TLS handshake between CLIENT and ALB failed
  Causes:
    - Client uses TLS version lower than ALB policy minimum (e.g., client TLS 1.0, ALB requires 1.2)
    - Client cipher suite not supported by ALB's security policy
    - Client sent invalid ClientHello

TargetTLSNegotiationErrorCount:
  What: TLS handshake between ALB and BACKEND TARGET failed
  Causes:
    - Backend cert expired or self-signed (ALB in HTTPS mode validates backend cert)
    - Backend doesn't support TLS version ALB is trying to use
    - Target group protocol mismatch (configured HTTP but backend expects HTTPS)

Exam pattern:
  "After enabling HTTPS on the ALB target group, all targets show Unhealthy
   and TargetTLSNegotiationErrorCount spikes. What is the cause?"

  Answer: Backend (EC2/ECS) is not configured for TLS, OR has an invalid/self-signed cert.
  Fix: Either configure HTTPS on the backend with a valid cert, OR change target group
  protocol to HTTP (and accept TLS termination at ALB only).

Remember:
  Client → ALB: ClientTLSNegotiationErrorCount (client-side problem)
  ALB → Target: TargetTLSNegotiationErrorCount (backend-side problem)
```

### Trap 2: ALB Security Policy Does NOT Apply to Origin Protocol

```
Exam trap: confusing ALB-to-client TLS policy with ALB-to-backend TLS policy.

ALB Security Policy (e.g., ELBSecurityPolicy-TLS13-1-2-2021-06):
  Applies ONLY to: connections between CLIENT and ALB
  Controls: minimum TLS version clients can use to connect to ALB
  Does NOT control: what TLS version ALB uses when connecting to backend targets

For ALB → Backend TLS:
  ALB uses its own internal TLS client to connect to backends
  The backend controls what TLS versions it accepts
  You cannot set a specific TLS version for ALB→backend (ALB uses modern TLS automatically)

CloudFront has separate viewer (client→CF) and origin (CF→origin) TLS settings:
  Viewer: Security policy on distribution (TLS version and cipher suite for clients)
  Origin: "Minimum Origin SSL Protocol" setting (TLS version to origin)
  These are configured independently
```

### Trap 3: TLS Session Tickets vs TLS Session IDs (and Server Stickiness)

```
Exam scenario:
  "Users report frequent TLS renegotiation and slower response times after
   scaling the ALB's backend from 1 to 10 instances. TLS latency increased.
   What is the likely cause and fix?"

Root cause: TLS Session ID-based resumption is server-specific.
  Session IDs are stored IN the server's memory.
  If client sends session ID, but request load-balances to a different server:
    Different server: no knowledge of that session ID → full handshake required!

With 1 server: session resumption works perfectly
With 10 servers: session resumption fails most of the time (1/10 chance of same server)

Fix: Use TLS session TICKETS instead of session IDs:
  Session tickets: the ticket is encrypted CLIENT-STORED state
  Server decrypts ticket using its ticket key → resumption works on ANY backend
  As long as all backends share the same ticket encryption key: works with any server

ALB behavior: ALB terminates TLS itself and handles session resumption at the ALB level,
not at individual backend targets. So this problem affects Nginx clusters directly.
For ALB: session resumption is managed by ALB internally (transparent to you).
Key: always terminate TLS at ALB, not at backend, for this reason.
```

### Trap 4: ACM Private CA vs ACM Public CA for mTLS

```
Exam scenario:
  "A solutions architect is designing mTLS between 20 microservices.
   The services are deployed in a private VPC. Which certificate authority
   should they use, and why?"

Answer analysis:
  ACM Public CA (certs issued by ACM):
    - Free for use with AWS services
    - Trusted by all browsers/clients worldwide
    - Cannot be used for CLIENT certificates (ACM public certs work for SERVERS only)
    - Private key is NOT exportable → cannot install on application code

  ACM Private CA:
    - ~$400/month for CA
    - Issues both server AND client certs
    - Not browser-trusted (intentionally — it's private)
    - Client cert private keys CAN be exported (for application use)
    - Integrates with ALB Trust Store for mTLS

  Correct answer: ACM Private CA
    Because: mTLS requires client certificates. ACM Public CA doesn't issue client certs.
    ACM Private CA issues client+server certs. ALB Trust Store accepts ACM Private CA certs.
    Services are internal → don't need browser trust → Private CA is appropriate.

  Common wrong answer: ACM Public Certificate (doesn't issue client certs → wrong)
  Common wrong answer: Self-signed certs (works, but doesn't scale to 20 services)
```

### Trap 5: TLS Offloading Cost at NLB vs ALB

```
Exam trap: understanding which load balancer terminates TLS and what that means.

ALB (Application Load Balancer):
  Always terminates TLS (Layer 7 operates on HTTP)
  TLS must end at ALB for ALB to route based on HTTP path/headers
  Backend sees: plain HTTP (or re-encrypted HTTPS if configured)
  X-Forwarded-Proto: https header tells backend original protocol was HTTPS

NLB (Network Load Balancer):
  Two modes:
    TCP listener: passes raw TCP bytes through (TLS PASSTHROUGH)
      → Backend terminates TLS
      → NLB sees only TCP (IP/port), no HTTP
      → Use for: mTLS, custom TLS, preserving client certificates end-to-end
    TLS listener: NLB terminates TLS (AWS handles this)
      → Backend receives plain TCP
      → ACM cert attached to NLB TLS listener (like ALB)
      → Use for: TLS offloading at NLB layer, backend gets plaintext

Exam question pattern:
  "A company requires that client certificates be visible to backend applications.
   Which load balancer configuration achieves this?"

  Answer: NLB with TCP passthrough
  ALB would terminate TLS → client cert goes away (or is forwarded as an HTTP header with ALB mTLS)
  NLB TCP passthrough → TLS session passes through unchanged → backend sees client cert
```

---

## SECTION 10 — 5 Comparison Tables

### Table 1: TLS 1.2 vs TLS 1.3 Handshake

| Dimension                    | TLS 1.2                                          | TLS 1.3                                 |
| ---------------------------- | ------------------------------------------------ | --------------------------------------- |
| Extra RTT after TCP          | 2 RTT                                            | 1 RTT                                   |
| 0-RTT resumption             | No                                               | Yes (with replay risk)                  |
| Key exchange                 | RSA (no PFS) or ECDHE (PFS)                      | ECDHE only (PFS mandatory)              |
| Cipher suites (encryption)   | ~37 suites (many deprecated)                     | 5 suites (all strong)                   |
| Certificate in TLS handshake | Plaintext (visible on wire)                      | Encrypted                               |
| Server key exchange signed   | Yes (ECDHE) or No (RSA)                          | Always (CertificateVerify)              |
| ChangeCipherSpec message     | Required                                         | Removed                                 |
| Downgrade protection         | Limited (server_random sentinel TLS 1.3 can set) | Built into key schedule                 |
| Browser support              | Universal                                        | Chrome 66+, FF 63+, Safari 12.1+ (99%+) |
| AWS ALB support              | Yes                                              | Yes (TLS13-\* policies)                 |

### Table 2: mTLS vs Standard TLS vs JWT Auth

| Dimension             | Standard TLS              | mTLS                             | JWT (with HTTPS)                             |
| --------------------- | ------------------------- | -------------------------------- | -------------------------------------------- |
| Who authenticates     | Server only               | Both server and client           | Server only at TLS; client via JWT in HTTP   |
| Client identity proof | None at TLS layer         | X.509 client certificate         | Signed JWT in Authorization header           |
| Infrastructure cost   | Low (one cert per server) | High (cert per service)          | Low (key pair for JWT signing)               |
| Rotation complexity   | Moderate                  | High (cert rotation)             | Low (JWT TTL = natural expiry)               |
| Revocation            | Via cert revocation       | CRL/OCSP + cert rotation         | Short TTL + blocklist (for immediate revoke) |
| Suitable for          | Browser-to-server         | Service-to-service (zero trust)  | User auth, API auth with tokens              |
| AWS tooling           | ACM public cert           | ACM Private CA + ALB Trust Store | Cognito, Lambda authorizers                  |
| Overhead per request  | One HMAC check            | One HMAC check                   | JWT signature verify (CPU: ~0.1ms)           |
| Latency added vs HTTP | TLS handshake once        | TLS handshake once (both certs)  | Header parsing (microseconds)                |

### Table 3: Certificate Type Comparison (Purpose vs Type)

| Property                | Server Cert (DV)               | Server Cert (EV)                 | Client Cert (mTLS)            | Code Signing Cert                   |
| ----------------------- | ------------------------------ | -------------------------------- | ----------------------------- | ----------------------------------- |
| Purpose                 | Authenticate server to browser | Same + show org name             | Authenticate client to server | Sign software executables           |
| Issued to               | Domain name                    | Organization                     | Service/user identity         | Publisher identity                  |
| Private key location    | Server (ACM-managed ideally)   | Server (HSM ideally)             | Application/device            | CI/CD system (HSM ideally)          |
| Browser trust indicator | Padlock                        | Padlock (green bar removed 2019) | No browser visible            | Windows/macOS trust warning removed |
| ACM support             | Yes (free)                     | No                               | Via Private CA                | Not applicable                      |
| Typical validity        | 90 days–13 months              | 1-2 years                        | 24 hours–1 year               | 1-3 years                           |
| Auto-renewable          | Yes (ACM, Let's Encrypt)       | Difficult                        | Yes (service mesh, SPIRE)     | Difficult                           |

### Table 4: TLS Error Codes and Root Causes

| Error                                | Layer       | Common Root Cause                                 | Fix                                                                    |
| ------------------------------------ | ----------- | ------------------------------------------------- | ---------------------------------------------------------------------- |
| `ERR_CERT_DATE_INVALID`              | Certificate | Certificate expired                               | Renew cert; enable ACM DNS validation                                  |
| `ERR_CERT_AUTHORITY_INVALID`         | Certificate | Unknown CA or incomplete chain                    | Add intermediate CA to cert; trust root CA                             |
| `ERR_SSL_VERSION_OR_CIPHER_MISMATCH` | Handshake   | Client TLS version not in server's policy         | Adjust TLS policy to include client's version                          |
| `NET::ERR_CERT_COMMON_NAME_INVALID`  | Certificate | SAN doesn't match hostname                        | Reissue cert with correct SAN                                          |
| `ClientTLSNegotiationErrorCount`     | ALB         | Client cipher/version rejected by ALB             | Change ALB security policy                                             |
| `TargetTLSNegotiationErrorCount`     | ALB         | Backend cert invalid/expired or protocol mismatch | Fix backend cert; check target group protocol                          |
| `HTTP 525` (CloudFront)              | Origin TLS  | CloudFront couldn't complete TLS with origin      | Fix origin cert; ensure CA trust                                       |
| `HTTP 526` (CloudFront)              | Origin cert | Origin cert invalid (self-signed, wrong SAN)      | Use ACM cert on origin or disable cert validation for internal origins |
| `ssl_error_rx_record_too_long`       | Protocol    | Client trying HTTP on HTTPS port                  | Ensure client uses https://                                            |

### Table 5: Session Resumption Mechanisms

| Mechanism            | TLS version  | Storage                 | Works across servers?      | Replay risk           | Notes                                                |
| -------------------- | ------------ | ----------------------- | -------------------------- | --------------------- | ---------------------------------------------------- |
| Session ID           | TLS 1.2      | Server memory           | No (server-specific)       | No                    | Fails with load balancing if no sticky sessions      |
| Session Ticket       | TLS 1.2, 1.3 | Client (encrypted blob) | Yes (if shared ticket key) | Low                   | Ticket keys must be rotated; all backends share key  |
| PSK (Pre-Shared Key) | TLS 1.3      | Client                  | Yes (with ticket)          | Low for 1-RTT         | Natural TLS 1.3 resumption mechanism                 |
| 0-RTT (Early Data)   | TLS 1.3      | Client                  | Yes                        | YES (replay possible) | Only for idempotent (GET) requests; disabled on POST |
| No resumption        | TLS 1.2/1.3  | N/A                     | N/A                        | N/A                   | Full handshake every TCP connection                  |

---

## SECTION 11 — Quick Revision

### 10 Key Points to Memorize

1. **TLS 1.3 = 1 RTT handshake.** Client sends ECDH key_share in ClientHello. Server responds with its key_share + cert + Finished. Both compute shared secret. Encrypted data starts.

2. **TLS 1.2 = 2 RTT.** Additional round trip for server to acknowledge client's key exchange before data flows.

3. **ECDH key exchange = forward secrecy.** Ephemeral key pair used PER SESSION. Server private key compromise does not allow decryption of past sessions.

4. **Certificate chain = Leaf → Intermediate → Root.** Client verifies each link. Root must be in trust store. Intermediate must be included in the TLS handshake (common misconfiguration: missing intermediate).

5. **Session tickets = server-side state moved to client.** Client holds encrypted blob. Any server with the ticket decryption key can resume. Requires shared ticket key across all backend servers.

6. **0-RTT = risky.** Data before handshake confirmation = no replay protection. Only use for idempotent GET requests. Never for POST or payments.

7. **ClientTLSNegotiationErrorCount = client-ALB TLS issue.** TargetTLSNegotiationErrorCount = ALB-backend TLS issue. Know the difference.

8. **ALB termination = Layer 7 inspection + header routing.** NLB TCP passthrough = Layer 4 only, TLS passes unchanged, client cert visible to backend.

9. **ACM Public cert → server cert only (free, non-exportable).** ACM Private CA → client + server certs ($400/mo), exportable private key, not browser-trusted.

10. **mTLS = both parties present X.509 certs.** Used for zero-trust service-to-service auth. ALB natively supports mTLS with Trust Store (forwards client cert identity as HTTP header).

---

### 30-Second Explanation (for interview "Explain TLS handshake")

> "The TLS handshake is a one-round-trip negotiation in TLS 1.3 where the client sends its encryption preferences and an ECDH public key, and the server responds with its ECDH public key, its certificate, and a Finished message. Both sides independently compute the same shared secret using Diffie-Hellman elliptic curve math — the secret never travels the network. The client verifies the server's certificate against a trusted Certificate Authority chain. Once both sides confirm with Finished messages, the connection is encrypted. Each session uses a fresh key pair, so compromising the server's private key later cannot decrypt past sessions — this is called perfect forward secrecy."

---

### Mnemonics

**TLS 1.3 = "CHEF"**

```
C — Client sends key_share in ClientHello (1 RTT instead of 2)
H — HMAC-based key derivation (HKDF for all session keys)
E — Encrypted certificate (cert travels encrypted — privacy improvement)
F — Forward secrecy mandatory (all cipher suites use ECDHE)
```

**Certificate Chain: "Leaves In Real Trees"**

```
Leaf cert (your domain cert)
Intermediate CA (online, signs leaf certs)
Root CA (offline in vault, top of trust chain)
Trust store (browser/OS has root pre-installed)
```

**TLS Error Metrics on ALB: "Client Bugs, Targets Break"**

```
ClientTLSNegotiationErrorCount → client-side issue (version, cipher mismatch)
TargetTLSNegotiationErrorCount → backend-side issue (cert expired, protocol mismatch)
```

**0-RTT = "GET Only, Never POST"**

```
0-RTT data = no replay protection
GET = idempotent = safe for 0-RTT
POST/PUT/DELETE = state-changing = replay = danger → disable 0-RTT for these
```

---

## SECTION 12 — Architect Thinking Exercise

_Read the scenario. Design your solution. Then reveal the root cause analysis._

---

### The Scenario

Your company runs 50 internal microservices. The security team mandates zero-trust networking: every service-to-service call must use mTLS with certificates issued by an internal CA. You are given 4 weeks to implement this.

**Current state:**

- 50 services deployed on ECS Fargate
- Services communicate via internal ALB (HTTP only)
- No existing PKI infrastructure
- Each service handles ~10,000 requests/second at peak

**Requirements:**

1. All service-to-service communication encrypted with mTLS
2. Certificates must auto-rotate every 72 hours (security team requirement)
3. Zero downtime during cert rotation
4. Service identity must be auditable (which service called which)
5. Implementation must not require code changes in any of the 50 services

**Questions to design before scrolling:**

1. How will you issue and distribute certificates to 50 services without code changes?
2. How do certificates rotate every 72 hours without service restart or downtime?
3. How do services verify each other's identity?
4. How does the audit trail work?

---

---

---

### Architecture Solution: Sidecar-Based mTLS

#### The Core Insight: App Code Must Not Handle Certs

The requirement "no code changes" forces a sidecar pattern. The application never knows about TLS — it speaks plain HTTP to a local proxy that handles all TLS transparently.

---

#### Component Breakdown

**1. Certificate Authority: ACM Private CA**

```
Setup:
  Create ACM Private CA in us-east-1
  Root CA: offline (AWS manages securely in HSM)
  Subordinate (Issuing) CA: online, issues service certificates

Certificate template:
  Duration: 72 hours
  Subject format: CN=service-name,O=shop.com,OU=microservices
  Key usage: digitalSignature, keyEncipherment
  Extended key usage: serverAuth, clientAuth (needed for mTLS both directions)

Cost: $400/month for CA + $0.75/cert × 50 services × (30 days/3 days) = $125/month in certs
Total: ~$525/month for PKI infrastructure
```

**2. Certificate Agent: AWS Private CA Agent (Sidecar)**

```
Deploy: ACMPCA cert-manager agent as sidecar container in every ECS task definition
  Container: public.ecr.aws/aws-crypto-tools/aws-pki-tools (open source)

Agent responsibilities:
  ① On startup: requests cert from ACM Private CA for this service identity
     SPIFFE ID: spiffe://shop.com/ns/default/sa/service-name
  ② Writes cert + private key to shared volume (not accessible from host)
  ③ At T-24h before expiry (T=48h into 72h lifetime):
       Issue CSR for new cert
       Get new cert from ACM Private CA
       Write to shared volume alongside old cert
  ④ Signals Envoy proxy via SDS (Secret Discovery Service) gRPC
  ⑤ Envoy hot-reloads cert without restart
  ⑥ Cert lifecycle event logged to CloudTrail

ECS task definition additon (simplified):
  {
    "name": "cert-agent",
    "image": "public.ecr.aws/aws-crypto-tools/aws-pki-tools",
    "environment": [
      {"name": "SERVICE_NAME", "value": "payments-service"},
      {"name": "CA_ARN", "value": "arn:aws:acm-pca:us-east-1:..."}
    ],
    "mountPoints": [{"sourceVolume": "certs", "containerPath": "/certs"}]
  }
```

**3. Envoy Proxy As Network Sidecar**

```
Also deployed as sidecar in each ECS task.

Envoy listens on:
  localhost:8080 (ingress from other services — Envoy passes to app on localhost:8000)
  Intercepts: ALL outbound HTTP calls from app → wraps in mTLS

mTLS configuration in Envoy:
  Server TLS context:
    cert_chain: /certs/server.pem    ← issued by ACM Private CA
    private_key: /certs/server-key.pem
    ca_cert: /certs/ca-bundle.pem   ← ACM Private CA root cert bundle
    require_client_certificate: true ← mTLS: enforce client cert

  Client TLS context (for outbound calls):
    cert_chain: /certs/client.pem
    private_key: /certs/client-key.pem
    ca_cert: /certs/ca-bundle.pem

Envoy verifies:
  Inbound: "Does caller's cert chain to ACM Private CA? Is CN in allowed-callers list?"
  Outbound: "Does target cert chain to ACM Private CA? Is CN=intended-service?"

Certificate hot-reload via SDS:
  Cert agent sends gRPC update: "new cert available at /certs/server-new.pem"
  Envoy atomically switches to new cert for new connections
  In-flight: completes with old cert
  After drain period (30s): old cert removed
```

**4. Service Identity Policy (Authorization)**

```
Envoy AuthorizationFilter or external OPA (Open Policy Agent):

Policy example (YAML):
  allow:
    - caller: "orders-service"
      target: "payments-service"
      paths: ["/charge", "/refund"]
    - caller: "api-gateway"
      target: "orders-service"
      paths: ["/orders/*"]

Enforcement:
  Envoy extracts caller cert CN from verified mTLS handshake
  Checks against PolicyEngine (local cache, refreshed every 60s from S3)
  Denied calls: 403 response + CloudWatch metric: mTls.AuthorizationDenied

Why this satisfies zero-trust:
  Even if service-A ECS container is compromised:
    It can ONLY call services and paths it's explicitly authorized for
    Its cert CN identifies it unmistakably as "service-a"
    It cannot forge a different CN (cert is signed by CA, CN is in the cert)
```

**5. Audit Trail**

```
ACM Private CA CloudTrail logs:
  Every cert issuance: service name, timestamp, cert ARN → S3 → Athena

Envoy access logs → Kinesis Firehose → S3:
  Each request logged with:
    source_cert_cn: "orders-service"
    dest_cert_cn: "payments-service"
    path: "/charge"
    result: "allowed" / "denied"

Athena query for audit:
  SELECT source_cert_cn, dest_cert_cn, path, COUNT(*) as calls
  FROM envoy_access_logs
  WHERE date = '2026-02-23'
  GROUP BY 1,2,3 ORDER BY calls DESC;
```

---

#### Zero-Downtime Rotation Timeline

```
T=0h    Cert issued (72h lifetime)
T=48h   Cert agent requests new cert from ACM Private CA
        Cert agent writes new cert alongside old: /certs/server-new.pem
T=48h   Cert agent notifies Envoy via SDS: "new cert ready"
T=48h   Envoy accepts new cert for new connections
        Old cert: still used for in-flight connections
T=48h+30s  All in-flight connections completed
           Envoy removes old cert from memory
T=72h   Old cert expires — already replaced 24 hours ago
        No disruption, no restart, no downtime
```

---

#### What the Architect Learned

The requirement "no code changes" and "auto-rotate every 72 hours without downtime" defines the architecture: you cannot put cert logic in the application. Sidecars exist precisely for this pattern.

The key architectural decisions and their reasons:

1. **ACM Private CA**: scales cert issuance, integrates with AWS IAM for fine-grained access control, provides CloudTrail audit without building log infrastructure
2. **Envoy sidecar + SDS**: hot certificate reload without process restart — only possible because Envoy treats certs as dynamic config, not startup config
3. **SPIFFE identity format**: standard format enabling future migration to service mesh (Istio, App Mesh) without re-architecting the identity model
4. **ACM Private CA NOT browser-trusted**: this is CORRECT for internal services — you don't want browser users accidentally connecting to internal services; the "untrusted" CA is a security feature

**Principle:** Security infrastructure must be invisible to application developers. If developers must write certificate management code, it will be inconsistent across 50 teams and will have bugs. Standardize it at the infrastructure layer.

---

## Complete Topic Summary — SSL/TLS Handshake (All 3 Files)

| Section | Content                                                                                                                                                          |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1       | Spy meeting + VIP club analogies; TLS handshake purpose (negotiate/verify/exchange/confirm)                                                                      |
| 2       | TLS stack position; TLS 1.2 2-RTT vs TLS 1.3 1-RTT; cipher suite anatomy; key schedule; session resumption; 0-RTT                                                |
| 3       | ASCII: full TLS 1.3 timing with ms; TLS record structure (AEAD: encrypt + MAC in one)                                                                            |
| 4       | Step-by-step: TLS 1.3 handshake 12 steps; session resumption with PSK; certificate pinning                                                                       |
| 5       | Diffie-Hellman as numbers; passport chain analogy; Cloudflare TLS at scale (0-RTT replay, ticket rotation)                                                       |
| 6       | TLS handshake CPU cost at scale; mTLS in microservices; cert rotation without downtime; TLS debugging commands                                                   |
| 7       | AWS: ACM lifecycle, ACM Private CA, ALB TLS policies + mTLS Trust Store, CloudFront TLS config, IoT mTLS                                                         |
| 8       | 8 Q&As: SSL vs TLS naming, HTTPS not E2EE, unknown CA, downgrade attacks, first-request latency, CT logs, 10K service mTLS, CloudHSM/ACM key protection          |
| 9       | AWS SAA traps: Client vs TargetTLSNegotiationErrorCount, ALB policy scope, session tickets vs IDs, ACM Private CA for mTLS, NLB TCP passthrough for client certs |
| 10      | 5 tables: TLS 1.2 vs 1.3, mTLS vs JWT, cert types, TLS error codes, session resumption mechanisms                                                                |
| 11      | 10 key points; CHEF/Leaves In Real Trees/Get Only Never POST mnemonics; 30-second explanation                                                                    |
| 12      | Architect exercise: 50-service ECS zero-trust mTLS — ACM Private CA + Envoy sidecar + SDS hot-reload + OPA policy engine + 72h zero-downtime rotation            |
