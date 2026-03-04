# RDS PostgreSQL

## FILE 03 OF 03 — Design Decisions, Exam Traps & Architect's Mental Model

> **Architect Training Mode** | Senior Principal Architect Perspective
> _Optimized for: design judgement · tradeoff evaluation · failure prediction · production debugging_

---

## SECTION 9 — Certification Focus (AWS SAA-C03)

```
CHOOSE RDS PostgreSQL WHEN:
  ✓ Standard PostgreSQL workload (OLTP, transactional web application)
  ✓ Budget-conscious: Aurora costs ~20-30% more for equivalent workload
  ✓ Need exact PostgreSQL version compatibility (extensions, behavior)
  ✓ Migration from on-premises PostgreSQL (same engine, minimal changes)
  ✓ Team familiar with PostgreSQL administration

CHOOSE AURORA POSTGRESQL WHEN:
  ✓ Significantly higher throughput required (Aurora MySQL 5× RDS MySQL, Aurora PG ~3×)
  ✓ Need Aurora Serverless v2 (auto-scale capacity units — no instance resizing)
  ✓ Up to 15 read replicas (vs 5 for RDS)
  ✓ Global database (active-active multi-region, <1 second replication)
  ✓ Sub-second point-in-time recovery (Aurora continuous backup to S3)
  ✓ Pay for what you use (Serverless v2: scale to 0 for dev environments)

CHOOSE SELF-MANAGED PostgreSQL ON EC2 WHEN:
  ✓ Need PostgreSQL extensions not supported by RDS (PostGIS on EC2 has more flexibility)
  ✓ Need specific OS-level tuning (huge pages, NUMA, specific kernel settings)
  ✓ Cost optimization for very large instances (cheaper per GB RAM at i3/r6i EC2 at scale)
  ✓ Compliance requires data residency RDS cannot guarantee

DECISION:
  Default: RDS PostgreSQL for standard production workload
  High-throughput + cloud-native: Aurora PostgreSQL
  Special requirements: self-managed EC2 (rare, warrants explicit justification)
```

---

## SECTION 10 — Comparison Table

```
ADD READ REPLICA WHEN:
  ✓ Primary CPU > 60% AND most queries are reads (reports, analytics)
  ✓ Long-running expensive reports impacting OLTP performance
  ✓ Need cross-region read performance (create replica in nearest region)
  ✓ Blue/green migrate: replica of production for testing queries against production-like data

DO NOT EXPECT READ REPLICA TO HELP:
  ✗ Write-heavy workload: replica doesn't reduce primary write load (async replication still writes)
  ✗ N+1 problem: replica just offloads volume, doesn't fix the root cause
  ✗ connection exhaustion: read replica = additional DB, but app needs to route reads explicitly
  ✗ Primary disk full: replica has same storage issue, different endpoint

READ ROUTING PATTERN:
  Application: connection pool to WRITER endpoint, connection pool to READER endpoint
  WRITES: payment.create(), user.update() → WRITER always
  READS: report.generate(), dashboard.load() → READER
  Explicit routing: service layer routes query based on intent (QueryBus pattern)
  ORM support: Sequelize, TypeORM support read/write splitting via dual pool config

AURORA ADVANTAGE:
  Aurora: cluster endpoint (writer) + reader endpoint (auto-balances across all replicas)
  Application: just 2 endpoints. Aurora handles load distribution automatically.
```

---

## SECTION 11 — Quick Revision

```
TRAP 1: Multi-AZ standby does NOT serve read traffic
  Common mistake: "create Multi-AZ to split read/write"
  Reality: standby = passive failover only. Not accessible for reads.
  "Read scaling" = Read Replicas. Separate feature, separate endpoint.
  Exam: "reduce read load on primary" → Add Read Replica. NOT Multi-AZ.

TRAP 2: Automated backups are deleted when DB is deleted (by default)
  RDS deletion: delete automated backups by default unless you check "retain backups"
  Final snapshot: manually created at deletion time (does persist)
  Exam: "recover deleted RDS instance" → only possible if snapshot was taken before delete

TRAP 3: Read Replica in different Region must be separately encrypted
  In-region encryption: inherits primary KMS key
  Cross-region replica: must specify a KMS key in the destination region
  Exam: cannot create cross-region encrypted replica without KMS key in target region

TRAP 4: RDS encryption cannot be enabled on existing unencrypted instance
  To encrypt existing: snapshot unencrypted DB → copy snapshot with encryption → restore
  Cannot: modify existing unencrypted instance to enable encryption (create+restore pattern)
  Exam: "enable encryption on existing unencrypted RDS" → snapshot → encrypted copy → restore

TRAP 5: max_connections formula for RDS
  RDS max_connections = LEAST({DBInstanceClassMemory/9531392}, 5000)
  db.t3.micro (1GB): ~45 connections
  db.t3.medium (4GB): ~170 connections
  Exam: "at scale, application hitting max_connections → best solution" → RDS Proxy
  Not: increase instance size (still limited, doesn't solve root cause)

TRAP 6: Read Replica promotion = separate standalone DB
  Promote replica → becomes a new standalone primary (original cluster relationship broken)
  No automatic cutover. Application must change its connection string.
  Use case: cross-region DR — promote replica in DR region and update DNS.
```

