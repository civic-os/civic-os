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

import { Component, input, computed, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule, CurrencyPipe } from '@angular/common';
import { PaymentValue } from '../../interfaces/entity';

/**
 * PaymentBadgeComponent - Displays payment status as a colored badge
 *
 * Renders a DaisyUI badge with:
 * - Color based on status (success/warning/error/ghost)
 * - Material icon representing status
 * - Payment display name or "No payment"
 * - Tooltip for refunded/partially_refunded showing breakdown
 *
 * Used by both DisplayPropertyComponent and EditPropertyComponent for consistent payment display.
 */
@Component({
  selector: 'app-payment-badge',
  standalone: true,
  imports: [CommonModule],  // CurrencyPipe used programmatically in tooltip()
  templateUrl: './payment-badge.component.html',
  styleUrl: './payment-badge.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class PaymentBadgeComponent {
  // Payment data from payments.transactions view (embedded in entity data)
  payment = input<PaymentValue | null>();

  // CurrencyPipe for formatting amounts in tooltip
  private currencyPipe = new CurrencyPipe('en-US');

  /**
   * Computed tooltip text for refund statuses
   * Shows breakdown: "Refunded $X of $Y — $Z still charged" (partial)
   * or "Fully refunded $X" (full refund)
   * For multiple refunds, shows count: "Refunded $X (2 refunds) of $Y"
   */
  tooltip = computed(() => {
    const p = this.payment();
    if (!p) return '';

    const status = p.effective_status;
    if (status !== 'refunded' && status !== 'partially_refunded') {
      return '';
    }

    const amount = this.currencyPipe.transform(p.amount, p.currency, 'symbol', '1.2-2') || `$${p.amount}`;
    const refundedAmount = this.currencyPipe.transform(p.total_refunded, p.currency, 'symbol', '1.2-2') || `$${p.total_refunded}`;
    const refundCountNote = p.refund_count > 1 ? ` (${p.refund_count} refunds)` : '';

    if (status === 'partially_refunded') {
      const netAmount = p.amount - p.total_refunded;
      const netFormatted = this.currencyPipe.transform(netAmount, p.currency, 'symbol', '1.2-2') || `$${netAmount}`;
      return `Refunded ${refundedAmount}${refundCountNote} of ${amount} — ${netFormatted} still charged`;
    }

    return `Fully refunded ${amount}${refundCountNote}`;
  });

  /**
   * Whether to show tooltip (only for refund statuses)
   */
  hasTooltip = computed(() => {
    const status = this.payment()?.effective_status;
    return status === 'refunded' || status === 'partially_refunded';
  });

  /**
   * Display text for the badge
   * Overrides display_name for refund statuses to show accurate state
   * Shows NET amount for partial refunds (what's actually charged)
   */
  displayText = computed(() => {
    const p = this.payment();
    if (!p) return 'No payment';

    const status = p.effective_status;

    switch (status) {
      case 'refunded':
        // Full refund - no amount charged
        return 'Refunded';
      case 'partially_refunded':
        // Partial refund - show net amount (what's still charged)
        const netAmount = p.amount - p.total_refunded;
        const netFormatted = this.currencyPipe.transform(netAmount, p.currency, 'symbol', '1.2-2') || `$${netAmount}`;
        return `${netFormatted} - Partial Refund`;
      case 'refund_pending':
        // Refund is being processed
        return 'Refund Pending';
      default:
        // Use the database-generated display_name for other statuses
        return p.display_name || 'No payment';
    }
  });
}
