-- =====================================================
-- Youth Soccer StoryMap Example - Dashboards
-- =====================================================
--
-- Four narrative dashboards showing program growth 2018-2025:
--   1. 2018 - Foundation Year (pilot program)
--   2. 2020 - Building Momentum (early growth)
--   3. 2022 - Acceleration (scaling up)
--   4. 2025 - Impact at Scale (present day)
--

-- =====================================================
-- Add map widget type (Dashboard Phase 2)
-- =====================================================
INSERT INTO metadata.widget_types (widget_type, display_name, description, icon_name, is_active)
VALUES (
  'map',
  'Geographic Map',
  'Display filtered entity records with geography columns on interactive map with optional clustering',
  'map',
  TRUE
)
ON CONFLICT (widget_type) DO NOTHING;

-- Notify PostgREST to reload schema cache
NOTIFY pgrst, 'reload schema';

-- =====================================================
-- Remove default Welcome dashboard from baseline migration
-- =====================================================
DELETE FROM metadata.dashboards WHERE is_default = TRUE;

-- =====================================================
-- Dashboard 1: "2018 - Foundation Year"
-- =====================================================
DO $$
DECLARE v_dashboard_id INT;
BEGIN
  INSERT INTO metadata.dashboards (display_name, description, is_default, is_public, sort_order)
  VALUES ('2018 - Foundation Year', 'The beginning: our first teams and players', TRUE, TRUE, 10)
  RETURNING id INTO v_dashboard_id;

  -- Row 1: Markdown (left) + Map (right)
  -- Markdown: Program founding story
  INSERT INTO metadata.dashboard_widgets (dashboard_id, widget_type, title, config, sort_order, width, height)
  VALUES (
    v_dashboard_id,
    'markdown',
    NULL,
    jsonb_build_object(
      'content', E'# 2018: Planting Seeds\n\n[EDIT: Share the founding story - why the program started, initial challenges, first supporters]\n\n**Key Stats:**\n- Players enrolled: 15\n- Teams formed: 2 (U8, U10)\n- Volunteer coaches: 4',
      'enableHtml', false
    ),
    1, 1, 2
  );

  -- Map: Participant home locations (2018 only, no clustering needed)
  INSERT INTO metadata.dashboard_widgets (dashboard_id, widget_type, title, entity_key, config, sort_order, width, height)
  VALUES (
    v_dashboard_id,
    'map',
    'Where Our First Players Live',
    'participants',
    jsonb_build_object(
      'entityKey', 'participants',
      'mapPropertyName', 'home_location',
      'filters', jsonb_build_array(
        jsonb_build_object('column', 'enrolled_date', 'operator', 'lt', 'value', '2019-01-01')
      ),
      'showColumns', jsonb_build_array('display_name', 'enrolled_date'),
      'enableClustering', false
    ),
    2, 1, 2
  );

  -- Row 2: Teams list (full width)
  -- Filtered list: 2018 teams
  INSERT INTO metadata.dashboard_widgets (dashboard_id, widget_type, title, entity_key, config, sort_order, width, height)
  VALUES (
    v_dashboard_id,
    'filtered_list',
    'Our First Teams',
    'teams',
    jsonb_build_object(
      'filters', jsonb_build_array(
        jsonb_build_object('column', 'season_year', 'operator', 'eq', 'value', 2018)
      ),
      'orderBy', 'age_group',
      'orderDirection', 'asc',
      'limit', 10,
      'showColumns', jsonb_build_array('display_name', 'age_group', 'season_year')
    ),
    3, 2, 1
  );

  -- Navigation footer
  INSERT INTO metadata.dashboard_widgets (dashboard_id, widget_type, title, config, sort_order, width, height)
  VALUES (
    v_dashboard_id,
    'markdown',
    NULL,
    jsonb_build_object(
      'content', E'<div class="flex justify-between items-center py-2">\n  <span class="btn btn-outline btn-sm opacity-0 pointer-events-none">← Placeholder</span>\n  <div class="flex gap-2">\n    <span class="badge badge-primary">2018</span>\n    <a href="/dashboard/3" class="badge badge-outline hover:badge-primary">2020</a>\n    <a href="/dashboard/4" class="badge badge-outline hover:badge-primary">2022</a>\n    <a href="/dashboard/5" class="badge badge-outline hover:badge-primary">2025</a>\n  </div>\n  <a href="/dashboard/3" class="btn btn-primary btn-sm">2020: Building Momentum →</a>\n</div>',
      'enableHtml', true
    ),
    100, 2, 1
  );
