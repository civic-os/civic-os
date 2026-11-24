#!/bin/bash
# =============================================================================
# Functional Test: v0-87-0 file reconcile (SQL)
# =============================================================================
# Covers the worker-only functions of v0-87-0-file-reconcile on throwaway tables, in one rolled-back
# transaction, so it runs on a bare migrated database (CI) as well as on an example stack:
#   - unclaimed_file_references(): finds staged files referenced from public tables (a mixed-case name, a
#     text primary key); first owner by table name, then the lowest key numerically; leaves out claimed
#     files, photo_gallery files, files whose thumbnail job is live, references from tables without a
#     single-column primary key and from other schemas; honors the limit.
#   - claim_file(): claimed, claimed_elsewhere (a second call), stale (an old updated_at), unreferenced;
#     22023 for a column that does not reference metadata.files and for an empty entity id.
#   - delete_orphaned_staged_files(): deletes only unreferenced staged rows older than the TTL, never one
#     referenced from any schema (a CASCADE reference included), a gallery file or one with a live
#     thumbnail job; refuses a TTL under 1 hour (22023).
#   - staged_file_states(), delete_stale_upload_requests() (22023 under 1 hour).
#   - Every function is a definer with a fixed search_path, closed to web_anon and authenticated; the
#     partial index exists; error.attachment_expired is seeded in six locales.
#
# Usage:
#   ./tests/functional/v0-87-0-file-reconcile-sql-test.sh
#
# Environment overrides (the psql user must be a superuser):
#   DATABASE_URL   postgres://postgres:securepassword123@localhost:15432/civic_os_db
#
# Copyright (C) 2023-2026 Civic OS, L3C
# AGPL-3.0-or-later
# =============================================================================

set -uo pipefail

DATABASE_URL="${DATABASE_URL:-postgres://postgres:securepassword123@localhost:15432/civic_os_db}"

RED='\033[0;31m'; GREEN='\033[0;32m'; BOLD='\033[1m'; NC='\033[0m'

echo -e "${BOLD}v0-87-0 file reconcile: SQL functions (rolled back)${NC}"

OUT=$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -o /dev/null 2>&1 <<'SQL'
BEGIN;
SET LOCAL client_min_messages = notice;

