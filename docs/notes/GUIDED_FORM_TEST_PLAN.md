# Guided Form System — Manual Test Plan

**Version**: v0.48.0
**Example**: Neighborhood Hub (`building_use_request` guided form)
**Prerequisites**: Docker environment running with `examples/neighborhood-hub`.

**Testing philosophy**: This plan exercises the guided form UX from the user's perspective. Focus
on how it *feels* — smoothness of transitions, clarity of state, recoverability from errors.

---

## Test Progress

Last updated: 2026-04-28

| Test | Status | Notes |
|------|--------|-------|
| 1. Start New Guided Form | PASS | Precondition RPC correctly blocks at 5 rows (validates error handling) |
| 2. Fill Step 0 - Auto-Save | PASS | Tested via Oak Park Neighbors (10001) draft save |
| 3. Save & Continue (Step 0 -> Step 1) | PASS | Nav updates, parent marked complete |
| 4. Save & Continue Through All Steps | PASS | Full flow: Parent -> Event Scheduling -> Room Preferences -> Review |
| 5. Skip Condition (Private Event) | PASS | Group Type = Private Event skips Event Scheduling + Room Preferences; auto_submit_on_all_skipped fires; on_submit_rpc populates Decision Notes with ineligibility message |
| 6. Require Condition (School) | PASS | Skip button hidden when require_if fires (Group Type = School makes Room Preferences required) |
| 7. Review & Submit | PASS | Submitted record 8: review section shows step data post-submit, skipped steps show "Skipped" badge, lock_on_submit hides Edit buttons, unlocked forms keep Edit buttons |
| 8. On-Submit Navigation | PASS | on_submit_rpc navigate_to redirects to list page after submit |
| 9. Lock on Submit | PASS | Record 10005 (submitted): edit page shows read-only fields, lock_on_submit enforced |
| 10. Edit Completed Step | PASS | View/edit toggle works on complete (not submitted) steps; submitted+locked hides Edit; submitted+unlocked shows Edit |
| 11. Locked Fields | PASS | Group Type disabled after parent completes; other fields remain editable; lock derived from condition definitions |
| 12. Auto-Save on Completed Steps | PASS | No auto-save indicator fires when editing completed step; changes only persist on explicit Save |
| 13. Cascading Options (Room Type) | PASS | Selected Main Hall on Room Preferences, options filtered by group size |
| 14. Resume Mid-Workflow | PASS | Continue button on detail page navigates to correct step |
| 15. Validation Enforcement | PASS | All 4 sub-tests pass: empty→"required", 0→"min 1", 999→"max 500", 50→succeeds |
| 16. Precondition RPC (Start Blocked) | PASS | HTTP 400 error with "Capacity limit reached" message |
| 17. List Page Status Badges | PASS | Draft/Complete/Submitted badges render correctly on list page |
| 18. Non-Guided-Form Regression | PASS | Non-guided entities (tool_types) show normal Add button, no nav, no review section |
| 19. Error Recovery | KNOWN ISSUE | Permission errors (REVOKE UPDATE) return 401 from PostgREST; authErrorInterceptor triggers keycloak.login() redirect, causing full page refresh and loss of form state. Error modal flashes briefly before redirect. Pre-existing issue — not specific to guided forms. |

### Integrator Error Resilience Tests (2026-04-28)

Tested realistic error scenarios that integrators or concurrent users could trigger:

