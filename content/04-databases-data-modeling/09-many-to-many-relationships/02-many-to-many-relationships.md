# Many-to-Many Relationships — Part 2 of 3

### Sections: 5 (Bad vs Correct), 6 (Performance Impact), 7 (Concurrency), 8 (Optimization & Indexing)

**Series:** Databases & Data Modeling → Topic 09

---

## SECTION 5 — Bad Usage vs Correct Usage

### Pattern 1: Junction Table Without Bidirectional Indexes

```sql
-- ❌ BAD: Junction table with only one direction indexed
CREATE TABLE user_roles (
  user_id INT NOT NULL REFERENCES users(id),
  role_id INT NOT NULL REFERENCES roles(id),
  PRIMARY KEY (user_id, role_id)
);
-- PK index: (user_id, role_id) covers direction: "what roles does this user have?"
-- BUT: "what users have this role?" → must scan entire user_roles table.
-- For "who has ADMIN role?": SeqScan on user_roles (potentially millions of rows).

-- ✅ CORRECT: Add reverse direction index.
CREATE INDEX idx_user_roles_role ON user_roles(role_id, user_id);
-- "Who has ADMIN role?": Index scan on idx_user_roles_role WHERE role_id = $admin_id.
-- Both directions: O(log N).

-- ALSO FREQUENTLY MISSED: FK indexes.
-- FK from user_roles.role_id → roles.id.
-- DELETE FROM roles WHERE id = $role_id: needs to check user_roles for references.
-- Without idx_user_roles_role: full table scan. With it: fast lookup.
-- Double benefit: reverse direction index ALSO serves as FK check index.
```

### Pattern 2: Soft Delete in Junction Table Done Wrong

```sql
-- ❌ BAD: Adding deleted_at to junction with composite PK (creates ghost rows)
CREATE TABLE article_tags (
  article_id INT NOT NULL REFERENCES articles(id),
  tag_id     INT NOT NULL REFERENCES tags(id),
  deleted_at TIMESTAMPTZ,
  PRIMARY KEY (article_id, tag_id)
);
-- Soft-delete: UPDATE article_tags SET deleted_at = NOW() WHERE article_id=1 AND tag_id=5;
-- Re-tag: INSERT INTO article_tags (article_id, tag_id) VALUES (1, 5); → PK VIOLATION!
-- Cannot re-add a tag that was previously removed (PK collision with soft-deleted row).

-- ✅ CORRECT: Use active flag + separate unique constraint on active rows.
CREATE TABLE article_tags (
  id         BIGSERIAL PRIMARY KEY,  -- surrogate PK (avoids re-tagging collision)
  article_id INT NOT NULL REFERENCES articles(id),
  tag_id     INT NOT NULL REFERENCES tags(id),
  is_active  BOOL NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  removed_at TIMESTAMPTZ
);
-- Partial unique index: only ONE active row per (article, tag).
CREATE UNIQUE INDEX uq_article_tag_active ON article_tags(article_id, tag_id) WHERE is_active = TRUE;
-- Soft-delete: UPDATE article_tags SET is_active=FALSE, removed_at=NOW() WHERE id = $junction_id;
-- Re-tag: INSERT INTO article_tags (article_id, tag_id) → new row, is_active=TRUE. No collision.
-- History: all rows preserved. Full audit trail of tag additions and removals.
```

### Pattern 3: Extra Attributes on Junction Table Not First-Class Modeled

```sql
-- SCENARIO: Users can follow other users. But also: users can "mute" someone (don't see posts)
-- and "block" someone (no interaction at all).

-- ❌ BAD: Multiple nullable boolean columns on junction
CREATE TABLE user_connections (
  follower_id  INT NOT NULL REFERENCES users(id),
  following_id INT NOT NULL REFERENCES users(id),
  is_muted     BOOL DEFAULT FALSE,
  is_blocked   BOOL DEFAULT FALSE,
  PRIMARY KEY (follower_id, following_id)
);
-- Problem: semantics become unclear. is_blocked=TRUE AND is_muted=TRUE: which takes precedence?
-- New relationship type: is_close_friend=TRUE? Add another column? Schema grows unbounded.

-- ✅ CORRECT: Relationship type as enum column (first-class).
CREATE TYPE connection_type AS ENUM ('FOLLOWING', 'MUTED', 'BLOCKED', 'CLOSE_FRIEND');
CREATE TABLE user_connections (
  follower_id     INT NOT NULL REFERENCES users(id),
  following_id    INT NOT NULL REFERENCES users(id),
  connection_type connection_type NOT NULL DEFAULT 'FOLLOWING',
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (follower_id, following_id, connection_type)
  -- A user can both mute and block (different rows). Or just follow. Explicit.
);
-- OR: one row per user pair, with latest state (use soft delete + event log for history).
-- "Is A blocking B?": WHERE follower_id=$a AND following_id=$b AND connection_type='BLOCKED'.
-- Index on (connection_type, following_id) for notification filtering: fast.
```

