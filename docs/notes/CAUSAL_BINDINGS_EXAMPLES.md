# Causal Bindings: Example Catalog

**Version:** v0.33.0
**Purpose:** Complete reference of all status transitions and property change triggers declared across examples. Use this to inform statechart visualization (Session 2), context diagram layout (Session 3), and causal chain UI (Session 4).

---

## Summary

| Example | Entity Types | Status Transitions | Property Change Triggers | Pattern |
|---------|:------------:|:-----------------:|:------------------------:|---------|
| **Community Center** | 1 | 4 | 7 | Simple approval workflow |
| **Mott Park** | 2 | 10 | 15 | Multi-stage workflow with payments |
| **Staff Portal** | 4 | 8 | 10 | Review loops, computed status, file triggers |
| **Pothole** | 0 (legacy) | 0 | 1 | Legacy tables, notification only |
| **Broader Impacts** | 0 (legacy) | 0 | 0 | No automation |
| **StoryMap** | 0 | 0 | 0 | Static content, no workflows |

---

## Community Center

**File:** `examples/community-center/init-scripts/15_causal_bindings.sql`

### Status Transitions: `reservation_request`

```
Pending ──→ Approved    (approve_reservation_request)
Pending ──→ Denied      (deny_reservation_request)
Pending ──→ Cancelled   (cancel_reservation_request)
Approved ──→ Cancelled  (cancel_reservation_request)
```

| From | To | RPC | Display Name | Side Effects |
|------|----|-----|-------------|-------------|
| Pending | Approved | `approve_reservation_request` | Approve | Creates linked reservation, sets reviewed_by/reviewed_at |
| Pending | Denied | `deny_reservation_request` | Deny | Sets reviewed_by/reviewed_at |
| Pending | Cancelled | `cancel_reservation_request` | Cancel | — |
| Approved | Cancelled | `cancel_reservation_request` | Cancel | Deletes linked reservation |

**Terminal states:** Approved, Denied, Cancelled (all `is_terminal = true`)

### Property Change Triggers: `reservation_requests.status_id`

| Change Type | Value | Function | Display Name | Phase | Effect |
|-------------|-------|----------|-------------|-------|--------|
| `changed_to` | Approved | `sync_reservation_request_to_reservation` | Create linked reservation on approval | BEFORE | Creates row in `reservations` table |
| `changed_to` | Cancelled | `handle_reservation_request_cancellation` | Delete linked reservation on cancellation | AFTER | Deletes linked reservation, NULLs FK |
| `any` | — | `set_reviewed_at_timestamp` | Stamp reviewed_at on status review | BEFORE | `reviewed_at = NOW()` on Pending → Approved/Denied |
| `any` | — | `add_status_change_note` | Create audit note on status change | AFTER | System Entity Note: "Status changed from X to Y" |
| `changed_to` | Approved | `notify_reservation_request_approved` | Notify requester on approval | AFTER | Email to requester |
| `changed_to` | Denied | `notify_reservation_request_denied` | Notify requester on denial | AFTER | Email to requester |
| `changed_to` | Cancelled | `notify_reservation_request_cancelled` | Notify staff on cancellation | AFTER | Email to all editors/admins |

**Trigger execution order when status changes:**
1. BEFORE: `set_reviewed_at_timestamp` → `sync_reservation_request_to_reservation`
2. AFTER: `handle_reservation_request_cancellation` → `add_status_change_note` → notification triggers

---

## Mott Park (MPRA)

**File:** `examples/mottpark/init-scripts/25_mpra_causal_bindings.sql`

### Status Transitions: `reservation_request`

```
                              ┌──→ Denied (terminal)
                              │
Pending ──┬──→ Approved ──┬──→ Completed ──→ Closed (terminal)
          │               │
          │               └──→ Cancelled (terminal)
          │
          └──→ Cancelled (terminal)
```

| From | To | RPC | Display Name | Guards |
|------|----|-----|-------------|--------|
| Pending | Approved | `approve_reservation_request` | Approve | Requires manager/admin role |
| Pending | Denied | `deny_reservation_request` | Deny | Requires manager/admin, denial_reason required |
| Pending | Cancelled | `cancel_reservation_request` | Cancel | Requires manager/admin, cancellation_reason required |
| Approved | Cancelled | `cancel_reservation_request` | Cancel | Auto-cancels all pending payments |
| Approved | Completed | `complete_reservation_request` | Mark Completed | Also runs automatically via `auto_complete_past_events()` scheduled job |
| Completed | Closed | `close_reservation_request` | Close | Blocked if security deposit still in Paid status (must refund/waive first) |

