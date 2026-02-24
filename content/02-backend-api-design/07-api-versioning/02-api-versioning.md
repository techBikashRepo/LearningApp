# API Versioning — Part 2 of 3

### Sections: 5 (Architecture Diagram), 6 (Production Scenarios), 7 (Scaling & Reliability), 8 (AWS Mapping)

**Series:** Backend & API Design → REST APIs → System Design

---

## SECTION 5 — Architecture & System Diagram

### BillingCore Versioned API Architecture

```
                        BILLINGCORE VERSIONED API ARCHITECTURE
                        ======================================

Client SDK (v1)              Client App (v2)
      │                            │
      │ GET /v1/payments           │ GET /v2/payments
      │                            │
      ▼                            ▼
┌──────────────────────────────────────────────────────────────┐
│                         Route 53 DNS                         │
│              api.billingcore.com → CloudFront               │
└──────────────────────────────┬───────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────┐
│                         CloudFront                           │
│  Cache behaviors:                                            │
│  /v1/* → origin: api-gateway-v1 (TTL: based on resource)    │
│  /v2/* → origin: api-gateway-v2 (TTL: based on resource)    │
│                                                              │
│  Cache key includes: /v1 or /v2 prefix                      │
│  → v1 and v2 responses never share cache entries            │
│  → Clean isolation at CDN layer                             │
└───────────────────┬──────────────────────┬───────────────────┘
                    │                      │
                    ▼                      ▼
┌────────────────────────┐  ┌─────────────────────────────────┐
│   API Gateway v1       │  │   API Gateway v2                │
│   (api-v1.internal)    │  │   (api-v2.internal)             │
│                        │  │                                  │
│   • v1 contract        │  │   • v2 contract                 │
│     enforced           │  │     enforced                    │
│   • Deprecation        │  │   • Active development          │
│     headers added      │  │   • Rate limits: 1000 req/min   │
│   • Sunset check:      │  │   • Request validation          │
│     if past sunset →   │  │     against v2 OpenAPI spec     │
│     return 410 Gone    │  │                                  │
└──────────┬─────────────┘  └────────────────┬────────────────┘
           │                                  │
           ▼                                  ▼
┌────────────────────────┐  ┌─────────────────────────────────┐
│   Lambda:              │  │   Lambda:                       │
│   billing-api-v1       │  │   billing-api-v2                │
│                        │  │                                  │
│   V1 RESPONSE          │  │   V2 RESPONSE                   │
│   ADAPTER:             │  │   (native):                     │
│                        │  │                                  │
│   1. Call v2 service   │  │   1. Validate request           │
│      internally        │  │   2. Execute business logic     │
│   2. Transform v2      │  │   3. Return v2 response shape   │
│      response → v1     │  │                                  │
│      response shape    │  │   (source of truth)             │
│   3. Add deprecation   │  │                                  │
│      headers           │  │                                  │
└──────────┬─────────────┘  └────────────────┬────────────────┘
           └──────────────┬───────────────────┘
                          │
                          ▼
┌──────────────────────────────────────────────────────────────┐
│                   Payments Service                           │
│                   (single source of truth)                   │
│                                                              │
│   ALL business logic lives here — version-agnostic          │
│   v1 Lambda: adapts the response                            │
│   v2 Lambda: uses response directly                         │
│                                                              │
│   Internal service → no public versioning concern           │
└──────────────────────────────────────────────────────────────┘
                          │
                          ▼
                    ┌────────────┐
                    │ Aurora DB  │
                    │ (Payment   │
                    │ records)   │
                    └────────────┘

V1 ADAPTER PATTERN — key architectural decision:

  Instead of maintaining two separate codebases (v1 and v2):

  WRONG — dual codebase:
    payments-v1/                ← must sync bug fixes to both
    payments-v2/                ← duplicate business logic danger

  RIGHT — adapter pattern (above architecture):
    Core business logic: one service (v2-native)
    v1 Lambda: transforms v2 response → v1 shape

    Bug fix: applied once in the payments service
    Automatically fixed in both v1 and v2 responses

    v1 adapter is simple, thin, and has no business logic.
    When v1 is sunset: delete the v1 adapter Lambda. Done.

V1 ADAPTER CODE:
  const toV1PaymentShape = (v2Response) => ({
    id: v2Response.id,
    amount: v2Response.amount_cents,           // reversed rename
    currency: v2Response.currency,
    status: v2Response.status,
    customer_id: v2Response.customer.id,        // flatten
    customer_email: v2Response.customer.email,  // flatten
    customer_name: v2Response.customer.name,    // flatten
    card_last4: v2Response.payment_method.card.last4,    // flatten
    card_brand: v2Response.payment_method.card.brand,    // flatten
    card_exp_month: v2Response.payment_method.card.exp_month,
    card_exp_year: v2Response.payment_method.card.exp_year,
    created_at: v2Response.created_at
    // legacy_processor_id: omitted — client code should have removed by now
  });
```

---

## SECTION 6 — Production Scenarios