| Scenario | HTTP Status | Error Displayed | Form Recoverable | Verdict |
|----------|-------------|-----------------|-------------------|---------|
| **Two tabs: submit in Tab A, edit in Tab B** | N/A (save succeeded) | No error — admin bypass in `block_submitted_update()` allows edit | N/A | UX GAP: Tab B gave zero warning that record was already submitted. Admin bypass is by design (`has_permission()` check), but stale frontend state is confusing. Non-admin users would hit trigger error → 401 → auth redirect (same as Test 19). |
| **Backend CHECK stricter than frontend** (raw `CHECK (estimated_attendees <= 200)`, frontend allows 500) | 400 | "Validation failed: chk_test_max_attendees" | Yes — form stays editable, "Try again" available | PASS: Error modal shows constraint name. Improvement: add `metadata.constraint_messages` entry for human-friendly text. |
| **on_submit_rpc failure** (RPC raises exception) | 400 | "External notification service unavailable (simulated outage)" — exact RAISE EXCEPTION message | Yes — review section stays visible, Submit button re-enables | PASS: Best-case error handling. Clear message, no data loss, fully recoverable. |
| **Wrong parent_fk_column** (step config says `request_id`, actual column is `building_use_request_id`) | 400 | `column "request_id" does not exist` | Yes — form stays editable, "Try again" available | PASS: Technical but debuggable by integrator. `complete_guided_form_step` RPC surfaces the PostgreSQL error. |

**Key takeaway**: All HTTP 400 errors (CHECK constraints, RPC exceptions, column mismatches) are handled gracefully — error modal appears, form stays functional, user can retry. Only HTTP 401 errors (permission REVOKE) trigger the auth interceptor redirect issue (Test 19).

### Additional Technical Validation (5-Layer Plan)

All 5 layers of the technical test plan passed (2026-04-28):

| Layer | Tests | Status |
|-------|-------|--------|
| 1. SQL (psql) | RPC parent/child lookup, status resolution, step_record_ids, conditions | PASS |
| 2. curl (PostgREST) | Authenticated calls, anonymous denied, child step lookup, full lifecycle | PASS |
| 3. Unit (npm test:headless) | 2535/2535 specs | PASS |
| 4. Browser (Chrome automation) | 8/8: start, complete, all steps, submit, lock, child parent ID, draft edit, regression | PASS |
| 5. Docker (clean deploy) | docker compose down -v && up, migrations apply, RPC accessible | PASS |

### Functional Test Scripts

| Script | Status | Notes |
|--------|--------|-------|
| `v0-48-0-workflow-system-test.sh` | PASS | Migration, RPCs, CHECK constraints, skip_if, on_submit_rpc (26 assertions) |
| `v0-48-0-workflow-browser-test.cjs` | Not recently verified | Playwright: login, start, nav, fill, save & continue |
| `v0-48-0-workflow-conditions-submit-test.cjs` | Not recently verified | Playwright: skip conditions, review submit |
| `v0-48-0-workflow-autosave-viewmode-test.cjs` | Not recently verified | Playwright: auto-save, view/edit toggle |
| `v0-48-0-draft-first-edit-flow-test.cjs` | Not recently verified | Playwright: ensure_step_record, draft-first flow |

### Bugs Found & Fixed During Testing

| Bug | Root Cause | Fix |
|-----|-----------|-----|
| Save & Continue sent wrong parent ID (`p_parent_id: 2` instead of `10003`) | FK column `building_use_request_id` has `show_on_edit: false`, excluded from PostgREST select | Two-pronged: added FK to data$ pipeline + fallback fetch in `detectGuidedFormMode()` |
| TimeSlot on `building_use_event_details` not detected | Column used raw `tstzrange` type, not `time_slot` domain | Changed `time_slot tstzrange` -> `time_slot time_slot` in init SQL |
| Progress nav stale after completing a step | `loadProgress()` cache-first (`if has(pk) return`) never re-fetched | Added `refreshProgress()` call in `completeStep()` via `tap()` |
| Progress nav blinks to zero during refresh | `invalidateProgress()` deleted cache, causing brief empty `[]` | Replaced with `refreshProgress()` that overwrites atomically (old data stays visible) |
| Save on guided form draft shows generic success modal | `performEdit()` always showed success modal | In draft mode, navigate to detail page instead |
| Review page shows redundant "Details" section below | Detail page template renders both Review Section and Details grid | Wrapped Details/M:M/Notes/Related Records in `@if (!showReviewSection())` |
| Detail page shows stale context after Save & Continue | `loadContext()` returned cached pre-completion data after `completeStep()` navigated to detail | Added `invalidateContextForForm()` in `completeStep()` and `submitGuidedForm()` via `tap()` |
| Review step only visible after all steps complete | Review step appended conditionally when `allComplete` was true | Changed to always append review step; gated clickability instead of visibility |

