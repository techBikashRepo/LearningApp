# Load Balancers — Part 2 of 3

### Topic: Real World Examples, System Design Importance, AWS Mapping & Interview Prep

**Series:** Scalability & Performance → Topic 04

---

## SECTION 5 — Real World Example

### Complete Observed Journey: HTTPS Request Through ALB

```
────────────────────────────────────────────────────────────────────────────
REQUEST: GET /api/v1/orders?status=pending
         Host: api.example.com
         Authorization: Bearer <jwt>
────────────────────────────────────────────────────────────────────────────

STEP 1: DNS Resolution
  Client: DNS lookup for api.example.com
  Route 53 returns: CNAME → ALB DNS name (myalb-123.us-east-1.elb.amazonaws.com)
  DNS returns ALB IP addresses (multiple, for ALB endpoint HA).

STEP 2: TCP + TLS Connection
  Client establishes TCP connection to ALB IP.
  TLS Handshake:
    ALB presents certificate for *.example.com (stored in ACM).
    Client verifies certificate chain → trusts ALB.
    Session: TLS 1.3 established.
    ⚡ TLS session resumption (if client reconnects within 24h):
       skips full handshake → saves ~50ms.

STEP 3: HTTP Request Received by ALB
  ALB reads HTTP headers:
    Host: api.example.com → matches rule
    Path: /api/v1/orders  → matches rule 2 (/api/*)
    No AWSALB cookie → no sticky session.
    Authorization header → not acted on by ALB (passed through to backend)
                           unless OIDC auth is configured.

  WAF evaluation (if configured):
    Check: is Authorization header suspicious? SQL injection in query string?
    Pass → proceed.

  Target Group selected: "API Servers"
  Algorithm: Least Outstanding Requests (LOR) — AWS's default since 2019.
  Current connections: API-01 (45 req in-flight), API-02 (52 req), API-03 (41 req).
  → Selects API-03.

STEP 4: Backend Connection
  ALB → HTTP/1.1 (or HTTP/2) connection to API-03.
  Uses connection pool (keep-alive — ALB reuses existing TCP connections to backends).
  Adds headers:
    X-Forwarded-For: <client IP>
    X-Forwarded-Proto: https
    X-Forwarded-Port: 443
  Forwards full request.

STEP 5: Backend Processes
  API-03 receives:
    GET /api/v1/orders?status=pending
    Authorization: Bearer <jwt>
    X-Forwarded-For: 203.0.113.42

  Processes: validate JWT → query DB → return orders.

STEP 6: Response Path
  API-03 → HTTP 200 response → ALB.
  ALB records:
    Target response time: 42ms
    HTTP status: 200
    Bytes: 4,200
  ALB → TLS encrypted response → Client.

STEP 7: ALB Access Log entry
  time="2024-01-01T09:15:30Z"
  type="https"
  client:port="203.0.113.42:54321"
  target:port="10.0.1.15:8080"   (API-03 private IP)
  request_processing_time=0.001   (ALB routing: 1ms)
  target_processing_time=0.042    (backend: 42ms)
  response_processing_time=0.000  (ALB response: 0ms)
  target_status_code=200
  received_bytes=298
  sent_bytes=4200
  request="GET https://api.example.com/api/v1/orders?status=pending HTTP/1.1"
  actions_executed="waf,forward"
```

---

### Health Check Lifecycle

```
HEALTH CHECK CYCLE:
  Every 30 seconds:
    ALB → GET /health → each target

  Response expected:
    HTTP 200, body can be anything
    Timeout: must respond within 5 seconds

  Decision logic:
    Current state: HEALTHY
      Got 200: stays HEALTHY
      Got timeout/5xx: counter++
      5 consecutive failures: → UNHEALTHY

    Current state: UNHEALTHY
      Got 200: counter++
      3 consecutive successes: → HEALTHY
      Traffic resumed immediately on 3rd success.

  /health endpoint best practice — deep health check:

    app.get('/health', async (req, res) => {
      try {
        await redis.ping();              // Redis reachable?
        await db.raw('SELECT 1');        // DB reachable?
        res.json({ status: 'ok',
                   redis: 'ok',
                   db: 'ok',
                   uptime: process.uptime() });
      } catch(err) {
        res.status(503).json({ status: 'unhealthy', error: err.message });
      }
    });

    SURFACE REAL FAILURES:
    If your /health returns 200 even when DB is down → ALB keeps sending
    requests to a server that can't process them → every backend request
    fails → your 5XX rate spikes even though "everything is healthy" per ALB.

    A meaningful health check catches this. A trivial 200 health check doesn't.
```

---

## SECTION 6 — System Design Importance

### Failure Mode 1: Health Check Not Catching Real Failures

