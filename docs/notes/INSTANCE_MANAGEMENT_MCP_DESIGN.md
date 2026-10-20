# Instance Management MCP: Structured Operations for Civic OS

> **Status**: Design (not scheduled)
> **Supersedes**: None (complements, does not replace, the data MCP server)
> **Depends on**: Deterministic Schema SDK for Layer 3 operations
> **Related**: `DETERMINISTIC_SCHEMA_SDK_DESIGN.md`, `MCP_SERVER_DESIGN.md`, `LLM_SCHEMA_ASSISTANT_DESIGN.md`

## Overview

A structured MCP interface for managing Civic OS instances — configuring metadata, modifying schema, and creating logic — that enforces correct patterns instead of allowing freeform SQL. The calling LLM agent provides intent and parameters; the tool ensures the correctness envelope (boilerplate, grants, indexes, ADRs, validation).

**Core principle**: The MCP server is a structured execution environment, not an AI system. It has no LLM. The agent on the other side of the MCP protocol is already an LLM — it provides custom logic as parameters when needed, and the tool wraps it in the correct scaffolding.

**Competing approach to the Schema Assistant**: Where the Schema Assistant generates complete SQL from natural language prompts, this interface exposes discrete, validated operations. The agent composes operations explicitly rather than delegating to an intermediate LLM layer. This produces more predictable results at the cost of requiring the agent to understand the operation vocabulary.

## Layer Model

Operations fall into five layers by risk and reversibility:

| Layer | Scope | Risk | Reversibility | Status |
|-------|-------|------|---------------|--------|
| **1 — Data** | CRUD on instance data | Low | Full (update/delete) | Shipped (existing MCP server) |
| **2 — Config** | Runtime metadata configuration | Low | Full (all metadata is updatable) | **Design ready, no SDK dependency** |
| **3 — Schema** | Table/column DDL | Medium | Revert scripts | **Blocked on SDK** |
| **4 — Logic** | Functions, triggers, RLS, VIEWs | High | Revert scripts | **Blocked on SDK (scaffolding); agent provides body** |
| **5 — Ops** | Cluster/DBA operations | N/A | Out of scope | Excluded |

## Schema-Aware Validation

All Layer 2–4 tools validate inputs against a live schema cache before execution. The cache extends the existing `SchemaCache` with the data sources listed in the Read Context section below.

**Validation contract**: Every tool returns a structured error with `field`, `expected`, and `got` when validation fails — the agent can correct and retry without guessing what went wrong.

```
Error: {
  code: "VALIDATION_FAILED",
  field: "column_name",
  expected: "column exists on table 'reservations'",
  got: "no column 'staus_id' — did you mean 'status_id'?"
}
```

Fuzzy matching on table/column names catches common LLM misspellings before they reach the database.

## Read Context: What the Agent Needs to Author Correct Logic

The write tools (Layers 2–4) are only as good as the read context the calling agent has. An LLM writing PL/pgSQL needs to understand the full instance shape — not just table/column names, but what functions already exist, what triggers fire, what access policies are in place, and what notification side effects are configured.

**Principle**: Every piece of instance context that a human developer would consult before writing SQL must be readable through the MCP interface. If the agent can't see it, it will guess — and guesses in DDL are expensive.

### Current Read Coverage (existing MCP server)

The existing data MCP server provides these read tools:

| Tool | What it exposes | Source |
|------|----------------|--------|
| `list_entities` | Entity names, display names, feature flags, read/create/edit permissions (delete is not shown) | `schema_entities` view |
| `describe_entity` | Properties (name, type label, visibility flags), status values, category values, action names with descriptions and parameter names (full definitions and conditions come from `list_actions`) | `schema_properties`, `statuses`, `categories`, `schema_entity_actions` views |
| `get_status_workflow` | Status values with is_initial/is_terminal + enabled transitions (with transition label and on-transition RPC) | `statuses` view + `rpc/get_status_transitions_for_entity` (called per request) |
| `list_actions` | Entity actions with params and conditions | `schema_entity_actions` view |
| `list_records` / `get_record` / `search` | Instance data | PostgREST queries |
| `civicos://schema/overview` (resource) | Schema summary (entities with their first property names) | `schema_entities`, `schema_properties` |
| `civicos://entity/{name}` (resource) | Entity detail | `schema_properties` |

### Gap Analysis

#### Tier 1: Fetched by the schema cache but not rendered to the agent

The `SchemaCache` already fetches full `SchemaProperty` objects, but `describe_entity` only renders a subset. These fields are silently dropped:

| Field | Why the agent needs it |
|-------|----------------------|
| `data_type` / `udt_name` (raw PostgreSQL type) | Write correct INSERT/UPDATE statements, DECLARE variables with matching types |
| `column_default` | Know what auto-populates; avoid setting values that conflict with defaults |
| `is_nullable` | Write NOT NULL guards in trigger logic; know which columns can be omitted |
| `is_generated` | Avoid writing to computed columns (causes PostgreSQL errors) |
| `is_updatable` | Know which VIEW columns accept writes |
| `validation_rules` (JSONB content) | Understand existing validation before adding constraints |
| `options_source_rpc` | Know filtering RPCs for FK dropdowns |
| `depends_on_columns` | Understand cascading dropdown chains |

**Resolution**: Extend `describe_entity` output to include these fields when a `detail_level: "full"` parameter is provided (or add a dedicated `describe_entity_schema` tool). No new data fetching required — just render what's already cached.

#### Tier 2: Exists in PostgREST views, not fetched by the MCP server

These views are GRANTed and served by PostgREST but the MCP server has no tool that reads them:

