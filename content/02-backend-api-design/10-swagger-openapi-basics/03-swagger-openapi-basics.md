# Swagger/OpenAPI Basics — Part 3 of 3

### Sections: 9 (Interview Prep), 10 (Comparison Tables), 11 (Quick Revision), 12 (Architect Thinking Exercise)

**Series:** Backend & API Design → REST APIs → System Design

---

## SECTION 9 — Interview Questions & Patterns

### Beginner-Level Questions

**Q: What is OpenAPI and what problem does it solve?**

```
OpenAPI (formerly Swagger) is a specification format for describing REST APIs.
An openapi.yaml file fully describes your API: every endpoint, every parameter,
every request body schema, every response schema, and every possible error response.

Problems it solves:

1. Documentation drift:
   Without OpenAPI: developer writes docs in Confluence, code changes, docs go stale.
   With OpenAPI: spec is in Git alongside code, changes require spec updates in the same PR.

2. Multiple-audience communication:
   Same spec serves: frontend devs, SDK generators, API GW validators, QA tools.
   Everyone reads one source of truth instead of asking the backend team.

3. Request validation:
   Import openapi.yaml into API Gateway → all requests validated against schemas.
   Lambda handlers receive only valid requests.
   Zero validation boilerplate replicated across handlers.

4. Developer experience:
   Swagger UI or Redoc generates interactive documentation automatically.
   Developer can test endpoints directly in the browser without writing any code.

Analogy: OpenAPI is the blueprint for your API.
Just as all construction workers work from the same architectural blueprint,
all API consumers work from the same openapi.yaml.
```

---

**Q: What is the difference between Swagger and OpenAPI?**

```
Short answer: Swagger is the old name. OpenAPI is the current name.

Timeline:
  2010: Wordnik engineers create the Swagger specification to document their API.
  2011: swagger-ui (the interactive docs viewer) released as open source.
  2015: SmartBear (commercial software company) acquires Swagger.
  2016: Swagger specification donated to the Linux Foundation.
  2016: Renamed OpenAPI Specification under the OpenAPI Initiative.
        Members: Google, Microsoft, IBM, Salesforce, Oracle, PayPal, and others.
  2017: OpenAPI 3.0.0 released (major improvements over Swagger 2.0)
  2021: OpenAPI 3.1.0 released (full JSON Schema alignment)

Today:
  "Swagger" commonly refers to swagger-ui (the documentation viewer) and
  the suite of tools (swagger-editor, swagger-codegen) from SmartBear.
  "OpenAPI" refers to the specification itself.

  But in practice: engineers use the terms interchangeably.
  "Swagger docs" = documentation generated from an OpenAPI spec.
  No one corrects you in a meeting for saying "Swagger" when you mean OpenAPI.

  Version note: if someone says "Swagger spec" they likely mean OpenAPI 2.0.
  OpenAPI 3.0+ is a breaking change from Swagger 2.0 in several areas.
```

---

**Q: What is the difference between OpenAPI 2.0 (Swagger) and OpenAPI 3.0?**

```
Key differences that matter in practice:

1. Request body definition:
   2.0: uses "parameters" with "in: body" (limited to one body parameter)
   3.0: uses "requestBody" object (cleaner, supports multiple content types)

2. Multiple server support:
   2.0: single host + basePath (one server only)
   3.0: "servers" array (multiple environments: prod, sandbox, local)

3. Response links:
   3.0 adds "links" to describe relationships between responses:
   Create invoice response → links to Get invoice operation.

4. Components vs definitions:
   2.0: schemas in "#/definitions/"
   3.0: schemas in "#/components/schemas/" (more organized, more reusable types)

5. Nullable:
   2.0: no standard way to express nullable fields
   3.0: nullable: true added to schema properties

6. anyOf / oneOf / not:
   3.0 adds full support for polymorphic schemas.
   Useful for: request that can be one of two formats.

In practice: if you're starting a new API, use OpenAPI 3.0.
If you're maintaining an existing 2.0 spec, migrate when convenient.
Most tools now support 3.0 well.
```

---

### Intermediate-Level Questions

**Q: What is contract-first API development and why do some teams prefer it?**

