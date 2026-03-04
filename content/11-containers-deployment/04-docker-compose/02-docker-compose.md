# Docker Compose

## SECTION 5 — Real World Example

> **Architect Training Mode** | Platform Engineer / DevOps Architect Perspective
> _Real failures. Real commands. Real fixes. Because incidents don't come with documentation._

---

### INCIDENT 01 — depends_on Without Healthcheck → App Crashes on Every Startup

```
SYMPTOM:
  docker compose up starts all containers.
  API container starts, then immediately crashes with:
    "Error: connect ECONNREFUSED 127.0.0.1:5432"
    "connection refused — database not accepting connections"
  docker compose up --force-recreate → same crash.
  Restart manually 20 seconds later → works fine.
  CI pipeline: fails 40% of the time, passes 60%. "Flaky CI."

ROOT CAUSE:
  compose.yaml:
    api:
      depends_on:
        - postgres    # waits for postgres CONTAINER to start, not for postgres to be READY

  Timeline:
    t=0s: postgres container created + pg process starts initializing
    t=0.5s: compose considers postgres "started" → launches api container (depends_on satisfied)
    t=0.5s: api starts, immediately tries to connect to postgres port 5432
    t=0.5s: postgres init not yet complete → port 5432 not yet open → ECONNREFUSED
    t=8s: postgres actually ready to accept connections
    t=8s: api is already dead (crash loop or process.exit(1))

FIX:
  Add healthcheck to postgres + use condition: service_healthy:

  services:
    api:
      depends_on:
        postgres:
          condition: service_healthy   ← waits until HEALTHCHECK passes

    postgres:
      image: postgres:16-alpine
      healthcheck:
        test: ["CMD-SHELL", "pg_isready -U appuser -d mydb"]
        interval: 5s
        timeout: 3s
        retries: 10
        start_period: 20s   ← grace period before checks begin (avoid false failures)

VERIFY:
  docker compose up -d
  docker compose ps           # postgres should show "(healthy)" before api starts
  docker compose logs api     # should show successful database connection

ALSO FIX: Application-level retry (defense in depth):
  Even with service_healthy, brief transient failures can happen.
  Add retry logic in app startup:
    async function connectWithRetry(attempt = 1) {
      try {
        await db.connect();
      } catch (err) {
        if (attempt <= 5) {
          console.log(`DB connect failed, retry ${attempt}/5 in 3s...`);
          await sleep(3000);
          return connectWithRetry(attempt + 1);
        }
        throw err;
      }
    }

  Both service_healthy AND application retry = resilient startup.
  service_healthy alone = one point of failure (healthcheck timing).
```

---

### INCIDENT 02 — Bind Mount Overwrites node_modules → Native Module Crashes

```
SYMPTOM:
  docker compose up runs fine on developer A's Mac (Intel).
  Developer B pulls the repo, runs docker compose up.
  API service starts and immediately crashes:
    "Error: /app/node_modules/bcrypt/lib/binding/napi-v3/bcrypt_lib.node: invalid ELF header"
    OR: "Error: dlopen() failed: no such file or directory"

  Developer B checks: they're on macOS ARM (M1/M2). Developer A was on x86.

ROOT CAUSE:
  compose.yaml:
    api:
      volumes:
        - .:/app   ← bind mounts ENTIRE project directory into container

  This overwrites /app/node_modules INSIDE the container with the HOST's node_modules.
  Developer B's host machine's node_modules has arm64 macOS native binaries.
  The container runs linux/amd64 — those binaries are incompatible.

  Even on the same architecture: host npm install may produce different artifacts
  than the container's npm ci (different platform paths, symlinks, etc).

FIX — Add anonymous volume to shield /app/node_modules:
  compose.yaml:
    api:
      volumes:
        - .:/app                  # bind mount source code
        - /app/node_modules       # anonymous volume shields container's node_modules

  What this does:
    .:/app                → host files mapped over container's /app
    /app/node_modules     → Docker re-mounts container's OWN node_modules on TOP
    Result: host's node_modules never reaches the container

FIX — Better pattern: only bind mount the source code, not node_modules directory:
  volumes:
    - ./src:/app/src         # only source code — nothing else

  node_modules stays as the container built it (npm ci in Dockerfile).
  Hot reload still works for code changes. No cross-platform contamination.

VERIFY:
  docker compose exec api node -e "require('bcrypt')"   # should not crash
  docker compose exec api ls /app/node_modules/.bin/    # should show container's bins
```

---

### INCIDENT 03 — .env File Accidentally Committed With Secrets

