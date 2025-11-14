-- ============================================================================
-- MOCK DATA FOR COMMUNITY CENTER EXAMPLE
-- ============================================================================
-- IMPORTANT: This script requires Civic OS core migrations to be deployed first!
-- The migrations create metadata.civic_os_users and metadata.civic_os_users_private tables.
--
-- For Docker: Migrations run automatically via init-scripts/01_run_migrations.sh
-- For hosted PostgreSQL: Run migrations manually before this script
-- ============================================================================

-- Verify metadata.civic_os_users table exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT FROM pg_tables
    WHERE schemaname = 'metadata' AND tablename = 'civic_os_users'
  ) THEN
    RAISE EXCEPTION 'metadata.civic_os_users table does not exist. Please run Civic OS migrations first (v0.9.0+).';
  END IF;
END $$;

-- civic_os_users (15 demo users)
-- Using ON CONFLICT DO NOTHING for idempotency (in case users already exist)
INSERT INTO metadata."civic_os_users" (id, display_name) VALUES ('678d40df-59e2-40cd-9d7b-7e620c2fb1b5', 'Mr. L.') ON CONFLICT (id) DO NOTHING;
INSERT INTO metadata."civic_os_users" (id, display_name) VALUES ('17383a58-fa70-4ccd-b747-6dcf6f58197d', 'Jenny S.') ON CONFLICT (id) DO NOTHING;
INSERT INTO metadata."civic_os_users" (id, display_name) VALUES ('c3ca67f7-7366-41a8-a934-2e8279269d12', 'Jeremiah S.') ON CONFLICT (id) DO NOTHING;
INSERT INTO metadata."civic_os_users" (id, display_name) VALUES ('ce3fd8d6-5346-4ccf-b111-c56b2c540aca', 'Jimmy P.') ON CONFLICT (id) DO NOTHING;
INSERT INTO metadata."civic_os_users" (id, display_name) VALUES ('f17b638a-221d-49a7-9ba8-415f37bd065f', 'Alexander W.') ON CONFLICT (id) DO NOTHING;
INSERT INTO metadata."civic_os_users" (id, display_name) VALUES ('d0f69bda-69c6-41eb-b761-0cbb6bae724c', 'Victor G.') ON CONFLICT (id) DO NOTHING;
INSERT INTO metadata."civic_os_users" (id, display_name) VALUES ('e82e28bd-a7b3-4391-8608-59b5271008b3', 'Kelvin N.') ON CONFLICT (id) DO NOTHING;
INSERT INTO metadata."civic_os_users" (id, display_name) VALUES ('93cd251f-1122-4ade-a9e5-9055bcfb1fbd', 'Nettie C.') ON CONFLICT (id) DO NOTHING;
INSERT INTO metadata."civic_os_users" (id, display_name) VALUES ('aa7a40ba-07d0-4437-96db-af51430d7f36', 'Beatrice G.') ON CONFLICT (id) DO NOTHING;
INSERT INTO metadata."civic_os_users" (id, display_name) VALUES ('8fae523e-4e06-4243-a6d3-38040a5cc87d', 'Yolanda S.') ON CONFLICT (id) DO NOTHING;
INSERT INTO metadata."civic_os_users" (id, display_name) VALUES ('617f71b1-bac4-40c8-802c-df4a0c8123df', 'Raquel S.') ON CONFLICT (id) DO NOTHING;
INSERT INTO metadata."civic_os_users" (id, display_name) VALUES ('3f2a97c3-2e08-464f-8dfc-f914a3648a12', 'Luke E.') ON CONFLICT (id) DO NOTHING;
INSERT INTO metadata."civic_os_users" (id, display_name) VALUES ('1c495e45-f90d-415c-adb9-d5b0c879c306', 'Sophia W.') ON CONFLICT (id) DO NOTHING;
INSERT INTO metadata."civic_os_users" (id, display_name) VALUES ('ad11059c-1cf5-40ac-b387-7c177a15a102', 'Jane D.') ON CONFLICT (id) DO NOTHING;
INSERT INTO metadata."civic_os_users" (id, display_name) VALUES ('4b2753fe-7fb9-4e0e-ac35-2aad86568ccb', 'Carroll L.') ON CONFLICT (id) DO NOTHING;

