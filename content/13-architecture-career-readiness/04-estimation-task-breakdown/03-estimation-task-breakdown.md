# Estimation & Task Breakdown

## FILE 03 OF 03 — Mock Exercise, Good vs Bad Estimates, Practice Rubric & Estimation Mental Model

> **Architect Training Mode** | Principal Engineer & Interview Panelist Perspective
> _The goal is not to be right. The goal is to make uncertainty visible, catch gross errors before work starts, and enable the team to make good decisions with incomplete information._

---

## SECTION 9 — Certification Focus (AWS SAA)

```
THE SCENARIO:
  "We're building a file upload and storage feature for a document management SaaS.
   Users can upload documents (PDFs, Word files, images).
   Documents are stored and retrievable by the user who uploaded them.

   Scale expectations:
   - 50,000 users at launch. 500,000 in year 2.
   - Average user uploads 5 documents/month.
   - Average document size: 2MB.
   - Users retrieve documents frequently (view/download multiple times).
   - Documents must be retained indefinitely (no deletion unless user deletes manually).

   Team: 2 backend engineers, 1 frontend engineer, 1 week = 5 working days.

   Question: Is this feasible in a 3-week sprint? What's the storage architecture?
   What will it cost?"

PART 1: TECHNICAL ESTIMATION (capacity / feasibility check)

  STEP 1: How much storage do we need?
    Year 1: 50,000 users × 5 uploads/month × 12 months = 3M documents/year
    Storage: 3M × 2MB = 6TB/year

    Year 2 (500K users): 10× more = 60TB/year cumulative (with year 1)
    Total by end of year 2: ~66TB

    IMPLICATION: 66TB is S3 territory. Not a local disk. Not a DB blob column.
    S3 is the right architecture:
      - S3 at $0.023/GB → 66TB = ~$1,518/month at year 2 scale.
      - Acceptable for a SaaS at 500K users (likely generating far more in revenue).

  STEP 2: Write throughput (uploads per second)?
    Year 1: 50,000 users × 5 uploads/month = 250,000 uploads/month
    Per day: 250,000 / 30 = ~8,333 uploads/day
    Per second (average): 8,333 / 86,400 = ~0.1 uploads/second average
    Peak (assume 10× during business hours): ~1 upload/second peak

    IMPLICATION: 1 upload/second is trivial. No load concerns for uploads at launch.
    Architecture does not need a queue or specialized upload service at this scale.

  STEP 3: Read throughput (downloads per second)?
    Assume each document is viewed 5× per month:
    Total reads/month = 3M documents × 5 = 15M reads/month
    Reads/second = 15M / (30 × 86,400) = ~5.8 reads/second average
    Peak: ~60 reads/second

    IMPLICATION: Direct S3 reads for 60 reads/second is fine.
    If documents are public-accessible links: add CloudFront CDN to reduce latency
    and S3 GET costs. But at this scale: optional, not required.

  STEP 4: Architecture conclusion from numbers
    "S3 for blob storage + PostgreSQL for metadata (user_id, filename, s3_key, size, created_at).
     Upload flow: pre-signed S3 URL pattern (client uploads directly to S3, no proxying through API).
     Read flow: generate signed S3 URL on demand (expiry = 1 hour).
     No CDN required at launch. Add CloudFront in year 2 if egress costs become significant."

    Cost projection: Storage at 6TB/year = ~$138/month. Egress ~$0.09/GB.
    At 60 reads/sec × 2MB = 120MB/sec = 10TB/month egress = ~$900/month.
    Recommendation: CloudFront would reduce egress cost significantly at year 2 scale.

PART 2: EFFORT ESTIMATION (how long to build it)

  TASK BREAKDOWN:

  Backend:
    Task 1: Design DB schema for documents table (0.5 day)
    Task 2: Spike — test S3 pre-signed URL upload flow (0.5 day)
    Task 3: Implement POST /documents/upload-url endpoint (1 day)
            (Generate S3 pre-signed PUT URL, record pending document in DB)
    Task 4: Implement S3 event notification → Lambda → update document status to 'uploaded' (1.5 days)
    Task 5: Implement GET /documents/{id}/download-url endpoint (0.5 day)
    Task 6: Implement GET /documents (list user's documents) with pagination (0.5 day)
    Task 7: Error handling + integration tests (1 day)
    Backend subtotal: 5.5 days

  Frontend:
    Task 8: File picker UI with drag-and-drop support (1 day)
    Task 9: Upload progress indicator + success/failure states (1 day)
    Task 10: Document list view with download links (1 day)
    Frontend subtotal: 3 days

  Observability + Testing:
    Task 11: Upload success/failure metrics + S3 event lag monitoring (0.5 day)
    Task 12: E2E test: upload → list → download (1 day)
    Subtotal: 1.5 days

  TOTAL: 10 days of work

  PARALLELIZATION WITH 2 BACKEND + 1 FRONTEND:
    Day 1–2:
      Backend Eng A: Tasks 1, 2 (schema + spike)
      Backend Eng B: Task 8 (frontend: file picker)
      Frontend Eng: blocked on API contract — start with mockup UI, no real integration yet

    Day 3–5:
      Backend Eng A: Tasks 3, 4 (API endpoints)
      Backend Eng B: Tasks 9, 10 (frontend UI)
      Frontend Eng: Tasks 9, 10 with Backend Eng B

    Day 6–8:
      Backend Eng A: Tasks 5, 6, 7 (download, list, error handling)
      Frontend Eng: Task 12 (E2E tests with real backend)
      Backend Eng B: Task 11 (monitoring)

    Total wall-clock: ~8–9 days for the team.

  ANSWER TO THE QUESTION:
    "Yes, this is feasible in a 3-week sprint with 2 backend + 1 frontend.
     We'll have ~6 days of buffer for unexpected issues.
     The main risk is Task 4 — S3 event → Lambda triggering is new territory.
     I'd spike it on day 1 to validate the approach before building around it."
```

