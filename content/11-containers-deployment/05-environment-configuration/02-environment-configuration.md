# Environment Configuration

## SECTION 5 — Real World Example

> **Architect Training Mode** | Platform Engineer / DevOps Architect Perspective
> _Real failures. Real commands. Real fixes. Because incidents don't come with documentation._

---

### INCIDENT 01 — .env Committed to Git → Secret Leak

```
SYMPTOM:
  GitHub automated secret scanning email: "AWS access key found in commit a3b7f9."
  OR: Developer notices .env in git log and panics at 4pm on a Friday.
  Team doesn't know when it was committed. Could be weeks of exposure.
  .env contained:
    AWS_ACCESS_KEY_ID=AKIA...
    DATABASE_PASSWORD=prod-db-password-123
    STRIPE_SECRET_KEY=sk_live_...

ROOT CAUSE:
  Developer created .env during setup.
  Project's .gitignore had "*.env" instead of ".env" — subtle typo.
  OR: .gitignore used ".env.*" but missed ".env" itself.
  git add . → .env included.
  git push → secret on GitHub (public OR private repo — both compromised).

IMPACT TIMELINE:
  GitHub secret scanning detects it in minutes → notifies you.
  GitHub Secret Scanning with Partner Programs → notifies AWS/Stripe immediately.
  But any forks, clones, or CI systems that had access may have cached it already.
  Manual analysis: assume exfiltrated immediately on push.

IMMEDIATE RESPONSE (do in this order — every minute matters):
  1. ROTATE ALL EXPOSED CREDENTIALS NOW
     aws iam create-access-key --user-name myapp-user          # new key
     aws iam delete-access-key --access-key-id AKIA... --user-name myapp-user  # old key
     # Same for Stripe, database password, JWT secret, etc.
     # DO THIS BEFORE cleaning git history

  2. Clean git history:
     # Install: pip install git-filter-repo
     git filter-repo --path .env --invert-paths
     git push --force --all
     # Force everyone to re-clone (history changed)

  3. Add .env to .gitignore (correctly):
     echo ".env" >> .gitignore
     echo ".env.*" >> .gitignore
     echo "!.env.example" >> .gitignore   # allow .env.example

  4. Post-mortem: check AWS CloudTrail for any API calls with the compromised key
     aws cloudtrail lookup-events --lookup-attributes \
       AttributeKey=AccessKeyId,AttributeValue=AKIA...
     Any unexpected calls → treat as confirmed breach → security incident

PREVENTION:
  # Pre-commit hook — prevents .env from ever being staged:
  # .git/hooks/pre-commit (chmod +x):
  if git diff --cached --name-only | grep -qE "^\.env(\..*)?$"; then
    echo "COMMIT BLOCKED: .env file detected in staged changes"
    exit 1
  fi

  # Automated: pre-commit framework with detect-secrets:
  repos:
    - repo: https://github.com/Yelp/detect-secrets
      rev: v1.4.0
      hooks:
        - id: detect-secrets
          args: ['--baseline', '.secrets.baseline']

  # CI gate: scan every PR for secrets:
  - uses: gitleaks/gitleaks-action@v2   # GitHub Action
```

---

### INCIDENT 02 — Secret Baked Into Docker Image → Permanent Credential in ECR

