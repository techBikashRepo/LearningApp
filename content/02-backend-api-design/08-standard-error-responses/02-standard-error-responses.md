# Standard Error Responses — Part 2 of 3

### Sections: 5 (Architecture Diagram), 6 (Production Scenarios), 7 (Scaling & Reliability), 8 (AWS Mapping)

**Series:** Backend & API Design → REST APIs → System Design

---

## SECTION 5 — Architecture & System Diagram

### Error Response Architecture

```
                    INVOICEFLOW ERROR HANDLING ARCHITECTURE
                    ========================================

Client / SDK
     │
     │  POST /v2/invoices/inv_abc/payments
     ▼
┌─────────────────────────────────────────────────────────────────┐
│                         CloudFront CDN                          │
│  • 4xx errors returned from origin (no caching)                │
│  • 5xx errors returned from origin (no caching)                │
│  • Custom error pages: CloudFront 503 → formatted JSON         │
│                                                                  │
│  On CloudFront origin timeout (rare):                           │
│  { "error": { "code": "CDN_ORIGIN_TIMEOUT",                    │
│    "message": "Please retry in a moment",                       │
│    "request_id": "cf-req-xxx" } }                               │
└─────────────────────────┬───────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                       API Gateway                               │
│                                                                  │
│  API GW generates its own errors for:                           │
│  • Auth validation failure (JWT invalid) → 401                 │
│  • Rate limit exceeded (usage plan) → 429                       │
│  • Request body too large (> 10MB) → 413                        │
│  • Request schema validation failure → 400                      │
│  • Endpoint not found → 404                                     │
│  • Method not allowed → 405                                     │
│                                                                  │
│  BY DEFAULT: API GW returns raw AWS error format                │
│  { "message": "Unauthorized" }                                  │
│                                                                  │
│  CONFIGURED: Map to standard format                             │
│  GatewayResponse for 401/403/429/404/413:                       │
│  { "error": { "code": "...", "message": "...",                  │
│    "request_id": "$context.requestId" } }                       │
└─────────────────────────┬───────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│              Application Lambda                                 │
│              (invoice payment handler)                          │
│                                                                  │
│  ERROR HANDLING LAYERS:                                         │
│                                                                  │
│  LAYER 1: Input validation (400 errors)                         │
│  • JSON schema validation → VALIDATION_ERROR                    │
│  • Business rule validation → domain-specific codes             │
│  • Return ALL validation errors in one response                 │
│                                                                  │
│  LAYER 2: Business logic (4xx domain errors)                    │
│  • fetch customer → not found → CUSTOMER_NOT_FOUND             │
│  • check invoice status → already paid → INVOICE_ALREADY_PAID  │
│  • check account tier → upgrade required → SUBSCRIPTION_REQUIRED│
│                                                                  │
│  LAYER 3: External service calls (502/504)                      │
│  try { stripe.charge(...)  }                                    │
│  catch (StripeDeclineError) → PAYMENT_CARD_DECLINED (422)      │
│  catch (StripeNetworkError) → PAYMENT_PROCESSOR_ERROR (502)    │
│  catch (StripeTimeoutError) → PAYMENT_PROCESSOR_TIMEOUT (504)  │
│                                                                  │
│  LAYER 4: Catch-all (500)                                       │
│  catch (Error) → INTERNAL_ERROR (500)                           │
│  • Log full stack trace to CloudWatch Logs                      │
│  • Send sanitized response (no internal details to client)      │
│  • Alert on-call engineer via PagerDuty                         │
└─────────┬───────────────────────────────────────────────────────┘
          │
          │  All errors flow through Error Response Builder
          ▼
┌─────────────────────────────────────────────────────────────────┐
│              Error Response Builder                             │
│                                                                  │
│  Responsibilities:                                              │
│  1. Normalize all errors to standard format                     │
│  2. Add request_id from Lambda context                          │
│  3. Add timestamp                                               │
│  4. Append documentation link                                   │
│  5. STRIP sensitive data (stack traces, internal IDs, DB errors)│
│  6. Set appropriate HTTP status code                            │
│  7. Set Content-Type: application/json                          │
│  8. Emit error metric to CloudWatch (error_code, status_code)   │
└─────────────────────────────────────────────────────────────────┘

ERROR FLOW TRACING:

Client receives error with request_id: req_f47ac10b
  → Client contacts support: "Request req_f47ac10b failed"
  → Support: CloudWatch Logs Insights query:
    fields @timestamp, @message
    | filter requestId = "req_f47ac10b"
    | sort @timestamp
    | limit 100
  → Full trace: request-in → validation → Stripe call → response-out
  → RCA in < 2 minutes

Without request_id:
  Client: "payment failed around 3pm yesterday"
  Support: searches thousands of log lines manually → 2+ hours

REQUEST ID PROPAGATION:
  API Gateway: generates $context.requestId
  Lambda: logs all events with requestId
  Calls to Stripe: pass requestId as Stripe idempotency key and metadata
  Response: include requestId in error body
  CloudWatch: structured log with requestId field

All steps linked by requestId → full distributed trace without Xray.
```

