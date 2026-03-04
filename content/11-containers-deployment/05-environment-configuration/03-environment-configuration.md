# Environment Configuration

## FILE 03 OF 03 — Design Decisions, Interview Q&A & Architect's Mental Model

> **Architect Training Mode** | Platform Engineer / DevOps Architect Perspective
> _Optimized for: design reviews · system design interviews · architecture decisions under pressure_

---

## SECTION 9 — Certification Focus (AWS SAA-C03)

### Decision 1: Secrets Manager vs Parameter Store

```
DECISION MATRIX:

Use Secrets Manager when:
  ✅ Credentials that MUST rotate automatically (RDS passwords, service keys)
  ✅ Compliance requirements (SOC2, HIPAA, PCI-DSS) demand regular rotation evidence
  ✅ Multi-account architectures (cross-account access via resource policy)
  ✅ JSON secrets (username + password + host as one object)
  ✅ Cost is not the primary constraint

Use Parameter Store (SecureString) when:
  ✅ Cost sensitivity: $0/month vs $0.40/secret/month for each secret
  ✅ Non-rotating secrets (third-party API keys that rarely change)
  ✅ Hierarchical config organization: /prod/myapp/database/host
  ✅ Mixing sensitive + non-sensitive: StringList for config, SecureString for secrets
  ✅ Simple single-value secrets, not complex JSON objects

Use Parameter Store (String/StringList) when:
  ✅ Non-sensitive config that changes at runtime (feature flags, URLs, counts)
  ✅ Free tier acceptable
  ✅ Needs to be readable without KMS permissions

AVOID THIS COMMON ANTI-PATTERN:
  Using Parameter Store SecureString for DB passwords with manual rotation →
  rotation becomes a manual checklist item → gets forgotten → password 18 months old.

  If the credential is important enough to secure, it's important enough to rotate.
  Important + rotating → Secrets Manager. Period.

COST REALITY CHECK (for a typical 5-service app):
  Secrets Manager:
    15 secrets × $0.40 = $6/month baseline
    API calls: ~5000/month = $0.025
    Total: ~$6/month

  Parameter Store:
    Standard tier: FREE
    Advanced tier (if needed): $0.05/10k API calls

  $6/month for auto-rotation that prevents a credential-compromise incident:
  One incident = 4 hours engineer time = $200+ minimum.
  ROI on $6/month: obvious.
```

### Decision 2: When to Use Build-time ARG vs Runtime ENV

```
BUILD-TIME ARG — use for:
  APP_VERSION (git SHA, semver): baked into binary for traceability
    ARG APP_VERSION=unknown
    ENV APP_VERSION=${APP_VERSION}
    # docker build --build-arg APP_VERSION=$(git rev-parse --short HEAD) .
    # process.env.APP_VERSION = "a3f7c9b" in production
    # Used in /health response for deployment verification

  NEVER for:
    Any value that differs between environments (need to rebuild for each env → defeats purpose)
    Any sensitive value (ARG values visible in docker history)

RUNTIME ENV (ECS environment block) — use for:
  Environment-specific non-sensitive config:
    DATABASE_HOST = prod-db.cluster.rds.amazonaws.com
    REDIS_URL = redis://prod.cache.amazonaws.com:6379
    LOG_LEVEL = info
    MAX_POOL_SIZE = 20
    AWS_REGION = us-east-1

RUNTIME SECRETS (ECS secrets block → Secrets Manager) — use for:
  All credentials, tokens, signing keys:
    DATABASE_PASSWORD
    JWT_SECRET
    STRIPE_SECRET_KEY
    SENDGRID_API_KEY
    OAUTH_CLIENT_SECRET

THE INVARIANT:
  Build once → Deploy everywhere.
  Any value that differs between dev/staging/prod MUST be runtime-injected.
  If you need to rebuild the image per environment → you have a config architecture problem.
```

### Decision 3: Environment Variables vs Config Files vs Feature Flag Service

