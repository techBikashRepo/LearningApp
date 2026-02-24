# Authentication vs Authorization — Part 3 of 3

### Sections: 9 (Interview Prep), 10 (Common Developer Mistakes), 11 (Quick Revision), 12 (Security Thinking Exercise)

**Series:** Authentication & Security → Topic 01

---

## SECTION 9 — Interview Preparation

### What Interviewers Are Actually Testing

```
Beginner questions: Do you know the vocabulary and distinction?
  Many candidates use "auth" for both — this reveals shallow understanding.

Intermediate questions: Can you design a secure system?
  Interviewers want to see defense-in-depth thinking.
  They are listening for: "and also we need authorization at the resource level."
  Missing that = they mark you down even if authentication is flawless.

Advanced questions: Have you dealt with real security incidents?
  They want operational thinking: rotation, revocation, auditing.
  They want to understand whether you design for the breach scenario,
  not just the happy path.

The single most impressive answer pattern:
  Mention OWASP A01:2021 Broken Access Control (was A5:2017 → moved to #1).
  Explain you've seen it in code review. Demonstrate you look for IDOR proactively.
  This shows you've internalized real-world security, not just textbook knowledge.
```

---

### Beginner Questions

**Q1: What is the difference between authentication and authorization?**

```
Direct answer (memorize this structure):

Authentication: "Prove who you are."
  Process: System verifies that your presented credentials match a known identity.
  Example: JWT signature valid + email + password match → identity established.
  Output: An identity (user ID, claims).

Authorization: "What are you allowed to do?"
  Process: Given a confirmed identity, check if it has permission for this action.
  Example: user_id matches invoice.user_id → allowed. role === "admin" → allowed.
  Output: Allow or Deny.

Key point for interviews:
  Authentication happens ONCE at login. Authorization happens on EVERY request.
  You can succeed at authentication and still be blocked by authorization.
  These are sequential gates, not alternatives.

  Real example: I log into Amazon (authenticated).
  Then I try to view my order history (authorized — my orders).
  Then I try to view your order history (authentication still valid, authorization DENIED).
```

---

**Q2: What is an IDOR vulnerability?**

```
IDOR = Insecure Direct Object Reference.
OWASP calls this a subset of Broken Access Control (#1 vulnerability since 2021.

Definition:
  An API endpoint accepts a resource identifier (ID) directly from user input
  and fetches the resource without verifying the requesting user has access to it.

Example:
  GET /api/invoices/1234 — this is a "direct object reference" (1234 = invoice ID)
  "Insecure" = the server doesn't check if YOUR identity owns invoice 1234.

Why it's so common:
  Developers think: "User is logged in = they can see their data"
  They forget: "logged in" ≠ "allowed to see this specific resource"

How to prevent:
  Always include ownership in the database query:
  WHERE id = $id AND user_id = $currentUserId

  If resource doesn't belong to requesting user → 404 (not 403, to avoid confirming existence)

Real-world examples: Peloton, Parler, countless banking apps, hotel booking systems.
```

---

**Q3: Why does returning 403 instead of 404 for unauthorized resources create a security risk?**

```
HTTP 403 Forbidden: "You don't have permission to access this resource."
HTTP 404 Not Found: "No resource exists at this path."

Security risk of 403:
  403 reveals the resource EXISTS but the requesting user cannot access it.

  Attack scenario:
  Attacker tries: GET /invoices/inv_9987
  Response: 403 Forbidden
  Attacker now knows: invoice inv_9987 EXISTS. Belongs to someone else.
  Attacker can now target the actual owner (social engineering, phishing).
  Or confirm their enumeration found valid IDs before pivoting to another attack.

  Response: 404 Not Found
  Attacker cannot tell: does this invoice exist? Is it not mine?
  No actionable intelligence.

The principle: Never leak the existence of resources to unauthorized requestors.
  This is called "security through obscurity" at the API level — not sufficient alone,
  but a useful additional layer in unauthorized access scenarios.

Exception: own resource that doesn't exist → 404 is correct (you'd expect to see it if it existed).
```

---

### Intermediate Questions

**Q1: Design the authentication and authorization system for a multi-tenant SaaS application.**