END $$;

-- =====================================================
-- Dashboard 2: "2020 - Building Momentum"
-- =====================================================
DO $$
DECLARE v_dashboard_id INT;
BEGIN
  INSERT INTO metadata.dashboards (display_name, description, is_default, is_public, sort_order)
  VALUES ('2020 - Building Momentum', 'Early growth and community support', FALSE, TRUE, 20)
  RETURNING id INTO v_dashboard_id;

  -- Row 1: Markdown (left) + Participants map (right)
  -- Markdown: Growth story
  INSERT INTO metadata.dashboard_widgets (dashboard_id, widget_type, title, config, sort_order, width, height)
  VALUES (
    v_dashboard_id,
    'markdown',
    NULL,
    jsonb_build_object(
      'content', E'# 2020: Growing Roots\n\n[EDIT: Describe expansion despite pandemic challenges, community rallying around kids, first partnerships]\n\n**Key Stats:**\n- Players enrolled: 45\n- Teams formed: 5 (U8, U10, U12, U14)\n- Sponsors: 3 local businesses',
      'enableHtml', false
    ),
    1, 1, 2
  );

  -- Map: Participant locations (up to 2020, start using clustering)
  INSERT INTO metadata.dashboard_widgets (dashboard_id, widget_type, title, entity_key, config, sort_order, width, height)
  VALUES (
    v_dashboard_id,
    'map',
    'Player Homes Across Flint',
    'participants',
    jsonb_build_object(
      'entityKey', 'participants',
      'mapPropertyName', 'home_location',
      'filters', jsonb_build_array(
        jsonb_build_object('column', 'enrolled_date', 'operator', 'lt', 'value', '2021-01-01')
      ),
      'showColumns', jsonb_build_array('display_name', 'enrolled_date'),
      'enableClustering', true,
      'clusterRadius', 60
    ),
    2, 1, 2
  );

  -- Row 2: Teams list (left) + Sponsors map (right)
  -- Filtered list: 2020 teams
  INSERT INTO metadata.dashboard_widgets (dashboard_id, widget_type, title, entity_key, config, sort_order, width, height)
  VALUES (
    v_dashboard_id,
    'filtered_list',
    '2020 Season Teams',
    'teams',
    jsonb_build_object(
      'filters', jsonb_build_array(
        jsonb_build_object('column', 'season_year', 'operator', 'eq', 'value', 2020)
      ),
      'orderBy', 'age_group',
      'orderDirection', 'asc',
      'limit', 10,
      'showColumns', jsonb_build_array('display_name', 'age_group')
    ),
    3, 1, 2
  );

  -- Map: Sponsor locations
  INSERT INTO metadata.dashboard_widgets (dashboard_id, widget_type, title, entity_key, config, sort_order, width, height)
  VALUES (
    v_dashboard_id,
    'map',
    'Community Supporters',
    'sponsors',
    jsonb_build_object(
      'entityKey', 'sponsors',
      'mapPropertyName', 'location',
      'filters', jsonb_build_array(
        jsonb_build_object('column', 'partnership_start', 'operator', 'lt', 'value', '2021-01-01')
      ),
      'showColumns', jsonb_build_array('display_name', 'sponsor_type', 'total_contribution'),
      'enableClustering', false
    ),
    4, 1, 2
  );

  -- Navigation footer
  INSERT INTO metadata.dashboard_widgets (dashboard_id, widget_type, title, config, sort_order, width, height)
  VALUES (
    v_dashboard_id,
    'markdown',
    NULL,
    jsonb_build_object(
      'content', E'<div class="flex justify-between items-center py-2">\n  <a href="/" class="btn btn-outline btn-sm">← 2018: Foundation Year</a>\n  <div class="flex gap-2">\n    <a href="/" class="badge badge-outline hover:badge-primary">2018</a>\n    <span class="badge badge-primary">2020</span>\n    <a href="/dashboard/4" class="badge badge-outline hover:badge-primary">2022</a>\n    <a href="/dashboard/5" class="badge badge-outline hover:badge-primary">2025</a>\n  </div>\n  <a href="/dashboard/4" class="btn btn-primary btn-sm">2022: Acceleration →</a>\n</div>',
      'enableHtml', true
    ),
    100, 2, 1
  );
