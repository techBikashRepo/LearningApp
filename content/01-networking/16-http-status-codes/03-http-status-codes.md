# HTTP Status Codes — Part 3 of 3

### Topic: AWS Certification, Comparison Tables, Quick Revision, Architect Exercise

**Series:** Networking Fundamentals → System Design → AWS Solutions Architect
**Sections Covered:** 9, 10, 11, 12

---

## SECTION 9 — AWS SAA Certification Focus

### Core Exam Concepts

**ALB-generated vs backend-generated status codes:**
ALB generates its own 502, 503, 504 and they have different root causes than the same codes from your backend. The exam loves this distinction.

```
ALB 502 (ALB-generated):
  Target returned an invalid response OR closed connection unexpectedly
  Target was registered but sent back malformed HTTP headers
  Fix: check target application logs; look at target_status_code="-" in ALB access logs

ALB 503 (ALB-generated):
  No healthy targets available in the target group
  All targets in DRAINING state (deregistering)
  Fix: investigate health check endpoint; add capacity; check security groups allow health check

ALB 504 (ALB-generated):
  Target group idle timeout exceeded (default 60 seconds)
  Fix: optimize backend speed OR increase ALB idle timeout (max 4000s)
       Better: use 202 + async processing for operations > 25s

ALB 403 (ALB-generated):
  AWS WAF attached to ALB and blocked the request
  Not a backend 403 — your application never saw the request
  Fix: adjust WAF rule; whitelist your test IP; check request matches no WAF conditions
```

### AWS SAA Exam Trap 1 — ALB Is Not Just a Pass-Through

**Scenario:** Application was working fine, now users see 503 errors. Target group has 4 healthy EC2 instances. No deployment happened. What do you check?

**Wrong answer:** Application bug returning 503.

**Correct answer:** Check the ALB target group HEALTH CHECK configuration.

- 503 from ALB = no healthy targets. Even if EC2 instances are running, if they fail health checks they're removed.
- Common causes: changed health check path (now returns 404) or application taking too long to respond to health check (health check timeout too low).
- **Exam key:** ALB generates 503 itself; your application code is not involved.

### AWS SAA Exam Trap 2 — CloudFront Error Caching

**Scenario:** Origin server is temporarily down (503). You fix it and bring it back online. But users still see error pages for several minutes. Why?

**Answer:** CloudFront caches error responses (5xx codes) from the origin. Default Error Caching TTL is 10 seconds but can be configured up to 86400 (24 hours).

If you set `ErrorCachingMinTTL: 300` in the Error Pages section, CloudFront will serve the cached error page for 5 minutes after the origin recovers.

**Fix:** CloudFront Console → Distribution → Error Pages → set appropriate Error Caching TTL. For frequently-changing health, keep TTL at 5-10 seconds. Or trigger a CloudFront invalidation after bringing origin back up.

**Exam key:** CloudFront caches 5xx error responses — this is separate from regular content caching.

### AWS SAA Exam Trap 3 — API Gateway Status Codes vs Lambda Errors

**Scenario:** Lambda function throws a JavaScript exception. Client receives 502 Bad Gateway. Why not 500?

**Answer:** API Gateway uses a specific contract for Lambda integration:

1. Lambda throws an uncaught exception → Lambda returns error to API Gateway but in the Lambda execution error format, not HTTP format
2. API Gateway doesn't know how to map this to HTTP → returns 502 Bad Gateway

To return proper HTTP 500: catch all exceptions in Lambda, then return the proxy response format:

```javascript
return {
  statusCode: 500,
  body: JSON.stringify({
    error: "Internal Server Error",
    trace_id: context.awsRequestId,
  }),
};
```

Lambda execution errors (function timeout, out of memory, uncaught exception) → 502 from API Gateway
Lambda returns well-formed error response → whatever statusCode you set (e.g., 500)

**Exam key:** Lambda unhandled exceptions map to API Gateway 502, not 500.

### AWS SAA Exam Trap 4 — Health Check Response Codes

**Scenario:** ALB health check is set to expect HTTP 200. Your application's `/health` endpoint returns 204 No Content. Health checks are failing. EC2 instances are UNHEALTHY but the application works fine.

