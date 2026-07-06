-- =============================================================================
-- Script 20: Client Identity Consolidation — Move Identity to User Record
-- =============================================================================
-- Requires: Scripts 01-19 applied, all clients have user_id set
--
-- Follows the precedent set by staff-portal/15_staff_member_user_link.sql.
-- Instead of duplicating identity (first_name, last_name, email, phone) on
-- the clients table, we consolidate to the user record:
--   - user_id becomes NOT NULL (every client must have a user account)
--   - Redundant identity columns are dropped
--   - display_name is trigger-managed from civic_os_users_private
--   - Notification functions JOIN through CUP for client email
--
-- No existing init scripts are modified. All changes are additive.
-- =============================================================================

BEGIN;

-- =============================================================================
-- A. GRANT civic_os_users_private:read TO STAFF ROLES
-- =============================================================================
-- Staff need to see client user accounts for FK display name resolution.
-- The existing RLS policy "Permitted roles see all private data" checks
-- has_permission(), so granting the permission is sufficient.

INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'civic_os_users_private'
  AND p.permission = 'read'
  AND r.role_key IN ('ic_staff', 'admin')
ON CONFLICT DO NOTHING;


-- =============================================================================
-- B. SCHEMA CHANGES TO clients TABLE
-- =============================================================================

-- Safety check: fail loudly if any client has NULL user_id
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM clients WHERE user_id IS NULL) THEN
    RAISE EXCEPTION 'Cannot migrate: clients with NULL user_id exist. Link all clients to users first.';
  END IF;
END $$;

-- 1. Drop search_vector generated column (depends on first_name/last_name)
ALTER TABLE clients DROP COLUMN IF EXISTS search_vector;

-- 2. Drop display_name generated column (depends on first_name/last_name)
ALTER TABLE clients DROP COLUMN IF EXISTS display_name;

-- 3. Drop trigram index (on the old display_name column — dropped with column)
--    Index idx_clients_display_name_trgm was dropped automatically with column.

-- 4. Drop redundant identity columns
ALTER TABLE clients
  DROP COLUMN first_name,
  DROP COLUMN last_name,
  DROP COLUMN email,
  DROP COLUMN phone;

-- 5. Add display_name as regular column (trigger-managed, not GENERATED)
ALTER TABLE clients ADD COLUMN display_name VARCHAR(511);

-- 6. Recreate trigram index on new display_name
CREATE INDEX idx_clients_display_name_trgm ON clients USING GIN(display_name gin_trgm_ops);

-- 7. Make user_id NOT NULL + UNIQUE
--    UNIQUE implicitly creates an index, replacing idx_clients_user_id.
ALTER TABLE clients ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE clients ADD CONSTRAINT clients_user_id_unique UNIQUE (user_id);

-- 8. Recreate search_vector using display_name + remaining text fields
ALTER TABLE clients ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (
    to_tsvector('simple',
      coalesce(display_name, '') || ' ' ||
      coalesce(country_of_origin, '') || ' ' ||
      coalesce(primary_language, '')
    )
  ) STORED;

CREATE INDEX idx_clients_search ON clients USING GIN(search_vector);

-- 9. Drop old FK index (UNIQUE constraint covers user_id lookups)
DROP INDEX IF EXISTS idx_clients_user_id;

-- 10. Drop the old unique_client_per_user constraint from script 18
--     (replaced by clients_user_id_unique above)
ALTER TABLE clients DROP CONSTRAINT IF EXISTS unique_client_per_user;


-- =============================================================================
-- C. SYNC TRIGGERS: display_name from civic_os_users_private
-- =============================================================================

-- BEFORE INSERT/UPDATE: look up user's display_name and set it on clients
CREATE OR REPLACE FUNCTION sync_client_display_name()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user_name TEXT;
BEGIN
  SELECT cup.display_name INTO v_user_name
    FROM metadata.civic_os_users_private cup WHERE cup.id = NEW.user_id;

  NEW.display_name := COALESCE(v_user_name, 'Unknown');
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_sync_client_display_name
  BEFORE INSERT OR UPDATE OF user_id ON clients
  FOR EACH ROW
  EXECUTE FUNCTION sync_client_display_name();

