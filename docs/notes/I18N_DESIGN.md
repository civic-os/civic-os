# Multi-Language (i18n) System Design

> Phase 1 (v0.57.0): Foundation + Angular system strings

## Overview

Civic OS serves municipalities with diverse populations. The i18n system enables framework UI strings (buttons, labels, error messages) to display in the user's preferred language. Instance-specific metadata translations (entity names, property labels) are deferred to Phase 2.

## Architecture

### Three-Layer Translation Stack

```
┌─────────────────────────────────────────────────────────┐
│  Angular Frontend                                       │
│  ┌───────────────┐  ┌──────────────┐  ┌──────────────┐ │
│  │ TranslatePipe  │→│ Translation  │→│ Locale       │ │
│  │ {{ key |      │  │ Service      │  │ Service      │ │
│  │   translate }} │  │ (cache+fetch)│  │ (signal)     │ │
│  └───────────────┘  └──────┬───────┘  └──────┬───────┘ │
│                            │                  │         │
│  ┌─────────────────────────┼──────────────────┼───────┐ │
│  │ Locale HTTP Interceptor │                  │       │ │
│  │ Adds Accept-Language    │                  │       │ │
│  └─────────────────────────┼──────────────────┼───────┘ │
└────────────────────────────┼──────────────────┼─────────┘
                             │                  │
┌────────────────────────────┼──────────────────┼─────────┐
│  PostgREST                 │                  │         │
│  Accept-Language header → GUC variable        │         │
│  request.header.accept-language               │         │
└────────────────────────────┼──────────────────┼─────────┘
                             │                  │
┌────────────────────────────┼──────────────────┼─────────┐
│  PostgreSQL                │                  │         │
│  ┌──────────────────┐   ┌─┴──────────────┐   │         │
│  │ metadata.         │   │ metadata.t()    │   │         │
│  │ translations      │   │ (lookup fn)     │   │         │
│  │ (source, key,     │   │ locale→text     │   │         │
│  │  locale, text)    │   │ fallback chain  │   │         │
│  └──────────────────┘   └────────────────┘   │         │
│                                               │         │
│  ┌────────────────────────────────────────┐   │         │
│  │ civic_os_users_private.locale          │←──┘         │
│  │ (persisted preference)                 │             │
│  └────────────────────────────────────────┘             │
└─────────────────────────────────────────────────────────┘
```

### Translation Fallback Chain

When `TranslationService.get(key)` is called:

1. **Cached locale translations** — fetched from DB via `get_translations_for_locale` RPC
2. **Bundled English fallback** — static import of `en.translations.ts` (synchronous, zero-latency)
3. **Raw key name** — last resort (e.g., `nav.home`) indicating a missing translation

### Locale Resolution Priority

When `LocaleService` initializes, it resolves the initial locale:

1. JWT `locale` claim (synced from `civic_os_users_private.locale` via Keycloak)
2. `navigator.language` (browser preference)
3. Instance `defaultLocale` from runtime config
4. `'en'` hardcoded fallback

## Key Design Decisions

### Static TypeScript Import vs HTTP Fetch

**Decision**: English fallback strings are bundled via static TypeScript import, not fetched via HTTP.

**Rationale**: The original design used `HttpClient.get('assets/i18n/en.json')` but this caused problems:
- Unflushed HTTP requests in tests (every component importing `TranslatePipe` triggered a background fetch)
- Race condition between fallback load and first `get()` call
- No benefit to async loading for the default language (always needed, always the same)

The `en.translations.ts` file is the single source of truth. It's ~10KB, well within acceptable bundle overhead for eliminating an entire class of async timing issues.

### No ngx-translate Dependency

**Decision**: Custom `TranslationService` + `TranslatePipe` (~200 lines total) instead of ngx-translate.

**Rationale**:
- Our translations live in PostgreSQL, not JSON files — ngx-translate's file-based loaders don't fit
- Signal-based reactivity integrates naturally with Angular's zoneless architecture
- The translation logic is simple: key lookup + `{{param}}` interpolation + fallback chain
- No maintenance burden tracking a third-party library's Angular version compatibility

### English Short-Circuit in `metadata.t()`

**Decision**: The database `t()` function returns the default text immediately when locale is `'en'`, skipping all table lookups.

**Rationale**: Most Civic OS instances are English-only. The `t()` function will be used in Phase 2 to wrap schema VIEW columns. Zero overhead for the default case means no performance regression for instances that don't use i18n.

### `Accept-Language` Header for Locale Transport

**Decision**: The Angular locale interceptor adds `Accept-Language: {locale}` to all PostgREST requests. PostgreSQL reads it via `current_setting('request.header.accept-language', true)`.