END $$;

-- =====================================================
-- Dashboard 3: "2022 - Acceleration"
-- =====================================================
DO $$
DECLARE v_dashboard_id INT;
BEGIN
  INSERT INTO metadata.dashboards (display_name, description, is_default, is_public, sort_order)
  VALUES ('2022 - Acceleration', 'Rapid expansion and competitive success', FALSE, TRUE, 30)
  RETURNING id INTO v_dashboard_id;

  -- Row 1: Markdown (left) + Map (right)
  -- Markdown: Acceleration story
  INSERT INTO metadata.dashboard_widgets (dashboard_id, widget_type, title, config, sort_order, width, height)
  VALUES (
    v_dashboard_id,
    'markdown',
    NULL,
    jsonb_build_object(
      'content', E'# 2022: Reaching New Heights\n\n[EDIT: Tournament wins, new age groups added, equipment donations, scholarship program launched]\n\n**Key Stats:**\n- Players enrolled: 120\n- Teams formed: 10 (all age groups U8-U16)\n- Sponsors: 8 partners\n- First competitive tournament wins!',
      'enableHtml', false
    ),
    1, 1, 2
  );

  -- Map: All participants up to 2022 (clustered)
  INSERT INTO metadata.dashboard_widgets (dashboard_id, widget_type, title, entity_key, config, sort_order, width, height)
  VALUES (
    v_dashboard_id,
    'map',
    'Youth Soccer Across Neighborhoods',
    'participants',
    jsonb_build_object(
      'entityKey', 'participants',
      'mapPropertyName', 'home_location',
      'filters', jsonb_build_array(
        jsonb_build_object('column', 'enrolled_date', 'operator', 'lt', 'value', '2023-01-01')
      ),
      'showColumns', jsonb_build_array('display_name', 'enrolled_date', 'status'),
      'enableClustering', true,
      'clusterRadius', 50
    ),
    2, 1, 2
  );

  -- Row 2: Teams list (left) + Sponsors list (right)
  -- Filtered list: 2022 teams
  INSERT INTO metadata.dashboard_widgets (dashboard_id, widget_type, title, entity_key, config, sort_order, width, height)
  VALUES (
    v_dashboard_id,
    'filtered_list',
    '2022 Season Teams',
    'teams',
    jsonb_build_object(
      'filters', jsonb_build_array(
        jsonb_build_object('column', 'season_year', 'operator', 'eq', 'value', 2022)
      ),
      'orderBy', 'age_group',
      'orderDirection', 'asc',
      'limit', 15,
      'showColumns', jsonb_build_array('display_name', 'age_group')
    ),
    3, 1, 1
  );

  -- Filtered list: Top sponsors
  INSERT INTO metadata.dashboard_widgets (dashboard_id, widget_type, title, entity_key, config, sort_order, width, height)
  VALUES (
    v_dashboard_id,
    'filtered_list',
    'Major Supporters',
    'sponsors',
    jsonb_build_object(
      'filters', jsonb_build_array(),
      'orderBy', 'total_contribution',
      'orderDirection', 'desc',
      'limit', 8,
      'showColumns', jsonb_build_array('display_name', 'sponsor_type', 'total_contribution')
    ),
    4, 1, 1
  );

  -- Navigation footer
  INSERT INTO metadata.dashboard_widgets (dashboard_id, widget_type, title, config, sort_order, width, height)
  VALUES (
    v_dashboard_id,
    'markdown',
    NULL,
    jsonb_build_object(
      'content', E'<div class="flex justify-between items-center py-2">\n  <a href="/dashboard/3" class="btn btn-outline btn-sm">← 2020: Building Momentum</a>\n  <div class="flex gap-2">\n    <a href="/" class="badge badge-outline hover:badge-primary">2018</a>\n    <a href="/dashboard/3" class="badge badge-outline hover:badge-primary">2020</a>\n    <span class="badge badge-primary">2022</span>\n    <a href="/dashboard/5" class="badge badge-outline hover:badge-primary">2025</a>\n  </div>\n  <a href="/dashboard/5" class="btn btn-primary btn-sm">2025: Impact at Scale →</a>\n</div>',
      'enableHtml', true
    ),
    100, 2, 1
  );
