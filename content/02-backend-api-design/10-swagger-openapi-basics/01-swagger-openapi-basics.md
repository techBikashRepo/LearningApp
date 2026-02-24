# Swagger/OpenAPI Basics — Part 1 of 3

### Sections: 1 (Intuition & Analogy), 2 (Why It Exists), 3 (Core Technical Concepts), 4 (Real-World API Contract)

**Series:** Backend & API Design → REST APIs → System Design

---

## SECTION 1 — Intuition & Analogy

### The Blueprint Analogy

Imagine an architect designing a skyscraper. They produce a blueprint — a precise, standardized technical document that describes the building completely:

- Every room's dimensions
- Every door's position
- Every electrical outlet's location
- Every load-bearing wall's specification

This blueprint serves multiple audiences simultaneously:

- **Construction crew:** exactly what to build
- **Electrical engineers:** where to run cables
- **Plumbing engineers:** where to lay pipes (different concerns, same blueprint)
- **Building inspectors:** what to verify against
- **Future renovators:** what the building actually looks like

Each audience reads the SAME document and extracts what they need.

**OpenAPI is the blueprint for your API:**

```
Without OpenAPI (no blueprint):
  Frontend developer: "What parameters does POST /invoices accept?"
  Backend developer: "Check the code, I think it's in handlers/invoices.js"
  → Frontend reads backend code to understand the interface
  → Backend changes a field name → Frontend breaks (no one told them)
  → API consumer wants to use your API → no documentation → support tickets
  → QA engineer writes tests → manually figuring out what parameters exist

With OpenAPI (blueprint):
  Frontend developer: reads openapi.yaml → knows every endpoint, every field,
                       every possible error response, required vs optional fields
  SDK generator: reads openapi.yaml → auto-generates TypeScript client in 30 seconds
  Postman: imports openapi.yaml → collection instantly available with examples
  API Gateway: validates every request against openapi.yaml → bad requests rejected
  Documentation site: reads openapi.yaml → live interactive docs auto-generated
  QA engineer: reads openapi.yaml → generates test cases automatically

ONE FILE serves all these purposes simultaneously.
```

The OpenAPI specification is the single source of truth for what your API does — the contract between your server and every client.

---

## SECTION 2 — Why It Exists

### Problems Without a Specification

```
PROBLEM 1: Documentation and Implementation Drift
  API deployed with documentation written manually in Confluence/Notion.
  Sprint 3: engineer changes field from "amount" to "amount_cents" — just a better name.
  Confluence doc still says "amount". Frontend developer reads docs, uses "amount".
  API silently ignores unknown fields → frontend shows zero amounts.

  This happens on EVERY team that manually maintains documentation.
  Survey: 73% of API consumers report finding undocumented behavior in APIs.

  OpenAPI solution: code generates the spec (code-first) OR spec generates the code
  (contract-first). They cannot diverge because they are the same artifact.

PROBLEM 2: Integration Costs
  Your B2B API has 50 enterprise clients, each writing their own SDK.
  Client A uses Python → writes Python wrapper.
  Client B uses Java → writes Java wrapper.
  Each SDK is a months-long project, duplicated 50 times.
  You change an API response format → break all 50 SDKs.

  OpenAPI solution: publish openapi.yaml → run openapi-generator once per language.
  openapi-generator generate -i openapi.yaml -g python → complete Python SDK in seconds.
  When you update the spec: regenerate → clients get updated SDK automatically.

PROBLEM 3: Request Validation Complexity
  Without spec: every Lambda handler manually validates inputs:
    if (!body.amount) return 400;
    if (typeof body.amount !== 'number') return 400;
    if (body.amount < 0) return 400;
    if (!body.currency) return 400;
    if (!CURRENCIES.includes(body.currency)) return 400;
    // 40 more lines of boilerplate

  Each handler repeats this. Engineers forget edge cases. Validation is inconsistent.

  OpenAPI solution: define schema in spec. API Gateway validates automatically.
  Zero validation code in Lambda handlers. Consistent across all endpoints.

PROBLEM 4: Developer Experience
  Public API without interactive documentation:
  - Developer sees endpoint list with no examples
  - Developer writes code, makes request, gets cryptic error
  - Developer reverse-engineers parameters by trial and error
  - Time to first successful call: hours to days

  OpenAPI + Swagger UI:
  - Developer opens docs.yourapi.com
  - Sees every endpoint with parameter descriptions and examples
  - Clicks "Try it out" → fills in form → executes live request
  - Time to first successful call: minutes
```

---

## SECTION 3 — Core Technical Concepts

### OpenAPI 3.0 Document Structure