---

## SECTION 6 — Performance Impact

### Junction Table Index Size vs Query Speed Trade-off

```
SETUP: articles (1M rows), tags (10K rows), article_tags (5M rows)
Avg tags per article: 5.

Indexes needed and sizes:
  PK (article_id, tag_id):  5M × (4+4) bytes + overhead = ~100MB
  Reverse (tag_id, article_id): 5M × (4+4) bytes + overhead = ~100MB
  Total junction indexes: ~200MB

QUERY: "All articles tagged 'react' (tag_id=42)"
  Index scan on (tag_id=42): finds ~50,000 article_ids.
  Time: ~5ms (index scan, likely cached).

QUERY: "All tags on article 100"
  Index scan on PK (article_id=100): finds ~5 tag_ids.
  Time: ~0.2ms.

WITHOUT REVERSE INDEX: "All articles tagged 'react'"
  SeqScan on article_tags: 5M rows.
  Time: ~500ms. 100x slower.
  At 100 tag searches/second: DB at 50,000ms/sec of scan work vs 500ms/sec.

WRITE OVERHEAD (2 indexes per junction row):
  INSERT into article_tags: updates PK index + reverse index.
  Extra: 1 additional B-tree insert per row vs single-direction index.
  At 500 tags added/second: 1,000 index inserts/second. Trivial.
  CONCLUSION: Always add reverse index. Write overhead is negligible. Read benefit is massive.
```

### N+1 Query Problem on M2M Traversal

```
SCENARIO: "List 100 articles with their tags" — ORM (Django, Hibernate, etc.)

N+1 PATTERN (bad):
  Query 1: SELECT * FROM articles LIMIT 100;   → returns 100 articles.
  Query 2: SELECT tag_name FROM tags JOIN article_tags ... WHERE article_id = 1;
  Query 3: SELECT tag_name FROM tags JOIN article_tags ... WHERE article_id = 2;
  ...
  Query 101: ... WHERE article_id = 100.
  Total: 101 queries. 100 round trips. Each ~0.5ms. Total: ~50ms.
  At page load requiring 10 such widgets: 1,010 queries. 500ms latency.

JOINed approach (correct):
  SELECT a.id, a.title, t.name AS tag_name
  FROM articles a
  JOIN article_tags at ON at.article_id = a.id
  JOIN tags t ON t.id = at.tag_id
  WHERE a.id = ANY($article_ids);   -- $article_ids = [1, 2, ..., 100]
  → 1 query returning 500 rows (100 articles × 5 tags avg). ~3ms.

  ORM solution (Postgres): "prefetch_related" / "eager loading" / "includes" in your ORM.
  These use "WHERE id IN (...)" or JOIN to batch-load relations. 1-2 queries instead of N+1.
  Always enable eager loading for M2M relations in list views.
```

---

## SECTION 7 — Concurrency

### Race Condition on Junction Table (Duplicate Insertions)

```
CONCURRENT ENROLLMENT SCENARIO:
  Two requests simultaneously try to enroll student 42 in course 99.

  Thread 1: INSERT INTO enrollments (student_id, course_id) VALUES (42, 99);
  Thread 2: INSERT INTO enrollments (student_id, course_id) VALUES (42, 99);

  WITHOUT unique constraint (or PK): both succeed → two enrollment rows. Fee charged twice.

  WITH PK (student_id, course_id):
    Both threads race. One succeeds, one gets PK violation.
    Application: catch the violation, treat as "already enrolled." Clean.

  IDEMPOTENT INSERT PATTERN (application doesn't need to handle exception):
  INSERT INTO enrollments (student_id, course_id, enrolled_at)
  VALUES (42, 99, NOW())
  ON CONFLICT (student_id, course_id) DO NOTHING;
  -- Safe to call multiple times. First succeeds. Subsequent calls: silently no-op.

ENROLLMENT WITH CAPACITY CHECK (concurrent seat race):
  Problem: course_99 has max 30 seats. 31 concurrent enrollment attempts.

  ❌ WRONG:
    Read count: SELECT COUNT(*) FROM enrollments WHERE course_id=99;  → 29 (each thread sees)
    If < 30: Insert. Both threads insert at same time → 31 enrollments.

  ✅ CORRECT: Use advisory lock or SELECT FOR UPDATE on the capacity counter.
  BEGIN;
  SELECT seats_remaining FROM courses WHERE id = 99 FOR UPDATE;  -- locks this row
  IF seats_remaining > 0:
    INSERT INTO enrollments (student_id, course_id) VALUES (42, 99);
    UPDATE courses SET seats_remaining = seats_remaining - 1 WHERE id = 99;
  COMMIT;
  -- FOR UPDATE: second concurrent transaction waits until first commits.
  -- After first commits: second sees updated seats_remaining. If 0: rejects. Never oversells.
```

