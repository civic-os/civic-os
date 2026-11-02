-- Neighborhood Engagement Hub - Dashboard widget titles
--
-- Script 10 put filtered_list titles in config.title, which nothing reads: the
-- widget container renders the title column, and get_dashboard() returns only
-- that column. Calendars and nav buttons never had one. Every widget rendered
-- without a heading, so an empty list gave no sign of what it was for.
--
-- This script:
--   1. Deletes duplicate calendars. Script 22 inserts the Event Kit calendars
--      without a guard, so running it twice left two copies on each dashboard.
--   2. Sets the title column on every list, calendar and nav widget, and removes
--      the unused config.title key.
--   3. Aborts if any of those widgets is still untitled.
--
-- Markdown widgets stay untitled: their content carries its own heading.
--
-- Widgets are matched by dashboard, type, entity and the old config.title, never
-- by id or filter, because those differ between instances. Titles are only set
-- where the column is NULL, so edits made in the UI survive. Safe to re-run.

BEGIN;

DO $$
DECLARE
    v_deleted INT;
    v_titled  INT;
    v_missing TEXT;
BEGIN
    DELETE FROM metadata.dashboard_widgets dup
    USING metadata.dashboard_widgets orig, metadata.dashboards d
    WHERE d.id = dup.dashboard_id
      AND d.display_name IN ('NEH Borrower', 'NEH Staff', 'NEH Admin')
      AND dup.widget_type = 'calendar'
      AND orig.dashboard_id = dup.dashboard_id
      AND orig.widget_type = dup.widget_type
      AND orig.sort_order = dup.sort_order
      AND orig.config = dup.config
      AND orig.id < dup.id;

    GET DIAGNOSTICS v_deleted = ROW_COUNT;

    WITH titles (dashboard, widget_type, entity, source_title, title) AS (
        VALUES
            -- Borrower: "My" lists are limited to the borrower's own rows by RLS
            ('NEH Borrower', 'nav_buttons',   NULL,                    NULL,                            'Start a Request'),
            ('NEH Borrower', 'filtered_list', 'tool_reservations',     'My Tool Reservations',          'My Tool Reservations'),
            ('NEH Borrower', 'filtered_list', 'building_use_requests', 'My Building Use Requests',      'My Building Use Requests'),
            ('NEH Borrower', 'filtered_list', 'mek_requests',          'My Event Kit Requests',         'My Event Kit Requests'),

            -- Staff
            ('NEH Staff',    'nav_buttons',   NULL,                    NULL,                            'Quick Actions'),
            ('NEH Staff',    'filtered_list', 'tool_reservations',     'Pending Tool Reservations',     'Tool Reservations Awaiting Approval'),
            ('NEH Staff',    'filtered_list', 'building_use_requests', 'Pending Building Use Requests', 'Building Use Requests Awaiting Approval'),
            ('NEH Staff',    'filtered_list', 'mek_requests',          'Pending Event Kit Requests',    'Event Kit Requests Awaiting Approval'),
            ('NEH Staff',    'filtered_list', 'borrowers',             'Pending Borrower Approvals',    'Borrowers Awaiting Approval'),
            ('NEH Staff',    'filtered_list', 'tool_reservations',     'Approved - Awaiting Checkout',  'Approved Tools Awaiting Checkout'),
            ('NEH Staff',    'filtered_list', 'tool_reservations',     'Currently Checked Out',         'Tools Currently Checked Out'),
            ('NEH Staff',    'calendar',      'tool_reservations',     NULL,                            'Tool Reservation Calendar'),
            ('NEH Staff',    'calendar',      'building_use_requests', NULL,                            'Building Use Calendar'),
            ('NEH Staff',    'calendar',      'mek_requests',          NULL,                            'Event Kit Calendar'),

            -- Admin
            ('NEH Admin',    'nav_buttons',   NULL,                    NULL,                            'Quick Actions'),
            ('NEH Admin',    'filtered_list', 'tool_reservations',     'Pending Tool Reservations',     'Tool Reservations Awaiting Approval'),
            ('NEH Admin',    'filtered_list', 'building_use_requests', 'Pending Building Use Requests', 'Building Use Requests Awaiting Approval'),
            ('NEH Admin',    'filtered_list', 'mek_requests',          'Pending Event Kit Requests',    'Event Kit Requests Awaiting Approval'),
            ('NEH Admin',    'filtered_list', 'tool_reservations',     'Currently Checked Out',         'Tools Currently Checked Out'),
            ('NEH Admin',    'calendar',      'tool_reservations',     NULL,                            'Tool Reservation Calendar'),
            ('NEH Admin',    'calendar',      'building_use_requests', NULL,                            'Building Use Calendar'),
            ('NEH Admin',    'calendar',      'mek_requests',          NULL,                            'Event Kit Calendar')
    )
    UPDATE metadata.dashboard_widgets w
    SET title = t.title,
        config = w.config - 'title',
        updated_at = NOW()
    FROM titles t
    JOIN metadata.dashboards d ON d.display_name = t.dashboard
    WHERE w.dashboard_id = d.id
      AND w.widget_type = t.widget_type
      AND w.title IS NULL
      -- Older calendars hold their entity only in config.entityKey
      AND COALESCE(w.entity_key, w.config->>'entityKey', '') = COALESCE(t.entity, '')
      AND (t.source_title IS NULL OR w.config->>'title' = t.source_title);

    GET DIAGNOSTICS v_titled = ROW_COUNT;

    SELECT string_agg(w.id::text, ', ' ORDER BY w.id) INTO v_missing
    FROM metadata.dashboard_widgets w
    JOIN metadata.dashboards d ON d.id = w.dashboard_id
    WHERE d.display_name IN ('NEH Borrower', 'NEH Staff', 'NEH Admin')
      AND w.widget_type IN ('filtered_list', 'calendar', 'nav_buttons')
      AND w.title IS NULL;

    IF v_missing IS NOT NULL THEN
        RAISE EXCEPTION 'Widgets left without a title: %', v_missing;
    END IF;

    RAISE NOTICE 'Deleted % duplicate calendars, titled % widgets', v_deleted, v_titled;
END $$;

COMMIT;
