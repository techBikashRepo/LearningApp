# Centralized Logging

## FILE 01 OF 03 — Observability Stack, Architecture & Production Patterns

> **Architect Training Mode** | Site Reliability Engineer Perspective
> _Optimized for: design judgement · tradeoff evaluation · failure prediction · production debugging_

---

## SECTION 1 — Intuition (Explain Like a 12-Year-Old)

```
WITHOUT CENTRALIZED LOGGING:
  Production incident at 2am.
  Service returns 500 errors for 8% of traffic.
  6 services. 12 ECS tasks. 4 engineers.
  "SSH into the EC2 instance and check the logs."
  → Fargate: no SSH access. Logs are gone when task dies.
  → EC2: which instance? task may have moved. Logs mixed with other tasks.
  → Worst: the task that generated the error is already dead and replaced.
  Mean time to detect cause: 47 minutes. Incident duration: 1h 20m.

WITH CENTRALIZED LOGGING:
  All logs from all tasks → CloudWatch Logs (or Elasticsearch/Datadog).
  One query across all services, all instances, all time.
  Mean time to detect cause: 4 minutes.
  The logs survived even though the task died.

WHAT CENTRALIZED LOGGING IS:
  Aggregation of log output from ALL instances of ALL services
  into a single queryable, durable, searchable store.

  Single pane of glass:
  apps → log collector/agent → centralized store → query/alert/dashboard

WHAT IT IS NOT:
  A replacement for metrics (CloudWatch metrics, Prometheus)
  A replacement for tracing (X-Ray, Zipkin, Jaeger)
  A debugging tool you SSH into machines to use
  A place to store PII or secrets (compliance risk)
```

---

## SECTION 2 — Core Technical Explanation

```
The three pillars of observability work together. Missing one creates a blind spot.

┌──────────────────────────────────────────────────────────────────────────┐
│                        OBSERVABILITY TRIANGLE                            │
├─────────────────────┬──────────────────────┬─────────────────────────────┤
│      LOGS           │      METRICS         │        TRACES               │
│  (WHAT happened)    │  (HOW MUCH/HOW FAST) │  (WHERE it happened)        │
├─────────────────────┼──────────────────────┼─────────────────────────────┤
│ Timestamped events  │ Aggregated numbers   │ Request path across services│
│ Request details     │ over time            │ Latency per service hop     │
│ Error stack traces  │ Error rate %         │ Distributed call graph      │
│ Business events     │ P99 latency          │ Root cause in microservices │
│ User actions        │ CPU/memory usage     │ "Which service is slow?"    │
│                     │ Request count/sec    │                             │
├─────────────────────┼──────────────────────┼─────────────────────────────┤
│ AWS: CloudWatch     │ AWS: CloudWatch      │ AWS: X-Ray                  │
│      Logs           │      Metrics         │      AWS Distro for OTel    │
│ OSS: ELK Stack      │ OSS: Prometheus+     │ OSS: Jaeger, Zipkin         │
│      Loki           │      Grafana         │      Tempo                  │
└─────────────────────┴──────────────────────┴─────────────────────────────┘

WHICH PILLAR ANSWERS WHAT:

  "Is something wrong right now?"                 → Metrics (error rate alarm)
  "What exactly went wrong?"                      → Logs (error message + context)
  "Which service in the chain is causing it?"     → Traces (distributed call graph)
  "When did it start?"                            → Metrics (graph over time)
  "What was the user doing when it happened?"     → Logs (request context)
  "Is this isolated or systemic?"                 → Metrics (% of traffic affected)

REAL EXAMPLE:
  Alarm fires: "API error rate > 1%"              ← Metric detected the problem
  CloudWatch Logs Insights query: find the errors ← Logs explain the problem
  X-Ray trace for a failing request               ← Trace shows it's the DB call
  Answer: RDS connection pool exhausted at 3:47am ← Root cause identified

  Without all three: you'd know something is wrong but not why or where.
```

---

## SECTION 3 — Architecture Diagram (MANDATORY)

