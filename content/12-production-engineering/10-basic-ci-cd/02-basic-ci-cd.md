# Basic CI/CD

## SECTION 5 — Real World Example

> **Architect Training Mode** | Site Reliability Engineer Perspective
> _Every CI/CD incident traces back to one of three failures: a test that didn't cover the broken behavior, a deployment that went to the wrong environment, or a rollback that wasn't fast enough._

---

### INCIDENT 01 — Bad Deployment Reaches Production With No Rollback Plan

### Symptom

```
Thursday 2:15 PM: Engineer merges a PR with a database migration + application changes.
                  Pipeline runs. Tests pass. Staging deploy: successful.
                  Production deploy: approved and started.

2:35 PM: Production deployment completes.
2:36 PM: Error rate spikes to 40%. PagerDuty fires.
2:36 PM: "TypeError: Cannot read property 'id' of undefined" in 40% of requests.
         Something is wrong with the new code.

Engineer (on-call): "I need to roll back."

PROBLEM:
  The engineer had no documented rollback procedure.
  Steps attempted:

  Step 1: Revert the git commit and push a new PR.
          PR review takes 10 minutes. CI tests run: 8 minutes. Deploy: 5 minutes.
          Total: ~23 minutes minimum. UNACCEPTABLE during active 40% error rate.

  Step 2 (emergency fallback): Manually update ECS task definition in AWS Console.
          Engineer opens console. Finds task definition.
          Tries to find the previous image tag. Tags are: "latest", "latest-prev"—
          no commit SHA tags. Cannot determine which image was last "working."

  Step 3: Deploy "latest-prev" tag hoping it's the previous version.
          It was the previous version from 3 days ago, skipping 2 intermediate versions.

3:02 PM: Deployed. Error rate drops. Service recovering.
Total downtime impact: 26 minutes at 40% error rate.
```

### Root Cause

```
FAILURE 1: Images tagged as "latest" and "latest-prev" instead of git SHA.
  "latest" is mutable. "latest" at rollback time is the broken version.
  Cannot determine which image to roll back to without commit SHA tagging.

  CORRECT: Tag every image with its git SHA:
    myapp-api:083a7c4f  (current)
    myapp-api:7b3e19d2  (previous working)

  AWS ECS service history shows which task definition was running.
  Task definition shows which image tag it was using.
  "Roll back" = deploy the task definition that used the previous SHA.

FAILURE 2: No automated rollback trigger.
  ECS deployment circuit breaker was NOT enabled.
  With circuit breaker (enable=true, rollback=true):
    New tasks fail health checks within 2 minutes.
    ECS automatically reverts to previous task definition.
    No human action required. Partial error window: ~5 minutes instead of 26.

FAILURE 3: wait-for-service-stability not set in pipeline.
  The pipeline marked deployment as successful when tasks were starting,
  not when they were healthy and serving traffic.
  With wait-for-service-stability=true:
    Pipeline waits until all new tasks pass health checks.
    If health checks fail: pipeline reports FAILURE.
    The circuit breaker reverts. Pipeline failure triggers immediate notification.

FAILURE 4: No documented rollback runbook.
  Under stress: engineer had to improvise. Improvised wrong (wrong image tag).
```

### Fix

```
1. Tag images with git SHA in pipeline:
   IMAGE_TAG: ${{ github.sha }}
   docker push $ECR_REGISTRY/$REPO:$IMAGE_TAG  # Immutable. Traceable. Always findable.

2. Enable ECS deployment circuit breaker in Terraform:
   resource "aws_ecs_service" "api" {
     deployment_circuit_breaker {
       enable   = true
       rollback = true  # Automatically revert if deployment fails
     }
   }

3. Enable wait-for-service-stability in the GitHub Actions deploy step:
   wait-for-service-stability: true

4. ROLLBACK RUNBOOK (30 seconds to start rollback):
   a) Identify the failing service: aws ecs describe-services --cluster prod --services api
   b) Find the previous ACTIVE task definition:
      aws ecs list-task-definitions --family-prefix api --status ACTIVE
      # Previous one = the one before the current.
   c) Update service to previous task definition:
      aws ecs update-service --cluster prod --service api \
        --task-definition api:<previous-revision-number>
   d) Confirm rollback: watch CloudWatch for error rate to reduce.
```

---

