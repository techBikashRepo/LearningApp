# Many-to-Many Relationships — Part 3 of 3

### Sections: 9 (AWS Mapping), 10 (Interview Questions), 11 (Debugging Exercise), 12 (Architect's Mental Model)

**Series:** Databases & Data Modeling → Topic 09

---

## SECTION 9 — AWS Service Mapping

### Many-to-Many Relationships Across AWS Data Services

```
RDS / AURORA (PostgreSQL):
  JUNCTION TABLE PATTERN:
    Standard junction table with bidirectional indexes.
    Composite PK: (left_fk, right_fk) covers left-to-right traversal.
    Supplemental index: (right_fk, left_fk) covers right-to-left traversal.

  CASCADE OPTIONS ON JUNCTION TABLE:
    ON DELETE CASCADE from BOTH parents is standard:
      If user deleted → all their roles auto-deleted from user_roles.
      If role deleted → all user_role assignments auto-deleted.
    Junction: if you want to audit deletions, use soft-delete on junction instead of CASCADE.

  EXTRA ATTRIBUTES ON JUNCTION:
    Junction tables become full first-class entities when they gain attributes:
      user_roles: (user_id, role_id) is a pure junction.
      user_roles: (user_id, role_id, granted_at, granted_by, expires_at) → now it's an entity.
    When junction has attributes: add a surrogate PK (id BIGSERIAL).
    Plus: UNIQUE(user_id, role_id) to preserve the duplicate-prevention behavior.

DYNAMODB:
  ADJACENCY LIST PATTERN — the DynamoDB M2M standard.

  Problem being solved:
    Traditional M2M junction requires two queries (look up both directions) OR a JOIN.
    DynamoDB: no JOINs. Must design for both access patterns in the table itself.

  Adjacency List Schema:
    One table: entities (same table for all entity types).
    PK = entity_id, SK = entity_id OR relationship_id

    Example: "Users ↔ Projects" M2M.

    Item type 1 (User entity):
      PK = "USER#u1", SK = "PROFILE", data: {name: "Alice", email: ...}

    Item type 2 (Project entity):
      PK = "PROJ#p1", SK = "METADATA", data: {name: "Apollo", owner: ...}

    Item type 3 (Membership — M2M relationship):
      PK = "USER#u1", SK = "PROJ#p1", data: {role: "editor", joined_at: "2024-01"}
      Access: Query PK = "USER#u1", SK begins_with "PROJ#" → all of Alice's projects.

    Item type 4 (Inverted membership — GSI reverse traversal):
      GSI PK = "PROJ#p1", GSI SK = "USER#u1"
      Access: Query GSI PK = "PROJ#p1" → all users in the Apollo project.

  GSI FOR REVERSE TRAVERSAL:
    Add a GSI: GSI-PK = relationship_type + right_entity_id, GSI-SK = left_entity_id.
    Primary table: answers "what projects does user X belong to?"
    GSI: answers "what users belong to project Y?"
    No second table needed. One GSI = second access direction.

  RELATIONSHIP ATTRIBUTES:
    M2M relationship item: store all relationship metadata here.
    Role, join date, permissions, status — all in the membership item.
    Same as extra attributes on a junction table in relational DB (but they live in the item itself).

NEPTUNE (Graph Database):
  Native M2M: Edges between Vertex nodes.
  No junction table. No separate join operation. Edges ARE the relationship.

  Vertex per entity: user, project, tag, product.
  Edge per relationship: HAS_TAG, BELONGS_TO, FOLLOWS.
  Edge properties: role, weight, created_at — stored directly on the edge.

  Query (Gremlin): "Find all users in the same project as user_id 42"
    g.V('user-42')
     .out('BELONGS_TO')           // → Alice's projects
     .in('BELONGS_TO')            // → all users who share those projects
     .dedup()
     .values('name')

  SQL equivalent: two JOINs through junction table + DISTINCT + GROUP BY.
  Neptune for: social graphs, access control graphs, fraud networks, product recommendation.
  Overhead: write-heavy workloads require more careful capacity planning (RCU/WCU per traversal).
  Not appropriate for: OLAP aggregations, financial ledgers — use Aurora for those.

ELASTICACHE (Redis):
  REDIS SETS FOR M2M MEMBERSHIP:
    Use Redis Sets (SADD, SMEMBERS, SISMEMBER) for M2M lookups when DB would be too slow.

    Cache user's projects:
      Key: "user:1001:projects" → SET {p1, p2, p3}
      Key: "project:p1:users"  → SET {u1001, u1002, u1003}

    Check if user is in project:
      SISMEMBER "project:p1:users" "u1001" → O(1) average.

    Get all projects for user:
      SMEMBERS "user:1001:projects" → returns set members. O(N) where N = member count.

    Set intersection (common members of two projects):
      SINTERSTORE "result" "project:p1:users" "project:p2:users" → O(N*M) but cached result.

    Cache invalidation: on junction table change (INSERT/DELETE), update both Redis sets.
    Or: TTL-based expiry (eventually consistent) — acceptable for soft membership checks.
    Not acceptable for: authorization (access checks must be authoritative, not cached).

OPENSEARCH (Elasticsearch):
  M2M via NESTED DOCUMENTS:
    A post with multiple tags: nested objects in a single document.
    Avoids document explosion (one post → one document, even with 50 tags).

    Nested query: exact field matching within the same nested object (atomically).
    Array query (without nested): would match across different array elements → false positives.

    Example: post has tags: [{name: "java", confidence: 0.9}, {name: "python", confidence: 0.6}]
    Without nested: "high-confidence java" query might match "low-confidence java" (0.6 threshold from python row).
    With nested: each tag is a sub-document with its own context. Query scoped to one tag object.

    Cost: nested documents: more storage, slower writes (must reindex entire parent document on tag change).
    Parent-child join type: similar to relational FK. Slower than nested for most read patterns.
    Best practice: denormalize and use nested for read-heavy M2M in OpenSearch.
```

