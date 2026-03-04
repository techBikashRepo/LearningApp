# Architecture Decision Records (ADR)

## FILE 02 OF 03 — ADR Patterns in Practice: Multiple Worked Examples, Lifecycle & Anti-Patterns

> **Architect Training Mode** | Principal Engineer & Interview Panelist Perspective
> _One ADR teaches you the format. Multiple ADRs teach you when to apply it. Seeing bad ADRs teaches you what it looks like when the format is followed but the thinking isn't._

---

## SECTION 5 — Real World Example

```
# ADR-007: Use SQS Queue Between API Service and Order Processor

## Status
Accepted

## Date
2024-04-10

## Context
  The API service receives HTTP POST /orders requests from clients.
  Originally, the API service called the order processor synchronously via HTTP.

  Problem observed in load testing:
    - Order processing takes 800ms–3,000ms (payment gateway + inventory check + email).
    - At 200 concurrent orders: the API service had 200 threads blocked waiting.
    - Client timeout set at 5s. Payment gateway P99 at 2,800ms.
      Under load: gateway latency spiked to 6,000ms → clients saw timeouts.
    - The API layer and the processing layer were failure-coupled: payment gateway
      slowness caused API 504 errors, even though the gateway was not "down."

  The team needs to decouple order acceptance from order processing to:
    1. Reduce client-visible latency (accept fast, process async).
    2. Isolate API availability from processing component failures.
    3. Provide natural backpressure when processing is slow.

## Decision
  Introduce an SQS Standard Queue between the API service and Order Processor.
  The API service writes the order to DB + enqueues an SQS message in a single transaction.
  The Order Processor consumes from SQS, processes independently of API request lifecycle.
  Client response: HTTP 202 Accepted + order_id. Client polls /orders/{id}/status.

## Options Considered

  ### Option A: SQS Standard Queue ← CHOSEN
  + Managed AWS service. No operational overhead (no Kafka cluster to manage).
  + At-least-once delivery guarantees. Message retention up to 14 days.
  + Scales to 120,000 msg/s without configuration changes.
  + Visibility timeout allows "borrowing" messages — if processor crashes mid-job,
    message becomes visible again for another worker automatically.
  + Dead Letter Queue (DLQ) support: messages that fail 3× route to DLQ.
    Ops team is alerted. Message is not lost.
  - At-least-once: processors must be idempotent. If message is delivered twice,
    processing it twice must be safe.
  - No strict ordering (Standard Queue). For orders: ordering not required.
    Each order is independent.
  - Cannot replay past messages (unlike Kafka). After the retention window: gone.

  ### Option B: Kafka (MSK) ← NOT CHOSEN
  + Durable log — messages replay indefinitely (configurable retention).
  + Consumer groups: multiple processing pipelines consume the same events independently.
  + Strict ordering within partition.
  - Requires dedicated Kafka cluster (MSK). Operational overhead: broker management,
    partition rebalancing, consumer group lag monitoring, offset management.
  - Team has zero Kafka operational experience. MSK is significantly more complex to debug.
  - Current throughput (200 orders/min peak) is drastically over-engineered for Kafka.
    Kafka makes sense at millions of events/minute.
  - We don't need replay today. If analytics requires it in the future: can add
    a separate event stream (CloudWatch Events or EventBridge) for analytics consumers.

  ### Option C: Direct HTTP (Current State) ← NOT CHOSEN (baseline, rejected)
  - Failure coupling: payment gateway slowness causes API timeouts.
  - No backpressure: API accepts requests faster than they can be processed.
  - No retry: if processor crashes mid-order, order stays in unknown state.
  - All latency components are in the critical path for API response time.

  ### Option D: AWS EventBridge ← NOT CHOSEN
  + Event routing, filtering, fan-out to multiple targets.
  - Not designed as a work queue. No visibility timeout, no DLQ, no at-least-once retry.
  - Better for event broadcasting, not for task processing.
  - Adds an abstraction layer that isn't needed for this single-consumer use case.

## Consequences

  ### Positive
  - API P99 response time drops from 3,000ms to ~50ms (just DB write + SQS publish).
  - Order Processor failures no longer surface as API errors.
    API returns 202 regardless of processor state.
  - Natural backpressure: if processor is slow, queue depth grows.
    Queue depth is now a real operational metric. Add CloudWatch alarm on queue depth > 1,000.
  - Retry is free: SQS retries automatically. DLQ catches persistent failures.

  ### Negative / Accepted Risk
  - Order creation is eventually consistent. Client gets 202, not 201.
    Some clients may poll /status repeatedly — need to document this in API design.
  - Order Processor MUST be idempotent. Duplicate SQS messages (rare but possible)
    must not create duplicate orders. Idempotency key = order_id on DB insert.
  - Net-new debugging complexity: "why is my order stuck?" now requires checking
    SQS queue depth, DLQ contents, and processor logs. Previously: one component.
    Operational runbook required. (See "SQS debugging playbook" in ops docs.)

  ### Neutral
  - Client flow changes: create → 202 → poll status. Frontend must be updated.
  - Integration tests must account for async: tests use polling or mock SQS locally.

## Revisit Condition
  If the team adds a second downstream consumer that also needs order events:
  evaluate replacing SQS with SNS fan-out → multiple SQS queues (one per consumer).
  If analytics team needs to replay historical orders: evaluate adding EventBridge
  Pipes or Kinesis Data Streams as a parallel event stream for the analytics use case.
```

