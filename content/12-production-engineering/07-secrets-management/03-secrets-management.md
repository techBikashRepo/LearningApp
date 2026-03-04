# Secrets Management


> **Architect Training Mode** | Site Reliability Engineer Perspective
> _The question isn't "how do I store my secrets securely." The question is "how do I design a system where secrets never need to be directly handled by humans in production?"_

---

## SECTION 9 — Certification Focus (AWS SAA-C03)

### Decision 1 — Secrets Manager vs SSM Parameter Store vs Vault

```
OPTION A: AWS Secrets Manager

  Pros:
    Built-in automatic rotation (no code to write for RDS rotation).
    Rotation Lambda provided by AWS for common databases (RDS, Redshift, DocumentDB).
    First-class secret type — not a generic key-value store.
    CloudTrail integration: every access logged.
    Versioning: AWSCURRENT and AWSPREVIOUS both valid during rotation transition.

  Cons:
    Cost: $0.40/secret/month. At 100 secrets: $40/month.
    Slightly more complex setup than SSM.

  WHEN: Any secret that should rotate. All production database passwords. All prod API keys.

OPTION B: SSM Parameter Store (SecureString)

  Pros:
    Free for standard tier.
    Same IAM/KMS integration.
    Good for hierarchy-organized config: /app/env/setting.
    Can reference directly from ECS task definitions.

  Cons:
    No built-in rotation (manual rotation only).
    Not semantically named as "secrets" — configuration and secrets mixed together.

  WHEN: Non-rotating configuration values. Per-environment settings.
        Large number of parameters where Secrets Manager cost matters.

OPTION C: HashiCorp Vault (self-managed or HCP)

  Pros:
    Multi-cloud. Not AWS-specific.
    Dynamic secrets: Vault can generate short-lived credentials on demand
                     (database credentials that expire in 1 hour, not rotate monthly).
    Fine-grained access policies.

  Cons:
    Operational overhead of running Vault (unless using HCP Vault = SaaS).
    More complexity. Vault itself needs to be highly available.

  WHEN: Multi-cloud architecture. Dynamic (ephemeral) credentials needed.
        Organization with dedicated security team and Vault expertise.

THE ANSWER FOR MOST APPLICATIONS:
  Secrets Manager for secrets (DB passwords, API keys, JWT secrets) = rotating values.
  SSM Parameter Store for configuration (feature flags, environment URLs, app settings).
  Don't introduce Vault unless you have specific requirements and expertise.
```

### Decision 2 — Where in the Stack to Inject Secrets?

```
OPTION A: Inject at infrastructure level (ECS secrets → environment variable)

  ECS task definition references Secrets Manager ARN.
  ECS fetches and injects secret as env var when task launches.
  App reads: process.env.DB_PASSWORD.

  Pros:
    Simple. The app doesn't need Secrets Manager client code.
    Works for any language/framework.

  Cons:
    Secret is visible in process environment (ps -e on host, not isolated).
    No auto-pickup of rotated secrets (task restart required).
    Must match secret version to task launch time — stale if secret rotated mid-task-lifetime.

OPTION B: Fetch from application code (SDK call at startup)

  App calls GetSecretValue at startup (and optionally on auth failure).

  Pros:
    Can implement cache-refresh on auth failure (picks up rotated secrets without restart).
    Only fetched when needed.
    Control over error handling (fail startup vs. run without secret).

  Cons:
    App needs Secrets Manager client dependency.
    IAM task role needs secretsmanager:GetSecretValue permission.

OPTION C: Sidecar container fetches secrets and writes to shared volume

  A sidecar (e.g., AWS SSM Agent or a custom init container) fetches secrets
  and writes them to a shared in-memory volume (tmpfs). Main container reads from file.

  Pros:
    Decouples secret-fetching logic from app.
    Files in tmpfs: not visible in process env, not persisted to disk.

  Cons:
    More complex setup.
    File refresh needs coordination.

RECOMMENDATION:
  Start with OPTION B (app fetches from SDK) for production applications.
  Pair with auth-error refresh for rotation compatibility.
  OPTION A is fine for simple services or when you want minimal app-level changes.
```

### Decision 3 — How Long to Cache Secrets?

