# Audit Columns — Part 3 of 3

### Sections: 9 (AWS Mapping), 10 (Interview Q&A), 11 (Debugging Exercise), 12 (Architect's Mental Model)

**Series:** Databases & Data Modeling → Topic 22

---

## SECTION 9 — AWS Service Mapping

### How AWS Services Support Audit Requirements

| Layer        | AWS Service                          | Audit Relevance                                                                                                                                                            |
| ------------ | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DB Audit     | Amazon RDS Activity Streams          | Streams all database activity (DDL, DML, queries) to Kinesis. Every INSERT/UPDATE/DELETE with user, timestamp, query. Compliance-grade audit trail at the DB engine level. |
| Table Audit  | Amazon DynamoDB Streams              | Captures `(oldImage, newImage)` for every item change. Lambda processes stream: stores before/after to S3 or OpenSearch. DynamoDB equivalent of `audit_log` table.         |
| API Audit    | AWS CloudTrail                       | Logs all AWS API calls: who called what API at what time from what IP. Immutable. S3-backed. 90-day hot retention, configurable long-term.                                 |
| Change Data  | AWS Database Migration Service (CDC) | Continuous replication of changes from RDS to analytics store. Can be used to stream `audit_log`-equivalent data to Redshift or S3.                                        |
| Secret Audit | AWS Secrets Manager                  | Records every access to secrets (rotation, retrieval). Who accessed which secret and when. Audit trail for sensitive config access.                                        |
| Compliance   | AWS Config                           | Records all configuration changes to AWS resources. "What was this security group's configuration on Jan 15th?" — Config answers it. Infrastructure-level audit columns.   |
| Log Store    | Amazon CloudWatch Logs Insights      | Query PostgreSQL logs (including trigger-generated audit rows exported via RDS log streaming). Centralized audit log search.                                               |

---

**RDS Activity Streams integration:**

```python
# RDS Activity Streams sends DB activity to Kinesis.
# Lambda processes Kinesis stream to populate audit dashboard:
import boto3, json, base64

def lambda_handler(event, context):
    for record in event['Records']:
        payload = base64.b64decode(record['kinesis']['data'])
        activity = json.loads(payload)

        if activity['type'] in ('UPDATE', 'INSERT', 'DELETE'):
            # activity contains: databaseName, tableName, statementName, dbUserName, commandText
            store_to_audit_dashboard(
                table=activity['databaseActivityEventList'][0]['objectName'],
                user=activity['databaseActivityEventList'][0]['dbUserName'],
                statement=activity['databaseActivityEventList'][0]['commandText'],
                timestamp=activity['databaseActivityEventList'][0]['endTime']
            )
```

---

## SECTION 10 — Interview Q&A

### Beginner Questions

**Q1: What four audit columns should every production table have and what do they capture?**

Every production table should have: (1) **`created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`** — when the record was first inserted. (2) **`updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`** — when the record was last modified. (3) **`created_by TEXT`** — which application user or service account inserted the record. (4) **`updated_by TEXT`** — which application user last modified the record. Together these answer: "When was this created? When was it last changed? Who created it? Who changed it?" — the four foundational questions for any debugging or compliance investigation.

---

**Q2: Why should `updated_at` be set by a database trigger rather than application code?**

Application code is bypassed by: direct database connections (DBA fixes, migrations), bulk updates in scripts, other microservices writing to the same table without using the same ORM, and future developers who forget the convention. A `BEFORE UPDATE` trigger fires on EVERY UPDATE regardless of origin — application ORM, psql command line, migration script, or raw SQL from a Lambda function. The trigger makes `updated_at` accuracy a database guarantee, not a developer discipline requirement.

---

**Q3: What is an `audit_log` table and what does it store?**

An `audit_log` table records the complete history of changes to sensitive database tables. Each row captures: `table_name` (which table changed), `record_id` (which row), `operation` (INSERT/UPDATE/DELETE), `old_values` (JSONB snapshot of the row before the change), `new_values` (JSONB snapshot after), `changed_by` (who made the change, from application context), and `changed_at` (exact timestamp). A trigger on sensitive tables (patient records, financial transactions, user accounts) populates `audit_log` within the same transaction — ensuring every change has a corresponding audit entry.

---

### Intermediate Questions

**Q4: How do you identify which specific fields changed in an UPDATE?**

