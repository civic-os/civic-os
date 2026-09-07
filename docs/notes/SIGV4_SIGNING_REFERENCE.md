# AWS SigV4 Presigned URL Signing — PostgreSQL Reference

> **Purpose**: Algorithm reference for implementing SigV4 presigned URL generation in PostgreSQL using `pgcrypto`. Extracted from research into AWS documentation, `pgsql-http` examples, and `cmoore-sp/plsql-aws-s3`.
> **Used by**: `docs/notes/SIGNED_FILE_URLS_DESIGN.md`

## Core Premise

Presigned URLs are generated entirely client-side with **no communication with the object store**. The signature is `HMAC-SHA256(signingKey, stringToSign)`, and the signing key is derived by four chained HMACs. Nothing about generating the URL touches the network; the network only happens later when the *client* uses the URL against S3.

This is exactly why it is feasible in-database: PostgreSQL's `pgcrypto` extension provides `hmac()` and `digest()`, the only two primitives needed.

## The SigV4 Presigned URL Algorithm

Source: AWS "Authenticating Requests: Using Query Parameters (AWS Signature Version 4)"

### Query parameters

All except `X-Amz-Signature` go into the canonical query string, sorted by name:

| Parameter | Value |
|-----------|-------|
| `X-Amz-Algorithm` | `AWS4-HMAC-SHA256` |
| `X-Amz-Credential` | `<access-key-id>/<yyyymmdd>/<region>/s3/aws4_request` (the `/` must be percent-encoded as `%2F`) |
| `X-Amz-Date` | `<yyyymmdd>T<hhmmss>Z` (ISO 8601 basic, UTC) |
| `X-Amz-Expires` | `<seconds>` (1..604800, max 7 days) |
| `X-Amz-SignedHeaders` | `host` |
| `X-Amz-Security-Token` | `<token>` (only if using STS creds — avoid for in-database signing) |
| `X-Amz-Signature` | `<hex>` (appended last, not part of the signed canonical query) |

### Canonical request

```
GET
/<uri-encoded-object-key>
<canonical-query-string-sorted>
host:<hostname>
                                    ← empty line
host
UNSIGNED-PAYLOAD
```

- The payload hash is the literal string `UNSIGNED-PAYLOAD` (not a SHA of an empty body), "because when you create a presigned URL, you don't know the payload content."
- Canonical headers must include the HTTP `host` header; `SignedHeaders` is `host` at minimum.
- The hostname depends on URL style (see Path-Style vs Virtual-Hosted below).

### String to sign

```
AWS4-HMAC-SHA256
<yyyymmdd>T<hhmmss>Z
<yyyymmdd>/<region>/s3/aws4_request
<hex(sha256(canonical_request))>
```

### Signing key derivation

```
kDate    = HMAC-SHA256("AWS4" + secret_access_key, yyyymmdd)
kRegion  = HMAC-SHA256(kDate, region)
kService = HMAC-SHA256(kRegion, "s3")
kSigning = HMAC-SHA256(kService, "aws4_request")
signature = hex(HMAC-SHA256(kSigning, string_to_sign))
```

**Critical**: Intermediate keys (`kDate`, `kRegion`, `kService`, `kSigning`) must stay as raw `bytea`. Do **not** hex-encode between stages — only hex-encode the final signature.

## pgcrypto Implementation

### Key derivation in SQL

```sql
encode(
  hmac(
    string_to_sign::bytea,
    hmac('aws4_request'::bytea,
      hmac('s3'::bytea,
        hmac(region::bytea,
          hmac(datestamp::bytea, ('AWS4' || secret_key)::bytea, 'sha256'),
        'sha256'),
      'sha256'),
    'sha256'),
  'sha256'),
'hex')
```

### Canonical request hash

```sql
encode(digest(canonical_request::bytea, 'sha256'), 'hex')
```

### Timestamp formatting

```sql
-- ISO 8601 basic UTC timestamp for X-Amz-Date
to_char(now() AT TIME ZONE 'utc', 'YYYYMMDD"T"HH24MISS"Z"')

-- Date-only for credential scope and signing key
to_char(now() AT TIME ZONE 'utc', 'YYYYMMDD')
```

## URI Encoding Rules

AWS specifies custom URI encoding rules that differ from standard percent-encoding:

1. Encode every byte except unreserved characters: `A-Z a-z 0-9 - . _ ~`
2. Space → `%20` (never `+`)
3. Hex digits must be **uppercase** (`%2F`, not `%2f`)
4. **Encode `/` everywhere except in the object key path** — slashes separating path segments in the S3 key stay literal, but slashes inside the credential scope value are encoded as `%2F`

AWS explicitly warns: "The standard UriEncode functions provided by your development platform may not work... We recommend that you write your own custom UriEncode function."

### Implementation approach

Two functions:
- `aws_uri_encode(text, encode_slash boolean)` — encodes everything, optionally encoding `/`
- `aws_uri_encode_path(text)` — calls `aws_uri_encode(text, false)` for S3 key paths

## Path-Style vs Virtual-Hosted URLs

The signing function must support both URL styles because Civic OS supports MinIO (dev), DigitalOcean Spaces, and AWS S3 (production).

### Virtual-hosted style (AWS default)

```
https://<bucket>.s3.<region>.amazonaws.com/<key>
Host header: <bucket>.s3.<region>.amazonaws.com
Canonical URI: /<key>
```

### Path-style (MinIO, DO Spaces, dotted buckets)

```
https://<endpoint>/<bucket>/<key>
Host header: <endpoint-host>
Canonical URI: /<bucket>/<key>
```

