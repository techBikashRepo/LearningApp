# Basic CI/CD

## FILE 01 OF 03 — Core Concepts, GitHub Actions, ECR/ECS Pipeline & Deployment Strategies

> **Architect Training Mode** | Site Reliability Engineer Perspective
> _CI/CD is not a tool. It's a contract: if tests pass, the code is deployable. If it's deployable, it deploys. Automatically. Every time. Humans don't touch production unless something is wrong._

---

## SECTION 1 — Intuition (Explain Like a 12-Year-Old)

```
WITHOUT CI/CD:
  Developer finishes a feature. To release:
    1. Manually run tests locally. (Did they run all of them?)
    2. Build Docker image locally. Push to ECR.
    3. SSH into production or use AWS Console to update the task definition.
    4. Manually trigger a deployment.
    5. Watch the logs to see if it worked.

  Problems:
    "Works on my machine" — tests ran in developer's environment, not a clean one.
    Deployment depends on one person's skill and uninterrupted attention.
    No audit trail: who deployed what version, when?
    Deployment is scary. Done infrequently. Big batches. Higher risk per deployment.
    Rollbacks: manual, slow, error-prone.
    Deployments happen business hours only (deployment is "an event").

WITH CI/CD:
  Developer merges PR to main.
  Pipeline automatically:
    Runs all tests in a clean environment.
    Builds Docker image tagged with commit SHA.
    Pushes image to ECR.
    Deploys to staging.
    Runs smoke tests.
    (Optionally) promotes to production.

  Benefits:
    Every merge is tested identically.
    Deployment is mechanical, not heroic.
    Full audit trail: "version 83a7c4f deployed by pipeline triggered by PR #142 at 14:32 UTC."
    Deployment frequency increases → smaller batches → lower risk per deployment.
    rollback = re-deploy the previous image tag (already built, already tested).

CI — CONTINUOUS INTEGRATION:
  Every code change is automatically built and tested against the main branch.
  Goal: detect integration problems immediately, not "at release time."

CD — CONTINUOUS DELIVERY:
  Every passing build is automatically deployable (possibly to staging, with manual gate to prod).

CD — CONTINUOUS DEPLOYMENT:
  Every passing build is automatically deployed to production.
  (No manual approval step. Higher maturity. Requires excellent test coverage.)
```

---

## SECTION 2 — Core Technical Explanation

```
TRIGGER: push to main branch (or PR merged)
  ┌─────────────────────────────────────────────────────────────────┐
  │                    GITHUB ACTIONS WORKFLOW                       │
  │                                                                   │
  │  Job 1: test                                                      │
  │    • checkout code                                                │
  │    • npm install                                                  │
  │    • npm run test (unit + integration)                            │
  │    • npm run lint                                                 │
  │                          ↓ (only if tests pass)                  │
  │  Job 2: build-and-push                                           │
  │    • Build Docker image                                           │
  │    • Tag with git SHA: 083a7c4f                                  │
  │    • Push to AWS ECR                                              │
  │                          ↓                                       │
  │  Job 3: deploy-staging                                            │
  │    • Update ECS task definition with new image                    │
  │    • Deploy to staging ECS service                                │
  │    • Wait for deployment to complete (green health checks)        │
  │    • Run smoke tests against staging                              │
  │                          ↓ (manual approval gate)                │
  │  Job 4: deploy-production (manual trigger or auto on tag)        │
  │    • Same as deploy-staging but for production cluster            │
  └─────────────────────────────────────────────────────────────────┘
```

### Complete GitHub Actions Workflow

