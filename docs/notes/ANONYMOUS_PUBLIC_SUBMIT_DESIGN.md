# Anonymous Public Submit — Technical Specification

**Status**: Design — ready for implementation review
**Date**: 2026-09-07
**Dependencies**: Instance Config Store (planned), `pgcrypto` extension (existing)

## Context

Civic OS routes all access through Keycloak/JWT. This works for staff and authenticated constituents, but blocks a large class of civic intake where requiring an account kills conversion: nonprofit client intake, volunteer signups, public service requests, permit applications.

This spec defines a **reusable platform capability** — not event-specific plumbing — that lets unauthenticated visitors submit forms safely. It resolves the framing doc's open questions against the actual codebase and evolves the design through several iterations:

1. Per-form integrator RPCs → **generic framework wrapper** (make it hard to mess up)
2. CAPTCHA as future Phase 2 → **ALTCHA proof-of-work as built-in** (zero external dependencies, verifiable in SQL)
3. Secret key storage as GUC → **Instance Config Store** (planned feature, natural home for server-side secrets)

---

## Approach Comparison: Why RPC-Mediated (5b)

The framing doc presented two mechanisms. We adopt 5b exclusively.

### 5a: Direct RLS INSERT via `web_anon`

Grant `INSERT` on the target table to `web_anon`, constrain via RLS `WITH CHECK`.

- **Pro**: Minimal moving parts, idiomatic PostgREST.
- **Con — column exposure**: Every column is a potential attack surface. An attacker can POST `status_id`, `assigned_to`, `is_approved` unless each is constrained in `WITH CHECK`. Forgetting one is a silent vulnerability.
- **Con — no procedural logic**: `WITH CHECK` supports only SQL expressions. No cross-table lookups, no conditional validation, no anti-abuse checks.
- **Con — anti-abuse has no home**: Honeypot, timing, rate limiting, and PoW verification don't fit in an RLS policy. Requires scattering logic across triggers.
- **Con — no `EntityActionResult`**: PostgREST INSERT returns the created row, not a custom success message, redirect URL, or field-level errors.
- **Con — write-only RLS is subtle**: Getting INSERT-allowed + SELECT-blocked + UPDATE-blocked + DELETE-blocked exactly right requires careful policy authoring. Misconfiguration is invisible until exploited.

### 5b: RPC-Mediated Submit (adopted)

`web_anon` has NO grants on data tables. A single `SECURITY DEFINER` wrapper is the only entry point.

- **Pro — single chokepoint**: Validation, anti-abuse, PoW, audit, and INSERT all in one place.
- **Pro — typed parameters**: Function signature defines exactly which fields the public can set.
- **Pro — returns `EntityActionResult`**: Custom messages, redirects, field errors — consistent with existing patterns.
- **Pro — zero table exposure**: Public surface is one function, not a table.

**We do not build 5a.** If an integrator truly wants raw anonymous INSERT, they can grant it manually — standard PostgreSQL, not something the framework needs to scaffold.

---

## Architecture: Generic Wrapper

The key design principle: **make it hard to mess up.** The framework handles `SECURITY DEFINER`, `search_path`, anti-abuse, PoW verification, audit logging, and exception handling. The integrator configures via metadata.

### Three Tiers of Integrator Complexity

**Tier 0 — Metadata only** (most forms): One SQL INSERT into `metadata.public_forms`. Zero custom functions. The framework auto-INSERTs into the target table.

**Tier 1 — Validation hook** (some forms): Add a `validate_rpc` for business rules beyond field validation. Called after anti-abuse, before INSERT. Pure `SECURITY INVOKER` — no elevated privileges needed.

**Tier 2 — Custom submit** (rare): Add a `custom_submit_rpc` for multi-table writes, notifications, or complex logic. Called after anti-abuse passes. The framework still handles abuse defense, audit, and exception wrapping.

### Single Entry Point

```
Frontend → POST /rpc/submit_public_form
         → { "p_form_key": "issue_report", "p_data": { "name": "...", "description": "..." } }
         → Headers: X-Cos-Honeypot, X-Cos-Elapsed, X-Cos-Pow (ALTCHA token)
```

One function granted to `web_anon`. One grant. Forever.

---

## 1. Database Schema

Migration: `v0-XX-0-anonymous-public-submit`

### 1.1 Public Form Registry

```sql
CREATE TABLE metadata.public_forms (
    table_name             NAME PRIMARY KEY,
    display_name           TEXT NOT NULL,
    description            TEXT,
    submit_label           TEXT DEFAULT 'Submit',
    success_message        TEXT,         -- NULL = default "Submission received"
    success_redirect       TEXT,         -- NULL = show in-page success
    enabled                BOOLEAN DEFAULT TRUE,
    -- Target for auto-INSERT (Tier 0/1). NULL when custom_submit_rpc is set.
    target_table           NAME,
    -- Optional hooks (Tier 1/2)
    validate_rpc           NAME,         -- called after anti-abuse, before INSERT
    custom_submit_rpc      NAME,         -- replaces auto-INSERT entirely
    -- Anti-abuse configuration
    honeypot_field         TEXT DEFAULT 'contact_website',
    min_submit_seconds     INT DEFAULT 3,
    rate_limit_per_ip      INT DEFAULT 10,
    rate_limit_window_min  INT DEFAULT 60,
    require_pow            BOOLEAN DEFAULT FALSE,  -- require ALTCHA proof-of-work
    -- Branding
    logo_url               TEXT,
    footer_markdown        TEXT,
    created_at             TIMESTAMPTZ DEFAULT now(),
    updated_at             TIMESTAMPTZ DEFAULT now(),
    -- Constraints
    CHECK (target_table IS NOT NULL OR custom_submit_rpc IS NOT NULL)
);
```

**Why a separate table**: Public forms are a fundamentally different access pattern (unauthenticated, rate-limited, SECURITY DEFINER). Only a small subset of entities will have them. Adding 15+ nullable columns to `metadata.entities` would be noise.