### Scenario A: Stripe's Version Strategy — Industry Gold Standard

Stripe is the most admired versioning design in the payments API space:

```
STRIPE'S DUAL VERSIONING SYSTEM:

1. URL version (major): /v1/charges, /v1/customers
   → v1 has never changed its URL (since 2011)
   → Stripe used additive-only for 12+ years on /v1

2. API-Version date header (behavior version):
   API-Version: 2023-10-16

   Each merchant has a "pinned version" — the date when they first authenticated.
   Their account freezes the API behavior as of that date.

   New merchants: get current API-Version (latest date)
   Old merchants: get behavior from their account's creation date

   Example:
   Merchant A signed up 2018-01-15 → account pinned to 2018-01-15 behavior
   Merchant B signed up 2023-01-15 → account pinned to 2023-01-15 behavior

   Change on 2023-01-15: "charge.status" expanded enums
   Merchant A: doesn't see new enum values (behavior frozen)
   Merchant B: sees new enum values

   Merchant A can UPGRADE: set API-Version: 2023-01-15 on next request
   → their account version advances
   → they can't go back

STRIPE MAINTAINS ~60 API BEHAVIOR VERSIONS simultaneously.
This requires a massive versioning infrastructure — not recommended for startups.
But the principle is right: isolate breaking changes, let clients migrate at own pace.
```

---

### Scenario B: GitHub's Versioning Evolution

GitHub went years without versioning, then added it:

```
BEFORE (circa 2020):
  https://api.github.com/repos/owner/repo
  No version in URL — just evolving the API.

  Problem: gradual breaking changes confused clients.
  Clients had to read release notes to understand what changed.

AFTER (2022+):
  https://api.github.com/repos/owner/repo
  Accept: application/vnd.github+json
  X-GitHub-Api-Version: 2022-11-28

  GitHub uses the API-Version header approach (like Stripe).
  If no version provided: defaults to latest (can break)
  If version provided: frozen behavior for that date

  Lesson: Absence of versioning means constant surprise for clients.
          Adding versioning later is disruptive but necessary.
          Better to add versioning at API launch than retrofit it years later.
```

---

### Scenario C: Twillio's Clean URL Versioning

```
Twilio: absolute clarity through URL versioning

https://api.twilio.com/2010-04-01/Accounts.json
https://api.twilio.com/2010-04-01/Accounts/{SID}/Messages.json

Year/month/day in URL path — immutable.
Every version is a complete snapshot of the API at that date.

Advantage: clients know exactly what behavior to expect.
No ambiguity. /2010-04-01/ still works in 2025.
Twilio maintains backward compatibility by policy across their versions.

When they release a new version (rare):
  /2010-04-01/ = legacy (maintained for backward compat)
  /2019-02-01/ = newer version with additional capabilities

Most Twilio clients run on /2010-04-01/ indefinitely.
```

---

## SECTION 7 — Scaling & Reliability

### Version Traffic Management

```
SUNSET PLANNING — the business problem:

Sunset date: when v1 stops working.
Too early → clients not migrated → support tickets, churn, SLA violations
Too late → maintaining v1 forever → engineering cost, security debt

Framework:
  1. Launch v2
  2. Monitor v1 usage in 30-day increments:
     Month 1: 100% traffic on v1, 0% on v2
     Month 3: 70% v1, 30% v2 (early adopters migrated)
     Month 6: 40% v1, 60% v2
     Month 9: 15% v1, 85% v2 (long tail problem begins)
  3. At <10% v1 traffic: send sunset announcement
  4. 3 months later: announce hard sunset date (3-6 months out)
  5. 30 days before sunset: send reminder emails to all v1 active clients
  6. Sunset day: v1 → 410 Gone

Monitoring: CloudWatch Metric Filters on API Gateway access logs
  Namespace: 'BillingCore/VersionUsage'
  MetricName: 'v1RequestCount' vs 'v2RequestCount'
  Dashboard: version traffic split over time
  Alarm: v1 traffic increases after v2 launch → v2 has a bug → rollback
```

### Feature Flags for Incremental Rollout Within a Version

```
Between major API versions, use feature flags for gradual rollout:

Server configuration (LaunchDarkly / AWS AppConfig):
  new_payment_model: {
    enabled_orgs: ["org_acme", "org_beta_corp"],  ← opt-in beta
    rollout_percentage: 0,                          ← 0% general rollout
    enabled_globally: false
  }

API handler:
  const useNewPaymentModel = await featureFlags.isEnabled(
    'new_payment_model',
    { org_id: req.auth.org_id }
  );

  const response = useNewPaymentModel
    ? newPaymentModelResponse(payment)
    : legacyPaymentModelResponse(payment);

This is NOT a version — it's a controlled rollout within the same version.
Use it for: testing new response shapes with willing partners before v2 launch.
NOT for: permanent feature branching (that's what versions are for).
```

### Version Compatibility Testing

