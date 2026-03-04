# Pre-Signed URLs

## FILE 02 OF 03 — Production Incidents, Failure Patterns & Debugging

> **Architect Training Mode** | Senior Principal Architect Perspective
> _Optimized for: design judgement · tradeoff evaluation · failure prediction · production debugging_

---

## SECTION 5 — Real World Example

```
INCIDENT:
  E-learning platform: users download course videos (avg 2GB).
  Pre-signed URL expiry set to 300 seconds (5 minutes).
  Users on slow connections (mobile, rural internet): download fails at ~60% completion.
  Error: "The request signature we calculated does not match" → URL expired mid-download.

ROOT CAUSE:
  Pre-signed URL expiry = time until S3 will no longer ACCEPT the request.
  For streaming/large downloads: expiry is checked at REQUEST INITIATION only.
  For range requests or very large files: S3 may check signature differently.

  Main issue: range requests (e.g., video player seeking/resuming):
    Video player seeks to position mid-video → new Range request with same signed URL
    If URL expired since first request: 403

FIX:
  Increase expiry for download URLs:
    Small files (< 100MB): 15 minutes (900 seconds) is fine
    Large files (video, archives): 24 hours (86400 seconds)
    User gets link emailed: 7 days (days * 86400, max for IAM user)

  For streaming video: use CloudFront Signed URL instead
    CloudFront: client downloads from edge, expiry check at EACH request
    But: streaming = multiple HTTP range requests → single CloudFront signed URL covers all
    Set CloudFront expiry = session length (e.g., 12 hours)

  Better architecture for video streaming:
    CloudFront Signed URL + access control window (start time - end time)
    User: gets signed URL with 12-hour window
    CANNOT share URL after 12 hours → controlled access
    Seeking: same URL covers all range requests within the time window
```

---

## SECTION 6 — System Design Importance

```
INCIDENT:
  Background job generates pre-signed download URLs and stores in DB (for batch export system).
  URLs sent to users 3 days after generation.
  All users report: 403 AccessDenied when clicking links.

ROOT CAUSE:
  Pre-signed URL signed with: EC2 instance IAM role credentials (temporary credentials).
  IAM role: session duration = 6 hours (default for EC2 instance profile).
  URL signed at: T+0 with role credentials expiring at T+6 hours.
  Pre-signed URL expiry: set to 7 days.

  The catch: pre-signed URL validity is LIMITED by the signing credential's expiry.
  If the IAM role session expires before the URL expiry → URL becomes invalid at role expiry.

  T+6 hours: role credentials rotated → pre-signed URL signed with OLD credentials → 403.

CORRECT MENTAL MODEL:
  Pre-signed URL effective expiry = MIN(URL expiry, signing credential expiry)
  IAM role (EC2/Lambda/ECS): session = 1-12 hours (configurable, max 12 hours)
  IAM user (long-term key): credentials don't expire → URL valid until URL expiry (up to 7 days)

FIX:
  Option A: Don't pre-generate and store URLs. Generate at access time (on demand).
    User requests download → server generates fresh URL → expires in 15 min → user downloads.
    Advantage: always fresh credentials. No stale URL problem.

  Option B: If long-lived links needed → store (bucket, key) in DB.
    Generate fresh pre-signed URL at the moment user clicks "download".
    Never store the signed URL itself.

RULE: Store S3 key reference, not signed URL. Generate URL on demand.
```

---

## SECTION 7 — AWS & Cloud Mapping

