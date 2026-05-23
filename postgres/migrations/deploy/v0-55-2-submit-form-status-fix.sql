-- Deploy civic_os:v0-55-2-submit-form-status-fix to pg
-- requires: v0-55-0-photo-gallery-action-param

BEGIN;


-- ============================================================================
-- PART A: HYBRID SEARCH — pg_trgm + Full-Text Search
-- ============================================================================
-- Replaces name_search_tokens() (manual trigram reimplementation) with native
-- pg_trgm extension for substring matching. Adds two explicit metadata columns
-- (fulltext_search_column, substring_search_column) so the frontend constructs
-- hybrid or=() PostgREST queries combining FTS (word-boundary) with ILIKE
-- (substring). This enables autocomplete-style search ("iel" → "Daniel").


-- A1. Enable pg_trgm extension (already in Docker image, explicit for portability)

CREATE EXTENSION IF NOT EXISTS pg_trgm;


-- A2. DROP name_search_tokens — replaced by pg_trgm ILIKE

DROP FUNCTION IF EXISTS public.name_search_tokens(TEXT);


-- A3. DROP civic_os_users VIEW (CASCADE to dependent views)

DROP VIEW IF EXISTS public.civic_os_users CASCADE;


-- A4. RECREATE civic_os_users VIEW — simplified tsvector without name_search_tokens
-- Substring matching now handled by ILIKE on display_name (via pg_trgm index).
-- FTS tsvector retains display_name, email, phone tokens for multi-word search.

CREATE VIEW public.civic_os_users AS
SELECT
  u.id,
  u.display_name,
  u.created_at,
  u.updated_at,
  CASE
    WHEN u.id = public.current_user_id()
         OR public.has_permission('civic_os_users_private', 'read')
    THEN p.display_name
    ELSE NULL
  END AS full_name,
  CASE
    WHEN u.id = public.current_user_id()
         OR public.has_permission('civic_os_users_private', 'read')
    THEN p.email
    ELSE NULL
  END AS email,
  CASE
    WHEN u.id = public.current_user_id()
         OR public.has_permission('civic_os_users_private', 'read')
    THEN p.phone
    ELSE NULL
  END AS phone,
  CASE
    WHEN u.id = public.current_user_id()
         OR public.has_permission('civic_os_users_private', 'read')
    THEN to_tsvector('english',
      COALESCE(u.display_name, '') || ' ' ||
      COALESCE(p.display_name, '') || ' ' ||
      COALESCE(replace(replace(p.email::text, '@', ' '), '.', ' '), '') || ' ' ||
      CASE WHEN p.phone ~ '^\d{10}$'
           THEN phone_search_tokens(p.phone::phone_number)
           ELSE COALESCE(p.phone::text, '') END)
    ELSE to_tsvector('english', COALESCE(u.display_name, ''))
  END AS civic_os_text_search
FROM metadata.civic_os_users u
LEFT JOIN metadata.civic_os_users_private p ON p.id = u.id;

ALTER VIEW public.civic_os_users SET (security_invoker = true);

GRANT SELECT ON public.civic_os_users TO web_anon, authenticated;


-- A5. GIN trgm index on civic_os_users_private.display_name
-- Accelerates FK search modal ILIKE queries for user lookup.

CREATE INDEX IF NOT EXISTS idx_cup_display_name_trgm
    ON metadata.civic_os_users_private USING gin (display_name gin_trgm_ops);


-- A6. RECREATE payment_transactions VIEW (dropped by CASCADE)
-- Restored from v0-50-1-phone-search-tokens (verbatim)

CREATE VIEW public.payment_transactions AS
SELECT
    t.id,
    t.user_id,
    u.display_name AS user_display_name,
    u.full_name AS user_full_name,
    u.email AS user_email,
    t.amount,
    t.processing_fee,
    t.total_amount,
    t.max_refundable,
    t.fee_percent,
    t.fee_flat_cents,
    t.fee_refundable,
    t.currency,
    t.status,
    t.provider_payment_id,
    COALESCE(r_agg.total_refunded, 0) AS total_refunded,
    COALESCE(r_agg.refund_count, 0) AS refund_count,
    COALESCE(r_agg.pending_count, 0) AS pending_refund_count,
    CASE
        WHEN r_agg.total_refunded >= t.max_refundable THEN 'refunded'
        WHEN r_agg.total_refunded > 0 THEN 'partially_refunded'
        WHEN r_agg.pending_count > 0 THEN 'refund_pending'
        ELSE COALESCE(t.status, 'unpaid')
    END AS effective_status,
    t.error_message,
    t.provider,
    t.provider_client_secret,
    t.description,
    t.display_name,
    t.created_at,
    t.updated_at,
    t.entity_type,
    t.entity_id,
    COALESCE(e.display_name, t.entity_type) AS entity_display_name
FROM payments.transactions t
LEFT JOIN public.civic_os_users u ON t.user_id = u.id
LEFT JOIN metadata.entities e ON t.entity_type = e.table_name
LEFT JOIN LATERAL (
    SELECT
        COALESCE(SUM(amount) FILTER (WHERE status = 'succeeded'), 0) AS total_refunded,
        COUNT(*) FILTER (WHERE status = 'succeeded') AS refund_count,
        COUNT(*) FILTER (WHERE status = 'pending') AS pending_count
    FROM payments.refunds
    WHERE transaction_id = t.id
) r_agg ON true;

GRANT SELECT ON public.payment_transactions TO authenticated, web_anon;


-- A7. RECREATE payment_refunds VIEW (dropped by CASCADE)
-- Restored from v0-50-1-phone-search-tokens (verbatim)

CREATE VIEW public.payment_refunds AS
SELECT
    r.id,
    r.transaction_id,
    r.amount,
    r.reason,
    r.initiated_by,
    u.display_name AS initiated_by_name,
    r.provider_refund_id,
    r.status,
    r.error_message,
    r.created_at,
    r.processed_at,
    t.amount AS payment_amount,
    t.description AS payment_description,
    t.provider_payment_id
FROM payments.refunds r
LEFT JOIN public.civic_os_users u ON r.initiated_by = u.id
LEFT JOIN payments.transactions t ON r.transaction_id = t.id;

GRANT SELECT ON public.payment_refunds TO authenticated;


-- A8. Add metadata columns for hybrid search configuration

ALTER TABLE metadata.entities ADD COLUMN IF NOT EXISTS fulltext_search_column NAME;
ALTER TABLE metadata.entities ADD COLUMN IF NOT EXISTS substring_search_column NAME;

COMMENT ON COLUMN metadata.entities.fulltext_search_column IS
    'Column name containing tsvector for full-text search (e.g., civic_os_text_search). '
    'Frontend uses this with PostgREST wfts operator. NULL = no FTS.';

COMMENT ON COLUMN metadata.entities.substring_search_column IS
    'Column name for ILIKE substring search (e.g., display_name). '
    'Frontend uses this with PostgREST ilike operator. NULL = no substring search. '
    'Recommended: add a GIN trgm index on the column for large tables.';


-- A9. Data migration — auto-populate fulltext_search_column for entities
-- that already have search_fields configured (backward compat)

UPDATE metadata.entities
SET fulltext_search_column = 'civic_os_text_search'
WHERE search_fields IS NOT NULL AND array_length(search_fields, 1) > 0
  AND fulltext_search_column IS NULL;


-- A10. Update schema_entities VIEW to expose new columns