| View | What it provides | Why the agent needs it | Impact |
|------|-----------------|----------------------|--------|
| **`schema_functions`** | Registered RPCs: function_name, parameters (names + types), return type, description, entity_effects, can_execute | Know what helper functions exist before writing logic that duplicates them or needs to call them. Without this, the agent cannot discover `get_users_with_role()`, `get_current_staff_member_id()`, or any instance-specific helper. | **Critical for Layer 4** |
| **`schema_triggers`** | Registered triggers: timing, events, function_name, description, purpose, entity_effects | Avoid double-triggering (e.g., writing a denormalization trigger when one already fires). Understand what side effects a table change already produces. | **Critical for Layer 4** |
| **`schema_entity_dependencies`** | Structural (FK, M:M) and behavioral (rpc_modifies, trigger_modifies) dependency graph | Write correct cascade logic. Understand which RPCs modify which tables. The FK graph alone is inferrable from `describe_entity`, but behavioral dependencies are not. | **High for Layer 4** |
| **`schema_notifications`** | Notification trigger config: trigger_condition, recipient_description, template subject/name, linked entity | Avoid emitting duplicate notifications. Know what notification templates are available and what variables they expect. | **High for Layer 4** |
| **`schema_permissions_matrix`** | Per-entity, per-role CRUD permission flags | Write RLS policies that align with the RBAC model. Without this, the agent cannot verify whether `has_permission('entity', 'read')` is actually granted to the intended roles. | **Moderate for Layer 4** |

**Resolution**: Add new read tools to the management MCP interface:

- **`list_functions`** — Fetch from `schema_functions`. Return function name, parameters, return type, description, associated entities.
- **`list_triggers`** — Fetch from `schema_triggers`. Return trigger name, table, timing, events, function_name, description.
- **`list_dependencies`** — Fetch from `schema_entity_dependencies`. Return dependency graph for a given entity (or full graph).
- **`list_notification_config`** — Fetch from `schema_notifications`. Return configured notification triggers per entity.
- **`get_permissions_matrix`** — Fetch from `schema_permissions_matrix`. Return role×entity CRUD grid.

These views already exist and are served by PostgREST. The tools are thin wrappers — moderate implementation effort.

#### Tier 3: Not exposed in any PostgREST view — needs new views over `pg_catalog`

This data exists in PostgreSQL system catalogs but no PostgREST view surfaces it:

| Data | System catalog source | Why the agent needs it | Impact |
|------|----------------------|----------------------|--------|
| **Existing RLS policy text** | `pg_policies` | Understand current access patterns before adding custom policies. Without this, the agent creates policies that may conflict with or duplicate existing ones. | **High for Layer 4** (specifically `create_rls_policy`) |
| **CHECK constraint SQL expressions** | `pg_constraint` | Know what validation already exists at the DB level. `constraint_messages` names constraints but does not expose the actual CHECK expression. | **Moderate for Layers 3–4** |
| **Index definitions** | `pg_indexes` | Avoid duplicate indexes. Know what's already indexed for query planning in VIEW/RPC logic. | **Moderate for Layer 3** (the validator needs this to prevent duplicates) |
| **Unregistered triggers** | `pg_trigger` + `pg_proc` | `schema_triggers` is opt-in (requires `auto_register_function()`). Triggers created by init scripts that skip registration are invisible. | **Moderate for Layer 4** |

**Resolution**: Create new views in a future migration:

```
-- Proposed views (exact DDL deferred to implementation)
public.schema_rls_policies    → wraps pg_policies for public schema tables
public.schema_check_constraints → wraps pg_constraint (type = 'c') with expression text
public.schema_indexes         → wraps pg_indexes for public schema tables
public.schema_all_triggers    → wraps pg_trigger + pg_proc (superset of schema_triggers)
```

These require a Sqitch migration to create the views and GRANT SELECT. Highest effort of the three tiers, but addressable incrementally — each view is independent.

### Read Context by Layer

| Layer | Tier 1 (render cached) | Tier 2 (add tools) | Tier 3 (new views) |
|-------|----------------------|-------------------|-------------------|
| **2 — Config** | Not needed | Not needed | Not needed |
| **3 — Schema** | **Required** (types, nullability, defaults for validation) | Helpful (dependencies) | Helpful (indexes, constraints for duplicate prevention) |
| **4 — Logic** | **Required** (types for DECLARE, defaults for logic) | **Required** (functions, triggers, notifications, permissions) | **Strongly recommended** (RLS policies, unregistered triggers) |

**Implication for build order**: Layer 2 can ship with zero read changes. Layer 3 needs only Tier 1 (trivial). Layer 4 needs Tiers 1 + 2 (moderate) and benefits significantly from Tier 3 (migration work). The read tools should ship *before* or *alongside* their corresponding write layer.

---

## ADR Integration

**Layer 3 and 4**: Every tool call that modifies schema automatically creates a schema decision record via `create_schema_decision()`. The ADR captures:
- `entity_types`: affected entities (from tool parameters)
- `property_names`: affected columns (from tool parameters)
- `title`: auto-generated from tool name + parameters (e.g., "Add column 'phone' to 'clients'")
- `decision`: structured description of what was done
- `context`: the full parameter set as JSONB (reproducible)
- `rationale`: **required parameter** on every Layer 3/4 tool — the agent must explain *why*

**Layer 2**: ADR creation is optional. Tools accept an optional `rationale` parameter; when provided, an ADR is created. When omitted, the change is made without an ADR (matching current admin UI behavior).

---

## Layer 2: Config Tools — Complete Interface Catalog

These tools configure runtime behavior via existing RPCs and `metadata.*` tables. No DDL. All changes are immediately effective after `NOTIFY pgrst, 'reload schema'` (issued automatically by each tool).

### Entity Metadata

#### `configure_entity`

