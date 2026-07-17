# Exemplary Community Services — Demo Instance Implementation Brief

**Prepared:** 2026-07-15 · **Demo:** 2026-07-17 · **Basis:** demo-instance-design-2026-07-17.md
**Implementation target:** Claude Code, starting from the ICGF init script in the civic-os repo.

---

## 1. Decisions locked this session

| # | Decision | Resolution |
|---|---|---|
| 1 | Org name | **Exemplary Community Services** ("ECS"). Deliberately, transparently fictional; the wink is honest about what the room is looking at, and the credibility anchors ("this exact workflow runs at a Flint refugee-services org today") carry all the realism weight. Zero collision risk. Realistic-name candidates were explored first: "Fieldstone" collided (real Bronson behavioral-health facility in Battle Creek); "Larkspur" cleared but was set aside in favor of the transparent approach. |
| 2 | Consent model | **History with current-consent helper.** Statuses include Superseded so replaced consents stay truthful in the audit trail. |
| 3 | Reminder cadence | **Staff-only, 30/14/7 days** before expiry. No client ladder; this also removes the client-email dependency (the DS-08 "quiet lie"). |
| 4 | Locale set | **English, Arabic, Spanish.** Full coverage over breadth; protects DS-04. |
| 5 | Gate mechanics | Denormalized `consent_state` + `consent_note` on clients, trigger-maintained. See §4 for why. |

---

## 2. Reskin delta (ICGF → ECS)

Apply to a copy of the ICGF init script. Everything not listed carries over unchanged (clients, partners, referrals, surveys, service categories, junction tables, cascade RPCs, survey job, dashboard, notifications).

| ICGF | ECS |
|---|---|
| Org naming, instance copy | Exemplary Community Services; style: dates yyyy-mm-dd; semicolons and commas over emdashes in all labels, copy, Markdown widgets |
| 12 service categories | 10: Housing, Employment, Food/Nutrition, Healthcare, Mental Health, Transportation, Childcare, Financial Literacy/Benefits, Education, Legal Aid |
| `immigration_status` category | **Drop** (do not replace; eligibility dimension is carried by consent + service needs for demo purposes) |
| `country_of_origin`, `date_of_arrival` | **Drop** |
| `primary_language` | Keep as `preferred_comm_language` (needed for RTL beat) |
| `household_size` | Keep as scalar |
| Roles `ic_staff` / `ic_client` | `ecs_staff` / `ecs_client` |
| Locales (six) | en, ar, es |
| Refer Client entity action | Modified by consent gate; see §5 |
| Dashboard | Add Consents Expiring filtered list; see §7 |

---

## 3. New build: consent subsystem

Complete SQL in `02_consent_subsystem.sql`. Entity summary:

| Entity | Purpose | Key fields |
|---|---|---|
| `client_consents` | Consent as a record, not a document | client FK, method (category: Verbal/Written/Portal), granted_date, expires_date, revoked_date, captured_by (User), evidence_file (optional), Status |
| `consent_reminder_log` | Idempotency for the staff reminder ladder | (consent_id, days_out) PK; not a UI entity |
| `client_current_consents` (VIEW) | Governing consent per client | for reporting and dashboard |
| `consents_expiring_soon` (VIEW) | Active consents expiring within 30 days | dashboard filtered list source |

**Status workflow** (`client_consent`): Pending (initial) → Active → Expired (terminal); Active → Revoked (terminal); Pending → Revoked; Superseded (terminal, system-set when a new consent replaces an old one). Revoked ≠ Expired: one is a client decision, one is a clock. Superseded ≠ either: it is replacement, and it is the honest answer when Ken asks what happens to the old row.

```
clients 1 ──── * client_consents ──── * consent_reminder_log
   │                    │
   │ consent_state      │ status_id → metadata.statuses (client_consent)
   │ consent_note       │ method_id → metadata.categories (consent_method)
   │ (trigger-maintained)│ captured_by → civic_os_users
   └── Refer Client action reads consent_state
```

---

## 4. Gate mechanics (and why denormalized)

Platform constraint: `entity_actions.enabled_condition` is JSONB evaluated client-side **against the record's own fields only**, and `disabled_tooltip` is static text. The gate therefore cannot query `client_consents` directly.

Design:
- `clients.consent_state` TEXT: none | pending | active | expired | revoked. Maintained by `recompute_client_consent_gate()` via trigger on `client_consents` and by the daily job.
- `clients.consent_note` TEXT: the human-readable reason, e.g. "Consent expired 2026-06-14", "No consent on record", "Consent revoked 2026-07-02". Displayed as a read-only property on the client Detail page, adjacent to the actions.
- Refer Client: `enabled_condition = {field: consent_state, operator: eq, value: active}`; static `disabled_tooltip` points at the Consent Status field.

Demo choreography (DS-10): greyed button + visible dated reason → Record Consent (action-params modal, no page navigation) → trigger recomputes → button lights → refer. The action-params modal is itself a v0.32.0 feature demo.

Governing-consent priority: Active > Pending > latest terminal (Revoked/Expired) > none. Superseded rows never drive the gate.

---

## 5. Entity actions (clients)

