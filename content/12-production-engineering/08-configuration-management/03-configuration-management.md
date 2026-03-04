# Configuration Management


> **Architect Training Mode** | Site Reliability Engineer Perspective
> _The best configuration management is invisible: the application behaves exactly as specified, every change is traceable, and no engineer has to guess what value is running in production._

---

## SECTION 9 — Certification Focus (AWS SAA-C03)

### Decision 1 — Where to Store Application Configuration?

```
OPTION A: Environment Variables in ECS Task Definition

  Hardcode values directly in the task definition JSON.

  Pros:
    Simple. Visible in task definition in AWS Console.
    No extra service dependencies.

  Cons:
    Config changes require a new task definition revision (redeploy).
    No version history for config values (task def versions track deployment,
    not just config changes).
    Can't change without triggering a full deployment.
    Mixing infrastructure (task size, networking) with application config.

  WHEN: Very simple apps. Values that change infrequently. Starter setups.
        Not recommended for production at scale.

OPTION B: SSM Parameter Store (fetched at startup)

  App reads from SSM at startup via GetParametersByPath.

  Pros:
    Values can be updated without a redeployment (restart ECS tasks to pick up changes).
    Versioned. CloudTrail audit. IAM access control.
    Path hierarchy keeps config organized by environment.
    Terraform manages parameters as code.

  Cons:
    Extra IAM setup (task role needs SSM:GetParametersByPath).
    One extra API call at startup (minor).
    Without live polling: changes still need task restart.

  WHEN: Production applications. When config changes more than once a month.
        When you need audit history for config changes.
        **Recommended default for all non-trivial applications.**

OPTION C: AWS AppConfig

  More powerful config management: schema validation, deployment strategies, rollback.

  Pros:
    Canary deployments for config changes (gradually roll out config to % of instances).
    Schema validation: define JSON schema, AppConfig validates before deploying.
    Rollback: if error rate spikes after config change, automatic rollback.
    Works for both structured config and feature flags.

  Cons:
    More complex setup.
    Cost: $0.0008 per hosted config retrieved.
    Extra SDK integration.

  WHEN: Config changes are high-risk (payment amounts, rate limits, security settings).
        You need gradual config rollouts with automatic rollback.
        Organization using AppConfig for feature flag management already.

THE PRAGMATIC CHOICE:
  ECS environment variables → SSM Parameter Store → AppConfig (in increasing complexity order).
  Start with SSM Parameter Store for production. Add AppConfig for highest-risk config values.
```

### Decision 2 — Fail-Fast Validation vs. Defaults for Missing Config?

```
OPTION A: Strict fail-fast (recommended)

  If a required configuration value is missing or invalid: crash at startup with a clear error.

  Code:
    if (!process.env.DB_HOST) {
      throw new Error('FATAL: DB_HOST is required but not set.');
    }
    const port = parseInt(process.env.PORT ?? '', 10);
    if (isNaN(port)) {
      throw new Error(`FATAL: PORT must be a number, got: "${process.env.PORT}"`);
    }

  Pros:
    Broken config fails BEFORE serving traffic — no user impact.
    Error message is actionable: "DB_HOST is required."
    ECS deployment circuit breaker catches this: task starts → fails → rollback.
    Deployment fails rather than bad config silently running.

  Cons:
    Startup fails on dev machine if config not set up (minor — just add the config).

OPTION B: Permissive defaults

  if (!process.env.DB_HOST) {
    process.env.DB_HOST = 'localhost';  // Well-intentioned default
  }

  NEVER do this for production-critical values.

  Problem: if DB_HOST is not set in production → app silently connects to localhost.
  localhost has no database. App appears to run (process started) but crashes on first DB call.
  The crash is opaque: "ECONNREFUSED localhost:5432" is much harder to debug than
  "FATAL: DB_HOST is required."

  Defaults are appropriate for: optional tuning parameters (LOG_LEVEL=info default),
  limits that have sensible defaults (MAX_UPLOAD_MB=50 default).
  Never for connection strings, hosts, or credentials.
```

### Decision 3 — How to Manage Config Changes in Production Without Downtime?

