# Connection Pooling

## FILE 03 OF 03 — Design Decisions, Exam Traps & Architect's Mental Model

> **Architect Training Mode** | Senior Principal Architect Perspective
> _Optimized for: design judgement · tradeoff evaluation · failure prediction · production debugging_

---

## SECTION 9 — Certification Focus (AWS SAA-C03)

```
WHEN TO USE EACH POOLING APPROACH:

SCENARIO: Small app, < 5 instances, max 100 connections total
  Solution: Application-level pool only (pg-pool, SQLAlchemy pool)
  Config: pool max = RDS max_connections / instance_count / 0.8 (leave 20% headroom)

SCENARIO: Medium ECS deployment, 10-50 tasks, variable scale
  Solution: PgBouncer as shared proxy (2 instances behind NLB)
  Config: transaction mode, default_pool_size = 20-40
  Cost: ~$50/month. Saves $150-300/month in RDS instance over-provisioning.

SCENARIO: Serverless — Lambda, large ECS fleet (100+ tasks)
  Solution: RDS Proxy (mandatory for Lambda, practical for large ECS)
  Reason: Lambda cannot share connection pool across invocations
  Config: pool max DB connections = 20-50 for most RDS sizes

SCENARIO: Microservices, multiple services connecting to same DB
  Solution: RDS Proxy (1 proxy per DB cluster, all services connect to proxy)
  Benefit: centralized connection management, centralized IAM auth

POOLING DECISION TREE:
  Is your compute serverless (Lambda)?
    Yes → RDS Proxy (no other practical option)
    No →
      Total (max_apps × pool_per_app) > max_connections?
        No → Application-level pool only
        Yes →
          Want managed, AWS-native, IAM auth, failover handling?
            Yes → RDS Proxy
            No → PgBouncer (cheaper, open source, more config options)
```

---

## SECTION 10 — Comparison Table

```
POOL SIZING FORMULA:
  connections_needed = active_queries_at_peak × avg_query_time_seconds

  Example: 100 req/sec, avg query = 50ms = 0.05s
  connections_needed = 100 × 0.05 = 5 concurrent DB connections needed

  Add 20% headroom: pool_size = 5 × 1.2 = 6
  Reality: add burst headroom → pool_size = 10-20 for this workload

POSTGRESQL FORMULA (Hardware Perspective):
  PostgreSQL team recommendation: pool_size = CPU_cores × 2 + effective_spindle_count
  For db.r6g.xlarge (4 vCPUs, SSD storage): ideal = 4 × 2 + 1 = 9 connections active simultaneously
  This is the # of CONCURRENT active queries for optimal throughput (queuing theory)

  More than this: threads compete for CPU → marginally worse throughput per query
  Much more: severe context switching → dramatically worse

APPLICATION POOL SIZING (per instance):
  pool_max = min(
    RDS max_connections × 0.8 / expected_instances,  // don't exceed DB limit
    cpu_cores × 4                                    // CPU-bound apps: not too large
  )

  Example: RDS max 170, 10 instances, 4 CPU cores
  pool_max = min(170 × 0.8 / 10, 4 × 4) = min(13.6, 16) = 13 per instance

PGBOUNCER SIZING:
  default_pool_size: target = ideal_active_connections (e.g., 20-40 for most workloads)
  max_client_conn: 10× the DB max_connections (PgBouncer is lightweight for client side)
  reserve_pool_size: 20% of default_pool_size (burst handling)
```

---

## SECTION 11 — Quick Revision

```
TRAP 1: RDS Proxy is the solution for Lambda → RDS connection exhaustion
  Exam pattern: "Lambda function connects to RDS. Under high concurrency → too many connections"
  Answer: Deploy RDS Proxy between Lambda and RDS.
  Not: increase max_connections (DB limit still finite). Not: reduce Lambda concurrency.

TRAP 2: PgBouncer transaction mode breaks certain PostgreSQL features
  Exam rarely tests PgBouncer internals, but important for architect judgment:
  Cannot use in transaction pooling: SET LOCAL, advisory locks, prepared statements, LISTEN/NOTIFY
  If your app uses these: session pooling or RDS Proxy (not transaction mode PgBouncer)

TRAP 3: RDS Proxy requires specific IAM/Secrets Manager setup
  Exam: RDS Proxy auth through Secrets Manager (mandatory) OR IAM auth
  Cannot: point proxy to DB with just username/password inline config
  Must have Secrets Manager secret with DB credentials registered with proxy

TRAP 4: Connection pool on app restart ≠ warm immediately
  When ECS task starts: pool.min connections established at startup
  If all tasks restart simultaneously (rolling deployment): connection spike to DB
  Mitigation: stagger deployment (maxSurge/maxUnavailable in rolling update)
  min pool size = 2-5 (not 0) to maintain connection warmth

TRAP 5: Connection pool doesn't help with slow queries
  Pool reduces connection overhead. Does not speed up queries.
  High pool wait (pool.waitingCount > 0): queries taking too long → pool depleted
  Fix: query optimization + indexing, NOT increase pool size (masks real problem)
```

