-- =====================================================
-- Youth Soccer StoryMap Example - Permissions & Indexes
-- =====================================================

-- =====================================================
-- Grant CRUD Permissions
-- =====================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON participants TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON teams TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON team_rosters TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON sponsors TO authenticated;

-- Sequences
GRANT USAGE, SELECT ON SEQUENCE participants_id_seq TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE teams_id_seq TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE team_rosters_id_seq TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE sponsors_id_seq TO authenticated;

-- Public read access (for unauthenticated users)
GRANT SELECT ON participants TO web_anon;
GRANT SELECT ON teams TO web_anon;
GRANT SELECT ON team_rosters TO web_anon;
GRANT SELECT ON sponsors TO web_anon;

-- =====================================================
-- Row Level Security Policies
-- =====================================================
ALTER TABLE participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_rosters ENABLE ROW LEVEL SECURITY;
ALTER TABLE sponsors ENABLE ROW LEVEL SECURITY;

-- Public read (anyone can view the data)
CREATE POLICY "Public read participants" ON participants
  FOR SELECT TO PUBLIC USING (true);

CREATE POLICY "Public read teams" ON teams
  FOR SELECT TO PUBLIC USING (true);

CREATE POLICY "Public read rosters" ON team_rosters
  FOR SELECT TO PUBLIC USING (true);

CREATE POLICY "Public read sponsors" ON sponsors
  FOR SELECT TO PUBLIC USING (true);

-- Authenticated write (logged-in users can modify)
CREATE POLICY "Authenticated write participants" ON participants
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Authenticated write teams" ON teams
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Authenticated write rosters" ON team_rosters
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Authenticated write sponsors" ON sponsors
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- =====================================================
-- Indexes for Performance
-- =====================================================

-- Foreign key indexes (CRITICAL for inverse relationships and joins)
CREATE INDEX idx_team_rosters_team_id ON team_rosters(team_id);
CREATE INDEX idx_team_rosters_participant_id ON team_rosters(participant_id);

-- Season year index (for "show all 2020 players" queries)
CREATE INDEX idx_team_rosters_season_year ON team_rosters(season_year);
CREATE INDEX idx_teams_season_year ON teams(season_year);

-- Date indexes (for temporal filtering in dashboards)
CREATE INDEX idx_participants_enrolled_date ON participants(enrolled_date);
CREATE INDEX idx_sponsors_partnership_start ON sponsors(partnership_start);

-- Status index (for filtering active/inactive players)
CREATE INDEX idx_participants_status ON participants(status);

-- Geography indexes (GIST for spatial queries)
CREATE INDEX idx_participants_home_location ON participants USING GIST(home_location);
CREATE INDEX idx_sponsors_location ON sponsors USING GIST(location);

-- Full-text search indexes (for display_name searches)
CREATE INDEX idx_participants_name ON participants(display_name);
CREATE INDEX idx_teams_name ON teams(display_name);
CREATE INDEX idx_sponsors_name ON sponsors(display_name);
