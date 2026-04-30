-- Neighborhood Engagement Hub - Seed Data

-- Tool categories
INSERT INTO tool_categories (display_name, description, color) VALUES
  ('Lawn Care',     'Mowers, trimmers, edgers',      '#22c55e'),
  ('Tree Trimming', 'Chainsaws, pole saws, loppers',  '#84cc16'),
  ('Snow Removal',  'Snow blowers, shovels, salt',    '#3b82f6');

-- Tool types (belong to categories)
INSERT INTO tool_types (display_name, category_id, description) VALUES
  ('Push Mower',       1, 'Manual push mower for small lawns'),
  ('Riding Mower',     1, 'Sit-on mower for large lawns'),
  ('String Trimmer',   1, 'Weed whacker / line trimmer'),
  ('Chainsaw',         2, '16-inch gas chainsaw'),
  ('Pole Saw',         2, 'Extendable pole pruner'),
  ('Loppers',          2, 'Long-handled pruning shears'),
  ('Snow Blower',      3, 'Two-stage snow blower'),
  ('Snow Shovel',      3, 'Ergonomic snow shovel');

-- Tool instances (individual tools, mix of conditions)
INSERT INTO tool_instances (display_name, tool_type_id, instance_number, status_id) VALUES
  ('Push Mower #1',     1, 1, (SELECT id FROM metadata.statuses WHERE entity_type = 'tool_instances' AND status_key = 'in_service')),
  ('Push Mower #2',     1, 2, (SELECT id FROM metadata.statuses WHERE entity_type = 'tool_instances' AND status_key = 'in_service')),
  ('Riding Mower #1',   2, 1, (SELECT id FROM metadata.statuses WHERE entity_type = 'tool_instances' AND status_key = 'in_service')),
  ('Chainsaw #1',       4, 1, (SELECT id FROM metadata.statuses WHERE entity_type = 'tool_instances' AND status_key = 'in_service')),
  ('Chainsaw #2',       4, 2, (SELECT id FROM metadata.statuses WHERE entity_type = 'tool_instances' AND status_key = 'maintenance')),
  ('Snow Blower #1',    7, 1, (SELECT id FROM metadata.statuses WHERE entity_type = 'tool_instances' AND status_key = 'retired'));

-- Borrowers (mix of approved, pending, rejected)
INSERT INTO borrowers (display_name, email, phone, status_id) VALUES
  ('Alice Johnson',   'alice@example.com',   '5551234567', (SELECT id FROM metadata.statuses WHERE entity_type = 'borrowers' AND status_key = 'approved')),
  ('Bob Smith',       'bob@example.com',     '5552345678', (SELECT id FROM metadata.statuses WHERE entity_type = 'borrowers' AND status_key = 'approved')),
  ('Charlie Brown',   'charlie@example.com', '5553456789', (SELECT id FROM metadata.statuses WHERE entity_type = 'borrowers' AND status_key = 'pending')),
  ('Diana Prince',    'diana@example.com',   '5554567890', (SELECT id FROM metadata.statuses WHERE entity_type = 'borrowers' AND status_key = 'rejected')),
  ('Eve Wilson',      'eve@example.com',     '5555678901', (SELECT id FROM metadata.statuses WHERE entity_type = 'borrowers' AND status_key = 'approved'));

-- Parcels (mix of eligibility and property classes, with polygon boundaries around Flint MI)
INSERT INTO parcels (display_name, parcel_number, prop_num, prop_street, prop_city, prop_zip, acreage, property_class, eligibility, boundary) VALUES
  ('123 Main St',     'P-001', '123',  'Main St',    'FLINT', '48503', 0.2500,
    get_category_id('parcel_property_class', 'residential'),
    get_category_id('parcel_eligibility', 'good'),
    postgis.ST_GeogFromText('SRID=4326;POLYGON((-83.6880 43.0125, -83.6870 43.0125, -83.6870 43.0135, -83.6880 43.0135, -83.6880 43.0125))')),
  ('456 Oak Ave',     'P-002', '456',  'Oak Ave',    'FLINT', '48503', 0.3200,
    get_category_id('parcel_property_class', 'residential'),
    get_category_id('parcel_eligibility', 'good'),
    postgis.ST_GeogFromText('SRID=4326;POLYGON((-83.6870 43.0125, -83.6860 43.0125, -83.6860 43.0135, -83.6870 43.0135, -83.6870 43.0125))')),
  ('789 Elm Blvd',    'P-003', '789',  'Elm Blvd',   'FLINT', '48504', 0.1800,
    get_category_id('parcel_property_class', 'commercial'),
    get_category_id('parcel_eligibility', 'few_issues'),
    postgis.ST_GeogFromText('SRID=4326;POLYGON((-83.6900 43.0140, -83.6890 43.0140, -83.6890 43.0150, -83.6900 43.0150, -83.6900 43.0140))')),
  ('321 Pine Dr',     'P-004', '321',  'Pine Dr',    'FLINT', '48505', 1.5000,
    get_category_id('parcel_property_class', 'industrial'),
    get_category_id('parcel_eligibility', 'ineligible'),
    postgis.ST_GeogFromText('SRID=4326;POLYGON((-83.6920 43.0100, -83.6900 43.0100, -83.6900 43.0120, -83.6920 43.0120, -83.6920 43.0100))')),
  ('654 Maple Ln',    'P-005', '654',  'Maple Ln',   'FLINT', '48503', 0.2100,
    get_category_id('parcel_property_class', 'residential'),
    get_category_id('parcel_eligibility', 'good'),
    postgis.ST_GeogFromText('SRID=4326;POLYGON((-83.6860 43.0135, -83.6850 43.0135, -83.6850 43.0145, -83.6860 43.0145, -83.6860 43.0135))')),
  ('987 Cedar Ct',    'P-006', '987',  'Cedar Ct',   'FLINT', '48504', 5.0000,
    get_category_id('parcel_property_class', 'agricultural'),
    get_category_id('parcel_eligibility', 'few_issues'),
    postgis.ST_GeogFromText('SRID=4326;POLYGON((-83.6950 43.0080, -83.6920 43.0080, -83.6920 43.0100, -83.6950 43.0100, -83.6950 43.0080))'));

-- Projects
INSERT INTO projects (display_name, description) VALUES
  ('Spring Cleanup 2026',  'Annual spring neighborhood cleanup'),
  ('Tree Planting Drive',  'Plant 50 new trees along Main St');

-- Some tool reservations
INSERT INTO tool_reservations (display_name, borrower_id, category_id, tool_type_id, reserved_date, notes) VALUES
  ('Alice - Mower Reservation', 1, 1, 1, '2026-04-20', 'For weekend lawn care'),
  ('Bob - Chainsaw Reservation', 2, 2, 4, '2026-04-22', 'Trim oak tree in backyard');

-- Some project-parcel associations
INSERT INTO project_parcels (project_id, parcel_id) VALUES
  (1, 1),
  (1, 2),
  (2, 5);
