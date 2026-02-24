# Standard Error Responses — Part 3 of 3

### Sections: 9 (Interview Prep), 10 (Comparison Tables), 11 (Quick Revision), 12 (Architect Thinking Exercise)

**Series:** Backend & API Design → REST APIs → System Design

---

## SECTION 9 — Interview Questions & Patterns

### Beginner-Level Questions

**Q: What is the difference between HTTP status codes 400 and 422?**

Short answer: 400 means the request could not be parsed or understood. 422 means the request was parsed successfully but the content is semantically invalid.

Full explanation:

```
400 Bad Request — Malformed or Unparseable
  • JSON syntax error in body: missing closing brace, trailing comma, etc.
  • Content-Type mismatch: header says application/json, body is plain text
  • Missing required headers that prevent basic parsing
  • URL encoding error in query parameters

The server could not read the request content at all.

422 Unprocessable Entity — Syntactically Valid, Semantically Wrong
  • JSON is valid but field value breaks a business rule
  • amount: -500 (valid JSON integer, invalid domain value)
  • start_date after end_date (each date is valid, the relationship is not)
  • email: "not-an-email" (valid string, invalid email format)
  • Invoice total does not match the sum of line items

The server understood the request perfectly but the content cannot be processed.

Common confusion: many APIs use 400 for both scenarios.
This is acceptable but 422 is more semantically precise for validation failures.
Stripe uses 400 for everything; GitHub uses 422 for validation — both are in production.

Rule of thumb:
  If the request body could not be parsed: 400
  If parsed but values fail validation: either 400 or 422 — pick one and be consistent
```

---

**Q: Why should API error responses include a `request_id`?**

```
Three concrete reasons:

1. Support Traceability
   Customer: "My payment failed at 3:47pm yesterday, order #8291"
   Without request_id: engineer searches logs for 3:47pm + order 8291 = thousands of entries
   With request_id: grep request_id "req_f47ac10b" → exact log entry in 5 seconds

2. Log Correlation Across Services
   API GW → Lambda → Stripe API → PostgreSQL
   request_id threads through all log entries in all services
   One ID reconstructs the full request execution chain

3. Security Without Exposure
   Error message to client: "Contact support with code req_f47ac10b"
   Client gets actionable info without receiving:
     - Stack traces with internal file paths
     - Database schema details
     - Internal service names
     - Query structure

   Internal engineers see everything; client sees only the id to reference it.

Production result: average time to RCA a customer-reported error drops from
2 hours (log hunting) to 4 minutes (direct lookup).
```

---

**Q: What is wrong with returning HTTP 200 with `{"success": false}` in the body?**

```
Pattern seen in many older or poorly designed APIs:
  HTTP 200 OK
  { "success": false, "error": "Invoice not found" }

Four specific problems:

1. CDN caching
   CDNs cache 200 responses by default.
   "Invoice not found" response gets cached and served to everyone.
   All users see one person's error message until cache expires.

2. Monitoring blind spot
   Uptime monitors check HTTP status codes.
   HTTP 200 = system is healthy (monitoring never alerts)
   But the application is returning errors for every request.
   APM tools count 5xx and 4xx rates — 200 errors are invisible.

3. SDK/client complexity
   JSON parsing is required for every response before you know if it succeeded.
   Libraries and SDKs must implement custom success checking logic.
   This is the caller's problem, not the library's — every caller duplicates this.

4. HTTP convention violation
   HTTP status code + body is a well-defined contract.
   Infrastructure (load balancers, API gateways, retry policies, circuit breakers)
   all rely on HTTP status codes for routing + retry decisions.
   Using 200 for errors sends correct data through the wrong channel.

Legitimate use case: batch operations return 207 Multi-Status with
per-item success/failure inside the body — this is intentional and standard.
```

---

### Intermediate-Level Questions

**Q: Design the complete error responses for a payment API**