### 1.2 Submission Audit Log

```sql
CREATE TABLE metadata.public_form_submissions (
    id                  BIGSERIAL PRIMARY KEY,
    table_name          NAME NOT NULL,
    submitted_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    ip_address          INET,
    user_agent          TEXT,
    user_id             UUID,            -- non-null via progressive identity
    honeypot_triggered  BOOLEAN DEFAULT FALSE,
    timing_violation    BOOLEAN DEFAULT FALSE,
    rate_limited        BOOLEAN DEFAULT FALSE,
    pow_failed          BOOLEAN DEFAULT FALSE,
    success             BOOLEAN,
    error_message       TEXT,
    form_data_hash      TEXT,            -- SHA-256 of payload (not the payload)
    pow_challenge       TEXT             -- ALTCHA challenge string for replay prevention
);

CREATE INDEX idx_pfs_ip_table_time
    ON metadata.public_form_submissions (ip_address, table_name, submitted_at DESC);

-- PoW replay prevention lookup
CREATE INDEX idx_pfs_pow_challenge
    ON metadata.public_form_submissions (pow_challenge)
    WHERE pow_challenge IS NOT NULL AND success = TRUE;
```

**Why hash, not payload**: Data goes into the target table. Duplicating it raises PII/retention concerns. The hash enables duplicate detection without storing PII.

### 1.3 RLS on Audit Log

```sql
ALTER TABLE metadata.public_form_submissions ENABLE ROW LEVEL SECURITY;

CREATE POLICY pfs_anon_insert ON metadata.public_form_submissions
    FOR INSERT TO web_anon WITH CHECK (TRUE);

CREATE POLICY pfs_admin_select ON metadata.public_form_submissions
    FOR SELECT TO authenticated USING (is_admin());
```

### 1.4 Public Form Configuration VIEW

```sql
CREATE VIEW public.schema_public_forms
WITH (security_invoker = true) AS
SELECT
    pf.table_name,
    metadata.t('public_form', pf.table_name::text || '.display_name',
        pf.display_name) AS display_name,
    metadata.t('public_form', pf.table_name::text || '.description',
        pf.description) AS description,
    metadata.t('public_form', pf.table_name::text || '.submit_label',
        pf.submit_label) AS submit_label,
    metadata.t('public_form', pf.table_name::text || '.success_message',
        pf.success_message) AS success_message,
    pf.success_redirect,
    pf.honeypot_field, pf.require_pow,
    pf.logo_url,
    metadata.t('public_form', pf.table_name::text || '.footer_markdown',
        pf.footer_markdown) AS footer_markdown
FROM metadata.public_forms pf
WHERE pf.enabled = TRUE;
```

**i18n**: All user-facing text columns are wrapped with `metadata.t()` using source type `public_form`. The `LocaleInterceptor` adds `Accept-Language` to PostgREST requests, so translations resolve automatically. Add `public_form` to the `get_translation_defaults()` UNION so the Admin Translation page discovers missing translations.

Note: `min_submit_seconds`, `rate_limit_*`, `target_table`, and RPC names are **not exposed** to the frontend. The backend validates; exposing internals helps attackers calibrate.

### 1.5 schema_rpc_parameters VIEW (Shared Infrastructure)

From the Custom Pages design — built as shared infrastructure for public forms, Custom Pages, and Entity Actions upgrade:

```sql
CREATE VIEW public.schema_rpc_parameters
WITH (security_invoker = true) AS
SELECT
    r.routine_name    AS function_name,
    p.parameter_name, p.data_type, p.udt_name,
    p.ordinal_position::INT,
    p.parameter_default IS NOT NULL AS has_default
FROM information_schema.routines r
JOIN information_schema.parameters p ON p.specific_name = r.specific_name
WHERE r.routine_schema = 'public' AND p.parameter_mode = 'IN'
ORDER BY r.routine_name, p.ordinal_position;
```

### 1.6 Grants

```sql
-- Framework tables/views
GRANT SELECT ON metadata.public_forms TO web_anon, authenticated;
GRANT INSERT ON metadata.public_form_submissions TO web_anon;
GRANT USAGE, SELECT ON SEQUENCE metadata.public_form_submissions_id_seq TO web_anon;
GRANT SELECT ON metadata.public_form_submissions TO authenticated;
GRANT SELECT ON public.schema_public_forms TO web_anon, authenticated;
GRANT SELECT ON public.schema_rpc_parameters TO web_anon, authenticated;

-- The ONE submit function
GRANT EXECUTE ON FUNCTION public.submit_public_form(NAME, JSONB) TO web_anon;
```

Per-form (instance-level):
```sql
-- 1. Table grants — web_anon needs SELECT for schema_properties to discover form shape
GRANT SELECT ON public.<target_table> TO web_anon;

-- 2. RBAC permission — anonymous role needs read permission so schema_entities/schema_properties
--    VIEWs (which use security_invoker + has_permission()) return the entity's metadata.
--    Without this, the PublicFormPage gets zero properties from SchemaService.
INSERT INTO metadata.permissions (table_name, role_key, can_read)
VALUES ('<target_table>', 'anonymous', TRUE);

-- 3. FK target tables — if the form has FK dropdowns (e.g., "department"),
--    web_anon needs SELECT on each FK target table AND anonymous read permission.
--    Only grant for FK targets appropriate for public exposure.
GRANT SELECT ON public.<fk_target_table> TO web_anon;
INSERT INTO metadata.permissions (table_name, role_key, can_read)
VALUES ('<fk_target_table>', 'anonymous', TRUE);

-- Target table INSERT is NOT granted to web_anon directly;
-- the DEFINER wrapper does the INSERT.
```

