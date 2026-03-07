-- Generated mock data for Staff Portal
-- Generated at: 2026-03-06T22:12:12.719Z
-- Usage: psql -U postgres -d staff_portal_db -f staff-portal-mock-data.sql

-- Clear existing mock data (preserves seed/reference data)
UPDATE public.sites SET lead_id = NULL;
DELETE FROM public.staff_tasks;
DELETE FROM public.offboarding_feedback;
DELETE FROM public.reimbursements;
DELETE FROM public.incident_reports;
DELETE FROM public.time_off_requests;
DELETE FROM public.time_entries;
DELETE FROM public.staff_documents;
DELETE FROM public.staff_members;
DELETE FROM metadata.civic_os_users_private;
DELETE FROM metadata.civic_os_users;

-- civic_os_users (20 records)
INSERT INTO metadata."civic_os_users" (id, display_name) VALUES ('801fd579-d6f1-4974-9a72-c452bd146f42', 'Catherine C.');
INSERT INTO metadata."civic_os_users" (id, display_name) VALUES ('1343c0f7-1753-4458-8f08-bb4fe952e4c0', 'Dr. K.');
INSERT INTO metadata."civic_os_users" (id, display_name) VALUES ('fef4900e-6096-4492-922f-cdba842499f7', 'Mona W.');
INSERT INTO metadata."civic_os_users" (id, display_name) VALUES ('7925c1dd-18d6-4a5a-9d3e-b5be49ce0868', 'Shelly M.');
INSERT INTO metadata."civic_os_users" (id, display_name) VALUES ('2378d492-4e3f-41cb-9cab-94340c445858', 'Darryl V.');
INSERT INTO metadata."civic_os_users" (id, display_name) VALUES ('ab38d413-7b46-49d1-aac3-0f8081c94a7e', 'Darrell M.');
INSERT INTO metadata."civic_os_users" (id, display_name) VALUES ('a7bd31c4-8dc4-443d-b576-dd1c98777234', 'Michelle R.');
INSERT INTO metadata."civic_os_users" (id, display_name) VALUES ('95cc4358-06b0-405a-acd6-d26584867e7c', 'Geneva B.');
INSERT INTO metadata."civic_os_users" (id, display_name) VALUES ('cb777069-3e3a-49c9-b49d-b14aa6a537fa', 'Ms. S.');
INSERT INTO metadata."civic_os_users" (id, display_name) VALUES ('6db0854d-03b2-4f06-860c-f4bca67ffc9c', 'Dr. M.');
INSERT INTO metadata."civic_os_users" (id, display_name) VALUES ('2a33b4ae-f6ac-4669-ad4e-3ae1735c379b', 'Wilfred P.');
INSERT INTO metadata."civic_os_users" (id, display_name) VALUES ('5fd1d267-32fc-4db8-966e-0cae62b72cf6', 'Lela F.');
INSERT INTO metadata."civic_os_users" (id, display_name) VALUES ('ba921520-e617-4d47-8b86-cc9c47648483', 'Dr. C.');
INSERT INTO metadata."civic_os_users" (id, display_name) VALUES ('2fcfa636-cbde-45f8-9835-6b46126aa77b', 'Morris W.');
INSERT INTO metadata."civic_os_users" (id, display_name) VALUES ('0de387a3-a363-4212-ab44-6889a35575f5', 'Louis R.');
INSERT INTO metadata."civic_os_users" (id, display_name) VALUES ('abe0ef5d-f12f-4e65-a1c3-d98c8284c6e5', 'Misty H.');
INSERT INTO metadata."civic_os_users" (id, display_name) VALUES ('0a4e4db5-2e7b-4089-afbf-bbcdda37bf0d', 'Darrel W.');
INSERT INTO metadata."civic_os_users" (id, display_name) VALUES ('8b8edef7-3af8-486a-95d4-1478e0e0d97f', 'Cheryl H.');
INSERT INTO metadata."civic_os_users" (id, display_name) VALUES ('88f876a4-71ab-487c-8342-52c6eb31b072', 'Lee M.');
INSERT INTO metadata."civic_os_users" (id, display_name) VALUES ('368f9dbb-132a-4168-b0fd-75712fb42649', 'Dr. S.');

