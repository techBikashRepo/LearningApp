# AWS Global Infrastructure (Regions & Availability Zones)

## FILE 02 OF 03 — Failure Patterns, AZ Outage Incidents & Production Debugging

> **Architect Training Mode** | Senior Principal Architect Perspective
> _Optimized for: design judgement · tradeoff evaluation · failure prediction · production debugging_

---

## SECTION 5 — Real World Example

### The Real Failure Sequence (Not the Happy Path Marketing Story)

```
T+0     AZ-a power event (hardware failure in upstream power distribution)
        AWS internal: AZ health state changes from HEALTHY → DEGRADED

T+30s   EC2 and ECS tasks in AZ-a: networking begins to degrade
        Not instant failure — partial packet loss first, then connectivity degrades
        "Thundering herd": all affected tasks detecting failures simultaneously

T+45s   ALB health checks to tasks in AZ-a: begin failing
        ALB: waits for health check failure threshold (default: 2 consecutive failures × 30s interval)
        During this window: ALB still routes ~50% traffic to AZ-a (getting errors)
        Users experience intermittent 502/504 errors

T+90s   ALB: marks all AZ-a targets as UNHEALTHY
        ALB: routes 100% traffic to AZ-b targets only
        User errors stop (assuming sufficient capacity in AZ-b)

T+2min  RDS primary in AZ-a: detects storage/network failure
        RDS: initiates automatic failover to standby in AZ-b
        DNS for RDS endpoint: updated to point to standby (now promoted to primary)

T+3min  RDS DNS TTL expires: application DB connections resolve to new primary
        Applications reconnect
        PROBLEM: apps with persistent DB connection pools:
          Node.js pg pool: holds old dead connections
          Must recognize connection failure and reconnect
          Apps without proper reconnect handling: 500 errors until pod restart

T+5min  System stable: all traffic on AZ-b, DB on AZ-b primary
        Your on-call gets a call: "hey, we had a 3-minute blip at 3 AM, no action needed"
        — This is what a well-architected multi-AZ system looks like

T+2hrs  AZ-a power restored: tasks and EC2 instances restart
        ALB: health checks pass → routes traffic back to AZ-a tasks
        RDS: AZ-a gets new standby (sync replication restores)
```

### The Real Danger: Application-Level Connection Handling

```
Database connection pool behavior during AZ failover:
─────────────────────────────────────────────────────────────────
Bad pattern (common in Express.js apps):
  const pool = new Pool({
    host: process.env.DB_HOST,   // resolves at startup only
    // No reconnect configuration
  });

  On RDS failover:
    DB_HOST still cached in DNS resolver
    Existing connections to old primary: dead (TCP reset)
    Connection pool tries to reuse dead connections → error
    No reconnect logic → 500 errors until process restart

  Mean time to recovery: until engineer restarts ECS tasks (if anyone is watching)

Good pattern:
  const pool = new Pool({
    host: process.env.DB_HOST,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    max: 20,
  });

  // Add error handler that reconnects on connection loss:
  pool.on('error', (err, client) => {
    console.error('Unexpected error on idle client', err);
    // Pool will automatically create new connection on next query
  });

  // Use pg-pool's built-in reconnection — retry with backoff for queries
  // Most ORMs (Sequelize, Prisma, TypeORM) handle this automatically
  // Test it: use chaos engineering to verify reconnection under AZ failure
```

---

## SECTION 6 — System Design Importance