```
UNSTRUCTURED LOG (searches are guesses):
  "Error processing payment for user 12345: connection timeout after 5000ms"

  To find this: grep "payment" | grep "timeout" | awk | sed...
  To alert on: regex pattern matching (fragile, breaks on message change)
  To aggregate: impossible (how many timeouts? per minute? per user?)
  PII risk: user ID exposed in plaintext log message

STRUCTURED LOG (JSON — machine-parseable, queryable, aggregatable):
  {
    "timestamp": "2026-02-28T03:47:22.341Z",
    "level": "ERROR",
    "service": "payment-service",
    "version": "a3f7c9b",
    "traceId": "1-5f4d8b2c-1234567890abcdef01234567",
    "requestId": "req_abc123",
    "event": "payment_processing_failed",
    "userId": "usr_hash_9f2e",        ← hashed, not raw PII
    "amount": 9900,
    "currency": "USD",
    "error": {
      "type": "ConnectionTimeoutError",
      "message": "DB connection timeout after 5000ms",
      "stack": "at Pool.acquire (/app/dist/db.js:42:15)..."
    },
    "duration_ms": 5023,
    "host": "ecs-task-09f8e7d6"
  }

  CloudWatch Logs Insights query:
    fields @timestamp, event, duration_ms, error.type
    | filter level = "ERROR" and event = "payment_processing_failed"
    | stats count(), avg(duration_ms) by bin(5m)
  → Instant: how many failures, trend over time, average duration

STRUCTURED LOGGING IN NODE.JS (pino — production standard):
  import pino from 'pino';

  const logger = pino({
    level: process.env.LOG_LEVEL ?? 'info',
    base: {
      service: process.env.SERVICE_NAME,
      version: process.env.APP_VERSION,
      env: process.env.NODE_ENV,
    },
    // Remove PII fields automatically:
    redact: {
      paths: ['req.headers.authorization', 'body.password', 'body.cardNumber'],
      censor: '[REDACTED]'
    },
    // Production: output newline-delimited JSON (no pretty-printing)
    // Development: pretty-print for human readability
    transport: process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty' }
      : undefined,
  });

  // Add request context to every log in that request:
  app.use((req, res, next) => {
    req.log = logger.child({
      requestId: req.headers['x-request-id'] ?? crypto.randomUUID(),
      traceId: req.headers['x-amzn-trace-id'],   // X-Ray injects this
      path: req.path,
      method: req.method,
    });
    next();
  });

  // Usage in handler:
  req.log.info({ event: 'payment_initiated', amount: req.body.amount });
  req.log.error({ event: 'payment_failed', err: error }, 'Payment processing failed');

LOG LEVELS — when to use each:
  ERROR: Something failed. Requires immediate attention or investigation.
         Always actionable: if it's not actionable, it's not an error.
  WARN:  Unexpected but handled. Degraded state. Should be reviewed.
         Example: rate limit hit → fallback used. Circuit breaker open.
  INFO:  Business events, request lifecycle. Core operational record.
         Example: payment_initiated, user_registered, order_shipped.
  DEBUG: Diagnostic detail for development/debugging. NEVER in production.
         Produces 10-100x log volume. Costs money. Slows app.
  TRACE: Even more granular. Dev only. Never leave in code paths that run in prod.

  PRODUCTION DEFAULT: INFO
  INCIDENT DEBUGGING: Temporarily raise to DEBUG for 5 minutes, then back to INFO
    (use dynamic log level via SSM Parameter Store + app polling)
```

---

## SECTION 4 — Request Flow (MANDATORY FLOWCHART)