-- civic_os_users_private (20 records)
INSERT INTO metadata."civic_os_users_private" (id, display_name, email, phone) VALUES ('801fd579-d6f1-4974-9a72-c452bd146f42', 'Catherine C.', 'catherine_cole80@example.com', '7174104982');
INSERT INTO metadata."civic_os_users_private" (id, display_name, email, phone) VALUES ('1343c0f7-1753-4458-8f08-bb4fe952e4c0', 'Dr. K.', 'dr.kristi@example.com', '6222981064');
INSERT INTO metadata."civic_os_users_private" (id, display_name, email, phone) VALUES ('fef4900e-6096-4492-922f-cdba842499f7', 'Mona W.', 'mona.wolff@example.com', '7703658497');
INSERT INTO metadata."civic_os_users_private" (id, display_name, email, phone) VALUES ('7925c1dd-18d6-4a5a-9d3e-b5be49ce0868', 'Shelly M.', 'shelly_monahan65@example.com', '6689762310');
INSERT INTO metadata."civic_os_users_private" (id, display_name, email, phone) VALUES ('2378d492-4e3f-41cb-9cab-94340c445858', 'Darryl V.', 'darryl.veum@example.com', '5518965793');
INSERT INTO metadata."civic_os_users_private" (id, display_name, email, phone) VALUES ('ab38d413-7b46-49d1-aac3-0f8081c94a7e', 'Darrell M.', 'darrell_monahan@example.com', '9919917504');
INSERT INTO metadata."civic_os_users_private" (id, display_name, email, phone) VALUES ('a7bd31c4-8dc4-443d-b576-dd1c98777234', 'Michelle R.', 'michelle_robel@example.com', '0911235796');
INSERT INTO metadata."civic_os_users_private" (id, display_name, email, phone) VALUES ('95cc4358-06b0-405a-acd6-d26584867e7c', 'Geneva B.', 'geneva_beer@example.com', '3853424268');
INSERT INTO metadata."civic_os_users_private" (id, display_name, email, phone) VALUES ('cb777069-3e3a-49c9-b49d-b14aa6a537fa', 'Ms. S.', 'ms._sherry@example.com', '6131894182');
INSERT INTO metadata."civic_os_users_private" (id, display_name, email, phone) VALUES ('6db0854d-03b2-4f06-860c-f4bca67ffc9c', 'Dr. M.', 'dr.michael46@example.com', '8828121583');
INSERT INTO metadata."civic_os_users_private" (id, display_name, email, phone) VALUES ('2a33b4ae-f6ac-4669-ad4e-3ae1735c379b', 'Wilfred P.', 'wilfred.pfannerstill@example.com', '7961270862');
INSERT INTO metadata."civic_os_users_private" (id, display_name, email, phone) VALUES ('5fd1d267-32fc-4db8-966e-0cae62b72cf6', 'Lela F.', 'lela.funk44@example.com', '9210587934');
INSERT INTO metadata."civic_os_users_private" (id, display_name, email, phone) VALUES ('ba921520-e617-4d47-8b86-cc9c47648483', 'Dr. C.', 'dr.camille@example.com', '2038269604');
INSERT INTO metadata."civic_os_users_private" (id, display_name, email, phone) VALUES ('2fcfa636-cbde-45f8-9835-6b46126aa77b', 'Morris W.', 'morris.will@example.com', '9766937385');
INSERT INTO metadata."civic_os_users_private" (id, display_name, email, phone) VALUES ('0de387a3-a363-4212-ab44-6889a35575f5', 'Louis R.', 'louis_romaguera37@example.com', '0915626868');
INSERT INTO metadata."civic_os_users_private" (id, display_name, email, phone) VALUES ('abe0ef5d-f12f-4e65-a1c3-d98c8284c6e5', 'Misty H.', 'misty.hilll@example.com', '7941485898');
INSERT INTO metadata."civic_os_users_private" (id, display_name, email, phone) VALUES ('0a4e4db5-2e7b-4089-afbf-bbcdda37bf0d', 'Darrel W.', 'darrel.walsh@example.com', '4108860680');
INSERT INTO metadata."civic_os_users_private" (id, display_name, email, phone) VALUES ('8b8edef7-3af8-486a-95d4-1478e0e0d97f', 'Cheryl H.', 'cheryl.haley66@example.com', '9203627692');
INSERT INTO metadata."civic_os_users_private" (id, display_name, email, phone) VALUES ('88f876a4-71ab-487c-8342-52c6eb31b072', 'Lee M.', 'lee.mertz46@example.com', '6626233040');
INSERT INTO metadata."civic_os_users_private" (id, display_name, email, phone) VALUES ('368f9dbb-132a-4168-b0fd-75712fb42649', 'Dr. S.', 'dr._silvia@example.com', '3485511035');

