-- Deploy civic_os:v0-76-0-maintenance-mode
-- Requires: v0-74-0-fix-role-sync-cascade
--
-- v0.76.0 -- Add maintenance mode enforcement in check_jwt with admin bypass
-- and i18n translations for maintenance UI strings.
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- AGPL-3.0-or-later

BEGIN;

-- ============================================================================
-- 1. REPLACE metadata.check_jwt() WITH MAINTENANCE MODE SUPPORT
-- ============================================================================
-- The check_jwt function is PostgREST's pre-request hook. It runs before every
-- API request. We add maintenance mode awareness:
--
-- Modes:
--   'off' (default) — normal operation
--   'readonly'      — authenticated reads allowed, writes (POST/PATCH/PUT/DELETE) blocked
--   'full'          — all requests blocked except admin
--
-- Admin bypass: if metadata.is_admin() returns true, a response header is set
-- and the request proceeds normally.
--
-- IMPORTANT: No SECURITY DEFINER — PG17 blocks SET LOCAL ROLE inside SECURITY
-- DEFINER functions.

CREATE OR REPLACE FUNCTION metadata.check_jwt()
RETURNS VOID AS $$
DECLARE
  v_mode TEXT;
  v_method TEXT;
  v_path TEXT;
BEGIN
  -- Step 1: Set role based on JWT (existing behavior)
  IF current_setting('request.jwt.claims', true)::json->>'sub' IS NOT NULL THEN
    EXECUTE 'SET LOCAL ROLE authenticated';
  ELSE
    EXECUTE 'SET LOCAL ROLE web_anon';
  END IF;

  -- Step 2: Check maintenance mode
  v_mode := coalesce(nullif(current_setting('app.settings.maintenance_mode', true), ''), 'off');

  IF v_mode = 'off' THEN
    RETURN;
  END IF;

  -- Step 3: Admin bypass — let admins through with a header flag
  IF metadata.is_admin() THEN
    PERFORM set_config(
      'response.headers',
      '[{"X-Maintenance-Mode": "' || v_mode || '-admin"}, {"Access-Control-Expose-Headers": "X-Maintenance-Mode"}]',
      true
    );
    RETURN;
  END IF;

  -- Step 4: Full maintenance — block everything
  IF v_mode = 'full' THEN
    RAISE EXCEPTION 'System is undergoing maintenance'
      USING ERRCODE = 'PT503';
  END IF;

  -- Step 5: Read-only maintenance — block write methods
  IF v_mode = 'readonly' THEN
    PERFORM set_config(
      'response.headers',
      '[{"X-Maintenance-Mode": "readonly"}, {"Access-Control-Expose-Headers": "X-Maintenance-Mode"}]',
      true
    );

    v_method := upper(coalesce(current_setting('request.method', true), 'GET'));
    v_path := coalesce(current_setting('request.path', true), '');

    -- Block write methods on table endpoints.
    -- Allow POST to /rpc/* paths: PostgREST RPCs always use POST even for
    -- read-only functions (get_dashboards, get_translations, etc.).
    -- Write RPCs are still protected by their own SECURITY DEFINER/RLS logic.
    IF v_method IN ('POST', 'PATCH', 'PUT', 'DELETE') THEN
      IF v_method = 'POST' AND v_path LIKE '/rpc/%' THEN
        -- Allow RPC calls through in readonly mode
        NULL;
      ELSE
        RAISE EXCEPTION 'System is in read-only maintenance mode'
          USING ERRCODE = 'PT503';
      END IF;
    END IF;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- The public.check_jwt() shim (created in v0-24-0) calls metadata.check_jwt()
-- via PERFORM, so no change is needed there.

DO $$ BEGIN RAISE NOTICE 'Replaced metadata.check_jwt() with maintenance mode support'; END $$;


-- ============================================================================
-- 2. INSERT I18N TRANSLATION KEYS
-- ============================================================================
-- English source keys (source_type='ui') are resolved by the frontend's
-- TranslateService. The five demo locales follow the pattern established
-- in v0-69-0-pwa-translations.

-- ============================================================================
-- ENGLISH (en) — source strings
-- ============================================================================

INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'maintenance.readonly_message', 'en', 'The system is in read-only mode for scheduled maintenance. You can view data but cannot make changes.'),
('ui', 'maintenance.full_message', 'en', 'The system is temporarily unavailable for scheduled maintenance. Please check back shortly.'),
('ui', 'maintenance.full_title', 'en', 'System Maintenance'),
('ui', 'maintenance.admin_bypass', 'en', 'Admin access active — system is in maintenance mode'),
('ui', 'maintenance.write_blocked', 'en', 'Changes are not allowed during maintenance')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- SPANISH (es)
-- ============================================================================

INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'maintenance.readonly_message', 'es', 'El sistema está en modo de solo lectura por mantenimiento programado. Puede ver los datos pero no realizar cambios.'),
('ui', 'maintenance.full_message', 'es', 'El sistema no está disponible temporalmente por mantenimiento programado. Por favor, vuelva a intentarlo en breve.'),
('ui', 'maintenance.full_title', 'es', 'Mantenimiento del sistema'),
('ui', 'maintenance.admin_bypass', 'es', 'Acceso de administrador activo — el sistema está en modo de mantenimiento'),
('ui', 'maintenance.write_blocked', 'es', 'No se permiten cambios durante el mantenimiento')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- ARABIC (ar)
-- ============================================================================

INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'maintenance.readonly_message', 'ar', 'النظام في وضع القراءة فقط للصيانة المجدولة. يمكنك عرض البيانات ولكن لا يمكنك إجراء تغييرات.'),
('ui', 'maintenance.full_message', 'ar', 'النظام غير متاح مؤقتًا للصيانة المجدولة. يرجى المحاولة مرة أخرى قريبًا.'),
('ui', 'maintenance.full_title', 'ar', 'صيانة النظام'),
('ui', 'maintenance.admin_bypass', 'ar', 'وصول المسؤول نشط — النظام في وضع الصيانة'),
('ui', 'maintenance.write_blocked', 'ar', 'لا يُسمح بإجراء تغييرات أثناء الصيانة')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- FRENCH (fr)
-- ============================================================================

INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'maintenance.readonly_message', 'fr', 'Le système est en mode lecture seule pour une maintenance planifiée. Vous pouvez consulter les données mais ne pouvez pas effectuer de modifications.'),
('ui', 'maintenance.full_message', 'fr', 'Le système est temporairement indisponible pour une maintenance planifiée. Veuillez réessayer sous peu.'),
('ui', 'maintenance.full_title', 'fr', 'Maintenance du système'),
('ui', 'maintenance.admin_bypass', 'fr', 'Accès administrateur actif — le système est en mode maintenance'),
('ui', 'maintenance.write_blocked', 'fr', 'Les modifications ne sont pas autorisées pendant la maintenance')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- GERMAN (de)
-- ============================================================================

INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'maintenance.readonly_message', 'de', 'Das System befindet sich im Nur-Lese-Modus für geplante Wartungsarbeiten. Sie können Daten einsehen, aber keine Änderungen vornehmen.'),
('ui', 'maintenance.full_message', 'de', 'Das System ist vorübergehend wegen geplanter Wartungsarbeiten nicht verfügbar. Bitte versuchen Sie es in Kürze erneut.'),
('ui', 'maintenance.full_title', 'de', 'Systemwartung'),
('ui', 'maintenance.admin_bypass', 'de', 'Administratorzugang aktiv — System befindet sich im Wartungsmodus'),
('ui', 'maintenance.write_blocked', 'de', 'Änderungen sind während der Wartung nicht erlaubt')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- PASHTO (ps)
-- ============================================================================

INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'maintenance.readonly_message', 'ps', 'سیستم د پلان شوي ساتنې لپاره د یوازې لوستلو حالت کې دی. تاسو کولی شئ معلومات وګورئ مګر بدلونونه نشئ کولی.'),
('ui', 'maintenance.full_message', 'ps', 'سیستم د پلان شوي ساتنې لپاره په لنډمهاله توګه شتون نلري. مهرباني وکړئ لږ وروسته بیا هڅه وکړئ.'),
('ui', 'maintenance.full_title', 'ps', 'د سیستم ساتنه'),
('ui', 'maintenance.admin_bypass', 'ps', 'د مدیر لاسرسی فعال دی — سیستم د ساتنې حالت کې دی'),
('ui', 'maintenance.write_blocked', 'ps', 'د ساتنې پر مهال بدلونونو ته اجازه نشته')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

DO $$ BEGIN RAISE NOTICE 'Inserted maintenance mode i18n translations for en/es/ar/fr/de/ps'; END $$;


-- ============================================================================
-- 3. NOTIFY POSTGREST
-- ============================================================================

NOTIFY pgrst, 'reload schema';

COMMIT;