---

## SECTION 10 — Comparison Table

```
PAIR 1: Estimating a New Feature

  BAD ESTIMATE:
    PM: "How long will the file upload feature take?"
    Engineer: "Probably 2 weeks? Maybe 3."

    WHAT'S WRONG:
    No breakdown. No assumptions. No risks named. No confidence level.
    "Maybe 3" communicates nothing actionable.
    The PM will hear "2 weeks" and plan a launch around it.
    Week 3 arrives. Slip. Surprise. Blame.

  GOOD ESTIMATE:
    PM: "How long will the file upload feature take?"

    Engineer: "Let me break it down.

    Backend: pre-signed URL generation, S3 event handling, document API — about 5 days.
    Frontend: upload UI with progress, document list — about 3 days.
    Testing + monitoring: 1.5 days.
    Total: ~10 working days of engineering effort.

    With 2 backend engineers and 1 frontend working in parallel: wall-clock ~8–9 days.
    That's under 2 weeks.

    My confidence is MEDIUM. The main risk is the S3-to-Lambda event trigger — I haven't
    built that end-to-end before. I'd allocate 0.5 days for a spike to confirm the approach.
    If that spike reveals a problem, the estimate increases by up to 2 days.

    I'd call this a 2-week sprint work item with a low risk of slipping into week 3."

    WHY IT WORKS:
    Breakdown is explicit — PM can see where the time goes.
    Risk is named before it's a problem.
    Confidence level is communicated.
    Wall-clock vs. effort-days distinction is clear.

───────────────────────────────────────────────────────────────────────────

PAIR 2: Capacity / Technical Estimate

  BAD:
    "Our system can handle a lot of traffic. We're using AWS so we can just scale."

    WHAT'S WRONG:
    "A lot" and "just scale" are not numbers.
    Auto-scaling doesn't save you from a single underprovisioned DB.
    This answer tells you nothing about whether the system will survive load.

  GOOD:
    "Let me run the numbers on peak capacity.

    At 500K users with 10 requests/user/day: 5M requests/day.
    Average: 5M / 86,400 ≈ 58 RPS. Peak: ~200 RPS.

    Our API tier (3 ECS tasks, 2 vCPU each): handles ~300 RPS easily.
    PostgreSQL (db.t3.large): at 200 RPS with 30ms average query time =
    6 concurrent queries. Well within limits.
    Redis: catalog reads — 200 RPS is trivial for Redis.

    The bottleneck I'd watch: RDS connection count at high ECS task scale.
    If we add 10 more ECS tasks (10 × 20 connections = 200 connections):
    we're at RDS connection limit. PgBouncer or RDS Proxy before we hit that.

    Conclusion: current architecture supports 500K users comfortably.
    The connection pool is the only planned scaling action needed before year 2."

    WHY IT WORKS:
    Numbers used throughout. Bottleneck identified before it becomes a problem.
    Specific action recommended (PgBouncer) with the trigger condition.

───────────────────────────────────────────────────────────────────────────

PAIR 3: Responding to "Can You Do It Faster?"

  BAD RESPONSE:
    PM: "We need this in 1 week, not 2."
    Engineer: "I'll try to get it done faster." (No scope discussion, just acceptance.)

    WHAT'S WRONG:
    "I'll try" is not a plan. The PM thinks the date moved. The engineer thinks they'll
    just work faster. Neither has engaged with the scope.
    Week 1 ends. Feature is 50% done. PM is surprised. Engineer feels blamed.

  GOOD RESPONSE:
    PM: "We need this in 1 week, not 2."

    Engineer: "I can do 1 week, but we'd need to scope down. Here's what fits:

    In 1 week: core upload + list + download. No direct-to-browser progress indicator
    (just a spinner). No download expiry. No monitoring beyond basic error logging.

    Out of 1 week: drag-and-drop UI (plain file input instead). S3 event Lambda trigger
    (background upload status update — we'd need a polling endpoint instead). E2E tests
    defer to next sprint.

    Is that acceptable for the launch milestone, or would it be better to ship
    the full version in week 2 and confidently demo it?"

    WHY IT WORKS:
    Made the scope levers visible instead of promising something that can't be delivered.
    Put the decision back with the PM — they can make an informed choice.
    Named specifically what's in vs. out. No ambiguity.
```

