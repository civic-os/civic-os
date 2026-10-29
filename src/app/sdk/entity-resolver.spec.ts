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

import { ChangeDetectionStrategy, Component, input, provideZonelessChangeDetection, reflectComponentType } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Route, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { of, throwError } from 'rxjs';
import type { EntityHandle } from '@civic-os/core';
import { routes } from '../app.routes';
import { SchemaService } from '../services/schema.service';
import { entityResolver } from './entity-resolver';

@Component({ template: '', changeDetection: ChangeDetectionStrategy.OnPush })
class RoutedStub {
  readonly entityHandle = input<EntityHandle | undefined>();
}

const issueHandle = { name: 'Issue' } as EntityHandle;

describe('entityResolver', () => {
  let getEntityHandle: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    getEntityHandle = vi.fn((key: string) => of(key === 'Issue' ? issueHandle : undefined));
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        // The same binding options as app.config.ts
        provideRouter(
          [{ path: 'view/:entityKey', component: RoutedStub, resolve: { entityHandle: entityResolver } }],
          withComponentInputBinding({ queryParams: false }),
        ),
        { provide: SchemaService, useValue: { getEntityHandle } },
      ],
    });
  });

  it('binds the resolved handle into the routed component', async () => {
    const harness = await RouterTestingHarness.create();
    const page = await harness.navigateByUrl('/view/Issue', RoutedStub);

    expect(getEntityHandle).toHaveBeenCalledWith('Issue');
    expect(page.entityHandle()).toBe(issueHandle);
  });

  it('activates the page with undefined for an unknown entity', async () => {
    const harness = await RouterTestingHarness.create();
    const page = await harness.navigateByUrl('/view/Nope', RoutedStub);

    expect(page.entityHandle()).toBeUndefined();
  });

  it('does not let a query param set the input', async () => {
    getEntityHandle.mockReturnValue(of(undefined));
    const harness = await RouterTestingHarness.create();
    const page = await harness.navigateByUrl('/view/Nope?entityHandle=forged', RoutedStub);

    expect(page.entityHandle()).toBeUndefined();
  });

  it('re-resolves when the entity param changes', async () => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/view/Issue', RoutedStub);
    const page = await harness.navigateByUrl('/view/Nope', RoutedStub);

    expect(getEntityHandle).toHaveBeenCalledTimes(2);
    expect(page.entityHandle()).toBeUndefined();
  });

  it('adds no error handling of its own', async () => {
    // getEntityHandle never errors (it maps load failures to undefined); the resolver adds no handling of
    // its own, so a failing observable would cancel navigation. Pin that the resolver passes it through.
    getEntityHandle.mockReturnValue(throwError(() => new Error('unexpected')));
    const harness = await RouterTestingHarness.create();

    await expect(harness.navigateByUrl('/view/Issue')).rejects.toThrow('unexpected');
  });
});

describe('CRUD routes', () => {
  const crud = ['view/:entityKey', 'view/:entityKey/:entityId', 'create/:entityKey', 'edit/:entityKey/:entityId'];

  function find(path: string, list: Route[] = routes): Route | undefined {
    for (const route of list) {
      if (route.path === path) return route;
      const child = route.children && find(path, route.children);
      if (child) return child;
    }
    return undefined;
  }

  for (const path of crud) {
    it(`${path} resolves entityHandle into a page that declares it`, () => {
      const route = find(path);
      expect(route?.resolve?.['entityHandle']).toBe(entityResolver);
      const inputs = reflectComponentType(route!.component!)!.inputs.map(i => i.propName);
      expect(inputs).toEqual(['entityHandle']);
    });
  }
});
