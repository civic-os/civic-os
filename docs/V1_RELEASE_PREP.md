# Civic OS v1.0 Release Preparation

This document tracks technical debt, inconsistencies, and breaking changes to address before the v1.0 release.

## Metadata Schema Inconsistencies

### Column Naming: `table_name` vs `entity_type`

The metadata tables use inconsistent naming for the column that identifies which entity/table a record belongs to:

| Table | Column Name | Notes |
|-------|-------------|-------|
| `metadata.entities` | `table_name` | ✓ Consistent |
| `metadata.properties` | `table_name` | ✓ Consistent |
| `metadata.permissions` | `table_name` | ✓ Consistent |
| `metadata.validations` | `table_name` | ✓ Consistent |
| `metadata.constraint_messages` | `table_name` | ✓ Consistent |
| `metadata.static_text` | `table_name` | ✓ Consistent |
| `metadata.entity_actions` | `table_name` | ✓ Consistent |
| `metadata.statuses` | `entity_type` | ⚠️ Inconsistent |
| `metadata.entity_notes` | `entity_type` | ⚠️ Inconsistent |
| `metadata.notification_templates` | `entity_type` | ⚠️ Inconsistent |
| `metadata.notifications` | `entity_type` | ⚠️ Inconsistent |
| `metadata.files` | `entity_type` | ⚠️ Inconsistent |

**Recommendation:** Standardize on `table_name` for all metadata tables. The term "entity_type" is ambiguous (could mean the type of entity vs the table name).

**Migration complexity:** Medium - requires updating:
- Column renames in 5 tables
- All RLS policies referencing these columns
- Frontend SchemaService queries
- Integrator SQL scripts

### Junction Table Column Naming

Junction tables use inconsistent FK column names:

| Table | FK Column | Points To |
|-------|-----------|-----------|
| `metadata.permission_roles` | `permission_id` | `permissions.id` |
| `metadata.permission_roles` | `role_id` | `roles.id` |
| `metadata.entity_action_roles` | `entity_action_id` | `entity_actions.id` |
| `metadata.entity_action_roles` | `role_id` | `roles.id` |

**Observation:** `entity_action_roles` uses `entity_action_id` (full table name prefix) while `permission_roles` uses just `permission_id`. Both patterns are valid, but consistency would help.

**Recommendation:** Keep as-is for v1.0 - the inconsistency is minor and changing would break existing integrations.

---

## DaisyUI 4 → 5 Migration Debt

The codebase uses some DaisyUI 4 class names that don't exist in DaisyUI 5:

| DaisyUI 4 Class | DaisyUI 5 Equivalent | Status |
|-----------------|---------------------|--------|
| `form-control` | `fieldset` | Widely used, needs audit |
| `label-text` | `label` | Widely used, needs audit |
| `tabs-lifted` | `tabs-lift` | Check usage |
| `tabs-bordered` | `tabs-border` | Check usage |
| `card-bordered` | `card-border` | Check usage |

**Recommendation:** Audit all component templates and update to DaisyUI 5 classes before v1.0.

---

## API Response Consistency

### Timestamp Formats

- Some columns return ISO 8601 strings
- Some return PostgreSQL timestamp format
- `tstzrange` columns return PostgreSQL range format `["2025-01-01 00:00:00+00","2025-01-02 00:00:00+00")`

**Recommendation:** Document expected formats clearly. Consider adding PostgREST computed fields for pre-formatted display values where needed.

### Money Type

PostgreSQL `money` type returns locale-formatted strings like `"$150.00"`. This works but:
- Locale-dependent formatting
- String parsing required for calculations
- Not ideal for i18n

**Recommendation:** Consider using `NUMERIC(10,2)` for new money columns and formatting in frontend.

---

## Breaking Changes for v1.0

### Planned

1. **Standardize `entity_type` → `table_name`** (if approved)
2. **Remove deprecated RPC functions** (list TBD)
3. **Consolidate worker services** (already done in v0.10.0)

### Deferred to v2.0

1. Views as entities (requires `schema_entities` changes)
2. Multi-tenant support
3. Audit logging system

---

## Pre-Release Checklist

- [ ] Resolve metadata column naming inconsistencies
- [ ] Audit and fix DaisyUI class usage
- [ ] Update all example schemas to use consistent patterns
- [ ] Review and update INTEGRATOR_GUIDE.md
- [ ] Run full test suite on all examples
- [ ] Performance audit on large datasets (1000+ records)
- [ ] Security audit (RLS policies, SECURITY DEFINER functions)
- [ ] Documentation review

---

## Notes

*Add observations here as they're discovered during development.*
