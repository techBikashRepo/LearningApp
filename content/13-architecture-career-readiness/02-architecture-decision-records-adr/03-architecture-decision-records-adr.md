# Architecture Decision Records (ADR)

## FILE 03 OF 03 — Mock Exercise, Good vs Bad ADRs, Practice Rubric & ADR Mental Model

> **Architect Training Mode** | Principal Engineer & Interview Panelist Perspective
> _Writing ADRs is not a bureaucratic exercise. The act of writing an ADR — naming the alternatives, being honest about the downsides, naming the revisit condition — forces the precision that distinguishes architecture from guesswork._

---

## SECTION 9 — Certification Focus (AWS SAA)

```
THE SCENARIO:
  You are the backend tech lead for a B2B SaaS platform.
  The platform sends transactional emails (password resets, order confirmations, invoices)
  and also sends marketing emails (newsletters, feature announcements, campaigns).

  Current state: the application calls SendGrid's API directly for all emails.

  Problem has emerged:
    - On high-traffic days, the email API calls slow down the request path.
    - When SendGrid returns 429 (rate limit) or 503: email sending silently fails.
    - There is no retry. There is no visibility into failed emails.
    - The marketing team wants to send campaigns (up to 500,000 recipients at once).
      Currently impossible with the synchronous call pattern.
    - Post-incident review found: during last outage, 3,200 order confirmation emails
      were never sent. Customers called support. Revenue department raised a compliance flag.

  You have identified three options and need to write an ADR.

───────────────────────────────────────────────────────────────────────────

STEP 1: Write the Context (before you think about the decision)

  Look at the scenario. Ask yourself:
  - What problem exists? (Silent email failures, blocking request path)
  - What constraint is being violated? (3,200 lost emails = financial/legal compliance)
  - Who is affected? (Customers, marketing team, revenue department)
  - What is the scale of the problem and what's the target scale?
    (Transactional: ~5,000/day. Campaign: up to 500,000 at once.)
  - What can't you change? (Budget, team size, existing stack)

  Draft context:
  "The platform sends two categories of email: transactional (order confirmations,
   password resets: ~5,000/day) and marketing campaigns (up to 500,000 recipients).

   Currently, both categories are sent via synchronous SendGrid API calls in the
   HTTP request path. Three critical failures have been identified:
   1. Transactional emails are blocking the request path (adding ~80ms to order creation).
   2. SendGrid rate limit errors (429) and outages silently drop emails.
      No retry. No queue. No alerting. 3,200 emails were lost in last outage.
   3. Marketing campaigns cannot be sent — 500K synchronous API calls would timeout.

   A compliance review has flagged the lost transactional emails as a reporting risk.
   This decision must be resolved before Q3."

STEP 2: Define the Options (with genuine honest tradeoffs)

  Option A: Add an SQS Queue before the SendGrid call
  Option B: Move to a managed email platform (Customer.io or Klaviyo) with built-in queuing
  Option C: AWS SES + SQS (decouple from SendGrid, add queue)

  For each: list 3 real advantages and 2–3 real disadvantages.

STEP 3: Make the Decision and Write the Consequences

  What gets better? (No more silent failures, campaign support, async email)
  What gets worse? (New operational component to monitor, async means eventual delivery)
  What changes? (Client flow: no more synchronous email confirmation)

STEP 4: Write the Revisit Condition

  What would invalidate your choice?
  (SendGrid price increase, delivery rate drops below 99%, team builds in-house ESP)

───────────────────────────────────────────────────────────────────────────

COMPLETED ADR (model answer):

# ADR-014: Decouple Email Sending via SQS Queue in Front of SendGrid

## Status
Accepted

## Date
2024-07-18

## Context
  The platform sends transactional emails (~5,000/day) and marketing campaigns
  (up to 500,000 recipients). Both categories currently call SendGrid synchronously
  in the HTTP request path.

  Three production failures have been identified:
  1. Synchronous calls add ~80ms to order creation P99. Acceptable today but compounds
     as order volume grows.
  2. SendGrid 429 / 503 responses silently drop emails. No retry, no alerting, no DLQ.
     3,200 order confirmation emails were lost in the May 2024 incident.
     Revenue department flagged this as a compliance issue (email delivery audit trail required).
  3. Campaign sends are impossible synchronously. 500K API calls in one request would time out.

  Constraints:
  - Stack is AWS. SQS is already used for order processing (see ADR-007).
  - SendGrid contract is paid through EOY 2024. Cannot switch provider immediately.
  - Must maintain GDPR email preference compliance (opt-out must be respected at send time,
    not just at enqueue time).

## Decision
  Introduce SQS Standard Queue between the application and SendGrid.
  Transactional and campaign emails are enqueued as SQS messages.
  A dedicated Email Worker consumes the queue and calls SendGrid.
  SQS DLQ configured for messages failing after 3 attempts.
  CloudWatch alarm on DLQ depth > 0.

## Options Considered

  ### Option A: SQS + Existing SendGrid ← CHOSEN
  + Reuses SendGrid (no new vendor contract, existing template library preserved).
  + SQS DLQ ensures no email is silently dropped. Failed messages are observable.
  + Campaign support: campaign service enqueues 500K messages over time;
    Email Worker processes at rate within SendGrid limits.
  + Team already understands SQS from order processing (ADR-007). Low onboarding cost.
  - Email Worker is a new operational component. Needs monitoring, DLQ alerting.
  - Email delivery is now asynchronous: no instant confirmation that email was sent.
    The application records "EMAIL_QUEUED" not "EMAIL_SENT" until worker processes it.
  - SendGrid dependency remains. If SendGrid has extended outage: emails accumulate
    in queue. Queue depth becomes a leading indicator, which is better than silent drops.

  ### Option B: Managed Email Platform (Customer.io or Klaviyo) ← DEFERRED
  + These platforms include queueing, campaign scheduling, A/B testing, analytics.
  + Would eliminate the Email Worker: the platform handles delivery natively.
  + Better tooling for the marketing team (visual campaign builder).
  - Migration cost: all existing SendGrid templates must be rebuilt.
  - Contract switch mid-year would forfeit remaining SendGrid prepayment.
  - Over-engineered for the current transactional email volume.
  - Marketing team has not yet evaluated feature needs.
  REVISIT: if marketing team requests campaign analytics or A/B testing features:
  evaluate Customer.io or Klaviyo as a consolidated solution.

  ### Option C: AWS SES + SQS ← NOT CHOSEN NOW
  + AWS SES is ~90% cheaper than SendGrid at high volume (~$0.10/1K vs ~$1.00/1K).
  + Full AWS-native stack: IAM permissions, CloudWatch native integration.
  - SES requires domain verification and maintained sender reputation.
    A new SES sender with no reputation history risks landing in spam filters.
    Reputation takes 4–8 weeks to establish with warming schedule.
  - Existing SendGrid templates, bounce handling, and unsubscribe infrastructure
    would need to be rebuilt in SES.
  - Given SendGrid contract runs through EOY: migration is a Q1 2025 project.
  REVISIT: At SendGrid contract renewal, evaluate SES migration for cost savings.

## Consequences

  ### Positive
  - All email sending is fault-tolerant: no more silent drops.
  - Campaign sends are unblocked: enqueue messages at application speed,
    deliver at SendGrid API rate.
  - Delivery audit trail: every email message is logged (queued, sent, failed, dead-lettered).
    Compliance requirement met.
  - HTTP request path no longer blocked by email API latency.

  ### Negative / Accepted Risk
  - Email Worker is a new microservice to maintain, monitor, and scale.
    Responsibility: backend team. Runbook required for DLQ alerts.
  - Async delivery: order confirmation appears "sent" in UI before SendGrid receives it.
    Acceptable. The window is typically <5 seconds.
  - GDPR opt-out must be checked at dequeue time, not enqueue time.
    If a user unsubscribes between enqueue and delivery: the message must not be sent.
    Email Worker must check preference store before each send.

## Revisit Condition
  - At SendGrid contract renewal (EOY 2024): evaluate SES migration for cost savings.
  - If marketing team requests A/B testing or advanced campaign analytics: evaluate
    Customer.io or Klaviyo as a full platform replacement.
  - If Email Worker DLQ consistently >100 messages/day: investigate root cause
    before scaling workers (may indicate SendGrid rate limit misconfiguration).
```