---

## SECTION 6 — Production Scenarios

### Scenario A: Stripe's Error Taxonomy — Industry Standard

Stripe's error handling is the most studied in the payments industry:

```
STRIPE TOP-LEVEL ERROR CATEGORIES:

1. api_error — Problem with Stripe's API (500-level)
2. card_error — Issue with the payment card (client: show to user)
   decline_codes: insufficient_funds, card_expired, do_not_honor, lost_card, stolen_card
3. idempotency_error — Conflicting idempotency key usage
4. invalid_request_error — Invalid parameters (client: fix request)
5. rate_limit_error — Too many requests

STRIPE ERROR RESPONSE:
{
  "error": {
    "type": "card_error",
    "code": "card_declined",
    "decline_code": "insufficient_funds",
    "message": "Your card has insufficient funds.",
    "param": "card",
    "charge": "ch_3abc123",
    "doc_url": "https://stripe.com/docs/error-codes/card-declined"
  }
}

Key design choices:
1. User-safe message: "Your card has insufficient funds" — safe to show directly to user
2. Decline code for developer: insufficient_funds — for analytics + routing logic
3. Charge ID: reference to the created (declined) payment attempt for reconciliation
4. Param: which parameter is the problem
5. Doc URL: every error links to dedicated documentation page

Developer handling:
  switch (error.decline_code) {
    case 'insufficient_funds':
      showMessage('Please use a different payment method');
      break;
    case 'card_expired':
      showForm('Please update your card details');
      break;
    case 'do_not_honor':
      showMessage('Payment declined. Please contact your bank.');
      break;
    // etc.
  }
```

---

### Scenario B: The Leaking 500 Error — What NOT To Do

```
DANGEROUS PRACTICE (real anti-pattern):

Python + SQLAlchemy error leaks internal details in 500 response:
{
  "error": "sqlalchemy.exc.IntegrityError: (psycopg2.errors.UniqueViolation)
   duplicate key value violates unique constraint \"users_email_key\"
   DETAIL: Key (email)=(user@example.com) already exists.
   [SQL: INSERT INTO users (email, password_hash, tenant_id) VALUES (%(email)s, ...)]
   [parameters: {'email': 'user@example.com', 'password_hash': '$2b$12$...', ...}]"
}

This leaks:
  - Database table name: users
  - Column names: email, password_hash, tenant_id
  - SQL query structure
  - Partial bcrypt hash of another user's password
  - Internal constraint name: users_email_key

Security impact:
  - Attacker maps database schema from error messages
  - Schema knowledge enables more targeted SQL injection attempts
  - Bcrypt hash leak (even partial) is a security incident

CORRECT APPROACH:
  Catch SQLAlchemy IntegrityError:
    if 'email' in str(e.orig) and 'UniqueViolation' in str(type(e.orig).__name__):
      raise ApiError(409, 'EMAIL_ALREADY_EXISTS',
                     'An account with this email already exists')
    else:
      logger.error(f"Unexpected DB error: {e}")  ← log internally, not externally
      raise ApiError(500, 'INTERNAL_ERROR', 'An unexpected error occurred')

  Client receives:
  {
    "error": {
      "code": "EMAIL_ALREADY_EXISTS",
      "message": "An account with this email already exists",
      "request_id": "req_f47ac10b"
    }
  }

  Clean. No schema information. No internal details. Actionable error code.
```

---

## SECTION 7 — Scaling & Reliability

### Error Rate Monitoring and Alerting