**vs. Community Center:** Mott Park adds `Completed` and `Closed` states, creating a 6-status workflow vs. 4. The `auto_complete_past_events()` scheduled job introduces an automated (non-user-driven) transition.

### Status Transitions: `reservation_payment`

```
Pending ──→ Paid       (Stripe webhook or manual RPCs)
Pending ──→ Waived     (waive_all_reservation_payments)
Pending ──→ Cancelled  (auto, when parent request is cancelled)
Paid ──→ Refunded      (manual process)
```

| From | To | RPC | Display Name | Notes |
|------|----|-----|-------------|-------|
| Pending | Paid | — | Pay | Multiple pathways: Stripe `sync_reservation_payment_status` trigger OR `record_cash/check/money_order/cashapp_payment` RPCs |
| Pending | Waived | `waive_all_reservation_payments` | Waive | Bulk operation: waives ALL pending payments for a reservation |
| Pending | Cancelled | — | Cancel | No direct RPC — side effect of `cancel_reservation_request` on parent |
| Paid | Refunded | — | Refund | Currently manual (Stripe refund trigger was removed in v0.18) |

**Design note:** Pending → Paid has no single RPC binding because it can happen via 5 different paths (1 Stripe webhook + 4 manual payment RPCs). The `on_transition_rpc` is NULL for this transition.

### Property Change Triggers: `reservation_requests.status_id`

| Change Type | Value | Function | Display Name | Effect |
|-------------|-------|----------|-------------|--------|
| `changed_to` | Approved | `on_reservation_approved` | Calculate pricing on approval | BEFORE: calculates holiday/weekend flag, facility fee amount |
| `changed_to` | Approved | `create_reservation_payments` | Create payment records on approval | AFTER: creates 3 payment records (deposit, facility fee, cleaning fee) |
| `changed_to` | Cancelled | `on_reservation_cancelled` | Track cancellation details | BEFORE: sets cancelled_at, cancelled_by |
| `any` | — | `validate_status_reasons` | Validate denial/cancellation reasons | BEFORE: requires denial_reason when Denied, cancellation_reason when Cancelled |
| `any` | — | `sync_reservation_color_from_status` | Sync calendar color from status | BEFORE: copies status color to reservation for calendar display |
| `any` | — | `sync_public_calendar_event` | Sync to public calendar | AFTER: upserts/removes from public_calendar_events based on status |
| `any` | — | `update_can_waive_fees` | Update waive fees eligibility | BEFORE: sets can_waive_fees flag based on status and pending payments |
| `any` | — | `add_reservation_status_change_note` | Create audit note on status change | AFTER: status-specific content (fee info, reasons, etc.) |
| `any` | — | `notify_reservation_status_change` | Notify requester on status change | AFTER: email for Approved, Denied, Cancelled transitions |

### Property Change Triggers: `reservation_payments.status_id`

| Change Type | Value | Function | Display Name | Effect |
|-------------|-------|----------|-------------|--------|
| `any` | — | `set_payment_display_name` | Update payment display name | BEFORE: rebuilds display string with status and payment method |
| `any` | — | `update_payment_overdue_status` | Update overdue tracking | BEFORE: computes days_until_due, is_overdue |
| `any` | — | `add_payment_status_change_note` | Create audit note on parent reservation | AFTER: Entity Note on parent reservation_request |
| `any` | — | `update_can_waive_fees` | Update parent waive fees eligibility | AFTER: recalculates parent's can_waive_fees |
| `any` | — | `update_can_record_payment` | Update manual payment eligibility | BEFORE: sets can_record_payment = (status is Pending) |

### Property Change Triggers: `payments.transactions.status` (cross-schema)

| Change Type | Value | Function | Display Name | Effect |
|-------------|-------|----------|-------------|--------|
| `any` | — | `sync_reservation_payment_status` | Sync Stripe payment status to reservation | AFTER: on `succeeded` → updates to Paid; on `failed`/`canceled` → clears transaction link |

**Design note:** This trigger is on `payments.transactions` (not in `public` schema). The `table_name` stores `'transactions'` unqualified. A future `schema_name` column would clarify this.

---

## Staff Portal

**File:** `examples/staff-portal/init-scripts/09_staff_portal_causal_bindings.sql`

### Status Transitions: `staff_document` (review loop)

```
Pending ──→ Submitted ──→ Approved (terminal)
                     └──→ Needs Revision ──→ Submitted (loop)
```

