# Linux Basics (SSH, Processes)

## FILE 03 OF 03 — AWS Mapping, Cost, Exam Traps, Scenario Exercise & Architect's Mental Model

> **Architect Training Mode** | Senior Principal Architect Perspective
> _Optimized for: design judgement · tradeoff evaluation · failure prediction · production debugging_

---

## SECTION 9 — Certification Focus (AWS SAA-C03)

### The Evolution: SSH Dependency → Managed Services

Every time you SSH into a production server to do something, ask: **"Could AWS automate this?"**

| Manual SSH Task                 | AWS Replacement                            | When to Use AWS Service         |
| ------------------------------- | ------------------------------------------ | ------------------------------- |
| SSH to check logs               | CloudWatch Logs + Insights                 | Always — no SSH needed for logs |
| SSH to run a cron job           | EventBridge Scheduler + Lambda             | Any scheduled task              |
| SSH to deploy new code          | CodeDeploy / ECS rolling deploy            | All code deployments            |
| SSH to check CPU/memory         | CloudWatch Agent + EC2 metrics             | Always — agent pushes metrics   |
| SSH to restart a service        | SSM Run Command                            | Emergency only                  |
| SSH to rotate config            | SSM Parameter Store + config reload        | Parameterize configs            |
| SSH to check disk usage         | CloudWatch Agent (disk metric)             | Enable agent on all EC2         |
| SSH to kill zombie processes    | Better: use ECS (containers restart clean) | Zero-SSH architecture           |
| SSH to run a database migration | CodeBuild task / ECS one-off task          | CI/CD pipeline                  |

---

### AWS SSM: The Modern SSH Replacement

```
SSM Session Manager capabilities:
  ├── Interactive shell session (like SSH) — no port 22, no keys
  ├── SSM Run Command — run a command across fleet (100 servers in parallel)
  ├── SSM State Manager — enforce desired state (ensure Nginx config correct)
  ├── SSM Patch Manager — automate OS patching across fleet
  └── SSM Automation — multi-step runbooks for complex operations

Run Command example (restart app on all prod servers simultaneously):
  aws ssm send-command \
    --document-name "AWS-RunShellScript" \
    --targets "Key=tag:Environment,Values=prod" \
    --parameters 'commands=["systemctl restart myapp"]' \
    --comment "Restart after config change"

  Result: command sent to all EC2 tagged Environment=prod
          No SSH. No bastion. Full audit trail in CloudTrail.

Cost: SSM Session Manager = FREE
      SSM Run Command = FREE (first 1M invocations/month free)
      Infrastructure savings: eliminates bastion host EC2 instance (~$15-30/month)
      Security savings: eliminates entire class of SSH-related vulnerabilities
```

---

### CloudWatch Agent: Making Process Data Observable

```
The CloudWatch Agent collects metrics SSH inspection normally provides:
  ├── CPU (per-core, wait, steal)
  ├── Memory usage and available
  ├── Disk usage per mount point
  ├── Process count
  └── Custom application metrics

cloudwatch-agent config (key section):
  {
    "metrics": {
      "metrics_collected": {
        "cpu": {
          "measurement": ["cpu_usage_user", "cpu_usage_iowait"],
          "metrics_collection_interval": 60
        },
        "mem": {
          "measurement": ["mem_used_percent"],
          "metrics_collection_interval": 60
        },
        "disk": {
          "measurement": ["disk_used_percent"],
          "resources": ["/", "/var/log"],
          "metrics_collection_interval": 60
        }
      }
    }
  }

Alarms on top of these metrics:
  mem_used_percent > 85% → PagerDuty (before OOM kills app)
  disk_used_percent > 80% → Warning, > 90% → Critical
  cpu_usage_iowait > 30% for 5 minutes → Possible EBS throttle/RDS slow query
```

---

## SECTION 10 — Comparison Table

### Real Cost of SSH-Based Operations Architecture

```
Direct costs:
  Bastion Host (t3.micro, Linux, 730 hrs/month):  ~$8.50/month
  Elastic IP (for bastion):                       ~$3.60/month if unused, $0 if attached
  Total bastion cost:                              ~$12/month minimum

Hidden costs:
  Engineer time maintaining bastion (OS patches, key rotation):  2-4 hrs/month
  Security audit findings related to port 22 exposure:           hours of remediation/quarter
  Incident investigation without audit trail:                    hours per incident

SSM Session Manager alternative:
  Direct cost: $0/month
  Port 22: never open → security team happy → fewer audit findings
  CloudTrail: every command logged → incidents resolved in minutes not hours

ROI: Replacing bastion with SSM = ~$12/month saved + hours of engineer time/month
     First security incident SSH access enables: costs far more than $12/month
```

