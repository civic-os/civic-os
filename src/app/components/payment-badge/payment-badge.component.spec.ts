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
import { By } from '@angular/platform-browser';
import { provideZonelessChangeDetection } from '@angular/core';
import { PaymentBadgeComponent } from './payment-badge.component';
import { PaymentValue } from '../../interfaces/entity';

describe('PaymentBadgeComponent', () => {
  let component: PaymentBadgeComponent;
  let fixture: ComponentFixture<PaymentBadgeComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [PaymentBadgeComponent],
      providers: [provideZonelessChangeDetection()]
    })
    .compileComponents();

    fixture = TestBed.createComponent(PaymentBadgeComponent);
    component = fixture.componentInstance;
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  // Helper to create PaymentValue with required fields
  function createPayment(overrides: Partial<PaymentValue> & { status: PaymentValue['status'] }): PaymentValue {
    const { status, effective_status, ...rest } = overrides;
    const amount = rest.amount ?? 50.00;
    return {
      id: 'pay_123',
      status: status,
      effective_status: effective_status ?? status, // Default to same as status
      amount: amount,
      processing_fee: 0,
      total_amount: amount,
      max_refundable: amount,
      fee_refundable: false,
      currency: 'USD',
      display_name: `$50.00 (${status})`,
      created_at: '2025-11-22T10:00:00Z',
      // Aggregated refund data (1:M support)
      total_refunded: 0,
      refund_count: 0,
      pending_refund_count: 0,
      ...rest
    };
  }

  describe('Succeeded Status', () => {
    it('should render green badge with check icon for succeeded payment', () => {
      const payment = createPayment({
        status: 'succeeded',
        display_name: '$50.00 (succeeded)'
      });

      fixture.componentRef.setInput('payment', payment);
      fixture.detectChanges();

      const badge = fixture.debugElement.query(By.css('.badge'));
      expect(badge).toBeTruthy();
      expect(badge.nativeElement.classList.contains('badge-success')).toBe(true);

      const icon = badge.query(By.css('.material-symbols-outlined'));
      expect(icon).toBeTruthy();
      expect(icon.nativeElement.textContent.trim()).toBe('check_circle');

      const textContent = badge.nativeElement.textContent.trim();
      expect(textContent).toContain('$50.00 (succeeded)');
    });

    it('should handle succeeded payment with error_message field (should be ignored)', () => {
      const payment = createPayment({
        status: 'succeeded',
        display_name: '$50.00 (succeeded)',
        error_message: 'Previous error' // Should be ignored for succeeded
      });

      fixture.componentRef.setInput('payment', payment);
      fixture.detectChanges();

      const badge = fixture.debugElement.query(By.css('.badge'));
      expect(badge.nativeElement.classList.contains('badge-success')).toBe(true);
    });
  });

  describe('Pending Statuses', () => {
    it('should render yellow badge with clock icon for pending payment', () => {
      const payment = createPayment({
        id: 'pay_456',
        status: 'pending',
        amount: 75.00,
        display_name: '$75.00 (pending)',
        provider_client_secret: 'pi_secret_123'
      });

      fixture.componentRef.setInput('payment', payment);
      fixture.detectChanges();

      const badge = fixture.debugElement.query(By.css('.badge'));
      expect(badge).toBeTruthy();
      expect(badge.nativeElement.classList.contains('badge-warning')).toBe(true);

      const icon = badge.query(By.css('.material-symbols-outlined'));
      expect(icon).toBeTruthy();
      expect(icon.nativeElement.textContent.trim()).toBe('schedule');

      const textContent = badge.nativeElement.textContent.trim();
      expect(textContent).toContain('$75.00 (pending)');
    });

    it('should render yellow badge with clock icon for pending_intent payment', () => {
      const payment = createPayment({
        id: 'pay_789',
        status: 'pending_intent',
        amount: 100.00,
        display_name: '$100.00 (pending_intent)'
      });

      fixture.componentRef.setInput('payment', payment);
      fixture.detectChanges();

      const badge = fixture.debugElement.query(By.css('.badge'));
      expect(badge.nativeElement.classList.contains('badge-warning')).toBe(true);

      const icon = badge.query(By.css('.material-symbols-outlined'));
      expect(icon.nativeElement.textContent.trim()).toBe('schedule');
    });
  });

  describe('Failed Status', () => {
    it('should render red badge with error icon for failed payment', () => {
      const payment = createPayment({
        id: 'pay_fail_123',
        status: 'failed',
        amount: 25.00,
        display_name: '$25.00 (failed)',
        error_message: 'Card declined'
      });

      fixture.componentRef.setInput('payment', payment);
      fixture.detectChanges();

      const badge = fixture.debugElement.query(By.css('.badge'));
      expect(badge).toBeTruthy();
      expect(badge.nativeElement.classList.contains('badge-error')).toBe(true);

      const icon = badge.query(By.css('.material-symbols-outlined'));
      expect(icon).toBeTruthy();
      expect(icon.nativeElement.textContent.trim()).toBe('error');

      const textContent = badge.nativeElement.textContent.trim();
      expect(textContent).toContain('$25.00 (failed)');
    });

    it('should handle failed payment without error_message', () => {
      const payment = createPayment({
        id: 'pay_fail_456',
        status: 'failed',
        amount: 30.00,
        display_name: '$30.00 (failed)'
      });

      fixture.componentRef.setInput('payment', payment);
      fixture.detectChanges();

      const badge = fixture.debugElement.query(By.css('.badge'));
      expect(badge.nativeElement.classList.contains('badge-error')).toBe(true);
    });
  });

  describe('Canceled Status', () => {
    it('should render gray badge with cancel icon for canceled payment', () => {
      const payment = createPayment({
        id: 'pay_cancel_123',
        status: 'canceled',
        amount: 60.00,
        display_name: '$60.00 (canceled)'
      });

      fixture.componentRef.setInput('payment', payment);
      fixture.detectChanges();

      const badge = fixture.debugElement.query(By.css('.badge'));
      expect(badge).toBeTruthy();
      expect(badge.nativeElement.classList.contains('badge-ghost')).toBe(true);

      const icon = badge.query(By.css('.material-symbols-outlined'));
      expect(icon).toBeTruthy();
      expect(icon.nativeElement.textContent.trim()).toBe('cancel');

      const textContent = badge.nativeElement.textContent.trim();
      expect(textContent).toContain('$60.00 (canceled)');
    });
  });

  describe('Refunded Statuses', () => {
    it('should render info badge with undo icon for refunded payment', () => {
      const payment = createPayment({
        status: 'succeeded',
        effective_status: 'refunded',
        display_name: '$50.00 (refunded)'
      });

      fixture.componentRef.setInput('payment', payment);
      fixture.detectChanges();

      const badge = fixture.debugElement.query(By.css('.badge'));
      expect(badge.nativeElement.classList.contains('badge-info')).toBe(true);

      const icon = badge.query(By.css('.material-symbols-outlined'));
      expect(icon.nativeElement.textContent.trim()).toBe('undo');
    });

    it('should render accent badge with undo icon for partially_refunded payment', () => {
      const payment = createPayment({
        status: 'succeeded',
        effective_status: 'partially_refunded',
        display_name: '$50.00 (partially refunded)'
      });

      fixture.componentRef.setInput('payment', payment);
      fixture.detectChanges();

      const badge = fixture.debugElement.query(By.css('.badge'));
      expect(badge.nativeElement.classList.contains('badge-accent')).toBe(true);

      const icon = badge.query(By.css('.material-symbols-outlined'));
      expect(icon.nativeElement.textContent.trim()).toBe('undo');
    });
  });

  describe('Null Payment Handling', () => {
    it('should show "No payment" for null payment value', () => {
      fixture.componentRef.setInput('payment', null);
      fixture.detectChanges();

      const badge = fixture.debugElement.query(By.css('.badge'));
      expect(badge).toBeTruthy();

      const textContent = badge.nativeElement.textContent.trim();
      expect(textContent).toContain('No payment');
    });

    it('should not have status-specific badge classes for null payment', () => {
      fixture.componentRef.setInput('payment', null);
      fixture.detectChanges();

      const badge = fixture.debugElement.query(By.css('.badge'));
      expect(badge.nativeElement.classList.contains('badge-success')).toBe(false);
      expect(badge.nativeElement.classList.contains('badge-warning')).toBe(false);
      expect(badge.nativeElement.classList.contains('badge-error')).toBe(false);
      expect(badge.nativeElement.classList.contains('badge-ghost')).toBe(false);
    });

    it('should not show icon for null payment', () => {
      fixture.componentRef.setInput('payment', null);
      fixture.detectChanges();

      const icon = fixture.debugElement.query(By.css('.material-symbols-outlined'));
      expect(icon).toBeFalsy();
    });
  });

  describe('Badge Structure and Styling', () => {
    it('should always render badge with gap-2 class', () => {
      const payment = createPayment({ status: 'succeeded' });

      fixture.componentRef.setInput('payment', payment);
      fixture.detectChanges();

      const badge = fixture.debugElement.query(By.css('.badge'));
      expect(badge.nativeElement.classList.contains('gap-2')).toBe(true);
    });

    it('should render badge with whitespace-normal class for text wrapping', () => {
      const payment = createPayment({ status: 'succeeded' });

      fixture.componentRef.setInput('payment', payment);
      fixture.detectChanges();

      const badge = fixture.debugElement.query(By.css('.badge'));
      expect(badge.nativeElement.classList.contains('whitespace-normal')).toBe(true);
    });

    it('should render badge with min-height for consistent sizing', () => {
      const payment = createPayment({ status: 'succeeded' });

      fixture.componentRef.setInput('payment', payment);
      fixture.detectChanges();

      const badge = fixture.debugElement.query(By.css('.badge'));
      expect(badge.nativeElement.classList.contains('h-auto')).toBe(true);
      expect(badge.nativeElement.classList.contains('min-h-[2rem]')).toBe(true);
    });

    it('should render icon with shrink-0 class to prevent icon distortion', () => {
      const payment = createPayment({ status: 'succeeded' });

      fixture.componentRef.setInput('payment', payment);
      fixture.detectChanges();

      const icon = fixture.debugElement.query(By.css('.material-symbols-outlined'));
      expect(icon.nativeElement.classList.contains('shrink-0')).toBe(true);
      expect(icon.nativeElement.classList.contains('text-xs')).toBe(true);
    });
  });

  describe('Currency and Amount Variations', () => {
    it('should handle large amount values', () => {
      const payment = createPayment({
        id: 'pay_large',
        status: 'succeeded',
        amount: 9999.99,
        display_name: '$9,999.99 (succeeded)'
      });

      fixture.componentRef.setInput('payment', payment);
      fixture.detectChanges();

      const textContent = fixture.nativeElement.textContent.trim();
      expect(textContent).toContain('$9,999.99');
    });

    it('should handle small amount values', () => {
      const payment = createPayment({
        id: 'pay_small',
        status: 'succeeded',
        amount: 0.01,
        display_name: '$0.01 (succeeded)'
      });

      fixture.componentRef.setInput('payment', payment);
      fixture.detectChanges();

      const textContent = fixture.nativeElement.textContent.trim();
      expect(textContent).toContain('$0.01');
    });

    it('should handle zero amount values', () => {
      const payment = createPayment({
        id: 'pay_zero',
        status: 'succeeded',
        amount: 0.00,
        display_name: '$0.00 (succeeded)'
      });

      fixture.componentRef.setInput('payment', payment);
      fixture.detectChanges();

      const textContent = fixture.nativeElement.textContent.trim();
      expect(textContent).toContain('$0.00');
    });

    it('should handle different currency codes in display_name', () => {
      const payment = createPayment({
        id: 'pay_eur',
        status: 'succeeded',
        currency: 'EUR',
        display_name: '€50.00 (succeeded)'
      });

      fixture.componentRef.setInput('payment', payment);
      fixture.detectChanges();

      const textContent = fixture.nativeElement.textContent.trim();
      expect(textContent).toContain('€50.00');
    });
  });

  describe('Edge Cases', () => {
    it('should handle payment with very long display_name', () => {
      const payment = createPayment({
        id: 'pay_long',
        status: 'succeeded',
        display_name: '$50.00 (succeeded) - This is a very long payment description that might wrap to multiple lines'
      });

      fixture.componentRef.setInput('payment', payment);
      fixture.detectChanges();

      const badge = fixture.debugElement.query(By.css('.badge'));
      const textContent = badge.nativeElement.textContent.trim();
      expect(textContent).toContain('very long payment description');
    });

    it('should handle payment with special characters in display_name', () => {
      const payment = createPayment({
        id: 'pay_special',
        status: 'succeeded',
        display_name: '$50.00 (succeeded) - Payment #12345 <Test>'
      });

      fixture.componentRef.setInput('payment', payment);
      fixture.detectChanges();

      const textContent = fixture.nativeElement.textContent.trim();
      expect(textContent).toContain('#12345');
    });

    it('should handle payment with empty display_name', () => {
      const payment = createPayment({
        id: 'pay_empty',
        status: 'succeeded',
        display_name: ''
      });

      fixture.componentRef.setInput('payment', payment);
      fixture.detectChanges();

      const badge = fixture.debugElement.query(By.css('.badge'));
      // Should still show the icon
      const icon = badge.query(By.css('.material-symbols-outlined'));
      expect(icon).toBeTruthy();
    });
  });

  describe('Status Validation', () => {
    it('should handle all valid payment statuses consistently', () => {
      const statuses: Array<PaymentValue['status']> = [
        'pending_intent', 'pending', 'succeeded', 'failed', 'canceled'
      ];

      statuses.forEach(status => {
        const payment = createPayment({
          id: `pay_${status}`,
          status: status,
          display_name: `$50.00 (${status})`
        });

        fixture.componentRef.setInput('payment', payment);
        fixture.detectChanges();

        const badge = fixture.debugElement.query(By.css('.badge'));
        expect(badge).toBeTruthy();

        const icon = badge.query(By.css('.material-symbols-outlined'));
        expect(icon).toBeTruthy();

        const textContent = badge.nativeElement.textContent.trim();
        expect(textContent).toContain(`$50.00 (${status})`);
      });
    });

    it('should handle all effective_status values correctly', () => {
      const effectiveStatuses: Array<PaymentValue['effective_status']> = [
        'pending_intent', 'pending', 'succeeded', 'failed', 'canceled', 'refunded', 'partially_refunded', 'refund_pending'
      ];

      effectiveStatuses.forEach(effectiveStatus => {
        const payment = createPayment({
          status: 'succeeded', // Original status preserved
          effective_status: effectiveStatus,
          display_name: `$50.00 (${effectiveStatus})`
        });

        fixture.componentRef.setInput('payment', payment);
        fixture.detectChanges();

        const badge = fixture.debugElement.query(By.css('.badge'));
        expect(badge).toBeTruthy();

        const icon = badge.query(By.css('.material-symbols-outlined'));
        expect(icon).toBeTruthy();
      });
    });
  });
});
