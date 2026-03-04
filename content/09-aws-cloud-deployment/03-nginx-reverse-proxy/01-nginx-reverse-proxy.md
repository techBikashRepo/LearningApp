# Nginx Reverse Proxy

## FILE 01 OF 03 — Physical Infrastructure Replaced, Architecture Position & Core Concepts

> **Architect Training Mode** | Senior Principal Architect Perspective
> _Optimized for: design judgement · tradeoff evaluation · failure prediction · production debugging_

---

## SECTION 1 — Intuition (Explain Like a 12-Year-Old)

### Before Nginx: Hardware Load Balancers and Apache

In enterprise data centers (pre-2005), the standard configuration was:

**Hardware Load Balancers:**

- F5 BIG-IP or Citrix NetScaler appliances: $20,000–$100,000+ per unit
- Two required (active/passive HA pair): $40,000–$200,000
- Purpose: distribute traffic from one public IP across a farm of application servers
- SSL termination done on hardware (SSL accelerator cards)
- Configuration: GUI-based, not version-controlled, only network engineers could modify

**Apache httpd as proxy:**

- `mod_proxy` module for reverse proxying
- Process-based architecture (fork a new OS process per connection)
- At 10,000 concurrent connections: 10,000 processes × ~10MB per Apache process = 100GB RAM
- This was the "C10K problem" (how to handle 10,000 concurrent connections) — Apache could not

**Nginx (2002, Nginx Inc., 2011)** replaced both:

- Single-process, event-driven (async I/O): handles 10,000 connections on ~10MB RAM
- Free and open source (Nginx Plus for commercial)
- Config in version-controlled text files
- Runs on a $5/month VPS vs $50,000+ hardware
- The 10,000 concurrent connection problem: **solved by architecture, not hardware spend**

**What Nginx also replaced:**
| Old Hardware/Software | Nginx Replacement Feature |
|---|---|
| F5 BIG-IP load balancer | `upstream` block + `least_conn` / `round_robin` |
| Hardware SSL terminator | `ssl` + `ssl_certificate` in server block |
| Web Application Firewall (basic) | `limit_req_zone` rate limiting |
| Apache `mod_proxy` | `proxy_pass` directive |
| Static file CDN (origin pulls) | Nginx serving static files with `try_files` |
| Varnish cache | `proxy_cache` directive |

---

## SECTION 2 — Core Technical Explanation

### The Three Positions Where Nginx Operates

```
POSITION 1: EDGE NGINX (public-facing, typical for small/medium systems)
─────────────────────────────────────────────────────────────────────────
            Internet
               │
               ▼
         [Nginx on EC2]          ← Public subnet, public IP, port 80/443
          reverse proxy
          SSL termination
               │
        ┌──────┴──────────┐
        ▼                 ▼
  [Node.js :3000]  [Node.js :3001]   ← Private subnet, no public IPs
                                         API application instances

POSITION 2: NGINX BEHIND ALB (AWS production pattern)
─────────────────────────────────────────────────────────────────────────
            Internet
               │
               ▼
     [AWS ALB / CloudFront]      ← AWS manages DDoS, health checks, SSL via ACM
               │
               ▼
         [Nginx on EC2]          ← Private subnet, handles routing, headers, caching
          routing logic
          request manipulation
               │
        ┌──────┴──────────┐
        ▼                 ▼
  [App server A]   [App server B]    ← Private subnet

POSITION 3: NGINX AS API GATEWAY SIDECAR (microservices)
─────────────────────────────────────────────────────────────────────────
   [ALB]
     │
     ▼
   [Nginx] ← acts as service mesh entry (with OpenResty/Lua for logic)
     │
     ├──→ /api/users     → user-service:3000
     ├──→ /api/products  → product-service:3001
     ├──→ /api/payments  → payment-service:3002
     └──→ /              → frontend:80

Position in OSI model: Layer 7 (Application layer)
  Nginx reads HTTP headers, paths, host names → makes routing decisions
  Not just Layer 4 (TCP/IP) like ELB Classic
```

---

## SECTION 3 — Architecture Diagram (MANDATORY)