---

## SECTION 11 — Quick Revision

```
THE CHALLENGE:
  "You are the tech lead for a team building a SaaS analytics product.
   The PM wants to add a 'scheduled reports' feature:

   Users can configure a report (metrics, date range, format: PDF or CSV).
   Reports are generated and emailed to the user on a weekly schedule.
   500 users will use this at launch. Expected to grow to 10,000 users.

   Produce:
   A) A back-of-envelope technical estimate (storage, throughput, architecture).
   B) A task breakdown with effort estimates.
   C) Identify 3 risks and their mitigations."

WHAT TO TRY ON YOUR OWN:
  Before reading the rubric, answer all three parts.
  A: How large are reports? How many reports/week at peak? What generates a PDF?
  B: Break it into at least 3 epics with tasks.
  C: What could go wrong?

──────────────────────────────────────────────────────────────────────────

FEEDBACK RUBRIC:

STRONG ANSWER (passes staff/principal bar):

  PART A (Technical Estimate):
  ✅ Reasonable report size assumed and justified:
     "Average report: ~500KB PDF or 100KB CSV. I'll use 1MB as a conservative ceiling."
  ✅ Volume calculation:
     "10,000 users × 1 report/week = 10,000 reports/week = ~17 reports/minute average.
      At launch (500 users): ~1.2 reports/minute. Not a throughput challenge."
  ✅ Storage calc:
     "10,000 reports/week × 1MB = 10GB/week. After 1 year: 520GB. S3 at $0.023/GB = ~$12/month."
  ✅ Architecture decision from numbers:
     "Report generation is CPU-intensive (PDF rendering). Run it as a background job,
      not in the request path. SQS queue + Lambda or ECS worker.
      Store reports in S3. Email the download link, not the attachment."
  ✅ Addressed the email attachment vs. link decision:
     "Attaching a 1MB PDF to every email = 10,000 × 1MB = 10GB/week in email.
      Most email providers limit attachment sizes. Better: email a signed S3 link.
      Link expires in 7 days. User downloads from S3 directly."

  PART B (Task Breakdown):
  ✅ Identified at least 3 epics:
     - Report configuration (UI + DB schema for schedule definition)
     - Report generation worker (PDF + CSV generation, S3 upload)
     - Email delivery (triggered on generation complete, pre-signed URL)
  ✅ Each task is 1–3 days
  ✅ Identified a spike for the PDF generation library (never used before)
  ✅ Estimated parallelization for a 2-engineer team

  PART C (Risks):
  ✅ Risk 1: PDF generation library choice (spike needed, different libraries have
             different page layout fidelity / memory usage)
  ✅ Risk 2: Email deliverability — bulk weekly sends can trigger spam filters.
             May need to whitelist or use a dedicated sending IP (SendGrid dedicated IP).
  ✅ Risk 3: Report generation time grows with data range.
             360-day date range on a large dataset may time out the Lambda.
             Mitigation: enforce max date range at launch, move to ECS task if needed.

PARTIAL ANSWER (passes senior bar):
  ⚠️ Technical estimate has correct approach but doesn't calculate storage cost.
  ⚠️ Task breakdown has the right epics but tasks are too large (> 3 days each).
  ⚠️ Identifies 2 of 3 risks. Misses email deliverability (a real production problem).

WEAK ANSWER:
  ✗ No throughput or storage calculation. Jumps to architecture without numbers.
  ✗ "Generate reports natively in the API handler" — blocks the HTTP request path.
  ✗ Sends the PDF as an email attachment without considering size or cost.
  ✗ No risks identified. "Run it and fix problems as they come."

  WHAT THIS LOOKS LIKE IN PRODUCTION:
    The PDF generation Lambda times out on large reports. Users get incomplete emails.
    10,000 email sends on Monday morning land in spam. Users don't get their reports.
    API response times spike on Monday due to report generation blocking the thread pool.
    Engineering team spends a week in incident triage instead of shipping new features.
```

