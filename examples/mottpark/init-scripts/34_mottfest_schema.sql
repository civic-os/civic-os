-- =============================================================================
-- MOTT FEST MODULE - PART 1: SCHEMA
-- =============================================================================
-- Annual neighborhood festival: one festival record per year, three application
-- pipelines (booth vendors, food trucks, sponsorships), an anonymous-by-design
-- feedback survey, and revenue summaries for the board.
--
-- This script: status types, categories, the mottfest_admin role, tables,
-- generated columns, get_current_festival(), normalize/consistency triggers,
-- FK indexes, grants, RLS, entity/property metadata, validations,
-- constraint_messages, status_transitions, permissions, entity notes, views
-- (current_festival, mottfest_revenue_summary, mottfest_current_summary, the
-- feedback_submission Virtual Entity) and Static Text.
--
-- Actions and Pay Now: 35_mottfest_actions_payments.sql
-- Notifications:       36_mottfest_notifications.sql
-- Dashboards and menu: 37_mottfest_dashboards_menu.sql
--
-- Re-runnable. Entity and property metadata are the module definition and are
-- upserted (re-running restores them). Statuses and categories are inserted
-- only when missing, so admin label and color edits survive a re-run.
-- Schema decisions are inserted after COMMIT, once each.
--
-- Requires: Civic OS v0.81.0+ (example 01-33 applied)
-- =============================================================================

BEGIN;

-- =============================================================================
-- 1. STATUS TYPES AND VALUES
-- =============================================================================

INSERT INTO metadata.status_types (entity_type, display_name, description) VALUES
  ('festival', 'Festival', 'Mott Fest lifecycle: Planning, Open, Closed, Completed'),
  ('vendor_application', 'Booth Vendor Application', 'Mott Fest booth vendor application workflow'),
  ('food_truck_application', 'Food Truck Application', 'Mott Fest food truck application workflow'),
  ('sponsorship_application', 'Sponsorship', 'Mott Fest sponsorship workflow')
ON CONFLICT (entity_type) DO NOTHING;

INSERT INTO metadata.statuses (entity_type, status_key, display_name, description, color, sort_order, is_initial, is_terminal) VALUES
  ('festival', 'planning',  'Planning',  'Being set up; not public and not the current festival', '#9CA3AF', 1, TRUE,  FALSE),
  ('festival', 'open',      'Open',      'Accepting applications inside the application window',  '#22C55E', 2, FALSE, FALSE),
  ('festival', 'closed',    'Closed',    'Applications closed; organizers can still enter late ones', '#F59E0B', 3, FALSE, FALSE),
  ('festival', 'completed', 'Completed', 'Festival is over and every application is resolved',    '#3B82F6', 4, FALSE, TRUE),

  ('vendor_application', 'pending',   'Pending',   'Waiting for organizer review',            '#FCD34D', 1, TRUE,  FALSE),
  ('vendor_application', 'approved',  'Approved',  'Approved; booth fee due',                 '#60A5FA', 2, FALSE, FALSE),
  ('vendor_application', 'paid',      'Paid',      'Approved and paid',                       '#22C55E', 3, FALSE, FALSE),
  ('vendor_application', 'waived',    'Waived',    'Approved with the booth fee waived',      '#14B8A6', 4, FALSE, FALSE),
  ('vendor_application', 'denied',    'Denied',    'Not accepted',                            '#EF4444', 5, FALSE, TRUE),
  ('vendor_application', 'withdrawn', 'Withdrawn', 'Withdrawn by the organizers (no refunds)', '#9CA3AF', 6, FALSE, TRUE),

  ('food_truck_application', 'pending',   'Pending',   'Waiting for organizer review',            '#FCD34D', 1, TRUE,  FALSE),
  ('food_truck_application', 'approved',  'Approved',  'Approved; food truck fee due',            '#60A5FA', 2, FALSE, FALSE),
  ('food_truck_application', 'paid',      'Paid',      'Approved and paid',                       '#22C55E', 3, FALSE, FALSE),
  ('food_truck_application', 'denied',    'Denied',    'Not accepted',                            '#EF4444', 5, FALSE, TRUE),
  ('food_truck_application', 'withdrawn', 'Withdrawn', 'Withdrawn by the organizers (no refunds)', '#9CA3AF', 6, FALSE, TRUE),

  ('sponsorship_application', 'pending',   'Pending',   'Waiting for organizer review',            '#FCD34D', 1, TRUE,  FALSE),
  ('sponsorship_application', 'approved',  'Approved',  'Approved; sponsorship payment due',       '#60A5FA', 2, FALSE, FALSE),
  ('sponsorship_application', 'paid',      'Paid',      'Approved and paid',                       '#22C55E', 3, FALSE, FALSE),
  ('sponsorship_application', 'in_kind',   'In-Kind',   'Approved in-kind gift; nothing to pay',   '#A855F7', 4, FALSE, FALSE),
  ('sponsorship_application', 'denied',    'Denied',    'Not accepted',                            '#EF4444', 5, FALSE, TRUE),
  ('sponsorship_application', 'withdrawn', 'Withdrawn', 'Withdrawn by the organizers (no refunds)', '#9CA3AF', 6, FALSE, TRUE)
ON CONFLICT (entity_type, status_key) DO NOTHING;

-- =============================================================================
-- 2. CATEGORIES
-- =============================================================================

INSERT INTO metadata.category_groups (entity_type, display_name, description) VALUES
  ('sponsorship_tier', 'Sponsorship Level', 'Mott Fest sponsorship levels. Prices live in mottfest_sponsorship_amount(); add a level only together with its price.'),
  ('vendor_type',      'Vendor Type',       'Mott Fest booth vendor types'),
  ('tshirt_size',      'T-Shirt Size',      'Sponsor t-shirt sizes'),
  ('worth_it',         'Worth It',          'Mott Fest feedback answers')
ON CONFLICT (entity_type) DO NOTHING;

INSERT INTO metadata.categories (entity_type, category_key, display_name, color, sort_order) VALUES
  ('sponsorship_tier', 'individual_100',  'Individual — $100',            '#94A3B8', 1),
  ('sponsorship_tier', 'corporate_250',   'Corporate — $250',             '#60A5FA', 2),
  ('sponsorship_tier', 'corporate_500',   'Corporate — $500',             '#3B82F6', 3),
  ('sponsorship_tier', 'corporate_1000',  'Corporate — $1,000',           '#2563EB', 4),
  ('sponsorship_tier', 'presenting_2500', 'Presenting Sponsor — $2,500',  '#F59E0B', 5),
  ('sponsorship_tier', 'custom',          'Custom Amount',                '#14B8A6', 6),
  ('sponsorship_tier', 'in_kind',         'In-Kind Gift',                 '#A855F7', 7),
  ('vendor_type', 'retail',    'Retail Vendor',              '#3B82F6', 1),
  ('vendor_type', 'nonprofit', 'Nonprofit / Resource Group', '#22C55E', 2),
  ('tshirt_size', 's',   'S',   '#9CA3AF', 1),
  ('tshirt_size', 'm',   'M',   '#9CA3AF', 2),
  ('tshirt_size', 'l',   'L',   '#9CA3AF', 3),
  ('tshirt_size', 'xl',  'XL',  '#9CA3AF', 4),
  ('tshirt_size', '2xl', '2XL', '#9CA3AF', 5),
  ('tshirt_size', '3xl', '3XL', '#9CA3AF', 6),
  ('worth_it', 'yes',   'Yes',   '#22C55E', 1),
  ('worth_it', 'no',    'No',    '#EF4444', 2),
  ('worth_it', 'other', 'Other', '#9CA3AF', 3)
ON CONFLICT (entity_type, category_key) DO NOTHING;

-- =============================================================================
-- 3. ROLE: mottfest_admin (inserting queues the Keycloak realm-role sync)
-- =============================================================================

INSERT INTO metadata.roles (display_name, description, role_key)
VALUES ('Mott Fest Admin', 'Mott Fest organizers: review applications, record payments, manage festivals', 'mottfest_admin')
ON CONFLICT (role_key) DO NOTHING;

INSERT INTO metadata.role_can_manage (manager_role_id, managed_role_id)
SELECT m.id, t.id FROM metadata.roles m, metadata.roles t
WHERE m.role_key = 'admin' AND t.role_key = 'mottfest_admin'
ON CONFLICT DO NOTHING;

-- =============================================================================
-- 4. FESTIVALS
-- =============================================================================

