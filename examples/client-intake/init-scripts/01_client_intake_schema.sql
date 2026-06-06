-- ============================================================================
-- CLIENT INTAKE & REFERRAL SYSTEM
-- International Center of Greater Flint (ICGF)
-- Tracks immigrant/refugee client intake, partner agencies, referrals,
-- and follow-up surveys with automated reminders and reporting.
-- Demonstrates: Status types, Category system, M:M junctions (x3),
--   GeoPoint maps, Entity Notes, Virtual Entity reports, full-text search,
--   RLS with custom roles, notifications, scheduled jobs.
-- ============================================================================
-- NOTE: Requires Civic OS v0.15.0+ (Status Type System)
-- NOTE: Requires Civic OS v0.25.0+ (status_key for programmatic lookups)
-- NOTE: Requires Civic OS v0.34.0+ (Category system)
-- NOTE: Requires Civic OS v0.46.0+ (inline M:M show_inline)
-- NOTE: Requires Civic OS v0.59.0+ (metadata.send_email for multi-recipient)
-- ============================================================================

BEGIN;

-- ============================================================================
-- STATUS TYPE SYSTEM CONFIGURATION
-- ============================================================================

INSERT INTO metadata.status_types (entity_type, display_name, description) VALUES
  ('client', 'Client', 'Client intake workflow status'),
  ('referral', 'Referral', 'Referral lifecycle status'),
  ('survey', 'Follow-Up Survey', 'Survey completion status')
ON CONFLICT (entity_type) DO NOTHING;

-- Client statuses: Intake Pending → Active ↔ Inactive
INSERT INTO metadata.statuses (entity_type, display_name, description, color, sort_order, is_initial, is_terminal, status_key) VALUES
  ('client', 'Intake Pending', 'Awaiting staff assessment', '#F59E0B', 1, TRUE, FALSE, 'intake_pending'),
  ('client', 'Active', 'Assessed and actively receiving services', '#22C55E', 2, FALSE, FALSE, 'active'),
  ('client', 'Inactive', 'No longer engaged or moved away', '#6B7280', 3, FALSE, TRUE, 'inactive')
ON CONFLICT DO NOTHING;

-- Referral statuses: Referred → Completed / Not Completed
INSERT INTO metadata.statuses (entity_type, display_name, description, color, sort_order, is_initial, is_terminal, status_key) VALUES
  ('referral', 'Referred', 'Referral created, awaiting outcome', '#3B82F6', 1, TRUE, FALSE, 'referred'),
  ('referral', 'Completed', 'Client successfully connected with partner', '#22C55E', 2, FALSE, TRUE, 'completed'),
  ('referral', 'Not Completed', 'Client unable to connect or referral unsuccessful', '#EF4444', 3, FALSE, TRUE, 'not_completed')
ON CONFLICT DO NOTHING;

-- Survey statuses: Pending → Completed / Expired
INSERT INTO metadata.statuses (entity_type, display_name, description, color, sort_order, is_initial, is_terminal, status_key) VALUES
  ('survey', 'Pending', 'Awaiting client response', '#F59E0B', 1, TRUE, FALSE, 'pending'),
  ('survey', 'Completed', 'Client completed the survey', '#22C55E', 2, FALSE, TRUE, 'completed'),
  ('survey', 'Expired', 'No response after all reminders', '#6B7280', 3, FALSE, TRUE, 'expired')
ON CONFLICT DO NOTHING;