**Key differences for signing**:
- The `host` header value changes
- The canonical URI includes the bucket name in path-style
- The `s3_path_style` config key controls which branch to use

**Caveats**:
- Buckets with dots (`my.bucket`) break virtual-hosted TLS — use path-style
- MinIO defaults to path-style and only does virtual-hosted if `MINIO_DOMAIN` is set
- Reverse proxies that rewrite Host/path break signatures
- The signing region must match the bucket's actual region

## AWS Test Vector

Use this to verify the implementation produces correct signatures.

| Parameter | Value |
|-----------|-------|
| Access Key ID | `AKIAIOSFODNN7EXAMPLE` |
| Secret Access Key | `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY` |
| Region | `us-east-1` |
| Bucket | `examplebucket` |
| Object Key | `test.txt` |
| Timestamp | `20130524T000000Z` |
| X-Amz-Expires | `86400` |

AWS publishes the exact expected canonical request, string-to-sign, and signing key for this case. The `metadata.verify_sigv4_test_vector()` function should reproduce the expected signature exactly.

### Verification approach

1. Hard-code the test vector parameters in `verify_sigv4_test_vector()`
2. Run each stage (canonical request, string-to-sign, signing key, final signature) and compare against AWS's published values
3. Additionally, compare `generate_presigned_get_url()` output against `aws s3 presign` CLI for a real object in your bucket

## Known Gotchas

1. **`hmac()`/`digest()` return `bytea`** — you must `encode(x, 'hex')` for the final signature and canonical request hash. The hex is automatically lowercase (which is correct). But do **not** hex-encode intermediate signing keys — pass raw `bytea` into the next `hmac()`.

2. **Timestamp must be UTC** — any local-timezone leakage causes `SignatureDoesNotMatch`. Always use `now() AT TIME ZONE 'utc'`.

3. **Query params must be sorted** by name in the canonical query string, and each value URI-encoded. Wrong order fails.

4. **Uppercase percent-encoding** — `%2F` not `%2f`. PostgreSQL's built-in encoding functions may lowercase hex digits.

5. **`X-Amz-Expires` max is 604800** (7 days). For IAM user long-term keys. STS/role credentials have shorter effective limits regardless of `X-Amz-Expires`.

6. **Clock skew** — S3 validates that `X-Amz-Date` is reasonably close to its own clock. Keep NTP in sync. `X-Amz-Expires` gives tolerance, but a badly wrong server clock breaks validation.

7. **Signing region must match bucket region** — otherwise `SignatureDoesNotMatch` or `PermanentRedirect`.

8. **`SignatureDoesNotMatch` debugging** — S3 returns the `CanonicalRequest` and `StringToSign` it computed in the error body. Diff against yours; the mismatch is almost always in the canonical request (encoding or header formatting).

9. **STS tokens** — if signing with STS/role credentials, you must add `X-Amz-Security-Token` to the signed query string. For in-database signing, prefer IAM user long-term keys to avoid this complexity.

10. **SSE-KMS objects require SigV4** — not a concern since we only use SigV4, but explains legacy `SignatureDoesNotMatch` reports in search results.

11. **`response-content-disposition` for downloads** — must be included in the canonical query string (sorted with other params) and signed. The value must be URI-encoded in the query string.

## Reference Implementations

- **`pramsey/pgsql-http` examples/** (Paul Ramsey, MIT): S3 request-signing in SQL using pgcrypto and the `http` extension. Signs live requests (Authorization-header style), not query-string presigned URLs, but the HMAC chain and canonicalization are directly reusable.

- **`cmoore-sp/plsql-aws-s3`** (Christina Moore / Storm Petrel LLC): Complete, production-tested SigV4 S3 signer in Oracle PL/SQL. Used in a ~2,000-user grants application (Tempest-GEMS) for the Government of Puerto Rico. Structure maps directly to pgcrypto:
  - `aws4_sha256()` → `encode(digest(data, 'sha256'), 'hex')`
  - `aws4_signing_key()` → nested `hmac(..., 'sha256')` calls (keep `bytea` between stages)
  - `aws4_escape()` → custom URI encoder with `/`→`%2F` replacement

- **`chimpler/postgres-aws-s3`** (Apache-2.0): Reimplementation of RDS `aws_s3` extension, but uses `plpython3u` + boto3 — signing happens in Python, not SQL. Confirms the common pattern but not useful as a SQL reference.

## Credential Security

### `SECURITY DEFINER` pattern

```sql
CREATE FUNCTION metadata.generate_presigned_get_url(...)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''  -- prevents search_path hijacking
AS $$ ... $$;

REVOKE ALL ON FUNCTION metadata.generate_presigned_get_url(...) FROM public;
-- Function is called indirectly via the VIEW, not directly by API users
```

- Always pin `search_path` on `SECURITY DEFINER` functions
- Never `RAISE` or log the secret access key
- The function is not exposed via PostgREST — it's called internally by the VIEW's computed columns
- RLS authorization happens *before* the function is called (via `security_invoker` VIEW)

### Credential storage options

| Method | Pros | Cons |
|--------|------|------|
| `instance_config` table + `get_config()` | Integrates with Instance Config Store design; standard Civic OS pattern | Plaintext in table (rely on disk encryption) |
| GUC via `ALTER DATABASE SET` | Simplest; well-documented PostgREST pattern | Visible in `pg_settings`/dumps |
| Supabase Vault | Encrypted at rest | Supabase-only |

**Recommendation**: Use `instance_config` + `get_config()` for consistency with the Instance Config Store design. GUC bridge for development until `instance_config` is implemented.
