# Dockerfile

## FILE 01 OF 03 — Core Concepts, Architecture & Production Patterns

> **Architect Training Mode** | Platform Engineer / DevOps Architect Perspective
> _Optimized for: design judgement · tradeoff evaluation · failure prediction · production debugging_

---

## SECTION 1 — Intuition (Explain Like a 12-Year-Old)

```
WITHOUT DOCKERFILE:
  "Install Node 20. Then run npm install. Set DB_HOST. Then start with node server.js."
  → Tribal knowledge. Breaks when the person leaves. Different machine = different result.

WITH DOCKERFILE:
  The entire environment, startup procedure, and dependencies are CODE.
  Versioned in git. Reviewed in PRs. Reproducible anywhere.
  The Dockerfile IS the deployment spec — self-documenting, executable, auditable.

WHAT A DOCKERFILE DEFINES:
  ├── Base OS + runtime (FROM node:20-alpine)
  ├── System packages needed (RUN apk add --no-cache curl)
  ├── Application dependencies (COPY package.json + RUN npm ci)
  ├── Application code (COPY . .)
  ├── Runtime configuration defaults (ENV PORT=8080)
  ├── User/permissions (USER appuser)
  ├── Health check (HEALTHCHECK CMD curl -f http://localhost:8080/health)
  ├── Exposed port (EXPOSE 8080)
  └── Startup command (CMD ["node", "dist/server.js"])

EVERY LINE IS A LAYER:
  Each instruction creates a read-only filesystem layer.
  Layers are cached. Only changed layers + everything below rebuild.
  Order matters: most stable instructions FIRST, most frequently changing LAST.
```

---

## SECTION 2 — Core Technical Explanation

```dockerfile
# ── FROM ──────────────────────────────────────────────────────────────
# Base image. The foundation of everything.
FROM node:20-alpine AS builder
# Rules:
#   Always pin a specific version tag. Never FROM node:latest.
#   alpine  = minimal ~5MB OS. Production standard for most apps.
#   debian  = larger but more compatible for native modules.
#   distroless = no shell/package manager — most secure, hardest to debug.

# ── WORKDIR ───────────────────────────────────────────────────────────
WORKDIR /app
# Creates dir if it doesn't exist. All subsequent COPY/RUN/CMD relative to it.
# Prefer over: RUN mkdir /app && cd /app

# ── COPY ──────────────────────────────────────────────────────────────
COPY package*.json ./
# Build context = directory passed to `docker build` (usually .)
# --chown: set file ownership so non-root user can read at runtime
COPY --chown=node:node . .

# ── RUN ───────────────────────────────────────────────────────────────
# Execute command during BUILD. Result frozen into a new layer.
RUN npm ci --only=production
# Chain commands with && to keep layer count low:
RUN apk add --no-cache curl \
    && rm -rf /var/cache/apk/*
# --no-cache: don't write package index to disk → smaller layer

# ── ENV vs ARG ────────────────────────────────────────────────────────
# ENV: baked into image, available at runtime.
ENV NODE_ENV=production
ENV PORT=8080
# ARG: only available at BUILD time, NOT in running container.
ARG APP_VERSION=unknown
# docker build --build-arg APP_VERSION=1.2.3 .
# CRITICAL: ARG values ARE visible in `docker history` — never use for secrets.

# ── EXPOSE ────────────────────────────────────────────────────────────
EXPOSE 8080
# Documentation only. Does NOT publish the port.
# docker run -p 8080:8080 still required. Tells ECS/k8s the container port.

# ── USER ──────────────────────────────────────────────────────────────
# Switch to non-root before CMD/ENTRYPOINT. Security critical.
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser
# node:20-alpine already ships a built-in 'node' user — use it.

# ── HEALTHCHECK ───────────────────────────────────────────────────────
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -qO- http://localhost:8080/health || exit 1
# start-period: grace window before failed checks count (app startup time).
# ECS/k8s use their own health check config — this is used in local/standalone Docker.

# ── ENTRYPOINT vs CMD ─────────────────────────────────────────────────
ENTRYPOINT ["node"]             # fixed executable — override requires --entrypoint flag
CMD ["dist/server.js"]          # default argument to ENTRYPOINT — easily overridable
# Together: runs "node dist/server.js"
# Worker override: docker run myimage dist/worker.js → "node dist/worker.js"
# Debug override: docker run --entrypoint sh myimage

# EXEC FORM vs SHELL FORM — signal handling (critical for graceful shutdown):
CMD ["node", "dist/server.js"]  # exec form: node is PID 1, receives SIGTERM directly ✅
CMD node dist/server.js         # shell form: /bin/sh wraps node, SIGTERM never forwarded ❌
                                # shell form → 10s kill timeout on every ECS deploy
```

