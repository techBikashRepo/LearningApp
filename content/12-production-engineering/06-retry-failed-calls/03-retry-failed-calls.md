# Retry Failed Calls


> **Architect Training Mode** | Site Reliability Engineer Perspective
> _Retries are not a feature. They are a contract. Before adding retries, answer: "What is the exact behavior when the same call is made twice?"_

---

## SECTION 9 — Certification Focus (AWS SAA-C03)

### Decision 1 — Retry at Which Layer?

```
OPTION A: Retry at the HTTP client layer (low-level, per library config)
  Library: axios-retry, node-fetch with a wrapper, got's retry option

  Pros:
    Zero changes to business logic code.
    Every outbound call retries automatically.

  Cons:
    No business-level context for the retry decision.
    Cannot distinguish "safe to retry" vs "non-idempotent POST."
    Retries ALL errors including 400s (unless carefully configured).
    Cannot implement business-specific fallback logic.

  WHEN TO USE: Third-party APIs with read-only operations (GET requests).
               Situation: adding retries to existing code with minimal change.

OPTION B: Retry in the service layer (withRetry wrapper, per operation)
  What we implemented: withRetry(() => callFraudApi(userId), options)

  Pros:
    Explicit. Each call gets a deliberate retry strategy.
    Business context available for shouldRetry decisions (userId, operation type).
    Can integrate idempotency key generation for each specific operation.

  Cons:
    More verbose. Every external call needs wrapping.
    Risk of missing some calls (inconsistent coverage).

  WHEN TO USE: Core business operations (payments, order creation, email sending).
               Any operation where retry behavior needs to match business rules.

OPTION C: Retry at the message queue level (SQS redelivery)
  Don't retry in code. Let the SQS message become visible again after visibilityTimeout.
  Configure redrive policy: after N failures → DLQ.

  Pros:
    No complex retry code. AWS handles redelivery.
    Natural distributed retry with backoff (each redelivery is delayed).
    Failed messages preserved in DLQ — no data loss.

  Cons:
    Retry delay tied to visibility timeout (minimum retry latency = visibilityTimeout).
    Cannot do fast retries (100ms backoff) — too short for visibility timeout.
    Less control over retry behavior in the moment.

  WHEN TO USE: Async background jobs (export, email sending, report generation).
               Operations where seconds/minutes between retries is acceptable.

THE ANSWER IN PRODUCTION:
  Use all three layers — each solves a different scope:
    Layer 1 (HTTP client): basic network error retry only, fast, 2 max attempts.
    Layer 2 (service): full retry logic with idempotency for business operations.
    Layer 3 (SQS): async jobs — rely on SQS redelivery + DLQ as the safety net.
```

### Decision 2 — How Many Retry Attempts?

```
OPTION A: 1 attempt (no retry)
  Use when: Payment confirmation acknowledgment, any operation that must be
  exactly-once even with idempotency keys (extra safety), calls with long timeouts.

OPTION B: 3 attempts (1 original + 2 retries)  ← DEFAULT
  The pragmatic sweet spot. Reasons:
    95%+ of transient failures resolve within 1–2 retries.
    Exponential backoff with 3 attempts: 100ms + 200ms = 300ms added delay.
    The cost of the 3rd retry rarely pays off vs. the added latency.

OPTION C: 5+ attempts
  Almost never correct for synchronous request-response calls.
  May be appropriate for: background jobs with long retry windows,
  async operations where eventual success matters more than response time.

RULE: For synchronous API calls, default to 3. Justify going higher.
      For async workers, let SQS and DLQ handle long-term retry rather than
      adding many in-code attempts.
```

### Decision 3 — Retry or Fail Fast?

```
Two scenarios where FAILING FAST is better than retrying:

SCENARIO A: Service is clearly down (circuit breaker OPEN)
  Symptom: 100% failure rate for the last 30 seconds.
  Action: fail-fast with circuit breaker. Don't burn time on retries.
  Why: retrying a DOWN service adds latency without improving success rate.
       Meanwhile: caller's resources (connections, memory, thread) are blocked.

SCENARIO B: Non-idempotent operation without idempotency key
  Symptom: POST /api/payment — no Idempotency-Key header.
  Action: execute once. If it fails: return the failure to the caller.
  Why: retrying could create duplicate charges. The caller must handle the failure
       and decide whether to retry (with an idempotency key) or give up.

  Stricter version: reject non-idempotent requests without idempotency keys at the
  gateway level (return 400: "Idempotency-Key header required").

DECISION TREE:
  Critical non-idempotent (payment, order create) → require idempotency key, then retry safely
  Read operation (GET) → retry freely
  Non-critical write → retry with idempotency key
  Error is 4xx (client error) → NEVER retry
  Downstream circuit is OPEN → NEVER retry (fail fast)
  Error is network or 5xx → retry with backoff + jitter
```

