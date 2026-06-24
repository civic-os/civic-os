-- Revert civic_os:v0-64-1-i18n-expansion

BEGIN;

-- ============================================================================
-- 1. RESTORE upsert_translations() WITH is_admin() GUARD
-- ============================================================================

CREATE OR REPLACE FUNCTION public.upsert_translations(p_translations JSONB)
RETURNS JSONB AS $$
DECLARE
  v_item JSONB;
  v_count INT := 0;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_translations)
  LOOP
    INSERT INTO metadata.translations (source_type, source_key, locale, translated_text)
    VALUES (
      v_item->>'source_type',
      v_item->>'source_key',
      v_item->>'locale',
      v_item->>'translated_text'
    )
    ON CONFLICT (source_type, source_key, locale) DO UPDATE
    SET translated_text = EXCLUDED.translated_text,
        updated_at = NOW();
    v_count := v_count + 1;
  END LOOP;

  RETURN jsonb_build_object('success', true, 'upserted', v_count);
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION public.upsert_translations(JSONB) IS
    'Bulk upsert translations from JSONB array. Admin only. Added in v0.57.0.';


-- ============================================================================
-- 2. RESTORE ORIGINAL RLS POLICIES (is_admin())
-- ============================================================================

DROP POLICY IF EXISTS translations_insert ON metadata.translations;
DROP POLICY IF EXISTS translations_update ON metadata.translations;
DROP POLICY IF EXISTS translations_delete ON metadata.translations;

CREATE POLICY "Admins can insert translations"
  ON metadata.translations
  FOR INSERT TO authenticated
  WITH CHECK (public.is_admin());

CREATE POLICY "Admins can update translations"
  ON metadata.translations
  FOR UPDATE TO authenticated
  USING (public.is_admin());

CREATE POLICY "Admins can delete translations"
  ON metadata.translations
  FOR DELETE TO authenticated
  USING (public.is_admin());


-- ============================================================================
-- 3. REMOVE PERMISSION ROWS AND ROLE ASSIGNMENTS
-- ============================================================================

DELETE FROM metadata.permission_roles
WHERE permission_id IN (
  SELECT id FROM metadata.permissions
  WHERE table_name = 'metadata.translations'
);

DELETE FROM metadata.permissions
WHERE table_name = 'metadata.translations';


-- ============================================================================
-- 4. DELETE TRANSLATION DATA
-- ============================================================================

DELETE FROM metadata.translations WHERE locale = 'ps' AND source_type = 'ui';
DELETE FROM metadata.translations WHERE locale = 'fr' AND source_type = 'ui';
DELETE FROM metadata.translations WHERE locale = 'de' AND source_type = 'ui';

COMMIT;
