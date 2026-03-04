# Centralized Logging

## SECTION 5 — Real World Example

> **Architect Training Mode** | Site Reliability Engineer Perspective
> _Real outages. Real queries. Real recovery. Because incidents don't come with documentation._

---

## REAL OUTAGE SCENARIO — "The Silent Cascade"

```
TIMELINE:
  03:47 UTC  — Payment service starts returning 500 errors (8% of traffic)
  03:47 UTC  — CloudWatch Alarm fires: "PaymentErrorRate > 1%"
  03:47 UTC  — PagerDuty wakes on-call engineer
  03:52 UTC  — Engineer starts investigation (5 min response time)
  03:56 UTC  — Root cause identified in logs
  04:03 UTC  — Fix deployed (ECS force-new-deployment)
  04:07 UTC  — Error rate back to 0%
  Total incident duration: 20 minutes. MTTD: 0 seconds. MTTR: 20 minutes.

HOW THE ENGINEER DEBUGGED IN 4 MINUTES:

  STEP 1 — What's failing? (30 seconds)
    CloudWatch Alarm → Dashboard → PaymentErrors metric → spike at 03:47.
    Affects only payment-service-prod (other services: healthy).

  STEP 2 — What do the logs say? (90 seconds)
    CloudWatch Logs Insights query:

    fields @timestamp, event, error.type, error.message, duration_ms
    | filter level = "ERROR" and @logStream like "payment-service-prod"
    | sort @timestamp desc
    | limit 20

    First result:
    {
      "event": "payment_processing_failed",
      "error": {
        "type": "PoolExhaustedError",
        "message": "Cannot acquire connection within 5000ms — pool size: 10, waiting: 47"
      },
      "duration_ms": 5023
    }

    Pattern: ALL errors are PoolExhaustedError. DB pool exhausted. Not a DB outage.

  STEP 3 — Why is the pool exhausted? (60 seconds)
    Look at what's HOLDING the connections:

    fields event, duration_ms, requestId
    | filter service = "payment-service" and duration_ms > 3000
    | stats count(), avg(duration_ms) by event

    Result:
    event                         count  avg_duration_ms
    verify_fraud_check             312    4847

    The fraud check call is taking 4.8 seconds avg (normal: 200ms).
    Each slow request holds a DB connection for 4.8s.
    10-connection pool × 4.8s hold time → pool exhausted at moderate traffic.

  STEP 4 — X-Ray confirms (60 seconds)
    Grab traceId from a failed request in the logs.
    Open X-Ray → paste traceId.
    Trace shows:
      payment-service → fraud-api: 4.8s  ← CULPRIT
      payment-service → postgres:  0ms   ← waiting for connection that's stuck

  ROOT CAUSE:
    fraud-api downstream service degraded (their deployment introduced a slow DB query).
    No timeout on the fraud API HTTP call → connections held 4.8s instead of 200ms.
    Connection pool exhausted → all new payment requests fail immediately.

  FIX:
    Short-term: force-new-deployment of payment service with added HTTP timeout (2s).
    Downstream: contact fraud-api team about their degraded service.
    Long-term: circuit breaker pattern on external service calls.

WITHOUT CENTRALIZED LOGGING:
  MTTD: 0s (alarm still fires).
  But: engineer SSHes into... wait, Fargate. No SSH.
  Engineer checks ECS console → finds stopped tasks (the erroring tasks were replaced).
  Remaining logs in CloudWatch? Using json-file log driver (local only, gone with task).
  No logs. No trace. Guessing in the dark.
  MTTR: 90 minutes of guessing. Escalation to team lead. Multiple engineers mobilized.
```

---

### INCIDENT 01 — Logs Not Appearing in CloudWatch (Invisible Failures)