```
LOG FLOW ON ECS FARGATE:

  App (stdout/stderr)
       ↓
  ECS log driver (awslogs)    ← configured in task definition
       ↓
  CloudWatch Logs Agent       ← runs as part of ECS agent (no sidecar needed)
       ↓
  CloudWatch Log Group        ← /ecs/myapp-prod
       ↓
  Log Streams                 ← one per task instance
       ↓
  CloudWatch Logs Insights    ← query engine
  CloudWatch Metric Filters   ← extract metrics from log patterns
  Subscription Filters        ← stream logs to Lambda/Kinesis/Firehose/S3

ECS TASK DEFINITION — LOG CONFIGURATION:
  {
    "containerDefinitions": [{
      "name": "api",
      "image": "...",
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group":         "/ecs/myapp-prod",
          "awslogs-region":        "us-east-1",
          "awslogs-stream-prefix": "ecs",
          "awslogs-create-group":  "true",   // create log group if not exists
          "mode":                  "non-blocking",  // CRITICAL: prevents app blocking on log write
          "max-buffer-size":       "4m"              // buffer size before dropping (non-blocking)
        }
      }
    }]
  }

  mode: non-blocking — WHY THIS MATTERS:
    Default "blocking" mode: if CloudWatch is slow/unavailable → your app BLOCKS waiting to write logs.
    A logging system taking down your production app is a textbook secondary failure.
    With non-blocking: if CloudWatch is backpressured, logs are dropped INSTEAD of app blocking.
    Tradeoff: might lose some logs in extreme backpressure.
    Alternative: sidecar log collector (Fluent Bit) — never blocks app.

LOG GROUP STRUCTURE (naming convention):
  /ecs/{app}-{environment}          → /ecs/payment-service-prod
  /ecs/{app}-{environment}/access   → access logs (high volume, separate)
  /lambda/{function-name}           → auto-created by Lambda
  /aws/rds/{instance-id}/error      → RDS error logs
  /aws/rds/{instance-id}/slowquery  → RDS slow query log

  SEPARATE LOG GROUPS PER:
    Service (payment-service vs order-service vs notification-service)
    Environment (prod vs staging) — use retention policy per group
    Log type (application logs vs access logs — different retention, different cost)

LOG RETENTION POLICY:
  Production application logs:  30-90 days (query-able)
  Production access logs:       7-14 days (high volume, archivable)
  Staging:                      7 days
  Dev:                          1-3 days

  Archive to S3 via Subscription Filter → Kinesis Firehose → S3 → Glacier
  S3 Glacier for compliance retention: 7 years at ~$0.004/GB/month

CLOUDWATCH PRICING:
  Ingest:   $0.50/GB
  Storage:  $0.03/GB/month
  Queries:  $0.005/GB scanned by Logs Insights

  COST CALCULATION for a typical service:
    1 ECS service, 2 tasks, INFO level, moderate traffic:
    ~500MB logs/day = 15GB/month
    Ingest: 15 × $0.50 = $7.50/month
    Storage (30-day retention): 15GB × $0.03 = $0.45/month
    Queries: depends on how much you query
    Total: ~$8-15/month per service at INFO level

    DEBUG level: 10-50x more volume = $80-750/month per service
    This is why DEBUG must never be on in production.
```

---

### CloudWatch Logs Insights (Query Engine)

```sql
-- ── BASIC QUERIES ──────────────────────────────────────────────────────

-- Find all errors in last 1 hour:
fields @timestamp, @message
| filter level = "ERROR"
| sort @timestamp desc
| limit 50

-- Count errors by type over time (5-minute buckets):
fields event, error.type
| filter level = "ERROR"
| stats count() as errorCount by error.type, bin(5m)
| sort errorCount desc

-- Find slow requests (P99 latency):
fields @timestamp, path, duration_ms, requestId
| filter duration_ms > 1000
| stats count(), avg(duration_ms), max(duration_ms), pct(duration_ms, 99) by path
| sort pct(duration_ms, 99) desc

-- Trace a specific request across services:
fields @timestamp, @message, service
| filter traceId = "1-5f4d8b2c-1234567890abcdef01234567"
| sort @timestamp asc

-- Find which user IDs are hitting errors most:
fields userId, event, error.type
| filter level = "ERROR"
| stats count() as errors by userId
| sort errors desc
| limit 20

-- ── METRIC FILTERS (extract CloudWatch metrics from log patterns) ────

-- Create metric from log pattern (no code change needed):
-- In AWS Console or Terraform:
resource "aws_cloudwatch_log_metric_filter" "payment_errors" {
  name           = "PaymentProcessingErrors"
  log_group_name = "/ecs/payment-service-prod"
  pattern        = "{ $.event = \"payment_processing_failed\" }"

  metric_transformation {
    name      = "PaymentErrors"
    namespace = "MyApp/Business"
    value     = "1"
    unit      = "Count"
  }
}
-- Then alarm on this metric: PaymentErrors > 10 in 5 minutes → PagerDuty

-- ── CROSS-LOG-GROUP QUERY (query multiple services at once) ────────────
-- Use CloudWatch Logs Insights console: select multiple log groups
-- Or via API: logGroupNames: ["/ecs/api-prod", "/ecs/payment-prod"]

-- ── QUERY OPTIMIZATION (cost matters at $0.005/GB) ──────────────────
-- BAD: scans entire log group
fields @message | filter @message like "ERROR"

-- GOOD: filter at field level first (scans less data):
fields level, event | filter level = "ERROR" and event = "payment_failed"

-- Use time range selector aggressively — narrow window = less scan cost
-- Use limit when exploring: | limit 100
-- Parse only when needed: | parse @message '"userId":"*"' as userId
```

