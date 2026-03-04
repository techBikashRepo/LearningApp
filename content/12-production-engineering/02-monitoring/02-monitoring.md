# Monitoring

## SECTION 5 — Real World Example

> **Architect Training Mode** | Site Reliability Engineer Perspective
> _Incidents you WILL face, and exactly how to debug them using metrics._

---

### INCIDENT 01 — "Service Looks Fine" But Users Are Getting Errors

```
SYMPTOM:
  2:12am — PagerDuty fires: "API error rate > 1%"
  Engineer checks ECS console: 2 tasks running. Green.
  Engineer checks CloudWatch: CPUUtilization = 8%. Memory = 42%. Healthy.
  Engineer thinks: "Everything looks normal. False alarm?"

  Reality: 8% of requests are failing. Users are hitting errors.
  The ECS health check passes (it only tests /health endpoint).
  But payment processing is broken, not the /health endpoint.

ROOT CAUSE:
  ECS and ALB health checks test /health (shallow check).
  /health returns 200 as long as the process is alive.
  But the actual payment dependency (Stripe API) is unreachable.
  All payment requests fail. But the service "looks healthy."

DEBUGGING:
  Step 1: Don't look at ECS. Look at ALB error rate by TARGET GROUP.
    aws cloudwatch get-metric-statistics \
      --namespace AWS/ApplicationELB \
      --metric-name HTTPCode_Target_5XX_Count \
      --dimensions Name=TargetGroup,Value=<tg-arn> \
      --period 60 --statistics Sum \
      --start-time $(date -u -d '30 minutes ago' +%Y-%m-%dT%H:%M:%SZ) \
      --end-time $(date -u +%Y-%m-%dT%H:%M:%SZ)

    Result: HTTPCode_Target_5XX_Count = 84 in last 10 minutes.
    Not ECS infra. Application is returning 500s.

  Step 2: Logs Insights — what error?
    fields @timestamp, event, error.type, error.message, path
    | filter level = "ERROR"
    | stats count() as count by error.type, path
    | sort count desc

    Result: StripeConnectionError × 84, only on /api/payments/* paths.

  Step 3: Is this our fault or Stripe's?
    Check Stripe status page (bookmark: status.stripe.com).
    Result: Stripe degraded in us-east-1 since 2:09am.

  RESOLUTION:
    Not our service, not our infrastructure. Stripe is degraded.
    Action: enable fallback payment processor OR disable payment features with maintenance message.
    Alert: Notify customer support team about the degradation.
    Monitor: set up alarm that auto-recovers when error rate drops.

LESSON:
  Infrastructure looking healthy ≠ service working correctly.
  Monitor business-level metrics (payments processed per minute)
  not just infrastructure metrics (CPU/memory).

  Business KPI alarm: "payments per minute dropped > 80%" catches this instantly.
```

---

### INCIDENT 02 — Memory Leak → OOMKill → Crash Loop