```
Context: E-commerce platform, normally 2 AZs, Black Friday traffic

Incident timeline:
────────────────────────────────────────────────────────────────────────
10:00 AM  Black Friday starts: traffic 10× normal
10:15 AM  AZ-a: NOT fully down. Power brownout → intermittent network packet loss ~5%

10:16 AM  ALB health checks: PASSING (health check endpoints fast, < 5ms, rarely hit 5% loss)
          User requests: ~5% failing (with retries, closer to 15% bad experience)

10:20 AM  Error monitoring: 500 errors UP. But not enough to page (threshold: 5%).
          Monitoring threshold too conservative for this event.

10:25 AM  Database: intermittent slow queries.
          RDS primary in AZ-a: packet loss causing query timeouts.
          App: retrying slow queries. Retry storm begins.
          DB connection pool: exhausted. All connections waiting on slow/retried queries.

10:30 AM  Connection pool: full. New requests: rejected immediately with "too many clients".
          This cascades to requests NOT going to AZ-a (even AZ-b tasks hitting same DB)

10:35 AM  Full outage. AZ-b tasks: healthy themselves, but overwhelmed DB is the bottleneck.
          System is "multi-AZ" at compute layer but single-AZ at DB layer (not fully multi-AZ)

Root cause analysis:
  1. AZ-a didn't fully fail → ALB never removed it → partial traffic failure started the cascade
  2. Connection pool had no circuit breaker → DB overload self-reinforced
  3. RDS Multi-AZ: failover requires full failure, not partial degradation
     Partial network degradation on primary: no automatic failover → manual intervention needed

Fixes implemented:
  1. Lower ALB health check thresholds: UnhealthyThresholdCount = 2, interval = 10 seconds
     → AZ-a detected as unhealthy faster on degradation, not just full failure

  2. Circuit breaker on DB connection pool:
     Max wait time for connection: 5 seconds (not infinite)
     If pool can't acquire connection in 5s: return error immediately (fail fast)
     Prevents request pileup waiting for DB

  3. Read replicas in AZ-b: read traffic offloaded from primary
     On AZ-a degradation: switch read queries to AZ-b replica (no cross-AZ read calls)

  4. Separate ALB per AZ (optional, advanced): dedicated traffic routing per AZ
     Ensures AZ-a traffic goes to AZ-a targets only → isolates blast radius
```

---

## SECTION 7 — AWS & Cloud Mapping

```
What is AZ imbalance?

  Normal: 5 ECS tasks → 2 in AZ-a, 3 in AZ-b (roughly balanced)
  After AZ failover:
    AZ-a recovers → ECS replaces 2 tasks in AZ-a → back to balanced

  But in real operations:
    Deployments: new tasks placed in AZ with most capacity
    Scale-down: tasks terminated without AZ preference
    Result: 4 tasks in AZ-a, 1 in AZ-b
    AZ-b fails → 4 tasks still running → fine
    AZ-a fails → 1 task left → overwhelmed

Fix: ECS capacity provider with AZ rebalancing
  In ECS service definition:
    "placementStrategy": [
      {"type": "spread", "field": "attribute:ecs.availability-zone"}
    ]

  This forces ECS to spread tasks evenly across AZs.
  Prevents AZ imbalance accumulation over time.

Kubernetes equivalent:
  topologySpreadConstraints:
    - maxSkew: 1
      topologyKey: topology.kubernetes.io/zone
      whenUnsatisfiable: DoNotSchedule
```

---

## SECTION 8 — Interview Preparation

**Beginner:**

**Q: What is an AWS Region and why would you choose one over another?**
**A:** An AWS Region is a geographically separate cluster of data centers (e.g., us-east-1 in Virginia, p-south-1 in Mumbai). Each is completely independent â€” a failure in one region does not affect another. Choosing a region: (1) *Latency* â€” pick the region closest to your users. If most users are in India, p-south-1 gives the lowest latency. (2) *Data residency* â€” some regulations (GDPR, India DPDP) require data to stay within a geographic boundary. (3) *Service availability* â€” not all AWS services are available in all regions (newer services launch in us-east-1 first). (4) *Cost* â€” prices vary by region (us-east-1 is usually cheapest).

**Q: What is an Availability Zone (AZ) and how is it different from a Region?**
**A:** A Region is a geographic area containing 2-6 Availability Zones. An AZ is one or more physical data centers within the region, connected by high-speed low-latency fiber. AZs within a region are physically separated (different flood plains, power grids) but close enough for synchronous replication (~1-2ms round trip). Why it matters: if you deploy to only one AZ and that data center has a power failure, your app is down. Deploy across 2-3 AZs and one can fail without affecting the others. AWS services like Multi-AZ RDS and ALB automatically use multiple AZs.

**Q: What is an AWS Edge Location and how does it relate to CloudFront?**
**A:** Edge Locations are AWS data centers (200+ worldwide) that are NOT full regions â€” they exist specifically to cache content close to end users. CloudFront (AWS CDN) uses edge locations: when a user in Bangalore requests an image, CloudFront serves it from the Mumbai or Chennai edge location (10ms away) instead of the origin server in us-east-1 (200ms away). Edge locations cache static content (images, CSS, JS) so the origin only gets requests for fresh content. Route 53 DNS also uses edge locations for low-latency DNS resolution worldwide.

