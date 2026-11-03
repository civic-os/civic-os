-- Verify civic_os:v0-80-2-admin-user-management-escape-valve

DO $$
DECLARE
  v_sig TEXT;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'public.create_provisioned_user(text, text, text, text, text[], boolean, boolean)',
    'public.bulk_provision_users(json)',
    'public.update_user_info(uuid, text, text, text)',
    'public.retry_user_provisioning(bigint)',
    'public.admin_get_user_notification_preferences(uuid)',
    'public.admin_update_notification_preference(uuid, text, boolean, boolean)'
  ] LOOP
    IF pg_get_functiondef(v_sig::regprocedure) NOT LIKE '%is_admin()%' THEN
      RAISE EXCEPTION '% does not admit is_admin()', v_sig;
    END IF;
    IF has_function_privilege('public', v_sig::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION '% is executable by PUBLIC', v_sig;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'metadata' AND tablename = 'user_roles'
      AND policyname = 'User managers see all roles'
      AND qual LIKE '%is_admin()%'
  ) THEN
    RAISE EXCEPTION 'user_roles policy does not admit is_admin()';
  END IF;
  FOREACH v_sig IN ARRAY ARRAY[
    'a11y.permissions_revoke_admin_warning',
    'permissions.revoke_admin_title',
    'permissions.revoke_admin_body',
    'permissions.revoke_admin_confirm',
    'permissions.revoke_admin_cancel',
    'permissions.update_failed',
    'permissions.dismiss'
  ] LOOP
    IF (SELECT count(DISTINCT locale) FROM metadata.translations
        WHERE source_type = 'ui' AND source_key = v_sig
          AND locale IN ('en', 'es', 'ar', 'fr', 'de', 'ps')) < 6 THEN
      RAISE EXCEPTION '% is not translated in all six locales', v_sig;
    END IF;
  END LOOP;
END $$;
