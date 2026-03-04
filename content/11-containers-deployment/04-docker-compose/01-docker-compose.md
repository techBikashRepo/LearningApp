# Docker Compose

## FILE 01 OF 03 — Core Concepts, Architecture & Production Patterns

> **Architect Training Mode** | Platform Engineer / DevOps Architect Perspective
> _Optimized for: design judgement · tradeoff evaluation · failure prediction · production debugging_

---

## SECTION 1 — Intuition (Explain Like a 12-Year-Old)

```
WITHOUT DOCKER COMPOSE:
  # Run a Node.js API + Postgres + Redis + Nginx — the manual way:
  docker network create myapp-net
  docker run -d --name postgres --network myapp-net \
    -e POSTGRES_PASSWORD=secret -v pgdata:/var/lib/postgresql/data postgres:16
  docker run -d --name redis --network myapp-net redis:7-alpine
  docker run -d --name api --network myapp-net \
    -e DATABASE_URL=postgres://... -e REDIS_URL=redis://... \
    -p 8080:8080 myapp:latest
  docker run -d --name nginx --network myapp-net \
    -p 80:80 -v ./nginx.conf:/etc/nginx/conf.d/default.conf nginx:alpine

  Problem: 4 commands. All have to be run in order. All parameters must match.
  New developer joins = 30 minutes of setup, half of which fails.
  CI pipeline = custom bash scripts that break constantly.

WITH DOCKER COMPOSE:
  docker compose up -d   ← one command launches everything
  docker compose down    ← tears everything down cleanly

  The entire multi-service environment is defined as CODE in compose.yaml.
  Self-documenting. Reviewed in PRs. Runs identically on every machine.

WHAT COMPOSE IS FOR:
  ✅ Local development (run entire stack on developer laptop)
  ✅ CI/CD integration testing (spin up DB + Redis + app for test suite)
  ✅ Demo environments, training setups

WHAT COMPOSE IS NOT FOR:
  ❌ Production deployments (no HA, no automatic restart policy, single host)
  ❌ Load balancing across multiple instances
  ❌ Automatic failover
  → Production: ECS Fargate, ECS EC2, or Kubernetes
```

---

## SECTION 2 — Core Technical Explanation

```yaml
# compose.yaml (or docker-compose.yml — both recognized)

name: myapp # project name — prefixes all container/network/volume names

# ──────────────────────────────────────────────────────────────────────
# SERVICES — each service = one container (or multiple replicas)
# ──────────────────────────────────────────────────────────────────────
services:
  # ── API Service ─────────────────────────────────────────────────────
  api:
    build:
      context: . # build from local Dockerfile
      target: runtime # use the 'runtime' stage (multi-stage)
    image: myapp-api:local # tag to apply to built image
    container_name: myapp-api # fixed name (otherwise: projectname_api_1)
    restart: unless-stopped # restart policy: no | always | on-failure | unless-stopped
    depends_on:
      postgres:
        condition: service_healthy # wait until postgres healthcheck passes
      redis:
        condition: service_healthy
    ports:
      - "8080:8080" # "hostPort:containerPort"
    environment:
      NODE_ENV: development
      PORT: "8080"
      DATABASE_URL: postgres://appuser:secret@postgres:5432/mydb
      REDIS_URL: redis://redis:6379
    env_file:
      - .env.local # load additional vars from file
    volumes:
      - ./src:/app/src # bind mount for hot reload in dev
      - /app/node_modules # anonymous mount: preserve container's node_modules
    networks:
      - backend
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:8080/health"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 60s

  # ── Postgres Service ─────────────────────────────────────────────────
  postgres:
    image: postgres:16-alpine
    container_name: myapp-postgres
    restart: unless-stopped
    environment:
      POSTGRES_USER: appuser
      POSTGRES_PASSWORD: secret
      POSTGRES_DB: mydb
    volumes:
      - pgdata:/var/lib/postgresql/data # named volume — persists across restarts
      - ./db/init.sql:/docker-entrypoint-initdb.d/init.sql # auto-runs on first start
    ports:
      - "5432:5432" # expose to host for local psql access
    networks:
      - backend
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U appuser -d mydb"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 30s

  # ── Redis Service ────────────────────────────────────────────────────
  redis:
    image: redis:7-alpine
    container_name: myapp-redis
    restart: unless-stopped
    command: redis-server --appendonly yes --requirepass redissecret
    volumes:
      - redisdata:/data
    networks:
      - backend
    healthcheck:
      test: ["CMD", "redis-cli", "--pass", "redissecret", "ping"]
      interval: 10s
      timeout: 3s
      retries: 5

# ──────────────────────────────────────────────────────────────────────
# NETWORKS — custom networks for service isolation
# ──────────────────────────────────────────────────────────────────────
networks:
  backend:
    driver: bridge
    # Services on this network can reach each other by service name (DNS)
    # api can connect to postgres at hostname: "postgres"
    # api can connect to redis at hostname: "redis"

# ──────────────────────────────────────────────────────────────────────
# VOLUMES — named volumes persist independently of container lifecycle
# ──────────────────────────────────────────────────────────────────────
volumes:
  pgdata: # data survives: docker compose down / docker compose up
  redisdata:
  # docker compose down -v ← DELETES named volumes (careful — dev data loss)
```

