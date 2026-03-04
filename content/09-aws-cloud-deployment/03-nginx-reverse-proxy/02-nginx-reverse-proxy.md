# Nginx Reverse Proxy

## FILE 02 OF 03 — Failure Modes, 502/504 Errors, Production Incidents & Debugging

> **Architect Training Mode** | Senior Principal Architect Perspective
> _Optimized for: design judgement · tradeoff evaluation · failure prediction · production debugging_

---

## SECTION 5 — Real World Example

### Understanding Which Error Number Means What

```
From CLIENT's perspective (what HTTP status code they receive):

400 Bad Request
  Nginx sent this — malformed request (oversized headers, invalid URI)
  Most common cause: request headers exceed client_header_buffer_size

413 Payload Too Large
  Client tried to upload a file larger than client_max_body_size (default: 1MB!)
  Very common gotcha: file upload fails with 413 because Nginx blocks before backend

429 Too Many Requests
  limit_req_zone rate limit exceeded
  Your custom rate limiting is working

502 Bad Gateway
  Nginx received an invalid or empty response from the BACKEND
  Nginx is alive. Backend is the problem.
  Causes: backend process crashed, backend returned invalid HTTP,
          backend connection refused (not running on that port)

503 Service Unavailable
  All upstream servers have failed health checks
  Nginx has no healthy backend to send to
  (Can also be your limit_req returning this — check config)

504 Gateway Timeout
  Nginx connected to backend, but backend took longer than proxy_read_timeout
  Nginx gave up waiting. Backend is alive but SLOW.
  Causes: long-running database query, external API call blocking backend,
          memory pressure causing swapping (slow backend)

499 Client Closed Request (Nginx custom code, not standard HTTP)
  Client disconnected before Nginx/backend could respond
  Common cause: mobile browser navigating away, user refreshing during load
  High 499 rate = your responses are too slow (users giving up)
  Not an error in Nginx or backend — but signals performance problem
```

---

## SECTION 6 — System Design Importance

### The 5-Step 502 Debugging Tree

```
502 Bad Gateway received
         │
         ▼ Step 1: Is backend process running?

  curl http://127.0.0.1:3000/health    ← test backend directly, bypass Nginx

  ├── Connection refused → backend NOT running on port 3000
  │     Action: systemctl status node-app / docker ps / ECS task status
  │             Check application startup logs for crash
  │
  └── 200 OK → backend IS running
        │
        ▼ Step 2: Check Nginx error log

  tail -f /var/log/nginx/error.log

  Common error lines and their meaning:
  ──────────────────────────────────────────────────────────────────
  "connect() failed (111: refused) while connecting to upstream"
    → Nginx cannot reach backend at address in proxy_pass
    → Check: correct IP:port in upstream block?
    →        Is backend listening on 0.0.0.0 or 127.0.0.1? (127.0.0.1 not visible to Nginx if on different machine)

  "upstream sent invalid header while reading response header from upstream"
    → Backend returned non-HTTP response (application crashed mid-response, or returned garbage)
    → Or: backend is HTTP/2 but upstream is configured for HTTP/1.1

  "no live upstreams while connecting to upstream"
    → All servers in upstream block have failed passive health checks
    → Check backend logs for why all of them failed

  "SSL_do_handshake() failed while SSL handshaking to upstream"
    → proxy_pass https://... but backend SSL cert is invalid or expired
    → If backend is internal, use: proxy_ssl_verify off; (or add backend's CA cert)
  ──────────────────────────────────────────────────────────────────

        ▼ Step 3: Test Nginx → Backend path directly

  # On Nginx server: can it reach backend?
  curl -v http://10.0.1.10:3000/health

  # Security group check (AWS): does Nginx server's security group allow
  # outbound to backend's security group on port 3000?

        ▼ Step 4: Check upstream block matches actual backend address

  nginx -T | grep upstream    ← dump compiled Nginx config

  ├── upstream has wrong IP? → update nginx.conf + nginx -s reload
  └── upstream has correct IP?
        │
        ▼ Step 5: Is backend returning valid HTTP?

  # Capture actual backend response:
  curl -v --raw http://10.0.1.10:3000/api/users 2>&1 | head -50

  ├── Response starts with "HTTP/1.1 200" → valid HTTP, Nginx config issue
  └── Response starts with binary/garbage → application code is broken
        must return valid HTTP (even for errors)
```

