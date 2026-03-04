# Estimation & Task Breakdown

## FILE 01 OF 03 — Foundation: The Estimation Mindset, Back-of-Envelope Toolkit & Scoping

> **Architect Training Mode** | Principal Engineer & Interview Panelist Perspective
> _Estimation is not prediction. Estimation is the discipline of checking whether your architecture is feasible, catching orders-of-magnitude errors before you write a line of code, and communicating uncertainty with precision._

---

## SECTION 1 — Intuition (Explain Like a 12-Year-Old)

```
THE MISCONCEPTION:
  Most engineers hate estimation because they think the goal is ACCURACY.
  "I said it would take 2 weeks and it took 4. I was wrong. Estimation is unreliable."

  This is the wrong frame.

THE RIGHT FRAME:
  Estimation has two roles in architecture work:

  ROLE 1: FEASIBILITY CHECK
    Is this design even possible given the constraints?
    If you're storing 10TB of logs daily but your S3 budget allows 1TB: you need to know.
    If you're designing for 50,000 RPS but your proposed single-server handles 1,000: you need to know.
    Estimation catches orders-of-magnitude errors before you commit to an architecture.

    A 2× error on a feasibility check is irrelevant.
    A 10× error changes the architecture completely.
    The goal: catch the 10× errors. Rough precision is sufficient.

  ROLE 2: ALIGNMENT ON SCOPE AND EFFORT
    When the team agrees to a 2-week estimate: they are agreeing on scope.
    The estimate is not a promise. It is a shared understanding of size.
    When the work takes 4 weeks: the conversation is "what scope changed?" not "you failed."

    Good estimates surface scope disagreements early (instead of in week 3 of a 2-week sprint).

THE ENGINEERS WHO REFUSE TO ESTIMATE:
  "I can't give you a number until I fully understand the problem."
  → Translation: "I will never give you a number." Nobody ever fully understands the problem.

  "I could give you a range of 1 day to 6 months."
  → This is not an estimate. This is refusal dressed up as honesty.

  WHAT YOU SHOULD DO INSTEAD:
  "My current best estimate is 2 weeks. My confidence is LOW because I haven't seen
  the payment integration API docs yet. The thing most likely to change this estimate
  is the auth requirements — if those are more complex than typical, add another week.
  Let me revisit this estimate after the API review on Thursday."

  That is useful. That is what a tech lead does.

THE TWO TYPES OF ESTIMATION:

  TECHNICAL / CAPACITY ESTIMATION (architect concern):
    "Can our system handle this load? How much storage will we need?
     How many servers do we need? Is this architecture financially viable?"
    Tools: back-of-envelope math, latency numbers, throughput benchmarks.

  EFFORT / TASK ESTIMATION (tech lead / engineering manager concern):
    "How long will it take the team to build this feature?
     How do we break a 3-month project into 2-week sprints?"
    Tools: task decomposition, story points, velocity, risk identification.

  Both belong to the architect's toolkit. This file covers both.
```

---

## SECTION 2 — Core Technical Explanation

