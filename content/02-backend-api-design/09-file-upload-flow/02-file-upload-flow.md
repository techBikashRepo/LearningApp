# File Upload Flow — Part 2 of 3

### Sections: 5 (Architecture Diagram), 6 (Production Scenarios), 7 (Scaling & Reliability), 8 (AWS Implementation)

**Series:** Backend & API Design → REST APIs → System Design

---

## SECTION 5 — Architecture Diagram

### InvoiceFlow Upload Architecture

```
                    INVOICEFLOW FILE UPLOAD ARCHITECTURE
                    =====================================

CLIENT (Browser / Mobile App)
     │
     │  Step 1: POST /uploads/initiate (small JSON, milliseconds)
     ▼
┌─────────────────────────────────────────────────────────────────┐
│                         CloudFront CDN                          │
│  • Routes /uploads/initiate to API Gateway                      │
│  • Routes /documents/* to API Gateway                           │
│  • Direct S3 uploads bypass CloudFront (go to S3 endpoint)      │
│  • Signed download URLs: CloudFront signed URLs                 │
│    (files served via CDN, not directly from S3)                 │
└─────────────────────────┬───────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                       API Gateway                               │
│  • Auth: JWT validation (Cognito authorizer)                    │
│  • Rate limiting: 10 presign requests/minute/user               │
│  • Request validation: required fields, content_type whitelist  │
│  • Routes to Upload Initiation Lambda                           │
└─────────────────────────┬───────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│            Upload Initiation Lambda                             │
│                                                                  │
│  1. Validate: file size ≤ 50MB, content type in whitelist       │
│  2. Generate S3 key: uploads/{userId}/{uuid}.{ext}              │
│  3. Generate presigned URL (S3 PutObject, 15-min expiry)        │
│  4. Record pending upload in DynamoDB                           │
│     { upload_id, user_id, s3_key, status: 'pending',           │
│       expires_at, created_at }                                  │
│  5. Return presigned URL + upload_id to client                  │
└─────────────────────────────────────────────────────────────────┘

    │ (client now has presigned URL)
    │
    │  Step 2: PUT directly to S3 (large binary, S3 handles it)
    ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Amazon S3                                  │
│              Staging Bucket (invoiceflow-staging)               │
│                                                                  │
│  • Receives PUT with presigned URL — verifies signature          │
│  • Stores file at: uploads/{userId}/{uuid}.pdf                  │
│  • S3 Event Notification fires on ObjectCreated event           │
│  • Staging bucket: NOT publicly accessible                      │
│  • No static website hosting — no direct download               │
│  • Objects moved to prod bucket after passing scan              │
└─────────────────────────┬───────────────────────────────────────┘
                          │  ObjectCreated event
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│             Virus Scan Lambda                                   │
│             (triggered by S3 ObjectCreated event)               │
│                                                                  │
│  1. Download file from staging bucket                           │
│  2. Read first 8 bytes → validate magic bytes (filetype)        │
│  3. Run ClamAV scan (malware signature database)                │
│  4. If PASS:                                                    │
│     • Copy file to production bucket (object moved, not staged) │
│     • Update DynamoDB: status → 'processing'                    │
│     • Send SQS message for OCR/metadata extraction              │
│     • Delete from staging bucket                                │
│  5. If FAIL:                                                    │
│     • Move file to quarantine bucket                            │
│     • Update DynamoDB: status → 'rejected'                      │
│     • Send webhook event: document.rejected                     │
│     • Alert security team via SNS                               │
└─────────────────────────┬───────────────────────────────────────┘
                          │  SQS message (clean files only)
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│             Document Processing Lambda                          │
│                                                                  │
│  • Textract: OCR extraction (invoice fields: vendor, amount)    │
│  • Rekognition: image content validation (is this an invoice?)  │
│  • Extract: page count, document type, date                     │
│  • Store metadata in DynamoDB                                   │
│  • Generate CloudFront signed URL (24-hour download link)       │
│  • Fire webhook: document.ready                                 │
└─────────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Amazon S3                                  │
│              Production Bucket (invoiceflow-prod)               │
│                                                                  │
│  • Objects served via CloudFront signed URLs only               │
│  • SSE-KMS encryption at rest                                   │
│  • Versioning enabled (accidental overwrite protection)         │
│  • Lifecycle: archive to Glacier after 90 days                  │
│  • Cross-region replication to us-west-2 (disaster recovery)    │
│  • Access logging: all GET requests logged to audit bucket      │
└─────────────────────────────────────────────────────────────────┘

CONFIRM STEP (Step 3: client calls your API):

    Client → POST /uploads/{upload_id}/confirm { etag }
    Upload Confirm Lambda:
    1. Verify upload_id belongs to this user (authorization)
    2. Verify upload exists in staging or prod bucket (confirms S3 upload happened)
    3. Verify ETag matches (prevents confirming a file the client never uploaded)
    4. Update DynamoDB: status → 'received' (awaiting scan result)
    5. Return document_id to client

S3 BUCKET STRUCTURE:
  invoiceflow-staging    → presigned PUT targets here
  invoiceflow-prod       → clean files live here forever
  invoiceflow-quarantine → infected/rejected files (for forensics)
  invoiceflow-audit      → access logs (immutable, lifecycle only)
```

