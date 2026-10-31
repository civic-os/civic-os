/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- fixtures are partial schema rows, as in the handle tests. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataClient } from '../client/data-client.js';
import { humanizeError } from '../errors/index.js';
import type { FormBackend, FormFieldSpec } from '../forms/backend.js';
import { validateValue } from '../forms/validate.js';
import type { ValidationFailure } from '../forms/validate.js';
import { mintEntityHandle } from '../handles/handles.js';
import type { EntityHandle } from '../handles/handles.js';
import { EntityPropertyType } from '../model/entity.js';
import { propertyToSelectString } from '../schema/select.js';
import type { RenderableItem, SchemaEntityProperty, SchemaEntityTable } from '../model/entity.js';
import type { ConstraintMessage } from '../model/index.js';
import { createFakeClock, FAKE_API_URL, fakeTransport, reply } from '../testing/index.js';
import type { FakeTransport } from '../testing/index.js';
import { TransportError } from '../transport/errors.js';
import type { TransportRequest, TransportResponse } from '../transport/types.js';
import { recordEditor } from './record-editor.js';
import type {
  EditorDeps,
  EditorEditStep,
  EditorEditStepResult,
  EditorGallery,
  ManyToManyDiff,
  RecordEditorEdit,
  RichManyToManyDiff,
} from './record-editor.js';
import { editorInternals } from './record-editor-shared.js';

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

const RECORD = { id: 7, name: 'Existing', count: 3, active: true };
const SELECT_BASE = 'issues?select=name,count,active,id&order=id.asc&id=eq.7';

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
  /** The row the record read returns; `null` for no row. */
  record?: Record<string, unknown> | null;
  recordId?: number | string;
  respond?: Route;
  constraintMessages?: ConstraintMessage[];
  backend?: BackendOptions;
  /** Extra editor options (timer settings). */
  options?: { autoSaveDebounceMs?: number; autoSaveSavedMs?: number };
}

