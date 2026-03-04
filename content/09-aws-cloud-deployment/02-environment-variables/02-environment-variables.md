# Environment Variables

## FILE 02 OF 03 — Injection Patterns, Rotation Failures & Production Incidents

> **Architect Training Mode** | Senior Principal Architect Perspective
> _Optimized for: design judgement · tradeoff evaluation · failure prediction · production debugging_

---

## SECTION 5 — Real World Example

### Three Different Injection Mechanisms — Same Concept, Very Different Behavior

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LEVEL 1: OS-LEVEL (systemd, EC2 user data)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/etc/environment (system-wide, all users, all processes at login):
  DATABASE_URL=postgresql://prod.rds.internal:5432/mydb
  NODE_ENV=production

/etc/profile.d/myapp.sh (login shells only):
  export PORT=3000

systemd unit (process-scoped, recommended for services):
  [Service]
  Environment="NODE_ENV=production" "PORT=3000"
  EnvironmentFile=/run/secrets/myapp.env  ← injected at deploy time by external secret fetcher

Timing: available BEFORE process starts
Scope: entire process and all child processes
Rotation: requires process restart or systemd reload
─────────────────────────────────────────────────────────────────

LEVEL 2: CONTAINER-LEVEL (ECS, Kubernetes, Docker)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Docker:
  docker run -e DATABASE_URL=postgresql://host/db -e NODE_ENV=production myimage

  Docker Compose:
  services:
    api:
      image: myimage
      environment:
        - DATABASE_URL=postgresql://host/db
        - NODE_ENV=production
      env_file:             ← reads .env file at docker-compose up time
        - .env.production

ECS Task Definition (2 blocks — critical distinction):
  "environment": [              ← plaintext, visible in API calls, describe-tasks
    {"name": "PORT", "value": "3000"},
    {"name": "NODE_ENV", "value": "production"}
  ],
  "secrets": [                  ← fetched from SSM/Secrets Manager at container START
    {
      "name": "DATABASE_URL",
      "valueFrom": "arn:aws:ssm:ap-south-1:123:parameter/prod/myapp/DATABASE_URL"
    },
    {
      "name": "STRIPE_SECRET",
      "valueFrom": "arn:aws:secretsmanager:ap-south-1:123:secret:prod/stripe-Abcd12"
    }
  ]

Timing: injected by container runtime before application code runs
Scope: that container only (not shared with sidecar containers)
Rotation: container must be restarted to pick up new secret values
─────────────────────────────────────────────────────────────────

LEVEL 3: APPLICATION-LEVEL (runtime fetch)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Fetch from Secrets Manager at application STARTUP (not OS inject):

  // Node.js example
  const AWS = require('@aws-sdk/client-secrets-manager');
  const client = new AWS.SecretsManagerClient({ region: 'ap-south-1' });

  async function loadSecrets() {
    const response = await client.send(
      new AWS.GetSecretValueCommand({ SecretId: 'prod/myapp/secrets' })
    );
    const secrets = JSON.parse(response.SecretString);

    // Set in process for rest of app to read normally
    process.env.DATABASE_URL = secrets.database_url;
    process.env.STRIPE_SECRET = secrets.stripe_secret;
  }

  loadSecrets().then(() => startServer());

Benefits:
  ├── Can implement rotation WITHOUT container restart
  │     (re-fetch every 24h and update in-memory connection pool)
  ├── Single secret contains multiple secrets as JSON blob
  ├── Can provide fallback / graceful degradation if fetch fails
  └── Works for non-containerized Lambda (cold start fetch)

Costs:
  ├── Network call at startup (adds 50-200ms cold start latency)
  ├── More complex application code
  ├── Need retry logic for transient Secrets Manager failures
  └── IAM role must have secretsmanager:GetSecretValue permission
```

---

## SECTION 6 — System Design Importance

### What It Is and Why It's Catastrophic

Cross-environment contamination = production code connects to staging DB, or staging test deletes production data.

```
How it happens — the subtle version:

Step 1: Developer tests staging locally
  .env file locally:
    DATABASE_URL=postgresql://staging.rds.internal/mydb_staging
    NODE_ENV=staging

Step 2: Deploy to production ECS — good, task definition has production DATABASE_URL

