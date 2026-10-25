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
import { HttpErrorResponse, HttpEventType, provideHttpClient, withXhr } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { firstValueFrom, toArray } from 'rxjs';
import { DataService } from './data.service';
import { AnalyticsService } from './analytics.service';
import { provideTranslationTesting } from '../testing/translation-testing';
import { settle } from '../testing/await-http';

const API = 'http://test-api.example.com/';

/**
 * Outgoing requests of every DataService HTTP method, as they were before the
 * core took over the I/O: method, URL, body, and the headers the service sets.
 */
describe('DataService requests through the core', () => {
  let service: DataService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    (window as any).civicOsConfig = { postgrestUrl: API };
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(withXhr()),
        provideHttpClientTesting(),
        provideTranslationTesting(),
        { provide: AnalyticsService, useValue: { trackEvent: vi.fn() } },
        DataService,
      ],
    });
    service = TestBed.inject(DataService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  const meta: any = { junctionTable: 'issue_tags', sourceColumn: 'issue_id', targetColumn: 'tag_id' };

  it('getData issues GET with the compiled select and order', async () => {
    const done = firstValueFrom(service.getData({ key: 'issues', fields: ['name'], orderField: 'name' }));
    const req = httpMock.expectOne(r => r.url.startsWith(API + 'issues'));
    expect(req.request.method).toBe('GET');
    expect(req.request.url).toBe(API + 'issues?select=name,id&order=name.asc');
    expect(req.request.body).toBeNull();
    req.flush([{ id: 1, name: 'a' }]);
    expect(await done).toEqual([{ id: 1, name: 'a' }]);
  });

  it('getDataPaginated issues GET with a count header and reads Content-Range', async () => {
    const done = firstValueFrom(service.getDataPaginated({ key: 'issues', fields: ['name'], pagination: { page: 2, pageSize: 10 } } as any));
    const req = httpMock.expectOne(r => r.url.startsWith(API + 'issues'));
    expect(req.request.method).toBe('GET');
    expect(req.request.headers.get('Prefer')).toBe('count=exact');
    req.flush([{ id: 11 }], { headers: { 'Content-Range': '10-19/237' } });
    expect(await done).toEqual({ data: [{ id: 11 }], totalCount: 237 });
  });

  it('createData issues POST with Prefer: return=representation', async () => {
    const done = firstValueFrom(service.createData('issues', { name: 'x' }));
    const req = httpMock.expectOne(API + 'issues');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ name: 'x' });
    expect(req.request.headers.get('Prefer')).toBe('return=representation');
    expect(req.request.headers.get('Content-Type')).toBeNull();
    req.flush([{ id: 5, name: 'x' }]);
    expect(await done).toEqual({ success: true, body: [{ id: 5, name: 'x' }] });
  });

  it('editData issues PATCH on ?id=eq.<id> and compares the representation', async () => {
    const done = firstValueFrom(service.editData('issues', 7, { name: 'y' }));
    const req = httpMock.expectOne(API + 'issues?id=eq.7');
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({ name: 'y' });
    expect(req.request.headers.get('Prefer')).toBe('return=representation');
    req.flush([{ id: 7, name: 'y' }]);
    expect((await done).success).toBe(true);
  });

  it('editData reports a no-op PATCH (empty representation) as a failure', async () => {
    const done = firstValueFrom(service.editData('issues', 7, { name: 'y' }));
    httpMock.expectOne(API + 'issues?id=eq.7').flush([]);
    expect((await done).success).toBe(false);
  });

  it('deleteData issues DELETE on ?id=eq.<id>', async () => {
    const done = firstValueFrom(service.deleteData('issues', 7));
    const req = httpMock.expectOne(API + 'issues?id=eq.7');
    expect(req.request.method).toBe('DELETE');
    expect(req.request.body).toBeNull();
    req.flush(null, { status: 204, statusText: 'No Content' });
    expect((await done).success).toBe(true);
  });

  it('refreshCurrentUser issues POST rpc/refresh_current_user with an empty object', async () => {
    const done = firstValueFrom(service.refreshCurrentUser());
    const req = httpMock.expectOne(API + 'rpc/refresh_current_user');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({});
    req.flush({});
    expect((await done).success).toBe(true);
  });

  it('getInverseRelationshipPreview issues GET with Prefer: count=exact', async () => {
    const done = firstValueFrom(service.getInverseRelationshipPreview('comments', 'issue_id', 3, 5));
    const req = httpMock.expectOne(API + 'comments?issue_id=eq.3&select=id,display_name&limit=5');
    expect(req.request.method).toBe('GET');
    expect(req.request.headers.get('Prefer')).toBe('count=exact');
    req.flush([{ id: 1 }], { headers: { 'Content-Range': '0-0/15' } });
    expect(await done).toEqual({ records: [{ id: 1 }], totalCount: 15 });
  });

  it('getInverseRelationshipPreview in count mode selects the filter column with limit=0', async () => {
    const done = firstValueFrom(service.getInverseRelationshipPreview('junction', 'a_id', 3, 5, 'count'));
    httpMock.expectOne(API + 'junction?a_id=eq.3&select=a_id&limit=0').flush([], { headers: { 'Content-Range': '*/4' } });
    expect((await done).totalCount).toBe(4);
  });

  it('addManyToManyRelation issues POST with Prefer: return=minimal', async () => {
    const done = firstValueFrom(service.addManyToManyRelation(1, meta, 2, { qty: 3 }));
    const req = httpMock.expectOne(API + 'issue_tags');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ issue_id: 1, tag_id: 2, qty: 3 });
    expect(req.request.headers.get('Prefer')).toBe('return=minimal');
    req.flush(null, { status: 201, statusText: 'Created' });
    expect(await done).toEqual({ success: true, body: null });
  });

  it('updateManyToManyRelation issues PATCH filtered by both keys', async () => {
    const done = firstValueFrom(service.updateManyToManyRelation(1, meta, 2, { qty: 4 }));
    const req = httpMock.expectOne(API + 'issue_tags?issue_id=eq.1&tag_id=eq.2');
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({ qty: 4 });
    expect(req.request.headers.get('Prefer')).toBe('return=minimal');
    req.flush(null, { status: 204, statusText: 'No Content' });
    expect(await done).toEqual({ success: true, body: null });
  });

  it('removeManyToManyRelation issues DELETE filtered by both keys', async () => {
    const done = firstValueFrom(service.removeManyToManyRelation(1, meta, 2));
    const req = httpMock.expectOne(API + 'issue_tags?issue_id=eq.1&tag_id=eq.2');
    expect(req.request.method).toBe('DELETE');
    req.flush(null, { status: 204, statusText: 'No Content' });
    expect(await done).toEqual({ success: true, body: null });
  });

  it('bulkInsert issues POST with the array body, JSON content type and progress events', async () => {
    const events = firstValueFrom(service.bulkInsert('issues', [{ name: 'a' }, { name: 'b' }]).pipe(toArray()));
    const req = httpMock.expectOne(API + 'issues');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual([{ name: 'a' }, { name: 'b' }]);
    expect(req.request.headers.get('Prefer')).toBe('return=representation');
    expect(req.request.reportProgress).toBe(true);
    req.event({ type: HttpEventType.UploadProgress, loaded: 50, total: 200 });
    req.flush([{ id: 1 }, { id: 2 }]);
    expect(await events).toEqual([
      { success: false, progress: 25, body: null },
      { success: true, body: [{ id: 1 }, { id: 2 }] },
    ]);
  });

  it('bulkInsertJunctions issues POST with Prefer: return=minimal, and nothing for an empty list', async () => {
    const done = firstValueFrom(service.bulkInsertJunctions('issue_tags', [{ issue_id: 1, tag_id: 2 }]));
    const req = httpMock.expectOne(API + 'issue_tags');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual([{ issue_id: 1, tag_id: 2 }]);
    expect(req.request.headers.get('Prefer')).toBe('return=minimal');
    req.flush(null, { status: 201, statusText: 'Created' });
    expect(await done).toEqual({ success: true, body: null });

    expect(await firstValueFrom(service.bulkInsertJunctions('issue_tags', []))).toEqual({ success: true, body: null });
    httpMock.expectNone(API + 'issue_tags');
  });

  it('callRpc issues POST rpc/<name> and surfaces the raw HttpErrorResponse on failure', async () => {
    const done = firstValueFrom(service.callRpc('do_it', { a: 1 }));
    const req = httpMock.expectOne(API + 'rpc/do_it');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ a: 1 });
    req.flush({ ok: true });
    expect(await done).toEqual({ ok: true });

    const failed = firstValueFrom(service.callRpc('do_it', {})).catch(e => e);
    httpMock.expectOne(API + 'rpc/do_it').flush({ code: 'P0001', message: 'nope' }, { status: 400, statusText: 'Bad Request' });
    const err = await failed;
    expect(err).toBeInstanceOf(HttpErrorResponse);
    expect(err.status).toBe(400);
    expect(err.error).toEqual({ code: 'P0001', message: 'nope' });
  });

  it('executeRpc issues POST rpc/<name>', async () => {
    const done = firstValueFrom(service.executeRpc('act', { id: 1 }));
    const req = httpMock.expectOne(API + 'rpc/act');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ id: 1 });
    req.flush({ success: true, message: 'ok' });
    expect((await done).success).toBe(true);
  });

  describe('error mapping equals the pre-core mapping', () => {
    const cases: Array<{ name: string; body: any; status: number; statusText: string; expected: any }> = [
      {
        name: 'a structured PostgREST error',
        body: { code: '23505', details: 'Key exists', hint: 'h', message: 'duplicate key' },
        status: 409,
        statusText: 'Conflict',
        expected: { httpCode: 409, code: '23505', details: 'Key exists', hint: 'h', message: 'duplicate key' },
      },
      {
        name: 'a structured error without a message falls back to the status text',
        body: { code: 'X' },
        status: 400,
        statusText: 'Bad Request',
        expected: { httpCode: 400, code: 'X', message: 'Bad Request' },
      },
      {
        name: 'a plain-text error body',
        body: 'boom',
        status: 500,
        statusText: 'Internal Server Error',
        expected: { httpCode: 500, message: 'boom' },
      },
      {
        name: 'an empty error body falls back to the status text',
        body: null,
        status: 502,
        statusText: 'Bad Gateway',
        expected: { httpCode: 502, message: 'Bad Gateway' },
      },
    ];

    for (const c of cases) {
      it(c.name, async () => {
        const done = firstValueFrom(service.createData('issues', {}));
        httpMock.expectOne(API + 'issues').flush(c.body, { status: c.status, statusText: c.statusText });
        const result = await done;
        expect(result.success).toBe(false);
        expect(result.error).toMatchObject(c.expected);
        expect(typeof result.error!.humanMessage).toBe('string');
      });
    }

    it('a network failure (status 0) maps like an unstructured error', async () => {
      const done = firstValueFrom(service.createData('issues', {}));
      httpMock.expectOne(API + 'issues').error(new ProgressEvent('error'), { status: 0, statusText: 'Unknown Error' });
      const result = await done;
      expect(result.success).toBe(false);
      expect(result.error!.httpCode).toBe(0);
    });

    it('getDataPaginated degrades to an empty page and logs, as before', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const done = firstValueFrom(service.getDataPaginated({ key: 'issues', fields: ['name'] } as any));
      httpMock.expectOne(r => r.url.startsWith(API + 'issues')).flush('x', { status: 500, statusText: 'Server Error' });
      expect(await done).toEqual({ data: [], totalCount: 0 });
      expect(spy).toHaveBeenCalledWith('Error fetching paginated data:', expect.any(HttpErrorResponse));
      spy.mockRestore();
    });
  });

  describe('laziness, synchronous issue and cancellation', () => {
    it('issues nothing until subscribed, and the request exists the moment subscribe returns', () => {
      const obs = service.createData('issues', { n: 1 });
      httpMock.expectNone(API + 'issues');
      const sub = obs.subscribe();
      const req = httpMock.expectOne(API + 'issues');
      expect(req.cancelled).toBe(false);
      sub.unsubscribe();
      expect(req.cancelled).toBe(true);
    });

    it('each subscription issues its own request', () => {
      const obs = service.deleteData('issues', 1);
      const a = obs.subscribe();
      const b = obs.subscribe();
      expect(httpMock.match(API + 'issues?id=eq.1').length).toBe(2);
      a.unsubscribe();
      b.unsubscribe();
    });

    it('unsubscribing mid-flight cancels the request and emits nothing', async () => {
      const seen: unknown[] = [];
      const sub = service.getData({ key: 'issues', fields: ['name'] }).subscribe(v => seen.push(v));
      const req = httpMock.expectOne(r => r.url.startsWith(API + 'issues'));
      sub.unsubscribe();
      expect(req.cancelled).toBe(true);
      await settle();
      expect(seen).toEqual([]);
    });

    it('a later unsubscribe after completion changes nothing that was delivered', async () => {
      const seen: unknown[] = [];
      let completed = 0;
      const sub = service.getData({ key: 'issues', fields: ['name'] }).subscribe({ next: v => seen.push(v), complete: () => completed++ });
      httpMock.expectOne(r => r.url.startsWith(API + 'issues')).flush([{ id: 1 }]);
      await settle();
      expect(seen).toEqual([[{ id: 1 }]]);
      expect(completed).toBe(1);
      sub.unsubscribe();
      await settle();
      expect(seen).toEqual([[{ id: 1 }]]);
      expect(completed).toBe(1);
    });
  });
});
