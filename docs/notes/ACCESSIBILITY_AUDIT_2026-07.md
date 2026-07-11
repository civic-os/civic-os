# Accessibility Audit — July 2026

> **✅ Implementation status (completed, July 2026).** All batches in the plan
> below were implemented and committed. Batches 1–11 remediated the catalogued
> navigation, input, dialog, form-ARIA, list/filter, rows/sorting,
> icons/spinners, routing/status, reorder, geo, and charts/contrast/motion
> issues; Batch 13 added FullCalendar keyboard support. The final **Batch 12
> (process guardrail)** installed an ESLint flat config (`eslint.config.js`)
> that enables the `@angular-eslint/template` accessibility rules and runs in CI
> (`.github/workflows/accessibility.yml`). The a11y lint gate is **live and
> enforced** (`npm run lint` exits non-zero on keyboard/SR violations such as a
> bare `(click)` on a non-interactive element). Residual keyboard hits in
> not-yet-touched components (schema inspector, template editor, system
> functions/policies, chart widget, guided-form nav, series views, user
> management, display-property file/gallery thumbnails) were fixed as part of
> Batch 12. Two high-volume legacy categories — `button-has-type` (253) and
> `label-has-associated-control` (128) — are enabled at `warn` (visible,
> tracked) rather than `error`, deferred to a dedicated mechanical sweep so the
> guardrail batch stayed focused and low-risk; promote them to `error` after
> that sweep lands.

**Scope:** Full Angular frontend (`src/app`), WCAG 2.2 AA lens.
**Method:** Static code audit of all 64 `.html` templates plus 22 inline-template components, six parallel deep inspections (forms, modals/focus, keyboard operability, data tables, app shell/SPA dynamics, non-text content/color), and verification of the claims in `docs/development/ACCESSIBILITY_WCAG.md` against the actual code.

---

## Executive summary

**The app is not keyboard-accessible today.** A keyboard-only or screen-reader user cannot operate the primary sidebar navigation, cannot select a value in the FK search modal (i.e., cannot set foreign-key fields), cannot upload gallery photos, and cannot set geographic fields. These are complete blockers, not degraded experiences.

**The existing accessibility documentation overstates the real state.** `ACCESSIBILITY_WCAG.md` claims "~60% WCAG 2.1 AA compliance achieved." The underlying work (commit `edb111b`, Nov 2025) touched exactly **three** templates: `app.component.html`, `list.page.html`, `edit-property.component.html`. Since then, **61 templates changed and 35 new ones were added** (guided forms, photo galleries, admin pages, dashboards, M:M editors) with no follow-up accessibility work. Today:

- **63 of ~86 templates (73%) contain zero ARIA/role/alt attributes.**
- **265 of 300 Material Symbols ligature icons (88%) are exposed to screen readers** as raw ligature text ("chevron_right", "arrow_back").
- **93 loading spinners; ~4 files have any adjacent `role="status"`/label.**
- pa11y/Lighthouse/Backstop configs exist but **none run in CI** (`.github/workflows/` has only build + unit tests). The pa11y config tests 5 URLs of one example schema, unauthenticated.
- There is **no ESLint config at all**, so the `@angular-eslint` template accessibility rules — which would have caught the majority of findings below at commit time — never ran.
- The three files that *were* remediated in Nov 2025 remain the best-implemented in the app and serve as internal reference patterns. The problem is coverage and process, not skill.

**Root-cause pattern:** `(click)` handlers on non-interactive elements (`<li>`, `<div>`, `<tr>`, `<th>`, `<span>`) and anchors without `href`, instead of native `<button>`/`<a routerLink>`. Fixing this one habit clears most of the Critical/Serious keyboard debt.

**Process gap:** CLAUDE.md's definition of done mandates docs and i18n for every feature — but not accessibility. Every feature shipped since Nov 2025 demonstrates the consequence.

---

## Critical — complete keyboard/AT blockers (WCAG 2.1.1, 4.1.2 — Level A)

