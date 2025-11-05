/**
 * Copyright (C) 2023-2025 Civic OS, L3C
 */

import { Component, ElementRef, ViewChild, signal } from '@angular/core';
import { FileReference } from '../../interfaces/entity';
import { getS3Config } from '../../config/runtime';

@Component({
  selector: 'app-image-viewer',
  standalone: true,
  imports: [],
  templateUrl: './image-viewer.component.html',
  styleUrl: './image-viewer.component.css'
})
export class ImageViewerComponent {
  @ViewChild('imageDialog') dialog!: ElementRef<HTMLDialogElement>;

  currentImage = signal<FileReference | null>(null);
  zoomed = signal(false);

  /**
   * Open image viewer with given file
   */
  open(image: FileReference) {
    this.currentImage.set(image);
    this.zoomed.set(false);
    this.dialog.nativeElement.showModal();
  }

  /**
   * Close the viewer
   */
  close() {
    this.dialog.nativeElement.close();
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
   * Download the original image file
   * Fetches as blob to force download instead of navigation
   */
  async downloadImage() {
    const img = this.currentImage();
    if (!img) return;

    const url = this.getS3Url(img.s3_original_key);
    const filename = this.getDownloadFilename();

    try {
      // Fetch the image as a blob
      const response = await fetch(url);
      const blob = await response.blob();

      // Create a temporary blob URL
      const blobUrl = URL.createObjectURL(blob);

      // Create a temporary anchor element and click it
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();

      // Clean up
      document.body.removeChild(a);
      URL.revokeObjectURL(blobUrl);
    } catch (error) {
      console.error('Failed to download image:', error);
    }
  }

  /**
   * Get image URL (prefer large thumbnail, fallback to original)
   */
  getImageUrl(): string {
    const img = this.currentImage();
    if (!img) return '';

    // For zoomed view, always use original
    if (this.zoomed()) {
      return this.getS3Url(img.s3_original_key);
    }

    // For fit view, use large thumbnail if available
    return img.s3_thumbnail_large_key
      ? this.getS3Url(img.s3_thumbnail_large_key)
      : this.getS3Url(img.s3_original_key);
  }

  /**
   * Construct S3 URL from key
   */
  private getS3Url(s3Key: string): string {
    const s3Config = getS3Config();
    return `${s3Config.endpoint}/${s3Config.bucket}/${s3Key}`;
  }
}