Set display properties and feature flags for an entity.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `entity` | string | yes | Table name |
| `display_name` | string | no | Custom display name |
| `description` | string | no | Entity description |
| `icon` | string | no | Icon name |
| `sort_order` | integer | no | Sidebar position |
| `show_in_sidebar` | boolean | no | Sidebar visibility |
| `entity_group` | string | no | Sidebar group heading |
| `show_calendar` | boolean | no | Enable calendar view |
| `calendar_property_name` | string | no | TimeSlot column for calendar |
| `calendar_color_property` | string | no | Column providing event color |
| `supports_recurring` | boolean | no | Enable recurring schedules |
| `recurring_property_name` | string | no | TimeSlot column for recurrence |
| `show_map` | boolean | no | Enable map view |
| `map_property_name` | string | no | GeoPoint column for map |
| `fulltext_search_column` | string | no | tsvector column name |
| `substring_search_column` | string | no | Trigram search column name |
| `default_sort_column` | string | no | Default list sort column |
| `default_sort_direction` | string | no | `asc` or `desc` |
| `rationale` | string | no | If provided, creates an ADR |

**Validates**: entity exists; referenced columns exist and are correct types (TimeSlot for calendar, GeoPoint for map, tsvector for fulltext_search).

#### `configure_property`

Set display and behavior properties for a column.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `entity` | string | yes | Table name |
| `column` | string | yes | Column name |
| `display_name` | string | no | Custom display name |
| `description` | string | no | Property description |
| `sort_order` | integer | no | Display position |
| `column_width` | integer | no | 1 (half) or 2 (full) |
| `show_on_list` | boolean | no | Show in list view |
| `show_on_create` | boolean | no | Show on create form |
| `show_on_edit` | boolean | no | Show on edit form |
| `show_on_detail` | boolean | no | Show on detail page |
| `sortable` | boolean | no | Allow list sorting |
| `filterable` | boolean | no | Allow list filtering |

**Validates**: entity and column exist.

#### `reorder_entities`

Set sort_order for multiple entities at once.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `order` | array of `{entity, sort_order}` | yes | New ordering |

**Validates**: all entities exist.

#### `reorder_properties`

Set sort_order for properties and static text blocks within an entity.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `entity` | string | yes | Table name |
| `order` | array of `{column, sort_order}` | yes | New ordering |

**Validates**: entity exists; all columns exist on entity.

### Status System

#### `create_status_type`

Register a new status entity_type.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `entity_type` | string | yes | Status group identifier |
| `display_name` | string | yes | Human-readable name |
| `description` | string | no | Description |

**Validates**: entity_type not already registered.

#### `upsert_status`

Create or update a status value.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `entity_type` | string | yes | Status group |
| `status_key` | string | yes | Programmatic key |
| `display_name` | string | yes | Human-readable name |
| `description` | string | no | Description |
| `color` | string | yes | Hex color (e.g., `#3B82F6`) |
| `sort_order` | integer | yes | Display position |
| `is_initial` | boolean | no | Default: false |
| `is_terminal` | boolean | no | Default: false |

**Validates**: entity_type exists; color is valid hex; at most one is_initial per entity_type.

#### `delete_status`

Remove a status value.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `entity_type` | string | yes | Status group |
| `status_key` | string | yes | Status to remove |

**Validates**: status exists; no records reference this status_id (or returns error with count).

#### `set_status_transition`

Create or update an allowed status transition.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `entity_type` | string | yes | Status group |
| `from_status_key` | string | yes | Source status |
| `to_status_key` | string | yes | Target status |
| `display_name` | string | no | Transition label |
| `description` | string | no | Transition description |
| `on_transition_rpc` | string | no | RPC to call on transition |
| `sort_order` | integer | no | Display position |
| `is_enabled` | boolean | no | Default: true |

**Validates**: entity_type and both status_keys exist; on_transition_rpc exists if provided.

#### `delete_status_transition`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `entity_type` | string | yes | Status group |
| `from_status_key` | string | yes | Source status |
| `to_status_key` | string | yes | Target status |

#### `delete_status_type`

Remove an entire status group and all its values.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `entity_type` | string | yes | Status group to remove |

**Validates**: no records reference any status_id in this group.

### Category System

#### `create_category_group`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `entity_type` | string | yes | Category group identifier |
| `display_name` | string | yes | Human-readable name |
| `description` | string | no | Description |

#### `upsert_category`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `entity_type` | string | yes | Category group |
| `category_key` | string | yes | Programmatic key |
| `display_name` | string | yes | Human-readable name |
| `description` | string | no | Description |
| `color` | string | yes | Hex color |
| `sort_order` | integer | yes | Display position |

#### `delete_category`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `entity_type` | string | yes | Category group |
| `category_key` | string | yes | Category to remove |

**Validates**: no records reference this category_id.

#### `delete_category_group`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `entity_type` | string | yes | Group to remove |

**Validates**: no records reference any category_id in this group.

### RBAC & Permissions

#### `create_role`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `role_key` | string | yes | Programmatic key |
| `display_name` | string | yes | Human-readable name |
| `description` | string | no | Description |

**Validates**: role_key not already registered.

#### `delete_role`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `role_key` | string | yes | Role to remove |

**Validates**: role is not a default role (anonymous, user, editor, manager, admin); returns affected user count for confirmation.

#### `set_permission`

Toggle a CRUD permission for a role on an entity.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `role_key` | string | yes | Target role |
| `entity` | string | yes | Table name (or `entity:notes` for note permissions) |
| `permission` | string | yes | `read`, `create`, `update`, or `delete` |
| `granted` | boolean | yes | true to grant, false to revoke |

**Validates**: role exists; entity exists (or is a valid `:notes` namespace).

#### `set_action_permission`

