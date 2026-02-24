# Public IP vs Private IP — Part 3 of 3

### Topic: AWS Certification Focus, Comparison Tables, Quick Revision & Architect Exercise

**Series:** Networking Fundamentals → System Design → AWS Solutions Architect
**Audience:** 14-Year Experienced Full-Stack Developer → Becoming an Architect
**Sections Covered:** 9, 10, 11, 12

---

## SECTION 9 — Certification Focus: AWS Solutions Architect Associate (SAA-C03)

### Exam-Critical Fact 1 — EC2 IP Address Types

The exam tests the exact behavior of each IP type:

| IP Type          | Survives Stop/Start | Charged When Unused | Who Assigns            | Use Case                  |
| ---------------- | ------------------- | ------------------- | ---------------------- | ------------------------- |
| Private IP       | Yes                 | No                  | AWS (from subnet CIDR) | Internal communication    |
| Public IP (auto) | No — changes        | No                  | AWS (from public pool) | Temporary internet access |
| Elastic IP (EIP) | Yes                 | Yes ($0.005/hr)     | You allocate           | Stable internet endpoint  |

**Key trap:** If you stop an instance that has a regular (non-EIP) public IP and restart it, the public IP changes. This will break DNS records pointing to the old IP. Always use Elastic IPs or DNS names (not raw IPs) for production services.

**Another trap:** An EIP associated with a running instance = free. An EIP sitting unattached OR attached to a stopped instance = charged per hour. AWS charges this to discourage holding public IPs without using them.

---

### Exam-Critical Fact 2 — VPC CIDR and Subnet Reserved Address Rules

The exam frequently includes subnet questions. Always remember:

**AWS reserves 5 addresses per subnet — not 2:**
For subnet 10.0.1.0/24 (256 total):

- 10.0.1.0 — Network address (not usable)
- 10.0.1.1 — VPC router
- 10.0.1.2 — AWS DNS
- 10.0.1.3 — AWS reserved for future use
- 10.0.1.255 — Broadcast address

Usable: 256 - 5 = **251 addresses**

**Exam question format:** "You need 29 EC2 instances in a subnet. Which is the smallest subnet that can accommodate this?" Answer: /27 gives 32 addresses, minus 5 reserved = 27 usable. That's not enough. /26 gives 64 addresses, minus 5 = 59 usable. That works. Answer: **/26**

---

### Exam-Critical Fact 3 — EC2 Instance Metadata Service (IMDSv1 vs IMDSv2)

**IMDSv1 (legacy):** Simple GET request to 169.254.169.254. No authentication. Vulnerable to SSRF attacks.

**IMDSv2 (recommended):** Requires a session token obtained via a PUT request first. SSRF attacks typically cannot perform the PUT request, blocking credential theft.

```bash
# IMDSv2 workflow
TOKEN=$(curl -X PUT "http://169.254.169.254/latest/api/token" \
  -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")

curl -H "X-aws-ec2-metadata-token: $TOKEN" \
  http://169.254.169.254/latest/meta-data/instance-id
```

**Exam point:** AWS recommends all new instances use IMDSv2. You can enforce IMDSv2 by setting `HttpTokens: required` in the instance metadata options. This can also be enforced via Service Control Policies (SCPs) at the organization level.

---

### Exam-Critical Fact 4 — NAT Gateway vs NAT Instance

**NAT Gateway (AWS Managed):**

- Highly available within an AZ (deploy one per AZ for full HA)
- Scales automatically up to 45 Gbps
- No security groups (controlled only by route tables)
- Not included in Free Tier — costs per hour + per GB
- You cannot use it as bastion host

**NAT Instance (self-managed EC2):**

- You manage patching, security, availability
- Must disable "source/destination check" on the EC2 instance — by default, EC2 drops packets where it's not the source or destination; NAT instances must forward others' packets
- Can be used as a bastion host (dual purpose)
- Cheaper at low traffic; more expensive to manage at scale
- Now generally deprecated for new architectures

**Exam trap:** "Cost-effective NAT for low-traffic development environments" → NAT Instance. "Production HA NAT" → NAT Gateway with one per AZ.

---

### Exam-Critical Fact 5 — VPC Flow Logs for IP Traffic Analysis

VPC Flow Logs capture IP traffic metadata (not packet contents) for:

- VPC
- Subnet
- Network Interface (ENI)

Each flow log record contains:

- Source IP and port
- Destination IP and port
- Protocol
- Bytes and packets
- Accept/Reject decision (based on Security Group / NACL)

**Exam use cases:**

- "Diagnose why traffic from a specific IP is being blocked" → Enable VPC Flow Logs, look for REJECT records
- "Audit which IPs are communicating with your RDS database" → Flow Logs on RDS network interface
- "Detect unusual outbound connections (potential data exfiltration)" → Flow Logs → CloudWatch / Athena analysis

