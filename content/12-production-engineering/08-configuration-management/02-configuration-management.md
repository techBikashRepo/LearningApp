# Configuration Management

## SECTION 5 — Real World Example

> **Architect Training Mode** | Site Reliability Engineer Perspective
> _Configuration drift causes more unexplained production behavior than bugs. The production environment "just works differently" — because someone changed a value six weeks ago and never told anyone._

---

### INCIDENT 01 — Wrong Configuration Deployed to Production

### Symptom

```
Friday 4:30 PM: Deployment of new feature to production.
                Deploys cleanly. No errors in deployment pipeline.

5:00 PM: Support tickets start coming in.
         Users say: "All emails are going to spam" and "I'm not receiving verification emails."

Engineering investigation:
  Application is running. No errors in logs.

5:45 PM: Support volume 15× normal. CTO escalates.

Root cause identified at 6:20 PM:
  SendGrid is rejecting emails. Response code: 200 but no delivery.
  SendGrid account shows: sandbox mode ENABLED.
```

### Root Cause

```
Deployment process:
  1. Developer updated .env.staging to enable sandbox mode for a test:
       SENDGRID_SANDBOX_MODE=true

  2. Deployment pipeline used "environment promotion" pattern:
       staging config → production config (copy env vars).

     The intent was to promote APP env vars (feature flags, versions).
     But it indiscriminately promoted ALL env vars including SENDGRID_SANDBOX_MODE.

  3. Production deployed with SENDGRID_SANDBOX_MODE=true.
     SendGrid accepted all API calls (200 OK) but delivered no emails.
     No error. No alert. Silent failure.

WHY WASN'T IT CAUGHT?
  Health check: /health only checked DB connection and Redis ping.
  SendGrid sandbox mode: API returns 202 Accepted (no errors).
  No alert on "email delivery rate dropped to 0."
  Monitoring gap: we tracked API errors, not business outcomes (emails delivered).
```

### Fix

```
IMMEDIATE:
  1. Set SENDGRID_SANDBOX_MODE=false in ECS task environment.
  2. Force redeploy: aws ecs update-service --force-new-deployment
  3. Verify email delivery (manual test: send test email, check delivery).
  4. Recovery: 12 minutes after fix deployed.

PROCESS FIX:
  1. Never promote config between environments — config should be EXPLICIT per environment.
     Each environment has its own complete config, maintained independently.
     Staging config and production config are not related by default.

  2. Dangerous config values get explicit validation:
       if (process.env.SENDGRID_SANDBOX_MODE === 'true' && APP_ENV === 'production') {
         throw new Error('FATAL: SENDGRID_SANDBOX_MODE is enabled in production. Refusing to start.');
       }
     Application crashes at startup with this config. Deployment never completes.
     The bad config is caught before any user is affected.

  3. Business metric alerting: "email delivery rate" metric.
     CloudWatch alarm: if emails sent vs. emails delivered diverges → alert.
     Catches silent failures that don't appear as errors.

  4. Config audit step in deployment pipeline:
     Before deploying: diff the config between what's running and what will be deployed.
     Print the diff. Require manual approval if SENDGRID_SANDBOX_MODE is in the diff.
```

---

### INCIDENT 02 — Configuration Drift Between Environments

### Symptom

```
Staging: new payment flow tested for 2 weeks. All tests pass. Stakeholders sign off.
Production deployment: immediate regressions.
  - Payment timeout errors (not seen in staging)
  - Currency formatting mismatch (staging showing $, production showing USD)
  - New checkout feature "not working" (working in staging)

Time spent debugging over 3 hours before identifying root cause.
```

### Root Cause