Toggle which roles can execute an entity action.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `entity` | string | yes | Table name |
| `action_name` | string | yes | Action identifier |
| `role_key` | string | yes | Target role |
| `granted` | boolean | yes | true to grant, false to revoke |

**Validates**: entity, action, and role all exist.

#### `set_role_delegation`

Configure which roles can assign/revoke which other roles.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `manager_role_key` | string | yes | Role that can manage |
| `managed_role_key` | string | yes | Role being managed |
| `allowed` | boolean | yes | true to allow, false to revoke |

**Validates**: both roles exist; managed_role is not `anonymous`.

### User Provisioning

#### `provision_user`

Create a new user in Keycloak and the database.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `email` | string | yes | User email |
| `first_name` | string | yes | First name |
| `last_name` | string | yes | Last name |
| `phone` | string | no | Phone number |
| `roles` | string[] | no | Initial role_keys to assign |
| `send_welcome_email` | boolean | no | Default: false |
| `send_welcome_sms` | boolean | no | Default: false |

#### `assign_user_role`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `user` | string | yes | User email or display name (resolved) |
| `role_key` | string | yes | Role to assign |

**Validates**: user exists; role exists; caller has delegation authority.

#### `revoke_user_role`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `user` | string | yes | User email or display name |
| `role_key` | string | yes | Role to revoke |

### Entity Actions

#### `register_action`

Register an entity action button.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `entity` | string | yes | Table name |
| `action_name` | string | yes | Programmatic identifier |
| `display_name` | string | yes | Button label |
| `description` | string | no | Tooltip text |
| `rpc_function` | string | yes | PostgreSQL function to call |
| `icon` | string | no | Icon name |
| `button_style` | string | no | DaisyUI style (primary, warning, error, etc.) |
| `sort_order` | integer | no | Button position |
| `requires_confirmation` | boolean | no | Show confirmation dialog |
| `confirmation_message` | string | no | Dialog message |
| `visibility_condition` | object | no | When to show the button |
| `enabled_condition` | object | no | When the button is clickable |
| `disabled_tooltip` | string | no | Tooltip when disabled |
| `default_success_message` | string | no | Toast on success |
| `refresh_after_action` | boolean | no | Reload page after action |
| `roles` | string[] | no | Role keys that can execute |

**Validates**: entity exists; rpc_function exists; condition fields reference valid columns; dot-notation conditions (e.g., `status_id.status_key`) resolve correctly.

#### `register_action_param`

Add a parameter to an entity action.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `entity` | string | yes | Table name |
| `action_name` | string | yes | Parent action |
| `param_name` | string | yes | Parameter identifier |
| `display_name` | string | yes | Form label |
| `param_type` | string | yes | `text`, `file`, `foreign_key`, `category`, `date`, `photo_gallery` |
| `required` | boolean | no | Default: false |
| `sort_order` | integer | no | Form position |
| `placeholder` | string | no | Placeholder text |
| `category_entity_type` | string | no | For `category` type: which group |
| `foreign_key_table` | string | no | For `foreign_key` type: target table |
| `file_type` | string | no | For `file` type: `image`, `pdf`, `any` |
| `options_source_rpc` | string | no | For `foreign_key` type: filtering RPC |

**Validates**: action exists on entity; param_type-specific fields are provided (e.g., `category_entity_type` required when `param_type = 'category'`); referenced RPCs/tables/groups exist.

#### `delete_action`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `entity` | string | yes | Table name |
| `action_name` | string | yes | Action to remove |

### Validation Rules

#### `add_validation`

Add a frontend validation rule.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `entity` | string | yes | Table name |
| `column` | string | yes | Column name |
| `rule` | string | yes | `required`, `min_length`, `max_length`, `min`, `max`, `pattern`, `email` |
| `value` | string | yes | Rule parameter |
| `message` | string | yes | Error message |

**Validates**: entity and column exist; rule is a known type.

#### `remove_validation`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `entity` | string | yes | Table name |
| `column` | string | yes | Column name |
| `rule` | string | yes | Rule type to remove |

#### `set_constraint_message`

Map a database constraint name to a friendly error message.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `constraint_name` | string | yes | PostgreSQL constraint name |
| `entity` | string | yes | Table name |
| `column` | string | no | Column name |
| `message` | string | yes | Human-readable error |

### Dashboards & Widgets

#### `create_dashboard`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `display_name` | string | yes | Dashboard title |
| `description` | string | no | Description |
| `sort_order` | integer | no | Dashboard selector position |

#### `update_dashboard`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `dashboard` | string | yes | Dashboard name (resolved) |
| `display_name` | string | no | New title |
| `description` | string | no | New description |
| `sort_order` | integer | no | New position |

#### `delete_dashboard`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `dashboard` | string | yes | Dashboard name |

#### `add_widget`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `dashboard` | string | yes | Dashboard name |
| `widget_type` | string | yes | `count`, `list`, `map`, `calendar`, `chart`, `markdown`, `heading` |
| `title` | string | yes | Widget title |
| `config` | object | yes | Type-specific configuration |
| `sort_order` | integer | yes | Position |
| `column_span` | integer | no | Grid columns (1–4, default 1) |
| `row_span` | integer | no | Grid rows (default 1) |

**Validates**: dashboard exists; widget_type is known; config fields validated per widget type (e.g., `table_name` exists, `filter` column references valid).

#### `update_widget`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `dashboard` | string | yes | Dashboard name |
| `widget_title` | string | yes | Widget to update (resolved by title + dashboard) |
| `title` | string | no | New title |
| `config` | object | no | New config (merged) |
| `sort_order` | integer | no | New position |
| `column_span` | integer | no | New column span |
| `row_span` | integer | no | New row span |

