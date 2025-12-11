# First-Class Notes System

**Status**: Implemented
**Version**: v0.16.0
**Related**: [Entity Actions](./ENTITY_ACTIONS.md), [Notifications](./NOTIFICATIONS.md)

## Overview

A framework-level notes system that any entity can opt into via metadata configuration. Notes are polymorphic (one table serves all entities) and support both human-authored and trigger-generated content.

This feature enables internal agency staff to communicate about work items without leaving Civic OS, replacing the need for custom `<entity>_notes` tables or external tools like email/Slack.

## Key Design Principles

1. **Human-focused**: Primary use case is staff adding contextual notes, not automated activity logging
2. **API for triggers**: `create_entity_note()` RPC allows triggers to add system notes (similar to `create_notification()`)
3. **Simple formatting**: Bold, italic, links - not full Markdown (reduces complexity)
4. **Opt-in per entity**: Entities must explicitly enable notes via `metadata.entities.enable_notes`
5. **Consistent UX**: Same notes component renders on all entity Detail pages

## Use Cases

- **Internal communication**: "Waiting on additional info from citizen", "Escalated to supervisor"
- **Status context**: System-generated note when status changes: "Status changed from **Pending** to **Approved**"
- **Assignment notes**: "Assigned to me - will handle by EOD Friday"
- **Research notes**: "Called applicant, left voicemail. Will follow up tomorrow."

## Database Schema

```sql
-- ============================================================
-- Notes Table (polymorphic)
-- ============================================================
CREATE TABLE metadata.entity_notes (
    id BIGSERIAL PRIMARY KEY,

    -- Polymorphic reference to parent entity
    entity_type NAME NOT NULL,           -- Table name: 'issues', 'reservations', etc.
    entity_id TEXT NOT NULL,             -- PK of parent (text for flexibility with UUID/int)

    -- Author
    author_id UUID NOT NULL REFERENCES civic_os_users(id) ON DELETE SET NULL,

    -- Content
    content TEXT NOT NULL,

    -- Categorization
    note_type VARCHAR(50) NOT NULL DEFAULT 'note',  -- 'note' (human), 'system' (trigger)

    -- Visibility
    is_internal BOOLEAN NOT NULL DEFAULT TRUE,  -- Hide from anonymous/public views

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Soft delete (optional)
    deleted_at TIMESTAMPTZ
);

-- Indexes for common queries
CREATE INDEX idx_entity_notes_entity ON metadata.entity_notes(entity_type, entity_id);
CREATE INDEX idx_entity_notes_author ON metadata.entity_notes(author_id);
CREATE INDEX idx_entity_notes_created ON metadata.entity_notes(created_at DESC);

-- ============================================================
-- Metadata Configuration
-- ============================================================
ALTER TABLE metadata.entities ADD COLUMN enable_notes BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN metadata.entities.enable_notes IS
    'When TRUE, notes section appears on Detail pages for this entity';

-- NOTE: Permissions are managed via dedicated {entity}:notes:read and {entity}:notes:create
-- permissions in metadata.permissions. See the Permissions section for details.
```

## RPC: Create Note

```sql
-- ============================================================
-- RPC: Create Note (for humans and triggers)
-- ============================================================
CREATE OR REPLACE FUNCTION create_entity_note(
    p_entity_type NAME,
    p_entity_id TEXT,
    p_content TEXT,
    p_note_type VARCHAR DEFAULT 'note',
    p_is_internal BOOLEAN DEFAULT TRUE,
    p_author_id UUID DEFAULT NULL  -- NULL = current_user_id()
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = metadata, public
AS $$
DECLARE
    v_note_id BIGINT;
    v_author UUID;
BEGIN
    -- Determine author
    v_author := COALESCE(p_author_id, current_user_id());

    -- Validate entity type has notes enabled
    IF NOT EXISTS (
        SELECT 1 FROM metadata.entities
        WHERE table_name = p_entity_type AND enable_notes = TRUE
    ) THEN
        RAISE EXCEPTION 'Notes are not enabled for entity type: %', p_entity_type;
    END IF;

    -- Validate content not empty
    IF TRIM(p_content) = '' THEN
        RAISE EXCEPTION 'Note content cannot be empty';
    END IF;

    -- Insert note
    INSERT INTO metadata.entity_notes (
        entity_type, entity_id, author_id, content, note_type, is_internal
    ) VALUES (
        p_entity_type, p_entity_id, v_author, p_content, p_note_type, p_is_internal
    )
    RETURNING id INTO v_note_id;

    RETURN v_note_id;
END;
$$;

GRANT EXECUTE ON FUNCTION create_entity_note TO authenticated;

COMMENT ON FUNCTION create_entity_note IS
    'Create a note on any entity. Use note_type="system" for trigger-generated notes.';
```

