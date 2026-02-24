# Primary Key — Part 2 of 3

### Sections: 5 (Bad vs Correct), 6 (Performance Impact), 7 (Concurrency), 8 (Optimization & Indexing)

**Series:** Databases & Data Modeling → Topic 06

---

## SECTION 5 — Bad Usage vs Correct Usage

### Pattern 1: Natural Key as Primary Key When Uniqueness Is External

```sql
-- ❌ BAD: SSN as primary key in employee table
CREATE TABLE employees (ssn CHAR(11) PRIMARY KEY, name TEXT, department_id INT);
-- Problems:
-- PII in primary key = PII in every FK column, every join, every index, every log line.
-- SSN changes (name protection programs, errors): must update PK + all FK references.
-- New legislation: similar ID format from another country collides with existing SSN pattern.
-- SSN misentered as 123-45-6789 (should be 123-45-6780): PK violation on correction.

-- ✅ CORRECT: Surrogate PK + SSN as separate UNIQUE column
CREATE TABLE employees (
  id      BIGSERIAL    PRIMARY KEY,    -- surrogate, no business meaning
  ssn     CHAR(11)     UNIQUE NOT NULL,-- business identifier, separately constrained
  name    TEXT,
  department_id INT
);
-- id: stable, internal. FK references use id (no PII).
-- ssn: mutable. UPDATE employees SET ssn = '123-45-6780' WHERE id = 42; → only 1 table row changed.
-- No cascading FK updates needed.
```

### Pattern 2: UUID v4 as PK in MySQL InnoDB (Write Amplification)

```sql
-- ❌ VERY BAD for MySQL InnoDB: Random UUID4 as clustered PK
CREATE TABLE orders (
  id   CHAR(36) PRIMARY KEY,  -- random UUID4, e.g., 'a3f8c2d1-7e4b-...'
  ...
);

-- PROBLEM: InnoDB clustered index. Rows physically stored in PK order.
-- UUID4 = random 128-bit value. Every INSERT goes to a random position in the B-tree.
-- B-tree leaf page for that position: almost never in buffer pool (random access pattern).
-- RESULT: every INSERT triggers a page read from disk, then a page write.
-- Extra I/O per INSERT: ~2 additional random I/Os.
-- At 5,000 inserts/second: 10,000 random I/Os/second = NVME saturated. Latency spikes.
-- Page splits: random inserts cause ~50% page fill vs 99% for sequential inserts.
-- Index fragmentation: requires OPTIMIZE TABLE periodically to compact.
-- Index size: 2x larger than necessary due to fragmentation.

-- ✅ CORRECT for MySQL InnoDB:
-- Option A: BIGINT AUTO_INCREMENT (sequential, optimal insertion)
CREATE TABLE orders (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, ...);
-- Option B: Store UUID separately, use INT PK
CREATE TABLE orders (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  public_uuid CHAR(36) UNIQUE NOT NULL DEFAULT (UUID()),
  ...
);

-- ✅ ACCEPTABLE for MySQL InnoDB: UUID v7 (time-ordered)
-- UUID v7 high bits = timestamp → nearly sequential inserts. Much better than v4.
-- Still 16 bytes vs 8 for BIGINT. Slightly more fragmentation than INT. Generally acceptable.
```

### Pattern 3: COMPOSITE Primary Key Where Business Rules Change

```sql
-- ❌ BAD: PK based on business relationship constraint
CREATE TABLE project_assignments (
  employee_id  INT REFERENCES employees(id),
  project_id   INT REFERENCES projects(id),
  PRIMARY KEY (employee_id, project_id)
  -- Business rule: one employee per project
);

-- 8 months later: business allows employee to have multiple roles on same project.
-- New PK needed: (employee_id, project_id, role_id) or surrogate.
-- Problem: 6 other tables reference (employee_id, project_id) as FK.
-- Migration: add surrogate PK, drop old composite, update all FK constraints.
-- Downtime: locks on all 6 related tables for the duration.

-- ✅ CORRECT: Surrogate PK + UNIQUE constraint for business rule.
CREATE TABLE project_assignments (
  id          BIGSERIAL PRIMARY KEY,
  employee_id INT NOT NULL REFERENCES employees(id),
  project_id  INT NOT NULL REFERENCES projects(id),
  UNIQUE (employee_id, project_id)  -- enforce "one per project" as constraint, not PK
);
-- Business rule changes: DROP UNIQUE CONSTRAINT, ADD NEW CONSTRAINT (employee_id, project_id, role_id).
-- No FK migrations needed. Surrogate PK unchanged. All FK references intact.
```

---

## SECTION 6 — Performance Impact

### B-Tree Index Size and Lookup Cost Comparison

