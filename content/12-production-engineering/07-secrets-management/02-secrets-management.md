# Secrets Management

## SECTION 5 — Real World Example

> **Architect Training Mode** | Site Reliability Engineer Perspective
> _Secrets incidents don't announce themselves with a pager alert. They announce themselves six months later with "someone has been accessing your production database for 30 days."_

---

### INCIDENT 01 — API Key Found in Public GitHub Repository

### Symptom

```
Friday 6:40 PM: Security team receives automated alert from GitHub's secret scanning.
                "Stripe live API key detected in public repository commit."

Immediate questions:
  When was the key exposed?
  Has anyone used it since the exposure?
  Is it still active?
  What transactions could have been made?
```

### Root Cause

```
Developer flow:
  1. Developer added Stripe integration locally.
      Created .env file: STRIPE_SECRET_KEY=sk_live_XXXXXXXXXXXXX
      Added .env to .gitignore. Correct.

  2. Developer created a "test" script during debugging:
      scripts/test-stripe.js:
        const stripe = require('stripe')('sk_live_XXXXXXXXXXXXX');
        // hardcoded key because "it's just a test script"

  3. Script committed along with the rest of the work.

  4. Repository was temporary made public to onboard a contractor.
      Public for 12 hours. GitHub secret scanning: flagged it.
      GitGuardian (also scanning): flagged it.
      But also: dozens of automated bots scan all GitHub public commits within minutes.

Timeline:
  Commit: 3 weeks ago.
  Repository public: yesterday 6 AM.
  Compromise window: 6 AM to 6:40 PM = 12 hours.
  Suspicious Stripe activity detected during review: 3 unauthorized test charges.
```

### Fix

```
IMMEDIATE (within minutes):
  1. Revoke the exposed key in Stripe dashboard immediately.
     This is the most important action. Even if a new key isn't ready: revoke it now.
  2. Check Stripe logs for suspicious transactions in the exposure window.
  3. Make repository private.

SHORT-TERM (same day):
  4. Generate new Stripe key.
  5. Store new key in Secrets Manager, not in code or .env.
  6. Deploy updated application using new key via Secrets Manager.
  7. Remove hardcoded key from git history:
     git filter-branch or BFG Repo Cleaner (just removing the file isn't enough;
     the key must be removed from ALL history, or the git history still contains it).
     Alternative: consider the key permanently compromised regardless of history scrubbing.

LONG-TERM (process fix):
  8. Add git-secrets pre-commit hook to all developer machines:
       git secrets --install
       git secrets --register-aws
       # Blocks commits containing patterns matching common API key formats.

  9. Add CI/CD step: run truffleHog or Semgrep to scan for secrets on every PR.

  10. Policy: all production API keys live in Secrets Manager ONLY.
      Scripts that need a key for testing use a test-mode key, not live.
      Test keys go in Secrets Manager under /myapp/development/ path.
```

---

### INCIDENT 02 — Secret Rotation Breaks Running Application

### Symptom

```
Wednesday 2:00 AM: Automated Secrets Manager rotation fires (scheduled: monthly).
                   Generates new RDS password. Updates RDS. Stores in Secrets Manager.

2:00 AM: All ECS tasks are running fine. They loaded the DB password at startup 1 week ago.
          They're using the OLD password. Old password is now AWSPREVIOUS.
          RDS still accepts AWSPREVIOUS for a brief grace period. Status: OK.

2:15 AM: New ECS task launches (auto-scaling event from scheduled batch job).
          New task fetches AWSCURRENT password from Secrets Manager.
          Connects to RDS. Works fine.

3:00 AM: Secrets Manager rotation grace period expires. AWSPREVIOUS password deactivated.
          Active ECS tasks: still using cached old password. All DB queries start failing.

3:00 AM: 500 errors spike. Alarms fire. On-call woken up.
```

### Root Cause

```
ECS tasks loaded the DB password once, at startup, cached it forever.
When rotation invalidated the old password, running tasks had no mechanism
to pick up the new one without a restart.

The application code:
  let dbPassword: string | null = null;
  async function getPassword() {
    if (dbPassword) return dbPassword;  // PROBLEM: never refreshed
    dbPassword = (await loadSecrets()).DB_PASSWORD;
    return dbPassword;
  }

The fundamentally broken assumption: "the secret won't change while the app is running."
In pre-Secrets-Manager world: true. In Secrets Manager world: false by design.
```

