# Linux Basics (SSH, Processes)

## FILE 02 OF 03 — Deep Dive: SSH Tunneling, Process Debugging, Failure Modes & Incidents

> **Architect Training Mode** | Senior Principal Architect Perspective
> _Optimized for: design judgement · tradeoff evaluation · failure prediction · production debugging_

---

## SECTION 5 — Real World Example

### Local Port Forwarding: The Database Access Pattern

The most common production use of SSH beyond direct shell access is **local port forwarding** — tunneling a connection to a database or service that has no public exposure.

```
Scenario: Connect to RDS PostgreSQL in private subnet from your laptop

Without tunnel: IMPOSSIBLE — RDS has no public IP, VPC blocks all direct access

With SSH tunnel via bastion:
  ssh -L 5433:rds.cluster-xxx.ap-south-1.rds.amazonaws.com:5432 \
      -i ~/.ssh/bastion.pem \
      ec2-user@54.x.x.x \
      -N   ← Don't open a shell, just forward

What happens:
  Your laptop port 5433 →  SSH tunnel → Bastion → RDS port 5432

  In your DB client: host=localhost, port=5433
  Actual traffic: laptop → [encrypted SSH] → bastion → [internal VPC] → RDS

  The connection to RDS originates FROM the bastion (which is allowed in RDS SG)
  Your laptop's IP never touches RDS directly

Operational use case:
  ├── Database migrations before application deployment
  ├── Production data debugging (read-only replica access)
  ├── Running EXPLAIN ANALYZE on slow queries in production
  └── One-time data fixes after an incident

When to stop using SSH tunnels for DB:
  If you're doing this regularly → set up proper DB admin tooling
  (AWS RDS Proxy + IAM auth, or a dedicated admin VPC with AppStream)
  SSH tunnel to production DB = high-risk, easy-to-misuse access pattern
```

---

### Remote Port Forwarding and Dynamic (SOCKS) Proxy

```
Dynamic SOCKS proxy (browse internal network like you're on the bastion):
  ssh -D 9090 -i ~/.ssh/bastion.pem ec2-user@54.x.x.x -N
  Configure browser/curl to use SOCKS5 proxy: localhost:9090

  All traffic routes through bastion — you can reach any private IP
  Dangerous: easy to forget this is on, effectively on the internal network

Remote port forwarding (expose local service to server):
  Useful for webhook testing: make your local dev server reachable from EC2
  ssh -R 8080:localhost:3000 ec2-user@bastion

  Traffic: internet → bastion:8080 → your laptop:3000
  Use case: testing webhooks (Stripe, GitHub) against local dev code
  Production use: NEVER — only for development/testing
```

---

## SECTION 6 — System Design Importance

### The Process Monitoring Matrix

```
Tool           What it shows                    When to use it
─────────────────────────────────────────────────────────────
top            CPU, memory, load avg (live)      First look during incident
htop           Enhanced top (tree view)          Interactive debugging
ps aux         All processes snapshot            Scripting, automation
ps -ef --forest Process tree view               Find orphans/zombies
pgrep nginx    PIDs of named process            Quick existence check
pidstat -p PID Per-process CPU/IO stats          Identify CPU/IO culprit
strace -p PID  System calls of a process        "What is this process DOING?"
lsof -p PID    Open files/sockets of process   "What is this process connected to?"
netstat -tlnp  Active TCP listeners             "Who's listening on port X?"
ss -s          Socket statistics summary        "How many connections are there?"
```

### Reading Top Output Like an Architect

```
top - 14:23:01 up 12 days,  4:01,  2 users,  load average: 4.21, 3.95, 3.72
Tasks: 187 total,   2 running, 185 sleeping,   0 stopped,   0 zombie
%Cpu(s): 87.3 us, 5.2 sy,  0.0 ni,  4.1 id,  3.1 wa,  0.0 hi,  0.3 si
MiB Mem:   7837.0 total,    312.1 free,   6921.3 used,    603.6 buff/cache

Architect reads this as:

  load average: 4.21, 3.95, 3.72 on a 4-core machine:
    Load ≈ 1.0 per core = fully utilized
    4.21 on 4 cores = slight overload RIGHT NOW
    Trend: 4.21 (1min) ≈ 3.72 (15min) → stable high CPU, not a spike

  %Cpu: 87.3 us (user space) / 4.1 id (idle) / 3.1 wa (iowait)
    87% user CPU → application code is the bottleneck (not kernel, not I/O)
    3.1% iowait → some disk I/O waiting but not the primary issue
    → This is a CPU-bound problem. Scale horizontally (add ECS tasks/EC2).

  0 zombie → good (parent processes cleaning up children)

  If you saw: 0.0 id + 20.0+ wa → iowait dominant → disk I/O bottleneck
    Possible causes: disk throughput limit, EBS volume throttled, RDS slow queries
```

