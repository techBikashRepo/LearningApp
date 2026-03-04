# Docker Concepts

## FILE 01 OF 03 — Core Concepts, Architecture & Production Patterns

> **Architect Training Mode** | Platform Engineer / DevOps Architect Perspective
> _Optimized for: design judgement · tradeoff evaluation · failure prediction · production debugging_

---

## SECTION 1 — Intuition (Explain Like a 12-Year-Old)

```
THE PROBLEM:
  Developer: "It works on my laptop."
  Ops engineer: "It crashes on production."

  Root cause: environment drift

  Laptop:          Node 18.12, libssl 3.0, glibc 2.35, .env.local, macOS ARM
  Staging:         Node 16.4,  libssl 1.1, glibc 2.27, injected env,  Linux x86_64
  Production:      Node 18.0,  libssl 3.0, glibc 2.31, secrets mgr,   Linux x86_64

  Result:
    Developer: app works perfectly
    Staging:   build succeeds, crash on startup (Node 16 + incompatible native module)
    Production: different glibc → segfault in compiled native addon

WITHOUT DOCKER:
  Ship code → ops team installs dependencies manually → versions diverge → unpredictable behavior

WITH DOCKER:
  Ship image → image contains: OS layer, runtime, dependencies, app code — frozen at build time
  Developer builds → exact same image → runs in staging → exact same image → runs in production

  Guarantee: if it runs in the container on your laptop, it runs identically on any host with Docker

WHAT DOCKER ACTUALLY PACKAGES:
  ├── Base OS filesystem (Alpine/Ubuntu/distroless) — user-space only, not kernel
  ├── Language runtime (Node.js 18.12.0, Python 3.11.4, JDK 21)
  ├── System libraries (libssl, glibc, etc. — the exact versions)
  ├── Application code (your source or compiled binary)
  └── Environment defaults (PORT, LOG_LEVEL — can be overridden at runtime)

  Kernel: SHARED with the host. Not packaged. (Difference from VMs)
  VMs: full OS + kernel (4GB image). Containers: user-space only (50-500MB image).
```

---

## SECTION 2 — Core Technical Explanation

```
STATES:
  created → running → paused → running → stopped → removed
                                       ↘ (on error) exited

  created:  docker create (image pulled, container object created, NOT running)
  running:  docker start / docker run (PID 1 executing in container)
  paused:   docker pause (SIGSTOP sent to all processes — container frozen, memory intact)
  stopped:  docker stop (SIGTERM → 10s grace → SIGKILL, container still exists on disk)
  removed:  docker rm (container deleted, filesystem gone)
  exited:   process ended (exit 0 = success, exit 1+ = failure)

PID 1 — THE CRITICAL CONCEPT:
  In every container: one process = PID 1
  PID 1 receives: SIGTERM from Docker (docker stop, ECS task stop, k8s pod termination)
  PID 1 responsibility: handle SIGTERM gracefully (drain connections, flush logs, exit cleanly)

  WRONG PID 1 (shell script as entrypoint):
    CMD ["/app/start.sh"]   ← shell is PID 1
    Shell: does NOT forward signals to child processes
    docker stop → SIGTERM to shell → shell ignores → Docker waits 10s → SIGKILL
    Result: ungraceful process kill. Data loss. In-flight requests dropped.

  CORRECT PID 1 (exec form):
    CMD ["node", "server.js"]   ← node is PID 1 directly
    docker stop → SIGTERM to node → node handles gracefully → exits cleanly
    Or use tini (tiny init) as PID 1 for proper signal forwarding:
    ENTRYPOINT ["/sbin/tini", "--"]
    CMD ["node", "server.js"]

CONTAINER vs VM vs PROCESS:
  Process:   runs on host OS. Shares all host resources. No isolation.
  Container: runs in isolated namespace. Shares host kernel. Isolated fs/network/pid.
  VM:        full OS + kernel. Complete isolation. Heavy (GBs, seconds to start).

  Container startup: milliseconds (process spawn).
  VM startup: 30-90 seconds (OS boot).
```

---

## SECTION 3 — Architecture Diagram (MANDATORY)

```
DOCKERFILE ANATOMY (production quality):

# Stage 1: Build stage (larger, has build tools)
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production       # install prod deps only
COPY . .
RUN npm run build                  # compile TypeScript, bundle assets

# Stage 2: Runtime stage (minimal, no build tools)
FROM node:20-alpine AS runtime
RUN addgroup -S appgroup && adduser -S appuser -G appgroup   # non-root user
WORKDIR /app
COPY --from=builder /app/dist ./dist       # only compiled output
COPY --from=builder /app/node_modules ./node_modules
USER appuser                               # run as non-root
EXPOSE 8080
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]

MULTI-STAGE BUILD BENEFITS:
  Build stage: node:20 full image = 900MB (has gcc, Python, etc. for native modules)
  Runtime stage: node:20-alpine = 180MB result
  Difference: 720MB removed. Contains no build tools (attack surface reduced).

BUILD → IMAGE → RUN FLOW:

  1. docker build -t myapp:1.0.0 .
       Reads: Dockerfile
       Executes: each instruction → creates a layer
       Result: image stored in local registry

  2. docker push myapp:1.0.0
       Pushes to: ECR / Docker Hub / GHCR
       Layers: only changed layers pushed (layer caching)

  3. docker run -p 8080:8080 myapp:1.0.0
       Pulls image (if not local)
       Creates container from image
       Starts PID 1 process
       Maps port 8080 on host → 8080 in container

LAYER CACHE OPTIMIZATION:
  Bad order (busts cache on every code change):
    COPY . .           # copies everything → any file change = rebuild deps
    RUN npm install

  Good order (cache-efficient):
    COPY package*.json ./    # only changes when deps change
    RUN npm ci               # cached unless package.json changes
    COPY . .                 # source code copied last (changes often)
    RUN npm run build
```

