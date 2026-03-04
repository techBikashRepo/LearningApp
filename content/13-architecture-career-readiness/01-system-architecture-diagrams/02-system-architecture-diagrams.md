# System Architecture Diagrams

## FILE 02 OF 03 — ADRs, Ambiguous Requirements, Estimation & What Interviewers Evaluate

> **Architect Training Mode** | Principal Engineer & Interview Panelist Perspective
> _The architect who can't write an ADR hasn't made a decision — they've made an assumption. The architect who can't handle ambiguity hasn't designed under real conditions. The architect who can't estimate hasn't shipped._

---

## SECTION 5 — Real World Example

```
WHAT AN ADR IS:
  A short document that records a significant architectural decision,
  the context that led to it, the options considered, and the consequences.

  NOT a design document (that describes what we're building).
  NOT a technical specification (that describes how to build it).
  AN ADR records WHY a decision was made — so future architects can understand
  if that reasoning still applies, or if circumstances have changed enough to revisit.

WHY ADRs MATTER IN PRODUCTION:
  Without ADRs:
    6 months later a new engineer asks "why do we use SQS instead of Kafka?"
    Nobody remembers. The decision gets relitigated. Hours wasted.
    Or worse: someone changes the decision without understanding why it was made,
    inadvertently breaking a constraint they didn't know existed.

  With ADRs:
    "ADR-007: We chose SQS over Kafka because the team has no Kafka operations
     experience and the throughput requirement (5,000 msg/s) is within SQS limits.
     Revisit: if throughput exceeds 50,000 msg/s or we need ordered partitioned streams."

    New engineer reads it. Question answered. Context preserved. Decision understood.

ADR FORMAT (lightweight, not bureaucratic):

  # ADR-012: Use RDS PostgreSQL instead of DynamoDB for Order Data

  ## Status
  Accepted | Superseded by ADR-019 | Deprecated

  ## Context
  We need persistent storage for order data. Orders have:
    - Complex relationships (users, products, payments, shipments)
    - Strict consistency requirements (payment + order write must be atomic)
    - Moderate write volume: ~500 orders/minute at peak
    - Query patterns: by user, by date range, by status — multiple predicates

  ## Decision
  Use AWS RDS PostgreSQL (db.t3.medium, Multi-AZ enabled).

  ## Options Considered

  Option A: RDS PostgreSQL ← CHOSEN
    + ACID transactions for order + payment atomicity
    + Rich query capabilities (range queries, joins, aggregation)
    + Team expertise: 3 of 4 engineers have PostgreSQL experience
    + AWS managed: automated backups, Multi-AZ failover
    - Vertical scaling limit: ~10,000 TPS before sharding required
    - Schema migrations require careful planning at scale

  Option B: DynamoDB
    + Unlimited horizontal scaling
    + Single-digit millisecond reads
    - No multi-item transactions (requires manual saga pattern)
    - Limited query patterns (partition key + sort key — complex queries expensive)
    - Team has no DynamoDB production experience
    - Would significantly increase development time for order query feature

  ## Consequences
  + Simplified development: standard SQL for all queries
  + Atomic order + payment writes
  + Known operational model for the team
  - Must plan for connection pooling under ECS horizontal scaling (see ADR-014)
  - At 100× current scale: will need read replicas or sharding (revisit at 5M orders/month)

  ## Revisit Condition
  If monthly order volume exceeds 5M OR payment query P99 > 100ms: evaluate read replicas.
  If engineering team doubles and multiple teams own order data: evaluate event sourcing.

WHEN TO WRITE AN ADR:
  ✅ Choosing between two viable technologies (DB, queue, auth pattern)
  ✅ Deliberately not following a best practice (explain why)
  ✅ Making a decision with known negative consequences (we accepted this tradeoff because...)
  ✅ Choosing a pattern that constrains future options (once you pick microservices: harder to undo)
  ✅ Any decision that would trigger "why did we do it this way?" when onboarding a new person

WHEN AN ADR IS NOT NEEDED:
  × Trivial implementation choices (which npm library to use for UUID generation)
  × Decisions that can be easily reversed without significant effort
  × Following the obvious best practice with no alternatives considered
```

---

## SECTION 6 — System Design Importance

