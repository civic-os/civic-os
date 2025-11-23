/**
 * Copyright (C) 2023-2025 Civic OS, L3C
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import { CommonModule } from '@angular/common';
import { Component, input, signal, computed, ChangeDetectionStrategy, ViewChild } from '@angular/core';
import { SchemaEntityProperty, EntityPropertyType, FileReference } from '../../interfaces/entity';
import { RouterModule } from '@angular/router';
import { GeoPointMapComponent } from '../geo-point-map/geo-point-map.component';
import { HighlightPipe } from '../../pipes/highlight.pipe';
import { ImageViewerComponent } from '../image-viewer/image-viewer.component';
import { PdfViewerComponent } from '../pdf-viewer/pdf-viewer.component';
import { DisplayTimeSlotComponent } from '../display-time-slot/display-time-slot.component';
import { PaymentBadgeComponent } from '../payment-badge/payment-badge.component';
import { getS3Config } from '../../config/runtime';

@Component({
    selector: 'app-display-property',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [
        CommonModule,
        RouterModule,
        GeoPointMapComponent,
        HighlightPipe,
        ImageViewerComponent,
        PdfViewerComponent,
        DisplayTimeSlotComponent,
        PaymentBadgeComponent,
    ],
    templateUrl: './display-property.component.html',
    styleUrl: './display-property.component.css'
})
export class DisplayPropertyComponent {
  @ViewChild(ImageViewerComponent) imageViewer?: ImageViewerComponent;
  @ViewChild(PdfViewerComponent) pdfViewer?: PdfViewerComponent;

  prop = input.required<SchemaEntityProperty>({ alias: 'property' });
  datum = input<any>();
  linkRelated = input<boolean>(true);
  showLabel = input<boolean>(true);
  highlightTerms = input<string[]>([]);

  propType = computed(() => this.prop().type);
  displayCoordinates = signal<[number, number] | null>(null);

  public EntityPropertyType = EntityPropertyType;

  onCoordinatesChange(coords: [number, number] | null) {
    this.displayCoordinates.set(coords);
  }

  formatPhoneNumber(raw: string): string {
    if (!raw || raw.length !== 10) return raw;
    return `(${raw.slice(0, 3)}) ${raw.slice(3, 6)}-${raw.slice(6)}`;
  }

  /**
   * Open image in full-screen viewer
   */
  onImageClick(file: FileReference) {
    this.imageViewer?.open(file);
  }

  /**
   * Open PDF in embedded viewer
   */
  onPdfClick(file: FileReference) {
    this.pdfViewer?.open(file);
  }

  /**
   * Construct S3 URL from key
   */
  getS3Url(s3Key: string): string {
    const s3Config = getS3Config();
    return `${s3Config.endpoint}/${s3Config.bucket}/${s3Key}`;
  }

  /**
   * Format file size in human-readable format
   */
  formatFileSize(bytes: number): string {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  }
}