```
INTERVIEWER WANTS TO HEAR:
  Tenant isolation at EVERY layer — not just login.

System Design:

1. Authentication layer:
   Cognito User Pool (one pool per environment, not per tenant).
   JWT contains: sub (user_id), custom:tenant_id, custom:role.
   Login: email + password validated against Cognito.
   MFA: TOTP required for admin-scoped users.
   Token: 1-hour access token, 30-day refresh token.

2. API Gateway authorization:
   JWT Authorizer verifies signature, expiry, issuer, audience.
   Injects requestContext.authorizer.jwt.claims into Lambda event.
   Malformed/expired tokens: 401 response before Lambda runs.

3. Application-level authorization:
   Every database query includes tenant_id from JWT claims:
   WHERE resource_id = $1 AND tenant_id = $2

   This means: even if attacker has valid JWT from Tenant A,
   all DB queries for Tenant B's data return 0 rows.
   Tenant isolation enforced at query level — not just application logic.

4. Admin operations:
   Role check: custom:role === 'admin' + tenant boundary still applies.
   Tenant admin cannot access other tenants, even as admin.
   Super-admin (platform staff): separate Cognito pool, separate API path,
   separate CloudTrail audit trail for regulatory compliance.

5. Audit log:
   Every 403 decision logged: user_id, tenant_id, resource attempted, timestamp.
   Spike in 403s for one tenant: possible account takeover in progress.
   CloudWatch alarm on 403 rate → alert security team.

Key insight: tenant_id from JWT cannot be forged (JWT is signed).
             Query-level enforcement cannot be bypassed by application bugs.
```

---

**Q2: A user changes their email or password. How do you handle active sessions/tokens securely?**

```
PROBLEM: User changes password → they want all other sessions invalidated.
(Classic scenario: discovered their account was compromised → changed password → still compromised)

SESSION-BASED SYSTEM — easy:
  DELETE FROM sessions WHERE user_id = $userId AND id != $currentSessionId
  All other sessions: gone immediately. Next request → re-authenticate required.

JWT SYSTEM — harder (stateless by design):
  Option 1: Token version in database + JWT claim
    User table: + token_version int (default 0)
    JWT claim: + tv: <token_version>

    Password change: UPDATE users SET token_version = token_version + 1 WHERE id = $userId

    Every request: verify JWT → check jwt.tv === db.user.token_version
    Mismatched version: 401 → re-authenticate required.

    Trade-off: one DB lookup per request (partially stateless)

  Option 2: Short JWT + refresh token invalidation
    Access token (15 min): cannot revoke immediately (accept 15-min window)
    Refresh token: stored in DB, delete all refresh tokens for user on password change

    After 15 minutes: access token expires, client tries to refresh
    Refresh token gone: 401 → re-authenticate required

    Best balance for most applications.

  Option 3: JTI blocklist in Redis
    On password change: add all previously issued JTIs to Redis blocklist
    (Query: get all active JTIs from refresh token table)
    Each request: lookup JTI in Redis → if found: 401

    Immediate revocation. Redis TTL = token expiry → no growing list.

RECOMMENDATION:
  Short-lived JWT (15 min) + DB-backed refresh token + refresh invalidation on password change.
  Balances performance (no DB on every request) with security (max 15-min window after compromise).
```

---

**Q3: You're designing a public API with API keys. How do you implement authorization for API key consumers?**

```
API keys: used for machine-to-machine auth (not human users).

DESIGN DECISIONS:

1. Key format:
   Prefix for identification: inf_live_sk_abc123...  (InvoiceFlow, live, secret key)
   Prefix lets you identify key type/environment on sight.
   Never use sequential integers (inf_1, inf_2) — guessable.
   256+ bits of randomness from crypto.randomBytes(32).toString('hex').

2. Storage:
   Never store the raw key. Store: prefix + SHA-256 hash of key.
   Database: { key_id, key_prefix, key_hash, user_id, scopes, created_at }

   Verification:
   Incoming: "inf_live_sk_abc123..."
   Extract prefix: "inf_live_sk_" → look up by prefix
   Hash remainder: SHA-256("abc123...") → compare with stored hash

   Why: if database is breached, attackers get hashes, not actual keys.
   They cannot reverse the hash to get the working key.

3. Scopes on API keys:
   Each key has assigned scopes: ["invoices:read", "customers:read"]
   Admin keys: ["invoices:read", "invoices:write", "customers:write"]

   Scope check:
   if (!apiKey.scopes.includes(requiredScope)) return 403 INSUFFICIENT_SCOPE;

   Why: compromised read-only key cannot write. Blast radius limited.

4. Authorization still required:
   API key identifies the account. Ownership still checked per resource.
   API key for Account A cannot access Account B's data even with write scope.

5. Rotation and revocation:
   Keys can be revoked immediately (set is_revoked = true in DB)
   Key rotation: issue new key, grace period for old key (e.g., 30 days), then delete old key
   Rotation event: logged to CloudTrail + notify account owner
```

