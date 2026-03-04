# RDS PostgreSQL

## FILE 01 OF 03 — Core Concepts, Architecture & Production Patterns

> **Architect Training Mode** | Senior Principal Architect Perspective
> _Optimized for: design judgement · tradeoff evaluation · failure prediction · production debugging_

---

## SECTION 1 — Intuition (Explain Like a 12-Year-Old)

```
PHYSICAL WORLD EQUIVALENT:
  Traditional: DBA team manages PostgreSQL on bare metal.
    Tasks: OS patches, RAID configuration, replication setup, backup scheduling, failover scripts.
    Team size: 2-5 DBAs just for infrastructure.

AWS RDS: managed PostgreSQL. AWS handles the undifferentiated-heavy-lifting.
  Infrastructure: AWS manages OS, patching, hardware, storage scaling
  You manage: schema, queries, indexes, DB parameter tuning, security

WHAT RDS HANDLES FOR YOU:
  ├── Automated backups (daily snapshot + continuous WAL archiving → point-in-time recovery)
  ├── Multi-AZ standby (automatic failover in 60-120 seconds)
  ├── Minor version patching (or manual for major versions)
  ├── Storage autoscaling (set max storage, RDS expands automatically)
  ├── Encryption at rest (KMS) and in transit (TLS)
  └── Monitoring (CloudWatch metrics + Enhanced Monitoring + Performance Insights)

WHAT YOU STILL MANAGE:
  ├── Database schema design and migrations
  ├── Query optimization and indexing
  ├── PostgreSQL parameter group tuning
  ├── Connection management (can't auto-scale DB connections like compute)
  └── Read scaling (read replicas, query routing)
```

---

## SECTION 2 — Core Technical Explanation

```
INSTANCE TYPES:
  Purpose        | Class      | Example        | Use Case
  ---------------|------------|----------------|--------------------------------
  Burstable      | db.t3/t4g  | db.t3.medium   | Dev/test, small workloads
  General Purpose| db.m5/m6g  | db.m6g.xlarge  | Production web applications
  Memory Optimized| db.r5/r6g | db.r6g.2xlarge | High-memory: reporting, analytics

STORAGE TYPES:
  gp3 (General Purpose SSD): default. 3,000 IOPS baseline. Up to 64TB.
    Baseline 3K IOPS included free. Extra IOPS: provision separately.
    Migrate from gp2: same performance at 20% lower cost.

  io1/io2 (Provisioned IOPS): for I/O-intensive workloads.
    Up to 256K IOPS. Higher cost. Use when consistent sub-ms I/O required.

  Magnetic: legacy. Don't use.

MULTI-AZ vs READ REPLICAS:

  Multi-AZ:
    Primary: us-east-1a — Standby: us-east-1b
    Synchronous replication (every write ACKed by standby before returning to app)
    Standby: NOT a read endpoint. Only for failover.
    Failover: automatic. DNS updates to standby in 60-120 seconds.
    Purpose: HIGH AVAILABILITY (disaster recovery, not performance)

  Read Replica:
    Async replication from primary → replica
    Replica has its OWN endpoint. Application must route reads explicitly.
    Can create up to 5 read replicas (15 for Aurora)
    Can be in different AZ or different Region (cross-region read replica)
    Purpose: READ SCALING (performance, not HA)
    Can promote to standalone primary (manual, for DR or scaling)

  EXAM CRITICAL:
    Multi-AZ = HA. Standby = no read traffic.
    Read Replica = read scale. Not auto-failover.
    Need BOTH: use Multi-AZ + read replica(s).
```

---

## SECTION 3 — Architecture Diagram (MANDATORY)

