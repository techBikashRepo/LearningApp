# Pre-Signed URLs

## FILE 03 OF 03 — Design Decisions, Exam Traps & Architect's Mental Model

> **Architect Training Mode** | Senior Principal Architect Perspective
> _Optimized for: design judgement · tradeoff evaluation · failure prediction · production debugging_

---

## SECTION 9 — Certification Focus (AWS SAA-C03)

```
WHEN TO USE PRE-SIGNED URLS:

USE PRE-SIGNED URL WHEN:
  ✓ User needs temporary access to specific private S3 object
  ✓ Client must upload file directly to S3 (bypass your server bandwidth)
  ✓ One-time or short-lived access (expiry enforces this)
  ✓ You need fine-grained per-object access control (per user, per file)
  ✓ Generating URL server-side (you have IAM credentials, client doesn't)

USE CLOUDFRONT SIGNED URL INSTEAD WHEN:
  ✓ Content is streamed (video player with range requests, HLS segments)
  ✓ Content is cached at edge (CloudFront cache → lower latency)
  ✓ Large media files: reduce S3 egress cost (CloudFront to user = 7× cheaper than S3 direct)
  ✓ Need long-validity access window (days/weeks) — CloudFront no 12-hour IAM role limit

USE CLOUDFRONT SIGNED COOKIE INSTEAD WHEN:
  ✓ User needs access to multiple files under a path (e.g., /premium/course-123/*)
  ✓ Seamless navigation: user doesn't interact with per-URL tokens

USE S3 NO SIGNING (public) WHEN:
  ✓ Content is truly public and not user-specific (marketing images, logos, public docs)
  ✓ No access control needed

NEVER USE:
  Proxying large files through your backend (Lambda/EC2 download → return to client)
  Cost: bandwidth on your servers + latency + scaling complexity
  Exception: when you need to apply business logic DURING read (virus scan, DRM watermark on-the-fly)
```

---

## SECTION 10 — Comparison Table

```
PATTERN A — Server-Proxied Upload (DO NOT USE FOR LARGE FILES):
  Client → POST multipart → API Server → S3 PutObject

  Problem:
    50 concurrent uploads of 100MB = 5GB transiting your API
    Lambda: 6-minute timeout, 10GB memory limit, not cheap at scale
    EC2: network bottleneck, scaling tied to upload scaling

  Use only for: very small files (< 1MB), need server processing before S3

PATTERN B — Pre-Signed PUT Upload (STANDARD PATTERN):
  Client → GET /upload-url → API Server → returns presigned PUT URL
  Client → PUT data → S3 directly (bypasses API server)
  S3 Event → Lambda → process/validate → update DB

  Benefit: API server bandwidth = metadata only (kB), not file data (MB/GB)

PATTERN C — S3 Multipart + Pre-Signed (FOR LARGE FILES > 100MB):
  Client: create multipart upload → get N presigned URLs for N parts
  Client: upload parts in parallel (6 concurrent × 10MB = fast)
  Client: send completion to server → server calls complete-multipart-upload

  Example (Node.js):
  // 1. Create multipart upload
  const { UploadId } = await s3.createMultipartUpload({ Bucket, Key }).promise();

  // 2. Get presigned URL per part
  const urls = await Promise.all(parts.map((_, i) =>
    getSignedUrl(s3Client, new UploadPartCommand({
      Bucket, Key, UploadId, PartNumber: i + 1
    }), { expiresIn: 3600 })
  ));

  // Client: uploads each part to its URL, collects ETags

  // 3. Complete multipart upload with ETags
  await s3.completeMultipartUpload({
    Bucket, Key, UploadId,
    MultipartUpload: { Parts: etags.map((ETag, i) => ({ ETag, PartNumber: i+1 })) }
  }).promise();
```

---

## SECTION 11 — Quick Revision

```
TRAP 1: Pre-signed URL validity is capped by signing credential expiry
  Signing with IAM role: max URL validity = remaining role session (max 12 hours)
  Exam: "generate pre-signed URL valid for 5 days using Lambda" → won't work
  Lambda: uses execution role (IAM role) → session max 12 hours → URL max 12 hours
  Fix: use IAM user long-term credential for 7-day URLs, or generate on demand

TRAP 2: Pre-signed URL doesn't bypass explicit DENY in bucket policy
  Pre-signed URL: bypasses NORMAL IAM identity checks during S3 access
  BUT: explicit DENY in bucket policy → still blocks pre-signed URL access
  Exam: "pre-signed URL generates successfully but returns 403" → check bucket policy for DENY

TRAP 3: Any holder of the URL can use it — no user identity check
  You generate URL for user Alice. Alice forwards URL to Bob.
  Bob can download using Alice's URL within expiry window.
  S3 cannot distinguish Bob from Alice (it's just an HTTPS URL).
  Exam: "prevent URL sharing" → S3 cannot enforce this. Use short expiry + application logic.

TRAP 4: Presigned URL for non-existent object returns 403 or 404 — not an error at generation time
  Generate presigned URL for s3://bucket/does/not/exist.jpg → SDK succeeds (does not check existence)
  Client uses URL → 404 NoSuchKey
  Exam: "presigned URL generated successfully but client gets error" → object may not exist / wrong key

TRAP 5: PUT pre-signed URL method-specific — cannot use for GET and vice versa
  GET presigned URL → client uses for PUT → 405 Method Not Allowed
  Exam: "correct action to allow client to upload" → PutObject presigned URL, not GetObject
```