**Security note on FK targets**: Not all FK columns are appropriate for public forms. Internal references (e.g., `assigned_to`, `created_by`) should not have their target tables exposed to `web_anon`. The integrator should carefully choose which FK dropdowns appear on the public form by setting `show_on_create = FALSE` on internal FK properties for the target table's metadata.properties entries.

---

## 2. ALTCHA Proof-of-Work

### Why ALTCHA

| | Turnstile | Cap | **ALTCHA** |
|---|---|---|---|
| License | Proprietary | Apache 2.0 | **MIT** |
| Self-hosted | No (Cloudflare) | Yes (Docker + Redis) | **Yes (no infra)** |
| External calls to verify | Yes (every submit) | No (self-hosted API) | **No (pure crypto)** |
| New infrastructure | None | Container + Redis | **None** |
| Verify in SQL | No | No | **Yes (`pgcrypto`)** |
| Privacy | Data to Cloudflare | Fully private | **Fully private** |
| WCAG | Compliant | Compliant | **WCAG 2.2 AA certified** |

ALTCHA's proof-of-work is entirely cryptographic: the server generates an HMAC-signed challenge, the client brute-force solves it (SHA-256, ~1-2s in a real browser), and the server verifies with one HMAC check + one hash — all expressible in PostgreSQL via `pgcrypto`.

### Flow

```
1. Frontend loads public form
2. Frontend requests challenge: GET /rpc/get_pow_challenge?p_form_key=issue_report
3. Server generates: salt (random + timestamp), secret_number (random),
   challenge = SHA-256(salt || secret_number),
   signature = HMAC-SHA-256(challenge, altcha_secret_key)
   Returns: { salt, challenge, signature, algorithm: "SHA-256" }
4. ALTCHA widget brute-forces to find secret_number
5. On submit, frontend sends solution as X-Cos-Pow header (base64 JSON):
   { salt, number, challenge, signature, algorithm }
6. Server verifies inside submit_public_form():
   a. Extract timestamp from salt prefix — reject if older than 10 minutes (TTL)
   b. HMAC(challenge, secret_key) == signature  (proves we issued this challenge)
   c. SHA-256(salt || number) == challenge       (proves client did the work)
   d. Challenge not already used (replay prevention via pow_challenge column)
```

**Challenge TTL**: The salt embeds a Unix timestamp prefix (`<epoch_hex>.<random_hex>`). The verifier extracts it and rejects challenges older than 10 minutes. This prevents attackers from stockpiling pre-solved challenges. The timestamp is inside the HMAC-signed payload, so it cannot be tampered with.

### Secret Key Storage: Instance Config Store

The ALTCHA HMAC secret key is a server-side-only secret. It must NOT be queryable via PostgREST.

**Dependency**: The planned **Instance Config Store** feature provides a natural home — a metadata table for server-side configuration that is readable only by `SECURITY DEFINER` framework functions, never exposed through the API.

The wrapper reads the key via something like:
```sql
v_secret := instance_config('altcha_secret_key');
```

If the Instance Config Store isn't built yet at implementation time, a PostgreSQL GUC serves as a temporary bridge:
```sql
ALTER DATABASE civic_os_db SET app.altcha_secret = 'random-256-bit-key';
-- Read via: current_setting('app.altcha_secret')
```

### Challenge Generation RPC

```sql
CREATE FUNCTION public.get_pow_challenge(p_form_key NAME)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, metadata, pg_temp
AS $$
DECLARE
    v_secret       TEXT;
    v_salt         TEXT;
    v_number       INT;
    v_challenge    TEXT;
    v_signature    TEXT;
BEGIN
    -- Verify form exists and requires PoW
    IF NOT EXISTS (
        SELECT 1 FROM metadata.public_forms
        WHERE table_name = p_form_key AND enabled AND require_pow
    ) THEN
        RETURN jsonb_build_object('error', 'Form not found or PoW not required');
    END IF;

    -- Read secret from Instance Config Store (or GUC fallback)
    v_secret := current_setting('app.altcha_secret', true);
    IF v_secret IS NULL THEN
        RETURN jsonb_build_object('error', 'PoW not configured');
    END IF;

    -- Generate challenge with timestamp-embedded salt for TTL enforcement
    v_salt := lpad(to_hex(extract(epoch FROM now())::BIGINT), 12, '0')
              || '.' || encode(gen_random_bytes(12), 'hex');
    v_number := floor(random() * 100000)::INT;  -- difficulty ~50K iterations avg
    v_challenge := encode(
        digest(v_salt || v_number::TEXT, 'sha256'), 'hex');
    v_signature := encode(
        hmac(v_challenge, v_secret, 'sha256'), 'hex');

    RETURN jsonb_build_object(
        'algorithm', 'SHA-256',
        'salt', v_salt,
        'challenge', v_challenge,
        'signature', v_signature
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_pow_challenge(NAME) TO web_anon;
```

### PoW Verification (inside `_check_public_submit()`)