```
THREE-TIER WEB APPLICATION WITH RDS:

  Internet
    │
  [ALB]                             ← Public subnets, multi-AZ
    │
  [ECS/EC2 Application Tier]        ← Private app subnets, multi-AZ
    │       ↑               ↑
    │  [Write: 5432]   [Read: 5432]
    │       │               │
  [RDS Primary]    [RDS Read Replica]   ← Private DB subnets, multi-AZ
  us-east-1a        us-east-1b
       │
  [Multi-AZ Standby]                ← Invisible to app. Auto-failover only.
  us-east-1b/c

SUBNET PLACEMENT:
  RDS: always in private DB subnets (no internet gateway route)
  DB subnet group: spans ≥ 2 AZs (required for Multi-AZ)
  Security Group: allow port 5432 ONLY from application security group (sg-app)

PARAMETER GROUP TUNING:
  shared_buffers:        25% of RAM (default often too low)
  work_mem:              RAM / max_connections / 4 (careful: per-sort-operation)
  effective_cache_size:  75% of RAM (hint to query planner)
  max_connections:       100-200 for RDS (use connection pooler for more)
  wal_level:             logical (required for logical replication / CDC)
  log_min_duration:      1000 (log queries > 1 second) — enable in Performance Insights

BACKUPS:
  Automated backup: 1-35 days retention. Point-in-time restore to any second.
  Snapshot: manual. Retained until deleted. Cross-region copy for DR.
  Recovery: restore to new DB instance (not in-place). DNS cutover required.
```

---

## SECTION 4 — Request Flow (MANDATORY FLOWCHART)

```
ENCRYPTION:
  At rest: KMS (AES-256). Must enable at creation (cannot enable on running DB).
  In transit: TLS 1.2+ required. Set rds.force_ssl = 1 in parameter group.

  Connection string with SSL:
    postgresql://user:pass@rds-endpoint:5432/mydb?sslmode=require
    Or: sslmode=verify-full (verifies CA cert — production recommended)

AUTHENTICATION OPTIONS:
  1. Username/password: stored in AWS Secrets Manager (auto-rotation)
     DB secret: rotate every 30 days automatically
     App: retrieve from Secrets Manager via SDK (cached, no hardcoding)

  2. IAM Database Authentication:
     Generate IAM auth token (15-minute validity) instead of password
     Advantage: no password stored. IAM controls who connects to DB.
     Limitation: max 200 connections/second for token generation (use connection pooler)

SECRETS MANAGER PATTERN:
  // Node.js — retrieve DB credentials from Secrets Manager
  const client = new SecretsManagerClient({ region: "us-east-1" });
  const { SecretString } = await client.send(
    new GetSecretValueCommand({ SecretId: "prod/myapp/postgresql" })
  );
  const { username, password, host, port, dbname } = JSON.parse(SecretString);
  // Use Secrets Manager SDK caching to avoid round-trip on every connection
```

---

### Cost Model

```
COST COMPONENTS:
  DB Instance:  hourly per instance type ($0.048/hr db.t4g.medium → $0.96/hr db.r6g.4xlarge)
  Storage:      $0.115/GB-month (gp3), $0.125/GB-month (io1)
  IOPS (io1):   $0.10/IOPS-month (provisioned above baseline)
  Backup:       Storage beyond 100% of DB size = $0.095/GB-month
  Data transfer: out to internet = $0.09/GB. Cross-AZ within VPC = $0.01/GB.

MULTI-AZ COST:
  Multi-AZ: essentially 2× instance cost (primary + synchronous standby)
  db.t4g.medium Single-AZ: $0.048/hr = $34.56/month
  db.t4g.medium Multi-AZ: $0.096/hr = $69.12/month
  Production: always Multi-AZ (RPO/RTO requirement)

COST OPTIMIZATION:
  Reserved Instances: 1-year = 35% discount, 3-year = 55% discount over On-Demand
  Savings Plans: NOT applicable to RDS (only EC2/Fargate/Lambda)
  Storage: gp3 over gp2 = same IOPS baseline at 20% lower storage cost
  Read Replicas: can be smaller instance class than primary (read queries less memory-intensive)
  Dev environments: db.t4g.small, single-AZ → 80% cheaper than production
```
