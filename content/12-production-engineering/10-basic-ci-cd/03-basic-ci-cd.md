# Basic CI/CD


> **Architect Training Mode** | Site Reliability Engineer Perspective
> _A CI/CD pipeline is only as trustworthy as the tests it runs. If you would merge code without tests, the pipeline is theater. If you trust the tests, the pipeline is infrastructure._

---

## SECTION 9 — Certification Focus (AWS SAA-C03)

### Decision 1 — Continuous Deployment vs. Continuous Delivery?

```
CONTINUOUS DELIVERY:
  Every passing build is automatically deployed to staging.
  Production deployment requires a human approval step.

  Pipeline:
    code push → tests → build → staging deploy (automatic) → [human approves] → prod deploy

  Pros:
    Staging always reflects the latest passing code.
    Human review for production: catch issues tests missed.
    Business can control deployment timing (avoid holiday deploys, etc.).

  Cons:
    Human approval creates a bottleneck.
    Approval may be rubber-stamped (no real review).
    Staging is always ahead of production — can cause "staging is fine, production is broken" confusion.

CONTINUOUS DEPLOYMENT:
  Every passing build is automatically deployed to production.
  No manual approval step.

  Pipeline:
    code push → tests → build → staging deploy → smoke tests → prod deploy (automatic)

  Pros:
    Forces discipline: if anything in production might break, the test must exist.
    Deployment frequency increases → smaller, safer changes.
    No batching of changes → each deployment is small.
    No approval bottleneck.

  Cons:
    Requires excellent test coverage and confidence.
    A bad test suite + auto-deploy = production broken regularly.
    Less appropriate for regulated environments (audit trail needs explicit approvals).

RECOMMENDATION:
  Continuous Delivery is the pragmatic default for most teams.
  Continuous Deployment is the goal — but it requires the test discipline first.

  Start with: auto-deploy to staging, manual gate for production.
  Evolve to: auto-deploy to production when the team's confidence in tests is high.

  The question is not "which is better" but "what is our test coverage and rollback speed?"
```

### Decision 2 — Rolling Update vs. Blue/Green vs. Canary?

```
ROLLING UPDATE:
  Replace old tasks one at a time with new tasks. Application always partially available.

  Choose when:
    Standard deployments. Stateless services.
    Can tolerate a brief window where both old and new versions serve traffic.
    Your service is backward-compatible (API changes are additive, not breaking).

  Configuration:
    minimumHealthyPercent: 100 (never reduce below full capacity — zero downtime, slower)
    minimumHealthyPercent: 50  (reduce to 50% during deploy — faster, brief reduced capacity)

BLUE/GREEN:
  New version deployed alongside old version. Instant traffic cut-over.
  Old version stays alive for instant rollback.

  Choose when:
    Breaking changes that can't tolerate mixed-version traffic.
    Database migrations that are NOT backward compatible.
    Need guaranteed instant rollback (not the ECS circuit breaker gradual rollback).

  Cost: temporarily running 2× instances.
  Time: more complex setup, longer deployment process.

CANARY:
  Route a small percentage of traffic to new version. Gradually increase.

  Choose when:
    High-risk features (payment changes, A/B behavioral changes).
    Want user behavior validation before full rollout.
    Have the monitoring to detect errors at 5% traffic.

  Requirement: good observability per version. Can you tell if the 5% canary has
               higher error rates than the 95% stable version?

THE ANSWER: Rolling for most. Blue/green for breaking changes. Canary for high-risk features.
            These are not mutually exclusive — you can choose per deployment.
```

### Decision 3 — How to Handle Database Migrations in the Pipeline?

```
THE PROBLEM:
  Application v2 requires a new column: ALTER TABLE users ADD COLUMN last_login TIMESTAMP.
  Deployment: stop v1 ECS tasks, start v2 ECS tasks.

  If migration runs BEFORE deploy: v2 column exists, v1 code ignores it (fine).
  If migration runs DURING deploy: some v1 tasks + some v2 tasks running simultaneously.
    v2 task: uses last_login column.
    v1 task: doesn't know about last_login column.
    If migration adds NOT NULL column without default: v1 task INSERT fails with error.

  This is a real production problem.

SOLUTION 1: Expand-Contract (Backward-Compatible Migrations)
  Deploy migrations in phases:

    Phase 1 (Expand): Add column as nullable (or with default):
      ALTER TABLE users ADD COLUMN last_login TIMESTAMP;  -- nullable = backward compatible
      Deploy application v2 (writes to last_login, handles null gracefully).
      Old v1 tasks: ignore the new column. Continue working.

    Phase 2 (Contract): After v2 is fully deployed with no v1 tasks remaining:
      Add NOT NULL constraint or clean up old unused columns.
      ALTER TABLE users ALTER COLUMN last_login SET NOT NULL;
      OR: DROP COLUMN old_unused_column;

  Key insight: migrations are backward-compatible (any code version can work with the schema
  during the transition). Never deploy a BREAKING schema change simultaneously with code.

SOLUTION 2: Run migrations as a separate pipeline step before deployment:
  In GitHub Actions:
    - name: Run database migrations
      run: npx db-migrate up
      env:
        DATABASE_URL: ${{ secrets.PROD_DATABASE_URL }}

    # Only after migration succeeds:
    - name: Deploy ECS service
      ...

  Pre-condition: the migration must be backward-compatible (v1 code works after migration).
  If migration fails: deployment step never runs. Service stays on v1 with unmodified schema.

SOLUTION 3: No-migration deployments (avoid schema changes with simultaneous code changes)
  Separate PRs:
    PR 1: Schema migration only (no application changes). Deploy and verify.
    PR 2: Application code changes (uses new schema). Deploy.

  This gives maximum safety and clear rollback boundaries.
```

