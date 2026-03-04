# Nginx Reverse Proxy

## FILE 03 OF 03 — AWS Comparison, Cost, Exam Traps, Scenario Exercise & Architect's Mental Model

> **Architect Training Mode** | Senior Principal Architect Perspective
> _Optimized for: design judgement · tradeoff evaluation · failure prediction · production debugging_

---

## SECTION 9 — Certification Focus (AWS SAA-C03)

```
┌────────────────────────────────────────────────────────────────────────────────────────────┐
│                         NGINX vs AWS ALB COMPARISON                                        │
├─────────────────────────┬──────────────────────────────┬───────────────────────────────────┤
│ Capability              │ Nginx (self-managed)          │ AWS ALB (managed)                 │
├─────────────────────────┼──────────────────────────────┼───────────────────────────────────┤
│ SSL/TLS termination     │ Manual cert management,       │ ACM certs (auto-renew), free with │
│                         │ Let's Encrypt auto-renew      │ ALB usage                         │
├─────────────────────────┼──────────────────────────────┼───────────────────────────────────┤
│ DDoS protection         │ rate limiting (manual)        │ AWS Shield Standard (included)    │
├─────────────────────────┼──────────────────────────────┼───────────────────────────────────┤
│ Path-based routing      │ location blocks               │ Target group rules                │
├─────────────────────────┼──────────────────────────────┼───────────────────────────────────┤
│ Host-based routing      │ server_name directive         │ Host header conditions            │
├─────────────────────────┼──────────────────────────────┼───────────────────────────────────┤
│ WebSocket support       │ Manual (see File 01)          │ Native (no config needed)         │
├─────────────────────────┼──────────────────────────────┼───────────────────────────────────┤
│ Sticky sessions         │ ip_hash in upstream           │ ALB sticky sessions (cookie)      │
├─────────────────────────┼──────────────────────────────┼───────────────────────────────────┤
│ Health checks           │ Passive only (fails + removes)│ Active + passive, configurable    │
├─────────────────────────┼──────────────────────────────┼───────────────────────────────────┤
│ Response caching        │ proxy_cache directive         │ Not built-in (use CloudFront)     │
├─────────────────────────┼──────────────────────────────┼───────────────────────────────────┤
│ Request modification    │ lua / sub_filter / headers    │ Limited (header modification)     │
├─────────────────────────┼──────────────────────────────┼───────────────────────────────────┤
│ Scaling                 │ Manual (add EC2 + ASG)        │ Automatic (managed by AWS)        │
├─────────────────────────┼──────────────────────────────┼───────────────────────────────────┤
│ Operational overhead    │ High (OS patches, config,     │ Zero (fully managed)              │
│                         │ HA setup, capacity planning)  │                                   │
├─────────────────────────┼──────────────────────────────┼───────────────────────────────────┤
│ Base cost               │ t3.small = ~$15/month         │ $16–20/month + $0.008/LCU-hour   │
├─────────────────────────┼──────────────────────────────┼───────────────────────────────────┤
│ HA cost                 │ 2× EC2 + NLB + EIP = ~$50    │ Multi-AZ included in base price   │
└─────────────────────────┴──────────────────────────────┴───────────────────────────────────┘
```

### Decision Rules

```
Use AWS ALB when:
  ✅ Team is small / SRE bandwidth is limited (managed is worth it)
  ✅ You need native ECS/EKS service discovery integration
  ✅ You're using Lambda as backend (ALB can invoke Lambda)
  ✅ You need WAF integration (AWS WAF attaches to ALB, not Nginx)
  ✅ Your service needs auto-scaling with no pre-warming
  ✅ You need gRPC or HTTP/2 to backend targets (ALB supports both)

Use Nginx when:
  ✅ You need response caching (proxy_cache) — reduces backend load significantly
  ✅ You need complex request/response transformation (body modification, Lua logic)
  ✅ You have a legacy EC2 deployment and ALB is over-engineered
  ✅ You need per-request config at millisecond granularity (custom routing logic)
  ✅ Cost: very high-traffic static content serving where ALB LCU fees accumulate
  ✅ Self-hosted Kubernetes (K3s, kubeadm) where you're deploying ingress-nginx
```

---

## SECTION 10 — Comparison Table

