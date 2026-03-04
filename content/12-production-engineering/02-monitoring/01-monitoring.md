# Monitoring

## FILE 01 OF 03 — Core Concepts, Metrics Architecture & AWS Tools

> **Architect Training Mode** | Site Reliability Engineer Perspective
> _You cannot fix what you cannot see. Monitoring is not optional — it's how you sleep at night._

---

## SECTION 1 — Intuition (Explain Like a 12-Year-Old)

```
WITHOUT MONITORING:
  User sends Slack message: "Hey, is the app down? I can't checkout."
  You open the app. It loads. "Looks fine to me."
  You check Twitter: 15 users complaining since 45 minutes ago.
  You open logs. CloudWatch has errors. Payment service has been failing for 47 minutes.
  MTTD: 47 minutes (user-reported). You had no idea.

WITH MONITORING:
  03:47 UTC — Payment service error rate crosses 1% threshold.
  03:47 UTC — CloudWatch Alarm fires.
  03:47 UTC — PagerDuty wakes on-call engineer.
  03:52 UTC — Engineer investigating. Root cause found.
  04:03 UTC — Fixed and deployed.
  MTTD: 0 minutes (automated). MTTR: 20 minutes.

MONITORING vs LOGGING vs TRACING:
  Monitoring (Metrics) — tells you SOMETHING IS WRONG (the alarm bell).
    "Error rate is 12% — this is above normal."
    Metrics are numbers over time. They don't explain WHY.

  Logging — tells you WHAT HAPPENED.
    "PoolExhaustedError: cannot acquire connection within 5000ms."
    Logs are events. They explain what the system did.

  Tracing — tells you WHERE IT WENT WRONG in the call chain.
    "Request went: API → Payment → FraudAPI (4.8s timeout) → DB wait."
    Traces show the journey of a single request across services.

  Production observability requires ALL THREE. Monitoring without logs = alarm with no clue.
  Logs without monitoring = incidents you find after users complain.
```

---

## SECTION 2 — Core Technical Explanation

```
Google SRE defined 4 metrics that, if monitored well, cover the majority of production issues.

SIGNAL 1: LATENCY — How long do requests take?
  Two types:
    Successful request latency: what is the normal experience?
    Failed request latency: are errors fast-fails or slow timeouts?
  Why it matters: a service timing out at 30s is worse than a service failing fast at 50ms.
  Percentiles:
    P50 (median): half of requests are faster than this.
    P95: 95% of requests are faster — represents "most users."
    P99: only 1% are slower — but if P99 = 10s, 1 in 100 users hits a 10-second request.
    P99.9 (P999): rarely used, but matters for high-traffic services.

  TRAP: Never use average latency. Average hides spikes.
    P50=100ms, P99=8000ms → average will look like ~250ms. "Average is fine!" But 1% = 8 seconds.

  AWS metric: ALB TargetResponseTime (P50, P95, P99 all available).
  Good thresholds for a REST API:
    P50 < 100ms | P95 < 500ms | P99 < 2000ms
    Alert: P99 > 2000ms for 5 consecutive minutes → P2

SIGNAL 2: TRAFFIC — How much load is the system handling?
  Measures demand on the system.
  HTTP services: requests per second (RPS).
  DB: queries per second (QPS).
  Queue: messages per second enqueued/dequeued.

  Why it matters:
    Sudden traffic spike → could explain high latency or errors.
    Traffic drop to 0 → scarier than a spike (service unreachable? upstream died?).

  AWS metric: ALB RequestCount per minute.
  Useful query: Traffic now vs same time last week (CloudWatch math).

SIGNAL 3: ERRORS — How many requests are failing?
  Error rate = failed requests / total requests × 100%.
  Types:
    Explicit: HTTP 500, 503, connection refused.
    Implicit: HTTP 200 but the response body says {"success": false}.
    Timeout: requests that take too long (no explicit error code).

  AWS metric: ALB HTTPCode_Target_5XX_Count / RequestCount.
  Target error rate: < 0.1% for stable production.
  Alert levels:
    > 0.5%: P3 Slack notification
    > 1%:   P2 PagerDuty (business hours)
    > 5%:   P1 PagerDuty (immediate, 24/7)

SIGNAL 4: SATURATION — How full is the system?
  Most constrained resource that will fail first:
    CPU: task throttled → slow responses
    Memory: container OOMKilled → crash loop
    DB connections: pool exhausted → 500 errors immediately
    Disk: ECS cannot write logs or tmpfiles → silent failures

  AWS metrics: ECS CPUUtilization, MemoryUtilization per cluster/service.
  Saturation warning: alert at 70% to act BEFORE failure at 100%.
  DB connections: custom metric from application or via RDS enhanced monitoring.
```