---

## SECTION 10 — Comparison Table

```
PAIR 1: Choosing a Caching Strategy

  BAD ADR:
  Context: The app is slow. We need caching.
  Decision: Add Redis.
  Consequences: App will be faster.
  ─────────────────────────────────────────────────────────────────────────────
  PROBLEMS: What is slow? What is being cached? Why Redis over Memcached or in-process cache?
  What breaks when Redis is unavailable? How are cache invalidations handled?
  "App will be faster" is a marketing claim, not a consequence.

  GOOD ADR:
  Context: Product catalog API serves 95% of all traffic. P99 is 280ms.
    Query trace shows 240ms is a PostgreSQL full-catalog scan (12,000 products).
    Product data changes at most 3 times/week (catalog manager updates).
    Serving stale product data up to 10 minutes is acceptable.
  Decision: Cache product catalog in Redis with TTL=10min, explicit invalidation on
    admin write.
  Options: In-process cache (rejected — invalidation across ECS tasks impossible),
    CDN edge caching (rejected — requires public-readable API, auth requirements clash),
    Redis (chosen — shared cache, TTL-based, invalidation via cache key deletion).
  Consequences:
    + P99 drops from 280ms to ~15ms for cached reads.
    - Redis is a new required dependency. If Redis is unavailable: fall through to DB.
      DB must remain functional as fallback. Do not remove DB code path.
    - Cache stampede: if TTL expires and 500 workers request simultaneously, DB hit spikes.
      Mitigation: add random jitter to TTL (600s ± 60s).
  Revisit: If product catalog grows beyond 1M items or update frequency increases to
    daily or more: evaluate Redis as a write-through cache with event-driven invalidation.

───────────────────────────────────────────────────────────────────────────

PAIR 2: Auth Strategy Decision

  BAD ADR:
  Context: We need authentication.
  Decision: Use JWT because it's stateless and widely adopted.
  ─────────────────────────────────────────────────────────────────────────────
  PROBLEMS: Why is statelessness important HERE? What alternatives were considered?
  What is the token lifetime? How is revocation handled?
  "Widely adopted" is not a reason — every technology is "widely adopted" by someone.
  This ADR describes a preference, not a decision.

  GOOD ADR (extract):
  Decision: Short-lived JWTs (15 min) + opaque refresh tokens stored in PostgreSQL.
    Refresh token rotation with family invalidation on reuse detection.
  Context maps the problem to the constraints:
    Team is building auth from scratch. 3 client types (web, iOS, Android).
    No shared session store. Token revocation required for incident response.
  Options: Server-side sessions (rejected — shared Redis dependency across all services),
    Long-lived JWTs (rejected — 15-min compromise window acceptable; 30-day is not),
    Auth0 (deferred — migrate when compliance certification is required).
  Consequences (honest):
    - Mobile clients must implement refresh logic. Non-trivial. Testing required.
    - 15-min JWT cannot be revoked before expiry without a blocklist.
      Accepted for most scenarios. For high-security operations (admin actions):
      re-authentication required at the action level.
```