```
The most common production architecture — ALB for AWS integration, Nginx for app logic:

Internet
    │
    ▼
[CloudFront]                  ← CDN: static assets, geographic distribution, DDoS
    │
    ▼
[AWS ALB]                     ← SSL termination via ACM, health checks, AZ routing
    │                            Target: ECS service running Nginx containers
    ▼
[Nginx in ECS container]      ← Path routing, rate limiting, headers, caching
    │
    └──> /api/*  ──────────── [API ECS Service :3000]
    └──> /ws/*   ──────────── [WebSocket ECS Service :4000]
    └──> /       ──────────── [Frontend (Next.js SSR) :8080]

Why this pattern?
  ALB handles: SSL (ACM auto-renew), multi-AZ failover, ECS service discovery, AWS Shield
  Nginx handles: rate limiting, response caching, request header manipulation, routing complexity

  Neither alone handles both well. Combined: best of both.

ECS Task Definition for Nginx sidecar:
  Container: nginx:alpine
  Port: 80 (ALB routes here via target group)
  Env vars from SSM:
    BACKEND_UPSTREAM_HOST = api-service.myapp.internal
    RATE_LIMIT_RPS         = 100

  Nginx template (envsubst fills vars from env):
  upstream backend { server ${BACKEND_UPSTREAM_HOST}:3000; keepalive 32; }

  Build:
    FROM nginx:alpine
    COPY nginx.conf.template /etc/nginx/templates/default.conf.template
    # ENV substitution built into nginx:alpine official image
    # docker-entrypoint.sh runs envsubst at container start
```

---

## SECTION 11 — Quick Revision

```
Scenario: Production API, 50M requests/month, average response 10KB

Option A: Nginx on t3.small EC2 (single instance, no HA)
  EC2 t3.small: $15.18/month (on-demand)
  EIP: $3.65/month
  Storage (20GB): $2.00/month
  Total: ~$21/month
  Risk: single point of failure — one EC2 failure = downtime

Option B: Nginx on 2× t3.small (HA, active/passive with heartbeat)
  2× EC2: $30.36/month
  NLB for HA: $16/month base + LCU fees
  EIP: $3.65/month
  Total: ~$50-60/month
  Benefit: HA, but you manage OS, Nginx config, failover logic

Option C: AWS ALB (fully managed HA)
  ALB base: $16.20/month
  LCU pricing for 50M requests:
    Request dimension: 50M × (10KB/1KB) / 1 billion × $0.008 = $4.00
    Processing: negligible
  Total: ~$20-25/month
  Benefit: fully managed, multi-AZ, auto-scaling, no operational overhead

Option D: ALB + Nginx in ECS (combined production pattern)
  ALB: $20/month
  ECS Fargate Nginx (0.25 vCPU, 512MB, 2 tasks for HA): $10/month
  Total: ~$30/month
  Benefit: all ALB managed features + Nginx routing flexibility

Cost comparison for 50M requests/month:
  Simple setup: Nginx single EC2 ≈ $21/month (high risk)
  HA: Nginx HA ≈ $55/month (medium operational effort)
  Managed: ALB ≈ $22/month (zero ops)
  Best of both: ALB + ECS Nginx ≈ $30/month (some config)

  For most teams: ALB or ALB+Nginx ECS is cost-comparable with MUCH lower operational risk
```

---

## SECTION 12 — Architect Thinking Exercise

```
1. WHEN OPERATIONAL BURDEN EXCEEDS VALUE FOR YOUR TEAM

   Nginx on EC2 requires:
   ├── OS security patches (monthly at minimum)
   ├── Nginx security updates (nginx -v, check CVEs)
   ├── SSL certificate renewal (if not using Let's Encrypt automation)
   ├── Log rotation configuration
   ├── Capacity planning (will this EC2 size handle Black Friday traffic?)
   ├── HA setup (if you need it)
   └── Config version control and deployment pipeline for nginx.conf changes

   If your team is 3 engineers and you're shipping features: use ALB.
   Managed services let you ship product, not manage infrastructure.

2. WHEN YOU NEED AWS WAF

   AWS WAF (Web Application Firewall) attaches to:
   ✅ CloudFront
   ✅ ALB
   ✅ API Gateway

   AWS WAF does NOT attach to Nginx running on EC2

   If you need WAF (PCI compliance, OWASP protection, bot detection):
   You MUST use ALB or CloudFront as the entry point, not just Nginx

3. WHEN YOU NEED LAMBDA BACKENDS

   ALB can route to Lambda functions directly (ALB Lambda integration)
   Nginx has no concept of Lambda — it only proxies to TCP addresses

   API with Lambda functions → use ALB or API Gateway, not Nginx

4. WHEN TRAFFIC IS UNPREDICTABLE AND BURSTY

   Nginx on a fixed EC2 has fixed capacity
   t3.small handles ~5,000 RPS (rough estimate, very workload dependent)
   A viral product launch: 50,000 RPS suddenly
   Options: pre-scale EC2 (wastes money), ASG with Nginx (complex to set up)

   ALB: scales automatically. You pay for usage, not capacity.
```

---

### AWS SAA Exam Traps

### Trap 1: ALB vs Nginx for Response Caching

