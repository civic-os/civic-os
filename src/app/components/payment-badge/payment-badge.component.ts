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

import { Component, input, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { PaymentValue } from '../../interfaces/entity';

/**
 * PaymentBadgeComponent - Displays payment status as a colored badge
 *
 * Renders a DaisyUI badge with:
 * - Color based on status (success/warning/error/ghost)
 * - Material icon representing status
 * - Payment display name or "No payment"
 *
 * Used by both DisplayPropertyComponent and EditPropertyComponent for consistent payment display.
 */
@Component({
  selector: 'app-payment-badge',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './payment-badge.component.html',
  styleUrl: './payment-badge.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class PaymentBadgeComponent {
  // Payment data from payments.transactions view (embedded in entity data)
  payment = input<PaymentValue | null>();
}
