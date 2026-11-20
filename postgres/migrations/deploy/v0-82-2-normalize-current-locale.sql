-- Deploy civic_os:v0-82-2-normalize-current-locale
-- Requires: v0-82-1-dashboard-selector-translations
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- v0.82.2 -- metadata.current_locale() returns one normalized language tag instead of the raw
-- Accept-Language header.
--
-- The app sends no Accept-Language header when its locale is English, so the browser's own header
-- reaches PostgREST (for example `en-US,en;q=0.9`). current_locale() returned that string as is, which
-- missed the `v_locale = 'en'` short-circuit in metadata.t() and translate_widget_config(): every
-- translatable column then ran two translations lookups that could never match (the whole header, then
-- `en` for a non-ui source type). Loading schema_properties took about 6 s instead of 0.5 s.
--
-- Normalization: first language range only, quality value dropped, `_` read as `-`; `en` and any
-- `en-*` become `en`; anything that is not a language tag (`*`, empty, junk) becomes `en`. Other tags
-- keep their subtags with conventional casing (language lowercase, 2-letter region uppercase, 4-letter
-- script title case), because metadata.translations.locale stores tags such as `es-MX` and t() compares
-- them case-sensitively; t() still falls back from `es-MX` to `es`.
--
-- Grants: unchanged. CREATE OR REPLACE keeps the function's ACL, and web_anon needs EXECUTE (t() runs
-- inside anonymously readable views).
--
-- Framework migration: no schema decision (ADR) is recorded.

BEGIN;

CREATE OR REPLACE FUNCTION metadata.current_locale()
RETURNS TEXT AS $$
DECLARE
  v_header TEXT;
  v_tag TEXT;
  v_parts TEXT[];
  v_result TEXT;
  v_i INT;
BEGIN
  v_header := COALESCE(
    -- PostgREST 13+: headers as JSON blob. A session that has used the GUC before reads '' here, not NULL.
    NULLIF(NULLIF(current_setting('request.headers', true), '')::json->>'accept-language', ''),
    -- Legacy fallback (PostgREST < 12 with db-use-legacy-gucs)
    NULLIF(current_setting('request.header.accept-language', true), '')
  );

  IF v_header IS NULL THEN
    RETURN 'en';
  END IF;

  -- First language range, without its quality value
  v_tag := replace(btrim(split_part(split_part(v_header, ',', 1), ';', 1)), '_', '-');

  -- Not a language tag ('*', empty, anything else): the default locale
  IF v_tag !~ '^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$' THEN
    RETURN 'en';
  END IF;

  v_parts := string_to_array(v_tag, '-');
  v_result := lower(v_parts[1]);

  -- Every English variant takes the English short-circuit in metadata.t()
  IF v_result = 'en' THEN
    RETURN 'en';
  END IF;

  FOR v_i IN 2..array_length(v_parts, 1) LOOP
    v_result := v_result || '-' || CASE
      WHEN v_parts[v_i] ~ '^[A-Za-z]{2}$' THEN upper(v_parts[v_i])    -- region: MX
      WHEN v_parts[v_i] ~ '^[A-Za-z]{4}$' THEN initcap(v_parts[v_i])  -- script: Hant
      ELSE lower(v_parts[v_i])                                         -- numeric region (419), variants
    END;
  END LOOP;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION metadata.current_locale() IS
    'Returns the request locale as one language tag, defaulting to en: the first Accept-Language range '
    'without its quality value, with every en-* variant as en and conventional subtag casing (es-MX). '
    'Reads the PostgREST 13 JSON headers blob, then the legacy GUC. Normalized in v0.82.2.';

COMMIT;
