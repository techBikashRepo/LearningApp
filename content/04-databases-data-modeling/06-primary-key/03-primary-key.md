# Primary Key — Part 3 of 3

### Sections: 9 (AWS Mapping), 10 (Interview Questions), 11 (Debugging Exercise), 12 (Architect's Mental Model)

**Series:** Databases & Data Modeling → Topic 06

---

## SECTION 9 — AWS Service Mapping

### Primary Key Design Across AWS Data Services

```
RDS / AURORA (PostgreSQL):
  BIGSERIAL PK:
    Optimal for single-region, write-concentrated workloads.
    B-tree index: always sequential inserts → rightmost page fills → minimal fragmentation.
    FK storage: 8 bytes per reference. Small index footprint.
    Shard-safe to NOT. If you shard later: PK collision across shards. Plan ahead.

  UUID v7 PK (time-ordered):
    Aurora multi-writer / Postgres + Citus (sharding): UUID v7 = globally unique, shard-safe.
    Time-ordered: near-sequential inserts → low fragmentation like INT.
    Storage: 16 bytes (2x BIGINT). FK columns: 2x larger. Tradeoff worth it for distributed setup.
    Generate in Postgres with pg_uuidv7 extension, or native PG 17: gen_uuid_v7().

  AURORA MULTI-MASTER (deprecated) / AURORA GLOBAL DATABASE:
    Dual-write regions: INT PK = collision risk (both regions generate their own sequences).
    UUID PK: globally unique across all regions. Required for multi-master or global writes.
    Aurora Global: typically active-write in one region. But for failover promotion:
      INT sequences: need to be relocated/re-gapped post-failover. Complex.
      UUID: no coordination required on failover. Simpler operations.

RDS AURORA (MySQL InnoDB):
  PK = CLUSTERED INDEX. PK choice directly determines physical row order.

  CRITICAL RULE: Always BIGINT AUTO_INCREMENT for primary write PK in InnoDB.
    Sequential inserts → append to right of clustered index → 99% page fill → minimal fragmentation.

  UUID v4 PK: catastrophic in InnoDB.
    Random inserts → 50% page fill → 2x wasted space → 2x IOPS → index fragmentation.
    Mitigation: OPTIMIZE TABLE periodically (table rebuild — locks table for duration!).
    At 100GB table: OPTIMIZE takes hours. Unacceptable for production.

  UUID v7: acceptable in InnoDB (time-ordered → near-sequential fill).
    Still 16 bytes vs 8 for BIGINT. Slightly more storage, slightly more I/O. Usually acceptable.

DYNAMODB:
  PRIMARY KEY = Partition Key (required) + Sort Key (optional).

  PARTITION KEY DESIGN:
    Hot partition problem: if PK has few distinct values (e.g., status = 'ACTIVE' / 'COMPLETED'),
    all writes for 'ACTIVE' go to one physical partition → throughput ceiling hit quickly.
    DynamoDB max per partition: 1,000 WCU, 3,000 RCU.

    GOOD PK: high-cardinality, evenly-distributed. E.g., user_id (UUID) → spread across all partitions.
    BAD PK: timestamp only → all recent inserts on same partition (write hotspot, just like UUID4 in InnoDB).

  COMPOSITE KEY (PK + SK):
    Use SK for entity subtyping and sorted access:
    PK = user_id, SK = ORDER#<timestamp> → all user orders in one partition, sorted by time.
    Query: PK = user_id → returns all orders, sorted by SK (timestamp) ascending.

  ULID or KSUID as Sort Key:
    Time-ordered unique IDs work well as DynamoDB Sort Keys (sortable, unique, no collision).
    Better than UUID4 as SK (UUID4 has no sort order → range queries on SK are random).

AURORA SERVERLESS v2:
  PK type affects ACU consumption:
    INT PK with sequential insert: low IOPS → fewer ACUs triggered by write throughput.
    UUID4 PK (InnoDB): random IOPS → storage tier I/O increases → more ACU scaling triggered.
    Cost: UUID4 in InnoDB Aurora Serverless can trigger unnecessary scale-up events.
    Rule: BIGINT AUTO_INCREMENT on Aurora Serverless MySQL. UUID v7 if global uniqueness needed.

RDS PROXY:
  PK lookups (single row by ID): ideal for RDS Proxy.
  Connection multiplexing: efficient for short-lived PK lookups (common read pattern).
  RDS Proxy pins connections for transactions. Short PK lookup + commit: pin released quickly.
  Range scans: acceptable. Long full-table reads: hold connection → reduces multiplexing efficiency.
```