CREATE TABLE IF NOT EXISTS festival (
  id BIGSERIAL PRIMARY KEY,
  display_name VARCHAR(100) NOT NULL CONSTRAINT festival_display_name_key UNIQUE,
  event_date DATE NOT NULL,
  event_hours VARCHAR(100),
  location VARCHAR(255),
  applications_open_at TIMESTAMPTZ NOT NULL,
  applications_close_at TIMESTAMPTZ NOT NULL,
  payment_due_date DATE GENERATED ALWAYS AS ((event_date - INTERVAL '1 month')::date) STORED,
  vendor_fee MONEY NOT NULL DEFAULT 25::money,
  food_truck_fee MONEY NOT NULL DEFAULT 75::money,
  vendor_capacity INT CONSTRAINT festival_vendor_capacity_check CHECK (vendor_capacity >= 0),
  food_truck_capacity INT CONSTRAINT festival_food_truck_capacity_check CHECK (food_truck_capacity >= 0),
  status_id INT NOT NULL DEFAULT get_initial_status('festival') REFERENCES metadata.statuses(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT festival_window_check CHECK (applications_close_at > applications_open_at)
);

CREATE INDEX IF NOT EXISTS idx_festival_status ON festival(status_id);
CREATE INDEX IF NOT EXISTS idx_festival_event_date ON festival(event_date);

-- At most one Open festival. The predicate must be immutable, so the resolved
-- status id is written into the index definition.
DO $$
BEGIN
  EXECUTE format(
    'CREATE UNIQUE INDEX IF NOT EXISTS festival_one_open ON festival (status_id) WHERE status_id = %s',
    get_status_id('festival', 'open'));
END $$;

DROP TRIGGER IF EXISTS festival_set_created_at ON festival;
CREATE TRIGGER festival_set_created_at BEFORE INSERT ON festival
  FOR EACH ROW EXECUTE FUNCTION set_created_at();
DROP TRIGGER IF EXISTS festival_set_updated_at ON festival;
CREATE TRIGGER festival_set_updated_at BEFORE UPDATE ON festival
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Current festival: the Open festival if there is one, else the latest by event
-- date that is Closed or Completed. Planning is excluded so next year's draft
-- does not change defaults. Open always wins so an applicant's row can never
-- default to a closed festival while another one is taking applications.
-- SECURITY DEFINER so column defaults resolve the same for every caller.
CREATE OR REPLACE FUNCTION public.get_current_festival()
RETURNS BIGINT
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, metadata
AS $$
  SELECT f.id FROM festival f
  WHERE f.status_id IN (get_status_id('festival', 'open'),
                        get_status_id('festival', 'closed'),
                        get_status_id('festival', 'completed'))
  ORDER BY (f.status_id = get_status_id('festival', 'open')) DESC, f.event_date DESC, f.id DESC
  LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public.get_current_festival() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_current_festival() TO web_anon, authenticated;

-- =============================================================================
-- 5. APPLICATION TABLES (shared column convention, spec section 2)
-- =============================================================================

CREATE TABLE IF NOT EXISTS vendor_application (
  id BIGSERIAL PRIMARY KEY,
  display_name VARCHAR(200) GENERATED ALWAYS AS (business_name) STORED,
  festival_id BIGINT NOT NULL DEFAULT get_current_festival() REFERENCES festival(id),
  applicant_id UUID NOT NULL DEFAULT current_user_id() REFERENCES metadata.civic_os_users(id),
  status_id INT NOT NULL DEFAULT get_initial_status('vendor_application') REFERENCES metadata.statuses(id),
  business_name VARCHAR(200) NOT NULL,
  vendor_type_id INT NOT NULL REFERENCES metadata.categories(id),
  description TEXT NOT NULL,
  contact_name VARCHAR(150) NOT NULL,
  email email_address NOT NULL,
  phone phone_number NOT NULL,
  website VARCHAR(255),
  social_media VARCHAR(255),
  placement_request TEXT,
  coi_file UUID REFERENCES metadata.files(id) ON DELETE SET NULL,
  preferred_payment_method_id INT NOT NULL REFERENCES metadata.statuses(id),
  amount_due MONEY NOT NULL DEFAULT 0::money,
  payment_transaction_id UUID REFERENCES payments.transactions(id) ON DELETE SET NULL,
  paid_amount MONEY,
  payment_method_id INT REFERENCES metadata.statuses(id),
  payment_date DATE,
  payment_reference VARCHAR(100),
  waiver_reason TEXT,
  reviewed_by UUID REFERENCES metadata.civic_os_users(id),
  reviewed_at TIMESTAMPTZ,
  denial_reason TEXT,
  withdrawal_reason TEXT,
  promoted_on_social DATE,
  civic_os_text_search TSVECTOR GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(business_name, '') || ' ' || coalesce(contact_name, '') || ' ' || coalesce(email::text, ''))
  ) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS food_truck_application (
  id BIGSERIAL PRIMARY KEY,
  display_name VARCHAR(200) GENERATED ALWAYS AS (business_name) STORED,
  festival_id BIGINT NOT NULL DEFAULT get_current_festival() REFERENCES festival(id),
  applicant_id UUID NOT NULL DEFAULT current_user_id() REFERENCES metadata.civic_os_users(id),
  status_id INT NOT NULL DEFAULT get_initial_status('food_truck_application') REFERENCES metadata.statuses(id),
  business_name VARCHAR(200) NOT NULL,
  menu_description TEXT NOT NULL,
  contact_name VARCHAR(150) NOT NULL,
  email email_address NOT NULL,
  phone phone_number NOT NULL,
  website VARCHAR(255),
  social_media VARCHAR(255),
  setup_needs TEXT,
  health_permit_file UUID REFERENCES metadata.files(id) ON DELETE SET NULL,
  coi_file UUID REFERENCES metadata.files(id) ON DELETE SET NULL,
  preferred_payment_method_id INT NOT NULL REFERENCES metadata.statuses(id),
  amount_due MONEY NOT NULL DEFAULT 0::money,
  payment_transaction_id UUID REFERENCES payments.transactions(id) ON DELETE SET NULL,
  paid_amount MONEY,
  payment_method_id INT REFERENCES metadata.statuses(id),
  payment_date DATE,
  payment_reference VARCHAR(100),
  reviewed_by UUID REFERENCES metadata.civic_os_users(id),
  reviewed_at TIMESTAMPTZ,
  denial_reason TEXT,
  withdrawal_reason TEXT,
  promoted_on_social DATE,
  civic_os_text_search TSVECTOR GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(business_name, '') || ' ' || coalesce(contact_name, '') || ' ' || coalesce(email::text, ''))
  ) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sponsorship_application (
  id BIGSERIAL PRIMARY KEY,
  display_name VARCHAR(200) GENERATED ALWAYS AS (sponsor_name) STORED,
  festival_id BIGINT NOT NULL DEFAULT get_current_festival() REFERENCES festival(id),
  applicant_id UUID NOT NULL DEFAULT current_user_id() REFERENCES metadata.civic_os_users(id),
  status_id INT NOT NULL DEFAULT get_initial_status('sponsorship_application') REFERENCES metadata.statuses(id),
  sponsor_name VARCHAR(200) NOT NULL,
  mailing_address TEXT NOT NULL,
  contact_name VARCHAR(150) NOT NULL,
  email email_address NOT NULL,
  phone phone_number NOT NULL,
  website VARCHAR(255),
  tier_id INT NOT NULL REFERENCES metadata.categories(id),
  custom_amount MONEY,
  in_kind_description TEXT,
  in_kind_value MONEY,
  tshirt_size_id INT REFERENCES metadata.categories(id),
  logo_file UUID REFERENCES metadata.files(id) ON DELETE SET NULL,
  -- Nullable: required by trigger except for In-Kind Gift sponsorships
  preferred_payment_method_id INT REFERENCES metadata.statuses(id),
  agreed_to_terms BOOLEAN NOT NULL DEFAULT FALSE
    CONSTRAINT sponsorship_application_agreed_check CHECK (agreed_to_terms),
  agreed_at TIMESTAMPTZ,
  amount_due MONEY NOT NULL DEFAULT 0::money,
  payment_transaction_id UUID REFERENCES payments.transactions(id) ON DELETE SET NULL,
  paid_amount MONEY,
  payment_method_id INT REFERENCES metadata.statuses(id),
  payment_date DATE,
  payment_reference VARCHAR(100),
  reviewed_by UUID REFERENCES metadata.civic_os_users(id),
  reviewed_at TIMESTAMPTZ,
  denial_reason TEXT,
  withdrawal_reason TEXT,
  promoted_on_social DATE,
  thank_you_sent DATE,
  civic_os_text_search TSVECTOR GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(sponsor_name, '') || ' ' || coalesce(contact_name, '') || ' ' || coalesce(email::text, ''))
  ) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- 6. FEEDBACK (no respondent identity anywhere: no owner, no created_by)
-- =============================================================================

CREATE TABLE IF NOT EXISTS feedback_response (
  id BIGSERIAL PRIMARY KEY,
  display_name VARCHAR(50) GENERATED ALWAYS AS ('Feedback #' || id::text) STORED,
  festival_id BIGINT NOT NULL DEFAULT get_current_festival() REFERENCES festival(id),
  what_worked_well TEXT,
  what_did_not_go_well TEXT,
  worth_it_financially_id INT REFERENCES metadata.categories(id),
  worth_it_financially_other VARCHAR(255),
  worth_it_non_financially_id INT REFERENCES metadata.categories(id),
  worth_it_non_financially_other VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- 7. FK AND SEARCH INDEXES
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_vendor_apps_festival ON vendor_application(festival_id);
CREATE INDEX IF NOT EXISTS idx_vendor_apps_applicant ON vendor_application(applicant_id);
CREATE INDEX IF NOT EXISTS idx_vendor_apps_status ON vendor_application(status_id);
CREATE INDEX IF NOT EXISTS idx_vendor_apps_vendor_type ON vendor_application(vendor_type_id);
CREATE INDEX IF NOT EXISTS idx_vendor_apps_coi_file ON vendor_application(coi_file);
CREATE INDEX IF NOT EXISTS idx_vendor_apps_pref_method ON vendor_application(preferred_payment_method_id);
CREATE INDEX IF NOT EXISTS idx_vendor_apps_transaction ON vendor_application(payment_transaction_id);
CREATE INDEX IF NOT EXISTS idx_vendor_apps_pay_method ON vendor_application(payment_method_id);
CREATE INDEX IF NOT EXISTS idx_vendor_apps_reviewed_by ON vendor_application(reviewed_by);
CREATE INDEX IF NOT EXISTS idx_vendor_apps_search ON vendor_application USING GIN (civic_os_text_search);

CREATE INDEX IF NOT EXISTS idx_food_truck_apps_festival ON food_truck_application(festival_id);
CREATE INDEX IF NOT EXISTS idx_food_truck_apps_applicant ON food_truck_application(applicant_id);
CREATE INDEX IF NOT EXISTS idx_food_truck_apps_status ON food_truck_application(status_id);
CREATE INDEX IF NOT EXISTS idx_food_truck_apps_permit_file ON food_truck_application(health_permit_file);
CREATE INDEX IF NOT EXISTS idx_food_truck_apps_coi_file ON food_truck_application(coi_file);
CREATE INDEX IF NOT EXISTS idx_food_truck_apps_pref_method ON food_truck_application(preferred_payment_method_id);
CREATE INDEX IF NOT EXISTS idx_food_truck_apps_transaction ON food_truck_application(payment_transaction_id);
CREATE INDEX IF NOT EXISTS idx_food_truck_apps_pay_method ON food_truck_application(payment_method_id);
CREATE INDEX IF NOT EXISTS idx_food_truck_apps_reviewed_by ON food_truck_application(reviewed_by);
CREATE INDEX IF NOT EXISTS idx_food_truck_apps_search ON food_truck_application USING GIN (civic_os_text_search);

CREATE INDEX IF NOT EXISTS idx_sponsorship_apps_festival ON sponsorship_application(festival_id);
CREATE INDEX IF NOT EXISTS idx_sponsorship_apps_applicant ON sponsorship_application(applicant_id);
CREATE INDEX IF NOT EXISTS idx_sponsorship_apps_status ON sponsorship_application(status_id);
CREATE INDEX IF NOT EXISTS idx_sponsorship_apps_tier ON sponsorship_application(tier_id);
CREATE INDEX IF NOT EXISTS idx_sponsorship_apps_tshirt ON sponsorship_application(tshirt_size_id);
CREATE INDEX IF NOT EXISTS idx_sponsorship_apps_logo_file ON sponsorship_application(logo_file);
CREATE INDEX IF NOT EXISTS idx_sponsorship_apps_pref_method ON sponsorship_application(preferred_payment_method_id);
CREATE INDEX IF NOT EXISTS idx_sponsorship_apps_transaction ON sponsorship_application(payment_transaction_id);
CREATE INDEX IF NOT EXISTS idx_sponsorship_apps_pay_method ON sponsorship_application(payment_method_id);
CREATE INDEX IF NOT EXISTS idx_sponsorship_apps_reviewed_by ON sponsorship_application(reviewed_by);
CREATE INDEX IF NOT EXISTS idx_sponsorship_apps_search ON sponsorship_application USING GIN (civic_os_text_search);

CREATE INDEX IF NOT EXISTS idx_feedback_festival ON feedback_response(festival_id);
CREATE INDEX IF NOT EXISTS idx_feedback_worth_fin ON feedback_response(worth_it_financially_id);
CREATE INDEX IF NOT EXISTS idx_feedback_worth_nonfin ON feedback_response(worth_it_non_financially_id);

-- =============================================================================
-- 8. TRIGGER FUNCTIONS
-- =============================================================================

-- Raises unless p_id is NULL or a category of the given group.
CREATE OR REPLACE FUNCTION mottfest_assert_category(p_id INT, p_group TEXT, p_label TEXT)
RETURNS VOID
LANGUAGE plpgsql STABLE
SET search_path = public, metadata
AS $$
BEGIN
  IF p_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM metadata.categories WHERE id = p_id AND entity_type = p_group
  ) THEN
    RAISE EXCEPTION 'Choose a valid %.', p_label;
  END IF;
END;
$$;

-- Sponsorship consistency rules and price map. Returns the amount due.
-- Callers normalize blank text and zero amounts to NULL first.
CREATE OR REPLACE FUNCTION mottfest_sponsorship_amount(
  p_tier_id INT, p_custom_amount MONEY, p_in_kind_description TEXT)
RETURNS MONEY
LANGUAGE plpgsql STABLE
SET search_path = public, metadata
AS $$
DECLARE
  v_key TEXT;
BEGIN
  SELECT category_key INTO v_key FROM metadata.categories
  WHERE id = p_tier_id AND entity_type = 'sponsorship_tier';

  IF v_key IS NULL THEN
    RAISE EXCEPTION 'Choose a sponsorship level.';
  END IF;

  IF v_key = 'custom' AND (p_custom_amount IS NULL OR p_custom_amount <= 0::money) THEN
    RAISE EXCEPTION 'Enter a custom amount, or choose a fixed level';
  END IF;
  IF v_key <> 'custom' AND p_custom_amount IS NOT NULL THEN
    RAISE EXCEPTION 'Custom amount only applies to the Custom Amount level';
  END IF;
  IF v_key = 'in_kind' AND p_in_kind_description IS NULL THEN
    RAISE EXCEPTION 'Describe your in-kind gift';
  END IF;
  IF v_key <> 'in_kind' AND p_in_kind_description IS NOT NULL THEN
    RAISE EXCEPTION 'In-kind gift details only apply to the In-Kind Gift level';
  END IF;

  RETURN CASE v_key
    WHEN 'individual_100'  THEN 100::money
    WHEN 'corporate_250'   THEN 250::money
    WHEN 'corporate_500'   THEN 500::money
    WHEN 'corporate_1000'  THEN 1000::money
    WHEN 'presenting_2500' THEN 2500::money
    WHEN 'custom'          THEN p_custom_amount
    WHEN 'in_kind'         THEN 0::money
    ELSE NULL
  END;
END;
$$;

