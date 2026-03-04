# Containers vs Images

## SECTION 5 — Real World Example

> **Architect Training Mode** | Platform Engineer / DevOps Architect Perspective
> _Real failures. Real commands. Real fixes. Because incidents don't come with documentation._

---

### INCIDENT 01 — :latest Tag Silent Regression (Wrong Version in Production)

```
SYMPTOM:
  CI/CD pipeline passed. Tests passed. Deployment succeeded.
  But production behaves differently than staging — a feature that worked in staging
  now crashes in prod. Code hasn't changed. Team is confused.

ROOT CAUSE:
  ECS task definition uses: "image": "myapp:latest"

  Two weeks ago: myapp:latest = v1.4.2 (stable)
  CI built and pushed a new image without incrementing version.
  myapp:latest was silently overwritten with the new build.

  ECS deployment: pulled "latest" → got the new overwritten image.
  No one noticed. Logs show deploy succeeded.

  The regression was in a dependency update inside the Dockerfile:
    RUN npm ci  ← resolved new minor versions of packages (no package-lock update)
  New version of a package had a breaking change. "latest" now runs the broken package.

FIX:
  ECS task definition → always use immutable image tags:
    "image": "123456789.dkr.ecr.us-east-1.amazonaws.com/myapp:a3f7c9b"  ← git SHA

  CI pipeline:
    IMAGE_TAG=$(git rev-parse --short HEAD)
    docker build -t myapp:${IMAGE_TAG} .
    docker push $ECR_URI/myapp:${IMAGE_TAG}
    # Update ECS task definition with IMAGE_TAG (not :latest)

  Enable ECR immutable tags in the repository settings.
  With immutable tags: if someone tries to push myapp:latest again → ECR rejects it.
  Forces teams to use unique, content-addressable tags.

ROLLBACK WITH IMMUTABLE TAGS:
  # Find previous known-good git SHA from CI history
  # Update ECS task definition to previous SHA
  aws ecs register-task-definition --container-definitions \
    '[{"image": "123456789.dkr.ecr.us-east-1.amazonaws.com/myapp:a1b2c3d"}]' ...
  aws ecs update-service --cluster prod --service myapp --task-definition myapp:42
  # Service rolls back to exact previous image. Guaranteed.
  # With :latest: rollback means "we hope this is the old image" → not guaranteed.
```

---

### INCIDENT 02 — Disk Exhaustion on EC2 Host from Image Accumulation

```
SYMPTOM:
  At 2am: PagerDuty alert — EC2 instance disk usage at 95%.
  ECS can't pull new images for deployments — "no space left on device".
  Running tasks are fine. New deployments fail silently.
  Incident duration: 45 minutes until disk cleared.

ROOT CAUSE:
  EC2 host running ECS agent. Each deployment:
  1. Pulls new image version (200MB added to disk)
  2. Old image version NOT removed (ECS doesn't auto-clean old images)

  10 services × 5 deploys/day × 30 days × 200MB = 300GB
  EC2 has 50GB root volume. Math doesn't work. Disk fills in ~5 days.

  Also: dangling images from failed builds accumulate (untagged intermediate layers).
  Each failed CI run may leave 500MB of dangling layers on CI runners.

FIX — ECS agent image cleanup configuration:
  # /etc/ecs/ecs.config on EC2 ECS host:
  ECS_ENGINE_TASK_CLEANUP_WAIT_DURATION=1h        # clean task artifacts after 1h
  ECS_DISABLE_IMAGE_CLEANUP=false                 # enable automatic image cleanup
  ECS_IMAGE_CLEANUP_INTERVAL=30m                  # check for stale images every 30 min
  ECS_IMAGE_MINIMUM_CLEANUP_AGE=1h                # don't delete image used within 1h
  ECS_NUM_IMAGES_DELETE_PER_CYCLE=5               # delete up to 5 images per cleanup cycle
  ECS_EXCLUDE_UNTRACKED_IMAGE=false               # also clean untracked images

FIX — Manual emergency cleanup:
  docker image prune -af              # remove all unused images immediately
  docker system prune -af             # containers + images + networks + cache
  docker system df -v                 # diagnose what's using disk before pruning

FIX — Root volume size (prevent recurrence):
  ECS EC2 launch template → increase root volume to 100GB
  Or better: use ECS Fargate (no host to manage, no disk to fill)

FIX — CI/CD runner cleanup:
  # Add to end of every CI pipeline (GitHub Actions):
  - name: Docker cleanup
    if: always()                    # run even if build fails
    run: docker system prune -af

MONITORING:
  CloudWatch alarm: EC2 disk usage > 75% → SNS alert
  Metric: disk_used_percent from CloudWatch Agent
  Alarm action: notify + trigger automated cleanup Lambda
```