```
SCENARIO: DB primary failover during an RDS maintenance window.

  11PM: RDS failover begins. Primary replaced by standby.
  11PM: 30-60 seconds where both old and new primaries are transitioning.

  11PM: App servers lose DB connection. All DB queries fail.
  App servers: still returning HTTP 200 to /health (trivial health check).
  ALB: "All servers healthy." Continues routing all traffic.

  11PM–11:01PM: ALL requests to DB fail. 100% of API calls return 500.
  ALB has no idea. "Healthy hosts: 3. All good."

  Users: "The app is broken."
  Dashboards: ALB HTTPCode_Target_5XX:  100%
              ALB HealthyHostCount:     3 (shows as healthy!)

  FIX: Deep health checks. If DB unreachable → return HTTP 503.
  ALB would have removed all instances (all unhealthy due to DB).
  This triggers an alert. On-call engineer investigates.
  Better: surface the DB failure rather than silently failing 100% of requests.
```

---

### Failure Mode 2: Connection Draining Misconfiguration

```
CASE A: Drain timeout too SHORT (e.g., 5s):

  Scale-in event: Server 2 marked for termination.
  ALB begins connection draining. 5-second window.

  In-flight long requests (PDF generation: takes 30s):
    User submitted report at 11:59:55.
    Server terminates at 12:00:00 (5s drain expired).
    Request at second 5: Connection reset. HTTP 502 to user.
    "Your report generation failed."

  FIX: Set deregistration_delay = max(p99_request_duration × 2, 30s).
  If P99 request is 8 seconds: set drain to 30 seconds minimum.
  Review your access logs for actual request durations.

CASE B: Drain timeout too LONG (e.g., 300s default):

  Scale-in event: 5 servers terminating (traffic spike subsided).
  Each one: 300s drain.
  ALL 5: start draining simultaneously.

  Duration: 300 seconds (5 minutes) of limbo.
  Auto-scaling is effectively frozen for 5 minutes.
  If another spike comes: new servers can't be added fast enough.
  The auto-scaling policy triggers: "add 5 more" but 5 are still draining.

  FIX: Tune drain time to ACTUAL typical request duration.
  Most APIs: drain = 30 seconds. Not 300.
```

---

### Failure Mode 3: The Thundering Herd on Recovery

```
SCENARIO: All 3 servers fail health checks simultaneously.
(Cascading bug in new deployment — all 3 servers OOM within 30 seconds.)

ALB: no healthy targets. Returns HTTP 503 to all requests.
Duration: 90 seconds while servers restart.

RECOVERY:
  Servers restart. All 3 pass health checks within 10 seconds of each other.
  ALB: marks all 3 healthy. Begins routing.

  PROBLEM: 90 seconds of backlogged traffic.
  Upstream services were retrying (exponential backoff — they still retry).
  Users were retrying (300K retries queued up).

  The moment ALB marks servers healthy: 300K requests arrive simultaneously.
  180 seconds worth of traffic hits 3 servers in 2 seconds.
  Servers OOM again. All 3 fail. Loop.

  THUNDERING HERD: the traffic that accumulated during an outage
  hitting your system all at once when it recovers — causing another failure.

  MITIGATIONS:
  1. Client-side exponential backoff with jitter
     (space out retries to prevent synchronized re-arrival)
  2. ALB slow start mode: newly healthy instances receive a ramping % of traffic
     (AWS ALB does not have built-in slow start; implement at ASG launch hook level)
  3. Rate limiting at ALB level (WAF rate rules: cap inflow during recovery)
  4. Circuit breaker upstream: don't accumulate 300K retries — fail fast,
     surface the error to the user, let them retry manually one at a time.
```

---

## SECTION 7 — AWS & Cloud Mapping

### Ownership Model at Scale

```
WHO OWNS THE LOAD BALANCER AS THE ORG SCALES:

STARTUP (< 20 engineers):
  One team owns everything. ALB config in Terraform.
  One team changes it when a new service is added.
  Bottleneck: any new routing rule requires that one team.

MID-SIZE (20-100 engineers):
  Platform/Infrastructure team owns ALB, Target Groups, Listener Rules.
  Product teams request routing changes via PR.

  Workflow:
  Product team: "We need /api/v2/payments/* to route to our new Payments service."
  Platform team: reviews, approves, merges.

  PROBLEM: Platform team becomes a bottleneck.
  Backlog of routing rule PRs. Product teams blocked on deployments.

LARGE ORG (100+ engineers, microservices):
  Move to self-service routing via Service Mesh or API Gateway.

  API Gateway (e.g., AWS API Gateway, Kong, Nginx Plus):
    Product teams configure their own routes via config files.
    Platform team owns the API Gateway itself, not individual routes.
    Product teams own their service's routing config.

  Service Mesh (e.g., Istio, AWS App Mesh):
    East-west traffic (service-to-service): routed via mesh, not ALB.
    ALB handles north-south only (external users → internal services).
    Each team declares their service's traffic policies via CRDs.
    Platform team maintains the mesh control plane.
    Product teams configure routing independently.

  KEY INSIGHT: As the engineering org scales, the load balancer model
  transitions from "single shared ALB" to "API Gateway + Service Mesh."
  The ALB remains as the external entry point but internal routing moves out.
```

