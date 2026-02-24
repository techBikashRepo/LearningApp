# Primary Key — Part 1 of 3

### Sections: 1 (Intuition), 2 (Why This Exists), 3 (Internal Working), 4 (Query Execution Flow)

**Series:** Databases & Data Modeling → Topic 06

---

## SECTION 1 — Intuition: The Hospital Medical Record Number

Every hospital patient gets a unique Medical Record Number (MRN) the moment they register — forever. Even if they change their name, address, or gender. The MRN is stable, meaningless as a value, and solely exists to uniquely identify that person in all hospital systems, forever.

```
THIS IS A SURROGATE PRIMARY KEY.

CONTRAST WITH NATURAL KEY (using SSN as patient identifier):
  SSN-based ID:
    - Patient has no SSN (foreign national): can't register.
    - SSN entry typo: entire medical history under wrong SSN.
    - Patient gets new SSN (identity protection): all records must be migrated.
    - SSN is PII: indexed SSNs in every FK and join → PII scattered in logs, indexes, query plans.
    - Two systems merged: SSN collisions possible between different national ID formats.

  MRN-based ID (surrogate):
    - System-generated: guaranteed unique, no external dependency.
    - Stable regardless of patient personal data changes.
    - No PII in FK columns or indexes.
    - Two systems merged: MRN renaming scripts simple (just update numbers in one table).

THE ARCHITECT'S FRAME:
  Primary key choice affects:
  • Write performance (index maintenance on every INSERT)
  • Read performance (join speed, index scan speed)
  • Insert ordering (random vs sequential inserts → index fragmentation)
  • Distribution across shards (INT sequential leaks info, UUID shards evenly)
  • Merge-ability (two databases with INT PKs collide; UUIDs don't)
  • Security (sequential INT exposes record count, resource enumeration)
```

---

## SECTION 2 — Why This Exists: The Production Failures

### Failure 1: Natural Key That Changed in Production

```
INCIDENT: A logistics company used shipment_tracking_number (carrier's ID) as PK.
Why: "It's always unique and the business talks about shipments by tracking number."

18 months later: carrier DHL issued duplicate tracking numbers due to a system migration.
Two shipments in their DB now have the same tracking_number.
Insert of second: PRIMARY KEY VIOLATION. New shipment cannot be recorded.
Emergency: cannot create shipment records while DHL duplicate range active.
Customer orders stuck. 6-hour outage while they migrated to surrogate key.
350 FKs across 40 tables all needed migration.

ROOT CAUSE: Natural key whose uniqueness depends on external system.
LESSON: External systems can have bugs. Natural keys are external contracts — they change.
        Surrogate keys are internal contracts — you control them completely.
```

### Failure 2: Sequential INT PK Causing Write Hotspot at Scale

```
INCIDENT: SaaS platform migrating to PostgreSQL sharding.
Primary key: SERIAL (auto-increment integer).
Existing tables: 600M rows, PK at ~600,000,000.

PROBLEM 1: Insert hotspot.
  All new inserts go to the PK=600,000,001, 600,000,002, ...
  All inserts hit the SAME right-most page of the B-tree index.
  Concurrent inserts: all competing for a lock on that one page.
  At 50,000 inserts/second: massive lock contention on the index right-most leaf.
  Throughput ceiling hit. Can't scale writes beyond ~10K inserts/sec per table.

PROBLEM 2: Enumeration vulnerability.
  API endpoint: GET /api/orders/600345821
  Attacker: increment ID by 1: GET /api/orders/600345822 → someone else's order.
  Sequential IDs: trivial to enumerate all records.
  Bug found: authorization check was missing on 3 internal endpoints.
  Customer data exposed.

PROBLEM 3: Shard merge.
  Start sharding: shard1 has INT PKs up to 600M. shard2 starts at 1.
  Collision: shard1 and shard2 both have order_id = 5. Can't query globally.
  UUID: shard1 and shard2: statistically zero probability of collision.
```

### Failure 3: Composite PK That Became Ambiguous

```sql
-- INTENT: orders have unique (customer_id, order_date) composite PK.
-- "A customer can only have one order per day."
CREATE TABLE orders (
  customer_id INT,
  order_date  DATE,
  total       DECIMAL(10,2),
  PRIMARY KEY (customer_id, order_date)
);

-- 6 months later: business requirement changes.
-- "Premium customers can now have multiple orders per day."
-- The PK constraint must be dropped. 40 tables reference this composite key as FK.
-- Migration: add surrogate PK, drop composite PK, update all 40 FK constraints.
-- Downtime: 4 hours.

-- ROOT CAUSE: Composite PK based on business rule that changed.
-- Business rules always change. PKs should be immutable constraints.
-- Surrogate PK would have required only an index change, no FK migrations.
```

