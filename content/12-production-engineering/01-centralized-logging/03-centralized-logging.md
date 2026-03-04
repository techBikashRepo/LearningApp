# Centralized Logging

## FILE 03 OF 03 — Design Decisions, Alerting, Runbooks & Architect's Mental Model

> **Architect Training Mode** | Site Reliability Engineer Perspective
> _How to make decisions, define alerting strategy, write runbooks, and answer in interviews._

---

## SECTION 9 — Certification Focus (AWS SAA-C03)

### Decision 1: Which Logging Platform?

```
CLOUDWATCH LOGS (Default AWS choice):
  ✅ Zero setup: ECS + awslogs driver = working in 5 minutes
  ✅ No infra to manage. Scales automatically.
  ✅ Native integration: X-Ray, Alarms, Dashboards, Lambda, all in same console
  ✅ IAM-based access control without extra configuration
  ✅ Logs Insights queries are fast for structured JSON
  ❌ Query language less powerful than Elasticsearch/Loki
  ❌ Cost can surprise at high volume (DEBUG in prod = expensive fast)
  ❌ Cross-account/cross-region log correlation requires extra setup
  ❌ Retention limited to 24 months max (archive to S3 for longer)
  CHOOSE WHEN: AWS-native stack, small-medium scale, don't want to manage tools.

ELK STACK (Elasticsearch + Logstash + Kibana):
  ✅ Extremely powerful queries, full-text search, aggregations
  ✅ Kibana dashboards are richer than CloudWatch
  ✅ Good for compliance/security log analysis (SIEM use cases)
  ❌ Significant infrastructure: self-hosted Elasticsearch clusters are expensive
  ❌ Operational burden: backups, upgrades, capacity planning, reindexing
  ❌ Elasticsearch can fail dramatically on heap exhaustion
  CHOOSE WHEN: AH heavy log analysis requirements, security team driving infra.

GRAFANA LOKI:
  ✅ "Like Prometheus, but for logs" — same labels/selectors model as Prometheus
  ✅ Much cheaper than Elasticsearch: doesn't index content, indexes labels only
  ✅ Tight Grafana integration: logs, metrics, traces in one dashboard
  ✅ Popular with Kubernetes (Promtail sidecar)
  ❌ No full-text search: you must filter by label then grep the content
  ❌ Self-hosted Loki requires operational expertise
  CHOOSE WHEN: Kubernetes-based systems, already using Prometheus+Grafana.

DATADOG / GRAFANA CLOUD (SaaS):
  ✅ Unified platform: logs + metrics + traces + APM + dashboards
  ✅ Zero infrastructure management
  ✅ Superior correlation (click from a trace to the log entry automatically)
  ✅ ML-based anomaly detection out of the box
  ❌ Expensive at scale ($0.10/GB/month vs CloudWatch $0.50/GB ingest but Datadog adds retention fees)
  ❌ Vendor lock-in: migrating away is painful
  ❌ IP/data leaves AWS (important for compliance-heavy industries)
  CHOOSE WHEN: fast-growing startup willing to pay for DX, or enterprise budget.

DECISION MATRIX:
  Stage                 | Choice
  ─────────────────────────────────────────────────────
  MVP / early startup   | CloudWatch (default ECS config)
  Growing product       | CloudWatch + X-Ray
  Multi-service/complex | CloudWatch + FireLens for routing + Datadog for APM
  Kubernetes stack      | Loki + Grafana + Tempo (all open source)
  Enterprise/compliance | Datadog or Sumo Logic with SLA guarantees
```

### Decision 2: Direct awslogs vs Fluent Bit FireLens

