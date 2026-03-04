# Containers vs Images

## FILE 01 OF 03 — Core Concepts, Architecture & Production Patterns

> **Architect Training Mode** | Platform Engineer / DevOps Architect Perspective
> _Optimized for: design judgement · tradeoff evaluation · failure prediction · production debugging_

---

## SECTION 1 — Intuition (Explain Like a 12-Year-Old)

```
IMAGE = IMMUTABLE BLUEPRINT
  Like a class definition in OOP.
  Built once. Read-only forever. Never changes after creation.
  Can be shared, versioned, tagged, pushed to a registry.
  Exists on disk as a stack of read-only layers.

CONTAINER = IMAGE + WRITABLE LAYER (running instance)
  Like an object instantiated from a class.
  Created FROM an image. Has its own writable layer on top.
  Any file writes during runtime go to the writable layer only.
  When container is deleted → writable layer is gone. Image unchanged.
  Multiple containers can run from the same image simultaneously.

ANALOGY:
  Image    = Cookie cutter (mold, reusable, unchanged)
  Container = Cookie (created from mold, unique, edible/destroyable)

  Image    = Class definition
  Container = Instance of that class

PRACTICAL IMPLICATION:
  docker run myapp        # creates container 1 (image unchanged)
  docker run myapp        # creates container 2 (same image, separate writable layer)
  docker run myapp        # creates container 3 (same image, separate writable layer)

  All 3 containers share the read-only image layers (disk efficient).
  Each has an isolated writable layer (no interference between containers).
  Deleting any container does NOT affect the image or other containers.
```

---

## SECTION 2 — Core Technical Explanation

```
LAYER STACK (reading top to bottom):

  ┌─────────────────────────────────────────┐  ← CONTAINER WRITABLE LAYER (ephemeral)
  │  /app/logs/access.log (runtime writes)  │    Deleted when container removed
  │  /tmp/uploads/ (runtime temp files)     │
  ├─────────────────────────────────────────┤
  │  IMAGE LAYER 4: COPY dist/ (app code)   │  ← Read-only (frozen at build)
  ├─────────────────────────────────────────┤
  │  IMAGE LAYER 3: RUN npm ci              │  ← Read-only (node_modules frozen)
  ├─────────────────────────────────────────┤
  │  IMAGE LAYER 2: COPY package*.json      │  ← Read-only
  ├─────────────────────────────────────────┤
  │  IMAGE LAYER 1: FROM node:20-alpine     │  ← Read-only base OS + Node.js
  └─────────────────────────────────────────┘

HOW OVERLAYFS WORKS:
  OverlayFS (the default storage driver) MERGES all layers into a single filesystem view.
  When you docker exec -it mycontainer sh and run ls /app, you see everything.
  The layers are separate on disk but appear unified in the container.

  LOWER DIRS: read-only image layers (stacked, cached, shareable)
  UPPER DIR:  writable layer for the specific container instance
  MERGED DIR: what the container sees (union of all layers)

COPY-ON-WRITE (CoW):
  What happens when a container writes to a file that exists in a read-only layer:

  1. Container tries to write to /app/config.json (exists in image layer 3)
  2. OverlayFS detects it's a read-only layer — triggers copy-on-write
  3. Copies /app/config.json to the container's writable layer
  4. Write happens on the writable layer copy
  5. Container now reads the writable-layer version (shadows the image version)
  6. Image layer 3's config.json is UNTOUCHED

  IMPLICATION: Don't write large files in containers (logs, uploads).
  CoW copy of a large file = expensive I/O. Use mounted volumes instead.

DISK SHARING BENEFIT:
  10 containers running node:20-alpine base?
  Alpine base layer: stored ONCE on disk, shared by all 10 containers.
  No duplication. Just one pointer per container to the shared layer.
  Only the writable layer is unique per container (usually tiny).
```

---

## SECTION 3 — Architecture Diagram (MANDATORY)