```
SYMPTOM:
  Tuesday 9am: ECS service behaving normally.
  Tuesday 11am: P99 latency starts climbing. 500ms → 1.2s → 3s.
  Tuesday 12:30pm: Tasks start restarting. CloudWatch shows task count oscillating.
  Tuesday 12:45pm: P1 alarm fires. Multiple tasks OOMKilled simultaneously.
  Service degraded for 45 minutes before engineers notice the trend.

WHAT SHOULD HAVE CAUGHT THIS EARLIER:
  MemoryUtilization was climbing steadily since 9am.
  If alarm was set at 80% for 15 minutes: would have fired at ~10:30am.
  2 hours before the OOMKill. That's 2 hours to investigate before impact.

  Missing alarm: MemoryUtilization trend (steady growth is the warning signal).

DEBUGGING:
  # Memory trend in CloudWatch (look for the slope, not the peak):
  aws cloudwatch get-metric-statistics \
    --namespace AWS/ECS \
    --metric-name MemoryUtilization \
    --dimensions Name=ServiceName,Value=api Name=ClusterName,Value=prod \
    --period 300 --statistics Average \
    --start-time $(date -u -d '4 hours ago' +%Y-%m-%dT%H:%M:%SZ) \
    --end-time $(date -u +%Y-%m-%dT%H:%M:%SZ)

  # Result: 35% → 45% → 56% → 68% → 79% → 88% → OOMKill
  # Straight line growth = memory leak. Not a spike from traffic surge.

  # Find which version was deployed at 9am:
  aws ecs describe-services --cluster prod --services api \
    --query 'services[0].deployments'

  # Result: deployment at 8:47am. This version = the source.

IDENTIFYING THE LEAK:
  Container Insights (if enabled) shows memory per-task:
    # Which specific task ID had the highest memory?
    # Container Insights → ECS → Cluster: prod → Service: api → Tasks
    # Sort by memory → click highest → see memory usage over time

  Application-level: add memory metrics via EMF or Node.js process.memoryUsage():
    setInterval(() => {
      const mem = process.memoryUsage();
      metrics.putMetric('HeapUsed', mem.heapUsed / 1024 / 1024, 'Megabytes');
      metrics.putMetric('HeapTotal', mem.heapTotal / 1024 / 1024, 'Megabytes');
      metrics.putMetric('RSS', mem.rss / 1024 / 1024, 'Megabytes');
      metrics.flush();
    }, 30_000);  // emit every 30 seconds

RESOLUTION (immediate):
  Rollback the deployment from 8:47am.
  aws ecs update-service --cluster prod --service api \
    --task-definition api:PREVIOUS_REVISION

ROOT CAUSE INVESTIGATION (after recovery):
  heapUsed grows but never shrinks = objects held in memory not being garbage collected.
  Common causes:
    - Event listeners added but never removed (EventEmitter leak)
    - Caches (Map, Set, array) growing unbounded with no eviction
    - Closures holding references to large objects
    - Database result sets not released

  Use Node.js --inspect and heap snapshots in staging:
    node --inspect server.js
    Chrome DevTools → Memory → Heap Snapshot → compare snapshots 1 and 2 after load.
```

---

### INCIDENT 03 — RDS Storage Full → Database Stops Writing

```
SYMPTOM:
  No alarm. No proactive alert.
  3:15pm: Users report they cannot submit orders.
  3:16pm: Engineers check app → logs show INSERT queries failing.
  3:17pm: Error message: "ERROR: could not extend file: No space left on device"
  RDS FreeStorageSpace = 0 bytes. Database disk is full.
  All INSERT, UPDATE, DELETE operations fail immediately.
  SELECT queries still work. Read-only mode effectively.

TIME TO FILL: Database grew 800MB/day due to large JSONB blobs being stored in a table.
  Storage started at 100GB. Full after 125 days. No alarm was set.

WHAT SHOULD HAVE CAUGHT THIS:
  resource "aws_cloudwatch_metric_alarm" "rds_storage_low" {
    alarm_name          = "rds-prod-storage-low"
    namespace           = "AWS/RDS"
    metric_name         = "FreeStorageSpace"
    dimensions          = { DBInstanceIdentifier = "prod-postgres" }
    threshold           = 10737418240  # 10GB in bytes
    comparison_operator = "LessThanThreshold"
    evaluation_periods  = 2
    period              = 300
    statistic           = "Minimum"
    alarm_actions       = [aws_sns_topic.p1.arn]
    treat_missing_data  = "breaching"
  }
  # This would have fired 12 days before the outage at 800MB/day growth.

RESOLUTION (emergency):
  Step 1: Extend RDS storage immediately (no downtime required, but takes minutes to hours):
    aws rds modify-db-instance \
      --db-instance-identifier prod-postgres \
      --allocated-storage 200 \
      --apply-immediately

  Step 2: While waiting, buy time by deleting temporary/log data:
    -- Find largest tables:
    SELECT schemaname, tablename,
           pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size
    FROM pg_tables
    ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC
    LIMIT 10;

    -- VACUUM FULL if autovacuum has dead tuples:
    VACUUM FULL table_name;  -- reclaims space but locks the table
    VACUUM table_name;       -- non-blocking, marks space as reusable

ENABLE AUTO-SCALING STORAGE (prevents recurrence):
  resource "aws_db_instance" "main" {
    # ...
    max_allocated_storage = 500  # RDS will auto-scale up to 500GB
    # Once set, RDS auto-scales when free space < 10% of current allocation
    # Auto-scaling never scales down (only up).
  }
```