---

### Advanced Questions

**Q1: You discover that 500 accounts in your system show signs of simultaneous active sessions from multiple geographically impossible locations. What is your incident response process?**

```
DIAGNOSIS: Active session from Boston and Singapore simultaneously = token theft.
One person cannot be in both places. Either VPN, or stolen tokens being replayed.

IMMEDIATE (0–15 minutes):
  1. Quarantine the affected accounts:
     Set account_status = 'security_review' for 500 accounts.
     This blocks all API requests regardless of valid token.
     Locked accounts receive: "Suspicious activity detected. Please reset your password."

  2. Invalidate all sessions:
     Session-based: DELETE FROM sessions WHERE user_id IN (...500 IDs)
     JWT-based: Increment token_version for all 500 accounts (existing tokens dead)
     Refresh tokens: Delete all refresh tokens for affected accounts.

  3. Notify users:
     Email: "Unusual sign-in detected from a new location. Your session was terminated."
     Link: password reset (required before account re-access).

SHORT-TERM (15 min – 4 hours):
  4. Determine attack vector:
     CloudTrail / CloudWatch Logs: how were the tokens obtained?
     Were credentials leaked (breached password database)?
     Was there an XSS on the platform?
     Was there a mobile app with insecure token storage?

  5. Check for data exfiltration:
     What did the suspicious sessions access?
     Did they export data, change email/password, add payment methods?
     Each account: audit log review of all API calls during suspicious window.

MEDIUM-TERM (4 hours – 24 hours):
  6. Root cause analysis
  7. Patch the vulnerability
  8. Force password reset for broader user base if breach is credential-based
  9. Consider HIBP (Have I Been Pwned) integration for future breach monitoring

REGULATORY:
  GDPR: 72-hour breach notification if EU users affected
  CCPA: notify California users
  PCI-DSS: if payment data accessed → card brand notification required

This demonstrates operational security maturity. Most candidates only say "invalidate sessions."
Interviewers want to see: detection → quarantine → notify → investigate → patch → report.
```

---

**Q2: How do you design an authorization system that scales to 100 microservices?**

```
PROBLEM:
  Monolith: one authorization check per endpoint — manageable.
  100 microservices: each must enforce authorization independently.
  Risk: each team implements authorization differently → inconsistency = holes.

SOLUTIONS AND TRADEOFFS:

Option A — Centralized Policy Decision Point (OPA / OpenFGA):
  Open Policy Agent (OPA): policy-as-code language (Rego).
  All services: send authorization query to OPA:
    { "user": { "id": "u123", "role": "admin", "tenant": "t456" },
      "action": "delete",
      "resource": { "type": "invoice", "tenant": "t456", "owner": "u123" } }
  OPA returns: allow or deny.
  Policies stored in Git, reviewed like code → auditable, consistent.

  Pros: single policy language for all 100 services. One place to update policies.
  Cons: OPA is now a critical dependency. Needs HA deployment. +1ms per request.

Option B — JWT Claims-Based (most common at scale):
  Enrich JWT at issuance: roles, tenant_id, scopes.
  Each service: independently verifies JWT + checks claims locally.
  No external call per request.

  Pros: stateless, no central dependency, < 0.1ms per auth check.
  Cons: JWT renegotiation required for permission changes (wait until next login).
        Complex permissions cannot fit in JWT (token gets too large).

Option C — Sidecar/Service Mesh (Envoy + OPA):
  Auth enforcement moved out of application code.
  Envoy sidecar: validates token before forwarding to service.
  Service receives only valid, claim-enriched requests.
  Application code: zero auth logic (auth concern separated).

  Used by: Airbnb, Netflix, Lyft, Uber.
  Works at Kubernetes (Istio) scale.

RECOMMENDATION FOR INTERVIEWS:
  "For most systems, JWT claims + ownership-in-query handles 90% of authorization.
   For complex policies that change frequently (ABAC), add OPA as the policy engine.
   For scale + separation of concerns, push auth to the service mesh layer."

   This shows: layered thinking, not one-size-fits-all.
```