---

## SECTION 11 — Quick Revision

### Anti-Patterns and When SSH Is the Wrong Answer

**1. Service-to-Service Communication**

```
NEVER do this:
  Application Server SSH → Database Server to run queries
  Service A SSH → Service B to execute scripts

If you see SSH between services: architectural smell.
Services communicate via APIs (HTTP/gRPC), message queues (SQS), or shared databases.
SSH is for HUMAN operators, not automated service communication.
```

**2. Docker Container Access in Production**

```
Container debugging via docker exec (ship equivalent of SSH):
  You SHOULDN'T be docker exec-ing into production containers.
  If you need to: your logging/monitoring is insufficient.

  Container logs should be in CloudWatch → no exec needed for log viewing
  Container metrics in CloudWatch via Container Insights → no exec for metrics

  If you MUST exec in: use ECS Exec (built on SSM, no port 22, full audit trail)
  aws ecs execute-command --cluster prod --task TASK_ID \
    --container myapp --interactive --command "/bin/bash"
```

**3. ECS/Lambda/Fargate — You Can't SSH (and Shouldn't Want To)**

```
ECS Fargate: no persistent EC2 instance. Task containers are ephemeral.
Lambda: no server at all. Pure function execution.

For Fargate: structured logging → CloudWatch → Insights queries
For Lambda: CloudWatch Logs → filter by request ID → full traces

If you've designed a system where you "need to SSH in to debug":
  The observability of your system is the real problem.
  Fix: structured logging, distributed tracing (X-Ray), CloudWatch dashboards.
```

**4. Scale: When You Have More Than ~10 Servers**

```
At 10+ servers: stop thinking about individual server SSH access
At 50+ servers: individual server management = operational anti-pattern
At 500+ servers: you cannot SSH to debug production — you need observability

Transition points:
  1-10 servers:     SSM Session Manager acceptable for occasional debug
  10-100 servers:   CI/CD + SSM Run Command + CloudWatch. Almost no direct access.
  100+ servers:     Zero direct access. Observability-only. Immutable infrastructure.

"Cattle, not pets" — servers at scale are replaced, not nursed back to health via SSH.
```

---

## SECTION 12 — Architect Thinking Exercise

```
Modern production architecture with zero SSH dependency:

Developer laptop
    │
    │ git push → GitHub
    │
    ▼
GitHub Actions CI/CD
    │ npm test + build
    │ docker build + push to ECR
    │ aws ecs update-service (rolling deploy)
    ▼
ECS Fargate (Private subnet, no public IP, no SSH port)
    │
    │ Application logs → CloudWatch Logs (via awslogs driver)
    │ Application metrics → CloudWatch (via CloudWatch Agent or SDK)
    │ Traces → AWS X-Ray
    ▼
CloudWatch Dashboards + Alarms + PagerDuty

FOR EMERGENCY DEBUG (rare, humans only):
    Developer → AWS Console → ECS → Task → ECS Exec (SSM-backed)
    OR
    Developer → SSM Session Manager → EC2 (if EC2-based, not Fargate)

What's completely absent:
    ├── No bastion host
    ├── Port 22: closed on ALL security groups
    ├── No SSH keys to manage
    └── No manual "check the server" operations

How deployments handle process management:
    │ ECS rolling deploy:
    │   1. ECS stops OLD task (sends SIGTERM, waits draining period)
    │   2. ECS starts NEW task (health check passes)
    │   3. ALB deregisters OLD, registers NEW
    │   No double-process problem. No port conflicts. No nohup.
    └── Built-in: zero-downtime deployment
```

---

### AWS SAA Exam Traps

### Trap 1: Bastion Host vs SSM Session Manager

```
Exam scenario: "A company needs engineers to securely access EC2 instances in private
                subnets. Which solution requires the LEAST operational overhead?"

Wrong answer: "Set up a bastion host in the public subnet"
Right answer: "Use AWS Systems Manager Session Manager"

Why SAA prefers SSM:
  ├── No port 22 open anywhere (exam loves "least privilege")
  ├── No additional EC2 instance to manage
  ├── IAM-based access (fits "least privilege" principle)
  └── Automatic audit trail in CloudTrail

Trap: The exam says "private subnet with no internet access."
      SSM Session Manager STILL works if you have:
        a) NAT Gateway in the VPC (SSM Agent calls out via HTTPS), OR
        b) Interface VPC Endpoints for SSM, ssmmessages, ec2messages

      If exam mentions "private subnet, no NAT Gateway" → you need SSM VPC Endpoints.
```