```
THE TRUTH: All real requirements are ambiguous.
  Interviewers give you ambiguous requirements ON PURPOSE.
  They are not testing if you know the answer.
  They are testing whether you know which questions to ask.

THE BAD RESPONSE (junior engineer brain):
  Interviewer: "Design Twitter."
  Candidate: *immediately starts drawing boxes* "OK so we'll need a frontend,
             backend, and database. Let me design the API first..."

  The candidate has launched into a solution before understanding the problem.
  They will design a system that solves the wrong problem.
  They will waste 15 minutes on architecture that doesn't fit the actual constraints.

THE GOOD RESPONSE (architect brain):
  Interviewer: "Design Twitter."
  Candidate: "Before I start, I'd like to clarify a few things that will drive
              fundamentally different architecture decisions.

              What's the scale? Are we designing for 10M users or 500M users?
              Scale changes whether this is a monolith + Postgres or a distributed
              system with specialized components.

              Who's using it? Consumer or enterprise? Verified professionals only
              (smaller scale, compliance requirements) or anonymous public users?

              What's the core feature? If it's real-time feed: that drives toward
              event streaming. If it's primarily search: that's a different read path.

              What's the most important non-functional requirement?
              Low latency for reads? High throughput for writes? Consistency?
              Twitter is read-heavy — I'll assume reads > writes by 100:1."

  After getting answers: design maps directly to those constraints.
  Every decision is traceable back to a stated constraint.

THE CLARIFICATION FRAMEWORK — ask in this order:

  1. SCALE (changes fundamental architecture):
     "How many users? Daily active users?"
     "What's the expected read/write ratio?"
     "What's the peak TPS?"
     Rule: 10K users = simple. 10M users = caching. 100M users = CDN + partitioning.

  2. CORE FEATURE vs. NICE-TO-HAVE:
     "What's the one thing that absolutely must work, even if everything else degrades?"
     This defines your consistency/availability tradeoff (CAP theorem in practice).
     For Twitter: reads must work even if writes are delayed. AP system.
     For a bank: writes must be consistent, reads can be slightly stale. CP system.

  3. NON-FUNCTIONAL REQUIREMENTS (define success):
     "What's the acceptable latency? P99 < 200ms? P50 < 50ms?"
     "What's the uptime requirement? 99.9% = 8.7 hours/year downtime OK.
      99.99% = 52 minutes/year. Different architecture."
     "What's the data retention? How long must we keep tweets?"

  4. CONSTRAINTS (define what's off the table):
     "Are there regulatory constraints? GDPR? HIPAA? PCI?"
     "What's the team size? A 5-person team can't own 12 microservices."
     "What's the budget? S3 at 100TB is $2,300/month. Is that acceptable?"

  5. WHAT'S OUT OF SCOPE (defines what you're NOT solving):
     "I'll assume authentication is handled by an existing identity system."
     "I'll skip the ads recommendation engine — that's a separate domain."
     "I won't design the mobile client — this is the backend API."

HANDLING "I DON'T KNOW THE ANSWER":
  Ambiguity sometimes extends to: "I don't know if this is even possible."

  WRONG: guess and confidently present incorrect information.
  WRONG: freeze and say nothing.

  RIGHT: name the uncertainty and make a documented assumption:
    "I'm not certain of the exact throughput limits of Kinesis Data Streams,
     but I believe it's roughly 1MB/s per shard or 1,000 records/s.
     I'll design assuming we need 20 shards for 20,000 msg/s and note that
     this assumption needs verification."

  In an interview: naming that you'd verify the assumption is worth more than
  confidently stating the wrong number.
```

---

## SECTION 7 — AWS & Cloud Mapping