```
Exam question pattern:
  "Application has a product catalog API that returns the same 5,000 products
   (rarely changing). 90% of API calls return the same data. How to reduce
   backend database load?"

Trap: "Use ALB" — ALB does not cache responses
Trap: "Use ElastiCache in the API" — valid but expensive and complex

Better answer 1 (Nginx): Nginx proxy_cache
  Add Nginx reverse proxy with proxy_cache
  First request: Nginx fetches from backend, caches response for 60 seconds
  Next 1000 requests: served from Nginx cache, backend not hit
  Cache-hit rate 99% for static catalog = 99% reduction in backend DB load

Better answer 2 (CloudFront): Add CloudFront in front of ALB
  Cache at edge nodes globally
  TTL-based expiry matches catalog update frequency
  ALB (and backend) only gets uncached requests (cache misses)

Choose: if content is truly static (same for all users): CloudFront
        if content is per-user but cacheable (same user hits same data): Nginx proxy_cache
```

### Trap 2: Nginx X-Forwarded-For and Rate Limiting

```
Exam question pattern / real production trap:
  "All users are being rate limited when they're behind the same corporate NAT."

Cause: Corporate office has one public IP
       All 500 employees share one NAT gateway IP
       Nginx rate limit: limit_req_zone $binary_remote_addr zone=api:10m rate=100r/m;
       500 employees × multiple requests = corporate IP hits 100 req/min in 12 seconds
       All 500 employees get 429 Too Many Requests

Solution: Rate limit by authenticated user ID, not IP
  limit_req_zone $http_x_user_id zone=user_limit:10m rate=100r/m;

  Backend sets X-User-ID header?? No — that's not how it works.

  Correct: Nginx can't identify users (that's backend logic)
  Architecture solution: move rate limiting INTO the backend application
  where it has JWT-decoded user ID available for per-user rate limiting

OR: Use API Gateway (AWS) which does per-API-key rate limiting natively
    Each user/client has an API key → Gateway tracks per-key usage quota
```

### Trap 3: Nginx Cannot Attach WAF

```
Exam question: "Company has Nginx reverse proxy. Security team requires OWASP
               protection against SQL injection and XSS. What changes are needed?"

Wrong answer: "Configure mod_security in Nginx" — while technically possible (modsecurity
              Nginx module exists), the exam answer is always AWS-native

Correct: Add AWS ALB in front of Nginx, attach AWS WAF to ALB
         OR: Remove Nginx, use ALB directly, attach WAF
         OR: Add CloudFront, attach WAF to CloudFront distribution
```

### Trap 4: Nginx Health Checks Are Passive

```
Active health check: Load balancer periodically probes /health endpoint
                     Removes backend BEFORE a real request fails
                     ALB does this

Passive health check: Load balancer observes that a request to a backend FAILED
                     Marks backend as unavailable after N failures
                     Nginx free version does this (Nginx Plus has active health checks)

Implication:
  With Nginx (free): first 3 requests to a failed backend WILL fail (before passive detection removes it)
  With ALB: backend removed within health check interval (default 30s) before user requests fail

Exam trap: "Which configuration ensures zero failed requests to unhealthy backends?"
  Answer: ALB with health checks (active probing) + Connection draining
  Not: Nginx (passive only) — there will be brief failures while detection happens
```

---

### Scenario Design Exercise

### Scenario: Startup API Gateway with ML and Static Content

**Problem Statement:**

You're the architect for a startup with:

- React SPA frontend (static files: HTML, JS, CSS, images)
- Node.js REST API backend (ECS Fargate, 2 tasks)
- Python ML inference service (ECS Fargate, 1 task — slow, ~2s response)
- 10,000 prod users, expecting 10× growth in 6 months
- Team: 2 backend engineers, 1 DevOps part-time
- Budget: minimize cost, maximize reliability

**Design the reverse proxy and routing layer.**

**Solution:**

```
Architecture:
  CloudFront Distribution
    ├── /api/*       → ALB → Nginx (ECS) → upstream: Node.js API
    ├── /ml/*        → ALB → Nginx (ECS) → upstream: Python ML (proxy_read_timeout 30s)
    └── /*           → S3 bucket (static React SPA files)

Routing justification:
  Static files → S3 + CloudFront: zero backend load for frontend assets, global edge caching
  API → ALB + Nginx: health checks (ALB), rate limiting (Nginx), header manipulation
  ML → same path but separate upstream block:
       proxy_read_timeout 30s  (ML takes 2s, must not hit default 60s but needs buffer)
       No rate limit (or very generous one — ML is called once per user action)

Nginx config highlights:
  upstream node_api {
      server api.internal:3000;
      keepalive 32;
  }

  upstream ml_service {
      server ml.internal:5000;
      keepalive 8;   # fewer connections to expensive ML service
  }

  location /api/ {
      limit_req zone=api_limit burst=50 nodelay;
      proxy_pass http://node_api;
      proxy_read_timeout 10s;  # API should be fast
  }

  location /ml/ {
      limit_req zone=ml_limit burst=5 nodelay;   # ML is expensive, strict limit
      proxy_pass http://ml_service;
      proxy_read_timeout 30s;                    # ML needs time
      proxy_connect_timeout 5s;
  }

Scaling plan:
  Now (10K users): 1 ALB + 2 Nginx tasks on Fargate + 2 Node API tasks + 1 ML task
  6-month growth (100K users): ALB auto-scales naturally
                               Increase ECS desired count: 2→10 API tasks
                               ML: add more tasks + scale based on CPU
                               No Nginx changes needed

Cost at 10K users:
  CloudFront: ~$1-2/month (low data transfer)
  ALB: ~$18/month
  Nginx on Fargate (2× 0.25vCPU/512MB): ~$7/month
  Total reverseproxy+routing: ~$27/month ← very lean for a startup
```

