# System Architecture Diagrams

## FILE 01 OF 03 — How Architects Think, Diagram Rules & Presenting Designs

> **Architect Training Mode** | Principal Engineer & Interview Panelist Perspective
> _A diagram is not documentation. It is communication. If the person reading it cannot make a decision from it, the diagram failed — regardless of how accurate it is._

---

## SECTION 1 — Intuition (Explain Like a 12-Year-Old)

```
DEVELOPER THINKING:
  "How do I implement this feature?"
  Starting point: the code. The function. The class.
  Primary concern: correctness, testability, clean abstractions.
  Time horizon: this sprint. This PR.
  Risk model: "Does this code do what I intend?"
  Tradeoff vocabulary: performance vs readability, DRY vs duplication.

ARCHITECT THINKING:
  "What are the CONSEQUENCES of this decision in 18 months?"
  Starting point: the problem space. The constraints. The failure modes.
  Primary concern: operability, evolvability, cost, team capability.
  Time horizon: next 2 years. Next scaling event. Next org change.
  Risk model: "What breaks when this assumption is wrong? How bad?"
  Tradeoff vocabulary: consistency vs availability, coupling vs autonomy,
                       build vs buy, now-simplicity vs later-flexibility.

THE MENTAL SHIFT:

  Developer question: "Should I use PostgreSQL or MongoDB for this feature?"
  Answer: "PostgreSQL has better joins and transactions. Use it."

  Architect question: "Should we use PostgreSQL or MongoDB for this system?"
  Answer:
    "It depends on:
      — Do we need ACID transactions across multiple entities? If yes: PostgreSQL.
      — Do we need flexible schema evolution at high write volume? Consider MongoDB.
      — Does our team know Postgres better? Strong preference to use what you know.
      — What's the query pattern? If mostly key-value reads with embedded data: MongoDB.
      — What are the operational requirements? AWS RDS gives managed Postgres.
        MongoDB Atlas gives managed Mongo. Similar operational overhead.

      For this system (e-commerce, complex order relationships, payments):
        I'd choose PostgreSQL. Transactions matter. Relationships are real.
        I would NOT choose MongoDB because 'NoSQL scales better' — that's not a design
        decision, that's a tech trend argument."

  THE DIFFERENCE: the developer answers from the tool.
                  The architect answers from the context.

WHAT ARCHITECTS OPTIMIZE FOR THAT DEVELOPERS OFTEN MISS:
  1. Change surface area: "How much must change when requirement X changes?"
     Low change surface = good architecture. If adding a feature requires touching 8 services: bad.

  2. Failure blast radius: "If component X fails, what else breaks?"
     Synchronous chains = large blast radius. Async queues = smaller.

  3. Team cognitive load: "Can a new developer understand this in 1 week?"
     Brilliant complexity that only you can operate = operational risk.

  4. Operational cost: "What does this cost at 10× load? 100× load?"
     A design that works at $200/month might cost $50,000/month at scale.
     The architect plans for that trajectory.
```

---

## SECTION 2 — Core Technical Explanation