```
SYMPTOM:
  GitHub sends email: "Secret scanning alert — AWS access key found in commit."
  Engineer used .env for local development. .gitignore had a typo: ".ev" instead of ".env".
  .env was committed with:
    AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
    AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
    DATABASE_PASSWORD=prod-super-secret-password

ROOT CAUSE:
  Docker Compose uses .env file automatically for variable substitution.
  Developers rely on .env for local DATABASE_URL, API keys, etc.
  .env in project root → very likely to be accidentally committed.

FIX — Immediate response (secret already committed):
  1. ROTATE all exposed credentials immediately (assume compromised)
  2. Remove .env from git history (git-filter-repo or BFG Repo Cleaner)
  3. Force push. Notify all collaborators to re-clone.
  4. Still assume the key was seen — GitHub scanning is nearly instant.
     Consider the key permanently compromised regardless of history cleanup.

FIX — Prevention:
  # .gitignore — comprehensive:
  .env
  .env.*
  !.env.example    # allow .env.example (template with no real values)

  # .env.example (committed to repo — documents required vars, no real values):
  DATABASE_URL=postgres://user:password@localhost:5432/mydb
  JWT_SECRET=replace-with-long-random-string
  REDIS_URL=redis://localhost:6379

  # Pre-commit hook (detects .env before it can be committed):
  # .git/hooks/pre-commit:
  if git diff --cached --name-only | grep -q "^\.env"; then
    echo "ERROR: .env file cannot be committed"
    exit 1
  fi

  # OR use pre-commit framework with detect-secrets:
  # .pre-commit-config.yaml:
  repos:
    - repo: https://github.com/Yelp/detect-secrets
      hooks:
        - id: detect-secrets

FIX — Separation of concerns:
  .env                  → local dev secrets (gitignored, never committed)
  .env.example          → template (committed, no real values)
  compose.override.yml  → dev-specific compose overrides (ALSO gitignored or env-var free)
  Production secrets    → AWS Secrets Manager (never files)
```

---

### INCIDENT 04 — Port Conflict: Multiple developers on same machine, same port

```
SYMPTOM:
  Developer runs docker compose up.
  Error: "Bind for 0.0.0.0:5432 failed: port is already allocated"
  OR: "address already in use :::8080"
  Developer A left a compose stack running. Developer B starts a different project.
  Both bind to port 5432 for postgres, 8080 for their API. Second one fails.

ROOT CAUSE:
  compose.yaml hardcodes host ports:
    ports:
      - "5432:5432"
      - "8080:8080"

  Two applications cannot bind to the same host port simultaneously.
  Team of 5 developers, all with different projects → guaranteed port conflicts.

FIX 1 — Use different ports per project (simple, low-overhead):
  Project A: API=8080, Postgres=5432, Redis=6379
  Project B: API=8081, Postgres=5433, Redis=6380

  Convention: +1 per service per project.
  Document in README: "This project uses ports 8081, 5433, 6380 on your host."

FIX 2 — Use environment variable for port (flexible per-developer):
  compose.yaml:
    services:
      api:
        ports:
          - "${API_PORT:-8080}:8080"    # default 8080, override via .env
      postgres:
        ports:
          - "${POSTGRES_PORT:-5432}:5432"

  Developer with conflict: set API_PORT=8081 in their local .env
  No compose.yaml change needed.

FIX 3 — Use Traefik or Nginx Proxy Manager for routing:
  Run a single reverse proxy container on the host.
  Each project registers with it via Docker labels.
  Projects use arbitrary internal ports, proxy maps domain names.
  api-a.localhost → project A's API
  api-b.localhost → project B's API
  No port conflicts at all.

FIND WHAT'S USING A PORT:
  netstat -ano | findstr :8080   # Windows: find PID on port 8080
  lsof -i :8080                  # macOS/Linux: find what's on port 8080
  docker ps --format "table {{.Ports}}"  # show all container port mappings
```

---

### INCIDENT 05 — Docker Compose Used in Production (Single Point of Failure)

```
SYMPTOM:
  Deployed multi-service app to EC2 using docker compose up -d.
  EC2 instance restarts (kernel update, hardware issue).
  Services come back up, but in wrong order (no depends_on health checks on restart).
  Database comes up after API → API crashes on startup → restart loop.
  Total downtime: 8 minutes until engineer manually restarts in correct order.

  Second incident: one container crashes (app bug).
  No auto-restart observed. restart: unless-stopped wasn't in compose.yaml.
  Service is down until next morning when someone checks.

WHAT WENT WRONG:
  Docker Compose limitations:
    - Runs on single host (single point of failure)
    - No automatic service replacement if container exits with error
    - No rolling deployments
    - No health-based traffic routing
    - No horizontal scaling
    - docker compose up brings everything down during deploy

WHAT TO USE INSTEAD (production):
  Small team, simple architecture → ECS Fargate
    - Managed host infrastructure
    - Task health monitoring + auto-restart
    - Rolling/blue-green deployments
    - Service discovery via AWS Cloud Map
    - No EC2 to manage

  Larger architecture, complex routing → ECS Fargate + Application Load Balancer
    - ALB health checks replace compose healthchecks
    - Service mesh optional (App Mesh)

  Kubernetes workloads → EKS
    - Full pod lifecycle management
    - Horizontal pod autoscaling
    - Sophisticated deployment strategies

IF STUCK WITH EC2 + COMPOSE (emergency bridge):
  At minimum:
    - restart: unless-stopped on all services
    - systemd unit that runs docker compose up at host boot
    - External health monitoring (Route 53 health check or UptimeRobot)
    - Manual runbook for restart sequence
    - This is NOT a production architecture. Plan migration to ECS.
```

