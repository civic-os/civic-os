/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { SchemaClient } from '../client/schema-client.js';
import { EntityPropertyType } from '../model/entity.js';
import type { EntityAction, SchemaEntityProperty, SchemaEntityTable } from '../model/entity.js';
import type { Transport, TransportRequest, TransportResponse } from '../transport/types.js';
import { EntityHandle } from './handles.js';

const API = 'https://api.example.com/';

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as object)) deepFreeze(v);
  }
  return o;
}

const entity = (over: Partial<SchemaEntityTable> = {}): SchemaEntityTable =>
  deepFreeze({
    table_name: 'issues',
    display_name: 'Issues',
    sort_order: 3,
    description: 'Reported issues',
    search_fields: ['title'],
    show_map: true,
    map_property_name: 'location',
    show_calendar: false,
    calendar_property_name: null,
    calendar_color_property: null,
    insert: true,
    select: true,
    update: false,
    delete: false,
    enable_notes: true,
    show_in_sidebar: false,
    ...over,
  } as SchemaEntityTable);

const prop = (over: Partial<SchemaEntityProperty> = {}): SchemaEntityProperty =>
  deepFreeze({
    table_name: 'issues',
    column_name: 'title',
    display_name: 'Title',
    sort_order: 1,
    is_nullable: false,
    data_type: 'character varying',
    udt_name: 'varchar',
    is_generated: false,
    is_identity: false,
    is_updatable: true,
    join_table: '',
    join_column: '',
    show_on_list: true,
    show_on_detail: false,
    validation_rules: [{ type: 'minLength', value: '3', message: 'short' }],
    ...over,
  } as SchemaEntityProperty);

const action = (over: Partial<EntityAction> = {}): EntityAction =>
  deepFreeze({
    id: 1,
    table_name: 'issues',
    action_name: 'close_issue',
    display_name: 'Close',
    rpc_function: 'close_issue',
    can_execute: true,
    visibility_condition: { field: 'status', operator: 'eq', value: 'open' },
    parameters: [],
    ...over,
  } as EntityAction);

/** Transport answering from mutable tables, so a test can change what the next load returns. */
function world() {
  const data = {
    entities: [entity()],
    properties: [prop()],
    actions: [action()],
  };
  const transport: Transport = {
    request(req: TransportRequest): Promise<TransportResponse> {
      const path = req.url.slice(API.length);
      const body = path.startsWith('schema_entities')
        ? data.entities
        : path.startsWith('schema_properties')
          ? data.properties
          : path.startsWith('schema_entity_actions')
            ? data.actions
            : [];
      return Promise.resolve({ status: 200, headers: {}, text: JSON.stringify(body) });
    },
  };
  const client = new SchemaClient({ transport, apiUrl: API });
  return { data, client };
}

async function warm() {
  const w = world();
  await Promise.all([w.client.getEntities(), w.client.getProperties(), w.client.getEntityActions('issues')]);
  return w;
}

describe('SchemaClient.entity', () => {
  it('is undefined while cold and for an unknown name, a handle otherwise', async () => {
    const { client } = world();
    expect(client.entity('issues')).toBeUndefined();
    await client.getEntities();
    expect(client.entity('nope')).toBeUndefined();
    expect(client.entity('issues')).toBeInstanceOf(EntityHandle);
  });

  it('cannot be constructed outside core, even by a cast', () => {
    const ctor = EntityHandle as unknown as new (...args: unknown[]) => EntityHandle;
    expect(() => new ctor(Symbol('x'), {}, 'issues')).toThrow(TypeError);
  });
});