---

## SECTION 10 — Interview Questions

### Beginner Questions

**Q1: What is a primary key and what are its constraints?**

> A primary key uniquely identifies each row in a table. It has three implicit constraints:
> (1) Uniqueness: no two rows can have the same PK value.
> (2) NOT NULL: PK column(s) can never be NULL — a NULL cannot identify anything.
> (3) Immutability (by convention): PK values should never change; all foreign keys referencing
> the row via PK would need to be updated otherwise. Databases don't enforce immutability,
> but architects treat it as a requirement. A changed PK = cascading FK update problem.
> Technically: any column or combination of columns satisfying uniqueness + NOT NULL can be a PK.

**Q2: What is the difference between a natural key and a surrogate key? When would you choose each?**

> A natural key uses existing real-world data as the identifier (email, SSN, product barcode).
> Advantage: self-documenting, already meaningful, no extra column needed.
> A surrogate key is a system-generated meaningless identifier (auto-increment ID, UUID).
> Advantage: stable (never changes with real-world data), no PII in FK columns, technology-neutral.
>
> Choose natural key when: the value is truly stable forever, universally unique, and carries
> no regulatory concerns (e.g., ISO country code as PK for a countries reference table — it won't change).
> Choose surrogate key for: all user data, order data, transactional entities — anywhere the
> real-world identifier might change, collide between systems, or carry PII.

**Q3: Why does MySQL/InnoDB behave differently with UUID primary keys compared to PostgreSQL?**

> MySQL InnoDB uses a clustered index where table rows are physically stored in PK order.
> UUID v4 values are random, so each new insert goes to a random position in the sorted tree.
> This causes random I/O (reading the target page from disk), frequent page splits (filling pages
> at ~50% capacity), and index fragmentation. At high write rates this saturates disk I/O.
> PostgreSQL uses heap storage — rows are inserted in insertion order regardless of PK value.
> The PK B-tree index is a separate structure pointing to heap locations.
> UUID inserts in Postgres: random entries in the B-tree index, but the heap itself still
> fills sequentially. Less I/O impact. UUID v4 is generally acceptable in Postgres.

### Intermediate Questions

**Q4: A table's `INT` primary key is approaching its maximum value (2.1 billion). How do you migrate to `BIGINT` in production with zero downtime?**

> Step 1: Add a new BIGINT column (`new_id`) with a new sequence starting at (current_max + 10,000,000).
> Step 2: Sync new_id from existing id via background UPDATE (batched: WHERE id BETWEEN x AND y).
> Step 3: Add a UNIQUE constraint on new_id (concurrent, no lock).
> Step 4: Add a NOT NULL constraint once sync is complete.
> Step 5: Switch application to write and read new_id instead of id (deploy as dual-write).
> Step 6: Update all FK columns referencing id to reference new_id (concurrent index rebuild per table).
> Step 7: RENAME new_id to id, rename old column to old_id.
> Step 8: Drop old_id and old sequence.
> Zero-downtime because: each step is non-blocking (CONCURRENTLY, batched, dual-write transition).
> In Postgres 11+: INT to BIGINT column type change may be done via ALTER TABLE ... ALTER COLUMN TYPE BIGINT USING id::BIGINT — only requires AccessExclusiveLock briefly if Postgres can confirm no type coercion is needed.

**Q5: When would you choose a composite primary key vs a surrogate primary key for a junction table?**

> Use composite PK when: the junction represents a unique relationship (no repeated pairs desired),
> the composite key naturally covers the "left side" traversal direction (prefix scan optimization),
> and you don't need to reference individual junction rows externally.
> Example: permissions table where (user_id, permission_name) is always unique and never referenced by other tables.
>
> Use surrogate PK when: the junction table has many attributes that make it a first-class entity,
> external tables need to reference individual junction rows (e.g., an approval_log table that points
> to a specific user_role assignment), or your ORM requires single-column integer IDs.
> Trade-off: surrogate PK requires adding a separate UNIQUE constraint on (left_fk, right_fk) or
> you lose the duplicate prevention that a composite PK provides for free.

### Advanced Questions

**Q6: Design a globally unique, time-sortable, shard-safe primary key for a distributed order management system handling 100K orders/second across 10 geographic regions.**

> Use a Snowflake-style ID: 64-bit integer composed of:
> Bits 63-22 (42 bits): millisecond timestamp since epoch → supports ~139 years. Time-sortable.
> Bits 21-12 (10 bits): machine/shard ID → supports 1,024 unique nodes. Unique per node.
> Bits 11-0 (12 bits): sequence counter per millisecond per node → 4,096 IDs/ms/node = 4M/sec/node.
> Total at 10 regions × 100 nodes: (4M/sec) × 1,000 nodes → well beyond 100K/sec.
>
> Properties: globally unique (no coordination needed), time-sortable (IDs sort chronologically),
> 8 bytes (same as BIGINT — 2x smaller than UUID, better index density), no UUID4 fragmentation.
> Libraries: Twitter Snowflake, Sonyflake (Go), instagram_id (Python), ulid.js (JavaScript).
> AWS equivalent: build in Lambda with node_id from EC2 instance metadata (region + AZ + instance last-octet).

---

## SECTION 11 — Debugging Exercise

### Scenario: Bulk Import Failing with Primary Key Violation

```
SYMPTOMS:
  - Daily customer data import (CSV from external CRM): 50,000 new customer records.
  - Runs nightly via COPY command.
  - Failing since last week with: "ERROR: duplicate key value violates unique constraint customers_pkey"
  - Import was working for 8 months before this.
  - The CSV is provided by external vendor.

QUERY:
  COPY customers (id, email, name, created_at) FROM '/tmp/customers_20240315.csv' CSV HEADER;

INVESTIGATION:

Step 1: Check what IDs are in the failing CSV.
  head -5 /tmp/customers_20240315.csv
  id,email,name,created_at
  1827654,alice@corp.com,Alice Johnson,2024-03-15
  1827655,bob@corp.com,Bob Smith,2024-03-15
  ...

  SELECT MAX(id) FROM customers;
  -- Returns: 1,827,900

  Finding: the CSV contains IDs that overlap with existing IDs in the table.
  The vendor's CRM recently RESET their auto-increment sequence to 1,800,000 after a database migration.
  Their new customers start at 1,800,001 — colliding with our existing records starting at 1,800,001.

  Root cause: natural key from external system (vendor's CRM ID). CRM changed.
  This is the exact failure mode predicted for natural keys from external systems.

Step 2: Check the data quality of the conflict.
  SELECT c.id, c.email, i.email AS import_email
  FROM customers c
  JOIN (VALUES (1827654, 'alice@corp.com')) AS i(id, email) ON c.id = i.id
  WHERE c.email != i.email;
  -- Returns rows: our customer at that ID is a different person than in the CSV.
  -- Confirmed: ID collision = different people. NOT just a retry of the same data.

RESOLUTION — Immediate:

Option A: Skip conflicting rows (if import is additive, not authoritative):
  COPY customers (id, email, name, created_at) FROM '/tmp/customers_20240315.csv' CSV HEADER
  ON CONFLICT (id) DO NOTHING;
  -- Imports records not in conflict. Skips duplicates silently.
  -- Downside: new customers in the file whose IDs conflict → not imported. Data loss.

Option B: Re-key on email (if email is the true natural business identifier):
  INSERT INTO customers (vendor_customer_id, email, name, created_at)
  SELECT id, email, name, created_at FROM csv_staging
  ON CONFLICT (email) DO UPDATE SET
    vendor_customer_id = EXCLUDED.vendor_customer_id,
    name = EXCLUDED.name;
  -- Our internal id: BIGSERIAL (never changed). vendor_customer_id: vendor's ID (can change).
  -- Email: business key. De-duplication basis.

LONG-TERM ARCHITECTURE FIX:
  ALTER TABLE customers ADD COLUMN vendor_customer_id INT;
  ALTER TABLE customers ADD COLUMN internal_id BIGSERIAL PRIMARY KEY;  -- or rename existing PK
  UPDATE customers SET vendor_customer_id = id;
  CREATE UNIQUE INDEX ON customers(vendor_customer_id);

  Now: internal_id = our stable PK. vendor_customer_id = their ID (mutable, can collide if vendor changes).
  Import: INSERT ... ON CONFLICT (vendor_customer_id) DO UPDATE SET ...
  Internal joins: always on internal_id. Vendor ID: just metadata.
```

---

## SECTION 12 — Architect's Mental Model

```
=== Architect's Mental Model: Primary Key ===

DECISION RULE 1: PK is an internal contract, not a business identifier.
  Never use a value whose guaranteed uniqueness depends on an external system.
  External systems have bugs, migrations, resets, and format changes.
  Your PK must be under your exclusive control and must NEVER change.
  Business identifiers (email, SSN, external CRM ID): store as a separate UNIQUE column.
  FK references always point to internal PK, never to business identifiers.

DECISION RULE 2: PK type drives I/O pattern, index size, and write throughput.
  PostgreSQL: BIGSERIAL (single-region) or UUID v7 (multi-region/distributed). Not UUID v4.
  MySQL InnoDB: ALWAYS BIGINT AUTO_INCREMENT as PK. UUID4 = write-amplification catastrophe.
  Distributed (Citus, Cassandra, DynamoDB): UUID v4/v7 or Snowflake IDs. INT sequences collide.
  Rule: choose PK type based on your eventual write topology, not your current one.

DECISION RULE 3: BIGSERIAL over SERIAL. Always.
  SERIAL: max 2,147,483,647 (~2.1B). At 50K inserts/day: exhausted in 117 years.
  But at 500K inserts/day: 11 years. At 5M insert/day: 1.2 years.
  BIGSERIAL: max 9,223,372,036,854,775,807. Effectively unlimited. 8 bytes (same layout).
  The migration from INT to BIGINT in production is painful. Use BIGSERIAL from day one.
  There is no meaningful downside to BIGSERIAL over SERIAL.

DECISION RULE 4: PK lookup = the fastest possible DB operation. Design your hot paths around it.
  SELECT * FROM table WHERE id = $1: 3-4 buffer hits, sub-millisecond.
  Any lookup by non-PK column: add index, but it will never be as fast as a PK lookup.
  Design your most latency-sensitive API endpoints to resolve records by PK as quickly as possible.
  User-facing URLs: expose PK or a stable unique token (UUID) that maps 1:1 to PK.

DECISION RULE 5: Never expose sequential INT PKs in URLs or APIs.
  GET /users/1, /users/2, /users/3: enumeration vulnerability.
  Attackers can walk all user records. Authorization gaps become obvious.
  Fix: expose UUID (public-facing), keep INT PK internal.
  Or: encode PK with Hashids / Sqids for obfuscation (not security, but reduces enumeration).
  True security: per-resource authorization check regardless of ID type.

COMMON MISTAKE 1: Using email as PK in a user table.
  Emails change (marriage, employer change). People share email accounts.
  Changing PK = updating all FKs across entire schema. Never done without major downtime.
  Email → store as UNIQUE NOT NULL column. PK → surrogate ID.

COMMON MISTAKE 2: Composite PK in junction table without reverse-direction index.
  PK (user_id, role_id) covers "what roles does user X have?"
  "What users have role Y?" → full table scan. Must add INDEX(role_id, user_id) manually.
  Every composite PK needs the reverse direction index added explicitly.

COMMON MISTAKE 3: Assuming sequential IDs encode business semantics.
  "The last order ID is 987,000 therefore we have 987,000 orders."
  Gaps from rollbacks, bulk inserts, server restarts. Sequences are not row counters.
  Use SELECT COUNT(*) FROM orders or a pre-maintained counter for business metrics.

30-SECOND INTERVIEW ANSWER (Why not use UUID v4 as primary key in MySQL?):
  "MySQL InnoDB stores rows physically sorted by primary key because it uses a clustered index.
  UUID v4 is randomly distributed, so every insert goes to a random position in the sorted structure.
  This means almost every insert triggers a page read from disk, then a write back — random I/O
  instead of sequential. Pages fill to only about 50% capacity instead of 99%, doubling storage
  and waking twice as many buffer pool pages. At any significant insert rate this saturates disk IOPS.
  The fix is BIGINT AUTO_INCREMENT for the clustered PK — purely sequential inserts, no fragmentation.
  If you need a UUID for external exposure, store it as a separate UNIQUE column alongside the INT PK."
```