---

## SECTION 11 — Quick Revision

```
THE CHALLENGE:
  "You are joining a team that built a monolithic Node.js Express application.
   The application handles: user authentication, product catalog, order processing,
   payment integration, email notifications, and admin dashboard.

   The team is experiencing these problems:
   - Deploy frequency is low because any change requires full regression testing.
   - The payment integration code has a bug that causes the entire app to restart.
   - Two new engineers want to add a 'Reviews and Ratings' feature but are blocked
     by tight coupling in the product catalog module.
   - The database has 50 tables and no clear ownership or access boundaries.

   The CTO says: 'We need to consider microservices.'

   Write the ADR for this architectural decision."

WHAT TO TRY ON YOUR OWN:
  1. Write the Context section. What is the real problem? (Hint: it's not "we need microservices.")
  2. List at least 3 options (not just monolith vs microservices — there's a spectrum).
  3. Write honest pros and cons for each option.
  4. Write the Decision with the reasoning tied to the specific constraints.
  5. Write the Consequences — including what gets HARDER.
  6. Write the Revisit Condition.

───────────────────────────────────────────────────────────────────────────

FEEDBACK RUBRIC:

STRONG ANSWER (passes staff-level bar):
  ✅ Context does NOT say "we need microservices." It describes the specific problems:
     deploy coupling, blast radius from payment bug, feature contention in product catalog.

  ✅ Options include the FULL SPECTRUM:
     - Monolith as-is (status quo, rejected with reasons)
     - Modular monolith (strong boundaries, deploy via feature flags or separate artifacts)
     - Strangler Fig (extract services one at a time from current monolith)
     - Full microservices decomposition (8–12 services from day one)
     - Micro-frontends + backend-for-frontend (separate frontend complexity)

  ✅ Decision is targeted at the actual pain:
     "We will extract payment service first (blast radius isolation).
      We will modularize catalog internally (clear ownership) before splitting.
      Full microservices: only if team grows to 6+ or there is a demonstrated
      independent scaling need."

  ✅ Consequences include the hard truths:
     "Distributed systems add operational complexity. The team currently has zero
      Kubernetes or service mesh experience. Premature decomposition adds risk."

  ✅ Revisit condition is concrete:
     "Revisit full microservices split if team exceeds 6 engineers with clear domain
     ownership, or if two services have proven independent scaling requirements."

PARTIAL ANSWER (passes senior bar, not staff):
  ⚠️ Context identifies the problems but frames it as "we need microservices" prematurely.
  ⚠️ Options listed: monolith vs microservices only (missed the spectrum in between).
  ⚠️ Decision made for full decomposition without addressing team skill gap.
  ✗ Does not address migration strategy: how do you get from monolith to microservices?
  ✗ Revisit condition: vague ("when we need it").

WEAK ANSWER (needs improvement):
  ✗ Context section is one sentence: "We need to migrate to microservices."
  ✗ No alternatives seriously considered — "microservices vs monolith" strawman.
  ✗ Decision: "We will use microservices architecture."
  ✗ Consequences: only positive outcomes listed. No mention of operational complexity.
  ✗ No revisit condition.

  WHAT THIS LOOKS LIKE IN PRODUCTION:
    The team decouples into 12 services. Each service calls 5 others synchronously.
    Any one service down: cascading failure.
    The team spends 60% of time on distributed system debugging instead of features.
    18 months later: Paul (the only person who knew why this was done) has left.
    Nobody can find the context for why each service exists. No ADRs.
```

