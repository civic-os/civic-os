# Accessibility Manual Testing Guide

Automated tools (the ESLint a11y gate, pa11y, Lighthouse, axe) catch roughly a
third of accessibility problems — the *structural* ones. The rest are things
only a human can judge: does the screen-reader announcement actually make sense?
Can you complete a task without a mouse? Does focus land somewhere sensible after
a dialog closes? **This guide is the release gate for that other two-thirds.**

It is a hands-on walkthrough, not a checklist. It assumes no prior screen-reader
experience. Every walkthrough is scripted against the **pothole example**
(`examples/pothole`), whose flows exercise every fix from the July 2026
accessibility remediation (see `docs/notes/ACCESSIBILITY_AUDIT_2026-07.md`).

> **When to run this:** before shipping any release, and whenever a PR adds or
> changes interactive UI (a new widget, a new page, a modal, a form control).
> The ESLint a11y gate runs in CI on every PR; this human pass is what CI cannot
> automate. Budget ~30 minutes for the full script, ~5 for a single-feature spot
> check.

---

## Table of contents

- [Setup: get the app running with data](#setup-get-the-app-running-with-data)
- [Part 1 — Keyboard-only pass (no screen reader, ~10 min)](#part-1--keyboard-only-pass)
- [Part 2 — Screen-reader pass (~15 min)](#part-2--screen-reader-pass)
  - [Turning on VoiceOver (macOS)](#turning-on-voiceover-macos)
  - [Turning on NVDA (Windows)](#turning-on-nvda-windows)
  - [The only keys you need](#the-only-keys-you-need)
  - [Scripted screen-reader walkthrough](#scripted-screen-reader-walkthrough)
- [Part 3 — axe DevTools browser extension (~5 min)](#part-3--axe-devtools-browser-extension)
- [Part 4 — Visual checks (zoom, contrast, reduced motion)](#part-4--visual-checks)
- [Pass/fail record](#passfail-record)
- [Appendix: what each check maps to](#appendix-what-each-check-maps-to)

---

## Setup: get the app running with data

You need the frontend plus a backend with rows to look at. The pothole example is
the reference target.

```bash
# 1. Start the backend (Postgres + PostgREST + Keycloak)
cd examples/pothole
cp .env.example .env            # edit POSTGRES_PASSWORD to any value
docker compose up -d
./fetch-keycloak-jwk.sh          # once Keycloak is up; wires PostgREST JWT verification

# 2. Load mock data (so lists/detail pages aren't empty)
#    From the repo root:
docker compose -f examples/pothole/docker-compose.yml exec -T postgres \
  psql -U postgres -d civic_os_db -f - < examples/pothole/pothole-mock-data.sql

# 3. Start the frontend (repo root)
npm start                        # http://localhost:4200
```

Log in at `http://localhost:4200` with **testadmin / testadmin** (admin sees the
most surface: admin pages, permissions, user management). `testuser / testuser`
is useful for a second, lower-privilege pass.

> The pothole entity is **`Issue`** (PascalCase). URLs are `/view/Issue`,
> `/create/Issue`, `/detail/Issue/<id>`.

---

## Part 1 — Keyboard-only pass

**Put the mouse away. Physically move it aside if that helps.** You will use only:

| Key | Action |
|-----|--------|
| `Tab` / `Shift+Tab` | Move to next / previous interactive element |
| `Enter` | Activate a link or button |
| `Space` | Activate a button; toggle a checkbox; page down |
| `Arrow keys` | Move within a control (select, radio group, menu, calendar) |
| `Esc` | Close a modal / dropdown |

As you go, watch for two things: **(a) can you reach and operate everything?**
and **(b) is the focus indicator always visible** — you should never lose track
of where you are. The app defines a `:focus-visible` outline globally; if focus
ever "disappears," that's a finding.

### 1.1 — App shell and navigation

1. Load `http://localhost:4200`. Press `Tab` **once**. A **"Skip to main content"**
   link should appear at the top-left. Press `Enter` — focus jumps into the page
   body. ✅ *Skip link works (WCAG 2.4.1).*
2. Reload. `Tab` to the hamburger / sidebar. Tab through the nav items (Home, each
   entity, admin items). Each should focus and show an outline. Press `Enter` on
   **Issue** — you navigate to the list. ✅ *Sidebar is real links, keyboard-operable
   (2.1.1) — this was the #1 blocker before remediation.*
3. Open the user menu (top-right, `Tab` to it, `Enter`). Tab through **My Profile /
   Preferences / About / Logout**. Each is reachable and activates. ✅

### 1.2 — List page: sorting, filtering, rows

On `/view/Issue`:

1. `Tab` to a **column header** — it's a button. Press `Enter`. The rows re-sort and
   the sort indicator changes. Press `Enter` again — it reverses. ✅ *Sortable
   headers are keyboard-operable (2.1.1); the header carries `aria-sort`.*
2. `Tab` to the **Filters** button, `Enter`. The filter drawer opens. Tab into it —
   every field (status checkboxes, date range, number range) is reachable and
   labeled. Set a filter; the list updates. ✅
3. Tab into the table body. Each row's **first cell is a link** — `Tab` reaches
   exactly one link per row, and `Enter` opens that record's detail page. ✅ *(Rows
   are no longer fake `role="link"` elements.)*

### 1.3 — Create form and validation

On `/create/Issue`:

1. `Tab` through the fields. Every input is reachable and has a visible label.
2. Without typing anything, `Tab` past the required **display name** field (or press
   the save button). An error message appears. ✅ *The field is marked required and
   the error is associated (you'll hear this in Part 2).*
3. Find the **FK / status dropdown** that opens a search modal. Open it with the
   keyboard. **Inside the modal:** `Tab` reaches the search box and the row
   checkboxes/radios directly; `Space` selects a row; `Esc` closes it and focus
   returns to the button you opened it from. ✅ *This was a total blocker — you
   could not set a foreign key by keyboard at all before remediation.*

### 1.4 — The hard cases (widgets that used to be mouse-only)

- **Photo gallery** (any entity with a PhotoGallery column, or the gallery admin):
  Tab to the **"Add photos"** button — it opens the file picker. Each image has
  **move-up / move-down** buttons reachable by keyboard. ✅ *(Reorder was drag-only.)*
- **Map field** (Issue has a `location` GeoPoint): in edit mode, Tab to the
  **Latitude / Longitude** number inputs and type coordinates — the marker moves.
  ✅ *(The map was click-only; these inputs are the keyboard path.)*
- **Recurrence / weekday pickers** (recurring time slots): the day toggles are
  reachable by `Tab` and toggle with `Space`, with a visible focus ring. ✅

### 1.5 — Modals and focus return

Open any modal (e.g. **Settings** via user menu → Preferences):

1. Focus moves *into* the modal on open.
2. `Tab` cycles **within** the modal — it does not escape to the page behind. ✅
   *(Focus trap.)*
3. `Esc` closes it, and focus returns to the control that opened it. ✅

> **If any step above fails** — you can't reach a control, focus vanishes, `Esc`
> doesn't close, or focus is lost after closing — record it (see
> [Pass/fail record](#passfail-record)). These are Level A failures.

---

## Part 2 — Screen-reader pass

Now verify that what a keyboard user *does* is also *announced correctly*. You do
not need to be fluent — you need ~8 keys and about 15 minutes.

### Turning on VoiceOver (macOS)

- **Toggle:** `Cmd + F5` (or triple-press Touch ID). A speech bubble appears and
  VoiceOver starts reading.
- First run: it offers a **Quick Start tutorial** — skip it (`Esc`) for now.
- **Turn it off the same way** (`Cmd + F5`) when you're done. It stays on until you
  do.
- Use **Safari** for the truest results (VoiceOver + Safari is the canonical macOS
  combination), though Chrome works.

### Turning on NVDA (Windows)

- **Install** the free reader from <https://www.nvaccess.org/> (no license, no cost).
- **Toggle:** `Ctrl + Alt + N` starts it; `NVDA menu → Exit` (or `Insert+Q`) quits.
- Use **Firefox or Chrome**.
- The **`Insert`** key is NVDA's modifier ("NVDA key"). On laptops without Insert,
  NVDA lets you use `CapsLock` as the NVDA key (offered during install).

### The only keys you need

You can do 90% of a review with **Tab and the arrow keys** plus a couple of reader
commands. Tab moves between interactive controls (and the reader announces each);
the arrow keys read *everything* including static text.

| Goal | VoiceOver (macOS) | NVDA (Windows) |
|------|-------------------|----------------|
| Read next / previous item | `VO + →` / `VO + ←` (VO = `Ctrl+Option`) | `↓` / `↑` |
| Move to next interactive control | `Tab` | `Tab` |
| Activate the item | `VO + Space` | `Enter` / `Space` |
| **List all headings** (page structure) | Rotor: `VO + U`, then ←/→ to "Headings" | `H` (next heading), `1`–`6` |
| **List all form fields** | Rotor: `VO + U` → "Form controls" | `F` (next form field) |
| **List all landmarks/regions** | Rotor: `VO + U` → "Landmarks" | `D` (next landmark) |
| Stop talking | `Ctrl` | `Ctrl` |

> **The rotor (VoiceOver) / element lists (NVDA) are the pro move.** Real
> screen-reader users navigate by pulling up a list of headings or form fields and
> jumping — not by tabbing linearly. If your headings list is a jumble or your form
> fields have no names, that's what real users hit first.

### Scripted screen-reader walkthrough

Turn the reader on, then work through these. The **"should hear"** column is the
pass condition — if you hear something materially different (an icon's raw name, a
control with no name, an error that's never announced), that's a finding.

| # | Do this | Should hear (pass condition) | Guards |
|---|---------|------------------------------|--------|
| 1 | Load `/view/Issue`. Pull up the **headings** list (`VO+U` / `H`). | A single, sensible page `<h1>` ("Issues"), not a pile of same-level headings. | 1.3.1 |
| 2 | Check the **browser tab title** on a few pages (Home, `/permissions`, `/view/Issue`). | Distinct titles per page: "Issues - Civic OS", "Permissions - Civic OS" — not "Civic OS" everywhere. | 2.4.2 |
| 3 | Navigate a sidebar link, then listen. | The new page's main region / heading gets focus and is announced — you're not left silently on the old link. | 2.4.3 |
| 4 | Arrow through a **table row**'s cells. | Real data ("Pothole on Saginaw St", a status), **not** icon ligature names like "check_box" for booleans — you should hear "Yes"/"No". | 1.1.1, 1.3.1 |
| 5 | Focus a **sort header**. | "…, column header, button" and the current sort state (ascending/descending) when set. | 4.1.2 |
| 6 | On `/create/Issue`, focus the **display name** field. | Its label **and** "required" — e.g. "Display name, required, edit text". | 3.3.2 |
| 7 | Leave that field empty and blur it. | The error is announced when it appears, and re-focusing the field reads the error via its description ("This field is required"). | 3.3.1 |
| 8 | Focus a field that has a **help tooltip** (the ⓘ icon). | The description text is read (it's in an `sr-only` span) — the icon itself is silent. | 1.3.1, 1.4.13 |
| 9 | Open any **modal**. | On open you hear the dialog's **name** ("Settings, dialog") — not an unnamed dialog. | 4.1.2 |
| 10 | Trigger a **loading state** (search, or a slow list). | A spinner is announced as a status ("Loading"), not silence. | 4.1.3 |
| 11 | Open the **dashboard with a chart widget**. | The chart has an equivalent — arrow into the adjacent `sr-only` data table and hear the category/series values. | 1.1.1 |
| 12 | Trigger an **error** (e.g. delete something that fails, or a bad save). | The error alert is spoken when it appears (it's a live region / `role="alert"`). | 4.1.3 |

If you only have five minutes, do rows **4, 6, 7, and 9** — booleans, required
state, error association, and dialog naming are the highest-signal checks and the
ones automated tools miss most often.

---

## Part 3 — axe DevTools browser extension

This is the interactive counterpart to the `axe`/`pa11y` CLIs — same engine, but
it inspects the *live rendered DOM* (after Angular runs), which the CLIs against a
cold URL can miss, and it lets you scan a specific state (a modal open, a filter
applied).

1. Install **axe DevTools** (Deque) for Chrome or Firefox — free tier is enough.
2. Open DevTools (`F12`) → **axe DevTools** tab → **Scan ALL of my page**.
3. Triage results:
   - **Fix now:** Critical/Serious violations (missing names, contrast, ARIA misuse).
   - **Judge:** "Needs review" items are the manual questions this guide answers —
     axe flags them precisely because a tool can't decide.
4. **Scan dynamic states too** — this is the point of the extension over the CLI:
   open a modal and scan; apply a filter and scan; open the FK search modal and
   scan. Those states never render for the unauthenticated CLI run in CI.

> Expect near-zero Critical/Serious on the remediated pages. A *new* violation is
> a regression the ESLint gate didn't catch (ESLint checks templates statically;
> axe checks the rendered result) — worth a fix and possibly a new lint rule.

---

## Part 4 — Visual checks

Quick, mouse-allowed, no reader needed:

1. **200% zoom** (`Cmd/Ctrl` `+` five times, or browser zoom to 200%): no content
   is cut off, nothing requires horizontal scrolling of the whole page, all
   controls still reachable. *(WCAG 1.4.10 reflow.)*
2. **Reduced motion:** enable it at the OS level (macOS: System Settings →
   Accessibility → Display → Reduce Motion; Windows: Settings → Accessibility →
   Visual effects → Animation off). Reload — modal/transition animations should be
   near-instant, not sliding/scaling. *(WCAG 2.3.3; the app ships a global
   `prefers-reduced-motion` block.)*
3. **Theme contrast:** switch themes (Settings → Colors). Deployment defaults are
   constrained to a vetted, contrast-checked list, but users may pick any of the 35
   — spot-check that a status badge's text is still readable on its colored
   background. *(The badge text color is computed for WCAG contrast; if a badge
   looks low-contrast, that's a finding in the contrast util.)*

---

## Pass/fail record

Copy this into the PR / release ticket. A failure is a blocker for anything at
Level A (keyboard operability, names, error identification).

```
Accessibility manual pass — <date> — <tester> — <build/branch>
Screen reader used: [ ] VoiceOver/Safari  [ ] NVDA/Firefox  [ ] NVDA/Chrome

Part 1 Keyboard-only .............. [ ] pass  [ ] fail — notes:
Part 2 Screen reader (12 checks) .. [ ] pass  [ ] fail — failed rows:
Part 3 axe DevTools (live + modal). [ ] pass  [ ] fail — violations:
Part 4 Zoom / reduced-motion / theme [ ] pass  [ ] fail — notes:

New interactive UI in this change: <list, or "none">
Blockers found: <list, or "none">
```

---

## Appendix: what each check maps to

The walkthroughs are organized by task, not by criterion; this maps them back for
anyone filling out a VPAT or conformance report. Every item traces to a fix
catalogued in `docs/notes/ACCESSIBILITY_AUDIT_2026-07.md`.

| WCAG SC | Level | Verified by | Feature it guards |
|---------|-------|-------------|-------------------|
| 1.1.1 Non-text Content | A | P2 rows 4, 11 | Icon `aria-hidden`, boolean Yes/No, chart data table |
| 1.3.1 Info & Relationships | A | P2 rows 1, 4, 8 | Table/heading semantics, field descriptions |
| 1.4.3 Contrast | AA | P4.3 | Computed badge text color, vetted theme defaults |
| 1.4.10 Reflow | AA | P4.1 | 200% zoom |
| 1.4.13 Content on Hover/Focus | AA | P2 row 8 | Tooltip descriptions in `sr-only` text |
| 2.1.1 Keyboard | A | All of Part 1 | Nav, sorting, FK modal, gallery, maps, reorder |
| 2.3.3 Animation from Interactions | AAA¹ | P4.2 | `prefers-reduced-motion` |
| 2.4.1 Bypass Blocks | A | P1.1 step 1 | Skip link |
| 2.4.2 Page Titled | A | P2 row 2 | Per-route `document.title` |
| 2.4.3 Focus Order | A | P1.5, P2 row 3 | Focus trap, focus-on-nav, focus return |
| 2.4.7 Focus Visible | AA | Part 1 (throughout) | Global `:focus-visible` ring |
| 3.3.1 Error Identification | A | P2 row 7 | `aria-invalid` + `aria-describedby` error link |
| 3.3.2 Labels or Instructions | A | P2 row 6 | `aria-required`, label association |
| 4.1.2 Name, Role, Value | A | P2 rows 5, 9 | Control names, dialog names, sort state |
| 4.1.3 Status Messages | AA | P2 rows 10, 12 | Live regions for loading / errors |

¹ 2.3.3 is Level AAA; included because motion-sensitivity accommodation is cheap
and expected, even though it's above the AA target.

---

*Companion docs: `docs/development/ACCESSIBILITY_WCAG.md` (standards overview +
automated tooling), `docs/notes/ACCESSIBILITY_AUDIT_2026-07.md` (the audit and
per-batch remediation record). The ESLint a11y gate
(`.github/workflows/accessibility.yml`) enforces the structural rules on every PR;
this guide is the human layer on top.*