CREATE OR REPLACE VIEW public.schema_entities AS
SELECT
    COALESCE(entities.display_name, tables.table_name::text) AS display_name,
    COALESCE(entities.sort_order, 0) AS sort_order,
    entities.description,
    entities.search_fields,
    COALESCE(entities.show_map, false) AS show_map,
    entities.map_property_name,
    tables.table_name,
    has_permission(tables.table_name::text, 'create'::text) AS insert,
    has_permission(tables.table_name::text, 'read'::text) AS "select",
    has_permission(tables.table_name::text, 'update'::text) AS update,
    has_permission(tables.table_name::text, 'delete'::text) AS delete,
    COALESCE(entities.show_calendar, false) AS show_calendar,
    entities.calendar_property_name,
    entities.calendar_color_property,
    entities.payment_initiation_rpc,
    entities.payment_capture_mode,
    COALESCE(entities.enable_notes, false) AS enable_notes,
    COALESCE(entities.supports_recurring, false) AS supports_recurring,
    entities.recurring_property_name,
    (tables.table_type::text = 'VIEW'::text) AS is_view,
    entities.guided_form_key,
    COALESCE(entities.show_in_sidebar, true) AS show_in_sidebar,
    entities.map_color_property,
    COALESCE(entities.is_rich_junction, false) AS is_rich_junction,
    entities.fulltext_search_column,
    entities.substring_search_column
FROM information_schema.tables
LEFT JOIN metadata.entities ON entities.table_name = tables.table_name::name
WHERE tables.table_schema::name = 'public'::name
  AND tables.table_type::text IN ('BASE TABLE', 'VIEW')
  AND (tables.table_type::text = 'BASE TABLE' OR entities.table_name IS NOT NULL)
  AND NOT (
    tables.table_type::text = 'VIEW' AND (
      tables.table_name::text LIKE 'schema_%'
      OR tables.table_name::text IN (
        'time_slot_series', 'time_slot_instances', 'civic_os_users', 'managed_users',
        'gallery_admin', 'photo_galleries', 'photo_gallery_files', 'photo_gallery_config'
      )
    )
  )
ORDER BY (COALESCE(entities.sort_order, 0)), tables.table_name;

COMMENT ON VIEW public.schema_entities IS
    'Entity metadata view. Updated in v0.55.2 to add fulltext_search_column and '
    'substring_search_column for hybrid FTS+ILIKE search.';


-- A11. Update upsert_entity_metadata to accept new params
-- Must drop old 15-param signature first — PostgreSQL treats different param counts
-- as separate overloads, not replacements.

DROP FUNCTION IF EXISTS public.upsert_entity_metadata(NAME, TEXT, TEXT, INT, TEXT[], BOOLEAN, TEXT, BOOLEAN, TEXT, TEXT, BOOLEAN, BOOLEAN, TEXT, BOOLEAN, TEXT);

CREATE OR REPLACE FUNCTION public.upsert_entity_metadata(
  p_table_name NAME,
  p_display_name TEXT,
  p_description TEXT,
  p_sort_order INT,
  p_search_fields TEXT[] DEFAULT NULL,
  p_show_map BOOLEAN DEFAULT FALSE,
  p_map_property_name TEXT DEFAULT NULL,
  p_show_calendar BOOLEAN DEFAULT FALSE,
  p_calendar_property_name TEXT DEFAULT NULL,
  p_calendar_color_property TEXT DEFAULT NULL,
  p_enable_notes BOOLEAN DEFAULT FALSE,
  p_supports_recurring BOOLEAN DEFAULT FALSE,
  p_recurring_property_name TEXT DEFAULT NULL,
  p_show_in_sidebar BOOLEAN DEFAULT TRUE,
  p_map_color_property TEXT DEFAULT NULL,
  p_fulltext_search_column NAME DEFAULT NULL,
  p_substring_search_column NAME DEFAULT NULL
)
RETURNS void AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  INSERT INTO metadata.entities (
    table_name, display_name, description, sort_order,
    search_fields, show_map, map_property_name,
    show_calendar, calendar_property_name, calendar_color_property,
    enable_notes, supports_recurring, recurring_property_name,
    show_in_sidebar, map_color_property,
    fulltext_search_column, substring_search_column
  )
  VALUES (
    p_table_name, p_display_name, p_description, p_sort_order,
    p_search_fields, p_show_map, p_map_property_name,
    p_show_calendar, p_calendar_property_name, p_calendar_color_property,
    p_enable_notes, p_supports_recurring, p_recurring_property_name,
    p_show_in_sidebar, p_map_color_property,
    p_fulltext_search_column, p_substring_search_column
  )
  ON CONFLICT (table_name) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    description = EXCLUDED.description,
    sort_order = EXCLUDED.sort_order,
    search_fields = COALESCE(EXCLUDED.search_fields, metadata.entities.search_fields),
    show_map = EXCLUDED.show_map,
    map_property_name = EXCLUDED.map_property_name,
    show_calendar = EXCLUDED.show_calendar,
    calendar_property_name = EXCLUDED.calendar_property_name,
    calendar_color_property = EXCLUDED.calendar_color_property,
    enable_notes = EXCLUDED.enable_notes,
    supports_recurring = EXCLUDED.supports_recurring,
    recurring_property_name = EXCLUDED.recurring_property_name,
    show_in_sidebar = EXCLUDED.show_in_sidebar,
    map_color_property = EXCLUDED.map_color_property,
    fulltext_search_column = COALESCE(EXCLUDED.fulltext_search_column, metadata.entities.fulltext_search_column),
    substring_search_column = COALESCE(EXCLUDED.substring_search_column, metadata.entities.substring_search_column);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION public.upsert_entity_metadata IS
  'Insert or update entity metadata. Admin only. Updated in v0.55.2 to add '
  'fulltext_search_column and substring_search_column for hybrid search.';

GRANT EXECUTE ON FUNCTION public.upsert_entity_metadata(NAME, TEXT, TEXT, INT, TEXT[], BOOLEAN, TEXT, BOOLEAN, TEXT, TEXT, BOOLEAN, BOOLEAN, TEXT, BOOLEAN, TEXT, NAME, NAME) TO authenticated;


-- ============================================================================
-- PART B: COLUMN-AGNOSTIC GUIDED FORM STATUS
-- ============================================================================
-- The guided form framework originally auto-created a `status_id` column on
-- parent/step tables for lifecycle tracking (draft → complete → submitted).
-- v0.55.2 renames this to `guided_form_status_id` to free `status_id` for
-- business workflow use by integrators.
--
-- STRATEGY: Core functions become column-agnostic — they detect whether the
-- table has `guided_form_status_id` or `status_id` and use whatever exists.
-- The actual rename happens in instance-specific init scripts (e.g., NEH
-- script 29) AFTER all other init scripts have completed. This avoids
-- breaking init scripts that reference `status_id` in trigger DDL.
--
-- On existing deployments (upgrade path), the rename can be applied via
-- a one-time migration script that runs ALTER TABLE RENAME COLUMN.


-- ============================================================================
-- 1. Helper: _gf_status_col(table_name) → column name
-- ============================================================================
-- Returns the GF lifecycle status column name for a given table.
-- Prefers `guided_form_status_id` (new name); falls back to `status_id` (old).

CREATE OR REPLACE FUNCTION public._gf_status_col(p_table_name NAME)
RETURNS NAME
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_catalog
AS $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = p_table_name
          AND column_name = 'guided_form_status_id'
    ) THEN
        RETURN 'guided_form_status_id';
    ELSIF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = p_table_name
          AND column_name = 'status_id'
    ) THEN
        RETURN 'status_id';
    ELSE
        RETURN NULL;
    END IF;
