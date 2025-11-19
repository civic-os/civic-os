-- =====================================================
-- Youth Soccer StoryMap Example Schema
-- =====================================================
--
-- This schema demonstrates a youth soccer program's growth
-- from 2018-2025, perfect for StoryMap dashboard visualization.
--
-- Tables:
--   - participants: Youth players with home locations
--   - teams: Age-based teams by season year
--   - team_rosters: M:M relationship with season tracking
--   - sponsors: Community partners supporting the program
--

-- =====================================================
-- Participants (Players)
-- =====================================================
CREATE TABLE participants (
  id SERIAL PRIMARY KEY,
  display_name VARCHAR(100) NOT NULL,
  birth_date DATE NOT NULL,
  home_location postgis.geography(Point, 4326),  -- Where the player lives
  enrolled_date DATE NOT NULL,                   -- When they joined the program
  status VARCHAR(20) NOT NULL DEFAULT 'Active',  -- Active, Alumni, Inactive
  parent_email email_address,
  parent_phone phone_number,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT valid_status CHECK (status IN ('Active', 'Alumni', 'Inactive'))
);

-- Computed WKT field for PostgREST (required for GeoPointMapComponent)
ALTER TABLE participants ADD COLUMN home_location_text TEXT
  GENERATED ALWAYS AS (postgis.ST_AsText(home_location)) STORED;

-- =====================================================
-- Teams (Age Groups by Season)
-- =====================================================
CREATE TABLE teams (
  id SERIAL PRIMARY KEY,
  display_name VARCHAR(100) NOT NULL,
  age_group VARCHAR(20) NOT NULL,  -- U8, U10, U12, U14, U16, U18
  season_year INT NOT NULL,         -- 2018, 2019, 2020, etc.
  color hex_color NOT NULL DEFAULT '#3B82F6',  -- Team color for UI display
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT valid_age_group CHECK (age_group IN ('U8', 'U10', 'U12', 'U14', 'U16', 'U18')),
  CONSTRAINT valid_season_year CHECK (season_year BETWEEN 2018 AND 2030)
);

-- =====================================================
-- Team Rosters (M:M with Season Tracking)
-- =====================================================
CREATE TABLE team_rosters (
  id SERIAL PRIMARY KEY,
  team_id INT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  participant_id INT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  season_year INT NOT NULL,  -- Denormalized from team for easy "show 2020 players" queries
  jersey_number INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT valid_jersey_number CHECK (jersey_number BETWEEN 1 AND 99)
);

-- Trigger to auto-populate season_year from parent team
CREATE OR REPLACE FUNCTION set_roster_season_year()
RETURNS TRIGGER AS $$
BEGIN
  SELECT season_year INTO NEW.season_year
  FROM teams WHERE id = NEW.team_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER roster_season_year_trigger
  BEFORE INSERT OR UPDATE ON team_rosters
  FOR EACH ROW
  EXECUTE FUNCTION set_roster_season_year();

-- =====================================================
-- Sponsors (Community Partners)
-- =====================================================
CREATE TABLE sponsors (
  id SERIAL PRIMARY KEY,
  display_name VARCHAR(100) NOT NULL,
  sponsor_type VARCHAR(50),              -- Corporate, Individual, Foundation, Grant
  contact_email email_address,
  location postgis.geography(Point, 4326),  -- Business/organization location
  total_contribution MONEY,              -- Lifetime contribution amount
  partnership_start DATE NOT NULL,       -- When they started supporting
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT valid_sponsor_type CHECK (sponsor_type IN ('Corporate', 'Individual', 'Foundation', 'Grant'))
);

-- Computed WKT field for PostgREST (required for GeoPointMapComponent)
ALTER TABLE sponsors ADD COLUMN location_text TEXT
  GENERATED ALWAYS AS (postgis.ST_AsText(location)) STORED;

-- =====================================================
-- Triggers for updated_at Timestamps
-- =====================================================
CREATE TRIGGER set_updated_at_trigger
  BEFORE INSERT OR UPDATE ON participants
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER set_updated_at_trigger
  BEFORE INSERT OR UPDATE ON teams
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER set_updated_at_trigger
  BEFORE INSERT OR UPDATE ON sponsors
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();
