# File Upload Flow — Part 1 of 3

### Sections: 1 (Intuition & Analogy), 2 (Why It Exists), 3 (Core Technical Concepts), 4 (Real-World API Contract)

**Series:** Backend & API Design → REST APIs → System Design

---

## SECTION 1 — Intuition & Analogy

### The Post Office Analogy

Imagine two ways to mail a large package to someone across the country:

**Method A — Hand the package to the mail clerk**
You carry the package to the post office, hand it to the clerk, they weigh it, label it, scan it, and accept it into their custody. You wait the entire time. The clerk is the bottleneck — one clerk handling packages one-at-a-time from every customer.

**Method B — Use a shipping terminal (drop-off kiosk)**
The post office gives you a label with a pre-authorized drop ID. You go directly to the secure shipping terminal with your package. You scan the label, drop the package in the slot. The main post office clerk never touched your package — the terminal handled it. The clerk is free to serve the next customer. The shipping terminal is designed specifically for this — it handles many simultaneous drop-offs.

**In API terms:**

```
Method A = Uploading through your API server
  Client → PUT /upload → Your API server → forward to S3

  Problems:
  - API server loads entire file into memory (128MB Lambda limit)
  - Your Lambda or EC2 is the bottleneck for all uploads
  - File transfer consumes CPU, memory, AND network bandwidth of your server
  - Slow upload = Lambda timeout = upload fails
  - 100 concurrent 50MB uploads = 5GB of memory/bandwidth on your backend

Method B = Direct upload with presigned URL (the drop-off kiosk)
  Step 1: Client calls API server: "I want to upload a file"
  API server returns: { "upload_url": "https://s3.../presigned-url-here" }
  Step 2: Client uploads directly to S3 using that URL

  API server never sees the file bytes.
  S3 is infinitely scalable — designed for exactly this.
  100 concurrent 50MB uploads: zero load on your backend.
  Lambda handles lightweight API calls only → stays within limits.
```

The presigned URL is your temporary, pre-authorized drop-off slot — only the holder of that specific URL can use it, and only for a short time window (15 minutes).

---

## SECTION 2 — Why It Exists

### Problems with Naive Upload Through API Server

```
PROBLEM 1: Memory pressure
  A Lambda function has 128MB–10GB memory.
  A video upload might be 500MB.
  Uploading through Lambda:
  - Lambda must buffer the entire file in memory
  - Multiple concurrent uploads consume all available memory
  - Results in out-of-memory crashes and 500 errors
  - Users experience failed uploads with no retry guidance

PROBLEM 2: Network inefficiency
  Upload path: Client → CloudFront → API GW → Lambda → S3
  The file travels over 3 network hops before reaching S3.
  Direct upload: Client → (one pre-auth step) → CloudFront → S3
  Faster, fewer failure points, no bandwidth cost on your API tier.

PROBLEM 3: Timeout limitations
  API Gateway hard limit: 29 seconds max integration timeout
  Lambda hard limit: 15 minutes execution length
  Uploading 1GB file on a slow connection: 20+ minutes with 5 Mbps upload speed
  Direct Lambda upload: file upload times out, request fails, user loses progress

  Presigned URL upload: S3 handles the connection for up to the configured timeout
  (default 3600 seconds) — completely decoupled from API Gateway limits.

PROBLEM 4: No partial failure recovery
  Network hiccup at 80% through a 500MB upload → entire upload fails
  User must start over from byte 0

  S3 multipart upload:
  - Split 500MB into 50 parts of 10MB each
  - Upload parts in parallel (5x faster on high bandwidth connection)
  - Part 38 fails → retry just part 38
  - Complete upload after all parts succeed
  - Result: 500MB upload that tolerates partial failures

PROBLEM 5: Virus/malware in uploads
  User uploads malicious.exe disguised as invoice.pdf
  Without scanning: stored directly in S3, later served to other users
  With Lambda trigger: S3 event triggers ClamAV Lambda scan on each upload
  Infected file → quarantined to a separate bucket + alert
  Clean file → moved to production bucket + database record created
```

---

## SECTION 3 — Core Technical Concepts

### Presigned URLs: The Mechanism

