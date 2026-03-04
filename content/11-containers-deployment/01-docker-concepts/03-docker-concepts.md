# Docker Concepts

## FILE 03 OF 03 — Design Decisions, Interview Questions & Architect's Mental Model

> **Architect Training Mode** | Platform Engineer / DevOps Architect Perspective
> _Optimized for: design judgement · tradeoff evaluation · failure prediction · production debugging_

---

## SECTION 9 — Certification Focus (AWS SAA-C03)

```
SHOULD YOU CONTAINERIZE THIS WORKLOAD?

CONTAINERIZE WHEN:
  ✓ Web application / API (stateless, HTTP — perfect container fit)
  ✓ Microservices (each service = its own image, independent deployment)
  ✓ Batch jobs (container runs job → exits → pay only for runtime)
  ✓ You want reproducible builds (dev = staging = prod environment)
  ✓ Team deploys frequently (CI/CD pipeline via image push → ECS rolling update)
  ✓ Horizontal scaling needed (spin up 10 identical containers instantly)

DON'T CONTAINERIZE (or requires special handling) WHEN:
  ✗ Stateful process that writes to local disk (manage volumes or use cloud storage)
  ✗ GPU-intensive ML training on ECS Fargate (no GPU support — use EC2 g-series or SageMaker)
  ✗ Windows GUI apps (no headless containerization for legacy GUI)
  ✗ Kernel-level software (needs kernel access → container can't expose host kernel safely)
  ✗ Legacy app requires specific OS with hardcoded /etc/hosts, initd scripts (lift+shift first, containerize later)

SINGLE CONTAINER vs MULTI-SERVICE COMPOSE:
  Single container: 1 app process = 1 container. Production default.
  Sidecar: 2 containers in same ECS task — app + log agent/proxy (Envoy, Fluent Bit).
           Share network namespace. Communicate via localhost.
  Compose: development only — spin up app + DB + Redis locally together.
           Never deploy Docker Compose to production (no HA, no orchestration).
```

---

## SECTION 10 — Comparison Table

```
ARCHITECTURE A: Monolith on EC2 (no containers)

  EC2 → node app directly on host OS → SSH to deploy → scripts to restart

  Problems:
    Environment drift between instances (AMI baked, not reproducible builds)
    Deployment: SSH + pull code + restart (downtime or race condition)
    Scale: clone EC2 = clone everything (app + OS debt)
    Rollback: re-deploy old code (slow, manual)

ARCHITECTURE B: Containers on ECS Fargate (correct cloud-native pattern)

  ECR ← docker push ← CI/CD pipeline ← git push
   ↓
  ECS Service → rolling update → new tasks (new image) → health check
                             → deregister old tasks from ALB
   ↓
  ALB → routes to healthy tasks

  Benefits:
    Immutable deployment: new version = new image tag = atomic
    Rollback: update service to point to previous image tag = instant
    Environment: identical across all tasks (same image = same runtime)
    Scale: add tasks in seconds (image already cached on host or pulled once)

ARCHITECTURE C: EKS for Large-Scale Microservices

  GitOps: ArgoCD watches git repo → applies manifests to cluster
  Service mesh: Istio → mutual TLS between services, circuit breaking, distributed tracing
  HPA: Horizontal Pod Autoscaler → scale on CPU OR custom metrics (queue depth, HTTP RPS)

  When to add this complexity:
    50+ microservices, multiple teams, multi-environment promotion pipelines
    Not: for 3 services and a team of 5 engineers
```

---

## SECTION 11 — Quick Revision

```
PATTERN 1: Rolling Update (default, zero-downtime)
  ECS: replace tasks incrementally (1 at a time or N at a time)

  Config:
    minimumHealthyPercent: 100   ← never reduce capacity below desired
    maximumPercent: 200          ← can temporarily run 2× tasks during update

  Timeline: ALB → drains connections from old task (deregistration delay 30s) → terminate old
  Rollback: update service task definition back to previous → rolls back the same way
  Use: standard deployment. Safe. Slightly slower for large fleets.

PATTERN 2: Blue/Green Deployment (instant cutover, instant rollback)

  Blue environment: current production (all traffic)
  Green environment: new version deployed (no traffic yet)

  Cutover: shift 100% traffic from Blue → Green (ECS CodeDeploy blue/green, Route 53 weighted)
  Testing: canary shift — 5% → Green, 95% → Blue → watch error rates → full shift
  Rollback: shift traffic back to Blue (seconds)

  Requires: 2× infrastructure cost during deployment window
  Use: critical releases, database schema changes, major version upgrades

PATTERN 3: Canary Deployment
  New version: 10% traffic. Old version: 90%.
  Monitor: error rate, latency, business metrics for 30 minutes.
  If healthy: gradually shift to 25% → 50% → 100%.
  If error spike: instantly reduce canary to 0%. Old version absorbs all traffic.

  AWS: ALB weighted target groups, App Mesh, or EKS with Flagger

PATTERN 4: Feature Flags (decouple deploy from release)
  Deploy new code (feature flag OFF) → code in production but inactive
  Enable flag: toggle in LaunchDarkly / AWS AppConfig → feature live
  Disable flag: instant "rollback" without re-deployment
  Use: risky features, A/B testing, gradual user rollout
```

---

## SECTION 12 — Architect Thinking Exercise