```
Contract-first: you write the OpenAPI spec before any implementation code.

Workflow:
  1. Product + engineering agree on API contract (openapi.yaml)
  2. Team reviews contract: Is this the right data shape? Missing fields? Naming ok?
  3. Contract is merged to main → frozen as the agreement
  4. Backend team implements the server
  5. Frontend team generates a mock server from the spec (Prism tool):
     npx @stoplight/prism-cli mock openapi.yaml
     → local mock server runs at localhost:3000
  6. Frontend team develops against the mock server while backend implements
  7. Both teams work in parallel — no blocking each other
  8. When backend is done: frontend switches URL from localhost:3000 to real API
  9. First integration test should pass because both sides implemented the same contract

Why teams prefer it:
  1. Parallel development: frontend and backend don't block each other
  2. Design review before implementation: catch issues before they're written in code
  3. Clear handoff: product can review spec before any implementation work starts
  4. External APIs: publish spec to partner teams before implementation is done
  5. Better APIs: discussing the contract explicitly produces better-designed APIs

Why teams resist it:
  1. Feels like extra YAML work before "real" development
  2. Requirements change → spec must be updated → feels like churn
  3. Teams not disciplined about keeping spec updated during development

Counter: code-first with strict spec generation tools (FastAPI auto-generates from types)
         achieves similar outcomes with less upfront friction.
```

---

**Q: How do you prevent spec drift in a code-first approach?**

```
Code-first: implementation generates or manually maintains the spec.

Drift causes:
  - Engineer adds a new response field without updating spec
  - Engineer changes parameter name in code, forgets to update spec
  - Test-coverage gap: spec says endpoint returns 404 but handler never does

Techniques to prevent drift:

1. Contract tests on CI (most effective):
   schemathesis run openapi.yaml --url http://localhost:3000 --checks all
   Schemathesis generates requests from spec, validates responses against spec.
   If implementation adds a field not in spec: test passes (response is superset).
   If implementation removes a required field: test fails → PR blocked.

2. Response schema validation middleware:
   Every response is validated against the OpenAPI response schema at runtime.
   In development/staging: schema mismatch → 500 error with diff details.
   In production: schema mismatch → log warning (don't break clients over internal error).

   Library: express-openapi-validator (validates requests AND responses)

3. Generated spec with linting:
   FastAPI: spec generated from code automatically on each build.
   oasdiff: compare generated spec (from this build) against previous release spec.
   Breaking changes detected automatically.

4. PR checklist:
   PR template includes: "Did you update openapi.yaml for any API changes?"
   Simple but effective for teams disciplined about this.

5. Type generation from spec:
   Generate TypeScript types from spec: openapi-typescript spec.yaml > types.ts
   Both handler code and spec derive from same types.
   Handler using a field not in spec: TypeScript compile error.
```

---

### Advanced Question

**Q: Design the OpenAPI governance process for a company with 12 API teams and 50 external consumers**

