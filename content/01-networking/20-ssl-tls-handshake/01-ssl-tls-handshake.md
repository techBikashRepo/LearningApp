# SSL/TLS Handshake — Part 1 of 3

### Topic: SSL/TLS Handshake — Concepts, Architecture, and Deep Dive

**Series:** Networking Fundamentals → System Design → AWS Solutions Architect
**Sections Covered:** 1, 2, 3, 4

---

## SECTION 1 — ELI12: Explain Like I'm 12

### What Is the TLS Handshake?

Every time your browser connects to https://amazon.com, before any shopping page is exchanged, the browser and the server run a **secret negotiation ritual** that lasts a fraction of a second but establishes total privacy for everything that follows. That ritual is the TLS handshake.

The handshake answers four questions:

1. **Which encryption method will we both use?** (cipher suite negotiation)
2. **Are you REALLY amazon.com and not a hacker pretending to be?** (certificate verification)
3. **How do we agree on a secret key without anyone on the network learning it?** (key exchange)
4. **Did everything arrive untampered?** (handshake integrity verification)

Once the handshake completes, BOTH sides have an identical secret key that nobody else has — and all subsequent communication is encrypted with that key.

---

### Analogy 1 — The Spy Meeting in a Public Café

Two spies need to exchange secrets. They're meeting in a busy café full of people who might be listening. Problem: they've never met before and have no shared secret. How do they establish one without anyone in the café learning it?

Step 1 → **Hello and capabilities:** Spy A sits down and says: "I can speak in Code Blue, Code Red, or Code Green." Spy B says: "I can also speak Code Blue — let's use that."

Step 2 → **Identity proof:** Spy B shows a passport issued by a trusted government. Spy A hasn't met Spy B before, but trusts the government. The passport proves Spy B's identity.

Step 3 → **Secret key exchange (magic math):** Each spy takes out a colored paint tube. Spy A mixes yellow + their private red. Spy B mixes yellow + their private blue. They swap the mixed paint openly (everyone sees it). Each spy adds their OWN private color to the paint they received. By mathematical magic (Diffie-Hellman), they both end up with the same final color — the shared secret — even though nobody watching can figure out either spy's private color.

Step 4 → **"I'm ready":** Both spies say a short verification word in the new code. If it's right, the secure channel is established.

This is TLS — happening in milliseconds, across the internet.

---

### Analogy 2 — VIP Club with a Bouncer and Wristbands

Imagine an exclusive VIP club with strict security:

**"Which door protocol?"** → The club has Door A (standard entry), Door B (members only), Door C (ultra-VIP). When you arrive, you and the bouncer quickly agree on which door applies to you.

**"Prove you're invited"** → The bouncer checks your invitation card, which was signed by the club's known event organizer. They verify the signature. Without the real organizer's signature, no entry.

**"Wristband exchange"** → Both you and the bouncer pick a color from a secret palette. Through a clever visual trick (colored lights), you independently produce matching wristbands without either ever directly handing the real color to the other. A spy watching the lights cannot figure out either color separately.

**"Test the wristband"** → You both wave the wristband under a scanner. It matches. Only now does the inner club door open and confidential conversations begin.

The TLS handshake is this sequence — protocol negotiation → identity verification → key exchange → integrity verification.

---

## SECTION 2 — Core Technical Deep Dive

### TLS Protocol Position in the Stack

```
Application Layer  (HTTP, FTP, SMTP — your actual data)
       ↕
TLS Record Layer   (encrypts, MACs, fragments application data)
TLS Handshake      (negotiates params, authenticates, establishes keys)
       ↕
Transport Layer    (TCP — reliable byte stream)
       ↕
Network Layer      (IP — routing)
```

TLS sits BETWEEN TCP and the application protocol. TCP provides reliable delivery; TLS provides security. The application (HTTP) is completely unaware of TLS — it just writes bytes that transparently become encrypted.

---

### TLS 1.2 Handshake (2-RTT, Legacy but Still Common)