```
SYMPTOM:
  Trivy scan in CI flags CRITICAL finding: "secret detected in image layer."
  OR: Application works in local Docker but security team files a report.
  Dockerfile had:
    ENV DATABASE_PASSWORD=prod-password
    OR: RUN echo "API_KEY=sk_live_..." > /app/.env (then later RUN rm /app/.env)
  Image has been pushed to ECR. Multiple versions contain the secret.

ROOT CAUSE (see also Dockerfile File 02):
  Dockerfile layers are immutable. `RUN rm secret.txt` creates a new layer masking the
  file, but the original layer (with the secret) still exists in the image manifest.
  docker save myimage | tar xf - → each layer's tarball still contains the secret.

FIX — Immediate response:
  1. Rotate the exposed credential immediately
  2. Identify all affected image versions in ECR:
     aws ecr list-images --repository-name myapp
  3. Delete all affected images:
     aws ecr batch-delete-image --repository-name myapp \
       --image-ids '[{"imageTag":"1.0.0"},{"imageTag":"1.0.1"}]'
  4. Fix the Dockerfile (below)
  5. Rebuild + push clean images

FIX — Stop using ENV for secrets:
  WRONG:
    ENV DATABASE_PASSWORD=mypassword   ← visible in docker inspect + docker history

  CORRECT:
    # Don't set secrets in image at all.
    # At runtime, ECS injects them via secrets: block in task definition.
    # process.env.DATABASE_PASSWORD is available without it being in the image.

    # Validate at startup (but don't bake the value):
    if (!process.env.DATABASE_PASSWORD) {
      console.error('DATABASE_PASSWORD not set');
      process.exit(1);
    }

FIX — Secrets needed at BUILD time (npm private registry, etc.):
  # Use BuildKit --mount=type=secret (never written to any layer):
  # syntax=docker/dockerfile:1
  RUN --mount=type=secret,id=npm_token \
    NPM_TOKEN=$(cat /run/secrets/npm_token) \
    npm config set //registry.npmjs.org/:_authToken=$NPM_TOKEN \
    && npm ci \
    && npm config delete //registry.npmjs.org/:_authToken

  # Build command:
  DOCKER_BUILDKIT=1 docker build --secret id=npm_token,src=$HOME/.npmrc .
  # Secret is NOT in docker history. Not in any layer. Completely ephemeral.

VERIFY NO SECRETS IN IMAGE:
  trivy image --scanners secret myapp:latest
  docker history myapp:latest --no-trunc | grep -i password
  docker inspect myapp:latest | jq '.[0].Config.Env'  # check ENV values
```

---

### INCIDENT 03 — Secrets Manager Rotation Without ECS Task Restart → Stale Credentials → 500 Errors

```
SYMPTOM:
  At 3am: 500 errors spike on all API endpoints that touch the database.
  CloudWatch: "password authentication failed for user appuser"
  RDS is up. Network is fine. Nothing deployed recently.
  Resolves when engineer manually: aws ecs update-service --force-new-deployment

ROOT CAUSE:
  Secrets Manager auto-rotation was configured for the RDS password: every 30 days.
  Rotation ran at 2:30am.
  New password set in RDS. Secrets Manager updated to AWSCURRENT version.

  But ECS tasks: they fetched the secret at TASK STARTUP and stored it in process.env.
  process.env is set once at container start. It does NOT re-read Secrets Manager at runtime.

  Old tasks: still running with old password (now invalid in RDS).
  New task launches: would get the new password — but no new tasks launched.
  All currently-running tasks: using rotated (invalidated) password → all DB calls fail.

FIX — Automate ECS rolling restart after rotation:
  Architecture:
    Secrets Manager rotation event → EventBridge → Lambda → force-new-deployment

  Lambda function:
    import boto3
    def handler(event, context):
        ecs = boto3.client('ecs')
        ecs.update_service(
            cluster='prod',
            service='myapp-api',
            forceNewDeployment=True
        )

  EventBridge rule:
    {
      "source": ["aws.secretsmanager"],
      "detail-type": ["AWS API Call via CloudTrail"],
      "detail": {
        "eventSource": ["secretsmanager.amazonaws.com"],
        "eventName": ["RotateSecret"],
        "requestParameters": {
          "secretId": ["arn:aws:secretsmanager:us-east-1:123:secret:prod/myapp/db-password"]
        }
      }
    }

  Timeline with fix:
    2:30am: rotation completes → EventBridge fires → Lambda triggers rolling restart
    2:35am: new ECS tasks start with new password → old tasks drain
    2:40am: all tasks running with new credential → zero downtime

FIX — Application-level secret refresh (alternative for high-change scenarios):
  Instead of env var: call Secrets Manager on each DB connection pool creation.
  const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

  async function getDbPassword() {
    const client = new SecretsManagerClient({ region: 'us-east-1' });
    const response = await client.send(new GetSecretValueCommand({
      SecretId: 'prod/myapp/db-password'
    }));
    return response.SecretString;
  }

  // Cache for 5 minutes to avoid API call on every query
  // But refresh before connection pool recreates

  DOWNSIDE: More complex code, SDK dependency, IAM permissions in task role (not just execution role).
  USE WHEN: secrets rotate very frequently or rotation is unpredictable.

MONITORING:
  CloudWatch alarm: RDS failed connections > 10 in 1 minute → SNS alert
  This alarm should fire BEFORE users notice in most cases.
```

