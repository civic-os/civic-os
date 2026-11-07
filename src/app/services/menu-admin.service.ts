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
import { Observable, catchError, map, of, switchMap } from 'rxjs';
import type { MenuNodeRow } from '@civic-os/core';
import { ApiError } from '../interfaces/api';
import { getPostgrestUrl } from '../config/runtime';
import { ErrorService } from './error.service';

/** The stored tree and the menu version it was read at (null when the server reports none). */
export interface MenuSnapshot {
  nodes: MenuNodeRow[];
  version: string | null;
}

/** Result of saving the menu tree: success, or a readable error. */
export interface SaveMenuResult {
  success: boolean;
  error?: string;
  /** Someone saved the menu after the version this save was based on; nothing was written. */
  conflict?: boolean;
  /** Keys of stored entity nodes the save dropped because their table or view no longer exists. */
  skipped?: string[];
  /** The menu version after the save, to send with the next one. */
  version?: string;
}

/** SQLSTATE that save_menu_tree raises for a stale expected version (PostgREST answers 409). */
const STALE_MENU_CODE = 'PT409';

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
   * The menu nodes as the database holds them, with the menu version read just before them. Version
   * first: a save landing between the two reads leaves an older version with newer nodes, which can only
   * cost a needless conflict, never hide one. `display_name` is the untranslated label (the view's
   * `base_display_name`), so an admin working in another locale saves the base label back, never a
   * translation of it.
   */
  getNodes(): Observable<MenuSnapshot> {
    const base = getPostgrestUrl();
    return this.http.get<{ version: string | null }[]>(base + 'schema_cache_versions?select=version&cache_name=eq.menu').pipe(
      switchMap(versions =>
        this.http.get<(MenuNodeRow & { base_display_name: string | null })[]>(
          base + 'schema_menu_nodes?select=*&order=node_key.asc'
        ).pipe(
          map(rows => ({
            nodes: rows.map(({ base_display_name, ...row }) => ({ ...row, display_name: base_display_name })),
            version: versions[0]?.version ?? null
          }))
        )
      )
    );
  }

  /**
   * Replaces the whole tree, if the stored menu is still at `expectedVersion` (null skips the check).
   * Never errors: failures come back as `{ success: false, error }`, and a stale version as
   * `{ success: false, conflict: true }`.
   */
  saveTree(nodes: readonly MenuNodeRow[], expectedVersion: string | null): Observable<SaveMenuResult> {
    return this.http.post<{ skipped?: unknown; menu_version?: unknown } | null>(
      getPostgrestUrl() + 'rpc/save_menu_tree', { p_nodes: nodes, p_expected_version: expectedVersion }
    ).pipe(
      map((body): SaveMenuResult => {
        const skipped = Array.isArray(body?.skipped) ? body.skipped.filter((k): k is string => typeof k === 'string') : [];
        const version = typeof body?.menu_version === 'string' ? body.menu_version : undefined;
        return {
          success: true,
          ...(skipped.length > 0 ? { skipped } : {}),
          ...(version !== undefined ? { version } : {})
        };
      }),
      catchError((error: HttpErrorResponse) => of<SaveMenuResult>(
        // By code, not by status: PostgREST also answers 409 for unique and foreign key violations.
        error?.error?.code === STALE_MENU_CODE
          ? { success: false, conflict: true }
          : { success: false, error: this.humanize(error) }
      ))
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
