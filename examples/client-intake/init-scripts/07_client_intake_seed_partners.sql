-- ============================================================================
-- Client Intake & Referral - Partner Directory Seed Data
-- ============================================================================
-- Source: ICGF partner list at icgflint.org/services, filtered to actual
-- service agencies. Contact info researched from each organization's website.
-- Fields left NULL where not publicly verified — ICGF staff should complete
-- these via the UI after launch.
--
-- NOTE: Locations (GeoPoint) are omitted — geocode from addresses post-seed.
-- NOTE: Run AFTER 01_schema, 02_permissions, 03_metadata, 06_actions.
-- ============================================================================

BEGIN;


-- ============================================================================
-- PARTNER RECORDS
-- ============================================================================

INSERT INTO partners (
  display_name, partner_type_id, contact_name, email, phone,
  address, website, languages_supported,
  capacity_notes, description, active
) VALUES

  -- 1. Legal Services of Eastern Michigan
  (
    'Legal Services of Eastern Michigan',
    (SELECT id FROM metadata.categories WHERE entity_type = 'partner_type' AND category_key = 'organization'),
    NULL,
    NULL,
    '8102342621',
    '436 S. Saginaw St., Suite 101, Flint, MI 48502',
    'https://lsem-mi.org',
    'English',
    'Walk-ins Mon-Thu 9:30am-3:30pm, Fri virtual only; phone intake Mon-Fri 9am-5pm; free, income-eligibility screening required. Eligibility/intake line: 8003224512.',
    'Nonprofit providing free civil legal representation to low-income residents and seniors across Genesee and neighboring counties.',
    TRUE
  ),

  -- 2. Mott Community College
  (
    'Mott Community College',
    (SELECT id FROM metadata.categories WHERE entity_type = 'partner_type' AND category_key = 'organization'),
    NULL,
    NULL,
    '8107620200',
    '1401 E. Court St., Flint, MI 48503',
    'https://www.mcc.edu',
    'English',
    'Admin hours Mon-Fri 8am-5pm; Workforce Education Center at 709 N. Saginaw St. (8102322555).',
    'Public community college offering associate degrees, certificates, adult education, and workforce training.',
    TRUE
  ),

  -- 3. GST Michigan Works! - Flint Service Center
  (
    'GST Michigan Works! - Flint Service Center',
    (SELECT id FROM metadata.categories WHERE entity_type = 'partner_type' AND category_key = 'organization'),
    NULL,
    NULL,
    '8102335974',
    '711 N. Saginaw St., Lower Level, Flint, MI 48503',
    'https://gstmiworks.org',
    'English',
    'Appointment scheduling available; job-seeker and employer services; administrative office in Suite 300.',
    'Regional workforce development agency providing job placement, training, and employer services in Genesee County.',
    TRUE
  ),

  -- 4. Mass Transportation Authority
  (
    'Mass Transportation Authority',
    (SELECT id FROM metadata.categories WHERE entity_type = 'partner_type' AND category_key = 'organization'),
    NULL,
    NULL,
    '8107670100',
    '1401 S. Dort Hwy., Flint, MI 48503',
    'https://www.mtaflint.org',
    'English',
    'Office Mon-Fri 8am-5pm; fixed routes plus ''Your Ride'' paratransit; service roughly 6:30am-11:30pm weekdays. Downtown hub at 615 Harrison St.',
    'Public transit operator for Flint and Genesee County; fixed-route bus, paratransit, and specialized senior/disability rides.',
    TRUE
  ),

  -- 5. American Red Cross of Genesee County
  (
    'American Red Cross of Genesee County',
    (SELECT id FROM metadata.categories WHERE entity_type = 'partner_type' AND category_key = 'organization'),
    NULL,
    NULL,
    '8102321401',
    '1401 S. Grand Traverse St., Flint, MI 48503',
    'https://www.redcross.org/local/michigan',
    'English',
    'Historic office hours Mon-Fri 8:30am-4:30pm; 24/7 disaster response via national line 8007332767.',
    'Disaster relief, emergency assistance, health and safety training, and blood services.',
    TRUE
  ),

  -- 6. Arab American Heritage Council
  (
    'Arab American Heritage Council',
    (SELECT id FROM metadata.categories WHERE entity_type = 'partner_type' AND category_key = 'organization'),
    NULL,
    'staff@aahcflint.org',
    '8102352722',
    '416 N. Saginaw St., Suite 220, Flint, MI 48502',
    'https://aahcflint.org',
    'Arabic, English',
    'Mon-Fri 9am-5pm; immigration application help, citizenship tutoring, translation/interpretation, English conversation hours; free; open to all nationalities.',
    'Nonprofit serving Arab Americans and the broader Flint community with immigration, language, and cultural services.',
    TRUE
  ),

  -- 7. Sylvester Broome Empowerment Village
  (
    'Sylvester Broome Empowerment Village',
    (SELECT id FROM metadata.categories WHERE entity_type = 'partner_type' AND category_key = 'organization'),
    'Maryum Rasool',
    'info@sbev.org',
    '8108936098',
    '4119 N. Saginaw St., Flint, MI 48505',
    'https://www.sbev.org',
    'English',
    'Youth-focused (ages 5-17); 20+ afterschool and summer programs, on-site Village Market, and ''Water Box'' clean-water access; north Flint community hub.',
    'Community hub offering youth academic, arts, athletic, and enrichment programming, plus food and clean-water access.',
    TRUE
  ),

  -- 8. Gloria Coles Flint Public Library
  (
    'Gloria Coles Flint Public Library',
    (SELECT id FROM metadata.categories WHERE entity_type = 'partner_type' AND category_key = 'organization'),
    NULL,
    NULL,
    '8102327111',
    '1026 E. Kearsley St., Flint, MI 48503',
    'https://www.fpl.info',
    'English',
    'Tue-Thu 11am-8pm, Fri-Sat 9am-6pm, closed Sun/Mon; free gigabit internet, computers, study/community rooms, public programs.',
    'Public library offering books and media, technology and internet access, meeting space, and community programming.',
    TRUE
  ),

  -- 9. Michigan Small Business Development Center (MI-SBDC)
  (
    'Michigan Small Business Development Center (MI-SBDC), I-69 Trade Corridor Region',
    (SELECT id FROM metadata.categories WHERE entity_type = 'partner_type' AND category_key = 'organization'),
    'Janis Mueller',
    'jmueller1@kettering.edu',
    '8107629660',
    'Kettering University, 1700 University Ave., Campus Center, 5th Floor, Flint, MI 48504',
    'https://michigansbdc.org/i-69-trade-corridor-region/',
    'English',
    'Mon-Fri 8am-5pm; no-cost business consulting, training, and market research; serves Genesee plus Huron, Lapeer, Sanilac, Shiawassee, St. Clair, and Tuscola counties.',
    'Provides no-cost consulting, training, and research to help residents launch and grow small businesses.',
    TRUE
  ),

  -- 10. Genesee Intermediate School District
  (
    'Genesee Intermediate School District',
    (SELECT id FROM metadata.categories WHERE entity_type = 'partner_type' AND category_key = 'organization'),
    NULL,
    NULL,
    '8105914400',
    '2413 W. Maple Ave., Flint, MI 48507',
    'https://www.geneseeisd.org',
    'English',
    'Regional educational service agency; special education, early childhood/Great Start, and career-technical training via the Genesee Career Institute.',
    'Regional service agency supporting 21 local districts with special education, early childhood, and career-technical programs.',
    TRUE
  )