---

### INCIDENT 04 — Wrong IAM Role for Secret Access → ECS Task Fails to Start

```
SYMPTOM:
  After adding a new secret to the ECS task definition's secrets: block,
  all new task ATTEMPTS fail immediately with:
    "CannotPullContainerError: Error response from daemon:
     pull access denied for ... (or) ResourceInitializationError:
     unable to retrieve secret from Secrets Manager: AccessDeniedException"

  Service shows desired=2, running=0. All tasks in STOPPED state. App is down.

ROOT CAUSE (common confusion — two different IAM roles):
  ECS has TWO separate IAM roles:

  TASK EXECUTION ROLE (arn:aws:iam::123:role/ecsTaskExecutionRole):
    Used BY ECS AGENT (not your app code) to:
    - Pull images from ECR
    - Fetch secrets from Secrets Manager/Parameter Store at startup
    - Write logs to CloudWatch
    WHO NEEDS THIS: ECS infrastructure layer

  TASK ROLE (arn:aws:iam::123:role/myapp-task-role):
    Used BY YOUR APPLICATION CODE inside the container to:
    - Call S3, DynamoDB, SQS from application code
    - Call Secrets Manager from application code (if fetching at runtime)
    WHO NEEDS THIS: your Node.js/Python/Java app

  THE TRAP: New secret added to task definition secrets: block.
  The EXECUTION ROLE doesn't have secretsmanager:GetSecretValue for the new secret ARN.
  ECS can't fetch it at startup → task fails before container even starts.

FIX — Add permission to Task Execution Role:
  # Inline policy on ecsTaskExecutionRole:
  {
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Action": [
        "secretsmanager:GetSecretValue",
        "kms:Decrypt"                     # required if secret uses customer-managed KMS key
      ],
      "Resource": [
        "arn:aws:secretsmanager:us-east-1:123456789:secret:prod/myapp/*"
      ]
    }]
  }

  # For Parameter Store SecureString:
  {
    "Effect": "Allow",
    "Action": ["ssm:GetParameters", "ssm:GetParameter"],
    "Resource": "arn:aws:ssm:us-east-1:123456789:parameter/prod/myapp/*"
  }

VERIFY BEFORE DEPLOY:
  # Simulate what ECS execution role can do:
  aws secretsmanager get-secret-value \
    --secret-id prod/myapp/db-password \
    --profile assumeRole-ecsTaskExecutionRole
  # If AccessDeniedException: you have the same problem ECS will have

DIAGNOSIS COMMANDS:
  # Check why task stopped:
  aws ecs describe-tasks --cluster prod --tasks <task-arn> \
    --query 'tasks[0].stoppedReason'

  # Check task definition's execution role:
  aws ecs describe-task-definition --task-definition myapp \
    --query 'taskDefinition.executionRoleArn'

  # Check what policies the execution role has:
  aws iam list-attached-role-policies --role-name ecsTaskExecutionRole
  aws iam list-role-policies --role-name ecsTaskExecutionRole   # inline policies
```

---

### INCIDENT 05 — Config Drift Between Environments (Dev .env ≠ Production)

