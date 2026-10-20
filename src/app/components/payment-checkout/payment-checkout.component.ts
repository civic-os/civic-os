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

import { Component, signal, computed, inject, input, output, effect, untracked, ChangeDetectionStrategy, ViewChild, ElementRef, DestroyRef } from '@angular/core';
import { Subscription } from 'rxjs';

import { DataService } from '../../services/data.service';
import { getStripePublishableKey } from '../../config/runtime';
import { CosModalComponent } from '../cos-modal/cos-modal.component';
import { TranslatePipe } from '../../pipes/translate.pipe';

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
 *
 * Lifecycle: every timer, poll request and the mounted Payment Element belong to
 * one open session. Reloading (reopen, new paymentId), closing and destroying
 * all cancel them, so a closed modal never keeps polling, never mounts Stripe
 * into a detached node and never emits from a destroyed component.
 */
@Component({
  selector: 'app-payment-checkout',
  templateUrl: './payment-checkout.component.html',
  styleUrl: './payment-checkout.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CosModalComponent, TranslatePipe]
})
export class PaymentCheckoutComponent {
  private dataService = inject(DataService);
  private destroyRef = inject(DestroyRef);

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
  private paymentElement: any;

  // Pending async work of the current session (cancelled by cancelPendingWork)
  private pendingRequest?: Subscription;
  private pendingTimer?: ReturnType<typeof setTimeout>;
  private destroyed = false;

  constructor() {
    // Load payment data when the modal opens or paymentId changes; stop when it closes
    effect(() => {
      const open = this.isOpen();
      const paymentId = this.paymentId();
      untracked(() => {
        if (open && paymentId) {
          this.loadPaymentData();
        } else {
          this.cancelPendingWork();
          this.teardownStripe();
        }
      });
    });

    this.destroyRef.onDestroy(() => {
      this.destroyed = true;
      this.cancelPendingWork();
      this.teardownStripe();
    });
  }

  /**
   * Fetch payment transaction to get client_secret.
   * Polls until worker creates the PaymentIntent.
   * Restarts from scratch: a previous session's poll loop and Payment Element are discarded.
   */
  private loadPaymentData() {
    this.cancelPendingWork();
    this.teardownStripe();
    this.loading.set(true);
    this.error.set(undefined);

    this.pollPaymentStatus();
  }

  /** Schedule the next step of the current session (only one is ever pending). */
  private schedule(fn: () => void, ms: number) {
    clearTimeout(this.pendingTimer);
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = undefined;
      fn();
    }, ms);
  }

  /** Cancel the in-flight poll request and any scheduled poll, Stripe init or emit. */
  private cancelPendingWork() {
    clearTimeout(this.pendingTimer);
    this.pendingTimer = undefined;
    this.pendingRequest?.unsubscribe();
    this.pendingRequest = undefined;
  }

  /** Unmount and destroy the Payment Element and drop the Stripe instances. */
  private teardownStripe() {
    if (this.paymentElement) {
      try {
        this.paymentElement.unmount();
        this.paymentElement.destroy();
      } catch (err) {
        console.warn('[PaymentCheckout] Payment Element teardown failed:', err);
      }
    }
    this.paymentElement = null;
    this.elements = null;
    this.stripe = null;
  }

  /**
   * Poll payment status until client_secret is available.
   * Retries every 500ms for up to 30 seconds.
   */
  private pollPaymentStatus(attempt: number = 0, maxAttempts: number = 60) {
    // Fetch payment transaction from public.payment_transactions view
    // Include fee fields for breakdown display
    this.pendingRequest = this.dataService.getData({
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
            this.schedule(() => this.pollPaymentStatus(attempt + 1, maxAttempts), 500);
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
        this.schedule(() => this.initializeStripe(), 100);
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
    if (this.destroyed || !this.clientSecret() || !this.paymentElementRef) {
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
      this.paymentElement = this.elements.create('payment');
      this.paymentElement.mount(this.paymentElementRef.nativeElement);

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

      // Closed or navigated away while Stripe was confirming: nothing left to update
      if (this.destroyed) return;

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
    this.pendingRequest = this.dataService.getData({
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
          this.schedule(() => {
            console.log('[PaymentCheckout] Emitting paymentSuccess event', { paymentId: this.paymentId() });
            this.processing.set(false);
            this.paymentSuccess.emit(this.paymentId());
          }, 500);
          return;
        }

        // Status hasn't changed yet
        if (attempt < maxAttempts) {
          // Poll again in 1 second
          this.schedule(() => this.pollForPaymentSuccess(attempt + 1, maxAttempts), 1000);
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
    // Stop polling and clean up Stripe Elements
    this.cancelPendingWork();
    this.teardownStripe();
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
