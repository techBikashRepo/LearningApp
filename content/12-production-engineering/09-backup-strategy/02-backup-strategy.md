# Backup Strategy

## SECTION 5 — Real World Example

> **Architect Training Mode** | Site Reliability Engineer Perspective
> _The backup incidents that hurt the most are not "we had no backups." They're "we had backups, but they didn't restore, and we discovered this during the emergency."_

---

### INCIDENT 01 — Table Dropped in Production, Backup Untested

### Symptom

```
Tuesday 3:45 PM: Database migration script runs in production.
                 Script was tested in staging. Ran cleanly.
                 In production: a logic error causes DROP TABLE orders; to execute
                 without the WHERE clause the developer intended.

3:45:12 PM: "orders" table: gone. All 2.3 million order records: deleted.
3:45:15 PM: First 500 errors arrive. Users can't view orders.
3:46:00 PM: PagerDuty fires.

Engineering response:
  "We have automated backups! We can restore the table."

  First attempt: restore latest automated snapshot to new RDS instance.
  Snapshot was taken at 2 AM. Restore started 3:47 PM.
  Estimated restore time shown in console: 45 minutes.

4:32 PM: Restored instance available. Connected application.
  Problem: snapshot from 2 AM has 13 hours of missing data.
           1,847 orders placed between 2 AM and 3:45 PM: not in the snapshot.

  Second attempt: point-in-time recovery to 3:44:50 PM (10 seconds before the drop).
  This was available — RDS PITR was enabled (though never explicitly verified).
  PITR restore started 4:35 PM.

5:20 PM: PITR restore complete. All orders present.

  Total downtime: 1 hour 35 minutes (3:45 PM → 5:20 PM).
  Expected downtime by engineers: "15 minutes" (never tested).
```

### Root Cause

```
Multiple failures:

FAILURE 1: Migration without a pre-migration snapshot.
  A pre-migration snapshot is a free, immediate insurance policy.
  Restoring a snapshot (from 5 minutes ago) takes the same 45 minutes as one from 2 AM.
  The pre-migration snapshot would have had all orders up to migration time.
  Instead: had to use PITR (longer, more complex) to get orders up to the incident.

FAILURE 2: Backup never tested.
  Engineers knew they had "7-day retention" but had never:
    Measured how long a restore actually takes.
    Verified PITR was enabled (it was, but they didn't know for certain).
    Tested whether the application works correctly against the restored DB.

  Result: during the emergency, discovering "45 minutes, not 15" added to panic.

FAILURE 3: Migration runs without a dry-run in staging that mimicked production data volume.
  Staging had 500 rows in orders. The logic error's impact wasn't visible.
```

### Fix

```
IMMEDIATE: Implement pre-migration snapshot automation:
  Every migration script execution in CI/CD triggers:
    1. Create RDS snapshot: migrations/<timestamp>-pre-<migration-name>
    2. Run migration.
    3. If migration fails: snapshot available for immediate restore (snapshot from 2 minutes ago).

PROCESS: Mandatory backup testing every 6 months:
  Procedure:
    1. Identify the latest automated snapshot.
    2. Restore it to an isolated RDS instance (naming: myapp-restore-test).
    3. Point a test deployment of the application at the restored instance.
    4. Run the application smoke test suite.
    5. Record: time to restore, any issues encountered.
    6. Delete the test instance.

  Document the results:
    "2024-01-15: Restore from snapshot to working app: 48 minutes. PITR capability: verified."

  This is the real RTO. Use it to set expectations and DR plans.

MIGRATION SAFETY: Add migration safeguards:
  if (process.env.NODE_ENV === 'production') {
    await createPreMigrationSnapshot();  // Always
  }

  // After migration: verification step:
  const orderCount = await db.query('SELECT COUNT(*) FROM orders');
  if (orderCount.rows[0].count < expectedMinimum) {
    throw new Error('Migration verification failed: unexpected row count after migration');
  }
```

---

### INCIDENT 02 — Backup "Worked" But Restore Took 4× Expected Time

### Symptom

