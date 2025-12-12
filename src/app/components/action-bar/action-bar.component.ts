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

import {
  Component,
  signal,
  input,
  output,
  ElementRef,
  ViewChild,
  AfterViewInit,
  OnDestroy,
  NgZone,
  effect,
  ChangeDetectionStrategy
} from '@angular/core';
import { CommonModule } from '@angular/common';

/**
 * Represents a button in the action bar.
 * Used by both built-in actions (Edit, Delete, Payment) and entity actions.
 */
export interface ActionButton {
  /** Unique identifier for the button (e.g., 'edit', 'delete', 'action:approve') */
  id: string;
  /** Display label */
  label: string;
  /** Material icon name (optional) */
  icon?: string;
  /** DaisyUI button style class (e.g., 'btn-primary', 'btn-error') */
  style: string;
  /** Whether the button is disabled */
  disabled: boolean;
  /** Tooltip text (shown on hover) */
  tooltip?: string;
}

/**
 * Reusable action bar component with dynamic overflow detection.
 *
 * Features:
 * - Renders buttons horizontally with consistent styling
 * - Uses ResizeObserver to detect container width changes
 * - Moves overflow buttons to a "More" dropdown when space is limited
 * - All buttons can overflow (no fixed priority)
 *
 * @example
 * ```html
 * <app-action-bar
 *   [buttons]="actionButtons"
 *   (buttonClick)="onButtonClick($event)">
 * </app-action-bar>
 * ```
 */
