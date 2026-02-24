# CSRF Attack — Part 2 of 3

### Sections: 5 (Defense Mechanisms), 6 (Architecture Diagram), 7 (Production Scenarios), 8 (AWS Mapping)

**Series:** Authentication & Security → Topic 06

---

## SECTION 5 — Defense Mechanisms

### Defense 1: SameSite Cookie Attribute (Browser-Side)

```javascript
// app.js — Express session configuration
import session from "express-session";
import RedisStore from "connect-redis";
import { createClient } from "redis";

const redisClient = createClient({ url: process.env.REDIS_URL });

app.use(
  session({
    store: new RedisStore({ client: redisClient }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    name: "__Host-sessionId", // __Host- prefix: must be Secure, no Domain, Path=/
    cookie: {
      httpOnly: true, // Not accessible via document.cookie (blocks XSS cookie theft)
      secure: true, // HTTPS only
      sameSite: "Lax", // Block cross-site POST/img/iframe bearing this cookie
      maxAge: 8 * 60 * 60 * 1000, // 8 hours
      // No `domain` attribute with __Host- prefix: cookie locked to exact origin
    },
  }),
);

// SameSite=Strict if your app has no external link entry points:
// sameSite: 'Strict'  // Even stricter: never sent on cross-site requests AT ALL
```

### Defense 2: Synchronizer Token Pattern (Full Implementation)

```javascript
// csrf.middleware.js — production-grade CSRF token middleware
import crypto from "crypto";

const TOKEN_BYTES = 32; // 256 bits of entropy
const CSRF_HEADER = "x-csrf-token";
const CSRF_COOKIE = "XSRF-TOKEN";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS", "TRACE"]);

// Called after session middleware
async function csrfTokenMiddleware(req, res, next) {
  if (!req.session?.id) return next();

  // Issue a CSRF token if session doesn't have one yet
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(TOKEN_BYTES).toString("hex");
    await req.session.save();
  }

  // Expose via cookie (JS-readable, needed for SPAs)
  res.cookie(CSRF_COOKIE, req.session.csrfToken, {
    httpOnly: false, // must be false: JS needs to read it to include in header
    secure: true,
    sameSite: "Strict",
    path: "/",
  });

  next();
}

// Called on all routes before handlers
function csrfValidationMiddleware(req, res, next) {
  // Skip validation for safe (read-only) methods
  if (SAFE_METHODS.has(req.method)) return next();

  const submittedToken = req.headers[CSRF_HEADER] || req.body?._csrf;
  const sessionToken = req.session?.csrfToken;

  if (!submittedToken || !sessionToken) {
    return res.status(403).json({
      error: "CSRF_VALIDATION_FAILED",
      message: "CSRF token missing",
    });
  }

  // Constant-time comparison to prevent timing attacks on CSRF tokens
  let valid = false;
  try {
    const a = Buffer.from(submittedToken, "hex");
    const b = Buffer.from(sessionToken, "hex");
    valid = a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    valid = false;
  }

  if (!valid) {
    // Log suspicious request
    console.warn({
      event: "CSRF_MISMATCH",
      ip: req.ip,
      userId: req.session?.userId,
      path: req.path,
      method: req.method,
    });
    return res
      .status(403)
      .json({ error: "CSRF_VALIDATION_FAILED", message: "Invalid CSRF token" });
  }

  next();
}

export { csrfTokenMiddleware, csrfValidationMiddleware };
```

### Defense 3: Origin / Referer Header Validation

```javascript
// Additional layer: verify request came from your own origin
// Works as defense-in-depth. Does not replace CSRF tokens.
// Some proxies/browsers strip Referer for privacy — can have false positives.

function originValidationMiddleware(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();

  const origin = req.headers["origin"];
  const referer = req.headers["referer"];
  const allowedOrigins = new Set([
    "https://app.yoursite.com",
    "https://www.yoursite.com",
  ]);

  // Prefer Origin header (more reliable, less strippable)
  if (origin) {
    if (!allowedOrigins.has(origin)) {
      console.warn({ event: "CSRF_ORIGIN_MISMATCH", origin, path: req.path });
      return res.status(403).json({ error: "ORIGIN_NOT_ALLOWED" });
    }
    return next();
  }

  // Fallback: Referer header
  if (referer) {
    try {
      const refererOrigin = new URL(referer).origin;
      if (!allowedOrigins.has(refererOrigin)) {
        return res.status(403).json({ error: "REFERER_NOT_ALLOWED" });
      }
    } catch {
      return res.status(403).json({ error: "REFERER_INVALID" });
    }
    return next();
  }

  // Neither Origin nor Referer — reject for high-sensitivity endpoints
  // For lower sensitivity, you might allow (mobile apps, privacy-stripping proxies)
  return res.status(403).json({ error: "ORIGIN_REQUIRED" });
}
```

