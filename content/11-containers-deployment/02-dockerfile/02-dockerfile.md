# Dockerfile

## SECTION 5 — Real World Example

> **Architect Training Mode** | Platform Engineer / DevOps Architect Perspective
> _Real failures. Real commands. Real fixes. Because incidents don't come with documentation._

---

### INCIDENT 01 — Shell Form CMD: SIGTERM Never Arrives → 10-Second Kill Delay on Every Deploy

```
SYMPTOM:
  Every ECS task replacement takes 10+ seconds during deployment.
  CloudWatch logs show the app never logs "graceful shutdown".
  Users see brief request failures during every deployment.
  ECS deployment: "Draining connections..." stays at 10s every time.

ROOT CAUSE:
  Dockerfile uses SHELL FORM for CMD:
    CMD node dist/server.js

  What actually runs:
    PID 1: /bin/sh
    PID 2: node dist/server.js (child of sh)

  ECS sends SIGTERM to PID 1 (/bin/sh).
  /bin/sh does NOT forward the signal to its children.
  Node.js never receives SIGTERM.
  ECS waits for stopTimeout (default 30s for ECS, 10s for Fargate default).
  Then sends SIGKILL. Node.js dies hard. In-flight requests dropped.

FIX:
  Use EXEC FORM (JSON array):
    CMD ["node", "dist/server.js"]

  What runs now:
    PID 1: node dist/server.js (directly, no shell wrapper)

  ECS sends SIGTERM → node receives it → runs shutdown handler → closes server gracefully.

GRACEFUL SHUTDOWN HANDLER (required to make SIGTERM useful):
  process.on('SIGTERM', async () => {
    console.log('SIGTERM received — starting graceful shutdown');
    server.close(() => {
      console.log('HTTP server closed');
      db.close();                          // close DB connection pool
      process.exit(0);
    });
    // Force exit if shutdown takes too long
    setTimeout(() => {
      console.error('Forced shutdown after timeout');
      process.exit(1);
    }, 25000);                             // less than ECS stopTimeout
  });

VERIFY:
  docker run --name test -d myimage
  docker stop test          # sends SIGTERM
  docker logs test          # should show "graceful shutdown" message
  # Without exec form: logs show nothing, container just disappears after 10s

IMPACT: Every deployment was dropping ~5% of in-flight requests.
  Rolling deployment × 10 services × 10 deploys/day = 100 incidents/day of dropped requests.
```

---

### INCIDENT 02 — Secret Baked Into Image Layer (Immutable, Permanent Exposure)

```
SYMPTOM:
  Security scan (Trivy) flags image for containing AWS credentials.
  Developer thought they cleaned it up: "I ran RUN rm .env at the end!"
  Image is in ECR. Secret is still there. Forever.

ROOT CAUSE:
  Each RUN instruction creates an immutable layer.
  Layers are NOT deleted — they are stacked.

  Dockerfile:
    RUN echo "DATABASE_URL=postgres://user:secretpassword@prod-db/myapp" > .env
    RUN rm .env   # ← THIS DOES NOTHING. Layer 1 still contains .env in filesystem.

  How attackers read it:
    docker save myimage | tar xf - | tar tf <layer.tar> | grep .env
    docker history myimage --no-trunc
    docker run --entrypoint sh myimage -c "find / -name .env"
    # Some tools can read intermediate layers directly

FIX — Use Docker BuildKit secrets (never written to any layer):
  # Dockerfile:
  RUN --mount=type=secret,id=npmrc cat /run/secrets/npmrc > ~/.npmrc \
      && npm ci \
      && rm ~/.npmrc

  # Build command:
  docker build --secret id=npmrc,src=.npmrc .

  The secret exists ONLY during that RUN step.
  It is NOT written to any image layer.
  docker history shows NOTHING about the secret value.

FIX — Never put secrets in ENV either:
  ENV DATABASE_PASSWORD=secretpassword  # WRONG: visible in docker inspect + docker history

  Correct pattern:
    ENV DATABASE_PASSWORD=""            # default empty
    # Inject at runtime: ECS task definition → secrets block → Secrets Manager ARN

FIX — For credentials needed only at build time (npm private registry, etc.):
  ARG NPM_TOKEN                              # build-time only
  RUN echo "//registry.npmjs.org/:_authToken=${NPM_TOKEN}" > ~/.npmrc \
      && npm ci \
      && rm ~/.npmrc
  docker build --build-arg NPM_TOKEN=$NPM_TOKEN .
  # WARNING: ARG values still appear in `docker history`. Use BuildKit --mount=secret instead.

SCAN FOR SECRETS:
  trivy image --severity HIGH,CRITICAL myimage
  trivy image --scanners secret myimage     # dedicated secret scanner
  # Run this in CI before every push to ECR

IF SECRET ALREADY IN ECR:
  1. Immediately rotate the exposed credential (assume it's compromised)
  2. Delete all affected image versions from ECR (deregister + delete layers)
  3. Fix Dockerfile with BuildKit secrets
  4. Rebuild and push clean image
  5. Post-mortem: add Trivy to CI pipeline so it never happens again
```