---

## SECTION 3 — Architecture Diagram (MANDATORY)

```dockerfile
# ══════════════════════════════════════════════════════════════════════
# STAGE 1 — Install production dependencies only
# ══════════════════════════════════════════════════════════════════════
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
# Result: /app/node_modules with ONLY prod packages (~50MB typical)

# ══════════════════════════════════════════════════════════════════════
# STAGE 2 — Build (TypeScript compile, asset bundling, etc.)
# ══════════════════════════════════════════════════════════════════════
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci                          # includes devDependencies (tsc, eslint, etc.)
COPY . .
RUN npm run build                   # compile TypeScript → dist/

# ══════════════════════════════════════════════════════════════════════
# STAGE 3 — Runtime image (what actually ships to production)
# ══════════════════════════════════════════════════════════════════════
FROM node:20-alpine AS runtime

RUN addgroup -S app && adduser -S app -G app
WORKDIR /app

# Copy ONLY what's needed to run the application
COPY --from=deps    /app/node_modules ./node_modules   # prod deps from stage 1
COPY --from=builder /app/dist         ./dist           # compiled output from stage 2
COPY package.json ./                                   # for metadata/scripts

ENV NODE_ENV=production PORT=8080
USER app
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -qO- http://localhost:8080/health || exit 1

CMD ["node", "dist/server.js"]

# ══════════════════════════════════════════════════════════════════════
# SIZE COMPARISON
# ══════════════════════════════════════════════════════════════════════
# Naive single-stage (node:20 + devDeps + source + build artifacts): ~1.1 GB
# Multi-stage result (alpine + prod node_modules + compiled dist only): ~160 MB
#
# 85% size reduction → 85% smaller attack surface → 85% faster ECR pull
# Cold start impact: 1.1GB pull = ~45s on ECS Fargate | 160MB pull = ~6s
```

---

## SECTION 4 — Request Flow (MANDATORY FLOWCHART)

```
THE GOLDEN RULE:
  Instructions that RARELY change → TOP of Dockerfile
  Instructions that FREQUENTLY change → BOTTOM of Dockerfile

─────────────────────────────────────────────────────────────────────
WRONG ORDER (cache-busting on every code commit):
─────────────────────────────────────────────────────────────────────
  COPY . .              ← ANY .ts file change invalidates this layer
  RUN npm ci            ← re-runs full npm install on EVERY push (3 min)
  RUN npm run build

─────────────────────────────────────────────────────────────────────
CORRECT ORDER (dependencies cached until package.json changes):
─────────────────────────────────────────────────────────────────────
  COPY package*.json ./ ← only invalidated when deps actually change
  RUN npm ci            ← cached 95% of the time (only source changed)
  COPY . .              ← source changes here, but heavy layer above is cached
  RUN npm run build

─────────────────────────────────────────────────────────────────────
REAL COST MATH:
─────────────────────────────────────────────────────────────────────
  Team: 3 developers, 50 pushes/day = 150 builds/day
  Wrong order: 150 × 3 min npm install = 450 min/day CI time
  Correct order: 150 × 15s (cached) = 37.5 min/day CI time

  GitHub Actions: $0.008/min
  Wrong: $3.60/day = $108/month in wasted CI minutes
  Correct: $0.30/day = $9/month
  → 91% CI cost reduction from instruction ORDER ALONE

─────────────────────────────────────────────────────────────────────
.dockerignore CHECKLIST (alongside Dockerfile at project root):
─────────────────────────────────────────────────────────────────────
  node_modules/      # never copy local node_modules into build context
  .git/              # git history adds hundreds of MB silently
  .env               # NEVER bake .env into image
  .env.*             # all variants
  dist/              # stale local build output
  coverage/          # test coverage reports
  *.test.ts          # test files not needed in prod image
  *.spec.ts
  README.md
  .DS_Store
  Dockerfile*        # Dockerfile itself doesn't need to be in image
  docker-compose*

  Without .dockerignore:
    COPY . . copies node_modules (500MB) into Docker build context
    → Slow context upload → bloated image layers → secrets accidentally included
```