```
SYMPTOM:
  Production deploy completed. Service is running.
  But CloudWatch Log Group /ecs/myapp-prod has no new log streams.
  Monitoring dashboard shows no error rate because there are NO logs.
  Service could be failing silently — nobody knows.

ROOT CAUSE OPTIONS:

  1. Missing IAM permission on task execution role:
     ECS can't write to CloudWatch → silently drops logs.
     Error visible in ECS task stopped reason, not in CloudWatch (of course).

     Fix: Add to task execution role:
     {
       "Effect": "Allow",
       "Action": [
         "logs:CreateLogGroup",
         "logs:CreateLogStream",
         "logs:PutLogEvents",
         "logs:DescribeLogStreams"
       ],
       "Resource": "arn:aws:logs:us-east-1:123456789:log-group:/ecs/myapp-prod:*"
     }

  2. Log group doesn't exist + awslogs-create-group not set:
     "awslogs-create-group": "true"  ← add this to logConfiguration options

  3. Application writing to a file instead of stdout:
     awslogs driver captures ONLY stdout/stderr.
     If app writes to /app/logs/app.log → zero logs in CloudWatch.
     Fix: ensure app logs to process.stdout (console.log in Node.js always does).
     Check: docker run myimage → look at terminal output. If nothing → file logging.

  4. Log driver mode: blocking + CloudWatch throttled = app hung, no logs:
     Use mode: "non-blocking" in logConfiguration.
     And add max-buffer-size to cap memory usage.

VERIFY LOGGING IS WORKING:
  # After deploy — within 60 seconds you should see logs appear:
  aws logs describe-log-streams \
    --log-group-name /ecs/myapp-prod \
    --order-by LastEventTime \
    --descending \
    --max-items 5

  # See latest log events directly:
  aws logs get-log-events \
    --log-group-name /ecs/myapp-prod \
    --log-stream-name ecs/api/$(aws ecs list-tasks --cluster prod --query 'taskArns[0]' --output text | cut -d'/' -f3)

  # Add to deployment checklist:
  sleep 30 && aws logs filter-log-events \
    --log-group-name /ecs/myapp-prod \
    --start-time $(date -d '1 minute ago' +%s)000 \
    --query 'events[0].message' || echo "NO LOGS DETECTED — INVESTIGATE"
```

---

### INCIDENT 02 — Log Volume Explosion → CloudWatch Bill Shock

```
SYMPTOM:
  Monthly AWS bill arrives. CloudWatch Logs line item: $3,400.
  Last month it was $180.
  Investigation: someone enabled DEBUG logging in production "temporarily".
  "I forgot to turn it off."

ROOT CAUSE ANALYSIS:
  Production API service at INFO level:
    ~200 log entries per request × 500 RPS × 2 tasks × 86400 sec/day
    = 17 billion log entries/month... no wait, that's too many.

  Real calculation:
    500 req/s × ~10 log lines per request (INFO level) × 86400s = 432M lines/day
    Average line size: 500 bytes JSON
    432M × 500B = 216GB/day × 30 days = 6,480GB/month

  DEBUG adds 10-50x more lines:
    × 50 = 324,000GB/month
    × $0.50/GB ingest = $162,000/month
    (This has happened at real companies)

  A more realistic case (team of 10, 5 services, DEBUG for 2 weeks):
    5 services × 200GB/day × 14 days = 14,000GB
    $0.50 × 14,000 = $7,000 surprise bill

FIX — Dynamic log level (no restart needed):
  Architecture:
    SSM Parameter Store: /prod/myapp/log-level = "info"
    App polls every 60 seconds → updates pino logger level dynamically

  Implementation:
    import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
    const ssm = new SSMClient({ region: 'us-east-1' });

    async function syncLogLevel() {
      const response = await ssm.send(new GetParameterCommand({
        Name: '/prod/myapp/log-level'
      }));
      const level = response.Parameter?.Value ?? 'info';
      if (logger.level !== level) {
        logger.info({ event: 'log_level_changed', from: logger.level, to: level });
        logger.level = level;
      }
    }

    setInterval(syncLogLevel, 60_000);   // poll every 60 seconds
    syncLogLevel();                       // sync at startup

  Operations:
    # Temporarily enable DEBUG for 5 minutes:
    aws ssm put-parameter --name /prod/myapp/log-level --value debug --overwrite
    sleep 300
    aws ssm put-parameter --name /prod/myapp/log-level --value info --overwrite

FIX — CloudWatch Billing Alert (detect early):
  aws budgets create-budget --account-id 123456789 --budget '{
    "BudgetName": "CloudWatch-Cost-Alert",
    "BudgetLimit": {"Amount": "500", "Unit": "USD"},
    "TimeUnit": "MONTHLY",
    "BudgetType": "COST",
    "CostFilters": {"Service": ["Amazon CloudWatch"]}
  }' --notifications-with-subscribers '[{
    "Notification": {
      "NotificationType": "ACTUAL",
      "ComparisonOperator": "GREATER_THAN",
      "Threshold": 80
    },
    "Subscribers": [{"SubscriptionType": "EMAIL", "Address": "ops@company.com"}]
  }]'
```