---

## SECTION 10 — Common Developer Mistakes

```
MISTAKE 1: Using 'alg: none' JWT acceptance in old libraries
─────────────────────────────────────────────────────────────
What happens: JWT library decodes any token without signature verification.
              Attacker changes payload to { "role": "admin" }, strips signature.
              Library accepts it because alg: none means no signature.
Attack: Total access to any account or privilege without password.
Fix: Always explicitly specify expected algorithm:
     jwt.verify(token, secret, { algorithms: ['RS256'] })
     Never allow the token header to determine which algorithm to use.

MISTAKE 2: Storing JWT in localStorage
────────────────────────────────────────────
What happens: Any XSS vulnerability on the page reads all localStorage.
              Attacker's injected script: localStorage.getItem('token') → sends to server.
Attack: Token theft → account takeover → stolen credentials used indefinitely.
Fix: HttpOnly, Secure, SameSite cookies. JavaScript cannot read HttpOnly cookies.

MISTAKE 3: Authorization check only in frontend
────────────────────────────────────────────────
What happens: Delete button hidden in UI for non-admins.
              Backend: DELETE /invoices/:id — no role check, just authentication.
Attack: Attacker uses Postman/curl, bypasses UI completely.
        DELETE /invoices/1 → deleted. Frontend is not security.
Fix: Every authorization check in backend. Frontend is UX, not security.

MISTAKE 4: Returning 403 revealing resource existence
──────────────────────────────────────────────────────
What happens: GET /invoices/inv_9987 → 403 Forbidden tells attacker the invoice exists.
Attack: Attacker confirms enumerated IDs are valid before targeting owners.
Fix: Return 404 for all unauthorized resource access (existence information leak).

MISTAKE 5: Sequential integer IDs
────────────────────────────────────
What happens: Order IDs are 1, 2, 3... Attacker tries 1 through 100,000.
Attack: Systematic enumeration of all resources even with ownership checks in place
        takes only the resources that happen to be public or misconfigured.
        Sequential IDs also reveal business metrics (order count to competitors).
Fix: UUIDs or Hashids. Non-sequential, non-guessable identifiers.

MISTAKE 6: Mass assignment — updating fields from request body directly
─────────────────────────────────────────────────────────────────────────
What happens: Object.assign(user, req.body) or User.update(req.body).
              Body includes { "role": "admin" } → saved to database.
Attack: Vertical privilege escalation without finding any other vulnerability.
Fix: Explicit allowlist: const allowed = ['name', 'bio']; pick(req.body, allowed).

MISTAKE 7: Missing tenant_id in multi-tenant queries
────────────────────────────────────────────────────
What happens: Multi-tenant SaaS checks user ownership but not tenant:
              SELECT * FROM data WHERE id = $1 AND user_id = $2
              User reassigned to different tenant incorrectly → same user_id, different tenant.
              Or: admin of Tenant A gets Tenant B's data if admin check skips tenant filter.
Attack: Cross-tenant data leakage — the highest severity SaaS security failure.
Fix: ALWAYS include tenant_id in every query from a tenant-scoped request.

MISTAKE 8: Verbose error messages leaking authorization state
────────────────────────────────────────────────────────────
What happens: "You don't have admin role" vs "Operation not permitted".
              "Invoice belongs to user_5512, you are user_5513" vs "Not found".
Attack: Attacker learns exact permission model, user IDs of other users, system structure.
Fix: Generic error messages for auth/authz failures revealing nothing about system internals.

MISTAKE 9: No rate limiting on login endpoint
───────────────────────────────────────────────
What happens: POST /auth/login accepts unlimited attempts.
Attack: Credential stuffing — test 10 million leaked password/email combinations.
        At 100 requests/second: 10 million combinations tested in ~27 hours.
        Breached accounts from other sites validated against your app.
Fix: WAF rate limit: 5 attempts/IP/minute. Exponential lockout after failures.
     CAPTCHA after 3 failures. Account lockout after 10.

MISTAKE 10: Not checking token audience (aud) claim
─────────────────────────────────────────────────────
What happens: Token issued for Service A (aud: "service-a") accepted by Service B.
Attack: Token theft from one service → replay at different service with broader permissions.
        Service A might have read-only scope. Service B has write scope.
        Same token works on both if aud is not checked.
Fix: Every service validates aud === its own expected audience string.
     jwt.verify(token, key, { audience: 'https://api.invoiceflow.com/invoices' })
```