Step 3: But config service reads API endpoint from WRONG env var name:
  Code:   const apiUrl = process.env.EXTERNAL_API_URL;
  Staging task def: EXTERNAL_API_URL=https://api-staging.partner.com   ← correct
  Prod task def:    ← EXTERNAL_API_URL not set (forgotten!)

  Node.js: process.env.EXTERNAL_API_URL → undefined → falls back to... NOTHING
  App silently treats undefined as empty string
  All API calls to partner go to "" → 400 errors on partner API → "looks like partner is down"

Actually: missing env var, not partner being down
─────────────────────────────────────────────────────────────────

How it happens — the serious version (actual production incident pattern):

Engineer deploys new service to staging
Task definition template shared between staging and production
Engineer copies SSM parameter path from staging docs
Production task definition accidentally points to SSM path: /staging/myapp/DATABASE_URL
Container starts in production → connects to staging database
First engineer to write data: writes production data to staging DB
Staging DB has different schema version → chaos

Prevention:
  1. SSM paths MUST include environment:
      /dev/myapp/DATABASE_URL
      /staging/myapp/DATABASE_URL
      /prod/myapp/DATABASE_URL

  2. IaC (Terraform/CDK) generates SSM paths dynamically from var.environment variable
     NEVER hardcode SSM paths in task definitions

  3. Application startup adds log line:
      console.log(`Environment: ${process.env.NODE_ENV}, DB: ${process.env.DATABASE_HOST}`)
      → Immediately visible in CloudWatch which DB this container is using

  4. Connection string parsing verification at startup:
      const url = new URL(process.env.DATABASE_URL);
      if (process.env.NODE_ENV === 'production' && url.hostname.includes('staging')) {
        throw new Error('FATAL: Production container pointing to staging database!');
      }
```

---

## SECTION 7 — AWS & Cloud Mapping

### Why Rotation Breaks Applications

```
Scenario: Secrets Manager rotates RDS password automatically (every 30 days)

What happens WITHOUT proper handling:
─────────────────────────────────────────────────────────────────
T+0:  Secrets Manager rotates DB password for prod/myapp/db-password
T+1:  RDS password updated to new value (old value now INVALID on RDS)
T+2:  ECS containers still running with OLD password in process.env
      (ECS injected secret at container start 8 days ago)
T+3:  New database connections fail: authentication error
T+4:  Connection pool exhausted, existing connections still work
T+5:  Application starts returning 500s for any request needing DB
T+6:  PagerDuty fires
T+7:  On-call engineer restarts ECS service
T+8:  New containers start, fetch NEW secret from Secrets Manager
T+9:  All connections work again
Total downtime: ~10 minutes (time to page + time to restart)
─────────────────────────────────────────────────────────────────

What happens WITH proper handling (zero-downtime rotation):
─────────────────────────────────────────────────────────────────
When using Secrets Manager rotation with RDS:
  1. Secrets Manager generates new password
  2. Updates RDS to accept BOTH old AND new password (using RDS multi-user rotation)
  3. Updates secret in Secrets Manager to new password
  4. Running containers have grace period where old password still works
  5. On next container restart/deploy, new password picked up
  6. After all containers rotated: old password removed from RDS

Application-side: fetch secret fresh for each new connection (not cached forever)
  Instead of: cache DATABASE_URL at startup permanently
  Do: check secret version every N hours, refresh connection pool if changed

// Explicit rotation-aware pattern
let secretVersion = null;
let dbPool = null;

