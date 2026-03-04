# Environment Configuration

## FILE 01 OF 03 — Core Concepts, Architecture & Production Patterns

> **Architect Training Mode** | Platform Engineer / DevOps Architect Perspective
> _Optimized for: design judgement · tradeoff evaluation · failure prediction · production debugging_

---

## SECTION 1 — Intuition (Explain Like a 12-Year-Old)

```
PROBLEM WITHOUT PROPER CONFIG MANAGEMENT:
  "It works in staging but fails in production."
  Production and staging configs differ. Where? Nobody is sure.
  Config is hardcoded in source files. Changing it requires a new build and deploy.
  Secrets are in git. Engineers have left the company. We don't know who has them.

THE 12-FACTOR RULE:
  "Store config in the environment."

  WHAT IS CONFIG?
    Anything that varies between deployments (dev, staging, prod):
    ├── Database URLs, credentials
    ├── External service API keys (Stripe, SendGrid, Twilio)
    ├── Feature flags
    ├── Environment name (NODE_ENV)
    ├── Log level (LOG_LEVEL)
    └── Resource limits, timeouts, ports

  WHAT IS NOT CONFIG? (belongs in code, not environment vars)
    Application logic
    Static HTML/CSS/JS assets
    Internal routing between microservices of same deployment

  TEST: Can you open-source your codebase right now without exposing credentials?
    YES → Config properly separated from code. ✅
    NO  → Secrets are in source code somewhere. Fix this. ❌

THE CANONICAL HIERARCHY (highest priority wins):
  1. AWS Secrets Manager / Parameter Store (secrets, managed rotation)
  2. ECS task definition runtime injection (environment/secrets blocks)
  3. Dockerfile ENV defaults (hardcoded non-sensitive defaults)
  4. Application defaults (port fallback, retry count)

  Never: .env file in production. Never: config baked into image at build time.
```

---

## SECTION 2 — Core Technical Explanation

```
BUILD TIME (Dockerfile ARG/ENV):
  Written into the image during `docker build`.
  Frozen. Same in every deployment of that image.
  Visible to anyone with access to the image (docker inspect, docker history).

  WHAT BELONGS AT BUILD TIME:
    ARG APP_VERSION=unknown     ← git SHA/version for traceability
    ENV NODE_ENV=production     ← process.env.NODE_ENV default
    ENV PORT=8080               ← sensible default, overridable at runtime
    ENV LOG_FORMAT=json         ← operational default

  WHAT NEVER BELONGS AT BUILD TIME:
    ❌ DATABASE_URL             → changes per environment (dev/staging/prod)
    ❌ JWT_SECRET               → sensitive, environment-specific
    ❌ API_KEYS                 → sensitive, may rotate
    ❌ FEATURE FLAGS            → may need to change without rebuild

RUNTIME (injected at container startup):
  Injected when the container starts, not when the image is built.
  Different values for dev, staging, production — same image.
  Is the correct place for all environment-specific and sensitive config.

  METHODS:
    docker run:           -e DATABASE_URL=postgres://...
    Docker Compose:       environment: block or env_file:
    ECS Fargate:          environment: [] and secrets: [] in task definition
    Kubernetes:           ConfigMap (non-sensitive) + Secret (sensitive)

THE CORE RULE:
  BUILD-TIME: app defaults, process metadata, non-sensitive constants
  RUNTIME:    environment-specific values, credentials, service endpoints

  If the value differs between dev and prod → it MUST be runtime-injected.
  If the value is a secret → it MUST be runtime-injected via secrets manager.
```

---

## SECTION 3 — Architecture Diagram (MANDATORY)

```json
// ECS Task Definition — container definition section
{
  "containerDefinitions": [
    {
      "name": "api",
      "image": "123456789.dkr.ecr.us-east-1.amazonaws.com/myapp:a3f7c9b",

      // ── environment: non-sensitive runtime config ──────────────────────
      // Values stored PLAINTEXT in task definition (visible in AWS Console)
      // Use for: URLs, ports, feature flags, log levels, environment names
      "environment": [
        { "name": "NODE_ENV", "value": "production" },
        { "name": "PORT", "value": "8080" },
        { "name": "LOG_LEVEL", "value": "info" },
        {
          "name": "REDIS_URL",
          "value": "redis://my-elasticache.cache.amazonaws.com:6379"
        },
        {
          "name": "DATABASE_HOST",
          "value": "my-rds.cluster.us-east-1.rds.amazonaws.com"
        }
      ],

      // ── secrets: sensitive values from Secrets Manager / Parameter Store ─
      // Values NEVER stored in task definition — fetched at container startup
      // Container receives them as environment variables (transparent to app code)
      // Use for: passwords, tokens, API keys, connection strings with credentials
      "secrets": [
        {
          "name": "DATABASE_PASSWORD", // env var name in container
          "valueFrom": "arn:aws:secretsmanager:us-east-1:123456789:secret:prod/myapp/db-password"
        },
        {
          "name": "JWT_SECRET",
          "valueFrom": "arn:aws:secretsmanager:us-east-1:123456789:secret:prod/myapp/jwt-secret"
        },
        {
          "name": "STRIPE_SECRET_KEY",
          "valueFrom": "arn:aws:ssm:us-east-1:123456789:parameter/prod/myapp/stripe-key"
          // Parameter Store for less critical secrets (cheaper, no auto-rotation)
        }
      ]
    }
  ]
}

// HOW SECRETS ARE FETCHED:
//   At container startup (not at task definition time):
//   1. ECS task execution role calls secretsmanager:GetSecretValue
//   2. AWS returns the secret value
//   3. ECS injects it as an environment variable inside the container
//   4. process.env.DATABASE_PASSWORD is available to your Node.js app
//   5. Secret value is NEVER written to disk, NEVER in task definition JSON

// REQUIRED IAM PERMISSIONS on Task Execution Role:
//   secretsmanager:GetSecretValue
//   kms:Decrypt (if secret is encrypted with CMK, not default KMS key)
//   ssm:GetParameters (for Parameter Store)
//   ssm:GetParameter
```