-- CASCADE: when user's name changes in Keycloak, propagate to clients
CREATE OR REPLACE FUNCTION cascade_user_name_to_client()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF OLD.display_name IS DISTINCT FROM NEW.display_name THEN
    UPDATE clients
    SET display_name = NEW.display_name
    WHERE user_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_cascade_user_name_to_client
  AFTER UPDATE OF display_name ON metadata.civic_os_users_private
  FOR EACH ROW
  EXECUTE FUNCTION cascade_user_name_to_client();

-- Backfill existing rows (no-op UPDATE triggers BEFORE UPDATE, populating display_name)
UPDATE clients SET user_id = user_id;


-- =============================================================================
-- D. SIMPLIFY auto_set_client_user_id()
-- =============================================================================
-- With user_id NOT NULL, staff creating records on behalf of clients MUST
-- provide user_id explicitly. Self-service clients still get auto-linked
-- via current_user_id(). The permission guard is no longer needed.

CREATE OR REPLACE FUNCTION auto_set_client_user_id()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF NEW.user_id IS NULL THEN
    NEW.user_id := current_user_id();
  END IF;
  RETURN NEW;
END;
$$;


-- =============================================================================
-- E. UPDATE NOTIFICATION FUNCTIONS (c.email → CUP JOIN)
-- =============================================================================