```
RULE: Start with awslogs. Add FireLens only when you need routing.

DIRECT AWSLOGS (start here):
  How it works:
    ECS task → stdout → awslogs driver → CloudWatch
    Built into Docker. Zero sidecar. Zero complexity.

  Task definition logConfiguration:
    {
      "logDriver": "awslogs",
      "options": {
        "awslogs-group": "/ecs/api-prod",
        "awslogs-region": "us-east-1",
        "awslogs-stream-prefix": "ecs",
        "awslogs-create-group": "true",
        "mode": "non-blocking",
        "max-buffer-size": "25m"
      }
    }

  When this is enough: single destination (CloudWatch), simple architecture.

FLUENT BIT FIRELENS (add when scaling):
  How it works:
    App container → stdout → FireLens sidecar (Fluent Bit) → multiple destinations
    The sidecar intercepts all stdout before CloudWatch.

  Use cases that justify the added complexity:
    • Multi-destination: send errors to Datadog AND all logs to S3
    • Transform logs: add fields, parse, redact before storage
    • Different retention: send DEBUG to S3 Glacier (cheap), ERROR to CloudWatch (queryable)
    • Cost optimization: filter out health check logs before CloudWatch (saves $$$)

  ECS task definition (container definition):
    {
      "name": "log_router",
      "image": "public.ecr.aws/aws-observability/aws-for-fluent-bit:stable",
      "essential": true,
      "firelensConfiguration": {
        "type": "fluentbit",
        "options": { "enable-ecs-log-metadata": "true" }
      }
    }

  App container log config with FireLens:
    {
      "logDriver": "awsfirelens",
      "options": {
        "Name": "cloudwatch_logs",
        "region": "us-east-1",
        "log_group_name": "/ecs/api-prod",
        "log_stream_prefix": "ecs/"
      }
    }

COST OPTIMIZATION WITH FIRELENS (Advanced):
  # fluent-bit.conf — filter out health check noise before CloudWatch:
  [FILTER]
    Name    grep
    Match   *
    Exclude path /health

  [FILTER]
    Name    grep
    Match   *
    Exclude path /metrics

  [FILTER]
    Name    grep
    Match   *
    Exclude level "debug"   # block DEBUG from expensive CloudWatch

  # Send filtered logs to CloudWatch (reduced volume = lower cost)
  [OUTPUT]
    Name              cloudwatch_logs
    Match             *
    region            us-east-1
    log_group_name    /ecs/api-prod

  # But send ALL logs (including debug) to S3 for cheap long-term storage:
  [OUTPUT]
    Name              s3
    Match             *
    bucket            my-logs-archive
    region            us-east-1
    s3_key_format     /logs/api-prod/%Y/%m/%d/%H/$UUID.gz
    compression       gzip
```

### Decision 3: Log Retention Strategy

```
Principle: retention = compliance requirements + query needs + cost budget

Environment + Log Type  | Retention (CloudWatch) | Archive (S3)
─────────────────────────────────────────────────────────────────
prod / ERROR/WARN        | 90 days               | 1 year S3 Standard
prod / INFO              | 30 days               | 90 days S3 IA
prod / DEBUG             | NEVER (blocked)       | Never
staging                  | 7 days                | None
development              | 3 days                | None
security/audit logs      | 1 year (legal req)    | 7 years S3 Glacier

CloudWatch cost:  $0.50/GB ingest  +  $0.03/GB/month storage
S3 Standard:      $0.023/GB/month
S3 IA:            $0.0125/GB/month
S3 Glacier:       $0.004/GB/month

90 days of 100GB/day production logs:
  CloudWatch:  100GB × 90 × $0.03 = $270/month storage
             + 100GB × 90 days × $0.50 = $4,500 ingest total

  After 30 days: archive to S3 IA and expire from CloudWatch:
  CloudWatch (30 days only): $45 ingest + $30 storage = $75/month
  S3 IA (30-90 days archive): 60 × 100GB × $0.0125 = $75/month
  Total: $150/month  (vs $270+ staying in CloudWatch)

Terraform retention policy:
  resource "aws_cloudwatch_log_group" "api_prod" {
    name              = "/ecs/api-prod"
    retention_in_days = 30
    tags = {
      Environment = "production"
      ManagedBy   = "terraform"
    }
  }

  # S3 lifecycle rule to transition to Glacier after 90 days:
  resource "aws_s3_bucket_lifecycle_configuration" "logs" {
    bucket = aws_s3_bucket.logs.id
    rule {
      id     = "log-archive-lifecycle"
      status = "Enabled"
      transition {
        days          = 90
        storage_class = "GLACIER"
      }
      expiration {
        days = 2555  # 7 years for compliance
      }
    }
  }
```

---

## SECTION 10 — Comparison Table

### Complete Alerting Architecture