---

## SECTION 7 — AWS & Cloud Mapping

### When Backend Is Alive But Slow

```
504 = Nginx's proxy_read_timeout expired before backend responded

Default timeouts in Nginx:
  proxy_connect_timeout  60s;    ← time to establish TCP connection to backend
  proxy_send_timeout     60s;    ← time for Nginx to send request to backend
  proxy_read_timeout     60s;    ← time to wait for backend to START responding

Common scenario causing 504:
  User triggers a report generation: SELECT with multiple JOINs across 10M rows
  Query takes 90 seconds
  Nginx proxy_read_timeout = 60 seconds
  At 60s: Nginx sends 504 to client
  At 90s: backend finishes query → sends response → nobody is listening → wasted work

Solutions:
  ──────────────────────────────────────────────────────────────────
  Option A: Increase proxy_read_timeout for that specific endpoint
    location /api/reports/ {
        proxy_read_timeout 300s;   # 5 minutes for reports
        proxy_pass http://backend;
    }

  Option B: Make the endpoint async (better architecture)
    POST /api/reports → returns 202 Accepted + job_id immediately
    GET /api/reports/{job_id} → returns report status / result when done

    User polls for result OR frontend uses WebSocket for completion notification
    Nginx 504 is no longer possible (first request returns in < 1 second)

  Option C: Investigate backend performance
    Is the 90-second query necessary?
    Add index? Add pagination? Cache result?
    Use EXPLAIN ANALYZE to find slow query
  ──────────────────────────────────────────────────────────────────

Server-Sent Events (SSE) / Streaming responses and 504:
  If backend streams a response (sends data over time), Nginx needs:
    proxy_read_timeout must cover TOTAL stream duration
    proxy_buffering off;   ← critical for streaming! Otherwise Nginx buffers entire response
                               before sending to client, defeating streaming purpose

    location /stream/ {
        proxy_pass http://backend;
        proxy_buffering off;
        proxy_read_timeout 3600s;
    }
```

---

## SECTION 8 — Interview Preparation

**Beginner:**

**Q: What is a reverse proxy and why do we use Nginx as one?**
**A:** A reverse proxy sits in front of your application server and forwards requests to it. Nginx handles the boring infrastructure work: SSL termination (decrypts HTTPS connections before they reach your app), serving static files (no need to hit Node.js for images/CSS), rate limiting, gzip compression, and routing different URLs to different backend services. Your app server only handles business logic. Nginx handles everything else â€” faster and more efficiently.

**Q: What is the difference between a forward proxy and a reverse proxy?**
**A:** *Forward proxy* sits in front of *clients* â€” used by a corporate network to control outbound internet access (all employee requests go through the company proxy). *Reverse proxy* sits in front of *servers* â€” used by a service to control inbound traffic. Nginx is almost always used as a reverse proxy (protecting and routing to your backend servers). Think of it as: forward proxy = gateway out, reverse proxy = gateway in.

**Q: What does "upstream" mean in Nginx configuration?**
**A:** "Upstream" refers to the backend server(s) that Nginx forwards requests to. In a typical setup: Browser â†’ Nginx (port 80/443) â†’ upstream Node.js app (port 3000). The upstream block in nginx.conf defines the pool of backend servers for load balancing. Nginx is "downstream" of the internet (receives from users) and "upstream" relative to your app (forwards to it) â€” confusingly, Nginx IS the upstream definition in its config.

---

**Intermediate:**

