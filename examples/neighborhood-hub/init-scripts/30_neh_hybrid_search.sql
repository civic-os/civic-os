-- Neighborhood Engagement Hub - Hybrid Search (v0.55.2)
-- Configures fulltext_search_column and substring_search_column for all
-- searchable entities, and adds pg_trgm GIN indexes for large tables.
--
-- The Sqitch migration (v0-55-2) auto-populates fulltext_search_column for
-- entities with search_fields on UPGRADE, but init scripts run AFTER migrations
-- on fresh deploys (when metadata.entities is still empty). This script ensures
-- both columns are set regardless of deploy path.

BEGIN;

-- ============================================================================
-- ENTITIES WITH TSVECTOR COLUMNS (hybrid FTS + ILIKE)
-- ============================================================================

-- Parcels (70K+ rows) — full hybrid search, trgm index essential
UPDATE metadata.entities SET
  fulltext_search_column = 'civic_os_text_search',
  substring_search_column = 'display_name'
WHERE table_name = 'parcels';

CREATE INDEX IF NOT EXISTS idx_parcels_name_trgm
  ON parcels USING gin (display_name gin_trgm_ops);

-- Borrowers — full hybrid search, trgm index recommended for phone/name autocomplete
UPDATE metadata.entities SET
  fulltext_search_column = 'civic_os_text_search',
  substring_search_column = 'display_name'
WHERE table_name = 'borrowers';

CREATE INDEX IF NOT EXISTS idx_borrowers_name_trgm
  ON borrowers USING gin (display_name gin_trgm_ops);

-- Census Block Groups — substring only. FTS adds no value here: users search
-- by partial GEOID ("26049") which is a substring match, not a word boundary.
-- The tsvector exists but covers "Block Group 260490001001" — nobody searches
-- for "Block Group" and GEOIDs don't benefit from stemming.
UPDATE metadata.entities SET
  fulltext_search_column = NULL,
  substring_search_column = 'display_name'
WHERE table_name = 'census_block_groups';

-- ============================================================================
-- ENTITIES WITHOUT TSVECTOR COLUMNS (substring search only)
-- These tables are small (<1K rows) so ILIKE without a trgm index is fine.
-- fulltext_search_column is cleared since there's no tsvector column to query.
-- ============================================================================

UPDATE metadata.entities SET
  fulltext_search_column = NULL,
  substring_search_column = 'display_name'
WHERE table_name IN (
  'tool_types',
  'tool_instances',
  'tool_reservations',
  'projects',
  'training_records'
);

COMMIT;