-- BEFORE INSERT on the three application tables.
--   Non-privileged callers (applicants): owner and status forced, organizer
--   fields cleared, festival must be Open and inside its window.
--   Privileged: has <table> update permission, or a database admin session
--   with no JWT user (init and deployment scripts).
--   Always: festival required, amount_due computed, consistency checks.
CREATE OR REPLACE FUNCTION mottfest_normalize_application()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, metadata
AS $$
DECLARE
  v_entity_type TEXT;
  v_privileged BOOLEAN;
  v_festival festival%ROWTYPE;
  v_tier_key TEXT;
BEGIN
  v_entity_type := CASE TG_TABLE_NAME
    WHEN 'vendor_application' THEN 'vendor_application'
    WHEN 'food_truck_application' THEN 'food_truck_application'
    WHEN 'sponsorship_application' THEN 'sponsorship_application'
  END;
  IF v_entity_type IS NULL THEN
    RAISE EXCEPTION 'mottfest_normalize_application() is not attached to a Mott Fest application table';
  END IF;

  v_privileged := has_permission(TG_TABLE_NAME::text, 'update')
    OR (current_user_id() IS NULL AND metadata._is_db_admin());

  IF NOT v_privileged THEN
    NEW.applicant_id := current_user_id();
    IF NEW.applicant_id IS NULL THEN
      RAISE EXCEPTION 'Please sign in to apply.' USING ERRCODE = '42501';
    END IF;
    NEW.status_id := get_status_id(v_entity_type, 'pending');
    NEW.payment_transaction_id := NULL;
    NEW.paid_amount := NULL;
    NEW.payment_method_id := NULL;
    NEW.payment_date := NULL;
    NEW.payment_reference := NULL;
    NEW.reviewed_by := NULL;
    NEW.reviewed_at := NULL;
    NEW.denial_reason := NULL;
    NEW.withdrawal_reason := NULL;
    NEW.promoted_on_social := NULL;
    IF TG_TABLE_NAME = 'vendor_application' THEN
      NEW.waiver_reason := NULL;
    ELSIF TG_TABLE_NAME = 'sponsorship_application' THEN
      NEW.thank_you_sent := NULL;
    END IF;
  END IF;

  IF NEW.festival_id IS NULL THEN
    IF v_privileged THEN
      RAISE EXCEPTION 'Choose a festival: no current Mott Fest is set up yet.';
    END IF;
    RAISE EXCEPTION 'Mott Fest applications are not open right now.';
  END IF;

  SELECT * INTO v_festival FROM festival WHERE id = NEW.festival_id;

  IF NOT v_privileged AND (
       NOT FOUND
    OR v_festival.status_id <> get_status_id('festival', 'open')
    OR now() < v_festival.applications_open_at
    OR now() >= v_festival.applications_close_at
  ) THEN
    RAISE EXCEPTION 'Mott Fest applications are not open right now.';
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Festival % does not exist.', NEW.festival_id;
  END IF;

  IF NEW.preferred_payment_method_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM metadata.statuses
    WHERE id = NEW.preferred_payment_method_id AND entity_type = 'payment_method'
  ) THEN
    RAISE EXCEPTION 'Choose how you will pay.';
  END IF;

  IF TG_TABLE_NAME = 'vendor_application' THEN
    PERFORM mottfest_assert_category(NEW.vendor_type_id, 'vendor_type', 'vendor type');
    NEW.amount_due := v_festival.vendor_fee;
  ELSIF TG_TABLE_NAME = 'food_truck_application' THEN
    NEW.amount_due := v_festival.food_truck_fee;
  ELSE
    NEW.in_kind_description := NULLIF(btrim(NEW.in_kind_description), '');
    IF NEW.custom_amount = 0::money THEN
      NEW.custom_amount := NULL;
    END IF;
    PERFORM mottfest_assert_category(NEW.tshirt_size_id, 'tshirt_size', 't-shirt size');
    NEW.amount_due := mottfest_sponsorship_amount(NEW.tier_id, NEW.custom_amount, NEW.in_kind_description);
    SELECT category_key INTO v_tier_key FROM metadata.categories WHERE id = NEW.tier_id;
    IF v_tier_key <> 'in_kind' AND NEW.preferred_payment_method_id IS NULL THEN
      RAISE EXCEPTION 'Choose how you will pay.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- BEFORE UPDATE on sponsorships: same consistency rules; the amount is
-- recomputed only while the sponsorship is Pending (an approved amount may
-- already be linked to a card payment).
CREATE OR REPLACE FUNCTION mottfest_sponsorship_consistency()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, metadata
AS $$
DECLARE
  v_amount MONEY;
  v_tier_key TEXT;
BEGIN
  NEW.in_kind_description := NULLIF(btrim(NEW.in_kind_description), '');
  IF NEW.custom_amount = 0::money THEN
    NEW.custom_amount := NULL;
  END IF;
  PERFORM mottfest_assert_category(NEW.tshirt_size_id, 'tshirt_size', 't-shirt size');
  v_amount := mottfest_sponsorship_amount(NEW.tier_id, NEW.custom_amount, NEW.in_kind_description);

  SELECT category_key INTO v_tier_key FROM metadata.categories WHERE id = NEW.tier_id;
  IF v_tier_key <> 'in_kind' AND NEW.preferred_payment_method_id IS NULL THEN
    RAISE EXCEPTION 'Choose how you will pay.';
  END IF;

  IF NEW.status_id = get_status_id('sponsorship_application', 'pending') THEN
    NEW.amount_due := v_amount;
  END IF;
  RETURN NEW;
END;
$$;

-- Stamp agreed_at when the terms box becomes checked (mirrors script 01).
CREATE OR REPLACE FUNCTION mottfest_stamp_agreed_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.agreed_to_terms AND (TG_OP = 'INSERT' OR NOT OLD.agreed_to_terms) THEN
    NEW.agreed_at := NOW();
  ELSIF TG_OP = 'UPDATE' AND NEW.agreed_to_terms = OLD.agreed_to_terms THEN
    NEW.agreed_at := OLD.agreed_at;
  END IF;
  RETURN NEW;
END;
$$;

-- BEFORE INSERT on feedback_response: friendly message when no festival.
CREATE OR REPLACE FUNCTION mottfest_normalize_feedback()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, metadata
AS $$
BEGIN
  IF NEW.festival_id IS NULL THEN
    RAISE EXCEPTION 'There is no Mott Fest to give feedback on yet.';
  END IF;
  PERFORM mottfest_assert_category(NEW.worth_it_financially_id, 'worth_it', 'answer');
  PERFORM mottfest_assert_category(NEW.worth_it_non_financially_id, 'worth_it', 'answer');
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION mottfest_assert_category(INT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION mottfest_sponsorship_amount(INT, MONEY, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION mottfest_normalize_application() FROM PUBLIC;
REVOKE ALL ON FUNCTION mottfest_sponsorship_consistency() FROM PUBLIC;
REVOKE ALL ON FUNCTION mottfest_stamp_agreed_at() FROM PUBLIC;
REVOKE ALL ON FUNCTION mottfest_normalize_feedback() FROM PUBLIC;
-- Helpers run inside invoker triggers, so API roles need EXECUTE on them.
GRANT EXECUTE ON FUNCTION mottfest_assert_category(INT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION mottfest_sponsorship_amount(INT, MONEY, TEXT) TO authenticated;

-- Attach triggers
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['vendor_application', 'food_truck_application', 'sponsorship_application'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS mottfest_normalize ON %I', t);
    EXECUTE format('CREATE TRIGGER mottfest_normalize BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION mottfest_normalize_application()', t);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_set_created_at', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION set_created_at()', t || '_set_created_at', t);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_set_updated_at', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t || '_set_updated_at', t);
  END LOOP;
END $$;

DROP TRIGGER IF EXISTS mottfest_sponsorship_consistency ON sponsorship_application;
CREATE TRIGGER mottfest_sponsorship_consistency
  BEFORE UPDATE OF tier_id, custom_amount, in_kind_description, preferred_payment_method_id, tshirt_size_id
  ON sponsorship_application
  FOR EACH ROW EXECUTE FUNCTION mottfest_sponsorship_consistency();

DROP TRIGGER IF EXISTS mottfest_stamp_agreed_at ON sponsorship_application;
CREATE TRIGGER mottfest_stamp_agreed_at
  BEFORE INSERT OR UPDATE ON sponsorship_application
  FOR EACH ROW EXECUTE FUNCTION mottfest_stamp_agreed_at();

DROP TRIGGER IF EXISTS mottfest_normalize_feedback ON feedback_response;
CREATE TRIGGER mottfest_normalize_feedback BEFORE INSERT ON feedback_response
  FOR EACH ROW EXECUTE FUNCTION mottfest_normalize_feedback();
DROP TRIGGER IF EXISTS feedback_response_set_created_at ON feedback_response;
CREATE TRIGGER feedback_response_set_created_at BEFORE INSERT ON feedback_response
  FOR EACH ROW EXECUTE FUNCTION set_created_at();
DROP TRIGGER IF EXISTS feedback_response_set_updated_at ON feedback_response;
CREATE TRIGGER feedback_response_set_updated_at BEFORE UPDATE ON feedback_response
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================================
-- 9. GRANTS
-- =============================================================================

GRANT SELECT ON festival TO web_anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON festival TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE festival_id_seq TO authenticated;

-- Application tables and feedback: no web_anon grant (anonymous sees "Sign in")
GRANT SELECT, INSERT, UPDATE, DELETE ON vendor_application, food_truck_application,
  sponsorship_application, feedback_response TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE vendor_application_id_seq, food_truck_application_id_seq,
  sponsorship_application_id_seq, feedback_response_id_seq TO authenticated;

-- =============================================================================
-- 10. ROW LEVEL SECURITY
-- =============================================================================

ALTER TABLE festival ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_application ENABLE ROW LEVEL SECURITY;
ALTER TABLE food_truck_application ENABLE ROW LEVEL SECURITY;
ALTER TABLE sponsorship_application ENABLE ROW LEVEL SECURITY;
ALTER TABLE feedback_response ENABLE ROW LEVEL SECURITY;

-- Festivals: Planning drafts are visible only to organizers
DROP POLICY IF EXISTS "festival: read non-planning or organizer" ON festival;
CREATE POLICY "festival: read non-planning or organizer" ON festival
  FOR SELECT TO web_anon, authenticated
  USING (status_id <> get_status_id('festival', 'planning') OR has_permission('festival', 'update'));
DROP POLICY IF EXISTS "festival: create" ON festival;
CREATE POLICY "festival: create" ON festival
  FOR INSERT TO authenticated WITH CHECK (has_permission('festival', 'create'));
DROP POLICY IF EXISTS "festival: update" ON festival;
CREATE POLICY "festival: update" ON festival
  FOR UPDATE TO authenticated
  USING (has_permission('festival', 'update')) WITH CHECK (has_permission('festival', 'update'));
DROP POLICY IF EXISTS "festival: delete" ON festival;
CREATE POLICY "festival: delete" ON festival
  FOR DELETE TO authenticated USING (has_permission('festival', 'delete'));

-- Application tables: owners read their own; no applicant UPDATE/DELETE
-- (applications lock after submit)
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['vendor_application', 'food_truck_application', 'sponsorship_application'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || ': read own or staff', t);
    EXECUTE format($p$CREATE POLICY %I ON %I FOR SELECT TO authenticated
      USING (applicant_id = current_user_id() OR has_permission(%L, 'read'))$p$, t || ': read own or staff', t, t);

    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || ': create', t);
    EXECUTE format($p$CREATE POLICY %I ON %I FOR INSERT TO authenticated
      WITH CHECK (has_permission(%L, 'create') AND (applicant_id = current_user_id() OR has_permission(%L, 'update')))$p$,
      t || ': create', t, t, t);

    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || ': staff update', t);
    EXECUTE format($p$CREATE POLICY %I ON %I FOR UPDATE TO authenticated
      USING (has_permission(%L, 'update')) WITH CHECK (has_permission(%L, 'update'))$p$, t || ': staff update', t, t, t);

    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || ': staff delete', t);
    EXECUTE format($p$CREATE POLICY %I ON %I FOR DELETE TO authenticated
      USING (has_permission(%L, 'delete'))$p$, t || ': staff delete', t, t);
  END LOOP;
END $$;

-- Feedback: organizers read and manage. Respondents write through the
-- feedback_submission Virtual Entity, never this table directly.
DROP POLICY IF EXISTS "feedback_response: read" ON feedback_response;
CREATE POLICY "feedback_response: read" ON feedback_response
  FOR SELECT TO authenticated USING (has_permission('feedback_response', 'read'));