```
Client                                          Server
  │                                               │
  │──── ClientHello ────────────────────────────► │
  │     • TLS version supported (max 1.2)         │
  │     • Random bytes (client_random)            │
  │     • Cipher suites list                      │
  │     • Session ID (for resumption)             │
  │     • Compression methods                     │
  │                                               │
  │ ◄─── ServerHello ──────────────────────────── │
  │       • Chosen TLS version                    │
  │       • Random bytes (server_random)          │
  │       • Chosen cipher suite                   │
  │       • Session ID                            │
  │                                               │
  │ ◄─── Certificate ──────────────────────────── │
  │       • Server's X.509 certificate chain      │
  │                                               │
  │ ◄─── ServerKeyExchange ────────────────────── │
  │       • ECDH public key (if ECDHE cipher)     │
  │       • Signed by server's certificate key    │
  │                                               │
  │ ◄─── ServerHelloDone ──────────────────────── │
  │                                               │
  │ ← Client verifies certificate chain ─────────┤
  │   (checks signature, CA trust, expiry, SAN)   │
  │                                               │
  │──── ClientKeyExchange ──────────────────────► │
  │     • Client's ECDH public key                │
  │                                               │
  ├── BOTH compute pre_master_secret from ECDH ──┤
  ├── BOTH derive session keys using PRF: ────────┤
  │     master_secret = PRF(pre_master_secret,    │
  │                         client_random,        │
  │                         server_random)        │
  │                                               │
  │──── ChangeCipherSpec ───────────────────────► │
  │     "I'm switching to encrypted mode"         │
  │──── Finished ───────────────────────────────► │
  │     (Encrypted hash of all handshake msgs)    │
  │                                               │
  │ ◄─── ChangeCipherSpec ──────────────────────── │
  │ ◄─── Finished ──────────────────────────────── │
  │       (Encrypted hash of all handshake msgs)  │
  │                                               │
  │ ◄══ Encrypted Application Data ══════════════► │
  │     (HTTP GET / etc.)                         │

Total extra round trips: 2 RTT (beyond TCP's 1 RTT)
RTT 1: ClientHello → ServerHelloDone
RTT 2: ClientKeyExchange+Finished → ServerFinished
```

---

### TLS 1.3 Handshake (1-RTT, Current Standard)

TLS 1.3 made a radical simplification: the client ASSUMES it knows which key exchange to use (ECDH) and sends its key share IN the ClientHello. This collapses 2 RTT to 1 RTT.

```
Client                                          Server
  │                                               │
  │──── ClientHello ────────────────────────────► │
  │     • Supported TLS versions                  │
  │     • Client_random                           │
  │     • Cipher suites (TLS 1.3 only)            │
  │     • key_share: Client's ECDH public key     │  ← NEW: key sent immediately
  │     • SNI (server name indication)            │
  │     • PSK identity (for session resumption)   │
  │                                               │
  │ ◄─── ServerHello ──────────────────────────── │
  │       • Chosen cipher suite                   │
  │       • key_share: Server's ECDH public key   │  ← Server sends its ECDH key
  │                                               │
  ├── BOTH compute handshake secret via ECDH ─────┤
  │                                               │
  │ ◄─── {EncryptedExtensions} ─────────────────── │  ← ENCRYPTED from here
  │ ◄─── {Certificate} ─────────────────────────── │  ← cert is now encrypted!
  │ ◄─── {CertificateVerify} ───────────────────── │  ← proves private key ownership
  │ ◄─── {Finished} ────────────────────────────── │
  │                                               │
  │ Client verifies cert (offline, locally) ─────┤
  │                                               │
  │──── {Finished} ────────────────────────────► │
  │                                               │
  │ ◄══ {Application Data} ══════════════════════► │
  │     HTTP can be INCLUDED in this message!     │

Total extra round trips: 1 RTT (vs TCP)
Key insight: Client sends key_share in HelloRTT, server responds with HelloRTT + data
```

---

### Cipher Suite Anatomy

A cipher suite is a named combination of algorithms for key exchange, authentication, encryption, and MAC:

```
TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256

TLS_        → Protocol
ECDHE_      → Key exchange: Elliptic Curve Diffie-Hellman Ephemeral (provides PFS)
RSA_        → Authentication: RSA signature verifies server identity
WITH_       → separator
AES_128_GCM → Bulk encryption: AES 128-bit in Galois/Counter Mode (authenticated encryption)
_SHA256     → PRF/MAC: SHA-256 for HMAC and key derivation

TLS 1.3 cipher suites (simplified — key exchange methods are separate):
  TLS_AES_256_GCM_SHA384
  TLS_CHACHA20_POLY1305_SHA256
  TLS_AES_128_GCM_SHA256
```

