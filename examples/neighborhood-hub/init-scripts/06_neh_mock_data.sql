-- Neighborhood Engagement Hub - Seed Data
BEGIN;

-- ============================================================================
-- CLEAN UP EXISTING DATA
-- ============================================================================
DELETE FROM tool_instances;
DELETE FROM tool_types;
DELETE FROM tool_categories;

-- ============================================================================
-- TOOL CATEGORIES (5)
-- ============================================================================
INSERT INTO tool_categories (display_name, description, color) VALUES
  ('Power Tools',          'Motorized and electric tools',            '#dc2626'),
  ('Hand Tools',           'Manual tools for yard and garden work',   '#22c55e'),
  ('Accessibility Tools',  'Ergonomic and adaptive tools',           '#8b5cf6'),
  ('Snow Removal',         'Snow clearing equipment',                '#3b82f6'),
  ('Mobile Event Kit',     'Equipment for community events',         '#f59e0b');

-- ============================================================================
-- TOOL TYPES (~83 items via DO block for clean ID lookups)
-- ============================================================================
DO $$
DECLARE
  v_power_tools INT;
  v_hand_tools INT;
  v_accessibility INT;
  v_snow INT;
  v_event_kit INT;
  v_tool_shed_module INT;
  v_event_kit_module INT;
