# Document Template System — Design Notes

> **Status**: Design (not yet implemented)
> **Author**: Daniel Kurin + Claude
> **Date**: 2026-08-28

## Overview

A document generation system that fills DOCX templates with entity data and optionally converts them to PDF via Gotenberg. Mirrors the notification/email template architecture: the caller assembles JSONB data in SQL (with RLS via `SECURITY INVOKER`), the framework handles rendering and delivery.

## Goals

- Non-technical users author templates in Word/LibreOffice
- Same `{{.Entity.field}}` / `{{range}}` / `{{if}}` syntax as email templates
- Reuse the existing Go `Renderer` infrastructure (formatters, template functions)
- Store templates and generated output via the existing S3 file pipeline
- Trigger generation via Entity Actions, RPCs, or status/property change triggers
- Optional PDF conversion via Gotenberg (integrator-managed)

## Architecture

### Data Flow

```
Integrator SQL (SECURITY INVOKER RPC)
    ↓  builds entity_data JSONB (joins, jsonb_agg, etc.)
    ↓  respects RLS — runs as calling user
generate_document() RPC
    ↓  validates template exists
    ↓  inserts into metadata.generated_documents (status='pending')
PostgreSQL Trigger
    ↓  enqueues River job
DocumentWorker (consolidated Go worker)
    ├── 1. Fetch template DOCX from S3 (via document_templates.file_id)
    ├── 2. Unzip DOCX, reassemble fragmented placeholders
    ├── 3. Hoist {{range}}/{{end}} from table cells to wrap <w:tr> elements
    ├── 4. Render XML via Go text/template (same Renderer, same formatters)
    ├── 5. Process {{image}} markers → inject images into word/media/
    ├── 6. Rezip into filled DOCX
    ├── 7. (Optional) POST to Gotenberg → receive PDF
    ├── 8. Upload output to S3 via file pipeline → new file_id
    ├── 9. UPDATE target entity property with output file_id
    └── 10. UPDATE generated_documents status='completed', output_file_id
```

### Parallel with Notification System

| Concern | Notifications | Documents |
|---|---|---|
| Template storage | `metadata.notification_templates` (text in DB columns) | `metadata.document_templates` (S3 file reference) |
| Template lookup | By `name` (varchar key) | By `name` (varchar key) |
| Data shaping | Caller builds JSONB via `jsonb_build_object` | Same |
| Security context | Caller's RLS (SECURITY INVOKER) | Same |
| Template syntax | Go `text/template` (`{{.Entity.field}}`) | Same |
| Formatters | `formatMoney`, `formatDateTime`, `formatPhone`, etc. | Same (reuse `Renderer.getTemplateFuncs()`) |
| Job queue | River (`send_notification`) | River (`generate_document`) |
| Output | SMTP email / SMS | S3 file (DOCX or PDF) |
| Audit trail | `metadata.notifications` (status, sent_at) | `metadata.generated_documents` (status, output_file_id) |

## Schema

### Template Config Table

```sql
CREATE TABLE metadata.document_templates (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        VARCHAR(100) NOT NULL UNIQUE,  -- lookup key, e.g. 'building_permit'
    description TEXT,
    entity_type VARCHAR(100),                  -- documentation: which entity this is for
    file_id     UUID NOT NULL REFERENCES metadata.files(id),
    output_format VARCHAR(10) NOT NULL DEFAULT 'pdf'
                  CHECK (output_format IN ('pdf', 'docx', 'both')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE metadata.document_templates IS
    'System-wide document templates. Template content (DOCX/DOTX) stored in S3 via metadata.files. Lookup by name, same pattern as notification_templates.';
COMMENT ON COLUMN metadata.document_templates.file_id IS
    'Reference to the DOCX template file in S3. Normalized on upload (smart quotes fixed, fragments reassembled).';
COMMENT ON COLUMN metadata.document_templates.output_format IS
    'pdf = convert via Gotenberg (requires GOTENBERG_URL). docx = filled DOCX only. both = produce both.';
```

### Generation Audit Table (Admin-Only)

`generated_documents` is a **pure audit log** — not a user-facing entity. Users access generated files via the entity's FilePDF property (e.g., `permits.permit_pdf`). This table exists for admin debugging ("why didn't my PDF generate?") and generation history tracking. It is not registered in `schema_entities`, has no RBAC permissions, and has no frontend list/detail pages.