---

### Base Image Selection Guide

```
┌─────────────────────────────────────┬──────────┬──────────────────────────────────────┐
│ Base Image                          │ Size     │ Best For                             │
├─────────────────────────────────────┼──────────┼──────────────────────────────────────┤
│ node:20                             │ ~950 MB  │ Local dev, CI build stages           │
│ node:20-slim                        │ ~240 MB  │ Apps with native modules              │
│ node:20-alpine                      │ ~135 MB  │ Production standard (most apps)      │
│ gcr.io/distroless/nodejs20          │ ~110 MB  │ High-security production workloads   │
│ scratch                             │ 0 MB     │ Go/Rust compiled static binaries     │
└─────────────────────────────────────┴──────────┴──────────────────────────────────────┘

CHOICE GUIDE:
  Production Node.js API → node:20-alpine
    curl/wget available, well-maintained, small, widely used

  Production Go or Rust service → scratch or distroless/static
    Compile to static binary → COPY binary FROM scratch → 10-20 MB image
    Zero OS. Zero attack surface. Nothing to CVE-scan.

  Apps with native Node.js modules (bcrypt, sharp, canvas, sqlite3):
    → node:20-slim (Debian, has glibc — prebuilt native packages need it)
    → OR: node:20 for build stage, node:20-alpine for runtime stage
    WHY: Alpine uses musl libc. Most prebuilt npm native modules target glibc.
         On Alpine they may fail with SIGILL or "invalid ELF header" at runtime.

  High-security production (no debug access needed):
    → distroless — no shell, no package manager, no cron, no nothing
    → Cannot: docker exec into it
    → Can: kubectl debug -it --image=busybox --target=mycontainer (ephemeral sidecar)

NEVER:
  FROM node:latest   — "latest" changes under you. Pin the exact version.
```

---

### Production Dockerfile Template (Node.js)

```dockerfile
# syntax=docker/dockerfile:1
# ─── Stage 1: Production dependencies ────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

# ─── Stage 2: Build ───────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# ─── Stage 3: Runtime ─────────────────────────────────────────────────
FROM node:20-alpine AS runtime
LABEL maintainer="team@company.com"
LABEL version="${APP_VERSION}"
LABEL description="Production API server"

# Non-root user (node user is built into node:alpine)
RUN chown -R node:node /app 2>/dev/null || true
WORKDIR /app

COPY --chown=node:node --from=deps    /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/dist         ./dist
COPY --chown=node:node package.json ./

ENV NODE_ENV=production
ENV PORT=8080
ARG APP_VERSION=unknown
ENV APP_VERSION=${APP_VERSION}

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -qO- http://localhost:${PORT}/health || exit 1

CMD ["node", "dist/server.js"]
```

---

### Cost Model

```
ECR IMAGE STORAGE:
  $0.10/GB/month
  160MB image: $0.016/month per version
  With 50 versions retained: $0.80/month — essentially free

DATA TRANSFER (ECR pull):
  Same region (ECR → ECS Fargate in same region): FREE
  Cross-region: $0.09/GB per GB pulled

COLD START IMPACT ON IMAGE SIZE:
  Fargate pulls image on every new task launch (no persistent disk).
  1.1 GB image → ~45 sec pull time on cold start
  160 MB image → ~6 sec pull time
  During traffic spike (scale-out event): 10 new tasks × 45s = tasks not ready for 45s
  With optimized image: 10 tasks ready in ~6s → faster horizontal scaling

ECR LIFECYCLE POLICY (prevent storage accumulation):
  aws ecr put-lifecycle-policy --repository-name myapp \
    --lifecycle-policy-text '{
      "rules": [
        {
          "rulePriority": 1,
          "description": "Keep last 10 production images",
          "selection": {
            "tagStatus": "tagged",
            "tagPrefixList": ["prod"],
            "countType": "imageCountMoreThan",
            "countNumber": 10
          },
          "action": {"type": "expire"}
        },
        {
          "rulePriority": 2,
          "description": "Delete untagged images after 1 day",
          "selection": {
            "tagStatus": "untagged",
            "countType": "sinceImagePushed",
            "countUnit": "days",
            "countNumber": 1
          },
          "action": {"type": "expire"}
        }
      ]
    }'
```
