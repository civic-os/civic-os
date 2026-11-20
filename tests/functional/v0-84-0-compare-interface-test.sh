#!/bin/bash
# =============================================================================
# Functional Test: v0-84-0 compare_interface() and assert_interface()
# =============================================================================
# Builds a fixture schema and checks, for table and rpc elements, every difference code and every row of
# the type table in docs/notes/MODULE_INSTALL_SUPPORT_DESIGN.md (Type compatibility):
#   - a matching declaration returns no rows; undeclared columns are never looked at;
#   - missing_table, kind_mismatch (a view), missing_column;
#   - widened (info): longer varchar, varchar to text, unbounded varchar, wider numeric, unconstrained
#     numeric, smallint -> integer -> bigint; type_mismatch (error): shorter varchar, text -> varchar,
#     smaller scale or integer part, unconstrained -> constrained numeric, bigint -> integer,
#     timestamp <-> timestamptz, base type <-> domain, integer -> numeric;
#   - now_required (info), nullability_mismatch; missing_reference, reference_mismatch;
#   - writes: true -> missing_default for an undeclared NOT NULL column without a default, nothing for
#     defaults, identity and generated columns;
#   - missing_rpc and type_mismatch on returns (scalar, SETOF, TABLE), type aliases normalized;
#   - dimension and module elements report missing_core_feature (registries arrive in v0.85.0);
#   - malformed declarations raise 22023;
#   - row order, template and source echoed;
#   - assert_interface(): silent on a match, NOTICE on info rows only, 55000 with a counted message and
#     one DETAIL line per error otherwise;
#   - authenticated can call both; web_anon cannot.
#
# All fixtures are created inside one transaction that is rolled back.
#
# Usage:
#   ./tests/functional/v0-84-0-compare-interface-test.sh
#
# Environment overrides (the connecting user must be a superuser, to create fixtures and switch roles):
#   DATABASE_URL   postgres://postgres:securepassword123@localhost:15432/civic_os_db
#
# Copyright (C) 2023-2026 Civic OS, L3C
# AGPL-3.0-or-later
# =============================================================================

set -euo pipefail

DATABASE_URL="${DATABASE_URL:-postgres://postgres:securepassword123@localhost:15432/civic_os_db}"

if psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -o /dev/null <<'SQL'
BEGIN;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
CREATE SCHEMA ci_fx;
CREATE TABLE ci_fx.sites (id BIGSERIAL PRIMARY KEY);
CREATE TABLE ci_fx.programs (
  id BIGSERIAL PRIMARY KEY,
  parent_id BIGINT REFERENCES ci_fx.programs(id),
  display_name VARCHAR(100) NOT NULL,
  code VARCHAR(20),
  notes TEXT,
  budget NUMERIC(10,2),
  small SMALLINT,
  mid INTEGER,
  ts TIMESTAMPTZ,
  wall TIMESTAMP,
  contact email_address,
  req TEXT NOT NULL,
  site_id BIGINT REFERENCES ci_fx.sites(id)
);
CREATE INDEX ON ci_fx.programs(parent_id);
CREATE INDEX ON ci_fx.programs(site_id);
CREATE VIEW ci_fx.programs_view AS SELECT id FROM ci_fx.programs;
CREATE TABLE ci_fx.writes_ok (
  id BIGSERIAL PRIMARY KEY,
  a TEXT NOT NULL DEFAULT 'x',
  b TEXT,
  c INT GENERATED ALWAYS AS IDENTITY,
  d INT GENERATED ALWAYS AS (1) STORED
);
CREATE TABLE ci_fx.writes_bad (id BIGSERIAL PRIMARY KEY, required_col TEXT NOT NULL);
CREATE FUNCTION ci_fx.f(text, bigint) RETURNS SETOF bigint LANGUAGE sql AS 'SELECT $2';
CREATE FUNCTION ci_fx.g() RETURNS TABLE(a integer, b text) LANGUAGE sql AS 'SELECT 1, ''x''';
CREATE FUNCTION ci_fx.h(integer) RETURNS integer LANGUAGE sql AS 'SELECT $1';

