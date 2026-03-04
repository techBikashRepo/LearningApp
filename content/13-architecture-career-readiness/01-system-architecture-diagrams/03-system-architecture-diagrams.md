# System Architecture Diagrams

## FILE 03 OF 03 — Mock Interview, Good vs Bad Examples, Practice Exercise & Architect's Mental Model

> **Architect Training Mode** | Principal Engineer & Interview Panelist Perspective
> _Theory without practice is just vocabulary. Practice without a rubric is just guessing. This file turns concepts into skills._

---

## SECTION 9 — Certification Focus (AWS SAA)

```
THE QUESTION (you will receive something like this):
  "Design a URL shortening service like bit.ly.
   Target scale: 200 million stored URLs, 10 billion redirects per month.
   Users expect < 100ms redirect latency. The system needs 99.99% availability."

DO NOT answer immediately. First, clarify:

  YOU: "Before I start, a few quick questions.

        Read/write ratio: I'm assuming this is very read-heavy —
        mostly redirects with some new URL creation. Is that right?

        Is analytics important? (click tracking, geography, device)
        That changes the data model significantly.

        Do we need custom aliases? Or just machine-generated short codes?

        Geographic distribution? 10B redirects/month with < 100ms globally
        means CDN or multi-region. Should I design for global?"

  INTERVIEWER: "Yes, 100:1 read/write ratio. Analytics: yes but can be eventual.
                Custom aliases: nice to have. Let's start with single-region
                and you can explain how you'd extend to global."

NOW WALK THE DESIGN — 5 STEPS:

STEP 1: Restate the problem (30 seconds):
  "We're building a URL shortener. Core operations: create a short URL,
  redirect a short code to a long URL. The dominant concern is redirect latency
  (< 100ms) at 10 billion reads/month. We can tolerate eventual consistency
  for analytics but the redirect path must be reliable."

STEP 2: Estimation to validate the architecture:
  "10B redirects / month ÷ 30 days ÷ 86,400 s = ~3,858 RPS average.
   Peak is probably 3–5× = ~15,000 RPS peak.

   200M URLs × 500 bytes (short code + long URL + metadata) = 100 GB total.
   100 GB fits in a single PostgreSQL instance easily.
   But 15,000 redirects/s is too hot for a single DB —
   so the redirect path needs a cache layer."

STEP 3: Happy path diagram (speak while drawing):

  [User] → [Load Balancer] → [API Service (ECS)] → [Redis Cache] ──✓──→ [Redirect 302]
                                                         ↓ cache miss
                                                    [PostgreSQL RDS]

  Components:

  A. CLIENT:
     User's browser requests: GET https://short.ly/xK92mP

  B. LOAD BALANCER (ALB):
     Routes to API service instances. Health checks. Terminates TLS.

  C. API SERVICE:
     Two endpoints:
     POST /shorten: generate short code, write to DB, invalidate nothing (new record).
     GET /{code}: look up short code in Redis. If miss, look up in DB, populate Redis.
                  Return HTTP 302 redirect to long URL.

  D. REDIS (ElastiCache):
     Key: short_code (e.g., "xK92mP")
     Value: long URL string
     TTL: 24 hours (refreshed on access for hot URLs)
     Size: If top 1% of 200M = 2M hot URLs × ~200 bytes = 400 MB → trivially fits in Redis.

  E. POSTGRESQL (RDS):
     urls table: (id, short_code, long_url, created_at, created_by, click_count)
     Index on short_code (very fast lookup).
     Read replica for analytics queries (so they don't hit the write primary).

STEP 4: Key decisions (name the tradeoffs):

  DECISION 1: HTTP 301 vs HTTP 302 for redirects
    301 = Permanent. Browser caches it. Reduces server load.
    302 = Temporary. Browser always asks server. Enables click analytics.
    WE CHOSE: 302. Analytics is a requirement. 301 would make click tracking impossible.
    COST: More traffic hits our servers. Mitigated by Redis cache.

  DECISION 2: Short code generation — random vs counter-based
    Counter-based (encode integer in base62): simple, sequential, no collision.
    Downside: predictable — someone can enumerate all URLs by incrementing counter.
    Random base62 (6 chars): 62^6 = 56 billion combos. Collision-check on insert.
    WE CHOSE: Counter-based with a separate "code generation service" that pre-allocates
    ranges. The IDs are non-sequential at the user level because base62 encoding scrambles them.

  DECISION 3: Where to record analytics
    Synchronous in the redirect path: adds latency. Bad.
    Write to Kafka on every redirect: asynchronous. Analytics worker consumes.
    WE CHOSE: Emit a lightweight event to SQS on redirect. Analytics worker batches inserts
    into a separate analytics DB. Redirect path is not blocked by analytics write.

STEP 5: Failure cases:

  "What if Redis is down?"
    → Fall through to PostgreSQL. Latency increases from ~5ms to ~15ms.
      Still under 100ms SLA. Acceptable degraded state.

  "What if the DB is unavailable?"
    → Redirect of cached URLs continues (Redis still serves them).
      New URL creation fails — return 503. Acceptable.
      URL creation is the write path; reads should degrade gracefully.

  "What if a single URL gets enormous traffic (hot key in Redis)?"
    → Redis can handle ~100,000 ops/s for a single node.
      At extreme scale: replicate Redis or use local in-process cache for top 100 URLs.

GLOBAL EXTENSION (if asked):
  "To extend globally: deploy API Service + Redis in 3 regions (US, EU, AP).
   Use GeoDNS to route user to nearest region.
   Redis per region: warm from DB writes. Slight eventual consistency (OK for redirects).
   PostgreSQL: single-region primary. Cross-region read replicas for local fallback."
```

