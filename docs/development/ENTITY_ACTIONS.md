# Entity Action Buttons - Design & Implementation Guide

**Status**: Implemented (v0.18.0)
**Note**: This is a design document. For usage guide, see `docs/INTEGRATOR_GUIDE.md` (Entity Action Buttons section).
**Last Updated**: 2025-11-26

## Overview

Entity action buttons provide a metadata-driven system for executing PostgreSQL RPC functions directly from the UI. Actions appear as buttons on Detail pages, with configurable visibility, disabled states, permissions, and post-action behavior controlled by RPC return values.

## Key Design Principles

1. **RPC-Driven Behavior**: The RPC function controls success messages, error messages, and navigation through its return value
2. **Dual Control**: Both visibility (hide/show) and disabled state (clickable/non-clickable) can be configured
3. **Per-RPC Permissions**: Granular role-based access control at the function level
4. **Condition-Based UI**: Buttons adapt to entity state using metadata expressions
5. **Consistent UX**: Follows existing Civic OS patterns (OnPush, signals, async pipe, modals)

## Architecture

### Permission Model

**Per-RPC Permission System** (parallel to table permissions):

```
metadata.protected_rpcs
  ├─ rpc_function (NAME, PK)
  └─ description

metadata.protected_rpc_roles
  ├─ rpc_function (FK to protected_rpcs)
  └─ role_id (FK to metadata.roles)

public.has_rpc_permission(p_rpc_function NAME) → BOOLEAN
```

**Permission Check Logic**:
- If RPC is NOT in `protected_rpcs` → Allow execution (unprotected function)
- If RPC IS in `protected_rpcs` → Check if user's role has permission
- Admin role always has access to all RPCs

### Metadata Model

**Primary Table**: `metadata.entity_actions`

```sql
CREATE TABLE metadata.entity_actions (
  id SERIAL PRIMARY KEY,
  table_name NAME NOT NULL,
  action_name VARCHAR(100) NOT NULL,  -- Unique identifier (e.g., 'approve_fix')
  display_name TEXT NOT NULL,         -- Button label
  description TEXT,                   -- Tooltip text
  rpc_function NAME NOT NULL,         -- PostgreSQL function to call

  -- Visual styling
  icon VARCHAR(50),                   -- Material Symbols icon name
  button_style VARCHAR(20) DEFAULT 'primary',  -- DaisyUI: primary, accent, success, warning, error
  sort_order INT DEFAULT 0,

  -- Confirmation modal
  requires_confirmation BOOLEAN DEFAULT false,
  confirmation_message TEXT,          -- Override default "Are you sure?"

  -- Visibility & Disabled State (evaluated client-side)
  visibility_condition JSONB,         -- When to HIDE button entirely
  disabled_condition JSONB,           -- When to DISABLE button (show but not clickable)
  disabled_tooltip TEXT,              -- Tooltip when button is disabled

  -- Post-action defaults (can be overridden by RPC return value)
  default_success_message TEXT,
  default_navigate_to TEXT,           -- Optional navigation after success
  refresh_after_action BOOLEAN DEFAULT true,

  -- Page placement
  show_on_detail BOOLEAN DEFAULT true,
  show_on_list BOOLEAN DEFAULT false, -- Future: bulk actions

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(table_name, action_name)
);

CREATE INDEX idx_entity_actions_table_name ON metadata.entity_actions(table_name);
```

**Condition Format**: JSONB expression evaluated against entity data

```json
{
  "field": "status",
  "operator": "eq",
  "value": "pending"
}
```

**Supported Operators**:
- `eq`, `ne`: Equality/inequality
- `gt`, `lt`, `gte`, `lte`: Numeric comparison
- `in`: Array membership (e.g., `"value": ["pending", "review"]`)
- `is_null`, `is_not_null`: Null checks

**Visibility vs Disabled**:
- **visibility_condition**: When false, button does NOT render at all
- **disabled_condition**: When true, button renders but is grayed out and non-clickable
- Use **visibility** for: Actions that never apply (e.g., "Approve" on rejected records)
- Use **disabled** for: Actions that might apply later (e.g., "Submit" when form incomplete)

### View: `schema_entity_actions`