---

## ESTIMATION MENTAL MODEL

```
5 RULES FOR ESTIMATION AND TASK BREAKDOWN:

  RULE 1: IF YOU CAN'T EXPLAIN THE BREAKDOWN, YOU HAVEN'T ESTIMATED YET
    "2 weeks" without a breakdown is a guess.
    Break it down until each piece takes 1–3 days.
    If you can't break it smaller: you have an unknown. Spike it first.

  RULE 2: NAME THE THING MOST LIKELY TO BLOW THE ESTIMATE
    Every project has one critical risk. Name it explicitly.
    "The third-party API is the risk. If it's well-documented: 2 weeks.
     If it's a nightmare like most fintech APIs: 4 weeks."
    Naming it is worth more than hiding it. Stakeholders can act on it.

  RULE 3: DISTINGUISH EFFORT DAYS FROM CALENDAR DAYS
    10 days of work ≠ 2 calendar weeks.
    Meetings, code reviews, stand-ups, context switching: all remove time.
    A common rule of thumb: 1 developer-day = 6 focused hours.
    A 5-day sprint for one engineer = ~30 focused hours of work = ~3–5 story points of real output.

  RULE 4: THE ESTIMATE IS A CONTRACT ABOUT SCOPE, NOT TIME
    When an estimate changes: scope changed OR a risk materialized.
    The first question is always: "What changed?"
    Not: "Why were you wrong?"
    Estimates don't slip because engineers are slow. They slip because assumptions failed.

  RULE 5: REVISION IS NOT FAILURE — SILENCE IS FAILURE
    Estimates must be revised when new information arrives.
    "I found a problem in week 1 that adds 3 days to the estimate" — good. Revise immediately.
    "I knew in week 1 but didn't say anything" — bad. Everyone plans based on wrong information.
    The obligation of a tech lead: surface estimate changes the moment they're known.

──────────────────────────────────────────────────────────────────────────

3 MISTAKES WHEN ESTIMATING:

  MISTAKE 1: ESTIMATING BEFORE BREAKING DOWN
    "The whole payment integration is about 2 weeks."
    No breakdown means no knowledge of what's inside the 2 weeks.
    When something takes longer than expected: you don't know what caused it.
    You can't learn from the estimate. You can't catch it early.

    FIX: Always break down first, then roll up.

  MISTAKE 2: PADDING SILENTLY INSTEAD OF NAMING RISKS
    Engineers add time because they "know there'll be problems."
    But they don't say which problems. A 10-day estimate becomes 15 days "just in case."
    Stakeholders see padding as inefficiency. They push back and squeeze the buffer.
    The buffer disappears. The risk materializes. The slip happens anyway.

    FIX: Name the risk, quantify it, justify the added days explicitly.
         "I'm adding 2 days because the Stripe 3DS flow is unknown. Here's my plan for the spike."

  MISTAKE 3: NEVER UPDATING THE ESTIMATE
    You estimated in week 0. It's now week 2 and the picture has changed.
    But the original estimate is still on the board. Nobody updated it.
    Everyone is planning based on stale information.

    FIX: Estimates are living documents. Update them when reality changes.
         Make revisions a communication event, not a blame event.

──────────────────────────────────────────────────────────────────────────

QUICK REFERENCE: NUMBERS EVERY ARCHITECT SHOULD KNOW

  | Quantity | Value |
  |---|---|
  | Seconds in a day | 86,400 (use 100,000 for easy math) |
  | Seconds in a month | ~2.6 million |
  | Seconds in a year | ~31.5 million |
  | 1% of a billion | 10 million |
  | PostgreSQL: typical writes/sec (single instance) | ~1,000–5,000 |
  | Redis: ops/sec (simple GET/SET) | 100,000–1,000,000 |
  | Same-AZ network latency | ~0.5 ms |
  | Cross-region network latency (US–EU) | ~80–120 ms |
  | S3 storage price (approximate) | $0.023/GB/month |
  | SQS message limit | 256 KB |
  | Lambda max execution time | 15 minutes |
  | Lambda max memory | 10 GB |
  | ECS task startup time (estimate) | ~30–60 seconds |
  | DynamoDB read unit = 4KB read | per RCU |
```
## SECTION 12 — Architect Thinking Exercise