---

### AWS X-Ray (Distributed Tracing)

```
WHAT X-RAY SOLVES:
  Microservices: request travels through API Gateway → Lambda → ECS service A →
                 ECS service B → RDS → ElastiCache.

  Error occurs somewhere in that chain.
  Logs show it happened. Metrics show error rate spiked.
  But WHICH service in the chain is actually slow or failing?

  X-Ray captures the full request path across all services.
  One trace ID. Complete call graph with latency per hop.

HOW IT WORKS:
  1. X-Ray SDK or AWS Distro for OpenTelemetry (ADOT) instruments your app
  2. Incoming request: SDK creates a "segment" (the root span)
  3. Outgoing calls (HTTP, DB, SQS): SDK creates "subsegments"
  4. Each call adds timing + metadata to the trace
  5. X-Ray daemon (sidecar) buffers + sends to X-Ray API
  6. X-Ray console: ServiceMap visualization, trace timeline

INSTRUMENTATION IN NODE.JS (ADOT — recommended over raw X-Ray SDK):
  # Dockerfile — add ADOT collector as sidecar in ECS task
  # OR: use auto-instrumentation layer

  // index.ts — must be FIRST import before anything else
  import './instrumentation';        // sets up OTEL before app code loads

  // instrumentation.ts:
  import { NodeSDK } from '@opentelemetry/sdk-node';
  import { AWSXRayPropagator } from '@aws-xray-sdk-node';
  import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
  import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
  import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';

  const sdk = new NodeSDK({
    textMapPropagator: new AWSXRayPropagator(),
    instrumentations: [
      new HttpInstrumentation(),      // auto-instruments all HTTP calls
      new ExpressInstrumentation(),   // auto-instruments Express routes
      new PgInstrumentation(),        // auto-instruments postgres queries
    ],
  });
  sdk.start();

TRACE ID CORRELATION (link logs → traces):
  // Add X-Ray trace ID to every log entry:
  import { getActiveSpan } from '@opentelemetry/api';

  app.use((req, res, next) => {
    const span = getActiveSpan();
    req.log = logger.child({
      traceId: span?.spanContext().traceId,
      spanId: span?.spanContext().spanId,
    });
    next();
  });

  // Now: CloudWatch Logs query finds the error with traceId.
  // Click traceId in log → opens X-Ray trace. See full callgraph.
  // Full loop: Alarm → Logs → Trace → Root cause.

X-RAY SAMPLING:
  X-Ray does NOT capture 100% of traces by default (cost + performance).
  Default: 5% of requests. Always captures errors.

  Custom sampling rules:
    /health endpoint: 0% (no value, high volume)
    POST /payment: 100% (all payment calls traced — critical path)
    GET /api/*: 5% default
    Error responses: 100% always

X-RAY PRICING:
  First 100,000 traces/month: Free
  After: $0.05 per 100,000 traces
  Storage: $0.01 per 100,000 traces (30-day retention)

  For most apps: $5-30/month. Cheap for the debugging power it provides.
```

---

### Log Collection Architecture Patterns

