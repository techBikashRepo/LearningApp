# Dockerfile

## FILE 03 OF 03 — Design Decisions, Interview Q&A & Architect's Mental Model

> **Architect Training Mode** | Platform Engineer / DevOps Architect Perspective
> _Optimized for: design reviews · system design interviews · architecture decisions under pressure_

---

## SECTION 9 — Certification Focus (AWS SAA-C03)

### Decision 1: Alpine vs Debian vs Distroless

```
DECISION MATRIX:

┌──────────────────────────────────┬──────────┬──────────┬──────────────────────────────────────────┐
│ Scenario                         │ Choice   │ Size     │ Reason                                   │
├──────────────────────────────────┼──────────┼──────────┼──────────────────────────────────────────┤
│ Standard Node.js API             │ Alpine   │ ~135 MB  │ curl available, small, well-maintained   │
│ App with bcrypt/sharp/canvas     │ Slim     │ ~240 MB  │ glibc needed for prebuilt native modules │
│ High-security workload           │ Distroless│ ~110 MB │ No shell = no exec = smaller attack      │
│ Go/Rust static binary            │ Scratch  │ ~0 MB    │ Binary is self-contained, needs nothing  │
│ Dev/debug environment            │ Full     │ ~950 MB  │ apt, curl, vim, bash all available       │
└──────────────────────────────────┴──────────┴──────────┴──────────────────────────────────────────┘

THE MUSL LIBC TRAP (Alpine):
  Alpine uses musl libc, not glibc.
  Prebuilt native Node.js npm packages (bcrypt, sharp, sqlite3) target glibc.
  They may silently fail on Alpine with SIGILL or missing symbol errors.
  Test: docker run node:20-alpine -e "require('bcrypt')" → ENOENT or SIGILL
  Fix options:
    a) Switch to node:20-slim (Debian, has glibc)
    b) Use build stage to compile native modules from source on Alpine
    c) Use alternative pure-JS modules (bcryptjs instead of bcrypt)

SECURITY DECISION — Distroless:
  Benefits:
    - No shell → developer cannot exec into container (attack vector eliminated)
    - No package manager → no apk/apt install → no supply chain risk
    - CVE surface: only your app + Node.js runtime, nothing else
  Drawbacks:
    - Cannot docker exec for debugging (use ephemeral debug sidecar: kubectl debug)
    - Dockerfile must be multi-stage (no tools to run inside distroless)
    - Harder to troubleshoot novel issues in production

  Rule of thumb:
    Security-critical services (payment, auth) → distroless
    Standard services → alpine
    Teams without k8s/ephemeral debug access → alpine (operational pragmatism)
```

### Decision 2: Multi-Stage Build — When It's Required vs Nice-to-Have

```
ALWAYS USE MULTI-STAGE FOR:
  ✅ Any compiled language (TypeScript, Go, Rust, Java)
     Build requires compiler/bundler. Runtime does not.
  ✅ Any environment with devDependencies (test frameworks, linters)
     prod image should not contain jest, eslint, ts-node, etc.
  ✅ Security-sensitive services
     Smaller image = smaller CVE surface = faster security scans
  ✅ Services with many deploys/day
     Small image → fast pull → faster cold start → better auto-scaling response

SINGLE-STAGE IS OK FOR:
  Pure Python API with no build step (copy source, pip install, done)
  Internal tooling with no security sensitivity
  Prototypes where you're still figuring out the architecture

MULTI-STAGE TEMPLATE VARIATIONS:
  2-stage: builder → runtime  (most common)
  3-stage: deps → builder → runtime  (separate dep install for cache optimization)
  4-stage: deps → test → builder → runtime  (run tests in CI inside Docker)

  4-stage with test:
    FROM node:20-alpine AS test
    COPY --from=deps /app/node_modules ./node_modules
    COPY . .
    RUN npm run test    # CI: build fails here if tests fail

    FROM node:20-alpine AS builder
    COPY --from=test /app ./       # only proceed to build if tests passed
    RUN npm run build
```

