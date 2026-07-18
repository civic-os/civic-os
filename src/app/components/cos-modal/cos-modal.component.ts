/**
 * Copyright (C) 2023-2025 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import {
  Component,
  ChangeDetectionStrategy,
  input,
  output,
  signal,
  computed,
  effect,
  ElementRef,
  ViewChild,
  AfterViewInit,
  OnDestroy
} from '@angular/core';
import { NgClass } from '@angular/common';
import { A11yModule } from '@angular/cdk/a11y';
import { inertSiblingsOutside } from '../../utils/inert.utils';

/**
 * Custom modal component that reliably centers on mobile devices.
 *
 * This component replaces DaisyUI modals which have a known centering bug
 * on mobile (GitHub issue #4020) caused by containing blocks created by
 * CSS transforms on ancestor elements (like the drawer).
 *
 * **Solution**: Uses a fixed full-viewport container with flexbox centering.
 * The modal box uses `position: relative` to participate in flexbox layout,
 * avoiding percentage-based calculations affected by containing blocks.
 *
 * **Features**:
 * - Proper centering on all screen sizes
 * - Body scroll lock (prevents iOS momentum scroll bounce)
 * - Focus trap for accessibility
 * - ESC key to close (configurable)
 * - Backdrop click to close (configurable)
 * - Smooth entrance/exit animations
 * - Size variants (sm, md, lg, xl, full)
 * - Inherits DaisyUI visual styles (colors, shadows, border-radius)
 *
 * @example
 * ```html
 * <cos-modal [isOpen]="showModal()" (closed)="showModal.set(false)" size="md">
 *   <h3 class="font-bold text-lg mb-4">Modal Title</h3>
 *   <p>Modal content goes here.</p>
 *   <div class="cos-modal-action">
 *     <button class="btn" (click)="showModal.set(false)">Cancel</button>
 *     <button class="btn btn-primary" (click)="confirm()">Confirm</button>
 *   </div>
 * </cos-modal>
 * ```
 */
@Component({
  selector: 'cos-modal',
  imports: [NgClass, A11yModule],
  templateUrl: './cos-modal.component.html',
  styleUrl: './cos-modal.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class CosModalComponent implements AfterViewInit, OnDestroy {
  /** Whether the modal is open */
  isOpen = input<boolean>(false);

  /** Modal size variant */
  size = input<'sm' | 'md' | 'lg' | 'xl' | 'full'>('md');

  /** Whether clicking the backdrop closes the modal */
  closeOnBackdrop = input<boolean>(true);

  /** Whether pressing ESC closes the modal */
  closeOnEscape = input<boolean>(true);

  /**
   * Accessible name for the dialog. Should match the modal's visible heading.
   * Applied as `aria-label` so screen readers announce a name for the dialog.
   */
  label = input<string>();

  /** Emitted when the modal should be closed */
  closed = output<void>();

  /** Reference to the modal container for focus management */
  @ViewChild('modalContainer') modalContainer?: ElementRef<HTMLElement>;

  /** Restore function for the inert attributes applied to background content while open. */
  private restoreInert?: () => void;

  /** Internal animation state (delayed for entrance animation) */
  animationReady = signal(false);

  /** Stored scroll position for restoration after close */
  private scrollY = 0;

  /** Computed CSS class for size variant */
  sizeClass = computed(() => {
    const s = this.size();
    return s === 'md' ? '' : `cos-modal-${s}`;
  });

  constructor() {
    // Effect to handle open/close state changes
    effect(() => {
      const open = this.isOpen();
      if (open) {
        this.onOpen();
      } else {
        this.onClose();
      }
    });
  }

  ngAfterViewInit(): void {
    // If modal starts open, ensure body scroll is locked
    if (this.isOpen()) {
      this.lockBodyScroll();
      requestAnimationFrame(() => this.animationReady.set(true));
    }
  }

  ngOnDestroy(): void {
    this.restoreInert?.();
    this.restoreInert = undefined;
    // Ensure body scroll is unlocked if component is destroyed while open
    if (this.isOpen()) {
      this.unlockBodyScroll();
    }
  }

  /** Handle modal opening */
  private onOpen(): void {
    this.lockBodyScroll();
    // Delay animation ready for entrance animation
    requestAnimationFrame(() => this.animationReady.set(true));
    // Focus fallback: cdkTrapFocusAutoCapture grabs the first tabbable child,
    // but modals whose content loads asynchronously may have none at open time,
    // leaving focus (and the screen reader) on the page behind the dialog.
    // If nothing inside the dialog took focus, focus the dialog itself.
    setTimeout(() => {
      const el = this.modalContainer?.nativeElement;
      if (!el || !this.isOpen()) return;
      // Remove the background from the accessibility tree and tab order while
      // the dialog is open (aria-modal alone is unevenly honored — VoiceOver's
      // cursor can recover to background elements after in-dialog re-renders).
      this.restoreInert ??= inertSiblingsOutside(el);
      if (!el.contains(document.activeElement)) {
        el.focus();
      }
    }, 50);
  }

  /** Handle modal closing */
  private onClose(): void {
    this.animationReady.set(false);
    this.unlockBodyScroll();
    this.restoreInert?.();
    this.restoreInert = undefined;
  }

  /** Close the modal by emitting the closed event */
  close(): void {
    this.closed.emit();
  }

  /** Handle backdrop click */
  onBackdropClick(): void {
    if (this.closeOnBackdrop()) {
      this.close();
    }
  }

  /** Handle keyboard events */
  onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && this.closeOnEscape()) {
      event.preventDefault();
      this.close();
    }
  }

  /**
   * Lock body scroll to prevent background scrolling.
   * Uses position: fixed to prevent iOS momentum scroll bounce.
   */
  private lockBodyScroll(): void {
    this.scrollY = window.scrollY;
    document.body.style.overflow = 'hidden';
    document.body.style.position = 'fixed';
    document.body.style.width = '100%';
    document.body.style.top = `-${this.scrollY}px`;
  }

  /**
   * Unlock body scroll and restore scroll position.
   */
  private unlockBodyScroll(): void {
    document.body.style.overflow = '';
    document.body.style.position = '';
    document.body.style.width = '';
    document.body.style.top = '';
    window.scrollTo(0, this.scrollY);
  }
}
