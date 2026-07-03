-- Deploy civic_os:v0-65-0-user-profile-extensions
-- Requires: v0-64-1-i18n-expansion
--
-- v0.65.0 — User Profile Extension System:
--   1. metadata.user_profile_extensions config table
--   2. update_own_profile() RPC for self-service profile editing
--   3. get_user_profile_extensions() RPC for profile page + completion guard
--   4. get_user_profile_extensions_admin() RPC for admin user management
--   5. PostgREST VIEW for config table access
--   6. i18n translations for profile UI strings

BEGIN;

-- ============================================================================
-- 1. CREATE metadata.user_profile_extensions CONFIG TABLE
-- ============================================================================
-- Registers tables as user profile extensions. Extension tables MUST have a
-- UUID FK to metadata.civic_os_users with a UNIQUE constraint (0-or-1 per user).

CREATE TABLE metadata.user_profile_extensions (
    id           SERIAL PRIMARY KEY,
    table_name   NAME NOT NULL REFERENCES metadata.entities(table_name) ON DELETE CASCADE,
    sort_order   INT NOT NULL DEFAULT 0,
    is_required  BOOLEAN NOT NULL DEFAULT FALSE,
    display_name TEXT,
    description  TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT unique_extension_table UNIQUE (table_name)
);

COMMENT ON TABLE metadata.user_profile_extensions IS
    'Registers tables as user profile extensions. Each table must have a UUID FK
     to civic_os_users with a UNIQUE constraint. Added in v0.65.0.';

COMMENT ON COLUMN metadata.user_profile_extensions.is_required IS
    'When true, the profile completion guard blocks navigation until the user
     has created a record in this extension table.';

-- Enable RLS
ALTER TABLE metadata.user_profile_extensions ENABLE ROW LEVEL SECURITY;

-- Everyone can read the config (needed for profile page + guard)
CREATE POLICY "Anyone can read profile extension config"
  ON metadata.user_profile_extensions
  FOR SELECT
  USING (true);

-- Only admins can manage the config
CREATE POLICY "Admins can insert profile extensions"
  ON metadata.user_profile_extensions
  FOR INSERT TO authenticated
  WITH CHECK (public.is_admin());

CREATE POLICY "Admins can update profile extensions"
  ON metadata.user_profile_extensions
  FOR UPDATE TO authenticated
  USING (public.is_admin());

CREATE POLICY "Admins can delete profile extensions"
  ON metadata.user_profile_extensions
  FOR DELETE TO authenticated
  USING (public.is_admin());

-- Grants
GRANT SELECT ON metadata.user_profile_extensions TO web_anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON metadata.user_profile_extensions TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE metadata.user_profile_extensions_id_seq TO authenticated;

-- Updated_at trigger
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON metadata.user_profile_extensions
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();


-- ============================================================================
-- 2. CREATE update_own_profile() RPC
-- ============================================================================
-- Self-service profile editing. Users can only update their own record.
-- Modeled on update_user_info() (v0.31.0) but uses current_user_id().

CREATE OR REPLACE FUNCTION public.update_own_profile(
  p_first_name TEXT,
  p_last_name TEXT,
  p_phone TEXT DEFAULT NULL
)
RETURNS JSON AS $$
DECLARE
  v_user_id UUID;
  v_full_name TEXT;
  v_public_display TEXT;
  v_email TEXT;
