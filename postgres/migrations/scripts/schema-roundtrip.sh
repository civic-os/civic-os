#!/usr/bin/env bash
# Copyright (C) 2023-2026 Civic OS, L3C
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Schema round-trip verification for Sqitch migrations.
#
# A revert script that does not fully undo its deploy script is invisible to
# `sqitch revert` (it succeeds) and usually to `sqitch deploy --verify` too. This
# script catches it by comparing normalized schema-only dumps taken at known
# points of a deploy / revert cycle (see .github/workflows/test.yml):
#
#   dump <target-uri> <outfile>
#       Write a normalized schema dump of the database.
#
#   compare <before> <after> <label>
#       Diff two dumps; exit 1 with the diff if they differ.
#
#   stepwise <target-uri> <workdir> <strict-after-change>
#       On an EMPTY database (no sqitch registry): deploy the plan up to and
#       including <strict-after-change>, then one change at a time, dumping the
#       schema after each. Then revert one change at a time from the head. After
#       reverting change N the schema must equal the dump taken after deploying
#       change N-1. Only changes AFTER <strict-after-change> are held to this;
#       earlier (legacy, immutable) reverts are known to be inexact (they restore
#       older function bodies/comments, leave extensions, or drop view options).
#       Runs from the repo root (sqitch.conf). Leaves the database at
#       <strict-after-change>.
#
# <target-uri> is a Sqitch target (db:pg://user:pass@host:port/dbname). It is
# converted to a libpq URI for pg_dump. Set PG_DUMP to use a specific pg_dump
# command (word-split; it must be >= the server's major version, and must write
# the dump to stdout).
#
# Moved columns: a change that drops a column can only re-add it at the end of the
# table on revert (Postgres has no column reordering short of rebuilding the table).
# Each schema.table.column listed in MOVED_COLUMNS is cut from its place in every dump,
# with its COMMENT ON COLUMN, and appended at the end of the dump, so its position is
# ignored while its definition and comment are still compared. Add an entry only for a
# column a strict-era change drops, and name that change.
#
# Fails loudly on any tool error: nothing here is allowed to silently skip.

set -euo pipefail

MOVED_COLUMNS=(
  metadata.entities.show_in_sidebar  # v0-81-0-menu-nodes drops it; the revert re-adds it last
)

usage() {
  echo "Usage: $0 dump <target-uri> <outfile>" >&2
  echo "       $0 compare <before.sql> <after.sql> <label>" >&2
  echo "       $0 stepwise <target-uri> <workdir> <strict-after-change>" >&2
  exit 2
}

# Filter: cut each listed column (space-separated schema.table.column) from its CREATE TABLE,
# re-comma the remaining items, cut its COMMENT ON COLUMN statement (which may span lines),
# and append both at the end under a fixed marker. Unlisted tables pass through unchanged.
move_columns() {
  awk -v moved="$1" -v q="'" '
    BEGIN {
      n = split(moved, list, " ")
      for (i = 1; i <= n; i++) {
        t = list[i]; sub(/\.[^.]*$/, "", t)
        c = list[i]; sub(/^.*\./, "", c)
        cols[t, c] = 1; tables[t] = 1
        comments["COMMENT ON COLUMN " list[i] " IS "] = list[i]
      }
    }
    function flush_table(   i, kept, k, line) {
      print header
      k = 0
      for (i = 1; i <= ni; i++) {
        line = items[i]
        name = line; sub(/^ +/, "", name); sub(/ .*/, "", name)
        if ((table, name) in cols) { sub(/,$/, "", line); tail = tail "MOVED COLUMN " table ":" line "\n"; continue }
        kept[++k] = line
      }
      for (i = 1; i <= k; i++) {
        line = kept[i]; sub(/,$/, "", line)
        print line (i < k ? "," : "")
      }
      print ");"
    }
    in_table { if ($0 == ");") { flush_table(); in_table = 0 } else items[++ni] = $0; next }
    in_comment { tail = tail $0 "\n"; if ($0 ~ (q ";$")) in_comment = 0; next }
    /^CREATE TABLE / && ($3 in tables) && $4 == "(" { in_table = 1; ni = 0; table = $3; header = $0; next }
    /^COMMENT ON COLUMN / {
      for (p in comments) if (index($0, p) == 1) {
        tail = tail "MOVED COMMENT " $0 "\n"
        if ($0 !~ (q ";$")) in_comment = 1
        next
      }
    }
    { print }
    END {
      if (in_table) { print "ERROR: no closing \");\" for " table " (table options?); extend move_columns" > "/dev/stderr"; exit 1 }
      if (tail != "") printf "\n%s", tail
    }
  '
}