---

## SECTION 11 — Quick Revision

### 10 Core Takeaways

```
1. Authentication = who you are. Authorization = what you can do.
   Sequential, not interchangeable. Both required on every sensitive operation.

2. OWASP Broken Access Control is #1 since 2021 — IDOR is its most common form.
   Check for it in every code review: WHERE resource_id = $1 AND user_id = $2.

3. Never trust the frontend for authorization.
   Hidden UI elements are UX. Backend checks are security. You need both.

4. JWT: validate ALL five — signature, expiry, issuer, audience, algorithm.
   Missing any one creates a forgeable or replayable token.

5. Store JWT in HttpOnly cookies, not localStorage.
   XSS + localStorage = instant token theft + account takeover.
   XSS + HttpOnly = XSS is bad but token theft is blocked.

6. Return 404 (not 403) for unauthorized resource access.
   403 reveals existence. 404 reveals nothing. Silence is security.

7. Mass assignment is privilege escalation — always use field allowlists.
   Never Object.assign(user, req.body). Be explicit about what is updateable.

8. Short-lived access tokens (15 min) + DB-backed refresh tokens.
   Limits token theft window. Enables revocation on logout/password change.

9. Multi-tenant: tenant_id in EVERY query.
   Not just at authentication. Every database read/write includes tenant boundary.

10. Rate limit and monitor authentication endpoints.
    5 login failures/minute → lockout + alert. This is your credential stuffing defense.
```

### 30-Second Interview Explanation

> "Authentication verifies identity — did this user prove they are who they claim? Authorization verifies access — does this confirmed identity have permission for this specific resource and action? The most critical mistake I see is implementing authentication correctly and then forgetting authorization at the resource level. An authenticated user calling GET /invoices/12345 should only get that invoice if it belongs to them — that's the authorization check. Broken access control — IDOR specifically — is OWASP's number one vulnerability since 2021 because developers habitually add authentication and skip ownership checks. Defense requires: ownership in the database query, non-sequential IDs, short-lived JWTs in HttpOnly cookies, and returning 404 (not 403) for unauthorized resource access."

### Memory Tricks

```
AuthN vs AuthZ:
  AutheNtication = "N" = kNow who you are
  AuthoriZation  = "Z" = last check (Z = end of the alphabet = final gate)

IDOR defense — "OWN IT":
  O — Ownership check in query (WHERE user_id = $currentUser)
  W — 404 (not 403) on unauthorized access
  N — Non-sequential IDs (UUIDs)
  I — Idempotent tenant boundary in every query
  T — Token contains userId (verify claims match resource)

JWT claim checklist — "SEAIE":
  S — Signature (verify with public key)
  E — Expiry (exp > now)
  A — Algorithm (whitelist RS256 — never 'none')
  I — Issuer (iss === expected URL)
  E — Audience (aud === this service)

Token storage — "HIS":
  H — HttpOnly cookie: BEST (JS cannot read)
  I — In-memory JS variable: OK (lost on refresh, XSS still possible)
  S — sessionStorage/localStorage: NEVER for auth tokens
```

---

## SECTION 12 — Security Thinking Exercise

### Vulnerability Scenario: MedBook Clinic Management System

**Context:**

MedBook is a SaaS platform for medical clinics. Features:

- Patients book appointments and view their own records
- Doctors view and update patient medical records for their clinic
- Clinic Admins manage their clinic's doctors and billing
- Platform Admins (MedBook staff) can access all clinics

**Current implementation excerpt:**

```javascript
// Appointment booking and retrieval
router.get("/appointments/:id", verifyJWT, async (req, res) => {
  const appointment = await db.query(
    "SELECT a.*, p.name as patient_name, p.dob, p.medical_history, " +
      "d.name as doctor_name, c.name as clinic_name " +
      "FROM appointments a " +
      "JOIN patients p ON a.patient_id = p.id " +
      "JOIN doctors d ON a.doctor_id = d.id " +
      "JOIN clinics c ON d.clinic_id = c.id " +
      "WHERE a.id = $1",
    [req.params.id],
  );
  if (!appointment) return res.status(404).json({ error: "Not found" });
  return res.json(appointment);
});

// Doctor updates patient medical record
router.patch("/records/:patientId", verifyJWT, async (req, res) => {
  const updates = req.body;
  await db.query("UPDATE patient_records SET ? WHERE patient_id = $1", [
    updates,
    req.params.patientId,
  ]);
  return res.json({ success: true });
});

// Role stored in JWT — issued at login
// JWT payload: { sub: "user_123", role: "doctor", clinic_id: "clinic_456" }

// Appointment IDs: appt_1, appt_2, appt_3 (sequential integers)
```