#### `delete_widget`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `dashboard` | string | yes | Dashboard name |
| `widget_title` | string | yes | Widget to remove |

### Static Text Blocks

#### `add_static_text`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `entity` | string | yes | Table name |
| `display_name` | string | yes | Block identifier |
| `content` | string | yes | Markdown content |
| `sort_order` | integer | yes | Position among properties |
| `column_width` | integer | no | 1 or 2 (default 2) |
| `show_on_create` | boolean | no | Default: false |
| `show_on_edit` | boolean | no | Default: false |
| `show_on_detail` | boolean | no | Default: true |

#### `update_static_text`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `entity` | string | yes | Table name |
| `display_name` | string | yes | Block to update |
| `content` | string | no | New markdown |
| `sort_order` | integer | no | New position |
| `column_width` | integer | no | New width |
| `show_on_create` | boolean | no | |
| `show_on_edit` | boolean | no | |
| `show_on_detail` | boolean | no | |

#### `delete_static_text`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `entity` | string | yes | Table name |
| `display_name` | string | yes | Block to remove |

### Notification Templates

#### `create_notification_template`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | yes | Template identifier |
| `description` | string | no | Description |
| `channel` | string | yes | `email`, `sms`, or `both` |
| `subject` | string | no | Email subject (supports `{{var}}` interpolation) |
| `body` | string | yes | Template body (supports `{{var}}` interpolation) |
| `entity_type` | string | no | Associated entity |
| `is_bulk` | boolean | no | Bulk email template |

#### `update_notification_template`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | yes | Template to update |
| `channel` | string | no | New channel |
| `subject` | string | no | New subject |
| `body` | string | no | New body |

#### `delete_notification_template`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | yes | Template to remove |

### Translations

#### `set_translation`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `source_type` | string | yes | `entity`, `property`, `status`, `category`, `action`, `action_param`, `dashboard`, `widget_config`, `ui`, `guided_form_step`, `static_text` |
| `source_key` | string | yes | Dot-notation key (e.g., `clients.first_name.display_name`) |
| `locale` | string | yes | Language code (e.g., `es`, `ar`) |
| `translated_text` | string | yes | Translation |

**Validates**: source_type is known; source_key resolves to a real entity/property/status/etc.

#### `delete_translation`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `source_type` | string | yes | |
| `source_key` | string | yes | |
| `locale` | string | yes | |

#### `bulk_set_translations`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `translations` | array of `{source_type, source_key, locale, translated_text}` | yes | Batch upsert |

#### `list_missing_translations`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `locale` | string | yes | Target language |
| `source_type` | string | no | Filter by type |

**Returns**: list of untranslated source keys for the locale.

### Feature Enablement

#### `enable_entity_notes`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `entity` | string | yes | Table name |

**Side effects**: creates permissions, grants to default roles. Wraps existing `enable_entity_notes()` RPC.

#### `register_user_profile_extension`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `entity` | string | yes | Table name |
| `display_name` | string | yes | Section heading on profile page |
| `description` | string | no | Help text |
| `user_fk_column` | string | yes | Column referencing civic_os_users |
| `sort_order` | integer | no | Section position |
| `is_required` | boolean | no | Block navigation until completed |
| `exempt_roles` | string[] | no | Role keys exempt from completion requirement |

**Validates**: entity exists; user_fk_column exists and is a UUID FK to civic_os_users.

#### `register_scheduled_job`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | yes | Job identifier |
| `schedule` | string | yes | Cron expression |
| `function_name` | string | yes | PostgreSQL function to call |
| `enabled` | boolean | no | Default: true |

**Validates**: function_name exists; schedule is valid cron syntax.

#### `register_guided_form_step`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `entity` | string | yes | Table name (must have `guided_form_key`) |
| `step_key` | string | yes | Step identifier |
| `display_name` | string | yes | Step heading |
| `sort_order` | integer | yes | Step position |
| `properties` | string[] | yes | Column names included in this step |
| `skip_condition` | object | no | Condition to skip this step |
| `require_condition` | object | no | Condition to require this step |

**Validates**: entity has guided_form_key; all properties exist on entity.

### Introspection

#### `register_function`

Register a function for the System Functions introspection page.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `function_name` | string | yes | PostgreSQL function name |
| `description` | string | yes | What it does |
| `entity_types` | string[] | no | Associated entities |

**Validates**: function exists.

---

## Layer 3: Schema Tools — Interface Catalog

These tools perform DDL operations. Each generates SQL, validates it against the schema cache, creates an ADR, and executes it. The `rationale` parameter is **required** on all Layer 3 tools.

> **SDK dependency**: These tools wrap the Deterministic Schema SDK. The interfaces below define what the MCP tool exposes; the SDK handles SQL generation and revert script creation.

### `create_entity`

Create a complete entity with all required boilerplate.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | yes | Table name (snake_case) |
| `display_name` | string | yes | Human-readable name |
| `description` | string | no | Entity description |
| `columns` | array | yes | Column definitions (see below) |
| `access` | string | yes | `public_read` (web_anon SELECT) or `authenticated_only` |
| `rationale` | string | yes | Why this entity exists |

**Column definition**:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Column name |
| `type` | string | yes | See supported types below |
| `nullable` | boolean | no | Default: true |
| `default` | string | no | SQL default expression |
| `display_name` | string | no | Custom display name |

**Supported column types**: `text`, `integer`, `bigint`, `boolean`, `date`, `timestamp`, `timestamptz`, `money`, `email_address`, `phone_number`, `hex_color`, `uuid`, `jsonb`

