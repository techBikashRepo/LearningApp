# DNS Resolution Flow (Step by Step) — Part 3 of 3

### Topic: AWS SAA Certification Traps, Comparison Tables, and Interview-Ready Revision

**Series:** Networking Fundamentals → System Design → AWS Solutions Architect
**Sections Covered:** 9, 10, 11, 12

---

## SECTION 9 — AWS SAA Certification Focus

### Core Service Mapping

| DNS Concept               | AWS Service                      | Key Detail                                     |
| ------------------------- | -------------------------------- | ---------------------------------------------- |
| Recursive Resolver        | Route 53 Resolver (VPC+2)        | Handles all DNS for VPC resources              |
| Authoritative NS          | Route 53 Hosted Zones            | Public or Private Hosted Zones                 |
| Split-horizon DNS         | PHZ + Public HZ (same domain)    | PHZ answer takes priority inside VPC           |
| Hybrid DNS forwarding     | Route 53 Resolver Endpoints      | Inbound (on-prem→AWS) / Outbound (AWS→on-prem) |
| DNS query logging         | Route 53 Resolver Query Logging  | CloudWatch Logs or S3 destination              |
| Malicious domain blocking | Route 53 Resolver DNS Firewall   | Supports AWS-managed threat intelligence lists |
| DoH / DoT                 | Not directly offered by Route 53 | Use Cloudflare or custom resolver in EC2       |
| DNSSEC                    | Route 53 supports DNSSEC signing | Must enable per-hosted zone; not automatic     |

---

### Critical Exam Traps

**Trap 1 — Resolver Endpoint ENIs Must Be in Different AZs**

When creating Route 53 Resolver Inbound or Outbound Endpoints, you must specify at least 2 IP addresses in **different Availability Zones**. The exam tests whether you know this is a requirement (not optional) for high availability.

If a question says "a Route 53 Resolver Inbound Endpoint was configured with one IP address" → this is a design flaw, not a valid configuration.

**Trap 2 — PHZ Must Be Associated with the VPC**

Creating a Private Hosted Zone does NOT automatically apply to a VPC. You must explicitly **associate** the PHZ with one or more VPCs. The exam presents scenarios where "an EC2 instance can't resolve an internal hostname" — and the root cause is a PHZ not associated with the EC2's VPC.

Multi-account gotcha: associating a PHZ in Account A with a VPC in Account B requires a CLI command — it cannot be done through the console. This is a common multi-account architecture exam question.

**Trap 3 — Outbound Endpoint is For AWS→On-Prem (Not Vice Versa)**

This is confusingly named. The direction is from the perspective of the **resolver itself**:

- **Inbound** = queries come **into** Route 53 Resolver (from on-premises toward AWS)
- **Outbound** = queries go **out of** Route 53 Resolver (from AWS toward on-premises)

Exam question format: "On-premises hosts need to resolve AWS Private Hosted Zone records" → answer is **Inbound Endpoint** (queries flow from on-prem into Route 53 Resolver).

**Trap 4 — Route 53 Resolver DNS Firewall Is NOT a WAF**

DNS Firewall blocks at the DNS query level — it can prevent a domain name from resolving. It does NOT inspect HTTP payloads, block specific URLs, or do deep packet inspection. For HTTP-level protection, use AWS WAF. DNS Firewall is for blocking malicious domain resolution (C2 servers, phishing domains, data exfiltration domains).

**Trap 5 — DNSSEC Signing Does Not Encrypt Queries**

DNSSEC adds cryptographic signatures to DNS records to verify authenticity. It does NOT encrypt queries or responses — DNS traffic is still visible on the wire. For encrypted DNS queries, use DoH or DoT. Route 53 supports DNSSEC for hosted zones (signing) and Route 53 Resolver supports DNSSEC validation.

---

### Route 53 Resolver Pricing (Exam-Relevant)

| Feature                             | Pricing                                                |
| ----------------------------------- | ------------------------------------------------------ |
| VPC DNS Resolver (VPC+2)            | Free — included with VPC                               |
| Route 53 Resolver Inbound Endpoint  | $0.125/hour per ENI IP address                         |
| Route 53 Resolver Outbound Endpoint | $0.125/hour per ENI IP address                         |
| Outbound forwarding queries         | $0.40 per million queries                              |
| DNS Firewall rule group             | $0.60/month per rule group + $0.60/M queries evaluated |
| Query Logging                       | CloudWatch/S3 costs apply                              |

Key: the Resolver itself (VPC+2) is free. ENI-based endpoints for hybrid DNS have hourly costs.

---

## SECTION 10 — Comparison Tables

### Table 1 — Recursive vs Iterative DNS Resolution

