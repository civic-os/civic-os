-- Neighborhood Engagement Hub - Borrower Sync Triggers

-- Trigger function for civic_os_users INSERT → create shell with display_name
CREATE OR REPLACE FUNCTION public.sync_borrower_on_user_insert()
RETURNS TRIGGER 
LANGUAGE plpgsql 
SECURITY DEFINER 
SET search_path = public, metadata, pg_temp
AS $$
BEGIN
  INSERT INTO public.borrowers (user_id, display_name)
  VALUES (NEW.id, NEW.display_name)
  ON CONFLICT (user_id) DO UPDATE
    SET display_name = EXCLUDED.display_name,
        updated_at = now();
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.sync_borrower_on_user_insert() IS
  'Sync borrower record when a new civic_os_user is created.';

-- Trigger function for civic_os_users_private INSERT/UPDATE → sync phone & email
CREATE OR REPLACE FUNCTION public.sync_borrower_on_private_upsert()
RETURNS TRIGGER 
LANGUAGE plpgsql 
SECURITY DEFINER 
SET search_path = public, metadata, pg_temp
AS $$
BEGIN
  INSERT INTO public.borrowers (user_id, display_name, phone, email)
  VALUES (NEW.id, NEW.display_name, NEW.phone, NEW.email)
  ON CONFLICT (user_id) DO UPDATE
    SET display_name = EXCLUDED.display_name,
        phone = EXCLUDED.phone,
        email = EXCLUDED.email,
        updated_at = now();
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.sync_borrower_on_private_upsert() IS
  'Sync borrower record when civic_os_users_private is updated.';

-- Create triggers
DROP TRIGGER IF EXISTS trg_borrower_sync_insert ON metadata.civic_os_users;
CREATE TRIGGER trg_borrower_sync_insert
  AFTER INSERT ON metadata.civic_os_users
  FOR EACH ROW EXECUTE FUNCTION public.sync_borrower_on_user_insert();

DROP TRIGGER IF EXISTS trg_borrower_sync_private ON metadata.civic_os_users_private;
CREATE TRIGGER trg_borrower_sync_private
  AFTER INSERT OR UPDATE ON metadata.civic_os_users_private
  FOR EACH ROW EXECUTE FUNCTION public.sync_borrower_on_private_upsert();

-- Backfill existing users (run once after migration)
-- INSERT INTO public.borrowers (user_id, display_name, phone, email)
-- SELECT cup.id, cup.display_name, cup.phone, cup.email
-- FROM metadata.civic_os_users_private cup
-- ON CONFLICT (user_id) DO NOTHING;