---

### INCIDENT 03 — Build Cache Invalidated Every CI Run (Wrong Instruction Order)

```
SYMPTOM:
  Every CI build takes 8 minutes when it should take 1 minute.
  npm install runs from scratch on every push, even for a one-line code change.
  CI costs have tripled in the last quarter. Engineers blame "slow CI".

ROOT CAUSE:
  Dockerfile:
    COPY . .              # LINE 5 — copies EVERYTHING including source files
    RUN npm ci            # LINE 6 — layer depends on LINE 5
    RUN npm run build     # LINE 7

  Any .ts file change → LINE 5 layer invalidated → LINE 6 cache miss → npm ci runs.
  Developer changes README.md → same result. Full npm install every time.

FIX:
  # Install dependencies FIRST (only re-runs when package*.json changes):
  COPY package*.json ./
  RUN npm ci                # cached until package.json/package-lock.json change
  COPY . .                  # source code here — changes often, but deps layer cached above
  RUN npm run build

VERIFY CACHE IS WORKING:
  # Build twice, second should say "CACHED":
  docker build -t myapp .
  # Make a source code change (touch src/index.ts)
  docker build -t myapp .
  # Output should show:
  #   Step 3/10 : RUN npm ci
  #   ---> Using cache        ← this is what you want

ADDITIONAL CACHE STRATEGIES:
  # BuildKit parallel stage execution (build stages run in parallel):
  DOCKER_BUILDKIT=1 docker build .

  # CI: cache layers between runs (GitHub Actions):
  - uses: docker/build-push-action@v5
    with:
      cache-from: type=gha
      cache-to: type=gha,mode=max

  # Result: first build 8 min, subsequent builds ~45 seconds
```

---

### INCIDENT 04 — Large Image (1.8GB) Causing ECS Fargate Cold Start Timeout

```
SYMPTOM:
  New ECS Fargate tasks fail to become healthy during auto-scaling event.
  Error: "Task stopped. Reason: Container failed to start."
  CloudWatch: task provisioned, then immediately DEPROVISIONING.
  Load increased → auto-scale triggered → new tasks die → load stays high → alarm fires.

ROOT CAUSE:
  Image is 1.8GB (single-stage build, node:20 base, devDependencies included).

  ECS Fargate default image pull timeout: 3 minutes.
  1.8GB at ~100Mbps ECR throughput = ~145 seconds.
  But ECR throughput is shared and bursty — during traffic spike: 40 seconds.
  4 new tasks × 40 seconds serial ECR pull = 160 seconds — within timeout normally.
  But concurrent pulls + network congestion → pull takes 4-5 minutes → task killed.

FIX — Reduce image size:
  Single-stage → Multi-stage: 1.8GB → 190MB (90% reduction)
  190MB pull time: ~15s → 4 tasks = 60s — well within timeout, handles spikes

FIX — Increase Fargate image pull timeout (if can't reduce size immediately):
  # In ECS task definition:
  {
    "runtimePlatform": {},
    "containerDefinitions": [{
      ...
    }],
    "ephemeralStorage": {"sizeInGiB": 21},
    # Not directly configurable in standard task def
    # Use start-timeout on container healthcheck instead:
    "healthCheck": {
      "startPeriod": 300   # 5 minutes grace period
    }
  }

FIX — Pre-warm ECR pulls in the same region:
  Ensure ECS cluster and ECR registry are in the SAME region.
  ECR → ECS same-region pulls are free AND faster (internal AWS network).
  Cross-region pulls: slower + $0.09/GB charge.

MONITORING:
  CloudWatch metric: ECS → ContainerInsights → image pull duration
  Alarm: P90 image pull > 60 seconds → investigate image size

ROOT CAUSE CHECKLIST:
  docker images myapp         # check current size
  docker history myapp        # find large layers
  dive myapp                  # explore layer-by-layer (install: github.com/wagoodman/dive)

  Common culprits:
    - node_modules in final image (should be filtered or multi-stage)
    - .git directory copied in (missing .dockerignore)
    - Build tools (gcc, python, make) left in runtime image
    - Multiple APK/APT install layers not merged
    - Test fixtures, seed data, documentation
```

