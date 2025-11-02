# File Storage Options for Civic OS

This document explores various approaches to integrating file storage (specifically AWS S3) with Civic OS's PostgREST-based architecture, where PostgreSQL and PostgREST serve as the primary communication hub with Angular.

## Problem Statement

S3 file storage typically requires server-side software to:
- Generate presigned URLs for secure uploads
- Generate presigned URLs for private file retrieval
- Sign requests with AWS credentials

The challenge: How to integrate this with Civic OS's architecture where Angular communicates exclusively through PostgREST to PostgreSQL, without introducing a traditional application server?

## Initial Options Considered

### Option 1: PostgreSQL BYTEA Storage

Store files directly in PostgreSQL using binary columns.

**Architecture:**
```sql
CREATE TABLE blobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type TEXT,
  entity_id UUID,
  file_name TEXT,
  data BYTEA,
  size INTEGER GENERATED ALWAYS AS (octet_length(data)) STORED,
  content_type TEXT,
  hash TEXT GENERATED ALWAYS AS (encode(sha256(data), 'hex')) STORED,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  metadata JSONB
);
```

**Upload:** Angular → PostgREST → PostgreSQL
**Download:** PostgreSQL RPC function returns BYTEA with headers

**Pros:**
- Zero additional infrastructure
- Perfect fit with metadata-driven architecture
- Built-in RBAC via Row-Level Security
- Automatic backups with database

**Cons:**
- Database bloat for large files
- Not ideal for files >10MB
- Higher storage costs than object storage
- Performance impact under heavy file traffic

**Best for:** Small files (<1-5MB), low-to-moderate volume, documents/PDFs/small images

---

### Option 2: PostgreSQL plpython3u Extension

Use Python inside PostgreSQL to generate AWS signatures.

**Architecture:**
```sql
CREATE EXTENSION plpython3u;

CREATE OR REPLACE FUNCTION generate_upload_url(
  bucket TEXT,
  key TEXT,
  expires_in INTEGER DEFAULT 3600
)
RETURNS TEXT AS $$
  import boto3
  from botocore.client import Config

  s3 = boto3.client('s3',
    region_name='us-east-1',
    config=Config(signature_version='s3v4')
  )

  url = s3.generate_presigned_url(
    'put_object',
    Params={'Bucket': bucket, 'Key': key},
    ExpiresIn=expires_in
  )
  return url
$$ LANGUAGE plpython3u SECURITY DEFINER;
```

**Pros:**
- Leverages S3 scalability
- No separate application server
- Fits PostgREST pattern
- AWS credentials stay in database

**Cons:**
- Requires plpython3u (superuser to install, security risk)
- AWS SDK dependencies in PostgreSQL
- Complex debugging (Python errors in SQL)
- Not available on all hosting providers
- Credentials stored in database environment

**Best for:** Self-hosted PostgreSQL with full control

---

### Option 3: AWS Lambda Function

Single-purpose Lambda to generate presigned URLs.

**Architecture:**
```javascript
// Lambda handler
const AWS = require('aws-sdk');
const s3 = new AWS.S3();

exports.handler = async (event) => {
  const { fileName, fileType } = JSON.parse(event.body);

  const url = await s3.getSignedUrlPromise('putObject', {
    Bucket: process.env.S3_BUCKET,
    Key: fileName,
    ContentType: fileType,
    Expires: 3600
  });

  return {
    statusCode: 200,
    headers: { 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({ url })
  };
};
```

**Pros:**
- Purpose-built for this use case
- Minimal code (~20 lines)
- AWS-managed, auto-scales
- Free tier covers most use cases
- Industry standard pattern

**Cons:**
- Breaks Angular → PostgREST-only communication
- Requires AWS account/configuration
- CORS configuration needed
- Another deployment to manage

**Best for:** Production apps with moderate-to-high file volumes

---

### Option 4: Cloudflare Workers

Similar to Lambda but using Cloudflare's edge platform.

**Pros:**
- Simpler than AWS Lambda
- Faster edge execution
- Can use Cloudflare R2 (no egress fees)
- Generous free tier

**Cons:**
- Another platform to learn
- Breaks PostgREST communication pattern
- Limited to JavaScript/TypeScript

**Best for:** Already using Cloudflare or want simpler than AWS

---

### Option 5: Public S3 with UUID Security

Store files in public bucket with unguessable UUIDs.

**Pros:**
- No presigning needed
- Simple implementation
- Fast CDN delivery

**Cons:**
- Security through obscurity
- Cannot revoke access
- Not suitable for sensitive data
- URLs can be leaked/shared

**Best for:** Non-sensitive public assets only (avatars, logos)

---

## PostgreSQL-Native Approaches (RECOMMENDED)

These approaches maintain the architectural principle of PostgreSQL/PostgREST as the communication hub.

### Approach A: pg_net Extension (Async HTTP) ⭐ TOP RECOMMENDATION

**What is pg_net?**
- PostgreSQL extension developed by Supabase
- Enables asynchronous HTTP/HTTPS requests from SQL
- Non-blocking (safe to use in triggers)
- Responses stored in `net._http_response` table

**Architecture:**
```
Angular → PostgREST → PostgreSQL Function → pg_net (async HTTP) → Micro-service
                           ↓                                            ↓
                      Store request_id                        Generate S3 URL
                           ↓                                            ↓
                      Poll for response  ← pg_net stores response ← Return URL
                           ↓
                    Return URL to Angular
```

**PostgreSQL Implementation:**

```sql
-- 1. Enable pg_net
CREATE EXTENSION pg_net;

-- 2. Table to track URL requests
CREATE TABLE file_upload_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type TEXT,
  entity_id UUID,
  file_name TEXT,
  file_type TEXT,
  status TEXT DEFAULT 'pending',  -- pending, processing, completed, failed
  presigned_url TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add RLS policies as needed
ALTER TABLE file_upload_requests ENABLE ROW LEVEL SECURITY;

-- 3. Function to request presigned URL
CREATE OR REPLACE FUNCTION request_upload_url(
  p_entity_type TEXT,
  p_entity_id UUID,
  p_file_name TEXT,
  p_file_type TEXT
) RETURNS UUID AS $$
DECLARE
  v_request_id UUID;
  v_http_request_id BIGINT;
BEGIN
  -- Create tracking record
  INSERT INTO file_upload_requests (entity_type, entity_id, file_name, file_type)
  VALUES (p_entity_type, p_entity_id, p_file_name, p_file_type)
  RETURNING id INTO v_request_id;

  -- Make async HTTP call to signing service
  SELECT net.http_post(
    url := 'http://s3-signer:3001/sign-upload',
    body := jsonb_build_object(
      'requestId', v_request_id,
      'fileName', p_file_name,
      'fileType', p_file_type,
      'entityType', p_entity_type,
      'entityId', p_entity_id
    )
  ) INTO v_http_request_id;

  -- Update status
  UPDATE file_upload_requests
  SET status = 'processing'
  WHERE id = v_request_id;

  RETURN v_request_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 4. Function to check if URL is ready
CREATE OR REPLACE FUNCTION get_upload_url(p_request_id UUID)
RETURNS TABLE(status TEXT, url TEXT, error TEXT) AS $$
  SELECT status, presigned_url, error_message
  FROM file_upload_requests
  WHERE id = p_request_id;
$$ LANGUAGE SQL;

-- 5. Grant permissions
GRANT EXECUTE ON FUNCTION request_upload_url TO authenticated;
GRANT EXECUTE ON FUNCTION get_upload_url TO authenticated;
```

**Micro-service Implementation (Node.js):**

```javascript
// sign-service.js
const express = require('express');
const AWS = require('aws-sdk');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

const s3 = new AWS.S3({
  region: process.env.AWS_REGION || 'us-east-1'
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

// Sign upload URL
app.post('/sign-upload', async (req, res) => {
  const { requestId, fileName, fileType, entityType, entityId } = req.body;

  console.log(`Processing request ${requestId} for ${fileName}`);

  try {
    // Generate S3 key with entity hierarchy
    const s3Key = `${entityType}/${entityId}/${Date.now()}-${fileName}`;

    // Generate presigned URL
    const presignedUrl = await s3.getSignedUrlPromise('putObject', {
      Bucket: process.env.S3_BUCKET,
      Key: s3Key,
      ContentType: fileType,
      Expires: 3600 // 1 hour
    });

    // Update PostgreSQL with the URL
    await pool.query(
      `UPDATE file_upload_requests
       SET status = $1, presigned_url = $2
       WHERE id = $3`,
      ['completed', presignedUrl, requestId]
    );

    console.log(`Successfully generated URL for request ${requestId}`);
    res.json({ success: true });

  } catch (error) {
    console.error(`Error processing request ${requestId}:`, error);

    // Update with error
    await pool.query(
      `UPDATE file_upload_requests
       SET status = $1, error_message = $2
       WHERE id = $3`,
      ['failed', error.message, requestId]
    );

    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`S3 signing service listening on port ${PORT}`);
});
```

**Docker Compose Setup:**