```sql
CREATE TABLE metadata.generated_documents (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    template_name   VARCHAR(100) NOT NULL,
    entity_type     VARCHAR(100),
    entity_id       VARCHAR(255),
    entity_data     JSONB,                        -- snapshot at generation time
    target_entity   VARCHAR(100),                 -- entity to update with output
    target_id       VARCHAR(255),                 -- record to update
    target_property VARCHAR(100),                 -- FilePDF column to set
    status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    output_file_id  UUID REFERENCES metadata.files(id),
    error_message   TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at    TIMESTAMPTZ
);

CREATE INDEX idx_generated_documents_status ON metadata.generated_documents(status);
CREATE INDEX idx_generated_documents_entity ON metadata.generated_documents(entity_type, entity_id);
CREATE INDEX idx_generated_documents_target ON metadata.generated_documents(target_entity, target_id);
```

**UX implication**: When a user clicks an Entity Action like "Generate Permit PDF", the RPC returns immediately (async via River queue). There is no progress indicator — the FilePDF column is NULL until the worker completes. On next page load/refresh, the PDF appears. If generation fails, the column stays NULL and the error is in `generated_documents` for admin investigation.

### RPC Function

```sql
CREATE OR REPLACE FUNCTION generate_document(
    p_template_name   VARCHAR,
    p_entity_type     VARCHAR DEFAULT NULL,
    p_entity_id       VARCHAR DEFAULT NULL,
    p_entity_data     JSONB   DEFAULT NULL,
    p_target_entity   VARCHAR DEFAULT NULL,
    p_target_id       VARCHAR DEFAULT NULL,
    p_target_property VARCHAR DEFAULT NULL
)
RETURNS BIGINT  -- generated_documents ID
SECURITY DEFINER
SET search_path = metadata, public
AS $$
DECLARE
    v_doc_id BIGINT;
BEGIN
    -- Validate template exists
    IF NOT EXISTS(SELECT 1 FROM metadata.document_templates WHERE name = p_template_name) THEN
        RAISE EXCEPTION 'Document template "%" does not exist', p_template_name;
    END IF;

    -- Validate target property is a FilePDF type (if destination specified)
    IF p_target_entity IS NOT NULL AND p_target_property IS NOT NULL THEN
        IF NOT EXISTS(
            SELECT 1 FROM schema_properties
            WHERE table_name = p_target_entity
              AND column_name = p_target_property
        ) THEN
            RAISE EXCEPTION 'Property "%.%" does not exist', p_target_entity, p_target_property;
        END IF;
    END IF;

    INSERT INTO metadata.generated_documents (
        template_name, entity_type, entity_id, entity_data,
        target_entity, target_id, target_property
    ) VALUES (
        p_template_name, p_entity_type, p_entity_id, p_entity_data,
        p_target_entity, p_target_id, p_target_property
    )
    RETURNING id INTO v_doc_id;

    RETURN v_doc_id;
END;
$$ LANGUAGE plpgsql;
```

### River Job Trigger

```sql
CREATE OR REPLACE FUNCTION metadata.enqueue_document_generation()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM river.fn_insert(jsonb_build_object(
        'kind', 'generate_document',
        'queue', 'documents',
        'priority', 3,
        'args', jsonb_build_object(
            'document_id',    NEW.id::text,
            'template_name',  NEW.template_name,
            'entity_type',    NEW.entity_type,
            'entity_id',      NEW.entity_id,
            'entity_data',    NEW.entity_data,
            'target_entity',  NEW.target_entity,
            'target_id',      NEW.target_id,
            'target_property', NEW.target_property
        )
    ));
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_enqueue_document_generation
    AFTER INSERT ON metadata.generated_documents
    FOR EACH ROW
    EXECUTE FUNCTION metadata.enqueue_document_generation();
```

## Template Syntax

### Text Placeholders

Same as email templates:

```
Dear {{.Entity.applicant_name}},

Your permit #{{.Entity.permit_number}} has been approved on {{formatDate .Entity.approved_at}}.
```

### Loops (Table Rows)

Template author types inside a Word table cell:

```
{{range .Entity.line_items}}
| {{.description}} | {{.quantity}} | {{formatMoney .unit_price}} |
{{end}}
```

In the raw OOXML, this becomes `{{range}}` inside a `<w:tc>` (table cell). The worker preprocesses the XML to **hoist** the range directive outside the `<w:tr>` element. See "Range Hoisting" section below.

### Conditionals

```
{{if .Entity.has_violations}}
NOTICE: This permit is subject to violation review.
{{end}}
```

### Images

```
{{image .Entity.child_photo 200 150}}
```

Parameters: field name (must be a file_id in entity_data), width in pixels, height in pixels. See "Image Processing" section below.

### Available Formatters

All existing notification template formatters are available:

- `{{formatMoney .Entity.amount}}` → `$1,234.56`
- `{{formatDateTime .Entity.created_at}}` → `Mar 15, 2026 2:00 PM EST`
- `{{formatDate .Entity.approved_at}}` → `Mar 15, 2026`
- `{{formatPhone .Entity.phone}}` → `(555) 123-4567`
- `{{formatTimeSlot .Entity.time_slot}}` → `Mar 15, 2026 2:00 PM EST - 4:00 PM EST`

## Key Implementation Details

### Range Hoisting

**Problem**: Go's `text/template` does text substitution. When the author types `{{range .Entity.items}}` in a table cell, Word places it inside `<w:tc><w:p><w:r><w:t>`. But the range needs to wrap the entire `<w:tr>` for row repetition.

**Solution**: Before template execution, the worker scans the XML AST for `{{range ...}}` and `{{end}}` directives that appear inside table cells. It restructures the XML:

```xml
<!-- Before hoisting (what Word produces) -->
<w:tr>
  <w:tc><w:p><w:r><w:t>{{range .Entity.items}}</w:t></w:r></w:p></w:tc>
  <w:tc><w:p><w:r><w:t>{{.description}}</w:t></w:r></w:p></w:tc>
</w:tr>
<w:tr>
  <w:tc><w:p><w:r><w:t>{{end}}</w:t></w:r></w:p></w:tc>
</w:tr>

<!-- After hoisting (what text/template sees) -->
{{range .Entity.items}}
<w:tr>
  <w:tc><w:p><w:r><w:t>{{.description}}</w:t></w:r></w:p></w:tc>
</w:tr>
{{end}}
```

**Rules**:
1. A `{{range ...}}` that is the sole content of a table cell → hoist outside the containing `<w:tr>`
2. A `{{end}}` that is the sole content of a table cell → hoist outside the containing `<w:tr>`, then remove the now-empty row
3. A `{{range}}` inside a paragraph (not a table) → hoist outside the `<w:p>` for paragraph repetition
4. Mixed content cells (e.g., `Total: {{range ...}}`) → leave in place (template author error; report during validation)

### Nested Loops

Go's `text/template` supports nested `{{range}}` natively. The hoisting preprocessor must also handle nesting correctly.

**Example** — a report with departments, each containing employees:

```
Template (as typed in Word):

{{range .Entity.departments}}
Department: {{.name}}
{{range .employees}}
| {{.employee_name}} | {{.role}} | {{formatMoney .salary}} |
{{end}}
{{end}}
```

This produces two levels of hoisting:
- Inner `{{range .employees}}` + `{{end}}` → hoist outside their `<w:tr>` elements (table row repetition)
- Outer `{{range .Entity.departments}}` + `{{end}}` → hoist outside their `<w:p>` elements (paragraph/section repetition)

**Algorithm**: Process **inside-out** using brace-matching:

1. Scan all `{{range ...}}` and `{{end}}` directives in the XML
2. Pair them using standard stack-based brace matching (innermost `{{range}}` pairs with the nearest `{{end}}`)
3. For each pair, starting from the innermost:
   - If inside a table cell (`<w:tc>`): hoist both outside their containing `<w:tr>`
   - If inside a paragraph (`<w:p>`, not in a table): hoist outside the `<w:p>`
   - If already at the correct structural level: leave in place
4. Remove any rows/paragraphs that became empty after hoisting

**Edge case — nested table rows**: When both an outer and inner `{{range}}` are in cells of the same table, the inner pair is hoisted first (producing repeated `<w:tr>` blocks), then the outer pair is hoisted to wrap the entire table section. The brace-matching ensures correct pairing even when multiple ranges interleave.

**Validation**: During template upload validation, check that all `{{range}}` directives have matching `{{end}}` directives and that nesting is well-formed (no overlapping ranges).

### Image Processing

**Two-pass approach**:

1. **Template execution**: `{{image .Entity.child_photo 200 150}}` is a custom Go template function that outputs a marker string: `__CIVIC_IMG_{unique_id}_{width}_{height}__`
2. **Post-processing**: Worker scans rendered XML for markers and for each one:
   - Reads the file_id from entity_data (e.g., `.Entity.child_photo` = UUID)
   - Downloads image bytes from S3 via `metadata.files`
   - Determines image format (PNG/JPEG) from file metadata
   - Adds image to `word/media/image{N}.{ext}` in the ZIP
   - Adds relationship entry to `word/_rels/document.xml.rels`
   - Replaces the marker with OOXML `<w:drawing>` inline image XML
   - Dimensions converted from pixels to EMUs at 96 DPI (1px = 9525 EMU)