**Answer:** By default, ALB health checks accept 200 (only). 204 is NOT automatically included.

**Fix:** In Target Group settings → Health Check → Success codes → change from `200` to `200,204` or `200-299`.

This is a common production mistake when developers return 204 from their health check (no body needed) without updating the ALB configuration.

**Exam key:** ALB health check "Healthy threshold codes" must explicitly include the HTTP code your endpoint returns. The default is `200`, not `2xx`.

### AWS SAA Exam Trap 5 — WAF 403 vs Application 403

**Scenario:** Some users get 403 errors but can access the app from a VPN. What is the most likely cause?

**Answer:** AWS WAF geographic restriction (GeoMatch rule) or IP reputation rule blocking certain IP ranges. The application itself never receives these requests.

How to distinguish WAF 403 from app 403:

- WAF 403: No matching request in your application access logs (request blocked before reaching app)
- WAF 403: Present in ALB access logs with `target_status_code = "-"` (ALB/WAF blocked, never forwarded)
- App 403: Present in both ALB logs AND application logs

**Exam key:** WAF blocks return 403 before the request reaches the target group. If ALB logs show request but application logs don't, WAF or ALB-level auth is responsible.

---

## SECTION 10 — Comparison Tables

### Table 1: Redirect Status Codes (301, 302, 307, 308)

| Code | Name               | Method After Redirect       | Cached                                | Browser Caches     | SEO PageRank Passes | Use Case                                                 |
| ---- | ------------------ | --------------------------- | ------------------------------------- | ------------------ | ------------------- | -------------------------------------------------------- |
| 301  | Moved Permanently  | GET (method changes)        | Yes                                   | Yes (indefinitely) | Yes                 | Domain migration, canonical URLs, HTTP→HTTPS (permanent) |
| 302  | Found (Temporary)  | GET (method changes)        | No (can be cached with Cache-Control) | Sometimes          | No                  | Temporary availability issues, A/B testing               |
| 307  | Temporary Redirect | Preserved (POST stays POST) | No                                    | No                 | No                  | Temporary redirect where form resubmission matters       |
| 308  | Permanent Redirect | Preserved (POST stays POST) | Yes                                   | Yes                | Yes                 | Permanent redirect with method-preserving semantics      |

**Key insight:** 301 and 302 both convert POST to GET on redirect (RFC 7231 says "may"). 307 and 308 explicitly prohibit method change. Always prefer 307 over 302, and 308 over 301, for API redirects where method matters.

**Production warning:** 301 aggressive browser caching means if you redirect http://foo.com → https://foo.com with 301, and then need to undo it, browsers already cached it. HSTS makes this permanent at the browser level. Test redirects with 302 before committing to 301.

### Table 2: 4xx Client Error Codes Reference

| Code | Name               | Who's At Fault         | Response Requires                      | Retry?           | Common Cause                                |
| ---- | ------------------ | ---------------------- | -------------------------------------- | ---------------- | ------------------------------------------- |
| 400  | Bad Request        | Client (syntax)        | Error field details                    | No               | Malformed JSON, invalid param format        |
| 401  | Unauthorized       | Client (no auth)       | `WWW-Authenticate` header (REQUIRED)   | Yes (after auth) | Missing/expired token, wrong credentials    |
| 403  | Forbidden          | Client (access)        | Optional error message                 | No               | Insufficient permissions, WAF block         |
| 404  | Not Found          | Either, or intentional | Optional "similar items"               | No               | Wrong path, deleted resource, security hide |
| 405  | Method Not Allowed | Client (method)        | `Allow` header (REQUIRED)              | No               | POST to read-only endpoint                  |
| 409  | Conflict           | Client (state)         | Current state & conflict reason        | Maybe            | Duplicate create, optimistic lock failure   |
| 410  | Gone               | Client using old URL   | Optional forwarding info               | No               | Permanently deleted resource                |
| 422  | Unprocessable      | Client (semantics)     | ​Detailed field-level errors           | No               | Validation failure, business rule violation |
| 429  | Too Many Requests  | Client (rate)          | `Retry-After`, `X-RateLimit-*` headers | Yes (after wait) | Rate limit hit, quota exceeded              |

### Table 3: 5xx Server Error Codes Reference

