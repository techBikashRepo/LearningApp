# Many-to-Many Relationships — Part 1 of 3

### Sections: 1 (Intuition), 2 (Why This Exists), 3 (Internal Working), 4 (Query Execution Flow)

**Series:** Databases & Data Modeling → Topic 09

---

## SECTION 1 — Intuition: The University Enrollment System

A university has students and courses. One student can enroll in many courses. One course can have many students. Neither table "owns" the relationship. You cannot put course_id in students (a student has many courses — you'd need an array or repeated columns). You cannot put student_id in courses (same problem). The relationship is a first-class entity: **an enrollment**.

```
THE RELATIONAL SOLUTION — JUNCTION TABLE:

  students (id, name, email)
  courses  (id, title, credits)
  enrollments (student_id, course_id, enrolled_at, grade)  ← junction table
                    ^FK              ^FK

  • enrollments.student_id → students.id (FK)
  • enrollments.course_id  → courses.id  (FK)
  • PRIMARY KEY: (student_id, course_id)  -- or a surrogate ID + unique constraint

  "What courses is student Alice taking?"
  SELECT c.title FROM courses c
  JOIN enrollments e ON e.course_id = c.id
  WHERE e.student_id = (SELECT id FROM students WHERE name = 'Alice');

  "Who is enrolled in Database Design 101?"
  SELECT s.name FROM students s
  JOIN enrollments e ON e.student_id = s.id
  WHERE e.course_id = (SELECT id FROM courses WHERE title = 'Database Design 101');

THE JUNCTION TABLE IS NOT JUST A PIVOT — IT HAS ITS OWN ATTRIBUTES:
  enrolled_at: when did Alice sign up for this course?
  grade:        what grade did Alice achieve?
  status:       'ACTIVE', 'DROPPED', 'WAITLISTED'
  payment_ref:  FK to payments (Alice paid for this specific enrollment)

  These attributes BELONG to the relationship, not to either side.
  They cannot live in students or courses tables — that would be a design error.

ARCHITECT'S FRAME:
  Whenever you think "this thing has many of those things, and that thing has many of these things":
  → You need a junction table.
  → That junction table almost always has its own temporal and state attributes.
  → Model it as a full entity — give it a proper name (Enrollment, Membership, Assignment, Subscription).
  → Avoid array-based approaches (PostgreSQL arrays, comma-separated lists) unless you have a very specific read-only use case with no lookup requirements.
```

---

## SECTION 2 — Why This Exists: Production Failures

### Failure 1: Tags Stored as Comma-Separated String

```
INCIDENT: Content platform. Articles have tags for filtering.

ORIGINAL SCHEMA:
  articles (id, title, body, tags TEXT DEFAULT '')
  -- tags value: 'javascript,react,performance,typescript'

QUERIES NEEDED:
  "Find all articles tagged 'react'"
  SELECT * FROM articles WHERE tags LIKE '%react%';
  -- Catastrophic: no index can help LIKE '%react%'.
  -- 5M articles: full sequential scan every tag lookup.
  -- Also: 'ract' in 'react' matches. 'react-native' matches for 'react'. False positives.

  "How many articles per tag?"
  SELECT tag, COUNT(*) FROM ???
  -- Impossible without string splitting. Requires application-side split and re-aggregation.
  -- PostgreSQL: string_to_array + unnest → expensive, unindexed.

  "Rename tag 'javascript' to 'js'"
  UPDATE articles SET tags = REPLACE(tags, 'javascript', 'js');
  -- Rewrites every row that has 'javascript'. 2M rows: 2M heap writes.
  -- Table bloat. 2-hour table rewrite. Full autovacuum cycle needed.

  "Delete the tag 'deprecated-api' from all articles"
  -- Same nightmare: pattern matching + UPDATE on millions of rows.

CORRECT SCHEMA:
  CREATE TABLE tags (id SERIAL PRIMARY KEY, name TEXT UNIQUE);
  CREATE TABLE article_tags (
    article_id INT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    tag_id     INT NOT NULL REFERENCES tags(id)     ON DELETE CASCADE,
    PRIMARY KEY (article_id, tag_id)
  );
  CREATE INDEX idx_article_tags_tag ON article_tags(tag_id);  -- for tag→articles lookups

  "Find all articles tagged 'react'"
  SELECT a.* FROM articles a
  JOIN article_tags at ON at.article_id = a.id
  JOIN tags t ON t.id = at.tag_id
  WHERE t.name = 'react';
  -- Two index lookups + small result join. Milliseconds.

  "Rename tag"
  UPDATE tags SET name = 'js' WHERE name = 'javascript';
  -- One row update. Propagates everywhere via FK. Instant.
```

### Failure 2: Polymorphic M2M via Application Arrays

```
INCIDENT: Permissions system. Users have roles. Roles have permissions.
But also: users can have direct permissions (bypassing roles).

DESIGN (anti-pattern):
  users table: role_ids INT[] (Postgres array), permission_ids INT[]

PROBLEM 1: Query performance.
  "Find all users with permission 'EXPORT_DATA'"
  SELECT * FROM users WHERE 42 = ANY(permission_ids);
  -- GIN index can help, but cardinality estimation is poor.
  -- Query planner often gets row estimates wrong → suboptimal join plans downstream.

PROBLEM 2: Referential integrity.
  permission_ids = [42, 99, 9999]
  DELETE FROM permissions WHERE id = 99;
  -- Array: still contains 99. No FK enforcement on array elements.
  -- Orphaned permission ID in user's array → silent data corruption.
  -- Application queries permission 99 → not found → bug.
  -- Which users are broken? SELECT * FROM users WHERE 99 = ANY(permission_ids) → 47,000 users.

PROBLEM 3: Add attributes to the relationship.
  "When was this permission granted to this user? Who granted it? When does it expire?"
  Impossible with array approach. The relationship has no place to store metadata.

CORRECT DESIGN:
  user_permissions (user_id, permission_id, granted_at, granted_by, expires_at, is_direct BOOL)
  user_roles       (user_id, role_id, assigned_at, assigned_by, expires_at)
  role_permissions (role_id, permission_id, granted_at)

  Full audit trail. FK enforcement. Rich relationship attributes. Proper indexing.
```

### Failure 3: Duplicate M2M Rows from Race Condition

```sql
-- PROBLEM: Two API requests concurrently add the same tag to the same article.
-- Without proper constraint: duplicate rows in article_tags.

-- Thread 1: INSERT INTO article_tags (article_id, tag_id) VALUES (555, 99);
-- Thread 2: INSERT INTO article_tags (article_id, tag_id) VALUES (555, 99);  -- race
-- Both succeed if no PK or UNIQUE constraint → duplicate rows.

-- Result: tag shows twice in article's tag list.
-- Count queries: doubled for this article/tag combo.
-- Application deduplication: bandaid, not fix.

-- FIX 1: Composite Primary Key enforces uniqueness at DB level.
ALTER TABLE article_tags ADD PRIMARY KEY (article_id, tag_id);
-- DUPLICATE insert → PRIMARY KEY violation → second INSERT fails.

-- FIX 2: INSERT ... ON CONFLICT DO NOTHING (idempotent insert)
INSERT INTO article_tags (article_id, tag_id) VALUES (555, 99)
ON CONFLICT (article_id, tag_id) DO NOTHING;
-- Safe in concurrent environment. No error, no duplicate.

-- FIX 3: If junction table has a surrogate PK:
-- Must add UNIQUE constraint on (article_id, tag_id) separately.
ALTER TABLE article_tags ADD CONSTRAINT uq_article_tag UNIQUE (article_id, tag_id);
-- Surrogate PK alone does NOT prevent duplicate (article_id, tag_id) pairs.
-- Common mistake: add surrogate ID, forget UNIQUE constraint → duplicates possible.
```

---

## SECTION 3 — Internal Working

### Composite PK vs Surrogate PK on Junction Table

```
OPTION A: Composite Primary Key
  PRIMARY KEY (article_id, tag_id)

  B-tree index created: entries sorted by (article_id, tag_id).

  LOOKUP "what tags does article 555 have?":
    Prefix scan: WHERE article_id = 555. Uses leftmost part of index. Very fast.
    Returns all (555, X) entries in order. Excellent.

  LOOKUP "what articles have tag 99?":
    Cannot use (article_id, tag_id) index for tag_id prefix scan.
    Needs SEPARATE INDEX on (tag_id, article_id).
    Without it: full table scan on article_tags.

  STRATEGY with composite PK:
    PK:       (article_id, tag_id)  → serves article→tags direction
    Index:    (tag_id, article_id)  → serves tag→articles direction
    Result:   both traversal directions are O(log N).

OPTION B: Surrogate Primary Key
  id BIGSERIAL PRIMARY KEY,
  article_id INT NOT NULL,
  tag_id     INT NOT NULL,
  CONSTRAINT uq_article_tag UNIQUE (article_id, tag_id)

  Pros:
    - Simpler for ORMs (Hibernate, ActiveRecord expect single integer PK)
    - External references can point to the junction row by ID
    - If junction table has many attributes (grades, timestamps, status),
      surrogate ID is clearer as a "first-class entity"

  Cons:
    - 8 extra bytes per row (BIGINT PK)
    - Must manually add UNIQUE constraint (easy to forget → duplicates)
    - Two indexes instead of one composite (slightly more write overhead)

  INDEX REQUIREMENTS:
    PK index:   (id) — auto-created
    Unique idx: (article_id, tag_id) — covers article→tags direction
    Separate:   (tag_id, article_id) — covers tag→articles direction

DATABASE BEHAVIOR DIFFERENCE:
  PostgreSQL: heap-based, both approaches perform similarly.
  MySQL InnoDB: CLUSTERED on PK. Composite PK = rows physically ordered by (article_id, tag_id).
    article→tags direction: optimal (clustered scan).
    tag→articles direction: still needs separate index.
    Surrogate PK: clustered on meaningless ID → neither direction is clustered → both need indexes.
```

### Self-Referential Many-to-Many

```sql
-- Use case: "Followers" — users follow other users. Both sides are users.
-- "Friends" — symmetric. Both sides are users. Order may or may not matter.

-- FOLLOWERS (asymmetric — Alice follows Bob, Bob may not follow Alice):
CREATE TABLE follows (
  follower_id INT NOT NULL REFERENCES users(id),
  following_id INT NOT NULL REFERENCES users(id),
  followed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (follower_id, following_id),
  CHECK (follower_id <> following_id)  -- prevent self-follow
);
CREATE INDEX idx_follows_following ON follows(following_id);  -- for "who follows me?"

-- "Who is Alice following?"     WHERE follower_id = alice_id  → uses PK prefix scan
-- "Who follows Alice?"          WHERE following_id = alice_id → uses idx_follows_following
-- "Do Alice and Bob follow each other?"
SELECT
  EXISTS(SELECT 1 FROM follows WHERE follower_id = $alice AND following_id = $bob) AS alice_follows_bob,
  EXISTS(SELECT 1 FROM follows WHERE follower_id = $bob  AND following_id = $alice) AS bob_follows_alice;
```

---

## SECTION 4 — Query Execution Flow

### Standard M2M Two-Join Pattern

```sql
-- "Get all article titles tagged 'react', published after 2024-01-01"
SELECT a.id, a.title, a.published_at
FROM articles a
JOIN article_tags at ON at.article_id = a.id
JOIN tags t ON t.id = at.tag_id
WHERE t.name = 'react'
  AND a.published_at > '2024-01-01'
ORDER BY a.published_at DESC
LIMIT 20;

-- EXECUTION (with proper indexes):

Step 1 — Tags lookup (high selectivity, few rows):
  Index Scan on tags(name) WHERE name = 'react'
  → Returns 1 row: {id: 42, name: 'react'}
  Estimated: 1 row.

Step 2 — article_tags lookup by tag_id (medium selectivity):
  Index Scan on article_tags(tag_id) WHERE tag_id = 42
  → Returns 15,000 rows: all articles tagged 'react'
  Sorted by tag_id (index order).

Step 3 — JOIN articles (high selectivity after date filter):
  Nested Loop: for each of 15,000 article_ids from step 2:
    Index Scan on articles(id) → fetch article row
    Apply filter: published_at > '2024-01-01'
  → 15,000 iterations × O(log N) each.

  ALTERNATIVE: Hash Join if date filter expected to be very selective:
    Hash articles WHERE published_at > '2024-01-01' (say 50,000 rows)
    Probe with article_ids from article_tags → find matches.
    Planner chooses based on estimated row counts.

Step 4 — Sort + LIMIT:
  Sort by published_at DESC. With LIMIT 20: heapsort top-N. No full sort.

-- OPTIMIZATION: Index on articles(published_at DESC) WHERE published_at > constant
--   + Index on article_tags(tag_id, article_id) → covers both join steps
-- With these: query fully resolved via index scans, possibly covering indexes.
-- Expected: <5ms for well-indexed M2M traversal on millions of rows.

-- DIAGNOSING SLOW M2M QUERIES:
-- EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT):
--   Look for: Seq Scan on article_tags → missing index on tag_id side
--   Look for: Hash Join Batches > 1 → work_mem too low for this join
--   Look for: rows=2000 (estimated) vs rows=150000 (actual) → stale statistics → ANALYZE
```