```
FUNDAMENTAL METRICS:

1. 5xx Error Rate (server errors — our fault):
   CloudWatch: count(status >= 500) / count(all requests) * 100
   Threshold: > 0.1% → P2 alert (wake up on-call in business hours)
   Threshold: > 1% → P1 alert (wake up on-call immediately, any hour)
   Rationale: 1% of payments failing means ~100 failures per 10,000 charges

2. 4xx Error Rate (client errors — their code has a bug):
   Threshold: > 15% → P3 (investigate — abnormal client error rate)
   Rationale: 15% means many clients are sending invalid requests
   → Possible: API docs are wrong, recent API change broke clients

3. Specific Error Code Rate (business metrics):
   PAYMENT_CARD_DECLINED rate → business health metric
   RATE_LIMIT_EXCEEDED → capacity planning signal
   UNAUTHENTICATED → potential credential theft probe
   CUSTOMER_NOT_FOUND spike → possible client-side bug

4. Error code distribution change:
   Normal: 80% VALIDATION_ERROR, 15% PAYMENT_CARD_DECLINED, 5% other
   Anomaly: INTERNAL_ERROR suddenly 40% → something broke in last deploy
   → Alarm on: any error code's share increasing by > 10 percentage points

CLOUDWATCH ALARM EXAMPLES:
  Alarm: API-5xx-Rate
    Metric: Error5xxCount / RequestCount
    Threshold: > 0.01 (1%)
    Period: 1 minute
    Action: SNS → PagerDuty → page on-call

  Alarm: API-Payment-Declined-Spike
    Custom metric: error_code = "PAYMENT_CARD_DECLINED"
    Threshold: > 200/minute
    Period: 5 minutes
    Action: SNS → Slack → payment-ops channel
    Rationale: spike might indicate fraud attempt, not just organic failures
```

### Error Response Performance

```
NEVER let error handling add latency:

WRONG:
  try {
    // request processing
  } catch (error) {
    await database.log('errors', { error: error.message, ... });  // DB write on error path
    // Now every error adds DB write latency to the error response
  }

RIGHT:
  try {
    // request processing
  } catch (error) {
    // Async log — don't await error logging
    errorLogger.log({ error, requestId }).catch(logErr =>
      console.error('Failed to log error:', logErr)  // log the log failure
    );

    // Return error response immediately
    return buildErrorResponse(error, requestId);
  }

Error logging should be:
  1. Async (don't block response)
  2. Non-throwing (error in error handler cannot crash the response)
  3. Structured (CloudWatch searchable fields, not unstructured text)
```

### Retry Logic and Error Codes

```
CLIENT RETRY DECISION MATRIX (based on error codes):

Status / Code             Retry?   Delay
─────────────────────────────────────────────────────────
400 VALIDATION_ERROR      NO       Fix the request first
401 UNAUTHENTICATED       YES*     After refreshing token
401 TOKEN_EXPIRED         YES*     After refreshing token, immediately
403 INSUFFICIENT_PERMS    NO       Permission issue, retrying won't help
404 NOT_FOUND             NO       Resource doesn't exist
409 CONFLICT              NO       Conflict is a state issue, retry same request = same conflict
422 PAYMENT_DECLINED      NO       Card declined, retrying = declined again
429 RATE_LIMIT_EXCEEDED   YES      After Retry-After header value expires
500 INTERNAL_ERROR        YES      After 2-5 second delay (max 3 retries)
502 BAD_GATEWAY           YES      After 1-2 second delay
503 SERVICE_UNAVAILABLE   YES      After Retry-After header (if present) or 30 seconds
504 GATEWAY_TIMEOUT       YES      After 2-5 second delay

Rule: Retry on 5xx (server problem, transient) and 429 (rate limit, wait and retry)
      Never retry on 4xx (client problem, retrying same bad request = same error)
      Exception: 401 TOKEN_EXPIRED → refresh token, then retry once
```

---

## SECTION 8 — AWS Implementation

### API Gateway Custom Error Responses

```yaml
# CloudFormation: customize API Gateway error responses
# By default, API GW returns: {"message": "Unauthorized"}
# After config: returns your standard format

Resources:
  # Override 401 response
  GatewayResponseUnauthorized:
    Type: AWS::ApiGateway::GatewayResponse
    Properties:
      RestApiId: !Ref ApiGateway
      ResponseType: UNAUTHORIZED
      StatusCode: "401"
      ResponseTemplates:
        application/json: >
          {
            "error": {
              "code": "UNAUTHENTICATED",
              "message": "Authentication credentials are missing or invalid",
              "request_id": "$context.requestId",
              "documentation": "https://api.invoiceflow.com/errors/UNAUTHENTICATED"
            }
          }

  # Override 429 response (rate limit)
  GatewayResponseThrottled:
    Type: AWS::ApiGateway::GatewayResponse
    Properties:
      RestApiId: !Ref ApiGateway
      ResponseType: THROTTLED
      StatusCode: "429"
      ResponseParameters:
        gatewayresponse.header.Retry-After: "'60'"
      ResponseTemplates:
        application/json: >
          {
            "error": {
              "code": "RATE_LIMIT_EXCEEDED",
              "message": "You have exceeded the permitted request rate",
              "retry_after_seconds": 60,
              "request_id": "$context.requestId",
              "documentation": "https://api.invoiceflow.com/errors/RATE_LIMIT_EXCEEDED"
            }
          }

  # Override 400 (bad request body / schema validation)
  GatewayResponseBadRequestBody:
    Type: AWS::ApiGateway::GatewayResponse
    Properties:
      RestApiId: !Ref ApiGateway
      ResponseType: BAD_REQUEST_BODY
      StatusCode: "400"
      ResponseTemplates:
        application/json: >
          {
            "error": {
              "code": "VALIDATION_ERROR",
              "message": "$context.error.validationErrorString",
              "request_id": "$context.requestId"
            }
          }
```

