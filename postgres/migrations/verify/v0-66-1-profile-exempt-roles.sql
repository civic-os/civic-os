-- Verify civic_os:v0-66-1-profile-exempt-roles on pg

-- 1. Column exists on config table
SELECT exempt_roles FROM metadata.user_profile_extensions WHERE FALSE;

-- 2. VIEW exposes both exempt_roles and computed is_required
SELECT table_name, is_required, exempt_roles
FROM public.user_profile_extensions WHERE FALSE;
