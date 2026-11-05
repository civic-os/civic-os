-- Deploy civic_os:v0-80-2-admin-user-management-escape-valve
-- Requires: v0-80-0-widget-key-filters
--
-- v0.80.2 -- User management always admits is_admin() (issue #50).
--
-- has_permission() has no admin bypass, so revoking a civic_os_users_private permission from the
-- `user` role (or removing it from admin) locked admins out of User Management. The role RPCs
-- already admit is_admin(); this adds `OR is_admin()` to the user management guards. Only the
-- guards change. SECURITY DEFINER, search_path and grants are unchanged.

BEGIN;

-- public.create_provisioned_user (guard body copied from v0-43-1-resolve-role-key.sql:68)
CREATE OR REPLACE FUNCTION public.create_provisioned_user(
    p_email TEXT,
    p_first_name TEXT,
    p_last_name TEXT,
    p_phone TEXT DEFAULT NULL,
    p_initial_roles TEXT[] DEFAULT ARRAY['user'],
    p_send_welcome_email BOOLEAN DEFAULT true,
    p_send_welcome_sms BOOLEAN DEFAULT false
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = metadata, public
AS $$
DECLARE
    v_input_role TEXT;
    v_role_name TEXT;
    v_provision_id BIGINT;
    v_initial_roles TEXT[];
    v_resolved_roles TEXT[] := ARRAY[]::TEXT[];
BEGIN
    IF NOT (metadata.has_permission('civic_os_users_private', 'create') OR public.is_admin()) THEN
        RETURN json_build_object('success', false, 'error', 'Permission denied');
    END IF;

    v_initial_roles := COALESCE(p_initial_roles, ARRAY['user']);
    IF array_length(v_initial_roles, 1) IS NULL THEN
        v_initial_roles := ARRAY['user'];
    END IF;

    -- Validate and resolve each role (accept role_key or display_name)
    FOREACH v_input_role IN ARRAY v_initial_roles LOOP
        v_role_name := resolve_role_key(v_input_role);
        IF v_role_name IS NULL THEN
            RETURN json_build_object('success', false, 'error', format('Role "%s" does not exist', v_input_role));
        END IF;

        IF NOT can_manage_role(v_role_name) THEN
            RETURN json_build_object('success', false, 'error', format('Your role cannot assign the "%s" role', v_input_role));
        END IF;

        v_resolved_roles := array_append(v_resolved_roles, v_role_name);
    END LOOP;

    INSERT INTO metadata.user_provisioning (
        email, first_name, last_name, phone,
        initial_roles, send_welcome_email, send_welcome_sms,
        status, requested_by
    ) VALUES (
        p_email::email_address,
        p_first_name,
        p_last_name,
        p_phone::phone_number,
        v_resolved_roles,
        COALESCE(p_send_welcome_email, true),
        COALESCE(p_send_welcome_sms, false),
        'pending',
        current_user_id()
    )
    RETURNING id INTO v_provision_id;

    INSERT INTO metadata.river_job (kind, args, queue, priority, max_attempts, scheduled_at, state)
    VALUES (
        'provision_keycloak_user',
        jsonb_build_object('provision_id', v_provision_id),
        'user_provisioning',
        1,
        5,
        NOW(),
        'available'
    );

    RETURN json_build_object('success', true, 'provision_id', v_provision_id);
END;
$$;

-- public.bulk_provision_users (guard body copied from v0-43-1-resolve-role-key.sql:148)
CREATE OR REPLACE FUNCTION public.bulk_provision_users(
    p_users JSON
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = metadata, public
AS $$
DECLARE
    v_user JSON;
    v_index INT := 0;
    v_created_count INT := 0;
    v_error_count INT := 0;
    v_errors JSON[] := ARRAY[]::JSON[];
    v_input_role TEXT;
    v_role_name TEXT;
    v_initial_roles TEXT[];
    v_resolved_roles TEXT[];
    v_provision_id BIGINT;
    v_email TEXT;
    v_first_name TEXT;
    v_last_name TEXT;
    v_phone TEXT;
    v_send_welcome_email BOOLEAN;
    v_send_welcome_sms BOOLEAN;
BEGIN
    IF NOT (metadata.has_permission('civic_os_users_private', 'create') OR public.is_admin()) THEN
        RETURN json_build_object('success', false, 'error', 'Permission denied');
    END IF;

    FOR v_user IN SELECT * FROM json_array_elements(p_users)
    LOOP
        v_index := v_index + 1;
        v_email := v_user->>'email';
        v_first_name := v_user->>'first_name';
        v_last_name := v_user->>'last_name';
        v_phone := v_user->>'phone';
        v_send_welcome_email := COALESCE((v_user->>'send_welcome_email')::BOOLEAN, true);
        v_send_welcome_sms := COALESCE((v_user->>'send_welcome_sms')::BOOLEAN, false);

        IF v_user->'initial_roles' IS NOT NULL AND v_user->>'initial_roles' != 'null' THEN
            SELECT array_agg(r::TEXT) INTO v_initial_roles
            FROM json_array_elements_text(v_user->'initial_roles') r;
        ELSE
            v_initial_roles := ARRAY['user'];
        END IF;

        IF array_length(v_initial_roles, 1) IS NULL THEN
            v_initial_roles := ARRAY['user'];
        END IF;

        BEGIN
            -- Validate and resolve roles (accept role_key or display_name)
            v_resolved_roles := ARRAY[]::TEXT[];
            FOREACH v_input_role IN ARRAY v_initial_roles LOOP
                v_role_name := resolve_role_key(v_input_role);
                IF v_role_name IS NULL THEN
                    RAISE EXCEPTION 'Role "%" does not exist', v_input_role;
                END IF;
                IF NOT can_manage_role(v_role_name) THEN
                    RAISE EXCEPTION 'Your role cannot assign the "%" role', v_input_role;
                END IF;
                v_resolved_roles := array_append(v_resolved_roles, v_role_name);
            END LOOP;

            INSERT INTO metadata.user_provisioning (
                email, first_name, last_name, phone,
                initial_roles, send_welcome_email, send_welcome_sms,
                status, requested_by
            ) VALUES (
                v_email::email_address,
                v_first_name,
                v_last_name,
                v_phone::phone_number,
                v_resolved_roles,
                v_send_welcome_email,
                v_send_welcome_sms,
                'pending',
                current_user_id()
            )
            RETURNING id INTO v_provision_id;

            INSERT INTO metadata.river_job (kind, args, queue, priority, max_attempts, scheduled_at, state)
            VALUES (
                'provision_keycloak_user',
                jsonb_build_object('provision_id', v_provision_id),
                'user_provisioning',
                1,
                5,
                NOW(),
                'available'
            );

            v_created_count := v_created_count + 1;
        EXCEPTION WHEN OTHERS THEN
            v_error_count := v_error_count + 1;
            v_errors := array_append(v_errors, json_build_object(
                'index', v_index,
                'email', v_email,
                'error', SQLERRM
            ));
        END;
    END LOOP;

    RETURN json_build_object(
        'success', v_error_count = 0,
        'created_count', v_created_count,
        'error_count', v_error_count,
        'errors', COALESCE(array_to_json(v_errors), '[]'::JSON)
    );
END;
$$;

-- public.update_user_info (guard body copied from v0-65-0-cup-phone-domain.sql:526)
CREATE OR REPLACE FUNCTION public.update_user_info(
  p_user_id UUID,
  p_first_name TEXT,
  p_last_name TEXT,
  p_phone TEXT DEFAULT NULL
)
RETURNS JSON AS $$
DECLARE
  v_full_name TEXT;
  v_public_display TEXT;
  v_phone TEXT;
  v_email TEXT;
BEGIN
  -- Permission check: must have civic_os_users_private:update permission
  IF NOT (public.has_permission('civic_os_users_private', 'update') OR public.is_admin()) THEN
    RETURN json_build_object('success', false, 'error', 'Permission denied');
  END IF;

  -- Validate required fields
  IF TRIM(COALESCE(p_first_name, '')) = '' OR TRIM(COALESCE(p_last_name, '')) = '' THEN
    RETURN json_build_object('success', false, 'error', 'First name and last name are required');
  END IF;

  -- Verify user exists
  IF NOT EXISTS (SELECT 1 FROM metadata.civic_os_users WHERE id = p_user_id) THEN
    RETURN json_build_object('success', false, 'error', 'User not found');
  END IF;

  -- Sanitize phone input
  IF TRIM(COALESCE(p_phone, '')) = '' THEN
    v_phone := NULL;
  ELSE
    v_phone := regexp_replace(p_phone, '[^0-9]', '', 'g');
    IF length(v_phone) = 11 AND v_phone LIKE '1%' THEN
      v_phone := substring(v_phone FROM 2);
    END IF;
    IF v_phone !~ '^\d{10}$' THEN
      RETURN json_build_object('success', false, 'error', 'Phone must be a valid 10-digit US number');
    END IF;
  END IF;

  -- Build full name and public display name
  v_full_name := TRIM(p_first_name) || ' ' || TRIM(p_last_name);
  v_public_display := public.format_public_display_name(v_full_name);

  -- Update civic_os_users (public profile)
  UPDATE metadata.civic_os_users
  SET display_name = v_public_display,
      updated_at = NOW()
  WHERE id = p_user_id;

  -- Update civic_os_users_private (private profile)
  UPDATE metadata.civic_os_users_private
  SET display_name = v_full_name,
      first_name = TRIM(p_first_name),
      last_name = TRIM(p_last_name),
      phone = v_phone,
      updated_at = NOW()
  WHERE id = p_user_id;

  -- Fetch current email for Keycloak sync (v0.47.1 pattern: Keycloak PUT
  -- treats missing fields as null, so email must be included in args)
  SELECT email INTO v_email
  FROM metadata.civic_os_users_private
  WHERE id = p_user_id;

  -- Enqueue River job for async Keycloak sync (phone excluded — database is authority)
  INSERT INTO metadata.river_job (args, kind, queue, state, priority, max_attempts)
  VALUES (
    json_build_object(
      'user_id', p_user_id::TEXT,
      'email', COALESCE(v_email::TEXT, ''),
      'first_name', TRIM(p_first_name),
      'last_name', TRIM(p_last_name)
    )::JSONB,
    'update_keycloak_user',
    'user_provisioning',
    'available',
    1,
    5
  );

  RETURN json_build_object('success', true, 'message', 'User info updated');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- public.retry_user_provisioning (guard body copied from v0-31-0-user-provisioning.sql:934)
CREATE OR REPLACE FUNCTION public.retry_user_provisioning(
    p_provision_id BIGINT
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = metadata, public
AS $$
DECLARE
    v_status TEXT;
BEGIN
    -- Permission check
    IF NOT (metadata.has_permission('civic_os_users_private', 'update') OR public.is_admin()) THEN
        RETURN json_build_object('success', false, 'error', 'Permission denied');
    END IF;

    -- Validate record exists and is in failed state
    SELECT status INTO v_status
    FROM metadata.user_provisioning
    WHERE id = p_provision_id;

    IF v_status IS NULL THEN
        RETURN json_build_object('success', false, 'error', 'Provisioning record not found');
    END IF;

    IF v_status != 'failed' THEN
        RETURN json_build_object('success', false, 'error', 'Only failed requests can be retried');
    END IF;

    -- Reset to pending and clear error
    UPDATE metadata.user_provisioning
    SET status = 'pending',
        error_message = NULL
    WHERE id = p_provision_id;

    -- Re-enqueue River job
    INSERT INTO metadata.river_job (kind, args, queue, priority, max_attempts, scheduled_at, state)
    VALUES (
        'provision_keycloak_user',
        jsonb_build_object('provision_id', p_provision_id),
        'user_provisioning',
        1,
        5,
        NOW(),
        'available'
    );

    RETURN json_build_object('success', true);
END;
$$;

-- admin_get_user_notification_preferences (guard body copied from v0-38-4-fix-admin-notif-pref-permission.sql:10)
CREATE OR REPLACE FUNCTION admin_get_user_notification_preferences(p_user_id UUID)
RETURNS TABLE(
    channel TEXT,
    enabled BOOLEAN,
    email_address TEXT,
    phone_number TEXT,
    sms_opted_out BOOLEAN,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ
)
SECURITY DEFINER
SET search_path = metadata, public
LANGUAGE plpgsql
AS $$
BEGIN
    -- Permission check: civic_os_users_private:update (admin-only, matches write RPC)
    IF NOT (public.has_permission('civic_os_users_private', 'update') OR public.is_admin()) THEN
        RAISE EXCEPTION 'Permission denied: civic_os_users_private:update required';
    END IF;

    RETURN QUERY
    SELECT
        np.channel::TEXT,
        np.enabled,
        np.email_address::TEXT,
        np.phone_number::TEXT,
        np.sms_opted_out,
        np.created_at,
        np.updated_at
    FROM metadata.notification_preferences np
    WHERE np.user_id = p_user_id
    ORDER BY np.channel;
END;
$$;

-- admin_update_notification_preference (guard body copied from v0-35-0-admin-notification-prefs.sql:167)
CREATE OR REPLACE FUNCTION admin_update_notification_preference(
    p_user_id UUID,
    p_channel TEXT,
    p_enabled BOOLEAN,
    p_clear_opted_out BOOLEAN DEFAULT false
)
RETURNS JSON
SECURITY DEFINER
SET search_path = metadata, public
LANGUAGE plpgsql
AS $$
DECLARE
    v_rows_updated INTEGER;
BEGIN
    -- Permission check: reuse civic_os_users_private:update (same as update_user_info)
    IF NOT (public.has_permission('civic_os_users_private', 'update') OR public.is_admin()) THEN
        RETURN json_build_object('success', false, 'error', 'Permission denied');
    END IF;

    UPDATE metadata.notification_preferences
    SET enabled = p_enabled,
        sms_opted_out = CASE
            WHEN p_clear_opted_out AND p_channel = 'sms' THEN false
            ELSE sms_opted_out
        END,
        updated_at = NOW()
    WHERE user_id = p_user_id AND channel = p_channel;

    GET DIAGNOSTICS v_rows_updated = ROW_COUNT;

    IF v_rows_updated = 0 THEN
        RETURN json_build_object('success', false, 'error',
            'No preference found for user ' || p_user_id || ' channel ' || p_channel);
    END IF;

    RETURN json_build_object('success', true);
END;
$$;

-- "User managers see all roles" (policy from v0-31-0-user-provisioning)
DROP POLICY IF EXISTS "User managers see all roles" ON metadata.user_roles;
CREATE POLICY "User managers see all roles" ON metadata.user_roles
  FOR SELECT
  USING (metadata.has_permission('civic_os_users_private', 'read') OR public.is_admin());

-- Re-assert grants (CREATE OR REPLACE keeps them; stated for clarity)
GRANT EXECUTE ON FUNCTION public.create_provisioned_user(TEXT, TEXT, TEXT, TEXT, TEXT[], BOOLEAN, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bulk_provision_users(JSON) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_user_info(UUID, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.retry_user_provisioning(BIGINT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_get_user_notification_preferences(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_update_notification_preference(UUID, TEXT, BOOLEAN, BOOLEAN) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.create_provisioned_user(TEXT, TEXT, TEXT, TEXT, TEXT[], BOOLEAN, BOOLEAN) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.bulk_provision_users(JSON) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.update_user_info(UUID, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.retry_user_provisioning(BIGINT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.admin_get_user_notification_preferences(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.admin_update_notification_preference(UUID, TEXT, BOOLEAN, BOOLEAN) FROM PUBLIC;

-- Translations for the revoke-from-user warning on the Permissions page (ui strings only)
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'a11y.permissions_revoke_admin_warning', 'en', 'Confirm revoking a permission that admins will also lose'),
('ui', 'a11y.permissions_revoke_admin_warning', 'es', 'Confirmar la revocación de un permiso que los administradores también perderán'),
('ui', 'a11y.permissions_revoke_admin_warning', 'ar', 'تأكيد سحب صلاحية سيفقدها المسؤولون أيضًا'),
('ui', 'a11y.permissions_revoke_admin_warning', 'fr', 'Confirmer la révocation d''une permission que les administrateurs perdront aussi'),
('ui', 'a11y.permissions_revoke_admin_warning', 'de', 'Entzug einer Berechtigung bestätigen, die auch Administratoren verlieren'),
('ui', 'a11y.permissions_revoke_admin_warning', 'ps', 'د هغه اجازې لغوه کول تایید کړئ چې مدیران به یې هم له لاسه ورکړي'),
('ui', 'permissions.revoke_admin_title', 'en', 'Admins will also lose this permission'),
('ui', 'permissions.revoke_admin_title', 'es', 'Los administradores también perderán este permiso'),
('ui', 'permissions.revoke_admin_title', 'ar', 'سيفقد المسؤولون هذه الصلاحية أيضًا'),
('ui', 'permissions.revoke_admin_title', 'fr', 'Les administrateurs perdront aussi cette permission'),
('ui', 'permissions.revoke_admin_title', 'de', 'Administratoren verlieren diese Berechtigung ebenfalls'),
('ui', 'permissions.revoke_admin_title', 'ps', 'مدیران به دا اجازه هم له لاسه ورکړي'),
('ui', 'permissions.revoke_admin_body', 'en', 'The admin role does not inherit permissions from the user role, and it does not hold {{permission}} on {{table}} directly. Revoking it from the user role will also remove it from admins, who may then see empty results. Grant it to the admin role first if admins should keep it.'),
('ui', 'permissions.revoke_admin_body', 'es', 'El rol de administrador no hereda permisos del rol de usuario y no tiene {{permission}} en {{table}} de forma directa. Revocarlo del rol de usuario también lo quitará a los administradores, que podrían ver resultados vacíos. Otórguelo primero al rol de administrador si los administradores deben conservarlo.'),
('ui', 'permissions.revoke_admin_body', 'ar', 'لا يرث دور المسؤول الصلاحيات من دور المستخدم، ولا يملك {{permission}} على {{table}} بشكل مباشر. سيؤدي سحبها من دور المستخدم إلى إزالتها من المسؤولين أيضًا، وقد يرون نتائج فارغة. امنحها لدور المسؤول أولًا إذا كان يجب أن يحتفظ بها المسؤولون.'),
('ui', 'permissions.revoke_admin_body', 'fr', 'Le rôle administrateur nhérite pas des permissions du rôle utilisateur et ne détient pas directement {{permission}} sur {{table}}. La révoquer du rôle utilisateur la retirera aussi aux administrateurs, qui pourraient alors voir des résultats vides. Accordez-la dabord au rôle administrateur si les administrateurs doivent la conserver.'),
('ui', 'permissions.revoke_admin_body', 'de', 'Die Administratorrolle erbt keine Berechtigungen von der Benutzerrolle und besitzt {{permission}} für {{table}} nicht direkt. Wird sie der Benutzerrolle entzogen, verlieren sie auch die Administratoren und sehen möglicherweise leere Ergebnisse. Erteilen Sie sie zuerst der Administratorrolle, wenn Administratoren sie behalten sollen.'),
('ui', 'permissions.revoke_admin_body', 'ps', 'د مدیر رول له کارن رول څخه اجازې نه میراثي کوي، او پخپله د {{table}} لپاره {{permission}} نه لري. که دا د کارن له رول څخه لغوه شي، له مدیرانو څخه به هم لیرې شي، او ښایي خالي پایلې وګوري. که مدیران باید دا وساتي، لومړی یې د مدیر رول ته ورکړئ.'),
('ui', 'permissions.revoke_admin_confirm', 'en', 'Revoke anyway'),
('ui', 'permissions.revoke_admin_confirm', 'es', 'Revocar de todos modos'),
('ui', 'permissions.revoke_admin_confirm', 'ar', 'سحب على أي حال'),
('ui', 'permissions.revoke_admin_confirm', 'fr', 'Révoquer quand même'),
('ui', 'permissions.revoke_admin_confirm', 'de', 'Trotzdem entziehen'),
('ui', 'permissions.revoke_admin_confirm', 'ps', 'بیا هم لغوه کړئ'),
('ui', 'permissions.revoke_admin_cancel', 'en', 'Cancel'),
('ui', 'permissions.revoke_admin_cancel', 'es', 'Cancelar'),
('ui', 'permissions.revoke_admin_cancel', 'ar', 'إلغاء'),
('ui', 'permissions.revoke_admin_cancel', 'fr', 'Annuler'),
('ui', 'permissions.revoke_admin_cancel', 'de', 'Abbrechen'),
('ui', 'permissions.revoke_admin_cancel', 'ps', 'لغوه کړئ'),
('ui', 'permissions.update_failed', 'en', 'Could not update the permission. Please try again.'),
('ui', 'permissions.update_failed', 'es', 'No se pudo actualizar el permiso. Inténtelo de nuevo.'),
('ui', 'permissions.update_failed', 'ar', 'تعذّر تحديث الصلاحية. يرجى المحاولة مرة أخرى.'),
('ui', 'permissions.update_failed', 'fr', 'Impossible de mettre à jour la permission. Veuillez réessayer.'),
('ui', 'permissions.update_failed', 'de', 'Die Berechtigung konnte nicht aktualisiert werden. Bitte versuchen Sie es erneut.'),
('ui', 'permissions.update_failed', 'ps', 'اجازه نه شوه تازه کیدای. مهرباني وکړئ بیا هڅه وکړئ.'),
('ui', 'permissions.dismiss', 'en', 'Dismiss'),
('ui', 'permissions.dismiss', 'es', 'Descartar'),
('ui', 'permissions.dismiss', 'ar', 'إغلاق'),
('ui', 'permissions.dismiss', 'fr', 'Fermer'),
('ui', 'permissions.dismiss', 'de', 'Schließen'),
('ui', 'permissions.dismiss', 'ps', 'بندول')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

NOTIFY pgrst, 'reload schema';

COMMIT;