### Decision 3: ENTRYPOINT vs CMD — When to Use Which

```
CMD ONLY (most Node.js services):
  CMD ["node", "dist/server.js"]
  → Simple. Default command. Easily overrideable:
    docker run myimage node dist/worker.js
    docker run myimage node dist/migration.js

ENTRYPOINT + CMD (when the executable never changes):
  ENTRYPOINT ["node"]
  CMD ["dist/server.js"]
  → Forces node as executor. Various scripts are arguments.
  → Good for: images that are definitively "a Node.js runner"

ENTRYPOINT SCRIPT (for init logic):
  COPY docker-entrypoint.sh /usr/local/bin/
  RUN chmod +x /usr/local/bin/docker-entrypoint.sh
  ENTRYPOINT ["docker-entrypoint.sh"]
  CMD ["node", "dist/server.js"]

  # docker-entrypoint.sh:
  #!/bin/sh
  set -e
  # Run database migrations before starting app
  node dist/migrate.js
  # exec replaces shell with CMD — preserves PID 1 for signal handling
  exec "$@"

KEY: Always end entrypoint scripts with `exec "$@"` to preserve PID 1 signal handling.
```

---

## SECTION 10 — Comparison Table

```
TRAP 1: "I deleted the secret with RUN rm — it's gone from the image"
  WRONG. Docker layers are immutable. RUN rm creates a NEW layer that hides the file.
  The original layer with the secret still exists in the image filesystem.
  docker save myapp | tar xf - → original layer tarball still contains the file.
  FIX: Use BuildKit --mount=type=secret. Never write secrets to any layer.

TRAP 2: "EXPOSE 8080 publishes port 8080"
  WRONG. EXPOSE is documentation/metadata only.
  docker run -p 8080:8080 still required to publish to host.
  ECS/k8s use portMappings/containerPort in their own config, not the EXPOSE instruction.

TRAP 3: "ENV and ARG are both environment variables"
  WRONG. ARG is only available during BUILD, not at runtime.
  ENV is available both during build and at runtime.
  Both are visible in docker history (neither is truly secret).
  Use BuildKit --mount=type=secret for actual secrets.

TRAP 4: "ADD is just a better COPY"
  WRONG. ADD has hidden behavior:
    - Automatically extracts .tar, .tar.gz, .zip files (surprising behavior)
    - Can fetch from URLs (security risk — downloading from internet during build)
  Rule: ALWAYS use COPY unless you specifically need tar extraction.
  Docker documentation itself recommends preferring COPY over ADD.

TRAP 5: ".dockerignore is optional"
  WRONG. Without .dockerignore:
    - node_modules copied into build context → 500MB context upload
    - .env files accidentally included → secret baked into image
    - .git history included → slow build, irrelevant data
  .dockerignore is as important as .gitignore.

TRAP 6: "Multi-stage builds are only for size optimization"
  ADDITIONAL benefits:
    - Security: build tools not in runtime image (no gcc = can't compile exploits)
    - Testing: test stage can run in CI, build only proceeds if tests pass
    - Separation of concerns: each stage has a single responsibility

TRAP 7: "FROM scratch means completely empty — nothing works"
  Used for compiled binaries (Go, Rust) with CGO_ENABLED=0 (static binary).
  The binary contains its own runtime. No OS needed.
  docker run myapp → binary runs directly. No shell, no libc, nothing.
  Very real for production Go services. Works perfectly.
```

---

## SECTION 11 — Quick Revision

**Q: What's the difference between CMD and ENTRYPOINT?**

> ENTRYPOINT sets the fixed executable that always runs. CMD provides the default arguments, which are overridable. Together they work as: `ENTRYPOINT + CMD = the command`. CMD alone sets the full command. The critical thing most people miss: use exec form (JSON array) for both — otherwise a shell wraps your process and SIGTERM never reaches your app, causing 10-second kill delays on every deployment.

**Q: Why should you use multi-stage builds?**

