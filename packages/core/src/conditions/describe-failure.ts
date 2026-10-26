/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- record payloads and conditions are untyped JSON. */

import { evaluateCondition, resolveFieldValue } from './action-condition.js';

/** A non-null object: the only shape a condition (or a compound entry) can have. */
function isConditionObject(c: unknown): c is Record<string, any> {
  return typeof c === 'object' && c !== null;
}

/** Condition value as shown in a failure sentence: `null` for a missing value, else its JSON. */
function show(value: unknown): string {
  return value === null || value === undefined ? 'null' : JSON.stringify(value);
}

/**
 * Explains in a sentence why an action condition is not met by `record`: the
 * record's current value against what the condition expects. Meant for
 * consumers that have no button to grey out and must tell the user (the MCP
 * server tells the LLM). It judges with the same evaluator as
 * {@link evaluateCondition} (strict), so a sentence is only produced for a
 * part that evaluator rejects.
 *
 * - A simple condition reads `status_id.status_key is "open", expected "closed"`;
 *   `ne` / `neq` say `must not be`, the ordering operators `must be > ...`,
 *   `in` `must be one of ...`, `is_null` `must be null`, `is_not_null`
 *   `is null, must have a value`, an unknown operator `failed condition "..."`.
 * - An `or` lists every branch under `None of these conditions are met:`.
 * - An `and` joins only the failing parts with `; `.
 * - A malformed entry (not an object, no string `field`) is described as
 *   malformed instead of throwing.
 *
 * @consumer mcp
 */
export function describeConditionFailure(condition: unknown, record: Record<string, any>): string {
  if (!isConditionObject(condition)) return 'the condition is malformed';

  if ('or' in condition && Array.isArray(condition['or'])) {
    const parts = condition['or'].map((c: unknown) =>
      isConditionObject(c) ? describeConditionFailure(c, record) : 'a sub-condition is malformed',
    );
    return `None of these conditions are met:\n${parts.map((p: string) => `  - ${p}`).join('\n')}`;
  }

  if ('and' in condition && Array.isArray(condition['and'])) {
    const failing = condition['and'].filter((c: unknown) => !isConditionObject(c) || !evaluateCondition(c, record));
    const parts = failing.map((c: unknown) =>
      isConditionObject(c) ? describeConditionFailure(c, record) : 'a sub-condition is malformed',
    );
    return parts.join('; ');
  }

  const { field, operator, value } = condition as { field?: unknown; operator?: unknown; value?: unknown };
  if (typeof field !== 'string') return 'the condition is malformed (no field name)';
  const actual = resolveFieldValue(record, field);

  switch (operator) {
    case 'eq': return `${field} is ${show(actual)}, expected ${show(value)}`;
    case 'ne':
    case 'neq': return `${field} is ${show(actual)}, must not be ${show(value)}`;
    case 'gt': return `${field} is ${show(actual)}, must be > ${show(value)}`;
    case 'lt': return `${field} is ${show(actual)}, must be < ${show(value)}`;
    case 'gte': return `${field} is ${show(actual)}, must be >= ${show(value)}`;
    case 'lte': return `${field} is ${show(actual)}, must be <= ${show(value)}`;
    case 'in': return `${field} is ${show(actual)}, must be one of ${show(value)}`;
    case 'is_null': return `${field} is ${show(actual)}, must be null`;
    case 'is_not_null': return `${field} is null, must have a value`;
    default: return `${field} failed condition "${String(operator)}"`;
  }
}
