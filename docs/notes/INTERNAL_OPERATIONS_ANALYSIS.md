# Internal Agency Operations Analysis

**Date**: December 2024
**Purpose**: Analysis of Civic OS capabilities for internal agency operations where citizen/client input becomes staff work items.

## Context

Many agencies use Civic OS to manage workflows where:
1. Citizens/clients submit requests via a public dashboard
2. Requests become work items for internal staff
3. Staff process, approve, or complete work items
4. Status updates flow back to citizens

This analysis identifies which existing features support this pattern, what's missing, and prioritizes roadmap items for internal operations.

## Current State Assessment

### Features That Work Well for Internal Users

| Feature | Version | Internal Value |
|---------|---------|----------------|
| **Status Type System** | v0.15.0 | Track work states (Open → In Progress → Completed) |
| **Notifications** | v0.11.0 | Alert staff when new items arrive or status changes |
| **Calendar Widgets** | v0.9.0 | Visualize scheduled work, appointments |
| **Filtered List Widgets** | v0.8.0 | Build work queues on dashboards |
| **User Assignment Columns** | Core | Assign items via FK to `civic_os_users` |
| **Import/Export** | v0.10.0 | Bulk data operations for reporting |
| **Full-Text Search** | Core | Find records across large datasets |

### Critical Gaps

| Gap | Impact | Workaround |
|-----|--------|------------|
| **No Quick Actions** | Staff edit forms to change status | None (clunky UX) |
| **No "My Work" View** | Staff can't see assigned items | Dashboard with filters |
| **No Activity Log** | Can't see who changed what | Database audit tables (no UI) |
| **No Comments/Notes** | Can't discuss items internally | External tools (email, Slack) |
| **No Bulk Actions** | Can't process multiple items | Individual edits |
| **No Due Dates/SLAs** | Can't prioritize by urgency | Sort by created_at |
| **No Workflow Rules** | Status changes not enforced | Tribal knowledge |

## Example Workflow Patterns

### Pothole Example (Citizen Reports → Work Items)

```
Citizen Report → Issue (New) → Verification → Repair Queue → Work Package → Completed
                     ↓
              assigned to staff via created_user FK
```

**Pattern**: Auto-assign creator, status-driven workflow, notification on status change.

### Community Center Example (Reservations with Approval)

```
User Request → Pending → [Staff Review] → Approved/Denied → Reservation Created
                              ↓
                    reviewed_by FK tracks approver
```

**Pattern**: Two-table design (requests → approved records), trigger-driven sync, multi-recipient notifications.

## Recommended Priorities

### Phase A: Enable Actions (4-6 weeks)

1. **Entity Action Buttons** 🔴 CRITICAL
   - Full design exists (`docs/development/ENTITY_ACTIONS.md`)
   - Transforms clunky status editing into one-click workflows
   - Examples: "Approve", "Assign to Me", "Close as Duplicate"

2. **First-Class Notes System** 🟡 HIGH
   - New design (`docs/development/ENTITY_NOTES.md`)
   - Replaces per-entity notes tables
   - Human-focused with trigger API for system notes

### Phase B: Visibility (4-6 weeks)

3. **Activity/Audit Log**
   - Track who changed what field and when
   - Timeline UI on Detail pages
   - Important for accountability

4. **Dashboard Management UI**
   - Let staff create personal "My Work" dashboards
   - Already on roadmap (Phase 3)

### Phase C: Workflow & Scale (6-8 weeks)

5. **Workflow System**
   - Enforce valid status transitions
   - Already on roadmap (Phase 1)

6. **Bulk Actions**
   - Select multiple items, apply action
   - Mentioned in Entity Actions design

### Phase D: Advanced (Future)

7. **Due Date / SLA Tracking**
8. **Assignment Queue / Load Balancing**
9. **Advanced Dashboard Widgets** (stat cards, charts)

## Building "My Work" Today

Dashboard widgets can approximate a "My Work" view:

```sql
-- Dashboard widget: My Open Issues
INSERT INTO metadata.dashboard_widgets (
  dashboard_id, widget_type, title, entity_key, config
) VALUES (
  v_dashboard_id,
  'filtered_list',
  'My Open Issues',
  'issues',
  jsonb_build_object(
    'filters', jsonb_build_array(
      jsonb_build_object('column', 'assigned_user_id', 'operator', 'eq', 'value', current_user_id()::text),
      jsonb_build_object('column', 'status_id', 'operator', 'neq', 'value', 'closed')
    ),
    'orderBy', 'created_at',
    'orderDirection', 'asc',
    'limit', 20
  )
);
```

**Limitations**: Requires SQL, doesn't aggregate across entity types.

## Entity Actions Enable "Workflow-Lite"

Without the full Workflow system, Entity Actions provide 80% of value:

- **"Approve" button**: Changes status AND sends notification
- **"Assign to Me" button**: Sets `assigned_user_id = current_user_id()`
- **"Escalate" button**: Changes status AND creates note
- **Visibility conditions**: Show "Approve" only when `status = 'pending'`
- **Permission checks**: Only editors can see "Approve" button

This works well for agencies wanting guided workflows without strict enforcement.

## New Roadmap Items Added

Based on this analysis, the following were added to `docs/ROADMAP.md`:

### Phase 1 - Logic
- **First-Class Notes System** - Polymorphic notes for any entity

### Phase 2 - Utilities
- **Activity/Audit Log** - Track who changed what and when
- **Due Date / SLA Property Type** - Time-based prioritization

### Phase 4 - Extension Modules
- **Assignment Queue / Load Balancing** - Work distribution for teams

## Related Documentation

- [Entity Actions Design](../development/ENTITY_ACTIONS.md) - Detailed design for action buttons
- [Entity Notes Design](../development/ENTITY_NOTES.md) - Detailed design for notes system
- [Dashboard Widgets](../development/DASHBOARD_WIDGETS.md) - Widget configuration reference
- [Notifications](../development/NOTIFICATIONS.md) - Notification system architecture
- [Status Type System](../development/STATUS_TYPE_SYSTEM.md) - Centralized status management

## Conclusion

The single most impactful improvement for internal operations is **implementing Entity Actions**, which is fully designed but not yet built. This feature transforms the staff experience from "edit form to change status" to "click Approve button" - a fundamental UX improvement.

The second priority is **First-Class Notes**, enabling internal communication without external tools or custom per-entity tables.

Together, these two features would make Civic OS significantly more usable for agencies managing internal workflows from citizen input.
