/**
 * Copyright (C) 2023-2025 Civic OS, L3C
 */

import { Component, signal, computed, inject, ChangeDetectionStrategy } from '@angular/core';
import { FileReference } from '../../interfaces/entity';
import { fileDisplayUrl } from '@civic-os/core';
import { FileAccessService } from '../../services/file-access.service';
import { CosModalComponent } from '../cos-modal/cos-modal.component';
import { TranslatePipe } from '../../pipes/translate.pipe';

@Component({
  selector: 'app-image-viewer',
  standalone: true,
  imports: [CosModalComponent, TranslatePipe],
  templateUrl: './image-viewer.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './image-viewer.component.css'
})
export class ImageViewerComponent {
  private fileAccess = inject(FileAccessService);

  isOpen = signal(false);
  currentImage = signal<FileReference | null>(null);
  zoomed = signal(false);

  /**
   * Open image viewer with given file
   */
  open(image: FileReference) {
    this.currentImage.set(image);
    this.zoomed.set(false);
    this.isOpen.set(true);
  }

  /**
   * Close the viewer
   */
  close() {
    this.isOpen.set(false);
    this.currentImage.set(null);
    this.zoomed.set(false);
  }

  /**
   * Toggle between fit and actual size
   */
  toggleZoom() {
    this.zoomed.update(z => !z);
  }

  /**
   * Get download filename
   */
  getDownloadFilename(): string {
    return this.currentImage()?.file_name || 'image';
  }

  /**
   * Download the original image under its name, with a URL read now (signed URLs expire, v0.88.0)
   */
  async downloadImage() {
    const img = this.currentImage();
    if (!img) return;
    if (!(await this.fileAccess.download(img))) {
      console.error('Failed to download image: no URL available');
    }
  }

  /**
   * The image to show: the large thumbnail in the fitted view, the original when zoomed
   * (computed, so the <img> keeps its src across change detection)
   */
  imageUrl = computed(() => fileDisplayUrl(this.currentImage(), this.zoomed() ? 'original' : 'large') ?? '');
}