```sql
CREATE OR REPLACE VIEW public.schema_entity_actions AS
SELECT
  ea.id,
  ea.table_name,
  ea.action_name,
  ea.display_name,
  ea.description,
  ea.rpc_function,
  ea.icon,
  ea.button_style,
  ea.sort_order,
  ea.requires_confirmation,
  ea.confirmation_message,
  ea.visibility_condition,
  ea.disabled_condition,
  ea.disabled_tooltip,
  ea.default_success_message,
  ea.default_navigate_to,
  ea.refresh_after_action,

  -- Permission check: is RPC protected? If yes, check permission. If no, allow.
  CASE
    WHEN EXISTS (SELECT 1 FROM metadata.protected_rpcs WHERE rpc_function = ea.rpc_function)
    THEN public.has_rpc_permission(ea.rpc_function)
    ELSE true
  END AS can_execute

FROM metadata.entity_actions ea
WHERE ea.show_on_detail = true
ORDER BY ea.table_name, ea.sort_order;

ALTER VIEW public.schema_entity_actions SET (security_invoker = true);
GRANT SELECT ON public.schema_entity_actions TO web_anon, authenticated;
```

## RPC Function Contract

### Standard Signature

All entity action RPCs MUST follow this pattern:

```sql
CREATE OR REPLACE FUNCTION <action_name>(p_entity_id <PRIMARY_KEY_TYPE>)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  -- Local variables
BEGIN
  -- 1. Permission check (if protected)
  IF NOT has_rpc_permission('<function_name>') THEN
    RETURN jsonb_build_object(
      'success', false,
      'message', 'Permission denied'
    );
  END IF;

  -- 2. State validation
  -- Check if action is valid for current entity state

  -- 3. Execute business logic
  -- Update records, create related records, etc.

  -- 4. Return result
  RETURN jsonb_build_object(
    'success', true,
    'message', 'Custom success message',
    'navigate_to', '/view/some_table/123',  -- Optional
    'refresh', true  -- Optional, defaults to metadata setting
  );
END;
$$;

GRANT EXECUTE ON FUNCTION <action_name>(<PRIMARY_KEY_TYPE>) TO authenticated;
```

### Return Value Schema

**Success Response**:
```json
{
  "success": true,
  "message": "Bid approved successfully",
  "navigate_to": "/view/bids",
  "refresh": true,
  "data": {
    "any": "additional data for UI"
  }
}
```

**Error Response**:
```json
{
  "success": false,
  "message": "Cannot approve bid in 'rejected' status"
}
```

### Return Value Priority

When RPC returns a value, it OVERRIDES metadata defaults:

1. **message**: RPC `message` field → `default_success_message` → "Action completed successfully"
2. **navigate_to**: RPC `navigate_to` field → `default_navigate_to` → Stay on page
3. **refresh**: RPC `refresh` field → `refresh_after_action` → true

This allows RPCs to make context-sensitive decisions (e.g., navigate to created record ID).

## Frontend Implementation

### TypeScript Interfaces

**File**: `src/app/interfaces/entity.ts`

```typescript
export interface EntityAction {
  id: number;
  table_name: string;
  action_name: string;
  display_name: string;
  description?: string;
  rpc_function: string;
  icon?: string;
  button_style: 'primary' | 'secondary' | 'accent' | 'success' | 'warning' | 'error';
  sort_order: number;
  requires_confirmation: boolean;
  confirmation_message?: string;
  visibility_condition?: VisibilityCondition;
  disabled_condition?: VisibilityCondition;
  disabled_tooltip?: string;
  default_success_message?: string;
  default_navigate_to?: string;
  refresh_after_action: boolean;
  can_execute: boolean;  // From permission check in view
}

export interface VisibilityCondition {
  field: string;
  operator: 'eq' | 'ne' | 'gt' | 'lt' | 'gte' | 'lte' | 'in' | 'is_null' | 'is_not_null';
  value?: any;
}

export interface EntityActionResult {
  success: boolean;
  message: string;
  navigate_to?: string;
  refresh?: boolean;
  data?: any;
}
```

### Condition Evaluator

**New File**: `src/app/utils/condition-evaluator.ts`

