/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient, withXhr } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { firstValueFrom } from 'rxjs';
import { DimensionService, SchemaDimension } from './dimension.service';
import { SchemaService } from './schema.service';
import { getPostgrestUrl } from '../config/runtime';
import { of } from 'rxjs';

const DIM: SchemaDimension = {
  dimension_key: 'program', display_name: 'Program', table_schema: 'public', table_name: 'programs',
  key_column: 'id', label_column: 'title', parent_column: 'parent_id', active_column: 'is_active',
  external_id_column: null, default_value_id: 1, hide_when_single: true, sort_order: 0,
};

describe('DimensionService', () => {
  let service: DimensionService;
  let http: HttpTestingController;
  const base = getPostgrestUrl();

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(), provideHttpClient(withXhr()), provideHttpClientTesting(),
        { provide: SchemaService, useValue: { getDimensions: () => of([DIM]) } },
      ],
    });
    service = TestBed.inject(DimensionService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('finds the registered dimension an FK points at, from the registry SchemaService loads', async () => {
    expect(await firstValueFrom(service.getDimensionFor({ join_schema: 'public', join_table: 'programs', join_column: 'id' }))).toEqual(DIM);
    expect(await firstValueFrom(service.getDimensionFor({ join_schema: 'public', join_table: 'sites', join_column: 'id' }))).toBeUndefined();
  });

  it('reads the rows aliased to one shape, ordered by label', async () => {
    const result = firstValueFrom(service.getOptions(DIM));
    http.expectOne(`${base}programs?select=id:id,label:title,parent_id:parent_id,active:is_active&order=title.asc,id.asc`)
      .flush([{ id: 1, label: 'General', parent_id: null, active: true }, { id: 2, label: null, parent_id: 1, active: false }]);
    expect(await result).toEqual([
      { id: 1, label: 'General', parent_id: null, active: true },
      { id: 2, label: '', parent_id: 1, active: false },
    ]);
  });

  it('orders siblings by the registry sort column, then label, then key', async () => {
    const result = firstValueFrom(service.getOptions({ ...DIM, sort_column: 'rank' }));
    http.expectOne(`${base}programs?select=id:id,label:title,parent_id:parent_id,active:is_active&order=rank.asc.nullslast,title.asc,id.asc`).flush([]);
    expect(await result).toEqual([]);
  });

  it('has no parent for a flat dimension, and no rows on an error', async () => {
    const result = firstValueFrom(service.getOptions({ ...DIM, parent_column: null }));
    http.expectOne(`${base}programs?select=id:id,label:title,active:is_active&order=title.asc,id.asc`).flush('no', { status: 403, statusText: 'Forbidden' });
    expect(await result).toEqual([]);
  });

  describe('getAncestorLabels', () => {
    const PROP = { join_schema: 'public', join_table: 'programs', join_column: 'id' };
    const ROWS = [
      { id: 1, label: 'General', parent_id: null, active: true },
      { id: 2, label: 'Youth', parent_id: 1, active: true },
      { id: 3, label: 'Teens', parent_id: 2, active: true },
    ];
    const optionsUrl = `${base}programs?select=id:id,label:title,parent_id:parent_id,active:is_active&order=title.asc,id.asc`;

    it('returns the ancestors root first from one flat request', async () => {
      const result = firstValueFrom(service.getAncestorLabels(PROP, 3));
      http.expectOne(optionsUrl).flush(ROWS);
      expect(await result).toEqual(['General', 'Youth']);
    });

    it('returns [] for a root or a row the caller cannot see', async () => {
      const root = firstValueFrom(service.getAncestorLabels(PROP, 1));
      http.expectOne(optionsUrl).flush(ROWS);
      expect(await root).toEqual([]);
      const hidden = firstValueFrom(service.getAncestorLabels(PROP, 99));
      http.expectOne(optionsUrl).flush(ROWS);
      expect(await hidden).toEqual([]);
    });

    it('makes no request for no value, a flat dimension or a column that is not a dimension', async () => {
      expect(await firstValueFrom(service.getAncestorLabels(PROP, null))).toEqual([]);
      expect(await firstValueFrom(service.getAncestorLabels({ ...PROP, join_table: 'sites' }, 1))).toEqual([]);
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [
          provideZonelessChangeDetection(), provideHttpClient(withXhr()), provideHttpClientTesting(),
          { provide: SchemaService, useValue: { getDimensions: () => of([{ ...DIM, parent_column: null }]) } },
        ],
      });
      const flat = TestBed.inject(DimensionService);
      http = TestBed.inject(HttpTestingController);
      expect(await firstValueFrom(flat.getAncestorLabels(PROP, 1))).toEqual([]);
    });
  });
});