END;
$$;

COMMENT ON FUNCTION public._gf_status_col(NAME) IS
    'Internal helper: returns the GF lifecycle status column name for a table. '
    'Prefers guided_form_status_id (v0.55.2+), falls back to status_id (pre-v0.55.2).';


-- ============================================================================
-- 2. FUNCTION: metadata.enforce_guided_form_lock()
-- ============================================================================
-- Column-agnostic: uses to_jsonb() to access OLD/NEW dynamically.

CREATE OR REPLACE FUNCTION metadata.enforce_guided_form_lock()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    v_locked_field NAME;
    v_old_value TEXT;
    v_new_value TEXT;
    v_old_status_key TEXT;
    v_new_status_key TEXT;
    v_gf_col NAME;
    v_old_status_id INT;
    v_new_status_id INT;
BEGIN
    -- Users with update permission on this table bypass the lock
    IF public.has_permission(TG_TABLE_NAME::TEXT, 'update') THEN RETURN NEW; END IF;

    -- Determine GF status column name dynamically
    v_gf_col := public._gf_status_col(TG_TABLE_NAME);
    IF v_gf_col IS NULL THEN RETURN NEW; END IF;

    -- Extract status IDs via jsonb for column-agnostic access
    v_old_status_id := (to_jsonb(OLD)->>v_gf_col)::INT;
    v_new_status_id := (to_jsonb(NEW)->>v_gf_col)::INT;

    -- Look up status keys
    SELECT status_key INTO v_old_status_key FROM metadata.statuses WHERE id = v_old_status_id;
    SELECT status_key INTO v_new_status_key FROM metadata.statuses WHERE id = v_new_status_id;

    -- Parent GF status follows a forward-only lifecycle: draft → complete → submitted.
    -- Block any reversion from 'complete' except the legitimate forward transition
    -- to 'submitted' (used by submit_guided_form / auto-submit).
    IF v_old_status_key = 'complete' AND v_new_status_key NOT IN ('complete', 'submitted') THEN
        RAISE EXCEPTION 'Cannot revert status from complete to draft on %', TG_TABLE_NAME
            USING ERRCODE = 'check_violation';
    END IF;

    -- Only lock condition fields when form lifecycle is 'complete'
    IF v_old_status_key != 'complete' THEN RETURN NEW; END IF;

    -- Check each condition field for changes using jsonb for dynamic field access
    FOR v_locked_field IN
        SELECT DISTINCT wsc.field
        FROM metadata.guided_forms w
        JOIN metadata.guided_form_steps ws ON ws.guided_form_key = w.guided_form_key
        JOIN metadata.guided_form_step_conditions wsc ON wsc.guided_form_step_id = ws.id
        WHERE w.parent_table = TG_TABLE_NAME
    LOOP
        EXECUTE format('SELECT to_jsonb($1)->>%L', v_locked_field) INTO v_old_value USING OLD;
        EXECUTE format('SELECT to_jsonb($1)->>%L', v_locked_field) INTO v_new_value USING NEW;
        IF v_old_value IS DISTINCT FROM v_new_value THEN
            RAISE EXCEPTION 'Field % is locked while guided form step is complete', v_locked_field
                USING ERRCODE = 'check_violation';
        END IF;
    END LOOP;

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION metadata.enforce_guided_form_lock() IS
    'Trigger function: enforces forward-only status lifecycle (draft → complete → submitted) '
    'and locks condition fields on guided form parent tables once form is complete. '
    'complete → submitted is allowed for auto-submit. '
    'Users with update permission on the table bypass the lock. '
    'v0.55.2: column-agnostic via _gf_status_col() — works with both status_id and guided_form_status_id.';


-- ============================================================================
-- 3. FUNCTION: metadata.rebuild_guided_form_constraints()
-- ============================================================================
-- Column-agnostic: uses _gf_status_col() to detect column name.

CREATE OR REPLACE FUNCTION metadata.rebuild_guided_form_constraints(p_table_name NAME)
RETURNS TABLE(action TEXT, detail TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = metadata, public, pg_catalog
AS $$
DECLARE
    v_validation RECORD;
    v_constraint_name NAME;
    v_constraint_sql TEXT;
    v_dropped INT := 0;
    v_created INT := 0;
    v_not_valid INT := 0;
    v_has_rows BOOLEAN;
    v_gf_status_col NAME;
BEGIN
    -- Guard: skip tables that aren't part of any guided form
    IF NOT EXISTS (
        SELECT 1 FROM metadata.guided_form_steps WHERE step_table = p_table_name
    ) AND NOT EXISTS (
        SELECT 1 FROM metadata.guided_forms WHERE parent_table = p_table_name
    ) THEN
        RETURN;
    END IF;

    -- Determine GF status column name dynamically
    v_gf_status_col := public._gf_status_col(p_table_name);
    IF v_gf_status_col IS NULL THEN
        RAISE EXCEPTION 'Table % does not have a guided form status column', p_table_name;
    END IF;

    -- Reliable check for existing rows
    EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I)', p_table_name) INTO v_has_rows;

    -- Drop stale auto-generated constraints
    FOR v_constraint_name IN
        SELECT con.conname FROM pg_constraint con
        JOIN pg_class cls ON cls.oid = con.conrelid
        WHERE cls.relname = p_table_name AND con.contype = 'c'
          AND con.conname ~ ('^' || p_table_name || '_.*_wfcheck$')
    LOOP
        EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', p_table_name, v_constraint_name);
        v_dropped := v_dropped + 1;
    END LOOP;

    -- Recreate from metadata.validations using the detected status column
    FOR v_validation IN
        SELECT v.column_name, v.validation_type, v.validation_value, v.error_message
        FROM metadata.validations v
        WHERE v.table_name = p_table_name
        ORDER BY v.sort_order
    LOOP
        v_constraint_name := format('%s_%s_%s_wfcheck',
            p_table_name, v_validation.column_name, v_validation.validation_type);

        CASE v_validation.validation_type
            WHEN 'required' THEN
                v_constraint_sql := format(
                    'ALTER TABLE %I ADD CONSTRAINT %I CHECK (public.is_guided_form_draft(%I) OR %I IS NOT NULL)',
                    p_table_name, v_constraint_name, v_gf_status_col, v_validation.column_name);
            WHEN 'min' THEN
                v_constraint_sql := format(
                    'ALTER TABLE %I ADD CONSTRAINT %I CHECK (public.is_guided_form_draft(%I) OR %I >= %L::numeric)',
                    p_table_name, v_constraint_name, v_gf_status_col, v_validation.column_name, v_validation.validation_value);
            WHEN 'max' THEN
                v_constraint_sql := format(
                    'ALTER TABLE %I ADD CONSTRAINT %I CHECK (public.is_guided_form_draft(%I) OR %I <= %L::numeric)',
                    p_table_name, v_constraint_name, v_gf_status_col, v_validation.column_name, v_validation.validation_value);
            WHEN 'minLength' THEN
                v_constraint_sql := format(
                    'ALTER TABLE %I ADD CONSTRAINT %I CHECK (public.is_guided_form_draft(%I) OR LENGTH(%I::text) >= %L::int)',
                    p_table_name, v_constraint_name, v_gf_status_col, v_validation.column_name, v_validation.validation_value);
            WHEN 'maxLength' THEN
                v_constraint_sql := format(
                    'ALTER TABLE %I ADD CONSTRAINT %I CHECK (public.is_guided_form_draft(%I) OR LENGTH(%I::text) <= %L::int)',
                    p_table_name, v_constraint_name, v_gf_status_col, v_validation.column_name, v_validation.validation_value);
            WHEN 'pattern' THEN
                v_constraint_sql := format(
                    'ALTER TABLE %I ADD CONSTRAINT %I CHECK (public.is_guided_form_draft(%I) OR %I::text ~ %L)',
                    p_table_name, v_constraint_name, v_gf_status_col, v_validation.column_name, v_validation.validation_value);
            ELSE
                CONTINUE;
        END CASE;

        IF v_has_rows THEN
            v_constraint_sql := v_constraint_sql || ' NOT VALID';
            v_not_valid := v_not_valid + 1;
        END IF;

        BEGIN
            EXECUTE v_constraint_sql;
            v_created := v_created + 1;

            INSERT INTO metadata.constraint_messages
                (constraint_name, table_name, column_name, error_message)
            VALUES (v_constraint_name, p_table_name, v_validation.column_name, v_validation.error_message)
            ON CONFLICT (constraint_name) DO UPDATE SET
                error_message = EXCLUDED.error_message,
                updated_at = NOW();

            IF v_has_rows THEN
                BEGIN
                    EXECUTE format('ALTER TABLE %I VALIDATE CONSTRAINT %I', p_table_name, v_constraint_name);
                EXCEPTION WHEN check_violation THEN
                    RETURN QUERY SELECT 'WARNING'::TEXT,
                        format('Constraint %s on %s could not be validated against existing rows (grandfathered)',
                               v_constraint_name, p_table_name);
                END;
            END IF;
        EXCEPTION WHEN duplicate_object THEN
            NULL;
        END;
    END LOOP;

    RETURN QUERY SELECT 'SUMMARY'::TEXT,
        format('Dropped %s, Created %s (%s NOT VALID) constraints for %s',
               v_dropped, v_created, v_not_valid, p_table_name);