cmd_dump() {
  [ $# -eq 2 ] || usage
  local target="$1" outfile="$2" uri
  case "$target" in
    db:pg://*) uri="postgresql://${target#db:pg://}" ;;
    db:postgres://*) uri="postgresql://${target#db:postgres://}" ;;
    postgresql://*|postgres://*) uri="$target" ;;
    *) echo "ERROR: unsupported target URI scheme (expected db:pg://...)" >&2; exit 2 ;;
  esac

  local raw
  raw="$(mktemp)"
  trap 'rm -f "$raw"' RETURN

  # Sqitch's own registry lives in the metadata schema (sqitch.conf: registry =
  # metadata). Its rows legitimately differ between cycle points, so exclude it.
  # PG_DUMP may be a multi-word command (e.g. "docker run --rm --network host <image> pg_dump").
  # shellcheck disable=SC2086
  ${PG_DUMP:-pg_dump} "$uri" \
    --schema-only \
    --no-owner \
    --exclude-schema=information_schema \
    --exclude-schema=pg_catalog \
    --exclude-table='metadata.changes' \
    --exclude-table='metadata.dependencies' \
    --exclude-table='metadata.events' \
    --exclude-table='metadata.projects' \
    --exclude-table='metadata.releases' \
    --exclude-table='metadata.tags' \
    --exclude-table='public.spatial_ref_sys' \
    > "$raw"

  # Strip volatile lines: comments (version banner), session SETs, set_config,
  # and psql \restrict / \unrestrict tokens (random per dump on recent pg_dump).
  grep -v -E '^(--|SET |SELECT pg_catalog\.set_config|\\restrict |\\unrestrict )' "$raw" \
    | move_columns "${MOVED_COLUMNS[*]}" \
    | cat -s > "$outfile"

  if [ ! -s "$outfile" ]; then
    echo "ERROR: schema dump is empty: $outfile" >&2
    exit 1
  fi
  echo "Wrote $(wc -l < "$outfile" | tr -d ' ') lines to $outfile"
}

cmd_compare() {
  [ $# -eq 3 ] || usage
  local before="$1" after="$2" label="$3"
  [ -s "$before" ] || { echo "ERROR: missing or empty dump: $before" >&2; exit 1; }
  [ -s "$after" ]  || { echo "ERROR: missing or empty dump: $after" >&2; exit 1; }
  if diff -u --label "before: $label" --label "after: $label" "$before" "$after"; then
    echo "OK: schema identical ($label)"
  else
    echo "FAIL: schema differs ($label). A revert script does not fully undo its deploy script." >&2
    exit 1
  fi
}

cmd_stepwise() {
  [ $# -eq 3 ] || usage
  local target="$1" work="$2" boundary="$3" self
  self="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
  mkdir -p "$work"

  # Capture to a variable so a sqitch failure aborts (set -e does not see a pipe's left side).
  local plan
  plan="$(sqitch plan --format 'format:%n' --no-headers)"
  local -a changes=()
  local line
  while IFS= read -r line; do
    if [ -n "$line" ]; then changes+=("$line"); fi
  done <<< "$plan"
  local n=${#changes[@]}

  local b=-1 i
  for ((i = 0; i < n; i++)); do
    if [ "${changes[i]}" = "$boundary" ]; then b=$i; fi
  done
  [ "$b" -ge 0 ] || { echo "ERROR: strict-after change '$boundary' is not in the plan" >&2; exit 1; }
  if [ "$b" -ge $((n - 1)) ]; then
    echo "ERROR: no changes after '$boundary' to check; the boundary is the plan head" >&2
    exit 1
  fi

  sqitch deploy "$target" --to "$boundary" --verify
  "$self" dump "$target" "$work/up-$b.sql" > /dev/null
  for ((i = b + 1; i < n; i++)); do
    sqitch deploy "$target" --to "${changes[i]}" --verify
    "$self" dump "$target" "$work/up-$i.sql" > /dev/null
  done
  echo "Deployed ${changes[b]} then $((n - 1 - b)) change(s) one at a time."

  local failures=0
  for ((i = n - 1; i > b; i--)); do
    sqitch revert "$target" --to "${changes[i-1]}" -y
    "$self" dump "$target" "$work/down-$((i-1)).sql" > /dev/null
    if ! diff -u --label "after deploying ${changes[i-1]}" --label "after reverting ${changes[i]}" \
         "$work/up-$((i-1)).sql" "$work/down-$((i-1)).sql" > "$work/diff-$i.txt"; then
      echo "FAIL: reverting ${changes[i]} does not restore the schema from before it was deployed" >&2
      head -80 "$work/diff-$i.txt" >&2
      failures=$((failures + 1))
    fi
  done

  if [ "$failures" -ne 0 ]; then
    echo "FAIL: $failures revert script(s) after '$boundary' do not fully undo their deploys" >&2
    exit 1
  fi
  echo "OK: all $((n - 1 - b)) revert script(s) after '$boundary' restore the prior schema"
}

[ $# -ge 1 ] || usage
sub="$1"; shift
case "$sub" in
  dump) cmd_dump "$@" ;;
  compare) cmd_compare "$@" ;;
  stepwise) cmd_stepwise "$@" ;;
  *) usage ;;
esac