```
A series of individual manual changes had made staging and production drift:

  STAGING                                    PRODUCTION
  API_TIMEOUT_MS=30000                       API_TIMEOUT_MS=5000 (changed 2 months ago, forgotten)
  CURRENCY_FORMAT=symbol                     CURRENCY_FORMAT=code (changed for compliance test)
  FEATURE_NEW_CHECKOUT=true                  FEATURE_NEW_CHECKOUT=false (never enabled in prod)
  MAX_RETRIES=3                              MAX_RETRIES=1 (emergency change during outage, forgotten)

Each individual change made sense when it was made.
But they accumulated over months. Nobody maintained a "current state" view.
The environments had diverged significantly. Testing in staging was testing a different system.

FUNDAMENTAL PROBLEM: Config changes had no audit trail, no review, no reconciliation.
```

### Fix

```
THE FIX: Infrastructure as Code for all configuration.

All SSM parameters managed in Terraform:
  resource "aws_ssm_parameter" "api_timeout" {
    for_each = toset(["development", "staging", "production"])

    name  = "/myapp/${each.key}/app/api_timeout_ms"
    type  = "String"
    value = each.key == "production" ? "5000" : "30000"
    # Explicit per-environment values, version-controlled, reviewable in PRs.
  }

BENEFITS:
  1. All config in git. Any drift: terraform plan shows it.
  2. Config changes require code review (PR process — same rigor as application code).
  3. terraform plan in CI shows what will change before it changes.
  4. terraform output exports config values that can be compared between envs.
  5. Rollback: git revert + terraform apply. Config state is always known.

RECONCILIATION PROCESS (for the transition from manual to IaC):
  1. Export current state: aws ssm get-parameters-by-path → JSON export for each environment.
  2. Diff the exports: compare staging vs. production parameters.
  3. Identify every difference. For each: document the reason or align the values.
  4. Codify in Terraform. After that: all changes via PR.
```

---

### INCIDENT 03 — Hardcoded Configuration Causes Surprise Production Failure

### Symptom

```
Application running fine for 8 months.
New developer joins team. Makes a code change to the upload handler.
Deploys to staging: works perfectly. Files up to 50MB upload fine.
Deploys to production: immediately — users can't upload anything above 5MB.
500 errors on upload attempts.
```

### Root Cause

```
Original developer (8 months ago):
  Had a discussion: "what should our upload limit be?"
  Decision: 50MB for users.
  Implemented:
    // upload.ts:
    const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;  // 50MB

  Then later:
    // Had forgotten about the constant. Changed the ECS env var for some reason.
    // process.env.MAX_UPLOAD_MB existed but wasn't used.

  Two sources of truth: the hardcoded constant and the env var.

New developer found the env var in the ECS task definition: MAX_UPLOAD_MB=5
Changed it to 50 in staging for a test. Forgot it. Reverted production env var to original.
But the real limit was always the hardcoded constant — env var wasn't wired up.

For 8 months: two different values existed. By coincidence, no behavior difference.
New developer's change accidentally connected the env var to the behavior,
but also accidentally introduced the 5MB limit from the production env var that had never mattered.
```

### Fix

```
APPLICATION SIDE: Single source of truth.
  The env var IS the configuration. The code reads the env var. Always.
  No hardcoded defaults that shadow configuration:

  // upload.ts — CORRECT:
  const maxFileSizeBytes = parseInt(process.env.MAX_UPLOAD_MB ?? '50', 10) * 1024 * 1024;

  If configuration is incorrect: application fails at startup validation (Zod schema).
  The behavior is always what the config says. No surprises.

  ALSO: document the env var in code via the Zod schema and a comment.
  The schema is the authoritative list of what configuration the application reads.

INFRASTRUCTURE SIDE: align the env var values across environments.
  SSM Parameter Store:
    /myapp/production/app/max_upload_mb = 50     (align with intent)
    /myapp/staging/app/max_upload_mb = 50

  Remove the conflicting ECS env var (now managed via SSM).
```

---

### INCIDENT 04 — Feature Flag Left Enabled After Rollback

### Symptom