---

### Session Resumption (Avoiding Repeat Handshakes)

Full handshake: expensive (1-2 RTT). Repeated for every new TCP connection.

```
TLS Session Tickets (TLS 1.2 and 1.3):
  After handshake: server creates an encrypted blob (session ticket)
  containing session keys + metadata
  Server sends ticket to client

  Next connection:
  Client sends ticket in ClientHello
  Server decrypts ticket, recovers session keys
  → Skip the full key exchange (0-RTT or fast 1-RTT resumption)

  Security note: session ticket keys must be rotated regularly
  (if ticket key is compromised, any recorded session with that ticket can be decrypted)

0-RTT (TLS 1.3 Early Data):
  Client sends application data WITH the ClientHello using previous session key
  Server can respond immediately
  Downside: no protection against replay attacks (same request sent twice)
  Use only for: safe, idempotent requests (GET)
  Never use for: POST, payments, state-changing operations
```

---

### What Each Party Derives (Key Material)

The handshake produces not just one key, but a key schedule:

```
Input to key derivation:
  early_secret (from PSK or zeros if no PSK)
    ↓
  handshake_secret (from ECDH shared secret)
    ↓
  master_secret
    ↓ (HKDF expand-label)

Four session keys derived:
  client_handshake_traffic_secret → encrypts client Finished message
  server_handshake_traffic_secret → encrypts server cert + Finished
  client_application_traffic_secret → encrypts client's HTTP data
  server_application_traffic_secret → encrypts server's HTTP response

Why separate keys for each direction?
  → If attacker compromises one direction, the other is unaffected
  → Provides directional integrity: can't mix client/server streams
```

---

## SECTION 3 — ASCII Diagram

### Full TLS 1.3 Handshake with Timing

```
TIME │  CLIENT (Browser)           NETWORK              SERVER (nginx)
─────┼──────────────────────────────────────────────────────────────────
 0ms │  DNS lookup begins
20ms │  DNS resolved: 93.184.216.34
20ms │  TCP SYN ───────────────────────────────────────────────────────►
     │                                                           SYN-ACK
40ms │  ◄──────────────────────────────────────────── TCP SYN-ACK
40ms │  TCP ACK (3-way handshake complete)         TCP established
─────┼─────────────────── TLS Handshake Begins ──────────────────────────
40ms │  ClientHello ──────────────────────────────────────────────────►
     │  [TLS 1.3 only, ECDH key_share, SNI=shop.com, client_random]
     │
60ms │                        Server receives ClientHello
     │                        Selects cipher suite: TLS_AES_256_GCM_SHA384
     │                        Generates ECDH key pair
     │                        Computes ECDH shared secret
     │                        Derives handshake keys
     │
60ms │  ◄──────────────────────────────────────────── ServerHello
     │  [server_ecdh_key_share, server_random]
     │  ◄──────────────────────────────────────────── {EncryptedExtensions}
     │  ◄──────────────────────────────────────────── {Certificate}
     │  [shop.com cert signed by DigiCert Intermediate]
     │  ◄──────────────────────────────────────────── {CertificateVerify}
     │  [RSA signature proving private key ownership]
     │  ◄──────────────────────────────────────────── {Finished}
     │  [HMAC of all handshake messages]
     │
80ms │  Client computes ECDH shared secret
     │  Client derives handshake keys
     │  Client verifies certificate:
     │    ✓ DigiCert signed certificate
     │    ✓ DigiCert cert signed by Root CA
     │    ✓ Root CA in browser trust store
     │    ✓ Not expired (exp: 2027-01-01)
     │    ✓ SAN matches shop.com
     │    ✓ Server's signature validates with cert's public key
     │  Client verifies Finished HMAC ✓
     │
80ms │  {Finished} ────────────────────────────────────────────────────►
     │  [Client's HMAC of handshake messages]
     │                                        Server verifies Finished ✓
─────┼────────────────── Encrypted Channel Ready ────────────────────────
80ms │  {Application Data} ────────────────────────────────────────────►
     │  GET /products HTTP/2
     │
90ms │  ◄──────────────────────────────────────────── {Application Data}
     │  HTTP/2 200 OK ...product list...

TIMING BREAKDOWN:
  TCP handshake: 20ms (1 RTT)
  TLS handshake: 20ms (1 RTT)  ← TLS 1.3 adds just 1 RTT
  HTTP request:  10ms
  Total: ~90ms
```

