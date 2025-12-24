# System Introspection & Documentation Architecture

## Overview

This document describes a comprehensive introspection system that exposes the internal workings of a Civic OS instance to support:

1. **Auto-generated user documentation** - Understanding what an instance does
2. **Dependency visualization** - Seeing how entities relate behaviorally (not just structurally)
3. **Safe function exposure** - Documenting RPCs without exposing source code

**Key Innovation**: Use static code analysis to automatically extract entity dependencies from function bodies.

---

## Development Phases

### Phase A: Core Infrastructure (v0.23.0)

Database-only implementation - can be fully tested via PostgREST without frontend changes.

| Component | Description |
|-----------|-------------|
| Core Tables | `rpc_functions`, `database_triggers`, `rpc_entity_effects`, `trigger_entity_effects`, `notification_triggers` |
| Static Analysis | `analyze_function_dependencies()` function to parse function bodies |
| Public Views | `schema_functions`, `schema_triggers`, `schema_entity_dependencies`, `schema_notifications`, `schema_permissions_matrix` |
| Cache Versioning | Add `introspection` cache type to `schema_cache_versions` |

### Phase B: Frontend & Documentation (Future)

Angular integration and documentation generation.

| Component | Description |
|-----------|-------------|
| IntrospectionService | Angular service consuming new views |
| Schema Editor Enhancement | Documentation tab in inspector panel |
| Documentation Page | `/documentation` route with entity browser |
| Markdown Generation | Server-side RPCs for documentation export |

---

## Phase A: Database Schema

### A.1 RPC Function Registry

```sql
CREATE TABLE metadata.rpc_functions (
    function_name NAME PRIMARY KEY,
    schema_name NAME NOT NULL DEFAULT 'public',
    display_name VARCHAR(100) NOT NULL,
    description TEXT,
    category VARCHAR(50),  -- 'workflow', 'crud', 'utility', 'payment', 'notification'
    parameters JSONB,      -- [{"name": "p_id", "type": "BIGINT", "description": "..."}]
    returns_type VARCHAR(100),
    returns_description TEXT,
    is_idempotent BOOLEAN DEFAULT FALSE,
    minimum_role VARCHAR(50),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE metadata.rpc_functions IS
    'Registry of RPC functions with documentation for auto-generated user guides.
     Functions must be explicitly registered; this is opt-in, not auto-discovery.';
```

### A.2 Trigger Registry

```sql
CREATE TABLE metadata.database_triggers (
    trigger_name NAME NOT NULL,
    table_name NAME NOT NULL,
    schema_name NAME NOT NULL DEFAULT 'public',
    timing VARCHAR(10) NOT NULL,     -- 'BEFORE', 'AFTER'
    events VARCHAR(20)[] NOT NULL,   -- ['INSERT', 'UPDATE', 'DELETE']
    function_name NAME NOT NULL,
    display_name VARCHAR(100),
    description TEXT NOT NULL,
    purpose VARCHAR(50),  -- 'audit', 'validation', 'cascade', 'notification', 'workflow'
    is_enabled BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (trigger_name, table_name, schema_name)
);

COMMENT ON TABLE metadata.database_triggers IS
    'Registry of database triggers with human-readable documentation.
     Triggers must be explicitly registered for documentation purposes.';
```

### A.3 Entity Effects Tables

Track what entities each function/trigger modifies:

```sql
-- RPC → Entity effects
CREATE TABLE metadata.rpc_entity_effects (
    id SERIAL PRIMARY KEY,
    function_name NAME NOT NULL REFERENCES metadata.rpc_functions(function_name) ON DELETE CASCADE,
    entity_table NAME NOT NULL,
    effect_type VARCHAR(20) NOT NULL,  -- 'create', 'read', 'update', 'delete'
    description TEXT,
    is_auto_detected BOOLEAN DEFAULT FALSE,  -- TRUE if from static analysis
    UNIQUE (function_name, entity_table, effect_type)
);

-- Trigger → Entity effects
CREATE TABLE metadata.trigger_entity_effects (
    id SERIAL PRIMARY KEY,
    trigger_name NAME NOT NULL,
    trigger_table NAME NOT NULL,
    trigger_schema NAME NOT NULL DEFAULT 'public',
    affected_table NAME NOT NULL,
    effect_type VARCHAR(20) NOT NULL,
    description TEXT,
    is_auto_detected BOOLEAN DEFAULT FALSE,
    FOREIGN KEY (trigger_name, trigger_table, trigger_schema)
        REFERENCES metadata.database_triggers ON DELETE CASCADE
);
```