### C1. Primary sidebar navigation is mouse-only
`src/app/app.component.html:93` (and 17 sibling `<li (click)>` items through line ~275)
```html
<li (click)="navigate(entity.table_name)">
  <a [class.menu-active]="...">{{ entity.display_name }}</a>
</li>
```
The click handler is on the `<li>`; the inner `<a>` has no `href`/`routerLink`, so it is not focusable. **Home, every entity, and every admin page are unreachable by keyboard.** Fix: `routerLink` on the `<a>` (also gives free `routerLinkActive`, middle-click/new-tab, and correct link semantics).

### C2. User/account dropdown items are mouse-only
`app.component.html:60–71` — My Profile, Preferences, About, Logout/Login, Stop Impersonation are `<a (click)>` with no `href`. The `<details>/<summary>` trigger is keyboard-operable; the items inside are not. (Line 65, Account Settings, correctly uses `[href]` — the fix pattern is one line away.)

### C3. FK search modal — records cannot be selected by keyboard
`src/app/components/fk-search-modal/fk-search-modal.component.html:146–152` (checkbox) and `312–315` (radio). Selection controls carry `tabindex="-1"` and rows are `<tr (click)>` with no tabindex/keydown. **Keyboard users cannot set any foreign-key value app-wide.** Fix: drop the `tabindex="-1"` and let the native checkbox/radio be the focus target.

### C4. Recurrence weekday checkboxes are `display:none`
`src/app/components/recurrence-rule-editor/recurrence-rule-editor.component.ts:105–114` — checkboxes use the Tailwind `hidden` class (removed from tab order and accessibility tree); the visible styled `<span>` has no role/tabindex. Weekday selection is unperceivable and inoperable for keyboard/SR users. Fix: `sr-only` instead of `hidden`, or toggle buttons with `aria-pressed`. Same hidden-input pattern appears in `settings-modal.component.html:143,189` (theme/role selection).

### C5. Photo gallery upload and reorder are pointer-only
`src/app/components/photo-gallery-editor/photo-gallery-editor.component.html:27–35` — the file input is `tabindex="-1"` with no button that triggers it; upload requires clicking the invisible input or drag-drop. Reorder is CDK drag-drop only (lines 49–57) with no keyboard alternative.

### C6. Geographic fields have no keyboard path
- `geo-point-map`: placing a point requires clicking the Leaflet map or "Use My Location" (GPS only). No lat/lng text inputs.
- `geo-polygon-map`: drawing/editing requires mouse on the leaflet-geoman canvas. No coordinate entry fallback at all.

### C7. Dashboard selector menu items unreachable
`src/app/components/dashboard-selector/dashboard-selector.component.html:19,39` — `<a (click)>` without `href`; trigger div also lacks Enter/Space handling and `aria-expanded`.

---

## Serious

### S1. Every `cos-modal` dialog has a broken accessible name
`cos-modal.component.html:8` sets `[attr.aria-labelledby]="titleId"` but no consumer ever applies `titleId` to its heading — the id dangles, so **every dialog in the app (settings, delete confirmation, import, FK search, payment, errors…) announces with no name** (WCAG 4.1.2). Fix in one place: project the id onto the heading or fall back to `aria-label`.

### S2. The core form renderer never sets required/invalid/error associations
`edit-property.component.html` (every generated form field flows through this):
- `isRequired()` is computed but never bound to `required`/`aria-required` — required state is an asterisk only (3.3.2).
- `aria-invalid` is never set anywhere (4.1.2).
- The error block (`:309–368`, correctly `role="alert"`) has no `id` and no input references it via `aria-describedby` — errors aren't discoverable when re-navigating a field (3.3.1, 1.3.1).
- Field descriptions from `metadata.properties` render only as a DaisyUI hover tooltip on a non-focusable span (`:8–12`) — unreachable by keyboard, unannounced, and a 1.4.13 failure.
- `<label [for]>` points at non-existent ids for custom widget types (TimeSlot, GeoPoint/Polygon, PhotoGallery, Payment) whose child components expose no matching id.

Because this is the single form engine, fixing it fixes every create/edit page at once.

