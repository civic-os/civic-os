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

import { Component, signal, computed, inject, input, output, effect, ChangeDetectionStrategy, ViewChild, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DataService } from '../../services/data.service';
import { getStripePublishableKey } from '../../config/runtime';
import { CosModalComponent } from '../cos-modal/cos-modal.component';

/**
 * Stripe instance (loaded from CDN)
 * @see https://docs.stripe.com/js
 */
declare const Stripe: any;

/**
 * PaymentCheckoutComponent - Stripe Payment Element modal
 *
 * Usage:
 * <app-payment-checkout
 *   [paymentId]="paymentId"
 *   [isOpen]="showCheckout"
 *   (paymentSuccess)="handleSuccess($event)"
 *   (close)="handleClose()">
 * </app-payment-checkout>
 *
 * Prerequisites:
 * - Stripe.js loaded in index.html: <script src="https://js.stripe.com/v3/"></script>
 * - Payment transaction created with status='pending_intent'
 * - River worker creates Stripe PaymentIntent and updates provider_client_secret
 *
 * Flow:
 * 1. Component receives paymentId
 * 2. Fetches payment transaction (includes client_secret)
 * 3. Initializes Stripe Elements with client_secret
 * 4. User enters payment details
 * 5. Confirms payment via Stripe.js
 * 6. Emits success/error events
 */
@Component({
  selector: 'app-payment-checkout',
  templateUrl: './payment-checkout.component.html',
  styleUrl: './payment-checkout.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, CosModalComponent]
})
export class PaymentCheckoutComponent {
  private dataService = inject(DataService);

  // Inputs
  paymentId = input.required<string>();
  isOpen = input<boolean>(false);

  // Outputs
  paymentSuccess = output<string>(); // Emits payment_id on success
  close = output<void>();

  // ViewChild for Stripe Elements mount point
  @ViewChild('paymentElement', { static: false }) paymentElementRef?: ElementRef;

  // State
  loading = signal(true);
  processing = signal(false);
  error = signal<string | undefined>(undefined);
  clientSecret = signal<string | undefined>(undefined);

  // Amount breakdown (for fee display)
  baseAmount = signal<number | undefined>(undefined);      // Original price
  processingFee = signal<number | undefined>(undefined);   // Processing fee
  totalAmount = signal<number | undefined>(undefined);     // Total charged to card

  // Computed: whether to show fee breakdown
  showFeeBreakdown = computed(() => (this.processingFee() ?? 0) > 0);

  // Legacy: keep amount for backward compatibility
  amount = computed(() => this.totalAmount());

  // Stripe instances
  private stripe: any;
  private elements: any;

  constructor() {
    // Effect to load payment data when paymentId or isOpen changes
    effect(() => {
      if (this.isOpen() && this.paymentId()) {
        this.loadPaymentData();
      }
    });
  }

  /**
   * Fetch payment transaction to get client_secret.
   * Polls until worker creates the PaymentIntent.
   */
  private loadPaymentData() {
    this.loading.set(true);
    this.error.set(undefined);

    this.pollPaymentStatus();
  }

  /**
   * Poll payment status until client_secret is available.
   * Retries every 500ms for up to 30 seconds.
   */
  private pollPaymentStatus(attempt: number = 0, maxAttempts: number = 60) {
    // Fetch payment transaction from public.payment_transactions view
    // Include fee fields for breakdown display
    this.dataService.getData({
      key: 'payment_transactions',
      fields: ['id', 'amount', 'processing_fee', 'total_amount', 'provider_client_secret', 'status'],
      entityId: this.paymentId()
    }).subscribe({
      next: (results) => {
        if (results.length === 0) {
          this.error.set('Payment not found');
          this.loading.set(false);
          return;
        }

        const payment = results[0] as any;

        // Check payment status
        if (payment.status === 'succeeded') {
          this.error.set('This payment has already been completed');
          this.loading.set(false);
          return;
        }

        if (payment.status === 'canceled' || payment.status === 'failed') {
          this.error.set(`Payment ${payment.status}. Please create a new payment.`);
          this.loading.set(false);
          return;
        }

        // Wait for client_secret from River worker
        if (!payment.provider_client_secret) {
          // Still waiting for worker to create PaymentIntent
          if (attempt < maxAttempts) {
            // Poll again in 500ms
            setTimeout(() => this.pollPaymentStatus(attempt + 1, maxAttempts), 500);
          } else {
            // Timeout after 30 seconds
            this.error.set('Payment initialization timed out. Please try again.');
            this.loading.set(false);
          }
          return;
        }

        // Success - client_secret is available
        this.clientSecret.set(payment.provider_client_secret);

        // Set amount breakdown for fee display
        this.baseAmount.set(payment.amount);
        this.processingFee.set(payment.processing_fee ?? 0);
        this.totalAmount.set(payment.total_amount ?? payment.amount);

        this.loading.set(false);

        // Initialize Stripe Elements (wait for view to render)
        setTimeout(() => this.initializeStripe(), 100);
      },
      error: (err) => {
        this.error.set('Failed to load payment information');
        this.loading.set(false);
      }
    });
  }

