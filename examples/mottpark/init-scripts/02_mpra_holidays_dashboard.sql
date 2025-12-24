-- ============================================================================
-- MOTT PARK RECREATION AREA - SUPPLEMENTAL SCHEMA
-- Part 2: Evergreen Holiday Rules & Dashboard Configuration
-- ============================================================================
-- This file supplements the main schema with:
-- 1. Evergreen holiday rules (algorithmic, never needs updating)
-- 2. Dashboard configuration for the public-facing home page
-- ============================================================================

-- Wrap in transaction for atomic execution
BEGIN;

-- ============================================================================
-- SECTION 1: EVERGREEN HOLIDAY RULES SYSTEM
-- Replaces the static holiday_dates table with computed rules
-- ============================================================================

-- Drop the static holiday_dates table if it exists
DROP TABLE IF EXISTS holiday_dates CASCADE;

-- Create holiday rules table (defines HOW to calculate holidays)
CREATE TABLE holiday_rules (
  id SERIAL PRIMARY KEY,
  display_name VARCHAR(100) NOT NULL,           -- e.g., "Thanksgiving"
  description TEXT,                              -- e.g., "Fourth Thursday of November"
  
  -- Rule type determines calculation method
  rule_type VARCHAR(20) NOT NULL CHECK (rule_type IN (
    'fixed',           -- Same date every year (e.g., July 4th, Christmas)
    'nth_weekday',     -- Nth weekday of month (e.g., 4th Thursday of November)
    'last_weekday',    -- Last weekday of month (e.g., Last Monday of May)
    'relative',        -- Relative to another holiday (e.g., day after Thanksgiving)
    'weekend'          -- All Saturdays and Sundays (special system rule)
  )),
  
  -- Parameters for rule calculation (interpretation depends on rule_type)
  month INT CHECK (month BETWEEN 1 AND 12),     -- 1=January, 12=December
  day INT CHECK (day BETWEEN 1 AND 31),         -- Day of month (for 'fixed' type)
  weekday INT CHECK (weekday BETWEEN 0 AND 6),  -- 0=Sunday, 6=Saturday (for nth_weekday/last_weekday)
  nth INT CHECK (nth BETWEEN 1 AND 5),          -- Which occurrence (for nth_weekday)
  relative_to_rule_id INT REFERENCES holiday_rules(id), -- Parent rule (for 'relative' type)
  relative_days INT,                             -- Days offset (for 'relative' type)
  
  -- Admin controls
  is_active BOOLEAN NOT NULL DEFAULT TRUE,      -- Enable/disable without deleting
  sort_order INT NOT NULL DEFAULT 0,
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE holiday_rules IS
  'Evergreen holiday calculation rules. Defines HOW holidays are computed rather than
   storing specific dates. Rules are evaluated by get_holidays_for_year() function.
   Weekend rule is a special system type that returns all Saturdays and Sundays.';

-- Index for efficient lookups
CREATE INDEX idx_holiday_rules_active ON holiday_rules(is_active) WHERE is_active = TRUE;

-- ============================================================================
-- HOLIDAY CALCULATION FUNCTIONS
-- ============================================================================

-- Get the Nth occurrence of a weekday in a given month/year
-- Example: get_nth_weekday_of_month(2025, 11, 4, 4) = 4th Thursday of November 2025
CREATE OR REPLACE FUNCTION get_nth_weekday_of_month(
  p_year INT,
  p_month INT,
  p_weekday INT,    -- 0=Sunday, 6=Saturday
  p_nth INT         -- 1=first, 2=second, etc.
) RETURNS DATE AS $$
DECLARE
  first_of_month DATE;
  first_weekday INT;
  days_to_add INT;
  result_date DATE;
BEGIN
  first_of_month := make_date(p_year, p_month, 1);
  first_weekday := EXTRACT(DOW FROM first_of_month)::INT;
  
  -- Calculate days to first occurrence of target weekday
  days_to_add := (p_weekday - first_weekday + 7) % 7;
  
  -- Add weeks for nth occurrence
  days_to_add := days_to_add + (p_nth - 1) * 7;
  
  result_date := first_of_month + days_to_add;
  
  -- Verify result is still in the same month
  IF EXTRACT(MONTH FROM result_date) != p_month THEN
    RETURN NULL;  -- Invalid (e.g., 5th Monday doesn't exist in this month)
  END IF;
  
  RETURN result_date;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Get the last occurrence of a weekday in a given month/year
-- Example: get_last_weekday_of_month(2025, 5, 1) = Last Monday of May 2025
CREATE OR REPLACE FUNCTION get_last_weekday_of_month(
  p_year INT,
  p_month INT,
  p_weekday INT     -- 0=Sunday, 6=Saturday
) RETURNS DATE AS $$
DECLARE
  last_of_month DATE;
  last_weekday INT;
  days_to_subtract INT;
BEGIN
  -- Get last day of month
  last_of_month := (make_date(p_year, p_month, 1) + INTERVAL '1 month' - INTERVAL '1 day')::DATE;
  last_weekday := EXTRACT(DOW FROM last_of_month)::INT;
  
  -- Calculate days to subtract to get to target weekday
  days_to_subtract := (last_weekday - p_weekday + 7) % 7;
  
  RETURN last_of_month - days_to_subtract;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Calculate the actual date for a holiday rule in a given year
CREATE OR REPLACE FUNCTION calculate_holiday_date(
  p_rule holiday_rules,
  p_year INT
) RETURNS DATE AS $$
DECLARE
  parent_date DATE;
BEGIN
  CASE p_rule.rule_type
    WHEN 'fixed' THEN
      -- Fixed date (e.g., July 4th)
      RETURN make_date(p_year, p_rule.month, p_rule.day);
      
    WHEN 'nth_weekday' THEN
      -- Nth weekday of month (e.g., 4th Thursday of November)
      RETURN get_nth_weekday_of_month(p_year, p_rule.month, p_rule.weekday, p_rule.nth);
      
    WHEN 'last_weekday' THEN
      -- Last weekday of month (e.g., Last Monday of May)
      RETURN get_last_weekday_of_month(p_year, p_rule.month, p_rule.weekday);
      
    WHEN 'relative' THEN
      -- Relative to another holiday (e.g., day after Thanksgiving)
      SELECT calculate_holiday_date(r.*, p_year)
      INTO parent_date
      FROM holiday_rules r
      WHERE r.id = p_rule.relative_to_rule_id;
      
      IF parent_date IS NOT NULL THEN
        RETURN parent_date + p_rule.relative_days;
      END IF;
      RETURN NULL;
      
    WHEN 'weekend' THEN
      -- Special case: handled by is_holiday_or_weekend function
      RETURN NULL;
      
    ELSE
      RETURN NULL;
  END CASE;
END;
$$ LANGUAGE plpgsql STABLE;

-- Get all holiday dates for a given year
CREATE OR REPLACE FUNCTION get_holidays_for_year(p_year INT)
RETURNS TABLE(holiday_name TEXT, holiday_date DATE) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    r.display_name::TEXT,
    calculate_holiday_date(r.*, p_year)
  FROM holiday_rules r
  WHERE r.is_active = TRUE
    AND r.rule_type != 'weekend'  -- Weekend handled separately
  ORDER BY calculate_holiday_date(r.*, p_year);
END;
$$ LANGUAGE plpgsql STABLE;

-- Main function: Check if a date qualifies for holiday/weekend pricing
-- This replaces the original is_holiday_or_weekend function
CREATE OR REPLACE FUNCTION is_holiday_or_weekend(check_date DATE)
RETURNS BOOLEAN AS $$
DECLARE
  check_year INT;
BEGIN
  check_year := EXTRACT(YEAR FROM check_date)::INT;
  
  -- Check if weekend (Saturday = 6, Sunday = 0)
  IF EXTRACT(DOW FROM check_date) IN (0, 6) THEN
    RETURN TRUE;
  END IF;
  
  -- Check against calculated holidays for this year
  IF EXISTS (
    SELECT 1 
    FROM get_holidays_for_year(check_year) h
    WHERE h.holiday_date = check_date
  ) THEN
    RETURN TRUE;
  END IF;
  
  RETURN FALSE;
END;
$$ LANGUAGE plpgsql STABLE;

-- ============================================================================
-- SEED DATA: FEDERAL & COMMON HOLIDAYS
-- These rules work for any year - no annual updates needed!
-- ============================================================================

INSERT INTO holiday_rules (display_name, description, rule_type, month, day, weekday, nth, sort_order)
VALUES
  -- Fixed-date holidays
  ('New Year''s Day', 'January 1st', 'fixed', 1, 1, NULL, NULL, 1),
  ('Independence Day', 'July 4th', 'fixed', 7, 4, NULL, NULL, 7),
  ('Veterans Day', 'November 11th', 'fixed', 11, 11, NULL, NULL, 11),
  ('Christmas Eve', 'December 24th', 'fixed', 12, 24, NULL, NULL, 13),
  ('Christmas Day', 'December 25th', 'fixed', 12, 25, NULL, NULL, 14),
  ('New Year''s Eve', 'December 31st', 'fixed', 12, 31, NULL, NULL, 15),
  
  -- Nth weekday holidays (weekday: 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat)
  ('Martin Luther King Jr. Day', 'Third Monday of January', 'nth_weekday', 1, NULL, 1, 3, 2),
  ('Presidents'' Day', 'Third Monday of February', 'nth_weekday', 2, NULL, 1, 3, 3),
  ('Columbus Day', 'Second Monday of October', 'nth_weekday', 10, NULL, 1, 2, 10),
  ('Thanksgiving', 'Fourth Thursday of November', 'nth_weekday', 11, NULL, 4, 4, 12),
  
  -- Last weekday holidays
  ('Memorial Day', 'Last Monday of May', 'last_weekday', 5, NULL, 1, NULL, 5),
  
  -- Labor Day (first Monday of September)
  ('Labor Day', 'First Monday of September', 'nth_weekday', 9, NULL, 1, 1, 9);

-- Day after Thanksgiving (relative to Thanksgiving)
INSERT INTO holiday_rules (display_name, description, rule_type, relative_to_rule_id, relative_days, sort_order)
SELECT 
  'Day After Thanksgiving', 
  'Friday after Thanksgiving', 
  'relative',
  id,
  1,
  12
FROM holiday_rules 
WHERE display_name = 'Thanksgiving';

-- ============================================================================
-- PERMISSIONS FOR HOLIDAY RULES
-- ============================================================================

GRANT SELECT ON holiday_rules TO web_anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON holiday_rules TO authenticated;  -- RLS restricts to admin
GRANT USAGE, SELECT ON SEQUENCE holiday_rules_id_seq TO authenticated;

ALTER TABLE holiday_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "holiday_rules: read all" ON holiday_rules
  FOR SELECT TO PUBLIC
  USING (TRUE);

CREATE POLICY "holiday_rules: admin modify" ON holiday_rules
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- Apply timestamp triggers
CREATE TRIGGER set_created_at_trigger
  BEFORE INSERT ON holiday_rules
  FOR EACH ROW
  EXECUTE FUNCTION public.set_created_at();

CREATE TRIGGER set_updated_at_trigger
  BEFORE INSERT OR UPDATE ON holiday_rules
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- Configure entity metadata
INSERT INTO metadata.entities (table_name, display_name, description, sort_order)
VALUES ('holiday_rules', 'Holiday Rules', 'Evergreen rules for calculating holiday pricing dates', 35)
ON CONFLICT (table_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description;

-- ============================================================================
-- SECTION 2: DASHBOARD CONFIGURATION
-- Public-facing home page with calendar, navigation, and tips
-- ============================================================================

DO $$
DECLARE 
  v_dashboard_id INT;
  v_admin_user_id UUID;
BEGIN
  -- Get first admin user for dashboard ownership
  SELECT u.id INTO v_admin_user_id
  FROM metadata.civic_os_users u
  JOIN metadata.user_roles ur ON u.id = ur.user_id
  JOIN metadata.roles r ON ur.role_id = r.id
  WHERE r.display_name = 'admin'
  LIMIT 1;
  
  -- Fallback to any user if no admin exists yet
  IF v_admin_user_id IS NULL THEN
    SELECT id INTO v_admin_user_id FROM metadata.civic_os_users LIMIT 1;
  END IF;

  -- Clear any existing default dashboard (unique constraint allows only one)
  UPDATE metadata.dashboards SET is_default = FALSE WHERE is_default = TRUE;

  -- Create main dashboard
  INSERT INTO metadata.dashboards (
    display_name, 
    description, 
    is_default, 
    is_public, 
    sort_order,
    created_by
  ) VALUES (
    'Mott Park Clubhouse Reservations',
    'View availability and reserve the clubhouse for your next event',
    TRUE,
    TRUE,
    1,
    v_admin_user_id
  )
  RETURNING id INTO v_dashboard_id;

  -- ============================================================================
  -- Widget 1: Welcome Header (Markdown - Full Width)
  -- ============================================================================
  INSERT INTO metadata.dashboard_widgets (
    dashboard_id, widget_type, title, config, sort_order, width, height
  ) VALUES (
    v_dashboard_id,
    'markdown',
    NULL,  -- No title for header widget
    jsonb_build_object(
      'content', E'# 🏠 Mott Park Recreation Area Clubhouse

Welcome to the Mott Park Recreation Area reservation system! The clubhouse is available for community events, meetings, and private gatherings.

**Capacity:** 75 people  |  **Hours:** Until 10 PM (vacate by 11 PM)  |  **Minimum Rental:** 4 hours',
      'enableHtml', false
    ),
    1,   -- sort_order (first)
    2,   -- width (full width)
    1    -- height (single unit)
  );

  -- ============================================================================
  -- Widget 2: Quick Actions (Markdown with Links - Half Width)
  -- ============================================================================
  INSERT INTO metadata.dashboard_widgets (
    dashboard_id, widget_type, title, config, sort_order, width, height
  ) VALUES (
    v_dashboard_id,
    'markdown',
    'Quick Actions',
    jsonb_build_object(
      'content', E'### Ready to Reserve?

<a href="/create/reservation_requests" class="btn btn-primary btn-lg w-full mb-4">📅 Request a Reservation</a>

### Already Have a Reservation?

<a href="/view/reservation_requests" class="btn btn-outline btn-md w-full mb-2">View My Reservations</a>

### Need Help?

- 📋 [View Facility Use Policy](/docs/policy)
- 📞 Contact: (810) 555-MPRA
- 📧 Email: reservations@mottparkra.org',
      'enableHtml', true
    ),
    2,   -- sort_order
    1,   -- width (half width)
    2    -- height (double unit)
  );

  -- ============================================================================
  -- Widget 3: Getting Started Tips (Markdown - Half Width)
  -- ============================================================================
  INSERT INTO metadata.dashboard_widgets (
    dashboard_id, widget_type, title, config, sort_order, width, height
  ) VALUES (
    v_dashboard_id,
    'markdown',
    'Getting Started',
    jsonb_build_object(
      'content', E'### How It Works

1. **Check Availability** - Use the calendar below to see open dates
2. **Submit Request** - Click "Request a Reservation" and fill out the form
3. **Wait for Approval** - Staff will review within 2-3 business days
4. **Make Payment** - Once approved, pay your deposit and fees online

### Pricing

| Fee | Amount | When Due |
|-----|--------|----------|
| Security Deposit | $150 | Upon approval |
| Facility Fee (Weekday) | $150 | 30 days before |
| Facility Fee (Weekend/Holiday) | $300 | 30 days before |
| Cleaning Fee | $75 | Before event |

*Security deposit is refundable after event if no damages.*',
      'enableHtml', false
    ),
    3,   -- sort_order
    1,   -- width (half width)
    2    -- height (double unit)
  );

  -- ============================================================================
  -- Widget 4: Availability Calendar (Full Width, Tall)
  -- Uses public_calendar_events which only contains approved/completed events
  -- (synced from reservation_requests via trigger in 05_mpra_public_calendar.sql)
  -- ============================================================================
  INSERT INTO metadata.dashboard_widgets (
    dashboard_id,
    widget_type,
    title,
    entity_key,
    config,
    sort_order,
    width,
    height
  ) VALUES (
    v_dashboard_id,
    'calendar',
    'Clubhouse Availability',
    'public_calendar_events',
    jsonb_build_object(
      'entityKey', 'public_calendar_events',
      'timeSlotPropertyName', 'time_slot',
      'defaultColor', '#22C55E',           -- Green for approved events
      'initialView', 'dayGridMonth',       -- Month view as requested
      'showCreateButton', false,           -- No create button - users create via reservation_requests
      'maxEvents', 500,
      -- No filters needed - public_calendar_events only contains approved/completed
      'showColumns', jsonb_build_array('display_name', 'event_type')
    ),
    4,   -- sort_order (last, below the info sections)
    2,   -- width (full width)
    3    -- height (triple unit for good calendar visibility)
  );

  -- ============================================================================
  -- Widget 5: Facility Rules Reminder (Markdown - Full Width)
  -- ============================================================================
  INSERT INTO metadata.dashboard_widgets (
    dashboard_id, widget_type, title, config, sort_order, width, height
  ) VALUES (
    v_dashboard_id,
    'markdown',
    'Important Reminders',
    jsonb_build_object(
      'content', E'### Facility Rules

- 🚫 **No alcohol** (City of Flint ordinance)
- 🚫 **No cooking** - warming food only; food must be catered or prepared off-site
- 🚫 **No candles or open flames**
- 🚫 **No smoking/vaping** within 20 feet
- 🎵 **Music must end by 10 PM**
- 🚪 **All guests must vacate by 11 PM**
- 🐕 **No pets** except service animals

*The person signing the reservation is responsible for their group''s conduct and any damages.*',
      'enableHtml', false
    ),
    5,   -- sort_order
    2,   -- width (full width)
    1    -- height (single unit)
  );

END $$;

-- ============================================================================
-- OPTIONAL: MANAGER DASHBOARD
-- Internal dashboard for staff to manage requests
-- ============================================================================

DO $$
DECLARE 
  v_dashboard_id INT;
  v_admin_user_id UUID;
BEGIN
  -- Get first admin user
  SELECT u.id INTO v_admin_user_id
  FROM metadata.civic_os_users u
  JOIN metadata.user_roles ur ON u.id = ur.user_id
  JOIN metadata.roles r ON ur.role_id = r.id
  WHERE r.display_name = 'admin'
  LIMIT 1;
  
  IF v_admin_user_id IS NULL THEN
    SELECT id INTO v_admin_user_id FROM metadata.civic_os_users LIMIT 1;
  END IF;

  -- Create manager dashboard (not default, not public)
  INSERT INTO metadata.dashboards (
    display_name, 
    description, 
    is_default, 
    is_public, 
    sort_order,
    created_by
  ) VALUES (
    'Reservation Management',
    'Staff dashboard for managing reservation requests',
    FALSE,
    FALSE,  -- Only visible to logged-in users with access
    2,
    v_admin_user_id
  )
  RETURNING id INTO v_dashboard_id;

  -- Widget 1: Pending Requests (needs attention)
  INSERT INTO metadata.dashboard_widgets (
    dashboard_id, widget_type, title, entity_key, config, sort_order, width, height
  ) VALUES (
    v_dashboard_id,
    'filtered_list',
    '⏳ Pending Requests',
    'reservation_requests',
    jsonb_build_object(
      'filters', jsonb_build_array(
        jsonb_build_object(
          'column', 'status_id',
          'operator', 'eq',
          'value', (SELECT id FROM metadata.statuses WHERE entity_type = 'reservation_request' AND display_name = 'Pending')
        )
      ),
      'orderBy', 'created_at',
      'orderDirection', 'asc',  -- Oldest first (FIFO)
      'limit', 10,
      'showColumns', jsonb_build_array('display_name_full', 'time_slot', 'attendee_count', 'created_at')
    ),
    1, 1, 2
  );

  -- Widget 2: Upcoming Approved Events
  INSERT INTO metadata.dashboard_widgets (
    dashboard_id, widget_type, title, entity_key, config, sort_order, width, height
  ) VALUES (
    v_dashboard_id,
    'filtered_list',
    '✅ Upcoming Approved Events',
    'reservation_requests',
    jsonb_build_object(
      'filters', jsonb_build_array(
        jsonb_build_object(
          'column', 'status_id',
          'operator', 'eq',
          'value', (SELECT id FROM metadata.statuses WHERE entity_type = 'reservation_request' AND display_name = 'Approved')
        )
      ),
      'orderBy', 'time_slot',
      'orderDirection', 'asc',
      'limit', 10,
      'showColumns', jsonb_build_array('display_name_full', 'time_slot', 'facility_fee_amount', 'is_public_event')
    ),
    2, 1, 2
  );

  -- Widget 3: Full Calendar View
  INSERT INTO metadata.dashboard_widgets (
    dashboard_id, widget_type, title, entity_key, config, sort_order, width, height
  ) VALUES (
    v_dashboard_id,
    'calendar',
    'All Reservations',
    'reservation_requests',
    jsonb_build_object(
      'entityKey', 'reservation_requests',
      'timeSlotPropertyName', 'time_slot',
      'defaultColor', '#3B82F6',
      'initialView', 'timeGridWeek',  -- Week view for managers
      'showCreateButton', true,
      'maxEvents', 500,
      'filters', jsonb_build_array(
        -- Show all non-denied/cancelled for managers
        jsonb_build_object(
          'column', 'status_id',
          'operator', 'in',
          'value', (
            SELECT jsonb_agg(id)
            FROM metadata.statuses
            WHERE entity_type = 'reservation_request'
            AND display_name NOT IN ('Denied', 'Cancelled')
          )
        )
      )
    ),
    3, 2, 3
  );

  -- Widget 4: Payments Needing Attention
  INSERT INTO metadata.dashboard_widgets (
    dashboard_id, widget_type, title, entity_key, config, sort_order, width, height
  ) VALUES (
    v_dashboard_id,
    'filtered_list',
    '💳 Pending Payments',
    'reservation_payments',
    jsonb_build_object(
      'filters', jsonb_build_array(
        jsonb_build_object('column', 'status', 'operator', 'eq', 'value', 'pending')
      ),
      'orderBy', 'due_date',
      'orderDirection', 'asc',
      'limit', 15,
      'showColumns', jsonb_build_array('display_name', 'amount', 'due_date', 'reservation_request_id')
    ),
    4, 2, 2
  );

END $$;

-- ============================================================================
-- NOTIFY POSTGREST TO RELOAD SCHEMA
-- ============================================================================

NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- VERIFICATION QUERIES
-- Run these to test the holiday rules system
-- ============================================================================

/*
-- Test: Show all holidays for 2025
SELECT * FROM get_holidays_for_year(2025) ORDER BY holiday_date;

-- Test: Check specific dates
SELECT '2025-07-04'::DATE AS date, is_holiday_or_weekend('2025-07-04') AS is_holiday; -- True (July 4th)
SELECT '2025-07-05'::DATE AS date, is_holiday_or_weekend('2025-07-05') AS is_holiday; -- True (Saturday)
SELECT '2025-07-07'::DATE AS date, is_holiday_or_weekend('2025-07-07') AS is_holiday; -- False (Monday)
SELECT '2025-11-27'::DATE AS date, is_holiday_or_weekend('2025-11-27') AS is_holiday; -- True (Thanksgiving)
SELECT '2025-11-28'::DATE AS date, is_holiday_or_weekend('2025-11-28') AS is_holiday; -- True (Day after)

-- Test: Show holidays for next 3 years
SELECT * FROM get_holidays_for_year(2025)
UNION ALL
SELECT * FROM get_holidays_for_year(2026)
UNION ALL
SELECT * FROM get_holidays_for_year(2027)
ORDER BY holiday_date;
*/

-- Complete transaction
COMMIT;

-- ROLLBACK;