```sql
-- When require_pow = TRUE:

v_pow_json := current_setting('request.header.x-cos-pow', true);
IF v_pow_json IS NULL OR v_pow_json = '' THEN
    RETURN jsonb_build_object('success', false,
        'message', 'Verification required');
END IF;

v_pow := v_pow_json::JSONB;
v_secret := current_setting('app.altcha_secret', true);

-- 1. TTL check — extract timestamp from salt prefix, reject if > 10 minutes old
v_salt_parts := string_to_array(v_pow->>'salt', '.');
v_challenge_ts := to_timestamp(('x' || v_salt_parts[1])::BIT(48)::BIGINT);
IF v_challenge_ts < now() - INTERVAL '10 minutes' THEN
    INSERT INTO metadata.public_form_submissions
        (table_name, ip_address, user_agent, pow_failed, success)
    VALUES (p_form_key, v_ip, v_ua, TRUE, FALSE);
    RETURN jsonb_build_object('success', false, 'message', 'Verification expired');
END IF;

-- 2. Verify HMAC (proves we issued this challenge)
IF encode(hmac(v_pow->>'challenge', v_secret, 'sha256'), 'hex')
   <> v_pow->>'signature' THEN
    INSERT INTO metadata.public_form_submissions
        (table_name, ip_address, user_agent, pow_failed, success)
    VALUES (p_form_key, v_ip, v_ua, TRUE, FALSE);
    RETURN jsonb_build_object('success', false, 'message', 'Verification failed');
END IF;

-- 3. Verify proof-of-work (proves client did the computation)
IF encode(digest((v_pow->>'salt') || (v_pow->>'number'), 'sha256'), 'hex')
   <> v_pow->>'challenge' THEN
    INSERT INTO metadata.public_form_submissions
        (table_name, ip_address, user_agent, pow_failed, success)
    VALUES (p_form_key, v_ip, v_ua, TRUE, FALSE);
    RETURN jsonb_build_object('success', false, 'message', 'Verification failed');
END IF;

-- 4. Replay prevention: check if this challenge was already used
IF EXISTS (
    SELECT 1 FROM metadata.public_form_submissions
    WHERE pow_challenge = v_pow->>'challenge' AND success = TRUE
) THEN
    RETURN jsonb_build_object('success', false, 'message', 'Verification expired');
END IF;
```

### Frontend ALTCHA Widget

The ALTCHA widget is an npm package (`altcha`) providing a web component. When `require_pow` is true in the form config:

1. `PublicFormPage` renders the `<altcha-widget>` component
2. Widget calls `GET /rpc/get_pow_challenge?p_form_key=<key>` (custom challengeurl)
3. Widget solves PoW in a Web Worker (~1-2s)
4. On submit, the solution JSON is sent as `X-Cos-Pow` header
5. If PoW isn't required, the widget is not rendered and no header is sent

---

## 3. Generic Wrapper: `submit_public_form()`

The single framework function that handles everything:

```sql
CREATE FUNCTION public.submit_public_form(
    p_form_key  NAME,
    p_data      JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, metadata, pg_temp
AS $$
DECLARE
    v_form     RECORD;
    v_abuse    JSONB;
    v_valid    JSONB;
    v_result   JSONB;
    v_ip       INET;
    v_ua       TEXT;
    v_user_id  UUID;
BEGIN
    -- 1. Load form config
    SELECT * INTO v_form FROM metadata.public_forms
    WHERE table_name = p_form_key AND enabled;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false,
            'message', 'This form is not currently available');
    END IF;

    -- 2. Read request context
    v_ip := _safe_inet(current_setting('request.header.x-forwarded-for', true));
    v_ua := current_setting('request.header.user-agent', true);
    BEGIN
        v_user_id := (current_setting('request.jwt.claims', true)::json->>'sub')::UUID;
    EXCEPTION WHEN OTHERS THEN v_user_id := NULL; END;

    -- 3. Anti-abuse checks (honeypot, timing, rate limit, PoW)
    v_abuse := _check_public_submit(v_form, v_ip, v_ua, v_user_id);
    IF v_abuse IS NOT NULL THEN RETURN v_abuse; END IF;

    -- 4. Optional validation hook (Tier 1)
    IF v_form.validate_rpc IS NOT NULL THEN
        EXECUTE format('SELECT %I($1)', v_form.validate_rpc)
            INTO v_valid USING p_data;
        IF v_valid IS NOT NULL AND (v_valid->>'success')::BOOLEAN IS DISTINCT FROM TRUE THEN
            RETURN v_valid;
        END IF;
    END IF;

    -- 5a. Custom submit (Tier 2) — integrator handles business logic
    IF v_form.custom_submit_rpc IS NOT NULL THEN
        EXECUTE format('SELECT %I($1)', v_form.custom_submit_rpc)
            INTO v_result USING p_data;

    -- 5b. Auto-INSERT (Tier 0/1) — framework handles the write
    ELSE
        v_result := _auto_insert_public_form(v_form.target_table, p_data);
    END IF;

    -- 6. Audit log (always)
    INSERT INTO metadata.public_form_submissions
        (table_name, ip_address, user_agent, user_id, success,
         form_data_hash, pow_challenge)
    VALUES (p_form_key, v_ip, v_ua, v_user_id,
        COALESCE((v_result->>'success')::BOOLEAN, TRUE),
        encode(digest(p_data::TEXT, 'sha256'), 'hex'),
        CASE WHEN v_form.require_pow THEN
            current_setting('request.header.x-cos-pow', true)::JSONB->>'challenge'
        END);

    -- 7. Return result with form-level overrides
    RETURN COALESCE(v_result, '{}'::JSONB) || jsonb_build_object(
        'success', COALESCE((v_result->>'success')::BOOLEAN, TRUE),
        'message', COALESCE(
            v_result->>'message',
            v_form.success_message,
            'Thank you for your submission'));

EXCEPTION
    WHEN check_violation OR not_null_violation OR unique_violation
         OR foreign_key_violation OR string_data_right_truncation THEN
        -- Surface DB constraint errors — frontend ErrorService.parseToHuman()
        -- translates constraint names to user-friendly messages via
        -- metadata.constraint_messages, consistent with CreatePage behavior.
        INSERT INTO metadata.public_form_submissions
            (table_name, ip_address, user_agent, user_id, success, error_message)
        VALUES (p_form_key, v_ip, v_ua, v_user_id, FALSE, SQLERRM);
        RETURN jsonb_build_object('success', false,
            'message', SQLERRM);
    WHEN OTHERS THEN
        -- Unexpected errors — generic message, log details for admin
        INSERT INTO metadata.public_form_submissions
            (table_name, ip_address, user_agent, user_id, success, error_message)
        VALUES (p_form_key, v_ip, v_ua, v_user_id, FALSE, SQLERRM);
        RETURN jsonb_build_object('success', false,
            'message', 'Something went wrong. Please try again.');
END;
$$;

GRANT EXECUTE ON FUNCTION public.submit_public_form(NAME, JSONB) TO web_anon;
```

