-- Deploy civic_os:v0-71-0-ical-http-caching to pg
-- requires: v0-70-0-trackable-notifications

BEGIN;

-- ============================================================================
-- iCAL FEED HTTP CACHING, LINE FOLDING, STABLE DTSTAMP, REFRESH-INTERVAL
-- ============================================================================
-- Hardens the iCal helpers so subscribing clients (Google Calendar, Apple
-- Calendar, Outlook) receive clean change-detection signals:
--
--   1. DTSTAMP is derived from p_last_modified (falls back to NOW() only when
--      the caller supplies no modification time). Previously every fetch
--      re-stamped every event, so the body changed on every poll and clients
--      could never distinguish a real change from noise.
--   2. Every property line is folded at 75 octets per RFC 5545 §3.1
--      (byte-aware, never splits a multibyte UTF-8 character).
--   3. wrap_ical_feed() emits ETag + Cache-Control headers, and honors
--      If-None-Match / If-Modified-Since by returning 304 Not Modified with an
--      empty body. ETag is derived from p_feed_updated_at (zero cost; relies on
--      the project convention that every row update bumps updated_at).
--   4. REFRESH-INTERVAL (RFC 7986) and X-PUBLISHED-TTL advertise a polling
--      cadence to clients that honor it (Apple, Outlook, Thunderbird). Google
--      ignores these and polls on its own schedule (observed every 4-6 hours).
--
-- All signatures remain call-compatible: format_ical_event() is unchanged,
-- wrap_ical_feed() gains one trailing optional parameter.
--
-- Backport note: this migration only CREATE OR REPLACEs function bodies. It
-- can be applied out-of-band to an instance on v0.66.0+ without the
-- intervening migrations; the real sqitch deploy is then a no-op.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Line folding helper (RFC 5545 §3.1)
-- ----------------------------------------------------------------------------
-- Content lines SHOULD NOT exceed 75 octets (excluding CRLF). Long lines are
-- split with CRLF followed by a single space; the space counts toward the next
-- line's 75-octet budget, so continuation lines carry 74 octets of content.
CREATE OR REPLACE FUNCTION metadata.fold_ical_line(p_line TEXT)
RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE
AS $$
DECLARE
  v_remaining TEXT := COALESCE(p_line, '');
  v_out TEXT := '';
  v_limit INTEGER := 75;   -- first segment: full 75 octets
  v_chars INTEGER;
BEGIN
  WHILE octet_length(v_remaining) > v_limit LOOP
    -- Start from the octet limit as a character count and back off until the
    -- prefix fits; this never cuts a multibyte character in half.
    v_chars := LEAST(v_limit, length(v_remaining));
    WHILE octet_length(left(v_remaining, v_chars)) > v_limit LOOP
      v_chars := v_chars - 1;
    END LOOP;
    v_out := v_out || left(v_remaining, v_chars) || chr(13) || chr(10) || ' ';
    v_remaining := substr(v_remaining, v_chars + 1);
    v_limit := 74;         -- continuation segments: 75 minus the leading space
  END LOOP;
  RETURN v_out || v_remaining;
END;
$$;

COMMENT ON FUNCTION metadata.fold_ical_line(TEXT) IS
  'Fold a single iCal content line at 75 octets per RFC 5545 §3.1 (CRLF + space continuation, UTF-8 safe).';

