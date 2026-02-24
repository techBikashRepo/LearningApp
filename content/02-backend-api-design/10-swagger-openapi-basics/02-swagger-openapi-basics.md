# Swagger/OpenAPI Basics — Part 2 of 3

### Sections: 5 (Architecture Diagram), 6 (Production Scenarios), 7 (Scaling & Reliability), 8 (AWS Implementation)

**Series:** Backend & API Design → REST APIs → System Design

---

## SECTION 5 — Architecture Diagram

### OpenAPI in the Development Lifecycle

```
                         OPENAPI ARCHITECTURE
                  (From Spec to Production)
                  ============================

DESIGN PHASE:
┌──────────────────────────────────────────────────────────────────────┐
│                        openapi.yaml                                  │
│                   (Single Source of Truth)                           │
│                                                                      │
│  Maintained in Git alongside code                                    │
│  PR review required for all spec changes                             │
│  Version tagged with API releases                                    │
│                                                                      │
│  Changes trigger: CI validation pipeline                             │
│  Breaking changes: require major version bump                        │
└────────────────────────────┬─────────────────────────────────────────┘
                             │ Consumed by all downstream tools
              ┌──────────────┼───────────────────────────────┐
              │              │                               │
              ▼              ▼                               ▼
┌─────────────────┐ ┌─────────────────┐           ┌─────────────────┐
│  SDK Generation │ │  Swagger UI /   │           │  API Gateway    │
│                 │ │  Redoc Docs     │           │  Validation     │
│  openapi-       │ │                 │           │                 │
│  generator:     │ │  Hosted at:     │           │  Import spec    │
│  • TypeScript   │ │  docs.invoice   │           │  API GW         │
│  • Python       │ │  flow.com       │           │  validates      │
│  • Java         │ │                 │           │  every request  │
│  • Go           │ │  Auto-generated │           │  against schema │
│  • Ruby         │ │  from spec      │           │  before Lambda  │
│  • C#/dotnet    │ │                 │           │  is invoked     │
│                 │ │  "Try it out"   │           │                 │
│  Regenerated on │ │  embedded       │           │  Bad requests   │
│  every release  │ │  Playground     │           │  rejected at GW │
└─────────────────┘ └─────────────────┘           └─────────────────┘

DEVELOPMENT PHASE:
┌──────────────────────────────────────────────────────────────────────┐
│               Code-First: Annotations → Spec Generation             │
│                                                                      │
│  FastAPI (Python):                                                   │
│    @app.post("/invoices", response_model=Invoice)                    │
│    async def create_invoice(invoice: InvoiceCreate):                 │
│      ...                                                             │
│    # FastAPI auto-generates /openapi.json from type hints            │
│                                                                      │
│  Express (Node.js) + swagger-jsdoc:                                  │
│    /**                                                               │
│     * @openapi                                                       │
│     * /invoices:                                                     │
│     *   post:                                                        │
│     *     requestBody: ...                                           │
│     */                                                               │
│    router.post('/invoices', handler);                                │
│    // swagger-jsdoc reads JSDoc → generates openapi.yaml             │
│                                                                      │
│  Contract-First:                                                     │
│    Write openapi.yaml                                                │
│    openapi-generator generates server stubs                          │
│    Engineers implement handler bodies only                           │
└──────────────────────────────────────────────────────────────────────┘

TESTING PHASE:
┌──────────────────────────────────────────────────────────────────────┐
│                    Contract Testing                                  │
│                                                                      │
│  Tool: Dredd, Schemathesis, or openapi-backend                       │
│                                                                      │
│  Schemathesis: automatically generates test cases from spec          │
│  • For each operation: generates valid + invalid requests            │
│  • Fuzzes parameters to find edge cases spec didn't consider         │
│  • Verifies each response matches declared schema                    │
│                                                                      │
│  schemathesis run openapi.yaml --url http://localhost:3000           │
│                                                                      │
│  CI pipeline: runs contract tests on every PR                        │
│  If response doesn't match schema: test fails → PR blocked           │
│  This catches: undocumented fields added, type changes, missing 404s │
└──────────────────────────────────────────────────────────────────────┘

PRODUCTION DEPLOYMENT:
┌──────────────────────────────────────────────────────────────────────┐
│                   API Gateway + OpenAPI                              │
│                                                                      │
│  aws apigateway import-rest-api --body file://openapi.yaml           │
│                                                                      │
│  API GW reads spec and:                                              │
│  • Creates all routes defined in paths                               │
│  • Wires each route to its backend integration (Lambda ARN)          │
│  • Enables request validation (validates body against schema)        │
│  • Returns structured 400 on schema violation (before Lambda runs)   │
│                                                                      │
│  Benefit: Lambda handlers receive only valid requests                │
│  Removes validation boilerplate from handler code                    │
└──────────────────────────────────────────────────────────────────────┘
```