---

### INCIDENT 03 — Supply Chain Attack via Compromised Base Image (No Digest Pinning)

```
SYMPTOM:
  Security team gets alert: unusual outbound network traffic from production containers.
  Containers are exfiltrating environment variables to external IP.
  All containers share the same base image. All are compromised.

HYPOTHETICAL ROOT CAUSE (this attack pattern is real — ref: 2018 Docker Hub compromised images):
  Dockerfile:
    FROM node:20-alpine   ← tag, not digest

  Attacker compromises the official node:20-alpine image (or a third-party base image).
  Pushes malicious version under the same tag.
  Next CI build: pulls "node:20-alpine" → gets compromised image.
  Build succeeds. Tests pass (malware is passive until runtime).
  Compromised image ships to production.

MITIGATION — Pin base images by digest:
  # Get current digest:
  docker pull node:20-alpine
  docker inspect node:20-alpine --format='{{index .RepoDigests 0}}'
  # Output: node@sha256:a7c05c7ae043a0b8c818f471e6c8c42f4e78f43ced93e1a6f4b78f64...

  # Dockerfile with digest pin:
  FROM node@sha256:a7c05c7ae043a0b8c818f471e6c8c42f4e78f43ced93e1a6f4b78f64...
  # This image can NEVER change. Content-addressable identity.

MITIGATION — Automated base image updates (Dependabot / Renovate):
  Digest pinning defeats the purpose if you never update.
  Use Renovate Bot or Dependabot to:
    1. Detect new node:20-alpine releases
    2. Open PR with updated digest
    3. CI runs tests
    4. Human reviews + merges
  Controlled, auditable update process vs silent tag mutation.

MITIGATION — ECR pull-through cache:
  Pull base images through ECR pull-through cache.
  ECR scans images on pull with Amazon Inspector.
  If base image has CRITICAL CVE → alert before it enters your pipeline.

MITIGATION — Trivy in CI (scan every build):
  trivy image --severity CRITICAL --exit-code 1 myapp
  exit-code 1 → CI pipeline fails if any CRITICAL CVE found

  - Every image is scanned before being pushed to ECR
  - Malicious base image = injected malicious packages = CVE detected = build blocked
```

---

### INCIDENT 04 — Writable Layer Bloat Causing Container OOM / Storage Pressure