**Auto-generated by the tool** (not specified by caller):
- `id BIGINT GENERATED BY DEFAULT AS IDENTITY` + primary key
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated_at TIMESTAMPTZ`
- `display_name TEXT` (unless caller provides a computed display_name)
- Timestamp triggers (`set_created_at`, `set_updated_at`)
- FK indexes on all FK columns
- Standard RLS (4 policies: web_anon/authenticated SELECT, authenticated INSERT/UPDATE with `has_permission()`)
- GRANTs (SELECT to both roles, INSERT/UPDATE/DELETE to authenticated)
- Sequence USAGE grant
- RBAC permission rows (read to all roles, CUD to editor+manager+admin)
- Entity metadata row
- Property metadata rows
- `NOTIFY pgrst, 'reload schema'`
- ADR

### `add_column`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `entity` | string | yes | Table name |
| `name` | string | yes | Column name |
| `type` | string | yes | Column type |
| `nullable` | boolean | no | Default: true |
| `default` | string | no | SQL default expression |
| `display_name` | string | no | Custom display name |
| `rationale` | string | yes | Why this column is needed |

**Auto-generated**: property metadata row, FK index (if type implies FK).

### `remove_column`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `entity` | string | yes | Table name |
| `column` | string | yes | Column name |
| `rationale` | string | yes | Why this column is being removed |

**Validates**: column exists; column is not `id`, `created_at`, `updated_at`, or `display_name` (framework columns). Warns if column has non-null data.

### `add_status_column`

Add a status_id FK column to an entity and register the status type.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `entity` | string | yes | Table name |
| `entity_type` | string | yes | Status group identifier |
| `statuses` | array of `{key, display_name, color, is_initial?, is_terminal?}` | yes | Initial status values |
| `transitions` | array of `{from_key, to_key, display_name?}` | no | Allowed transitions |
| `rationale` | string | yes | |

**Auto-generated**: column with `DEFAULT get_initial_status(entity_type)`, FK to `metadata.statuses`, index, status_type registration, status value rows, transition rows, metadata update.

### `add_category_column`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `entity` | string | yes | Table name |
| `column_name` | string | yes | Column name (e.g., `priority_id`) |
| `entity_type` | string | yes | Category group identifier |
| `categories` | array of `{key, display_name, color}` | yes | Initial values |
| `rationale` | string | yes | |

### `add_fk_relationship`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `entity` | string | yes | Table with the FK column |
| `column_name` | string | yes | FK column name |
| `references_entity` | string | yes | Target table |
| `on_delete` | string | no | `restrict` (default), `cascade`, `set_null` |
| `nullable` | boolean | no | Default: true |
| `rationale` | string | yes | |

**Auto-generated**: column (if not exists), FK constraint (NOT VALID + VALIDATE), index, property metadata.

### `add_m2m_relationship`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `entity_a` | string | yes | First entity |
| `entity_b` | string | yes | Second entity |
| `junction_name` | string | no | Custom junction table name (default: `{a}_{b}`) |
| `extra_columns` | array | no | Additional payload columns (rich junction) |
| `rationale` | string | yes | |

**Auto-generated**: junction table with composite PK (or serial PK + UNIQUE for rich junctions), FK constraints, indexes on both FK columns, grants (SELECT + INSERT + DELETE), RLS, permission rows, metadata.

### `add_computed_column`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `entity` | string | yes | Table name |
| `column_name` | string | yes | Column name |
| `expression` | string | yes | SQL expression for `GENERATED ALWAYS AS (...) STORED` |
| `type` | string | yes | Result type (e.g., `text`, `tsvector`) |
| `rationale` | string | yes | |

**Validates**: expression references only columns that exist on the entity.

### `add_geography_column`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `entity` | string | yes | Table name |
| `column_name` | string | yes | Column name |
| `geo_type` | string | yes | `point` or `polygon` |
| `rationale` | string | yes | |

**Auto-generated**: geography column, `_text` computed companion (`ST_AsText()`), companion function with grants.

### `add_photo_gallery_column`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `entity` | string | yes | Table name |
| `column_name` | string | yes | Column name |
| `max_images` | integer | no | Per-record limit |
| `rationale` | string | yes | |

**Auto-generated**: UUID FK to `metadata.photo_galleries`, index, gallery config row.

### `add_file_column`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `entity` | string | yes | Table name |
| `column_name` | string | yes | Column name |
| `file_type` | string | yes | `image`, `pdf`, `any` |
| `rationale` | string | yes | |

### `configure_text_search`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `entity` | string | yes | Table name |
| `mode` | string | yes | `fulltext`, `substring`, `hybrid` |
| `fulltext_columns` | string[] | no | Columns for tsvector (required if mode includes fulltext) |
| `substring_column` | string | no | Column for trigram (required if mode includes substring) |
| `rationale` | string | yes | |

**Auto-generated**: tsvector computed column + GIN index (fulltext), GIN trigram index (substring), entity metadata updates.

### `add_index`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `entity` | string | yes | Table name |
| `columns` | string[] | yes | Column(s) to index |
| `type` | string | no | `btree` (default), `gin`, `gist` |
| `unique` | boolean | no | Default: false |
| `name` | string | no | Custom index name |
| `rationale` | string | yes | |

### `add_check_constraint`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `entity` | string | yes | Table name |
| `name` | string | yes | Constraint name |
| `expression` | string | yes | SQL CHECK expression |
| `error_message` | string | no | Friendly error (creates constraint_message row) |
| `rationale` | string | yes | |

**Validates**: expression references only columns that exist on the entity.

### `add_unique_constraint`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `entity` | string | yes | Table name |
| `columns` | string[] | yes | Columns in the unique constraint |
| `name` | string | no | Custom constraint name |
| `error_message` | string | no | Friendly error |
| `rationale` | string | yes | |

### `add_exclusion_constraint`

Add a GIST exclusion constraint (time slot overlap prevention).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `entity` | string | yes | Table name |
| `range_column` | string | yes | tstzrange column or expression |
| `equality_columns` | string[] | yes | Columns that must match (e.g., `room_id`) |
| `exclude_status_key` | string | no | Status key to exclude (e.g., `cancelled`) |
| `name` | string | no | Custom constraint name |
| `error_message` | string | no | Friendly error |
| `rationale` | string | yes | |

### `drop_entity`

Remove an entity and all associated metadata.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `entity` | string | yes | Table name |
| `rationale` | string | yes | Why this entity is being removed |

**Validates**: no other entities have FK references to this table. Warns if table has data (returns row count).

**Auto-generated**: drops table, removes metadata rows (entity, properties, static text, validations, constraint messages, permissions, permission_roles, entity_actions, action_params, action_roles, dashboard widgets referencing the entity), ADR.

---

## Layer 4: Logic Tools — Interface Catalog

These tools accept **agent-provided PL/pgSQL** as a parameter. The tool provides the scaffolding; the agent provides the logic body. The `rationale` parameter is **required** on all Layer 4 tools.

> **SDK dependency**: These tools use the SDK for scaffolding generation (function signature, SECURITY DEFINER pattern, grants, introspection registration). The logic body is opaque to the SDK.

### `create_workflow_rpc`

Create a SECURITY DEFINER workflow function (for entity actions).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `function_name` | string | yes | Function name |
| `entity` | string | yes | Primary entity |
| `parameters` | array of `{name, type}` | yes | Must include `p_entity_id` |
| `body` | string | yes | PL/pgSQL function body (between BEGIN...END) |
| `description` | string | yes | What the function does |
| `returns` | string | no | Return type (default: `jsonb`) |
| `rationale` | string | yes | |

**Auto-generated scaffolding**:
```sql
CREATE OR REPLACE FUNCTION public.{function_name}({parameters})
RETURNS {returns}
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  -- variables extracted from body (if any DECLARE section provided)
BEGIN
  IF current_user_id() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  {body}