```
New "experimental search" feature deployed with feature flag FEATURE_EXPERIMENTAL_SEARCH=true.
Feature had a bug: returning incorrect results for certain query types.
Immediate rollback of the code deployed within 10 minutes.
All engineers: "We rolled back. We're safe."

Next day: users still reporting wrong search results.
Engineering: "That's impossible — we rolled back the code."

Still happening 3 days after the "rollback."
```

### Root Cause

```
"Rollback" reverted the code deployment (ECS tasks running previous Docker image).
But: FEATURE_EXPERIMENTAL_SEARCH=true was set in SSM Parameter Store.
The previous version of the code also had the feature flag logic (it was added 2 weeks ago).
The previous image checks: if (isEnabled('experimental_search')) → uses experimental path.
Flag still enabled → experimental path still active → same bug still present.

The code rollback was correct but incomplete.
A feature flag enable is a separate action from a code deploy.
Rolling back the deploy does NOT automatically roll back the flag state.
```

### Fix

```
IMMEDIATE: Disable the flag.
  aws ssm put-parameter \
    --name "/myapp/production/features/experimental_search" \
    --value "false" \
    --overwrite

  Behavior fixed within 60 seconds (next flag poll cycle).
  No redeploy needed.

PROCESS FIX:
  1. When disabling a feature flag is part of rollback: make it explicit in runbook.
     ROLLBACK CHECKLIST:
       [ ] Revert ECS service to previous task definition
       [✓] Disable feature flag: FEATURE_EXPERIMENTAL_SEARCH=false   ← ADD THIS
       [ ] Verify health checks pass on previous version
       [ ] Confirm error rate returns to baseline

  2. Flag lifecycle documentation:
       Flag created: date, owner, purpose.
       Flag enabled: date, deployment it accompanied.
       Flag disabled: date, reason.
       Flag removed: date (when code paths fully cleaned up).

     Flags that outlive their purpose accumulate. Aim to remove a flag within
     1–2 weeks after full production rollout. Dead code is a maintenance burden.

  3. Alert on flags enabled for > 30 days with no change: time to roll out 100% or remove.
```

---

## DEBUGGING TOOLKIT

### Compare Config Between Environments

```bash
# Fetch all parameters for production and staging, compare:
aws ssm get-parameters-by-path \
  --path "/myapp/production/" \
  --recursive --with-decryption \
  --query 'Parameters[*].{Name:Name, Value:Value}' \
  --output json > prod_config.json

aws ssm get-parameters-by-path \
  --path "/myapp/staging/" \
  --recursive --with-decryption \
  --query 'Parameters[*].{Name:Name, Value:Value}' \
  --output json > staging_config.json

# Diff the JSON files to spot discrepancies:
diff <(cat prod_config.json | python3 -c "import json,sys; [print(f\"{x['Name'].split('/')[-1]}={x['Value']}\") for x in sorted(json.load(sys.stdin), key=lambda x:x['Name'])]") \
     <(cat staging_config.json | python3 -c "import json,sys; [print(f\"{x['Name'].split('/')[-1]}={x['Value']}\") for x in sorted(json.load(sys.stdin), key=lambda x:x['Name'])]")
```

### Check Who Changed a Config Value and When

```bash
# CloudTrail: find who changed a specific SSM parameter:
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=ResourceName,AttributeValue="/myapp/production/app/log_level" \
  --query 'Events[].{Time: EventTime, Who: Username, What: EventName}' \
  --output table

# List all SSM write operations in the last 24h:
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=EventName,AttributeValue=PutParameter \
  --start-time $(date -u -d "24 hours ago" +%FT%TZ) \
  --query 'Events[].{Time: EventTime, Who: Username, Param: CloudTrailEvent}' \
  --output json | jq '.[] | {time: .Time, who: .Who}'
```

### Check What Config ECS Tasks Are Currently Using

