# Docker Concepts

## SECTION 5 — Real World Example

> **Architect Training Mode** | Platform Engineer / DevOps Architect Perspective
> _Optimized for: design judgement · tradeoff evaluation · failure prediction · production debugging_

---

## SECTION 5 — Real World Example

```
MISTAKE 1: Running as root inside the container
  Default Dockerfile: no USER instruction → process runs as root (UID 0)
  Container breakout: if attacker escapes container (CVE) → runs as root on host
  Fix:
    RUN addgroup -S app && adduser -S app -G app
    USER app
  Check: docker run --rm myimage whoami  →  should NOT return "root"

MISTAKE 2: Storing state inside the container filesystem
  Container filesystem: ephemeral. Container restart/replacement = filesystem gone.
  Development: "I'll just write to /tmp/uploads/" in container.
  Production: ECS replaces task → 3,000 uploaded files gone.
  Fix: volumes (development) or cloud storage (S3, EFS) for persistent data.
  Rule: containers are cattle, not pets. Rebuild anytime.

MISTAKE 3: Massive image size (multi-GB)
  Symptom: ECS task takes 4 minutes to start (pulling 3GB image).
  Cause: copied entire repo (node_modules unoptimized), left build tools in image.
  Impact: slow deployments, slow scale-out, higher transfer costs.
  Fix: multi-stage build, .dockerignore, use Alpine base, only copy production artifacts.

  .dockerignore (CRITICAL — often forgotten):
    node_modules/
    .git/
    .env*
    *.test.ts
    coverage/
    dist/
    README.md
  Without .dockerignore: COPY . . copies 500MB node_modules into build context.

MISTAKE 4: No HEALTHCHECK — ECS/k8s can't detect app failure
  Container running: OS-level process alive.
  Application: deadlocked, DB connection lost, memory leak → serving 500s.
  ECS: sees "task running" → doesn't know app is broken → no replacement.

  Fix in Dockerfile:
  HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1

  ECS/ALB: uses HTTP health check (separate config) — prefer this over Dockerfile HEALTHCHECK.
  But: Dockerfile HEALTHCHECK = self-describes the container for local dev and debugging.

MISTAKE 5: Pinning to :latest tag in deployment
  image: myapp:latest → deployed Monday = image A.
  Teammate pushes hotfix → :latest = image B.
  Incident rollback → re-deploy "same" version → actually pulls image B again.
  Can't reproduce the exact version that was running.
  Fix: ALWAYS use immutable tag (Git SHA or semantic version) in production.
```

---

## SECTION 6 — System Design Importance

```
IMAGE SECURITY LAYERS:

1. BASE IMAGE — choose minimal, from trusted source
   WRONG: FROM ubuntu:latest  (full OS, 720MB, 200+ packages, large attack surface)
   BETTER: FROM node:20-alpine (Alpine Linux, 5MB OS layer, minimal packages)
   BEST: FROM gcr.io/distroless/nodejs20-debian12 (Google distroless — no shell, no package manager)
     Distroless: cannot exec into (no bash), drastically reduces exploitability

2. VULNERABILITY SCANNING — in CI pipeline
   Tool: Trivy (open source, fast, free)

   # In CI pipeline:
   trivy image --exit-code 1 --severity CRITICAL myapp:$GIT_SHA
   # --exit-code 1 fails pipeline if CRITICAL CVEs found

   ECR Enhanced Scanning: automatic CVE scanning on push (uses Inspector v2)
   Alert: SNS notification if new CVE found in already-deployed image

3. NON-ROOT USER — always
   USER app (UID 1001, not 0)

4. READ-ONLY FILESYSTEM — immutable container
   docker run --read-only --tmpfs /tmp myapp:1.0.0
   Attacker writes exploit file: "Read-only file system" error
   ECS support: readonlyRootFilesystem: true in task definition

5. NO SECRETS IN IMAGES — scan for this
   Tool: truffleHog, gitleaks — scan Dockerfiles and layers for embedded secrets

6. CAPABILITIES — drop all, add only what's needed
   docker run --cap-drop=ALL --cap-add=NET_BIND_SERVICE myapp:1.0.0
   NET_BIND_SERVICE: allows binding ports < 1024 without root
   Most apps: don't need any Linux capabilities

PRODUCTION SECURITY CHECKLIST:
  □ Non-root USER in Dockerfile
  □ Multi-stage build (no build tools in runtime image)
  □ Trivy scan in CI (block on CRITICAL)
  □ No ENV secrets in Dockerfile
  □ .dockerignore excludes .env, credentials, .git
  □ readonlyRootFilesystem: true in ECS task definition
  □ ECR image scanning enabled
```

