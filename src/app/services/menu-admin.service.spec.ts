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
import { provideHttpClient, withXhr } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { firstValueFrom } from 'rxjs';
import type { MenuNodeRow } from '@civic-os/core';
import { MenuAdminService } from './menu-admin.service';

const NODE: MenuNodeRow = {
  node_key: 'issues', node_kind: 'entity', target_key: 'issues', display_name: null, icon: null,
  parent_node_key: null, sort_order: 0, is_hidden: false, collapsed_by_default: false,
};

describe('MenuAdminService', () => {
  let service: MenuAdminService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), provideHttpClient(withXhr()), provideHttpClientTesting(), MenuAdminService]
    });
    service = TestBed.inject(MenuAdminService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  const VERSION = '2026-11-07T15:00:00.123456+00:00';

  /** Answers the version read; the nodes read must not have started before it. */
  function flushVersion(version: string | null = VERSION) {
    httpMock.expectNone(r => r.url.includes('schema_menu_nodes'));
    const req = httpMock.expectOne(r => r.url.includes('schema_cache_versions'));
    expect(req.request.method).toBe('GET');
    expect(req.request.urlWithParams).toContain('cache_name=eq.menu');
    req.flush(version === null ? [] : [{ version }]);
  }

  it('reads the menu version first, then the nodes from schema_menu_nodes', async () => {
    const result = firstValueFrom(service.getNodes());
    flushVersion();
    const req = httpMock.expectOne(r => r.url.includes('schema_menu_nodes'));
    expect(req.request.method).toBe('GET');
    req.flush([{ ...NODE, base_display_name: null }]);
    expect(await result).toEqual({ nodes: [NODE], version: VERSION });
  });

  it('reports no version when the server has no menu row', async () => {
    const result = firstValueFrom(service.getNodes());
    flushVersion(null);
    httpMock.expectOne(r => r.url.includes('schema_menu_nodes')).flush([]);
    expect(await result).toEqual({ nodes: [], version: null });
  });

  it('edits the untranslated label, not the one translated for the admin\'s locale', async () => {
    const result = firstValueFrom(service.getNodes());
    flushVersion();
    httpMock.expectOne(r => r.url.includes('schema_menu_nodes'))
      .flush([{ ...NODE, display_name: 'Problemas', base_display_name: 'Issues' }]);
    expect((await result).nodes).toEqual([{ ...NODE, display_name: 'Issues' }]);
  });

  it('posts the nodes and the expected version to save_menu_tree, and returns the new version', async () => {
    const result = firstValueFrom(service.saveTree([NODE], VERSION));
    const req = httpMock.expectOne(r => r.url.endsWith('rpc/save_menu_tree'));
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ p_nodes: [NODE], p_expected_version: VERSION });
    req.flush({ nodes: 1, skipped: [], menu_version: '2026-11-07T15:01:00+00:00' });
    expect(await result).toEqual({ success: true, version: '2026-11-07T15:01:00+00:00' });
  });

  it('sends a null expected version as null (the server skips the check)', async () => {
    const result = firstValueFrom(service.saveTree([NODE], null));
    const req = httpMock.expectOne(r => r.url.endsWith('rpc/save_menu_tree'));
    expect(req.request.body).toEqual({ p_nodes: [NODE], p_expected_version: null });
    req.flush({ nodes: 1 });
    expect(await result).toEqual({ success: true });
  });

  it('maps a stale version (PT409) to a conflict', async () => {
    const result = firstValueFrom(service.saveTree([NODE], VERSION));
    httpMock.expectOne(r => r.url.endsWith('rpc/save_menu_tree')).flush(
      { code: 'PT409', message: 'The menu was changed by someone else since it was loaded', hint: 'Reload the menu' },
      { status: 409, statusText: 'Conflict' }
    );
    expect(await result).toEqual({ success: false, conflict: true });
  });

  it('keeps other 409s (a duplicate key) as errors, not conflicts', async () => {
    const result = firstValueFrom(service.saveTree([NODE], VERSION));
    httpMock.expectOne(r => r.url.endsWith('rpc/save_menu_tree')).flush(
      { code: '23505', message: 'duplicate key value violates unique constraint "menu_nodes_pkey"' },
      { status: 409, statusText: 'Conflict' }
    );
    const value = await result;
    expect(value.conflict).toBeUndefined();
    expect(value.success).toBe(false);
    expect(value.error).toBeTruthy();
  });

  it('passes through the keys a save skipped', async () => {
    const result = firstValueFrom(service.saveTree([NODE], VERSION));
    httpMock.expectOne(r => r.url.endsWith('rpc/save_menu_tree')).flush({ nodes: 0, skipped: ['issues', 7] });
    expect(await result).toEqual({ success: true, skipped: ['issues'] });
  });

  it('returns a readable error instead of throwing', async () => {
    const result = firstValueFrom(service.saveTree([NODE], VERSION));
    httpMock.expectOne(r => r.url.endsWith('rpc/save_menu_tree'))
      .flush({ message: 'Admin access required', code: '42501' }, { status: 403, statusText: 'Forbidden' });
    const value = await result;
    expect(value.success).toBe(false);
    expect(value.error).toBeTruthy();
  });
});