```
ENVIRONMENT VARIABLES: Best for
  ✅ Credentials and secrets (via Secrets Manager)
  ✅ Service discovery (URLs, hostnames, ports)
  ✅ Simple boolean flags (ENABLE_FEATURE_X=true)
  ✅ 12-factor compliance
  ⚠ Limitations: changing them requires ECS task restart (no hot reload)

Config files (S3 + app reads at startup): Better for
  ✅ Complex hierarchical configuration (many keys, nested)
  ✅ Config too large for env vars (>4KB limit in some systems)
  ✅ Config managed by non-engineers (product team edits JSON file in S3)
  ⚠ Requires IAM permissions for S3 read in task role
  ⚠ App must poll or restart to pick up changes

Feature Flag Service (LaunchDarkly, AWS AppConfig, Unleash): Best for
  ✅ Flags that change frequently without deployment
  ✅ Gradual rollouts (10% → 50% → 100% of users)
  ✅ A/B testing
  ✅ Emergency kill switches (disable payment processing in real-time)
  ✅ User/segment targeting
  ⚠ Additional dependency, cost, SDK integration needed

TYPICAL ARCHITECTURE FOR GROWTH STAGE APP:
  Environment variables → non-sensitive runtime config + service endpoints
  Secrets Manager      → credentials, signing keys
  AWS AppConfig        → feature flags (free with AWS, no external service dependency)
  Nowhere in code      → no hardcoded URLs, passwords, or feature toggles
```

---

## SECTION 10 — Comparison Table

```
TRAP 1: "The ECS task role and task execution role are the same thing"
  WRONG. Two separate roles with different purposes:

  EXECUTION ROLE: Used by ECS INFRASTRUCTURE to:
    - Pull images from ECR
    - Fetch secrets from Secrets Manager (task definition secrets: block)
    - Write logs to CloudWatch

  TASK ROLE: Used by YOUR APPLICATION CODE to:
    - Call AWS services from inside the container (S3, DynamoDB, SQS...)
    - Get secrets from Secrets Manager using the AWS SDK in code

  Add Secrets Manager permission to EXECUTION ROLE for task definition secrets: block.
  Add Secrets Manager permission to TASK ROLE if fetching in application code.
  Getting this wrong → task fails to start (execution role) or 403 at runtime (task role).

TRAP 2: "process.env auto-updates when Secrets Manager rotates"
  WRONG. process.env is set ONCE at container startup. It's static for the lifetime of the process.
  Secrets Manager rotation → secrets change → running containers still have old value.
  Fix: force ECS rolling deployment after rotation (EventBridge → Lambda → force-new-deployment).
  OR: fetch from Secrets Manager SDK at runtime (not at startup), cache with TTL.

TRAP 3: "ARG values are safe because they're build-time only"
  HALF WRONG. ARG values don't persist in the container environment at runtime.
  BUT: ARG values ARE visible in `docker history --no-trunc`.
  Anyone with docker pull access to your image can read ARG values.
  NEVER: ARG for secrets. ARG for version numbers, build flags: OK.

TRAP 4: "Environment variables in compose.yaml are the same as .env file"
  DIFFERENT SOURCES:
    environment: block in compose.yaml → set directly (hardcoded)
    env_file: .env → read from file (gitignored)
    ${VAR} in compose.yaml → substituted from shell env or .env file

  Secrets in environment: block → in compose.yaml → potentially in git. Bad.
  Secrets in .env (gitignored) → referenced via ${SECRET_VAR} in compose.yaml. Good.

TRAP 5: "NODE_ENV controls security features"
  PARTIAL TRUTH. NODE_ENV=production is just a string. Its effects depend on what libraries check it.
  Express: NODE_ENV=production disables verbose error responses.
  Some ORMs: NODE_ENV=production enables connection pooling defaults.
  Custom code that checks if (process.env.NODE_ENV !== 'production') to skip auth: DANGER.
  Never use NODE_ENV as a security gate. Use explicit security configuration.

TRAP 6: "Once in Secrets Manager, the secret is automatically used by my app"
  WRONG. Secrets Manager is just a vault. Your app must be explicitly wired to use it.
  Wiring options:
    a) ECS task definition secrets: block → value injected as env var at container start
    b) AWS SDK call in application code: GetSecretValue → parse JSON → use value
  Without explicit wiring → the secret exists but your app doesn't know about it.
```

---

## SECTION 11 — Quick Revision

**Q: How do you manage secrets for a production application on AWS ECS?**

> I store secrets in AWS Secrets Manager, never in the application code, Dockerfile, or git. In the ECS task definition, the `secrets:` block maps a Secrets Manager ARN to an environment variable name. At container startup, ECS (using the task execution role) calls `GetSecretValue` and injects the value as a normal environment variable — the application calls `process.env.JWT_SECRET` transparently. For auto-rotation, I configure Secrets Manager's native RDS rotation and an EventBridge rule that triggers a Lambda to force a new ECS deployment after rotation, preventing stale-credential incidents.

