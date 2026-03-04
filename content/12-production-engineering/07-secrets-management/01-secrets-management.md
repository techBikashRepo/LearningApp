# Secrets Management

## FILE 01 OF 03 — Core Concepts, AWS Tools & Production Patterns

> **Architect Training Mode** | Site Reliability Engineer Perspective
> _A secret is only as secure as its weakest exposure point. Your app code, git history, logs, and environment variables are all potential exposure points. Secrets Manager closes each one._

---

## SECTION 1 — Intuition (Explain Like a 12-Year-Old)

```
A SECRET is any value that grants access to a protected resource:
  Database passwords
  API keys (Stripe, SendGrid, Twilio)
  JWT signing keys (HMAC secret or RSA private key)
  OAuth client secrets
  Encryption keys
  Third-party service credentials

THE PROBLEM WITH "SIMPLE" APPROACHES:

  Hardcoded in source code:
    const DB_PASSWORD = "mysupersecretpassword";
    → In git history FOREVER, even after deletion. Anyone with repo access = has password.
    → If repo is public (even accidentally for 1 second): password is compromised.

  In .env file committed to git:
    DB_PASSWORD=mysupersecretpassword
    → Same problem as hardcoding, just one file removed.

  In environment variables (set at deployment time):
    export DB_PASSWORD=mysupersecretpassword
    → Visible in process list (ps aux on the host shows env vars).
    → Visible in CloudWatch Logs if logged by accident.
    → Visible in ECS task definition JSON in AWS Console if stored there.
    → No rotation mechanism. Same password forever.
    → When do you rotate? Manual. Risky. Usually "never."

  THE CORE PROBLEMS:
    1. Secrets live in places humans shouldn't see them (git, logs, consoles).
    2. No rotation (compromised secret stays active until manually changed).
    3. No audit trail (who accessed this secret? when?).
    4. No centralized management (secret is scattered across all deploy scripts).
```

---

## SECTION 2 — Core Technical Explanation

```
AWS SECRETS MANAGER:
  Purpose: Built specifically for secrets. Has additional features.

  Core features:
    Automatic rotation: define a Lambda rotation function. Rotate every N days.
                        New secret value generated. Old value still works briefly (grace period).
                        App reads new value on next read (no restart needed if fetched fresh).
    Versioning: keeps AWSCURRENT and AWSPREVIOUS. Both work during rotation.
    Cross-account access: can share secrets across AWS accounts (enterprise use).
    Native integrations: RDS, Redshift, DocumentDB have built-in rotation support.
    CloudTrail logging: every GetSecretValue call logged with IAM principal, timestamp, IP.

  Cost: $0.40/secret/month + $0.05 per 10,000 API calls.

  Best for: Database passwords, API keys — anything that should rotate regularly.

AWS SSM PARAMETER STORE:
  Purpose: Configuration AND secrets. More general-purpose.

  Core features:
    Standard tier: free. Up to 10,000 parameters. No rotation built-in.
    Advanced tier: $0.05/parameter/month. Larger values. Policies.
    Types: String, StringList, SecureString (encrypted with KMS).
    Hierarchy: /myapp/production/db/password (path-based organization).
    Reference from other AWS services: ECS task definition can reference parameter directly.

  Cost: Free for standard SecureString. Advanced tier has costs.

  Best for: Configuration values that change between environments (not on a rotation schedule).
            Feature flags, non-sensitive config, per-environment URLs.

DECISION GUIDE:
  Use Secrets Manager when:
    [ ] Value needs automatic rotation (DB passwords, API keys)
    [ ] High compliance requirement (HIPAA, PCI DSS)
    [ ] Cross-account secret sharing
    [ ] Managed RDS password rotation (zero-effort)

  Use SSM Parameter Store when:
    [ ] Configuration that varies by environment (not a secret)
    [ ] Simple encrypted value that doesn't need rotation
    [ ] Large number of parameters (cost: free vs. $0.40/parameter/month)
    [ ] Already using SSM for other automation (consistent tooling)
```

---

## SECTION 3 — Architecture Diagram (MANDATORY)

### Pattern A: ECS Task Fetches Secret at Startup

```typescript
// secrets.ts — load secrets once at application startup

import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

const client = new SecretsManagerClient({
  region: process.env.AWS_REGION ?? "us-east-1",
});

interface AppSecrets {
  DB_PASSWORD: string;
  STRIPE_SECRET_KEY: string;
  JWT_SECRET: string;
}

let secretsCache: AppSecrets | null = null;

export async function loadSecrets(): Promise<AppSecrets> {
  if (secretsCache) return secretsCache; // Use cache after first load

  const command = new GetSecretValueCommand({
    SecretId: `myapp/${process.env.APP_ENV}/secrets`, // e.g., myapp/production/secrets
  });

  const response = await client.send(command);

  if (!response.SecretString) {
    throw new Error("Secret value is empty or binary — expected JSON string");
  }

  const parsed = JSON.parse(response.SecretString) as AppSecrets;

  // Validate required keys are present:
  const required: (keyof AppSecrets)[] = [
    "DB_PASSWORD",
    "STRIPE_SECRET_KEY",
    "JWT_SECRET",
  ];
  for (const key of required) {
    if (!parsed[key]) throw new Error(`Missing required secret: ${key}`);
  }

  secretsCache = parsed;
  logger.info({
    event: "secrets_loaded",
    secretId: `myapp/${process.env.APP_ENV}/secrets`,
  });
  return secretsCache;
}

// server.ts — startup sequence:
async function start() {
  const secrets = await loadSecrets(); // Fetch once. Fail fast if unavailable.

  const pool = new Pool({
    password: secrets.DB_PASSWORD,
    // other config...
  });

  // Start server only after secrets are available:
  await app.listen({ port: 3000 });
}
```