### A.4 Notification Documentation

```sql
CREATE TABLE metadata.notification_triggers (
    id SERIAL PRIMARY KEY,
    trigger_type VARCHAR(20) NOT NULL,   -- 'rpc', 'trigger', 'manual'
    source_function NAME,                 -- RPC or trigger function
    source_table NAME,
    template_id INT REFERENCES metadata.notification_templates(id),
    trigger_condition TEXT,               -- Human-readable
    recipient_description TEXT,
    description TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

### A.5 Scheduled Jobs Integration

Link RPC functions to their scheduled execution via `metadata.scheduled_jobs` (v0.22.0+). This enables introspection of which functions run on schedules.

**Approach:** Since `scheduled_jobs.function_name` already references the RPC, we can join directly without additional tables.

```sql
-- View: schema_scheduled_functions
-- Shows RPCs that run on a schedule with execution statistics
CREATE OR REPLACE VIEW public.schema_scheduled_functions
WITH (security_invoker = true) AS
SELECT
    rf.function_name,
    rf.display_name,
    rf.description,
    rf.category,
    sj.name AS job_name,
    sj.schedule AS cron_schedule,
    sj.timezone,
    sj.enabled AS schedule_enabled,
    sj.last_run_at,
    sjs.last_run_success,
    sjs.success_rate_percent
FROM metadata.rpc_functions rf
JOIN metadata.scheduled_jobs sj ON sj.function_name = rf.function_name::VARCHAR(200)
LEFT JOIN public.scheduled_job_status sjs ON sjs.id = sj.id
WHERE public.is_admin();  -- Admin-only for schedule details

GRANT SELECT ON public.schema_scheduled_functions TO authenticated;
```

**Update `schema_functions`** to include a schedule indicator:

```sql
-- Add to schema_functions SELECT clause:
EXISTS (
    SELECT 1 FROM metadata.scheduled_jobs sj
    WHERE sj.function_name = rf.function_name::VARCHAR(200)
      AND sj.enabled = true
) AS has_active_schedule
```

---

## Static Code Analysis

### Function Body Parser

Parses `pg_proc.prosrc` to extract table references with confidence levels:

```sql
CREATE OR REPLACE FUNCTION metadata.analyze_function_dependencies(p_function_name NAME)
RETURNS TABLE (
    table_name NAME,
    effect_type VARCHAR(20),
    confidence VARCHAR(20)  -- 'high', 'medium', 'low'
)
LANGUAGE plpgsql AS $$
DECLARE
    v_source TEXT;
    v_patterns JSONB := '[
        {"pattern": "INSERT INTO\\s+(\\w+)", "effect": "create", "confidence": "high"},
        {"pattern": "UPDATE\\s+(\\w+)", "effect": "update", "confidence": "high"},
        {"pattern": "DELETE FROM\\s+(\\w+)", "effect": "delete", "confidence": "high"},
        {"pattern": "SELECT .* FROM\\s+(\\w+)", "effect": "read", "confidence": "medium"},
        {"pattern": "JOIN\\s+(\\w+)", "effect": "read", "confidence": "medium"}
    ]'::jsonb;
    v_pattern RECORD;
    v_matches TEXT[];
BEGIN
    -- Get function source from pg_proc (not exposed to users)
    SELECT p.prosrc INTO v_source
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE p.proname = p_function_name AND n.nspname = 'public';

    IF v_source IS NULL THEN
        RETURN;
    END IF;

    -- Extract matches for each pattern
    FOR v_pattern IN SELECT * FROM jsonb_array_elements(v_patterns) LOOP
        FOR v_matches IN
            SELECT regexp_matches(v_source, v_pattern->>'pattern', 'gi')
        LOOP
            RETURN QUERY SELECT
                v_matches[1]::NAME,
                (v_pattern->>'effect')::VARCHAR(20),
                (v_pattern->>'confidence')::VARCHAR(20);
        END LOOP;
    END LOOP;