END;
$$;
REVOKE EXECUTE ON FUNCTION public.{function_name}({param_types}) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.{function_name}({param_types}) TO authenticated;
```

**Validates against schema cache**:
- Table/column references in the body (`NEW.column_name`, `FROM table_name`) checked against known schema
- `get_status_id()`, `get_category_id()` calls validated against known values
- `has_permission()` calls validated against known entities
- Function calls (`create_notification`, `create_entity_note`) validated against known signatures

**Auto-generated**: grant/revoke, introspection registration, ADR.

### `create_trigger_function`

Create a trigger function and attach it to a table.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `function_name` | string | yes | Function name |
| `entity` | string | yes | Table to attach trigger to |
| `timing` | string | yes | `before` or `after` |
| `events` | string[] | yes | `insert`, `update`, `delete` |
| `for_each` | string | no | `row` (default) or `statement` |
| `when_columns` | string[] | no | Columns that trigger on UPDATE OF (omit for all columns) |
| `body` | string | yes | PL/pgSQL function body |
| `security_definer` | boolean | no | Default: false |
| `description` | string | yes | What the trigger does |
| `rationale` | string | yes | |

**Auto-generated scaffolding**:
```sql
CREATE OR REPLACE FUNCTION public.{function_name}()
RETURNS TRIGGER
LANGUAGE plpgsql
[SECURITY DEFINER]
AS $$
BEGIN
  {body}
END;
$$;

CREATE TRIGGER trg_{function_name}
  {BEFORE|AFTER} {INSERT|UPDATE|DELETE} [OF {columns}]
  ON public.{entity}
  FOR EACH {ROW|STATEMENT}
  EXECUTE FUNCTION public.{function_name}();