### Trap 2: SSH Key Pairs in Auto Scaling Groups

```
Exam trap: EC2 Auto Scaling launches instances.
           "How do engineers access individual instances?"

Wrong mental model: "SSH to each instance's public IP"
  In an ASG: instances are created/destroyed dynamically
  Tracking individual instance IPs = operational nightmare
  Answer: SSM Session Manager — instances are dynamically targetable by instance ID

Another trap: "EC2 key pair is required for Linux instances in ASG"
  Technically true for SSH. But if you never open port 22, key pair = irrelevant.
  You CAN create EC2 instances without a key pair if using SSM-only access.
  This often catches people who assume SSH is mandatory.
```

### Trap 3: nohup vs systemd on EC2

```
Exam scenario: "A script starts an application on an EC2 instance using nohup.
                After a reboot, the application is not running. What's the issue?"

Answer: nohup does NOT configure the process to survive reboots.
        nohup only keeps the process alive when the SSH session closes.

Fix: systemctl enable myapp → creates symlink in /etc/systemd/system/multi-user.target.wants/
     This makes the service start on boot.

Combined requirement: Restart on crash + Start on boot
  systemctl enable myapp  ← start on boot
  Restart=always in unit file ← restart on crash
  Both are needed. Neither alone is sufficient.
```

### Trap 4: Process Signals and Graceful Shutdown

```
Exam scenario: "An application needs to drain in-flight requests before stopping.
                How should the deployment process handle this?"

Key signals:
  SIGTERM (15): Graceful shutdown signal. Application should finish current requests then exit.
  SIGKILL (9):  Immediate kill. Cannot be caught or ignored. No cleanup.
  SIGHUP (1):   Historically "hang up" — many daemons use it to reload config WITHOUT restart.

Correct deployment sequence:
  1. Send SIGTERM to old process (graceful drain)
  2. Wait for process to exit (or timeout, configurable)
  3. If timeout: send SIGKILL (force kill)
  4. Start new process

  systemd handles this: TimeoutStopSec=30 (waits 30s for SIGTERM, then SIGKILL)
  ECS handles this: stopTimeout in task definition (default 30s, max 120s)

Exam: If asked about "graceful shutdown during rolling deploy" → SIGTERM + drain timeout
```

---

### Scenario Design Exercise

**Challenge:** Design the server access and process management architecture for a startup going from 2 developers and 3 EC2 instances to 20 developers and 200 EC2 instances in 6 months. What changes?

```
Phase 1 (Today): 2 devs, 3 EC2
─────────────────────────────
Access strategy:
  ├── SSM Session Manager (not bastion — start right)
  ├── EC2 instance role: AmazonSSMManagedInstanceCore
  └── IAM users for each developer

Process management:
  ├── systemd unit files for all services
  ├── Restart=always on all production services
  └── CloudWatch Agent for memory/disk metrics

Deployment:
  ├── GitHub Actions: test → build → SSM Run Command restart
  └── Or: simple ECS even at small scale (better long-term)

Phase 2 (6 months): 20 devs, 200 EC2
──────────────────────────────────────
Access strategy (SAME — SSM scales fine):
  ├── SSM Session Manager → but now with IAM groups and least privilege
  ├── IAM policy: allow SSM start-session only on tagged environments
  │   (dev team: can access dev instances. Cannot access prod instances.)
  └── CloudTrail log group: all SSM sessions → Splunk/CloudWatch Insights

Process management:
  ├── systemd + CloudWatch Agent on EC2 (if still using EC2)
  └── PREFER: migrate to ECS Fargate by now (200 EC2 = significant overhead)

Deployment (THIS must change):
  ├── GitHub Actions → CodePipeline → CodeDeploy or ECS rolling deploy
  ├── Blue/green deployment (zero-downtime, instant rollback)
  └── SSM Run Command: emergency patches only, not routine deployments

The key architectural shift:
  Phase 1: "I SSH in when something's wrong"
  Phase 2: "Something being wrong means my observability is broken. Fix observability."

  At 200 servers: debugging individual servers via SSH = losing the war.
  Observability: structured logs → CloudWatch → Insights queries to find outlier instance
                 then SSM to that ONE instance if needed (not routine)
```

---

### Interview Question Bank

### Beginner

**Q: How do you access a private EC2 instance that has no public IP?**