**Rationale**: This reuses PostgREST's existing GUC variable mechanism (same pattern as JWT claims). No schema changes, no session state — the locale travels with each request. The interceptor follows the exact same pattern as `impersonation.interceptor.ts`.

### Conditional Language Tab

**Decision**: The Language tab in Settings only appears when `supportedLocales.length > 1`.

**Rationale**: English-only instances (the majority) shouldn't see a useless Language tab. The tab appears automatically when an instance adds a second locale to its runtime config.

## Database Schema

### `metadata.translations` Table

```sql
CREATE TABLE metadata.translations (
  id SERIAL PRIMARY KEY,
  source_type VARCHAR(50) NOT NULL,  -- 'ui', 'entity', 'property', etc.
  source_key TEXT NOT NULL,           -- 'nav.home', 'error.forbidden'
  locale VARCHAR(10) NOT NULL,        -- 'en', 'es', 'es-MX'
  translated_text TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (source_type, source_key, locale)
);
```

- **RLS**: `web_anon` and `authenticated` can SELECT. Only admin can INSERT/UPDATE/DELETE.
- **`source_type`**: Discriminator for Phase 2 (entity names, property labels, status labels, etc.). Phase 1 uses `'ui'` exclusively.

### RPCs

| Function | Access | Purpose |
|----------|--------|---------|
| `get_translations_for_locale(p_locale)` | All roles | Bulk fetch all UI translations for a locale |
| `upsert_translations(p_translations JSONB)` | Admin only | Bulk insert/update translations |
| `get_missing_translations(p_target_locale)` | Admin only | Coverage report: keys without translations |

### `metadata.t()` Function

```sql
metadata.t(p_source_type TEXT, p_source_key TEXT, p_default_text TEXT) → TEXT
```

- Reads locale from `request.header.accept-language` GUC
- Short-circuits for `'en'` → returns `p_default_text` (zero overhead)
- Fallback: exact locale (`es-MX`) → base language (`es`) → `p_default_text`
- Marked `STABLE` for query plan caching

## Frontend Services

### LocaleService (`src/app/services/locale.service.ts`)

Signal-based service following the `ThemeService` pattern:
- `locale: Signal<string>` — current locale (readonly)
- `supportedLocales: LocaleInfo[]` — configured locales with display names
- `setLocale(code)` — updates signal + persists to `civic_os_users_private`
- `effect()` sets `document.documentElement.lang` and `dir` attributes

### TranslationService (`src/app/services/translation.service.ts`)

- Fetches translations via `get_translations_for_locale` RPC on locale change
- Caches in `Map<string, string>` per locale
- `get(key, params?)` — lookup with `{{param}}` interpolation
- `version: Signal<number>` — increments on each fetch to trigger pipe re-evaluation

### TranslatePipe (`src/app/pipes/translate.pipe.ts`)

- Impure pipe that reads `translationService.version()` signal to re-evaluate on locale change
- Usage: `{{ 'nav.home' | translate }}` or `{{ 'form.min_value' | translate:{ min: 5 } }}`

### Locale Interceptor (`src/app/interceptors/locale.interceptor.ts`)

- Adds `Accept-Language` header to all PostgREST requests
- Skips non-PostgREST URLs
- Follows `impersonation.interceptor.ts` pattern exactly

## Testing

### `provideTranslationTesting()` Utility

Shared test utility at `src/app/testing/translation-testing.ts` that provides mock `LocaleService` and `TranslationService`. Returns English text from bundled `EN_TRANSLATIONS` so existing test assertions work without changes.

Required in any spec file where components import `TranslatePipe`.

## Phase 2: Metadata Translations (v0.58.0)

Phase 2 wraps instance-specific metadata text (entity names, property labels, status names, etc.) with `metadata.t()` in 7 public VIEWs. The `Accept-Language` header — already sent by the locale interceptor — drives translation lookup at query time.

### Source Types and Key Conventions

Each metadata type uses a unique `source_type` and hierarchical dot-notation `source_key`:

| Source Type | Key Pattern | Example |
|-------------|-------------|---------|
| `entity` | `{table_name}.display_name` | `Issue.display_name` |
| `entity` | `{table_name}.description` | `Issue.description` |
| `property` | `{table_name}.{column_name}.display_name` | `Issue.street_address.display_name` |
| `property` | `{table_name}.{column_name}.description` | `Issue.description.description` |
| `status` | `{entity_type}.{status_key}.display_name` | `issue.new.display_name` |
| `status` | `{entity_type}.{status_key}.description` | `issue.new.description` |
| `category` | `{entity_type}.{category_key}.display_name` | `time_entry.billable.display_name` |
| `static_text` | `{table_name}.{id}` | `Issue.42` |
| `action` | `{table_name}.{action_name}.{column}` | `Issue.approve.display_name` |
| `action_param` | `{table_name}.{action_name}.{param_name}.{column}` | `Issue.approve.reason.display_name` |
| `guided_form_step` | `{guided_form_key}.{step_key}.display_name` | `building_use.contact_info.display_name` |

