# HTTP Headers — Part 3 of 3

### Topic: AWS Certification, Comparison Tables, Quick Revision, Architect Exercise

**Series:** Networking Fundamentals → System Design → AWS Solutions Architect
**Sections Covered:** 9, 10, 11, 12

---

## SECTION 9 — AWS SAA Certification Focus

### Core Exam Concepts

**CloudFront caching behavior and headers:**
The exam tests whether you understand which headers affect CloudFront's caching. CloudFront uses a CACHE KEY to determine if it has a cached response. By default, the cache key is just the URL path + query string. Headers are NOT part of the default cache key.

```
If your response varies based on headers, you MUST:
1. Forward those headers to origin (CloudFront behavior: Cache Based on Whitelist)
2. Add them to the cache key (Origin Request Policy + Cache Policy)

Example: Accept-Language-based content
  User A: GET /page, Accept-Language: en-US
  User B: GET /page, Accept-Language: fr-FR

  Without caching by Accept-Language:
    CloudFront returns cached English page to French user

  With Accept-Language in cache key:
    Two cache entries: /page?lang=en and /page?lang=fr (separate keys)
    Each user gets correct localized response
```

### AWS SAA Exam Trap 1 — Cookie Forwarding Disables CDN Caching

**Scenario:** You enable CloudFront for your e-commerce site to improve performance. Product pages still show high latency. What's happening?

**Answer:** CloudFront is NOT caching product pages. Your application reads the session cookie on every request. Since a Cookie header is attached to every request, CloudFront treats each request as unique (cookies are forwarded to origin + included in cache key). CloudFront effectively becomes a TCP proxy, not a cache.

**Fix:** Split caching behavior by path:

- `/products/*` behaviour: DO NOT forward cookies to origin + DO NOT include cookies in cache key → CloudFront caches product pages (public content, no user data)
- `/cart, /account/*` behaviour: Forward all cookies → CloudFront passes through to origin (user-specific data)

**Exam key:** Forwarding cookies to origin disables CloudFront caching for that path. ALWAYS configure separate cache behaviors per path pattern.

### AWS SAA Exam Trap 2 — HSTS and the Subdomain Trap

**Scenario:** You enable HSTS with `includeSubDomains` directive on your main domain. Three months later your team can't access `http://staging.yourcompany.com` from any browser. Why?

**Answer:** HSTS with `includeSubDomains` means ANY subdomain must use HTTPS once any browser encounters the HSTS header. If `staging.yourcompany.com` doesn't have a valid TLS certificate but a developer visited `yourcompany.com` (with `includeSubDomains` HSTS), their browser permanently upgrades ALL subdomains to HTTPS — including staging.

This is permanent in the browser (up to `max-age` seconds). The only fix is to either:

1. Add TLS to staging (correct answer)
2. Have the developer manually clear HSTS cache in browser settings

**Exam key:** `includeSubDomains` in HSTS applies to ALL subdomains. Only use it when you can guarantee every subdomain has HTTPS.

### AWS SAA Exam Trap 3 — Vary: \* Bypasses CloudFront Cache

**Scenario:** Your API returns personalized content based on user locale. You add `Vary: Accept-Language` to responses. Then you add `Vary: Cookie` for authenticated responses. Users report seeing each other's data occasionally. What is happening?

**Answer:** `Vary: Cookie` causes CloudFront to store different cache entries per unique Cookie value. With session cookies, almost every user has a unique cookie — so cache keys are nearly unique. Cache hit rate drops to near 0%.

But here's the problem: `Vary: Cookie` doesn't encrypt or protect the cache key matching. If two users happen to share the exact same session cookie value (edge case: session IDs with low entropy), they could get each other's cached responses.

**Fix:** For authenticated/personalized content, use `Cache-Control: private, no-store` — CloudFront will not cache these responses at all, forwarding directly to origin. Use the Lambda@Edge or CloudFront Functions to add cache-busting logic for partial personalization.

**Exam key:** `Cache-Control: private` is the correct header to prevent CDN from caching user-specific responses. `Vary: Cookie` is fragile and insecure.

### AWS SAA Exam Trap 4 — CloudFront Response Headers Policy vs Origin Headers