```
Context:
  12 internal teams each maintain their own APIs.
  50 external customers consuming multiple internal APIs.
  Problem: every team has different conventions, different error formats,
           different naming styles, different versioning approaches.

  External developer feedback: "Every InternalCo API feels like a different company."

SOLUTION: API Platform Team + OpenAPI Governance

1. Shared Spec Standards (enforced by linting):
   Create: api-standards/openapi.yaml (base spec with shared components)

   Defines:
   - components.schemas.Error (standard error format — ALL teams must use)
   - components.responses.Unauthorized, NotFound, etc.
   - conventions: camelCase for JSON, ISO 8601 dates, amount_cents pattern

   Teams extend the shared base:
   openapi.yaml:
     components:
       schemas:
         Invoice:
           $ref: '#/components/schemas/Invoice'  # own schemas
     $merge: api-standards/openapi.yaml  # inherits shared error schemas

2. Spec Linting Rules (enforced by CI on every team's repo):
   Custom Redocly ruleset: internal-api-standards.yaml

   Rules enforced:
   - Error responses must $ref components.responses.StandardError
   - All IDs must have example values
   - No operation without tags
   - All enums must have description
   - No raw object type without properties defined
   - operationId must be present on all operations
   - Monetary amounts must use integer + currency (flag float + "amount" fields)

   CI: if linting fails → PR cannot merge
   Every team's CI runs: npx redocly lint --config internal-standards.yaml api.yaml

3. Developer Portal (central discovery):
   API Platform hosts: developer.internalco.com/apis
   Each team publishes their spec to the portal via CI deploy step

   Portal features:
   - Unified search: developer searches "invoice" → finds all APIs with invoice operations
   - Side-by-side comparison: see how Team A and Team B designed similar endpoints
   - Changelog: every spec version tracked with diff
   - Subscription: external developer subscribes to changelog of APIs they consume

4. Breaking Change Governance:
   Internal APIs: breaking changes require 60-day notice to affected teams
   External APIs: breaking changes require 6-month deprecation window

   Process:
   - Engineer wants to make breaking change → opens RFC (Request For Comment) in GitHub
   - Affected teams are tagged automatically (from API dependency graph in portal)
   - 2-week review window → comments → approved/rejected
   - If approved: breaking change plan published with migration guide in spec

   Tools: oasdiff in CI flags breaking changes automatically
          Portal shows "BREAKING CHANGE" badge on new versions

5. SDK Governance:
   Central SDK team maintains generated SDKs for top 3 languages
   Each team publishes spec → SDK team regenerates → publishes to internal npm registry
   External consumers: single SDK package that wraps all InternalCo APIs

   Result: external developer installs one package, gets typed access to all internal APIs.

OUTCOME METRICS:
  Before governance:
    External dev onboarding: 3 weeks average per API
    Breaking change incidents: 8 per quarter
    Support tickets about API contracts: 120/month

  After governance (6 months):
    External dev onboarding: 3 days average per API
    Breaking change incidents: 1 per quarter (governed, planned)
    Support tickets: 15/month (down 87.5%)
```

---

## SECTION 10 — Comparison Tables

### OpenAPI Tooling Overview

```
CATEGORY          TOOL              USE CASE                       NOTES
──────────────────────────────────────────────────────────────────────────────────────
Editing           Swagger Editor    Write spec with live preview   editor.swagger.io
                  Stoplight Studio  GUI-based spec editor          Team/enterprise
                  VS Code + Redocly IntelliSense + validation      Free, offline

Documentation     Swagger UI        Interactive docs, "Try it"     Embedded in apps
                  Redoc             Beautiful read-only docs       Better SEO/style
                  Rapidoc           Lightweight, fast              Web Component embed

Validation        Redocly CLI       Lint spec quality              CI integration
                  spectral          Configurable rules             Custom rule support
                  openapi-validator Validate spec structure        Node.js library

Contract Testing  Schemathesis      Fuzzing + schema validation    Property-based tests
                  Dredd             Request/response validation    Older, stable
                  openapi-backend   Node.js spec-based routing     Validate in code

Mock Server       Prism             Mock server from spec          Contract-first dev
                  Mockoon           GUI mock server tool           Easy for non-engineers

SDK Generation    openapi-generator 50+ language targets           Large community
                  swagger-codegen   Similar, older project         SmartBear maintained
                  hey-api/client    TypeScript-specific, modern    Newest, clean output

Breaking Changes  oasdiff           OpenAPI diff + breaking check  Go tool, fast
                  openapi-diff      Java-based diff tool           Older, verbose
```

### Contract-First vs Code-First

```
DIMENSION             CONTRACT-FIRST              CODE-FIRST
─────────────────────────────────────────────────────────────────────
Spec quality          High (spec is the design)   Variable (depends on annotations)
Parallel development  Yes (mock server from spec) No (need running server first)
Design phase          Explicit spec review        In code review
API quality           Deliberate, consistent      Good if team is disciplined
Learning curve        Higher (YAML upfront)       Lower (familiar code)
Drift risk            Low (spec = source)         Medium to high without enforcement
Best for              B2B APIs, external facing   Internal APIs, fast iteration
                      Large teams, multiple clients  Small teams, prototypes
Framework support     All (generate stubs)        FastAPI, Fastify (best native support)
```

### OpenAPI Versions

