# Monitoring

## FILE 03 OF 03 — Design Decisions, Runbooks, Exam Traps & Architect's Mental Model

> **Architect Training Mode** | Site Reliability Engineer Perspective

---

## SECTION 9 — Certification Focus (AWS SAA-C03)

### Decision 1: Container Insights — On or Off?

```
Container Insights provides per-task CPU/memory, not just per-service averages.
Cost: ~$0.50/container/month + log storage.
For 10 containers: ~$5/month. For 100 containers: ~$50/month.

ENABLE FOR: production only.
DISABLE FOR: development, staging (use standard ECS metrics, they're free).

Why standard ECS metrics aren't enough for production debugging:
  Standard: "ECS service API average memory = 72%"
  Container Insights: "Task abc123 memory = 94%, task def456 = 48%"
  Without per-task visibility: can't tell if one bad apple is skewing the average.

Terraform:
  resource "aws_ecs_cluster" "prod" {
    name = "prod"
    setting {
      name  = "containerInsights"
      value = "enabled"   # "disabled" for non-prod
    }
  }
```

### Decision 2: Standard Metrics (1-min) vs High-Resolution (1-sec)

```
Standard (1-minute granularity): included in CloudWatch free tier.
High-Resolution (1-second granularity): $0.30/metric/month extra.

USE HIGH-RESOLUTION FOR:
  - Payment processing latency (short bursts matter → 1-min window misses them)
  - Auto-scaling trigger metrics (scale faster by detecting spikes in 10 seconds vs 5 minutes)
  - Real-time gaming/trading applications

USE STANDARD FOR:
  - Everything else. 1-minute resolution catches 99% of production problems.
  - Memory leaks, error rate trends, saturation — all visible at 1-minute.

Default: standard everywhere. Add high-resolution only when you can justify the cost.
```

### Decision 3: Metric Filters vs Custom EMF Metrics

```
METRIC FILTER (from logs):
  CloudWatch Logs metric filter: extracts a number from a structured log field.
  When to use: you're already logging the event, and you just need a metric from it.
  Cost: free (you're already paying for log ingest).
  Latency: ~1 minute lag (logs must be ingested first, then metric extracted).

  Limitation: can only count (1 per match) or extract a numeric value from a field.
  Cannot do complex aggregations across multiple log fields.

CUSTOM EMF METRIC (embedded in logs):
  When to use: business KPIs that need precise values (payment amount, order total).
  Cost: free (embedded in log entry, uses PutLogEvents not PutMetricData).
  Latency: ~30 seconds after log ingest.

  Advantage: same log entry creates BOTH the audit trail and the metric.

DIRECT PUTMETRICDATA (SDK):
  When to use: metrics completely independent from log events.
  Batch: up to 20 metrics per API call.
  Cost: $0.01 per 1,000 API requests.
  Risk: separate from logs → can lose metric if app crashes before API call.

PREFERENCE ORDER: EMF > Metric Filter > PutMetricData
  EMF is the cleanest: one write creates both the log and the metric.
```

---

## SECTION 10 — Comparison Table

````markdown
# ECS — Service Task Count Below Desired

**Severity:** P1
**Alarm:** ecs-{service}-task-count-low
**Owner:** Platform Team

## What is this alert?

The ECS service is running fewer tasks than configured.
This means reduced capacity. If tasks = 0: service completely down.

## Dashboards