| Action | Behavior | Conditions |
|---|---|---|
| `refer_client` (ICGF, modified) | unchanged RPC | enabled only when `consent_state = active`; disabled_tooltip: "Referral requires active consent; see Consent Status on this record." **Verify the ICGF action_name before running the UPDATE.** |
| `record_consent` (new) | Params modal: method (category), granted date (default today), expires date (default granted + 1 year), optional evidence file. Supersedes prior Active/Pending consents, inserts Active, gate recomputes. | visible always; primary demo path (DS-08) |
| `request_consent` (new) | Creates Pending consent; emails the client the `consent_request` template. If the client has no email, returns an honest failure: "Client has no email address; record consent manually." | visible when `consent_state ≠ active` |

Revocation is a status transition on the consent record (Active → Revoked) with `on_transition_rpc` stamping `revoked_date`.

---

## 6. Scheduled job and notifications

`run_consent_maintenance()`, registered daily 08:00 America/Detroit, on the `run_survey_reminders()` pattern:
1. Expire Active consents with `expires_date < CURRENT_DATE`; per-row trigger recomputes gates.
2. Staff reminders at exactly 30/14/7 days out, to `captured_by`, idempotent via `consent_reminder_log`.

Templates: `consent_expiring_staff` (to staff; subject carries client name and yyyy-mm-dd expiry), `consent_request` (to client). Manual trigger for rehearsal: `SELECT trigger_scheduled_job('consent_maintenance');`

---

## 7. Dashboard delta

Reskin the ICGF Intake Dashboard; add one filtered-list widget **Consents Expiring** sourced from `consents_expiring_soon`, placed with Intake Pending / Open Referrals / Pending Surveys. This ties beat 2 into beat 4. Keep the Referrals Per Week chart and Partner Locations map (Ken's Leaflet callback).

---

## 8. Seed data spec (per §7 of design input)

Generated in Claude Code with the mock data generator; **never named aloud in the room**.

- ~250 clients, ~25 partners, ~400 referrals; surveys and consents proportional; two years of history.
- Consents: ~80% Active; **8–10 expiring within 30 days** (so the reminder ladder and dashboard list have content, with several inside 7 days); **at least 3 Expired including the demo client** (expiry date should read plausibly, e.g. 2026-06-14); **at least 1 Revoked**; a few Pending; several Superseded rows behind renewed clients so the history model is visibly a history.
- Referrals: at least 2 denied/Not Completed; one record in an awkward status; referrals-per-week variance so the chart has a shape.
- Surveys: several "Could Not Make Contact"; outcome mix includes "Enrolled in Services".
- Partners spread across plausible Genesee-County-scale geography so the map clusters.
- A few messy/incomplete records.
- **Demo client:** one named client with an Expired consent (the gate beat), realistic service needs matching 2–3 partners, no referrals yet.

## 9. Import file spec (DS-01; separate from seed)

~40-row Excel of clients: inconsistent capitalization; one date column mixing yyyy-mm-dd, m/d/yy, and "March 3, 2025"; at least one partner name that is a near-miss of a seeded partner (FK resolution must visibly fix it); 2–3 blank required cells (validation must visibly reject with reasons); service needs as comma-separated values in one column (M:M import path).

---

## 10. Claude Code handoff checklist

1. Copy ICGF init script → apply §2 reskin delta (drops, renames, categories, roles, locales, copy style).
2. Run `02_consent_subsystem.sql` after the base script. Before running, verify against the repo: exact `metadata.properties` column names, the ICGF `refer_client` action_name, the user-FK pattern (`metadata.civic_os_users`), and role keys. Flagged inline with `-- VERIFY`.
3. Add the Consents Expiring dashboard widget to the reskinned dashboard config.
4. Generate seed data per §8; build the DS-01 import file per §9.
5. Rehearsal helpers: `trigger_scheduled_job('consent_maintenance')`; confirm the demo client's gate reads "Consent expired 2026-06-14".
6. Smoke-test locales en/ar/es; confirm no half-translated screens (DS-04 kill condition).

---

## 11. Platform enhancement opportunities

| Opportunity | Current behavior | Proposal | Impact here | Broader value | Complexity |
|---|---|---|---|---|---|
| **Templated disabled_tooltip** | `disabled_tooltip` is static text | Support field interpolation, e.g. `{{consent_note}}` | The dated reason could live in the tooltip itself instead of an adjacent property | Every gated action across instances gets self-explaining disabled states | Low |
| **Cross-entity action conditions** | `enabled_condition` evaluates the record's own fields only | Allow conditions against related-entity aggregates, or first-class "computed condition" RPC | Would remove the denormalized `consent_state` column and its trigger | Any gate that depends on child-record state (payments cleared, documents on file, training current) | Medium |
| **"Current record" helper pattern** | Hand-rolled per instance (current consent; ICGF current status views) | Platform helper for "latest governing child record" views + gate sync | Generalizes `client_current_consents` | Current enrollment, current membership, current certification are the same shape | Medium |
| **Category-scoped consent** | Consent is client-global | Consent per service category or partner, intersecting the needs ∩ offerings cascade | Out of scope Friday; **say it aloud to Ken as the next turn** | Real requirement for HIPAA-adjacent and multi-program orgs | High |

---

## 12. Open items (not builds)

- Resolve the ICGF adoption-language contradiction (client profile vs project spec) before Friday; it is a sentence you will say to Ken.
- Thursday: rehearse DS-10 choreography end-to-end; it is the only beat with no fallback.
- After Friday: Meeting Notes per meeting; Decision Record for consent-as-record.