---

**Intermediate:**

**Q: What is the AWS Shared Responsibility Model and what are you responsible for vs AWS?**
**A:** AWS is responsible for security "of" the cloud (physical hardware, hypervisors, global network, data center physical security). You are responsible for security "in" the cloud: your OS patches (if EC2), your application code security, your IAM configuration (who has access), your data encryption, your security group rules, your network ACL rules. Common confusion: "AWS manages EC2 security." No â€” AWS manages the physical host. YOU manage the OS on that EC2, install patches, configure the firewall (security groups). For managed services (RDS, Lambda): AWS manages more (OS, patching), but you still manage access control and encryption settings.

**Q: What is AWS Availability Zone affinity and why does it matter for cost and performance?**
**A:** Data transferred WITHIN the same AZ is free. Data transferred BETWEEN AZs in the same region costs .01/GB each way. Between regions: .02-0.08/GB. This matters significantly at scale. Example: ECS task in us-east-1a calling RDS in us-east-1b = cross-AZ data transfer charges. Fix: ensure your ECS tasks and RDS are in the same AZ for hot read paths (use RDS in same AZ as ECS for read replicas). For HA: accept cross-AZ cost but optimize by: minimizing payload sizes, using batch APIs, caching frequently accessed data.

**Q: What is a Local Zone and AWS Outposts, and when would a developer care about them?**
**A:** *Local Zone:* AWS infrastructure placed in a major metro area outside a full Region (e.g., Los Angeles, Dallas). For applications needing < 10ms latency to a specific city. Subset of AWS services. *Outposts:* AWS-managed hardware racks physically installed in YOUR data center â€” runs AWS APIs on-premises. For: data that legally cannot leave your building, legacy systems that need cloud APIs, ultra-low latency to on-prem systems. Most developers never need these. They matter for: financial trading (Local Zones for HFT), healthcare with strict data residency (Outposts), or government with classified data requirements.

---

**Advanced (System Design):**

**Scenario 1:** Design a multi-region active-passive architecture for a SaaS application that requires 99.99% uptime. Primary region is us-east-1, failover region is eu-west-1. Describe the infrastructure setup and failover process, including RTO and achievable RPO.

*Active-passive setup:*
*us-east-1 (active):* ALB â†’ ECS Fargate tasks â†’ RDS Multi-AZ PostgreSQL. S3 buckets with cross-region replication to eu-west-1. Route 53 with health checks on ALB.
*eu-west-1 (passive):* ECS service stopped (0 desired tasks). RDS Read Replica of us-east-1 primary. ECR images replicated. S3 replica bucket.
*Route 53:* Primary record â†’ us-east-1 ALB with health check. Failover record â†’ eu-west-1 ALB (only served when primary health check fails).
*Failover process:* Route 53 detects us-east-1 health check failure â†’ switches DNS to eu-west-1 (60s). Runbook triggers: (1) promote RDS read replica to primary (5 min), (2) scale ECS tasks to desired count in eu-west-1 (2 min), (3) verify smoke tests. *RTO:* ~10 minutes (with automation). *RPO:* < 1 minute (RDS replication lag typically < 60s).

**Scenario 2:** Your company is expanding from US-only to serving users in India and Europe. Current architecture is in us-east-1. Users in India report 600ms+ API response times. Design a latency optimization strategy using AWS global infrastructure without duplicating the entire backend.

*Strategy â€” Read optimization with single write region:*
(1) *Static assets:* CloudFront distribution with edge caching â€” images, JS, CSS served from nearest edge location. Reduces static asset latency from 200ms to < 30ms globally.
(2) *API responses (cacheable):* CloudFront in front of the API with cache-control headers for GET endpoints (product catalog, public content).
(3) *Database reads:* RDS Read Replicas in p-south-1 (India) and eu-west-1 (Europe). Route read queries to regional replica via application-level read/write splitting.
(4) *Non-cacheable API calls:* Route 53 latency-based routing â†’ API deployed in all 3 regions (us-east-1, ap-south-1, eu-west-1). All regions connect to us-east-1 primary RDS for writes (acceptable: writes are < 5% of traffic).
(5) *Result:* Indian users: ~50ms (ap-south-1 local replica reads) vs 600ms (us-east-1 reads). Writes: ~180ms round-trip to us-east-1 (acceptable).

