# Estimation & Task Breakdown

## FILE 02 OF 03 — Task Decomposition Strategies, Effort Sizing, Risk & Team Calibration

> **Architect Training Mode** | Principal Engineer & Interview Panelist Perspective
> _The difference between a project that ships and one that slips is almost never technical skill. It is almost always: work that wasn't broken down small enough to estimate, risks that weren't identified before work started, and scope that was never explicitly agreed on._

---

## SECTION 5 — Real World Example

```
THE PROBLEM WITH "2 WEEKS FOR THE WHOLE FEATURE":
  When a team estimates a feature as a single block:
    - No visibility into which parts are risky vs. routine.
    - No ability to parallelize across multiple engineers.
    - When something goes wrong: nobody knows which piece is causing the slip.
    - Stakeholders can't see progress until week 2. Surprises hit late.

  The fix: decompose down to units that take 1–3 days to complete.
  Work you can complete in a day can be estimated with high confidence.
  Work that takes 2 weeks is too large to estimate accurately.

THE WORK BREAKDOWN STRUCTURE (WBS):

  A WBS is a hierarchical decomposition of all the work required for a deliverable.

  Level 0: The Feature
  Level 1: Epics (major components or phases)
  Level 2: Stories (user-visible outcomes)
  Level 3: Tasks (technical work units, 1–3 days each)

  EXAMPLE: "Add Stripe Payment Integration to Checkout"

  Level 0: Stripe Payment Integration

  Level 1 — EPIC: Backend Integration
    Story A: Accept payment method selection from API
      Task 1: Define PaymentMethod schema and endpoint (1 day)
      Task 2: Store payment method intent in DB (0.5 day)

    Story B: Stripe Charge Execution
      Task 1: Spike — read Stripe API docs, test in sandbox (1 day)
      Task 2: Implement charge API calls with idempotency key (2 days)
      Task 3: Handle Stripe error codes (3xx, 4xx, 5xx) with retry strategy (1 day)
      Task 4: Write integration test against Stripe test mode (1 day)

    Story C: Webhook Handler
      Task 1: Implement Stripe webhook endpoint with signature verification (1 day)
      Task 2: Handle payment_intent.succeeded event → update order status (1 day)
      Task 3: Handle payment_intent.failed event → queue retry logic (1 day)

  Level 1 — EPIC: Frontend
    Story D: Checkout Payment UI
      Task 1: Integrate Stripe Elements (card input) into checkout page (1 day)
      Task 2: Handle 3D Secure redirect flow (1 day)
      Task 3: Error state UI (charge failed, card declined) (0.5 day)

  Level 1 — EPIC: Testing & Observability
    Story E: End-to-End Testing
      Task 1: Write E2E test for successful checkout (1 day)
      Task 2: Write E2E test for declined card scenario (0.5 day)

    Story F: Monitoring
      Task 1: Add metrics: payment_charge_attempted, payment_charge_succeeded,
              payment_charge_failed (0.5 day)
      Task 2: Add CloudWatch alarm on payment_charge_failed rate > 5% (0.5 day)

  TOTAL ESTIMATE:
    Backend: 1 + 0.5 + 1 + 2 + 1 + 1 + 1 + 1 + 1 = 9.5 days
    Frontend: 1 + 1 + 0.5 = 2.5 days
    Testing + Monitoring: 1 + 0.5 + 0.5 + 0.5 = 2.5 days
    Total: ~14.5 days = ~3 weeks for 1 engineer, ~10 days parallelized across 2 engineers.

  WHAT THE WBS REVEALS:
    - The Stripe spike (1 day in Task B-1) is the riskiest item. Until it's done: the rest of B is unknown.
    - The webhook handler (Story C) is independently completable in parallel with the frontend.
    - Monitoring is often forgotten until post-launch. Including it explicitly prevents that.

THE SPIKE:
  A time-boxed investigation to resolve a specific unknown.
  "I don't know how long this will take because I've never used Stripe's API."
  Fix: allocate 1 day to read docs, build a proof of concept, write a summary.
  After the spike: you can estimate the actual integration with real data.

  Rules:
    Spike = fixed time-box (e.g., 1 day). You stop when the time is up regardless.
    Spike output = a short writeup + revised estimate. Not production code.
    Every significant unknown should have a spike BEFORE the estimate is locked.
```