```
SYMPTOM:
  Feature works perfectly in staging.
  After production deploy: feature broken with undefined behavior.
  Developer logs show: "FEATURE_FLAG_NEW_CHECKOUT undefined — defaulting to false"
  In staging: FEATURE_FLAG_NEW_CHECKOUT=true was set weeks ago.
  Nobody added it to the production ECS task definition.

ROOT CAUSE:
  Config managed inconsistently:
    - Developer adds to .env.local + tells staging manually
    - staging ECS task definition updated ad-hoc via console click
    - Production task definition: managed by Terraform / CloudFormation (lagging)

  No single source of truth. No audit trail of what config is in each environment.
  New environment variable needed → must remember to add in 4 different places.

FIX — Infrastructure as Code for task definitions (Terraform):
  # All environments defined in one place. Diff visible in PRs.

  variable "environment" { default = "prod" }

  resource "aws_ecs_task_definition" "myapp" {
    container_definitions = jsonencode([{
      name  = "api"
      image = "123456789.dkr.ecr.us-east-1.amazonaws.com/myapp:${var.image_tag}"

      environment = [
        { name = "NODE_ENV",                    value = var.environment },
        { name = "FEATURE_FLAG_NEW_CHECKOUT",   value = var.feature_flag_new_checkout },
        # Adding a new env var → PR → reviewed → applied to all envs
      ]
      secrets = [
        { name = "DATABASE_PASSWORD", valueFrom = aws_secretsmanager_secret.db_pass.arn }
      ]
    }])
  }

FIX — Startup validation (catch missing vars at deploy, not in prod traffic):
  // Required env var list — fails fast at startup:
  const REQUIRED_VARS = [
    'DATABASE_URL', 'REDIS_URL', 'JWT_SECRET', 'FEATURE_FLAG_NEW_CHECKOUT'
  ];
  const missing = REQUIRED_VARS.filter(v => !process.env[v]);
  if (missing.length) {
    console.error('STARTUP FAILED — missing env vars:', missing);
    process.exit(1);
  }

  If a new var is required → task fails to start in staging → caught before production.
  Not: silently undefined → wrong behavior in production.

FIX — Environment parity checks in CI:
  # Script: compare env vars in staging task def vs production task def
  # Alert if: prod is missing any var that staging has
  aws ecs describe-task-definition --task-definition myapp-staging \
    --query 'taskDefinition.containerDefinitions[0].environment[*].name' > staging_envs.json
  aws ecs describe-task-definition --task-definition myapp-prod \
    --query 'taskDefinition.containerDefinitions[0].environment[*].name' > prod_envs.json
  diff staging_envs.json prod_envs.json   # any differences = potential config drift
```

---

### Debugging Toolkit