```yaml
# .github/workflows/deploy.yml

name: CI/CD Pipeline

on:
  push:
    branches: [main] # Trigger on every merge to main
  pull_request:
    branches: [main] # Run tests on every PR (but don't deploy)

env:
  AWS_REGION: us-east-1
  ECR_REGISTRY: 123456789.dkr.ecr.us-east-1.amazonaws.com
  ECR_REPOSITORY: myapp-api
  ECS_CLUSTER_STAGING: myapp-staging
  ECS_SERVICE_STAGING: api-staging
  ECS_CLUSTER_PROD: myapp-production
  ECS_SERVICE_PROD: api-production
  CONTAINER_NAME: api # Must match containerDefinitions[].name in task definition

jobs:
  # ─── JOB 1: Test ─────────────────────────────────────────────────
  test:
    name: Run Tests
    runs-on: ubuntu-latest

    services:
      # Spin up a real Postgres for integration tests:
      postgres:
        image: postgres:15
        env:
          POSTGRES_PASSWORD: testpassword
          POSTGRES_DB: myapp_test
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
        ports:
          - 5432:5432

    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: "npm"

      - name: Install dependencies
        run: npm ci # ci = clean install from package-lock.json (not npm install)

      - name: Run linter
        run: npm run lint

      - name: Run tests
        env:
          DATABASE_URL: postgresql://postgres:testpassword@localhost:5432/myapp_test
          NODE_ENV: test
        run: npm run test:ci # npm run test -- --ci --coverage

      - name: Upload coverage reports
        uses: codecov/codecov-action@v4
        if: always() # Upload even if tests fail (for debugging)

  # ─── JOB 2: Build & Push Docker Image ────────────────────────────
  build:
    name: Build & Push Image
    runs-on: ubuntu-latest
    needs: test # Only runs if test job passes
    if: github.event_name == 'push' # Don't build on PRs

    outputs:
      image-tag: ${{ steps.build.outputs.image-tag }}

    steps:
      - uses: actions/checkout@v4

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: ${{ env.AWS_REGION }}
          # Use OIDC for GitHub Actions (better than long-lived keys):
          # role-to-assume: arn:aws:iam::123456789:role/github-actions-role

      - name: Login to Amazon ECR
        id: login-ecr
        uses: aws-actions/amazon-ecr-login@v2

      - name: Build and push Docker image
        id: build
        env:
          IMAGE_TAG: ${{ github.sha }} # git commit SHA as image tag
        run: |
          docker build \
            --build-arg APP_VERSION=$IMAGE_TAG \
            -t $ECR_REGISTRY/$ECR_REPOSITORY:$IMAGE_TAG \
            -t $ECR_REGISTRY/$ECR_REPOSITORY:latest \
            .

          docker push $ECR_REGISTRY/$ECR_REPOSITORY:$IMAGE_TAG
          docker push $ECR_REGISTRY/$ECR_REPOSITORY:latest

          echo "image-tag=$IMAGE_TAG" >> $GITHUB_OUTPUT

  # ─── JOB 3: Deploy to Staging ────────────────────────────────────
  deploy-staging:
    name: Deploy to Staging
    runs-on: ubuntu-latest
    needs: build
    environment: staging # GitHub environment (can add protection rules)

    steps:
      - uses: actions/checkout@v4

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: ${{ env.AWS_REGION }}

      - name: Update ECS task definition with new image
        id: task-def
        uses: aws-actions/amazon-ecs-render-task-definition@v1
        with:
          task-definition: .aws/task-definition-staging.json # Template in repo
          container-name: ${{ env.CONTAINER_NAME }}
          image: ${{ env.ECR_REGISTRY }}/${{ env.ECR_REPOSITORY }}:${{ needs.build.outputs.image-tag }}

      - name: Deploy to staging ECS
        uses: aws-actions/amazon-ecs-deploy-task-definition@v1
        with:
          task-definition: ${{ steps.task-def.outputs.task-definition }}
          service: ${{ env.ECS_SERVICE_STAGING }}
          cluster: ${{ env.ECS_CLUSTER_STAGING }}
          wait-for-service-stability: true # Wait until all tasks are healthy

      - name: Run smoke tests against staging
        run: |
          # Simple smoke test: check health endpoint is 200:
          response=$(curl -s -o /dev/null -w "%{http_code}" https://staging.myapp.com/health)
          if [ "$response" != "200" ]; then
            echo "Smoke test failed: /health returned $response"
            exit 1
          fi
          echo "Smoke test passed: staging is healthy"

  # ─── JOB 4: Deploy to Production (manual approval) ───────────────
  deploy-production:
    name: Deploy to Production
    runs-on: ubuntu-latest
    needs: [build, deploy-staging]
    environment:
      name: production # GitHub environment with required_reviewers = 1 person
      url: https://myapp.com

    steps:
      - uses: actions/checkout@v4

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: ${{ env.AWS_REGION }}

      - name: Update ECS task definition with new image
        id: task-def
        uses: aws-actions/amazon-ecs-render-task-definition@v1
        with:
          task-definition: .aws/task-definition-production.json
          container-name: ${{ env.CONTAINER_NAME }}
          image: ${{ env.ECR_REGISTRY }}/${{ env.ECR_REPOSITORY }}:${{ needs.build.outputs.image-tag }}

      - name: Deploy to production ECS
        uses: aws-actions/amazon-ecs-deploy-task-definition@v1
        with:
          task-definition: ${{ steps.task-def.outputs.task-definition }}
          service: ${{ env.ECS_SERVICE_PROD }}
          cluster: ${{ env.ECS_CLUSTER_PROD }}
          wait-for-service-stability: true
```