Flow Logs are stored in **CloudWatch Logs** or **S3**. Analysis with Athena over S3 is more cost-efficient for large volumes.

---

### Exam-Critical Fact 6 — IPv6 in AWS

AWS supports dual-stack (IPv4 + IPv6):

- VPCs can be assigned a /56 IPv6 CIDR block (AWS-assigned from its pool)
- Subnets can be assigned a /64 IPv6 CIDR block
- IPv6 addresses are globally unique public addresses — NO NAT needed for IPv6
- Egress-Only Internet Gateway (for IPv6): allows IPv6 outbound internet, blocks IPv6 inbound (like NAT Gateway behavior but for IPv6)

**Exam trap:** IPv6 addresses in AWS are always public routable. If you have a private subnet and assign IPv6, the instances still get globally routable IPv6 addresses. To prevent inbound IPv6 from internet, use Egress-Only IGW + remove the IGW from the route table for IPv6 destinations.

---

## SECTION 10 — Comparison Tables

### Table 1 — Public IP vs Private IP vs Elastic IP (complete)

| Property            | Private IP             | Public IP (dynamic)    | Elastic IP (static public)  |
| ------------------- | ---------------------- | ---------------------- | --------------------------- |
| Globally unique     | No                     | Yes                    | Yes                         |
| Internet routable   | No (needs NAT)         | Yes                    | Yes                         |
| Persists stop/start | Yes                    | No                     | Yes                         |
| Charged standalone  | No                     | No                     | Yes (if unused)             |
| Assigned by         | AWS (from subnet CIDR) | AWS (random from pool) | You allocate                |
| Can be remapped     | No                     | No                     | Yes (to different instance) |
| Use for             | Internal traffic       | Temporary internet     | Production stable endpoint  |

---

### Table 2 — RFC 1918 Private Ranges Cheatsheet

| CIDR Block     | Range                         | Total Addresses | Common Use                             |
| -------------- | ----------------------------- | --------------- | -------------------------------------- |
| 10.0.0.0/8     | 10.0.0.0 – 10.255.255.255     | 16,777,216      | AWS VPCs, large enterprises            |
| 172.16.0.0/12  | 172.16.0.0 – 172.31.255.255   | 1,048,576       | Docker bridge, medium networks         |
| 192.168.0.0/16 | 192.168.0.0 – 192.168.255.255 | 65,536          | Home routers (192.168.1.x most common) |

---

### Table 3 — NAT Gateway vs NAT Instance vs VPC Endpoint

| Feature       | NAT Gateway                                   | NAT Instance             | VPC Endpoint                                    |
| ------------- | --------------------------------------------- | ------------------------ | ----------------------------------------------- |
| For accessing | Any internet destination                      | Any internet destination | Specific AWS services (S3, DynamoDB, etc.)      |
| Managed by    | AWS                                           | You                      | AWS                                             |
| HA            | Yes (per AZ)                                  | No (you must handle)     | Yes                                             |
| Cost          | Per hour + per GB                             | Instance cost            | Free (Gateway type) / Per hour (Interface type) |
| Traffic path  | Through public internet                       | Through public internet  | AWS private network only                        |
| Security      | Route tables                                  | Security groups          | IAM policies                                    |
| Best for      | General internet access for private resources | Legacy or low-cost dev   | Accessing AWS services privately                |

---

### Table 4 — Special IP Addresses Reference

| Address         | Name                        | Purpose                                                             |
| --------------- | --------------------------- | ------------------------------------------------------------------- |
| 127.0.0.1       | Loopback                    | Local machine self-reference (localhost)                            |
| 0.0.0.0         | Default route / unspecified | "All destinations" in routing (0.0.0.0/0); unbound in server listen |
| 255.255.255.255 | Limited broadcast           | Broadcast to all hosts in current network                           |
| 169.254.0.0/16  | Link-local / APIPA          | Auto-assigned when DHCP fails; AWS IMDS at 169.254.169.254          |
| 100.64.0.0/10   | Shared address space        | Carrier-Grade NAT (RFC 6598) — mobile carriers                      |
| 240.0.0.0/4     | Reserved                    | Reserved for future use by IETF                                     |

---

### Table 5 — IPv4 vs IPv6

| Property        | IPv4                         | IPv6                                                  |
| --------------- | ---------------------------- | ----------------------------------------------------- |
| Bit length      | 32 bits                      | 128 bits                                              |
| Total addresses | ~4.3 billion                 | 340 undecillion                                       |
| Notation        | Dotted decimal (192.168.1.1) | Hex colon (2001:db8::1)                               |
| NAT required    | Usually (address exhaustion) | No (every device can have unique public IP)           |
| Header size     | 20 bytes fixed               | 40 bytes fixed (simpler, no fragmentation in routers) |
| Broadcast       | Yes                          | No (replaced by multicast)                            |
| DHCP            | DHCPv4                       | DHCPv6 or SLAAC (auto-configuration)                  |
| AWS support     | Full                         | Dual-stack (IPv4 + IPv6)                              |

