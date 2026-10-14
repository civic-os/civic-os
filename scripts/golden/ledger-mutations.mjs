#!/usr/bin/env node
/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Source mutations for scripts/golden/ledger-mutation-check.sh.
 *
 * Each mutation changes one behavior the goldens cover, on the MCP side
 * (`mcp`: the MCP goldens are re-derived) or the frontend side (`frontend`:
 * the frontend goldens are re-derived, then the MCP goldens, which read their
 * inputs from them). The ledger must refuse every one of them (exit 2): its
 * reference models transcribe both code bases, so any behavior change,
 * including one that moves a side toward parity, has to be acknowledged by
 * updating the models and the rule catalogue.
 *
 * M1-M15: first P0.3 verifier round (anchors verbatim). V1-V5, FE-1, FE-2:
 * second verifier round. O1-O9, FE-3..FE-8: additional coverage.
 *
 *   node scripts/golden/ledger-mutations.mjs list            id <TAB> side <TAB> description
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
const SS = 'src/app/services/schema.service.ts';
const DS = 'src/app/services/data.service.ts';
const ES = 'src/app/services/error.service.ts';
const CE = 'src/app/utils/condition-evaluator.ts';
const SU = 'src/app/utils/search.utils.ts';
const anchorSel = '  const type = prop.type ?? EntityPropertyType.Unknown;\n';
const anchorStatus = '    const statuses = this.cache.getStatuses(entityType);\n    const normalized = name.trim().toLowerCase();';
const anchorEval = '  const recordValue = resolveFieldValue(record, field);\n';
const anchorHuman = '  toHumanMessage(constraintMessages?: Array<{ constraint_name: string; error_message: string }>): string {\n';