CloudFront has TWO places where you configure headers:

1. **Origin Request Policy:** Headers sent FROM CloudFront TO origin (request headers)
2. **Response Headers Policy:** Headers sent FROM CloudFront TO viewer (response headers added/modified at edge)

**Common exam scenario:** You want to add HSTS headers to all responses. Can you do this in CloudFront without changing your origin code?

**Answer:** YES. Use a CloudFront **Response Headers Policy**:

- Go to `Response headers policies`
- Add `Strict-Transport-Security` with `max-age=31536000; includeSubDomains`
- Attach the policy to your CloudFront distribution's cache behavior
- CloudFront adds these headers to ALL responses regardless of what your origin returns

This is how teams add security headers without touching application code. The `SecurityHeadersPolicy` managed policy adds HSTS, CSP, X-Content-Type-Options, X-Frame-Options, Referrer-Policy all at once.

**Exam key:** CloudFront Response Headers Policy adds or modifies headers at the EDGE, after receiving origin response, before sending to viewer. No origin code change required.

### AWS SAA Exam Trap 5 — ALB vs NLB Header Differences

**Scenario:** You migrate from ALB to NLB for lower latency. Suddenly your application can't determine the real client IP address. X-Forwarded-For header is missing. Why?

**Answer:** NLB operates at Layer 4 (TCP), not Layer 7 (HTTP). It does NOT add HTTP headers — it cannot, because it doesn't parse HTTP. There is no `X-Forwarded-For` added by NLB.

For getting original client IP with NLB:

- **Proxy Protocol v2:** NLB can prepend a Proxy Protocol header (binary, Layer 4) to each TCP connection. The application must be configured to parse this.
- **Preserve client IP:** NLB can preserve the original source IP without Proxy Protocol (direct pass-through). Available for TCP traffic, application sees real source IP in socket.

ALB (Layer 7): Adds `X-Forwarded-For`, `X-Forwarded-Proto`, `X-Forwarded-Port`. Application reads HTTP headers.
NLB (Layer 4): Does not add HTTP headers. Use Proxy Protocol v2 or IP preservation.

**Exam key:** Only ALB adds X-Forwarded-For. NLB is Layer 4 and has no concept of HTTP headers.

---

## SECTION 10 — Comparison Tables

### Table 1: Request Headers vs Response Headers Reference

| Header             | Direction             | Purpose                                | Required?          | Example                    |
| ------------------ | --------------------- | -------------------------------------- | ------------------ | -------------------------- |
| `Host`             | Request               | Virtual hosting; route to correct site | MANDATORY HTTP/1.1 | `api.shop.com`             |
| `Authorization`    | Request               | Send identity/credentials              | When auth needed   | `Bearer eyJ...`            |
| `Content-Type`     | Both                  | Declare body format                    | When body present  | `application/json`         |
| `Accept`           | Request               | Preferred response format              | Optional           | `application/json`         |
| `Accept-Encoding`  | Request               | Compression algorithms supported       | Optional           | `gzip, br`                 |
| `If-None-Match`    | Request               | Conditional fetch by ETag              | Caching            | `"abc123"`                 |
| `Origin`           | Request               | CORS: origin of request                | Browser CORS       | `https://shop.com`         |
| `Cache-Control`    | Both                  | Cache instructions                     | Recommended        | `max-age=3600, public`     |
| `ETag`             | Response              | Resource version fingerprint           | Caching            | `"sha256-abc"`             |
| `Location`         | Response              | URL of new/redirected resource         | 2xx/3xx            | `/orders/789`              |
| `Set-Cookie`       | Response              | Create cookie on client                | Sessions/auth      | `id=abc; HttpOnly; Secure` |
| `WWW-Authenticate` | Response              | How to authenticate                    | With 401           | `Bearer realm=api`         |
| `Vary`             | Response              | Cache key variation factors            | Correct caching    | `Accept-Encoding`          |
| `X-Forwarded-For`  | Request (proxy-added) | Original client IP chain               | Proxies add        | `1.2.3.4, 10.0.0.1`        |

### Table 2: Cache-Control Directive Decision Guide

