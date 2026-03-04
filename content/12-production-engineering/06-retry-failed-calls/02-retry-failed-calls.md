# Retry Failed Calls

## SECTION 5 — Real World Example

> **Architect Training Mode** | Site Reliability Engineer Perspective
> _Every retry disaster in production had the same root cause: someone added retries but forgot to think about what happens when the retry itself fails, is wrong, or amplifies the problem._

---

### INCIDENT 01 — Retry Storm Takes Down Payment Service

### Symptom

```
11:47 AM: Fraud API deployment takes 90 seconds longer than expected.
           New task spinning up, old task deregistering from ALB.
           During that 90s window: fraud API calls fail with 503.

11:47 AM: ERROR rate on payment service spikes to 100%.
11:48 AM: Payment service CPU: 94% (normally 15%).
11:49 AM: Payment service ECS tasks start crashing (OOMKill).
11:50 AM: Payment service completely down.
           Fraud API recovered 3 minutes ago.
           Payment service still failing because it crashed.

Customer impact: 8 minutes of complete payment outage from a 90-second fraud API blip.
```

### Root Cause

```
Payment service had added retries to fraud API calls. Configuration:
  maxAttempts: 5
  retryDelay: 500ms (fixed, no jitter)
  shouldRetry: ALL errors including 503

During the 90-second fraud API outage:
  At peak: 200 requests per second flowing through payment service.
  Each request attempts fraud API 5 times before failing.
  5 × 200 = 1000 fraud API calls per second (vs normal 200).
  Memory: each retry holds the request object in memory → 5× memory.
  CPU: each retry + JSON serialization + logging → 5× CPU work.

When payment service CPU hit 94%: event loop blocked.
Health check timed out. ALB marked tasks unhealthy. ECS tasks restarted.
After restart: tasks immediately started retrying again at 5× volume.
Restart loop.
```

### Fix

```
1. IMMEDIATE (stop the bleeding):
   Deployed config change: maxAttempts: 1 (disable retries temporarily)
   Payment service stabilized in 2 minutes.

2. PROPER FIX:
   a) Exponential backoff + jitter:
      baseDelayMs: 100, maxDelayMs: 2000, jitter: true

   b) Cap retries at 3 (never 5):
      Most transient issues resolve in 1 retry. 3 is the pragmatic max.

   c) Timeout per attempt:
      Each fraud API call has a 2-second timeout.
      Maximum total time for 3 attempts: 2s + 100ms + 2s + 200ms + 2s = 6.3s max
      (Still within the 10-second payment service request timeout.)

   d) Circuit breaker:
      After 50% failure rate (>10 requests): open circuit. Fail fast (0ms) instead of retry.
      Fallback: flag payment for manual fraud review, allow transaction.

   e) Result:
      Same 90-second fraud API blip → payment service stays healthy.
      Circuit opens after ~10 seconds. Remainder of 90s: instant fallback response.
      Circuit closes when fraud API recovers. Automatic.
```

---

### INCIDENT 02 — Retried POST Creates Duplicate Orders

### Symptom

```
Customer Sarah places an order. Sees loading spinner for 8 seconds (unusual).
Finally gets a confirmation with order ID: ORD-7791.
Checks her email: two confirmation emails. Order ORD-7791 and order ORD-7792.
Both charged to her credit card.
Support ticket: "You charged me twice."

Operations team investigated: 47 duplicate orders in the last 30 days.
```

### Root Cause

```
Network diagram:
  Browser → API Server → Order Service → Stripe (charge) → write to DB

What happened:
  1. API received POST /api/orders from browser.
  2. API called Order Service. Order Service called Stripe successfully (charge created).
  3. Order Service called DB to insert order. DB was briefly slow (high load spike).
  4. DB insert took 6.1 seconds. API's internal HTTP call timeout: 5 seconds.
  5. API timeout: ECONNRESET (upstream took too long).
  6. API retry logic: ECONNRESET is a network error → retryable. Retry.
  7. Retry: calls Order Service again. New Stripe charge. New DB insert.
  8. Both orders land in DB. Two charges on Sarah's card.

The fundamental error: API treated a DB timeout as a transient network error.
The operation had partially succeeded (Stripe was charged).
Retrying the whole operation failed to check if any part had already completed.
```