```
Scenario: POST /payments endpoint — charge a card

VALIDATION ERRORS (400):
  Missing payment_method_id:
  { "error": { "code": "REQUIRED_FIELD_MISSING",
    "message": "payment_method_id is required",
    "details": [{ "field": "payment_method_id", "code": "REQUIRED" }] } }

  Invalid amount:
  { "error": { "code": "INVALID_AMOUNT",
    "message": "amount must be a positive integer in the smallest currency unit",
    "details": [{ "field": "amount", "code": "MUST_BE_POSITIVE", "given": -100 }] } }

BUSINESS LOGIC ERRORS (4xx):
  Customer not found (404):
  { "error": { "code": "CUSTOMER_NOT_FOUND",
    "message": "Customer 'cus_abc' was not found in your account" } }

  Duplicate payment detected (409):
  { "error": { "code": "DUPLICATE_PAYMENT",
    "message": "A payment with idempotency key 'key_xyz' was already processed",
    "existing_payment_id": "pay_existing_abc" } }

  Card declined - insufficient funds (422):
  { "error": { "code": "PAYMENT_CARD_DECLINED",
    "decline_reason": "insufficient_funds",
    "message": "Your card has insufficient funds.",
    "user_message": "Please use a different payment method.",
    "payment_id": "pay_failed_xyz" } }

  Card declined - fraud detected (422):
  { "error": { "code": "PAYMENT_CARD_DECLINED",
    "decline_reason": "fraud_suspected",
    "message": "This transaction was flagged by fraud prevention.",
    "user_message": "Please contact your bank to authorize this payment." } }
    NOTE: never tell client we suspect fraud — say "contact your bank"

  Payment method expired (422):
  { "error": { "code": "PAYMENT_METHOD_EXPIRED",
    "message": "The payment method on file expired in 03/2024",
    "user_message": "Please update your payment method." } }

THIRD-PARTY ERRORS (5xx):
  Payment processor unreachable (502):
  { "error": { "code": "PAYMENT_PROCESSOR_ERROR",
    "message": "Payment processor unavailable. Please retry in a moment.",
    "retry_after_seconds": 30 } }
    NOTE: DO NOT say "Stripe is down" — exposes vendor relationship

  Payment processor timeout (504):
  { "error": { "code": "PAYMENT_PROCESSOR_TIMEOUT",
    "message": "Payment processing timed out. Check payment status before retrying.",
    "status_check_url": "/payments/pay_xyz/status" } }
    CRITICAL: timeout means the payment MAY have gone through — tell client to check

KEY DESIGN DECISIONS:
  decline_reason: used by developer for analytics + routing logic
  user_message: safe for UI display without modification
  payment_id: always return the created attempt ID for reconciliation
  status_check_url on timeout: prevents duplicate charge from blind retry
```

---

**Q: How do you handle errors from third-party services without leaking internals?**

```
Scenario: Your API calls Stripe, Twilio, and SendGrid internally.

PRINCIPLE: Translate, don't pass through.

BAD PATTERN — raw third-party error passed to client:
  catch (stripeError) {
    return { status: 500, body: stripeError.message };
    // Returns: "No such customer: 'cus_abc'; code: resource_missing"
    // Leaks: you use Stripe, Stripe's internal codes
  }

CORRECT PATTERN — translation layer:
  catch (error) {
    if (error instanceof Stripe.errors.StripeCardError) {
      // Safe to surface card decline info to user
      throw new ApiError(422, 'PAYMENT_CARD_DECLINED',
        error.message, { decline_code: error.decline_code });
    }

    if (error instanceof Stripe.errors.StripeInvalidRequestError) {
      // Our code passed bad data to Stripe — our 500
      logger.error('Stripe invalid request', { stripeError: error });
      throw new ApiError(500, 'INTERNAL_ERROR', 'Payment configuration error');
    }

    if (error instanceof Stripe.errors.StripeAPIError) {
      // Stripe unavailable — our 502
      throw new ApiError(502, 'PAYMENT_PROCESSOR_ERROR',
        'Payment processor temporarily unavailable');
    }

    // Unknown — log and return generic 500
    logger.error('Unexpected Stripe error', { error });
    throw new ApiError(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
  }

KEY: client never sees "Stripe", "resource_missing", or internal Stripe error codes.
     Client sees your API's error vocabulary only.
     Internal logs capture everything for debugging.
```

---

### Advanced Question

**Q: Design error handling for a checkout flow that chains four microservices**