---

## SECTION 6 — System Design Importance

```
T-SHIRT SIZING (fast calibration for roadmap discussions):

  Used when: the team needs to sequence a backlog of features by effort.
  Goal: relative sizing, not precise estimates.

  Sizes:
    XS = half a day or less (a config change, a copy update, a trivial bug fix)
    S = 1–2 days (a simple API endpoint, minor UI update)
    M = 3–5 days (a feature with multiple parts, moderate complexity)
    L = 1–2 weeks (a significant feature, multiple components affected)
    XL = 2–4 weeks (a major feature, architecture change, new integration)
    XXL = 1–3 months (a platform initiative, rewrite of a subsystem)

  HOW TO USE:
    List the backlog. Each engineer writes their size estimate silently.
    Reveal simultaneously (like Planning Poker).
    Discuss disagreements only — consensus items are accepted without discussion.
    If two engineers say S and XL: that gap reveals a misunderstanding of scope.
    The discussion is about: "What work are you imagining? What did I miss?"

  TRANSLATION TO DAYS (rough guide):
    XS = 0.5 day    S = 2 days    M = 4 days    L = 8 days    XL = 15 days    XXL = 45 days

STORY POINTS (velocity-based planning):

  Used when: the team has 3+ sprints of data on how much work they complete per sprint.
  Goal: consistent internal unit of relative effort. Enables sprint capacity planning.

  Points are RELATIVE, not hours. They measure complexity + effort + uncertainty.
    1 point = a simple, well-understood task (30 min – half a day)
    3 points = moderate effort, mostly clear
    5 points = significant effort, some unknowns
    8 points = complex, non-trivial unknowns, may need spike
    13 points = too large, should be split into smaller stories

  HOW TO CALIBRATE:
    Pick a "reference story" the team has done before.
    "The password reset flow" = 3 points.
    Every new story is sized relative to that reference.
    "Is this smaller or larger than the password reset flow?"

  VELOCITY:
    After 3 sprints: team consistently completes 25 points/sprint.
    Planning: team can commit to 25 points next sprint with reasonable confidence.
    If a feature is 100 points: it's roughly a 4-sprint (8-week) initiative.

  CAUTION: Story points measure capacity, not quality.
    Don't compare story points across teams. A team scoring 30 points/sprint is not
    "better" than a team scoring 20. Point value is calibrated internally.

THREE-POINT ESTIMATION (for high-stakes estimates):

  Used when: a precise estimate matters (contractor billing, executive headcount request).
  Goal: replace a single-point estimate with a range that captures uncertainty.

  Estimate three numbers per task:
    O (Optimistic): everything goes right, no surprises. Best case.
    M (Most Likely): the way similar work usually goes.
    P (Pessimistic): something unexpected, a dependency is late, ambiguity emerges.

  FORMULA: E = (O + 4M + P) / 6
    This is the PERT weighted average. It biases toward Most Likely but captures the distribution.

  EXAMPLE:
    Task: "Implement Stripe charge integration"
    O = 1 day (Stripe docs are perfect, works first try)
    M = 3 days (some debugging, error handling, one gotcha)
    P = 6 days (Stripe API has unexpected behavior in 3DS, need to read 10 support docs)
    E = (1 + 4×3 + 6) / 6 = (1 + 12 + 6) / 6 = 19/6 = 3.2 days

  STANDARD DEVIATION: σ = (P - O) / 6 = (6 - 1) / 6 = 0.83 days
    One σ range: 3.2 ± 0.83 = 2.4 to 4.0 days.
    "I estimate 3 days, likely to be between 2.5 and 4."
```

---

## SECTION 7 — AWS & Cloud Mapping

