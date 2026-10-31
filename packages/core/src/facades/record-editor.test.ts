/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- fixtures are partial schema rows, as in the handle tests. */

import { describe, expect, it, vi } from 'vitest';
import type { DataClient } from '../client/data-client.js';
import { humanizeError } from '../errors/index.js';
import type { FormBackend, FormFieldSpec } from '../forms/backend.js';
import { validateValue } from '../forms/validate.js';
import type { ValidationFailure } from '../forms/validate.js';
import { mintEntityHandle } from '../handles/handles.js';
import type { EntityHandle } from '../handles/handles.js';
import { EntityPropertyType } from '../model/entity.js';
import type { RenderableItem, SchemaEntityProperty, SchemaEntityTable } from '../model/entity.js';
import type { ConstraintMessage } from '../model/index.js';
import { createFakeClock, FAKE_API_URL, fakeTransport, reply } from '../testing/index.js';
import type { FakeTransport } from '../testing/index.js';
import { TransportError } from '../transport/errors.js';
import type { TransportRequest, TransportResponse } from '../transport/types.js';
import { recordEditor } from './record-editor.js';
import type {
  EditorDeps,
  EditorStep,
  EditorStepResult,
  ManyToManyDiff,
  RecordEditor,
  RichManyToManyDiff,
} from './record-editor.js';

// Core compiles without DOM or Node types (see fetch-transport.test.ts).
declare const setTimeout: (callback: () => void, ms: number) => unknown;

const T = EntityPropertyType;
const ZONE = 'America/New_York';

const entityRow = (over: Partial<SchemaEntityTable> = {}): SchemaEntityTable =>
  ({
    table_name: 'issues',
    display_name: 'Issues',
    sort_order: 1,
    description: null,
    search_fields: null,
    show_map: false,
    map_property_name: null,
    show_calendar: false,
    calendar_property_name: null,
    calendar_color_property: null,
    insert: true,
    select: true,
    update: true,
    delete: true,
    ...over,
  }) as SchemaEntityTable;

const prop = (column: string, type: EntityPropertyType, over: Partial<SchemaEntityProperty> = {}): SchemaEntityProperty =>
  ({
    table_catalog: 'db',
    table_schema: 'public',
    table_name: 'issues',
    column_name: column,
    display_name: column.charAt(0).toUpperCase() + column.slice(1),
    sort_order: 1,
    is_nullable: true,
    data_type: 'text',
    udt_name: 'text',
    is_generated: false,
    is_identity: false,
    is_updatable: true,
    join_schema: '',
    join_table: '',
    join_column: '',
    show_on_list: true,
    type,
    ...over,
  }) as SchemaEntityProperty;

const m2m = (column: string, inline: boolean, over: Record<string, unknown> = {}): SchemaEntityProperty =>
  prop(column, T.ManyToMany, {
    show_inline: inline,
    many_to_many_meta: {
      junctionTable: `issue_${column}`,
      sourceTable: 'issues',
      targetTable: column,
      sourceColumn: 'issue_id',
      targetColumn: `${column}_id`,
      relatedTable: column,
      relatedTableDisplayName: column,
      showOnSource: true,
      showOnTarget: true,
      displayOrder: 1,
      relatedTableHasColor: false,
      extraColumns: [],
      ...over,
    } as any,
  });

const P = {
  id: prop('id', T.IntegerNumber, { is_identity: true }),
  name: prop('name', T.TextShort, { is_nullable: false }),
  count: prop('count', T.IntegerNumber),
  active: prop('active', T.Boolean),
};
const BASE = [P.id, P.name, P.count, P.active];
const TAGS = m2m('tags', true);
const LABELS = m2m('labels', true, { extraColumns: [prop('note', T.TextShort)] });
const PHOTOS = prop('photos', T.PhotoGallery);