```bash
# ──────────────────────────────────────────────────────────────────────
# INSPECT ECS TASK CONFIG
# ──────────────────────────────────────────────────────────────────────

# See all environment vars in active task definition:
aws ecs describe-task-definition --task-definition myapp \
  --query 'taskDefinition.containerDefinitions[0].environment'

# See all secrets in task definition (shows names + ARNs, not values):
aws ecs describe-task-definition --task-definition myapp \
  --query 'taskDefinition.containerDefinitions[0].secrets'

# Check running task environment (requires ECS Exec enabled):
aws ecs execute-command \
  --cluster prod \
  --task <task-arn> \
  --container api \
  --command "/bin/sh -c 'env | sort'" \
  --interactive

# ──────────────────────────────────────────────────────────────────────
# SECRETS MANAGER
# ──────────────────────────────────────────────────────────────────────

# Get secret value (test that the secret exists + execution role can read it):
aws secretsmanager get-secret-value \
  --secret-id prod/myapp/db-password

# List all secrets:
aws secretsmanager list-secrets

# Check rotation status:
aws secretsmanager describe-secret \
  --secret-id prod/myapp/db-password \
  --query '{rotation: RotationEnabled, schedule: RotationRules}'

# ──────────────────────────────────────────────────────────────────────
# IAM ROLE DEBUGGING
# ──────────────────────────────────────────────────────────────────────

# Verify execution role has required permissions:
aws iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::123456789:role/ecsTaskExecutionRole \
  --action-names secretsmanager:GetSecretValue \
  --resource-arns arn:aws:secretsmanager:us-east-1:123:secret:prod/myapp/db-password \
  --query 'EvaluationResults[0].EvalDecision'
# allowed → ok | implicitDeny / explicitDeny → missing permission

# ──────────────────────────────────────────────────────────────────────
# LOCAL DEBUGGING
# ──────────────────────────────────────────────────────────────────────

# Verify .env loaded correctly:
node -e "require('dotenv/config'); console.log(process.env.DATABASE_URL)"

# Check for secrets in environment (sanity check — log structure, not values):
node -e "
  const keys = Object.keys(process.env).filter(k =>
    /secret|password|token|key/i.test(k)
  );
  console.log('Sensitive env keys found:', keys);
"

# Validate .env vs .env.example (find missing vars):
# Using dotenv-cli:
npx dotenv -e .env -- node -e "
  const required = Object.keys(require('dotenv').config({path: '.env.example'}).parsed);
  const missing = required.filter(k => !process.env[k]);
  console.log('Missing from .env:', missing);
"
```

## SECTION 6 — System Design Importance

The incident patterns above highlight key system design principles: design for failure, implement graceful degradation, enforce security boundaries at every layer, and monitor proactively. Each incident represents a production scenario that should inform your system design decisions.

## SECTION 7 — AWS & Cloud Mapping

AWS services directly relevant to these patterns: **ECS/Fargate** for container orchestration and task lifecycle management; **ECR** for secure image storage and scanning; **Secrets Manager / SSM Parameter Store** for runtime secret injection; **CloudWatch** for container metrics, logs, and alarms; **IAM** for fine-grained access control.

## SECTION 8 — Interview Preparation

**Beginner:**

**Q: What is the twelve-factor app principle for configuration, and how do containers support it?**
**A:** The Twelve-Factor App (a methodology for building SaaS apps) says: "Store config in the environment." Everything that varies between deployments (dev/staging/prod) â€” database URLs, API keys, feature flags â€” should come from environment variables, not code files. Containers are perfectly suited for this: you build one image, then inject different env vars at runtime for each environment. Same Docker image runs as the dev environment (pointing to local database) or production (pointing to production database). Code doesn't change â€” only environment changes.

**Q: What is the difference between passing environment variables at container startup vs baking them into the image?**
**A:** *Baked into image:* ENV NODE_ENV=production in Dockerfile â€” the value is in the image layer forever, visible in docker inspect and docker history. Fine for non-sensitive defaults. *Passed at startup:* docker run -e DATABASE_URL=postgres://... or ECS task definition environment â€” value is injected when the container starts, not stored in the image. Required for: secrets (passwords, API keys), values that differ per environment (dev/staging/prod), values that may change between deployments without rebuilding.

**Q: How do you access environment variables in a Node.js application?**
**A:** process.env.VARIABLE_NAME. Examples: const dbUrl = process.env.DATABASE_URL;. Use dotenv package in development to load from .env file: equire('dotenv').config() at the very start of your application. In production (ECS), environment variables are injected by ECS from the task definition â€” no .env file needed. Best practice: validate all required variables at startup and throw a clear error if any are missing, rather than failing cryptically later.

---

**Intermediate:**