---

## The Guided Form Under Test

**Building Use Request** — a 3-step guided form for mission-aligned groups requesting community
building space.

| Step | Name | Table | Required | Condition |
|------|------|-------|----------|-----------|
| 0 (Parent) | Group Information | `building_use_requests` | Yes | — |
| 1 | Event Scheduling | `building_use_event_details` | Yes | **Skipped** when Group Type = "Private Event" |
| 2 | Room Preferences | `building_use_room_preferences` | No (`can_skip`) | **Required** when Group Type = "School" |

**Key features exercised**: Auto-save, skip_if, require_if, category dropdowns, RPC-driven
cascading options (room_type depends on group_size_estimate), locked condition fields,
lock_on_submit, precondition_rpc, on_submit_rpc with navigate_to, CHECK constraints from
metadata.validations.

---

## Setup Checklist

- [ ] Docker environment running: `cd examples/neighborhood-hub && docker-compose up -d`
- [ ] Keycloak JWK fetched: `./fetch-keycloak-jwk.sh`
- [ ] Frontend running: `npm start` → http://localhost:4200
- [ ] Logged in as `testadmin` (password: `testadmin`) — has full CRUD on guided form tables
- [ ] **IMPORTANT**: Mock data ships with 5 `building_use_requests` records. The precondition
  RPC blocks new forms at >= 5 rows. **Delete at least 1 record** before starting tests:
  ```sql
  DELETE FROM building_use_requests WHERE id = 10001;
  ```
  Or use psql: `docker exec -it <postgres_container> psql -U postgres -d neighborhood_hub`

---

## Mock Data Reference

These records are pre-loaded for testing existing states:

| ID | Name | Group Type | Status | Submitted | Notes |
|----|------|-----------|--------|-----------|-------|
| 10001 | Oak Park Cleanup - Draft | Nonprofit | Draft | No | Step 1 incomplete (missing attendees) |
| 10002 | Smith Birthday Party - Draft | Private Event | Draft | No | Event Scheduling skipped (skip_if) |
| 10003 | Youth Coding Workshop - Complete | Community Group | Complete | No | Ready for review & submit |
| 10004 | After-School STEM Program - Draft | School | Draft | No | Room Prefs required but incomplete |
| 10005 | Community Garden Planning | Nonprofit | Complete | **Yes** | Locked (lock_on_submit) |

---

## Test 1: Start New Guided Form (List Page)

**Goal**: Verify the "Start New" button creates a parent record and redirects to edit.

1. Navigate to `/view/building_use_requests`
2. **Observe**: Button should say "Start New Building Use Request" with a `play_arrow` icon (not "Add")
3. Click "Start New Building Use Request"
4. **Observe**: Should redirect to `/edit/building_use_requests/{new_id}`
5. **Observe**: The guided form nav bar should appear at top showing 3 steps:
   "Group Information" · "Event Scheduling" · "Room Preferences"
6. **Observe**: "Group Information" (step 0) should be highlighted/active
7. **Observe**: No checkmarks on any step yet

**Failure modes**:
- Button says "Add" instead of "Start New" → `guided_form_key` not loaded on entity
- RPC error → check console for `start_guided_form` or `check_no_pending_building_use_request` failure
- **Precondition blocks you** → too many existing rows, delete one (see Setup)

---

## Test 2: Fill Out Step 0 (Parent) — Auto-Save

**Goal**: Verify auto-save fires for draft steps and the UI indicator works.