| From | To | RPC | Display Name | Notes |
|------|----|-----|-------------|-------|
| Pending | Submitted | `submit_staff_document` | Submit | Also triggered automatically by file upload |
| Submitted | Approved | `approve_staff_document` | Approve | Prevents self-approval. Triggers onboarding recalc |
| Submitted | Needs Revision | `request_document_revision` | Request Revision | Reviewer notes parameter |
| Needs Revision | Submitted | `submit_staff_document` | Resubmit | Also triggered automatically by file re-upload |

**Unique pattern: review loop.** The Submitted ↔ Needs Revision cycle can repeat indefinitely until the document is Approved. This is the only example with a non-linear state machine (a cycle).

### Status Transitions: `staff_onboarding` (COMPUTED — no transitions declared)

```
Not Started ──→ Partial ──→ All Approved (terminal)
                       ←──  (can regress)
```

**This entity type has NO `add_status_transition()` entries** because the status is computed by `update_onboarding_status()` trigger on `staff_documents`, not set directly by any RPC. The status reflects child document approval progress:
- **Not Started:** 0 of N required documents approved
- **Partial:** 1 to N-1 approved
- **All Approved:** all N approved

**Design implication:** Statechart visualization for computed statuses should use dashed/hollow arrows or a "computed" annotation to distinguish them from user-driven transitions.

### Status Transitions: `time_off_request`

```
Pending ──→ Approved (terminal)
       └──→ Denied (terminal)
```

| From | To | RPC | Display Name | Notes |
|------|----|-----|-------------|-------|
| Pending | Approved | `approve_time_off` | Approve | Prevents self-approval |
| Pending | Denied | `deny_time_off` | Deny | Optional response_notes param. Prevents self-denial |

### Status Transitions: `reimbursement`

```
Pending ──→ Approved (terminal)
       └──→ Denied (terminal)
```

| From | To | RPC | Display Name | Notes |
|------|----|-----|-------------|-------|
| Pending | Approved | `approve_reimbursement` | Approve | Prevents self-approval |
| Pending | Denied | `deny_reimbursement` | Deny | Optional response_notes param |

**Pattern:** `time_off_request` and `reimbursement` share the identical approve/deny workflow shape. Only the RPCs and permission rules differ.

### Property Change Triggers: `staff_documents.status_id`

| Change Type | Value | Function | Display Name | Effect |
|-------------|-------|----------|-------------|--------|
| `any` | — | `staff_document_status_guard` | Guard against direct status edits | BEFORE: resets status if caller is `authenticated` role (not SECURITY DEFINER RPC) |
| `any` | — | `update_onboarding_status` | Recalculate onboarding progress | AFTER: recomputes parent staff_members.onboarding_status_id |
| `changed_to` | Needs Revision | `notify_document_status_change` | Notify staff on revision needed | AFTER: email to staff member |
| `changed_to` | Approved | `notify_document_status_change` | Notify staff on approval | AFTER: email to staff member |

### Property Change Triggers: `staff_documents.file`

| Change Type | Value | Function | Display Name | Effect |
|-------------|-------|----------|-------------|--------|
| `set` | — | `staff_document_status_guard` | Auto-submit on file upload | BEFORE: auto-transitions Pending/Needs Revision → Submitted when file is uploaded |

**Unique pattern: file upload as implicit status transition.** The same function (`staff_document_status_guard`) handles both status guarding and file-upload auto-submission. This is the only example where a non-status property change drives a status transition.

### Property Change Triggers: `time_off_requests.status_id`

| Change Type | Value | Function | Display Name | Effect |
|-------------|-------|----------|-------------|--------|
| `changed_to` | Approved | `notify_time_off_status_change` | Notify staff on time off approved | AFTER: email |
| `changed_to` | Denied | `notify_time_off_status_change` | Notify staff on time off denied | AFTER: email |

### Property Change Triggers: `reimbursements.status_id`

| Change Type | Value | Function | Display Name | Effect |
|-------------|-------|----------|-------------|--------|
| `changed_to` | Approved | `notify_reimbursement_status_change` | Notify staff on reimbursement approved | AFTER: email |
| `changed_to` | Denied | `notify_reimbursement_status_change` | Notify staff on reimbursement denied | AFTER: email |

### Property Change Triggers: `staff_members.onboarding_status_id`

| Change Type | Value | Function | Display Name | Effect |
|-------------|-------|----------|-------------|--------|
| `changed_to` | All Approved | `notify_onboarding_complete` | Notify managers on onboarding complete | AFTER: email to all managers/admins |

---

## Pothole

**File:** `examples/pothole/init-scripts/10_causal_bindings.sql`

### Status Transitions: none

Uses legacy `IssueStatus` and `WorkPackageStatus` tables (not `metadata.statuses`). No transitions can be declared.