```
THE FOUR LEVELS OF ABSTRACTION (C4 Model):

  LEVEL 1 — Context Diagram:
    Who are your users? What external systems do you integrate with?
    Shows: [User] → [Your System] ↔ [Stripe] ↔ [SendGrid] ↔ [AWS]
    Audience: stakeholders, product managers, non-technical leadership.
    Rule: ONE box for your entire system. Focus on external relationships.
    When asked first in an interview: draw this. It shows you understand scope.

  LEVEL 2 — Container Diagram:
    What are the major deployed units? (containers = deployable units, not Docker)
    Shows: [React SPA] → [API Server] → [PostgreSQL] / [Redis] / [S3]
    Audience: architects, senior engineers, DevOps.
    Rule: Each box is independently deployable. Shows technology choices.
    When asked in an interview: this is the primary level interviewers expect.

  LEVEL 3 — Component Diagram:
    Inside one container: what are the major logical components?
    Shows: inside [API Server]: [Auth Middleware] → [Order Service] → [Payment Service]
    Audience: developers working inside that service.
    Rule: Don't go here in interviews unless the interviewer asks for depth.

  LEVEL 4 — Code Diagram:
    Classes, methods, data structures.
    NEVER show this in system design. This is a different conversation.

THE 6 RULES OF EFFECTIVE ARCHITECTURE DIAGRAMS:

  RULE 1: Every element has a label AND a type.
    BAD: "Box A → Box B → Box C"
    GOOD: "[React SPA: Web App] → [auth-api: Node.js REST API] → [PostgreSQL: RDS]"
    WHY: reader shouldn't have to guess what each element is.

  RULE 2: Every arrow has a direction AND a label.
    BAD: ←→ (bidirectional arrow with no label)
    GOOD: → "HTTPS REST" or → "async, SQS message"
    WHY: the communication protocol and direction carry decision information.

  RULE 3: Show the INTERESTING decisions, not all decisions.
    If you show every component: you show the TOPOLOGY but not the REASONING.
    Include the components that represent architectural choices (sync vs async,
    where you put the cache, what gets a dedicated service vs. stays coupled).
    Omit components that are standard infrastructure with no decision involved.

  RULE 4: Same level of abstraction throughout.
    Don't mix a microservice name with an AWS account ID in the same box.
    Don't show a React SPA at the same level as a database connection pool.
    Each diagram should have consistent zoom level.

  RULE 5: Data flows in one direction (top to bottom, or left to right).
    Zig-zag arrows = diagram is too complex or needs to be split.
    If your arrows cross: consider whether you have a coupling problem.

  RULE 6: Include boundaries. Show who owns what.
    [Client Browser] outside a AWS boundary box.
    [ECS Task] inside a VPC boundary box.
    Boundaries communicate blast radius, security zones, and team ownership.

WHAT NOT TO DRAW:
  × Don't draw ideal future state and label it as current state.
  × Don't draw every AWS service used — only architecturally significant ones.
  × Don't use diagrams to hide complexity. A diagram that "hides" a bad design
    is worse than no diagram — it will mislead decisions.
```

---

## SECTION 3 — Architecture Diagram (MANDATORY)

```
THE FATAL MISTAKE: using the same diagram for every audience.
  Your diagram for the CTO is not your diagram for the dev team.
  Your diagram for the security review is not your diagram for the oncall runbook.
  Different audiences have different questions. Answer their questions, not yours.

AUDIENCE 1: Non-Technical Stakeholders (CTO, VP, Product)
  Their question: "What does the system DO and who uses it?"
  The right diagram: Context Diagram (Level 1).
  Language: avoid acronyms, explain tech choices as business decisions.
  BAD: "We use Redis for caching with TTL-based invalidation."
  GOOD: "We cache frequently-read product data so users see results instantly
         without hitting the database on every click."

  One slide. One minute. What problem it solves. What it doesn't solve.

AUDIENCE 2: Engineering Leadership
  Their question: "Is this scalable? What are the risks? What are we committing to?"
  The right diagram: Container Diagram + key data flows + failure modes.
  Language: tradeoffs with consequences. Numbers.
  BAD: "We use microservices for scalability."
  GOOD: "We separated the payment service because it has different compliance
         requirements (PCI), different scaling characteristics, and we want to
         independently deploy it. Cost: added 400ms of network overhead on checkout.
         Mitigation: async non-critical steps, sync only what's required."

AUDIENCE 3: Development Team
  Their question: "What do I build, how does it fit together, where are the interfaces?"
  The right diagram: Container Diagram + Component Diagram for their service.
  Plus: API contracts, shared data models, deployment dependency order.
  Language: technical, specific, actionable.
  Include: the decision that was NOT made (e.g., "we decided NOT to use GraphQL because...")

AUDIENCE 4: Incident Response / SRE
  Their question: "What path does a request take? What can fail? What's the fallback?"
  The right diagram: Data flow diagram with failure annotations.
  Label each hop: "if this fails: X happens." "timeout: Yms." "fallback: Z."
  NOT an architecture diagram — an operational runbook with visuals.

THE PRESENTATION STRUCTURE FOR A SYSTEM DESIGN (interview or leadership review):
  Step 1: Restate the problem + constraints (30 seconds)
    "We're building a payment processing service. Primary constraints:
     PCI compliance, must not double-charge, < 3 seconds end-to-end."

  Step 2: Clarify what success looks like + what you're NOT building (30 seconds)
    "We're building the capture and fulfillment flow. Out of scope: fraud ML model."

  Step 3: Walk the happy path through the diagram (2 minutes)
    "User clicks Pay → frontend calls POST /api/checkout →
     API validates cart → calls payment service →
     payment service calls Stripe → receives {paymentIntentId} →
     writes order to DB → returns confirmation."

  Step 4: Walk the failure cases (1-2 minutes)
    "If Stripe is unavailable: retry with exponential backoff.
     If DB write fails after Stripe charge: idempotency key prevents re-charge.
     If service crashes mid-transaction: recovery uses the stored paymentIntentId."

  Step 5: Explain 2-3 key decisions (1 minute)
    "I chose to synchronize the checkout flow because users need confirmation.
     I made fraud check asynchronous because we can flag and cancel after the fact."

  Step 6: Name what you'd change with more time (30 seconds)
    "At 10× scale: I'd move from RDS to RDS + read replicas for the catalog queries."
```