### Fix

```
LAYER 1: Idempotency key (the real fix):
  Browser generates key before ANY submit:
    const idempotencyKey = `order-${userId}-${cartId}-${cartVersion}`;
    // cartVersion changes if cart changes. Same cart = same key.

  Browser sends: POST /api/orders { ... }
                 Header: Idempotency-Key: order-usr123-cart456-v3

  Order Service checks Redis:
    const existing = await redis.get(`idem:order:${key}`);
    if (existing) return JSON.parse(existing);   // deduplicated

  After successful completion: cache result with 24h TTL.

  On retry with same key: Order Service returns cached result → no new Stripe charge.

LAYER 2: Don't retry POST operations without idempotency:
  Updated shouldRetry function:
    if (method === 'POST' && !hasIdempotencyKey(request)) {
      return false;  // Never retry POST without idempotency key
    }

LAYER 3: Alert on duplicate idempotency key hits:
  if (cache hit) {
    metrics.increment('idempotency.duplicate_request');
    logger.warn({ event: 'idempotency_key_hit', key });  // Track how often this occurs
  }

RESULT: 0 duplicate orders in the 3 months after fix.
        Idempotency key hit rate: ~0.3% of order requests (real retries from browser too).
```

---

### INCIDENT 03 — Retrying 400 Errors Burns CPU and Amplifies Bad Input

### Symptom

```
Monday 9:15 AM: Mobile app deploy over the weekend shipped a bug.
                User profile update endpoint now sends malformed JSON.
                Every single profile update request fails.

Alert fires: API Error Rate > 10%.
Expected impact: slightly elevated error rate.
Actual impact: API server CPU at 89%. Several tasks killed. 5-minute degradation.

Only 200 profile update failures. Why is CPU at 89%?
```

### Root Cause

```
Workflow:
  Mobile app → Gateway → Profile Microservice

Profile Microservice returns 422 Unprocessable Entity (validation failed).
Gateway had blanket retry logic:
  shouldRetry: (err) => err.response?.status >= 500 || isNetworkError(err)

Wait — that correctly excludes 422. So why retries?

Investigation: the Gateway's HTTP call to Profile Service.
Profile Service JSON parsing failure threw a generic JavaScript error:
  SyntaxError: Unexpected token } in JSON at position 47

Gateway's shouldRetry function:
  if (!err.response) return true;  // Assume network error if no response object

SyntaxError has no .response property. Gateway treated it as a network error.
Retried 3 times. 200 bad requests × 3 retries = 600 Profile Service calls.
Profile Service: parsing 600 malformed JSON objects → CPU.
Also logged 600 error stack traces → disk I/O spike.
Also 600 retry logs from Gateway with full request body → another 600 log writes.
Together: disk I/O + CPU = service degradation.
```

### Fix

```
1. IMMEDIATE: rolled back the mobile app to previous version. Errors stopped.

2. FIX shouldRetry logic — explicit allowlist, not implicit:
   BEFORE (implicit "retry if no response"):
     if (!err.response) return true;  // DANGEROUS

   AFTER (explicit allowlist):
     function isRetryable(err: any): boolean {
       // Network-level errors: explicitly check the code
       const retryableCodes = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND'];
       if (err.code && retryableCodes.includes(err.code)) return true;

       // HTTP status-based:
       const status = err.response?.status;
       if (!status) return false;          // Unknown error type — DON'T retry
       return [429, 502, 503, 504].includes(status);
     }

   SyntaxError: no .code in allowlist, no .response.status → return false. Not retried.

3. RATE LIMIT on error logging:
   Log first occurrence. Then log every 100th occurrence.
   Prevents log volume explosion from repeated client errors.
```

---

### INCIDENT 04 — Missing Timeout + Retries = SQS Worker Freezes

### Symptom

