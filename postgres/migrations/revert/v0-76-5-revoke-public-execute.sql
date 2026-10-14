-- Revert civic_os:v0-76-5-revoke-public-execute from pg
--
-- Restores PUBLIC EXECUTE on all functions, reverts _is_db_admin() to
-- current_user, and removes authorization guards from function bodies.
-- NOTE: This re-opens the security vulnerabilities fixed by the deploy.

BEGIN;

-- Remove the ALTER DEFAULT PRIVILEGES restriction.
-- Uses current_user so the revert works for managed-database admin roles
-- (doadmin, rdsadmin) that cannot ALTER DEFAULT PRIVILEGES FOR ROLE postgres.
DO $$
BEGIN
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I GRANT EXECUTE ON FUNCTIONS TO PUBLIC',
    current_user
  );
END;
$$;

-- Restore PUBLIC EXECUTE on all non-extension public functions
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN
        SELECT p.oid::regprocedure::text AS sig
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND NOT EXISTS (
              SELECT 1 FROM pg_depend d
              WHERE d.objid = p.oid AND d.classid = 'pg_proc'::regclass AND d.deptype = 'e'
          )
    LOOP
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO PUBLIC', r.sig);
    END LOOP;
END;
$$;

-- Restore web_anon on functions that had it
GRANT EXECUTE ON FUNCTION has_role(uuid, text) TO web_anon;

-- Revert _is_db_admin() to current_user (the broken version)
CREATE OR REPLACE FUNCTION metadata._is_db_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  SELECT public.is_admin()
    OR current_setting('is_superuser', true) = 'on'
    OR EXISTS (
        SELECT 1 FROM pg_roles
        WHERE rolname = current_user AND rolcreaterole
    );
$function$;

-- Revert request_upload_url (remove auth guard)
CREATE OR REPLACE FUNCTION request_upload_url(
  p_entity_type text,
  p_entity_id text,
  p_file_name text,
  p_file_type text
) RETURNS uuid AS $$
DECLARE
  v_request_id UUID;
BEGIN
  INSERT INTO metadata.file_upload_requests (entity_type, entity_id, file_name, file_type)
  VALUES (p_entity_type, p_entity_id, p_file_name, p_file_type)
  RETURNING id INTO v_request_id;

  PERFORM pg_notify(
    'upload_url_request',
    json_build_object(
      'requestId', v_request_id,
      'fileName', p_file_name,
      'fileType', p_file_type,
      'entityType', p_entity_type,
      'entityId', p_entity_id
    )::text
  );

  RETURN v_request_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Revert get_upload_url (remove auth guard)
CREATE OR REPLACE FUNCTION get_upload_url(p_request_id uuid)
RETURNS TABLE(status text, url text, file_id uuid, error text) AS $$
  SELECT status, presigned_url, file_id, error_message
  FROM metadata.file_upload_requests
  WHERE id = p_request_id;
$$ LANGUAGE SQL SECURITY DEFINER;

-- Revert admin_get_user_bulk_subscriptions (remove permission guard)
CREATE OR REPLACE FUNCTION admin_get_user_bulk_subscriptions(p_user_id uuid)
 RETURNS TABLE(template_name character varying, template_description text, unsubscribed boolean, last_sent_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
    SELECT
        ntt.template_name,
        COALESCE(nt.description, ntt.template_name),
        BOOL_OR(ntt.unsubscribed),
        MAX(ntt.created_at)
    FROM metadata.notification_tracking_tokens ntt
    JOIN metadata.civic_os_users_private cup ON cup.email = ntt.recipient_email
    LEFT JOIN metadata.notification_templates nt ON nt.name = ntt.template_name AND nt.is_bulk = TRUE
    WHERE cup.id = p_user_id
      AND nt.is_bulk = TRUE
    GROUP BY ntt.template_name, nt.description
    ORDER BY MAX(ntt.created_at) DESC;
$function$;

-- Note: Reverting all guarded function bodies (create_entity_note,
-- preview_template_parts, validate_template_parts, recurring series
-- functions, enable_entity_notes) is not practical in a single revert
-- script. The deploy uses CREATE OR REPLACE which preserves the function
-- OID. A full revert would require restoring each function body to its
-- pre-migration state. In practice, if this migration needs reverting,
-- it should be done via sqitch revert which will run this script, and
-- then the prior migration versions will be re-deployed.

-- Remove schema decision
DELETE FROM metadata.schema_decisions
WHERE migration_id = 'v0-76-5-revoke-public-execute';

NOTIFY pgrst, 'reload schema';

COMMIT;