```
FEATURE                          SWAGGER 2.0     OPENAPI 3.0    OPENAPI 3.1
────────────────────────────────────────────────────────────────────────────────
Request body                     in: body        requestBody    requestBody
Multiple servers                 No              Yes            Yes
Nullable fields                  x-nullable      nullable: true type: [type, null]
JSON Schema alignment            Partial         Mostly         Full
anyOf / oneOf / not              Limited         Full           Full
Webhooks                         No              No             Yes (webhooks key)
Callbacks                        No              Yes            Yes
Path-level parameters            Yes             Yes            Yes
File upload in OpenAPI           Crude           Clean          Clean
Link between operations          No              Yes (links)    Yes (links)
Industry support                 Legacy          Current widely Current, less adoption
```

---

## SECTION 11 — Quick Revision

### 10 Core Takeaways

```
1. OpenAPI is a contract, not just documentation.
   It defines the API's behavior as a machine-readable specification.
   Documentation is one output — SDK generation, validation, testing are others.

2. The spec should live in Git alongside code.
   API change = spec change = code change → all in the same PR.
   Spec in Confluence or Notion = guaranteed drift within 30 days.

3. $ref everything to avoid duplication.
   Define Invoice once in components.schemas.Invoice.
   $ref: '#/components/schemas/Invoice' in every place you use it.
   One definition change updates everywhere.

4. Document ALL error responses, not just the happy path.
   APIs that only document 200 responses are useless for production clients.
   Client's retry logic, error handling UI, and alerting all depend on 4xx/5xx docs.

5. Import spec to API Gateway — eliminate validation boilerplate.
   Spec imported to API GW = schema validation before Lambda runs.
   Lambda only receives valid, conforming requests.

6. Contract-first enables parallel development.
   Agree on spec → frontend mocks with Prism → backend implements.
   Both teams work simultaneously. Zero blocking.

7. oasdiff in CI catches breaking changes before they hit production.
   Removing an enum value, renaming a field, removing a response property —
   all are breaking changes automatically detected and CI-blocked.

8. Schemathesis auto-generates test cases from your spec.
   No manual test case writing. Fuzz tests from your own schema for free.
   Run in CI → catches undocumented behavior.

9. OpenAPI generator produces SDKs in 50+ languages from your spec.
   Publish spec → clients regenerate SDKs → type-safe access to your API.
   No manual SDK maintenance for standard REST patterns.

10. OpenAPI 3.1 aligns fully with JSON Schema — use it for new projects.
    3.1 allows type: [string, null] instead of nullable: true.
    JSON Schema validators (ajv, etc.) work directly on 3.1 schemas.
```

### 30-Second Explanation

> "OpenAPI is a YAML or JSON file that fully describes your REST API — every endpoint, every parameter, every request body schema, and every possible response including errors. It serves as the single source of truth that multiple tools can read: API Gateway uses it for request validation, Swagger UI generates interactive docs from it, openapi-generator creates client SDKs from it, and Schemathesis generates contract tests from it. The key insight is that it's a contract — both your server and every client agree on the same spec, so any deviation is caught automatically by tooling rather than discovered in production."

### Mnemonics

```
OPENAPI STRUCTURE — "IPSCP":
  I — Info (title, version, description)
  P — Paths (endpoint definitions)
  S — Servers (base URLs, environments)
  C — Components (reusable schemas, responses, security)
  P — Parameters (global reusable parameters)

SPEC QUALITY — "DETES":
  D — Describe all errors (not just happy path)
  E — Examples on every parameter and request body
  T — Tags on every operation (for grouping in UI)
  E — Enums documented with description
  S — Schemas DRY (use $ref, not copy-paste)

TOOLING — "VDMT":
  V — Validate spec with Redocly/Spectral
  D — Document with Swagger UI or Redoc
  M — Mock with Prism for contract-first dev
  T — Test with Schemathesis for contract compliance

BREAKING CHANGE TYPES — "RARE":
  R — Remove endpoint or field
  A — Add required parameter
  R — Rename field or operation
  E — Enum value removed
```

---

## SECTION 12 — Architect Thinking Exercise