---

## SECTION 4 — Request Flow (MANDATORY FLOWCHART)

```
COMPARISON:

┌────────────────────────────────┬────────────────────────────┬───────────────────────────────┐
│ Feature                        │ Secrets Manager            │ Parameter Store               │
├────────────────────────────────┼────────────────────────────┼───────────────────────────────┤
│ Cost                           │ $0.40/secret/month         │ Free (standard tier)          │
│                                │ + $0.05/10k API calls      │ $0.05/10k for advanced params │
├────────────────────────────────┼────────────────────────────┼───────────────────────────────┤
│ Auto-rotation                  │ ✅ Built-in (Lambda-based) │ ❌ Manual only                │
│ (RDS, Redshift, DocumentDB)    │                            │                               │
├────────────────────────────────┼────────────────────────────┼───────────────────────────────┤
│ Cross-account access           │ ✅ Via resource policy     │ Limited                       │
├────────────────────────────────┼────────────────────────────┼───────────────────────────────┤
│ Versioning                     │ ✅ Stages (AWSCURRENT,     │ Standard versions             │
│                                │ AWSPREVIOUS, custom)       │                               │
├────────────────────────────────┼────────────────────────────┼───────────────────────────────┤
│ Secret types                   │ JSON, plaintext, binary    │ String, StringList,           │
│                                │                            │ SecureString                  │
├────────────────────────────────┼────────────────────────────┼───────────────────────────────┤
│ Audit logging                  │ CloudTrail                 │ CloudTrail                    │
└────────────────────────────────┴────────────────────────────┴───────────────────────────────┘

DECISION GUIDE:
  Use Secrets Manager for:
    → Credentials that need auto-rotation (RDS passwords, API keys)
    → Complex JSON secrets (multiple fields in one secret object)
    → High-compliance environments (SOC2, HIPAA — auto-rotation matters)
    → Anything where you'd lose sleep if the secret wasn't rotated regularly

  Use Parameter Store for:
    → Non-sensitive config (Redis URL, feature flag values, S3 bucket names)
    → SecureString for secrets where auto-rotation isn't needed
    → Cost-sensitive environments with many configuration values
    → Hierarchical config: /prod/myapp/database/host, /prod/myapp/database/port

NAMING CONVENTION:
  Secrets Manager: prod/myapp/database, staging/myapp/database
  Parameter Store: /prod/myapp/database/host, /prod/myapp/database/port

  Use environment prefix: makes IAM policies easy (allow access to /prod/* only for prod tasks).

AUTO-ROTATION PATTERN (Secrets Manager + RDS):
  1. Enable auto-rotation in Secrets Manager (RDS native rotation lambda)
  2. Rotation period: e.g., every 30 days
  3. Secrets Manager creates a new password in RDS, updates secret
  4. ECS: new task launches → fetches new credential → uses rotated password ✅
  5. PROBLEM: currently-running tasks still have old password in env var
  6. SOLUTION: rolling restart after rotation:
       # EventBridge rule triggered by Secrets Manager rotation event
       # → Lambda → aws ecs update-service --force-new-deployment
       # Forces ECS to start new tasks (fetch new secret) and drain old ones
```

---

### Environment Variable Management in Code

```javascript
// ── COMMON PATTERN: validation at startup ────────────────────────────

const required = [
  'DATABASE_URL',
  'JWT_SECRET',
  'REDIS_URL',
];

const missing = required.filter(key => !process.env[key]);
if (missing.length > 0) {
  console.error(`Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);  // fail fast — better than failing later with cryptic errors
}

// ── CONFIG MODULE PATTERN ─────────────────────────────────────────────