---

## SECTION 8 — Interview Preparation

**Beginner:**

**Q: What is a load balancer and why do we need one?**
**A:** A load balancer is like a host at a restaurant who directs you to an available table. Without it, all customers would rush to the same table. The host knows which tables are free and distributes customers evenly. In tech: users all hit one IP address (the load balancer), which routes each request to one of several servers so no single server gets overwhelmed.

**Q: What happens if a server behind the load balancer crashes?**
**A:** The load balancer runs health checks every few seconds (e.g., GET /health). If a server doesn't respond or returns an error, the load balancer marks it as unhealthy and stops sending it traffic. Users never see the failed server â€” they just get routed to the healthy ones. This is how you achieve high availability.

**Q: What's the difference between the different load balancing algorithms?**
**A:** *Round-robin:* rotates through servers in order (1, 2, 3, 1, 2, 3...). Simple but ignores server load. *Least connections:* sends to the server with the fewest active connections â€” best for long-running requests. *IP hash:* routes the same IP to the same server consistently (useful for stateful apps). Most teams use least-connections for web apps.

---

**Intermediate:**

**Q: What is the difference between ALB (Layer 7) and NLB (Layer 4) in AWS?**
**A:** ALB (Application Load Balancer) operates at HTTP/HTTPS layer â€” it can read the URL path, HTTP headers, and hostname to make routing decisions (e.g., /api/* â†’ backend servers, /static/* â†’ S3). Supports path-based routing, host-based routing, WebSockets, sticky sessions, and WAF integration. NLB (Network Load Balancer) operates at TCP/UDP layer â€” it doesn't understand HTTP but handles millions of connections with sub-millisecond latency. Use ALB for web apps; NLB for high-performance TCP (databases, gaming, real-time streaming).

**Q: What is connection draining (deregistration delay) and why is it important during deployments?**
**A:** When you remove a server from the load balancer pool (for deployment or auto-scaling scale-in), connection draining tells the load balancer to stop sending *new* requests to that server but to let *existing* requests finish. Default: 300 seconds. Without draining, in-flight requests get cut off mid-execution â€” users see errors. For APIs with short request times (<1s), set draining to 30s. For long-running jobs, increase it.

**Q: Your ALB shows 502 Bad Gateway errors. What are the likely causes and how do you debug?**
**A:** 502 means the ALB reached the backend server but the backend returned an invalid response (or no response). Causes: (1) App server crashed â€” check EC2/ECS logs. (2) App process listening on wrong port â€” verify security group + app config. (3) Keep-alive timeout mismatch: if ALB's idle timeout (60s) is higher than the app's keep-alive timeout, the app closes the connection first, causing a 502. Fix: increase app keep-alive to 75s (Express: server.keepAliveTimeout = 75000). (4) Memory pressure causing slow responses that time out.

---

**Advanced (System Design):**

**Scenario 1:** Design the load balancing architecture for a SaaS platform with three distinct workload types: (a) REST API calls (milliseconds), (b) file upload/processing (minutes), (c) WebSocket connections (hours-long). Each has different scaling and routing requirements.

*REST API:* ALB with path-based routing (/api/*), target group of stateless EC2/ECS. Scale on P99 latency.
*File uploads:* Dedicated ALB target group with longer idle timeout (600s). Upload goes to S3 directly via pre-signed URL (bypass server entirely). Post-upload processing via SQS + worker fleet.
*WebSockets:* ALB with sticky sessions enabled, or AWS API Gateway WebSocket API. Redis pub/sub for cross-server message delivery.

**Scenario 2:** Your load balancer is routing requests to 10 servers equally, but 2 of them are consistently returning 500 errors (they have a bad app deployment). The other 8 are healthy. How does the ALB handle this automatically, and what monitoring would you set up to catch this before users notice?

*ALB behavior:* Health checks detect unhealthy targets and remove them. With default health check settings (30s interval, 3 failures = unhealthy), it takes 90 seconds for a bad server to be removed â€” during which ~20% of traffic hits bad servers.
*Better monitoring:* Set up ALB HTTPCode_Target_5XX_Count CloudWatch alarm. Set health check interval to 10s, unhealthy threshold to 2 (20s to detect bad server). Use blue/green deployment to prevent sending traffic to newly-deployed bad instances until health checks pass.