1. From the edit page after starting a new guided form (Test 1)
2. Type "Test Community Group" into the **Group Name** field and **stop typing**
3. **Wait ~2 seconds** after stopping
4. **Observe**: "Saving..." spinner appears briefly, then "Saved" with checkmark
5. **Wait ~2 more seconds**
6. **Observe**: "Saved" indicator fades back to hidden
7. Refresh the page (`Cmd+R`)
8. **Observe**: "Test Community Group" should be preserved (auto-save persisted it)
9. Type a **Contact Email** and stop — confirm auto-save fires again

**What to feel for**:
- Is the 1500ms debounce noticeable? Too fast? Too slow?
- Is the "Saving.../Saved" indicator visible enough?
- Does it feel safe — like you won't lose work?

---

## Test 3: Save & Continue (Step 0 → Step 1)

**Goal**: Verify step completion and navigation to next step.

1. Fill in all required parent fields:
   - **Group Name**: "Test Community Group"
   - **Group Type**: Select "Community Group" (not "Private Event" — that triggers skip)
   - **Contact Email**: "test@example.com"
   - **Contact Phone**: "(555) 123-4567"
   - **Mission Description**: "Testing the guided form system"
2. Click "Save & Continue"
3. **Observe**: Button should show spinner while processing
4. **Observe**: Should navigate to `/edit/building_use_event_details/{record_id}`
5. **Observe**: The nav bar should update — "Group Information" shows a checkmark
6. **Observe**: You're now on the edit page for "Event Scheduling"

**Failure modes**:
- Validation error blocks completion → a required field is missing
- `completeStep` RPC fails → check console
- Nav bar doesn't update → progress not loaded/cached

---

## Test 4: Save & Continue Through All Steps → Review

**Goal**: Walk through the entire guided form to the review page.

1. On the Event Scheduling step (from Test 3), fill in:
   - **Time Slot**: Select a start/end date+time (renders as dual datetime-local inputs)
   - **Estimated Attendees**: 75
   - **Setup Needs**: (optional, leave blank or fill)
2. Click "Save & Continue"
3. **Observe**: Navigates to `/edit/building_use_room_preferences/{record_id}`
4. **Observe**: Nav bar shows checkmarks on steps 0 and 1, step 2 highlighted
5. On Room Preferences, fill in:
   - **Group Size Estimate**: 75
   - **Room Type**: Should show "Main Hall" and "Conference Room" (not "Outdoor Patio" — filtered by size)
   - **Needs AV Equipment**: check the box
   - **Accessibility Needs**: (optional)
6. Click "Save & Continue"
7. **Observe**: Navigates to `/view/building_use_requests/{id}` (detail page)
8. **Observe**: Review & Submit section appears with collapsible cards for each step
9. **Observe**: Nav bar shows all 3 steps with checkmarks, plus "Review & Submit" at end
10. **Observe**: Only the Review section is shown — no redundant "Details" grid below it

**What to feel for**:
- Is the flow smooth or jarring?
- Does each step transition feel like progress?
- Can you tell where you are in the process at each point?

---

## Test 5: Skip Condition (Private Event Skips Event Scheduling)

**Goal**: Verify `skip_if` hides a step when the condition is met.

1. Start a new guided form (or examine record 10002 — "Smith Birthday Party")
2. On the parent step, set **Group Type** to **"Private Event"**
3. Fill in remaining required fields (group name, email, phone, mission)
4. Click "Save & Continue"
5. **Observe**: The nav bar should NOT show "Event Scheduling"
6. **Observe**: Navigation should jump directly to "Room Preferences" (step 2)
7. Complete Room Preferences and reach review
8. **Observe**: Review section should only show "Group Information" and "Room Preferences" — no "Event Scheduling" card

**Alternative**: Navigate to record 10002 in the list — it's a Private Event draft where Event
Scheduling is already skipped. Verify the nav bar reflects this.

---