```
OPTION A: Cache forever (for the lifetime of the process)

  Simple. One SDK call per startup.
  Risk: secret is rotated → cached value becomes stale → auth failures.
  Acceptable only if: you're confident rotation never happens or you're OK with restart.

OPTION B: Cache with TTL (refresh every N hours)

  Re-fetch from Secrets Manager every 4 hours (or some interval).

  Pros: picks up rotated secrets proactively.
  Cons: complexity. Need to handle the case where old cached value is used between
        fetch cycles and rotation happens during that window.

OPTION C: Cache with invalidation on auth failure (recommended)

  Cache until an authentication error occurs. Auth error → invalidate → re-fetch → retry once.

  Best practice pattern:
    Normal operation: cached value, zero extra API calls.
    After rotation: first auth failure triggers re-fetch. One Secrets Manager call.
    Automatic recovery without restart. No background tasks or timers.

  This is the correct model for most applications.
```

---

## SECTION 10 — Comparison Table

**Trap 1 — "Environment variables are secure"**

```
WRONG: Environment variables are NOT secure storage for secrets.
  They're visible in the process environment on the host.
  They can be accidentally logged (logger.debug(process.env)).
  They're visible in ECS task definition JSON in the AWS Console.
  They don't have audit logs, versioning, or rotation.

CORRECT: Use Secrets Manager or SSM SecureString.
         If you must use env vars: inject via ECS secrets reference (Secrets Manager → env var).
         This is different from hardcoding the value in the task definition.
```

**Trap 2 — "Deleting the secret from git history makes us safe"**

```
WRONG: git filter-branch removes the file from new clones but:
  Anyone who cloned the repo before deletion still has it.
  GitHub's own copy may take time to be cleaned.
  Any forks of the repository have their own copy.
  CI/CD systems may have cached the secret in pipeline artifacts.

CORRECT: Treat any exposed secret as permanently compromised.
         Revoke IMMEDIATELY. Generate new secret. Then clean history.
         Cleaning history is cosmetic — not a security remediation.
```

**Trap 3 — "Rotating the secret in Secrets Manager rotates it everywhere"**

```
WRONG: Rotating in Secrets Manager updates the STORED value. But any application
       that cached the old value continues using it until it restarts or re-fetches.

CORRECT: Rotating Secrets Manager changes the authoritative value.
         Your APPLICATION must be designed to pick up that change.
         Either via: restart, TTL-based refresh, or auth-failure-triggered re-fetch.
```

**Trap 4 — "One set of credentials for all environments"**

```
WRONG: Using the same API key in dev, staging, and production means:
  A developer's local machine compromise exposes production credentials.
  A test script loop in development can burn production API rate limits (Incident 04).
  Staging load tests affect production external service billing.

CORRECT: Separate credentials per environment. Each environment has its own path in
         Secrets Manager: /myapp/{dev|staging|production}/sendgrid-key.
         Dev/staging use sandbox or test mode where available.
```

**Trap 5 — "SecretString vs SecretBinary: either works"**

```
For JSON secrets (multiple key-value pairs): use SecretString JSON.
  Easier to parse. Human-readable in the console (when authorized).
  Example: {"DB_PASSWORD": "xyz", "STRIPE_KEY": "sk_live_abc"}

SecretBinary is for actual binary data (encryption keys, certificates).
  Base64-encoded. Slightly more complex to handle.

Most application secrets: use SecretString JSON.
```

**Trap 6 — "Secrets Manager is too expensive — use SSM"**

```
Context: $0.40/secret/month.
A typical production application has:
  1 database password
  1 JWT secret
  2–3 third-party API keys
Total: 4–5 secrets = $1.60–$2.00/month.

The cost of a single production secret leak (incident response, engineering hours,
customer trust, potential fines) vastly outweighs $24/year for Secrets Manager.

Use Secrets Manager for actual secrets. Use SSM for config.
Don't avoid Secrets Manager over cost for production credentials.
```

---

## SECTION 11 — Quick Revision

**Q1: "How do you store and manage secrets in production on AWS?"**

```
All production secrets live in AWS Secrets Manager, organized by environment path:
/myapp/production/db-password, /myapp/production/stripe-key, and so on.

Database passwords use automatic rotation with the AWS-provided Lambda rotation function
for RDS — rotation triggers every 30 days, generates a new password, updates RDS,
and promotes the new value to AWSCURRENT with a grace period where both old and new work.

Applications fetch secrets at startup via the Secrets Manager SDK and cache them in memory.
If an auth failure occurs, the cache is invalidated and we re-fetch — this handles
mid-lifecycle rotation without a restart.

Access is controlled via IAM: each ECS task execution role has a policy granting
GetSecretValue only to its specific secret ARNs — not a wildcard. Every access
is logged to CloudTrail for audit purposes.

In development, secrets are fetched from /myapp/development/ paths, which point at
test accounts and sandbox modes — completely isolated from production values.
```

**Q2: "What do you do if you discover a secret was committed to git?"**

