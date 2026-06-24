-- Revert v0-64-0-add-arabic-translations

BEGIN;

DELETE FROM metadata.translations WHERE locale = 'ar' AND source_type = 'ui';

DROP FUNCTION IF EXISTS public.set_user_locale(TEXT);

COMMIT;