### Fix

```
IMMEDIATE: Restart all ECS tasks.
  aws ecs update-service --cluster prod --service api --force-new-deployment
  Tasks restart, fetch AWSCURRENT password from Secrets Manager, connect successfully.
  Recovery time: ~3 minutes (ECS rolling replacement).

PROPER FIX — Implement cache invalidation on auth failure:

  export class DbPool {
    private pool: Pool | null = null;

    async getPool(): Promise<Pool> {
      if (this.pool) return this.pool;
      this.pool = await this.createPool();
      return this.pool;
    }

    private async createPool(): Promise<Pool> {
      secretsCache = null;  // Force fresh fetch from Secrets Manager
      const { DB_PASSWORD } = await loadSecrets();
      return new Pool({ password: DB_PASSWORD, /* other config */ });
    }

    async query(sql: string, params?: any[]): Promise<any> {
      try {
        return (await this.getPool()).query(sql, params);
      } catch (err: any) {
        if (isPasswordAuthError(err)) {
          logger.warn({ event: 'db_auth_failure_refresh', msg: 'Refreshing credentials after auth failure' });
          this.pool = null;               // Destroy old pool
          await this.getPool();           // Create new pool with fresh secret
          return (await this.getPool()).query(sql, params);  // Retry once
        }
        throw err;
      }
    }
  }

  function isPasswordAuthError(err: any): boolean {
    // pg throws a specific PG error code for password authentication failure:
    return err.code === '28P01' || err.message?.includes('password authentication failed');
  }

This approach: auth failure → refresh secret → retry once. Zero manual intervention.

ALSO: Adjust rotation timing. Rotate at 3 AM when traffic is lowest.
      Give grace period of 24h (both old and new passwords valid for 24h).
      This provides a window for running tasks to reconnect naturally.
```

---

### INCIDENT 03 — Secrets Leaked via CloudWatch Logs

### Symptom

```
External security audit report:
"Database connection strings including passwords are visible in CloudWatch log group
/aws/ecs/production/api. Any developer with CloudWatch read access can retrieve production
RDS passwords."

Audit tested:
  1. Connected as a developer IAM user to AWS Console.
  2. Opened CloudWatch Logs.
  3. Searched for "postgresql://" — 847 log entries with full connection strings.
  4. Connection string format: postgresql://app:PASSWORD@rds.endpoint:5432/dbname
```

### Root Cause

```
Application startup logging:
  logger.info(`Database connected: ${config.DB_URL}`);
  // DB_URL = postgresql://app:p@$$w0rd@mydb.abc123.us-east-1.rds.amazonaws.com:5432/myapp

Error logging on connection failure:
  catch (err) {
    logger.error(`Failed to connect to database: ${err.message}`);
    // err.message from pg: "password authentication failed for user 'app' - connection: postgresql://app:p@$$w0rd@..."
    // Driver includes full connection string in error message
  }

Both cases: full connection string (including password) serialized into log event.
CloudWatch retains logs for 90 days (default). 847 entries over 90 days: normal rotation.
```

### Fix

```
IMMEDIATE:
  1. Delete the specific log groups/streams containing credentials.
     (CloudWatch doesn't have "search and replace" — must delete entire stream or export + redact + re-import)
  2. Rotate the exposed passwords immediately.

APPLICATION FIX:
  3. Never log connection strings:
       // WRONG:
       logger.info(`Database connected: ${process.env.DATABASE_URL}`);

       // CORRECT:
       logger.info({
         event: 'database_connected',
         host: config.DB_HOST,  // Log host and dbname, NOT password or full URL
         database: config.DB_NAME,
       });

  4. Redact sensitive fields in the logger:
       // Pino (Node.js logger) redaction:
       const logger = pino({
         redact: {
           paths: ['password', '*.password', 'authorization', '*.authorization',
                   'db_url', '*.db_url', 'connectionString', 'headers.authorization'],
           censor: '[REDACTED]',  // Replace with this string in logs
         }
       });

  5. pg error messages: catch and sanitize before logging:
       catch (err: any) {
         // Strip connection details from error message before logging:
         const safeMessage = err.message?.replace(/postgresql:\/\/[^:]+:[^@]+@[^/]+/g, 'postgresql://[REDACTED]');
         logger.error({ event: 'db_connection_error', message: safeMessage, code: err.code });
       }

GOVERNANCE FIX:
  6. CloudWatch log retention: set 30-day retention (not indefinite).
     Reduces window of exposed data if a leak occurs.
  7. Developer access to production CloudWatch: read-only and requires approval.
  8. CloudWatch Logs Insights queries: log them (CloudTrail records API calls).
     If a developer searches for passwords: that query is auditable.
```

