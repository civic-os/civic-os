#!/usr/bin/env node
/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * MCP source mutations for scripts/golden/ledger-mutation-check.sh.
 *
 * Each mutation changes one MCP behavior the goldens cover. The ledger must
 * refuse every one of them (exit 2): its reference models transcribe the
 * current MCP code, so any behavior change, including one that moves the MCP
 * toward the frontend, has to be acknowledged by updating the models and the
 * rule catalogue. M1-M15 are the P0.3 verifier's mutations (anchors kept
 * verbatim); O1-O8 are additional ones covering other areas.
 *
 *   node scripts/golden/ledger-mutations.mjs list
 *   node scripts/golden/ledger-mutations.mjs apply <root> <id>
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const SB = 'tools/mcp-server/src/select-builder.ts';
const LR = 'tools/mcp-server/src/tools/list-records.ts';
const NR = 'tools/mcp-server/src/name-resolver.ts';
const SC = 'tools/mcp-server/src/schema-cache.ts';
const EA = 'tools/mcp-server/src/tools/execute-action.ts';
const PC = 'tools/mcp-server/src/postgrest-client.ts';
const GR = 'tools/mcp-server/src/tools/get-record.ts';
const anchorSel = '  const type = prop.type ?? EntityPropertyType.Unknown;\n';
const anchorStatus = '    const statuses = this.cache.getStatuses(entityType);\n    const normalized = name.trim().toLowerCase();';
const anchorEval = '  const recordValue = resolveFieldValue(record, field);\n';
const anchorHuman = '  toHumanMessage(constraintMessages?: Array<{ constraint_name: string; error_message: string }>): string {\n';

/** [id, what it breaks, file, find, replace] */
export const MUTATIONS = [
  ['M1-user-embed-rename', 'User embed field renamed', SB, anchorSel, anchorSel + "  if (type === EntityPropertyType.User) return `${col}:civic_os_users!${col}(id,display_name,name)`;\n"],
  ['M2-fk-embed-rename', 'FK embed field renamed', SB, anchorSel, anchorSel + "  if (type === EntityPropertyType.ForeignKeyName) return `${col}:${prop.join_table}!${col}(id,label)`;\n"],
  ['M3-operator-gte-to-gt', 'operator mapping gte -> gt', LR, 'function mapOperator(op: string): string {\n', "function mapOperator(op: string): string {\n  if (op.toLowerCase() === 'gte') return 'gt';\n"],
  ['M4-in-separator', 'in-list separator', LR, 'expression: `in.(${(value as Array<string | number>).join(\',\')})`', 'expression: `in.(${(value as Array<string | number>).join(\';\')})`'],
  ['M5-status-any-entity-type', 'status lookup across entity types', NR, anchorStatus, '    const statuses = [...this.cache.statuses].reverse();\n    const normalized = name.trim().toLowerCase();'],
  ['M6-status-case-sensitive', 'status lookup case-sensitive', NR, anchorStatus, '    const statuses = this.cache.getStatuses(entityType);\n    const normalized = name.trim();'],
  ['M7-user-detected-as-fk', 'User uuid detected as ForeignKeyName', SC, '  const hasFK = !!join_table && !!join_column;\n', "  const hasFK = !!join_table && !!join_column;\n  if (join_table === 'civic_os_users' && udt_name === 'uuid') return EntityPropertyType.ForeignKeyName;\n"],
  ['M8-loose-in', 'loose `in`', EA, anchorEval, anchorEval + "  if (operator === 'in') return Array.isArray(value) && value.some(v => v == recordValue);\n"],
  ['M9-is-null-empty-string', 'is_null treats empty string as null', EA, anchorEval, anchorEval + "  if (operator === 'is_null' && recordValue === '') return true;\n"],
  ['M10-23505-wrong-message', '23505 gets the permission message', PC, anchorHuman, anchorHuman + "    if (this.code === '23505') return 'Permission denied. You do not have access to perform this action.';\n"],
  ['M11-default-order-id-desc', 'default order id.asc -> id.desc', LR, "params['order'] = 'id.asc';", "params['order'] = 'id.desc';"],
  ['M12-get-record-no-id-filter', 'get_record filters id=gte', GR, '            id: `eq.${id}`,\n', '            id: `gte.${id}`,\n'],
  ['M13-range-off-by-one', 'Range end off by one', LR, 'const rangeEnd = offset + limit - 1;', 'const rangeEnd = offset + limit;'],
  ['M14-content-range-total', 'Content-Range total minus one', PC, "total: match[3] === '*' ? null : parseInt(match[3], 10),", "total: match[3] === '*' ? null : parseInt(match[3], 10) - 1,"],
  ['M15-substring-search-prefix-only', 'substring search prefix-only', LR, 'params[resolved.substring_search_column] = `ilike.*${search}*`;', 'params[resolved.substring_search_column] = `ilike.${search}*`;'],
  ['O1-user-embed-matches-frontend', 'User embed gains phone,email (toward parity; still a model change)', SB, 'return `${col}:civic_os_users!${col}(id,display_name,full_name)`;', 'return `${col}:civic_os_users!${col}(id,display_name,full_name,phone,email)`;'],
  ['O2-varchar-bpchar-textlong', 'varchar and bpchar (shared case) detected as TextLong', SC, "case 'bpchar': return EntityPropertyType.TextShort;", "case 'bpchar': return EntityPropertyType.TextLong;"],
  ['O3-default-order-display-name-desc', 'default order display_name.desc', LR, "params['order'] = 'display_name.asc';", "params['order'] = 'display_name.desc';"],
  ['O4-22p02-wording', '22P02 friendly type wording', PC, "integer: 'a whole number',", "integer: 'an integer',"],
  ['O5-category-case-sensitive', 'category lookup case-sensitive', NR, '    const categories = this.cache.getCategories(entityType);\n    const normalized = displayName.trim().toLowerCase();', '    const categories = this.cache.getCategories(entityType);\n    const normalized = displayName.trim();'],
  ['O6-ne-strict', '`ne` becomes strict (toward parity; still a model change)', EA, "case 'ne': return recordValue != value;", "case 'ne': return recordValue !== value;"],
  ['O7-get-record-no-timestamps', 'get_record stops forcing timestamps (fixes Q-12; still a model change)', GR, 'buildSelectString(allProperties, { includeTimestamps: true })', 'buildSelectString(allProperties)'],
  ['O8-edit-view-keeps-identity', 'filterProperties keeps identity/generated columns in edit views', SB, "if ((context === 'create' || context === 'edit') && (prop.is_identity || prop.is_generated)) {", "if (context === 'create' && (prop.is_identity || prop.is_generated)) {"],
  ['O9-status-no-trim', 'resolveStatus stops trimming its input', NR, anchorStatus, '    const statuses = this.cache.getStatuses(entityType);\n    const normalized = name.toLowerCase();'],
];

function apply(root, id) {
  const m = MUTATIONS.find(x => x[0] === id);
  if (!m) throw new Error(`unknown mutation ${id}`);
  const [, , file, find, replace] = m;
  const p = path.join(root, file);
  const text = fs.readFileSync(p, 'utf8');
  if (!text.includes(find)) throw new Error(`${id}: anchor not found in ${file}: ${JSON.stringify(find)}`);
  fs.writeFileSync(p, text.replace(find, replace));
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'list') {
  for (const [id, what] of MUTATIONS) console.log(`${id}\t${what}`);
} else if (cmd === 'apply') {
  apply(args[0], args[1]);
} else if (cmd) {
  console.error('usage: ledger-mutations.mjs list | apply <root> <id>');
  process.exit(64);
}