-- civic_os_users_private (15 records with contact info)
INSERT INTO metadata."civic_os_users_private" (id, display_name, email, phone) VALUES ('678d40df-59e2-40cd-9d7b-7e620c2fb1b5', 'Mr. L.', 'mr._lawrence@example.com', '4186151079') ON CONFLICT (id) DO NOTHING;
INSERT INTO metadata."civic_os_users_private" (id, display_name, email, phone) VALUES ('17383a58-fa70-4ccd-b747-6dcf6f58197d', 'Jenny S.', 'jenny.schinner@example.com', '8744065405') ON CONFLICT (id) DO NOTHING;
INSERT INTO metadata."civic_os_users_private" (id, display_name, email, phone) VALUES ('c3ca67f7-7366-41a8-a934-2e8279269d12', 'Jeremiah S.', 'jeremiah_stroman2@example.com', '4094970924') ON CONFLICT (id) DO NOTHING;
INSERT INTO metadata."civic_os_users_private" (id, display_name, email, phone) VALUES ('ce3fd8d6-5346-4ccf-b111-c56b2c540aca', 'Jimmy P.', 'jimmy_parisian@example.com', '3364651720') ON CONFLICT (id) DO NOTHING;
INSERT INTO metadata."civic_os_users_private" (id, display_name, email, phone) VALUES ('f17b638a-221d-49a7-9ba8-415f37bd065f', 'Alexander W.', 'alexander_walker46@example.com', '2767807918') ON CONFLICT (id) DO NOTHING;
INSERT INTO metadata."civic_os_users_private" (id, display_name, email, phone) VALUES ('d0f69bda-69c6-41eb-b761-0cbb6bae724c', 'Victor G.', 'victor.gulgowski@example.com', '4482852530') ON CONFLICT (id) DO NOTHING;
INSERT INTO metadata."civic_os_users_private" (id, display_name, email, phone) VALUES ('e82e28bd-a7b3-4391-8608-59b5271008b3', 'Kelvin N.', 'kelvin_nader-zieme@example.com', '4192580679') ON CONFLICT (id) DO NOTHING;
INSERT INTO metadata."civic_os_users_private" (id, display_name, email, phone) VALUES ('93cd251f-1122-4ade-a9e5-9055bcfb1fbd', 'Nettie C.', 'nettie.crist@example.com', '9069547237') ON CONFLICT (id) DO NOTHING;
INSERT INTO metadata."civic_os_users_private" (id, display_name, email, phone) VALUES ('aa7a40ba-07d0-4437-96db-af51430d7f36', 'Beatrice G.', 'beatrice_greenholt@example.com', '0425017390') ON CONFLICT (id) DO NOTHING;
INSERT INTO metadata."civic_os_users_private" (id, display_name, email, phone) VALUES ('8fae523e-4e06-4243-a6d3-38040a5cc87d', 'Yolanda S.', 'yolanda.sauer14@example.com', '0108579497') ON CONFLICT (id) DO NOTHING;
INSERT INTO metadata."civic_os_users_private" (id, display_name, email, phone) VALUES ('617f71b1-bac4-40c8-802c-df4a0c8123df', 'Raquel S.', 'raquel_schuppe@example.com', '0084630152') ON CONFLICT (id) DO NOTHING;
INSERT INTO metadata."civic_os_users_private" (id, display_name, email, phone) VALUES ('3f2a97c3-2e08-464f-8dfc-f914a3648a12', 'Luke E.', 'luke.emmerich32@example.com', '3082872259') ON CONFLICT (id) DO NOTHING;
INSERT INTO metadata."civic_os_users_private" (id, display_name, email, phone) VALUES ('1c495e45-f90d-415c-adb9-d5b0c879c306', 'Sophia W.', 'sophia.windler@example.com', '6518013799') ON CONFLICT (id) DO NOTHING;
INSERT INTO metadata."civic_os_users_private" (id, display_name, email, phone) VALUES ('ad11059c-1cf5-40ac-b387-7c177a15a102', 'Jane D.', 'jane.denesik@example.com', '7133778206') ON CONFLICT (id) DO NOTHING;
INSERT INTO metadata."civic_os_users_private" (id, display_name, email, phone) VALUES ('4b2753fe-7fb9-4e0e-ac35-2aad86568ccb', 'Carroll L.', 'carroll_lemke-yundt@example.com', '0607557523') ON CONFLICT (id) DO NOTHING;