---

### INCIDENT 05 — Root User Container → Container Escape

```
SYMPTOM:
  Security audit finds all containers running as root (UID 0).
  Penetration test: RCE vulnerability in Node.js dependency → attacker reads /etc/shadow.
  Potential container escape via kernel exploits (runc CVE-2024-21626 etc).

ROOT CAUSE:
  No USER instruction in Dockerfile.
  Default: container runs as root.
  Root in container = root on host if breakout occurs.

FIX:
  # node:20-alpine has a built-in 'node' user:
  USER node

  # For other images, create dedicated app user:
  RUN groupadd -r appgroup && useradd -r -g appgroup appuser
  USER appuser

  # Ensure file ownership before USER switch:
  COPY --chown=node:node . .

DEFENSE IN DEPTH (complete security hardening):
  # 1. Non-root user (above)

  # 2. Read-only root filesystem (ECS task definition or docker run):
  docker run --read-only --tmpfs /tmp myimage
  # ECS: "readonlyRootFilesystem": true in container definition
  # App must write only to explicitly mounted volumes, not to container filesystem.

  # 3. Drop Linux capabilities:
  docker run --cap-drop=ALL --cap-add=NET_BIND_SERVICE myimage
  # ECS: "linuxParameters": {"capabilities": {"drop": ["ALL"], "add": ["NET_BIND_SERVICE"]}}

  # 4. No privileged mode:
  # Never: "privileged": true in ECS task definition
  # Privileged = container has near-root access to host kernel

  # 5. Scan for vulnerabilities:
  trivy image --severity HIGH,CRITICAL myimage
  # Add to CI gate: fail build if CRITICAL CVEs found

VERIFY:
  docker run myimage whoami    # should output: node (or appuser), NOT root
  docker run myimage id        # uid=1000(node) gid=1000(node)  ← correct
                               # uid=0(root)                    ← dangerous
```

---

### Debugging Toolkit

```bash
# ──────────────────────────────────────────────────────────────────────
# INSPECT IMAGE DETAILS
# ──────────────────────────────────────────────────────────────────────

# Show all layers and sizes
docker history myimage --no-trunc

# Show image metadata (ENV, CMD, ENTRYPOINT, EXPOSE, USER, etc.)
docker inspect myimage | jq '.[0].Config'

# Show image size
docker images myimage

# Interactive layer exploration (install: github.com/wagoodman/dive)
dive myimage

# ──────────────────────────────────────────────────────────────────────
# SHELL INTO RUNNING CONTAINER (alpine)
# ──────────────────────────────────────────────────────────────────────
docker exec -it <container_id> sh   # alpine uses sh, not bash

# Shell into stopped container (for build debugging)
docker run -it --entrypoint sh myimage

# ──────────────────────────────────────────────────────────────────────
# BUILD DEBUGGING
# ──────────────────────────────────────────────────────────────────────

# Build with verbose output
docker build --progress=plain .

# Build specific stage only
docker build --target builder .

# Build with no cache (force full rebuild)
docker build --no-cache .

# Check build context size (large context = slow build)
docker build . 2>&1 | head -1
# Output: "Sending build context to Docker daemon  532.5MB" ← 532MB is too large

# ──────────────────────────────────────────────────────────────────────
# SECRET SCANNING
# ──────────────────────────────────────────────────────────────────────
trivy image --scanners secret myimage
trivy image --severity HIGH,CRITICAL myimage

# ──────────────────────────────────────────────────────────────────────
# PROCESS & SIGNAL DEBUGGING
# ──────────────────────────────────────────────────────────────────────

# Check what PID 1 is (should be your app, not sh)
docker run myimage ps aux

# Test SIGTERM handling
docker run --name test -d myimage
docker stop --time=5 test          # sends SIGTERM, waits max 5s before SIGKILL
docker logs test                   # should show graceful shutdown message

# ──────────────────────────────────────────────────────────────────────
# LAYER CLEANUP
# ──────────────────────────────────────────────────────────────────────

# Remove dangling images (untagged intermediate layers)
docker image prune

# Remove all unused images (aggressive)
docker image prune -a

# Remove all stopped containers + unused images + networks + build cache
docker system prune -af

# Show disk usage breakdown
docker system df -v
```