```
CLIENT REQUEST LIFECYCLE THROUGH NGINX REVERSE PROXY
══════════════════════════════════════════════════════════════════════

Browser                  Nginx                      Node.js Backend
   │
   │  GET /api/users HTTP/1.1
   │  Host: api.myapp.com
   │  Authorization: Bearer eyJ...
   │─────────────────────────────────────────►
   │                  │
   │                  │ nginx.conf processing:
   │                  │
   │                  │  1. Match server_name api.myapp.com
   │                  │  2. Match location /api/
   │                  │  3. Check rate limit (limit_req)
   │                  │  4. Add proxy headers:
   │                  │     X-Real-IP: 103.12.34.56
   │                  │     X-Forwarded-For: 103.12.34.56
   │                  │     X-Forwarded-Proto: https
   │                  │     Host: api.myapp.com
   │                  │  5. Select upstream server
   │                  │     (round-robin or least_conn)
   │                  │  6. proxy_pass to backend
   │                  │────────────────────────────────►
   │                  │                                   │
   │                  │                                   │ Express.js sees:
   │                  │                                   │ req.ip = Nginx IP
   │                  │                                   │ req.headers['x-real-ip']
   │                  │                                   │    = 103.12.34.56 (real IP)
   │                  │◄────────────────────────────────  │
   │                  │  HTTP/1.1 200 OK                  │
   │                  │  {"users": [...]}                 │
   │                  │
   │                  │  Nginx can:
   │                  │  - Add response headers
   │                  │  - Strip internal headers
   │                  │  - Cache response (proxy_cache)
   │                  │  - Modify response body (sub_filter)
   │◄─────────────────│
   │  HTTP/1.1 200 OK
   │  {"users": [...]}
```

---

## SECTION 4 — Request Flow (MANDATORY FLOWCHART)

```nginx
# /etc/nginx/nginx.conf

# Number of worker processes (usually = number of CPU cores)
worker_processes auto;

# Max connections per worker (tune based on ulimit -n)
events {
    worker_connections 1024;  # 1024 × auto workers = total capacity
    use epoll;                 # Linux async I/O (vs select/poll)
}

http {
    # ─────────────────────────────────────────────────────────────
    # UPSTREAM BLOCK — your backend servers
    # ─────────────────────────────────────────────────────────────
    upstream backend {
        least_conn;                        # algorithm: least active connections
        # round_robin;                    # default: rotate through servers
        # ip_hash;                        # sticky sessions: same IP → same server
        # hash $request_uri consistent;  # consistent hash by URL (for caching)

        server 10.0.1.10:3000 weight=3;   # send 3x more traffic here
        server 10.0.1.11:3000 weight=1;
        server 10.0.1.12:3000 backup;     # only used if others are down

        keepalive 32;   # maintain 32 persistent connections to backend (critical for perf)
    }

    # ─────────────────────────────────────────────────────────────
    # RATE LIMITING — prevent abuse
    # ─────────────────────────────────────────────────────────────
    # Define zone: 10m RAM = ~160,000 IP tracking
    limit_req_zone $binary_remote_addr zone=api_limit:10m rate=100r/m;
    limit_req_zone $binary_remote_addr zone=login_limit:1m  rate=5r/m;

    # ─────────────────────────────────────────────────────────────
    # PROXY CACHE (optional, if you cache API responses)
    # ─────────────────────────────────────────────────────────────
    proxy_cache_path /var/cache/nginx levels=1:2 keys_zone=api_cache:10m
                     max_size=1g inactive=60m use_temp_path=off;

    # ─────────────────────────────────────────────────────────────
    # SERVER BLOCK — virtual host (one per domain)
    # ─────────────────────────────────────────────────────────────
    server {
        listen 80;
        server_name api.myapp.com;

        # Redirect HTTP → HTTPS
        return 301 https://$server_name$request_uri;
    }

    server {
        listen 443 ssl http2;
        server_name api.myapp.com;

        # SSL configuration (see HTTPS file for full details)
        ssl_certificate     /etc/ssl/certs/myapp.crt;
        ssl_certificate_key /etc/ssl/private/myapp.key;
        ssl_protocols       TLSv1.2 TLSv1.3;
        ssl_ciphers         HIGH:!aNULL:!MD5;

        # ─────────────────────────────────────────────────────────
        # LOCATION BLOCKS — routing by URL path
        # ─────────────────────────────────────────────────────────

        # Exact match: /health endpoint, no rate limiting, no auth logging
        location = /health {
            access_log off;
            proxy_pass http://backend;
        }

        # Auth endpoints: strict rate limiting (5 req/min per IP)
        location /auth/ {
            limit_req zone=login_limit burst=3 nodelay;
            limit_req_status 429;
            proxy_pass http://backend;
        }

        # API: general rate limiting (100 req/min per IP)
        location /api/ {
            limit_req zone=api_limit burst=20 nodelay;

            # Headers Nginx adds so backend knows real client info
            proxy_set_header Host              $host;
            proxy_set_header X-Real-IP         $remote_addr;
            proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;

            # Timeouts (tune per your backend's response time)
            proxy_connect_timeout 5s;    # time to connect to backend: fail fast
            proxy_send_timeout    60s;   # time to send request to backend
            proxy_read_timeout    60s;   # time waiting for backend response

            # Enable HTTP/1.1 to backend (required for keepalive)
            proxy_http_version 1.1;
            proxy_set_header Connection "";

            proxy_pass http://backend;
        }

        # Static files: served directly by Nginx (never hits Node.js)
        location /static/ {
            root /var/www;
            expires 1y;
            add_header Cache-Control "public, immutable";
            access_log off;
        }
    }
}
```

