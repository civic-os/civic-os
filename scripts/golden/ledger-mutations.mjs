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
 * second verifier round (V5 re-anchored to float4 only). N1-N7: third verifier
 * round, reconstructed from their names. O1-O9, FE-3..FE-8: additional coverage.
 *
 * P0.10 (after main's MCP fixes, b3f2eeb8): M14, N5, O6, O7 and V2 were
 * retargeted because their anchor is gone or the mutation became a no-op on
 * the fixed code (each keeps its id; the comment beside it says what changed).
 * R1-R7 are new: each re-breaks one row fixed on main without restoring the
 * removed text verbatim, so the models (not only the `absent` anchors) must
 * refuse it. R8 re-breaks C-05 on a path no golden reaches; it is marked
 * `coveredBy: 'probe'`: the check then requires no golden change, only that
 * the ledger's in-process probe of execute-action.ts refuses it (exit 2).
 *
 * Entry: [id, side, description, file, find, replace, options?]; `find` /
 * `replace` may be parallel arrays of edits, applied in order.
 *
 *   node scripts/golden/ledger-mutations.mjs list            id <TAB> side <TAB> description <TAB> golden | probe
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
const CPT = 'packages/core/src/schema/property-type.ts';
const CSEL = 'packages/core/src/schema/select.ts';
const DS = 'src/app/services/data.service.ts';
const ES = 'src/app/services/error.service.ts';
const CE = 'src/app/utils/condition-evaluator.ts';
const SU = 'src/app/utils/search.utils.ts';
const anchorSel = '  const type = prop.type ?? EntityPropertyType.Unknown;\n';
const anchorStatus = '    const statuses = this.cache.getStatuses(entityType);\n    const normalized = name.trim().toLowerCase();';
const anchorEval = '  const recordValue = resolveFieldValue(record, field);\n';
const anchorHuman = '  toHumanMessage(constraintMessages?: Array<{ constraint_name: string; error_message: string }>): string {\n';

/** [id, side, what it breaks, file, find, replace, { coveredBy }?] */
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
  // M14 retargeted (P0.10): the parser reads the total from `totalMatch` since b3f2eeb8.
  ['M14-content-range-total', 'mcp', 'Content-Range total minus one', PC, "total: totalMatch[1] === '*' ? null : parseInt(totalMatch[1], 10),", "total: totalMatch[1] === '*' ? null : parseInt(totalMatch[1], 10) - 1,"],
  ['M15-substring-search-prefix-only', 'mcp', 'substring search prefix-only', LR, 'params[resolved.substring_search_column] = `ilike.*${search}*`;', 'params[resolved.substring_search_column] = `ilike.${search}*`;'],
  ['V1-describe-wording', 'mcp', 'condition-failure text reworded', EA, "case 'eq': return `${field} is ${fmt(actual)}, expected ${fmt(value)}`;", "case 'eq': return `${field} = ${fmt(actual)} (want ${fmt(value)})`;"],
  // V2 retargeted (P0.10): since b3f2eeb8 includeTimestamps adds only columns the entity has, which the
  // condition fetch already selects, so the original mutation is a no-op. Same target: which columns the fetch selects.
  ['V2-condition-fetch-detail-only', 'mcp', 'condition fetch selects only detail-visible columns', EA, 'const selectStr = buildSelectString(allProperties);', 'const selectStr = buildSelectString(allProperties.filter(p => p.show_on_detail !== false));'],
  ['V3-column-substring-startswith', 'mcp', 'column substring match becomes prefix match', NR, '        p.column_name.includes(normalized),\n    );\n\n    if (substringMatches.length === 1) return substringMatches[0];', '        p.column_name.startsWith(normalized),\n    );\n\n    if (substringMatches.length === 1) return substringMatches[0];'],
  ['V4-rpc-renamed', 'mcp', 'execute_action calls a renamed RPC', EA, '        const response = await client.post<EntityActionResult>(\n          `rpc/${actionConfig.rpc_function}`,', '        const response = await client.post<EntityActionResult>(\n          `rpc/${actionConfig.rpc_function}_v2`,'],
  // V5 originally dropped the `return` after `case 'float4':` and let `numeric` fall through too; re-anchored to float4 only.
  ['V5-float4-only-integer', 'mcp', 'float4 alone detected as IntegerNumber (numeric and float8 untouched; probe only)', SC, "    case 'numeric':\n    case 'float4':\n    case 'float8': return EntityPropertyType.DecimalNumber;", "    case 'numeric':\n    case 'float8': return EntityPropertyType.DecimalNumber;\n    case 'float4': return EntityPropertyType.IntegerNumber;"],
  ['O1-user-embed-matches-frontend', 'mcp', 'User embed gains phone,email (toward parity; still a model change)', SB, 'return `${col}:civic_os_users!${col}(id,display_name,full_name)`;', 'return `${col}:civic_os_users!${col}(id,display_name,full_name,phone,email)`;'],
  ['O2-varchar-bpchar-textlong', 'mcp', 'varchar and bpchar (shared case) detected as TextLong', SC, "case 'bpchar': return EntityPropertyType.TextShort;", "case 'bpchar': return EntityPropertyType.TextLong;"],
  ['O3-default-order-display-name-desc', 'mcp', 'default order display_name.desc', LR, "params['order'] = 'display_name.asc';", "params['order'] = 'display_name.desc';"],
  ['O4-22p02-wording', 'mcp', '22P02 friendly type wording', PC, "integer: 'a whole number',", "integer: 'an integer',"],
  ['O5-category-case-sensitive', 'mcp', 'category lookup case-sensitive', NR, '    const categories = this.cache.getCategories(entityType);\n    const normalized = displayName.trim().toLowerCase();', '    const categories = this.cache.getCategories(entityType);\n    const normalized = displayName.trim();'],
  // O6 and O7 retargeted (P0.10): both moved a side toward parity, which main has now done (C-02, Q-12), so they run
  // in reverse: O6 makes `ne` loose again; O7 (dropping includeTimestamps is a no-op now) makes the builder force timestamps again.
  ['O6-ne-loose-again', 'mcp', '`ne` becomes loose again (C-02 regression)', EA, "case 'ne': return recordValue !== value;", "case 'ne': return recordValue != value;"],
  ['O7-timestamps-forced-again', 'mcp', 'buildSelectString adds created_at / updated_at even when the entity lacks them (Q-12 regression)', SB, '      if (properties.some(p => p.column_name === ts)) fields.add(ts);', '      fields.add(ts);'],
  ['O8-edit-view-keeps-identity', 'mcp', 'filterProperties keeps identity/generated columns in edit views', SB, "if ((context === 'create' || context === 'edit') && (prop.is_identity || prop.is_generated)) {", "if (context === 'create' && (prop.is_identity || prop.is_generated)) {"],
  ['O9-status-no-trim', 'mcp', 'resolveStatus stops trimming its input', NR, anchorStatus, '    const statuses = this.cache.getStatuses(entityType);\n    const normalized = name.toLowerCase();'],
  // N1-N7: the P0.3 verifier's third-round mutations, reconstructed from their names (anchors recorded here).
  ['N1-fe-range-off-by-one', 'frontend', 'getDataPaginated Range end one past the page', DS, 'const rangeEnd = offset + pagination.pageSize - 1;', 'const rangeEnd = offset + pagination.pageSize;'],
  ['N2-fe-23p01-named-wording', 'frontend', 'parseToHumanWithLookup 23P01 named fallback reworded', ES, 'return `This conflicts with an existing record. Please check your input and try again.`;', 'return `This conflicts with another record.`;'],
  ['N3-fe-in-loose', 'frontend', 'action evaluator `in` uses loose equality', CE, 'simple.value.includes(fieldValue);', 'simple.value.some((v: unknown) => v == fieldValue);'],
  ['N4-mcp-fk-limit-10', 'mcp', 'FK eq lookup limit 5 -> 10 (ilike lookup untouched)', NR, "        display_name: `eq.${displayName}`,\n        limit: '5',", "        display_name: `eq.${displayName}`,\n        limit: '10',"],
  // N5 retargeted (P0.10): the total regex is end-anchored since b3f2eeb8 (the original mutation); now the anchor is dropped.
  ['N5-mcp-content-range-unanchored', 'mcp', 'Content-Range total regex loses its end anchor (trailing garbage parses again)', PC, 'const totalMatch = header.match(/\\/(\\d+|\\*)$/);', 'const totalMatch = header.match(/\\/(\\d+|\\*)/);'],
  ['N6-mcp-entity-no-readable-preference', 'mcp', 'resolveEntity drops the readable-entity preference among substring matches', NR, 'const effectiveMatches = readableMatches.length > 0 ? readableMatches : substringMatches;', 'const effectiveMatches = substringMatches;'],
  ['N7-mcp-float4-only-integer', 'mcp', 'float4 alone detected as IntegerNumber via an early return (same behavior as V5, different code shape)', SC, '  switch (udt_name) {\n', "  if (udt_name === 'float4') return EntityPropertyType.IntegerNumber;\n  switch (udt_name) {\n"],
  // R1-R7 (P0.10): regressions of rows fixed on main in b3f2eeb8.
  ['R1-plain-field-no-id-unwrap', 'mcp', 'plain condition field stops unwrapping an embedded .id (C-01 / A-01 regression)', EA, "    if (value !== null && typeof value === 'object' && 'id' in value) {\n      return (value as Record<string, unknown>).id;\n    }\n", ''],
  ['R2-unknown-operator-open', 'mcp', 'unknown operator fails open when an operator is given (C-04 regression)', EA, '    default: return false;\n  }\n}', '    default: return !!operator;\n  }\n}'],
  ['R3-gt-no-numeric-guard', 'mcp', '`gt` drops the numeric guard (C-03 regression)', EA, "case 'gt': return typeof recordValue === 'number' && typeof value === 'number' && recordValue > value;", "case 'gt': return (recordValue as any) > (value as any);"],
  ['R4-no-record-evaluates', 'mcp', 'a missing record is evaluated as an empty one (C-05 regression)', EA, '  if (!record) return false;\n', '  if (!record) record = {};\n'],
  ['R5-fk-filter-no-uuid-shortcut', 'mcp', 'FK filter values look UUIDs up by display name again (N-04 regression)', NR, '    if (UUID_PATTERN.test(value)) return value;\n    return this.resolveForeignKeyValue(targetTable, value);', '    return this.resolveForeignKeyValue(targetTable, value);'],
  ['R6-imatch-unescaped', 'mcp', 'FK fallback pattern stops escaping metacharacters (N-03 regression)', NR, "return `^${value.replace(/[\\\\^$.|?*+()[\\]{}]/g, '\\\\$&')}$`;", 'return "^" + value + "$";'], // no dollar-backtick in the replacement: String.replace would expand it
  ['R7-select-trailing-comma', 'mcp', 'list_records keeps empty select parts (`select=id,`, Q-14 regression)', LR, "const selectStr = selectParts.filter(Boolean).join(',');", "const selectStr = selectParts.join(',');"],
  // R8 (P0.10 fix round): the regression the P0.10 verifier made by hand. execute_action again proceeds to the RPC
  // unchecked when the condition fetch fails or finds no row (the pre-b3f2eeb8 behavior), while every anchored
  // string, the refusal blocks with their returns included, stays in the file: the refusals become unreachable
  // through a labeled block. No golden reaches this path, so only the ledger's in-process probe can catch it.
  ['R8-fetch-failure-proceeds', 'mcp', 'execute_action calls the RPC unchecked when the condition fetch fails or finds no row, anchors kept (C-05 regression)', EA,
    [
      '      if (actionConfig.visibility_condition || actionConfig.enabled_condition) {\n        try {\n',
      '        } catch (err) {\n          if (err instanceof PostgRESTRequestError) {\n',
      '\n\n        if (!currentRecord) {\n          return {\n',
    ],
    [
      '      if (actionConfig.visibility_condition || actionConfig.enabled_condition) checks: {\n        try {\n',
      '        } catch (err) {\n          break checks; // pre-b3f2eeb8: proceed, the RPC will validate\n          if (err instanceof PostgRESTRequestError) {\n',
      '\n\n        if (!currentRecord) break checks;\n        if (!currentRecord) {\n          return {\n',
    ],
    { coveredBy: 'probe' }],
  ['FE-1-hybrid-ilike-prefix', 'frontend', 'buildHybridSearchParams ilike *x* -> x*', SU, 'clauses.push(`${col}.ilike.*${encoded}*`);', 'clauses.push(`${col}.ilike.${encoded}*`);'],
  ['FE-2-user-embed-drops-email', 'frontend', 'User embed drops email', CSEL, "'(id,display_name,full_name,phone,email)'", "'(id,display_name,full_name,phone)'"],
  ['FE-3-ne-loose', 'frontend', 'action evaluator `ne` becomes loose', CE, '            return fieldValue !== simple.value;', '            return fieldValue != simple.value;'],
  ['FE-4-23505-wording', 'frontend', 'parseToHuman 23505 reworded', ES, 'return "Record must be unique";', 'return "Duplicate record";'],
  ['FE-5-encode-filter-values', 'frontend', 'getData encodes filter values (fixes F-01 there; still a model change)', DS, '            args.push(`${filter.column}=${filter.operator}.${filter.value}`);', '            args.push(`${filter.column}=${filter.operator}.${encodeURIComponent(String(filter.value))}`);'],
  ['FE-6-structural-drops-status', 'frontend', 'ensureStructuralProps stops adding status_id', SS, "const structuralColumns = ['display_name', 'status_id', 'submitted_at'];", "const structuralColumns = ['display_name', 'submitted_at'];"],
  ['FE-7-preview-total-fallback', 'frontend', 'inverse preview total falls back to 0', DS, 'totalCount = match ? parseInt(match[1], 10) : records.length;', 'totalCount = match ? parseInt(match[1], 10) : 0;'],
  ['FE-8-money-decimal', 'frontend', 'getPropertyType maps money to DecimalNumber', CPT, "['money'].includes(val.udt_name) ? EntityPropertyType.Money :", "['money'].includes(val.udt_name) ? EntityPropertyType.DecimalNumber :"],
];