BEGIN
  SELECT id INTO v_power_tools FROM tool_categories WHERE display_name = 'Power Tools';
  SELECT id INTO v_hand_tools FROM tool_categories WHERE display_name = 'Hand Tools';
  SELECT id INTO v_accessibility FROM tool_categories WHERE display_name = 'Accessibility Tools';
  SELECT id INTO v_snow FROM tool_categories WHERE display_name = 'Snow Removal';
  SELECT id INTO v_event_kit FROM tool_categories WHERE display_name = 'Mobile Event Kit';
  SELECT id INTO v_tool_shed_module FROM metadata.categories WHERE entity_type = 'inventory_module' AND category_key = 'tool_shed';
  SELECT id INTO v_event_kit_module FROM metadata.categories WHERE entity_type = 'inventory_module' AND category_key = 'event_kit';

  -- Power Tools (23 items, individually tracked)
  INSERT INTO tool_types (display_name, category_id, inventory_module_id, description, is_qty_managed, total_quantity) VALUES
    ('Air Compressor',            v_power_tools, v_tool_shed_module, 'Portable air compressor',                    false, NULL),
    ('Brush Hog',                 v_power_tools, v_tool_shed_module, 'Heavy-duty rotary mower for rough terrain',  false, NULL),
    ('Chainsaw 16"',              v_power_tools, v_tool_shed_module, '16-inch gas chainsaw',                       false, NULL),
    ('Chainsaw 20"',              v_power_tools, v_tool_shed_module, '20-inch gas chainsaw',                       false, NULL),
    ('Circular Saw',              v_power_tools, v_tool_shed_module, 'Electric circular saw',                      false, NULL),
    ('DR Trimmer',                v_power_tools, v_tool_shed_module, 'DR field and brush trimmer',                 false, NULL),
    ('Edger (Gas)',                v_power_tools, v_tool_shed_module, 'Gas-powered lawn edger',                     false, NULL),
    ('Edger (Electric)',           v_power_tools, v_tool_shed_module, 'Electric lawn edger',                        false, NULL),
    ('Generator',                 v_power_tools, v_tool_shed_module, 'Portable gas generator',                     false, NULL),
    ('Hedge Hog Edger',           v_power_tools, v_tool_shed_module, 'Hedge Hog power edger',                      false, NULL),
    ('Leaf Blower (Gas)',          v_power_tools, v_tool_shed_module, 'Gas-powered leaf blower',                    false, NULL),
    ('Leaf Blower (Electric)',     v_power_tools, v_tool_shed_module, 'Electric leaf blower',                       false, NULL),
    ('Mantis Tiller',             v_power_tools, v_tool_shed_module, 'Mantis mini tiller/cultivator',              false, NULL),
    ('Porter Cable Tiger Saw',    v_power_tools, v_tool_shed_module, 'Porter Cable reciprocating saw',             false, NULL),
    ('Power Mate Roto Tiller',    v_power_tools, v_tool_shed_module, 'Power Mate rear-tine roto tiller',           false, NULL),
    ('Push Mower',                v_power_tools, v_tool_shed_module, 'Gas push mower for small lawns',             false, NULL),
    ('Riding Mower',              v_power_tools, v_tool_shed_module, 'Sit-on mower for large lawns',               false, NULL),
    ('Snow Blower',               v_power_tools, v_tool_shed_module, 'Two-stage snow blower',                      false, NULL),
    ('Stihl Power Drill',         v_power_tools, v_tool_shed_module, 'Stihl earth auger power drill',              false, NULL),
    ('Stihl Weed Trimmer',        v_power_tools, v_tool_shed_module, 'Stihl gas weed trimmer',                     false, NULL),
    ('String Trimmer',            v_power_tools, v_tool_shed_module, 'Weed whacker / line trimmer',                false, NULL),
    ('Wet & Dry Vac',             v_power_tools, v_tool_shed_module, 'Wet and dry shop vacuum',                    false, NULL),
    ('Zero Turn Mower',           v_power_tools, v_tool_shed_module, 'Zero-turn radius riding mower',              false, NULL);

  -- Hand Tools (34 items, individually tracked)
  INSERT INTO tool_types (display_name, category_id, inventory_module_id, description, is_qty_managed, total_quantity) VALUES
    ('Ax',                v_hand_tools, v_tool_shed_module, 'Splitting ax',                         false, NULL),
    ('Broadfork',         v_hand_tools, v_tool_shed_module, 'Broadfork for deep soil aeration',     false, NULL),
    ('Compacter',         v_hand_tools, v_tool_shed_module, 'Manual soil compacter',                false, NULL),
    ('Cultivator',        v_hand_tools, v_tool_shed_module, 'Hand cultivator for garden beds',      false, NULL),
    ('Dolly',             v_hand_tools, v_tool_shed_module, 'Hand truck / dolly',                   false, NULL),
    ('Hedge Shears',      v_hand_tools, v_tool_shed_module, 'Manual hedge shears',                  false, NULL),
    ('HEPA Vac',          v_hand_tools, v_tool_shed_module, 'HEPA filter vacuum',                   false, NULL),
    ('Hoe',               v_hand_tools, v_tool_shed_module, 'Garden hoe',                           false, NULL),
    ('Ladder (Step)',      v_hand_tools, v_tool_shed_module, 'Step ladder',                          false, NULL),
    ('Ladder (Extension)', v_hand_tools, v_tool_shed_module, 'Extension ladder',                    false, NULL),
    ('Log Splitter',      v_hand_tools, v_tool_shed_module, 'Manual log splitter',                  false, NULL),
    ('Loppers',           v_hand_tools, v_tool_shed_module, 'Long-handled pruning shears',          false, NULL),
    ('Mallet',            v_hand_tools, v_tool_shed_module, 'Rubber mallet',                        false, NULL),
    ('Pick-Ax',           v_hand_tools, v_tool_shed_module, 'Pick-ax for hard soil',                false, NULL),
    ('Pitchfork',         v_hand_tools, v_tool_shed_module, 'Pitchfork for hay and compost',        false, NULL),
    ('Pole Saw',          v_hand_tools, v_tool_shed_module, 'Extendable pole pruner',               false, NULL),
    ('Post Hole Digger',  v_hand_tools, v_tool_shed_module, 'Manual post hole digger',              false, NULL),
    ('Pruners',           v_hand_tools, v_tool_shed_module, 'Hand pruning shears',                  false, NULL),
    ('Push Broom',        v_hand_tools, v_tool_shed_module, 'Wide push broom',                      false, NULL),
    ('Rake (Leaf)',        v_hand_tools, v_tool_shed_module, 'Leaf rake',                            false, NULL),
    ('Rake (Garden)',      v_hand_tools, v_tool_shed_module, 'Garden rake',                          false, NULL),
    ('Rake (Bow)',         v_hand_tools, v_tool_shed_module, 'Bow rake for grading',                 false, NULL),
    ('Saw (Hand)',         v_hand_tools, v_tool_shed_module, 'Hand saw for branches',                false, NULL),
    ('Scraper',           v_hand_tools, v_tool_shed_module, 'Floor/wall scraper',                   false, NULL),
    ('Shovel (Round)',     v_hand_tools, v_tool_shed_module, 'Round-point digging shovel',           false, NULL),
    ('Shovel (Flat)',      v_hand_tools, v_tool_shed_module, 'Flat-head transfer shovel',            false, NULL),
    ('Shovel (Snow)',      v_hand_tools, v_tool_shed_module, 'Ergonomic snow shovel',                false, NULL),
    ('Sledgehammer',      v_hand_tools, v_tool_shed_module, 'Sledgehammer for demolition',          false, NULL),
    ('Spreader',          v_hand_tools, v_tool_shed_module, 'Broadcast seed/fertilizer spreader',   false, NULL),
    ('Stirrup Hoe',       v_hand_tools, v_tool_shed_module, 'Stirrup hoe for weeding',              false, NULL),
    ('Trowel',            v_hand_tools, v_tool_shed_module, 'Hand trowel for planting',             false, NULL),
    ('Weed Whip',         v_hand_tools, v_tool_shed_module, 'Manual weed whip / scythe',            false, NULL),
    ('Weeder',            v_hand_tools, v_tool_shed_module, 'Stand-up weeder tool',                 false, NULL),
    ('Wheelbarrow',       v_hand_tools, v_tool_shed_module, 'Heavy-duty wheelbarrow',               false, NULL);

  -- Accessibility Tools (11 items, individually tracked)
  INSERT INTO tool_types (display_name, category_id, inventory_module_id, description, is_qty_managed, total_quantity) VALUES
    ('Easy Grip Handle',                    v_accessibility, v_tool_shed_module, 'Ergonomic easy-grip handle attachment',       false, NULL),
    ('Easy Grip Trowel',                    v_accessibility, v_tool_shed_module, 'Trowel with ergonomic easy-grip handle',      false, NULL),
    ('Easy Grip Weeder',                    v_accessibility, v_tool_shed_module, 'Weeder with ergonomic easy-grip handle',      false, NULL),
    ('Extension Cultivator',                v_accessibility, v_tool_shed_module, 'Long-handle extension cultivator',            false, NULL),
    ('Extension Hoe Cultivator',            v_accessibility, v_tool_shed_module, 'Long-handle extension hoe cultivator',        false, NULL),
    ('Extension Rake',                      v_accessibility, v_tool_shed_module, 'Long-handle extension rake',                  false, NULL),
    ('Grandpa Weeder',                      v_accessibility, v_tool_shed_module, 'Stand-up weeder (no bending)',                false, NULL),
    ('Hoe Cultivator',                      v_accessibility, v_tool_shed_module, 'Combined hoe and cultivator',                 false, NULL),
    ('In-Line Robo Handle Ergonomic Grip',  v_accessibility, v_tool_shed_module, 'Ergonomic inline robo handle grip adapter',   false, NULL),
    ('Short Hand Rake',                     v_accessibility, v_tool_shed_module, 'Short-handle hand rake for seated gardening', false, NULL),
    ('Spray Nozzle',                        v_accessibility, v_tool_shed_module, 'Ergonomic spray nozzle with easy trigger',    false, NULL);

  -- Snow Removal (2 items, individually tracked)
  INSERT INTO tool_types (display_name, category_id, inventory_module_id, description, is_qty_managed, total_quantity) VALUES
    ('Ice Scraper',                 v_snow, v_tool_shed_module, 'Long-handle ice scraper for sidewalks',       false, NULL),
    ('Salt Spreader (Walk-Behind)', v_snow, v_tool_shed_module, 'Walk-behind salt/sand spreader for pathways', false, NULL);

  -- Mobile Event Kit (13 items: 11 qty-managed + 2 serial-tracked)
  INSERT INTO tool_types (display_name, category_id, inventory_module_id, description, is_qty_managed, total_quantity) VALUES
    ('Folding Table',                          v_event_kit, v_event_kit_module, '6-foot folding table',                           true, 16),
    ('Folding Chair',                          v_event_kit, v_event_kit_module, 'Padded folding chair',                           true, 75),
    ('Tent 10x10',                             v_event_kit, v_event_kit_module, '10x10 pop-up canopy tent',                       true,  6),
    ('Tent 10x20',                             v_event_kit, v_event_kit_module, '10x20 pop-up canopy tent',                       true,  4),
    ('Portable Generator',                     v_event_kit, v_event_kit_module, 'Portable event generator',                       true,  2),
    ('Sandwich Board Sign',                    v_event_kit, v_event_kit_module, 'A-frame sandwich board sign',                    true,  2),
    ('Giant Connect-Four',                     v_event_kit, v_event_kit_module, 'Giant Connect-Four yard game',                   true,  1),
    ('Corn-Hole Games',                        v_event_kit, v_event_kit_module, 'Corn-hole toss game set',                        true,  1),
    ('Bucket Ball Game',                       v_event_kit, v_event_kit_module, 'Bucket Ball outdoor game set',                   true,  1),
    ('Spike Ball Game',                        v_event_kit, v_event_kit_module, 'Spike Ball game set',                            true,  1),
    ('Ring Toss Game',                         v_event_kit, v_event_kit_module, 'Ring toss game set',                             true,  1),
    ('Popcorn Cart',                           v_event_kit, v_event_kit_module, 'Wheeled popcorn cart with kettle',               false, NULL),
    ('Portable Sound System w/ Microphone',    v_event_kit, v_event_kit_module, 'Portable PA system with wireless microphone',    false, NULL);

