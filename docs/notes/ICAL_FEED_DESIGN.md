# iCal Feed Design

**Status**: Implemented (v0.27.0 helpers, v0.66.0 change detection, v0.71.0 HTTP caching)
**Audience**: Contributors maintaining `metadata.format_ical_event()` / `metadata.wrap_ical_feed()`
**Integrator docs**: `docs/INTEGRATOR_GUIDE.md` (iCal Calendar Feeds section)

## Overview

Civic OS exposes subscribable calendar feeds as PostgREST RPCs. An instance writes a small PL/pgSQL function that selects its time-based rows, calls `metadata.format_ical_event()` per row, and hands the concatenated VEVENTs to `metadata.wrap_ical_feed()`. The framework owns every RFC 5545 and HTTP detail; the instance owns only the query and the field mapping.

```
Instance RPC (public.*_ical_feed)
  └─ SELECT rows
  └─ metadata.format_ical_event(...) ×N   -- VEVENT text
  └─ metadata.wrap_ical_feed(...)         -- VCALENDAR + HTTP headers / status
       └─ returns "*/*" domain (bytea)    -- PostgREST passes body through verbatim
```

## Decisions

### Instance-only export, no RRULE (v0.27.0)

Civic OS materializes recurring schedules into individual rows, so every occurrence is emitted as its own VEVENT. RRULE + EXDATE would be smaller but is the single most inconsistently implemented part of iCalendar across clients. Per-instance VEVENTs render identically everywhere.

### `"*/*"` media-type handler (v0.27.0)

PostgREST's domain-based media type handlers let a function own the response body. `"*/*"` (rather than `"text/calendar"`) was chosen because calendar clients send wildly different `Accept` headers — some none at all — and a narrower handler returned 406 for several of them. `Content-Type` is set explicitly through the `response.headers` GUC.

### UTC `Z` timestamps, no VTIMEZONE (v0.27.0)

Emitting `DTSTART:...Z` avoids shipping a VTIMEZONE block and avoids the DST-transition bugs that come with `TZID=` floating times. Clients render in the viewer's local zone.

### `LAST-MODIFIED` + `SEQUENCE` + HTTP `Last-Modified` (v0.66.0)

Gave clients a per-event change signal and a feed-level cache validator. `SEQUENCE` is caller-supplied (default 0) because only the instance knows what counts as a reschedule.

### Stable `DTSTAMP`, `ETag`, `304`, folding, `REFRESH-INTERVAL` (v0.71.0)

Triggered by a production investigation (Mott Park, Aug 2026): a newly approved event was in the feed, Google Calendar (`Google-Calendar-Importer`) was fetching every 4–6 hours and receiving it on every fetch, yet it did not render for days. The feed itself was valid, but it gave clients nothing to diff against:

| Problem | Fix |
|---|---|
| `DTSTAMP` was `NOW()` on every fetch → every event looked modified on every poll; body never byte-stable | `DTSTAMP = COALESCE(p_last_modified, NOW())` |
| Conditional GETs (`If-Modified-Since`) always got a full `200` | Read `request.headers`; on match set `response.status = 304`, return empty body |
| No `ETag` | Weak ETag `W/"<epoch of feed_updated_at>"` |
| No `Cache-Control` | `Cache-Control: no-cache` — forces revalidation at any intermediate cache (Traefik/CDN) without disabling conditional requests |
| Lines > 75 octets | `fold_ical_line()`, byte-aware so multibyte UTF-8 is never split |
| No advertised refresh cadence | `REFRESH-INTERVAL;VALUE=DURATION` (RFC 7986) + `X-PUBLISHED-TTL`, via new optional `p_refresh_interval` (default 1 hour) |

**Why ETag from `updated_at` rather than a content hash**: zero cost, and correct under the project convention that every row change bumps `updated_at` via trigger. A content hash would be more robust to instances that violate that convention, but the convention is the contract — and `Last-Modified`/`If-Modified-Since` already depend on it. Documented as a requirement in the Integrator Guide.

**Why not a `304` for requests without `p_feed_updated_at`**: without a modification instant there is nothing to validate against; the function simply serves `200` as before.

**Volatility**: `format_ical_event()` was declared `IMMUTABLE` while calling `NOW()`. It is now `STABLE`, which is the honest classification with the `NOW()` fallback still present.

**Signature compatibility**: `format_ical_event()` keeps its 8-parameter signature; `wrap_ical_feed()` gains one trailing optional parameter (the 3-param overload is dropped, as in v0.66.0, to avoid ambiguity). Existing instance RPCs need no change. Because the migration only replaces function bodies, it can be applied out-of-band to an instance on an older framework version; the subsequent sqitch deploy is a no-op.

## Client behavior reference (observed, Aug 2026)

| Client | Poll cadence | Honors `REFRESH-INTERVAL` | Sends conditional headers |
|---|---|---|---|
| Google Calendar (`Google-Calendar-Importer`) | every 4–6 h per URL, shared across all subscribers | No | Not observed |
| Apple Calendar | per subscription setting / `REFRESH-INTERVAL` | Yes | Yes |
| Outlook | ~3 h default / `X-PUBLISHED-TTL` | Yes | Varies |

Google's fetch and its apply-to-calendars step are separate; a feed can be fetched repeatedly and still render stale. The only user-side reset is unsubscribing and re-adding, ideally with a changed query string so Google treats it as a new URL.

## Testing

- `postgres/migrations/verify/v0-71-0-ical-http-caching.sql` — pure-SQL assertions incl. folding boundaries, multibyte round-trip, and 304 logic via `set_config('request.headers', ...)`.
- `tests/functional/v0-71-0-ical-http-caching-test.sh` — installs a throwaway RPC and exercises headers, 304/200 paths, byte-stability, and folding through a live PostgREST. Instance-independent.

## Future

- `URL:` property linking back to the record's Detail page (needs a base-URL source in the DB).
- `STATUS:CANCELLED` VEVENTs for records that leave the feed, so clients remove them promptly instead of waiting for them to age out of the window.
- Per-instance `p_refresh_interval` tuning guidance once more client telemetry exists.