---

### Hadolint (Dockerfile Linter)

```bash
# Install
brew install hadolint             # macOS
docker run hadolint/hadolint < Dockerfile   # via Docker (no install)

# Run
hadolint Dockerfile

# Example output:
#   Dockerfile:3 DL3007 warning: Using latest is best avoided
#   Dockerfile:8 DL3018 warning: Pin versions in apk add: apk add curl=7.88.1-r1
#   Dockerfile:12 DL4006 warning: Set the SHELL option -o pipefail before RUN with a pipe

# Add to CI (fail PR if Dockerfile has errors):
# .github/workflows/lint.yml
- name: Lint Dockerfile
  uses: hadolint/hadolint-action@master
  with:
    dockerfile: Dockerfile

# Common rules to know:
#   DL3007: avoid :latest tags
#   DL3008: pin apt-get package versions
#   DL3018: pin apk package versions
#   DL3025: use JSON array for CMD/ENTRYPOINT (exec form)
#   DL4006: use set -o pipefail with pipes in RUN
```

## SECTION 6 — System Design Importance

The incident patterns above highlight key system design principles: design for failure, implement graceful degradation, enforce security boundaries at every layer, and monitor proactively. Each incident represents a production scenario that should inform your system design decisions.

## SECTION 7 — AWS & Cloud Mapping

AWS services directly relevant to these patterns: **ECS/Fargate** for container orchestration and task lifecycle management; **ECR** for secure image storage and scanning; **Secrets Manager / SSM Parameter Store** for runtime secret injection; **CloudWatch** for container metrics, logs, and alarms; **IAM** for fine-grained access control.

## SECTION 8 — Interview Preparation

**Beginner:**

