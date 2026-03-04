# Explaining Tradeoffs

## FILE 02 OF 03 — Deep Dives: Six Major Tradeoffs Every Architect Must Own

> **Architect Training Mode** | Principal Engineer & Interview Panelist Perspective
> _You will be asked about these tradeoffs in every architecture interview, every design review, and every incident retrospective. Own the reasoning, not the memorized answer._

---

## SECTION 5 — Real World Example

```
THE QUESTION YOU'LL FACE:
  "Why would you choose REST over GraphQL (or vice versa)?"

REST:
  WHAT IT IS: Resource-oriented API. Each URL is a resource. HTTP verbs define operations.

  GAINS:
  + Simplicity: every developer already understands HTTP. No query language to learn.
  + Caching: GET /products/123 can be cached at CDN, browser, proxy level.
    GraphQL POST requests cannot be HTTP-cached at the transport layer.
  + Tooling maturity: Swagger/OpenAPI, Postman, curl — all work natively.
  + Error transparency: HTTP status codes (404, 401, 403, 500) are meaningful and standard.
  + Server-side simplicity: endpoints are predictable, auditable, rate-limitable individually.

  COSTS:
  - Over-fetching: GET /users returns 30 fields when the mobile client needed 3.
    Wasted bandwidth. Especially painful on mobile clients with limited data.
  - Under-fetching (N+1 problem): GET /users/123, then GET /users/123/orders,
    then GET /orders/456/items. Multiple round trips for one screen.
  - Client-driven flexibility is impossible: if the client needs different data shapes,
    you need either multiple endpoints or versioning.

GraphQL:
  WHAT IT IS: Query language for APIs. Client declares exactly what fields it needs.
  Single endpoint (/graphql). Server resolves the query against a typed schema.

  GAINS:
  + Client-defined queries: fetch exactly the fields needed. No over-fetching.
  + Single round trip: get user + orders + items in one request.
  + Strong typing: schema is a contract. Type violations caught at development time.
  + Excellent for complex, nested data with many optional relationships (social graph, CMS).
  + Enables rapid frontend iteration: new UI views don't require new backend endpoints.

  COSTS:
  - Complexity: query parsing, resolvers, DataLoader pattern, schema management.
    Backend engineers need time to learn and implement correctly.
  - Caching is hard: POST to /graphql with a JSON body — not HTTP-cacheable.
    Persisted queries or client-side cache (Apollo Client) required.
  - N+1 query problem moves server-side: GraphQL resolvers can accidentally trigger
    N+1 DB queries. DataLoader is required to batch + deduplicate. Non-trivial.
  - Error handling: GraphQL always returns 200 OK with errors in the response body.
    Monitoring "did this request succeed?" requires parsing the response, not reading status.

WHEN TO CHOOSE REST:
  - Simple CRUD APIs with well-defined, stable resource shapes.
  - Public/third-party APIs where simplicity and tooling matter.
  - APIs where HTTP caching at the CDN or proxy level is a performance requirement.
  - Small teams without GraphQL experience.
  - Mobile apps with infrequent, predictable data needs.

WHEN TO CHOOSE GraphQL:
  - Complex frontend with many data relationships (social network, SaaS dashboard).
  - Multiple clients (web, iOS, Android) with different data needs for the same entity.
  - Teams where frontend engineers need API flexibility without backend deployments.
  - BFF (Backend for Frontend) layer on top of internal microservices.

THE ONE-SENTENCE RULE:
  "REST when the data shape is stable and caching matters.
   GraphQL when clients have diverse, complex data needs and you want to
   let clients define their queries rather than creating new endpoints."
```

---

## SECTION 6 — System Design Importance