-- staff_members (20 records)
INSERT INTO public."staff_members" (display_name, email, site_id, role_id, pay_rate, start_date, user_id) VALUES ('Andre West', 'catherine_cole80@example.com', 2, 3, 26.19, '2026-06-05', '801fd579-d6f1-4974-9a72-c452bd146f42');
INSERT INTO public."staff_members" (display_name, email, site_id, role_id, pay_rate, start_date, user_id) VALUES ('Vivian Leuschke', 'dr.kristi@example.com', 2, 1, 31.62, '2026-06-03', '1343c0f7-1753-4458-8f08-bb4fe952e4c0');
INSERT INTO public."staff_members" (display_name, email, site_id, role_id, pay_rate, start_date, user_id) VALUES ('Mr. Alex Rodriguez', 'mona.wolff@example.com', 2, 3, 17.38, '2026-06-01', 'fef4900e-6096-4492-922f-cdba842499f7');
INSERT INTO public."staff_members" (display_name, email, site_id, role_id, pay_rate, start_date, user_id) VALUES ('Willie Collins', 'shelly_monahan65@example.com', 3, 1, 16.49, '2026-06-03', '7925c1dd-18d6-4a5a-9d3e-b5be49ce0868');
INSERT INTO public."staff_members" (display_name, email, site_id, role_id, pay_rate, start_date, user_id) VALUES ('Antonio Kiehn', 'darryl.veum@example.com', 1, 1, 32.1, '2026-06-06', '2378d492-4e3f-41cb-9cab-94340c445858');
INSERT INTO public."staff_members" (display_name, email, site_id, role_id, pay_rate, start_date, user_id) VALUES ('Clara McDermott', 'darrell_monahan@example.com', 2, 1, 21.65, '2026-06-07', 'ab38d413-7b46-49d1-aac3-0f8081c94a7e');
INSERT INTO public."staff_members" (display_name, email, site_id, role_id, pay_rate, start_date, user_id) VALUES ('Teresa Simonis', 'michelle_robel@example.com', 3, 1, 16.02, '2026-06-09', 'a7bd31c4-8dc4-443d-b576-dd1c98777234');
INSERT INTO public."staff_members" (display_name, email, site_id, role_id, pay_rate, start_date, user_id) VALUES ('Aubrey Hintz', 'geneva_beer@example.com', 2, 3, 19.73, '2026-06-06', '95cc4358-06b0-405a-acd6-d26584867e7c');
INSERT INTO public."staff_members" (display_name, email, site_id, role_id, pay_rate, start_date, user_id) VALUES ('Tricia Boyle Sr.', 'ms._sherry@example.com', 2, 2, 27.25, '2026-06-06', 'cb777069-3e3a-49c9-b49d-b14aa6a537fa');
INSERT INTO public."staff_members" (display_name, email, site_id, role_id, pay_rate, start_date, user_id) VALUES ('Kristie Steuber', 'dr.michael46@example.com', 3, 4, 17.02, '2026-06-10', '6db0854d-03b2-4f06-860c-f4bca67ffc9c');
INSERT INTO public."staff_members" (display_name, email, site_id, role_id, pay_rate, start_date, user_id) VALUES ('Luke Schultz', 'wilfred.pfannerstill@example.com', 1, 1, 27.59, '2026-06-09', '2a33b4ae-f6ac-4669-ad4e-3ae1735c379b');
INSERT INTO public."staff_members" (display_name, email, site_id, role_id, pay_rate, start_date, user_id) VALUES ('Ms. Faith Christiansen', 'lela.funk44@example.com', 2, 1, 17.77, '2026-06-14', '5fd1d267-32fc-4db8-966e-0cae62b72cf6');
INSERT INTO public."staff_members" (display_name, email, site_id, role_id, pay_rate, start_date, user_id) VALUES ('Clinton Trantow', 'dr.camille@example.com', 1, 1, 24.28, '2026-06-01', 'ba921520-e617-4d47-8b86-cc9c47648483');
INSERT INTO public."staff_members" (display_name, email, site_id, role_id, pay_rate, start_date, user_id) VALUES ('Alexis Lesch-Nolan', 'morris.will@example.com', 2, 3, 23.01, '2026-06-14', '2fcfa636-cbde-45f8-9835-6b46126aa77b');
INSERT INTO public."staff_members" (display_name, email, site_id, role_id, pay_rate, start_date, user_id) VALUES ('Christy Shields', 'louis_romaguera37@example.com', 1, 4, 30.34, '2026-06-13', '0de387a3-a363-4212-ab44-6889a35575f5');
INSERT INTO public."staff_members" (display_name, email, site_id, role_id, pay_rate, start_date, user_id) VALUES ('Francis Bashirian DDS', 'misty.hilll@example.com', 2, 1, 21.17, '2026-06-04', 'abe0ef5d-f12f-4e65-a1c3-d98c8284c6e5');
INSERT INTO public."staff_members" (display_name, email, site_id, role_id, pay_rate, start_date, user_id) VALUES ('Marshall Little-Heaney', 'darrel.walsh@example.com', 1, 2, 34.63, '2026-06-11', '0a4e4db5-2e7b-4089-afbf-bbcdda37bf0d');
INSERT INTO public."staff_members" (display_name, email, site_id, role_id, pay_rate, start_date, user_id) VALUES ('Mrs. Roxanne Runte', 'cheryl.haley66@example.com', 3, 2, 21.18, '2026-06-12', '8b8edef7-3af8-486a-95d4-1478e0e0d97f');
INSERT INTO public."staff_members" (display_name, email, site_id, role_id, pay_rate, start_date, user_id) VALUES ('Ms. Florence Thiel', 'lee.mertz46@example.com', 1, 3, 33.1, '2026-06-03', '88f876a4-71ab-487c-8342-52c6eb31b072');
INSERT INTO public."staff_members" (display_name, email, site_id, role_id, pay_rate, start_date, user_id) VALUES ('Miss Helen Conroy', 'dr._silvia@example.com', 2, 2, 18.11, '2026-06-08', '368f9dbb-132a-4168-b0fd-75712fb42649');

