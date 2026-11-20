-- =============================================================================
-- MOTT FEST - SAMPLE DATA (EXAMPLE ONLY, NEVER PORT TO PRODUCTION)
-- =============================================================================
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- Gives the demo something to show: one Open "Mott Fest (Sample)" festival,
-- applications in every status, and a few feedback responses.
--
-- Applications need an owner in metadata.civic_os_users, and a fresh example
-- has no users until someone signs in. Like the mock-data generator, this
-- script seeds placeholder users (fixed UUIDs, example.com addresses). They
-- are not Keycloak users, so nobody can sign in as them: testuser sees none of
-- these rows as their own, while an organizer (mottfest_admin) and admins see
-- all of them.
--
-- Review steps run through the module's own action RPCs as a sample organizer,
-- so reviewed_by, reviewed_at, amounts and the status-change system notes are
-- exactly what the real workflow writes. The notification triggers are
-- disabled for the duration of the transaction, so no sample emails are sent.
-- Approving Sample Hardware (card preference) opens an online payment, as a
-- real approval does, so the demo has one row where Pay Now works.
--
-- Idempotent: does nothing if the sample festival already exists, or if any
-- other festival is Open (only one may be). 99_reset_instance.sql removes it.
--
-- Requires: scripts 34-36.
-- =============================================================================

\set ON_ERROR_STOP on
\set QUIET on

SELECT NOT EXISTS (SELECT 1 FROM festival WHERE display_name = 'Mott Fest (Sample)')
   AND NOT EXISTS (SELECT 1 FROM festival WHERE status_id = get_status_id('festival', 'open'))
   AS mottfest_seed \gset

\if :mottfest_seed

BEGIN;

-- Placeholder users: one organizer, four applicants
INSERT INTO metadata.civic_os_users (id, display_name) VALUES
  ('5a3b1e00-0000-4000-8000-000000000001', 'Sam O.'),
  ('5a3b1e00-0000-4000-8000-000000000002', 'Rita V.'),
  ('5a3b1e00-0000-4000-8000-000000000003', 'Tomas T.'),
  ('5a3b1e00-0000-4000-8000-000000000004', 'Grace S.'),
  ('5a3b1e00-0000-4000-8000-000000000005', 'Leon P.')
ON CONFLICT (id) DO NOTHING;

INSERT INTO metadata.civic_os_users_private (id, display_name, first_name, last_name, email) VALUES
  ('5a3b1e00-0000-4000-8000-000000000001', 'Sam Organizer', 'Sam', 'Organizer', 'sample.organizer@example.com'),
  ('5a3b1e00-0000-4000-8000-000000000002', 'Rita Vendor', 'Rita', 'Vendor', 'sample.rita@example.com'),
  ('5a3b1e00-0000-4000-8000-000000000003', 'Tomas Truck', 'Tomas', 'Truck', 'sample.tomas@example.com'),
  ('5a3b1e00-0000-4000-8000-000000000004', 'Grace Sponsor', 'Grace', 'Sponsor', 'sample.grace@example.com'),
  ('5a3b1e00-0000-4000-8000-000000000005', 'Leon Potter', 'Leon', 'Potter', 'sample.leon@example.com')
ON CONFLICT (id) DO NOTHING;

-- Festival: event about six months out, applications open now
INSERT INTO festival (display_name, event_date, event_hours, location,
                       applications_open_at, applications_close_at,
                       vendor_capacity, food_truck_capacity, status_id)
VALUES ('Mott Fest (Sample)', CURRENT_DATE + 180, '12:00 PM - 8:00 PM',
        'Mott Park Recreation Area, 2401 Nolen Dr., Flint, MI',
        now() - interval '7 days', (CURRENT_DATE + 135)::timestamptz,
        40, 8, get_status_id('festival', 'open'));

-- No sample emails
ALTER TABLE vendor_application      DISABLE TRIGGER notify_mottfest_application_submitted_trigger;
ALTER TABLE vendor_application      DISABLE TRIGGER notify_mottfest_application_update_trigger;
ALTER TABLE food_truck_application  DISABLE TRIGGER notify_mottfest_application_submitted_trigger;
ALTER TABLE food_truck_application  DISABLE TRIGGER notify_mottfest_application_update_trigger;
ALTER TABLE sponsorship_application DISABLE TRIGGER notify_mottfest_application_submitted_trigger;
ALTER TABLE sponsorship_application DISABLE TRIGGER notify_mottfest_application_update_trigger;

-- Applications, inserted as their applicants (the normalize trigger then
-- applies the same rules a real submission gets)
SET LOCAL ROLE authenticated;