---

## SECTION 7 — AWS & Cloud Mapping

```
ECS FARGATE TASK DEFINITION (production-ready):

{
  "family": "myapp-prod",
  "requiresCompatibilities": ["FARGATE"],
  "networkMode": "awsvpc",             // each task gets its own ENI
  "cpu": "512",                        // 0.5 vCPU
  "memory": "1024",                    // 1GB RAM
  "executionRoleArn": "arn:...:role/ecsTaskExecutionRole",  // pull from ECR, write logs
  "taskRoleArn": "arn:...:role/myapp-task-role",           // what app can DO (S3, DynamoDB, etc.)
  "containerDefinitions": [{
    "name": "myapp",
    "image": "123456789.dkr.ecr.us-east-1.amazonaws.com/myapp:a3f2c1d",  // immutable Git SHA
    "portMappings": [{ "containerPort": 8080, "protocol": "tcp" }],
    "environment": [
      { "name": "PORT", "value": "8080" },
      { "name": "LOG_LEVEL", "value": "info" }
    ],
    "secrets": [
      { "name": "DB_PASSWORD", "valueFrom": "arn:...:secret:prod/myapp/db" },
      { "name": "JWT_SECRET", "valueFrom": "arn:...:secret:prod/myapp/jwt" }
    ],
    "logConfiguration": {
      "logDriver": "awslogs",
      "options": {
        "awslogs-group": "/ecs/myapp-prod",
        "awslogs-region": "us-east-1",
        "awslogs-stream-prefix": "ecs"
      }
    },
    "healthCheck": {
      "command": ["CMD-SHELL", "curl -f http://localhost:8080/health || exit 1"],
      "interval": 30,
      "timeout": 5,
      "retries": 3,
      "startPeriod": 60        // grace period for app startup before health check counts
    },
    "readonlyRootFilesystem": true,
    "linuxParameters": {
      "initProcessEnabled": true    // tini-equivalent: proper signal forwarding + zombie reaping
    }
  }]
}

ECS SERVICE (rolling deployment):
{
  "serviceName": "myapp-prod",
  "desiredCount": 3,
  "deploymentConfiguration": {
    "maximumPercent": 200,        // can run 6 tasks during rolling update (200% of 3)
    "minimumHealthyPercent": 100  // never drop below 3 healthy tasks (zero downtime)
  },
  "loadBalancers": [{
    "targetGroupArn": "arn:...",
    "containerName": "myapp",
    "containerPort": 8080
  }],
  "networkConfiguration": {
    "awsvpcConfiguration": {
      "subnets": ["subnet-app-1a", "subnet-app-1b"],
      "securityGroups": ["sg-app"],
      "assignPublicIp": "DISABLED"   // private subnet, no public IP
    }
  }
}
```

---

## SECTION 8 — Interview Preparation

**Beginner:**

**Q: What problem does Docker solve that didn't exist with traditional deployment?**
**A:** "It works on my machine" â€” the classic developer headache. Your laptop has Node 18 and library version X. The production server has Node 16 and library version Y. Code works locally, breaks in production. Docker packages the application together with its exact runtime environment (OS libraries, language version, dependencies) into a container. The container runs identically on any machine that has Docker. What runs on your laptop runs exactly the same in production.

**Q: What is the difference between a virtual machine (VM) and a Docker container?**
**A:** A VM virtualizes the entire hardware â€” it includes a full OS kernel, hundreds of MB/GB on disk, takes minutes to start. A Docker container shares the host OS kernel â€” it only packages the application and its dependencies (libraries, config files). Result: containers start in seconds, are 10-100x smaller, and you can run dozens on the same machine where you'd run 3-4 VMs. Trade-off: containers share the host kernel (less isolated than VMs). For production: containers run on VMs â€” you get both the isolation of VMs and the efficiency of containers.

**Q: What is a Docker registry and how does it fit into the deployment process?**
**A:** A Docker registry stores Docker images. Docker Hub is the public registry (like GitHub for code, but for images). AWS ECR (Elastic Container Registry) is a private registry inside AWS. The flow: (1) Developer writes code + Dockerfile. (2) CI/CD builds the image: docker build -t myapp:v1.2 .. (3) Image pushed to registry: docker push 123456.ecr.us-east-1.amazonaws.com/myapp:v1.2. (4) Production ECS pulls the image from ECR and runs it. The registry is the artifact store between build and deploy.

---

**Intermediate:**

