-- Revert civic_os:v0-82-2-translation-lookup-collation
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- Restores the v0.57.0 body of metadata.t(), whose lookups take the caller's collation.

BEGIN;

CREATE OR REPLACE FUNCTION metadata.t(
  p_source_type TEXT, p_source_key TEXT, p_default_text TEXT
) RETURNS TEXT AS $$
DECLARE
  v_locale TEXT;
  v_result TEXT;
  v_base_locale TEXT;
BEGIN
  v_locale := metadata.current_locale();

  -- Short-circuit for English (default) - zero overhead
  IF v_locale = 'en' OR v_locale IS NULL THEN
    RETURN p_default_text;
  END IF;

  -- Try exact locale match
  SELECT translated_text INTO v_result
  FROM metadata.translations
  WHERE source_type = p_source_type
    AND source_key = p_source_key
    AND locale = v_locale;

  IF v_result IS NOT NULL THEN
    RETURN v_result;
  END IF;

  -- Try base language fallback (es-MX -> es)
  v_base_locale := split_part(v_locale, '-', 1);
  IF v_base_locale != v_locale THEN
    SELECT translated_text INTO v_result
    FROM metadata.translations
    WHERE source_type = p_source_type
      AND source_key = p_source_key
      AND locale = v_base_locale;

    IF v_result IS NOT NULL THEN
      RETURN v_result;
    END IF;
  END IF;

  -- Final fallback: return default text
  RETURN p_default_text;
END;
$$ LANGUAGE plpgsql STABLE;

COMMIT;