---

## SECTION 10 — Interview Questions

### Beginner Questions

**Q1: What is a many-to-many relationship and how do you model it in a relational database?**

> A many-to-many relationship exists when a single row in table A can relate to multiple rows
> in table B, AND a single row in table B can relate to multiple rows in table A.
> Example: students and courses — a student takes many courses, a course has many students.
> In a relational database, you cannot directly represent this with a foreign key in either
> table (a FK is one-to-many). The standard solution is a junction table (also called an
> associative table or bridge table) with two foreign keys — one pointing to each parent table.
> The junction table has one row per relationship pair.
> Schema: students(id), courses(id), enrollments(student_id → students, course_id → courses).
> The pair (student_id, course_id) is typically the composite PK of the junction table,
> ensuring the same enrollment can't be duplicated.

**Q2: What indexes are required on a junction table and why?**

> A junction table with columns (left_fk, right_fk) needs two indexes:
> Index 1: (left_fk, right_fk) — answers "what right-side entities does this left entity have?"
> If this is the composite PK: the PK index covers this direction automatically.
> Index 2: (right_fk, left_fk) — answers "what left-side entities does this right entity have?"
> This is NOT created automatically. Must be added manually.
> Without index 2: any query traversing the relationship from right-to-left requires a full
> sequential scan of the entire junction table — for every row on the right side.
> For a junction table with 100M rows: missing the reverse-direction index means every "what users
> have role X?" query scans 100M rows instead of using an O(log N) index lookup.
> Both directions are typically queried in production applications. Both indexes are required.

**Q3: Why shouldn't you store tags as a comma-separated string in a database column?**

> Storing tags as CSV (e.g., tags = "sql,performance,database") violates first normal form
> (1NF) — a column should hold a single atomic value, not a list.
> Problems this creates:
> (1) No index-supported search: WHERE tags LIKE '%sql%' → full table scan. No index can help.
> (2) No FK integrity: can't delete a tag from the tags table and have the CSV updated atomically.
> (3) No count queries: "how many posts use the 'sql' tag?" requires parsing every CSV value.
> (4) No sorting by tag: can't sort by individual tag properties.
> (5) Update race conditions: two concurrent tag additions must read-modify-write the entire field.
> The relational fix is a junction table: (post_id, tag_id) with standard M2M pattern and indexes.
> NoSQL fix (DynamoDB): store tags as a Set type attribute with GSI for reverse lookup.