---

## SECTION 6 — Production Scenarios

### Scenario A: Stripe's API Reference — World's Best API Documentation

```
Stripe's API documentation is consistently ranked as the best in the industry.
200,000+ developers, $1 trillion+ in payment volume processed annually.
Documentation quality has been cited as a key reason Stripe won against incumbents.

What Stripe does:

1. Every parameter documented with:
   - Type and format
   - Required vs optional, shown clearly
   - Default value if applicable
   - Example value
   - Linked to related parameters
   - "Expandable" annotation for nested resource objects

2. Every response documented with:
   - Complete schema of success response
   - All possible error codes with conditions that trigger them
   - Sample response JSON shown inline

3. Interactive examples in multiple languages:
   curl / Node.js / Python / Ruby / Go / Java / PHP / .NET
   Switch language: example updates immediately

4. Versioning in docs:
   Each dated API version has own documentation snapshot
   Developer can see what changed between versions
   Side-by-side diffs for version migration

5. Webhooks documented as OpenAPI event schemas:
   Every webhook event has schema matching the API resource schema
   => Consistent mental model between API responses and webhook payloads

RESULT:
  Stripe's time-to-first-call metric: ~30 minutes for most developers
  Industry average for comparable payment APIs: 3-5 days
  This is competitive advantage built entirely on documentation quality.
```

---

### Scenario B: Spec Validation Catching a Breaking Change

```
SCENARIO: API v2 has been live for 18 months, 200 clients in production.

Engineer raises PR:
  // Making invoice status more specific
  - "status": "open"
  + "status": "outstanding"  // open → outstanding rename

Without spec + CI validation:
  PR merged, deployed → 200 clients polling invoice status
  All code checking `if (invoice.status === 'open')` silently breaks
  No errors until clients notice wrong behavior in production
  Mass incident: 200 support tickets, engineers debugging client-side code

With spec + CI validation (breaking change detection):
  PR modifies openapi.yaml:
    status:
      enum: [draft, outstanding, paid, void, uncollectible]  # 'open' removed

  CI runs oasdiff (OpenAPI diff tool):
    oasdiff breaking openapi-v2.yaml openapi-v2-proposed.yaml

  Output:
    BREAKING CHANGE: GET /invoices response property 'status' removed enum value 'open'
    BREAKING CHANGE: GET /invoices/{id} response property 'status' removed enum value 'open'
    (+ 12 more endpoints)

  CI fails → PR blocked → engineer must either:
  a) Add both 'open' and 'outstanding' (backward compatible, migrate gradually)
  b) Bump to v3 and maintain v2 compatibility window
  c) Abandon the rename (product decision re: migration cost)

oasdiff is the tool used by teams at Shopify, Cloudflare, and Atlassian for this.
Breaking change types detected:
  - Removed endpoint
  - Removed required request parameter
  - Added required request parameter
  - Removed response field
  - Changed field type
  - Removed enum value (like above)
  - Changed authentication requirement
```

---

## SECTION 7 — Scaling & Reliability

### OpenAPI Spec Quality Standards