---

### INCIDENT 04 — Metric Not Appearing in CloudWatch (Missing Metrics)

```
SYMPTOM:
  Team sets up a new service. No alarms firing.
  Engineer assumes service is healthy because: no alarms.
  Service is actually erroring at 15% rate.
  The alarm was created but the metric never populated.

ROOT CAUSE:
  1. Namespace typo: alarm references "MyApp/Api" but EMF emits "MyApp/API"
     CloudWatch namespace is case-sensitive.

  2. Dimension mismatch: alarm filters by {Environment: "prod"}
     but application emits {Environment: "production"}
     No matching datapoints → INSUFFICIENT_DATA state → never fires.

  3. Service emitting metrics via SDK but hitting throttling limits:
     PutMetricData: 150 transactions/second/namespace
     If calling it 200 times/second: 25% of calls are throttled → metrics missing.
     Fix: batch PutMetricData (up to 20 metrics per call) or switch to EMF.

  4. IAM permission missing: task execution role lacks cloudwatch:PutMetricData

DEBUGGING:
  # Check alarm state:
  aws cloudwatch describe-alarms \
    --alarm-names "payment-error-rate" \
    --query 'MetricAlarms[0].StateValue'
  # If INSUFFICIENT_DATA: metric isn't arriving.

  # Check if the metric exists in CloudWatch at all:
  aws cloudwatch list-metrics \
    --namespace "MyApp/Payments" \
    --metric-name "ErrorCount"
  # If empty result: metric was never emitted.

  # Check IAM for PutMetricData permission:
  aws iam simulate-principal-policy \
    --policy-source-arn <task-execution-role-arn> \
    --action-names cloudwatch:PutMetricData

PREVENTION:
  Add deployment verification step:
    After deploy, wait 2 minutes, then check:
    1. Are log entries appearing in CloudWatch? (verify logging works)
    2. Is the error rate metric receiving datapoints? (verify metrics work)
    3. Is the alarm in OK state (not INSUFFICIENT_DATA)? (verify alarm is connected)

  Script:
    sleep 120
    STATE=$(aws cloudwatch describe-alarms \
      --alarm-names "$SERVICE-error-rate" \
      --query 'MetricAlarms[0].StateValue' --output text)
    if [ "$STATE" = "INSUFFICIENT_DATA" ]; then
      echo "WARNING: Alarm has no data. Metrics may not be emitting."
      exit 1
    fi
```

---

### The Debugging Toolkit