```yaml
openapi: "3.0.3"
info:
  title: InvoiceFlow API
  version: "2.0"
  description: >
    Invoice management and billing API.
    Base URL: https://api.invoiceflow.com/v2

servers:
  - url: https://api.invoiceflow.com/v2
    description: Production
  - url: https://sandbox.invoiceflow.com/v2
    description: Sandbox

# Reusable security scheme (referenced by individual operations)
components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
      bearerFormat: JWT

  # Reusable schemas (DRY — define once, reference everywhere)
  schemas:
    Invoice:
      type: object
      required: [id, status, customer_id, amount_cents, currency, created_at]
      properties:
        id:
          type: string
          example: inv_f47ac10b
        status:
          type: string
          enum: [draft, open, paid, void, uncollectible]
        customer_id:
          type: string
          example: cus_abc123
        amount_cents:
          type: integer
          minimum: 1
          description: Invoice total in smallest currency unit (cents)
          example: 2500
        currency:
          type: string
          minLength: 3
          maxLength: 3
          example: USD
        due_date:
          type: string
          format: date
          example: "2024-02-15"
        created_at:
          type: string
          format: date-time
          example: "2024-01-15T14:30:00Z"

    Error:
      type: object
      required: [error]
      properties:
        error:
          type: object
          required: [code, message, request_id]
          properties:
            code:
              type: string
              example: INVOICE_NOT_FOUND
            message:
              type: string
              example: Invoice 'inv_abc' was not found
            request_id:
              type: string
              example: req_f47ac10b
            details:
              type: array
              items:
                type: object

  # Reusable response definitions
  responses:
    Unauthorized:
      description: Authentication credentials are missing or invalid
      content:
        application/json:
          schema:
            $ref: "#/components/schemas/Error"
    NotFound:
      description: Resource not found
      content:
        application/json:
          schema:
            $ref: "#/components/schemas/Error"

# API endpoints
paths:
  /invoices:
    get:
      operationId: listInvoices
      summary: List invoices
      tags: [Invoices]
      security:
        - bearerAuth: []
      parameters:
        - name: status
          in: query
          schema:
            type: string
            enum: [draft, open, paid, void, uncollectible]
          description: Filter by invoice status
        - name: customer_id
          in: query
          schema:
            type: string
          description: Filter by customer
        - name: limit
          in: query
          schema:
            type: integer
            minimum: 1
            maximum: 100
            default: 20
        - name: cursor
          in: query
          schema:
            type: string
          description: Cursor for pagination (from previous response next_cursor)
      responses:
        "200":
          description: Paginated list of invoices
          content:
            application/json:
              schema:
                type: object
                required: [data, has_more]
                properties:
                  data:
                    type: array
                    items:
                      $ref: "#/components/schemas/Invoice"
                  has_more:
                    type: boolean
                  next_cursor:
                    type: string
                    nullable: true
        "401":
          $ref: "#/components/responses/Unauthorized"

    post:
      operationId: createInvoice
      summary: Create invoice
      tags: [Invoices]
      security:
        - bearerAuth: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [customer_id, currency, line_items]
              properties:
                customer_id:
                  type: string
                currency:
                  type: string
                  minLength: 3
                  maxLength: 3
                  example: USD
                due_date:
                  type: string
                  format: date
                line_items:
                  type: array
                  minItems: 1
                  items:
                    type: object
                    required: [description, quantity, unit_amount_cents]
                    properties:
                      description:
                        type: string
                        maxLength: 500
                      quantity:
                        type: integer
                        minimum: 1
                      unit_amount_cents:
                        type: integer
                        minimum: 1
            example:
              customer_id: cus_abc123
              currency: USD
              due_date: "2024-02-15"
              line_items:
                - description: "API Platform License (January)"
                  quantity: 1
                  unit_amount_cents: 29900
      responses:
        "201":
          description: Invoice created
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Invoice"
        "400":
          description: Validation error
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Error"
        "401":
          $ref: "#/components/responses/Unauthorized"

  /invoices/{id}:
    parameters:
      - name: id
        in: path
        required: true
        schema:
          type: string
        example: inv_f47ac10b
    get:
      operationId: getInvoice
      summary: Get invoice by ID
      tags: [Invoices]
      security:
        - bearerAuth: []
      responses:
        "200":
          description: Invoice details
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Invoice"
        "401":
          $ref: "#/components/responses/Unauthorized"
        "404":
          $ref: "#/components/responses/NotFound"
```

### Contract-First vs Code-First