END;
$$;
```

### Auto-Registration Helper

```sql
CREATE OR REPLACE FUNCTION metadata.auto_register_function(
    p_function_name NAME,
    p_display_name VARCHAR(100) DEFAULT NULL,
    p_description TEXT DEFAULT NULL,
    p_category VARCHAR(50) DEFAULT 'utility'
)
RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE
    v_dep RECORD;
BEGIN
    -- Insert or update function metadata
    INSERT INTO metadata.rpc_functions (function_name, display_name, description, category)
    VALUES (
        p_function_name,
        COALESCE(p_display_name, p_function_name::VARCHAR(100)),
        p_description,
        p_category
    )
    ON CONFLICT (function_name) DO UPDATE SET
        display_name = COALESCE(EXCLUDED.display_name, metadata.rpc_functions.display_name),
        description = COALESCE(EXCLUDED.description, metadata.rpc_functions.description),
        updated_at = NOW();

    -- Auto-detect entity effects from function body
    FOR v_dep IN SELECT * FROM metadata.analyze_function_dependencies(p_function_name) LOOP
        INSERT INTO metadata.rpc_entity_effects
            (function_name, entity_table, effect_type, is_auto_detected)
        VALUES (p_function_name, v_dep.table_name, v_dep.effect_type, TRUE)
        ON CONFLICT (function_name, entity_table, effect_type) DO NOTHING;
    END LOOP;
END;
$$;
```

### Bulk Registration

```sql
CREATE OR REPLACE FUNCTION metadata.auto_register_all_rpcs()
RETURNS TABLE (function_name NAME, effects_found INT)
LANGUAGE plpgsql AS $$
DECLARE
    v_func RECORD;
    v_count INT;
BEGIN
    FOR v_func IN
        SELECT p.proname
        FROM pg_proc p
        JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = 'public'
          AND p.prokind = 'f'
          AND p.proname NOT LIKE 'pg_%'
          AND p.proname NOT LIKE 'schema_%'
    LOOP
        PERFORM metadata.auto_register_function(v_func.proname);

        SELECT COUNT(*) INTO v_count
        FROM metadata.rpc_entity_effects
        WHERE rpc_entity_effects.function_name = v_func.proname;

        function_name := v_func.proname;
        effects_found := v_count;
        RETURN NEXT;
    END LOOP;
END;
$$;
```

---

## Permission Model

### Design Philosophy: Partial Visibility

Users see metadata for things they can interact with, but with **filtered details**:

- **Function/trigger exists**: Visible if user can execute OR if it's on a table they can read
- **Entity effects**: Filtered to only show tables the user can read
- **Hidden count**: `hidden_effects_count` field provides transparency without disclosure
- **Permissions matrix**: Admin-only (reveals full RBAC structure)

### Permission Matrix

| View | Visibility Rule | Entity Effects |
|------|-----------------|----------------|
| `schema_functions` | Show if user can execute OR any affected table is readable | Filter to readable tables; show `hidden_effects_count` |
| `schema_triggers` | Show if user can read the trigger's source table | Filter to readable tables |
| `schema_entity_dependencies` | Show if user can read source entity | Filter to readable target entities |
| `schema_notifications` | Show if user can read the source table | Show template name |
| `schema_permissions_matrix` | **Admin only** | N/A |

### Anonymous Access

Anonymous users can see metadata for tables with `anonymous:read` permission, enabling public documentation.

---

## Public Views

### schema_functions

```sql
CREATE OR REPLACE VIEW public.schema_functions
WITH (security_invoker = true) AS
SELECT
    rf.function_name,
    rf.schema_name,
    rf.display_name,
    rf.description,
    rf.category,
    rf.parameters,
    rf.returns_type,
    rf.returns_description,
    rf.is_idempotent,
    rf.minimum_role,

    -- Filtered entity effects (only readable tables)
    COALESCE(
        jsonb_agg(DISTINCT jsonb_build_object(
            'table', ree.entity_table,
            'effect', ree.effect_type,
            'auto_detected', ree.is_auto_detected,
            'description', ree.description
        )) FILTER (
            WHERE ree.id IS NOT NULL
              AND public.has_permission(ree.entity_table, 'read')
        ),
        '[]'::jsonb
    ) AS entity_effects,

    -- Count of hidden effects (transparency without disclosure)
    COUNT(*) FILTER (
        WHERE ree.id IS NOT NULL
          AND NOT public.has_permission(ree.entity_table, 'read')
    ) AS hidden_effects_count,

    -- Permission check
    CASE
        WHEN EXISTS (SELECT 1 FROM metadata.protected_rpcs pr WHERE pr.rpc_function = rf.function_name)
        THEN public.has_rpc_permission(rf.function_name)
        ELSE true
    END AS can_execute