```
THE QUESTION YOU'LL FACE:
  "When would you choose a monolith over microservices?"
  (Or the reverse — nearly identical in structure.)

MONOLITH (including Modular Monolith):
  WHAT IT IS: All business logic deployed as a single unit.
  Modules may have internal boundaries (modular monolith) but share a process and DB.

  GAINS:
  + Simple to develop: no network overhead, shared DB transactions, easy refactoring.
  + Simple to operate: one deployment, one log stream, one rollback.
  + Easy local development: one process to run. No orchestration needed.
  + Atomic operations across modules: update user + create order + charge payment in one DB transaction.
  + Better performance for internal calls: function calls, not network hops.

  COSTS:
  - Deploy coupling: any change requires full retest and redeploy.
    If team A breaks something: team B's deployment is blocked.
  - Scaling is coarse: must scale the entire monolith to scale one hot component.
    Cannot scale just the recommendation engine independently.
  - Blast radius: a memory leak in one module can crash the entire application.
  - Technology lock-in: all modules must use the same language and runtime.

MICROSERVICES:
  WHAT IT IS: Business capabilities split into independent, separately deployable services.
  Each service owns its data. Services communicate via APIs or events.

  GAINS:
  + Independent deployment: team A deploys without coordinating with team B.
    Deploy frequency goes up. Feature velocity increases (if done well).
  + Independent scaling: scale only the hot service. Cost-efficient at scale.
  + Fault isolation: if the recommendation service crashes, the order service still works.
    Blast radius is contained to the failed service.
  + Technology diversity: each service can use the best language/runtime for its job.

  COSTS:
  - Distributed systems complexity: network calls fail. Latency varies.
    Every inter-service call needs: timeouts, retries, circuit breakers.
  - Operational overhead: each service needs its own deployment pipeline, monitoring,
    alerting, and on-call runbook. 12 services = 12× the operational surface area.
  - Data sovereignty: services cannot share DB tables. Cross-service queries require
    either an aggregation service, a read model, or eventual consistency via events.
  - Debugging difficulty: a single user request may touch 5 services.
    Distributed tracing (Jaeger, X-Ray) becomes a requirement, not an option.
  - The "Distributed Monolith" failure mode: you decomposed into services but each
    service calls 4 others synchronously. Any one down = all down.
    You got all the complexity with none of the isolation benefit.

THE HONEST DECISION FRAMEWORK:
  Start with a monolith when:
  → Team is < 5 engineers. You can't staff 12 independently-operated services.
  → Domain is not fully understood yet. Getting domain boundaries wrong in microservices
    creates permanent, expensive seams that are hard to change later.
  → Speed to market is the priority. Microservices infrastructure takes 3–6 months to do right.
  → The scale doesn't justify distributed overhead. 10,000 users/day is a monolith problem.

  Evolve toward microservices when:
  → Team has grown to a point where deploy coupling is measurably hurting delivery velocity.
  → A specific component has independently proven scaling requirements (10× more traffic
    on recommendations vs. order management — scale them separately).
  → Multiple teams need to deploy independently on DIFFERENT schedules.
  → One component has a materially different technology requirement (ML model serving).

THE MIGRATION PATTERN:
  "Strangler Fig": don't rewrite. Extract one bounded context at a time.
  Start with the component that causes the most pain (blast radius or deploy coupling).
  Run old and new in parallel. Route traffic gradually. Remove old code only when new is proven.
  This is the safe path. "Big bang rewrite to microservices" is the graveyard of projects.
```

---

## SECTION 7 — AWS & Cloud Mapping