---

## SECTION 10 — Comparison Table

**Trap 1 — "Use 'latest' tag for Docker images in ECS"**

```
WRONG: "latest" is a mutable tag.
  When you deploy with image: myapp:latest, ECS uses whatever is in ECR as "latest" TODAY.
  Rolling back means "deploy the previous task definition" but the "latest" tag
  in that task definition is NOW the broken version (it was just pushed).

  You cannot reliably roll back to a specific version using the "latest" tag.

CORRECT: Tag images with an immutable identifier — the git commit SHA.
  image: myapp:083a7c4f

  Rollback = deploy the task definition that pointed to the previous SHA.
  The previous SHA's image is in ECR, unchanged, always available. Instant rollback.
```

**Trap 2 — "CI/CD means automated deployment to production on every push"**

```
NUANCED: Continuous DEPLOYMENT means this (every passing build → production).
         Continuous DELIVERY means automated deployment to staging, manual gate for production.

Most organizations use Continuous Delivery.
Neither is more "correct" — it depends on test coverage quality and risk tolerance.

When someone says "we do CI/CD":
  They might mean: all the way to production automatically (CD = deployment).
  They might mean: automated to staging, manual approval for production (CD = delivery).
  Ask which one they mean. The answer matters.
```

**Trap 3 — "Tests pass in CI so the deployment is safe"**

```
NUANCED: Tests that pass give you confidence proportional to the quality of the tests.
  Tests that don't cover the new behavior → confidence is false.

  The real question: "What could break that isn't tested?"
    Integration with external services (Stripe, SendGrid) — rarely tested in CI.
    Database migration side effects — often not explicitly tested.
    Performance under load — unit tests don't catch this.
    Configuration errors — startup validation tests this; feature tests don't.

Trust your tests for what they cover. Be explicit about what they don't cover.
Use post-deploy smoke tests and monitoring to catch what CI doesn't.
```

**Trap 4 — "Rolling back means reverting the git commit"**

```
WRONG for immediate rollback during an incident.
  Reverting a git commit requires: PR → review → CI tests (10+ minutes) → deployment.
  During an active incident with a 40% error rate: 10 minutes is unacceptable.

CORRECT: Rollback = re-deploy the previous Docker image (already built, already tested).
  ECS: update service to previous task definition revision.
  GitHub Actions: re-trigger the pipeline from the previous commit's successful run.

  This takes 2–5 minutes (the time to run a normal ECS deployment).
  No code review. No tests. The previous image already passed tests when it was built.
```

**Trap 5 — "One pipeline for all environments is simpler"**

```
WRONG: A single pipeline that deploys everywhere without environment-specific controls:
  Deploys a breaking change to production the same way as a typo fix.
  Can't add a human gate only for production.
  Harder to configure different variables per environment.

CORRECT: Separate jobs per environment within one workflow file.
  Same workflow, different jobs. Job for staging runs automatically.
  Job for production uses a GitHub environment with required_reviewers.
  Each job has its own env vars, secrets, and ECS cluster targets.
```

---

## SECTION 11 — Quick Revision

**Q1: "Walk me through your CI/CD pipeline for a Node.js application deployed on ECS."**

```
When a PR is merged to main, GitHub Actions triggers a workflow with four jobs.

First: test job. Runs on ubuntu-latest. Starts a Postgres service container.
Runs npm ci for clean installs, then the full test suite including integration tests.
If tests fail: pipeline stops. Nothing gets deployed.

Second (only on push to main, not PRs): build job.
Builds the Docker image, tags it with the git SHA (not "latest"), and pushes to ECR.
ECR automatically scans the image for vulnerabilities.

Third: deploy to staging.
Updates the ECS task definition to use the new image tag.
Uses aws-actions/amazon-ecs-deploy-task-definition and waits for service stability.
Then runs a smoke test — at minimum an HTTP check against the /health endpoint.

Fourth: deploy to production.
This job uses a GitHub Environment with one required approver.
The workflow pauses here until someone approves.
After approval: same deploy process as staging, but to the production cluster.

The ECS services have deployment circuit breaker enabled with rollback.
If new tasks fail health checks: ECS automatically reverts to the previous task definition.
```