---

## SECTION 11 — Quick Revision

### 10 Key Points to Remember Always

1. **Private IP ranges (RFC 1918):** 10.x.x.x, 172.16-31.x.x, 192.168.x.x — not routable on the internet, free to use internally.

2. **NAT** translates private IPs to public IPs for internet access. Your home router does NAT. AWS NAT Gateway does NAT for private VPC subnets.

3. **EC2 private IP** persists across stop/start. **EC2 public IP** changes on stop/start. **Elastic IP** is static, persists, and costs money when idle.

4. **Never put a database in a public subnet with a public IP.** Databases get private IPs only — reachable only from application servers within the VPC.

5. **AWS reserves 5 IPs per subnet:** network address, router, DNS, reserved, broadcast. /24 gives 251 usable (not 254).

6. **169.254.169.254** is the AWS Instance Metadata Service address. Only accessible from within the EC2 instance. Contains IAM credentials — can be exploited via SSRF.

7. **VPC CIDR cannot be changed** after creation (only secondary CIDRs can be added). Plan CIDR ranges across all accounts before creating VPCs.

8. **Overlapping VPC CIDRs cannot be peered.** Use a company-wide CIDR allocation plan to prevent this.

9. **VPC Gateway Endpoints** (for S3 and DynamoDB) are free and keep traffic on AWS's private network — no NAT Gateway needed, no internet exposure.

10. **IPv6 addresses in AWS are always globally unique public addresses** — no NAT. Use Egress-Only Internet Gateway to allow IPv6 outbound without inbound.

---

### 30-Second Interview Explanation

_"Private IPs (10.x, 172.16-31.x, 192.168.x) are RFC 1918 addresses used inside private networks. They're not globally unique and not routable on the internet. NAT — at your home router or at AWS's NAT Gateway — translates private IPs to a public IP so internal devices can access the internet without being directly exposed. Public IPs are globally unique, internet-routable addresses. In AWS, EC2 instances always get a private IP from the VPC subnet; a public IP is optional and changes on restart unless you use an Elastic IP. The core security principle: give public IPs only to services that absolutely need internet access — load balancers, API gateways. Keep application servers and databases on private IPs only, reducing the attack surface to the minimum necessary."_

---

### Memory Tricks

**Private IP ranges — "10, 172, 192"**

- 10 fingers on your hands (10.x.x.x — Class A, biggest range)
- 172 degrees — medium (172.16.x.x — Class B, medium range)
- 192 — easy to remember because every home router uses 192.168.1.x

**NAT Gateway location — "Public Servant"**

- NAT Gateway is a "public servant" — it lives in the public subnet but serves the private subnet residents

**EIP cost rule — "Idle hands cost money"**

- EIP is free when working (attached to running instance). Costs money when idle (unattached or on stopped instance) — "idle hands cost money"

**AWS reserved IPs per subnet — "NRDRB" (5 addresses)**

- **N**etwork | **R**outer | **D**NS | **R**eserved | **B**roadcast

---

## SECTION 12 — Architect Thinking Exercise

### The Scenario

Read carefully and think for 2-3 minutes before reading the solution.

---

**You are the AWS architect at an e-commerce startup. The company just received a PCI-DSS Level 1 audit requirement (the highest level — required when processing over 6 million credit card transactions per year).**

**Current problematic architecture (discovered in the audit):**

- EC2 payment processing servers: in a public subnet with public IPs
- RDS with cardholder data: in a public subnet with public IP
- All EC2 instances share the same security group that allows all inbound traffic (0.0.0.0/0 on all ports)
- Developer laptops access production RDS directly from internet using their public IPs
- EC2 instances use IMDSv1
- No VPC Flow Logs

**PCI-DSS requirements you must meet:**

1. Cardholder data systems must not be directly accessible from the internet
2. Access to cardholder data must be through authenticated, encrypted channels only
3. All network access must be logged
4. Only authorized users with least-privilege access
5. Regular vulnerability scanning of all public-facing systems

**Your task:** Design the remediated architecture.

---

### Solution and Reasoning

**Step 1 — Move RDS to a private subnet with no public IP (Critical)**

This is the highest-priority fix. An RDS database with a public IP is a catastrophic PCI violation — credit card data is directly reachable from the internet.

Action:

- Create new private subnets (10.0.20.0/24 in AZ-a, 10.0.21.0/24 in AZ-b)
- Launch a new RDS instance in these private subnets with no public accessibility
- Migrate database
- Update application connection strings
- Delete old public RDS

