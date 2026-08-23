-- Verify civic_os:v0-71-0-ical-http-caching on pg

BEGIN;

-- New helpers exist
SELECT 1/(CASE WHEN COUNT(*) = 1 THEN 1 ELSE 0 END)
FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'metadata' AND p.proname = 'fold_ical_line';

SELECT 1/(CASE WHEN COUNT(*) = 1 THEN 1 ELSE 0 END)
FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'metadata' AND p.proname = 'ical_property';

-- wrap_ical_feed now has exactly one overload with 4 params
SELECT 1/(CASE WHEN COUNT(*) = 1 AND MAX(pronargs) = 4 THEN 1 ELSE 0 END)
FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'metadata' AND p.proname = 'wrap_ical_feed';

-- format_ical_event keeps its 8-param signature and is now STABLE
SELECT 1/(CASE WHEN COUNT(*) = 1 THEN 1 ELSE 0 END)
FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'metadata' AND p.proname = 'format_ical_event'
  AND pronargs = 8 AND provolatile = 's';

-- Folding: a short line is untouched
SELECT 1/(CASE WHEN metadata.fold_ical_line('SUMMARY:Short') = 'SUMMARY:Short' THEN 1 ELSE 0 END);

-- Folding: exactly 75 octets is untouched (boundary)
SELECT 1/(CASE WHEN metadata.fold_ical_line(repeat('a', 75)) = repeat('a', 75) THEN 1 ELSE 0 END);

-- Folding: 76 octets splits into 75 + CRLF + space + 1
SELECT 1/(CASE WHEN metadata.fold_ical_line(repeat('a', 76)) = repeat('a', 75) || E'\r\n a' THEN 1 ELSE 0 END);

-- Folding: no physical segment of a long ASCII line exceeds 75 octets
SELECT 1/(CASE WHEN bool_and(octet_length(seg) <= 75) THEN 1 ELSE 0 END)
FROM unnest(string_to_array(metadata.fold_ical_line(repeat('x', 400)), E'\r\n')) AS seg;

-- Folding: multibyte characters are never split (unfolded text round-trips)
SELECT 1/(CASE WHEN
  replace(metadata.fold_ical_line(repeat('é', 100)), E'\r\n ', '') = repeat('é', 100)
  AND bool_and(octet_length(seg) <= 75)
  THEN 1 ELSE 0 END)
FROM unnest(string_to_array(metadata.fold_ical_line(repeat('é', 100)), E'\r\n')) AS seg;

-- ical_property: NULL / empty values emit nothing
SELECT 1/(CASE WHEN metadata.ical_property('DESCRIPTION', NULL) = ''
              AND metadata.ical_property('DESCRIPTION', '') = '' THEN 1 ELSE 0 END);

-- DTSTAMP derives from p_last_modified (stable across calls)
SELECT 1/(CASE WHEN metadata.format_ical_event(
  'test-1@civic-os.org', 'Stable', '2024-01-15 10:00:00+00', '2024-01-15 11:00:00+00',
  p_last_modified := '2024-06-01 12:00:00+00'
) LIKE '%DTSTAMP:20240601T120000Z%' THEN 1 ELSE 0 END);

-- DTSTAMP falls back to NOW() when p_last_modified is NULL
SELECT 1/(CASE WHEN metadata.format_ical_event(
  'test-2@civic-os.org', 'Fallback', '2024-01-15 10:00:00+00', '2024-01-15 11:00:00+00'
) LIKE '%DTSTAMP:' || to_char(NOW() AT TIME ZONE 'UTC', 'YYYYMMDD') || '%' THEN 1 ELSE 0 END);

-- Backward compat: 4 required args still work, SEQUENCE:0 emitted
SELECT 1/(CASE WHEN metadata.format_ical_event(
  'test-3@civic-os.org', 'Compat', '2024-01-15 10:00:00+00', '2024-01-15 11:00:00+00'
) LIKE 'BEGIN:VEVENT%SEQUENCE:0%END:VEVENT' THEN 1 ELSE 0 END);

-- Long SUMMARY is folded inside the VEVENT
SELECT 1/(CASE WHEN metadata.format_ical_event(
  'test-4@civic-os.org', repeat('Long title ', 12), '2024-01-15 10:00:00+00', '2024-01-15 11:00:00+00'
) LIKE '%' || E'\r\n ' || '%' THEN 1 ELSE 0 END);