### Lambda Error Handler

```javascript
// Centralized error handler — all Lambda functions use this
import { randomUUID } from "crypto";

// Domain error class
class ApiError extends Error {
  constructor(statusCode, code, message, details = []) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

// Error response builder
const buildErrorResponse = (error, requestId, event) => {
  // Known domain errors: return structured response
  if (error instanceof ApiError) {
    // Log at warn level (expected errors)
    console.warn(
      JSON.stringify({
        level: "warn",
        requestId,
        errorCode: error.code,
        errorMessage: error.message,
        statusCode: error.statusCode,
        path: event?.path,
      }),
    );

    return {
      statusCode: error.statusCode,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details.length > 0 && { details: error.details }),
          request_id: requestId,
          timestamp: new Date().toISOString(),
          documentation: `https://api.invoiceflow.com/errors/${error.code}`,
        },
      }),
    };
  }

  // Unknown errors: sanitize and log full details internally
  console.error(
    JSON.stringify({
      level: "error",
      requestId,
      errorName: error.name,
      errorMessage: error.message,
      stack: error.stack,
      // Full details — INTERNAL ONLY, never returned to client
    }),
  );

  // Emit metric for monitoring
  const cw = new CloudWatch({ region: process.env.AWS_REGION });
  cw.putMetricData({
    Namespace: "InvoiceFlow/Errors",
    MetricData: [{ MetricName: "UnhandledError", Value: 1, Unit: "Count" }],
  }).catch(() => {}); // fire-and-forget

  // Return sanitized 500 — no internal details
  return {
    statusCode: 500,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected error occurred. Our team has been notified.",
        request_id: requestId,
        timestamp: new Date().toISOString(),
        support: "https://support.invoiceflow.com",
      },
    }),
  };
};

// Lambda handler wrapper — applies to all functions
export const withErrorHandler = (handler) => async (event, context) => {
  const requestId = context.awsRequestId || randomUUID();

  try {
    return await handler(event, context, requestId);
  } catch (error) {
    return buildErrorResponse(error, requestId, event);
  }
};

// Usage in any function:
export const handler = withErrorHandler(async (event, context, requestId) => {
  const invoiceId = event.pathParameters?.id;

  const invoice = await db.getInvoice(invoiceId);
  if (!invoice) {
    throw new ApiError(
      404,
      "INVOICE_NOT_FOUND",
      `Invoice '${invoiceId}' was not found in your account`,
    );
  }

  if (invoice.status === "paid") {
    throw new ApiError(
      409,
      "INVOICE_ALREADY_PAID",
      `Invoice '${invoiceId}' has already been paid and cannot be modified`,
    );
  }

  // etc.
});
```

### CloudWatch Error Dashboard

```javascript
// Key metrics to emit for every error
const emitErrorMetric = async (errorCode, statusCode, endpoint) => {
  await cloudwatch.putMetricData({
    Namespace: "InvoiceFlow/API/Errors",
    MetricData: [
      {
        MetricName: "ErrorCount",
        Value: 1,
        Unit: "Count",
        Dimensions: [
          { Name: "ErrorCode", Value: errorCode },
          { Name: "StatusCode", Value: String(statusCode) },
          { Name: "Endpoint", Value: endpoint },
        ],
      },
    ],
  });
};

// CloudWatch Insights query for error analysis:
// fields @timestamp, errorCode, statusCode, requestId, @message
// | filter statusCode >= 400
// | stats count() as count by errorCode, statusCode
// | sort count desc
// | limit 20

// Alarm: UnhandledError count > 0 in 5 minutes → page on-call
// Dashboard: Error code distribution pie chart updates every minute
// Alert: PAYMENT_CARD_DECLINED > 200/5min → notify payments team
```