Inside the trigger function, compare `OLD.*` and `NEW.*` field by field to build a `changed_fields` array:

```sql
SELECT array_agg(key)
FROM jsonb_each(to_jsonb(NEW)) n
JOIN jsonb_each(to_jsonb(OLD)) o USING (key)
WHERE n.value IS DISTINCT FROM o.value
```

Store this array as a `TEXT[]` column in `audit_log` alongside the JSONB snapshots. This allows precise queries like "find all records where the `dose` field was ever changed" using a GIN index: `WHERE changed_fields @> ARRAY['dose']`. This is significantly more efficient than scanning JSONB old/new values for field-level queries.

---

**Q5: How do you safely pass the application user identity to a PostgreSQL trigger?**

Use PostgreSQL's session-level setting: before each transaction, the application executes `SET LOCAL app.current_user_id = '42'`. The trigger function reads this with `current_setting('app.current_user_id', TRUE)` (the TRUE makes it return NULL if not set rather than raising an error). `SET LOCAL` resets automatically at transaction commit/rollback, making it safe with connection pooling in transaction mode. In PgBouncer session mode: use `SET` instead and reset explicitly. Never use `SESSION_USER` or `CURRENT_USER` for application-level identity — those reflect the database role (service account), not the logged-in human user.

---

### Advanced Questions

**Q6: Audit logs grow unboundedly. What is your long-term management strategy?**

Partition `audit_log` by month using `PARTITION BY RANGE (changed_at)`. Create partitions one month in advance (automated with pg_partman). Retention policy: financial services — 7 years; healthcare — 10 years; general SaaS — 2-3 years (or as required by contract). Enforcement: `DROP TABLE audit_log_2020_01` (instant, atomic). This is dramatically faster than `DELETE FROM audit_log WHERE changed_at < '2021-01-01'` (slow, generates dead tuples, requires VACUUM). For very old data pre-purge: export to S3 Glacier via an archival script, then DROP the partition. Indexes within each partition are automatically pruned when the partition is dropped.

---

**Q7: How do you prevent the audit log itself from being tampered with (insider threat, compromised DBA)?**

Layered approach: (1) **Database-level**: `GRANT INSERT ON audit_log TO app_service` — no UPDATE or DELETE. The application role can only insert, never modify. (2) **Separate database user**: `audit_writer` role with INSERT-only on audit_log. Even a compromised `app_service` cannot delete/modify audit entries. (3) **External append-only stream**: use PostgreSQL logical replication or RDS Activity Streams to replicate `audit_log` rows to an external immutable store (S3 with Object Lock, or AWS Ledger/QLDB). Even a DBA with database superuser access cannot retroactively modify what has already been replicated to the immutable store. (4) **Checksums**: store a hash of `(old_values || new_values || changed_at)` in each audit row. Tampering changes the hash — detectable during compliance audits.

---

## SECTION 11 — Debugging Exercise

### Production Incident: Salary Fraud Investigation

**Scenario:**
HR reports that three employees' salaries were increased without approval. Total unauthorized salary increase: $240K/year. There is no record in the change management system, and the HR manager denies making the changes. You need to determine what happened using the audit system.

**Investigation with audit columns:**

```sql
-- Step 1: find all salary changes in the last 90 days
SELECT
    record_id AS employee_id,
    changed_by,
    changed_at,
    old_values->>'salary_cents' AS old_salary,
    new_values->>'salary_cents' AS new_salary,
    (new_values->>'salary_cents')::int - (old_values->>'salary_cents')::int AS increase,
    changed_fields
FROM audit_log
WHERE table_name = 'employees'
  AND 'salary_cents' = ANY(changed_fields)
  AND changed_at > NOW() - INTERVAL '90 days'
ORDER BY changed_at;
```

**Results:**

```
employee_id | changed_by     | changed_at           | old_salary | new_salary | increase
-----------+----------------+----------------------+------------+------------+---------
employee 12 | db_admin       | 2024-11-12 02:17:33  | 9500000    | 12500000   | 3000000
employee 28 | db_admin       | 2024-11-12 02:19:01  | 8200000    | 11200000   | 3000000
employee 35 | db_admin       | 2024-11-12 02:21:44  | 7800000    | 10600000   | 2800000
```

**Key finding:** `changed_by = 'db_admin'`. Changes made directly via the database admin account, not through the HR application (which would show an HR user ID). Time: 2am. No corresponding ticket in the change management system.