---

## SECTION 10 — Comparison Table

```
CONTRAST 1: Choosing a Database

  BAD:
    "I'd use MongoDB because it's flexible and NoSQL scales better."

    WHY IT FAILS:
      "Flexible" is not an architectural reason — it's marketing language.
      "NoSQL scales better" is only true for specific access patterns.
      The interviewer learns nothing about whether you understand the problem.
      This is a tool-first answer. You picked a hammer, then looked for nails.

  GOOD:
    "I'd use PostgreSQL here. The data has natural relational structure:
     users have orders, orders have line items, line items point to products.
     We need JOIN semantics and we need atomic writes across multiple tables
     (order + payment + inventory update must succeed together or all roll back).

     PostgreSQL gives us ACID transactions and foreign key enforcement natively.
     MongoDB would push that consistency logic into application code,
     which is harder to reason about and test.

     The scale — 500 orders/minute — is well within what a single Postgres instance
     handles. I'd revisit this decision if we hit 5 million orders/month
     or if analytics queries start impacting write performance."

    WHY IT WORKS:
      Reason connected to data model characteristics (relational structure).
      Constraint named: atomic writes.
      Alternative considered and dismissed with specific reasoning.
      Clear scale trigger for revisiting.

---

CONTRAST 2: Scaling a Bottleneck

  BAD:
    "To scale, we'd add more servers and use load balancing."

    WHY IT FAILS:
      Which servers? For what bottleneck? Load balancing solves what?
      This is pattern-matching without diagnosis.
      Interviewers hear this from every candidate. It signals surface-level knowledge.

  GOOD:
    "Before scaling anything, let me identify the actual bottleneck.

     In our design, the catalog read service handles ~40,000 RPS.
     Product catalog data changes at most a few times per hour.
     The bottleneck is the DB — it's being queried for data that barely changes.

     The right fix is not more servers — it's eliminating unnecessary work.
     I'd add a Redis cache in front of the catalog DB:
     cache key = product:{id}, TTL = 10 minutes, write-through invalidation on update.

     That drops DB reads by ~95% for catalog queries.
     After the cache: if the remaining 2,000 RPS still strains the DB,
     THEN I add a read replica for catalog queries and route them there.

     Adding more API servers before addressing the DB bottleneck
     would just put more pressure on the DB faster. Order matters."

    WHY IT WORKS:
      Diagnoses before prescribing.
      Specific numbers.
      Explains why the obvious answer (more servers) is wrong.
      Sequences the fixes correctly.

---

CONTRAST 3: Handling a Failure

  BAD:
    "If the payment service is down, we'd retry the request."

    WHY IT FAILS:
      What kind of failure? 503? 400? 500? Timeout?
      Retry a POST? That might charge the user twice.
      Retry immediately? Thundering herd.
      No mention of idempotency, backoff, limits, or circuit breakers.

  GOOD:
    "For payment service failures, the strategy depends on the error type.

     4xx errors (bad request, invalid card): DO NOT retry.
       These are caller errors. Retrying will get the same result.
       Return the error to the user.

     5xx errors and timeouts (payment service unavailable): RETRY with limits.
       Use exponential backoff with jitter: 1s, 2s, 4s, max 3 retries.
       CRITICAL: the payment call must use an idempotency key.
       Our idempotency key = order_id + timestamp_bucket.
       Stripe (or whichever PSP) deduplicates on this key.
       So if we retry after a timeout where the first request actually succeeded,
       the second call is a no-op — user is not charged twice.

     If all retries fail: the order enters a 'payment_pending' state.
       A background worker retries with increasing delay.
       The user sees: 'Payment is being processed — we'll notify you.'
       Better than: 'Error. Please try again.' (user doesn't know if they were charged)

     I'd also add a circuit breaker: if error rate from the payment service
     exceeds 30% over 30 seconds, open the circuit. Stop sending requests.
     This prevents cascading failures and lets the payment service recover."

    WHY IT WORKS:
      Differentiates error types (not all errors are the same).
      Addresses the double-charge problem explicitly.
      Idempotency key named with specific implementation.
      Circuit breaker to prevent cascade.
      User experience considered.

---

CONTRAST 4: Answering "It depends"

  BAD:
    "It depends on the use case."
    (...says nothing else.)

    WHY IT FAILS:
      "It depends" is the beginning of an architectural thought, not the end of one.
      Saying "it depends" and stopping is equivalent to saying nothing.

  GOOD:
    "It depends on two things:

     First: the write pattern. If writes happen frequently and must be immediately
     visible to all readers, use synchronous writes and strong consistency.
     If writes are infrequent or readers can tolerate slight delay, async + eventual is fine.

     Second: the failure contract. What happens if a write fails?
     In a banking system, a failed write means money state is wrong — unacceptable.
     In a social feed, a failed write means someone's post is briefly delayed — acceptable.

     For this specific problem: we're writing user profile updates.
     They're infrequent (~1/day per user) and the user tolerates seeing their
     own changes within a few seconds. Eventual consistency is acceptable here.
     I'd use async with a queue and accept up to 5 seconds of eventual consistency."

    WHY IT WORKS:
      Names the variables that the decision DEPENDS ON.
      Gives a concrete answer at the end.
      Justifies the choice with a specific constraint from this problem.
```

