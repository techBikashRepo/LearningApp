# Docker Compose

## FILE 03 OF 03 — Design Decisions, Interview Q&A & Architect's Mental Model

> **Architect Training Mode** | Platform Engineer / DevOps Architect Perspective
> _Optimized for: design reviews · system design interviews · architecture decisions under pressure_

---

## SECTION 9 — Certification Focus (AWS SAA-C03)

### Decision 1: compose.yaml Structure — Shared Base vs Environment-Specific

```
ANTI-PATTERN: One monolithic compose.yaml for everything
  services:
    api:
      build: .
      volumes:
        - ./src:/app/src     # dev-only
      environment:
        NODE_ENV: development # hardcoded
      ports:
        - "9229:9229"        # debugger port (useless in CI)

CORRECT: Base + Override pattern

  compose.yaml (base — shared across all environments):
    services:
      api:
        image: myapp:${IMAGE_TAG:-local}
        depends_on:
          postgres:
            condition: service_healthy
        networks:
          - backend
        environment:
          PORT: "8080"

      postgres:
        image: postgres:16-alpine
        healthcheck:
          test: ["CMD-SHELL", "pg_isready -U appuser"]
        networks:
          - backend

    networks:
      backend:

    volumes:
      pgdata:

  compose.override.yml (local dev — auto-merged with base):
    services:
      api:
        build: .              # build locally instead of pull
        volumes:
          - ./src:/app/src    # hot reload
          - /app/node_modules # shield from host node_modules
        environment:
          NODE_ENV: development
          LOG_LEVEL: debug
        ports:
          - "8080:8080"
          - "9229:9229"       # Node.js debug port

      postgres:
        ports:
          - "5432:5432"       # expose to host for DB GUI tool

  compose.ci.yml (CI testing — used explicitly):
    services:
      api:
        image: myapp:${GITHUB_SHA}   # use pre-built CI image, never build
        environment:
          NODE_ENV: test
      postgres:
        tmpfs:
          - /var/lib/postgresql/data  # in-memory postgres (faster CI, no persistence needed)

  USAGE:
    Developer: docker compose up                    (base + override.yml auto-merged)
    CI:        docker compose -f compose.yaml -f compose.ci.yml up --wait
    Verify:    docker compose config                (shows merged effective config)
```

### Decision 2: Volumes — When to Use Named Volumes vs tmpfs in CI

```
LOCAL DEV:
  Named volume for postgres/redis — persists developer's test data between restarts.
  docker compose down           → data survives
  docker compose down -v        → data wiped (when you want a fresh start)

CI/CD (integration tests):
  Use tmpfs for databases — in-memory, faster, no cleanup needed:
    postgres:
      tmpfs:
        - /var/lib/postgresql/data   # database lives in RAM
      # After docker compose down: nothing to clean. Next run starts fresh.
      # Bonus: tmpfs is 2-3x faster than disk (important for big test suites)

WHEN TO DELETE NAMED VOLUMES IN DEV:
  Fresh start needed: docker compose down -v
  Data migration test: wipe + run migrations from scratch
  Switch branches with schema changes: wipe prevents stale schema confusion

NEVER use named volumes across environments (dev ≠ prod data).
Production databases → RDS (managed). Never a Docker named volume.
```

### Decision 3: When NOT to Use Docker Compose

```
DO NOT USE COMPOSE FOR:
  1. Production application hosting
     WHY: Single host = single point of failure. No internal HA.
     USE: ECS Fargate, ECS EC2, Kubernetes

  2. Services requiring multi-host networking
     WHY: Compose networks are single-host bridge networks
     USE: ECS Service Discovery, Kubernetes Services

  3. Stateful production databases
     WHY: Named volumes on a single host are not HA, not backed up automatically
     USE: AWS RDS (automated backups, multi-AZ, failover)

  4. Services needing > 1 replica with load balancing
     WHY: docker compose up --scale api=3 with fixed ports fails
          No load balancer built into Compose
     USE: ECS with target group + ALB

ACCEPTABLE USES OF COMPOSE:
  ✅ Local development environment (developer laptop)
  ✅ CI integration tests (single-host is fine for tests, just not production)
  ✅ Internal tooling with no uptime SLA
  ✅ Demo environments, hackathon projects
  ✅ Batch processing jobs where downtime is acceptable
```

---

## SECTION 10 — Comparison Table

