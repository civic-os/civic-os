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
import { HttpClient, HttpErrorResponse, HttpEventType, provideHttpClient, withXhr } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Subject, firstValueFrom, toArray } from 'rxjs';
import { DataClientError, TransportError } from '@civic-os/core';
import type { Transport } from '@civic-os/core';
import { angularHttpTransport, originalHttpError } from './angular-http-transport';
import { fromCore, fromCoreWithProgress } from './from-core';
import { toLegacyError } from './legacy-error';
import { settle } from '../testing/await-http';

const URL = 'http://test-api.example.com/things';

describe('angularHttpTransport', () => {
  let transport: Transport;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), provideHttpClient(withXhr()), provideHttpClientTesting()],
    });
    transport = angularHttpTransport(TestBed.inject(HttpClient));
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  it('issues the HttpClient request synchronously inside request()', () => {
    void transport.request({ method: 'GET', url: URL, headers: {} });
    httpMock.expectOne(URL).flush([]);
  });

  it('parses the string body back to a value so HttpClient serializes it itself', async () => {
    const done = transport.request({ method: 'POST', url: URL, headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ a: [1, 2] }) });
    const req = httpMock.expectOne(URL);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ a: [1, 2] });
    expect(req.request.headers.get('Prefer')).toBe('return=minimal');
    expect(req.request.serializeBody()).toBe('{"a":[1,2]}');
    expect(req.request.detectContentTypeHeader()).toBe('application/json');
    expect(req.request.headers.has('Accept')).toBe(false);
    req.flush(null, { status: 201, statusText: 'Created' });
    expect((await done).status).toBe(201);
  });

  it('sends no body when the core sends none', () => {
    void transport.request({ method: 'DELETE', url: URL, headers: {} });
    const req = httpMock.expectOne(URL);
    expect(req.request.body).toBeNull();
    req.flush(null, { status: 204, statusText: 'No Content' });
  });

  it('resolves status, status text, lowercased headers and the body as JSON text', async () => {
    const done = transport.request({ method: 'GET', url: URL, headers: {} });
    httpMock.expectOne(URL).flush([{ id: 1 }], { headers: { 'Content-Range': '0-0/1', 'X-Maintenance-Mode': 'readonly' } });
    const res = await done;
    expect(res.status).toBe(200);
    expect(res.headers['content-range']).toBe('0-0/1');
    expect(res.headers['x-maintenance-mode']).toBe('readonly');
    expect(JSON.parse(res.text)).toEqual([{ id: 1 }]);
  });

  it('resolves an empty text for an empty body', async () => {
    const done = transport.request({ method: 'DELETE', url: URL, headers: {} });
    httpMock.expectOne(URL).flush(null, { status: 204, statusText: 'No Content' });
    expect((await done).text).toBe('');
  });

  it('resolves (does not reject) a non-2xx response, with the error body as text', async () => {
    const done = transport.request({ method: 'GET', url: URL, headers: {} });
    httpMock.expectOne(URL).flush({ code: 'PGRST', message: 'bad' }, { status: 400, statusText: 'Bad Request' });
    const res = await done;
    expect(res.status).toBe(400);
    expect(res.statusText).toBe('Bad Request');
    expect(JSON.parse(res.text)).toEqual({ code: 'PGRST', message: 'bad' });
    expect(originalHttpError(res.headers)).toBeInstanceOf(HttpErrorResponse);
  });

  it('passes a plain-text error body through unchanged', async () => {
    const done = transport.request({ method: 'GET', url: URL, headers: {} });
    httpMock.expectOne(URL).flush('gateway down', { status: 502, statusText: 'Bad Gateway' });
    expect((await done).text).toBe('gateway down');
  });

  it('rejects status 0 with a network TransportError carrying the original error as cause', async () => {
    const done = transport.request({ method: 'GET', url: URL, headers: {} }).catch(e => e);
    httpMock.expectOne(URL).error(new ProgressEvent('error'), { status: 0, statusText: 'Unknown Error' });
    const err = await done;
    expect(err).toBeInstanceOf(TransportError);
    expect(err.kind).toBe('network');
    expect(err.cause).toBeInstanceOf(HttpErrorResponse);
    expect(err.cause.status).toBe(0);
  });

  it('aborting the signal cancels the request and rejects with kind aborted', async () => {
    const controller = new AbortController();
    const done = transport.request({ method: 'GET', url: URL, headers: {}, signal: controller.signal }).catch(e => e);
    const req = httpMock.expectOne(URL);
    controller.abort();
    const err = await done;
    expect(req.cancelled).toBe(true);
    expect(err).toBeInstanceOf(TransportError);
    expect(err.kind).toBe('aborted');
  });

  it('rejects an already-aborted signal without issuing a request', async () => {
    const controller = new AbortController();
    controller.abort();
    const err = await transport.request({ method: 'GET', url: URL, headers: {}, signal: controller.signal }).catch(e => e);
    expect(err.kind).toBe('aborted');
    httpMock.expectNone(URL);
  });

  it('forwards upload progress to onUploadProgress and still resolves the response', async () => {
    const progress: Array<[number, number | undefined]> = [];
    const done = transport.request({
      method: 'POST', url: URL, headers: {}, body: '[1]',
      onUploadProgress: (loaded, total) => progress.push([loaded, total]),
    });
    const req = httpMock.expectOne(URL);
    expect(req.request.reportProgress).toBe(true);
    req.event({ type: HttpEventType.UploadProgress, loaded: 10, total: 40 });
    req.event({ type: HttpEventType.UploadProgress, loaded: 40, total: 40 });
    req.flush([{ id: 1 }]);
    expect((await done).status).toBe(200);
    expect(progress).toEqual([[10, 40], [40, 40]]);
  });

  it('aborting after the response has been delivered does nothing', async () => {
    const controller = new AbortController();
    const done = transport.request({ method: 'GET', url: URL, headers: {}, signal: controller.signal });
    httpMock.expectOne(URL).flush([]);
    await done;
    controller.abort();
    await settle();
  });
});

