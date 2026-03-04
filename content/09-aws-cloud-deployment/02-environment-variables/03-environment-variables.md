# Environment Variables

## FILE 03 OF 03 — AWS Services, Cost, Exam Traps, Scenario Exercise & Architect's Mental Model

> **Architect Training Mode** | Senior Principal Architect Perspective
> _Optimized for: design judgement · tradeoff evaluation · failure prediction · production debugging_

---

## SECTION 9 — Certification Focus (AWS SAA-C03)

### Four AWS Services for Configuration — When to Use Each

```
┌────────────────────────────────────────────────────────────────────────────────────────────┐
│               AWS CONFIGURATION STORAGE DECISION MATRIX                                    │
├────────────────────────┬──────────────┬────────────────────┬───────────────────────────────┤
│ Service                │ Best For     │ Encryption         │ Rotation / Versioning         │
├────────────────────────┼──────────────┼────────────────────┼───────────────────────────────┤
│ ECS environment block  │ Non-secret   │ None (plaintext    │ New task definition required  │
│ (task definition)      │ config only  │ in API response)   │                               │
├────────────────────────┼──────────────┼────────────────────┼───────────────────────────────┤
│ SSM Parameter Store    │ Non-secret   │ Optional           │ Version history, no rotation  │
│ (Standard tier)        │ config + refs│ (SecureString uses │ ($0 for standard params)      │
│                        │              │ KMS)               │                               │
├────────────────────────┼──────────────┼────────────────────┼───────────────────────────────┤
│ SSM Parameter Store    │ High-volume  │ Optional KMS       │ Version history               │
│ (Advanced tier)        │ parameter    │                    │ ($0.05/parameter/month)       │
│                        │ storage      │                    │                               │
├────────────────────────┼──────────────┼────────────────────┼───────────────────────────────┤
│ AWS Secrets Manager    │ Secrets that │ Always (KMS)       │ Automatic rotation built-in   │
│                        │ ROTATE       │                    │ ($0.40/secret/month)          │
│                        │              │                    │ + $0.05/10K API calls         │
├────────────────────────┼──────────────┼────────────────────┼───────────────────────────────┤
│ AWS AppConfig          │ Feature      │ Optional           │ Deployment strategies, safe   │
│                        │ flags, app   │                    │ deployments, rollback         │
│                        │ configuration│                    │ ($0 for AppConfig operations) │
└────────────────────────┴──────────────┴────────────────────┴───────────────────────────────┘
```

### Decision Tree: Which Service?

```
Is it a secret (password, API key, certificate private key)?
├── YES → Does it need AUTOMATIC ROTATION?
│         ├── YES → AWS Secrets Manager ($0.40/secret/month)
│         └── NO  → SSM Parameter Store SecureString (KMS encrypted, $0 standard tier)
│                   Manual rotation: update SSM value → deploy new containers
└── NO  → Is it a feature flag / gradual rollout / A/B config?
          ├── YES → AWS AppConfig (rollout strategies, monitoring integration)
          └── NO  → SSM Parameter Store Standard (plaintext or encrypted)
                    Or: ECS environment block (if value is non-sensitive)
```

---

## SECTION 10 — Comparison Table

### Real Cost Model for Config at Scale

```
Scenario: Production ECS service, 50 environment variables per service, 20 services

Option A: All in Secrets Manager (over-using)
  50 parameters × 20 services = 1,000 secrets
  Cost: 1,000 × $0.40 = $400/month just for storage
  Plus: API calls at cold start: 1,000 secrets × (say) 100 cold starts/day × 30 days = 3M calls
  API cost: (3,000,000 / 10,000) × $0.05 = $15/month
  Total: ~$415/month

Option B: SSM Parameter Store Standard (appropriate use)
  Non-secret config (40 per service): 40 × 20 = 800 params → $0/month (free tier: unlimited standard)
  Secrets (10 per service): 10 × 20 = 200 → Secrets Manager = 200 × $0.40 = $80/month
  Total: ~$80/month

Option C: ECS environment block (zero storage cost, zero secret protection)
  All 50 vars baked into task definitions
  Cost: $0 storage
  Risk cost: One exposed secret = incident response = 40 hrs × $150/hr = $6,000
  Total when breach occurs: $6,000+

Recommendation:
  Non-secret config (port numbers, log levels, feature flags, service URLs):
    → SSM Parameter Store Standard (free) or ECS environment block
  Secrets that don't rotate (third-party API keys you can manually update):
    → SSM Parameter Store SecureString (free)
  Secrets that need rotation (DB passwords, internal service tokens):
    → Secrets Manager ($0.40/secret/month — worth it for rotation)
```