```typescript
import { VisibilityCondition } from '../interfaces/entity';

/**
 * Evaluates a visibility or disabled condition against entity data.
 * Returns true if condition is satisfied, false otherwise.
 * If no condition provided, returns true (always visible/enabled).
 */
export function evaluateCondition(
  condition: VisibilityCondition | undefined,
  entityData: any
): boolean {
  if (!condition) return true;

  const { field, operator, value } = condition;
  const fieldValue = entityData[field];

  switch (operator) {
    case 'eq':
      return fieldValue === value;
    case 'ne':
      return fieldValue !== value;
    case 'gt':
      return fieldValue > value;
    case 'lt':
      return fieldValue < value;
    case 'gte':
      return fieldValue >= value;
    case 'lte':
      return fieldValue <= value;
    case 'in':
      return Array.isArray(value) && value.includes(fieldValue);
    case 'is_null':
      return fieldValue === null || fieldValue === undefined;
    case 'is_not_null':
      return fieldValue !== null && fieldValue !== undefined;
    default:
      console.warn(`Unknown operator: ${operator}`);
      return false;
  }
}
```

**Unit Tests**: `src/app/utils/condition-evaluator.spec.ts`

```typescript
describe('evaluateCondition', () => {
  it('should return true when no condition provided', () => {
    expect(evaluateCondition(undefined, {})).toBe(true);
  });

  it('should evaluate equality', () => {
    const data = { status: 'pending' };
    const condition = { field: 'status', operator: 'eq' as const, value: 'pending' };
    expect(evaluateCondition(condition, data)).toBe(true);
  });

  it('should evaluate "in" operator', () => {
    const data = { status: 'review' };
    const condition = { field: 'status', operator: 'in' as const, value: ['pending', 'review'] };
    expect(evaluateCondition(condition, data)).toBe(true);
  });

  // ... more tests for all operators
});
```

### DataService Updates

**File**: `src/app/services/data.service.ts`

Add method after `refreshCurrentUser()` (~line 217):

```typescript
/**
 * Execute a PostgreSQL RPC function with parameters.
 * Used for entity actions and other backend operations.
 *
 * @param functionName - The PostgreSQL function name
 * @param params - Parameters to pass (must match function signature)
 * @returns Observable<ApiResponse> with success/error and optional data
 */
public executeRpc(
  functionName: string,
  params: Record<string, any> = {}
): Observable<ApiResponse> {
  return this.http.post(getPostgrestUrl() + 'rpc/' + functionName, params)
    .pipe(
      catchError((err) => this.parseApiError(err)),
      map((response) => {
        // If catchError already returned error response, pass through
        if (response && typeof response === 'object' && 'success' in response && response.success === false) {
          return response as ApiResponse;
        }
        // Otherwise, wrap successful response
        return <ApiResponse>{success: true, body: response};
      }),
    );
}
```

### SchemaService Updates

**File**: `src/app/services/schema.service.ts`

Add method in appropriate location (~line 150):

```typescript
/**
 * Get all actions configured for a specific entity.
 * Returns actions with permission checks already applied.
 *
 * @param tableName - The entity table name
 * @returns Observable<EntityAction[]> sorted by sort_order
 */
public getEntityActions(tableName: string): Observable<EntityAction[]> {
  return this.http.get<EntityAction[]>(
    getPostgrestUrl() + 'schema_entity_actions',
    {
      params: {
        table_name: `eq.${tableName}`,
        order: 'sort_order.asc'
      }
    }
  );
}
```

### DetailPage Updates

**File**: `src/app/pages/detail/detail.page.ts`

#### Add Imports

```typescript
import { evaluateCondition } from '../../utils/condition-evaluator';
import type { EntityAction, EntityActionResult } from '../../interfaces/entity';
```

#### Add Properties

```typescript
// Entity actions
actions$!: Observable<EntityAction[]>;
visibleActions$!: Observable<EntityAction[]>;

// Action modal state
showActionModal = signal(false);
currentAction = signal<EntityAction | undefined>(undefined);
actionLoading = signal(false);
actionError = signal<string | undefined>(undefined);
actionSuccess = signal<string | undefined>(undefined);
```

#### Update ngOnInit

```typescript
ngOnInit() {
  // ... existing code ...

  // Load entity actions
  this.actions$ = this.entity$.pipe(
    switchMap(entity => this.schema.getEntityActions(entity.table_name)),
    shareReplay(1)
  );

  // Filter actions by permission and visibility condition
  this.visibleActions$ = combineLatest([this.actions$, this.data$]).pipe(
    map(([actions, data]) =>
      actions.filter(action =>
        action.can_execute &&
        evaluateCondition(action.visibility_condition, data)
      )
    )
  );
}
```

#### Add Action Methods