---

## SECTION 7 — AWS & Cloud Mapping

### Failure 1: The Zombie Storm

```
What creates zombies:
  Parent process forks children but never calls wait() to read their exit status
  Child finishes → becomes Zombie (exists only as PID in process table)

  Harmless at small scale: 5 zombies = debug but not urgent
  Dangerous at scale: thousands of zombies = process table exhaustion

  Linux process table: default ~32,768 PIDs (configurable via kernel.pid_max)
  If zombie count approaches this limit:
    New process creation FAILS → "fork: retry: No child processes"
    Application cannot spawn threads → request handling fails
    System appears running but functionally broken

Production indicator:
  ps aux | grep 'Z' | wc -l  → count zombies
  ps aux | grep -v grep | grep 'Z'  → see which processes are zombie

Root cause: usually a parent process that's poorly written (Node.js uncaught exceptions
            losing event loop tracking, Python subprocess without .wait())

Fix: Kill parent process (orphans its zombies → init/systemd adopts them → cleans up)
     Long-term: fix application code to properly reap children
```

---

### Failure 2: D-State Processes (Production Killers)

```
D state = "uninterruptible sleep" = waiting for disk I/O or kernel resource

  kill -9 PID   → does NOT work on D-state processes
  The process is stuck in kernel space waiting for I/O to complete

  Causes in AWS EC2 production:
    1. EBS volume I/O throttling (gp2 burst credits exhausted)
    2. EFS mount gone stale (NFS operations hanging)
    3. Kernel bug with specific EBS volume type
    4. RDS connection hanging at TCP level (app in D state waiting for response)

  How to spot it:
    ps aux | awk '$8 == "D" {print}'

  Impact:
    Single D-state process: minor, may resolve itself
    Multiple D-state processes: application frozen, requests timing out
    Entire app in D state: only EC2 reboot resolves it

  AWS-specific: EBS gp2 I/O burst credits deplete after sustained high I/O
    Solution: Migrate to gp3 (no burst credit model — consistent baseline)
              Or increase IOPS provisioning

  Check: CloudWatch metric → EBSIOBalance% dropping toward 0% = approaching I/O throttle
```

---

### Failure 3: The OOM Killer (Out of Memory)

```
Linux Out-of-Memory Killer activates when system has no free memory + no swap.
It kills the process with highest oom_score (calculated by kernel).

OOM kill in production:
  /var/log/syslog or `dmesg | grep -i oom`:
    "Out of memory: Killed process 14832 (node) score 862 or sacrifice child"

  Application: suddenly dead. No graceful shutdown. No SIGTERM. Instant.
  systemd: detects service died → restarts it (if Restart=always)
  Users: brief interruption then recovery if systemd restarts quickly

  The dangerous OOM scenario:
    OOM kills your application (expected — it had highest score)
    systemd restarts application (good)
    Application starts, begins accepting memory again
    Soon OOM kills it again (bad — memory leak, restarts don't fix root cause)
    Loop: start → OOM → restart → start → OOM...
    Result: constant partial availability, memory-related requests always fail

  Detection: CloudWatch metric "mem_used_percent" approaching 100%
  Alert before OOM: alarm at 85% memory → investigate before OOM kills app

  Quick fix: `systemctl restart myapp` (frees memory, temporary relief)
  Real fix: find memory leak in application code

  Architect note: size your EC2/ECS task memory with 30% headroom for GC, peaks, libraries
```

---

## SECTION 8 — Interview Preparation

**Beginner:**

**Q: What is SSH and why do developers use it?**
**A:** SSH (Secure Shell) is an encrypted protocol for remotely controlling a server from your laptop â€” like a secure remote control. Without SSH, you'd have to be physically at the server to type commands. With SSH, you open a terminal, type ssh user@server_ip, enter your key, and you're on the server running commands from anywhere in the world. All communication is encrypted, so no one can intercept your commands.

