# Pre-Signed URLs

## FILE 01 OF 03 — Core Concepts, Architecture & Production Patterns

> **Architect Training Mode** | Senior Principal Architect Perspective
> _Optimized for: design judgement · tradeoff evaluation · failure prediction · production debugging_

---

## SECTION 1 — Intuition (Explain Like a 12-Year-Old)

```
THE PROBLEM: secure access to private S3 objects without exposing credentials or making bucket public

OPTION A — Make bucket public (WRONG):
  Any object in bucket = accessible by anyone, forever.
  No authentication. No audit trail per user. Data leak risk.

OPTION B — Proxy via backend (OK, but costly):
  Client → API Server → S3 download → API Server → Client
  Problem: every download passes through your EC2/Lambda
  Large files (video, zip, PDFs): saturate EC2 network, increase cost, add latency

OPTION C — Pre-Signed URL (CORRECT for S3 access):
  Client → API Server: "I want file X"
  API Server: generates signed URL for S3 (uses IAM credentials to sign)
  API Server → Client: returns signed URL (short-lived token embedded in URL)
  Client → S3 directly: downloads using signed URL
  S3 validates: signature + expiry → serves file directly to client

  Benefits:
    ✓ S3 bucket: fully private, no public access
    ✓ Large files: client downloads directly from S3 (no EC2 bandwidth used)
    ✓ Time-limited: URL expires after N seconds (you choose)
    ✓ One-time or multi-use within expiry window
    ✓ Works for both GET (download) and PUT (upload) operations
```

---

## SECTION 2 — Core Technical Explanation

```
TECHNICAL MECHANISM:
  Pre-signed URL = S3 URL + HMAC-SHA256 signature + expiry timestamp
  Signed using: AWS Signature Version 4 (using IAM role/user credentials)

  URL anatomy:
  https://bucket.s3.amazonaws.com/object-key
    ?X-Amz-Algorithm=AWS4-HMAC-SHA256
    &X-Amz-Credential=AKID%2F20240115%2Fus-east-1%2Fs3%2Faws4_request
    &X-Amz-Date=20240115T120000Z
    &X-Amz-Expires=3600          ← expiry in seconds (3600 = 1 hour)
    &X-Amz-SignedHeaders=host
    &X-Amz-Signature=<HMAC-SHA256-signature>

  AWS validates: signature (was it signed by a valid IAM key?) + Expires (not past?)
  If both valid: S3 serves the object WITHOUT checking bucket policy/IAM again

TYPES:
  Pre-signed GET URL: client can download the object
  Pre-signed PUT URL: client can upload directly to S3 (no upload through your server)

PUT PRE-SIGNED (direct upload flow):
  1. Client tells server: "I want to upload profile.jpg (5MB, image/jpeg)"
  2. Server generates: putObject presigned URL for key "users/123/profile.jpg"
  3. Client receives presigned PUT URL (valid 15 minutes)
  4. Client: HTTP PUT body=file → presigned URL → S3
  5. S3: validates signature → stores object
  6. Client: notifies server "upload complete"
  7. Server: records file key in DB, triggers post-processing (resize, virus scan)

EXPIRY:
  Minimum: 1 second
  Maximum using IAM user credentials: 7 days (604,800 seconds)
  Maximum using IAM role credentials: 12 hours (role session duration limit)
  Recommendation: use shortest practical expiry:
    Download: 15 minutes (user has 15 min to start download)
    Upload: 15-60 minutes depending on file size and user experience
```

---

## SECTION 3 — Architecture Diagram (MANDATORY)