### Defense Summary: Layered CSRF Protection

```
LAYER 1 (Browser): SameSite=Lax or Strict on session cookie
  → Blocks majority of classic CSRF attacks from external domains
  → Free: just set the cookie attribute correctly
  → Limitation: GET-based CSRF, legacy browsers, subdomain cookies

LAYER 2 (Application): Synchronizer CSRF Token or Double-Submit Cookie
  → Server-generated random token per session
  → Validated on every state-changing request
  → Attacker cannot forge it (SOP prevents reading the token)
  → Works regardless of browser SameSite support

LAYER 3 (Network): Origin/Referer validation
  → Additional check on request origin
  → Defense-in-depth: catches some cases the above miss
  → May have false positives with privacy proxies

LAYER 4 (Architecture): Don't use GET endpoints for state changes
  → GET requests: read-only, no session changes, no data writes
  → Eliminates entire class of GET-based CSRF
  → Follow HTTP semantics (RFC 7231): GET = safe + idempotent

DEPLOYMENT CHECKLIST:
  [ ] SameSite=Lax (minimum) on all session cookies
  [ ] CSRF token generated per session, validated on POST/PUT/DELETE/PATCH
  [ ] CSRF token in header (X-CSRF-Token) for AJAX, hidden field for HTML forms
  [ ] Origin/Referer validation on sensitive endpoints
  [ ] GET endpoints: zero state changes
  [ ] Subdomains: secure cookie Domain scope (subdomain takeover + CSRF chain)
```

---

## SECTION 6 — Architecture Diagram

```
CSRF PROTECTION ARCHITECTURE

BROWSER (https://app.yoursite.com)
┌────────────────────────────────────────────────────────────────────────────────┐
│  1. User logs in → server issues session cookie (SameSite=Lax, HttpOnly)       │
│     AND CSRF cookie (SameSite=Strict, NOT HttpOnly — JS can read)              │
│                                                                                 │
│  2. React app reads CSRF cookie:                                                │
│     axios.defaults.headers.common['X-CSRF-Token'] = readCsrfCookie()          │
│     All non-GET requests now carry this header automatically                   │
│                                                                                 │
│  3. For HTML forms (non-SPA): server embeds token in hidden field              │
│     <input type="hidden" name="_csrf" value="{{csrfToken}}">                   │
└───────────────────────────────────┬───────────────────────────────────────────┘
                                    │ POST /api/transfer
                                    │ Cookie: sessionId=abc (SameSite=Lax → sent since same site)
                                    │ X-CSRF-Token: a9f3c2...  (header from JS — attacker can't set this)
                                    ▼
CLOUDFRONT / WAF
┌────────────────────────────────────────────────────────────────────────────────┐
│  AWS WAF: inspect headers, block requests without X-CSRF-Token on POST routes  │
│           (optional WAF rule — not a substitute for app-level validation)      │
│  CloudFront: enforce HTTPS (no downgrade attack on cookie Secure flag)         │
└───────────────────────────────────┬───────────────────────────────────────────┘
                                    ▼
APPLICATION SERVER
┌────────────────────────────────────────────────────────────────────────────────┐
│  Middleware pipeline (in order):                                               │
│                                                                                 │
│  1. express-session (load session from Redis using sessionId cookie)           │
│  2. csrfTokenMiddleware (ensure session has CSRF token, expose as cookie)      │
│  3. csrfValidationMiddleware (validate header token == session token)          │
│  4. originValidationMiddleware (verify Origin header)                          │
│  5. Route handler (only reached if all checks pass)                            │
│                                                                                 │
│  If CSRF validation fails: 403 CSRF_VALIDATION_FAILED. Request rejected.       │
│  No state changes occur.                                                        │
└───────────────────────────────────┬───────────────────────────────────────────┘
                                    ▼
ELASTICACHE REDIS
┌────────────────────────────────────────────────────────────────────────────────┐
│  Session store: sessionId → { userId, csrfToken, ... }                        │
│  CSRF token fetched from session (not re-generated per request)                │
│  TTL: synced with session TTL                                                   │
└────────────────────────────────────────────────────────────────────────────────┘

────────────────────────────────────────────────────────────────────────────────
ATTACKER'S FAILED ATTEMPT:
  attacker.evil → POST bank.com with session cookie (SameSite=Lax allows top-level)
  Browser sends session cookie: ✓ (CSRF attempt relies on this)
  Attacker sets X-CSRF-Token header: ✗ (can't read CSRF cookie due to SOP)
  Server validation: session token ≠ submitted token → 403 rejected.

  SameSite alone: ✓ blocks most CSRF but fails on same-domain subdomains
  CSRF token alone: ✓ blocks even same-subdomain CSRF
  Both together: ✓✓ defense in depth
────────────────────────────────────────────────────────────────────────────────
```