**Q: What is a Dockerfile and what do the most common instructions do?**
**A:** A Dockerfile is a text file of step-by-step instructions for building a Docker image. Key instructions: FROM â€” specifies the base image to start from (e.g., FROM node:20-alpine). WORKDIR â€” sets the working directory inside the container. COPY â€” copies files from your project into the image. RUN â€” executes a command during build (install packages, compile code). EXPOSE â€” documents which port the app listens on (doesn't actually open ports). CMD â€” defines the default command to run when the container starts. Together, they define exactly how to build and run your app.

**Q: What is the difference between CMD and ENTRYPOINT in a Dockerfile?**
**A:** CMD provides the default command but it can be completely overridden when running the container (docker run myimage alternative-command). ENTRYPOINT sets a fixed command that always runs â€” CMD or docker run arguments become arguments to it. Example: ENTRYPOINT ["node"] with CMD ["server.js"] â†’ runs 
ode server.js. You can docker run myimage different-file.js and it runs 
ode different-file.js â€” only the argument changes. Common pattern: ENTRYPOINT for the executable, CMD for default arguments.

**Q: Why should you use a specific base image version tag instead of :latest?**
**A:** FROM node:latest is dangerous because :latest changes whenever Node.js releases a new major version. Your Dockerfile that worked with Node 18 might break when :latest becomes Node 22 with breaking changes. Builds become unpredictable. Use specific: FROM node:20.11.0-alpine3.19 â€” exact Node version, exact Alpine version. Your build is reproducible forever. In CI: two builds a week apart produce identical images. Upgrade node version purposefully, not accidentally.

---

**Intermediate:**

**Q: What are bind mounts vs volumes in Docker and when do you use each?**
**A:** *Bind mount:* maps a host directory into a container (docker run -v /host/path:/container/path). Used for development â€” mount source code into container so changes appear instantly without rebuilding. NOT for production (host path must exist, not portable). *Volume:* Docker-managed storage (docker run -v mydata:/container/path). Docker stores data at its own location. Survives container deletion. Used for persistent data: database files, uploaded files. For production ECS: use EFS (Elastic File System) mounted as a volume for shared file storage across container instances.

**Q: What is the security implication of running a container as root, and how do you fix it?**
**A:** By default, processes inside Docker containers run as root (UID 0). If an attacker exploits your app and escapes the container (container escape vulnerabilities do exist), they land on the host as root â†’ game over. Fix in Dockerfile: create a non-root user and switch to it before CMD:
`dockerfile
RUN addgroup -g 1001 appgroup && \
    adduser -u 1001 -G appgroup -s /bin/sh -D appuser
USER appuser
`
Also: read-only root filesystem (docker run --read-only) prevents writing to container filesystem. AWS ECS supports user in task definition and read-only root filesystem.

**Q: How do you reduce Docker image size and why does it matter in production?**
**A:** Smaller images = faster pulls (faster deploys), less attack surface, less storage cost in ECR. Key techniques: (1) Alpine base image â€” 
ode:20-alpine is ~50MB vs 
ode:20 at ~1GB. (2) Multi-stage builds â€” compiler/build tools don't go in the final image. (3) Combine RUN commands: RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/* â€” one layer, cleanup removes package cache. (4) .dockerignore â€” don't copy test files, docs, development configs into image. (5) 
pm ci --only=production â€” no devDependencies in production image.

---

**Advanced (System Design):**

**Scenario 1:** Design a Dockerfile strategy for a monorepo containing a Node.js API and a shared utilities package. The API depends on the utilities package. The build must run from CI, produce a minimal production image, and not include the utilities package's development tooling.

*Multi-stage Dockerfile with monorepo context:*
`dockerfile
FROM node:20-alpine AS builder
WORKDIR /monorepo
# Copy workspace configuration
COPY package*.json ./
COPY packages/utils/package.json ./packages/utils/
COPY packages/api/package.json ./packages/api/
# Install all deps at workspace root
RUN npm ci
# Copy source
COPY packages/utils ./packages/utils
COPY packages/api ./packages/api
# Build shared utils first
RUN npm run build --workspace=packages/utils
# Build API
RUN npm run build --workspace=packages/api

FROM node:20-alpine AS runner
WORKDIR /app
# Only copy what's needed for runtime
COPY --from=builder /monorepo/packages/api/dist ./dist
COPY --from=builder /monorepo/packages/utils/dist ./node_modules/@myorg/utils/dist
COPY packages/api/package.json ./
RUN npm ci --only=production
CMD ["node", "dist/server.js"]
`

**Scenario 2:** A security scan of your Docker images in ECR reveals critical CVEs (vulnerabilities) in your base image 
ode:18-alpine. You have 15 microservices using this base image. Design a process for updating all 15 images across dev/staging/production without downtime, and how to prevent this situation in future.

*Fix process:* Update base image tag to patched version in all Dockerfiles. Trigger CI builds for all 15 services simultaneously (pipeline). Automated tests run per service. Deploy to staging, run smoke tests, promote to production via rolling update (ECS handles zero-downtime rolling replacement). Use image digest pinning (FROM node:20-alpine@sha256:abc123) for exact reproducibility.
*Prevention:* (1) Centralize base image definition â€” a single internal FROM company/node:20 base image that the security team maintains and patches. All 15 services FROM this internal image. One update patches all. (2) ECR Enhanced Scanning (powered by Snyk/Inspector) â€” auto-scans on push, creates findings. (3) CI step: docker scan or Trivy scan as a build gate â€” fail builds for CRITICAL CVEs. (4) Monthly scheduled CI rebuild to pick up base image patches even without code changes.