### S3. No per-route page titles and no focus management on navigation
- `app.component.ts:160` sets `document.title` once; Angular's `Title` service is never used. Every page shares the identical title (WCAG 2.4.2, Level A).
- Nothing moves focus or announces after `NavigationEnd` — content swaps silently under the user (2.4.3). No `LiveAnnouncer` usage anywhere despite `@angular/cdk` being a dependency.

### S4. Sorting is keyboard-inoperable everywhere it exists
`<th (click)>` with no button/tabindex/keydown on: `list.page.html:134–137` (which even advertises `aria-sort`), `admin-galleries:145–172`, `admin-files:158–180`, `admin-payments:106–126`, `fk-search-modal:129,295`. Fix: wrap header labels in `<button>`.

### S5. List rows: `role="link"` on `<tr>` + nested links
`list.page.html:162–184` — `role="link"` overrides row semantics (breaks SR table navigation), rows contain real `mailto:`/`tel:` links from `display-property` (invalid nested interactive), and every row shares the same accessible name ("View Issue" × 25 — 2.4.4).

### S6. Drag-only reordering in admin pages
`entity-management.page.html:25–34` and `property-management.page.html:55–66,189–194` use CDK drag-drop with no keyboard alternative (CDK provides none out of the box). Menu order and property order cannot be managed by keyboard.

### S7. gallery-lightbox has no focus trap or restoration
`gallery-lightbox.component.html:3–8` — hand-rolled overlay (unlike cos-modal): Tab escapes to background content, focus never moves in on open or back on close. Also: arrow-key direction is not RTL-mirrored while the visible chevrons are.

### S8. Filter bar inputs are unlabeled
`filter-bar.component.html:36–122` — group labels have no `for`; boolean select, date-range, and number-range inputs have no accessible names. Date inputs rely on `placeholder`, which `type="date"` doesn't even render. Checkbox groups lack fieldset/group semantics. The toggle button has no `aria-expanded` and, on mobile, no accessible name (icon ligatures only).

---

## Moderate (systemic)

