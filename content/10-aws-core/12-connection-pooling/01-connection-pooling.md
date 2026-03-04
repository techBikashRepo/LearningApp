# Connection Pooling

## FILE 01 OF 03 — Core Concepts, Architecture & Production Patterns

> **Architect Training Mode** | Senior Principal Architect Perspective
> _Optimized for: design judgement · tradeoff evaluation · failure prediction · production debugging_

---

## SECTION 1 — Intuition (Explain Like a 12-Year-Old)

```
POSTGRESQL CONNECTION COST:
  Each PostgreSQL connection = new OS-level process (fork() syscall)
  Cost per connection:
    Memory: ~5-10MB RAM per connection in PostgreSQL
    OS: process creation (slow syscall)
    Auth: TCP handshake + TLS handshake + pg authentication = ~10-50ms

WITHOUT CONNECTION POOLING:
  HTTP Request arrives → Open new DB connection → Query → Close connection
  100 concurrent requests = 100 connection opens per second
  Each open: 10-50ms overhead → 10% of 100ms API budget
  100 connections × 5MB = 500MB just for connection overhead on DB
  And: PostgreSQL max_connections typically 100-200 → hit limit quickly

WITH CONNECTION POOLING:
  Application startup → open N connections (connection pool)
  HTTP Request arrives → borrow connection from pool (instant, no TCP/TLS overhead)
  Query executes → return connection to pool (not closed, kept warm)
  Next request → same pooled connection (reused)

  Instead of: open-query-close (50ms overhead per request)
  Now: borrow-query-return (~0ms overhead for connection itself)

ANALOGY: taxi stand
  Without pool: order cab → cab drives from depot (5 min wait). Use. Cab returns to depot.
  With pool: cabs waiting at stand. Any request → instant cab. Finished → back to stand.
```

---

## SECTION 2 — Core Technical Explanation

```
APPLICATION-LEVEL POOL (in-process, within your app):
  Library: pg (node-postgres), node-pg-pool, TypeORM, Sequelize, SQLAlchemy
  Lives: inside each application process (container/pod)
  Pool per process: each instance has its own N connections to DB

  Problem at scale:
    10 ECS tasks × 20 connections pool = 200 connections to DB
    Scale to 100 tasks = 2,000 connections → exceeds RDS max_connections
    Each task restart = connection pool rebuilt (reconnection overhead at startup)

SERVER-SIDE PROXY POOL (external process, shared across app instances):
  Tools: PgBouncer (self-managed), RDS Proxy (AWS managed)
  Lives: between application and database
  Pool shared: 100 app instances all connect to 1 PgBouncer → PgBouncer holds 20 real DB connections

  Applications → [PgBouncer] → [RDS PostgreSQL]
  1000 app connections → PgBouncer accepts them all → maintains 20-50 real DB connections

  Benefit: DB sees 20 connections. App can scale to 1000 tasks. DB not overloaded.

PGBOUNCER POOLING MODES:
  Session pooling:   1 server connection held for entire client session duration
                     Client disconnect → connection returned to pool
                     Safest. Compatible with all PostgreSQL features.

  Transaction pooling: server connection held only during a transaction
                     Between transactions: connection returned to pool
                     Most efficient. Supports many clients with few DB connections.
                     Limitation: cannot use: SET variables, prepared statements (some limitations)

  Statement pooling: return after EACHstatement (aggressive, most restrictive)
                     Rarely used. Incompatible with most ORMs.

PRODUCTION DEFAULT: transaction pooling for connection efficiency
  Session pooling: use only if app relies on session-level features (SET LOCAL, advisory locks)
```

---

## SECTION 3 — Architecture Diagram (MANDATORY)

```
PATTERN 1: Application Pool Only (small scale)

  EC2/ECS App (3 instances)
    └── pg-pool (20 connections each)
         └── RDS PostgreSQL (60 connections total)

  Good for: < 10 instances, total connections < 80% of max_connections
  Limit: scales with instances → will hit max_connections during scale events

PATTERN 2: PgBouncer Sidecar (medium scale)

  EC2/ECS App (50 instances)
    └── PgBouncer sidecar (same container/pod)
         └── 5 connections per sidecar
              └── RDS PostgreSQL (250 connections total)  ← STILL HIGH

  Same problem as app pool at very large scale

PATTERN 3: PgBouncer as Shared Proxy (medium-large scale)

  EC2/ECS App (100 instances) → all connect to PgBouncer cluster
  PgBouncer (2-3 instances for HA):
    └── 20-50 connections to RDS
  RDS PostgreSQL: sees 50 connections (not 100×20=2000)

  Setup:
    PgBouncer on dedicated EC2 (c6g.large tier)
    HAProxy or NLB in front of 2 PgBouncer instances (HA)
    App: connect to HAProxy/NLB endpoint → routed to available PgBouncer

PATTERN 4: AWS RDS Proxy (managed, serverless-friendly)

  Lambda (1000 concurrent) → RDS Proxy → RDS PostgreSQL (20 connections)
  ECS App (100 tasks) → RDS Proxy → RDS PostgreSQL (50 connections)

  RDS Proxy features:
    Multiplexing: accepts any number of app connections → few DB connections
    IAM Auth: Lambda can auth with IAM token (no password management)
    Auto-failover: on Multi-AZ failover, RDS Proxy reconnects seamlessly
    Secrets Manager: handles credential rotation without app disruption
    PrivateLink: fully within VPC, no public endpoint

  Best for: Lambda, large-scale ECS, applications that scale rapidly
```