---

## SECTION 11 — Quick Revision

### Environment Variables Are the Wrong Tool For:

```
1. LARGE CONFIGURATIONS (> a few KB each)

   Problem: Environment variables are limited:
     Linux: total env block = 128KB maximum (ARG_MAX varies by kernel)
             Individual variable: no hard kernel limit but shell tools have limits
     Windows: 32KB per variable, total environment limited

   If you have: extensive JSON config, certificate chain content, YAML configuration,
                binary data (base64 encoded certificates — hundreds of KB)

   Use instead: AWS AppConfig → stores and deploys large config files
                Application reads from AppConfig SDK, config served as file content
                Can be YAML, JSON, plaintext — no size limitation

2. FREQUENTLY CHANGING CONFIG (more than 1x per hour)

   Problem: Changing an env var requires container restart to take effect

   If you need: dynamic rate limit values, changing feature flag percentages,
                real-time config updates without deploying

   Use instead: AWS AppConfig with polling (app checks every 30 seconds)
                Application reads config from AppConfig SDK without restart
                Config changes propagate within polling interval

3. SHARED CONFIG ACROSS MULTIPLE SERVICES

   Problem: If 20 microservices all need DATABASE_REPLICA_HOST
             When it changes, you must update 20 ECS task definitions
             Risk of drift (some services updated, some not)

   Use instead: SSM Parameter Store with parameterized paths
                Each service reads /prod/shared/DATABASE_REPLICA_HOST at startup
                Update once in SSM → all services get new value on next restart

4. SECRETS WITH COMPLIANCE REQUIREMENTS (SOC2, PCI, HIPAA)

   Problem: Environment variables in ECS appear in:
     - CloudTrail describe-task API responses (for environment: block)
     - ECS console task details page
     - Container inspect output

   Compliance auditors expect: all secrets in approved secret stores,
                               access logged via CloudTrail,
                               rotation policies documented

   Use: Secrets Manager for secrets: access audited, rotation enforced, KMS key tracked

5. BINARY DATA OR VERY SENSITIVE PRIVATE KEYS

   Problem: Certificate private keys as env vars → visible in shell env output

   Use: AWS Certificate Manager (ACM) for TLS certs (reference ARN, not raw key)
         Secrets Manager for private keys (if you must manage them)
         AWS KMS for encryption operations (don't store keys, use KMS to encrypt)
```

---

## SECTION 12 — Architect Thinking Exercise

### Trap 1: SSM SecureString vs Secrets Manager — Exam Prefers Secrets Manager for Rotation

```
Exam question pattern:
  "Company needs to store RDS passwords and rotate them automatically every 30 days.
   Which service should they use?"

  All options:
  A) SSM Parameter Store Standard
  B) SSM Parameter Store SecureString
  C) AWS Secrets Manager
  D) KMS

  Trap: SSM SecureString is encrypted with KMS (sounds secure)
  But: SSM Parameter Store does NOT have built-in automatic rotation

  Correct: C — Secrets Manager has native RDS password rotation Lambda integration

  Watch for: "automatic rotation" → always Secrets Manager
             "encrypted" → both SSM SecureString AND Secrets Manager (not distinguishing)
```

### Trap 2: ECS Secrets Block vs Environment Block

```
Exam question pattern:
  "A developer stores RDS credentials in ECS task definition environment variables.
   Security audit flags this. What is the minimum change to improve security?"

  Correct: Move credentials to Secrets Manager, reference via 'secrets' block in task definition
               (not 'environment' block which stores plaintext)

  Wrong: "Use encrypted ECS environment variables" — there is no such thing
         ECS environment block = plaintext, always
```

### Trap 3: Cross-Region Secrets Manager

```
Exam question pattern:
  "Application deployed in us-east-1 and eu-west-1. Secrets Manager secret exists
   in us-east-1 only. eu-west-1 deployment fails to retrieve secret."

  Solution: Secrets Manager supports cross-region replication
    aws secretsmanager replicate-secret-to-regions \
      --secret-id prod/myapp/db-password \
      --add-replica-regions Region=eu-west-1

  Trap: candidates think they need to create a separate secret in eu-west-1
  Reality: Use Secrets Manager replication — one secret, available in multiple regions
```