---

### INCIDENT 03 — Alert Fatigue → Real Incident Ignored

```
SYMPTOM:
  Production database goes down at 14:23.
  Nobody responds for 22 minutes.
  Postmortem reveals: the alert fired. PagerDuty notified on-call.
  On-call engineer: "I get 50 alerts a day. Half are noise. I was in a meeting."

  In the past 30 days: 1,847 alerts fired. 1,792 were not actionable.
  On-call team muted notifications during business hours.
  A real P1 incident was missed.

ROOT CAUSE: Alert fatigue from poorly designed alerting strategy.
  Symptoms of bad alerting:
    Alarms on symptoms that aren't actionable (memory at 60% — so what?)
    Fixed thresholds instead of anomaly/trend-based
    No severity differentiation (everything pages on-call at 2am)
    Alarms that fire during known maintenance windows
    Alarms with no clear owner or runbook

CORRECT ALERTING STRATEGY (4-tier model):

  P1 — WAKE PEOPLE UP IMMEDIATELY (PagerDuty, phone call):
    • Error rate > 5% for 5 consecutive minutes
    • Service completely unreachable (health check failing)
    • Database connection failure
    • Revenue-impacting events (payment service down)
    Standard: acknowledge within 5 minutes, resolve within 30.

  P2 — NOTIFY ON-CALL (PagerDuty, 30-min acknowledgment):
    • Error rate 1-5%
    • P99 latency > 3s for 10 minutes
    • Queue depth growing unbounded
    • Disk usage > 80%
    Can wait for morning if night-time and trend is stable.

  P3 — SLACK CHANNEL NOTIFICATION (no wake-up):
    • Elevated error rate < 1%
    • Single task restart
    • Retry storm (circuit breaker opened)
    • Non-critical service degraded
    Review next business day.

  P4 — DASHBOARD ONLY (no notification):
    • CPU > 70% (might be normal traffic spike)
    • Memory > 60%
    • Minor latency increase
    Visible on dashboard. Only escalates if sustained.

ALARM QUALITY RULES:
  Every alarm must have:
    1. Owner (which team responds)
    2. Runbook URL (what to do when it fires)
    3. Severity label (P1/P2/P3)
    4. Suppression window (during deployments, maintenance)

  If an alarm fires and nobody knows what to do: it's not ready. Remove it until it is.

  Measure: alarm-to-action rate. If < 50% of alarms lead to an action → too noisy.
  Target: > 90% of P1 alarms lead to a corrective action.
```

---

### INCIDENT 04 — Logs Contain PII → GDPR Compliance Breach

```
SYMPTOM:
  Legal team receives a GDPR "right to erasure" request.
  Standard process: find and delete user data from databases.
  Data discovery sweep: CloudWatch Logs also contain PII.
  Logs have: email addresses, full names, partial credit card numbers.
  CloudWatch logs can't be selectively deleted (you can delete the whole group, not individual records).

  Legal exposure: GDPR Article 83 fines up to €20M or 4% of global turnover.
  Operational nightmare: which log groups? which time range? 14 months of logs.

ROOT CAUSE:
  Logging framework logged full HTTP request/response bodies.
  Requestbody: { "email": "user@example.com", "fullName": "John Smith", "creditCard": "4111..." }
  All of that went into structured log field "body" → CloudWatch.

  ALSO COMMON:
    console.log(user)  ← logs entire user object including PII fields
    logger.info(req.body) ← if body has sensitive data = PII in logs
    Error stack traces including user-controlled input

FIX — Pino redact (sanitize before logging):
  const logger = pino({
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'body.password',
        'body.creditCard',
        'body.ssn',
        'body.email',           // hash or redact
        'user.email',
        'user.phone',
        '*.token',
        '*.secret',
      ],
      censor: '[REDACTED]'
    }
  });

FIX — Log what you need, not what you have:
  // WRONG: log entire request:
  req.log.info({ body: req.body }, 'Request received');

  // CORRECT: log only non-sensitive operational context:
  req.log.info({
    event: 'payment_initiated',
    orderId: req.body.orderId,              // business key (not PII)
    amount: req.body.amount,               // numeric (not PII)
    currency: req.body.currency,
    userId: hashUserId(req.user.id),       // hashed — cannot reverse to real ID
    // NOT: email, name, address, card number
  }, 'Payment started');

FIX — Log retention limits compliance window:
  Retention: 30 days (most GDPR requests come within 30 days of data entry)
  After 30 days: data automatically deleted from CloudWatch
  Archive only non-PII fields to long-term S3 storage

  Terraform resource:
    resource "aws_cloudwatch_log_group" "api" {
      name              = "/ecs/api-prod"
      retention_in_days = 30      # auto-delete after 30 days
    }
```