**Implied Issue workflow (not enforced):**
```
New → Verification → Re-estimate or Repair Queue → Batched for Quote → Bid Accepted → Completed
                                                                                       Duplicate (any time)
```

**Implied WorkPackage workflow (not enforced):**
```
New → Competitive → Awarded or Not Selected
```

### Property Change Triggers: `Issue.status`

| Change Type | Value | Function | Display Name | Effect |
|-------------|-------|----------|-------------|--------|
| `any` | — | `notify_issue_status_changed` | Notify reporter on status change | AFTER: email to created_user when status changes |

---

## Design Patterns Observed

### 1. Workflow Shapes

| Shape | Examples | Visualization |
|-------|----------|--------------|
| **Linear** | Mott Park reservation_request (happy path) | Horizontal arrow chain |
| **Fork** | Community Center (Pending → 3 targets) | Diamond or branch node |
| **Fork + Join** | Mott Park (fork at Pending, converge through Completed) | DAG with merge |
| **Loop** | Staff Portal staff_document (Submitted ↔ Needs Revision) | Cycle with back-arrow |
| **Simple binary** | Staff Portal time_off/reimbursement | Two-branch fork |
| **Computed** | Staff Portal staff_onboarding | Dashed arrows, "derived" annotation |

### 2. Trigger Chain Depth

| Depth | Example |
|-------|---------|
| **1 trigger** | Pothole (notify on change) |
| **3-4 triggers** | Community Center (create reservation + audit note + notification) |
| **8-10 triggers** | Mott Park reservation_request (pricing + payments + calendar + audit + notification + validation + color sync + waive flag) |

### 3. Cross-Entity Effects

| Source Change | Target Entity | Example |
|--------------|---------------|---------|
| `reservation_requests.status_id` → Approved | Creates `reservations` row | Community Center |
| `reservation_requests.status_id` → Approved | Creates 3 `reservation_payments` rows | Mott Park |
| `reservation_requests.status_id` → Approved/Completed | Upserts `public_calendar_events` | Mott Park |
| `reservation_requests.status_id` → Cancelled | Cancels `reservation_payments` | Mott Park |
| `reservation_payments.status_id` changes | Note on parent `reservation_requests` | Mott Park |
| `staff_documents.status_id` changes | Recalculates `staff_members.onboarding_status_id` | Staff Portal |
| `payments.transactions.status` → succeeded | Updates `reservation_payments` to Paid | Mott Park |

### 4. Transition Trigger Sources

| Source | Examples |
|--------|----------|
| **User action (entity action button → RPC)** | All approve/deny/cancel/complete/close RPCs |
| **Trigger-driven (property change on same entity)** | File upload → auto-submit (Staff Portal) |
| **Trigger-driven (property change on related entity)** | Stripe webhook → payment status sync (Mott Park) |
| **Scheduled job** | `auto_complete_past_events()` daily at 8 AM (Mott Park) |
| **Side effect of parent transition** | Cancel request → cancel payments (Mott Park) |
| **Computed from children** | Document approvals → onboarding status (Staff Portal) |

### 5. Design Observations for Future Sessions

**For statechart visualization (Session 2):**
- Most workflows are DAGs (no cycles), except Staff Portal's document review loop
- Computed statuses (staff_onboarding) need visual distinction from direct transitions
- Terminal states should be visually marked (filled/bordered differently)
- Transitions with `on_transition_rpc = NULL` (e.g., auto-cancelled payments) should be styled differently from RPC-bound transitions

**For context diagrams (Session 3):**
- Cross-entity effects create the most interesting context diagram edges
- Mott Park's reservation_request is the best test case: approval fans out to 3+ entities
- Staff Portal's document → onboarding computed relationship is a "reverse flow" (child affects parent)

**For causal chain UI (Session 4):**
- Mott Park's approval chain is the deepest: user clicks Approve → pricing calc → payment creation → display name computation → overdue tracking → calendar sync → audit note → email notification
- The "same function, two behaviors" pattern (staff_document_status_guard) needs clear presentation
- Scheduled job transitions (auto_complete_past_events) are a third category beyond user-action and trigger-driven

**Schema improvements identified:**
- `property_change_triggers` could benefit from a `schema_name` column for cross-schema tables (payments.transactions)
- `change_value` stores environment-specific integer IDs; a `changed_to_key` variant storing `(entity_type, status_key)` would be portable
- Computed statuses could be flagged on `metadata.status_types` with `is_computed BOOLEAN`
- Transitions without `on_transition_rpc` that are side effects of other transitions could use a `triggered_by` column to chain causality
