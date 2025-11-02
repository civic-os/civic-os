-- =====================================================
-- Broader Impacts Tracking System - Full-Text Search
-- =====================================================
-- This file adds full-text search capabilities to organizations, contacts, and projects
-- using PostgreSQL's tsvector and GIN indexes

-- =====================================================
-- ADD TEXT SEARCH COLUMN TO ORGANIZATIONS
-- =====================================================

ALTER TABLE public.organizations
ADD COLUMN civic_os_text_search tsvector
GENERATED ALWAYS AS (
  to_tsvector('english',
    coalesce(display_name, '') || ' ' ||
    coalesce(description, '')
  )
) STORED;

-- Create GIN index for fast full-text search
CREATE INDEX idx_organizations_text_search
ON public.organizations
USING gin(civic_os_text_search);

-- Configure search fields in metadata
UPDATE metadata.entities
SET search_fields = ARRAY['display_name', 'description']
WHERE table_name = 'organizations';

-- =====================================================
-- ADD TEXT SEARCH COLUMN TO CONTACTS
-- =====================================================

ALTER TABLE public.contacts
ADD COLUMN civic_os_text_search tsvector
GENERATED ALWAYS AS (
  to_tsvector('english',
    coalesce(first_name, '') || ' ' ||
    coalesce(last_name, '') || ' ' ||
    coalesce(email, '')
  )
) STORED;

-- Create GIN index for fast full-text search
CREATE INDEX idx_contacts_text_search
ON public.contacts
USING gin(civic_os_text_search);

-- Configure search fields in metadata
UPDATE metadata.entities
SET search_fields = ARRAY['first_name', 'last_name', 'email']
WHERE table_name = 'contacts';

-- =====================================================
-- ADD TEXT SEARCH COLUMN TO PROJECTS
-- =====================================================

ALTER TABLE public.projects
ADD COLUMN civic_os_text_search tsvector
GENERATED ALWAYS AS (
  to_tsvector('english',
    coalesce(display_name, '') || ' ' ||
    coalesce(description, '')
  )
) STORED;

-- Create GIN index for fast full-text search
CREATE INDEX idx_projects_text_search
ON public.projects
USING gin(civic_os_text_search);

-- Configure search fields in metadata
UPDATE metadata.entities
SET search_fields = ARRAY['display_name', 'description']
WHERE table_name = 'projects';

-- =====================================================
-- NOTIFY POSTGREST
-- =====================================================

NOTIFY pgrst, 'reload schema';
