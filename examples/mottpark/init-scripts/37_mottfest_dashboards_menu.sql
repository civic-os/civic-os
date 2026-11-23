-- =============================================================================
-- MOTT FEST - DASHBOARDS, BANNER AND MENU
-- =============================================================================
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- Adds the Mott Fest user interface on top of scripts 34-36, staged so that
-- clubhouse users see no dashboard change until launch:
--   1. "Mott Fest" dashboard: festival facts, Apply and Already Applied
--      buttons, sponsorship levels. Created non-public and shown only to the
--      mottfest_admin role; 40_mottfest_launch.sql makes it public.
--   2. "Mott Fest Management" dashboard (non-public, shown to the
--      mottfest_admin role through metadata.dashboard_roles): pending and
--      awaiting-payment queues per pipeline, revenue and status charts, and
--      the feedback survey link to email out.
--   3. "Thanks for your feedback" dashboard (non-public, hidden from the
--      selector where core supports it). The feedback survey link returns
--      here through ?returnTo=. Shown to mottfest_admin until
--      40_mottfest_launch.sql grants it to every signed-in user.
--   4. (The Mott Fest banner on the default clubhouse dashboard is added by
--      40_mottfest_launch.sql.)
--   5. A "Mott Fest" menu heading with the module's entities, plus hidden
--      nodes for the module's helper views so they never show as unplaced
--      root entries.
--
-- RE-RUNS KEEP ADMIN EDITS. Every object is insert-if-missing:
--   - a dashboard is found by display_name; if it exists, neither it nor
--     its widgets are touched (rename it and a re-run adds a second copy);
--   - an existing dashboard's is_public is never changed, so a re-run
--     after launch does not hide the launched dashboard again;
--   - menu nodes use ON CONFLICT (node_key) DO NOTHING, so an admin's
--     reordering, renaming or hiding in /admin/menu survives.
--
-- Portability: every target is found by title, role_key or table name, never
-- by id, and nothing is created for a missing target. The clubhouse menu
-- layout is not this script's concern (example script 32 owns it).
--
-- Staged launch: the menu heading shows from this script on (its lists are
-- empty for clubhouse users). The Mott Fest dashboard, the Thanks page for
-- applicants and the landing-page banner appear only when 40_mottfest_launch.sql
-- runs.
--
-- Requires: Civic OS v0.80.3+ (dashboard_roles), v0.81.0+ (menu_nodes).
--           v0.82.0+ hides the Thanks dashboard from the selector
--           (show_in_selector); on older cores it stays listed.
--           Scripts 34-36.
-- =============================================================================

BEGIN;

DO $$
DECLARE
    v_mottfest_id   INT;
    v_mgmt_id       INT;
    v_thanks_id     INT;
    v_after         INT;
    v_role_admin    SMALLINT;
