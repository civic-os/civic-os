/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import { Component, ChangeDetectionStrategy, input, output, signal, computed, effect, HostListener, inject, ElementRef, viewChild } from '@angular/core';
import { GalleryImage } from '../../interfaces/entity';
import { getS3Config } from '../../config/runtime';
import { LocaleService } from '../../services/locale.service';
import { TranslatePipe } from '../../pipes/translate.pipe';

/**
 * Full-screen lightbox for gallery image viewing with keyboard navigation.
 *
 * Rendered as a native `<dialog>` via showModal(): the browser handles
 * top-layer stacking (above any open cos-modal), background inerting, and
 * initial focus. Focus restoration on close is handled here because the
 * dialog leaves the DOM via @if instead of dialog.close().
 *
 * Features:
 * - Large image display (800px thumbnail or original fallback)
 * - Prev/Next arrows + keyboard navigation (← →)
 * - Image counter "3 / 10"
 * - Caption display below image
 * - Close via X button, Escape key, or backdrop click
 *
 * @example
 * ```html
 * <app-gallery-lightbox
 *   [images]="galleryImages()"
 *   [isOpen]="lightboxOpen()"
 *   [startIndex]="clickedImageIndex()"
 *   (closed)="lightboxOpen.set(false)"
 * />
 * ```
 *
 * Added in v0.47.0.
 */
@Component({
  selector: 'app-gallery-lightbox',
  standalone: true,
  imports: [TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './gallery-lightbox.component.html'
})
export class GalleryLightboxComponent {
  private localeService = inject(LocaleService);
  readonly isRtl = this.localeService.isRtl;

  images = input.required<GalleryImage[]>();
  isOpen = input<boolean>(false);
  startIndex = input<number>(0);
  closed = output<void>();

  currentIndex = signal(0);

  /** The native dialog element (present only while isOpen is true) */
  private dialogRef = viewChild<ElementRef<HTMLDialogElement>>('dialog');

  /** Element focused before the lightbox opened, restored on close */
  private previouslyFocused: HTMLElement | null = null;

  /** Show the native dialog whenever it enters the DOM (isOpen drives the @if) */
  private showDialog = effect(() => {
    const dialog = this.dialogRef()?.nativeElement;
    if (dialog && !dialog.open) {
      this.previouslyFocused =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
    }
  });

  /** Sync currentIndex when the lightbox opens (or startIndex changes while open) */
  private syncIndex = effect(() => {
    if (this.isOpen()) {
      this.currentIndex.set(this.startIndex());
    } else {
      this.restoreFocus();
    }
  });

  ngOnDestroy(): void {
    this.restoreFocus();
  }

  /** Return focus to the element that opened the lightbox (no-op if never opened) */
  private restoreFocus(): void {
    const el = this.previouslyFocused;
    this.previouslyFocused = null;
    if (el) {
      // Wait a tick so the dialog has left the DOM (and the top layer) -
      // while it is still modal, focus cannot move outside it.
      setTimeout(() => {
        if (document.contains(el)) {
          el.focus();
        }
      });
    }
  }

  /**
   * Handle the native close request (Escape via close watcher). Prevented so
   * the dialog only closes via the isOpen input; the closed event asks the
   * parent to flip that state.
   */
  onCancel(event: Event): void {
    event.preventDefault();
    this.close();
  }

  currentImage = computed(() => {
    const imgs = this.images();
    const idx = this.currentIndex();
    return imgs.length > idx ? imgs[idx] : null;
  });

  imageCount = computed(() => this.images().length);

  /** Navigate to previous image (wraps around) */
  prev(): void {
    const count = this.imageCount();
    if (count <= 1) return;
    this.currentIndex.update(i => (i - 1 + count) % count);
  }

  /** Navigate to next image (wraps around) */
  next(): void {
    const count = this.imageCount();
    if (count <= 1) return;
    this.currentIndex.update(i => (i + 1) % count);
  }

  /** Open lightbox at a specific index */
  open(index: number = 0): void {
    this.currentIndex.set(index);
  }

  close(): void {
    this.closed.emit();
  }

  @HostListener('document:keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    if (!this.isOpen()) return;

    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        this.close();
        break;
      case 'ArrowLeft':
        // Match the key direction to the visible chevron direction. In RTL the
        // start-side (visually right) chevron points to "next", so ArrowLeft
        // advances to the next image instead of the previous one.
        event.preventDefault();
        this.isRtl() ? this.next() : this.prev();
        break;
      case 'ArrowRight':
        event.preventDefault();
        this.isRtl() ? this.prev() : this.next();
        break;
    }
  }

  /** Get image URL — use original for full-quality lightbox display */
  getImageUrl(image: GalleryImage): string {
    if (!image.file) return '';
    const s3Config = getS3Config();
    const key = image.file.s3_original_key;
    return `${s3Config.endpoint}/${s3Config.bucket}/${key}`;
  }

  /** Get thumbnail URL for navigation strip */
  getThumbUrl(image: GalleryImage): string {
    if (!image.file) return '';
    const s3Config = getS3Config();
    const key = image.file.s3_thumbnail_small_key || image.file.s3_thumbnail_medium_key || image.file.s3_original_key;
    return `${s3Config.endpoint}/${s3Config.bucket}/${key}`;
  }

  /** Stop click propagation (prevent backdrop close when clicking image) */
  onContentClick(event: MouseEvent): void {
    event.stopPropagation();
  }
}
