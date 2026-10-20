-- Deploy civic_os:v0-76-9-split-applies-new-schedule
-- Requires: v0-76-9-occurrence-date-local
--
-- v0.76.9 -- "This and following" splits and series templates, made safe.
--
-- SECURITY: split_series_from_date and update_series_template are SECURITY DEFINER
-- and wrote entity records with definer rights behind an owner-or-admin check, so a
-- series owner WITHOUT update permission on the entity table could change records,
-- e.g. a plain 'user' approving their own reservation requests through
-- update_series_template('{"status_id": <approved>}'). Both now require
-- has_permission(entity_table, 'update'), never write Status columns (columns with
-- a foreign key to metadata.statuses) through a template, and set search_path.
--
-- 1. Status columns never propagate through a template: workflow changes go through
--    actions. A series' stored template keeps its original status.
-- 2. Occurrences edited outside the series RPCs become exceptions: an AFTER UPDATE
--    trigger (metadata.mark_series_instance_modified) marks them 'rescheduled' (time
--    slot changed, original_time_slot kept) or 'modified' (any other change, e.g. an
--    approval), so splits and template updates leave them alone. The series RPCs set
--    the transaction-local GUC civic_os.series_write to bypass it. The trigger is
--    attached to every entity table with series now and whenever a series is
--    inserted (any path). Existing rows are checked once: bookings no longer on
--    their scheduled slot ('rescheduled', from the slot the v0.76.9 occurrence date
--    conversion matched, metadata.time_slot_instance_date_repair.scheduled_start),
--    then template drift ('modified').
-- 3. split_series_from_date(..., p_edited_entity_id, p_edited_values) saves the
--    edited occurrence in the same transaction as the split, moves the following
--    non-exception occurrences onto the new schedule and template in place
--    (metadata.apply_split_to_future_instances), keeps COUNT a series total,
--    refuses a second split of a group on the same date, refuses date shifts that
--    would put the new first occurrence on or before the old version's last one or
--    that would detach edited following occurrences.
-- 4. time_slot_series.timezone must be an exact pg_timezone_names name (the worker's
--    LoadLocation and the frontend reject offsets and wrong-case names).
--
-- No production deployment runs recurring schedules on v0.76.5+, so splits made
-- before this release need no data repair; versions whose COUNT was restarted by an
-- earlier split are reported with a NOTICE.

BEGIN;

-- ============================================================================
-- 1. Helpers: Status columns, template stripping, series-write GUC
-- ============================================================================

-- Columns of a public entity table that reference metadata.statuses
CREATE OR REPLACE FUNCTION metadata.series_status_columns(p_table name) RETURNS text[]
LANGUAGE sql STABLE
SET search_path = public, metadata, postgis
AS $$
    SELECT COALESCE(array_agg(a.attname::text), ARRAY[]::text[])
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    WHERE c.contype = 'f'
      AND c.conrelid = to_regclass(format('public.%I', p_table))
      AND c.confrelid = 'metadata.statuses'::regclass
$$;
REVOKE EXECUTE ON FUNCTION metadata.series_status_columns(name) FROM PUBLIC;

-- A template without Status columns: workflow state never propagates through templates
CREATE OR REPLACE FUNCTION metadata.strip_series_status_columns(p_table name, p_template jsonb) RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = public, metadata, postgis
AS $$
    SELECT COALESCE(p_template, '{}'::jsonb) - metadata.series_status_columns(p_table)
$$;
REVOKE EXECUTE ON FUNCTION metadata.strip_series_status_columns(name, jsonb) FROM PUBLIC;

-- ============================================================================
-- 2. Mark occurrences edited outside the series RPCs as exceptions
-- ============================================================================

CREATE OR REPLACE FUNCTION metadata.mark_series_instance_modified() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, metadata, postgis
AS $$
DECLARE
    v_inst RECORD;
    v_old jsonb;
    v_new jsonb;