---

## SECTION 12 — Architect Thinking Exercise

```
CHALLENGE:
  Monolith EC2 app → decompose → Lambda functions.
  Existing RDS PostgreSQL (db.t4g.large, max 115 connections).
  Lambda: up to 500 concurrent invocations during peak.

PROBLEM:
  Without pooler: 500 Lambda × 1 connection = 500 → exceeds 115 limit.

MIGRATION DESIGN:

  Step 1: Deploy RDS Proxy
    aws rds create-db-proxy \
      --db-proxy-name lambda-rds-proxy \
      --engine-family POSTGRESQL \
      --auth AuthScheme=SECRETS,SecretArn=arn:aws:secretsmanager:...
      --role-arn arn:aws:iam::...:role/rds-proxy-role \
      --vpc-subnet-ids subnet-xxx subnet-yyy \
      --vpc-security-group-ids sg-xxx

  Step 2: Update Lambda connection string
    DB_HOST: proxy endpoint (not RDS endpoint)
    Pool max: 1 per Lambda (proxy multiplexes across all Lambdas)

  Step 3: Grant Lambda IAM permission to connect via proxy
    IAM policy on Lambda execution role:
    {
      "Effect": "Allow",
      "Action": ["rds-db:connect"],
      "Resource": "arn:aws:rds-db:region:account:dbuser:proxy-resource-id/dbuser"
    }

  Step 4: Use IAM auth token instead of password
    const signer = new RDS.Signer({
      hostname: proxyEndpoint, port: 5432, username: 'lambda_user', region: 'us-east-1'
    });
    const token = await signer.getAuthToken(); // 15-minute auth token
    // token used as password in DB connection

  RESULT:
    Lambda (500 concurrent) → RDS Proxy (accepts 500 connections)
    RDS Proxy → RDS (maintains 20 real DB connections)
    RDS CPU: stable. Connections: 20. Lambda: scales freely.
```

---

### Architect's Mental Model

```
5 RULES I NEVER VIOLATE:

1. "Lambda + RDS requires RDS Proxy. Full stop."
   Lambda is stateless ephemeral functions. Cannot share connection pools across invocations.
   Without proxy: linear connection growth with Lambda concurrency. DB overwhelmed.
   RDS Proxy overhead: ~5ms added latency. Worth it for every Lambda-to-RDS integration.

2. "Application pool is not optional — even with a proxy, the app still needs pool discipline"
   With RDS Proxy: app → proxy (connection). Proxy → DB (fewer connections).
   App still needs connection lifecycle management (release in finally , pool sizing, timeouts).
   Proxy doesn't fix connection leaks in application code.

3. "Pool waitingCount > 0 = query performance problem, not pool size problem"
   Pool exhausted: queries taking too long → connections held too long → queue builds.
   Fix: EXPLAIN ANALYZE the slow query. Add index. Cache hot data.
   Increasing pool size: temporarily masks problem, makes DB worse at scale.

4. "Always release connections in finally — never trust the happy path"
   Connection leak is silent. Takes hours to exhaust a pool.
   By the time you notice: usually requires application restart.
   Code review rule: every pool.connect() must have a paired finally { client.release() }

5. "PgBouncer transaction mode is the default — know its limitations before deploying"
   Transaction pooling is most efficient. But it silently breaks prepared statements, SET LOCAL.
   Test your ORM with transaction mode in staging. Don't discover in production.
   TypeORM users: explicitly disable prepare (prepareThreshold = 0 ) with transaction mode.

3 MISTAKES JUNIOR ARCHITECTS MAKE:

1. Setting pool size to match max_connections (forgetting multiple app instances)
   1 instance × pool 100 = fine.
   Auto Scaling to 10 instances × pool 100 = 1,000 connections → DB explodes.
   Formula: pool_per_instance = max_connections / max_expected_instances / 1.2.

2. Not monitoring pool stats in production
   "DB is slow" investigations start with CloudWatch CPU/connections.
   Better starting point: pool waitingCount (>0 = app-level starvation) + pg_stat_activity idle in transaction (leak detector).
   Instrument pool stats as custom CloudWatch metrics from day one.

3. Forgetting that RDS Proxy has a per-vCPU cost that compounds at scale
   Small DB: RDS Proxy cost = $20/month (negligible).
   Large multi-cluster setup: 8 clusters × db.r6g.4xlarge × 8 vCPUs = $691/month for proxy.
   At large scale: evaluate Architect-managed PgBouncer fleet cost vs RDS Proxy.

30-SECOND MENTAL MODEL (Say this in an interview):
  "Connection pooling reuses DB connections instead of creating new ones per request.
   Creates new connection: 10-50ms + 5-10MB RAM overhead. Pool: instant, pre-established.
   At scale: without pooling, connection count = active requests. DB has hard limits.
   Solution tiers: app-level pool (small), PgBouncer proxy (medium), RDS Proxy (large/Lambda).
   Key metric: pool.waitingCount > 0 means slow queries, not small pool."
```