-- 1. send_referral_notification(): c.email → cup_client.email
CREATE OR REPLACE FUNCTION send_referral_notification(p_referral_id BIGINT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_client_email TEXT;
  v_client_name TEXT;
  v_partner_email TEXT;
  v_partner_name TEXT;
  v_partner_contact TEXT;
  v_partner_phone TEXT;
  v_partner_address TEXT;
  v_partner_website TEXT;
  v_staff_email TEXT;
  v_staff_name TEXT;
  v_referral_type TEXT;
  v_referral_type_key TEXT;
  v_referral_date TEXT;
  v_service_categories TEXT;
  v_to_addresses TEXT[];
  v_cc_addresses TEXT[];
BEGIN
  -- Gather referral details
  -- Client email now comes from civic_os_users_private via user_id
  SELECT
    cup_client.email, c.display_name,
    p.email, p.display_name, p.contact_name, p.phone, p.address, p.website,
    cup_staff.email, cup_staff.display_name,
    cat.display_name, cat.category_key,
    to_char(r.referral_date, 'YYYY-MM-DD')
  INTO
    v_client_email, v_client_name,
    v_partner_email, v_partner_name, v_partner_contact, v_partner_phone, v_partner_address, v_partner_website,
    v_staff_email, v_staff_name,
    v_referral_type, v_referral_type_key,
    v_referral_date
  FROM referrals r
  JOIN clients c ON r.client_id = c.id
  JOIN metadata.civic_os_users_private cup_client ON c.user_id = cup_client.id
  JOIN partners p ON r.partner_id = p.id
  LEFT JOIN metadata.civic_os_users_private cup_staff ON r.referred_by = cup_staff.id
  LEFT JOIN metadata.categories cat ON r.referral_type_id = cat.id
  WHERE r.id = p_referral_id;

  -- Aggregate service categories for this referral
  SELECT string_agg(sc.display_name, ', ' ORDER BY sc.sort_order)
  INTO v_service_categories
  FROM referral_service_categories rsc
  JOIN service_categories sc ON rsc.service_category_id = sc.id
  WHERE rsc.referral_id = p_referral_id;

  -- Build recipient lists based on referral type:
  --   Warm: client (To) + partner (To) + staff (CC)
  --   Info: client (To) + staff (CC) — partner info is in the body but they're not emailed
  v_to_addresses := ARRAY[]::TEXT[];
  IF v_client_email IS NOT NULL THEN
    v_to_addresses := v_to_addresses || v_client_email;
  END IF;
  IF v_referral_type_key = 'warm' AND v_partner_email IS NOT NULL THEN
    v_to_addresses := v_to_addresses || v_partner_email;
  END IF;

  v_cc_addresses := ARRAY[]::TEXT[];
  IF v_staff_email IS NOT NULL THEN
    v_cc_addresses := v_cc_addresses || v_staff_email;
  END IF;

  -- Only send if we have at least one recipient
  IF array_length(v_to_addresses, 1) > 0 THEN
    PERFORM metadata.send_email(
      p_to_addresses  := v_to_addresses,
      p_template_name := 'referral_created',
      p_cc_addresses  := v_cc_addresses,
      p_entity_type   := 'referrals',
      p_entity_id     := p_referral_id::TEXT,
      p_entity_data   := jsonb_build_object(
        'client_name', COALESCE(v_client_name, 'Unknown'),
        'partner_name', COALESCE(v_partner_name, 'Unknown'),
        'partner_contact', v_partner_contact,
        'partner_email', v_partner_email,
        'partner_phone', v_partner_phone,
        'partner_address', v_partner_address,
        'partner_website', v_partner_website,
        'staff_name', COALESCE(v_staff_name, 'Staff'),
        'referral_type', COALESCE(v_referral_type, 'Referral'),
        'referral_date', COALESCE(v_referral_date, ''),
        'service_categories', COALESCE(v_service_categories, 'Not specified')
      )
    );
  END IF;
END;
$$;


-- 2. run_survey_reminders(): c.email → cup_client.email
--    Replaces the version from script 08 (the latest override).
CREATE OR REPLACE FUNCTION run_survey_reminders()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_reminders_sent INT := 0;
  v_surveys_expired INT := 0;
  v_survey RECORD;
  v_client_email TEXT;
  v_client_name TEXT;
  v_partner_name TEXT;
  v_referral_date TEXT;
  v_service_categories TEXT;
  v_days_since INT;
  v_pending_status_id INT;
  v_expired_status_id INT;
BEGIN
  v_pending_status_id := get_status_id('survey', 'pending');
  v_expired_status_id := get_status_id('survey', 'expired');

  -- Find pending surveys with referrals created 3, 5, or 7+ days ago
  -- Client email now comes from civic_os_users_private via user_id
  FOR v_survey IN
    SELECT
      s.id AS survey_id,
      r.id AS referral_id,
      r.referral_date,
      cup_client.email AS client_email,
      c.display_name AS client_name,
      c.id AS client_id,
      p.display_name AS partner_name,
      (CURRENT_DATE - r.referral_date) AS days_since
    FROM follow_up_surveys s
    JOIN referrals r ON s.referral_id = r.id
    JOIN clients c ON r.client_id = c.id
    JOIN metadata.civic_os_users_private cup_client ON c.user_id = cup_client.id
    JOIN partners p ON r.partner_id = p.id
    WHERE s.status_id = v_pending_status_id
      AND (CURRENT_DATE - r.referral_date) IN (3, 5, 7)
  LOOP
    -- Gather service categories for this referral
    SELECT string_agg(sc.display_name, ', ' ORDER BY sc.sort_order)
    INTO v_service_categories
    FROM referral_service_categories rsc
    JOIN service_categories sc ON rsc.service_category_id = sc.id
    WHERE rsc.referral_id = v_survey.referral_id;

    -- Send reminder email if client has email
    IF v_survey.client_email IS NOT NULL THEN
      PERFORM metadata.send_email(
        p_to_addresses  := ARRAY[v_survey.client_email],
        p_template_name := 'survey_reminder',
        p_entity_type   := 'follow_up_surveys',
        p_entity_id     := v_survey.survey_id::TEXT,
        p_entity_data   := jsonb_build_object(
          'client_name', COALESCE(v_survey.client_name, 'Client'),
          'partner_name', COALESCE(v_survey.partner_name, 'Partner'),
          'referral_date', to_char(v_survey.referral_date, 'YYYY-MM-DD'),
          'service_categories', COALESCE(v_service_categories, 'Not specified'),
          'survey_id', v_survey.survey_id
        )
      );
      v_reminders_sent := v_reminders_sent + 1;
    END IF;
  END LOOP;

  -- Expire surveys older than 7 days — loop so each client gets a note
  FOR v_survey IN
    SELECT s.id AS survey_id, r.client_id, p.display_name AS partner_name
    FROM follow_up_surveys s
    JOIN referrals r ON s.referral_id = r.id
    JOIN partners p ON r.partner_id = p.id
    WHERE s.status_id = v_pending_status_id
      AND (CURRENT_DATE - r.referral_date) > 7
  LOOP
    UPDATE follow_up_surveys
    SET status_id = v_expired_status_id,
        updated_at = NOW()
    WHERE id = v_survey.survey_id;

    PERFORM create_entity_note(
      p_entity_type := 'clients',
      p_entity_id   := v_survey.client_id::TEXT,
      p_content     := format('Follow-up survey expired (no response after 7 days) for referral to **%s**', COALESCE(v_survey.partner_name, 'Unknown')),
      p_note_type   := 'system',
      p_author_id   := NULL
    );

    v_surveys_expired := v_surveys_expired + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'success', TRUE,
    'message', format('Sent %s reminders, expired %s surveys', v_reminders_sent, v_surveys_expired),
    'details', jsonb_build_object(
      'reminders_sent', v_reminders_sent,
      'surveys_expired', v_surveys_expired
    )
  );

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object(
    'success', FALSE,
    'message', SQLERRM
  );
