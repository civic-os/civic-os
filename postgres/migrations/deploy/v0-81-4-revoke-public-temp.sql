-- Deploy civic_os:v0-81-4-revoke-public-temp
-- Requires: v0-81-3-translations-admin-translations
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later

-- v0.81.4 -- Revoke TEMPORARY on the Civic OS database from PUBLIC (CVE-2026-6460 hardening).
--
-- PostgreSQL grants TEMPORARY on every new database to PUBLIC by default, so every role that can log in
-- can create temporary tables, including roles meant to be read-only (civic_os_mcp_readonly) and
-- authenticator. CVE-2026-6460 (PostgreSQL before 18.7, 17.12, 16.16, 15.20, 14.25) lets any role that can
-- create objects, temporary ones included, run code as the operating system user. No Civic OS API role
-- needs TEMPORARY: PostgREST never creates temporary tables, and the only temporary tables in core live in
-- migration helpers, which run as the database owner or a superuser. Upgrading PostgreSQL is the fix; this
-- removes the privilege the exploit needs from roles that never needed it, and stays useful after the
-- upgrade as least privilege.
--
-- What changes:
--   * PUBLIC loses TEMPORARY on this database. CONNECT is untouched.
--   * The database owner keeps TEMPORARY (implicit in the owner's ACL entry); superusers bypass the check.
--   * A role an integrator granted TEMPORARY to explicitly keeps it.
--
-- Only the database owner, a member of the owner role or a superuser can revoke PUBLIC's default grant,
-- because the owner is its grantor; anyone else gets a WARNING, not an error. The deploy therefore checks
-- the result and fails with the command to run as the owner. When PUBLIC already lacks TEMPORARY (the
-- owner ran that command), the deploy does nothing, so a blocked deployment can rerun it.
--
-- Database ACLs are cluster-wide catalog data, but this migration changes only its own database. It raises
-- a NOTICE naming every other database where PUBLIC still holds CONNECT and TEMPORARY (typically the
-- maintenance database "postgres"): a login role can connect there and create temporary tables, so the
-- operator should revoke TEMPORARY there too. See docs/notes/CVE_2026_6460_RESPONSE.md.
--
-- Framework migration: no schema decision (ADR) is recorded.

BEGIN;

DO $$
DECLARE
    v_other TEXT;
BEGIN
    IF has_database_privilege('public', current_database(), 'TEMPORARY') THEN
        EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());

        IF has_database_privilege('public', current_database(), 'TEMPORARY') THEN
            RAISE EXCEPTION 'PUBLIC still holds TEMPORARY on database %: role % could not revoke it', current_database(), current_user
                USING HINT = format('Connect as the database owner (%s) or a superuser and run: REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC; then deploy again.',
                                    (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database()),
                                    current_database());
        END IF;
    END IF;

    SELECT string_agg(quote_ident(datname), ', ' ORDER BY datname)
      INTO v_other
      FROM pg_database
     WHERE datname <> current_database()
       AND datallowconn
       AND has_database_privilege('public', datname, 'CONNECT')
       AND has_database_privilege('public', datname, 'TEMPORARY');

    IF v_other IS NOT NULL THEN
        RAISE NOTICE 'PUBLIC can still connect to and create temporary tables in: %. As a superuser, run REVOKE TEMPORARY ON DATABASE % FROM PUBLIC; (CVE-2026-6460 hardening).', v_other, v_other;
    END IF;
END $$;

COMMIT;