```
Flow: POST /orders → OrderService → InventoryService → PaymentService → NotificationService

CHALLENGE: What does the client receive when step 3 (PaymentService) fails?

DESIGN DECISIONS:

1. Request ID propagation
   OrderService generates order_id + request_id
   Passes both as headers to each downstream service
   X-Request-Id: req_abc
   X-Order-Id: order_xyz
   All services log with both IDs → correlated trace

2. What to return when step 3 fails (payment declined)
   OrderService receives InventoryService success
   OrderService receives PaymentService PAYMENT_CARD_DECLINED

   At this point:
   - Inventory has been reserved (step 2 succeeded)
   - Order record has been created (step 1 succeeded)
   - Payment failed (step 3)
   - Notification was never sent (step 4 never ran)

   Response to client:
   HTTP 422
   { "error": {
     "code": "PAYMENT_CARD_DECLINED",
     "decline_reason": "insufficient_funds",
     "user_message": "Your card has insufficient funds",
     "order_id": "order_xyz",     ← include order_id even on failure
     "order_status": "payment_required",  ← order exists, pending payment
     "retry_url": "/orders/order_xyz/pay",  ← allow retry without recreating order
     "request_id": "req_abc"
   } }

3. Compensating transactions on failure
   PaymentService failure → OrderService must:
   - Release inventory reservation (call InventoryService)
   - Set order status to 'payment_failed'
   - Log compensation action
   These are Saga compensations — they DO NOT change the error response.
   Client sees PAYMENT_CARD_DECLINED regardless of whether compensation succeeded.

4. What if compensation itself fails?
   InventoryService is unreachable when OrderService tries to release reservation
   OrderService:
   - Logs the stuck state to a dead-letter queue or SQS for manual review
   - Returns PAYMENT_CARD_DECLINED to client (same error, different internal state)
   - Sets internal order status to 'compensation_required' for reconciliation

5. What if the result is a partial success?
   OrderService succeeds + InventoryService succeeds + PaymentService succeeds
   NotificationService (step 4) fails (email delivery failure)

   The order and payment are complete — the notification failure is not the client's problem.
   Response: HTTP 201 Created with order details (success)
   Notification failure: logged, retried async via SQS with dead-letter queue

   KEY RULE: Notification failure cannot cause a payment to fail.
   Classify failures by whether they affect the core transaction or not.
```

---

## SECTION 10 — Comparison Tables

### HTTP Status Code Cheat Sheet

```
CATEGORY     CODE  NAME                    WHEN TO USE
─────────────────────────────────────────────────────────────────────────
Success       200  OK                      GET/PUT/PATCH succeeded
Success       201  Created                 POST succeeded, resource created
Success       202  Accepted                Request accepted, processing async
Success       204  No Content              DELETE succeeded, nothing to return
Success       207  Multi-Status            Batch: mixed success/failure per item

Client 4xx   400  Bad Request             Cannot parse request; invalid JSON
Client 4xx   401  Unauthorized            Not authenticated; credentials missing/invalid
Client 4xx   403  Forbidden               Authenticated but not authorized; do not retry
Client 4xx   404  Not Found               Resource does not exist
Client 4xx   405  Method Not Allowed      POST on /invoices/id which only accepts GET
Client 4xx   409  Conflict                State conflict; duplicate, optimistic lock failed
Client 4xx   410  Gone                    Existed but has been permanently deleted
Client 4xx   413  Content Too Large       Request body exceeds maximum allowed size
Client 4xx   422  Unprocessable           Parsed but fails validation rules
Client 4xx   429  Too Many Requests       Rate limit exceeded; include Retry-After header

Server 5xx   500  Internal Server Error   Unhandled exception; bug in server code
Server 5xx   502  Bad Gateway             Upstream service returned invalid response
Server 5xx   503  Service Unavailable     Server overloaded or down for maintenance
Server 5xx   504  Gateway Timeout         Upstream service did not respond in time
```

### Error Format Comparison

```
DIMENSION            RFC 7807          YOUR CUSTOM FORMAT    GOOGLE ERRORS
────────────────────────────────────────────────────────────────────────────────────
Standard?            IETF standard     Proprietary           Google-specific
Content-Type         application/      application/json      application/json
                     problem+json

Machine code?        "type" URI        "code" string         "reason" string
                     (awkward)         (clean)               (clean)

Human message?       "title" + "detail" "message"            "message"

Field-level errors?  "invalid-params"  "details" array       "errors" array
                     extension                                with "location"

Per-error doc link?  "type" URL        "documentation" URL   Not standard

Nested errors?       No                Yes (details[])       Yes (errors[])

Industry adoption    LOW               HIGH (most APIs)      HIGH (Google clients)

Best for             Standards-first   Most REST APIs        Google Cloud clients
                     APIs              (recommended)
```

