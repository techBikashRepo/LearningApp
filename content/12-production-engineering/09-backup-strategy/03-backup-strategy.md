# Backup Strategy


> **Architect Training Mode** | Site Reliability Engineer Perspective
> _Backup strategy is not defined by what you back up. It's defined by what you can restore, in what time, to what state. Design for the restore, not the backup._

---

## SECTION 9 — Certification Focus (AWS SAA-C03)

### Decision 1 — Automated Backup vs. Manual Snapshots vs. Continuous Replication?

```
OPTION A: Automated Backups Only (RDS automated + S3 versioning)

  Automated RDS backup: daily snapshot + transaction logs (PITR to any point in retention window).
  S3 versioning: every object write preserved, deletes create delete markers.

  Pros:
    Zero operational overhead. Runs automatically.
    PITR covers most business scenarios (recover from accidental DROP TABLE).
    Free storage up to DB instance size.

  Cons:
    Retention limited to 35 days maximum.
    Backup remains in same region — not protected against regional failure.
    Doesn't protect against: long-undetected corruption, compliance archival needs.

  WHEN: Most production applications. Start here.

OPTION B: Automated + Monthly Manual Snapshots

  Add: monthly manual snapshots, retained for 12 months (or 7 years for compliance).

  Pros:
    Extends retention beyond 35-day automated limit.
    Can restore to a specific month's state (useful for compliance investigations:
    "Show me the database state on December 31st for the audit").
    Manual snapshots persist until explicitly deleted.

  Cons:
    Manual snapshots cost money (standard RDS storage rates).
    Requires automation to create and manage retention.

  WHEN: Regulated industries (financial, healthcare). Long audit trails required.
        RECOMMENDED FOR MOST PRODUCTION APPLICATIONS.

OPTION C: Continuous Replication (Multi-AZ or Read Replica)

  Multi-AZ: synchronous replication to a standby in another AZ.
  Read Replica: async replication to a read-only copy in same or different region.

  Pros:
    Multi-AZ: automatic failover in 1–2 minutes. RPO ≈ 0 (synchronous).
    Read Replica (cross-region): foundation for manual DR failover.
    Read Replica can absorb read traffic (operational benefit beyond backup).

  Cons:
    NOT a substitute for backups. Multi-AZ and Read Replicas replicate all writes,
    including accidental DELETEs and DROPs. If you drop a table: the drop
    replicates to all replicas within milliseconds.
    Cost: 2× the DB cost for Multi-AZ.

  WHEN: High-availability requirement (RTO < 5 minutes).
        Multi-AZ for production (HA). Separate from backup strategy.

THE ANSWER:
  Layer 1: Automated RDS backups (daily + PITR) — for operational recovery (default).
  Layer 2: Monthly manual snapshots, cross-region copies — for long-term + DR.
  Layer 3: Multi-AZ — for high availability (not a backup substitute).
  These three serve different purposes and are used together.
```

### Decision 2 — Same Region vs. Cross-Region Backups?

```
SCENARIO: AWS announces us-east-1 availability event. Could be minutes to hours.
          Your database is in us-east-1.
          Your backups are in us-east-1 (managed by RDS, stored in S3 in same region).

          Available: us-west-2 (another AWS region, unaffected).

          Can you restore?
          Not if all your snapshots are only in us-east-1.

DECISION: Does your DR plan require surviving a full regional failure?

  If RTO for regional failure = "hours to days" (acceptable): same-region backups suffice.
  If RTO for regional failure = "under 2 hours": need cross-region snapshot copies.
  If RTO for regional failure = "under 30 minutes": need active cross-region standby
    (read replica in us-west-2, promote to primary on us-east-1 failure).

CROSS-REGION SNAPSHOT COPY:
  EventBridge rule: trigger on RDS snapshot creation event →
  Lambda: copy snapshot to us-west-2.

  Cost: additional storage in the DR region.

  EventBridge rule pattern (Terraform):
    event_pattern = jsonencode({
      source      = ["aws.rds"]
      detail-type = ["RDS DB Snapshot Event"]
      detail = {
        EventID = ["RDS-EVENT-0091"]  # Automated backup completed
      }
    })

  Lambda: copies snapshot to DR region and deletes copies older than 30 days in DR region.

MINIMUM RECOMMENDATION:
  Monthly manual snapshots copied to a second region.
  Cost: one monthly snapshot in a second region = minimal storage cost.
  Benefit: if us-east-1 is entirely unavailable, monthly recovery possible from us-west-2.
  Gap: up to 30 days of data loss. Acceptable for some applications.

  For RPO < 7 days from regional failure: copy each automated daily snapshot cross-region.
```

### Decision 3 — How to Handle Application-Level Data Relationships During Restore?

