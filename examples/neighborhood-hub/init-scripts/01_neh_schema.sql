-- Neighborhood Engagement Hub - Base Schema
-- Exercises options_source_rpc with cascading FKs, filtered dropdowns, and M:M editors

-- ============================================================================
-- LOOKUP TABLES
-- ============================================================================

-- Tool categories (e.g., Lawn Care, Tree Trimming, Snow Removal)
CREATE TABLE tool_categories (
    id SERIAL PRIMARY KEY,
    display_name VARCHAR(100) NOT NULL,
    description TEXT,
    color hex_color DEFAULT '#3B82F6',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Tool types (e.g., Chainsaw, Push Mower - belongs to a category)
CREATE TABLE tool_types (
    id SERIAL PRIMARY KEY,
    display_name VARCHAR(100) NOT NULL,
    category_id INT NOT NULL REFERENCES tool_categories(id),
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ON tool_types(category_id);

-- Tool instances (e.g., Chainsaw #1, #2 - belongs to a type, has status)
CREATE TABLE tool_instances (
    id SERIAL PRIMARY KEY,
    display_name VARCHAR(100) NOT NULL,
    tool_type_id INT NOT NULL REFERENCES tool_types(id),
    instance_number INT NOT NULL,
    status_id INT REFERENCES metadata.statuses(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ON tool_instances(tool_type_id);
CREATE INDEX ON tool_instances(status_id);

-- ============================================================================
-- CORE ENTITIES
-- ============================================================================

-- Borrowers (community members who can borrow tools)
CREATE TABLE borrowers (
    id SERIAL PRIMARY KEY,
    display_name VARCHAR(100) NOT NULL,
    email email_address,
    phone phone_number,
    user_id UUID REFERENCES metadata.civic_os_users(id),
    status_id INT REFERENCES metadata.statuses(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX ON borrowers(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX ON borrowers(status_id);

-- Parcels (properties with eligibility category)
CREATE TABLE parcels (
    id SERIAL PRIMARY KEY,
    display_name VARCHAR(100) NOT NULL,
    parcel_number VARCHAR(50),
    eligibility INTEGER REFERENCES metadata.categories(id),
    civic_os_text_search tsvector GENERATED ALWAYS AS (
        to_tsvector('english', coalesce(display_name, '') || ' ' || coalesce(parcel_number, ''))
    ) STORED,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_parcels_eligibility ON parcels(eligibility);
CREATE INDEX idx_parcels_text_search ON parcels USING GIN(civic_os_text_search);

-- Tool reservations (borrower reserves a tool type, exercises cascading FK + filtered FK)
CREATE TABLE tool_reservations (
    id SERIAL PRIMARY KEY,
    display_name VARCHAR(100) NOT NULL,
    borrower_id INT NOT NULL REFERENCES borrowers(id),
    category_id INT NOT NULL REFERENCES tool_categories(id),
    tool_type_id INT NOT NULL REFERENCES tool_types(id),
    reserved_date DATE NOT NULL DEFAULT CURRENT_DATE,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ON tool_reservations(borrower_id);
CREATE INDEX ON tool_reservations(category_id);
CREATE INDEX ON tool_reservations(tool_type_id);

-- ============================================================================
-- M:M JUNCTION TABLE - project_parcels (exercises options_source_rpc on M:M)
-- ============================================================================

-- Projects (neighborhood improvement projects)
CREATE TABLE projects (
    id SERIAL PRIMARY KEY,
    display_name VARCHAR(100) NOT NULL,
    description TEXT,
    photos UUID REFERENCES metadata.photo_galleries(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_projects_photos ON projects(photos);

-- Junction: projects <-> parcels (M:M)
CREATE TABLE project_parcels (
    project_id INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    parcel_id INT NOT NULL REFERENCES parcels(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (project_id, parcel_id)
);
CREATE INDEX ON project_parcels(project_id);
CREATE INDEX ON project_parcels(parcel_id);