```
FLOW:
  CloudWatch Metric Filter
    → CloudWatch Alarm (threshold breach)
      → SNS Topic
        → Lambda (severity router)
          → PagerDuty (P1/P2)  OR  Slack (P3/P4)

COMPONENT 1: Metric Filter (extract metric from logs)
  Captures log patterns → increments a CloudWatch metric.

  resource "aws_cloudwatch_log_metric_filter" "error_rate" {
    name           = "api-error-count"
    log_group_name = aws_cloudwatch_log_group.api_prod.name
    pattern        = "{ $.level = \"ERROR\" }"
    metric_transformation {
      name      = "ErrorCount"
      namespace = "MyApp/API"
      value     = "1"
      default_value = "0"
    }
  }

COMPONENT 2: CloudWatch Alarm (threshold trigger)

  resource "aws_cloudwatch_metric_alarm" "api_error_rate_critical" {
    alarm_name          = "api-error-rate-CRITICAL"
    comparison_operator = "GreaterThanThreshold"
    evaluation_periods  = 3          # must breach 3 consecutive periods
    period              = 60         # 60-second evaluation windows
    metric_name         = "ErrorCount"
    namespace           = "MyApp/API"
    threshold           = 50         # > 50 errors per minute for 3 consecutive minutes
    statistic           = "Sum"
    alarm_description   = "P1: API error rate critical. Runbook: https://wiki/runbooks/api-errors"
    alarm_actions       = [aws_sns_topic.alerts_p1.arn]
    ok_actions          = [aws_sns_topic.alerts_p1.arn]  # alert when RESOLVED too

    # Prevent alarm oscillation (don't alarm again during in-progress investigation):
    treat_missing_data = "notBreaching"  # missing data = NOT alarming
  }

COMPONENT 3: SNS + Lambda Severity Router

  # Lambda function: routes based on alarm name convention:
  export const handler = async (event) => {
    const alarm = JSON.parse(event.Records[0].Sns.Message);
    const severity = alarm.AlarmName.includes('CRITICAL') ? 'P1'
                   : alarm.AlarmName.includes('HIGH')     ? 'P2'
                   : 'P3';

    if (severity === 'P1' || severity === 'P2') {
      await sendToPagerDuty(alarm, severity);
    }

    // All severities get Slack:
    await sendToSlack(alarm, severity);
  };

COMPOSITE ALARM (avoid false positives from a single spike):

  # Fire only if BOTH error rate AND latency are high simultaneously.
  # Reduces false pages by 60-80%.
  resource "aws_cloudwatch_composite_alarm" "api_degraded" {
    alarm_name = "api-degraded-composite"
    alarm_rule = "ALARM(${aws_cloudwatch_metric_alarm.error_rate.alarm_name}) AND ALARM(${aws_cloudwatch_metric_alarm.latency_p99.alarm_name})"
    alarm_actions = [aws_sns_topic.pagerduty_p2.arn]
    alarm_description = "P2: Both error rate elevated AND latency P99 high. Likely real degradation."
  }

ANOMALY DETECTION ALARM (dynamic baseline, far better than fixed thresholds):

  resource "aws_cloudwatch_metric_alarm" "error_anomaly" {
    alarm_name          = "api-error-rate-ANOMALY"
    comparison_operator = "GreaterThanUpperThreshold"
    evaluation_periods  = 2
    threshold_metric_id = "e1"    # references the anomaly detection band
    alarm_description   = "Error rate outside normal range (anomaly detection)"
    alarm_actions       = [aws_sns_topic.alerts_p2.arn]

    metric_query {
      id          = "e1"
      expression  = "ANOMALY_DETECTION_BAND(m1, 2)"
      label       = "ErrorRate (expected)"
      return_data = "true"
    }
    metric_query {
      id          = "m1"
      return_data = "false"
      metric {
        metric_name = "ErrorCount"
        namespace   = "MyApp/API"
        period      = 120
        stat        = "Sum"
      }
    }
  }
  # Benefit: 2am Sunday should NOT trigger the same threshold as 2pm Monday.
  # CloudWatch learns your traffic patterns. Anomaly detection band adjusts automatically.
```

---

## SECTION 11 — Quick Revision

### Runbook Structure (Required Fields)