---

## SECTION 6 — Production Scenarios

### Scenario A: Dropbox's Upload Approach — Chunked Upload

```
Dropbox engineering (from their tech blog):
  Problem: 1-10GB files uploaded over mobile connections
  Mobile upload: connection drops frequently
  Without chunked upload: 80% through a 2GB upload → drop → restart from 0
  User experience: impossible to upload large files on mobile

Dropbox solution — resumable chunked upload:

  Step 1: /upload/start → session_id
  Step 2: /upload/append (repeated, each call uploads one chunk)
    Upload 4MB → server stores chunk, returns offset
    Network drops → client knows it stopped at offset 4MB
    Client resumes: /upload/append with offset=4194304 → continues from there
  Step 3: /upload/finish → file committed, metadata created

KEY DESIGN:
  Server stores chunks temporarily, tracks offset per session
  Client sends X-Dropbox-Offset header with each append
  If offset doesn't match server's record: 400 INCORRECT_OFFSET
  Client can always query /upload/session for current offset to recover state

AWS equivalent: S3 multipart upload
  UploadId = session_id
  PartNumber = chunk index
  Can query ListParts to find which parts succeeded
  Resume by skipping already-uploaded parts
```

---

### Scenario B: File Type Validation Failure — The Polyglot Attack

```
A "polyglot" file is a file that is simultaneously valid as two formats.
Example: a file that is both a valid JPEG and a valid JavaScript file.

Attack vector:
  Attacker uploads a file with:
  - Magic bytes: FF D8 FF (valid JPEG header)
  - Content at offset 100: <script>maliciousCode()</script>

  Your validator: "magic bytes match JPEG, accept file"
  Server stores file as image/jpeg

  If served in HTML via <img src="...">, browser renders JPEG
  If served with wrong Content-Type header, browser may execute JS

  This has affected Slack, Dropbox, and Google Drive historically.

Defense:
  1. Always set Content-Disposition: attachment for downloadable files
     (forces browser to download, not render)
  2. Serve from a separate domain (attacker.your-uploads.com, not app.company.com)
     JavaScript can't access cookies from the main domain if served from upload subdomain
  3. Re-encode images using Sharp/Pillow before storing
     Re-encoding destroys all embedded payloads (strips non-image data)
     Image comes out completely clean on the other side
  4. For PDFs: parse with PDF.js in sandboxed environment, reject malformed structures

Re-encoding example:
  import sharp from 'sharp';
  // Re-encode: destroys all metadata and embedded content
  const safeImage = await sharp(inputBuffer)
    .jpeg({ quality: 90 })  // JPEG re-encode strips all non-JPEG data
    .toBuffer();
  await s3.putObject({ Bucket: 'prod', Key: key, Body: safeImage });
```

---

## SECTION 7 — Scaling & Reliability

### Progress Tracking for Large Uploads