---

### INCIDENT 05 — Trace IDs Not Propagated → Impossible to Correlate Logs

```
SYMPTOM:
  User reports: "My payment failed at 3:47pm."
  Engineer queries logs for that user at that time: 47 log entries from 3 services.
  Without a trace ID to correlate them: which entries are from THAT request?
  Multiple users were hitting payment at 3:47. Entries interleaved.
  Impossible to reconstruct the specific request's journey.
  Debugging time: 40 minutes to piece together manually.

ROOT CAUSE:
  Service A generates a requestId (UUID) for incoming requests.
  Service A calls Service B → does NOT pass the request ID in headers.
  Service B logs its own events with its own IDs.
  No shared identifier links the two services' log entries.

FIX — Trace ID propagation via HTTP headers:
  // Service A — Express middleware:
  app.use((req, res, next) => {
    // Use X-Ray trace ID if available (ALB injects it), or generate:
    const traceId = req.headers['x-amzn-trace-id'] ??
                    `1-${Date.now().toString(16)}-${crypto.randomBytes(12).toString('hex')}`;
    const requestId = req.headers['x-request-id'] ?? crypto.randomUUID();

    // Attach to request context for logging:
    req.log = logger.child({ traceId, requestId });

    // Store for outgoing calls:
    req.traceId = traceId;
    req.requestId = requestId;
    res.set('x-request-id', requestId);  // pass back to client
    next();
  });

  // Service A — outgoing HTTP call to Service B:
  const response = await fetch('http://service-b/validate', {
    headers: {
      'x-amzn-trace-id': req.traceId,     // propagate trace ID
      'x-request-id': req.requestId,       // propagate request ID
    }
  });

  // Service B — same middleware — extracts the header:
  // req.headers['x-amzn-trace-id'] will be set → same traceId in logs

  // Now: one CloudWatch Logs Insights query across both services:
  // | filter traceId = "1-65a2b3c4-abc123def456789012345678"
  // Shows ALL entries from BOTH services for that specific request, in order.

VERIFY PROPAGATION IS WORKING:
  # Trigger a request, grep logs for the traceId:
  TRACE_ID=$(curl -s -I http://api/payment | grep x-request-id | awk '{print $2}')
  aws logs filter-log-events \
    --log-group-name /ecs/api-prod \
    --filter-pattern "{$.requestId = \"$TRACE_ID\"}"
  aws logs filter-log-events \
    --log-group-name /ecs/payment-prod \
    --filter-pattern "{$.requestId = \"$TRACE_ID\"}"
  # Both queries should show related entries for the same request
```

---

### Incident Response Exercise

