# Domain Setup

## FILE 02 OF 03 — DNS Failures, Propagation Debugging & Production Incidents

> **Architect Training Mode** | Senior Principal Architect Perspective
> _Optimized for: design judgement · tradeoff evaluation · failure prediction · production debugging_

---

## SECTION 5 — Real World Example

### The Incident: Domain Not Resolving After Route 53 Setup

```
Scenario: Developer buys myapp.com from GoDaddy, moves DNS management to Route 53

Steps taken:
  1. Created Route 53 hosted zone for myapp.com
  2. Route 53 assigned nameservers:
       ns-1234.awsdns-12.org
       ns-5678.awsdns-34.net
       ns-9012.awsdns-56.com
       ns-3456.awsdns-78.co.uk
  3. Added A record: myapp.com → 52.14.35.67
  4. Waited...
  5. myapp.com still doesn't resolve. Returns SERVFAIL.

Root cause:
  Developer FORGOT to update NS records at GoDaddy
  GoDaddy still has original nameservers:
    ns1.domaincontrol.com   ← GoDaddy's nameservers
    ns2.domaincontrol.com

  When anyone queries myapp.com:
    1. Root servers ask: "what nameservers for .com registry knows about myapp.com?"
    2. .com registry answers: "try ns1.domaincontrol.com, ns2.domaincontrol.com"  (GoDaddy)
    3. Query goes to GoDaddy nameservers
    4. GoDaddy has no records for myapp.com (you deleted them when you moved to Route 53)
    5. SERVFAIL (no answer)

  Route 53 is never queried because the chain of delegation never reaches it.

Fix:
  Log into GoDaddy → Domain settings → Nameservers → Custom nameservers
  Enter all 4 Route 53 nameservers
  Save → wait for TTL of old NS record to expire (typically 48 hours for NS records)

  After fix:
    .com registry delegates to Route 53 nameservers
    Route 53 answers with your A record
    myapp.com resolves correctly

Verification command:
  # Check what .com registry thinks the nameservers are:
  dig NS myapp.com @a.gtld-servers.net
  # Should return your Route 53 nameservers

  # Check if Route 53 has the record:
  dig A myapp.com @ns-1234.awsdns-12.org
  # Should return your IP address
```

---

## SECTION 6 — System Design Importance

### Commands You Need for DNS Troubleshooting

```bash
# Basic lookup — queries your configured DNS resolver (ISP, Google, etc.)
nslookup myapp.com
dig myapp.com

# Query a SPECIFIC nameserver (bypass local cache):
dig myapp.com @8.8.8.8          # Google's public resolver
dig myapp.com @1.1.1.1          # Cloudflare's public resolver
dig myapp.com @ns-1234.awsdns-12.org   # Query Route 53 directly

# Check TTL of cached response:
dig myapp.com | grep -A1 "ANSWER SECTION"
# Shows: myapp.com. 247 IN A 52.14.35.67
#                   ^^^  TTL remaining (247 seconds until expiry)

# Full delegation trace (shows each step from root → TLD → authoritative):
dig +trace myapp.com
# Output shows:
#   Root servers → .com TLD → your nameservers → final answer
#   Look for: where does the chain break? (mismatched NS = breaks here)

# Check NS records at each level:
dig NS myapp.com                           # your hosted zone NS records
dig NS myapp.com @a.gtld-servers.net       # what .com registry has
# These two MUST match. If they don't: registrar NS not updated.

# Check all record types for a domain:
dig ANY myapp.com @ns-1234.awsdns-12.org

# Check MX records:
dig MX myapp.com

# Check TXT records (SPF, DKIM, domain verification):
dig TXT myapp.com

# REVERSE DNS lookup (IP → hostname):
dig -x 52.14.35.67

# Check if negative caching is in effect (NXDOMAIN cached):
dig +stats myapp.com | grep "Query time"
# If query time = 0ms and it's wrong: negative cache hit — wait for TTL
```

---

## SECTION 7 — AWS & Cloud Mapping

```
Negative caching = caching of "this domain does not exist" responses

Scenario:
  You try myapp.com BEFORE you've set up the A record
  DNS resolver asks Route 53 → Route 53 says: NXDOMAIN (does not exist)
  DNS resolver caches NXDOMAIN for... the SOA minimum TTL (often 300-900s)

  You then ADD the A record to Route 53
  DNS resolver still serves NXDOMAIN (from cache!)
  You can't understand why your record isn't working — you see it in Route 53 console

  Wait: SOA minimum TTL expires → resolver re-queries → gets correct A record

How to avoid:
  Create DNS records BEFORE announcing the domain publicly
  Or: use low SOA minimum TTL (Route 53 default SOA TTL = 900s = 15 minutes)

How negative caching is tracked in SOA:
  dig SOA myapp.com
  # Returns: myapp.com SOA ns-1234.awsdns-12.org. awsdns-hostmaster.amazon.com.
  #           serial   refresh  retry   expire   minimum_ttl
  #           1       7200     900     1209600   86400
  #                                             ^^^^^^^^^ negative cache TTL

  Route 53 default: 86400 seconds (24 hours!) negative caching
  If you queried NXDOMAIN before creating the record: clients may cache NXDOMAIN for 24h

  Workaround: change SOA minimum TTL to lower value before creating records
  Or: test in a new browser profile (no local DNS cache)
```