// config.ts — centralizes all env var access
export const config = {
  port: parseInt(process.env.PORT ?? '8080', 10),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  isProduction: process.env.NODE_ENV === 'production',

  database: {
    url: process.env.DATABASE_URL!,         // ! asserts non-null (validated above)
    poolSize: parseInt(process.env.DB_POOL_SIZE ?? '10', 10),
  },

  redis: {
    url: process.env.REDIS_URL!,
  },

  jwt: {
    secret: process.env.JWT_SECRET!,
    expiresIn: process.env.JWT_EXPIRES_IN ?? '1h',
  },

  aws: {
    region: process.env.AWS_REGION ?? 'us-east-1',
    s3Bucket: process.env.S3_BUCKET!,
  },
};

// WHY CENTRAL CONFIG MODULE:
//   - Single place to add validation
//   - Typed (string | number, not always string)
//   - Defaults visible at a glance
//   - Search "config.database.url" finds every DB usage
//   - NOT: process.env.DATABASE_URL scattered across 40 files

// ── ZOD VALIDATION (popular alternative) ─────────────────────────────
import { z } from 'zod';

const envSchema = z.object({
  PORT:          z.string().transform(Number).default('8080'),
  NODE_ENV:      z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL:  z.string().url(),
  JWT_SECRET:    z.string().min(32),    // enforce minimum length for security
  REDIS_URL:     z.string().url(),
});

// Throws with descriptive error if any validation fails at startup:
const env = envSchema.parse(process.env);
// ZodError: [{"message":"Invalid url","path":["DATABASE_URL"]}]
```

---

### Local Dev Config Pattern (Without Secrets Manager)

```
.env                    ← local dev credentials (GITIGNORED, NEVER COMMITTED)
.env.example            ← template with no real values (committed to repo)
.env.test               ← test environment config (may be committed if no secrets)

.env contents (example):
  NODE_ENV=development
  PORT=8080
  DATABASE_URL=postgres://appuser:localpassword@localhost:5432/mydb_dev
  REDIS_URL=redis://localhost:6379
  JWT_SECRET=local-dev-jwt-secret-not-for-production-use
  LOG_LEVEL=debug

.env.example contents (committed to repo):
  NODE_ENV=development
  PORT=8080
  DATABASE_URL=        # postgres://user:password@localhost:5432/dbname
  REDIS_URL=           # redis://localhost:6379
  JWT_SECRET=          # generate: openssl rand -hex 32
  LOG_LEVEL=debug

LOADING .env IN NODE.JS (development only):
  import 'dotenv/config';                   // package: dotenv
  // OR:
  if (process.env.NODE_ENV !== 'production') {
    const { config } = await import('dotenv');
    config();
  }
  // In production (ECS): env vars injected by ECS — dotenv not needed

  IMPORTANT: Never call dotenv in production.
  In ECS, all env vars are already in process.env.
  dotenv in production: reads .env file → which doesn't exist → silently does nothing.
  But the dependency shows intent to use .env files → code smell for prod.

CONFIG DRIFT PREVENTION:
  Problem: .env.example falls out of sync with actual required config.
  Devs clone repo → missing env vars → cryptic startup errors.

  Fix: startup validation (see Section 5) — app fails fast with list of missing vars.
  Fix: script to validate .env against .env.example:
    # Check all keys in .env.example exist in .env:
    npx check-env-file
    # OR: custom script in package.json prestart hook
```

---

### Config Hierarchy & Cost Model

```
FULL CONFIG HIERARCHY (highest priority wins):

  1. Runtime: ECS secrets block         ← DB passwords, API keys, tokens
                                            (fetched from Secrets Manager at start)
  2. Runtime: ECS environment block     ← DB hosts, Redis URLs, log level
                                            (stored in task definition plaintext)
  3. Build: Dockerfile ENV defaults     ← PORT=8080, NODE_ENV=production
                                            (frozen in image, lowest priority runtime source)
  4. Code: Application defaults         ← pool size, retry count, timeout
                                            (hardcoded sensible defaults)

WHAT EACH LAYER COSTS:

  Secrets Manager:
    $0.40/secret/month × N secrets
    5 services × 3 secrets each = 15 secrets × $0.40 = $6/month
    + API calls: each ECS task launch = ~3 GetSecretValue calls
    1000 task launches/month × 3 calls = 3000 × $0.05/10k = $0.015/month
    Total Secrets Manager: ~$6/month for a small app

  Parameter Store (standard tier): FREE
    Good for: non-sensitive config values, feature flags, URLs

  THE HIDDEN COST: Secrets Manager rotation + ECS restart
    Scheduled rotation requires tasks to restart to pick up new credentials.
    Rolling restart = brief increase in task count (ECS runs new + old tasks simultaneously)
    Extra ECS Fargate cost during rotation: minutes × vCPU × $0.04048/vCPU/hour
    Typically: negligible ($0.01-$0.10 per rotation event)

OPERATIONAL COST (rotation without restart automation):
  Secret rotated → old tasks still running with old password.
  RDS rejects old password after N hours (rotation window).
  All in-flight requests start failing → incident → manual restart needed.
  PREVENTION: automate ECS restart on secret rotation (EventBridge + Lambda).
  Cost of incident: engineer hours >> $0.10 Lambda + EventBridge cost.
```