FROM metadata.rpc_functions rf
LEFT JOIN metadata.rpc_entity_effects ree ON ree.function_name = rf.function_name
WHERE
    -- Show if user can execute (including SECURITY DEFINER functions)
    (NOT EXISTS (SELECT 1 FROM metadata.protected_rpcs pr WHERE pr.rpc_function = rf.function_name)
     OR public.has_rpc_permission(rf.function_name))
    -- OR if user can read any affected table
    OR EXISTS (
        SELECT 1 FROM metadata.rpc_entity_effects ree2
        WHERE ree2.function_name = rf.function_name
          AND public.has_permission(ree2.entity_table, 'read')
    )
GROUP BY rf.function_name, rf.schema_name, rf.display_name, rf.description,
         rf.category, rf.parameters, rf.returns_type, rf.returns_description,
         rf.is_idempotent, rf.minimum_role;
```

### schema_triggers

```sql
CREATE OR REPLACE VIEW public.schema_triggers
WITH (security_invoker = true) AS
SELECT
    dt.trigger_name,
    dt.table_name,
    dt.timing,
    dt.events,
    dt.function_name,
    dt.display_name,
    dt.description,
    dt.purpose,
    dt.is_enabled,

    COALESCE(
        jsonb_agg(DISTINCT jsonb_build_object(
            'table', tee.affected_table,
            'effect', tee.effect_type,
            'auto_detected', tee.is_auto_detected
        )) FILTER (
            WHERE tee.id IS NOT NULL
              AND public.has_permission(tee.affected_table, 'read')
        ),
        '[]'::jsonb
    ) AS entity_effects,

    COUNT(*) FILTER (
        WHERE tee.id IS NOT NULL
          AND NOT public.has_permission(tee.affected_table, 'read')
    ) AS hidden_effects_count

FROM metadata.database_triggers dt
LEFT JOIN metadata.trigger_entity_effects tee
    ON tee.trigger_name = dt.trigger_name AND tee.trigger_table = dt.table_name
WHERE public.has_permission(dt.table_name, 'read')
GROUP BY dt.trigger_name, dt.table_name, dt.timing, dt.events,
         dt.function_name, dt.display_name, dt.description, dt.purpose, dt.is_enabled;
