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

import { ChangeDetectionStrategy, Component, computed, input, model, signal } from '@angular/core';
import { TranslatePipe } from '../../pipes/translate.pipe';

/** How the hover tooltip lines up with the button: centered, or flush with its start or end edge. */
export type HelpTipAlign = 'center' | 'start' | 'end';

/** Margin kept between the hover tooltip and the viewport edge, in px. */
const EDGE = 16;
/** DaisyUI's tooltip max-width (20rem). */
const TIP_MAX = 320;

/**
 * The (?) help button next to a page title or a field label (issue #130).
 *
 * A toggletip: a real button that shows or hides a description the parent renders in the page flow
 * (`[hidden]="!open()"`, with the id passed as `panelId`). It works with touch, mouse and keyboard, and
 * screen readers hear its state (`aria-expanded`). On devices whose primary input hovers with a fine
 * pointer, hovering also shows the description as a tooltip; its alignment is chosen on hover so it stays
 * inside the viewport (a tooltip centered on an icon near the edge widened the page at phone width).
 *
 * Usage:
 *   <app-help-toggletip [text]="d" [subject]="name" panelId="x-help" [(open)]="helpOpen" />
 *   <div id="x-help" [hidden]="!helpOpen()">{{ d }}</div>
 */
@Component({
  selector: 'app-help-toggletip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslatePipe],
  host: { class: 'relative inline-flex align-middle' },
  template: `
    <button type="button"
      class="btn btn-ghost btn-circle btn-xs min-h-0 h-auto w-auto p-0.5"
      [class.btn-active]="open()"
      [attr.aria-expanded]="open()"
      [attr.aria-controls]="panelId()"
      [attr.aria-label]="(open() ? 'a11y.hide_description' : 'a11y.show_description') | translate:{ name: subject() }"
      (click)="toggle()"
      (mouseenter)="onPointerEnter($event)"
      (mouseleave)="hovered.set(false)">
      <span class="material-symbols-outlined text-info" [class]="iconSizeClass()" aria-hidden="true">help_outline</span>
    </button>
    <!-- Rendered only while shown: a hidden DaisyUI tip still takes part in layout, and one centered on
         an icon near the edge widened the page at phone width -->
    @if (showTooltip()) {
      <span aria-hidden="true" data-testid="help-tooltip"
        class="tooltip tooltip-bottom tooltip-open absolute inset-0 pointer-events-none"
        [class.tooltip-start]="align() === 'start'"
        [class.tooltip-end]="align() === 'end'"
        [attr.data-tip]="text()"></span>
    }
  `,
})
export class HelpToggletipComponent {
  /** The description. */
  text = input.required<string>();
  /** What it describes (entity or field name), for the button's accessible name. */
  subject = input.required<string>();
  /** id of the element that shows the description when open. */
  panelId = input.required<string>();
  /** Icon size: next to a page title or a field label. */
  size = input<'title' | 'field'>('field');
  /** Whether the description is shown; two-way bound by the parent, which renders it. */
  open = model(false);

  protected readonly hovered = signal(false);
  protected readonly align = signal<HelpTipAlign>('center');
  /** The tooltip only previews: hidden while the description is open in the page. */
  protected readonly showTooltip = computed(() => this.hovered() && !this.open());
  protected readonly iconSizeClass = computed(() => this.size() === 'title' ? 'text-xl' : 'text-base');

  toggle(): void {
    this.open.set(!this.open());
    this.hovered.set(false);
  }

  /**
   * Show the tooltip only where the primary input hovers with a fine pointer: on touch devices a tap
   * fires mouseenter too, and there the button's disclosure is the whole interaction.
   */
  onPointerEnter(event: MouseEvent): void {
    if (typeof matchMedia !== 'function' || !matchMedia('(hover: hover) and (pointer: fine)').matches) return;
    const button = event.currentTarget as HTMLElement;
    const rtl = getComputedStyle(button).direction === 'rtl';
    this.align.set(helpTipAlign(button.getBoundingClientRect(), window.innerWidth, rtl));
    this.hovered.set(true);
  }
}

/**
 * Alignment that keeps a tooltip of up to 20rem inside the viewport. Centered under the button when it
 * fits; otherwise flush with the button edge nearer the overflowing side. `start`/`end` are logical
 * (DaisyUI's tooltip-start/-end use inset-inline), so the physical side is mapped for RTL.
 */
export function helpTipAlign(button: { left: number; right: number }, viewportWidth: number, rtl: boolean): HelpTipAlign {
  const width = Math.min(TIP_MAX, viewportWidth - 2 * EDGE);
  const center = (button.left + button.right) / 2;
  const overflowsRight = center + width / 2 > viewportWidth - EDGE;
  const overflowsLeft = center - width / 2 < EDGE;
  if (!overflowsRight && !overflowsLeft) return 'center';
  // Flush with the button's left edge extends rightward; flush with its right edge extends leftward.
  const physical: 'left' | 'right' = overflowsRight ? 'right' : 'left';
  if (physical === 'left') return rtl ? 'end' : 'start';
  return rtl ? 'start' : 'end';
}
