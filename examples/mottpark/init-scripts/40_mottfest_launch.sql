-- =============================================================================
-- MOTT FEST - LAUNCH (show the module to clubhouse users)
-- =============================================================================
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- Script 37 builds the Mott Fest dashboards visible only to the
-- mottfest_admin role, so organizers can test on a live instance while
-- clubhouse users see no dashboard change. This script is the launch step:
--   1. "Mott Fest" dashboard becomes public (anonymous visitors included).
--   2. "Thanks for your feedback" dashboard gets a show row for the user
--      role, so every signed-in survey respondent lands on it.
--   3. A Mott Fest banner goes on the default clubhouse dashboard, beside
--      its welcome header: header and banner sit side by side as one column
--      each, so the header drops to one column here, once, when the banner
--      is added.
-- The mottfest_admin show rows from script 37 stay; they change nothing once
-- the dashboard is public.
--
-- Re-runs: the dashboard is made public only while it is non-public, the
-- user row is ON CONFLICT DO NOTHING, and the banner is added only when no
-- widget on the clubhouse dashboard links to the Mott Fest dashboard. An
-- admin who later makes the dashboard non-public again should not re-run
-- this script. Production runs this file as 37_mottfest_launch.sql, last.
--
-- Requires: 37 (Mott Fest dashboards)
-- =============================================================================

BEGIN;

DO $$
DECLARE
    v_mottfest_id   INT;
    v_thanks_id     INT;
    v_main_id       INT;
    v_after         INT;
    v_role_user     SMALLINT;
BEGIN
    SELECT id INTO v_mottfest_id FROM metadata.dashboards
     WHERE display_name = 'Mott Fest' ORDER BY id LIMIT 1;
    IF v_mottfest_id IS NULL THEN
        RAISE EXCEPTION 'Mott Fest dashboard not found: run the dashboards and menu script first';
    END IF;

    -- 1. Public Mott Fest dashboard
    UPDATE metadata.dashboards SET is_public = TRUE
     WHERE id = v_mottfest_id AND NOT is_public;

    -- 2. Thanks page for every signed-in user
    SELECT id INTO v_thanks_id FROM metadata.dashboards
     WHERE display_name = 'Thanks for your feedback' ORDER BY id LIMIT 1;
    SELECT id INTO v_role_user FROM metadata.roles WHERE role_key = 'user';
    IF v_thanks_id IS NOT NULL AND v_role_user IS NOT NULL THEN
        INSERT INTO metadata.dashboard_roles (dashboard_id, role_id, mode)
        VALUES (v_thanks_id, v_role_user, 'show')
        ON CONFLICT DO NOTHING;
    END IF;

    -- 3. Banner on the default clubhouse dashboard
    SELECT id INTO v_main_id FROM metadata.dashboards
     WHERE display_name = 'Mott Park Clubhouse Reservations'
     ORDER BY id LIMIT 1;

    IF v_main_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM metadata.dashboard_widgets
         WHERE dashboard_id = v_main_id
           AND config->>'content' LIKE '%/dashboard/' || v_mottfest_id || '"%'
    ) THEN
        -- The welcome header is the first untitled markdown widget; the
        -- banner goes right after it (or first, if there is none).
        SELECT sort_order INTO v_after FROM metadata.dashboard_widgets
         WHERE dashboard_id = v_main_id AND widget_type = 'markdown'
           AND COALESCE(title, '') = ''
         ORDER BY sort_order, id LIMIT 1;
        v_after := COALESCE(v_after, 0);

        UPDATE metadata.dashboard_widgets
           SET sort_order = sort_order + 1
         WHERE dashboard_id = v_main_id AND sort_order > v_after;

        UPDATE metadata.dashboard_widgets
           SET width = 1
         WHERE dashboard_id = v_main_id AND sort_order = v_after
           AND widget_type = 'markdown' AND COALESCE(title, '') = '' AND width = 2;

        INSERT INTO metadata.dashboard_widgets (dashboard_id, widget_type, title, config, sort_order, width, height)
        VALUES (v_main_id, 'markdown', NULL, jsonb_build_object('enableHtml', TRUE, 'content', format(
'## 🎪 Mott Fest

Vendors, food trucks, and sponsors: apply for Mott Fest right here.

<a href="/dashboard/%s" class="btn btn-secondary">Mott Fest info & applications</a>', v_mottfest_id)),
            v_after + 1, 1, 1);
    END IF;
END $$;

COMMIT;

-- =============================================================================
-- Schema decisions (outside the transaction; direct INSERT because
-- create_schema_decision() requires a JWT admin context)
-- =============================================================================

INSERT INTO metadata.schema_decisions (entity_types, property_names, migration_id, title, status, context, decision, rationale, consequences, decided_date)
SELECT
    ARRAY['festival', 'vendor_application', 'food_truck_application', 'sponsorship_application', 'feedback_submission']::NAME[], NULL,
    '40_mottfest_launch',
    'Staged Mott Fest launch: dashboards for organizers first, then a launch script',
    'accepted',
    'The module goes onto the live clubhouse instance before Mott Fest opens, so organizers can test it there. Clubhouse users should see no change to their dashboards or landing page until launch.',
    'Script 37 creates the Mott Fest and Thanks dashboards non-public with dashboard_roles show rows for mottfest_admin only, and adds no banner. A separate launch script, run last, makes Mott Fest public, grants Thanks to user and adds the landing-page banner. The menu heading is not staged: it shows from script 37 on.',
    'Dashboard visibility is per role (v0.80.3), so organizers see the finished dashboards on the real instance while nobody else does. Keeping the switch in one short script makes launch a single, reviewable step. The menu cannot be hidden per role (is_hidden applies to everyone, admins included), and an early Mott Fest heading with empty lists was judged acceptable.',
    'Before launch, applicant-side testing on the live instance happens through organizer accounts, which read every application; owner-only access is covered by the functional test. Survey respondents without mottfest_admin cannot open the Thanks page until launch. Re-running script 37 after launch never makes the dashboard non-public again.',
    CURRENT_DATE
WHERE NOT EXISTS (
    SELECT 1 FROM metadata.schema_decisions
    WHERE migration_id = '40_mottfest_launch'
      AND title = 'Staged Mott Fest launch: dashboards for organizers first, then a launch script'
);

INSERT INTO metadata.schema_decisions (entity_types, property_names, migration_id, title, status, context, decision, rationale, consequences, decided_date)
SELECT
    ARRAY['festival', 'vendor_application', 'food_truck_application', 'sponsorship_application']::NAME[], NULL,
    '40_mottfest_launch',
    'Mott Fest banner on the default clubhouse dashboard',
    'accepted',
    'Most visitors land on the clubhouse dashboard and would not find the Mott Fest dashboard in the selector. Dashboards cannot be menu nodes.',
    'Insert a one-column markdown banner, headed like the clubhouse welcome header, linking to the Mott Fest dashboard directly after that header, shifting later widgets down by one, and narrow the header to one column so the two sit side by side. Find the dashboard by title and the header as its first untitled markdown widget; skip the insert when a widget already links to the Mott Fest dashboard.',
    'The banner is the shortest path from the landing page to the applications, for anonymous visitors too. Finding widgets by title and content, never by id, keeps the script working on production, where ids differ.',
    'Admins can edit or delete the banner. A re-run re-adds it only if no widget links to the Mott Fest dashboard any more.',
    CURRENT_DATE
WHERE NOT EXISTS (
    SELECT 1 FROM metadata.schema_decisions
    WHERE migration_id = '40_mottfest_launch'
      AND title = 'Mott Fest banner on the default clubhouse dashboard'
);