```bash
# ──────────────────────────────────────────────────────
# CLOUDWATCH METRICS — QUICK INSPECTION
# ──────────────────────────────────────────────────────

# Get ALB error rate for last 30 minutes:
aws cloudwatch get-metric-statistics \
  --namespace AWS/ApplicationELB \
  --metric-name HTTPCode_Target_5XX_Count \
  --dimensions Name=LoadBalancer,Value=<alb-arn-suffix> \
  --period 60 --statistics Sum \
  --start-time $(date -u -d '30 minutes ago' +%Y-%m-%dT%H:%M:%SZ) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%SZ)

# Get ECS service CPU and memory (last hour):
aws cloudwatch get-metric-statistics \
  --namespace AWS/ECS \
  --metric-name CPUUtilization \
  --dimensions Name=ServiceName,Value=api Name=ClusterName,Value=prod \
  --period 300 --statistics Average \
  --start-time $(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%SZ) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%SZ)

# Get RDS free storage (in bytes — divide by 1GB = 1073741824):
aws cloudwatch get-metric-statistics \
  --namespace AWS/RDS \
  --metric-name FreeStorageSpace \
  --dimensions Name=DBInstanceIdentifier,Value=prod-postgres \
  --period 300 --statistics Minimum \
  --start-time $(date -u -d '2 hours ago' +%Y-%m-%dT%H:%M:%SZ) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%SZ) \
  --query 'Datapoints[-1].Minimum'

# ──────────────────────────────────────────────────────
# ALARMS — STATUS
# ──────────────────────────────────────────────────────

# All alarms currently in ALARM state:
aws cloudwatch describe-alarms --state-value ALARM \
  --query 'MetricAlarms[*].{Name:AlarmName,Reason:StateReason,Since:StateUpdatedTimestamp}'

# History for a specific alarm (last 5 state changes):
aws cloudwatch describe-alarm-history \
  --alarm-name api-error-rate-CRITICAL \
  --history-item-type StateUpdate \
  --max-records 5

# ──────────────────────────────────────────────────────
# CONTAINER INSIGHTS — TASK-LEVEL METRICS
# ──────────────────────────────────────────────────────
# CloudWatch Logs Insights query in /aws/ecs/containerinsights/prod/performance:

fields TaskId, ContainerName, CpuUtilized, MemoryUtilized, StorageWriteBytes
| filter Type = "Container" and ServiceName = "api"
| sort MemoryUtilized desc
| limit 20

# ──────────────────────────────────────────────────────
# ECS — TASK STATUS
# ──────────────────────────────────────────────────────

# List stopped tasks (recently crashed) and their stop reason:
aws ecs list-tasks --cluster prod --service-name api --desired-status STOPPED \
  --query 'taskArns' --output text | \
  xargs aws ecs describe-tasks --cluster prod --tasks | \
  jq '.tasks[] | {taskId: .taskArn, stoppedAt: .stoppedAt, stoppedReason: .stoppedReason}'

# Common stoppedReason values:
#   "Essential container in task exited" → app crashed (check logs for why)
#   "Task failed container health checks" → health check failing → check /health endpoint
#   "OutOfMemoryError: Container killed due to memory usage" → OOMKill → memory leak
#   "CannotPullContainerError" → ECR login issue or image doesn't exist
```

## SECTION 6 — System Design Importance

The incident patterns above highlight key system design principles: design for failure, implement graceful degradation, enforce security boundaries at every layer, and monitor proactively. Each incident represents a production scenario that should inform your system design decisions.

## SECTION 7 — AWS & Cloud Mapping

AWS services directly relevant to these patterns: **ECS/Fargate** for container orchestration and task lifecycle management; **ECR** for secure image storage and scanning; **Secrets Manager / SSM Parameter Store** for runtime secret injection; **CloudWatch** for container metrics, logs, and alarms; **IAM** for fine-grained access control.

## SECTION 8 — Interview Preparation

**Beginner:**

**Q: What is the difference between logging and monitoring?**
**A:** Logging records discrete events ("user 123 logged in at 10:23"). Monitoring tracks continuous numerical measurements over time ("CPU is at 78%, response time P99 is 320ms, error rate is 0.2%"). Logs answer "what happened." Metrics answer "how is the system behaving right now and over time." You need both: logs for post-incident investigation, metrics for real-time health tracking and trending. Metrics trigger alerts (when CPU > 90% for 5 minutes, alert). Logs tell you why (which process consumed the CPU).

**Q: What are the "four golden signals" of monitoring?**
**A:** Google SRE Book identifies four metrics that tell you if your service is healthy: (1) *Latency:* how long do requests take? Track P50, P95, P99 â€” not just average. (2) *Traffic:* how much load is the system handling? (requests/sec, queries/sec). (3) *Errors:* what percentage of requests fail? Error rate = errors/total requests. (4) *Saturation:* how "full" is the system? CPU %, memory %, db connection pool %, disk usage %. If all four golden signals are healthy, your service is almost certainly healthy.

**Q: What is a CloudWatch Alarm and how does it work?**
**A:** A CloudWatch Alarm watches one metric and evaluates a condition over a time period. Configuration: metric (CPU utilization), threshold (> 90%), evaluation period (2 consecutive 5-minute periods). States: OK (below threshold), ALARM (threshold breached), INSUFFICIENT_DATA (not enough data). When state changes to ALARM: trigger an action â€” SNS notification â†’ email/Slack/PagerDuty. Good alarms: specific, actionable, and with a runbook ("when this alarm fires, do X"). Bad alarms fire constantly for non-actionable conditions (alert fatigue).

---

**Intermediate:**