---

## SECTION 11 — Quick Revision

```
THE DESIGN CHALLENGE:
  "Design a notification system for a large e-commerce platform.
   The system must send notifications via email, SMS, and push notifications.

   Users: 5 million active users.
   Triggers: notifications can be triggered by user actions (order shipped,
             payment confirmed) OR scheduled marketing campaigns
             (flash sales, weekly digest).

   Non-functional requirements:
   - Transactional notifications (order shipped) must be delivered within 30 seconds.
   - Marketing campaigns can have up to 2 hours latency.
   - Users have per-channel preferences (some opt out of SMS, all of push, etc.)
   - The system must not spam — rate limit per user (max 10 notifications/day via any channel)."

WHAT TO TRY ON YOUR OWN:
  Before reading the rubric, spend 20 minutes and try to:
  1. Ask your own clarifying questions.
  2. Draw the Level 2 container diagram.
  3. Identify the 3 hardest design problems.
  4. Describe what happens when an email provider goes down.
  5. Describe how you'd test if user preferences are being respected.

---

FEEDBACK RUBRIC:

STRONG ANSWER (passes staff-level bar):
  ✅ Identifies fan-out as the core architectural challenge.
     (1 order event → potentially 3 notifications per user. At 5M users × campaign = 5M emails)

  ✅ Separates transactional (high priority) from marketing (lowpriority) with different queues:
     "I'd use two SQS queues: one standard (marketing, up to 2h delay OK),
      one FIFO with high concurrency (transactional, < 30s required)."

  ✅ Implements user preference check BEFORE fan-out:
     "Before publishing to channel queues, check Redis for user preferences.
      If user opted out of SMS: don't put the event on the SMS queue."

  ✅ Uses provider abstraction layer:
     "Channel workers don't know if they're using SendGrid or SES for email.
      The provider is an interface. If SendGrid rate-limits us: swap to SES.
      No code change in the notification logic."

  ✅ Implements retry + Dead Letter Queue:
     "Failed sends retry 3× with exponential backoff.
      After 3 failures: move to DLQ. Alert the on-call engineer.
      Log the failure for audit: 'User X's order notification was not delivered.'"

  ✅ Implements rate limiting per user:
     "Redis counter per user per day: notification:user:{id}:20240115
      Increment on every send. TTL = 24h. If count > 10: skip and log."

PARTIAL ANSWER (passes senior bar, not staff):
  ⚠️ Has a queue between the trigger and the channel workers — good.
  ⚠️ Recognizes the need for user preferences — but checks them per worker,
     not at ingestion. (Means an SMS message is enqueued, then discarded —
     wasted work, but not catastrophically wrong)
  ⚠️ Mentions retry but not DLQ.
  ✗ Doesn't address rate limiting.
  ✗ Doesn't separate transactional from marketing (or doesn't explain why they differ)

WEAK ANSWER (needs improvement):
  ✗ No queue — notification triggers call email/SMS provider API directly from
    order service. Single point of failure. If Twilio is slow, order creation is slow.
  ✗ User preferences not checked — users get notifications on channels they opted out of.
  ✗ No failure handling — if the email provider returns 503, the notification is lost.
  ✗ No rate limiting — a campaign could send 50 notifications to one user.

  WHAT THIS LOOKS LIKE IN PRODUCTION: The order service starts slowing down
  whenever the email provider has latency (experienced this at many companies).
  Users receive notifications they specifically said they don't want.
  A misconfigured campaign loop sends thousands of emails to the same user.
```

