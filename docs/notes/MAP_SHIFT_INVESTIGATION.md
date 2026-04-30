# Map Shift Investigation — RESOLVED

## Problem

All Leaflet map overlays (markers and polygons) rendered ~24px too high relative to the OSM tile features they should align with. This was a longstanding issue — the GeoPoint component had a deliberate `iconAnchor` workaround shifting markers down by 20px to compensate.

## Root Cause

**Tailwind Typography's `.prose img` rule** applied `margin: 2em 0` to Leaflet tile `<img>` elements.

All CRUD pages (detail, list, edit, create) wrap content in `<div class="prose">`. Tailwind Typography's prose styles apply vertical margin to all descendant `<img>` elements. Leaflet tile images (`<img class="leaflet-tile">`) are caught by this rule because they're dynamically created `<img>` tags inside the prose scope.

Since `.leaflet-container` sets `font-size: 12px`, `2em` computes to `24px`. This pushed all tile images down by 24px while SVG overlays (polygons) and absolutely-positioned marker icons remained in their correct positions — making overlays appear shifted ~24px northward relative to map features.

### Why the shift was 24px, not 20px

The original GeoPoint `iconAnchor` hack used a 20px offset, which was an approximation. The actual CSS-induced shift was always 24px (`2em × 12px`). The 4px discrepancy was small enough to seem "close enough" when the hack was written.

### Why standalone tests didn't reproduce it

The standalone HTML test pages used Tailwind CDN + DaisyUI CDN + Leaflet but never wrapped the map in a `<div class="prose">`. Without the prose ancestor, the Typography plugin's img rules don't apply.

## Fix

Added `not-prose` class to the `map-wrapper` div in both map component templates. This tells Tailwind Typography to stop styling descendant elements.

| File | Change |
|------|--------|
| `geo-polygon-map.component.html:1` | `<div class="map-wrapper">` → `<div class="map-wrapper not-prose">` |
| `geo-point-map.component.html:1` | `<div class="map-wrapper">` → `<div class="map-wrapper not-prose">` |

### GeoPoint iconAnchor workaround removal (also in this fix)

With the root cause fixed, the GeoPoint component's workaround hacks were removed:

| File | Change |
|------|--------|
| `geo-point-map.component.ts:169` | `iconAnchor: [12, 21]` → `[12, 41]` (standard Leaflet value) |
| `geo-point-map.component.ts:245-251` | Removed `point.y -= 20` click offset hack |
| `geo-point-map.component.ts:570-577` | Highlighted icon anchor `[15, 27]` → `[16, 52]` (correct proportional value) |
| `geo-point-map.component.spec.ts:611-612` | Updated test assertion |

## Diagnostic Trail

### What we ruled out

| Hypothesis | Result |
|-----------|--------|
| Tailwind Preflight CSS alone | No shift in standalone test |
| DaisyUI CSS interference | No shift with DaisyUI CDN in standalone test |
| Map initialization timing / `invalidateSize()` | `invalidateSize()` reported zero delta |
| CSS pane/transform misalignment | All panes at `position: absolute; top: 0; left: 0` |
| Container padding/border | `paddingTop: 0`, `borderTopWidth: 0` |
| Data source mismatch (county GIS vs OSM) | GeoPoint marker hack proves it's not data |

### The breakthrough diagnostic

```javascript
// In-browser CSS audit revealed:
getComputedStyle(tileOnPage).margin     // "24px 0px" — WRONG!
getComputedStyle(freshTileOnBody).margin // "0px"     — correct

// Adding not-prose to wrapper:
wrapper.classList.add('not-prose');
getComputedStyle(tileOnPage).margin     // "0px"     — FIXED!
```

The tile images only had margin when inside the Angular component's DOM (which sits inside a `prose` div), not when appended directly to `<body>`.

## Lesson Learned

When using Leaflet (or any library that creates DOM elements dynamically) inside Tailwind Typography's `prose` scope, always add `not-prose` to the map container wrapper. The Typography plugin's broad element selectors (`img`, `video`, `hr`, etc.) will interfere with library internals.

### General Rule: `not-prose` for Sensitive Components

Any component that renders DOM elements with precise positioning, sizing, or layout expectations should declare `not-prose` on its outermost wrapper when it may appear inside a `prose` scope. Tailwind Typography applies styles to bare HTML elements (`img`, `video`, `table`, `hr`, `h1`-`h6`, `p`, `ol`, `ul`, `li`, `blockquote`, `figure`, `figcaption`, `code`, `pre`) — any of these created dynamically by a third-party library will be affected.

**Components that should always use `not-prose`:**
- Map components (Leaflet, Mapbox) — tile `<img>` elements get unwanted margin
- Diagram/canvas libraries (JointJS, Blockly, D3) — SVG/HTML elements get unwanted typography styles
- Rich text editors — internal `<p>`, `<h1>`, etc. will inherit prose sizing
- File upload / drag-drop zones — `<img>` previews get unwanted margin
- Any component that creates `<img>`, `<video>`, `<table>`, or heading elements dynamically

**Why this is easy to miss:** The affected elements are created at runtime by JavaScript libraries, not in Angular templates. They don't appear in source code review, and the CSS interference only happens when the component is rendered inside a `prose` ancestor — which may not be the case in standalone unit tests or isolated demos.