---

## SECTION 3 — Architecture Diagram (MANDATORY)

```yaml
# NAIVE (WRONG — causes app crash on startup):
services:
  api:
    depends_on:
      - postgres        # waits for container to START, not for postgres to be READY
                        # postgres container starts in milliseconds, but postgres
                        # server takes 5-10s to accept connections
                        # api starts, tries to connect, postgres refuses → crash

# CORRECT — condition: service_healthy:
services:
  api:
    depends_on:
      postgres:
        condition: service_healthy  # waits until postgres HEALTHCHECK passes
      redis:
        condition: service_healthy

  postgres:
    image: postgres:16-alpine
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U appuser -d mydb"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 30s   # give postgres 30s grace before first health check

# CONDITION OPTIONS:
#   service_started   → container started (default, almost useless)
#   service_healthy   → healthcheck passes ← USE THIS for databases/redis
#   service_completed_success → container exited 0 (for init/migration containers)

# INIT CONTAINER PATTERN — run migrations before app starts:
services:
  migrate:
    image: myapp:local
    command: ["node", "dist/migrate.js"]
    depends_on:
      postgres:
        condition: service_healthy

  api:
    image: myapp:local
    depends_on:
      migrate:
        condition: service_completed_success  # wait for migration to finish
      redis:
        condition: service_healthy
```

---

## SECTION 4 — Request Flow (MANDATORY FLOWCHART)

```yaml
# ── NAMED VOLUME (production-like persistence) ──────────────────────
volumes:
  pgdata:
    # managed by Docker
    # docker volume ls → shows pgdata
    # Persists: docker compose down + docker compose up → data still there
    # Delete data: docker volume rm myapp_pgdata
    # OR: docker compose down -v  (nukes all volumes)

services:
  postgres:
    volumes:
      - pgdata:/var/lib/postgresql/data

# ── BIND MOUNT (local dev: sync host source into container) ─────────
services:
  api:
    volumes:
      - ./src:/app/src    # host ./src ↔ container /app/src
      # Changes on host appear in container instantly (hot reload)
      # Used for: nodemon/ts-node in dev, not for production

# ── ANONYMOUS VOLUME (preserve container-specific directory) ────────
services:
  api:
    volumes:
      - ./src:/app/src          # bind mount source code
      - /app/node_modules       # anonymous: keeps container's node_modules
      # WHY: if you bind mount . over /app, you overwrite /app/node_modules
      # with your HOST's node_modules (wrong platform binaries, or missing).
      # Adding /app/node_modules as anonymous volume "shields" it from the
      # bind mount's overlay — container's compiled modules stay intact.

# ── COMPARISON ───────────────────────────────────────────────────────
# Named volume:     docker manages path. Cross-platform. Persistent.
# Bind mount:       tied to host filepath. Dev only. Immediate sync.
# Anonymous volume: tied to container. Lost on docker compose down.
```

---

### Override Files & Profiles