## View: Schema Notes Configuration

```sql
-- ============================================================
-- View: Schema Notes Configuration
-- ============================================================
CREATE OR REPLACE VIEW public.schema_entity_notes_config AS
SELECT
    e.table_name,
    e.enable_notes
FROM metadata.entities e
WHERE e.enable_notes = TRUE;

GRANT SELECT ON public.schema_entity_notes_config TO web_anon, authenticated;
```

## RLS Policies

Notes use **dedicated granular permissions** (`{entity}:notes:read` and `{entity}:notes:create`) separate from entity-level permissions. This allows scenarios like "citizens can read issues but only staff can see notes."

```sql
-- ============================================================
-- RLS Policies (Dedicated Notes Permissions)
-- ============================================================
ALTER TABLE metadata.entity_notes ENABLE ROW LEVEL SECURITY;

-- Read notes: requires {entity}:notes:read permission
CREATE POLICY "Users can read notes" ON metadata.entity_notes
    FOR SELECT TO authenticated
    USING (
        has_permission(entity_type || ':notes', 'read')
        OR is_admin()
    );

-- Create notes: requires {entity}:notes:create permission
CREATE POLICY "Users can create notes" ON metadata.entity_notes
    FOR INSERT TO authenticated
    WITH CHECK (
        has_permission(entity_type || ':notes', 'create')
        OR is_admin()
    );

-- Update own notes: must be author AND have create permission
CREATE POLICY "Users can update own notes" ON metadata.entity_notes
    FOR UPDATE TO authenticated
    USING (
        author_id = current_user_id()
        AND (has_permission(entity_type || ':notes', 'create') OR is_admin())
    )
    WITH CHECK (
        author_id = current_user_id()
    );

-- Delete own notes: must be author AND have create permission
CREATE POLICY "Users can delete own notes" ON metadata.entity_notes
    FOR DELETE TO authenticated
    USING (
        author_id = current_user_id()
        AND (has_permission(entity_type || ':notes', 'create') OR is_admin())
    );
```