```
PK TYPE COMPARISON (table: orders, 100M rows):

INT (4 bytes):
  PK index size:  4 bytes × 100M rows + B-tree overhead = ~800MB
  FK reference:   BIGINT FK column in order_items: 8 bytes × 500M rows = 4GB
  Index height:   3-4 levels (fast lookup)
  Insert pattern: sequential → next integer. Always appends to rightmost page.

UUID4 (16 bytes):
  PK index size:  16 bytes × 100M rows + B-tree overhead = ~3.2GB
  FK reference:   UUID FK column in order_items: 16 bytes × 500M rows = 8GB
  Index height:   4-5 levels (1 extra level due to larger keys filling fewer entries per page)
  Insert pattern: random → page splits → 50% fill factor → 6.4GB effective

UUID7 (16 bytes, time-ordered):
  PK index size:  ~3.2GB (same key size as UUID4)
  Insert pattern: near-sequential → 90%+ fill factor → ~3.5GB effective
  FK reference:   Same as UUID4 but inserts are faster

PRACTICAL IMPACT AT 100M ROWS:
  PK lookup:
    INT: 3-4 page reads (index fits well in buffer cache at 800MB)
    UUID4: 4-5 page reads + cache misses (3.2-6.4GB index less likely to be cached)

  JOIN performance (order_items FK → orders PK):
    INT FK joins: index on FK column = 8 bytes × 500M = 4GB (likely cached on large server)
    UUID FK joins: 16 bytes × 500M = 8GB (marginally less cache-friendly)

  WRITE throughput (inserts/second):
    INT: ~50,000/sec (sequential, minimal page splits)
    UUID4 (MySQL InnoDB): ~8,000/sec (random, many page splits)
    UUID4 (Postgres heap): ~35,000/sec (heap unaffected by PK order)
    UUID7 (MySQL InnoDB): ~40,000/sec (near-sequential)
```

---

## SECTION 7 — Concurrency

### Sequence Gaps and Their Meaning

```
AUTO_INCREMENT / SERIAL sequences: NOT transaction-safe by design.
  Why: sequence values allocated from a global counter. Transaction rolls back → hole in sequence.

SCENARIO:
  T1: BEGIN; INSERT INTO orders → gets id=1001; ROLLBACK. (order cancelled by user)
  T2: BEGIN; INSERT INTO orders → gets id=1002; COMMIT.

  Result: order 1001 never exists. Sequence has gap: 1000 → 1002.

  NEVER assume: "no gap means no rollback / no gaps = sequential completeness."
  NEVER use: sequential ID to infer business events or count records.
    orders.id = 10000 does NOT mean "we have processed exactly 10,000 orders."
    Gap reasons: rollbacks, bulk inserts, server restart (sequence cache lost), insert failures.

  TRANSACTION PARALLEL INSERT (race for ID assignment):
    T1 and T2 both start transactions:
    T1 allocates sequence value 1001.
    T2 allocates sequence value 1002.
    T2 commits first (faster transaction).
    T1 commits second.
    Result: id=1002 is visible before id=1001 for a window in time.
    "SELECT MAX(id) FROM orders" = 1002 even though id=1001 not yet committed.

  IMPACT: Applications that poll "give me all orders with id > last_seen_id" will MISS id=1001
  if last_seen_id = 1002 when they poll.
  SOLUTION: Use created_at timestamp with small buffer (poll "WHERE created_at > $last - interval '5 seconds'").
  Or: use LISTEN/NOTIFY / Change Data Capture instead of ID polling.
```

---

## SECTION 8 — Optimization & Indexing

### PK Lookup as Clustered Access (Index Scan Mechanics)

```sql
-- QUERY PLAN for PK lookup:
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM orders WHERE id = 987654;

-- EXPECTED OUTPUT (Postgres):
Index Scan using orders_pkey on orders
  (cost=0.57..8.59 rows=1 width=152)
  (actual time=0.075..0.077 rows=1 loops=1)
  Index Cond: (id = 987654)
  Buffers: shared hit=4
-- 4 pages: root (1) + intermediate (1) + leaf (1) + heap page (1). All cached → hit=4.
-- actual time=0.077ms: sub-millisecond. This is the floor for any DB lookup.

-- FOR 100% index-only lookup (ALL columns in SELECT are in PK or a covering index):
EXPLAIN (ANALYZE, BUFFERS) SELECT id, created_at FROM orders WHERE id = 987654;
-- If (id, created_at) both in a covering index:
Index Only Scan using orders_pkey on orders
  Buffers: shared hit=3  ← no heap page read. 3 pages = root + intermediate + leaf.
  Heap Fetches: 0

-- MONITORING PK INDEX USAGE:
SELECT indexrelname, idx_scan, idx_tup_read, idx_tup_fetch
FROM pg_stat_user_indexes
WHERE tablename = 'orders' AND indexrelname = 'orders_pkey';
-- idx_scan: total PK index scan count (should be high relative to seq_scan)
-- idx_tup_fetch: rows fetched from heap via this index
-- High idx_tup_fetch / idx_scan ratio: most PK lookups need heap → consider covering index

-- DETECTING SEQUENCES ABOUT TO OVERFLOW:
SELECT sequence_name,
       last_value,
       (max_value - last_value) AS remaining,
       ROUND(last_value::NUMERIC / max_value * 100, 2) AS pct_used
FROM information_schema.sequences
WHERE sequence_schema = 'public';
-- INT (SERIAL): max 2,147,483,647. At 50K inserts/day: exhausted in ~117 years.
-- At 500K inserts/day: ~11 years. Common to hit this on fast-growing systems.
-- BIGSERIAL: max 9,223,372,036,854,775,807. Effectively unlimited.
-- RULE: Always use BIGSERIAL unless you absolutely need INT for storage reasons.
```