describe('fromCore', () => {
  it('does nothing until subscribed and runs again for each subscription', async () => {
    const run = vi.fn().mockResolvedValue(1);
    const obs = fromCore(run);
    expect(run).not.toHaveBeenCalled();
    await firstValueFrom(obs);
    await firstValueFrom(obs);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('calls run synchronously inside subscribe', async () => {
    let finish!: (v: number) => void;
    const run = vi.fn().mockReturnValue(new Promise<number>(r => (finish = r)));
    const sub = fromCore(run).subscribe();
    expect(run).toHaveBeenCalledTimes(1);
    sub.unsubscribe();
    finish(1);
    await settle();
  });

  it('emits once then completes', async () => {
    const seen: string[] = [];
    fromCore(() => Promise.resolve('v')).subscribe({ next: v => seen.push(`next:${v}`), complete: () => seen.push('complete') });
    await settle();
    expect(seen).toEqual(['next:v', 'complete']);
  });

  it('errors with the rejection', async () => {
    const boom = new Error('boom');
    await expect(firstValueFrom(fromCore(() => Promise.reject(boom)))).rejects.toBe(boom);
  });

  it('aborts the signal when unsubscribed before completion, and emits nothing', async () => {
    let signal!: AbortSignal;
    const gate = new Subject<void>();
    const seen: unknown[] = [];
    const sub = fromCore<number>(s => {
      signal = s;
      return firstValueFrom(gate).then(() => 1);
    }).subscribe(v => seen.push(v));
    expect(signal.aborted).toBe(false);
    sub.unsubscribe();
    expect(signal.aborted).toBe(true);
    gate.next();
    await settle();
    expect(seen).toEqual([]);
  });

  it('does not abort when unsubscribed after completion', async () => {
    let signal!: AbortSignal;
    const sub = fromCore(s => {
      signal = s;
      return Promise.resolve(1);
    }).subscribe();
    await settle();
    sub.unsubscribe();
    expect(signal.aborted).toBe(false);
  });
});

describe('fromCoreWithProgress', () => {
  it('delivers interim values while in flight, then the resolved value, then completes', async () => {
    let emit!: (v: number) => void;
    let resolve!: (v: number) => void;
    const result = firstValueFrom(
      fromCoreWithProgress<number>((_s, e) => {
        emit = e;
        return new Promise<number>(r => (resolve = r));
      }).pipe(toArray())
    );
    emit(10);
    emit(60);
    resolve(100);
    expect(await result).toEqual([10, 60, 100]);
  });

  it('aborts on early unsubscribe and ignores later interim values', async () => {
    let signal!: AbortSignal;
    let emit!: (v: number) => void;
    let finish!: (v: number) => void;
    const seen: number[] = [];
    const sub = fromCoreWithProgress<number>((s, e) => {
      signal = s;
      emit = e;
      return new Promise<number>(r => (finish = r));
    }).subscribe(v => seen.push(v));
    emit(1);
    sub.unsubscribe();
    emit(2);
    finish(3);
    await settle();
    expect(signal.aborted).toBe(true);
    expect(seen).toEqual([1]);
  });
});

describe('toLegacyError', () => {
  function dataClientError(init: { kind: 'http' | 'parse'; status: number; text: string; body?: unknown; headers?: Record<string, string> }) {
    return new DataClientError(
      init.kind,
      { status: init.status, statusText: 'Status', headers: init.headers ?? {}, text: init.text },
      init.body,
    );
  }

  it('returns the original HttpErrorResponse for a DataClientError that came through the transport', async () => {
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), provideHttpClient(withXhr()), provideHttpClientTesting()],
    });
    const transport = angularHttpTransport(TestBed.inject(HttpClient));
    const http = TestBed.inject(HttpTestingController);
    const pending = transport.request({ method: 'GET', url: URL, headers: {} });
    http.expectOne(URL).flush({ code: 'X' }, { status: 409, statusText: 'Conflict' });
    const res = await pending;
    const original = originalHttpError(res.headers)!;
    const legacy = toLegacyError(dataClientError({ kind: 'http', status: 409, text: res.text, body: { code: 'X' }, headers: res.headers }));
    expect(legacy).toBe(original);
    http.verify();
  });

  it('rebuilds an HttpErrorResponse with the parsed body when there is no original', () => {
    const legacy = toLegacyError(dataClientError({ kind: 'http', status: 400, text: '{"message":"m"}', body: { message: 'm' } })) as HttpErrorResponse;
    expect(legacy).toBeInstanceOf(HttpErrorResponse);
    expect(legacy.status).toBe(400);
    expect(legacy.error).toEqual({ message: 'm' });
  });

  it('rebuilds a plain-text error with the text as the body, and an empty one with null', () => {
    expect((toLegacyError(dataClientError({ kind: 'http', status: 502, text: 'down' })) as HttpErrorResponse).error).toBe('down');
    expect((toLegacyError(dataClientError({ kind: 'http', status: 502, text: '' })) as HttpErrorResponse).error).toBeNull();
  });

  it('rebuilds a parse failure the way HttpClient reports a bad 2xx body', () => {
    const legacy = toLegacyError(dataClientError({ kind: 'parse', status: 200, text: '<html>' })) as HttpErrorResponse;
    expect(legacy.status).toBe(200);
    expect(legacy.error).toEqual({ error: undefined, text: '<html>' });
  });

  it('maps a network TransportError to its cause, and leaves anything else alone', () => {
    const cause = new HttpErrorResponse({ status: 0 });
    expect(toLegacyError(new TransportError('network', 'x', { cause }))).toBe(cause);
    const aborted = new TransportError('aborted');
    expect(toLegacyError(aborted)).toBe(aborted);
    const plain = new Error('plain');
    expect(toLegacyError(plain)).toBe(plain);
  });
});