-- resources (4 realistic facilities)
INSERT INTO public."resources" (display_name, description, color, capacity, hourly_rate, active, created_at, updated_at) VALUES
  ('Club House', 'Main event space with full kitchen, tables/chairs for 75, A/V system with projector and sound. Perfect for parties, receptions, and large gatherings.', '#3B82F6', 75, 25.00, TRUE, NOW() - INTERVAL '6 months', NOW() - INTERVAL '1 month'),
  ('Meeting Room', 'Quiet boardroom with conference table (seats 20), projector, whiteboard, and video conferencing setup. Ideal for business meetings and workshops.', '#10B981', 20, 15.00, TRUE, NOW() - INTERVAL '6 months', NOW() - INTERVAL '2 months'),
  ('Gymnasium', 'Full basketball court with volleyball nets, bleacher seating for 100, sound system. Available for sports, fitness classes, and large events.', '#F59E0B', 100, 50.00, TRUE, NOW() - INTERVAL '6 months', NOW() - INTERVAL '1 month'),
  ('Outdoor Pavilion', 'Covered picnic area with grills, picnic tables (seats 50), electrical outlets. Seasonal availability (April-October). Great for outdoor gatherings and BBQs.', '#8B5CF6', 50, 35.00, TRUE, NOW() - INTERVAL '6 months', NOW() - INTERVAL '3 weeks');

-- reservation_requests (12 realistic records spread across next 30 days)
-- Note: Using CURRENT_DATE for relative dates so data stays fresh
-- Status breakdown: 6 approved, 3 pending, 2 denied, 1 cancelled

-- APPROVED REQUESTS (will auto-create reservations via trigger)
INSERT INTO public."reservation_requests" (resource_id, time_slot, purpose, attendee_count, notes, requested_by, reviewed_at, created_at, updated_at) VALUES
  -- Club House - Birthday Party (approved)
  (1, tstzrange((CURRENT_DATE + INTERVAL '5 days')::timestamp + TIME '14:00', (CURRENT_DATE + INTERVAL '5 days')::timestamp + TIME '18:00'), 'Birthday Party', 45, 'Will need access to kitchen for cake and refreshments. Planning for 45 guests.', '678d40df-59e2-40cd-9d7b-7e620c2fb1b5', NOW() - INTERVAL '2 days', NOW() - INTERVAL '1 week', NOW() - INTERVAL '2 days'),

  -- Meeting Room - Board Meeting (approved)
  (2, tstzrange((CURRENT_DATE + INTERVAL '3 days')::timestamp + TIME '18:00', (CURRENT_DATE + INTERVAL '3 days')::timestamp + TIME '20:30'), 'Monthly Board Meeting', 15, 'Need video conferencing setup for 2 remote attendees. Will use projector for financial reports.', '17383a58-fa70-4ccd-b747-6dcf6f58197d', NOW() - INTERVAL '3 days', NOW() - INTERVAL '2 weeks', NOW() - INTERVAL '3 days'),

  -- Gymnasium - Youth Basketball Practice (approved)
  (3, tstzrange((CURRENT_DATE + INTERVAL '2 days')::timestamp + TIME '17:00', (CURRENT_DATE + INTERVAL '2 days')::timestamp + TIME '19:00'), 'Youth Basketball Practice', 25, 'Weekly practice for ages 10-14. Need basketball equipment and sound system.', 'c3ca67f7-7366-41a8-a934-2e8279269d12', NOW() - INTERVAL '5 days', NOW() - INTERVAL '3 weeks', NOW() - INTERVAL '5 days'),

  -- Club House - Wedding Reception (approved)
  (1, tstzrange((CURRENT_DATE + INTERVAL '15 days')::timestamp + TIME '17:00', (CURRENT_DATE + INTERVAL '15 days')::timestamp + TIME '23:00'), 'Wedding Reception', 70, 'Need early access at 2pm for decoration setup. Bringing external caterer. Will provide certificate of insurance.', 'ce3fd8d6-5346-4ccf-b111-c56b2c540aca', NOW() - INTERVAL '1 day', NOW() - INTERVAL '2 weeks', NOW() - INTERVAL '1 day'),

  -- Meeting Room - Workshop (approved)
  (2, tstzrange((CURRENT_DATE + INTERVAL '7 days')::timestamp + TIME '10:00', (CURRENT_DATE + INTERVAL '7 days')::timestamp + TIME '15:00'), 'Professional Development Workshop', 18, 'Full-day workshop for local nonprofit staff. Need projector, whiteboard, and video conferencing.', 'f17b638a-221d-49a7-9ba8-415f37bd065f', NOW() - INTERVAL '4 days', NOW() - INTERVAL '10 days', NOW() - INTERVAL '4 days'),

  -- Gymnasium - Community Fitness Class (approved)
  (3, tstzrange((CURRENT_DATE + INTERVAL '10 days')::timestamp + TIME '09:00', (CURRENT_DATE + INTERVAL '10 days')::timestamp + TIME '10:30'), 'Community Yoga & Fitness Class', 40, 'Weekly Saturday morning class. Participants bring own mats. Need sound system for music.', 'd0f69bda-69c6-41eb-b761-0cbb6bae724c', NOW() - INTERVAL '6 days', NOW() - INTERVAL '1 month', NOW() - INTERVAL '6 days');