BEGIN
    -- Writes by the series machinery itself (split, template update) are not edits
    IF current_setting('civic_os.series_write', true) = 'on' THEN
        RETURN NULL;
    END IF;

    SELECT i.id, s.time_slot_property INTO v_inst
    FROM metadata.time_slot_instances i
    JOIN metadata.time_slot_series s ON s.id = i.series_id
    WHERE i.entity_table = TG_TABLE_NAME AND i.entity_id = NEW.id AND NOT i.is_exception;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    v_old := to_jsonb(OLD);
    v_new := to_jsonb(NEW);
    IF v_old -> v_inst.time_slot_property IS DISTINCT FROM v_new -> v_inst.time_slot_property THEN
        UPDATE metadata.time_slot_instances
        SET is_exception = TRUE, exception_type = 'rescheduled',
            original_time_slot = (v_old ->> v_inst.time_slot_property)::tstzrange,
            exception_at = NOW(), exception_by = current_user_id()
        WHERE id = v_inst.id;
    ELSIF (v_old - 'updated_at') IS DISTINCT FROM (v_new - 'updated_at') THEN
        UPDATE metadata.time_slot_instances
        SET is_exception = TRUE, exception_type = 'modified',
            exception_at = NOW(), exception_by = current_user_id()
        WHERE id = v_inst.id;
    END IF;
    RETURN NULL;
END;
$$;
REVOKE EXECUTE ON FUNCTION metadata.mark_series_instance_modified() FROM PUBLIC;

