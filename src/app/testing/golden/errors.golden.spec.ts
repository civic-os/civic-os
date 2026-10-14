/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Golden outputs: ErrorService.parseToHuman / parseToHumanWithLookup over a
 * fixed PostgREST error-payload set, with each example's constraint_messages
 * loaded through the REAL SchemaService.getConstraintMessages(); and
 * DataService.parseApiError over HttpErrorResponse shapes.
 */
import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { ErrorService } from '../../services/error.service';
import { AnalyticsService } from '../../services/analytics.service';
import { SchemaService } from '../../services/schema.service';
import { DataService } from '../../services/data.service';
import { ApiError, ConstraintMessage } from '../../interfaces/api';
import { checkGolden, expectNoOrphans, listExamples, listVariants, loadRaw } from './golden-io';
import { configureHttpTesting, flushAll } from './schema-harness';

const stubAnalytics = { trackError: () => {}, trackEvent: () => {} };

function err(p: Partial<ApiError>): ApiError {
  return { humanMessage: '', message: '', ...p } as ApiError;
}

/** The fixed payload set (constraint-bearing payloads are expanded per example). */
function basePayloads(): ApiError[] {
  return [
    err({ httpCode: 0, message: 'Http failure response for http://x: 0 Unknown Error' }),
    err({ httpCode: 401, message: 'JWT expired', code: 'PGRST301' }),
    err({ httpCode: 401, message: 'Unauthorized' }),
    err({ httpCode: 404, message: 'Not Found' }),
    err({ httpCode: 403, code: '42501', message: 'permission denied for table x' }),
    err({ httpCode: 409, code: '23505', message: 'duplicate key value violates unique constraint "x_key"', details: 'Key (a)=(1) already exists.' }),
    err({ httpCode: 409, code: '23503', message: 'insert or update on table "x" violates foreign key constraint "x_fk"', details: 'Key (b)=(9) is not present in table "y".' }),
    err({ httpCode: 400, code: '23514', message: 'check violation' }),
    err({ httpCode: 409, code: '23P01', message: 'conflicting key value' }),
    err({ httpCode: 400, code: '23502', message: 'null value in column "c" violates not-null constraint' }),
    err({ httpCode: 400, code: '22P02', message: 'invalid input syntax for type integer: "abc"' }),
    err({ httpCode: 400, code: '22007', message: 'invalid input syntax for type date: "x"' }),
    err({ httpCode: 406, code: 'PGRST116', message: 'The result contains 0 rows', details: 'The result contains 0 rows' }),
    err({ httpCode: 401, code: 'PGRST301', message: 'No suitable key or wrong key type' }),
    err({ httpCode: 503, code: 'PT503', message: 'Maintenance mode' }),
    err({ httpCode: 400, code: 'P0001', message: 'Custom RAISE EXCEPTION text' }),
    err({ httpCode: 400, code: 'P0001' }),
    err({ httpCode: 400, message: 'Bad Request' }),
    err({ httpCode: 500, message: 'Internal Server Error' }),
    err({ message: 'no http code, no code' }),
    // precedence between httpCode and code
    err({ httpCode: 0, code: '42501' }),
    err({ httpCode: 404, code: '42501' }),
    err({ httpCode: 401, code: '23505' }),
    err({ httpCode: 404, code: 'P0001', message: 'raise' }),
    err({ httpCode: 401, code: 'P0001', message: 'raise' }),
  ];
}

function constraintPayloads(names: string[]): ApiError[] {
  const out: ApiError[] = [];
  for (const code of ['23514', '23P01']) {
    for (const name of names) {
      out.push(err({ httpCode: 400, code, message: `violates constraint "${name}"` }));
      out.push(err({ httpCode: 400, code, message: 'generic message', details: `Failing row violates constraint "${name}".` }));
    }
    // details take precedence over message
    out.push(err({ httpCode: 400, code, message: 'constraint "from_message"', details: 'constraint "from_details"' }));
    out.push(err({ httpCode: 400, code, message: 'constraint "" (empty name)' }));
    out.push(err({ httpCode: 400, code, details: 'constraint "only_details"' }));
  }
  return out;
}