### INCIDENT 02 — Pipeline Deploys to Wrong Environment

### Symptom

```
Friday 11:30 AM: New security fix deployed through the pipeline.
                 Developer: "I'll send it to staging to validate."

                 The pipeline "staging" job ran successfully.
                 Developer: tested staging. Approved production.

11:45 AM: Production deployed.

12:00 PM: Security audit checks production RDS.
          The security fix was supposed to restrict access to admin users only.
          All users can still access the admin panel in production.

Investigation: the staging deployment went to...production.
               Production deployment went to... production again.
               Staging was never updated. The developer was testing the old version.

Why: The task definition JSON files committed to the repo had incorrect ECS cluster ARNs.
     Both .aws/task-definition-staging.json and .aws/task-definition-production.json
     were pointing to the production cluster. A copy-paste error when staging was set up.
```

### Root Cause

```
Manual configuration: two task definition template files manually maintained in the repo.
  task-definition-staging.json had a hardcoded production cluster ARN.
  Nobody noticed because "staging deployed successfully" (it did — to production).

The developer validated the old (broken) staging version and "approved" production
without the fix ever having been tested. The production deploy was the second
deploy to production, but without the security patch.

WHY WASN'T IT CAUGHT?
  The GitHub Actions workflow used the task definition file to determine WHERE to deploy.
  But the CLUSTER is specified in the deploy step (ECS_CLUSTER_STAGING env var).
  The task definition file's cluster ARN was IGNORED — it's just a definition template.
  The bug shipped, but from a different cause:

  After deeper investigation: the issue was the task definition templates correctly
  pointed to the right clusters. The actual error was that the ENVIRONMENT VARIABLES
  set different DATABASE_URL values, but both pointed to the same staging database,
  which was a copy of production from 3 months ago. The security fix WAS deployed,
  but was tested against 3-month-old data where the admin panel had different behavior.

  The staging database was stale. Staging was not representative of production.
```

### Fix

```
1. NEVER validate a security feature against stale staging data.
   For security features: test in staging with fresh production-like data AND
   include automated assertions in the test suite:

   // test/security/admin-access.test.ts:
   it('should deny admin panel access to non-admin users', async () => {
     const response = await request(app)
       .get('/admin/users')
       .set('Authorization', `Bearer ${regularUserToken}`);
     expect(response.status).toBe(403);
   });

   This test RUNS IN CI on every push. If the security fix regresses: CI fails.
   No manual validation step required or trusted.

2. STAGING ENVIRONMENT REFRESH:
   Weekly automated job: refresh staging database with a sanitized production snapshot.
   (Production data: anonymize PII before copying to staging.)
   Staging will always behave like production.

3. DEPLOY CONFIRMATION LOG:
   Pipeline step logs the deployment target explicitly:
   echo "Deploying image $IMAGE_TAG to cluster: $ECS_CLUSTER"
   echo "Service: $ECS_SERVICE"
   echo "Environment: staging"  # Hardcoded in the staging job, not from a variable

   This makes the actual deployment target visible in the GitHub Actions log.
   Any human reviewing the pipeline output sees exactly where the deploy went.
```

---

### INCIDENT 03 — ECR Image Scan Unnoticed, Critical Vulnerability in Production

### Symptom

```
CVE-2024-XXXX announced: critical vulnerability in node 20.0 to 20.5.0.
                          Allows remote code execution via malformed HTTP headers.

Security team audit: production ECS is running node:20.4.0.
Immediately vulnerable.

How long has this been running? 3 months. Since the last base image update.
```

### Root Cause

```
Pipeline:
  1. Build Docker image using FROM node:20 (resolves to node:20-latest at build time).
  2. Push to ECR.
  3. Deploy.

  ECR image scanning IS enabled (set in Terraform during setup).
  ECR automatically scans on push.
  ECR scan found the CVE 3 months ago.
  ECR sends a FINDING to EventBridge.

  There was NO alert configured on the EventBridge finding.
  No one reviewed ECR scan results. They sat there silently.

  How node:20 became node:20.4.0:
    node:20 tag is mutable. The version it points to changes as Node releases updates.
    At build time 3 months ago: node:20 → 20.4.0.
    Since then: node:20 → 20.12.0 (patched). But our Dockerfile still FROM node:20.
    Pipeline doesn't rebuild the entire image weekly. Only rebuilds on code push.
    No dependency updates → same old node base → vulnerability persisted.
```