DROP POLICY IF EXISTS "feedback_response: create" ON feedback_response;
CREATE POLICY "feedback_response: create" ON feedback_response
  FOR INSERT TO authenticated WITH CHECK (has_permission('feedback_response', 'create'));
DROP POLICY IF EXISTS "feedback_response: update" ON feedback_response;
CREATE POLICY "feedback_response: update" ON feedback_response
  FOR UPDATE TO authenticated
  USING (has_permission('feedback_response', 'update')) WITH CHECK (has_permission('feedback_response', 'update'));
DROP POLICY IF EXISTS "feedback_response: delete" ON feedback_response;
CREATE POLICY "feedback_response: delete" ON feedback_response
  FOR DELETE TO authenticated USING (has_permission('feedback_response', 'delete'));

-- =============================================================================
-- 11. VIEWS
-- =============================================================================

-- Public details of the current festival. Auto-updatable single-table view:
-- SELECT only, never INSERT/UPDATE/DELETE (writes would skip festival RLS).
CREATE OR REPLACE VIEW current_festival WITH (security_invoker = true) AS
SELECT f.id, f.display_name, f.event_date, f.event_hours, f.location,
       f.applications_open_at, f.applications_close_at, f.payment_due_date,
       f.vendor_fee, f.food_truck_fee
FROM festival f
WHERE f.id = get_current_festival();

REVOKE ALL ON current_festival FROM web_anon, authenticated;
GRANT SELECT ON current_festival TO web_anon, authenticated;

-- Per festival x pipeline. The body checks the view's own read permission,
-- because applicants can read their own rows in the base tables.
CREATE OR REPLACE VIEW mottfest_revenue_summary WITH (security_invoker = true) AS
WITH apps AS (
  SELECT 1 AS pipeline_no, a.festival_id, s.status_key, a.paid_amount, NULL::money AS in_kind_value
  FROM vendor_application a JOIN metadata.statuses s ON s.id = a.status_id
  UNION ALL
  SELECT 2, a.festival_id, s.status_key, a.paid_amount, NULL::money
  FROM food_truck_application a JOIN metadata.statuses s ON s.id = a.status_id
  UNION ALL
  SELECT 3, a.festival_id, s.status_key, a.paid_amount, a.in_kind_value
  FROM sponsorship_application a JOIN metadata.statuses s ON s.id = a.status_id
),
pipelines (pipeline_no, pipeline) AS (
  VALUES (1, 'Booth Vendors'), (2, 'Food Trucks'), (3, 'Sponsorships')
)
SELECT
  f.id * 10 + p.pipeline_no AS id,
  f.id AS festival_id,
  f.display_name AS festival_name,
  p.pipeline_no,
  p.pipeline,
  count(a.pipeline_no) AS submitted,
  count(*) FILTER (WHERE a.status_key = 'pending') AS pending,
  count(*) FILTER (WHERE a.status_key = 'approved') AS approved_unpaid,
  count(*) FILTER (WHERE a.status_key = 'paid') AS paid,
  count(*) FILTER (WHERE a.status_key = 'waived') AS waived,
  count(*) FILTER (WHERE a.status_key = 'in_kind') AS in_kind,
  count(*) FILTER (WHERE a.status_key = 'denied') AS denied,
  count(*) FILTER (WHERE a.status_key = 'withdrawn') AS withdrawn,
  COALESCE(sum(a.paid_amount), 0::money) AS total_paid,
  COALESCE(sum(a.in_kind_value), 0::money) AS in_kind_value,
  CASE p.pipeline_no WHEN 1 THEN f.vendor_capacity WHEN 2 THEN f.food_truck_capacity END AS capacity,
  count(*) FILTER (WHERE a.status_key IN ('approved', 'paid', 'waived')) AS committed
FROM festival f
CROSS JOIN pipelines p
LEFT JOIN apps a ON a.festival_id = f.id AND a.pipeline_no = p.pipeline_no
WHERE has_permission('mottfest_revenue_summary', 'read')
GROUP BY f.id, f.display_name, f.vendor_capacity, f.food_truck_capacity, p.pipeline_no, p.pipeline;

REVOKE ALL ON mottfest_revenue_summary FROM web_anon, authenticated;
GRANT SELECT ON mottfest_revenue_summary TO authenticated;

-- Current festival only, numeric money, no id: chart widgets (isSummaryView)
CREATE OR REPLACE VIEW mottfest_current_summary WITH (security_invoker = true) AS
SELECT r.pipeline_no, r.pipeline, r.submitted, r.pending, r.approved_unpaid, r.paid,
       r.waived, r.in_kind, r.denied, r.withdrawn,
       r.total_paid::numeric AS total_paid,
       r.in_kind_value::numeric AS in_kind_value,
       r.capacity, r.committed
FROM mottfest_revenue_summary r
WHERE r.festival_id = get_current_festival()
  AND has_permission('mottfest_current_summary', 'read');

REVOKE ALL ON mottfest_current_summary FROM web_anon, authenticated;
GRANT SELECT ON mottfest_current_summary TO authenticated;

-- Write-only feedback Virtual Entity. Respondents hold create (no read), so
-- the invoker view returns them no rows; the SECURITY DEFINER INSTEAD OF
-- INSERT writes the base row and returns it, recording no identity.
CREATE OR REPLACE VIEW feedback_submission WITH (security_invoker = true) AS
SELECT id, display_name, festival_id, what_worked_well, what_did_not_go_well,
       worth_it_financially_id, worth_it_financially_other,
       worth_it_non_financially_id, worth_it_non_financially_other, created_at
FROM feedback_response;

CREATE OR REPLACE FUNCTION mottfest_feedback_submission_insert()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, metadata
AS $$
DECLARE
  v_row feedback_response%ROWTYPE;
BEGIN
  IF NOT has_permission('feedback_submission', 'create') THEN
    RAISE EXCEPTION 'You do not have permission to submit Mott Fest feedback.' USING ERRCODE = '42501';
  END IF;

  -- Always the current festival; respondents never choose one
  INSERT INTO feedback_response (
    festival_id, what_worked_well, what_did_not_go_well,
    worth_it_financially_id, worth_it_financially_other,
    worth_it_non_financially_id, worth_it_non_financially_other)
  VALUES (
    get_current_festival(),
    NULLIF(btrim(NEW.what_worked_well), ''), NULLIF(btrim(NEW.what_did_not_go_well), ''),
    NEW.worth_it_financially_id, NULLIF(btrim(NEW.worth_it_financially_other), ''),
    NEW.worth_it_non_financially_id, NULLIF(btrim(NEW.worth_it_non_financially_other), ''))
  RETURNING * INTO v_row;

  NEW.id := v_row.id;
  NEW.display_name := v_row.display_name;
  NEW.festival_id := v_row.festival_id;
  NEW.created_at := v_row.created_at;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION mottfest_feedback_submission_insert() FROM PUBLIC;

DROP TRIGGER IF EXISTS feedback_submission_insert ON feedback_submission;
CREATE TRIGGER feedback_submission_insert
  INSTEAD OF INSERT ON feedback_submission
  FOR EACH ROW EXECUTE FUNCTION mottfest_feedback_submission_insert();

REVOKE ALL ON feedback_submission FROM web_anon, authenticated;
GRANT SELECT, INSERT ON feedback_submission TO authenticated;

-- =============================================================================
-- 12. ENTITY METADATA (module definition: upserted)
-- =============================================================================

INSERT INTO metadata.entities (table_name, display_name, description, sort_order, search_fields, fulltext_search_column) VALUES
  ('festival', 'Festival', 'One Mott Fest per year: dates, application window, fees and capacity', 200, NULL, NULL),
  ('vendor_application', 'Booth Vendor Application', 'Mott Fest booth vendor and resource group applications', 210,
     ARRAY['business_name', 'contact_name', 'email'], 'civic_os_text_search'),
  ('food_truck_application', 'Food Truck Application', 'Mott Fest food truck applications', 220,
     ARRAY['business_name', 'contact_name', 'email'], 'civic_os_text_search'),
  ('sponsorship_application', 'Sponsorship', 'Mott Fest sponsorships', 230,
     ARRAY['sponsor_name', 'contact_name', 'email'], 'civic_os_text_search'),
  ('feedback_response', 'Feedback Response', 'Mott Fest participant feedback (respondents are not recorded)', 240, NULL, NULL),
  ('feedback_submission', 'Mott Fest Feedback', 'Feedback form for Mott Fest vendors and food trucks', 245, NULL, NULL),
  ('mottfest_revenue_summary', 'Revenue Summary', 'Mott Fest applications and revenue per festival and pipeline', 250, NULL, NULL),
  ('mottfest_current_summary', 'Current Festival Summary', 'Revenue and status counts for the current Mott Fest (dashboard charts)', 255, NULL, NULL),
  ('current_festival', 'Current Festival', 'Public details of the current Mott Fest', 260, NULL, NULL)