-- wrap_ical_feed: 2-arg and 3-arg calls still work; REFRESH-INTERVAL default 1h present
SELECT 1/(CASE WHEN convert_from(metadata.wrap_ical_feed('', 'Test Calendar')::bytea, 'UTF8')
  LIKE '%REFRESH-INTERVAL;VALUE=DURATION:PT1H%X-PUBLISHED-TTL:PT1H%' THEN 1 ELSE 0 END);

SELECT 1/(CASE WHEN length(metadata.wrap_ical_feed('', 'Test Calendar', '2024-06-01 12:00:00+00')) > 0 THEN 1 ELSE 0 END);

-- wrap_ical_feed: NULL interval omits REFRESH-INTERVAL; 30 min renders as PT30M
SELECT 1/(CASE WHEN convert_from(metadata.wrap_ical_feed('', 'T', NULL, NULL)::bytea, 'UTF8')
  NOT LIKE '%REFRESH-INTERVAL%' THEN 1 ELSE 0 END);

SELECT 1/(CASE WHEN convert_from(metadata.wrap_ical_feed('', 'T', NULL, '30 minutes')::bytea, 'UTF8')
  LIKE '%REFRESH-INTERVAL;VALUE=DURATION:PT30M%' THEN 1 ELSE 0 END);

-- wrap_ical_feed: headers include ETag, Cache-Control and Last-Modified when updated_at given
SELECT metadata.wrap_ical_feed('', 'T', '2024-06-01 12:00:00+00');
SELECT 1/(CASE WHEN
  position('"Cache-Control": "no-cache"' IN current_setting('response.headers', true)) > 0
  AND position('"Last-Modified": "Sat, 01 Jun 2024 12:00:00 GMT"' IN current_setting('response.headers', true)) > 0
  AND position('"ETag": "W/\"1717243200\""' IN current_setting('response.headers', true)) > 0
  THEN 1 ELSE 0 END);

-- wrap_ical_feed: If-None-Match hit yields 304 and empty body
SELECT set_config('request.headers', '{"if-none-match": "W/\"1717243200\""}', true);
SELECT 1/(CASE WHEN length(metadata.wrap_ical_feed('', 'T', '2024-06-01 12:00:00+00')) = 0
              AND current_setting('response.status', true) = '304' THEN 1 ELSE 0 END);

-- wrap_ical_feed: weak comparison — strong-form tag and a list with our tag both match
SELECT set_config('response.status', '', true);
SELECT set_config('request.headers', '{"if-none-match": "\"abc\", \"1717243200\" , W/\"zzz\""}', true);
SELECT 1/(CASE WHEN length(metadata.wrap_ical_feed('', 'T', '2024-06-01 12:00:00+00')) = 0
              AND current_setting('response.status', true) = '304' THEN 1 ELSE 0 END);

-- wrap_ical_feed: "*" yields 304 (a representation always exists)
SELECT set_config('response.status', '', true);
SELECT set_config('request.headers', '{"if-none-match": "*"}', true);
SELECT 1/(CASE WHEN length(metadata.wrap_ical_feed('', 'T', '2024-06-01 12:00:00+00')) = 0
              AND current_setting('response.status', true) = '304' THEN 1 ELSE 0 END);

-- wrap_ical_feed: superstring tag must NOT match (exact opaque-tag comparison)
SELECT set_config('response.status', '', true);
SELECT set_config('request.headers', '{"if-none-match": "W/\"91717243200\""}', true);
SELECT 1/(CASE WHEN length(metadata.wrap_ical_feed('', 'T', '2024-06-01 12:00:00+00')) > 0
              AND COALESCE(current_setting('response.status', true), '') <> '304' THEN 1 ELSE 0 END);

-- wrap_ical_feed: If-Modified-Since newer than feed yields 304
SELECT set_config('response.status', '', true);
SELECT set_config('request.headers', '{"if-modified-since": "Sun, 02 Jun 2024 00:00:00 GMT"}', true);
SELECT 1/(CASE WHEN length(metadata.wrap_ical_feed('', 'T', '2024-06-01 12:00:00+00')) = 0
              AND current_setting('response.status', true) = '304' THEN 1 ELSE 0 END);

-- wrap_ical_feed: stale If-Modified-Since yields full body, no 304
SELECT set_config('response.status', '', true);
SELECT set_config('request.headers', '{"if-modified-since": "Fri, 31 May 2024 00:00:00 GMT"}', true);
SELECT 1/(CASE WHEN length(metadata.wrap_ical_feed('', 'T', '2024-06-01 12:00:00+00')) > 0
              AND COALESCE(current_setting('response.status', true), '') <> '304' THEN 1 ELSE 0 END);

ROLLBACK;