```
INCIDENT:
  Fintech app: users upload profile documents (KYC).
  Direct S3 upload with pre-signed PUT URL.
  Object key: "kyc/{userId}/{filename}"

  Security audit: key format predictable → attacker with valid S3 GET presigned URL
  for own document can guess other user IDs → enumerate object keys.

  Even without pre-signed: attacker cannot GET (private bucket), but key structure reveals user IDs.

FIX:
  Use UUID/random key for all uploaded objects (never predictable user-derived path):

  // Generate on server:
  const fileId = crypto.randomUUID(); // e.g., "f47ac10b-58cc-4372-a567-0e02b2c3d479"
  const key = `kyc/${fileId}/${sanitizedFilename}`;
  // Store: DB record maps userId → fileId → S3 key
  // S3 key: unpredictable UUID, no user ID in path

  DB record:
  {
    fileId: "f47ac10b-...",
    userId: "user_123",    ← only in DB, not in S3 key
    s3Key: "kyc/f47ac10b-58cc.../passport.pdf",
    status: "pending"
  }

  Authorization: always verify userId owns fileId BEFORE generating pre-signed GET URL.

ADDITIONAL: Pre-signed URL misuse (URL sharing)
  Pre-signed URL: anyone with the URL can use it within expiry.
  User: copies download URL and shares with unauthorized party.
  Mitigation: keep expiry short (15 min). Add IP condition if known IP range.
  Not fully preventable at S3 level. Application must control URL distribution.
```

---

## SECTION 8 — Interview Preparation

**Beginner:**

**Q: What is a pre-signed URL and what problem does it solve for file uploads?**
**A:** A pre-signed URL is a temporary URL that grants access to a specific S3 object without requiring AWS credentials. Problem it solves: your API server has an AWS IAM role that can upload to S3. If you upload files through your API server: client â†’ API server â†’ S3. The API server is in the data path â€” it must receive the file (memory/disk on the server), then re-upload to S3 (double the bandwidth, double the latency, server CPU used for streaming). With pre-signed URL: API server generates a URL signed with its credentials â†’ returns URL to client â†’ client uploads DIRECTLY to S3 (API server never handles file bytes). Faster, cheaper, scalable.

**Q: What is the difference between a pre-signed GET URL and pre-signed POST/PUT URL?**
**A:** *Pre-signed GET URL:* allows the holder to download a specific S3 object. Used for: private files that specific users can access for a limited time (medical reports, invoice PDFs, private photos). The URL encodes permissions + expiry time, signed with AWS credentials. *Pre-signed PUT URL:* allows the holder to upload an object to a specific S3 location. Used for: direct browser-to-S3 uploads. *Pre-signed POST:* like PUT but supports multi-field forms and more conditions (max file size, allowed content types). Use PUT for single-file uploads from clients. Use POST for HTML form-based uploads with server-side conditions.

**Q: What should pre-signed URL expiry times be and what happens when a URL expires?**
**A:** Expiry time depends on use case: *Upload URLs:* 5-15 minutes â€” enough time for the user to select a file and upload. Don't set too long (security risk). *Download URLs for large files:* 1-24 hours â€” depends on how long the download session should be valid. If expired: HTTP 403 Forbidden from S3 when the client tries to use it. Client must request a new URL from your API. Best practice: generate pre-signed URLs on-demand (not pre-generated and stored in the database â€” stored URLs can leak). Generate immediately before the client needs them, keep expiry short.

---

**Intermediate:**