-- Attach the trigger to an entity table used by series (idempotent)
CREATE OR REPLACE FUNCTION metadata.ensure_series_modified_trigger(p_table name) RETURNS void
LANGUAGE plpgsql
SET search_path = public, metadata, postgis
AS $$
BEGIN
    IF to_regclass(format('public.%I', p_table)) IS NULL THEN
        RETURN;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = format('public.%I', p_table)::regclass
          AND tgname = 'zz_time_slot_series_instance_modified'
    ) THEN
        EXECUTE format(
            'CREATE TRIGGER zz_time_slot_series_instance_modified
             AFTER UPDATE ON public.%I FOR EACH ROW
             EXECUTE FUNCTION metadata.mark_series_instance_modified()', p_table);
    END IF;
END;
$$;
REVOKE EXECUTE ON FUNCTION metadata.ensure_series_modified_trigger(name) FROM PUBLIC;

-- Attach to every table that already has series, and mark rows that drifted from
-- their version before this release (one-time; nothing recorded those edits)
DO $drift$
DECLARE
    v_series RECORD;
    v_keys text[];
    v_modified int := 0;
    v_rescheduled int := 0;
    v_n int;
BEGIN
    FOR v_series IN SELECT DISTINCT entity_table FROM metadata.time_slot_series
    LOOP
        PERFORM metadata.ensure_series_modified_trigger(v_series.entity_table);
    END LOOP;

    -- Bookings moved "this only" before edits were tracked: not on the slot the
    -- occurrence date conversion matched them to
    FOR v_series IN SELECT DISTINCT entity_table, time_slot_property FROM metadata.time_slot_series
                    WHERE to_regclass(format('public.%I', entity_table)) IS NOT NULL
    LOOP
        EXECUTE format(
            'UPDATE metadata.time_slot_instances i
             SET is_exception = TRUE, exception_type = ''rescheduled'', exception_at = NOW(),
                 original_time_slot = tstzrange(r.scheduled_start, r.scheduled_start + r.scheduled_duration, ''[)'')
             FROM metadata.time_slot_instance_date_repair r, metadata.time_slot_series s, public.%I e
             WHERE r.instance_id = i.id AND s.id = i.series_id AND e.id = i.entity_id
               AND s.entity_table = $1 AND s.time_slot_property = $2
               AND NOT i.is_exception AND r.scheduled_start IS NOT NULL
               AND (lower(e.%I) IS DISTINCT FROM r.scheduled_start
                    OR upper(e.%I) IS DISTINCT FROM r.scheduled_start + r.scheduled_duration)',
            v_series.entity_table, v_series.time_slot_property, v_series.time_slot_property)
        USING v_series.entity_table, v_series.time_slot_property;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        v_rescheduled := v_rescheduled + v_n;
    END LOOP;

    FOR v_series IN
        SELECT s.*, CASE WHEN s.timezone IN (SELECT name FROM pg_timezone_names) THEN s.timezone ELSE 'UTC' END AS tz
        FROM metadata.time_slot_series s
        WHERE to_regclass(format('public.%I', s.entity_table)) IS NOT NULL
    LOOP
        -- Any template field (status included) that differs from the template
        SELECT array_agg(k) INTO v_keys
        FROM jsonb_object_keys(v_series.entity_template) k
        WHERE k NOT IN ('id', 'time_slot', v_series.time_slot_property);
        CONTINUE WHEN v_keys IS NULL;
        EXECUTE format(
            'UPDATE metadata.time_slot_instances i
             SET is_exception = TRUE, exception_type = ''modified'', exception_at = NOW()
             FROM public.%I e
             WHERE i.series_id = $1 AND NOT i.is_exception AND e.id = i.entity_id
               AND EXISTS (SELECT 1 FROM unnest($2::text[]) k
                           WHERE (to_jsonb(e) ->> k) IS DISTINCT FROM ($3 ->> k))',
            v_series.entity_table)
        USING v_series.id, v_keys, v_series.entity_template;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        v_modified := v_modified + v_n;
    END LOOP;

    RAISE NOTICE 'Series exceptions recorded for earlier edits: % rescheduled, % modified', v_rescheduled, v_modified;

    -- Versions created by an earlier split restarted the full COUNT
    FOR v_series IN
        SELECT s.id, s.group_id, s.version_number, s.rrule
        FROM metadata.time_slot_series s
        WHERE s.version_number > 1 AND s.rrule ~* '(^|;)COUNT=\d+'
    LOOP
        RAISE NOTICE 'Series % (group %, version %) has % : a split before v0.76.9 restarted COUNT, so check whether the group has more occurrences than intended',
            v_series.id, v_series.group_id, v_series.version_number,
            substring(v_series.rrule FROM '(?i)COUNT=\d+');
    END LOOP;
END
$drift$;

-- ============================================================================
-- 3. time_slot_series.timezone: exact IANA names only
-- ============================================================================

CREATE OR REPLACE FUNCTION metadata.validate_series_timezone() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, metadata, postgis
AS $$
BEGIN
    IF NEW.timezone IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.timezone) THEN
        RAISE EXCEPTION 'Invalid timezone "%"', NEW.timezone
            USING HINT = 'Use an IANA timezone name with exact case, e.g. America/New_York (no UTC offsets)';
    END IF;
    RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION metadata.validate_series_timezone() FROM PUBLIC;

DROP TRIGGER IF EXISTS validate_series_timezone ON metadata.time_slot_series;
CREATE TRIGGER validate_series_timezone
    BEFORE INSERT OR UPDATE OF timezone ON metadata.time_slot_series
    FOR EACH ROW EXECUTE FUNCTION metadata.validate_series_timezone();

DO $tz$
BEGIN
    IF EXISTS (SELECT 1 FROM metadata.time_slot_series
               WHERE timezone IS NOT NULL AND timezone NOT IN (SELECT name FROM pg_timezone_names)) THEN
        RAISE NOTICE 'Series with a timezone the worker cannot load (expanded in UTC): %',
            (SELECT string_agg(format('%s=%L', id, timezone), ', ') FROM metadata.time_slot_series
             WHERE timezone IS NOT NULL AND timezone NOT IN (SELECT name FROM pg_timezone_names));
    END IF;
END
$tz$;

-- ============================================================================
-- 4. Attach the edit trigger whenever a series is created (any path)
-- ============================================================================
-- create_recurring_series, splits, the worker and integrator init scripts all
-- insert into metadata.time_slot_series, so attach from there.

CREATE OR REPLACE FUNCTION metadata.attach_series_modified_trigger() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, metadata, postgis
AS $$
BEGIN
    PERFORM metadata.ensure_series_modified_trigger(NEW.entity_table);
    RETURN NULL;
