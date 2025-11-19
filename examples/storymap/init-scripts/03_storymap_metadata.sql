-- =====================================================
-- Youth Soccer StoryMap Example - Metadata Enhancements
-- =====================================================
--
-- Customize entity and property display for better UX

-- =====================================================
-- Entity Customization
-- =====================================================
INSERT INTO metadata.entities (table_name, display_name, description, sort_order)
VALUES
  ('participants', 'Youth Soccer Participants', 'Players enrolled in the program', 10),
  ('teams', 'Teams', 'Age-based teams by season', 20),
  ('team_rosters', 'Team Rosters', 'Player assignments to teams by season', 30),
  ('sponsors', 'Community Sponsors', 'Organizations and individuals supporting the program', 40)
ON CONFLICT (table_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order;

-- =====================================================
-- Property Customization
-- =====================================================

-- Participants
INSERT INTO metadata.properties (table_name, column_name, display_name, description, filterable, sortable, show_on_list, sort_order)
VALUES
  ('participants', 'display_name', 'Player Name', 'Full name of the participant', TRUE, TRUE, TRUE, 1),
  ('participants', 'birth_date', 'Birth Date', 'Date of birth', TRUE, TRUE, TRUE, 2),
  ('participants', 'home_location', 'Home Location', 'Where the player lives', FALSE, FALSE, FALSE, 3),
  ('participants', 'enrolled_date', 'Enrollment Date', 'When they joined the program', TRUE, TRUE, TRUE, 4),
  ('participants', 'status', 'Status', 'Active, Alumni, or Inactive', TRUE, TRUE, TRUE, 5),
  ('participants', 'parent_email', 'Parent Email', 'Parent/guardian email contact', FALSE, FALSE, FALSE, 6),
  ('participants', 'parent_phone', 'Parent Phone', 'Parent/guardian phone contact', FALSE, FALSE, FALSE, 7)
ON CONFLICT (table_name, column_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  filterable = EXCLUDED.filterable,
  sortable = EXCLUDED.sortable,
  show_on_list = EXCLUDED.show_on_list,
  sort_order = EXCLUDED.sort_order;

-- Teams
INSERT INTO metadata.properties (table_name, column_name, display_name, description, filterable, sortable, show_on_list, sort_order)
VALUES
  ('teams', 'display_name', 'Team Name', 'Full team name', TRUE, TRUE, TRUE, 1),
  ('teams', 'age_group', 'Age Group', 'Under-8, Under-10, etc.', TRUE, TRUE, TRUE, 2),
  ('teams', 'season_year', 'Season', 'Year of the season', TRUE, TRUE, TRUE, 3),
  ('teams', 'color', 'Team Color', 'Color for UI display', FALSE, FALSE, TRUE, 4)
ON CONFLICT (table_name, column_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  filterable = EXCLUDED.filterable,
  sortable = EXCLUDED.sortable,
  show_on_list = EXCLUDED.show_on_list,
  sort_order = EXCLUDED.sort_order;

-- Team Rosters
INSERT INTO metadata.properties (table_name, column_name, display_name, description, filterable, sortable, show_on_list, sort_order)
VALUES
  ('team_rosters', 'team_id', 'Team', 'Which team', TRUE, TRUE, TRUE, 1),
  ('team_rosters', 'participant_id', 'Player', 'Which player', TRUE, TRUE, TRUE, 2),
  ('team_rosters', 'season_year', 'Season', 'Year of the season', TRUE, TRUE, TRUE, 3),
  ('team_rosters', 'jersey_number', 'Jersey #', 'Player jersey number', FALSE, TRUE, TRUE, 4)
ON CONFLICT (table_name, column_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  filterable = EXCLUDED.filterable,
  sortable = EXCLUDED.sortable,
  show_on_list = EXCLUDED.show_on_list,
  sort_order = EXCLUDED.sort_order;

-- Sponsors
INSERT INTO metadata.properties (table_name, column_name, display_name, description, filterable, sortable, show_on_list, sort_order)
VALUES
  ('sponsors', 'display_name', 'Sponsor Name', 'Organization or individual name', TRUE, TRUE, TRUE, 1),
  ('sponsors', 'sponsor_type', 'Type', 'Corporate, Individual, Foundation, or Grant', TRUE, TRUE, TRUE, 2),
  ('sponsors', 'total_contribution', 'Total Contribution', 'Lifetime giving amount', FALSE, TRUE, TRUE, 3),
  ('sponsors', 'partnership_start', 'Partnership Start', 'When they started supporting', TRUE, TRUE, TRUE, 4),
  ('sponsors', 'contact_email', 'Contact Email', 'Primary email contact', FALSE, FALSE, FALSE, 5),
  ('sponsors', 'location', 'Location', 'Business/organization location', FALSE, FALSE, FALSE, 6)
ON CONFLICT (table_name, column_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  filterable = EXCLUDED.filterable,
  sortable = EXCLUDED.sortable,
  show_on_list = EXCLUDED.show_on_list,
  sort_order = EXCLUDED.sort_order;