```
THE QUESTION YOU'LL FACE:
  "Why would you choose PostgreSQL over DynamoDB (or vice versa) for this use case?"

POSTGRESQL (Relational SQL):
  GAINS:
  + ACID transactions: multiple rows, multiple tables, atomic. The default for correctness.
  + Rich query language: JOINs, GROUP BY, window functions, full-text search.
    Unknown-at-design-time queries are possible.
  + Schema enforcement: the DB rejects malformed writes at the column/type level.
  + Mature ecosystem: ORMs, migration tools, query analyzers, monitoring dashboards.
  + Flexible: handles OLTP (transactional) and light OLAP (reporting) with read replicas.

  COSTS:
  - Vertical scaling limit: ~10,000–50,000 TPS on a single instance before sharding required.
  - Sharding is complex and manual: horizontal scaling requires application-level routing.
  - Schema migrations: at scale, ALTER TABLE can lock tables. Must use online migration tools.
  - Connection management: PostgreSQL uses one process per connection. At 1,000+ connections:
    PgBouncer or RDS Proxy is required.

DYNAMODB (NoSQL Key-Value / Document):
  GAINS:
  + Unlimited horizontal scale: AWS manages partitioning. Scales to millions of writes/sec.
  + Single-digit millisecond reads: SSD-based, optimized for key lookups.
  + Serverless billing: pay per read/write unit, not per provisioned instance.
  + No connection management: HTTP-based API. No connection pool limits.
  + Event streaming built-in: DynamoDB Streams → Lambda triggers.

  COSTS:
  - Must know ALL access patterns at design time: DynamoDB is optimized for specific key-value
    lookups. Adding a new access pattern may require a new GSI or a table redesign.
  - No JOIN semantics: cross-entity queries require application-level join logic
    or denormalized data (store copies of data in multiple tables).
  - Transactions are limited: DynamoDB Transactions work but add significant read/write cost.
    Not a replacement for PostgreSQL ACID semantics in complex multi-entity scenarios.
  - Hot partition problem: all writes to the same partition key hit the same shard.
    Misdesigned partition keys cause throughput bottlenecks.
  - Querying is expensive if not via the primary key: table scans, GSIs each cost RCUs.

THE DIAGNOSTIC QUESTIONS:
  1. How many access patterns do you have and are they known upfront?
     Known, simple, key-based → DynamoDB.
     Complex, unknown, ad hoc → PostgreSQL.

  2. Do you need atomic transactions across multiple entities?
     Yes, for correctness → PostgreSQL.
     Can be eventually consistent or use event-based sagas → DynamoDB possible.

  3. What's your expected TPS?
     < 50,000 TPS → PostgreSQL handles it comfortably.
     > 1M TPS → DynamoDB.
     In between → PostgreSQL with read replicas + caching often sufficient.

  4. What is your team's expertise?
     SQL expertise → PostgreSQL onboarding is immediate.
     DynamoDB requires learning the data modeling discipline; wrong design is expensive to fix.
```

---

## SECTION 8 — Interview Preparation

**Beginner:**

**Q: What is a trade-off in software engineering and why is explaining them important?**
**A:** A trade-off is when gaining one benefit requires giving up another. Every technical decision has trade-offs: using a cache improves read speed but adds complexity and risks stale data. Microservices enable independent deployment but add network overhead. There is no "best" architecture â€” only "best for these specific constraints." Explaining trade-offs is important because it shows stakeholders you've thought through options critically, not just picked the first thing that worked. Senior engineers are distinguished by their ability to reason about trade-offs clearly, especially under time and budget constraints.

**Q: What is the CAP theorem trade-off and how do you explain it simply?**
**A:** CAP theorem says a distributed database can guarantee at most TWO of: Consistency (all reads see the latest write), Availability (system always responds), Partition tolerance (system continues during network failures). You can't have all three. In practice: partition tolerance is non-negotiable (networks fail). So you choose: CP (consistent + partition tolerant) â€” may reject requests when nodes can't sync (e.g., HBase, Zookeeper). AP (available + partition tolerant) â€” always responds but may return slightly stale data (e.g., Cassandra, DynamoDB). Choosing depends on whether stale reads are acceptable for your use case (social feed: yes; bank balance: no).

**Q: How do you explain a technical trade-off to a non-technical stakeholder (e.g., a product manager)?**
**A:** Connect it to business impact, not engineering theory. Instead of: "Using a microservices architecture adds operational overhead." Say: "If we split the service into microservices now, we'll need 2 extra weeks to set up the infrastructure and your team will need to maintain 3 deployment pipelines instead of 1. The benefit is that in 6 months when we need to scale the checkout service independently, we'll save 2 sprints of refactoring. Would you like to invest the 2 weeks now or later?" Frame trade-offs as investment decisions with specific timelines and consequences.

---

**Intermediate:**

**Q: What is the consistency vs availability trade-off in a multi-region deployment, and when do you choose each?**
**A:** In multi-region (e.g., us-east-1 and ap-south-1), a write in one region must replicate to the other. This takes ~150-200ms. During that window: *Strong consistency* â€” block all reads until replication completes (every user sees latest data). Problem: high latency for all reads, all writes bottlenecked through one primary region. *Eventual consistency* â€” reads can proceed immediately, data converges "eventually." Problem: a user in India might see their profile update from 1 minute ago for a few seconds after saving. Choose consistency for: financial transactions, inventory counts (overselling is bad). Choose eventual consistency for: user profiles, social feeds, notifications. Most systems use eventual consistency by default and strong consistency only where necessary.

