/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient, withXhr } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { firstValueFrom } from 'rxjs';
import { SchemaService } from '../../services/schema.service';
import { EntityPropertyType, SchemaEntityProperty, SchemaEntityTable, StaticText } from '../../interfaces/entity';
import { provideTranslationTesting } from '../translation-testing';
import { loadRaw, Variant } from './golden-io';

export function typeName(t: EntityPropertyType): string {
  return EntityPropertyType[t] ?? `?${t}`;
}

export function configureHttpTesting(...extraProviders: any[]): HttpTestingController {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(withXhr()),
      provideHttpClientTesting(),
      provideTranslationTesting(),
      ...extraProviders,
    ],
  });
  return TestBed.inject(HttpTestingController);
}

export interface LoadedSchema {
  service: SchemaService;
  httpMock: HttpTestingController;
  tables: SchemaEntityTable[];
  props: SchemaEntityProperty[];
  staticText: StaticText[];
}

/** Flush every pending request whose URL contains `fragment` with a fresh clone of `body`. */
export function flushAll(httpMock: HttpTestingController, fragment: string, body: any): number {
  const reqs = httpMock.match(r => r.url.includes(fragment));
  reqs.forEach(r => r.flush(structuredClone(body)));
  return reqs.length;
}

/**
 * Boot the REAL SchemaService against a raw-fixture variant, the way the app
 * does at bootstrap: schema_entities + schema_properties + schema_m2m_properties
 * (getProperties) and static_text. Fixtures are deep-cloned on every flush
 * because getProperties() overwrites `type` on the objects it receives.
 */
export async function loadSchema(v: Variant, ...extraProviders: any[]): Promise<LoadedSchema> {
  const httpMock = configureHttpTesting(...extraProviders);
  const service = TestBed.inject(SchemaService);

  const props$ = firstValueFrom(service.getProperties());
  flushAll(httpMock, 'schema_entities', loadRaw(v, 'schema_entities'));
  flushAll(httpMock, 'schema_properties', loadRaw(v, 'schema_properties'));
  flushAll(httpMock, 'schema_m2m_properties', loadRaw(v, 'schema_m2m_properties'));
  const props = await props$;

  const tables = await firstValueFrom(service.getEntities());

  const st$ = firstValueFrom(service.getStaticText());
  flushAll(httpMock, 'static_text', loadRaw(v, 'static_text'));
  const staticText = await st$;

  return { service, httpMock, tables, props, staticText };
}
