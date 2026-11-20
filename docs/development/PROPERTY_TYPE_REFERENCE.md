# Property Type Reference

Detailed documentation for property types that require special implementation knowledge beyond what's in CLAUDE.md's type enum list.

## User Type

**Detection**: UUID with `join_table = 'civic_os_users'`

### Unified View Architecture

The `civic_os_users` view in `public` schema combines data from two underlying tables:
- `metadata.civic_os_users` - Public profile (display_name)
- `metadata.civic_os_users_private` - Private contact info (full_name, phone, email)

**API Response**: `{id, display_name, full_name, phone, email}` where private fields are NULL unless:
- User views their own record, OR
- User has `civic_os_users_private:read` permission

**Storage**: Actual tables reside in `metadata` schema for namespace organization; the view provides a backward-compatible API surface.

### Profile Management

User profile data (name, email, phone) is managed in **Keycloak** (single source of truth) and synced to Civic OS on login via `refresh_current_user()` RPC. The "Account Settings" menu item links to Keycloak's account console with referrer params for easy return.

Phone number requires custom user attribute and JWT mapper configuration. See `docs/AUTHENTICATION.md` (Step 5) for setup.

## Dimension Type (v0.86.0)

**Detection** (core `getPropertyType`, after Status and Category, before system types): a `BIGINT` (`int8`) column with a foreign key into `public` whose target table, schema and key column match a row of the dimensions registry. Like the system types (an FK to `files`, `civic_os_users`, ...), the type comes from the FK target alone; there is no extra column on `schema_properties`. Clients load `schema_dimensions` with the properties (core `SchemaClient.getDimensions()`, invalidated with the properties cache, whose version follows the registry) and pass it to `getPropertyType(prop, dimensions)`; `dimensionFor(prop, dimensions)` returns the matching registry row. Without the registry (an instance older than v0.85.0) the column is a `ForeignKeyName`. A dimension table outside `public` has no API path, so FKs to it stay `ForeignKeyName`.

**Same as ForeignKeyName**: the select string embeds `display_name` of the target, the edit select reads the raw id, ordering is by `col(display_name)`, the List filter is the checkbox list with `in`, import and export resolve names through the target table, and junction detection treats it as an FK. Filters match the chosen ids only; no client uses `dimension_subtree()` to include descendants. The MCP server treats it as an FK too; see `docs/notes/MCP_SERVER_DESIGN.md` (Dimension Columns).

**Edit control**: `TreeSelectComponent` (`src/app/components/tree-select/`), an ARIA editable combobox over a listbox, fed by `DimensionService` (registry row from `schema_dimensions`, rows from the dimension table with columns aliased to `id`, `label`, `parent_id`, `active`, read each time a control loads, uncached, so added and retired rows show on the next form; a failed request yields no options). Tree logic is core's `buildTree` / `flattenTree` (`packages/core/src/tree/`).

- Siblings come in the registry's order: `DimensionService` requests `order=<sort_column>.asc.nullslast,<label>.asc,<key>.asc` (the sort column from `register_dimension(p_sort_column)`, or a `sort_order` column by convention) and `buildTree()` keeps input order within siblings.
- Options are indented by level and named label first with their ancestors in parentheses, root first ("Shovels (Hand Tools › Digging & Soil)", `formatTreeLabel()` in `src/app/utils/tree-path.ts`); listbox options carry no level, so this is the accessible name. The closed text box shows the same text, so truncation hides ancestors, never the chosen row.
- Typing filters by label; ancestors of matches stay visible as context.
- Retired rows (active column false) are hidden from new choices; the current value stays visible, marked "Inactive". A retired ancestor of an active row shows as disabled context.
- On a dimension table's own parent column (the FK points at its own table), the record and its descendants are disabled.
- On an empty control the dimension's active default is preselected, so a required column validates and the user sees what the server would fill. The server-side fill trigger still covers import, MCP and SQL inserts.
- `hide_when_single`: with exactly one active row the field is not rendered and holds that row, unless the record already holds a different value.
- `fk_search_modal`, `options_source_rpc` and `depends_on_columns` are ignored: `useFkSearchModal` and the options branches in `EditPropertyComponent` apply only to `ForeignKeyName` (and `User`), so the tree select is the only control. `register_dimension()` raises a NOTICE for each referencing column that has one set. Issue #142 will honor `fk_search_modal` with a tree-aware search modal (without the flag the tree select stays); many-to-many relationships to a dimension are issue #139.

**Display** (`DisplayPropertyComponent`, `dimensionText`): a link to the record. Detail passes `showPath` to `DisplayPropertyComponent`, which shows "Shovels (Hand Tools › Digging & Soil)": the label renders at once and the ancestors follow from `DimensionService.getAncestorLabels()`, one flat request for the dimension table resolved by `buildTree()` (no recursive query, no cache; a flat dimension makes no request). List and other contexts show `display_name` alone.

## Geography (GeoPoint) Type

**Detection**: `geography(Point, 4326)`

### Computed Field Requirement

When adding a geography column, you **must** create a paired computed field function that returns `ST_AsText()`. PostgREST exposes this as a virtual field.

```sql
-- For a column named 'location':
CREATE OR REPLACE FUNCTION location_text(rec my_table)
RETURNS TEXT AS $$
  SELECT postgis.ST_AsText(rec.location);
$$ LANGUAGE SQL STABLE;
```