```
SCENARIO: You want to change MAX_CONNECTIONS_PER_POOL from 10 to 20 in production.
           Without taking the service down.

APPROACH 1: Update SSM → restart tasks (rolling deployment)
  1. Update SSM: aws ssm put-parameter --name "/myapp/production/db/pool_max" --value "20"
  2. Force rolling replacement: aws ecs update-service --force-new-deployment
  3. ECS replaces one task at a time. Old tasks continue serving traffic. New tasks pick up new config.

  Downtime: zero (if minHealthyPercent ≥ 50%).
  Time: 2–5 minutes for rolling replacement.
  Risk: none for this change. Higher risk for changes like "switch to new DB host."

APPROACH 2: Live reload (SSM polling)
  App polls SSM every 60 seconds. When param changes: immediately picks it up.

  Pros: no restart at all — fastest possible config change.
  Cons: not all config can be changed live (DB pool max requires pool recreation, not just reading);
        config reload code is more complex.

  WHEN: Feature flags. Log levels. Non-structural settings.

APPROACH 3: AppConfig with gradual rollout (highest safety)
  1. Create new config version with changed value.
  2. Deploy to 10% of instances. Monitor error rate and latency.
  3. If stable: continue rollout. If error rate rises: automatic rollback.

  WHEN: Config changes that could affect behavior (request timeouts, cache sizes, rate limits).

RULE: For config changes that can be safely reloaded: SSM + polling.
      For structural config that requires restart: SSM + force-new-deployment.
      For high-risk config: AppConfig with canary rollout.
```

---

## SECTION 10 — Comparison Table

**Trap 1 — "12-Factor says store config in env vars, so never use config files"**

```
NUANCED: 12-Factor says "store config in the environment" because config shouldn't be in
source code. Environment variables are one way to represent the environment's config.
SSM Parameter Store IS the environment's configuration — the app reads it at startup and
uses it to configure itself. The principle is satisfied.

Config files committed to git (application.yml, config.json with environment-specific values)
violate 12-Factor if they contain per-deployment values because you can't open-source the code.
Config files that are purely structural (defining schema) are fine.
```

**Trap 2 — "Just add a sensible default so the app always starts"**

```
WRONG for required infrastructure values. "Sensible default" in dev (localhost:5432) is
NOT sensible in production. Defaults mask missing configuration.

CORRECT approach: fail fast with a clear error. Let the deployment fail.
ECS deployment circuit breaker prevents the broken task from becoming the live version.
The engineer has a clear error: exactly which env var is missing, instead of a mysterious
runtime failure hours later when the first user triggers a DB call.
```

**Trap 3 — "Config changes are low-risk, just update directly in console"**

```
WRONG: Direct console changes:
  Are not tracked in git (no audit trail if you revert infrastructure changes via IaC).
  Create drift between what Terraform knows and what actually exists.
  Can't be code-reviewed before being applied.
  Can't be tested in staging first.
  Can be applied to the wrong environment (staging vs. production console confusion).

CORRECT: All config changes via terraform apply or aws ssm put-parameter via
         an automated pipeline that requires PR approval for production.
```

**Trap 4 — "Feature flags are just environment variables"**

```
PARTIALLY TRUE: A feature flag can be an env var or SSM param.
But there's a critical difference: env var changes require a redeploy to take effect.

The VALUE of a feature flag is that it can be changed WITHOUT a deploy.
If changing the flag requires a redeploy, you've removed the key benefit.

Use SSM with live polling for feature flags that need instant enable/disable capability.
The flag architecture (polling + live read) is what makes it a real feature flag,
not just "a parameter that controls behavior."
```

**Trap 5 — "Staging config values should be close to production values"**

```
NUANCE: Some values should match production (rate limits, timeout values) for accurate testing.
Some values should explicitly differ (sandbox mode, external URLs pointing to test accounts,
lower resource limits to reduce cost).

The key principle: staging must be EXPLICIT about these differences.
Not "staging uses whatever was last in production" but "staging config is defined
independently and intentionally mirrors or intentionally differs from production."

Configuration drift happens when staging values change and those changes aren't
mirrored to production (or vice versa). IaC with explicit environment values prevents this.
```

---

## SECTION 11 — Quick Revision

**Q1: "How do you manage configuration across dev/staging/production environments?"**

```
I organize configuration in SSM Parameter Store using a path hierarchy:
/myapp/{environment}/category/parameter_name.

Each environment has its own complete set of parameters — they're not inherited
or promoted from each other. The values may be identical for some parameters
(like max file upload size) and explicitly different for others
(log level: debug in staging, info in production; or service URLs pointing to different endpoints).

All SSM parameters are managed in Terraform. Changes go through pull requests —
same review process as code. The diff in the PR shows exactly what config changes.

The application reads all config at startup via GetParametersByPath, validates it
with a Zod schema, and crashes with a clear error if anything is missing or invalid.
Config failures are caught by ECS deployment circuit breaker before going live.

For feature flags that need immediate changes without redeploy, I poll SSM every 60 seconds.
```

**Q2: "What's the difference between a feature flag and a configuration value?"**