---

### Interview Q&A

**Q: "What is a reverse proxy and why would you use Nginx for it?"**

Good answer: "A reverse proxy sits between clients and backends, forwarding requests on behalf of the backend. Nginx is used because its event-driven architecture handles thousands of concurrent connections with minimal memory — unlike Apache's process-per-connection model. On top of proxying, Nginx gives you SSL termination, rate limiting, static file serving, and response caching in one component that's configurable via version-controlled text files."

**Q: "What's the difference between a 502 and 504 from Nginx?"**

Good answer: "502 Bad Gateway means Nginx reached the backend but got an invalid or no response — the backend is likely crashed or returning garbage. 504 Gateway Timeout means Nginx connected but the backend took too long to respond. The fix for 502 is to fix or restart the backend; the fix for 504 is either increasing `proxy_read_timeout`, moving to async processing, or optimizing backend performance."

---

## === ARCHITECT'S MENTAL MODEL ===

### 5 Decision Rules for Nginx Reverse Proxy

1. **Nginx solves the 10,000-connection problem by architecture.** Event-driven vs process-per-connection. This is not a tuning difference — it's a fundamentally different model. Understanding this is why Nginx became the internet's default reverse proxy.

2. **Always set `keepalive` in your upstream block.** Without it, every proxied request creates a throwaway TCP connection. At any meaningful traffic level, you'll see port exhaustion masquerading as random 502 errors. `keepalive 32` or higher is non-negotiable in production.

3. **Rate limiting without `burst` is broken for real traffic.** Real users make 3-5 requests within 1-2 seconds (page loads trigger multiple API calls). Always add `burst=20 nodelay` or appropriate values. The `nodelay` prevents artificial latency for burst requests that are within the burst allowance.

4. **Nginx or ALB — it's not always either/or.** The production standard for AWS is ALB (for managed HA, ACM, auto-scaling) + Nginx in ECS (for routing logic, caching, rate limiting). Let each handle what it does best.

5. **`proxy_buffering off` for streaming.** Default buffering buffers the full response before sending to the client. For streaming (SSE, chunked JSON, file downloads), this is the wrong behavior. Add `proxy_buffering off` per location for any endpoint that streams.

### 3 Common Mistakes

1. **Restarting Nginx (`nginx -s restart`) instead of reloading (`nginx -s reload`)**. `reload` is graceful — current connections finish, workers pick up new config. `restart` drops all active connections immediately. In production, always `nginx -t` (test) then `nginx -s reload`. Never restart unless the process itself is broken.

2. **Forgetting `proxy_http_version 1.1` and `proxy_set_header Connection ""`** when using keepalive to backend. Keepalive requires HTTP/1.1. Without these two lines in the location block, Nginx negotiates HTTP/1.0 to the backend, which doesn't support keepalive — your keepalive 32 setting does nothing.

3. **Overlooking `client_max_body_size` for file uploads**. The backend can accept 50MB files. Developers test uploads, they fail, they check backend logs — nothing. Nginx silently returned 413 before the request reached the backend. Default is 1MB. Match this to your largest expected upload size, per location if needed.

### 1 Clear Interview Answer (30 Seconds)

> "Nginx is event-driven — a single worker process handles thousands of concurrent connections using kernel async I/O, versus Apache's one-process-per-connection model. In production, I use Nginx behind an AWS ALB: ALB handles managed SSL via ACM, multi-AZ health checks, and auto-scaling. Nginx handles rate limiting with `limit_req_zone`, response caching with `proxy_cache`, and WebSocket proxying with proper `Upgrade` headers. The two essential Nginx production settings that almost everyone forgets: `keepalive` in the upstream block to reuse TCP connections to the backend, and `client_max_body_size` set large enough for your uploads."

---

_End of Nginx Reverse Proxy 3-File Series_