| Code | Name                  | ALB Source                       | Backend Source         | Safe to Retry?               | Most Common AWS Cause                                     |
| ---- | --------------------- | -------------------------------- | ---------------------- | ---------------------------- | --------------------------------------------------------- |
| 500  | Internal Server Error | No                               | Yes (bug)              | Careful (may have processed) | Lambda unhandled exception → via proxy response           |
| 502  | Bad Gateway           | Yes (backend malformed response) | Yes (upstream error)   | Yes (usually transient)      | Lambda exception (API Gateway proxy), backend crash (ALB) |
| 503  | Service Unavailable   | Yes (no healthy targets)         | Yes (capacity)         | Yes (with Retry-After)       | ALB: all targets failed health checks                     |
| 504  | Gateway Timeout       | Yes (backend slow)               | Yes (upstream timeout) | Dangerous (check state)      | ALB: backend exceeds 60s; API Gateway: Lambda exceeds 29s |

### Table 4: Monitoring Strategy by Status Code Class

| Code Class       | Alert Priority | Dashboard Metric           | Likely Owner        | Action                                                      |
| ---------------- | -------------- | -------------------------- | ------------------- | ----------------------------------------------------------- |
| 2xx drop         | P1 Critical    | Decrease in 2xx count      | Engineering         | Investigate immediately — traffic may be shifting to errors |
| 3xx spike        | P3 Info        | Redirect count             | SEO/Platform        | Check for redirect loops; crawler traffic                   |
| 4xx baseline     | P3 Info        | 4xx per endpoint           | Client/API team     | Check for broken client, new rate limiting, auth expiry     |
| 4xx sudden spike | P2 Warning     | 4xx delta change           | Engineering         | Possible API breaking change or external client bug         |
| 5xx > 0.1%       | P2 Warning     | 5xx rate %                 | Backend Engineering | Investigate immediately                                     |
| 5xx > 1%         | P1 Critical    | 5xx count spike            | On-call             | Wake team, consider circuit breaker                         |
| 503 spike        | P1 Critical    | 503 source (ELB vs target) | DevOps              | Check target health; add capacity                           |
| 504 spike        | P1 Critical    | target_processing_time     | Backend/DB          | Find slow queries; add timeouts                             |

### Table 5: HTTP Status Code → AWS Service Action Mapping

| Status Code Observed | AWS Service | Likely Configuration Issue             | Fix                                            |
| -------------------- | ----------- | -------------------------------------- | ---------------------------------------------- |
| 403 (no app log)     | ALB         | WAF blocking requests                  | Adjust WAF rule or IP whitelist                |
| 503 (target "-")     | ALB         | All targets unhealthy                  | Fix health check path or success codes         |
| 502 (target "-")     | ALB         | Backend closed connection mid-response | Fix application; check OOM kills               |
| 504                  | ALB         | Target exceeds 60s idle timeout        | Optimize or increase idle timeout              |
| 504                  | API Gateway | Lambda exceeds 29s                     | Move to async: SQS + 202 response              |
| 502                  | API Gateway | Lambda returned non-proxy response     | Return {statusCode, headers, body} from Lambda |
| 403                  | CloudFront  | Missing OAI/OAC on S3 bucket           | Add CloudFront bucket policy                   |
| 404 → cached         | CloudFront  | High error caching TTL                 | Reduce ErrorCachingMinTTL                      |
| 503 (health check)   | ECS / ALB   | Container failed health check          | Fix /health endpoint; check container startup  |

---

## SECTION 11 — Quick Revision

### 10 Key Points

1. **4xx = YOUR mistake, 5xx = MY (server) mistake.** This determines who gets paged and who retries.

2. **201 requires a Location header** pointing to the newly-created resource. Omitting it is an RFC violation.

3. **401 requires a WWW-Authenticate header** describing the auth scheme. Without it, the client can't know how to authenticate.

4. **301 is forever — browsers cache it indefinitely.** Test with 302 first; promote to 301 only when sure.

5. **502 ≠ 503 from ALB.** 502 = backend alive but responded badly. 503 = no healthy targets at all. Different fixes.

6. **504 is dangerous to retry** because the backend may have already processed the request. Always check state first.

7. **304 Not Modified sends zero body bytes.** All metadata reused from first response. Content-Type/Length still in headers.