**Q: What is Docker layer caching and how does it affect build speed?**
**A:** Every instruction in a Dockerfile creates a layer (a snapshot of the filesystem at that point). Docker caches layers and only rebuilds from the first changed instruction onward. This means: if you COPY package.json and RUN npm install BEFORE COPY . . â€” layer cache for npm install is valid as long as package.json doesn't change (which is most of the time). If you copy all source code first, THEN run npm install â€” every code change invalidates the npm install cache. Rule of thumb: put things that change infrequently (system dependencies, package installs) early in the Dockerfile; things that change often (source code) late.

**Q: What is Docker networking and how do containers communicate with each other?**
**A:** Docker creates virtual networks. By default: containers can't talk to each other unless they're on the same network. A bridge network is the default for standalone containers. Container-to-container on same bridge: curl http://container-name:3000 (Docker's internal DNS resolves container names). Docker Compose puts all services on a shared network automatically â€” db, pi, edis can all reach each other by service name. In ECS: all containers in the same task share localhost (awsvpc mode). Understanding networking mode (bridge vs awsvpc vs host) is critical for production ECS configuration.

**Q: What is the Docker build context and why can it severely slow down builds?**
**A:** The build context is the directory you pass to docker build . â€” Docker sends ALL files in that directory to the Docker daemon before building. If your project root contains 
ode_modules/ (200MB+), .git/ history, large test data â€” all of that is uploaded on every build, even if the Dockerfile never uses those files. Fix: create .dockerignore (works like .gitignore) with at minimum: 
ode_modules, .git, .env, *.log, dist/, coverage/. A build that sends 200MB context vs 5MB context is dramatically faster, especially in CI/CD.

---

**Advanced (System Design):**

**Scenario 1:** Design a multi-stage Docker build for a production Node.js API that: (1) has development-only tools (TypeScript compiler, Jest, ESLint) that should NOT be in the production image, (2) builds to < 150MB image size, (3) runs as a non-root user for security.

*Multi-stage build:*
`dockerfile
# Stage 1: Build
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci                        # Install ALL deps (including devDeps)
COPY . .
RUN npm run build                 # Compile TypeScript â†’ dist/

# Stage 2: Production
FROM node:20-alpine AS runner
WORKDIR /app
RUN addgroup -g 1001 appgroup && adduser -u 1001 -G appgroup -s /bin/sh -D appuser
COPY package*.json ./
RUN npm ci --only=production      # Only prod deps (~50MB vs ~200MB)
COPY --from=builder /app/dist ./dist
USER appuser                      # Non-root
EXPOSE 3000
CMD ["node", "dist/server.js"]
`
Alpine base image (~5MB vs Ubuntu ~75MB). Result: ~120MB final image. No TypeScript compiler, no test frameworks, no .ts source files in production image.

**Scenario 2:** Your team's docker build takes 8 minutes in CI. Developers are frustrated. Profile the build and describe what optimizations you'd apply to bring it under 2 minutes.

*Profiling:* docker build --no-cache . 2>&1 | ts '%H:%M:%S' â€” timestamp each layer. Find the slow layers.
*Common findings and fixes:*
(1) 
pm install runs every build because COPY . . invalidates cache â†’ fix: COPY package*.json ./ then RUN npm ci before COPY . .. Brings npm install from 4min to 0 (cached).
(2) Build context is large (node_modules included) â†’ fix: .dockerignore with 
ode_modules, .git. Reduces context upload from 200MB to 5MB.
(3) TypeScript 	sc takes 2min â†’ fix: use 	sc --incremental and cache .tsbuildinfo. Or run TypeScript check in parallel with Docker build (separate CI step).
(4) CI pulls base image every run â†’ fix: Docker layer caching in CI (GitHub Actions: cache-from: type=gha).
Combined result: 8min â†’ ~90s.

## SECTION 6 — System Design Importance

The incident patterns above highlight key system design principles: design for failure, implement graceful degradation, enforce security boundaries at every layer, and monitor proactively. Each incident represents a production scenario that should inform your system design decisions.

## SECTION 7 — AWS & Cloud Mapping

AWS services directly relevant to these patterns: **ECS/Fargate** for container orchestration and task lifecycle management; **ECR** for secure image storage and scanning; **Secrets Manager / SSM Parameter Store** for runtime secret injection; **CloudWatch** for container metrics, logs, and alarms; **IAM** for fine-grained access control.

## SECTION 8 — Interview Preparation

**Beginner:**
- What are the most common production issues you've seen with this technology?
- How do you debug a service that is failing in production?

**Intermediate:**
- Walk through a real incident you've handled (or studied) — root cause, fix, and prevention.
- How do you build runbooks and post-mortems for recurring failure patterns?

**Advanced (System Design):**
- Design a production-grade deployment pipeline that catches the failure types described above before they reach production.