| Attribute          | Recursive Resolution                   | Iterative Resolution                       |
| ------------------ | -------------------------------------- | ------------------------------------------ |
| Who does the work  | The DNS server follows all referrals   | The querying client follows each referral  |
| Client effort      | One query, one final answer            | Multiple queries, multiple responses       |
| Used by            | Your application → recursive resolver  | Recursive resolver → root/TLD/auth NS      |
| Response types     | Final answer only                      | Final answer OR referral to another NS     |
| Burden on server   | High (resolves entirely for client)    | Low (just provides referral, no follow-up) |
| Caching benefit    | Server caches all intermediate results | Client must cache if desired               |
| AWS implementation | EC2 → VPC Resolver = recursive         | VPC Resolver → root/TLD/auth = iterative   |

---

### Table 2 — DNS over UDP vs TCP

| Attribute           | DNS over UDP (port 53)               | DNS over TCP (port 53)             |
| ------------------- | ------------------------------------ | ---------------------------------- |
| Default usage       | Standard queries and responses       | Large responses, zone transfers    |
| Connection overhead | None (connectionless)                | 3-way handshake required           |
| Response size limit | 512 bytes (EDNS0 extends to 4096+)   | Unlimited                          |
| Speed               | Faster (lower overhead)              | ~2× slower per query (handshake)   |
| Use cases           | Regular A/AAAA queries, MX lookups   | DNSSEC responses, AXFR transfers   |
| Truncated response  | TC bit set → client retries with TCP | N/A                                |
| Security concern    | Source IP spoofing → amplification   | SYN flood; higher resource cost    |
| EDNS0               | Extends UDP payload beyond 512 bytes | Not needed (TCP is size-unlimited) |

---

### Table 3 — DNS Caching Layers Comparison

| Cache Layer                | Location        | Controlled By             | Flush Method                      | TTL Override               |
| -------------------------- | --------------- | ------------------------- | --------------------------------- | -------------------------- |
| Browser (Chrome)           | Client browser  | Browser (caps at 60s)     | chrome://net-internals/#dns       | No; capped at 60s          |
| OS resolver                | Client OS       | OS + nameserver TTL       | ipconfig /flushdns (Win)          | Some OS impose minimums    |
| App DNS cache (JVM)        | Application     | JVM security config       | Restart or tune TTL property      | `networkaddress.cache.ttl` |
| Route 53 Resolver          | VPC DNS         | AWS                       | Cannot flush externally           | Honors record TTL          |
| ISP / third-party resolver | ISP or 8.8.8.8  | ISP / Google / Cloudflare | Cannot flush externally           | Some impose minimums       |
| Authoritative NS           | Zone file owner | You (domain owner)        | Modify TTL, wait for field expiry | Full control               |

---

### Table 4 — Positive vs Negative Caching

| Attribute             | Positive Caching                  | Negative Caching                             |
| --------------------- | --------------------------------- | -------------------------------------------- |
| What is cached        | Successfully resolved record + IP | Non-existence of a record (NXDOMAIN)         |
| DNS response code     | NOERROR                           | NXDOMAIN or NODATA                           |
| Cache duration        | Record's TTL field                | SOA record's minimum TTL field               |
| Typical TTL           | 60–3600 seconds                   | 300–900 seconds (SOA minimum)                |
| Impact on ops         | Stale IPs if TTL too long         | NXDOMAIN served even after record created    |
| Prevention strategy   | Lower TTL before migrations       | Create DNS records BEFORE deploying services |
| Can you force-expire? | No (for remote resolvers)         | No (for remote resolvers)                    |
| Your lever            | Set short TTL → tolerates change  | "DNS first, service second" deployment order |

---

### Table 5 — DNS Firewall vs WAF vs Security Groups vs NACLs

| Control Plane         | Layer             | What It Blocks                        | Use Case                                 |
| --------------------- | ----------------- | ------------------------------------- | ---------------------------------------- |
| Route 53 DNS Firewall | Layer 7 (DNS)     | Domain name resolution                | Block C2 servers, phishing, exfiltration |
| AWS WAF               | Layer 7 (HTTP)    | HTTP requests, headers, bodies, paths | SQL injection, XSS, rate limits          |
| Security Groups       | Layer 4 (TCP/UDP) | IP addresses and port numbers         | EC2 inbound/outbound traffic rules       |
| NACLs                 | Layer 3/4 (IP)    | IP ranges and ports (subnet level)    | Subnet-wide deny rules                   |
| Shield Standard       | Layer 3/4         | Volumetric UDP/SYN floods             | DDoS protection (automatic, free)        |
| Shield Advanced       | Layer 3–7         | DDoS with response team               | Mission-critical applications            |

---

## SECTION 11 — Quick Revision & Memory Tricks

### 10 Key Points to Remember

1. **Recursive = your resolver does all the work** — one query from client, one final answer back. Your app never talks to root, TLD, or authoritative servers directly.

