# Standard Error Responses — Part 1 of 3

### Sections: 1 (Intuition), 2 (Why It Exists), 3 (Core Technical Deep Dive), 4 (Real-World API Contract & Request Flow)

**Series:** Backend & API Design → REST APIs → System Design

---

## SECTION 1 — Building Intuition First

### The Doctor's Report Analogy

Imagine a doctor's report with two versions:

**Version A (bad):**

> "Something went wrong. Error code: 5823."

You: What went wrong? Is it serious? What do I do? What does 5823 mean?

**Version B (good):**

> "Your blood pressure is elevated (165/92 measured at 10:30 AM). High blood pressure increases cardiovascular risk. Recommended action: Schedule follow-up appointment within 2 weeks. Reduce sodium intake. Avoid caffeine. Reference: Visit ID 20240115-Dr-Jones."

Same problem — but version B tells you: what happened, why it matters, what to do about it, and how to reference it later.

API error responses follow the same principle. A good error response answers:

1. **What** went wrong (error code + human message)
2. **Where** it went wrong (which field, which parameter)
3. **Why** it went wrong (violated what rule)
4. **What to do** (how to fix it)
5. **How to reference it** (request ID for support)

### The 404 vs 403 Distinction

```
Scenario: User tries to access a report they don't have permission to view.

WRONG: Return 404 Not Found
  Client code: "I got 404 — the report doesn't exist. Let me tell the user it's missing."
  User sees: "Report not found" (the report DOES exist, they just can't access it)

CORRECT: Return 403 Forbidden
  Client code: "I got 403 — the user doesn't have access. Show permission message."
  User sees: "You don't have permission to view this report. Contact your admin."

  Also: 404 leaks information — "this thing exists but you're not allowed to see it"
  → In high-security contexts, 404 is the CORRECT response (security through obscurity)
  → In typical SaaS, 403 is clearer for UX

The error status code is as much information as the body.
Using the wrong code = wrong behavior in client code.
```

---

## SECTION 2 — Why Standard Error Responses Exist

### The Problem: Inconsistent Errors Destroy Developer Experience

```
BAD (inconsistent error formats scattered across one API):

GET /users/999        → { "error": "not found" }
POST /orders invalid  → { "msg": "Bad request", "code": 400 }
DELETE /items/1       → { "Error": "forbidden", "Status": 403 }
GET /reports/slow     → { "message": "Internal server error occurred", "trace": "..." }
PUT /config invalid   → HTTP 400, empty body

5 different formats. Client code must handle 5 different cases.
Frontend developer writes 5 different error parsing functions.
Each microservice adds its own convention. After 3 years: 15 different formats.
```

```
GOOD (consistent error format):

ALL endpoints return:
{
  "error": {
    "code": "RESOURCE_NOT_FOUND",
    "message": "User with id '999' was not found",
    "request_id": "req_f47ac10b",
    "documentation": "https://api.example.com/docs/errors#RESOURCE_NOT_FOUND"
  }
}

Client writes ONE error handler. Works for every endpoint.
Every response has request_id for support. Every code links to docs.
```

### What Bad Error Design Costs

**Cost 1 — Developer time:** A developer integrating an API with inconsistent errors spends 30% of their integration time on error handling vs 5-10% with a consistent format.

**Cost 2 — Support tickets:** Without a `request_id`, support cannot trace a specific failed request in logs. "My payment failed at 3pm yesterday" → impossible to find without a trace ID. With request_id: instant log lookup.

**Cost 3 — Client resilience:** Inconsistent error codes prevent clients from writing correct retry logic.

```
Client code:
  if (error.status === 429) → retry with backoff (correct)
  if (error.status === 503) → retry (correct)
  if (error.status === 400) → do NOT retry (correct)

  But if the API returns 500 for rate-limiting (instead of 429)?
  Client retries → makes the rate limit worse → cascade failure
  The wrong status code caused a production incident.
```

**Cost 4 — Monitoring and alerting:** Error category metrics depend on consistent status codes:

- 5xx rate → alert on page (server problem)
- 4xx rate → alert on ticket (client problem, or API design issue)
- Specific error codes → product metrics ("how many PAYMENT_METHOD_INVALID per day?")

---

## SECTION 3 — Core Technical Deep Dive

### HTTP Status Code Categories

```
1xx — Informational:  100 Continue, 101 Switching Protocols
      Rarely used in REST APIs.

2xx — Success:
  200 OK              Standard success (GET, PUT, PATCH)
  201 Created         Resource created (POST)
  202 Accepted        Async processing started (result not yet ready)
  204 No Content      Success with no body (DELETE, some PUT)
  206 Partial Content Range request fulfilled (streaming, byte-range download)

3xx — Redirection:
  301 Moved Permanently   Resource permanently moved (update bookmarks)
  302 Found               Temporary redirect
  304 Not Modified        Client cache is fresh (used with ETag/If-None-Match)
  308 Permanent Redirect  Like 301 but preserves HTTP method

4xx — Client Error (problem with the request):
  400 Bad Request         Malformed request, validation failure
  401 Unauthorized        Not authenticated (missing or invalid credentials)
  403 Forbidden           Authenticated but not authorized for this resource
  404 Not Found           Resource doesn't exist
  405 Method Not Allowed  POST /orders/{id} when only GET is supported
  409 Conflict            Resource conflict (duplicate, state conflict)
  410 Gone                Resource permanently removed (vs 404 = might return)
  422 Unprocessable       Syntactically valid but semantically wrong
  429 Too Many Requests   Rate limit exceeded (include Retry-After header)

5xx — Server Error (problem on the server):
  500 Internal Server Error  Unexpected server error
  502 Bad Gateway            Upstream service error (proxy/API GW upstream fail)
  503 Service Unavailable    Server overloaded or in maintenance
  504 Gateway Timeout        Upstream timed out
```