**Q: What's the difference between the ECS task execution role and the task role?**

> They serve completely different purposes. The task execution role is used by the ECS infrastructure layer — it lets ECS pull images from ECR, fetch secrets from Secrets Manager at container startup, and write logs to CloudWatch. The task role is assumed by your application code running inside the container — it lets your Node.js app call S3, DynamoDB, or call Secrets Manager at runtime via the SDK. Confusing them is a common source of "AccessDeniedException" errors: if your task fails to start because it can't fetch a secret, check the execution role. If your app gets 403 calling AWS services, check the task role.

**Q: Why shouldn't you use :latest or hardcoded values in a Dockerfile ENV for production config?**

> Two separate concerns. `:latest` is a mutable tag that silently changes under your deployments. For `ENV` in Dockerfiles: build-time ENV creates the same value in every deployment of that image — so it's fine for non-sensitive defaults like `PORT=8080`. But anything environment-specific (like a database URL) or sensitive (like a password) must NOT be in `ENV` because: (1) it's baked into the image — staging and production get the same value unless you build separate images per environment, defeating "build once, deploy everywhere," and (2) secrets in ENV are visible in `docker inspect` and `docker history`.

**Q: A secret rotated in Secrets Manager but production is throwing database authentication errors. Why?**

> Classic stale-credentials problem. ECS tasks fetched the secret value at startup and stored it in `process.env`. When Secrets Manager rotated the secret, the new password was set in RDS and Secrets Manager — but the running containers never re-read `process.env`. They're still using the old password, which RDS now rejects. Fix: automate an ECS rolling deployment after rotation using EventBridge + Lambda `update-service --force-new-deployment`. New tasks start, fetch the new credential, old tasks drain gracefully. Zero downtime.

**Q: How would you prevent config drift between staging and production environments?**

> Three practices: First, manage ECS task definitions in Terraform — environment variables are code, reviewed in PRs, and both environments are defined in the same repo. Configuration drift becomes a diff visible before merge. Second, startup validation in the application that lists every required environment variable and `process.exit(1)` if any are missing — a missing var in production fails the deployment before it affects traffic. Third, CI check that compares the environment variable names in staging vs production task definitions and alerts if they diverge. The combination makes configuration a first-class artifact, not a manual console operation.

---

## SECTION 12 — Architect Thinking Exercise

```
PATTERN: Fail-fast config validation
  Validate all required env vars at application startup.
  Exit with clear error message listing missing vars.
  Fail in staging BEFORE reaching production.
  Better: failed deployment than silent undefined behavior in prod.

PATTERN: Config module — single source of truth in code
  All process.env access goes through one config.ts module.
  Type coercion, defaults, and validation in one place.
  Searchable: "config.database.url" vs ctrl+F "DATABASE_URL" in 40 files.

PATTERN: Secrets Manager with rotation + ECS auto-restart
  Secret in Secrets Manager with 30-day rotation.
  EventBridge rule on RotateSecret event.
  Lambda triggers force-new-deployment.
  New ECS tasks pick up new credential automatically.
  Zero manual intervention. Zero downtime.

PATTERN: Non-secret config in Parameter Store with env prefix
  /prod/myapp/* — readable by prod task execution role only
  /staging/myapp/* — readable by staging task execution role only
  IAM boundary enforced by ARN prefix in policy Resource.
  New engineer adding config: follows path convention automatically.

PATTERN: .env.example as living documentation
  Every required env var documented in .env.example.
  .env.example updated in the SAME PR that adds the new env var.
  Code review catches: "you added DATABASE_REPLICA_URL in code but not in .env.example."
  New developer cloning repo: complete setup guide, one file.
```

---

### Architect's Mental Model