---

## SECTION 7 — Production Scenarios

### Scenario 1: SPA (Single-Page Application) Migration

```
SITUATION: A company migrates from server-rendered HTML to a React SPA.
           Their old CSRF protection uses: form hidden fields with CSRF tokens.
           After SPA migration: no HTML forms. Just fetch() / Axios.

WHAT WENT WRONG:
  Old code: CSRF token in hidden form field — works for HTML form submits.
  New code: Axios sends JSON. No form field. CSRF middleware receives no _csrf field.

  Developer: adds an exception "for API routes" because CSRF middleware fails.
  // BAD: app.use('/api', csrfExclusionMiddleware)

  Result: all API routes unprotected. Back to square one.

CORRECT MIGRATION:

Step 1: Update frontend to read CSRF token from cookie:
  // api.js
  import axios from 'axios';

  const api = axios.create({ baseURL: '/api', withCredentials: true });

  api.interceptors.request.use((config) => {
    if (!['get', 'head', 'options'].includes(config.method)) {
      const csrfToken = document.cookie
        .split(';')
        .find(c => c.trim().startsWith('XSRF-TOKEN='))
        ?.split('=')[1];

      if (csrfToken) {
        config.headers['X-CSRF-Token'] = decodeURIComponent(csrfToken);
      }
    }
    return config;
  });

  export default api;

Step 2: Backend validates X-CSRF-Token header (not _csrf form field):
  const submittedToken = req.headers['x-csrf-token'];  // Changed from body field

Step 3: Ensure CSRF cookie is NOT HttpOnly (JS must be able to read it):
  res.cookie('XSRF-TOKEN', token, { httpOnly: false, ... });

Result: CSRF protection preserved after SPA migration.
```

### Scenario 2: Subdomain Cookie Scope Vulnerability

```
COMPANY SETUP:
  Main app: https://app.company.com
  Marketing site: https://www.company.com
  User-hosted content: https://user-content.company.com   ← DANGER

COOKIE CONFIG (mistake):
  Set-Cookie: sessionId=abc; Domain=.company.com   ← dot prefix: ALL subdomains!

PROBLEM:
  If user-content.company.com allows user-controlled content (XSS vector):
    → Attacker posts content with JavaScript to user-content.company.com
    → Victim views it → JS runs from the user-content subdomain
    → user-content.company.com IS a subdomain of .company.com
    → Browser sends the sessionId cookie to user-content.company.com
    → Attacker reads the session cookie via JavaScript!
    → SameSite=Lax doesn't help: user-content.company.com IS same-site as app.company.com

ALSO: Subdomain CSRF bypass:
    CSRF request from user-content.company.com to app.company.com:
    → Same-site! SameSite=Lax ALLOWS this.
    → CSRF token from cookie: attacker can read it (same-site script access)
    → Attacker forges CSRF token correctly.
    → CSRF protection bypassed.

DEFENSE:
  1. Never serve user-controlled content from a subdomain of your application origin.
     Use a completely separate domain: https://ugc.company-assets.com (no cookies shared)

  2. Use __Host- cookie prefix:
     Set-Cookie: __Host-sessionId=abc; Secure; Path=/; HttpOnly
     NO Domain attribute allowed (browser rejects if Domain is set with __Host-)
     → Cookie locked to exact host: app.company.com ONLY. Not *.company.com.

  3. Content Security Policy on user-uploaded content subdomain.
```

