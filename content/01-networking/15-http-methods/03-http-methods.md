# HTTP Methods — Part 3 of 3

### Topic: Certification Focus, Tables, Revision, and Architect Exercise

**Series:** Networking Fundamentals → System Design → AWS Solutions Architect
**Audience:** 14-Year Experienced Full-Stack Developer → Becoming an Architect
**Sections Covered:** 9, 10, 11, 12

---

## SECTION 9 — AWS SAA Certification Focus

### Exam-Critical Facts

**API Gateway method authorization levels:**

- NONE: no auth (public)
- AWS_IAM: caller must sign request with IAM credentials (SigV4)
- COGNITO_USER_POOLS: Cognito JWT token in Authorization header
- Lambda Authorizer (TOKEN or REQUEST type): custom auth logic
- **Exam trap:** "Allow only authenticated users to call POST /orders but allow anyone to GET /products" → configure auth per method, not per API.

**API Gateway HTTP API vs REST API method support:**

- HTTP API: route-level auth (JWT Authorizer or Lambda Authorizer)
- REST API: per-method auth + usage plans + API keys per method
- **Exam trap:** "Need to throttle API by HTTP method" → REST API with usage plans per method; HTTP API throttles per route.

**CORS in AWS API Gateway:**

- HTTP API: Enable CORS in one configuration (fills all Access-Control-\* headers automatically)
- REST API: Must enable CORS per method → API Gateway generates OPTIONS mock integration
- **Exam trap:** "Frontend React app getting CORS error on POST to API Gateway" → Enable CORS on the resource; redeploy the API stage (REQUIRED after any change to REST API).
- **Exam trap:** "CORS works for GET but not POST" → CORS enabled on GET but not POST method separately (REST API).

**ALB listener rule — method condition:**

- ALB supports HTTP method routing from 2021: condition `HttpHeaderCondition` + method value
- Route POST to write tier, GET to read tier (separate target groups)
- **Exam trap:** "Split read/write traffic at load balancer level" → ALB method-based routing rules.

**S3 pre-signed URLs and method:**

- A pre-signed URL is bound to a specific HTTP method, expiry, and object key
- `PUT` pre-signed URL: upload directly to S3 from browser (Content-Type must match what was signed)
- `GET` pre-signed URL: download private S3 object
- Cannot change the method on a pre-signed URL
- **Exam trap:** "User uploads via pre-signed URL fails with 403" → Method mismatch (using POST instead of signed PUT, or URL expired).

### Potential Exam Trap Summary

| Trap                             | Wrong Assumption                  | Correct Answer                                         |
| -------------------------------- | --------------------------------- | ------------------------------------------------------ |
| REST API CORS change, no effect  | Change is live immediately        | Must redeploy the API stage                            |
| POST idempotency key in ALB      | ALB enforces idempotency          | Idempotency is application-layer; ALB is transport     |
| CORS error in curl/Postman       | CORS blocked the API call         | CORS is browser-only; curl bypasses CORS               |
| S3 pre-signed URL with PUT fails | URL is valid                      | Method must match what was specified at signing        |
| HTTP API per-method auth         | HTTP API supports per-method auth | HTTP API auth is per-route, not per-method split       |
| GET /users deletes data          | GET is safe, server must honor    | Server may misuse GET — architectural design issue     |
| OPTIONS request hits Lambda      | Every preflight invokes Lambda    | Configure mock OPTIONS integration; Lambda not invoked |

---

## SECTION 10 — Comparison Tables

### Table 1 — HTTP Method Properties Reference

| Method      | Safe | Idempotent | Cacheable   | Body (Request) | Body (Response) | Success Code         |
| ----------- | ---- | ---------- | ----------- | -------------- | --------------- | -------------------- |
| **GET**     | Yes  | Yes        | Yes         | No (avoid)     | Yes             | 200 OK               |
| **HEAD**    | Yes  | Yes        | Yes         | No             | No              | 200 OK               |
| **OPTIONS** | Yes  | Yes        | No          | Optional       | Yes             | 200/204              |
| **POST**    | No   | No         | Conditional | Yes            | Yes             | 201 Created / 200 OK |
| **PUT**     | No   | Yes        | No          | Yes            | Yes             | 200 OK / 201 Created |
| **PATCH**   | No   | No\*       | No          | Yes            | Yes             | 200 OK               |
| **DELETE**  | No   | Yes        | No          | Optional       | Optional        | 204 / 200            |
| **CONNECT** | No   | No         | No          | No             | Yes             | 200 OK               |