END $$;

-- ============================================================================
-- TOOL INSTANCES (9 serial-tracked items, mix of statuses)
-- ============================================================================
INSERT INTO tool_instances (display_name, tool_type_id, instance_number, status_id) VALUES
  ('Push Mower #1',
   (SELECT id FROM tool_types WHERE display_name = 'Push Mower'),
   1,
   (SELECT id FROM metadata.statuses WHERE entity_type = 'tool_instances' AND status_key = 'in_service')),

  ('Push Mower #2',
   (SELECT id FROM tool_types WHERE display_name = 'Push Mower'),
   2,
   (SELECT id FROM metadata.statuses WHERE entity_type = 'tool_instances' AND status_key = 'in_service')),

  ('Riding Mower #1',
   (SELECT id FROM tool_types WHERE display_name = 'Riding Mower'),
   1,
   (SELECT id FROM metadata.statuses WHERE entity_type = 'tool_instances' AND status_key = 'in_service')),

  ('Chainsaw 16" #1',
   (SELECT id FROM tool_types WHERE display_name = 'Chainsaw 16"'),
   1,
   (SELECT id FROM metadata.statuses WHERE entity_type = 'tool_instances' AND status_key = 'in_service')),

  ('Chainsaw 16" #2',
   (SELECT id FROM tool_types WHERE display_name = 'Chainsaw 16"'),
   2,
   (SELECT id FROM metadata.statuses WHERE entity_type = 'tool_instances' AND status_key = 'maintenance')),

  ('Zero Turn Mower #1',
   (SELECT id FROM tool_types WHERE display_name = 'Zero Turn Mower'),
   1,
   (SELECT id FROM metadata.statuses WHERE entity_type = 'tool_instances' AND status_key = 'in_service')),

  ('Snow Blower #1',
   (SELECT id FROM tool_types WHERE display_name = 'Snow Blower'),
   1,
   (SELECT id FROM metadata.statuses WHERE entity_type = 'tool_instances' AND status_key = 'retired')),

  ('Popcorn Cart #1',
   (SELECT id FROM tool_types WHERE display_name = 'Popcorn Cart'),
   1,
   (SELECT id FROM metadata.statuses WHERE entity_type = 'tool_instances' AND status_key = 'in_service')),

  ('Sound System #1',
   (SELECT id FROM tool_types WHERE display_name = 'Portable Sound System w/ Microphone'),
   1,
   (SELECT id FROM metadata.statuses WHERE entity_type = 'tool_instances' AND status_key = 'in_service'));

