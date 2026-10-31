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

describe('recordEditor edit: later commands', () => {
  it('throws not implemented for the series and guided commands', async () => {
    const w = await ready();
    const calls: [string, () => unknown][] = [
      ['saveWithScope', () => (w.editor as any).saveWithScope('all')],
      ['cancelScope', () => (w.editor as any).cancelScope()],
      ['saveAndContinue', () => (w.editor as any).saveAndContinue()],
      ['skipStep', () => (w.editor as any).skipStep()],
      ['goToStep', () => (w.editor as any).goToStep('x')],
      ['enterEditMode', () => (w.editor as any).enterEditMode()],
      ['cancelEditMode', () => (w.editor as any).cancelEditMode()],
    ];
    for (const [name, call] of calls) expect(call).toThrow(`recordEditor edit mode: ${name} is not implemented yet`);
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
