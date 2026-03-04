# Architecture Decision Records (ADR)

## FILE 01 OF 03 — Foundation: What ADRs Are, Why They Exist, and How to Write Them

> **Architect Training Mode** | Principal Engineer & Interview Panelist Perspective
> _An architecture without recorded decisions is a system that silently accumulates assumptions nobody can verify. ADRs are the audit trail that lets future architects reason about the past._

---

## SECTION 1 — Intuition (Explain Like a 12-Year-Old)

```
THE CORE DEFINITION:
  An Architecture Decision Record (ADR) is a short document that captures
  a significant architectural decision made during the development of a system —
  along with the CONTEXT that led to it, the OPTIONS that were considered,
  and the CONSEQUENCES that followed.

  KEY WORD: "significant."
  Not every decision needs an ADR. An ADR documents decisions that are:
    - Hard or costly to reverse
    - Non-obvious to someone joining the team later
    - A deliberate departure from a default or best practice
    - Made under specific constraints that may not be visible in the code

WHAT AN ADR IS NOT:

  NOT a design document:
    A design document describes WHAT is being built.
    An ADR records WHY a specific choice was made among alternatives.

  NOT a technical specification:
    A tech spec describes HOW to build something.
    An ADR records which major approach was selected and what was rejected.

  NOT a wiki page:
    A wiki page is updated over time and shows current state.
    An ADR is immutable after acceptance — it's a historical record.
    When circumstances change: you write a NEW ADR that supersedes the old one.
    You do NOT edit the old ADR to reflect the new reality.

  NOT only for software architects:
    ADRs are written by whoever made the decision —
    senior engineer, tech lead, principal, or staff engineer.
    Any decision with long-term structural consequences qualifies.

THE PROBLEM ADRs SOLVE:

  Symptom 1: The "Why did we do this?" conversation
    New engineer joins. Sees PostgreSQL.
    "Why not Mongo? Why not DynamoDB?"
    Nobody remembers. The original decision-makers have left.
    The team relitigates a decision that was already made thoughtfully.
    Without ADR: hours of debate, possible bad reversal.
    With ADR: "Read ADR-008." Conversation over in 2 minutes.

  Symptom 2: The "This seems wrong but I don't want to change it" paralysis
    Codebase has a decision that looks bad.
    Nobody knows if it was intentional or a mistake.
    Is it a core architectural choice or technical debt?
    Without ADR: engineers work around it, adding more technical debt.
    With ADR: "ADR-012 — Status: Accepted — Context: we could not use JWT here
              because the auth service didn't exist yet. Revisit when auth service ships."
    Now you know: this WAS intentional, this IS a candidate for cleanup.

  Symptom 3: The reversal without context
    6 months in: someone "fixes" a design decision they don't understand.
    They optimize for a local concern without knowing the global reason it existed.
    Result: a latent bug or a broken invariant that takes weeks to diagnose.
    Without ADR: the change looks legitimate. Nobody catches it until production.
    With ADR: "This change reverses ADR-006. ADR-006 says we need this because..."
              The PR reviewer now understands the full context before approving.
```

---

## SECTION 2 — Core Technical Explanation

```
STANDARD ADR FORMAT:
  Simple, consistent, and maintained in source control alongside the code.
  Stored in: /docs/decisions/ADR-{number}-{short-title}.md

─────────────────────────────────────────────────────────────────────────────

# ADR-{number}: {One-line title of the decision being made}

## Status
{Proposed | Accepted | Deprecated | Superseded by ADR-XXX}

## Date
{YYYY-MM-DD — when the decision was recorded}

## Context
{
  What is the situation that forces a decision?
  What constraints exist? What problem are we trying to solve?
  What happens if we don't make a decision?

  Write this for someone who doesn't know the full history of the system.
  This section explains WHY the decision exists — not what the decision is.
}

## Decision
{
  What was decided? One or two sentences.
  "We will use X." Not "We might use X" or "X was considered."
  This section is a direct statement of the choice made.
}

## Options Considered

  ### Option A: {Title} ← {CHOSEN / NOT CHOSEN}
  {Brief description}
  + Advantage 1
  + Advantage 2
  - Disadvantage 1
  - Disadvantage 2

  ### Option B: {Title} ← NOT CHOSEN
  {Brief description}
  + Advantage 1
  - Disadvantage 1
  - Disadvantage 2

## Consequences

  ### Positive
  - What gets better because of this decision.

  ### Negative / Accepted Risk
  - What gets worse. What we're accepting as a known cost.

  ### Neutral / Operational Notes
  - Things that change but are neither better nor worse.

## Revisit Condition
{
  When should this decision be re-evaluated?
  State a concrete trigger: volume threshold, team size change, tech maturity signal.
  Avoid: "revisit when needed." This is meaningless.
  Use: "Revisit if monthly order volume exceeds 5M" or "Revisit when the team
  has 2 engineers with Kafka operational experience."
}

─────────────────────────────────────────────────────────────────────────────

WHY EACH FIELD MATTERS:

  Status: tells you immediately if this ADR is still active.
    "Superseded by ADR-019" tells you where to look for the current thinking.

  Date: context matters. A 2019 decision about containers is different
    from a 2024 decision. Technology maturity changes.

  Context: the most important field. If the context is wrong or incomplete,
    the decision looks arbitrary. Future architects must understand what was
    known at the time the decision was made.

  Options Considered: this is what separates an ADR from an announcement.
    If only one option is listed: you wrote a memo, not an ADR.
    Alternatives must be listed with honest pros and cons, not strawmen.

  Revisit Condition: prevents ADRs from becoming sacred cows.
    Architecture decisions should expire when circumstances change.
    Naming the expiry condition forces the author to think about the decision's shelf life.
```