```bash
# Describe running task to see its environment variables:
TASK_ARN=$(aws ecs list-tasks --cluster prod --service-name api --query 'taskArns[0]' --output text)

aws ecs describe-tasks \
  --cluster prod \
  --tasks $TASK_ARN \
  --query 'tasks[0].containers[0].environment' \
  --output table

# Check task definition for secrets references (Secrets Manager injections):
aws ecs describe-task-definition \
  --task-definition api-production \
  --query 'taskDefinition.containerDefinitions[0].secrets' \
  --output table

# Verify a specific SSM parameter current value:
aws ssm get-parameter \
  --name "/myapp/production/app/log_level" \
  --with-decryption \
  --query 'Parameter.{Value:Value, LastModified:LastModifiedDate, Version:Version}'
```

### Validate Application Config at Startup (Local Test)

```bash
# Simulate production config locally to verify validation:
APP_ENV=production \
DB_HOST=test.example.com \
DB_NAME=myapp_prod \
DB_PASSWORD=testpass \
node -e "
const { loadEnvConfig } = require('./dist/env');
try {
  const config = loadEnvConfig();
  console.log('Config valid:', Object.keys(config).length, 'values loaded');
} catch(err) {
  console.error('Config validation failed:', err.message);
  process.exit(1);
}
"
# Use this as a pre-deploy smoke test: if config is invalid, fail before deployment.
```

## SECTION 6 — System Design Importance

The incident patterns above highlight key system design principles: design for failure, implement graceful degradation, enforce security boundaries at every layer, and monitor proactively. Each incident represents a production scenario that should inform your system design decisions.

## SECTION 7 — AWS & Cloud Mapping

AWS services directly relevant to these patterns: **ECS/Fargate** for container orchestration and task lifecycle management; **ECR** for secure image storage and scanning; **Secrets Manager / SSM Parameter Store** for runtime secret injection; **CloudWatch** for container metrics, logs, and alarms; **IAM** for fine-grained access control.

## SECTION 8 — Interview Preparation

**Beginner:**

**Q: What is configuration management and why is it important at scale?**
**A:** Configuration management is the practice of controlling and tracking all configuration (non-secret) settings for your application: database pool sizes, feature flags, timeouts, log levels, service endpoints. At small scale (1-2 services), environment variables in a .env file are fine. At scale (20+ services, 3 environments): you need to track what config each service has in each environment, ensure changes are reviewed, prevent config drift (services having different values than intended), and update config without requiring a code deployment. Configuration management provides the discipline and tooling to do this reliably.

**Q: What is a feature flag and when should you use one?**
**A:** A feature flag (or feature toggle) is a configuration value that enables or disables a feature at runtime without code deployment. CHECKOUT_V2_ENABLED=true/false. Uses: (1) *Gradual rollout:* enable for 5% of users, watch metrics, then increase. (2) *A/B testing:* 50% see version A, 50% see version B. (3) *Kill switch:* instantly disable a problematic feature without rolling back code ("turn off the recommendation engine in production â€” it's causing high latency"). (4) *Decouple deploy from release:* code is deployed (merged, running in production) but feature is off â€” turn it on when business is ready.

**Q: What is AWS AppConfig and how is it different from SSM Parameter Store for configuration?**
**A:** SSM Parameter Store: simple key-value store, no built-in change control or deployment mechanisms. Good for static config. AWS AppConfig: adds validation, gradual deployment (rollout config to 10% of hosts, watch CloudWatch metrics for errors, then continue/rollback), and change history on top of configuration storage. Use AppConfig when: configuration changes are high-risk and need gradual rollout (e.g., feature flags, performance tuning). Use SSM Parameter Store when: config rarely changes and doesn't need gradual deployment.

---

**Intermediate:**

