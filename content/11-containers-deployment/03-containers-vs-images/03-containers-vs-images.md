# Containers vs Images

## FILE 03 OF 03 — Design Decisions, Interview Q&A & Architect's Mental Model

> **Architect Training Mode** | Platform Engineer / DevOps Architect Perspective
> _Optimized for: design reviews · system design interviews · architecture decisions under pressure_

---

## SECTION 9 — Certification Focus (AWS SAA-C03)

### Decision 1: Tag Strategy — What to Use in Production

```
TAGGING STRATEGY DECISION MATRIX:

┌────────────────────┬─────────────────┬────────────────────────────────────────────────┐
│ Tag Pattern        │ Mutability      │ Use Case                                       │
├────────────────────┼─────────────────┼────────────────────────────────────────────────┤
│ :latest            │ Mutable (bad)   │ Never in production task definitions           │
│ :1.2.3 (semver)    │ Should be fixed │ User-facing versioned releases                 │
│ :a3f7c9b (git SHA) │ Immutable       │ All CI/CD deployments. Exact traceability.     │
│ :prod-2026-02-28   │ Immutable       │ Rollback-safe snapshots of production releases │
│ :staging, :dev     │ Mutable         │ Environment promotion (non-production only)    │
└────────────────────┴─────────────────┴────────────────────────────────────────────────┘

RECOMMENDED PRODUCTION PATTERN:

  Every CI build:
    IMAGE_TAG=$(git rev-parse --short HEAD)
    docker tag myapp:${IMAGE_TAG}              ← git SHA tag (primary identifier)
    docker push $ECR_URI/myapp:${IMAGE_TAG}

  On production deploy (after approval gate):
    DATE=$(date +%Y-%m-%d)
    docker tag $ECR_URI/myapp:${IMAGE_TAG} $ECR_URI/myapp:prod-${DATE}-${IMAGE_TAG}
    docker push $ECR_URI/myapp:prod-${DATE}-${IMAGE_TAG}
    ← this tag is protected by ECR lifecycle policy (never auto-deleted)

  ECS task definition always references:
    "image": "...myapp:a3f7c9b"   ← exact SHA, never ":latest"

WHY SEMVER TAGS ALONE ARE NOT ENOUGH:
  You deploy v1.2.3. Bug found. Fix is tiny. You build and push v1.2.3 again.
  (Without ECR immutable tags, this is possible and happens).
  Old v1.2.3 and new v1.2.3 are different images with same tag.
  Rollback to v1.2.3 → you don't know which one you're getting.
  Git SHA solves this: a3f7c9b = exactly that commit. Forever.
```

### Decision 2: When to Use Digest Pinning in FROM

```
FROM node:20-alpine       → tag reference (mutable — can change under you)
FROM node@sha256:abc...   → digest reference (immutable — always same image)

USE DIGEST PINNING WHEN:
  ✅ High-security environments (financial, healthcare, regulated industries)
  ✅ Air-gapped environments where supply chain integrity is critical
  ✅ After a base image audit — "freeze this exact version"
  ✅ Compliance requirements mandate reproducible builds

DON'T USE DIGEST PINNING IF:
  ✗ You have no automated update mechanism for the pinned digest
    (Security vulnerability fixed in base image → your pin shields the old vuln)
  ✗ Small team without tooling (Renovate/Dependabot) to manage digest updates

BALANCED APPROACH:
  Use Renovate Bot:
    1. Pin base image by digest in Dockerfile
    2. Renovate detects new node:20-alpine release
    3. Renovate opens PR: "Update node digest to sha256:newdigest"
    4. CI runs → tests → human reviews → merge
    → Immutable + automatically kept current + audited update history
```

### Decision 3: Volumes — Named Volume vs Bind Mount vs tmpfs