---

## SECTION 10 — Comparison Table

**Trap 1 — "Retry all failed requests for resilience"**

```
WRONG: retrying 400 Bad Request is pointless (your request is wrong —
       it will always be 400) and wasteful (CPU burn, log spam).
WRONG: retrying 404 Not Found won't find the missing resource.
WRONG: retrying 401 Unauthorized won't fix your auth token.

RULE: ONLY retry errors that are caused by transient conditions in the downstream service,
      not by problems in your request. 4xx = your problem. Don't retry.
```

**Trap 2 — "I added retries so the service is now resilient"**

```
WRONG: adding retries without idempotency on non-idempotent operations introduces
       a new risk (duplicates) that is often worse than the original problem (failed request).

CORRECT: retries + idempotency together = resilience.
         Retries alone on POST operations = potential data integrity disaster.
```

**Trap 3 — "Exponential backoff prevents thundering herd"**

```
WRONG: exponential backoff without jitter still creates thundering herd.
       Example: 500 requests all fail at t=0. All wait exactly 200ms. All retry at t=200ms.
       The synchronized retry hits the recovering service simultaneously.

CORRECT: exponential backoff WITH JITTER prevents thundering herd by randomizing
         retry timing, spreading the load across a time window.
```

**Trap 4 — "Circuit breaker replaces retries"**

```
WRONG: circuit breaker and retries serve different purposes.
  Retries: handle TRANSIENT failures (brief blips — milliseconds to low seconds).
  Circuit breaker: handle SUSTAINED failures (service DOWN — seconds to minutes).

CORRECT: use both. Retries first (for transient). Circuit breaker opens if sustained.
         While circuit is open: return cached result or fallback immediately.
         Circuit prevents retry storms during sustained outages.
```

**Trap 5 — "Retry timeout doesn't matter"**

```
WRONG: if each retry attempt has no individual timeout, a slow server that accepts
       connections but never responds will hold your connection open indefinitely.
       Three attempts can block your worker for minutes.

CORRECT: every retry attempt must have a per-attempt timeout.
         Total time budget = maxAttempts × perAttemptTimeout + backoff.
         This total MUST fit within the caller's request timeout.
         For SQS workers: total time MUST fit within visibility timeout.
```

**Trap 6 — "I don't need retries — AWS services never fail"**

```
WRONG: even within AWS, transient failures happen:
  DynamoDB: occasional throttling → 400 ProvisionedThroughputExceededException
  S3: eventual consistency issues → 404 immediately after write (race)
  SQS: at-least-once delivery → some messages re-delivered unexpectedly
  EC2: network blips within VPC (rare, but real during maintenance)

AWS SDK has built-in retry with exponential backoff for most services.
You still need YOUR retry logic for your application's outbound HTTP calls.
```

---

## SECTION 11 — Quick Revision

**Q1: "What's the difference between retries and circuit breakers, and when do you use each?"**

```
Retries handle transient failures — problems that resolve on their own within seconds.
Network timeout, brief 503, momentary overload. I retry because the next attempt
likely succeeds. I use exponential backoff with jitter to avoid amplifying load.

Circuit breakers handle sustained failures.
If 50% of calls to the fraud API fail for the last 30 seconds, retrying is just
making things worse — the service is down. The circuit breaker opens and I fail
fast with a fallback response. After a cooldown period, I probe with one call.
If it succeeds, the circuit closes. If not, it stays open.

In production I use both together: retries for transient, circuit breaker for sustained.
They're complementary, not alternatives.
```

**Q2: "A payment service retries a failed charge and the user was charged twice. How do you prevent this?"**

```
This is an idempotency problem.

The fix is deterministic idempotency keys.
Before attempting the charge, the client generates a key tied to the business context —
something like 'payment-{orderId}-{userId}'.
The key is sent with every attempt of the same operation.
Stripe (and other payment providers) accept this key and deduplicate within 24 hours:
if they've already processed a charge with that key, they return the original result.

For our own services, we implement idempotency in Redis:
check if the key exists before processing.
If it does: return cached result.
If not: process and cache the result before returning.

The key insight: the key must be deterministic, not random.
A random UUID as idempotency key generated on each retry defeats the purpose.
```

**Q3: "How would you diagnose a retry storm in production right now?"**