### Intermediate Questions

**Q4: Your junction table has soft-delete (an `is_active` column). A user de-tags a post, then re-tags it with the same tag. How do you handle the PK collision, and what's the correct schema design?**

> With composite PK (post_id, tag_id) + is_active boolean:
> Sequence: tag → PK (post, tag) inserted. De-tag → is_active = FALSE. Re-tag → INSERT fails
> because (post_id, tag_id) already exists (PK violation).
> Wrong fix: change is_active = TRUE on re-insert. Requires SELECT + UPDATE — not elegant and race-prone.
> Correct schema design option 1: Remove the composite PK. Replace with surrogate PK + partial unique index:
> id BIGSERIAL PRIMARY KEY,
> post_id INT REFERENCES posts(id),
> tag_id INT REFERENCES tags(id),
> is_active BOOLEAN DEFAULT TRUE,
> UNIQUE (post_id, tag_id) WHERE is_active = TRUE
> Now: two rows with same (post, tag) are allowed as long as at most one is active.
> Re-tag: INSERT new row with is_active = TRUE. Clean audit history. No PK collision.
> Option 2: Physical deletion from junction + retain history in separate audit/event table.
> Better separation: current state (junction) vs history (audit). Simpler queries on current state.

**Q5: What is the N+1 query problem in the context of M2M relationships, and how do you solve it?**

> N+1 occurs when you retrieve N parent records and then issue one additional query per record
> to retrieve its related children — totaling N+1 database round trips.
> M2M example: retrieve 100 posts, then for each post: SELECT tags WHERE post_id = ?
> → 101 queries: 1 for posts + 100 for tags. Network + DB overhead × 100.
>
> Solution 1 — JOIN-based: single query with JOIN:
> SELECT p.id, p.title, t.name AS tag
> FROM posts p
> JOIN post_tags pt ON pt.post_id = p.id
> JOIN tags t ON t.id = pt.tag_id
> WHERE p.id = ANY($ids)
> ORDER BY p.id, t.name;
> Application: group rows by post.id and collect tag names. 1 query → all data.
>
> Solution 2 — Batched 2-query approach (ORM-friendly):
> Query 1: SELECT _ FROM posts WHERE id = ANY($ids) → 100 rows
> Query 2: SELECT pt.post_id, t._ FROM post_tags pt JOIN tags t ON t.id = pt.tag_id
> WHERE pt.post_id = ANY($post_id_array) → all tags in 1 query
> Application: assemble map post_id → tags. 2 queries. Scales to thousands of posts.
> Rails: includes(:tags). Django: prefetch_related('tags'). Both generate 2 queries.

### Advanced Questions

**Q6: Design a DynamoDB schema for a social following system where users can follow other users, and you need to efficiently answer: "Get all users that user A follows" AND "Get all followers of user B".**

> Single-table design with adjacency list:
>
> PK = "USER#<user_id>", SK = "FOLLOWER#<followed_user_id>"
> These items represent the "A follows B" relationship.
>
> GSI: GSI-PK = "USER#<followed_user_id>", GSI-SK = "FOLLOWER#<user_id>"
> The same item, but with the relationship inverted in the GSI.
>
> Access pattern 1 — "Who does user A follow?":
> Query primary table: PK = "USER#A", SK begins_with "FOLLOWER#"
> → All follow items where A is the follower. SK contains the followed user IDs.
>
> Access pattern 2 — "Who follows user B?":
> Query GSI: GSI-PK = "USER#B", GSI-SK begins_with "FOLLOWER#"
> → All follow items where B is the followed user. SK contains follower user IDs.
>
> Relationship attributes (stored on the item):
> followed_at: timestamp. mutual: boolean. notification_enabled: boolean.
> These live in the M2M item itself — equivalent to junction table attributes.
>
> Counts (follower/following counts):
> Separate counter items: UPDATE users_table SET follower_count = follower_count + 1
> Using DynamoDB atomic ADD expression. Avoids read-modify-write race conditions.
> Or: DynamoDB Streams → Lambda to maintain count. Eventual consistency 100-300ms.

---

## SECTION 11 — Debugging Exercise

### Scenario: Tag-Based Product Search Running Full Table Scans