```yaml
# Add to examples/pothole/docker-compose.yml
services:
  s3-signer:
    build: ./s3-signer-service
    container_name: s3_signer
    environment:
      - DATABASE_URL=postgres://postgres:${POSTGRES_PASSWORD}@postgres_db:5432/civic_os_db
      - AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID}
      - AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY}
      - AWS_REGION=${AWS_REGION:-us-east-1}
      - S3_BUCKET=${S3_BUCKET}
      - PORT=3001
    networks:
      - postgres_network
    depends_on:
      - postgres
```

**Dockerfile for Micro-service:**

```dockerfile
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY sign-service.js ./

EXPOSE 3001

CMD ["node", "sign-service.js"]
```

**Angular Implementation:**

```typescript
// file-upload.service.ts
import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { environment } from '../environments/environment';
import { firstValueFrom, interval, take, switchMap } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class FileUploadService {
  private apiUrl = environment.apiUrl;

  constructor(private http: HttpClient) {}

  async uploadFile(
    file: File,
    entityType: string,
    entityId: string
  ): Promise<void> {
    // Step 1: Request presigned URL
    const requestId = await firstValueFrom(
      this.http.post<string>(`${this.apiUrl}/rpc/request_upload_url`, {
        p_entity_type: entityType,
        p_entity_id: entityId,
        p_file_name: file.name,
        p_file_type: file.type
      })
    );

    // Step 2: Poll for URL (max 10 seconds, check every 500ms)
    const maxAttempts = 20;
    let attempt = 0;
    let url: string | null = null;

    while (!url && attempt < maxAttempts) {
      const response = await firstValueFrom(
        this.http.get<{ status: string; url: string; error: string }>(
          `${this.apiUrl}/rpc/get_upload_url?p_request_id=${requestId}`
        )
      );

      if (response.status === 'completed') {
        url = response.url;
        break;
      } else if (response.status === 'failed') {
        throw new Error(response.error || 'Failed to get upload URL');
      }

      // Wait 500ms before next attempt
      await new Promise(resolve => setTimeout(resolve, 500));
      attempt++;
    }

    if (!url) {
      throw new Error('Timeout waiting for upload URL');
    }

    // Step 3: Upload directly to S3
    await firstValueFrom(
      this.http.put(url, file, {
        headers: { 'Content-Type': file.type }
      })
    );

    // Step 4: (Optional) Save file metadata to your entities table
    // await this.saveFileMetadata(entityType, entityId, file.name, url);
  }
}
```

**Usage in Component:**

```typescript
@Component({
  selector: 'app-file-upload',
  template: `
    <input type="file" (change)="onFileSelected($event)" />
    @if (uploading()) {
      <span class="loading loading-spinner"></span>
    }
    @if (error(); as err) {
      <div class="alert alert-error">{{ err }}</div>
    }
  `
})
export class FileUploadComponent {
  uploading = signal(false);
  error = signal<string | undefined>(undefined);

  constructor(private uploadService: FileUploadService) {}

  async onFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    this.uploading.set(true);
    this.error.set(undefined);

    try {
      await this.uploadService.uploadFile(
        file,
        'Issue',
        this.issueId
      );
      // Success - refresh data or show success message
    } catch (err) {
      this.error.set(err.message);
    } finally {
      this.uploading.set(false);
    }
  }
}
```

**Installing pg_net:**

```bash
# For Docker (add to Dockerfile or init script)
apt-get update
apt-get install -y postgresql-17-pg-net

# Then in PostgreSQL
CREATE EXTENSION pg_net;

# Configure (optional, in postgresql.conf)
shared_preload_libraries = 'pg_net'
```

**Pros:**
- ✅ PostgreSQL remains the communication hub (Angular ↔ PostgREST only)
- ✅ Non-blocking - Safe to use in triggers
- ✅ Native PostgreSQL extension (no Python/untrusted languages)
- ✅ Lightweight service - Only handles S3 signing (~50 lines)
- ✅ Scales well - Service is stateless, multiple instances possible
- ✅ Audit trail - All requests logged in database
- ✅ Used by Supabase (battle-tested)

**Cons:**
- ❌ Requires pg_net extension (not available on all hosts)
- ❌ Polling required on Angular side (adds ~500ms-1s latency)
- ❌ More complex than direct Lambda approach
- ❌ Still need to deploy/manage micro-service
- ❌ Extension is in beta (API may change)

**Best for:** Production applications maintaining architectural purity

---

### Approach B: pgsql-http Extension (Sync HTTP)

**What is pgsql-http?**
- PostgreSQL extension by Paul Ramsey
- Enables synchronous HTTP requests from SQL
- Blocks until response received
- Simple request/response pattern

**PostgreSQL Implementation:**

```sql
-- 1. Enable http extension
CREATE EXTENSION http;

-- 2. Function to get presigned URL synchronously
CREATE OR REPLACE FUNCTION get_upload_url_sync(
  p_entity_type TEXT,
  p_entity_id UUID,
  p_file_name TEXT,
  p_file_type TEXT
) RETURNS TEXT AS $$
DECLARE
  v_response http_response;
  v_url TEXT;
BEGIN
  -- Make synchronous HTTP call
  SELECT * INTO v_response FROM http_post(
    'http://s3-signer:3001/sign-upload',
    jsonb_build_object(
      'fileName', p_file_name,
      'fileType', p_file_type,
      'entityType', p_entity_type,
      'entityId', p_entity_id
    )::text,
    'application/json'
  );

  -- Check status
  IF v_response.status != 200 THEN
    RAISE EXCEPTION 'Failed to get presigned URL: %', v_response.content;
  END IF;

  -- Parse response
  v_url := (v_response.content::jsonb)->>'url';

  RETURN v_url;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION get_upload_url_sync TO authenticated;
```

**Micro-service:** Same as pg_net approach (just returns URL in response)

**Angular Implementation:**

```typescript
// Simpler - single call, no polling!
async uploadFile(file: File, entityType: string, entityId: string) {
  // Step 1: Get presigned URL (blocks until ready)
  const { url } = await firstValueFrom(
    this.http.post<{ url: string }>(`${this.apiUrl}/rpc/get_upload_url_sync`, {
      p_entity_type: entityType,
      p_entity_id: entityId,
      p_file_name: file.name,
      p_file_type: file.type
    })
  );

  // Step 2: Upload to S3
  await firstValueFrom(
    this.http.put(url, file, {
      headers: { 'Content-Type': file.type }
    })
  );
}
```

**Pros:**
- ✅ Simpler flow - No polling required
- ✅ PostgreSQL remains hub
- ✅ Immediate response
- ✅ Easier to reason about
- ✅ Fewer moving parts

**Cons:**
- ❌ **Blocks PostgreSQL connection** during HTTP call (1-2 seconds)
- ❌ Cannot use in triggers (would block writes)
- ❌ If external service is slow/down, impacts user directly
- ❌ Timeouts affect database connection pool
- ❌ Not suitable for high-concurrency scenarios

**Best for:** Low-volume applications, simple use cases, prototyping

---

### Approach C: LISTEN/NOTIFY + External Worker

**What is LISTEN/NOTIFY?**
- Built-in PostgreSQL pub/sub mechanism
- No extension required
- External workers listen for notifications
- Process work asynchronously

**Architecture:**
```
Angular → PostgREST → PostgreSQL INSERT + NOTIFY
                           ↓
                      Returns request_id
                           ↓
                      Poll for completion
                           ↑
Worker (persistent connection) ← NOTIFY ← PostgreSQL
      ↓
Generate S3 URL
      ↓
UPDATE PostgreSQL with URL
```

**PostgreSQL Implementation:**

```sql
-- 1. Table for URL requests
CREATE TABLE file_upload_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type TEXT,
  entity_id UUID,
  file_name TEXT,
  file_type TEXT,
  status TEXT DEFAULT 'pending',
  presigned_url TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Function to request URL
CREATE OR REPLACE FUNCTION request_upload_url(
  p_entity_type TEXT,
  p_entity_id UUID,
  p_file_name TEXT,
  p_file_type TEXT
) RETURNS UUID AS $$
DECLARE
  v_request_id UUID;
BEGIN
  -- Insert request
  INSERT INTO file_upload_requests (
    entity_type, entity_id, file_name, file_type
  ) VALUES (
    p_entity_type, p_entity_id, p_file_name, p_file_type
  ) RETURNING id INTO v_request_id;

  -- Notify workers
  PERFORM pg_notify(
    'upload_url_request',
    json_build_object(
      'requestId', v_request_id,
      'fileName', p_file_name,
      'fileType', p_file_type,
      'entityType', p_entity_type,
      'entityId', p_entity_id
    )::text
  );

  RETURN v_request_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3. Function to get URL
CREATE OR REPLACE FUNCTION get_upload_url(p_request_id UUID)
RETURNS TABLE(status TEXT, url TEXT, error TEXT) AS $$
  SELECT status, presigned_url, error_message
  FROM file_upload_requests
  WHERE id = p_request_id;
$$ LANGUAGE SQL;
```

**Worker Service Implementation (Node.js):**

