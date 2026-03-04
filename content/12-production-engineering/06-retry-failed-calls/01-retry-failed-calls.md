# Retry Failed Calls

## FILE 01 OF 03 — Core Concepts, Retry Patterns & Circuit Breakers

> **Architect Training Mode** | Site Reliability Engineer Perspective
> _Retrying blindly can turn a 5-second outage into a 30-minute cascade. Retrying intelligently turns a 30-minute outage into 5 seconds of blip._

---

## SECTION 1 — Intuition (Explain Like a 12-Year-Old)

```
THE DISTRIBUTED SYSTEM REALITY:
  In any system with network calls, some percentage will fail — not because of bugs,
  but because of transient conditions:
    Network packet loss (happens even in well-configured VPCs)
    DNS resolution blip (AWS Route 53 / VPC DNS: 99.99% uptime, not 100%)
    Downstream service cold start (Lambda cold start, ECS task spinning up)
    Brief database connection drop (RDS maintenance, Multi-AZ failover)
    Load spike causing brief 503 from upstream (service overloaded, then recovers)
    TCP connection timeout (keep-alive reset after idle period)

  These failures are TRANSIENT. They self-resolve within milliseconds to seconds.
  If your code fails the entire request on the first transient failure:
    User gets an error they'd never need to see if you just tried once more.
    Your MTTR for transient failures = "user retries manually" or "user gives up."

WITHOUT RETRIES:
  Payment service calls fraud API. Fraud API has a 30ms cold start blip.
  TCP connection refused. Payment service throws 500 to user.
  User: "My payment failed." Support ticket. Manual processing.

WITH RETRIES (exponential backoff):
  Payment service calls fraud API. Connection refused.
  Wait 100ms. Retry. Fraud API now available. Request succeeds.
  User: never knew anything happened.

THE DANGER: Retries done wrong cause cascades.
  If fraud API is under load (502 errors): retrying immediately amplifies the load.
  Every failed request becomes 5 requests (1 original + 4 retries).
  5× load on an already overloaded service = worse overload = more failures = more retries.
  Retry storm. What was a 10% error rate becomes 100%.
  This is how a localized outage becomes a full system cascade.
```

---

## SECTION 2 — Core Technical Explanation

```
STRATEGY 1: FIXED DELAY (simple, rarely correct)
  Wait T ms. Retry. Wait T ms. Retry.

  Problem: all failed requests retry at the same time.
    1000 requests fail at t=0 due to overload. All wait 1 second. All retry at t=1000.
    1000 simultaneous retries hit the same overloaded service. Amplified overload.
    This is called a thundering herd.

STRATEGY 2: EXPONENTIAL BACKOFF (better)
  Wait T₁. Retry. Wait T₂ (= T₁ × 2). Retry. Wait T₃ (= T₂ × 2). Retry.

  Attempt 1 fails → wait 100ms
  Attempt 2 fails → wait 200ms
  Attempt 3 fails → wait 400ms
  Attempt 4 fails → wait 800ms

  Requests spread out over time. Load on downstream service decreases.
  Problem: if all requests started at the same time, the doubling pattern creates
  synchronized spikes at 100ms, 200ms, 400ms etc. Still somewhat synchronized.

STRATEGY 3: EXPONENTIAL BACKOFF WITH JITTER (correct)
  Add random noise to break synchronization:

  Wait = base × 2^attempt + random(0, base)

  Attempt 1 fails → wait 100 + random(0-100) = e.g. 147ms
  Attempt 2 fails → wait 200 + random(0-100) = e.g. 251ms
  Attempt 3 fails → wait 400 + random(0-100) = e.g. 463ms

  1000 failed requests now spread their retries across a time window instead of hitting
  simultaneously. Downstream service sees a gradual trickle rather than a synchronized spike.

  This is what AWS SDK does internally. It's the AWS recommended retry strategy.

FULL JITTER (even better):
  Wait = random(0, min(maxDelay, base × 2^attempt))

  Completely random within the exponential ceiling. Maximum distribution.
```

---

## SECTION 3 — Architecture Diagram (MANDATORY)