2. **Iterative = "here's who to ask next"** — resolvers make iterative queries to root→TLD→auth, following referrals until the authoritative answer is found.

3. **DNS uses UDP port 53** by default. TCP only for large responses (>512 bytes), zone transfers (AXFR), and when TC (truncated) bit is set.

4. **Glue records prevent infinite delegation loops** — when NS hostname lives in the same domain it serves, the TLD includes NS IP in the Additional section of its response.

5. **Negative caching (NXDOMAIN) is cached too** — SOA minimum TTL controls how long. "DNS first, service second" prevents NXDOMAIN being cached before your record exists.

6. **EDNS0 extends UDP payloads** past 512 bytes — most modern DNSSEC responses need this. Supported by all major resolvers and Route 53.

7. **Route 53 VPC Resolver (VPC+2) is free** — it resolves both PHZ and public DNS for all VPC resources.

8. **Inbound Endpoint = on-prem→AWS queries | Outbound Endpoint = AWS→on-prem queries** — direction named from Route 53 Resolver's perspective.

9. **DNSSEC ≠ encryption** — DNSSEC signs records to verify authenticity. Queries are still plaintext. Use DoH/DoT for query encryption.

10. **DNS cache control sequence:** You CANNOT flush remote resolvers. Your only levers are: (a) set short TTL before changes, (b) create records before deploying services, (c) flush YOUR OWN OS/browser cache.

---

### 30-Second Explanation (Memorize This)

"When your app calls a hostname, the OS asks the configured recursive resolver — in AWS, that's always the VPC's DNS server at the base IP plus two. If the resolver has a cached answer with TTL still valid, it returns immediately in under a millisecond. If not, it makes iterative queries: first to the root name servers which say 'try the TLD server,' then to the TLD server which says 'try this domain's authoritative NS,' then to the authoritative NS which gives the final IP. Every response is cached with the TTL from the record. The whole cold chain takes 50–150 milliseconds. Negative responses — NXDOMAIN — are also cached for the SOA minimum TTL, which is why you should always create DNS records before deploying the services that use them."

---

### Memory Mnemonics

**RIA = Resolver → Iterative queries → Answers recursively to client**

- R = Recursive from client's perspective (client sends one query, gets one answer)
- I = Iterative internal process (resolver queries root→TLD→auth with referrals)
- A = Authoritative NS is the only source of truth

**GRTA = Glue Records Two Answers**
The glue record problem: when NS hostname lives inside its own zone, the TLD gives you Two Answers in one response (NS name + NS IP). Without this, you get a loop.

**NFS = Negative First, Service Second**
"N for Negative caching, F for First create DNS, S for Service deployment."
→ NXDOMAIN caches = bad. Solution: DNS record First, Service Second.

**INOUO = Inbound iN, Outbound OUt**

- Inbound Endpoint: traffic comes **IN** to Route 53 Resolver (from on-prem)
- Outbound Endpoint: traffic goes **OUT** of Route 53 Resolver (to on-prem)

**Quick-Fire Exam Facts:**

- PHZ not resolving → check if PHZ is **associated** with the VPC
- Multi-account PHZ association → must use AWS CLI (no console support)
- DNS Firewall blocks suspicious **domain names**, not IP addresses or HTTP paths
- DNSSEC → authenticity (not privacy)
- DoH/DoT → privacy (not authenticity on its own)
- Minimum Resolver Endpoint AZ count → **2** (required for HA)

---

## SECTION 12 — Architect Thinking Exercise

### The Problem (Read carefully — take 5 minutes to think before viewing the solution)

**Scenario:**
You are the lead architect at a financial services company. Your security team has flagged an anomaly in CloudTrail and VPC Flow Logs:

From EC2 instance `i-0abc123` (production payments service, 10.0.3.15):

- Normal outbound TCP traffic: only ports 443 (HTTPS) to known payment processor IPs
- Anomaly: hundreds of DNS queries per hour to `*.xyz.io` subdomains with long, base64-style subdomain strings like: `dGhpcyBpcyBzdG9sZW4=.telemetry.xyz.io`, `c3VwZXJzZWNyZXQ=.telemetry.xyz.io`
- No TCP connections to those IPs — just DNS queries
- VPC Flow Logs show no unusual data leaving port 443

**What is happening? How do you isolate it, confirm it, and fix it permanently with AWS architecture?**

_(Think through your diagnosis before scrolling)_

---

↓

↓

↓

↓

↓ (Answer below)

↓

---

### Solution — DNS Exfiltration Detection and Permanent Mitigation

**What is happening: DNS exfiltration**

The attacker (malware running on the EC2 instance) is encoding sensitive data (credentials, database records, PII) into DNS subdomain prefixes and sending DNS queries. The data never leaves over port 443 — it leaves as DNS queries to `*.xyz.io`.