```
Every runbook must answer these questions before an engineer is paged:

HEADER:
  Title: [Service Name] — [Specific Issue]
  Severity: P1 / P2 / P3
  Owner: Platform Team / Backend Team / etc.
  Last Updated: YYYY-MM-DD
  Trigger: which alarm fires this runbook?

BODY:
  1. WHAT IS THIS ALERT?
     One paragraph. Non-technical explanation. What broke from the user's perspective.

  2. IMPACT
     Who is affected. How many users. What functionality is degraded.

  3. DASHBOARD LINKS
     Bookmark. No searching during incidents.

  4. DIAGNOSIS (numbered steps, run these in order)
     Each step: command to run + what to look for + what it means.

  5. RESOLUTION OPTIONS
     Option A: (fastest, temporary fix) — do this first if unsure.
     Option B: (permanent fix if root cause is X)
     Option C: (escalation path if A and B don't resolve)

  6. ESCALATION
     When to escalate: if not resolved after N minutes.
     Who to call: on-call rotation link.

  7. KNOWN FALSE POSITIVES
     If this alarm fires harmlessly during [scheduled task at 3am] — verify by checking X.
```

### Example Runbook: High Error Rate

```markdown
# API — High Error Rate

**Severity:** P1 if > 5%, P2 if 1-5%
**Owner:** Platform Team
**Alarm:** api-error-rate-CRITICAL or api-error-rate-HIGH
**Last Updated:** 2024-01-15

---

## What is this alert?

The API is returning more HTTP 500 errors than normal.
Users may be seeing "Something went wrong" messages.
Payment and booking flows are most likely affected.

## Impact

~{ErrorRate}% of all API requests are failing.
Estimated: {RPS × ErrorRate} users per minute affected.

## Dashboards

- [Production Overview](https://us-east-1.console.aws.amazon.com/cloudwatch/home#dashboards:name=MyApp-Prod)
- [X-Ray Service Map](https://us-east-1.console.aws.amazon.com/xray/home#/service-map)
- [ECS Services](https://us-east-1.console.aws.amazon.com/ecs/v2/clusters/prod/services)

---

## Diagnosis

### Step 1: Confirm the error rate (30 seconds)

Check the Production Overview dashboard.

- Which service has elevated errors? (api / payment / auth / downstream?)
- When did it start? (gradual climb = capacity, sudden spike = deployment/config)

### Step 2: Get the error pattern (2 minutes)

Run in CloudWatch Logs Insights (time range: last 15 minutes):
```

fields @timestamp, error.type, error.message, path
| filter level = "ERROR"
| stats count() as count by error.type, error.message
| sort count desc
| limit 10

````
What is the #1 error type?
- PoolExhaustedError → proceed to Step 4a
- ConnectionRefused → proceed to Step 4b
- TimeoutError → proceed to Step 4c
- ValidationError → proceed to Step 4d

### Step 3: Check recent deployments (1 minute)
```bash
aws ecs describe-services --cluster prod --services api \
  --query 'services[0].deployments'
````

Was there a deployment in the last 30 minutes? → most likely cause. Rollback (Step 5a).

### Step 4a: PoolExhaustedError (DB connection pool)

Get slow query pattern:

```
fields event, duration_ms
| filter service = "api" and duration_ms > 2000
| stats avg(duration_ms), count() by event
| sort avg(duration_ms) desc
```

If one query is slow: check RDS Performance Insights for long-running queries.
If pool exhausted across all queries: downstream service holding connections is slow.
→ Resolution Option B (increase pool size short-term) or Option D (fix slow query).

### Step 4b: ConnectionRefused

Service trying to connect to something that's not listening.

```bash
# Check if RDS is accessible:
aws rds describe-db-instances --db-instance-identifier prod-postgres \
  --query 'DBInstances[0].DBInstanceStatus'
# Should return "available"
```

### Step 5a: Rollback (fastest path)

```bash
# Get previous task definition revision number:
PREV_REVISION=$(aws ecs describe-task-definition --task-definition api \
  --query 'taskDefinition.revision' --output text)
ROLLBACK_REVISION=$((PREV_REVISION - 1))

aws ecs update-service --cluster prod --service api \
  --task-definition api:$ROLLBACK_REVISION
```

Wait 3 minutes. Check error rate. Should drop to < 0.1%.

---

## Known False Positives

- **3:00am UTC every Sunday**: batch job causes 2-3 minutes of elevated errors.
  Verify: logs will show `event: "batch_migration_lock_timeout"`. Safe to wait.
- **After midnight deploys**: first 2 minutes always show elevated errors (health check timing).
  Verify: errors should drop below threshold by minute 3. If not → real issue.

```