**Q: You need to choose between a relational database and a document database for a new service. Walk through how you'd frame the trade-off analysis.**
**A:** Start with requirements: What are the query patterns? What's the data structure? What are the consistency requirements? Then:
*Relational (PostgreSQL):* Trade-offs: (+) Strong consistency, complex joins across tables, schema enforcement, mature tooling, ACID transactions. (-) Schema changes require migrations, sharding is complex, less flexible for varied document shapes.
*Document (MongoDB/DynamoDB):* Trade-offs: (+) Flexible schema for varied document shapes, horizontal scaling built-in, fast for single-document reads. (-) No multi-document transactions (or limited), no complex joins, no schema enforcement (data quality risk).
*Decision factor:* Do you have complex relational queries (join user + order + payment)? Use relational. Do you have highly variable document structures with massive scale? Use document. For most CRUD SaaS apps: PostgreSQL wins on reliability and developer experience.

**Q: How do you communicate a trade-off you disagree with after the decision is made? How do you "disagree and commit"?**
**A:** "Disagree and commit" means voicing your concern clearly once, ensuring it's heard and considered, and then fully supporting the final decision even if it wasn't yours. In practice: in the decision meeting, clearly articulate your concern and specific risk ("I think this increases our failure rate at > 1000 req/s because..."). If the decision goes the other way: "I understand the reasoning. I still think the risk is X, but I'll fully support this direction. Can we agree to revisit if we see [specific metric] degrade?" Document your concern in the ADR if appropriate. Then work wholeheartedly on the chosen approach. Sustained resistance after a decision destroys team cohesion.

---

**Advanced (System Design):**

**Scenario 1:** Your team is evaluating whether to add a message queue (SQS) between your API and your notification service, which currently calls the notification service synchronously. The product manager is asking "will this add latency to our checkout flow?" Explain the trade-off.

*Framework:*
Current (synchronous): API â†’ calls notification directly â†’ waits for response â†’ returns to user. Risk: if notification service is slow or down, checkout fails or is slow. Notification delivery is coupled to checkout latency.
*With SQS:* API â†’ publishes to SQS (5ms) â†’ returns to user immediately â†’ notification service reads from SQS asynchronously. 
*Trade-offs explained clearly:*
"The checkout response will actually be FASTER (50ms faster on average) because we no longer wait for the email to send. The trade-off is: you won't know instantly if an email failed to send â€” it'll be visible in the SQS dead-letter queue within 5 minutes, not within the checkout request. If the notification service goes down, emails queue up and are delivered when it recovers â€” users get their confirmation email slightly late rather than checkout failing entirely. For most users, this is a better experience."

**Scenario 2:** Walk through the trade-off between building an in-house authentication system vs integrating a third-party identity provider (Auth0, Cognito). Present this as you would in an engineering design review.

*Build in-house:*
(+) Full control over data and flow, no vendor dependency, cheaper at massive scale (no per-user fees).
(-) Must implement: password hashing, brute force protection, MFA, password reset, session management, JWT rotation, OAuth flows, security patching. Estimated 6 engineer-weeks for secure basic implementation. Any mistake = security breach. Must maintain forever.

*Third-party (Cognito/Auth0):*
(+) Battle-tested, MFA/OAuth/SAML out of the box, SOC 2 compliant, security patches handled by vendor.
(-) Vendor lock-in (migration is painful), costs scale with users (~.0055/MAU in Auth0), less control over UX.

*Recommendation:* For a startup or a team without security expertise: third-party. The 6 engineer-weeks is better spent on business logic. For a company with > 10M MAU or regulatory requirements for data residency: consider in-house with a dedicated security engineer. For most cases: Cognito if on AWS (tight integration, free tier generous), Auth0 if multi-cloud or advanced enterprise SSO features needed.

