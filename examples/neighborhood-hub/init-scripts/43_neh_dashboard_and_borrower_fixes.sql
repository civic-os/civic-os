-- Neighborhood Engagement Hub - Dashboard markup cleanup and borrower visibility
--
-- Three unrelated repairs that surfaced together while reviewing the dashboards.
--
--   1. Heading levels. The dashboard page renders the dashboard name as the page
--      h1, so a markdown widget that opens with a level-1 heading gives the page
--      a second h1. Script 13 put one on the default dashboard (renamed
--      "Neighborhood Engagement Hub") and script 10 put one on "NEH Borrower".
--      A leading "# " becomes "## ". Deeper headings are left alone, as are
--      level-1 headings further down in the text.
--
--   2. Dead config keys. Script 10 wrote config.entity, config.filter and
--      config.columns on the filtered_list widgets. The widget reads the
--      entity_key column, config.filters and config.showColumns instead, so
--      the old keys do nothing and only mislead anyone reading the config.
--      They are removed. Calendar config.entityKey is a different, live key
--      and is not touched.
--
--   3. Borrowers see their own requests. The guided form policy
--      gf_owner_select on tool_reservations, building_use_requests and
--      mek_requests shows a row only to the user who created it. When staff
--      create a request on a borrower's behalf, that borrower never sees it,
--      including on the "My ..." dashboard lists. A second SELECT policy lets
--      a borrower read every row that names them as borrower_id. Policies are
--      OR'd, so the gf_* policies stay exactly as they are.
--      current_borrower_id() returns NULL for a user with no borrower record,
--      and borrower_id = NULL matches no row, so such users gain nothing.
--
-- Widgets are matched by dashboard name and content, never by id, because ids
-- differ between instances. Safe to re-run: after the first run nothing matches.

BEGIN;

DO $$
DECLARE
    v_headings INT;
    v_keys     INT;
    v_left     TEXT;
    v_policies INT;
    v_table    TEXT;
BEGIN
    -- 1. Demote a leading level-1 heading in markdown widgets
    UPDATE metadata.dashboard_widgets w
    SET config = jsonb_set(w.config, '{content}',
                           to_jsonb(regexp_replace(w.config->>'content', '^# ', '## '))),
        updated_at = NOW()
    FROM metadata.dashboards d
    WHERE d.id = w.dashboard_id
      AND d.display_name IN ('Neighborhood Engagement Hub', 'NEH Borrower', 'NEH Staff', 'NEH Admin')
      AND w.widget_type = 'markdown'
      AND w.config->>'content' ~ '^# ';

    GET DIAGNOSTICS v_headings = ROW_COUNT;

    -- 2. Remove config keys that no widget code reads
    UPDATE metadata.dashboard_widgets w
    SET config = w.config - 'entity' - 'filter' - 'columns',
        updated_at = NOW()
    FROM metadata.dashboards d
    WHERE d.id = w.dashboard_id
      AND d.display_name IN ('Neighborhood Engagement Hub', 'NEH Borrower', 'NEH Staff', 'NEH Admin')
      AND w.widget_type = 'filtered_list'
      AND w.config ?| ARRAY['entity', 'filter', 'columns'];

    GET DIAGNOSTICS v_keys = ROW_COUNT;

    -- 3. Borrowers read the rows that name them, whoever created the row
    FOREACH v_table IN ARRAY ARRAY['tool_reservations', 'building_use_requests', 'mek_requests'] LOOP
        EXECUTE format('DROP POLICY IF EXISTS borrower_select ON public.%I', v_table);
        EXECUTE format(
            'CREATE POLICY borrower_select ON public.%I FOR SELECT TO authenticated '
            'USING (borrower_id = (SELECT current_borrower_id()))', v_table);
    END LOOP;

    -- Closing assertions
    SELECT string_agg(w.id::text, ', ' ORDER BY w.id) INTO v_left
    FROM metadata.dashboard_widgets w
    JOIN metadata.dashboards d ON d.id = w.dashboard_id
    WHERE d.display_name IN ('Neighborhood Engagement Hub', 'NEH Borrower', 'NEH Staff', 'NEH Admin')
      AND ((w.widget_type = 'markdown' AND w.config->>'content' ~ '^# ')
        OR (w.widget_type = 'filtered_list' AND w.config ?| ARRAY['entity', 'filter', 'columns']));

    IF v_left IS NOT NULL THEN
        RAISE EXCEPTION 'Widgets still carry a leading h1 or dead config keys: %', v_left;
    END IF;

    SELECT count(*) INTO v_policies
    FROM pg_policies
    WHERE schemaname = 'public'
      AND policyname = 'borrower_select'
      AND tablename IN ('tool_reservations', 'building_use_requests', 'mek_requests');

    IF v_policies <> 3 THEN
        RAISE EXCEPTION 'Expected 3 borrower_select policies, found %', v_policies;
    END IF;

    RAISE NOTICE 'Demoted % markdown headings, cleaned % filtered_list configs, % borrower_select policies in place',
        v_headings, v_keys, v_policies;
END $$;

INSERT INTO metadata.schema_decisions (
    entity_types, migration_id,
    title, status, context, decision, rationale, consequences, decided_date
)
SELECT
    ARRAY['tool_reservations', 'building_use_requests', 'mek_requests']::NAME[],
    'neh-43-borrower-select-policy',
    'Borrowers read their own requests regardless of creator',
    'accepted',
    'The guided form policy gf_owner_select shows a row only to the user in created_by. Staff create '
    'requests on behalf of borrowers, so those borrowers could not see them on their dashboard.',
    'Add a permissive SELECT policy borrower_select on tool_reservations, building_use_requests and '
    'mek_requests for authenticated users: borrower_id = current_borrower_id(). The gf_* policies '
    'are unchanged.',
    'Ownership of a request is the borrower it names, not whoever typed it in. Policies are OR''d, so '
    'creators keep their access. current_borrower_id() is NULL for users without a borrower record, '
    'which matches no rows.',
    'A borrower now reads every tool reservation, building use request and event kit request that '
    'names them. Update and delete rights are unchanged.',
    CURRENT_DATE
WHERE NOT EXISTS (
    SELECT 1 FROM metadata.schema_decisions WHERE migration_id = 'neh-43-borrower-select-policy'
);

COMMIT;