---

## ARCHITECT'S MENTAL MODEL

```
5 RULES FOR SYSTEM ARCHITECTURE DECISIONS:

  RULE 1: THE CONSTRAINT FIRST
    No decision without a constraint.
    "Use Redis for caching" is a preference.
    "Cache product catalog in Redis because it's read 10,000× more than written
     and changes at most hourly" is a decision.
    Every architectural decision must be traceable to a stated constraint.

  RULE 2: BE BORING
    The best system design uses the simplest combination of well-understood components.
    Novelty is a liability: your team can't debug what they don't understand.
    Flashy distributed systems architecture is NOT a signal of good architecture —
    it's a signal that the architect wanted to be clever, not effective.
    Do the boring thing until data proves the boring thing isn't enough.

  RULE 3: DESIGN FOR THE BLAST RADIUS
    When something fails (and it will), how much of the system fails with it?
    A single DB connection pool shared across all services means one service's query spike
    degrades everyone. Separate pools: blast radius contained.
    Good architecture minimizes failure blast radius at every layer.

  RULE 4: OPTIMIZE FOR THE FIRST PERSON WHO HAS TO FIX IT AT 2AM
    Your system will be debugged by someone who wasn't in the design meeting,
    who can't wake anyone up, who has 30 minutes to restore service.
    Is the data flow obvious from the logs? Are failure states observable?
    Is the circuit breaker status visible? Architecture that is hard to operate
    is bad architecture, even if it's technically correct.

  RULE 5: EVERY TRADEOFF MUST BE NAMED
    There is no neutral decision. Every "yes" is a "no" to the alternative.
    Own your tradeoffs explicitly: "We chose consistency over availability here."
    "We chose operational simplicity over maximum throughput."
    Architects who can't name the cost of their decisions aren't architects —
    they're guessing.

---

3 COMMON MISTAKES ARCHITECTS MAKE:

  MISTAKE 1: DESIGNING FOR THE SCALE YOU WISH YOU HAD
    Building a Kafka + event sourcing + CQRS system for 500 users.
    Cost: months of engineering time. Operational complexity the team will struggle with.
    Result: the team is debugging Kafka offsets instead of building features.
    Should have been: PostgreSQL + background jobs + upgrade later if needed.

    Correction: Design for 5× current scale, plan for 50×, prove you need 100× first.

  MISTAKE 2: THE DISTRIBUTED MONOLITH
    Decomposed the system into 12 microservices.
    But each service calls 4 others synchronously before returning a response.
    Any one of the 12 being down causes the entire request to fail.
    You have all the complexity of microservices and none of the isolation benefits.

    Correction: If services must succeed together, they might belong together.
    Use async events (not synchronous calls) between microservices.
    Accept partial response over total failure.

  MISTAKE 3: IGNORING THE OPERATIONAL SURFACE AREA
    Beautiful diagram. New technology for every component.
    No one on the team has operated it. No runbooks. No dashboards.
    The system is brilliant until 2AM when it fails in a novel way that
    requires deep knowledge of the system to debug.

    Correction: Weight "team can operate this" as heavily as "this is technically optimal."
    Operational risk is architecture risk.

---

30-SECOND INTERVIEW ANSWER:
  "How do you approach a system design problem?"

  STRONG ANSWER:
  "I start by making sure I understand the problem, not the technology.
   I ask about scale, SLA, team constraints, and the most critical failure mode.

   Then I sketch the simplest design that handles the core requirement.
   Not the best design — the simplest that works.

   From there I stress-test it: what breaks first? What's the blast radius?
   What would I add to make failures visible and recoverable?

   Every decision I make, I name the tradeoff and the condition under which
   I'd reverse that decision.

   The goal isn't to make the right decision — it's to make a defensible decision
   that we can change when we learn more."

  WHY THIS ANSWER WORKS:
    - Signals: constraint-first thinking
    - Signals: evolutionary architecture (SimpleFirst, then extend)
    - Signals: failure thinking is built in
    - Signals: humility — decisions can be reversed. No ego attached to the design.
    - Length: 30 seconds. Leaves room for the actual interview.
```