### Exercise: DataStream — Multi-Tenant Analytics API

**Scenario:**

You are the lead architect at DataStream, a B2B analytics platform. Your API is consumed by 80 enterprise clients (Fortune 500 companies), each with their own team of 5-20 engineers. DataStream's engineering organization has 6 product teams, each owning a segment of the API:

- Events Team: `POST /events`, `GET /events`
- Reports Team: `GET /reports`, `POST /reports/run`
- Segments Team: `GET /segments`, `POST /segments`
- Destinations Team: `GET /destinations`, `POST /destinations`, `PATCH /destinations/{id}`
- Users Team: `GET /users`, `POST /users`, authentication and permissions
- Billing Team: `GET /usage`, `GET /invoices` (separate service, different API gateway)

**Problems reported:**

1. Each team maintains their own openapi.yaml — 6 separate specs with wildly inconsistent naming (some use snake_case, some camelCase, some use `id` as field name, some use `{resource}_id`).

2. Clients building integrations must read 6 different documentation sites with no cross-referencing.

3. When Events Team changes a response schema, Segments Team (which queries event data) finds out in their integration tests, not before deployment.

4. 3 enterprise clients have requested Python, Go, and Java SDKs. Each client team is building their own — duplicated effort, diverging from the actual API.

5. Two clients reported submitting "valid" requests that failed with cryptic errors — investigation reveals one team's field is undocumented, another team's required field is described as optional in their spec.

**Design the OpenAPI architecture and governance process to fix these problems.**

---

### Model Solution

**Architecture: Unified API Specification**

```
GOAL: One developer portal, one specification, consistent conventions.

APPROACH: Federated spec with shared base, unified at build time.

DIRECTORY STRUCTURE (monorepo or separate repos with shared package):
  api-spec/
  ├── foundation/
  │   ├── base-spec.yaml         ← shared: error schemas, pagination, auth, conventions
  │   ├── components/
  │   │   ├── schemas/
  │   │   │   ├── Error.yaml     ← canonical error format, ALL teams $ref this
  │   │   │   ├── Pagination.yaml
  │   │   │   └── Timestamp.yaml ← shared type definitions
  │   │   └── responses/
  │   │       ├── 401.yaml
  │   │       ├── 403.yaml
  │   │       └── 404.yaml
  │   └── conventions.md         ← naming rules, documented
  ├── events/
  │   └── events-spec.yaml       ← Events team owns this file
  ├── reports/
  │   └── reports-spec.yaml      ← Reports team owns this file
  ├── segments/
  │   └── segments-spec.yaml
  ├── destinations/
  │   └── destinations-spec.yaml
  ├── users/
  │   └── users-spec.yaml
  └── build/
      └── merged-openapi.yaml    ← CI generates this by merging all team specs

BUILD STEP (CI generates unified spec):
  npx @redocly/cli bundle foundation/base-spec.yaml \
    --ext yaml > build/merged-openapi.yaml
  # Each team's spec listed as $ref from base-spec.yaml paths section

  RESULT: merged-openapi.yaml is the single spec covering all 6 teams.
  Developer portal publishes from merged-openapi.yaml only.
  Enterprise clients point their SDK generators at merged-openapi.yaml.
```

---

**Governance: Enforced Consistency**

```
NAMING CONVENTIONS (foundation/conventions.md, enforced by linting):

1. Property naming: snake_case everywhere.
   YES: user_id, created_at, event_type
   NO:  userId, createdAt, eventType

2. Resource ID pattern:
   YES: { "event_id": "evt_abc" }  (resource prefix + underscore)
   NO:  { "id": "abc" }  (generic "id" is ambiguous in payloads)

3. Timestamps: ISO 8601 with timezone
   YES: "2024-01-15T14:30:00Z"
   NO:  1705326600 (Unix), "Jan 15 2024" (human-readable)

4. Pagination: cursor-based, consistent envelope
   All list endpoints:
   { "data": [...], "has_more": boolean, "next_cursor": string | null }

5. Error format: ALWAYS use foundation/components/schemas/Error via $ref
   No team may define their own error schema.

LINTING RULES (.redocly.yaml):
  rules:
    # Naming
    rule/snake-case-properties:
      subject: {type: Schema, property: properties}
      assertions: {casing: snake_case}

    # Error schema consistency
    rule/standard-error-ref:
      subject: {type: Response, property: content}
      where: {property: statusCode, value: /4[0-9]{2}|5[0-9]{2}/}
      assertions:
        ref: '#/components/schemas/Error'

    # No operations without tags
    operation-tag-defined: error

    # No operations without examples
    rule/require-examples:
      subject: {type: Schema}
      assertions:
        defined: [example, examples]

    # IDs must use resource prefix pattern
    rule/id-naming:
      subject: {type: Schema, property: properties}
      where: {name: /^(\w+)_id$/}
      assertions:
        notPattern: '^id$'  # bare 'id' not allowed
```