**Q: What causes a 502 Bad Gateway error from Nginx and how do you debug it?**
**A:** 502 = Nginx reached the backend but got an invalid/no response. Most common causes: (1) Backend app crashed or not running (check systemctl status myapp or ECS task status). (2) Backend listening on wrong port â€” verify proxy_pass URL matches the actual app port. (3) Keep-alive timeout mismatch: if Nginx's proxy_read_timeout (default 60s) < time backend takes to respond, Nginx gives up and returns 502. (4) Backend threw a fatal error â€” check app logs. Debug: 
ginx -t (config test), 	ail /var/log/nginx/error.log, curl localhost:3000/health directly.

**Q: What are the critical Nginx settings to tune for a production Node.js API, and why?**
**A:** keepalive 32 in upstream block â€” enables connection reuse between Nginx and Node.js (instead of new TCP connection per request). proxy_connect_timeout 5s â€” fail fast if backend is down (don't wait 60s). proxy_read_timeout 30s â€” max time to wait for backend response. worker_processes auto â€” one worker per CPU core. worker_connections 1024 (or higher) â€” max connections per worker. client_max_body_size 10m â€” reject oversized uploads before they reach your app. Buffer settings (proxy_buffer_size, proxy_buffers) â€” prevent disk buffering for small responses.

**Q: How does Nginx rate limiting work, and how do you configure it to protect against brute-force login attacks?**
**A:** Nginx uses limit_req_zone with a shared memory zone tracking request counts per client IP (or custom key). Example: limit_req_zone  zone=login:10m rate=5r/m â€” 5 requests per minute per IP to the login endpoint. limit_req zone=login burst=3 nodelay â€” allows bursts of 3 with no initial delay, then enforces 5/min. Excess requests get 429. For brute-force: 5 login attempts/minute per IP prevents automated password attacks while not affecting real users (who rarely login more than once/minute).

---

**Advanced (System Design):**

**Scenario 1:** Design a multi-service routing setup using Nginx where a single domain pi.example.com routes to three separate backend services: /auth/* â†’ auth service (port 3001), /payments/* â†’ payment service (port 3002), /catalog/* â†’ catalog service (port 3003). Each service has 2 instances for HA. Include health-check-aware load balancing and proper timeout configuration per service.

*nginx.conf excerpt:*
`
upstream auth_servers { least_conn; keepalive 16; server 127.0.0.1:3001; server 127.0.0.1:3011; }
upstream payment_servers { least_conn; keepalive 16; server 127.0.0.1:3002; server 127.0.0.1:3012; }
upstream catalog_servers { least_conn; keepalive 16; server 127.0.0.1:3003; server 127.0.0.1:3013; }

location /auth/ {
    proxy_pass http://auth_servers/;
    proxy_read_timeout 10s;      # Auth should be fast
}
location /payments/ {
    proxy_pass http://payment_servers/;
    proxy_read_timeout 30s;      # Payments may take longer
}
location /catalog/ {
    proxy_pass http://catalog_servers/;
    proxy_cache catalog_cache;   # Cache catalog responses
    proxy_cache_valid 200 60s;
}
`
Enable Nginx health_check (Nginx Plus) or use passive health checks.

**Scenario 2:** Your Nginx server is returning 504 Gateway Timeout errors for 3% of requests during peak traffic. The backend Node.js server is responding but slowly (P99 = 28s for these requests). How do you configure Nginx and your infrastructure to eliminate the 504s?

*Root cause:* proxy_read_timeout defaults to 60s but P99 is 28s occasionally spiking above 60s.
*Fix 1:* Identify WHY those requests take 28s â€” proxy_read_timeout increase just hides the problem. Check: slow DB queries (add pg_stat_activity monitoring), N+1 ORM issues, external API calls with no timeout.
*Fix 2:* While fixing root cause â€” increase proxy_read_timeout 90s to stop 504s from fast-returning operations that occasionally spike.
*Fix 3:* Circuit breaker pattern: if a backend returns slow responses / errors repeatedly, Nginx temporarily marks it unhealthy and routes to other instances.
*Fix 4:* Add async processing for genuinely slow operations â€” return 202 Accepted immediately, process in background, poll for result.

