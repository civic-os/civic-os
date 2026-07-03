-- Revert civic_os:v0-65-0-user-profile-extensions

BEGIN;

-- Drop PostgREST VIEW
DROP VIEW IF EXISTS public.user_profile_extensions;

-- Drop RPCs
DROP FUNCTION IF EXISTS public.get_user_profile_extensions_admin(UUID);
DROP FUNCTION IF EXISTS public.get_user_profile_extensions();
DROP FUNCTION IF EXISTS public.update_own_profile(TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.get_own_profile();

-- Drop config table (CASCADE removes RLS policies, triggers, constraints)
DROP TABLE IF EXISTS metadata.user_profile_extensions CASCADE;

-- Remove translations
DELETE FROM metadata.translations
WHERE source_type = 'ui' AND source_key LIKE 'profile.%';

COMMIT;