### Client Behavior by Status Code

```
STATUS   CLIENT SHOULD                                         SHOW USER?
─────────────────────────────────────────────────────────────────────────────
400      Fix the request; do not retry                         developer error msg
401      Refresh/re-obtain credentials; retry once             "Please log in again"
403      Do not retry; show permission error                   "Access denied"
404      Do not retry; handle missing resource                 "Not found"
409      Read server state; may need different request         conflict-specific msg
422      Fix the field values; do not retry                    field validation errors
429      Wait for Retry-After seconds; then retry              "Please wait..."
500      Retry with exponential backoff (max 3 times)          "Something went wrong"
502      Retry with exponential backoff                        "Please try again"
503      Retry after Retry-After seconds                       "Service maintenance"
504      Check if action occurred; retry carefully             "Please try again"
```

---

## SECTION 11 — Quick Revision

### 10 Core Takeaways

```
1. Machine-readable codes, human-readable messages.
   code: "PAYMENT_CARD_DECLINED" — for software to branch on.
   message: "Your card was declined" — for humans to read.

2. 401 vs 403 is NOT interchangeable.
   401: "Who are you?" — no credentials or invalid credentials.
   403: "I know who you are, but you can't do this." — never re-auth.

3. Always include request_id in errors.
   The one field that connects client error to internal log trace.
   Support ticket time: 2+ hours → 4 minutes.

4. Return ALL validation errors simultaneously.
   Shotgun validation: find all errors in one pass.
   Don't force iterative fix cycles — return all field errors at once.

5. Never expose internal details in 500 errors.
   Stack traces, SQL queries, service names, table names are internal only.
   Log them — never return them to the client.

6. 5xx = retry. 4xx = fix the request. Never retry 4xx.
   Exception: 401 TOKEN_EXPIRED → refresh token → retry once.

7. Timeout (504) requires a status check URL.
   504 means the request may have succeeded.
   A blind retry on 504 for a payment API risks duplicate charges.

8. PAYMENT_CARD_DECLINED is a 422, not a 500.
   The server processed the request correctly. The card declined.
   5xx is for server-side failures, not business outcome failures.

9. Never expose your vendor relationships in errors.
   Not "Stripe is unavailable" — use "Payment processor unavailable."
   Not "SendGrid bounce" — use "Email delivery failed."

10. Set Retry-After on every 429 and 503 response.
    Without it, clients implement random backoff or hammer continuously.
    A header value tells them exactly when to retry — reduces load spikes.
```

### 30-Second Explanation (for interviews)

> "A good error response has four parts: an HTTP status code that correctly classifies the problem, a machine-readable code like PAYMENT_CARD_DECLINED that clients can branch on, a human-readable message that explains what happened, and a request ID that allows support engineers to trace the exact request in logs. 4xx errors mean the client made a mistake — don't retry. 5xx errors mean the server had a problem — retry with exponential backoff. The most common mistake I see is 500 errors leaking internal details like stack traces or SQL queries. 500s should be sanitized to the client, full details only in internal logs."

### Mnemonics

```
ERROR FORMAT — "CAMP":
  C — Code (machine-readable: PAYMENT_CARD_DECLINED)
  A — Action (what should the user/developer do next)
  M — Message (human-readable explanation)
  P — Pointer (request_id for traceability)

4XX VS 5XX:
  4XX = "4 your fault" (client made a mistake)
  5XX = "5 server's fault" (our problem, may be transient)

401 VS 403 — "IAM":
  401 = Identity not established (who are you?)
  403 = Access is denied (I know you, access Managed away from you)

RETRY RULE:
  5xx = "5ervers fail, so retry"
  4xx = "4ix the request, don't retry"
  429 = "4-2-9, wait and try (after Retry-After)"

VALIDATION — "SAFE":
  S — Sanitize (remove PII from error messages)
  A — All errors at once (shotgun, not drip)
  F — Field-level details (which field, what violation)
  E — Error code per field (so client can i18n the message)
```

