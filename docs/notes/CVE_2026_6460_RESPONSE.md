# CVE-2026-6460 Response: Revoke TEMPORARY from PUBLIC

> **Status**: Hardening implemented in v0.81.4 (`v0-81-4-revoke-public-temp`). The fix is a PostgreSQL minor upgrade.
> **Author**: Daniel Kurin
> **Date**: 2026-11-14
> **Severity**: CVSS 3.1 8.8 (AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H), CWE-843

## Summary

CVE-2026-6460 is a type confusion in PostgreSQL that lets a role that can create objects run arbitrary code as the operating system user that runs the server. Creating temporary objects is enough. It is fixed in PostgreSQL 18.7, 17.12, 16.16, 15.20 and 14.25 (released 2026-11-12). The advisory names no workaround.

PostgreSQL grants `TEMPORARY` on every new database to `PUBLIC`, so every role that can log in meets the prerequisite, including roles meant to be read-only.

## Exposure in Civic OS

| Path | Exposed? | Why |
|------|----------|-----|
| Anonymous and signed-in users through PostgREST | No | PostgREST runs fixed, parameterized queries. No endpoint lets a client run DDL or `CREATE TEMP TABLE`, and core RPCs never create temporary tables. |
| `authenticator` (PostgREST's login role) | Yes, if its password leaks | It logs in directly and holds `TEMPORARY` through `PUBLIC`. |
| `civic_os_mcp_readonly` and other read-only login roles | Yes | The documented recipes grant only `SELECT`, but the role still holds `TEMPORARY` through `PUBLIC`. Anyone with the connection string, including an LLM agent driven by untrusted input, can create temporary tables. |
| Other databases in the cluster (`postgres`, `template_postgis`) | Yes | Every login role can connect to them and holds `TEMPORARY` there by default. A revoke in the Civic OS database alone does not close these. |
| `CREATE` on schema `public` | No | PostgreSQL 15+ no longer grants it to `PUBLIC`, and Civic OS runs 17. |

The local stack and the published images run `postgis/postgis:17-3.5` (PostgreSQL 17.5 at the time of writing), which is affected.

## The Fix: Upgrade PostgreSQL

Upgrade to 17.12 or later. A minor upgrade keeps the data directory, so it is a pull and a restart:

```bash
docker compose pull postgres && docker compose up -d postgres
```

The examples build their database from `docker/dev-postgres`, so rebuild it with `docker compose build --pull postgres` to pick up the new base. On a managed database, apply the provider's minor version update. Check the running version with `SELECT version();`.

The `postgis/postgis` 17-3.5 tags were last rebuilt before 17.12 shipped, so until they are rebuilt, the hardening below is the only defense on those images.

## The Hardening: v0.81.4

The migration `v0-81-4-revoke-public-temp` revokes `TEMPORARY` on the Civic OS database from `PUBLIC`:

- `CONNECT` is untouched.
- The database owner keeps `TEMPORARY` (implicit in its ACL entry), and superusers bypass the check, so migrations that use temporary tables still deploy.
- A role an integrator granted `TEMPORARY` to explicitly keeps it.
- No API role needs `TEMPORARY`, so the API behaves the same.

It stays useful after the upgrade as least privilege: the next bug of this class will need the same privilege.

**Who can deploy it.** Only the database owner, a member of the owner role or a superuser can revoke `PUBLIC`'s default grant. Anyone else gets a `WARNING`, not an error, so the migration checks the result and fails with a hint naming the owner and the command. If the owner runs `REVOKE TEMPORARY ON DATABASE <db> FROM PUBLIC;` first, the migration does nothing and the deployment can rerun. On DigitalOcean managed databases `doadmin` owns the database, so the deploy succeeds as is.

**Other databases.** Database privileges are per database, and a migration changes only its own. The deploy raises a `NOTICE` naming every other database where `PUBLIC` still holds `CONNECT` and `TEMPORARY`. Close them as a superuser:

```sql
REVOKE TEMPORARY ON DATABASE postgres, template_postgis FROM PUBLIC;
```

Name the databases the notice lists. `template_postgis` exists on the `postgis/postgis` image. Managed providers may not let you change their maintenance database; there, the upgrade is the fix.

**Revert.** The revert grants `TEMPORARY` back to `PUBLIC`. The ACL stays explicit (`=Tc/owner`) rather than NULL, with the same privileges as the default.

**Test scripts.** A functional test that switches to an API role (`SET ROLE authenticated`, `SET SESSION AUTHORIZATION authenticator`) can no longer create `pg_temp` helper functions or temporary tables after the switch. Create them as the superuser before switching, and grant `EXECUTE` on the helpers to `PUBLIC`. As `SECURITY INVOKER` functions they still run with the caller's privileges. `tests/functional/v0-76-9-view-rls-test.sh` was changed this way.

## Read-Only Login Roles

A role with only `SELECT` grants is not read-only at the database level while `PUBLIC` holds `TEMPORARY`. After v0.81.4 and the revoke above, a read-only role cannot create temporary objects in any database. Do not grant `TEMPORARY` to such roles. The recipes in `docs/INTEGRATOR_GUIDE.md` (Database Role for MCP) and `infrastructure/vps/README.md` (step 10) say so.

## Verification

`tests/functional/v0-81-4-revoke-public-temp-test.sh` checks, against a migrated database:

- `PUBLIC` lacks `TEMPORARY` and keeps `CONNECT`;
- `web_anon`, `authenticated`, `authenticator` and a role built from the read-only recipe cannot create a temporary table;
- a read-only role can still read;
- the owner keeps `TEMPORARY`, and an explicit grant still works.

On a throwaway `postgis/postgis:17-3.5` cluster:

- Deploy to HEAD as a superuser passes the test 8/8. After a revert to v0.81.3 the five exposure cases fail, so the test is not vacuous.
- Deploy as a non-superuser owner (the managed-database case) passes 8/8.
- Deploy as a role that does not own the database fails with the hint.
- A deploy after the owner revoked first succeeds without changes.

## Related

- `docs/notes/SECURITY_DEFINER_AUDIT_2026-10.md`: the same `PUBLIC` default problem for function `EXECUTE`.
- `docs/development/PERMISSIONS_MODEL.md` (Layer 1): database-level privileges.