---

## SECTION 8 — AWS Mapping

### AWS Services for CSRF Defense

```
┌─────────────────────────────┬────────────────────────────────────────────────────┐
│ AWS Service                 │ Role in CSRF Defense                               │
├─────────────────────────────┼────────────────────────────────────────────────────┤
│ AWS WAF                     │ Custom rule: block POST/PUT/DELETE requests         │
│                             │   missing X-CSRF-Token header on specific URIs.    │
│                             │ Not a replacement for app-layer CSRF tokens.       │
│                             │ Acts as a fast-fail layer before app server.       │
│                             │ Managed rules: Cross-site forgery protection       │
│                             │   available in AWS Managed Rules group             │
├─────────────────────────────┼────────────────────────────────────────────────────┤
│ CloudFront                  │ Enforce HTTPS: cookie Secure flag depends on HTTPS  │
│                             │ Without HTTPS: session cookies transmitted in clear │
│                             │ → CSRF token interception possible                 │
│                             │ CloudFront + ACM certificate: free HTTPS           │
├─────────────────────────────┼────────────────────────────────────────────────────┤
│ ElastiCache Redis           │ Server-side CSRF token storage per session         │
│                             │ CSRF token → TTL synced with session expiry        │
│                             │ Cluster mode: CSRF token available across app servers│
├─────────────────────────────┼────────────────────────────────────────────────────┤
│ Cognito                     │ When using Cognito hosted UI: CSRF protection      │
│                             │   built-in via state parameter in OAuth flows      │
│                             │   state = random value → verified on callback      │
│                             │ If using Cognito + custom UI: you handle CSRF.     │
├─────────────────────────────┼────────────────────────────────────────────────────┤
│ CloudWatch                  │ Alarm on: spike in 403 CSRF_VALIDATION_FAILED      │
│                             │ Alarm on: rapid POST/PUT from single IP without    │
│                             │   valid CSRF token → potential automated attack     │
└─────────────────────────────┴────────────────────────────────────────────────────┘
```

### AWS WAF Rule for CSRF Header Enforcement

```json
{
  "Name": "RequireCSRFTokenForMutations",
  "Priority": 10,
  "Action": { "Block": {} },
  "VisibilityConfig": {
    "SampledRequestsEnabled": true,
    "CloudWatchMetricsEnabled": true,
    "MetricName": "RequireCSRFToken"
  },
  "Statement": {
    "AndStatement": {
      "Statements": [
        {
          "ByteMatchStatement": {
            "FieldToMatch": { "Method": {} },
            "PositionalConstraint": "EXACTLY",
            "SearchString": "POST",
            "TextTransformations": [{ "Priority": 0, "Type": "LOWERCASE" }]
          }
        },
        {
          "NotStatement": {
            "Statement": {
              "ByteMatchStatement": {
                "FieldToMatch": {
                  "SingleHeader": { "Name": "x-csrf-token" }
                },
                "PositionalConstraint": "STARTS_WITH",
                "SearchString": "a",
                "TextTransformations": [{ "Priority": 0, "Type": "LOWERCASE" }]
              }
            }
          }
        }
      ]
    }
  }
}
```

### CORS Configuration (Tighten to Prevent CSRF via JSON)

```javascript
// cors.config.js — Production CORS preventing CSRF escalation
import cors from "cors";

const corsOptions = {
  origin: (origin, callback) => {
    const allowedOrigins = [
      "https://app.yoursite.com",
      "https://www.yoursite.com",
    ];

    // Allow requests with no origin (mobile apps, curl, same-origin)
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`CORS: Origin ${origin} not allowed`));
    }
  },
  credentials: true, // Allow cookies to be sent/received cross-origin (to allowed origins)
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-CSRF-Token"],
};

// CRITICAL: Don't use origin: '*' with credentials: true
// origin: '*' + credentials: true → browser blocks AND it means attacker.com is allowed
// Use explicit allowedOrigins list. If you need public API: don't use credentials.

app.use(cors(corsOptions));
```