See the [Permissions](#permissions) section for permission setup and defaults.

## Permissions

Notes use dedicated granular permissions separate from entity-level permissions:

| Permission | Description |
|------------|-------------|
| `{entity}:notes:read` | Can view notes on this entity type |
| `{entity}:notes:create` | Can create, edit, and delete own notes |

**Examples**:
- `issues:notes:read` - Can read notes on issues
- `issues:notes:create` - Can create notes on issues
- `reservations:notes:read` - Can read notes on reservations

### Default Permission Grants

The `enable_entity_notes()` helper function creates default permissions:

| Role | Permissions |
|------|-------------|
| `user` | `{entity}:notes:read` |
| `editor` | `{entity}:notes:read`, `{entity}:notes:create` |
| `admin` | All (via `is_admin()` bypass) |

### Helper Function: enable_entity_notes()

```sql
-- ============================================================
-- Helper: Enable Notes for an Entity
-- ============================================================
CREATE OR REPLACE FUNCTION enable_entity_notes(p_entity_type NAME)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- Enable notes flag
    UPDATE metadata.entities
    SET enable_notes = TRUE
    WHERE table_name = p_entity_type;

    -- Create permissions
    INSERT INTO metadata.permissions (entity_name, action)
    VALUES
        (p_entity_type || ':notes', 'read'),
        (p_entity_type || ':notes', 'create')
    ON CONFLICT DO NOTHING;

    -- Grant to editor role by default
    INSERT INTO metadata.permission_roles (permission_id, role_id)
    SELECT p.id, r.id
    FROM metadata.permissions p
    CROSS JOIN metadata.roles r
    WHERE p.entity_name = p_entity_type || ':notes'
      AND r.name = 'editor'
    ON CONFLICT DO NOTHING;

    -- Grant read to user role
    INSERT INTO metadata.permission_roles (permission_id, role_id)
    SELECT p.id, r.id
    FROM metadata.permissions p
    CROSS JOIN metadata.roles r
    WHERE p.entity_name = p_entity_type || ':notes'
      AND p.action = 'read'
      AND r.name = 'user'
    ON CONFLICT DO NOTHING;
END;
$$;

GRANT EXECUTE ON FUNCTION enable_entity_notes TO authenticated;

COMMENT ON FUNCTION enable_entity_notes IS
    'Enable notes for an entity and create default permissions (user: read, editor: read+create)';
```

### Custom Permission Setup

For fine-grained control, manually configure permissions:

```sql
-- Grant notes access to a custom role
INSERT INTO metadata.permissions (entity_name, action)
VALUES ('issues:notes', 'read'), ('issues:notes', 'create');

INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p, metadata.roles r
WHERE p.entity_name = 'issues:notes' AND r.name = 'case_worker';
```

## Frontend Architecture

### New Files

- `src/app/components/entity-notes/entity-notes.component.ts`
- `src/app/components/entity-notes/entity-notes.component.html`
- `src/app/services/notes.service.ts`

### Modified Files

- `src/app/services/schema.service.ts` - Add `getNotesConfig()`
- `src/app/pages/detail/detail.page.ts` - Add notes section
- `src/app/pages/detail/detail.page.html` - Render notes component

### NotesService Interface

```typescript
interface EntityNote {
  id: number;
  entity_type: string;
  entity_id: string;
  author_id: string;
  author?: { id: string; display_name: string };  // Embedded via select
  content: string;
  note_type: 'note' | 'system';
  is_internal: boolean;
  created_at: string;
  updated_at: string;
}

@Injectable({ providedIn: 'root' })
export class NotesService {
  getNotes(entityType: string, entityId: string): Observable<EntityNote[]>;
  createNote(entityType: string, entityId: string, content: string): Observable<EntityNote>;
  updateNote(noteId: number, content: string): Observable<EntityNote>;
  deleteNote(noteId: number): Observable<void>;
}
```

### UI Component Features

- Notes list (newest first, paginated)
- Add note textarea with simple formatting toolbar (B, I, link)
- System notes styled differently (lighter background, robot/system icon)
- Edit/Delete buttons on own notes
- Relative timestamps ("2 hours ago")
- Author avatar and display name
- **Export button** to download notes as Excel (.xlsx)
- **Permission-aware**: Notes section only visible if user has `{entity}:notes:read`
- **Add note form** only visible if user has `{entity}:notes:create`

## Formatting Specification

### Storage Format

Notes are stored as **Markdown** in the `content` column. This provides:
- Future extensibility (can support more formatting later)
- Compatibility with external tools and exports
- Standard, well-documented format

### UI Presentation

The note editor presents **limited formatting options** to keep the UI simple and focused:

| Button | Inserts | Rendered As |
|--------|---------|-------------|
| **B** | `**text**` | **bold** |
| *I* | `*text*` | *italic* |
| 🔗 | `[text](url)` | [link](url) |

The display component renders Markdown to HTML, but only these three inline formats are recognized. Block elements (headers, lists, code blocks) are displayed as plain text.

### Rendering

| Markdown | HTML Output |
|----------|-------------|
| `**bold**` | `<strong>bold</strong>` |
| `*italic*` | `<em>italic</em>` |
| `[link text](url)` | `<a href="url" target="_blank" rel="noopener">link text</a>` |

**Security**: Sanitize HTML output to prevent XSS. Use DOMPurify or Angular's built-in sanitizer. Links open in new tab with `noopener` for security.

### Implementation Considerations

Consider adding database-level constraints for defense in depth:

```sql
-- Optional: Add constraints during implementation
ALTER TABLE metadata.entity_notes
  ADD CONSTRAINT content_not_empty CHECK (trim(content) != ''),
  ADD CONSTRAINT content_max_length CHECK (length(content) <= 10000);
```

**Note**: A Markdown syntax CHECK constraint is not recommended - Markdown is too permissive (plain text is valid Markdown), so it provides no real security benefit. Security is better enforced at render time via sanitization.

## Trigger Integration Example

```sql
-- Example: Auto-add note when status changes
CREATE OR REPLACE FUNCTION add_status_change_note()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_old_status TEXT;
    v_new_status TEXT;
BEGIN
    -- Get status display names
    SELECT display_name INTO v_old_status FROM statuses WHERE id = OLD.status_id;
    SELECT display_name INTO v_new_status FROM statuses WHERE id = NEW.status_id;

    -- Add system note
    PERFORM create_entity_note(
        p_entity_type := TG_TABLE_NAME::NAME,
        p_entity_id := NEW.id::TEXT,
        p_content := format('Status changed from **%s** to **%s**', v_old_status, v_new_status),
        p_note_type := 'system',
        p_author_id := current_user_id()
    );

    RETURN NEW;
END;
$$;

-- Attach to issues table (opt-in per entity)
CREATE TRIGGER issues_status_change_note
    AFTER UPDATE OF status_id ON issues
    FOR EACH ROW
    WHEN (OLD.status_id IS DISTINCT FROM NEW.status_id)
    EXECUTE FUNCTION add_status_change_note();
```

## Integrator Quick Start

```sql
-- 1. Enable notes for an entity (creates default permissions automatically)
SELECT enable_entity_notes('issues');

-- 2. (Optional) Add status change notes trigger
CREATE TRIGGER issues_status_change_note
    AFTER UPDATE OF status_id ON issues
    FOR EACH ROW
    WHEN (OLD.status_id IS DISTINCT FROM NEW.status_id)
    EXECUTE FUNCTION add_status_change_note();

-- 3. Done! Notes section now appears on issue Detail pages
--    - 'user' role can read notes
--    - 'editor' role can read and create notes
--    - Export button available on Detail page and List page export
```

## PostgREST API

```bash
# Get notes for an entity
GET /entity_notes?entity_type=eq.issues&entity_id=eq.123&select=*,author:civic_os_users(id,display_name)&order=created_at.desc

# Create a note (via RPC)
POST /rpc/create_entity_note
{
  "p_entity_type": "issues",
  "p_entity_id": "123",
  "p_content": "Contacted citizen, awaiting response."
}

# Update own note
PATCH /entity_notes?id=eq.456
{ "content": "Updated note content" }

# Delete own note (soft delete)
DELETE /entity_notes?id=eq.456
```

## Export Specification

Notes can be exported to Excel (.xlsx) from two locations:

### List Page Export (Bulk)

When exporting entities with notes enabled, an "Include notes" checkbox appears in the export dialog. If checked, the Excel workbook includes a second worksheet with all notes for the exported entities.

**Worksheet: Notes**

| Column | Source | Description |
|--------|--------|-------------|
| Entity ID | FK reference | Links note to parent entity |
| Note ID | `id` | Unique identifier |
| Author | `author.display_name` | Who wrote the note |
| Date | `created_at` | When note was created |
| Type | `note_type` | "Note" (human) or "System" (trigger) |
| Content | `content` | Plain text (formatting stripped) |

**Example Output**:
```
Sheet 1: "Issues"
| ID  | Display Name    | Status | ...
| 123 | Pothole on Main | Open   | ...
| 456 | Broken light    | Closed | ...

Sheet 2: "Notes"
| Entity ID | Note ID | Author | Date       | Type   | Content                        |
| 123       | 1       | Jane   | 2025-01-15 | Note   | Called citizen, left voicemail |
| 123       | 2       | System | 2025-01-16 | System | Status changed: Open → Pending |
| 456       | 3       | Bob    | 2025-01-14 | Note   | Resolved and verified          |
```

### Detail Page Export (Single Entity)

"Export Notes" button on the notes section downloads an Excel file with all notes for that entity.

**Filename**: `{entity_type}_{entity_id}_notes_{date}.xlsx`
Example: `issues_123_notes_2025-01-15.xlsx`

**Columns**: Same as bulk export, minus "Entity ID" column.

### Formatting Conversion

Simple formatting is stripped for plain text export:

| Stored | Exported |
|--------|----------|
| `**bold**` | `bold` |
| `*italic*` | `italic` |
| `[link](url)` | `link (url)` |

### Permissions

Users must have `{entity}:notes:read` permission to export notes. The export respects RLS - users only see notes they have permission to read.

## Future Enhancements (Phase 2+)

1. **@mentions**: `@username` triggers notification to mentioned user
2. **Attachments**: Link notes to files via `metadata.files`
3. **Reactions**: Quick emoji reactions to notes (👍, 👎, ✅)
4. **Threading**: Reply to specific notes (parent_note_id FK)
5. **Pin/Star**: Important notes pinned to top of list
6. **Search**: Full-text search across notes (`civic_os_text_search` column)
7. **Bulk Export**: Admin dashboard for cross-entity notes export
   - Filter by entity type, date range
   - Include soft-deleted notes option (for compliance/audit)
   - Export all notes for a user (for offboarding/GDPR)

## Design Rationale

### Why Polymorphic (Single Table)?

- **Consistency**: Same UI component, same RLS policies, same API
- **No schema changes**: Adding notes to a new entity requires only metadata update
- **Cross-entity queries**: Possible to query "all my notes" across entities
- **Follows patterns**: Matches notifications, dashboards, permissions architecture

### Why Not Full Markdown?

- **Complexity**: Full Markdown requires substantial parsing and rendering
- **Security**: More attack surface for XSS with complex HTML output
- **Use case**: Internal notes don't need headers, code blocks, tables
- **Simplicity**: Three inline formats cover 95% of use cases

### Why RPC for Creation?

- **Validation**: Ensure entity has notes enabled before inserting
- **Flexibility**: Triggers can pass explicit author_id for system notes
- **Consistency**: Matches `create_notification()` pattern
- **Future-proof**: Can add side effects (notifications, audit) without schema changes
