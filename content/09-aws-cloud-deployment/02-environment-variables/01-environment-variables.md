# Environment Variables

## FILE 01 OF 03 — Physical Infrastructure Replaced, Architecture Position & Core Concepts

> **Architect Training Mode** | Senior Principal Architect Perspective
> _Optimized for: design judgement · tradeoff evaluation · failure prediction · production debugging_

---

## SECTION 1 — Intuition (Explain Like a 12-Year-Old)

### Before Environment Variables: Hardcoded Config in Code

In pre-cloud, pre-DevOps systems, configuration was often:

- **Hardcoded in source code** — database connection strings, API keys, ports baked into `.java` or `.php` files
- **Config files committed to version control** — `config.properties` with production passwords in the Git repository
- **Per-server manual configuration** — engineer SSHes in, edits `/etc/app/config.ini` by hand on each server
- **Separate builds per environment** — different WAR files for dev, staging, prod with different DB credentials compiled in

This was **synchronous, risky, non-auditable** configuration management:

- Rotating a database password required recompiling and redeploying the entire application
- A credential leaked in one Git commit was permanently in history
- Config drift between servers was invisible until something broke

**Environment variables replace:**

| Old Method                            | Environment Variable Equivalent                       |
| ------------------------------------- | ----------------------------------------------------- |
| Hardcoded DB URL in source code       | `DATABASE_URL` env var read at startup                |
| Credentials in committed `config.ini` | AWS Secrets Manager → injected as env var             |
| Per-server SSH config editing         | ECS task definition `environment` block               |
| Different builds per environment      | Same Docker image, different env vars per env         |
| Shared `deploy.properties` in repo    | `.env` file gitignored, SSM Parameter Store for CI/CD |

---

### The 12-Factor App Principle (The Standard You're Following)