- [ECS Cluster](https://console.aws.amazon.com/ecs/v2/clusters/prod)
- [CloudWatch Operations Dashboard](https://console.aws.amazon.com/cloudwatch/home#dashboards:name=production-operations)

## Diagnosis

### Step 1: How many tasks are running vs desired? (30 sec)

```bash
aws ecs describe-services --cluster prod --services {service} \
  --query 'services[0].{desired:desiredCount, running:runningCount, pending:pendingCount}'
```
````

- desired=2, running=0, pending=2: tasks trying to start but failing.
- desired=2, running=1, pending=0: one task died and not recovering.

### Step 2: Get stopped task details (1 min)

```bash
STOPPED=$(aws ecs list-tasks --cluster prod --service-name {service} \
  --desired-status STOPPED --query 'taskArns[0]' --output text)
aws ecs describe-tasks --cluster prod --tasks $STOPPED \
  --query 'tasks[0].{stopped:stoppedReason, containers:containers[*].{name:name,exit:exitCode,reason:reason}}'
```

Exit code interpretation:

- Exit 1: application error. Check logs.
- Exit 137: OOMKill (out of memory). Increase task memory.
- Exit 125: Docker error. Check task definition.
- stoppedReason "Task failed container health checks": /health endpoint failing.

### Step 3: Check application logs (2 min)

```
# CloudWatch Logs Insights — last 5 minutes:
fields @timestamp, level, event, error.message
| filter level = "ERROR" or level = "FATAL"
| sort @timestamp desc
| limit 20
```

Look for startup errors (cannot connect to DB, missing env var, port already in use).

### Step 4: Check if image can be pulled

```bash
aws ecs describe-tasks --cluster prod --tasks $STOPPED \
  --query 'tasks[0].stoppedReason'
# "CannotPullContainerError" → ECR login or image tag issue
```

## Resolution

**Option A — Rollback** (if caused by recent deployment):

```bash
PREV=$(aws ecs describe-task-definition --task-definition {service} \
  --query 'taskDefinition.revision' --output text)
aws ecs update-service --cluster prod --service {service} \
  --task-definition {service}:$((PREV-1))
```

**Option B — Force new deployment** (if tasks stuck):

```bash
aws ecs update-service --cluster prod --service {service} \
  --force-new-deployment
```

**Option C — Increase memory** (if OOMKill):
Update task definition with higher memory. Redeploy.

## Escalation

If not resolved in 15 minutes → escalate to senior engineer.
If tasks still not starting after rollback → escalate to platform team.

```

---

## SECTION 11 — Quick Revision

```

TRAP 1: "Monitor CPU and memory and you're set."
Truth: CPU/memory are infrastructure metrics. The Four Golden Signals are:
Latency, Traffic, Errors, Saturation.
A service can have 8% CPU and be returning 15% error rate.
Infrastructure healthy ≠ service working correctly.
Always monitor at the application/ALB layer, not just the ECS task layer.

TRAP 2: "Average latency is the right thing to alert on."
Truth: Always use percentiles (P99, P95). Never average.
Average = adds fast requests + slow requests, divides.
P50=100ms, P99=8000ms → average ≈ 200ms (looks fine).
1 in 100 users gets an 8-second request. Average completely hides this.

TRAP 3: "An alarm in OK state means the service is healthy."
An alarm can be in OK state because:
a) The service is truly healthy. ✓
b) The metric isn't arriving. INSUFFICIENT_DATA gets confused with OK.
c) The alarm threshold is set too high to ever trigger.
d) The wrong namespace/dimension means it's watching a ghost metric.
Always verify: metric is receiving datapoints AND alarm is in OK (not INSUFFICIENT_DATA).

TRAP 4: "Container Insights on every environment saves debugging time."
Cost: $0.50/container/month. 20 containers × 5 environments = $50/month.
Dev and staging containers start/stop constantly → thousands of containers over a month.
Enable Container Insights on production only. Standard metrics are sufficient for dev/staging.

TRAP 5: "CloudWatch only keeps data for 15 days."
Partial truth. CloudWatch keeps data at progressively lower resolution:
3 hours: 1-second resolution
15 days: 1-minute resolution ← the limit many know
63 days: 5-minute resolution
455 days: 1-hour resolution
For "what was the error rate 3 months ago?" the 5-minute resolution data is still there.
For "what was the exact spike at 3:47am 6 months ago?" — gone. Archive to S3 if needed.

TRAP 6: "treat_missing_data = notBreaching is always safest."
For alarms on "RunningTaskCount" or "HealthyHostCount":
If service crashes → ECS stops emitting metrics → missing data.
notBreaching = alarm stays OK even though service is down.
For "service completely down" alarms: use treat_missing_data = "breaching".
For "error rate" alarms: use notBreaching (no traffic = no errors = not a problem).

TRAP 7: "One alarm per service is enough."
In practice:
At least one alarm per golden signal per service.
Plus: one alarm per shared dependency (RDS storage, connection count).
Plus: one business KPI alarm (payments/orders per minute).
One alarm risks covering only one failure mode while others go undetected.

```

---

## SECTION 12 — Architect Thinking Exercise

```

Q1: "What metrics would you monitor for a production API service?"

A: "I follow the Four Golden Signals: latency, traffic, errors, and saturation.
For latency: ALB TargetResponseTime at P99. Alert if P99 exceeds 2 seconds.
For traffic: ALB RequestCount per minute. Alert on sudden drops (service unreachable).
For errors: HTTPCode_Target_5XX_Count / RequestCount. Alert if error rate exceeds 1%.
For saturation: ECS CPUUtilization and MemoryUtilization. Alert at 70-80%.
Beyond infra: I also monitor RDS FreeStorageSpace, DatabaseConnections,
and ALB HealthyHostCount — that's probably the most critical one:
HealthyHostCount = 0 means the ALB has no targets to send traffic to. P1 immediately."

────────────────────────────────────────────────────────────────────

Q2: "Walk me through your alerting strategy for a production system."

A: "Four severity levels.
P1 wakes people up immediately via PagerDuty — service completely down, error rate > 5%.
P2 is non-urgent PagerDuty — degraded but not catastrophic, acknowledge by morning.
P3 posts to Slack — elevated metrics that need watching but not immediate action.
P4 is dashboard only — informational.
Every alarm has an owner, a runbook URL, and an ok_action (notify when it resolves).
I use composite alarms for P1s — fire only when BOTH error rate AND latency are
elevated simultaneously. Reduces false positives by ~60%.
Monthly: review alarm-to-action rate. Any alarm with < 50% actionability gets fixed or removed."