BEGIN
    SELECT id INTO v_role_admin FROM metadata.roles WHERE role_key = 'mottfest_admin';

    -- -------------------------------------------------------------------------
    -- 3. Thanks dashboard (created first: the Management widget links to it)
    -- -------------------------------------------------------------------------
    SELECT id INTO v_thanks_id FROM metadata.dashboards
     WHERE display_name = 'Thanks for your feedback'
     ORDER BY id LIMIT 1;

    IF v_thanks_id IS NULL THEN
        INSERT INTO metadata.dashboards (display_name, description, is_default, is_public, sort_order, show_title)
        VALUES ('Thanks for your feedback',
                'Shown after a Mott Fest feedback survey is submitted.',
                FALSE, FALSE, 99, FALSE)
        RETURNING id INTO v_thanks_id;

        -- v0.82.0+: keep it out of the dashboard selector. Older cores lack
        -- the column; the dashboard then stays listed for signed-in users.
        IF EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'metadata' AND table_name = 'dashboards'
                      AND column_name = 'show_in_selector') THEN
            EXECUTE 'UPDATE metadata.dashboards SET show_in_selector = FALSE WHERE id = $1'
              USING v_thanks_id;
        END IF;

        -- Buttons are nav_buttons widgets, never HTML links in markdown: a
        -- routerLink keeps the app loaded, where <a href> reloads the page.
        INSERT INTO metadata.dashboard_widgets (dashboard_id, widget_type, title, config, sort_order, width, height) VALUES
        (v_thanks_id, 'markdown', NULL, jsonb_build_object('content',
'## 🎪 Thanks for your feedback!

Your answers help us plan next year''s Mott Fest. They are anonymous: we don''t record who sent them.'),
            1, 2, 1),
        (v_thanks_id, 'nav_buttons', NULL, jsonb_build_object('buttons', jsonb_build_array(
            jsonb_build_object('text', 'Back to home', 'url', '/', 'icon', 'home', 'variant', 'primary'))),
            2, 2, 1);
    END IF;

    -- Organizers until launch; the launch script adds the user row.
    IF v_role_admin IS NOT NULL THEN
        INSERT INTO metadata.dashboard_roles (dashboard_id, role_id, mode)
        VALUES (v_thanks_id, v_role_admin, 'show')
        ON CONFLICT DO NOTHING;
    END IF;

    -- -------------------------------------------------------------------------
    -- 1. Mott Fest dashboard (organizers until launch, then public)
    -- -------------------------------------------------------------------------
    SELECT id INTO v_mottfest_id FROM metadata.dashboards
     WHERE display_name = 'Mott Fest'
     ORDER BY id LIMIT 1;

    IF v_mottfest_id IS NULL THEN
        INSERT INTO metadata.dashboards (display_name, description, is_default, is_public, sort_order, show_title)
        VALUES ('Mott Fest',
                'Mott Park''s neighborhood summer festival: festival details and vendor, food truck and sponsor applications.',
                FALSE, FALSE, 3, TRUE)
        RETURNING id INTO v_mottfest_id;

        INSERT INTO metadata.dashboard_widgets (dashboard_id, widget_type, entity_key, title, config, sort_order, width, height) VALUES
        (v_mottfest_id, 'markdown', NULL, NULL, jsonb_build_object('content',
'## 🎪 Mott Fest

Mott Fest is Mott Park''s neighborhood summer festival in Flint, celebrating our community''s natural beauty, food, and art — with live music, food trucks, a beer garden, vendors, and activities for kids. Mott Fest helps current and former neighbors connect and celebrate the good in our community.'),
            1, 2, 1),
        (v_mottfest_id, 'filtered_list', 'current_festival', 'This Year''s Festival', jsonb_build_object(
            'filters', '[]'::jsonb,
            'limit', 1,
            'showColumns', jsonb_build_array('display_name', 'event_date', 'event_hours', 'location',
                                             'applications_close_at', 'vendor_fee', 'food_truck_fee', 'payment_due_date'),
            'emptyMessage', 'Applications aren''t open yet. Check back soon!',
            'showSeeMore', FALSE),
            2, 2, 1),
        (v_mottfest_id, 'nav_buttons', NULL, 'Apply', jsonb_build_object(
            'description', 'You''ll be asked to sign in or create a free account. Prefer paper? Mail the sponsorship form with a check to Mott Park Recreation Association, 2401 Nolen Dr., Flint, MI 48504.',
            'buttons', jsonb_build_array(
                jsonb_build_object('text', 'Apply as a Booth Vendor', 'url', '/create/vendor_application', 'icon', 'storefront', 'variant', 'primary'),
                jsonb_build_object('text', 'Apply as a Food Truck', 'url', '/create/food_truck_application', 'icon', 'local_shipping', 'variant', 'primary'),
                jsonb_build_object('text', 'Become a Sponsor', 'url', '/create/sponsorship_application', 'icon', 'handshake', 'variant', 'secondary'))),
            3, 1, 1),
        (v_mottfest_id, 'nav_buttons', NULL, 'Already Applied?', jsonb_build_object(
            'description', 'Our committee reviews each application and emails you. Pay online or by check, due one month before the festival.',
            'buttons', jsonb_build_array(
                jsonb_build_object('text', 'My Booth Vendor Applications', 'url', '/view/vendor_application', 'icon', 'storefront'),
                jsonb_build_object('text', 'My Food Truck Applications', 'url', '/view/food_truck_application', 'icon', 'local_shipping'),
                jsonb_build_object('text', 'My Sponsorships', 'url', '/view/sponsorship_application', 'icon', 'handshake'))),
            4, 1, 1),
        (v_mottfest_id, 'markdown', NULL, 'Sponsorship Levels', jsonb_build_object('content',
'| Level | Recognition |
|---|---|
| Individual — $100 | Celebrated on a donor board in the Clubhouse; Mott Fest t-shirt |
| Corporate — $250 | Thanked on social media; Mott Fest t-shirt |
| Corporate — $500 | Named on t-shirts; thanked on social media; Mott Fest t-shirt |
| Corporate — $1,000 | Named on a large banner at Mott Fest; named on t-shirts; thanked on social media; Mott Fest t-shirt |
| Presenting Sponsor — $2,500 | Named on the official poster as presenting sponsor; 3 minutes on the microphone during Mott Fest; use of the clubhouse for 3 events this year; and all of the above |
| Custom Amount | Any amount you choose |
| In-Kind Gift | Goods or services for the festival |'),
            5, 2, 1);
    END IF;

    IF v_role_admin IS NOT NULL THEN
        INSERT INTO metadata.dashboard_roles (dashboard_id, role_id, mode)
        VALUES (v_mottfest_id, v_role_admin, 'show')
        ON CONFLICT DO NOTHING;
    END IF;

    -- -------------------------------------------------------------------------
    -- 2. Mott Fest Management dashboard (non-public, mottfest_admin)
    -- -------------------------------------------------------------------------
    -- Widgets filter on status only, never on a festival id: Mark Completed
    -- refuses while pending or approved-unpaid rows remain, so a finished
    -- festival never leaves rows in these queues.
    SELECT id INTO v_mgmt_id FROM metadata.dashboards
     WHERE display_name = 'Mott Fest Management'
     ORDER BY id LIMIT 1;

    IF v_mgmt_id IS NULL THEN
        INSERT INTO metadata.dashboards (display_name, description, is_default, is_public, sort_order, show_title)
        VALUES ('Mott Fest Management',
                'Mott Fest review queues, payments and revenue for organizers.',
                FALSE, FALSE, 4, TRUE)
        RETURNING id INTO v_mgmt_id;

        INSERT INTO metadata.dashboard_widgets (dashboard_id, widget_type, entity_key, title, config, sort_order, width, height) VALUES
        -- Row 1: review queues, oldest first
        (v_mgmt_id, 'filtered_list', 'vendor_application', '⏳ Pending Booth Vendors', jsonb_build_object(
            'filters', jsonb_build_array(jsonb_build_object('column', 'status_id.status_key', 'operator', 'eq', 'value', 'pending')),
            'orderBy', 'created_at', 'orderDirection', 'asc', 'limit', 10,
            'showColumns', jsonb_build_array('display_name', 'contact_name', 'vendor_type_id', 'created_at'),
            'emptyMessage', 'No booth vendor applications waiting for review'),
            1, 1, 1),
        (v_mgmt_id, 'filtered_list', 'food_truck_application', '⏳ Pending Food Trucks', jsonb_build_object(
            'filters', jsonb_build_array(jsonb_build_object('column', 'status_id.status_key', 'operator', 'eq', 'value', 'pending')),
            'orderBy', 'created_at', 'orderDirection', 'asc', 'limit', 10,
            'showColumns', jsonb_build_array('display_name', 'contact_name', 'created_at'),
            'emptyMessage', 'No food truck applications waiting for review'),
            2, 1, 1),
        (v_mgmt_id, 'filtered_list', 'sponsorship_application', '⏳ Pending Sponsorships', jsonb_build_object(
            'filters', jsonb_build_array(jsonb_build_object('column', 'status_id.status_key', 'operator', 'eq', 'value', 'pending')),
            'orderBy', 'created_at', 'orderDirection', 'asc', 'limit', 10,
            'showColumns', jsonb_build_array('display_name', 'contact_name', 'tier_id', 'created_at'),
            'emptyMessage', 'No sponsorships waiting for review'),
            3, 2, 1),
        -- Row 2: approved, not yet paid
        (v_mgmt_id, 'filtered_list', 'vendor_application', '💳 Booth Vendors Awaiting Payment', jsonb_build_object(
            'filters', jsonb_build_array(jsonb_build_object('column', 'status_id.status_key', 'operator', 'eq', 'value', 'approved')),
            'orderBy', 'reviewed_at', 'orderDirection', 'asc', 'limit', 10,
            'showColumns', jsonb_build_array('display_name', 'amount_due', 'reviewed_at'),
            'emptyMessage', 'No booth vendors awaiting payment'),
            4, 1, 1),
        (v_mgmt_id, 'filtered_list', 'food_truck_application', '💳 Food Trucks Awaiting Payment', jsonb_build_object(
            'filters', jsonb_build_array(jsonb_build_object('column', 'status_id.status_key', 'operator', 'eq', 'value', 'approved')),
            'orderBy', 'reviewed_at', 'orderDirection', 'asc', 'limit', 10,
            'showColumns', jsonb_build_array('display_name', 'amount_due', 'reviewed_at'),
            'emptyMessage', 'No food trucks awaiting payment'),
            5, 1, 1),
        (v_mgmt_id, 'filtered_list', 'sponsorship_application', '💳 Sponsorships Awaiting Payment', jsonb_build_object(
            'filters', jsonb_build_array(jsonb_build_object('column', 'status_id.status_key', 'operator', 'eq', 'value', 'approved')),
            'orderBy', 'reviewed_at', 'orderDirection', 'asc', 'limit', 10,
            'showColumns', jsonb_build_array('display_name', 'amount_due', 'reviewed_at'),
            'emptyMessage', 'No sponsorships awaiting payment'),
            6, 2, 1),
        -- Row 3: current festival totals
        (v_mgmt_id, 'chart', 'mottfest_current_summary', 'Revenue by Pipeline', jsonb_build_object(
            'labelColumn', 'pipeline',
            'valueColumns', jsonb_build_array('total_paid'),
            'seriesLabels', jsonb_build_array('Paid ($)'),
            'orderBy', 'pipeline_no', 'orderDirection', 'asc',
            'yAxisLabel', 'Dollars'),
            7, 1, 2),
        (v_mgmt_id, 'chart', 'mottfest_current_summary', 'Applications by Status', jsonb_build_object(
            'labelColumn', 'pipeline',
            'valueColumns', jsonb_build_array('pending', 'approved_unpaid', 'paid', 'waived', 'in_kind'),
            'seriesLabels', jsonb_build_array('Pending', 'Approved, unpaid', 'Paid', 'Waived', 'In-kind'),
            'orderBy', 'pipeline_no', 'orderDirection', 'asc',
            'yAxisLabel', 'Applications'),
            8, 1, 2),
        -- Row 4: organizer links
        (v_mgmt_id, 'nav_buttons', NULL, 'Organizer Links', jsonb_build_object('buttons', jsonb_build_array(
            jsonb_build_object('text', 'Revenue Summary (all festivals)', 'url', '/view/mottfest_revenue_summary', 'icon', 'payments'),
            jsonb_build_object('text', 'Festivals', 'url', '/view/festival', 'icon', 'festival'),
            jsonb_build_object('text', 'Feedback', 'url', '/view/feedback_response', 'icon', 'reviews'))),
            9, 2, 1),
        (v_mgmt_id, 'markdown', NULL, 'Feedback Survey Link', jsonb_build_object('content', format(
'After the festival, email this link to vendors, food trucks and sponsors. Answers are anonymous.

`<your site address>/create/feedback_submission?returnTo=/dashboard/%s`', v_thanks_id)),
            10, 2, 1);
    END IF;

    -- Thank-yous due (story S8): paid or in-kind sponsorships with no
    -- Thank-You Sent date. The Filters panel cannot express "date is empty",
    -- so this widget and its "See more" link are the organizer's path to the
    -- list. Added on its own, after the status chart, when no widget on the
    -- dashboard filters on thank_you_sent yet, so dashboards built by an
    -- earlier run get it and an admin's renamed copy is not duplicated.
    IF NOT EXISTS (
        SELECT 1 FROM metadata.dashboard_widgets
         WHERE dashboard_id = v_mgmt_id
           AND entity_key = 'sponsorship_application'
           AND config->'filters' @> '[{"column": "thank_you_sent"}]'
    ) THEN
        SELECT sort_order INTO v_after FROM metadata.dashboard_widgets
         WHERE dashboard_id = v_mgmt_id AND title = 'Applications by Status'
         ORDER BY sort_order, id LIMIT 1;
        IF v_after IS NULL THEN
            SELECT COALESCE(MAX(sort_order), 0) INTO v_after
              FROM metadata.dashboard_widgets WHERE dashboard_id = v_mgmt_id;
        END IF;

        UPDATE metadata.dashboard_widgets
           SET sort_order = sort_order + 1
         WHERE dashboard_id = v_mgmt_id AND sort_order > v_after;

        INSERT INTO metadata.dashboard_widgets (dashboard_id, widget_type, entity_key, title, config, sort_order, width, height)
        VALUES (v_mgmt_id, 'filtered_list', 'sponsorship_application', '🙏 Thank-Yous Due', jsonb_build_object(
            'filters', jsonb_build_array(
                jsonb_build_object('column', 'status_id.status_key', 'operator', 'in', 'value', jsonb_build_array('paid', 'in_kind')),
                jsonb_build_object('column', 'thank_you_sent', 'operator', 'is', 'value', NULL)),
            'orderBy', 'reviewed_at', 'orderDirection', 'asc', 'limit', 10,
            'showColumns', jsonb_build_array('display_name', 'contact_name', 'tier_id', 'status_id'),
            'emptyMessage', 'Every paid and in-kind sponsor has been thanked'),
            v_after + 1, 2, 1);
    END IF;

    IF v_role_admin IS NOT NULL THEN
        INSERT INTO metadata.dashboard_roles (dashboard_id, role_id, mode)
        VALUES (v_mgmt_id, v_role_admin, 'show')
        ON CONFLICT DO NOTHING;
    END IF;

END $$;

-- -----------------------------------------------------------------------------
-- 5. Menu: "Mott Fest" heading, plus hidden helper views
-- -----------------------------------------------------------------------------
-- Entity names are singular ("Add Booth Vendor Application", "Festival:
-- Mott Fest 2027"), so entity nodes carry a plural menu label. A NULL label
-- shows the entity's own name. The validate trigger rejects ineligible
-- targets, so only targets that exist are inserted.
INSERT INTO metadata.menu_nodes (node_key, node_kind, display_name, icon, parent_node_key, sort_order, collapsed_by_default)
VALUES ('mottfest', 'heading', 'Mott Fest', 'festival', NULL, 30, FALSE)
ON CONFLICT (node_key) DO NOTHING;

INSERT INTO metadata.menu_nodes (node_key, node_kind, target_key, display_name, parent_node_key, sort_order, is_hidden)
SELECT n.target, 'entity', n.target::NAME, n.label, n.parent, n.sort_order, n.is_hidden
FROM (VALUES
    ('vendor_application',      'Booth Vendor Applications', 'mottfest', 10, FALSE),
    ('food_truck_application',  'Food Truck Applications',   'mottfest', 20, FALSE),
    ('sponsorship_application', 'Sponsorships',              'mottfest', 30, FALSE),
    ('feedback_response',       'Feedback Responses',        'mottfest', 40, FALSE),
    ('festival',                'Festivals',                 'mottfest', 50, FALSE),
    ('mottfest_revenue_summary', NULL,                        'mottfest', 60, FALSE),
    -- Helper views: reached through dashboards and links, never the menu.
    ('current_festival',         NULL,                        NULL,       900, TRUE),
    ('mottfest_current_summary', NULL,                        NULL,       910, TRUE),
    ('feedback_submission',     NULL,                        NULL,       920, TRUE)
) AS n(target, label, parent, sort_order, is_hidden)
WHERE EXISTS (SELECT 1 FROM information_schema.tables t
               WHERE t.table_schema = 'public' AND t.table_name = n.target)
ON CONFLICT (node_key) DO NOTHING;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- =============================================================================
-- Schema decisions (outside the transaction; direct INSERT because
-- create_schema_decision() requires a JWT admin context)
-- =============================================================================

INSERT INTO metadata.schema_decisions (entity_types, property_names, migration_id, title, status, context, decision, rationale, consequences, decided_date)
SELECT
    ARRAY['vendor_application', 'food_truck_application', 'sponsorship_application', 'feedback_response',
          'festival', 'mottfest_revenue_summary', 'current_festival', 'mottfest_current_summary', 'feedback_submission']::NAME[], NULL,
    '37_mottfest_dashboards_menu',
    'Group Mott Fest entities under a Mott Fest menu heading; hide helper views',
    'accepted',
    'The module adds nine entities. Without menu nodes they would appear as unplaced root entries after the clubhouse headings, mixed with each other, and the helper views (current_festival, mottfest_current_summary, the write-only feedback_submission) would appear as menu items that lead nowhere useful.',
    'Add a Mott Fest heading (sort 30, after the clubhouse headings) holding Booth Vendor Applications, Food Truck Applications, Sponsorships, Feedback Responses, Festivals and Revenue Summary (plural menu labels over singular entity names), and hidden root nodes for current_festival, mottfest_current_summary and feedback_submission. Insert with ON CONFLICT DO NOTHING.',
    'A heading keeps the festival work in one place and leaves the clubhouse menu unchanged. Hidden nodes are the menu''s way to say "placed on purpose, not shown"; dashboards and emailed links reach those views. Entity names are singular because the pages build "Add <entity>", "<entity>: <record>" and "<entity> List" from them; the menu lists collections, so its entity nodes carry plural labels. Renaming an entity no longer renames those entries: change the node label in /admin/menu too. Dashboards cannot be menu nodes yet, so the Mott Fest dashboard is reached through the banner (added at launch) and the dashboard selector.',
    'Per-caller filtering drops entries a role cannot see, so anonymous visitors see Mott Fest with Festivals only. Applicants see Feedback and Revenue Summary entries whose lists are empty for them. Admins may reorder, rename or hide nodes in /admin/menu; re-running the script keeps those edits and only adds missing nodes.',
    CURRENT_DATE
WHERE NOT EXISTS (
    SELECT 1 FROM metadata.schema_decisions
    WHERE migration_id = '37_mottfest_dashboards_menu'
      AND title = 'Group Mott Fest entities under a Mott Fest menu heading; hide helper views'
);

INSERT INTO metadata.schema_decisions (entity_types, property_names, migration_id, title, status, context, decision, rationale, consequences, decided_date)
SELECT
    ARRAY['vendor_application', 'food_truck_application', 'sponsorship_application', 'current_festival', 'mottfest_current_summary']::NAME[], NULL,
    '37_mottfest_dashboards_menu',
    'Mott Fest dashboard (public at launch) and a Management dashboard gated to mottfest_admin',
    'accepted',
    'Applicants need one public page with festival facts and apply buttons. Organizers need review and payment queues. Since v0.80.3 a non-public dashboard is visible only to admins, its creator, or roles granted in metadata.dashboard_roles.',
    'Create "Mott Fest" and "Mott Fest Management", both is_public FALSE with a dashboard_roles show row for mottfest_admin; the launch script makes "Mott Fest" public. Management widgets filter on status keys (status_id.status_key), never on numeric ids or a festival id. Each queue has an empty-state message.',
    'Status keys keep the widgets portable between the example and production. Filtering on status alone is correct because Mark Completed refuses while pending or approved-unpaid rows remain. A show row, not a default row, leaves organizers'' landing dashboard unchanged.',
    'Applicants never see the Management dashboard in the selector. Row-level security still decides what any list shows, so a direct link to it shows nothing an applicant may not read. Re-running the script never overwrites widgets an admin has edited.',
    CURRENT_DATE
WHERE NOT EXISTS (
    SELECT 1 FROM metadata.schema_decisions
    WHERE migration_id = '37_mottfest_dashboards_menu'
      AND title = 'Mott Fest dashboard (public at launch) and a Management dashboard gated to mottfest_admin'
);

INSERT INTO metadata.schema_decisions (entity_types, property_names, migration_id, title, status, context, decision, rationale, consequences, decided_date)
SELECT
    ARRAY['feedback_submission', 'feedback_response']::NAME[], NULL,
    '37_mottfest_dashboards_menu',
    'Thanks dashboard as the feedback survey redirect, hidden from the selector',
    'accepted',
    'After saving, the Create page goes to the new record''s Detail page, which a write-only feedback view cannot show. The Create page honors a returnTo query parameter, so the survey link can send respondents anywhere after saving.',
    'Create a "Thanks for your feedback" dashboard (is_public FALSE, a dashboard_roles show row for mottfest_admin, and one for user from the launch script) and point the survey link at /create/feedback_submission?returnTo=/dashboard/<id>. Set show_in_selector = FALSE where the core supports it (v0.82.0+). The link is published on the Management dashboard for organizers to email.',
    'A dashboard needs no frontend code and its text stays editable by admins. Granting it to user rather than making it public matches the survey, which needs a signed-in user anyway.',
    'On cores before v0.82.0 the Thanks dashboard is listed in every signed-in user''s selector. Its id differs per instance, so the link is built at script time; recreating the dashboard means updating the published link.',
    CURRENT_DATE
WHERE NOT EXISTS (
    SELECT 1 FROM metadata.schema_decisions
    WHERE migration_id = '37_mottfest_dashboards_menu'
      AND title = 'Thanks dashboard as the feedback survey redirect, hidden from the selector'
);