```
A spec that teams actually use must meet quality standards.
Common problems in real-world specs and their fixes:

PROBLEM 1 — Missing error responses (most common omission):
  INCOMPLETE:
    post:
      responses:
        '200':
          ...
        # No 400, 401, 404, 422 defined

  COMPLETE:
    post:
      responses:
        '201':
          $ref: '#/components/responses/InvoiceCreated'
        '400':
          $ref: '#/components/responses/ValidationError'
        '401':
          $ref: '#/components/responses/Unauthorized'
        '403':
          $ref: '#/components/responses/Forbidden'
        '422':
          $ref: '#/components/responses/BusinessRuleError'

PROBLEM 2 — Undescribed parameters (spec pollution):
  INCOMPLETE:
    parameters:
      - name: status
        in: query
        schema:
          type: string
        # No description, no enum, no example

  COMPLETE:
    parameters:
      - name: status
        in: query
        description: >
          Filter invoices by current status.
          Use 'open' to find invoices awaiting payment.
          Use 'paid' for reconciliation reports.
        schema:
          type: string
          enum: [draft, open, paid, void, uncollectible]
        example: open

PROBLEM 3 — Missing $ref (schema duplication):
  WRONG: Copy-paste Invoice schema into every response
  RIGHT: Define Invoice once in components.schemas.Invoice, $ref everywhere
  Reason: Single change updates all references. Copy-paste diverges over time.

PROBLEM 4 — No examples:
  Spec without examples = developer must guess what valid data looks like.
  Every request body should have a realistic example showing all supported fields.
  Every response schema should have an example showing a realistic object.

PROBLEM 5 — Incorrect nullable handling:
  WRONG:
    amount:
      type: [string, null]  # JSON Schema syntax, not OpenAPI 3.0

  CORRECT (OpenAPI 3.0):
    amount:
      type: string
      nullable: true

  CORRECT (OpenAPI 3.1 — uses JSON Schema):
    amount:
      type: [string, null]  # OpenAPI 3.1 supports this
```

### CI/CD Spec Validation Pipeline

```yaml
# .github/workflows/api-spec.yml
name: OpenAPI Spec Validation

on:
  pull_request:
    paths:
      - "openapi.yaml"
      - "src/**/*.ts" # if code-first, changes may affect generated spec

jobs:
  validate-spec:
    runs-on: ubuntu-latest
    steps:
      # 1. Lint spec for common quality issues
      - name: Lint OpenAPI spec
        uses: lornasong/redoc-lint-action@v1
        with:
          args: openapi.yaml

      # 2. Validate spec syntax (catches YAML errors, ref resolution failures)
      - name: Validate spec syntax
        run: npx @redocly/cli lint openapi.yaml --extends recommended

      # 3. Check for breaking changes against main branch
      - name: Check breaking changes
        run: |
          npx oasdiff breaking \
            https://api.invoiceflow.com/openapi.json \
            openapi.yaml \
            --fail-on-diff

      # 4. Run contract tests against local server
      - name: Contract tests
        run: |
          docker-compose up -d
          npx schemathesis run openapi.yaml --url http://localhost:3000 \
            --checks all

  publish-docs:
    needs: validate-spec
    if: github.ref == 'refs/heads/main'
    steps:
      - name: Deploy Redoc to S3/CloudFront
        run: |
          npx redoc-cli bundle openapi.yaml -o docs/index.html
          aws s3 sync docs/ s3://invoiceflow-docs/api/
          aws cloudfront create-invalidation \
            --distribution-id $CF_DIST_ID \
            --paths "/api/*"
```

---

## SECTION 8 — AWS Implementation

### API Gateway Import and Validation