```
SCENARIO: You receive this PagerDuty alert at 2:17am:
  "CRITICAL: API error rate 12% — Alarm: APIErrorRate-Prod"

EXECUTE THIS PLAYBOOK:

MINUTE 0-2: TRIAGE — What is the scope?

  # 1. Check service health dashboard (bookmark this):
  # CloudWatch Dashboard: MyApp-Production
  # Look at: error rate per service, request rate, latency P99

  # 2. Determine which service(s) affected:
  aws cloudwatch get-metric-statistics \
    --namespace MyApp/Services \
    --metric-name ErrorRate \
    --dimensions Name=Service,Value=api \
    --start-time $(date -u -d '10 minutes ago' +%Y-%m-%dT%H:%M:%SZ) \
    --end-time $(date -u +%Y-%m-%dT%H:%M:%SZ) \
    --period 60 \
    --statistics Average

MINUTE 2-5: IDENTIFY — What is failing?

  # CloudWatch Logs Insights — run immediately:
  fields @timestamp, event, error.type, error.message, path, duration_ms
  | filter level = "ERROR"
  | stats count() as errorCount by error.type, error.message
  | sort errorCount desc
  | limit 10

  # What does the error pattern say?
  # PoolExhaustedError → DB connection pool (check downstream query speed)
  # ConnectionRefused → downstream service down
  # TimeoutError → slow downstream service
  # ValidationError → client-side (probably not your fault, but affects error rate)
  # AuthenticationError → token/secret issue (rotation? expired?)

MINUTE 5-10: TRACE — Where in the call chain?

  # Get a failed request's traceId from the logs:
  fields @timestamp, traceId, error.type
  | filter level = "ERROR"
  | sort @timestamp desc
  | limit 1

  # Open X-Ray → paste traceId → see which service/call is failing/slow

MINUTE 10-15: ACT — Apply the fix:

  # Rollback to last known good (fastest path):
  aws ecs update-service --cluster prod --service api \
    --task-definition api:PREVIOUS_VERSION

  # OR: if it's a config issue:
  aws ssm put-parameter --name /prod/api/feature-flag --value false --overwrite
  # If app polls SSM: takes effect in 60s without restart

  # OR: if downstream service is the problem:
  # Enable circuit breaker. Route traffic to fallback. Notify other team.

MINUTE 15+: MONITOR — Confirm recovery:

  # Watch error rate come down in real-time:
  watch -n 5 'aws cloudwatch get-metric-statistics \
    --namespace MyApp/Services --metric-name ErrorRate \
    --period 60 --statistics Average \
    --start-time $(date -u -d "5 minutes ago" +%Y-%m-%dT%H:%M:%SZ) \
    --end-time $(date -u +%Y-%m-%dT%H:%M:%SZ) \
    --dimensions Name=Service,Value=api \
    --query "Datapoints[0].Average"'

  # Watch for 0% error rate for at least 5 consecutive minutes before closing.
  # Closing too early = incident reopens = second wake-up call.

POST-INCIDENT:
  Write blameless postmortem within 48 hours.
  5 sections:
    1. Timeline (what happened, in order)
    2. Root cause (not who, but what system/process failed)
    3. Impact (users affected, revenue impact, duration)
    4. Action items (with owner + due date — not "we should")
    5. What went well (what helped the recovery — reinforce these)
```

---

### Debugging Toolkit

```bash
# ──────────────────────────────────────────────────────────────────────
# CLOUDWATCH LOGS — QUICK QUERIES
# ──────────────────────────────────────────────────────────────────────

# Start an interactive Logs Insights query via CLI:
aws logs start-query \
  --log-group-name /ecs/api-prod \
  --start-time $(date -d '1 hour ago' +%s) \
  --end-time $(date +%s) \
  --query-string 'fields @timestamp, @message | filter level = "ERROR" | sort @timestamp desc | limit 20'

# Get the query results (use the queryId returned above):
aws logs get-query-results --query-id <queryId>

# Filter by pattern (simple, fast for known patterns):
aws logs filter-log-events \
  --log-group-name /ecs/api-prod \
  --filter-pattern '{ $.level = "ERROR" }' \
  --start-time $(date -d '30 minutes ago' +%s)000 \
  --end-time $(date +%s)000

# Tail logs from a specific ECS task (like tail -f):
aws logs tail /ecs/api-prod --follow

# ──────────────────────────────────────────────────────────────────────
# ECS EXEC — SHELL INTO RUNNING TASK (production debug, use carefully)
# ──────────────────────────────────────────────────────────────────────

# Enable ECS Exec on the service (if not already):
aws ecs update-service --cluster prod --service api \
  --enable-execute-command

# Shell into a running task:
TASK_ARN=$(aws ecs list-tasks --cluster prod --service-name api \
  --query 'taskArns[0]' --output text)

aws ecs execute-command \
  --cluster prod \
  --task $TASK_ARN \
  --container api \
  --command "/bin/sh" \
  --interactive

# Inside the container:
env | sort              # verify env vars loaded
curl localhost:8080/health  # local health check
netstat -tlnp           # verify which ports are listening
ps aux                  # verify process is running as non-root

# ──────────────────────────────────────────────────────────────────────
# X-RAY — TRACE LOOKUP
# ──────────────────────────────────────────────────────────────────────

# Get recent traces for a service:
aws xray get-traces \
  --trace-ids $(aws xray get-trace-ids \
    --start-time $(date -d '10 minutes ago' +%s) \
    --end-time $(date +%s) \
    --filter-expression 'service("api-prod") AND error' \
    --query 'TraceIds[0]' --output text)

# ──────────────────────────────────────────────────────────────────────
# CLOUDWATCH ALARMS — STATUS CHECK
# ──────────────────────────────────────────────────────────────────────

# See all alarms in ALARM state right now:
aws cloudwatch describe-alarms --state-value ALARM \
  --query 'MetricAlarms[*].{Name:AlarmName, Reason:StateReason}'

# Get recent alarm history:
aws cloudwatch describe-alarm-history \
  --alarm-name APIErrorRate-Prod \
  --history-item-type StateUpdate \
  --max-records 10

# ──────────────────────────────────────────────────────────────────────
# METRICS — QUICK CHECKS
# ──────────────────────────────────────────────────────────────────────

# Get current ECS service CPU/memory:
aws cloudwatch get-metric-statistics \
  --namespace AWS/ECS \
  --metric-name CPUUtilization \
  --dimensions Name=ServiceName,Value=api Name=ClusterName,Value=prod \
  --period 300 \
  --statistics Average \
  --start-time $(date -u -d '30 minutes ago' +%Y-%m-%dT%H:%M:%SZ) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%SZ)

# Get ALB 5XX error rate:
aws cloudwatch get-metric-statistics \
  --namespace AWS/ApplicationELB \
  --metric-name HTTPCode_ELB_5XX_Count \
  --dimensions Name=LoadBalancer,Value=<alb-arn-suffix> \
  --period 60 --statistics Sum \
  --start-time $(date -u -d '30 minutes ago' +%Y-%m-%dT%H:%M:%SZ) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%SZ)
```