> Modern answer: AWS SSM Session Manager. The EC2 has the SSM Agent running, and an IAM role with `AmazonSSMManagedInstanceCore`. I connect via the AWS Console or CLI — no port 22, no public IP, no bastion required. The session is authenticated via IAM and logged in CloudTrail.
> Legacy answer: Bastion host — an EC2 in the public subnet with port 22 open to our VPN/office IP. Then SSH from bastion to target using the internal private IP. The target's Security Group allows port 22 from the bastion's Security Group.

**Q: What is the difference between SIGTERM and SIGKILL?**

> SIGTERM (signal 15) is a polite shutdown request — the application receives it, finishes in-flight requests, closes connections, and exits cleanly. SIGKILL (signal 9) is an immediate forced kill — the kernel terminates the process instantly, no cleanup, no chance to drain. Deployment scripts should always try SIGTERM with a timeout (e.g., 30 seconds) before falling back to SIGKILL, to allow graceful draining. systemd's `TimeoutStopSec` and ECS's `stopTimeout` implement this pattern.

---

### Intermediate

**Q: A production EC2 instance has 200 zombie processes. What's happening and how do you fix it?**

> Zombie processes exist when a parent process hasn't called `wait()` to read the exit status of its finished children. 200 zombies suggest a parent process (likely the application) is spawning subprocesses but not properly cleaning them up — common in poorly handled Python `subprocess` calls or Node.js child processes after an unhandled exception puts the event loop in a broken state. Short-term fix: identify and restart the parent process. Long-term: fix the application to properly reap children, or use ECS/Lambda where the container/function lifecycle is managed externally and each invocation starts clean.

**Q: Your deployment script uses `nohup node server.js &` and after the next server reboot, the app isn't running. What's the fix and why?**

> `nohup` only keeps the process alive when the initiating terminal session ends — it doesn't register the process to start on boot. Fix: create a systemd service unit file with `[Install] WantedBy=multi-user.target` and run `systemctl enable myapp`. Also add `Restart=always` and `RestartSec=5` in the `[Service]` section so it auto-recovers from crashes. But the real answer at production scale is: avoid `nohup` entirely. Use ECS or a properly configured systemd service from day one.

---

### Advanced

**Q: How would you design access control for 50 engineers who need varying levels of access to 500 EC2 instances across 3 environments?**

> I'd use SSM Session Manager exclusively — no SSH, no bastion. Access control through IAM: engineers have IAM roles with tag-based conditions — `ssm:resourceTag/Environment = dev` allows dev access, `= prod` requires MFA + break-glass approval (IAM Policy with `aws:MultiFactorAuthPresent: true`). EC2 instances are tagged by environment and ownership team. Access is reviewed quarterly via IAM Access Analyzer. All sessions logged to CloudTrail → shipped to immutable S3 with Object Lock for compliance. When an engineer leaves: deactivate their IAM user → access revoked everywhere simultaneously, no SSH key hunting.

---

### Quick Revision: 10 Key Points

1. **SSM Session Manager > bastion host** — no port 22, no keys, IAM-auth, free, full audit trail
2. **systemd: `Restart=always` + `RestartSec=5` + `systemctl enable`** = crash recovery + boot start
3. **D-state process** = waiting for I/O, cannot kill, must reboot. Check EBS burst credits (gp2).
4. **Zombie processes** = parent not calling wait(). Thousands = process table exhaustion. Kill parent.
5. **OOM Killer** = instant silent death. Monitor mem_used_percent, alarm at 85%.
6. **ulimit nofile** = default 1024. Production web servers need 65535. Missed = fail at 1024 connections.
7. **set -e -u -o pipefail** in every script — fail fast, never continue silently on error.
8. **nohup = anti-pattern for production**. systemd or ECS for process lifecycle management.
9. **Port 22 to 0.0.0.0/0** = gets brute-forced within minutes. Never in production.
10. **At scale: cattle not pets** — replace broken servers, don't SSH to fix them. Observability first.

---

### 30-Second Interview Answer

**Q: "How do you manage and access production Linux servers at scale?"**

> "I design for zero-SSH production architecture. For access, I use AWS SSM Session Manager — engineers authenticate via IAM with MFA, no port 22 anywhere, and every session is logged in CloudTrail. For process management on EC2, I use systemd unit files with `Restart=always` so services recover from crashes automatically. For deployments, I use ECS rolling deploys or CodeDeploy — no manual SSH deployments.
>
> For observability, the CloudWatch Agent runs on every EC2 and ships CPU, memory, disk, and process metrics. Logs go to CloudWatch Logs structured as JSON for queryability.
>
> The guiding principle: every time I would have SSHed to check something, I instead improve the monitoring or alerting so I never need to check it manually again. At 100+ servers, SSH debugging is a scaling anti-pattern — structured observability is the answer."