### Auto-INSERT Helper

For Tier 0/1, the framework dynamically inserts into the target table using only whitelisted columns:

```sql
CREATE FUNCTION metadata._auto_insert_public_form(
    p_target_table NAME,
    p_data         JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    v_allowed_cols NAME[];
    v_col          NAME;
    v_cols         TEXT := '';
    v_vals         TEXT := '';
    v_id           TEXT;
    v_user_id      UUID;
BEGIN
    -- Whitelist: only columns marked show_on_create in metadata.properties
    SELECT array_agg(mp.column_name) INTO v_allowed_cols
    FROM metadata.properties mp
    WHERE mp.table_name = p_target_table
      AND mp.show_on_create = TRUE;

    -- Build INSERT from p_data keys that match allowed columns
    FOR v_col IN SELECT jsonb_object_keys(p_data) LOOP
        IF v_col = ANY(v_allowed_cols) THEN
            v_cols := v_cols || ', ' || quote_ident(v_col);
            v_vals := v_vals || ', ' || quote_literal(p_data->>v_col);
        END IF;
        -- Keys not in whitelist are silently ignored
    END LOOP;

    IF v_cols = '' THEN
        RETURN jsonb_build_object('success', false,
            'message', 'No valid fields provided');
    END IF;

    -- Progressive identity: if visitor is authenticated (check-sso) and
    -- target table has a created_by column, auto-populate it.
    v_user_id := current_user_id();  -- returns NULL for anonymous
    IF v_user_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = p_target_table
          AND column_name = 'created_by'
    ) THEN
        v_cols := v_cols || ', created_by';
        v_vals := v_vals || ', ' || quote_literal(v_user_id::TEXT);
    END IF;

    -- Trim leading comma-space
    v_cols := substring(v_cols FROM 3);
    v_vals := substring(v_vals FROM 3);

    EXECUTE format(
        'INSERT INTO %I (%s) VALUES (%s) RETURNING id::TEXT',
        p_target_table, v_cols, v_vals
    ) INTO v_id;

    RETURN jsonb_build_object('success', true);
END;
$$;
```

**Security**: The column whitelist from `metadata.properties` + `show_on_create` prevents attackers from setting columns like `status_id`, `is_approved`, `assigned_to`. Only explicitly configured columns are writable.

### Anti-Abuse Checker: `_check_public_submit()`

The security core of the framework. Runs all anti-abuse checks in order (cheapest first) and returns a JSONB error if any fail, or NULL to proceed:

```sql
CREATE FUNCTION metadata._check_public_submit(
    v_form     RECORD,    -- metadata.public_forms row
    v_ip       INET,
    v_ua       TEXT,
    v_user_id  UUID
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    v_honeypot   TEXT;
    v_elapsed    INT;
    v_recent     INT;
    v_pow_json   TEXT;
    v_pow        JSONB;
    v_secret     TEXT;
    v_salt_parts TEXT[];
    v_challenge_ts TIMESTAMPTZ;
BEGIN
    -- ── 1. Honeypot check (cheapest — just read a header) ──
    v_honeypot := current_setting('request.header.x-cos-honeypot', true);
    IF v_honeypot IS NOT NULL AND v_honeypot <> '' THEN
        -- Log silently, return success (don't reveal detection to bots)
        INSERT INTO metadata.public_form_submissions
            (table_name, ip_address, user_agent, user_id,
             honeypot_triggered, success)
        VALUES (v_form.table_name, v_ip, v_ua, v_user_id, TRUE, FALSE);
        RETURN jsonb_build_object('success', true,
            'message', COALESCE(v_form.success_message,
                'Thank you for your submission'));
    END IF;

    -- ── 2. Timing check (cheap — parse one header) ──
    v_elapsed := COALESCE(
        NULLIF(current_setting('request.header.x-cos-elapsed', true), '')::INT,
        0);
    IF v_elapsed < v_form.min_submit_seconds THEN
        INSERT INTO metadata.public_form_submissions
            (table_name, ip_address, user_agent, user_id,
             timing_violation, success)
        VALUES (v_form.table_name, v_ip, v_ua, v_user_id, TRUE, FALSE);
        -- Also return fake success to avoid revealing the check
        RETURN jsonb_build_object('success', true,
            'message', COALESCE(v_form.success_message,
                'Thank you for your submission'));
    END IF;

    -- ── 3. Rate limiting (one COUNT query — still cheap) ──
    IF v_ip IS NOT NULL THEN
        SELECT COUNT(*) INTO v_recent
        FROM metadata.public_form_submissions
        WHERE ip_address = v_ip
          AND table_name = v_form.table_name
          AND submitted_at > now() - (v_form.rate_limit_window_min || ' minutes')::INTERVAL
          AND success = TRUE;

        IF v_recent >= v_form.rate_limit_per_ip THEN
            INSERT INTO metadata.public_form_submissions
                (table_name, ip_address, user_agent, user_id,
                 rate_limited, success)
            VALUES (v_form.table_name, v_ip, v_ua, v_user_id, TRUE, FALSE);
            -- Rate limit is explicitly communicated (user needs to know to wait)
            RETURN jsonb_build_object('success', false,
                'message', 'Too many submissions. Please try again later.');
        END IF;
    END IF;

    -- ── 4. Proof-of-work (most expensive — crypto operations) ──
    IF v_form.require_pow THEN
        v_pow_json := current_setting('request.header.x-cos-pow', true);
        IF v_pow_json IS NULL OR v_pow_json = '' THEN
            RETURN jsonb_build_object('success', false,
                'message', 'Verification required');
        END IF;

        v_pow := v_pow_json::JSONB;
        v_secret := current_setting('app.altcha_secret', true);

        -- 4a. TTL check — extract timestamp from salt prefix
        v_salt_parts := string_to_array(v_pow->>'salt', '.');
        BEGIN
            v_challenge_ts := to_timestamp(
                ('x' || v_salt_parts[1])::BIT(48)::BIGINT);
        EXCEPTION WHEN OTHERS THEN
            RETURN jsonb_build_object('success', false,
                'message', 'Verification failed');
        END;
        IF v_challenge_ts < now() - INTERVAL '10 minutes' THEN
            INSERT INTO metadata.public_form_submissions
                (table_name, ip_address, user_agent, user_id,
                 pow_failed, success)
            VALUES (v_form.table_name, v_ip, v_ua, v_user_id, TRUE, FALSE);
            RETURN jsonb_build_object('success', false,
                'message', 'Verification expired. Please refresh and try again.');
        END IF;

        -- 4b. Verify HMAC (proves we issued this challenge)
        IF encode(hmac(v_pow->>'challenge', v_secret, 'sha256'), 'hex')
           <> v_pow->>'signature' THEN
            INSERT INTO metadata.public_form_submissions
                (table_name, ip_address, user_agent, user_id,
                 pow_failed, success)
            VALUES (v_form.table_name, v_ip, v_ua, v_user_id, TRUE, FALSE);
            RETURN jsonb_build_object('success', false,
                'message', 'Verification failed');
        END IF;

        -- 4c. Verify proof-of-work (proves client did the computation)
        IF encode(digest((v_pow->>'salt') || (v_pow->>'number'), 'sha256'), 'hex')
           <> v_pow->>'challenge' THEN
            INSERT INTO metadata.public_form_submissions
                (table_name, ip_address, user_agent, user_id,
                 pow_failed, success)
            VALUES (v_form.table_name, v_ip, v_ua, v_user_id, TRUE, FALSE);
            RETURN jsonb_build_object('success', false,
                'message', 'Verification failed');
        END IF;

        -- 4d. Replay prevention
        IF EXISTS (
            SELECT 1 FROM metadata.public_form_submissions
            WHERE pow_challenge = v_pow->>'challenge' AND success = TRUE
        ) THEN
            RETURN jsonb_build_object('success', false,
                'message', 'Verification expired. Please refresh and try again.');
        END IF;
    END IF;

    -- All checks passed
    RETURN NULL;
END;
$$;
```