8. **429 demands a Retry-After header.** If you rate-limit without it, well-behaved clients can't know when to try again.

9. **410 Gone beats 404** for intentionally deleted content. SEO crawlers remove 410 pages; they keep 404 pages in hope they come back.

10. **API Gateway 502 ≠ backend 502.** API Gateway generates 502 when Lambda throws an uncaught exception — your Lambda never returned a valid HTTP proxy response.

### 30-Second "I Know This" Explanation

HTTP status codes are a three-digit language between server and client. The first digit tells you the category: 1xx is informational, 2xx means success, 3xx means "look elsewhere," 4xx means the client did something wrong, and 5xx means the server failed. In production systems, you treat 4xx and 5xx completely differently: 4xx errors are the client's problem to fix, so you alert at low priority; 5xx means your servers are failing, so you page someone immediately. Three critical distinctions to memorize: 401 vs 403 (don't know who you are vs know but deny), 302 vs 307 (method can change vs method must stay), and 502 vs 503 vs 504 from ALB (bad backend response vs no healthy targets vs backend too slow).

### Mnemonics

**"4xx = Your fault, 5xx = My fault"**

- Client error = 4, Server error = 5. The number of mistakes you make = the number on the error.
- 4 letters in "your" → 4xx client errors
- 5 letters in "their" (server's) → 5xx server errors

**"The Terrible Twins"**

- 401 vs 403: "401 = I don't know WHO you are. 403 = I know WHO you are but HELL NO."
- 502 vs 504: "502 = backend said something WRONG. 504 = backend said NOTHING (timed out)."

**"PLAG" for 2xx:**

- **P**ost → 201 (Created)
- **L**ist/Get → 200 (OK)
- **A**ccepted (async) → 202
- **G**one (no body DELETE) → 204

**ALB Error Codes: "No Healthy Targets Brings Slow Fives"**

- No Healthy Targets → **503**
- Broken response from backend → **502**
- Slow backend (timeout) → **504**

**"3xx Redirect Rules: 301 Caches But Methods Change, 307 Safe But Temporary"**

- 3**0**1 = permanent, **0** = zero cache expiry (cached "forever" in browser)
- 3**0**7 = temporary, method **0**bligatorily preserved

---

## SECTION 12 — Architect Thinking Exercise

### The Problem

**Production Incident — Post-Deploy 502 Surge**

You're the on-call engineer. At 2:47 PM, your PagerDuty alert fires:

```
ALB 5xx Error Rate: 8.3%  (threshold: 1%)
Alert: HTTP 502 Bad Gateway spike detected
Service: order-api PRODUCTION
Duration: ongoing for 3 minutes
```

CloudWatch dashboard:

```
HTTPCode_ELB_5XX_Count:    1,847 in last 5 min
HTTPCode_Target_5XX_Count: 0     in last 5 min
ALB_RequestCount:          22,104 in last 5 min
HealthyHostCount:          6 (all healthy)
```

Deployment log shows a new release went out at 2:44 PM (3 minutes before alert).

Your team is watching. What is happening and what do you do?

---

_Think through the problem before reading further._

---

_What do you know?_

- 6 healthy targets (health checks are passing)
- 5xx count is all ALB-generated (Target 5xx = 0)
- Spike correlates perfectly with the 2:44 PM deployment
- Requests are reaching ALB and being forwarded (HealthyHostCount = 6)

---

_What does ALB-generated 502 with healthy targets mean?_

---

_Pause here. What would you do first?_

---

### The Solution

**Root Cause: Node.js Response Double-End Bug**

The new deployment introduced a middleware bug. The response was being closed (`.end()`) twice:

```javascript
// Old code (working):
app.post("/orders", async (req, res) => {
  const order = await createOrder(req.body);
  return res.json({ orderId: order.id }); // one response
});

// New code (broken):
app.post("/orders", async (req, res) => {
  const order = await createOrder(req.body);
  res.json({ orderId: order.id }); // first response

  // Bug: audit middleware runs AFTER and also tries to end response
  await auditLog(req, res); // auditLog calls res.end() again!
});
```

When `res.end()` is called twice in Express, the second call corrupts or terminates the TCP connection unexpectedly. The backend had already sent the HTTP response headers but then closed the connection mid-flow. ALB received a malformed response and returned 502.

**Why health checks were passing:** Health checks hit `/health` endpoint, which didn't use the audit middleware — so they returned 200 normally.

**Why Target 5xx count = 0:** The backend DID start sending a response (not an error response) — it began sending 200 headers successfully. The issue was the connection being forcibly closed after headers were sent. ALB never received a complete valid response. Since the backend transmitted something (not an HTTP error code), it cannot be counted as a backend 5xx — ALB generates a 502 to the client.

### Step-by-Step Diagnosis and Fix

**Step 1: Confirm deployment correlation** ✓

- Alert at 2:47 PM, deploy at 2:44 PM → high confidence root cause is the deploy

**Step 2: Roll back immediately**

```bash
aws deploy create-deployment \
  --application-name order-api \
  --deployment-group-name prod \
  --deployment-config-name CodeDeployDefault.OneAtATime \
  --s3-location bucket=deployments,key=order-api-v2.3.1.zip,bundleType=zip
  # v2.3.1 = previous working version
```

→ 502s should stop within 2 minutes of rollback completing

**Step 3: Reproduce in staging (root cause analysis)**

```bash
# Simulate the request that triggers the double-end
curl -X POST https://staging.order-api.com/orders \
  -H "Content-Type: application/json" \
  -d '{"product_id": 1, "quantity": 1}'
# Monitor: watch -n1 'curl -s .../health'
```

Node.js log would show:

```
Express Warning: Cannot set headers after they are sent to the client
  at createOrder (order-service.js:142)
```

**Step 4: Fix the audit middleware**

```javascript
// After fix: middleware doesn't touch response
app.post("/orders", async (req, res) => {
  const order = await createOrder(req.body);

  // Record audit data non-destructively
  setImmediate(() => auditLog({ orderId: order.id, userId: req.user.id }));

  // Send ONE response
  res.json({ orderId: order.id });
});
```

**Step 5: ALB alarm post-mortem improvement**

```
Add CloudWatch alarm:
  Metric: HTTPCode_ELB_5XX_Count (not Target_5XX)
  Period: 1 minute, Threshold: > 50
  Action: Notify + trigger automatic rollback via EventBridge → Lambda → CodeDeploy rollback

  This would have auto-rolled back within 5 minutes instead of 8 minutes of manual response
```

### Architecture Lesson

The 502 pattern in this incident reveals a key architectural insight: **ALB-generated 502 with all healthy targets = response corruption at the application layer**, not server failure. This is distinct from:

- 502 with unhealthy targets = backend crashes on startup (race condition at deploy time)
- 503 = all health checks failing (backend completely broken)
- 504 = backend running fine but slow (DB bottleneck)

Each pattern points to a different class of root cause, enabling faster diagnosis. Learning these patterns reduces mean-time-to-resolve (MTTR) by bypassing wrong hypotheses.

**Final principle:** In distributed systems, status codes are diagnostic signals. A senior engineer reads `502-from-ELB-with-0-target-5xx` as a signature — like a doctor reading a specific lab result combination — and immediately knows where to look. This pattern recognition is built through practice, post-mortems, and deliberately understanding each status code's precise semantics.

---

## File Summary — Topic 16 Complete

**All three files together cover:**

**File 01 (Sections 1-4):** Post-office analogy + traffic signals; full status code reference (1xx through 5xx); decision tree; ALB code sources; the 504 uncertainty problem (backend may have already processed).

**File 02 (Sections 5-8):** Hospital triage + parcel locker analogies; GitHub API real-world usage; monitoring tiers (P1/P2/P3 by code class); error body design with RFC 7807; retry safety map; circuit breaker integration; webhook 200 strategy; ALB/CloudFront/API Gateway AWS code specifics; 8 Q&As.

**File 03 (Sections 9-12):** AWS SAA traps (ALB 502/503/504 distinction, CloudFront error caching, Lambda→API Gateway 502, health check codes, WAF 403); 5 comparison tables; PLAG/Terrible Twins mnemonics; Architect Exercise — post-deploy 502 surge root-caused to Node.js double-end bug, diagnosed via Target 5xx = 0 with all healthy targets.
