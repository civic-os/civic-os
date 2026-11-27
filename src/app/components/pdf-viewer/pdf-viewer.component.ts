/**
 * Copyright (C) 2023-2025 Civic OS, L3C
 */

import { Component, signal, computed, inject, ChangeDetectionStrategy } from '@angular/core';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { FileReference } from '../../interfaces/entity';
import { FileAccessService } from '../../services/file-access.service';
import { CosModalComponent } from '../cos-modal/cos-modal.component';
import { TranslatePipe } from '../../pipes/translate.pipe';

@Component({
  selector: 'app-pdf-viewer',
  standalone: true,
  imports: [CosModalComponent, TranslatePipe],
  templateUrl: './pdf-viewer.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './pdf-viewer.component.css'
})
export class PdfViewerComponent {
  private fileAccess = inject(FileAccessService);

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
   * The PDF's URL for the iframe, from the files view (signed for private files, v0.88.0). Computed,
   * so the iframe keeps one SafeResourceUrl instead of a new one per change detection.
   */
  pdfUrl = computed<SafeResourceUrl | null>(() => {
    const url = this.currentPdf()?.url;
    return url ? this.sanitizer.bypassSecurityTrustResourceUrl(url) : null;
  });

  /**
   * Open PDF in new tab with full browser controls (with a URL read now: signed URLs expire)
   */
  openFullScreen() {
    const pdf = this.currentPdf();
    if (pdf) void this.fileAccess.openInNewTab(pdf);
  }

  /**
   * Download the PDF under its name (a URL read now, signed with Content-Disposition: attachment)
   */
  async downloadPdf() {
    const pdf = this.currentPdf();
    if (!pdf) return;
    if (!(await this.fileAccess.download(pdf))) {
      console.error('Failed to download PDF: no URL available');
    }
  }
}