---

## SECTION 3 — Architecture Diagram (MANDATORY)

```
ROLLING UPDATE (ECS default):
  Replace tasks one at a time. New tasks register to ALB before old tasks deregister.

  ECS service configuration:
    minimumHealthyPercent: 50   (can go down to 50% capacity during deployment)
    maximumPercent: 200         (can scale to 200% capacity during replacement)

  Example (3 tasks currently running):
    Phase 1: Start 1 new task (now: 3 old + 1 new = 4 tasks). ALB routes to all.
    Phase 2: Old task health check fails (deregistered). Remove 1 old task (3 tasks).
    Phase 3: Repeat for each old task.

  Duration: ~3× the health check interval + ALB drain time per task.
  Zero downtime IF:
    New task passes health check successfully.
    ALB draining is configured (connection draining before removing old task).

  Rollback: ECS deployment circuit breaker (enable+rollback=true).
    If new deployment fails health checks: automatic rollback to previous task definition.

  WHEN: Default choice for most production deployments.

BLUE/GREEN DEPLOYMENT:
  Run new version (green) alongside old version (blue).
  ALB controls which target group receives traffic.

  Steps:
    1. Deploy green environment (new version). Test it.
    2. ALB: shift 100% traffic from blue to green (weighted target groups).
    3. Monitor for 10 minutes.
    4. If stable: decommission blue.
    5. If problems: shift traffic back to blue (instant rollback).

  Zero downtime. Instant rollback (just re-point ALB).
  Higher cost during transition: running 2× instances.

  AWS CodeDeploy handles this automatically for ECS.

  WHEN: High-traffic services where rolling update risk is too high.
        Services where you want guaranteed instant rollback.
        Blue/green in Terraform:
          aws_codedeploy_deployment_group with ECS_BLUE_GREEN deployment config.

CANARY DEPLOYMENT:
  Route 5–10% of traffic to new version. Monitor. Gradually increase.

  ALB weighted target groups:
    TargetGroup-v2: weight=5   (5% of requests)
    TargetGroup-v1: weight=95  (95% of requests)

  Monitor: error rate, latency, custom metrics.
  If metrics stable: increase v2 weight in steps (5 → 25 → 50 → 100).
  If metrics degrade: reduce v2 weight to 0. Investigate.

  WHEN: High-risk code changes. User-facing behavior changes. A/B testing.
        Situations where you want production validation before full rollout.
```

---

## SECTION 4 — Request Flow (MANDATORY FLOWCHART)

```
PIPELINE STRUCTURE
  [ ] CI runs on every PR — tests must pass before merge
  [ ] Build produces immutable artifact tagged with git SHA
  [ ] Same artifact deployed to staging and production (no rebuilds between envs)
  [ ] Staging deployment automatic; production deployment requires approval
  [ ] Pipeline tracks which image tag is deployed to which environment

SECURITY
  [ ] No long-lived AWS access keys in GitHub Secrets (use OIDC role assumption)
  [ ] GitHub environment protection rules: production requires 1 approver
  [ ] ECR image scanning enabled (detect known vulnerabilities before deployment)
  [ ] Docker image built with minimal base image (node:20-alpine not node:20)
  [ ] .dockerignore excludes node_modules, .env, .git, test files

DEPLOYMENT SAFETY
  [ ] ECS deployment circuit breaker: enable=true, rollback=true
  [ ] wait-for-service-stability=true (pipeline fails if deployment fails)
  [ ] Post-deployment smoke test: at minimum test /health endpoint
  [ ] Rollback procedure documented and tested
  [ ] Image tag pinned in task definition (not "latest")

OBSERVABILITY
  [ ] Pipeline steps emit success/failure metrics
  [ ] Deployment event logged to CloudWatch (know what deployed when)
  [ ] Slack/Teams notification on deployment failure
  [ ] Link from GitHub deployment to CloudWatch dashboard
```