---

## ADR MENTAL MODEL

```
5 QUESTIONS BEFORE YOU WRITE AN ADR:
  1. Can I explain this decision to someone on day one, without verbal help?
     If not → write the ADR. The context isn't obvious.

  2. Is this decision hard to reverse without significant cost?
     If yes → write the ADR. The cost of reversal justifies the context.

  3. Am I departing from the common/expected approach?
     If yes → write the ADR. Future engineers need to know WHY.

  4. Does my team agree on this decision or are there competing views?
     If competing views exist → write the ADR. The review process resolves it formally.

  5. Will someone change this decision in 18 months without knowing why it was made?
     If yes → write the ADR. The historical record prevents the context-free reversal.

3 MISTAKES ARCHITECTS MAKE WITH ADRs:
  MISTAKE 1: Write the ADR after implementing to document the choice.
    → ADR becomes archaeology, not reasoning. The ship has sailed.
    → Write the ADR first. Use the ADR review to challenge the decision before building.

  MISTAKE 2: Never mark ADRs as Superseded.
    → System evolves. ADRs don't. Engineers follow outdated ADRs as if they're law.
    → Assign an owner for regular ADR review. At least quarterly: check Revisit Conditions.

  MISTAKE 3: Write ADRs for obvious decisions to "look thorough."
    → "ADR-022: Use async/await instead of callbacks."
    → This devalues the ADR system. Engineers stop reading them because they stop mattering.
    → Reserve ADRs for decisions where the non-obvious choice was made, or where
      two real alternatives existed with genuine tradeoffs.

30-SECOND EXPLANATION:
  "What are ADRs and why does your team use them?"

  STRONG ANSWER:
  "An ADR is a document that records a major architectural decision alongside
   the context that drove it, the alternatives we considered, and the known
   tradeoffs we accepted.

   We use them because code doesn't explain itself at the architectural level.
   Six months from now, a new engineer reading our code can see WHAT we built —
   but not WHY we chose PostgreSQL over DynamoDB, or why we use SQS instead of
   direct HTTP. ADRs are the 'why' layer that sits alongside the 'what.'

   They also make post-incident reviews faster: we can ask 'did we know this
   was a risk when we made this decision?' and actually look it up."

─────────────────────────────────────────────────────────────────────────────

QUICK REFERENCE: ADR STATUS CODES

  Proposed     → Draft. Under review. Not yet binding.
  Accepted     → Active. The system implements this decision.
  Deprecated   → The decision is no longer followed but not formally superseded yet.
  Superseded   → A new ADR makes a different decision. This becomes historical record.

QUICK REFERENCE: FIELDS THAT SEPARATE GOOD FROM BAD ADRs

  Context:   Tells a story. Explains what would have happened if no decision was made.
  Options:   Lists real alternatives with honest tradeoffs. Not strawmen.
  Decision:  One sentence. Active voice. "We will use X." Not "X was evaluated."
  Negative:  Lists what gets WORSE. Every choice has a downside. Name it.
  Revisit:   Specific, testable trigger. Not "when needed."
```
## SECTION 12 — Architect Thinking Exercise