---

## SECTION 6 — System Design Importance

```
# ADR-009: Use JWT Access Tokens + Refresh Token Rotation

## Status
Accepted

## Date
2024-05-03

## Context
  The platform needs to authenticate API requests from:
    1. Web browser (SPA) — users logged in via email/password.
    2. Mobile apps (iOS/Android) — same user authentication flow.
    3. Service-to-service — internal microservices calling each other.

  Current state: no auth system. All API endpoints are unprotected.
  This must be resolved before the first public beta.

  Constraints:
  - The auth service is being built from scratch (not using a third-party like Auth0 initially).
  - All clients (web + mobile) must support token refresh without re-login.
  - Session state must not be stored server-side (team wants stateless API scaling).
  - Token compromise must be recoverable: compromised long-lived token must be revocable.

## Decision
  Use short-lived JWT access tokens (15-minute expiry) with opaque refresh tokens
  stored in the database. Refresh token rotation: each use issues a new refresh token
  and invalidates the previous one.

## Options Considered

  ### Option A: JWT Access + DB-Backed Refresh Tokens ← CHOSEN
  + Stateless access token verification: API services verify JWTs without DB lookup.
    Scales horizontally — no shared session store needed.
  + Short-lived access token (15 min): compromise window is small.
  + Refresh token stored in DB: allows forced logout (delete the refresh token record).
    Security incident response: revoke all refresh tokens for a user instantly.
  + Refresh token rotation detects theft:
    If a stolen token is used: the old (rotated) token is also presented.
    Server detects the family has been used twice → invalidates entire family.
  - DB lookup required on every refresh (every 15 min per user session).
    Acceptable: refresh is rare relative to API calls.
  - JWT revocation before 15-min expiry is not possible without a blocklist.
    Accepted: for most scenarios, 15 min is an acceptable window.

  ### Option B: Session Cookies + Server-Side Session Store ← NOT CHOSEN
  + Instant revocation: delete the session from Redis and the user is logged out globally.
  + No token management complexity on the client.
  - Requires session store (Redis): shared state that all API servers must reach.
    Horizontal scaling now has a shared dependency.
  - CSRF risk with cookie-based auth for browser clients requires additional mitigation.
  - Mobile clients have no convenient cookie store — every iOS/Android client needs
    custom cookie persistence logic.

  ### Option C: API Keys (long-lived static tokens) ← NOT CHOSEN
  + Simple. Clients include key in header. No expiry handling.
  - No expiry = permanent compromise window.
    A leaked API key is compromised until manually rotated.
  - Acceptable only for service-to-service with no user identity.
    Not suitable for user-facing authentication.

  ### Option D: Auth0 / Cognito (managed identity provider) ← DEFERRED
  + Eliminates auth service build entirely. Token management, MFA, social login included.
  + Compliance certifications (SOC2, ISO27001) provided by the provider.
  - Cost: Auth0 pricing at 5M users ≈ $X/month (significant at scale).
  - Dependency: platform auth depends on a third-party. Outage = platform login down.
  - For beta with <10,000 users: the cost is fine but the migration complexity is nonzero.

  DECISION: Build JWT in-house for beta. Migrate to managed identity provider
  (Cognito or Auth0) when the team exceeds 5 engineers with auth ownership,
  or when compliance certification is required (SOC2 audit).
  This is the condition for Revisit, codified into ADR-009.

## Consequences

  ### Positive
  - Stateless verification: API services scale horizontally without shared auth state.
  - 15-min access token: even if token extracted from memory, 15-min window limits exposure.
  - Full revocation capability via refresh token DB record deletion.

  ### Negative / Accepted Risk
  - Mobile clients must implement token refresh logic. This is non-trivial.
    iOS and Android implementations will need testing and maintenance.
  - 15-min JWT expiry requires client-side refresh logic (transparent re-auth).
    If the client fails to refresh, the user sees a 401 and may be confused.

## Revisit Condition
  If the team exceeds 5 engineers owning auth-related code: evaluate Cognito or Auth0.
  If a SOC2 audit is required: managed identity provider is likely a prerequisite.
  If refresh token DB becomes a write bottleneck (>10,000 refreshes/minute): evaluate
  Redis-backed session store instead of PostgreSQL for refresh tokens specifically.
```