**Q: What is the difference between P50, P95, and P99 latency percentiles, and why shouldn't you use average response time?**
**A:** Percentile tells you "X% of requests complete within N milliseconds." P50 = median (half of requests), P95 = 95% of requests, P99 = 99% of requests. Average is misleading: if 999 requests take 10ms and 1 request takes 10,000ms, average = 19.9ms but P99 = 10,000ms. That one slow user has a terrible experience. In production: alert on P99 latency (the worst 1% of users). E-commerce: if P99 checkout latency > 3s, 1% of checkout attempts take > 3 seconds â€” that's real lost revenue. Average would show 10ms and look fine.

**Q: What is the USE Method for infrastructure monitoring?**
**A:** USE = Utilization, Saturation, Errors â€” a framework for checking every resource in your infrastructure. For each resource (CPU, memory, disk, network, database connections): *Utilization:* what percentage of the resource is being used? (CPU 78%). *Saturation:* is work queuing up waiting for the resource? (connection pool queue depth). *Errors:* are there errors from this resource? (disk read errors, network packet drops). Applied systematically, USE analysis quickly narrows down bottlenecks. "My app is slow" â†’ check USE for every resource â†’ CPU: 30% OK; Memory: 90% PROBLEM â†’ investigate memory leak.

**Q: What is synthetic monitoring and how does it catch issues before users do?**
**A:** Synthetic monitoring runs automated scripts that simulate real user actions on your production system on a schedule (every 1 minute). A "canary" script: logs in, searches for a product, adds to cart, checks out. If it fails, you know before a real user tells you. Tools: AWS CloudWatch Synthetics, DataDog Synthetics, Pingdom. Critical user flows should have synthetic monitoring. Important: synthetics create real test data â€” your checkout synthetic may create 1,440 test orders per day. Use a dedicated test account or clean up after each run.

---

**Advanced (System Design):**

**Scenario 1:** Design a monitoring system for a payment processing service. Define exactly what metrics to track, what thresholds should trigger alerts, and what the on-call runbook should contain for each alert.

*Metrics + thresholds + runbooks:*

1. *Payment success rate < 98%* (5-min window): Runbook: Check Stripe/PayPal dashboard for provider errors. Check DB connection pool (max_connections in RDS). Check payment service ECS task health. Escalate to payment provider if their status page shows incidents.

2. *Payment P99 latency > 5s*: Runbook: Check RDS slow query log (CloudWatch Insights). Check external payment gateway latency. Check DB connection pool exhaustion (CloudWatch DB connections metric). Look for N+1 queries in APM.

3. *DLQ message count > 0* (SQS Dead Letter Queue): Runbook: Inspect dead-lettered messages in SQS console. Identify error pattern. Fix bug. Replay messages from DLQ to main queue.

4. *ECS task crash loop* (task count < desired count for 3 minutes): Runbook: ws ecs describe-tasks for exit code. Check CloudWatch Logs for crash reason. Roll back to previous task definition if bad deploy.

5. *Fraud detection rate > 2x baseline:* Runbook: Review flagged transactions manually. Check if legitimate campaign triggered abnormal patterns. Alert fraud team.

**Scenario 2:** Six months after launch, your engineering team has 200+ CloudWatch alarms. 60% are false positives. Engineers are ignoring alert emails. Design a process for cleaning up the alert system and maintaining quality going forward.

*Immediate cleanup:*
(1) Audit all 200 alarms: for each, answer "in the last 30 days, did this alarm fire? Did it result in an actionable response?" Tag three categories: CRITICAL (fires â†’ engineer takes action), NOISE (fires â†’ engineers ignore), STALE (hasn't fired in 90+ days, may be for decommissioned service).
(2) Delete/disable STALE immediately. Move NOISE to a separate low-priority channel (Slack #monitoring-noise), not PagerDuty.
(3) Review NOISE alarms: fix threshold, fix metric, or delete if truly not actionable.

*Ongoing governance:*
Monthly alert review in team retrospective: "which alarms woke someone up last month? Were they actionable?" Target: < 5 actionable pages/week, 0 non-actionable. New alarm PR template: must include "what action does an engineer take when this fires?" If no clear answer â†’ don't create it.