```
FULL PRODUCTION FILE UPLOAD ARCHITECTURE:

  Client (browser/mobile)
    │ 1. POST /api/uploads/initiate {filename, contentType, size}
    ↓
  API Server (Lambda or ECS)
    │ 2. Validate: file type allowed? size <= limit? user authenticated?
    │ 3. Generate S3 key: uploads/{userId}/{uuid}/{filename}
    │ 4. Create DynamoDB record: status=pending
    │    aws s3 presign → generate PUT URL (15 min expiry)
    │ 5. Return: {uploadUrl, fileId, key}
    ↓
  S3 Bucket (direct upload from client)
    │ 6. Client: HTTP PUT → uploadUrl (with file body)
    │ 7. S3 triggers: S3 Event → SQS → Lambda (processing)
    ↓
  Processing Lambda
    │ 8. Validate file content (virus scan, image validation)
    │ 9. Resize/transcode if needed → write to processed/ prefix
    │ 10. Update DynamoDB: status=complete, processedKey={key}
    ↓
  API Server (download)
    │ 11. GET /api/files/{fileId}
    │ 12. Verify user owns the file (check DynamoDB)
    │    aws s3 presign → generate GET URL (15 min expiry)
    │ 13. Return: {downloadUrl} (client downloads directly from S3)

CORS CONFIGURATION (required for browser direct upload):
  Bucket CORS policy:
  [
    {
      "AllowedHeaders": ["*"],
      "AllowedMethods": ["GET", "PUT", "POST"],
      "AllowedOrigins": ["https://app.example.com"],
      "ExposeHeaders": ["ETag"],
      "MaxAgeSeconds": 3000
    }
  ]
  Without CORS: browser blocks cross-origin S3 uploads
```

---

## SECTION 4 — Request Flow (MANDATORY FLOWCHART)

```
PRE-SIGNED S3 URL:
  Signed by: your IAM credentials (server-side generation)
  URL contains: S3 hostname (bucket.s3.amazonaws.com)
  Max expiry: 7 days (IAM user) / 12 hours (IAM role)
  Use: single file download/upload access control

CLOUDFRONT SIGNED URL:
  Signed by: CloudFront key pair (RSA private key)
  URL contains: CloudFront domain (d1234.cloudfront.net)
  Max expiry: unlimited (you choose in policy)
  Use: media streaming, per-user access to CloudFront-cached content

CLOUDFRONT SIGNED COOKIE:
  Same security as signed URL but uses HTTP cookie
  Use: multiple files under same path (e.g.: entire protected video series)
  User: logs in → receives signed cookie → accesses all /premium/* resources

DECISION MATRIX:
  Need                                    | Solution
  ----------------------------------------|--------------------
  Secure download from S3 (temporary)    | Pre-signed S3 URL
  Secure upload to S3 (client-direct)    | Pre-signed PUT URL
  Protected video streaming (long access)| CloudFront signed URL
  Protect entire premium content section | CloudFront signed cookie
  Public static assets (no auth)         | S3 public or CloudFront (no signing)
```

---

### Code Patterns

```javascript
// Node.js / AWS SDK v3 — Generate GET pre-signed URL
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3Client = new S3Client({ region: "us-east-1" });

async function getDownloadUrl(bucket, key, expirySeconds = 900) {
  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
  const url = await getSignedUrl(s3Client, command, { expiresIn: expirySeconds });
  return url;
}

// Node.js — Generate PUT pre-signed URL (client upload)
import { PutObjectCommand } from "@aws-sdk/client-s3";

async function getUploadUrl(bucket, key, contentType, expirySeconds = 900) {
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: contentType,
  });
  const url = await getSignedUrl(s3Client, command, { expiresIn: expirySeconds });
  return url;
}

// Python / boto3 — Generate GET pre-signed URL
import boto3

s3 = boto3.client("s3", region_name="us-east-1")

def get_download_url(bucket, key, expiry=900):
    url = s3.generate_presigned_url(
        "get_object",
        Params={"Bucket": bucket, "Key": key},
        ExpiresIn=expiry
    )
    return url

# Python boto3 — PUT pre-signed URL
def get_upload_url(bucket, key, content_type, expiry=900):
    url = s3.generate_presigned_url(
        "put_object",
        Params={
            "Bucket": bucket,
            "Key": key,
            "ContentType": content_type
        },
        ExpiresIn=expiry
    )
    return url
```

---

### Cost Model

```
PRE-SIGNED URL COST:
  Generating the URL: FREE (IAM sign operation, no AWS API call to S3)
  The subsequent S3 GET/PUT request: normal S3 request pricing
    GET: $0.0004/1K requests
    PUT: $0.005/1K requests
  Data transfer out (download): $0.09/GB (first 10TB)

COST OPTIMIZATION with Pre-Signed + CloudFront:
  Download via pre-signed URL → goes directly S3 → full $0.09/GB egress
  Download via CloudFront OAC + CloudFront signed URL:
    S3 → CloudFront: free
    CloudFront → user: $0.0085/GB (first 10TB via CloudFront)
    Cached downloads: $0 from origin again

  For large media files or frequent downloads: CloudFront signed URL is 10× cheaper
  For single-download sensitive documents (audit reports): direct pre-signed URL is fine
```
