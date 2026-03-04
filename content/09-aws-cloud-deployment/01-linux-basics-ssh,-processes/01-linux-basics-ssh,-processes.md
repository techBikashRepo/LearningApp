# Linux Basics (SSH, Processes)

## FILE 01 OF 03 — Physical Infrastructure Replaced, Architecture Position & Core Concepts

> **Architect Training Mode** | Senior Principal Architect Perspective
> _Optimize for: design judgement · tradeoff evaluation · failure prediction · production debugging_

---

## SECTION 1 — Intuition (Explain Like a 12-Year-Old)

### Before SSH: Physical Console Access

In a pre-cloud data center, managing a server required:

- Physical presence in a server room (or costly KVM-over-IP hardware)
- Serial console cables attached directly to server's COM port
- Out-of-band management cards (iDRAC, iLO, IPMI) — each costing $$$
- On-call engineers physically going to the data center at 2 AM

This was **synchronous, human-in-the-loop, latency-bound** server management. One engineer, one server, one physical location at a time.

**SSH replaces:**
| Physical Component | SSH Equivalent |
|---|---|
| Serial console cable | SSH terminal session |
| KVM-over-IP switch ($1,500+) | AWS SSM Session Manager (free) |
| Out-of-band management (iDRAC/iLO) | EC2 Serial Console (AWS feature) |
| Data center physical access | Bastion host / Jump server |
| Hardware crash cart | AWS Systems Manager |

### The Async Shift SSH Enables

SSH turns server management from synchronous (someone physically present) to **asynchronous at scale**:

- 1 engineer can manage 10,000 servers remotely
- Scripts replace human presence for repetitive tasks
- Automation replaces on-call physical visits
- Audit trails replace physical access logs

This is the foundation of every DevOps practice: infrastructure as code only works if you can remotely execute code on infrastructure.

---

## SECTION 2 — Core Technical Explanation

### The Access Layer (Above Infrastructure, Below Application)

```
┌─────────────────────────────────────────────────────────┐
│                   PUBLIC INTERNET                       │
└─────────────────────────────┬───────────────────────────┘
                              │ Port 22 (SSH) or HTTPS (SSM)
┌─────────────────────────────▼───────────────────────────┐
│              ACCESS LAYER (How engineers reach servers) │
│                                                         │
│   Traditional:  Bastion Host (EC2 in public subnet)     │
│   Modern:       AWS SSM Session Manager (no port 22)    │
│   Emergency:    EC2 Serial Console (last resort)        │
└─────────────────────────────┬───────────────────────────┘
                              │
┌─────────────────────────────▼───────────────────────────┐
│              APPLICATION LAYER (Your servers)           │
│   EC2 instances / ECS tasks / EKS nodes                 │
│   Running in PRIVATE subnets (no public IP)             │
└─────────────────────────────┬───────────────────────────┘
                              │
┌─────────────────────────────▼───────────────────────────┐
│              DATA LAYER                                 │
│   RDS, ElastiCache, S3                                  │
└─────────────────────────────────────────────────────────┘

SSH/SSM lives in the ACCESS LAYER.
It should never be the APPLICATION LAYER's concern.
```

SSH is an **operational tool** — it's for humans managing infrastructure, not for application traffic. This distinction matters enormously: if your application architecture requires SSH between services, the architecture is wrong.

---

## SECTION 3 — Architecture Diagram (MANDATORY)

### Pattern 1 (Legacy): Bastion Host Architecture

```
Developer Laptop
      │
      │ SSH (port 22) with private key
      ▼
┌─────────────┐
│ Bastion Host │  ← EC2 in PUBLIC subnet
│ (t3.micro)  │  ← Port 22 open to: your IP only (or corporate NAT IP)
│             │  ← Has private key to target servers
└──────┬──────┘
       │
       │ SSH (port 22) — internal VPC connection
       ▼
┌──────────────────────────────────────────┐
│  PRIVATE SUBNET                          │
│  ┌───────────┐ ┌────────────┐           │
│  │  EC2 App  │ │  ECS Task  │           │
│  │ Server 1  │ │            │           │
│  └───────────┘ └────────────┘           │
└──────────────────────────────────────────┘

Security Group rules:
  Bastion SG: inbound port 22 from [developer IP range only]
  App Server SG: inbound port 22 from [Bastion SG ID only]

Problems with this pattern:
  ├── Bastion = SPOF and attack surface (single compromise → full access)
  ├── Port 22 open anywhere = constant brute-force attempt target
  ├── Private key management (who has the key? rotation policy?)
  └── No native audit trail without extra tooling
```