```
SQS queue: user-export-jobs.
Worker: fetches job, calls 3rd-party analytics API, writes CSV to S3.

Normal job processing time: 8–12 seconds.
Queue visibility timeout: 30 seconds.

Wednesday: analytics API suffered extreme slowdown.
           Requests were accepted but responses took 45–120 seconds.

Worker symptoms:
  One task: 0% CPU. Completely frozen. Processing no messages.
  Queue depth: growing. Jobs backing up. No new workers spinning up
  (auto-scaling watches CPU, which was 0, so no scale-out).

Two hours later: analytics API recovered. Worker still frozen.
Needed manual task restart to unfreeze.
```

### Root Cause

```
Worker had no timeout on the analytics API call:
  const data = await analyticsClient.getExportData(userId);
  // No timeout. Waits forever if the server accepts but never responds.

Analytics API accepted the connection (TCP handshake succeeded) but sent no response.
Worker: blocked on `await` for 80 seconds.
Meanwhile: SQS visibility timeout (30s) expired. Message became visible again.
Other workers (there were none at the time) could pick it up.
But this worker: still waiting on the first attempt.
After 80 seconds: analytics API eventually returned 504 response.
Worker retry logic: 504 is retryable. Retry.
Second attempt: also accepted then hung for 60 seconds.
After 60 seconds: 504. Retry again (3rd attempt).
Total time frozen: 80 + 60 + 45 = 185 seconds. 3+ minutes per job.
Single worker. Single connection. Could process no other messages the whole time.
```

### Fix

```
EVERY network call in a worker MUST have a timeout:

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10_000);  // 10s max

  try {
    const data = await analyticsClient.getExportData(userId, {
      signal: controller.signal  // AbortController signal
    });
    clearTimeout(timeoutId);
    return data;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('analytics-api-timeout');  // Will be retried
    }
    throw err;
  }

TOTAL RETRY BUDGET:
  3 attempts × 10s timeout each + backoff = ~35s worst case.
  SQS visibility timeout: 60s (increased to give buffer).
  If all retries fail: throw. SQS redelivers message after visibility timeout.
  After maxReceiveCount: message goes to DLQ for manual investigation.

RULE: timeout per attempt × max attempts < SQS visibility timeout - 10s safety buffer.
  10s × 3 + 15s backoff = 45s. Visibility timeout: 60s. Buffer: 15s.
```

---

## DEBUGGING TOOLKIT

### CloudWatch: Detect Retry Storms

```bash
# Check for sudden spike in request volume (retry storm = volume spike + error spike together):
aws cloudwatch get-metric-statistics \
  --namespace "AWS/ApplicationELB" \
  --metric-name "RequestCount" \
  --dimensions Name=LoadBalancer,Value=<alb-arn> \
  --start-time $(date -u -d "1 hour ago" +%FT%TZ) \
  --end-time $(date -u +%FT%TZ) \
  --period 60 \
  --statistics Sum

# Check 5xx rate alongside request count:
aws cloudwatch get-metric-statistics \
  --namespace "AWS/ApplicationELB" \
  --metric-name "HTTPCode_Target_5XX_Count" \
  --dimensions Name=LoadBalancer,Value=<alb-arn> \
  --start-time $(date -u -d "1 hour ago" +%FT%TZ) \
  --end-time $(date -u +%FT%TZ) \
  --period 60 \
  --statistics Sum

# If RequestCount spikes 3-5× AND 5XX spikes: this is a retry storm.
# Disable retries immediately as emergency mitigation.
```

### Logs Insights: Track Retry Attempt Distribution

```
# Find how many requests needed 0, 1, 2, 3 retries:
fields @timestamp, attempt, error
| filter event = "retry_attempt"
| stats count(*) by attempt
| sort attempt asc
# Normal: very few attempts. If attempt 2 and 3 are common: downstream service degraded.

# Find most common error types causing retries:
fields error
| filter event = "retry_attempt"
| stats count(*) as retries by error
| sort retries desc
| limit 20
```

### Identify Duplicate Requests (Idempotency Issues)