---

## SECTION 12 — Architect Thinking Exercise

```

TRAP 1: "Just use console.log()"
What students think: console.log works, structured logging is over-engineering.
Why it fails in production: - console.log("user:", user) logs the entire user object including PII - No log levels → can't filter noise from important events - No standard fields → can't correlate across services - console.log is synchronous → blocks event loop under load
Reality: Pino at INFO level with redact is production minimum.

TRAP 2: "CloudWatch stores logs forever by default"
Truth: Yes, forever — but it COSTS $0.03/GB/month forever.
1TB of logs × 3 years = $1,080/year just in storage, before ingest costs.
Always set retention_in_days in every log group.

TRAP 3: "Logs are enough for observability"
Logs answer WHAT. Without metrics = no trend detection. Without traces = no WHERE.
Production systems need logs + metrics + traces (the three pillars).
A bug that causes no log errors but increases P99 latency by 10x = invisible with logs only.

TRAP 4: "awslogs mode: blocking is fine"
Truth: blocking mode means if CloudWatch is slow → your app is slow.
CloudWatch has throttling limits. During high log volume: throttled.
App log writes block → all threads waiting → cascading timeouts → full outage.
ALWAYS use mode: "non-blocking".

TRAP 5: "X-Ray traces everything"
Default sampling: 5 requests/second + 5% of the rest.
At 1000 RPS: 5 + 49.75 = ~55 traces/second = 5.5% sampling.
94.5% of requests are NOT traced by default.
Adjust sampling rules: 100% for payment, 0% for /health, 10% for everything else.

TRAP 6: "Structured logging is just JSON"
Structured logging requires CONSISTENT FIELDS across all services.
If service A uses "errorType" and service B uses "error.type" and service C uses "err_type":
You cannot query across services. Each team needs to conform to a shared schema.
Build a shared logging library that enforces the schema, rather than each service inventing fields.

TRAP 7: "CloudWatch Logs Insights is slow because CloudWatch is slow"
Truth: Logs Insights is fast when queries are structured correctly.
Unstructured log search is slow: | filter @message like /error/ (regex on raw string)
Structured field filter is fast: | filter level = "ERROR" (index lookup)
Always use structured JSON logging + field-based filters.

TRAP 8: "Add a log line for every function call"
Over-logging problems: - Doubles or triples log volume = cost multiplier - More noise = take longer to find signal during incidents - DEBUG/TRACE everywhere in production = 10-50x cost
Rule: Log at boundaries — request in, response out, external calls. Not every internal function.

```

---

### Interview Q&A