---

## SECTION 3 — Architecture Diagram (MANDATORY)

```
# ADR-004: Use RDS PostgreSQL for Order and Payment Data

## Status
Accepted

## Date
2024-03-15

## Context
  The platform needs persistent storage for e-commerce orders and payments.

  Current state:
    - Team: 4 engineers, 2 have direct PostgreSQL production experience.
    - Scale: 300 orders/day in beta, projected 10,000 orders/day at launch.
    - Peak: Black Friday estimate ~50,000 orders/day (2 years out).
    - Data shape: orders have complex relationships — user → order → line items → products.
    - Consistency: payment + order creation must be atomic.
      A successful payment with a missing order record is a financial reconciliation nightmare.
    - Auth system: not yet built. Will be built Q3 2024.
    - Analytics: product team needs order reporting queries (last 30 days, by status, by SKU).

  Without a decision, the team is building prototype code against an in-memory store.
  This decision gates the order service implementation.

## Decision
  We will use AWS RDS PostgreSQL (db.t3.large, Multi-AZ standby) as the primary
  data store for order and payment data.

## Options Considered

  ### Option A: RDS PostgreSQL ← CHOSEN
  AWS managed PostgreSQL with Multi-AZ standby for automatic failover.
  + ACID transactions: order + payment rows written atomically in one transaction.
  + Rich query support: all reporting queries solvable with standard SQL.
  + Team expertise: 2 of 4 engineers have production PostgreSQL experience.
    Onboarding cost low — documentation, tooling, and mental models exist.
  + Managed service: automated backups, patching, Multi-AZ failover in AWS.
  + Sufficient capacity: at 50,000 orders/day = ~0.6 writes/second average.
    db.t3.large handles ~3,000 TPS. Headroom is substantial.
  - Vertical scaling ceiling: at ~100M orders (2+ years out) would need sharding.
  - Schema migrations: must be planned carefully to avoid lock contention at scale.
  - Connection management: ECS horizontal scaling will need a connection pooler
    (PgBouncer or RDS Proxy — see ADR-005).

  ### Option B: DynamoDB ← NOT CHOSEN
  AWS fully managed NoSQL — key-value with optional GSI for secondary access.
  + Unlimited horizontal scale with no operational overhead.
  + Single-digit millisecond reads — excellent for high-throughput lookups.
  - No multi-item ACID transactions without DynamoDB Transactions API.
    DynamoDB Transactions are supported but complex and have known gotchas
    with conditional expressions at high concurrency.
  - Limited query patterns: primary key + sort key only. Analytics queries
    would require DynamoDB Streams → Lambda → S3 → Athena pipeline —
    significant additional complexity and cost.
  - No team experience: would require 4–6 weeks of learning and tooling setup.
  - Access pattern design upfront: DynamoDB requires knowing ALL access patterns
    before designing the table. Our analytics requirements are still evolving.

  ### Option C: MongoDB Atlas ← NOT CHOSEN
  Managed document store — flexible schema, good aggregation framework.
  + Flexible schema: useful if order structure varies across product lines.
  - No native ACID cross-document transactions (MongoDB 4.0+ has them but
    they have significant performance implications).
  - No AWS VPC-native deployment (Atlas runs in its own network — VPC peering needed).
  - Team has no MongoDB production experience.
  - The "flexible schema" benefit is not relevant here — order structure is well-defined.

## Consequences

  ### Positive
  - Atomic order + payment creation eliminates reconciliation errors.
  - Full SQL for analytics — product reporting built with standard queries.
  - Leverages existing team expertise. Onboarding time: minimal.

  ### Negative / Accepted Risk
  - Connection pooling is a shared responsibility. RDS Proxy or PgBouncer must be
    set up before the order service scales beyond 10 ECS tasks. (See ADR-005.)
  - At 100M orders (est. 2027): will need read replicas for analytics isolation.
    This is accepted — the decision intentionally optimizes for speed-to-market now.

  ### Neutral / Operational Notes
  - Database migrations will be managed with Flyway, integrated into CI/CD pipeline.
  - All tables will have created_at / updated_at timestamps. Soft delete pattern used.

## Revisit Condition
  If monthly order volume exceeds 5M: evaluate read replica for analytics queries.
  If payment query P99 exceeds 50ms sustained: investigate query plan, then indexing,
  then read replicas (in that order — do not jump to sharding before exhausting simpler options).
  If a second team needs independent write access to order data: evaluate event sourcing.

─────────────────────────────────────────────────────────────────────────────

WHAT MAKES THIS ADR GOOD:
  ✅ Context section tells a story: team size, experience, scale projections.
     A reader 3 years later understands why DynamoDB wasn't obvious.

  ✅ Options considered are honest: DynamoDB advantages are stated fairly.
     This isn't a propaganda document — it's a reasoning document.

  ✅ Decision is traced to constraints: "2 of 4 engineers have experience" is
     a concrete constraint, not a preference.

  ✅ The "Revisit: 5M orders/month" is specific and testable.
     Not "revisit when it gets slow."

  ✅ ADR-005 is referenced: decisions connect to each other.
     ADRs form a chain of reasoning, not isolated memos.
```