**Before reading the solution below — analyze these risks:**

1. What can an authenticated patient exploit in the first endpoint?
2. What can an authenticated doctor exploit in the second endpoint?
3. What single action makes both exploits trivially easy to automate?

---

### Analysis: How an Attacker Exploits This

```
VULNERABILITY 1 — GET /appointments/:id (Patient perspective)

ATTACKER: Registered patient. Valid JWT. Role: "patient".

Exploit:
  Appointment IDs are sequential: appt_1, appt_2...appt_50000.
  No ownership check in the query.

  for n in range(1, 50000):
    GET /appointments/appt_{n}
    → response includes: other patients' names, dates of birth,
      full medical history, doctor name, clinic name

What is leaked:
  • Patient names + DOB + medical_history (complete PHI)
  • Medical conditions (HIV, cancer, mental health diagnoses)
  • Which doctor a patient sees and at which clinic

Legal exposure:
  HIPAA: minimum fine $100 per record. Willful neglect: $50,000 per record.
  50,000 records: up to $2.5 BILLION in fines (willful neglect category).
  Class action from patients (particularly those with sensitive diagnoses exposed).
  State medical board investigation of affiliated clinics.
  Loss of Medicare/Medicaid billing rights.
```

```
VULNERABILITY 2 — PATCH /records/:patientId (Doctor perspective)

ATTACKER: Registered doctor. Valid JWT. Role: "doctor". clinic_id: "clinic_456".

Exploit A — Cross-clinic access:
  Doctor at Clinic 456 patches records for patients at Clinic 789.
  No check that this doctor treats this patient.
  PATCH /records/patient_999 { "diagnosis": "MODIFIED", "notes": "tampered" }
  Medical records altered without clinical relationship.
  Patient care endangered.

Exploit B — Mass assignment:
  Patient records table includes: { notes, diagnosis, billing_code, insurance_id }
  But also: { is_archived, patient_user_id, access_level }

  PATCH /records/patient_123 { "access_level": "platform_admin", "patient_user_id": "attacker_id" }
  If no allowlist: doctor reassigns patient record to themselves, escalates access.

WHY BOTH EXPLOITS WORK AUTOMATICALLY:
  Sequential IDs: enumerate valid targets in O(N) time.
  No ownership/relationship check: once a valid target ID is found, the operation succeeds.
  Mass assignment: req.body directly into UPDATE query — no field restriction.
```

---

### Why the System Failed

```
FAILURE 1: No resource ownership / relationship check
  Authentication (JWT) was present. Authorization was absent.

  The system confirmed the user is logged in.
  It never asked: "Is this appointment related to this user?"
  Patient → should see ONLY their own appointments.
  Doctor → should see ONLY appointments for patients under their care in their clinic.

FAILURE 2: Sequential appointment IDs
  Sequential integers make enumeration trivial.
  Attacker doesn't need to guess IDs — they are perfectly predictable.
  UUID or opaque random IDs increase effort by 2^128-fold.

FAILURE 3: Mass assignment in PATCH endpoint
  UPDATE SET <whatever the body contains> = no field allowlist.
  Database fields that should never be externally settable are exposed.

FAILURE 4: No rate limiting or anomaly detection
  50,000 sequential requests from one account → no alert, no block.
  Medical platforms must detect and alert on: >20 patient records accessed/hour by
  the same account (beyond their patient panel size).

FAILURE 5: Medical history returned in appointment response
  Principle of least privilege violated:
  appointment data should be: date, time, doctor name, status.
  medical_history should NOT be embedded in appointment response.
  Sensitive PHI should require an explicit separate request with its own auth check.
```

---

### Correct Secure Design