---

### INCIDENT 04 — Third-Party API Key Reaches Daily Rate Limit Unexpectedly

### Symptom

```
Tuesday 11:00 AM: SendGrid suddenly returns 429 for all email send calls.
                 Marketing email campaign: completely stalled.
                 User signup confirmation emails: failing.

Dashboard check: API key hit 100,000 emails/day limit.
Normal daily volume: ~2,000 emails.
Usage today: 94,000 emails by 11 AM.
```

### Root Cause

```
Previous week: a developer was testing a bulk email feature.
              Used production SendGrid API key (stored in .env.local) "just for testing."
              Test script accidentally looped 92,000 emails against real production key.

  WHY did this happen?
    Development environment variables sourced from .env.local.
    .env.local contained SENDGRID_API_KEY=<production key>.
    Developer didn't know it was production — it was copied from a shared document
    months ago when the application was first deployed.
    No environment-level differentiation.
```

### Fix

```
IMMEDIATE: Switch to a different API key (create a new one in SendGrid, update Secrets Manager).
           The rate limit was per-key, not per-account.

ROOT CAUSE FIX:
  1. Separate keys per environment:
       Secrets Manager:
         /myapp/production/sendgrid-api-key  → sk-prod-XXXXXX (daily limit: 100k)
         /myapp/staging/sendgrid-api-key     → sk-staging-XXXXXX (daily limit: 10k)
         /myapp/development/sendgrid-api-key → sk-dev-XXXXXX OR use SendGrid sandbox mode

  2. Development always uses sandbox mode:
       if (process.env.APP_ENV === 'development') {
         sendgrid.setMailSettings({
           sandboxMode: { enable: true }  // Emails accepted but not delivered
         });
       }

  3. Per-key rate limit monitoring:
       CloudWatch custom metric: SendGridEmailsSent.
       Alarm: ALERT when daily count > 80,000 (80% of limit), before hitting 100k.
```

---

## DEBUGGING TOOLKIT

### Find Secrets References in Source Code

```bash
# Scan codebase for hardcoded secrets or secret references (run in repository root):

# Common API key patterns:
grep -rn "sk_live_\|pk_live_\|sk_test_\|AKID\|ASIA" --include="*.ts" --include="*.js" .
# Exclude node_modules and build output:
grep -rn "sk_live_" . --include="*.ts" --exclude-dir={node_modules,dist,.git}

# Find any place where a full postgres URL might be logged:
grep -rn "postgresql://" . --include="*.ts" --include="*.js" --exclude-dir=node_modules

# Find environment variables containing "password" or "secret" in config files:
grep -rn "SECRET\|PASSWORD\|API_KEY" .env .env.local .env.production 2>/dev/null
```

### Check Who Accessed a Secret (CloudTrail)

```bash
# AWS CloudTrail: find all GetSecretValue calls for a specific secret in the last 24h:
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=ResourceName,\
AttributeValue="myapp/production/secrets" \
  --start-time $(date -u -d "24 hours ago" +%FT%TZ) \
  --query 'Events[].{Time:EventTime, User:Username, IP:CloudTrailEvent}' \
  --output table

# See all calls to GetSecretValue in the last hour (any secret):
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=EventName,AttributeValue=GetSecretValue \
  --start-time $(date -u -d "1 hour ago" +%FT%TZ) \
  --output json | jq '.Events[] | {time: .EventTime, user: .Username}'
```

### Verify Secret Content Without Exposing It

