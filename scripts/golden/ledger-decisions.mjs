/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Decisions for the SDK divergence ledger.
 *
 * tests/golden/ledger-decisions.json is committed by hand and merged into each
 * ledger row's `decision` by scripts/golden/ledger.mjs. Shape:
 *
 *   { "<row id>": { "decision": "<kind>", "detail": "<one sentence>", "by": "<name>", "date": "YYYY-MM-DD" } }
 *
 * Kinds in use: adopt-mcp, adopt-frontend, fix, proposal, evidence-gated, keep,
 * deferred, not-divergence, informational.
 */
import * as fs from 'node:fs';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Reads the decisions file. A missing file is an empty object; malformed content throws. */
export function loadDecisions(file) {
  if (!fs.existsSync(file)) return {};
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${file} is not valid JSON: ${e.message}`);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error(`${file} must be an object keyed by row id`);
  return doc;
}

/** Shape problems, one string per problem. */
export function validateDecisions(decisions) {
  const problems = [];
  for (const [id, d] of Object.entries(decisions)) {
    if (!d || typeof d !== 'object' || Array.isArray(d)) { problems.push(`${id}: must be an object`); continue; }
    for (const k of ['decision', 'detail', 'by', 'date']) {
      if (typeof d[k] !== 'string' || !d[k].trim()) problems.push(`${id}: "${k}" must be a non-empty string`);
    }
    if (typeof d.date === 'string' && !DATE.test(d.date)) problems.push(`${id}: "date" must be YYYY-MM-DD`);
  }
  return problems;
}

/**
 * Merges decisions into ledger rows. Returns the merged rows, the decision ids
 * that name no ledger row (`unknown`, a hard error for the caller) and the row
 * ids left without a decision (`undecided`, a warning). A row's own
 * `decision` (from the rule catalogue) is kept when the file has none for it.
 */
export function mergeDecisions(rows, decisions) {
  const ids = new Set(rows.map(r => r.id));
  const unknown = Object.keys(decisions).filter(id => !ids.has(id)).sort();
  const merged = rows.map(r => (Object.hasOwn(decisions, r.id) ? { ...r, decision: decisions[r.id] } : r));
  const undecided = merged.filter(r => r.decision == null).map(r => r.id);
  return { rows: merged, unknown, undecided };
}
