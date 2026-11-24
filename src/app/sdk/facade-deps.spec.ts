/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { of } from 'rxjs';
import type { DataClient, EntityHandle, SchemaEntityProperty, SchemaEntityTable } from '@civic-os/core';
import { DataService } from '../services/data.service';
import { SchemaService } from '../services/schema.service';
import { CLOCK } from './clock';
import { createFacadeDeps, FACADE_DEPS } from './facade-deps';

describe('facade deps', () => {
  it('reads the data client from DataService on each use', () => {
    let client = { id: 1 } as unknown as DataClient;
    const data = { get coreClient() { return client; } } as unknown as DataService;
    const deps = createFacadeDeps({ data, schema: {} as SchemaService, clock: { now: () => new Date(0) } });

    expect(deps.data).toBe(client);
    client = { id: 2 } as unknown as DataClient;
    expect(deps.data).toBe(client);
  });

  it('loads properties through SchemaService.getPropertiesForEntity', async () => {
    const props = [{ column_name: 'name' }];
    const getPropertiesForEntity = vi.fn(() => of(props));
    const entity = { table_name: 'issues' } as SchemaEntityTable;
    const deps = createFacadeDeps({
      data: {} as DataService,
      schema: { getPropertiesForEntity } as unknown as SchemaService,
      clock: { now: () => new Date(0) },
    });

    await expect(deps.schema.properties(entity)).resolves.toBe(props);
    expect(getPropertiesForEntity).toHaveBeenCalledWith(entity);
  });

  // Issue #72: Status and Category filter chips name their values
  it('names Status and Category values through the cached SchemaService options', async () => {
    const getStatusesForEntity = vi.fn(() => of([{ id: 22, display_name: 'Pending', color: null }, { id: 23, display_name: 'Approved', color: null }]));
    const getCategoriesForEntity = vi.fn(() => of([{ id: 4, display_name: 'Youth', color: null }]));
    const deps = createFacadeDeps({
      data: {} as DataService,
      schema: { getStatusesForEntity, getCategoriesForEntity } as unknown as SchemaService,
      clock: { now: () => new Date(0) },
    });
    const status = { column_name: 'status_id', status_entity_type: 'issue' } as SchemaEntityProperty;
    const category = { column_name: 'kind_id', category_entity_type: 'issue' } as SchemaEntityProperty;
    const other = { column_name: 'name' } as SchemaEntityProperty;

    expect([...(await deps.schema.optionNames!(status))]).toEqual([['22', 'Pending'], ['23', 'Approved']]);
    expect(getStatusesForEntity).toHaveBeenCalledWith('issue');
    expect([...(await deps.schema.optionNames!(category))]).toEqual([['4', 'Youth']]);
    expect(getCategoriesForEntity).toHaveBeenCalledWith('issue');
    expect((await deps.schema.optionNames!(other)).size).toBe(0);
  });

  it('loads the record viewer reads through the SchemaService calls the detail page always made', async () => {
    const row = { table_name: 'issues' } as SchemaEntityTable;
    const handle = { name: 'issues', liveRow: row } as unknown as EntityHandle;
    const renderables = [{ kind: 'property' }];
    const actions = [{ action_name: 'close' }];
    const inverse = [{ sourceTable: 'comments' }];
    const entities = [row];
    const exclude = new Set(['steps']);
    const getDetailRenderables = vi.fn(() => of(renderables));
    const getEntityActions = vi.fn(() => of(actions));
    const getInverseRelationships = vi.fn(() => of(inverse));
    const getEntities = vi.fn(() => of(entities));
    const deps = createFacadeDeps({
      data: {} as DataService,
      schema: { getDetailRenderables, getEntityActions, getInverseRelationships, getEntities } as unknown as SchemaService,
      clock: { now: () => new Date(0) },
    });

    await expect(deps.schema.renderables(handle)).resolves.toBe(renderables);
    expect(getDetailRenderables).toHaveBeenCalledWith(row);
    await expect(deps.schema.actions(handle)).resolves.toBe(actions);
    expect(getEntityActions).toHaveBeenCalledWith('issues');
    await expect(deps.schema.inverseRelationships(handle, exclude)).resolves.toBe(inverse);
    expect(getInverseRelationships).toHaveBeenCalledWith('issues', exclude);
    await expect(deps.schema.entities()).resolves.toBe(entities);
  });

  it('loads the record editor reads: create and edit renderables, and the constraint messages', async () => {
    const row = { table_name: 'issues' } as SchemaEntityTable;
    const handle = { name: 'issues', liveRow: row } as unknown as EntityHandle;
    const createItems = [{ kind: 'property', id: 'c' }];
    const editItems = [{ kind: 'property', id: 'e' }];
    const messages = [{ constraint_name: 'uq', message: 'taken' }];
    const getCreateRenderables = vi.fn(() => of(createItems));
    const getEditRenderables = vi.fn(() => of(editItems));
    const schema = { getCreateRenderables, getEditRenderables, constraintMessages: undefined as unknown } as unknown as SchemaService;
    const deps = createFacadeDeps({ data: {} as DataService, schema, clock: { now: () => new Date(0) } });

    await expect(deps.schema.formRenderables(handle, 'create')).resolves.toBe(createItems);
    expect(getCreateRenderables).toHaveBeenCalledWith(row);
    expect(getEditRenderables).not.toHaveBeenCalled();
    await expect(deps.schema.formRenderables(handle, 'edit')).resolves.toBe(editItems);
    expect(getEditRenderables).toHaveBeenCalledWith(row);

    expect(deps.schema.constraintMessages()).toBeUndefined();
    (schema as unknown as { constraintMessages: unknown }).constraintMessages = messages;
    expect(deps.schema.constraintMessages()).toBe(messages);
  });

  it('provides the app clock and services through the token', () => {
    const client = {} as DataClient;
    const clock = { now: () => new Date(0) };
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: DataService, useValue: { coreClient: client } },
        { provide: SchemaService, useValue: {} },
        { provide: CLOCK, useValue: clock },
      ],
    });
    const deps = TestBed.inject(FACADE_DEPS);

    expect(deps.data).toBe(client);
    expect(deps.clock).toBe(clock);
  });
});