### Trap 4: Lambda Environment Variable Size Limit

```
Lambda has a HARD limit: 4 KB total for all environment variables combined

Trap: "Store large configuration JSON in Lambda environment variable"
Reality: 4 KB limit = about one small JSON object

Solution for large Lambda config:
  - SSM Parameter Store (read at cold start)
  - AppConfig extension: Lambda layer that polls AppConfig
  - S3 object reference: env var holds S3 KEY, Lambda reads config from S3

Exam question: Lambda needs 20KB of configuration. Which service?
  Answer: SSM Parameter Store Advanced / S3 with reference / AppConfig
          NOT environment variables (over the 4 KB limit)
```

### Trap 5: dotenv in Production Lambda

```
Very common wrong answer on exam scenarios:
  "Developer uses dotenv library with .env file in Lambda deployment package"

  Problem: .env file in Lambda deployment ZIP = secrets in source code package
           Visible to anyone who downloads the Lambda deployment package
           Violates separation of config from code

  Correct: Lambda function environment variables (for < 4KB)
           SSM Parameter Store reads in handler (for larger config or secrets)
           Secrets Manager reads in handler (for rotating secrets)
```

---

### Scenario Design Exercise

### Scenario: Multi-Service Startup Managing Config for 5 Microservices

**Problem Statement:**

Your team is building an e-commerce platform with 5 microservices:

- `user-service` (Node.js, ECS)
- `product-service` (Python, ECS)
- `payment-service` (Java, ECS) — handles credit card processing (PCI scope)
- `notification-service` (Node.js, Lambda)
- `inventory-service` (Go, ECS)

Each service needs:

- Database URL (shared RDS cluster, different database per service)
- Service-specific API keys
- Shared config: Redis URL, internal service URLs, feature flags
- payment-service specifically: Stripe API key (must rotate every 30 days), PCI audit trail required

**Design the config management architecture. Consider: storage, security, rotation, cost.**

**Solution:**

```
SHARED NON-SECRET CONFIG (all 5 services)
  → SSM Parameter Store Standard (free)

  /prod/shared/REDIS_URL           = redis.cluster.cache.amazonaws.com:6379
  /prod/shared/USER_SERVICE_URL    = http://user-service.internal:3000
  /prod/shared/PRODUCT_SERVICE_URL = http://product-service.internal:3001
  ...

  Each service reads its needed shared params at startup
  Update once → all services get new value on next deploy

PER-SERVICE NON-SECRET CONFIG
  → ECS task definition environment block (zero cost, visible in console)

  user-service task def:
    environment:
      - name: PORT
        value: "3000"
      - name: NODE_ENV
        value: production
      - name: LOG_LEVEL
        value: info

PER-SERVICE DB PASSWORDS (no PCI scope except payment-service)
  → SSM Parameter Store SecureString with KMS (free, encrypted)

  /prod/user-service/DB_PASSWORD    → SecureString
  /prod/product-service/DB_PASSWORD → SecureString
  ...
  Rotation: manual process — update SSM value, restart containers every 90 days

PAYMENT SERVICE (PCI scope)
  → Secrets Manager (all secrets, automatic rotation, CloudTrail audit)

  prod/payment-service/stripe-api-key
    - Automatic rotation: 30-day Lambda rotation function
    - KMS encryption with dedicated CMK (separate from other services)
    - Resource policy: only payment-service ECS task role can GetSecretValue
    - CloudTrail: every GetSecretValue call logged for PCI audit trail

  prod/payment-service/db-password
    - Automatic rotation: Secrets Manager RDS rotation integration
    - Zero-downtime rotation using multi-user rotation

FEATURE FLAGS (all services)
  → AWS AppConfig

  Application: ecommerce
  Environment: production
  Config: feature-flags
    {
      "new_checkout_flow": { "enabled": true, "percentage": 25 },
      "recommendation_engine": { "enabled": false },
      "express_shipping": { "enabled": true, "percentage": 100 }
    }

  Services poll AppConfig every 30 seconds → config changes without restart

notification-service (Lambda)
  → Lambda environment variables:
      PORT, FUNCTIONAL (non-secrets, < 4KB)
  → Secrets Manager read at cold start:
      SendGrid API key (read once per cold start, cached in module scope)
```

