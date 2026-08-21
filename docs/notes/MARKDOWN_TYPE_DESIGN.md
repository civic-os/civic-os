# Markdown Property Type & Newsletter System -- Design Notes

> **Version**: v0.70.0
> **Status**: Implemented
> **Author**: Daniel Kurin

## Overview

Markdown is a new `EntityPropertyType` (enum value 27) backed by a PostgreSQL domain `CREATE DOMAIN markdown AS TEXT`. It enables rich-text content authoring on any entity column with WYSIWYG editing on the frontend and CommonMark rendering in both the browser and Go worker (for email notifications).

The client-intake example includes a **Newsletter system** that demonstrates the Markdown type in a real-world email campaign use case, built entirely from existing Civic OS primitives.

## Domain Detection

The `schema_properties` VIEW automatically resolves PostgreSQL domain names via:

```sql
COALESCE(pg_type_info.domain_name, columns.udt_name)
```

This means the frontend sees `udt_name = 'markdown'` without any VIEW modifications. `SchemaService.getPropertyType()` detects it via the existing domain detection pattern -- the same mechanism used for `hex_color`, `email_address`, `phone_number`, and `time_slot`.

## Frontend Architecture

### Display

Uses `ngx-markdown`'s `<markdown [data]>` component, the same library already in use for Static Text Blocks and Entity Notes. Markdown content renders identically everywhere it appears in the application.

### Edit: MarkdownEditorComponent

A custom `MarkdownEditorComponent` wrapping the TipTap WYSIWYG editor.

```
EditPropertyComponent
    └── @defer block (loading gate)
            └── MarkdownEditorComponent (ControlValueAccessor)
                    └── TipTap Editor instance
                            ├── StarterKit (bold, italic, heading, lists, code, blockquote)
                            ├── Link extension (auto-detect URLs)
                            └── @tiptap/markdown (bidirectional conversion)
```

**Key implementation details:**

- **ControlValueAccessor pattern**: Same approach as `EditTimeSlotComponent`. The component implements `ControlValueAccessor` to integrate with Angular reactive forms, providing `writeValue()`, `registerOnChange()`, and `registerOnTouched()` callbacks.

- **Lazy loading**: Uses `@defer` block plus dynamic `import()` in `ngAfterViewInit()`, following the same pattern as `BlocklyViewerComponent`. This keeps the TipTap bundle (~150KB gzipped) out of the main bundle entirely.

- **Zone isolation**: The TipTap editor instance runs outside Angular's zone (`NgZone.runOutsideAngular()`) for performance. Editor content changes are marshalled back into the zone only when the CVA `onChange` callback fires.

- **Toolbar**: DaisyUI-styled toolbar with `role="toolbar"` and `aria-pressed` attributes on toggle buttons for accessibility compliance. Toolbar buttons map to TipTap commands (`toggleBold()`, `toggleItalic()`, `toggleHeading({ level })`, etc.).

- **Bidirectional markdown conversion**: `@tiptap/markdown` handles the round-trip:
  - **Read**: `editor.commands.setContent(value, { contentType: 'markdown' })` parses markdown into ProseMirror nodes
  - **Write**: `editor.getMarkdown()` serializes ProseMirror document back to markdown text

### Import/Export

Markdown columns pass through as plain text in Excel cells, identical to `TextLong`. No special handling is needed -- the raw markdown string is the stored value.

## TipTap Library Choice

TipTap was selected over several alternatives:

| Library | Why Not |
|---------|---------|
| Quill | jQuery-era architecture, poor TypeScript support, markdown conversion is lossy |
| ProseMirror (direct) | Powerful but extremely low-level; TipTap wraps it with sane defaults |
| SimpleMDE / EasyMDE | Textarea-based, no true WYSIWYG, aging codebases |
| CodeMirror 6 | Excellent code editor, but markdown preview requires a separate rendering step |
| Milkdown | ProseMirror-based like TipTap but smaller community and fewer Angular integrations |

**Why TipTap won:**

1. **ProseMirror foundation** with excellent TypeScript support
2. **`@tiptap/markdown`** extension handles bidirectional markdown-to-ProseMirror conversion out of the box
3. **`ngx-tiptap`** provides Angular bindings that are signals-compatible
4. **Content-editable approach** is inherently accessible (keyboard navigation, screen reader compatible)
5. **Extensible architecture** allows adding custom marks/nodes later (video embeds, mentions, etc.)

