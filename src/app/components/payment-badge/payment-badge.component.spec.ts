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

  describe('Succeeded Status', () => {
    it('should render green badge with check icon for succeeded payment', () => {
      const payment: PaymentValue = {
        id: 'pay_123',
        status: 'succeeded',
        amount: 50.00,
        currency: 'USD',
        display_name: '$50.00 (succeeded)',
        created_at: '2025-11-22T10:00:00Z'
      };

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
      const payment: PaymentValue = {
        id: 'pay_123',
        status: 'succeeded',
        amount: 50.00,
        currency: 'USD',
        display_name: '$50.00 (succeeded)',
        error_message: 'Previous error', // Should be ignored for succeeded
        created_at: '2025-11-22T10:00:00Z'
      };

      fixture.componentRef.setInput('payment', payment);
      fixture.detectChanges();

      const badge = fixture.debugElement.query(By.css('.badge'));
      expect(badge.nativeElement.classList.contains('badge-success')).toBe(true);
    });
  });

  describe('Pending Statuses', () => {
    it('should render yellow badge with clock icon for pending payment', () => {
      const payment: PaymentValue = {
        id: 'pay_456',
        status: 'pending',
        amount: 75.00,
        currency: 'USD',
        display_name: '$75.00 (pending)',
        provider_client_secret: 'pi_secret_123',
        created_at: '2025-11-22T10:00:00Z'
      };

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
      const payment: PaymentValue = {
        id: 'pay_789',
        status: 'pending_intent',
        amount: 100.00,
        currency: 'USD',
        display_name: '$100.00 (pending_intent)',
        created_at: '2025-11-22T10:00:00Z'
      };

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
      const payment: PaymentValue = {
        id: 'pay_fail_123',
        status: 'failed',
        amount: 25.00,
        currency: 'USD',
        display_name: '$25.00 (failed)',
        error_message: 'Card declined',
        created_at: '2025-11-22T10:00:00Z'
      };

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
      const payment: PaymentValue = {
        id: 'pay_fail_456',
        status: 'failed',
        amount: 30.00,
        currency: 'USD',
        display_name: '$30.00 (failed)',
        created_at: '2025-11-22T10:00:00Z'
      };

      fixture.componentRef.setInput('payment', payment);
      fixture.detectChanges();

      const badge = fixture.debugElement.query(By.css('.badge'));
      expect(badge.nativeElement.classList.contains('badge-error')).toBe(true);
    });
  });

  describe('Canceled Status', () => {
    it('should render gray badge with cancel icon for canceled payment', () => {
      const payment: PaymentValue = {
        id: 'pay_cancel_123',
        status: 'canceled',
        amount: 60.00,
        currency: 'USD',
        display_name: '$60.00 (canceled)',
        created_at: '2025-11-22T10:00:00Z'
      };

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
      const payment: PaymentValue = {
        id: 'pay_123',
        status: 'succeeded',
        amount: 50.00,
        currency: 'USD',
        display_name: '$50.00 (succeeded)',
        created_at: '2025-11-22T10:00:00Z'
      };

      fixture.componentRef.setInput('payment', payment);
      fixture.detectChanges();

      const badge = fixture.debugElement.query(By.css('.badge'));
      expect(badge.nativeElement.classList.contains('gap-2')).toBe(true);
    });

    it('should render badge with whitespace-normal class for text wrapping', () => {
      const payment: PaymentValue = {
        id: 'pay_123',
        status: 'succeeded',
        amount: 50.00,
        currency: 'USD',
        display_name: '$50.00 (succeeded)',
        created_at: '2025-11-22T10:00:00Z'
      };

      fixture.componentRef.setInput('payment', payment);
      fixture.detectChanges();

      const badge = fixture.debugElement.query(By.css('.badge'));
      expect(badge.nativeElement.classList.contains('whitespace-normal')).toBe(true);
    });

    it('should render badge with min-height for consistent sizing', () => {
      const payment: PaymentValue = {
        id: 'pay_123',
        status: 'succeeded',
        amount: 50.00,
        currency: 'USD',
        display_name: '$50.00 (succeeded)',
        created_at: '2025-11-22T10:00:00Z'
      };

      fixture.componentRef.setInput('payment', payment);
      fixture.detectChanges();

      const badge = fixture.debugElement.query(By.css('.badge'));
      expect(badge.nativeElement.classList.contains('h-auto')).toBe(true);
      expect(badge.nativeElement.classList.contains('min-h-[2rem]')).toBe(true);
    });

    it('should render icon with shrink-0 class to prevent icon distortion', () => {
      const payment: PaymentValue = {
        id: 'pay_123',
        status: 'succeeded',
        amount: 50.00,
        currency: 'USD',
        display_name: '$50.00 (succeeded)',
        created_at: '2025-11-22T10:00:00Z'
      };

      fixture.componentRef.setInput('payment', payment);
      fixture.detectChanges();

      const icon = fixture.debugElement.query(By.css('.material-symbols-outlined'));
      expect(icon.nativeElement.classList.contains('shrink-0')).toBe(true);
      expect(icon.nativeElement.classList.contains('text-xs')).toBe(true);
    });
  });

  describe('Currency and Amount Variations', () => {
    it('should handle large amount values', () => {
      const payment: PaymentValue = {
        id: 'pay_large',
        status: 'succeeded',
        amount: 9999.99,
        currency: 'USD',
        display_name: '$9,999.99 (succeeded)',
        created_at: '2025-11-22T10:00:00Z'
      };

      fixture.componentRef.setInput('payment', payment);
      fixture.detectChanges();

      const textContent = fixture.nativeElement.textContent.trim();
      expect(textContent).toContain('$9,999.99');
    });

    it('should handle small amount values', () => {
      const payment: PaymentValue = {
        id: 'pay_small',
        status: 'succeeded',
        amount: 0.01,
        currency: 'USD',
        display_name: '$0.01 (succeeded)',
        created_at: '2025-11-22T10:00:00Z'
      };

      fixture.componentRef.setInput('payment', payment);
      fixture.detectChanges();

      const textContent = fixture.nativeElement.textContent.trim();
      expect(textContent).toContain('$0.01');
    });

    it('should handle zero amount values', () => {
      const payment: PaymentValue = {
        id: 'pay_zero',
        status: 'succeeded',
        amount: 0.00,
        currency: 'USD',
        display_name: '$0.00 (succeeded)',
        created_at: '2025-11-22T10:00:00Z'
      };

      fixture.componentRef.setInput('payment', payment);
      fixture.detectChanges();

      const textContent = fixture.nativeElement.textContent.trim();
      expect(textContent).toContain('$0.00');
    });

    it('should handle different currency codes in display_name', () => {
      const payment: PaymentValue = {
        id: 'pay_eur',
        status: 'succeeded',
        amount: 50.00,
        currency: 'EUR',
        display_name: '€50.00 (succeeded)',
        created_at: '2025-11-22T10:00:00Z'
      };

      fixture.componentRef.setInput('payment', payment);
      fixture.detectChanges();

      const textContent = fixture.nativeElement.textContent.trim();
      expect(textContent).toContain('€50.00');
    });
  });

  describe('Edge Cases', () => {
    it('should handle payment with very long display_name', () => {
      const payment: PaymentValue = {
        id: 'pay_long',
        status: 'succeeded',
        amount: 50.00,
        currency: 'USD',
        display_name: '$50.00 (succeeded) - This is a very long payment description that might wrap to multiple lines',
        created_at: '2025-11-22T10:00:00Z'
      };

      fixture.componentRef.setInput('payment', payment);
      fixture.detectChanges();

      const badge = fixture.debugElement.query(By.css('.badge'));
      const textContent = badge.nativeElement.textContent.trim();
      expect(textContent).toContain('very long payment description');
    });

    it('should handle payment with special characters in display_name', () => {
      const payment: PaymentValue = {
        id: 'pay_special',
        status: 'succeeded',
        amount: 50.00,
        currency: 'USD',
        display_name: '$50.00 (succeeded) - Payment #12345 <Test>',
        created_at: '2025-11-22T10:00:00Z'
      };

      fixture.componentRef.setInput('payment', payment);
      fixture.detectChanges();

      const textContent = fixture.nativeElement.textContent.trim();
      expect(textContent).toContain('#12345');
    });

    it('should handle payment with empty display_name', () => {
      const payment: PaymentValue = {
        id: 'pay_empty',
        status: 'succeeded',
        amount: 50.00,
        currency: 'USD',
        display_name: '',
        created_at: '2025-11-22T10:00:00Z'
      };

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
      const statuses: Array<'pending_intent' | 'pending' | 'succeeded' | 'failed' | 'canceled'> = [
        'pending_intent', 'pending', 'succeeded', 'failed', 'canceled'
      ];

      statuses.forEach(status => {
        const payment: PaymentValue = {
          id: `pay_${status}`,
          status: status,
          amount: 50.00,
          currency: 'USD',
          display_name: `$50.00 (${status})`,
          created_at: '2025-11-22T10:00:00Z'
        };

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
  });
});