```
Same underlying mechanism — a named value that changes application behavior.
The difference is semantics and update frequency.

A configuration value is a stable setting: DB pool size, max upload limit, log level.
Changes infrequently. Usually requires a restart to take effect. Has one "correct" value
for a given environment.

A feature flag is temporary and its primary purpose is controlling whether a feature
is active, independent of the code deployment. It's designed to be changed quickly,
often without a redeploy — to enable a feature, disable it, or roll out gradually.

Feature flags have a lifecycle: created, enabled in staging, enabled gradually in production,
then removed from code entirely once the feature is fully rolled out.
Leaving flags in the code indefinitely is a code smell — they accumulate and make
code harder to read.
```

**Q3: "An engineer accidentally changed a production config value and broke the service. How do you prevent and detect this?"**

```
Prevention:
  All config changes via automated pipeline with PR approval, not direct console access.
  Dangerous config values (sandbox mode, external API endpoints) validated at startup —
  application refuses to start if a "test mode" flag is enabled in production.

Detection:
  CloudTrail logs all SSM PutParameter calls: who, when, what parameter.
  Set up a CloudWatch alert on SSM PutParameter events for production parameters
  — operational change triggers a notification (not necessarily an alarm, but visibility).

  Terraform plan in CI: any manual change creates drift between Terraform state and
  actual SSM values. Next terraform plan detects the drift.

Recovery:
  SSM Parameter Store keeps version history. To revert:
    aws ssm get-parameter-history --name "/myapp/production/app/log_level"
    # Lists all previous versions with timestamps.
    aws ssm put-parameter \
      --name "/myapp/production/app/log_level" \
      --value "info" \
      --overwrite

  For config loaded at startup: restart tasks to pick up the reverted value.
```

---

## SECTION 12 — Architect Thinking Exercise

### The 5 Rules of Configuration That Stays Sane

```
RULE 1: One source of truth per config value.
  Either the code has the value, or the environment has it. Never both.
  Two conflicting values is a bug waiting to happen — you never know which wins.
  The environment (SSM/env var) ALWAYS wins. Code reads from environment, never overrides it.

RULE 2: Config changes must be code-reviewable.
  Store config in IaC (Terraform or SSM with IaC management).
  A config change is a change to the running system — it deserves the same scrutiny as code.
  Incidents caused by "I just quickly updated that in the console" are common.

RULE 3: Bad config must fail loudly at startup, before serving traffic.
  The worst outcome: bad config is applied, app starts, and fails on the first request.
  The best outcome: bad config is applied, app fails to start, deployment rolls back automatically.
  Startup validation + ECS deployment circuit breaker achieves this.

RULE 4: Each environment's config is explicit and independently maintained.
  Staging and production have different config files, not a shared file with overrides.
  "Inheriting from" or "promoting" config between environments causes drift.

RULE 5: Feature flags have a lifecycle. Remove them after rollout.
  Flag created → enable in staging → gradual production rollout → 100% → remove from code.
  The removal step is always forgotten. Schedule it.
  A codebase with 40 stale feature flags is a codebase nobody understands.
```

### The 3 Mistakes Every Team Makes

```
MISTAKE 1: Promoting config from staging to production.
  Reasoning: "Staging config got tested, so it must be right."
  Result: SENDGRID_SANDBOX_MODE=true in production. Silent failures.
  Always define production config independently and explicitly.

MISTAKE 2: No startup validation, only runtime validation.
  Bad port number fails when first connection is attempted.
  Wrong DB host fails when first query runs.
  Missing JWT secret fails when first authenticated request comes in.
  None of these are caught at startup. Hours of mystery debugging.
  Validate all config at startup. Fail before serving a single request.

MISTAKE 3: Feature flags that were never removed.
  3 years old. Nobody knows what they do. Remove them and something breaks.
  Don't remove them: codebase complexity grows endlessly.
  Flag lifecycle must be explicitly managed, not just "when we get around to it."
```

### 30-Second Answer: "How do you manage configuration in production?"

```
"I organize configuration in SSM Parameter Store using an environment-based path hierarchy:
/myapp/{env}/category/name.

Each environment's config is explicitly defined in Terraform — changes go through
pull requests rather than direct console edits.

The application loads all config at startup via GetParametersByPath, validates it
against a Zod schema, and fails fast if anything is missing or invalid.
This means bad config prevents the deployment from completing rather than causing
runtime failures after users are already affected.

Feature flags use SSM with 60-second polling so they can be changed without a redeploy.
For the most sensitive config values — rate limits, external service URLs, anything
where a wrong value causes an outage — I'd use AppConfig with a canary rollout,
which validates the change against error rate metrics and rolls back automatically."
```