-- Status transitions
INSERT INTO metadata.status_transitions (entity_type, from_status_id, to_status_id) VALUES
  -- Client: intake_pending → active, active ↔ inactive
  ('client',
   (SELECT id FROM metadata.statuses WHERE entity_type = 'client' AND status_key = 'intake_pending'),
   (SELECT id FROM metadata.statuses WHERE entity_type = 'client' AND status_key = 'active')),
  ('client',
   (SELECT id FROM metadata.statuses WHERE entity_type = 'client' AND status_key = 'active'),
   (SELECT id FROM metadata.statuses WHERE entity_type = 'client' AND status_key = 'inactive')),
  ('client',
   (SELECT id FROM metadata.statuses WHERE entity_type = 'client' AND status_key = 'inactive'),
   (SELECT id FROM metadata.statuses WHERE entity_type = 'client' AND status_key = 'active')),
  -- Referral: referred → completed, referred → not_completed
  ('referral',
   (SELECT id FROM metadata.statuses WHERE entity_type = 'referral' AND status_key = 'referred'),
   (SELECT id FROM metadata.statuses WHERE entity_type = 'referral' AND status_key = 'completed')),
  ('referral',
   (SELECT id FROM metadata.statuses WHERE entity_type = 'referral' AND status_key = 'referred'),
   (SELECT id FROM metadata.statuses WHERE entity_type = 'referral' AND status_key = 'not_completed')),
  -- Survey: pending → completed, pending → expired
  ('survey',
   (SELECT id FROM metadata.statuses WHERE entity_type = 'survey' AND status_key = 'pending'),
   (SELECT id FROM metadata.statuses WHERE entity_type = 'survey' AND status_key = 'completed')),
  ('survey',
   (SELECT id FROM metadata.statuses WHERE entity_type = 'survey' AND status_key = 'pending'),
   (SELECT id FROM metadata.statuses WHERE entity_type = 'survey' AND status_key = 'expired'))
ON CONFLICT DO NOTHING;


-- ============================================================================
-- CATEGORY SYSTEM CONFIGURATION
-- 7 category groups for non-workflow categorization
-- ============================================================================

INSERT INTO metadata.category_groups (entity_type, display_name, description) VALUES
  ('gender', 'Gender', 'Client gender identity'),
  ('immigration_status', 'Immigration Status', 'Client immigration status category'),
  ('partner_type', 'Partner Type', 'Organization or Individual partner'),
  ('referral_type', 'Referral Type', 'Warm or Info referral'),
  ('helpfulness', 'Helpfulness', 'Survey: how helpful was the referral'),
  ('time_to_contact', 'Time to Contact', 'Survey: how long to make contact'),
  ('outcome', 'Outcome', 'Survey: what was the outcome')
ON CONFLICT (entity_type) DO NOTHING;

-- Gender categories
INSERT INTO metadata.categories (entity_type, display_name, color, sort_order, category_key) VALUES
  ('gender', 'Male', '#3B82F6', 1, 'male'),
  ('gender', 'Female', '#EC4899', 2, 'female'),
  ('gender', 'Non-Binary', '#8B5CF6', 3, 'non_binary'),
  ('gender', 'Prefer Not to Say', '#6B7280', 4, 'prefer_not_to_say')
ON CONFLICT DO NOTHING;

-- Immigration status categories
INSERT INTO metadata.categories (entity_type, display_name, color, sort_order, category_key) VALUES
  ('immigration_status', 'Refugee', '#3B82F6', 1, 'refugee'),
  ('immigration_status', 'Asylee', '#8B5CF6', 2, 'asylee'),
  ('immigration_status', 'SIV (Special Immigrant Visa)', '#22C55E', 3, 'siv'),
  ('immigration_status', 'Permanent Resident', '#10B981', 4, 'permanent_resident'),
  ('immigration_status', 'Citizen', '#06B6D4', 5, 'citizen'),
  ('immigration_status', 'Other/Unknown', '#6B7280', 6, 'other')
ON CONFLICT DO NOTHING;

-- Partner type categories
INSERT INTO metadata.categories (entity_type, display_name, color, sort_order, category_key) VALUES
  ('partner_type', 'Organization', '#3B82F6', 1, 'organization'),
  ('partner_type', 'Individual', '#F59E0B', 2, 'individual')
ON CONFLICT DO NOTHING;

-- Referral type categories
INSERT INTO metadata.categories (entity_type, display_name, color, sort_order, category_key) VALUES
  ('referral_type', 'Warm', '#22C55E', 1, 'warm'),
  ('referral_type', 'Info', '#3B82F6', 2, 'info')
ON CONFLICT DO NOTHING;

-- Survey: helpfulness categories
INSERT INTO metadata.categories (entity_type, display_name, color, sort_order, category_key) VALUES
  ('helpfulness', 'Very Helpful', '#22C55E', 1, 'very_helpful'),
  ('helpfulness', 'Somewhat Helpful', '#F59E0B', 2, 'somewhat_helpful'),
  ('helpfulness', 'Not Helpful', '#EF4444', 3, 'not_helpful'),
  ('helpfulness', 'Could Not Make Contact', '#6B7280', 4, 'could_not_contact')
