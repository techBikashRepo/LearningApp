# Backup Strategy

## FILE 01 OF 03 — Core Concepts, RTO/RPO, AWS Backup Tools & Architecture

> **Architect Training Mode** | Site Reliability Engineer Perspective
> _A backup that has never been tested is not a backup. It is a backup-shaped comfort object. The test is the backup._

---

## SECTION 1 — Intuition (Explain Like a 12-Year-Old)

```
RTO — Recovery Time Objective
  Definition: How long can your service be DOWN before the business suffers unacceptable loss?
  Measured in: minutes, hours.

  Example definitions:
    RTO = 4 hours → service can be offline for 4 hours. Recovery within 4 hours is acceptable.
    RTO = 15 minutes → service must be back within 15 minutes.
    RTO = 0 → zero downtime acceptable (requires hot standby / multi-region active-active).

  What RTO drives: recovery PROCESS. How fast can you restore a backup?
    Restoring a 500GB RDS snapshot to a new instance = 30–60 minutes. Can your RTO absorb that?
    If RTO < 30 minutes: you need a continuously available standby (Multi-AZ or Read Replica
    that can be promoted), not just a snapshot backup.

RPO — Recovery Point Objective
  Definition: How much DATA can you afford to LOSE? (How far back can you restore to?)
  Measured in: time (the gap between last backup and the incident).

  Example definitions:
    RPO = 24 hours → acceptable to lose up to 24 hours of data. Daily backup is sufficient.
    RPO = 1 hour → can't lose more than 1 hour of data. Backups must run every hour.
    RPO = 0 → zero data loss (requires synchronous replication to standby).

  What RPO drives: backup FREQUENCY.
    Daily automated backup → RPO = 24 hours (worst case: backup taken midnight, incident at 11:59 PM).
    Point-in-time recovery (PITR) → RPO = 5 minutes (RDS transaction logs every 5 minutes).

PRACTICAL EXAMPLES:
  Startup non-critical data (analytics, logs):
    RTO = 4 hours. RPO = 24 hours.
    Daily RDS snapshot is sufficient.

  E-commerce order database:
    RTO = 1 hour. RPO = 5 minutes.
    RDS automated backups with PITR + Multi-AZ (5-minute RPO via transaction logs).
    Multi-AZ handles RTO if failure is AZ-level (auto-failover < 2 minutes).

  Banking transaction system:
    RTO = near-zero. RPO = near-zero.
    Multi-region active-active replication. Synchronous writes to multiple AZs.
    This is not a backup question — it's a high availability architecture question.
    Backups also exist for point-in-time restore, not for HA.
```

---

## SECTION 2 — Core Technical Explanation

```
AUTOMATED BACKUPS (default feature):
  What they are: AWS takes a daily snapshot of your entire database.
                 Plus: transaction logs every 5 minutes.

  Storage:
    Backup data stored in S3 by AWS (you don't see the S3 bucket — it's AWS-managed).
    Free storage up to the size of your RDS instance.

  Retention period: 1–35 days. 0 = disabled.
    Set to 7 days for most production systems.
    7-day window: can restore to any second within the last 7 days.

  Point-in-Time Recovery (PITR):
    Restore to any second in the retention window.
    Use case: "Someone dropped the users table at 2:15:33 PM. Restore to 2:15:00 PM."
    Mechanism: restore the last snapshot, then replay transaction logs up to the desired time.
    Time to restore: depends on snapshot size and log replay time. Typically 15–60 minutes.

  Terraform:
    resource "aws_db_instance" "main" {
      backup_retention_period = 7             # Days to retain automated backups
      backup_window           = "02:00-03:00" # When to take daily snapshot (UTC, low-traffic)
      deletion_protection     = true          # Prevent accidental instance deletion
      skip_final_snapshot     = false         # Take a final snapshot when instance is deleted
      final_snapshot_identifier = "myapp-prod-final-snapshot"
    }

MANUAL SNAPSHOTS:
  What they are: on-demand snapshots you create and control.
  Unlike automated backups: they persist INDEFINITELY unless you delete them.

  When to create:
    Before any major database migration or schema change.
    Before a major deployment that touches the data model.
    Monthly/quarterly for long-term retention beyond the 35-day automated limit.

  Creation:
    aws rds create-db-snapshot \
      --db-instance-identifier myapp-prod \
      --db-snapshot-identifier myapp-prod-pre-migration-20240115

  Best practice: automate monthly snapshots via EventBridge + Lambda.
    Schedule: first of each month, 1 AM.
    Retention: keep 12 months.
    Implement: Lambda calls create-db-snapshot and deletes snapshots older than 12 months.

COPY SNAPSHOTS TO ANOTHER REGION (Disaster Recovery):
  If your entire AWS region goes down: snapshots in that region are inaccessible.
  Solution: copy snapshots to a second region.

  aws rds copy-db-snapshot \
    --source-db-snapshot-identifier arn:aws:rds:us-east-1:123456789:snapshot:myapp-prod-20240115 \
    --target-db-snapshot-identifier myapp-prod-20240115-dr-copy \
    --source-region us-east-1 \
    --region us-west-2 \
    --kms-key-id arn:aws:kms:us-west-2:...

  Automate with EventBridge: trigger cross-region copy after each automated backup completes.
```