```
SYMPTOM:
  Containers have been running for 7 days.
  Gradually increasing memory and disk pressure.
  docker inspect <container> shows "SizeRw" (writable layer size) growing.
  Eventually: container killed (OOM or storage limit).
  After restart: container is fine — until it grows again.

ROOT CAUSE:
  Application writes logs to /app/logs/ inside the container.
  Log files accumulate in the writable layer over 7 days.
  Writable layer grows to 8GB.

  Secondary: application writes session files, temp uploads, compiled caches to
  the container filesystem instead of mounted storage.

FIX — Never write persistent data to container filesystem:
  Application logs:
    Use stdout + stderr ONLY. Docker captures them automatically.
    docker logs <container> — shows stdout/stderr
    ECS → CloudWatch Logs (captured from stdout/stderr automatically)
    Never: open('/app/logs/access.log', 'a') inside container
    Always: console.log() → stdout → log driver captures it

  Uploads / user files:
    Mount S3 or EFS. Never write to container filesystem.
    S3 presigned upload URL → client uploads directly → S3
    Container never touches user files.

  Temp files (/tmp):
    Acceptable in writable layer if bounded and short-lived.
    For larger temp files: mount a size-limited tmpfs:
      docker run --tmpfs /tmp:size=100m myapp

FIX — Read-only root filesystem (forces good behavior):
  docker run --read-only myapp
  ECS task definition: "readonlyRootFilesystem": true

  App MUST use mounted volumes for any writes.
  If app accidentally writes to container filesystem → immediate permission error.
  Better to fail fast than silently accumulate junk.

MONITORING:
  docker inspect <container> --format='{{.SizeRw}}'   # writable layer size
  ECS: Container Insights → container filesystem metrics
  Alert: writable layer > 500MB → investigate what's being written
```

---

### INCIDENT 05 — Missing Image After ECR Repository Deletion / Lifecycle Policy Misconfiguration

```
SYMPTOM:
  Rollback triggered after bad production deploy.
  Team runs: aws ecs update-service --task-definition myapp:prev
  ECS task fails to start. Error: "CannotPullContainerError: image not found"
  The previous stable image was deleted from ECR.

ROOT CAUSE 1 — ECR lifecycle policy too aggressive:
  Policy: delete images older than 7 days = any image over 7 days old is gone.
  Outage happens on day 8 → rollback target is 8 days old → deleted.

ROOT CAUSE 2 — Manual delete during housekeeping:
  Engineer "cleaned up" ECR, deleted images tagged "old".
  Those "old" images were the stable rollback targets.

FIX — Lifecycle policy with rollback-safe rules:
  # Production strategy:
  # - Keep all images tagged with "prod-" prefix permanently (until manually removed)
  # - Keep last 20 images by count regardless of age
  # - Delete untagged images after 1 day

  {
    "rules": [
      {
        "rulePriority": 1,
        "description": "Keep all production releases",
        "selection": {
          "tagStatus": "tagged",
          "tagPrefixList": ["prod-"],
          "countType": "imageCountMoreThan",
          "countNumber": 30
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
  }

FIX — Tag releases explicitly before deletion window:
  On every production deploy:
    docker tag myapp:${GIT_SHA} myapp:prod-${DATE}-${GIT_SHA}
    # "prod-2026-02-28-a3f7c9b" — unambiguous, never accidentally deleted

  Current production: also tag as "prod-current" (can be overwritten)
  Rollback targets: keep tagged with full datestamp → never deleted by policy

VERIFY:
  Before every production deploy: verify rollback target still exists:
    aws ecr describe-images --repository-name myapp \
      --image-ids imageTag=${ROLLBACK_TAG} || echo "ROLLBACK TARGET MISSING — ABORT"
```

---

### Debugging Toolkit