## SECTION 6 — System Design Importance

The incident patterns above highlight key system design principles: design for failure, implement graceful degradation, enforce security boundaries at every layer, and monitor proactively. Each incident represents a production scenario that should inform your system design decisions.

## SECTION 7 — AWS & Cloud Mapping

AWS services directly relevant to these patterns: **ECS/Fargate** for container orchestration and task lifecycle management; **ECR** for secure image storage and scanning; **Secrets Manager / SSM Parameter Store** for runtime secret injection; **CloudWatch** for container metrics, logs, and alarms; **IAM** for fine-grained access control.

## SECTION 8 — Interview Preparation

**Beginner:**

**Q: What is centralized logging and why is it necessary in production?**
**A:** In development, you look at logs in your terminal. In production, you might have 10+ server instances each writing logs to their own disk. To investigate a bug, you'd have to SSH into each server, find the right log file, and grep through it â€” impossible to correlate events across servers. Centralized logging ships all logs from all servers/containers to ONE place (CloudWatch Logs, Datadog, ELK Stack). You search and filter once, see all logs. Essential for debugging distributed systems, auditing security events, and monitoring errors across a fleet.

**Q: What is structured logging and why is it better than plain text logs?**
**A:** Plain text log: 2024-01-15 10:23:45 ERROR: Payment failed for user 12345. Structured log (JSON): {"timestamp":"2024-01-15T10:23:45Z","level":"ERROR","event":"payment_failed","user_id":12345,"amount":99.99,"error":"card_declined"}. Structured logs are machine-parseable: you can query user_id = 12345 AND event = payment_failed in CloudWatch Insights or Datadog. With plain text: you'd write complex regex. Structured logs also: consistent fields across all services (same user_id field name), easy dashboards and alerts (alert when error_count > 10 in 5 minutes).

**Q: What is the difference between a log level ERROR, WARN, and INFO, and how should you decide which to use?**
**A:** *ERROR:* Something broke and requires attention. The system failed to do something it should have done (payment processing failed, database connection lost, uncaught exception). Should trigger an alert or be investigated. *WARN:* Something unexpected happened but the system continued. Worth noting but not critical (rate limit almost hit, deprecated API used, retried a failed request but it succeeded on retry). *INFO:* Normal operation events that help understand system flow (user logged in, order created, cron job started). In production: set default level to INFO, ERROR and WARN are always logged. Never log sensitive data (passwords, PII) at any level.

---

**Intermediate:**