  /**
   * Initialize Stripe.js and mount Payment Element
   */
  private initializeStripe() {
    if (!this.clientSecret() || !this.paymentElementRef) {
      return;
    }

    // Check if Stripe.js is loaded
    if (typeof Stripe === 'undefined') {
      this.error.set('Stripe.js failed to load. Please refresh the page.');
      return;
    }

    try {
      // Initialize Stripe with publishable key from runtime config
      this.stripe = Stripe(getStripePublishableKey());

      // Create Elements instance
      this.elements = this.stripe.elements({
        clientSecret: this.clientSecret()
      });

      // Create and mount Payment Element
      const paymentElement = this.elements.create('payment');
      paymentElement.mount(this.paymentElementRef.nativeElement);

    } catch (err) {
      console.error('Stripe initialization error:', err);
      this.error.set('Failed to initialize payment form');
    }
  }

  /**
   * Handle payment submission
   */
  async handleSubmit() {
    if (!this.stripe || !this.elements) {
      this.error.set('Payment form not initialized');
      return;
    }

    this.processing.set(true);
    this.error.set(undefined);

    try {
      // Confirm payment with Stripe
      const { error, paymentIntent } = await this.stripe.confirmPayment({
        elements: this.elements,
        confirmParams: {
          // Return URL for redirect-based payment methods
          return_url: `${window.location.origin}/payment-success`,
        },
        redirect: 'if_required' // Only redirect if payment method requires it
      });

      if (error) {
        // Payment failed
        this.error.set(error.message || 'Payment failed');
        this.processing.set(false);
      } else if (paymentIntent && paymentIntent.status === 'succeeded') {
        // Payment succeeded in Stripe - now poll for database update
        // Webhook processing is async, so we need to wait for status change
        this.pollForPaymentSuccess();
      } else {
        // Payment requires additional action (3D Secure, etc.)
        // Stripe will handle the redirect
        this.processing.set(false);
      }
    } catch (err: any) {
      this.error.set(err.message || 'An unexpected error occurred');
      this.processing.set(false);
    }
  }

  /**
   * Poll for payment status change after successful Stripe confirmation.
   * Webhooks are async, so we need to wait for the database to update.
   * Polls for ANY status change (succeeded, failed, canceled).
   */
  private pollForPaymentSuccess(attempt: number = 0, maxAttempts: number = 15) {
    this.dataService.getData({
      key: 'payment_transactions',
      fields: ['id', 'status'],
      entityId: this.paymentId()
    }).subscribe({
      next: (results) => {
        if (results.length === 0) {
          // Payment not found - shouldn't happen
          this.error.set('Payment record not found');
          this.processing.set(false);
          return;
        }

        const payment = results[0] as any;

        // Check if status has changed from 'pending'
        if (payment.status !== 'pending' && payment.status !== 'pending_intent') {
          // Status changed! Wait 500ms to ensure database views are consistent,
          // then close modal and reload parent record
          // Could be: succeeded, failed, or canceled
          console.log('[PaymentCheckout] Payment status changed, emitting paymentSuccess after 500ms', { status: payment.status, paymentId: this.paymentId() });
          setTimeout(() => {
            console.log('[PaymentCheckout] Emitting paymentSuccess event', { paymentId: this.paymentId() });
            this.processing.set(false);
            this.paymentSuccess.emit(this.paymentId());
          }, 500);
          return;
        }

        // Status hasn't changed yet
        if (attempt < maxAttempts) {
          // Poll again in 1 second
          setTimeout(() => this.pollForPaymentSuccess(attempt + 1, maxAttempts), 1000);
        } else {
          // Timeout after 15 seconds
          // Payment succeeded in Stripe, webhook will update eventually
          console.warn('[PaymentCheckout] Webhook processing timeout - payment will update asynchronously');
          console.log('[PaymentCheckout] Emitting paymentSuccess event (timeout)', { paymentId: this.paymentId() });
          this.processing.set(false);
          this.paymentSuccess.emit(this.paymentId());
        }
      },
      error: (err) => {
        this.error.set('Failed to verify payment status');
        this.processing.set(false);
      }
    });
  }

  /**
   * Close modal
   */
  handleClose() {
    console.log('[PaymentCheckout] handleClose called - emitting close event');
    // Clean up Stripe Elements
    if (this.elements) {
      this.elements = null;
    }
    this.stripe = null;
    this.clientSecret.set(undefined);
    this.baseAmount.set(undefined);
    this.processingFee.set(undefined);
    this.totalAmount.set(undefined);
    this.error.set(undefined);
    this.loading.set(true);
    this.processing.set(false);

    console.log('[PaymentCheckout] Emitting close event');
    this.close.emit();
  }
}