BEGIN
  -- Get current user ID from JWT
  v_user_id := public.current_user_id();
  IF v_user_id IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Not authenticated');
  END IF;

  -- Validate required fields
  IF TRIM(COALESCE(p_first_name, '')) = '' OR TRIM(COALESCE(p_last_name, '')) = '' THEN
    RETURN json_build_object('success', false, 'error', 'First name and last name are required');
  END IF;

  -- Build full name and public display name
  v_full_name := TRIM(p_first_name) || ' ' || TRIM(p_last_name);
  v_public_display := public.format_public_display_name(v_full_name);

  -- Update civic_os_users (public profile)
  UPDATE metadata.civic_os_users
  SET display_name = v_public_display,
      updated_at = NOW()
  WHERE id = v_user_id;

  -- Update civic_os_users_private (private profile)
  UPDATE metadata.civic_os_users_private
  SET display_name = v_full_name,
      first_name = TRIM(p_first_name),
      last_name = TRIM(p_last_name),
      phone = CASE WHEN TRIM(COALESCE(p_phone, '')) = '' THEN NULL ELSE TRIM(p_phone) END,
      updated_at = NOW()
  WHERE id = v_user_id;

  -- Fetch current email for Keycloak sync (v0.47.1 pattern: Keycloak PUT
  -- treats missing fields as null, so email must be included in args)
  SELECT email INTO v_email
  FROM metadata.civic_os_users_private
  WHERE id = v_user_id;

  -- Enqueue River job for async Keycloak sync (phone excluded — database is authority)
  INSERT INTO metadata.river_job (args, kind, queue, state, priority, max_attempts)
  VALUES (
    json_build_object(
      'user_id', v_user_id::TEXT,
      'email', COALESCE(v_email::TEXT, ''),
      'first_name', TRIM(p_first_name),
      'last_name', TRIM(p_last_name)
    )::JSONB,
    'update_keycloak_user',
    'user_provisioning',
    'available',
    1,
    5
  );

  RETURN json_build_object('success', true, 'message', 'Profile updated');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION public.update_own_profile(TEXT, TEXT, TEXT) IS
    'Self-service profile update. Updates name/phone for the current user and
     enqueues Keycloak sync. No permission check needed — JWT identity only.
     Added in v0.65.0.';

GRANT EXECUTE ON FUNCTION public.update_own_profile(TEXT, TEXT, TEXT) TO authenticated;


-- ============================================================================
-- 2b. CREATE get_own_profile() RPC
-- ============================================================================
-- Returns the current user's private record (first_name, last_name, etc.)
-- Uses current_user_id() so users can only read their own data.

CREATE OR REPLACE FUNCTION public.get_own_profile()
RETURNS JSON AS $$
DECLARE
  v_user_id UUID;
  v_result JSON;
BEGIN
  v_user_id := public.current_user_id();
  IF v_user_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT json_build_object(
    'id', p.id,
    'display_name', p.display_name,
    'first_name', p.first_name,
    'last_name', p.last_name,
    'email', p.email,
    'phone', p.phone
  ) INTO v_result
  FROM metadata.civic_os_users_private p
  WHERE p.id = v_user_id;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

COMMENT ON FUNCTION public.get_own_profile() IS
    'Returns the current user''s private profile record (name, email, phone).
     Uses current_user_id() from JWT — users can only read their own data.
     Added in v0.65.0.';

GRANT EXECUTE ON FUNCTION public.get_own_profile() TO authenticated;


-- ============================================================================
-- 3. CREATE get_user_profile_extensions() RPC
-- ============================================================================
-- Returns extension config + whether the current user has a record in each
-- extension table. Used by both the profile page and the completion guard.

CREATE OR REPLACE FUNCTION public.get_user_profile_extensions()
RETURNS TABLE (
  table_name NAME,
  sort_order INT,
  is_required BOOLEAN,
  display_name TEXT,
  description TEXT,
  user_fk_column NAME,
  has_record BOOLEAN
) AS $$
DECLARE
  v_user_id UUID;
  v_ext RECORD;
  v_fk_col NAME;
  v_has BOOLEAN;