CREATE FUNCTION pg_temp.expect_sqlstate(p_sql text, p_state text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RETURN false;
EXCEPTION WHEN OTHERS THEN
  RETURN SQLSTATE = p_state;
END $$;

-- A file row; thumbnail_status 'pending' makes the insert trigger queue a thumbnail job.
CREATE FUNCTION pg_temp.file(p_id uuid, p_type text, p_entity text, p_status text DEFAULT 'not_applicable') RETURNS uuid
LANGUAGE sql AS $$
  INSERT INTO metadata.files (id, entity_type, entity_id, file_name, file_type, file_size, s3_original_key, thumbnail_status)
  VALUES (p_id, p_type, p_entity, 'f.png', 'image/png', 1,
          p_type || '/' || CASE WHEN p_entity = '' THEN '_new' ELSE p_entity END || '/' || p_id || '/original.png', p_status)
  RETURNING id
$$;

CREATE FUNCTION pg_temp.refs() RETURNS text LANGUAGE sql AS $$
  SELECT coalesce(string_agg(right(file_id::text, 2) || '>' || table_name || ':' || entity_id || ':' || column_name, ',' ORDER BY file_id), '')
  FROM metadata.unclaimed_file_references(100)
$$;

CREATE TABLE public."FR Items" (id BIGSERIAL PRIMARY KEY, photo UUID REFERENCES metadata.files(id), doc UUID REFERENCES metadata.files(id));
CREATE TABLE public.fr_text (code TEXT PRIMARY KEY, doc UUID REFERENCES metadata.files(id));
CREATE TABLE public.fr_nopk (doc UUID REFERENCES metadata.files(id));
CREATE SCHEMA fr_x;
CREATE TABLE fr_x.links (id BIGSERIAL PRIMARY KEY, doc UUID REFERENCES metadata.files(id) ON DELETE CASCADE);

-- staged files: 01 referenced twice in "FR Items" (ids 2 and 10) and once in fr_text; 02 unreferenced;
-- 03 claimed; 04 a gallery file; 05 referenced only from a table without a key and from fr_x;
-- 06 referenced, with a live thumbnail job; 07 referenced from fr_text (text key)
SELECT pg_temp.file('00000000-0000-7000-8000-000000000001', 'FR Items', '');
SELECT pg_temp.file('00000000-0000-7000-8000-000000000002', 'FR Items', '');
SELECT pg_temp.file('00000000-0000-7000-8000-000000000003', 'FR Items', '5');
SELECT pg_temp.file('00000000-0000-7000-8000-000000000004', 'photo_gallery', '');
SELECT pg_temp.file('00000000-0000-7000-8000-000000000005', 'FR Items', '');
SELECT pg_temp.file('00000000-0000-7000-8000-000000000006', 'FR Items', '', 'pending');
SELECT pg_temp.file('00000000-0000-7000-8000-000000000007', 'fr_text', '');

INSERT INTO public."FR Items" (id, photo) VALUES (10, '00000000-0000-7000-8000-000000000001'), (2, '00000000-0000-7000-8000-000000000001'),
  (3, '00000000-0000-7000-8000-000000000003'), (4, '00000000-0000-7000-8000-000000000004'), (6, '00000000-0000-7000-8000-000000000006');
INSERT INTO public.fr_text VALUES ('a', '00000000-0000-7000-8000-000000000001'), ('b', '00000000-0000-7000-8000-000000000007');
INSERT INTO public.fr_nopk VALUES ('00000000-0000-7000-8000-000000000005');
INSERT INTO fr_x.links (doc) VALUES ('00000000-0000-7000-8000-000000000005');

DO $$
DECLARE
  v_seen timestamptz;
  v_n int;
BEGIN
  -- ---- discovery -----------------------------------------------------------
  ASSERT (SELECT count(*) FROM metadata._file_reference_columns(true) WHERE table_name IN ('FR Items', 'fr_text', 'fr_nopk', 'links')) = 3,
    'claimable columns: FR Items.photo, FR Items.doc, fr_text.doc (not the keyless table, not fr_x)';
  ASSERT (SELECT count(*) FROM metadata._file_reference_columns(false) WHERE table_name IN ('FR Items', 'fr_text', 'fr_nopk', 'links')) = 5,
    'all reference columns include the keyless table and fr_x.links';
  ASSERT metadata._file_thumbnail_job_live('00000000-0000-7000-8000-000000000006'), 'the pending insert queued a live thumbnail job';
  ASSERT pg_temp.refs() = '01>FR Items:2:photo,07>fr_text:b:doc',
    format('first owner by table then numeric key; claimed, gallery, keyless/other-schema and live-job files left out; got %s', pg_temp.refs());
  ASSERT (SELECT count(*) FROM metadata.unclaimed_file_references(1)) = 1, 'the limit applies to the references returned';

  UPDATE metadata.river_job SET state = 'completed', finalized_at = now()
  WHERE kind = 'thumbnail_generate' AND args->>'file_id' = '00000000-0000-7000-8000-000000000006';
  ASSERT NOT metadata._file_thumbnail_job_live('00000000-0000-7000-8000-000000000006'), 'a completed job is not live';
  ASSERT pg_temp.refs() LIKE '%06>FR Items:6:photo%', 'with its job finished, file 06 is claimable';

  -- ---- claim_file ----------------------------------------------------------
  SELECT f.updated_at INTO v_seen FROM metadata.files f WHERE f.id = '00000000-0000-7000-8000-000000000001';
  ASSERT metadata.claim_file('00000000-0000-7000-8000-000000000001', 'FR Items', 'photo', '2', v_seen - interval '1 second',
           'FR Items/2/00000000-0000-7000-8000-000000000001/original.png', NULL, NULL, NULL) = 'stale', 'an old updated_at is stale';
  ASSERT metadata.claim_file('00000000-0000-7000-8000-000000000001', 'FR Items', 'photo', '3', v_seen,
           'FR Items/3/00000000-0000-7000-8000-000000000001/original.png', NULL, NULL, NULL) = 'unreferenced', 'row 3 does not reference file 01';
  ASSERT metadata.claim_file('00000000-0000-7000-8000-000000000001', 'FR Items', 'photo', '2', v_seen,
           'FR Items/2/00000000-0000-7000-8000-000000000001/original.png', 'FR Items/2/00000000-0000-7000-8000-000000000001/thumb-small.jpg', NULL, NULL) = 'claimed',
    'the first owner claims it';
  ASSERT (SELECT f.entity_type = 'FR Items' AND f.entity_id = '2'
                 AND f.s3_original_key = 'FR Items/2/00000000-0000-7000-8000-000000000001/original.png'
                 AND f.s3_thumbnail_small_key = 'FR Items/2/00000000-0000-7000-8000-000000000001/thumb-small.jpg'
                 AND f.s3_key_prefix = 'FR Items/2/00000000-0000-7000-8000-000000000001'
          FROM metadata.files f WHERE f.id = '00000000-0000-7000-8000-000000000001'), 'the row carries its record and new keys';
  ASSERT metadata.claim_file('00000000-0000-7000-8000-000000000001', 'FR Items', 'photo', '2', v_seen,
           'FR Items/2/00000000-0000-7000-8000-000000000001/original.png', NULL, NULL, NULL) = 'claimed_elsewhere',
    'a second claim to the same keys is claimed_elsewhere';
  ASSERT metadata.claim_file('00000000-0000-7000-8000-000000000001', 'FR Items', 'photo', '2', v_seen,
           'other/key.png', NULL, NULL, NULL) = 'stale', 'a second claim to other keys is stale';
  ASSERT (SELECT fr.photo FROM public."FR Items" fr WHERE fr.id = 10) = '00000000-0000-7000-8000-000000000001',
    'the other reference still points at the shared file';

  SELECT f.updated_at INTO v_seen FROM metadata.files f WHERE f.id = '00000000-0000-7000-8000-000000000007';
  ASSERT metadata.claim_file('00000000-0000-7000-8000-000000000007', 'fr_text', 'doc', 'b', v_seen,
           'fr_text/b/00000000-0000-7000-8000-000000000007/original.png', NULL, NULL, NULL) = 'claimed', 'a text primary key claims';

  ASSERT pg_temp.expect_sqlstate($q$SELECT metadata.claim_file('00000000-0000-7000-8000-000000000002', 'fr_nopk', 'doc', '1', now(), 'k', NULL, NULL, NULL)$q$, '22023'),
    'a table without a single-column key is refused';
  ASSERT pg_temp.expect_sqlstate($q$SELECT metadata.claim_file('00000000-0000-7000-8000-000000000002', 'FR Items', 'note', '1', now(), 'k', NULL, NULL, NULL)$q$, '22023'),
    'a column that is not a file reference is refused';
  ASSERT pg_temp.expect_sqlstate($q$SELECT metadata.claim_file('00000000-0000-7000-8000-000000000002', 'FR Items', 'photo', '', now(), 'k', NULL, NULL, NULL)$q$, '22023'),
    'an empty entity id is refused';

  -- ---- orphans -------------------------------------------------------------
  PERFORM pg_temp.file('00000000-0000-7000-8000-000000000008', 'FR Items', '');            -- young, unreferenced: kept
  PERFORM pg_temp.file('00000000-0000-7000-8000-000000000009', 'FR Items', '', 'pending'); -- old, live job: kept
  UPDATE metadata.files f SET created_at = now() - interval '8 days'
  WHERE f.id IN ('00000000-0000-7000-8000-000000000002', '00000000-0000-7000-8000-000000000004',
                 '00000000-0000-7000-8000-000000000005', '00000000-0000-7000-8000-000000000006',
                 '00000000-0000-7000-8000-000000000009');

  ASSERT pg_temp.expect_sqlstate($q$SELECT * FROM metadata.delete_orphaned_staged_files(interval '59 minutes')$q$, '22023'),
    'a TTL under an hour is refused';
  ASSERT (SELECT string_agg(right(file_id::text, 2) || ':' || s3_original_key, ',')
          FROM metadata.delete_orphaned_staged_files(interval '7 days', 100))
         = '02:FR Items/_new/00000000-0000-7000-8000-000000000002/original.png',
    'only the old unreferenced staged file is deleted, with its keys returned';
  ASSERT (SELECT count(*) FROM metadata.files f WHERE f.id IN ('00000000-0000-7000-8000-000000000004',
            '00000000-0000-7000-8000-000000000005', '00000000-0000-7000-8000-000000000006',
            '00000000-0000-7000-8000-000000000008', '00000000-0000-7000-8000-000000000009')) = 5,
    'gallery, CASCADE-referenced, referenced, young and live-job files are kept';
  ASSERT (SELECT count(*) FROM fr_x.links) = 1, 'the CASCADE reference in another schema is intact';

  -- ---- staged states, upload requests --------------------------------------
  ASSERT (SELECT string_agg(right(file_id::text, 2) || ':' || claimed, ',' ORDER BY file_id)
          FROM metadata.staged_file_states(ARRAY['00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002',
                                                 '00000000-0000-7000-8000-000000000005']::uuid[]))
         = '01:true,05:false', 'claimed and staged rows are reported, a missing one is not';

  INSERT INTO metadata.file_upload_requests (entity_type, entity_id, file_name, file_type, created_at)
  VALUES ('FR Items', '', 'old.png', 'image/png', now() - interval '25 hours'), ('FR Items', '', 'new.png', 'image/png', now());
  v_n := metadata.delete_stale_upload_requests();
  ASSERT v_n >= 1 AND NOT EXISTS (SELECT 1 FROM metadata.file_upload_requests r WHERE r.file_name = 'old.png')
         AND EXISTS (SELECT 1 FROM metadata.file_upload_requests r WHERE r.file_name = 'new.png'),
    'upload requests older than 24 hours are deleted, newer ones kept';
  ASSERT pg_temp.expect_sqlstate($q$SELECT metadata.delete_stale_upload_requests(interval '10 minutes')$q$, '22023'),
    'an age under an hour is refused';

  -- ---- privileges, index, translations --------------------------------------
  ASSERT (SELECT count(*) FROM pg_proc p
          WHERE p.oid IN ('metadata._file_thumbnail_job_live(uuid)'::regprocedure,
                          'metadata._file_reference_columns(boolean)'::regprocedure,
                          'metadata.unclaimed_file_references(integer)'::regprocedure,
                          'metadata.claim_file(uuid,name,name,text,timestamptz,text,text,text,text)'::regprocedure,
                          'metadata.delete_orphaned_staged_files(interval,integer)'::regprocedure,
                          'metadata.staged_file_states(uuid[])'::regprocedure,
                          'metadata.delete_stale_upload_requests(interval)'::regprocedure)
            AND p.prosecdef AND p.proconfig IS NOT NULL
            AND NOT has_function_privilege('web_anon', p.oid, 'EXECUTE')
            AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')) = 7,
    'all seven functions are definers with a fixed search_path, closed to web_anon and authenticated';
  ASSERT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'metadata' AND indexname = 'idx_files_unclaimed'
                 AND indexdef LIKE '%WHERE (entity_id = ''''::text)%'), 'the partial index on staged rows exists';
  ASSERT (SELECT count(*) FROM metadata.translations WHERE source_type = 'ui' AND source_key = 'error.attachment_expired'
          AND translated_text LIKE '%{{field}}%') = 6, 'error.attachment_expired in six locales, each naming the field';

  RAISE NOTICE 'ALL ASSERTIONS PASSED';
END $$;

ROLLBACK;
SQL
)
RC=$?

if [ $RC -eq 0 ] && echo "$OUT" | grep -q "ALL ASSERTIONS PASSED"; then
  echo -e "  ${GREEN}PASS${NC} discovery, claim outcomes, orphan deletion, staged states, upload requests, privileges, index, translations"
  exit 0
fi
echo -e "  ${RED}FAIL${NC}"
echo "$OUT"
exit 1