```
# In application logs, find requests with same idempotency key:
fields @timestamp, userId, idempotencyKey
| filter event = "order_created" OR event = "idempotency_key_hit"
| stats count(*) as requests by idempotencyKey
| filter requests > 1
| sort requests desc
# Any key appearing twice = retry/duplicate. Count tells you scale of problem.
```

### Simulate Retry Behavior Locally

```bash
# Use curl to simulate a retryable failure — start a service on port 3001
# Then kill it and see retry behavior from your application:

# Watch connections and timing during retry:
node -e "
const { withRetry } = require('./src/retry');
async function test() {
  const start = Date.now();
  try {
    await withRetry(
      () => fetch('http://localhost:3001/health'),
      { maxAttempts: 3, baseDelayMs: 100, jitter: false }
    );
  } catch(e) {
    console.log('Failed after', Date.now() - start, 'ms:', e.message);
  }
}
test();
"
# Output should show 3 attempts with increasing delay.
# Total time should be ~700ms (100ms + 200ms + ~400ms = ~700ms).
```

## SECTION 6 — System Design Importance

The incident patterns above highlight key system design principles: design for failure, implement graceful degradation, enforce security boundaries at every layer, and monitor proactively. Each incident represents a production scenario that should inform your system design decisions.

## SECTION 7 — AWS & Cloud Mapping

AWS services directly relevant to these patterns: **ECS/Fargate** for container orchestration and task lifecycle management; **ECR** for secure image storage and scanning; **Secrets Manager / SSM Parameter Store** for runtime secret injection; **CloudWatch** for container metrics, logs, and alarms; **IAM** for fine-grained access control.

## SECTION 8 — Interview Preparation

**Beginner:**

**Q: What are transient failures and why should they be retried?**
**A:** A transient failure is a temporary error that resolves on its own â€” the underlying cause is brief and the operation would succeed if tried again moments later. Examples: a brief network blip (TCP connection reset), a database momentarily overloaded (connection timeout), an external API responding slowly (502 from their load balancer during a deploy). These failures are normal in distributed systems, not bugs. Automatically retrying transient failures makes your system more resilient without any changes to the underlying infrastructure. Without retry: one network blip = failed request shown to user. With retry: same blip = transparent brief delay, request succeeds.

**Q: What is an idempotent operation and why must you only retry idempotent operations?**
**A:** An idempotent operation produces the same result regardless of how many times it's called. GET /orders/123 is idempotent â€” calling it 5 times returns the same data, no side effects. POST /payments is NOT idempotent by default â€” retrying a payment that timed out might charge the user twice (the first request succeeded but the response was lost). Before adding retry logic: verify the operation is safe to repeat. For non-idempotent operations: use idempotency keys (client sends a unique ID per transaction; server checks if it's already been processed before executing).

**Q: What is exponential backoff and why is it important for retries?**
**A:** Exponential backoff increases the wait time between retries exponentially: retry 1 after 1s, retry 2 after 2s, retry 3 after 4s, retry 4 after 8s. Without backoff (immediate retry): if 1,000 clients all retry simultaneously after a server overload, they create a "retry storm" â€” peak load exactly when the server is trying to recover. Exponential backoff spreads retries out over time, reducing load on the struggling service. Add jitter (random variation: wait = 2^retryCount Ã— 1000ms + random(0, 500ms)) to prevent synchronized retries from different clients.

---

**Intermediate:**

**Q: What is the difference between retrying at the application layer vs using AWS SDK's built-in retry logic?**
**A:** *AWS SDK built-in:* All AWS SDK calls (S3, SQS, DynamoDB, etc.) have automatic retry with exponential backoff for throttling (429) and transient errors (5xx). Default: 3 retries for most services. You can configure maxAttempts and backoff strategy. This is free and correct â€” don't add additional retry logic on top of AWS SDK calls (double retries = quadruple retry attempts). *Application layer retries:* For your own HTTP API calls to third-party services or other microservices â€” you need to implement retry logic (axios-retry, got's retry option, or manual loop). Pattern: retry on 429, 502, 503, 504; DO NOT retry on 400, 401, 403, 404 (those are your bugs, not transient).