```
THE PROBLEM:
  You restore the orders database to 3:44 PM.
  But your users database (separate service) wasn't restored — it's at current time.
  Users created AFTER 3:44 PM exist in the users database but not in orders.

  Or: after orders was corrupted, other systems processed related shipments.
  Restoring orders to 3:44 PM creates inconsistency with the shipping records.

STRATEGIES:

STRATEGY 1: Point-in-time restore is good enough (most common case)
  Accidental table drop / data corruption: restore to just before incident.
  All related systems were also at that point in time. Consistency preserved.
  The few transactions processed between backup point and now:
    Identify them from application logs.
    Manually replay or accept the small data loss (RPO negotiation).

STRATEGY 2: Saga pattern + event sourcing for distributed consistency
  Each cross-service operation is a saga (sequence of steps).
  Every step emits an event to an event store (SQS, EventBridge, DynamoDB).
  On restore: replay events from the event store to reconstruct state.
  This is complex — only justified for systems with strict cross-service consistency needs.

STRATEGY 3: Compensating transactions
  After restore: run a script that identifies inconsistencies between restored DB
  and current state of related services.
  For each inconsistency: apply a compensating transaction.
  Example: order exists in orders DB but corresponding shipment was already processed
  in shipping DB → mark order as "shipped" in restored DB.

REALISTIC ANSWER: for most applications, accept some inconsistency after a restore.
  Document the known gaps.
  Use the restore for the corrupted portion.
  Apply compensating transactions for the known side effects.
  This is why having an experienced DBA and runbook is part of your DR plan.
```

---

## SECTION 10 — Comparison Table

**Trap 1 — "Multi-AZ replaces backups"**

```
WRONG: Multi-AZ is HIGH AVAILABILITY, not a backup.

  Multi-AZ replicates EVERY write synchronously, including:
    DELETE FROM orders;         → replicated to standby immediately.
    DROP TABLE users;           → replicated to standby immediately.
    UPDATE prices SET amount = 0;  → replicated. All prices are now 0.

  Multi-AZ cannot protect you from application-level errors or malicious actions.

CORRECT: Multi-AZ for HA (AZ failure: auto-failover → minimal downtime).
         Automated backups + PITR for data recovery (human or application errors).
         BOTH are required. They cover different failure modes.
```

**Trap 2 — "We have automated backups so we're covered"**

```
NUANCED: You're partially covered. Questions that must be answered:
  How long does a restore actually take? (Have you measured it on production data size?)
  Is PITR enabled and tested?
  Do backups exist in another region if us-east-1 becomes unavailable?
  When did you last confirm a backup is actually restorable?
  Does your documented RTO match the actual restore time?

Untested backups have unknown reliability. Test them.
```

**Trap 3 — "RDS automated backup retention period = 0 is fine for non-critical systems"**

```
WRONG: Setting backup_retention_period = 0 disables automated backups entirely.
       Also disables point-in-time recovery.

The only scenario where 0 is acceptable: a temporary development/testing instance
that has no production data and can be re-created from scratch at any time.

Even "non-critical" production systems should have at minimum 1-day retention.
```

**Trap 4 — "S3 is durable, so no backup needed for S3 data"**

```
NUANCED: S3 has 11 nines of durability (99.999999999%). But:
  Durability protects against disk failure — not deletions.
  If your application deletes objects (user deletes, application bug): objects are gone.
  Durability does not mean "objects can't be deleted."

CORRECT: Enable S3 versioning for user-generated content.
         Versioning + delete markers = soft delete. Previous versions preserved.
         Add lifecycle rules to eventually purge old versions (cost management).
```

**Trap 5 — "RPO = backup frequency"**

```
CORRECT in simple cases. But with RDS PITR: the RPO is 5 minutes (transaction log interval),
regardless of the daily backup frequency.

More precisely: RPO = maximum time between now and the most recent restorable point.
  With daily snapshots only (no PITR): RPO = up to 24 hours.
  With daily snapshots + PITR: RPO = up to 5 minutes.
  With continuous replication (Multi-AZ): RPO ≈ 0 (synchronous, but not useful for app-level corruption).
```

**Trap 6 — "Backup and DR are the same thing"**

```
DIFFERENT CONCEPTS:
  Backup: storing a copy of data that can be restored when data is lost/corrupted.
          Covers: accidental deletion, corruption, ransomware.

  Disaster Recovery: the process of restoring full service after a major outage.
          Covers: region failure, complete system loss.

  DR requires: backup strategy + runbooks + tested recovery procedures + defined RTO/RPO.
  You can have good backups and bad DR (slow recovery, no runbook, never tested).

A backup strategy is one component of a disaster recovery plan.
```

---

## SECTION 11 — Quick Revision

**Q1: "How do you design a backup strategy for a production PostgreSQL database on AWS?"**

```
I start by establishing RTO and RPO with the business.
For most production apps:
  RPO = 5-15 minutes (can't lose much data).
  RTO = under 2 hours (service can be down for a bit but not for days).

For those requirements:
  RDS automated backups with 7-day retention.
  Backup window during low-traffic hours (2-3 AM).
  This gives PITR to any 5-minute window in the last 7 days.

Additionally: monthly manual snapshots retained for 12 months.
These persist beyond the 35-day automated limit for compliance and audit needs.

For DR coverage: monthly snapshots copied to a second region.
If us-east-1 dies, we can restore from up to 30 days ago in us-west-2.

I also enable deletion_protection on the RDS instance to prevent accidental
or malicious instance deletion.

And critically: I test the restore process every 6 months. Last test: 48 minutes
from snapshot to working application. That's the real RTO in our runbook.
```