```
How a presigned URL is generated:

1. Your API server generates a pre-signed S3 URL using AWS SDK:

   const s3 = new S3Client({ region: 'us-east-1' });

   // Define the S3 target key (where the file will land)
   const key = `uploads/${userId}/${Date.now()}-${filename}`;

   // Create the presigned PUT command
   const command = new PutObjectCommand({
     Bucket: 'invoiceflow-uploads',
     Key: key,
     ContentType: 'application/pdf',   // enforce expected MIME type
     ContentLength: 2048576,           // enforce max file size
     Metadata: {
       'uploaded-by': userId,
       'upload-timestamp': Date.now().toString()
     }
   });

   // Sign the URL with 15-minute expiry
   const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 900 });

2. Client uploads directly to the presigned URL:
   // No Authorization header needed — credentials embedded in URL
   await fetch(uploadUrl, {
     method: 'PUT',                    // Must match PutObjectCommand
     body: file,
     headers: {
       'Content-Type': 'application/pdf'  // Must match what was signed
     }
   });

3. On success: S3 returns 200 with ETag
   Client calls your API: POST /uploads/confirm { key: '...', etag: '...' }
   API creates database record for the upload

SECURITY PROPERTIES:
  - URL includes signature: HMAC-SHA256 of request parameters using AWS credentials
  - Signature covers: bucket, key, ContentType, ContentLength, Expiry
  - Changing ANY parameter invalidates the signature → S3 returns 403
  - URL expires automatically after configured time
  - Client can upload to this ONE key only — not any other S3 path
```

### File Type Validation: Magic Bytes vs MIME Type

```
DANGEROUS APPROACH — trust Content-Type header:
  if (file.contentType === 'application/pdf') → accept ✓

  Why it fails:
  curl -X PUT "https://s3.../presigned" \
    -H "Content-Type: application/pdf" \
    --data-binary @malicious.exe

  S3 stores malicious.exe with Content-Type: application/pdf
  User downloads and opens "invoice.pdf" which executes as .exe

CORRECT APPROACH — validate magic bytes (file signature):
  Every file format has a unique byte sequence at the beginning.

  PDF:    First 5 bytes: 25 50 44 46 2D   (%PDF-)
  PNG:    First 8 bytes: 89 50 4E 47 0D 0A 1A 0A
  JPEG:   First 3 bytes: FF D8 FF
  ZIP:    First 4 bytes: 50 4B 03 04      (also: docx, xlsx are ZIP-based)
  EXE:    First 2 bytes: 4D 5A            (MZ header)

  Lambda virus-scan function reads first 8 bytes of every uploaded file:
  const { Body } = await s3.getObject({ Bucket, Key });
  const buffer = Buffer.alloc(8);
  for await (const chunk of Body) {
    chunk.copy(buffer, 0, 0, 8);
    break;  // only need first 8 bytes
  }

  if (buffer.slice(0, 2).equals(Buffer.from([0x4D, 0x5A]))) {
    // Windows executable detected regardless of claimed Content-Type
    await quarantineFile(Key);
    throw new Error('INVALID_FILE_TYPE');
  }

VALIDATION LAYERS:
  1. Frontend: validate file extension + size before upload (UX — fast feedback)
  2. Presigned URL: ContentType restriction embeds content type intent in signature
  3. Post-upload Lambda: validate magic bytes (definitive content check)
  4. ClamAV scan: detect known malware signatures (not just format)
```

### Multipart Upload for Large Files

```
S3 MULTIPART UPLOAD PROTOCOL:

Files > 100MB: use multipart upload
Files 5MB–100MB: presigned single PUT or multipart
Files < 5MB: single presigned PUT

MULTIPART STEPS:
  Step 1: Initialize
    const { UploadId } = await s3.createMultipartUpload({
      Bucket: 'invoiceflow-uploads',
      Key: 'videos/training-video.mp4',
      ContentType: 'video/mp4'
    });
    // UploadId: '7YkNG...' — unique identifier for this multipart session

  Step 2: Upload each part (5MB minimum except last part)
    Parts may be uploaded in parallel:
    const partUploadPromises = chunks.map(async (chunk, i) => {
      const { ETag } = await s3.uploadPart({
        Bucket, Key, UploadId,
        PartNumber: i + 1,   // 1-indexed
        Body: chunk
      });
      return { PartNumber: i + 1, ETag };
    });
    const parts = await Promise.all(partUploadPromises);

  Step 3: Complete
    await s3.completeMultipartUpload({
      Bucket, Key, UploadId,
      MultipartUpload: { Parts: parts }
    });

  On failure: abort to avoid paying for stored incomplete parts
    await s3.abortMultipartUpload({ Bucket, Key, UploadId });

IMPORTANT: Set S3 lifecycle rule to abort incomplete multipart uploads > 7 days.
           Forgotten incomplete uploads incur storage charges.
           aws s3api put-bucket-lifecycle-configuration --bucket invoiceflow-uploads \
             --lifecycle-configuration '{"Rules":[{
               "AbortIncompleteMultipartUpload":{"DaysAfterInitiation":7},
               "Status":"Enabled","Filter":{"Prefix":""}}]}'
```

---

## SECTION 4 — Real-World API Contract

### InvoiceFlow Document Upload API

**Use case:** Invoice processors upload PDF invoices, supporting documents, and financial statements for automated processing.