---

## SECTION 12 — Architect Thinking Exercise

```
REQUIREMENT:
  Investment management company: advisors upload client agreements (PDF, DOC, <50MB).
  Clients must be able to download their documents via mobile app.
  Requirements: audit trail, no public S3 access, documents expire after 7 years.

SOLUTION DESIGN:

  UPLOAD FLOW:
  1. Advisor app → POST /api/documents/init {clientId, filename, type}
  2. API: validate advisor has permission for clientId
  3. API: generate random fileId (UUID), S3 key = "agreements/{fileId}/{sanitized-name}"
  4. API: store DB record (fileId, clientId, advisorId, status=pending, s3Key)
  5. API: generate presigned PUT URL (30-minute expiry for large documents)
  6. Return to app: {fileId, uploadUrl}
  7. App: PUT file → S3 bucket (private, SSE-KMS, us-east-1)
  8. S3 Event → Lambda: validate PDF, extract metadata, update DB status=complete

  DOWNLOAD FLOW (client mobile app):
  1. Client → GET /api/documents/{fileId}
  2. API: verify JWT token → client owns this document (check DB: doc.clientId == clientId)
  3. API: generate presigned GET URL (15-minute expiry)
  4. Return: {downloadUrl}
  5. Client: GET → S3 directly (30MB PDF download at full S3 bandwidth)

  AUDIT TRAIL:
  S3 Server Access Logging: every presigned URL usage logged (IP, timestamp, key)
  CloudTrail data events: S3 PutObject/GetObject events captured
  DynamoDB: every URL generation logged (who, what file, when)

  RETENTION:
  S3 Object Lock: COMPLIANCE mode, 7-year retention (cannot delete even by admin)
  Lifecycle: after 7 years + 30 days → delete (COMPLIANCE mode expires then allow delete)
```

---

### Architect's Mental Model

```
5 RULES I NEVER VIOLATE:

1. "Store S3 keys in DB. Generate pre-signed URLs on demand. Never store signed URLs."
   Signed URL = credential + expiry baked in. Will expire. Cannot revoke.
   DB record = (bucket, key, owner). One source of truth. Fresh URL per request.

2. "Pre-signed URL expiry is limited by the signing credential's session duration"
   Lambda/EC2/ECS role: max 12 hours. IAM user: up to 7 days.
   For long-lived access links: use IAM user credentials or (better) generate on demand.

3. "Large file upload NEVER goes through your API server — always direct to S3"
   Server-proxied upload: scales your API proportionally to file size × concurrent users.
   Pre-signed PUT: server handles metadata only. S3 handles raw bytes. Correct architecture.

4. "Randomize S3 object keys — never embed user IDs or business logic in keys"
   UUID-based keys: no enumeration, no data leakage in keys, no sequential guessing.
   Business context lives in the database, not the S3 key.

5. "Validate authorization before generating the URL — not after"
   Check: does this user own this resource? BEFORE calling generatePresignedUrl.
   Never generate a URL and trust the client to use it correctly.
   Authorization check = in your app code, not at S3 level.

3 MISTAKES JUNIOR ARCHITECTS MAKE:

1. Using pre-signed URLs for heavy streaming video (should be CloudFront)
   Pre-signed URL: user downloads direct from S3 ($0.09/GB egress).
   100K video views × 1GB = $9,000/month from S3 alone.
   Fix: CloudFront + signed URL ($0.0085/GB + cache = 10-50× cheaper at scale).

2. Setting expiry to 7 days "to be safe"
   Long expiry = long window for abuse if URL leaked.
   User screenshots link, shares via email, posts to Slack → that link stays valid 7 days.
   Production: 15 minutes download / 30-60 minutes upload. Extend only when UX demands it.

3. Forgetting CORS configuration on the S3 bucket for browser uploads
   Backend generates PUT URL. Browser attempts PUT → CORS preflight OPTIONS → blocked.
   Fix: bucket CORS policy with AllowedMethods: PUT, AllowedOrigins: your domain.
   This blocks 100% of direct browser uploads if not configured.

30-SECOND MENTAL MODEL (Say this in an interview):
  "Pre-signed URL is a time-limited signed S3 URL that grants caller access to a specific object.
   You generate it server-side using IAM credentials. Client uses it to GET or PUT directly.
   Key benefits: private bucket, no credentials exposed to client, direct S3 access (no server proxy).
   Key rules: generate on demand, keep expiry short, validate authorization first, use UUIDs for keys.
   For video streaming at scale: CloudFront signed URL is better (cached, lower cost)."
```