```

### schema_entity_dependencies (Dependency Graph)

This unified view exposes all entity relationships - both structural (FK, M:M) and behavioral (RPC, trigger effects).

**Relationship Types:**
| Type | Category | `via_object` Contains |
|------|----------|----------------------|
| `foreign_key` | structural | NULL (column is in `via_column`) |
| `many_to_many` | structural | Junction table name |
| `rpc_modifies` | behavioral | RPC function name |
| `trigger_modifies` | behavioral | Trigger function name |

```sql
CREATE OR REPLACE VIEW public.schema_entity_dependencies
WITH (security_invoker = true) AS
WITH
-- Foreign key relationships (structural)
fk_deps AS (
    SELECT DISTINCT
        tc.table_name AS source_entity,
        ccu.table_name AS target_entity,
        'foreign_key' AS relationship_type,
        kcu.column_name AS via_column,
        NULL::NAME AS via_object,
        'structural' AS category
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
    JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
    WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
),
-- Many-to-many relationships (structural) - detected from junction tables
-- Junction table criteria: exactly 2 FKs to public schema + only metadata columns
m2m_deps AS (
    WITH junction_candidates AS (
        SELECT
            sp.table_name AS junction_table,
            array_agg(sp.column_name ORDER BY sp.column_name) AS fk_columns,
            array_agg(sp.join_table ORDER BY sp.column_name) AS related_tables
        FROM schema_properties sp
        WHERE sp.join_table IS NOT NULL
          AND sp.join_schema = 'public'
        GROUP BY sp.table_name
        HAVING COUNT(*) = 2
    ),
    validated_junctions AS (
        SELECT jc.*
        FROM junction_candidates jc
        WHERE NOT EXISTS (
            SELECT 1 FROM schema_properties sp
            WHERE sp.table_name = jc.junction_table
              AND sp.column_name NOT IN (
                  'id', 'created_at', 'updated_at',
                  jc.fk_columns[1], jc.fk_columns[2]
              )
        )
    )
    -- Direction 1: table[1] -> table[2]
    SELECT
        vj.related_tables[1]::NAME AS source_entity,
        vj.related_tables[2]::NAME AS target_entity,
        'many_to_many'::TEXT AS relationship_type,
        vj.fk_columns[1]::TEXT AS via_column,
        vj.junction_table::NAME AS via_object,  -- Junction table name
        'structural'::TEXT AS category
    FROM validated_junctions vj
    UNION ALL
    -- Direction 2: table[2] -> table[1] (bidirectional)
    SELECT
        vj.related_tables[2]::NAME AS source_entity,
        vj.related_tables[1]::NAME AS target_entity,
        'many_to_many'::TEXT AS relationship_type,
        vj.fk_columns[2]::TEXT AS via_column,
        vj.junction_table::NAME AS via_object,
        'structural'::TEXT AS category
    FROM validated_junctions vj
),
-- RPC effects (behavioral)
rpc_deps AS (
    SELECT DISTINCT
        ea.table_name AS source_entity,
        ree.entity_table AS target_entity,
        'rpc_modifies' AS relationship_type,
        NULL::TEXT AS via_column,
        rf.function_name AS via_object,  -- RPC function name
        'behavioral' AS category
    FROM metadata.entity_actions ea
    JOIN metadata.rpc_functions rf ON rf.function_name = ea.rpc_function
    JOIN metadata.rpc_entity_effects ree ON ree.function_name = rf.function_name
    WHERE ree.entity_table != ea.table_name AND ree.effect_type != 'read'
),
-- Trigger effects (behavioral)
trigger_deps AS (
    SELECT DISTINCT
        dt.table_name AS source_entity,
        tee.affected_table AS target_entity,
        'trigger_modifies' AS relationship_type,
        NULL::TEXT AS via_column,
        dt.function_name AS via_object,  -- Trigger function name
        'behavioral' AS category
    FROM metadata.database_triggers dt
    JOIN metadata.trigger_entity_effects tee ON tee.trigger_name = dt.trigger_name
    WHERE tee.affected_table != dt.table_name
),
all_deps AS (
    SELECT * FROM fk_deps
    UNION ALL SELECT * FROM m2m_deps
    UNION ALL SELECT * FROM rpc_deps
    UNION ALL SELECT * FROM trigger_deps
)
SELECT *
FROM all_deps
WHERE public.has_permission(source_entity, 'read')
  AND public.has_permission(target_entity, 'read');
```

**Column Semantics:**
- `via_column`: The FK column name (for `foreign_key` and `many_to_many` types)
- `via_object`: The intermediary object name - junction table for M:M, function name for RPC/trigger effects

### schema_notifications

```sql
CREATE OR REPLACE VIEW public.schema_notifications
WITH (security_invoker = true) AS
SELECT
    nt.id,
    nt.trigger_type,
    nt.source_function,
    nt.source_table,
    t.name AS template_name,
    t.channel,
    t.subject,
    nt.trigger_condition,
    nt.recipient_description,
    nt.description
FROM metadata.notification_triggers nt
JOIN metadata.notification_templates t ON t.id = nt.template_id
WHERE public.has_permission(nt.source_table, 'read');
```

### schema_permissions_matrix (Admin Only)

```sql
CREATE OR REPLACE VIEW public.schema_permissions_matrix
WITH (security_invoker = true) AS
SELECT
    e.table_name,
    e.display_name AS entity_name,
    r.id AS role_id,
    r.display_name AS role_name,
    COALESCE(bool_or(p.permission = 'create' AND pr.role_id IS NOT NULL), false) AS can_create,
    COALESCE(bool_or(p.permission = 'read' AND pr.role_id IS NOT NULL), false) AS can_read,
    COALESCE(bool_or(p.permission = 'update' AND pr.role_id IS NOT NULL), false) AS can_update,
    COALESCE(bool_or(p.permission = 'delete' AND pr.role_id IS NOT NULL), false) AS can_delete