**Cost Estimate:**

- SSM Standard: $0/month
- SSM SecureString (4 services × 3 secrets = 12 params): $0 standard tier
- Secrets Manager (payment-service, 3 secrets): 3 × $0.40 = $1.20/month
- AppConfig: $0 for operations
- **Total: ~$1.20/month for config management of 5 PCI-compliant microservices**

---

### Interview Q&A

**Q: "How should I handle database passwords in a dockerized application?"**

Good answer: "I'd store them in AWS Secrets Manager for rotating credentials, referenced via the ECS task definition's `secrets` block, not the `environment` block. That way the value is fetched from Secrets Manager at container start, never visible in `describe-tasks` API responses, and rotates automatically with zero code changes."

**Q: "What's the difference between SSM Parameter Store and Secrets Manager?"**

Good answer: "Both store encrypted secrets, but Secrets Manager adds automatic rotation via Lambda, cross-region replication, and native integrations for RDS, Redshift, and DocumentDB password rotation. SSM SecureString is cheaper — free at standard tier — but requires manual or custom rotation. Rule of thumb: use Secrets Manager for anything that must rotate automatically, SSM SecureString for static secrets."

**Q: "How do environment variables work across microservices? What if the same DB host changes?"**

Good answer: "I'd put shared config like the DB host in SSM Parameter Store under a `/prod/shared/` namespace. Each service reads from SSM at startup. When the value changes, a fresh container deployment picks it up. I don't hardcode service-specific URLs in task definitions — I use SSM paths that are constructed by Terraform using the environment variable, so `/prod/` vs `/staging/` is automatic and containers can't accidentally point to the wrong environment."

---

## === ARCHITECT'S MENTAL MODEL ===

### 5 Decision Rules for Environment Variables

1. **Never hardcode config that varies per environment.** If it changes between dev/staging/prod, it's config. Config belongs in SSM/Secrets Manager, not source code.

2. **Classify secrets before storing.** Non-secret config → SSM Standard (free) or ECS `environment` block. Static secrets → SSM SecureString. Rotating secrets → Secrets Manager. The difference is not about "being careful" — it's about rotation capability and audit trail.

3. **ECS `environment` block = visible.** Plaintext in ECS task definition appears in CloudTrail `describe-tasks`. If your SecOps team can see it, so can an attacker who compromises an admin IAM user. Use `secrets` block for anything sensitive.

4. **Validate at startup.** Check all required env vars exist before serving traffic. Fail fast with a clear error message. A container that exits on startup is caught by the health check; a container that serves 500s for the first 10 minutes is caught by your users.

5. **Make cross-environment contamination impossible by design.** SSM paths must include environment: `/prod/` vs `/staging/`. Generate paths from IaC variables. Log the actual values (non-secret ones) at startup so the first log line tells you exactly what environment this container is running against.

### 3 Common Mistakes

1. **Using Secrets Manager for everything.** It costs $0.40/secret/month. For 200 non-rotating config values across 20 microservices, that's $80/month versus $0 for SSM Standard. Use Secrets Manager when you need automatic rotation or PCI/SOC2 audit requirements.

2. **Relying on container restart for secret rotation.** Many teams set up Secrets Manager rotation but never test it. Result: secret rotates at 2 AM, containers fail, on-call engineer restarts service. Fix: design for rotation from day one — either graceful restart strategy, or application-layer secret refresh.

3. **Treating .env.example as safe.** Teams commit `.env.example` with fake values, then developers copy it and fill in real values. If a developer commits `.env` (forgetting .gitignore), the structure is already there. Protect with pre-commit hooks. Detect-secrets scans for patterns (high-entropy strings, AWS key patterns, common secret formats) regardless of filename.

### 1 Clear Interview Answer (30 Seconds)

> "For configuration management in AWS, I use a tiered approach: non-secret config like port numbers and log levels go in the ECS task definition's `environment` block or SSM Parameter Store at no cost. Static secrets go in SSM SecureString — encrypted at rest with KMS, free at the standard tier. Anything that needs automatic rotation — RDS passwords, internal service keys — goes in Secrets Manager, referenced via the ECS `secrets` block so they're injected at container start but never visible in API responses. The key rule is: validate all required vars at startup, fail fast if anything is missing, and make cross-environment contamination impossible by including the environment name in all SSM paths."

---

_End of Environment Variables 3-File Series_