**Most critical distinction: 401 vs 403:**

```
401 Unauthorized (misleadingly named — really "Unauthenticated"):
  The request lacks valid authentication credentials.
  → Client should: re-authenticate, refresh token, redirect to login
  → Response MUST include: WWW-Authenticate header
  Example: expired JWT token, missing Bearer header

403 Forbidden (really "Unauthorized" semantically):
  The request is authenticated but the user lacks PERMISSION.
  → Client should: show "insufficient permissions" message, NOT re-authenticate
  → Re-authenticating won't help — they're authenticated, just not authorized
  Example: user tries to delete another user's data, scope mismatch

WRONG: Return 401 when user is logged in but lacks permission
  → Client re-authenticates, gets the same 401 again
  → Infinite login loop, confused user
```

### Standard Error Response Structure

The RFC 7807 "Problem Details" standard:

```json
// RFC 7807 format — production standard adopted by many APIs
{
  "type": "https://errors.example.com/validation-error",
  "title": "Validation Error",
  "status": 400,
  "detail": "Request body contains invalid fields",
  "instance": "/v2/orders",
  "errors": [
    {
      "field": "amount_cents",
      "code": "MUST_BE_POSITIVE",
      "message": "amount_cents must be a positive integer"
    },
    {
      "field": "currency",
      "code": "UNSUPPORTED_CURRENCY",
      "message": "Currency 'XYZ' is not supported. Supported: usd, eur, gbp"
    }
  ],
  "request_id": "req_f47ac10b-2b0a-4e2f-9f1d-8c5b2a1d3e4f",
  "timestamp": "2024-01-15T10:30:00Z"
}
```

**Custom format (simpler, widely used):**

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [
      {
        "field": "amount_cents",
        "code": "MUST_BE_POSITIVE",
        "message": "amount_cents must be a positive integer, got: -500"
      }
    ],
    "request_id": "req_f47ac10b",
    "documentation": "https://api.example.com/errors#VALIDATION_ERROR"
  }
}
```

**Error code naming conventions:**

```
Machine-readable error codes (SCREAMING_SNAKE_CASE):
  RESOURCE_NOT_FOUND
  VALIDATION_ERROR
  INSUFFICIENT_FUNDS
  RATE_LIMIT_EXCEEDED
  PAYMENT_METHOD_DECLINED

Rules:
  1. Always present (needed for programmatic handling)
  2. Stable across API changes (clients switch on these codes)
  3. Specific: PAYMENT_CARD_EXPIRED > PAYMENT_FAILED > ERROR
  4. Domain-language: INVOICE_ALREADY_PAID not DATABASE_UNIQUE_CONSTRAINT_VIOLATION
  5. Documented: every code in API docs with: meaning, cause, resolution
```

### Validation Error Response (Multi-Field)

```json
// POST /v2/orders with multiple invalid fields
// → 400 Bad Request
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed. Please fix the following errors and retry.",
    "details": [
      {
        "field": "amount_cents",
        "code": "REQUIRED_FIELD_MISSING",
        "message": "amount_cents is required"
      },
      {
        "field": "currency",
        "code": "UNSUPPORTED_VALUE",
        "message": "currency 'XYZ' is not supported",
        "allowed_values": ["usd", "eur", "gbp", "cad", "aud"],
        "received": "XYZ"
      },
      {
        "field": "customer.email",
        "code": "INVALID_FORMAT",
        "message": "customer.email is not a valid email address",
        "received": "not-an-email"
      }
    ],
    "request_id": "req_f47ac10b",
    "timestamp": "2024-01-15T10:30:00Z"
  }
}
```

Return ALL validation errors in one response. Do not return one error, fix it, then discover the next. The "shotgun validation" pattern returns all errors simultaneously so the developer can fix them all at once.

### Rate Limit Error Response

```
HTTP/1.1 429 Too Many Requests
Retry-After: 47
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1705312347

{
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "You have exceeded the rate limit of 100 requests per minute",
    "retry_after_seconds": 47,
    "limit": 100,
    "window": "1 minute",
    "reset_at": "2024-01-15T10:31:00Z",
    "request_id": "req_f47ac10b",
    "documentation": "https://api.example.com/docs/rate-limits"
  }
}

Client handling:
  if (response.status === 429) {
    const retryAfter = response.headers['retry-after'];
    await sleep(retryAfter * 1000);
    return retry(request);  // with same idempotency key if POST
  }