```
SYMPTOMS:
  - E-commerce platform, product catalog: 2.8M products.
  - Product tags: stored as comma-separated text in products.tags column.
    Example: tags = "electronics,gadgets,portable,bluetooth,audio"
  - Search API: "find all products tagged 'wireless'"
  - Query: SELECT * FROM products WHERE tags LIKE '%wireless%';
  - Response time: 4.2 seconds.
  - At launch: 5 products. Today: 2.8M products. Was fast "back then."
  - DBA has never touched the schema.

INVESTIGATION:

Step 1: Explain the query.
  EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM products WHERE tags LIKE '%wireless%';

  -> Seq Scan on products  (cost=0.00..485320.00  rows=28000 width=842)
     Filter: ((tags)::text ~~ '%wireless%'::text)
     Rows Removed by Filter: 2,771,844
     Buffers: shared hit=12847 read=97215  (109K buffer reads)
     Execution time: 4187.312 ms

  Finding: Full sequential scan of 2.8M rows. 97K disk reads.
  The leading wildcard (LIKE '%wireless%') prevents index use on any B-tree index.
  No index can help a leading wildcard. The query must evaluate every row.

Step 2: Quantify the current tag schema.
  SELECT MAX(array_length(string_to_array(tags, ','), 1)) AS max_tags,
         AVG(array_length(string_to_array(tags, ','), 1)) AS avg_tags,
         COUNT(*) AS total_products
  FROM products;
  -- max_tags: 47, avg_tags: 8.4, total_products: 2,800,000
  -- Total tag assignments: ~23M (2.8M × 8.4 avg)

  How many distinct tags?
  SELECT COUNT(DISTINCT unnest(string_to_array(tags, ',')))...
  -- ~12,400 distinct tags.

MIGRATION PLAN:

Step 1: Create proper schema.
  CREATE TABLE tags (
    id       SERIAL PRIMARY KEY,
    name     VARCHAR(100) NOT NULL,
    slug     VARCHAR(100) NOT NULL,
    UNIQUE(slug)
  );

  CREATE TABLE product_tags (
    product_id  INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    tag_id      INT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (product_id, tag_id)
  );
  CREATE INDEX idx_product_tags_tag ON product_tags(tag_id, product_id);

Step 2: One-time migration.
  -- Populate tags table from distinct values:
  INSERT INTO tags (name, slug)
  SELECT DISTINCT trim(t.tag), lower(trim(t.tag))
  FROM products p, unnest(string_to_array(p.tags, ',')) AS t(tag)
  ON CONFLICT (slug) DO NOTHING;

  -- Populate junction table:
  INSERT INTO product_tags (product_id, tag_id)
  SELECT p.id, t.id
  FROM products p
  CROSS JOIN LATERAL unnest(string_to_array(p.tags, ',')) AS tag_name
  JOIN tags t ON t.slug = lower(trim(tag_name))
  ON CONFLICT DO NOTHING;
  -- Duration: ~4 minutes for 23M rows. Run in background, not during peak hours.

Step 3: Query rewrite.
  -- NEW query: indexed M2M lookup
  SELECT p.*
  FROM products p
  JOIN product_tags pt ON pt.product_id = p.id
  JOIN tags t ON t.id = pt.tag_id
  WHERE t.slug = 'wireless';

  EXPLAIN output:
  -> Index Scan using idx_product_tags_tag on product_tags  (cost=0.44..2.68 rows=847)
     Index Cond: (tag_id = 1247)
  -> Index Scan using products_pkey on products  (cost=0.44..0.51 rows=1)
  Execution time: 12.3 ms

RESULT:
  Before: 4,187ms — SeqScan on 2.8M rows.
  After:   12ms   — Index scan on 847 matching product_tags rows.
  Improvement: 340× faster.

Step 4: Tag statistics (bonus) — now trivial because schema is correct.
  SELECT t.name, COUNT(*) AS product_count
  FROM tags t
  JOIN product_tags pt ON pt.tag_id = t.id
  GROUP BY t.id, t.name
  ORDER BY product_count DESC
  LIMIT 20;
  -- Executes in 180ms (23M rows aggregated with index). Was impossible with CSV pattern.

Step 5: Deprecate old column.
  ALTER TABLE products DROP COLUMN tags;  -- After validating new schema matches exactly.
```

