/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {
  Component, ChangeDetectionStrategy, inject, input, output, signal, computed, effect
} from '@angular/core';
import { CdkDragDrop, DragDropModule, moveItemInArray } from '@angular/cdk/drag-drop';
import { GalleryImage, FileReference, PhotoGalleryConfig } from '../../interfaces/entity';
import { GalleryService } from '../../services/gallery.service';
import { FileUploadService } from '../../services/file-upload.service';
import { GalleryLightboxComponent } from '../gallery-lightbox/gallery-lightbox.component';
import { FileThumbnailComponent } from '../file-thumbnail/file-thumbnail.component';
import { getS3Config } from '../../config/runtime';

/**
 * Editor component for photo galleries — drag-drop upload, reorder, remove.
 *
 * All gallery junction mutations (add, remove, reorder) are buffered locally.
 * The parent page calls `saveChanges()` to persist them (typically on form save).
 * File uploads to S3 and file record creation happen immediately for instant
 * thumbnail feedback.
 *
 * On Create pages (entityId is empty), the first upload creates a draft gallery
 * so S3 uploads have a valid context. The draft gallery is linked to the entity
 * after form submit via `link_gallery_to_entity` RPC.
 *
 * @example
 * ```html
 * <app-photo-gallery-editor
 *   [galleryId]="record.photos?.id"
 *   [entityType]="entityKey"
 *   [entityId]="entityId"
 *   [columnName]="prop.column_name"
 *   [currentFiles]="record.photos?.photo_gallery_files || []"
 *   [config]="galleryConfig()"
 *   (galleryChanged)="refreshData()"
 *   (draftGalleryCreated)="onDraftGalleryCreated($event)"
 * />
 * ```
 *
 * Added in v0.47.0.
 */
@Component({
  selector: 'app-photo-gallery-editor',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DragDropModule, GalleryLightboxComponent, FileThumbnailComponent],
  templateUrl: './photo-gallery-editor.component.html'
})
export class PhotoGalleryEditorComponent {
  private galleryService = inject(GalleryService);
  private fileUpload = inject(FileUploadService);

  // Inputs
  galleryId = input<string | null>(null);
  entityType = input.required<string>();
  entityId = input<string>('');
  columnName = input.required<string>();
  currentFiles = input<GalleryImage[]>([]);
  config = input<PhotoGalleryConfig>({
    table_name: '', column_name: '', max_images: 20, allowed_types: 'image/*'
  });

  // Outputs
  galleryChanged = output<void>();
  draftGalleryCreated = output<string>();  // Emits gallery_id for Create page

  // Internal state
  images = signal<GalleryImage[]>([]);
  uploading = signal(false);
  uploadError = signal<string | null>(null);
  lightboxOpen = signal(false);
  lightboxIndex = signal(0);

  /** Internal gallery ID — may be set from input or created during draft flow */
  private internalGalleryId = signal<string | null>(null);

  /** file_ids uploaded but not yet linked to gallery (persisted on saveChanges) */
  private pendingAdds = signal<string[]>([]);
  /** file_ids to unlink from gallery on save (persisted on saveChanges) */
  private pendingRemoves = signal<string[]>([]);

  currentCount = computed(() => this.images().length);
  maxImages = computed(() => this.config().max_images);
  atMax = computed(() => this.currentCount() >= this.maxImages());
  acceptTypes = computed(() => this.config().allowed_types || 'image/*');

  /** Prevents the currentFiles effect from overwriting local edits after initial load */
  private initialLoad = true;

  constructor() {
    // Sync images from input — only on first load.
    // After initialization, the component owns `images` (local adds/removes/reorder).
    // The effect still tracks currentFiles() so it runs when the input first arrives.
    effect(() => {
      const files = this.currentFiles();
      if (this.initialLoad && files && files.length > 0) {
        this.images.set([...files].sort((a, b) => a.sort_order - b.sort_order));
        this.initialLoad = false;
      }
    });

    // Sync gallery ID from input
    effect(() => {
      const id = this.galleryId();
      if (id) {
        this.internalGalleryId.set(id);
      }
    });
  }