```typescript
/**
 * Opens the confirmation modal for an entity action.
 */
openActionModal(action: EntityAction) {
  this.currentAction.set(action);
  this.actionError.set(undefined);
  this.actionSuccess.set(undefined);
  this.showActionModal.set(true);
}

/**
 * Closes the action modal and resets state.
 */
closeActionModal() {
  this.showActionModal.set(false);
  this.currentAction.set(undefined);
}

/**
 * Checks if an action should be disabled based on its disabled_condition.
 */
isActionDisabled(action: EntityAction, data: any): boolean {
  return !evaluateCondition(action.disabled_condition, data);
}

/**
 * Executes the selected action's RPC function.
 * Handles success/error, messages, navigation, and data refresh.
 */
confirmAction() {
  const action = this.currentAction();
  if (!action || !this.entityId) return;

  this.actionLoading.set(true);
  this.actionError.set(undefined);

  this.data.executeRpc(action.rpc_function, {
    p_entity_id: this.entityId
  }).subscribe({
    next: (response) => {
      this.actionLoading.set(false);

      if (response.success) {
        const result = response.body as EntityActionResult;

        // Determine success message (RPC > metadata > default)
        const message = result?.message || action.default_success_message || 'Action completed successfully';
        this.actionSuccess.set(message);

        // Determine navigation (RPC > metadata > none)
        const navigateTo = result?.navigate_to || action.default_navigate_to;

        // Determine refresh (RPC > metadata default)
        const shouldRefresh = result?.refresh !== undefined
          ? result.refresh
          : action.refresh_after_action;

        // Close modal after brief delay to show success message
        setTimeout(() => {
          this.closeActionModal();

          // Refresh data if needed
          if (shouldRefresh && !navigateTo) {
            this.loadData();
          }

          // Navigate if specified
          if (navigateTo) {
            this.router.navigate([navigateTo]);
          }
        }, 1500);
      } else {
        // Show error message from RPC or API
        this.actionError.set(response.error?.humanMessage || 'Action failed');
      }
    },
    error: () => {
      this.actionLoading.set(false);
      this.actionError.set('An unexpected error occurred. Please try again.');
    }
  });
}
```

### DetailPage Template Updates

**File**: `src/app/pages/detail/detail.page.html`

#### Add Action Buttons (after Edit/Delete buttons, ~line 21)

```html
<!-- Entity Actions -->
@if (visibleActions$ | async; as actions) {
  @if (data$ | async; as data) {
    @for (action of actions; track action.id) {
      <button
        class="btn btn-{{action.button_style}}"
        (click)="openActionModal(action)"
        [disabled]="isActionDisabled(action, data)"
        [title]="isActionDisabled(action, data) ? action.disabled_tooltip : action.description">
        @if (action.icon) {
          <span class="material-symbols-outlined">{{action.icon}}</span>
        }
        {{action.display_name}}
      </button>
    }
  }
}
```

#### Add Action Modal (at end of template, ~line 201)

```html
<!-- Action Confirmation Modal -->
@if (showActionModal()) {
  <div class="modal modal-open">
    <div class="modal-box">
      @if (currentAction(); as action) {
        <h3 class="font-bold text-lg mb-4">{{action.display_name}}</h3>

        @if (actionError()) {
          <div class="alert alert-error mb-4">
            <span class="material-symbols-outlined">error</span>
            <span>{{ actionError() }}</span>
          </div>
        }

        @if (actionSuccess()) {
          <div class="alert alert-success mb-4">
            <span class="material-symbols-outlined">check_circle</span>
            <span>{{ actionSuccess() }}</span>
          </div>
        } @else {
          <!-- Confirmation message -->
          <p class="mb-6">
            {{ action.confirmation_message || 'Are you sure you want to perform this action?' }}
          </p>

          <!-- Action buttons -->
          <div class="modal-action">
            <button
              class="btn"
              (click)="closeActionModal()"
              [disabled]="actionLoading()">
              Cancel
            </button>
            <button
              class="btn btn-{{action.button_style}}"
              (click)="confirmAction()"
              [disabled]="actionLoading()">
              @if (actionLoading()) {
                <span class="loading loading-spinner loading-sm"></span>
                Processing...
              } @else {
                @if (action.icon) {
                  <span class="material-symbols-outlined">{{action.icon}}</span>
                }
                Confirm
              }
            </button>
          </div>
        }
      }
    </div>
  </div>
}
```