> Three reasons: size (build tools don't ship to production), security (smaller attack surface, no compiler in prod image), and separation of concerns. A Node.js app built single-stage can be 1.1GB. Multi-stage: 160MB. On Fargate, that's the difference between a 45-second and a 6-second cold start during a traffic spike — which is the difference between surviving the spike and dropping requests.

**Q: What's wrong with using :latest as a base image tag?**

> `latest` is mutable — it's just a pointer. Today's `node:latest` is Node 20. Tomorrow it might be Node 22. Your Dockerfile changes behaviour without any code changes. CI passes, production breaks. Pin exact versions: `node:20.11.1-alpine3.19`. In production, you want deterministic, reproducible builds. `latest` is the opposite.

**Q: How do you handle secrets in a Dockerfile?**

> Never put secrets in ENV, ARG, or RUN echo. All of these are visible in `docker history`. The only correct approach is BuildKit `--mount=type=secret`, which mounts the secret only for the duration of that RUN step and is never written to any layer. At runtime, inject secrets via ECS task definition `secrets` block pointing to Secrets Manager ARNs — the task execution role fetches them at container start.

**Q: What is the build context and why does it matter?**

> The build context is the directory (usually `.`) sent to the Docker daemon before build starts. `COPY . .` copies from the build context, not directly from your filesystem. Without `.dockerignore`, the entire context is sent — including `node_modules` (500MB), `.git` history, `.env` files. A bloated context causes slow builds and can accidentally include secrets. `.dockerignore` is mandatory for production Dockerfiles.

**Q: What does a non-root user in Docker protect against?**

> Two things. First, it limits blast radius: if your app is compromised via RCE, the attacker runs as an unprivileged user inside the container — can't write to system paths, install software, or access root-owned files. Second, it prevents container escape via root-privilege escalation. Running as root inside a container can be leveraged with certain kernel CVEs (like runc CVEs) to escape to the host. Running as a non-root user closes that vector.

---

## SECTION 12 — Architect Thinking Exercise

```
PATTERN: Infrastructure as Code (IaC) for containers
  Dockerfile is IaC for your application environment.
  Commit it. Review it. Version it. Enforce it via CI.
  "Works on my machine" becomes impossible when the machine is defined in code.

PATTERN: Immutable Artifacts
  Build once → deploy anywhere.
  Same 160MB image moves from dev → staging → prod.
  No "re-build for production" step. The image includes its own environment.
  Tag with Git SHA: myapp:a3f7c9b → exact version, forever traceable.

PATTERN: Layer as Unit of Cache
  Think of each RUN/COPY as a cache key.
  Design instruction order to maximize cache hits.
  Most frequently changed instructions at the bottom.
  Dependencies (rarely change) cached above source code (frequently changes).

PATTERN: Defense in Depth for Container Security
  Layer 1: Non-root USER
  Layer 2: Read-only root filesystem
  Layer 3: Drop all Linux capabilities (--cap-drop=ALL)
  Layer 4: No privileged mode
  Layer 5: Distroless base image
  Layer 6: Regular vulnerability scanning (Trivy in CI)
  Each layer independently reduces blast radius.

PATTERN: Build-time vs Runtime Configuration
  Build-time (ARG + ENV defaults): non-sensitive app defaults
    PORT=8080, NODE_ENV=production, LOG_LEVEL=info
  Runtime injection: environment-specific non-sensitive values
    DATABASE_HOST, REDIS_URL, S3_BUCKET_NAME
  Secrets Manager: credentials, keys, tokens
    DATABASE_PASSWORD, JWT_SECRET, STRIPE_API_KEY
  Never: sensitive values in image layers
```

---

### Architect's Mental Model

```
┌─────────────────────────────────────────────────────────────────────┐
│                  DOCKERFILE ARCHITECT'S MENTAL MODEL                │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  RULE 1: A Dockerfile is a contract, not a script                   │
│  ─────────────────────────────────────────────────────────────────  │
│  It defines exactly what environment your app needs to run.         │
│  Anyone who builds it gets the same result. Everywhere. Always.     │
│  If your app has undocumented dependencies, the Dockerfile lies.    │
│                                                                     │
│  RULE 2: Layers are immutable — read them as a ledger               │
│  ─────────────────────────────────────────────────────────────────  │
│  Every RUN adds to the ledger. You can't erase past entries.        │
│  RUN rm secret.txt adds line: "secret.txt hidden" — original stays. │
│  Design with immutability in mind. Don't write secrets to layers.   │
│                                                                     │
│  RULE 3: Optimize for the happy path in CI, not the edge case       │
│  ─────────────────────────────────────────────────────────────────  │
│  Cache-optimized instruction order saves hours of CI time daily.    │
│  The 5 minutes you spend thinking about instruction order pays off  │
│  every single build for the lifetime of the project.                │
│                                                                     │
│  RULE 4: The runtime image is a production server, not a dev box    │
│  ─────────────────────────────────────────────────────────────────  │
│  No compiler. No test frameworks. No source maps. No devtools.      │
│  Multi-stage: build environment ≠ runtime environment.              │
│  If it's not needed to RUN the app, it has no business in the image.│
│                                                                     │
│  RULE 5: Security is not a layer — it's the foundation              │
│  ─────────────────────────────────────────────────────────────────  │
│  Non-root user is not optional. It's the floor.                     │
│  Distroless is for when the floor isn't enough.                     │
│  Trivy in CI is for when you need proof.                            │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│  3 MISTAKES EVERY JUNIOR ENGINEER MAKES:                            │
│  1. CMD in shell form → SIGTERM never received → graceful shutdown  │
│     broken → dropped requests on every deploy                       │
│  2. No .dockerignore → node_modules in build context → huge image   │
│     → secret .env files accidentally in image layers                │
│  3. Single-stage build → 1GB+ image → slow pulls → cold start       │
│     failures during traffic spikes                                  │
├─────────────────────────────────────────────────────────────────────┤
│  30-SECOND SYSTEM DESIGN ANSWER:                                    │
│  ─────────────────────────────────────────────────────────────────  │
│  "For production Dockerfiles I always use multi-stage builds with   │
│  an alpine or distroless runtime image. The key design decisions    │
│  are: exec form CMD for proper signal handling, .dockerignore to    │
│  prevent context bloat and secret leaks, instruction ordering       │
│  for cache efficiency, non-root USER for security, and BuildKit     │
│  --mount=type=secret for any credentials needed at build time.      │
│  On ECS Fargate, image size directly impacts cold start latency     │
│  during scale events — so a 160MB image vs 1.1GB isn't vanity,      │
│  it's the difference between surviving a traffic spike and          │
│  cascading task failures."                                           │
└─────────────────────────────────────────────────────────────────────┘
```

---

### Quick Reference Cheatsheet

```dockerfile
# PRODUCTION DOCKERFILE CHECKLIST:
# [ ] Multi-stage build (builder → runtime)
# [ ] Alpine or distroless runtime base
# [ ] package*.json COPY before source COPY (cache optimization)
# [ ] .dockerignore present and complete
# [ ] CMD/ENTRYPOINT in exec form (JSON array, not shell form)
# [ ] Non-root USER instruction
# [ ] HEALTHCHECK defined
# [ ] No secrets in ENV, ARG, or RUN echo
# [ ] hadolint passes with no errors
# [ ] trivy scan passes with no CRITICAL CVEs
# [ ] Image size verified after build (docker images myapp)
# [ ] SIGTERM test passes (docker stop + check graceful shutdown logs)

# QUICK SIZE CHECK COMMANDS:
docker images myapp                        # total compressed size
docker history myapp                       # per-layer breakdown
dive myapp                                 # interactive explorer
docker inspect myapp | jq '.[0].Config'    # metadata summary

# BUILD VARIANTS:
docker build .                             # standard build
DOCKER_BUILDKIT=1 docker build .           # enable BuildKit (caching, secrets mount)
docker build --target runtime .            # build specific stage only
docker build --build-arg APP_VERSION=$(git rev-parse --short HEAD) .
```