---

## === ARCHITECT'S MENTAL MODEL ===

### 5 Decision Rules

**Rule 1: "If you're SSHing into production to debug, your observability is broken."**
SSH-to-debug is a symptom that metrics, logs, and tracing are insufficient. Every SSH debug session should result in: a new CloudWatch metric, alarm, or log query that makes the same investigation possible without SSH next time. SSH access should get rarer over time, not more frequent. If SSH frequency increases as your system grows — you're scaling the wrong thing.

**Rule 2: "Port 22 to 0.0.0.0/0 is disqualifying in any architecture review."**
It's an automatic rejection from production approval. The correct answer is always: SSM Session Manager (port 22 closed entirely), or port 22 limited to a specific corporate IP/VPN CIDR. No exceptions for production systems. Ask this in every architecture review: "How is port 22 restricted?"

**Rule 3: "Process management is not the application's job — it's the platform's job."**
Applications should not worry about staying alive, restarting on crash, or starting on boot. That's systemd's job (EC2) or ECS service scheduler's job (containers). If someone's application has "auto-restart" code written in Python or Node — redirect that effort. The OS/platform does it better.

**Rule 4: "At 10+ servers, stop managing individuals. Manage the fleet."**
SSM Run Command, CodeDeploy, ansible-pull — fleet management tools. Individual SSH sessions for routine operations at scale = technical debt. Every routine SSH task should have a fleet-management equivalent scripted and version-controlled.

**Rule 5: "Immutable infrastructure beats mutable at scale. Replace, don't repair."**
When an EC2 instance is sick: don't SSH and fix it. Terminate it. Auto Scaling replaces it with a fresh, correctly configured instance from the AMI. This is only possible if: (a) your application state is external (RDS, S3, not local disk), (b) your AMI is up-to-date, (c) your user data / config management (SSM State Manager) configures the instance correctly on boot. Build toward replaceable infrastructure, not repaired infrastructure.

---

### 3 Common Architect Mistakes

**Mistake 1: "We'll add the bastion host for now and switch to SSM later."**
"For now" lasts until the first security breach. Bastion hosts accumulate: stale SSH keys from departed engineers, outdated OS (who patches the bastion?), port 22 restrictions loosen over time ("just add our home office IP"). Building with SSM from day one is SIMPLER than building with bastion and migrating. SSM requires: IAM role on EC2 + SSM Agent (pre-installed on Amazon Linux). That's it. Bastion requires: separate EC2, EIP, SG rules, key management, OS patching, ingress rules. SSM is objectively less work.

**Mistake 2: "The deployment script tests fine — deploy it to production."**
Deployment scripts tested only in happy-path conditions fail in production because: (1) production has state (files that already exist, services already running, disk with existing logs), (2) deployment runs as a different user with different permissions, (3) production has different environment variables. Defense: `set -e -u -o pipefail` + idempotent operations (`mkdir -p`, `systemctl restart` not start, `git pull` not clone) + test in staging with already-deployed state, not fresh state.

**Mistake 3: "The app handles its own process restart with a try-catch loop."**
Application code that catches fatal errors and restarts itself competes with the OS's process management. The application is trying to be its own supervisor — badly. Problems: (1) memory leaks don't get cleaned by in-process restart, (2) corrupted in-process state persists, (3) port binding issues if restart is too fast, (4) no external monitoring of restart frequency. Use systemd's `RestartSec` + `StartLimitIntervalSec` + `StartLimitBurst` — the OS knows how to rate-limit restarts and alert on crash loops. Applications should `process.exit(1)` on fatal errors and let the platform (systemd/ECS) restart them cleanly.

---

### Memory Trick: **SOAP-R**

**S** — SSM over SSH: port 22 = never open in production
**O** — Observability: SSHing to debug = monitoring deficiency. Fix the root cause.
**A** — Automation: Manual SSH ops at scale = anti-pattern. Script everything via Run Command.
**P** — Process lifecycle: systemd manages it. App code should not contain restart logic.
**R** — Replace, not repair: immutable infrastructure at scale. Terminate sick, launch fresh.

---

_Series Complete — Linux Basics (SSH, processes) → 3 Files_
_Next: AWS Cloud & Deployment — 02 - Environment Variables_