```bash
# Check that a secret exists and was updated recently (without printing the value):
aws secretsmanager describe-secret \
  --secret-id "myapp/production/secrets" \
  --query '{Name: Name, LastChanged: LastChangedDate, RotationEnabled: RotationEnabled}'

# Verify rotation configuration:
aws secretsmanager describe-secret \
  --secret-id "myapp/production/db-password" \
  --query '{RotationEnabled: RotationEnabled, NextRotation: NextRotationDate, Lambda: RotationLambdaARN}'

# List all versions of a secret (see if AWSCURRENT ≠ AWSPREVIOUS = rotation happened):
aws secretsmanager list-secret-version-ids \
  --secret-id "myapp/production/db-password" \
  --query 'Versions[].{ID: VersionId, Stages: VersionStages, Created: CreatedDate}'
```

### Check for Leaked Secrets in Git History

```bash
# Install truffleHog and scan repository history:
pip install trufflehog
trufflehog git file://. --since-commit HEAD~100  # scan last 100 commits

# Or use git-secrets:
brew install git-secrets
git secrets --scan-history  # scan entire repository history

# BFG Repo Cleaner: remove a specific string from ALL git history:
java -jar bfg.jar --replace-text passwords.txt  # passwords.txt lists strings to remove
git reflog expire --expire=now --all
git gc --prune=now --aggressive
```

## SECTION 6 — System Design Importance

The incident patterns above highlight key system design principles: design for failure, implement graceful degradation, enforce security boundaries at every layer, and monitor proactively. Each incident represents a production scenario that should inform your system design decisions.

## SECTION 7 — AWS & Cloud Mapping

AWS services directly relevant to these patterns: **ECS/Fargate** for container orchestration and task lifecycle management; **ECR** for secure image storage and scanning; **Secrets Manager / SSM Parameter Store** for runtime secret injection; **CloudWatch** for container metrics, logs, and alarms; **IAM** for fine-grained access control.

## SECTION 8 — Interview Preparation

**Beginner:**

**Q: What is the difference between a configuration value and a secret?**
**A:** Configuration values are non-sensitive settings that define how an application behaves: LOG_LEVEL=info, MAX_CONNECTIONS=20, AWS_REGION=us-east-1. These can be committed to a config file, visible in logs, etc. Secrets are sensitive credentials that, if exposed, give access to protected resources: database passwords, API keys, JWT signing keys, TLS private keys, OAuth client secrets. Secrets must never: appear in source code, be committed to Git, appear in logs, be transmitted without encryption, or be visible in CI/CD environment variable settings on screen. Treat every secret as if an adversary is actively trying to steal it.

**Q: What is AWS Secrets Manager and what problem does it solve compared to environment variables?**
**A:** Environment variables for secrets are stored in the ECS task definition (visible in AWS console to anyone with ECS access), in CI/CD pipeline settings, and potentially in shell history. Secrets Manager: encrypted store for secrets, access controlled by IAM (not ECS task view permissions), audit log of every access (CloudTrail), supports automatic rotation (changes the password on a schedule, updates applications automatically). The key difference: environment variables are "set and forgotten" â€” Secrets Manager is "live rotation without redeployment."

**Q: What does "least privilege" mean for secrets access and how do you implement it?**
**A:** Least privilege means a service can only access the secrets it actually needs â€” nothing more. Implementation: each ECS task has its own IAM task role. The payment service's task role has secretsmanager:GetSecretValue permission only for rn:aws:secretsmanager:*:*:secret:prod/payment-service/*. It cannot read prod/user-service/database-password even if it tried. Without least privilege: one compromised service can extract all secrets.

---

**Intermediate:**

**Q: What is secret rotation and how does AWS Secrets Manager automate it?**
**A:** Secret rotation is periodically changing a credential (e.g., rotating a database password every 30 days). Manual rotation: someone changes the password in Secrets Manager AND updates RDS. Any connected applications using the old password fail until they reload the secret. Automated rotation in AWS: Secrets Manager invokes a Lambda function on a schedule. Lambda: (1) creates new password in RDS, (2) updates the secret in Secrets Manager, (3) tests the new credential, (4) deletes the old one. Applications using the ECS secrets injection pattern automatically get the new password on their next deployment (or poll Secrets Manager on a schedule). For RDS: Lambda rotation function is provided by AWS (select in console â€” no code needed).