---

## SECTION 4 — Request Flow (MANDATORY FLOWCHART)

```
STORAGE LOCATION — keep ADRs in the repository:
  Recommended: /docs/decisions/
  Naming: ADR-{zero-padded-number}-{kebab-case-title}.md
  Examples:
    docs/decisions/ADR-001-use-postgresql-for-order-data.md
    docs/decisions/ADR-002-async-order-processing-via-sqs.md
    docs/decisions/ADR-003-jwt-authentication-with-refresh-tokens.md

  Why in the repo (not Confluence, not Notion):
    The decision lives with the code it affects.
    When you git blame / git log: you can trace what ADR was active when a change was made.
    If the code lives in GitHub: so does the context for every decision that shaped it.

NUMBERING:
  Sequential. Never reuse a number. Never delete an ADR.
  If a decision is reversed: mark it "Superseded by ADR-XXX" and write a new ADR.
  The original remains as historical context.

ADR STATUS LIFECYCLE:

  PROPOSED:
    A draft. The decision has been identified but not yet accepted.
    Open for comment and discussion (PR review is perfect for this).

  ACCEPTED:
    Decision is approved and in effect. The system implements this decision.

  DEPRECATED:
    The decision was valid but is no longer followed.
    Usually means the system has grown past the constraint that drove the decision,
    but nobody has formally revisited it yet.
    More honest than pretending the ADR still applies.

  SUPERSEDED BY ADR-XXX:
    A new ADR makes a different decision on the same question.
    Link to the new ADR. This ADR is now historical record only.

ADR INDEX:
  Create a README.md in /docs/decisions/ that lists all ADRs with one-line summaries.
  Engineers should be able to scan the list without reading every file.

  Example index entry:
    | ADR-004 | Use RDS PostgreSQL for order data | Accepted | 2024-03-15 |
    | ADR-005 | Use RDS Proxy for connection pooling | Accepted | 2024-03-22 |
    | ADR-006 | Defer multi-region to Phase 2 | Deprecated | 2024-04-01 |

REVIEW PROCESS:
  The best way to write an ADR is as a pull request.
  PR title: "ADR-012: Switch from JWT to PASETO for auth tokens"
  PR description: "Draft ADR for review before implementing. Requesting input from
                   security team and backend lead."

  This forces asynchronous review of the reasoning before the implementation begins.
  The comments on the PR become part of the decision record.
  Merged PR = accepted ADR.
```
