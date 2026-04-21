/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {
  Component, ChangeDetectionStrategy, input, output, signal, effect,
  inject, DestroyRef, computed
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { interval } from 'rxjs';
import { takeWhile, switchMap } from 'rxjs/operators';
import { FileReference } from '../../interfaces/entity';
import { FileUploadService } from '../../services/file-upload.service';
import { getS3Config } from '../../config/runtime';

/**
 * Shared thumbnail display component for file references.
 *
 * Handles the full thumbnail lifecycle:
 * - Shows optimized thumbnail when available (medium by default)
 * - Falls back to original image as preview when thumbnail isn't generated yet
 * - Shows spinner when no image keys are available yet
 * - Shows broken-image icon on failure
 * - Optionally polls for thumbnail completion and emits updated FileReference
 *
 * The parent controls the container dimensions — this component fills its parent
 * with `w-full h-full` and the chosen `object-fit`.
 *
 * @example
 * ```html
 * <div class="w-32 h-32">
 *   <app-file-thumbnail
 *     [file]="fileRef"
 *     [poll]="true"
 *     (fileUpdated)="onFileUpdated($event)"
 *     (clicked)="openViewer()"
 *   />
 * </div>
 * ```
 *
 * Added in v0.47.0.
 */
@Component({
  selector: 'app-file-thumbnail',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (thumbnailUrl()) {
      <img
        [src]="thumbnailUrl()"
        [alt]="alt()"
        class="not-prose w-full h-full"
        [class.object-cover]="objectFit() === 'cover'"
        [class.object-contain]="objectFit() === 'contain'"
        (click)="clicked.emit()"
      />
    } @else if (isLoading()) {
      <div class="w-full h-full flex items-center justify-center bg-base-200">
        <span class="loading loading-spinner"></span>
      </div>
    } @else if (isFailed()) {
      <div class="w-full h-full flex items-center justify-center bg-base-200">
        <span class="material-symbols-outlined text-2xl text-warning">broken_image</span>
      </div>
    } @else {
      <div class="w-full h-full flex items-center justify-center bg-base-200">
        <span class="material-symbols-outlined text-2xl text-base-content/40">image</span>
      </div>
    }
  `
})
export class FileThumbnailComponent {
  private fileUpload = inject(FileUploadService);
  private destroyRef = inject(DestroyRef);

  /** The file reference to display */
  file = input<FileReference | null>(null);

  /** Which thumbnail size to prefer. Falls back: preferred → original */
  preferredSize = input<'small' | 'medium' | 'original'>('medium');

  /** CSS object-fit mode */
  objectFit = input<'cover' | 'contain'>('cover');

  /** Alt text for the image */
  alt = input('');

  /** Whether to poll for thumbnail completion when status is pending/processing */
  poll = input(false);

  /** Emitted when the image is clicked */
  clicked = output<void>();

  /** Emits the updated FileReference when polling detects thumbnail completion */
  fileUpdated = output<FileReference>();

  /** Internal file state — starts from input, updated by polling */
  private displayFile = signal<FileReference | null>(null);

  /** Track polling per file ID to avoid duplicate polls */
  private pollingFileId: string | null = null;

  /** Whether we're actively polling */
  isPolling = signal(false);

  /** Computed: is the thumbnail still loading (pending/processing with no preview available)? */
  isLoading = computed(() => {
    const f = this.displayFile();
    if (!f) return false;
    const status = f.thumbnail_status;
    // Only show spinner if there's no image at all to preview
    return (status === 'pending' || status === 'processing')
      && !f.s3_thumbnail_medium_key && !f.s3_original_key;
  });

  /** Computed: did thumbnail generation fail? */
  isFailed = computed(() => {
    const f = this.displayFile();
    if (!f) return false;
    return f.thumbnail_status === 'failed'
      && !f.s3_thumbnail_medium_key && !f.s3_original_key;
  });

  /** Computed: the best available URL to display */
  thumbnailUrl = computed(() => {
    const f = this.displayFile();
    if (!f) return null;

    const size = this.preferredSize();
    let key: string | undefined;

    if (size === 'small') {
      key = f.s3_thumbnail_small_key || f.s3_thumbnail_medium_key || f.s3_original_key;
    } else if (size === 'medium') {
      key = f.s3_thumbnail_medium_key || f.s3_original_key;
    } else {
      key = f.s3_original_key;
    }

    if (!key) return null;

    const s3Config = getS3Config();
    return `${s3Config.endpoint}/${s3Config.bucket}/${key}`;
  });

  constructor() {
    // Sync from input and start polling if needed
    effect(() => {
      const f = this.file();
      this.displayFile.set(f);

      if (f && this.poll() && this.shouldPoll(f) && this.pollingFileId !== f.id) {
        this.startPolling(f.id);
      }
    });
  }

  /** Whether this file needs polling (thumbnail not yet ready) */
  private shouldPoll(f: FileReference): boolean {
    return f.thumbnail_status === 'pending' || f.thumbnail_status === 'processing';
  }

  /** Poll FileUploadService.getFile() until thumbnail completes */
  private startPolling(fileId: string): void {
    this.pollingFileId = fileId;
    this.isPolling.set(true);

    const maxAttempts = 30;
    let attempt = 0;

    interval(1000).pipe(
      takeWhile(() => {
        attempt++;
        return attempt <= maxAttempts && this.pollingFileId === fileId;
      }),
      switchMap(() => this.fileUpload.getFile(fileId)),
      takeUntilDestroyed(this.destroyRef)
    ).subscribe({
      next: (updatedFile) => {
        if (!updatedFile || this.pollingFileId !== fileId) return;

        if (updatedFile.thumbnail_status === 'completed' || updatedFile.thumbnail_status === 'failed') {
          this.displayFile.set(updatedFile);
          this.fileUpdated.emit(updatedFile);
          this.pollingFileId = null;
          this.isPolling.set(false);
        }
      },
      error: () => {
        this.pollingFileId = null;
        this.isPolling.set(false);
      },
      complete: () => {
        this.pollingFileId = null;
        this.isPolling.set(false);
      }
    });
  }
}