---

## SECTION 12 — Architect Thinking Exercise

### Exercise: HealthTrack Multi-Service Error Design

**Scenario:**

You are the backend architect for HealthTrack, a health data platform serving 50,000 patients. Their API processes lab result submissions from hospital systems with this flow:

```
POST /lab-results

1. LabResultService — validate HL7/FHIR format, create lab record
2. PatientService — verify patient exists, update patient health timeline
3. ProviderService — notify ordering physician (async notification)
4. InsuranceService — submit for billing (async, best-effort)
5. AlertService — check if result requires urgent clinical alert
```

**Problems stakeholders have reported:**

1. Hospital EHR system logs show 23% of submissions returning "Error 500" — EHR engineers have no idea what went wrong
2. Support team receives 40+ calls a week because errors include the message "psycopg2 IntegrityError: duplicate key value violates unique constraint patient_mrn_key"
3. When InsuranceService is down (happens for maintenance every Tuesday at 2am), all lab submissions fail with 503 — urgent lab results are blocked overnight
4. Physician alerting fails silently — 3 patients had critical values not flagged for 6+ hours

**Your task:** Design the complete error handling architecture to fix these problems.

---

### Model Solution

**Problem 1 Analysis: 500s with no context to hospital systems**

```
ROOT CAUSE: Single unhandled catch block returning generic 500
  catch (error) { res.status(500).json({ error: error.message }) }

SOLUTION — structured error translation layer:

Define HL7/FHIR specific errors (because hospitals speak FHIR):
  {
    "resourceType": "OperationOutcome",
    "issue": [{
      "severity": "error",
      "code": "INVALID_RESOURCE",
      "details": { "text": "Observation.subject is required" },
      "diagnostics": "Field subject_reference must be a valid Patient FHIR reference",
      "expression": ["Observation.subject"]
    }],
    "requestId": "req_f47ac10b"
  }

Hospital EHR engineers understand OperationOutcome (FHIR standard error format).
requestId links to internal logs if they escalate to support.

Map internal errors to FHIR issue codes:
  VALIDATION_ERROR → code: "invalid"
  PATIENT_NOT_FOUND → code: "not-found"
  DUPLICATE_RESULT → code: "duplicate"
  INTERNAL_ERROR → code: "exception" (sanitized, no DB details)
```

---

**Problem 2 Analysis: Database error leaking to hospital systems**

```
ROOT CAUSE: Raw exception message returned to client
  "psycopg2 IntegrityError: duplicate key value violates unique constraint patient_mrn_key"

This leaks:
  - Python ORM (psycopg2)
  - Database engine (PostgreSQL implied)
  - Table constraint name (patient_mrn_key)
  - Column name (mrn = Medical Record Number)
  → Security vulnerability + HIPAA concern (exposing data structure)

SOLUTION — exception translation at DB layer:
  try:
    db.save(lab_result)
  except IntegrityError as e:
    if 'patient_mrn_key' in str(e):
      raise ApiError(409, 'DUPLICATE_LAB_RESULT',
        f"A lab result with accession number '{lab_result.accession_id}' "
        f"already exists for this patient. "
        f"Each result requires a unique accession number.")
    else:
      logger.error("Unexpected DB integrity error", exc_info=True,
                   extra={"request_id": request_id})
      raise ApiError(500, 'INTERNAL_ERROR',
        'Lab result could not be saved. Our team has been notified.')

Hospital receives: "A lab result with accession number 'ACC-123' already exists"
They understand this and can fix their submission.
Zero internal details exposed. HIPAA-safe.
```

---

**Problem 3 Analysis: Insurance billing bringing down lab submissions**