---

### TLS Record Structure

Every piece of data sent after TLS handshake is wrapped in a TLS Record:

```
┌─────────────────────────────────────────────────────┐
│ TLS Record Header (5 bytes)                         │
│  Content Type:  1 byte  (23=Application Data,       │
│                          22=Handshake, 21=Alert)    │
│  Legacy Version: 2 bytes (0x0303 = TLS 1.2 compat)  │
│  Length:        2 bytes  (max 16,384 bytes / record) │
├─────────────────────────────────────────────────────┤
│ Encrypted Payload                                   │
│  [Padded plaintext + Content Type byte]             │
│  Encrypted with AES-256-GCM or ChaCha20-Poly1305    │
├─────────────────────────────────────────────────────┤
│ Authentication Tag (16 bytes)                       │
│  AEAD tag — detects any tampering with record       │
│  If tag invalid: connection is immediately aborted  │
└─────────────────────────────────────────────────────┘

AEAD = Authenticated Encryption with Associated Data
     = encryption + integrity MAC in one operation
     = no separate HMAC step needed
```

---

## SECTION 4 — Step-by-Step Flows

### Flow 1: Complete TLS 1.3 Handshake with Certificate Validation

```
Step 1: TCP Connection Established
   Browser has IP (e.g., 93.184.216.34), has opened TCP socket
   TCP 3-way handshake complete (SYN→SYN-ACK→ACK)
   TCP socket ready for data

Step 2: ClientHello
   Browser constructs:
     • Supported versions: [TLS 1.3, TLS 1.2]
     • client_random: 32 cryptographically random bytes
     • Cipher suites: [TLS_AES_256_GCM_SHA384, TLS_AES_128_GCM_SHA256, ...]
     • Key share extension: Client generates ECDH key pair
       private_key_c = random 32 bytes
       public_key_c = private_key_c × curve_generator_point  (elliptic curve math)
       Sends: public_key_c
     • SNI extension: server_name = "shop.com"

Step 3: ServerHello
   Server chooses: TLS 1.3, cipher TLS_AES_256_GCM_SHA384
   Server generates its ECDH key pair:
     private_key_s = random 32 bytes
     public_key_s = private_key_s × G
   Sends: public_key_s, server_random

Step 4: ECDH Shared Secret Computation (both sides independently)
   Client computes: shared_secret = private_key_c × public_key_s
   Server computes: shared_secret = private_key_s × public_key_c
   Result is IDENTICAL (ECDH property: a×(b×G) = b×(a×G))
   Network only saw: public_key_c and public_key_s
   Nobody watching can compute shared_secret without either private key

Step 5: Key Derivation (HKDF)
   Both sides run identical HKDF operations:
   early_secret = HKDF-Extract(0, PSK or zeros)
   handshake_secret = HKDF-Extract(derived_secret, ECDH_shared_secret)
   Derive: client_hs_key, server_hs_key (for encrypting handshake messages)

Step 6: Server sends encrypted Certificate
   Server encrypts its leaf certificate + intermediate CA cert using server_hs_key
   Certificate contains: domain SAN, public key, issuer, validity, signature

Step 7: Server sends CertificateVerify
   Server computes: signature = Sign(private_key, Hash("TLS 1.3, server" + all_handshake_msgs))
   This proves the server possesses the private key matching the certificate's public key

Step 8: Server sends Finished
   Server computes: verify_data = HMAC(server_finished_key, Hash(all_handshake_msgs))
   This proves server is the same party that derived the same keys

Step 9: Client Validates Certificate
   ① Signature on leaf cert: verified using intermediate CA public key ✓
   ② Signature on intermediate cert: verified using root CA public key ✓
   ③ Root CA is in browser trust store ✓
   ④ Leaf cert not expired (check notBefore, notAfter) ✓
   ⑤ Leaf cert SAN contains "shop.com" ✓
   ⑥ CertificateVerify signature valid with leaf cert public key ✓
   ⑦ Finished HMAC valid ✓
   If any check fails: TLS alert sent, connection terminated

Step 10: Client sends Finished
   Client HMAC of all handshake messages → sends encrypted with client_hs_key
   Server verifies client Finished HMAC ✓

Step 11: Application Keys Derived
   master_secret = HKDF-Extract(derived_from_hs_secret, zeros)
   client_app_traffic_secret → AES-256-GCM key for client's HTTP data
   server_app_traffic_secret → AES-256-GCM key for server's HTTP data

Step 12: Application Data Begins
   Browser sends: {GET /products HTTP/2} encrypted with client_app_key
   Server sends: {HTTP/2 200 OK ...} encrypted with server_app_key
   Both keys are completely separate from handshake keys
   Ephemeral ECDH keys are now discarded (forward secrecy achieved)
```