Why it works:

- DNS queries are rarely blocked by firewalls (UDP port 53 is open almost everywhere)
- The attacker controls `xyz.io`'s authoritative name server — every DNS query you make is **received by the attacker** as a DNS query log entry
- Data travels across the internet disguised as DNS lookups — your VPC Flow Logs show UDP port 53 traffic to the VPC Resolver, not to the external destination

```
Malware on EC2 (10.0.3.15):
  data_chunk = base64("credit_card_number_1234567890")
  → "Y3JlZGl0X2NhcmQ=.c2.xyz.io"

  Sends DNS query: Y3JlZGl0X2NhcmQ=.c2.xyz.io A?
    → VPC Resolver (10.0.0.2) receives query
    → Resolver queries root → TLD → xyz.io auth NS (ATTACKER'S SERVER)
    → Attacker's server logs the query subdomain = DECODES THE DATA
    → Returns NXDOMAIN (doesn't matter — data already received)
```

**Immediate Isolation Steps:**

```
Step 1: Isolate the EC2 instance
  → Move i-0abc123 to a quarantine security group
  → Quarantine SG: deny ALL outbound EXCEPT port 443 to specific IPs
  → Do NOT terminate — preserve forensic evidence

Step 2: Capture evidence
  → Enable Route 53 Resolver Query Logging (if not already enabled)
  → Export existing VPC Flow Logs to S3 for forensics
  → Run `strings` and memory dump on EC2 if forensically needed

Step 3: Identify the exfiltrated data
  → Decode base64 subdomain prefixes from DNS query logs
  → Assess data sensitivity → trigger incident response / GDPR/PCI breach notification if required
```

**Permanent AWS Architectural Fix:**

```
Layer 1 — DNS Firewall (blocks exfiltration at DNS level)
  Create Route 53 Resolver DNS Firewall rule group:
  → BLOCK all queries to *.xyz.io (or use AWS-managed malware domains list)
  → BLOCK queries matching pattern: [long-string].*.io / *.tk / *.top (high-entropy subdomains)
  → Action: BLOCK → return NXDOMAIN

  Associate rule group with all production VPCs

Layer 2 — Allow-list DNS posture (strongest defense)
  Instead of deny-listing, ONLY allow DNS resolution to:
  → *.amazonaws.com (AWS services)
  → *.your-company.com (internal services)
  → Approved 3rd party SaaS domains (Stripe, Twilio, etc.)
  → Block all other DNS queries (default BLOCK action)

  Trade-off: high maintenance but eliminates exfiltration vector

Layer 3 — Query logging + automated detection
  → Route 53 Resolver Query Logs → CloudWatch Logs
  → CloudWatch Metric Filter: count queries with subdomain entropy > threshold
  → CloudWatch Alarm → SNS → Lambda → isolate EC2 automatically

  Entropy detection pseudo-code:
  if len(subdomain_prefix) > 32 AND base64_valid(subdomain_prefix):
    → alert as potential exfiltration

Layer 4 — Restrict resolver access to known infrastructure
  → EC2 security groups: only allow outbound UDP/TCP 53 to VPC Resolver (10.x.x.2)
  → Prevents malware from bypassing VPC Resolver to query 8.8.8.8 directly
  → Then Route 53 DNS Firewall controls all resolution
```

**Architect checklist for all new environments:**

- [ ] Route 53 Resolver Query Logging enabled → CloudWatch Logs
- [ ] DNS Firewall rule group with AWS managed lists attached to all VPCs
- [ ] IMDSv2 enforced (prevents another exfiltration vector via metadata endpoint)
- [ ] VPC Flow Logs enabled → S3 with long retention for forensics
- [ ] Security Hub + GuardDuty enabled (GuardDuty has a DNS finding type: `Trojan:EC2/DNSDataExfiltration`)

---

## Complete Series Summary — Topic 09

| File    | Sections | Core Content                                                                                                                                                  |
| ------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File 01 | 1–4      | Recursive/iterative mechanics, cache hierarchy, 11-step UDP trace, negative caching, glue records, ASCII diagram                                              |
| File 02 | 5–8      | Chrome DNS prefetch, DNS as SPOF, DNS amplification DDoS, Route 53 Resolver + DNS Firewall + hybrid endpoints, 8 interview Q&As                               |
| File 03 | 9–12     | AWS SAA exam traps (PHZ association, endpoint direction, DNSSEC≠encryption), 5 comparison tables, RIA/GRTA/NFS mnemonics, DNS exfiltration architect exercise |

**Next Topic →** Topic 10: Domain Name vs IP Address — Why human-readable names exist, URL anatomy deep dive, FQDN structure, Internationalized Domain Names, public suffix list, and why IP addresses alone can never replace domain names in modern systems.