────────────────────────────────────────────────────────────────────

Q3: "How do you emit custom business metrics from your application?"

A: "I prefer Embedded Metric Format — EMF. Instead of a separate SDK call to
PutMetricData, I embed the metric directly in the structured log entry.
CloudWatch Logs automatically extracts it into a CloudWatch metric.
One write operation creates both the audit log AND the metric.
It's more cost-efficient than PutMetricData, and the metric and log are always in sync.
For example: when a payment is processed, I flush an EMF entry that emits
PaymentSuccess=1 and PaymentLatency=processingTimeMs to the MyApp/Payments namespace."

────────────────────────────────────────────────────────────────────

Q4: "What's the difference between CloudWatch standard and high-resolution metrics?"

A: "Standard resolution is 1-minute granularity — free for AWS-native metrics,
$0.30/metric/month for custom metrics.
High-resolution is 1-second granularity — an additional $0.30/metric/month.
For most production services, 1-minute resolution is sufficient.
High-resolution adds value for payment processing latency where you want to catch
a 5-second spike that resolves within a minute — which 1-minute averaging would miss.
Or for auto-scaling where you want to react in 10 seconds instead of 5 minutes."

```

---

### Architect's Mental Model

### 5 Decision Rules

```

RULE 1: MONITOR THE USER EXPERIENCE, NOT JUST THE INFRASTRUCTURE
CPU at 8% and memory at 40% tells you nothing about whether users are succeeding.
Monitor: ALB error rate, P99 latency, business KPIs (orders per minute).
Infrastructure metrics explain WHY. Business metrics tell you THAT something is wrong.

RULE 2: PERCENTILES OVER AVERAGES — ALWAYS
P99 is what your slowest 1% of users experience.
At 1000 RPS: that's 10 users per second getting a slow response.
At 100,000 RPS: that's 1000 users/second. P99 matters.
Never configure an alert on average latency.

RULE 3: EVERY ALARM MUST HAVE A RUNBOOK
An alarm that fires and nobody knows what to do = alert fatigue.
If you can't write a runbook for it: the alarm isn't ready for production.
Alarm description field: always include runbook URL.

RULE 4: SET THRESHOLDS BEFORE FAILURE, NOT AT FAILURE
RDS storage: alert at 10GB free (not 0).
Memory: alert at 80% (not 100% / OOMKill).
Connections: alert at 80% of max (not when pool is exhausted and app errors).
The goal is to have time to investigate before users are impacted.

RULE 5: VERIFY METRICS ARE ACTUALLY ARRIVING AFTER EVERY DEPLOY
New service, new metric namespace, new dimension = possible monitoring gap.
Post-deploy checklist: confirm metric appears in CloudWatch within 2 minutes.
Don't assume: verify. An alarm watching a metric that no longer exists catches nothing.

```

### 3 Most Expensive Mistakes

```

MISTAKE 1: NO BUSINESS METRIC ALARMS
Infrastructure: all green. CPU fine, memory fine, tasks running.
Meanwhile: payment processing failing at 15% because Stripe key expired.
Business metric (payments per minute = 0) would have caught this immediately.
Infrastructure metrics didn't.

MISTAKE 2: NOT SETTING ok_actions ON ALARMS
Alarm fires at 2am. Engineer wakes up, investigates, fixes the issue.
Error rate drops back to 0%. Alarm should return to OK state.
Without ok_action: no notification that the incident is resolved.
Engineer keeps staring at the dashboard for 20 minutes waiting to see it improve.
With ok_action: "RESOLVED: API error rate back to normal" → close incident.
Always set ok_actions = alarm_actions.

MISTAKE 3: MONITORING THE WRONG PERCENTILE
Team monitors P50 latency. P50 = 80ms. "Great performance!"
P99 latency = 12 seconds. 1% of users wait 12 seconds.
At 10,000 RPS: 100 users per second are experiencing a 12-second timeout.
Nobody knows because the monitored P50 looks excellent.
Monitor P99. Alert on P99. Fix P99.

```

### 30-Second Interview Answer

```

"For production monitoring I follow the Four Golden Signals:
latency at P99, traffic (requests per minute), error rate (5xx/total),
and saturation (CPU, memory, DB connections).

On AWS: ALB metrics for latency and errors, ECS metrics for saturation,
RDS metrics for database health, and custom EMF metrics for business KPIs
like orders and payments per minute.

I use composite alarms to reduce false positives, always set ok_actions
so I know when incidents resolve, and every alarm has a runbook URL in its description.

Monthly review: alarm-to-action rate. Any alarm firing without action gets tuned or removed.
Goal: MTTD under 1 minute, engineers woken only for real incidents."

(30 seconds. Covers fundamentals, AWS specifics, operational maturity.)

```

```