-- Emit one property line: NAME:value, folded, terminated with CRLF.
-- Returns '' when value is NULL or empty so optional properties can be
-- concatenated unconditionally.
CREATE OR REPLACE FUNCTION metadata.ical_property(p_name TEXT, p_value TEXT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_value IS NULL OR p_value = '' THEN ''
    ELSE metadata.fold_ical_line(p_name || ':' || p_value) || chr(13) || chr(10)
  END
$$;

COMMENT ON FUNCTION metadata.ical_property(TEXT, TEXT) IS
  'Emit a folded "NAME:value" iCal content line with CRLF; returns empty string for NULL/empty values.';

-- ----------------------------------------------------------------------------
-- format_ical_event: stable DTSTAMP + folding (signature unchanged)
-- ----------------------------------------------------------------------------
-- Volatility changed from IMMUTABLE to STABLE: the NOW() fallback was never
-- immutable, and STABLE is the honest classification.
CREATE OR REPLACE FUNCTION metadata.format_ical_event(
  p_uid TEXT,                    -- Unique ID (e.g., 'reservation-123@civic-os.org')
  p_summary TEXT,                -- Event title
  p_dtstart TIMESTAMPTZ,         -- Start time
  p_dtend TIMESTAMPTZ,           -- End time
  p_description TEXT DEFAULT NULL,
  p_location TEXT DEFAULT NULL,
  p_last_modified TIMESTAMPTZ DEFAULT NULL,  -- When the source record was last changed
  p_sequence INTEGER DEFAULT 0               -- Change counter (bump on reschedule)
) RETURNS TEXT
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  v_fmt CONSTANT TEXT := 'YYYYMMDD"T"HH24MISS"Z"';
  v_crlf CONSTANT TEXT := chr(13) || chr(10);
BEGIN
  RETURN
    'BEGIN:VEVENT' || v_crlf ||
    metadata.ical_property('UID', p_uid) ||
    -- DTSTAMP: stable across fetches when the caller supplies last_modified
    metadata.ical_property('DTSTAMP',
      to_char(COALESCE(p_last_modified, NOW()) AT TIME ZONE 'UTC', v_fmt)) ||
    metadata.ical_property('DTSTART', to_char(p_dtstart AT TIME ZONE 'UTC', v_fmt)) ||
    metadata.ical_property('DTEND', to_char(p_dtend AT TIME ZONE 'UTC', v_fmt)) ||
    metadata.ical_property('SUMMARY', metadata.escape_ical_text(p_summary)) ||
    metadata.ical_property('DESCRIPTION', metadata.escape_ical_text(p_description)) ||
    metadata.ical_property('LOCATION', metadata.escape_ical_text(p_location)) ||
    CASE WHEN p_last_modified IS NOT NULL
      THEN metadata.ical_property('LAST-MODIFIED', to_char(p_last_modified AT TIME ZONE 'UTC', v_fmt))
      ELSE '' END ||
    metadata.ical_property('SEQUENCE', COALESCE(p_sequence, 0)::text) ||
    'END:VEVENT';
END;
$$;

COMMENT ON FUNCTION metadata.format_ical_event(TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, TIMESTAMPTZ, INTEGER) IS
  'Format a single VEVENT block for iCal export. Timestamps are converted to UTC. DTSTAMP derives from p_last_modified when provided (stable output). Lines are folded at 75 octets per RFC 5545. Supports LAST-MODIFIED and SEQUENCE for change detection.';

-- ----------------------------------------------------------------------------
-- wrap_ical_feed: ETag / 304 / Cache-Control / REFRESH-INTERVAL
-- ----------------------------------------------------------------------------
-- Drop the 3-param overload before creating the 4-param version (same pattern
-- as v0-66-0): CREATE OR REPLACE with a different arg count would create a
-- second overload and make 3-arg calls ambiguous.
DROP FUNCTION IF EXISTS metadata.wrap_ical_feed(TEXT, TEXT, TIMESTAMPTZ);

CREATE OR REPLACE FUNCTION metadata.wrap_ical_feed(
  p_events TEXT,                               -- Concatenated VEVENT blocks (each ending with CRLF)
  p_calendar_name TEXT DEFAULT 'Civic OS Calendar',
  p_feed_updated_at TIMESTAMPTZ DEFAULT NULL,  -- Most recent event modification time
  p_refresh_interval INTERVAL DEFAULT '1 hour' -- Advertised polling cadence (NULL = omit)
) RETURNS "*/*"
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_crlf CONSTANT TEXT := chr(13) || chr(10);
  v_result TEXT;
  v_headers TEXT;
  v_updated TIMESTAMPTZ;
  v_etag TEXT;
  v_last_modified_http TEXT;
  v_req_headers JSON;
  v_if_none_match TEXT;
  v_if_modified_since TIMESTAMPTZ;
  v_not_modified BOOLEAN := false;
  v_duration TEXT;
BEGIN
  -- HTTP dates carry whole seconds; truncate so equality comparisons hold.
  v_updated := date_trunc('second', p_feed_updated_at);

  IF v_updated IS NOT NULL THEN
    -- Weak ETag from the feed's last modification instant. Relies on the
    -- convention that every content change bumps updated_at.
    v_etag := 'W/"' || extract(epoch FROM v_updated)::bigint::text || '"';
    v_last_modified_http := to_char(v_updated AT TIME ZONE 'UTC', 'Dy, DD Mon YYYY HH24:MI:SS') || ' GMT';

    -- Conditional request handling (PostgREST exposes request headers,
    -- lower-cased, via the request.headers GUC).
    BEGIN
      v_req_headers := current_setting('request.headers', true)::JSON;
    EXCEPTION WHEN OTHERS THEN
      v_req_headers := NULL;  -- Not running under PostgREST (psql, tests)
    END;

    IF v_req_headers IS NOT NULL THEN
      v_if_none_match := v_req_headers->>'if-none-match';
      IF v_if_none_match IS NOT NULL THEN
        -- RFC 9110 §13.1.2: "*" is false whenever a representation exists;
        -- otherwise compare each listed tag with the weak comparison
        -- function (§8.8.3.2): opaque-tags equal, W/ prefix ignored.
        IF btrim(v_if_none_match) = '*' THEN
          v_not_modified := true;
        ELSE
          v_not_modified := EXISTS (
            SELECT 1
            FROM unnest(string_to_array(v_if_none_match, ',')) AS t(tag)
            WHERE regexp_replace(btrim(t.tag), '^W/', '') = replace(v_etag, 'W/', '')
          );
        END IF;
      ELSIF v_req_headers->>'if-modified-since' IS NOT NULL THEN
        BEGIN
          v_if_modified_since := to_timestamp(
            v_req_headers->>'if-modified-since', 'Dy, DD Mon YYYY HH24:MI:SS "GMT"'
          );
          v_not_modified := v_updated <= v_if_modified_since;
        EXCEPTION WHEN OTHERS THEN
          v_not_modified := false;  -- Unparseable date: serve the full body
        END;
      END IF;
    END IF;
  END IF;

  -- Build response headers
  v_headers := '[{"Content-Type": "text/calendar; charset=utf-8"}'
            || ', {"Cache-Control": "no-cache"}';
  IF v_updated IS NOT NULL THEN
    v_headers := v_headers
              || ', {"Last-Modified": "' || v_last_modified_http || '"}'
              || ', {"ETag": "' || replace(v_etag, '"', '\"') || '"}';
  END IF;
  v_headers := v_headers || ']';
  PERFORM set_config('response.headers', v_headers, true);

  IF v_not_modified THEN
    PERFORM set_config('response.status', '304', true);
    RETURN ''::bytea::"*/*";
  END IF;

  -- ISO 8601 duration for REFRESH-INTERVAL (RFC 7986) and X-PUBLISHED-TTL.
  -- Whole hours or minutes cover every realistic cadence.
  IF p_refresh_interval IS NOT NULL THEN
    IF extract(epoch FROM p_refresh_interval)::bigint % 3600 = 0 THEN
      v_duration := 'PT' || (extract(epoch FROM p_refresh_interval)::bigint / 3600)::text || 'H';
    ELSE
      v_duration := 'PT' || (extract(epoch FROM p_refresh_interval)::bigint / 60)::text || 'M';
    END IF;
  END IF;

  v_result :=
    'BEGIN:VCALENDAR' || v_crlf ||
    'VERSION:2.0' || v_crlf ||
    'PRODID:-//Civic OS//Calendar Feed//EN' || v_crlf ||
    'CALSCALE:GREGORIAN' || v_crlf ||
    'METHOD:PUBLISH' || v_crlf ||
    metadata.ical_property('X-WR-CALNAME', metadata.escape_ical_text(p_calendar_name)) ||
    CASE WHEN v_duration IS NOT NULL
      THEN 'REFRESH-INTERVAL;VALUE=DURATION:' || v_duration || v_crlf ||
           'X-PUBLISHED-TTL:' || v_duration || v_crlf
      ELSE '' END ||
    COALESCE(p_events, '') ||
    'END:VCALENDAR';

  RETURN convert_to(v_result, 'UTF8')::"*/*";
END;
$$;

COMMENT ON FUNCTION metadata.wrap_ical_feed(TEXT, TEXT, TIMESTAMPTZ, INTERVAL) IS
  'Wrap VEVENT blocks in a VCALENDAR container. Sets Content-Type, Cache-Control, Last-Modified and ETag headers; answers If-None-Match / If-Modified-Since with 304. Advertises REFRESH-INTERVAL (RFC 7986) when p_refresh_interval is non-NULL.';

-- ----------------------------------------------------------------------------
-- Grants & introspection
-- ----------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION metadata.fold_ical_line(TEXT) TO web_anon, authenticated;
GRANT EXECUTE ON FUNCTION metadata.ical_property(TEXT, TEXT) TO web_anon, authenticated;
GRANT EXECUTE ON FUNCTION metadata.format_ical_event(TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, TIMESTAMPTZ, INTEGER) TO web_anon, authenticated;
GRANT EXECUTE ON FUNCTION metadata.wrap_ical_feed(TEXT, TEXT, TIMESTAMPTZ, INTERVAL) TO web_anon, authenticated;

SELECT metadata.auto_register_function(
  'fold_ical_line',
  'Fold iCal Line',
  'Fold an iCal content line at 75 octets per RFC 5545',
  'iCal Export'
);

SELECT metadata.auto_register_function(
  'ical_property',
  'iCal Property Line',
  'Emit a folded iCal property line with CRLF',
  'iCal Export'
);

COMMIT;