### Pattern B: ECS Task Definition Referencing Secrets Manager

```json
// task-definition.tf (Terraform) — inject secret as environment variable via ECS:
{
  "containerDefinitions": [
    {
      "name": "api",
      "image": "...",
      "secrets": [
        {
          "name": "DB_PASSWORD",
          "valueFrom": "arn:aws:secretsmanager:us-east-1:123456789:secret:myapp/production/db-password-AbCdEf"
        },
        {
          "name": "STRIPE_KEY",
          "valueFrom": "arn:aws:secretsmanager:us-east-1:123456789:secret:myapp/production/stripe-key-XyZwVu"
        }
      ]
      // Note: ECS resolves the secret at task LAUNCH time.
      // Value is injected as environment variable, not fetched from code.
      // Pro: simple. Con: no automatic pickup of rotated secrets (requires redeploy).
    }
  ]
}
```

### Pattern C: Secret Rotation with No Downtime

```
HOW SECRETS MANAGER ROTATION WORKS:
  1. Rotation trigger (time-based or manual): Secrets Manager calls your rotation Lambda.
  2. Lambda creates a new secret value (e.g., generates new DB password, sets it in RDS).
  3. Lambda stores new value as AWSPENDING in Secrets Manager.
  4. Lambda tests the new secret works (optional but recommended).
  5. Lambda promotes AWSPENDING to AWSCURRENT. Old value becomes AWSPREVIOUS.

  OVERLAP PERIOD: Both AWSCURRENT and AWSPREVIOUS are valid simultaneously.
  This means: running ECS tasks using old password continue to work.

  Your application code — to take advantage of rotation:
    Don't cache secrets forever. Refresh on some interval or on auth failure:

    async function connectToDb(): Promise<Pool> {
      try {
        return new Pool({ password: (await getSecret()).DB_PASSWORD });
      } catch (err) {
        if (isAuthError(err)) {
          secretsCache = null;           // Invalidate cache
          const fresh = await loadSecrets();  // Re-fetch from Secrets Manager
          return new Pool({ password: fresh.DB_PASSWORD });
        }
        throw err;
      }
    }

MANAGED RDS ROTATION (Zero effort):
  In Terraform:
    resource "aws_secretsmanager_secret_rotation" "db_rotation" {
      secret_id           = aws_secretsmanager_secret.db.id
      rotation_lambda_arn = aws_lambda_function.rotation.arn
      rotation_rules {
        automatically_after_days = 30
      }
    }
  AWS provides the Lambda rotation function for RDS — you don't write it.
  Enable it, point it at your RDS, and rotation is fully automated every 30 days.
```

---

## SECTION 4 — Request Flow (MANDATORY FLOWCHART)

```
LEAST-PRIVILEGE PATTERN:
  Each ECS task has a Task Execution Role. That role's policy ONLY grants access
  to the specific secrets that task needs. Nothing else.

# Terraform — ECS task role policy:
resource "aws_iam_role_policy" "ecs_secrets" {
  role = aws_iam_role.ecs_task_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = ["secretsmanager:GetSecretValue"]
        Resource = [
          "arn:aws:secretsmanager:us-east-1:${data.aws_caller_identity.current.account_id}:secret:myapp/production/*"
          # Only production secrets, not staging or other apps
        ]
      },
      {
        Effect = "Allow"
        Action = ["kms:Decrypt"]
        Resource = [aws_kms_key.secrets.arn]
        # Required to decrypt secrets encrypted with a customer-managed KMS key
      }
    ]
  })
}

WHAT THIS PREVENTS:
  A developer machine compromised → attacker can't access production secrets via AWS CLI
    (their IAM user doesn't have secretsmanager:GetSecretValue for prod).
  A staging ECS task compromised → can't access production secrets
    (staging task role only allows staging/* secret paths).
```

---

### Production Readiness Checklist

```
STORAGE
  [ ] No secrets in source code or .env files committed to git
  [ ] All secrets stored in Secrets Manager or SSM Parameter Store SecureString
  [ ] Secrets organized by environment path: /myapp/{env}/secrets
  [ ] Separate secrets per environment (dev/staging/prod use different values)

ACCESS CONTROL
  [ ] Each service has its own IAM role with access ONLY to its required secrets
  [ ] No wildcard Resource: "*" in secretsmanager IAM policies
  [ ] CloudTrail logging enabled (audit: who accessed which secret)
  [ ] No human IAM users with production secret access by default (just-in-time access)

ROTATION
  [ ] Database passwords in Secrets Manager with automated rotation (30/90 days)
  [ ] Rotation Lambda tested: manual rotation tested before enabling automatic
  [ ] App handles re-fetch on auth failure (picks up rotated credentials)
  [ ] RDS rotation uses AWS-provided Lambda (no custom code needed)

LEAK PREVENTION
  [ ] Logger does not log request headers (Authorization header = credential)
  [ ] Logger does not log full request body in production (may contain passwords)
  [ ] Error stack traces do not include database connection strings
  [ ] ECS task definition JSON not publicly accessible (resource policy)
  [ ] git-secrets or similar pre-commit hook to prevent accidental commit
```