```bash
# ──────────────────────────────────────────────────────────────────────
# IMAGES
# ──────────────────────────────────────────────────────────────────────

docker images                               # list all local images
docker images myapp                         # list all tags of myapp
docker images --digests                     # show digests alongside tags
docker image inspect myapp:1.2.3            # full metadata JSON
docker image history myapp:1.2.3            # layer-by-layer breakdown
docker image ls --format "table {{.Repository}}\t{{.Tag}}\t{{.Size}}"

# ──────────────────────────────────────────────────────────────────────
# CONTAINERS
# ──────────────────────────────────────────────────────────────────────

docker ps                                   # running containers
docker ps -a                                # all containers (including stopped)
docker ps -a --format "table {{.Names}}\t{{.Status}}\t{{.Image}}"
docker inspect <container_id>               # full container config + state
docker inspect <container_id> --format='{{.State.Status}}'
docker inspect <container_id> --format='{{.SizeRw}}'    # writable layer size
docker stats                                # live CPU/memory/network stats
docker stats --no-stream                    # snapshot (not live)

# ──────────────────────────────────────────────────────────────────────
# FILESYSTEM / LAYERS
# ──────────────────────────────────────────────────────────────────────

docker diff <container>     # show what writable layer has changed (A=added, C=changed, D=deleted)
# Example output:
#   C /app
#   A /app/logs/access.log    ← file written to writable layer (not a volume — problem!)

# Find all files in a container's writable layer:
docker run --rm -it myimage find / -newer /etc/hostname 2>/dev/null

# ──────────────────────────────────────────────────────────────────────
# ECR COMMANDS
# ──────────────────────────────────────────────────────────────────────

# List all images in repository
aws ecr list-images --repository-name myapp
aws ecr describe-images --repository-name myapp

# Get digest for a specific tag
aws ecr describe-images --repository-name myapp \
  --image-ids imageTag=1.2.3 \
  --query 'imageDetails[0].imageDigest'

# Check if specific image exists (for rollback verification)
aws ecr describe-images --repository-name myapp \
  --image-ids imageTag=${ROLLBACK_TAG} \
  && echo "Image exists" || echo "Image NOT FOUND"

# ──────────────────────────────────────────────────────────────────────
# DISK CLEANUP
# ──────────────────────────────────────────────────────────────────────

docker system df                            # show space used by images/containers/volumes
docker system df -v                         # detailed breakdown
docker image prune                          # remove dangling images
docker image prune -a                       # remove all unused images (not referenced by container)
docker system prune -af                     # nuclear option: everything unused
docker container prune                      # remove all stopped containers
docker volume prune                         # remove unused anonymous volumes
```

## SECTION 6 — System Design Importance

The incident patterns above highlight key system design principles: design for failure, implement graceful degradation, enforce security boundaries at every layer, and monitor proactively. Each incident represents a production scenario that should inform your system design decisions.

## SECTION 7 — AWS & Cloud Mapping

AWS services directly relevant to these patterns: **ECS/Fargate** for container orchestration and task lifecycle management; **ECR** for secure image storage and scanning; **Secrets Manager / SSM Parameter Store** for runtime secret injection; **CloudWatch** for container metrics, logs, and alarms; **IAM** for fine-grained access control.

## SECTION 8 — Interview Preparation

**Beginner:**

**Q: What is the difference between a Docker image and a Docker container?**
**A:** A Docker image is the blueprint â€” a read-only snapshot of the filesystem and configuration. It's stored on disk (or in a registry) and doesn't do anything by itself. A Docker container is a running instance of an image â€” it's the image brought to life, with its own process(es), network interface, and a thin writable layer on top. Analogy: the image is a class definition in code; the container is an object (instance) created from that class. You can run 10 containers from the same image simultaneously â€” each gets its own isolated process and writable layer.

**Q: Why can multiple containers be created from the same image without interfering with each other?**
**A:** Each container gets its own isolated writable layer on top of the shared read-only image layers. When a container writes a file, it writes to its private writable layer â€” other containers see their own writable layers, not each other's. The underlying image layers are shared (read-only, never modified). This is Copy-on-Write (CoW): files are only copied to the container's writable layer when modified. This is why 10 containers from a 500MB image don't use 5GB of disk â€” they all share the same read-only layers.

**Q: What happens to data written inside a container when the container is stopped or deleted?**
**A:** It's lost. The container's writable layer is deleted when the container is removed. This is intentional â€” containers are designed to be ephemeral (short-lived, replaceable). Data that must persist (database files, user uploads) must be stored outside the container in: (1) Docker volumes (managed by Docker), (2) bind mounts (host directory), or (3) external storage (S3 for files, RDS for databases in AWS). Never depend on a container's writable layer for important data.

---

**Intermediate:**