describe('EntityHandle', () => {
  it('exposes structural, presentation, schema, can and features from the live row', async () => {
    const { client } = await warm();
    const h = client.entity('issues')!;
    expect(h.name).toBe('issues');
    expect(h.exists).toBe(true);
    expect(h.structural).toMatchObject({ name: 'issues', displayName: 'Issues', description: 'Reported issues', searchFields: ['title'] });
    expect(h.presentation).toEqual({ sortOrder: 3, showInSidebar: false });
    expect(h.schema).toEqual({ isView: false, isRichJunction: false });
    expect(h.can).toEqual({ insert: true, select: true, update: false, delete: false });
    expect(h.features).toMatchObject({ notes: true, map: true, mapProperty: 'location', calendar: false, payment: false, recurring: false, guidedFormKey: null });
  });

  it('returns frozen snapshots, never the row', async () => {
    const { client } = await warm();
    const h = client.entity('issues')!;
    expect(Object.isFrozen(h.can)).toBe(true);
    expect(h.liveRow).toBe(client.peekEntities()![0]);
  });

  it('property() is a PropertyHandle for a known column and undefined otherwise', async () => {
    const { client } = await warm();
    const h = client.entity('issues')!;
    expect(h.property('missing')).toBeUndefined();
    const p = h.property('title')!;
    expect(p.name).toBe('title');
    expect(p.schema).toMatchObject({ type: EntityPropertyType.TextShort, isNullable: false, dataType: 'character varying', joinTable: null });
    expect(p.schema!.validators).toEqual([{ kind: 'required' }, { kind: 'minLength', value: 3 }]);
    expect(p.presentation).toMatchObject({ showOn: { list: true, create: true, edit: true, detail: false }, sortOrder: 1, displayName: 'Title' });
    expect(p.structural).toMatchObject({ name: 'title', tableName: 'issues', dependsOnColumns: [] });
  });

  it('action() finds a loaded action and evaluates its visibility through core conditions', async () => {
    const { client } = await warm();
    const h = client.entity('issues')!;
    expect(h.action('nope')).toBeUndefined();
    const a = h.action('close_issue')!;
    expect(a.displayName).toBe('Close');
    expect(a.canExecute).toBe(true);
    expect(a.isVisible({ status: 'open' })).toBe(true);
    expect(a.isVisible({ status: 'closed' })).toBe(false);
    expect(a.isEnabled({})).toBe(true);
  });

  it('has no actions before getEntityActions ran', async () => {
    const { client } = world();
    await client.getEntities();
    expect(client.entity('issues')!.action('close_issue')).toBeUndefined();
  });
});

describe('liveness', () => {
  it('reports absence after invalidateEntities and recovers after a reload', async () => {
    const { client } = await warm();
    const h = client.entity('issues')!;
    const p = h.property('title')!;
    const a = h.action('close_issue')!;

    client.invalidateEntities();
    for (const dead of [h, p, a]) expect(dead.exists).toBe(false);
    expect(h.structural).toBeUndefined();
    expect(h.can).toBeUndefined();
    expect(h.features).toBeUndefined();
    expect(h.presentation).toBeUndefined();
    expect(h.schema).toBeUndefined();
    expect(h.liveRow).toBeUndefined();
    expect(h.property('title')).toBeUndefined();
    expect(h.action('close_issue')).toBeUndefined();
    expect(p.schema).toBeUndefined();
    expect(p.presentation).toBeUndefined();
    expect(p.structural).toBeUndefined();
    expect(a.displayName).toBeUndefined();
    expect(a.isVisible({})).toBeUndefined();
    expect(client.entity('issues')).toBeUndefined();

    await client.getEntities();
    expect(h.exists).toBe(true);
    expect(h.structural?.displayName).toBe('Issues');
    expect(p.exists).toBe(true);
    // the actions were dropped with the entities and are not back until loaded again
    expect(a.exists).toBe(false);
    await client.getEntityActions('issues');
    expect(a.exists).toBe(true);
  });

  it('reports absence when a refresh removes the entity', async () => {
    const { client, data } = await warm();
    const h = client.entity('issues')!;
    data.entities = [entity({ table_name: 'other', display_name: 'Other' })];
    client.invalidateEntities();
    await client.getEntities();
    expect(h.exists).toBe(false);
    expect(h.structural).toBeUndefined();
    expect(h.property('title')).toBeUndefined();
    expect(client.entity('other')!.exists).toBe(true);
  });

  it('an old handle sees a refresh that changes a property type and a display name', async () => {
    const { client, data } = await warm();
    const h = client.entity('issues')!;
    const p = h.property('title')!;
    expect(p.schema!.type).toBe(EntityPropertyType.TextShort);
    expect(h.structural!.displayName).toBe('Issues');

    data.properties = [prop({ data_type: 'integer', udt_name: 'int4', display_name: 'Count' })];
    data.entities = [entity({ display_name: 'Tickets' })];
    client.invalidateEntities();
    client.invalidateProperties();
    await Promise.all([client.getEntities(), client.getProperties()]);

    expect(p.schema!.type).toBe(EntityPropertyType.IntegerNumber);
    expect(p.presentation!.displayName).toBe('Count');
    expect(h.structural!.displayName).toBe('Tickets');
  });

  it('a property that disappears in a properties refresh reports absence while the entity stays', async () => {
    const { client, data } = await warm();
    const h = client.entity('issues')!;
    const p = h.property('title')!;
    data.properties = [];
    client.invalidateProperties();
    await client.getProperties();
    expect(h.exists).toBe(true);
    expect(p.exists).toBe(false);
    expect(p.schema).toBeUndefined();
  });

  it('follows a context switch to a cold context', async () => {
    const { client } = await warm();
    const h = client.entity('issues')!;
    client.use({ identity: 'someone-else' });
    expect(h.exists).toBe(false);
    client.use({ identity: '' });
    expect(h.exists).toBe(true);
  });
});