-- ============================================================================
-- PARCELS (6 existing records)
-- ============================================================================
INSERT INTO parcels (display_name, parcel_number, prop_num, prop_street, prop_city, prop_zip, acreage, property_class, eligibility, boundary) VALUES
  ('123 Main St',     '254014377001', '123',  'Main St',    'FLINT', '48503', 0.2500,
    get_category_id('parcel_property_class', 'residential'),
    get_category_id('parcel_eligibility', 'good'),
    postgis.ST_GeogFromText('SRID=4326;POLYGON((-83.6880 43.0125, -83.6870 43.0125, -83.6870 43.0135, -83.6880 43.0135, -83.6880 43.0125))')),
  ('456 Oak Ave',     '254014377002', '456',  'Oak Ave',    'FLINT', '48503', 0.3200,
    get_category_id('parcel_property_class', 'residential'),
    get_category_id('parcel_eligibility', 'good'),
    postgis.ST_GeogFromText('SRID=4326;POLYGON((-83.6870 43.0125, -83.6860 43.0125, -83.6860 43.0135, -83.6870 43.0135, -83.6870 43.0125))')),
  ('789 Elm Blvd',    '254014377003', '789',  'Elm Blvd',   'FLINT', '48504', 0.1800,
    get_category_id('parcel_property_class', 'commercial'),
    get_category_id('parcel_eligibility', 'few_issues'),
    postgis.ST_GeogFromText('SRID=4326;POLYGON((-83.6900 43.0140, -83.6890 43.0140, -83.6890 43.0150, -83.6900 43.0150, -83.6900 43.0140))')),
  ('321 Pine Dr',     '254014377004', '321',  'Pine Dr',    'FLINT', '48505', 1.5000,
    get_category_id('parcel_property_class', 'industrial'),
    get_category_id('parcel_eligibility', 'ineligible'),
    postgis.ST_GeogFromText('SRID=4326;POLYGON((-83.6920 43.0100, -83.6900 43.0100, -83.6900 43.0120, -83.6920 43.0120, -83.6920 43.0100))')),
  ('654 Maple Ln',    '254014377005', '654',  'Maple Ln',   'FLINT', '48503', 0.2100,
    get_category_id('parcel_property_class', 'residential'),
    get_category_id('parcel_eligibility', 'good'),
    postgis.ST_GeogFromText('SRID=4326;POLYGON((-83.6860 43.0135, -83.6850 43.0135, -83.6850 43.0145, -83.6860 43.0145, -83.6860 43.0135))')),
  ('987 Cedar Ct',    '254014377006', '987',  'Cedar Ct',   'FLINT', '48504', 5.0000,
    get_category_id('parcel_property_class', 'agricultural'),
    get_category_id('parcel_eligibility', 'few_issues'),
    postgis.ST_GeogFromText('SRID=4326;POLYGON((-83.6950 43.0080, -83.6920 43.0080, -83.6920 43.0100, -83.6950 43.0100, -83.6950 43.0080))'));

