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

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { AdminFilesPage } from './admin-files.page';
import { AuthService } from '../../services/auth.service';
import { SchemaService } from '../../services/schema.service';
import { EntityPropertyType, FileReference } from '../../interfaces/entity';

describe('AdminFilesPage', () => {
  let component: AdminFilesPage;
  let fixture: ComponentFixture<AdminFilesPage>;
  let httpMock: HttpTestingController;
  let mockAuthService: jasmine.SpyObj<AuthService>;
  let mockSchemaService: jasmine.SpyObj<SchemaService>;

  function createMockFile(overrides: Partial<FileReference> = {}): FileReference {
    return {
      id: overrides.id ?? 'file-001',
      entity_type: overrides.entity_type ?? 'issues',
      entity_id: overrides.entity_id ?? '1',
      file_name: overrides.file_name ?? 'test.jpg',
      file_type: overrides.file_type ?? 'image/jpeg',
      file_size: overrides.file_size ?? 1024,
      s3_bucket: 'civic-os-files',
      s3_key_prefix: '',
      s3_original_key: overrides.s3_original_key ?? 'issues/1/original.jpg',
      s3_thumbnail_small_key: overrides.s3_thumbnail_small_key,
      s3_thumbnail_medium_key: overrides.s3_thumbnail_medium_key,
      s3_thumbnail_large_key: overrides.s3_thumbnail_large_key,
      thumbnail_status: overrides.thumbnail_status ?? 'not_applicable',
      thumbnail_error: overrides.thumbnail_error,
      property_name: overrides.property_name,
      created_at: overrides.created_at ?? '2026-03-18T10:00:00Z',
      updated_at: overrides.updated_at ?? '2026-03-18T10:00:00Z'
    };
  }

  beforeEach(async () => {
    mockAuthService = jasmine.createSpyObj('AuthService', ['hasPermission']);
    mockAuthService.hasPermission.and.returnValue(true);

    mockSchemaService = jasmine.createSpyObj('SchemaService', [
      'getEntities', 'getProperties', 'getEntity', 'getPropertiesForEntity'
    ]);
    mockSchemaService.getEntities.and.returnValue(of([
      { table_name: 'issues', display_name: 'Issues', sort_order: 1, description: null, search_fields: null, show_map: false, map_property_name: null, show_calendar: false, calendar_property_name: null, calendar_color_property: null, insert: true, select: true, update: true, delete: true },
      { table_name: 'staff_documents', display_name: 'Staff Documents', sort_order: 2, description: null, search_fields: null, show_map: false, map_property_name: null, show_calendar: false, calendar_property_name: null, calendar_color_property: null, insert: true, select: true, update: true, delete: true }
    ]));
    mockSchemaService.getProperties.and.returnValue(of([
      { table_name: 'issues', column_name: 'photo', display_name: 'Photo', type: EntityPropertyType.FileImage, sort_order: 1, data_type: 'uuid', udt_name: 'uuid', table_catalog: '', table_schema: 'public', column_default: '', is_nullable: false, character_maximum_length: 0, udt_schema: 'public', is_self_referencing: false, is_identity: false, is_generated: false, is_updatable: true, join_schema: 'metadata', join_table: 'files', join_column: 'id', geography_type: '', show_on_list: true, filterable: false },
      { table_name: 'staff_documents', column_name: 'resume', display_name: 'Resume', type: EntityPropertyType.FilePDF, sort_order: 1, data_type: 'uuid', udt_name: 'uuid', table_catalog: '', table_schema: 'public', column_default: '', is_nullable: false, character_maximum_length: 0, udt_schema: 'public', is_self_referencing: false, is_identity: false, is_generated: false, is_updatable: true, join_schema: 'metadata', join_table: 'files', join_column: 'id', geography_type: '', show_on_list: true, filterable: false },
      { table_name: 'staff_documents', column_name: 'status_id', display_name: 'Status', type: EntityPropertyType.ForeignKeyName, sort_order: 2, data_type: 'int4', udt_name: 'int4', table_catalog: '', table_schema: 'public', column_default: '', is_nullable: false, character_maximum_length: 0, udt_schema: 'public', is_self_referencing: false, is_identity: false, is_generated: false, is_updatable: true, join_schema: 'public', join_table: 'statuses', join_column: 'id', geography_type: '', show_on_list: true, filterable: true }
    ]));
    mockSchemaService.getEntity.and.returnValue(of(undefined));
    mockSchemaService.getPropertiesForEntity.and.returnValue(of([]));

    await TestBed.configureTestingModule({
      imports: [AdminFilesPage],
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: AuthService, useValue: mockAuthService },
        { provide: SchemaService, useValue: mockSchemaService }
      ]
    }).compileComponents();

    httpMock = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(AdminFilesPage);
    component = fixture.componentInstance;
  });

  afterEach(() => {
    httpMock.verify();
  });

  /**
   * Helper to flush all initial HTTP requests on component init.
   * AdminFilesPage makes: stats RPC + All Files mode query.
   * Must be called after fixture.detectChanges() to ensure ngOnInit fires.
   */
  function flushInitialRequests() {
    fixture.detectChanges();

    // Storage stats RPC
    const statsReq = httpMock.match(r => r.url.includes('rpc/get_file_storage_stats'));
    statsReq.forEach(req => req.flush([{ total_count: 42, total_size_bytes: 1048576 }]));

    // All Files mode initial query
    const filesReq = httpMock.match(r => r.url.includes('files') && !r.url.includes('rpc'));
    filesReq.forEach(req => req.flush([], {
      headers: { 'Content-Range': '0-0/0' }
    }));
  }

  it('should create', () => {
    expect(component).toBeTruthy();
    flushInitialRequests();
  });

  it('should load storage stats on init', () => {
    flushInitialRequests();

    expect(component.totalFileCount()).toBe(42);
    expect(component.totalFileSize()).toBe(1048576);
  });

  describe('Permission Gate', () => {
    it('should show error when no permission', () => {
      mockAuthService.hasPermission.and.returnValue(false);
      fixture = TestBed.createComponent(AdminFilesPage);
      component = fixture.componentInstance;

      expect(component.canViewFiles()).toBe(false);

      // Still need to flush initial requests
      const statsReq = httpMock.match(r => r.url.includes('rpc/get_file_storage_stats'));
      statsReq.forEach(req => req.flush([{ total_count: 0, total_size_bytes: 0 }]));
      const filesReq = httpMock.match(r => r.url.includes('files') && !r.url.includes('rpc'));
      filesReq.forEach(req => req.flush([]));
    });
  });

  describe('Entity Dropdown', () => {
    it('should show entities with file properties', () => {
      flushInitialRequests();

      const options = component.entityOptions();
      expect(options.length).toBe(2);
      expect(options.map(o => o.value)).toContain('issues');
      expect(options.map(o => o.value)).toContain('staff_documents');
    });
  });

  describe('formatFileSize', () => {
    it('should format bytes', () => {
      expect(component.formatFileSize(0)).toBe('0 B');
      expect(component.formatFileSize(512)).toBe('512 B');
    });

    it('should format kilobytes', () => {
      expect(component.formatFileSize(1024)).toBe('1.0 KB');
      expect(component.formatFileSize(2048)).toBe('2.0 KB');
    });

    it('should format megabytes', () => {
      expect(component.formatFileSize(1048576)).toBe('1.0 MB');
      expect(component.formatFileSize(5242880)).toBe('5.0 MB');
    });

    it('should format gigabytes', () => {
      expect(component.formatFileSize(1073741824)).toBe('1.0 GB');
    });
  });

  describe('getS3Url', () => {
    it('should construct S3 URL from key', () => {
      const url = component.getS3Url('issues/1/original.jpg');
      expect(url).toContain('issues/1/original.jpg');
    });
  });

  describe('getFileIcon', () => {
    it('should return image icon for images', () => {
      expect(component.getFileIcon('image/jpeg')).toBe('image');
      expect(component.getFileIcon('image/png')).toBe('image');
    });

    it('should return pdf icon for PDFs', () => {
      expect(component.getFileIcon('application/pdf')).toBe('picture_as_pdf');
    });

    it('should return video icon for videos', () => {
      expect(component.getFileIcon('video/mp4')).toBe('videocam');
    });

    it('should return default icon for unknown types', () => {
      expect(component.getFileIcon('application/octet-stream')).toBe('insert_drive_file');
    });
  });

  describe('getThumbnailUrl', () => {
    it('should return thumbnail URL when available', () => {
      const file = createMockFile({
        thumbnail_status: 'completed',
        s3_thumbnail_small_key: 'issues/1/thumb-small.jpg'
      });
      const url = component.getThumbnailUrl(file);
      expect(url).toContain('thumb-small.jpg');
    });

    it('should return null when no thumbnail', () => {
      const file = createMockFile({ thumbnail_status: 'pending' });
      expect(component.getThumbnailUrl(file)).toBeNull();
    });
  });

  describe('File Selection', () => {
    beforeEach(() => {
      flushInitialRequests();
    });

    it('should toggle file selection', () => {
      component.toggleFileSelection('file-001');
      expect(component.selectedFileIds().has('file-001')).toBe(true);

      component.toggleFileSelection('file-001');
      expect(component.selectedFileIds().has('file-001')).toBe(false);
    });

    it('should select all files', () => {
      component.files.set([
        createMockFile({ id: 'file-001' }),
        createMockFile({ id: 'file-002' })
      ]);

      component.toggleSelectAll();
      expect(component.selectedFileIds().size).toBe(2);

      component.toggleSelectAll();
      expect(component.selectedFileIds().size).toBe(0);
    });

    it('should check if all selected', () => {
      component.files.set([
        createMockFile({ id: 'file-001' }),
        createMockFile({ id: 'file-002' })
      ]);

      expect(component.isAllSelected()).toBe(false);

      component.selectedFileIds.set(new Set(['file-001', 'file-002']));
      expect(component.isAllSelected()).toBe(true);
    });
  });

  describe('Sorting', () => {
    beforeEach(() => {
      flushInitialRequests();
    });

    it('should return correct sort icon for active column', () => {
      component.sortColumn.set('file_size');
      component.sortDirection.set('asc');
      expect(component.getSortIcon('file_size')).toBe('arrow_upward');

      component.sortDirection.set('desc');
      expect(component.getSortIcon('file_size')).toBe('arrow_downward');
    });

    it('should return unfold_more for inactive columns', () => {
      component.sortColumn.set('created_at');
      expect(component.getSortIcon('file_name')).toBe('unfold_more');
    });
  });

  describe('All Files Mode Query Building', () => {
    beforeEach(() => {
      flushInitialRequests();
    });

    it('should build default query params', () => {
      const params = (component as any).buildAllFilesQueryParams();
      expect(params).toContain('select=*');
      expect(params).toContain('order=created_at.desc');
      expect(params).toContain('limit=25');
      expect(params).toContain('offset=0');
    });

    it('should include file type filter with wildcard', () => {
      component.currentFileTypeFilter.set('image/*');
      const params = (component as any).buildAllFilesQueryParams();
      expect(params).toContain('file_type=like.image/%');
    });

    it('should include file type filter exact match', () => {
      component.currentFileTypeFilter.set('application/pdf');
      const params = (component as any).buildAllFilesQueryParams();
      expect(params).toContain('file_type=eq.application/pdf');
    });

    it('should include date range filters', () => {
      component.currentDateFrom.set('2026-01-01');
      component.currentDateTo.set('2026-03-01');
      const params = (component as any).buildAllFilesQueryParams();
      expect(params).toContain('created_at=gte.2026-01-01T00:00:00Z');
      expect(params).toContain('created_at=lte.2026-03-01T23:59:59Z');
    });

    it('should include filename search', () => {
      component.currentSearch.set('report');
      const params = (component as any).buildAllFilesQueryParams();
      expect(params).toContain('file_name=ilike.*report*');
    });

    it('should not include empty filters', () => {
      component.currentFileTypeFilter.set('');
      component.currentDateFrom.set('');
      component.currentDateTo.set('');
      component.currentSearch.set('');
      const params = (component as any).buildAllFilesQueryParams();
      expect(params).not.toContain('file_type');
      expect(params).not.toContain('created_at=gte');
      expect(params).not.toContain('created_at=lte');
      expect(params).not.toContain('file_name=ilike');
    });
  });

  describe('Filter Params Parsing', () => {
    beforeEach(() => {
      flushInitialRequests();
    });

    it('should parse filter params from URL', () => {
      const filters = (component as any).parseFilterParams({
        f0_col: 'status_id',
        f0_op: 'eq',
        f0_val: '1'
      });
      expect(filters.length).toBe(1);
      expect(filters[0].column).toBe('status_id');
      expect(filters[0].operator).toBe('eq');
      expect(filters[0].value).toBe('1');
    });

    it('should parse in operator with array values', () => {
      const filters = (component as any).parseFilterParams({
        f0_col: 'status_id',
        f0_op: 'in',
        f0_val: '(1,2,3)'
      });
      expect(filters[0].operator).toBe('in');
      expect(filters[0].value).toEqual(['1', '2', '3']);
    });

    it('should parse multiple filters', () => {
      const filters = (component as any).parseFilterParams({
        f0_col: 'status_id',
        f0_op: 'eq',
        f0_val: '1',
        f1_col: 'priority',
        f1_op: 'gte',
        f1_val: '3'
      });
      expect(filters.length).toBe(2);
    });

    it('should return empty for no filter params', () => {
      const filters = (component as any).parseFilterParams({});
      expect(filters.length).toBe(0);
    });
  });

  describe('Entity Display Name', () => {
    beforeEach(() => {
      flushInitialRequests();
    });

    it('should use cached name in entity mode', () => {
      component.currentEntityType.set('issues');
      component.cachedEntityNames.set(new Map([['1', 'Pothole on Main St']]));

      const file = createMockFile({ entity_id: '1' });
      expect(component.getEntityDisplayName(file)).toBe('Pothole on Main St');
    });

    it('should fallback to entity_id when not in cache', () => {
      component.currentEntityType.set('issues');
      component.cachedEntityNames.set(new Map());

      const file = createMockFile({ entity_id: '99' });
      expect(component.getEntityDisplayName(file)).toBe('99');
    });

    it('should show entity type display name in all files mode', () => {
      component.currentEntityType.set('all');

      const file = createMockFile({ entity_type: 'issues' });
      expect(component.getEntityDisplayName(file)).toBe('Issues');
    });
  });

  describe('Entity Route', () => {
    beforeEach(() => {
      flushInitialRequests();
    });

    it('should return route to entity detail page', () => {
      const file = createMockFile({ entity_type: 'issues', entity_id: '42' });
      expect(component.getEntityRoute(file)).toEqual(['/view', 'issues', '42']);
    });
  });
});