---

## SECTION 3 — Architecture Diagram (MANDATORY)

```
HOW CLOUDWATCH METRICS WORK:

  Data Source → CloudWatch Metrics API → Stored Datapoints
    Every 1 minute (standard) or 1 second (high-resolution, costs more).
    Datapoints retained:
      3 hours: 1-second resolution
      15 days: 1-minute resolution
      63 days: 5-minute resolution
      455 days: 1-hour resolution
    After 455 days: datapoints are gone. Archive to S3 if you need longer.

  METRIC ANATOMY:
    Namespace: logical grouping. AWS/ECS, AWS/RDS, AWS/ApplicationELB, MyApp/Services.
    Metric Name: CPUUtilization, RequestCount, ErrorCount.
    Dimensions: filter to specific resource. {ServiceName: "api", ClusterName: "prod"}.
    Value: the number at this timestamp.
    Unit: Percent, Count, Milliseconds, Bytes.

  CUSTOM METRICS (emit from your application):
    Use AWS SDK to push custom metrics:

    import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch'
    const cw = new CloudWatchClient({ region: 'us-east-1' });

    // Emit a metric for a successful payment:
    await cw.send(new PutMetricDataCommand({
      Namespace: 'MyApp/Payments',
      MetricData: [{
        MetricName: 'PaymentProcessed',
        Value: 1,
        Unit: 'Count',
        Dimensions: [
          { Name: 'Environment', Value: 'production' },
          { Name: 'Currency', Value: req.body.currency }
        ]
      }]
    }));

    COST: first 10 custom metrics free, then $0.30/metric/month.

  EMBEDDED METRIC FORMAT (EMF) — preferred for high-volume:
    Instead of SDK calls, embed metric in structured logs.
    CloudWatch Logs automatically extracts them into metrics.
    Cost: PutLogEvents (cheap) instead of PutMetricData (more expensive).
    No additional API calls from application.

    const { createMetricsLogger } = require('aws-embedded-metrics');
    const metrics = createMetricsLogger();
    metrics.setNamespace('MyApp/Payments');
    metrics.putDimensions({ Environment: 'production' });
    metrics.putMetric('PaymentLatency', processingTimeMs, 'Milliseconds');
    metrics.putMetric('PaymentSuccess', 1, 'Count');
    await metrics.flush();  // writes structured log → CloudWatch extracts metrics
```

---

## SECTION 4 — Request Flow (MANDATORY FLOWCHART)

