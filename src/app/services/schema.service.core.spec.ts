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
import { effect, provideZonelessChangeDetection } from '@angular/core';
import { HttpErrorResponse, provideHttpClient, withXhr } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { firstValueFrom } from 'rxjs';
import { SchemaService } from './schema.service';
import { MOCK_ENTITIES, MOCK_PROPERTIES } from '../testing';
import { provideTranslationTesting } from '../testing/translation-testing';
import { awaitRequest, settle } from '../testing/await-http';

const fail = { status: 500, statusText: 'Server Error' };

/**
 * SchemaService on top of the core SchemaClient: the legacy console.error
 * messages, the `tables` signal rule, cache clearing, and the invalidators.
 */
describe('SchemaService over the core SchemaClient', () => {
  let service: SchemaService;
  let httpMock: HttpTestingController;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(withXhr()),
        provideHttpClientTesting(),
        provideTranslationTesting(),
        SchemaService,
      ],
    });
    service = TestBed.inject(SchemaService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
    errorSpy.mockRestore();
  });

  const urlHas = (fragment: string) => (r: { url: string }) => r.url.includes(fragment);
  const tables = () => (service as any).tables() as unknown[] | undefined;

  async function loadEntities(rows: unknown[] = [MOCK_ENTITIES.issue]) {
    const done = firstValueFrom(service.getEntities());
    httpMock.expectOne(urlHas('schema_entities')).flush(rows);
    return done;
  }

  describe('degrading loads log the same message and resolve an empty list', () => {
    it('constraint messages', async () => {
      const done = firstValueFrom(service.getConstraintMessages());
      httpMock.expectOne(urlHas('constraint_messages')).flush('x', fail);
      expect(await done).toEqual([]);
      expect(errorSpy).toHaveBeenCalledWith('Failed to load constraint messages:', expect.any(HttpErrorResponse));
      expect(service.constraintMessages).toBeUndefined();
    });

    it('statuses, naming the entity type, and does not mirror them', async () => {
      const done = firstValueFrom(service.getStatusesForEntity('issue'));
      httpMock.expectOne(urlHas('rpc/get_statuses_for_entity')).flush('x', fail);
      expect(await done).toEqual([]);
      expect(errorSpy).toHaveBeenCalledWith("Failed to load statuses for entity type 'issue':", expect.any(HttpErrorResponse));
      expect(service.getStatusOptionsSync('issue')).toEqual([]);
    });

    it('categories, naming the entity type', async () => {
      const done = firstValueFrom(service.getCategoriesForEntity('building'));
      httpMock.expectOne(urlHas('rpc/get_categories_for_entity')).flush('x', fail);
      expect(await done).toEqual([]);
      expect(errorSpy).toHaveBeenCalledWith("Failed to load categories for entity type 'building':", expect.any(HttpErrorResponse));
    });

    it('guided form definitions and steps', async () => {
      const defs = firstValueFrom(service.getGuidedFormDefinitions());
      httpMock.expectOne(urlHas('schema_guided_forms')).flush('x', fail);
      expect(await defs).toEqual([]);
      expect(errorSpy).toHaveBeenCalledWith('Failed to load guided form definitions:', expect.any(HttpErrorResponse));

      const steps = firstValueFrom(service.getGuidedFormSteps());
      httpMock.expectOne(urlHas('schema_guided_form_steps')).flush('x', fail);
      expect(await steps).toEqual([]);
      expect(errorSpy).toHaveBeenCalledWith('Failed to load guided form steps:', expect.any(HttpErrorResponse));
    });

    it('static text', async () => {
      const done = firstValueFrom(service.getStaticText());
      httpMock.expectOne(urlHas('static_text')).flush('x', fail);
      expect(await done).toEqual([]);
      expect(errorSpy).toHaveBeenCalledWith('Failed to load static text:', expect.any(HttpErrorResponse));
    });

    it('entity actions', async () => {
      const done = firstValueFrom(service.getEntityActions('issue'));
      httpMock.expectOne(urlHas('schema_entity_actions')).flush('x', fail);
      expect(await done).toEqual([]);
      expect(errorSpy).toHaveBeenCalledWith('Failed to load entity actions:', expect.any(HttpErrorResponse));
    });

    it('M:M metadata fails silently and the properties still load', async () => {
      const entities = loadEntities([MOCK_ENTITIES.issue]);
      const done = firstValueFrom(service.getProperties());
      await entities;
      httpMock.expectOne(urlHas('schema_properties')).flush([MOCK_PROPERTIES.textShort]);
      (await awaitRequest(httpMock, urlHas('schema_m2m_properties'))).flush('x', fail);
      const props = await done;
      expect(props.length).toBe(1);
      expect(errorSpy).not.toHaveBeenCalled();
    });
  });

  describe('property failures reject with the HttpErrorResponse', () => {
    it('getProperties', async () => {
      await loadEntities();
      const done = firstValueFrom(service.getProperties()).catch(e => e);
      httpMock.expectOne(urlHas('schema_properties')).flush({ message: 'down' }, fail);
      (await awaitRequest(httpMock, urlHas('schema_m2m_properties'))).flush([]);
      const err = await done;
      expect(err).toBeInstanceOf(HttpErrorResponse);
      expect(err.status).toBe(500);
      expect(err.error).toEqual({ message: 'down' });
    });
  });

  describe('warm caches and de-duplication', () => {
    it('emits a warm cache synchronously', async () => {
      await loadEntities();
      let seen: unknown[] | undefined;
      service.getEntities().subscribe(v => (seen = v));
      expect(seen).toEqual([MOCK_ENTITIES.issue]);
    });

    it('shares one request between concurrent subscribers', async () => {
      const a = firstValueFrom(service.getConstraintMessages());
      const b = firstValueFrom(service.getConstraintMessages());
      httpMock.expectOne(urlHas('constraint_messages')).flush([]);
      expect(await a).toEqual([]);
      expect(await b).toEqual([]);
    });

    it('an effect subscribing to a warm status type does not track the status cache', async () => {
      const warmA = firstValueFrom(service.getStatusesForEntity('a'));
      httpMock.expectOne(r => r.url.includes('rpc/get_statuses_for_entity') && JSON.stringify(r.body).includes('"a"')).flush([]);
      await warmA;

      let runs = 0;
      const ref = TestBed.runInInjectionContext(() => effect(() => {
        runs++;
        service.getStatusesForEntity('a').subscribe();
      }));
      TestBed.tick();
      expect(runs).toBe(1);

      const loadB = firstValueFrom(service.getStatusesForEntity('b'));
      httpMock.expectOne(r => r.url.includes('rpc/get_statuses_for_entity') && JSON.stringify(r.body).includes('"b"'))
        .flush([{ id: 1, display_name: 'New', color: null, status_key: 'new' }]);
      await loadB;
      TestBed.tick();
      expect(service.getStatusOptionsSync('b').length).toBe(1);
      expect(runs).toBe(1);
      ref.destroy();
    });

    it('an effect subscribing to a warm category type does not track the category cache', async () => {
      const warmA = firstValueFrom(service.getCategoriesForEntity('a'));
      httpMock.expectOne(r => r.url.includes('rpc/get_categories_for_entity') && JSON.stringify(r.body).includes('"a"')).flush([]);
      await warmA;

      let runs = 0;
      const ref = TestBed.runInInjectionContext(() => effect(() => {
        runs++;
        service.getCategoriesForEntity('a').subscribe();
      }));
      TestBed.tick();
      expect(runs).toBe(1);

      const loadB = firstValueFrom(service.getCategoriesForEntity('b'));
      httpMock.expectOne(r => r.url.includes('rpc/get_categories_for_entity') && JSON.stringify(r.body).includes('"b"'))
        .flush([{ id: 1, display_name: 'X', color: null, category_key: 'x' }]);
      await loadB;
      TestBed.tick();
      expect(service.getCategoryOptionsSync('b').length).toBe(1);
      expect(runs).toBe(1);
      ref.destroy();
    });
  });

  describe('tables signal', () => {
    it('is set from the entities store once loaded', async () => {
      expect(tables()).toBeUndefined();
      await loadEntities();
      await settle();
      expect(tables()).toEqual([MOCK_ENTITIES.issue]);
    });

    it('keeps its previous value while a refresh is in flight, then takes the new one', async () => {
      await loadEntities();
      await settle();
      service.refreshEntitiesCache();
      const req = httpMock.expectOne(urlHas('schema_entities'));
      await settle();
      expect(tables()).toEqual([MOCK_ENTITIES.issue]);
      req.flush([MOCK_ENTITIES.issue, MOCK_ENTITIES.status]);
      await settle();
      expect(tables()).toEqual([MOCK_ENTITIES.issue, MOCK_ENTITIES.status]);
    });

    it('refreshCache keeps the signal at its previous value until the refetch lands', async () => {
      await loadEntities();
      await settle();
      service.refreshCache();
      const req = httpMock.expectOne(urlHas('schema_entities'));
      await settle();
      expect(tables()).toEqual([MOCK_ENTITIES.issue]);
      req.flush([MOCK_ENTITIES.status]);
      await settle();
      expect(tables()).toEqual([MOCK_ENTITIES.status]);
    });
  });

  describe('refreshCache', () => {
    it('clears constraint messages and issues an eager entities refetch only', async () => {
      const messages = firstValueFrom(service.getConstraintMessages());
      httpMock.expectOne(urlHas('constraint_messages')).flush([{ id: 1, constraint_name: 'c', table_name: 't', column_name: null, error_message: 'm' }]);
      await messages;
      await settle();
      expect(service.constraintMessages?.length).toBe(1);

      service.refreshCache();
      expect(service.constraintMessages).toBeUndefined();
      expect(service.properties).toBeUndefined();
      httpMock.expectOne(urlHas('schema_entities')).flush([]);
      httpMock.expectNone(urlHas('constraint_messages'));
      httpMock.expectNone(urlHas('schema_properties'));
    });

    it('drops cached statuses so the next read refetches', async () => {
      const first = firstValueFrom(service.getStatusesForEntity('issue'));
      httpMock.expectOne(urlHas('rpc/get_statuses_for_entity')).flush([{ id: 1, display_name: 'New', color: null, status_key: 'new' }]);
      await first;
      await settle();
      expect(service.getStatusOptionsSync('issue').length).toBe(1);

      service.refreshCache();
      httpMock.expectOne(urlHas('schema_entities')).flush([]);
      expect(service.getStatusOptionsSync('issue')).toEqual([]);

      const again = firstValueFrom(service.getStatusesForEntity('issue'));
      httpMock.expectOne(urlHas('rpc/get_statuses_for_entity')).flush([]);
      await again;
    });

    it('drops static text but keeps guided forms, which only invalidateGuidedFormCache clears', async () => {
      const text = firstValueFrom(service.getStaticText());
      httpMock.expectOne(urlHas('static_text')).flush([]);
      await text;
      const forms = firstValueFrom(service.getGuidedFormDefinitions());
      httpMock.expectOne(urlHas('schema_guided_forms')).flush([]);
      await forms;
      const steps = firstValueFrom(service.getGuidedFormSteps());
      httpMock.expectOne(urlHas('schema_guided_form_steps')).flush([]);
      await steps;
      await settle();

      service.refreshCache();
      httpMock.expectOne(urlHas('schema_entities')).flush([]);

      const formsAgain = firstValueFrom(service.getGuidedFormDefinitions());
      const stepsAgain = firstValueFrom(service.getGuidedFormSteps());
      httpMock.expectNone(urlHas('schema_guided_form'));
      await formsAgain;
      await stepsAgain;

      const textAgain = firstValueFrom(service.getStaticText());
      httpMock.expectOne(urlHas('static_text')).flush([]);
      await textAgain;
    });
  });

  describe('invalidators map to the client invalidators', () => {
    it('invalidateStatusCache(type) refetches only that type', async () => {
      for (const type of ['a', 'b']) {
        const p = firstValueFrom(service.getStatusesForEntity(type));
        httpMock.expectOne(r => r.url.includes('rpc/get_statuses_for_entity') && JSON.stringify(r.body).includes(`"${type}"`)).flush([]);
        await p;
      }
      service.invalidateStatusCache('a');

      let warmB: unknown;
      service.getStatusesForEntity('b').subscribe(v => (warmB = v));
      expect(warmB).toEqual([]);
      httpMock.expectNone(urlHas('rpc/get_statuses_for_entity'));

      const a = firstValueFrom(service.getStatusesForEntity('a'));
      httpMock.expectOne(urlHas('rpc/get_statuses_for_entity')).flush([]);
      await a;
    });

    it('invalidateStatusCache() and refreshStatusesCache() forget every type', async () => {
      const p = firstValueFrom(service.getStatusesForEntity('a'));
      httpMock.expectOne(urlHas('rpc/get_statuses_for_entity')).flush([]);
      await p;

      service.invalidateStatusCache();
      const q = firstValueFrom(service.getStatusesForEntity('a'));
      httpMock.expectOne(urlHas('rpc/get_statuses_for_entity')).flush([]);
      await q;

      service.refreshStatusesCache();
      const r = firstValueFrom(service.getStatusesForEntity('a'));
      httpMock.expectOne(urlHas('rpc/get_statuses_for_entity')).flush([]);
      await r;
    });

    it('invalidateCategoryCache refetches categories', async () => {
      const p = firstValueFrom(service.getCategoriesForEntity('a'));
      httpMock.expectOne(urlHas('rpc/get_categories_for_entity')).flush([]);
      await p;
      service.invalidateCategoryCache('a');
      const q = firstValueFrom(service.getCategoriesForEntity('a'));
      httpMock.expectOne(urlHas('rpc/get_categories_for_entity')).flush([]);
      await q;
    });

    it('refreshStaticTextCache refetches static text', async () => {
      const p = firstValueFrom(service.getStaticText());
      httpMock.expectOne(urlHas('static_text')).flush([]);
      await p;
      service.refreshStaticTextCache();
      const q = firstValueFrom(service.getStaticText());
      httpMock.expectOne(urlHas('static_text')).flush([]);
      await q;
    });

    it('invalidateGuidedFormCache refetches definitions and steps', async () => {
      const defs = firstValueFrom(service.getGuidedFormDefinitions());
      httpMock.expectOne(urlHas('schema_guided_forms')).flush([]);
      await defs;
      const steps = firstValueFrom(service.getGuidedFormSteps());
      httpMock.expectOne(urlHas('schema_guided_form_steps')).flush([]);
      await steps;

      service.invalidateGuidedFormCache();

      const defs2 = firstValueFrom(service.getGuidedFormDefinitions());
      httpMock.expectOne(urlHas('schema_guided_forms')).flush([]);
      await defs2;
      const steps2 = firstValueFrom(service.getGuidedFormSteps());
      httpMock.expectOne(urlHas('schema_guided_form_steps')).flush([]);
      await steps2;
    });
  });

  describe('eager refresh', () => {
    it('refreshEntitiesCache invalidates and fetches immediately without a subscriber', () => {
      service.refreshEntitiesCache();
      httpMock.expectOne(urlHas('schema_entities')).flush([]);
    });

    it('refreshPropertiesCache invalidates and fetches immediately', async () => {
      const entities = loadEntities();
      await entities;
      service.refreshPropertiesCache();
      httpMock.expectOne(urlHas('schema_properties')).flush([]);
      (await awaitRequest(httpMock, urlHas('schema_m2m_properties'))).flush([]);
      await settle();
    });
  });
});