/** Lets the microtask-scheduled load and the fake transport settle. */
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/** A response held until the test settles it. */
function deferred() {
  let resolve!: (r: TransportResponse) => void;
  const promise = new Promise<TransportResponse>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

interface BackendOptions {
  /** Notifies twice per change, as a FormGroup does (valueChanges and statusChanges). */
  notifyTwice?: boolean;
  /** Values set right after registration, as a backend that already holds state. */
  preset?: Record<string, unknown>;
}

type MemBackend = FormBackend & {
  listeners: Set<() => void>;
  resetCalls: (Readonly<Record<string, unknown>> | undefined)[];
  registered: string[];
};

/** A plain-state backend, as a custom app would write it. */
function memoryBackend(options: BackendOptions = {}): MemBackend {
  const specs = new Map<string, FormFieldSpec>();
  const values = new Map<string, unknown>();
  const baseline = new Map<string, unknown>();
  const touched = new Set<string>();
  const disabled = new Set<string>();
  const listeners = new Set<() => void>();
  const resetCalls: (Readonly<Record<string, unknown>> | undefined)[] = [];
  const registered: string[] = [];
  const emit = () => {
    for (let i = 0; i < (options.notifyTwice ? 2 : 1); i++) [...listeners].forEach(l => l());
  };
  return {
    listeners,
    resetCalls,
    registered,
    register(fields) {
      for (const f of fields) {
        specs.set(f.key, f);
        registered.push(f.key);
        const v = options.preset && f.key in options.preset ? options.preset[f.key] : f.initial;
        values.set(f.key, v);
        baseline.set(f.key, v);
      }
    },
    getValue: key => values.get(key),
    setValue(key, value) {
      values.set(key, value);
      emit();
    },
    setValues(next) {
      for (const key of Object.keys(next)) values.set(key, next[key]);
      emit();
    },
    reset(next) {
      resetCalls.push(next);
      for (const [key, spec] of specs) {
        const value = next !== undefined && Object.prototype.hasOwnProperty.call(next, key) ? next[key] : spec.initial;
        values.set(key, value);
        baseline.set(key, value);
      }
      touched.clear();
      emit();
    },
    getErrors: (key): readonly ValidationFailure[] => (disabled.has(key) ? [] : validateValue(specs.get(key)!.rules, values.get(key))),
    isTouched: key => touched.has(key),
    markTouched(key) {
      touched.add(key);
      emit();
    },
    isDirty: key => !Object.is(values.get(key), baseline.get(key)),
    isEnabled: key => !disabled.has(key),
    setEnabled(key, enabled) {
      if (enabled) disabled.delete(key);
      else disabled.add(key);
      emit();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

interface Call {
  method: string;
  path: string;
  body: any;
}
/** Answers a request, or returns `undefined` to leave it to the default reply. */
type Route = (call: Call, req: TransportRequest) => TransportResponse | Promise<TransportResponse> | undefined;

interface Scenario {
  /** `null`: the entity is not in the live schema. */
  entity?: Partial<SchemaEntityTable> | null;
  props?: SchemaEntityProperty[];
  respond?: Route;
  prefill?: Record<string, unknown>;
  galleryImages?: () => Promise<boolean>;
  constraintMessages?: ConstraintMessage[];
  backend?: BackendOptions;
}

interface World {
  editor: RecordEditor<MemBackend>;
  deps: EditorDeps;
  ft: FakeTransport;
  handle: EntityHandle;
  state: {
    props: SchemaEntityProperty[];
    propertiesFail: boolean;
    /** Awaited by `schema.properties` when set. */
    gate: Promise<void> | null;
    propertiesCalls: unknown[];
    renderableCalls: unknown[][];
    backends: MemBackend[];
  };
  /** Number of snapshots published since creation. */
  notified: { count: number };
}

function make(sc: Scenario = {}): World {
  const row = sc.entity === null ? undefined : entityRow(sc.entity);
  const state: World['state'] = {
    props: sc.props ?? BASE,
    propertiesFail: false,
    gate: null,
    propertiesCalls: [],
    renderableCalls: [],
    backends: [],
  };
  const ft = fakeTransport(async req => {
    const path = req.url.startsWith(FAKE_API_URL) ? req.url.slice(FAKE_API_URL.length) : req.url;
    const call: Call = { method: req.method, path, body: req.body === undefined ? undefined : JSON.parse(req.body) };
    const custom = sc.respond?.(call, req);
    if (custom !== undefined) return custom;
    if (req.method === 'POST' && path === 'issues') return reply(201, [{ id: 11, ...call.body }]);
    return reply(200, null);
  });
  const handle = mintEntityHandle(
    { peekEntities: () => (row ? [row] : []), peekProperties: () => state.props, peekEntityActions: () => undefined },
    'issues',
  );
  const deps: EditorDeps = {
    data: ft.client as DataClient,
    clock: createFakeClock('2026-10-21T12:00:00Z'),
    schema: {
      properties: async entity => {
        state.propertiesCalls.push(entity);
        if (state.gate) await state.gate;
        if (state.propertiesFail) throw new Error('schema down');
        return state.props;
      },
      formRenderables: async (entity, mode) => {
        state.renderableCalls.push([entity, mode]);
        return state.props.map(p => ({ ...p, itemType: 'property' }) as RenderableItem);
      },
      constraintMessages: () => sc.constraintMessages,
    },
  };
  const editor = recordEditor<MemBackend>(deps, handle, {
    mode: 'create',
    backend: () => {
      const b = memoryBackend(sc.backend);
      state.backends.push(b);
      return b;
    },
    timeZone: ZONE,
    ...(sc.prefill && { prefill: sc.prefill }),
    ...(sc.galleryImages && { galleryImages: sc.galleryImages }),
  });
  const notified = { count: 0 };
  editor.subscribe(() => notified.count++);
  return { editor, deps, ft, handle, state, notified };
}

/** A world whose first load has settled. */
async function ready(sc: Scenario = {}): Promise<World> {
  const w = make(sc);
  await flush();
  return w;
}

const snap = (w: World) => w.editor.getSnapshot();
const sent = (w: World) => w.ft.recorded();
const posts = (w: World, path: string) =>
  sent(w).filter(r => r.method === 'POST' && r.path === path).map(r => ({ ...r, body: r.body as Record<string, unknown> }));
const rpcs = (w: World, fn: string) => posts(w, `rpc/${fn}`).map(r => ({ ...r, body: r.body as any }));
const backend = (w: World): MemBackend => w.state.backends[w.state.backends.length - 1]!;
const value = (w: World, key: string) => snap(w).form!.fields[key]!.value;
const setName = (w: World, v: unknown = 'Test Issue') => backend(w).setValue('name', v);

const runAll = async (steps: readonly EditorStep[]): Promise<EditorStepResult[]> => {
  const out: EditorStepResult[] = [];
  for (const s of steps) out.push(await s.execute());
  return out;
};

async function stepsOf(w: World): Promise<readonly EditorStep[]> {
  const r = await w.editor.save();
  if (r.status !== 'steps') throw new Error(`expected steps, got ${r.status}`);
  return r.steps;
}

const diff = (...add: number[]): ManyToManyDiff => ({ toAdd: add, toRemove: [] });
const richDiff = (...add: { id: number; extraData: Record<string, unknown> }[]): RichManyToManyDiff => ({ toAdd: add, toRemove: [], toUpdate: [] });

const WITH_PENDING = [...BASE, TAGS, LABELS, PHOTOS];

// ---------------------------------------------------------------------------------------------------------------

describe('recordEditor: the form', () => {
  it('is loading until the first load settles, then serves the form (ported 118)', async () => {
    const w = make();
    expect(snap(w).loading).toBe(true);
    expect(snap(w).form).toBeNull();
    expect(snap(w).backend).toBeNull();
    await flush();
    expect(snap(w).loading).toBe(false);
    expect(snap(w).error).toBeUndefined();
    expect(snap(w).backend).toBe(backend(w));
    expect(snap(w).form).not.toBeNull();
  });

  it('serves the properties for the create form, minus files and non-inline many-to-many (ported 143)', async () => {
    const hidden = prop('internal', T.TextShort, { show_on_create: false });
    const stamp = prop('created_at', T.DateTimeLocal);
    const generated = prop('computed', T.TextShort, { is_generated: true });
    const readonly = prop('locked', T.TextShort, { is_updatable: false });
    const files = [prop('doc', T.File), prop('pic', T.FileImage), prop('pdf', T.FilePDF)];
    const w = await ready({ props: [...BASE, hidden, stamp, generated, readonly, ...files, m2m('plain', false), TAGS] });
    expect(snap(w).properties.map(p => p.column_name)).toEqual(['name', 'count', 'active', 'tags']);
    expect(w.state.propertiesCalls).toEqual([w.handle.liveRow]);
  });

  it('lists the inline many-to-many properties apart and keeps them out of the form fields', async () => {
    const w = await ready({ props: [...BASE, m2m('plain', false), TAGS, LABELS] });
    expect(snap(w).inlineManyToMany.map(p => p.column_name)).toEqual(['tags', 'labels']);
    expect(Object.keys(snap(w).form!.fields)).toEqual(['name', 'count', 'active']);
    expect(backend(w).registered).toEqual(['name', 'count', 'active']);
  });

  it('has empty properties, no form and no requests when the entity is not in the schema (ported 158)', async () => {
    const w = await ready({ entity: null });
    expect(snap(w).properties).toEqual([]);
    expect(snap(w).renderables).toEqual([]);
    expect(snap(w).backend).toBeNull();
    expect(snap(w).form).toBeNull();
    expect(snap(w).loading).toBe(false);
    expect(snap(w).guidedFormKey).toBeNull();
    expect(w.state.propertiesCalls).toEqual([]);
    expect(w.state.backends).toEqual([]);
    expect(sent(w)).toEqual([]);
  });

  it('creates one control per form property, in order (ported 170)', async () => {
    const w = await ready({ props: [P.name, P.count, P.active] });
    expect(Object.keys(snap(w).form!.fields)).toEqual(['name', 'count', 'active']);
    expect(backend(w).registered).toEqual(['name', 'count', 'active']);
  });

  it('starts booleans at false and every other type at null (ported 188)', async () => {
    const w = await ready({ props: [P.name, P.active] });
    expect(value(w, 'active')).toBe(false);
    expect(value(w, 'name')).toBeNull();
  });

  it('adds the required validator to non-nullable fields only (ported 205)', async () => {
    const w = await ready({ props: [P.name, P.count] });
    expect(snap(w).form!.fields['name']!.errors).toEqual([{ kind: 'required' }]);
    expect(snap(w).form!.fields['count']!.errors).toEqual([]);
    expect(snap(w).form!.valid).toBe(false);
  });

  it('calls the backend factory once for the first build', async () => {
    const w = await ready();
    expect(w.state.backends).toHaveLength(1);
  });

  it('reads the renderables of the create mode', async () => {
    const w = await ready();
    expect(w.state.renderableCalls).toEqual([[w.handle, 'create']]);
    expect(snap(w).renderables.map(r => (r as SchemaEntityProperty).column_name)).toEqual(['id', 'name', 'count', 'active']);
  });

  it('reads the guided form key from the entity, and null when it has none', async () => {
    const guided = await ready({ entity: { guided_form_key: 'intake' } });
    const plain = await ready();
    expect(snap(guided).guidedFormKey).toBe('intake');
    expect(snap(plain).guidedFormKey).toBeNull();
  });

  it('reports a schema load failure as the error, with no form', async () => {
    const w = make();
    w.state.propertiesFail = true;
    await flush();
    expect(snap(w).error).toEqual(new Error('schema down'));
    expect(snap(w).loading).toBe(false);
    expect(snap(w).form).toBeNull();
    expect(w.state.backends).toEqual([]);
  });

  it('returns the same snapshot until something changes', async () => {
    const w = await ready();
    const first = snap(w);
    expect(snap(w)).toBe(first);
    expect(snap(w).form).toBe(first.form);
  });
});

describe('recordEditor: prefill', () => {
  it('sets a falsy field and marks it touched', async () => {
    const w = await ready({ prefill: { name: 'Pothole' } });
    expect(value(w, 'name')).toBe('Pothole');
    expect(snap(w).form!.fields['name']!.touched).toBe(true);
    expect(snap(w).form!.fields['count']!.touched).toBe(false);
  });

  it('overwrites a false boolean, as the legacy page overwrote any falsy value', async () => {
    const w = await ready({ prefill: { active: 'true' } });
    expect(value(w, 'active')).toBe('true');
  });

  it('ignores names that are not fields, without error', async () => {
    const w = await ready({ prefill: { nope: 'x', tags: '1', returnTo: '/view/a', id: '5' } });
    expect(snap(w).error).toBeUndefined();
    expect(Object.keys(snap(w).form!.fields)).toEqual(['name', 'count', 'active']);
    expect(snap(w).form!.fields['name']!.touched).toBe(false);
  });

  it('keeps a field that already has a value', async () => {
    const w = await ready({ prefill: { name: 'From the URL' }, backend: { preset: { name: 'Existing' } } });
    expect(value(w, 'name')).toBe('Existing');
    expect(snap(w).form!.fields['name']!.touched).toBe(false);
  });

  it('is part of the first published snapshot: one notification for the whole load', async () => {
    const w = make({ prefill: { name: 'Pothole', count: '3' } });
    await flush();
    expect(w.notified.count).toBe(1);
    expect(value(w, 'name')).toBe('Pothole');
    expect(value(w, 'count')).toBe('3');
  });

  it('applies again to the form a rebuild builds', async () => {
    const w = await ready({ prefill: { name: 'Pothole' } });
    w.editor.rebuild();
    await flush();
    expect(w.state.backends).toHaveLength(2);
    expect(value(w, 'name')).toBe('Pothole');
    expect(snap(w).form!.fields['name']!.touched).toBe(true);
  });
});

describe('recordEditor: snapshots', () => {
  it('publishes one snapshot per keystroke even when the backend notifies twice', async () => {
    const w = await ready({ backend: { notifyTwice: true } });
    const before = w.notified.count;
    setName(w, 'a');
    expect(w.notified.count).toBe(before + 1);
    setName(w, 'ab');
    expect(w.notified.count).toBe(before + 2);
    expect(value(w, 'name')).toBe('ab');
  });

  it('publishes nothing for a notification that changed nothing', async () => {
    const w = await ready({ backend: { notifyTwice: true } });
    setName(w, 'a');
    const before = w.notified.count;
    const first = snap(w);
    setName(w, 'a');
    expect(w.notified.count).toBe(before);
    expect(snap(w)).toBe(first);
  });

  it('carries the form store snapshot, which changes with the form', async () => {
    const w = await ready();
    const before = snap(w).form;
    setName(w, 'x');
    expect(snap(w).form).not.toBe(before);
    expect(snap(w).form!.fields['name']!.value).toBe('x');
    expect(snap(w).form!.valid).toBe(true);
  });

  it('returns an idempotent unsubscribe', async () => {
    const w = await ready();
    const seen = vi.fn();
    const off = w.editor.subscribe(seen);
    off();
    off();
    setName(w, 'x');
    expect(seen).not.toHaveBeenCalled();
  });
});

describe('recordEditor: save', () => {
  it('sends the entity and the form values in one create request (ported 237)', async () => {
    const w = await ready();
    setName(w, 'Test Issue');
    const result = await w.editor.save();
    expect(result.status).toBe('created');
    expect(sent(w)).toHaveLength(1);
    expect(sent(w)[0]).toMatchObject({
      method: 'POST',
      path: 'issues',
      headers: { Prefer: 'return=representation' },
      body: { name: 'Test Issue', count: null, active: false },
    });
  });

  it('leaves out the values of disabled fields', async () => {
    const w = await ready();
    setName(w);
    backend(w).setEnabled('count', false);
    await w.editor.save();
    expect(posts(w, 'issues')[0]!.body).toEqual({ name: 'Test Issue', active: false });
  });

  it('resolves created with the new id, and keeps it as createdId (ported 249, 406)', async () => {
    const w = await ready({ respond: ({ method, path }) => (method === 'POST' && path === 'issues' ? reply(201, [{ id: 42 }]) : undefined) });
    setName(w, 'Test');
    expect(await w.editor.save()).toEqual({ status: 'created', id: 42 });
    expect(snap(w).createdId).toBe(42);
    expect(snap(w).saving).toBe(false);
  });

  it('resolves created with a null id when the response has no row', async () => {
    const w = await ready({ respond: ({ method, path }) => (method === 'POST' && path === 'issues' ? reply(201, []) : undefined) });
    setName(w);
    expect(await w.editor.save()).toEqual({ status: 'created', id: null });
    expect(snap(w).createdId).toBeNull();
  });

  it('resolves failed with the legacy error shape when the write is rejected (ported 262)', async () => {
    const body = {
      code: '23505',
      message: 'duplicate key value violates unique constraint "issues_name_key"',
      details: 'Key (name)=(Test) already exists.',
      hint: 'Check your input',
    };
    const w = await ready({ respond: ({ method, path }) => (method === 'POST' && path === 'issues' ? reply(409, body) : undefined) });
    setName(w, 'Test');
    const result: any = await w.editor.save();
    expect(result.status).toBe('failed');
    expect(result.error).toEqual({
      httpCode: 409,
      code: '23505',
      message: body.message,
      details: body.details,
      hint: 'Check your input',
      humanMessage: humanizeError({ httpCode: 409, code: '23505', message: body.message, details: body.details }),
    });
    expect(result.error.humanMessage).not.toBe('');
    expect(snap(w).saving).toBe(false);
    expect(snap(w).createdId).toBeNull();
  });

  it('uses the configured constraint message for the human wording', async () => {
    const body = { code: '23514', message: 'new row for relation "issues" violates check constraint "issues_count_check"' };
    const w = await ready({
      constraintMessages: [{ constraint_name: 'issues_count_check', table_name: 'issues', column_name: 'count', error_message: 'Count must be positive.' }],
      respond: ({ method, path }) => (method === 'POST' && path === 'issues' ? reply(400, body) : undefined),
    });
    setName(w);
    const result: any = await w.editor.save();
    expect(result.error.humanMessage).toBe('Count must be positive.');
  });

  it('takes the message from a text body, then the status text, then "Unknown error"', async () => {
    const text = await ready({ respond: ({ method }) => (method === 'POST' ? { status: 502, headers: {}, text: 'upstream down', statusText: 'Bad Gateway' } : undefined) });
    setName(text);
    expect(((await text.editor.save()) as any).error).toMatchObject({ httpCode: 502, message: 'upstream down' });

    const statusText = await ready({ respond: ({ method }) => (method === 'POST' ? { status: 409, headers: {}, text: '{}', statusText: 'Conflict' } : undefined) });
    setName(statusText);
    expect(((await statusText.editor.save()) as any).error).toMatchObject({ httpCode: 409, message: 'Conflict' });

    const neither = await ready({ respond: ({ method }) => (method === 'POST' ? reply(500, {}) : undefined) });
    setName(neither);
    expect(((await neither.editor.save()) as any).error).toMatchObject({ httpCode: 500, message: 'Unknown error' });
  });

  it('shapes a network failure as status 0', async () => {
    const w = await ready({
      respond: ({ method }) => (method === 'POST' ? Promise.reject(new TransportError('network')) : undefined),
    });
    setName(w);
    const result: any = await w.editor.save();
    expect(result.status).toBe('failed');
    expect(result.error).toEqual({
      httpCode: 0,
      message: 'Unknown error',
      humanMessage: humanizeError({ httpCode: 0 }),
    });
  });

  it('keeps the legacy "System Error" shape for anything unexpected', async () => {
    const w = await ready();
    setName(w);
    vi.spyOn(w.ft.client, 'createData').mockRejectedValue(new TypeError('boom'));
    const result: any = await w.editor.save();
    expect(result).toEqual({
      status: 'failed',
      error: { httpCode: 500, message: 'An unexpected error occurred', humanMessage: 'System Error' },
    });
    expect(snap(w).saving).toBe(false);
  });

  it('sends nothing and resolves invalid for an invalid form (ported 319, 330)', async () => {
    const w = await ready();
    expect(await w.editor.save()).toEqual({ status: 'invalid' });
    expect(sent(w)).toEqual([]);
    expect(snap(w).saving).toBe(false);
  });

  it('marks every field touched when the form is invalid (ported 341)', async () => {
    const w = await ready();
    expect(snap(w).form!.fields['name']!.touched).toBe(false);
    await w.editor.save();
    expect(Object.values(snap(w).form!.fields).every(f => f.touched)).toBe(true);
  });

  it('turns valid when the missing value is entered, and then sends (ported 353)', async () => {
    const w = await ready();
    await w.editor.save();
    expect(snap(w).form!.valid).toBe(false);
    setName(w);
    expect(snap(w).form!.valid).toBe(true);
    expect((await w.editor.save()).status).toBe('created');
  });

  it('resolves ignored, sending nothing, when the entity has no form (ported 292)', async () => {
    const w = await ready({ entity: null });
    expect(await w.editor.save()).toEqual({ status: 'ignored' });
    expect(sent(w)).toEqual([]);
  });

  it('holds saving for the call and ignores a second save meanwhile', async () => {
    const gate = deferred();
    const w = await ready({ respond: ({ method, path }) => (method === 'POST' && path === 'issues' ? gate.promise : undefined) });
    setName(w);
    const first = w.editor.save();
    expect(snap(w).saving).toBe(true);
    expect(await w.editor.save()).toEqual({ status: 'ignored' });
    expect(posts(w, 'issues')).toHaveLength(1);
    gate.resolve(reply(201, [{ id: 5 }]));
    expect(await first).toEqual({ status: 'created', id: 5 });
    expect(snap(w).saving).toBe(false);
  });

  it('sends the create request after the page refreshed its token (ported 525, 538)', async () => {
    const w = await ready();
    setName(w, 'Test Issue');
    const order: string[] = [];
    const result = await w.editor.save(async () => {
      order.push(`beforeSend after ${sent(w).length} requests`);
    });
    expect(order).toEqual(['beforeSend after 0 requests']);
    expect(posts(w, 'issues')[0]!.body).toEqual({ name: 'Test Issue', count: null, active: false });
    expect(result).toEqual({ status: 'created', id: 11 });
  });

  it('resolves aborted with the cause when beforeSend rejects, sending nothing (ported 552, 573)', async () => {
    const w = await ready();
    setName(w);
    const cause = new Error('Token refresh failed');
    expect(await w.editor.save(() => Promise.reject(cause))).toEqual({ status: 'aborted', cause });
    expect(sent(w)).toEqual([]);
    expect(snap(w).saving).toBe(false);
  });

  it('holds saving while beforeSend runs', async () => {
    const w = await ready();
    setName(w);
    let release!: () => void;
    const held = new Promise<void>(r => {
      release = r;
    });
    const running = w.editor.save(() => held);
    expect(snap(w).saving).toBe(true);
    expect(await w.editor.save()).toEqual({ status: 'ignored' });
    release();
    expect((await running).status).toBe('created');
    expect(snap(w).saving).toBe(false);
  });

  it('runs beforeSend before the steps are returned, with no request sent before it', async () => {
    const w = await ready({ props: WITH_PENDING });
    setName(w);
    w.editor.setManyToManyDiff('tags', diff(1));
    const seen: number[] = [];
    const result = await w.editor.save(async () => {
      seen.push(sent(w).length);
    });
    expect(seen).toEqual([0]);
    expect(result.status).toBe('steps');
    expect(sent(w)).toEqual([]);
    expect(snap(w).saving).toBe(true);
  });

  it('resolves aborted instead of steps when beforeSend rejects with pending changes', async () => {
    const w = await ready({ props: WITH_PENDING });
    setName(w);
    w.editor.setManyToManyDiff('tags', diff(1));
    const cause = new Error('expired');
    expect(await w.editor.save(() => Promise.reject(cause))).toEqual({ status: 'aborted', cause });
    expect(sent(w)).toEqual([]);
    expect(snap(w).saving).toBe(false);
  });

  it('never reaches beforeSend for an invalid form or a transform error', async () => {
    const w = await ready({ props: [P.name, prop('at', T.DateTime)] });
    const beforeSend = vi.fn(async () => {});
    expect(await w.editor.save(beforeSend)).toEqual({ status: 'invalid' });
    setName(w);
    backend(w).setValue('at', '2025-13-45T10:30');
    const result: any = await w.editor.save(beforeSend);
    expect(result.status).toBe('transform_error');
    expect(result.column).toBe('at');
    expect(beforeSend).not.toHaveBeenCalled();
    expect(sent(w)).toEqual([]);
    expect(snap(w).saving).toBe(false);
  });
});

describe('recordEditor: the payload', () => {
  it('converts a DateTimeLocal control value from the zone to UTC', async () => {
    const w = await ready({ props: [P.name, prop('when', T.DateTimeLocal)] });
    setName(w);
    backend(w).setValue('when', '2025-01-15T17:30');
    await w.editor.save();
    expect(posts(w, 'issues')[0]!.body['when']).toBe('2025-01-15T22:30:00.000Z');
  });

  it('adds seconds to a DateTime control value and converts nothing', async () => {
    const w = await ready({ props: [P.name, prop('at', T.DateTime)] });
    setName(w);
    backend(w).setValue('at', '2025-01-15T10:30');
    await w.editor.save();
    expect(posts(w, 'issues')[0]!.body['at']).toBe('2025-01-15T10:30:00');
  });

  it('leaves the PhotoGallery key out of the body', async () => {
    const w = await ready({ props: [P.name, PHOTOS] });
    setName(w);
    await w.editor.save();
    expect(Object.keys(posts(w, 'issues')[0]!.body)).toEqual(['name']);
  });

  it('never sends many-to-many keys', async () => {
    const w = await ready({ props: [P.name, TAGS] });
    setName(w);
    await w.editor.save();
    expect(Object.keys(posts(w, 'issues')[0]!.body)).toEqual(['name']);
  });

  it('resolves transform_error for an impossible local time, sending nothing', async () => {
    const w = await ready({ props: [P.name, prop('at', T.DateTime)] });
    setName(w);
    backend(w).setValue('at', '2025-13-45T10:30');
    const result: any = await w.editor.save();
    expect(result.status).toBe('transform_error');
    expect(result.column).toBe('at');
    expect(result.message).toContain('is not a valid date and time for at');
    expect(sent(w)).toEqual([]);
    expect(snap(w).saving).toBe(false);
  });
});

describe('recordEditor: coordinated create steps', () => {
  it('sends nothing until the steps run, and orders them record, many-to-many, rich, gallery link, gallery images', async () => {
    const w = await ready({ props: WITH_PENDING });
    setName(w);
    w.editor.setGalleryDraft('photos', 'g-1');
    w.editor.setRichManyToManyDiff('labels', richDiff({ id: 2, extraData: { note: 'x' } }));
    w.editor.setManyToManyDiff('tags', diff(1, 3));
    const steps = await stepsOf(w);
    expect(sent(w)).toEqual([]);
    expect(steps.map(s => s.kind)).toEqual(['record', 'many_to_many', 'many_to_many', 'gallery_link', 'gallery_images']);
    expect(steps[1]).toMatchObject({ kind: 'many_to_many', column: 'tags', addCount: 2, property: { column_name: 'tags' } });
    expect(steps[2]).toMatchObject({ kind: 'many_to_many', column: 'labels', addCount: 1 });
    expect(steps[3]).toMatchObject({ kind: 'gallery_link', column: 'photos' });
    expect(snap(w).saving).toBe(true);
  });

  it('puts plain many-to-many steps before rich ones whatever order they were set in', async () => {
    const w = await ready({ props: WITH_PENDING });
    setName(w);
    w.editor.setRichManyToManyDiff('labels', richDiff({ id: 2, extraData: {} }));
    w.editor.setManyToManyDiff('tags', diff(1));
    const steps = await stepsOf(w);
    expect(steps.map(s => (s as any).column)).toEqual([undefined, 'tags', 'labels']);
  });

  it('runs the record step as the one create request and remembers the id', async () => {
    const w = await ready({ props: WITH_PENDING });
    setName(w);
    w.editor.setManyToManyDiff('tags', diff(1));
    const [record] = await stepsOf(w);
    expect(await record!.execute()).toEqual({ success: true });
    expect(posts(w, 'issues')[0]!.body).toEqual({ name: 'Test Issue', count: null, active: false });
    expect(snap(w).createdId).toBe(11);
  });

  it('words a failed record step with the human message', async () => {
    const body = { code: '23505', message: 'duplicate key value violates unique constraint "k"' };
    const w = await ready({
      props: WITH_PENDING,
      respond: ({ method, path }) => (method === 'POST' && path === 'issues' ? reply(409, body) : undefined),
    });
    setName(w);
    w.editor.setManyToManyDiff('tags', diff(1));
    const [record] = await stepsOf(w);
    expect(await record!.execute()).toEqual({ success: false, errorMessage: humanizeError({ httpCode: 409, ...body }) });
    expect(snap(w).createdId).toBeNull();
  });

  it('adds each many-to-many target to the new record, with the junction body', async () => {
    const w = await ready({ props: WITH_PENDING });
    setName(w);
    w.editor.setManyToManyDiff('tags', diff(1, 3));
    const results = await runAll(await stepsOf(w));
    expect(results[1]).toEqual({ success: true, failedCount: 0, totalCount: 2 });
    const junction = posts(w, 'issue_tags');
    expect(junction.map(r => r.body)).toEqual([
      { issue_id: 11, tags_id: 1 },
      { issue_id: 11, tags_id: 3 },
    ]);
    expect(junction[0]!.headers['Prefer']).toBe('return=minimal');
  });

  it('adds rich junction rows with their extra columns', async () => {
    const w = await ready({ props: WITH_PENDING });
    setName(w);
    w.editor.setRichManyToManyDiff('labels', richDiff({ id: 2, extraData: { note: 'urgent' } }, { id: 4, extraData: { note: 'later' } }));
    await runAll(await stepsOf(w));
    expect(posts(w, 'issue_labels').map(r => r.body)).toEqual([
      { issue_id: 11, labels_id: 2, note: 'urgent' },
      { issue_id: 11, labels_id: 4, note: 'later' },
    ]);
  });

  it('sends the additions of a step in parallel', async () => {
    const gates = [deferred(), deferred(), deferred()];
    let n = 0;
    const w = await ready({
      props: WITH_PENDING,
      respond: ({ method, path }) => (method === 'POST' && path === 'issue_tags' ? gates[n++]!.promise : undefined),
    });
    setName(w);
    w.editor.setManyToManyDiff('tags', diff(1, 2, 3));
    const steps = await stepsOf(w);
    await steps[0]!.execute();
    const running = steps[1]!.execute();
    await flush();
    expect(posts(w, 'issue_tags')).toHaveLength(3);
    gates.forEach(g => g.resolve(reply(201, null)));
    expect(await running).toEqual({ success: true, failedCount: 0, totalCount: 3 });
  });

  it('counts failed additions and reports additions_failed', async () => {
    const w = await ready({
      props: WITH_PENDING,
      respond: ({ method, path, body }) => (method === 'POST' && path === 'issue_tags' && body.tags_id === 2 ? reply(409, { message: 'dup' }) : undefined),
    });
    setName(w);
    w.editor.setManyToManyDiff('tags', diff(1, 2, 3));
    const results = await runAll(await stepsOf(w));
    expect(results[1]).toEqual({ success: false, failedCount: 1, totalCount: 3, reason: 'additions_failed' });
  });

  it('succeeds without a request for a step with nothing to add', async () => {
    const w = await ready({ props: WITH_PENDING });
    setName(w);
    w.editor.setManyToManyDiff('tags', { toAdd: [], toRemove: [4] });
    const results = await runAll(await stepsOf(w));
    expect(results[1]).toEqual({ success: true });
    expect(posts(w, 'issue_tags')).toEqual([]);
  });

  it('reports record_id_missing when the record step returned no id', async () => {
    const w = await ready({
      props: WITH_PENDING,
      respond: ({ method, path }) => (method === 'POST' && path === 'issues' ? reply(201, []) : undefined),
    });
    setName(w);
    w.editor.setManyToManyDiff('tags', diff(1));
    w.editor.setRichManyToManyDiff('labels', richDiff({ id: 2, extraData: {} }));
    w.editor.setGalleryDraft('photos', 'g-1');
    const results = await runAll(await stepsOf(w));
    expect(results[0]).toEqual({ success: true });
    expect(results.slice(1, 4)).toEqual([
      { success: false, reason: 'record_id_missing' },
      { success: false, reason: 'record_id_missing' },
      { success: false, reason: 'record_id_missing' },
    ]);
    expect(sent(w).map(r => r.path)).toEqual(['issues']);
  });

  it('links each draft gallery with the legacy RPC body', async () => {
    const w = await ready({ props: WITH_PENDING });
    setName(w);
    w.editor.setGalleryDraft('photos', 'g-1');
    const results = await runAll(await stepsOf(w));
    expect(results[1]).toEqual({ success: true });
    expect(rpcs(w, 'link_gallery_to_entity').map(r => r.body)).toEqual([
      { p_gallery_id: 'g-1', p_entity_type: 'issues', p_entity_id: '11', p_column_name: 'photos' },
    ]);
  });

  it('carries the server text of a failed gallery link, and a reason only when there is none', async () => {
    const withText = await ready({
      props: WITH_PENDING,
      respond: ({ path }) => (path === 'rpc/link_gallery_to_entity' ? reply(400, { message: 'gallery gone' }) : undefined),
    });
    setName(withText);
    withText.editor.setGalleryDraft('photos', 'g-1');
    expect((await runAll(await stepsOf(withText)))[1]).toEqual({ success: false, errorMessage: 'gallery gone' });

    const without = await ready({
      props: WITH_PENDING,
      respond: ({ path }) => (path === 'rpc/link_gallery_to_entity' ? reply(500, {}) : undefined),
    });
    setName(without);
    without.editor.setGalleryDraft('photos', 'g-1');
    expect((await runAll(await stepsOf(without)))[1]).toEqual({ success: false, reason: 'gallery_link_failed' });
  });

  it('runs the galleryImages hook in the last step, and reports gallery_images_failed when it says no', async () => {
    const hook = vi.fn().mockResolvedValue(true);
    const ok = await ready({ props: WITH_PENDING, galleryImages: hook });
    setName(ok);
    ok.editor.setGalleryDraft('photos', 'g-1');
    const results = await runAll(await stepsOf(ok));
    expect(hook).toHaveBeenCalledTimes(1);
    expect(results[2]).toEqual({ success: true });

    const no = await ready({ props: WITH_PENDING, galleryImages: async () => false });
    setName(no);
    no.editor.setGalleryDraft('photos', 'g-1');
    expect((await runAll(await stepsOf(no)))[2]).toEqual({ success: false, reason: 'gallery_images_failed' });
  });

  it('succeeds the gallery images step when the page gave no hook', async () => {
    const w = await ready({ props: WITH_PENDING });
    setName(w);
    w.editor.setGalleryDraft('photos', 'g-1');
    expect((await runAll(await stepsOf(w)))[2]).toEqual({ success: true });
  });

  it('adds the gallery images step only when there are drafts', async () => {
    const w = await ready({ props: WITH_PENDING, galleryImages: vi.fn() });
    setName(w);
    w.editor.setManyToManyDiff('tags', diff(1));
    expect((await stepsOf(w)).map(s => s.kind)).toEqual(['record', 'many_to_many']);
  });

  it('removes the entry when a diff is set empty, and then creates directly', async () => {
    const w = await ready({ props: WITH_PENDING });
    setName(w);
    w.editor.setManyToManyDiff('tags', diff(1));
    w.editor.setManyToManyDiff('tags', { toAdd: [], toRemove: [] });
    w.editor.setRichManyToManyDiff('labels', richDiff({ id: 1, extraData: {} }));
    w.editor.setRichManyToManyDiff('labels', { toAdd: [], toRemove: [], toUpdate: [] });
    expect((await w.editor.save()).status).toBe('created');
  });

  it('keeps a rich diff that only updates or removes', async () => {
    const w = await ready({ props: WITH_PENDING });
    setName(w);
    w.editor.setRichManyToManyDiff('labels', { toAdd: [], toRemove: [], toUpdate: [{ id: 1, extraData: {} }] });
    expect((await w.editor.save()).status).toBe('steps');
  });

  it('skips a diff for a column that is not an inline many-to-many property', async () => {
    const w = await ready({ props: WITH_PENDING });
    setName(w);
    w.editor.setManyToManyDiff('nope', diff(1));
    w.editor.setManyToManyDiff('tags', diff(1));
    const steps = await stepsOf(w);
    expect(steps.map(s => s.kind)).toEqual(['record', 'many_to_many']);
  });

  it('still validates and transforms before offering steps', async () => {
    const w = await ready({ props: [...WITH_PENDING, prop('at', T.DateTime)] });
    w.editor.setManyToManyDiff('tags', diff(1));
    expect(await w.editor.save()).toEqual({ status: 'invalid' });
    setName(w);
    backend(w).setValue('at', '2025-13-45T10:30');
    expect((await w.editor.save() as any).status).toBe('transform_error');
    expect(sent(w)).toEqual([]);
    expect(snap(w).saving).toBe(false);
  });

  it('keeps saving until clearPending, which forgets the diffs and drafts', async () => {
    const w = await ready({ props: WITH_PENDING });
    setName(w);
    w.editor.setManyToManyDiff('tags', diff(1));
    w.editor.setGalleryDraft('photos', 'g-1');
    await stepsOf(w);
    expect(snap(w).saving).toBe(true);
    expect(await w.editor.save()).toEqual({ status: 'ignored' });
    w.editor.clearPending();
    expect(snap(w).saving).toBe(false);
    expect((await w.editor.save()).status).toBe('created');
  });
});

describe('recordEditor: saveAndContinue', () => {
  const guided = (over: Record<string, unknown> = {}): Scenario => ({
    entity: { guided_form_key: 'intake' },
    respond: ({ method, path }) => {
      if (method === 'POST' && path === 'rpc/get_guided_form_context') {
        return reply(200, { step_key: 'basics', parent_id: 7, definition: { parent_table: 'requests' } });
      }
      if (method === 'POST' && path === 'rpc/complete_guided_form_step') return reply(200, { next_record_id: 9, next_step_table: 'details', ...over });
      return undefined;
    },
  });

  it('resolves invalid and touches every field, sending nothing', async () => {
    const w = await ready(guided());
    expect(await w.editor.saveAndContinue()).toEqual({ status: 'invalid' });
    expect(Object.values(snap(w).form!.fields).every(f => f.touched)).toBe(true);
    expect(sent(w)).toEqual([]);
  });

  it('resolves ignored without a form, and while a save is in flight', async () => {
    const none = await ready({ entity: null });
    expect(await none.editor.saveAndContinue()).toEqual({ status: 'ignored' });

    const gate = deferred();
    const w = await ready({ respond: ({ method, path }) => (method === 'POST' && path === 'issues' ? gate.promise : undefined) });
    setName(w);
    const first = w.editor.saveAndContinue();
    expect(snap(w).saving).toBe(true);
    expect(await w.editor.saveAndContinue()).toEqual({ status: 'ignored' });
    gate.resolve(reply(201, [{ id: 3 }]));
    expect(await first).toEqual({ status: 'created', id: 3 });
    expect(snap(w).saving).toBe(false);
  });

  it('transforms before beforeSend: a transform error never reaches the token refresh', async () => {
    const w = await ready({ props: [P.name, prop('at', T.DateTime)] });
    setName(w);
    backend(w).setValue('at', '2025-13-45T10:30');
    const beforeSend = vi.fn();
    const result: any = await w.editor.saveAndContinue(beforeSend);
    expect(result.status).toBe('transform_error');
    expect(result.column).toBe('at');
    expect(beforeSend).not.toHaveBeenCalled();
    expect(snap(w).saving).toBe(false);
  });

  it('resolves aborted with the cause when beforeSend rejects, sending nothing', async () => {
    const w = await ready();
    setName(w);
    const cause = new Error('Token refresh failed');
    expect(await w.editor.saveAndContinue(() => Promise.reject(cause))).toEqual({ status: 'aborted', cause });
    expect(sent(w)).toEqual([]);
    expect(snap(w).saving).toBe(false);
  });

  it('holds saving across the whole sequence', async () => {
    const gate = deferred();
    const w = await ready({
      ...guided(),
      respond: ({ method, path }) => {
        if (method === 'POST' && path === 'issues') return gate.promise;
        return guided().respond!({ method, path, body: undefined }, undefined as any);
      },
    });
    setName(w);
    const running = w.editor.saveAndContinue();
    expect(snap(w).saving).toBe(true);
    gate.resolve(reply(201, [{ id: 11 }]));
    await running;
    expect(snap(w).saving).toBe(false);
  });

  it('falls back to created when the entity has no guided form', async () => {
    const w = await ready();
    setName(w);
    expect(await w.editor.saveAndContinue()).toEqual({ status: 'created', id: 11 });
    expect(snap(w).createdId).toBe(11);
    expect(sent(w).map(r => r.path)).toEqual(['issues']);
  });

  it('falls back to created, without a context request, when the response has no id', async () => {
    const w = await ready({
      ...guided(),
      respond: ({ method, path }) => (method === 'POST' && path === 'issues' ? reply(201, []) : undefined),
    });
    setName(w);
    expect(await w.editor.saveAndContinue()).toEqual({ status: 'created', id: null });
    expect(rpcs(w, 'get_guided_form_context')).toEqual([]);
  });

  it('loads the context and completes the step with the legacy RPC bodies', async () => {
    const w = await ready(guided());
    setName(w);
    const result = await w.editor.saveAndContinue();
    expect(rpcs(w, 'get_guided_form_context').map(r => r.body)).toEqual([
      { p_guided_form_key: 'intake', p_table_name: 'issues', p_record_id: 11 },
    ]);
    expect(rpcs(w, 'complete_guided_form_step').map(r => r.body)).toEqual([
      { p_guided_form_key: 'intake', p_parent_id: 7, p_step_key: 'basics' },
    ]);
    expect(result).toEqual({
      status: 'continued',
      id: 11,
      guidedFormKey: 'intake',
      stepKey: 'basics',
      navigation: { kind: 'edit', table: 'details', id: 9 },
    });
    expect(snap(w).createdId).toBe(11);
  });

  it('uses "__parent__" when the context has no step key, and a numeric parent id from text', async () => {
    const w = await ready({
      entity: { guided_form_key: 'intake' },
      respond: ({ method, path }) => {
        if (path === 'rpc/get_guided_form_context') return reply(200, { step_key: null, parent_id: '12', definition: { parent_table: 'requests' } });
        if (path === 'rpc/complete_guided_form_step') return reply(200, { all_data_steps_complete: true });
        return method === 'POST' && path === 'issues' ? undefined : undefined;
      },
    });
    setName(w);
    const result: any = await w.editor.saveAndContinue();
    expect(rpcs(w, 'complete_guided_form_step')[0]!.body).toEqual({ p_guided_form_key: 'intake', p_parent_id: 12, p_step_key: '__parent__' });
    expect(result.stepKey).toBe('__parent__');
    expect(result.navigation).toEqual({ kind: 'view', table: 'requests', id: '12' });
  });

  it('navigates to the url the backend named when it auto-submitted', async () => {
    const w = await ready(guided({ auto_submitted: true, navigate_to: '/view/requests/7?done=1', next_record_id: null }));
    setName(w);
    expect(((await w.editor.saveAndContinue()) as any).navigation).toEqual({ kind: 'url', url: '/view/requests/7?done=1' });
  });

  it('navigates to the parent record when it auto-submitted without a url', async () => {
    const w = await ready(guided({ auto_submitted: true, next_record_id: null }));
    setName(w);
    expect(((await w.editor.saveAndContinue()) as any).navigation).toEqual({ kind: 'view', table: 'requests', id: '7' });
  });

  it('navigates to the parent record when all data steps are complete', async () => {
    const w = await ready(guided({ all_data_steps_complete: true, next_record_id: null, next_step_table: null }));
    setName(w);
    expect(((await w.editor.saveAndContinue()) as any).navigation).toEqual({ kind: 'view', table: 'requests', id: '7' });
  });

  it('navigates nowhere when the step result names neither', async () => {
    const w = await ready(guided({ next_record_id: null, next_step_table: null }));
    setName(w);
    const result: any = await w.editor.saveAndContinue();
    expect(result.status).toBe('continued');
    expect(result.navigation).toEqual({ kind: 'none' });
    expect(snap(w).saving).toBe(false);
  });

  it('falls back to created when the context cannot be loaded, or comes back empty', async () => {
    const failing = await ready({
      entity: { guided_form_key: 'intake' },
      respond: ({ path }) => (path === 'rpc/get_guided_form_context' ? reply(500, { message: 'no' }) : undefined),
    });
    setName(failing);
    expect(await failing.editor.saveAndContinue()).toEqual({ status: 'created', id: 11 });
    expect(rpcs(failing, 'complete_guided_form_step')).toEqual([]);
    expect(snap(failing).createdId).toBe(11);

    const empty = await ready({ entity: { guided_form_key: 'intake' } });
    setName(empty);
    expect(await empty.editor.saveAndContinue()).toEqual({ status: 'created', id: 11 });
  });

  it('resolves step_failed with the server text when completing the step fails', async () => {
    const w = await ready({
      ...guided(),
      respond: ({ path }) => {
        if (path === 'rpc/get_guided_form_context') return reply(200, { step_key: 'basics', parent_id: 7, definition: { parent_table: 'requests' } });
        if (path === 'rpc/complete_guided_form_step') return reply(400, { message: 'Step not ready', code: 'P0001', hint: 'Fill the rest' });
        return undefined;
      },
    });
    setName(w);
    expect(await w.editor.saveAndContinue()).toEqual({
      status: 'step_failed',
      id: 11,
      guidedFormKey: 'intake',
      stepKey: 'basics',
      error: { message: 'Step not ready', code: 'P0001', hint: 'Fill the rest' },
    });
    expect(snap(w).saving).toBe(false);
  });

  it('resolves failed with the error shape when the create is rejected', async () => {
    const w = await ready({
      entity: { guided_form_key: 'intake' },
      respond: ({ method, path }) => (method === 'POST' && path === 'issues' ? reply(403, { message: 'denied', code: '42501' }) : undefined),
    });
    setName(w);
    const result: any = await w.editor.saveAndContinue();
    expect(result.status).toBe('failed');
    expect(result.error).toMatchObject({ httpCode: 403, code: '42501', message: 'denied', humanMessage: humanizeError({ httpCode: 403, code: '42501' }) });
    expect(rpcs(w, 'get_guided_form_context')).toEqual([]);
    expect(snap(w).saving).toBe(false);
  });

  it('keeps the "System Error" shape for anything unexpected', async () => {
    const w = await ready();
    setName(w);
    vi.spyOn(w.ft.client, 'createData').mockRejectedValue(new TypeError('boom'));
    expect(await w.editor.saveAndContinue()).toEqual({
      status: 'failed',
      error: { httpCode: 500, message: 'An unexpected error occurred', humanMessage: 'System Error' },
    });
  });

  it('ignores pending diffs and drafts, as the legacy page did', async () => {
    const w = await ready({ ...guided(), props: WITH_PENDING });
    setName(w);
    w.editor.setManyToManyDiff('tags', diff(1));
    w.editor.setGalleryDraft('photos', 'g-1');
    await w.editor.saveAndContinue();
    expect(sent(w).map(r => r.path)).toEqual(['issues', 'rpc/get_guided_form_context', 'rpc/complete_guided_form_step']);
  });
});

describe('recordEditor: resetForAnother', () => {
  it('resets the form to its defaults, booleans to false and the rest to null (ported 421, 442)', async () => {
    const w = await ready();
    setName(w, 'Old Value');
    backend(w).setValue('active', true);
    w.editor.resetForAnother();
    expect(value(w, 'name')).toBeNull();
    expect(value(w, 'active')).toBe(false);
    expect(backend(w).resetCalls.at(-1)).toEqual({ name: null, count: null, active: false });
    expect(snap(w).form!.fields['name']!.touched).toBe(false);
  });

  it('sets each field to its default through the backend afterwards, so dependents hear of it', async () => {
    const w = await ready();
    setName(w, 'Old Value');
    backend(w).setValue('active', true);
    const set: [string, unknown][] = [];
    const original = backend(w).setValue;
    backend(w).setValue = (key, v) => {
      set.push([key, v]);
      original(key, v);
    };
    const before = w.notified.count;
    w.editor.resetForAnother();
    expect(set).toEqual([['name', null], ['count', null], ['active', false]]);
    expect(value(w, 'name')).toBeNull();
    expect(value(w, 'count')).toBeNull();
    expect(value(w, 'active')).toBe(false);
    for (const f of Object.values(snap(w).form!.fields)) {
      expect(f.dirty).toBe(false);
      expect(f.touched).toBe(false);
    }
    // The reset is one new snapshot; the re-sets change nothing the store holds, so they add none.
    expect(w.notified.count).toBe(before + 1);
  });

  it('clears createdId, saving and every pending diff and draft', async () => {
    const w = await ready({ props: WITH_PENDING });
    setName(w);
    w.editor.setManyToManyDiff('tags', diff(1));
    w.editor.setRichManyToManyDiff('labels', richDiff({ id: 1, extraData: {} }));
    w.editor.setGalleryDraft('photos', 'g-1');
    const [record] = await stepsOf(w);
    await record!.execute();
    expect(snap(w).createdId).toBe(11);
    expect(snap(w).saving).toBe(true);
    w.editor.resetForAnother();
    expect(snap(w).createdId).toBeNull();
    expect(snap(w).saving).toBe(false);
    setName(w);
    expect((await w.editor.save()).status).toBe('created');
  });

  it('does not apply the prefill again', async () => {
    const w = await ready({ prefill: { name: 'Pothole' } });
    w.editor.resetForAnother();
    expect(value(w, 'name')).toBeNull();
    expect(snap(w).form!.fields['name']!.touched).toBe(false);
  });

  it('publishes a single snapshot', async () => {
    const w = await ready({ props: WITH_PENDING });
    setName(w, 'x');
    const before = w.notified.count;
    w.editor.resetForAnother();
    expect(w.notified.count).toBe(before + 1);
  });

  it('does nothing harmful without a form', async () => {
    const w = await ready({ entity: null });
    expect(() => w.editor.resetForAnother()).not.toThrow();
  });
});

describe('recordEditor: rebuild', () => {
  it('builds a new backend, store and form together, and drops the old store', async () => {
    const w = await ready();
    const old = backend(w);
    expect(old.listeners.size).toBe(1);
    w.editor.rebuild();
    await flush();
    expect(w.state.backends).toHaveLength(2);
    expect(snap(w).backend).toBe(backend(w));
    expect(snap(w).backend).not.toBe(old);
    expect(old.listeners.size).toBe(0);
    expect(backend(w).listeners.size).toBe(1);
  });

  it('starts the new form from the defaults', async () => {
    const w = await ready();
    setName(w, 'typed');
    w.editor.rebuild();
    await flush();
    expect(value(w, 'name')).toBeNull();
  });

  it('shows the new schema after the rebuild', async () => {
    const w = await ready({ props: [P.name] });
    w.state.props = [P.name, P.count];
    w.editor.rebuild();
    await flush();
    expect(snap(w).properties.map(p => p.column_name)).toEqual(['name', 'count']);
    expect(Object.keys(snap(w).form!.fields)).toEqual(['name', 'count']);
  });

  it('is loading while it runs, and keeps the old form meanwhile', async () => {
    const w = await ready();
    const old = snap(w).form;
    w.editor.rebuild();
    expect(snap(w).loading).toBe(true);
    expect(snap(w).form).toBe(old);
    await flush();
    expect(snap(w).loading).toBe(false);
  });

  it('keeps the pending diffs and drafts', async () => {
    const w = await ready({ props: WITH_PENDING });
    w.editor.setManyToManyDiff('tags', diff(1));
    w.editor.rebuild();
    await flush();
    setName(w);
    expect((await w.editor.save()).status).toBe('steps');
  });

  it('keeps the old form, and reports the error, when the schema read fails', async () => {
    const w = await ready();
    const old = snap(w).backend;
    w.state.propertiesFail = true;
    w.editor.rebuild();
    await flush();
    expect(snap(w).error).toEqual(new Error('schema down'));
    expect(snap(w).backend).toBe(old);
    expect(w.state.backends).toHaveLength(1);
    expect(old!.listeners.size).toBe(1);
  });

  it('builds once for rebuilds requested together', async () => {
    const w = await ready();
    w.editor.rebuild();
    w.editor.rebuild();
    await flush();
    expect(w.state.backends).toHaveLength(2);
  });

  it('lets the latest rebuild win over a slower earlier read', async () => {
    const w = await ready({ props: [P.name] });
    let release!: () => void;
    w.state.gate = new Promise<void>(r => {
      release = r;
    });
    w.editor.rebuild();
    await flush();
    w.state.gate = null;
    w.state.props = [P.name, P.count];
    w.editor.rebuild();
    await flush();
    release();
    await flush();
    expect(Object.keys(snap(w).form!.fields)).toEqual(['name', 'count']);
    expect(w.state.backends).toHaveLength(2);
  });
});

describe('recordEditor: dispose', () => {
  it('makes every command throw', async () => {
    const w = await ready({ props: WITH_PENDING });
    w.editor.dispose();
    const calls: (() => unknown)[] = [
      () => w.editor.setManyToManyDiff('tags', diff(1)),
      () => w.editor.setRichManyToManyDiff('labels', richDiff({ id: 1, extraData: {} })),
      () => w.editor.setGalleryDraft('photos', 'g'),
      () => w.editor.clearPending(),
      () => w.editor.save(),
      () => w.editor.saveAndContinue(),
      () => w.editor.resetForAnother(),
      () => w.editor.rebuild(),
    ];
    for (const call of calls) expect(call).toThrow('recordEditor is disposed');
  });

  it('is idempotent, and leaves the snapshot readable', async () => {
    const w = await ready();
    const last = snap(w);
    w.editor.dispose();
    expect(() => w.editor.dispose()).not.toThrow();
    expect(snap(w)).toBe(last);
  });

  it('drops the form store from its backend and stops notifying (ported 458)', async () => {
    const w = await ready();
    const seen = vi.fn();
    w.editor.subscribe(seen);
    const b = backend(w);
    w.editor.dispose();
    expect(b.listeners.size).toBe(0);
    b.setValue('name', 'x');
    expect(seen).not.toHaveBeenCalled();
    expect(w.notified.count).toBe(1);
  });

  it('leaves a second editor, for another route, working (ported 458)', async () => {
    const a = await ready();
    const b = await ready({ entity: { table_name: 'issues' } });
    a.editor.dispose();
    setName(b, 'x');
    expect(value(b, 'name')).toBe('x');
    expect((await b.editor.save()).status).toBe('created');
  });

  it('never builds a form when disposed before the first load', async () => {
    const w = make();
    w.editor.dispose();
    await flush();
    expect(w.state.backends).toEqual([]);
    expect(snap(w).form).toBeNull();
  });

  it('lets a save in flight resolve, without notifying', async () => {
    const gate = deferred();
    const w = await ready({ respond: ({ method, path }) => (method === 'POST' && path === 'issues' ? gate.promise : undefined) });
    setName(w);
    const running = w.editor.save();
    const before = w.notified.count;
    w.editor.dispose();
    gate.resolve(reply(201, [{ id: 8 }]));
    expect(await running).toEqual({ status: 'created', id: 8 });
    expect(w.notified.count).toBe(before);
  });
});