---

## SECTION 3 — Architecture Diagram (MANDATORY)

```
S3 VERSIONING:
  What it is: S3 stores every version of every object. Delete doesn't destroy — it adds
              a "delete marker." Previous versions are retrievable.

  When to enable:
    Any bucket storing user data or files (uploads, documents, media).
    Configuration files that change over time.
    Terraform state files (critical — enables rollback of infrastructure).

  Terraform:
    resource "aws_s3_bucket_versioning" "app_uploads" {
      bucket = aws_s3_bucket.app_uploads.id
      versioning_configuration {
        status = "Enabled"
      }
    }

    # Add lifecycle rule: permanently delete non-current versions after 90 days:
    resource "aws_s3_bucket_lifecycle_configuration" "app_uploads" {
      bucket = aws_s3_bucket.app_uploads.id
      rule {
        id     = "delete-old-versions"
        status = "Enabled"

        noncurrent_version_expiration {
          noncurrent_days = 90  # Delete non-current versions older than 90 days
        }
      }
    }

S3 CROSS-REGION REPLICATION (for disaster recovery):
  Replicates objects to another region in near-real-time.

  resource "aws_s3_bucket_replication_configuration" "app_uploads" {
    role   = aws_iam_role.replication.arn
    bucket = aws_s3_bucket.app_uploads.id

    rule {
      status = "Enabled"
      destination {
        bucket        = "arn:aws:s3:::myapp-uploads-dr-us-west-2"
        storage_class = "STANDARD_IA"  # Lower cost for DR bucket
      }
    }
  }

S3 OBJECT LOCK (compliance):
  Prevents deletion/overwrite for a specified retention period.
  Required for compliance: write-once-read-many (WORM) storage.
  If ransomware encrypts your S3 objects: Object Lock prevents overwriting the originals.

  storage_class = "GLACIER" for long-term archival (retrieval time: hours, very low cost).
```

---

## SECTION 4 — Request Flow (MANDATORY FLOWCHART)

```
AWS BACKUP is a service that provides a single pane of glass for all backup activities:
  Backup plans define: what to back up, how often, retention, cross-region copy.
  Works across: RDS, S3, DynamoDB, EFS, EC2 volumes.

BACKUP PLAN (Terraform):
  resource "aws_backup_plan" "production" {
    name = "production-backup-plan"

    rule {
      rule_name         = "daily-backup"
      target_vault_name = aws_backup_vault.main.name
      schedule          = "cron(0 2 * * ? *)"     # 2:00 AM UTC daily
      start_window      = 60                        # Start within 60 minutes of scheduled time
      completion_window = 180                       # Must complete within 3 hours

      lifecycle {
        cold_storage_after = 30   # Move to cold storage (Glacier) after 30 days
        delete_after       = 365  # Delete after 1 year
      }

      # Copy to DR region:
      copy_action {
        destination_vault_arn = "arn:aws:backup:us-west-2:..."
        lifecycle {
          delete_after = 365
        }
      }
    }

    rule {
      rule_name         = "monthly-snapshot"
      target_vault_name = aws_backup_vault.main.name
      schedule          = "cron(0 1 1 * ? *)"  # First of month, 1 AM
      lifecycle {
        delete_after = 2557  # 7 years (for compliance)
      }
    }
  }

  # Apply the plan to your RDS instance:
  resource "aws_backup_selection" "production_db" {
    name         = "production-db"
    iam_role_arn = aws_iam_role.backup.arn
    plan_id      = aws_backup_plan.production.id

    resources = [aws_db_instance.main.arn]
  }
```

---

### Production Readiness Checklist

```
RDS BACKUP
  [ ] Automated backups enabled with 7+ day retention
  [ ] Backup window scheduled during low-traffic period (2-3 AM UTC)
  [ ] Point-in-time recovery verified (manual test: restore to specific time)
  [ ] Manual snapshot automation: monthly + pre-major-changes
  [ ] Snapshots copied to second region (cross-region DR)
  [ ] deletion_protection = true on production instances
  [ ] skip_final_snapshot = false

S3 BACKUP
  [ ] Versioning enabled on all buckets containing user data
  [ ] Lifecycle rules defined: noncurrent version expiration policy
  [ ] Cross-region replication enabled for critical data buckets
  [ ] Object lock considered for compliance-sensitive data

BACKUP TESTING
  [ ] Restore test performed: restore the latest backup to a test instance
  [ ] Recovery time measured: documented actual RTO (not estimated)
  [ ] Restored data verified: application started against restored DB, ran smoke tests
  [ ] Test frequency: at minimum every 6 months, always before major changes

ALERTING
  [ ] CloudWatch alarm: RDS automated backup job failed
  [ ] CloudWatch alarm: S3 replication latency > acceptable threshold
  [ ] AWS Backup: notification on backup job failures (SNS topic)
```
