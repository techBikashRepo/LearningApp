# HTTP Status Codes — Part 2 of 3

### Topic: HTTP Status Codes in Production Systems and AWS

**Series:** Networking Fundamentals → System Design → AWS Solutions Architect
**Sections Covered:** 5, 6, 7, 8

---

## SECTION 5 — Real World Examples

### Analogy 1 — The Hospital Triage System

A hospital triage nurse uses codes to communicate patient status:

- **200:** Patient treated, discharged, all good
- **202:** Patient checked in, treatment scheduled, come back later
- **301:** Patient moved to new wing permanently — update your map
- **400:** Your paperwork is incomplete — fill in required fields
- **401:** No hospital wristband — register at reception first
- **403:** Authorized staff only — this ward requires surgeon privileges
- **404:** That patient was never here
- **503:** Emergency situation, no capacity — try clinic down the road
- **504:** On-call specialist didn't respond within required window

The hospital analogy conveys the most important production fact: 4xx codes are like paperwork errors (your fault, fix the form). 5xx codes are like hospital equipment failures (our fault, we're on it). Your PagerDuty alert severity should differ: 5xx = wake someone up, 4xx = investigate patterns in business hours.

### Analogy 2 — The Automated Parcel Locker

A self-service parcel locker at an apartment building:

- **200:** Parcel retrieved successfully
- **201:** Parcel deposited, locker #7 reserved
- **204:** Setting saved, no further info
- **304:** "Nothing new since you last checked" (you have the latest package)
- **401:** No code entered — scan your key card
- **403:** Wrong code — you're not the recipient
- **404:** No parcel for this apartment number
- **429:** You've tried 5 wrong codes — locked out for 15 minutes
- **503:** Locker system rebooting — try again in 5 minutes
- **504:** Parcel delivery service not responding to locker's inventory query

### Real Software Example — GitHub API Error Handling

GitHub's REST API demonstrates best-practice status code usage:

```
Repository access:
  GET /repos/owner/private-repo  (unauthenticated)
  → 404 Not Found                (NOT 403 — hides that the repo exists)

  GET /repos/owner/private-repo  (authenticated, different user)
  → 404 Not Found                (still 404 — security by obscurity for private repos)

  GET /repos/owner/private-repo  (authenticated, correct user)
  → 200 OK + repo data

Fork a repository:
  POST /repos/owner/repo/forks
  → 202 Accepted                 (async operation — forking takes time)
  → Poll: GET /users/me/repos until new fork appears

Rate limiting:
  Any API call when quota exhausted:
  → 429 Too Many Requests
  X-RateLimit-Limit: 5000
  X-RateLimit-Remaining: 0
  X-RateLimit-Reset: 1740290400
  X-RateLimit-Resource: core
  Retry-After: 3600

  (Unauthenticated: 60/hour; Authenticated: 5000/hour; GitHub Apps: 15,000/hour)

Search API secondary limit:
  GET /search/repositories?q=nodejs  (too many search requests)
  → 403 Forbidden                    (!) GitHub uses 403 for search abuse, not 429
  {"message": "API rate limit exceeded for search"}

  Note: GitHub inconsistency (403 vs 429 for rate limiting) is a real API design
  imperfection — use 429 with Retry-After for rate limiting in new APIs.

Repository creation conflict:
  POST /user/repos {"name": "my-project"}  (repo already exists)
  → 422 Unprocessable Entity
  {"message": "Repository creation failed.", "errors": [{"resource":"Repository","code":"custom","message":"name already exists on this account"}]}
```

---

## SECTION 6 — System Design Importance

### 1. Status Code Classes for Monitoring Dashboards

Status codes are the language of observability:

```
Production monitoring tiers:

CRITICAL (P1 alert — wake team):
  5xx rate > 1% of requests
  503 Service Unavailable (all backends down)
  504 Gateway Timeout spike (DB overload, external API degraded)

WARNING (P2 — investigate within the hour):
  500 Internal Server Error > baseline
  502 Bad Gateway (individual backend crashing, not all)
  4xx error codes for APIs (may indicate broken client release)

INFO (P3 — review in business hours):
  401 spike (expired tokens, client-side issue)
  429 spike (usage pattern change, possible abuse)
  404 spike (bad link in newsletter, SEO issue)
  400 spike (API client sending malformed data after update)

WHY separate 4xx vs 5xx alerts:
  4xx = clients making bad requests = not our server's fault
  5xx = our servers failing = our fault, needs immediate fix

  If you alert on all errors: you'll drown in 404s from web crawlers and
  have alert fatigue before real 5xx issues are noticed
```

### 2. Error Response Body Design

A status code alone is not enough in production. Error bodies must contain:

```json
{
  "status": 422,
  "error": "Validation Failed",
  "message": "The submitted order data contains errors",
  "errors": [
    {
      "field": "quantity",
      "code": "INVALID_RANGE",
      "message": "Quantity must be between 1 and 100",
      "value": -1
    },
    {
      "field": "product_id",
      "code": "NOT_FOUND",
      "message": "Product with ID 99999 does not exist"
    }
  ],
  "trace_id": "7f3d9a12-4c6e-4a8b-9b3c-1234567890ab",
  "docs_url": "https://docs.api.shop.com/errors/INVALID_RANGE",
  "timestamp": "2026-02-23T10:00:00Z"
}
```

Why each field matters:

- `status`: redundant with HTTP code but useful when response is parsed outside HTTP context (queue message, log line)
- `error`: human-readable summary
- `errors` array: multiple field errors in one response (user sees all issues at once, not one at a time)
- `trace_id`: correlate with server logs (client pastes this in support ticket → engineer finds the log)
- `docs_url`: self-documenting API (client/SDK reads link automatically)
- `timestamp`: useful for debugging timezone/refresh issues

**Never expose:**

```json
{
  "error": "NullPointerException at ProductService.java:142",
  "stack": "java.lang.NullPointerException\n\tat com.shop.ProductService.getProduct(ProductService.java:142)..."
}
```

Stack traces reveal internal architecture, technology stack, and vulnerability surface. Return 500 with `trace_id` only; log the full stack trace server-side.

### 3. Retry Safety by Status Code

```
SAFE to auto-retry (client middleware can retry transparently):
  429 Too Many Requests  → wait Retry-After seconds, then retry
  503 Service Unavailable → exponential backoff (1s, 2s, 4s, 8s, max 64s)
  502 Bad Gateway        → retry immediately (load balancer picks different backend)

UNSAFE to auto-retry without idempotent semantics:
  504 Gateway Timeout    → backend MAY have processed → check state before retry
  500 Internal Server Error → may or may not have processed → implement idempotency

NEVER auto-retry:
  400 Bad Request        → your request is broken; retry with same body = same 400
  401 Unauthorized       → get a new token first, then retry
  403 Forbidden          → escalate permissions; retry = same 403
  404 Not Found          → resource doesn't exist; retry = same 404
  422 Unprocessable      → fix validation errors; retry = same 422

AWS SDK retry behavior:
  By default, AWS SDKs retry: 5xx errors | 429 | socket timeouts
  They do NOT retry: 4xx errors (except 429 with Retry-After)
  SDK retry uses exponential backoff with jitter:
    sleep = min(cap, base * 2^retryAttempt) + random_jitter
```

### 4. Circuit Breaker and Status Codes

Circuit breakers in microservices use status codes to track failure rates:

```
Downstream service (payment-service) is degraded:
  Returns 503 intermittently

Your order-service with circuit breaker (e.g., Resilience4j):
  CLOSED state (normal):
    Call payment-service → 503? Record failure.
    10 failures in 30 seconds → trip to OPEN state

  OPEN state:
    Do NOT call payment-service at all
    Return 503 to your clients immediately (fail-fast)
    After 30s: try one probe request (HALF-OPEN)

  HALF-OPEN state:
    One test call → 200? Close circuit (normal again)
                → 503? Open circuit again (still broken)

Status code logic:
  5xx → failure (contribute to trip threshold)
  429 → failure (overloaded → failing)
  401 → do NOT trip circuit (auth issue, not service health)
  404 → do NOT trip circuit (not found is expected for some queries)

Fine-grained circuit breaking:
  Different error types need different circuit breakers:
  GET /products → 404 = normal (products can legitimately not exist)
  POST /payments → 500 = critical (payment system error)
```

### 5. HTTP Status Codes in Webhooks and Event Systems

Webhooks are HTTP callbacks from external services to your endpoint:

```
External service (Stripe, GitHub, Slack) sends:
  POST https://your-app.com/webhooks/stripe
  Body: {"type": "payment.succeeded", "data": {...}}

Your expected response:
  200 OK (or 2xx) → "Got it, thanks."
  Non-200 → External service: "Failed. Will retry."

Timeout without response (> 10-30s) → External service: "Failed. Will retry."

Retry behavior of common webhook providers:
  Stripe:   Retries up to 72 hours (exponential backoff, ~3, 5, 10, 25... hours)
  GitHub:   Retries 3 times within ~10 seconds
  Twilio:   Retries 4 times within 24 hours

Critical rule: Return 200 IMMEDIATELY, process asynchronously:
  POST /webhooks/stripe
  1. Validate webhook signature (verify Stripe-Signature header)
  2. Return 200 OK immediately (< 5 seconds)
  3. Enqueue event to SQS for async processing

  If you do it wrong:
  1. Process synchronously (DB write, send email)
  2. Processing takes 20 seconds
  3. Stripe times out (10 second limit)
  4. Stripe marks as failed and retries → your handler processes TWICE
  5. Customer receives two "thank you" emails, or payment processed twice
```

---

## SECTION 7 — AWS Mapping

### ALB Status Code Origins

ALB introduces its own status codes that differ from backend codes:

```
ALB-GENERATED (backend NOT involved):
  503: No healthy targets in target group
  503: All targets failed health checks
  503: Target group deregistered during shutdown (deregistration delay = 300s)
  504: ALB waited 60s for target, no response (idle timeout)
  400: Malformed HTTP request from client
  400: TLS handshake failure (cert mismatch, TLS version not supported)
  403: WAF rule blocked the request (with AWS WAF attached to ALB)

FORWARDED FROM BACKEND:
  500: Backend application threw unhandled exception
  502: Backend crashed mid-response or returned malformed HTTP
  Any 4xx: Backend returned it (ALB forwards transparently)

How to distinguish ALB 502/503 vs backend 502/503 in logs:
  ALB access log field "target_status_code" = "-" → ALB generated (no backend involved)
  ALB access log field "target_status_code" = "502" → backend returned 502 to ALB
```

### CloudFront Status Codes

```
CloudFront custom error pages:
  Cache 404 and 503 pages at edge for unavailable origins:

  Distribution → Error Pages settings:
    Error Code: 404 → Response Page Path: /error/404.html → Response Code: 200
    Error Code: 502 → Response Page Path: /error/maintenance.html → Response Code: 503

    Cache TTL: 300 (cache error page for 5 minutes)
    5 minutes of 503 cached at edge = 5 minutes without hitting dead origin
    (This is your "down for maintenance" page served at CDN speed)

CloudFront returns 504 when:
  - Origin request takes longer than CloudFront origin response timeout (60 seconds default)
  - Configurable: 1-60 seconds

CloudFront 403:
  - IAM policy blocks CloudFront from S3 bucket (missing OAI/OAC policy on bucket)
  - Signed URL/cookie required but not provided
  - Geographic restriction (GeoRestriction) blocked the request

CloudFront 400:
  - SSL/TLS negotiation failure (client doesn't support any cipher suite)
  - Request headers exceed maximum allowed size
```

### API Gateway Status Codes

```
API Gateway adds its own 4xx and 5xx codes:
  401: Lambda Authorizer returned isAuthorized=false
       OR JWT validation failed (HTTP API JWT Authorizer)
  403: Authorizer returned explicit deny OR request throttled (account limit)
  429: Usage plan quota exceeded OR burst limit reached
       X-Amzn-RequestId: present in headers for debugging
  500: Lambda function itself threw an error
       Lambda integration error response (malformed proxy response)
  502: Lambda returned response not matching API Gateway proxy format
       {statusCode, headers, body} must all be present and correct
  504: Integration timeout exceeded (Lambda ran too long)
       HTTP API: 30 seconds; REST API: 29 seconds

Integration response format (Lambda MUST return this for API Gateway):
{
  "statusCode": 200,            (must be integer, not string)
  "headers": {
    "Content-Type": "application/json"
  },
  "body": "{\"key\": \"value\"}" (must be string! JSON.stringify your object)
}

Missing any field → API Gateway returns 502 to client
Body must be string (not object) → not stringifying = 502
```

---

## SECTION 8 — Interview Q&As

### Beginner Questions

**Q1: What is the difference between 401 and 403?**

A: Despite common confusion, 401 and 403 answer different questions:

401 Unauthorized (better named "Unauthenticated"): "I don't know who you are. Please authenticate." The client has not provided credentials or the provided credentials are invalid/expired. The server CANNOT determine if the user would have permission because it doesn't know who they are. RFC 7235 requires a `WWW-Authenticate` header in the response, telling clients how to authenticate (e.g., `Bearer` scheme, realm). Providing valid credentials and retrying may succeed.

403 Forbidden: "I know exactly who you are, but you're not allowed to do this." The user successfully authenticated (valid JWT, verified session), but their role/permission doesn't include the requested resource or operation. Retrying with the same credentials will not help — the user needs elevated permissions granted by an administrator.

Rule of thumb: 401 = "who are you?", 403 = "I know you, but no."

Security note: For private resources, prefer 404 over 403 — revealing that a resource exists (even if the user can't access it) can be an information leak.

**Q2: When should you use 202 instead of 201?**

A: Use 202 Accepted when the request has been received but processing is asynchronous — the result is not yet available.

Use 201 Created when the resource creation is complete synchronously and the resource is immediately accessible at the URL in the `Location` header.

Example: `POST /invoices` → synchronous DB insert → return 201 + `Location: /invoices/789`. The invoice exists at that URL immediately.

Example: `POST /video-transcodes` → queued for processing, transcoding takes 30 minutes → return 202 + `Location: /jobs/status/abc123`. The video isn't available yet; the client polls the status URL.

202 should always include a way to check status: a `Location` header for polling or a way to receive a webhook callback when complete.

**Q3: What is the correct status code for a deleted resource that was previously available?**

A: Use 410 Gone (not 404) for resources that have been permanently and intentionally deleted. 410 carries stronger semantic meaning: "This resource existed here, was intentionally removed, and will not come back." This instructs:

- Search engine crawlers: remove this URL from the index permanently
- CDNs: do not wait for this resource to reappear
- Clients: update bookmarks/links (this URL is dead)

404 Not Found is appropriate for: resources that never existed, resources whose existence is unknown, or resources that may come back online.

In practice, implementing 410 requires storing deleted resource IDs to distinguish from never-existed. The operational overhead is sometimes not worth it for small services. Large content platforms (YouTube for deleted videos, Twitter for deleted tweets) correctly return 410.

### Intermediate Questions

**Q4: Your ALB is returning 504 errors for some requests. How do you diagnose the root cause?**

A: 504 Gateway Timeout from ALB means the ALB waited for a backend target response but didn't receive it within the idle timeout (default 60 seconds). Diagnosis steps:

**Check which targets are involved:**

```
ALB Access Logs → filter "elb_status_code"="504"
  Look at: target_status_code ("-" means ALB generated, no backend response)
  Look at: target (IP:port of the backend that timed out)
  Look at: target_processing_time (seconds ALB waited)
```

**Find the slow operation:**

```
If target_processing_time ≈ 60 (ALB timeout):
  → Backend is hitting 60s ALB ceiling
  → Identify the slow operation: DB query, external API, heavy computation

Application logs on the target EC2:
  Correlate by X-Amzn-Trace-ID (ALB injects this, propagate through app)
  Find requests that started but never completed within 60s
```

**Common root causes:**

1. Slow DB query (missing index, query plan regression after data growth)
2. External API call with no timeout configured (hangs indefinitely)
3. N+1 query problem exploded at scale (100 DB calls per request at peak)
4. Memory pressure causing GC pauses chaining beyond 60s total
5. Thread pool saturation: all threads blocked → new requests never start processing

**Fixes:**

- Immediate: increase ALB idle timeout (buys time, not a fix)
- Short-term: add DB indexes, add timeouts to all external calls
- Architecture: async processing (202 pattern) for long operations, circuit breakers for external APIs

**Q5: What is the semantic difference between 400 Bad Request and 422 Unprocessable Entity?**

A: Both indicate client error, but at different validation layers:

400 Bad Request: The server could not parse/understand the request itself. Examples: malformed JSON (missing closing brace), invalid Content-Type (server expects JSON, gets HTML), wrong HTTP structure. The request is syntactically invalid before business logic even runs.

422 Unprocessable Entity: The request was correctly formed and parseable, but the content fails semantic validation. Examples: required field missing, value out of range, reference to non-existent resource, business rule violation (can't order more than inventory). The server understood the request perfectly but the VALUES inside it are logically invalid.

In practice: most REST APIs return 400 for both, which is acceptable. Using 422 specifically for validation errors improves client developer experience — it signals "your payload is structurally fine but the data is wrong." Spring Boot Validation and Rails both return 422 for validation failures by default.

**Q6: What does it mean when a webhook returns 200 but has already been processed? Should you return 200 or 409?**

A: Return 200 OK. Always.

Webhook providers don't distinguish between "processed now" vs "already processed." They only care that you received the event. If you return 409 Conflict (or any non-2xx), the provider will retry and you'll process twice.

The correct pattern: idempotency in your handler:

```python
def handle_stripe_webhook(event):
    event_id = event['id']

    # Idempotent check
    if event_processed(event_id):
        return 200, {"status": "already processed"}  # Return 200! Not 409.

    # Process the event
    process_payment_succeeded(event['data'])
    mark_event_processed(event_id)

    return 200, {"status": "ok"}
```

The idempotency logic is YOUR responsibility in the handler. The HTTP response to the webhook provider must always be 2xx to prevent retries.

### Advanced System Design Questions

**Q7: Design an API error handling strategy for a mobile checkout API that minimizes bad user experience and prevents double-processing. Cover all relevant status codes.**

A: Full error handling strategy:

**For each status code, define client behavior:**

```
200 OK:        → Show success, navigate to confirmation page
201 Created:   → Extract Location header, show order summary
202 Accepted:  → Show "Order received, processing..." with job ID, poll status
204 No Content:→ Operation done, close modal

400 Bad Request:  → Show form errors from body['errors'] (highlight specific fields)
                    Do NOT retry automatically
401 Unauthorized: → Refresh JWT token silently, retry once
                    If refresh fails: redirect to login screen
403 Forbidden:   → Show "Access denied" message, do NOT retry
404 Not Found:   → Show "Not found" — offer search or homepage
409 Conflict:    → Show specific conflict message (item out of stock, email taken)
422 Validation:  → Highlight all errored fields with messages from body['errors']
429 Too Many:    → Show "Please wait Xs before retrying" (read Retry-After header)
                   Disable submit button until timer expires

500 Internal:   → Show generic "Something went wrong. Your cart is saved."
                   Log error with trace_id
                   Offer retry button (not auto-retry)
502 Bad Gateway: → Same as 500; may succeed on retry (different backend)
                   Auto-retry with exponential backoff (1x, 2x times)
503 Unavailable: → Show "Service temporarily busy. Retry in Xs" (Retry-After header)
                   Auto-retry respecting Retry-After
504 Timeout:    → DANGER: do NOT auto-retry the payment POST!
                   Show: "Your order may have been placed. Check your order history at {link}"
                   Auto-navigate to GET /orders to check if order exists
```

**Q8: You see a sudden spike in 502 errors from ALB. 503s are normal but low. What does the pattern tell you, and how do you resolve it?**

A: The key distinction: 503 vs 502 from ALB tells you where the failure is occurring.

503 Service Unavailable from ALB = **no healthy targets** (health checks failing, all targets in unhealthy state).
502 Bad Gateway from ALB = **target responded but with invalid/malformed HTTP** (target is alive but its response confused ALB).

502 spike typically means:

1. A bad deployment is returning malformed HTTP responses (e.g., Express.js middleware bug ending response incorrectly)
2. Application throwing an exception after partial response headers were sent (response body corrupted)
3. Memory exhaustion causing a crash mid-response (partial response written, then connection dropped)
4. Application server using wrong HTTP version framing

Diagnosis:

```
ALB access logs: target_status_code for these requests?
  "-" → Application crashed or closed connection without sending HTTP response
  Actual code → Application is returning something but ALB can't parse it

EC2 target logs: Any unhandled exceptions? OOM kills?
  sudo journalctl -u myapp --since "10:00" | grep -i "error\|exception\|killed"

Memory: free -h on affected instances → is application hitting memory limit?
  OOMKiller in /var/log/kern.log
```

Fix: roll back the problematic deployment, fix the response formatting bug, or add memory limits to prevent OOM. Add CloudWatch Alarm: when 502 count > 10 in 1 minute → notify + trigger auto-rollback of most recent CodeDeploy deployment.

---

## File Summary

This file covered:

- Hospital triage and parcel locker analogies (4xx = your paperwork, 5xx = our equipment)
- GitHub API real-world example: 404 for private repos (hide existence), 202 for async forking, 429 with rate-limit headers
- Monitoring tiers: P1 alert on 5xx, P2 on sustained 502, P3 on 4xx pattern analysis
- Error response body design: status, error, errors[], trace_id, docs_url (never expose stack traces)
- Retry safety map: 429/503/502 = safe; 504 = unsafe (check state first); 4xx = never retry
- Circuit breaker status code logic: 5xx trips circuit, 401/404 do not (expected errors)
- Webhooks: always return 200; idempotency in handler prevents duplicate processing
- AWS ALB 502 vs 503 vs 504 origins; CloudFront 403 from IAM/OAI misconfiguration; API Gateway 502 from malformed Lambda proxy response
- 8 Q&As: 401 vs 403, 202 vs 201, 410 vs 404, ALB 504 diagnosis, 400 vs 422, webhook 200 strategy

**Continue to File 03** for AWS SAA certification traps, 5 comparison tables, Quick Revision mnemonics, and Architect Exercise: diagnosing a production incident where 502 errors spike after every deployment.