@Component({
  selector: 'app-action-bar',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex gap-2 items-center" #container>
      <!-- Visible buttons -->
      @for (btn of visibleButtons(); track btn.id) {
        <button
          [class]="'btn btn-sm ' + btn.style"
          [disabled]="btn.disabled"
          [title]="btn.tooltip || ''"
          (click)="buttonClick.emit(btn.id)">
          @if (btn.icon) {
            <span class="material-symbols-outlined text-lg">{{btn.icon}}</span>
          }
          <span class="hidden sm:inline">{{btn.label}}</span>
          <span class="sm:hidden">{{btn.label}}</span>
        </button>
      }

      <!-- More dropdown (when overflow exists) -->
      @if (overflowButtons().length > 0) {
        <div class="dropdown dropdown-end">
          <button tabindex="0" class="btn btn-sm btn-ghost btn-outline">
            More
            <span class="material-symbols-outlined text-lg">expand_more</span>
          </button>
          <ul tabindex="0" class="dropdown-content menu bg-base-100 rounded-box shadow-lg z-10 w-56 p-2">
            @for (btn of overflowButtons(); track btn.id) {
              <li>
                <button
                  [disabled]="btn.disabled"
                  [class]="getDropdownItemClass(btn)"
                  [title]="btn.tooltip || ''"
                  (click)="onDropdownButtonClick(btn.id, $event)">
                  @if (btn.icon) {
                    <span class="material-symbols-outlined">{{btn.icon}}</span>
                  }
                  {{btn.label}}
                </button>
              </li>
            }
          </ul>
        </div>
      }
    </div>

    <!-- Hidden measurement container for calculating button widths -->
    <div class="absolute opacity-0 pointer-events-none flex gap-2" #measureContainer aria-hidden="true">
      @for (btn of buttons(); track btn.id) {
        <button [class]="'btn btn-sm ' + btn.style">
          @if (btn.icon) {
            <span class="material-symbols-outlined text-lg">{{btn.icon}}</span>
          }
          <span>{{btn.label}}</span>
        </button>
      }
    </div>
  `,
  styles: [`
    :host {
      display: block;
      position: relative;
    }
  `]
})
export class ActionBarComponent implements AfterViewInit, OnDestroy {
  /** Array of buttons to display */
  buttons = input.required<ActionButton[]>();

  /** Emits button ID when clicked */
  buttonClick = output<string>();

  @ViewChild('container') container!: ElementRef<HTMLElement>;
  @ViewChild('measureContainer') measureContainer!: ElementRef<HTMLElement>;

  /** Buttons that fit in the visible area */
  visibleButtons = signal<ActionButton[]>([]);

  /** Buttons that overflow into the dropdown */
  overflowButtons = signal<ActionButton[]>([]);

  private resizeObserver?: ResizeObserver;
  private buttonWidths: number[] = [];
  private initialized = false;

  constructor(private ngZone: NgZone) {
    // React to button changes
    effect(() => {
      const btns = this.buttons();
      if (this.initialized && btns.length > 0) {
        // Re-measure when buttons change
        this.measureAndCalculate();
      }
    });
  }

  ngAfterViewInit() {
    // Initial measurement after render
    requestAnimationFrame(() => {
      this.measureAndCalculate();
      this.initialized = true;

      // Watch for container resize
      this.resizeObserver = new ResizeObserver(() => {
        this.ngZone.run(() => this.calculateOverflow());
      });
      this.resizeObserver.observe(this.container.nativeElement);
    });
  }

  ngOnDestroy() {
    this.resizeObserver?.disconnect();
  }

  /**
   * Handle clicks from dropdown menu items.
   * Closes the dropdown after click.
   */
  onDropdownButtonClick(buttonId: string, event: Event): void {
    // Close the dropdown by removing focus
    const dropdown = (event.target as HTMLElement).closest('.dropdown');
    if (dropdown) {
      (dropdown.querySelector('[tabindex="0"]') as HTMLElement)?.blur();
    }
    this.buttonClick.emit(buttonId);
  }

  /**
   * Get CSS classes for dropdown menu items.
   * Applies a left border with the button's configured color for visual distinction.
   */
  getDropdownItemClass(btn: ActionButton): string {
    const baseClasses = 'border-l-4 rounded-l-none';
    const disabledClasses = btn.disabled ? 'opacity-50 cursor-not-allowed' : '';

    // Map button style to border color class
    // btn.style is like 'btn-primary', extract the color part
    const colorMap: Record<string, string> = {
      'btn-primary': 'border-l-primary',
      'btn-secondary': 'border-l-secondary',
      'btn-accent': 'border-l-accent',
      'btn-neutral': 'border-l-neutral',
      'btn-info': 'border-l-info',
      'btn-success': 'border-l-success',
      'btn-warning': 'border-l-warning',
      'btn-error': 'border-l-error',
      'btn-ghost': 'border-l-base-300',
    };

    const borderClass = colorMap[btn.style] || 'border-l-base-300';

    return `${baseClasses} ${borderClass} ${disabledClasses}`.trim();
  }

  /**
   * Measure button widths from the hidden measurement container
   * and then calculate overflow.
   */
  private measureAndCalculate(): void {
    if (!this.measureContainer?.nativeElement) {
      // Fallback: show all buttons if we can't measure
      this.visibleButtons.set(this.buttons());
      this.overflowButtons.set([]);
      return;
    }

    requestAnimationFrame(() => {
      const measureEl = this.measureContainer.nativeElement;
      const buttons = measureEl.querySelectorAll('button');
      this.buttonWidths = Array.from(buttons).map(btn => {
        const rect = btn.getBoundingClientRect();
        return rect.width + 8; // +8 for gap-2 (0.5rem = 8px)
      });
      this.calculateOverflow();
    });
  }

  /**
   * Calculate which buttons fit in the visible area
   * and which should overflow to the dropdown.
   */
  private calculateOverflow(): void {
    if (!this.container?.nativeElement) return;

    const containerWidth = this.container.nativeElement.getBoundingClientRect().width;
    const moreButtonWidth = 90; // Approximate width of "More ▼" button
    const allButtons = this.buttons();

    // If no buttons or no widths measured, show all
    if (allButtons.length === 0 || this.buttonWidths.length === 0) {
      this.visibleButtons.set(allButtons);
      this.overflowButtons.set([]);
      return;
    }

    let totalWidth = 0;
    let visibleCount = 0;

    for (let i = 0; i < allButtons.length; i++) {
      const buttonWidth = this.buttonWidths[i] || 100; // Fallback width
      const nextWidth = totalWidth + buttonWidth;

      // Check if this button would overflow
      // Reserve space for "More" button if there would be overflow
      const needsMoreButton = i < allButtons.length - 1;
      const availableWidth = containerWidth - (needsMoreButton ? moreButtonWidth : 0);

      if (nextWidth > availableWidth) {
        // This button and remaining go to overflow
        break;
      }

      totalWidth = nextWidth;
      visibleCount++;
    }

    // Edge case: always show at least one button if possible
    if (visibleCount === 0 && allButtons.length > 0) {
      visibleCount = 1;
    }

    // If all buttons fit, show all (no More dropdown)
    if (visibleCount >= allButtons.length) {
      this.visibleButtons.set(allButtons);
      this.overflowButtons.set([]);
    } else {
      this.visibleButtons.set(allButtons.slice(0, visibleCount));
      this.overflowButtons.set(allButtons.slice(visibleCount));
    }
  }
}