The [12-Factor App](https://12factor.net/) methodology, Factor III: **Config**

> "An app's config is everything that is likely to vary between deploys (staging, production, developer environments). This includes resource handles to the database, credentials to external services, per-deploy values such as the canonical hostname for the deploy. Apps sometimes store config as constants in the code. This is a violation of twelve-factor, which requires **strict separation of config from code**."

The test: **"Could this codebase be open-sourced right now, without exposing credentials?"**
If no → config is leaking into code.

---

## SECTION 2 — Core Technical Explanation

```
┌─────────────────────────────────────────────────────────────────┐
│                    CONFIG SOURCES                               │
│                                                                 │
│  ┌─────────────┐  ┌─────────────────┐  ┌──────────────────┐   │
│  │ .env file   │  │ SSM Parameter   │  │ Secrets Manager  │   │
│  │ (local dev) │  │ Store           │  │ (secrets)        │   │
│  └──────┬──────┘  └────────┬────────┘  └────────┬─────────┘   │
└─────────┼──────────────────┼─────────────────────┼─────────────┘
          │   injected at    │    injected at       │
          │   process start  │    deploy time       │ fetched at runtime
          ▼                  ▼                      ▼
┌──────────────────────────────────────────────────────────────────┐
│                  RUNTIME (Process / Container)                   │
│                  process.env.DATABASE_URL                        │
│                  os.environ['API_KEY']                           │
│                  System.getenv("PORT")                           │
└──────────────────────────────────────────────────────────────────┘

Env vars sit BETWEEN config sources and running code.
They are the INTERFACE between infrastructure and application.
Application code READS env vars. Application code NEVER writes its own env vars.
```

**The critical layering:**

1. **Local dev**: `.env` file loaded by `dotenv` library
2. **CI/CD**: GitHub Actions secrets → injected as env vars during build/test
3. **ECS/EC2 staging/prod**: SSM Parameter Store or Secrets Manager → task definition or user data
4. **Lambda**: Function environment variables (for non-secrets) or SSM at cold start (for secrets)

---

## SECTION 3 — Architecture Diagram (MANDATORY)

```
DEVELOPMENT ENVIRONMENT
────────────────────────
Developer's laptop
  ├── .env file (gitignored):
  │     DATABASE_URL=postgresql://localhost:5432/myapp_dev
  │     REDIS_URL=redis://localhost:6379
  │     NODE_ENV=development
  │     API_KEY=test_key_12345
  └── dotenv library loads .env on process start

  .gitignore:
    .env
    .env.local
    .env.*.local

  Committed to repo (.env.example):
    DATABASE_URL=postgresql://HOST:PORT/DBNAME   ← structure, no values
    REDIS_URL=redis://HOST:6379
    NODE_ENV=development
    API_KEY=your_api_key_here

─────────────────────────────────────────────────────────────────
CI/CD (GitHub Actions)
────────────────────────
GitHub Repository Secrets:
  STAGING_DATABASE_URL  → injected as env var during workflow run
  STAGING_API_KEY       → injected as env var
  AWS_ROLE_ARN          → for AWS deployments

Workflow:
  env:
    DATABASE_URL: ${{ secrets.STAGING_DATABASE_URL }}
  run: npm test  ← tests run with real staging config

─────────────────────────────────────────────────────────────────
ECS PRODUCTION DEPLOYMENT
──────────────────────────
SSM Parameter Store (non-secrets, plaintext):
  /prod/myapp/DATABASE_HOST      = rds.cluster.ap-south-1.rds.amazonaws.com
  /prod/myapp/REDIS_HOST         = redis.cluster.cache.amazonaws.com
  /prod/myapp/PORT               = 3000
  /prod/myapp/NODE_ENV           = production

Secrets Manager (secrets, encrypted):
  /prod/myapp/DB_PASSWORD        = { encrypted value }
  /prod/myapp/STRIPE_SECRET_KEY  = { encrypted value }
  /prod/myapp/JWT_SECRET         = { encrypted value }

ECS Task Definition:
  environment:           ← plaintext (SSM values read at deploy time)
    - name: DATABASE_HOST
      value: rds.cluster.ap-south-1.rds.amazonaws.com
    - name: PORT
      value: "3000"

  secrets:               ← fetched at container start FROM Secrets Manager / SSM
    - name: DB_PASSWORD
      valueFrom: arn:aws:secretsmanager:ap-south-1:123:secret:/prod/myapp/DB_PASSWORD
    - name: STRIPE_SECRET_KEY
      valueFrom: arn:aws:ssm:ap-south-1:123:parameter/prod/myapp/STRIPE_SECRET_KEY

Application code (Node.js):
  const db = new Pool({
    host: process.env.DATABASE_HOST,    ← reads at runtime
    password: process.env.DB_PASSWORD,  ← already in process env (injected by ECS)
  });
```

---

## SECTION 4 — Request Flow (MANDATORY FLOWCHART)

### How Process Environment Inheritance Works

```
OS starts → init/systemd has base environment
     │
     └── systemd starts your app process
           App process inherits ALL of systemd's environment
             App process can set env vars (visible only to itself + its children)
             App process CANNOT affect parent's env vars

     └── App process forks child process (e.g., runs a shell command)
           Child inherits ALL of parent's current environment
           Child sets a var → NOT visible to parent (one-way inheritance)

Key implication:
  export DATABASE_URL=postgresql://...  ← export makes it available to children
  DATABASE_URL=postgresql://...         ← no export = only available in current shell

  In scripts called by your app: they inherit app's environment
  In systemd: use Environment= or EnvironmentFile= in unit file

  [Service]
  Environment="NODE_ENV=production"
  Environment="PORT=3000"
  EnvironmentFile=/etc/myapp/secrets.env  ← file-based env vars (keep secrets off disk usually)
```

### Environment Variable Priority (when multiple sources define same var)

```
Lowest priority → Highest priority (last wins if same key defined multiple times)

1. System-wide defaults (/etc/environment)
2. Shell profile (~/.bashrc, ~/.profile)
3. systemd unit Environment= lines
4. EnvironmentFile= file
5. Inline overrides at process start: NODE_ENV=test npm test
6. dotenv .env file (loaded by library — depends on library's load order)
7. Explicit: process.env.VAR = 'value' (runtime code override — avoid this)

Gotcha: dotenv library loads AFTER process starts.
  Any env var already set in the environment is NOT overridden by .env
  This is correct behavior (system environment > .env file)
  But it surprises developers who set DATABASE_URL locally and wonder why .env override doesn't work
```

---

### Security Considerations: What Can Go Wrong

### The Secrets-in-Plaintext Problem

```
Risk Level    What you're doing                    Why dangerous
─────────────────────────────────────────────────────────────────────
CRITICAL      API_KEY=sk-live-xxx in source code  In version control forever (git history)
HIGH          Secrets in .env committed to repo    All collaborators see prod credentials
HIGH          Secrets as plaintext ECS env vars   Visible in ECS console, CloudTrail, describe-tasks
MEDIUM        Secrets in CloudWatch Logs           "Starting server... STRIPE_KEY=sk_live_..." logged at startup
MEDIUM        Secrets in SSM Parameter (not SecureString) → readable without audit by all IAM users who can read params
LOW           Secrets Manager with resource policy → only specific roles can read, full rotation support
```

### The "env" Command in Logs Leak

```
Common accidental secret exposure:
  Startup script that does:
    env | logger -t myapp    ← logs ALL environment variables including secrets

  Or worse in code:
    console.log('Starting with config:', process.env)   ← logs ALL env vars to CloudWatch!
    print(f"Config: {os.environ}")                      ← Python equivalent

  Result: All secrets visible in CloudWatch Logs to anyone with CloudWatch access

Checklist to prevent log leaks:
  ├── Never log process.env or os.environ directly
  ├── Log a specific whitelist of non-secret config values
  ├── Use a secrets-aware config library that masks sensitive keys in toString()
  └── CloudWatch Logs resource policy: restrict who can view prod log groups
```

---

### Common Misconfigurations

### 1. Secrets as Plaintext ECS Environment Variables

```
WRONG — plaintext visible in ECS console and CloudTrail describe-tasks:
  environment:
    - name: DB_PASSWORD
      value: "SuperSecret123!"

RIGHT — injected from Secrets Manager, not visible in describe-tasks:
  secrets:
    - name: DB_PASSWORD
      valueFrom: "arn:aws:secretsmanager:us-east-1:123456:secret:prod/db-password"
```

### 2. Forgetting dotenv in Production

```
Very common mistake: developer uses dotenv in local dev
  Assumes it works in production ECS
  In ECS: there is no .env file. Environment variables come from task definition.
  dotenv finds nothing → application starts with missing DATABASE_URL → crash

Rule: dotenv should only load in development
  if (process.env.NODE_ENV !== 'production') {
    require('dotenv').config();
  }

  Or: use dotenv with `path` set, and have CI/CD create the file before start
  Either way: ECS production should NEVER rely on .env files
```

### 3. Missing Required Variable Check at Startup

```
Bad: Application starts, DB_PASSWORD is undefined, first DB query fails at runtime
  User gets 500 error 10 minutes into using the app

Good: Validate all required env vars at startup — fail fast, fail loud
  const required = ['DATABASE_URL', 'REDIS_URL', 'STRIPE_SECRET_KEY', 'JWT_SECRET'];
  const missing = required.filter(key => !process.env[key]);
  if (missing.length > 0) {
    console.error(`FATAL: Missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);   ← crash at startup, not after first user request
  }

ECS will see: task exited with code 1 → won't mark task as healthy → service fails safe
              (no traffic routed to a misconfigured container)
```

---

## KEY TAKEAWAYS — FILE 01

- Env vars = interface between infrastructure config and application code. Never hardcode what varies per environment.
- The 12-Factor test: could the codebase be open-sourced right now without exposing credentials?
- **Secrets → Secrets Manager** (encrypted, audited, rotation support). Non-secret config → SSM Parameter Store (cheaper) or task definition `environment` block.
- In ECS: use `secrets` block for Secrets Manager values, NOT `environment` block. Plaintext in `environment` = visible in CloudTrail.
- Never log `process.env` or `os.environ` directly — secrets leak to CloudWatch.
- **Validate all required env vars at startup** — crash immediately on missing config, not after user request.
- dotenv = development only. Production config comes from the deployment platform (ECS task def, Lambda env, systemd unit).

---

_Continue to File 02 → Injection patterns, rotation, partial failures & production incidents_
