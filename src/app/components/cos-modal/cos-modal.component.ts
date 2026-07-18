/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import {
  Component,
  ChangeDetectionStrategy,
  input,
  output,
  computed,
  effect,
  ElementRef,
  viewChild,
  OnDestroy
} from '@angular/core';
import { NgClass } from '@angular/common';

/**
 * Custom modal component built on the native `<dialog>` element.
 *
 * `showModal()` places the dialog in the browser's top layer, which sidesteps
 * the DaisyUI mobile-centering bug (GitHub issue #4020) caused by containing
 * blocks from CSS transforms on ancestors (like the drawer): top-layer
 * elements are positioned against the viewport, never a transformed ancestor.
 *
 * The browser natively provides:
 * - Top-layer rendering (always above any z-index stacking context)
 * - True background inerting (focus, click, and screen-reader cursor cannot
 *   escape the dialog while it is open)
 * - Escape-key close requests (surfaced via the `cancel` event)
 * - Initial focus placement when the dialog opens
 *
 * The component still provides:
 * - Body scroll lock (`::backdrop` does NOT prevent background scrolling)
 * - Focus restoration to the previously focused element on close (the native
 *   restore only runs on `dialog.close()`; this component removes the element
 *   from the DOM instead, driven by the `isOpen` input)
 * - Entrance animation (`@starting-style` + `::backdrop`)
 * - Size variants (sm, md, lg, xl, full)
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
  imports: [NgClass],
  templateUrl: './cos-modal.component.html',
  styleUrl: './cos-modal.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class CosModalComponent implements OnDestroy {
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

  /** The native dialog element (present only while isOpen is true) */
  private dialogRef = viewChild<ElementRef<HTMLDialogElement>>('dialog');

  /** Element focused before the dialog opened, restored on close */
  private previouslyFocused: HTMLElement | null = null;

  /** Whether this instance currently holds the body scroll lock */
  private bodyLocked = false;

  /** Stored scroll position for restoration after close */
  private scrollY = 0;

  /**
   * Set when a pointerdown lands inside the modal box, so a drag that starts
   * on content but is released over the backdrop does not dismiss the dialog.
   */
  private suppressBackdropClick = false;

  /** Computed CSS class for size variant */
  sizeClass = computed(() => {
    const s = this.size();
    return s === 'md' ? '' : `cos-modal-${s}`;
  });

  constructor() {
    // The isOpen input drives the dialog's lifecycle: entering the DOM (via
    // @if) triggers showModal() here; leaving the DOM removes it from the
    // top layer. dialog.close() is never called - state flows one way.
    effect(() => {
      const dialog = this.dialogRef()?.nativeElement;
      if (dialog && !dialog.open) {
        this.previouslyFocused =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
        dialog.showModal();
      }
    });

    // Body scroll lock lifecycle
    effect(() => {
      if (this.isOpen()) {
        this.lockBodyScroll();
      } else {
        this.onClose();
      }
    });
  }

  ngOnDestroy(): void {
    // Ensure body scroll is unlocked if component is destroyed while open
    if (this.bodyLocked) {
      this.unlockBodyScroll();
    }
  }

  /** Handle modal closing: release the scroll lock and restore focus */
  private onClose(): void {
    if (!this.bodyLocked) {
      return;
    }
    this.unlockBodyScroll();
    const el = this.previouslyFocused;
    this.previouslyFocused = null;
    if (el) {
      // Wait a tick so the dialog has left the DOM (and the top layer) -
      // while it is still modal, focus cannot move to background content.
      setTimeout(() => {
        if (document.contains(el)) {
          el.focus();
        }
      });
    }
  }

  /** Close the modal by emitting the closed event */
  close(): void {
    this.closed.emit();
  }

  /**
   * Handle the native close request (close watcher paths such as a platform
   * back gesture). Always prevented: the dialog must only close via the
   * isOpen input, otherwise the parent's state would desync from the DOM.
   */
  onCancel(event: Event): void {
    event.preventDefault();
    if (this.closeOnEscape()) {
      this.close();
    }
  }

  /**
   * Escape handling on the keydown itself. Keydown always reaches the dialog
   * (modal dialogs contain focus), while the browser's Escape-to-cancel close
   * request is not delivered in some environments (observed with injected
   * input in embedded/automated browsers). preventDefault here suppresses the
   * native close request, so the cancel path above cannot double-fire.
   */
  onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && this.closeOnEscape()) {
      event.preventDefault();
      this.close();
    }
  }

  /** Track where a pointer gesture started (see suppressBackdropClick) */
  onPointerDown(event: PointerEvent): void {
    this.suppressBackdropClick = event.target !== this.dialogRef()?.nativeElement;
  }

  /**
   * Handle clicks on the dialog surface. The dialog element itself is a
   * transparent full-viewport flex container, so a click whose target is the
   * dialog (not the box) is a backdrop click.
   */
  onDialogClick(event: MouseEvent): void {
    const isBackdrop = event.target === this.dialogRef()?.nativeElement;
    const suppressed = this.suppressBackdropClick;
    this.suppressBackdropClick = false;
    if (isBackdrop && !suppressed && this.closeOnBackdrop()) {
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
    this.bodyLocked = true;
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
    this.bodyLocked = false;
  }
}