async function getDbPool() {
  const secret = await secretsManager.getSecretValue({ SecretId: 'prod/db', VersionStage: 'AWSCURRENT' });

  if (secret.VersionId !== secretVersion) {
    // Secret rotated! Create new pool
    secretVersion = secret.VersionId;
    if (dbPool) await dbPool.end();
    dbPool = createPool(JSON.parse(secret.SecretString));
  }

  return dbPool;
}
```

---

## SECTION 8 — Interview Preparation

**Beginner:**

**Q: What is an environment variable and why do we use them?**
**A:** An environment variable is a named value available to a running program from its operating environment â€” outside the code. Instead of writing const DB_HOST = 'prod-db.example.com' in your code (hardcoded), you write const DB_HOST = process.env.DB_HOST and set the actual value on the server. This means the same code runs in development (pointing to a local DB) and production (pointing to the real DB) by changing environment, not code.

**Q: What is the danger of committing a .env file to Git?**
**A:** A .env file contains real secrets (database passwords, API keys). If you commit it to a public GitHub repository, it's immediately indexed by bots that specifically scan for secrets. Your credentials can be stolen within minutes. Even in private repos, it's a security risk (team members who later leave still have git history). Always add .env to .gitignore, use .env.example (with placeholder values) as documentation, and store real secrets in AWS Secrets Manager or SSM Parameter Store.

**Q: How do environment variables get into an ECS container?**
**A:** Three ways: (1) *Hard-coded in task definition* â€” values visible in ECS console, OK for non-sensitive config. (2) *SSM Parameter Store reference* â€” task definition references parameter ARN; ECS injects it at runtime. (3) *Secrets Manager reference* â€” for passwords/API keys; ECS fetches and injects encrypted values. Never set sensitive values as plain-text in the task definition. Always use option 2 or 3 for anything secret.

---

**Intermediate:**

**Q: What is the difference between build-time and runtime environment variables in a containerized app?**
**A:** *Build-time:* variables used during docker build (e.g., ARG NODE_ENV=production, REACT_APP_API_URL for React apps that bundle the URL into the JavaScript). These are baked into the image layer â€” changes require a rebuild. *Runtime:* variables injected when the container starts (e.g., DATABASE_URL, JWT_SECRET). These can change between deployments without rebuilding. Rule: never put secrets as build-time ARG values (they're visible in docker history). All sensitive config must be runtime.

**Q: What is config drift and how does it cause production incidents?**
**A:** Config drift means your development, staging, and production environments have different environment variable values â€” and you've lost track of which is current truth. Common scenarios: a developer tests with FEATURE_X_ENABLED=true locally, forgets to update staging, discovers in production review that staging has alse. Or production has a performance tuning variable set manually 6 months ago that no one documented. Prevention: use infrastructure-as-code (Terraform/CDK) to define all environment variables, with code review for changes. Never manually edit environment variables on running servers.

**Q: How do you validate required environment variables at application startup?**
**A:** Fail fast on startup if critical config is missing. In Node.js, use joi or manual validation:
`js
const required = ['DATABASE_URL', 'JWT_SECRET', 'AWS_REGION'];
const missing = required.filter(key => !process.env[key]);
if (missing.length > 0) {
  console.error('Missing required env vars:', missing.join(', '));
  process.exit(1);  // Crash immediately â€” don't start serving traffic
}
`
This is better than discovering at runtime (e.g., first DB query) that DATABASE_URL is undefined â€” which causes cryptic errors that take time to debug.

---

**Advanced (System Design):**

**Scenario 1:** You have 15 microservices deployed on ECS, each needing ~20 environment variables. Some variables are shared (e.g., AWS region, log level), others are service-specific (database URLs, service-specific API keys). Design an environment variable management system that: (1) prevents drift between services and environments, (2) allows secrets rotation without redeployment, and (3) supports the principle of least privilege.

*Architecture:* SSM Parameter Store with path-based hierarchy: /app/{env}/{service}/{variable}. Shared variables: /app/prod/shared/LOG_LEVEL. Service-specific: /app/prod/payment-service/DATABASE_URL. ECS task role grants ssm:GetParameters only for its service's path prefix (least privilege). Rotation: update the SSM parameter â†’ ECS tasks reload vars on next deployment OR use Secrets Manager with automatic rotation (no redeployment needed). IaC: Terraform manages all parameters as code, PR review for any change.

**Scenario 2:** A production incident is traced to a service that started returning 500 errors after a deployment. Investigation reveals a required environment variable (PAYMENT_GATEWAY_API_KEY) was not set in the ECS task definition for the new revision â€” the variable was accidentally removed from the Terraform config. How do you prevent this in future deployments?

*Prevention:* (1) Startup validation (fail-fast check for all required vars at process start â€” would have caught this immediately on deploy). (2) Smoke test in CD pipeline: after deploy, run a curl check against /health endpoint that internally validates config. (3) ECS health check: if process exits on startup (due to missing var), ECS health check fails â†’ deployment rollback triggered automatically. (4) Terraform plan review: required review of any change to environment variable list before apply.