```
ALB (Application Load Balancer) — Front door metrics:
  Metric                           | Threshold Alert
  ─────────────────────────────────────────────────────
  RequestCount                     | Drop to 0 = service unreachable P1
  HTTPCode_ELB_5XX_Count           | > 10/min = P2
  HTTPCode_Target_5XX_Count        | > 50/min = P1
  TargetResponseTime P99           | > 2000ms = P2
  HealthyHostCount                 | < 1 = P1 (no healthy targets!)
  UnHealthyHostCount               | > 0 = P2 (tasks failing health checks)
  ActiveConnectionCount            | sudden drop = upstream issue

  Why HealthyHostCount matters:
    If all ECS tasks fail their ALB health check: ALB stops routing traffic.
    502 Bad Gateway to every user. MTTD = 0 (alarm). But without this alarm:
    users get 502, you get user reports.

ECS (Fargate tasks) — Compute metrics:
  Metric                           | Threshold Alert
  ─────────────────────────────────────────────────────
  CPUUtilization (service)         | > 70% for 15min = P2 (scale before throttle)
  MemoryUtilization (service)      | > 80% for 5min = P2 (OOMKill risk)
  RunningTaskCount                 | below desired count = P1

  CRITICAL: RunningTaskCount < DesiredTaskCount is a P1.
    Means tasks are crash-looping, OOMKilled, or failing to start.
    The service is running below capacity or completely down.

  Custom ECS alarm for task count:
    resource "aws_cloudwatch_metric_alarm" "ecs_tasks_low" {
      alarm_name  = "payment-service-task-count-low"
      namespace   = "AWS/ECS"
      metric_name = "RunningTaskCount"
      dimensions  = { ClusterName = "prod", ServiceName = "payment" }
      threshold           = 1   # alert if fewer than 1 task running
      comparison_operator = "LessThanThreshold"
      evaluation_periods  = 1
      period              = 60
      statistic           = "Minimum"  # not Average — use Minimum!
      alarm_actions       = [aws_sns_topic.p1.arn]
    }
    # Note: always use Minimum, never Average.
    # Average of 2 tasks and 0 tasks = 1 → doesn't trigger threshold of 1.

RDS PostgreSQL — Database metrics:
  Metric                           | Threshold Alert
  ─────────────────────────────────────────────────────
  CPUUtilization                   | > 80% for 5min = P2
  FreeableMemory                   | < 256MB = P2
  DatabaseConnections              | > 80% of max_connections = P2
  FreeStorageSpace                 | < 10% = P1 (DB will stop accepting writes)
  ReadLatency                      | > 20ms = P2
  WriteLatency                     | > 10ms = P2
  DiskQueueDepth                   | > 1 sustained = P2 (I/O bottleneck)

  FreeStorageSpace = 0 is a catastrophic event:
    PostgreSQL stops accepting any writes.
    Every INSERT/UPDATE/DELETE fails.
    App returns 500s for all mutation operations.
    Read queries still work. Users can view data but not change anything.
    Recovery: immediately extend storage. In RDS: auto-scaling storage or manual increase.

APPLICATION (custom metrics via EMF):
  PaymentsProcessed per minute    | drop to 0 = P1 (business KPI, not just technical)
  PaymentFailureRate              | > 0.5% = P2
  UserRegistrations per hour      | drop > 90% = P2 (possible auth service issue)
  QueueDepth (SQS)               | > 1000 messages growing = P2 (consumer stuck)
  EmailsQueued vs Sent           | growing gap = P2 (email worker down)
```

---

### CloudWatch Dashboards

```
ARCHITECTURE: One dashboard per environment per layer.

DASHBOARD 1: Executive/Business (no AWS knowledge needed)
  Widgets:
    Orders per hour (line graph, last 24h vs same time last week)
    Payment success rate % (large number widget, should be > 99.5%)
    Active users (line graph)
    Revenue per hour (custom metric)

  Who uses this: Product, CEO, stakeholder check during incidents.
  Refresh: auto-refresh every 1 minute.

DASHBOARD 2: Operations (on-call engineer — bookmark this)
  Widgets (one row per service):
    ALB: Request rate | Error rate | P99 latency
    ECS-API: CPU% | Memory% | Running tasks
    ECS-Payment: CPU% | Memory% | Running tasks
    RDS: CPU% | DB connections | Free storage | Read/Write latency
    Active alarms list widget

  Time range default: last 3 hours. Zooming in to last 30 min shows incident start.

DASHBOARD 3: Deep-Dive (debugging during incidents)
  Service-specific metrics, Logs Insights query widgets, X-Ray insights.

TERRAFORM DASHBOARD (Infrastructure as Code):
  resource "aws_cloudwatch_dashboard" "operations" {
    dashboard_name = "production-operations"
    dashboard_body = jsonencode({
      widgets = [
        {
          type   = "metric"
          width  = 8
          height = 6
          properties = {
            title   = "ALB Error Rate"
            metrics = [
              ["AWS/ApplicationELB", "HTTPCode_Target_5XX_Count",
               "LoadBalancer", var.alb_arn_suffix, { stat = "Sum", period = 60 }],
              ["AWS/ApplicationELB", "RequestCount",
               "LoadBalancer", var.alb_arn_suffix, { stat = "Sum", period = 60, id = "req" }]
            ]
            view   = "timeSeries"
            period = 60
          }
        }
      ]
    })
  }

CLOUDWATCH METRIC MATH (calculate error rate % in dashboard):
  For a metric expression widget:
  Expression: (errors / requests) * 100

  metrics:
    id: e1  →  HTTPCode_Target_5XX_Count (Sum)
    id: r1  →  RequestCount (Sum)
    id: rate  →  Expression: "(e1/r1)*100"
    label: "Error Rate %"
```