```
Disaster recovery drill (planned exercise, no production impact):
  Goal: restore production RDS from yesterday's automated snapshot.
  Expected time (from documentation): "approximately 20 minutes."

  Actual time: 1 hour 47 minutes.

After restoring: additional 25 minutes to:
  Update connection strings in ECS.
  Restart all ECS tasks (rolling deployment).
  Verify application working.

Total time from "start restore" to "application serving traffic": 2 hours 12 minutes.
Documented RTO in disaster recovery plan: 30 minutes.
```

### Root Cause

```
The 20-minute estimate was based on:
  An AWS documentation quote from 3 years ago.
  A test restore of a 10 GB database.

Production database had grown to 280 GB (never re-tested after growth).

AWS RDS restore time factors:
  Database size (largest factor).
  Storage type (gp2 vs gp3 vs io1).
  Number of storage files.
  Region (backup in us-east-1, restore to same region: faster than cross-region).

For 280 GB gp2: actual time was 1 hour 47 minutes.
This was discoverable in advance — but nobody tested it after the database grew.

SECOND ISSUE: The DR plan documented "restore process" but not "application recovery process."
  The additional 25 minutes for connection string updates and ECS restarts was not
  accounted for in the RTO calculation.

  RTO must include:
    Time to restore backup + Time to reconfigure application + Time to verify.
    Not just: time to restore backup.
```

### Fix

```
1. RE-RUN DR DRILLS AFTER DATABASE GROWTH MILESTONES:
   Trigger: every time database size increases by more than 50 GB, re-run the restore test.
   Alert: CloudWatch metric "FreeStorageSpace" with a notification when storage used crosses thresholds.

2. DOCUMENT FULL RECOVERY TIME — not just restore time:
   RTO = T_restore + T_reconfigure + T_verify

   T_restore: time from clicking "restore" to instance available = 107 minutes (280 GB, gp2)
   T_reconfigure: update ECS environment variables with new RDS endpoint = 5 minutes
   T_verify: rolling ECS restart + smoke tests = 20 minutes

   TRUE RTO: 132 minutes. Update DR plan accordingly.

   ACTION: to reduce to <60 minutes:
     Upgrade to gp3 storage (faster restore than gp2 at same cost).
     Pre-created CloudFormation template for restore (DNS alias approach:
     restore to same instance ID if possible, avoiding reconfigure step).

3. USE CNAME/ROUTE53 WEIGHTED RECORDS instead of hardcoded RDS endpoints:
   Application connects to db.internal.myapp.com (Route53 private hosted zone).
   Route53 record: db.internal.myapp.com → actual RDS endpoint.

   On restore: point db.internal.myapp.com → restored instance endpoint.
   Application: no change needed. No ECS restart for connection string.

   T_reconfigure drops from 25 minutes to 30 seconds (Route53 TTL).
```

---

### INCIDENT 03 — S3 Versioning Off, User Accidentally Deletes 3,000 Photos

### Symptom

```
Feature: users can upload and delete their own photos.
Thursday: user support escalates. A user deleted a batch of 3,200 of their photos.
          They say it was accidental (batch delete UI had no confirmation dialog).
          They want their photos back.

Engineering response: "We can restore from S3."
Actual outcome: S3 versioning was NOT enabled on the uploads bucket.
Deletion = permanent. Objects gone. Completely unrecoverable.
User: permanently lost 3,200 photos. Legal complaint filed.
```

### Root Cause

```
S3 bucket was created 2 years ago. At that time: team was small, moved fast,
"we'll add versioning later." Later never happened.

No checklist item for "versioning enabled" during bucket creation.
Infrastructure code (Terraform) for the bucket had no versioning block.
No audit of S3 bucket configurations post-creation.
```

### Fix