```javascript
// worker.js
const { Client } = require('pg');
const AWS = require('aws-sdk');

const s3 = new AWS.S3({
  region: process.env.AWS_REGION || 'us-east-1'
});

async function main() {
  // Create dedicated connection for LISTEN
  const client = new Client({
    connectionString: process.env.DATABASE_URL
  });

  await client.connect();
  console.log('Worker connected to PostgreSQL');

  // Listen for notifications
  await client.query('LISTEN upload_url_request');
  console.log('Listening for upload URL requests...');

  // Handle notifications
  client.on('notification', async (msg) => {
    const payload = JSON.parse(msg.payload);
    const { requestId, fileName, fileType, entityType, entityId } = payload;

    console.log(`Processing request ${requestId}`);

    try {
      // Generate S3 key
      const s3Key = `${entityType}/${entityId}/${Date.now()}-${fileName}`;

      // Generate presigned URL
      const presignedUrl = await s3.getSignedUrlPromise('putObject', {
        Bucket: process.env.S3_BUCKET,
        Key: s3Key,
        ContentType: fileType,
        Expires: 3600
      });

      // Update database
      await client.query(
        `UPDATE file_upload_requests
         SET status = $1, presigned_url = $2
         WHERE id = $3`,
        ['completed', presignedUrl, requestId]
      );

      console.log(`Completed request ${requestId}`);

    } catch (error) {
      console.error(`Error processing request ${requestId}:`, error);

      await client.query(
        `UPDATE file_upload_requests
         SET status = $1, error_message = $2
         WHERE id = $3`,
        ['failed', error.message, requestId]
      );
    }
  });

  // Handle connection errors
  client.on('error', (err) => {
    console.error('PostgreSQL connection error:', err);
    process.exit(1);
  });
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
```

**Docker Compose Setup:**

```yaml
services:
  s3-worker:
    build: ./s3-worker-service
    container_name: s3_worker
    environment:
      - DATABASE_URL=postgres://postgres:${POSTGRES_PASSWORD}@postgres_db:5432/civic_os_db
      - AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID}
      - AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY}
      - AWS_REGION=${AWS_REGION:-us-east-1}
      - S3_BUCKET=${S3_BUCKET}
    networks:
      - postgres_network
    depends_on:
      - postgres
    restart: unless-stopped
```

**Angular Implementation:** Same polling approach as pg_net

**Pros:**
- ✅ PostgreSQL remains hub
- ✅ True async - Non-blocking
- ✅ No HTTP extensions needed
- ✅ Most flexible - Workers can do complex processing
- ✅ Built-in PostgreSQL feature (no extensions)
- ✅ Multiple workers possible for scaling
- ✅ Worker can handle retries, batching, etc.

**Cons:**
- ❌ Worker must maintain persistent DB connection
- ❌ Requires worker to be always running
- ❌ Polling still needed on Angular side
- ❌ More complex to deploy/monitor
- ❌ Need to handle worker crashes/restarts

**Best for:** High-volume applications, complex file processing pipelines

---

## Image Storage & Thumbnail Generation ⭐ CRITICAL FOR CIVIC OS

### Why Thumbnails Matter

For applications with images (like pothole photos in Civic OS), thumbnail generation is **not optional**:

**Without thumbnails:**
- Loading 20 pothole issues = downloading 20× 5MB photos = 100MB
- Page load time: 30+ seconds on 3G
- User experience: Terrible
- Mobile data costs: High

**With thumbnails:**
- Loading 20 pothole issues = downloading 20× 50KB thumbnails = 1MB
- Page load time: <2 seconds
- User experience: Excellent
- Original loaded only when user clicks to view details

### The Challenge