-- PENDING REQUESTS (awaiting staff review)
INSERT INTO public."reservation_requests" (resource_id, time_slot, purpose, attendee_count, notes, requested_by, created_at, updated_at) VALUES
  -- Outdoor Pavilion - Family Reunion (pending)
  (4, tstzrange((CURRENT_DATE + INTERVAL '20 days')::timestamp + TIME '11:00', (CURRENT_DATE + INTERVAL '20 days')::timestamp + TIME '17:00'), 'Family Reunion BBQ', 50, 'Planning to use grills for cooking. Expect 50 family members. Will bring own coolers and supplies.', 'e82e28bd-a7b3-4391-8608-59b5271008b3', NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day'),

  -- Meeting Room - Training Session (pending)
  (2, tstzrange((CURRENT_DATE + INTERVAL '12 days')::timestamp + TIME '13:00', (CURRENT_DATE + INTERVAL '12 days')::timestamp + TIME '17:00'), 'Employee Training Session', 20, 'Corporate training for local business. Need projector and whiteboard. Coffee service requested.', '93cd251f-1122-4ade-a9e5-9055bcfb1fbd', NOW() - INTERVAL '2 hours', NOW() - INTERVAL '2 hours'),

  -- Club House - Fundraiser Gala (pending)
  (1, tstzrange((CURRENT_DATE + INTERVAL '25 days')::timestamp + TIME '18:00', (CURRENT_DATE + INTERVAL '26 days')::timestamp + TIME '00:00'), 'Nonprofit Fundraiser Gala', 65, 'Evening fundraiser with silent auction, dinner, and program. Need 6-hour setup time. Professional event planner coordinating.', 'aa7a40ba-07d0-4437-96db-af51430d7f36', NOW() - INTERVAL '3 hours', NOW() - INTERVAL '3 hours');

-- DENIED REQUESTS
INSERT INTO public."reservation_requests" (resource_id, time_slot, purpose, attendee_count, notes, requested_by, reviewed_at, denial_reason, created_at, updated_at) VALUES
  -- Club House - Late Night Event (denied - outside hours)
  (1, tstzrange((CURRENT_DATE + INTERVAL '8 days')::timestamp + TIME '22:00', (CURRENT_DATE + INTERVAL '9 days')::timestamp + TIME '03:00'), 'Late Night Dance Party', 60, 'DJ and sound system. Expecting 60-75 guests.', '8fae523e-4e06-4243-a6d3-38040a5cc87d', NOW() - INTERVAL '1 day', 'Facility closes at 11 PM. Cannot accommodate events ending after midnight per community center policy.', NOW() - INTERVAL '4 days', NOW() - INTERVAL '1 day'),

  -- Gymnasium - Conflicting Booking (denied - overlap)
  (3, tstzrange((CURRENT_DATE + INTERVAL '2 days')::timestamp + TIME '18:00', (CURRENT_DATE + INTERVAL '2 days')::timestamp + TIME '20:00'), 'Adult Volleyball League', 20, 'Weekly volleyball practice. Need volleyball nets and equipment.', '617f71b1-bac4-40c8-802c-df4a0c8123df', NOW() - INTERVAL '2 hours', 'Time slot conflicts with approved youth basketball practice (5:00-7:00 PM). Please select an alternative time.', NOW() - INTERVAL '1 day', NOW() - INTERVAL '2 hours');

-- CANCELLED REQUEST (user-initiated cancellation)
INSERT INTO public."reservation_requests" (resource_id, time_slot, purpose, attendee_count, notes, requested_by, reviewed_at, denial_reason, created_at, updated_at) VALUES
  -- Meeting Room - Cancelled Workshop (user cancelled)
  (2, tstzrange((CURRENT_DATE + INTERVAL '4 days')::timestamp + TIME '14:00', (CURRENT_DATE + INTERVAL '4 days')::timestamp + TIME '17:00'), 'Photography Workshop', 12, 'Beginner photography class. Need projector and screen.', '3f2a97c3-2e08-464f-8dfc-f914a3648a12', NOW() - INTERVAL '1 hour', NULL, NOW() - INTERVAL '5 days', NOW() - INTERVAL '1 hour');

-- Note: Reservations will be auto-created by database triggers when requests are approved