---

### Pattern 2 (Modern): AWS SSM Session Manager

```
Developer Laptop
      │
      │ HTTPS (port 443) via AWS API
      ▼
┌─────────────────────────┐
│  AWS Systems Manager    │  ← AWS-managed service
│  Session Manager        │  ← Zero port 22 required
└───────────┬─────────────┘
            │
            │ SSM Agent (pre-installed on Amazon Linux 2/2023)
            │ polls SSM endpoint via HTTPS outbound
            ▼
┌──────────────────────────────────────────┐
│  PRIVATE SUBNET — no public IP needed    │
│  ┌───────────────────────────────┐       │
│  │  EC2 Server                   │       │
│  │  SSM Agent running            │       │
│  │  IAM Role: AmazonSSMManagedEC2│       │
│  └───────────────────────────────┘       │
└──────────────────────────────────────────┘

Requirements:
  ├── EC2 IAM Role: AmazonSSMManagedInstanceCore policy attached
  ├── SSM Agent: running on EC2 (pre-installed on Amazon Linux 2/2023)
  ├── Interface VPC Endpoint (or NAT GW) for SSM API access
  └── Port 22: NEVER NEEDED — port 22 can be closed on ALL Security Groups

Benefits:
  ├── Full audit trail in CloudTrail (every command logged)
  ├── No SSH keys to manage or rotate
  ├── No bastion host attack surface
  ├── IAM-based access control (same as everything else in AWS)
  └── Session logs can be sent to S3 or CloudWatch Logs
```

---

## SECTION 4 — Request Flow (MANDATORY FLOWCHART)

### What a Process Is (from an Architect's Perspective)

A process is an **isolated unit of execution** with:

- Its own memory space
- Its own file descriptors
- A parent-child relationship (process tree)
- States that affect system stability

As an architect, you care about processes because:

- **Process crashes = service unavailability** (unless managed by systemd/supervisor)
- **Zombie processes = resource leak** leading to gradual degradation
- **Orphan processes = system instability** after deployment
- **D-state processes = disk I/O hang** requiring instance reboot

### Process States and Their Operational Meaning

```
Process State Machine:

  NEW ──→ RUNNING ──→ SLEEPING (S) ──→ RUNNING
               │           │
               │      DISK WAIT (D)  ← Uninterruptible — cannot kill, only reboot
               │
               └──→ STOPPED (T)      ← Suspended (SIGSTOP/SIGTSTP)
               │
               └──→ ZOMBIE (Z)       ← Process finished but parent hasn't read exit status
               │
               └──→ TERMINATED       ← Cleaned up

Operational significance:
  S (Sleeping): Normal. Process waiting for CPU or I/O.
  D (Disk wait): DANGER. Waiting for I/O. Cannot be killed. May indicate dying disk or NFS hang.
  T (Stopped):  Usually intentional (SIGSTOP for debugging). Can cause stuck deployments.
  Z (Zombie):   Memory leak indicator. Parent process not calling wait(). Accumulate over time.
```

### systemd: The Process Manager You Actually Need

```
systemd replaces:
  Old way: rc.d scripts, /etc/init.d — manual, fragile startup ordering
  New way: systemd units — declarative, dependency-aware, restart policies

Production-critical systemd config:

[Unit]
Description=My Node.js Application
After=network.target           # Don't start until network is up
Wants=network.target

[Service]
Type=simple
User=app                       # Run as non-root (security)
WorkingDirectory=/app
ExecStart=/usr/bin/node server.js
Restart=always                 # Restart on crash
RestartSec=5                   # Wait 5s before restart (prevents tight crash loop)
StandardOutput=journal         # Logs go to journald
StandardError=journal
Environment=NODE_ENV=production

# Resource limits — prevent runaway process from killing server
LimitNOFILE=65535              # Open file descriptors
LimitNPROC=4096                # Max subprocesses

[Install]
WantedBy=multi-user.target

# Key commands:
# systemctl start myapp        → start
# systemctl enable myapp       → start on boot
# systemctl status myapp       → current state
# journalctl -u myapp -f       → live logs
# systemctl daemon-reload      → reload config after editing unit file
```

---