**Nil handling**: If the file_id is null or the file doesn't exist in S3, the marker is replaced with empty string (image silently omitted). Template authors can use `{{if .Entity.child_photo}}{{image ...}}{{end}}` for explicit control.

### XML Escaping

Entity data may contain characters that break XML (`<`, `>`, `&`, `"`, `'`). Since we use `text/template` (not `html/template`), there's no automatic escaping.

**Solution**: Before building the template context, the worker XML-escapes all string values in the entity data map. This happens at the `buildContext()` level, so template authors never need to think about it.

```go
// Pseudocode
func xmlEscapeStrings(data map[string]interface{}) map[string]interface{} {
    for k, v := range data {
        switch val := v.(type) {
        case string:
            data[k] = xml.EscapeText(val)  // & → &amp;  < → &lt;  etc.
        case map[string]interface{}:
            data[k] = xmlEscapeStrings(val) // recurse into nested objects
        case []interface{}:
            // recurse into array elements
        }
    }
    return data
}
```

### Template Normalization (On Upload)

When a DOCX is linked as a document template, the worker normalizes template syntax only:

| Transformation | Scope | Example |
|---|---|---|
| Smart double quotes → straight | Inside `{{ }}` only | `"` `"` → `"` |
| Smart single quotes → straight | Inside `{{ }}` only | `'` `'` → `'` |
| En/em dashes → hyphen | Inside `{{ }}` only | `–` `—` → `-` |
| Proofing elements removed | Inside `{{ }}` only | `<w:proofErr>` stripped |
| Run fragments merged | Inside `{{ }}` only | Split `<w:r>` elements joined |

**Nothing outside `{{ }}` blocks is modified.** Document text, formatting, images, styles, and structure are untouched. The normalized file replaces the original in S3 — the visual document is identical.

### Fragment Reassembly

WordprocessingML splits text across multiple `<w:r>` (run) elements for formatting, spell-check, and revision tracking. A placeholder like `{{.Entity.name}}` may become:

```xml
<w:r><w:t>{{.Entity.</w:t></w:r>
<w:r><w:rPr><w:lang w:val="en-US"/></w:rPr><w:t>name}}</w:t></w:r>
```