```

Q1: "Describe your logging architecture for a production microservices system on AWS."

A: "At the application layer, services use pino structured JSON logging with standard fields:
timestamp, level, service name, version, trace ID, request ID, and event name.
PII is redacted at the logger level using pino's redact config before anything hits the network.

Logs flow stdout → CloudWatch via the awslogs driver in non-blocking mode.
Log groups are per service per environment with 30-day retention in CloudWatch.
Older logs auto-archive to S3 Infrequent Access for 90 days, then Glacier for compliance.

For distributed tracing, AWS X-Ray wraps all HTTP calls and DB operations.
Trace IDs are propagated via headers between services so I can pull one traceId
and instantly see the full request journey across 5 services in one X-Ray trace.

CloudWatch metric filters extract error counts from logs → CloudWatch Alarms with
composite alarm rules → SNS → Lambda routes P1 to PagerDuty and everything to Slack.

The result: MTTD near-zero (alarms fire within one minute), MTTR under 10 minutes
because engineers can correlate alarm → logs query → trace without digging."

────────────────────────────────────────────────────────────────────────

Q2: "Walk me through a production incident you'd use logs to debug."

A: "Payment service starts erroring. PagerDuty fires.
I open CloudWatch Logs Insights immediately — no console navigating.
Query: filter level = ERROR, stats count by error.type.
First result: PoolExhaustedError × 312 occurrences.
Second query: filter duration_ms > 3000, stats avg by event.
Result: fraud_check averaging 4.8 seconds.

Open X-Ray. Paste a traceId from the error log. Trace shows:
payment-service → fraud-api: 4.8s. Fraud API is degraded.
No timeout was configured on that HTTP call.

Short-term fix: deploy payment service with a 2-second HTTP timeout.
Long-term: add circuit breaker pattern for external service calls.
Total debug time: 4 minutes."

────────────────────────────────────────────────────────────────────────

Q3: "How do you prevent logging from impacting application performance?"

A: "Four things:
First, non-blocking log mode on the awslogs driver — log writes are async, app never waits.
Second, pino is the fastest Node.js logger by design: JSON serialization is ~10x faster than Winston.
Third, log level discipline — INFO in production, never DEBUG — keeps volume manageable.
Fourth, for very high throughput services, Fluent Bit as a sidecar handles log routing
so even if CloudWatch throttles, the sidecar buffers and retries without touching app memory.
The app just writes to stdout. Fluent Bit handles delivery."

────────────────────────────────────────────────────────────────────────

Q4: "How do you balance log retention with cost and compliance?"

A: "Three tiers:
Hot (0-30 days): CloudWatch. Fully queryable, fast Logs Insights queries.
Warm (30-90 days): S3 Infrequent Access. Queryable via Athena if needed. ~75% cheaper.
Cold (90 days+): S3 Glacier. For compliance audit trail. Low probability of access.

The classification depends on data type:
Security/audit logs: 7 years Glacier (SOC2/HIPAA/GDPR audit requirements).
Application INFO logs: 30 days then delete, no compliance need.
Error/WARN logs: 90 days — post-incident analysis window.
DEBUG logs: never reach production storage (filtered at Fluent Bit layer).

This tiering cuts CloudWatch cost by 60-70% vs naive retention."

────────────────────────────────────────────────────────────────────────

Q5: "How do you handle GDPR and PII in logs?"

A: "Three-layer approach:
Layer 1 — Source: pino redact config strips PII fields (email, phone, SSN, card numbers)
before they leave the application process. The censor value is [REDACTED].
Layer 2 — Architecture: log only business keys, never full objects.
OrderId is fine. UserId is fine (as a hash). User's full name, address — never logged.
Layer 3 — Retention: 30-day retention on CloudWatch means GDPR erasure requests
arriving within 30 days have no log trail after expiry. For older requests,
we audit what was logged in the first place to confirm PII wasn't captured.
For a true right-to-erasure: S3 + Athena is more manageable than CloudWatch
because S3 objects can be individually deleted. CloudWatch log groups cannot be surgically deleted."

```

---

### Architect's Mental Model

### 5 Decision Rules

```

RULE 1: LOG AT BOUNDARIES, NOT EVERYWHERE
Log when a request enters your service.
Log when an external call is made (and its result).
Log when a request completes (duration + status).
Do NOT log inside every internal function.
Why: boundaries are where failures happen. Middle of a function = noise.

RULE 2: EVERY LOG ENTRY MUST ANSWER: "WHY DO I NEED THIS AT 2AM?"
Before adding a log statement: if an incident woke me up and I ran this query,
would this entry help me? If no → don't log it. If yes → what level?
Helps at 2am → INFO or WARN.
Helps during normal debugging → DEBUG (production off, staging on).
Absolutely critical indicator of system failure → ERROR.

RULE 3: SHARED LOG SCHEMA ACROSS ALL SERVICES
One team's `errorType` vs another team's `error.type` = unqueryable.
Build a shared logging library that all services import.
The library enforces: required fields, PII redaction, log level config.
If a field isn't in the schema → it doesn't get logged.

RULE 4: NEVER CONFIGURE INFINITE RETENTION
Every log group created by any service must have explicit retention_in_days.
Enforce via AWS Config rule or Terraform policy.
Infinite retention default has cost-surprised more teams than any other AWS setting.

RULE 5: OBSERVABILITY ISN'T LOGGING — IT'S ALL THREE PILLARS
Logs tell you WHAT happened. Metrics tell you it's happening. Traces tell you WHERE.
A missing metric = no alerting = MTTD is "whenever a user reports it."
A missing trace = debugging microservice issues takes 10x longer.
Invest equally in all three.

```

### 3 Most Expensive Mistakes