---

### CloudWatch Alarms

```
ALARM STATES:
  OK       — metric is within threshold. All good.
  ALARM    — metric has breached threshold. Something needs attention.
  INSUFFICIENT_DATA — not enough data yet. New alarm, or metric stopped arriving.

EVALUATION PERIODS:
  evaluation_periods = 3, period = 60 means:
    3 consecutive 60-second windows must ALL breach threshold before alarm fires.
    Prevents single-spike false alarms.
    Total time before alarm: 3 minutes.

  For P1 alarms: lower is better (1-2 periods). Speed matters.
  For P2 alarms: 3-5 periods reduces false positives.

TREAT MISSING DATA:
  treat_missing_data = "notBreaching":
    Missing data is treated as OK. Alarm won't fire during maintenance windows.
    Risk: if service dies and stops emitting metrics → alarm doesn't fire.

  treat_missing_data = "breaching":
    Missing data = alarm fires. Catches services that stop emitting entirely.
    Risk: more false positives during deploys, startups.

  treat_missing_data = "ignore":
    Missing periods don't count. Alarm only fires on actual bad values.

  For "service completely down" alarms: use "breaching".
    Why: service crash = no metrics = treat as problem.
  For latency/error rate alarms: use "notBreaching" or "ignore".
    Why: during deploy, some windows have no data — shouldn't alarm.

ALARM ON A MATH EXPRESSION:
  # Calculate error rate % and alarm on it:
  resource "aws_cloudwatch_metric_alarm" "error_rate_pct" {
    alarm_name = "api-error-rate-percent"

    metric_query {
      id          = "e1"
      return_data = false
      metric {
        namespace   = "AWS/ApplicationELB"
        metric_name = "HTTPCode_Target_5XX_Count"
        period      = 60
        stat        = "Sum"
        dimensions  = { LoadBalancer = var.alb_arn_suffix }
      }
    }
    metric_query {
      id          = "r1"
      return_data = false
      metric {
        namespace   = "AWS/ApplicationELB"
        metric_name = "RequestCount"
        period      = 60
        stat        = "Sum"
        dimensions  = { LoadBalancer = var.alb_arn_suffix }
      }
    }
    metric_query {
      id          = "rate"
      expression  = "(e1 / r1) * 100"
      label       = "Error Rate %"
      return_data = true
    }

    comparison_operator = "GreaterThanThreshold"
    threshold           = 5       # > 5% error rate
    evaluation_periods  = 3
    alarm_description   = "P1: API error rate > 5%. Runbook: https://wiki/runbooks/api-errors"
    alarm_actions       = [aws_sns_topic.p1.arn]
    ok_actions          = [aws_sns_topic.p1.arn]
  }
```

---

### Production Readiness Checklist

```
METRICS COLLECTION
  [ ] ALB access logs enabled (stored to S3 for Athena analysis)
  [ ] ECS Container Insights enabled (per-service CPU/memory per task)
  [ ] RDS Enhanced Monitoring enabled (1-second granularity)
  [ ] Custom EMF metrics for business KPIs (orders/payments/users per minute)
  [ ] Application-level metrics: error rate, latency P99, queue depth

DASHBOARDS
  [ ] Operations dashboard bookmarked by all on-call engineers
  [ ] Dashboard includes: all 4 golden signals per service
  [ ] Business KPI dashboard accessible to non-technical stakeholders
  [ ] Dashboard auto-refreshes during incidents (60s or 10s intervals)

ALARMS (per service)
  [ ] Error rate > 5% → P1 alarm
  [ ] P99 latency > 2s → P2 alarm
  [ ] RunningTaskCount < desired → P1 alarm
  [ ] RDS FreeStorageSpace < 10% → P1 alarm
  [ ] RDS DatabaseConnections > 80% max → P2 alarm
  [ ] ALB HealthyHostCount = 0 → P1 alarm
  [ ] Every alarm has runbook URL in description
  [ ] Every alarm has ok_action (notify when resolved)

COST
  [ ] CloudWatch cost budget alert at 150% of baseline
  [ ] High-resolution metrics only where needed (1-min standard is usually enough)
  [ ] Container Insights: enabled only for prod (not dev/staging where cost matters)
```
