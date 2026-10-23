-- Verify civic_os:v0-76-10-view-relations-output-columns on pg
--
-- The function must exist, and it must report no FK for a view column that the view only uses in a
-- JOIN condition (the pre-v0.76.10 false positive), while still reporting a directly output column,
-- under an alias too. Fixtures live in this transaction and are rolled back.

BEGIN;

SELECT 1 / COUNT(*) FROM pg_proc WHERE proname = 'schema_view_relations_func' AND pronamespace = 'public'::regnamespace;

-- the conversion helper exists, returns NULL (not an error) on text it cannot convert, and has no PUBLIC execute
SELECT 1 / COUNT(*) FROM pg_proc WHERE proname = 'view_rule_to_json' AND pronamespace = 'metadata'::regnamespace;
SELECT 1 / (CASE WHEN metadata.view_rule_to_json('vr_verify', 'not a node tree') IS NULL THEN 1 ELSE 0 END);
SELECT 1 / (CASE WHEN has_function_privilege('public', 'metadata.view_rule_to_json(name, text)', 'EXECUTE') THEN 0 ELSE 1 END);

CREATE TABLE public.vr_verify_users (id int PRIMARY KEY);
CREATE TABLE public.vr_verify_member (id int PRIMARY KEY, user_id int REFERENCES public.vr_verify_users(id));
CREATE TABLE public.vr_verify_profile (id int PRIMARY KEY REFERENCES public.vr_verify_users(id), name text);
CREATE VIEW public.vr_verify_view AS
  SELECT m.id, m.user_id AS owner, p.name
  FROM public.vr_verify_member m JOIN public.vr_verify_profile p ON p.id = m.user_id;

-- the function reports registered views only (what schema_properties exposes)
INSERT INTO metadata.entities (table_name) VALUES ('vr_verify_view');

-- the aliased FK column is reported
SELECT 1 / COUNT(*) FROM public.schema_view_relations_func()
WHERE view_name = 'vr_verify_view' AND view_column = 'owner' AND join_table = 'vr_verify_users';

-- the join-only column is not: id must carry no FK, and nothing else but owner is reported
SELECT 1 / (CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END) FROM public.schema_view_relations_func()
WHERE view_name = 'vr_verify_view' AND view_column <> 'owner';

ROLLBACK;