---

## QUICK REFERENCE CARD — System Architecture Diagrams

| Concept             | Key Principle                                                                | Common Mistake                                                     |
| ------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| C4 Levels           | Context → Container → Component (skip Code in interviews)                    | Drawing at multiple levels on the same diagram                     |
| ADRs                | Context + Decision + Alternatives + Consequences                             | Writing what without explaining why                                |
| Ambiguity           | Ask one question that changes the architecture                               | Asking many questions vs. stating assumptions                      |
| Estimation          | Calculate from first principles, state confidence level                      | Either skipping estimation or excessive precision                  |
| Tradeoffs           | Name GAINS, COSTS, ASSUMPTIONS, and BREAKING POINT                           | Presenting only benefits of chosen approach                        |
| Failure Modes       | On every component: what breaks, how you detect it, what degrades gracefully | Saying "it won't fail" or only designing happy path                |
| Interviewer Signals | Structured thinking + named tradeoffs + failure awareness > correct answer   | Racing to name a tech stack instead of understanding constraints   |
| ADR Status          | Proposed → Accepted → Superseded/Deprecated                                  | Treating ADRs as permanent — they should evolve                    |
| Scale Decisions     | Build for 5×, plan for 50×, prove need for 100×                              | YAGNI ignored at architecture level or over-engineered prematurely |
| Rate Limiting       | Redis counter with TTL per user per window                                   | Implementing rate limiting in DB (wrong layer)                     |

---

_Architecture is not a set of correct answers. It is a discipline of making defensible decisions,
naming the tradeoffs, and building systems that can be changed by people who weren't in the room
when they were designed._
## SECTION 12 — Architect Thinking Exercise

**Scenario:**
You are interviewing for a senior engineer role. The interviewer asks: "Design the architecture for a URL shortener service (like bit.ly) that handles 100 million URLs and 10 billion redirects per month. Draw the architecture diagram and explain each component."

**Think before reading the solution:**
- What are the key components you would include?
- Where does read vs. write traffic split?
- How would you represent this in a diagram? What notation/layers would you use?

---

**Architect's Solution Diagram (text representation):**

`
[User Browser] â†’ [CDN (CloudFront)] â†’ [ALB]
                                          â†“
                              [API Service - ECS Fargate]
                             /                           \
                    [Write Path]                     [Read Path]
                         â†“                               â†“
              [RDS PostgreSQL - Primary]      [ElastiCache Redis]
              (store longâ†’short mapping)      (cache top 20% URLs)
                                                        â†“ (cache miss)
                                              [RDS PostgreSQL - Read Replica]
              
              [S3] â† [Analytics Worker] â† [SQS Queue] â† [Click Events]
`

**Key diagram decisions to explain:**
1. CDN at the edge â€” 10B redirects/month = ~3,800 req/sec peak; CDN handles ~70% without hitting origin
2. Redis cache â€” 80% of traffic hits 20% of URLs (power law); cache TTL = 24h
3. Read replica separation â€” redirect reads never contend with write path
4. Async analytics â€” click tracking is non-blocking via SQS

**Diagram tips for interviews:**
- Always show the data flow direction with arrows
- Label each component with the AWS service name
- Annotate where the scale bottlenecks are
- Show failure boundaries (what fails independently)
