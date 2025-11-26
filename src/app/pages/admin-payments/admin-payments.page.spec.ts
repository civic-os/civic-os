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

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { AdminPaymentsPage } from './admin-payments.page';
import { AuthService } from '../../services/auth.service';

describe('AdminPaymentsPage', () => {
  let component: AdminPaymentsPage;
  let fixture: ComponentFixture<AdminPaymentsPage>;
  let httpMock: HttpTestingController;
  let mockAuthService: jasmine.SpyObj<AuthService>;

  // Helper to create a mock payment
  function createMockPayment(overrides: Partial<{
    id: string;
    status: string;
    effective_status: string;
    amount: number;
    total_refunded: number;
    pending_refund_count: number;
    entity_type: string | null;
    entity_id: string | null;
  }> = {}) {
    return {
      id: overrides.id ?? 'pay_123',
      user_id: 'user_456',
      user_display_name: 'Test User',
      user_full_name: 'Test User Full',
      user_email: 'test@example.com',
      amount: overrides.amount ?? 100.00,
      currency: 'USD',
      status: overrides.status ?? 'succeeded',
      effective_status: overrides.effective_status ?? 'succeeded',
      error_message: null,
      provider: 'stripe',
      provider_payment_id: 'pi_test123',
      description: 'Test payment',
      display_name: '$100.00 USD',
      created_at: '2025-11-26T10:00:00Z',
      updated_at: '2025-11-26T10:00:00Z',
      total_refunded: overrides.total_refunded ?? 0,
      refund_count: 0,
      pending_refund_count: overrides.pending_refund_count ?? 0,
      entity_type: overrides.entity_type ?? null,
      entity_id: overrides.entity_id ?? null,
      entity_display_name: null
    };
  }

  beforeEach(async () => {
    mockAuthService = jasmine.createSpyObj('AuthService', ['hasPermission']);
    // Default to having permissions
    mockAuthService.hasPermission.and.returnValue(of(true));

    await TestBed.configureTestingModule({
      imports: [AdminPaymentsPage],
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: AuthService, useValue: mockAuthService }
      ]
    }).compileComponents();

    httpMock = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(AdminPaymentsPage);
    component = fixture.componentInstance;
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
    // Flush initial data request
    const req = httpMock.expectOne(r => r.url.includes('payment_transactions'));
    req.flush([]);
  });

  describe('Query Parameter Building', () => {
    beforeEach(() => {
      // Flush initial request
      const req = httpMock.expectOne(r => r.url.includes('payment_transactions'));
      req.flush([]);
    });

    it('should include default parameters', () => {
      // Access private method via any cast for testing
      const params = (component as any).buildQueryParams();

      expect(params).toContain('select=*');
      expect(params).toContain('order=created_at.desc');
      expect(params).toContain('limit=25');
      expect(params).toContain('offset=0');
    });

    it('should include status filter when not "all"', () => {
      component.statusFilter.set('succeeded');

      const params = (component as any).buildQueryParams();

      expect(params).toContain('effective_status=eq.succeeded');
    });

    it('should not include status filter when "all"', () => {
      component.statusFilter.set('all');

      const params = (component as any).buildQueryParams();

      expect(params).not.toContain('effective_status=eq.');
    });

    it('should include search query when provided', () => {
      component.searchQuery.set('test@example.com');

      const params = (component as any).buildQueryParams();

      expect(params).toContain('or=(description.ilike.*test@example.com*,user_email.ilike.*test@example.com*)');
    });

    it('should trim search query whitespace', () => {
      component.searchQuery.set('  test  ');

      const params = (component as any).buildQueryParams();

      expect(params).toContain('or=(description.ilike.*test*,user_email.ilike.*test*)');
    });

    it('should not include search when empty', () => {
      component.searchQuery.set('');

      const params = (component as any).buildQueryParams();

      expect(params).not.toContain('or=(description.ilike');
    });

    it('should include date from filter', () => {
      component.dateFrom.set('2025-01-01');

      const params = (component as any).buildQueryParams();

      expect(params).toContain('created_at=gte.2025-01-01T00:00:00Z');
    });

    it('should include date to filter', () => {
      component.dateTo.set('2025-12-31');

      const params = (component as any).buildQueryParams();

      expect(params).toContain('created_at=lte.2025-12-31T23:59:59Z');
    });

    it('should include both date filters for range', () => {
      component.dateFrom.set('2025-01-01');
      component.dateTo.set('2025-01-31');

      const params = (component as any).buildQueryParams();

      expect(params).toContain('created_at=gte.2025-01-01T00:00:00Z');
      expect(params).toContain('created_at=lte.2025-01-31T23:59:59Z');
    });

    it('should not include date filters when empty', () => {
      component.dateFrom.set('');
      component.dateTo.set('');

      const params = (component as any).buildQueryParams();

      expect(params).not.toContain('created_at=gte');
      expect(params).not.toContain('created_at=lte');
    });

    it('should handle custom sort column', () => {
      component.sortColumn.set('amount');
      component.sortDirection.set('asc');

      const params = (component as any).buildQueryParams();

      expect(params).toContain('order=amount.asc');
    });

    it('should calculate pagination offset correctly', () => {
      component.currentPage.set(3);
      component.pageSize.set(25);

      const params = (component as any).buildQueryParams();

      expect(params).toContain('offset=50'); // (3-1) * 25 = 50
    });
  });

  describe('Refund Eligibility (canRefund)', () => {
    beforeEach(() => {
      // Flush initial request
      const req = httpMock.expectOne(r => r.url.includes('payment_transactions'));
      req.flush([]);
    });

    it('should allow refund for succeeded payment with no refunds', () => {
      const payment = createMockPayment({
        status: 'succeeded',
        effective_status: 'succeeded',
        pending_refund_count: 0
      });

      expect(component.canRefund(payment)).toBe(true);
    });

    it('should allow refund for partially refunded payment', () => {
      const payment = createMockPayment({
        status: 'succeeded',
        effective_status: 'partially_refunded',
        total_refunded: 50,
        pending_refund_count: 0
      });

      expect(component.canRefund(payment)).toBe(true);
    });

    it('should NOT allow refund for fully refunded payment', () => {
      const payment = createMockPayment({
        status: 'succeeded',
        effective_status: 'refunded',
        total_refunded: 100,
        pending_refund_count: 0
      });

      expect(component.canRefund(payment)).toBe(false);
    });

    it('should NOT allow refund for pending payment', () => {
      const payment = createMockPayment({
        status: 'pending',
        effective_status: 'pending',
        pending_refund_count: 0
      });

      expect(component.canRefund(payment)).toBe(false);
    });

    it('should NOT allow refund for failed payment', () => {
      const payment = createMockPayment({
        status: 'failed',
        effective_status: 'failed',
        pending_refund_count: 0
      });

      expect(component.canRefund(payment)).toBe(false);
    });

    it('should NOT allow refund when another refund is pending', () => {
      const payment = createMockPayment({
        status: 'succeeded',
        effective_status: 'succeeded',
        pending_refund_count: 1
      });

      expect(component.canRefund(payment)).toBe(false);
    });

    it('should NOT allow refund without permission', () => {
      // Override permission to false
      mockAuthService.hasPermission.and.callFake((table: string, perm: string) => {
        if (table === 'payment_refunds' && perm === 'create') {
          return of(false);
        }
        return of(true);
      });

      // Create new fixture to pick up permission change
      fixture = TestBed.createComponent(AdminPaymentsPage);
      component = fixture.componentInstance;

      // Flush the new component's request
      const req = httpMock.expectOne(r => r.url.includes('payment_transactions'));
      req.flush([]);

      const payment = createMockPayment({
        status: 'succeeded',
        effective_status: 'succeeded',
        pending_refund_count: 0
      });

      expect(component.canRefund(payment)).toBe(false);
    });
  });

  describe('Status Badge Classes', () => {
    beforeEach(() => {
      const req = httpMock.expectOne(r => r.url.includes('payment_transactions'));
      req.flush([]);
    });

    it('should return badge-success for succeeded', () => {
      expect(component.getStatusBadgeClass('succeeded')).toBe('badge-success');
    });

    it('should return badge-warning for pending', () => {
      expect(component.getStatusBadgeClass('pending')).toBe('badge-warning');
    });

    it('should return badge-warning for pending_intent', () => {
      expect(component.getStatusBadgeClass('pending_intent')).toBe('badge-warning');
    });

    it('should return badge-error for failed', () => {
      expect(component.getStatusBadgeClass('failed')).toBe('badge-error');
    });

    it('should return badge-ghost for canceled', () => {
      expect(component.getStatusBadgeClass('canceled')).toBe('badge-ghost');
    });

    it('should return badge-info for refunded', () => {
      expect(component.getStatusBadgeClass('refunded')).toBe('badge-info');
    });

    it('should return badge-accent for partially_refunded', () => {
      expect(component.getStatusBadgeClass('partially_refunded')).toBe('badge-accent');
    });

    it('should return badge-ghost for unknown status', () => {
      expect(component.getStatusBadgeClass('unknown')).toBe('badge-ghost');
    });
  });

  describe('Status Icons', () => {
    beforeEach(() => {
      const req = httpMock.expectOne(r => r.url.includes('payment_transactions'));
      req.flush([]);
    });

    it('should return check_circle for succeeded', () => {
      expect(component.getStatusIcon('succeeded')).toBe('check_circle');
    });

    it('should return schedule for pending', () => {
      expect(component.getStatusIcon('pending')).toBe('schedule');
    });

    it('should return error for failed', () => {
      expect(component.getStatusIcon('failed')).toBe('error');
    });

    it('should return cancel for canceled', () => {
      expect(component.getStatusIcon('canceled')).toBe('cancel');
    });

    it('should return hourglass_top for refund_pending', () => {
      expect(component.getStatusIcon('refund_pending')).toBe('hourglass_top');
    });

    it('should return undo for refunded', () => {
      expect(component.getStatusIcon('refunded')).toBe('undo');
    });

    it('should return undo for partially_refunded', () => {
      expect(component.getStatusIcon('partially_refunded')).toBe('undo');
    });

    it('should return help for unknown status', () => {
      expect(component.getStatusIcon('unknown')).toBe('help');
    });
  });

  describe('Status Labels', () => {
    beforeEach(() => {
      const req = httpMock.expectOne(r => r.url.includes('payment_transactions'));
      req.flush([]);
    });

    it('should return "Paid" for succeeded', () => {
      expect(component.getStatusLabel('succeeded')).toBe('Paid');
    });

    it('should return "Awaiting Payment" for pending', () => {
      expect(component.getStatusLabel('pending')).toBe('Awaiting Payment');
    });

    it('should return "Processing" for pending_intent', () => {
      expect(component.getStatusLabel('pending_intent')).toBe('Processing');
    });

    it('should return "Failed" for failed', () => {
      expect(component.getStatusLabel('failed')).toBe('Failed');
    });

    it('should return "Canceled" for canceled', () => {
      expect(component.getStatusLabel('canceled')).toBe('Canceled');
    });

    it('should return "Refund Pending" for refund_pending', () => {
      expect(component.getStatusLabel('refund_pending')).toBe('Refund Pending');
    });

    it('should return "Refunded" for refunded', () => {
      expect(component.getStatusLabel('refunded')).toBe('Refunded');
    });

    it('should return "Partial Refund" for partially_refunded', () => {
      expect(component.getStatusLabel('partially_refunded')).toBe('Partial Refund');
    });

    it('should return status string for unknown status', () => {
      expect(component.getStatusLabel('custom_status')).toBe('custom_status');
    });
  });

  describe('Sorting', () => {
    beforeEach(() => {
      const req = httpMock.expectOne(r => r.url.includes('payment_transactions'));
      req.flush([]);
    });

    it('should toggle sort direction when clicking same column', () => {
      component.sortColumn.set('created_at');
      component.sortDirection.set('desc');

      component.onSort('created_at');

      // Expect a new request due to sort change
      const req = httpMock.expectOne(r => r.url.includes('payment_transactions'));
      req.flush([]);

      expect(component.sortDirection()).toBe('asc');
    });

    it('should set new column with desc direction', () => {
      component.sortColumn.set('created_at');
      component.sortDirection.set('desc');

      component.onSort('amount');

      const req = httpMock.expectOne(r => r.url.includes('payment_transactions'));
      req.flush([]);

      expect(component.sortColumn()).toBe('amount');
      expect(component.sortDirection()).toBe('desc');
    });

    it('should return correct sort icon for active column', () => {
      component.sortColumn.set('amount');
      component.sortDirection.set('asc');

      expect(component.getSortIcon('amount')).toBe('arrow_upward');

      component.sortDirection.set('desc');
      expect(component.getSortIcon('amount')).toBe('arrow_downward');
    });

    it('should return unfold_more for inactive columns', () => {
      component.sortColumn.set('amount');

      expect(component.getSortIcon('created_at')).toBe('unfold_more');
    });
  });

  describe('Filter Handlers', () => {
    beforeEach(() => {
      const req = httpMock.expectOne(r => r.url.includes('payment_transactions'));
      req.flush([]);
    });

    it('should reset to page 1 on status filter change', () => {
      component.currentPage.set(3);

      component.onStatusFilterChange('succeeded');

      const req = httpMock.expectOne(r => r.url.includes('payment_transactions'));
      req.flush([]);

      expect(component.statusFilter()).toBe('succeeded');
      expect(component.currentPage()).toBe(1);
    });

    it('should reset to page 1 on date from change', () => {
      component.currentPage.set(3);

      component.onDateFromChange('2025-01-01');

      const req = httpMock.expectOne(r => r.url.includes('payment_transactions'));
      req.flush([]);

      expect(component.dateFrom()).toBe('2025-01-01');
      expect(component.currentPage()).toBe(1);
    });

    it('should reset to page 1 on date to change', () => {
      component.currentPage.set(3);

      component.onDateToChange('2025-12-31');

      const req = httpMock.expectOne(r => r.url.includes('payment_transactions'));
      req.flush([]);

      expect(component.dateTo()).toBe('2025-12-31');
      expect(component.currentPage()).toBe(1);
    });

    it('should reset to page 1 on search change', () => {
      component.currentPage.set(3);

      component.onSearchChange('test query');

      const req = httpMock.expectOne(r => r.url.includes('payment_transactions'));
      req.flush([]);

      expect(component.searchQuery()).toBe('test query');
      expect(component.currentPage()).toBe(1);
    });
  });

  describe('Pagination Computed Values', () => {
    beforeEach(() => {
      const req = httpMock.expectOne(r => r.url.includes('payment_transactions'));
      req.flush([]);
    });

    it('should calculate total pages correctly', () => {
      component.totalCount.set(100);
      component.pageSize.set(25);

      expect(component.totalPages()).toBe(4);
    });

    it('should handle partial last page', () => {
      component.totalCount.set(101);
      component.pageSize.set(25);

      expect(component.totalPages()).toBe(5); // ceil(101/25) = 5
    });

    it('should indicate hasNextPage correctly', () => {
      component.totalCount.set(100);
      component.pageSize.set(25);
      component.currentPage.set(3);

      expect(component.hasNextPage()).toBe(true);

      component.currentPage.set(4);
      expect(component.hasNextPage()).toBe(false);
    });

    it('should indicate hasPrevPage correctly', () => {
      component.currentPage.set(1);
      expect(component.hasPrevPage()).toBe(false);

      component.currentPage.set(2);
      expect(component.hasPrevPage()).toBe(true);
    });

    it('should calculate pagination range correctly', () => {
      component.totalCount.set(100);
      component.pageSize.set(25);
      component.currentPage.set(2);

      expect(component.paginationStart()).toBe(26);
      expect(component.paginationEnd()).toBe(50);
    });

    it('should cap pagination end at total count', () => {
      component.totalCount.set(45);
      component.pageSize.set(25);
      component.currentPage.set(2);

      expect(component.paginationEnd()).toBe(45);
    });
  });

  describe('Refund Modal', () => {
    beforeEach(() => {
      const req = httpMock.expectOne(r => r.url.includes('payment_transactions'));
      req.flush([]);
    });

    it('should open refund modal with max refundable amount', () => {
      const payment = createMockPayment({
        amount: 100,
        total_refunded: 30
      });

      component.openRefundModal(payment);

      expect(component.showRefundModal()).toBe(true);
      expect(component.refundForm()?.amount).toBe(70); // 100 - 30
      expect(component.refundForm()?.payment).toBe(payment);
    });

    it('should close refund modal and clear form', () => {
      const payment = createMockPayment();
      component.openRefundModal(payment);

      component.closeRefundModal();

      expect(component.showRefundModal()).toBe(false);
      expect(component.refundForm()).toBeNull();
    });

    it('should update refund amount', () => {
      const payment = createMockPayment();
      component.openRefundModal(payment);

      component.updateRefundAmount(50);

      expect(component.refundForm()?.amount).toBe(50);
    });

    it('should update refund reason', () => {
      const payment = createMockPayment();
      component.openRefundModal(payment);

      component.updateRefundReason('Customer requested');

      expect(component.refundForm()?.reason).toBe('Customer requested');
    });

    it('should validate refund amount > 0', () => {
      const payment = createMockPayment();
      component.openRefundModal(payment);
      component.updateRefundAmount(0);
      component.updateRefundReason('Test');

      component.submitRefund();

      expect(component.refundError()).toBe('Refund amount must be greater than 0');
    });

    it('should validate refund amount not exceeding remaining', () => {
      const payment = createMockPayment({
        amount: 100,
        total_refunded: 50
      });
      component.openRefundModal(payment);
      component.updateRefundAmount(60); // Exceeds remaining 50
      component.updateRefundReason('Test');

      component.submitRefund();

      expect(component.refundError()).toContain('cannot exceed remaining balance');
    });

    it('should validate refund reason required', () => {
      const payment = createMockPayment();
      component.openRefundModal(payment);
      component.updateRefundAmount(50);
      component.updateRefundReason('');

      component.submitRefund();

      expect(component.refundError()).toBe('Refund reason is required');
    });

    it('should validate refund reason with whitespace only', () => {
      const payment = createMockPayment();
      component.openRefundModal(payment);
      component.updateRefundAmount(50);
      component.updateRefundReason('   ');

      component.submitRefund();

      expect(component.refundError()).toBe('Refund reason is required');
    });
  });

  describe('Entity Routing', () => {
    beforeEach(() => {
      const req = httpMock.expectOne(r => r.url.includes('payment_transactions'));
      req.flush([]);
    });

    it('should return route for payment with entity', () => {
      const payment = createMockPayment({
        entity_type: 'reservation_requests',
        entity_id: '123'
      });

      const route = component.getEntityRoute(payment);

      expect(route).toEqual(['/view', 'reservation_requests', '123']);
    });

    it('should return null for payment without entity', () => {
      const payment = createMockPayment({
        entity_type: null,
        entity_id: null
      });

      const route = component.getEntityRoute(payment);

      expect(route).toBeNull();
    });

    it('should return null when entity_type is set but entity_id is null', () => {
      const payment = createMockPayment({
        entity_type: 'reservation_requests',
        entity_id: null
      });

      const route = component.getEntityRoute(payment);

      expect(route).toBeNull();
    });
  });

  describe('Refresh', () => {
    beforeEach(() => {
      const req = httpMock.expectOne(r => r.url.includes('payment_transactions'));
      req.flush([]);
    });

    it('should trigger reload on refresh', () => {
      component.refresh();

      // Should trigger a new request
      const req = httpMock.expectOne(r => r.url.includes('payment_transactions'));
      req.flush([]);
    });
  });
});
