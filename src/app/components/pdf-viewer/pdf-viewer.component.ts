/**
 * Copyright (C) 2023-2025 Civic OS, L3C
 */

import { Component, signal } from '@angular/core';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { FileReference } from '../../interfaces/entity';
import { getS3Config } from '../../config/runtime';
import { CosModalComponent } from '../cos-modal/cos-modal.component';

@Component({
  selector: 'app-pdf-viewer',
  standalone: true,
  imports: [CosModalComponent],
  templateUrl: './pdf-viewer.component.html',
  styleUrl: './pdf-viewer.component.css'
})
export class PdfViewerComponent {
  isOpen = signal(false);
  currentPdf = signal<FileReference | null>(null);

  constructor(private sanitizer: DomSanitizer) {}

  /**
   * Open PDF viewer with given file
   */
  open(pdf: FileReference) {
    this.currentPdf.set(pdf);
    this.isOpen.set(true);
  }

  /**
   * Close the viewer
   */
  close() {
    this.isOpen.set(false);
    this.currentPdf.set(null);
  }

  /**
   * Get sanitized PDF URL for iframe
   * Angular security requires bypassing for blob/data URLs
   */
  getSanitizedPdfUrl(): SafeResourceUrl {
    const pdf = this.currentPdf();
    if (!pdf) return '';

    const url = this.getS3Url(pdf.s3_original_key);
    return this.sanitizer.bypassSecurityTrustResourceUrl(url);
  }

  /**
   * Get raw PDF URL for download link
   */
  getPdfUrl(): string {
    const pdf = this.currentPdf();
    return pdf ? this.getS3Url(pdf.s3_original_key) : '';
  }

  /**
   * Open PDF in new tab with full browser controls
   */
  openFullScreen() {
    window.open(this.getPdfUrl(), '_blank');
  }

  /**
   * Get download filename
   */
  getDownloadFilename(): string {
    return this.currentPdf()?.file_name || 'document.pdf';
  }

  /**
   * Download the PDF file
   * Fetches as blob to force download instead of browser PDF viewer
   */
  async downloadPdf() {
    const pdf = this.currentPdf();
    if (!pdf) return;

    const url = this.getS3Url(pdf.s3_original_key);
    const filename = this.getDownloadFilename();

    try {
      // Fetch the PDF as a blob
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
      console.error('Failed to download PDF:', error);
    }
  }

  /**
   * Construct S3 URL from key
   */
  private getS3Url(s3Key: string): string {
    const s3Config = getS3Config();
    return `${s3Config.endpoint}/${s3Config.bucket}/${s3Key}`;
  }
}