---

## SECTION 7 — AWS & Cloud Mapping

```
ANTI-PATTERN 1: The Announcement ADR

  # ADR-002: We Will Use Microservices

  ## Status: Accepted

  ## Decision
  The platform will be built using a microservices architecture.

  ## Context
  Microservices are the modern way to build scalable systems.

  ─────────────────────────────────────────────────────────────────────────────

  WHAT'S WRONG:
  × Context: "microservices are modern" is not context. What is the PROBLEM being solved?
    What constraints make microservices the right fit for THIS system?
  × No alternatives considered. Why not a modular monolith? Why not service-oriented?
  × No consequences. What does this commit the team to operationally?
  × No revisit condition. This will be treated as gospel permanently.
  × This reads like someone decided and then wrote the ADR to justify it,
    not to inform it.

ANTI-PATTERN 2: The ADR Written After The Ship

  # ADR-015: Use Redis for Caching
  Status: Accepted — Date: 2024-01-01

  ## Context
  We needed a fast cache. We added Redis.

  ## Decision
  Use Redis.

  ─────────────────────────────────────────────────────────────────────────────

  WHAT'S WRONG:
  × Written after implementation — this is documentation, not decision recording.
  × "We needed a fast cache" doesn't explain what alternatives were rejected.
  × No data: what's being cached? What is the expected hit rate? What's the TTL strategy?
  × What happens when Redis is unavailable? Is this on the hot read path?

  RULE: An ADR written after the decision has been implemented is better than no ADR,
  but the best time to write an ADR is BEFORE the implementation begins.
  The ADR should be the input to the "should we do this" conversation, not the paperwork after.

ANTI-PATTERN 3: The Strawman ADR

  ## Options Considered

  Option A: PostgreSQL ← CHOSEN
  + Excellent, well-understood, handles all our needs perfectly.

  Option B: MongoDB ← NOT CHOSEN
  + None. MongoDB is unsuitable for this use case.
  - Complex, unstructured, not ACID-compliant, difficult to query.

  ─────────────────────────────────────────────────────────────────────────────

  WHAT'S WRONG:
  × MongoDB has genuine strengths — listing none of them signals dishonesty.
  × "MongoDB is unsuitable for this use case" is a conclusion, not a reason.
    WHY is it unsuitable for THIS specific use case?
  × Reader learns nothing about when MongoDB WOULD be the right choice.
  × Any engineer who has used MongoDB will immediately lose trust in the document.

  RULE: Alternatives must be presented with genuine charity.
    If MongoDB were the right tool in a different context, that context should be named.
    The point of listing alternatives is to show you CONSIDERED them,
    not to prove you were never going to change your mind.

ANTI-PATTERN 4: The Decision-Free ADR

  ## Decision
  We need to determine the right approach for the caching layer.
  Several options are being evaluated and a decision will be made soon.

  ─────────────────────────────────────────────────────────────────────────────

  WHAT'S WRONG:
  × This is a problem statement, not a decision record.
  × An ADR with Status: Proposed is fine — but it should still state a PROPOSED decision.
    "We propose to use X pending review" or "We will do X unless Y objection arises."
  × An ADR without a clear decision is just a committee document.
```

---

## SECTION 8 — Interview Preparation

**Beginner:**

**Q: What is an ADR and what problem does it solve?**
**A:** An Architecture Decision Record is a short document capturing an important technical decision: what was decided, why, and what alternatives were considered. The problem it solves: six months after a decision, no one remembers WHY the codebase uses PostgreSQL instead of MongoDB, or WHY a microservice was split from the monolith. New engineers make the same mistakes, reverse the decision unknowingly, or spend hours reverse-engineering intent from code. ADRs preserve the reasoning, not just the outcome. They're short (1-2 pages), live in version control alongside code, and are never modified after acceptance â€” they're append-only history.

**Q: What are the key sections of a well-written ADR?**
**A:** A minimal ADR has: *Title:* ADR-0012: Use JWT for stateless auth. *Status:* Proposed / Accepted / Deprecated / Superseded. *Context:* The problem and constraints that forced a decision â€” why does a decision need to be made? *Decision:* What was decided, stated clearly and directly. *Consequences:* What becomes easier, what becomes harder, what risks are accepted â€” the trade-offs. Optional: *Alternatives considered* (why were other options rejected?). The document should be readable by someone joining the team 2 years later and leave them saying "I understand exactly why this was done."

