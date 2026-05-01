-- Verify civic_os:v0-50-1-phone-search-tokens

BEGIN;

-- Function exists
SELECT 1/COUNT(*)::int FROM pg_proc WHERE proname = 'phone_search_tokens';

-- Returns expected tokens
DO $$
DECLARE result TEXT;
BEGIN
  result := phone_search_tokens('3135551234'::phone_number);
  ASSERT result LIKE '%313%', 'area code missing';
  ASSERT result LIKE '%5551234%', 'last 7 missing';
  ASSERT result LIKE '%1234%', 'last 4 missing';
  ASSERT result LIKE '%313555%', 'area+exchange missing';
END;
$$;

ROLLBACK;
