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

import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable, catchError, map, of } from 'rxjs';
import type { MenuNodeRow } from '@civic-os/core';
import { ApiError } from '../interfaces/api';
import { getPostgrestUrl } from '../config/runtime';
import { ErrorService } from './error.service';

/** Result of saving the menu tree: success, or a readable error. */
export interface SaveMenuResult {
  success: boolean;
  error?: string;
  /** Keys of stored entity nodes the save dropped because their table or view no longer exists. */
  skipped?: string[];
}

/**
 * I/O for the menu editor: reads the raw node list (never the app-wide cache, so the editor
 * starts from the server's current state) and replaces the whole tree through `save_menu_tree`.
 */
@Injectable({
  providedIn: 'root'
})
export class MenuAdminService {
  private http = inject(HttpClient);

  /**
   * The menu nodes as the database holds them. `display_name` is the untranslated label
   * (the view's `base_display_name`), so an admin working in another locale saves the base
   * label back, never a translation of it.
   */
  getNodes(): Observable<MenuNodeRow[]> {
    return this.http.get<(MenuNodeRow & { base_display_name: string | null })[]>(
      getPostgrestUrl() + 'schema_menu_nodes?select=*&order=node_key.asc'
    ).pipe(
      map(rows => rows.map(({ base_display_name, ...row }) => ({ ...row, display_name: base_display_name })))
    );
  }

  /** Replaces the whole tree. Never errors: failures come back as `{ success: false, error }`. */
  saveTree(nodes: readonly MenuNodeRow[]): Observable<SaveMenuResult> {
    return this.http.post<{ skipped?: unknown } | null>(getPostgrestUrl() + 'rpc/save_menu_tree', { p_nodes: nodes }).pipe(
      map((body): SaveMenuResult => {
        const skipped = Array.isArray(body?.skipped) ? body.skipped.filter((k): k is string => typeof k === 'string') : [];
        return skipped.length > 0 ? { success: true, skipped } : { success: true };
      }),
      catchError((error: HttpErrorResponse) => of<SaveMenuResult>({ success: false, error: this.humanize(error) }))
    );
  }

  private humanize(evt: HttpErrorResponse): string {
    const body = evt?.error && typeof evt.error === 'object' ? evt.error : null;
    const apiError: ApiError = {
      httpCode: evt?.status,
      code: body?.code,
      details: body?.details,
      hint: body?.hint,
      message: body?.message || evt?.statusText || 'Unknown error',
      humanMessage: ''
    };
    return ErrorService.parseToHuman(apiError);
  }
}