```
TRAP 1: "depends_on ensures the service is ready"
  WRONG. depends_on: service: condition: service_started only waits for container start.
  The process inside (postgres server) may not be ready.
  CORRECT: use condition: service_healthy WITH a healthcheck defined.
  Without healthcheck: condition: service_healthy fails immediately (no check to pass).

TRAP 2: "environment variables in compose.yaml are secured"
  WRONG. Values in compose.yaml are plaintext. Committed to git = leaked.
  Use variables with .env file substitution (${SECRET_VALUE}) or Docker secrets.
  .env file itself: NEVER commit. Add to .gitignore. Provide .env.example.

TRAP 3: "docker compose down removes all data"
  WRONG. docker compose down removes containers and networks, NOT named volumes.
  Named volumes persist after docker compose down.
  To delete volumes: docker compose down -v (explicitly)
  This trips up developers who expect a "clean state" after down.

TRAP 4: "compose.override.yml must be manually specified"
  WRONG. Docker Compose automatically merges compose.override.yml if it exists in the same directory.
  docker compose up ← automatically uses compose.yaml + compose.override.yml
  Force only base: docker compose -f compose.yaml up

TRAP 5: "Scaling with docker compose is like production scaling"
  WRONG. docker compose up --scale api=3 runs 3 containers but with no load balancer.
  All 3 instances compete for the same port (if fixed) or need a reverse proxy.
  Compose has no service mesh, no health-based routing, no automatic failover.
  It's a convenience for test parallelization, not production scaling.

TRAP 6: "docker compose restart restarts with latest config changes"
  WRONG. docker compose restart restarts containers with the SAME config they started with.
  To pick up compose.yaml changes: docker compose up -d (Compose recalculates diff and recreates)
  docker compose restart is for: "container crashed, restart the process only."

TRAP 7: "Networks in compose are isolated from other compose stacks"
  DEFAULT: each compose project gets its own default network (project-name_default).
  Services in different compose stacks CANNOT reach each other by service name by default.
  To share network: use external: true network pointing to a pre-created shared network.
```

---

## SECTION 11 — Quick Revision

**Q: What is Docker Compose and what is it NOT appropriate for?**

> Docker Compose is a tool for defining and running multi-container applications as code on a single host. It's ideal for local development — one command starts your entire stack (API, database, cache, reverse proxy) consistently on any developer's machine. It is NOT appropriate for production because it runs on a single host (no high availability), has no built-in load balancing, no automatic failover, and no rolling deployment capability. For production, use ECS Fargate or Kubernetes.

**Q: What's the difference between `depends_on: service` and `depends_on: service: condition: service_healthy`?**

> `depends_on: service` (shorthand) uses `condition: service_started` — it only waits for the container to be created and running, not for the application inside to be ready. A postgres container "starts" in milliseconds, but the postgres server takes 5-10 seconds to accept connections. `condition: service_healthy` waits until the service's defined `healthcheck` passes — which means postgres is actually responding. Without `service_healthy`, you get a race condition where the API tries to connect before postgres is ready.

**Q: What happens to database data when you run `docker compose down`?**

> Named volumes are NOT deleted by `docker compose down`. The containers and networks are removed, but named volumes persist on disk. Your postgres data survives. To delete volumes, you must explicitly run `docker compose down -v`. This is intentional — your local development data should survive container recreation. In CI, you can use `tmpfs` for the database so it's automatically clean every run without needing `down -v`.

**Q: How would you structure compose files for local dev vs CI?**

> I use a base `compose.yaml` with shared service definitions, and a `compose.override.yml` that Compose auto-merges for local dev — adds bind mounts for hot reload, exposes ports to the host, enables debug ports. For CI, I have a separate `compose.ci.yml` that I specify explicitly: it uses the pre-built CI image (no local build), uses `tmpfs` for the database (faster + auto-clean), and omits all developer conveniences. CI uses `docker compose -f compose.yaml -f compose.ci.yml up --wait` to start services and wait for all healthchecks to pass before running tests.

**Q: How do you prevent secrets from being committed in Docker Compose setups?**

> Never put secret values directly in `compose.yaml`. Use `${VARIABLE}` substitution, which Compose reads from a `.env` file. The `.env` file is gitignored (add to `.gitignore` and verify). Provide a `.env.example` with all required variables listed but no real values, so new developers know what to fill in. For production, use Docker secrets (Swarm) or, on AWS, the ECS task definition `secrets` block pointing to Secrets Manager ARNs.

---

## SECTION 12 — Architect Thinking Exercise