```
MEMORY LAYER (numbers to internalize):

  STORAGE:
    1 byte = 1 ASCII character
    1 KB = 1,000 bytes = roughly a short text block
    1 MB = 1,000 KB = a typical photo (compressed) or a song (MP3 at 128kbps)
    1 GB = 1,000 MB = a standard video file or a substantial DB backup
    1 TB = 1,000 GB = 1,000 movies or ~1 billion small records
    1 PB = 1,000 TB = enterprise-scale data lake territory

  TIME AND THROUGHPUT:
    1 second = 1,000 milliseconds
    1 day = 86,400 seconds (memorize as ~100,000 for easy math)
    1 month = ~730 hours = ~2.6 million seconds = ~30 × 100K seconds
    1 year = ~31.5 million seconds (memorize as ~30 million)

  LATENCY NUMBERS (rough orders of magnitude):
    L1 cache access: ~1 nanosecond
    RAM access: ~100 nanoseconds
    SSD read: ~100 microseconds (0.1 ms)
    Network: same data center, same AZ: ~0.5 ms
    Network: cross-AZ (same region): ~1–2 ms
    Network: cross-region (US to EU): ~80–120 ms
    PostgreSQL query (cached, indexed): ~1–5 ms
    PostgreSQL query (full table scan, 1M rows): ~100–1000 ms
    Redis GET: ~0.5–1 ms
    External API call (domestic): ~50–200 ms

  THROUGHPUT BENCHMARKS (approximate, varies strongly with hardware):
    PostgreSQL single instance: ~5,000–20,000 simple reads/sec
    PostgreSQL single instance: ~1,000–5,000 writes/sec
    Redis: ~100,000–1,000,000 ops/sec (single instance, simple operations)
    SQS: standard queue − >120,000 msgs/sec
    Nginx/Node.js: ~10,000–50,000 HTTP requests/sec per process depending on logic
    S3: effectively unlimited for reads, few thousand req/s per bucket for writes

THE FIVE-STEP BACK-OF-ENVELOPE METHOD:

  STEP 1: USERS → DAU (Daily Active Users)
    "We have 10M registered users. Assume 20% are daily active."
    DAU = 2M

  STEP 2: DAU → REQUESTS PER SECOND (RPS)
    "Each active user makes ~10 API requests per day."
    Total requests/day = 2M × 10 = 20M requests/day
    Average RPS = 20M ÷ 100,000 (≈ seconds in a day) = 200 RPS average
    Peak RPS = Peak is typically 3–5× average → ~600–1,000 RPS peak

  STEP 3: RPS → STORAGE (if writing data)
    "Each request creates a ~1KB record."
    Storage/day = 200 RPS × 86,400 × 1KB = 17 GB/day
    Storage/year = 17 GB × 365 = ~6 TB/year

  STEP 4: STORAGE → ARCHITECTURE IMPLICATION
    6 TB/year: can stay in PostgreSQL with partitioning or move cold data to S3.
    At 10 TB/year: consider tiered storage (hot last 90 days in DB, archive to S3 Glacier).

  STEP 5: RPS → SERVER COUNT (if needed)
    "Each request takes ~100ms. Each server handles 100 concurrent connections.
     Concurrent requests = 1,000 RPS × 0.1s = 100 concurrent.
     Servers needed = 100 / 100 = 1. With 3× safety margin: 3 servers."

    NOTE: This is why small products can start with a single server.
    1,000 RPS is a lot of traffic for a growing startup: still fits 3 small servers.

WORKED EXAMPLE — URL SHORTENER:

  "Design a URL shortener like bit.ly. 200M stored URLs. 10B redirects/month."

  STEP 1: How many new URLs are created per day?
    200M URLs to store. Assume 200M URLs accumulated over 5 years.
    New URLs/year = 200M / 5 = 40M
    New URLs/day = 40M / 365 = ~110,000/day ≈ ~1.3 writes/second

  STEP 2: How many redirects per second at peak?
    10B redirects/month = 10B / (30 × 86,400) = 10B / 2.6M = ~3,850 RPS average
    Peak: assume 5× = ~20,000 RPS peak

  STEP 3: Storage for all URLs
    200M URLs × 500 bytes (short code + long URL + metadata) = 100 GB
    100 GB fits comfortably in PostgreSQL (or DynamoDB, or any DB).
    Storage is NOT the bottleneck.

  STEP 4: Architecture implication
    20,000 RPS for redirects → can't hit PostgreSQL directly for every request.
    20,000 × 0.005s (5ms per DB query) = 100 concurrent DB connections. Maybe manageable.
    BUT: redirects are pure reads on the same data. Cache aggressively.
    Top 1% of 200M URLs = 2M hot URLs × 200 bytes = 400 MB → fits in Redis easily.
    With Redis: 20,000 RPS becomes trivial (Redis handles 100K+ reads/sec).

  CONCLUSION FROM ESTIMATION:
    "The storage requirement (100GB) doesn't drive the architecture.
     The read throughput (20,000 RPS) does. The answer is Redis caching.
     Write volume (1.3/second) is negligible — PostgreSQL as the source of truth is fine."
```

---

## SECTION 3 — Architecture Diagram (MANDATORY)