**Q: What is GitOps for configuration management and what are its benefits?**
**A:** GitOps treats configuration as code: all configuration lives in a Git repository. To change config: create a PR, review, merge. The system automatically applies the change. Benefits: (1) *Audit trail:* Git history shows who changed what, when, and why. (2) *Review process:* required PR reviews prevent unreviewed config changes. (3) *Rollback:* git revert rolls back config. (4) *Consistency:* all environments defined declaratively â€” no undocumented manual changes. (5) *Disaster recovery:* can recreate entire configuration from Git. Tools: Terraform for infrastructure config, Helm values for Kubernetes config, AWS CDK for AWS resources as code. Anti-pattern: manual changes in AWS console with no record.

**Q: What is configuration drift and how does infrastructure-as-code prevent it?**
**A:** Config drift is when the actual running configuration of a system diverges from what's documented or intended. Common cause: manual changes ("I'll just change this one setting in the AWS console really quickly, I'll document it later" â€” they never document it). Six months later, no one knows why the production ECS task has MAX_CONNECTIONS=50 when the config file says 20. Someone changes it back to 20 and breaks production. IaC prevents drift: all config defined in Terraform/CDK. Applying Terraform detects and corrects any manual deviations. Regular 	erraform plan in CI shows if production has drifted from the codebase.

**Q: How do you handle configuration for multiple environments (dev, staging, prod) without duplicating files?**
**A:** Pattern 1 â€” *Override files:* base config in config/default.json, overrides in config/production.json. Library (node-config) merges them. Shared values in base, environment-specific overrides only where they differ. Pattern 2 â€” *Environment-specific variables:* SSM Parameter Store with /app/{env}/config-key paths. Same code reads from the path for its environment. Pattern 3 â€” *Helm/Kustomize:* for Kubernetes, base YAML with environment overlays. Rule: don't repeat unchanged values â€” only specify differences from default. Changes to shared values (like timeout settings) should apply to all environments unless explicitly overridden.

---

**Advanced (System Design):**

**Scenario 1:** You need to update a configuration value (RATE_LIMIT=100 â†’ RATE_LIMIT=500) across 15 ECS services in production. Some services need to be updated first (API gateway), others last (worker services). A bad value could cause traffic to spike and overload downstream services. Design the update process.

*AppConfig with gradual deployment:*
(1) Update config value in AppConfig (or SSM Parameter Store via Terraform PR â†’ merge â†’ apply).
(2) For AppConfig: configure a deployment strategy â€” linear 10% increment every 2 minutes with CloudWatch monitoring.
(3) Deploy to non-customer-facing services first (workers, background jobs). Monitor 5 minutes.
(4) Deploy to API gateway (highest risk â€” directly customer-facing). Use linear gradual deployment: 10% of ECS tasks get new config â†’ CloudWatch monitors error rate + latency â†’ if metrics healthy, continue to 100% over 20 minutes.
(5) Automatic rollback trigger: if error rate increases by > 1% during gradual deployment â†’ AppConfig automatically rolls back to previous value.

**Scenario 2:** A production incident is traced to a configuration value (TIMEOUT_MS=5000) that was changed manually in the AWS console two weeks ago by a developer who has since left the company. The value should be 30000. How do you prevent this from ever happening again?

*Prevention â€” Zero-tolerance for manual config changes:*

(1) *Service Control Policy (SCP) at AWS Organization level:* deny ssm:PutParameter and ppconfig:* directly; require all changes through a CI/CD pipeline that has these permissions via an assumed role.

(2) *Terraform state management:* all SSM parameters managed by Terraform. 	erraform plan run nightly in CI â€” any drift (manual console changes) detected and alerted.

(3) *Config change audit:* CloudTrail alarm: alert on PutParameter or UpdateApplication API calls made by human IAM users (not CI/CD role). Immediate Slack notification: "Manual config change detected by [username] in production."

(4) *Offboarding process:* when engineer leaves, audit their CloudTrail activity for the past 30 days for config changes â€” verify all are documented.

(5) *Immutable config per deployment:* each deployment captures config state in the task definition revision. If config changes without deployment, the scheduled 	erraform plan detects and alerts.