**Q: When should you write an ADR vs when is it overkill?**
**A:** Write an ADR when: (1) The decision is hard to reverse (technology choice, database schema design, security architecture). (2) Multiple options were seriously considered. (3) The decision has significant long-term impact on the system. (4) Team members disagree and the decision needs documentation. (5) It involves external stakeholders (compliance, security review). Skip ADR for: routine implementation choices (which library for date formatting), low-stakes reversible decisions, very small projects where all context is in one person's head.

---

**Intermediate:**

**Q: What is an ADR "status" lifecycle and how does superseding work?**
**A:** ADR statuses: *Proposed* â€” decision drafted, under review. *Accepted* â€” decision made, in effect. *Deprecated* â€” still followed but being phased out. *Superseded* â€” replaced by a newer ADR. Critical rule: you NEVER edit an accepted ADR's decision. If you change the decision, write a new ADR that says "Supersedes ADR-0012" and update ADR-0012 status to "Superseded by ADR-0031." This preserves the full decision history â€” future engineers can see the original decision AND the new decision AND understand the evolution. The history is the value, not just the current state.

**Q: How do ADRs fit into a team's development process â€” when in the delivery lifecycle are they written?**
**A:** ADRs should be written BEFORE or DURING implementation, not after. Best practice: when a significant technical decision is needed, write the ADR as a draft/proposal, share with the team for review (can be a PR), discuss alternatives, finalize. Then implementation begins with the decision recorded. Writing ADRs retroactively is better than nothing but loses the "alternatives considered" value (you tend to rationalize the decision you already made rather than remembering what was genuinely considered). In sprint planning: add an ADR-writing task alongside any story that requires an architectural decision.

**Q: What is the difference between an ADR and an RFC (Request for Comments)?**
**A:** An RFC is a collaborative document used to gather input and reach consensus BEFORE a decision is made. It's a discussion document â€” typically longer, with open questions, explicit solicitation of feedback, and a comment period. Team votes or the tech lead accepts one option. An ADR records the decision AFTER it's been made (possibly through an RFC process). They often complement each other: the RFC process â†’ decision â†’ ADR recorded. Some teams use light-weight "ADR as RFC" â€” propose, review, accept in one document â€” which works well for smaller teams.

---

**Advanced (System Design):**

**Scenario 1:** Your team is deciding between three approaches for inter-service communication in your microservices platform: (1) synchronous REST APIs, (2) async messaging via SQS, (3) a service mesh with gRPC. Write the ADR structure for this decision as it would appear in your docs/adr/ folder.

*ADR-0024: Inter-Service Communication Protocol*

**Status:** Accepted (2024-03-15)

**Context:** 8 microservices need to communicate. Some calls require instant responses (inventory check during checkout). Others can be async (email after order placed). System needs to scale to 500 req/s peak. Current setup is ad-hoc REST with no consistency.

**Decision:** Adopt a hybrid approach: synchronous gRPC (via Envoy service mesh) for request-response flows requiring <500ms SLA; SQS for async/event-driven flows where the caller doesn't need an immediate response.

**Alternatives Considered:**
- REST-only: Simple but no streaming, no strict contracts, HTTP/1.1 overhead at scale.
- SQS-only: Can't handle synchronous flows (inventory check can't be async). Adds latency for user-facing requests.
- gRPC-only: Too complex for simple async notification use cases.

**Consequences:**
- (+) Consistent, typed contracts via protobuf. Better performance than REST.
- (+) Async flows decoupled, independently scalable.
- (-) Teams must learn gRPC and protobuf. Additional learning curve.
- (-) Service mesh adds operational complexity. Requires Envoy expertise.
- Risk: gRPC tooling less mature for Node.js than REST. Accepted given performance gains.

**Scenario 2:** A new junior engineer on your team argues: "ADRs are a waste of time â€” the code is the documentation." How do you respond, and can you think of a case where the engineer's view has merit?

*Response:* The code documents WHAT was built, not WHY choices were made. Code can't capture: why PostgreSQL was chosen over MongoDB (the rejected alternatives), why a particular security approach was selected (the compliance constraints at the time), or why the monolith wasn't split further (the team size constraint). When someone changes the ORM three years later, the code doesn't warn them that this ORM was selected specifically because it supports a database feature needed by the compliance module.

*When the engineer is right:* For obvious decisions, extensively documenting is overhead. If you chose Express.js for a simple API because "it's what everyone uses and it works," an ADR is overkill. ADRs are for decisions with real trade-offs, and it takes judgment to know which decisions those are. Balance: 5-10 meaningful ADRs per year per team is far more valuable than 100 trivial ones.