| Scenario                               | Correct Cache-Control                                              | Reasoning                                                               |
| -------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Static JS/CSS bundle (hashed filename) | `max-age=31536000, immutable`                                      | URL changes when content changes; cache forever                         |
| Static images (no hash in filename)    | `max-age=86400, public`                                            | Cache 1 day; CDN can cache for all users                                |
| Public API (updated hourly)            | `max-age=3600, s-maxage=86400, public, stale-while-revalidate=300` | Browser 1h, CDN 24h, serve stale 5m while refreshing                    |
| User profile page                      | `private, max-age=300`                                             | Browser cache 5m; CDN MUST NOT cache                                    |
| Cart / authenticated content           | `private, no-cache`                                                | Browser can store but must revalidate; CDN bypasses                     |
| Bank balance / credit card data        | `no-store`                                                         | Never store anywhere                                                    |
| Search results (popular queries)       | `max-age=60, public, stale-while-revalidate=600`                   | Short TTL, serve stale during refresh                                   |
| API response after POST/DELETE         | `no-store`                                                         | Result of mutation; don't cache or client may reuse stale post response |

### Table 3: Cookie Security Flags Reference

| Flag               | What It Does                                                                                  | What It Prevents                                           | When to Use                                                   |
| ------------------ | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------- |
| `HttpOnly`         | JavaScript cannot read the cookie                                                             | XSS cookie theft: `document.cookie` returns empty          | ALL session/auth cookies                                      |
| `Secure`           | Cookie only sent over HTTPS                                                                   | Transmission over unencrypted HTTP                         | ALL production cookies                                        |
| `SameSite=Strict`  | Cookie never sent on cross-site requests (including links from other sites)                   | CSRF attacks; cross-site request forgery                   | Auth cookies when cross-site isn't needed                     |
| `SameSite=Lax`     | Cookie sent on top-level navigation but not on cross-site subrequests (images, iframes, AJAX) | Most CSRF attacks; allows link navigation from other sites | Default secure choice; login state preserving                 |
| `SameSite=None`    | Cookie sent on all cross-site requests                                                        | Nothing (weakens security)                                 | Third-party cookies, payment iframes — requires `Secure` flag |
| `Max-Age=N`        | Cookie expires N seconds from now                                                             | Indefinite session persistence                             | All persistent session cookies                                |
| `Domain=.shop.com` | Cookie sent to all subdomains                                                                 | N/A (expands scope)                                        | Cross-subdomain SSO (use carefully)                           |
| `Path=/api`        | Cookie only sent for requests under /api path                                                 | Scope leakage to unrelated paths                           | Scoping cookies to specific API path                          |

### Table 4: Security Headers Reference

| Header                             | Protects Against                      | Key Value                                            | Pitfall                                                                 |
| ---------------------------------- | ------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------- |
| `Strict-Transport-Security (HSTS)` | HTTP downgrade, MITM                  | `max-age=31536000; includeSubDomains`                | `includeSubDomains` locks ALL subdomains to HTTPS                       |
| `Content-Security-Policy`          | XSS, script injection                 | `default-src 'self'; script-src 'self' cdn.shop.com` | Too-strict CSP breaks legitimate scripts; start with `report-only` mode |
| `X-Frame-Options`                  | Clickjacking                          | `DENY`                                               | Deprecated by CSP `frame-ancestors`; keep for old browser support       |
| `X-Content-Type-Options`           | MIME sniffing attacks                 | `nosniff`                                            | Only value is `nosniff`; no configuration                               |
| `Referrer-Policy`                  | Information leakage in Referer header | `strict-origin-when-cross-origin`                    | Too strict = breaks analytics and third-party integrations              |
| `Permissions-Policy`               | Unauthorized browser feature access   | `camera=(), microphone=(), geolocation=(self)`       | Feature names changed; old syntax was `Feature-Policy`                  |
| `Cross-Origin-Opener-Policy`       | Cross-origin data leaks, Spectre      | `same-origin`                                        | Breaks cross-origin popups (OAuth, payment flow)                        |

### Table 5: ALB vs NLB vs CloudFront Header Behavior