```
OVERRIDE FILE PATTERN:
  compose.yaml          ← base config (shared across all environments)
  compose.override.yml  ← extends base automatically (local dev customizations)
  compose.prod.yml      ← production overrides (used explicitly)

  docker compose up                          → merges compose.yaml + compose.override.yml
  docker compose -f compose.yaml -f compose.prod.yml up  → explicitly use prod file

EXAMPLE — BASE compose.yaml:
  services:
    api:
      image: myapp:${IMAGE_TAG}
      environment:
        NODE_ENV: production

EXAMPLE — compose.override.yml (local dev):
  services:
    api:
      build: .            # override: build locally instead of pull
      volumes:
        - ./src:/app/src  # hot reload
      environment:
        NODE_ENV: development
        LOG_LEVEL: debug
      ports:
        - "9229:9229"     # Node.js debugger port

PROFILES — conditional service startup:
  services:
    api:
      # no profile → always started

    mailhog:
      image: mailhog/mailhog
      profiles: [dev, testing]  # only starts with --profile dev

    prometheus:
      image: prom/prometheus
      profiles: [monitoring]    # only starts with --profile monitoring

  docker compose up                          # starts: api only
  docker compose --profile dev up            # starts: api + mailhog
  docker compose --profile dev --profile monitoring up  # api + mailhog + prometheus
```

---

### Common docker compose Commands

```bash
# ── STARTUP / SHUTDOWN ────────────────────────────────────────────────
docker compose up                   # start all services (foreground)
docker compose up -d                # start detached (background)
docker compose up --build           # rebuild images before starting
docker compose up --force-recreate  # recreate containers even if config unchanged
docker compose down                 # stop + remove containers + networks
docker compose down -v              # also delete named volumes (data loss!)
docker compose stop                 # stop containers (keep containers + volumes)
docker compose start                # start stopped containers

# ── INDIVIDUAL SERVICES ───────────────────────────────────────────────
docker compose up -d api            # start only the api service
docker compose restart api          # restart one service
docker compose stop postgres        # stop one service

# ── LOGS ──────────────────────────────────────────────────────────────
docker compose logs                 # all service logs
docker compose logs api             # logs for api only
docker compose logs -f api          # follow (tail) api logs
docker compose logs --tail=50 api   # last 50 lines

# ── EXEC / SHELL ──────────────────────────────────────────────────────
docker compose exec api sh          # shell into running api container
docker compose exec postgres psql -U appuser -d mydb  # postgres psql

# ── STATUS / INSPECT ─────────────────────────────────────────────────
docker compose ps                   # list all running services + ports
docker compose ps -a                # include stopped services
docker compose top                  # show running processes inside each container
docker compose config               # validate and show merged compose config

# ── BUILD ─────────────────────────────────────────────────────────────
docker compose build                # build all service images
docker compose build api            # build specific service
docker compose build --no-cache api # build without layer cache

# ── SCALING (dev/test only) ───────────────────────────────────────────
docker compose up --scale api=3     # run 3 replicas of api
# Note: with scale, remove container_name and avoid fixed port mapping
```

---

### CI Integration Testing Pattern

```yaml
# .github/workflows/test.yml

- name: Start services for integration tests
  run: docker compose -f compose.test.yml up -d --wait
  # --wait: waits until all healthchecks pass before proceeding

- name: Run integration tests
  run: npm run test:integration

- name: Collect logs on failure
  if: failure()
  run: docker compose -f compose.test.yml logs

- name: Teardown
  if: always()        # run even if tests fail
  run: docker compose -f compose.test.yml down -v

# compose.test.yml — optimized for CI (no bind mounts, no dev tools):
services:
  api:
    image: myapp:${GITHUB_SHA}   # use the exact built image from CI
    environment:
      DATABASE_URL: postgres://test:test@postgres/testdb
    depends_on:
      postgres:
        condition: service_healthy

  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: test
      POSTGRES_PASSWORD: test
      POSTGRES_DB: testdb
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U test -d testdb"]
      interval: 5s
      retries: 5
      start_period: 10s

# KEY: --wait flag requires all services to have healthchecks defined.
# Without --wait: your tests might start before postgres is ready → flaky CI.
```