## Database Migration

**File**: `postgres/migrations/deploy/v0-10-0-add-entity-actions.sql`

```sql
-- Deploy civic_os:v0-10-0-add-entity-actions to pg

BEGIN;

-- ============================================================
-- RPC Permission System
-- ============================================================

CREATE TABLE metadata.protected_rpcs (
  rpc_function NAME PRIMARY KEY,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE metadata.protected_rpc_roles (
  rpc_function NAME REFERENCES metadata.protected_rpcs(rpc_function) ON DELETE CASCADE,
  role_id SMALLINT REFERENCES metadata.roles(id) ON DELETE CASCADE,
  PRIMARY KEY (rpc_function, role_id)
);

COMMENT ON TABLE metadata.protected_rpcs IS
  'Registry of RPC functions that require explicit role permissions';
COMMENT ON TABLE metadata.protected_rpc_roles IS
  'Maps roles to RPC functions they can execute';

-- Permission check function
CREATE OR REPLACE FUNCTION public.has_rpc_permission(p_rpc_function NAME)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1
    FROM metadata.protected_rpc_roles prr
    JOIN metadata.roles r ON r.id = prr.role_id
    WHERE prr.rpc_function = p_rpc_function
    AND r.display_name = ANY(public.get_user_roles())
  );
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

COMMENT ON FUNCTION public.has_rpc_permission IS
  'Check if current user has permission to execute a protected RPC function';

-- ============================================================
-- Entity Actions Metadata
-- ============================================================

CREATE TABLE metadata.entity_actions (
  id SERIAL PRIMARY KEY,
  table_name NAME NOT NULL,
  action_name VARCHAR(100) NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  rpc_function NAME NOT NULL,

  -- Visual styling
  icon VARCHAR(50),
  button_style VARCHAR(20) DEFAULT 'primary',
  sort_order INT DEFAULT 0,

  -- Confirmation
  requires_confirmation BOOLEAN DEFAULT false,
  confirmation_message TEXT,

  -- Conditional UI
  visibility_condition JSONB,
  disabled_condition JSONB,
  disabled_tooltip TEXT,

  -- Post-action behavior (can be overridden by RPC return value)
  default_success_message TEXT,
  default_navigate_to TEXT,
  refresh_after_action BOOLEAN DEFAULT true,

  -- Page placement
  show_on_detail BOOLEAN DEFAULT true,
  show_on_list BOOLEAN DEFAULT false,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(table_name, action_name),
  CHECK (button_style IN ('primary', 'secondary', 'accent', 'success', 'warning', 'error'))
);

CREATE INDEX idx_entity_actions_table_name ON metadata.entity_actions(table_name);

COMMENT ON TABLE metadata.entity_actions IS
  'Defines action buttons that appear on entity pages';
COMMENT ON COLUMN metadata.entity_actions.visibility_condition IS
  'JSONB expression - when false, button is hidden';
COMMENT ON COLUMN metadata.entity_actions.disabled_condition IS
  'JSONB expression - when true, button is disabled but visible';

-- ============================================================
-- Schema View
-- ============================================================

CREATE OR REPLACE VIEW public.schema_entity_actions AS
SELECT
  ea.id,
  ea.table_name,
  ea.action_name,
  ea.display_name,
  ea.description,
  ea.rpc_function,
  ea.icon,
  ea.button_style,
  ea.sort_order,
  ea.requires_confirmation,
  ea.confirmation_message,
  ea.visibility_condition,
  ea.disabled_condition,
  ea.disabled_tooltip,
  ea.default_success_message,
  ea.default_navigate_to,
  ea.refresh_after_action,

  -- Permission check: is RPC protected? If yes, check permission. If no, allow.
  CASE
    WHEN EXISTS (SELECT 1 FROM metadata.protected_rpcs WHERE rpc_function = ea.rpc_function)
    THEN public.has_rpc_permission(ea.rpc_function)
    ELSE true
  END AS can_execute

FROM metadata.entity_actions ea
WHERE ea.show_on_detail = true
ORDER BY ea.table_name, ea.sort_order;

ALTER VIEW public.schema_entity_actions SET (security_invoker = true);

-- ============================================================
-- Grants
-- ============================================================

GRANT SELECT ON metadata.protected_rpcs TO authenticated;
GRANT SELECT ON metadata.protected_rpc_roles TO authenticated;
GRANT SELECT ON metadata.entity_actions TO authenticated;
GRANT SELECT ON public.schema_entity_actions TO web_anon, authenticated;

COMMIT;
```