\*PATCH can be idempotent if designed to set absolute values (not relative changes)

### Table 2 — REST Resource URL + Method Matrix

| HTTP Method | `/orders` (Collection)              | `/orders/{id}` (Item)             |
| ----------- | ----------------------------------- | --------------------------------- |
| **GET**     | List all orders (paginated)         | Get specific order                |
| **POST**    | Create new order                    | (Usually not used — POST on item) |
| **PUT**     | (Bulk replace — uncommon)           | Replace order completely          |
| **PATCH**   | (Bulk update — uncommon)            | Partial update of order           |
| **DELETE**  | (Bulk delete — risky)               | Delete specific order             |
| **HEAD**    | Get count/metadata about collection | Check if order exists             |
| **OPTIONS** | CORS preflight / discover methods   | CORS preflight                    |

### Table 3 — PUT vs PATCH vs POST for Updates

| Property              | PUT                                         | PATCH                     | POST (for updates)          |
| --------------------- | ------------------------------------------- | ------------------------- | --------------------------- |
| **Scope**             | Full resource replacement                   | Partial update            | Action trigger              |
| **Idempotent**        | Yes                                         | No (by default)           | No                          |
| **Bandwidth**         | High (full payload)                         | Low (delta only)          | Depends                     |
| **Lost update risk**  | High (client overwrites concurrent changes) | Low (only touched fields) | Varies                      |
| **Server complexity** | Low (replace)                               | High (merge logic)        | Medium                      |
| **CDN caching**       | Not cached                                  | Not cached                | Not cached                  |
| **Use case**          | Replace entire document                     | Update specific fields    | Trigger state transitions   |
| **Example**           | Update entire user profile                  | Change password only      | Submit order for processing |

### Table 4 — CORS Headers Reference

| Header                             | Direction                 | Example                       | Purpose                                      |
| ---------------------------------- | ------------------------- | ----------------------------- | -------------------------------------------- |
| `Origin`                           | Request (browser→server)  | `https://app.com`             | Identifies requesting origin                 |
| `Access-Control-Request-Method`    | Preflight request         | `POST`                        | What method the actual request will use      |
| `Access-Control-Request-Headers`   | Preflight request         | `Authorization, Content-Type` | Custom headers in actual request             |
| `Access-Control-Allow-Origin`      | Response (server→browser) | `https://app.com` or `*`      | Allowed origins                              |
| `Access-Control-Allow-Methods`     | Response                  | `GET, POST, DELETE`           | Allowed methods                              |
| `Access-Control-Allow-Headers`     | Response                  | `Authorization, Content-Type` | Allowed custom headers                       |
| `Access-Control-Max-Age`           | Response                  | `86400`                       | Preflight cache duration (seconds)           |
| `Access-Control-Allow-Credentials` | Response                  | `true`                        | Whether cookies/auth headers allowed         |
| `Vary: Origin`                     | Response                  | —                             | CDN must cache separate responses per Origin |

### Table 5 — Method Usage in Popular APIs

| API / Pattern        | GET                | POST                    | PUT                   | PATCH                | DELETE                   |
| -------------------- | ------------------ | ----------------------- | --------------------- | -------------------- | ------------------------ |
| **REST (standard)**  | Read               | Create                  | Replace               | Partial update       | Delete                   |
| **Stripe**           | Read               | Create + Actions        | Not used              | Not used (uses POST) | Not used (cancel = POST) |
| **GitHub REST API**  | Read               | Create, fork, merge     | Replace               | Update               | Delete                   |
| **AWS S3 API**       | GetObject          | PutObject (!)           | (uses PUT for create) | (no PATCH)           | DeleteObject             |
| **GraphQL**          | Persistent queries | All mutations + queries | Not used              | Not used             | Not used                 |
| **gRPC-transcoding** | Unary reads        | Mutations               | Full replace          | Partial update       | Delete                   |

Note: S3 uses PUT for uploads (creating objects) because uploads are idempotent (uploading same key twice replaces the object). This is semantically correct for PUT.

---

## SECTION 11 — Quick Revision and Memory Tricks

### 10 Key Points — HTTP Methods