### Request Flow: How SSH Access Works (12-Step Handshake)

```
Developer → Bastion → Target Server (SSH)

Step 1:  Developer runs: ssh -i ~/.ssh/prod.pem ec2-user@54.x.x.x (bastion IP)
Step 2:  TCP SYN sent to port 22 of bastion's public IP
Step 3:  Security Group evaluated: is source IP allowed on port 22? YES → passes
Step 4:  Bastion SSH daemon receives connection request
Step 5:  SSH key exchange (Elliptic Curve Diffie-Hellman) — establishes encrypted channel
Step 6:  Client sends public key for authentication
Step 7:  Bastion checks ~/.ssh/authorized_keys for matching public key
Step 8:  Match found → authenticated. Shell spawned for ec2-user
Step 9:  Developer is now IN bastion. Runs: ssh -i ~/.ssh/internal.pem 10.0.11.20
Step 10: TCP to internal server on port 22 (VPC private routing — no internet)
Step 11: Internal server SG: allows port 22 from bastion SG? YES → passes
Step 12: Same key exchange + auth. Developer in target server's shell.

Security implications of each step:
  Step 2: Port 22 open = brute force scan target. Limit source IPs ALWAYS.
  Step 6: Never copy private keys to bastion. Use SSH Agent Forwarding (-A flag).
            Agent forwarding keeps private key on developer laptop, forwards auth challenges.
  Step 7: authorized_keys file must be 600 permissions — writable only by owner
  Step 9: The bastion is now a hop point. If bastion is compromised, so is your network.
```

---

### Security Considerations: SSH Attack Surface

### What Port 22 Exposed to the Internet Means

```
Reality check — what happens when port 22 is open to 0.0.0.0/0:

  Real-world data: A new EC2 instance with port 22 open to internet
  receives its first brute-force attempt within 2-3 MINUTES of launch.

  Attacks targeting port 22:
    ├── Dictionary attacks (admin/admin, root/root, ubuntu/password)
    ├── Key brute-force (less common, very slow)
    ├── Known vulnerability exploits (Heartbleed-era SSH bugs)
    └── SSH tarpit attacks (attackers reverse-targeting your server)

Minimum security requirements for SSH:
  ├── Source IP restriction: ONLY from known IPs (corporate office, VPN)
  ├── Disable password authentication: PasswordAuthentication no (sshd_config)
  ├── Root login disabled: PermitRootLogin no
  ├── Specific user allowed: AllowUsers ec2-user
  └── Fail2Ban or AWS WAF on ALB (for port 22, Fail2Ban auto-bans IPs after N failed attempts)

Modern rule: port 22 should NEVER be open to 0.0.0.0/0.
If someone tells you to open port 22 to 0.0.0.0/0: that's an architectural defect.
```

### Handling SSH Keys at Scale

```
Problem: 10 developers, 50 servers. Who has SSH access to what?

Anti-pattern: Shared "deploy key" that everyone uses
  ├── Can't audit who did what (all look like "deploy")
  ├── Key rotation requires updating 50 servers
  └── Departing employee: which key did they have?

Pattern 1: Individual keys + bastion authorized_keys management
  Each developer has their own key pair
  Bastion's authorized_keys lists each public key
  Remove access: remove from authorized_keys

Pattern 2 (preferred): AWS SSM + IAM
  Zero SSH keys. IAM user = access.
  Departing employee: revoke IAM → immediate access revocation, ALL servers, ALL regions
  Audit: CloudTrail shows every session, every command
  MFA enforcement: IAM policy requires MFA for SSM session start
```

---

## KEY TAKEAWAYS — FILE 01

- SSH replaced physical console access — it's the async, remote equivalent of being at the server
- **Modern production**: use SSM Session Manager (port 22 = closed on all SGs). SSH/bastion = legacy.
- SSH belongs in the **access layer** — never between application services (service-to-service = API calls, not SSH)
- systemd `Restart=always` + `RestartSec=5` = your minimum crash-recovery config for any production service
- Process state D (disk wait) = cannot kill — server reboot required. Usually indicates I/O subsystem failure.
- Port 22 open to 0.0.0.0/0 is an architectural defect — receives brute force attempts within minutes
- **SSH key sprawl kills security posture** — prefer IAM-based access (SSM) where every access is tied to an identifiable person

---

_Continue to File 02 → SSH tunneling, process debugging, failure modes & production incidents_
