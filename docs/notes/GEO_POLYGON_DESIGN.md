# GeoPolygon Property Type - Design Notes

**Version**: v0.49.0
**Date**: 2026-04-29

## Overview

GeoPolygon adds area/boundary support to Civic OS, complementing the existing GeoPoint (single marker) type. It follows the same end-to-end pattern: PostgreSQL `geography(Polygon, 4326)` -> auto-detection via `schema_properties` -> interactive Leaflet map -> dashboard/list rendering.

## Key Design Decisions

### Drawing Library: leaflet-geoman-free

Chose `@geoman-io/leaflet-geoman-free` over alternatives:
- **leaflet-draw**: Unmaintained, no TypeScript types
- **leaflet-geoman-free**: Actively maintained, TypeScript support, vertex snapping (important for parcel precision)
- **Loaded lazily**: Dynamic `import()` only in edit mode, same pattern as `leaflet.markercluster` in GeoPointMapComponent

### Single Polygon Per Field

Each GeoPolygon column stores one polygon (no MultiPolygon, no holes). This keeps the data model simple and matches the expected use case (one boundary per parcel/property). The component enforces this by disabling the draw tool after one polygon is created.

### Color Resolution

Both the dashboard map widget and list page need to color polygons per-record. Rather than requiring a separate `hex_color` column, the `resolveColor()` utility handles:
1. Flat hex strings: `"#22c55e"` -> used directly
2. Category embed objects: `{"id":1, "display_name":"Residential", "color":"#22c55e"}` -> extracts `.color`

This allows `colorProperty` in dashboard config to point directly at a Category FK column.

### WKT/EWKT Format

- **Database insert**: EWKT `SRID=4326;POLYGON((lng1 lat1, lng2 lat2, ..., lng1 lat1))`
- **Database read**: WKT `POLYGON((lng1 lat1, ...))` via `_text` computed field
- **Ring closure**: Enforced on emit (first point == last point)
- **Coordinate order**: WKT uses `lng lat` (not `lat lng`)

### Import/Export

- **Export**: WKT -> GeoJSON `{"type":"Polygon","coordinates":[[...]]}` for interoperability
- **Import**: Accepts both WKT (`POLYGON((...))`) and GeoJSON, converts to EWKT
- **Validation**: Min 4 points (triangle + close), WGS84 bounds check

## Architecture

### Component: GeoPolygonMapComponent

Standalone Angular component with three modes:
- **display**: Static polygon render, no interactions
- **edit**: Geoman polygon drawing with vertex drag, single polygon constraint
- **multi-polygon**: Array of `MapPolygon[]` with per-polygon color and click handlers

### Integration Points

| Component | Change |
|-----------|--------|
| `entity.ts` | `GeoPolygon` enum value + `MapPolygon` interface |
| `SchemaService` | Type detection, `_text` select string, full-width column span |
| `DisplayPropertyComponent` | Renders static polygon map |
| `EditPropertyComponent` | Renders editable polygon map (400px height) |
| `MapWidgetComponent` | Polygon mode detection + `colorProperty` support |
| `ListPage` | Map type branching (GeoPoint vs GeoPolygon) |
| `import-export.service.ts` | GeoJSON export formatting |
| `import-validation.worker.ts` | WKT + GeoJSON import validation |

### No Data Transform Changes

Same as GeoPoint: the polygon map component handles EWKT formatting internally, form controls store the EWKT string directly. No changes to `CreatePage.transformValuesForApi()` or `EditPage.transformValuesForApi()`.

## Dogfooding: Flint MI Parcels

The neighborhood-hub example includes a parcels table with `boundary` column exercising the full GeoPolygon pipeline. An import script (`examples/neighborhood-hub/scripts/import-parcels.js`) loads real Flint MI parcel GeoJSON data (78K records from Genesee County Open Data).

## Files Created/Modified

- **New**: `src/app/components/geo-polygon-map/` (4 files)
- **New**: `examples/neighborhood-hub/scripts/import-parcels.js`
- **Modified**: entity.ts, schema.service.ts, display-property, edit-property, map-widget, list.page, import-export.service, import-validation.worker
- **Modified**: neighborhood-hub SQL init scripts (01, 02, 06)