FROM metadata.entities e
CROSS JOIN metadata.roles r
LEFT JOIN metadata.permissions p ON p.table_name = e.table_name
LEFT JOIN metadata.permission_roles pr ON pr.permission_id = p.id AND pr.role_id = r.id
WHERE public.is_admin()  -- Admin-only
GROUP BY e.table_name, e.display_name, e.sort_order, r.id, r.display_name
ORDER BY e.sort_order, r.id;
```

---

## Cache Versioning Integration

Add `introspection` cache type to existing system:

```sql
-- Update schema_cache_versions view
DROP VIEW IF EXISTS public.schema_cache_versions;

CREATE VIEW public.schema_cache_versions AS
SELECT 'entities' AS cache_name,
       GREATEST(
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.entities),
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.permissions),
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.roles),
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.permission_roles)
       ) AS version
UNION ALL
SELECT 'properties' AS cache_name,
       GREATEST(
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.properties),
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.validations)
       ) AS version
UNION ALL
SELECT 'constraint_messages' AS cache_name,
       (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.constraint_messages) AS version
UNION ALL
-- NEW: Introspection cache
SELECT 'introspection' AS cache_name,
       GREATEST(
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.rpc_functions),
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.database_triggers),
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.rpc_entity_effects),
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.trigger_entity_effects),
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.notification_triggers)
       ) AS version;

GRANT SELECT ON public.schema_cache_versions TO web_anon, authenticated;
```

---

## Testing with Local Keycloak

### Add to docker-compose.yml

```yaml
  keycloak:
    image: quay.io/keycloak/keycloak:26.0
    command: start-dev
    environment:
      KEYCLOAK_ADMIN: admin
      KEYCLOAK_ADMIN_PASSWORD: admin
    ports:
      - "8080:8080"
    networks:
      - app-network
```

### Test Users

| User | Password | Roles | Purpose |
|------|----------|-------|---------|
| `admin@test.com` | `admin123` | `admin` | Full introspection access |
| `editor@test.com` | `editor123` | `editor` | Partial access |
| `user@test.com` | `user123` | `user` | Read-only on most tables |

### Get Tokens

```bash
# Admin token
curl -X POST "http://localhost:8080/realms/civic-os-test/protocol/openid-connect/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "client_id=civic-os-frontend" \
  -d "username=admin@test.com" \
  -d "password=admin123" \
  -d "grant_type=password" \
  | jq -r '.access_token'
```

### Test Matrix

| Test Case | Admin | Editor | User | Anonymous |
|-----------|-------|--------|------|-----------|
| `schema_permissions_matrix` returns rows | Yes | No | No | No |
| `schema_functions` shows all functions | Yes | Filtered | Filtered | Filtered |
| `schema_functions.entity_effects` complete | Yes | Partial | Partial | Partial |
| `schema_functions.hidden_effects_count` accurate | Yes | Yes | Yes | Yes |

---

## Example Registration SQL

```sql
-- Register an RPC function with documentation
SELECT metadata.auto_register_function(
    'approve_reservation_request',
    'Approve Request',
    'Approves a pending reservation request and creates the corresponding reservation.',
    'workflow'
);

-- Register a trigger
INSERT INTO metadata.database_triggers
    (trigger_name, table_name, timing, events, function_name, display_name, description, purpose)
VALUES
    ('handle_reservation_request_approval', 'reservation_requests', 'BEFORE', ARRAY['UPDATE'],
     'handle_reservation_request_approval', 'Auto-Create Reservation',
     'When request is approved, creates corresponding reservation record', 'workflow');

