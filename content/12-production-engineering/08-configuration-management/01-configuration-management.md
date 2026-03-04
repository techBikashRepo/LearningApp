# Configuration Management

## FILE 01 OF 03 — Core Concepts, 12-Factor App, SSM Hierarchy & Feature Flags

> **Architect Training Mode** | Site Reliability Engineer Perspective
> _Configuration is the variable that makes your code behave differently in different environments without changing the code itself. Mismanaged configuration is how "works in staging" becomes "broken in production."_

---

## SECTION 1 — Intuition (Explain Like a 12-Year-Old)

```
CONFIGURATION vs SECRETS:
  Configuration: values that change application behavior between environments.
                 Non-sensitive (or low-sensitivity). Safe to commit to a config file.
                 Examples: LOG_LEVEL, MAX_CONNECTIONS, FEATURE_FLAGS, API_BASE_URL

  Secrets: values that grant access to protected resources. NEVER commit.
           Examples: DB_PASSWORD, STRIPE_SECRET_KEY, JWT_SECRET

  In practice: the boundary isn't always clean.
    DATABASE_URL = postgresql://host/db → not a secret (just a URL)
    DATABASE_URL = postgresql://user:password@host/db → secret embedded → treat as secret

  Storage rule:
    Secrets → AWS Secrets Manager
    Configuration → Environment variables / SSM Parameter Store / config files

THE 12-FACTOR APP PRINCIPLES (relevant subset):
  Factor III: Config — Store config in the environment.
    "An app's config is everything that is likely to vary between deployments (dev/staging/prod).
    The test: can the app's source code be open-sourced right now without compromising credentials?"

    What should be in environment variables:
      Database hosts and names (not passwords)
      External service base URLs (different for each environment)
      Port numbers
      Log levels
      Feature flag values

    What should NOT be in source code:
      Any value that changes between environments (or between users/deployments)

THE PROBLEM THIS SOLVES:
  Without configuration management:
    A developer changes LOG_LEVEL=debug in production to diagnose an issue.
    Forgets to change it back. Production is now logging 100x more data.
    CloudWatch Logs storage cost triples. Alert fires 2 weeks later.
    Nobody knows who changed it or when. No audit trail.

  With SSM Parameter Store:
    Change is recorded in CloudTrail (who, when, from which IP).
    Previous value stored (can revert).
    Deployment pipeline reads fresh values — no manual intervention.
```

---

## SECTION 2 — Core Technical Explanation

```
NAMING CONVENTION — path-based hierarchy:
  /{app}/{environment}/{category}/{name}

  Examples:
    /myapp/production/database/host           = mydb.abc123.us-east-1.rds.amazonaws.com
    /myapp/production/database/port           = 5432
    /myapp/production/database/name           = myapp_prod
    /myapp/production/app/log_level           = info
    /myapp/production/app/max_upload_size_mb  = 100
    /myapp/production/features/new_checkout   = false
    /myapp/staging/database/host              = mydb-staging.abc123.us-east-1.rds.amazonaws.com
    /myapp/staging/app/log_level              = debug
    /myapp/staging/features/new_checkout      = true   ← enabled in staging to test, disabled in prod

FETCHING ALL CONFIG FOR AN ENVIRONMENT:
  The GetParametersByPath API fetches all params under a prefix — one call, all config.

  // config.ts — load all SSM config at startup:
  import { SSMClient, GetParametersByPathCommand } from '@aws-sdk/client-ssm';

  const ssm = new SSMClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
  const APP_ENV = process.env.APP_ENV ?? 'development';  // Set in ECS task definition

  export async function loadConfig(): Promise<Record<string, string>> {
    const prefix = `/myapp/${APP_ENV}/`;
    const params: Record<string, string> = {};

    let nextToken: string | undefined;
    do {
      const response = await ssm.send(new GetParametersByPathCommand({
        Path: prefix,
        Recursive: true,        // include sub-paths
        WithDecryption: true,   // decrypt SecureString type params
        NextToken: nextToken,
      }));

      for (const param of response.Parameters ?? []) {
        // Convert path to flat key: /myapp/prod/app/log_level → LOG_LEVEL
        const key = param.Name!.replace(prefix, '').replace(/\//g, '_').toUpperCase();
        params[key] = param.Value!;
      }

      nextToken = response.NextToken;
    } while (nextToken);

    logger.info({ event: 'config_loaded', parameterCount: Object.keys(params).length, prefix });
    return params;
  }

  // Usage in server.ts:
  const config = await loadConfig();
  const LOG_LEVEL = config.APP_LOG_LEVEL ?? 'info';
  const MAX_UPLOAD_MB = parseInt(config.APP_MAX_UPLOAD_SIZE_MB ?? '50', 10);

CREATING PARAMETERS (Terraform):
  resource "aws_ssm_parameter" "app_log_level" {
    name  = "/myapp/production/app/log_level"
    type  = "String"
    value = "info"
    tags  = { Environment = "production", App = "myapp" }
  }

  resource "aws_ssm_parameter" "db_host" {
    name  = "/myapp/production/database/host"
    type  = "String"  # Not SecureString — hostname is not a secret
    value = aws_db_instance.main.address
  }
```