```

---

## SECTION 4 — Real-World API Contract & Request Flow

### InvoiceFlow — B2B Billing API

InvoiceFlow handles invoice creation, payment collection, and billing management for 8,000 clients.

```
COMPLETE ERROR TAXONOMY FOR INVOICEFLOW:

ERROR CODE CATALOG:
──────────────────────────────────────────────────────────────────────────────

VALIDATION/CLIENT ERRORS (4xx — client should fix request):

  VALIDATION_ERROR            400  Request fields failed validation
  REQUIRED_FIELD_MISSING      400  Mandatory field not provided
  INVALID_FIELD_FORMAT        400  Field has wrong format (email, UUID, etc.)
  UNSUPPORTED_CURRENCY        400  Currency code not in supported list
  NEGATIVE_AMOUNT             400  Amount must be positive
  INVALID_DATE_RANGE          400  End date before start date
  DUPLICATE_LINE_ITEM         400  Same product twice in one invoice

  UNAUTHENTICATED             401  Missing or invalid API key / JWT
  TOKEN_EXPIRED               401  JWT token has expired (client: refresh)

  INSUFFICIENT_PERMISSIONS    403  Account lacks permission for this operation
  SUBSCRIPTION_REQUIRED       403  Feature requires paid subscription tier
  DEMO_ACCOUNT_LIMIT          403  Demo accounts cannot create live payments

  INVOICE_NOT_FOUND           404  Invoice with given ID does not exist
  CUSTOMER_NOT_FOUND          404  Customer ID not in this account

  INVOICE_ALREADY_PAID        409  Cannot modify a paid invoice
  DUPLICATE_REFERENCE_ID      409  reference_id already used on another invoice
  CUSTOMER_HAS_OPEN_INVOICES  409  Customer blocked due to > 5 unpaid invoices

  PAYMENT_CARD_DECLINED       422  Card issuer declined the charge
  PAYMENT_CARD_EXPIRED        422  Card expiry date has passed
  INSUFFICIENT_FUNDS          422  Card has insufficient funds
  FRAUD_SUSPECTED             422  Payment processor flagged as suspicious

  RATE_LIMIT_EXCEEDED         429  Too many requests (include Retry-After)

SERVER ERRORS (5xx — not client's fault, may retry):

  INTERNAL_ERROR              500  Unexpected server error (retry safe after delay)
  PAYMENT_PROCESSOR_ERROR     502  Stripe/payment processor returned an error
  SERVICE_UNAVAILABLE         503  InvoiceFlow is temporarily unavailable
  DATABASE_TIMEOUT            503  Database query timed out (retry after backoff)
  PAYMENT_PROCESSOR_TIMEOUT   504  Payment processor did not respond in time

──────────────────────────────────────────────────────────────────────────────

EXAMPLE: Comprehensive error responses

INVALID INVOICE CREATION:
POST /v2/invoices
{
  "customer_id": "cust_unknown",
  "currency": "XYZ",
  "line_items": [
    { "description": "Product A", "quantity": -1, "unit_price_cents": 5000 },
    { "description": "Product B", "quantity": 1, "unit_price_cents": 0 }
  ]
}

Response 400:
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invoice could not be created due to validation errors",
    "details": [
      {
        "field": "customer_id",
        "code": "CUSTOMER_NOT_FOUND",
        "message": "Customer 'cust_unknown' does not exist in your account",
        "suggestion": "Use GET /v2/customers to list your customers"
      },
      {
        "field": "currency",
        "code": "UNSUPPORTED_CURRENCY",
        "message": "Currency 'XYZ' is not supported",
        "allowed_values": ["usd", "eur", "gbp", "cad", "aud", "sgd"],
        "received": "XYZ"
      },
      {
        "field": "line_items[0].quantity",
        "code": "MUST_BE_POSITIVE",
        "message": "Quantity must be a positive integer, received: -1"
      },
      {
        "field": "line_items[1].unit_price_cents",
        "code": "MUST_BE_POSITIVE",
        "message": "unit_price_cents must be greater than 0, received: 0"
      }
    ],
    "request_id": "req_f47ac10b-2b0a-4e2f-9f1d-8c5b2a1d3e4f",
    "timestamp": "2024-01-15T10:30:00Z",
    "documentation": "https://api.invoiceflow.com/errors/VALIDATION_ERROR"
  }
}

PAYMENT DECLINED:
POST /v2/invoices/inv_abc/payments
{
  "payment_method_id": "pm_card_visa"
}

Response 422:
{
  "error": {
    "code": "PAYMENT_CARD_DECLINED",
    "message": "The card was declined by the card issuer",
    "decline_reason": "insufficient_funds",
    "user_message": "The payment was declined. Please use a different payment method or contact your bank.",
    "request_id": "req_g58bd21c",
    "invoice_id": "inv_abc",
    "amount_cents": 15000,
    "currency": "usd",
    "documentation": "https://api.invoiceflow.com/errors/PAYMENT_CARD_DECLINED"
  }
}

// Note: decline_reason is for DEVELOPER debugging
// user_message is pre-formatted for showing to end customers directly
// Never show raw decline reasons to customers (reveals card status)
```