1. **GET = read-only, cacheable, bookmarkable.** No side effects. Safe for crawlers, CDNs, browsers.
2. **POST = create or trigger action.** NOT idempotent. Always use idempotency keys for financial POST.
3. **PUT = idempotent replace.** Entire resource replaced. Client sends full representation.
4. **PATCH = partial update.** Usually NOT idempotent. Efficient for large objects with small changes.
5. **DELETE = idempotent removal.** Second DELETE is a no-op (resource already gone).
6. **HEAD = metadata only.** Identical to GET response headers, no body. Check existence or size.
7. **OPTIONS = capability discovery.** Browser sends automatically for CORS preflight.
8. **CORS is browser-enforced only.** `curl` and server-to-server calls bypass CORS.
9. **API Gateway**: auth per method (REST API) or per route (HTTP API). Redeploy REST API after CORS change.
10. **S3 pre-signed URLs** are method-specific. PUT for upload, GET for download. Cannot switch method.

### 30-Second Explanation

> "HTTP methods define the intent of a request. GET reads without side effects — safe to cache and repeat. POST creates — not idempotent, needs idempotency keys for retries. PUT replaces a resource entirely — idempotent. PATCH updates partially — efficient but not idempotent by default. DELETE removes a resource — idempotent. HEAD gets headers without the body, useful for checking existence. OPTIONS is used for CORS preflight — browsers send it automatically before cross-origin POST/PUT requests to ask if they're allowed.
>
> The critical insight: safe methods (GET, HEAD, OPTIONS) can be retried freely. POST cannot — you need idempotency keys. CORS is browser-enforcement only — Postman ignores it."

### Mnemonics

**SIP-DELETE** — Safety/Idempotency pattern:

- **S**afe: GET, HEAD, OPTIONS (reading doesn't hurt)
- **I**dempotent but NOT safe: PUT, DELETE (changes data but same result repeated)
- **P**ost is neither safe NOR idempotent (creates new resource each time)
- **PATCH** is not idempotent unless it sets absolute values

**GHO = Read, Never Delete:**

- **G**ET, **H**EAD, **O**PTIONS = always safe
- "GHO read — never touch data"

**"POST pays twice, PUT replaces nice":**

- POST twice → two charges (idempotency key needed)
- PUT replaces nicely → same result no matter how many times

**CORS = "Browsers Only Random Stunt":**

- Only browsers enforce CORS
- curl, Postman, servers — none enforce it
- It's purely client-side origin policy

**"Amazon S3 PUTs, not POSTs":**

- S3 uses PUT for object creation (idempotent upload)
- S3 REST API breaks REST convention only here (PUT = create)
- Remember by: "Storage idempotency"

---

## SECTION 12 — Architect Thinking Exercise

### Scenario: Production Double-Charge Bug Investigation

**Background:**
Your company runs a SaaS subscription platform. You receive an urgent Slack message:

> `@oncall - CRITICAL - 47 customers have been charged TWICE this morning. Finance team confirmed duplicate subscription charges in Stripe. Payments are real, duplicates are real. Need RCA immediately.`

**System context:**

- Mobile app (iOS/Android) + Web frontend
- Backend: Spring Boot microservice → POST /subscriptions → Stripe API
- Infrastructure: API Gateway (REST) → Lambda → RDS → Stripe
- Recently deployed: mobile app v3.2.1 (4 days ago) with "improved retry logic"
- Normal charge volume: ~500/day; today: ~547 charges but 47 are duplicates

**Evidence from logs:**

```
2026-02-23 09:15:23 POST /subscriptions user_id=1001 amount=99 Idempotency-Key: null → 201
2026-02-23 09:15:24 POST /subscriptions user_id=1001 amount=99 Idempotency-Key: null → 201
                        ↑ DUPLICATE CHARGE
2026-02-23 09:18:42 POST /subscriptions user_id=1002 amount=99 Idempotency-Key: null → 201
2026-02-23 09:18:44 POST /subscriptions user_id=1002 amount=99 Idempotency-Key: null → 201
                        ↑ DUPLICATE CHARGE
```

**Stop here. Think:**

1. What caused this?
2. Why did v3.2.1 suddenly trigger it?
3. What is the immediate fix?
4. What is the permanent architectural fix?

---

_(Solution follows)_

---

### Solution

**Root Cause:**

`Idempotency-Key: null` is the smoking gun. The mobile app v3.2.1 added "improved retry logic" — it now retries POST /subscriptions on any network error or timeout. But it was NOT sending idempotency keys with the retries.

The specific failure mode:

```
Mobile client → POST /subscriptions {amount: 99}
  Network hiccup: response delayed (3G congestion)
  Client timeout: 3 seconds
  Mobile v3.2.1 "improved retry": sends POST again immediately
  Server: Both requests arrive! Creates two subscriptions.
  First response arrives at client (after retry already sent)
  Client: "Got 201, we're good" (unaware of duplicate)
```

Why now? Previous app version (v3.1.x) had no retry logic — network errors just showed an error to the user. v3.2.1 "helpfully" added retries, converting a UX problem (user sees error) into a data problem (user charged twice silently).

**Immediate Fix (deploy in next 30 minutes):**

```
1. Feature flag: disable retry logic in v3.2.1 immediately
   Mobile apps: force update gate OR feature flag via Firebase Remote Config

2. Process refunds for 47 duplicate charges:
   Script to identify: SELECT * FROM subscriptions
     WHERE user_id IN (...) AND created_at BETWEEN '09:00' AND '10:00'
     GROUP BY user_id HAVING COUNT(*) > 1
   Stripe refund via API for each duplicate charge_id

3. Check if any more duplicates accumulating:
   CloudWatch alarm: subscription_count > 550/day → alert
```

**Permanent Fix — Three Layers:**

**Layer 1: Client generates idempotency key (fix in mobile app v3.2.2):**

```swift
// iOS: generate UUID on first attempt, persist across retries
let idempotencyKey = UserDefaults.standard.string(forKey: "sub_idem_\(userId)")
    ?? UUID().uuidString
UserDefaults.standard.set(idempotencyKey, forKey: "sub_idem_\(userId)")

// Include in EVERY POST request:
request.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key")
// After confirmed success: clear from UserDefaults
```

**Layer 2: Server enforces idempotency key (reject if missing):**

```java
// Spring Boot interceptor
@Component
public class IdempotencyEnforcer implements HandlerInterceptor {
    @Override
    public boolean preHandle(HttpServletRequest request,
                             HttpServletResponse response, Object handler) {
        if ("POST".equals(request.getMethod()) &&
            request.getRequestURI().contains("/subscriptions")) {
            String key = request.getHeader("Idempotency-Key");
            if (key == null || key.isBlank()) {
                response.setStatus(422);  // Unprocessable Entity
                // Return: {"error": "Idempotency-Key header required for subscription creation"}
                return false;
            }
        }
        return true;
    }
}
```

**Layer 3: Idempotency store in DynamoDB:**

```java
public SubscriptionResponse createSubscription(CreateSubscriptionRequest req,
                                                String idempotencyKey) {
    // Check existing
    Optional<IdempotencyRecord> existing = idempotencyRepo.findById(idempotencyKey);
    if (existing.isPresent()) {
        log.info("Returning cached response for idempotency key {}", idempotencyKey);
        return existing.get().getCachedResponse();  // Return same 201 + same subscription_id
    }

    // Process with Stripe (also pass idempotency key to Stripe!)
    Subscription subscription = stripeClient.subscriptions().create(
        SubscriptionCreateParams.builder()
            .setCustomer(req.getCustomerId())
            .addItem(SubscriptionCreateParams.Item.builder().setPrice(req.getPriceId()).build())
            .build(),
        RequestOptions.builder().setIdempotencyKey(idempotencyKey).build()  // Pass to Stripe!
    );

    // Store result
    idempotencyRepo.save(new IdempotencyRecord(idempotencyKey, subscription, Instant.now().plusSeconds(86400)));
    return new SubscriptionResponse(subscription);
}
```

**AWS Architecture for Idempotency:**

```
API Gateway → Lambda
                │
                ├── DynamoDB: KeyId={idempotency_key}
                │   (TTL: 24h, check before creating)
                │
                └── Stripe API (with same idempotency key passed through)
                    (Stripe also deduplicates on their end as backup)
```

**Post-Incident Process Changes:**

1. Any PR adding retry logic to a client MUST include idempotency key implementation
2. Load test with network chaos injection (Chaos Monkey) before shipping retry logic
3. Add CloudWatch metric: `subscription_duplicates_detected` (alert threshold: 1)
4. API contract: all non-idempotent POST endpoints in API spec must document idempotency key requirement

---

**Next Topic →** Topic 16: HTTP Status Codes — the complete language of server responses: 1xx informational, 2xx success, 3xx redirection, 4xx client errors, 5xx server errors, and how ALB, CloudFront, and API Gateway use specific codes in AWS architectures.
