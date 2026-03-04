# RDS PostgreSQL

## FILE 02 OF 03 — Production Incidents, Failure Patterns & Debugging

> **Architect Training Mode** | Senior Principal Architect Perspective
> _Optimized for: design judgement · tradeoff evaluation · failure prediction · production debugging_

---

## SECTION 5 — Real World Example

```
INCIDENT TIMELINE:
  T+0:  Traffic spike: 500 concurrent API requests.
  T+2:  Error logs: "FATAL: remaining connection slots are reserved for non-replication superuser connections"
  T+3:  Application 500 errors across all endpoints (not just DB-heavy ones)
  T+10: DB CPU = 15% (not overloaded). Instance has capacity. Connections = 100/100 (full).

ROOT CAUSE:
  RDS db.t3.medium: default max_connections = 85 (formula: RAM_in_bytes / 18874368)
  Application: ORM (Sequelize) with connection pool per instance, not shared.
  5 ECS tasks × 20 connections/pool = 100+ connections → exceeded limit

  Cascading effect:
    New connections rejected → app requests hang waiting for connection
    Hanging requests consume ECS task threads → all task threads blocked
    Load balancer health check fails → target group unhealthy → 503

FIX (immediate):
  Increase max_connections in RDS parameter group (requires restart)
  Reduce connection pool size per application instance

FIX (correct permanent solution):
  Deploy RDS Proxy (connection pooler in front of RDS):
    RDS Proxy: multiplexes thousands of app connections → dozens of real DB connections
    Application → 1000 connections to RDS Proxy → 20 connections from Proxy to RDS
    RDS Proxy: buffers and queues if DB limit reached (no hard failure)

LESSON: max_connections is hard limit, not soft limit.
  db.t3.medium (2GB RAM): max 85-115 connections. Never enough for production.
  Use RDS Proxy or PgBouncer for connection pooling.
```

---

## SECTION 6 — System Design Importance

```
INCIDENT:
  Multi-AZ RDS performs automated failover (primary AZ hardware failure).
  Expected downtime: 60-120 seconds.
  Actual downtime: 8 minutes of 500 errors and DB connection failures.

ROOT CAUSE (3 failure points):

  1. Application: DB connection hardcoded as IP address, not DNS hostname.
     Multi-AZ failover: AWS updates DNS (CNAME) in 60-90 seconds.
     Application: ignored DNS. Kept hitting old IP. Connections rejected.
     Fix: ALWAYS use RDS endpoint DNS hostname. Never IP address.

  2. Application: no connection retry logic.
     During failover window (DNS update): connections fail with "Connection refused"
     Application: throws unhandled exception → request fails.
     Fix: implement exponential backoff retry (3 retries, 100ms-2s delay).

  3. Application: connection pool not refreshing dead connections.
     Old pool connections: established to old primary before failover.
     After failover: connections stale (TCP keepalive eventually kills them, but slowly).
     Fix: set pool connection_lifetime = 300-600 seconds (force periodic refresh).
     OR: RDS Proxy invalidates connections automatically on failover.

CORRECT RESILIENCE PATTERN:
  Connection: use DNS hostname (auto-resolves to new primary after failover)
  Retry: 3 attempts with exponential backoff (100ms, 500ms, 2000ms)
  Pool: set idle timeout + max connection age to force reconnection
  Health check: application endpoint that verifies DB connection (for ALB health check)
  Tool: RDS Proxy automatically handles connection refresh on failover for you
```

---

## SECTION 7 — AWS & Cloud Mapping