```
IMAGE TAG:
  A mutable pointer to an image. Like a DNS name.
  myapp:latest      ← points to "the most recent" — CHANGES over time
  myapp:1.2.3       ← version tag — should be immutable by convention
  myapp:prod        ← environment tag — MOVES on every production deploy

  Tags are NOT immutable. docker push overwrites a tag silently.
  myapp:latest today is NOT the same image as myapp:latest next week.

IMAGE DIGEST (SHA256):
  Content-addressable, immutable, unique identifier.
  docker pull myapp@sha256:a3f7c9b2e4d8f1a6...  ← will ALWAYS be the same image
  Digest = cryptographic hash of the image manifest content.
  If any layer changes → digest changes. Guaranteed.

  GET DIGEST:
    docker inspect myapp:1.2.3 --format='{{index .RepoDigests 0}}'
    docker images --digests

IMAGE MANIFEST:
  JSON document describing the image.
  Contains: list of layer digests, image config, architecture, OS.
  Two formats:
    Image Manifest v2     — single architecture image
    Image Index (OCI)     — multi-arch manifest (arm64 + amd64 under one tag)

MULTI-ARCH IMAGES:
  docker pull node:20-alpine  ← works on Intel Mac, M1 Mac, ARM server, AWS Graviton
  How? Docker pulls the manifest for YOUR platform automatically.

  Build multi-arch:
    docker buildx build --platform linux/amd64,linux/arm64 -t myapp:1.0.0 --push .

  AWS Graviton (ARM) is 20-40% cheaper than x86 for same workload.
  Multi-arch image = no code changes needed to use cheaper hardware.

TAG STRATEGY:
  BAD:  myapp:latest (ambiguous, mutable, causes silent regressions)
  GOOD: myapp:1.2.3 (semantic version, stable reference for rollback)
  BEST: myapp:a3f7c9b (git SHA — exact code version, fully traceable)

  Production standard:
    CI builds: myapp:${GIT_SHA}
    Stable release: myapp:v1.2.3 AND myapp:${GIT_SHA} (two tags, same image)
    ECS task definition references: myapp:${GIT_SHA} (never :latest)
```

---

## SECTION 4 — Request Flow (MANDATORY FLOWCHART)

```
LINUX NAMESPACES — how containers are isolated from each other and host:

┌──────────────────┬──────────────────────────────────────────────────────────┐
│ Namespace        │ What it isolates                                         │
├──────────────────┼──────────────────────────────────────────────────────────┤
│ PID              │ Process IDs. Container's PID 1 ≠ host PID 1.            │
│                  │ Container can't see host processes (ps aux shows only    │
│                  │ container processes). Host can see container PIDs.       │
├──────────────────┼──────────────────────────────────────────────────────────┤
│ Network          │ Container gets its own network interface, IP, routing.  │
│                  │ eth0 inside container ≠ eth0 on host.                   │
│                  │ Ports inside container don't auto-expose to host.       │
├──────────────────┼──────────────────────────────────────────────────────────┤
│ Mount (mnt)      │ Container filesystem tree. Container sees its own /,    │
│                  │ /proc, /sys etc. — not the host's.                       │
├──────────────────┼──────────────────────────────────────────────────────────┤
│ UTS              │ Hostname and domain name. Container has its own          │
│                  │ hostname (usually container ID or custom hostname).      │
├──────────────────┼──────────────────────────────────────────────────────────┤
│ IPC              │ Inter-process communication. Shared memory segments.     │
│                  │ Containers can't share memory with other containers.     │
├──────────────────┼──────────────────────────────────────────────────────────┤
│ User             │ User and group IDs. UID 1000 in container ≠ UID 1000    │
│                  │ on host (when user namespace enabled).                   │
└──────────────────┴──────────────────────────────────────────────────────────┘

WHAT IS NOT ISOLATED:
  Kernel: all containers share the HOST kernel.
  This is the fundamental difference between containers and VMs.
  VM: separate kernel per VM (guest OS). True isolation.
  Container: shared kernel. Kernel exploits can affect all containers on host.
  This is why:
    - Non-root users matter (kernel privilege escalation risk)
    - Privileged containers are dangerous (direct kernel access)
    - Distroless + seccomp profiles are production best practice

CONTAINERS vs VMs:
  VM:        Hardware → Hypervisor → Guest OS (per VM) → App
  Container: Hardware → Host OS → Container Runtime → App (shared kernel)

  VMs:       Boot time 30-60s, 1-2GB memory overhead per instance, full isolation
  Containers: Start time 50ms-2s, 10-50MB overhead per instance, shared kernel
```

---

### Image Registries (ECR, Docker Hub, GHCR)