**Data formats**:
- Insert/Update: EWKT `"SRID=4326;POINT(lng lat)"`
- Read: WKT `"POINT(lng lat)"` (from the `_text` computed field)

### Map Dark Mode

Maps automatically switch between light and dark tile layers based on the current DaisyUI theme:

- **ThemeService** (`src/app/services/theme.service.ts`) dynamically calculates theme luminance by reading the `--b1` CSS variable and applying the YIQ brightness formula
- Works with any DaisyUI theme (including custom themes) without hardcoded theme names
- Light themes: OpenStreetMap tiles; Dark themes: ESRI World Dark Gray tiles
- `GeoPointMapComponent` subscribes to theme changes via MutationObserver on `data-theme` attribute and swaps tile layers without page reload

## Geography (GeoPolygon) Type

**Detection**: `geography(Polygon, 4326)`

### Computed Field Requirement

Same pattern as GeoPoint - create a paired computed field:

```sql
-- For a column named 'boundary':
CREATE OR REPLACE FUNCTION boundary_text(rec my_table)
RETURNS TEXT AS $$
  SELECT postgis.ST_AsText(rec.boundary);
$$ LANGUAGE SQL STABLE;
```

**Data formats**:
- Insert/Update: EWKT `"SRID=4326;POLYGON((lng1 lat1, lng2 lat2, ..., lng1 lat1))"`
- Read: WKT `"POLYGON((lng1 lat1, lng2 lat2, ...))"` (from the `_text` computed field)

### Drawing Library

Uses `@geoman-io/leaflet-geoman-free` (lazy loaded) for interactive polygon drawing in edit mode:
- Single polygon constraint (draw one, then delete to draw another)
- Vertex snapping for parcel-precision boundaries
- Edit mode enables vertex dragging on existing polygons

### Multi-Polygon Display (List/Dashboard)

`GeoPolygonMapComponent` accepts a `MapPolygon[]` input for rendering multiple polygons:
- Each polygon can have its own color (resolved via `resolveColor()` utility)
- `resolveColor()` handles both flat hex strings (`"#22c55e"`) and Category embed objects (`{id, display_name, color}`)
- Dashboard map widget uses `colorProperty` config to color polygons by a Category column

### Map Dark Mode

Same tile-switching behavior as GeoPoint - see above.

## PhotoGallery Type

**Detection**: UUID with `join_table = 'photo_galleries'` (via `isSystemType()` in `SchemaService`)

The PhotoGallery type manages an ordered collection of images for an entity column, unlike `FileImage` which stores a single file per column. Detection uses the same `isSystemType()` path as Status and Category — when the FK's `join_table` is `photo_galleries`, the property is typed as `EntityPropertyType.PhotoGallery`.

### Display Mode

`DisplayPropertyComponent` renders a responsive thumbnail grid of gallery images. Clicking any thumbnail opens the `GalleryLightboxComponent` for full-screen browsing with previous/next navigation.

- Thumbnails use the 150x150 size from the standard thumbnail pipeline
- Empty galleries show a placeholder with "No photos" text
- Image count badge shown on the gallery container

### Edit Mode

`PhotoGalleryEditorComponent` provides the full editing experience:

- **Drag-drop upload**: Drop zone and file input, validates against `photo_gallery_config` (allowed types, max size, max images)
- **CDK DragDrop reorder**: Angular CDK `DragDropModule` for visual drag-and-drop reordering of thumbnails
- **Per-image metadata**: Inline editing of caption and alt text
- **Remove images**: Delete button with confirmation per image
- **Upload progress**: Progress bar during S3 upload

On Create pages, the component uses the **draft gallery pattern**: a draft gallery is created before the entity record exists, then linked via `link_gallery_to_entity` RPC on form submission. Draft galleries abandoned for more than 12 hours are cleaned up by `metadata.cleanup_draft_galleries` (server-side function, hidden from PostgREST).

### Companion Tables

| Table | Purpose |
|-------|---------|
| `metadata.photo_galleries` | Gallery registry with `entity_table`/`entity_id` polymorphic back-reference |
| `metadata.photo_gallery_files` | Junction table linking galleries to `metadata.files` with `sort_order`, `caption`, `alt_text` |
| `metadata.photo_gallery_config` | Per-column configuration: `max_images`, `allowed_types`, `max_file_size` |

### Setup

```sql
-- 1. Add UUID column with FK to photo_galleries
ALTER TABLE issues ADD COLUMN photos UUID REFERENCES metadata.photo_galleries(id);
CREATE INDEX idx_issues_photos ON issues(photos);

-- 2. Insert gallery configuration
INSERT INTO metadata.photo_gallery_config (entity_table, property_name, max_images, allowed_types, max_file_size)
VALUES ('issues', 'photos', 20, '{image/jpeg,image/png,image/webp}', 10485760);

-- 3. (Optional) Configure display properties
INSERT INTO metadata.properties (table_name, column_name, display_name, description, sort_order)
VALUES ('issues', 'photos', 'Photos', 'Photo gallery for this issue', 60);

-- 4. Notify PostgREST to reload schema cache
NOTIFY pgrst, 'reload schema';
```

See `docs/notes/PHOTO_GALLERY_DESIGN.md` for full architecture and lifecycle details.

---

**Last Updated**: 2026-04-20