**Scenario:**
Your team is building a new notification service. You need to decide between:
- **Option A**: Direct API calls from each service to send notifications (push model)
- **Option B**: Event-driven with SQS/SNS â€” services publish events, notification service consumes them (pub-sub model)

The tech lead says "just use direct API calls, it's simpler." You disagree and want to document this as an ADR.

**Think before reading the solution:**
- What decision factors would you include in the ADR?
- What are the consequences (positive and negative) of each option?
- How do you frame the recommendation without dismissing the tech lead's concern?

---

**Architect's Solution â€” ADR Template:**

`markdown
# ADR-007: Notification Service Communication Pattern

## Status: Accepted

## Context
We are building a centralized notification service (email, SMS, push) consumed by 
8 microservices. Each service needs to trigger notifications from its own business logic.
Current load: ~50K notifications/day, expected to 10x in 12 months.

## Decision
We will use asynchronous event-driven communication via SQS (pub-sub) rather than 
synchronous direct API calls.

## Consequences

**Positive:**
- Decoupled: notification service outage does not affect calling services
- Retry handling: SQS provides automatic retry with exponential backoff
- Scalability: consumer can scale independently based on queue depth
- Auditability: SQS provides a durable message log

**Negative:**
- Added complexity: developers must understand async patterns
- Eventual delivery: notifications may be delayed by seconds (acceptable)
- Infrastructure cost: SQS + DLQ setup required

## Alternatives Considered
Direct API calls rejected because: a single notification service outage would cascade 
to all 8 upstream services; no built-in retry; harder to add new notification channels later.

## Review Date: 2025-Q1
`

**Why this matters for your career:**
ADRs show you can communicate technical decisions in writing. Senior engineers who write ADRs get promoted because they create institutional knowledge. Start writing ADRs even for small decisions.