SELECT set_config('request.jwt.claims', '{"sub":"5a3b1e00-0000-4000-8000-000000000002","realm_access":{"roles":["user"]}}', true);
INSERT INTO vendor_application (business_name, vendor_type_id, description, contact_name, email, phone, website, preferred_payment_method_id) VALUES
  ('Nolen Drive Pottery',   get_category_id('vendor_type', 'retail'),    'Hand-thrown mugs, bowls and planters.',           'Rita Vendor', 'sample.rita@example.com', '8105550101', NULL,                         get_status_id('payment_method', 'credit_card')),
  ('Flint Honey Co.',       get_category_id('vendor_type', 'retail'),    'Local raw honey and beeswax candles.',            'Rita Vendor', 'sample.rita@example.com', '8105550101', 'https://example.com/honey', get_status_id('payment_method', 'check')),
  ('Gilkey Creek Stewards', get_category_id('vendor_type', 'nonprofit'), 'Creek cleanup sign-ups and native plant info.',   'Rita Vendor', 'sample.rita@example.com', '8105550101', NULL,                         get_status_id('payment_method', 'check'));

SELECT set_config('request.jwt.claims', '{"sub":"5a3b1e00-0000-4000-8000-000000000005","realm_access":{"roles":["user"]}}', true);
INSERT INTO vendor_application (business_name, vendor_type_id, description, contact_name, email, phone, preferred_payment_method_id) VALUES
  ('Leon''s Prints',        get_category_id('vendor_type', 'retail'),    'Screen-printed Flint posters and tote bags.',     'Leon Potter', 'sample.leon@example.com', '8105550105', get_status_id('payment_method', 'cash')),
  ('Park Side Candles',     get_category_id('vendor_type', 'retail'),    'Soy candles.',                                    'Leon Potter', 'sample.leon@example.com', '8105550105', get_status_id('payment_method', 'check')),
  ('Westside Jewelry',      get_category_id('vendor_type', 'retail'),    'Beaded jewelry.',                                 'Leon Potter', 'sample.leon@example.com', '8105550105', get_status_id('payment_method', 'check')),
  ('Corner Bookshop',       get_category_id('vendor_type', 'retail'),    'Used books and local history titles.',            'Leon Potter', 'sample.leon@example.com', '8105550105', get_status_id('payment_method', 'credit_card'));

SELECT set_config('request.jwt.claims', '{"sub":"5a3b1e00-0000-4000-8000-000000000003","realm_access":{"roles":["user"]}}', true);
INSERT INTO food_truck_application (business_name, menu_description, contact_name, email, phone, setup_needs, preferred_payment_method_id) VALUES
  ('Taco Tomas',       'Street tacos, elote, aguas frescas.', 'Tomas Truck', 'sample.tomas@example.com', '8105550103', 'One 20A outlet', get_status_id('payment_method', 'credit_card')),
  ('Coney Corner',     'Flint-style coneys and fries.',       'Tomas Truck', 'sample.tomas@example.com', '8105550103', NULL,             get_status_id('payment_method', 'check')),
  ('Sweet Spot Shaved Ice', 'Shaved ice and lemonade.',       'Tomas Truck', 'sample.tomas@example.com', '8105550103', NULL,             get_status_id('payment_method', 'check'));

SELECT set_config('request.jwt.claims', '{"sub":"5a3b1e00-0000-4000-8000-000000000004","realm_access":{"roles":["user"]}}', true);
INSERT INTO sponsorship_application (sponsor_name, mailing_address, contact_name, email, phone, tier_id, tshirt_size_id, in_kind_description, in_kind_value, preferred_payment_method_id, agreed_to_terms) VALUES
  ('Grace Sponsor',          '1 Sample St., Flint, MI 48504', 'Grace Sponsor', 'sample.grace@example.com', '8105550104', get_category_id('sponsorship_tier', 'individual_100'), get_category_id('tshirt_size', 'm'), NULL, NULL, get_status_id('payment_method', 'check'), TRUE),
  ('Sample Hardware',        '2 Sample St., Flint, MI 48504', 'Grace Sponsor', 'sample.grace@example.com', '8105550104', get_category_id('sponsorship_tier', 'corporate_500'),  get_category_id('tshirt_size', 'l'), NULL, NULL, get_status_id('payment_method', 'credit_card'), TRUE),
  ('Sample Credit Union',    '3 Sample St., Flint, MI 48504', 'Grace Sponsor', 'sample.grace@example.com', '8105550104', get_category_id('sponsorship_tier', 'corporate_250'),  get_category_id('tshirt_size', 'xl'), NULL, NULL, get_status_id('payment_method', 'cash'), TRUE),
  ('Sample Tent Rentals',    '4 Sample St., Flint, MI 48504', 'Grace Sponsor', 'sample.grace@example.com', '8105550104', get_category_id('sponsorship_tier', 'in_kind'),        NULL, 'Two 20x20 tents for the beer garden', 400::money, NULL, TRUE);