| Capability                                | ALB (Layer 7)               | NLB (Layer 4)                             | CloudFront (Edge)              |
| ----------------------------------------- | --------------------------- | ----------------------------------------- | ------------------------------ |
| Adds X-Forwarded-For                      | ✅ Yes                      | ❌ No (IP preservation or Proxy Protocol) | ✅ Yes (extends chain)         |
| Adds X-Forwarded-Proto                    | ✅ Yes                      | ❌ No                                     | ✅ Yes                         |
| Route based on Host header                | ✅ Yes                      | ❌ No                                     | ✅ Yes (host-based behaviors)  |
| Route based on custom header value        | ✅ Yes                      | ❌ No                                     | ❌ No (use Lambda@Edge)        |
| TLS termination (reads encrypted headers) | ✅ Yes                      | Optional TLS passthrough or termination   | ✅ Yes                         |
| Can add response headers                  | ✅ Via ALB response headers | ❌ No                                     | ✅ Via Response Headers Policy |
| Sticky sessions via cookie                | ✅ AWSALB cookie            | ❌ No                                     | ❌ No                          |
| CORS headers                              | ❌ No (app responsibility)  | ❌ No                                     | ✅ Via Response Headers Policy |

---

## SECTION 11 — Quick Revision

### 10 Key Points

1. **HTTP headers are key-value pairs, case-insensitive**, terminated by CRLF. A blank line separates headers from body. In HTTP/2, all header names are lowercase by protocol.

2. **`Host` header is mandatory in HTTP/1.1.** It enables virtual hosting (many domains on one IP). Without it, the server can't route the request. HTTP/2 uses `:authority` pseudo-header.

3. **`Cache-Control: no-cache` ≠ "don't cache."** It means "you can cache but must revalidate." `no-store` means "never store." Security-sensitive data should use `no-store`.

4. **`Vary: Accept-Encoding` = correct; `Vary: Cookie` = fragile; `Vary: User-Agent` = catastrophic** (thousands of unique User-Agents = thousands of cache entries = 0% hit rate).

5. **ETag enables bandwidth-free validation.** When content is unchanged, server returns 304 with zero body bytes. At scale, this saves terabytes of bandwidth.

6. **`Content-Security-Policy` is the most powerful XSS defense.** Deploy in `report-only` mode first (collects violations without breaking), then enforce. Violations are reported to `report-uri`.

7. **HSTS `includeSubDomains` is irreversible** within the max-age period. Every browser that saw the header will upgrade ALL subdomains to HTTPS until the max-age expires. Test before enabling.

8. **X-Forwarded-For can be spoofed** by clients prepending their own IP. For rate limiting, use the LAST value added by your known infrastructure (ALB/CloudFront), not the first value.

9. **API Gateway CORS changes require redeployment.** "I enabled CORS but still seeing errors" = most likely forgot to Deploy API after the change. APIs don't update until explicitly deployed.

10. **NLB does not add HTTP headers.** Only ALB (Layer 7) adds X-Forwarded-For, X-Forwarded-Proto. NLB uses Proxy Protocol v2 (binary TCP header) or IP preservation for client IP.

### 30-Second "I Know This" Explanation

HTTP headers are the metadata layer of every request and response — they carry everything the infrastructure needs to make decisions without reading the body. On requests, they carry identity (`Authorization`), format preferences (`Accept`, `Accept-Encoding`), caching state (`If-None-Match`), and routing info (`Host`, `Origin`). On responses, they control caching (`Cache-Control`, `ETag`, `Vary`), security (`HSTS`, `CSP`, `X-Frame-Options`, `nosniff`), and state management (`Set-Cookie`, `Location`). In AWS, every layer from CloudFront to ALB to API Gateway reads and writes headers for routing, security, caching, and tracing. The most architecturally impactful headers are: `Cache-Control` (which controls billion-dollar CDN utilization), `Content-Security-Policy` (which determines XSS attack surface), and `X-Forwarded-For` (which is your only window into real client identity behind proxies).

### Mnemonics

**"CAVE" for the 4 key request header categories:**

