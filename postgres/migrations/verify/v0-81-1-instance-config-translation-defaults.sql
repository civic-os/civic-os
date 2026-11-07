-- Verify civic_os:v0-81-1-instance-config-translation-defaults
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.get_translation_defaults() WHERE source_type = 'instance_config') THEN
    RAISE EXCEPTION 'get_translation_defaults() returns no instance_config rows';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.get_translation_defaults() WHERE source_type = 'instance_config_group') THEN
    RAISE EXCEPTION 'get_translation_defaults() returns no instance_config_group rows';
  END IF;
END $$;