```
I'd look at two metrics together: request volume and error rate.

A retry storm signature: request volume spikes 3–5× while error rate also spikes.
On CloudWatch: ALB RequestCount and HTTPCode_Target_5XX_Count, both spiked together.

Then I check the service emitting retries:
In our application logs on Logs Insights: filter for event = 'retry_attempt',
group by attempt number. If I see a lot of attempt=2 and attempt=3: something downstream
is degraded and we're retrying heavily.

Immediate mitigation: reduce maxAttempts to 1 via an environment variable (if designed
for hot config). That stops the amplification. Then diagnose the root cause.

Longer term: circuit breaker on the troubled dependency prevents this pattern from
ever becoming a full storm.
```

**Q4: "When should you NOT add retries to a call?"**

```
Four situations:

One — client errors (4xx). If the downstream returns 400 or 422, the problem is in
my request. Retrying the exact same request gets the exact same response.
Fix the bug, don't add retries.

Two — non-idempotent operations without idempotency keys.
POST /payment without an idempotency key could double-charge the customer.
Either add idempotency keys first, or treat the failure as final.

Three — when the circuit is open.
The downstream service has been failing for 30 seconds straight.
Retrying is just adding load to a down service. Fail fast with a fallback.

Four — when you've already timed out from the caller's perspective.
If the user's HTTP request has a 5-second timeout and my downstream has already
taken 4.8 seconds, retrying will just keep the connection open past the user's timeout.
Fail fast. The user will retry from their end if needed.
```

---

## SECTION 12 — Architect Thinking Exercise

### The 5 Rules of Retries That Work

```
RULE 1: Retry errors caused by the SERVER, not by YOUR REQUEST.
  Retry 5xx and network errors. Never retry 4xx.
  The question: "Would sending the same request again likely succeed?"
  If the server is broken: yes. If your request is broken: no.

RULE 2: All retries must use exponential backoff with jitter.
  No exceptions. The reason you're adding retries is because the server is under stress.
  Firing retries in synchronized batches adds stress. Jitter distributes it.

RULE 3: Idempotency must come BEFORE retires on non-idempotent operations.
  Design the operation to be safe to repeat, THEN add retries.
  Don't retrofit retries onto an operation that hasn't been made idempotent first.

RULE 4: Every retry attempt needs a timeout, and the total budget must fit in your caller's window.
  3 attempts × 3s timeout + 600ms backoff = ~9.6s.
  If the user's request timeout is 10s: you have 400ms buffer. Barely acceptable.
  Plan the math BEFORE you pick timeout and attempt values.

RULE 5: Pair retries with circuit breakers for external dependencies.
  Retries alone: great for brief blips, catastrophic if the service is down for minutes.
  Circuit breaker: silences the retry noise during a real outage.
  Together: resilience for transient AND sustained failures.
```

### The 3 Mistakes Every Team Makes

```
MISTAKE 1: Treating "retryable" as the default.
  First instinct: "Add retries, it's for resilience."
  Result: 4xx errors retried (wasted CPU), non-idempotent posts retried (duplicates).
  Correct instinct: "Is this specific error type retryable? Am I sure retrying is safe?"

MISTAKE 2: No circuit breaker → retry storm amplifies outages.
  A 2-minute third-party outage becomes a 10-minute cascade because every request
  retried 3× and increased load on everything — including your own service.

MISTAKE 3: Idempotency key is random per request, not deterministic per operation.
  Using crypto.randomUUID() as idempotency key for each attempt generates a new key
  per retry → server sees each retry as a fresh operation → no deduplication.
  Must be deterministic: orderId, userId, cartVersion combined.
```

### 30-Second Answer: "How do you handle retry logic in production?"

```
"For all outbound HTTP calls, I use exponential backoff with jitter — base 100ms,
capping at 3 seconds, maximum 3 attempts.

My shouldRetry function retries network errors (ECONNRESET, ETIMEDOUT) and 5xx
responses. It never retries 4xx — those are client errors that won't resolve on retry.

For non-idempotent operations like payments: I generate deterministic idempotency keys
before firing any request, so retries are safe, and the downstream can deduplicate.

For external dependencies like fraud APIs or payment gateways: I wrap them in circuit
breakers using a 50% error threshold and 30-second cooldown. When the circuit opens,
I return a fallback response immediately instead of retrying into a broken service.

This combination — exponential backoff with jitter, selective shouldRetry, idempotency
keys, and circuit breakers — handles both transient blips and sustained outages without
causing retry storms or data duplication."
```