### Fix

```
1. ALERT ON ECR CRITICAL/HIGH FINDINGS:
   EventBridge rule: when ECR scan finds CRITICAL or HIGH severity CVE →
   SNS notification → email/Slack to security channel.

   resource "aws_cloudwatch_event_rule" "ecr_critical_cve" {
     event_pattern = jsonsencode({
       source      = ["aws.inspector2"]
       detail-type = ["Inspector2 Finding"]
       detail = {
         severity = ["CRITICAL", "HIGH"]
         resources = [{ type = ["AWS_ECR_CONTAINER_IMAGE"] }]
       }
     })
   }

2. WEEKLY BASE IMAGE REBUILD:
   Scheduled GitHub Actions workflow (separate from deployment):

   # .github/workflows/weekly-rebuild.yml
   on:
     schedule:
       - cron: '0 6 * * 1'  # Every Monday at 6 AM UTC

   Jobs:
     - Build a fresh Docker image (this pulls the latest node:20 = always latest patch).
     - Push to ECR with tag "base-updated-YYYYMMDD".
     - Run ECR scan.
     - If scan passes: trigger deploy pipeline to staging.

   This ensures base image vulnerabilities are patched weekly, not only on code changes.

3. PIN TO NON-MUTABLE TAG FORMAT:
   FROM node:20.12.0-alpine  (specific patch version, explicit)

   When a new Node version is released: update the Dockerfile version deliberately via PR.
   Change is visible. Intentional. Not a surprise.

   Trade-off: requires manual updates. But the update is intentional and testable.

   Both approaches (pinned specific + weekly rebuild) are used in different organizations.
   Either is better than "FROM node:20" with no rebuild schedule.
```

---

## DEBUGGING TOOLKIT

### Check What's Currently Deployed

```bash
# What image tag is running in production right now?
aws ecs describe-services \
  --cluster myapp-production \
  --services api \
  --query 'services[0].deployments[*].{ID:id, Status:status, DesiredCount:desiredCount, RunningCount:runningCount, Image:runningTasks}' \
  --output table

# Get the specific image tag from the current task definition:
TASK_DEF=$(aws ecs describe-services --cluster myapp-production --services api \
  --query 'services[0].taskDefinition' --output text)

aws ecs describe-task-definition \
  --task-definition $TASK_DEF \
  --query 'taskDefinition.containerDefinitions[0].image' \
  --output text
# Returns: 123456789.dkr.ecr.us-east-1.amazonaws.com/myapp-api:083a7c4f

# The SHA 083a7c4f → find this in GitHub commits to know exactly what's running.
```

### Perform a Manual Rollback (Emergency)

```bash
# Find available task definition revisions:
aws ecs list-task-definitions \
  --family-prefix api-production \
  --status ACTIVE \
  --sort DESC \
  --query 'taskDefinitionArns[0:5]'  # Last 5 revisions
# Output: ["arn:.../api-production:45", "arn:.../api-production:44", "arn:.../api-production:43"]

# Roll back to revision 44 (previous):
aws ecs update-service \
  --cluster myapp-production \
  --service api \
  --task-definition api-production:44

# Monitor rollback progress:
aws ecs describe-services \
  --cluster myapp-production \
  --services api \
  --query 'services[0].deployments[*].{Status:status, Running:runningCount, Desired:desiredCount}'
# Watch for the new deployment (ROLLBACK) to show runningCount = desiredCount.
```

### Check Pipeline Failures and Deployment History

```bash
# From GitHub CLI: list recent workflow runs for the deploy workflow
gh run list --workflow=deploy.yml --limit=10
# Shows: run ID, status, commit SHA, time

# View logs of a specific failed run:
gh run view <run-id> --log

# From AWS: see ECS service event history (deployment events):
aws ecs describe-services \
  --cluster myapp-production \
  --services api \
  --query 'services[0].events[0:10]'
# Shows: "service api has started 1 tasks: task abc123" and health check results.

# CloudTrail: who approved and triggered the production deployment:
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=EventName,AttributeValue=UpdateService \
  --start-time $(date -u -d "24 hours ago" +%FT%TZ) \
  --query 'Events[].{Time:EventTime, Who:Username}'
```

### Verify ECR Image Scan Status