```
INCIDENT:
  Feature deployed: user dashboard showing 50 recent orders with customer names.
  Post-deployment: DB CPU spikes to 100%. Response time 8 seconds.
  Performance Insights: "SELECT * FROM users WHERE id = ?" executing 2,500 times/second.

ROOT CAUSE (classic N+1 problem):

  Code:
  const orders = await Order.findAll({ limit: 50 }); // 1 query
  for (const order of orders) {
    order.user = await User.findOne({ where: { id: order.userId } }); // N queries
  }
  // 1 query for 50 orders + 50 queries for 50 users = 51 queries per request

  50 orders × 1 query each user = 51 queries per page load
  100 concurrent users = 5,100 queries per page load cycle
  Result: DB CPU 100%, queue depth explodes

FIX:
  Use JOIN (eager loading) instead of lazy loading:

  // Sequelize eager load (1 query with JOIN):
  const orders = await Order.findAll({
    limit: 50,
    include: [{ model: User, attributes: ['id', 'name', 'email'] }]
  });
  // Generates: SELECT orders.*, users.name FROM orders JOIN users ON orders.userId = users.id LIMIT 50
  // 1 query → same result

DETECTION:
  Performance Insights: most executed queries by count (not by duration)
  N+1 signature: same query template executing N×(requests/sec)
  DataDog/New Relic: APM shows same DB query repeated hundreds of times per trace

RULE: Review Performance Insights weekly. Sort by "Calls" column, not just "Load".
```

---

## SECTION 8 — Interview Preparation

**Beginner:**

**Q: What is Amazon RDS and what does "managed" actually mean?**
**A:** RDS (Relational Database Service) is AWS's managed database service. "Managed" means AWS handles: OS patching, database software updates, hardware maintenance, automated backups (daily snapshots + transaction logs for PITR), Multi-AZ failover (in < 2 minutes). You handle: database schema design, query optimization, security group rules, deciding which instance type and storage to use. Compared to running PostgreSQL yourself on EC2: with RDS you lose root OS access but gain: no midnight "disk is full" alerts (you still get them but don't fix at OS level), no manual backup scripts, automatic failover. 95% of production PostgreSQL should be on RDS.

**Q: What is Multi-AZ RDS and why should production always use it?**
**A:** Multi-AZ RDS maintains a synchronous standby replica in a different AZ. Every write is replicated to the standby before confirming to the application. If the primary fails: AWS automatically fails over (DNS update) to the standby in ~60-120 seconds. Your application reconnects to the same endpoint â€” the DNS now points to the promoted standby. Without Multi-AZ: one AZ power outage = database down until manually restored. Cost: ~2x â€” you pay for both primary and standby. For production: Multi-AZ is non-negotiable. For development/staging: Single-AZ is fine (save money). Never use Single-AZ in production unless you have a documented, tested RTO > 5 minutes.

**Q: What are RDS read replicas and how are they different from Multi-AZ standby?**
**A:** *Multi-AZ standby:* synchronous replication, same region, CANNOT serve reads â€” it's purely a high-availability standby. Automatically promoted on primary failure. *Read Replica:* asynchronous replication (slight lag), CAN serve reads â€” connect your app's read queries to the replica endpoint. Can be in a different region. NOT automatically promoted (manual step). Use read replicas to: scale read-heavy workloads (separate read traffic from write traffic), offload reporting/analytics queries, reduce load on primary. Replication lag: typically < 1 second, can spike to minutes under heavy write load. Reads from replica may be slightly stale.

---

**Intermediate:**

**Q: What is RDS parameter group and what are the most important parameters to tune for a production PostgreSQL database?**
**A:** A parameter group contains configuration settings applied to the RDS PostgreSQL instance. Key parameters to review for production: shared_buffers â€” PostgreSQL buffer cache size (AWS sets this to 25% of RAM, usually good). max_connections â€” maximum simultaneous connections (formula: LEAST({DBInstanceClassMemory/9531392}, 5000)). work_mem â€” memory per sort/hash operation per query (be careful: max_connections Ã— work_mem could exhaust RAM). checkpoint_completion_target = 0.9 â€” spread checkpoints to reduce I/O spikes. log_slow_queries = 1000ms â€” log queries taking > 1 second (essential for identifying slow queries). idle_in_transaction_session_timeout = 30000 â€” kill connections idle in transaction for > 30s (prevent lock hangs).