END;
$$;

COMMENT ON FUNCTION metadata.rebuild_guided_form_constraints(NAME) IS
    'Idempotently rebuilds conditional CHECK constraints for a guided form step table '
    'from metadata.validations. Uses NOT VALID for existing rows. '
    'v0.55.2: column-agnostic via _gf_status_col().';


-- ============================================================================
-- 4. RPC: register_guided_form()
-- ============================================================================
-- Column-agnostic: detects and uses existing column name. Does NOT rename.
-- If neither column exists, adds `status_id` for backward compatibility with
-- init scripts that reference it in trigger DDL.

CREATE OR REPLACE FUNCTION public.register_guided_form(
    p_guided_form_key            NAME,
    p_parent_table            NAME,
    p_description             TEXT DEFAULT NULL,
    p_on_submit_rpc           NAME DEFAULT NULL,
    p_parent_step_display_name VARCHAR(100) DEFAULT 'Application Details',
    p_review_intro_text       TEXT DEFAULT NULL,
    p_lock_on_submit          BOOLEAN DEFAULT FALSE,
    p_precondition_rpc        NAME DEFAULT NULL,
    p_ownership_column        NAME DEFAULT 'created_by'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = metadata, public, pg_catalog
AS $$
DECLARE
    v_pk_column TEXT;
    v_pk_type   TEXT;
    v_gf_col    NAME;
BEGIN
    -- Admin guard: only admins (or superusers running init scripts) can register guided forms
    IF NOT (public.is_admin() OR current_setting('is_superuser', true) = 'on') THEN
        RAISE EXCEPTION 'Admin access required';
    END IF;

    -- Validate parent table exists
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = p_parent_table
    ) THEN
        RETURN jsonb_build_object('success', false, 'message', format('Parent table %s does not exist', p_parent_table));
    END IF;

    -- Detect or create GF status column. Do NOT rename — init scripts may still reference status_id.
    v_gf_col := public._gf_status_col(p_parent_table);
    IF v_gf_col IS NULL THEN
        -- Neither column exists; add status_id for backward compat with init script trigger DDL
        EXECUTE format(
            'ALTER TABLE public.%I ADD COLUMN status_id INTEGER REFERENCES metadata.statuses(id)',
            p_parent_table
        );
        v_gf_col := 'status_id';
    END IF;
    -- Ensure DEFAULT is set
    EXECUTE format(
        'ALTER TABLE public.%I ALTER COLUMN %I SET DEFAULT public.get_initial_status(''guided_form'')',
        p_parent_table, v_gf_col
    );
    -- Index for FK lookups and filtered queries
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%I_gf_status_id ON public.%I (%I)', p_parent_table, p_parent_table, v_gf_col);

    INSERT INTO metadata.properties (table_name, column_name, display_name, sort_order,
        show_on_list, show_on_create, show_on_edit, show_on_detail, filterable, status_entity_type)
    VALUES (p_parent_table, v_gf_col, 'Form Status', -10,
        false, false, false, false, false, 'guided_form')
    ON CONFLICT (table_name, column_name) DO UPDATE
      SET status_entity_type = 'guided_form',
          show_on_list = false, show_on_detail = false,
          show_on_create = false, show_on_edit = false;

    -- Validate ownership column exists on parent table (if specified)
    IF p_ownership_column IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = p_parent_table AND column_name = p_ownership_column
        ) THEN
            RETURN jsonb_build_object('success', false, 'message', format('Parent table %s must have an ownership column %s (UUID)', p_parent_table, p_ownership_column));
        END IF;
    END IF;

    -- Validate parent table uses BIGINT PK
    SELECT kcu.column_name, c.data_type
    INTO v_pk_column, v_pk_type
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
    JOIN information_schema.columns c ON c.table_name = tc.table_name AND c.column_name = kcu.column_name
    WHERE tc.table_schema = 'public' AND tc.table_name = p_parent_table
      AND tc.constraint_type = 'PRIMARY KEY'
    LIMIT 1;

    IF v_pk_column IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', format('Parent table %s must have a primary key', p_parent_table));
    END IF;

    IF v_pk_type NOT IN ('bigint', 'bigserial') THEN
        RETURN jsonb_build_object('success', false, 'message', format('Parent table %s PK must be bigint or bigserial, found %s', p_parent_table, v_pk_type));
    END IF;

    -- Insert guided form definition
    INSERT INTO metadata.guided_forms (
        guided_form_key, description, parent_table,
        ownership_column, on_submit_rpc, review_intro_text,
        lock_on_submit, precondition_rpc
    ) VALUES (
        p_guided_form_key, p_description, p_parent_table,
        p_ownership_column, p_on_submit_rpc, p_review_intro_text,
        p_lock_on_submit, p_precondition_rpc
    );

    -- Auto-register step zero (__parent__)
    INSERT INTO metadata.guided_form_steps (
        guided_form_key, step_key, display_name, step_table,
        parent_fk_column, step_order, can_skip
    ) VALUES (
        p_guided_form_key, '__parent__', COALESCE(p_parent_step_display_name, 'Application Details'),
        p_parent_table, NULL, 0, FALSE
    );

    -- Update parent entity metadata
    UPDATE metadata.entities
       SET guided_form_key = p_guided_form_key
     WHERE table_name = p_parent_table;

    -- If lock_on_submit, create submitted-guided form lock trigger on parent
    IF p_lock_on_submit THEN
        EXECUTE format(
            'DROP TRIGGER IF EXISTS trg_block_submitted_update ON %I; '
            'CREATE TRIGGER trg_block_submitted_update '
            'BEFORE UPDATE ON %I FOR EACH ROW '
            'EXECUTE FUNCTION metadata.block_submitted_update();',
            p_parent_table, p_parent_table
        );
    END IF;

    -- Create condition-field lock trigger on parent
    EXECUTE format(
        'DROP TRIGGER IF EXISTS trg_guided_form_lock ON %I; '
        'CREATE TRIGGER trg_guided_form_lock '
        'BEFORE UPDATE ON %I FOR EACH ROW '
        'EXECUTE FUNCTION metadata.enforce_guided_form_lock();',
        p_parent_table, p_parent_table
    );

    -- Create cascade delete trigger to clean up progress rows
    EXECUTE format(
        'DROP TRIGGER IF EXISTS trg_cascade_gf_delete ON %I; '
        'CREATE TRIGGER trg_cascade_gf_delete '
        'BEFORE DELETE ON %I FOR EACH ROW '
        'EXECUTE FUNCTION metadata.cascade_guided_form_delete();',
        p_parent_table, p_parent_table
    );

    -- Ensure CRUD permission entries exist for the parent table.
    INSERT INTO metadata.permissions (table_name, permission)
    SELECT p_parent_table, p::metadata.permission
    FROM unnest(ARRAY['create', 'read', 'update', 'delete']) AS p
    ON CONFLICT (table_name, permission) DO NOTHING;

    -- Auto-create RLS policies on parent table when ownership is configured.
    IF p_ownership_column IS NOT NULL THEN
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', p_parent_table);

        -- === Tier 1: Ownership policies ===
        EXECUTE format(
            'CREATE POLICY gf_owner_select ON public.%I FOR SELECT TO authenticated USING (%I = public.current_user_id())',
            p_parent_table, p_ownership_column
        );
        EXECUTE format(
            'CREATE POLICY gf_owner_update ON public.%I FOR UPDATE TO authenticated USING (%I = public.current_user_id())',
            p_parent_table, p_ownership_column
        );
        EXECUTE format(
            'CREATE POLICY gf_owner_delete ON public.%I FOR DELETE TO authenticated USING (%I = public.current_user_id())',
            p_parent_table, p_ownership_column
        );
        EXECUTE format(
            'CREATE POLICY gf_insert ON public.%I FOR INSERT TO authenticated WITH CHECK (true)',
            p_parent_table
        );

        -- === Tier 2: RBAC per-operation blanket access ===
        EXECUTE format(
            'CREATE POLICY gf_rbac_select ON public.%I FOR SELECT TO authenticated USING (public.has_permission(%L, ''read''))',
            p_parent_table, p_parent_table::TEXT
        );
        EXECUTE format(
            'CREATE POLICY gf_rbac_update ON public.%I FOR UPDATE TO authenticated USING (public.has_permission(%L, ''update''))',
            p_parent_table, p_parent_table::TEXT
        );
        EXECUTE format(
            'CREATE POLICY gf_rbac_delete ON public.%I FOR DELETE TO authenticated USING (public.has_permission(%L, ''delete''))',
            p_parent_table, p_parent_table::TEXT
        );

        -- Hide ownership column from UI
        INSERT INTO metadata.properties (table_name, column_name, show_on_list, show_on_create, show_on_edit, show_on_detail)
        VALUES (p_parent_table, p_ownership_column, false, false, false, false)
        ON CONFLICT (table_name, column_name) DO UPDATE
          SET show_on_list = false, show_on_create = false, show_on_edit = false, show_on_detail = false;
    END IF;

    RETURN jsonb_build_object('success', true, 'guided_form_key', p_guided_form_key);