```typescript
// retry.ts — production-ready retry utility

interface RetryOptions {
  maxAttempts: number; // total attempts including the first
  baseDelayMs: number; // starting delay (doubles each attempt)
  maxDelayMs: number; // cap on exponential growth
  jitter: boolean; // add randomness to prevent thundering herd
  shouldRetry?: (err: Error, attempt: number) => boolean; // custom retry decision
}

const DEFAULT_OPTIONS: RetryOptions = {
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 3000,
  jitter: true,
};

function calculateDelay(attempt: number, opts: RetryOptions): number {
  const exponential = opts.baseDelayMs * Math.pow(2, attempt - 1); // attempt 1=100, 2=200, 3=400
  const capped = Math.min(exponential, opts.maxDelayMs);

  if (opts.jitter) {
    // Full jitter: random between 0 and the capped value
    return Math.random() * capped;
  }
  return capped;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: Partial<RetryOptions> = {},
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: Error;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;

      // Check if this error type is retryable:
      if (opts.shouldRetry && !opts.shouldRetry(err, attempt)) {
        throw err; // Non-retryable error, fail immediately
      }

      // Don't wait after the final attempt:
      if (attempt === opts.maxAttempts) break;

      const delay = calculateDelay(attempt, opts);

      logger.warn({
        event: "retry_attempt",
        attempt,
        maxAttempts: opts.maxAttempts,
        delayMs: Math.round(delay),
        error: err.message,
      });

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError!;
}

// ── WHICH ERRORS SHOULD BE RETRIED? ──────────────
function isRetryableHttpError(err: any, attempt: number): boolean {
  if (attempt >= 3) return false; // never retry more than 3 total attempts

  // Network errors — always retryable (transient):
  if (err.code === "ECONNREFUSED") return true;
  if (err.code === "ECONNRESET") return true;
  if (err.code === "ETIMEDOUT") return true;
  if (err.code === "ENOTFOUND") return true; // DNS blip

  // HTTP status codes:
  const status = err.response?.status ?? err.status;
  if (status === 429) return true; // Too Many Requests — retry after backoff
  if (status === 503) return true; // Service Unavailable — transient
  if (status === 502) return true; // Bad Gateway — upstream blip
  if (status === 504) return true; // Gateway Timeout — upstream slow

  // Do NOT retry:
  if (status === 400) return false; // Bad Request — our fault, retrying won't help
  if (status === 401) return false; // Unauthorized — auth issue, not transient
  if (status === 403) return false; // Forbidden — permission issue
  if (status === 404) return false; // Not Found — won't appear on retry
  if (status === 422) return false; // Unprocessable Entity — validation error
  if (status >= 400 && status < 500) return false; // All 4xx: client errors
  if (status >= 500) return true; // 5xx: server errors, potentially retryable

  return false;
}

// ── USAGE EXAMPLES ────────────────────────────────

// Simple: retry up to 3 times with defaults:
const result = await withRetry(() =>
  fetch("https://api.stripe.com/v1/charges", {
    method: "POST",
    body: JSON.stringify(chargeData),
  }),
);

// Advanced: custom retry decision:
const fraudResult = await withRetry(() => fraudApiClient.check(userId), {
  maxAttempts: 4,
  baseDelayMs: 200,
  maxDelayMs: 5000,
  jitter: true,
  shouldRetry: isRetryableHttpError,
});
```

---

## SECTION 4 — Request Flow (MANDATORY FLOWCHART)

```
WHAT IT SOLVES:
  Retries on every request are good for transient failures.
  But if a downstream service is DOWN for 5 minutes:
    Every request to it retries 3 times = 3× load on a broken service.
    Each request waits much longer (base + retries = 700ms+ instead of 20ms).
    Your service becomes slow because it's waiting on a dead dependency.
    Circuit breaker detects "X% of calls failing" → OPENS.
    While open: fail-fast immediately without calling the broken service.
    After a "cooldown" period: try again (half-open). If succeeds: close the circuit.

CIRCUIT BREAKER STATES:
  CLOSED  → Normal operation. Requests flow through freely.
  OPEN    → Too many failures. Fail immediately without calling downstream.
  HALF-OPEN → Cooldown expired. Let one request through as a test.
              If it succeeds: CLOSE the circuit.
              If it fails: OPEN again (reset the cooldown timer).

IMPLEMENTATION (using 'opossum' library):

  import CircuitBreaker from 'opossum';

  const fraudApiCircuit = new CircuitBreaker(
    async (userId: string) => fraudApiClient.check(userId),
    {
      timeout: 3000,              // calls exceeding 3s count as failures
      errorThresholdPercentage: 50,  // open when 50% of requests fail
      resetTimeout: 30_000,       // try again after 30 seconds (half-open)
      volumeThreshold: 10,        // need at least 10 requests before circuit can open
      // (prevents opening on first 1-2 failures at startup)
    }
  );

  // Handle the fallback (what to do when circuit is open):
  fraudApiCircuit.fallback((userId: string) => ({
    riskScore: null,
    bypassed: true,
    reason: 'fraud-api-unavailable',
    // Degrade gracefully: flag for manual review rather than blocking the user.
  }));

  // Monitor state changes:
  fraudApiCircuit.on('open', () =>
    logger.warn({ event: 'circuit_breaker_opened', circuit: 'fraud-api' })
  );
  fraudApiCircuit.on('close', () =>
    logger.info({ event: 'circuit_breaker_closed', circuit: 'fraud-api' })
  );
  fraudApiCircuit.on('halfOpen', () =>
    logger.info({ event: 'circuit_breaker_half_open', circuit: 'fraud-api' })
  );

  // Usage:
  const fraudCheck = await fraudApiCircuit.fire(userId);

WHEN TO USE CIRCUIT BREAKERS:
  ✅ Calls to external third-party APIs (Stripe, SendGrid, Twilio)
  ✅ Calls to other internal microservices you don't control
  ✅ Any non-critical dependency where degraded operation is acceptable
  ❌ Database queries (use connection pool timeout instead)
  ❌ Calls you CANNOT skip (payment capture — you must know if it succeeded)
```