---

## SECTION 4 — Request Flow (MANDATORY FLOWCHART)

```ini
# /etc/pgbouncer/pgbouncer.ini — Production Configuration

[databases]
# Format: alias = host=... port=... dbname=...
myapp = host=mydb.cluster-xxxx.us-east-1.rds.amazonaws.com port=5432 dbname=myapp

[pgbouncer]
# Network
listen_addr = 0.0.0.0
listen_port = 5432

# Pool mode
pool_mode = transaction          # transaction pooling (most efficient)
# pool_mode = session            # use if SET/advisory locks needed

# Pool sizes
default_pool_size = 20           # max server connections per (db, user) pair
max_client_conn = 1000           # max app-side connections PgBouncer accepts
min_pool_size = 5                # keep this many idle server connections warm
reserve_pool_size = 5            # extra connections for burst (reserve_pool_timeout)
reserve_pool_timeout = 3         # use reserve pool if normal pool saturated > 3s

# Timeouts
server_idle_timeout = 600        # close idle server connections after 10 min
client_idle_timeout = 0          # don't close idle clients (app manages this)
query_timeout = 30               # kill queries running > 30 seconds
connect_timeout = 5              # fail if can't connect to DB server in 5s

# Auth
auth_type = scram-sha-256        # match PostgreSQL auth method
auth_file = /etc/pgbouncer/userlist.txt  # user:password pairs

# Logging
log_connections = 0              # 0 = no, 1 = yes (set 1 for debugging)
log_disconnections = 0
log_pooler_errors = 1

# Monitoring
stats_period = 60                # emit stats every 60 seconds
```

---

### Node.js Connection Pool Configuration

```javascript
// node-postgres (pg) pool configuration
import { Pool } from "pg";

const pool = new Pool({
  host: process.env.DB_HOST, // RDS endpoint or PgBouncer endpoint
  port: parseInt(process.env.DB_PORT || "5432"),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: false }, // TLS (verify CA in production)

  // Pool settings
  max: 20, // max connections in pool (per process)
  min: 2, // minimum idle connections maintained
  idleTimeoutMillis: 30000, // close idle pool connections after 30s
  connectionTimeoutMillis: 5000, // throw error if can't get connection in 5s
  maxUses: 7500, // recycle connection after N queries (prevent memory leaks)
});

// Always use try/finally or pool.connect() pattern to release connection
async function queryWithPool(sql, params) {
  const client = await pool.connect();
  try {
    const res = await client.query(sql, params);
    return res.rows;
  } finally {
    client.release(); // CRITICAL: always release, even on error
  }
}

// Simpler for single queries (auto-releases)
async function singleQuery(sql, params) {
  const res = await pool.query(sql, params); // pool manages acquire/release
  return res.rows;
}
```

---

### Cost Model

```
APPLICATION-LEVEL POOL:
  Cost: free (built into ORM/driver library)
  Tradeoff: does not solve connection count problem at scale

PGBOUNCER:
  Cost: EC2 instance cost only (c6g.medium: ~$22/month)
  For HA: 2 PgBouncer + NLB = ~$50/month total
  Saves: prevents need to upsize RDS to support more connections ($100-400/month)

RDS PROXY:
  Cost: $0.015/vCPU-hour (based on underlying RDS instance vCPU count)
  db.t4g.medium (2 vCPUs): $0.015 × 2 × 720 = $21.60/month
  db.r6g.xlarge (4 vCPUs): $0.015 × 4 × 720 = $43.20/month
  Value: fully managed, HA, no operational overhead, IAM auth, failover handling

COMPARISON:
  For Lambda/serverless -> RDS Proxy is the only practical option
  For ECS at moderate scale -> PgBouncer (cheaper, more control)
  For very simple deployments -> application-level pool (no extra infra)
  Break-even: RDS Proxy vs PgBouncer: ~$20/month vs ~$50/month HA PgBouncer
    Either way: much cheaper than RDS instance upsizing to handle raw connections
```