---

**Cross-Team Dependency Detection**

```
PROBLEM: Events Team changes response schema → Segments Team not notified.

SOLUTION: API Dependency Graph + Automated Notifications

1. Each team declares what they consume in their spec's x-extensions:
   events-spec.yaml:
     x-consumes:
       - team: users
         operations: [getUser, listUsers]
       - team: segments
         operations: [getSegment]

2. CI step runs dependency analysis:
   When events-spec.yaml merges a breaking change:
     → Read all x-consumes declarations
     → Find all teams that consume affected events operations
     → Post GitHub comment: "⚠️ Breaking change in Events API:
        Teams that may be affected: Segments, Reports"
     → Tag those teams' tech leads in the PR

3. Impact assessment required:
   PR checklist: "List all teams you have notified about this breaking change"
   PR cannot merge to main without checking this box.

4. Deprecation timeline enforced:
   Breaking changes to shared schemas: 30-day deprecation for internal teams
   New version published alongside old: overlap window where both work
   oasdiff detects breaking changes automatically in CI
```

---

**SDK Strategy**

```
SOLUTION: Platform-managed SDK pipeline

1. Setup SDK repository: github.com/datastream/api-clients
2. CI pipeline watches merged-openapi.yaml for changes
3. On change: regenerate all SDKs from merged spec

GitHub Actions:
  - Generate Python SDK → publish to PyPI as datastream-client
  - Generate Go SDK → publish to Go module registry as github.com/datastream/go-client
  - Generate Java SDK → publish to Maven Central as io.datastream:client
  - Generate TypeScript → publish to npm as @datastream/client

Enterprise client communication:
  "We now provide officially supported SDKs for Python, Go, and Java.
  All SDKs are generated from our OpenAPI spec automatically on every release.
  They are always in sync with the current API."

  Clients who built their own SDKs: "You can migrate to ours or continue using
  yours — our spec is published at api.datastream.io/openapi.json for your generators."

RESULT:
  Enterprise clients:
    Previously: weeks to build SDK per language + maintenance burden
    After: run one generator command → fully typed, always-current SDK
    Time to first successful API call: 30 minutes (was 2 weeks)

  DataStream platform team:
    Zero SDK maintenance beyond keeping spec accurate
    SDK issues filed against spec → spec fix → all SDKs regenerated automatically
```

---

**Developer Portal**

```
SOLUTION: Unified docs from merged spec

docs.datastream.io

Built from merged-openapi.yaml:
  - Single navigation covering all 6 team APIs
  - Cross-linked: Event schema references Segment schema
  - Changelog: every spec version tracked, diffs highlighted
  - SDK download links: Python / Go / Java / TypeScript
  - Authentication guide: one auth section (not 6)
  - Versioning guide: current vs deprecated operations clearly marked

Portal build: CI step after spec merge
  npx redoc-cli bundle build/merged-openapi.yaml \
    --title "DataStream API Reference" \
    -o portal/index.html

  aws s3 sync portal/ s3://datastream-docs/
  aws cloudfront create-invalidation --paths "/*"

Enterprise client portal access:
  Single URL covers entire DataStream API surface.
  Clients never need to know about internal team boundaries.
  "DataStream has one API" from the outside view.
```

---

_End of Topic 10: Swagger/OpenAPI Basics_

---

_This completes the Backend & API Design section. Topics 02–10 fully covered._