**Q2: "What's the difference between rolling update, blue/green, and canary deployment, and when do you use each?"**

```
Rolling update replaces tasks incrementally. New tasks are added to ALB, old tasks drain,
then are replaced. Traffic flows to both versions during the transition.
I use this for most deployments — stateless services, backward-compatible API changes.
It's simple, zero-downtime, and ECS handles it natively.

Blue/green deploys a complete new environment alongside the old one.
ALB switches 100% of traffic at once. The old environment stays live for instant rollback.
I use this when both versions can't serve traffic simultaneously — breaking API changes,
database migrations that aren't backward-compatible.

Canary routes a small percentage of traffic to the new version and gradually increases it.
Best used for high-risk changes where I want production validation before full rollout —
payment flow changes, major new features.
Requires good per-version metrics to actually measure whether the 5% canary is healthy.

Default is rolling. Migrate to blue/green or canary for specific high-risk deployments.
```

**Q3: "How do you handle database migrations in a CI/CD pipeline?"**

```
The critical rule: migrations must be backward-compatible with the version of code
that's currently running. You can't deploy a migration that breaks the running application.

In practice, I use the expand-contract pattern.
First, I deploy the migration to add a nullable column or non-breaking schema change.
The existing code still works with the new schema — it just ignores the new column.
Then, in the same deployment or a subsequent one, I deploy the application code
that uses the new column.
Later, once the old code is fully gone, I can add NOT NULL constraints or drop old columns.

In the pipeline: migrations run as a dedicated step before the ECS service deploy.
If the migration fails, the deploy step never runs — service stays on old code with old schema.

For safety on risky migrations: I take a pre-migration RDS snapshot as part of the pipeline.
If we need to restore to pre-migration state: the snapshot is already there.
```

---

## SECTION 12 — Architect Thinking Exercise

### The 5 Rules of CI/CD Done Right

```
RULE 1: The build artifact is the unit of deployment. Build once, deploy everywhere.
  Same Docker image (same SHA) goes to staging and production.
  If you rebuild for production: you're deploying untested code.
  The image tested in staging IS the image deployed to production.

RULE 2: Tags are identities. "latest" is not an identity.
  Image tag = git SHA. Every deployment is traceable to an exact commit.
  Rollback = re-deploy a previous SHA. Takes 3 minutes, not 25.
  "latest" gives you no option to roll back specifically.

RULE 3: The pipeline fails on broken deployments, not just broken tests.
  wait-for-service-stability: true
  ECS circuit breaker: enable + rollback.
  Smoke tests after deploy.
  A deployment that produces unhealthy tasks is a deployment failure.
  The pipeline must detect and report it.

RULE 4: The rollback procedure is tested as often as the deploy procedure.
  Run a rollback drill quarterly. Know the commands. Time how long it takes.
  The first time you run a rollback should not be during a production incident.

RULE 5: CI/CD amplifies the quality of your tests.
  Good tests + CI/CD = rapid, confident delivery.
  No tests + CI/CD = automated delivery of untested software.
  The pipeline does not make your software correct. It makes delivery of correct software fast.
  Invest in the tests first.
```

### The 3 Mistakes Every Team Makes

```
MISTAKE 1: "latest" Docker tag. No commit SHA tracking.
  Consequence: rollbacks are slow, risky, and sometimes point to the wrong version.
  Fix: image tag = git SHA. One line change in the pipeline.

MISTAKE 2: wait-for-service-stability not set.
  Pipeline says "deploy succeeded" before tasks are healthy.
  Deployment keeps running with unhealthy tasks. Alert fires 5 minutes later as a surprise.
  Pipeline should be the one that detects deployment failure, not PagerDuty.

MISTAKE 3: Testing in CI but not validating in production.
  CI tests pass in a clean environment with mock data.
  The production environment has real data, real scale, real integrations.
  Add a post-deploy smoke test to every deployment.
  At minimum: HTTP GET /health. Ideally: test a real user workflow.
```

### 30-Second Answer: "Describe your CI/CD process."

```
"On every merge to main, GitHub Actions runs three stages.

First: tests. The full test suite runs in a clean Ubuntu environment with a real database.
If tests fail: nothing else happens.

Second: build. Docker image is built and pushed to ECR, tagged with the git SHA.
Same image will be used for both staging and production — built once.

Third: deploy. Staging deployment is automatic after build.
Production requires a one-person approval in GitHub's environment protection.
After approval, ECS gets a new task definition pointing to the new image SHA.
ECS deployment circuit breaker handles rollback automatically if the new tasks fail health checks.
The pipeline waits for service stability before declaring success.

Rollback when needed: 3 minutes — update the ECS service to point to the previous
task definition revision. The previous SHA's image is still in ECR, unchanged."
```