END $$;

-- =====================================================
-- Dashboard 4: "2025 - Impact at Scale"
-- =====================================================
DO $$
DECLARE v_dashboard_id INT;
BEGIN
  INSERT INTO metadata.dashboards (display_name, description, is_default, is_public, sort_order)
  VALUES ('2025 - Impact at Scale', 'Current reach and future vision', FALSE, TRUE, 40)
  RETURNING id INTO v_dashboard_id;

  -- Row 1: Markdown (left) + Map (right)
  -- Markdown: Present day + looking ahead
  INSERT INTO metadata.dashboard_widgets (dashboard_id, widget_type, title, config, sort_order, width, height)
  VALUES (
    v_dashboard_id,
    'markdown',
    NULL,
    jsonb_build_object(
      'content', E'# 2025: A Movement\n\n[EDIT: Current impact statistics, success stories, alumni achievements, future goals]\n\n**Key Stats:**\n- Players enrolled: 200+\n- Teams formed: 18 (multiple teams per age group)\n- Sponsors: 15 community partners\n- Alumni: 50+ former players\n- Scholarships awarded: 12',
      'enableHtml', false
    ),
    1, 1, 2
  );

  -- Map: ALL participants (heavily clustered)
  INSERT INTO metadata.dashboard_widgets (dashboard_id, widget_type, title, entity_key, config, sort_order, width, height)
  VALUES (
    v_dashboard_id,
    'map',
    'Our Full Community',
    'participants',
    jsonb_build_object(
      'entityKey', 'participants',
      'mapPropertyName', 'home_location',
      'filters', jsonb_build_array(
        jsonb_build_object('column', 'status', 'operator', 'in', 'value', jsonb_build_array('Active', 'Alumni'))
      ),
      'showColumns', jsonb_build_array('display_name', 'enrolled_date', 'status'),
      'enableClustering', true,
      'clusterRadius', 50,
      'maxMarkers', 500
    ),
    2, 1, 2
  );

  -- Row 2: Teams list (left) + Sponsors list (right)

  -- Filtered list: Active 2025 teams
  INSERT INTO metadata.dashboard_widgets (dashboard_id, widget_type, title, entity_key, config, sort_order, width, height)
  VALUES (
    v_dashboard_id,
    'filtered_list',
    '2025 Season Teams',
    'teams',
    jsonb_build_object(
      'filters', jsonb_build_array(
        jsonb_build_object('column', 'season_year', 'operator', 'eq', 'value', 2025)
      ),
      'orderBy', 'age_group',
      'orderDirection', 'asc',
      'limit', 20,
      'showColumns', jsonb_build_array('display_name', 'age_group')
    ),
    3, 1, 1
  );

  -- Filtered list: All sponsors
  INSERT INTO metadata.dashboard_widgets (dashboard_id, widget_type, title, entity_key, config, sort_order, width, height)
  VALUES (
    v_dashboard_id,
    'filtered_list',
    'Community Partners',
    'sponsors',
    jsonb_build_object(
      'filters', jsonb_build_array(),
      'orderBy', 'partnership_start',
      'orderDirection', 'asc',
      'limit', 20,
      'showColumns', jsonb_build_array('display_name', 'sponsor_type', 'partnership_start', 'total_contribution')
    ),
    4, 1, 1
  );

  -- Navigation footer
  INSERT INTO metadata.dashboard_widgets (dashboard_id, widget_type, title, config, sort_order, width, height)
  VALUES (
    v_dashboard_id,
    'markdown',
    NULL,
    jsonb_build_object(
      'content', E'<div class="flex justify-between items-center py-2">\n  <a href="/dashboard/4" class="btn btn-outline btn-sm">← 2022: Acceleration</a>\n  <div class="flex gap-2">\n    <a href="/" class="badge badge-outline hover:badge-primary">2018</a>\n    <a href="/dashboard/3" class="badge badge-outline hover:badge-primary">2020</a>\n    <a href="/dashboard/4" class="badge badge-outline hover:badge-primary">2022</a>\n    <span class="badge badge-primary">2025</span>\n  </div>\n  <a href="/" class="btn btn-primary btn-sm">↺ Back to Start</a>\n</div>',
      'enableHtml', true
    ),
    100, 2, 1
  );
END $$;