```
UPLOAD FLOW:

┌──────────────────────────────────────────────────────────────────────┐
│                    INVOICEFLOW UPLOAD FLOW                           │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  STEP 1: Get upload authorization                                    │
│                                                                      │
│  POST /uploads/initiate                                              │
│  Authorization: Bearer <jwt>                                         │
│  {                                                                   │
│    "filename": "Q4-invoice.pdf",                                     │
│    "content_type": "application/pdf",                                │
│    "file_size_bytes": 2048576,                                       │
│    "purpose": "invoice"        // invoice | statement | receipt      │
│  }                                                                   │
│                                                                      │
│  Response 200:                                                       │
│  {                                                                   │
│    "upload_id": "upl_f47ac10b",                                     │
│    "upload_url": "https://invoiceflow-uploads.s3.amazonaws.com/...", │
│    "upload_method": "PUT",                                           │
│    "required_headers": {                                             │
│      "Content-Type": "application/pdf"                               │
│    },                                                                │
│    "expires_at": "2024-01-15T14:30:00Z",  // 15 min from now        │
│    "max_file_size_bytes": 52428800         // 50MB limit per file    │
│  }                                                                   │
│                                                                      │
│  STEP 2: Client uploads directly to S3                               │
│                                                                      │
│  PUT {upload_url}                                                    │
│  Content-Type: application/pdf                                       │
│  <binary file data>                                                  │
│                                                                      │
│  Response 200 (S3 direct response, not your API)                     │
│                                                                      │
│  STEP 3: Confirm the upload                                          │
│                                                                      │
│  POST /uploads/{upload_id}/confirm                                   │
│  Authorization: Bearer <jwt>                                         │
│  {                                                                   │
│    "etag": "\"d41d8cd98f00b204e9800998ecf8427e\""                    │
│  }                                                                   │
│                                                                      │
│  Response 201:                                                       │
│  {                                                                   │
│    "document_id": "doc_a1b2c3d4",                                   │
│    "filename": "Q4-invoice.pdf",                                     │
│    "file_size_bytes": 2048576,                                       │
│    "content_type": "application/pdf",                                │
│    "status": "processing",     // virus scanning + OCR in progress  │
│    "processing_webhook": "/webhooks/document-status",                │
│    "created_at": "2024-01-15T14:15:00Z"                             │
│  }                                                                   │
│                                                                      │
│  STEP 4: Webhook fires when processing completes                     │
│                                                                      │
│  POST {your webhook URL}                                             │
│  {                                                                   │
│    "event": "document.ready",                                        │
│    "document_id": "doc_a1b2c3d4",                                   │
│    "status": "ready",                                                │
│    "download_url": "https://cdn.invoiceflow.com/...",               │
│    "expires_at": "2024-01-15T15:15:00Z"  // signed download URL     │
│  }                                                                   │
│  or:                                                                 │
│  {                                                                   │
│    "event": "document.rejected",                                     │
│    "document_id": "doc_a1b2c3d4",                                   │
│    "status": "rejected",                                             │
│    "rejection_reason": "VIRUS_DETECTED",                             │
│    "details": "File failed security scan"                            │
│  }                                                                   │
└──────────────────────────────────────────────────────────────────────┘
```

**Error Scenarios**

```
FILE TOO LARGE — 413 before presigning (fast fail):
  POST /uploads/initiate
  { "file_size_bytes": 104857600 }  // 100MB, limit is 50MB

  Response 413:
  { "error": { "code": "FILE_TOO_LARGE",
    "message": "File size 100.0 MB exceeds the 50 MB limit",
    "limit_bytes": 52428800,
    "submitted_bytes": 104857600 } }

UNSUPPORTED FILE TYPE:
  Response 415:
  { "error": { "code": "UNSUPPORTED_FILE_TYPE",
    "message": "File type 'video/mp4' is not supported for purpose 'invoice'",
    "supported_types": ["application/pdf", "image/jpeg", "image/png", "image/tiff"],
    "submitted_type": "video/mp4" } }

EXPIRED PRESIGNED URL (S3 returns 403, client relays to confirm endpoint):
  POST /uploads/{upload_id}/confirm
  Response 400:
  { "error": { "code": "UPLOAD_URL_EXPIRED",
    "message": "The upload URL expired at 2024-01-15T14:30:00Z. Request a new one.",
    "expired_at": "2024-01-15T14:30:00Z",
    "action": "Call POST /uploads/initiate to get a new upload URL" } }
```

**Rate Limits**

```
POST /uploads/initiate:       10 requests/minute per user
POST /uploads/:id/confirm:    10 requests/minute per user
GET  /documents/:id:          100 requests/minute per user

Concurrent uploads per account:
  Free tier:       2 concurrent uploads
  Pro tier:        20 concurrent uploads
  Enterprise:      unlimited (governed by account agreement)
```