describe('golden: ErrorService', () => {
  for (const example of listExamples()) {
    it(`${example}: parseToHuman and parseToHumanWithLookup with its constraint_messages`, async () => {
      const admin = listVariants(example).find(v => v.variant === 'testadmin')!;
      const httpMock = configureHttpTesting({ provide: AnalyticsService, useValue: stubAnalytics });
      const schema = TestBed.inject(SchemaService);
      const messages$ = firstValueFrom(schema.getConstraintMessages());
      flushAll(httpMock, 'constraint_messages', loadRaw(admin, 'constraint_messages'));
      const messages: ConstraintMessage[] = await messages$;

      const svc = TestBed.inject(ErrorService);
      const names = [...new Set(messages.map(m => m.constraint_name))].sort();
      const payloads = [...basePayloads(), ...constraintPayloads([...names, 'no_such_constraint'])];
      const results = payloads.map(p => ({
        payload: p,
        parseToHuman: ErrorService.parseToHuman(p),
        parseToHumanWithLookup: svc.parseToHumanWithLookup(p),
      }));
      // before constraint messages are loaded the lookup falls back
      (schema as any).constraintMessages = undefined;
      const unloaded = constraintPayloads(names.slice(0, 1)).slice(0, 2)
        .map(p => ({ payload: p, parseToHumanWithLookup: svc.parseToHumanWithLookup(p) }));
      checkGolden(`${example}/_example/errors.lookup.json`, { constraintMessages: messages, results, unloaded });
      httpMock.verify();
    });
  }

  it('DataService.parseApiError over HttpErrorResponse shapes', async () => {
    const httpMock = configureHttpTesting({ provide: AnalyticsService, useValue: stubAnalytics });
    const data = TestBed.inject(DataService);
    const mk = (init: any) => new HttpErrorResponse(init);
    const cases: Array<[string, HttpErrorResponse]> = [
      ['postgrest 23505', mk({ status: 409, statusText: 'Conflict', error: { code: '23505', message: 'duplicate key', details: 'Key exists', hint: null } })],
      ['postgrest 23514 constraint', mk({ status: 400, statusText: 'Bad Request', error: { code: '23514', message: 'violates check constraint "c1"', details: null, hint: 'h' } })],
      ['postgrest 42501', mk({ status: 403, statusText: 'Forbidden', error: { code: '42501', message: 'permission denied' } })],
      ['postgrest P0001', mk({ status: 400, statusText: 'Bad Request', error: { code: 'P0001', message: 'raised text' } })],
      ['postgrest no message', mk({ status: 400, statusText: 'Bad Request', error: { code: 'XX000' } })],
      ['postgrest no message no statusText', mk({ status: 500, error: { code: 'XX000' } })],
      ['string body', mk({ status: 502, statusText: 'Bad Gateway', error: '<html>bad gateway</html>' })],
      ['null body', mk({ status: 404, statusText: 'Not Found', error: null })],
      ['network error status 0', mk({ status: 0, statusText: 'Unknown Error', error: new ProgressEvent('error') })],
      ['401 empty', mk({ status: 401, statusText: 'Unauthorized', error: null })],
      ['503 PT503', mk({ status: 503, statusText: 'Service Unavailable', error: { code: 'PT503', message: 'maintenance' } })],
    ];
    const out: Record<string, unknown> = {};
    for (const [name, evt] of cases) out[name] = await firstValueFrom((data as any).parseApiError(evt));
    checkGolden('_shared/errors.data-parse-api-error.json', out);
    httpMock.verify();
  });

  it('no orphan errors.* golden files', () => {
    expectNoOrphans(rel => /\/errors\.[a-z-]+\.json$/.test(rel));
  });
});