```
CONTRACT-FIRST (spec → code):
  1. Write openapi.yaml manually (the contract)
  2. Generate server stubs: openapi-generator generate -g nodejs-express-server
  3. Implement business logic in generated handlers
  4. Tests validate against spec automatically

  Pros:
  + Spec and implementation cannot diverge (code comes FROM spec)
  + Forces API design discussion before any implementation
  + Frontend and backend can develop in parallel once spec is agreed
  + Perfect for teams where API design is a dedicated discipline

  Cons:
  - Requires spec discipline from day 1 (no "just code it")
  - YAML/JSON spec can be verbose and hard to co-maintain
  - Generated code needs careful customization to avoid regeneration conflicts

CODE-FIRST (code → spec):
  1. Write API handlers (Express, Lambda, FastAPI, etc.)
  2. Add decorators or JSDoc annotations to handlers
  3. Library generates openapi.yaml from annotations at build time

  Node.js example: `fastify-swagger` auto-generates from route schemas
  Python example: FastAPI generates from Pydantic models automatically

  Pros:
  + Natural for existing teams - familiar workflow
  + Closer to implementation → less drift risk
  + FastAPI (Python): automatic OpenAPI generation from type hints

  Cons:
  - Spec quality depends on annotation completeness
  - Easy to miss documenting error responses
  - API design happens in code review, not explicit design step

HYBRID (most practical for large teams):
  Define schemas in openapi.yaml (shared contract).
  Write route handlers independently.
  Validation middleware reads openapi.yaml and validates requests automatically.
  CI pipeline: validate generated spec matches hand-written spec.
  Schema drift → CI fails → engineer must update spec.
```

---

## SECTION 4 — InvoiceFlow OpenAPI Contract Summary

### Endpoint Overview

```
InvoiceFlow API v2 — Endpoint Summary
======================================

INVOICES:
  GET    /invoices                 List invoices (paginated, filterable)
  POST   /invoices                 Create invoice
  GET    /invoices/{id}            Get invoice
  PATCH  /invoices/{id}            Update draft invoice
  DELETE /invoices/{id}            Delete draft invoice (204 No Content)
  POST   /invoices/{id}/finalize   Finalize draft (status: draft → open)
  POST   /invoices/{id}/void       Void open invoice (status: open → void)

PAYMENTS:
  POST   /invoices/{id}/payments   Pay invoice
  GET    /invoices/{id}/payments   List payment attempts for invoice

CUSTOMERS:
  GET    /customers                List customers
  POST   /customers                Create customer
  GET    /customers/{id}           Get customer
  PATCH  /customers/{id}           Update customer

UPLOADS:
  POST   /uploads/initiate         Get presigned upload URL
  POST   /uploads/{id}/confirm     Confirm completed upload

WEBHOOKS:
  GET    /webhooks                 List webhook endpoints
  POST   /webhooks                 Register webhook endpoint
  DELETE /webhooks/{id}            Unregister webhook endpoint
```

### API Design Principles Encoded in the Spec

```
1. All IDs use prefix notation in examples:
   invoices: "inv_{id}"
   customers: "cus_{id}"
   payments: "pay_{id}"
   → clients can tell resource type from ID prefix

2. All monetary amounts: integer + currency (never float)
   amount_cents: integer (minimum: 1)
   currency: string (minLength/maxLength: 3)
   → "3.40" stored as amount_cents: 340, currency: "USD"

3. All timestamps: ISO 8601 string (format: date-time)
   created_at: "2024-01-15T14:30:00Z"
   → consistent across all endpoints, all time zones

4. All list responses: consistent envelope
   { data: [...], has_more: boolean, next_cursor: string | null }
   → every pagination implementation is identical

5. Nullable fields explicit in spec:
   next_cursor:
     type: string
     nullable: true
   → code generators produce Optional[str] or string | null correctly

6. Error responses defined on every endpoint:
   All endpoints declare 401 (auth required)
   Resource endpoints declare 404 (not found)
   Write endpoints declare 400 (validation), 422 (business rules)
   → consumers know exactly what errors to handle

7. Security required globally, overridable per operation:
   Default: security: [{ bearerAuth: [] }]
   Public endpoints: security: [] (override to unauthenticated)
   → exceptions are explicit, authentication is the default
```

### SDK Generation Example

```bash
# Generate TypeScript client from spec
npx @openapitools/openapi-generator-cli generate \
  -i https://api.invoiceflow.com/openapi.json \
  -g typescript-axios \
  -o ./generated/invoiceflow-client

# Generated client usage:
import { InvoicesApi } from './generated/invoiceflow-client';

const invoicesApi = new InvoicesApi({ accessToken: bearerToken });

// Fully type-safe — TypeScript knows the exact shape of request and response:
const { data: invoice } = await invoicesApi.createInvoice({
  customer_id: 'cus_abc',
  currency: 'USD',
  line_items: [
    { description: 'License', quantity: 1, unit_amount_cents: 29900 }
  ]
});

// TypeScript error: invoice.amount is not a field (spec says amount_cents)
// console.log(invoice.amount);       ← compile error
// console.log(invoice.amount_cents); ← correct, autocompleted

# Generate Python client:
openapi-generator generate -i openapi.yaml -g python -o ./python-client

# Generate Postman collection:
npx openapi-to-postman -i openapi.yaml -o invoiceflow.postman_collection.json
```