```
First action: revoke the secret immediately.
Even before you clean git history. The secret is compromised the moment it's accessible.
If it's a database password: rotate it in both RDS and Secrets Manager.
If it's a third-party API key: revoke in the provider's dashboard, generate a new key.

Then: check exposure. CloudTrail for database access. Provider dashboards for API key usage.
Determine if unauthorized access occurred and what the blast radius is.

Then: generate a new secret, store in Secrets Manager, deploy updated application.
Verify the application is using the new credential before proceeding.

Then: clean git history (BFG Repo Cleaner or git filter-branch) — but treat this as
hygiene, not remediation. The credential must already be considered permanently compromised.

Finally: post-incident review. How did it get committed? Pre-commit hooks (git-secrets),
CI scanning (truffleHog in PR pipeline), disable hardcoding secrets as a policy.
```

**Q3: "What's the difference between AWS Secrets Manager and SSM Parameter Store, and when do you use each?"**

```
Secrets Manager is specifically designed for secrets. Its key advantage is automatic rotation.
SSM Parameter Store is a generic key-value store that supports encrypted values (SecureString).

I use Secrets Manager for anything that rotates:
database passwords, API keys, JWT signing keys.
The built-in rotation Lambda for RDS means zero code for rotating database credentials.

I use SSM Parameter Store for configuration that varies between environments but doesn't rotate:
feature flags, external service URLs, non-sensitive app settings.
It's free for standard tier, which makes it practical for dozens of config parameters.

The cost difference matters at scale: 100 secrets in Secrets Manager = $40/month.
100 parameters in SSM standard tier = $0. But for actual secrets, the rotation and
auditing capabilities of Secrets Manager are worth the $0.40/secret/month.
```

---

## SECTION 12 — Architect Thinking Exercise

### The 5 Rules of Secrets That Stay Secret

```
RULE 1: A secret that a human can see is no longer a secret. Follow the path.
  If a developer can: read the .env file, view the task definition, search CloudWatch logs —
  the secret is accessible to every developer and anyone who compromises their machine.
  Design systems where NO human path to the plaintext secret exists in normal operation.
  Audit logs: fine. Console output: not fine.

RULE 2: Rotate. Rotation limits the blast radius of a compromise you don't know about.
  If the DB password has been the same for 3 years, a silently compromised credential
  has been active for 3 years. Monthly rotation caps the exposure window at 30 days.
  Automate rotation — manual rotation doesn't happen on schedule.

RULE 3: Separate credentials per environment. Never share production secrets with anything else.
  Dev and staging are run by humans on machines that may be less secure.
  Production secrets should be unrelated to anything that hits a developer device.

RULE 4: Least privilege. Each service gets access ONLY to the secrets it needs.
  If the email service is compromised, it can't read the payment service's Stripe key.
  IAM resource policies: specific ARNs, not wildcards.

RULE 5: Design your app to survive secret rotation without a restart.
  Build auth-failure-triggered re-fetch into every secret consumer.
  If it can't survive rotation: you'll skip rotation "just this once" → then always.
```

### The 3 Mistakes Every Team Makes

```
MISTAKE 1: Putting secrets in environment variables in the task definition.
  It seems like "infrastructure" so it feels safe. But the task definition is JSON visible
  in AWS Console, deployable in plain text, and potentially leaked via CloudFormation stacks.
  The correct way: task definition references a Secrets Manager ARN (the ARN is not the secret).

MISTAKE 2: Rotation works on paper but breaks the running application.
  Rotation is implemented. Tests pass. Then the first rotation fires at 3 AM and every
  running ECS task starts failing because they cached the old password.
  Rotation without app-side refresh handling is incomplete.

MISTAKE 3: Using the same secret for local development and production.
  Starts as "just until we properly set this up." Persists for years.
  Ends with a developer's laptop incident affecting production.
```

### 30-Second Answer: "How do you handle secrets in a production Node.js application on AWS?"

```
"All secrets live in AWS Secrets Manager organized by environment,
/myapp/production/ for production and separate paths for staging and dev.

Database passwords use Secrets Manager's built-in RDS rotation — it generates a new
password, updates RDS, and rotates automatically every 30 days.

The application fetches secrets once at startup via the AWS SDK, caches them in memory,
and re-fetches if it gets an authentication failure — so rotation works without deploys.

Access is controlled via IAM: each ECS task role has GetSecretValue permission only for
its specific secret ARNs. Every access is logged in CloudTrail.

Nothing is hardcoded, nothing is in .env files, and we run git-secrets as a pre-commit hook
plus truffleHog in CI to catch any accidental secret commits before they reach the repository."
```