```
PROBLEM: User uploads 500MB file. During 10-minute upload:
  - UI shows spinner (no progress)
  - User doesn't know if it's working
  - User refreshes page → interrupts upload → starts over

SOLUTION — Upload progress via browser's XMLHttpRequest or fetch with streams:

// Browser: track upload progress
const xhr = new XMLHttpRequest();
xhr.upload.addEventListener('progress', (event) => {
  if (event.lengthComputable) {
    const percentComplete = (event.loaded / event.total) * 100;
    updateProgressBar(percentComplete);
    updateLabel(`${formatBytes(event.loaded)} / ${formatBytes(event.total)}`);
  }
});
xhr.open('PUT', presignedUrl);
xhr.setRequestHeader('Content-Type', 'application/pdf');
xhr.send(file);

// OR modern fetch with ReadableStream (no progress events, but works in workers):
const response = await fetch(presignedUrl, {
  method: 'PUT',
  body: createProgressStream(file, onProgress),  // wrapper stream
  headers: { 'Content-Type': contentType }
});

SERVER-SIDE PROGRESS:
  For multipart uploads, each part upload represents a milestone.
  Client can query: GET /uploads/{upload_id} → { status, parts_uploaded, parts_total }

  DynamoDB record updated after each part completes:
  { upload_id, parts_total: 50, parts_uploaded: 23, percent: 46, status: 'uploading' }
```

### Upload Retry Strategy

```
EXPONENTIAL BACKOFF FOR FAILED PARTS:

const uploadPartWithRetry = async (params, maxRetries = 3) => {
  let delay = 1000;  // start: 1 second

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await s3.uploadPart(params);
    } catch (error) {
      if (attempt === maxRetries) throw error;

      // Retryable: network errors, S3 503/500
      // Not retryable: 403 (presigned URL expired), 400 (bad params)
      if (error.statusCode === 403 || error.statusCode === 400) throw error;

      await sleep(delay + Math.random() * 1000);  // jitter
      delay *= 2;  // 1s → 2s → 4s
    }
  }
};

HANDLING EXPIRED PRESIGNED URLS:
  Problem: User starts multipart upload, pauses for 2 hours, resumes
  Presigned URL expired (15-minute expiry)

  Solution:
  1. Client: if 403 received during upload → call /uploads/{id}/refresh
  2. Server: issue new presigned URL for remaining parts
  3. Client: resume upload with new URL

  DynamoDB stores: { upload_id, s3_key, uploadId (S3 multipart) }
  Server can always generate new presigned URL for same S3 uploadId.
```

### Concurrent Upload Management

```
For large files, upload parts in parallel for maximum throughput:

PARALLEL UPLOAD WITH CONCURRENCY LIMIT:

const uploadAllParts = async (uploadId, key, chunks) => {
  const concurrencyLimit = 5;  // 5 parts uploading simultaneously
  const parts = [];

  // Process in batches of concurrencyLimit
  for (let i = 0; i < chunks.length; i += concurrencyLimit) {
    const batch = chunks.slice(i, i + concurrencyLimit);
    const batchParts = await Promise.all(
      batch.map((chunk, j) =>
        uploadPartWithRetry({
          Bucket: 'invoiceflow-staging',
          Key: key,
          UploadId: uploadId,
          PartNumber: i + j + 1,
          Body: chunk
        })
      )
    );
    parts.push(...batchParts.map((p, j) => ({
      PartNumber: i + j + 1,
      ETag: p.ETag
    })));
  }

  return parts;
};

Performance comparison for 500MB file (50 x 10MB parts):
  Sequential:    50 parts × 3 seconds each = 150 seconds (2.5 minutes)
  5 concurrent:  10 batches × 3 seconds each = 30 seconds (5x faster)
  10 concurrent: 5 batches × 3 seconds each = 15 seconds (10x faster)

  But: too many concurrent connections → S3 throttling → errors → retries
  Practical optimum: 5-10 concurrent part uploads per client
```

---

## SECTION 8 — AWS Implementation

### Full Infrastructure (CloudFormation)

