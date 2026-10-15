-- 15_add_observed_at_timestamp.sql
-- Pothole example: add a DateTime (timestamp WITHOUT time zone) column to Issue.
--
-- Until now no example had a `timestamp` column, so the DateTime property type
-- (wall-clock time, stored and shown exactly as typed, no time-zone conversion)
-- had no end-to-end coverage. Issue.observed_at is the wall-clock time a
-- resident saw the pothole. The data-integrity suite (tests/e2e/integrity.spec.ts)
-- types values into it from two browser time zones and checks with psql that
-- they are stored unshifted. WorkPackage.quote_due_date stays the DateTimeLocal
-- (timestamptz) counterpart.
--
-- Safe to re-run: ADD COLUMN IF NOT EXISTS, ON CONFLICT upserts, and a
-- NOT EXISTS guard on the schema decision.
--
-- Grants: the table-level GRANTs on "Issue" (01_pot_hole_schema.sql) cover new
-- columns, and the existing RLS policies apply unchanged. No functions are added,
-- so nothing needs an EXECUTE grant or a PUBLIC revoke (see 14_revoke_public_execute.sql).

BEGIN;

ALTER TABLE public."Issue"
  ADD COLUMN IF NOT EXISTS observed_at TIMESTAMP WITHOUT TIME ZONE;

COMMENT ON COLUMN public."Issue".observed_at IS
  'Wall-clock date and time the issue was observed. timestamp without time zone: stored exactly as entered, never converted.';

-- Shown on detail, create and edit; kept off the list so list pages stay unchanged.
INSERT INTO metadata.properties (table_name, column_name, display_name, description, sort_order, column_width, show_on_list, show_on_detail, show_on_create, show_on_edit)
VALUES ('Issue', 'observed_at', 'Observed At', 'Local date and time the issue was observed (shown exactly as entered, in every time zone)', 26, 1, FALSE, TRUE, TRUE, TRUE)
ON CONFLICT (table_name, column_name) DO UPDATE
SET display_name = EXCLUDED.display_name,
    description = EXCLUDED.description,
    sort_order = EXCLUDED.sort_order,
    column_width = EXCLUDED.column_width,
    show_on_list = EXCLUDED.show_on_list,
    show_on_detail = EXCLUDED.show_on_detail,
    show_on_create = EXCLUDED.show_on_create,
    show_on_edit = EXCLUDED.show_on_edit;

-- Spanish metadata translations (companion to 13_spanish_translations.sql).
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('property', 'Issue.observed_at.display_name', 'es', 'Observado el'),
('property', 'Issue.observed_at.description', 'es', 'Fecha y hora local en que se observó el problema (se muestra tal como se ingresó, en cualquier zona horaria)')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- Schema decision (direct INSERT: init scripts run without a JWT, so the
-- create_schema_decision() RPC cannot attribute an author).
INSERT INTO metadata.schema_decisions (
    entity_types, property_names, migration_id,
    title, status, context, decision, rationale, consequences, decided_date
)
SELECT
    ARRAY['Issue']::NAME[], ARRAY['observed_at']::NAME[], 'pothole-15-observed-at',
    'Issue.observed_at as timestamp without time zone (DateTime)',
    'accepted',
    'No example instance had a timestamp-without-time-zone column, so the DateTime property type had no end-to-end coverage, while the frontend transforms that handle it are flagged integrity-critical.',
    'Added nullable Issue.observed_at TIMESTAMP WITHOUT TIME ZONE, shown on detail, create and edit but not on the list.',
    'An observation time is a wall-clock reading ("I saw it at 7:30 on Saginaw St"), not an absolute instant, which is exactly what DateTime models. It pairs with the timestamptz WorkPackage.quote_due_date (DateTimeLocal) so one example exercises both transforms.',
    'Issue create, edit and detail pages gain one field and their PostgREST select strings gain observed_at. List pages are unchanged.',
    '2026-10-15'
WHERE NOT EXISTS (
    SELECT 1 FROM metadata.schema_decisions
    WHERE migration_id = 'pothole-15-observed-at' AND property_names = ARRAY['observed_at']::NAME[]
);

COMMIT;

NOTIFY pgrst, 'reload schema';