```
┌─────────────────────────────────────────────────────────────────────┐
│               DOCKER COMPOSE ARCHITECT'S MENTAL MODEL               │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  RULE 1: Compose is a developer tool, not an ops tool               │
│  ─────────────────────────────────────────────────────────────────  │
│  Its job: eliminate "works on my machine."                          │
│  Its scope: single developer's machine, CI test runner.             │
│  Its limit: single host, no HA, no production SLA.                  │
│  Never confuse the tool's job with its limitations.                 │
│                                                                     │
│  RULE 2: compose.yaml is infrastructure-as-code for dev             │
│  ─────────────────────────────────────────────────────────────────  │
│  Treat it like Terraform for localhost.                             │
│  Version it. Review it in PRs. Keep it accurate.                    │
│  An outdated compose.yaml that no longer matches reality            │
│  is worse than no compose.yaml (false confidence).                  │
│                                                                     │
│  RULE 3: healthchecks + depends_on are non-negotiable               │
│  ─────────────────────────────────────────────────────────────────  │
│  Every service that others depend on must have a healthcheck.       │
│  Every dependent service must use condition: service_healthy.       │
│  The alternative: flaky startup, flaky CI, intermittent failures    │
│  that waste more time debugging than the setup ever saved.          │
│                                                                     │
│  RULE 4: Secrets in files, files in .gitignore                      │
│  ─────────────────────────────────────────────────────────────────  │
│  The moment a secret enters a git commit, it's compromised.         │
│  .env exists to keep secrets off the terminal and out of compose.   │
│  .env.example exists to document what secrets are needed.           │
│  This is not optional hygiene — it's the minimum acceptable bar.    │
│                                                                     │
│  RULE 5: Know when to graduate out of Compose                       │
│  ─────────────────────────────────────────────────────────────────  │
│  Signs you've outgrown Compose:                                     │
│    • Deploying compose to "production" EC2                          │
│    • Needing > 1 instance of any service for availability           │
│    • Any service must survive host reboot with proper ordering      │
│    • You're writing shell scripts to manage the compose lifecycle   │
│  When you see these signs: migrate to ECS Fargate.                  │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│  3 MISTAKES EVERY JUNIOR ENGINEER MAKES:                            │
│  1. depends_on without service_healthy → race condition on startup  │
│     → app crashes → "it works if I restart it manually" forever     │
│  2. .env committed to git → secret leak → credential rotation →     │
│     incident postmortem → 3 hours of cleanup                        │
│  3. Docker Compose in production → first EC2 restart or container   │
│     crash = uncontrolled outage with no auto-recovery               │
├─────────────────────────────────────────────────────────────────────┤
│  30-SECOND SYSTEM DESIGN ANSWER:                                    │
│  ─────────────────────────────────────────────────────────────────  │
│  "I use Docker Compose exclusively for local dev and CI integration │
│  tests. The compose.yaml defines the full stack — API, postgres,    │
│  redis — with healthchecks on every service and                     │
│  condition: service_healthy on all depends_on. I split config into  │
│  a base compose.yaml plus compose.override.yml (auto-merged for     │
│  dev) and compose.ci.yml for CI. Secrets go in .env (gitignored),  │
│  documented via .env.example. For production, I'd move to ECS       │
│  Fargate — Compose is a dev tool, not a production platform."       │
└─────────────────────────────────────────────────────────────────────┘
```

---

### Quick Reference Cheatsheet

```yaml
# PRODUCTION-QUALITY compose.yaml CHECKLIST:
# [ ] healthcheck defined on every service that others depend on
# [ ] depends_on uses condition: service_healthy (not just - servicename)
# [ ] No hardcoded secrets (use ${VAR} substitution)
# [ ] .env in .gitignore, .env.example committed
# [ ] Named volumes defined for persistent data
# [ ] Anonymous volume for /app/node_modules (if bind mounting source code)
# [ ] Networks defined explicitly (not relying on default network)
# [ ] restart: unless-stopped on all services (dev/CI)
# [ ] docker compose config passes without errors
# [ ] Each service has a container_name for log readability

# COMMON MISTAKES TO SEARCH FOR IN CODE REVIEW:
# grep -n "depends_on:" compose.yaml | without "service_healthy" → race condition risk
# grep -rn "PASSWORD\|SECRET\|TOKEN\|KEY" compose.yaml → hardcoded secrets
# grep -n "volumes:" compose.yaml | without anonymous node_modules → bind mount trap
```