ON CONFLICT DO NOTHING;

-- Survey: time to contact categories
INSERT INTO metadata.categories (entity_type, display_name, color, sort_order, category_key) VALUES
  ('time_to_contact', 'Same Day', '#22C55E', 1, 'same_day'),
  ('time_to_contact', '1-2 Days', '#10B981', 2, '1_2_days'),
  ('time_to_contact', '3-5 Days', '#F59E0B', 3, '3_5_days'),
  ('time_to_contact', 'More Than 5 Days', '#F97316', 4, 'more_than_5_days'),
  ('time_to_contact', 'Unable to Make Contact', '#6B7280', 5, 'unable_to_contact')
ON CONFLICT DO NOTHING;

-- Survey: outcome categories
INSERT INTO metadata.categories (entity_type, display_name, color, sort_order, category_key) VALUES
  ('outcome', 'Enrolled in Services', '#22C55E', 1, 'enrolled'),
  ('outcome', 'Received Information', '#3B82F6', 2, 'received_info'),
  ('outcome', 'Referred Elsewhere', '#F59E0B', 3, 'referred_elsewhere'),
  ('outcome', 'No Action Taken', '#6B7280', 4, 'no_action'),
  ('outcome', 'Other', '#9CA3AF', 5, 'other')
ON CONFLICT DO NOTHING;


-- ============================================================================
-- TABLES
-- ============================================================================