**Important caveat**: `ngx-tiptap`'s `TiptapEditorDirective` only supports `outputFormat: "json" | "html"` -- NOT markdown. This is why the project uses a custom CVA wrapper instead of the directive directly. The wrapper calls `editor.getMarkdown()` from `@tiptap/markdown` on every content change.

## Go Worker Integration

The consolidated Go worker (`services/consolidated-worker-go/`) gains markdown rendering capability for notification templates.

- **Library**: `goldmark` v1.8.5 (CommonMark-compliant Go markdown library)
- **Registration**: Added as a `markdown` template function in `renderer.go:getTemplateFuncs()`
- **Return type**: `template.HTML` to prevent Go's `html/template` auto-escaping of the rendered HTML
- **Template usage**: `{{ markdown .Entity.body }}` in notification templates
- **Error handling**: On parse error, returns HTML-escaped source text (graceful degradation rather than empty output or template failure)

## Newsletter System (client-intake Example)

The newsletter system demonstrates the Markdown type in a real-world email campaign use case. It is built entirely from existing Civic OS primitives -- no new framework features beyond the Markdown type itself.

### Primitives Used

| Civic OS Primitive | Newsletter Usage |
|--------------------|-----------------|
| Markdown property type | Newsletter body content |
| Status workflow | Draft -> Scheduled -> Sent / Archived |
| Scheduled jobs | Hourly `check_scheduled_newsletters` auto-sends past-due newsletters |
| Notification system | Email delivery with markdown-rendered body |
| Entity action buttons | "Send Now" button with confirmation dialog |
| M:M junction table | `newsletter_recipients` linking newsletters to contacts |
| Anonymous RPC | `track_newsletter_open` tracking pixel endpoint |
| `security_invoker` VIEW | `newsletter_open_stats` for aggregated open rates |

### Status Workflow

```
  Draft ──────────────► Scheduled ──────────────► Sent
    │                       │
    │                       │
    ▼                       ▼
  Archived              Archived
```

- **Draft**: Initial state. Editable. "Send Now" and scheduling available.
- **Scheduled**: Has a `scheduled_at` timestamp. Hourly job checks for past-due newsletters.
- **Sent**: Terminal state. `sent_at` timestamp recorded. Read-only.
- **Archived**: Terminal state. Reachable from Draft or Scheduled.

### Tracking Architecture

Each recipient row in the `newsletter_recipients` junction table gets a UUID `tracking_token`. The notification email includes a 1x1 transparent tracking pixel:

```html
<img src="https://instance.example.com/rpc/track_newsletter_open?token=UUID" width="1" height="1" />
```

The `track_newsletter_open` RPC:
- Is `SECURITY DEFINER` (runs as function owner, not caller)
- Is granted to `web_anon` (no authentication required for pixel loads)
- Updates `opened_at` on the matching `newsletter_recipients` row (idempotent -- first open wins)
- Returns a 1x1 transparent GIF with `Content-Type: image/gif`

The `newsletter_open_stats` VIEW aggregates open rates with `security_invoker = true`, ensuring the calling user's permissions determine visibility.

## Edge Cases & Gotchas

### SQL Init Script Pitfalls

These are common mistakes when writing SQL init scripts for new Civic OS examples. They are documented here because they were encountered during newsletter system development.

**1. status_types registration order**

`metadata.statuses` has a FK constraint to `metadata.status_types`. The status type row MUST exist before inserting status values:

```sql
-- MUST come first
INSERT INTO metadata.status_types (entity_type, display_name, description)
VALUES ('newsletters', 'Newsletter', 'Newsletter delivery workflow')
ON CONFLICT (entity_type) DO NOTHING;

-- Then status values
INSERT INTO metadata.statuses (entity_type, status_name, ...)
VALUES ('newsletters', 'draft', ...);
```

**2. Permission column naming**

The column is `permission` (not `permission_type`), and values use RBAC verbs (`read`, `create`, `update`, `delete`), not SQL verbs (`select`, `insert`):

```sql
-- Correct
INSERT INTO metadata.permissions (table_name, permission)
VALUES ('newsletters', 'read');

-- Wrong (column does not exist)
INSERT INTO metadata.permissions (table_name, permission_type)
VALUES ('newsletters', 'select');
```