```

**Validates**: entity exists; when_columns exist on entity; body column references validated.

### `create_rls_policy`

Create a custom RLS policy (beyond the standard 4-policy set from `create_entity`).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `entity` | string | yes | Table name |
| `policy_name` | string | yes | Policy identifier |
| `operation` | string | yes | `select`, `insert`, `update`, `delete`, `all` |
| `role` | string | yes | `web_anon`, `authenticated` |
| `using_expression` | string | no | USING clause (for SELECT/UPDATE/DELETE) |
| `check_expression` | string | no | WITH CHECK clause (for INSERT/UPDATE) |
| `description` | string | yes | What access pattern this enables |
| `rationale` | string | yes | |

**Validates**: entity exists; column references in expressions validated; no duplicate policy name.

### `create_view`

Create a VIEW (read-only or virtual entity with INSTEAD OF triggers).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `view_name` | string | yes | View name |
| `query` | string | yes | SELECT statement |
| `security_invoker` | boolean | no | Default: true |
| `is_virtual_entity` | boolean | no | Register as a CRUD entity |
| `grants` | object | no | `{web_anon: ["select"], authenticated: ["select"]}` |
| `description` | string | yes | What the view provides |
| `rationale` | string | yes | |

**Validates**: tables/columns in query exist; security_invoker recommended (warning if false).

**Auto-generated**: grants, entity metadata (if virtual entity), ADR.

### `create_helper_function`

Create a non-action helper function (for RLS predicates, computed values, etc.).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `function_name` | string | yes | Function name |
| `parameters` | array of `{name, type}` | yes | Function parameters |
| `returns` | string | yes | Return type |
| `body` | string | yes | Function body |
| `language` | string | no | `plpgsql` (default) or `sql` |
| `volatility` | string | no | `volatile` (default), `stable`, `immutable` |
| `security_definer` | boolean | no | Default: false |
| `grant_to` | string[] | no | Roles to grant execute (default: `authenticated`) |
| `description` | string | yes | What the function does |
| `rationale` | string | yes | |

**Auto-generated**: revoke from PUBLIC, grants, introspection registration, ADR.

### `create_notification_trigger`

Specialized trigger for sending notifications on data changes.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `entity` | string | yes | Table to watch |
| `trigger_name` | string | yes | Trigger identifier |
| `template_name` | string | yes | Notification template to use |
| `timing` | string | no | `after` (default) |
| `events` | string[] | yes | `insert`, `update`, `delete` |
| `when_columns` | string[] | no | Trigger on specific column changes |
| `recipient_expression` | string | yes | PL/pgSQL expression that evaluates to UUID or UUID[] |
| `entity_data_expression` | string | yes | PL/pgSQL expression that evaluates to JSONB |
| `channels` | string[] | no | `email`, `sms` (default: `['email']`) |
| `condition` | string | no | PL/pgSQL IF condition (e.g., `NEW.status_id IS DISTINCT FROM OLD.status_id`) |
| `rationale` | string | yes | |

**Validates**: entity exists; template_name exists; when_columns exist; column references in expressions validated.

**Auto-generated**: complete trigger function wrapping `create_notification()` call with the provided expressions, SECURITY DEFINER, auth guard, grant/revoke, introspection registration, ADR.

This tool is a hybrid — it's more structured than `create_trigger_function` (the agent provides expressions, not a full function body) but still requires agent-authored PL/pgSQL fragments.

---

## Coverage Matrix

How the three layers cover the 96 operation types found across the example instances and reference deployments:

| Operation Category | Count | Layer 2 | Layer 3 | Layer 4 | Not Covered |
|--------------------|-------|---------|---------|---------|-------------|
| Table creation | 10 | — | `create_entity`, `add_m2m_relationship` | — | — |
| Column operations | 6 | — | `add_column`, `remove_column`, `add_*_column` | — | ALTER COLUMN TYPE, RENAME COLUMN (rare, manual) |
| Index operations | 7 | — | `add_index` (+ auto-generated FK indexes) | — | DROP INDEX (manual) |
| Constraint operations | 6 | — | `add_check_constraint`, `add_unique_constraint`, `add_exclusion_constraint` | — | — |
| Permission grants | 6 | — | Auto-generated by `create_entity` | — | — |
| RLS policies | 8 | — | Standard 4-set auto-generated | `create_rls_policy` | — |
| Trigger creation | 13 | — | Timestamp triggers auto-generated | `create_trigger_function`, `create_notification_trigger` | — |
| Function creation | 10 | — | — | `create_workflow_rpc`, `create_helper_function` | — |
| View creation | 4 | — | — | `create_view` | — |
| Entity metadata | 4 | `configure_entity`, `reorder_entities` | — | — | — |
| Property metadata | 4 | `configure_property`, `reorder_properties` | — | — | — |
| Status system | 5 | Full CRUD | `add_status_column` | — | — |
| Category system | 4 | Full CRUD | `add_category_column` | — | — |
| RBAC | 10 | `set_permission`, `create_role`, etc. | — | — | — |
| Entity actions | 5 | `register_action`, `register_action_param` | — | — | — |
| Dashboards | 4 | Full CRUD | — | — | — |
| Notifications | 3 | `create_notification_template` | — | `create_notification_trigger` | — |
| Translations | 3 | `set_translation`, `bulk_set_translations` | — | — | — |
| Validations | 3 | `add_validation`, `set_constraint_message` | — | — | — |
| Search config | 2 | — | `configure_text_search` | — | — |
| Feature enablement | 5 | `enable_entity_notes`, `register_*` | — | — | — |
| Data seeding | 2 | Existing data MCP tools (Layer 1) | — | — | — |
| PostgREST reload | 1 | Auto (every tool) | Auto | Auto | — |

**Coverage**: ~90 of 96 operation types. The 6 uncovered operations are rare schema evolution primitives (ALTER COLUMN TYPE, RENAME COLUMN, DROP INDEX, DISABLE/ENABLE TRIGGER, REINDEX) that can remain manual SQL for now.

---

## Operations NOT Included (and Why)

| Operation | Reason |
|-----------|--------|
| `DROP TABLE` as freeform | `drop_entity` covers this with safety checks |
| ALTER COLUMN TYPE | Rare, high risk, often requires data migration — manual |
| RENAME COLUMN | Rare, breaks PostgREST clients — manual |
| DROP INDEX | Low value, low risk — manual |
| DISABLE/ENABLE TRIGGER | Operational, used during bulk data loads — manual |
| CREATE EXTENSION | Framework bootstrap only (Sqitch migrations) |
| CREATE ROLE (database) | Cluster-level operation, not instance management |
| pg_dump / pg_restore | Ops tooling, not schema management |
| ALTER SYSTEM | DBA tuning, not instance management |
| Payment integration | Complex cross-service setup (Stripe + worker), manual for now |

---

## Open Questions

1. **Review pipeline**: Should Layer 3/4 tools execute immediately or route through a `pending_changes` review queue? The Schema Assistant design includes a review pipeline, but this interface's structured validation may make immediate execution safe enough for Layer 3 while Layer 4 warrants review.

2. **Revert scripts**: The SDK generates revert SQL for every operation. Should the MCP tools expose a `revert_last_operation` tool, or is revert always a manual process?

3. **Dry-run mode**: Should tools support a `dry_run: true` parameter that returns the SQL that would be executed without executing it? This lets the agent inspect and iterate before committing.

4. **Batch operations**: Should there be a `batch` tool that groups multiple operations into a single transaction? The `create_entity` tool already bundles 8–10 operations atomically, but cross-entity workflows (e.g., "create two entities with a junction table") currently require multiple tool calls.

5. **Migration output**: Should Layer 3/4 tools optionally emit Sqitch migration files instead of executing directly? This would integrate with the existing migration workflow for production deployments.