**Key design choice**: Status and category keys use `status_key`/`category_key` (not `display_name`) for stability across renames.

### VIEWs Modified

All 7 VIEWs are recreated with `metadata.t()` wrapping on translatable text columns:

1. `schema_entities` — `display_name`, `description`
2. `schema_properties` — `display_name`, `description`
3. `statuses` — `display_name`, `description`
4. `categories` — `display_name`, `description`
5. `static_text` — `content`
6. `schema_entity_actions` — `display_name`, `description`, `confirmation_message`, `disabled_tooltip`, `default_success_message` + embedded param `display_name`, `placeholder`
7. `schema_guided_form_steps` — `display_name`, `description`

### PostgREST 13 Header Handling

PostgREST 13+ stores request headers in a single `request.headers` JSON GUC, not individual `request.header.<name>` GUCs. Hyphenated header names like `accept-language` can never be individual GUCs because PostgreSQL identifiers don't support hyphens. The `metadata.current_locale()` function was updated to read from the JSON blob with a legacy fallback:

```sql
SELECT COALESCE(
  NULLIF(current_setting('request.headers', true)::json->>'accept-language', ''),
  NULLIF(current_setting('request.header.accept-language', true), ''),
  'en'
);
```

### VIEW Recreation (Collation)

VIEWs wrapped with `metadata.t()` must use `DROP VIEW IF EXISTS ... CASCADE` + `CREATE VIEW`, not `CREATE OR REPLACE VIEW`. The `t()` function returns `TEXT` with collation `"C"`, while original columns use collation `"default"` — PostgreSQL rejects collation changes via `CREATE OR REPLACE`. The `schema_entity_dependencies` VIEW (depends on `schema_properties`) must be explicitly recreated after the CASCADE drop.

### Frontend Cache Invalidation

When the user changes locale, the frontend must re-fetch schema metadata because VIEWs return different text based on `Accept-Language`. Both `SchemaService` and `DashboardService` use an `effect()` watching `LocaleService.locale()` that calls `refreshCache()` on changes (skipping the initial emission).

**Bug fix**: `SchemaService.refreshCache()` was missing category cache clearing — status caches were cleared but categories were not.

### Circular Dependency: `Injector.get()` Pattern

Adding `LocaleService` to `SchemaService` (for locale-aware cache invalidation) created a circular DI chain: `SchemaService` → `LocaleService` → `AuthService` → `SchemaService`. The fix: `LocaleService` uses `inject(Injector)` instead of `inject(AuthService)`, then lazily resolves `AuthService` via `this.injector.get(AuthService)` only inside `setLocale()`. This breaks the cycle because Angular's DI doesn't try to resolve `AuthService` during `LocaleService` construction.

### Deferred to Phase 3

- Dashboard widget JSONB `config` translations (embedded text in Markdown widgets, nav buttons)
- Dashboard RPC function modifications (`get_dashboards`/`get_dashboard` don't use VIEWs)
- `schema_decisions` translation (developer-facing, not user-facing)
- Admin translation management UI

## Phase Roadmap

| Phase | Version | Scope |
|-------|---------|-------|
| Phase 1 | v0.57.0 | Foundation tables, Angular UI strings (~250 keys), locale service, settings Language tab |
| **Phase 2** | v0.58.0 | Metadata translations — wrap 7 VIEWs with `t()`, locale-aware cache invalidation, pothole Spanish seeds |
| Phase 3 | v0.59.0 | Dashboard RPC translations, admin translation UI, notification template localization |

## File Reference

| File | Purpose |
|------|---------|
| `postgres/migrations/deploy/v0-57-0-add-i18n.sql` | Phase 1: tables, functions, UI string seeds |
| `postgres/migrations/deploy/v0-58-0-metadata-translations.sql` | Phase 2: VIEW rewrites, metadata seeds |
| `src/app/i18n/en.translations.ts` | Single source of truth for English strings |
| `src/app/services/locale.service.ts` | Signal-based locale management |
| `src/app/services/translation.service.ts` | Translation lookup + cache |
| `src/app/pipes/translate.pipe.ts` | Template translation pipe |
| `src/app/interceptors/locale.interceptor.ts` | Accept-Language header injection |
| `src/app/testing/translation-testing.ts` | Shared test mock utility |