```yaml
AWSTemplateFormatVersion: "2010-09-09"
Description: InvoiceFlow File Upload Infrastructure

Resources:
  # Staging bucket — presigned PUT targets here
  StagingBucket:
    Type: AWS::S3::Bucket
    Properties:
      BucketName: !Sub "invoiceflow-staging-${AWS::AccountId}"
      PublicAccessBlockConfiguration:
        BlockPublicAcls: true
        BlockPublicPolicy: true
        IgnorePublicAcls: true
        RestrictPublicBuckets: true
      CorsConfiguration:
        CorsRules:
          - AllowedMethods: [PUT] # Only PUT allowed (presigned upload)
            AllowedOrigins: ["https://app.invoiceflow.com"]
            AllowedHeaders: ["Content-Type", "Content-Length"]
            MaxAge: 3600
      LifecycleConfiguration:
        Rules:
          - Status: Enabled # Abort incomplete multipart uploads
            AbortIncompleteMultipartUpload:
              DaysAfterInitiation: 1
          - Status: Enabled # Delete unconfirmed uploads after 2 days
            ExpirationInDays: 2
      NotificationConfiguration:
        LambdaConfigurations:
          - Event: "s3:ObjectCreated:*"
            Function: !GetAtt VirusScanLambda.Arn

  # Production bucket — clean files only
  ProductionBucket:
    Type: AWS::S3::Bucket
    Properties:
      BucketName: !Sub "invoiceflow-prod-${AWS::AccountId}"
      PublicAccessBlockConfiguration:
        BlockPublicAcls: true
        BlockPublicPolicy: true
        IgnorePublicAcls: true
        RestrictPublicBuckets: true
      BucketEncryption:
        ServerSideEncryptionConfiguration:
          - ServerSideEncryptionByDefault:
              SSEAlgorithm: aws:kms
              KMSMasterKeyID: !Ref DocumentEncryptionKey
      VersioningConfiguration:
        Status: Enabled
      LifecycleConfiguration:
        Rules:
          - Status: Enabled
            Transitions:
              - TransitionInDays: 90
                StorageClass: GLACIER
      ReplicationConfiguration: # Cross-region DR
        Role: !GetAtt ReplicationRole.Arn
        Rules:
          - Status: Enabled
            Destination:
              Bucket: !Sub "arn:aws:s3:::invoiceflow-prod-dr-${AWS::AccountId}"
              StorageClass: STANDARD_IA
```

### Upload Initiation Lambda

```javascript
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { randomUUID } from "crypto";
import { withErrorHandler, ApiError } from "/opt/nodejs/error-handler.js";

const s3 = new S3Client({ region: process.env.AWS_REGION });
const ddb = new DynamoDBClient({ region: process.env.AWS_REGION });

const ALLOWED_TYPES = {
  invoice: ["application/pdf", "image/jpeg", "image/png", "image/tiff"],
  statement: ["application/pdf"],
  receipt: ["application/pdf", "image/jpeg", "image/png"],
};

const MAX_FILE_SIZE = 52428800; // 50MB
const URL_EXPIRY_SECONDS = 900; // 15 minutes

export const handler = withErrorHandler(async (event, context, requestId) => {
  const userId = event.requestContext.authorizer.claims.sub;
  const body = JSON.parse(event.body);
  const { filename, content_type, file_size_bytes, purpose } = body;

  // Validate file size (fast fail — before generating presigned URL)
  if (file_size_bytes > MAX_FILE_SIZE) {
    throw new ApiError(
      413,
      "FILE_TOO_LARGE",
      `File size ${(file_size_bytes / 1024 / 1024).toFixed(1)} MB exceeds the 50 MB limit`,
      [
        {
          field: "file_size_bytes",
          code: "EXCEEDS_MAXIMUM",
          maximum: MAX_FILE_SIZE,
        },
      ],
    );
  }

  // Validate content type for purpose
  const allowedTypes = ALLOWED_TYPES[purpose] ?? [];
  if (!allowedTypes.includes(content_type)) {
    throw new ApiError(
      415,
      "UNSUPPORTED_FILE_TYPE",
      `File type '${content_type}' is not supported for purpose '${purpose}'`,
      [{ supported_types: allowedTypes, submitted_type: content_type }],
    );
  }

  // Generate safe S3 key (never trust filename from client — could path-traverse)
  const ext = filename
    .split(".")
    .pop()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  const uploadId = `upl_${randomUUID().replace(/-/g, "")}`;
  const s3Key = `uploads/${userId}/${uploadId}.${ext}`;

  // Generate presigned URL
  const command = new PutObjectCommand({
    Bucket: process.env.STAGING_BUCKET,
    Key: s3Key,
    ContentType: content_type,
    ContentLength: file_size_bytes,
    Metadata: {
      "upload-id": uploadId,
      "user-id": userId,
      "original-filename": encodeURIComponent(filename),
      purpose: purpose,
    },
  });

  const uploadUrl = await getSignedUrl(s3, command, {
    expiresIn: URL_EXPIRY_SECONDS,
  });
  const expiresAt = new Date(
    Date.now() + URL_EXPIRY_SECONDS * 1000,
  ).toISOString();

  // Record pending upload in DynamoDB
  await ddb.send(
    new PutItemCommand({
      TableName: process.env.UPLOADS_TABLE,
      Item: {
        upload_id: { S: uploadId },
        user_id: { S: userId },
        s3_key: { S: s3Key },
        original_filename: { S: filename },
        content_type: { S: content_type },
        file_size_bytes: { N: String(file_size_bytes) },
        purpose: { S: purpose },
        status: { S: "pending" },
        expires_at: { S: expiresAt },
        created_at: { S: new Date().toISOString() },
      },
      ConditionExpression: "attribute_not_exists(upload_id)", // idempotency
    }),
  );

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      upload_id: uploadId,
      upload_url: uploadUrl,
      upload_method: "PUT",
      required_headers: { "Content-Type": content_type },
      expires_at: expiresAt,
      max_file_size_bytes: MAX_FILE_SIZE,
    }),
  };
});
```