---

## SECTION 8 — Optimization & Indexing

### Covering Index for M2M Hot Path

```sql
-- HOT QUERY: News feed. "Get the 20 most recent articles in categories the user follows."
-- User follows categories via user_category_follows (user_id, category_id) junction.

SELECT a.id, a.title, a.published_at, a.thumbnail_url
FROM articles a
JOIN article_categories ac ON ac.article_id = a.id
JOIN user_category_follows ucf ON ucf.category_id = ac.category_id
WHERE ucf.user_id = $1
  AND a.published_at > NOW() - INTERVAL '7 days'
ORDER BY a.published_at DESC
LIMIT 20;

-- INDEX REQUIREMENT:
-- 1. ucf: lookup by user_id → categories they follow:
CREATE INDEX idx_ucf_user ON user_category_follows(user_id, category_id);
-- Covers: user_id lookup, returns category_ids.

-- 2. ac: lookup articles by category_id:
CREATE INDEX idx_ac_category ON article_categories(category_id, article_id);
-- Covers: category_id → article_ids.

-- 3. articles: filter by published_at (for 7-day window) + sort:
CREATE INDEX idx_articles_published ON articles(published_at DESC)
WHERE published_at > (NOW() - INTERVAL '30 days');  -- partial index: only recent
-- Partial index: avoids indexing 5-year-old article archive.
-- Size: small (7-30 day window). Fits in RAM. Fast.

-- 4. COVERING: include columns needed by SELECT (avoid heap reads on articles):
CREATE INDEX idx_articles_feed_covering ON articles(published_at DESC)
INCLUDE (id, title, thumbnail_url)
WHERE published_at > (CURRENT_DATE - 30);
-- Index Only Scan on articles. No heap reads.

-- PLAN SHAPE:
Limit (rows=20)
  -> Nested Loop
     -> Nested Loop
        -> Index Scan on user_category_follows (user_id = $1)  → 15 categories
        -> Index Scan on article_categories (category_id = each)  → ~500 articles
     -> Index Only Scan on articles (published_at range, sorted)  → filter + top-20
```

### Polymorphic M2M (Tag Any Entity Type)

```sql
-- GOAL: Tags can apply to articles, videos, AND podcasts (multiple entity types).

-- ❌ BAD: One junction table per entity type
CREATE TABLE article_tags (article_id INT, tag_id INT, PRIMARY KEY (article_id, tag_id));
CREATE TABLE video_tags   (video_id   INT, tag_id INT, PRIMARY KEY (video_id, tag_id));
CREATE TABLE podcast_tags (podcast_id INT, tag_id INT, PRIMARY KEY (podcast_id, tag_id));
-- Adding new content type: add new junction table. Schema sprawl.
-- "All content tagged 'react'": UNION of three queries. Slow. Complex.

-- ✅ CORRECT: Polymorphic junction table
CREATE TABLE content_tags (
  tag_id      INT NOT NULL REFERENCES tags(id),
  entity_type TEXT NOT NULL,  -- 'article', 'video', 'podcast'
  entity_id   INT NOT NULL,
  tagged_at   TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (tag_id, entity_type, entity_id)
);
CREATE INDEX idx_content_tags_entity ON content_tags(entity_type, entity_id, tag_id);

-- "All content tagged 'react'":
SELECT entity_type, entity_id FROM content_tags WHERE tag_id = $react_tag_id;
-- Single query. All entity types. Extending to new type: just INSERT with new entity_type value.

-- "All tags on article 100":
SELECT t.name FROM tags t
JOIN content_tags ct ON ct.tag_id = t.id
WHERE ct.entity_type = 'article' AND ct.entity_id = 100;

-- TRADEOFF: Cannot enforce FK from entity_id to the correct table (entity_id is untyped).
-- Missing FK enforcement: compensate with application-level validation + check trigger.
-- OR: Use separate tables per type (more FK safety, less flexibility).
-- DECISION: polymorphic if types unknown/extensible. Separate tables if types known and stable.
```