**Q2: "What is the difference between RTO and RPO, and how do they drive design decisions?"**

```
RPO — Recovery Point Objective — answers: how much data can we lose?
      It's the time gap between the last recoverable state and the incident.

RTO — Recovery Time Objective — answers: how long can we be down?
      It's the maximum acceptable time from incident to service restored.

They drive opposite design decisions:
  RPO drives backup frequency. Lower RPO = more frequent backups or continuous replication.
  RTO drives recovery speed. Lower RTO = closer to production, faster restore mechanism.

With RDS:
  Daily snapshot alone = RPO 24 hours. PITR = RPO 5 minutes.
  Snapshot restore to new instance = RTO ~45-90 minutes.
  Multi-AZ auto-failover = RTO ~2 minutes (but this is HA, not backup, and doesn't help with data corruption).

If a business says RTO = 30 minutes and RPO = zero: that requires synchronous active-active
replication across multiple regions. A snapshot restore cannot achieve either requirement.
Understanding RTO and RPO helps you say "what you want requires this specific architecture"
rather than guessing what backup solution to use.
```

**Q3: "How do you verify that your backups are actually working?"**

```
The only way to verify a backup works is to restore it and run the application against it.

Process I follow:
  Every 6 months: initiate a restore of the latest automated RDS snapshot to a
  temporary test instance. That instance is in a private subnet with no internet access.
  I point a test deployment of the application at it and run the smoke test suite:
  can the app connect, can it read users, can it write orders, can it serve traffic?

  I measure: time from clicking restore to successful smoke test completion.
  I document it: "2024-01-15: 52 minutes total. DB restore: 43 min. App verify: 9 min."

  I also test PITR selectively:
  Once a year, restore to a specific point in time (a recorded timestamp from a week ago)
  and verify the expected data state. This confirms transaction log integrity alongside snapshot integrity.

  This process has never found a completely broken backup —
  but it has found wrong RTO estimates and once found a parameter group that
  needed manual recreation after restore (the restore didn't carry over a custom parameter group).
  Better to find it in a drill than during a real incident.
```

---

## SECTION 12 — Architect Thinking Exercise

### The 5 Rules of Backups That Actually Work

```
RULE 1: Design for the restore, not the backup.
  A backup only matters at restore time. Ask: "How long to restore? What's the process?
  Who does it at 3 AM? What does the application need after the restore?"
  If you can't answer these: your backup is incomplete.

RULE 2: Test restores. Otherwise your backup is an untested assumption.
  An untested backup may fail due to: encryption key rotation (inaccessible backup),
  parameter group not transferred, IAM permissions missing on DR account,
  or the backup was never completing due to a misconfiguration.
  Test frequency: every 6 months minimum.

RULE 3: Storage availability ≠ data durability.
  S3 11-nines durability: objects aren't spontaneously lost.
  But objects can be intentionally deleted (by users, bugs, or bad actors).
  Enable versioning. These are different problems.

RULE 4: Multi-AZ is HA, not backup. Replication propagates errors.
  Know which problems each mechanism solves.
  You need both layers for true production resilience.

RULE 5: Your RTO is what the restore actually takes, not what you hope it takes.
  Measure it. Document it. If it doesn't meet business requirements:
  change the architecture (not the documentation).
```

### The 3 Mistakes Every Team Makes

```
MISTAKE 1: Never testing the restore.
  The backup "exists." The process of restoring and verifying it was never run.
  This is essentially false confidence. The backup might not restore cleanly.

MISTAKE 2: Assuming Multi-AZ covers data loss from human/application errors.
  Multi-AZ failovers in 2 minutes. Nobody knows that doesn't help if the orders
  table was dropped. Both the primary and standby just lost the orders table.

MISTAKE 3: Forgetting the application recovery steps in the RTO calculation.
  "Restore time: 45 minutes" but the runbook doesn't include:
  update connection strings, restart ECS tasks, run smoke tests.
  Actual time: 90 minutes. RTO violation discovered during the incident.
  Write the full runbook. Time each step during a drill.
```

### 30-Second Answer: "What's your backup strategy for production on AWS?"

```
"For RDS, I enable automated backups with 7-day retention and PITR —
that gives me the ability to restore to any 5-minute window in the last week,
which covers most accidental deletion or corruption scenarios.

I add monthly manual snapshots retained for 12 months for compliance,
and cross-region copies monthly for disaster recovery coverage.

For S3 buckets with user data: I enable versioning to protect against accidental deletions.

For high availability: I run Multi-AZ on production RDS — but I keep that
conceptually separate from backup. Multi-AZ is about AZ failure, not about
recovering from data corruption.

The part I consider most important: I test the restore process every 6 months.
I measure actual restore time, not estimated time. That measured time is what
goes into the DR runbook and what we tell stakeholders our real RTO is."
```