interface World {
  editor: RecordEditorEdit<MemBackend>;
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
    record: Record<string, unknown> | null;
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
    record: sc.record === undefined ? RECORD : sc.record,
  };
  const ft = fakeTransport(async req => {
    const path = req.url.startsWith(FAKE_API_URL) ? req.url.slice(FAKE_API_URL.length) : req.url;
    const call: Call = { method: req.method, path, body: req.body === undefined ? undefined : JSON.parse(req.body) };
    const custom = sc.respond?.(call, req);
    if (custom !== undefined) return custom;
    if (req.method === 'GET' && path.startsWith('issues?select=')) return reply(200, state.record ? [state.record] : []);
    if (req.method === 'PATCH' && path.startsWith('issues?id=eq.')) return reply(200, [{ ...RECORD, ...call.body }]);
    if (req.method === 'POST' || req.method === 'PATCH') return reply(201, null);
    return reply(204, null);
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
    mode: 'edit',
    recordId: sc.recordId ?? 7,
    backend: () => {
      const b = memoryBackend(sc.backend);
      state.backends.push(b);
      return b;
    },
    timeZone: ZONE,
    ...sc.options,
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
const writes = (w: World) => sent(w).filter(r => r.method !== 'GET');
const patches = (w: World, path = 'issues?id=eq.7') => sent(w).filter(r => r.method === 'PATCH' && r.path === path);
const posts = (w: World, path: string) => sent(w).filter(r => r.method === 'POST' && r.path === path);
const recordGets = (w: World) => sent(w).filter(r => r.method === 'GET' && r.path.startsWith('issues?select='));
const backend = (w: World): MemBackend => w.state.backends[w.state.backends.length - 1]!;
const value = (w: World, key: string) => snap(w).form!.fields[key]!.value;
const setName = (w: World, v: unknown = 'Changed') => backend(w).setValue('name', v);

const runAll = async (steps: readonly EditorEditStep[]): Promise<EditorEditStepResult[]> => {
  const out: EditorEditStepResult[] = [];
  for (const s of steps) out.push(await s.execute());
  return out;
};

async function stepsOf(w: World): Promise<readonly EditorEditStep[]> {
  const r = await w.editor.save();
  if (r.status !== 'steps') throw new Error(`expected steps, got ${r.status}`);
  return r.steps;
}

const diff = (...add: number[]): ManyToManyDiff => ({ toAdd: add, toRemove: [] });
const richDiff = (over: Partial<RichManyToManyDiff> = {}): RichManyToManyDiff => ({ toAdd: [], toRemove: [], toUpdate: [], ...over });

const WITH_PENDING = [...BASE, TAGS, LABELS, PHOTOS];
const PENDING_ROW = { ...RECORD, photos: null, tags: [], labels: [] };

const gallery = (over: Partial<{ pending: boolean; save: () => Promise<boolean> }> = {}): EditorGallery & { saves: number } => {
  const g = {
    saves: 0,
    hasPendingChanges: () => over.pending ?? false,
    save: async () => {
      g.saves++;
      return over.save ? over.save() : true;
    },
  };
  return g as any;
};

// ---------------------------------------------------------------------------------------------------------------

describe('recordEditor edit: first load', () => {
  it('is loading until the first load settles, then serves the record and the form (ported 129 facade half)', async () => {
    const w = make();
    expect(snap(w).loading).toBe(true);
    expect(snap(w).form).toBeNull();
    expect(snap(w).record).toBeNull();
    expect(snap(w).recordId).toBe(7);
    await flush();
    expect(snap(w).loading).toBe(false);
    expect(snap(w).error).toBeUndefined();
    expect(snap(w).notFound).toBe(false);
    expect(snap(w).backend).toBe(backend(w));
    expect(snap(w).record).toEqual(RECORD);
    expect(snap(w).form).not.toBeNull();
  });

  it('reads the schema, then the record, and sends no write', async () => {
    const w = await ready();
    expect(w.state.propertiesCalls).toEqual([w.handle.liveRow]);
    expect(w.state.renderableCalls).toEqual([[w.handle, 'edit']]);
    expect(writes(w)).toEqual([]);
    expect(recordGets(w)).toHaveLength(1);
  });

  it('serves the edit properties minus non-inline many-to-many (ported 167)', async () => {
    const hidden = prop('internal', T.TextShort, { show_on_edit: false });
    const readonly = prop('locked', T.TextShort, { is_updatable: false });
    const w = await ready({ props: [...BASE, hidden, readonly, m2m('plain', false), TAGS], record: { ...RECORD, tags: [] } });
    const names = snap(w).properties.map(p => p.column_name);
    expect(names).toEqual(['name', 'count', 'active', 'tags']);
    expect(snap(w).inlineManyToMany.map(p => p.column_name)).toEqual(['tags']);
  });

  it('reads the record once, with the edit select fields and the id as given (ported 183)', async () => {
    const w = await ready();
    expect(recordGets(w).map(r => r.path)).toEqual([SELECT_BASE]);
    expect(recordGets(w)[0]!.headers).not.toHaveProperty('prefer');
    expect(snap(w).record).toEqual(RECORD);
  });

  it('keeps a string id a string in the read', async () => {
    const w = await ready({ recordId: 'a-b-c' });
    expect(recordGets(w).map(r => r.path)).toEqual(['issues?select=name,count,active,id&order=id.asc&id=eq.a-b-c']);
    expect(snap(w).recordId).toBe('a-b-c');
  });

  it('selects every property type with its edit string: Status as the raw id, a geography as its text (ported 537)', async () => {
    const w = await ready({
      props: [
        P.name,
        prop('status_id', T.Status, { join_table: 'statuses', join_column: 'id' }),
        prop('owner_id', T.ForeignKeyName, { join_table: 'owners', join_column: 'id' }),
        prop('location', T.GeoPoint),
        prop('location_text', T.TextShort, { is_generated: true, show_on_edit: false }),
        prop('due', T.DateTimeLocal),
        prop('price', T.Money),
        TAGS,
      ],
      record: { id: 7, name: 'n', status_id: 2, owner_id: 4, location: null, location_text: null, due: null, price: null, tags: [] },
    });
    const select = recordGets(w)[0]!.path.split('select=')[1]!.split('&')[0]!;
    const fields = select.split(',');
    expect(fields).toContain('status_id');
    expect(fields).toContain('owner_id');
    expect(fields).toContain('location:location_text');
    expect(fields).toContain('due');
    expect(fields).toContain('price');
    expect(select).toContain('tags:issue_tags!issue_id(tags!tags_id(id,display_name))');
  });

  it('has empty properties, no form and no requests when the entity is not in the schema', async () => {
    const w = await ready({ entity: null });
    expect(snap(w).properties).toEqual([]);
    expect(snap(w).renderables).toEqual([]);
    expect(snap(w).backend).toBeNull();
    expect(snap(w).form).toBeNull();
    expect(snap(w).record).toBeNull();
    expect(snap(w).notFound).toBe(false);
    expect(snap(w).loading).toBe(false);
    expect(snap(w).guidedFormKey).toBeNull();
    expect(w.state.propertiesCalls).toEqual([]);
    expect(w.state.backends).toEqual([]);
    expect(sent(w)).toEqual([]);
  });

  it('reports notFound, with no record, backend or form, when the read returns no row', async () => {
    const w = await ready({ record: null });
    expect(snap(w).notFound).toBe(true);
    expect(snap(w).record).toBeNull();
    expect(snap(w).backend).toBeNull();
    expect(snap(w).form).toBeNull();
    expect(snap(w).loading).toBe(false);
    expect(snap(w).error).toBeUndefined();
    expect(w.state.backends).toEqual([]);
  });

  it('reports a schema read failure as the error, with no form and no record read', async () => {
    const w = make();
    w.state.propertiesFail = true;
    await flush();
    expect(snap(w).error).toEqual(new Error('schema down'));
    expect(snap(w).loading).toBe(false);
    expect(snap(w).form).toBeNull();
    expect(recordGets(w)).toEqual([]);
  });

  it('reports a record read failure as the error, with no form', async () => {
    const w = await ready({ respond: ({ method, path }) => (method === 'GET' && path.startsWith('issues?select=') ? reply(500, { message: 'boom' }) : undefined) });
    expect(snap(w).error).toBeDefined();
    expect(snap(w).loading).toBe(false);
    expect(snap(w).form).toBeNull();
    expect(snap(w).record).toBeNull();
    expect(w.state.backends).toEqual([]);
  });

  it('includes the structural status_id and the inline many-to-many columns in the select', async () => {
    const w = await ready({
      props: [...BASE, prop('status_id', T.Status, { join_table: 'statuses', join_column: 'id', show_on_edit: false }), TAGS, LABELS],
      record: { ...RECORD, status_id: 1, tags: [], labels: [] },
    });
    const select = recordGets(w)[0]!.path.split('select=')[1]!.split('&')[0]!;
    expect(select.split(',')).toContain('status_id');
    expect(select).toContain('tags:issue_tags!issue_id(tags!tags_id(id,display_name))');
    expect(select).toContain('labels:issue_labels!issue_id(note,labels!labels_id(id,display_name))');
  });

  it('reads the guided form key from the entity, and null when it has none', async () => {
    const guided = await ready({ entity: { guided_form_key: 'intake' } });
    const plain = await ready();
    expect(snap(guided).guidedFormKey).toBe('intake');
    expect(snap(plain).guidedFormKey).toBeNull();
  });

  it('holds the resting values of the later commits', async () => {
    const w = await ready();
    expect(snap(w)).toMatchObject({ series: undefined, scopePending: false, guidedForm: null, autoSave: 'idle', savingAndContinuing: false, saving: false });
  });

  it('returns the same snapshot until something changes', async () => {
    const w = await ready();
    const first = snap(w);
    expect(snap(w)).toBe(first);
  });
});

describe('recordEditor edit: record', () => {
  it('flattens inline many-to-many columns as legacy currentData did, and leaves the others (extra columns)', async () => {
    const w = await ready({
      props: [...BASE, TAGS, LABELS],
      record: {
        ...RECORD,
        tags: [{ tags: { id: 1, display_name: 'one' } }, { tags: { id: 2, display_name: 'two' } }],
        labels: [{ labels: { id: 5, display_name: 'five' }, note: 'n5' }],
      },
    });
    const rec = snap(w).record!;
    expect(rec['name']).toBe('Existing');
    expect(rec['tags']).toEqual([
      { id: 1, display_name: 'one' },
      { id: 2, display_name: 'two' },
    ]);
    expect(rec['labels']).toEqual([{ id: 5, display_name: 'five', _junction: { note: 'n5' } }]);
  });

  it('flattens through parent hops to the target table', async () => {
    const hops = m2m('saws', true, { junctionTable: 'issue_reservations', targetTable: 'reservations', relatedTable: 'tools', targetColumn: 'reservation_id', parentHops: [{ table: 'tools', fkColumn: 'tool_id' }] });
    const row = { reservations: { tools: { id: 5, display_name: 'Saw' } } };
    const w = await ready({ props: [...BASE, hops], record: { ...RECORD, saws: [row, row, { reservations: null }] } });
    expect(snap(w).record!['saws']).toEqual([{ id: 5, display_name: 'Saw' }]);
  });

  it('defaults a missing inline many-to-many column to an empty list', async () => {
    const w = await ready({ props: [...BASE, TAGS] });
    expect(snap(w).record!['tags']).toEqual([]);
  });
});

describe('recordEditor edit: the form', () => {
  it('creates one control per form property, in order, with no id field (ported 203, 239)', async () => {
    const status = prop('status_id', T.Status, { join_table: 'statuses', join_column: 'id', show_on_edit: false });
    const w = await ready({ props: [P.id, P.name, P.count, P.active, status, TAGS], record: { ...RECORD, status_id: 2, tags: [] } });
    expect(Object.keys(snap(w).form!.fields)).toEqual(['name', 'count', 'active']);
    expect(backend(w).registered).toEqual(['name', 'count', 'active']);
    expect(snap(w).properties.map(p => p.column_name)).toContain('status_id');
    expect(snap(w).form!.fields['id']).toBeUndefined();
  });

  it('holds the row values in the first form snapshot (ported 220)', async () => {
    const w = await ready();
    expect(value(w, 'name')).toBe('Existing');
    expect(value(w, 'count')).toBe(3);
    expect(value(w, 'active')).toBe(true);
  });

  it('holds a missing column as null', async () => {
    const w = await ready({ record: { id: 7, name: 'Existing' } });
    expect(value(w, 'count')).toBeNull();
    expect(value(w, 'active')).toBeNull();
  });

  it('adds the required validator to non-nullable fields only (ported 253)', async () => {
    const w = await ready({ record: { id: 7, name: null, count: null, active: false } });
    expect(snap(w).form!.fields['name']!.errors).toEqual([{ kind: 'required' }]);
    expect(snap(w).form!.fields['count']!.errors).toEqual([]);
    expect(snap(w).form!.valid).toBe(false);
  });

  it('keeps file properties as fields and never many-to-many', async () => {
    const doc = prop('doc', T.File);
    const w = await ready({ props: [...BASE, doc, TAGS], record: { ...RECORD, doc: { id: 'f-1' }, tags: [] } });
    expect(Object.keys(snap(w).form!.fields)).toEqual(['name', 'count', 'active', 'doc']);
    expect(value(w, 'doc')).toEqual({ id: 'f-1' });
  });

  it('loads in one write: one notification, pristine and untouched', async () => {
    const w = make();
    await flush();
    expect(w.notified.count).toBe(1);
    expect(backend(w).resetCalls).toEqual([]);
    const form = snap(w).form!;
    expect(form.dirty).toBe(false);
    for (const f of Object.values(form.fields)) {
      expect(f.touched).toBe(false);
      expect(f.dirty).toBe(false);
    }
  });

  it('holds the loadedApiValues baseline: the transform of the loaded values', async () => {
    const w = await ready({
      props: [...BASE, prop('due', T.DateTimeLocal), prop('at', T.DateTime)],
      record: { ...RECORD, due: '2026-10-21T16:30:00+00:00', at: '2026-10-21T10:30:00' },
    });
    expect(editorInternals.get(w.editor)!.loadedApiValues()).toEqual({
      name: 'Existing',
      count: 3,
      active: true,
      due: '2026-10-21T16:30:00.000Z',
      at: '2026-10-21T10:30:00',
    });
  });

  it('holds an empty baseline when a loaded value cannot be transformed', async () => {
    const w = await ready({ props: [...BASE, prop('at', T.DateTime)], record: { ...RECORD, at: '2025-13-45T10:30:00' } });
    expect(editorInternals.get(w.editor)!.loadedApiValues()).toEqual({});
    expect(snap(w).error).toBeUndefined();
  });

  it('reads the loaded datetime as the control value (ported 619)', async () => {
    const w = await ready({ props: [...BASE, prop('at', T.DateTime)], record: { ...RECORD, at: '2026-10-21T10:30:00' } });
    expect(value(w, 'at')).toBe('2026-10-21T10:30');
  });

  it('converts a loaded DateTimeLocal from UTC to the zone (ported 635)', async () => {
    const w = await ready({ props: [...BASE, prop('due', T.DateTimeLocal)], record: { ...RECORD, due: '2026-10-21T16:30:00+00:00' } });
    expect(value(w, 'due')).toBe('2026-10-21T12:30');
  });

  it('turns loaded money text into a number (ported 654)', async () => {
    const w = await ready({ props: [...BASE, prop('price', T.Money)], record: { ...RECORD, price: '$1,500.25' } });
    expect(value(w, 'price')).toBe(1500.25);
  });

  it('keeps loaded nulls null (ported 669)', async () => {
    const w = await ready({
      props: [...BASE, prop('at', T.DateTime), prop('due', T.DateTimeLocal), prop('price', T.Money)],
      record: { ...RECORD, at: null, due: null, price: null },
    });
    expect(value(w, 'at')).toBeNull();
    expect(value(w, 'due')).toBeNull();
    expect(value(w, 'price')).toBeNull();
  });

  it('publishes one snapshot per keystroke even when the backend notifies twice', async () => {
    const w = await ready({ backend: { notifyTwice: true } });
    const before = w.notified.count;
    setName(w, 'a');
    expect(w.notified.count).toBe(before + 1);
    setName(w, 'ab');
    expect(w.notified.count).toBe(before + 2);
    expect(value(w, 'name')).toBe('ab');
    setName(w, 'ab');
    expect(w.notified.count).toBe(before + 2);
  });

  it('turns the form valid when the missing value is entered (ported 403)', async () => {
    const w = await ready({ record: { ...RECORD, name: null } });
    expect(snap(w).form!.valid).toBe(false);
    setName(w, 'Now valid');
    expect(snap(w).form!.valid).toBe(true);
  });
});

describe('recordEditor edit: save', () => {
  it('sends one PATCH with the id as given and every form value (ported 281)', async () => {
    const w = await ready();
    setName(w, 'Changed');
    const result = await w.editor.save();
    expect(result).toEqual({ status: 'saved', after: 'success' });
    expect(writes(w)).toHaveLength(1);
    const [req] = patches(w);
    expect(req!.body).toEqual({ name: 'Changed', count: 3, active: true });
    expect(req!.headers['Prefer']).toBe('return=representation');
        expect(snap(w).saving).toBe(false);
  });

  it('keeps a string id a string in the PATCH path', async () => {
    const w = await ready({ recordId: 'a-b-c' });
    await w.editor.save();
    expect(sent(w).filter(r => r.method === 'PATCH').map(r => r.path)).toEqual(['issues?id=eq.a-b-c']);
  });

  it('resolves saved with after success (ported 292)', async () => {
    const w = await ready();
    expect(await w.editor.save()).toEqual({ status: 'saved', after: 'success' });
  });

  it('resolves failed with the legacy error shape when the write is rejected (ported 303)', async () => {
    const body = {
      code: '23505',
      message: 'duplicate key value violates unique constraint "issues_name_key"',
      details: 'Key (name)=(Test) already exists.',
      hint: 'Check your input',
    };
    const w = await ready({ respond: ({ method }) => (method === 'PATCH' ? reply(409, body) : undefined) });
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
    expect(snap(w).saving).toBe(false);
  });

  it('uses the configured constraint message for the human wording', async () => {
    const body = { code: '23514', message: 'new row for relation "issues" violates check constraint "issues_count_check"' };
    const w = await ready({
      constraintMessages: [{ constraint_name: 'issues_count_check', table_name: 'issues', column_name: 'count', error_message: 'Count must be positive.' }],
      respond: ({ method }) => (method === 'PATCH' ? reply(400, body) : undefined),
    });
    const result: any = await w.editor.save();
    expect(result.error.humanMessage).toBe('Count must be positive.');
  });

  it('takes the message from a text body, then the status text, then "Unknown error"', async () => {
    const text = await ready({ respond: ({ method }) => (method === 'PATCH' ? reply(500, { message: 'text body' }) : undefined) });
    expect(((await text.editor.save()) as any).error).toMatchObject({ httpCode: 500, message: 'text body' });
    const bare = await ready({ respond: ({ method }) => (method === 'PATCH' ? reply(503, null) : undefined) });
    const r: any = await bare.editor.save();
    expect(r.status).toBe('failed');
    expect(r.error.httpCode).toBe(503);
    expect(typeof r.error.message).toBe('string');
    expect(r.error.message).not.toBe('');
  });

  it('turns an empty PATCH response into the legacy "may not have been saved" failure', async () => {
    const w = await ready({ respond: ({ method }) => (method === 'PATCH' ? reply(200, []) : undefined) });
    const result: any = await w.editor.save();
    expect(result.status).toBe('failed');
    expect(result.error).toMatchObject({ httpCode: 400, humanMessage: 'Changes may not have been saved' });
    expect(snap(w).saving).toBe(false);
  });

  it('shapes a network failure as status 0', async () => {
    const w = await ready({
      respond: ({ method }) => {
        if (method === 'PATCH') throw new TransportError('network', 'offline');
        return undefined;
      },
    });
    const result: any = await w.editor.save();
    expect(result.status).toBe('failed');
    expect(result.error.httpCode).toBe(0);
  });

  it('keeps the legacy "System Error" shape for anything unexpected', async () => {
    const w = await ready({
      respond: ({ method }) => {
        if (method === 'PATCH') throw new Error('weird');
        return undefined;
      },
    });
    const result: any = await w.editor.save();
    expect(result.status).toBe('failed');
    expect(result.error).toEqual({ httpCode: 500, message: 'An unexpected error occurred', humanMessage: 'System Error' });
  });

  it('sends nothing and resolves ignored when there is no form (ported 338)', async () => {
    const w = await ready({ entity: null });
    expect(await w.editor.save()).toEqual({ status: 'ignored' });
    expect(sent(w)).toEqual([]);
    const missing = await ready({ record: null });
    expect(await missing.editor.save()).toEqual({ status: 'ignored' });
    expect(writes(missing)).toEqual([]);
  });

  it('sends nothing and resolves invalid for an invalid form (ported 366, 378)', async () => {
    const w = await ready({ record: { ...RECORD, name: null } });
    expect(await w.editor.save()).toEqual({ status: 'invalid' });
    expect(writes(w)).toEqual([]);
    expect(snap(w).saving).toBe(false);
  });

  it('marks every field touched when the form is invalid (ported 390)', async () => {
    const w = await ready({ record: { ...RECORD, name: null } });
    await w.editor.save();
    for (const key of ['name', 'count', 'active']) expect(snap(w).form!.fields[key]!.touched).toBe(true);
  });

  it('leaves out the values of disabled fields', async () => {
    const w = await ready();
    backend(w).setEnabled('count', false);
    await w.editor.save();
    expect(patches(w)[0]!.body).toEqual({ name: 'Existing', active: true });
  });

  it('sends a file value as its id and a PhotoGallery as its id, keeping null keys', async () => {
    const doc = prop('doc', T.FileImage);
    const w = await ready({
      props: [...BASE, doc, PHOTOS],
      record: { ...RECORD, doc: { id: 'f-1' }, photos: { id: 'g-1' } },
    });
    await w.editor.save();
    expect(patches(w)[0]!.body).toEqual({ name: 'Existing', count: 3, active: true, doc: 'f-1', photos: 'g-1' });
    const none = await ready({ props: [...BASE, doc, PHOTOS], record: { ...RECORD, doc: null, photos: null } });
    await none.editor.save();
    expect(patches(none)[0]!.body).toMatchObject({ doc: null, photos: null });
  });

  it('never sends many-to-many keys', async () => {
    const w = await ready({ props: [...BASE, TAGS], record: { ...RECORD, tags: [{ tags: { id: 1, display_name: 'x' } }] } });
    await w.editor.save();
    expect(Object.keys(patches(w)[0]!.body as object)).not.toContain('tags');
  });

  it('holds saving for the call and ignores a second save meanwhile', async () => {
    const gate = deferred();
    const w = await ready({ respond: ({ method }) => (method === 'PATCH' ? gate.promise : undefined) });
    const first = w.editor.save();
    expect(snap(w).saving).toBe(true);
    expect(await w.editor.save()).toEqual({ status: 'ignored' });
    expect(patches(w)).toHaveLength(1);
    gate.resolve(reply(200, [RECORD]));
    expect(await first).toEqual({ status: 'saved', after: 'success' });
    expect(snap(w).saving).toBe(false);
  });

  it('sends the DateTime value with :00 seconds (ported 698)', async () => {
    const w = await ready({ props: [...BASE, prop('at', T.DateTime)], record: { ...RECORD, at: '2026-10-21T10:30:00' } });
    await w.editor.save();
    expect(patches(w)[0]!.body).toMatchObject({ at: '2026-10-21T10:30:00' });
    backend(w).setValue('at', '2026-10-22T09:15');
    await w.editor.save();
    expect(patches(w)[1]!.body).toMatchObject({ at: '2026-10-22T09:15:00' });
  });

  it('sends the DateTimeLocal value converted to UTC (ported 720)', async () => {
    const w = await ready({ props: [...BASE, prop('due', T.DateTimeLocal)], record: { ...RECORD, due: '2026-10-21T16:30:00+00:00' } });
    backend(w).setValue('due', '2026-10-21T17:30');
    await w.editor.save();
    expect(patches(w)[0]!.body).toMatchObject({ due: '2026-10-21T21:30:00.000Z' });
  });

  it('sends money as a number (ported 746)', async () => {
    const w = await ready({ props: [...BASE, prop('price', T.Money)], record: { ...RECORD, price: '$1,500.25' } });
    await w.editor.save();
    expect(patches(w)[0]!.body).toMatchObject({ price: 1500.25 });
  });

  it('transforms every kind of value in one body (ported 769)', async () => {
    const w = await ready({
      props: [...BASE, prop('at', T.DateTime), prop('due', T.DateTimeLocal), prop('price', T.Money)],
      record: { ...RECORD, at: '2026-10-21T10:30:00', due: '2026-10-21T16:30:00+00:00', price: '$20.00' },
    });
    setName(w, 'Mixed');
    await w.editor.save();
    expect(patches(w)[0]!.body).toEqual({
      name: 'Mixed',
      count: 3,
      active: true,
      at: '2026-10-21T10:30:00',
      due: '2026-10-21T16:30:00.000Z',
      price: 20,
    });
  });

  it('resolves transform_error for an impossible local time, never reaching beforeSend', async () => {
    const w = await ready({ props: [...BASE, prop('at', T.DateTime)], record: { ...RECORD, at: '2026-10-21T10:30:00' } });
    backend(w).setValue('at', '2025-13-45T10:30');
    const beforeSend = vi.fn(async () => {});
    const result: any = await w.editor.save(beforeSend);
    expect(result.status).toBe('transform_error');
    expect(result.column).toBe('at');
    expect(typeof result.message).toBe('string');
    expect(beforeSend).not.toHaveBeenCalled();
    expect(writes(w)).toEqual([]);
    expect(snap(w).saving).toBe(false);
  });

  it('never reaches beforeSend for an invalid form', async () => {
    const w = await ready({ record: { ...RECORD, name: null } });
    const beforeSend = vi.fn(async () => {});
    expect(await w.editor.save(beforeSend)).toEqual({ status: 'invalid' });
    expect(beforeSend).not.toHaveBeenCalled();
  });

  it('sends the PATCH after beforeSend resolved (ported 837, 849)', async () => {
    const w = await ready();
    const order: string[] = [];
    const result = await w.editor.save(async () => {
      order.push(`beforeSend after ${writes(w).length} writes`);
    });
    expect(order).toEqual(['beforeSend after 0 writes']);
    expect(patches(w)).toHaveLength(1);
    expect(result).toEqual({ status: 'saved', after: 'success' });
  });

  it('resolves aborted with the cause when beforeSend rejects (ported 862)', async () => {
    const w = await ready();
    const cause = new Error('Token refresh failed');
    expect(await w.editor.save(() => Promise.reject(cause))).toEqual({ status: 'aborted', cause });
  });

  it('sends nothing and releases saving when beforeSend rejects (ported 880)', async () => {
    const w = await ready();
    await w.editor.save(() => Promise.reject(new Error('expired')));
    expect(writes(w)).toEqual([]);
    expect(snap(w).saving).toBe(false);
  });

  it('holds saving while beforeSend runs', async () => {
    const w = await ready();
    let release!: () => void;
    const held = new Promise<void>(r => {
      release = r;
    });
    const running = w.editor.save(() => held);
    expect(snap(w).saving).toBe(true);
    expect(await w.editor.save()).toEqual({ status: 'ignored' });
    release();
    expect((await running).status).toBe('saved');
    expect(snap(w).saving).toBe(false);
  });
});

describe('recordEditor edit: coordinated save', () => {
  it('is the plain PATCH with no diffs and a registered gallery with nothing pending', async () => {
    const w = await ready({ props: WITH_PENDING, record: PENDING_ROW });
    const g = gallery({ pending: false });
    w.editor.registerGallery('photos', g);
    expect(await w.editor.save()).toEqual({ status: 'saved', after: 'success' });
    expect(patches(w)).toHaveLength(1);
    expect(g.saves).toBe(0);
  });

  it('is triggered by a many-to-many diff, sending nothing until the steps run', async () => {
    const w = await ready({ props: WITH_PENDING, record: PENDING_ROW });
    w.editor.setManyToManyDiff('tags', diff(1));
    const steps = await stepsOf(w);
    expect(writes(w)).toEqual([]);
    expect(steps.map(s => s.kind)).toEqual(['record', 'many_to_many']);
    expect(snap(w).saving).toBe(true);
  });

  it('is triggered by a gallery with pending changes, and adds the galleries step', async () => {
    const w = await ready({ props: WITH_PENDING, record: PENDING_ROW });
    const g = gallery({ pending: true });
    w.editor.registerGallery('photos', g);
    const steps = await stepsOf(w);
    expect(steps.map(s => s.kind)).toEqual(['record', 'galleries']);
  });

  it('adds the galleries step whenever any gallery is registered once the path is taken', async () => {
    const w = await ready({ props: WITH_PENDING, record: PENDING_ROW });
    w.editor.registerGallery('photos', gallery({ pending: false }));
    w.editor.setManyToManyDiff('tags', diff(1));
    expect((await stepsOf(w)).map(s => s.kind)).toEqual(['record', 'many_to_many', 'galleries']);
  });

  it('orders the steps record, pure junctions, rich junctions, galleries, with their counts', async () => {
    const w = await ready({ props: WITH_PENDING, record: PENDING_ROW });
    w.editor.registerGallery('photos', gallery({ pending: true }));
    w.editor.setRichManyToManyDiff('labels', richDiff({ toAdd: [{ id: 2, extraData: { note: 'x' } }], toRemove: [8, 9], toUpdate: [{ id: 3, extraData: { note: 'y' } }] }));
    w.editor.setManyToManyDiff('tags', { toAdd: [1, 3], toRemove: [4] });
    const steps = await stepsOf(w);
    expect(steps.map(s => s.kind)).toEqual(['record', 'many_to_many', 'rich_many_to_many', 'galleries']);
    expect(steps[1]).toMatchObject({ column: 'tags', addCount: 2, removeCount: 1, property: { column_name: 'tags' } });
    expect(steps[2]).toMatchObject({ column: 'labels', addCount: 1, removeCount: 2, updateCount: 1 });
  });

  it('runs the record step as the one PATCH', async () => {
    const w = await ready({ props: WITH_PENDING, record: PENDING_ROW });
    setName(w);
    w.editor.setManyToManyDiff('tags', diff(1));
    const [record] = await stepsOf(w);
    expect(await record!.execute()).toEqual({ success: true });
    expect(patches(w)[0]!.body).toMatchObject({ name: 'Changed' });
    expect(patches(w)).toHaveLength(1);
  });

  it('words a failed record step with the human message, then the message', async () => {
    const body = { code: '23505', message: 'duplicate key value violates unique constraint "k"' };
    const w = await ready({ props: WITH_PENDING, record: PENDING_ROW, respond: ({ method }) => (method === 'PATCH' ? reply(409, body) : undefined) });
    w.editor.setManyToManyDiff('tags', diff(1));
    const [record] = await stepsOf(w);
    const result: any = await record!.execute();
    expect(result.success).toBe(false);
    expect(result.errorMessage).toBe(humanizeError({ httpCode: 409, code: '23505', message: body.message }));
    const bare = await ready({ props: WITH_PENDING, record: PENDING_ROW, respond: ({ method }) => (method === 'PATCH' ? reply(200, []) : undefined) });
    bare.editor.setManyToManyDiff('tags', diff(1));
    expect(await (await stepsOf(bare))[0]!.execute()).toEqual({ success: false, errorMessage: 'Changes may not have been saved' });
  });

  it('removes then adds in a pure junction step, with the legacy junction requests', async () => {
    const w = await ready({ props: WITH_PENDING, record: PENDING_ROW });
    w.editor.setManyToManyDiff('tags', { toAdd: [1], toRemove: [4] });
    const steps = await stepsOf(w);
    await steps[0]!.execute();
    expect(await steps[1]!.execute()).toEqual({ success: true, failedCount: 0, totalCount: 2 });
    const junction = sent(w).filter(r => r.path.startsWith('issue_tags'));
    expect(junction.map(r => `${r.method} ${r.path}`)).toEqual(['DELETE issue_tags?issue_id=eq.7&tags_id=eq.4', 'POST issue_tags']);
    expect(junction[1]!.body).toEqual({ issue_id: 7, tags_id: 1 });
    expect(junction[1]!.headers['Prefer']).toBe('return=minimal');
  });

  it('keeps a string id a string in the junction requests', async () => {
    const w = await ready({ props: WITH_PENDING, record: PENDING_ROW, recordId: 'u-1' });
    w.editor.setManyToManyDiff('tags', { toAdd: [1], toRemove: [4] });
    const steps = await stepsOf(w);
    await steps[1]!.execute();
    expect(sent(w).filter(r => r.path.startsWith('issue_tags')).map(r => r.path)).toEqual(['issue_tags?issue_id=eq.u-1&tags_id=eq.4', 'issue_tags']);
    expect(posts(w, 'issue_tags')[0]!.body).toEqual({ issue_id: 'u-1', tags_id: 1 });
  });

  it('sends the operations of a step in parallel', async () => {
    const gates = [deferred(), deferred(), deferred()];
    let n = 0;
    const w = await ready({
      props: WITH_PENDING,
      record: PENDING_ROW,
      respond: ({ path }) => (path.startsWith('issue_tags') ? gates[n++]!.promise : undefined),
    });
    w.editor.setManyToManyDiff('tags', { toAdd: [1, 2], toRemove: [3] });
    const steps = await stepsOf(w);
    await steps[0]!.execute();
    const running = steps[1]!.execute();
    await flush();
    expect(sent(w).filter(r => r.path.startsWith('issue_tags'))).toHaveLength(3);
    gates.forEach(g => g.resolve(reply(204, null)));
    expect(await running).toEqual({ success: true, failedCount: 0, totalCount: 3 });
  });

  it('counts failed operations and reports changes_failed with the counts', async () => {
    const w = await ready({
      props: WITH_PENDING,
      record: PENDING_ROW,
      respond: ({ method, path, body }) => (method === 'POST' && path === 'issue_tags' && body.tags_id === 2 ? reply(409, { message: 'dup' }) : undefined),
    });
    w.editor.setManyToManyDiff('tags', diff(1, 2, 3));
    const results = await runAll(await stepsOf(w));
    expect(results[1]).toEqual({ success: false, failedCount: 1, totalCount: 3, reason: 'changes_failed' });
  });

  it('succeeds without a request for a step with nothing to do', async () => {
    const w = await ready({ props: WITH_PENDING, record: PENDING_ROW });
    w.editor.setRichManyToManyDiff('labels', richDiff({ toUpdate: [] , toAdd: [] , toRemove: [1]}));
    const steps = await stepsOf(w);
    await steps[1]!.execute();
    expect(sent(w).filter(r => r.path.startsWith('issue_labels'))).toHaveLength(1);
  });

  it('runs a rich step as removals, additions with extra data, then updates', async () => {
    const w = await ready({ props: WITH_PENDING, record: PENDING_ROW });
    w.editor.setRichManyToManyDiff(
      'labels',
      richDiff({ toRemove: [8], toAdd: [{ id: 2, extraData: { note: 'x' } }], toUpdate: [{ id: 3, extraData: { note: 'y' } }] }),
    );
    const steps = await stepsOf(w);
    await steps[0]!.execute();
    expect(await steps[1]!.execute()).toEqual({ success: true, failedCount: 0, totalCount: 3 });
    const junction = sent(w).filter(r => r.path.startsWith('issue_labels'));
    expect(junction.map(r => `${r.method} ${r.path}`)).toEqual([
      'DELETE issue_labels?issue_id=eq.7&labels_id=eq.8',
      'POST issue_labels',
      'PATCH issue_labels?issue_id=eq.7&labels_id=eq.3',
    ]);
    expect(junction[1]!.body).toEqual({ issue_id: 7, labels_id: 2, note: 'x' });
    expect(junction[2]!.body).toEqual({ note: 'y' });
    expect(junction[2]!.headers['Prefer']).toBe('return=minimal');
  });

  it('counts failed rich operations as changes_failed', async () => {
    const w = await ready({
      props: WITH_PENDING,
      record: PENDING_ROW,
      respond: ({ method, path }) => (method === 'DELETE' && path.startsWith('issue_labels') ? reply(500, { message: 'no' }) : undefined),
    });
    w.editor.setRichManyToManyDiff('labels', richDiff({ toRemove: [8], toAdd: [{ id: 2, extraData: {} }] }));
    const results = await runAll(await stepsOf(w));
    expect(results[1]).toEqual({ success: false, failedCount: 1, totalCount: 2, reason: 'changes_failed' });
  });

  it('saves every registered gallery in parallel in the galleries step', async () => {
    const w = await ready({ props: [...WITH_PENDING, prop('docs', T.PhotoGallery)], record: { ...PENDING_ROW, docs: null } });
    const releases: (() => void)[] = [];
    const slow = (): EditorGallery & { saves: number } =>
      gallery({
        pending: true,
        save: () =>
          new Promise<boolean>(r => {
            releases.push(() => r(true));
          }),
      });
    const a = slow();
    const b = slow();
    w.editor.registerGallery('photos', a);
    w.editor.registerGallery('docs', b);
    const steps = await stepsOf(w);
    const running = steps[1]!.execute();
    await flush();
    expect([a.saves, b.saves]).toEqual([1, 1]);
    releases.forEach(r => r());
    expect(await running).toEqual({ success: true });
  });

  it('reports gallery_save_failed when any gallery resolves false', async () => {
    const falsy = await ready({ props: WITH_PENDING, record: PENDING_ROW });
    falsy.editor.registerGallery('photos', gallery({ pending: true, save: async () => false }));
    expect((await runAll(await stepsOf(falsy)))[1]).toEqual({ success: false, reason: 'gallery_save_failed' });
  });

  it('rejects the galleries step when a gallery save throws, as legacy forwarded the rejection', async () => {
    const thrown = await ready({ props: WITH_PENDING, record: PENDING_ROW });
    thrown.editor.registerGallery('photos', gallery({ pending: true, save: () => Promise.reject(new Error('x')) }));
    const steps = await stepsOf(thrown);
    await expect(steps[1]!.execute()).rejects.toThrow('x');
  });

  it('removes the entry when a diff is set empty, and then patches directly', async () => {
    const w = await ready({ props: WITH_PENDING, record: PENDING_ROW });
    w.editor.setManyToManyDiff('tags', diff(1));
    w.editor.setManyToManyDiff('tags', { toAdd: [], toRemove: [] });
    w.editor.setRichManyToManyDiff('labels', richDiff({ toRemove: [1] }));
    w.editor.setRichManyToManyDiff('labels', richDiff());
    expect((await w.editor.save()).status).toBe('saved');
  });

  it('keeps a rich diff that only updates or removes', async () => {
    const w = await ready({ props: WITH_PENDING, record: PENDING_ROW });
    w.editor.setRichManyToManyDiff('labels', richDiff({ toUpdate: [{ id: 1, extraData: { note: 'n' } }] }));
    expect((await stepsOf(w)).map(s => s.kind)).toEqual(['record', 'rich_many_to_many']);
  });

  it('skips a diff for a column that is not an inline many-to-many, though it still triggers', async () => {
    const w = await ready({ props: [...WITH_PENDING, m2m('plain', false)], record: PENDING_ROW });
    w.editor.setManyToManyDiff('plain', diff(1));
    w.editor.setManyToManyDiff('nope', diff(1));
    const steps = await stepsOf(w);
    expect(steps.map(s => s.kind)).toEqual(['record']);
  });

  it('still validates and transforms before offering steps', async () => {
    const w = await ready({ props: WITH_PENDING, record: { ...PENDING_ROW, name: null } });
    w.editor.setManyToManyDiff('tags', diff(1));
    expect(await w.editor.save()).toEqual({ status: 'invalid' });
  });

  it('runs beforeSend before the steps are returned, with no write sent before it', async () => {
    const w = await ready({ props: WITH_PENDING, record: PENDING_ROW });
    w.editor.setManyToManyDiff('tags', diff(1));
    const seen: number[] = [];
    const result = await w.editor.save(async () => {
      seen.push(writes(w).length);
    });
    expect(seen).toEqual([0]);
    expect(result.status).toBe('steps');
    expect(writes(w)).toEqual([]);
    expect(snap(w).saving).toBe(true);
  });

  it('resolves aborted instead of steps when beforeSend rejects with pending changes', async () => {
    const w = await ready({ props: WITH_PENDING, record: PENDING_ROW });
    w.editor.setManyToManyDiff('tags', diff(1));
    const cause = new Error('expired');
    expect(await w.editor.save(() => Promise.reject(cause))).toEqual({ status: 'aborted', cause });
    expect(snap(w).saving).toBe(false);
  });

  it('keeps saving until clearPending, which forgets the diffs', async () => {
    const w = await ready({ props: WITH_PENDING, record: PENDING_ROW });
    w.editor.setManyToManyDiff('tags', diff(1));
    await stepsOf(w);
    expect(snap(w).saving).toBe(true);
    expect(await w.editor.save()).toEqual({ status: 'ignored' });
    w.editor.clearPending();
    expect(snap(w).saving).toBe(false);
    expect((await w.editor.save()).status).toBe('saved');
  });
});

describe('recordEditor edit: registerGallery', () => {
  it('returns a function that unregisters the gallery', async () => {
    const w = await ready({ props: WITH_PENDING, record: PENDING_ROW });
    const off = w.editor.registerGallery('photos', gallery({ pending: true }));
    off();
    expect(await w.editor.save()).toEqual({ status: 'saved', after: 'success' });
  });

  it('replaces a registration for the same column, and a stale unregister leaves the new one', async () => {
    const w = await ready({ props: WITH_PENDING, record: PENDING_ROW });
    const first = gallery({ pending: true });
    const second = gallery({ pending: true });
    const offFirst = w.editor.registerGallery('photos', first);
    w.editor.registerGallery('photos', second);
    offFirst();
    const steps = await stepsOf(w);
    await runAll(steps);
    expect([first.saves, second.saves]).toEqual([0, 1]);
  });

  it('does not throw when unregistering after dispose', async () => {
    const w = await ready({ props: WITH_PENDING, record: PENDING_ROW });
    const off = w.editor.registerGallery('photos', gallery());
    w.editor.dispose();
    expect(() => off()).not.toThrow();
  });

  it('survives a rebuild', async () => {
    const w = await ready({ props: WITH_PENDING, record: PENDING_ROW });
    w.editor.registerGallery('photos', gallery({ pending: true }));
    w.editor.rebuild();
    await flush();
    expect((await stepsOf(w)).map(s => s.kind)).toEqual(['record', 'galleries']);
  });
});

describe('recordEditor edit: rebuild', () => {
  it('re-reads schema and record, builds a new backend, store and form, and drops the old store', async () => {
    const w = await ready();
    const old = backend(w);
    expect(old.listeners.size).toBe(1);
    w.state.record = { ...RECORD, name: 'Reloaded' };
    w.editor.rebuild();
    await flush();
    expect(w.state.backends).toHaveLength(2);
    expect(snap(w).backend).toBe(backend(w));
    expect(snap(w).backend).not.toBe(old);
    expect(old.listeners.size).toBe(0);
    expect(backend(w).listeners.size).toBe(1);
    expect(recordGets(w)).toHaveLength(2);
    expect(w.state.propertiesCalls).toHaveLength(2);
    expect(value(w, 'name')).toBe('Reloaded');
    expect(snap(w).record!['name']).toBe('Reloaded');
  });

  it('serves a new editor for another record as a fresh load (ported 467)', async () => {
    const a = await ready();
    const b = await ready({ recordId: 8, record: { id: 8, name: 'Other', count: 1, active: false } });
    a.editor.dispose();
    expect(recordGets(b).map(r => r.path)).toEqual(['issues?select=name,count,active,id&order=id.asc&id=eq.8']);
    expect(value(b, 'name')).toBe('Other');
    expect(snap(b).recordId).toBe(8);
  });

  it('builds a new backend, store and form for a new entity, and the old store is disposed (ported 507)', async () => {
    const a = await ready();
    const ba = backend(a);
    const b = await ready({ entity: { table_name: 'issues' }, props: [P.name], record: { id: 7, name: 'x' } });
    a.editor.dispose();
    expect(ba.listeners.size).toBe(0);
    expect(backend(b)).not.toBe(ba);
    expect(Object.keys(snap(b).form!.fields)).toEqual(['name']);
    expect(backend(b).listeners.size).toBe(1);
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

  it('keeps the pending diffs', async () => {
    const w = await ready({ props: WITH_PENDING, record: PENDING_ROW });
    w.editor.setManyToManyDiff('tags', diff(1));
    w.editor.rebuild();
    await flush();
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

  it('drops the previous form when the record is gone after a rebuild', async () => {
    const w = await ready();
    const old = backend(w);
    w.state.record = null;
    w.editor.rebuild();
    await flush();
    expect(snap(w).notFound).toBe(true);
    expect(snap(w).form).toBeNull();
    expect(snap(w).backend).toBeNull();
    expect(snap(w).record).toBeNull();
    expect(old.listeners.size).toBe(0);
  });

  it('builds once for rebuilds requested together', async () => {
    const w = await ready();
    w.editor.rebuild();
    w.editor.rebuild();
    await flush();
    expect(w.state.backends).toHaveLength(2);
  });

  it('lets the latest rebuild win over a slower earlier read', async () => {
    const w = await ready({ props: [P.name], record: { id: 7, name: 'x' } });
    let release!: () => void;
    w.state.gate = new Promise<void>(r => {
      release = r;
    });
    w.editor.rebuild();
    await flush();
    w.state.gate = null;
    w.state.props = [P.name, P.count];
    w.state.record = { id: 7, name: 'x', count: 2 };
    w.editor.rebuild();
    await flush();
    release();
    await flush();
    expect(Object.keys(snap(w).form!.fields)).toEqual(['name', 'count']);
    expect(w.state.backends).toHaveLength(2);
  });
});

describe('recordEditor edit: dispose', () => {
  it('makes every command throw', async () => {
    const w = await ready({ props: WITH_PENDING, record: PENDING_ROW });
    w.editor.dispose();
    const calls: (() => unknown)[] = [
      () => w.editor.setManyToManyDiff('tags', diff(1)),
      () => w.editor.setRichManyToManyDiff('labels', richDiff()),
      () => w.editor.registerGallery('photos', gallery()),
      () => w.editor.clearPending(),
      () => w.editor.save(),
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

  it('drops the form store from its backend and stops notifying', async () => {
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

  it('never builds a form when disposed before the first load', async () => {
    const w = make();
    w.editor.dispose();
    await flush();
    expect(w.state.backends).toEqual([]);
    expect(snap(w).form).toBeNull();
  });

  it('lets a save in flight resolve, without notifying', async () => {
    const gate = deferred();
    const w = await ready({ respond: ({ method }) => (method === 'PATCH' ? gate.promise : undefined) });
    const running = w.editor.save();
    const before = w.notified.count;
    w.editor.dispose();
    gate.resolve(reply(200, [RECORD]));
    expect(await running).toEqual({ status: 'saved', after: 'success' });
    expect(w.notified.count).toBe(before);
  });
});

// ---- series (commit 11) -------------------------------------------------------------------------------------------

const STATUS = prop('status_id', T.Status);
const SLOT = prop('time_slot', T.TimeSlot);
const BOOKING = prop('booking_window', T.TimeSlot);
const STARTS = prop('starts', T.DateTimeLocal);
const SERIES_PROPS = [...BASE, STATUS, SLOT, BOOKING, STARTS];
const SERIES_PENDING_PROPS = [...SERIES_PROPS, TAGS, PHOTOS];
const LOADED_SLOT = '["2026-01-13 22:30:00+00","2026-01-13 23:30:00+00")';
const SERIES_RECORD = { ...RECORD, status_id: 1, time_slot: LOADED_SLOT, booking_window: null, starts: '2026-01-13T22:30:00+00:00' };
const SERIES_PENDING_RECORD = { ...SERIES_RECORD, photos: null, tags: [] };
const MEMBER = { is_member: true, series_id: 3, group_id: 5, occurrence_date: '2026-01-13' };
const SCHEDULE = { timezone: 'America/New_York', dtstart: '2026-01-06T17:30:00', time_slot_property: 'time_slot' };
const SCHEDULE_URL = 'time_slot_series?id=eq.3&select=timezone,dtstart,time_slot_property';
const NEW_SLOT = '[2026-01-13T23:30:00.000Z,2026-01-14T00:30:00.000Z)';

type Resp = TransportResponse | Promise<TransportResponse>;
interface SeriesRoutes {
  membership?: Resp | (() => Resp);
  schedule?: Resp | (() => Resp);
  split?: Resp | (() => Resp);
  template?: Resp | (() => Resp);
}
const answer = (v: Resp | (() => Resp) | undefined, fallback: Resp): Resp => (v === undefined ? fallback : typeof v === 'function' ? v() : v);

/** Routes the four series requests; anything else falls through to the default replies. */
const seriesRoute =
  (o: SeriesRoutes = {}): Route =>
  ({ method, path }) => {
    if (method === 'POST' && path === 'rpc/get_series_membership') return answer(o.membership, reply(200, MEMBER));
    if (method === 'GET' && path === SCHEDULE_URL) return answer(o.schedule, reply(200, [SCHEDULE]));
    if (method === 'POST' && path === 'rpc/split_series_from_date') return answer(o.split, reply(200, { success: true }));
    if (method === 'POST' && path === 'rpc/update_series_template') return answer(o.template, reply(200, { success: true }));
    return undefined;
  };

const seriesReady = (routes: SeriesRoutes = {}, sc: Scenario = {}): Promise<World> =>
  ready({ props: SERIES_PROPS, record: SERIES_RECORD, ...sc, respond: seriesRoute(routes) });

const rpcs = (w: World, name: string) => posts(w, `rpc/${name}`);
const memberships = (w: World) => rpcs(w, 'get_series_membership');
const scheduleReads = (w: World) => sent(w).filter(r => r.method === 'GET' && r.path.startsWith('time_slot_series'));
const splitBody = (w: World): any => (rpcs(w, 'split_series_from_date')[0] as any).body;
const seriesWrites = (w: World) => writes(w).filter(r => !r.path.startsWith('rpc/get_series_membership'));

/** Save on a member (scope_required), then continue with `scope`. */
async function scoped(w: World, scope: 'this_only' | 'this_and_future' | 'all', beforeSend?: () => Promise<void>) {
  expect(await w.editor.save()).toEqual({ status: 'scope_required' });
  return w.editor.saveWithScope(scope, beforeSend);
}

/** Edits the form, saves, and splits. */
async function splitWith(w: World, edits: Record<string, unknown>) {
  for (const [k, v] of Object.entries(edits)) backend(w).setValue(k, v);
  const result = await scoped(w, 'this_and_future');
  return { result, body: splitBody(w) };
}

describe('recordEditor edit: series membership', () => {
  it('reads get_series_membership after the record loads, with the record id as given (a string stays a string)', async () => {
    const w = await seriesReady({}, { recordId: '42' });
    expect(memberships(w).map(r => r.body)).toEqual([{ p_entity_table: 'issues', p_entity_id: '42' }]);
    expect(snap(w).series).toEqual(MEMBER);
    const n = await seriesReady();
    expect(memberships(n).map(r => r.body)).toEqual([{ p_entity_table: 'issues', p_entity_id: 7 }]);
  });

  it('reads only when a TimeSlot or RecurringTimeSlot property is among the edit properties', async () => {
    const plain = await ready({ respond: seriesRoute() });
    expect(memberships(plain)).toEqual([]);
    expect(snap(plain).series).toBeUndefined();
    const recurring = await ready({
      props: [...BASE, prop('when', T.RecurringTimeSlot)],
      record: { ...RECORD, when: null },
      respond: seriesRoute(),
    });
    expect(memberships(recurring)).toHaveLength(1);
    expect(snap(recurring).series).toEqual(MEMBER);
  });

  it('is undefined until the read lands', async () => {
    const gate = deferred();
    const w = await seriesReady({ membership: gate.promise });
    expect(snap(w).loading).toBe(false);
    expect(snap(w).series).toBeUndefined();
    gate.resolve(reply(200, MEMBER));
    await flush();
    expect(snap(w).series).toEqual(MEMBER);
  });

  it('publishes { is_member: false } when the read fails or returns nothing (the service maps a failure to it)', async () => {
    const failed = await seriesReady({ membership: reply(500, { message: 'down' }) });
    expect(snap(failed).series).toEqual({ is_member: false });
    const thrown = await seriesReady({
      membership: () => {
        throw new TransportError('network', 'offline');
      },
    });
    expect(snap(thrown).series).toEqual({ is_member: false });
    const empty = await seriesReady({ membership: reply(200, null) });
    expect(snap(empty).series).toEqual({ is_member: false });
  });

  it('is not read after the record is not found, an entity absent from the schema, or a failed load', async () => {
    const missing = await seriesReady({}, { record: null });
    expect(memberships(missing)).toEqual([]);
    const absent = await seriesReady({}, { entity: null });
    expect(memberships(absent)).toEqual([]);
    const failedLoad = await ready({
      props: SERIES_PROPS,
      respond: (call, req) => (call.method === 'GET' && call.path.startsWith('issues?select=') ? reply(500, { message: 'down' }) : seriesRoute()(call, req)),
    });
    expect(snap(failedLoad).error).toBeDefined();
    expect(memberships(failedLoad)).toEqual([]);
  });

  it('is read again by a rebuild, and the latest read wins', async () => {
    const first = deferred();
    let n = 0;
    const w = await seriesReady({
      membership: () => (++n === 1 ? first.promise : reply(200, { ...MEMBER, series_id: 9 })),
    });
    w.editor.rebuild();
    await flush();
    expect(memberships(w)).toHaveLength(2);
    expect(snap(w).series).toEqual({ ...MEMBER, series_id: 9 });
    first.resolve(reply(200, MEMBER));
    await flush();
    expect(snap(w).series).toEqual({ ...MEMBER, series_id: 9 });
  });
});

describe('recordEditor edit: save on a series member', () => {
  it('holds the save: scope_required, scopePending, nothing sent, beforeSend not run (a member)', async () => {
    const w = await seriesReady();
    const beforeSend = vi.fn(async () => undefined);
    setName(w);
    expect(await w.editor.save(beforeSend)).toEqual({ status: 'scope_required' });
    expect(snap(w).scopePending).toBe(true);
    expect(snap(w).saving).toBe(false);
    expect(beforeSend).not.toHaveBeenCalled();
    expect(seriesWrites(w)).toEqual([]);
    expect(scheduleReads(w)).toEqual([]);
  });

  it('saves normally for a non-member, for a failed read, and without a time slot', async () => {
    const non = await seriesReady({ membership: reply(200, { is_member: false }) });
    expect(await non.editor.save()).toEqual({ status: 'saved', after: 'success' });
    expect(patches(non)).toHaveLength(1);
    expect(snap(non).scopePending).toBe(false);
    const failed = await seriesReady({ membership: reply(500, { message: 'down' }) });
    expect(await failed.editor.save()).toEqual({ status: 'saved', after: 'success' });
    const plain = await ready({ respond: seriesRoute() });
    expect(await plain.editor.save()).toEqual({ status: 'saved', after: 'success' });
    expect(patches(plain)).toHaveLength(1);
  });

  it('validates first: an invalid form is invalid, not scope_required', async () => {
    const w = await seriesReady();
    setName(w, '');
    expect(await w.editor.save()).toEqual({ status: 'invalid' });
    expect(snap(w).scopePending).toBe(false);
  });

  it('transforms first: a value that cannot be sent is transform_error, not scope_required', async () => {
    const w = await seriesReady();
    backend(w).setValue('starts', 'not-a-datetime!!');
    const r: any = await w.editor.save();
    expect(r.status).toBe('transform_error');
    expect(r.column).toBe('starts');
    expect(snap(w).scopePending).toBe(false);
  });

  it('cancelScope drops the held save (ported 1190 is the page-only dialog)', async () => {
    const w = await seriesReady();
    setName(w);
    await w.editor.save();
    w.editor.cancelScope();
    expect(snap(w).scopePending).toBe(false);
    expect(await w.editor.saveWithScope('this_only')).toEqual({ status: 'ignored' });
    expect(seriesWrites(w)).toEqual([]);
  });

  it('saveWithScope without a held save is ignored and sends nothing', async () => {
    const w = await seriesReady();
    for (const scope of ['this_only', 'this_and_future', 'all'] as const) expect(await w.editor.saveWithScope(scope)).toEqual({ status: 'ignored' });
    expect(seriesWrites(w)).toEqual([]);
  });

  it('holds the transformed payload: a later form change does not leak into it', async () => {
    const w = await seriesReady();
    setName(w, 'Held');
    // 17:30 in New York on 2026-01-13 (EST, UTC-5) is 22:30Z.
    backend(w).setValue('starts', '2026-01-13T17:30');
    await w.editor.save();
    setName(w, 'Later');
    backend(w).setValue('starts', '2026-01-13T19:00');
    expect(await w.editor.saveWithScope('this_only')).toEqual({ status: 'saved', after: 'success' });
    const body = (patches(w)[0] as any).body;
    expect(body.name).toBe('Held');
    expect(body.starts).toBe('2026-01-13T22:30:00.000Z');
  });

  it('a second save after the first was held replaces the held payload', async () => {
    const w = await seriesReady();
    setName(w, 'One');
    await w.editor.save();
    setName(w, 'Two');
    await w.editor.save();
    await w.editor.saveWithScope('this_only');
    expect((patches(w)[0] as any).body.name).toBe('Two');
  });
});

describe('recordEditor edit: saveWithScope this_only', () => {
  it('is the plain save with the held payload: one PATCH, no series request (ported 1190 is page-only)', async () => {
    const w = await seriesReady();
    setName(w, 'Only here');
    const result = await scoped(w, 'this_only');
    expect(result).toEqual({ status: 'saved', after: 'success' });
    expect(snap(w).scopePending).toBe(false);
    expect(snap(w).saving).toBe(false);
    expect(patches(w)).toHaveLength(1);
    expect((patches(w)[0] as any).body).toMatchObject({ name: 'Only here', count: 3, active: true, time_slot: LOADED_SLOT });
    expect(scheduleReads(w)).toEqual([]);
    expect(rpcs(w, 'split_series_from_date')).toEqual([]);
    expect(rpcs(w, 'update_series_template')).toEqual([]);
  });

  it('runs beforeSend before the PATCH, and aborts when it rejects', async () => {
    const w = await seriesReady();
    const order: string[] = [];
    await w.editor.save();
    await w.editor.saveWithScope('this_only', async () => {
      order.push(`before:${seriesWrites(w).length}`);
    });
    expect(order).toEqual(['before:0']);
    expect(patches(w)).toHaveLength(1);

    const cause = new Error('token');
    const aborted = await seriesReady();
    await aborted.editor.save();
    expect(await aborted.editor.saveWithScope('this_only', () => Promise.reject(cause))).toEqual({ status: 'aborted', cause });
    expect(seriesWrites(aborted)).toEqual([]);
    expect(snap(aborted).saving).toBe(false);
  });

  it('takes the coordinated path with pending many-to-many changes, as a plain save does', async () => {
    const w = await ready({ props: SERIES_PENDING_PROPS, record: SERIES_PENDING_RECORD, respond: seriesRoute() });
    w.editor.setManyToManyDiff('tags', diff(1));
    await w.editor.save();
    const r: any = await w.editor.saveWithScope('this_only');
    expect(r.status).toBe('steps');
    expect(r.steps.map((s: EditorEditStep) => s.kind)).toEqual(['record', 'many_to_many']);
  });

  it('does not merge the saved values into the load baseline (a plain save never did)', async () => {
    const w = await seriesReady();
    const before = { ...editorInternals.get(w.editor)!.loadedApiValues() };
    setName(w, 'Plain');
    await scoped(w, 'this_only');
    expect(editorInternals.get(w.editor)!.loadedApiValues()).toEqual(before);
  });

  it('saves with the record id as given', async () => {
    const w = await seriesReady({}, { recordId: '42' });
    await scoped(w, 'this_only');
    expect(patches(w, 'issues?id=eq.42')).toHaveLength(1);
  });
});

describe('recordEditor edit: saveWithScope this_and_future', () => {
  it('falls back to the plain save without series_id or without occurrence_date', async () => {
    const noSeries = await seriesReady({ membership: reply(200, { is_member: true, occurrence_date: '2026-01-13' }) });
    await scoped(noSeries, 'this_and_future');
    expect(patches(noSeries)).toHaveLength(1);
    expect(scheduleReads(noSeries)).toEqual([]);
    const noDate = await seriesReady({ membership: reply(200, { is_member: true, series_id: 3 }) });
    expect(await scoped(noDate, 'this_and_future')).toEqual({ status: 'saved', after: 'success' });
    expect(patches(noDate)).toHaveLength(1);
    expect(rpcs(noDate, 'split_series_from_date')).toEqual([]);
  });

  it('runs beforeSend, then reads the series schedule, then splits (saving is true meanwhile)', async () => {
    const gate = deferred();
    const w = await seriesReady({ split: gate.promise });
    const seen: string[] = [];
    await w.editor.save();
    const running = w.editor.saveWithScope('this_and_future', async () => {
      seen.push(`before:${snap(w).saving}:${scheduleReads(w).length}:${rpcs(w, 'split_series_from_date').length}`);
    });
    await flush();
    expect(seen).toEqual(['before:true:0:0']);
    expect(scheduleReads(w)).toHaveLength(1);
    expect(snap(w).saving).toBe(true);
    expect(snap(w).scopePending).toBe(false);
    gate.resolve(reply(200, { success: true }));
    expect(await running).toEqual({ status: 'saved', after: 'success' });
    expect(snap(w).saving).toBe(false);
    expect(sent(w).map(r => `${r.method} ${r.path}`).filter(p => p.includes('time_slot_series') || p.includes('split_series'))).toEqual([
      `GET ${SCHEDULE_URL}`,
      'POST rpc/split_series_from_date',
    ]);
  });

  it('reads the schedule at GET time_slot_series with the id filter before the select, as legacy did', async () => {
    const w = await seriesReady();
    await splitWith(w, { name: 'x' });
    expect(scheduleReads(w).map(r => r.path)).toEqual([SCHEDULE_URL]);
  });

  it('sends the edited start as wall-clock time in the series zone, not UTC (ported 1125)', async () => {
    // 23:30Z on 2026-01-13 is 18:30 EST.
    const w = await seriesReady();
    const { body } = await splitWith(w, { time_slot: NEW_SLOT });
    expect(body.p_series_id).toBe(3);
    expect(body.p_split_date).toBe('2026-01-13');
    expect(body.p_new_dtstart).toBe('2026-01-13T18:30:00');
  });

  it('sends the edited length as the new duration (ported 1135)', async () => {
    const w = await seriesReady();
    const { body } = await splitWith(w, { time_slot: '[2026-01-14T00:00:00.000Z,2026-01-14T02:00:00.000Z)' });
    expect(body.p_new_duration).toBe('7200 seconds');
  });

  it('parses an untouched time slot in PostgREST format (quoted, +00 offset) (ported 1142)', async () => {
    const w = await seriesReady();
    const { body } = await splitWith(w, { time_slot: '["2026-01-13 22:30:00+00","2026-01-13 23:30:00+00")' });
    expect(body.p_new_dtstart).toBe('2026-01-13T17:30:00');
    expect(body.p_new_duration).toBe('3600 seconds');
  });

  it('uses the series timezone even when it differs from the editor timeZone (ported 1149)', async () => {
    // 22:30Z + 5:30 = 04:00 next day in Kolkata; the editor's zone is New York.
    const w = await seriesReady({ schedule: reply(200, [{ ...SCHEDULE, timezone: 'Asia/Kolkata', dtstart: '2026-01-07T04:00:00' }]) });
    const { body } = await splitWith(w, { time_slot: '[2026-01-13T22:30:00.000Z,2026-01-13T23:30:00.000Z)' });
    expect(body.p_new_dtstart).toBe('2026-01-14T04:00:00');
  });

  it('keeps the series zone for dtstart while a DateTimeLocal edit is sent in the editor zone', async () => {
    const w = await seriesReady({ schedule: reply(200, [{ ...SCHEDULE, timezone: 'Asia/Kolkata' }]) });
    const { body } = await splitWith(w, {
      time_slot: '[2026-01-13T22:30:00.000Z,2026-01-13T23:30:00.000Z)',
      // 19:00 on 2026-01-13 in New York (EST) is 00:00Z the next day.
      starts: '2026-01-13T19:00',
    });
    expect(body.p_new_dtstart).toBe('2026-01-14T04:00:00');
    expect(body.p_edited_values.starts).toBe('2026-01-14T00:00:00.000Z');
  });

  it('falls back to UTC, like the expansion worker, when the series has no timezone (ported 1157)', async () => {
    const w = await seriesReady({ schedule: reply(200, [{ ...SCHEDULE, timezone: null }]) });
    const { body } = await splitWith(w, { time_slot: '[2026-01-13T22:30:00.000Z,2026-01-13T23:30:00.000Z)' });
    expect(body.p_new_dtstart).toBe('2026-01-13T22:30:00');
  });

  it('reads the time slot from the series time_slot_property column, and drops that column and time_slot from the template (ported 1165)', async () => {
    const w = await seriesReady({ schedule: reply(200, [{ ...SCHEDULE, time_slot_property: 'booking_window' }]) });
    const { body } = await splitWith(w, {
      time_slot: '[2026-01-13T15:00:00.000Z,2026-01-13T16:00:00.000Z)',
      booking_window: NEW_SLOT,
      name: 'Renamed',
    });
    expect(body.p_new_dtstart).toBe('2026-01-13T18:30:00');
    expect(body.p_new_template).toEqual({ name: 'Renamed' });
    expect(Object.keys(body.p_edited_values).sort()).toEqual(['booking_window', 'name', 'time_slot']);
  });

  it('keeps the original time of day and duration when the time slot is not part of the edit (ported 1176)', async () => {
    const w = await seriesReady();
    backend(w).setEnabled('time_slot', false);
    const { body } = await splitWith(w, { name: 'Renamed' });
    expect(body.p_new_dtstart).toBe('2026-01-13T17:30:00');
    expect(body.p_new_duration).toBeNull();
    expect(body.p_new_template).toEqual({ name: 'Renamed' });
    expect(body.p_edited_values).toEqual({ name: 'Renamed' });
  });

  it('sends no duration when the range is not a positive length', async () => {
    const w = await seriesReady();
    const { body } = await splitWith(w, { time_slot: '[2026-01-13T23:30:00.000Z,2026-01-13T23:30:00.000Z)' });
    expect(body.p_new_duration).toBeNull();
    expect(body.p_new_dtstart).toBe('2026-01-13T18:30:00');
  });

  it('sends only changed fields as the template, never Status columns or the time slot (ported 1201)', async () => {
    const w = await seriesReady();
    const { body } = await splitWith(w, { status_id: 2, name: 'Board (new room)', time_slot: NEW_SLOT });
    // count, active and starts are unchanged one-offs and must not overwrite the series
    expect(body.p_new_template).toEqual({ name: 'Board (new room)' });
  });

  it('saves the occurrence through the split RPC with every change, Status included, and sends no PATCH (ported 1211)', async () => {
    const w = await seriesReady();
    const { result, body } = await splitWith(w, { status_id: 2, name: 'Board (new room)', time_slot: NEW_SLOT });
    expect(body.p_edited_values).toEqual({ status_id: 2, name: 'Board (new room)', time_slot: NEW_SLOT });
    expect(body.p_edited_entity_id).toBe(7);
    expect(patches(w)).toEqual([]);
    expect(result).toEqual({ status: 'saved', after: 'success' });
    expect(snap(w).saving).toBe(false);
  });

  it('sends the split body in legacy key order, with null for a missing duration', async () => {
    const w = await seriesReady();
    const { body } = await splitWith(w, { name: 'Renamed' });
    expect(Object.keys(body)).toEqual([
      'p_series_id',
      'p_split_date',
      'p_new_dtstart',
      'p_new_duration',
      'p_new_template',
      'p_edited_entity_id',
      'p_edited_values',
    ]);
  });

  it('sends p_edited_entity_id as a number whatever the id was given as', async () => {
    const w = await seriesReady({}, { recordId: '42' });
    const { body } = await splitWith(w, { name: 'x' });
    expect(body.p_edited_entity_id).toBe(42);
    expect(memberships(w)[0]!.body).toEqual({ p_entity_table: 'issues', p_entity_id: '42' });
  });

  it('reads the membership again after the split, and publishes it when it lands (ported 1226)', async () => {
    let n = 0;
    const w = await seriesReady({ membership: () => reply(200, ++n === 1 ? MEMBER : { ...MEMBER, series_id: 4 }) });
    await splitWith(w, { name: 'x' });
    expect(memberships(w)).toHaveLength(2);
    await flush();
    expect(snap(w).series).toEqual({ ...MEMBER, series_id: 4 });
  });

  it('publishes { is_member: false } when the re-read fails', async () => {
    let n = 0;
    const w = await seriesReady({ membership: () => (++n === 1 ? reply(200, MEMBER) : reply(500, { message: 'down' })) });
    await splitWith(w, { name: 'x' });
    await flush();
    expect(snap(w).series).toEqual({ is_member: false });
  });

  it('merges the saved payload into the baseline after a split, so a second save diffs against it', async () => {
    const w = await seriesReady();
    const before = { ...editorInternals.get(w.editor)!.loadedApiValues() };
    await splitWith(w, { name: 'First' });
    const merged = editorInternals.get(w.editor)!.loadedApiValues();
    expect(merged).toMatchObject({ ...before, name: 'First' });
    await flush();
    // still a member (the re-read returns MEMBER): change only the count
    backend(w).setValue('count', 9);
    await w.editor.save();
    await w.editor.saveWithScope('this_and_future');
    const second = (rpcs(w, 'split_series_from_date')[1] as any).body;
    expect(second.p_edited_values).toEqual({ count: 9 });
    expect(second.p_new_template).toEqual({ count: 9 });
  });

  describe('failures save nothing and release saving (the page words each)', () => {
    const nothingMore = (w: World) => {
      expect(patches(w)).toEqual([]);
      expect(snap(w).saving).toBe(false);
      expect(snap(w).scopePending).toBe(false);
    };

    it('beforeSend rejects: series_split_failed with the cause message, never the 401 modal, nothing read or sent', async () => {
      const w = await seriesReady();
      const r = await scoped(w, 'this_and_future', () => Promise.reject(new Error('token expired')));
      expect(r).toStrictEqual({ status: 'series_split_failed', detail: 'token expired' });
      expect(scheduleReads(w)).toEqual([]);
      expect(rpcs(w, 'split_series_from_date')).toEqual([]);
      nothingMore(w);
    });

    it('beforeSend rejects with an error body message, an empty message or no cause: detail follows legacy', async () => {
      const body = await seriesReady();
      expect(await scoped(body, 'this_and_future', () => Promise.reject({ error: { message: 'from body' }, message: 'outer' }))).toStrictEqual({
        status: 'series_split_failed',
        detail: 'from body',
      });
      const empty = await seriesReady();
      expect(await scoped(empty, 'this_and_future', () => Promise.reject(new Error('')))).toStrictEqual({ status: 'series_split_failed' });
      const none = await seriesReady();
      expect(await scoped(none, 'this_and_future', () => Promise.reject(undefined))).toStrictEqual({ status: 'series_split_failed' });
    });

    it('the series schedule cannot be read: no detail, no split, nothing saved (ported 1235)', async () => {
      const failing = await seriesReady({ schedule: reply(500, { message: 'down' }) });
      expect(await scoped(failing, 'this_and_future')).toStrictEqual({ status: 'series_split_failed' });
      expect(rpcs(failing, 'split_series_from_date')).toEqual([]);
      nothingMore(failing);
      const noRow = await seriesReady({ schedule: reply(200, []) });
      expect(await scoped(noRow, 'this_and_future')).toStrictEqual({ status: 'series_split_failed' });
      expect(rpcs(noRow, 'split_series_from_date')).toEqual([]);
      nothingMore(noRow);
      const thrown = await seriesReady({
        schedule: () => {
          throw new TransportError('network', 'offline');
        },
      });
      expect(await scoped(thrown, 'this_and_future')).toStrictEqual({ status: 'series_split_failed' });
      nothingMore(thrown);
    });

    it('the split RPC reports failure: detail is its message, nothing saved (ported 1246)', async () => {
      const w = await seriesReady({ split: reply(200, { success: false, message: 'Permission denied' }) });
      expect(await scoped(w, 'this_and_future')).toStrictEqual({ status: 'series_split_failed', detail: 'Permission denied' });
      nothingMore(w);
      expect(memberships(w)).toHaveLength(1);
    });

    it('the split RPC reports failure without a message, or with an empty body: no detail', async () => {
      const bare = await seriesReady({ split: reply(200, { success: false }) });
      expect(await scoped(bare, 'this_and_future')).toStrictEqual({ status: 'series_split_failed' });
      const empty = await seriesReady({ split: reply(200, null) });
      expect(await scoped(empty, 'this_and_future')).toStrictEqual({ status: 'series_split_failed' });
      nothingMore(empty);
    });

    it('the split request is rejected: detail is the PostgREST message (ported 1260)', async () => {
      const w = await seriesReady({ split: reply(400, { message: 'boom' }) });
      expect(await scoped(w, 'this_and_future')).toStrictEqual({ status: 'series_split_failed', detail: 'boom' });
      nothingMore(w);
    });

    it('the split request is rejected without a message, or never answers: detail is "Failed to split series"', async () => {
      const bare = await seriesReady({ split: reply(500, null) });
      expect(await scoped(bare, 'this_and_future')).toStrictEqual({ status: 'series_split_failed', detail: 'Failed to split series' });
      const net = await seriesReady({
        split: () => {
          throw new TransportError('network', 'offline');
        },
      });
      expect(await scoped(net, 'this_and_future')).toStrictEqual({ status: 'series_split_failed', detail: 'Failed to split series' });
      nothingMore(net);
    });
  });

  describe('after a successful split', () => {
    it('follows with the steps and no record step when many-to-many changes are pending, holding saving', async () => {
      const w = await ready({ props: SERIES_PENDING_PROPS, record: SERIES_PENDING_RECORD, respond: seriesRoute() });
      w.editor.setManyToManyDiff('tags', diff(1));
      backend(w).setValue('name', 'Split');
      await w.editor.save();
      const r: any = await w.editor.saveWithScope('this_and_future');
      expect(r.status).toBe('steps');
      expect(r.steps.map((s: EditorEditStep) => s.kind)).toEqual(['many_to_many']);
      expect(snap(w).saving).toBe(true);
      await runAll(r.steps);
      expect(patches(w)).toEqual([]);
      expect(posts(w, 'issue_tags')).toHaveLength(1);
      w.editor.clearPending();
      expect(snap(w).saving).toBe(false);
      expect(editorInternals.get(w.editor)!.loadedApiValues()).toMatchObject({ name: 'Split' });
    });

    it('follows with the galleries step alone for a gallery-only change', async () => {
      const w = await ready({ props: SERIES_PENDING_PROPS, record: SERIES_PENDING_RECORD, respond: seriesRoute() });
      const g = gallery({ pending: true });
      w.editor.registerGallery('photos', g);
      await w.editor.save();
      const r: any = await w.editor.saveWithScope('this_and_future');
      expect(r.steps.map((s: EditorEditStep) => s.kind)).toEqual(['galleries']);
      await runAll(r.steps);
      expect(g.saves).toBe(1);
      expect(patches(w)).toEqual([]);
    });

    it('is saved, with saving released, when nothing else is pending (a registered gallery with none)', async () => {
      const w = await ready({ props: SERIES_PENDING_PROPS, record: SERIES_PENDING_RECORD, respond: seriesRoute() });
      w.editor.registerGallery('photos', gallery({ pending: false }));
      await w.editor.save();
      expect(await w.editor.saveWithScope('this_and_future')).toEqual({ status: 'saved', after: 'success' });
      expect(snap(w).saving).toBe(false);
    });
  });
});

describe('recordEditor edit: saveWithScope all', () => {
  it('falls back to the plain save without series_id', async () => {
    const w = await seriesReady({ membership: reply(200, { is_member: true, occurrence_date: '2026-01-13' }) });
    expect(await scoped(w, 'all')).toEqual({ status: 'saved', after: 'success' });
    expect(patches(w)).toHaveLength(1);
    expect(rpcs(w, 'update_series_template')).toEqual([]);
  });

  it('sends the full transformed payload as the template, not the changed subset', async () => {
    const w = await seriesReady();
    setName(w, 'Everyone');
    const result = await scoped(w, 'all');
    expect(result).toEqual({ status: 'saved', after: 'success' });
    const call = rpcs(w, 'update_series_template');
    expect(call).toHaveLength(1);
    const body = (call[0] as any).body;
    expect(Object.keys(body)).toEqual(['p_series_id', 'p_new_template', 'p_skip_exceptions']);
    expect(body.p_series_id).toBe(3);
    expect(body.p_skip_exceptions).toBe(true);
    expect(body.p_new_template).toMatchObject({ name: 'Everyone', count: 3, active: true, status_id: 1, time_slot: LOADED_SLOT, starts: '2026-01-13T22:30:00.000Z' });
    expect(patches(w)).toEqual([]);
    expect(rpcs(w, 'split_series_from_date')).toEqual([]);
    expect(scheduleReads(w)).toEqual([]);
  });

  it('never sets saving, as legacy never set isSaving', async () => {
    const gate = deferred();
    const w = await seriesReady({ template: gate.promise });
    await w.editor.save();
    const seen: boolean[] = [];
    const running = w.editor.saveWithScope('all', async () => {
      seen.push(snap(w).saving);
    });
    await flush();
    seen.push(snap(w).saving);
    gate.resolve(reply(200, { success: true }));
    await running;
    seen.push(snap(w).saving);
    expect(seen).toEqual([false, false, false]);
  });

  it('runs beforeSend first and resolves aborted when it rejects, sending nothing', async () => {
    const w = await seriesReady();
    const cause = new Error('token');
    expect(await scoped(w, 'all', () => Promise.reject(cause))).toEqual({ status: 'aborted', cause });
    expect(seriesWrites(w)).toEqual([]);
    const ok = await seriesReady();
    const order: number[] = [];
    await scoped(ok, 'all', async () => {
      order.push(rpcs(ok, 'update_series_template').length);
    });
    expect(order).toEqual([0]);
    expect(rpcs(ok, 'update_series_template')).toHaveLength(1);
  });

  it('reports a body with success false as series_update_failed with its message', async () => {
    const w = await seriesReady({ template: reply(200, { success: false, message: 'Series is terminated' }) });
    expect(await scoped(w, 'all')).toStrictEqual({ status: 'series_update_failed', message: 'Series is terminated' });
    expect(snap(w).saving).toBe(false);
    const bare = await seriesReady({ template: reply(200, { success: false }) });
    expect(await scoped(bare, 'all')).toStrictEqual({ status: 'series_update_failed' });
  });

  it('treats a body without success false as saved (legacy: `result.success !== false`)', async () => {
    const w = await seriesReady({ template: reply(200, { updated: 4 }) });
    expect(await scoped(w, 'all')).toEqual({ status: 'saved', after: 'success' });
  });

  it('treats an empty body as saved (legacy threw reading it, and showed nothing)', async () => {
    const w = await seriesReady({ template: reply(200, null) });
    expect(await scoped(w, 'all')).toEqual({ status: 'saved', after: 'success' });
  });

  it('a rejected request is series_update_failed with the PostgREST message, not a System Error failure', async () => {
    const w = await seriesReady({ template: reply(400, { message: 'nope' }) });
    expect(await scoped(w, 'all')).toStrictEqual({ status: 'series_update_failed', message: 'nope' });
    const bare = await seriesReady({ template: reply(500, null) });
    expect(await scoped(bare, 'all')).toStrictEqual({ status: 'series_update_failed', message: 'Failed to update series template' });
    const net = await seriesReady({
      template: () => {
        throw new TransportError('network', 'offline');
      },
    });
    expect(await scoped(net, 'all')).toStrictEqual({ status: 'series_update_failed', message: 'Failed to update series template' });
  });

  it('sends no coordinated many-to-many and leaves the pending diffs where they are', async () => {
    const w = await ready({ props: SERIES_PENDING_PROPS, record: SERIES_PENDING_RECORD, respond: seriesRoute() });
    w.editor.setManyToManyDiff('tags', diff(1));
    expect(await scoped(w, 'all')).toEqual({ status: 'saved', after: 'success' });
    expect(posts(w, 'issue_tags')).toEqual([]);
    expect(snap(w).saving).toBe(false);
    await w.editor.save();
    const again: any = await w.editor.saveWithScope('this_only');
    expect(again.steps.map((s: EditorEditStep) => s.kind)).toEqual(['record', 'many_to_many']);
  });
});

// ---- guided form, autosave, Save and Continue, skip and step jumps (commit 12) -------------------------------------

const GCTX = 'rpc/get_guided_form_context';
const ENSURE = 'rpc/ensure_guided_form_step_record';
const COMPLETE = 'rpc/complete_guided_form_step';

/** Tries each route in order; the first that answers wins. */
const routes =
  (...rs: Route[]): Route =>
  (call, req) => {
    for (const r of rs) {
      const out = r(call, req);
      if (out !== undefined) return out;
    }
    return undefined;
  };

/** A route for one request: `POST rpc/<name>` or the exact path. */
const on =
  (method: string, path: string, answerWith: (call: Call) => TransportResponse | Promise<TransportResponse>): Route =>
  call =>
    call.method === method && call.path === path ? answerWith(call) : undefined;

const gstep = (key: string, table: string, order: number, over: Record<string, unknown> = {}) => ({
  id: order + 1,
  guided_form_key: 'intake',
  step_key: key,
  display_name: key,
  description: null,
  step_table: table,
  parent_fk_column: 'application_id',
  step_order: order,
  can_skip: true,
  track_key: null,
  conditions: [],
  ...over,
});
const G_PARENT = gstep('__parent__', 'applications', 0, { parent_fk_column: null, can_skip: false });
const G_ABOUT = gstep('about', 'issues', 1);
const G_BUDGET = gstep('budget', 'budgets', 2, { can_skip: false });
const G_DOCS = gstep('docs', 'documents', 3);
const gcond = (type: 'skip_if' | 'require_if', field: string, operator = 'is_null', value: string | null = null) => ({
  id: 1,
  condition_type: type,
  field,
  operator,
  value,
});

const gctx = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  definition: {
    guided_form_key: 'intake',
    description: null,
    parent_table: 'applications',
    ownership_column: null,
    lock_on_submit: true,
    on_submit_rpc: null,
    review_intro_text: null,
    precondition_rpc: null,
    auto_submit_on_all_skipped: false,
    is_enabled: true,
    status_options: [],
  },
  steps: [G_PARENT, G_ABOUT, G_BUDGET, G_DOCS],
  progress: [],
  status_options: [],
  parent_status_id: 1,
  parent_status_key: 'draft',
  parent_id: 100,
  record_id: 7,
  is_child_step: true,
  step_key: 'about',
  step_record_ids: {},
  ...over,
});
const SUBMITTED = { parent_status_key: 'submitted' };

type GuidedScenario = Omit<Scenario, 'entity'> & {
  entity?: Partial<SchemaEntityTable>;
  /** The context RPC's answer: a body, `'fail'` (HTTP 500) or `'empty'` (no body). */
  ctx?: Record<string, unknown> | 'fail' | 'empty';
};

/** The guided world: the entity has a `guided_form_key` and no `update` unless the test says so. */
function gmake(sc: GuidedScenario = {}): World {
  const { ctx, respond, entity, ...rest } = sc;
  const ctxRoute: Route = call => {
    if (call.path !== GCTX) return undefined;
    if (ctx === 'fail') return reply(500, { message: 'context down' });
    if (ctx === 'empty') return reply(200, null);
    return reply(200, ctx ?? gctx());
  };
  return make({ ...rest, entity: { guided_form_key: 'intake', update: false, ...entity }, respond: routes(respond ?? (() => undefined), ctxRoute) });
}

/** Lets the load, the context read and the display read settle under fake timers. */
const settle = async () => {
  for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(0);
};
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

async function gready(sc: GuidedScenario = {}): Promise<World> {
  const w = gmake(sc);
  await settle();
  return w;
}

const gf = (w: World) => snap(w).guidedForm!;
const ctxReads = (w: World) => rpcs(w, 'get_guided_form_context');
const type = (w: World, key = 'name', v: unknown = 'Changed') => backend(w).setValue(key, v);

/** A PATCH that stays open until the test releases it, one gate per PATCH. */
function holdPatches() {
  const gates: ReturnType<typeof deferred>[] = [];
  const bodies: Record<string, unknown>[] = [];
  const route: Route = ({ method, path, body }) => {
    if (method === 'PATCH' && path === 'issues?id=eq.7') {
      const d = deferred();
      gates.push(d);
      bodies.push(body);
      return d.promise;
    }
    return undefined;
  };
  return { gates, route, release: (n = 0) => gates[n]!.resolve(reply(200, [{ ...RECORD, ...bodies[n] }])) };
}

/** Autosave is armed: one change is saved after the debounce, and only that change. */
async function expectArmed(w: World, key = 'count', v: unknown = 99) {
  const before = patches(w).length;
  type(w, key, v);
  await tick(1500);
  expect(patches(w)).toHaveLength(before + 1);
  expect(patches(w)[before]!.body).toEqual({ [key]: v });
}

/** Autosave is off: a change is never saved. */
async function expectOff(w: World) {
  const before = patches(w).length;
  type(w, 'count', 12345);
  await tick(10000);
  expect(patches(w)).toHaveLength(before);
}

/** Fake timers for a describe: the editor's debounce, badge and wait timers are `setTimeout`. */
const withFakeTimers = () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
};

describe('recordEditor edit: guided form', () => {
  withFakeTimers();

  describe('context load', () => {
    it('reads get_guided_form_context with the key, the entity name and Number of the loaded row id', async () => {
      const w = await gready({ record: { ...RECORD, id: '7' } });
      expect(ctxReads(w)).toHaveLength(1);
      const [req] = ctxReads(w);
      expect(req!.body).toEqual({ p_guided_form_key: 'intake', p_table_name: 'issues', p_record_id: 7 });
      expect(Object.keys(req!.body as object)).toEqual(['p_guided_form_key', 'p_table_name', 'p_record_id']);
      expect(typeof (req!.body as any).p_record_id).toBe('number');
    });

    it('serves the context and what derives from it', async () => {
      const w = await gready();
      expect(gf(w)).toMatchObject({
        key: 'intake',
        parentId: '100',
        status: 'draft',
        draft: true,
        locked: false,
        editingCompletedStep: false,
        completedStepDisplay: false,
        displayRecord: null,
      });
      expect(gf(w).context).toMatchObject({ parent_id: 100, parent_status_key: 'draft', record_id: 7 });
      expect(typeof gf(w).parentId).toBe('string');
    });

    it('defaults every step conditions to an empty array', async () => {
      const bare = { ...G_ABOUT } as Record<string, unknown>;
      delete bare["conditions"];
      const w = await gready({ ctx: gctx({ steps: [G_PARENT, bare, { ...G_BUDGET, conditions: null }, { ...G_DOCS, conditions: [gcond('skip_if', 'x')] }] }) });
      const steps = gf(w).context!.steps;
      expect(steps.map(s => s.conditions.length)).toEqual([0, 0, 0, 1]);
    });

    it('is served as a guided form with no context before it arrives, and the form is usable', async () => {
      const gate = deferred();
      const w = await gready({ respond: on('POST', GCTX, () => gate.promise) });
      expect(gf(w)).toEqual({
        key: 'intake',
        context: null,
        parentId: null,
        status: null,
        draft: false,
        locked: false,
        skippable: false,
        editingCompletedStep: false,
        completedStepDisplay: false,
        displayRecord: null,
      });
      expect(snap(w).form).not.toBeNull();
      gate.resolve(reply(200, gctx()));
      await settle();
      expect(gf(w).context).not.toBeNull();
    });

    it('leaves the context null and the form usable when the load fails', async () => {
      const w = await gready({ ctx: 'fail' });
      expect(gf(w).context).toBeNull();
      expect(gf(w)).toMatchObject({ parentId: null, status: null, draft: false, locked: false, completedStepDisplay: false });
      expect(snap(w).error).toBeUndefined();
      type(w);
      expect(await w.editor.save()).toEqual({ status: 'saved', after: 'success' });
      expect(patches(w)).toHaveLength(1);
    });

    it('ignores an empty answer', async () => {
      const w = await gready({ ctx: 'empty' });
      expect(gf(w).context).toBeNull();
    });

    it('is not read, and the snapshot has no guided form, for an entity without guided_form_key', async () => {
      const w = make({ respond: routes(on('POST', GCTX, () => reply(200, gctx()))) });
      await settle();
      expect(snap(w).guidedForm).toBeNull();
      expect(ctxReads(w)).toEqual([]);
    });

    it('is not read before the record loads, and not at all when the record is not found', async () => {
      const w = gmake();
      expect(snap(w).guidedForm).toBeNull();
      expect(ctxReads(w)).toEqual([]);
      await settle();
      expect(ctxReads(w)).toHaveLength(1);
      const missing = await gready({ record: null });
      expect(snap(missing).notFound).toBe(true);
      expect(snap(missing).guidedForm).toBeNull();
      expect(ctxReads(missing)).toEqual([]);
    });

    it('is not read for a row without an id', async () => {
      const w = await gready({ record: { name: 'x', count: 1, active: true } });
      expect(ctxReads(w)).toEqual([]);
      expect(snap(w).guidedForm).toBeNull();
    });

    it('derives status, draft, locked and completedStepDisplay (the update bypass, lock_on_submit with submitted)', async () => {
      const draft = await gready();
      expect(gf(draft)).toMatchObject({ status: 'draft', draft: true, locked: false, completedStepDisplay: false });
      const submitted = await gready({ ctx: gctx(SUBMITTED) });
      expect(gf(submitted)).toMatchObject({ status: 'submitted', draft: false, locked: true, completedStepDisplay: true });
      const bypass = await gready({ ctx: gctx(SUBMITTED), entity: { update: true } });
      expect(gf(bypass)).toMatchObject({ draft: false, locked: false, completedStepDisplay: true });
      const unlocked = await gready({ ctx: gctx({ ...SUBMITTED, definition: { ...(gctx()["definition"] as object), lock_on_submit: false } }) });
      expect(gf(unlocked)).toMatchObject({ locked: false, completedStepDisplay: true });
      const other = await gready({ ctx: gctx({ parent_status_key: 'in_review' }) });
      expect(gf(other)).toMatchObject({ status: 'in_review', draft: false, locked: false, completedStepDisplay: true });
      const none = await gready({ ctx: gctx({ parent_status_key: null }) });
      expect(gf(none)).toMatchObject({ status: null, draft: false, locked: false, completedStepDisplay: false });
    });

    it('resets editingCompletedStep when the context loads again', async () => {
      const w = await gready({ ctx: gctx(SUBMITTED) });
      w.editor.enterEditMode();
      expect(gf(w).editingCompletedStep).toBe(true);
      w.editor.rebuild();
      await settle();
      expect(ctxReads(w)).toHaveLength(2);
      expect(gf(w).editingCompletedStep).toBe(false);
    });
  });

  describe('skippable (isCurrentStepSkippable)', () => {
    it('is false without a context (ported 933)', async () => {
      const w = await gready({ ctx: 'fail' });
      expect(gf(w).skippable).toBe(false);
    });

    it('is false for the __parent__ step (ported 937)', async () => {
      const w = await gready({ ctx: gctx({ steps: [gstep('__parent__', 'issues', 0, { parent_fk_column: null, can_skip: true }), G_BUDGET] }) });
      expect(gf(w).skippable).toBe(false);
    });

    it('is true for an optional step of a draft (ported 944)', async () => {
      const w = await gready();
      expect(gf(w).skippable).toBe(true);
    });

    it('is false for a required step, can_skip false (ported 957)', async () => {
      const w = await gready({ ctx: gctx({ steps: [G_PARENT, gstep('about', 'issues', 1, { can_skip: false }), G_BUDGET] }) });
      expect(gf(w).skippable).toBe(false);
    });

    it('is false when a require_if condition makes the optional step required (ported 970)', async () => {
      const w = await gready({ ctx: gctx({ steps: [G_PARENT, gstep('about', 'issues', 1, { conditions: [gcond('require_if', 'x')] }), G_BUDGET] }) });
      expect(gf(w).skippable).toBe(false);
      const unmatched = await gready({ ctx: gctx({ steps: [G_PARENT, gstep('about', 'issues', 1, { conditions: [gcond('require_if', 'x', 'is_not_null')] }), G_BUDGET] }) });
      expect(gf(unmatched).skippable).toBe(true);
    });

    it('is false when a skip_if condition skips the step (ported 984)', async () => {
      const w = await gready({ ctx: gctx({ steps: [G_PARENT, gstep('about', 'issues', 1, { conditions: [gcond('skip_if', 'x')] }), G_BUDGET] }) });
      expect(gf(w).skippable).toBe(false);
    });

    it('is false when the form is not a draft, and when no step has the entity table', async () => {
      const submitted = await gready({ ctx: gctx(SUBMITTED) });
      expect(gf(submitted).skippable).toBe(false);
      const elsewhere = await gready({ ctx: gctx({ steps: [G_PARENT, G_BUDGET] }) });
      expect(gf(elsewhere).skippable).toBe(false);
    });
  });

  describe('displayRecord', () => {
    const props = [...BASE, STATUS];
    const record = { ...RECORD, status_id: 1 };
    const DISPLAY_ROW = { ...record, status_id: { id: 1, display_name: 'Draft', color: '#ccc', status_key: 'draft' } };
    const displayGets = (w: World) => sent(w).filter(r => r.method === 'GET' && r.path.includes('statuses!status_id'));
    const serve = (rows: () => unknown = () => [DISPLAY_ROW]): Route => ({ method, path }) =>
      method === 'GET' && path.includes('statuses!status_id') ? reply(200, rows()) : undefined;

    it('is read with the display select when the context arrives and the form is not a draft', async () => {
      const w = await gready({ props, record, ctx: gctx(SUBMITTED), respond: serve() });
      const fields = snap(w).properties.map(propertyToSelectString).join(',');
      expect(displayGets(w).map(r => r.path)).toEqual([`issues?select=${fields},id&order=id.asc&id=eq.7`]);
      expect(gf(w).displayRecord).toEqual(DISPLAY_ROW);
    });

    it('is not read for a draft', async () => {
      const w = await gready({ props, record, respond: serve() });
      expect(displayGets(w)).toEqual([]);
      expect(gf(w).displayRecord).toBeNull();
    });

    it('is read after the context, so the display request follows the context request', async () => {
      const w = await gready({ props, record, ctx: gctx(SUBMITTED), respond: serve() });
      const order = sent(w).map(r => r.path);
      expect(order.indexOf(GCTX)).toBeGreaterThan(-1);
      expect(order.findIndex(p => p.includes('statuses!status_id'))).toBeGreaterThan(order.indexOf(GCTX));
    });

    it("carries the entity's own columns, as legacy's DataService.withEntityColumns did: no id appended and no order without an id column", async () => {
      const w = await gready({ props: [P.name, P.count, P.active, STATUS], record, ctx: gctx(SUBMITTED), respond: serve() });
      const fields = snap(w).properties.map(propertyToSelectString).join(',');
      expect(displayGets(w).map(r => r.path)).toEqual([`issues?select=${fields}&id=eq.7`]);
    });

    it('stays null when the read fails or returns no row', async () => {
      const failed = await gready({ props, record, ctx: gctx(SUBMITTED), respond: ({ method, path }) => (method === 'GET' && path.includes('statuses!status_id') ? reply(500, { message: 'down' }) : undefined) });
      expect(gf(failed).displayRecord).toBeNull();
      const empty = await gready({ props, record, ctx: gctx(SUBMITTED), respond: serve(() => []) });
      expect(gf(empty).displayRecord).toBeNull();
    });
  });

  describe('field locks', () => {
    const conditioned = (...fields: string[]) => gctx({ ...SUBMITTED, steps: [G_PARENT, gstep('about', 'issues', 1, { conditions: fields.map(f => gcond('skip_if', f)) }), G_BUDGET] });

    it('disables the condition fields when the form is not a draft and the entity lacks update', async () => {
      const w = await gready({ ctx: conditioned('count', 'active') });
      const fields = snap(w).form!.fields;
      expect(fields["count"]!.enabled).toBe(false);
      expect(fields["active"]!.enabled).toBe(false);
      expect(fields["name"]!.enabled).toBe(true);
    });

    it('ignores a condition field that is not a form control', async () => {
      const w = await gready({ ctx: conditioned('parent_only', 'count') });
      expect(snap(w).form!.fields["count"]!.enabled).toBe(false);
      expect(snap(w).form!.fields["name"]!.enabled).toBe(true);
    });

    it('leaves a draft alone', async () => {
      const w = await gready({ ctx: gctx({ steps: [G_PARENT, gstep('about', 'issues', 1, { conditions: [gcond('skip_if', 'count')] })] }) });
      expect(snap(w).form!.fields["count"]!.enabled).toBe(true);
    });

    it('leaves the form alone when the entity grants update', async () => {
      const w = await gready({ ctx: conditioned('count'), entity: { update: true } });
      expect(snap(w).form!.fields["count"]!.enabled).toBe(true);
    });

    it('leaves the form alone when the context has no steps', async () => {
      const w = await gready({ ctx: gctx({ ...SUBMITTED, steps: [] }) });
      expect(snap(w).form!.fields["count"]!.enabled).toBe(true);
    });

    it('locks every step condition field, whatever the step', async () => {
      const w = await gready({ ctx: gctx({ ...SUBMITTED, steps: [G_PARENT, gstep('about', 'issues', 1, { conditions: [gcond('skip_if', 'count')] }), gstep('budget', 'budgets', 2, { conditions: [gcond('require_if', 'active')] })] }) });
      expect(snap(w).form!.fields["count"]!.enabled).toBe(false);
      expect(snap(w).form!.fields["active"]!.enabled).toBe(false);
    });

    it('leaves disabled fields out of a save', async () => {
      const w = await gready({ ctx: gctx({ ...conditioned('count', 'active'), parent_status_key: 'in_review' }) });
      expect(await w.editor.save()).toEqual({ status: 'saved', after: 'success' });
      expect(patches(w)[0]!.body).toEqual({ name: 'Existing' });
    });
  });
});

describe('recordEditor edit: guided form save', () => {
  withFakeTimers();

  const props = [...BASE, STATUS];
  const record = { ...RECORD, status_id: 1 };
  const DISPLAY_ROW = (name: string) => ({ ...record, name, status_id: { id: 1, display_name: 'Draft', color: '#ccc', status_key: 'draft' } });
  const displayGets = (w: World) => sent(w).filter(r => r.method === 'GET' && r.path.includes('statuses!status_id'));

  it('a draft skips validation, sends the PATCH and leaves through the parent detail page', async () => {
    const w = await gready({ record: { ...RECORD, name: null } });
    const result = await w.editor.save();
    expect(result).toEqual({ status: 'saved', after: 'guided_parent', navigation: { kind: 'view', table: 'applications', id: '100' } });
    expect(patches(w)).toHaveLength(1);
    expect(patches(w)[0]!.body).toEqual({ name: null, count: 3, active: true });
    expect(snap(w).saving).toBe(false);
  });

  it('a draft is never held for a series scope', async () => {
    const w = await gready({ props: SERIES_PROPS, record: SERIES_RECORD, respond: seriesRoute() });
    expect(snap(w).series).toEqual(MEMBER);
    const result = await w.editor.save();
    expect(result).toMatchObject({ status: 'saved', after: 'guided_parent' });
    expect(snap(w).scopePending).toBe(false);
    expect(patches(w)).toHaveLength(1);
    expect(rpcs(w, 'split_series_from_date')).toEqual([]);
    expect(rpcs(w, 'update_series_template')).toEqual([]);
  });

  it('a draft still resolves transform_error, sending nothing', async () => {
    const w = await gready({ props: [...BASE, prop('at', T.DateTime)], record: { ...RECORD, at: '2026-10-21T10:30:00' } });
    type(w, 'at', '2025-13-45T10:30');
    const result: any = await w.editor.save();
    expect(result.status).toBe('transform_error');
    expect(result.column).toBe('at');
    expect(patches(w)).toEqual([]);
  });

  it('a draft with pending many-to-many changes still hands back the steps', async () => {
    const w = await gready({ props: WITH_PENDING, record: PENDING_ROW });
    w.editor.setManyToManyDiff('tags', diff(1));
    const result = await w.editor.save();
    expect(result.status).toBe('steps');
  });

  it('is the normal save without a context: validated, and success afterwards', async () => {
    const invalid = await gready({ ctx: 'fail', record: { ...RECORD, name: null } });
    expect(await invalid.editor.save()).toEqual({ status: 'invalid' });
    expect(patches(invalid)).toEqual([]);
    const valid = await gready({ ctx: 'fail' });
    expect(await valid.editor.save()).toEqual({ status: 'saved', after: 'success' });
  });

  it('a submitted step that is not being edited saves as success', async () => {
    const w = await gready({ ctx: gctx(SUBMITTED), entity: { update: true } });
    expect(await w.editor.save()).toEqual({ status: 'saved', after: 'success' });
  });

  it('a submitted step is validated like any other non-draft save', async () => {
    const w = await gready({ ctx: gctx(SUBMITTED), entity: { update: true }, record: { ...RECORD, name: null } });
    expect(await w.editor.save()).toEqual({ status: 'invalid' });
  });

  it('a completed-step edit leaves edit mode and reads the display record again', async () => {
    let reads = 0;
    const respond: Route = ({ method, path }) => {
      if (method === 'GET' && path.includes('statuses!status_id')) return reply(200, [DISPLAY_ROW(++reads === 1 ? 'Existing' : 'Changed')]);
      return undefined;
    };
    const w = await gready({ props, record, ctx: gctx(SUBMITTED), entity: { update: true }, respond });
    expect((gf(w).displayRecord as any).name).toBe('Existing');
    w.editor.enterEditMode();
    expect(gf(w).editingCompletedStep).toBe(true);
    expect(gf(w).completedStepDisplay).toBe(false);
    type(w, 'name', 'Changed');
    const result = await w.editor.save();
    expect(result).toEqual({ status: 'saved', after: 'completed_step' });
    expect(gf(w).editingCompletedStep).toBe(false);
    expect(gf(w).completedStepDisplay).toBe(true);
    expect(snap(w).saving).toBe(false);
    expect(displayGets(w)).toHaveLength(2);
    expect(displayGets(w)[1]!.path).toBe(displayGets(w)[0]!.path);
    expect((gf(w).displayRecord as any).name).toBe('Changed');
    const order = sent(w).filter(r => r.method === 'PATCH' || r.path.includes('statuses!status_id')).map(r => r.method);
    expect(order).toEqual(['GET', 'PATCH', 'GET']);
  });

  it('a failed completed-step edit stays in edit mode', async () => {
    const w = await gready({
      props,
      record,
      ctx: gctx(SUBMITTED),
      entity: { update: true },
      respond: ({ method, path }) => (method === 'GET' && path.includes('statuses!status_id') ? reply(200, [DISPLAY_ROW('Existing')]) : method === 'PATCH' ? reply(409, { message: 'dup' }) : undefined),
    });
    w.editor.enterEditMode();
    const result: any = await w.editor.save();
    expect(result.status).toBe('failed');
    expect(gf(w).editingCompletedStep).toBe(true);
    expect(displayGets(w)).toHaveLength(1);
  });

  it('a failed re-read leaves the previous display record', async () => {
    let reads = 0;
    const w = await gready({
      props,
      record,
      ctx: gctx(SUBMITTED),
      entity: { update: true },
      respond: ({ method, path }) => (method === 'GET' && path.includes('statuses!status_id') ? (++reads === 1 ? reply(200, [DISPLAY_ROW('Existing')]) : reply(500, { message: 'down' })) : undefined),
    });
    w.editor.enterEditMode();
    expect(await w.editor.save()).toEqual({ status: 'saved', after: 'completed_step' });
    expect((gf(w).displayRecord as any).name).toBe('Existing');
    expect(gf(w).editingCompletedStep).toBe(false);
  });
});

describe('recordEditor edit: autosave', () => {
  withFakeTimers();

  it('saves the changed field once the debounce has passed, and only after it', async () => {
    const w = await gready();
    type(w);
    await tick(1499);
    expect(patches(w)).toEqual([]);
    await tick(1);
    expect(patches(w)).toHaveLength(1);
    expect(patches(w)[0]!.body).toEqual({ name: 'Changed' });
    expect(patches(w)[0]!.headers['Prefer']).toBe('return=representation');
  });

  it('is not armed without a context, for a form that is not a draft, or for an entity without a guided form', async () => {
    await expectOff(await gready({ ctx: 'fail' }));
    await expectOff(await gready({ ctx: gctx(SUBMITTED), entity: { update: true } }));
    const plain = make();
    await settle();
    expect(snap(plain).guidedForm).toBeNull();
  });

  it('uses autoSaveDebounceMs and autoSaveSavedMs', async () => {
    const w = gmake({ options: { autoSaveDebounceMs: 100, autoSaveSavedMs: 50 } });
    await settle();
    type(w);
    await tick(99);
    expect(patches(w)).toEqual([]);
    await tick(1);
    expect(patches(w)).toHaveLength(1);
    await settle();
    expect(snap(w).autoSave).toBe('saved');
    await tick(49);
    expect(snap(w).autoSave).toBe('saved');
    await tick(1);
    expect(snap(w).autoSave).toBe('idle');
  });

  it('collapses a burst into one save of the last values, restarting the quiet time', async () => {
    const w = await gready();
    type(w, 'name', 'A');
    await tick(1000);
    type(w, 'name', 'B');
    await tick(1000);
    expect(patches(w)).toEqual([]);
    await tick(500);
    expect(patches(w)).toHaveLength(1);
    expect(patches(w)[0]!.body).toEqual({ name: 'B' });
  });

  it('arms one debounce for a keystroke that notifies twice', async () => {
    const w = await gready({ backend: { notifyTwice: true } });
    type(w);
    await tick(1500);
    expect(patches(w)).toHaveLength(1);
  });

  it('does not save when the values are back at the baseline', async () => {
    const w = await gready();
    type(w, 'name', 'Other');
    await tick(100);
    type(w, 'name', 'Existing');
    await tick(5000);
    expect(patches(w)).toEqual([]);
    expect(snap(w).autoSave).toBe('idle');
  });

  it('takes the values at arming as the baseline, so an earlier change is not sent', async () => {
    const gate = deferred();
    const w = await gready({ respond: on('POST', GCTX, () => gate.promise) });
    type(w, 'name', 'Early');
    gate.resolve(reply(200, gctx()));
    await settle();
    type(w, 'count', 9);
    await tick(1500);
    expect(patches(w).map(r => r.body)).toEqual([{ count: 9 }]);
  });

  it('sends only the changed fields, and the baseline advances after a success', async () => {
    const w = await gready();
    type(w, 'name', 'A');
    type(w, 'count', 9);
    await tick(1500);
    expect(patches(w)[0]!.body).toEqual({ name: 'A', count: 9 });
    expect(Object.keys(patches(w)[0]!.body as object)).toEqual(['name', 'count']);
    await settle();
    type(w, 'active', false);
    await tick(1500);
    expect(patches(w)[1]!.body).toEqual({ active: false });
  });

  it('never sends status_id, and sends nothing when it is the only change', async () => {
    const w = await gready({ props: [...BASE, STATUS], record: { ...RECORD, status_id: 1 } });
    type(w, 'status_id', 2);
    type(w, 'name', 'A');
    await tick(1500);
    expect(patches(w)).toHaveLength(1);
    expect(patches(w)[0]!.body).toEqual({ name: 'A' });
    await settle();
    type(w, 'status_id', 3);
    await tick(1500);
    expect(patches(w)).toHaveLength(1);
    expect(snap(w).autoSave).toBe('saved');
    await tick(2000);
    type(w, 'status_id', 4);
    await tick(1500);
    expect(patches(w)).toHaveLength(1);
    expect(snap(w).autoSave).toBe('idle');
  });

  it('sends nothing for a value that cannot be transformed', async () => {
    const w = await gready({ props: [...BASE, prop('at', T.DateTime)], record: { ...RECORD, at: '2026-10-21T10:30:00' } });
    type(w, 'at', '2025-13-45T10:30');
    await tick(1500);
    expect(patches(w)).toEqual([]);
    expect(snap(w).autoSave).toBe('idle');
  });

  it('shows saving while the PATCH is in flight, saved after it, and idle after autoSaveSavedMs', async () => {
    const hold = holdPatches();
    const w = await gready({ respond: hold.route });
    expect(snap(w).autoSave).toBe('idle');
    type(w);
    await tick(1500);
    expect(snap(w).autoSave).toBe('saving');
    hold.release();
    await settle();
    expect(snap(w).autoSave).toBe('saved');
    await tick(1999);
    expect(snap(w).autoSave).toBe('saved');
    await tick(1);
    expect(snap(w).autoSave).toBe('idle');
  });

  it('returns to idle after a rejected PATCH and keeps the old baseline', async () => {
    let n = 0;
    const w = await gready({ respond: on('PATCH', 'issues?id=eq.7', call => (++n === 1 ? reply(500, { message: 'down' }) : reply(200, [{ ...RECORD, ...call.body }]))) });
    type(w, 'name', 'A');
    await tick(1500);
    await settle();
    expect(snap(w).autoSave).toBe('idle');
    type(w, 'count', 9);
    await tick(1500);
    expect(patches(w)).toHaveLength(2);
    expect(patches(w)[1]!.body).toEqual({ name: 'A', count: 9 });
    await settle();
    expect(snap(w).autoSave).toBe('saved');
  });

  it('returns to idle after a request that throws', async () => {
    const w = await gready({ respond: on('PATCH', 'issues?id=eq.7', () => Promise.reject(new TransportError('network', 'offline'))) });
    type(w);
    await tick(1500);
    await settle();
    expect(patches(w)).toHaveLength(1);
    expect(snap(w).autoSave).toBe('idle');
  });

  it('does not send the same values twice in a row after a failure (distinctUntilChanged)', async () => {
    const w = await gready({ respond: on('PATCH', 'issues?id=eq.7', () => reply(500, { message: 'down' })) });
    type(w, 'name', 'A');
    await tick(1500);
    expect(patches(w)).toHaveLength(1);
    type(w, 'name', 'B');
    await tick(100);
    type(w, 'name', 'A');
    await tick(5000);
    expect(patches(w)).toHaveLength(1);
  });

  it('does not arm a debounce for a notification that leaves the values alone', async () => {
    const w = await gready();
    backend(w).markTouched('name');
    await tick(5000);
    expect(patches(w)).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  describe('cancelled for good by the first save command that reaches cancelAutoSave', () => {
    it('a draft save', async () => {
      const w = await gready();
      await expectArmed(w, 'count', 5);
      expect(await w.editor.save()).toMatchObject({ status: 'saved', after: 'guided_parent' });
      await expectOff(w);
    });

    it('a draft save whose values cannot be transformed (it cancels before it transforms)', async () => {
      const w = await gready({ props: [...BASE, prop('at', T.DateTime)], record: { ...RECORD, at: '2026-10-21T10:30:00' } });
      await expectArmed(w, 'count', 5);
      type(w, 'at', '2025-13-45T10:30');
      expect((await w.editor.save()).status).toBe('transform_error');
      await expectOff(w);
    });

    it('a rejected draft save', async () => {
      const w = await gready({ respond: on('PATCH', 'issues?id=eq.7', () => reply(409, { message: 'dup' })) });
      type(w, 'count', 5);
      const sentBefore = patches(w).length;
      expect((await w.editor.save()).status).toBe('failed');
      expect(patches(w)).toHaveLength(sentBefore + 1);
      await expectOff(w);
    });

    it('saveAndContinue, after validation', async () => {
      const w = await gready();
      await expectArmed(w, 'count', 5);
      expect((await w.editor.saveAndContinue()).status).toBe('continued');
      await expectOff(w);
    });

    it('a failed saveAndContinue', async () => {
      const w = await gready({ respond: on('PATCH', 'issues?id=eq.7', () => reply(409, { message: 'dup' })) });
      expect((await w.editor.saveAndContinue()).status).toBe('failed');
      await expectOff(w);
    });

    it('skipStep, also when it finds no current step', async () => {
      const w = await gready({ respond: on('POST', ENSURE, () => reply(200, { record_id: 301 })) });
      await expectArmed(w, 'count', 5);
      expect(await w.editor.skipStep()).toEqual({ kind: 'edit', table: 'budgets', id: 301 });
      await expectOff(w);
      const lost = await gready({ ctx: gctx({ steps: [G_PARENT, G_BUDGET] }) });
      await expectArmed(lost, 'count', 5);
      expect(await lost.editor.skipStep()).toBeNull();
      await expectOff(lost);
    });

    it('goToStep to __parent__, __review__ and another known step, with or without a parent_fk_column', async () => {
      const ensure = on('POST', ENSURE, () => reply(200, { record_id: 301 }));
      for (const step of ['__parent__', '__review__', 'budget']) {
        const w = await gready({ respond: ensure });
        await expectArmed(w, 'count', 5);
        expect((await w.editor.goToStep(step)).status).toBe('navigate');
        await expectOff(w);
      }
      const bare = await gready({ ctx: gctx({ steps: [G_PARENT, G_ABOUT, gstep('budget', 'budgets', 2, { parent_fk_column: null })] }) });
      await expectArmed(bare, 'count', 5);
      expect(await bare.editor.goToStep('budget')).toEqual({ status: 'none' });
      await expectOff(bare);
    });

    it('goToStep to a step whose ensure fails or returns no record', async () => {
      const failed = await gready({ respond: on('POST', ENSURE, () => reply(500, { message: 'no' })) });
      await expectArmed(failed, 'count', 5);
      expect((await failed.editor.goToStep('budget')).status).toBe('failed');
      await expectOff(failed);
    });

    it('not an invalid saveAndContinue', async () => {
      const w = await gready({ record: { ...RECORD, name: null } });
      expect(await w.editor.saveAndContinue()).toEqual({ status: 'invalid' });
      await expectArmed(w, 'count', 5);
    });

    it('not a goToStep to an unknown step or to the current step', async () => {
      const w = await gready();
      expect(await w.editor.goToStep('nope')).toEqual({ status: 'none' });
      expect(await w.editor.goToStep('about')).toEqual({ status: 'none' });
      await expectArmed(w, 'count', 5);
    });

    it('not a goToStep without a context', async () => {
      const w = await gready({ ctx: 'fail' });
      expect(await w.editor.goToStep('__parent__')).toEqual({ status: 'ignored' });
    });

    it('is armed again by the next context load', async () => {
      const w = await gready();
      expect(await w.editor.goToStep('__parent__')).toMatchObject({ status: 'navigate' });
      await expectOff(w);
      w.editor.rebuild();
      await settle();
      await expectArmed(w, 'count', 5);
    });

    it('leaves the badge where it was: saved stays saved', async () => {
      const w = await gready();
      type(w, 'count', 5);
      await tick(1500);
      await settle();
      expect(snap(w).autoSave).toBe('saved');
      await w.editor.goToStep('__parent__');
      await tick(10000);
      expect(snap(w).autoSave).toBe('saved');
    });

    it('lets an in-flight autosave finish, which still advances the badge', async () => {
      const hold = holdPatches();
      const w = await gready({ respond: hold.route });
      type(w, 'count', 5);
      await tick(1500);
      expect(snap(w).autoSave).toBe('saving');
      await w.editor.goToStep('__review__');
      expect(snap(w).autoSave).toBe('saving');
      hold.release();
      await settle();
      expect(snap(w).autoSave).toBe('saved');
      await tick(2000);
      expect(snap(w).autoSave).toBe('idle');
    });
  });

  describe('timers', () => {
    it('dispose clears the debounce', async () => {
      const w = await gready();
      type(w);
      expect(vi.getTimerCount()).toBe(1);
      w.editor.dispose();
      expect(vi.getTimerCount()).toBe(0);
      await tick(5000);
      expect(patches(w)).toEqual([]);
    });

    it('dispose clears the saved timer', async () => {
      const w = await gready();
      type(w);
      await tick(1500);
      await settle();
      expect(snap(w).autoSave).toBe('saved');
      expect(vi.getTimerCount()).toBe(1);
      w.editor.dispose();
      expect(vi.getTimerCount()).toBe(0);
      await tick(5000);
      expect(snap(w).autoSave).toBe('saved');
    });

    it('a rebuild that drops the form clears its timers and arms the new form', async () => {
      const w = await gready();
      const old = backend(w);
      type(w);
      w.editor.rebuild();
      await settle();
      expect(backend(w)).not.toBe(old);
      await tick(5000);
      expect(patches(w)).toEqual([]);
      expect(old.listeners.size).toBe(0);
      await expectArmed(w, 'count', 5);
    });

    it('a rebuild during the saved badge clears its timer', async () => {
      const w = await gready();
      type(w);
      await tick(1500);
      await settle();
      w.editor.rebuild();
      await settle();
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});

/** Holds only the first PATCH (an autosave in flight); later PATCHes are answered at once. */
function holdFirstPatch() {
  const d = deferred();
  let n = 0;
  let sentBody: Record<string, unknown> = {};
  const route: Route = ({ method, path, body }) => {
    if (method === 'PATCH' && path === 'issues?id=eq.7' && n++ === 0) {
      sentBody = body;
      return d.promise;
    }
    return undefined;
  };
  return { route, release: () => d.resolve(reply(200, [{ ...RECORD, ...sentBody }])) };
}

const completeReply = (over: Record<string, unknown> = {}) => on('POST', COMPLETE, () => reply(200, over));
const order = (w: World) => sent(w).filter(r => r.method !== 'GET' && r.path !== GCTX).map(r => `${r.method} ${r.path}`);

describe('recordEditor edit: saveAndContinue', () => {
  withFakeTimers();

  it('takes no beforeSend', () => {
    const w = make();
    expect(w.editor.saveAndContinue.length).toBe(0);
  });

  it('is ignored without a form', async () => {
    const w = make({ record: null });
    await settle();
    expect(await w.editor.saveAndContinue()).toEqual({ status: 'ignored' });
    expect(writes(w)).toEqual([]);
  });

  it('is ignored without a guided context, after validating and transforming, sending nothing', async () => {
    const w = await gready({ ctx: 'fail' });
    expect(await w.editor.saveAndContinue()).toEqual({ status: 'ignored' });
    expect(writes(w).filter(r => r.path !== GCTX)).toEqual([]);
    expect(snap(w).savingAndContinuing).toBe(false);
  });

  it('is ignored while a save is in flight, and while another continue is in flight', async () => {
    const hold = holdPatches();
    const w = await gready({ respond: hold.route });
    const first = w.editor.save();
    await settle();
    expect(await w.editor.saveAndContinue()).toEqual({ status: 'ignored' });
    hold.release();
    await first;
    const w2 = await gready({ respond: hold.route });
    const c1 = w2.editor.saveAndContinue();
    await settle();
    expect(snap(w2).savingAndContinuing).toBe(true);
    expect(await w2.editor.saveAndContinue()).toEqual({ status: 'ignored' });
    expect(await w2.editor.save()).toEqual({ status: 'ignored' });
    hold.release(1);
    await c1;
  });

  it('is invalid for an invalid form, marks every field touched and leaves autosave armed', async () => {
    const w = await gready({ record: { ...RECORD, name: null } });
    expect(await w.editor.saveAndContinue()).toEqual({ status: 'invalid' });
    expect(snap(w).form!.fields['name']!.touched).toBe(true);
    expect(snap(w).form!.fields['count']!.touched).toBe(true);
    expect(writes(w).filter(r => r.path !== GCTX)).toEqual([]);
    await expectArmed(w, 'count', 5);
  });

  it('PATCHes the record, then completes the step with the parent id as a number', async () => {
    const w = await gready({ respond: completeReply({}) });
    const result = await w.editor.saveAndContinue();
    expect(result).toEqual({ status: 'continued', guidedFormKey: 'intake', stepKey: 'about', navigation: { kind: 'none' } });
    expect(order(w)).toEqual(['PATCH issues?id=eq.7', `POST ${COMPLETE}`]);
    expect(patches(w)[0]!.body).toEqual({ name: 'Existing', count: 3, active: true });
    const [req] = rpcs(w, 'complete_guided_form_step');
    expect(req!.body).toEqual({ p_guided_form_key: 'intake', p_parent_id: 100, p_step_key: 'about' });
    expect(Object.keys(req!.body as object)).toEqual(['p_guided_form_key', 'p_parent_id', 'p_step_key']);
    expect(typeof (req!.body as any).p_parent_id).toBe('number');
    expect(snap(w).savingAndContinuing).toBe(false);
  });

  it('uses __parent__ as the step key when no step has the entity table', async () => {
    const w = await gready({ ctx: gctx({ steps: [G_PARENT, G_BUDGET] }), respond: completeReply({}) });
    const result: any = await w.editor.saveAndContinue();
    expect(result.stepKey).toBe('__parent__');
    expect((rpcs(w, 'complete_guided_form_step')[0]!.body as any).p_step_key).toBe('__parent__');
  });

  it('treats a null completion answer as empty', async () => {
    const w = await gready({ respond: on('POST', COMPLETE, () => reply(200, null)) });
    expect(await w.editor.saveAndContinue()).toMatchObject({ status: 'continued', navigation: { kind: 'none' } });
  });

  it('is failed with the same error save gives, and sends no completion', async () => {
    const respond = on('PATCH', 'issues?id=eq.7', () => reply(409, { code: '23505', message: 'dup', details: 'x', hint: 'h' }));
    const w = await gready({ respond });
    const viaSave = await (await gready({ respond })).editor.save();
    const result = await w.editor.saveAndContinue();
    expect(result.status).toBe('failed');
    expect((result as any).error).toEqual((viaSave as any).error);
    expect(rpcs(w, 'complete_guided_form_step')).toEqual([]);
    expect(snap(w).savingAndContinuing).toBe(false);
  });

  it('is transform_error for a value that cannot be sent, clearing savingAndContinuing', async () => {
    const w = await gready({ props: [...BASE, prop('at', T.DateTime)], record: { ...RECORD, at: '2026-10-21T10:30:00' } });
    type(w, 'at', '2025-13-45T10:30');
    const result: any = await w.editor.saveAndContinue();
    expect(result.status).toBe('transform_error');
    expect(result.column).toBe('at');
    expect(snap(w).savingAndContinuing).toBe(false);
    expect(patches(w)).toEqual([]);
  });

  describe('pending many-to-many changes', () => {
    const base = { props: WITH_PENDING, record: PENDING_ROW };

    it('are sent after the PATCH and before the completion, removals before additions, and the string record id', async () => {
      const w = await gready({ ...base, recordId: 7, respond: completeReply({}) });
      w.editor.setManyToManyDiff('tags', { toAdd: [1], toRemove: [4] });
      w.editor.setRichManyToManyDiff('labels', richDiff({ toAdd: [{ id: 2, extraData: { note: 'x' } }], toRemove: [8], toUpdate: [{ id: 3, extraData: { note: 'y' } }] }));
      expect(await w.editor.saveAndContinue()).toMatchObject({ status: 'continued' });
      const o = order(w);
      expect(o[0]).toBe('PATCH issues?id=eq.7');
      expect(o[o.length - 1]).toBe(`POST ${COMPLETE}`);
      expect(o).toContain('DELETE issue_tags?issue_id=eq.7&tags_id=eq.4');
      expect(o.indexOf('DELETE issue_tags?issue_id=eq.7&tags_id=eq.4')).toBeLessThan(o.indexOf('POST issue_tags'));
      expect(posts(w, 'issue_tags')[0]!.body).toEqual({ issue_id: 7, tags_id: 1 });
      expect(o).toContain('DELETE issue_labels?issue_id=eq.7&labels_id=eq.8');
      expect(o).toContain('PATCH issue_labels?issue_id=eq.7&labels_id=eq.3');
      expect(posts(w, 'issue_labels')[0]!.body).toEqual({ issue_id: 7, labels_id: 2, note: 'x' });
      expect(o).toHaveLength(7);
    });

    it('use the record id as the route gave it', async () => {
      const w = await gready({ ...base, recordId: 'u-1', respond: completeReply({}) });
      w.editor.setManyToManyDiff('tags', { toAdd: [1], toRemove: [4] });
      expect(await w.editor.saveAndContinue()).toMatchObject({ status: 'continued' });
      expect(sent(w).filter(r => r.path.startsWith('issue_tags')).map(r => r.path)).toEqual(['issue_tags?issue_id=eq.u-1&tags_id=eq.4', 'issue_tags']);
      expect(posts(w, 'issue_tags')[0]!.body).toEqual({ issue_id: 'u-1', tags_id: 1 });
    });

    it('run in parallel', async () => {
      const gates = [deferred(), deferred()];
      let n = 0;
      const w = await gready({ ...base, respond: routes(({ path }) => (path.startsWith('issue_tags') ? gates[n++]!.promise : undefined), completeReply({})) });
      w.editor.setManyToManyDiff('tags', { toAdd: [1], toRemove: [4] });
      const run = w.editor.saveAndContinue();
      await settle();
      expect(sent(w).filter(r => r.path.startsWith('issue_tags'))).toHaveLength(2);
      expect(rpcs(w, 'complete_guided_form_step')).toEqual([]);
      gates.forEach(g => g.resolve(reply(204, null)));
      expect(await run).toMatchObject({ status: 'continued' });
    });

    it('make it related_failed with counts and no completion when some fail', async () => {
      const w = await gready({
        ...base,
        respond: ({ method, path, body }) => (method === 'POST' && path === 'issue_tags' && body.tags_id === 2 ? reply(409, { message: 'dup' }) : undefined),
      });
      w.editor.setManyToManyDiff('tags', { toAdd: [1, 2], toRemove: [] });
      expect(await w.editor.saveAndContinue()).toEqual({ status: 'related_failed', message: '1 of 2 related item changes failed', failedCount: 1, totalCount: 2 });
      expect(rpcs(w, 'complete_guided_form_step')).toEqual([]);
      expect(snap(w).savingAndContinuing).toBe(false);
    });
  });

  describe('step_failed', () => {
    it('carries the message, code and hint of a failing completion', async () => {
      const w = await gready({ respond: on('POST', COMPLETE, () => reply(400, { code: 'P0001', message: 'Step incomplete', hint: 'Fill it in' })) });
      expect(await w.editor.saveAndContinue()).toEqual({
        status: 'step_failed',
        guidedFormKey: 'intake',
        stepKey: 'about',
        error: { message: 'Step incomplete', code: 'P0001', hint: 'Fill it in' },
      });
      expect(snap(w).savingAndContinuing).toBe(false);
      expect(patches(w)).toHaveLength(1);
    });

    it('carries the Error message of a request that throws', async () => {
      const w = await gready({ respond: on('POST', COMPLETE, () => Promise.reject(new TransportError('network', 'offline'))) });
      const result: any = await w.editor.saveAndContinue();
      expect(result.status).toBe('step_failed');
      expect(result.error.message).toBe('offline');
      expect(result.error.code).toBeUndefined();
      expect(result.error.hint).toBeUndefined();
    });
  });

  describe('navigation', () => {
    it('goes to the next step record', async () => {
      const w = await gready({ respond: completeReply({ next_record_id: 301, next_step_table: 'budgets' }) });
      expect(await w.editor.saveAndContinue()).toMatchObject({ navigation: { kind: 'edit', table: 'budgets', id: 301 } });
    });

    it('goes to the parent when all data steps are complete', async () => {
      const w = await gready({ respond: completeReply({ all_data_steps_complete: true }) });
      expect(await w.editor.saveAndContinue()).toMatchObject({ navigation: { kind: 'view', table: 'applications', id: '100' } });
    });

    it('goes to navigate_to when auto-submitted, else to the parent', async () => {
      const a = await gready({ respond: completeReply({ auto_submitted: true, navigate_to: '/thanks' }) });
      expect(await a.editor.saveAndContinue()).toMatchObject({ navigation: { kind: 'url', url: '/thanks' } });
      const b = await gready({ respond: completeReply({ auto_submitted: true }) });
      expect(await b.editor.saveAndContinue()).toMatchObject({ navigation: { kind: 'view', table: 'applications', id: '100' } });
    });

    it('goes nowhere when nothing says where', async () => {
      const w = await gready({ respond: completeReply({ next_record_id: 301 }) });
      expect(await w.editor.saveAndContinue()).toMatchObject({ navigation: { kind: 'none' } });
    });
  });

  describe('waiting for an autosave in flight', () => {
    it('re-checks every 200 ms and goes on once the autosave is done', async () => {
      const hold = holdFirstPatch();
      const w = await gready({ respond: routes(hold.route, completeReply({})) });
      type(w, 'count', 5);
      await tick(1500);
      expect(patches(w)).toHaveLength(1);
      const run = w.editor.saveAndContinue();
      await tick(199);
      expect(patches(w)).toHaveLength(1);
      expect(snap(w).savingAndContinuing).toBe(false);
      hold.release();
      await tick(1);
      await settle();
      expect(patches(w)).toHaveLength(2);
      expect(await run).toMatchObject({ status: 'continued' });
    });

    it('goes on regardless after 15 waits (3000 ms)', async () => {
      const hold = holdFirstPatch();
      const w = await gready({ respond: routes(hold.route, completeReply({})) });
      type(w, 'count', 5);
      await tick(1500);
      const run = w.editor.saveAndContinue();
      await tick(2999);
      expect(patches(w)).toHaveLength(1);
      await tick(1);
      await settle();
      expect(patches(w)).toHaveLength(2);
      expect(await run).toMatchObject({ status: 'continued' });
      hold.release();
    });

    it('validates again at every check', async () => {
      const hold = holdFirstPatch();
      const w = await gready({ respond: routes(hold.route, completeReply({})) });
      type(w, 'count', 5);
      await tick(1500);
      const run = w.editor.saveAndContinue();
      await tick(100);
      type(w, 'name', null);
      hold.release();
      await tick(100);
      await settle();
      expect(await run).toEqual({ status: 'invalid' });
      expect(patches(w)).toHaveLength(1);
    });

    it('is ignored when the editor is disposed during the wait', async () => {
      const hold = holdFirstPatch();
      const w = await gready({ respond: routes(hold.route, completeReply({})) });
      type(w, 'count', 5);
      await tick(1500);
      const run = w.editor.saveAndContinue();
      await tick(100);
      w.editor.dispose();
      await tick(5000);
      expect(await run).toEqual({ status: 'ignored' });
      expect(patches(w)).toHaveLength(1);
      hold.release();
    });

    it('sets savingAndContinuing after the wait and holds it while the PATCH is in flight', async () => {
      const gate = deferred();
      const w = await gready({ respond: routes(on('PATCH', 'issues?id=eq.7', () => gate.promise), completeReply({})) });
      const run = w.editor.saveAndContinue();
      await settle();
      expect(snap(w).savingAndContinuing).toBe(true);
      expect(snap(w).saving).toBe(false);
      gate.resolve(reply(200, [RECORD]));
      await run;
      expect(snap(w).savingAndContinuing).toBe(false);
    });
  });
});

describe('recordEditor edit: skipStep', () => {
  withFakeTimers();
  const ensure = (id: number | null = 301) => on('POST', ENSURE, () => reply(200, id === null ? {} : { record_id: id }));

  it('goes to the next step, ensuring its record first (ported 1039)', async () => {
    const w = await gready({ respond: ensure() });
    expect(await w.editor.skipStep()).toEqual({ kind: 'edit', table: 'budgets', id: 301 });
    const [req] = rpcs(w, 'ensure_guided_form_step_record');
    expect(req!.body).toEqual({ p_guided_form_key: 'intake', p_parent_id: 100, p_step_key: 'budget' });
    expect(Object.keys(req!.body as object)).toEqual(['p_guided_form_key', 'p_parent_id', 'p_step_key']);
    expect(writes(w).filter(r => r.path !== GCTX)).toHaveLength(1);
  });

  it('goes to the parent detail page from the last step without ensuring anything (ported 1060)', async () => {
    const w = await gready({ ctx: gctx({ steps: [G_PARENT, G_BUDGET, gstep('about', 'issues', 9)] }), respond: ensure() });
    expect(await w.editor.skipStep()).toEqual({ kind: 'view', table: 'applications', id: 100 });
    expect(rpcs(w, 'ensure_guided_form_step_record')).toEqual([]);
  });

  it('jumps over steps a skip_if condition skips, but not completed steps or require_if', async () => {
    const skipped = gstep('budget', 'budgets', 2, { conditions: [gcond('skip_if', 'name')] });
    const w = await gready({ ctx: gctx({ steps: [G_PARENT, G_ABOUT, skipped, G_DOCS] }), respond: ensure() });
    expect(await w.editor.skipStep()).toEqual({ kind: 'edit', table: 'documents', id: 301 });
    expect((rpcs(w, 'ensure_guided_form_step_record')[0]!.body as any).p_step_key).toBe('docs');
    const done = await gready({ ctx: gctx({ progress: [{ step_key: 'budget', is_completed: true }] as any }), respond: ensure() });
    expect(await done.editor.skipStep()).toEqual({ kind: 'edit', table: 'budgets', id: 301 });
  });

  it('orders the steps by step_order', async () => {
    const w = await gready({ ctx: gctx({ steps: [G_DOCS, G_BUDGET, G_ABOUT, G_PARENT] }), respond: ensure() });
    expect(await w.editor.skipStep()).toEqual({ kind: 'edit', table: 'budgets', id: 301 });
  });

  it('falls back to the parent detail page when ensuring fails or returns no record', async () => {
    const failed = await gready({ respond: on('POST', ENSURE, () => reply(500, { message: 'no' })) });
    expect(await failed.editor.skipStep()).toEqual({ kind: 'view', table: 'applications', id: 100 });
    const empty = await gready({ respond: ensure(null) });
    expect(await empty.editor.skipStep()).toEqual({ kind: 'view', table: 'applications', id: 100 });
  });

  it('is null without a context, without a parent id, or without a current step', async () => {
    const none = await gready({ ctx: 'fail' });
    expect(await none.editor.skipStep()).toBeNull();
    const noParent = await gready({ ctx: gctx({ parent_id: 0 }) });
    expect(await noParent.editor.skipStep()).toBeNull();
    const lost = await gready({ ctx: gctx({ steps: [G_PARENT, G_BUDGET] }), respond: ensure() });
    expect(await lost.editor.skipStep()).toBeNull();
    expect(rpcs(lost, 'ensure_guided_form_step_record')).toEqual([]);
  });
});

describe('recordEditor edit: goToStep', () => {
  withFakeTimers();
  const ensure = (id: number | null = 301) => on('POST', ENSURE, () => reply(200, id === null ? {} : { record_id: id }));

  it('is ignored without a context', async () => {
    const w = await gready({ ctx: 'fail' });
    expect(await w.editor.goToStep('budget')).toEqual({ status: 'ignored' });
  });

  it('opens the parent for edit and the review page for view', async () => {
    const w = await gready();
    expect(await w.editor.goToStep('__parent__')).toEqual({ status: 'navigate', navigation: { kind: 'edit', table: 'applications', id: '100' } });
    expect(await w.editor.goToStep('__review__')).toEqual({ status: 'navigate', navigation: { kind: 'view', table: 'applications', id: '100' } });
    expect(rpcs(w, 'ensure_guided_form_step_record')).toEqual([]);
  });

  it('is none for an unknown step and for the current step, sending nothing', async () => {
    const w = await gready({ respond: ensure() });
    expect(await w.editor.goToStep('nope')).toEqual({ status: 'none' });
    expect(await w.editor.goToStep('about')).toEqual({ status: 'none' });
    expect(rpcs(w, 'ensure_guided_form_step_record')).toEqual([]);
  });

  it('ensures the step record and navigates to it', async () => {
    const w = await gready({ respond: ensure() });
    expect(await w.editor.goToStep('budget')).toEqual({ status: 'navigate', navigation: { kind: 'edit', table: 'budgets', id: 301 } });
    expect(rpcs(w, 'ensure_guided_form_step_record')[0]!.body).toEqual({ p_guided_form_key: 'intake', p_parent_id: 100, p_step_key: 'budget' });
  });

  it('is none when ensuring returns no record, or when the step has no parent_fk_column', async () => {
    const empty = await gready({ respond: ensure(null) });
    expect(await empty.editor.goToStep('budget')).toEqual({ status: 'none' });
    const bare = await gready({ ctx: gctx({ steps: [G_PARENT, G_ABOUT, gstep('budget', 'budgets', 2, { parent_fk_column: null })] }), respond: ensure() });
    expect(await bare.editor.goToStep('budget')).toEqual({ status: 'none' });
    expect(rpcs(bare, 'ensure_guided_form_step_record')).toEqual([]);
  });

  it('is failed with the server message, or the fixed text when the answer has none', async () => {
    const withMessage = await gready({ respond: on('POST', ENSURE, () => reply(400, { message: 'Not allowed' })) });
    expect(await withMessage.editor.goToStep('budget')).toEqual({ status: 'failed', error: { humanMessage: 'Not allowed', message: 'Not allowed' } });
    const thrown = await gready({ respond: on('POST', ENSURE, () => Promise.reject(new TransportError('network', 'offline'))) });
    expect(await thrown.editor.goToStep('budget')).toEqual({ status: 'failed', error: { humanMessage: 'Failed to load step record.', message: 'offline' } });
  });
});

describe('recordEditor edit: enterEditMode and cancelEditMode', () => {
  withFakeTimers();

  it('enterEditMode leaves display mode', async () => {
    const w = await gready({ ctx: gctx(SUBMITTED), entity: { update: true } });
    expect(gf(w).completedStepDisplay).toBe(true);
    const before = w.notified.count;
    w.editor.enterEditMode();
    expect(gf(w)).toMatchObject({ editingCompletedStep: true, completedStepDisplay: false });
    expect(w.notified.count).toBe(before + 1);
  });

  describe('cancelEditMode', () => {
    const entered = async (over: GuidedScenario = {}) => {
      const w = await gready({ ctx: gctx(SUBMITTED), entity: { update: true }, ...over });
      w.editor.enterEditMode();
      return w;
    };

    it('puts the values back to the loaded ones, pristine, and leaves edit mode in one publish', async () => {
      const w = await entered();
      type(w, 'name', 'Changed');
      type(w, 'count', 9);
      const before = w.notified.count;
      w.editor.cancelEditMode();
      expect(value(w, 'name')).toBe('Existing');
      expect(value(w, 'count')).toBe(3);
      expect(snap(w).form!.fields['name']!.dirty).toBe(false);
      expect(gf(w).editingCompletedStep).toBe(false);
      expect(w.notified.count).toBe(before + 1);
    });

    it('resets the backend once with the loaded control values', async () => {
      const w = await entered();
      type(w, 'name', 'Changed');
      const calls = backend(w).resetCalls.length;
      w.editor.cancelEditMode();
      expect(backend(w).resetCalls).toHaveLength(calls + 1);
      expect(backend(w).resetCalls[calls]).toMatchObject({ name: 'Existing', count: 3, active: true });
    });

    it('keeps the touched state of the fields that were touched', async () => {
      const w = await entered();
      type(w, 'name', 'Changed');
      backend(w).markTouched('name');
      w.editor.cancelEditMode();
      expect(snap(w).form!.fields['name']!.touched).toBe(true);
      expect(snap(w).form!.fields['count']!.touched).toBe(false);
    });

    it('never calls setValue or setValues on the backend', async () => {
      const w = await entered();
      type(w, 'name', 'Changed');
      const b = backend(w);
      const one = vi.spyOn(b, 'setValue');
      const many = vi.spyOn(b, 'setValues');
      w.editor.cancelEditMode();
      expect(one).not.toHaveBeenCalled();
      expect(many).not.toHaveBeenCalled();
    });

    it('converts a DateTimeLocal value through the editor time zone, as the load does', async () => {
      const w = await entered({ props: [...BASE, STARTS], record: { ...RECORD, starts: '2026-01-13T22:30:00+00:00' } });
      const loaded = value(w, 'starts');
      type(w, 'starts', '2030-01-01T00:00');
      w.editor.cancelEditMode();
      expect(value(w, 'starts')).toBe(loaded);
    });

    it('never arms an autosave PATCH, even after a draft has been autosaved', async () => {
      const w = await gready();
      type(w, 'count', 5);
      await tick(1500);
      await settle();
      expect(patches(w)).toHaveLength(1);
      w.editor.enterEditMode();
      w.editor.cancelEditMode();
      await tick(10000);
      expect(patches(w)).toHaveLength(1);
    });

    it('does nothing harmful without a guided form or a loaded form', async () => {
      const plain = make();
      await settle();
      expect(() => plain.editor.cancelEditMode()).not.toThrow();
      expect(() => plain.editor.enterEditMode()).not.toThrow();
      const loading = make();
      expect(() => loading.editor.cancelEditMode()).not.toThrow();
      await settle();
    });
  });
});

describe('recordEditor edit: guided commands on a disposed editor', () => {
  withFakeTimers();

  it('throw synchronously, like every other command', async () => {
    const w = await gready();
    w.editor.dispose();
    expect(() => w.editor.saveAndContinue()).toThrow('recordEditor is disposed');
    expect(() => w.editor.skipStep()).toThrow('recordEditor is disposed');
    expect(() => w.editor.goToStep('budget')).toThrow('recordEditor is disposed');
    expect(() => w.editor.enterEditMode()).toThrow('recordEditor is disposed');
    expect(() => w.editor.cancelEditMode()).toThrow('recordEditor is disposed');
  });
});