```
┌──────────────────┬───────────────────────────────────────────────────────────────┐
│ Type             │ When to Use                                                   │
├──────────────────┼───────────────────────────────────────────────────────────────┤
│ Named Volume     │ Database data, persistent app state. Managed by Docker.       │
│                  │ Survives container recreate. docker volume ls to inspect.     │
│                  │ Production: use EFS (multi-AZ, durable) on ECS.              │
├──────────────────┼───────────────────────────────────────────────────────────────┤
│ Bind Mount       │ Local dev: sync host source code into container.             │
│                  │ docker run -v $(pwd):/app mydev                              │
│                  │ Never in production: ties container to host filesystem path.  │
├──────────────────┼───────────────────────────────────────────────────────────────┤
│ tmpfs            │ Ephemeral in-memory storage. Temp files, lock files.         │
│                  │ docker run --tmpfs /tmp:size=100m myapp                      │
│                  │ Disappears on container stop. Fast. No disk I/O.            │
└──────────────────┴───────────────────────────────────────────────────────────────┘

PRODUCTION RULE:
  Application state that needs to persist → EFS or S3 mounted via task definition
  Application logs → stdout/stderr (no volume needed, captured by log driver)
  Temp files → tmpfs or S3 presigned URL (client uploads directly)
  Database → RDS (not a container volume — use managed service for production DBs)

BIND MOUNT TRAP IN DEVELOPMENT:
  docker run -v $(pwd):/app -v /app/node_modules myapp
  The second -v anonymously mounts node_modules BACK from the container.
  This prevents the host's node_modules from overwriting the container's.
  If you forget this, your Alpine-compiled modules get replaced by your macOS modules → crashes.
```

---

## SECTION 10 — Comparison Table

```
TRAP 1: "Containers are lightweight VMs"
  WRONG. Containers share the HOST kernel. VMs have their own kernel (guest OS).
  Container isolation = Linux namespaces + cgroups.
  VM isolation = hypervisor + separate kernel per VM.
  Practical: kernel vulnerability affects all containers on the host simultaneously.
  Kernel vulnerability in a VM: host kernel isolated from guest. Guest compromised, host OK.

TRAP 2: "EXPOSE in Dockerfile publishes the port"
  WRONG. EXPOSE is documentation/metadata.
  Port doesn't bind to host. Container is still unreachable from outside Docker network.
  docker run -p 8080:8080 or docker-compose ports: - "8080:8080" is required.
  In ECS: portMappings in task definition handles this. EXPOSE is informational.

TRAP 3: "Deleting a container deletes the image"
  WRONG. Containers are instances. Deleting a container removes only was writable layer.
  The image remains until explicitly deleted with docker rmi or docker image rm.
  10 containers from same image → delete all 10 → image still on disk.

TRAP 4: "docker stop immediately terminates the container"
  WRONG. docker stop sends SIGTERM, then waits stopTimeout (default 10s).
  If process handles SIGTERM and exits cleanly → done immediately (< 10s).
  If no handler: waits 10s, then sends SIGKILL (hard kill).
  docker kill sends SIGKILL immediately (no grace period).

TRAP 5: "Two containers from same image see each other's filesystem"
  WRONG. Each container has its own writable layer.
  Writes in container A are invisible to container B.
  They share the read-only image layers (can READ the same base files).
  Runtime writes: isolated per container.

TRAP 6: "Image layers are just directories"
  NOT EXACTLY. Layers are content-addressable tarballs identified by SHA256 digest.
  OverlayFS presents them as a unified filesystem, but storage is layered tarballs.
  This is why: deleting a file in a new layer still shows the file was in old layer,
  you need multi-stage builds to truly eliminate files from the image.

TRAP 7: "Larger image = more memory usage when running"
  NOT DIRECTLY. Image size ≈ disk/pull cost, not memory cost.
  Container memory = process memory (RAM), not filesystem size.
  A 1GB image might run a process using 128MB RAM.
  BUT: larger images include more code → more exploitable surface → more CVEs.
```

---

## SECTION 11 — Quick Revision

**Q: What's the difference between a container and an image?**

> An image is an immutable layered filesystem snapshot — a blueprint. A container is a running instance of an image with its own writable layer on top. The image never changes; the running container adds a thin writable layer for runtime state. Multiple containers can run from the same image simultaneously, sharing the read-only layers and saving disk space via OverlayFS copy-on-write semantics.

**Q: How does Docker use less memory than a VM?**

> Containers share the host kernel via Linux namespaces and cgroups. There's no guest OS running inside the container — just your process. A VM requires a full guest kernel, system libraries, and OS processes (~1-2GB overhead per VM). A container's overhead is ~10-50MB — essentially just the process plus OverlayFS writable layer metadata. Ten containers share one kernel; ten VMs need ten kernels.

**Q: Why should you never use :latest in a production ECS task definition?**

> Because `:latest` is a mutable tag — it points to whatever was pushed most recently. When ECS launches a new task (during scaling or deployment), it pulls the current `:latest`, which might be a different image than what was tested. You lose reproducibility, rollback guarantee, and traceability. Use Git SHA tags: `myapp:a3f7c9b` — that reference is immutable, traceable to exact code, and enables precise rollbacks.

**Q: What happens to data written inside a container when the container is removed?**