```
WHY SLIPS HAPPEN:
  Teams identify the work to do.
  Teams estimate how long each piece takes.
  Teams skip: what could make this take longer than estimated?

  The estimate doesn't fail because the task took longer.
  The estimate fails because a RISK MATERIALIZED that wasn't identified.

  Risk identification is the difference between an estimate and a wishlist.

THE RISK REGISTER (simple version):
  Before finalizing any estimate, list:
  1. What assumptions are you making that, if wrong, would change the estimate significantly?
  2. External dependencies: third-party APIs, other teams, licenses, approvals.
  3. Knowledge gaps: things you don't know that you'll need to figure out.
  4. Technical unknowns: things you've never built before in this context.

  For each risk: estimate the probability (Low/Medium/High) and the impact (delay in days).

  EXAMPLE risk log for the Stripe integration:

  | Risk | Probability | Impact | Mitigation |
  |---|---|---|---|
  | Stripe 3DS flow more complex than expected | Medium | +2 days | Spike it in day 1 |
  | Backend engineer has never used Stripe APIs | High | +1–2 days | Allocate 1 day spike |
  | Webhook testing requires HTTPS (dev env issue) | Medium | +1 day | Use ngrok or Stripe CLI |
  | PCI compliance review required before launch | Low | +1 week | Confirm with legal today |

  After filling this out: the 3-week estimate has a visible risk picture.
  "This is a 3-week estimate with 3 medium risks totaling up to 5 extra days.
   My adjusted estimate with risk: 3.5–4 weeks."

  This is useful. Stakeholders can choose to accept the risk or mitigate (e.g., pair
  the engineer with someone Stripe-experienced; reduces the High risk to Low).

THE ESTIMATE REVIEW CONVERSATION:

  WRONG:
    Tech Lead: "We'll ship the payment integration in 3 weeks."
    PM: "Great."
    [week 3: slipping. Nobody knows why.]

  RIGHT:
    Tech Lead: "My estimate is 3 weeks, assuming:
                1. Stripe API sandbox behaves like production (confirmed by reading the docs).
                2. Legal doesn't require a PCI review before launch.
                3. The backend engineer completes the Stripe spike by Tuesday —
                   if the 3DS flow is complex, add 2 days.
                Here are the top 3 risks and my mitigations..."
    PM: "Risk #2 — let me check with legal today."
    [Known risks are resolved before work starts. Week 3 has no surprises.]
```

---

## SECTION 8 — Interview Preparation

**Beginner:**