---

### Debugging Toolkit

```bash
# ──────────────────────────────────────────────────────────────────────
# STATUS & HEALTH
# ──────────────────────────────────────────────────────────────────────

docker compose ps                           # service status + ports
docker compose ps -a                        # include exited services
docker compose top                          # processes inside each container

# Check healthcheck status:
docker inspect myapp-postgres --format='{{.State.Health.Status}}'
# healthy | unhealthy | starting

# See healthcheck history (last 5 results):
docker inspect myapp-postgres --format='{{json .State.Health}}' | jq .

# ──────────────────────────────────────────────────────────────────────
# LOGS
# ──────────────────────────────────────────────────────────────────────

docker compose logs                         # all services
docker compose logs api                     # specific service
docker compose logs -f                      # follow all
docker compose logs --tail=100 api          # last 100 lines
docker compose logs --since=30m             # logs from last 30 minutes
docker compose logs -f api postgres         # follow multiple services

# ──────────────────────────────────────────────────────────────────────
# EXEC / DEBUG
# ──────────────────────────────────────────────────────────────────────

docker compose exec api sh                  # shell into api container
docker compose exec postgres psql -U appuser -d mydb   # psql shell
docker compose exec redis redis-cli -a redissecret ping  # redis ping

# Run one-off command without starting a new service:
docker compose run --rm api node dist/migrate.js
# --rm: removes container after command completes

# ──────────────────────────────────────────────────────────────────────
# CONFIGURATION VALIDATION
# ──────────────────────────────────────────────────────────────────────

docker compose config                       # validate + print merged config
docker compose config --services            # list service names
docker compose config --volumes             # list volumes

# Dry run (check what would run without starting):
docker compose up --dry-run

# ──────────────────────────────────────────────────────────────────────
# REBUILD / RESET
# ──────────────────────────────────────────────────────────────────────

docker compose build --no-cache             # full rebuild
docker compose up -d --build                # rebuild + start
docker compose down -v                      # teardown + delete volumes (CAREFUL)
docker compose down --rmi local             # teardown + remove locally built images

# Full reset (nuclear):
docker compose down -v --rmi local --remove-orphans

# ──────────────────────────────────────────────────────────────────────
# VARIABLE & ENVIRONMENT DEBUGGING
# ──────────────────────────────────────────────────────────────────────

# See what variables compose is substituting:
docker compose config                       # shows resolved values

# Check what .env vars are loaded:
docker compose run --rm api env | sort

# Override a single variable without editing .env:
DATABASE_URL=postgres://other:pass@otherhosts:5432/db docker compose up api
```

## SECTION 6 — System Design Importance

The incident patterns above highlight key system design principles: design for failure, implement graceful degradation, enforce security boundaries at every layer, and monitor proactively. Each incident represents a production scenario that should inform your system design decisions.

## SECTION 7 — AWS & Cloud Mapping

AWS services directly relevant to these patterns: **ECS/Fargate** for container orchestration and task lifecycle management; **ECR** for secure image storage and scanning; **Secrets Manager / SSM Parameter Store** for runtime secret injection; **CloudWatch** for container metrics, logs, and alarms; **IAM** for fine-grained access control.

## SECTION 8 — Interview Preparation

**Beginner:**

**Q: What is Docker Compose and why would you use it for local development?**
**A:** Docker Compose lets you define and run multiple containers together as a single application. For example, a web app typically needs: a Node.js API server, a PostgreSQL database, and a Redis cache â€” three separate containers. Without Compose, you'd manually start each with long docker run commands, set up networks, pass environment variables. With Compose, you define everything in docker-compose.yml and start the entire stack with docker compose up. One command launches all services, configured correctly, on a shared network. Perfect for local development matching the production architecture.