---

## SECTION 12 — Architect Thinking Exercise

```
REQUIREMENT:
  E-commerce: 100K daily active users, Black Friday → 10× spike.
  Read/write ratio: 80% reads, 20% writes. SLA: 99.9% availability.

SOLUTION DESIGN:

  DATABASE CONFIGURATION:
  └── Aurora PostgreSQL (chosen for scale + serverless v2 for cost efficiency)
      ├── db.r6g.xlarge writer (burstable to r6g.4xlarge with Aurora Serverless v2)
      ├── db.r6g.large read replica × 2 (offload dashboard/search reads)
      └── Aurora Serverless v2 auto-scaling: 2 ACU → 16 ACU (handles Black Friday)

  ALTERNATIVELY (simpler, lower cost):
  └── RDS PostgreSQL db.r6g.xlarge Multi-AZ
      ├── 1 Read Replica db.r6g.large (for reporting/dashboard queries)
      └── RDS Proxy in front (handles connection surge from 500→5000 concurrent users)

  SECURITY:
  ├── DB in private subnets (no public access)
  ├── Security Group: allow 5432 from app SG only
  ├── Credentials: AWS Secrets Manager (auto-rotate 30 days)
  └── Encryption: KMS at rest + require SSL in transit

  PARAMETER TUNING:
  ├── shared_buffers = r6g.xlarge (32GB) → 8GB (25%)
  ├── max_connections = 200 (+ RDS Proxy handles actual app connections)
  ├── log_min_duration_statement = 1000 (log queries > 1s)
  └── pg_stat_statements: enabled (Performance Insights integration)

  BACKUP:
  ├── Automated backup retention: 7 days (PITR to any second)
  ├── Weekly manual snapshot: retained 90 days
  └── Cross-region snapshot copy: us-west-2 (DR)
```

---

### Architect's Mental Model

```
5 RULES I NEVER VIOLATE:

1. "Multi-AZ = availability. Read Replica = performance. Never confuse the two."
   Multi-AZ: protects against AZ failure. Single endpoint.
   Read Replica: adds read throughput. Separate endpoint. Different connection pool.
   Production: both. Multi-AZ for HA, Read Replica if read load demands it.

2. "Connection string always uses DNS hostname — never a hardcoded IP"
   Multi-AZ failover updates DNS. Hardcoded IP = downtime beyond the 90-second failover.
   Driver: use connection string with SSL. Enable TCP keepalive and retry logic.

3. "max_connections is a hard limit — size your connection pool accordingly or add RDS Proxy"
   At any scale: connections per app instance × app instances must < max_connections - superuser_reserved
   Production default: RDS Proxy in front of all production databases.
   Cost: RDS Proxy ~$0.015/hour plus $0.01/connection-hour → cheap insurance.

4. "Secrets Manager for credentials. Never environment variables with plaintext passwords."
   Env var password: visible in task definition, CloudTrail, logs.
   Secrets Manager: encrypted, versioned, auto-rotated. Minimal code change.
   Pattern: fetch secret at startup, cache with TTL, refresh on rotation event.

5. "Performance Insights on, always. Look at it weekly."
   Performance Insights: free for 7 days on most RDS instances.
   It shows: top SQLs by load, waits, calls. Real root cause data.
   Without it: you're guessing when DB slows down. With it: you know in 30 seconds.

3 MISTAKES JUNIOR ARCHITECTS MAKE:

1. Single-AZ in production to save cost
   "We'll add Multi-AZ later." AZ failure during single-AZ = full outage, potentially hours.
   Multi-AZ cost delta = ~$35-100/month depending on instance class.
   Outage cost = engineering escalation + customer SLA breach + reputation. Not worth it.

2. No connection pooling, application directly opens unlimited connections
   Serverless (Lambda): each invocation opens a new connection. 1000 concurrent = 1000 connections.
   RDS throws: "too many clients" error at connection limit.
   Fix: RDS Proxy between Lambda and RDS. Essential for serverless architectures.

3. Restoring to same DB endpoint (not possible in RDS)
   "Restore to yesterday's backup" → RDS creates a NEW instance with a NEW endpoint.
   DNS cutover required. App must point to new endpoint.
   Plan for this: test restore procedure before you need it in a real incident.

30-SECOND MENTAL MODEL (Say this in an interview):
  "RDS is managed PostgreSQL on AWS. AWS handles patching, backups, failover.
   Multi-AZ for HA (standby can't serve reads). Read Replicas for read scaling.
   Always Multi-AZ in production. Use RDS Proxy for connection management at scale.
   Credentials in Secrets Manager. Performance Insights for debugging slow queries.
   Core trade: less operational overhead than self-managed, slight less flexibility."
```