```
ROOT CAUSE: Synchronous coupling to non-critical service
  The critical path: receive lab result → validate → save → alert physician
  InsuranceService billing is ADMINISTRATIVE — not clinically critical

  Yet: InsuranceService timeout blocks all lab submissions for the whole outage window

SOLUTION — Decouple via async queue:

BEFORE (wrong):
  POST /lab-results:
  1. ValidateAndSave → critical
  2. NotifyPhysician → critical
  3. SubmitInsuranceClaim → InsuranceService (BLOCKS!)

AFTER (correct):
  POST /lab-results:
  1. ValidateAndSave → critical (synchronous)
  2. AlertPhysician → critical (synchronous)
  3. Enqueue insurance task to SQS → non-critical (milliseconds, never fails)
  → Respond 201 Created to hospital

  SQS consumer (separate Lambda):
  4. Pick up task → call InsuranceService
  5. On failure: retry with exponential backoff
  6. On max retries: send to DLQ → alert billing team

RESPONSE DESIGN:
  201 Created:
  { "lab_result_id": "lr_abc",
    "clinical_status": "received",
    "physician_notified": true,
    "billing_status": "queued",    ← honest: not yet processed
    "billing_estimated": "within 15 minutes" }

  When InsuranceService is down at 2am:
  - Hospitals receive 201 (lab result saved and clinical team notified)
  - Billing queue builds up
  - When InsuranceService recovers, SQS processes the backlog
  - No patient impact. No hospital call centers flooded.

  RULE: Never let a billing or notification failure affect a clinical transaction.
```

---

**Problem 4 Analysis: Physician alerts failing silently**

```
ROOT CAUSE: AlertService failures not monitored, no DLQ, errors swallowed
  try {
    alertService.notifyPhysician(result)
  } catch (e) {
    // silently swallowed — no log, no metric, no alerting
  }

THIS IS UNACCEPTABLE IN A CLINICAL CONTEXT.
3 patients had critical lab values (e.g., potassium 6.9 mEq/L — life-threatening)
not flagged to the physician for 6+ hours.

SOLUTION — treat alerts as a critical path, not best-effort:

1. AlertService is SYNCHRONOUS and CRITICAL on the initial submission:
   Lab result saved → Alert evaluated (is this critical? Yes/No)
   If critical: AlertService must respond within 5 seconds
   If AlertService times out: return 500 ALERT_SYSTEM_UNAVAILABLE
   → Hospital knows: result was stored but alert system failed
   → Hospital can call physician directly (fallback procedure)

2. Distinguish critical vs routine alerts:
   Critical (K=6.9, troponin elevated): synchronous, blocks 201 response
   Routine (normal annual result): async via SQS (non-blocking)

3. Error response when critical alert fails:
   HTTP 500 (not 201!)
   { "error": {
     "code": "CRITICAL_ALERT_FAILED",
     "message": "Lab result was saved successfully but the critical value alert
                 could not be delivered to the ordering physician.
                 Manual notification required.",
     "lab_result_id": "lr_abc",     ← provide ID even on failure
     "physician": "Dr. Smith",
     "contact": "+1-555-DOCTOR",
     "escalation": "Contact on-call physician at +1-555-ONCALL",
     "request_id": "req_f47ac10b"
   } }

   Hospital EHR immediately shows this as a failure requiring manual action.

4. Monitor all alert deliveries:
   CloudWatch alarm: alert_delivery_failed > 0 in 1 minute → page on-call
   DLQ for all failed alerts → never silently drop a critical value notification

KEY: Critical system failures must NOT be silently swallowed.
     Return an error that tells the caller they need to take manual action.
```

---

**Final Architecture Summary**

```
ERROR CLASSIFICATION FOR HEALTHTRACK:

CRITICAL PATH (synchronous, failure = HTTP error response):
  - FHIR format validation
  - Patient existence check
  - Lab result storage
  - Critical value alert delivery

NON-CRITICAL PATH (async queue, failure = queued retry):
  - Physician routine notification
  - Insurance billing submission
  - Patient timeline update (can lag)
  - Audit log writes

RESPONSE DESIGN:
  Success (all critical path passed):
  201 { lab_result_id, clinical_status, billing_status: "queued" }

  Failure (any critical path step failed):
  4xx or 5xx with FHIR OperationOutcome, requestId for trace

  Partial (lab saved, critical alert failed):
  500 with CRITICAL_ALERT_FAILED, physician contact details,
  lab_result_id (result was saved, alert failed — be explicit about both)

MONITORING:
  5xx rate > 0.5% → P2 alert
  CRITICAL_ALERT_FAILED count > 0 → P1 IMMEDIATE page
  DLQ depth > 100 (InsuranceService backlog) → P3 alert billing team
  Support ticket rate from hospitals → lagging indicator of error quality
```

---

_End of Topic 08: Standard Error Responses_