**Design notes**:
- Checks run cheapest-first: header read → header parse → COUNT query → crypto operations.
- Honeypot and timing violations return **fake success** — bots should believe their submission worked. This is standard honeypot practice; revealing detection trains bots to adapt.
- Rate limiting returns an **explicit error** — real users need to know they've hit a limit.
- PoW verification returns **explicit errors** — the ALTCHA widget handles retry UX.

### IP Address Helper: `_safe_inet()`

Safely parses `X-Forwarded-For` which may contain multiple comma-separated IPs (`client, proxy1, proxy2`):

```sql
CREATE FUNCTION metadata._safe_inet(p_header TEXT)
RETURNS INET
LANGUAGE plpgsql IMMUTABLE
AS $$
BEGIN
    IF p_header IS NULL OR p_header = '' THEN
        RETURN NULL;
    END IF;
    -- X-Forwarded-For: client, proxy1, proxy2 — take the leftmost (client IP)
    RETURN trim(split_part(p_header, ',', 1))::INET;
EXCEPTION WHEN OTHERS THEN
    RETURN NULL;  -- Malformed header — don't crash the submission
END;
$$;
```

### What the Integrator Never Thinks About

| Concern | Handled by |
|---------|-----------|
| `SECURITY DEFINER` | Generic wrapper — one function, forever |
| `SET search_path` | Generic wrapper |
| Honeypot check | `_check_public_submit()` |
| Timing check | `_check_public_submit()` |
| Rate limiting | `_check_public_submit()` |
| Proof-of-work (ALTCHA) | `_check_public_submit()` |
| Audit logging | Generic wrapper |
| Exception handling | Generic wrapper |
| `EntityActionResult` format | Generic wrapper |
| `GRANT EXECUTE TO web_anon` | Migration — done once |
| Progressive identity | Wrapper reads JWT claims |

---

## 4. Frontend Architecture

### 4.1 Route: `/submit/:formKey`

Outside `profileCompletionGuard`, alongside `/login` and `/logout`:

```typescript
// app.routes.ts — top-level
{
    path: 'submit/:formKey',
    loadComponent: () => import('./pages/public-form/public-form.page')
        .then(m => m.PublicFormPage),
    canActivate: [schemaVersionGuard],  // No authGuard
    data: { publicForm: true }
}
```

### 4.2 Minimal Chrome

`AppComponent` detects `publicForm: true` in route data and renders simplified layout:

- **No sidebar drawer**
- **Minimal navbar** — app title/logo only
- **No profileCompletionGuard** prompt
- Standard `<main>` with `<router-outlet>`

Implementation: `isPublicFormRoute` signal in `AppComponent`, updated on `NavigationEnd`, controls `@if` in template.

### 4.3 PublicFormPage Component

**File**: `src/app/pages/public-form/public-form.page.ts`

**Data flow**:
1. Read `formKey` from route params
2. Fetch form config from `schema_public_forms?table_name=eq.{formKey}`
3. Fetch properties from `SchemaService.getPropsForCreate(formKey)` (reuses existing)
4. Build `FormGroup` with validators from `SchemaService.getFormValidatorsForProperty()`
5. Record `Date.now()` on init for timing check
6. If `require_pow`: render `<altcha-widget>` with `challengeurl` pointing at `get_pow_challenge`
7. Render form: logo, title, description, `EditPropertyComponent` per field, honeypot, ALTCHA widget, submit button

