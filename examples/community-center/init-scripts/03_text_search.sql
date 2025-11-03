-- ============================================================================
-- TEXT SEARCH CONFIGURATION
-- Adds full-text search to community center tables
-- ============================================================================

-- Add text search to resources
ALTER TABLE resources
  ADD COLUMN civic_os_text_search TSVECTOR
    GENERATED ALWAYS AS (
      setweight(to_tsvector('english', coalesce(display_name, '')), 'A') ||
      setweight(to_tsvector('english', coalesce(description, '')), 'B')
    ) STORED;

CREATE INDEX idx_resources_text_search ON resources USING GIN (civic_os_text_search);

UPDATE metadata.entities
SET search_fields = ARRAY['display_name', 'description']
WHERE table_name = 'resources';

-- Add text search to reservations
ALTER TABLE reservations
  ADD COLUMN civic_os_text_search TSVECTOR
    GENERATED ALWAYS AS (
      setweight(to_tsvector('english', coalesce(purpose, '')), 'A') ||
      setweight(to_tsvector('english', coalesce(notes, '')), 'B')
    ) STORED;

CREATE INDEX idx_reservations_text_search ON reservations USING GIN (civic_os_text_search);

UPDATE metadata.entities
SET search_fields = ARRAY['purpose', 'notes']
WHERE table_name = 'reservations';

-- Add text search to reservation_requests
ALTER TABLE reservation_requests
  ADD COLUMN civic_os_text_search TSVECTOR
    GENERATED ALWAYS AS (
      setweight(to_tsvector('english', coalesce(purpose, '')), 'A') ||
      setweight(to_tsvector('english', coalesce(notes, '')), 'B') ||
      setweight(to_tsvector('english', coalesce(denial_reason, '')), 'C')
    ) STORED;

CREATE INDEX idx_reservation_requests_text_search ON reservation_requests USING GIN (civic_os_text_search);

UPDATE metadata.entities
SET search_fields = ARRAY['purpose', 'notes', 'denial_reason']
WHERE table_name = 'reservation_requests';