```
Q1: "Explain Docker in one sentence."
  "Docker packages an application with its exact runtime dependencies into an immutable
   image that runs identically on any host — eliminating environment drift between
   development, staging, and production."

Q2: "What's the difference between a Docker image and a container?"
  "Image = read-only blueprint (frozen filesystem, like a class definition).
   Container = a running instance of that image (like an object created from the class).
   One image → many containers. Stopping a container doesn't delete the image."

Q3: "What is multi-stage build and why does it matter in production?"
  "Multi-stage separates the build environment (compiler, test tools, heavy dependencies)
   from the runtime image (only production artifacts).
   Your 900MB build environment → 80MB runtime image.
   Result: faster deploys, less attack surface, lower ECR storage cost.
   Without it: your build tools, test frameworks, and source maps run in production."

Q4: "A container in ECS is running (process alive) but the app returns 500 errors.
      How do you debug this?"
  Step 1: Check CloudWatch Logs (application errors? DB connection? Startup failure?)
  Step 2: Check ALB target group health (is the /health endpoint 200 or 500?)
  Step 3: ECS Exec (exec into running task) → curl localhost:8080 from inside
  Step 4: Check environment variables (wrong DB endpoint? Missing secret?)
  Step 5: Check CloudWatch Container Insights → memory/CPU spike correlates with errors?

Q5: "Container exits with code 137 in production. What happened?"
  "Exit code 137 = SIGKILL from the Linux OOM killer.
   The container exceeded its memory limit — the kernel forcibly killed it.
   Debug: check CloudWatch MemoryUtilization metric at time of exit.
   Fix: either increase the task memory limit or find the memory leak (heap dump with Node --inspect).
   Prevention: alert when MemoryUtilization > 80%, add --max-old-space-size to Node.js."

Q6: "Should you store application logs inside the container filesystem?"
  "Never. Container filesystem is ephemeral — restart = data lost.
   Send logs directly to CloudWatch Logs (ECS awslogs driver) or stdout (12-factor).
   STDOUT/STDERR → Docker daemon → CloudWatch Logs via awslogs log driver.
   The container itself has zero knowledge of log destination (12-factor principle)."

Q7: "ECS Fargate vs EKS — when do you choose each?"
  "ECS Fargate: AWS workloads, team without k8s expertise, fully managed nodes,
   faster time to production. Cost: no control plane fee.

   EKS: multi-cloud portability needed, large engineering org with k8s expertise,
   complex patterns (service mesh, GitOps with ArgoCD, KEDA, Helm ecosystem).
   Cost: $0.10/hour for control plane + node group cost.

   Rule: ECS Fargate until you hit a specific limitation that only k8s solves."
```

---

### Architect's Mental Model

```
5 RULES I NEVER VIOLATE:

1. "Containers are cattle, not pets — build them to be killed and replaced at any moment"
   Any container: must handle SIGTERM gracefully. Must be stateless.
   State lives in: S3, RDS, ElastiCache. Never in container local filesystem.
   If you can't kill and replace a container without impact: the architecture is wrong.

2. "Image tag in production = Git SHA — never :latest, never :staging, never :v2"
   :latest is a mutable pointer. It lies. Yesterday's :latest ≠ today's :latest.
   Git SHA = immutable, traceable, revertible. Link deploy to commit in one lookup.
   Rollback: update ECS service to image:previousGitSHA. Done.

3. "Never put secrets into the image — scan for it proactively in CI"
   Dockerfile ENV = non-sensitive defaults only.
   Secrets: injected at runtime via ECS secrets block (from Secrets Manager).
   Defense: truffleHog or Trivy secret scanning in CI pipeline — fail build on detection.

4. "Multi-stage build is default — single-stage is a code review rejection"
   No dev dependency, no build tool, no compiler belongs in the runtime image.
   The runtime image is the attack surface. Minimize it.
   Size target: < 200MB for most applications. > 500MB needs justification.

5. "Readiness and health checks are not optional — they define when traffic is safe"
   ECS startPeriod: give the app time to connect to DB and warm up.
   /health endpoint: return 200 only when app is fully ready (DB connected, cache warm).
   /health returning 200 while app is broken = the worst kind of failure (silent, hard to debug).

3 MISTAKES JUNIOR ENGINEERS MAKE:

1. Mounting the entire source directory as a volume in "production-like" staging
   docker run -v $(pwd):/app myapp:latest  ← development convenience
   In staging/prod: baked source code gets overridden by host mount.
   Container = image contents. Volumes = exception for explicit persistent data only.
   Never mount source code as volume in any deployed environment.

2. Building the image locally and pushing to ECR manually
   Breaks: auditability (who built it?), reproducibility (which exact dependencies?),
   security scanning (no Trivy in manual build), environment parity.
   Rule: all images MUST be built inside CI/CD pipeline on a clean agent.
   No exceptions for production. Even hotfixes.

3. Setting container CPU/memory limits too low "to save cost"
   Under-provisioned container: OOM kills (137), CPU throttling (latency spikes), pod evictions.
   Correct process: measure p99 CPU+memory in staging under load test → set limits at 130% of p99.
   Saving $5/month on task memory → causing $50K/hour outage is not a trade-off.

30-SECOND MENTAL MODEL (Say this in an interview):
  "Docker solves environment drift — the 'works on my machine' problem — by packaging
   the application and its exact runtime dependencies into an immutable image.
   That image runs identically on any host.
   Production principles: immutable tags via Git SHA, secrets injected at runtime,
   never as root, multi-stage builds for minimal image size, stateless containers
   with graceful SIGTERM handling. Deployment: ECS rolling update with health check
   gates — new task healthy before old drains. Rollback: point to prior image SHA."
```