| Finding | Where | SC |
|---|---|---|
| 265/300 ligature icons not `aria-hidden`; SRs read "check_circle Succeeded", "delete Delete" | app-wide; worst: detail page, all admin pages, payment-badge | 1.1.1 |
| Icon-only buttons named by their ligature: back buttons announce as "arrow_back" | create/edit/detail/entity-code pages; chart export ("download"); ~17 buttons rely on `title` only | 4.1.2 |
| 93 spinners silent; content swaps unannounced; results count / import flow steps / sort changes have no live region | list, import-modal, dashboards, admin pages | 4.1.3 |
| Detail-page error alerts lack `role="alert"` (payment, action, guided-form, delete errors) | `detail.page.html:62,70,79,262,324` | 4.1.3 |
| No toast/notification system; interceptor logs HTTP failures to Matomo only; many services `catchError(() => of([]))` silently | shell-wide | 4.1.3 |
| Boolean cells render as icon glyphs only ("check_box" / "disabled_by_default") | `display-property.component.html:48–55` | 1.1.1 |
| Media thumbnails (image, PDF, gallery) open viewers via `(click)` on divs — pointer-only | `display-property.component.html:155,167,181,243` | 2.1.1 |
| Guided-form step navigation is `<li (click)>` — pointer-only | `guided-form-nav.component.html:9–20` | 2.1.1 |
| Filtered-list dashboard widget rows pointer-only (list page fixed, widget missed) | `filtered-list-widget.component.html:45` | 2.1.1 |
| Drawer/dropdown toggles lack `aria-expanded` (drawer checkbox hack, filter bar, action-bar overflow, dashboard selector) | shell + components | 4.1.2 |
| Sidebar has no `<nav>` landmark or label; pagination has no `<nav>` | app shell, pagination | 1.3.1 |
| Duplicate `id="pageSize"` when pagination renders twice per page | `pagination.component.html:64–67` | 4.1.2 |
| No `autocomplete` attributes anywhere, incl. profile page name/email/tel | app-wide | 1.3.5 |
| No `prefers-reduced-motion` handling; modal scale animations, list highlight-pulse, theme hover transforms unconditional | `cos-modal.css`, `list.page.css:95`, theme-picker | 2.3.3 |
| No global `:focus-visible` baseline; 35 DaisyUI themes enabled with no contrast validation (incl. `wireframe`, `pastel`); "DaisyUI guarantees contrast" claim in docs is not a guarantee | `styles.css` | 2.4.7, 1.4.3, 1.4.11 |
| Hardcoded white text over arbitrary admin-chosen hex background — bypasses the app's own `getContrastTextColor()` util | `admin-statuses.page.html:188` | 1.4.3 |
| `getContrastTextColor()` uses YIQ threshold 128, not a 4.5:1 ratio check — mid-luma hues can fail | `utils/color.utils.ts` | 1.4.3 |
| Charts (unovis SVG) have no text alternative or data-table fallback (CSV download ≠ in-page alternative) | `chart-widget` | 1.1.1 |
| FullCalendar time-slot views: no keyboard config, no list alternative | `time-slot-calendar` | 2.1.1 |
| System functions/policies collapse rows are `<div (click)>` | `system-functions.page.html:53`, `system-policies.page.html:50` | 2.1.1 |
| Schema inspector panel expand/navigate divs pointer-only; 40 inline SVGs unlabeled | `schema-inspector-panel` | 2.1.1, 1.1.1 |
| PDF viewer iframe has no `title` | `pdf-viewer.component.html:10` | 4.1.2 |
| Detail label/value pairs use bare `<label>` bound to nothing (should be `<dl>`) | `display-property.component.html:2–13` | 1.3.1 |
| Server-error modal detail hidden behind an unlabeled collapse checkbox | `create.page.html:134`, `edit.page.html:260` | 4.1.2 |
| Theme picker: current theme communicated by ring color only — no `aria-pressed`/`role="radio"` | `theme-picker.component.ts:57,83` | 4.1.2 |
| `colspan="100%"` is invalid (treated as 1) | `list.page.html:188` | 1.3.1 |
| Emoji file-type indicators (📄, 📎) with no text alternative | `display-property.component.html:177,200` | 1.1.1 |
| Empty `alt` fallback on admin-authored image widgets marks informative images decorative | `image-widget.component.ts:70` | 1.1.1 |
| Heading levels skip (63 `<h3>` vs 10 `<h2>`); h1 present on most pages | app-wide | 1.3.1 (best practice) |

---

## What's genuinely done right (preserve these)

- **Skip link** (`app.component.html:2–4`) — real, focus-revealed, RTL-aware, targets `<main id="main-content">`.
- **`<html lang>` and `dir` update reactively on locale change** (`locale.service.ts:82–89`); logical CSS properties used consistently for RTL.
- **cos-modal focus mechanics**: `cdkTrapFocus` + auto-capture, ESC close, focus restoration via destroy, backdrop-close gating while busy, body scroll lock. (Only the accessible *name* is broken — S1.)
- **List page** (the Nov 2025 work): true table semantics with sr-only caption and `scope="col"`, `aria-sort`, keyboard-operable rows with Enter *and* Space, labeled filter chips/search/clear, `aria-current` pagination with labeled prev/next.
- **edit-property native inputs** are correctly label-associated via `[for]`/`[id]` per column name; upload progress/errors use proper live regions.
- **Color is never the only channel** in the display layer — status/category badges include text, color chips show hex, payment badges pair icon + text. A real contrast utility (`getContrastTextColor`) computes badge text color.
- **Alt-text fallback chains** (alt_text → filename → generic) in viewer, lightbox, thumbnails.
- **No focus-outline suppression anywhere; no positive tabindex anywhere.**
- **Blockly pages are read-only with a keyboard-accessible text alternative** (Blocks/Source toggle → Prism text).
- **No auto-dismissing toasts** → no timing failures.

---

## Remediation strategy

