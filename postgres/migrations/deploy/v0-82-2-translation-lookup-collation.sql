-- Deploy civic_os:v0-82-2-translation-lookup-collation
-- Requires: v0-82-2-normalize-current-locale
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- v0.82.2 -- metadata.t() looks translations up through the index whatever the caller's collation.
--
-- A PL/pgSQL function's parameters and local variables take the collation of the arguments it is
-- called with. schema_properties passes information_schema names (type sql_identifier, collation "C")
-- to t(), so its lookups compared source_type, source_key and locale under "C". The
-- (source_type, source_key, locale) btree index on metadata.translations uses the database default
-- collation, so the planner could not use it, and every t() call ran a sequential scan of the whole
-- table. With a few thousand translation rows, a non-English schema_properties load took about 2 s
-- of lookups instead of about 0.5 s.
--
-- Fix: compare under COLLATE "default" in both lookups, which matches the index. Equality under the
-- default (deterministic) collation and under "C" are the same, so results do not change.
--
-- Grants: unchanged. CREATE OR REPLACE keeps the function's ACL and comment.
--
-- Framework migration: no schema decision (ADR) is recorded.

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
  WHERE source_type = p_source_type COLLATE "default"
    AND source_key = p_source_key COLLATE "default"
    AND locale = v_locale COLLATE "default";

  IF v_result IS NOT NULL THEN
    RETURN v_result;
  END IF;

  -- Try base language fallback (es-MX -> es)
  v_base_locale := split_part(v_locale, '-', 1);
  IF v_base_locale != v_locale THEN
    SELECT translated_text INTO v_result
    FROM metadata.translations
    WHERE source_type = p_source_type COLLATE "default"
      AND source_key = p_source_key COLLATE "default"
      AND locale = v_base_locale COLLATE "default";

    IF v_result IS NOT NULL THEN
      RETURN v_result;
    END IF;
  END IF;

  -- Final fallback: return default text
  RETURN p_default_text;
END;
$$ LANGUAGE plpgsql STABLE;

COMMIT;