BEGIN
  v_user_id := public.current_user_id();
  IF v_user_id IS NULL THEN
    RETURN;  -- Return empty for unauthenticated users
  END IF;

  FOR v_ext IN
    SELECT e.table_name AS tbl, e.sort_order, e.is_required,
           COALESCE(e.display_name, ent.display_name, e.table_name::TEXT) AS disp_name,
           e.description
    FROM metadata.user_profile_extensions e
    LEFT JOIN metadata.entities ent ON ent.table_name = e.table_name
    ORDER BY e.sort_order, e.table_name
  LOOP
    -- Discover FK column: find column in the extension table that references civic_os_users
    SELECT kcu.column_name INTO v_fk_col
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name
      AND tc.table_schema = ccu.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = 'public'
      AND tc.table_name = v_ext.tbl::TEXT
      AND ccu.table_name = 'civic_os_users'
    LIMIT 1;

    -- If no FK found, skip this extension
    IF v_fk_col IS NULL THEN
      CONTINUE;
    END IF;

    -- Check if the current user has a record in this extension table
    EXECUTE format(
      'SELECT EXISTS(SELECT 1 FROM public.%I WHERE %I = $1)',
      v_ext.tbl, v_fk_col
    ) INTO v_has USING v_user_id;

    table_name := v_ext.tbl;
    sort_order := v_ext.sort_order;
    is_required := v_ext.is_required;
    display_name := v_ext.disp_name;
    description := v_ext.description;
    user_fk_column := v_fk_col;
    has_record := v_has;
    RETURN NEXT;
  END LOOP;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

COMMENT ON FUNCTION public.get_user_profile_extensions() IS
    'Returns user profile extension config with per-user completion status.
     Discovers FK column name via information_schema. Used by profile page
     and completion guard. Added in v0.65.0.';

GRANT EXECUTE ON FUNCTION public.get_user_profile_extensions() TO authenticated;


-- ============================================================================
-- 4. CREATE get_user_profile_extensions_admin() RPC
-- ============================================================================
-- Same as above but accepts a target user ID. Admin-only.

CREATE OR REPLACE FUNCTION public.get_user_profile_extensions_admin(p_user_id UUID)
RETURNS TABLE (
  table_name NAME,
  sort_order INT,
  is_required BOOLEAN,
  display_name TEXT,
  description TEXT,
  user_fk_column NAME,
  has_record BOOLEAN
) AS $$
DECLARE
  v_ext RECORD;
  v_fk_col NAME;
  v_has BOOLEAN;
BEGIN
  -- Permission check: must have civic_os_users_private:update permission
  IF NOT public.has_permission('civic_os_users_private', 'update') THEN
    RAISE EXCEPTION 'Permission denied: requires civic_os_users_private:update';
  END IF;

  FOR v_ext IN
    SELECT e.table_name AS tbl, e.sort_order, e.is_required,
           COALESCE(e.display_name, ent.display_name, e.table_name::TEXT) AS disp_name,
           e.description
    FROM metadata.user_profile_extensions e
    LEFT JOIN metadata.entities ent ON ent.table_name = e.table_name
    ORDER BY e.sort_order, e.table_name
  LOOP
    -- Discover FK column
    SELECT kcu.column_name INTO v_fk_col
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name
      AND tc.table_schema = ccu.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = 'public'
      AND tc.table_name = v_ext.tbl::TEXT
      AND ccu.table_name = 'civic_os_users'
    LIMIT 1;

    IF v_fk_col IS NULL THEN
      CONTINUE;
    END IF;

    -- Check if the target user has a record
    EXECUTE format(
      'SELECT EXISTS(SELECT 1 FROM public.%I WHERE %I = $1)',
      v_ext.tbl, v_fk_col
    ) INTO v_has USING p_user_id;

    table_name := v_ext.tbl;
    sort_order := v_ext.sort_order;
    is_required := v_ext.is_required;
    display_name := v_ext.disp_name;
    description := v_ext.description;
    user_fk_column := v_fk_col;
    has_record := v_has;
    RETURN NEXT;
  END LOOP;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

COMMENT ON FUNCTION public.get_user_profile_extensions_admin(UUID) IS
    'Admin version of get_user_profile_extensions() that accepts a target user ID.
     Requires civic_os_users_private:update permission. Added in v0.65.0.';