---

## SECTION 8 — Interview Preparation

**Beginner:**

**Q: What is DNS and what does it do?**
**A:** DNS (Domain Name System) is the internet's phone book. When you type google.com, your computer asks a DNS server: "What is the IP address for google.com?" The DNS server responds: "142.250.80.46." Your computer then connects to that IP address. Without DNS, you'd have to memorize IP addresses for every website. DNS translates human-readable names into computer-readable addresses.

**Q: What is a DNS record and what are the most important types?**
**A:** A DNS record maps a domain name to something. Key types: *A record* â€” maps a domain to an IPv4 address (example.com â†’ 1.2.3.4). *CNAME record* â€” maps a domain to another domain name (www.example.com â†’ example.com). *MX record* â€” maps a domain to an email server. *TXT record* â€” stores text, used for domain verification and SPF/DKIM email authentication. Most websites need: one A record (or ALIAS) pointing to their server/load balancer, and a CNAME for www.

**Q: What is DNS propagation and why does it take time?**
**A:** When you change a DNS record, the change must spread to DNS servers worldwide. These servers cache DNS records for the TTL duration (often 5 minutes to 48 hours) to reduce load. During propagation, some users see old DNS and some see new DNS. To minimize propagation time: lower your DNS TTL to 60 seconds **before** making the change, then change, then raise TTL back after confirming it works. Never change DNS records and try to troubleshoot immediately â€” wait a few minutes first.

---

**Intermediate:**

**Q: What is the difference between Route 53's A/ALIAS record and a CNAME? When should you use each?**
**A:** *A record:* maps directly to an IPv4 address. Required for apex/root domain (example.com â€” no subdomain). *CNAME:* maps to another domain name. Cannot be used for apex domain (DNS spec restriction). *ALIAS:* AWS-specific â€” looks like an A record but internally points to an AWS resource (ALB, CloudFront, S3) and resolves to the current IP. Use ALIAS for apex domains pointing to AWS resources (alb endpoint changes IPs â€” ALIAS handles this automatically). Use CNAME for subdomains pointing to non-AWS hostnames (external services, CDNs).

**Q: What are NS records and why are they critical to get right when setting up a domain?**
**A:** NS (Name Server) records tell the internet which DNS servers are authoritative for your domain. When GoDaddy registers your domain example.com, it sets GoDaddy's name servers by default. If you want to use Route 53 for DNS records, you must: (1) Create a Route 53 hosted zone (Route 53 gives you 4 NS addresses). (2) Update the NS records at your registrar (GoDaddy) to point to the 4 Route 53 name servers. Common mistake: creating Route 53 records but forgetting to update the registrar's NS records â€” your Route 53 records are never used.

**Q: What is TTL and what value should you set for different DNS record types in production?**
**A:** TTL controls how long DNS resolvers worldwide cache your record. Low TTL (60-300s) = fast failover but more DNS queries (performance cost). High TTL (3600-86400s) = fewer queries but slow propagation after changes. Best practices: *A records for production:* 300s (5 min) â€” allows reasonably fast failover to a new IP. *During planned migration:* drop to 60s 24 hours before the change. *After migration confirmed:* restore to 300-3600s. *MX records:* 3600s (email servers are rarely changed). *TXT records (SPF/DKIM):* 3600s. *Internal/development:* 60s OK (changes are frequent).

---

**Advanced (System Design):**

**Scenario 1:** Your website example.com is hosted in us-east-1. You want to implement geo-based DNS routing so that users in India get routed to a server in ap-south-1 for lower latency, while all other users continue going to us-east-1. Both regions must share the same database. Design the DNS and infrastructure setup.

*Route 53 Geolocation Routing:* Create two record sets for pi.example.com: (1) Geolocation record for IN (India) â†’ ALB in ap-south-1. (2) Default routing record â†’ ALB in us-east-1. Route 53 returns the India record for Indian IP addresses.
*Database:* For read-heavy workloads: primary in us-east-1 + read replica in ap-south-1. Reads served from local region replica. Writes always go to us-east-1 primary (cross-region latency ~180ms acceptable for writes). For write-heavy: consider DynamoDB Global Tables for multi-region active-active.
*Health check integration:* Route 53 health checks on both ALBs. If ap-south-1 ALB fails health check â†’ Indian users automatically fall back to us-east-1.

**Scenario 2:** Your DNS TTL was set to 86400 (24 hours). Your API server IP changed due to an infrastructure migration. Users are complaining they can't reach the API. Some users are affected, some are not. Walk through how DNS TTL causes this, how long it lasts, and how to prevent it in future.

*Explanation:* Users whose local resolver cached the OLD IP before the change will continue hitting the old IP for up to 24 hours. Users whose cache expired naturally now get the new IP and connect successfully â€” hence partial outage.
*Duration:* Up to 24 hours from when you changed the DNS record (not from when you started receiving errors).
*Immediate fix:* If old server is still running: set up forwarding from old IP â†’ new IP (reverse proxy redirect). Reduces user impact while cache expires.
*Prevention:* Always lower TTL to 60s â‰¥ 24 hours before any planned IP change. After confirming new IP works: raise TTL back to 300s. Document this as a required step in your infrastructure change runbook.