**Page title**: After loading form config, the component calls `Title.setTitle(`${formConfig.display_name} - ${appTitle}`)` for WCAG 2.4.2 compliance. The route does not carry a static `titleKey` since the title is dynamic (comes from the form's `display_name`).

**On submit**:
1. Calculate elapsed time
2. Collect form values into `p_data` JSONB
3. Set headers: `X-Cos-Honeypot`, `X-Cos-Elapsed`, `X-Cos-Pow` (if ALTCHA)
4. POST to `rpc/submit_public_form` with `{ p_form_key, p_data }`
5. Handle `EntityActionResult`: success message, redirect, or field errors

**Key differences from CreatePage**:
- No Keycloak token refresh — may not be authenticated
- No M:M, file upload, gallery, guided form support
- No "View Created Record" — anonymous user can't access it
- Honeypot + ALTCHA widget rendered automatically
- Anti-abuse headers injected automatically
- Minimal layout (no breadcrumbs, no back-to-list)
- "Submit Another" button on success

### 4.4 Honeypot

```html
<!-- Off-screen, not display:none or visibility:hidden (bots detect CSS hiding) -->
<div class="absolute -start-[9999px]" aria-hidden="true">
  <label [for]="'hp-' + formKey()">Website</label>
  <input [id]="'hp-' + formKey()" type="text"
         tabindex="-1"
         autocomplete="off"
         [formControlName]="formConfig()?.honeypot_field ?? 'contact_website'" />
</div>
```

- **Off-screen positioning** (not `display:none` — bots detect that)
- **`aria-hidden="true"`** excludes from screen readers
- **`tabindex="-1"`** prevents keyboard navigation into the field
- **`autocomplete="off"`** prevents browser autofill false positives
- **Label says "Website"** — bots parse labels to decide what to fill; a URL-shaped label is irresistible
- **Default field name `contact_website`** — plausible on any civic form, unlikely to collide with a real field, configurable per form via `metadata.public_forms.honeypot_field`

### 4.5 SchemaService Additions

- `getPublicFormConfig(formKey: string): Observable<PublicFormConfig | null>` — fetches `schema_public_forms`
- `getRpcParams(functionName: string): Observable<RpcParam[]>` — shared infrastructure, also used by Custom Pages

### 4.6 DataService Addition

- `callRpcWithHeaders(name, params, headers): Observable<any>` — like `callRpc()` but accepts custom headers for anti-abuse

### 4.7 Translation Keys

Under `public_form.*`: `not_available`, `submit`, `submitting`, `success`, `success_default`, `submit_another`, `rate_limited`, `error`, `fix_errors`, `pow_solving`, `pow_required`.

---

## 5. Open Question Resolutions

**Q1 (Mechanism)**: RPC-mediated (5b). Single generic wrapper, not per-form RPCs. See Approach Comparison section.

**Q2 (Rate-limit table)**: `metadata.public_form_submissions` keyed on `(ip_address, table_name, submitted_at)`. Shared infrastructure for anonymous submit and future kiosk seam. Store IP from `X-Forwarded-For`. No device fingerprinting.

**Q3 (Audit attribution)**: Wrapper reads JWT claims directly via `current_setting('request.jwt.claims')`. No synthetic principal needed — `user_id` is populated when authenticated (progressive identity), NULL when anonymous.

**Q4 (CAPTCHA)**: **ALTCHA proof-of-work as built-in.** Zero external dependencies, verified in SQL via `pgcrypto`. No third-party JS, no hosted service, MIT license, WCAG 2.2 AA certified. Turnstile/hCaptcha remain documented as opt-in alternatives for instances that want behavior-based analysis.

**Q5 (Consent)**: Instance-level, not framework-level. The submit RPC (Tier 2 custom) can insert a consent record. No framework consent table.

**Q6 (KB concept)**: This design doc → `docs/notes/ANONYMOUS_PUBLIC_SUBMIT_DESIGN.md`. Promote to Decision Record after implementation.

---

## 6. SECURITY DEFINER Exception Documentation

Create `docs/development/SECURITY_DEFINER_EXCEPTIONS.md`:

1. **Permission-check functions** (`has_permission`, `is_admin`, `get_user_roles`): Need DEFINER to read metadata tables.
2. **Public submit wrapper** (`submit_public_form`): Needs DEFINER because `web_anon` has no INSERT grants. Single chokepoint with built-in anti-abuse and audit.
3. **PoW challenge generator** (`get_pow_challenge`): Needs DEFINER to read the HMAC secret from Instance Config Store.

---

## 7. Dependencies

| Dependency | Status | Fallback |
|-----------|--------|----------|
| Instance Config Store | Planned | PostgreSQL GUC (`app.altcha_secret`) |
| `pgcrypto` extension | Already installed | Required for PoW; no fallback |
| Custom Pages | Not yet implemented | **Not a dependency** — shares `schema_rpc_parameters` but builds independently |
| Kiosk seam | KB concept only | **Not a dependency** — sibling seam, shares `public_form_submissions` table shape |
| ALTCHA npm package | Available | Widget loaded from npm; can self-host the JS as a static asset |

---

## 8. Phasing

### Phase 1: Core Framework
- Migration: tables, views, grants, `submit_public_form()`, `_check_public_submit()`, `_auto_insert_public_form()`, `get_pow_challenge()`
- Frontend: `PublicFormPage`, route, minimal chrome, `SchemaService` additions, ALTCHA widget integration
- Docs: `ANONYMOUS_PUBLIC_SUBMIT_DESIGN.md`, Integrator Guide section, CLAUDE.md update, `SECURITY_DEFINER_EXCEPTIONS.md`
- Tests: unit tests, functional test with example form

### Phase 2: Admin & Observability
- Admin page at `/admin/public-forms`
- Submission analytics and audit log viewer
- PoW difficulty tuning per form

### Phase 3: Enhanced Features
- File upload for anonymous forms (presigned URL generation)
- Embeddable iframe mode
- Caddy `rate_limit` module (defense-in-depth)
- Turnstile/hCaptcha as alternative CAPTCHA providers

---

## 9. Verification

### Unit Tests
- `PublicFormPage`: form build, honeypot, timing, submit flow, success/error, PoW widget conditional rendering
- `SchemaService`: `getPublicFormConfig()`, `getRpcParams()`
- `AppComponent`: minimal chrome detection

### Docker Migration
```bash
docker compose down -v && docker compose up -d
psql -c "SELECT * FROM metadata.public_forms LIMIT 0;"
psql -c "SELECT * FROM schema_public_forms LIMIT 0;"
psql -c "SELECT * FROM schema_rpc_parameters LIMIT 1;"
```

### PostgREST (curl, no auth)
```bash
# Config accessible
curl -s localhost:3000/schema_public_forms
# PoW challenge generation
curl -s -X POST localhost:3000/rpc/get_pow_challenge \
    -H "Content-Type: application/json" \
    -d '{"p_form_key":"issue_report"}'
# Submit without auth (Tier 0)
curl -s -X POST localhost:3000/rpc/submit_public_form \
    -H "Content-Type: application/json" \
    -d '{"p_form_key":"issue_report","p_data":{"display_name":"Test","description":"Main St"}}'
# Rate limiting (submit 11 times rapidly)
```

### Playwright
1. Navigate to `/submit/issue_report` (no login)
2. Verify minimal chrome
3. Fill and submit
4. Verify success message
5. Verify record created (admin view)
6. Test with PoW enabled — verify widget renders and solves

---

## 10. Resolved Gaps

These items were identified during design review and resolved in this specification:

1. **~~PoW replay column overloading~~** → **Resolved**: Added dedicated `pow_challenge` column to `public_form_submissions`. `form_data_hash` stores the payload hash; `pow_challenge` stores the ALTCHA challenge string for replay prevention.

2. **~~`_check_public_submit()` implementation missing~~** → **Resolved**: Full SQL body now in Section 3 (Anti-Abuse Checker). Runs four checks cheapest-first: honeypot → timing → rate limit → PoW.

3. **~~`_safe_inet()` helper missing~~** → **Resolved**: Full SQL body now in Section 3. Parses leftmost IP from `X-Forwarded-For`, handles malformed headers gracefully.

4. **~~PoW challenge expiry (no TTL)~~** → **Resolved**: Salt now embeds a Unix timestamp prefix. Verifier rejects challenges older than 10 minutes. Timestamp is inside the HMAC-signed payload so it cannot be tampered with.

5. **~~i18n for form metadata strings~~** → **Resolved**: `schema_public_forms` VIEW now wraps `display_name`, `description`, `submit_label`, `success_message`, and `footer_markdown` with `metadata.t()` using source type `public_form`.

6. **~~Page title for public form routes~~** → **Resolved**: `PublicFormPage` calls `Title.setTitle()` after loading form config, documented in Section 4.3.

7. **~~`web_anon` access to schema metadata~~** → **Verified**: `web_anon` already has SELECT on `schema_entities`, `schema_properties`, and `schema_cache_versions` (baseline migration). `schemaVersionGuard` does not require authentication.

8. **~~Per-form permission rows~~** → **Resolved**: Section 1.6 now documents that integrators must INSERT `anonymous` + `read` rows into `metadata.permissions` for both the target entity and any FK target tables.

9. **~~`validate_rpc` / `custom_submit_rpc` mutual exclusion~~** → **Resolved**: Both CAN be set simultaneously. This is intentional — `validate_rpc` runs first (after anti-abuse), then `custom_submit_rpc` handles the write. This lets integrators reuse a common validator across multiple custom submit paths.

## 11. Additional Resolved Decisions

These were resolved during final design review:

10. **~~Auto-INSERT type casting~~** → **Keep `quote_literal()`**: PostgreSQL's implicit text-to-column casting handles all types used in civic intake forms (integers, booleans, UUIDs, dates, text). `jsonb_populate_record()` adds complexity for no practical benefit in this context.

11. **~~Progressive identity on auto-INSERT~~** → **Yes, auto-detect**: `_auto_insert_public_form()` now checks `current_user_id()` and, if non-NULL and the target table has a `created_by` column, auto-populates it. Transparent to integrators, consistent with CreatePage behavior.

12. **~~Server-side `metadata.validations` enforcement~~** → **Not needed**: Frontend enforces `metadata.validations` rules; DB CHECK constraints are the server-side safety net. The wrapper now surfaces constraint violations (CHECK, NOT NULL, UNIQUE, FK) as SQLERRM in the response, which the frontend's `ErrorService.parseToHuman()` translates via `metadata.constraint_messages`. This is consistent with how CreatePage works — no third validation layer needed.

13. **~~FK dropdown data exposure~~** → **Document, don't enforce**: Section 1.6 documents the integrator's responsibility to only grant `web_anon` SELECT on FK target tables appropriate for public exposure. Framework guardrails would add complexity for a low-probability misconfiguration. The `show_on_create = FALSE` pattern on internal FK properties is sufficient guidance.

---

## Critical Files

| File | Change |
|------|--------|
| `postgres/migrations/deploy/v0-XX-0-anonymous-public-submit.sql` | New migration |
| `src/app/app.routes.ts` | `/submit/:formKey` outside profileCompletionGuard |
| `src/app/app.component.ts` + `.html` | Minimal chrome conditional |
| `src/app/pages/public-form/public-form.page.ts` | New page component |
| `src/app/services/schema.service.ts` | `getRpcParams()`, `getPublicFormConfig()` |
| `src/app/services/data.service.ts` | `callRpcWithHeaders()` |
| `src/app/interfaces/public-form.ts` | New interface |
| `docs/notes/ANONYMOUS_PUBLIC_SUBMIT_DESIGN.md` | Design doc |
| `docs/development/SECURITY_DEFINER_EXCEPTIONS.md` | Convention doc |
| `CLAUDE.md` | Index entry |