---

## SECTION 4 — Request Flow (MANDATORY FLOWCHART)

```
THE ARCHITECT'S TRADEOFF VOCABULARY:
  A good architect doesn't say "option A is better."
  A good architect says: "Option A is better IF [condition]. Option B is better IF [condition]."

  Every architectural decision lives in a tradeoff space.
  If someone presents a decision with no tradeoffs: they haven't thought it through.

THE TRADEOFF FRAMEWORK:
  For any option, articulate:
    GAINS: what you get
    COSTS: what you give up (always exists)
    ASSUMPTIONS: under what conditions the gain outweighs the cost
    BREAKING POINT: at what scale/load/complexity does this choice hurt you

  EXAMPLE — Synchronous vs. Asynchronous Order Processing:

  SYNCHRONOUS:
    Gains: immediate confirmation, simpler code, easier debugging
    Costs: user waits, downstream failure = request failure, tight coupling
    Assumptions: downstream services are fast and reliable (< 200ms, 99.9% uptime)
    Breaking point: when downstream slows under load → cascading timeouts

  ASYNCHRONOUS (SQS queue):
    Gains: fault isolation, retry built-in, downstream independently scalable
    Costs: eventual consistency, harder to debug, "when did it process?"
    Assumptions: users can tolerate "order received, processing" instead of instant confirmation
    Breaking point: when queue backlog grows and SLA for "processing" is violated

THE THREE QUESTIONS INTERVIEWERS LISTEN FOR:
  1. "Why not the obvious alternative?"
     If you say "I use Kafka" without addressing "why not SQS?" — incomplete answer.
     The comparison IS the reasoning. Skip it: you seem like you only know one option.

  2. "What breaks first?"
     For any design: name what fails under load, under failure, under data growth.
     Shows production thinking. Shows you've operated a system before.

  3. "What would change your decision?"
     "If the team already runs Kafka: I'd use it. If it's a new team with no streaming
      expertise: SQS is the better choice even if Kafka is more powerful."
     Shows contextual judgment. Not just technical correctness.

TRADEOFFS WORTH KNOWING COLD:
  REST vs GraphQL: REST for public APIs + caching; GraphQL for complex client-driven queries.
  Monolith vs Microservices: monolith first for new products; services when team/scale requires it.
  SQL vs NoSQL: SQL for defined relationships + transactions; NoSQL for flexible schema + high write volume.
  Sync vs Async: sync when caller needs the result; async when caller can proceed without it.
  Push vs Pull: push for real-time; pull for batch; push+queue for scale.
  Cache-aside vs Write-through: cache-aside for read-heavy, infrequent writes; write-through for consistency.
```