**Scenario:**
Your manager asks: "How long will it take to add multi-tenancy to our existing single-tenant SaaS application?" The application has 50K lines of code, uses PostgreSQL, Node.js API, and React frontend. You have a team of 3 engineers.

**Think before reading the solution:**
- What questions do you ask before estimating?
- How do you break this into tasks?
- How do you communicate uncertainty?

---

**Architect's Solution:**

**Step 1 â€” Ask clarifying questions FIRST:**
1. What isolation model? (row-level with 	enant_id vs. separate schemas vs. separate databases)
2. What's the rollout strategy? (existing users migrated, or new tenants only?)
3. What's the acceptable risk level? (can we take downtime? rolling migration?)
4. Are there compliance requirements? (GDPR data isolation requirements?)

**Step 2 â€” Break into estimable tasks (assuming row-level isolation):**

| Task | Estimate | Risk |
|------|----------|------|
| Add 	enant_id to all 23 tables + backfill migration | 3d | High |
| Update all queries to filter by 	enant_id (audit all 180 endpoints) | 5d | High |
| Auth middleware: extract tenant from JWT + inject into query context | 2d | Medium |
| Admin UI: tenant management + super-admin role | 3d | Low |
| Testing: integration tests for tenant isolation | 4d | Medium |
| Data migration script for existing users | 2d | High |
| **Total** | **19d** | |

**Step 3 â€” Communicate with uncertainty ranges:**
> "Based on our architecture assessment: confident estimate is 4-6 weeks for 3 engineers. The high-risk items are the database migration and query audit â€” if we find unexpected patterns in the 180 endpoints, this could extend to 8 weeks. I recommend a 2-day spike to audit the query patterns before committing to a timeline."

**Key principle:** Never give a single-point estimate. Always give a range and identify what would cause you to be at the high end.