---

### Security Headers Nginx Should Add

```nginx
# Add to server block or http block:

# Prevent clickjacking (don't allow iframe embedding)
add_header X-Frame-Options "SAMEORIGIN" always;

# XSS protection
add_header X-XSS-Protection "1; mode=block" always;

# Prevent MIME type sniffing
add_header X-Content-Type-Options "nosniff" always;

# Force HTTPS (HSTS) — 1 year, include subdomains
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

# Control what browser sends in Referer header
add_header Referrer-Policy "strict-origin-when-cross-origin" always;

# Content Security Policy (strict example)
add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:;" always;

# Hide Nginx version (security by obscurity — minimal but standard)
server_tokens off;

# Remove backend's Server header (hide that you're using Node.js/Express)
proxy_hide_header X-Powered-By;
proxy_hide_header Server;
```

---

### WebSocket Proxying

Nginx by default doesn't proxy WebSocket connections correctly.
HTTP/1.0 → WebSocket upgrade sequence requires special handling:

```nginx
# Wrong (default HTTP/1.0 proxy, WebSockets fail):
location /ws/ {
    proxy_pass http://backend;
}

# Right — upgrade headers required:
location /ws/ {
    proxy_pass http://backend;
    proxy_http_version 1.1;
    proxy_set_header Upgrade    $http_upgrade;    # send Upgrade: websocket
    proxy_set_header Connection "upgrade";         # Connection: Upgrade header
    proxy_read_timeout 3600s;  # WebSockets are long-lived; default 60s kills them
}
```

---

## KEY TAKEAWAYS — FILE 01

- Nginx replaced $50,000+ F5 hardware load balancers with a $5/mo VPS running open-source software. The architecture difference: event-driven vs process-per-connection.
- Nginx operates at Layer 7 — it reads HTTP headers and routes by them. This enables: virtual hosts (multiple domains one IP), path-based routing, header injection, SSL termination.
- **Proxy headers are critical.** Without `X-Real-IP` and `X-Forwarded-For`, your backend sees only the Nginx server IP as the client IP — rate limiting, geolocation, and audit logs are wrong.
- **keepalive to backend is critical for performance.** `keepalive 32` in upstream block reuses connections. Without it, every proxied request creates a new TCP connection to the backend — expensive.
- WebSocket proxying requires explicit `Upgrade` headers and a long `proxy_read_timeout`. Default config silently kills WebSocket connections after 60 seconds.

---

_Continue to File 02 → Failure modes, 502/504 errors, buffer overflows, debugging & production incidents_