```bash
# Check scan results for the currently deployed image:
IMAGE_TAG="083a7c4f"  # Current deployed tag

aws ecr describe-image-scan-findings \
  --repository-name myapp-api \
  --image-id imageTag=$IMAGE_TAG \
  --query 'imageScanFindings.findingSeverityCounts'
# Output: {"CRITICAL": 0, "HIGH": 2, "MEDIUM": 5}
# CRITICAL=0 is expected. Any CRITICAL: investigate immediately.

# List critical vulnerabilities in detail:
aws ecr describe-image-scan-findings \
  --repository-name myapp-api \
  --image-id imageTag=$IMAGE_TAG \
  --query 'imageScanFindings.findings[?severity==`CRITICAL`].{Name:name, Severity:severity, URI:uri}'
```

## SECTION 6 — System Design Importance

The incident patterns above highlight key system design principles: design for failure, implement graceful degradation, enforce security boundaries at every layer, and monitor proactively. Each incident represents a production scenario that should inform your system design decisions.

## SECTION 7 — AWS & Cloud Mapping

AWS services directly relevant to these patterns: **ECS/Fargate** for container orchestration and task lifecycle management; **ECR** for secure image storage and scanning; **Secrets Manager / SSM Parameter Store** for runtime secret injection; **CloudWatch** for container metrics, logs, and alarms; **IAM** for fine-grained access control.

## SECTION 8 — Interview Preparation

**Beginner:**

**Q: What is CI/CD and what specific problems does it solve?**
**A:** CI (Continuous Integration) = automatically run tests on every code change. CD (Continuous Delivery/Deployment) = automatically build and deploy the tested code. Without CI/CD: developers merge code, manually run tests (or skip them), manually SSH to a server and upload files, pray nothing is broken. With CI/CD: every PR triggers automated tests â€” broken code can't merge. Every merge to main: builds Docker image, runs tests, deploys to staging automatically. Releasing to production is a button press (Delivery) or fully automatic (Deployment). Result: faster releases (hours vs weeks), fewer manual errors, instant feedback on broken code.

**Q: What is the difference between Continuous Delivery and Continuous Deployment?**
**A:** *Continuous Delivery:* every commit is automatically tested and built into a deployable artifact (Docker image, package). Deploying to production requires a human action (button press, PR approval). Used when: regulatory approval needed, business coordination required, or the team wants human oversight. *Continuous Deployment:* every commit that passes all automated tests is automatically deployed to production â€” no human in the loop. Used when: very high test coverage and confidence, fast rollback capability, and a culture of small frequent releases (multiple times per day). Most teams start with Delivery, evolve to Deployment as testing coverage and rollback confidence grows.

**Q: What are the core stages of a typical CI/CD pipeline for a Node.js API?**
**A:** Typical pipeline in order: (1) *Checkout:* pull code from Git. (2) *Install dependencies:* 
pm ci (reproducible install). (3) *Lint:* ESLint for code quality. (4) *Type check:* TypeScript 	sc --noEmit. (5) *Unit tests:* Jest, fail on any test failure. (6) *Integration tests:* tests that hit a real database (run in Docker Compose). (7) *Build Docker image:* docker build -t myapp: .. (8) *Security scan:* Trivy or Snyk scan the image for CVEs. (9) *Push to ECR:* tag with Git SHA and push. (10) *Deploy to staging:* update ECS service with new image. (11) *Smoke test:* automated test against staging. (12) *(Optional) Deploy to production.*

---

**Intermediate:**

**Q: What is a deployment strategy and what are the key differences between blue/green and rolling deployments?**
**A:** *Rolling deployment:* replace old containers with new containers gradually (e.g., 2 at a time out of 10). At any point, some users go to old version, some to new. Cheap (no duplicate infrastructure). Risk: if new version has a bug, it affects some users immediately. Rollback: ECS rolls back to previous task definition. *Blue/green deployment:* maintain two identical environments. Blue = current production. Green = new version. Deploy to Green, run tests, switch all traffic at once to Green (DNS or ALB target group switch). Instant rollback: switch back to Blue. More expensive (double infrastructure cost during switchover). Best for: high-risk deployments, database schema changes, situations where you can't tolerate partial rollout.