---

## SECTION 12 — Architect's Mental Model

```
=== Architect's Mental Model: Many-to-Many Relationships ===

DECISION RULE 1: Any M2M relationship requires a junction table. No exceptions in relational DBs.
  CSV in a column: breaks indexes, breaks FKs, breaks counts, breaks sorting.
  Array column (Postgres {tag1,tag2}): better than CSV but still lacks FK, harder to join.
  Junction table: full index support, FK integrity, relationship attributes, all queries supported.
  The moment you need ANY of these: search, count, sort, FK, extra attributes → junction table.

DECISION RULE 2: Every junction table requires TWO directional indexes. Always.
  (left_fk, right_fk): covers left→right traversal. The composite PK covers this if PK exists.
  (right_fk, left_fk): covers right→left traversal. Must be added manually.
  Missing the reverse index: full-table scan on every reverse traversal. Discovered in production,
  usually under load, usually at 3am. Add both indexes in the same migration that creates the table.

DECISION RULE 3: Extra attributes on junction table = junction is a first-class entity.
  Once a junction table has: created_at, status, created_by, role, permissions, expires_at,
  it is no longer "just a junction" — it is an entity in its own right.
  Promote it: give it a surrogate PK (id BIGSERIAL), a semantic name (enrollment, membership,
  assignment), and maintain its own lifecycle (soft-delete, event log).

DECISION RULE 4: Soft-delete on junction requires partial unique index, not composite PK.
  Composite PK + is_active: re-insert same pair = PK violation. Prevents legitimate re-tagging.
  Solution: surrogate PK + UNIQUE(left_fk, right_fk) WHERE is_active = TRUE (partial index).
  Inactive rows: allowed to be re-created. Active rows: still unique. No data loss, no collision.
  This pattern applies to any M2M with soft-delete semantics.

DECISION RULE 5: In DynamoDB, M2M = adjacency list pattern + GSI for reverse direction.
  Primary table: covers the "natural" access direction.
  GSI: covers the "reverse" access direction.
  Relationship attributes: stored in the relationship item itself (not in a separate table).
  Both parties' entity items also live in the same table (single-table design).
  Redis Sets: fast in-memory M2M membership cache for hot access patterns.

COMMON MISTAKE 1: Storing M2M as CSV or array in a column.
  "We'll fix it later" — you won't. 50K rows becomes 50M rows. Migration becomes multi-hour outage.
  Model M2M correctly from day one. The junction table is three lines of SQL. There is no excuse.

COMMON MISTAKE 2: Missing reverse-direction index.
  Application initially queries only one direction → reverse index forgotten.
  Feature added 6 months later uses the reverse direction → full table scan on 100M rows.
  The index was supposed to be there from day one. Add it in the same migration. Every time.

COMMON MISTAKE 3: Surrogate PK without UNIQUE constraint on (left_fk, right_fk).
  id BIGSERIAL + no unique constraint: same pair can be inserted N times.
  user_id=1 can have tag_id=5 recorded 47 times. COUNT queries return wrong numbers.
  If you use a surrogate PK on a junction table: the UNIQUE constraint on the two FK columns
  is not optional — it IS the duplicate-protection that the composite PK normally provided.
  Always: PRIMARY KEY (id) + UNIQUE(left_fk, right_fk) [optionally partial if soft-delete].

30-SECOND INTERVIEW ANSWER (Why is a junction table better than storing relationships as a CSV string?):
  "A comma-separated string like 'sql,performance,database' is a list encoded inside a single
  column, which breaks the relational model entirely. You can't index it — any search requires
  a full table scan with a LIKE operator. You can't enforce referential integrity with foreign keys
  because the database has no way to parse the individual values inside the string. You can't
  count how many products have each tag without scanning every row and parsing every string.
  A junction table solves all of this: two foreign keys, two directional indexes, proper
  uniqueness constraint. Every access pattern — search by tag, list tags for a product,
  count product per tag, find products sharing multiple tags — is supported with sub-millisecond
  index lookups. The junction table is three lines of SQL that unlocks every M2M operation properly."
```