```
HOW DOCKER PULL WORKS:
  1. docker pull myapp:1.2.3
  2. Docker resolves registry (default: registry-1.docker.io for Docker Hub)
  3. Fetches image manifest from registry (list of layer digests)
  4. For each layer: checks local cache (by digest)
  5. Downloads only layers not already cached
  6. Unpacks and stores with OverlayFS

REGISTRY COMPARISON:

┌─────────────────┬────────────────────────────────────────────────────────────┐
│ Registry        │ Best For                                                   │
├─────────────────┼────────────────────────────────────────────────────────────┤
│ ECR (AWS)       │ Production on AWS. Private. IAM auth. Same-region pulls   │
│                 │ free + fast. Native integration with ECS/EKS/Fargate.     │
│                 │ Immutable tags feature. Lifecycle policies.               │
├─────────────────┼────────────────────────────────────────────────────────────┤
│ Docker Hub      │ Public base images (node, nginx, postgres official images)│
│                 │ Rate-limited (100 pulls/6h unauthenticated, 200 authed).  │
│                 │ Avoid for private production images.                      │
├─────────────────┼────────────────────────────────────────────────────────────┤
│ GHCR            │ GitHub Packages. Free for public repos. Good for          │
│                 │ open-source. Integrates with GitHub Actions workflows.    │
├─────────────────┼────────────────────────────────────────────────────────────┤
│ GAR (GCP)       │ Production on GCP. Google Artifact Registry.              │
└─────────────────┴────────────────────────────────────────────────────────────┘

ECR AUTHENTICATION (required before push/pull):
  aws ecr get-login-password --region us-east-1 \
    | docker login --username AWS --password-stdin \
      123456789.dkr.ecr.us-east-1.amazonaws.com

PUSH TO ECR:
  # Tag with ECR URI
  docker tag myapp:1.2.3 123456789.dkr.ecr.us-east-1.amazonaws.com/myapp:1.2.3
  # Push
  docker push 123456789.dkr.ecr.us-east-1.amazonaws.com/myapp:1.2.3

ECR IMMUTABLE TAGS:
  Enable in ECR repository settings: "Tag immutability: Enabled"
  Prevents overwriting an existing tag (once myapp:1.2.3 is pushed, it can't be overwritten)
  Protects production deployments: tag always refers to the same image digest
  Best practice for production repositories

DOCKER HUB RATE LIMITS (affects CI/CD):
  CI pulling node:20-alpine from Docker Hub → hits rate limit at 200 pulls/6h
  Fix: mirror base images to ECR (pull once, cache in your account):
    aws ecr create-repository --repository-name node-cache
    docker pull node:20-alpine
    docker tag node:20-alpine 123456789.dkr.ecr.us-east-1.amazonaws.com/node-cache:20-alpine
    docker push 123456789.dkr.ecr.us-east-1.amazonaws.com/node-cache:20-alpine
    # CI now pulls from ECR (no rate limit, faster, no external dependency)
```

---

### Container Lifecycle

```
CONTAINER STATES:
  created   → docker create myimage (container created, not started)
  running   → docker start <id> | docker run myimage
  paused    → docker pause <id> (SIGSTOP to all container processes)
  stopped   → docker stop <id> (SIGTERM → wait → SIGKILL)
  dead      → error state (couldn't be properly stopped/removed)
  removed   → docker rm <id> (container gone, writable layer deleted)

KEY LIFECYCLE EVENTS:

  docker run myimage
  ├── 1. Pull image if not cached
  ├── 2. Create container (writable layer allocated)
  ├── 3. Assign network interface + IP
  ├── 4. Mount namespaces (PID, network, mount, UTS, IPC)
  ├── 5. Execute ENTRYPOINT/CMD as PID 1
  └── Container is now running

  docker stop mycontainer
  ├── 1. Send SIGTERM to PID 1
  ├── 2. Wait stopTimeout seconds (default: 10s)
  ├── 3. If still running: send SIGKILL (immediate kill)
  └── Container is stopped (writable layer still exists)

  docker rm mycontainer
  └── Delete writable layer (container data gone forever)

IMPORTANT:
  Stopped container still exists (docker ps -a shows it).
  Its writable layer is still on disk.
  docker start <stopped_container> → resumes from stopped state.
  docker rm is needed to actually free disk space.

VOLUME vs WRITABLE LAYER:
  Writable layer: deleted with docker rm. Don't store important data here.
  Named volume: persists independently of container lifecycle.
  Bind mount: maps host directory into container.

  Use volumes for: databases, user uploads, log files, any persistent data.
  Writable layer is for: ephemeral runtime artifacts, temp files.
```

---

### Production Image Hygiene & Cost Model

```
IMAGE PRUNING (prevent disk exhaustion on CI/CD hosts):
  docker image prune         # remove dangling images (untagged intermediate layers)
  docker image prune -a      # remove ALL unused images
  docker system prune -af    # containers + images + networks + build cache
  docker system df           # show disk usage breakdown

  Without pruning:
    CI host builds images daily → disk fills → CI fails → engineers confused
    Production EC2 host → images accumulate → disk alert at 80% → incident

ECR LIFECYCLE POLICY (reduce storage cost):
  Keep: last 10 tagged production images
  Delete: untagged images after 1 day, old versions after 30 days
  Cost impact: 100 image versions × 200MB = 20GB = $2/month → 10 versions = $0.20/month

PULL-THROUGH CACHE (ECR feature):
  Configure ECR to proxy Docker Hub pulls.
  aws ecr create-pull-through-cache-rule \
    --ecr-repository-prefix "docker-hub" \
    --upstream-registry-url "registry-1.docker.io"

  docker pull 123456789.dkr.ecr.us-east-1.amazonaws.com/docker-hub/node:20-alpine
  First pull: ECR fetches + caches from Docker Hub.
  Subsequent pulls: served from ECR (no rate limit, faster, survivable if Docker Hub is down).

ECR SCANNING (vulnerability detection):
  Enable in ECR: "Scan on push: Enhanced scanning (inspector)"
  Every image push → automatic CVE scan → findings in Security Hub
  Block deployment if CRITICAL CVEs found (can enforce via CI check on ECR findings).
```