```
┌─────────────────────────────────────────────────────────────────────┐
│          ENVIRONMENT CONFIGURATION ARCHITECT'S MENTAL MODEL         │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  RULE 1: Config is code. Treat it accordingly.                      │
│  ─────────────────────────────────────────────────────────────────  │
│  Config in ECS task definitions → IaC (Terraform/CloudFormation).  │
│  Reviewed in PRs. Versioned. Audited. Not clicked in AWS Console.  │
│  A config change without code review is an unreviewed deployment.  │
│                                                                     │
│  RULE 2: The environment, not the image, determines behavior        │
│  ─────────────────────────────────────────────────────────────────  │
│  One image. Many environments. Behavior differs only through env.  │
│  Build-time config = same in all envs (metadata, defaults).        │
│  Runtime config = different per env (endpoints, credentials).       │
│  If you're building separate images per environment → rethink.      │
│                                                                     │
│  RULE 3: Secrets must be rotatable without a deployment             │
│  ─────────────────────────────────────────────────────────────────  │
│  A credential that can't be rotated without downtime is a          │
│  liability waiting to become an incident.                           │
│  Design for: secret rotates → ECS auto-restarts → zero downtime.   │
│  Secrets Manager + EventBridge + Lambda makes this automatic.       │
│                                                                     │
│  RULE 4: Fail loudly on startup, silently never                     │
│  ─────────────────────────────────────────────────────────────────  │
│  Missing env var at startup → crash immediately with clear message. │
│  Missing env var at runtime → undefined → cryptic 500 errors →     │
│  30-minute debugging session at 2am.                               │
│  Startup validation is worth 10 lines of code to save hours later. │
│                                                                     │
│  RULE 5: Know which IAM role to add permissions to                  │
│  ─────────────────────────────────────────────────────────────────  │
│  Infrastructure fetching secrets: execution role.                   │
│  Application calling AWS: task role.                               │
│  Getting confused costs: 30 minutes of "why does the task fail"    │
│  debugging every time a new secret or AWS service is added.        │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│  3 MISTAKES EVERY JUNIOR ENGINEER MAKES:                            │
│  1. .env committed to git → immediate secret leak, rotation        │
│     sprint, potential breach notification to customers              │
│  2. Secrets Manager rotated but no ECS restart → stale credential  │
│     → database auth failures → 3am incident, manual restart        │
│  3. Wrong IAM role → task fails to start → nothing in app logs →   │
│     30 minutes diagnosing ECS events before finding "AccessDenied" │
├─────────────────────────────────────────────────────────────────────┤
│  30-SECOND SYSTEM DESIGN ANSWER:                                    │
│  ─────────────────────────────────────────────────────────────────  │
│  "I follow 12-factor config: all config via environment, nothing    │
│  hardcoded. Non-sensitive runtime config goes in ECS task          │
│  definition environment: block. Credentials go in Secrets Manager  │
│  and are injected via ECS's secrets: block — the execution role    │
│  handles fetching at task startup. I automate credential rotation   │
│  with Secrets Manager's native rotation + EventBridge triggering   │
│  a Lambda that forces ECS rolling deployments after rotation, so   │
│  stale credentials never cause production incidents. Everything is  │
│  in Terraform — config drift is a diff in a PR, not a mystery."    │
└─────────────────────────────────────────────────────────────────────┘
```

---

### Quick Reference Cheatsheet

```
DECISION TREE — where does this config go?

Is it a credential / secret / token?
  YES → Secrets Manager (auto-rotation) or Parameter Store SecureString (no rotation needed)
        → ECS task definition secrets: block
  NO  → Is it environment-specific? (different in dev vs staging vs prod)
          YES → ECS task definition environment: block
                OR: Parameter Store String → read at startup
          NO  → Consider Dockerfile ENV default (or application code default)

IS IT IN GIT? CHECKLIST:
  ✅ Application code
  ✅ Dockerfile
  ✅ compose.yaml (without secret values — use ${VAR})
  ✅ Terraform for task definitions (without secret values — use data.aws_secretsmanager_secret_version)
  ✅ .env.example (template, no real values)
  ❌ .env (gitignored — real dev values)
  ❌ Any file with passwords, tokens, API keys, connection strings

QUICK IAM POLICY TEMPLATES:
  # Execution role (ECS infrastructure):
  secretsmanager:GetSecretValue on prod/myapp/*
  kms:Decrypt on the KMS key used for secret encryption
  ssm:GetParameters + ssm:GetParameter on /prod/myapp/*
  ecr:GetAuthorizationToken, ecr:BatchGetImage, ecr:GetDownloadUrlForLayer
  logs:CreateLogStream, logs:PutLogEvents

  # Task role (application code):
  s3:GetObject, s3:PutObject on myapp-prod-bucket/*
  dynamodb:GetItem, dynamodb:PutItem on myapp-prod-table
  secretsmanager:GetSecretValue (only if fetching secrets in app code, not via task def)
```