---

## SECTION 3 — Architecture Diagram (MANDATORY)

```typescript
// env.ts — validated configuration object at application boundary

import { z } from "zod";

// Define the expected shape and types of configuration:
const ConfigSchema = z.object({
  // Required:
  APP_ENV: z.enum(["development", "staging", "production"]),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  // Database (host from SSM, password from Secrets Manager — injected as env vars by ECS):
  DB_HOST: z.string().min(1),
  DB_PORT: z.coerce.number().default(5432),
  DB_NAME: z.string().min(1),
  DB_PASSWORD: z.string().min(1), // Injected from Secrets Manager via ECS secrets

  // App behavior:
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  MAX_UPLOAD_MB: z.coerce.number().default(50),

  // Feature flags (string "true"/"false" → coerce to boolean):
  FEATURE_NEW_CHECKOUT: z
    .string()
    .transform((v) => v === "true")
    .default("false"),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export function loadEnvConfig(): AppConfig {
  const result = ConfigSchema.safeParse(process.env);

  if (!result.success) {
    // Fail loudly at startup with clear error — not silently use defaults:
    const missing = result.error.errors.map(
      (e) => `${e.path.join(".")}: ${e.message}`,
    );
    throw new Error(`Configuration validation failed:\n${missing.join("\n")}`);
  }

  return result.data;
}

// server.ts — startup:
const config = loadEnvConfig(); // Crash here if config is wrong — better than running wrong.

// BENEFIT: "TypeError: Cannot read property 'toUpperCase' of undefined" in production
//          becomes "Configuration validation failed: DB_HOST: Required" at startup.
//          The former is a mystery. The latter is immediately actionable.
```

---

## SECTION 4 — Request Flow (MANDATORY FLOWCHART)

```
WHAT ARE FEATURE FLAGS?
  Feature flags (aka feature toggles) let you deploy code to production but not activate it.
  The flag controls whether a NEW behavior is enabled without a redeploy.

  Use cases:
    Gradual rollout: enable for 5% of users, then 25%, then 100%.
    Kill switch: instantly disable a bad feature without deploying a hotfix.
    A/B testing: show feature to group A, old behavior to group B.
    Ops flag: enable verbose logging for 1 hour during incident investigation.

SIMPLE FLAG (SSM Parameter Store):
  SSM parameter: /myapp/production/features/new_checkout = false

  // In application code:
  function shouldUseNewCheckout(): boolean {
    return config.FEATURE_NEW_CHECKOUT === true;  // Read from startup config
  }

  To enable: update SSM parameter to "true". Redeploy (or implement live fetch).

  Limitation: changes require app restart (or live fetch with TTL/polling) to take effect.

LIVE FLAG (polling SSM at runtime):
  // feature-flags.ts — refresh flags every 60 seconds:

  let flags: Record<string, boolean> = {};

  export async function refreshFlags(): Promise<void> {
    const response = await ssm.send(new GetParametersByPathCommand({
      Path: `/myapp/${APP_ENV}/features/`,
      WithDecryption: false,
    }));

    const updated: Record<string, boolean> = {};
    for (const param of response.Parameters ?? []) {
      const name = param.Name!.split('/').pop()!;
      updated[name] = param.Value === 'true';
    }
    flags = updated;
  }

  // Refresh on startup and then every 60 seconds:
  await refreshFlags();
  setInterval(refreshFlags, 60_000);

  export function isEnabled(flag: string): boolean {
    return flags[flag] === true;
  }

  // Usage:
  if (isEnabled('new_checkout')) {
    return newCheckoutFlow(cart);
  } else {
    return legacyCheckoutFlow(cart);
  }

ADVANCED: LaunchDarkly / Flagsmith / AWS AppConfig
  For complex flag logic (user segments, percentage rollouts, A/B variants):
  These services handle flag delivery, targeting rules, and gradual rollouts
  without you polling SSM manually.
  AWS AppConfig integrates natively with ECS/Lambda and supports validation schemas.
```

---

### Production Readiness Checklist

```
CONSISTENCY
  [ ] Same application code runs in all environments (dev/staging/prod)
  [ ] Configuration is the ONLY difference between environments (not different code branches)
  [ ] Config is validated at startup — app refuses to start with missing/invalid config
  [ ] No default "production-looking" values in code — force explicit config per env

STORAGE
  [ ] Non-sensitive config stored in SSM Parameter Store organized by path hierarchy
  [ ] Sensitive config (secrets) stored in Secrets Manager (not SSM)
  [ ] Infrastructure config (resource ARNs, VPC IDs) output from Terraform, not hardcoded
  [ ] No production config values committed in source code or .env files

CHANGE MANAGEMENT
  [ ] SSM parameter changes tracked via CloudTrail (who changed what, when)
  [ ] Config changes require same approval process as code changes (optional, for regulated environments)
  [ ] Deployment pipeline reads config values at deploy time, not baked into images

FEATURE FLAGS
  [ ] New features gated by feature flags before production deployment
  [ ] Kill switch flags defined for each major new feature
  [ ] Flags are boolean or simple string — avoid complex structured data as flags
```