---

## SECTION 4 — Request Flow (MANDATORY FLOWCHART)

```
COMPLETE CI/CD PIPELINE:

  Developer Push → Git Repository
         │
         ▼
  [CI Pipeline — GitHub Actions / GitLab CI / CodePipeline]
         │
         ├── 1. Code Checkout
         ├── 2. Unit Tests + Lint
         ├── 3. docker build -t ECR_REPO:$GIT_SHA .
         ├── 4. Container Security Scan (Trivy / ECR Enhanced Scanning)
         │       Fail pipeline if: CRITICAL CVEs found
         ├── 5. docker push ECR_REPO:$GIT_SHA
         └── 6. docker push ECR_REPO:latest (or :staging-latest)
         │
         ▼
  [Staging Deployment — ECS / EKS / Fargate]
         │ New task definition: image = ECR_REPO:$GIT_SHA
         ├── Rolling update: new task → health check → old task drained
         ├── Integration tests run against staging
         └── Smoke test: curl /health → 200 OK
         │
         ▼
  [Production Deployment — Gated, Manual Approve or Automated]
         │
         ├── Blue/Green: deploy new version alongside old
         │               traffic shift: 10% → 50% → 100% over time
         │               instant rollback: shift back to old if error rate spikes
         │
         └── Rolling update: replace tasks/pods incrementally
                             maxSurge=1, maxUnavailable=0 (zero-downtime)

IMAGE TAGGING STRATEGY:
  :latest → NEVER use in production (unpredictable, can't roll back)
  :$GIT_SHA → immutable, traceable to exact commit (use in production)
  :1.2.3 → semantic version, good for release tracking

  Production rule: image tag = Git SHA. Always know exactly what's running.
```

---

### Environment Configuration

```
THE PROBLEM: same image, different behavior per environment

  Dev:    connect to localhost DB, verbose logging, debug mode on
  Staging: connect to staging RDS, info logging, feature flags set
  Prod:   connect to prod RDS, error logging only, secrets from Secrets Manager

  Docker: image is immutable. Behavior configured via ENVIRONMENT VARIABLES at runtime.

METHODS (in preference order):

NEVER: bake secrets into image
  ENV DB_PASSWORD=mysecret  ← IN DOCKERFILE → in image → in registry → SECURITY INCIDENT
  Rule: Dockerfile ENV = non-sensitive defaults only (PORT=8080, LOG_LEVEL=info)

GOOD: inject via runtime environment
  docker run -e DB_HOST=prod-rds.amazonaws.com -e LOG_LEVEL=error myapp:1.0.0
  ECS Task Definition: environment block or secrets reference

CORRECT (production): secrets from Secrets Manager / Parameter Store
  ECS Task Definition:
  {
    "secrets": [
      {
        "name": "DB_PASSWORD",
        "valueFrom": "arn:aws:secretsmanager:region:account:secret:prod/myapp/db"
      }
    ],
    "environment": [
      { "name": "PORT", "value": "8080" },
      { "name": "LOG_LEVEL", "value": "error" }
    ]
  }
  → ECS agent: fetches secret at task startup, injects as env var
  → Image: never contains secret. Rotated secrets: just restart task.

12-FACTOR APP PRINCIPLE (Config):
  All config: via environment variables
  Code: 0 knowledge of environment name ("dev", "prod" not in code)
  Feature flags, connections, log levels: all env vars
  Same image: runs in dev, staging, prod with only env vars changing
```

---

### Cost Model

```
WHERE DOCKER SAVES MONEY:
  Density: 1 EC2 host → 50 containers (vs 50 VMs = 50× EC2 cost)
  Startup: milliseconds → faster scaling, Spot instance replacement recovery
  Image size: smaller image = faster pull = faster deployment = less ECR storage cost

ECR PRICING:
  Storage: $0.10/GB/month
  Data transfer out to EC2 same region: free
  Data transfer out to internet: $0.09/GB

  50MB image × 10 pulls/deploy × 100 deploys/month = 50GB = $5/month

BUILD TIME COST (CI/CD):
  GitHub Actions: 2,000 free minutes/month. $0.008/min for Linux after.
  Optimization: layer cache → rebuild in 90 sec vs 8 min = 5× less CI cost
  Use: GitHub Actions cache for Docker layer cache across pipeline runs
```
