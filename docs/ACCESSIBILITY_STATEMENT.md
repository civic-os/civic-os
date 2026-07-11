# Accessibility Statement — Civic OS

*This is a template statement for Civic OS deployments. Deployers: replace the
bracketed placeholders, review the "customizations" section against your
instance, and publish this (or link to it) from your application's footer or
help area.*

---

**[Organization name]** is committed to ensuring digital accessibility for
people with disabilities in **[application name]**, which is built on the
Civic OS framework. We are continually improving the user experience for
everyone and applying the relevant accessibility standards.

## Conformance status

[Application name] targets **WCAG 2.1 Level AA**. The Civic OS framework
underwent a comprehensive accessibility audit and remediation in July 2026
covering keyboard operability, screen-reader semantics, focus management,
color contrast, and motion preferences. The framework's detailed conformance
report is available in
[`docs/ACCESSIBILITY_CONFORMANCE.md`](./ACCESSIBILITY_CONFORMANCE.md), and
automated accessibility rules run on every code change to prevent regressions.

We assess this application as **partially conformant**: the framework-generated
interface meets the target, with the known limitations listed below.

## What you can expect

- Full keyboard operation: navigation, forms, data tables (including sorting
  and filtering), dialogs, file upload, reordering, and map/calendar data entry
  via text-input alternatives.
- Screen-reader support: labeled controls, named dialogs, announced loading
  states, validation errors, and status changes; per-page titles; a skip link.
- Visual preferences: respects your operating system's reduced-motion setting;
  visible keyboard-focus indicators; selectable color themes (the default theme
  meets contrast requirements; some optional themes are labeled as reduced
  contrast).
- Right-to-left language support.

## Known limitations

- **Sign-in pages** are provided by Keycloak, a third-party component, and have
  known accessibility issues being addressed upstream.
- **The visual schema diagram** (administrators only) requires a mouse for
  rearranging the diagram layout; all underlying information is available in
  accessible pages.
- **Optional low-contrast themes** may be chosen by users as a personal
  preference; these are labeled in the theme picker.
- **[Deployment-specific content]**: describe any instance content that has not
  yet been remediated (e.g., legacy uploaded documents without alternative
  text).

## Feedback and contact

We welcome feedback on the accessibility of [application name]. If you
encounter accessibility barriers, please contact us:

- **Email:** [accessibility contact email]
- **Phone:** [phone number]
- **[Other channel, e.g., feedback form]**

We aim to respond to accessibility feedback within **[N business days]**.

## Assessment and technical information

- **Assessment approach:** framework-level code audit, automated testing
  (axe-core, Angular template accessibility linting in CI), and scripted
  keyboard/assistive-technology verification against a live instance. See the
  framework's [manual testing guide](./development/ACCESSIBILITY_MANUAL_TESTING.md).
- **Technologies relied upon:** HTML, CSS, JavaScript (Angular), WAI-ARIA.
- **Statement prepared:** [date]. **Last reviewed:** [date].

---

*Framework note for deployers: keep this statement honest. If your instance
adds custom pages or content, verify them against the manual testing guide
before claiming conformance for them, and update the known-limitations list.
The Civic OS project welcomes accessibility issue reports at
https://github.com/civic-os/frontend/issues (or your fork's tracker).*