```
CONSUMER-DRIVEN CONTRACT TESTS:
  Each API client (consumer) declares the contract they depend on:
    {
      "consumer": "client-sdk-v1",
      "provider": "payments-api",
      "interactions": [
        {
          "description": "get payment by ID",
          "request": { "method": "GET", "path": "/v1/payments/pay_abc" },
          "response": {
            "status": 200,
            "body": {
              "id": "pay_abc",
              "amount": "${like:5000}",      ← must exist and be integer-like
              "customer_email": "${like:any}"  ← must exist
            }
          }
        }
      ]
    }

  Provider CI/CD runs consumer contract tests:
  → Before any deployment, simulate all consumer requests
  → Verify all consumer contracts are still satisfied
  → If a consumer contract breaks → deployment blocked
  → Forces developer to either: fix the contract or bump version

  Tools: Pact (language-agnostic), Spring Cloud Contract (Java)

  This is how Stripe-style reliability is achieved at scale.
  You don't accidentally break clients because tests catch it before deployment.
```

---

## SECTION 8 — AWS Implementation

### API Gateway Multi-Version Routing

```yaml
# CloudFormation: separate API Gateways per version
Resources:
  # V1 API Gateway
  ApiV1:
    Type: AWS::Serverless::Api
    Properties:
      Name: billing-api-v1
      StageName: prod
      DefinitionBody:
        # OpenAPI spec for v1 contract
      # CORS, auth, rate limit configs for v1

  # V2 API Gateway
  ApiV2:
    Type: AWS::Serverless::Api
    Properties:
      Name: billing-api-v2
      StageName: prod
      DefinitionBody:
        # OpenAPI spec for v2 contract

  # CloudFront Distribution routes based on path prefix
  CloudFrontDistribution:
    Type: AWS::CloudFront::Distribution
    Properties:
      DistributionConfig:
        Origins:
          - Id: api-v1
            DomainName: !Sub "${ApiV1}.execute-api.${AWS::Region}.amazonaws.com"
          - Id: api-v2
            DomainName: !Sub "${ApiV2}.execute-api.${AWS::Region}.amazonaws.com"
        CacheBehaviors:
          - PathPattern: "/v1/*"
            TargetOriginId: api-v1
            ForwardedValues:
              QueryString: true
              Headers: ["Authorization", "Content-Type"]
          - PathPattern: "/v2/*"
            TargetOriginId: api-v2
            ForwardedValues:
              QueryString: true
              Headers: ["Authorization", "Content-Type"]
```

### Sunset Middleware

```javascript
// Middleware that adds deprecation headers or blocks sunset versions
const VERSIONS = {
  v1: {
    status: "deprecated",
    sunset_date: new Date("2025-12-31T23:59:59Z"),
    migration_url: "https://developer.billingcore.com/migration/v2",
  },
  v2: {
    status: "active",
    sunset_date: null,
  },
};

export const versionMiddleware = (req, res, next) => {
  const version = req.path.match(/^\/v(\d+)\//)?.[1];
  if (!version) {
    return res.status(400).json({
      error: "VERSION_REQUIRED",
      message: "API version required in URL path. Use /v2/...",
    });
  }

  const versionKey = `v${version}`;
  const config = VERSIONS[versionKey];

  if (!config) {
    return res.status(404).json({
      error: "VERSION_NOT_FOUND",
      message: `API version ${versionKey} does not exist`,
      available_versions: Object.keys(VERSIONS).filter(
        (v) => VERSIONS[v].status !== "sunset",
      ),
    });
  }

  // Sunset check: block entirely if past sunset date
  if (config.sunset_date && new Date() > config.sunset_date) {
    return res.status(410).json({
      error: "VERSION_SUNSET",
      message: `API ${versionKey} was sunset on ${config.sunset_date.toISOString().split("T")[0]}`,
      migration_guide: config.migration_url,
    });
  }

  // Deprecation headers for active-but-deprecated versions
  if (config.status === "deprecated" && config.sunset_date) {
    res.setHeader("Deprecation", "true");
    res.setHeader("Sunset", config.sunset_date.toUTCString());
    res.setHeader("Link", `<${config.migration_url}>; rel="deprecation"`);
  }

  next();
};
```

### CloudWatch Version Usage Dashboard

```javascript
// Automated version traffic monitoring
const logVersionUsage = (version, endpoint, responseTime) => {
  cloudwatch.putMetricData({
    Namespace: "BillingCore/API",
    MetricData: [
      {
        MetricName: "RequestCount",
        Value: 1,
        Unit: "Count",
        Dimensions: [
          { Name: "Version", Value: version },
          { Name: "Endpoint", Value: endpoint },
        ],
      },
      {
        MetricName: "ResponseTime",
        Value: responseTime,
        Unit: "Milliseconds",
        Dimensions: [{ Name: "Version", Value: version }],
      },
    ],
  });
};

// CloudWatch Insights query for version traffic split (run monthly):
// fields @timestamp, version, @message
// | stats count() as requests by version
// | sort requests desc

// Alarm: v1 traffic > 90% of total after 6 months since v2 launch
// → v2 has adoption problem → investigate developer experience
```
