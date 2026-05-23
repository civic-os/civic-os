# Hybrid Search Design: pg_trgm + Full-Text Search

**Version**: v0.55.2
**Status**: Implemented

## Problem

Civic OS uses PostgreSQL Full-Text Search (tsvector/tsquery via PostgREST `wfts`) for List page search. FTS works well for multi-word queries ("block party") but fails at **substring name matching** — the primary search pattern in CRUD apps.

Typing "iel" can't find "Daniel" because FTS is word-boundary based. The `name_search_tokens()` function was a workaround that manually generated 3-char overlapping substrings and stuffed them into the tsvector. This was a reimplementation of what `pg_trgm` does natively — and worse, because it:
- Missed prefixes < 3 chars
- Couldn't do fuzzy matching
- Bloated the tsvector with synthetic tokens
- Added per-VIEW maintenance overhead

## Solution

Replace `name_search_tokens()` with the native `pg_trgm` extension and enable hybrid FTS + ILIKE search on all List pages via two new explicit metadata columns.

### Two Metadata Columns

Added to `metadata.entities`:

| Column | Type | Purpose |
|--------|------|---------|
| `fulltext_search_column` | NAME | tsvector column for FTS. Used with PostgREST `wfts` operator. |
| `substring_search_column` | NAME | Column for ILIKE substring search. Used with PostgREST `ilike` operator. |

**Why explicit columns instead of heuristics?** The existing `search_fields TEXT[]` is informational — it documents which source columns feed the tsvector but doesn't instruct search behavior. The new columns are **behavioral**: they tell the frontend exactly which columns to query and how. No auto-detection, no heuristics — integrators explicitly opt in.

**Why singular (NAME) not array (NAME[])?** One tsvector column and one ILIKE column per entity. Multiple source columns can be combined into a single generated column (e.g., `search_text = display_name || ' ' || description`). This keeps the PostgREST query construction simple.

### Hybrid or=() Query Pattern

When both columns are set, the List page constructs:

```
?or=(civic_os_text_search.wfts.query,display_name.ilike.*query*)
```

When only one is set:
- `fulltext_search_column` only → `?civic_os_text_search=wfts.query`
- `substring_search_column` only → `?display_name=ilike.*query*`

### Why Both FTS and ILIKE?

| Search Type | Strengths | Weaknesses |
|-------------|-----------|------------|
| FTS (tsvector) | Multi-word queries, stemming, ranking | No substring matching |
| ILIKE (pg_trgm) | Substring matching, prefix search | No stemming, no word-boundary awareness |

The `or=()` returns the union. PostgreSQL combines both GIN indexes via BitmapOr, which is efficient when no explicit ORDER BY is present (already true during search — DataService skips ordering).

### Index Behavior

Both GIN indexes (tsvector + trgm) produce bitmap scans:

```
BitmapOr
  -> Bitmap Index Scan on idx_my_table_fts (gin tsvector)
  -> Bitmap Index Scan on idx_my_table_trgm (gin trgm)
-> Bitmap Heap Scan on my_table
```

**Performance notes**:
- pg_trgm indexes work best for queries ≥ 3 characters (trigram minimum)
- For 1-2 character queries, PostgreSQL may fall back to sequential scan — this is expected and fast for typical table sizes
- Both indexes are maintained automatically by PostgreSQL on INSERT/UPDATE

## Frontend Architecture

### Search Gate

Search input appears when **any** search capability is configured:

```typescript
const hasSearchCapability = !!(entity?.fulltext_search_column || entity?.substring_search_column
  || (entity?.search_fields && entity.search_fields.length > 0));
```

### Query Construction

`ListPage.buildSearchParams()` constructs PostgREST query params based on which columns are set. The method strips `(),` characters from user input to prevent PostgREST parse errors in `or=()` syntax.

### Backward Compatibility

Entities with only `search_fields` set (no new columns) fall through to the legacy `DataService.searchQuery` path, which hardcodes `civic_os_text_search=wfts.{query}`. Zero migration friction.

The data migration auto-populates `fulltext_search_column = 'civic_os_text_search'` for entities that already have `search_fields` configured, so existing FTS continues working via the new code path.

## Migration Path

### New Deployments

Both columns are available from v0.55.2. Integrators configure them as part of entity setup.

### Existing Deployments

The Sqitch migration:
1. Installs `pg_trgm` extension
2. Drops `name_search_tokens()` function
3. Simplifies `civic_os_users` VIEW (removes name_search_tokens calls)
4. Adds GIN trgm index on `civic_os_users_private.display_name`
5. Adds metadata columns
6. Auto-populates `fulltext_search_column` for entities with `search_fields`
7. Updates `schema_entities` VIEW and `upsert_entity_metadata()`

The `substring_search_column` is left NULL by default — integrators opt in by setting it and (recommended) adding a trgm GIN index on the target column.

## Decision Record

- **Why pg_trgm over custom tokenization?** pg_trgm is a PostgreSQL core extension, maintained by the PG team, with native GIN index support. It handles all the edge cases (short strings, Unicode) that `name_search_tokens()` missed.
- **Why not just ILIKE everywhere?** FTS provides stemming ("running" → "run") and word-boundary awareness that ILIKE can't match. The hybrid approach gives users the best of both.
- **Why not trigram similarity (`%`) instead of ILIKE?** PostgREST doesn't expose `%` or `similarity()` as operators. ILIKE is natively supported and sufficient for the autocomplete use case.