---

### Flow 2: Session Resumption with TLS Session Ticket

```
Initial connection (full handshake, described above):
  At end: server issues Session Ticket
  Session Ticket = Encrypt(ticket_key, {session_secret, timestamp, metadata})
  Client stores session ticket in memory (not to disk by default)

Subsequent connection (same or different TCP connection):
  Client reconnects (TCP SYN → SYN-ACK → ACK)

  ClientHello includes:
    • pre_shared_key extension with session ticket
    • early_data indication (if sending 0-RTT data)

  Server decrypts session ticket → recovers previous session_secret
  Server responds with ServerHello including:
    • pre_shared_key extension (confirms PSK was accepted)

  Session resumes WITHOUT full ECDH key exchange
  (TLS 1.3 still uses PSK + optional ECDH for "forward-secure session resumption")

  If 0-RTT enabled:
    Client sends {Application Data} WITHIN the ClientHello packet
    Server sees it before completing handshake verification
    Note: 0-RTT data has no replay protection

  Total overhead: 0 additional RTT (vs full handshake's 1 RTT)
```

---

### Flow 3: Certificate Pinning (Mobile App Scenario)

```
Standard TLS: trust any cert signed by any trusted CA
Certificate Pinning: trust ONLY this specific cert or public key hash

Implementation in mobile app:
  At build time: developer pins the server's public key hash (SHA-256)
    expected_spki_hash = "sha256/AAAAAABB...="  ← from server's current cert

  At runtime:
    TLS handshake completes normally (cert validated against CA)
    THEN app runs extra check:
      received_cert = extracted from TLS handshake
      received_spki_hash = SHA256(received_cert.subjectPublicKeyInfo)
      if received_spki_hash != expected_spki_hash:
          abort_connection()  ← prevents MITM even with legitimate CA-issued cert

  Why this matters:
    Scenario: Attacker compromises or coerces a CA to issue fake cert for your domain
    Normal TLS: accepts the fake cert (it's CA-signed) → MITM possible
    Pinning: rejects it (hash doesn't match expected) → MITM blocked

  Risk:
    If your server cert is rotated WITHOUT updating the pin in the app:
    → App breaks for all users until app update is published
    → Force an app update (Play Store: 1-7 days; App Store: 24-48 hours)

  Best practice: pin the INTERMEDIATE CA public key (not leaf cert)
    → survives leaf cert rotation as long as same CA is used
    → still blocks rogue CAs
```

---

## File Summary

This file covered:

- Spy meeting + VIP club analogies (cipher negotiation, identity, key exchange, confirmation)
- TLS position in the protocol stack: between TCP and application layer
- TLS 1.2 handshake: 2-RTT, RSA or ECDHE key exchange, ChangeCipherSpec, Finished messages
- TLS 1.3 handshake: 1-RTT, ECDH key_share in ClientHello, encrypted cert, no ChangeCipherSpec
- Cipher suite anatomy: ECDHE (PFS) + RSA (auth) + AES-256-GCM (encryption) + SHA256 (MAC)
- Key schedule: four derived keys, separate per-direction application keys
- Session resumption: session tickets, 0-RTT tradeoffs and replay attack risk
- ASCII diagram: full TLS 1.3 timing with milliseconds
- TLS record structure: header, AEAD-encrypted payload, 16-byte authentication tag
- Step-by-step: full TLS 1.3 handshake with certificate chain validation
- Flow: session resumption with PSK and 0-RTT
- Flow: certificate pinning in mobile apps (pin SPKI hash, not leaf cert hash)

**Continue to File 02** for real-world examples, system design importance, AWS mapping, and 8 interview Q&As.