```javascript
// FIXED: GET /appointments/:id
router.get("/appointments/:id", verifyJWT, async (req, res) => {
  const userId = req.user.sub;
  const userRole = req.user.role;
  const userClinicId = req.user.clinic_id;

  // Fetch appointment basics (no medical history embedded)
  const appointment = await db.query(
    `SELECT a.id, a.appointment_date, a.status,
            d.name as doctor_name, c.name as clinic_name,
            a.patient_id, a.doctor_id
     FROM appointments a
     JOIN doctors d ON a.doctor_id = d.id
     JOIN clinics c ON d.clinic_id = c.id
     WHERE a.id = $1`,
    [req.params.appointmentId],
  );

  if (!appointment) return res.status(404).json({ error: "NOT_FOUND" });

  // Authorization: role-based ownership check
  const isOwningPatient =
    userRole === "patient" && appointment.patientId === userId;
  const isTreatingDoctor =
    userRole === "doctor" &&
    appointment.doctorId === userId &&
    appointment.clinicId === userClinicId;
  const isClinicAdmin =
    userRole === "clinic_admin" && appointment.clinicId === userClinicId;
  const isPlatformAdmin = userRole === "platform_admin";

  if (
    !isOwningPatient &&
    !isTreatingDoctor &&
    !isClinicAdmin &&
    !isPlatformAdmin
  ) {
    return res.status(404).json({ error: "NOT_FOUND" });
    // 404 — not 403 — never confirm the appointment exists to unauthorized users
  }

  // Medical history: separate call, stricter authorization
  // Only the patient themselves or their treating doctor can fetch medical_history
  // Not embedded in every appointment response

  return res.json({
    id: appointment.id,
    date: appointment.appointmentDate,
    status: appointment.status,
    doctor: appointment.doctorName,
    clinic: appointment.clinicName,
    // medical_history: NEVER included here — separate endpoint
  });
});

// FIXED: PATCH /records/:patientId
const UPDATABLE_RECORD_FIELDS = [
  "notes",
  "diagnosis",
  "treatment_plan",
  "prescriptions",
];

router.patch("/records/:patientId", verifyJWT, async (req, res) => {
  const { patientId } = req.params;
  const doctorId = req.user.sub;
  const doctorClinicId = req.user.clinic_id;

  // Verify clinical relationship: this doctor treats this patient at their clinic
  const relationship = await db.query(
    `SELECT 1 FROM doctor_patient_relationships dpr
     JOIN doctors d ON dpr.doctor_id = d.id
     WHERE dpr.doctor_id = $1 
       AND dpr.patient_id = $2
       AND d.clinic_id = $3
       AND dpr.is_active = true`,
    [doctorId, patientId, doctorClinicId],
  );

  if (!relationship) {
    return res.status(403).json({
      error: {
        code: "NO_CLINICAL_RELATIONSHIP",
        message: "You are not the treating physician for this patient",
      },
    });
    // 403 here is appropriate: doctor knows they have patients — not info leak
  }

  // Allowlist: only clinical fields updatable, never system fields
  const allowedUpdates = {};
  for (const field of UPDATABLE_RECORD_FIELDS) {
    if (req.body[field] !== undefined) allowedUpdates[field] = req.body[field];
  }

  if (Object.keys(allowedUpdates).length === 0) {
    return res.status(400).json({ error: { code: "NO_VALID_FIELDS" } });
  }

  // Audit log: every record modification logged (HIPAA requirement)
  await auditLog.write({
    actor_id: doctorId,
    actor_role: "doctor",
    action: "UPDATE_PATIENT_RECORD",
    resource_id: patientId,
    fields_modified: Object.keys(allowedUpdates),
    timestamp: new Date().toISOString(),
    clinic_id: doctorClinicId,
  });

  await db.query("UPDATE patient_records SET $fields WHERE patient_id = $1", [
    allowedUpdates,
    patientId,
  ]);

  return res.json({ success: true });
});

// STRUCTURAL FIXES:
// 1. Appointment IDs: UUID (not sequential integer)
//    appt_3f8a9b2c... not appt_1, appt_2
//
// 2. Rate limiting on record access:
//    > 50 distinct patient records/hour by one doctor → alert, log, review
//
// 3. Medical history: separate endpoint with dedicated authorization
//    GET /patients/:id/medical-history
//    Requires explicit treating-doctor or patient-owner relationship check
//
// 4. Platform admin access: requires separate JWT from separate auth flow
//    Regular doctor JWT cannot access platform admin endpoints
//    Even if someone changes their role claim — separate auth service issues the JWT
```

---

_End of Topic 01: Authentication vs Authorization_