-- ============================================================================
-- PROJECTS (2 existing records)
-- ============================================================================
INSERT INTO projects (display_name, description) VALUES
  ('Spring Cleanup 2026',  'Annual spring neighborhood cleanup'),
  ('Tree Planting Drive',  'Plant 50 new trees along Main St');

-- Project-parcel associations (use subqueries since IDs are auto-generated)
INSERT INTO project_parcels (project_id, parcel_id) VALUES
  ((SELECT id FROM projects WHERE display_name = 'Spring Cleanup 2026'),
   (SELECT id FROM parcels WHERE parcel_number = '254014377001')),
  ((SELECT id FROM projects WHERE display_name = 'Spring Cleanup 2026'),
   (SELECT id FROM parcels WHERE parcel_number = '254014377002')),
  ((SELECT id FROM projects WHERE display_name = 'Tree Planting Drive'),
   (SELECT id FROM parcels WHERE parcel_number = '254014377005'));

-- ============================================================================
-- TRAINING & BORROWER DATA
-- ============================================================================

-- Training records require borrower_id references
-- Mock data will be created after borrower sync triggers fire

-- Borrowers need a user_id from civic_os_users, but those are created by Keycloak sync
-- For mock data, we skip borrowers since they require valid user_id references

-- ============================================================================
-- MEK REQUESTS
-- ============================================================================

-- MEK request mock data is handled in 11_neh_mek_workflow.sql

COMMIT;
