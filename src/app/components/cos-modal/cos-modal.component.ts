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

  /** Emitted when the modal should be closed */
  closed = output<void>();

  /** Reference to the modal container for focus management */
  @ViewChild('modalContainer') modalContainer?: ElementRef<HTMLElement>;

  /** Internal animation state (delayed for entrance animation) */
  animationReady = signal(false);

  /** Stored scroll position for restoration after close */
  private scrollY = 0;

  /** Unique ID for ARIA labelling */
  readonly titleId = `cos-modal-title-${Math.random().toString(36).slice(2)}`;

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
  }

  /** Handle modal closing */
  private onClose(): void {
    this.animationReady.set(false);
    this.unlockBodyScroll();
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