-- Review, as the sample organizer (RPC result rows are not useful in the init log)
\o /dev/null
SELECT set_config('request.jwt.claims', '{"sub":"5a3b1e00-0000-4000-8000-000000000001","realm_access":{"roles":["user","mottfest_admin"]}}', true);

SELECT approve_vendor_application(id) FROM vendor_application WHERE business_name = 'Flint Honey Co.';
SELECT record_vendor_payment(id, get_status_id('payment_method', 'check'), CURRENT_DATE, 'Check 1042')
  FROM vendor_application WHERE business_name = 'Flint Honey Co.';
SELECT waive_and_approve_vendor_application(id, 'Neighborhood nonprofit')
  FROM vendor_application WHERE business_name = 'Gilkey Creek Stewards';
SELECT approve_vendor_application(id) FROM vendor_application WHERE business_name = 'Leon''s Prints';
SELECT deny_vendor_application(id, 'We already have a candle vendor this year.')
  FROM vendor_application WHERE business_name = 'Park Side Candles';
SELECT withdraw_vendor_application(id, 'Vendor has a schedule conflict.')
  FROM vendor_application WHERE business_name = 'Westside Jewelry';
-- Nolen Drive Pottery and Corner Bookshop stay Pending.

SELECT approve_food_truck_application(id) FROM food_truck_application WHERE business_name = 'Coney Corner';
SELECT record_food_truck_payment(id, get_status_id('payment_method', 'check'), CURRENT_DATE, 'Check 311')
  FROM food_truck_application WHERE business_name = 'Coney Corner';
SELECT approve_food_truck_application(id) FROM food_truck_application WHERE business_name = 'Sweet Spot Shaved Ice';
-- Taco Tomas stays Pending.

SELECT approve_sponsorship(id) FROM sponsorship_application WHERE sponsor_name = 'Sample Hardware';
SELECT approve_sponsorship(id) FROM sponsorship_application WHERE sponsor_name = 'Sample Credit Union';
SELECT record_sponsorship_payment(id, get_status_id('payment_method', 'cash'), CURRENT_DATE, NULL)
  FROM sponsorship_application WHERE sponsor_name = 'Sample Credit Union';
SELECT approve_sponsorship(id) FROM sponsorship_application WHERE sponsor_name = 'Sample Tent Rentals';
-- Grace Sponsor (individual) stays Pending.
\o

RESET ROLE;

ALTER TABLE vendor_application      ENABLE TRIGGER notify_mottfest_application_submitted_trigger;
ALTER TABLE vendor_application      ENABLE TRIGGER notify_mottfest_application_update_trigger;
ALTER TABLE food_truck_application  ENABLE TRIGGER notify_mottfest_application_submitted_trigger;
ALTER TABLE food_truck_application  ENABLE TRIGGER notify_mottfest_application_update_trigger;
ALTER TABLE sponsorship_application ENABLE TRIGGER notify_mottfest_application_submitted_trigger;
ALTER TABLE sponsorship_application ENABLE TRIGGER notify_mottfest_application_update_trigger;

-- Feedback (anonymous by design: no respondent column exists)
INSERT INTO feedback_response (festival_id, what_worked_well, what_did_not_go_well,
                                worth_it_financially_id, worth_it_non_financially_id, worth_it_non_financially_other)
SELECT f.id, v.worked, v.not_worked, get_category_id('worth_it', v.fin), get_category_id('worth_it', v.nonfin), v.nonfin_other
FROM festival f
CROSS JOIN (VALUES
  ('Great crowd in the afternoon; easy load-in.', 'Not enough shade near the vendor row.', 'yes', 'yes', NULL),
  ('Friendly organizers and good signage.',       'Music was too loud near the food trucks.', 'no', 'yes', NULL),
  ('Met lots of neighbors.',                      'Parking was hard to find.',              'other', 'other', 'Good for visibility, sales were slow')
) AS v(worked, not_worked, fin, nonfin, nonfin_other)
WHERE f.display_name = 'Mott Fest (Sample)';

COMMIT;

\else
\echo 'Mott Fest sample data skipped: the sample festival exists or another festival is Open.'
\endif