**Q: Why is software estimation so difficult and what's the most common mistake developers make?**
**A:** Software estimation is hard because: (1) You're estimating work you haven't done before (otherwise it'd be copy-paste). (2) Unknown unknowns â€” bugs, complexity, and requirements changes you didn't anticipate. (3) The planning fallacy â€” humans are systematically optimistic about future task completion. Most common mistake: estimating the "happy path" only (how long it takes if nothing goes wrong), forgetting: reviewing and fixing PR feedback (1-2 days), testing edge cases, fixing bugs found in testing, integration issues with other services, deployment, monitoring verification. Rule of thumb: initial gut estimate Ã— 2 is closer to reality. The Pragmatic Programmer calls this "80% of the work takes 20% of the time, the last 20% takes 80%."

**Q: What is the purpose of breaking a large task into subtasks before estimating?**
**A:** Breaking down forces you to think through all the work â€” you can't estimate what you haven't made explicit. "Implement user authentication" is impossible to estimate. "Design JWT token structure + write login endpoint + write token validation middleware + write refresh token endpoint + write tests + update API docs + deploy to staging" â€” now you can estimate each piece and sum them. This also: reveals hidden dependencies (database schema must exist before the endpoint), identifies parallel work (another engineer can write tests while you write the endpoint), and shows which parts are risky/uncertain (flag those explicitly).

**Q: What is a "spike" in agile development and when should you use one?**
**A:** A spike is a time-boxed investigation task (1-2 days maximum) to answer a specific unknown question before committing to a larger estimate. Example: "We're not sure how to integrate with the new payment gateway API. We need to set a spike: 1 day to write a proof-of-concept integration, evaluate their SDK, and estimate the full implementation." Without the spike, you'd be guessing at a 2-week estimate. After the spike, you estimate confidently. Use spikes when: integration with unfamiliar systems, evaluating new technology, large unknowns in technical approach.

---

**Intermediate:**

**Q: What is the difference between story points and hour-based estimation and when is each appropriate?**
**A:** *Hours:* absolute time estimate (this task takes 8 hours). Specific but prone to overconfidence, affected by interruptions and individual skill differences. Good for short, well-understood tasks. *Story points:* relative complexity estimate (this feature is 3 points, twice as complex as a 1-point task). Team's velocity (total points per sprint) calibrates delivery automatically. Points aren't tied to a specific person â€” accounts for team variance. Good for sprint planning where you need to predict team throughput. *Neither is objectively better:* small teams doing short-cycle work often prefer hours. Larger teams with variable sprint capacity benefit from story points. Pick one, be consistent, and calibrate over time.

**Q: How do you handle scope creep in estimates â€” when stakeholders keep adding requirements after you've committed to a timeline?**
**A:** Scope creep is inevitable; the key is making its impact explicit. Use a "scope change impact" conversation: "The original estimate was 3 weeks for features A, B, C. You've added D and E. Here are the options: (1) Deliver A, B, C in 3 weeks (pull D and E to next sprint). (2) Deliver A, B, D in 3 weeks (pull C and E). (3) Deliver all 5 features in 5 weeks. (4) Add another developer to deliver all 5 in 3.5 weeks (but new dev needs 3 days of onboarding)." Always present options with trade-offs. Never agree to "just fit it in" without explicit acknowledgment that something else gives.

**Q: What is the critical path in project planning and why must you identify it?**
**A:** The critical path is the sequence of tasks where any delay causes the entire project to be delayed. Tasks NOT on the critical path have "float" â€” they can be delayed without affecting the deadline. Example: Building an API. Critical path: Database schema â†’ ORM setup â†’ API endpoints â†’ integration tests â†’ staging deploy. If the DB schema is delayed by 3 days, everything is delayed. Non-critical: writing API documentation (can happen in parallel with integration tests). Identifying the critical path lets you: focus risk management on the right tasks, assign senior developers to critical path tasks, and make informed decisions about what can be parallelized.

---

**Advanced (System Design):**

**Scenario 1:** You're asked to estimate building a "search feature" for an e-commerce platform. The PM says "how long will it take?" You don't have enough information yet. Walk through how you'd handle the next 30 minutes of conversation and arrive at a defensible estimate.

*Step 1 â€” Clarify requirements (5 min):*
"Before I estimate, I need to understand scope: (1) What should be searchable? Products only, or also categories and brands? (2) What search features? Exact match only, or typo tolerance, partial match? Filters? (3) How many products? 1,000 or 1,000,000? (4) Latency requirement? < 200ms? (5) Learning from existing analytics: what search patterns do users currently have?"

*Step 2 â€” Identify approach based on answers:*
1,000 products + exact match â†’ SQL LIKE query (2 days). 100,000 + partial match + filters â†’ Elasticsearch integration (3 weeks). 1,000,000 + typo tolerance + faceted filters â†’ Elasticsearch + Algolia consideration (6-8 weeks).

*Step 3 â€” Produce a range:*
"Based on what you've described (100k products, partial match, 3 filter types), my estimate is 2-3 weeks. If we also need typo tolerance and auto-suggest, add 1 week. I'd like 1 day spike to evaluate Elasticsearch vs PostgreSQL full-text search before committing."

**Scenario 2:** A developer on your team consistently underestimates by 3x and is blocking the sprint. How do you coach them to estimate more accurately, and what structural changes can help the whole team estimate better?

*Individual coaching:*
Root cause analysis: why are they underestimating? (1) Not breaking down tasks enough â€” solution: require tickets to have subtasks before sprint starts. (2) Not accounting for code review cycles â€” solution: explicitly budget 1 day for "review and revision." (3) Optimism bias â€” solution: ask "what could go wrong?" and add that to the estimate. Review the past 5 estimates together and compare actual. Most people improve when they see the pattern in data.
*Structural team practices:* (1) Retrospective: add "estimate accuracy" as a metric â€” actual hours vs estimated, track trend. (2) Planning poker: group estimation surfaces the range of perspectives, surfaces hidden complexity. (3) Definition of Done includes: tests written, code reviewed, deployed to staging, docs updated â€” all of this goes in the estimate. (4) Buffer sprint: one sprint per quarter with no committed deliverables, used to clear tech debt and refine estimates for future quarters.