```yaml
# openapi.yaml — AWS API Gateway extensions embedded in OpenAPI spec
openapi: "3.0.3"
info:
  title: InvoiceFlow API

paths:
  /invoices:
    post:
      operationId: createInvoice
      # AWS extension: connects this operation to a Lambda function
      x-amazon-apigateway-integration:
        type: aws_proxy
        httpMethod: POST
        uri: !Sub "arn:aws:apigateway:${AWS::Region}:lambda:path/2015-03-31/functions/${CreateInvoiceLambda.Arn}/invocations"
        passthroughBehavior: never
      # API GW will validate request body against the requestBody schema
      x-amazon-apigateway-request-validator: body-only
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/CreateInvoiceRequest"
      responses:
        "201":
          description: Invoice created

# Define request validators
x-amazon-apigateway-request-validators:
  body-only:
    validateRequestBody: true
    validateRequestParameters: false
  full:
    validateRequestBody: true
    validateRequestParameters: true

# API GW gateway responses (override default AWS error format)
x-amazon-apigateway-gateway-responses:
  BAD_REQUEST_BODY:
    statusCode: 400
    responseTemplates:
      application/json: |
        {
          "error": {
            "code": "VALIDATION_ERROR",
            "message": $context.error.messageString,
            "request_id": "$context.requestId"
          }
        }
```

```bash
# Import spec to API Gateway (creates all routes automatically)
aws apigateway import-rest-api \
  --fail-on-warnings \
  --body file://openapi.yaml

# Deploy to stage
aws apigateway create-deployment \
  --rest-api-id abc123 \
  --stage-name prod \
  --description "v2.1.0 release"

# Result: ALL routes from openapi.yaml are created and wired to Lambdas
# No manual route configuration required
# Spec is the infrastructure definition
```

### Swagger UI Hosting (S3 + CloudFront)

```javascript
// Before Lambda returns response, we serve docs from CloudFront
// Static generated documentation — no server needed

// Redoc: generates single HTML file from spec
// npx redoc-cli bundle openapi.yaml -o docs/index.html --title "InvoiceFlow API"

// S3 config for docs hosting:
// Bucket: invoiceflow-docs (public read for docs)
// CloudFront: https://docs.invoiceflow.com → S3 origin

// Lambda: serve the spec itself (for SDK generation use)
// GET /openapi.json → returns current spec
export const serveSpec = async (event) => {
  const spec = await s3.getObject({
    Bucket: "invoiceflow-assets",
    Key: "api/openapi.json",
  });

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json",
      // Allow SDK generators from any origin to fetch the spec
      "Access-Control-Allow-Origin": "*",
      // Cache spec for 5 minutes (not forever — may need to update)
      "Cache-Control": "public, max-age=300",
    },
    body: await spec.Body.transformToString(),
  };
};

// CloudFront behavior:
//   /openapi.json → API Gateway → Lambda (dynamic spec with version)
//   /docs/*       → S3 (static Redoc HTML)
//   /api/*        → API Gateway → Lambda handlers
```

### Automated SDK Publishing

```yaml
# .github/workflows/publish-sdk.yml
# Triggered when openapi.yaml changes on main

name: Publish SDKs

on:
  push:
    branches: [main]
    paths: ["openapi.yaml"]

jobs:
  generate-typescript-sdk:
    runs-on: ubuntu-latest
    steps:
      - name: Generate TypeScript SDK
        run: |
          npx openapi-generator-cli generate \
            -i openapi.yaml \
            -g typescript-axios \
            -o ./sdk/typescript \
            --additional-properties=npmName=@invoiceflow/api-client \
            --additional-properties=npmVersion=${{ github.sha }}

      - name: Publish to npm
        env:
          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
        run: |
          cd sdk/typescript
          npm publish --access public

  generate-python-sdk:
    runs-on: ubuntu-latest
    steps:
      - name: Generate Python SDK
        run: |
          openapi-generator generate \
            -i openapi.yaml \
            -g python \
            -o ./sdk/python \
            --additional-properties=packageName=invoiceflow_client

      - name: Publish to PyPI
        run: |
          cd sdk/python
          pip install build twine
          python -m build
          twine upload dist/* -u __token__ -p ${{ secrets.PYPI_TOKEN }}

# Result: every time spec changes, TypeScript and Python SDKs
# are automatically regenerated and published with the latest version.
# SDK consumers run: npm update @invoiceflow/api-client
# and get type-safe access to the latest API immediately.
```