EXCEPTION
    WHEN unique_violation THEN
        RETURN jsonb_build_object('success', false, 'message', format('Guided form %s already exists', p_guided_form_key));
    WHEN OTHERS THEN
        RETURN jsonb_build_object('success', false, 'message', SQLERRM);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.register_guided_form(NAME, NAME, TEXT, NAME, VARCHAR, TEXT, BOOLEAN, NAME, NAME) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.register_guided_form(NAME, NAME, TEXT, NAME, VARCHAR, TEXT, BOOLEAN, NAME, NAME) TO authenticated;

COMMENT ON FUNCTION public.register_guided_form(NAME, NAME, TEXT, NAME, VARCHAR, TEXT, BOOLEAN, NAME, NAME) IS
    'Register a new guided form definition with auto step-zero and ownership RLS. '
    'SECURITY DEFINER for trigger/RLS creation. '
    'v0.55.2: column-agnostic — detects guided_form_status_id or status_id, does not rename.';


-- ============================================================================
-- 5. RPC: add_guided_form_step()
-- ============================================================================
-- Column-agnostic: detects and uses existing column name. Does NOT rename.

CREATE OR REPLACE FUNCTION public.add_guided_form_step(
    p_guided_form_key     NAME,
    p_step_key         NAME,
    p_display_name     VARCHAR(100),
    p_step_order       INT,
    p_step_table       NAME,
    p_parent_fk_column NAME,
    p_description      TEXT DEFAULT NULL,
    p_can_skip         BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = metadata, public, pg_catalog
AS $$
DECLARE
    v_guided_form      metadata.guided_forms%ROWTYPE;
    v_gf_col           NAME;
BEGIN
    -- Admin guard: only admins (or superusers running init scripts) can add guided form steps
    IF NOT (public.is_admin() OR current_setting('is_superuser', true) = 'on') THEN
        RAISE EXCEPTION 'Admin access required';
    END IF;

    SELECT * INTO v_guided_form FROM metadata.guided_forms WHERE guided_form_key = p_guided_form_key;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', format('Guided form %s not found', p_guided_form_key));
    END IF;

    -- Detect or create GF status column on step table. Do NOT rename.
    v_gf_col := public._gf_status_col(p_step_table);
    IF v_gf_col IS NULL THEN
        EXECUTE format(
            'ALTER TABLE public.%I ADD COLUMN status_id INTEGER REFERENCES metadata.statuses(id)',
            p_step_table
        );
        v_gf_col := 'status_id';
    END IF;
    EXECUTE format(
        'ALTER TABLE public.%I ALTER COLUMN %I SET DEFAULT public.get_initial_status(''guided_form'')',
        p_step_table, v_gf_col
    );
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%I_gf_status_id ON public.%I (%I)', p_step_table, p_step_table, v_gf_col);

    INSERT INTO metadata.properties (table_name, column_name, show_on_list, show_on_create, show_on_edit, show_on_detail)
    VALUES (p_step_table, v_gf_col, false, false, false, false)
    ON CONFLICT (table_name, column_name) DO UPDATE
      SET show_on_list = false, show_on_create = false, show_on_edit = false, show_on_detail = false;

    INSERT INTO metadata.guided_form_steps (
        guided_form_key, step_key, display_name, description,
        step_table, parent_fk_column, step_order, can_skip
    ) VALUES (
        p_guided_form_key, p_step_key, p_display_name, p_description,
        p_step_table, p_parent_fk_column, p_step_order, p_can_skip
    );

    -- Upgrade FK constraint to ON DELETE CASCADE
    DECLARE
        v_fk_name TEXT;
    BEGIN
        SELECT conname INTO v_fk_name
        FROM pg_constraint
        WHERE conrelid = format('public.%I', p_step_table)::regclass
          AND confrelid = format('public.%I', v_guided_form.parent_table)::regclass
          AND contype = 'f';

        IF v_fk_name IS NOT NULL THEN
            EXECUTE format(
                'ALTER TABLE public.%I DROP CONSTRAINT %I',
                p_step_table, v_fk_name
            );
            EXECUTE format(
                'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES public.%I(id) ON DELETE CASCADE',
                p_step_table, v_fk_name, p_parent_fk_column, v_guided_form.parent_table
            );
        END IF;
    END;

    -- Hide step table from sidebar and propagate guided_form_key
    INSERT INTO metadata.entities (table_name, display_name, show_in_sidebar, guided_form_key)
    VALUES (p_step_table, p_display_name, FALSE, p_guided_form_key)
    ON CONFLICT (table_name) DO UPDATE SET
        show_in_sidebar = FALSE,
        guided_form_key = p_guided_form_key;

    -- Ensure CRUD permission entries exist for the step table.
    INSERT INTO metadata.permissions (table_name, permission)
    SELECT p_step_table, p::metadata.permission
    FROM unnest(ARRAY['create', 'read', 'update', 'delete']) AS p
    ON CONFLICT (table_name, permission) DO NOTHING;

    -- Auto-create RLS policies on step table (inherits parent ownership).
    IF v_guided_form.ownership_column IS NOT NULL THEN
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', p_step_table);

        -- === Tier 1: Ownership via parent FK ===
        EXECUTE format(
            'CREATE POLICY gf_child_select ON public.%I FOR SELECT TO authenticated '
            'USING (EXISTS (SELECT 1 FROM public.%I WHERE %I.id = %I.%I AND %I.%I = public.current_user_id()))',
            p_step_table, v_guided_form.parent_table,
            v_guided_form.parent_table, p_step_table, p_parent_fk_column,
            v_guided_form.parent_table, v_guided_form.ownership_column
        );
        EXECUTE format(
            'CREATE POLICY gf_child_insert ON public.%I FOR INSERT TO authenticated '
            'WITH CHECK (EXISTS (SELECT 1 FROM public.%I WHERE %I.id = %I.%I AND %I.%I = public.current_user_id()))',
            p_step_table, v_guided_form.parent_table,
            v_guided_form.parent_table, p_step_table, p_parent_fk_column,
            v_guided_form.parent_table, v_guided_form.ownership_column
        );
        EXECUTE format(
            'CREATE POLICY gf_child_update ON public.%I FOR UPDATE TO authenticated '
            'USING (EXISTS (SELECT 1 FROM public.%I WHERE %I.id = %I.%I AND %I.%I = public.current_user_id()))',
            p_step_table, v_guided_form.parent_table,
            v_guided_form.parent_table, p_step_table, p_parent_fk_column,
            v_guided_form.parent_table, v_guided_form.ownership_column
        );
        EXECUTE format(
            'CREATE POLICY gf_child_delete ON public.%I FOR DELETE TO authenticated '
            'USING (EXISTS (SELECT 1 FROM public.%I WHERE %I.id = %I.%I AND %I.%I = public.current_user_id()))',
            p_step_table, v_guided_form.parent_table,
            v_guided_form.parent_table, p_step_table, p_parent_fk_column,
            v_guided_form.parent_table, v_guided_form.ownership_column
        );

        -- === Tier 2: RBAC per-operation blanket access (inherits parent table permissions) ===
        EXECUTE format(
            'CREATE POLICY gf_child_rbac_select ON public.%I FOR SELECT TO authenticated '
            'USING (public.has_permission(%L, ''read''))',
            p_step_table, v_guided_form.parent_table::TEXT
        );
        EXECUTE format(
            'CREATE POLICY gf_child_rbac_insert ON public.%I FOR INSERT TO authenticated '
            'WITH CHECK (public.has_permission(%L, ''update''))',
            p_step_table, v_guided_form.parent_table::TEXT
        );
        EXECUTE format(
            'CREATE POLICY gf_child_rbac_update ON public.%I FOR UPDATE TO authenticated '
            'USING (public.has_permission(%L, ''update''))',
            p_step_table, v_guided_form.parent_table::TEXT
        );
        EXECUTE format(
            'CREATE POLICY gf_child_rbac_delete ON public.%I FOR DELETE TO authenticated '
            'USING (public.has_permission(%L, ''delete''))',
            p_step_table, v_guided_form.parent_table::TEXT
        );
    END IF;

    RETURN jsonb_build_object('success', true, 'step_key', p_step_key);
EXCEPTION
    WHEN unique_violation THEN
        RETURN jsonb_build_object('success', false, 'message', format('Step %s already exists in guided form %s', p_step_key, p_guided_form_key));
    WHEN OTHERS THEN
        RETURN jsonb_build_object('success', false, 'message', SQLERRM);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.add_guided_form_step(NAME, NAME, VARCHAR, INT, NAME, NAME, TEXT, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.add_guided_form_step(NAME, NAME, VARCHAR, INT, NAME, NAME, TEXT, BOOLEAN) TO authenticated;

COMMENT ON FUNCTION public.add_guided_form_step(NAME, NAME, VARCHAR, INT, NAME, NAME, TEXT, BOOLEAN) IS
    'Add a step to a guided form definition with auto child RLS delegation. '
    'SECURITY DEFINER for RLS creation. '
    'v0.55.2: column-agnostic — detects guided_form_status_id or status_id, does not rename.';


-- ============================================================================
-- 6. RPC: complete_guided_form_step()
-- ============================================================================
-- Column-agnostic: uses _gf_status_col() for dynamic column references.

CREATE OR REPLACE FUNCTION public.complete_guided_form_step(
    p_guided_form_key NAME,
    p_parent_id    BIGINT,
    p_step_key     NAME
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = metadata, public, pg_catalog
AS $$
DECLARE
    v_step           metadata.guided_form_steps%ROWTYPE;
    v_all_complete   BOOLEAN;
    v_parent_table   NAME;
    v_auto_submit    BOOLEAN;
    v_submit_result  JSONB;
    v_next_step      RECORD;
    v_next_result    JSONB;
    v_parent_json    JSONB;
    v_condition_met  BOOLEAN;
    v_condition      RECORD;
    v_field_value    TEXT;
    v_gf_col         NAME;
BEGIN
    -- ── STATUS MODEL ──────────────────────────────────────────────────
    -- Parent row's GF status = form lifecycle (draft → complete → submitted).
    -- Step completion is tracked in guided_form_progress for ALL steps,
    -- including step zero.  Only steps 1-N get a step-level status update
    -- (on their own table).  The parent's GF status advances forward only
    -- — never reverts from complete to draft.
    -- ──────────────────────────────────────────────────────────────────

    SELECT * INTO v_step
    FROM metadata.guided_form_steps
    WHERE guided_form_key = p_guided_form_key AND step_key = p_step_key;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Step % not found', p_step_key USING ERRCODE = 'P0001';
    END IF;

    -- STEP DATA STATUS: mark step data as validated.
    -- Step zero skipped — parent GF status is the form lifecycle, not step data.
    -- Step zero completion is recorded in guided_form_progress below.
    IF v_step.parent_fk_column IS NOT NULL THEN
        -- Steps 1-N: update the step table's own GF status column
        v_gf_col := public._gf_status_col(v_step.step_table);
        EXECUTE format(
            'UPDATE public.%I SET %I = (SELECT id FROM metadata.statuses WHERE entity_type = ''guided_form'' AND status_key = ''complete'') WHERE %I = $1',
            v_step.step_table, v_gf_col, v_step.parent_fk_column
        ) USING p_parent_id;
    END IF;

    -- PROGRESS TRACKING: record step completion (all steps including step zero)
    INSERT INTO metadata.guided_form_progress (guided_form_key, parent_id, step_key, completed_by)
    VALUES (p_guided_form_key, p_parent_id, p_step_key, public.current_user_id())
    ON CONFLICT (guided_form_key, parent_id, step_key) DO UPDATE SET
        completed_at = NOW(),
        completed_by = public.current_user_id();

    -- ── FIND NEXT STEP FIRST ─────────────────────────────────────────
    SELECT parent_table INTO v_parent_table
    FROM metadata.guided_forms WHERE guided_form_key = p_guided_form_key;

    EXECUTE format(
        'SELECT to_jsonb(t.*) FROM public.%I t WHERE t.id = $1',
        v_parent_table
    ) INTO v_parent_json USING p_parent_id;

    FOR v_next_step IN
        SELECT * FROM metadata.guided_form_steps
        WHERE guided_form_key = p_guided_form_key
          AND step_key != '__parent__'
          AND step_order > v_step.step_order
        ORDER BY step_order
    LOOP
        -- Evaluate skip_if conditions for this candidate step
        v_condition_met := FALSE;
        FOR v_condition IN
            SELECT * FROM metadata.guided_form_step_conditions
            WHERE guided_form_step_id = v_next_step.id AND condition_type = 'skip_if'
            ORDER BY sort_order
        LOOP
            v_field_value := v_parent_json->>v_condition.field;
            CASE v_condition.operator
                WHEN 'eq' THEN
                    IF v_field_value = v_condition.value THEN v_condition_met := TRUE; END IF;
                WHEN 'neq' THEN
                    IF v_field_value != v_condition.value THEN v_condition_met := TRUE; END IF;
                WHEN 'is_null' THEN
                    IF v_field_value IS NULL THEN v_condition_met := TRUE; END IF;
                WHEN 'is_not_null' THEN
                    IF v_field_value IS NOT NULL THEN v_condition_met := TRUE; END IF;
            END CASE;
        END LOOP;

        IF v_condition_met THEN
            CONTINUE;
        END IF;

        IF EXISTS(
            SELECT 1 FROM metadata.guided_form_progress
            WHERE guided_form_key = p_guided_form_key AND parent_id = p_parent_id AND step_key = v_next_step.step_key
        ) THEN
            CONTINUE;
        END IF;

        -- Found the next non-skipped, incomplete step
        v_next_result := public.ensure_guided_form_step_record(p_guided_form_key, p_parent_id, v_next_step.step_key);

        RETURN jsonb_build_object(
            'all_data_steps_complete', false,
            'next_step_key', v_next_step.step_key,
            'next_step_table', v_next_step.step_table,
            'next_record_id', (v_next_result->>'record_id')::bigint
        );
    END LOOP;

    -- ── NO MORE INCOMPLETE STEPS ─────────────────────────────────────
    SELECT public._check_guided_form_complete(p_guided_form_key, p_parent_id) INTO v_all_complete;

    IF v_all_complete THEN
        v_gf_col := public._gf_status_col(v_parent_table);
        EXECUTE format(
            'UPDATE public.%I SET %I = (SELECT id FROM metadata.statuses WHERE entity_type = ''guided_form'' AND status_key = ''complete'') WHERE id = $1',
            v_parent_table, v_gf_col
        ) USING p_parent_id;

        -- Auto-submit if flag is set and ALL non-parent steps were condition-skipped
        SELECT auto_submit_on_all_skipped INTO v_auto_submit
        FROM metadata.guided_forms WHERE guided_form_key = p_guided_form_key;

        IF v_auto_submit AND public._all_steps_condition_skipped(p_guided_form_key, p_parent_id) THEN
            v_submit_result := public.submit_guided_form(p_guided_form_key, p_parent_id);
            RETURN v_submit_result || jsonb_build_object(
                'all_data_steps_complete', true,
                'auto_submitted', true
            );
        END IF;

        RETURN jsonb_build_object(
            'all_data_steps_complete', true
        );
    END IF;

    -- Edge case: no next step found but not all complete
    RETURN jsonb_build_object(
        'all_data_steps_complete', false
    );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.complete_guided_form_step(NAME, BIGINT, NAME) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_guided_form_step(NAME, BIGINT, NAME) TO authenticated;

COMMENT ON FUNCTION public.complete_guided_form_step(NAME, BIGINT, NAME) IS
    'Mark a guided form step as complete. Steps 1-N get a step-level status update; '
    'step zero completion is recorded in guided_form_progress only. '
    'Advances parent to complete when all steps are done. '
    'v0.55.2: column-agnostic via _gf_status_col().';


-- ============================================================================
-- 7. RPC: submit_guided_form()
-- ============================================================================
-- ALWAYS sets the GF status column to 'submitted'. Column-agnostic.
-- The on_submit_rpc handles business status (a different column).

CREATE OR REPLACE FUNCTION public.submit_guided_form(
    p_guided_form_key NAME,
    p_parent_id    BIGINT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = metadata, public, pg_catalog
AS $$
DECLARE
    v_guided_form metadata.guided_forms%ROWTYPE;
    v_result   JSONB;
    v_gf_col   NAME;
BEGIN
    SELECT * INTO v_guided_form FROM metadata.guided_forms WHERE guided_form_key = p_guided_form_key;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Unknown guided form' USING ERRCODE = 'P0001';
    END IF;

    IF NOT public._check_guided_form_complete(p_guided_form_key, p_parent_id) THEN
        RAISE EXCEPTION 'Guided form has incomplete required steps' USING ERRCODE = 'P0001';
    END IF;

    -- Call on_submit_rpc BEFORE locking so it can modify the parent record.
    -- The RPC handles business status (e.g., setting status_id to 'pending').
    -- If it fails, the transaction rolls back and the guided form remains unsubmitted.
    IF v_guided_form.on_submit_rpc IS NOT NULL THEN
        EXECUTE format('SELECT public.%I($1)', v_guided_form.on_submit_rpc)
            INTO v_result USING p_parent_id;
        IF v_result IS NOT NULL AND (v_result->>'success')::boolean = false THEN
            RAISE EXCEPTION '%', v_result->>'message' USING ERRCODE = 'P0001';
        END IF;
    END IF;

    -- ALWAYS set GF status to 'submitted' — this is the framework lifecycle.
    -- The on_submit_rpc (if any) sets the business status on a separate column.
    v_gf_col := public._gf_status_col(v_guided_form.parent_table);
    EXECUTE format(
        'UPDATE public.%I SET submitted_at = NOW(), %I = (SELECT id FROM metadata.statuses WHERE entity_type = ''guided_form'' AND status_key = ''submitted'') WHERE id = $1',
        v_guided_form.parent_table, v_gf_col
    ) USING p_parent_id;

    -- Mark progress as submitted
    UPDATE metadata.guided_form_progress
       SET submitted_at = NOW()
     WHERE guided_form_key = p_guided_form_key
       AND parent_id    = p_parent_id
       AND step_key     = '__parent__';

    -- Forward navigate_to from on_submit_rpc if it provided one.
    RETURN jsonb_build_object(
        'navigate_to', COALESCE(v_result->>'navigate_to', '')
    );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.submit_guided_form(NAME, BIGINT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_guided_form(NAME, BIGINT) TO authenticated;

COMMENT ON FUNCTION public.submit_guided_form(NAME, BIGINT) IS
    'Submit a completed guided form. ALWAYS sets GF status to submitted and calls on_submit_rpc. '
    'v0.55.2: column-agnostic via _gf_status_col(), separate from business status.';


-- ============================================================================
-- 8. RPC: get_guided_form_context()
-- ============================================================================
-- Column-agnostic: uses _gf_status_col() for the status SELECT.
-- The returned JSON keys (parent_status_id, parent_status_key) are unchanged
-- for frontend compatibility.

CREATE OR REPLACE FUNCTION public.get_guided_form_context(
    p_guided_form_key  NAME,
    p_table_name       NAME,
    p_record_id        BIGINT
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = metadata, public, pg_catalog
AS $$
DECLARE
    v_def            RECORD;
    v_steps          JSONB;
    v_progress       JSONB;
    v_status_options JSONB;
    v_parent_id      BIGINT;
    v_record_id      BIGINT := p_record_id;
    v_is_child_step  BOOLEAN := FALSE;
    v_step_key       NAME := NULL;
    v_parent_status_id   INTEGER;
    v_parent_status_key  TEXT;
    v_step_record_ids    JSONB := '{}'::JSONB;
    v_step              RECORD;
    v_fk_col            NAME;
    v_found_id          BIGINT;
    v_gf_col            NAME;
BEGIN
    -- 1. Look up the guided form definition
    SELECT * INTO v_def
    FROM metadata.guided_forms
    WHERE guided_form_key = p_guided_form_key;

    IF v_def IS NULL THEN
        RETURN NULL;
    END IF;

    -- 2. Determine if p_table_name is the parent table or a child step table
    IF p_table_name = v_def.parent_table THEN
        v_parent_id := p_record_id;
        v_is_child_step := FALSE;
    ELSE
        SELECT gfs.parent_fk_column, gfs.step_key
        INTO v_fk_col, v_step_key
        FROM metadata.guided_form_steps gfs
        WHERE gfs.guided_form_key = p_guided_form_key
          AND gfs.step_table = p_table_name
          AND gfs.parent_fk_column IS NOT NULL
        LIMIT 1;

        IF v_fk_col IS NULL THEN
            RETURN NULL;
        END IF;

        v_is_child_step := TRUE;

        EXECUTE format(
            'SELECT %I FROM %I WHERE id = $1',
            v_fk_col, p_table_name
        ) INTO v_parent_id USING p_record_id;

        IF v_parent_id IS NULL THEN
            RETURN NULL;
        END IF;
    END IF;

    -- 3. Fetch steps with embedded conditions
    SELECT COALESCE(jsonb_agg(step_row ORDER BY step_row->>'step_order'), '[]'::JSONB)
    INTO v_steps
    FROM (
        SELECT jsonb_build_object(
            'id', gfs.id,
            'guided_form_key', gfs.guided_form_key,
            'step_key', gfs.step_key,
            'display_name', gfs.display_name,
            'description', gfs.description,
            'step_table', gfs.step_table,
            'parent_fk_column', gfs.parent_fk_column,
            'step_order', gfs.step_order,
            'can_skip', gfs.can_skip,
            'track_key', gfs.track_key,
            'conditions', COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                    'id', c.id,
                    'condition_type', c.condition_type,
                    'field', c.field,
                    'operator', c.operator,
                    'value', c.value
                ))
                FROM metadata.guided_form_step_conditions c
                WHERE c.guided_form_step_id = gfs.id
            ), '[]'::JSONB)
        ) AS step_row
        FROM metadata.guided_form_steps gfs
        WHERE gfs.guided_form_key = p_guided_form_key
        ORDER BY gfs.step_order
    ) sub;

    -- 4. Fetch progress for the resolved parent_id
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', gfp.id,
        'guided_form_key', gfp.guided_form_key,
        'parent_id', gfp.parent_id,
        'step_key', gfp.step_key,
        'completed_at', gfp.completed_at,
        'completed_by', gfp.completed_by,
        'submitted_at', gfp.submitted_at,
        'created_at', gfp.created_at
    ) ORDER BY gfp.created_at), '[]'::JSONB)
    INTO v_progress
    FROM metadata.guided_form_progress gfp
    WHERE gfp.guided_form_key = p_guided_form_key
      AND gfp.parent_id = v_parent_id;

    -- 5. Fetch status options for this guided form's entity_type
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', s.id,
        'status_key', s.status_key,
        'display_name', s.display_name,
        'color', s.color
    ) ORDER BY s.sort_order), '[]'::JSONB)
    INTO v_status_options
    FROM metadata.statuses s
    WHERE s.entity_type = 'guided_form';

    -- 6. Read GF status from the parent record via dynamic column detection
    v_gf_col := public._gf_status_col(v_def.parent_table);
    IF v_gf_col IS NOT NULL THEN
        EXECUTE format(
            'SELECT %I FROM %I WHERE id = $1',
            v_gf_col, v_def.parent_table
        ) INTO v_parent_status_id USING v_parent_id;
    END IF;

    -- 7. Resolve status_key from status_id
    IF v_parent_status_id IS NOT NULL THEN
        SELECT s.status_key INTO v_parent_status_key
        FROM metadata.statuses s
        WHERE s.id = v_parent_status_id;
    END IF;

    -- 8. For each step, query for existing record IDs
    v_step_record_ids := jsonb_build_object('__parent__', v_parent_id);

    FOR v_step IN
        SELECT gfs.step_key, gfs.step_table, gfs.parent_fk_column
        FROM metadata.guided_form_steps gfs
        WHERE gfs.guided_form_key = p_guided_form_key
          AND gfs.parent_fk_column IS NOT NULL
        ORDER BY gfs.step_order
    LOOP
        BEGIN
            EXECUTE format(
                'SELECT id FROM %I WHERE %I = $1 LIMIT 1',
                v_step.step_table, v_step.parent_fk_column
            ) INTO v_found_id USING v_parent_id;

            IF v_found_id IS NOT NULL THEN
                v_step_record_ids := v_step_record_ids || jsonb_build_object(v_step.step_key, v_found_id);
            END IF;
        EXCEPTION WHEN OTHERS THEN
            NULL;
        END;
    END LOOP;

    -- 9. Build and return the full context
    -- JSON keys (parent_status_id, parent_status_key) are unchanged for frontend compat
    RETURN jsonb_build_object(
        'definition', jsonb_build_object(
            'guided_form_key', v_def.guided_form_key,
            'description', v_def.description,
            'parent_table', v_def.parent_table,
            'ownership_column', v_def.ownership_column,
            'lock_on_submit', v_def.lock_on_submit,
            'on_submit_rpc', v_def.on_submit_rpc,
            'review_intro_text', v_def.review_intro_text,
            'precondition_rpc', v_def.precondition_rpc,
            'auto_submit_on_all_skipped', v_def.auto_submit_on_all_skipped,
            'is_enabled', v_def.is_enabled,
            'status_options', v_status_options
        ),
        'steps', v_steps,
        'progress', v_progress,
        'status_options', v_status_options,
        'parent_status_id', v_parent_status_id,
        'parent_status_key', v_parent_status_key,
        'parent_id', v_parent_id,
        'record_id', v_record_id,
        'is_child_step', v_is_child_step,
        'step_key', v_step_key,
        'step_record_ids', v_step_record_ids
    );
END;
$$;

COMMENT ON FUNCTION public.get_guided_form_context(NAME, NAME, BIGINT) IS
    'One-shot context loader for guided form pages. Returns definition, steps, progress, '
    'status, and step record IDs. '
    'v0.55.2: column-agnostic via _gf_status_col().';


-- ============================================================================
-- Done
-- ============================================================================

NOTIFY pgrst, 'reload schema';

COMMIT;