```
PATTERN 1: Direct to CloudWatch (ECS Fargate — simplest)
  App → stdout → ECS awslogs driver → CloudWatch Logs

  PRO: Zero infra to manage. Built into ECS.
  CON: No log transformation. No fan-out. CloudWatch-only.
  USE FOR: Single-region, CloudWatch-centric, small to medium teams.

PATTERN 2: Fluent Bit Sidecar (ECS — flexible routing)
  App → stdout → Fluent Bit sidecar → multiple destinations
                                    ├── CloudWatch Logs (alerting + query)
                                    ├── S3 (archive + cost)
                                    └── Elasticsearch/OpenSearch (full-text search)

  Fluent Bit ECS sidecar:
    FireLens: AWS's managed Fluent Bit for ECS
    Add to task definition:
    {
      "name": "log_router",
      "image": "906394416424.dkr.ecr.us-east-1.amazonaws.com/aws-for-fluent-bit:stable",
      "firelensConfiguration": {
        "type": "fluentbit"
      }
    }

    API container log config:
    "logConfiguration": {
      "logDriver": "awsfirelens",
      "options": {
        "Name": "cloudwatch_logs",
        "region": "us-east-1",
        "log_group_name": "/ecs/myapp",
        "auto_create_group": "true"
      }
    }

  PRO: Transform logs (parse, filter, enrich) before shipping.
       Route different log types to different destinations.
       Never blocks the app process.
  CON: Another container to maintain. More complex task definition.
  USE FOR: High-volume logs, multi-destination requirements, custom parsing.

PATTERN 3: Kinesis Firehose (streaming to S3/OpenSearch)
  App → CloudWatch Logs → Subscription Filter → Kinesis Firehose → S3/OpenSearch

  Cost model shift: CloudWatch for recent queryable logs (30 days)
                    S3 Glacier for archive (7 years, compliance)
                    OpenSearch for full-text search across history

  Kinesis Firehose: $0.029/GB delivered. Far cheaper than CloudWatch for high-volume.
  USE FOR: Compliance retention. High-volume logs. Full-text search requirements.

PATTERN 4: Third-party (Datadog, Grafana Cloud, New Relic)
  Agent/Forwarder → Third-party SaaS

  PRO: Unified platform (logs + metrics + traces + dashboards + alerts in one UI).
       Better ML-based anomaly detection (Watchdog, etc.).
       Better correlation across pillars.
  CON: $20-50/host/month or per-GB pricing. Vendor lock-in. Data leaves AWS.
  USE FOR: Teams that need unified observability and can afford SaaS.
           Compliance environments where you control data residency (check data agreements).
```

---

### Production Readiness Checklist

```
APPLICATION LOGGING:
  [ ] Structured JSON logging (never unstructured strings)
  [ ] LOG_LEVEL configurable via env var (no code change needed)
  [ ] Default: INFO in production, DEBUG never on by default
  [ ] Every log entry includes: timestamp, level, service, version, requestId, traceId
  [ ] PII removed or hashed (GDPR/HIPAA compliance)
  [ ] Secrets never logged (passwords, tokens, credit card numbers)
  [ ] Startup validation logged (which env vars loaded, which external services connected)
  [ ] Request/response logged at INFO (without body for PII risk)
  [ ] All errors logged at ERROR with full stack trace
  [ ] Graceful shutdown logged: "SIGTERM received", "server closed", "process exiting"

ECS / INFRASTRUCTURE:
  [ ] awslogs or FireLens logging driver configured (not default json-file driver)
  [ ] Log driver mode: non-blocking
  [ ] Log groups named consistently: /ecs/{service}-{env}
  [ ] Log retention policy set per group (not infinite = money leak)
  [ ] IAM: task execution role has logs:CreateLogGroup, logs:CreateLogStream, logs:PutLogEvents

CLOUDWATCH:
  [ ] Log metric filters for: error count, payment failures, auth failures
  [ ] Alarms on metric filters (error rate > threshold)
  [ ] Dashboard: service health, error rates, latency P99
  [ ] Logs Insights saved queries for common incident investigations
  [ ] Subscription filter to Kinesis Firehose (if archiving to S3)

TRACING:
  [ ] X-Ray or ADOT instrumentation enabled
  [ ] Trace ID propagated across service boundaries (X-Amzn-Trace-Id header)
  [ ] Trace ID included in every log entry (logs ↔ traces linkable)
  [ ] Sampling rules defined (100% for critical paths, not 100% everywhere)

ALERTING:
  [ ] At least one error rate alarm per service
  [ ] Alarm actions: SNS → PagerDuty/OpsGenie for P1
  [ ] Alarm actions: SNS → Slack for P2/P3
  [ ] No alarm fatigue: every alarm is actionable
  [ ] Runbook URL in every alarm description
```