Thumbnails require:
1. **Image processing** (resize, compress, format conversion)
2. **Asynchronous execution** (can't make user wait 2-5 seconds)
3. **Storage of multiple variants** (original + small/medium/large thumbnails)
4. **Conditional serving** (thumbnail for lists, original for detail view)
5. **Heavy CPU usage** (image processing is computationally expensive)

**This fundamentally changes the architecture requirements.**

---

### How Each Approach Handles Thumbnails

#### ❌ PostgreSQL BYTEA - NOT VIABLE FOR IMAGES

**Problems:**
- Image processing in PostgreSQL requires ImageMagick extension (complex setup)
- Storing multiple variants (original + 3 thumbnail sizes) multiplies database bloat by 4×
- Where does processing happen?
  - **In PostgreSQL**: Crushes database CPU, blocks connections
  - **In Angular after download**: Defeats the purpose (must download full image first)
  - **External service**: Need external service anyway, so why use BYTEA?

**Storage Example:**
- 1000 pothole photos @ 5MB each = 5GB originals
- + 3 thumbnail sizes = 20GB total in PostgreSQL
- RDS storage cost: $2,300/year vs $460/year for S3

**Verdict**: BYTEA was already marginal for images; thumbnails make it impractical. ❌ **Not recommended.**

---

#### ❌ pgsql-http + Micro-service - POOR FIT

**Problem: Synchronous HTTP blocks database connection**

**Option A: Generate thumbnail synchronously**
```javascript
app.post('/sign-upload', async (req, res) => {
  const uploadUrl = await s3.getSignedUrl(...);
  res.json({ url: uploadUrl });

  // User uploads directly to S3
  // Micro-service never sees the image!
});
```
- User uploads directly to S3, bypassing micro-service
- Can't process image we never receive

**Option B: User uploads to micro-service, then to S3**
```javascript
app.post('/upload', async (req, res) => {
  const image = req.file; // Receive upload

  // Generate thumbnail (takes 2-5 seconds)
  const thumbnail = await sharp(image.buffer).resize(200, 200).toBuffer();

  // Upload both to S3
  await s3.putObject({ Key: 'original/...', Body: image });
  await s3.putObject({ Key: 'thumbnail/...', Body: thumbnail });

  // PostgreSQL connection held open for 5+ seconds!
  res.json({ success: true });
});
```
- Blocks PostgreSQL connection for 5+ seconds
- 10 concurrent uploads = 10 blocked connections
- Connection pool exhausted quickly

**Verdict**: Synchronous nature conflicts with async thumbnail needs. ❌ **Not recommended for images.**

---

#### ⚠️ pg_net + Micro-service - REQUIRES LAMBDA

**The Problem: User uploads directly to S3, bypassing micro-service**

```
Angular → PostgREST → pg_net → Micro-service (signs URL)
                                      ↓
User uploads ──────────────────→ S3 directly
                                      ↓
                              Micro-service never sees image!
```

**Solution: S3 Event Trigger → Lambda**

```
User uploads → S3 → S3 Event Notification → Lambda → Generate thumbnails
                ↓
           Update PostgreSQL via HTTP
```

**Lambda Implementation:**

```javascript
// lambda-thumbnail-generator.js
const AWS = require('aws-sdk');
const sharp = require('sharp');
const axios = require('axios');

const s3 = new AWS.S3();

const SIZES = {
  small: { width: 150, height: 150 },
  medium: { width: 400, height: 400 },
  large: { width: 800, height: 800 }
};

exports.handler = async (event) => {
  const bucket = event.Records[0].s3.bucket.name;
  const key = event.Records[0].s3.object.key;

  // Only process originals, not thumbnails
  if (key.includes('/thumbnails/')) return;

  console.log(`Processing ${key}`);

  try {
    // Download original
    const original = await s3.getObject({ Bucket: bucket, Key: key }).promise();

    // Generate all thumbnail sizes in parallel
    const thumbnailPromises = Object.entries(SIZES).map(async ([size, dimensions]) => {
      const thumbnail = await sharp(original.Body)
        .resize(dimensions.width, dimensions.height, { fit: 'cover' })
        .jpeg({ quality: 80 })
        .toBuffer();

      const thumbnailKey = key.replace('/originals/', `/thumbnails/${size}/`);

      await s3.putObject({
        Bucket: bucket,
        Key: thumbnailKey,
        Body: thumbnail,
        ContentType: 'image/jpeg'
      }).promise();

      return { size, key: thumbnailKey };
    });

    const thumbnails = await Promise.all(thumbnailPromises);

    // Update PostgreSQL via PostgREST
    await axios.patch(`${process.env.POSTGREST_URL}/files?original_key=eq.${key}`, {
      thumbnail_small_key: thumbnails.find(t => t.size === 'small').key,
      thumbnail_medium_key: thumbnails.find(t => t.size === 'medium').key,
      thumbnail_large_key: thumbnails.find(t => t.size === 'large').key,
      thumbnail_status: 'completed'
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      }
    });

    console.log(`Successfully processed ${key}`);

  } catch (error) {
    console.error(`Error processing ${key}:`, error);

    // Mark as failed
    await axios.patch(`${process.env.POSTGREST_URL}/files?original_key=eq.${key}`, {
      thumbnail_status: 'failed'
    });
  }
};
```

**S3 Event Configuration:**

```json
{
  "LambdaFunctionConfigurations": [{
    "LambdaFunctionArn": "arn:aws:lambda:us-east-1:123456789012:function:thumbnail-generator",
    "Events": ["s3:ObjectCreated:*"],
    "Filter": {
      "Key": {
        "FilterRules": [{
          "Name": "prefix",
          "Value": "originals/"
        }]
      }
    }
  }]
}
```

**Pros:**
- ✅ Non-blocking (user doesn't wait)
- ✅ Industry standard pattern
- ✅ Lambda auto-scales for image spikes
- ✅ Can use Lambda layers with pre-built Sharp

**Cons:**
- ❌ **Breaks architectural purity** (requires Lambda)
- ❌ Lambda cold starts (1-2 second delay for first image)
- ❌ Lambda needs network access to PostgREST
- ❌ Service role credentials required for PostgREST updates
- ❌ Another AWS service to manage

**Verdict**: Works well, but requires Lambda. ⚠️ **Use if already committed to AWS Lambda.**

---

#### ⭐⭐⭐ LISTEN/NOTIFY + Worker - PERFECT FIT

**Architecture: PostgreSQL notifies worker, worker processes asynchronously**

```
┌──────────┐
│  Angular │ Uploads via presigned URL
└────┬─────┘
     │ POST /files (s3_url)
     ↓
┌────────────┐
│ PostgREST  │
└────┬───────┘
     │ INSERT INTO files + NOTIFY
     ↓
┌─────────────────────┐       NOTIFY        ┌──────────────────┐
│    PostgreSQL       │───────────────────→ │  Image Worker    │
│                     │                      │  (Node.js)       │
│  files table        │                      │                  │
│  - s3_original_key  │                      │  1. Downloads    │
│  - s3_thumb_sm_key  │       UPDATE        │  2. Sharp resize │
│  - s3_thumb_md_key  │←─────────────────── │  3. S3 upload    │
│  - s3_thumb_lg_key  │                      │  4. Update DB    │
│  - thumbnail_status │                      │                  │
└─────────────────────┘                      └────────┬─────────┘
     ↑                                                │
     │ Angular polls for thumbnail_status            ↓
     │ or uses WebSocket for real-time           ┌──────────┐
     └───────────────────────────────────────────│  S3      │
                                                 │/originals│
                                                 │/thumbs   │
                                                 └──────────┘
```

**PostgreSQL Schema:**

```sql
CREATE TABLE files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  file_name TEXT NOT NULL,
  file_type TEXT NOT NULL,
  file_size INTEGER,

  -- S3 keys
  s3_original_key TEXT NOT NULL,
  s3_thumbnail_small_key TEXT,
  s3_thumbnail_medium_key TEXT,
  s3_thumbnail_large_key TEXT,

  -- CDN URLs (optional, for convenience)
  original_url TEXT GENERATED ALWAYS AS
    ('https://cdn.civic-os.org/' || s3_original_key) STORED,
  thumbnail_small_url TEXT GENERATED ALWAYS AS
    ('https://cdn.civic-os.org/' || s3_thumbnail_small_key) STORED,
  thumbnail_medium_url TEXT GENERATED ALWAYS AS
    ('https://cdn.civic-os.org/' || s3_thumbnail_medium_key) STORED,
  thumbnail_large_url TEXT GENERATED ALWAYS AS
    ('https://cdn.civic-os.org/' || s3_thumbnail_large_key) STORED,

  -- Processing status
  thumbnail_status TEXT DEFAULT 'pending' CHECK (
    thumbnail_status IN ('pending', 'processing', 'completed', 'failed')
  ),
  thumbnail_error TEXT,

  -- Image metadata (populated by worker)
  width INTEGER,
  height INTEGER,
  exif_data JSONB,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  -- Soft delete
  deleted_at TIMESTAMPTZ
);

-- Index for entity lookups
CREATE INDEX idx_files_entity ON files(entity_type, entity_id) WHERE deleted_at IS NULL;

-- Index for processing queue
CREATE INDEX idx_files_pending ON files(thumbnail_status, created_at)
WHERE thumbnail_status IN ('pending', 'failed');

-- RLS policies
ALTER TABLE files ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view files for entities they can access"
ON files FOR SELECT
USING (
  CASE entity_type
    WHEN 'Issue' THEN EXISTS (
      SELECT 1 FROM "Issue" WHERE id = files.entity_id
    )
    -- Add other entity types
    ELSE false
  END
);

CREATE POLICY "Authenticated users can upload files"
ON files FOR INSERT
WITH CHECK (auth.role() = 'authenticated');

-- Trigger to notify worker
CREATE OR REPLACE FUNCTION notify_file_uploaded()
RETURNS TRIGGER AS $$
BEGIN
  -- Only notify for pending thumbnails
  IF NEW.thumbnail_status = 'pending' THEN
    PERFORM pg_notify(
      'file_uploaded',
      json_build_object(
        'file_id', NEW.id,
        's3_key', NEW.s3_original_key,
        'file_type', NEW.file_type
      )::text
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER file_uploaded_trigger
AFTER INSERT ON files
FOR EACH ROW
EXECUTE FUNCTION notify_file_uploaded();
```

**Worker Implementation:**

```javascript
// worker/thumbnail-worker.js
const { Client } = require('pg');
const AWS = require('aws-sdk');
const sharp = require('sharp');
const ExifParser = require('exif-parser');

const s3 = new AWS.S3({
  region: process.env.AWS_REGION || 'us-east-1'
});

const THUMBNAIL_SIZES = {
  small: { width: 150, height: 150, quality: 75 },
  medium: { width: 400, height: 400, quality: 80 },
  large: { width: 800, height: 800, quality: 85 }
};

class ThumbnailWorker {
  constructor() {
    this.client = new Client({
      connectionString: process.env.DATABASE_URL
    });
  }

  async start() {
    await this.client.connect();
    console.log('✅ Connected to PostgreSQL');

    // Listen for file uploads
    await this.client.query('LISTEN file_uploaded');
    console.log('👂 Listening for file uploads...');

    // Handle notifications
    this.client.on('notification', async (msg) => {
      try {
        const payload = JSON.parse(msg.payload);
        await this.processFile(payload);
      } catch (error) {
        console.error('❌ Error processing notification:', error);
      }
    });

    // Handle connection errors
    this.client.on('error', (err) => {
      console.error('❌ PostgreSQL connection error:', err);
      process.exit(1);
    });

    // Process any existing pending files (recovery from downtime)
    await this.processBacklog();
  }

  async processBacklog() {
    const { rows } = await this.client.query(`
      SELECT id, s3_original_key, file_type
      FROM files
      WHERE thumbnail_status = 'pending'
         OR (thumbnail_status = 'failed' AND updated_at < NOW() - INTERVAL '1 hour')
      ORDER BY created_at ASC
      LIMIT 100
    `);

    if (rows.length > 0) {
      console.log(`📦 Processing ${rows.length} files from backlog`);
      for (const row of rows) {
        await this.processFile({
          file_id: row.id,
          s3_key: row.s3_original_key,
          file_type: row.file_type
        });
      }
    }
  }

  async processFile({ file_id, s3_key, file_type }) {
    console.log(`🔄 Processing file ${file_id}`);

    // Update status to processing
    await this.client.query(
      'UPDATE files SET thumbnail_status = $1, updated_at = NOW() WHERE id = $2',
      ['processing', file_id]
    );

    try {
      // Download original from S3
      const original = await s3.getObject({
        Bucket: process.env.S3_BUCKET,
        Key: s3_key
      }).promise();

      // Extract EXIF data
      const exifData = this.extractExif(original.Body);

      // Get image dimensions
      const metadata = await sharp(original.Body).metadata();

      // Generate all thumbnails in parallel
      const thumbnailPromises = Object.entries(THUMBNAIL_SIZES).map(
        async ([size, config]) => {
          const thumbnail = await sharp(original.Body)
            .resize(config.width, config.height, {
              fit: 'cover',
              position: 'attention' // Smart crop focusing on interesting areas
            })
            .jpeg({ quality: config.quality, progressive: true })
            .toBuffer();

          // Generate S3 key for thumbnail
          const thumbnailKey = s3_key.replace(
            '/originals/',
            `/thumbnails/${size}/`
          );

          // Upload to S3
          await s3.putObject({
            Bucket: process.env.S3_BUCKET,
            Key: thumbnailKey,
            Body: thumbnail,
            ContentType: 'image/jpeg',
            CacheControl: 'public, max-age=31536000', // 1 year
            Metadata: {
              'original-key': s3_key,
              'thumbnail-size': size
            }
          }).promise();

          return { size, key: thumbnailKey };
        }
      );

      const thumbnails = await Promise.all(thumbnailPromises);

      // Update database with thumbnail URLs and metadata
      await this.client.query(`
        UPDATE files
        SET thumbnail_status = $1,
            s3_thumbnail_small_key = $2,
            s3_thumbnail_medium_key = $3,
            s3_thumbnail_large_key = $4,
            width = $5,
            height = $6,
            exif_data = $7,
            updated_at = NOW()
        WHERE id = $8
      `, [
        'completed',
        thumbnails.find(t => t.size === 'small').key,
        thumbnails.find(t => t.size === 'medium').key,
        thumbnails.find(t => t.size === 'large').key,
        metadata.width,
        metadata.height,
        JSON.stringify(exifData),
        file_id
      ]);

      console.log(`✅ Successfully processed file ${file_id}`);

    } catch (error) {
      console.error(`❌ Error processing file ${file_id}:`, error);

      // Update with error
      await this.client.query(
        `UPDATE files
         SET thumbnail_status = $1,
             thumbnail_error = $2,
             updated_at = NOW()
         WHERE id = $3`,
        ['failed', error.message, file_id]
      );
    }
  }

  extractExif(buffer) {
    try {
      const parser = ExifParser.create(buffer);
      const result = parser.parse();

      return {
        latitude: result.tags.GPSLatitude,
        longitude: result.tags.GPSLongitude,
        timestamp: result.tags.DateTimeOriginal,
        camera: result.tags.Model,
        orientation: result.tags.Orientation
      };
    } catch (error) {
      return null;
    }
  }
}

// Start worker
const worker = new ThumbnailWorker();
worker.start().catch(err => {
  console.error('Failed to start worker:', err);
  process.exit(1);
});
```

**package.json for Worker:**

```json
{
  "name": "thumbnail-worker",
  "version": "1.0.0",
  "dependencies": {
    "pg": "^8.11.0",
    "sharp": "^0.33.0",
    "aws-sdk": "^2.1400.0",
    "exif-parser": "^0.1.12"
  }
}
```

**Dockerfile for Worker:**

```dockerfile
FROM node:20-alpine

# Install dependencies for Sharp
RUN apk add --no-cache \
    libc6-compat \
    vips-dev \
    build-base \
    python3

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY thumbnail-worker.js ./

CMD ["node", "thumbnail-worker.js"]
```

**Docker Compose:**

```yaml
services:
  thumbnail-worker:
    build: ./thumbnail-worker
    container_name: thumbnail_worker
    environment:
      - DATABASE_URL=postgres://postgres:${POSTGRES_PASSWORD}@postgres_db:5432/civic_os_db
      - AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID}
      - AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY}
      - AWS_REGION=${AWS_REGION:-us-east-1}
      - S3_BUCKET=${S3_BUCKET}
    networks:
      - postgres_network
    depends_on:
      - postgres
    restart: unless-stopped
    # For high-volume scenarios, scale horizontally
    # deploy:
    #   replicas: 3
```

**Angular Implementation with Progressive Enhancement:**

```typescript
// file-upload.service.ts
import { Injectable, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { interval, switchMap, takeWhile, tap } from 'rxjs';

export interface FileUpload {
  id: string;
  entity_type: string;
  entity_id: string;
  file_name: string;
  thumbnail_status: 'pending' | 'processing' | 'completed' | 'failed';
  thumbnail_small_url?: string;
  thumbnail_medium_url?: string;
  thumbnail_large_url?: string;
  original_url: string;
}

@Injectable({ providedIn: 'root' })
export class FileUploadService {
  constructor(private http: HttpClient) {}

  /**
   * Upload file and poll for thumbnail generation
   */
  async uploadWithThumbnails(
    file: File,
    entityType: string,
    entityId: string
  ): Promise<FileUpload> {
    // Step 1: Get presigned URL
    const { url, s3_key } = await this.getPresignedUrl(file.name, file.type);

    // Step 2: Upload to S3
    await this.uploadToS3(url, file);

    // Step 3: Create file record in PostgreSQL
    const fileRecord = await this.createFileRecord({
      entity_type: entityType,
      entity_id: entityId,
      file_name: file.name,
      file_type: file.type,
      file_size: file.size,
      s3_original_key: s3_key
    });

    // Step 4: Poll for thumbnail completion (optional, for immediate feedback)
    await this.waitForThumbnails(fileRecord.id);

    return fileRecord;
  }

  private async waitForThumbnails(fileId: string): Promise<void> {
    return new Promise((resolve) => {
      interval(1000).pipe(
        switchMap(() => this.http.get<FileUpload>(`/api/files/${fileId}`)),
        takeWhile(file =>
          file.thumbnail_status === 'pending' ||
          file.thumbnail_status === 'processing',
          true // Include final emission
        ),
        tap(file => {
          if (file.thumbnail_status === 'completed' ||
              file.thumbnail_status === 'failed') {
            resolve();
          }
        })
      ).subscribe();
    });
  }
}
```

**Component with Progressive Loading:**

```typescript
@Component({
  selector: 'app-image-grid',
  template: `
    <div class="grid grid-cols-4 gap-4">
      @for (file of files(); track file.id) {
        <div class="card">
          @switch (file.thumbnail_status) {
            @case ('completed') {
              <img
                [src]="file.thumbnail_medium_url"
                [alt]="file.file_name"
                class="w-full h-48 object-cover cursor-pointer"
                (click)="viewOriginal(file)"
              />
            }
            @case ('processing') {
              <div class="skeleton h-48 w-full"></div>
              <span class="text-xs">Processing...</span>
            }
            @case ('pending') {
              <div class="skeleton h-48 w-full"></div>
              <span class="text-xs">Queued</span>
            }
            @case ('failed') {
              <div class="bg-error/10 h-48 flex items-center justify-center">
                <span class="text-error">Failed to process</span>
              </div>
            }
          }
          <div class="card-body">
            <h3 class="card-title text-sm">{{ file.file_name }}</h3>
          </div>
        </div>
      }
    </div>
  `
})
export class ImageGridComponent {
  files = signal<FileUpload[]>([]);

  // Real-time updates via polling or WebSocket
  ngOnInit() {
    this.loadFiles();

    // Poll for thumbnail updates every 5 seconds
    interval(5000).pipe(
      switchMap(() => this.fileService.getFiles(this.entityType, this.entityId))
    ).subscribe(files => this.files.set(files));
  }
}
```

**Pros:**
- ✅ **Perfect architectural fit**: Angular → PostgREST only, worker is "invisible"
- ✅ **Asynchronous**: User doesn't wait for thumbnails
- ✅ **Progressive enhancement**: Show placeholders while processing
- ✅ **Multiple variants**: Generate any number of sizes
- ✅ **Extensible**: Worker can do EXIF extraction, watermarks, format conversion
- ✅ **Scalable**: Deploy multiple workers for high volume
- ✅ **No Lambda**: All containerized with Docker
- ✅ **Automatic recovery**: Processes backlog on restart
- ✅ **Cost-effective**: No Lambda invocations, Sharp is fast

**Cons:**
- ❌ More complex deployment (worker service + dependencies)
- ❌ Worker needs monitoring (health checks, restart policies)
- ❌ Sharp requires native dependencies (larger Docker image)

**Verdict**: LISTEN/NOTIFY + Worker is the **BEST** approach for Civic OS with images. ⭐⭐⭐

---

## Comparison Table

| Aspect | pg_net (A) | pgsql-http (B) | LISTEN/NOTIFY (C) |
|--------|-----------|---------------|-------------------|
| **PostgreSQL Hub** | ✅ Yes | ✅ Yes | ✅ Yes |
| **Complexity** | Medium | Low | High |
| **Performance** | Non-blocking | Blocking | Non-blocking |
| **Angular Changes** | Polling (~1s) | Simple call | Polling (~1s) |
| **Service Type** | Stateless HTTP | Stateless HTTP | Stateful worker |
| **Extension Required** | pg_net | http | None |
| **Trigger-Safe** | ✅ Yes | ❌ No | ✅ Yes |
| **Scalability** | High | Low | High |
| **Deployment** | Docker service | Docker service | Docker service |
| **Connection Usage** | Normal | Blocks during call | Dedicated connection |
| **Image Thumbnails** | ⚠️ Requires Lambda | ❌ Not viable | ✅ Perfect fit |
| **Best For** | Documents only | Prototyping | **Images + production** |

---

## Final Recommendation

### **For Civic OS with Images: Use LISTEN/NOTIFY + Worker (Approach C)** ⭐⭐⭐

**The game-changer:** Civic OS's pothole tracking system will inevitably include **images** (photos of potholes). This makes thumbnail generation a **requirement, not a nice-to-have**.

Once you need thumbnails, **LISTEN/NOTIFY + Worker** becomes the clear winner.

**Why:**

1. **Architectural Purity**: Maintains PostgreSQL/PostgREST as the exclusive hub. Angular never calls external services directly. Worker operates "behind" PostgreSQL.

2. **Perfect for Images**:
   - Generates multiple thumbnail sizes (small for lists, medium for grids, large for previews)
   - Extracts EXIF data (GPS coordinates from photos! 📍)
   - Handles format conversion (HEIC → JPEG)
   - No Lambda cold starts (sub-second processing)

3. **Extensibility**: Worker can grow to handle:
   - AI-powered pothole severity classification
   - Automatic geolocation extraction
   - Image quality analysis
   - Duplicate detection

4. **Cost-Effective**:
   - No Lambda invocations ($0.20 per million vs free)
   - Sharp processes images faster than Lambda
   - One worker handles 100s of images/hour

5. **Operational Simplicity**:
   - Everything in Docker Compose
   - Worker auto-recovers backlog on restart
   - Scales horizontally (just add replicas)

**Implementation Path:**

1. **Phase 1: Basic File Upload** (Start here)
   - Implement LISTEN/NOTIFY for presigned URL generation
   - Store file metadata in PostgreSQL `files` table
   - Test with simple documents (no thumbnails yet)

2. **Phase 2: Add Image Worker** (When images needed)
   - Create thumbnail worker with Sharp
   - Start with one thumbnail size
   - Add progressive UI (show skeleton → thumbnail)

3. **Phase 3: Production Ready**
   - Multiple thumbnail sizes (small/medium/large)
   - EXIF extraction (GPS, timestamp, camera)
   - Error handling & retry logic
   - Monitoring (Prometheus + Grafana)

4. **Phase 4: Advanced Features** (Optional)
   - Watermarking for public images
   - AI classification (pothole severity)
   - Image optimization (AVIF/WebP)
   - Duplicate detection

---

### Alternative Recommendations

**If you DON'T need images (documents only):**
- Use **Approach A (pg_net + micro-service)** for simplicity
- Simpler than worker, no thumbnail complexity

**If you CAN'T install PostgreSQL extensions:**
- Use **AWS Lambda (Option 3)** directly from Angular
- Industry standard, but breaks architectural purity

**If prototyping quickly:**
- Start with **PostgreSQL BYTEA (Option 1)** for <1MB files
- Migrate to S3 later when volume grows

---

### Why NOT the Other Approaches?

**pg_net + Micro-service:**
- ⚠️ Can generate presigned URLs
- ❌ But needs Lambda for thumbnails (defeats architectural purpose)
- 📊 Use case: Documents only, no images

**pgsql-http + Micro-service:**
- ❌ Synchronous blocking incompatible with thumbnail generation
- ❌ Connection pool exhaustion under load
- 📊 Use case: Quick prototypes only

**PostgreSQL BYTEA:**
- ❌ 4× storage bloat with thumbnails
- ❌ Database CPU crushed by image processing
- ❌ Expensive ($2,300/yr vs $460/yr for S3)
- 📊 Use case: Never use for images

---

## Decision Tree

Use this flowchart to choose the right approach:

```
START: Do you need file storage?
  │
  ├─ No → You're done!
  │
  └─ Yes → Will you store IMAGES (not just documents)?
      │
      ├─ YES (images, photos) 📸
      │   │
      │   └─ Thumbnails required? (almost always yes)
      │       │
      │       ├─ YES → LISTEN/NOTIFY + Worker ⭐ RECOMMENDED
      │       │        (Perfect fit for Civic OS pothole photos)
      │       │
      │       └─ NO → Continue below
      │
      └─ NO (documents, PDFs only) 📄
          │
          └─ What's your average file size?
              │
              ├─ < 1MB AND < 1000 files
              │   └─ PostgreSQL BYTEA (simplest)
              │
              └─ > 1MB OR > 1000 files
                  └─ Can you install PostgreSQL extensions?
                      │
                      ├─ NO → AWS Lambda (Option 3)
                      │
                      └─ YES → What's your hosting setup?
                          │
                          ├─ Self-hosted/Docker
                          │   └─ pg_net (Approach A)
                          │
                          └─ Managed (RDS, Supabase)
                              └─ pg_net available?
                                  ├─ Yes → pg_net (Approach A)
                                  └─ No → AWS Lambda (Option 3)
```

**Quick Decision Matrix:**

| Your Situation | Recommended Approach | Why |
|---------------|---------------------|-----|
| **Images + Thumbnails** ⭐ | **LISTEN/NOTIFY + Worker** | Only option that handles thumbnails well |
| Pothole tracking (Civic OS) | LISTEN/NOTIFY + Worker | Photos require thumbnails |
| Documents only, production | pg_net + micro-service | Simpler than worker |
| Prototyping/MVP | PostgreSQL BYTEA | Fastest to implement |
| Self-hosted, < 10 users, <1MB files | PostgreSQL BYTEA | Simplest infrastructure |
| Can't install extensions | AWS Lambda | Standard serverless pattern |
| Files > 100MB | AWS Lambda or LISTEN/NOTIFY | Database not ideal for huge files |
| Need AI/ML processing | LISTEN/NOTIFY + Worker | Maximum flexibility |

---

## Cost Analysis

### Storage Costs (Monthly, approximate)

| Approach | 100GB Storage | 1TB Storage | Notes |
|----------|--------------|------------|-------|
| **PostgreSQL (RDS)** | ~$11.50 | ~$115 | RDS storage: $0.115/GB-month |
| **PostgreSQL (self-hosted)** | ~$5 | ~$50 | NVMe SSD pricing |
| **AWS S3 Standard** | ~$2.30 | ~$23 | $0.023/GB-month |
| **S3 Infrequent Access** | ~$1.25 | ~$12.50 | $0.0125/GB-month |
| **S3 Glacier** | ~$0.40 | ~$4 | $0.004/GB-month |
| **Cloudflare R2** | ~$1.50 | ~$15 | $0.015/GB-month |
| **Backblaze B2** | ~$0.60 | ~$6 | $0.006/GB-month |

### Transfer Costs (Egress)

| Service | First 100GB/month | Over 100GB | Notes |
|---------|------------------|-----------|-------|
| **AWS S3** | $0 (with CloudFront) | $0.085/GB | Can get expensive |
| **Cloudflare R2** | **$0** | **$0** | No egress fees! |
| **Backblaze B2** | Free (3x storage) | $0.01/GB | Generous free tier |
| **PostgreSQL** | N/A | N/A | Pay for compute/bandwidth |

### Total Cost Example (1TB storage, 500GB monthly downloads)

- **S3 + CloudFront**: ~$23 + $42.50 = **$65.50/month**
- **Cloudflare R2**: ~$15 + $0 = **$15/month** ⭐ Best value
- **Backblaze B2**: ~$6 + $5 = **$11/month** ⭐ Cheapest
- **PostgreSQL BYTEA**: ~$115 + compute = **$150+/month**

**Recommendation**: For production with significant traffic, use **Cloudflare R2** or **Backblaze B2** instead of S3 to avoid egress fees. Both are S3-compatible, so the code is nearly identical.

---

## Performance Guidelines

### File Size Limits

| Approach | Recommended Max | Hard Limit | Notes |
|----------|----------------|-----------|-------|
| PostgreSQL BYTEA | 5MB | 1GB | Performance degrades after 10MB |
| pg_net + S3 | 5GB | 5TB | S3 multipart for > 100MB |
| pgsql-http + S3 | 100MB | 5GB | Connection timeout risk |
| Lambda + S3 | 5GB | 5TB | Use multipart for large files |
| Direct S3 Upload | 5TB | 5TB | Native S3 limit |

### Expected Latency

| Operation | BYTEA | pg_net | pgsql-http | Lambda |
|-----------|-------|--------|-----------|--------|
| Get Upload URL | ~50ms | ~500-1000ms (polling) | ~200ms | ~100ms |
| Upload 1MB | ~100ms | ~500ms (to S3) | ~500ms | ~500ms |
| Upload 100MB | ~10s | ~10s (to S3) | ~10s | ~10s |
| Download 1MB | ~100ms | ~500ms | ~500ms | ~200ms |

### Image Processing Performance

**Thumbnail Generation Times (using Sharp):**

| Image Size | Small (150px) | Medium (400px) | Large (800px) | All 3 |
|-----------|--------------|---------------|--------------|-------|
| 2MP (1920×1080) | ~100ms | ~150ms | ~200ms | ~450ms |
| 5MP (2592×1944) | ~150ms | ~250ms | ~350ms | ~750ms |
| 12MP (4000×3000) | ~300ms | ~500ms | ~800ms | ~1.6s |
| 20MP+ (5472×3648) | ~500ms | ~1s | ~1.5s | ~3s |

**Worker Throughput (1 worker instance):**

| Scenario | Images/minute | Notes |
|----------|--------------|-------|
| Small images (2MP) | 60-80 | Modern smartphone photos |
| Medium images (5MP) | 40-50 | DSLR low quality |
| Large images (12MP+) | 20-30 | High-res photos |
| Mixed workload | ~40 | Real-world average |

**Scaling:**
- 3 workers = 120 images/minute = 7,200/hour
- 10 workers = 400 images/minute = 24,000/hour
- Typical pothole report = 2-3 photos = 800 reports/hour per 3 workers

**Lambda vs Worker Comparison:**

| Aspect | AWS Lambda | LISTEN/NOTIFY Worker |
|--------|-----------|---------------------|
| Cold start | 1-2s first image | 0s (always warm) |
| Processing | ~500ms | ~450ms |
| Throughput | Unlimited (auto-scale) | 40 images/min/worker |
| Cost (10k images) | $2.00 | $0.00 (included in compute) |
| Latency P99 | ~2s | ~500ms |

### Concurrent Users

| Approach | 10 Users | 100 Users | 1000 Users | Bottleneck |
|----------|----------|-----------|------------|------------|
| PostgreSQL BYTEA | ✅ Fine | ⚠️ Slow | ❌ Overloaded | Database I/O |
| pg_net + S3 | ✅ Fine | ✅ Fine | ✅ Fine | Micro-service (scale horizontally) |
| pgsql-http + S3 | ✅ Fine | ⚠️ Slow | ❌ Blocked | Database connections |
| Lambda + S3 | ✅ Fine | ✅ Fine | ✅ Fine | AWS auto-scales |

---

## Local Development Setup

### Option 1: MinIO (S3-Compatible Local Server)

**Why MinIO?** Free, S3-compatible, runs locally, perfect for development.

```yaml
# Add to examples/pothole/docker-compose.yml
services:
  minio:
    image: minio/minio:latest
    container_name: minio_local
    ports:
      - "9000:9000"  # API
      - "9001:9001"  # Console
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
    command: server /data --console-address ":9001"
    volumes:
      - minio_data:/data
    networks:
      - postgres_network

volumes:
  minio_data:
```

**Configure Your Service:**
```javascript
// sign-service.js
const s3 = new AWS.S3({
  endpoint: process.env.S3_ENDPOINT || 'http://minio:9000',
  accessKeyId: process.env.AWS_ACCESS_KEY_ID || 'minioadmin',
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || 'minioadmin',
  s3ForcePathStyle: true, // Required for MinIO
  signatureVersion: 'v4'
});
```

**Create Bucket:**
```bash
# Access MinIO Console: http://localhost:9001
# Login: minioadmin / minioadmin
# Create bucket: civic-os-files
```

### Option 2: LocalStack (Full AWS Emulator)

```yaml
services:
  localstack:
    image: localstack/localstack:latest
    ports:
      - "4566:4566"
    environment:
      - SERVICES=s3
      - DEBUG=1
    volumes:
      - localstack_data:/var/lib/localstack
```

**Note**: MinIO is simpler and faster for just S3 testing.

---

## Testing Strategies

### Unit Testing the Micro-service

```javascript
// sign-service.test.js
const request = require('supertest');
const app = require('./sign-service');

jest.mock('aws-sdk', () => {
  const mockGetSignedUrlPromise = jest.fn().mockResolvedValue('https://fake-url.com');
  return {
    S3: jest.fn(() => ({
      getSignedUrlPromise: mockGetSignedUrlPromise
    }))
  };
});

describe('POST /sign-upload', () => {
  it('should return presigned URL', async () => {
    const response = await request(app)
      .post('/sign-upload')
      .send({
        requestId: '123',
        fileName: 'test.jpg',
        fileType: 'image/jpeg'
      });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
  });
});
```

### Integration Testing with PostgreSQL

```sql
-- Test requesting URL
SELECT request_upload_url('Issue', gen_random_uuid(), 'test.pdf', 'application/pdf');

-- Check status
SELECT * FROM file_upload_requests ORDER BY created_at DESC LIMIT 1;

-- Verify RLS policies
SET ROLE authenticated;
SELECT * FROM file_upload_requests; -- Should only see own requests
```

### Angular Service Testing

```typescript
describe('FileUploadService', () => {
  let httpMock: HttpTestingController;

  it('should poll until URL is ready', fakeAsync(() => {
    service.uploadFile(mockFile, 'Issue', 'uuid').subscribe();

    // First call: status=pending
    httpMock.expectOne('/rpc/get_upload_url').flush({ status: 'pending' });
    tick(500);

    // Second call: status=completed
    httpMock.expectOne('/rpc/get_upload_url').flush({
      status: 'completed',
      url: 'https://...'
    });
  }));
});
```

---

## Operational Concerns

### Monitoring

**Key Metrics to Track:**

1. **PostgreSQL Approach:**
   - Database size growth rate
   - Query performance (SELECT with BYTEA)
   - Connection pool utilization
   - Backup duration

2. **pg_net/pgsql-http Approach:**
   - Request success/failure rate
   - Average time to URL generation
   - Micro-service health
   - S3 upload success rate

3. **All Approaches:**
   - File upload failures
   - Orphaned files (requested but never uploaded)
   - Storage usage vs limits
   - Cost per month

**Recommended Tools:**
- PostgreSQL: pgAdmin, pg_stat_statements
- Micro-service: Prometheus + Grafana
- S3: AWS CloudWatch, S3 Inventory

### Logging Best Practices

```javascript
// Structured logging in micro-service
const logger = require('pino')();

app.post('/sign-upload', async (req, res) => {
  const { requestId, fileName } = req.body;

  logger.info({
    action: 'sign_upload_start',
    requestId,
    fileName,
    timestamp: new Date().toISOString()
  });

  try {
    // ... generate URL
    logger.info({
      action: 'sign_upload_success',
      requestId,
      duration: Date.now() - startTime
    });
  } catch (error) {
    logger.error({
      action: 'sign_upload_error',
      requestId,
      error: error.message,
      stack: error.stack
    });
  }
});
```

### Cleanup Strategy

**Problem**: Users request URLs but never upload, or uploads fail midway.

**Solution**: Scheduled cleanup job

```sql
-- PostgreSQL function to clean old requests
CREATE OR REPLACE FUNCTION cleanup_old_upload_requests()
RETURNS void AS $$
BEGIN
  -- Delete pending/processing requests older than 24 hours
  DELETE FROM file_upload_requests
  WHERE status IN ('pending', 'processing')
    AND created_at < NOW() - INTERVAL '24 hours';

  -- Archive completed requests older than 7 days
  INSERT INTO file_upload_requests_archive
  SELECT * FROM file_upload_requests
  WHERE status = 'completed'
    AND created_at < NOW() - INTERVAL '7 days';

  DELETE FROM file_upload_requests
  WHERE status = 'completed'
    AND created_at < NOW() - INTERVAL '7 days';
END;
$$ LANGUAGE plpgsql;

-- Schedule with pg_cron (if available) or external cron
SELECT cron.schedule('cleanup-uploads', '0 2 * * *', 'SELECT cleanup_old_upload_requests()');
```

**S3 Lifecycle Policies:**
```json
{
  "Rules": [{
    "Id": "Delete incomplete multipart uploads",
    "Status": "Enabled",
    "AbortIncompleteMultipartUpload": {
      "DaysAfterInitiation": 1
    }
  }]
}
```

### Backup Considerations

| Approach | Backup Impact | Restore Complexity | Notes |
|----------|--------------|-------------------|--------|
| PostgreSQL BYTEA | ⚠️ **Large backups** | Simple | Files included in pg_dump |
| S3-based | ✅ Small DB backups | Medium | Must backup DB + S3 separately |

**BYTEA Backup Strategy:**
```bash
# Exclude large BYTEA columns from regular backups
pg_dump --exclude-table-data=blobs civic_os_db > backup.sql

# Backup blobs separately (less frequently)
pg_dump --table=blobs civic_os_db > blobs_backup.sql
```

### Disaster Recovery

**S3-based approaches:**
1. Enable S3 versioning (recover from accidental deletes)
2. Configure S3 Cross-Region Replication
3. Backup PostgreSQL metadata separately

**PostgreSQL BYTEA:**
1. Point-in-time recovery with WAL archiving
2. Test restore procedures regularly
3. Consider separate tablespace for BYTEA data

---

## Common Pitfalls & Gotchas

### 1. Presigned URL Expiry During Upload

**Problem**: User gets URL, starts uploading large file, URL expires mid-upload.

**Solution**: Set expiry to accommodate largest expected file:
```javascript
// 100MB file @ 1Mbps = ~15 minutes
// Set expiry to 1 hour to be safe
Expires: 3600
```

### 2. CORS Errors with S3

**Problem**: Browser blocks S3 PUT request.

**Solution**: Configure S3 bucket CORS:
```json
[{
  "AllowedOrigins": ["http://localhost:4200", "https://yourdomain.com"],
  "AllowedMethods": ["GET", "PUT", "POST"],
  "AllowedHeaders": ["*"],
  "ExposeHeaders": ["ETag"]
}]
```

### 3. Content-Type Not Preserved

**Problem**: File uploaded but downloads as "application/octet-stream".

**Solution**: Set Content-Type in presigned URL:
```javascript
const url = await s3.getSignedUrlPromise('putObject', {
  ContentType: fileType,  // ✅ Must include
  Bucket: bucket,
  Key: key
});
```

### 4. PostgreSQL Connection Pool Exhaustion (pgsql-http)

**Problem**: Synchronous HTTP calls hold connections, pool runs out.

**Solution**: Increase pool size or switch to pg_net:
```javascript
// In micro-service
const pool = new Pool({
  max: 20,  // Increase from default 10
  idleTimeoutMillis: 30000
});
```

### 5. File Name Collisions

**Problem**: Two users upload "photo.jpg" to same entity.

**Solution**: Add timestamp or UUID to S3 key:
```javascript
const s3Key = `${entityType}/${entityId}/${Date.now()}-${fileName}`;
// Or use UUID: `${entityType}/${entityId}/${uuidv4()}-${fileName}`
```

### 6. Missing pg_net Extension

**Problem**: `CREATE EXTENSION pg_net` fails with "extension not found".

**Solution**: pg_net must be installed at OS level first:
```bash
# Check if installed
apt list --installed | grep pg-net

# Install if missing (Ubuntu/Debian)
apt-get install postgresql-17-pg-net

# Then in psql
CREATE EXTENSION pg_net;
```

### 7. Polling Timeout Too Short

**Problem**: Users on slow connections timeout before URL is ready.

**Solution**: Adjust polling parameters:
```typescript
const maxAttempts = 40;  // Increase from 20
const pollInterval = 500; // Total: 20 seconds
```

---

## S3 Alternatives Comparison

### Cloudflare R2

**Pros:**
- ✅ **Zero egress fees** (biggest advantage)
- ✅ S3-compatible API
- ✅ Excellent global performance
- ✅ Generous free tier (10GB storage, 1M requests/month)

**Cons:**
- ❌ No Transfer Acceleration (yet)
- ❌ Fewer features than S3

**Code Changes:** Nearly none, just change endpoint:
```javascript
const s3 = new AWS.S3({
  endpoint: 'https://[account-id].r2.cloudflarestorage.com',
  accessKeyId: process.env.R2_ACCESS_KEY_ID,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  signatureVersion: 'v4'
});
```

### Backblaze B2

**Pros:**
- ✅ Cheapest storage ($0.006/GB)
- ✅ Generous free egress (3x storage amount)
- ✅ S3-compatible API

**Cons:**
- ❌ Slower than AWS/Cloudflare
- ❌ Limited regions

### MinIO (Self-hosted)

**Pros:**
- ✅ Fully self-hosted (no vendor)
- ✅ S3-compatible
- ✅ Free and open source

**Cons:**
- ❌ You manage scaling, redundancy, backups
- ❌ No CDN integration

---

## EXIF Data Extraction - Free GPS Coordinates! 📍

**One of the hidden benefits of LISTEN/NOTIFY + Worker: automatic GPS extraction from photo metadata.**

### Why This Matters for Civic OS

Users reporting potholes take photos with their smartphones. Modern phones embed GPS coordinates in photo EXIF data. The worker can automatically extract this and populate the `location` field!

**User Experience:**
1. User takes photo of pothole with phone
2. Uploads to Civic OS
3. **GPS coordinates automatically extracted** 🎉
4. Pothole appears on map without manual entry

### Implementation

Already included in the worker example above:

```javascript
extractExif(buffer) {
  try {
    const parser = ExifParser.create(buffer);
    const result = parser.parse();

    return {
      latitude: result.tags.GPSLatitude,
      longitude: result.tags.GPSLongitude,
      timestamp: result.tags.DateTimeOriginal,
      camera: result.tags.Model,
      orientation: result.tags.Orientation
    };
  } catch (error) {
    return null;
  }
}
```

### Populating Issue Location

**Option 1: Direct Update (Simple)**

Worker updates the Issue record directly:

```javascript
// After extracting EXIF
if (exifData?.latitude && exifData?.longitude) {
  await client.query(`
    UPDATE "Issue"
    SET location = postgis.ST_SetSRID(
      postgis.ST_MakePoint($1, $2),
      4326
    )
    WHERE id = $3
      AND location IS NULL  -- Only if not manually set
  `, [exifData.longitude, exifData.latitude, entityId]);
}
```

**Option 2: Via PostgREST (Respects RLS)**

Worker calls PostgREST to update (respects permissions):

```javascript
await axios.patch(
  `${process.env.POSTGREST_URL}/Issue?id=eq.${entityId}`,
  {
    location: `SRID=4326;POINT(${exifData.longitude} ${exifData.latitude})`
  },
  {
    headers: {
      'Authorization': `Bearer ${process.env.SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal'
    }
  }
);
```

### Angular UI Enhancement

Show GPS indicator in upload component:

```typescript
@Component({
  template: `
    <input type="file" (change)="onFileSelected($event)" accept="image/*" />

    @if (uploadingFile()) {
      <div class="alert alert-info">
        <span class="loading loading-spinner"></span>
        <div>
          <p>Uploading photo...</p>
          @if (extractingGPS()) {
            <p class="text-sm">📍 Extracting GPS coordinates...</p>
          }
        </div>
      </div>
    }

    @if (gpsExtracted(); as coords) {
      <div class="alert alert-success">
        ✅ Location automatically detected: {{ coords.lat }}, {{ coords.lng }}
      </div>
    }
  `
})
export class IssuePhotoUploadComponent {
  uploadingFile = signal(false);
  extractingGPS = signal(false);
  gpsExtracted = signal<{lat: number, lng: number} | null>(null);

