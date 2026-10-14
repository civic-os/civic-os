# Security Audit: REVOKE PUBLIC EXECUTE (October 2026)

> **Status**: Implemented in v0.76.5 (`v0-76-5-revoke-public-execute`)
> **Author**: Daniel Kurin
> **Date**: 2026-10-14
> **Severity**: CVSS 9.8 (network, low complexity, no authentication, high impact)

## Summary

PostgreSQL grants `EXECUTE` on every new function to the `PUBLIC` pseudo-role by default. Civic OS migrations secured RPCs by adding `GRANT ... TO authenticated`, and in places `REVOKE ... FROM web_anon`. Neither removes the `PUBLIC` grant: `web_anon` inherits `EXECUTE` through `PUBLIC`, so the `web_anon` revoke is a no-op and the `authenticated` grant is additive, not restrictive.

PostgREST exposes every function in the `public` schema as `/rpc/<name>`. Any anonymous HTTP client could therefore call `SECURITY DEFINER` functions, which run as the function owner and bypass table GRANTs and RLS. Most had no in-body authorization check because the author assumed the GRANT was the gate.

## Impact

An unauthenticated attacker with only the API URL could:

- Delete arbitrary rows from any table in the `public` schema
- Tamper with recurring series data at scale
- Obtain S3 presigned upload URLs (storage abuse and cost)
- Send arbitrary email and SMS through the notification pipeline
- Reach DDL and privilege-granting code paths through the guided form setup functions

Every instance on a release before v0.76.5 is affected. Upgrade to v0.76.5 or later.

## Key Exploits Verified

| Function | Result of anonymous call |
|----------|--------------------------|
| `cancel_series_occurrence` | Arbitrary `DELETE` from any public table (table name is a parameter) |
| `request_upload_url`, `get_upload_url` | Anonymous S3 presigned URL issuance |
| `create_notification` | Anonymous email and SMS spam to any user |
| `metadata._is_db_admin()` | Always returned true (see below) |
| `update_series_template` | Mass data tampering across series instances |
| `register_guided_form`, `grant_guided_form_permissions` | DDL execution and permission escalation |

### The `_is_db_admin()` defect

`metadata._is_db_admin()` is `SECURITY DEFINER`, so inside it `current_user` is the function owner (`postgres`), never the caller. Its `rolcreaterole` check on `current_user` was therefore always true, and the functions that relied on it as their guard (`register_guided_form`, `add_guided_form_step`, `grant_guided_form_permissions`, introduced in v0.56.1) accepted every caller. Combined with the `PUBLIC` grant, that made the DDL and permission-granting paths reachable anonymously. The fix checks `session_user`, which is the login role: `authenticator` for PostgREST requests, the integrator's own role when running migrations.

## Fix (v0.76.5)

1. **REVOKE EXECUTE FROM PUBLIC** on 122 functions whose intended audience is not anonymous users: authenticated-only RPCs and internal-only functions (trigger functions, worker helpers, integrator setup functions). Two functions with explicit `web_anon` grants (`has_role`, `get_series_membership`) also lost them. Missing `authenticated` grants were added where the old behavior depended on `PUBLIC`.
2. **ALTER DEFAULT PRIVILEGES FOR ROLE postgres** so functions created from now on do not receive `PUBLIC` execute. This fails closed: a forgotten GRANT yields a function nobody can call instead of one everybody can.
3. **In-body authorization guards** added to 18 critical `SECURITY DEFINER` functions (defense in depth, so a future GRANT mistake does not reopen the hole): file upload URL functions, `create_entity_note`, `admin_get_user_bulk_subscriptions`, the template preview and validate functions, all 11 recurring series functions, and `enable_entity_notes`.
4. **`_is_db_admin()` rewritten** to use `session_user`.
5. **Template corrected**: `postgres/migrations/templates/add_rpc_function.sql` previously taught `REVOKE ... FROM web_anon`; it now revokes from `PUBLIC` and explains why.
6. **Schema decision recorded** in `metadata.schema_decisions` by the migration.

The 33 functions intended for anonymous use keep their `PUBLIC` grant.

## Audit Methodology

1. **Catalog query**: enumerated every non-extension function with owner, `SECURITY DEFINER` flag, and ACL.
2. **Body analysis**: read each function body for authorization checks (`current_user_id()`, `has_permission()`, `is_admin()`, `_is_db_admin()`) and for dynamic SQL that takes table or column names from parameters.
3. **Classification**: assigned each function an intended audience.
4. **Empirical probing**: called functions over PostgREST as `web_anon` and as a low-privilege authenticated user, confirming exploitability rather than trusting the ACL.

## Statistics

| Intended audience | Functions |
|-------------------|-----------|
| Anonymous | 33 |
| Authenticated | 98 |
| Internal (triggers, workers, integrator setup) | 25 |
| **Total audited** | **156** |

## Ongoing Guidance

For authors of new migrations:

- **Revoke from `PUBLIC`, never from `web_anon`.** Revoking from `web_anon` does nothing while the `PUBLIC` grant exists. Then `GRANT EXECUTE` explicitly to the roles that need it.
- **Every `SECURITY DEFINER` function needs an in-body guard**, even when the GRANT looks sufficient. Use `current_user_id()` for authentication, `has_permission()` for entity-level checks, `is_admin()` for admin-only paths.
- **Never take table or column names from parameters** into dynamic SQL without validating them against `metadata.entities` and checking the caller's permission on that table.
- **Start from the template** at `postgres/migrations/templates/add_rpc_function.sql`.
- **Anonymous-facing functions need an explicit GRANT** to `web_anon` now. This includes helpers that RLS policies or other objects evaluate as the anonymous role, which no longer inherit access from `PUBLIC`.
- **Default privileges apply only to functions created by `postgres`** and also affect extensions created afterward; follow `CREATE EXTENSION` with an explicit GRANT if anonymous callers need its functions. `CREATE OR REPLACE` keeps a function's existing ACL.

For integrators auditing an existing instance, list functions where `PUBLIC` still holds `EXECUTE` and compare against the intended audience. The `docs/INTEGRATOR_GUIDE.md` section "Securing RPC Functions" describes the workflow.

## Related

- Migration: `postgres/migrations/deploy/v0-76-5-revoke-public-execute.sql` (revert and verify scripts alongside)
- `docs/development/PERMISSIONS_MODEL.md` for the three-layer model (GRANTs, RBAC, RLS). `SECURITY DEFINER` functions bypass table GRANTs and RLS, so for them the function `EXECUTE` grant and the in-body guard are the only gates
- `docs/INTEGRATOR_GUIDE.md` (Securing RPC Functions)
