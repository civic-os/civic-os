-- Deploy civic_os:v0-86-0-dimension-cache-version to pg
-- requires: v0-85-0-registry-translations
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- The Dimension property type (v0.86.0) is detected by clients from a foreign key's target: a BIGINT FK to a
-- table in the dimensions registry (public.schema_dimensions) is a Dimension, the way an FK to a known system
-- table is a File, User or Payment. schema_properties and the schema contract hash do not change. Clients
-- load the registry with the properties, so the properties cache version now also follows the registry:
-- registering a dimension or changing its default refreshes open browsers on their next navigation.
-- Design: docs/notes/IMPACT_REPORTING_DESIGN.md (decision 13, superseded 2026-11-20).
--
-- public.schema_cache_versions is re-created from its v0.85.0 definition with CREATE OR REPLACE, so its
-- owner, grants and options are unchanged.

BEGIN;

CREATE OR REPLACE VIEW public.schema_cache_versions AS
SELECT 'entities'::text AS cache_name,
    GREATEST(( SELECT COALESCE(max(entities.updated_at), '1970-01-01 00:00:00+00'::timestamp with time zone) AS "coalesce"
           FROM metadata.entities), ( SELECT COALESCE(max(permissions.updated_at), '1970-01-01 00:00:00+00'::timestamp with time zone) AS "coalesce"
           FROM metadata.permissions), ( SELECT COALESCE(max(roles.updated_at), '1970-01-01 00:00:00+00'::timestamp with time zone) AS "coalesce"
           FROM metadata.roles), ( SELECT COALESCE(max(permission_roles.updated_at), '1970-01-01 00:00:00+00'::timestamp with time zone) AS "coalesce"
           FROM metadata.permission_roles)) AS version
UNION ALL
 SELECT 'properties'::text AS cache_name,
    GREATEST(( SELECT COALESCE(max(properties.updated_at), '1970-01-01 00:00:00+00'::timestamp with time zone) AS "coalesce"
           FROM metadata.properties), ( SELECT COALESCE(max(validations.updated_at), '1970-01-01 00:00:00+00'::timestamp with time zone) AS "coalesce"
           FROM metadata.validations), ( SELECT COALESCE(max(dimensions.updated_at), '1970-01-01 00:00:00+00'::timestamp with time zone) AS "coalesce"
           FROM metadata.dimensions)) AS version
UNION ALL
 SELECT 'constraint_messages'::text AS cache_name,
    ( SELECT COALESCE(max(constraint_messages.updated_at), '1970-01-01 00:00:00+00'::timestamp with time zone) AS "coalesce"
           FROM metadata.constraint_messages) AS version
UNION ALL
 SELECT 'introspection'::text AS cache_name,
    GREATEST(( SELECT COALESCE(max(rpc_functions.updated_at), '1970-01-01 00:00:00+00'::timestamp with time zone) AS "coalesce"
           FROM metadata.rpc_functions), ( SELECT COALESCE(max(database_triggers.updated_at), '1970-01-01 00:00:00+00'::timestamp with time zone) AS "coalesce"
           FROM metadata.database_triggers), ( SELECT COALESCE(max(rpc_entity_effects.updated_at), '1970-01-01 00:00:00+00'::timestamp with time zone) AS "coalesce"
           FROM metadata.rpc_entity_effects), ( SELECT COALESCE(max(trigger_entity_effects.updated_at), '1970-01-01 00:00:00+00'::timestamp with time zone) AS "coalesce"
           FROM metadata.trigger_entity_effects), ( SELECT COALESCE(max(notification_triggers.updated_at), '1970-01-01 00:00:00+00'::timestamp with time zone) AS "coalesce"
           FROM metadata.notification_triggers)) AS version
UNION ALL
 SELECT 'categories'::text AS cache_name,
    GREATEST(( SELECT COALESCE(max(categories.updated_at), '1970-01-01 00:00:00+00'::timestamp with time zone) AS "coalesce"
           FROM metadata.categories), ( SELECT COALESCE(max(category_groups.updated_at), '1970-01-01 00:00:00+00'::timestamp with time zone) AS "coalesce"
           FROM metadata.category_groups)) AS version
UNION ALL
 SELECT 'translations'::text AS cache_name,
    ( SELECT COALESCE(max(translations_version.changed_at), '1970-01-01 00:00:00+00'::timestamp with time zone) AS "coalesce"
           FROM metadata.translations_version) AS version
UNION ALL
 SELECT 'profile_extensions'::text AS cache_name,
    ( SELECT COALESCE(max(user_profile_extensions.updated_at), '1970-01-01 00:00:00+00'::timestamp with time zone) AS "coalesce"
           FROM metadata.user_profile_extensions) AS version
UNION ALL
 SELECT 'instance_config'::text AS cache_name,
    ( SELECT COALESCE(max(instance_config.updated_at), '1970-01-01 00:00:00+00'::timestamp with time zone) AS "coalesce"
           FROM metadata.instance_config) AS version
UNION ALL
 SELECT 'statuses'::text AS cache_name,
    GREATEST(( SELECT COALESCE(max(statuses.updated_at), '1970-01-01 00:00:00+00'::timestamp with time zone) AS "coalesce"
           FROM metadata.statuses), ( SELECT COALESCE(max(status_types.updated_at), '1970-01-01 00:00:00+00'::timestamp with time zone) AS "coalesce"
           FROM metadata.status_types)) AS version
UNION ALL
 SELECT 'menu'::text AS cache_name,
    ( SELECT COALESCE(max(menu_version.changed_at), '1970-01-01 00:00:00+00'::timestamp with time zone) AS "coalesce"
           FROM metadata.menu_version) AS version;

COMMENT ON VIEW public.schema_cache_versions IS
    'Cache version timestamps for frontend cache invalidation. Includes entities, properties,
     constraint_messages, introspection, categories, translations, profile_extensions, instance_config,
     statuses, and menu. The properties version also follows metadata.dimensions since v0.86.0.';

NOTIFY pgrst, 'reload schema';

COMMIT;
