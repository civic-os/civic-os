<!--
Copyright (C) 2023-2026 Civic OS, L3C
SPDX-License-Identifier: AGPL-3.0-or-later
-->

# Accessibility Audit Runbook

This runbook describes how to run automated WCAG 2.2 AA accessibility scans using the IBM Equal Access engine via Playwright, triage results, and track fixes.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Method](#method)
- [Step-by-Step Audit Procedure](#step-by-step-audit-procedure)
- [Known False Positives](#known-false-positives)
- [Fix Workflow](#fix-workflow)
- [Cadence](#cadence)
- [Related Resources](#related-resources)

---

## Prerequisites

- Docker stack running (`docker compose up -d`)
- Dev server at `http://localhost:4200` (`npm start`)
- Playwright MCP configured (browser automation)
- Example data loaded (e.g., pothole example)

---

## Method

IBM Equal Access (`ace.js`) is injected into each page via Playwright's `browser_run_code_unsafe` tool. The engine evaluates WCAG 2.2 AA rules against the live DOM and returns structured results with:

- **Violations** — definite failures requiring fixes
- **Needs Review** — potential issues requiring human judgment
- **Recommendations** — best practices, not strict failures

This live-DOM approach catches issues that static URL-scanning tools miss, such as dynamically rendered content, Angular component output, and runtime-injected ARIA attributes.

---

## Step-by-Step Audit Procedure

### 4.1 Start the stack

```bash
docker compose up -d
npm start
```

### 4.2 Log into Keycloak via Playwright

Navigate to `http://localhost:4200`, click login, authenticate as `testadmin`/`testadmin`.

### 4.3 Run the scan

For each page, use Playwright to:

1. Navigate to the page URL
2. Wait for content to load (network idle)
3. Inject and run the IBM Equal Access checker:

```javascript
// Load ace.js from CDN
const script = document.createElement('script');
script.src = 'https://unpkg.com/accessibility-checker-engine@latest/ace.js';
script.onload = async () => {
  const checker = new window.ace.Checker();
  const result = await checker.check(document, ['WCAG_2_2']);
  // result.results contains the findings
  window.__a11yResults = result;
};
document.head.appendChild(script);
```

4. Collect results via `browser_evaluate`

### 4.4 Pages to scan

Scan all authenticated pages:

- `/` (Home/Dashboard)
- `/profile`
- `/view/{entity}` (List pages for each entity)
- `/create/{entity}` (Create pages)
- `/detail/{entity}/{id}` (Detail pages)
- `/edit/{entity}/{id}` (Edit pages)
- `/schema-editor`
- `/permissions`
- `/entity-management`
- `/property-management`
- `/admin/users`
- `/admin/statuses`
- `/admin/categories`
- `/admin/files`
- `/admin/galleries`
- `/admin/translations`
- `/system/functions`
- `/system/policies`

### 4.5 Parse results

Group findings by:

- Rule ID (e.g., `text_contrast_sufficient`)
- Severity (Violation / Needs Review / Recommendation)
- Page

Count occurrences and identify patterns (same rule across many pages = framework-level fix).

---

## Known False Positives

The following persistent tool false positives do **not** require code changes:

| Rule | Element | Why It's a False Positive |
|------|---------|--------------------------|
| `label_name_visible` | Icon-only buttons (Move up/down, Back, Theme, Export, zoom) | WCAG 2.5.3 doesn't apply to elements without visible text. Icon-only buttons with `aria-label` are correct. |
| `text_block_heading` | "Civic OS" app title link | App branding link in navbar, not a heading. Intentional. |
| `input_label_visible` | DaisyUI drawer checkbox | Already `aria-hidden="true"` + `tabindex="-1"`. DaisyUI CSS-only mechanism, not user-facing. |
| `style_color_misuse` | Stylesheet-level flags | Generic warning about color usage in stylesheets. Not actionable. |
| `text_contrast_sufficient` on badges | DaisyUI badges with `appContrastText` | The `appContrastText` directive correctly calculates WCAG AA contrast at runtime. Working as designed. |

Add new confirmed false positives to this table as they are discovered.

---

## Fix Workflow

1. **Prioritize**: Violations > Needs Review > Recommendations
2. **Classify**: True violation vs. false positive vs. working-as-designed
3. **Fix scope**: Framework-level fixes (shared components) resolve many pages at once
4. **Verify**: Re-scan affected pages after fixes
5. **Document**: Add new false positives to the table above as discovered

---

## Cadence

- Run before each release
- Run after adding new pages or significant UI components
- Run after upgrading DaisyUI, Angular, or Leaflet

---

## Related Resources

- `docs/development/ACCESSIBILITY_WCAG.md` — WCAG implementation guide and patterns
- `docs/notes/ACCESSIBILITY_AUDIT_2026-07.md` — July 2026 manual audit findings and remediation
- `.github/workflows/accessibility.yml` — CI ESLint a11y guard
- `src/app/directives/contrast-text.directive.ts` — Runtime WCAG AA contrast calculation