```
IMMEDIATE:
  Not recoverable. No fix for the user's data. Transparency and process improvement only.

S3 VERSIONING (retroactively enable):
  Enabling versioning on an existing bucket protects ALL NEW uploads from this point.
  Existing objects that are deleted BEFORE enabling: not recoverable.

  Terraform:
    resource "aws_s3_bucket_versioning" "uploads" {
      bucket = aws_s3_bucket.uploads.id
      versioning_configuration { status = "Enabled" }
    }

UI FIX: Confirmation dialog before batch delete.
  Plus: "soft delete" approach — mark items as deleted, purge after 30-day hold.

  async function deletePhoto(photoId: string, userId: string): Promise<void> {
    // OPTION 1: Soft delete — mark as deleted, don't remove from S3 yet:
    await db.query(
      'UPDATE photos SET deleted_at = NOW() WHERE id = $1 AND user_id = $2',
      [photoId, userId]
    );
    // Schedule actual S3 delete after 30 days (EventBridge + Lambda):
    // User can "undo" within 30 days. After 30 days: permanent.

    // OPTION 2: With S3 versioning enabled — just delete (add delete marker):
    await s3.deleteObject({ Bucket: UPLOADS_BUCKET, Key: photoKey }).promise();
    // Object gets a delete marker. Previous version still exists until explicitly purged.
    // Restore: delete the delete marker.
  }

POLICY: All new S3 buckets must have versioning enabled as a default.
  AWS Organizations Service Control Policy (SCP):
    Deny PutBucketVersioning with status=Suspended (prevent disabling versioning once enabled).
  Infrastructure code review: all new bucket Terraform must include a versioning block.
```

---

## DEBUGGING TOOLKIT

### Verify Backup Configuration

```bash
# Check RDS automated backup settings:
aws rds describe-db-instances \
  --db-instance-identifier myapp-prod \
  --query 'DBInstances[0].{BackupRetentionPeriod: BackupRetentionPeriod, BackupWindow: PreferredBackupWindow, LatestRestorableTime: LatestRestorableTime, DeletionProtection: DeletionProtection}'

# List available snapshots (automated and manual):
aws rds describe-db-snapshots \
  --db-instance-identifier myapp-prod \
  --query 'DBSnapshots[*].{ID: DBSnapshotIdentifier, Created: SnapshotCreateTime, Status: Status, Type: SnapshotType}' \
  --output table

# Check S3 versioning status on all buckets:
for bucket in $(aws s3api list-buckets --query 'Buckets[*].Name' --output text); do
  status=$(aws s3api get-bucket-versioning --bucket $bucket --query 'Status' --output text 2>/dev/null)
  echo "$bucket: ${status:-DISABLED}"
done
```

### Perform a Test Restore

```bash
# Find the latest automated snapshot:
LATEST_SNAPSHOT=$(aws rds describe-db-snapshots \
  --db-instance-identifier myapp-prod \
  --snapshot-type automated \
  --query 'sort_by(DBSnapshots, &SnapshotCreateTime)[-1].DBSnapshotIdentifier' \
  --output text)

echo "Restoring from snapshot: $LATEST_SNAPSHOT"

# Restore to a new test instance:
aws rds restore-db-instance-from-db-snapshot \
  --db-instance-identifier myapp-restore-test \
  --db-snapshot-identifier $LATEST_SNAPSHOT \
  --db-instance-class db.t3.medium \
  --no-multi-az \
  --no-publicly-accessible \
  --vpc-security-group-ids sg-xxxxxxxx

# Monitor restore progress:
watch -n 30 'aws rds describe-db-instances \
  --db-instance-identifier myapp-restore-test \
  --query "DBInstances[0].{Status:DBInstanceStatus, Progress:Endpoint.Address}"'

# After testing, delete the restore instance:
aws rds delete-db-instance \
  --db-instance-identifier myapp-restore-test \
  --skip-final-snapshot
```

### Perform a Point-in-Time Restore

```bash
# Restore to specific time (e.g., 5 minutes before an incident):
RESTORE_TIME="2024-01-15T15:44:50Z"  # 10 seconds before the incident at 15:45:00

aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier myapp-prod \
  --target-db-instance-identifier myapp-pitr-restore \
  --restore-time $RESTORE_TIME \
  --db-instance-class db.t3.large \
  --no-multi-az

# Verify the restore time is within your backup retention window (LatestRestorableTime):
aws rds describe-db-instances \
  --db-instance-identifier myapp-prod \
  --query 'DBInstances[0].LatestRestorableTime'
```

### Recover Deleted S3 Object (If Versioning Enabled)