**Revert File**: `postgres/migrations/revert/v0-10-0-add-entity-actions.sql`

```sql
-- Revert civic_os:v0-10-0-add-entity-actions from pg

BEGIN;

DROP VIEW IF EXISTS public.schema_entity_actions;
DROP TABLE IF EXISTS metadata.entity_actions;
DROP FUNCTION IF EXISTS public.has_rpc_permission(NAME);
DROP TABLE IF EXISTS metadata.protected_rpc_roles;
DROP TABLE IF EXISTS metadata.protected_rpcs;

COMMIT;
```

**Verify File**: `postgres/migrations/verify/v0-10-0-add-entity-actions.sql`

```sql
-- Verify civic_os:v0-10-0-add-entity-actions on pg

BEGIN;

SELECT 1/COUNT(*) FROM pg_tables WHERE schemaname = 'metadata' AND tablename = 'protected_rpcs';
SELECT 1/COUNT(*) FROM pg_tables WHERE schemaname = 'metadata' AND tablename = 'protected_rpc_roles';
SELECT 1/COUNT(*) FROM pg_tables WHERE schemaname = 'metadata' AND tablename = 'entity_actions';
SELECT 1/COUNT(*) FROM pg_views WHERE schemaname = 'public' AND viewname = 'schema_entity_actions';
SELECT 1/COUNT(*) FROM pg_proc WHERE proname = 'has_rpc_permission';

ROLLBACK;
```

## Example Implementation: Pothole Approval

### 1. Create RPC Function

**File**: `examples/pothole/init-scripts/03_entity_actions.sql`

```sql
-- ============================================================
-- Example: Approve Pothole Fix Action
-- ============================================================

CREATE OR REPLACE FUNCTION approve_pothole_fix(p_entity_id BIGINT)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_current_status TEXT;
  v_issue_name TEXT;
BEGIN
  -- Permission check
  IF NOT has_rpc_permission('approve_pothole_fix') THEN
    RETURN jsonb_build_object(
      'success', false,
      'message', 'You do not have permission to approve fixes'
    );
  END IF;

  -- Get current status and display name
  SELECT status, display_name
  INTO v_current_status, v_issue_name
  FROM issues
  WHERE id = p_entity_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'message', 'Pothole not found'
    );
  END IF;

  -- State validation
  IF v_current_status != 'pending' THEN
    RETURN jsonb_build_object(
      'success', false,
      'message', 'Only pending potholes can be approved. Current status: ' || v_current_status
    );
  END IF;

  -- Execute business logic
  UPDATE issues
  SET
    status = 'approved',
    updated_at = NOW()
  WHERE id = p_entity_id;

  -- Success with custom message
  RETURN jsonb_build_object(
    'success', true,
    'message', 'Pothole "' || v_issue_name || '" approved successfully!',
    'refresh', true
  );
END;
$$;

GRANT EXECUTE ON FUNCTION approve_pothole_fix(BIGINT) TO authenticated;

-- ============================================================
-- Register Protected RPC
-- ============================================================

INSERT INTO metadata.protected_rpcs (rpc_function, description)
VALUES ('approve_pothole_fix', 'Approve a pothole repair request');

-- Grant permission to editor and admin roles
INSERT INTO metadata.protected_rpc_roles (rpc_function, role_id)
SELECT 'approve_pothole_fix', id
FROM metadata.roles
WHERE display_name IN ('editor', 'admin');

-- ============================================================
-- Create Entity Action
-- ============================================================

INSERT INTO metadata.entity_actions (
  table_name,
  action_name,
  display_name,
  description,
  rpc_function,
  icon,
  button_style,
  sort_order,
  requires_confirmation,
  confirmation_message,
  default_success_message,
  visibility_condition,
  disabled_condition,
  disabled_tooltip,
  refresh_after_action
) VALUES (
  'issues',
  'approve_fix',
  'Approve Fix',
  'Approve this pothole repair request',
  'approve_pothole_fix',
  'check_circle',
  'success',
  10,
  true,
  'Are you sure you want to approve this pothole repair?',
  'Pothole approved!',
  '{"field": "status", "operator": "ne", "value": "approved"}',  -- Hide if already approved
  '{"field": "status", "operator": "ne", "value": "pending"}',   -- Disable if not pending
  'Only pending potholes can be approved',
  true
);

-- ============================================================
-- Example: Reject Action (similar pattern)
-- ============================================================

CREATE OR REPLACE FUNCTION reject_pothole_fix(p_entity_id BIGINT)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_current_status TEXT;
BEGIN
  IF NOT has_rpc_permission('reject_pothole_fix') THEN
    RETURN jsonb_build_object('success', false, 'message', 'Permission denied');
  END IF;

  SELECT status INTO v_current_status FROM issues WHERE id = p_entity_id;

  IF v_current_status != 'pending' THEN
    RETURN jsonb_build_object(
      'success', false,
      'message', 'Only pending potholes can be rejected'
    );
  END IF;

  UPDATE issues SET status = 'rejected', updated_at = NOW() WHERE id = p_entity_id;

  RETURN jsonb_build_object(
    'success', true,
    'message', 'Pothole rejected',
    'navigate_to', '/view/issues',  -- Navigate back to list
    'refresh', false  -- No need to refresh since we're navigating away
  );
END;
$$;

GRANT EXECUTE ON FUNCTION reject_pothole_fix(BIGINT) TO authenticated;

INSERT INTO metadata.protected_rpcs (rpc_function, description)
VALUES ('reject_pothole_fix', 'Reject a pothole repair request');

INSERT INTO metadata.protected_rpc_roles (rpc_function, role_id)
SELECT 'reject_pothole_fix', id FROM metadata.roles WHERE display_name IN ('editor', 'admin');

INSERT INTO metadata.entity_actions (
  table_name, action_name, display_name, rpc_function,
  icon, button_style, sort_order, requires_confirmation,
  visibility_condition, disabled_condition, disabled_tooltip
) VALUES (
  'issues', 'reject_fix', 'Reject', 'reject_pothole_fix',
  'cancel', 'error', 11, true,
  '{"field": "status", "operator": "ne", "value": "rejected"}',
  '{"field": "status", "operator": "ne", "value": "pending"}',
  'Only pending potholes can be rejected'
);
```