> It's gone. The container's writable layer is deleted with `docker rm`. This is by design — containers are ephemeral. Any data that must persist must be stored outside the container: named volumes, bind mounts (dev only), or cloud storage (S3/EFS for production). For application logs: always write to stdout/stderr so the Docker log driver captures them independently of the container lifecycle.

**Q: What is OverlayFS and how does it relate to container isolation?**

> OverlayFS is Docker's default storage driver. It merges multiple read-only layers (the image) with a single writable layer (the container) into one unified filesystem view. Lower layers are shared across containers; the upper layer is unique per container. When a container writes to a file that exists in a lower layer, OverlayFS triggers copy-on-write: copies the file to the writable layer, then writes there, leaving the original layer untouched.

**Q: How would you prevent a supply chain attack through a compromised base image?**

> Three layers of defense: pin the base image by digest in the Dockerfile (immutable identity, not a mutable tag), use automated tooling like Renovate to manage digest updates with PR review, and run Trivy vulnerability scanning in CI on every image build with `--exit-code 1` to fail the build on critical CVEs. Additionally, configure ECR pull-through cache with Amazon Inspector scanning so compromised base images are flagged before entering your pipeline.

---

## SECTION 12 — Architect Thinking Exercise

```
┌─────────────────────────────────────────────────────────────────────┐
│            CONTAINERS vs IMAGES ARCHITECT'S MENTAL MODEL            │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  RULE 1: Image = fact. Container = event.                           │
│  ─────────────────────────────────────────────────────────────────  │
│  The image is a stable, versioned artifact. It doesn't change.      │
│  The container is an ephemeral runtime event. It starts and stops.  │
│  Design your system so that container death loses nothing           │
│  important — all persistent state lives outside the container.      │
│                                                                     │
│  RULE 2: Tags are promises. Digests are facts.                      │
│  ─────────────────────────────────────────────────────────────────  │
│  A tag says "this was version 1.2.3 when we pushed it."            │
│  A digest says "this is exactly this content, cryptographically."   │
│  Production deployments should reference facts, not promises.       │
│  Git SHA tags are the practical compromise: meaningful + immutable. │
│                                                                     │
│  RULE 3: The writable layer is not storage                          │
│  ─────────────────────────────────────────────────────────────────  │
│  The writable layer is for process temp state only.                 │
│  Use it like RAM — cheap, fast, expendable, gone when done.         │
│  Any data you care about: volumes, S3, RDS, EFS.                   │
│  Force good behavior: readonlyRootFilesystem: true in production.   │
│                                                                     │
│  RULE 4: Shared kernel = shared responsibility                      │
│  ─────────────────────────────────────────────────────────────────  │
│  Containers are not VMs. Security isolation is at the kernel level. │
│  A CVE in the host kernel affects every container.                  │
│  Defense: keep host kernel patched, use Fargate (AWS manages host), │
│  run non-root, drop capabilities, enable seccomp profiles.          │
│                                                                     │
│  RULE 5: Registry is your source of truth for deployment history    │
│  ─────────────────────────────────────────────────────────────────  │
│  ECR is not just a cache — it's your deployment audit log.         │
│  Every production image should be tagged with git SHA + date.       │
│  Image lifecycle policies are mandatory — not optional cleanup.     │
│  Rollback requires the image to still exist in the registry.        │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│  3 MISTAKES EVERY JUNIOR ENGINEER MAKES:                            │
│  1. :latest in ECS task definition → silent regression, no          │
│     reliable rollback, mystery incidents                            │
│  2. Logging to container filesystem (/app/logs/) → writable layer  │
│     bloat → OOM → ECS task killed → logs lost                       │
│  3. No ECR lifecycle policy → disk fills CI runners / EC2 hosts →  │
│     3am incident caused by "ran out of disk space"                  │
├─────────────────────────────────────────────────────────────────────┤
│  30-SECOND SYSTEM DESIGN ANSWER:                                    │
│  ─────────────────────────────────────────────────────────────────  │
│  "I treat images as immutable versioned artifacts tagged with git   │
│  SHA, stored in ECR with lifecycle policies and immutable tag        │
│  enforcement. Containers are ephemeral — any persistent state goes  │
│  to S3, RDS, or EFS, never the container filesystem. ECS task       │
│  definitions always reference exact git SHA tags, enabling          │
│  deterministic rollbacks. For security: containers run non-root     │
│  with read-only root filesystems, and every image is Trivy-scanned  │
│  in CI before being pushed to ECR."                                  │
└─────────────────────────────────────────────────────────────────────┘
```