```bash
# List all versions of a specific object (including delete markers):
aws s3api list-object-versions \
  --bucket myapp-uploads \
  --prefix "users/123/photos/photo-abc.jpg" \
  --query '{Versions:Versions[*].{VersionId:VersionId, Modified:LastModified, IsLatest:IsLatest}, DeleteMarkers:DeleteMarkers[*].{VersionId:VersionId, Modified:LastModified}}'

# Get the delete marker version ID, then delete it (this restores the object):
# (Delete a delete marker = restore the object)
aws s3api delete-object \
  --bucket myapp-uploads \
  --key "users/123/photos/photo-abc.jpg" \
  --version-id "delete-marker-version-id-here"

# Verify the object is visible again:
aws s3api head-object \
  --bucket myapp-uploads \
  --key "users/123/photos/photo-abc.jpg"
# Should return metadata. If 404: object not restored yet.
```

## SECTION 6 — System Design Importance

The incident patterns above highlight key system design principles: design for failure, implement graceful degradation, enforce security boundaries at every layer, and monitor proactively. Each incident represents a production scenario that should inform your system design decisions.

## SECTION 7 — AWS & Cloud Mapping

AWS services directly relevant to these patterns: **ECS/Fargate** for container orchestration and task lifecycle management; **ECR** for secure image storage and scanning; **Secrets Manager / SSM Parameter Store** for runtime secret injection; **CloudWatch** for container metrics, logs, and alarms; **IAM** for fine-grained access control.

## SECTION 8 — Interview Preparation

**Beginner:**

**Q: What is the difference between RTO and RPO?**
**A:** *RPO (Recovery Point Objective):* how much data can you afford to lose? If your database backs up every 24 hours and it crashes 23 hours after the last backup, you lose 23 hours of data. RPO = 24 hours means that's acceptable. If you need RPO < 1 hour, you need continuous backups or replication. *RTO (Recovery Time Objective):* how fast must you recover? Can you be down for 4 hours while restoring a backup? Or must you be up in 5 minutes? RTO drives your recovery MECHANISM: restoring from S3 backup might take 2 hours (bad for RTO < 1 hour). Multi-AZ RDS automatic failover takes 60 seconds (good for RTO < 5 minutes). Budget drives RTO/RPO â€” higher requirements cost more.