**Q: What is the difference between docker compose up and docker compose up --build?**
**A:** docker compose up starts services using existing local images (pulls from registry if not present). docker compose up --build rebuilds the images from your Dockerfile before starting â€” use this when you've changed your Dockerfile or added new dependencies (anything that changes the image). For day-to-day code changes on services using volumes (code mounted into container), neither rebuild nor restart is needed â€” changes are instantly visible. --build is mainly needed after dependency changes.

**Q: What does the depends_on setting in docker-compose.yml do?**
**A:** depends_on controls startup ORDER â€” the pi service won't start until the db service container is running. However, important caveat: "running" means the container started, NOT that the service inside is ready (e.g., PostgreSQL may take 2-3 seconds after container start before it accepts connections). A Node.js app that tries to connect immediately may fail. Solution: use retry logic in your app's DB connection code (or depends_on with condition: service_healthy and a health check defined for the db service).

---

**Intermediate:**

**Q: How do Docker Compose named volumes differ from bind mounts, and when should you use each for a Postgres database?**
**A:** *Bind mount:* ./postgres-data:/var/lib/postgresql/data â€” data stored in a specific host folder. Downside: PostgreSQL data files are OS-specific and may cause permissions issues on Mac/Windows). *Named volume:* db_data:/var/lib/postgresql/data â€” Docker manages the storage location. Portable, no host path needed, correct permissions. For local development PostgreSQL: use a named volume â€” data persists across docker compose down and docker compose up, no path issues. Use docker compose down -v only when you want to wipe the database completely (e.g., run fresh migrations). Bind mounts: best for source code you want to edit in your IDE.

**Q: What is the purpose of environment variable substitution in docker-compose.yml and how does .env integrate?**
**A:** docker-compose.yml supports ${VARIABLE_NAME} placeholders â€” Compose replaces them with values from: (1) your shell environment, (2) a .env file in the same directory. This enables: image: myapp: â€” same compose file runs different versions. environment: DATABASE_URL: postgres://:@db/mydb â€” credentials from .env, not hardcoded. Never hardcode passwords in docker-compose.yml. Keep .env out of git. Distribute secrets via your team's agreed secret manager.

**Q: How would you scale a service with Docker Compose and what are its limitations vs Kubernetes?**
**A:** docker compose up --scale api=3 â€” runs 3 instances of the pi service. But: all 3 run on the same machine, manual scaling (no auto-scale based on CPU/memory), no health-check-based replacement, no rolling updates, no cross-host scheduling. Compose is designed for local development and small single-server deployments. For production at scale: ECS (managed container orchestration), Kubernetes (self-managed or EKS), or other orchestrators handle scheduling across multiple hosts, auto-scaling, rolling deployments, and service discovery.

---

**Advanced (System Design):**

**Scenario 1:** Design a docker-compose.yml setup for a development environment where: the Node.js API has hot-reload (code changes are instant), PostgreSQL data persists between restarts, Redis is ephemeral (wiped on restart), and a separate migrate service runs database migrations before the API starts.

`yaml
version: '3.8'
services:
  migrate:
    build: .
    command: node db/migrate.js
    environment:
      DATABASE_URL: postgres://user:pass@db:5432/myapp
    depends_on:
      db:
        condition: service_healthy

  api:
    build: .
    command: npx nodemon src/index.js
    volumes:
      - ./src:/app/src          # Hot reload
    ports:
      - "3000:3000"
    environment:
      DATABASE_URL: postgres://user:pass@db:5432/myapp
      REDIS_URL: redis://redis:6379
    depends_on:
      migrate:
        condition: service_completed_successfully

  db:
    image: postgres:15-alpine
    volumes:
      - db_data:/var/lib/postgresql/data   # Persistent
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U user -d myapp"]
      interval: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    # No volume = ephemeral

volumes:
  db_data:
`

**Scenario 2:** Your team of 8 developers uses Docker Compose for local development. Three devs complain their local environment "just broke" â€” the API can't connect to PostgreSQL. Other devs are fine. The Compose setup hasn't changed. What are the most likely causes and how do you debug systematically?

*Diagnosis flow:*
(1) docker compose ps â€” are all containers running or did db exit? Check status columns.
(2) docker compose logs db â€” PostgreSQL error logs. Common: "database directory appears to contain a database, but file format version mismatch" (volume contains old Postgres version data after image update).
(3) docker compose logs api â€” what connection error? "connection refused" = db not ready; "authentication failed" = env var mismatch; "database does not exist" = migration not run.
(4) For the volume mismatch: docker compose down -v && docker compose up â€” wipe the volume, fresh start.
(5) Verify .env file exists and has correct values â€” maybe these devs pulled new code that requires a new env var not in their local .env.
(6) Docker Desktop memory/disk issue â€” check if Docker Desktop ran out of disk space (common on Mac with large volumes). Docker Desktop settings â†’ Resources.