  /** Handle file input or drop zone selection */
  async onFilesSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    if (!input.files?.length) return;
    await this.uploadFiles(Array.from(input.files));
    input.value = ''; // Reset input
  }

  /** Handle drag-and-drop file upload */
  async onDrop(event: DragEvent): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    if (!event.dataTransfer?.files?.length) return;
    await this.uploadFiles(Array.from(event.dataTransfer.files));
  }

  onDragOver(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
  }

  /** Upload one or more files to gallery */
  private async uploadFiles(files: File[]): Promise<void> {
    this.uploadError.set(null);

    // Filter to allowed types
    const config = this.config();
    const allowedTypes = config.allowed_types.split(',').map(t => t.trim());
    const validFiles = files.filter(f => this.isTypeAllowed(f.type, allowedTypes));

    if (validFiles.length === 0) {
      this.uploadError.set('No valid image files selected. Allowed: ' + config.allowed_types);
      return;
    }

    // Check max images
    const remaining = this.maxImages() - this.currentCount();
    if (validFiles.length > remaining) {
      this.uploadError.set(`Can only add ${remaining} more image(s) (max ${this.maxImages()})`);
      return;
    }

    // Check file size
    if (config.max_file_size) {
      const oversized = validFiles.find(f => f.size > config.max_file_size!);
      if (oversized) {
        const maxMB = (config.max_file_size / 1048576).toFixed(1);
        this.uploadError.set(`File "${oversized.name}" exceeds max size of ${maxMB} MB`);
        return;
      }
    }

    this.uploading.set(true);

    try {
      // On Create page (no entityId), ensure a draft gallery exists for S3 key context
      let gId = this.internalGalleryId();
      if (!gId && !this.entityId()) {
        gId = await this.ensureGalleryExists();
      }

      // Upload each file to S3 + create file record (immediate for thumbnail feedback)
      for (let i = 0; i < validFiles.length; i++) {
        const file = validFiles[i];
        const sortOrder = this.currentCount() + i;

        const fileRef = await this.fileUpload.uploadFile(
          file, this.entityType(), this.entityId() || gId!, false, this.columnName()
        );

        // Buffer the junction row — persisted when parent calls saveChanges()
        this.pendingAdds.update(ids => [...ids, fileRef.id]);

        // Add to local images for immediate visual feedback
        this.images.update(imgs => [...imgs, {
          file_id: fileRef.id,
          sort_order: sortOrder,
          caption: null,
          alt_text: null,
          created_at: new Date().toISOString(),
          file: fileRef
        }]);
      }

      this.galleryChanged.emit();
    } catch (err: any) {
      this.uploadError.set(err?.message || 'Upload failed');
    } finally {
      this.uploading.set(false);
    }
  }

  /** Ensure a gallery exists — creates draft if needed */
  private async ensureGalleryExists(): Promise<string> {
    const galleryId = await this.galleryService.createDraftGallery(
      this.entityType(), this.columnName()
    ).toPromise();

    if (!galleryId) throw new Error('Failed to create gallery');

    this.internalGalleryId.set(galleryId);
    this.draftGalleryCreated.emit(galleryId);
    return galleryId;
  }

  /** Remove an image — buffers locally, persisted on saveChanges() */
  removeImage(image: GalleryImage): void {
    // If this file was a pending add, just cancel it (never reached the gallery)
    if (this.pendingAdds().includes(image.file_id)) {
      this.pendingAdds.update(ids => ids.filter(id => id !== image.file_id));
    } else {
      this.pendingRemoves.update(ids => [...ids, image.file_id]);
    }
    this.images.update(imgs => imgs.filter(i => i.file_id !== image.file_id));
  }

  /** Track whether the user has reordered images (dirty flag for parent save) */
  private reorderDirty = signal(false);

  /** Handle CDK DragDrop reorder — buffers locally, persisted on saveChanges() */
  onReorder(event: CdkDragDrop<GalleryImage[]>): void {
    if (event.previousIndex === event.currentIndex) return;

    const imgs = [...this.images()];
    moveItemInArray(imgs, event.previousIndex, event.currentIndex);
    this.images.set(imgs);
    this.reorderDirty.set(true);
  }

  /** Whether there are any unsaved gallery changes */
  hasPendingChanges(): boolean {
    return this.pendingAdds().length > 0
      || this.pendingRemoves().length > 0
      || this.reorderDirty();
  }

  /**
   * Persist all buffered gallery changes — adds, removes, and reorder.
   * Called by the parent page on Save. Returns true if all operations succeeded.
   *
   * Order: adds first (may lazy-create gallery), then removes, then reorder.
   * On Edit page (entityId set), uses entity-aware addImage RPC.
   * On Create page (entityId empty), uses gallery-ID-based addImageById RPC.
   */
  async saveChanges(): Promise<boolean> {
    if (!this.hasPendingChanges()) return true;

    try {
      const currentImages = this.images();
      const gId = this.internalGalleryId();

      // Step 1: Persist pending adds
      for (const fileId of this.pendingAdds()) {
        const sortOrder = currentImages.findIndex(i => i.file_id === fileId);
        const order = sortOrder >= 0 ? sortOrder : currentImages.length;

        if (this.entityId()) {
          // Edit page: entity-aware RPC (lazy-creates gallery + sets entity FK)
          await this.galleryService.addImage(
            this.entityType(), this.entityId(), this.columnName(), fileId, order
          ).toPromise();
        } else if (gId) {
          // Create page: draft gallery already exists from upload step
          await this.galleryService.addImageById(gId, fileId, order).toPromise();
        }
      }

      // Step 2: Persist pending removes
      if (gId && this.pendingRemoves().length > 0) {
        for (const fileId of this.pendingRemoves()) {
          await this.galleryService.removeImage(gId, fileId).toPromise();
        }
      }

      // Step 3: Persist reorder (only meaningful when gallery pre-existed)
      if (this.reorderDirty() && gId) {
        const fileIds = currentImages.map(i => i.file_id);
        await this.galleryService.reorderImages(gId, fileIds).toPromise();
      }

      // Clear all buffers
      this.pendingAdds.set([]);
      this.pendingRemoves.set([]);
      this.reorderDirty.set(false);
      return true;
    } catch (err: any) {
      this.uploadError.set('Failed to save gallery changes: ' + (err?.message || 'Unknown error'));
      return false;
    }
  }

  /** Open lightbox at a specific image */
  openLightbox(index: number): void {
    this.lightboxIndex.set(index);
    this.lightboxOpen.set(true);
  }

  /** Get S3 URL for a thumbnail key */
  getS3Url(key: string): string {
    const s3Config = getS3Config();
    return `${s3Config.endpoint}/${s3Config.bucket}/${key}`;
  }

  /** Get the medium thumbnail URL for an image */
  getThumbUrl(image: GalleryImage): string {
    if (!image.file) return '';
    const key = image.file.s3_thumbnail_medium_key || image.file.s3_original_key;
    return this.getS3Url(key);
  }

  /** Update a gallery image's embedded file reference when polling detects thumbnail completion */
  onThumbnailReady(fileId: string, updatedFile: FileReference): void {
    this.images.update(imgs =>
      imgs.map(img => img.file_id === fileId ? { ...img, file: updatedFile } : img)
    );
  }

  /** Check if a MIME type matches any allowed type pattern */
  private isTypeAllowed(mimeType: string, allowedTypes: string[]): boolean {
    return allowedTypes.some(allowed => {
      if (allowed === 'image/*') return mimeType.startsWith('image/');
      return mimeType === allowed;
    });
  }
}