```
WHY ARCHITECTS ESTIMATE:
  Estimation is not about predicting the future.
  It is about testing whether a design is feasible and catching gross miscalculations BEFORE building.

  "We need to store 1 year of clickstream data" — how much storage is that?
  If you don't work through the numbers: you might design for 10GB when the answer is 50TB.
  Completely different storage solution.

THE BACK-OF-ENVELOPE TOOLKIT:

  MEMORY NUMBERS TO KNOW:
    1 byte = 1 character of text
    1 KB = 1,000 bytes ≈ one small text document
    1 MB = 1,000 KB ≈ one song (compressed) / one photo (compressed)
    1 GB = 1,000 MB ≈ one movie (compressed)
    1 TB = 1,000 GB ≈ 1,000 movies

  TIME AND THROUGHPUT:
    1 day = 86,400 seconds ≈ 100,000 seconds (easier to work with)
    1 year ≈ 30 million seconds (3 × 10^7)

  TYPICAL SIZES:
    Tweet / short post: ~300 bytes of text
    User profile row: ~1KB (with metadata)
    Photo (compressed, web): ~200KB–1MB
    Video (1 min, compressed): ~100MB
    API response (typical JSON): ~5–50KB

WORKED ESTIMATION EXAMPLES:

  EXAMPLE 1: "Design Twitter — how much storage for tweets per year?"
    Assumptions:
      300M daily active users.
      Each user tweets ~2 times/day average.
      Each tweet: 300 bytes (text) + 500 bytes (metadata) = ~800 bytes.

    Calculation:
      Tweets/day: 300M users × 2 tweets = 600M tweets/day
      Storage/day: 600M × 800 bytes = 480 GB/day ≈ 500 GB/day
      Storage/year: 500 GB × 365 = ~180 TB/year

    Architectural implication:
      180 TB/year → Standard blob storage (S3) for archival.
      Hot data (last 30 days = 15 TB) → can stay in database with sharding.
      Design needs a tiered storage strategy (hot/warm/cold).

  EXAMPLE 2: "Design a URL shortener — can we fit all URLs in one DB?"
    Assumptions:
      10 billion short URLs exist.
      Each record: ~500 bytes (short code + long URL + metadata).

    Calculation:
      10 billion × 500 bytes = 5 TB total.

    Architectural implication:
      5 TB fits in a single database (PostgreSQL can comfortably handle this).
      BUT: at 100,000 redirects/second (peak), single DB is a bottleneck.
      Design needs: DB for storage + cache (Redis) for hot URL lookups.
      Cache: top 1% of URLs = 100M entries × 500 bytes = 50 GB. Fits in Redis.

  EXAMPLE 3: "How many servers do I need?"
    Assumptions:
      100,000 RPS peak.
      Each request takes 50ms to process.
      Each server handles 500 concurrent requests (standard Node.js with async).

    Calculation:
      Active requests at any time: 100,000 RPS × 0.05s = 5,000 concurrent requests.
      Servers needed: 5,000 / 500 = 10 servers.
      With 2× buffer for safety: 20 servers.

    Architectural implication:
      20 ECS tasks (t3.medium). Load balanced. Auto-scaling between 5 and 40.

SCOPING IN THE INTERVIEW (time management):
  A system design interview is 45–60 minutes. Use it like this:
    0–5 min: clarification questions. Define scope.
    5–15 min: high-level architecture (Level 2 diagram). Walk the happy path.
    15–25 min: deep dive into the most interesting/hardest component.
    25–35 min: handle failure scenarios, bottlenecks, scaling.
    35–45 min: tradeoffs and alternatives. "What would you do differently at 10x scale?"

  The candidate who deep-dives immediately into a low-priority component
  (like admin panel design) has missed the point: scope management IS architecture.
```

---

## SECTION 8 — Interview Preparation

**Beginner:**

**Q: Why do software engineers draw architecture diagrams and who are they for?**
**A:** Architecture diagrams communicate how a system is structured â€” which components exist, how they connect, and how data flows â€” without reading lines of code. They serve different audiences: C4 Context diagrams for non-technical stakeholders (what the system does and who uses it); Component diagrams for other engineers joining the project (get up to speed quickly); Sequence diagrams for debugging complex multi-service flows; Infrastructure diagrams for DevOps/Platform teams. A good diagram answers a specific question for a specific person. Bad diagrams try to show everything and end up explaining nothing.

**Q: What is the difference between a system diagram and a sequence diagram?**
**A:** A *system/architecture diagram* (component or infrastructure) shows the static structure: what components exist, what databases and services they use, how they're connected. It's a snapshot. A *sequence diagram* shows dynamic behavior: for one specific user action or API call, exactly which services are called in what order, what data passes between them, and where errors can occur. Use architecture diagrams to explain "how the system is built." Use sequence diagrams to explain "what happens when I call POST /checkout?"

**Q: What makes an architecture diagram "bad" and hard to understand?**
**A:** A diagram becomes bad when: (1) it shows EVERYTHING â€” every table, every field, every microservice regardless of whether they're relevant. (2) Boxes have no labels or have vague names like "Service 2". (3) Arrows have no labels (what data flows on this arrow? HTTP? Events?). (4) Multiple levels of abstraction are mixed (a user box next to a Kubernetes pod). (5) No legend for colors/shapes. Good diagrams: narrow scope (answer ONE question), clear labels, directional arrows with labels, consistent abstraction level.

