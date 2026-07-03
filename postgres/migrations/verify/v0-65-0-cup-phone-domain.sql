-- Verify civic_os:v0-65-0-cup-phone-domain

-- Verify phone column is phone_number domain
SELECT 1 / (CASE WHEN domain_name = 'phone_number' THEN 1 ELSE 0 END)
FROM information_schema.columns
WHERE table_schema = 'metadata'
  AND table_name = 'civic_os_users_private'
  AND column_name = 'phone';

-- Verify civic_os_users VIEW exists
SELECT 1 FROM information_schema.views
WHERE table_schema = 'public' AND table_name = 'civic_os_users';

-- Verify payment views exist (recreated after CASCADE drop)
SELECT 1 FROM information_schema.views
WHERE table_schema = 'public' AND table_name = 'payment_transactions';

SELECT 1 FROM information_schema.views
WHERE table_schema = 'public' AND table_name = 'payment_refunds';

-- Verify managed_users VIEW exists (recreated after phone type change)
SELECT 1 FROM information_schema.views
WHERE table_schema = 'public' AND table_name = 'managed_users';

-- Verify functions exist
SELECT 1 FROM pg_proc WHERE proname = 'refresh_current_user';
SELECT 1 FROM pg_proc WHERE proname = 'update_own_profile';
SELECT 1 FROM pg_proc WHERE proname = 'update_user_info';
