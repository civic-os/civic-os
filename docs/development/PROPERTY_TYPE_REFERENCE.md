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

---

**Last Updated**: 2026-03-11