CREATE FUNCTION pg_temp.expect_sqlstate(p_sql text, p_state text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RETURN false;
EXCEPTION WHEN OTHERS THEN
  RETURN SQLSTATE = p_state;
END $$;
GRANT EXECUTE ON FUNCTION pg_temp.expect_sqlstate(text, text) TO PUBLIC;

-- one column's differences, as "code:severity" joined by commas ('' when none)
CREATE FUNCTION pg_temp.col(p_column jsonb) RETURNS text LANGUAGE sql AS $$
  SELECT coalesce(string_agg(difference || ':' || severity, ',' ORDER BY difference), '')
  FROM public.compare_interface(jsonb_build_object('elements', jsonb_build_array(
    jsonb_build_object('element', 'table', 'name', 'ci_fx.programs', 'columns', jsonb_build_array(p_column)))))
$$;
-- one element's differences
CREATE FUNCTION pg_temp.el(p_element jsonb) RETURNS text LANGUAGE sql AS $$
  SELECT coalesce(string_agg(difference || ':' || severity, ',' ORDER BY column_name NULLS FIRST, difference), '')
  FROM public.compare_interface(jsonb_build_object('elements', jsonb_build_array(p_element)))
$$;
GRANT EXECUTE ON FUNCTION pg_temp.col(jsonb), pg_temp.el(jsonb) TO PUBLIC;

-- ---------------------------------------------------------------------------
-- Tables: existence, kind, columns
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  ASSERT NOT EXISTS (SELECT 1 FROM public.compare_interface($j${"template":"t@1","elements":[
      {"element":"table","name":"ci_fx.programs","columns":[
        {"name":"id","type":"bigint","nullable":false},
        {"name":"parent_id","type":"int8","nullable":true,"references":"ci_fx.programs.id"},
        {"name":"display_name","type":"varchar(100)","nullable":false},
        {"name":"budget","type":"numeric(10,2)"},
        {"name":"contact","type":"email_address"}]},
      {"element":"table","name":"ci_fx.sites","columns":[]},
      {"element":"rpc","name":"ci_fx.f","args":["text","bigint"],"returns":"setof bigint"}]}$j$)),
    'a matching declaration returns no rows';
  ASSERT NOT EXISTS (SELECT 1 FROM public.compare_interface('{"elements":[]}')), 'an empty declaration returns no rows';

  ASSERT pg_temp.el('{"element":"table","name":"ci_fx.nope"}') = 'missing_table:error', 'missing_table';
  ASSERT pg_temp.el('{"element":"table","name":"ci_fx.programs_view","columns":[{"name":"id"}]}') = 'kind_mismatch:error',
    'a view is kind_mismatch, and its columns are not compared';
  ASSERT (SELECT actual FROM public.compare_interface('{"elements":[{"element":"table","name":"ci_fx.programs_view"}]}')) = 'view',
    'kind_mismatch names the actual kind';
  ASSERT pg_temp.col('{"name":"gone","type":"text"}') = 'missing_column:error', 'missing_column';
  ASSERT (SELECT expected FROM public.compare_interface(
    '{"elements":[{"element":"table","name":"ci_fx.programs","columns":[{"name":"gone","type":"varchar(5)"}]}]}')) = 'character varying(5)',
    'missing_column names the declared type';
END $$;

-- ---------------------------------------------------------------------------
-- Type compatibility (declared -> live)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  -- same type, aliases normalized
  ASSERT pg_temp.col('{"name":"id","type":"BIGINT"}') = '', 'BIGINT equals bigint';
  ASSERT pg_temp.col('{"name":"mid","type":"int4"}') = '', 'int4 equals integer';
  ASSERT pg_temp.col('{"name":"code","type":"character varying(20)"}') = '', 'character varying(20) equals varchar(20)';

  -- widened (info)
  ASSERT pg_temp.col('{"name":"display_name","type":"varchar(50)"}') = 'widened:info', 'varchar(50) -> varchar(100)';
  ASSERT pg_temp.col('{"name":"notes","type":"varchar(500)"}') = 'widened:info', 'varchar(n) -> text';
  ASSERT pg_temp.col('{"name":"budget","type":"numeric(8,2)"}') = 'widened:info', 'numeric(8,2) -> numeric(10,2)';
  ASSERT pg_temp.col('{"name":"budget","type":"numeric(9,1)"}') = 'widened:info', 'numeric(9,1) -> numeric(10,2)';
  ASSERT pg_temp.col('{"name":"small","type":"smallint"}') = '', 'smallint -> smallint';
  ASSERT pg_temp.col('{"name":"mid","type":"smallint"}') = 'widened:info', 'smallint -> integer';
  ASSERT pg_temp.col('{"name":"id","type":"integer"}') = 'widened:info', 'integer -> bigint';
  ASSERT pg_temp.col('{"name":"id","type":"smallint"}') = 'widened:info', 'smallint -> bigint';

  -- type_mismatch (error)
  ASSERT pg_temp.col('{"name":"display_name","type":"varchar(200)"}') = 'type_mismatch:error', 'varchar(200) -> varchar(100)';
  ASSERT pg_temp.col('{"name":"display_name","type":"text"}') = 'type_mismatch:error', 'text -> varchar(100)';
  ASSERT pg_temp.col('{"name":"display_name","type":"varchar"}') = 'type_mismatch:error', 'unbounded varchar -> varchar(100)';
  ASSERT pg_temp.col('{"name":"budget","type":"numeric(10,3)"}') = 'type_mismatch:error', 'smaller scale';
  ASSERT pg_temp.col('{"name":"budget","type":"numeric(12,2)"}') = 'type_mismatch:error', 'smaller integer part';
  ASSERT pg_temp.col('{"name":"budget","type":"numeric"}') = 'type_mismatch:error', 'unconstrained -> constrained numeric';
  ASSERT pg_temp.col('{"name":"mid","type":"bigint"}') = 'type_mismatch:error', 'bigint -> integer';
  ASSERT pg_temp.col('{"name":"ts","type":"timestamp"}') = 'type_mismatch:error', 'timestamp -> timestamptz';
  ASSERT pg_temp.col('{"name":"wall","type":"timestamptz"}') = 'type_mismatch:error', 'timestamptz -> timestamp';
  ASSERT pg_temp.col('{"name":"contact","type":"text"}') = 'type_mismatch:error', 'text -> email_address (a domain)';
  ASSERT pg_temp.col('{"name":"notes","type":"email_address"}') = 'type_mismatch:error', 'email_address -> text';
  ASSERT pg_temp.col('{"name":"budget","type":"integer"}') = 'type_mismatch:error', 'integer -> numeric is not a widening';
  ASSERT pg_temp.col('{"name":"small","type":"numeric"}') = 'type_mismatch:error', 'numeric -> smallint';

  ASSERT (SELECT expected || '|' || actual FROM public.compare_interface(
    '{"elements":[{"element":"table","name":"ci_fx.programs","columns":[{"name":"mid","type":"bigint"}]}]}')) = 'bigint|integer',
    'expected and actual are formatted types';
END $$;

-- ---------------------------------------------------------------------------
-- Nullability and references
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  ASSERT pg_temp.col('{"name":"req","nullable":true}') = 'now_required:info', 'nullable -> NOT NULL is info';
  ASSERT pg_temp.col('{"name":"notes","nullable":false}') = 'nullability_mismatch:error', 'NOT NULL -> nullable is an error';
  ASSERT pg_temp.col('{"name":"display_name","nullable":false}') = '', 'NOT NULL matches';

  ASSERT pg_temp.col('{"name":"parent_id","references":"ci_fx.programs.id"}') = '', 'a matching FK';
  ASSERT pg_temp.col('{"name":"code","references":"ci_fx.programs.id"}') = 'missing_reference:error', 'no FK';
  ASSERT pg_temp.col('{"name":"site_id","references":"ci_fx.programs.id"}') = 'reference_mismatch:error', 'FK points elsewhere';
  ASSERT (SELECT actual FROM public.compare_interface(
    '{"elements":[{"element":"table","name":"ci_fx.programs","columns":[{"name":"site_id","references":"ci_fx.programs.id"}]}]}')) = 'ci_fx.sites.id',
    'reference_mismatch names the live target';
  ALTER TABLE ci_fx.programs DROP CONSTRAINT programs_parent_id_fkey;
  ASSERT pg_temp.col('{"name":"parent_id","type":"bigint","references":"ci_fx.programs.id"}') = 'missing_reference:error',
    'a dropped FK is an error even though the column is intact';
END $$;

-- ---------------------------------------------------------------------------
-- Tables the script writes
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  ASSERT pg_temp.el('{"element":"table","name":"ci_fx.writes_ok","writes":true,"columns":[{"name":"id"}]}') = '',
    'defaults, nullable, identity and generated columns accept an omitted value';
  ASSERT pg_temp.el('{"element":"table","name":"ci_fx.writes_bad","writes":true,"columns":[{"name":"id"}]}') = 'missing_default:error',
    'an undeclared NOT NULL column without a default';
  ASSERT (SELECT column_name FROM public.compare_interface(
    '{"elements":[{"element":"table","name":"ci_fx.writes_bad","writes":true}]}')) = 'required_col',
    'missing_default names the column';
  ASSERT pg_temp.el('{"element":"table","name":"ci_fx.writes_bad","writes":true,"columns":[{"name":"id"},{"name":"required_col"}]}') = '',
    'a declared column is the script''s own business';
  ASSERT pg_temp.el('{"element":"table","name":"ci_fx.writes_bad","columns":[{"name":"id"}]}') = '',
    'without writes, undeclared columns are not looked at';
END $$;

-- ---------------------------------------------------------------------------
-- rpc
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  ASSERT pg_temp.el('{"element":"rpc","name":"ci_fx.f","args":["text","int8"]}') = '', 'argument aliases normalized';
  ASSERT pg_temp.el('{"element":"rpc","name":"ci_fx.f","args":["text"]}') = 'missing_rpc:error', 'wrong arity is missing_rpc';
  ASSERT pg_temp.el('{"element":"rpc","name":"ci_fx.nope","args":[]}') = 'missing_rpc:error', 'missing_rpc';
  ASSERT pg_temp.el('{"element":"rpc","name":"ci_fx.f","args":["text","bigint"],"returns":"SETOF int8"}') = '', 'SETOF alias';
  ASSERT pg_temp.el('{"element":"rpc","name":"ci_fx.f","args":["text","bigint"],"returns":"setof integer"}') = 'type_mismatch:error',
    'a different SETOF type';
  ASSERT pg_temp.el('{"element":"rpc","name":"ci_fx.f","args":["text","bigint"],"returns":"bigint"}') = 'type_mismatch:error',
    'SETOF vs scalar';
  ASSERT pg_temp.el('{"element":"rpc","name":"ci_fx.h","args":["int4"],"returns":"int4"}') = '', 'scalar alias';
  ASSERT pg_temp.el('{"element":"rpc","name":"ci_fx.g","args":[],"returns":"TABLE(a integer, b text)"}') = '', 'TABLE result';
  ASSERT pg_temp.el('{"element":"rpc","name":"ci_fx.g","args":[],"returns":"table( a integer,b text )"}') = '', 'TABLE spacing and case';
  ASSERT pg_temp.el('{"element":"rpc","name":"ci_fx.g","args":[],"returns":"TABLE(a integer, c text)"}') = 'type_mismatch:error',
    'a different TABLE result';
END $$;

-- ---------------------------------------------------------------------------
-- dimension and module: no registries yet
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  ASSERT pg_temp.el('{"element":"dimension","key":"program","table":"public.programs","columns":{"key":"id","parent":"parent_id"}}')
    = 'missing_core_feature:error', 'dimension elements need metadata.dimensions';
  ASSERT pg_temp.el('{"element":"module","key":"people_served","version":"1.2"}') = 'missing_core_feature:error',
    'module elements need metadata.modules';
  ASSERT (SELECT name || '|' || expected FROM public.compare_interface('{"elements":[{"element":"module","key":"people_served"}]}'))
    = 'people_served|metadata.modules', 'the row names the key and the missing feature';
END $$;

-- ---------------------------------------------------------------------------
-- Malformed declarations: 22023
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  bad text;
BEGIN
  FOREACH bad IN ARRAY ARRAY[
    '[]',
    '{"template":"t"}',
    '{"elements":{}}',
    '{"elements":[],"extra":1}',
    '{"template":5,"elements":[]}',
    '{"elements":[1]}',
    '{"elements":[{"element":"view","name":"ci_fx.programs"}]}',
    '{"elements":[{"name":"ci_fx.programs"}]}',
    '{"elements":[{"element":"table"}]}',
    '{"elements":[{"element":"table","name":"programs"}]}',
    '{"elements":[{"element":"table","name":"ci_fx.programs","colums":[]}]}',
    '{"elements":[{"element":"table","name":"ci_fx.programs","columns":{}}]}',
    '{"elements":[{"element":"table","name":"ci_fx.programs","writes":"yes"}]}',
    '{"elements":[{"element":"table","name":"ci_fx.programs","columns":[{"type":"text"}]}]}',
    '{"elements":[{"element":"table","name":"ci_fx.programs","columns":[{"name":"id","typ":"text"}]}]}',
    '{"elements":[{"element":"table","name":"ci_fx.programs","columns":[{"name":"id","type":"no_such_type"}]}]}',
    '{"elements":[{"element":"table","name":"ci_fx.programs","columns":[{"name":"id","nullable":"no"}]}]}',
    '{"elements":[{"element":"table","name":"ci_fx.programs","columns":[{"name":"id","references":"ci_fx.programs"}]}]}',
    '{"elements":[{"element":"rpc","name":"ci_fx.f"}]}',
    '{"elements":[{"element":"rpc","name":"f","args":[]}]}',
    '{"elements":[{"element":"rpc","name":"ci_fx.f","args":["no_such_type"]}]}',
    '{"elements":[{"element":"rpc","name":"ci_fx.f","args":[],"returns":"no_such_type"}]}',
    '{"elements":[{"element":"dimension"}]}',
    '{"elements":[{"element":"dimension","key":"p","columns":{"owner":"x"}}]}',
    '{"elements":[{"element":"dimension","key":"p","table":"programs"}]}',
    '{"elements":[{"element":"module","key":"m","version":"1.2.3"}]}'
  ] LOOP
    ASSERT pg_temp.expect_sqlstate(format('SELECT * FROM public.compare_interface(%L::jsonb)', bad), '22023'),
      format('malformed declaration is 22023: %s', bad);
  END LOOP;
  ASSERT pg_temp.expect_sqlstate('SELECT * FROM public.compare_interface(NULL)', '22023'), 'NULL is 22023';
  -- a malformed element raises even when an earlier element already differs
  ASSERT pg_temp.expect_sqlstate($q$SELECT * FROM public.compare_interface(
    '{"elements":[{"element":"table","name":"ci_fx.nope"},{"element":"table","name":"x"}]}')$q$, '22023'),
    'malformed beats differences';
END $$;

-- ---------------------------------------------------------------------------
-- Row order, template and source
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_order text;
BEGIN
  SELECT string_agg(element || ':' || name || ':' || coalesce(column_name, '-') || ':' || difference, ' | ')
    INTO v_order
  FROM public.compare_interface($j${"template":"tpl@2","elements":[
    {"element":"table","name":"ci_fx.programs","source":"shared/program","columns":[
      {"name":"notes","nullable":false},{"name":"gone"},{"name":"mid","type":"bigint"}]},
    {"element":"rpc","name":"ci_fx.nope","args":[]},
    {"element":"table","name":"ci_fx.absent"}]}$j$);
  ASSERT v_order = 'rpc:ci_fx.nope:-:missing_rpc | table:ci_fx.absent:-:missing_table | table:ci_fx.programs:gone:missing_column | table:ci_fx.programs:mid:type_mismatch | table:ci_fx.programs:notes:nullability_mismatch',
    format('rows are ordered by element, name and column: %s', v_order);
  ASSERT (SELECT bool_and(template = 'tpl@2') FROM public.compare_interface(
    '{"template":"tpl@2","elements":[{"element":"table","name":"ci_fx.absent"}]}')), 'template is echoed';
  ASSERT (SELECT source FROM public.compare_interface(
    '{"elements":[{"element":"table","name":"ci_fx.absent","source":"shared/program"}]}')) = 'shared/program', 'source is echoed';
END $$;

-- ---------------------------------------------------------------------------
-- assert_interface()
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_state text; v_msg text; v_detail text;
BEGIN
  -- a match and info-only rows pass
  PERFORM public.assert_interface('{"elements":[{"element":"table","name":"ci_fx.programs","columns":[{"name":"id","type":"bigint"}]}]}');
  PERFORM public.assert_interface('{"elements":[{"element":"table","name":"ci_fx.programs","columns":[{"name":"mid","type":"smallint"}]}]}');

  BEGIN
    PERFORM public.assert_interface($j${"template":"people_served@1.1.0","elements":[
      {"element":"table","name":"ci_fx.programs","source":"shared/program","columns":[
        {"name":"mid","type":"bigint"},{"name":"small","type":"smallint"},{"name":"display_name","type":"varchar(10)"}]}]}$j$);
    RAISE EXCEPTION 'assert_interface did not raise';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT, v_detail = PG_EXCEPTION_DETAIL;
  END;
  ASSERT v_state = '55000', format('an error row raises 55000, got %s', v_state);
  ASSERT v_msg = 'interface check failed for people_served@1.1.0: 1 difference', format('message: %s', v_msg);
  ASSERT v_detail = 'ci_fx.programs.mid: type integer, required bigint (required by shared/program)', format('detail: %s', v_detail);

  BEGIN
    PERFORM public.assert_interface('{"elements":[{"element":"table","name":"ci_fx.absent"},{"element":"rpc","name":"ci_fx.nope","args":["text"]}]}');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT, v_detail = PG_EXCEPTION_DETAIL;
  END;
  ASSERT v_msg = 'interface check failed for (unnamed): 2 differences', format('plural message: %s', v_msg);
  ASSERT v_detail = E'ci_fx.nope: function ci_fx.nope(text) is missing\nci_fx.absent: table is missing', format('one line per error: %s', v_detail);

  ASSERT pg_temp.expect_sqlstate($q$SELECT public.assert_interface('{"elements":[{"element":"table"}]}')$q$, '22023'),
    'a malformed declaration raises 22023 through assert_interface too';
END $$;

-- ---------------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA ci_fx TO authenticated;
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  ASSERT pg_temp.el('{"element":"table","name":"ci_fx.programs","columns":[{"name":"mid","type":"bigint"}]}') = 'type_mismatch:error',
    'authenticated can call compare_interface';
  PERFORM public.assert_interface('{"elements":[{"element":"table","name":"ci_fx.programs","columns":[{"name":"id"}]}]}');
END $$;
RESET ROLE;
SET LOCAL ROLE web_anon;
DO $$
BEGIN
  ASSERT pg_temp.expect_sqlstate($q$SELECT * FROM public.compare_interface('{"elements":[]}')$q$, '42501'),
    'web_anon cannot call compare_interface';
  ASSERT pg_temp.expect_sqlstate($q$SELECT public.assert_interface('{"elements":[]}')$q$, '42501'),
    'web_anon cannot call assert_interface';
END $$;
RESET ROLE;

ROLLBACK;
SQL
then
  echo "PASS: compare_interface() difference codes, type rules, malformed input, assert_interface() and grants"
else
  echo "FAIL: interface comparison checks failed (see the assertion above)"
  exit 1
fi