---

## SECTION 3 — Internal Working

### How a Primary Key Indexes Itself

```
PRIMARY KEY in PostgreSQL:
  Automatically creates a UNIQUE INDEX on the PK column(s).
  The physical table (heap) is NOT sorted by PK in Postgres (unlike MySQL InnoDB).
  Rows inserted in heap in insert order regardless of PK value.

  FOR LOOKUP BY PK:
    B-tree index traversal: 3-4 level reads → get heap page pointer → 1 heap page read.
    Total: ~4-5 I/O operations (typically in buffer cache: sub-millisecond).

  FOR RANGE SCAN BY PK:
    Walk B-tree leaves in order → get sequence of heap pointers.
    Heap pointers: NOT in order (random heap layout) → random I/O per row.
    Exception: if table was loaded in PK order (bulk INSERT) and hasn't been fragmented by UPDATEs.

MYSQL INNODB DIFFERENCE:
  InnoDB: CLUSTERED INDEX — table rows physically stored in PK order.
  PK lookup: B-tree traversal → data IS at the leaf node (no separate heap read).
    Saves 1 I/O per PK lookup vs Postgres.
  Sequential inserts: optimal (appended to the right of the clustered index).
  Random UUID inserts: catastrophic — random pages to split → write amplification → fragmentation.
  RULE for MySQL InnoDB: always use auto-increment INT for PK, never random UUID.
  Use UUID as a separate UNIQUE column if external exposure needed.
```

### INT vs UUID v4 vs UUID v7: The Concrete Trade-offs

```
                    INT SERIAL      UUID v4 (random)    UUID v7 (time-ordered)
Storage per row:    4 bytes         16 bytes            16 bytes
FK storage:         4 bytes/ref     16 bytes/ref        16 bytes/ref
Index size:         Smallest        4x larger           4x larger
Insert pattern:     Sequential      Random              Sequential-ish
MySQL InnoDB perf:  Optimal         Very bad            Good
Postgres perf:      Good            Good (heap-based)   Good
Collision risk:     None (sequence) 2^122 - astronomically low  Same
Enumerable:         Yes (security risk)  No             No
Shard-safe:         No              Yes                 Yes
Human readable:     Yes (helpful in logs) No            No (but sortable by time)

PRODUCTION RECOMMENDATION:
  Postgres + single-region + security not critical: BIGSERIAL (8-byte INT, future-proof)
  Postgres + multi-region / sharding / security: UUID v7 with gen_random_uuid() until PG17
    (PG17 has native uuid_generate_v7())
  MySQL: BIGINT AUTO_INCREMENT as PK, UUID as separate UNIQUE column
  Distributed systems (Cassandra, Citus): UUID v4 or snowflake-style IDs
```

---

## SECTION 4 — Query Execution Flow

### PK Lookup: The Fastest Possible Query

```
QUERY: SELECT * FROM orders WHERE id = 'a4f2c8d1-...' (UUID PK)

EXECUTION:
  1. PARSE: trivial
  2. PLAN: always IndexScan on PK index (equality on unique key → exactly 1 row → index always wins)
  3. EXECUTE:
     a. Compute hash of UUID value → B-tree lookup
     b. Root node (likely in buffer cache): read key range
     c. Follow pointer to intermediate node: read
     d. Follow pointer to leaf node: get heap TID (page_number, offset)
     e. Fetch that single heap page (8KB) → find row at offset
     f. Return row
     Total: 3-4 page reads (all likely cached) → ~0.1ms

  FULL TABLE SCANS IMPOSSIBLE for PK equality: planner always uses unique index.
  The only way to lose here: SELECT * on a row with 100KB JSONB column
  (row fetch is fast; serialization and network transfer of 100KB is not).

EXPLAIN OUTPUT:
  Index Scan using orders_pkey on orders  (cost=0.57..8.59 rows=1 width=200)
                        ^^^^^^^^^^^^
                        This is the auto-created unique index for the PK.
    Index Cond: (id = 'a4f2c8d1-...')

  (actual time=0.082..0.083 rows=1 loops=1)
    Buffers: shared hit=4   ← 4 buffer cache hits. Zero disk reads.

CONTRAST — lookup WITHOUT index (e.g., WHERE non_indexed_column = 'value'):
  Seq Scan on orders  (cost=0.00..89432.00 rows=1 width=200)
    Filter: (some_column = 'value')
    Rows Removed by Filter: 9999999    ← read 10M rows, kept 1
    (actual time=4521.3..4521.3 rows=1 loops=1)
    Buffers: shared hit=44716 read=12080  ← 56K page reads
```