**Q: What is the difference between Secrets Manager and SSM Parameter Store, and when should you use each?**
**A:** *SSM Parameter Store:* Free for standard parameters. Supports plaintext and SecureString (KMS encrypted). Good for: non-sensitive config, feature flags, environment-specific settings. No automatic rotation. *Secrets Manager:* ~.40/secret/month. Specifically designed for credentials: built-in rotation support, cross-account access, better audit logging. Good for: database passwords, API keys, OAuth secrets. Use Rule: SSM for config that happens to be somewhat sensitive (API gateway URL, service account names). Secrets Manager for anything that could directly compromise a database, third-party account, or cryptographic operation.

**Q: What are the security implications of printing a secret in application logs and how do you prevent it?**
**A:** Logs aggregate to centralized systems (CloudWatch) visible to everyone with permissions. If console.log("connecting to DB:", connectionString) where connectionString contains a password â†’ password in CloudWatch â†’ visible to every developer with CloudWatch Logs viewer permissions â†’ potentially exported to S3 â†’ available forever. Prevention: (1) Never log full connection strings or any string that might contain a secret. (2) Scrub secrets from error messages before logging: err.message.replace(dbPassword, '****'). (3) Use structured logging with explicit field names â€” don't log raw request/response bodies. (4) Static analysis tools (detect-secrets, git-secrets) in CI pipeline â€” scan for common secret patterns in code and logs config.

---

**Advanced (System Design):**

**Scenario 1:** Design a secret management system for a 20-microservice platform. Each service has 3-5 secrets. Secrets must be: rotated every 30 days, accessible only by the service that owns them, auditable (who accessed what, when), and updatable without service redeployment.

*Architecture:*
- Secrets Manager with path-based naming: /{env}/{service-name}/{secret-name}. Example: /prod/payment-service/stripe-api-key.
- ECS task roles: each service has a unique IAM task role. IAM policy grants secretsmanager:GetSecretValue on only its own path prefix.
- Secret injection: ECS secrets block in task definition (references Secrets Manager ARN). Injected at task start. No application code needed to call Secrets Manager.
- Rotation: 30-day schedule per secret. Lambda rotation functions per service type. RDS secrets use AWS-managed Lambda rotation.
- Zero-downtime rotation: Secrets Manager "version stages" â€” during rotation, both old (AWSCURRENT) and new (AWSPENDING) versions exist. Applications continue with current until rotation completes.
- Audit: CloudTrail records every GetSecretValue call: which IAM role, which secret, timestamp. Athena query on CloudTrail for audit reports.
- No-redeployment updates: for non-ECS-injected secrets, application code calls secretsmanager.getSecretValue() with 5-minute caching in process memory. Cache invalidated on 429 from API (rotation in progress).

**Scenario 2:** A developer accidentally committed a PostgreSQL connection string (with password) to a public GitHub repository. It was visible for 2 minutes before being caught. The repo is now private. What do you do in the next 30 minutes, and what process changes prevent this happening again?

*Immediate response (next 30 min):*
1. (T+0) Rotate the PostgreSQL password NOW â€” assume it's compromised. AWS: Secrets Manager â†’ rotate immediately. This invalidates the leaked credentials immediately.
2. (T+2) Check RDS logs for unexpected connections from non-application IPs since the commit was public.
3. (T+5) Check Git history to confirm no other secrets were in the same commit.
4. (T+10) BFD (git-filter-branch or BFG Repo Cleaner) to remove the commit from git history. Force push. Even though public, remove for audit record.
5. (T+15) Notify security team per incident response protocol.
6. (T+30) Verify application still connects to RDS with new password (Secrets Manager auto-rotation updated it).

*Prevention:*
- Pre-commit hook: detect-secrets scans every commit for 40+ secret patterns. Block commit if detected.
- CI gate: secret scanning on every PR (GitHub has built-in secret scanning, alerts on push).
- Engineer onboarding: mandatory security training includes "never put credentials in code."
- Vault pattern: if an engineer asks "where do I put this database password?" the answer is always "Secrets Manager, here's how to add it."