**Q: What is a Docker image manifest and what are multi-platform (multi-arch) images?**
**A:** An image manifest is metadata describing the image: the ordered list of layers, platform (linux/amd64, linux/arm64), and config. A multi-platform image has multiple manifests behind one tag â€” 
ode:20-alpine works on both Intel/AMD servers and Apple M-chip Macs. Docker automatically pulls the right variant for the current architecture. Production relevance: AWS Graviton (ARM64) instances cost 30% less than x86. If you build your Docker image only for linux/amd64 and deploy to Graviton, it fails. Build multi-arch: docker buildx build --platform linux/amd64,linux/arm64 -t myapp:v1 --push .

**Q: How do you inspect the layer composition of a Docker image to understand what's making it large?**
**A:** docker history myimage:v1 â€” lists all layers, the command that created each, and the size. Reveals which Dockerfile instruction added large files. For deeper analysis: dive myimage:v1 (open-source tool) â€” interactive TUI showing each layer and exactly which files are added/removed. Look for: large COPY layers (is node_modules being copied?), 
pm install producing huge devDependency tree, duplicate copies of same files across layers. Also: docker image inspect myimage:v1 | jq '.[0].Size' â€” total image size in bytes.

**Q: What is image tagging strategy in production and why does it matter for rollback?**
**A:** Image tags are mutable by default â€” myapp:latest can be overwritten. This is dangerous: a failed docker pull myapp:latest on 3 servers might pull different images if the tag was just pushed. Production best practice: tag images with the Git commit SHA (myapp:a3f8b12). This is immutable â€” that exact image is always that exact code. Tag strategy: myapp:a3f8b12 (exact commit), myapp:main-20240115 (branch + date), myapp:latest (just for convenience, pointing to same image). Rollback: docker pull myapp:a3f8b12 â€” exact previous version, guaranteed.

---

**Advanced (System Design):**

**Scenario 1:** Your ECS service has 6 running tasks (containers). You deploy a new image version. ECS uses rolling deployment (replace 2 at a time). During deployment, the new container version has a bug introduced by a new environment variable that wasn't set correctly. Design a deployment configuration and monitoring setup that: detects the problem within 2 minutes and automatically rolls back.

*Configuration:* ECS deployment circuit breaker enabled (deploymentCircuitBreaker: { rollback: true }). ECS health check: HTTP check on /health endpoint, 3 consecutive failures = unhealthy. ALB target group health check: 30s interval, 2 unhealthy threshold. CloudWatch alarm: HealthyHostCount < 4 triggers SNS alert.
*Flow:* 2 new tasks start â†’ ECS health check runs â†’ new tasks crash (missing env var â†’ process exits) â†’ ECS marks them unhealthy â†’ circuit breaker detects > 50% failure â†’ automatic rollback to previous task definition. Total time: ~90 seconds. Old 4 tasks never had traffic interrupted.

**Scenario 2:** Your squad has 3 microservices: auth, orders, and notifications. The notification service depends on a shared internal package that's used in all 3. A developer accidentally deleted the shared package's image from ECR. The build pipeline needs the image to create the package layer. How do you recover and how do you prevent image deletion in the future?

*Recovery:* Check if docker history is intact on any developer machine or CI runner with a cached layer. If the layer is cached locally: docker tag sha256:{layer-hash} myregistry/shared-pkg:v2.3 and push back to ECR. If no cached image: rebuild from source in Git (the code isn't lost). Accelerate by running all 3 microservice builds in parallel pointing to freshly rebuilt shared package.
*Prevention:* (1) ECR image immutability â€” enable imageTagMutability: IMMUTABLE so existing tags cannot be overwritten. (2) ECR lifecycle policy exceptions â€” protect tagged images (never delete * tags, only delete latest after 30 days). (3) Require PR review for any ECR policy changes. (4) Archive to S3: CI pipeline saves image digests to S3 as audit log. (5) Separate ECR repositories per environment â€” prod images never in same repo as dev/CI scratch images.