**Q: What security considerations apply to pre-signed URLs?**
**A:** (1) *URL can be shared:* anyone who has the URL can access the file during the expiry window (it's like a time-limited password in the URL). Don't use long expiry for sensitive data. (2) *Transport security:* always use HTTPS (AWS enforces this for S3). The URL contains signature parameters that would be exposed over HTTP. (3) *Key rotation:* pre-signed URLs are signed with the IAM credentials at generation time. If the access key is rotated/deleted before expiry, the URL becomes invalid. IAM role-based signing (Fargate/EC2 role) is safer â€” rotating managed credentials automatically. (4) *Content-type restriction:* in PUT pre-signed URL, specify the expected content type; include it as a signed condition so clients can't upload unexpected types.

**Q: How do you implement pre-signed URL generation in Node.js with the AWS SDK v3?**
**A:** 
`javascript
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3 = new S3Client({ region: "us-east-1" });

// For upload (PUT)
const uploadUrl = await getSignedUrl(
  s3,
  new PutObjectCommand({
    Bucket: "my-uploads-bucket",
    Key: uploads//.jpg,
    ContentType: "image/jpeg",
  }),
  { expiresIn: 300 }  // 5 minutes
);

// For download (GET)
const downloadUrl = await getSignedUrl(
  s3,
  new GetObjectCommand({ Bucket: "my-bucket", Key: "private/invoice.pdf" }),
  { expiresIn: 3600 }  // 1 hour
);
`
Return uploadUrl to the client â†’ client does a PUT request with the file body directly to the URL.

**Q: How do you validate that a file was actually uploaded after giving a client a pre-signed upload URL?**
**A:** The API gives the client a pre-signed URL but has no direct confirmation when the upload completes (it's client â†’ S3 directly). Solutions: (1) *S3 Event Notification:* S3 publishes ObjectCreated event to SQS/Lambda when upload completes. Lambda: validates file exists, triggers post-processing (thumbnails, virus scan). API polls or uses WebSocket to notify client. (2) *Client confirmation:* after client uploads, it calls POST /api/confirm-upload?key={s3Key}. API calls HeadObject to verify the file exists and has the correct size/content type. (3) *Polling:* client polls GET /api/file-status?key={s3Key} â€” API checks if S3 object exists. Option 2 (client confirmation) is simplest.

---

**Advanced (System Design):**

**Scenario 1:** Design a secure document sharing system where: users upload contracts (PDF, max 10MB). Each contract is visible only to the uploader and specific email-invited recipients. Downloads are tracked (audit log of who downloaded when). Pre-signed URLs expire in 30 minutes.

*Architecture:*
Upload: POST /api/documents/upload-url â†’ API generates pre-signed PUT URL (ContentType: application/pdf, max 10MB via ContentLengthRange condition in POST presign, or verified via S3 notification). Client uploads â†’ S3 event notification â†’ Lambda processes (virus scan, PDF validation) â†’ insert metadata in PostgreSQL: {document_id, s3_key, uploader_id, allowed_emails[]}.

Access: GET /api/documents/{id}/download â†’ API checks: is authenticated user the uploader OR in llowed_emails? If yes: generate 30-min pre-signed GET URL â†’ return to client. ALSO: insert to udit_log table: {document_id, user_id, timestamp, ip_address}.

Security: S3 bucket is PRIVATE (Block Public Access on). All access goes through API-generated pre-signed URLs. No direct S3 access. Bucket policy: deny all except API's IAM role.

**Scenario 2:** Users report that they're clicking your "Download Invoice" button and getting "Access Denied" errors from S3, but only sometimes. It works for some files but not others. Investigate the possible causes.

*Systematic diagnosis:*
(1) *URL expiry:* are the pre-signed URLs being cached anywhere? If a URL generated at 10:00 AM (30-min expiry) is stored in the frontend or a CDN cache and reused at 10:35 AM â†’ expired â†’ Access Denied. Fix: never cache pre-signed URLs. Generate fresh per request.

(2) *IAM role change:* was the IAM role used to sign the URLs recently modified? If permissions were revoked after URL generation, the URL is immediately invalid (role-generated URL validation checks current role permissions at request time).

(3) *Wrong region:* pre-signed URL generated with us-east-1 client, bucket is in eu-west-1. Fix: S3Client must be initialized with the bucket's region.

(4) *Clock skew:* S3 validates timestamp in the signature. If the server generating URLs has a system clock > 15 minutes off from AWS: ALL pre-signed URLs fail. Check: date on the server vs UTC time. Fix: NTP sync (systemctl restart systemd-timesyncd). AWS IMDSv2 time sync is automatic for EC2.

(5) *Special characters in object key:* if the S3 key contains +, &, # â€” URL encoding may be inconsistent. Use UUID-based keys to avoid special characters.