  async onFileSelected(event: Event) {
    this.uploadingFile.set(true);
    this.extractingGPS.set(true);

    // Upload file
    const fileRecord = await this.fileService.uploadWithThumbnails(...);

    // Poll for EXIF extraction
    interval(500).pipe(
      switchMap(() => this.http.get(`/api/files/${fileRecord.id}`)),
      takeWhile(f => !f.exif_data, true)
    ).subscribe(file => {
      if (file.exif_data?.latitude) {
        this.gpsExtracted.set({
          lat: file.exif_data.latitude,
          lng: file.exif_data.longitude
        });
        this.extractingGPS.set(false);
      }
    });

    this.uploadingFile.set(false);
  }
}
```

### Privacy Considerations

**IMPORTANT**: EXIF data includes:
- GPS coordinates (exact location)
- Timestamp (when photo was taken)
- Camera model
- Sometimes photographer name

**Best Practices:**
1. **Strip EXIF from thumbnails** (already done in worker - thumbnails are regenerated)
2. **Don't expose EXIF in public API** (store in JSONB, selective exposure)
3. **User consent**: "Allow location detection from photos" checkbox
4. **Manual override**: Let users adjust location if GPS is wrong

**Worker Enhancement:**

```javascript
// Strip sensitive EXIF from originals if needed
async stripExif(s3Key) {
  const original = await s3.getObject({
    Bucket: process.env.S3_BUCKET,
    Key: s3Key
  }).promise();

  const stripped = await sharp(original.Body)
    .withMetadata({ exif: {} })  // Remove EXIF
    .toBuffer();

  await s3.putObject({
    Bucket: process.env.S3_BUCKET,
    Key: s3Key.replace('/originals/', '/public/'),
    Body: stripped
  }).promise();
}
```

### Other EXIF Use Cases

**Image Rotation:**
- EXIF Orientation tag (1-8) indicates if photo was rotated
- Worker auto-rotates thumbnails to correct orientation
- Already handled by Sharp with `rotate()` option

**Timestamp:**
- Use `DateTimeOriginal` instead of upload timestamp
- More accurate for "when was pothole first seen"

**Camera Model:**
- Analytics: which devices are used most
- Debugging: quality issues with specific models

---

## Migration Paths

### From PostgreSQL BYTEA → S3-based

1. **Parallel Run Phase:**
   - Add S3 upload capability
   - Keep BYTEA uploads working
   - New files go to S3, old files stay in DB

2. **Migration Script:**
```javascript
// Migrate existing files to S3
const { Pool } = require('pg');
const AWS = require('aws-sdk');