**Q: What is a Multi-AZ RDS deployment and how does it improve availability?**
**A:** Multi-AZ RDS maintains a synchronous standby replica in a different Availability Zone. Every write to the primary is synchronously replicated to the standby (both must acknowledge before write is confirmed). If the primary fails (hardware failure, AZ outage): AWS automatically fails over to the standby â€” DNS is updated to point to the standby, which becomes the new primary. Failover completes in 60-120 seconds. Application reconnects (using the same endpoint â€” DNS has changed). Multi-AZ is for high availability (fast failover), not for read scaling (standby doesn't take reads until it becomes primary). Cost: 2x instance + storage cost.

**Q: What is the difference between a backup and a replica?**
**A:** *Backup:* point-in-time snapshot stored to durable storage (S3). Protects against: accidental data deletion, data corruption, natural disaster, ransomware. Recovery: restore the snapshot to a new DB instance (takes minutes to hours). *Replica:* real-time copy of the live database in sync (or near-sync). Protects against: hardware failure, AZ outage. Recovery: automatic failover in seconds/minutes. Replica is NOT a substitute for backup: if you accidentally DELETE FROM users and it's replicated instantly, your replica is also wiped. You need BOTH: replicas for fast failover, backups for data recovery.

---

**Intermediate:**

**Q: What is RDS automated backup and what is the difference between automated backup and a manual snapshot?**
**A:** *Automated backup:* RDS takes daily full snapshots and retains transaction logs for continuous point-in-time recovery. You can restore to any second within the retention window (1-35 days). Automatically deleted after retention period. Used for: day-to-day recovery from data issues within the window. *Manual snapshot:* you explicitly create this. Retained indefinitely until you delete it. Used for: before major migrations (take a snapshot first), regulatory requirements (keep 7-year archive), testing (restore to a test instance for load testing). Best practice: automated backup retention = 7-14 days + monthly manual snapshot before major changes.

**Q: What is the 3-2-1 backup rule and how do you implement it for a production database?**
**A:** 3-2-1 rule: 3 copies of data, on 2 different storage media, 1 copy off-site. Implementation for RDS: (1) *Copy 1:* Primary RDS instance (live data). (2) *Copy 2:* RDS automated backup in S3 (same region, different media â€” S3 is not RDS). (3) *Copy 3:* Cross-region snapshot copy â€” AWS feature that copies RDS automated snapshots to a second region automatically. If an entire AWS region goes down (rare but possible), you can restore from the other region's copy. S3 itself stores 3 copies internally across different hardware â€” but that's at S3 level, not your application's responsibility.

**Q: What is database point-in-time recovery (PITR) and how is it different from restoring a snapshot?**
**A:** *Snapshot restore:* restores a specific daily backup. You can only go back to the exact point of the snapshot (midnight, for example). If an incident happened at 3 PM and the snapshot is from midnight, you lose 15 hours of transactions. *PITR:* RDS continuously archives transaction logs. Combine the daily snapshot + transaction logs = restore to any specific timestamp (e.g., 2:58 PM â€” 2 minutes before the incident). PITR requires automated backups enabled. Restoration process: same command as snapshot restore but specify a timestamp instead of snapshot ID. PITR creates a NEW RDS instance (not in-place overwrite) â€” you then verify data and swap endpoints.

---

**Advanced (System Design):**

**Scenario 1:** Design a backup and disaster recovery strategy for a SaaS platform. Requirements: RPO < 1 hour, RTO < 30 minutes, multi-region capability. Database: PostgreSQL 15 on RDS. Budget: moderate (avoid over-engineering).

*Primary region (us-east-1):*
- RDS Multi-AZ: automatic 60s failover within region. Handles AZ failures.
- RDS automated backup: 7-day retention, PITR enabled. Handles accidental data loss within 1 week.
- Transaction log retention: minimum 1 hour ensures RPO < 1 hour.

*Cross-region (ap-south-1):*
- RDS Read Replica in ap-south-1: replication lag typically < 1 minute (achieves RPO < 1 hour).
- RDS automated snapshot cross-region copy: daily snapshot copied to ap-south-1 automatically.
- Promotion plan: If us-east-1 goes down â†’ promote ap-south-1 read replica to standalone primary â†’ update Route 53 DNS to point to ap-south-1 endpoint. Promotion takes ~5 minutes. Plus DNS TTL (set to 60s pre-disaster for < 30 min RTO).

*Application:* Stateless (ECS with Docker images in ECR both regions). No state on ECS tasks. Failover requires only: promote RDS replica + update Route 53.

**Scenario 2:** An engineer runs UPDATE users SET email = NULL without a WHERE clause â€” accidentally nulling all 50,000 user email addresses in production. The error is caught 45 minutes after it occurred. Walk through the recovery process using PITR.

*Recovery process:*

(1) *Stop further damage:* immediately investigate if any new users have signed up in the 45 minutes â€” those emails are legitimately NULL (not from the accident). Query created_at > incident_time to count new users.

(2) *Create a PITR restore:* in AWS console, RDS â†’ restore to point in time â†’ specify timestamp to 2 minutes before the incident. This creates a NEW RDS instance (e.g., prod-db-recovery). Takes ~10 minutes.

(3) *Verify recovery instance:* connect to prod-db-recovery, run SELECT count(*) FROM users WHERE email IS NOT NULL. Should show all 50,000 emails intact.

(4) *Extract and patch:* instead of swapping entire database (which would lose 45 minutes of new signups), extract just the email column: SELECT id, email FROM users WHERE email IS NOT NULL into a CSV. In production DB: UPDATE users SET email = recovery.email FROM recovery_data WHERE users.id = recovery_data.id AND users.created_at < incident_time. Preserves new signups.

(5) *Verify and cleanup:* confirm all emails restored. Delete recovery instance. Document incident. Add WHERE clause linter rule to detect missing WHERE on UPDATE/DELETE in code review / pre-commit.