**Phase 0 — unblock keyboard users (days, small diffs):**
1. `routerLink` on sidebar/user-menu/dashboard-selector anchors (C1, C2, C7).
2. Remove `tabindex="-1"` from FK-modal selection controls (C3).
3. `hidden` → `sr-only` on recurrence weekday and settings-modal inputs (C4).
4. Visible button to trigger the gallery file input (C5).
5. Lat/lng text inputs as fallback on geo fields (C6).

**Phase 1 — fix the multipliers (shared components, one fix = app-wide):**
- edit-property: bind `required`/`aria-invalid`, give the error block an id + `aria-describedby`, associate descriptions, fix dangling `for` on custom widgets (S2).
- cos-modal: wire `titleId` to projected headings (S1).
- A shared icon component or wrapper that defaults `aria-hidden="true"` (kills the 265-icon problem structurally); a shared spinner with `role="status"` + sr-only text.
- Sort-header `<button>` pattern; apply the list-row keyboard pattern to filtered-list widget and guided-form nav.
- Per-route `Title` + focus-to-main on `NavigationEnd` (S3).

**Phase 2 — process, so it doesn't regress:**
- Add ESLint with `@angular-eslint/template` accessibility rules (`alt-text`, `click-events-have-key-events`, `interactive-supports-focus`, `label-has-associated-control`, `valid-aria`, etc.). Most findings in this audit are mechanically detectable.
- Wire pa11y into CI with an authenticated session and representative URLs (admin pages, guided forms, modals open).
- Add accessibility to the per-feature definition of done in CLAUDE.md, alongside docs and i18n.
- Update `ACCESSIBILITY_WCAG.md`'s status section to reflect this audit; retire the "~60% compliant" claim.
- Constrain or contrast-validate the theme list; add `prefers-reduced-motion` and a global `:focus-visible` style.
- Manual screen-reader pass (VoiceOver/NVDA) on: list → detail → edit round trip, FK modal, guided form, import flow.

---

## Handover notes for implementation

This section makes the design decisions so an implementing agent does not have to. Follow these patterns exactly; where a finding above conflicts with a decision here, this section wins. Line numbers in the findings will have drifted — re-locate by the quoted code pattern, not the line number.

### Non-negotiable ground rules

1. **Every new user-visible string — including every `aria-label` — goes through the translate pipe.** Pattern: `[attr.aria-label]="'a11y.close_dialog' | translate"`. Add new keys to `src/app/i18n/en.translations.ts` under an `a11y.` prefix (follow the existing flat-key style, e.g. `nav.open_menu`). Follow the New Feature i18n Checklist in `docs/notes/I18N_DESIGN.md`. Hardcoded English aria-labels (there are a few already, e.g. `aria-label="User menu"` in app.component.html) should be converted to keys when touched.
2. **Run `npm run test:headless` before every commit** (repo mandate). Adding `Title`, `LiveAnnouncer`, or new injections to components will break existing spec mocks — update the mocks, don't skip tests.
3. **Follow the 5-layer E2E verification** in `docs/development/E2E_VERIFICATION.md` for each batch: unit tests, then browser-verify the specific keyboard flow listed in that batch's acceptance criteria (use the browser tooling; Tab/Enter/Space through the real UI).
4. **Zero visual regressions is the target** for Phases 0–1. Every fix below was chosen to be visually invisible (or trivially close). If a fix forces a visual change, stop and flag it.
5. **CSS logical properties only** (`ms-`/`me-`/`start-`/`end-`) per the RTL rule in CLAUDE.md.

### Pattern decisions (settled — do not re-litigate)