**Q: What is a Linux process and how is it different from a program?**
**A:** A program is the code stored on disk (e.g., the 
ode binary file). A process is a running instance of that program â€” it has memory, CPU time, a process ID (PID), and is actively executing. You can have one program running as multiple processes (e.g., 4 Node.js worker processes). ps aux lists all running processes; kill PID stops one; 	op or htop shows CPU/memory usage per process in real time.

**Q: What is the most common SSH security mistake developers make?**
**A:** Leaving SSH port 22 open to the internet (0.0.0.0/0 in security groups). Bots continuously scan the internet and try to brute-force SSH. Best practices: restrict SSH to your specific IP in the security group; use SSH keys (never passwords); disable root login (PermitRootLogin no); better yet, use AWS Session Manager (SSM) â€” zero port 22 open, all access audited in CloudTrail.

---

**Intermediate:**

**Q: What is systemd and why should you use it instead of 
ohup for running production services?**
**A:** 
ohup starts a process that survives SSH session closure but: it won't restart if the process crashes, it logs to a file with no rotation (disk fills up), and it doesn't start on server reboot. systemd is the Linux init system that manages services properly: auto-restarts on crash (Restart=always), starts on boot (WantedBy=multi-user.target), logs via journald (auto-rotated, queryable with journalctl), and supports dependency ordering. For any production long-running process, create a systemd unit file.

**Q: What does ulimit control and what is the most important ulimit for web servers?**
**A:** ulimit sets per-process resource limits. The most critical for web servers: 
ofile (max open file descriptors). Every TCP connection uses one file descriptor. Default limit is often 1024 â€” you'll hit connection failures at ~1,000 concurrent users. Production web servers need ulimit -n 65535 (or set in /etc/security/limits.conf and the systemd unit file with LimitNOFILE=65535). Check current: ulimit -a. Missing this setting causes "Too many open files" errors at moderate traffic load.

**Q: How do zombie processes and D-state (disk wait) processes differ, and how do you handle each?**
**A:** *Zombie (Z-state):* Process finished executing but parent hasn't called wait() to collect its exit code. Shows in ps as Z+. Uses no CPU/memory. Clean up by killing the parent process (which will reap its children). Many zombies = buggy parent code. *D-state (uninterruptible sleep):* Process waiting for kernel I/O (usually disk). Cannot be killed â€” even kill -9 won't work. Usually caused by NFS hang or EBS burst credits exhausted (gp2 volume). Only fix: resolve the underlying I/O issue or reboot. D-state processes block CPU scheduler.

---

**Advanced (System Design):**

**Scenario 1:** Your company runs EC2 instances that engineers SSH into for debugging. You need to implement production access controls: all SSH sessions should be audited, access should be temporary (maximum 4 hours), and no SSH keys should be distributed to engineers. How do you architect this?

*AWS SSM Session Manager:* No SSH keys, no port 22 open. Engineers authenticate via IAM. Sessions are automatically logged to S3/CloudWatch. Time-limited: IAM policy conditions limit session duration. Audit trail: every command logged in CloudTrail. Implementation: SSM agent on EC2 + IAM role granting ssm:StartSession. Engineers open sessions via AWS Console or ws ssm start-session. MFA-enforced via IAM policy. Zero key management burden.

**Scenario 2:** An EC2 instance is running 100% CPU for an unknown reason. You SSH in and find 5 Node.js processes running. You need to identify which is the culprit, why it's happening, and safely terminate the problematic process without affecting the other 4.

*Diagnosis:* 	op (sort by CPU, press P). Identify PID of high-CPU process. ls -la /proc/{PID}/exe â†’ shows full path of executable. cat /proc/{PID}/cmdline | tr '\0' ' ' â†’ exact command that started it. strace -p {PID} â†’ what system calls it's making (is it in a tight loop?). If perf top -p {PID} â†’ which function is consuming CPU.
*Safe termination:* Signal SIGTERM first (kill {PID}) â€” allows graceful shutdown. Wait 5 seconds. If still running: kill -9 {PID} (SIGKILL â€” immediate). Check other 4 processes aren't affected (they have their own PIDs). Identify root cause (runaway CPU loop in code? Infinite recursion?) before restarting.