- **C**ontent (Content-Type — what I'm sending)
- **A**ccept (Accept — what I want back)
- **V**erify (Authorization — who I am)
- **E**tiquette (If-None-Match — conditional cache check)

**"S-CRXP" for security response headers:**

- **S**TS (Strict-Transport-Security = HSTS)
- **C**SP (Content-Security-Policy = no XSS)
- **R**eferrer-Policy (= information control)
- **X**-Frame-Options (= no clickjacking)
- **P**ermissions-Policy / X-Content-Type-Options (= no MIME sniffing)

**"The Vary Killers":**

- `Vary: *` → Kills ALL caching
- `Vary: User-Agent` → Kills cache hit rate (thousands of agents)
- `Vary: Cookie` → Kills cache + security risk
- Safe: `Vary: Accept-Encoding`, `Vary: Accept-Language`, `Vary: Origin`

**"no-STORE = Sensitive Data on the STORE floor (never leave it there)"**

- `no-store` = bank data, credit cards, passwords
- "STORE floor" = browser disk/memory = never store sensitive info there

---

## SECTION 12 — Architect Thinking Exercise

### The Problem

**Production Incident — CSP Deployment Breaks Production**

Your company's security team has been pushing for Content-Security-Policy headers. You implement them directly in production:

```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'
```

Monitoring shows a sudden spike in reported JavaScript errors at 3:00 PM. Customer support starts receiving calls: "The checkout button does nothing," "The payment form won't load," "The site looks broken."

Your checkout flow was loading fine before. Your homepage loads fine. But the /checkout route is completely broken.

ALB access logs show 200 responses (server is responding correctly). No 5xx errors. Users are getting the HTML — it just doesn't work.

What is happening, and what is the right process to have avoided this?

---

_Think through the problem before reading further._

---

_Why did CSP break only the checkout and not the homepage?_

---

_Where would you look first?_

---

### The Solution

**Root Cause: CSP blocked third-party payment SDK and CDN resources**

Your checkout page loads resources from external domains. The `default-src 'self'` CSP policy only allows resources from YOUR origin. Everything else is blocked.

```html
<!-- Checkout page resources that are NOW blocked by CSP: -->
<script src="https://js.stripe.com/v3/"></script>
<!-- ❌ BLOCKED: js.stripe.com not in script-src -->

<link rel="stylesheet" href="https://fonts.googleapis.com/css2?..." />
<!-- ❌ BLOCKED: fonts.googleapis.com not in style-src -->

<script>
  window.analytics.track("checkout_viewed"); // Segment analytics
</script>
<!-- ❌ BLOCKED: inline script. 'unsafe-inline' not in script-src -->

<img src="https://secure.example-analytics.com/pixel.gif" />
<!-- ❌ BLOCKED: example-analytics.com not in img-src -->
```

The browser silently blocks all of these (from user perspective: nothing happens when they click "Pay"). The browser console shows CSP violation errors, but users don't see the console.

### The Right Process: Report-Only Mode First

```
PHASE 1 — Observe (Report-Only mode, NO enforcement):

  Add header:
  Content-Security-Policy-Report-Only: default-src 'self'; report-uri /csp-report

  This header: DOES NOT BLOCK anything
               REPORTS all violations to your /csp-report endpoint

  Deploy to production and wait 24-48 hours. Collect all CSP violations:
  [
    {"blocked-uri": "https://js.stripe.com/v3/", "violated-directive": "script-src"},
    {"blocked-uri": "https://fonts.googleapis.com", "violated-directive": "style-src"},
    {"blocked-uri": "inline", "violated-directive": "script-src"},
    {"blocked-uri": "https://analytics.segment.com", "violated-directive": "connect-src"}
  ]

PHASE 2 — Build complete allowlist from violation report:

  Content-Security-Policy-Report-Only:
    default-src 'self';
    script-src 'self' https://js.stripe.com https://analytics.segment.com;
    style-src 'self' https://fonts.googleapis.com;
    font-src 'self' https://fonts.gstatic.com;
    img-src 'self' data: https://secure.analytics.com;
    connect-src 'self' https://api.stripe.com https://analytics.segment.com;
    frame-src https://js.stripe.com;
    report-uri /csp-report;

  Deploy again in report-only mode. Zero violations? → Ready to enforce.

PHASE 3 — Enforce (switch from Report-Only to enforcing):

  Content-Security-Policy:  ← change from Report-Only to enforcing
    default-src 'self';
    script-src 'self' https://js.stripe.com https://analytics.segment.com;
    style-src 'self' https://fonts.googleapis.com 'unsafe-inline';
    font-src 'self' https://fonts.gstatic.com;
    img-src 'self' data: https://secure.analytics.com;
    connect-src 'self' https://api.stripe.com https://analytics.segment.com;
    frame-src https://js.stripe.com;
    report-uri /csp-report;  ← keep for ongoing monitoring

PHASE 4 — Ongoing monitoring:
  /csp-report endpoint (or hosted at report.uri):
  - Alert if violation count spikes (indicates XSS attempt or unauthorized resource)
  - Review weekly for new legitimate third-party resources needing allowlist
```

### AWS Implementation

```
CloudFront Response Headers Policy (no application code change):

  Security headers policy:
    Content-Security-Policy:
      default-src 'self';
      script-src 'self' https://js.stripe.com https://analytics.segment.com;
      style-src 'self' https://fonts.googleapis.com 'unsafe-inline';
      font-src 'self' https://fonts.gstatic.com;
      img-src 'self' data:;
      connect-src 'self' https://api.stripe.com;
      frame-src https://js.stripe.com;
      report-uri https://csp.yourcompany.com/report;

    Override behavior: "Override" (always add, even if origin sends one)

For report-uri endpoint:
  Use a dedicated lightweight Lambda function behind API Gateway:
    POST /csp-report → Lambda → writes to CloudWatch Logs →
    CloudWatch Insights query for violation spikes →
    SNS alarm if violations from new unknown origins > threshold
```

### Final Architect Insight

The CSP incident illustrates the most important rule for deploying security headers in production systems: **measure before you enforce.** Unlike most application changes (which are visible in testing), CSP failures are SILENT in users' browsers. The server responds 200. Your integration tests pass (they test that the server returns HTML — not that JavaScript executes). E2E tests may catch it only if they run on the exact routes with all third-party loading.

Report-Only mode is the professional path: minimum 48 hours of observation in production traffic (not just your test scenarios), zero violations, then enforce. The alternative is the scenario above — checkout doesn't work, $XX,000 in lost transactions, emergency rollback, incident report explaining why security team's well-intentioned change cost the company real money.

The same principle applies to HSTS preload — once you submit to the HSTS preload list, you cannot undo it for months. Enforce on production for 12+ weeks without issues before submitting.

---

## File Summary — Topic 17 Complete

**All three files together cover:**

**File 01 (Sections 1-4):** Envelope + shipping manifest analogies; header anatomy (key-value CRLF format, case-insensitive); request headers (Accept/Authorization/If-None-Match/Host/Origin/User-Agent/X-Correlation-ID); response headers (Content-Type/Length/Encoding, Cache-Control/ETag/Vary, WWW-Authenticate/Set-Cookie/Location, security headers); ASCII diagrams for request flow, ETag caching, CORS, CSP enforcement; step-by-step ETag validation, CORS preflight, security header browser enforcement.

**File 02 (Sections 5-8):** Bank teller + airport analogies; XSS/clickjacking/HSTS/MIME-sniffing real incidents and preventing headers; infrastructure header additions per layer; Cache-Control deep dive (immutable, s-maxage, stale-while-revalidate, no-store); Vary cache fragmentation dangers; X-Forwarded-For chain and spoofing; CloudFront custom headers, response policy, ALB routing, API Gateway CORS/JWT; 8 Q&As.

**File 03 (Sections 9-12):** AWS SAA traps (cookie forwarding disables CDN cache, HSTS includeSubDomains trap, Vary:Cookie fragility, CloudFront Response Headers Policy, NLB has no HTTP headers); 5 comparison tables (request vs response reference, Cache-Control decision guide, cookie security flags, security headers, ALB vs NLB vs CloudFront); CAVE/SCRXP/Vary-Killers mnemonics; Architect Exercise — CSP broke checkout (blocked Stripe/analytics) → lesson: always use Report-Only mode for 48h before enforcing CSP.