---

**Intermediate:**

**Q: What are the C4 Model levels and when do you use each?**
**A:** C4 is a hierarchical diagramming framework: *Level 1 â€” Context:* The system as a single box. Shows users and external systems it integrates with. For stakeholders and new team members. *Level 2 â€” Container:* Inside the system: web app, API, database, message queue â€” the major deployable units. For engineering discussions. *Level 3 â€” Component:* Inside one container: the major classes/modules/services and how they're organized. For developers working in that container. *Level 4 â€” Code:* Class diagrams, UML. Rarely drawn (IDEs auto-generate). For senior engineers making architectural decisions in a module. In practice: L1 and L2 are most valuable. L3 only for complex components.

**Q: How do you document async event-driven architectures where services communicate via queues, not direct HTTP calls?**
**A:** Async flows are harder to diagram because there's no direct call â€” ServiceA publishes an event to an SQS queue, ServiceB later consumes it independently. Sequence diagram approach for async: show it as a three-column interaction (ServiceA â†’ Queue â†’ ServiceB) with clearly labeled async arrows and a note about non-guaranteed timing. In architecture diagrams: use dashed arrows for async communication, solid arrows for synchronous. Include message schema (what payload does the event carry) in the diagram notes or linked documentation. EventStorming (sticky note workshop) is a collaborative technique for mapping complex event flows across a system.

**Q: What is "diagram as code" and what are the advantages over drag-and-drop tools?**
**A:** Diagram as code uses text/markup to define diagrams (Mermaid, PlantUML, Structurizr DSL, Terraform-based tools). Advantages: (1) Version control â€” diagrams live in Git alongside code, PRs for diagram changes. (2) Consistency â€” no random box sizes or misaligned arrows. (3) Diff review â€” exact changes visible in PR diffs. (4) Auto-generation â€” generate diagrams from actual infrastructure state (Terraform â†’ Inframap). Disadvantage: less visual flexibility for complex custom layouts. Recommendation: use Mermaid (supported in GitHub markdown, Confluence, Notion) for most diagrams.

---

**Advanced (System Design):**

**Scenario 1:** You're joining a team that has no architecture documentation. The system has 12 microservices, a mix of synchronous APIs and Kafka event streams, 3 databases, and a legacy monolith still receiving traffic. You have 1 week to produce architecture documentation that engineers can actually use. What do you produce, in what order, and using what approach?

*Week plan:*
Day 1: Interview 3-4 engineers. Goal: understand the most confusing parts of the system. Collect existing diagrams, runbooks, README files.
Day 2: Draw C4 Level 1 (Context) + C4 Level 2 (Container). Validate with team. Get corrections.
Day 3: Sequence diagrams for the 3 most critical user flows (e.g., user login, order checkout, payment processing). These are where bugs happen and new engineers get lost.
Day 4: Event topology diagram â€” every Kafka topic, which service produces to it, which consumes from it.
Day 5: Infrastructure diagram â€” which AWS services each application runs on.
Output: a Confluence space (or README.md in a docs repo) with 6-7 diagrams. Each diagram answers one question. Links between diagrams (C4 L2 box links to sequence diagrams for that service).

**Scenario 2:** During a technical design review, a senior engineer asks you to "walk through the architecture." You have 5 minutes and a whiteboard. How do you structure the explanation of a 6-service e-commerce platform?

*Structured walkthrough:*
(1) *Start with the boundary:* "The system has a mobile/web frontend. Let me draw the outer boundary." Draw a box for users â†’ arrow to the edge.
(2) *Add the entry point:* API Gateway / Load Balancer. One box. "All traffic enters here."
(3) *Draw the primary flow:* Follow one key user action (browse â†’ add to cart â†’ checkout â†’ payment). Draw each service encountered as a box: Product Service, Cart Service, Order Service, Payment Service. Arrows show direction and protocol.
(4) *Add storage:* Each service's database below it.
(5) *Add async:* "Order creation publishes an event" â†’ draw queue â†’ Notification Service.
(6) *Call out key decisions:* "Payment Service is the only one that calls the external payment gateway â€” isolated for PCI compliance."
Total: 5 minutes, clear narrative, 6 boxes, 8 arrows. No clutter.

