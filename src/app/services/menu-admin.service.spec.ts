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

  it('reads the nodes from schema_menu_nodes', async () => {
    const result = firstValueFrom(service.getNodes());
    const req = httpMock.expectOne(r => r.url.includes('schema_menu_nodes'));
    expect(req.request.method).toBe('GET');
    req.flush([{ ...NODE, base_display_name: null }]);
    expect(await result).toEqual([NODE]);
  });

  it('edits the untranslated label, not the one translated for the admin\'s locale', async () => {
    const result = firstValueFrom(service.getNodes());
    httpMock.expectOne(r => r.url.includes('schema_menu_nodes'))
      .flush([{ ...NODE, display_name: 'Problemas', base_display_name: 'Issues' }]);
    expect(await result).toEqual([{ ...NODE, display_name: 'Issues' }]);
  });

  it('posts the nodes to save_menu_tree as p_nodes', async () => {
    const result = firstValueFrom(service.saveTree([NODE]));
    const req = httpMock.expectOne(r => r.url.endsWith('rpc/save_menu_tree'));
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ p_nodes: [NODE] });
    req.flush({ nodes: 1 });
    expect(await result).toEqual({ success: true });
  });

  it('returns a readable error instead of throwing', async () => {
    const result = firstValueFrom(service.saveTree([NODE]));
    httpMock.expectOne(r => r.url.endsWith('rpc/save_menu_tree'))
      .flush({ message: 'Admin access required', code: '42501' }, { status: 403, statusText: 'Forbidden' });
    const value = await result;
    expect(value.success).toBe(false);
    expect(value.error).toBeTruthy();
  });
});