### Virus Scan Lambda

```javascript
import {
  S3Client,
  GetObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@aws-sdk/node-http-handler";
import ClamScan from "clamscan";

const s3 = new S3Client({ region: process.env.AWS_REGION });

// Magic byte signatures for allowed file types
const MAGIC_BYTES = {
  PDF: { offset: 0, bytes: Buffer.from([0x25, 0x50, 0x44, 0x46]) }, // %PDF
  JPEG: { offset: 0, bytes: Buffer.from([0xff, 0xd8, 0xff]) },
  PNG: {
    offset: 0,
    bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  TIFF_LE: { offset: 0, bytes: Buffer.from([0x49, 0x49, 0x2a, 0x00]) },
  TIFF_BE: { offset: 0, bytes: Buffer.from([0x4d, 0x4d, 0x00, 0x2a]) },
};

const FORBIDDEN_MAGIC = [
  { name: "Windows EXE/DLL", bytes: Buffer.from([0x4d, 0x5a]) },
  { name: "ELF binary", bytes: Buffer.from([0x7f, 0x45, 0x4c, 0x46]) },
  { name: "Shell script", bytes: Buffer.from([0x23, 0x21]) }, // #!
];

export const handler = async (event) => {
  const s3Record = event.Records[0].s3;
  const bucket = s3Record.bucket.name;
  const key = decodeURIComponent(s3Record.object.key);

  console.log(JSON.stringify({ action: "scan_start", bucket, key }));

  // 1. Download file (stream first 8 bytes for magic check + full for ClamAV)
  const { Body } = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  const chunks = [];
  for await (const chunk of Body) chunks.push(chunk);
  const fileBuffer = Buffer.concat(chunks);

  // 2. Check forbidden magic bytes
  for (const forbidden of FORBIDDEN_MAGIC) {
    if (fileBuffer.slice(0, forbidden.bytes.length).equals(forbidden.bytes)) {
      console.warn(
        JSON.stringify({
          action: "magic_bytes_rejected",
          key,
          type: forbidden.name,
        }),
      );
      return await rejectFile(
        bucket,
        key,
        "INVALID_FILE_TYPE",
        `File content matches forbidden type: ${forbidden.name}`,
      );
    }
  }

  // 3. Run ClamAV scan
  const clamscan = await new ClamScan().init({ removeInfected: false });
  const { isInfected, viruses } = await clamscan.scanBuffer(fileBuffer);

  if (isInfected) {
    console.warn(JSON.stringify({ action: "virus_detected", key, viruses }));
    return await rejectFile(
      bucket,
      key,
      "VIRUS_DETECTED",
      `File contains known malware signature`,
    );
  }

  // 4. File is clean — move to production bucket
  await s3.send(
    new CopyObjectCommand({
      Bucket: process.env.PROD_BUCKET,
      CopySource: `${bucket}/${key}`,
      Key: key,
      ServerSideEncryption: "aws:kms",
    }),
  );

  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));

  // 5. Send to processing queue (OCR, metadata extraction)
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: process.env.PROCESSING_QUEUE_URL,
      MessageBody: JSON.stringify({ key, bucket: process.env.PROD_BUCKET }),
    }),
  );

  console.log(JSON.stringify({ action: "scan_pass", key }));
};
```