**Q: What is a CI/CD "artifact" and why does immutability matter?**
**A:** An artifact is the build output: the Docker image, compiled binary, or deployment package. Immutability means: once built and tagged with the Git SHA (myapp:a3f8b12), that artifact never changes. If you deploy myapp:a3f8b12 to staging and it passes, you deploy the EXACT SAME artifact to production. You never rebuild from source for production deployment. This guarantees: what you tested is what you deployed. A mutable artifact (:latest tag overwritten) breaks this guarantee â€” the "same" tag might be different images at test and deploy time.

**Q: What is a deployment rollback and how do you design your pipeline to make rollbacks fast and safe?**
**A:** Rollback means reverting to the previous working version quickly after a bad deploy. For ECS: ws ecs update-service --task-definition myapp:42 --service myapp-prod â€” swap back to the previous task definition revision. This works in seconds. Design requirements for fast rollback: (1) *Immutable image tags:* by Git SHA, old image is always in ECR. (2) *ECS task definition history:* previous revisions are preserved. (3) *Database backward compatibility:* new code must work with the old DB schema AND new schema. Never deploy a schema migration that breaks the previous version (Blue/Green expansion-contraction pattern). (4) *One-click rollback in CI/CD:* pipeline step "rollback to previous version" invokes the ECS update command automatically.

---

**Advanced (System Design):**

**Scenario 1:** Design a GitHub Actions CI/CD pipeline for a Node.js API deployed to AWS ECS. Include: pull request validation, staging deployment on merge to main, and production deployment via manual approval. Specify the exact jobs, their dependencies, and how secrets are handled.

*Pipeline structure (yaml pseudocode):*
`
on:
  pull_request: [opened, synchronize]  â†’ runs "validate" job
  push to main:                        â†’ runs "validate" then "deploy-staging"

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - checkout
      - npm ci (cached by package-lock hash)
      - run: npm run lint
      - run: npm run typecheck
      - run: npm test (unit)
      - run: docker build -t myapp:test .
      - run: trivy image --exit-code 1 --severity CRITICAL myapp:test
      (secrets: none needed for validate)

  deploy-staging:
    needs: [validate]
    if: github.ref == 'refs/heads/main'
    steps:
      - configure-aws-credentials (IAM OIDC â€” no long-lived keys)
      - docker build -t myapp: .
      - docker push {ECR_REPO}:
      - aws ecs update-service --task-definition update with new image tag
      - wait for deployment complete: aws ecs wait services-stable
      - run smoke tests against staging URL

  deploy-production:
    needs: [deploy-staging]
    environment: production  (requires manual approval in GitHub)
    steps:
      - same as staging but targeting prod ECS cluster
`
*Secrets:* AWS credentials via OIDC (GitHub assumed role) â€” no long-lived access keys stored in GitHub. Principle: CI assumes a scoped IAM role via GitHub OIDC trust, not static credentials.

**Scenario 2:** Your team deploys 10+ times per day with full CI/CD. A production deployment introduced a bug that took 3 hours to detect (monitoring was insufficient). By then, 5,000 users had experienced errors, and the bad code had already been deployed to production 4 more times (overwriting history). How do you restructure your deployment process and monitoring to detect bad deploys within 5 minutes?

*Detection < 5 minutes:*
(1) *Automated smoke tests:* run after every production deploy. Tests critical paths â€” login, primary user flow. If they fail: immediate rollback trigger + alert. Tests run in < 2 minutes.
(2) *Synthetic monitoring:* Datadog/CloudWatch Synthetics runs every minute â€” would have caught user-facing error within 1-3 minutes.
(3) *Deployment-correlated alerting:* CloudWatch alert that triggers for 5 minutes after any production deploy: temporarily lower error rate alarm threshold to 0.1% (vs normal 1%). Catches subtle regressions.
(4) *Canary deployment:* deploy new version to 5% of ECS tasks first. Watch metrics for 5 min. If healthy: deploy remainder. If not: automatic rollback. Only 5% of users see the bug.

*History preservation:*
(5) *ECR image retention:* last 30 tagged images retained (never overwrite by SHA). Old images available for rollback.
(6) *ECS task definition history:* preserved automatically. After detecting bad deploy: ecs update-service --task-definition previous-revision â†’ rollback in 30s.
(7) *Deployment freeze during incident:* CI/CD pipeline check: if a CloudWatch alarm is in ALARM state, production deployment is blocked (GitHub Actions check against CloudWatch API).