```sql
-- Correlate with RDS Activity Streams or PostgreSQL logs:
-- pg_log entries show:
-- 2024-11-12 02:15:00 UTC: db_admin connected from IP 192.168.1.47
-- 2024-11-12 02:17:33 UTC: UPDATE employees SET salary_cents=12500000 WHERE id=12
-- IP 192.168.1.47: assigned to the workstation of IT contractor "John D."
```

**Outcome:** The audit trail provides exact evidence: who (db_admin role used by contractor), when (2am), what (three specific salary changes), from where (IP address). Without audit columns, this would have been undetectable.

**Prevention added:**

```sql
-- Restrict direct UPDATE on salary column to HR application role only:
REVOKE UPDATE ON employees FROM db_admin;
GRANT UPDATE (name, department_id, manager_id) ON employees TO db_admin;  -- restrict columns
-- salary_cents: only updatable via hr_service role (the application).
-- db_admin: cannot directly UPDATE salary anymore.

-- Add alert: salary change outside business hours:
-- audit_log trigger → if changed_at hour NOT BETWEEN 8 AND 18 AND table='employees' AND 'salary_cents'=ANY(changed_fields)
-- → send PagerDuty alert immediately.
```

---

## SECTION 12 — Architect's Mental Model

### 5 Decision Rules

1. **Four basic audit columns on every table — no exceptions.** `created_at`, `updated_at`, `created_by`, `updated_by`. Cost: 4 columns, 1 trigger. Benefit: answers the most common debugging question ("what changed and when?") for the lifetime of the application.

2. **Full `audit_log` table only for compliance-critical or sensitive tables.** Not every table needs full before/after JSONB logging. Identify: financial records, healthcare data, user credentials, configuration changes. These get the full `audit_log` trigger. Other tables: basic 4 audit columns only.

3. **Audit INSERT must be in the same transaction as the data change.** Two-phase (data + separate audit transaction): can lose the audit on crash. One trigger: same transaction = atomically consistent. The audit is either there (both committed) or not there (both rolled back). No split-brain.

4. **Partition audit_log by month and drop old partitions.** A single monolithic `audit_log` table growing for years becomes a maintenance problem. Monthly partitions: drop with a single DDL statement when retention period expires. Zero VACUUM work, zero dead tuples, instant reclamation.

5. **`SET LOCAL app.current_user_id` at every transaction start, not every query.** Setting it once per transaction ensures the entire transaction's trigger invocations record the same user. If the setting is only done at individual query level, a trigger fired by a different query in the same transaction may see NULL.

---

### 3 Common Mistakes

**Mistake 1: Using `NOW()` in trigger instead of `CLOCK_TIMESTAMP()` for `changed_at` in audit logs.** `NOW()` returns the transaction start time — all changes within one transaction get the same timestamp. `CLOCK_TIMESTAMP()` returns the real current time at the moment of function execution. For audit logs where ordering of changes within a transaction matters: use `CLOCK_TIMESTAMP()`.

**Mistake 2: Not masking PII in `old_values` and `new_values` JSONB.** Audit logs often have broader read access (security team, compliance officers). An SSN or credit card stored in `old_values` is a data breach waiting to happen. Exclude sensitive columns from JSONB capture in the trigger.

**Mistake 3: Applying the full `audit_log` trigger to high-write tables without measuring overhead.** A table with 50K updates/second with a full JSONB audit trigger: ~25% write overhead, generates 50K rows/second in `audit_log` — 4.3 billion rows per day. For high-write tables: use selective triggers (only fire on critical column changes), or use CDC/Kinesis for audit instead of in-database triggers.

---

### 30-Second Interview Answer

> "Audit columns are the four standard fields on every table — `created_at`, `updated_at`, `created_by`, `updated_by` — set by database triggers so they can't be bypassed by any writer. For sensitive tables requiring full history (patient records, financial transactions), I add an `audit_log` table with before/after JSONB, changed fields array, and the application user from `current_setting('app.current_user_id')`. The trigger fires within the same transaction — so the audit is atomically consistent with the data change. `SET LOCAL` makes the user context safe with connection pooling. For retention: partition audit_log by month and DROP old partitions — no slow DELETE, no VACUUM, instant reclamation."

---

_→ Next: [03-Multi-Tenant Data.md](../23 - Multi-Tenant Data/03-Multi-Tenant Data.md)_