END;
$$;
REVOKE EXECUTE ON FUNCTION metadata.attach_series_modified_trigger() FROM PUBLIC;

DROP TRIGGER IF EXISTS attach_series_modified_trigger ON metadata.time_slot_series;
CREATE TRIGGER attach_series_modified_trigger
    AFTER INSERT ON metadata.time_slot_series
    FOR EACH ROW EXECUTE FUNCTION metadata.attach_series_modified_trigger();

-- ============================================================================
-- 5. update_series_template: caller needs update permission; no Status columns
-- ============================================================================

CREATE OR REPLACE FUNCTION update_series_template(
  p_series_id bigint,
  p_new_template jsonb,
  p_skip_exceptions boolean DEFAULT true
) RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, metadata, postgis
AS $function$
DECLARE
    v_series RECORD;
    v_user_id UUID;
    v_updated_count INT := 0;
    v_instance RECORD;
    v_set_clause TEXT;
    v_key TEXT;
    v_value JSONB;
BEGIN
    v_user_id := current_user_id();
    IF v_user_id IS NULL AND NOT metadata._is_db_admin() THEN
        RAISE EXCEPTION 'Authentication required';
    END IF;

    SELECT * INTO v_series FROM metadata.time_slot_series WHERE id = p_series_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', FALSE, 'message', 'Series not found');
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM metadata.time_slot_series_groups
        WHERE id = v_series.group_id
          AND (created_by = v_user_id OR is_admin() OR metadata._is_db_admin())
    ) THEN
        RAISE EXCEPTION 'Permission denied'
            USING HINT = 'Must be the series owner or an admin';
    END IF;

    -- The template rewrites existing records: the caller must be allowed to update them
    IF NOT has_permission(v_series.entity_table::text, 'update') AND NOT metadata._is_db_admin() THEN
        RAISE EXCEPTION 'Permission denied'
            USING HINT = format('Requires %s:update permission', v_series.entity_table);
    END IF;

    -- Workflow state never propagates through a template
    p_new_template := v_series.entity_template
        || metadata.strip_series_status_columns(v_series.entity_table, p_new_template);
    PERFORM metadata.validate_entity_template(v_series.entity_table, p_new_template);

    UPDATE metadata.time_slot_series
    SET entity_template = p_new_template,
        template_updated_at = NOW(),
        template_updated_by = v_user_id
    WHERE id = p_series_id;

    v_set_clause := '';
    FOR v_key, v_value IN
        SELECT * FROM jsonb_each(metadata.strip_series_status_columns(v_series.entity_table, p_new_template))
    LOOP
        IF v_key NOT IN ('time_slot', v_series.time_slot_property) THEN
            IF v_set_clause != '' THEN v_set_clause := v_set_clause || ', '; END IF;
            v_set_clause := v_set_clause || format('%I = %L', v_key, v_value #>> '{}');
        END IF;
    END LOOP;

    IF v_set_clause != '' THEN
        PERFORM set_config('civic_os.series_write', 'on', true);
        FOR v_instance IN
            SELECT entity_id FROM metadata.time_slot_instances
            WHERE series_id = p_series_id AND entity_id IS NOT NULL
              AND (NOT p_skip_exceptions OR NOT is_exception)
        LOOP
            EXECUTE format('UPDATE public.%I SET %s WHERE id = $1', v_series.entity_table, v_set_clause)
            USING v_instance.entity_id;
            v_updated_count := v_updated_count + 1;
        END LOOP;
        PERFORM set_config('civic_os.series_write', 'off', true);
    END IF;

    RETURN jsonb_build_object('success', TRUE, 'message', format('Template updated, %s records modified', v_updated_count),
        'series_id', p_series_id, 'records_updated', v_updated_count);
END;
$function$;

REVOKE EXECUTE ON FUNCTION update_series_template(bigint, jsonb, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION update_series_template(bigint, jsonb, boolean) TO authenticated;

-- ============================================================================
-- 6. Split: move following occurrences in place, atomic edit, guarded shifts
-- ============================================================================

CREATE OR REPLACE FUNCTION metadata.apply_split_to_future_instances(
  p_new_series_id bigint,
  p_split_date date,
  p_new_dtstart timestamp without time zone,
  p_duration interval,
  p_template jsonb,
  p_time_slot_property text
) RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path = public, metadata, postgis
AS $function$
-- Internal helper for split_series_from_date() (runs with its definer rights;
-- the caller has checked has_permission(entity_table, 'update')).
-- Rewrites the non-exception occurrences after the split date, which the split has
-- re-linked to the new version, onto the new schedule: time slot = local occurrence
-- date + new dtstart time of day in the series timezone, for p_duration; plus the
-- new template's fields. Records keep their id (and notes, payments, approvals).
--
-- Dates: an RRULE with explicit BY* parts keeps its days, so dates stay. Without
-- BY* parts (DAILY, WEEKLY/MONTHLY/YEARLY anchored on dtstart) the pattern follows
-- dtstart, so every re-linked slot (including the edited occurrence and exceptions)
-- moves by the same day offset as the edited occurrence, matching what the worker
-- later expands for the new version and keeping the worker from re-creating them.
--
-- An occurrence whose new time would violate an exclusion or unique constraint
-- (e.g. overlap prevention) keeps its old time and becomes a conflict_skipped
-- exception instead of failing the whole split.
DECLARE
    v_series RECORD;
    v_tz TEXT;
    v_day_shift INT := 0;
    v_set_clause TEXT := '';
    v_key TEXT;
    v_value JSONB;
    v_inst RECORD;
    v_new_date DATE;
    v_start TIMESTAMPTZ;
    v_updated INT := 0;
    v_conflicts INT := 0;
BEGIN
    SELECT * INTO v_series FROM metadata.time_slot_series WHERE id = p_new_series_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Series % not found', p_new_series_id;
    END IF;

    -- Same fallback as the expansion worker: unset or unknown timezone means UTC
    v_tz := CASE WHEN v_series.timezone IN (SELECT name FROM pg_timezone_names)
                 THEN v_series.timezone ELSE 'UTC' END;

    IF v_series.rrule !~* '(^|;)BY[A-Z]+=' THEN
        v_day_shift := p_new_dtstart::date - p_split_date;
    END IF;

    -- Workflow state never propagates through a template
    FOR v_key, v_value IN
        SELECT * FROM jsonb_each(metadata.strip_series_status_columns(v_series.entity_table, p_template))
    LOOP
        IF v_key NOT IN ('time_slot', p_time_slot_property) THEN
            v_set_clause := v_set_clause || format(', %I = %L', v_key, v_value #>> '{}');
        END IF;
    END LOOP;

    -- These writes are the series' own: they must not mark occurrences as edited
    PERFORM set_config('civic_os.series_write', 'on', true);

    -- Every re-linked instance (the edited one on the split date and exceptions too)
    -- is a scheduled slot of the new version, so its date follows the day shift.
    -- Moving dates forward, go latest first (earliest first backward) so a shifted
    -- slot never lands on a date another row still holds (unique per series).
    FOR v_inst IN
        SELECT id, occurrence_date, entity_id, is_exception
        FROM metadata.time_slot_instances
        WHERE series_id = p_new_series_id
          AND occurrence_date >= p_split_date
        ORDER BY CASE WHEN v_day_shift > 0 THEN p_split_date - occurrence_date ELSE occurrence_date - p_split_date END
    LOOP
        v_new_date := v_inst.occurrence_date + v_day_shift;

        -- Rewrite the record of non-exception occurrences after the split date; the
        -- edited occurrence is saved by the caller, exceptions keep their own data
        IF v_inst.occurrence_date > p_split_date AND NOT v_inst.is_exception AND v_inst.entity_id IS NOT NULL THEN
            v_start := (v_new_date + p_new_dtstart::time) AT TIME ZONE v_tz;
            BEGIN
                EXECUTE format('UPDATE public.%I SET %I = tstzrange($1, $2, ''[)'')%s WHERE id = $3',
                               v_series.entity_table, p_time_slot_property, v_set_clause)
                USING v_start, v_start + p_duration, v_inst.entity_id;
                v_updated := v_updated + 1;
            EXCEPTION WHEN exclusion_violation OR unique_violation THEN
                UPDATE metadata.time_slot_instances
                SET is_exception = TRUE,
                    exception_type = 'conflict_skipped',
                    exception_reason = 'Kept its original time: the new schedule overlaps another record',
                    exception_at = NOW(),
                    exception_by = current_user_id()
                WHERE id = v_inst.id;
                v_conflicts := v_conflicts + 1;
            END;
        END IF;

        IF v_day_shift <> 0 THEN
            UPDATE metadata.time_slot_instances SET occurrence_date = v_new_date WHERE id = v_inst.id;
        END IF;
    END LOOP;

    PERFORM set_config('civic_os.series_write', 'off', true);
    RETURN jsonb_build_object('updated', v_updated, 'conflicts', v_conflicts);
END;
$function$;


REVOKE EXECUTE ON FUNCTION metadata.apply_split_to_future_instances(bigint, date, timestamp without time zone, interval, jsonb, text) FROM PUBLIC;

-- New signature (edited occurrence parameters); callers using the 5 named
-- parameters keep working through the defaults
DROP FUNCTION split_series_from_date(bigint, date, timestamp without time zone, interval, jsonb);

CREATE FUNCTION split_series_from_date(
  p_series_id bigint,
  p_split_date date,
  p_new_dtstart timestamp without time zone,
  p_new_duration interval DEFAULT NULL,
  p_new_template jsonb DEFAULT NULL,
  p_edited_entity_id bigint DEFAULT NULL,
  p_edited_values jsonb DEFAULT NULL
) RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, metadata, postgis
AS $function$
DECLARE
    v_original RECORD;
    v_group_id BIGINT;
    v_new_version INT;
    v_new_series_id BIGINT;
    v_user_id UUID;
    v_count INT;
    v_consumed INT;
    v_future JSONB;
    v_shift INT := 0;
    v_last_before DATE;
    v_set_clause TEXT := '';
    v_key TEXT;
    v_value JSONB;
    v_status_cols TEXT[];
BEGIN
    v_user_id := current_user_id();
    IF v_user_id IS NULL AND NOT metadata._is_db_admin() THEN
        RAISE EXCEPTION 'Authentication required';
    END IF;

    SELECT * INTO v_original FROM metadata.time_slot_series WHERE id = p_series_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', FALSE, 'message', 'Series not found');
    END IF;

    -- Occurrence dates of this group the v0.76.9 conversion could not decide
    IF EXISTS (
        SELECT 1 FROM metadata.time_slot_instance_date_repair r
        JOIN metadata.time_slot_series g ON g.id = r.series_id
        WHERE r.status = 'unresolved'
          AND (g.id = p_series_id OR (v_original.group_id IS NOT NULL AND g.group_id = v_original.group_id))
    ) THEN
        RAISE EXCEPTION 'The dates of this series need attention'
            USING HINT = 'An administrator must resolve them first (metadata.time_slot_instance_date_repair, status unresolved)';
    END IF;

    -- Check series ownership or admin (use group or fallback to series created_by)
    IF v_original.group_id IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1 FROM metadata.time_slot_series_groups
            WHERE id = v_original.group_id
              AND (created_by = v_user_id OR is_admin() OR metadata._is_db_admin())
        ) THEN
            RAISE EXCEPTION 'Permission denied'
                USING HINT = 'Must be the series owner or an admin';
        END IF;
    ELSE
        IF NOT (v_original.created_by = v_user_id OR is_admin() OR metadata._is_db_admin()) THEN
            RAISE EXCEPTION 'Permission denied'
                USING HINT = 'Must be the series owner or an admin';
        END IF;
    END IF;

    -- The split rewrites existing records: the caller must be allowed to update them
    IF NOT has_permission(v_original.entity_table::text, 'update') AND NOT metadata._is_db_admin() THEN
        RAISE EXCEPTION 'Permission denied'
            USING HINT = format('Requires %s:update permission', v_original.entity_table);
    END IF;

    -- A version that already ended was split before (e.g. a retried save): reload
    IF v_original.effective_until IS NOT NULL
       OR EXISTS (SELECT 1 FROM metadata.time_slot_series
                  WHERE group_id = v_original.group_id AND id <> p_series_id
                    AND effective_from = p_split_date) THEN
        RAISE EXCEPTION 'This series was already split on %', p_split_date
            USING HINT = 'Reload the record and edit the current version of the series';
    END IF;

    -- Splitting a version on (or before) its own first day would end it before it starts
    IF p_split_date <= v_original.effective_from THEN
        RAISE EXCEPTION 'This is the first occurrence of this version of the series'
            USING HINT = 'Change all occurrences instead';
    END IF;

    IF p_edited_entity_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM metadata.time_slot_instances
        WHERE series_id = p_series_id AND occurrence_date = p_split_date
          AND entity_table = v_original.entity_table AND entity_id = p_edited_entity_id
    ) THEN
        RAISE EXCEPTION 'Record % is not the occurrence of series % on %', p_edited_entity_id, p_series_id, p_split_date;
    END IF;

    -- Without BY* parts the pattern follows dtstart, so the following occurrences
    -- move by the edited occurrence's day offset (see apply_split_to_future_instances)
    IF v_original.rrule !~* '(^|;)BY[A-Z]+=' THEN
        v_shift := p_new_dtstart::date - p_split_date;
    END IF;
    IF v_shift < 0 THEN
        SELECT max(occurrence_date) INTO v_last_before
        FROM metadata.time_slot_instances
        WHERE series_id = p_series_id AND occurrence_date < p_split_date;
        IF v_last_before IS NOT NULL AND p_split_date + v_shift <= v_last_before THEN
            RAISE EXCEPTION 'Moving this occurrence to % would put it on or before the previous occurrence (%)',
                p_split_date + v_shift, v_last_before
                USING HINT = 'Move it to a later date, or change all occurrences instead';
        END IF;
    END IF;
    IF v_shift <> 0 AND EXISTS (
        SELECT 1 FROM metadata.time_slot_instances
        WHERE series_id = p_series_id AND occurrence_date > p_split_date
          AND is_exception AND entity_id IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'Moving the following occurrences to another day would detach occurrences that were edited individually'
            USING HINT = 'Edit those occurrences individually, or change all occurrences instead';
    END IF;

    IF v_original.group_id IS NULL THEN
        INSERT INTO metadata.time_slot_series_groups (display_name, created_by)
        VALUES (COALESCE(v_original.entity_template->>'purpose', 'Recurring Schedule'), v_user_id)
        RETURNING id INTO v_group_id;

        UPDATE metadata.time_slot_series
        SET group_id = v_group_id, version_number = 1
        WHERE id = p_series_id;
    ELSE
        v_group_id := v_original.group_id;
    END IF;

    SELECT COALESCE(MAX(version_number), 0) + 1 INTO v_new_version
    FROM metadata.time_slot_series WHERE group_id = v_group_id;

    UPDATE metadata.time_slot_series
    SET effective_until = (p_split_date - INTERVAL '1 day')::DATE,
        rrule = metadata.modify_rrule_until(v_original.rrule, (p_split_date - INTERVAL '1 day')::DATE)
    WHERE id = p_series_id;

    -- The new version keeps the original status: workflow never propagates via templates
    IF p_new_template IS NOT NULL THEN
        p_new_template := v_original.entity_template
            || metadata.strip_series_status_columns(v_original.entity_table, p_new_template)
            - 'time_slot' - v_original.time_slot_property::text;
        PERFORM metadata.validate_entity_template(v_original.entity_table, p_new_template);
    END IF;

    INSERT INTO metadata.time_slot_series (
        group_id, version_number, effective_from, entity_table,
        entity_template, rrule, dtstart, duration, timezone,
        time_slot_property, status, created_by
    ) VALUES (
        v_group_id, v_new_version, p_split_date, v_original.entity_table,
        COALESCE(p_new_template, v_original.entity_template),
        v_original.rrule, p_new_dtstart,
        COALESCE(p_new_duration, v_original.duration),
        v_original.timezone, v_original.time_slot_property,
        'active', v_user_id
    ) RETURNING id INTO v_new_series_id;

    -- Re-link the original version's instances on/after the split date to the new
    -- version (v0.38.5 behavior, dropped by the v0.76.5 rewrite). Without this, the
    -- old version keeps its already-expanded future occurrences and the worker expands
    -- the new version on the same dates: every following occurrence is doubled.
    UPDATE metadata.time_slot_instances
    SET series_id = v_new_series_id
    WHERE series_id = p_series_id
      AND occurrence_date >= p_split_date;

    -- COUNT is a total for the whole series: the new version gets what is left after
    -- the occurrences before the split date (all expanded, since the split date is an
    -- expanded occurrence and expansion is contiguous from dtstart)
    v_count := substring(v_original.rrule FROM '(?i)(?:^|;)COUNT=(\d+)')::INT;
    IF v_count IS NOT NULL THEN
        SELECT count(*) INTO v_consumed
        FROM metadata.time_slot_instances
        WHERE series_id = p_series_id AND occurrence_date < p_split_date;

        UPDATE metadata.time_slot_series
        SET rrule = regexp_replace(rrule, '(?i)((?:^|;)COUNT=)\d+', '\1' || GREATEST(v_count - v_consumed, 1))
        WHERE id = v_new_series_id;
    END IF;

    -- Move the following non-exception occurrences onto the new schedule and template
    v_future := metadata.apply_split_to_future_instances(
        v_new_series_id, p_split_date, p_new_dtstart,
        COALESCE(p_new_duration, v_original.duration),
        COALESCE(p_new_template, v_original.entity_template),
        v_original.time_slot_property);

    -- Save the edited occurrence in the same transaction (atomic with the split)
    IF p_edited_entity_id IS NOT NULL AND p_edited_values IS NOT NULL AND p_edited_values <> '{}'::jsonb THEN
        PERFORM metadata.validate_entity_template(v_original.entity_table, p_edited_values - 'id');
        FOR v_key, v_value IN SELECT * FROM jsonb_each(p_edited_values - 'id')
        LOOP
            IF v_set_clause <> '' THEN v_set_clause := v_set_clause || ', '; END IF;
            v_set_clause := v_set_clause || format('%I = %L', v_key, v_value #>> '{}');
        END LOOP;
        PERFORM set_config('civic_os.series_write', 'on', true);
        EXECUTE format('UPDATE public.%I SET %s WHERE id = $1', v_original.entity_table, v_set_clause)
        USING p_edited_entity_id;
        PERFORM set_config('civic_os.series_write', 'off', true);

        -- A status change on this occurrence is its own, not the series': an exception
        v_status_cols := metadata.series_status_columns(v_original.entity_table);
        IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_edited_values) k WHERE k = ANY (v_status_cols)) THEN
            UPDATE metadata.time_slot_instances
            SET is_exception = TRUE, exception_type = 'modified', exception_at = NOW(), exception_by = v_user_id
            WHERE series_id = v_new_series_id AND entity_id = p_edited_entity_id;
        END IF;
    END IF;

    RETURN jsonb_build_object(
        'success', TRUE, 'original_series_id', p_series_id,
        'new_series_id', v_new_series_id, 'group_id', v_group_id,
        'split_date', p_split_date,
        'future_updated', v_future->'updated', 'future_conflicts', v_future->'conflicts',
        'edited_entity_id', p_edited_entity_id
    );
END;
$function$;

REVOKE EXECUTE ON FUNCTION split_series_from_date(bigint, date, timestamp without time zone, interval, jsonb, bigint, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION split_series_from_date(bigint, date, timestamp without time zone, interval, jsonb, bigint, jsonb) TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
