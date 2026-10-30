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
import type { DataClient, SchemaEntityTable } from '@civic-os/core';
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