## Test 6: Require Condition (School Requires Room Preferences)

**Goal**: Verify `require_if` makes an optional step mandatory.

1. Start a new guided form
2. On the parent step, set **Group Type** to **"School"**
3. Fill in remaining required fields, click "Save & Continue"
4. Complete the Event Scheduling step, click "Save & Continue"
5. **Observe**: You arrive at Room Preferences — this step is now **required**
6. Try to skip or leave it incomplete — the form should not advance to review without completing it
7. Fill in **Room Type** (required validation) and complete the step
8. **Observe**: Review page shows all 3 steps

**Using mock data**: Record 10004 ("After-School STEM Program") is a School with event_details
complete but room_preferences incomplete. Navigate to it and verify it can't be submitted without
completing Room Preferences.

---

## Test 7: Review & Submit

**Goal**: Verify the review section shows step data and submission works.

**Use record 10003** ("Youth Coding Workshop - Complete") — it's complete but not submitted.

1. Navigate to `/view/building_use_requests/10003`
2. **Observe** the Review & Submit section:
   - Collapsible cards for each completed step
   - Field labels in Title Case (not `snake_case`)
   - Boolean fields show "Yes"/"No" (not "true"/"false")
   - Category fields show display names (e.g., "Community Group") not raw IDs
   - Each card has an "Edit" button
   - No redundant "Details" grid below the review section
3. **Observe**: Review intro text: "Please review your request details before submitting..."
4. Click "Submit Application"
5. **Observe**: Page should refresh, review section disappears
6. **Observe**: The `display_name` should now end with " -- Submitted" (on_submit_rpc side effect)
7. Navigate to the list page
8. **Observe**: Record 10003 shows a blue "Submitted" badge

**What to feel for**:
- Does the review give you confidence in what you're submitting?
- Are the formatted values readable? Or do you see raw IDs/ISO dates?
- Is the submit action clear and final-feeling?

---

## Test 8: On-Submit Navigation

**Goal**: Verify the `on_submit_rpc` return value drives post-submit navigation.

1. After submitting in Test 7 (or submit a new form)
2. **Observe**: After submit completes, the page should navigate to `/view/building_use_requests`
   (the list page — as specified by the `navigate_to` return from `notify_building_use_submitted`)
3. If it stays on the detail page instead, the `navigate_to` handling is broken

---

## Test 9: Lock on Submit (Post-Submit Read-Only)

**Goal**: Verify submitted forms cannot be edited when `lock_on_submit = TRUE`.

**Use record 10005** ("Community Garden Planning" — already submitted).

1. Navigate to `/view/building_use_requests/10005`
2. **Observe**: No "Edit" button should appear (or if edit page is accessible, fields should be read-only)
3. Try navigating directly to `/edit/building_use_requests/10005`
4. **Observe**: Either the page blocks editing, or saving triggers a database error from
   `trg_block_submitted_update`
5. **Observe**: The error should be human-readable, not a raw PostgreSQL error

---

## Test 10: Edit a Completed Step (View Mode → Edit Mode)

**Goal**: Verify the view/edit toggle for completed steps before submission.

