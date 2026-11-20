/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable, catchError, map, of } from 'rxjs';
import { dimensionFor, type SchemaDimension } from '@civic-os/core';
import type { SchemaEntityProperty } from '../interfaces/entity';
import { getPostgrestUrl } from '../config/runtime';
import { SchemaService } from './schema.service';

export type { SchemaDimension };

/** One row of a dimension table, in the shape the tree select reads. */
export interface DimensionOption {
  id: number;
  label: string;
  parent_id: number | null;
  active: boolean;
}

/**
 * Rows of a registered dimension table (v0.86.0) for the Dimension property type's tree select. The registry
 * itself comes from SchemaService, which loads it with the properties. A dimension's rows are fetched each
 * time a control asks, so a newly added or retired row shows on the next form.
 */
@Injectable({ providedIn: 'root' })
export class DimensionService {
  private http = inject(HttpClient);
  private schema = inject(SchemaService);

  /** The registered dimension a property's FK points at, or undefined. */
  getDimensionFor(prop: Pick<SchemaEntityProperty, 'join_schema' | 'join_table' | 'join_column'>): Observable<SchemaDimension | undefined> {
    return this.schema.getDimensions().pipe(map(dimensions => dimensionFor(prop, dimensions)));
  }

  /**
   * Every row of the dimension table the caller can read (RLS applies), in sibling order: the registry's sort
   * column when set, then label, then key, requested from PostgREST (core's buildTree keeps input order within
   * siblings). Columns are aliased to one shape whatever the table names them; a flat dimension has no parent.
   */
  getOptions(dim: SchemaDimension): Observable<DimensionOption[]> {
    const select = [
      `id:${dim.key_column}`,
      `label:${dim.label_column}`,
      ...(dim.parent_column ? [`parent_id:${dim.parent_column}`] : []),
      `active:${dim.active_column}`,
    ].join(',');
    return this.http
      .get<Array<Omit<DimensionOption, 'parent_id'> & { parent_id?: number | null }>>(
        `${getPostgrestUrl()}${dim.table_name}?select=${select}&order=${[
          ...(dim.sort_column ? [`${dim.sort_column}.asc.nullslast`] : []),
          `${dim.label_column}.asc`,
          `${dim.key_column}.asc`,
        ].join(',')}`,
      )
      .pipe(
        map(rows => rows.map(r => ({ id: r.id, label: String(r.label ?? ''), parent_id: r.parent_id ?? null, active: r.active !== false }))),
        catchError(() => of([])),
      );
  }
}