```

MISTAKE 1: DEBUG LOGGING IN PRODUCTION
Cost: 10-50x log volume = 10-50x cost. Has created six-figure monthly CloudWatch bills.
Prevention: dynamic log level via SSM. Monitor CloudWatch costs weekly.
Detection: set CloudWatch cost budget alert at 150% of baseline.

MISTAKE 2: LOGGING WITHOUT QUERYING
Pattern: team sets up CloudWatch, logs flow, nobody ever queries them.
Logs are "set and forget." Incidents happen, nobody goes to logs → gut feeling debugging.
Prevention: every team must run Logs Insights queries in their weekly oncall review.
Build log querying into your incident response habits or it won't happen at 2am.

MISTAKE 3: ALERT FATIGUE DESTROYING ONCALL CULTURE
Pattern: 100 alarms, 80% are noise. Engineers start muting. Real incident missed.
Prevention: measure alarm-to-action rate monthly. Any alarm < 50% action rate → fix or remove.
Standard: P1 alarms should have < 5% false positive rate. If not, demote to P2.

```

### 30-Second Interview Answer

```

"For centralized logging on AWS microservices, I use three layers.

Application layer: pino structured JSON logging with standard fields across all services.
PII redacted at the source. Dynamic log levels via SSM Parameter Store so I can
toggle DEBUG without restarting.

Infrastructure layer: ECS awslogs driver in non-blocking mode to CloudWatch.
Log groups per service with 30-day retention, then archive to S3.
For complex routing, Fluent Bit FireLens sidecar.

Observability layer: CloudWatch Logs Insights for correlation queries,
metric filters feeding alarms, and X-Ray for distributed tracing.
Trace IDs propagated across services so one query gives a complete picture.

The goal: MTTD under 1 minute via alarms, MTTR under 10 minutes via
correlation from alarm to logs to trace to root cause."

(30 seconds. Covers all three pillars. Shows AWS knowledge. Shows operational thinking.)

```

---

## PRODUCTION READINESS CHECKLIST — FINAL

```

BEFORE YOUR FIRST PRODUCTION DEPLOY:

APPLICATION
[ ] pino (or equivalent) structured JSON logging implemented
[ ] Log level: INFO (not DEBUG, not console.log)
[ ] PII redacted: email, phone, card, SSN, password, tokens all [REDACTED]
[ ] Standard fields: timestamp, level, service, version, traceId, requestId, event
[ ] Dynamic log level via SSM (no restart needed to change)
[ ] Correlation IDs propagated in all outgoing HTTP calls (x-amzn-trace-id, x-request-id)

ECS / INFRASTRUCTURE
[ ] awslogs driver: mode non-blocking, max-buffer-size 25m
[ ] IAM task execution role: logs:CreateLogGroup, logs:CreateLogStream, logs:PutLogEvents
[ ] Log group: explicit retention_in_days (never infinite)
[ ] Log group naming: /ecs/{service}-{environment}
[ ] S3 lifecycle policy for log archival at 30 days

ALERTING
[ ] CloudWatch metric filter for error count per service
[ ] P1 alarm: error rate > 5% for 3 consecutive minutes → PagerDuty
[ ] P2 alarm: error rate 1-5% for 5 minutes → Slack + PagerDuty
[ ] P99 latency alarm: > 2s for 5 minutes → Slack
[ ] Composite alarm for real degradation detection (error rate AND latency)
[ ] Every alarm has a runbook URL in its description
[ ] CloudWatch cost budget alert set at 150% of baseline monthly spend

TRACING
[ ] X-Ray enabled on ECS task definition
[ ] ADOT/AWS X-Ray SDK instrumenting HTTP calls and DB queries
[ ] Sampling rules configured (100% payment, 0% health, 5-10% default)
[ ] traceId appears in all application log entries

RUNBOOKS
[ ] High error rate runbook written and linked from alarm description
[ ] Rollback procedure documented and tested
[ ] On-call rotation defined and rotation schedule active in PagerDuty

MONITORING VERIFICATION
[ ] Deploy a test error → verify it appears in CloudWatch within 60 seconds
[ ] Trigger metric filter → verify alarm fires within 5 minutes
[ ] Run a test request → verify trace appears in X-Ray
[ ] Verify Slack/PagerDuty receives test notification
[ ] Verify CloudWatch log retention is set (not unlimited)

```

```