### 2. Testing the Example

**Prerequisites**:
- User with `editor` or `admin` role
- Pothole record with `status = 'pending'`

**Test Flow**:
1. Navigate to Detail page for pending pothole
2. Verify "Approve Fix" button is visible and enabled (green)
3. Verify "Reject" button is visible and enabled (red)
4. Click "Approve Fix"
5. Confirm in modal
6. Verify success message displays
7. Verify page refreshes with updated status
8. Verify buttons now show as disabled (status no longer 'pending')

## UI/UX Considerations

### Button Visibility States

| State | Condition | Visual | Tooltip | Clickable |
|-------|-----------|--------|---------|-----------|
| **Visible & Enabled** | `can_execute = true`, visibility passes, disabled fails | Full color | `description` | ✓ |
| **Visible & Disabled** | `can_execute = true`, visibility passes, disabled passes | Grayed out | `disabled_tooltip` | ✗ |
| **Hidden** | `can_execute = false` OR visibility passes | Not rendered | N/A | N/A |

### Styling Examples

**DaisyUI Button Styles**:
- `primary`: Blue - default actions
- `accent`: Purple - important actions
- `success`: Green - approve/confirm actions
- `warning`: Orange - caution actions
- `error`: Red - reject/delete actions
- `secondary`: Gray - less important actions

### Loading States

During RPC execution:
- Button shows spinner and "Processing..." text
- Cancel button is disabled
- User cannot close modal

After success:
- Success alert shows for 1.5 seconds
- Then modal closes
- Then navigation/refresh occurs

### Error Handling

**Display Hierarchy**:
1. RPC `message` field (from `success: false` response)
2. `ErrorService.parseToHuman()` for HTTP errors
3. Generic "An unexpected error occurred"

## Testing Strategy

### Unit Tests

**condition-evaluator.spec.ts**:
- Test all operators (eq, ne, gt, lt, in, is_null, etc.)
- Test undefined conditions (should return true)
- Test invalid operators (should return false)
- Test edge cases (null values, empty arrays)

**detail.page.spec.ts** (add tests):
- `isActionDisabled()` with various conditions
- `confirmAction()` success path
- `confirmAction()` error path
- RPC return value overrides metadata defaults