/** [id, side, what it breaks, file, find, replace] */
export const MUTATIONS = [
  ['M1-user-embed-rename', 'mcp', 'User embed field renamed', SB, anchorSel, anchorSel + "  if (type === EntityPropertyType.User) return `${col}:civic_os_users!${col}(id,display_name,name)`;\n"],
  ['M2-fk-embed-rename', 'mcp', 'FK embed field renamed', SB, anchorSel, anchorSel + "  if (type === EntityPropertyType.ForeignKeyName) return `${col}:${prop.join_table}!${col}(id,label)`;\n"],
  ['M3-operator-gte-to-gt', 'mcp', 'operator mapping gte -> gt', LR, 'function mapOperator(op: string): string {\n', "function mapOperator(op: string): string {\n  if (op.toLowerCase() === 'gte') return 'gt';\n"],
  ['M4-in-separator', 'mcp', 'in-list separator', LR, 'expression: `in.(${(value as Array<string | number>).join(\',\')})`', 'expression: `in.(${(value as Array<string | number>).join(\';\')})`'],
  ['M5-status-any-entity-type', 'mcp', 'status lookup across entity types', NR, anchorStatus, '    const statuses = [...this.cache.statuses].reverse();\n    const normalized = name.trim().toLowerCase();'],
  ['M6-status-case-sensitive', 'mcp', 'status lookup case-sensitive', NR, anchorStatus, '    const statuses = this.cache.getStatuses(entityType);\n    const normalized = name.trim();'],
  ['M7-user-detected-as-fk', 'mcp', 'User uuid detected as ForeignKeyName', SC, '  const hasFK = !!join_table && !!join_column;\n', "  const hasFK = !!join_table && !!join_column;\n  if (join_table === 'civic_os_users' && udt_name === 'uuid') return EntityPropertyType.ForeignKeyName;\n"],
  ['M8-loose-in', 'mcp', 'loose `in`', EA, anchorEval, anchorEval + "  if (operator === 'in') return Array.isArray(value) && value.some(v => v == recordValue);\n"],
  ['M9-is-null-empty-string', 'mcp', 'is_null treats empty string as null', EA, anchorEval, anchorEval + "  if (operator === 'is_null' && recordValue === '') return true;\n"],
  ['M10-23505-wrong-message', 'mcp', '23505 gets the permission message', PC, anchorHuman, anchorHuman + "    if (this.code === '23505') return 'Permission denied. You do not have access to perform this action.';\n"],
  ['M11-default-order-id-desc', 'mcp', 'default order id.asc -> id.desc', LR, "params['order'] = 'id.asc';", "params['order'] = 'id.desc';"],
  ['M12-get-record-no-id-filter', 'mcp', 'get_record filters id=gte', GR, '            id: `eq.${id}`,\n', '            id: `gte.${id}`,\n'],
  ['M13-range-off-by-one', 'mcp', 'Range end off by one', LR, 'const rangeEnd = offset + limit - 1;', 'const rangeEnd = offset + limit;'],
  ['M14-content-range-total', 'mcp', 'Content-Range total minus one', PC, "total: match[3] === '*' ? null : parseInt(match[3], 10),", "total: match[3] === '*' ? null : parseInt(match[3], 10) - 1,"],
  ['M15-substring-search-prefix-only', 'mcp', 'substring search prefix-only', LR, 'params[resolved.substring_search_column] = `ilike.*${search}*`;', 'params[resolved.substring_search_column] = `ilike.${search}*`;'],
  ['V1-describe-wording', 'mcp', 'condition-failure text reworded', EA, "case 'eq': return `${field} is ${fmt(actual)}, expected ${fmt(value)}`;", "case 'eq': return `${field} = ${fmt(actual)} (want ${fmt(value)})`;"],
  ['V2-condition-fetch-timestamps', 'mcp', 'condition fetch forces timestamps', EA, 'const selectStr = buildSelectString(allProperties);', 'const selectStr = buildSelectString(allProperties, { includeTimestamps: true });'],
  ['V3-column-substring-startswith', 'mcp', 'column substring match becomes prefix match', NR, '        p.column_name.includes(normalized),\n    );\n\n    if (substringMatches.length === 1) return substringMatches[0];', '        p.column_name.startsWith(normalized),\n    );\n\n    if (substringMatches.length === 1) return substringMatches[0];'],
  ['V4-rpc-renamed', 'mcp', 'execute_action calls a renamed RPC', EA, '        const response = await client.post<EntityActionResult>(\n          `rpc/${actionConfig.rpc_function}`,', '        const response = await client.post<EntityActionResult>(\n          `rpc/${actionConfig.rpc_function}_v2`,'],
  ['V5-float4-integer', 'mcp', 'float4 detected as IntegerNumber (probe only)', SC, "    case 'float4':\n    case 'float8': return EntityPropertyType.DecimalNumber;", "    case 'float4': return EntityPropertyType.IntegerNumber;\n    case 'float8': return EntityPropertyType.DecimalNumber;"],
  ['O1-user-embed-matches-frontend', 'mcp', 'User embed gains phone,email (toward parity; still a model change)', SB, 'return `${col}:civic_os_users!${col}(id,display_name,full_name)`;', 'return `${col}:civic_os_users!${col}(id,display_name,full_name,phone,email)`;'],
  ['O2-varchar-bpchar-textlong', 'mcp', 'varchar and bpchar (shared case) detected as TextLong', SC, "case 'bpchar': return EntityPropertyType.TextShort;", "case 'bpchar': return EntityPropertyType.TextLong;"],
  ['O3-default-order-display-name-desc', 'mcp', 'default order display_name.desc', LR, "params['order'] = 'display_name.asc';", "params['order'] = 'display_name.desc';"],
  ['O4-22p02-wording', 'mcp', '22P02 friendly type wording', PC, "integer: 'a whole number',", "integer: 'an integer',"],
  ['O5-category-case-sensitive', 'mcp', 'category lookup case-sensitive', NR, '    const categories = this.cache.getCategories(entityType);\n    const normalized = displayName.trim().toLowerCase();', '    const categories = this.cache.getCategories(entityType);\n    const normalized = displayName.trim();'],
  ['O6-ne-strict', 'mcp', '`ne` becomes strict (toward parity; still a model change)', EA, "case 'ne': return recordValue != value;", "case 'ne': return recordValue !== value;"],
  ['O7-get-record-no-timestamps', 'mcp', 'get_record stops forcing timestamps (fixes Q-12; still a model change)', GR, 'buildSelectString(allProperties, { includeTimestamps: true })', 'buildSelectString(allProperties)'],
  ['O8-edit-view-keeps-identity', 'mcp', 'filterProperties keeps identity/generated columns in edit views', SB, "if ((context === 'create' || context === 'edit') && (prop.is_identity || prop.is_generated)) {", "if (context === 'create' && (prop.is_identity || prop.is_generated)) {"],
  ['O9-status-no-trim', 'mcp', 'resolveStatus stops trimming its input', NR, anchorStatus, '    const statuses = this.cache.getStatuses(entityType);\n    const normalized = name.toLowerCase();'],
  ['FE-1-hybrid-ilike-prefix', 'frontend', 'buildHybridSearchParams ilike *x* -> x*', SU, 'clauses.push(`${col}.ilike.*${encoded}*`);', 'clauses.push(`${col}.ilike.${encoded}*`);'],
  ['FE-2-user-embed-drops-email', 'frontend', 'User embed drops email', SS, "'(id,display_name,full_name,phone,email)'", "'(id,display_name,full_name,phone)'"],
  ['FE-3-ne-loose', 'frontend', 'action evaluator `ne` becomes loose', CE, '            return fieldValue !== simple.value;', '            return fieldValue != simple.value;'],
  ['FE-4-23505-wording', 'frontend', 'parseToHuman 23505 reworded', ES, 'return "Record must be unique";', 'return "Duplicate record";'],
  ['FE-5-encode-filter-values', 'frontend', 'getData encodes filter values (fixes F-01 there; still a model change)', DS, '            args.push(`${filter.column}=${filter.operator}.${filter.value}`);', '            args.push(`${filter.column}=${filter.operator}.${encodeURIComponent(String(filter.value))}`);'],
  ['FE-6-structural-drops-status', 'frontend', 'ensureStructuralProps stops adding status_id', SS, "const structuralColumns = ['display_name', 'status_id', 'submitted_at'];", "const structuralColumns = ['display_name', 'submitted_at'];"],
  ['FE-7-preview-total-fallback', 'frontend', 'inverse preview total falls back to 0', DS, 'totalCount = match ? parseInt(match[1], 10) : records.length;', 'totalCount = match ? parseInt(match[1], 10) : 0;'],
  ['FE-8-money-decimal', 'frontend', 'getPropertyType maps money to DecimalNumber', SS, "['money'].includes(val.udt_name) ? EntityPropertyType.Money :", "['money'].includes(val.udt_name) ? EntityPropertyType.DecimalNumber :"],
];

function apply(root, id) {
  const m = MUTATIONS.find(x => x[0] === id);
  if (!m) throw new Error(`unknown mutation ${id}`);
  const [, , , file, find, replace] = m;
  const p = path.join(root, file);
  const text = fs.readFileSync(p, 'utf8');
  if (!text.includes(find)) throw new Error(`${id}: anchor not found in ${file}: ${JSON.stringify(find)}`);
  fs.writeFileSync(p, text.replace(find, replace));
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'list') {
  for (const [id, side, what] of MUTATIONS) console.log(`${id}\t${side}\t${what}`);
} else if (cmd === 'apply') {
  apply(args[0], args[1]);
} else if (cmd) {
  console.error('usage: ledger-mutations.mjs list | apply <root> <id>');
  process.exit(64);
}