The `has_permission()` function also uses RBAC verbs: `has_permission('newsletters', 'read')`.

**3. set_updated_at function schema**

The trigger function lives in `public`, not `metadata`:

```sql
-- Correct
CREATE TRIGGER set_updated_at BEFORE UPDATE ON newsletters
EXECUTE FUNCTION public.set_updated_at();

-- Wrong
EXECUTE FUNCTION metadata.set_updated_at();
```

**4. created_by FK and user existence**

When using `created_by UUID DEFAULT current_user_id() REFERENCES metadata.civic_os_users(id)`, the JWT's user UUID must already exist in `civic_os_users`. First-time users need to call `refresh_current_user()` before creating records. Mock data scripts should insert user records before inserting entity records.

### Enum Drift Guard

The import-validation worker runs in a Web Worker context and cannot import from the main application, so it duplicates `EntityPropertyType` as a plain object. When adding a new property type (like Markdown), ALL of the following must be updated:

1. `EntityPropertyType` enum in `src/app/interfaces/entity.ts`
2. Worker copy in `src/app/workers/import-validation.worker.ts`
3. `EXPECTED_COUNT` in `src/app/workers/import-validation-enum-sync.spec.ts`
4. `EXPECTED_WORKER_ENUM_VALUES` in `src/app/services/import-export.service.spec.ts`
5. `getPropertyTypeLabel()` in `src/app/pages/property-management/property-management.page.ts`

A unit test (`import-validation-enum-sync.spec.ts`) catches drift between the main enum and the worker copy by comparing counts and values. If you add a type and forget the worker, CI will fail.

### Markdown Rendering Consistency

The same markdown content renders in three contexts:

| Context | Library | Notes |
|---------|---------|-------|
| Browser display | `ngx-markdown` (marked.js) | Static Text, Notes, Detail pages |
| Browser edit | `@tiptap/markdown` (markdown-it) | WYSIWYG editor round-trip |
| Email (Go worker) | `goldmark` | Notification template rendering |

These are three different markdown parsers. All are CommonMark-compliant, but edge cases in extended syntax (tables, strikethrough, etc.) may render differently. The `markdown` domain stores CommonMark, and all three libraries handle the CommonMark spec faithfully. Avoid relying on parser-specific extensions.

### Previous Design Document

`docs/notes/MARKDOWN_EDITOR_DESIGN.md` was written as a forward-looking requirements document before the Markdown type was implemented. It captures the original requirements analysis and library comparison. This document (`MARKDOWN_TYPE_DESIGN.md`) supersedes it for architecture reference but the editor design doc remains useful for understanding the requirements that informed the final implementation -- particularly the video embed integration requirements and the DOMPurify considerations.

## npm Dependencies Added

| Package | Purpose |
|---------|---------|
| `@tiptap/core` | Editor core |
| `@tiptap/starter-kit` | Common extensions (bold, italic, heading, lists, code, blockquote) |
| `@tiptap/pm` | ProseMirror peer dependency |
| `@tiptap/markdown` | Bidirectional markdown conversion |
| `@tiptap/extension-link` | Link marks with auto-detection |
| `@tiptap/extension-bubble-menu` | Contextual toolbar (future use) |
| `@tiptap/extension-floating-menu` | Slash commands (future use) |
| `@floating-ui/dom` | Positioning engine for bubble/floating menus |
| `ngx-tiptap` | Angular bindings |

## Go Dependencies Added

| Package | Purpose |
|---------|---------|
| `github.com/yuin/goldmark` v1.8.5 | CommonMark markdown-to-HTML for email notification templates |

## Related Files

| Purpose | Path |
|---------|------|
| Property type enum | `src/app/interfaces/entity.ts` |
| Schema detection | `src/app/services/schema.service.ts` |
| Display component | `src/app/components/display-property/display-property.component.ts` |
| Edit component | `src/app/components/edit-property/edit-property.component.ts` |
| Markdown editor CVA | `src/app/components/markdown-editor/markdown-editor.component.ts` |
| Worker enum copy | `src/app/workers/import-validation.worker.ts` |
| Enum sync test | `src/app/workers/import-validation-enum-sync.spec.ts` |
| Go template funcs | `services/consolidated-worker-go/internal/renderer/renderer.go` |
| Newsletter example | `examples/client-intake/` |
| Previous design doc | `docs/notes/MARKDOWN_EDITOR_DESIGN.md` |