ON CONFLICT DO NOTHING;


-- ============================================================================
-- PARTNER ↔ SERVICE CATEGORY TAGS
-- ============================================================================
-- Tags drive the needs-based partner filtering on the referral form:
-- get_partners_for_client_needs() matches client needs → partner services.

INSERT INTO partner_service_categories (partner_id, service_category_id)
SELECT p.id, sc.id
FROM partners p, service_categories sc
WHERE (p.display_name, sc.display_name) IN (
  -- Legal Services of Eastern Michigan
  ('Legal Services of Eastern Michigan',           'Legal Aid / Immigration Legal'),

  -- Mott Community College
  ('Mott Community College',                       'Education (non-ESL)'),
  ('Mott Community College',                       'Employment / Job Placement'),

  -- GST Michigan Works!
  ('GST Michigan Works! - Flint Service Center',   'Employment / Job Placement'),

  -- Mass Transportation Authority
  ('Mass Transportation Authority',                'Transportation'),

  -- American Red Cross of Genesee County
  ('American Red Cross of Genesee County',         'Healthcare / Medical'),
  ('American Red Cross of Genesee County',         'Housing Assistance'),

  -- Arab American Heritage Council
  ('Arab American Heritage Council',               'ESL / English Classes'),
  ('Arab American Heritage Council',               'Legal Aid / Immigration Legal'),
  ('Arab American Heritage Council',               'Translation / Interpretation'),

  -- Sylvester Broome Empowerment Village
  ('Sylvester Broome Empowerment Village',         'Education (non-ESL)'),
  ('Sylvester Broome Empowerment Village',         'Food / Nutrition'),

  -- Gloria Coles Flint Public Library
  ('Gloria Coles Flint Public Library',            'Education (non-ESL)'),

  -- MI-SBDC
  ('Michigan Small Business Development Center (MI-SBDC), I-69 Trade Corridor Region', 'Financial Literacy / Benefits'),
  ('Michigan Small Business Development Center (MI-SBDC), I-69 Trade Corridor Region', 'Education (non-ESL)'),

  -- Genesee ISD
  ('Genesee Intermediate School District',         'Education (non-ESL)'),
  ('Genesee Intermediate School District',         'Childcare'),
  ('Genesee Intermediate School District',         'Employment / Job Placement')
)
ON CONFLICT DO NOTHING;


-- Notify PostgREST to reload schema cache
NOTIFY pgrst, 'reload schema';

COMMIT;