**Q: What is log correlation ID and how do you implement it across microservices?**
**A:** A correlation ID (also trace ID) is a unique identifier generated at the entry point (API gateway / first service) and passed through every subsequent service call as an HTTP header (X-Correlation-ID). Each service includes this ID in every log message it writes. Now, when debugging an incident: search by correlation ID and see every log message from every service for that specific request â€” in order. Implementation: middleware generates UUID at request start; attaches to request context; all logging in that request automatically includes the ID; propagated to downstream services via HTTP header. Without it: impossible to trace one user's request through 5 services.

**Q: What is log sampling and when should you use it?**
**A:** Log sampling is writing only a percentage of log messages (e.g., log 10% of INFO messages, 100% of ERRORs). Used when: very high throughput (10,000 req/s Ã— verbose logs = billions of log events/day = massive cost). Sampling preserves statistical accuracy for metrics while reducing volume. Example: CloudWatch Logs costs ~.50/GB ingested + .03/GB stored. At 10GB/day that's /day = ,800/year just for logs. Sampling INFO logs at 10% reduces this to /year. Always sample: DEBUG/INFO at low rates. Never sample: ERROR logs (you need every error), security audit logs, transaction logs.

**Q: What are the key CloudWatch Logs features every production engineer should know?**
**A:** *Log Groups:* container for log streams (one group per application/service). *Log Streams:* individual source (one per container instance). *Log Insights:* query language for searching and aggregating log data â€” ields @timestamp, @message | filter level = "ERROR" | stats count() by bin(5m). *Metric Filters:* convert log patterns into CloudWatch metrics (count occurrences of "ERROR" â†’ metric â†’ alarm â†’ SNS/PagerDuty alert). *Log Retention:* set retention period (30-90 days for compliance; older is expensive). *Live Tail:* real-time log streaming (like 	ail -f but for CloudWatch). *Alarms:* create alarms on metric filters for real-time incident alerting.

---

**Advanced (System Design):**

**Scenario 1:** Design a centralized logging architecture for a platform with 30 ECS services + 5 Lambda functions. Requirements: (1) All logs searchable in < 5 seconds. (2) Error logs must trigger PagerDuty alerts within 2 minutes. (3) Logs retained for 90 days. (4) Cost < /month. (5) Sensitive PII must be masked before storage.

*Architecture:*
- ECS: awslogs driver ships to CloudWatch Logs. Lambda: built-in CloudWatch Logs integration.
- PII masking: Lambda function subscribed to all log groups via CloudWatch Logs subscription filter â†’ processes and masks PII fields (email, SSN patterns) â†’ writes clean logs to S3 + CloudWatch Logs.
- Search: CloudWatch Logs Insights for real-time search. S3 + Athena for historical analysis (cheaper for old logs).
- Alerting: CloudWatch Metric Filters on each log group (count "level=ERROR") â†’ CloudWatch Alarm (threshold: 5 errors in 1 minute) â†’ SNS â†’ PagerDuty webhook.
- Retention: CloudWatch Logs: 7-day retention (recent/hot). Export job: Lambda daily exports logs > 7 days to S3 Glacier (cheap). 90-day S3 lifecycle policy.
- Cost estimate: 30 services Ã— ~200MB/day = 6GB/day ingestion @ .50/GB = /day = /month. Storage (S3 Glacier for older logs): ~.004/GB. Total: well under /month.

**Scenario 2:** Your team is getting PagerDuty alerts at 3 AM for "high error rate" but when engineers investigate, the errors are harmless (e.g., 404 Not Found from web crawlers hitting non-existent pages). Alert fatigue is causing engineers to ignore alerts. How do you fix the alerting system?

*Root cause:* Log metric filter is counting ALL log entries with level=ERROR, including expected/benign errors (404s, client validation errors). 

*Fix â€” Tiered alerting:*
(1) Separate ERROR severity: 4xx errors (client errors â€” not our problem) vs 5xx errors (server errors â€” our fault). Only alert on 5xx.
(2) Alert on rate increase, not absolute count: "5xx error rate > 1% of total requests" vs "error count > 5". Crawlers cause high raw count but low percentage.
(3) Add CloudWatch composite alarms: alert only if BOTH (error rate high) AND (p99 latency high). Single-signal alerting is too noisy.
(4) Quiet hours with different thresholds: 10x higher threshold for 2-5 AM (when traffic is lowest, even a few errors is a higher percentage).
(5) Monthly review: track how many alerts woke someone up and turned out to be non-actionable â†’ target < 10% noise ratio.