const pool = new Pool();
const s3 = new AWS.S3();

async function migrate() {
  const { rows } = await pool.query('SELECT * FROM blobs');

  for (const row of rows) {
    await s3.putObject({
      Bucket: 'civic-os-files',
      Key: `migrated/${row.entity_type}/${row.entity_id}/${row.file_name}`,
      Body: row.data,
      ContentType: row.content_type
    }).promise();

    console.log(`Migrated: ${row.file_name}`);
  }
}
```

3. **Cleanup:**
   - Verify all files accessible
   - Delete BYTEA data: `UPDATE blobs SET data = NULL`
   - Eventually drop BYTEA column

### From pgsql-http → pg_net

1. Create new functions with pg_net
2. Update Angular to use new functions
3. Test thoroughly
4. Remove old pgsql-http functions

**Minimal code changes** - same micro-service, different PostgreSQL functions.

---

## Security Considerations

For all approaches:

1. **Row-Level Security**: Apply RLS policies to `file_upload_requests` table
2. **Presigned URL Expiry**: Keep short (1 hour max)
3. **S3 Bucket Policy**: Ensure bucket is private by default
4. **File Size Limits**: Enforce in Angular and S3 presigned URL
5. **Content-Type Validation**: Restrict allowed MIME types
6. **Virus Scanning**: Consider S3 event trigger to scan uploaded files
7. **Credentials**: Store AWS credentials as Docker secrets, never in code
8. **Rate Limiting**: Prevent abuse by limiting requests per user/IP
9. **Audit Logging**: Log all file operations for compliance
10. **Data Residency**: Ensure S3 region complies with regulations (GDPR, etc.)

---

## Future Enhancements

1. **Download URLs**: Similar pattern for generating presigned GET URLs
2. **File Metadata Table**: Store file references linked to entities
3. **Image Thumbnails**: Worker generates thumbnails after upload
4. **Progress Tracking**: WebSockets or Server-Sent Events for upload progress
5. **CDN Integration**: CloudFront in front of S3 for faster delivery
6. **File Versioning**: S3 versioning + metadata tracking

---

## References

- [pg_net Documentation (Supabase)](https://supabase.com/docs/guides/database/extensions/pg_net)
- [pgsql-http Extension (GitHub)](https://github.com/pramsey/pgsql-http)
- [PostgreSQL LISTEN/NOTIFY (Official Docs)](https://www.postgresql.org/docs/current/sql-notify.html)
- [AWS S3 Presigned URLs (AWS Docs)](https://docs.aws.amazon.com/AmazonS3/latest/userguide/PresignedUrlUploadObject.html)
- [PostgREST Documentation](https://postgrest.org/)
- [Recreating S3 in Postgres using PostgREST (Neon Blog)](https://neon.com/blog/recreating-s3-in-postgres-using-postgrest)
