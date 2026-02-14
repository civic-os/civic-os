/**
 * Copyright (C) 2023-2025 Civic OS, L3C
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

import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, of } from 'rxjs';
import { getPostgrestUrl } from '../config/runtime';
import {
  SchemaFunction,
  SchemaTrigger,
  EntitySourceCodeResponse,
  SchemaRlsPolicy,
  ParsedSourceCode
} from '../interfaces/introspection';

@Injectable({
  providedIn: 'root'
})
export class IntrospectionService {
  private http = inject(HttpClient);

  /**
   * Fetch all visible functions with source code.
   * Visibility is permission-filtered by the schema_functions view.
   */
  getFunctions(): Observable<SchemaFunction[]> {
    return this.http.get<SchemaFunction[]>(
      getPostgrestUrl() + 'schema_functions?order=function_name'
    );
  }

  /**
   * Fetch all visible triggers with source code.
   * Visibility is permission-filtered by the schema_triggers view.
   */
  getTriggers(): Observable<SchemaTrigger[]> {
    return this.http.get<SchemaTrigger[]>(
      getPostgrestUrl() + 'schema_triggers?order=table_name,trigger_name'
    );
  }

  /**
   * Fetch all source code objects for a specific entity.
   * Uses the get_entity_source_code() RPC which returns permission-filtered results.
   */
  getEntitySourceCode(tableName: string): Observable<EntitySourceCodeResponse> {
    return this.http.post<EntitySourceCodeResponse>(
      getPostgrestUrl() + 'rpc/get_entity_source_code',
      { p_table_name: tableName }
    );
  }

  /**
   * Fetch pre-parsed ASTs for functions/views of a given entity.
   * Used by BlocklyViewer to render PL/pgSQL as visual blocks without client-side parsing.
   */
  getParsedSourceCode(objectNames: string[]): Observable<ParsedSourceCode[]> {
    if (objectNames.length === 0) return of([]);
    const filter = objectNames.map(n => `"${n}"`).join(',');
    return this.http.get<ParsedSourceCode[]>(
      getPostgrestUrl() + `parsed_source_code?object_name=in.(${filter})&select=object_name,object_type,language,ast_json,parse_error`
    );
  }

  /**
   * Fetch RLS policies (admin-only).
   * Optionally filter by table name.
   */
  getRlsPolicies(tableName?: string): Observable<SchemaRlsPolicy[]> {
    let url = getPostgrestUrl() + 'schema_rls_policies?order=table_name,policy_name';
    if (tableName) {
      url += `&table_name=eq.${tableName}`;
    }
    return this.http.get<SchemaRlsPolicy[]>(url);
  }
}
