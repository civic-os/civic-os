# Civic OS Accessibility Conformance Report (WCAG 2.1)

**Product:** Civic OS frontend (Angular meta-application framework)
**Report date:** 2026-07-11
**Evaluation methods:** Full static code audit (July 2026, all templates), automated
linting (`@angular-eslint/template` accessibility rules, enforced in CI), axe-core
via pa11y, and machine-driven keyboard/DOM verification against a live instance
(pothole example schema) using real key-event injection. A human screen-reader
pass (VoiceOver/NVDA) per `docs/development/ACCESSIBILITY_MANUAL_TESTING.md` is
the remaining validation step and is noted where it is the source of confidence.
**Remediation record:** `docs/notes/ACCESSIBILITY_AUDIT_2026-07.md` (audit +
14 remediation batches, all landed).

> **Scope note.** Civic OS is a framework that auto-generates UI from database
> schemas. This report covers the framework-generated UI (list/detail/create/edit
> pages, navigation, dialogs, admin pages, built-in widgets). Deployment-specific
> content (entity names, descriptions, admin-chosen status colors, uploaded
> images' alt text) is authored by integrators; the framework provides the
> accessible mechanics (e.g., computed contrast for badge text, alt-text fields)
> but each deployment should validate its own content. Keycloak's hosted
> login/account pages are third-party and have known upstream issues
> (keycloak#36479, #36480).

**Conformance levels:** Supports / Partially Supports / Does Not Support / Not Applicable

## Table 1: WCAG 2.1 Level A

| Criterion | Level | Status | Remarks |
|---|---|---|---|
| 1.1.1 Non-text Content | A | Supports | Decorative icons/SVGs `aria-hidden` (verified 0 exposed); icon-only controls labeled; boolean values announced Yes/No; charts have sr-only data tables; image alt fallback chains. Integrator-supplied images depend on authored alt text. |
| 1.2.1–1.2.3 Time-based Media | A | Not Applicable | Framework renders no audio/video content of its own; embedded YouTube (`@[video]`) relies on YouTube's player. |
| 1.3.1 Info and Relationships | A | Supports | Real table semantics with captions/scope; labels programmatically associated (`for`/`id`, `aria-describedby`); fieldset/legend groups; landmark structure; heading-per-page. |
| 1.3.2 Meaningful Sequence | A | Supports | DOM order matches visual order; logical CSS properties for RTL. |
| 1.3.3 Sensory Characteristics | A | Supports | Instructions do not rely on shape/location alone. |
| 1.4.1 Use of Color | A | Supports | Status/category badges pair color with text; audit found zero color-only information channels. |
| 1.4.2 Audio Control | A | Not Applicable | No auto-playing audio. |
| 2.1.1 Keyboard | A | Supports | Machine-verified with real key events: navigation, drawer toggle, sorting, row links, form entry, FK search modal selection, settings toggles, reorder buttons, geo coordinate entry. Calendar events focusable (`eventInteractive`); calendar drag-select and map click have documented equivalent paths (datetime inputs; coordinate inputs). Schema-editor canvas drag is a visual convenience with data editable elsewhere. |
| 2.1.2 No Keyboard Trap | A | Supports | Modal focus traps release on Escape/close; verified live. |
| 2.1.4 Character Key Shortcuts | A | Not Applicable | No single-character shortcuts. |
| 2.2.1 Timing Adjustable / 2.2.2 Pause, Stop, Hide | A | Supports | No time limits; no auto-dismissing content. |
| 2.3.1 Three Flashes | A | Supports | No flashing content. |
| 2.4.1 Bypass Blocks | A | Supports | Skip link (verified: first tab stop, visible on focus, moves focus to main). |
| 2.4.2 Page Titled | A | Supports | Per-route titles (verified on direct load and in-app navigation, including dynamic entity/record titles). |
| 2.4.3 Focus Order | A | Supports | Focus moves to main on page change but is retained on same-page updates (sort/pagination); modal focus captured and returned to trigger (verified live). |
| 2.4.4 Link Purpose (In Context) | A | Supports | Row links named by record display value with sr-only fallback for empty values. |
| 2.5.1 Pointer Gestures / 2.5.2 Pointer Cancellation | A | Supports | No path-based gestures required; drag interactions have single-pointer and keyboard alternatives. |
| 2.5.3 Label in Name | A | Supports | Accessible names contain visible label text; enforced patterns via lint. |
| 2.5.4 Motion Actuation | A | Not Applicable | No motion-operated features. |
| 3.1.1 Language of Page | A | Supports | `<html lang>` set and updated reactively on locale change (incl. `dir` for RTL). |
| 3.2.1 On Focus / 3.2.2 On Input | A | Supports | No context changes on focus/input; dropdown-on-focus (DaisyUI) does not move focus or change context. |
| 3.3.1 Error Identification | A | Supports | `aria-invalid` + `aria-describedby` → error element with `role="alert"` (verified live: fill/clear/blur produces associated "This field is required"). |
| 3.3.2 Labels or Instructions | A | Supports | All form controls labeled; required state exposed via `aria-required`; metadata descriptions associated via `aria-describedby`. |
| 4.1.1 Parsing | A | Supports | Angular-templated; duplicate-id issues remediated (per-instance uid generation). |
| 4.1.2 Name, Role, Value | A | Supports | Dialogs named; expandable controls expose `aria-expanded`; sort state via `aria-sort`; enforced by lint rules in CI. |

## Table 2: WCAG 2.1 Level AA

| Criterion | Level | Status | Remarks |
|---|---|---|---|
| 1.2.4–1.2.5 Captions/Audio Description | AA | Not Applicable | No framework-produced media. |
| 1.3.4 Orientation | AA | Supports | Responsive layout, no orientation lock. |
| 1.3.5 Identify Input Purpose | AA | Supports | `autocomplete` attributes on user-data profile fields (name/tel); email is display-only. |
| 1.4.3 Contrast (Minimum) | AA | Partially Supports | Default themes constrained to a vetted list; badge text color computed via true WCAG contrast ratio against admin-chosen backgrounds. Users may *opt into* any of 35 DaisyUI themes, some low-contrast (labeled "reduced contrast" in the picker); user-selected presentation is treated as personalization. |
| 1.4.4 Resize Text / 1.4.10 Reflow | AA | Supports | Utility-class responsive layout; wide tables scroll within their own containers. 200%-zoom spot-checked; full-page sweep recommended per manual guide. |
| 1.4.5 Images of Text | AA | Supports | No images of text in framework UI. |
| 1.4.11 Non-text Contrast | AA | Partially Supports | Global `:focus-visible` outline uses the theme primary color; contrast of that indicator varies with user-selected themes (vetted defaults pass). |
| 1.4.12 Text Spacing | AA | Supports | No fixed-height text containers that clip on spacing overrides. |
| 1.4.13 Content on Hover or Focus | AA | Supports | Tooltip descriptions duplicated in screen-reader-accessible text (sr-only spans / `aria-describedby`). |
| 2.4.5 Multiple Ways | AA | Supports | Sidebar navigation, dashboards, full-text search, and direct URLs. |
| 2.4.6 Headings and Labels | AA | Supports | Descriptive per-page `h1` and labeled controls. |
| 2.4.7 Focus Visible | AA | Supports | Global `:focus-visible` ring; no outline suppression (audited); verified visible on formerly-hidden controls (sr-only inputs get sibling focus rings). |
| 3.1.2 Language of Parts | AA | Supports | Single-language content per locale; `lang` updates wholesale on switch. |
| 3.2.3 Consistent Navigation / 3.2.4 Consistent Identification | AA | Supports | Schema-driven generation yields uniform navigation and control identity across all entities. |
| 3.3.3 Error Suggestion | AA | Supports | Validation messages state the requirement (required, min/max, pattern) from metadata; server constraint errors translated to human messages. |
| 3.3.4 Error Prevention (Legal/Financial) | AA | Supports | Destructive actions require confirmation dialogs; payments flow through Stripe's own accessible UI. |
| 4.1.3 Status Messages | AA | Supports | Live regions for loading, result counts, import steps, reorder announcements, and error alerts (`role="alert"`/`role="status"`). Announcement *quality* pending the human screen-reader pass. |

## Known limitations

1. **Human screen-reader validation pending.** All structural/behavioral criteria
   above were machine-verified; announcement quality in VoiceOver/NVDA has not yet
   had a human pass (procedure: `docs/development/ACCESSIBILITY_MANUAL_TESTING.md`).
2. **User-selected low-contrast themes** (1.4.3/1.4.11): deployment defaults are
   vetted; the full 35-theme list remains user-selectable by design, with reduced-
   contrast options labeled.
3. **Schema-editor ERD canvas**: node positioning is mouse-only (visual layout
   convenience; all underlying data is editable through accessible pages).
4. **Keycloak-hosted pages** (login, account management): third-party; tracked
   upstream (keycloak#36479, #36480).
5. **Integrator-authored content**: entity descriptions, status colors (contrast
   computed automatically), and uploaded media alt text are deployment
   responsibilities.

*Maintained alongside `docs/notes/ACCESSIBILITY_AUDIT_2026-07.md`. Update this
report when the human screen-reader pass completes and at each substantial UI
feature release; the ESLint accessibility gate (CI) guards the structural claims
between updates.*