-- Run bulk auto-registration
SELECT * FROM metadata.auto_register_all_rpcs();
```

---

## Security Considerations

1. **No source code exposure**: Views expose curated descriptions, not `pg_proc.prosrc`
2. **Permission-aware**: Filtered visibility based on table-level read permissions
3. **Partial visibility**: Functions visible if executable, but effects filtered to accessible tables
4. **Hidden count**: Users see `hidden_effects_count` for transparency
5. **Admin-only matrix**: `schema_permissions_matrix` restricted to admins
6. **Anonymous support**: Can see metadata for publicly-readable entities
7. **Security invoker**: All views use `security_invoker = true`

---

## Future Angular Refactoring Opportunities

When Phase B is implemented, existing Angular components could use new views:

| Component | Current | Opportunity |
|-----------|---------|-------------|
| Schema Editor | Computes relationships in-memory | Use `schema_entity_dependencies` including behavioral dependencies |
| Permissions Page | Builds matrix in Angular | Use `schema_permissions_matrix` view |
| Detail Page | Shows entity actions | Show "What happens when..." tooltips from `schema_functions` |
| VersionService | Caches entities/properties | Add `introspection` cache type |

---

## Implementation Checklist

### Migration: `v0-23-0-system-introspection.sql`

**Tables:**
- [ ] `metadata.rpc_functions` (with `updated_at` + trigger)
- [ ] `metadata.database_triggers` (with `updated_at` + trigger)
- [ ] `metadata.rpc_entity_effects` (with `updated_at` + trigger)
- [ ] `metadata.trigger_entity_effects` (with `updated_at` + trigger)
- [ ] `metadata.notification_triggers` (with `updated_at` + trigger)

**Functions:**
- [ ] `metadata.analyze_function_dependencies(NAME)`
- [ ] `metadata.auto_register_function(NAME, ...)`
- [ ] `metadata.auto_register_all_rpcs()`

**Views:**
- [ ] `public.schema_functions` (with permission filtering + `has_active_schedule` column)
- [ ] `public.schema_triggers`
- [ ] `public.schema_entity_dependencies` (with `m2m_deps` CTE for M:M detection)
- [ ] `public.schema_notifications`
- [ ] `public.schema_permissions_matrix` (admin-only)
- [ ] `public.schema_scheduled_functions` (admin-only, shows schedule details)
- [ ] Update `public.schema_cache_versions`

**Grants:**
- [ ] SELECT on all new views to `authenticated`, `web_anon`

**Frontend (Phase B):**
- [ ] Simplify `SchemaService.detectJunctionTables()` to use `schema_entity_dependencies` filtered by `relationship_type = 'many_to_many'`

---

## Cross-System References (Already Available)

Many cross-system feature references are already exposed through existing views and don't require new introspection tables:

**Available via `schema_entities`:**

| Feature | Column(s) |
|---------|-----------|
| Payments | `payment_initiation_rpc`, `payment_capture_mode` |
| Calendar | `show_calendar`, `calendar_property_name`, `calendar_color_property` |
| Maps | `show_map`, `map_property_name` |
| Recurring | `supports_recurring`, `recurring_property_name` |
| Notes | `enable_notes` |
| Full-Text Search | `search_fields` |

**Available via `schema_properties`:**

| Feature | Detection Method |
|---------|-----------------|
| File storage | `join_table = 'files'` indicates file FK |
| Status type | `status_entity_type` column |
| Recurring properties | `is_recurring` column |
| Validations | `validation_rules` JSONB array |

---

## Future Considerations

The following enhancements are out of scope for v0.23.0 but could enrich introspection in future releases:

### Dashboard & Widget References
- Which dashboards reference which entities via `filtered_list`, `map`, `calendar` widgets
- Would require new view joining `metadata.dashboard_widgets` to entity references in widget config JSONB

### Notification Template → Entity Mapping
- Which notification templates reference which entities in their Go template bodies
- Would require template parsing or explicit metadata column

### RLS Policy Documentation
- Human-readable descriptions of Row Level Security policies
- Currently available in `pg_policies` but without documentation layer
- Could parse policy expressions for common patterns (e.g., "user can only see own records")

### Index Coverage Reporting
- Whether FK columns have required indexes (per CLAUDE.md best practice requirements)
- Would help integrators verify schema configuration
- Could flag missing indexes as warnings in documentation

### Validation Rule Documentation
- Expose `metadata.validations` as dedicated introspection view
- Currently only embedded in `schema_properties.validation_rules`
- Could include constraint message lookups from `metadata.constraint_messages`

### Static Analysis Improvements
- Detect dynamic SQL patterns (`EXECUTE`, `format()`) and flag for manual review
- Handle schema-qualified table references (e.g., `metadata.users`)
- Parse CTEs with DML operations
- Add `requires_manual_review` flag to effects with low confidence

---

## License

Copyright (C) 2023-2025 Civic OS, L3C. Licensed under AGPL-3.0-or-later.