**Use record 10003** (complete, not submitted — if you haven't submitted it in Test 7, or use 10004).

1. Navigate to a completed step via the nav bar
2. **Observe**: The edit page should show an "Edit" button instead of "Save"
   (completed step starts in view mode)
3. Click "Edit"
4. **Observe**: Form fields become editable, "Save" and "Cancel" buttons appear
5. Make a change and click "Save"
6. **Observe**: Standard save behavior, CHECK constraints should fire
7. **Alternative**: Click "Cancel" instead
8. **Observe**: Form reverts to original values, returns to view mode

---

## Test 11: Locked Fields (Condition Fields on Completed Parent)

**Goal**: Verify that `group_type` (the field driving skip/require conditions) is locked after
step 0 completes.

1. Use record 10003 or 10004 (both have completed parent step)
2. Navigate to the parent edit page (click "Group Information" in nav)
3. **Observe**: The **Group Type** dropdown should be visually disabled/grayed out
4. Try to change it
5. **Observe**: The dropdown should not respond (disabled form control)
6. **Observe**: Other fields (Group Name, Contact Email, etc.) should remain editable
   (only condition fields are locked)

**Why this matters**: If group_type could be changed after step 0, it would alter which steps
are skipped/required — invalidating already-completed steps.

**Failure modes**:
- Group Type is still editable → `lockFieldsEffect` not firing
- ALL fields are locked → too aggressive locking
- No visual indication of lock → field is disabled but doesn't look different

---

## Test 12: Auto-Save Does NOT Fire on Completed Steps

**Goal**: Verify auto-save is disabled for completed (non-draft) steps.

1. Navigate to a completed step's edit page (e.g., step 0 of record 10003)
2. Click "Edit" to enter edit mode
3. Make changes to fields
4. **Wait 3+ seconds**
5. **Observe**: No "Saving..." indicator should appear
6. Changes should be local only until you click "Save"

---

## Test 13: Cascading RPC-Driven Options (Room Type)

**Goal**: Verify `options_source_rpc` with `depends_on_columns` works within a guided form step.

1. Start a new guided form or navigate to an in-progress one at step 2 (Room Preferences)
2. Set **Group Size Estimate** to **30**
3. Click the **Room Type** dropdown
4. **Observe**: Should show all 3 options — Main Hall, Conference Room, Outdoor Patio
5. Change **Group Size Estimate** to **75**
6. Click **Room Type** again
7. **Observe**: Should show only Main Hall and Conference Room (Outdoor Patio filtered out)
8. Change **Group Size Estimate** to **150**
9. Click **Room Type** again
10. **Observe**: Should show only Main Hall

**Why this matters**: This tests that the standard Civic OS cascading dropdown feature works
correctly inside a guided form step context, not just on regular entity pages.

---

## Test 14: Resume Mid-Workflow

**Goal**: Verify that users can resume an in-progress guided form from the detail page.

1. Use a draft record with partial progress (e.g., record 10001 or 10004)
2. Navigate to the detail page (`/view/building_use_requests/{id}`)
3. **Observe**: "Continue" button appears below the nav bar
4. Click "Continue"
5. **Observe**: Navigates to the first incomplete, non-skipped step
6. **Observe**: Nav bar correctly reflects completed vs incomplete steps (no blinking during load)
7. Complete the step via "Save & Continue"
8. **Observe**: Progress nav updates smoothly — no flash to zero progress between old and new state
9. Navigate back to the detail page
10. **Observe**: Nav bar shows updated progress, "Continue" targets the next incomplete step

**Also test page refresh**:
11. On a step edit page, refresh the browser (`Cmd+R`)
12. **Observe**: Nav bar loads with correct checkmarks, current step indicated

---

## Test 15: Validation Enforcement at Step Completion

**Goal**: Verify that required fields block "Save & Continue" but not plain "Save" on drafts.

### Draft Save (no validation)
1. Start a new guided form or navigate to a draft step
2. Leave required fields empty
3. Click "Save"
4. **Observe**: Save succeeds — navigates to detail page (no validation error)
5. **Observe**: Database accepts partial data (CHECK constraints use `is_guided_form_draft()` bypass)

### Save & Continue (full validation)
6. Navigate back to the same step and click "Save & Continue" with required fields empty
7. **Observe**: Validation error banner appears, required fields are highlighted
8. **Observe**: Step does NOT complete (no checkmark in nav)
9. Fill in all required fields
10. Click "Save & Continue" again
11. **Observe**: Step completes successfully, navigates to next step

**Also test step 1 validation** (if metadata.validations rows exist):
12. On Event Scheduling, leave **Estimated Attendees** empty and click "Save & Continue"
13. **Observe**: Validation error — "Estimated attendees is required"
14. Enter **0** and click "Save & Continue"
15. **Observe**: Validation error — "Must have at least 1 attendee" (min validation)
16. Enter **999** and click "Save & Continue"
17. **Observe**: Validation error — "Cannot exceed 500 attendees" (max validation)
18. Enter **50** and click "Save & Continue"
19. **Observe**: Step completes successfully

---

## Test 16: Precondition RPC (Start Blocked)

**Goal**: Verify the precondition check blocks form creation when conditions aren't met.

1. Ensure there are **5 or more** `building_use_requests` records in the database
   (the mock data ships with exactly 5)
2. Navigate to `/view/building_use_requests`
3. Click "Start New Building Use Request"
4. **Observe**: An error should appear — the precondition RPC rejects the request
5. **Observe**: No new record should be created
6. **Observe**: You should remain on the list page (not redirected to a broken edit page)

**What to feel for**:
- Is the error message clear? Does it explain WHY you can't start a new form?
- Or is it a raw RPC error that means nothing to the user?

---

## Test 17: List Page Status Badges

**Goal**: Verify correct badge rendering for each guided form state.

1. Navigate to `/view/building_use_requests`
2. **Observe** the status badges on each row:
   - Records 10001, 10002, 10004: yellow "Draft" badge
   - Record 10003: green "Complete" badge
   - Record 10005: blue "Submitted" badge
3. Confirm the badge logic:
   - `submitted_at` present → "Submitted" (blue) — takes priority
   - `guided_form_status = 'complete'` → "Complete" (green)
   - `guided_form_status = 'draft'` → "Draft" (yellow)

---

## Test 18: Non-Guided-Form Entity Regression Check

**Goal**: Verify that non-guided-form entities are completely unaffected.

1. Navigate to a standard entity list page — try **Tool Types** (`/view/tool_types`)
   or **Parcels** (`/view/parcels`)
2. **Observe**: Button says "Add" (not "Start New")
3. **Observe**: No Status column with Draft/Complete/Submitted badges
4. Click into a record's detail page
5. **Observe**: No guided form nav bar, no review section
6. Click Edit
7. **Observe**: Standard edit form — no "Save & Continue" button, no auto-save indicator
8. **Critical**: Verify that properties with `show_on_edit: false` are still hidden
   (e.g., `created_at`, `updated_at` should not appear on edit forms)
9. **Critical**: Verify that properties with `show_on_detail: false` are still hidden

---

## Test 19: Error Recovery

**Goal**: Verify graceful handling of backend errors.

1. (Requires database access) Temporarily revoke permissions:
   ```sql
   REVOKE UPDATE ON building_use_requests FROM authenticated;
   ```
2. Navigate to a draft guided form and try "Save & Continue"
3. **Observe**: Error modal should appear with a human-readable message
4. **Observe**: Form should remain editable (not stuck in loading/spinner state)
5. Restore permissions:
   ```sql
   GRANT UPDATE ON building_use_requests TO authenticated;
   ```
6. Retry "Save & Continue"
7. **Observe**: Succeeds normally

---

## Post-Test Notes

After walking through all tests, capture your impressions:

- **Flow smoothness**: Did the step-to-step transitions feel natural?
- **State clarity**: Could you always tell where you were in the process?
- **Auto-save trust**: Did the auto-save feel reliable? Any data loss?
- **Nav bar utility**: Was the step navigation helpful for jumping around?
- **Review quality**: Did the review section give enough information to submit confidently?
  Or were there raw IDs, ISO dates, or snake_case labels?
- **Error handling**: Were error messages clear? Could you recover?
- **Skip/require clarity**: Was it obvious that a step was skipped or made required?
- **Cascading dropdowns**: Did the room type options update correctly based on group size?
- **Lock behavior**: Was it clear that group_type was locked? That submitted forms can't be edited?
- **Polish items**: Any rough edges, layout issues, or confusing labels?