**D1. Sidebar/menu navigation → real router links.**
Move navigation onto the `<a>` elements: `<a [routerLink]="...">`, delete the `(click)` from the `<li>`. Where the click handler also closes the drawer (`this.drawerOpen = false`), keep that behavior via `(click)` *on the anchor alongside* `routerLink`. Replace the `isRouteActive()` class bindings with `routerLinkActive` where straightforward; keeping the existing bindings is also acceptable. Same treatment for the user dropdown (`navigateToProfile()` etc. become `routerLink` where they navigate; pure actions like `logout()` become `<button>` styled by DaisyUI's menu — a `<button>` inside `menu li` renders identically to an `<a>` in DaisyUI 5). Dashboard-selector items: same split — navigation gets `routerLink`, selection actions become `<button>`.

**D2. List rows → first-cell link, row-click as mouse convenience.**
Remove `role="link"`, `tabindex`, `aria-label`, and the keydown handlers from the `<tr>` (delete `onRowKeyPress` if now unused). Keep `[routerLink]`-equivalent click-to-navigate on the row for mouse users (plain `(click)` + `cursor-pointer`, no ARIA). Wrap the **first cell's rendered value** in a real `<a [routerLink]="detailUrl(row)">` so each row exposes exactly one tabbable link whose accessible name is the record's display value (fixes the "View Issue ×25" problem for free). If a row's first column renders empty, fall back to the record id as link text with an sr-only prefix ("View record {id}"). Inner `mailto:`/`tel:` links already work; add `$event.stopPropagation()` on them so they don't trigger row navigation. Apply the same pattern to `filtered-list-widget`.

**D3. Drag-and-drop reorder → add move up/down buttons, keep drag for mouse.**
Do NOT attempt keyboard drag-and-drop (CDK has none; the ARIA grab/drop pattern is not worth the complexity). Add two icon buttons per item (`arrow_upward`/`arrow_downward`, `btn-ghost btn-xs`, icons `aria-hidden`), labels like `a11y.move_up` translated with the item name: "Move {name} up". Disable at the ends. After a move, announce via a single shared `aria-live="polite"` region in the component: "{name} moved to position {i} of {n}" (translated). Applies to: entity-management, property-management (both lists), photo-gallery-editor (grid order — use "Move earlier/later" wording, keys `a11y.move_earlier`/`a11y.move_later`). This adds small visible buttons — the one sanctioned visual change; keep them ghost-styled and compact.

**D4. Geo fields → coordinate text entry as fallback, map stays primary.**
- `geo-point-map` (edit mode): add labeled decimal `Latitude`/`Longitude` number inputs (step `0.000001`) below the map, two-way synced with the marker (typing updates marker + form value; map click updates inputs). Keep "Use My Location".
- `geo-polygon-map` (edit mode): add a collapsible "Edit coordinates" `<textarea>` (DaisyUI collapse with a real `<button>`/checkbox toggle, not a click-div) accepting one `lat, lng` pair per line, ring auto-closed; parse on blur/Apply button, validate (≥3 points, numeric ranges), sync both directions. This is a fallback, not a redesign — document it in the component and INTEGRATOR_GUIDE.
- No geocoding/address search — that's a new external dependency and out of scope.

**D5. Charts → sr-only data table, chart marked decorative.**
Wrap the unovis container with `aria-hidden="true"`; render an adjacent `sr-only` `<table>` built from the same widget data (caption = widget title, first column = category/x value, one column per series). No visible toggle, no visual change. The existing CSV button stays.

**D6. cos-modal accessible name → new `label` input.**
Add a required-in-practice `label = input<string>()` to `CosModalComponent`; template sets `[attr.aria-label]="label() || null"` and **removes** the dangling `[attr.aria-labelledby]="titleId"` (delete `titleId`). Update all 29 consumer files to pass `[label]` with the same translated string as their visible heading. Where a consumer has no visible heading (rare), add an appropriate translated label. Do not attempt the projected-heading-id approach — 29 consumers make the input approach strictly simpler and testable.

**D7. Hidden inputs driving styled siblings → `sr-only`, plus visible focus.**
Replace class `hidden` with `sr-only` on the recurrence weekday checkboxes and settings-modal theme/role radios+checkboxes (`sr-only` keeps them focusable and preserves `peer-*` sibling styling — verified). Add `peer-focus-visible:ring-2 peer-focus-visible:ring-primary` (or equivalent) to the styled sibling so keyboard focus is visible.

**D8. Sort headers → button inside `<th>`.**
`<th scope="col" [attr.aria-sort]="...">` keeps `aria-sort`; the label + sort icon move into a full-size `<button type="button" class="...">` that carries the `(click)`. Style the button to fill the header cell (no visual change: inherit font, `w-full text-start bg-transparent p-0`). Applies to list page, admin-galleries, admin-files, admin-payments, fk-search-modal.

**D9. Route change behavior → title + focus, no announcer.**
On `NavigationEnd` (skip the initial navigation): set `document.title` via Angular `Title` service to "{Page name} – Civic OS" (page name from route `data.title` for static routes; List/Detail/Create/Edit pages update it themselves once entity metadata resolves, e.g. "Issues – Civic OS", "Edit Issue #42 – Civic OS"); then move focus to `<main id="main-content" tabindex="-1">` (add the tabindex; suppress its focus outline with `outline-none` — this is the one place outline suppression is correct). Do NOT also fire a LiveAnnouncer message — title + focus is sufficient and double-announcing is noise.

**D10. Icons → bulk attribute sweep, not a wrapper component.**
Add `aria-hidden="true"` to every decorative `material-symbols-outlined` span (one next to visible text = decorative). Icon-only buttons get a translated `aria-label` AND `aria-hidden` on the icon. Do NOT introduce an `<app-icon>` component — rewriting 300 call sites churns every template for no behavioral gain; prevention comes from lint + convention (see process batch). Also sweep the 40 inline `<svg>`s with `aria-hidden="true"` (all are decorative). Add the convention to `docs/development/ANGULAR.md`.

**D11. Spinners → one shared component.**
Create `LoadingIndicatorComponent` (inline template: `<span role="status"><span class="loading loading-spinner" aria-hidden="true"></span><span class="sr-only">{{ 'a11y.loading' | translate }}</span></span>`, size input). Replace bare spinners with it opportunistically — prioritize page/section-level spinners (list tbody, dashboards, admin pages, file-thumbnail); button-internal spinners inside already-labeled buttons may keep a plain `aria-hidden` spinner.

**D12. FK search modal rows.**
Remove `tabindex="-1"` from the row checkboxes/radios so the native control is the focus target (label association or `aria-label` = the record's display name). Keep row `(click)` as mouse convenience; no role/tabindex on the `<tr>`. Search inputs get translated `aria-label`s.

### Batch plan (each = one commit/PR, independently shippable, in order)

| # | Batch | Contents | Acceptance criteria (verify in browser) |
|---|---|---|---|
| 1 | Keyboard unblock: navigation | D1 (sidebar, user menu, dashboard-selector) | From page load, Tab reaches every sidebar item, user-menu item, and dashboard option; Enter activates; drawer still closes on selection; middle-click opens entity in new tab |
| 2 | Keyboard unblock: inputs | D7, D12, gallery upload button (visible `btn` labeled "Add photos" triggering the file input), C4/C5 | Weekday toggles, theme/role pickers, FK record selection, and photo upload all operable with Tab/Space/Enter; focus visibly indicated |
| 3 | Dialog naming + lightbox | D6; add `cdkTrapFocus`+auto-capture to gallery-lightbox; RTL-mirror its arrow keys; `title` on pdf-viewer iframe | VoiceOver announces a name for every dialog; Tab cannot escape the lightbox; focus returns to trigger on close |
| 4 | Form engine ARIA | S2 in full: `required`/`aria-invalid`/`aria-describedby` wiring, error-block ids, description association (move description to a focusable `<button>` tooltip or always-visible `aria-describedby` text — prefer the latter, sr-only if needed), fix dangling `for` on custom-widget types (drop the `for` and use `role="group"`+`aria-labelledby` on the wrapper) | With SR on a create page: each field announces name, required state, description; after failed submit, each invalid field announces its error |
| 5 | Filter bar + list polish | S8 (unique ids via `crypto.randomUUID()` or an instance counter, `for`/`id` everywhere, fieldset/legend on checkbox groups, `aria-expanded` on toggle, mobile `aria-label`), duplicate `id="pageSize"`, pagination `<nav>`, results-count live region, `aria-busy` on table, `colspan` fix | All filter inputs announce distinct names; filtering announces the new result count |
| 6 | Rows + sorting | D2, D8 | Tab reaches one link per row named by the record; Enter on a header button sorts and `aria-sort` updates |
| 7 | Icons + spinners + booleans | D10, D11, boolean cells get sr-only Yes/No (translated), icon-only back buttons get labels, emoji file indicators get sr-only text | Spot-check with SR: no ligature names announced on detail/list/admin pages |
| 8 | Routing + status | D9; `role="alert"` on the five detail-page alerts; import-modal step/live-region wiring (`role="status"` on step container, `role="alert"` on error alerts, labels on `<progress>`) | Title changes per page; focus lands on main after nav; import flow announces validation/success |
| 9 | Reorder buttons | D3 | Full reorder of entities/properties/photos with keyboard only; moves announced |
| 10 | Geo fallback | D4 | Set a point and a polygon using only the keyboard |
| 11 | Charts + contrast + motion + themes | D5; `admin-statuses.page.html` hardcoded white → `getContrastTextColor()`; upgrade `getContrastTextColor` to check the actual 4.5:1 WCAG ratio (compute relative luminance, pick black/white by ratio); global `@media (prefers-reduced-motion: reduce)` block; global `:focus-visible` ring (`outline: 2px solid` in a theme-aware color, `outline-offset: 2px`); autocomplete attrs on profile page (`name`, `email`, `tel`); **theme two-tier policy (decided by Daniel 2026-07-10)**: constrain `DEFAULT_THEME` to the vetted/recommended list in `src/app/constants/themes.ts` (fall back to `corporate` with a console warning if a deployer sets an unvetted theme), keep all 35 user-selectable, and label unvetted themes in the theme picker with a translated "reduced contrast" note | Lighthouse a11y ≥ 90 on list/detail/create; unvetted `DEFAULT_THEME` env value falls back safely |
| 12 | Process | ESLint flat config with `@angular-eslint/template` a11y rules (`alt-text`, `click-events-have-key-events`, `interactive-supports-focus`, `label-has-associated-control`, `valid-aria`, `button-has-type`); fix or explicitly disable-with-comment remaining hits; wire pa11y into `test.yml` CI (authenticated via test Keycloak user, add admin + guided-form URLs); update `ACCESSIBILITY_WCAG.md` status section to point here; add a11y line to CLAUDE.md's feature checklist | CI fails on a template with a bare `(click)` div |

### Explicitly deferred (needs Daniel or runtime research — do not attempt)

- ~~**Theme policy**~~ **Decided (2026-07-10): two-tier.** Vetted defaults + all themes user-selectable with reduced-contrast labeling. Folded into Batch 11.
- ~~**FullCalendar keyboard navigation**~~ **Resolved by research (2026-07-10), now Batch 13.** Repo uses FullCalendar 6.1.19 (post-v5.10 a11y overhaul: toolbar/view controls already accessible). Plan: (a) set `eventInteractive: true` in `time-slot-calendar` — makes events tabbable, Enter/Space fires the existing `eventClick` path; (b) verify keyboard-driven `eventClick` opens the same detail/edit flow in the browser; (c) keyboard *creation* deliberately relies on the equivalent path: the `edit-time-slot` dual `datetime-local` inputs (keyboard-native) — drag-select on the calendar remains a mouse convenience. Upstream keyboard slot-selection ([fullcalendar#6528](https://github.com/fullcalendar/fullcalendar/issues/6528)) and keyboard drag/resize ([fullcalendar#2535](https://github.com/fullcalendar/fullcalendar/issues/2535)) are long-open with no merged/pending PR and no third-party plugin — do not wait for them. Document the equivalent-path rationale in the component and INTEGRATOR_GUIDE.
- **Schema editor (JointJS) keyboard manipulation**: layout-only convenience; low priority, separate design.
- **Visible-table toggle for charts** (beyond D5's sr-only table): visual design decision.

---

*Audit performed 2026-07-10; handover section added same day. Companion doc: `docs/development/ACCESSIBILITY_WCAG.md` (status section now superseded by this audit).*