The new RDS has only a private IP. No internet path in or out. Only the application servers in the private app subnet can connect to it.

**Step 2 — Move payment servers to private subnet**

Payment processing servers should not have public IPs. They only need to:

- Receive requests from the load balancer (internal)
- Call the payment processor's API (outbound to internet)
- Connect to RDS (internal)

Action:

- Create private application subnets (10.0.10.0/24, 10.0.11.0/24)
- Move EC2 payment servers here, remove public IPs
- Add a NAT Gateway in the public subnet for outbound internet access (to call payment processor API)
- Update Load Balancer to forward traffic to private subnet EC2 targets

**Step 3 — Fix security groups (CDE isolation)**

PCI-DSS requires isolating the Cardholder Data Environment (CDE). This means tight security group rules:

```
ALB Security Group:
  Inbound: 443 from 0.0.0.0/0 (HTTPS from internet)
  Outbound: 8080 to AppServer-SG (to application)

AppServer Security Group:
  Inbound: 8080 from ALB-SG only
  Outbound: 3306 to RDS-SG, 443 to 0.0.0.0/0 (for payment API calls via NAT GW)

RDS Security Group:
  Inbound: 3306 from AppServer-SG only
  Outbound: None
```

This implements the principle of least privilege at the network layer.

**Step 4 — Fix developer access (no direct internet RDS access)**

Developers must not access production RDS directly from their laptops over the internet. This is both a security violation and a PCI violation.

Solutions (choose one based on company needs):

- **Bastion Host / Jump Box:** A hardened EC2 in a public subnet. Developers SSH to the bastion first (key pair + IP whitelist only), then from bastion connect to RDS. All access logged. Bastion can be an auto-scaling group of 1 that's off outside business hours.
- **AWS Systems Manager Session Manager:** No public bastion needed. Developers access EC2 instances through SSM (over HTTPS through SSM endpoints). No SSH port open, no public IP on server. All sessions are logged in CloudTrail + S3.
- **Client VPN:** Developers authenticate with a VPN client; assigned a private IP; connect to RDS as if on the internal network. All traffic through encrypted VPN tunnel.

For PCI-DSS best practice: **SSM Session Manager** — no open ports, no SSH, full logging.

**Step 5 — Enable IMDSv2**

Update all EC2 instances to require IMDSv2:

```bash
aws ec2 modify-instance-metadata-options \
  --instance-id i-xxxx \
  --http-tokens required \
  --http-endpoint enabled
```

Enforce via an SCP at the Organization level so no future instance can use IMDSv1.

**Step 6 — Enable VPC Flow Logs**

- Enable VPC Flow Logs for the entire VPC → S3 bucket
- Set up Athena tables for querying flow logs
- Create CloudWatch alarms for unusual traffic patterns (e.g., RDS receiving connections from unexpected IPs)
- Logs must be retained for at least 12 months (PCI-DSS requirement)

**Final Remediated Architecture:**

```
Internet
   │
   ▼
[ALB — Public Subnet — Public IP]
   │ (Security Group: 443 from internet only)
   ▼
[Payment Server EC2 — Private Subnet — Private IP only]
   │ (Security Group: from ALB only)
   ├──→ [NAT Gateway] → Internet (for payment API calls only)
   │
   ▼
[RDS — Private Data Subnet — Private IP only]
   (Security Group: 3306 from payment server SG only)

Developer Access:
[Dev Laptop] → [SSM Endpoint (HTTPS)] → [EC2 / RDS via private IP]
All sessions logged in CloudTrail
```

Zero public IPs on backend systems. Zero direct internet access to cardholder data. Zero open SSH ports. All network traffic logged. Least privilege at every layer.

---

### Architect's Takeaway

The entire PCI-DSS remediation was executed through one discipline: **understanding and correctly applying public vs private IP addressing** at the architecture level. Every fix was a manifestation of one rule: "private systems get private IPs; only the minimum necessary surface area is public." IP addressing is not a low-level network detail — it is a security architecture decision.

---

## Complete Series Summary

| File    | Sections | Core Learning                                                                                                               |
| ------- | -------- | --------------------------------------------------------------------------------------------------------------------------- |
| File 01 | 1–4      | Private/public IP intuition, RFC 1918 ranges, NAT types, IMDS, full architecture + 10-step NAT flow                         |
| File 02 | 5–8      | Hotel/Uber analogies, security architecture thinking, AWS EC2 IP types, CIDR planning, CGNAT, zero-trust design             |
| File 03 | 9–12     | AWS SAA exam traps (EIP cost, /5 reserved, IMDSv2, IPv6), 5 comparison tables, quick revision, PCI-DSS remediation exercise |

**Next Topic:** IP Address Structure (IPv4 Concept)