The worker uses the same reassembly approach as [lukasjarosch/go-docx](https://github.com/lukasjarosch/go-docx): scan for `{{` and `}}` delimiters across adjacent runs, merge the text content into a single run, and preserve the formatting of the first run.

## Generation Triggers

### Entity Action Button (On-Demand)

```sql
-- Register an action button on the permits detail page
INSERT INTO metadata.entity_action_buttons (entity_type, label, rpc_function_name, icon)
VALUES ('permits', 'Generate Permit PDF', 'generate_permit_pdf', 'document');

-- The RPC (SECURITY INVOKER — runs as calling user)
CREATE OR REPLACE FUNCTION generate_permit_pdf(p_record_id TEXT)
RETURNS VOID
SECURITY INVOKER
AS $$
BEGIN
    PERFORM generate_document(
        p_template_name   := 'building_permit',
        p_entity_type     := 'permits',
        p_entity_id       := p_record_id,
        p_entity_data     := (
            SELECT jsonb_build_object(
                'permit_number', p.permit_number,
                'applicant_name', u.display_name,
                'address', p.address,
                'approved_at', p.approved_at,
                'inspector_name', i.display_name,
                'line_items', (
                    SELECT jsonb_agg(jsonb_build_object(
                        'description', li.description,
                        'fee', li.fee
                    ) ORDER BY li.sort_order)
                    FROM permit_line_items li WHERE li.permit_id = p.id
                )
            )
            FROM permits p
            JOIN civic_os_users u ON p.applicant_id = u.id
            LEFT JOIN civic_os_users i ON p.inspector_id = i.id
            WHERE p.id = p_record_id::int
        ),
        p_target_entity   := 'permits',
        p_target_id       := p_record_id,
        p_target_property := 'permit_pdf'
    );
END;
$$ LANGUAGE plpgsql;
```

### Status Transition Trigger (Automatic)

```sql
-- Auto-generate when permit status changes to 'approved'
INSERT INTO metadata.status_transitions (entity_type, from_status_key, to_status_key)
VALUES ('permits', 'pending_review', 'approved');

-- In the status change trigger:
PERFORM generate_document(
    p_template_name := 'building_permit',
    p_entity_type   := 'permits',
    p_entity_id     := NEW.id::text,
    p_entity_data   := jsonb_build_object(...),
    p_target_entity := 'permits',
    p_target_id     := NEW.id::text,
    p_target_property := 'permit_pdf'
);
```

### With Notification (Link, Not Attachment)

```sql
-- After document generation, send notification with link
PERFORM create_notification(
    p_user_id       := p.applicant_id,
    p_template_name := 'permit_approved',
    p_entity_type   := 'permits',
    p_entity_id     := NEW.id::text,
    p_entity_data   := jsonb_build_object(
        'permit_number', NEW.permit_number,
        'applicant_name', u.display_name,
        'document_url', format('%s/view/permits/%s', current_setting('app.site_url'), NEW.id)
    )
);
```

Email template references the link: `<a href="{{.Entity.document_url}}">View your permit</a>`. The generated PDF is accessible on the permit's detail page via the `permit_pdf` FilePDF property.

## Re-generation Behavior

When a document is re-generated for the same entity (e.g., user clicks "Generate PDF" again):

1. A new row is inserted into `metadata.generated_documents` (audit log)
2. The worker generates a new PDF and uploads to S3 (new file_id)
3. The target property is updated to point to the new file_id — users always see the latest
4. The previous generation record remains in `generated_documents` with its `output_file_id` — the old file is **not deleted** from S3
5. `generated_documents` provides admin-only version history; users are unaware of previous generations

Old files can be cleaned up via periodic maintenance if storage is a concern.

## Template Version Resolution

Template version is resolved **at execution time** (latest wins). The job stores `template_name`; the worker looks up `document_templates.file_id` when it runs. This means:

- Updating a template immediately affects all future generations
- In-flight jobs (enqueued before the update, executed after) use the new template
- This is acceptable because template updates are intentional admin actions and jobs typically execute within seconds

## Gotenberg Integration

Gotenberg is **optional**. Configuration:

```env
GOTENBERG_URL=http://gotenberg:3000  # If set, PDF conversion is available
# If unset, output_format='pdf' jobs fail with descriptive error;
# output_format='docx' works without Gotenberg
```

### Resource Considerations (Integrator Documentation)

- Gotenberg bundles LibreOffice + Chromium in a single Docker container (~2GB image)
- RAM: ~500MB idle, ~1-2GB under concurrent conversion load
- Shared instance is fine for low-volume generation (< 50 docs/day)
- High-volume instances should run a dedicated Gotenberg container
- Font availability: mount custom fonts into the Gotenberg container at `/usr/share/fonts/custom/` if templates use non-standard fonts

### API Call

```
POST http://gotenberg:3000/forms/libreoffice/convert
Content-Type: multipart/form-data

file: filled.docx (the rendered DOCX bytes)
```

Response: PDF bytes.

## i18n

Deferred. The `document_templates` table can add a `locale` column later with a composite unique constraint on `(name, locale)`. The `generate_document` RPC would accept an optional `p_locale` parameter and fall back to the default locale template.

For now, integrators who need multilingual documents can create separate templates (`building_permit_en`, `building_permit_es`) and select the appropriate one in their SECURITY INVOKER RPC based on user locale.

## File Format Support

The system accepts both `.docx` and `.dotx` files as templates. Internally they are identical ZIP/XML structures — the only difference is the content type declaration in `[Content_Types].xml`. The worker processes both identically.

## Dependencies

| Dependency | Purpose | License | New? |
|---|---|---|---|
| Go `archive/zip` (stdlib) | Unzip/rezip DOCX | BSD | No (stdlib) |
| Go `encoding/xml` (stdlib) | Parse/manipulate OOXML | BSD | No (stdlib) |
| Go `text/template` (stdlib) | Template rendering | BSD | No (already used) |
| [lukasjarosch/go-docx](https://github.com/lukasjarosch/go-docx) | Fragment reassembly reference | MIT | Yes (or port the logic) |
| Gotenberg (Docker container) | DOCX → PDF conversion | MIT | Yes (optional) |

## Open Questions / Future Work

- **Template Management UI**: Admin page for uploading/managing document templates (similar to `/templates` for notifications). Could extend the existing template management page or be a separate admin page.
- **Preview**: "Generate Preview" button that renders the template with sample data and shows the PDF inline. Requires Gotenberg.
- **Batch generation**: Generate documents for multiple records at once (e.g., all approved permits). Could reuse the `send_email` multi-recipient pattern.
- **Digital signatures**: Sign generated PDFs with a certificate. Post-processing step after Gotenberg conversion.
- **QR codes**: `{{qrcode .Entity.permit_url 100}}` function that generates a QR code image inline. Uses a Go QR library (e.g., `skip2/go-qrcode`) in the image processing pass.