-- time_entries (100 records)
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (18, 'clock_in', '2026-02-11T14:49:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (1, 'clock_out', '2026-02-20T22:28:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (18, 'clock_in', '2026-02-04T13:46:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (19, 'clock_out', '2026-02-28T21:14:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (10, 'clock_in', '2026-03-02T14:32:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (8, 'clock_out', '2026-03-05T21:38:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (13, 'clock_in', '2026-02-23T12:36:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (9, 'clock_out', '2026-02-17T23:36:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (11, 'clock_in', '2026-02-09T12:28:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (3, 'clock_out', '2026-03-04T22:24:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (7, 'clock_in', '2026-02-11T14:15:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (4, 'clock_out', '2026-03-01T22:56:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (5, 'clock_in', '2026-02-04T12:06:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (1, 'clock_out', '2026-02-22T21:22:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (16, 'clock_in', '2026-02-23T13:21:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (7, 'clock_out', '2026-02-06T22:22:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (16, 'clock_in', '2026-02-05T12:36:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (12, 'clock_out', '2026-02-24T21:33:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (8, 'clock_in', '2026-02-19T13:56:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (9, 'clock_out', '2026-02-11T21:06:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (11, 'clock_in', '2026-03-01T12:58:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (17, 'clock_out', '2026-02-27T22:32:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (7, 'clock_in', '2026-02-14T14:24:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (19, 'clock_out', '2026-02-23T22:31:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (19, 'clock_in', '2026-02-16T12:26:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (7, 'clock_out', '2026-02-08T21:39:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (6, 'clock_in', '2026-02-13T12:56:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (17, 'clock_out', '2026-02-08T22:48:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (13, 'clock_in', '2026-02-25T12:17:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (18, 'clock_out', '2026-02-17T23:26:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (2, 'clock_in', '2026-02-06T12:04:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (20, 'clock_out', '2026-03-02T21:59:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (11, 'clock_in', '2026-02-09T13:27:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (13, 'clock_out', '2026-02-23T21:23:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (13, 'clock_in', '2026-02-04T14:34:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (11, 'clock_out', '2026-02-19T20:40:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (13, 'clock_in', '2026-02-23T12:19:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (10, 'clock_out', '2026-02-18T23:10:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (14, 'clock_in', '2026-03-04T13:05:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (15, 'clock_out', '2026-02-16T20:57:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (8, 'clock_in', '2026-02-12T14:33:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (5, 'clock_out', '2026-02-23T21:11:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (3, 'clock_in', '2026-03-03T14:25:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (3, 'clock_out', '2026-02-20T20:46:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (18, 'clock_in', '2026-03-04T12:09:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (8, 'clock_out', '2026-02-08T20:06:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (12, 'clock_in', '2026-02-21T12:06:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (10, 'clock_out', '2026-02-28T20:55:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (2, 'clock_in', '2026-02-25T12:37:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (7, 'clock_out', '2026-03-06T20:23:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (7, 'clock_in', '2026-02-05T14:35:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (11, 'clock_out', '2026-02-11T22:40:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (12, 'clock_in', '2026-02-27T13:20:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (12, 'clock_out', '2026-02-19T23:05:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (9, 'clock_in', '2026-02-14T13:39:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (2, 'clock_out', '2026-03-02T22:50:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (4, 'clock_in', '2026-02-15T14:40:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (4, 'clock_out', '2026-02-10T23:17:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (5, 'clock_in', '2026-02-09T14:33:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (16, 'clock_out', '2026-02-05T21:01:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (19, 'clock_in', '2026-02-27T12:48:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (19, 'clock_out', '2026-02-17T20:20:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (13, 'clock_in', '2026-02-18T13:35:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (1, 'clock_out', '2026-02-28T21:43:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (13, 'clock_in', '2026-02-14T12:31:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (3, 'clock_out', '2026-02-28T21:11:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (11, 'clock_in', '2026-02-22T12:56:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (18, 'clock_out', '2026-02-25T23:13:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (9, 'clock_in', '2026-03-02T12:37:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (19, 'clock_out', '2026-02-15T21:28:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (12, 'clock_in', '2026-03-03T14:15:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (11, 'clock_out', '2026-02-08T21:41:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (6, 'clock_in', '2026-02-12T13:10:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (7, 'clock_out', '2026-02-06T22:01:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (16, 'clock_in', '2026-03-03T13:09:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (12, 'clock_out', '2026-02-08T22:38:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (19, 'clock_in', '2026-02-04T12:18:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (3, 'clock_out', '2026-02-25T21:34:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (10, 'clock_in', '2026-02-13T13:42:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (19, 'clock_out', '2026-02-14T20:28:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (8, 'clock_in', '2026-03-06T12:12:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (17, 'clock_out', '2026-02-16T22:10:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (3, 'clock_in', '2026-02-05T13:23:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (20, 'clock_out', '2026-02-05T21:43:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (6, 'clock_in', '2026-02-23T12:18:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (7, 'clock_out', '2026-03-02T21:08:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (4, 'clock_in', '2026-02-08T14:30:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (1, 'clock_out', '2026-02-10T22:56:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (19, 'clock_in', '2026-02-21T14:19:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (16, 'clock_out', '2026-03-04T22:47:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (18, 'clock_in', '2026-03-04T12:29:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (12, 'clock_out', '2026-02-15T21:46:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (17, 'clock_in', '2026-03-04T12:13:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (15, 'clock_out', '2026-02-05T22:39:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (18, 'clock_in', '2026-02-26T14:24:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (6, 'clock_out', '2026-02-08T21:52:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (7, 'clock_in', '2026-02-07T13:57:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (20, 'clock_out', '2026-02-13T22:09:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (17, 'clock_in', '2026-02-08T14:10:00.000Z');
INSERT INTO public."time_entries" (staff_member_id, entry_type, entry_time) VALUES (1, 'clock_out', '2026-03-06T21:22:00.000Z');

-- time_off_requests (15 records)
INSERT INTO public."time_off_requests" (staff_member_id, start_date, end_date, reason, status_id) VALUES (13, '2026-07-06', '2026-07-10', 'Religious observance', 9);
INSERT INTO public."time_off_requests" (staff_member_id, start_date, end_date, reason, status_id, responded_by, responded_at) VALUES (8, '2026-07-17', '2026-07-19', 'Family event', 10, '88f876a4-71ab-487c-8342-52c6eb31b072', '2026-03-06T07:29:29.918Z');
INSERT INTO public."time_off_requests" (staff_member_id, start_date, end_date, reason, status_id) VALUES (18, '2026-07-14', '2026-07-15', 'Vacation', 9);
INSERT INTO public."time_off_requests" (staff_member_id, start_date, end_date, reason, status_id) VALUES (1, '2026-08-03', '2026-08-04', 'Moving day', 9);
INSERT INTO public."time_off_requests" (staff_member_id, start_date, end_date, reason, status_id) VALUES (1, '2026-07-22', '2026-07-23', 'Childcare', 9);
INSERT INTO public."time_off_requests" (staff_member_id, start_date, end_date, reason, status_id) VALUES (11, '2026-07-05', '2026-07-10', 'Vacation', 9);
INSERT INTO public."time_off_requests" (staff_member_id, start_date, end_date, reason, status_id, responded_by, responded_at) VALUES (20, '2026-06-22', '2026-06-24', 'Vacation', 10, '2a33b4ae-f6ac-4669-ad4e-3ae1735c379b', '2026-02-25T00:30:14.876Z');
INSERT INTO public."time_off_requests" (staff_member_id, start_date, end_date, status_id, responded_by, responded_at) VALUES (2, '2026-08-02', '2026-08-04', 10, 'ba921520-e617-4d47-8b86-cc9c47648483', '2026-03-02T18:40:38.962Z');
INSERT INTO public."time_off_requests" (staff_member_id, start_date, end_date, reason, status_id) VALUES (14, '2026-06-22', '2026-06-24', 'Medical appointment', 9);
INSERT INTO public."time_off_requests" (staff_member_id, start_date, end_date, reason, status_id) VALUES (4, '2026-06-19', '2026-06-20', 'Religious observance', 9);
INSERT INTO public."time_off_requests" (staff_member_id, start_date, end_date, reason, status_id, responded_by, responded_at) VALUES (20, '2026-07-30', '2026-08-04', 'Personal day', 10, '2378d492-4e3f-41cb-9cab-94340c445858', '2026-02-23T10:49:07.926Z');
INSERT INTO public."time_off_requests" (staff_member_id, start_date, end_date, reason, status_id) VALUES (9, '2026-07-03', '2026-07-08', 'Personal day', 9);
INSERT INTO public."time_off_requests" (staff_member_id, start_date, end_date, reason, status_id, responded_by, responded_at) VALUES (20, '2026-07-23', '2026-07-28', 'Personal day', 10, '801fd579-d6f1-4974-9a72-c452bd146f42', '2026-02-25T08:21:21.360Z');
INSERT INTO public."time_off_requests" (staff_member_id, start_date, end_date, status_id) VALUES (2, '2026-07-04', '2026-07-06', 9);
INSERT INTO public."time_off_requests" (staff_member_id, start_date, end_date, reason, status_id) VALUES (18, '2026-07-27', '2026-07-31', 'Childcare', 9);

-- incident_reports (8 records)
INSERT INTO public."incident_reports" (reported_by_id, site_id, incident_date, incident_time, description, people_involved, action_taken, follow_up_needed) VALUES (16, 2, '2026-08-04', '16:14:00', 'Student fell on playground during recess. Scraped knee, first aid administered.', 'Two staff members', 'Held mediation session, documented agreements, followed up next day', FALSE);
INSERT INTO public."incident_reports" (reported_by_id, site_id, incident_date, incident_time, description, people_involved, action_taken, follow_up_needed, follow_up_notes) VALUES (4, 3, '2026-06-19', '12:07:00', 'Verbal altercation between two students during afternoon session. Separated and counseled.', 'Three students from Group B', 'Followed emergency protocol, contacted parents for early pickup', TRUE, 'Scheduled follow-up meeting with parents for next week');
INSERT INTO public."incident_reports" (reported_by_id, site_id, incident_date, incident_time, description, people_involved, action_taken, follow_up_needed, follow_up_notes) VALUES (16, 2, '2026-07-13', '13:32:00', 'Minor allergic reaction during snack time. EpiPen not needed, parent contacted.', 'All students present at site', 'Students separated, individual conversations held, parents notified at pickup', TRUE, 'Maintenance repair scheduled for Friday');
INSERT INTO public."incident_reports" (reported_by_id, site_id, incident_date, incident_time, description, people_involved, action_taken, follow_up_needed) VALUES (14, 2, '2026-07-26', '14:26:00', 'Unauthorized visitor attempted to enter building. Staff followed lockout procedure.', 'One student, age 10', 'Followed emergency protocol, contacted parents for early pickup', FALSE);
INSERT INTO public."incident_reports" (reported_by_id, site_id, incident_date, incident_time, description, people_involved, action_taken, follow_up_needed) VALUES (16, 2, '2026-07-11', '12:11:00', 'Water leak from ceiling in classroom B. Area cordoned off, maintenance contacted.', 'All students present at site', 'Held mediation session, documented agreements, followed up next day', FALSE);
INSERT INTO public."incident_reports" (reported_by_id, site_id, incident_date, incident_time, description, people_involved, action_taken, follow_up_needed, follow_up_notes) VALUES (1, 2, '2026-07-06', '15:03:00', 'Student left program area without permission. Located within 5 minutes in parking lot.', 'Staff member and parent', 'Followed emergency protocol, contacted parents for early pickup', TRUE, 'CPS case number assigned, awaiting response');
INSERT INTO public."incident_reports" (reported_by_id, site_id, incident_date, incident_time, description, people_involved, action_taken, follow_up_needed) VALUES (9, 2, '2026-07-09', '8:07:00', 'Conflict between staff members regarding schedule changes. Mediated by site coordinator.', 'Maintenance staff and site coordinator', 'Evacuated area, placed work order, relocated class to available room', FALSE);
INSERT INTO public."incident_reports" (reported_by_id, site_id, incident_date, incident_time, description, people_involved, action_taken, follow_up_needed, follow_up_notes) VALUES (1, 2, '2026-07-02', '8:50:00', 'Power outage during afternoon activities. Backup procedures followed, early dismissal at 3 PM.', 'Two 8-year-old students from Group A', 'Conducted sweep of facility, reviewed supervision protocols with staff', TRUE, 'Maintenance repair scheduled for Friday');

-- reimbursements (10 records)
INSERT INTO public."reimbursements" (staff_member_id, amount, description, status_id, responded_by, responded_at) VALUES (8, 16.26, 'Art supplies for afternoon activity', 13, '95cc4358-06b0-405a-acd6-d26584867e7c', '2026-02-22T06:58:35.442Z');
INSERT INTO public."reimbursements" (staff_member_id, amount, description, status_id, responded_by, responded_at) VALUES (2, 72.54, 'Snacks for 25 students', 13, '95cc4358-06b0-405a-acd6-d26584867e7c', '2026-02-23T20:00:10.298Z');
INSERT INTO public."reimbursements" (staff_member_id, amount, description, status_id, responded_by, responded_at) VALUES (10, 38.44, 'First aid kit refill', 13, '5fd1d267-32fc-4db8-966e-0cae62b72cf6', '2026-03-05T16:32:54.032Z');
INSERT INTO public."reimbursements" (staff_member_id, amount, description, status_id) VALUES (8, 61.53, 'Books for reading circle', 12);
INSERT INTO public."reimbursements" (staff_member_id, amount, description, status_id) VALUES (14, 12.52, 'Science experiment materials', 12);
INSERT INTO public."reimbursements" (staff_member_id, amount, description, status_id, responded_by, responded_at) VALUES (17, 50.69, 'Printer paper and toner', 13, '0a4e4db5-2e7b-4089-afbf-bbcdda37bf0d', '2026-03-06T15:08:48.590Z');
INSERT INTO public."reimbursements" (staff_member_id, amount, description, status_id, responded_by, responded_at) VALUES (8, 35.79, 'Cleaning supplies', 13, '2a33b4ae-f6ac-4669-ad4e-3ae1735c379b', '2026-02-26T15:14:48.354Z');
INSERT INTO public."reimbursements" (staff_member_id, amount, description, status_id, response_notes, responded_by, responded_at) VALUES (18, 31.64, 'Field trip transportation (personal vehicle)', 14, 'Amount exceeds per-item budget. Please submit for partial reimbursement.', '5fd1d267-32fc-4db8-966e-0cae62b72cf6', '2026-03-06T00:09:56.413Z');
INSERT INTO public."reimbursements" (staff_member_id, amount, description, status_id) VALUES (4, 71.68, 'Sports equipment replacement', 12);
INSERT INTO public."reimbursements" (staff_member_id, amount, description, status_id, responded_by, responded_at) VALUES (2, 31.22, 'Classroom decoration materials', 13, '5fd1d267-32fc-4db8-966e-0cae62b72cf6', '2026-02-26T19:06:22.698Z');

-- staff_tasks (25 records)
INSERT INTO public."staff_tasks" (display_name, description, assigned_to_id, site_id, due_date, status_id) VALUES ('Complete fire safety training', 'Watch the 30-minute fire safety video and pass the quiz with 80% or higher.', 12, 2, '2026-08-25', 15);
INSERT INTO public."staff_tasks" (display_name, description, assigned_to_id, site_id, due_date, status_id) VALUES ('Submit lesson plan for Week 3', 'Lesson plan should include reading, math enrichment, and outdoor activity blocks.', 12, 2, '2026-07-23', 15);
INSERT INTO public."staff_tasks" (display_name, description, assigned_to_id, site_id, status_id) VALUES ('Inventory classroom supplies', 'Count and record all art supplies, books, and learning materials. Report shortages.', 11, 1, 15);
INSERT INTO public."staff_tasks" (display_name, description, assigned_to_id, site_id, due_date, status_id) VALUES ('Set up parent communication folder', 'Create weekly update template and distribution list for your classroom parents.', 2, 2, '2026-08-28', 16);
INSERT INTO public."staff_tasks" (display_name, description, assigned_to_id, site_id, status_id) VALUES ('Attend CPR certification session', 'Saturday 9 AM at the main site. Bring comfortable clothes and closed-toe shoes.', 7, 3, 18);
INSERT INTO public."staff_tasks" (display_name, description, assigned_to_id, site_id, due_date, status_id, completion_notes, completed_at) VALUES ('Review student allergy list', 'Familiarize yourself with all student allergies and emergency procedures for your group.', 6, 2, '2026-07-21', 17, 'Completed on time.', '2026-02-16T04:35:07.502Z');
INSERT INTO public."staff_tasks" (display_name, description, assigned_to_id, site_id, due_date, status_id) VALUES ('Prepare field trip permission slips', 'Print, organize, and distribute permission slips for the upcoming museum visit.', 4, 3, '2026-08-20', 16);
INSERT INTO public."staff_tasks" (display_name, description, assigned_to_id, site_id, due_date, status_id, completion_notes, completed_at) VALUES ('Clean and organize storage room', 'Sort donations, discard damaged items, and label all storage bins.', 6, 2, '2026-07-23', 17, 'All items checked and verified.', '2026-02-16T18:49:08.877Z');
INSERT INTO public."staff_tasks" (display_name, description, assigned_to_id, site_id, due_date, status_id, completion_notes, completed_at) VALUES ('Update attendance records', 'Reconcile paper sign-in sheets with digital records for the past two weeks.', 9, 2, '2026-08-19', 17, 'All items checked and verified.', '2026-02-25T10:08:50.302Z');
INSERT INTO public."staff_tasks" (display_name, description, assigned_to_id, site_id, due_date, status_id, completion_notes, completed_at) VALUES ('Coordinate with lunch volunteers', 'Confirm volunteer schedule for next week and communicate any dietary changes.', 3, 2, '2026-07-29', 17, 'Done. No issues.', '2026-02-20T05:46:52.122Z');
INSERT INTO public."staff_tasks" (display_name, description, assigned_to_id, site_id, due_date, status_id) VALUES ('Post weekly photos to parent portal', 'Select 5-8 activity photos (no faces of non-consented students) and upload with captions.', 2, 2, '2026-07-15', 16);
INSERT INTO public."staff_tasks" (display_name, description, assigned_to_id, site_id, due_date, status_id, completion_notes, completed_at) VALUES ('Complete incident report follow-up', 'Document resolution steps taken for the playground incident from last Thursday.', 8, 2, '2026-08-12', 17, 'Completed on time.', '2026-03-02T10:59:34.178Z');
INSERT INTO public."staff_tasks" (display_name, description, assigned_to_id, site_id, status_id, completion_notes, completed_at) VALUES ('Prep materials for science week', 'Gather supplies for volcano, solar system, and plant growth experiments.', 7, 3, 17, 'All items checked and verified.', '2026-02-19T05:21:45.219Z');
INSERT INTO public."staff_tasks" (display_name, description, assigned_to_id, site_id, due_date, status_id, completion_notes, completed_at) VALUES ('Conduct student reading assessments', 'Administer the standardized reading level assessment to all students in your group.', 17, 1, '2026-07-07', 17, 'All items checked and verified.', '2026-02-25T13:14:51.770Z');
INSERT INTO public."staff_tasks" (display_name, description, assigned_to_id, site_id, status_id, completion_notes, completed_at) VALUES ('Submit mileage reimbursement', 'Log all site-to-site travel for the month and submit with odometer photos.', 9, 2, 17, 'Done. No issues.', '2026-03-04T20:05:22.129Z');
INSERT INTO public."staff_tasks" (display_name, description, assigned_to_id, site_id, due_date, status_id) VALUES ('Complete fire safety training', 'Watch the 30-minute fire safety video and pass the quiz with 80% or higher.', 2, 2, '2026-08-06', 18);
INSERT INTO public."staff_tasks" (display_name, description, assigned_to_id, site_id, due_date, status_id, completion_notes, completed_at) VALUES ('Submit lesson plan for Week 3', 'Lesson plan should include reading, math enrichment, and outdoor activity blocks.', 10, 3, '2026-07-23', 17, 'Finished — submitted to site lead for review.', '2026-02-24T06:23:26.655Z');
INSERT INTO public."staff_tasks" (display_name, description, assigned_to_id, site_id, due_date, status_id, completion_notes, completed_at) VALUES ('Inventory classroom supplies', 'Count and record all art supplies, books, and learning materials. Report shortages.', 8, 2, '2026-08-02', 17, 'Completed on time.', '2026-02-25T05:43:53.305Z');
INSERT INTO public."staff_tasks" (display_name, description, assigned_to_id, site_id, due_date, status_id) VALUES ('Set up parent communication folder', 'Create weekly update template and distribution list for your classroom parents.', 20, 2, '2026-07-14', 16);
INSERT INTO public."staff_tasks" (display_name, description, assigned_to_id, site_id, status_id) VALUES ('Attend CPR certification session', 'Saturday 9 AM at the main site. Bring comfortable clothes and closed-toe shoes.', 5, 1, 18);
INSERT INTO public."staff_tasks" (display_name, description, assigned_to_id, site_id, due_date, status_id) VALUES ('Review student allergy list', 'Familiarize yourself with all student allergies and emergency procedures for your group.', 17, 1, '2026-06-23', 16);
INSERT INTO public."staff_tasks" (display_name, description, assigned_to_id, site_id, due_date, status_id) VALUES ('Prepare field trip permission slips', 'Print, organize, and distribute permission slips for the upcoming museum visit.', 12, 2, '2026-07-11', 15);
INSERT INTO public."staff_tasks" (display_name, description, assigned_to_id, site_id, due_date, status_id, completion_notes, completed_at) VALUES ('Clean and organize storage room', 'Sort donations, discard damaged items, and label all storage bins.', 20, 2, '2026-07-14', 17, 'Done. No issues.', '2026-02-17T17:17:06.173Z');
INSERT INTO public."staff_tasks" (display_name, description, assigned_to_id, site_id, due_date, status_id) VALUES ('Update attendance records', 'Reconcile paper sign-in sheets with digital records for the past two weeks.', 19, 1, '2026-08-15', 15);
INSERT INTO public."staff_tasks" (display_name, description, assigned_to_id, site_id, due_date, status_id) VALUES ('Coordinate with lunch volunteers', 'Confirm volunteer schedule for next week and communicate any dietary changes.', 19, 1, '2026-07-21', 15);

-- offboarding_feedback (5 records)
INSERT INTO public."offboarding_feedback" (staff_member_id, overall_rating, what_went_well, what_could_improve, would_return) VALUES (6, 2, 'Great team atmosphere and supportive leadership. The kids were wonderful.', 'More advance notice for schedule changes would be helpful.', TRUE);
INSERT INTO public."offboarding_feedback" (staff_member_id, overall_rating, what_went_well, what_could_improve, would_return) VALUES (5, 4, 'Excellent training provided. I felt well-prepared for every session.', 'Additional training on conflict resolution with older students.', TRUE);
INSERT INTO public."offboarding_feedback" (staff_member_id, overall_rating, what_went_well, what_could_improve, would_return) VALUES (14, 5, 'The curriculum was engaging and the students responded positively.', 'Better communication between sites about shared resources.', TRUE);
INSERT INTO public."offboarding_feedback" (staff_member_id, overall_rating, what_went_well, what_could_improve, would_return, additional_comments) VALUES (7, 2, 'Strong community connections and meaningful work with families.', 'More structured onboarding process in the first week.', TRUE, 'Thank you for this opportunity. I learned a lot this summer.');
INSERT INTO public."offboarding_feedback" (staff_member_id, overall_rating, what_went_well, what_could_improve, would_return) VALUES (15, 3, 'Good work-life balance and reasonable expectations for summer staff.', 'Higher pay rate to match cost of living in the area.', TRUE);

-- Refresh sequences
SELECT setval('public."staff_members_id_seq"', (SELECT COALESCE(MAX(id), 1) FROM public."staff_members"));
SELECT setval('public."time_entries_id_seq"', (SELECT COALESCE(MAX(id), 1) FROM public."time_entries"));
SELECT setval('public."time_off_requests_id_seq"', (SELECT COALESCE(MAX(id), 1) FROM public."time_off_requests"));
SELECT setval('public."incident_reports_id_seq"', (SELECT COALESCE(MAX(id), 1) FROM public."incident_reports"));
SELECT setval('public."reimbursements_id_seq"', (SELECT COALESCE(MAX(id), 1) FROM public."reimbursements"));
SELECT setval('public."staff_tasks_id_seq"', (SELECT COALESCE(MAX(id), 1) FROM public."staff_tasks"));
SELECT setval('public."offboarding_feedback_id_seq"', (SELECT COALESCE(MAX(id), 1) FROM public."offboarding_feedback"));

-- Note: staff_documents are auto-created by trigger when staff_members are inserted