/** How a mutation must be caught: by a golden that changes (the default), or by the ledger's in-process probe (no golden reaches the path). */
const coveredBy = m => m[6]?.coveredBy ?? 'golden';

function apply(root, id) {
  const m = MUTATIONS.find(x => x[0] === id);
  if (!m) throw new Error(`unknown mutation ${id}`);
  const [, , , file, find, replace] = m;
  const p = path.join(root, file);
  let text = fs.readFileSync(p, 'utf8');
  // `find` / `replace` are one string each, or parallel arrays of edits applied in order.
  const finds = Array.isArray(find) ? find : [find];
  const replaces = Array.isArray(replace) ? replace : [replace];
  finds.forEach((f, i) => {
    if (!text.includes(f)) throw new Error(`${id}: anchor not found in ${file}: ${JSON.stringify(f)}`);
    text = text.replace(f, () => replaces[i]);
  });
  fs.writeFileSync(p, text);
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'list') {
  for (const m of MUTATIONS) console.log(`${m[0]}\t${m[1]}\t${m[2]}\t${coveredBy(m)}`);
} else if (cmd === 'apply') {
  apply(args[0], args[1]);
} else if (cmd) {
  console.error('usage: ledger-mutations.mjs list | apply <root> <id>');
  process.exit(64);
}