**Q: What is a Dead Letter Queue (DLQ) and how does it work with retry logic for SQS?**
**A:** SQS DLQ is a separate queue that receives messages that repeatedly fail processing. Flow: message arrives in main queue â†’ consumer processes it â†’ consumer throws error â†’ message becomes visible again after visibility timeout â†’ retried (up to maxReceiveCount, e.g., 5 times) â†’ if still failing after 5 attempts â†’ moved to DLQ. The DLQ holds failed messages for manual inspection and replay. Correct setup: (1) Set maxReceiveCount = 3-5. (2) Create DLQ. (3) Configure main queue's RedrivePolicy pointing to DLQ. (4) CloudWatch alarm: DLQ message count > 0 â†’ alert ops team. The DLQ prevents poison messages (malformed payloads) from endlessly retrying and consuming all worker threads.

**Q: What HTTP response codes should trigger a retry and what codes should NOT?**
**A:** *Retry on:* 429 (Too Many Requests â€” rate limited, back off and retry). 500 (Internal Server Error â€” might be transient). 502 (Bad Gateway â€” upstream issue). 503 (Service Unavailable â€” temporary overload). 504 (Gateway Timeout â€” request timed out in transit). *Never retry on:* 400 (Bad Request â€” your request is malformed, retrying won't fix it). 401 (Unauthorized â€” credentials invalid). 403 (Forbidden â€” authenticated but not allowed). 404 (Not Found â€” the resource doesn't exist). 422 (Unprocessable Entity â€” validation error). Retrying 4xx wastes resources and can cause unintended behavior (retrying 400s creates log spam that hides real errors).

---

**Advanced (System Design):**

**Scenario 1:** Design a retry strategy for a payment processing service that calls an external payment gateway. Requirements: (1) Never charge a user twice. (2) Handle timeouts (did the charge happen? we don't know). (3) Handle explicit failure (charge declined â€” don't retry). (4) Handle rate limiting from the payment gateway. Describe the complete flow.

*Strategy:*
(1) *Idempotency key:* before calling gateway, generate unique key (order_id + attempt_number). Store: {key, status: 'pending', created_at} in DB. Send as Idempotency-Key: {key} header to gateway. If retry sent with same key â†’ gateway returns same result without double-charging.

(2) *Timeout handling:* if gateway call times out, state is UNKNOWN. Algorithm: wait 5s, then call gateway GET endpoint to check transaction status by idempotency key. If status = COMPLETED â†’ record success, return. If status = NOT_FOUND â†’ safe to retry with same idempotency key. Never retry a timeout without checking status first.

(3) *Explicit failures (4xx from gateway):* NO retry. card_declined, insufficient_funds, invalid_card_number â†’ return error to user immediately.

(4) *Rate limiting (429):* Exponential backoff with jitter. Respect Retry-After header if provided. Max 4 total attempts over ~1 minute.

**Scenario 2:** Your microservice has retry logic with exponential backoff for calling an internal API. During an incident, the internal API was down for 15 minutes. Logs show your service spawned 50,000 goroutines/async tasks, all stuck retrying, causing your service to also crash. Diagnose the failure and fix the retry implementation.

*Root cause:* Retry storm + no circuit breaker + unlimited concurrent retry tasks. Each incoming request spawned a retry loop, retries stacked up, goroutine count exploded, OOM crash.

*Fixes:*
(1) *Circuit breaker:* after 10 consecutive failures, open circuit â†’ immediately return error for 30s without even trying. This stops spawning retry tasks.
(2) *Retry timeout budget:* each retry loop must complete within a timeout (e.g., 30 seconds total, regardless of retries). Use context with deadline: ctx, cancel := context.WithTimeout(ctx, 30*time.Second).
(3) *Bounded retry concurrency:* use a semaphore or worker pool to limit concurrent retry tasks to N.
(4) *Graceful degradation:* when circuit is open, return a cached/fallback response rather than hanging.
(5) *Bulkhead pattern:* isolate retry worker pool from main request handling â€” retry storms can't consume all threads.