### Integration Tests

**E2E Test** (`e2e/entity-actions.spec.ts`):
```typescript
describe('Entity Actions', () => {
  it('should show action buttons with correct permissions', async () => {
    await loginAsRole('editor');
    await navigateTo('/detail/issues/1');
    await expect(page.getByRole('button', { name: 'Approve Fix' })).toBeVisible();
  });

  it('should disable button when condition not met', async () => {
    await navigateTo('/detail/issues/1'); // Approved issue
    await expect(page.getByRole('button', { name: 'Approve Fix' })).toBeDisabled();
  });

  it('should execute action and refresh data', async () => {
    await page.getByRole('button', { name: 'Approve Fix' }).click();
    await page.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.getByText('approved successfully')).toBeVisible();
    // Wait for modal to close and refresh
    await expect(page.getByText('Status: approved')).toBeVisible();
  });
});
```

### Manual Testing Checklist

- [ ] Button appears on Detail page for configured entity
- [ ] Button is hidden when user lacks permission
- [ ] Button is hidden when visibility condition fails
- [ ] Button is disabled when disabled condition passes
- [ ] Disabled tooltip shows on hover
- [ ] Confirmation modal displays correct message
- [ ] RPC executes with correct entity ID
- [ ] Success message displays (RPC override > metadata > default)
- [ ] Data refreshes after action (if configured)
- [ ] Navigation occurs after action (if configured)
- [ ] Error messages display for failed actions
- [ ] Loading spinner shows during execution
- [ ] Modal cannot be closed during execution

## Future Enhancements

### Phase 2: Bulk Actions

- Add `show_on_list` support
- Multi-select checkboxes on List page
- Pass array of IDs to RPC: `p_entity_ids BIGINT[]`
- Progress indicator for bulk operations
- Partial success handling (some succeed, some fail)

### Phase 3: Parameters

- Add `parameter_schema` JSONB to metadata
- Generate dynamic form in modal
- Support common types: text, number, dropdown, date
- Validation for required parameters
- Pass parameters to RPC alongside entity ID

### Phase 4: Advanced Conditions

- Support compound conditions (AND/OR)
- Reference related entity fields (e.g., `"field": "user.role"`)
- Computed conditions (call RPC to determine visibility)

### Phase 5: Workflow Integration

- Integrate with Status Type system
- Auto-generate actions from `metadata.status_transitions`
- Enforce workflow state machine
- Audit trail for action execution

## Related Documentation

- **RLS & Permissions**: `docs/AUTHENTICATION.md`
- **Metadata System**: `CLAUDE.md` sections on Property Types and Metadata Views
- **Testing Guidelines**: `docs/development/TESTING.md`
- **Status Type System**: `docs/development/STATUS_TYPE_SYSTEM.md`
- **PostgREST RPC Docs**: https://postgrest.org/en/stable/references/api/functions.html

## Questions & Decisions

**Q: Should we support actions without confirmation modals?**
A: Yes, set `requires_confirmation = false` to execute immediately on click. Use for low-risk actions like "Mark as Read".

**Q: Can one RPC be used for multiple actions?**
A: Yes, but generally better to have separate functions for clarity and permissions. Could pass `action_name` as parameter if needed.

**Q: How to handle long-running actions (e.g., generating reports)?**
A: Phase 2 - implement background jobs. RPC returns job ID, UI polls for completion. Show progress bar in modal.

**Q: Should actions support file uploads or complex inputs?**
A: Phase 3 - add `parameter_schema` for input fields. For now, create separate page for complex workflows.

**Q: Can actions create related records?**
A: Yes! RPC can INSERT into related tables. Consider returning new record ID in response.data and navigating to it.

## Implementation Checklist

When implementing this feature:

- [ ] Create Sqitch migration (deploy, revert, verify)
- [ ] Add TypeScript interfaces to `src/app/interfaces/entity.ts`
- [ ] Create `src/app/utils/condition-evaluator.ts` with tests
- [ ] Update `DataService.executeRpc()`
- [ ] Update `SchemaService.getEntityActions()`
- [ ] Update `DetailPage` component (TS + template)
- [ ] Create example in pothole domain
- [ ] Test with different roles and entity states
- [ ] Update `CLAUDE.md` with Entity Actions section
- [ ] Add entry to `docs/ROADMAP.md`

---

**Status**: Ready for implementation when approved.