END;
$$;


-- =============================================================================
-- F. METADATA CLEANUP
-- =============================================================================

-- display_name: keep on list/detail but hide from create/edit (trigger-managed)
UPDATE metadata.properties
SET show_on_create = FALSE, show_on_edit = FALSE
WHERE table_name = 'clients' AND column_name = 'display_name';

-- user_id: promote to primary identity field, show on list
UPDATE metadata.properties
SET show_on_list = TRUE, sort_order = 2, display_name = 'User'
WHERE table_name = 'clients' AND column_name = 'user_id';

-- Remove property registrations for dropped columns
DELETE FROM metadata.properties
WHERE table_name = 'clients' AND column_name IN ('first_name', 'last_name', 'email', 'phone');

-- Remove validations for dropped columns
DELETE FROM metadata.validations
WHERE table_name = 'clients' AND column_name IN ('first_name', 'last_name');

-- Add constraint message for user_id unique
INSERT INTO metadata.constraint_messages (constraint_name, table_name, column_name, error_message)
VALUES ('clients_user_id_unique', 'clients', 'user_id',
        'This user is already linked to a client record.')
ON CONFLICT (constraint_name) DO UPDATE SET error_message = EXCLUDED.error_message;

-- Remove old constraint message from script 18 (constraint was replaced)
DELETE FROM metadata.constraint_messages
WHERE constraint_name = 'unique_client_per_user';

-- Remove translations for dropped columns (all 5 languages)
DELETE FROM metadata.translations
WHERE source_type = 'property'
  AND source_key IN (
    'clients.first_name.display_name',
    'clients.last_name.display_name',
    'clients.email.display_name',
    'clients.phone.display_name'
  );


-- =============================================================================
-- G. SCHEMA DECISION (ADR)
-- =============================================================================

INSERT INTO metadata.schema_decisions (entity_types, property_names, migration_id, title, status, context, decision, rationale, consequences, decided_date)
VALUES (
  ARRAY['clients']::NAME[], ARRAY['user_id', 'display_name', 'first_name', 'last_name', 'email', 'phone']::NAME[], 'client-intake-20-identity',
  'Consolidate client identity to user record',
  'accepted',
  'The clients table duplicated identity fields (first_name, last_name, email, phone) that already exist on civic_os_users_private. With the profile extension system (v0.65.0+), every client must have a user account, making these columns redundant.',
  'Make user_id NOT NULL + UNIQUE. Drop first_name, last_name, email, phone columns. Auto-compute display_name via BEFORE trigger from civic_os_users_private. Notification functions JOIN through CUP for client email. Follows the staff-portal/15_staff_member_user_link.sql precedent.',
  'Alternative: keep identity columns as optional overrides. Rejected because identity should have one source of truth (the user record), and the profile extension system already ensures every client has a linked user.',
  'Identity columns removed. display_name is read-only (trigger-managed). Cascade trigger propagates name changes from Keycloak. Notification functions use CUP JOINs for email.',
  CURRENT_DATE
);


-- =============================================================================
-- H. POSTGREST RELOAD
-- =============================================================================

NOTIFY pgrst, 'reload schema';

COMMIT;