GRANT EXECUTE ON FUNCTION public.get_user_profile_extensions_admin(UUID) TO authenticated;


-- ============================================================================
-- 5. CREATE PostgREST VIEW
-- ============================================================================

CREATE VIEW public.user_profile_extensions AS
SELECT id, table_name, sort_order, is_required, display_name, description, created_at, updated_at
FROM metadata.user_profile_extensions;

ALTER VIEW public.user_profile_extensions SET (security_invoker = true);

COMMENT ON VIEW public.user_profile_extensions IS
    'PostgREST-exposed view for user_profile_extensions config. Security invoker
     delegates access to base table RLS. Added in v0.65.0.';

GRANT SELECT ON public.user_profile_extensions TO web_anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.user_profile_extensions TO authenticated;


-- ============================================================================
-- 6. SEED i18n TRANSLATIONS
-- ============================================================================

-- English
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'profile.title', 'en', 'My Profile'),
('ui', 'profile.my_profile', 'en', 'My Profile'),
('ui', 'profile.personal_info', 'en', 'Personal Information'),
('ui', 'profile.first_name', 'en', 'First Name'),
('ui', 'profile.last_name', 'en', 'Last Name'),
('ui', 'profile.email', 'en', 'Email'),
('ui', 'profile.phone', 'en', 'Phone'),
('ui', 'profile.phone_invalid', 'en', 'Phone must be exactly 10 digits'),
('ui', 'profile.notifications', 'en', 'Notification Preferences'),
('ui', 'profile.complete_required', 'en', 'Complete Your Profile'),
('ui', 'profile.complete_required_description', 'en', 'Please complete the following required sections before continuing.'),
('ui', 'profile.complete_profile', 'en', 'Complete Profile'),
('ui', 'action.dismiss', 'en', 'Dismiss'),
('ui', 'profile.save_success', 'en', 'Profile updated successfully'),
('ui', 'profile.save_error', 'en', 'Failed to update profile'),
('ui', 'profile.email_readonly', 'en', 'Email is managed by your identity provider'),
('ui', 'profile.complete', 'en', 'Complete'),
('ui', 'profile.required', 'en', 'Required'),
('ui', 'profile.not_started', 'en', 'Not Started'),
('ui', 'profile.extensions', 'en', 'Profile Extensions'),
('ui', 'profile.view', 'en', 'View'),
('ui', 'profile.missing', 'en', 'Missing')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- Spanish
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'profile.title', 'es', 'Mi Perfil'),
('ui', 'profile.my_profile', 'es', 'Mi Perfil'),
('ui', 'profile.personal_info', 'es', 'Información Personal'),
('ui', 'profile.first_name', 'es', 'Nombre'),
('ui', 'profile.last_name', 'es', 'Apellido'),
('ui', 'profile.email', 'es', 'Correo Electrónico'),
('ui', 'profile.phone', 'es', 'Teléfono'),
('ui', 'profile.phone_invalid', 'es', 'El teléfono debe tener exactamente 10 dígitos'),
('ui', 'profile.notifications', 'es', 'Preferencias de Notificación'),
('ui', 'profile.complete_required', 'es', 'Complete Su Perfil'),
('ui', 'profile.complete_required_description', 'es', 'Por favor complete las siguientes secciones requeridas antes de continuar.'),
('ui', 'profile.complete_profile', 'es', 'Completar Perfil'),
('ui', 'action.dismiss', 'es', 'Descartar'),
('ui', 'profile.save_success', 'es', 'Perfil actualizado exitosamente'),
('ui', 'profile.save_error', 'es', 'Error al actualizar el perfil'),
('ui', 'profile.email_readonly', 'es', 'El correo electrónico es administrado por su proveedor de identidad'),
('ui', 'profile.complete', 'es', 'Completo'),
('ui', 'profile.required', 'es', 'Requerido'),
('ui', 'profile.not_started', 'es', 'No Iniciado'),
('ui', 'profile.extensions', 'es', 'Extensiones de Perfil'),
('ui', 'profile.view', 'es', 'Ver'),
('ui', 'profile.missing', 'es', 'Faltante')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- Arabic
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'profile.title', 'ar', 'ملفي الشخصي'),
('ui', 'profile.my_profile', 'ar', 'ملفي الشخصي'),
('ui', 'profile.personal_info', 'ar', 'المعلومات الشخصية'),
('ui', 'profile.first_name', 'ar', 'الاسم الأول'),
('ui', 'profile.last_name', 'ar', 'اسم العائلة'),
('ui', 'profile.email', 'ar', 'البريد الإلكتروني'),
('ui', 'profile.phone', 'ar', 'الهاتف'),
('ui', 'profile.phone_invalid', 'ar', 'يجب أن يكون رقم الهاتف 10 أرقام بالضبط'),
('ui', 'profile.notifications', 'ar', 'تفضيلات الإشعارات'),
('ui', 'profile.complete_required', 'ar', 'أكمل ملفك الشخصي'),
('ui', 'profile.complete_required_description', 'ar', 'يرجى إكمال الأقسام المطلوبة التالية قبل المتابعة.'),
('ui', 'profile.complete_profile', 'ar', 'إكمال الملف الشخصي'),
('ui', 'action.dismiss', 'ar', 'تجاهل'),
('ui', 'profile.save_success', 'ar', 'تم تحديث الملف الشخصي بنجاح'),
('ui', 'profile.save_error', 'ar', 'فشل تحديث الملف الشخصي'),
('ui', 'profile.email_readonly', 'ar', 'يتم إدارة البريد الإلكتروني بواسطة مزود الهوية الخاص بك'),
('ui', 'profile.complete', 'ar', 'مكتمل'),
('ui', 'profile.required', 'ar', 'مطلوب'),
('ui', 'profile.not_started', 'ar', 'لم يبدأ'),
('ui', 'profile.extensions', 'ar', 'ملحقات الملف الشخصي'),
('ui', 'profile.view', 'ar', 'عرض'),
('ui', 'profile.missing', 'ar', 'مفقود')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- Pashto
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'profile.title', 'ps', 'زما پروفایل'),
('ui', 'profile.my_profile', 'ps', 'زما پروفایل'),
('ui', 'profile.personal_info', 'ps', 'شخصي معلومات'),
('ui', 'profile.first_name', 'ps', 'لومړی نوم'),
('ui', 'profile.last_name', 'ps', 'تخلص'),
('ui', 'profile.email', 'ps', 'بریښنالیک'),
('ui', 'profile.phone', 'ps', 'تلیفون'),
('ui', 'profile.phone_invalid', 'ps', 'تلیفون باید دقیقاً ۱۰ عددونه ولري'),
('ui', 'profile.notifications', 'ps', 'د خبرتیا غوره توبونه'),
('ui', 'profile.complete_required', 'ps', 'خپل پروفایل بشپړ کړئ'),
('ui', 'profile.complete_required_description', 'ps', 'مهرباني وکړئ د دوام مخکې لاندې اړین برخې بشپړې کړئ.'),
('ui', 'profile.complete_profile', 'ps', 'پروفایل بشپړ کړئ'),
('ui', 'action.dismiss', 'ps', 'رد کړئ'),
('ui', 'profile.save_success', 'ps', 'پروفایل په بریالیتوب سره تازه شو'),
('ui', 'profile.save_error', 'ps', 'د پروفایل تازه کول ناکام شو'),
('ui', 'profile.email_readonly', 'ps', 'بریښنالیک ستاسو د پیژندنې چمتو کونکي لخوا اداره کیږي'),
('ui', 'profile.complete', 'ps', 'بشپړ'),
('ui', 'profile.required', 'ps', 'اړین'),
('ui', 'profile.not_started', 'ps', 'نه دی پیل شوی'),
('ui', 'profile.extensions', 'ps', 'د پروفایل توسیعونه'),
('ui', 'profile.view', 'ps', 'لیدل'),
('ui', 'profile.missing', 'ps', 'ورکه')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- French
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'profile.title', 'fr', 'Mon Profil'),
('ui', 'profile.my_profile', 'fr', 'Mon Profil'),
('ui', 'profile.personal_info', 'fr', 'Informations Personnelles'),
('ui', 'profile.first_name', 'fr', 'Prénom'),
('ui', 'profile.last_name', 'fr', 'Nom'),
('ui', 'profile.email', 'fr', 'E-mail'),
('ui', 'profile.phone', 'fr', 'Téléphone'),
('ui', 'profile.phone_invalid', 'fr', 'Le téléphone doit comporter exactement 10 chiffres'),
('ui', 'profile.notifications', 'fr', 'Préférences de Notification'),
('ui', 'profile.complete_required', 'fr', 'Complétez Votre Profil'),
('ui', 'profile.complete_required_description', 'fr', 'Veuillez compléter les sections requises suivantes avant de continuer.'),
('ui', 'profile.complete_profile', 'fr', 'Compléter le Profil'),
('ui', 'action.dismiss', 'fr', 'Ignorer'),
('ui', 'profile.save_success', 'fr', 'Profil mis à jour avec succès'),
('ui', 'profile.save_error', 'fr', 'Échec de la mise à jour du profil'),
('ui', 'profile.email_readonly', 'fr', 'L''e-mail est géré par votre fournisseur d''identité'),
('ui', 'profile.complete', 'fr', 'Complet'),
('ui', 'profile.required', 'fr', 'Requis'),
('ui', 'profile.not_started', 'fr', 'Non Commencé'),
('ui', 'profile.extensions', 'fr', 'Extensions de Profil'),
('ui', 'profile.view', 'fr', 'Voir'),
('ui', 'profile.missing', 'fr', 'Manquant')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- German
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'profile.title', 'de', 'Mein Profil'),
('ui', 'profile.my_profile', 'de', 'Mein Profil'),
('ui', 'profile.personal_info', 'de', 'Persönliche Informationen'),
('ui', 'profile.first_name', 'de', 'Vorname'),
('ui', 'profile.last_name', 'de', 'Nachname'),
('ui', 'profile.email', 'de', 'E-Mail'),
('ui', 'profile.phone', 'de', 'Telefon'),
('ui', 'profile.phone_invalid', 'de', 'Telefonnummer muss genau 10 Ziffern haben'),
('ui', 'profile.notifications', 'de', 'Benachrichtigungseinstellungen'),
('ui', 'profile.complete_required', 'de', 'Vervollständigen Sie Ihr Profil'),
('ui', 'profile.complete_required_description', 'de', 'Bitte füllen Sie die folgenden erforderlichen Abschnitte aus, bevor Sie fortfahren.'),
('ui', 'profile.complete_profile', 'de', 'Profil Vervollständigen'),
('ui', 'action.dismiss', 'de', 'Verwerfen'),
('ui', 'profile.save_success', 'de', 'Profil erfolgreich aktualisiert'),
('ui', 'profile.save_error', 'de', 'Profil konnte nicht aktualisiert werden'),
('ui', 'profile.email_readonly', 'de', 'E-Mail wird von Ihrem Identitätsanbieter verwaltet'),
('ui', 'profile.complete', 'de', 'Vollständig'),
('ui', 'profile.required', 'de', 'Erforderlich'),
('ui', 'profile.not_started', 'de', 'Nicht Begonnen'),
('ui', 'profile.extensions', 'de', 'Profil-Erweiterungen'),
('ui', 'profile.view', 'de', 'Anzeigen'),
('ui', 'profile.missing', 'de', 'Fehlend')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

COMMIT;