**Q: How does AWS ECS securely inject secrets from Secrets Manager into container environment variables?**
**A:** In the ECS task definition, instead of specifying a plain-text value, you specify a Secrets Manager ARN and optional JSON key:
`json
{
  "name": "DATABASE_PASSWORD",
  "valueFrom": "arn:aws:secretsmanager:us-east-1:123:secret:prod/db-password:password::"
}
`
When ECS starts the task: it calls Secrets Manager, retrieves the value, injects it as an environment variable. The ECS task role must have secretsmanager:GetSecretValue permission. The secret value is NEVER stored in the task definition, never in CloudTrail task events, and rotates automatically if Secrets Manager rotation is configured. Containers see it as a normal env var with no Secrets Manager calls at runtime.

**Q: What is the risk of environment variable injection order in a multi-container ECS task?**
**A:** In an ECS task with multiple containers (a sidecar pattern â€” e.g., app + log forwarder), each container has its own environment variables. They are NOT shared between containers (unless you use a shared volume or a localhost network). A common mistake: assuming container B can read container A's env vars. It cannot. Each container needs its own copy of shared configuration. Also: container startup order with dependsOn in ECS ensures container A is healthy before B starts, but this doesn't share env vars between them.

**Q: What happens if a container's required environment variable is an empty string vs not set at all?**
**A:** They are different states and can cause subtle bugs. process.env.DATABASE_URL === undefined â€” not set at all (ECS task definition doesn't include this env var). process.env.DATABASE_URL === "" â€” set but empty (ECS task has DATABASE_URL: ""). Many developers check if (!process.env.DATABASE_URL) â€” this treats both undefined AND empty string as missing (correct). But if (process.env.DATABASE_URL === undefined) misses the empty string case. Best validation: if (!process.env.DATABASE_URL?.trim()) throw new Error('DATABASE_URL required') â€” handles undefined, empty, and whitespace-only values.

---

**Advanced (System Design):**

**Scenario 1:** Design a configuration management system for 20 ECS services across 3 environments (dev, staging, prod). Requirements: (1) Developers can view non-sensitive config. (2) Only CI/CD (not humans) can update production secrets. (3) Changes to any variable must go through code review. (4) Rotating a secret must not require redeployment.

*Architecture:*
- Non-sensitive config: AWS AppConfig or SSM Parameter Store Standard (plaintext), paths under /app/{env}/{service}/. Managed as Terraform â€” PR required for changes, review enforced.
- Secrets: Secrets Manager, paths /{env}/{service}/{secret}. Rotation configured (30-day automatic rotation).
- IAM: Developers have ssm:GetParameter for dev/staging paths, read access in AWS console. No access to prod. CI/CD assumes an IAM role with scoped permissions.
- Redeployment-free rotation: ECS secrets injection from Secrets Manager with external changes: configure app to refresh secrets periodically (restart tasks on rotation event via Lambda â†’ ECS update-service --force-new-deployment) OR use AWS SDKs to fetch secrets at runtime (cache with 5-min TTL in process memory).

**Scenario 2:** A production ECS task is throwing "Cannot connect to database" errors. The connection string in Secrets Manager looks correct when you view it in the AWS Console. List the 5 most likely configuration issues in the ECS task definition that could cause this, and how you'd verify each.

*5 possibilities:*
(1) Wrong ARN in alueFrom â€” pointing to wrong secret or wrong region: ws ecs describe-task-definition --task-definition myapp:latest and inspect the secrets section ARN.
(2) Secret JSON key mismatch â€” secret stores {"DB_URL": "..."} but task uses :url:: not :DB_URL::: verify JSON keys match the valueFrom suffix.
(3) ECS task role missing secretsmanager:GetSecretValue permission â€” task can't fetch the secret: ws iam simulate-principal-policy --policy-source-arn {task-role-arn} --action-names secretsmanager:GetSecretValue.
(4) Secret is in a VPC-isolated Secrets Manager endpoint â€” task in private subnet with no Secrets Manager VPC endpoint: check VPC endpoints in the subnet's route to Secrets Manager.
(5) The secret was recently rotated but ECS is still running old task definition revisions on some instances â€” docker exec into a currently running task: env | grep DATABASE to see the actual injected value vs what Secrets Manager currently has.