-- 1. service_categories: Shared vocabulary across clients, partners, referrals
CREATE TABLE service_categories (
  id BIGSERIAL PRIMARY KEY,
  display_name TEXT NOT NULL UNIQUE,
  description TEXT,
  color hex_color,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INT DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. clients: Immigrant/refugee community members seeking services
CREATE TABLE clients (
  id BIGSERIAL PRIMARY KEY,
  first_name VARCHAR(255) NOT NULL,
  last_name VARCHAR(255) NOT NULL,
  display_name VARCHAR(511) GENERATED ALWAYS AS (COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')) STORED,
  email email_address,
  phone phone_number,
  date_of_birth DATE,
  gender_id INT REFERENCES metadata.categories(id),
  country_of_origin VARCHAR(255),
  primary_language VARCHAR(255),
  preferred_comm_language VARCHAR(255),
  date_of_arrival DATE,
  immigration_status_id INT REFERENCES metadata.categories(id),
  household_size INT,
  status_id INT NOT NULL DEFAULT get_initial_status('client') REFERENCES metadata.statuses(id),
  user_id UUID REFERENCES metadata.civic_os_users(id),
  created_by UUID DEFAULT current_user_id() REFERENCES metadata.civic_os_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. partners: Organizations/individuals that provide services
CREATE TABLE partners (
  id BIGSERIAL PRIMARY KEY,
  display_name TEXT NOT NULL,
  partner_type_id INT REFERENCES metadata.categories(id),
  contact_name VARCHAR(255),
  email email_address,
  phone phone_number,
  address TEXT,
  location postgis.geography(Point, 4326),
  location_text TEXT GENERATED ALWAYS AS (postgis.ST_AsText(location)) STORED,
  website VARCHAR(512),
  languages_supported TEXT,
  capacity_notes TEXT,
  description TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. referrals: Connects one client to one partner for services
CREATE TABLE referrals (
  id BIGSERIAL PRIMARY KEY,
  display_name TEXT GENERATED ALWAYS AS ('Referral #' || id) STORED,
  client_id BIGINT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  partner_id BIGINT NOT NULL REFERENCES partners(id),
  referral_type_id INT REFERENCES metadata.categories(id),
  referral_date DATE NOT NULL DEFAULT CURRENT_DATE,
  referred_by UUID DEFAULT current_user_id() REFERENCES metadata.civic_os_users(id),
  status_id INT NOT NULL DEFAULT get_initial_status('referral') REFERENCES metadata.statuses(id),
  outcome_notes TEXT,
  completed_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. follow_up_surveys: Post-referral client feedback
CREATE TABLE follow_up_surveys (
  id BIGSERIAL PRIMARY KEY,
  display_name TEXT GENERATED ALWAYS AS ('Survey #' || id) STORED,
  referral_id BIGINT NOT NULL UNIQUE REFERENCES referrals(id) ON DELETE CASCADE,
  status_id INT NOT NULL DEFAULT get_initial_status('survey') REFERENCES metadata.statuses(id),
  helpfulness_id INT REFERENCES metadata.categories(id),
  time_to_contact_id INT REFERENCES metadata.categories(id),
  outcome_id INT REFERENCES metadata.categories(id),
  open_feedback TEXT,
  completed_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ============================================================================
-- M:M JUNCTION TABLES (composite PKs, no surrogate IDs)
-- ============================================================================

-- Client ↔ Service Categories (needs tagged during intake)
CREATE TABLE client_service_needs (
  client_id BIGINT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  service_category_id BIGINT NOT NULL REFERENCES service_categories(id) ON DELETE CASCADE,
  PRIMARY KEY (client_id, service_category_id)
);

-- Partner ↔ Service Categories (services offered)
CREATE TABLE partner_service_categories (
  partner_id BIGINT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  service_category_id BIGINT NOT NULL REFERENCES service_categories(id) ON DELETE CASCADE,
  PRIMARY KEY (partner_id, service_category_id)
);

-- Referral ↔ Service Categories (services covered by this referral)
CREATE TABLE referral_service_categories (
  referral_id BIGINT NOT NULL REFERENCES referrals(id) ON DELETE CASCADE,
  service_category_id BIGINT NOT NULL REFERENCES service_categories(id) ON DELETE CASCADE,
  PRIMARY KEY (referral_id, service_category_id)
);


-- ============================================================================
-- FULL-TEXT SEARCH
-- ============================================================================

-- Clients: search on name, country, language
ALTER TABLE clients ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (
    to_tsvector('simple',
      coalesce(first_name, '') || ' ' ||
      coalesce(last_name, '') || ' ' ||
      coalesce(country_of_origin, '') || ' ' ||
      coalesce(primary_language, '')
    )
  ) STORED;

CREATE INDEX idx_clients_search ON clients USING GIN(search_vector);

-- Partners: search on name, contact, description
ALTER TABLE partners ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (
    to_tsvector('simple',
      coalesce(display_name, '') || ' ' ||
      coalesce(contact_name, '') || ' ' ||
      coalesce(description, '') || ' ' ||
      coalesce(languages_supported, '')
    )
  ) STORED;

CREATE INDEX idx_partners_search ON partners USING GIN(search_vector);

-- Substring search (pg_trgm) for partial name matching / duplicate detection
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX idx_clients_display_name_trgm ON clients USING GIN(display_name gin_trgm_ops);


-- ============================================================================
-- INDEXES (CRITICAL: FK columns must be indexed)
-- ============================================================================

-- clients
CREATE INDEX idx_clients_status_id ON clients(status_id);
CREATE INDEX idx_clients_gender_id ON clients(gender_id);
CREATE INDEX idx_clients_immigration_status_id ON clients(immigration_status_id);
CREATE INDEX idx_clients_created_by ON clients(created_by);
CREATE INDEX idx_clients_user_id ON clients(user_id);

-- partners
CREATE INDEX idx_partners_partner_type_id ON partners(partner_type_id);
CREATE INDEX idx_partners_location ON partners USING GIST(location);

-- referrals
CREATE INDEX idx_referrals_client_id ON referrals(client_id);
CREATE INDEX idx_referrals_partner_id ON referrals(partner_id);
CREATE INDEX idx_referrals_referral_type_id ON referrals(referral_type_id);
CREATE INDEX idx_referrals_referred_by ON referrals(referred_by);
CREATE INDEX idx_referrals_status_id ON referrals(status_id);
CREATE INDEX idx_referrals_referral_date ON referrals(referral_date);

-- follow_up_surveys
CREATE INDEX idx_follow_up_surveys_referral_id ON follow_up_surveys(referral_id);
CREATE INDEX idx_follow_up_surveys_status_id ON follow_up_surveys(status_id);
CREATE INDEX idx_follow_up_surveys_helpfulness_id ON follow_up_surveys(helpfulness_id);
CREATE INDEX idx_follow_up_surveys_time_to_contact_id ON follow_up_surveys(time_to_contact_id);
CREATE INDEX idx_follow_up_surveys_outcome_id ON follow_up_surveys(outcome_id);

-- M:M junctions (reverse direction indexes — PK covers the forward direction)
CREATE INDEX idx_client_service_needs_category ON client_service_needs(service_category_id);
CREATE INDEX idx_partner_service_categories_category ON partner_service_categories(service_category_id);
CREATE INDEX idx_referral_service_categories_category ON referral_service_categories(service_category_id);


-- ============================================================================
-- TIMESTAMP TRIGGERS
-- ============================================================================

CREATE TRIGGER set_created_at_trigger BEFORE INSERT ON service_categories FOR EACH ROW EXECUTE FUNCTION public.set_created_at();
CREATE TRIGGER set_updated_at_trigger BEFORE INSERT OR UPDATE ON service_categories FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER set_created_at_trigger BEFORE INSERT ON clients FOR EACH ROW EXECUTE FUNCTION public.set_created_at();
CREATE TRIGGER set_updated_at_trigger BEFORE INSERT OR UPDATE ON clients FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER set_created_at_trigger BEFORE INSERT ON partners FOR EACH ROW EXECUTE FUNCTION public.set_created_at();
CREATE TRIGGER set_updated_at_trigger BEFORE INSERT OR UPDATE ON partners FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER set_created_at_trigger BEFORE INSERT ON referrals FOR EACH ROW EXECUTE FUNCTION public.set_created_at();
CREATE TRIGGER set_updated_at_trigger BEFORE INSERT OR UPDATE ON referrals FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER set_created_at_trigger BEFORE INSERT ON follow_up_surveys FOR EACH ROW EXECUTE FUNCTION public.set_created_at();
CREATE TRIGGER set_updated_at_trigger BEFORE INSERT OR UPDATE ON follow_up_surveys FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Auto-link client to current user for self-service intake.
-- Staff (ic_staff) create records on behalf of clients, so user_id stays NULL.
CREATE OR REPLACE FUNCTION auto_set_client_user_id()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF NEW.user_id IS NULL AND NOT has_permission('clients', 'update') THEN
    NEW.user_id := current_user_id();
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER set_client_user_id_trigger
  BEFORE INSERT ON clients
  FOR EACH ROW EXECUTE FUNCTION auto_set_client_user_id();


-- ============================================================================
-- GRANTS
-- ============================================================================

-- service_categories: Public read, staff CRUD
GRANT SELECT ON service_categories TO web_anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON service_categories TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE service_categories_id_seq TO authenticated;

-- clients: No anonymous access, authenticated CRUD
GRANT SELECT, INSERT, UPDATE, DELETE ON clients TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE clients_id_seq TO authenticated;

-- partners: Public read, staff CRUD
GRANT SELECT ON partners TO web_anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON partners TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE partners_id_seq TO authenticated;

-- referrals: No anonymous access, authenticated CRUD
GRANT SELECT, INSERT, UPDATE, DELETE ON referrals TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE referrals_id_seq TO authenticated;

-- follow_up_surveys: No anonymous access, authenticated CRUD
GRANT SELECT, INSERT, UPDATE, DELETE ON follow_up_surveys TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE follow_up_surveys_id_seq TO authenticated;

-- M:M junctions
GRANT SELECT ON client_service_needs TO authenticated;
GRANT INSERT, DELETE ON client_service_needs TO authenticated;

GRANT SELECT ON partner_service_categories TO web_anon, authenticated;
GRANT INSERT, DELETE ON partner_service_categories TO authenticated;

GRANT SELECT, INSERT, DELETE ON referral_service_categories TO authenticated;


-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================

-- Clients: Staff see all, clients see only their own record
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;

CREATE POLICY clients_select ON clients FOR SELECT
  USING (has_permission('clients', 'read') OR user_id = current_user_id());

CREATE POLICY clients_insert ON clients FOR INSERT
  WITH CHECK (has_permission('clients', 'create') OR user_id = current_user_id());

CREATE POLICY clients_update ON clients FOR UPDATE
  USING (has_permission('clients', 'update'));

CREATE POLICY clients_delete ON clients FOR DELETE
  USING (has_permission('clients', 'delete'));

-- Referrals: Staff see all, clients see their own referrals
ALTER TABLE referrals ENABLE ROW LEVEL SECURITY;

CREATE POLICY referrals_select ON referrals FOR SELECT
  USING (has_permission('referrals', 'read')
    OR client_id IN (SELECT id FROM clients WHERE user_id = current_user_id()));

CREATE POLICY referrals_insert ON referrals FOR INSERT
  WITH CHECK (has_permission('referrals', 'create'));

CREATE POLICY referrals_update ON referrals FOR UPDATE
  USING (has_permission('referrals', 'update'));

CREATE POLICY referrals_delete ON referrals FOR DELETE
  USING (has_permission('referrals', 'delete'));

-- Follow-up surveys: Staff see all, clients can see/edit their own
ALTER TABLE follow_up_surveys ENABLE ROW LEVEL SECURITY;

CREATE POLICY surveys_select ON follow_up_surveys FOR SELECT
  USING (has_permission('follow_up_surveys', 'read')
    OR referral_id IN (
      SELECT r.id FROM referrals r
      JOIN clients c ON r.client_id = c.id
      WHERE c.user_id = current_user_id()
    ));

CREATE POLICY surveys_insert ON follow_up_surveys FOR INSERT
  WITH CHECK (has_permission('follow_up_surveys', 'create'));

CREATE POLICY surveys_update ON follow_up_surveys FOR UPDATE
  USING (has_permission('follow_up_surveys', 'update')
    OR referral_id IN (
      SELECT r.id FROM referrals r
      JOIN clients c ON r.client_id = c.id
      WHERE c.user_id = current_user_id()
    ));

CREATE POLICY surveys_delete ON follow_up_surveys FOR DELETE
  USING (has_permission('follow_up_surveys', 'delete'));

-- M:M junctions: Follow parent table access
ALTER TABLE client_service_needs ENABLE ROW LEVEL SECURITY;

CREATE POLICY csn_select ON client_service_needs FOR SELECT
  USING (has_permission('clients', 'read')
    OR client_id IN (SELECT id FROM clients WHERE user_id = current_user_id()));

CREATE POLICY csn_insert ON client_service_needs FOR INSERT
  WITH CHECK (has_permission('clients', 'create')
    OR client_id IN (SELECT id FROM clients WHERE user_id = current_user_id()));

CREATE POLICY csn_delete ON client_service_needs FOR DELETE
  USING (has_permission('clients', 'update'));

ALTER TABLE referral_service_categories ENABLE ROW LEVEL SECURITY;

CREATE POLICY rsc_select ON referral_service_categories FOR SELECT
  USING (has_permission('referrals', 'read'));

CREATE POLICY rsc_insert ON referral_service_categories FOR INSERT
  WITH CHECK (has_permission('referrals', 'create'));

CREATE POLICY rsc_delete ON referral_service_categories FOR DELETE
  USING (has_permission('referrals', 'update'));


-- ============================================================================
-- ENABLE ENTITY NOTES (for client records)
-- ============================================================================

SELECT enable_entity_notes('clients');


-- ============================================================================
-- SEED SERVICE CATEGORIES
-- ============================================================================

INSERT INTO service_categories (display_name, description, color, sort_order) VALUES
  ('ESL / English Classes', 'English as a Second Language instruction', '#3B82F6', 1),
  ('Employment / Job Placement', 'Job search assistance, resume help, placement services', '#22C55E', 2),
  ('Legal Aid / Immigration Legal', 'Immigration legal services, document assistance', '#8B5CF6', 3),
  ('Housing Assistance', 'Housing search, rental assistance, emergency shelter', '#F59E0B', 4),
  ('Healthcare / Medical', 'Medical care, health screenings, insurance enrollment', '#EF4444', 5),
  ('Translation / Interpretation', 'Language interpretation and document translation', '#06B6D4', 6),
  ('Transportation', 'Transit assistance, ride services, bus passes', '#F97316', 7),
  ('Food / Nutrition', 'Food pantries, SNAP benefits, nutrition programs', '#84CC16', 8),
  ('Education (non-ESL)', 'GED, vocational training, higher education', '#EC4899', 9),
  ('Financial Literacy / Benefits', 'Banking, budgeting, benefits enrollment', '#10B981', 10),
  ('Mental Health / Counseling', 'Counseling, trauma support, mental health services', '#A855F7', 11),
  ('Childcare', 'Daycare, after-school programs, childcare subsidies', '#FB923C', 12)
ON CONFLICT (display_name) DO NOTHING;


-- Notify PostgREST to reload schema cache
NOTIFY pgrst, 'reload schema';

COMMIT;
