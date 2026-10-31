/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * What the create and edit editors share. Private to the facades: not exported from any barrel.
 */

import type { Store } from '../client/store.js';
import { DataClientError } from '../client/errors.js';
import { humanizeError } from '../errors/index.js';
import type { PostgrestErrorShape } from '../errors/classify.js';
import { EntityPropertyType } from '../model/index.js';
import type { ApiError, ConstraintMessage, PropertyItem, SchemaEntityProperty } from '../model/index.js';
import type { PlanItem, RenderPlan } from '../plan/types.js';
import { getColumnSpan } from '../schema/property-views.js';
import { TransportError } from '../transport/errors.js';

export const FILE_TYPES: ReadonlySet<EntityPropertyType> = new Set([
  EntityPropertyType.File,
  EntityPropertyType.FileImage,
  EntityPropertyType.FilePDF,
]);

/** An inline many-to-many property (`show_inline`): edited on the form's page, not held as a form field. */
export const isInlineManyToMany = (p: SchemaEntityProperty): boolean => p.type === EntityPropertyType.ManyToMany && p.show_inline === true;

/** The legacy `DataService.parseApiError` result for a failed write. */
export function toApiError(err: unknown, constraintMessages: readonly ConstraintMessage[] | undefined): ApiError {
  if (err instanceof DataClientError) {
    const s = err.shape;
    const shape: PostgrestErrorShape = { httpCode: s.httpCode };
    if (s.code !== undefined) shape.code = s.code;
    if (s.details !== undefined) shape.details = s.details;
    if (s.message !== undefined) shape.message = s.message;
    const out: ApiError = {
      httpCode: s.httpCode,
      message: s.message || err.statusText || 'Unknown error',
      humanMessage: humanizeError(shape, { constraintMessages }),
    };
    if (s.code !== undefined) out.code = s.code;
    if (s.details !== undefined) out.details = s.details;
    if (s.hint !== undefined) out.hint = s.hint;
    return out;
  }
  if (err instanceof TransportError) {
    return { httpCode: 0, message: 'Unknown error', humanMessage: humanizeError({ httpCode: 0 }, { constraintMessages }) };
  }
  return { httpCode: 500, message: 'An unexpected error occurred', humanMessage: 'System Error' };
}

/** The render plan the form store is built over: one property item per form field, in one section. */
export function buildPlan(props: readonly SchemaEntityProperty[], mode: 'create' | 'edit'): RenderPlan {
  const items: PlanItem[] = props.map(p => ({
    kind: 'property',
    key: p.column_name,
    property: { ...p, itemType: 'property' } as PropertyItem,
    label: { text: p.display_name },
    span: getColumnSpan(p),
  }));
  return { mode, items, sections: [{ title: undefined, items }] };
}

/**
 * One keystroke can notify the backend several times; only a snapshot that differs (by `Object.is` on any
 * field) is published.
 */
export function publishWhenChanged<S extends object>(store: Store<S>, next: S): void {
  const cur = store.getSnapshot();
  const same = (Object.keys(next) as (keyof S)[]).every(k => Object.is(next[k], cur[k]));
  if (!same) store.set(next);
}

/**
 * State an editor holds for its own later commands and for its tests, outside its public contract. Keyed by the
 * editor object `recordEditor` returned.
 */
export interface EditEditorInternals {
  /** What the record held when loaded, in API form (`{}` when a loaded value cannot be sent). The series split diffs against it. */
  loadedApiValues(): Readonly<Record<string, unknown>>;
}

export const editorInternals = new WeakMap<object, EditEditorInternals>();