**Q: What is Enhanced Monitoring in RDS and what does it show that standard CloudWatch metrics don't?**
**A:** Standard CloudWatch RDS metrics: average CPU, free memory, database connections, disk read/write ops â€” collected at 1-minute granularity, from the hypervisor. Enhanced Monitoring: collects metrics from an agent running on the RDS instance itself â€” at 1-second granularity. Shows: per-process CPU breakdown (is postgres using 80% CPU, or utovacuum?), OS-level memory (buffers, cached), file system calls, thread-level details. Essential for diagnosing: autovacuum causing I/O spikes, specific PostgreSQL processes consuming unexpected CPU. Standard metrics tell you "CPU is 90%"; Enhanced Monitoring tells you WHICH process.

**Q: What is RDS Performance Insights and how do you use it to find slow queries?**
**A:** Performance Insights is an AWS tool that shows which SQL queries are the top CPU consumers at any point in time. Main view: a timeline of DB load (measured in AAS â€” average active sessions). Below it: top SQL statements ranked by load. Click into any time window: see the exact SQL, wait event type (CPU, I/O, locks), and calling session. Use it to: find the query causing a CPU spike (event correlation with application traffic), identify lock contention, justify adding an index (before/after comparison). Free tier: 7-day history. Paid: longer retention. Always enable Performance Insights on production RDS â€” its value during an incident is immense.

---

**Advanced (System Design):**

**Scenario 1:** Your application queries are getting slower over time. The RDS instance is db.r6g.large (16GB RAM, 2 vCPU). CPU is 40%, memory is 60% used. Performance Insights shows the top query: SELECT * FROM orders WHERE user_id =  ORDER BY created_at DESC LIMIT 20. This query now takes 800ms, up from 50ms 3 months ago. Diagnose and fix.

*Diagnosis:*
(1) EXPLAIN ANALYZE SELECT * FROM orders WHERE user_id =  ORDER BY created_at DESC LIMIT 20 â€” check query plan. Is it doing a Seq Scan or Index Scan? Seq Scan on orders getting slower as the table grows.
(2) Check existing indexes: \d orders. Is there an index on user_id? On (user_id, created_at)?
(3) Table size: SELECT pg_size_pretty(pg_total_relation_size('orders')). Orders table grew from 100K to 10M rows.

*Fix â€” Add composite index:*
`sql
CREATE INDEX CONCURRENTLY idx_orders_user_created 
  ON orders (user_id, created_at DESC);
`
CONCURRENTLY means index builds without locking the table (production safe). New query plan: Index Scan using idx_orders_user_created â†’ O(log n) lookup by user_id, already sorted by created_at â†’ 50ms even at 10M rows.

*Longer term:* if orders table will reach 100M rows â€” consider table partitioning by created_at (monthly partitions) so old partitions are pruned from scans.

**Scenario 2:** Your production RDS is showing "max connection count reached" errors during business hours. Max_connections is 170 (db.t3.medium). You have 15 ECS tasks each with pool max=20. How do you analyze the connection usage and implement a sustainable fix?

*Analysis:*
`sql
SELECT count(*) AS total_connections,
       state,
       count(*) FILTER(WHERE state = 'idle in transaction') AS idle_tx,
       count(*) FILTER(WHERE state = 'active') AS active
FROM pg_stat_activity
WHERE datname = 'myapp'
GROUP BY state;
`
If many idle in transaction: set idle_in_transaction_session_timeout = 30000 in RDS parameter group. These are leaked transactions not being cleaned up.
If total is just 170 active: 15 tasks Ã— 20 max pool = 300 potential > 170 limit.

*Sustainable fix:*
(1) Reduce pool max from 20 to 10: 15 Ã— 10 = 150 < 170. Leaves headroom.
(2) Add PgBouncer as a sidecar container in the ECS task definition: tasks connect to PgBouncer at localhost:5432, PgBouncer maintains a pool of real connections to RDS. Multiplexing: 150 app connections â†’ 50 real RDS connections.
(3) Upgrade RDS to db.r6g.large (max_connections â‰ˆ 870) â€” more headroom, can accommodate growth.
(4) CloudWatch alarm: DatabaseConnections > 130 (75% of 170) â†’ alert before hitting limit.