ON CONFLICT (table_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  search_fields = EXCLUDED.search_fields,
  fulltext_search_column = EXCLUDED.fulltext_search_column;

-- =============================================================================
-- 13. PROPERTY METADATA (module definition: upserted)
-- =============================================================================
-- Columns: table, column, label, help, sort, width (grid span: 8 = a full row on wide screens,
--          capped at 6 and 3 on narrower ones, full row on phones),
--          filterable, list, create, edit, detail, status type, category type

INSERT INTO metadata.properties (table_name, column_name, display_name, description, sort_order, column_width,
  filterable, show_on_list, show_on_create, show_on_edit, show_on_detail, status_entity_type, category_entity_type)
SELECT * FROM (VALUES
  -- festival
  ('festival', 'display_name', 'Festival', 'e.g., "Mott Fest 2027"', 1, 3, FALSE, TRUE, TRUE, TRUE, TRUE, NULL, NULL),
  ('festival', 'status_id', 'Status', 'Changed with the action buttons.', 2, 2, TRUE, TRUE, FALSE, FALSE, TRUE, 'festival', NULL),
  ('festival', 'event_date', 'Event Date', NULL, 10, 2, FALSE, TRUE, TRUE, TRUE, TRUE, NULL, NULL),
  ('festival', 'event_hours', 'Event Hours', 'e.g., "2–8 PM"', 20, 2, FALSE, FALSE, TRUE, TRUE, TRUE, NULL, NULL),
  ('festival', 'location', 'Location', NULL, 30, 4, FALSE, FALSE, TRUE, TRUE, TRUE, NULL, NULL),
  ('festival', 'applications_open_at', 'Applications Open', 'Applicants can submit between these times while the festival is Open.', 40, 3, FALSE, TRUE, TRUE, TRUE, TRUE, NULL, NULL),
  ('festival', 'applications_close_at', 'Applications Close', NULL, 50, 3, FALSE, TRUE, TRUE, TRUE, TRUE, NULL, NULL),
  ('festival', 'payment_due_date', 'Payment Due', 'One month before the event.', 60, 2, FALSE, TRUE, FALSE, FALSE, TRUE, NULL, NULL),
  ('festival', 'vendor_fee', 'Booth Vendor Fee', 'Applies to new applications only.', 70, 2, FALSE, FALSE, TRUE, TRUE, TRUE, NULL, NULL),
  ('festival', 'food_truck_fee', 'Food Truck Fee', 'Applies to new applications only.', 80, 2, FALSE, FALSE, TRUE, TRUE, TRUE, NULL, NULL),
  ('festival', 'vendor_capacity', 'Booth Vendor Spots', 'Soft limit — approvals past it show a warning.', 90, 2, FALSE, FALSE, TRUE, TRUE, TRUE, NULL, NULL),
  ('festival', 'food_truck_capacity', 'Food Truck Spots', 'Soft limit.', 100, 2, FALSE, FALSE, TRUE, TRUE, TRUE, NULL, NULL),
  ('festival', 'created_at', 'Created', NULL, 900, 2, FALSE, FALSE, FALSE, FALSE, FALSE, NULL, NULL),
  ('festival', 'updated_at', 'Updated', NULL, 910, 2, FALSE, FALSE, FALSE, FALSE, FALSE, NULL, NULL),

  -- vendor_application
  ('vendor_application', 'display_name', 'Name', NULL, 1, 3, FALSE, TRUE, FALSE, FALSE, TRUE, NULL, NULL),
  ('vendor_application', 'status_id', 'Status', NULL, 2, 2, TRUE, TRUE, FALSE, FALSE, TRUE, 'vendor_application', NULL),
  ('vendor_application', 'festival_id', 'Festival', NULL, 3, 3, TRUE, TRUE, FALSE, TRUE, TRUE, NULL, NULL),
  ('vendor_application', 'amount_due', 'Fee', NULL, 4, 2, FALSE, TRUE, FALSE, FALSE, TRUE, NULL, NULL),
  ('vendor_application', 'business_name', 'Business / Organization Name', NULL, 10, 4, FALSE, FALSE, TRUE, TRUE, FALSE, NULL, NULL),
  ('vendor_application', 'vendor_type_id', 'Vendor Type', 'Choose Nonprofit / Resource Group if you''re sharing information or services rather than selling.', 20, 3, TRUE, TRUE, TRUE, TRUE, TRUE, NULL, 'vendor_type'),
  ('vendor_application', 'description', 'What will you sell or share?', NULL, 30, 8, FALSE, FALSE, TRUE, TRUE, TRUE, NULL, NULL),
  ('vendor_application', 'contact_name', 'Contact Person', NULL, 40, 3, FALSE, TRUE, TRUE, TRUE, TRUE, NULL, NULL),
  ('vendor_application', 'email', 'Email', NULL, 50, 3, FALSE, FALSE, TRUE, TRUE, TRUE, NULL, NULL),
  ('vendor_application', 'phone', 'Phone', NULL, 60, 2, FALSE, FALSE, TRUE, TRUE, TRUE, NULL, NULL),
  ('vendor_application', 'website', 'Website', NULL, 70, 3, FALSE, FALSE, TRUE, TRUE, TRUE, NULL, NULL),
  ('vendor_application', 'social_media', 'Social Media', 'Facebook, Instagram, or TikTok handle.', 80, 3, FALSE, FALSE, TRUE, TRUE, TRUE, NULL, NULL),
  ('vendor_application', 'placement_request', 'Placement or Accessibility Requests', 'Need to be near another vendor, indoors, or close to parking? Let us know.', 90, 8, FALSE, FALSE, TRUE, TRUE, TRUE, NULL, NULL),
  ('vendor_application', 'coi_file', 'Certificate of Insurance (optional)', 'PDF or photo.', 100, 4, FALSE, FALSE, TRUE, TRUE, TRUE, NULL, NULL),
  ('vendor_application', 'preferred_payment_method_id', 'How will you pay?', 'Credit Card means paying online after approval, which adds a processing fee. Choose Check, Cash, Money Order, or CashApp to pay by mail or in person.', 110, 3, TRUE, TRUE, TRUE, TRUE, TRUE, 'payment_method', NULL),
  ('vendor_application', 'payment_transaction_id', 'Online Payment', 'Pay Now works once your application is approved and you chose Credit Card.', 200, 3, FALSE, FALSE, FALSE, FALSE, TRUE, NULL, NULL),
  ('vendor_application', 'paid_amount', 'Amount Paid', NULL, 210, 2, FALSE, FALSE, FALSE, FALSE, TRUE, NULL, NULL),
  ('vendor_application', 'payment_method_id', 'Payment Method', NULL, 220, 2, FALSE, FALSE, FALSE, FALSE, TRUE, 'payment_method', NULL),
  ('vendor_application', 'payment_date', 'Payment Date', NULL, 230, 2, FALSE, FALSE, FALSE, FALSE, TRUE, NULL, NULL),
  ('vendor_application', 'payment_reference', 'Payment Reference', 'Check or money order number.', 240, 3, FALSE, FALSE, FALSE, FALSE, TRUE, NULL, NULL),
  ('vendor_application', 'waiver_reason', 'Fee Waiver Reason', NULL, 250, 8, FALSE, FALSE, FALSE, FALSE, TRUE, NULL, NULL),
  ('vendor_application', 'reviewed_by', 'Reviewed By', NULL, 300, 3, FALSE, FALSE, FALSE, FALSE, TRUE, NULL, NULL),
  ('vendor_application', 'reviewed_at', 'Reviewed At', NULL, 310, 3, FALSE, FALSE, FALSE, FALSE, TRUE, NULL, NULL),
  ('vendor_application', 'denial_reason', 'Denial Reason', NULL, 320, 8, FALSE, FALSE, FALSE, FALSE, TRUE, NULL, NULL),
  ('vendor_application', 'withdrawal_reason', 'Withdrawal Reason', NULL, 330, 8, FALSE, FALSE, FALSE, FALSE, TRUE, NULL, NULL),
  ('vendor_application', 'promoted_on_social', 'Promoted on Social Media', 'Date you posted about them.', 400, 3, FALSE, FALSE, FALSE, TRUE, TRUE, NULL, NULL),
  ('vendor_application', 'applicant_id', 'Account', 'Organizer-entered records belong to the organizer.', 410, 3, FALSE, FALSE, FALSE, FALSE, TRUE, NULL, NULL),
  ('vendor_application', 'created_at', 'Submitted', NULL, 420, 3, FALSE, TRUE, FALSE, FALSE, TRUE, NULL, NULL),
  ('vendor_application', 'updated_at', 'Updated', NULL, 430, 3, FALSE, FALSE, FALSE, FALSE, FALSE, NULL, NULL),
  ('vendor_application', 'civic_os_text_search', 'Search', NULL, 999, 1, FALSE, FALSE, FALSE, FALSE, FALSE, NULL, NULL),

  -- food_truck_application
  ('food_truck_application', 'display_name', 'Name', NULL, 1, 3, FALSE, TRUE, FALSE, FALSE, TRUE, NULL, NULL),
  ('food_truck_application', 'status_id', 'Status', NULL, 2, 2, TRUE, TRUE, FALSE, FALSE, TRUE, 'food_truck_application', NULL),
  ('food_truck_application', 'festival_id', 'Festival', NULL, 3, 3, TRUE, TRUE, FALSE, TRUE, TRUE, NULL, NULL),
  ('food_truck_application', 'amount_due', 'Fee', NULL, 4, 2, FALSE, TRUE, FALSE, FALSE, TRUE, NULL, NULL),
  ('food_truck_application', 'business_name', 'Business Name', NULL, 10, 4, FALSE, FALSE, TRUE, TRUE, FALSE, NULL, NULL),
  ('food_truck_application', 'menu_description', 'What will you serve?', NULL, 20, 8, FALSE, FALSE, TRUE, TRUE, TRUE, NULL, NULL),
  ('food_truck_application', 'contact_name', 'Contact Person', NULL, 30, 3, FALSE, TRUE, TRUE, TRUE, TRUE, NULL, NULL),
  ('food_truck_application', 'email', 'Email', NULL, 40, 3, FALSE, FALSE, TRUE, TRUE, TRUE, NULL, NULL),
  ('food_truck_application', 'phone', 'Phone', NULL, 50, 2, FALSE, FALSE, TRUE, TRUE, TRUE, NULL, NULL),
  ('food_truck_application', 'website', 'Website', NULL, 60, 3, FALSE, FALSE, TRUE, TRUE, TRUE, NULL, NULL),
  ('food_truck_application', 'social_media', 'Social Media', NULL, 70, 3, FALSE, FALSE, TRUE, TRUE, TRUE, NULL, NULL),
  ('food_truck_application', 'setup_needs', 'Setup Needs', 'Power, water, or space needs (truck or trailer length).', 80, 8, FALSE, FALSE, TRUE, TRUE, TRUE, NULL, NULL),
  ('food_truck_application', 'health_permit_file', 'Health Department Permit (optional)', 'PDF or photo.', 90, 4, FALSE, FALSE, TRUE, TRUE, TRUE, NULL, NULL),
  ('food_truck_application', 'coi_file', 'Certificate of Insurance (optional)', 'PDF or photo.', 100, 4, FALSE, FALSE, TRUE, TRUE, TRUE, NULL, NULL),
  ('food_truck_application', 'preferred_payment_method_id', 'How will you pay?', 'Credit Card means paying online after approval, which adds a processing fee. Choose Check, Cash, Money Order, or CashApp to pay by mail or in person.', 110, 3, TRUE, TRUE, TRUE, TRUE, TRUE, 'payment_method', NULL),
  ('food_truck_application', 'payment_transaction_id', 'Online Payment', 'Pay Now works once your application is approved and you chose Credit Card.', 200, 3, FALSE, FALSE, FALSE, FALSE, TRUE, NULL, NULL),
  ('food_truck_application', 'paid_amount', 'Amount Paid', NULL, 210, 2, FALSE, FALSE, FALSE, FALSE, TRUE, NULL, NULL),
  ('food_truck_application', 'payment_method_id', 'Payment Method', NULL, 220, 2, FALSE, FALSE, FALSE, FALSE, TRUE, 'payment_method', NULL),
  ('food_truck_application', 'payment_date', 'Payment Date', NULL, 230, 2, FALSE, FALSE, FALSE, FALSE, TRUE, NULL, NULL),
  ('food_truck_application', 'payment_reference', 'Payment Reference', 'Check or money order number.', 240, 3, FALSE, FALSE, FALSE, FALSE, TRUE, NULL, NULL),
  ('food_truck_application', 'reviewed_by', 'Reviewed By', NULL, 300, 3, FALSE, FALSE, FALSE, FALSE, TRUE, NULL, NULL),
  ('food_truck_application', 'reviewed_at', 'Reviewed At', NULL, 310, 3, FALSE, FALSE, FALSE, FALSE, TRUE, NULL, NULL),
  ('food_truck_application', 'denial_reason', 'Denial Reason', NULL, 320, 8, FALSE, FALSE, FALSE, FALSE, TRUE, NULL, NULL),
  ('food_truck_application', 'withdrawal_reason', 'Withdrawal Reason', NULL, 330, 8, FALSE, FALSE, FALSE, FALSE, TRUE, NULL, NULL),
  ('food_truck_application', 'promoted_on_social', 'Promoted on Social Media', 'Date you posted about them.', 400, 3, FALSE, FALSE, FALSE, TRUE, TRUE, NULL, NULL),
  ('food_truck_application', 'applicant_id', 'Account', 'Organizer-entered records belong to the organizer.', 410, 3, FALSE, FALSE, FALSE, FALSE, TRUE, NULL, NULL),
  ('food_truck_application', 'created_at', 'Submitted', NULL, 420, 3, FALSE, TRUE, FALSE, FALSE, TRUE, NULL, NULL),
  ('food_truck_application', 'updated_at', 'Updated', NULL, 430, 3, FALSE, FALSE, FALSE, FALSE, FALSE, NULL, NULL),
  ('food_truck_application', 'civic_os_text_search', 'Search', NULL, 999, 1, FALSE, FALSE, FALSE, FALSE, FALSE, NULL, NULL),

  -- sponsorship_application
  ('sponsorship_application', 'display_name', 'Name', NULL, 1, 3, FALSE, TRUE, FALSE, FALSE, TRUE, NULL, NULL),
  ('sponsorship_application', 'status_id', 'Status', NULL, 2, 2, TRUE, TRUE, FALSE, FALSE, TRUE, 'sponsorship_application', NULL),
  ('sponsorship_application', 'festival_id', 'Festival', NULL, 3, 3, TRUE, TRUE, FALSE, TRUE, TRUE, NULL, NULL),
  ('sponsorship_application', 'amount_due', 'Amount', NULL, 4, 2, FALSE, TRUE, FALSE, FALSE, TRUE, NULL, NULL),
  ('sponsorship_application', 'sponsor_name', 'Company / Organization / Individual Name', 'As you''d like it to appear in recognition.', 10, 4, FALSE, FALSE, TRUE, TRUE, FALSE, NULL, NULL),
  ('sponsorship_application', 'mailing_address', 'Physical Address', 'Where we''ll send your thank-you.', 20, 4, FALSE, FALSE, TRUE, TRUE, TRUE, NULL, NULL),
  ('sponsorship_application', 'contact_name', 'Contact Person', NULL, 30, 3, FALSE, TRUE, TRUE, TRUE, TRUE, NULL, NULL),
  ('sponsorship_application', 'email', 'Email', NULL, 40, 3, FALSE, FALSE, TRUE, TRUE, TRUE, NULL, NULL),
  ('sponsorship_application', 'phone', 'Phone', NULL, 50, 2, FALSE, FALSE, TRUE, TRUE, TRUE, NULL, NULL),
  ('sponsorship_application', 'website', 'Website', NULL, 60, 3, FALSE, FALSE, TRUE, TRUE, TRUE, NULL, NULL),
  ('sponsorship_application', 'tier_id', 'Sponsorship Level', 'See the levels above.', 70, 3, TRUE, TRUE, TRUE, TRUE, TRUE, NULL, 'sponsorship_tier'),
  ('sponsorship_application', 'custom_amount', 'Custom Amount', 'Only if you chose Custom Amount.', 80, 2, FALSE, FALSE, TRUE, TRUE, TRUE, NULL, NULL),
  ('sponsorship_application', 'in_kind_description', 'In-Kind Gift', 'Only if you chose In-Kind Gift: describe what you''re donating.', 90, 8, FALSE, FALSE, TRUE, TRUE, TRUE, NULL, NULL),
  ('sponsorship_application', 'in_kind_value', 'Estimated Value of Gift (optional)', NULL, 100, 3, FALSE, FALSE, TRUE, TRUE, TRUE, NULL, NULL),
  ('sponsorship_application', 'tshirt_size_id', 'T-Shirt Size', 'Every sponsorship includes a Mott Fest t-shirt.', 110, 2, FALSE, FALSE, TRUE, TRUE, TRUE, NULL, 'tshirt_size'),
  ('sponsorship_application', 'logo_file', 'Logo (optional)', 'Helps us recognize you on social media and printed materials.', 120, 4, FALSE, FALSE, TRUE, TRUE, TRUE, NULL, NULL),
  ('sponsorship_application', 'preferred_payment_method_id', 'How will you pay?', 'Not needed for an In-Kind Gift. Credit Card means paying online after approval, which adds a processing fee. Choose Check, Cash, Money Order, or CashApp to pay by mail or in person.', 130, 3, TRUE, TRUE, TRUE, TRUE, TRUE, 'payment_method', NULL),
  ('sponsorship_application', 'agreed_to_terms', 'I agree to the sponsorship terms above', NULL, 150, 8, FALSE, FALSE, TRUE, FALSE, TRUE, NULL, NULL),
  ('sponsorship_application', 'agreed_at', 'Agreed At', NULL, 160, 3, FALSE, FALSE, FALSE, FALSE, TRUE, NULL, NULL),
  ('sponsorship_application', 'payment_transaction_id', 'Online Payment', 'Pay Now works once your sponsorship is approved and you chose Credit Card.', 200, 3, FALSE, FALSE, FALSE, FALSE, TRUE, NULL, NULL),
  ('sponsorship_application', 'paid_amount', 'Amount Paid', NULL, 210, 2, FALSE, FALSE, FALSE, FALSE, TRUE, NULL, NULL),
  ('sponsorship_application', 'payment_method_id', 'Payment Method', NULL, 220, 2, FALSE, FALSE, FALSE, FALSE, TRUE, 'payment_method', NULL),
  ('sponsorship_application', 'payment_date', 'Payment Date', NULL, 230, 2, FALSE, FALSE, FALSE, FALSE, TRUE, NULL, NULL),
  ('sponsorship_application', 'payment_reference', 'Payment Reference', 'Check or money order number.', 240, 3, FALSE, FALSE, FALSE, FALSE, TRUE, NULL, NULL),
  ('sponsorship_application', 'reviewed_by', 'Reviewed By', NULL, 300, 3, FALSE, FALSE, FALSE, FALSE, TRUE, NULL, NULL),
  ('sponsorship_application', 'reviewed_at', 'Reviewed At', NULL, 310, 3, FALSE, FALSE, FALSE, FALSE, TRUE, NULL, NULL),
  ('sponsorship_application', 'denial_reason', 'Denial Reason', NULL, 320, 8, FALSE, FALSE, FALSE, FALSE, TRUE, NULL, NULL),
  ('sponsorship_application', 'withdrawal_reason', 'Withdrawal Reason', NULL, 330, 8, FALSE, FALSE, FALSE, FALSE, TRUE, NULL, NULL),
  ('sponsorship_application', 'promoted_on_social', 'Promoted on Social Media', 'Date you posted about them.', 400, 3, FALSE, FALSE, FALSE, TRUE, TRUE, NULL, NULL),
  ('sponsorship_application', 'thank_you_sent', 'Thank-You Sent', NULL, 405, 2, TRUE, TRUE, FALSE, TRUE, TRUE, NULL, NULL),
  ('sponsorship_application', 'applicant_id', 'Account', 'Organizer-entered records belong to the organizer.', 410, 3, FALSE, FALSE, FALSE, FALSE, TRUE, NULL, NULL),
  ('sponsorship_application', 'created_at', 'Submitted', NULL, 420, 3, FALSE, TRUE, FALSE, FALSE, TRUE, NULL, NULL),
  ('sponsorship_application', 'updated_at', 'Updated', NULL, 430, 3, FALSE, FALSE, FALSE, FALSE, FALSE, NULL, NULL),
  ('sponsorship_application', 'civic_os_text_search', 'Search', NULL, 999, 1, FALSE, FALSE, FALSE, FALSE, FALSE, NULL, NULL),

  -- feedback_response (organizers)
  ('feedback_response', 'display_name', 'Response', NULL, 1, 3, FALSE, TRUE, FALSE, FALSE, TRUE, NULL, NULL),
  ('feedback_response', 'festival_id', 'Festival', NULL, 2, 3, TRUE, TRUE, FALSE, TRUE, TRUE, NULL, NULL),
  ('feedback_response', 'what_worked_well', 'What Worked Well', 'What worked well for you this year? Please list as many items as you wish.', 10, 8, FALSE, FALSE, TRUE, TRUE, TRUE, NULL, NULL),
  ('feedback_response', 'what_did_not_go_well', 'What Didn''t Go Well and Suggestions', 'What did not go well? What suggestions do you have for our planning committee?', 20, 8, FALSE, FALSE, TRUE, TRUE, TRUE, NULL, NULL),
  ('feedback_response', 'worth_it_financially_id', 'Worth It Financially?', 'Was it worth it financially for you to join us at Mott Fest?', 30, 8, TRUE, TRUE, TRUE, TRUE, TRUE, NULL, 'worth_it'),
  ('feedback_response', 'worth_it_financially_other', 'If other, please explain', NULL, 40, 8, FALSE, FALSE, TRUE, TRUE, TRUE, NULL, NULL),
  ('feedback_response', 'worth_it_non_financially_id', 'Worth It in Other Ways?', 'Was it worth it in non-financial ways (fun, connections, networking, marketing, etc.) for you to join us?', 50, 8, TRUE, TRUE, TRUE, TRUE, TRUE, NULL, 'worth_it'),
  ('feedback_response', 'worth_it_non_financially_other', 'If other, please explain', NULL, 60, 8, FALSE, FALSE, TRUE, TRUE, TRUE, NULL, NULL),
  ('feedback_response', 'created_at', 'Submitted', NULL, 900, 3, FALSE, TRUE, FALSE, FALSE, TRUE, NULL, NULL),
  ('feedback_response', 'updated_at', 'Updated', NULL, 910, 3, FALSE, FALSE, FALSE, FALSE, FALSE, NULL, NULL),

  -- feedback_submission (respondent form; create only)
  ('feedback_submission', 'display_name', 'Response', NULL, 1, 3, FALSE, TRUE, FALSE, FALSE, TRUE, NULL, NULL),
  ('feedback_submission', 'festival_id', 'Festival', NULL, 2, 3, FALSE, TRUE, FALSE, FALSE, TRUE, NULL, NULL),
  ('feedback_submission', 'what_worked_well', 'What Worked Well', NULL, 10, 8, FALSE, FALSE, TRUE, FALSE, TRUE, NULL, NULL),
  ('feedback_submission', 'what_did_not_go_well', 'What Didn''t Go Well and Suggestions', NULL, 20, 8, FALSE, FALSE, TRUE, FALSE, TRUE, NULL, NULL),
  ('feedback_submission', 'worth_it_financially_id', 'Worth It Financially?', NULL, 30, 8, FALSE, FALSE, TRUE, FALSE, TRUE, NULL, 'worth_it'),
  ('feedback_submission', 'worth_it_financially_other', 'If other, please explain', NULL, 40, 8, FALSE, FALSE, TRUE, FALSE, TRUE, NULL, NULL),
  ('feedback_submission', 'worth_it_non_financially_id', 'Worth It in Other Ways?', NULL, 50, 8, FALSE, FALSE, TRUE, FALSE, TRUE, NULL, 'worth_it'),
  ('feedback_submission', 'worth_it_non_financially_other', 'If other, please explain', NULL, 60, 8, FALSE, FALSE, TRUE, FALSE, TRUE, NULL, NULL),
  ('feedback_submission', 'created_at', 'Submitted', NULL, 900, 3, FALSE, FALSE, FALSE, FALSE, FALSE, NULL, NULL),

  -- current_festival
  ('current_festival', 'display_name', 'Festival', NULL, 1, 2, FALSE, TRUE, FALSE, FALSE, TRUE, NULL, NULL),
  ('current_festival', 'event_date', 'Event Date', NULL, 10, 2, FALSE, TRUE, FALSE, FALSE, TRUE, NULL, NULL),
  ('current_festival', 'event_hours', 'Event Hours', NULL, 20, 2, FALSE, TRUE, FALSE, FALSE, TRUE, NULL, NULL),
  ('current_festival', 'location', 'Location', NULL, 30, 4, FALSE, TRUE, FALSE, FALSE, TRUE, NULL, NULL),
  ('current_festival', 'applications_open_at', 'Applications Open', NULL, 40, 2, FALSE, FALSE, FALSE, FALSE, TRUE, NULL, NULL),
  ('current_festival', 'applications_close_at', 'Applications Close', NULL, 50, 2, FALSE, TRUE, FALSE, FALSE, TRUE, NULL, NULL),
  ('current_festival', 'payment_due_date', 'Payment Due', NULL, 60, 2, FALSE, TRUE, FALSE, FALSE, TRUE, NULL, NULL),
  ('current_festival', 'vendor_fee', 'Booth Vendor Fee', NULL, 70, 2, FALSE, TRUE, FALSE, FALSE, TRUE, NULL, NULL),
  ('current_festival', 'food_truck_fee', 'Food Truck Fee', NULL, 80, 2, FALSE, TRUE, FALSE, FALSE, TRUE, NULL, NULL),

  -- mottfest_revenue_summary
  ('mottfest_revenue_summary', 'festival_id', 'Festival', NULL, 1, 2, TRUE, TRUE, FALSE, FALSE, TRUE, NULL, NULL),
  ('mottfest_revenue_summary', 'festival_name', 'Festival Name', NULL, 2, 2, FALSE, FALSE, FALSE, FALSE, FALSE, NULL, NULL),
  ('mottfest_revenue_summary', 'pipeline_no', 'Pipeline Order', NULL, 3, 2, FALSE, FALSE, FALSE, FALSE, FALSE, NULL, NULL),
  ('mottfest_revenue_summary', 'pipeline', 'Pipeline', NULL, 4, 2, FALSE, TRUE, FALSE, FALSE, TRUE, NULL, NULL),
  ('mottfest_revenue_summary', 'submitted', 'Submitted', NULL, 10, 2, FALSE, TRUE, FALSE, FALSE, TRUE, NULL, NULL),
  ('mottfest_revenue_summary', 'pending', 'Pending', NULL, 20, 2, FALSE, TRUE, FALSE, FALSE, TRUE, NULL, NULL),
  ('mottfest_revenue_summary', 'approved_unpaid', 'Approved (Unpaid)', NULL, 30, 2, FALSE, TRUE, FALSE, FALSE, TRUE, NULL, NULL),
  ('mottfest_revenue_summary', 'paid', 'Paid', NULL, 40, 2, FALSE, TRUE, FALSE, FALSE, TRUE, NULL, NULL),
  ('mottfest_revenue_summary', 'waived', 'Waived', NULL, 50, 2, FALSE, TRUE, FALSE, FALSE, TRUE, NULL, NULL),
  ('mottfest_revenue_summary', 'in_kind', 'In-Kind', NULL, 60, 2, FALSE, TRUE, FALSE, FALSE, TRUE, NULL, NULL),
  ('mottfest_revenue_summary', 'denied', 'Denied', NULL, 70, 2, FALSE, TRUE, FALSE, FALSE, TRUE, NULL, NULL),
  ('mottfest_revenue_summary', 'withdrawn', 'Withdrawn', NULL, 80, 2, FALSE, TRUE, FALSE, FALSE, TRUE, NULL, NULL),
  ('mottfest_revenue_summary', 'total_paid', 'Total Paid', 'All payments received, whatever the current status.', 90, 2, FALSE, TRUE, FALSE, FALSE, TRUE, NULL, NULL),
  ('mottfest_revenue_summary', 'in_kind_value', 'In-Kind Value', NULL, 100, 2, FALSE, TRUE, FALSE, FALSE, TRUE, NULL, NULL),
  ('mottfest_revenue_summary', 'capacity', 'Spots', NULL, 110, 2, FALSE, TRUE, FALSE, FALSE, TRUE, NULL, NULL),
  ('mottfest_revenue_summary', 'committed', 'Committed', 'Approved, paid, and waived.', 120, 2, FALSE, TRUE, FALSE, FALSE, TRUE, NULL, NULL)
) AS v(table_name, column_name, display_name, description, sort_order, column_width,
       filterable, show_on_list, show_on_create, show_on_edit, show_on_detail, status_entity_type, category_entity_type)
ON CONFLICT (table_name, column_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  column_width = EXCLUDED.column_width,
  filterable = EXCLUDED.filterable,
  show_on_list = EXCLUDED.show_on_list,
  show_on_create = EXCLUDED.show_on_create,
  show_on_edit = EXCLUDED.show_on_edit,
  show_on_detail = EXCLUDED.show_on_detail,
  status_entity_type = EXCLUDED.status_entity_type,
  category_entity_type = EXCLUDED.category_entity_type;

-- =============================================================================
-- 14. VALIDATIONS AND CONSTRAINT MESSAGES
-- =============================================================================

INSERT INTO metadata.validations (table_name, column_name, validation_type, validation_value, error_message, sort_order)
VALUES ('sponsorship_application', 'logo_file', 'fileType', 'image/*', 'Only image files are allowed', 1)
ON CONFLICT (table_name, column_name, validation_type) DO UPDATE SET
  validation_value = EXCLUDED.validation_value, error_message = EXCLUDED.error_message;

INSERT INTO metadata.constraint_messages (constraint_name, table_name, column_name, error_message) VALUES
  ('festival_window_check', 'festival', 'applications_close_at', 'Applications must close after they open.'),
  ('festival_vendor_capacity_check', 'festival', 'vendor_capacity', 'Booth vendor spots cannot be negative.'),
  ('festival_food_truck_capacity_check', 'festival', 'food_truck_capacity', 'Food truck spots cannot be negative.'),
  ('festival_display_name_key', 'festival', 'display_name', 'A festival with this name already exists.'),
  ('festival_one_open', 'festival', 'status_id', 'Another festival is already Open. Close it first.'),
  ('sponsorship_application_agreed_check', 'sponsorship_application', 'agreed_to_terms', 'Please agree to the sponsorship terms'),
  ('vendor_application_festival_id_fkey', 'vendor_application', 'festival_id', 'This festival has applications or feedback, so it cannot be deleted.'),
  ('food_truck_application_festival_id_fkey', 'food_truck_application', 'festival_id', 'This festival has applications or feedback, so it cannot be deleted.'),
  ('sponsorship_application_festival_id_fkey', 'sponsorship_application', 'festival_id', 'This festival has applications or feedback, so it cannot be deleted.'),
  ('feedback_response_festival_id_fkey', 'feedback_response', 'festival_id', 'This festival has applications or feedback, so it cannot be deleted.')
ON CONFLICT (constraint_name) DO UPDATE SET
  table_name = EXCLUDED.table_name, column_name = EXCLUDED.column_name, error_message = EXCLUDED.error_message;

-- =============================================================================
-- 15. STATUS TRANSITIONS (introspection and documentation; changes happen
--     only through the entity actions in script 35)
-- =============================================================================

INSERT INTO metadata.status_transitions (entity_type, from_status_id, to_status_id, display_name, sort_order)
SELECT t.entity_type, get_status_id(t.entity_type, t.from_key), get_status_id(t.entity_type, t.to_key), t.label, t.sort_order
FROM (VALUES
  ('festival', 'planning', 'open',      'Open Applications',   1),
  ('festival', 'closed',   'open',      'Reopen Applications', 2),
  ('festival', 'open',     'closed',    'Close Applications',  3),
  ('festival', 'closed',   'completed', 'Mark Completed',      4)
) AS t(entity_type, from_key, to_key, label, sort_order)
ON CONFLICT (entity_type, from_status_id, to_status_id) DO NOTHING;

INSERT INTO metadata.status_transitions (entity_type, from_status_id, to_status_id, display_name, sort_order)
SELECT e.entity_type, get_status_id(e.entity_type, t.from_key), get_status_id(e.entity_type, t.to_key), t.label, t.sort_order
FROM (VALUES ('vendor_application'), ('food_truck_application'), ('sponsorship_application')) AS e(entity_type)
CROSS JOIN (VALUES
  ('pending',  'approved',  'Approve',             1),
  ('pending',  'waived',    'Waive Fee & Approve', 2),
  ('pending',  'in_kind',   'Approve In-Kind',     3),
  ('approved', 'paid',      'Record Payment',      4),
  ('pending',  'denied',    'Deny',                5),
  ('approved', 'denied',    'Deny',                6),
  ('pending',  'withdrawn', 'Withdraw',            7),
  ('approved', 'withdrawn', 'Withdraw',            8),
  ('paid',     'withdrawn', 'Withdraw',            9),
  ('waived',   'withdrawn', 'Withdraw',            10),
  ('in_kind',  'withdrawn', 'Withdraw',            11)
) AS t(from_key, to_key, label, sort_order)
WHERE get_status_id(e.entity_type, t.from_key) IS NOT NULL
  AND get_status_id(e.entity_type, t.to_key) IS NOT NULL
ON CONFLICT (entity_type, from_status_id, to_status_id) DO NOTHING;

-- =============================================================================
-- 16. PERMISSIONS (RBAC)
-- =============================================================================

INSERT INTO metadata.permissions (table_name, permission)
SELECT t, p::metadata.permission
FROM unnest(ARRAY['festival', 'vendor_application', 'food_truck_application', 'sponsorship_application',
                  'feedback_response', 'feedback_submission', 'current_festival',
                  'mottfest_revenue_summary', 'mottfest_current_summary']) AS t
CROSS JOIN unnest(ARRAY['create', 'read', 'update', 'delete']) AS p
ON CONFLICT (table_name, permission) DO NOTHING;

INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM (VALUES
  ('festival', 'read',   ARRAY['anonymous', 'user', 'mottfest_admin', 'admin']),
  ('festival', 'create', ARRAY['mottfest_admin', 'admin']),
  ('festival', 'update', ARRAY['mottfest_admin', 'admin']),
  ('festival', 'delete', ARRAY['mottfest_admin', 'admin']),

  ('vendor_application', 'create', ARRAY['user', 'mottfest_admin', 'admin']),
  ('vendor_application', 'read',   ARRAY['mottfest_admin', 'admin']),
  ('vendor_application', 'update', ARRAY['mottfest_admin', 'admin']),
  ('vendor_application', 'delete', ARRAY['mottfest_admin', 'admin']),
  ('food_truck_application', 'create', ARRAY['user', 'mottfest_admin', 'admin']),
  ('food_truck_application', 'read',   ARRAY['mottfest_admin', 'admin']),
  ('food_truck_application', 'update', ARRAY['mottfest_admin', 'admin']),
  ('food_truck_application', 'delete', ARRAY['mottfest_admin', 'admin']),
  ('sponsorship_application', 'create', ARRAY['user', 'mottfest_admin', 'admin']),
  ('sponsorship_application', 'read',   ARRAY['mottfest_admin', 'admin']),
  ('sponsorship_application', 'update', ARRAY['mottfest_admin', 'admin']),
  ('sponsorship_application', 'delete', ARRAY['mottfest_admin', 'admin']),

  ('feedback_response', 'create', ARRAY['admin']),
  ('feedback_response', 'read',   ARRAY['mottfest_admin', 'admin']),
  ('feedback_response', 'update', ARRAY['mottfest_admin', 'admin']),
  ('feedback_response', 'delete', ARRAY['mottfest_admin', 'admin']),
  ('feedback_submission', 'create', ARRAY['user', 'mottfest_admin', 'admin']),

  ('current_festival', 'read', ARRAY['anonymous', 'user', 'mottfest_admin', 'admin']),
  ('mottfest_revenue_summary', 'read', ARRAY['mottfest_admin', 'admin']),
  ('mottfest_current_summary', 'read', ARRAY['mottfest_admin', 'admin'])
) AS g(table_name, permission, role_keys)
JOIN metadata.permissions p ON p.table_name = g.table_name AND p.permission::text = g.permission
JOIN metadata.roles r ON r.role_key = ANY (g.role_keys)
ON CONFLICT DO NOTHING;

-- =============================================================================
-- 17. ENTITY NOTES: staff only
-- =============================================================================
-- enable_entity_notes() grants notes to the default user/editor roles; the
-- organizer follow-up log must not be visible to applicants, so those grants
-- are removed and mottfest_admin + admin get read and create.

SELECT enable_entity_notes('vendor_application');
SELECT enable_entity_notes('food_truck_application');
SELECT enable_entity_notes('sponsorship_application');

DELETE FROM metadata.permission_roles pr
USING metadata.permissions p, metadata.roles r
WHERE pr.permission_id = p.id AND pr.role_id = r.id
  AND p.table_name IN ('vendor_application:notes', 'food_truck_application:notes', 'sponsorship_application:notes')
  AND r.role_key NOT IN ('mottfest_admin', 'admin');

INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
JOIN metadata.roles r ON r.role_key IN ('mottfest_admin', 'admin')
WHERE p.table_name IN ('vendor_application:notes', 'food_truck_application:notes', 'sponsorship_application:notes')
ON CONFLICT DO NOTHING;

-- =============================================================================
-- 18. STATIC TEXT (update in place by table and sort_order, else insert)
-- =============================================================================

CREATE TEMP TABLE mottfest_static_text (
  table_name NAME, sort_order INT, content TEXT,
  show_on_detail BOOLEAN, show_on_create BOOLEAN, show_on_edit BOOLEAN
) ON COMMIT DROP;

INSERT INTO mottfest_static_text VALUES
  ('vendor_application', 0,
   'Thanks for your interest in Mott Fest! Submit this form and our committee will review it and email you. Once approved, your fee is due one month before the festival — pay online or by check. You won''t be able to edit your application after submitting, so email us with any changes.',
   FALSE, TRUE, FALSE),
  ('food_truck_application', 0,
   'Thanks for your interest in Mott Fest! Submit this form and our committee will review it and email you. Once approved, your fee is due one month before the festival — pay online or by check. You won''t be able to edit your application after submitting, so email us with any changes.',
   FALSE, TRUE, FALSE),
  ('sponsorship_application', 0,
   E'### Sponsorship Levels\n\n'
   '| Level | Recognition |\n'
   '|---|---|\n'
   '| Individual — $100 | Celebrated on a donor board in the Clubhouse; Mott Fest t-shirt |\n'
   '| Corporate — $250 | Thanked on social media; Mott Fest t-shirt |\n'
   '| Corporate — $500 | Named on t-shirts; thanked on social media; Mott Fest t-shirt |\n'
   '| Corporate — $1,000 | Named on a large banner at Mott Fest; named on t-shirts; thanked on social media; Mott Fest t-shirt |\n'
   '| Presenting Sponsor — $2,500 | Named on the official poster as presenting sponsor; 3 minutes on the microphone during Mott Fest; use of the clubhouse for 3 events this year; and all of the above |\n'
   '| Custom Amount | Any amount you choose |\n'
   '| In-Kind Gift | Goods or services for the festival |',
   FALSE, TRUE, FALSE),
  ('sponsorship_application', 140,
   'I understand I support Mott Fest and the Mott Park Recreation Association. All sponsorship funds will be available to pay for Mott Fest and be available as undesignated funds for future MPRA projects and events. No refunds will be issued.',
   TRUE, TRUE, FALSE),
  ('feedback_submission', 0,
   'We invite feedback from food trucks and retail vendors on what worked and what can be improved for Mott Fest. Thank you for being a part of it!',
   FALSE, TRUE, FALSE),
  -- Survey questions as text above short field labels: form labels do not wrap,
  -- so a full question as a label overflows a phone screen.
  ('feedback_submission', 5, '**What worked well for you this year?** Please list as many items as you wish.', FALSE, TRUE, FALSE),
  ('feedback_submission', 15, '**What did not go well? What suggestions do you have for our planning committee?**', FALSE, TRUE, FALSE),
  ('feedback_submission', 25, '**Was it worth it financially for you to join us at Mott Fest?**', FALSE, TRUE, FALSE),
  ('feedback_submission', 45, '**Was it worth it in non-financial ways (fun, connections, networking, marketing, etc.) for you to join us?**', FALSE, TRUE, FALSE);

UPDATE metadata.static_text s
SET content = m.content, show_on_detail = m.show_on_detail,
    show_on_create = m.show_on_create, show_on_edit = m.show_on_edit, column_width = 8
FROM mottfest_static_text m
WHERE s.table_name = m.table_name AND s.sort_order = m.sort_order;

INSERT INTO metadata.static_text (table_name, content, sort_order, column_width, show_on_detail, show_on_create, show_on_edit)
SELECT m.table_name, m.content, m.sort_order, 8, m.show_on_detail, m.show_on_create, m.show_on_edit
FROM mottfest_static_text m
WHERE NOT EXISTS (
  SELECT 1 FROM metadata.static_text s WHERE s.table_name = m.table_name AND s.sort_order = m.sort_order
);

COMMIT;

-- Reload PostgREST's schema cache so new tables and views are served
NOTIFY pgrst, 'reload schema';

-- =============================================================================
-- SCHEMA DECISIONS (outside the transaction; direct INSERT because
-- create_schema_decision() requires a JWT admin context). Once each.
-- =============================================================================

CREATE FUNCTION pg_temp.mottfest_adr(
  p_title TEXT, p_entity_types NAME[], p_property_names NAME[],
  p_context TEXT, p_decision TEXT, p_rationale TEXT, p_consequences TEXT)
RETURNS VOID LANGUAGE sql AS $$
  INSERT INTO metadata.schema_decisions (entity_types, property_names, migration_id, title, status,
    context, decision, rationale, consequences, decided_date)
  SELECT p_entity_types, p_property_names, '34_mottfest_schema', p_title, 'accepted',
    p_context, p_decision, p_rationale, p_consequences, CURRENT_DATE
  WHERE NOT EXISTS (
    SELECT 1 FROM metadata.schema_decisions
    WHERE migration_id = '34_mottfest_schema' AND title = p_title);
$$;

SELECT pg_temp.mottfest_adr(
  'Mott Fest: inline single-payment fields on application entities',
  ARRAY['vendor_application', 'food_truck_application', 'sponsorship_application']::NAME[],
  ARRAY['amount_due', 'payment_transaction_id', 'paid_amount', 'payment_method_id', 'payment_date', 'payment_reference']::NAME[],
  'Each Mott Fest application has exactly one flat fee. The clubhouse uses a child reservation_payments table because a reservation has several payments.',
  'Payment columns live on each application table, including the payment_transaction_id link used by Pay Now.',
  'A child payment table would be polymorphic across three entities; inline columns keep RLS, actions and reporting simple.',
  'Multiple or partial payments per application would need a migration to a child table.');

SELECT pg_temp.mottfest_adr(
  'Mott Fest: three separate application entities',
  ARRAY['vendor_application', 'food_truck_application', 'sponsorship_application']::NAME[], NULL,
  'Field sets diverge: vendor type and placement for vendors; menu and permits for food trucks; level, in-kind and acknowledgment for sponsors.',
  'Separate tables with a shared column convention, one shared normalize trigger keyed on TG_TABLE_NAME, and shared helper RPCs.',
  'Separate entities over polymorphism (instance design principle); each gets its own form, list and permissions.',
  'Actions, triggers and templates are registered three times; templates are shared and parameterized. Moving an application between pipelines is not supported (deny with a re-apply reason).');

SELECT pg_temp.mottfest_adr(
  'Mott Fest: sponsorship level as Category, prices in code',
  ARRAY['sponsorship_application']::NAME[], ARRAY['tier_id', 'custom_amount', 'in_kind_description', 'amount_due']::NAME[],
  'Five fixed sponsorship levels plus Custom Amount and In-Kind Gift; prices are stable year to year.',
  'sponsorship_tier category group; mottfest_sponsorship_amount() maps category_key to price and enforces the custom and in-kind consistency rules with friendly messages, on insert and on update (amount recomputed only while Pending).',
  'Categories give admin UI and colored badges for free; a trigger keeps amounts authoritative regardless of client.',
  'A price change or a new level needs a script. A level without a price raises "Sponsorship level has no price configured". Category values are admin-managed, not organizer-managed.');

SELECT pg_temp.mottfest_adr(
  'Mott Fest: festival anchor, get_current_festival() default and one Open festival',
  ARRAY['festival', 'vendor_application', 'food_truck_application', 'sponsorship_application', 'feedback_response', 'feedback_submission', 'current_festival']::NAME[],
  ARRAY['festival_id', 'status_id']::NAME[],
  'Mott Fest is annual; applicants should never pick a year, and next year''s draft must not change defaults.',
  'One festival row per year. get_current_festival() (SECURITY DEFINER) returns the Open festival if there is one, else the latest Closed or Completed festival by event date, and is the festival_id default on every child table. A partial unique index (festival_one_open, predicate written with the resolved Open status id) allows at most one Open festival. Normalize triggers raise a friendly message when no festival qualifies.',
  'Evergreen: no yearly schema edits. The unique index enforces the single-Open rule for every write path, not only the Open Applications action.',
  'Late feedback after next year opens defaults to the new festival. If the Open status row is ever recreated with a new id, the index must be rebuilt (re-run this script after dropping it).');

SELECT pg_temp.mottfest_adr(
  'Mott Fest: payment due date generated from the event date',
  ARRAY['festival', 'current_festival']::NAME[], ARRAY['payment_due_date']::NAME[],
  'Fees are due one month before the festival.',
  'payment_due_date is a stored generated column, (event_date - 1 month)::date.',
  'One source of truth; organizers cannot set an inconsistent due date.',
  'A different due-date rule needs a script.');

SELECT pg_temp.mottfest_adr(
  'Mott Fest: no Guided Forms; conditional sponsorship fields always visible',
  ARRAY['sponsorship_application']::NAME[], ARRAY['custom_amount', 'in_kind_description', 'in_kind_value', 'preferred_payment_method_id']::NAME[],
  'Showing Custom Amount and In-Kind fields only for those levels would require Guided Form step tables and the dual-status pattern.',
  'Plain create form; help text says when each field applies; the trigger enforces consistency with friendly messages. preferred_payment_method_id is nullable on sponsorships and required by trigger except for In-Kind Gift.',
  'Avoids step tables and dual-status complexity for a single-page form.',
  'Custom and In-Kind fields are visible to every sponsor.');

SELECT pg_temp.mottfest_adr(
  'Mott Fest: applicants create without update; normalize trigger protects organizer fields',
  ARRAY['vendor_application', 'food_truck_application', 'sponsorship_application']::NAME[],
  ARRAY['applicant_id', 'status_id', 'reviewed_by', 'reviewed_at', 'paid_amount', 'payment_transaction_id']::NAME[],
  'Applicants must not change submitted data or set organizer-owned fields through the API.',
  'RLS: owners read their own rows, create requires create permission, update and delete require organizer permission. The BEFORE INSERT normalize trigger forces applicant_id and Pending for callers without update permission, clears payment, review and reason fields, and requires an Open festival inside its window. Scripts (database admin session with no JWT user) are treated as privileged.',
  'Permission-driven (has_permission, never role names) and enforced in the database for every client, including MCP.',
  'Every correction goes through an organizer. Organizer-entered applications belong to the organizer account.');

SELECT pg_temp.mottfest_adr(
  'Mott Fest: reuse payment_method statuses; no Venmo',
  ARRAY['vendor_application', 'food_truck_application', 'sponsorship_application']::NAME[],
  ARRAY['preferred_payment_method_id', 'payment_method_id']::NAME[],
  'The clubhouse already has a payment_method status type (Cash, Check, Credit Card, Money Order, CashApp).',
  'Reuse it unchanged for both the applicant''s preferred method and the recorded method. Credit Card means Pay Now online; help text explains it, since relabeling the shared status would change the clubhouse too.',
  'Civic OS online payment replaces Venmo; one list for both modules.',
  'The form shows "Credit Card", not "Credit card (pay online)"; the help text carries the online meaning.');

SELECT pg_temp.mottfest_adr(
  'Mott Fest: vendor-only fee waiver; in-kind as its own outcome',
  ARRAY['vendor_application', 'sponsorship_application']::NAME[], ARRAY['status_id', 'waiver_reason']::NAME[],
  'MPRA waives booth fees for some vendors; food truck fees are never waived; in-kind sponsors contribute goods instead of money.',
  'vendor_application has a Waived status; sponsorship_application has In-Kind; food_truck_application has neither. Transitions are recorded in metadata.status_transitions.',
  'An in-kind gift is a contribution, not a waiver; reporting keeps them apart.',
  'Revenue summary counts waived and in-kind separately; committed = approved + paid + waived.');

SELECT pg_temp.mottfest_adr(
  'Mott Fest: feedback through a write-only Virtual Entity, respondent not recorded',
  ARRAY['feedback_response', 'feedback_submission']::NAME[], NULL,
  'MPRA''s survey was anonymous. Login is required for spam control, but no respondent identity may be stored. The create page needs a returned row after insert, and respondents must not read feedback.',
  'feedback_response has no owner, created_by or audit link; respondents get no permission on it. They submit through feedback_submission, a security_invoker view whose SECURITY DEFINER INSTEAD OF INSERT trigger checks has_permission(feedback_submission, create), writes the base row for the current festival and returns it. The survey link redirects to a Thanks dashboard with returnTo.',
  'The invoker view returns respondents no rows, while the trigger''s RETURNING gives the create page its row; identity is never written because no column holds it.',
  'Respondents cannot view their submission; duplicates cannot be detected. Organizers read and manage feedback_response directly. (Amends spec ADR 9.)');

SELECT pg_temp.mottfest_adr(
  'Mott Fest: mottfest_admin role and permission matrix',
  ARRAY['festival', 'vendor_application', 'food_truck_application', 'sponsorship_application', 'feedback_response', 'feedback_submission', 'current_festival', 'mottfest_revenue_summary', 'mottfest_current_summary']::NAME[], NULL,
  'Festival organizers are volunteers who are not clubhouse managers; applicants self-register with the default user role.',
  'New role mottfest_admin (Keycloak realm role synced by the worker; admins may assign it through role_can_manage). user: create on the three application tables and feedback_submission, read on festival and current_festival. mottfest_admin: full CRUD on festival and applications, read/update/delete on feedback, read on the summaries. admin holds every grant explicitly. anonymous: read festival and current_festival.',
  'Separates festival organizing from clubhouse management; all checks go through has_permission.',
  'A person who organizes both needs both roles. Applicant reads of their own rows come from RLS ownership, not the read permission.');

SELECT pg_temp.mottfest_adr(
  'Mott Fest: entity notes restricted to staff',
  ARRAY['vendor_application', 'food_truck_application', 'sponsorship_application']::NAME[], NULL,
  'Notes replace the spreadsheet''s Contacted column as the organizer follow-up log. enable_entity_notes() grants notes to the default user and editor roles.',
  'After enable_entity_notes(), delete every notes grant except mottfest_admin and admin, then grant both read and create.',
  'Applicants own their rows, so a user notes grant would expose organizer notes to them.',
  'Re-running enable_entity_notes() for these tables re-adds the default grants; re-run this script afterward.');

SELECT pg_temp.mottfest_adr(
  'Mott Fest: summary views guarded by their own read permission; current_festival SELECT-only',
  ARRAY['current_festival', 'mottfest_revenue_summary', 'mottfest_current_summary']::NAME[], NULL,
  'Invoker views over the application tables would show applicants aggregates of their own rows. current_festival is a single-table view and therefore auto-updatable.',
  'Both summaries are security_invoker and filter with has_permission(<view>, read) in their bodies; mottfest_current_summary has no id and numeric money for chart widgets. current_festival is security_invoker with SELECT granted to web_anon and authenticated and nothing else.',
  'Views are projections, never privilege escalation; the in-body guard turns an aggregate leak into an empty result.',
  'Granting INSERT/UPDATE/DELETE on current_festival would let writes skip festival RLS; never do it.');
