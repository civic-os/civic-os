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
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { StatusAdminService, StatusType, StatusValue, StatusTransition } from './status-admin.service';

describe('StatusAdminService', () => {
  let service: StatusAdminService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        StatusAdminService
      ]
    });

    service = TestBed.inject(StatusAdminService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  describe('getStatusEntityTypes', () => {
    it('should call the RPC and return status types', () => {
      const mockTypes: StatusType[] = [
        { entity_type: 'issues_status', display_name: 'Issue Status', description: 'Issue statuses', status_count: 4 }
      ];

      service.getStatusEntityTypes().subscribe(types => {
        expect(types).toEqual(mockTypes);
      });

      const req = httpMock.expectOne(r => r.url.includes('rpc/get_status_entity_types'));
      expect(req.request.method).toBe('POST');
      req.flush(mockTypes);
    });
  });

  describe('getStatusesForEntity', () => {
    it('should fetch statuses with correct query params', () => {
      const mockStatuses: StatusValue[] = [
        { id: 1, entity_type: 'issues_status', status_key: 'open', display_name: 'Open', description: null, color: '#22C55E', sort_order: 0, is_initial: true, is_terminal: false }
      ];

      service.getStatusesForEntity('issues_status').subscribe(statuses => {
        expect(statuses).toEqual(mockStatuses);
      });

      const req = httpMock.expectOne(r =>
        r.url.includes('statuses?entity_type=eq.issues_status&order=sort_order,display_name')
      );
      expect(req.request.method).toBe('GET');
      req.flush(mockStatuses);
    });
  });

  describe('upsertStatusType', () => {
    it('should call RPC with correct params', () => {
      service.upsertStatusType('test_status', 'Test status type', 'Test Status').subscribe(response => {
        expect(response.success).toBeTrue();
      });

      const req = httpMock.expectOne(r => r.url.includes('rpc/upsert_status_type'));
      expect(req.request.body).toEqual({
        p_entity_type: 'test_status',
        p_description: 'Test status type',
        p_display_name: 'Test Status'
      });
      req.flush({ success: true });
    });
  });

  describe('deleteStatusType', () => {
    it('should call RPC with entity type', () => {
      service.deleteStatusType('test_status').subscribe(response => {
        expect(response.success).toBeTrue();
      });

      const req = httpMock.expectOne(r => r.url.includes('rpc/delete_status_type'));
      expect(req.request.body).toEqual({ p_entity_type: 'test_status' });
      req.flush({ success: true });
    });
  });

  describe('upsertStatus', () => {
    it('should create a new status (no statusId)', () => {
      service.upsertStatus('issues_status', 'Closed', undefined, '#EF4444', 1, false, true).subscribe(response => {
        expect(response.success).toBeTrue();
      });

      const req = httpMock.expectOne(r => r.url.includes('rpc/upsert_status'));
      expect(req.request.body).toEqual({
        p_entity_type: 'issues_status',
        p_display_name: 'Closed',
        p_description: null,
        p_color: '#EF4444',
        p_sort_order: 1,
        p_is_initial: false,
        p_is_terminal: true,
        p_status_id: null
      });
      req.flush({ success: true, id: 5 });
    });

    it('should update an existing status', () => {
      service.upsertStatus('issues_status', 'Closed (Resolved)', undefined, '#EF4444', 1, false, true, 5).subscribe(response => {
        expect(response.success).toBeTrue();
      });

      const req = httpMock.expectOne(r => r.url.includes('rpc/upsert_status'));
      expect(req.request.body.p_status_id).toBe(5);
      req.flush({ success: true, id: 5 });
    });
  });

  describe('deleteStatus', () => {
    it('should call RPC with status ID', () => {
      service.deleteStatus(5).subscribe(response => {
        expect(response.success).toBeTrue();
      });

      const req = httpMock.expectOne(r => r.url.includes('rpc/delete_status'));
      expect(req.request.body).toEqual({ p_status_id: 5 });
      req.flush({ success: true });
    });

    it('should handle reference error', () => {
      service.deleteStatus(5).subscribe(response => {
        expect(response.success).toBeFalse();
        expect(response.error?.humanMessage).toContain('Cannot delete');
      });

      const req = httpMock.expectOne(r => r.url.includes('rpc/delete_status'));
      req.flush({ success: false, error: 'Cannot delete: 10 records reference this status' });
    });
  });

  describe('getTransitionsForEntity', () => {
    it('should call RPC and return transitions with joined data', () => {
      const mockTransitions: StatusTransition[] = [
        {
          id: 1, entity_type: 'issues_status',
          from_status_id: 1, from_display_name: 'Open', from_color: '#22C55E',
          to_status_id: 2, to_display_name: 'Closed', to_color: '#EF4444',
          on_transition_rpc: null, display_name: 'Close', description: null,
          sort_order: 0, is_enabled: true
        }
      ];

      service.getTransitionsForEntity('issues_status').subscribe(transitions => {
        expect(transitions).toEqual(mockTransitions);
        expect(transitions[0].from_display_name).toBe('Open');
        expect(transitions[0].to_display_name).toBe('Closed');
      });

      const req = httpMock.expectOne(r => r.url.includes('rpc/get_status_transitions_for_entity'));
      expect(req.request.body).toEqual({ p_entity_type: 'issues_status' });
      req.flush(mockTransitions);
    });
  });

  describe('upsertTransition', () => {
    it('should create a new transition', () => {
      service.upsertTransition('issues_status', 1, 2, undefined, 'Close', 'Close the issue').subscribe(response => {
        expect(response.success).toBeTrue();
      });

      const req = httpMock.expectOne(r => r.url.includes('rpc/upsert_status_transition'));
      expect(req.request.body).toEqual({
        p_entity_type: 'issues_status',
        p_from_status_id: 1,
        p_to_status_id: 2,
        p_on_transition_rpc: null,
        p_display_name: 'Close',
        p_description: 'Close the issue',
        p_sort_order: 0,
        p_is_enabled: true,
        p_transition_id: null
      });
      req.flush({ success: true, id: 1 });
    });

    it('should update an existing transition', () => {
      service.upsertTransition('issues_status', 1, 2, 'close_issue_rpc', 'Close', undefined, 0, true, 1).subscribe(response => {
        expect(response.success).toBeTrue();
      });

      const req = httpMock.expectOne(r => r.url.includes('rpc/upsert_status_transition'));
      expect(req.request.body.p_transition_id).toBe(1);
      expect(req.request.body.p_on_transition_rpc).toBe('close_issue_rpc');
      req.flush({ success: true, id: 1 });
    });
  });

  describe('deleteTransition', () => {
    it('should call RPC with transition ID', () => {
      service.deleteTransition(1).subscribe(response => {
        expect(response.success).toBeTrue();
      });

      const req = httpMock.expectOne(r => r.url.includes('rpc/delete_status_transition'));
      expect(req.request.body).toEqual({ p_transition_id: 1 });
      req.flush({ success: true });
    });
  });
});
