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

import { Component, inject, signal, computed, ChangeDetectionStrategy } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { CommonModule, CurrencyPipe, DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { Router, RouterLink } from '@angular/router';
import { forkJoin, of, switchMap, map, catchError, BehaviorSubject } from 'rxjs';
import { NgxCurrencyDirective } from 'ngx-currency';
import { AuthService } from '../../services/auth.service';
import { getPostgrestUrl } from '../../config/runtime';

/**
 * Payment transaction from the payment_transactions view
 * Updated for 1:M refund support - uses aggregated refund data instead of single FK
 */
interface PaymentTransaction {
  id: string;
  user_id: string;
  user_display_name: string | null;
  user_full_name: string | null;  // Access-controlled: visible to admins/self
  user_email: string | null;
  amount: number;
  currency: string;
  status: string;
  effective_status: string;
  error_message: string | null;
  provider: string;
  provider_payment_id: string | null;  // pi_* for Stripe cross-reference
  description: string;
  display_name: string;
  created_at: string;
  updated_at: string;
  // Aggregated refund data (supports multiple refunds per transaction)
  total_refunded: number;
  refund_count: number;
  pending_refund_count: number;
  // Entity reference for linking
  entity_type: string | null;
  entity_id: string | null;
  entity_display_name: string | null;
}

/**
 * Refund detail for history modal
 */
interface RefundDetail {
  id: string;
  transaction_id: string;
  amount: number;
  reason: string;
  status: 'pending' | 'succeeded' | 'failed';
  provider_refund_id: string | null;  // re_* for Stripe cross-reference
  error_message: string | null;
  created_at: string;
  processed_at: string | null;
  initiated_by_name: string | null;
  payment_amount: number;
  payment_description: string;
  provider_payment_id: string | null;  // pi_* from parent transaction
}

/**
 * Refund form data
 */
interface RefundFormData {
  payment: PaymentTransaction;
  amount: number;
  reason: string;
}

/**
 * AdminPaymentsPage - System-wide payment management for administrators
 *
 * Features:
 * - View all payments across all users (requires payment_transactions:read permission)
 * - Initiate refunds (requires payment_refunds:create permission)
 * - Filter by effective_status (pending, succeeded, failed, refunded)
 * - Sort by date, amount, status
 */
@Component({
  selector: 'app-admin-payments',
  standalone: true,
  imports: [CommonModule, FormsModule, CurrencyPipe, DatePipe, RouterLink, NgxCurrencyDirective],
  templateUrl: './admin-payments.page.html',
  styleUrl: './admin-payments.page.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class AdminPaymentsPage {
  private http = inject(HttpClient);
  private auth = inject(AuthService);
  private router = inject(Router);

  // Permission checks
  canViewPayments = toSignal(
    this.auth.hasPermission('payment_transactions', 'read'),
    { initialValue: false }
  );

  canCreateRefunds = toSignal(
    this.auth.hasPermission('payment_refunds', 'create'),
    { initialValue: false }
  );

  // UI state
  loading = signal(true);
  error = signal<string | undefined>(undefined);
  successMessage = signal<string | undefined>(undefined);

  // Filter state
  statusFilter = signal<string>('all');
  searchQuery = signal<string>('');
  dateFrom = signal<string>('');  // YYYY-MM-DD format
  dateTo = signal<string>('');    // YYYY-MM-DD format

  // Pagination
  currentPage = signal(1);
  pageSize = signal(25);
  totalCount = signal(0);

  // Sorting
  sortColumn = signal<string>('created_at');
  sortDirection = signal<'asc' | 'desc'>('desc');

  // Data reload trigger
  private reloadTrigger = new BehaviorSubject<void>(undefined);

  // Refund modal state
  showRefundModal = signal(false);
  refundForm = signal<RefundFormData | null>(null);
  refundLoading = signal(false);
  refundError = signal<string | undefined>(undefined);

  // Refund history modal state
  showRefundHistoryModal = signal(false);
  refundHistoryPayment = signal<PaymentTransaction | null>(null);
  refundHistory = signal<RefundDetail[]>([]);
  refundHistoryLoading = signal(false);

  // Load payments data
  payments = toSignal(
    this.reloadTrigger.pipe(
      switchMap(() =>
        this.auth.hasPermission('payment_transactions', 'read').pipe(
          switchMap(hasPermission => {
            if (!hasPermission) {
              this.loading.set(false);
              this.error.set('You do not have permission to view payments');
              return of([]);
            }

            this.loading.set(true);
            this.error.set(undefined);

            // Build query params
            const params = this.buildQueryParams();

            return forkJoin({
              payments: this.http.get<PaymentTransaction[]>(
                `${getPostgrestUrl()}payment_transactions?${params}`,
                { headers: { 'Prefer': 'count=exact' }, observe: 'response' }
              ),
            }).pipe(
              map(({ payments }) => {
                // Extract total count from Content-Range header
                const contentRange = payments.headers.get('Content-Range');
                if (contentRange) {
                  const match = contentRange.match(/\/(\d+|\*)/);
                  if (match && match[1] !== '*') {
                    this.totalCount.set(parseInt(match[1], 10));
                  }
                }

                this.loading.set(false);
                return payments.body || [];
              }),
              catchError(err => {
                this.loading.set(false);
                this.error.set('Failed to load payments');
                console.error('Error loading payments:', err);
                return of([]);
              })
            );
          })
        )
      )
    ),
    { initialValue: [] }
  );

  // Computed values for pagination
  totalPages = computed(() => Math.ceil(this.totalCount() / this.pageSize()));
  hasNextPage = computed(() => this.currentPage() < this.totalPages());
  hasPrevPage = computed(() => this.currentPage() > 1);
  paginationEnd = computed(() => Math.min(this.currentPage() * this.pageSize(), this.totalCount()));
  paginationStart = computed(() => (this.currentPage() - 1) * this.pageSize() + 1);

  // Status options for filter
  // Human-readable status labels for filter dropdown
  statusOptions = [
    { value: 'all', label: 'All Statuses' },
    { value: 'succeeded', label: 'Paid' },
    { value: 'pending', label: 'Awaiting Payment' },
    { value: 'pending_intent', label: 'Processing' },
    { value: 'failed', label: 'Failed' },
    { value: 'canceled', label: 'Canceled' },
    { value: 'refund_pending', label: 'Refund Pending' },
    { value: 'refunded', label: 'Fully Refunded' },
    { value: 'partially_refunded', label: 'Partially Refunded' },
  ];

  /**
   * Build PostgREST query parameters
   */
  private buildQueryParams(): string {
    const params: string[] = [];

    // Select all fields
    params.push('select=*');

    // Status filter
    const status = this.statusFilter();
    if (status !== 'all') {
      params.push(`effective_status=eq.${status}`);
    }

    // Search query (searches description and user email via ILIKE pattern matching)
    // Note: This uses ILIKE wildcards, not full-text search. Acceptable for admin
    // page volumes but won't scale to millions of records.
    const search = this.searchQuery().trim();
    if (search) {
      params.push(`or=(description.ilike.*${search}*,user_email.ilike.*${search}*)`);
    }

    // Date range filter
    const fromDate = this.dateFrom();
    const toDate = this.dateTo();
    if (fromDate) {
      // Include payments from start of day (UTC)
      params.push(`created_at=gte.${fromDate}T00:00:00Z`);
    }
    if (toDate) {
      // Include payments until end of day (UTC)
      params.push(`created_at=lte.${toDate}T23:59:59Z`);
    }

    // Sorting
    const sortCol = this.sortColumn();
    const sortDir = this.sortDirection();
    params.push(`order=${sortCol}.${sortDir}`);

    // Pagination
    const page = this.currentPage();
    const size = this.pageSize();
    const offset = (page - 1) * size;
    params.push(`limit=${size}`);
    params.push(`offset=${offset}`);

    return params.join('&');
  }

  /**
   * Handle status filter change
   */
  onStatusFilterChange(status: string) {
    this.statusFilter.set(status);
    this.currentPage.set(1); // Reset to first page
    this.reloadTrigger.next();
  }

  /**
   * Handle date from filter change
   */
  onDateFromChange(date: string) {
    this.dateFrom.set(date);
    this.currentPage.set(1);
    this.reloadTrigger.next();
  }

  /**
   * Handle date to filter change
   */
  onDateToChange(date: string) {
    this.dateTo.set(date);
    this.currentPage.set(1);
    this.reloadTrigger.next();
  }

  /**
   * Handle search query change
   */
  onSearchChange(query: string) {
    this.searchQuery.set(query);
    this.currentPage.set(1);
    this.reloadTrigger.next();
  }

  /**
   * Refresh the current view
   */
  refresh() {
    this.reloadTrigger.next();
  }

  /**
   * Handle column sort
   */
  onSort(column: string) {
    if (this.sortColumn() === column) {
      // Toggle direction
      this.sortDirection.set(this.sortDirection() === 'asc' ? 'desc' : 'asc');
    } else {
      this.sortColumn.set(column);
      this.sortDirection.set('desc');
    }
    this.reloadTrigger.next();
  }

  /**
   * Get sort icon for column header
   */
  getSortIcon(column: string): string {
    if (this.sortColumn() !== column) return 'unfold_more';
    return this.sortDirection() === 'asc' ? 'arrow_upward' : 'arrow_downward';
  }

  /**
   * Handle pagination
   */
  goToPage(page: number) {
    if (page >= 1 && page <= this.totalPages()) {
      this.currentPage.set(page);
      this.reloadTrigger.next();
    }
  }

  nextPage() {
    if (this.hasNextPage()) {
      this.goToPage(this.currentPage() + 1);
    }
  }

  prevPage() {
    if (this.hasPrevPage()) {
      this.goToPage(this.currentPage() - 1);
    }
  }

  /**
   * Open refund modal for a payment
   */
  openRefundModal(payment: PaymentTransaction) {
    // Default to remaining refundable amount (considering previous refunds)
    const maxRefundable = payment.amount - payment.total_refunded;
    this.refundForm.set({
      payment,
      amount: maxRefundable,
      reason: ''
    });
    this.refundError.set(undefined);
    this.showRefundModal.set(true);
  }

  /**
   * Close refund modal
   */
  closeRefundModal() {
    this.showRefundModal.set(false);
    this.refundForm.set(null);
  }

  /**
   * Update refund amount in form
   */
  updateRefundAmount(amount: number) {
    const form = this.refundForm();
    if (form) {
      this.refundForm.set({ ...form, amount });
    }
  }

  /**
   * Update refund reason in form
   */
  updateRefundReason(reason: string) {
    const form = this.refundForm();
    if (form) {
      this.refundForm.set({ ...form, reason });
    }
  }

  /**
   * Submit refund request
   */
  submitRefund() {
    const form = this.refundForm();
    if (!form) return;

    // Calculate max refundable (payment amount minus already refunded)
    const maxRefundable = form.payment.amount - form.payment.total_refunded;

    // Validate
    if (form.amount <= 0) {
      this.refundError.set('Refund amount must be greater than 0');
      return;
    }
    if (form.amount > maxRefundable) {
      this.refundError.set(`Refund amount cannot exceed remaining balance ($${maxRefundable.toFixed(2)})`);
      return;
    }
    if (!form.reason.trim()) {
      this.refundError.set('Refund reason is required');
      return;
    }

    this.refundLoading.set(true);
    this.refundError.set(undefined);

    // Call the initiate_payment_refund RPC
    this.http.post(
      `${getPostgrestUrl()}rpc/initiate_payment_refund`,
      {
        p_payment_id: form.payment.id,
        p_amount: form.amount,
        p_reason: form.reason.trim()
      }
    ).subscribe({
      next: () => {
        this.refundLoading.set(false);
        this.showRefundModal.set(false);
        this.successMessage.set('Refund initiated successfully');

        // Reload payments to show updated status
        this.reloadTrigger.next();

        // Auto-dismiss success message after 5 seconds
        setTimeout(() => this.dismissSuccess(), 5000);
      },
      error: (err) => {
        this.refundLoading.set(false);
        const message = err.error?.message || err.error?.details || 'Failed to initiate refund';
        this.refundError.set(message);
        console.error('Refund error:', err);
      }
    });
  }

  /**
   * Dismiss success message
   */
  dismissSuccess() {
    this.successMessage.set(undefined);
  }

  /**
   * Check if a payment can be refunded
   * Requirements:
   * - Payment must have succeeded
   * - Payment cannot be fully refunded (effective_status !== 'refunded')
   * - No pending refunds (only one refund at a time)
   * - User must have permission to create refunds
   */
  canRefund(payment: PaymentTransaction): boolean {
    return payment.status === 'succeeded' &&
           payment.effective_status !== 'refunded' &&
           payment.pending_refund_count === 0 &&
           this.canCreateRefunds();
  }

  /**
   * Get badge class for effective status
   */
  getStatusBadgeClass(status: string): string {
    switch (status) {
      case 'succeeded':
        return 'badge-success';
      case 'pending':
      case 'pending_intent':
        return 'badge-warning';
      case 'failed':
        return 'badge-error';
      case 'canceled':
        return 'badge-ghost';
      case 'refunded':
        return 'badge-info';
      case 'partially_refunded':
        return 'badge-accent';
      default:
        return 'badge-ghost';
    }
  }

  /**
   * Get icon for effective status
   */
  getStatusIcon(status: string): string {
    switch (status) {
      case 'succeeded':
        return 'check_circle';
      case 'pending':
      case 'pending_intent':
        return 'schedule';
      case 'failed':
        return 'error';
      case 'canceled':
        return 'cancel';
      case 'refund_pending':
        return 'hourglass_top';
      case 'refunded':
      case 'partially_refunded':
        return 'undo';
      default:
        return 'help';
    }
  }

  /**
   * Get human-readable label for effective status
   */
  getStatusLabel(status: string): string {
    switch (status) {
      case 'succeeded':
        return 'Paid';
      case 'pending':
        return 'Awaiting Payment';
      case 'pending_intent':
        return 'Processing';
      case 'failed':
        return 'Failed';
      case 'canceled':
        return 'Canceled';
      case 'refund_pending':
        return 'Refund Pending';
      case 'refunded':
        return 'Refunded';
      case 'partially_refunded':
        return 'Partial Refund';
      default:
        return status;
    }
  }

  /**
   * Get route for entity link
   */
  getEntityRoute(payment: PaymentTransaction): string[] | null {
    if (!payment.entity_type || !payment.entity_id) {
      return null;
    }
    // Route to detail page: /view/{entity_type}/{entity_id}
    return ['/view', payment.entity_type, payment.entity_id];
  }

  /**
   * Navigate to the entity detail page
   */
  navigateToEntity(payment: PaymentTransaction): void {
    const route = this.getEntityRoute(payment);
    if (route) {
      this.router.navigate(route);
    }
  }

  /**
   * Open refund history modal for a payment
   * Loads refund details from the payment_refunds view
   */
  openRefundHistoryModal(payment: PaymentTransaction) {
    this.refundHistoryPayment.set(payment);
    this.refundHistory.set([]);
    this.refundHistoryLoading.set(true);
    this.showRefundHistoryModal.set(true);

    // Load refund history for this payment
    this.http.get<RefundDetail[]>(
      `${getPostgrestUrl()}payment_refunds?transaction_id=eq.${payment.id}&order=created_at.desc`
    ).subscribe({
      next: (refunds) => {
        this.refundHistory.set(refunds);
        this.refundHistoryLoading.set(false);
      },
      error: (err) => {
        console.error('Error loading refund history:', err);
        this.refundHistoryLoading.set(false);
      }
    });
  }

  /**
   * Close refund history modal
   */
  closeRefundHistoryModal() {
    this.showRefundHistoryModal.set(false);
    this.refundHistoryPayment.set(null);
    this.refundHistory.set([]);
  }
}