---

### Idempotency: Required for Safe Retries

```
THE PROBLEM WITH NON-IDEMPOTENT OPERATIONS:
  Idempotent = calling it multiple times produces the same result as calling it once.
    GET /users/123 → always returns the same user. Safe to retry.
    DELETE /users/123 → deletes once. Second call returns 404. Already done. Safe.

  Non-idempotent:
    POST /payments → creates a charge.
    If the network drops AFTER Stripe processes the charge but BEFORE you get the response:
    You don't know if the charge succeeded.
    Retry → second charge → duplicate.
    User is charged twice.

IDEMPOTENCY KEY PATTERN:
  Client generates a unique key before the operation.
  Sends it with every attempt of the same operation.
  Server: if key already seen → return the cached result. Don't process again.

  // Client side:
  const idempotencyKey = `pay-${orderId}-${userId}`;  // deterministic key

  // Stripe (built-in support):
  const charge = await stripe.paymentIntents.create(
    { amount: 1000, currency: 'usd' },
    { idempotencyKey }  // Stripe deduplicates within 24h
  );

  // Your own API (implement it):
  // POST /api/orders with header: Idempotency-Key: <uuid>

  // Server side:
  app.post('/api/orders', async (req, res) => {
    const idempotencyKey = req.headers['idempotency-key'];
    if (!idempotencyKey) return res.status(400).json({ error: 'Idempotency-Key required' });

    // Check Redis/DB for previous result:
    const cached = await redis.get(`idem:${idempotencyKey}`);
    if (cached) {
      logger.info({ event: 'idempotency_key_hit', key: idempotencyKey });
      return res.status(200).json(JSON.parse(cached));
    }

    // Process the order:
    const order = await createOrder(req.body);

    // Cache the result (expire after 24 hours):
    await redis.setex(`idem:${idempotencyKey}`, 86400, JSON.stringify(order));

    res.status(201).json(order);
  });

RULE: Every non-idempotent operation that can be retried MUST have idempotency keys.
Payments, order creation, email sending, file creation — all need it.
```

---

### Production Readiness Checklist

```
RETRY STRATEGY
  [ ] All external HTTP calls wrapped in retry utility
  [ ] Using exponential backoff with jitter (not fixed delay)
  [ ] maxAttempts cap (3 is usually correct; never more than 5)
  [ ] Should-retry logic: 4xx errors NOT retried, 5xx and network errors retried
  [ ] Retry attempts logged at WARN level with attempt number
  [ ] Total retry timeout < upstream service's request timeout

CIRCUIT BREAKER
  [ ] Circuit breakers on external service calls (non-critical dependencies)
  [ ] Fallback defined for each circuit (graceful degradation behavior)
  [ ] Circuit state changes logged (open/close/half-open events)
  [ ] Circuit state metrics emitted to CloudWatch (for alerting on persistent opens)

IDEMPOTENCY
  [ ] All non-idempotent operations (payments, order creation) have idempotency keys
  [ ] Keys deterministic and derived from business context (not random per retry)
  [ ] Idempotency store (Redis or DB) with appropriate TTL (24h for payments)
  [ ] GET and DELETE operations verified as idempotent by design
```