```
THE LANGUAGE OF ESTIMATION:

  LEVEL 1: ROUGH ORDER OF MAGNITUDE (ROM)
    Confidence: 50% chance of being within 5× of actual.
    When to use: early feasibility sketch. First conversation. Pre-requirements.
    Language: "Ballpark — I'd say this is a weeks-scale project, not days and not months."

    DO NOT: report ROM estimates as if they're commitments.
    DO: always label them: "This is a very rough estimate — I'm working from first principles."

  LEVEL 2: CONCEPTUAL ESTIMATE
    Confidence: within 2× of actual. Maybe 50–100% better or worse.
    When to use: after requirements are mostly known. Architecture is sketched.
    Language: "Based on what I know, probably 4–6 weeks. Could be 2 if auth is simple.
               Could be 8 if the third-party integration is complicated."

    The range should reflect actual uncertainty. A wide range is honest, not weak.
    A narrow range is confident, not accurate. Don't fake precision.

  LEVEL 3: DETAILED ESTIMATE
    Confidence: within 25% of actual.
    When to use: requirements are locked, design is set, unknown items have been researched.
    Language: "Based on the design doc and our spike findings: 6 weeks.
               The main risk is the Plaid integration — I've allocated 1 week buffer.
               If Plaid is simpler than expected, we'll come in at 5 weeks."

    This level requires task-level decomposition (see File 02).

COMMUNICATING CONFIDENCE EXPLICITLY:
  "My confidence on this estimate is HIGH because we've built similar features before.
   I'm not expecting surprises."

  "My confidence on this estimate is LOW because I haven't seen the API schema yet.
   After the API review on Thursday, I'll revise and narrow the range."

  "The thing most likely to blow this estimate is [specific risk]. If that happens:
   I'll know within the first 3 days and will flag it immediately."

  WHY THIS MATTERS:
    Stakeholders make decisions based on estimates.
    If you give a number without a confidence level, they'll treat it as a commitment.
    The confidence level is the most important piece of information — it tells them
    how much to trust the number and when to expect revision.

SCOPING CONVERSATIONS:
  Often, an estimate is too large because scope is too large.
  The architect's job is to help stakeholders see the scope levers.

  "If we must ship in 4 weeks and the full feature takes 8:
   Here's what a 4-week version looks like — what pieces can we defer?
   Core flow: 3 weeks. Analytics dashboard: 3 weeks. Notifications: 2 weeks.
   Can we ship core flow first and add analytics in a follow-up sprint?"

  This is how architects manage scope. Not by accepting unrealistic deadlines,
  and not by refusing to engage. By decomposing the work and presenting the levers.
```

---

## SECTION 4 — Request Flow (MANDATORY FLOWCHART)

```
THE ARCHITECT'S MOST VALUABLE CONTRIBUTION TO PLANNING:

  An architect who can distinguish "must-have for launch" from "nice-to-have later"
  is worth more than one who can only describe what's technically possible.

  The question is not "what is the full vision?"
  The question is "what is the minimum architecture that proves the value,
                   and what part of that architecture can be extended cheaply
                   when we're ready to grow?"

THE MVP vs SCALABLE ARCHITECTURE DISTINCTION:

  WRONG APPROACH:
    Build for 10M users on day one.
    Every decision optimized for scale that doesn't exist yet.
    Team spends 3 months building Kafka + sharded DB + Kubernetes
    before a single user validates the product.

  RIGHT APPROACH:
    "We're launching to 1,000 beta users. The architecture that serves them well
    is a monolith + PostgreSQL + S3. That takes 6 weeks to build.

    At 100K users: we'll add Redis caching and a read replica.
    At 1M users: we'll evaluate whether the DB is the bottleneck and act on data.
    At 10M users: we'll have revenue to fund a dedicated platform engineering week.

    The exit path from the MVP is clear. We're not trapped by it.
    The monolith we're building has clean module boundaries — extracting services
    later is possible. We're not building a big-ball-of-mud, just a monolith."

  THE KEY: "CLEAR EXIT PATH"
    The MVP decision is defensible if:
    1. You can name the point at which it stops being sufficient (breaking point).
    2. The migration path to the next level is known and feasible.
    3. The MVP doesn't encode decisions that are impossible to reverse.

    If the MVP uses a schema that requires a full migration at scale:
    that's not a good MVP decision. The technical debt is too expensive.

SCOPE DECISIONS IN PRACTICE:

  Build now (must have for launch):
  ✅ Core happy path (the one thing the product does)
  ✅ Basic authentication and authorization
  ✅ Error handling that doesn't expose internals
  ✅ Sufficient logging to debug production issues
  ✅ Basic monitoring: is the app receiving requests? Are errors spiking?

  Build later (defer until there's data):
  📋 Advanced analytics (build when you know what questions you're actually asking)
  📋 Multi-region deployment (build when users in that region are paying)
  📋 Advanced caching (build when profiling shows DB is the bottleneck)
  📋 Event streaming (add when a second consumer needs the same events)
  📋 Automated testing infrastructure (build in parallel with feature work, not before)
  📋 Admin dashboard tooling (every startup, at launch: engineers run SQL queries directly)
```
