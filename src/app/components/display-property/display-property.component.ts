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
import { SchemaEntityProperty, EntityPropertyType, FileReference, GalleryImage } from '../../interfaces/entity';
import { RouterModule } from '@angular/router';
import { GeoPointMapComponent } from '../geo-point-map/geo-point-map.component';
import { GeoPolygonMapComponent } from '../geo-polygon-map/geo-polygon-map.component';
import { HighlightPipe } from '../../pipes/highlight.pipe';
import { ImageViewerComponent } from '../image-viewer/image-viewer.component';
import { PdfViewerComponent } from '../pdf-viewer/pdf-viewer.component';
import { DisplayTimeSlotComponent } from '../display-time-slot/display-time-slot.component';
import { PaymentBadgeComponent } from '../payment-badge/payment-badge.component';
import { GalleryLightboxComponent } from '../gallery-lightbox/gallery-lightbox.component';
import { FileThumbnailComponent } from '../file-thumbnail/file-thumbnail.component';
import { getS3Config } from '../../config/runtime';
import { getContrastTextColor } from '../../utils/color.utils';

@Component({
    selector: 'app-display-property',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [
        CommonModule,
        RouterModule,
        GeoPointMapComponent,
        GeoPolygonMapComponent,
        HighlightPipe,
        ImageViewerComponent,
        PdfViewerComponent,
        DisplayTimeSlotComponent,
        PaymentBadgeComponent,
        GalleryLightboxComponent,
        FileThumbnailComponent,
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
  compact = input<boolean>(false);
  highlightTerms = input<string[]>([]);

  propType = computed(() => this.prop().type);
  displayCoordinates = signal<[number, number] | null>(null);

  // Gallery lightbox state (v0.47.0)
  galleryLightboxOpen = signal(false);
  galleryLightboxIndex = signal(0);

  public EntityPropertyType = EntityPropertyType;

  onCoordinatesChange(coords: [number, number] | null) {
    this.displayCoordinates.set(coords);
  }

  formatPhoneNumber(raw: string): string {
    if (!raw || raw.length !== 10) return raw;
    return `(${raw.slice(0, 3)}) ${raw.slice(3, 6)}-${raw.slice(6)}`;
  }

  /**
   * Format M:M chip label, appending rich junction extra column values if present.
   * Example: "Push Mower / 2"
   */
  formatM2mLabel(item: any): string {
    const name = item.display_name ?? '';
    const meta = this.prop().many_to_many_meta;
    if (!meta || !item._junction || meta.extraColumns.length === 0) return name;
    const parts = meta.extraColumns
      .sort((a, b) => (a.sort_order ?? 999) - (b.sort_order ?? 999))
      .map(col => item._junction[col.column_name])
      .filter(val => val !== null && val !== undefined && val !== '');
    if (parts.length === 0) return name;
    return `${name} / ${parts.join(' / ')}`;
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

  /**
   * Get contrast text color for status badge based on background luminance.
   * Returns 'white' for dark backgrounds, 'black' for light backgrounds.
   */
  getStatusTextColor(): string {
    const color = this.datum()?.color || '#3B82F6';
    return getContrastTextColor(color);
  }

  /**
   * Get contrast text color for category badge (same logic as status).
   */
  getCategoryTextColor(): string {
    const color = this.datum()?.color || '#3B82F6';
    return getContrastTextColor(color);
  }

  /**
   * Get sorted gallery images from embedded gallery data.
   * Returns empty array if no gallery or no files.
   */
  getGalleryImages(): GalleryImage[] {
    const gallery = this.datum();
    if (!gallery?.photo_gallery_files) return [];
    return [...gallery.photo_gallery_files].sort((a: GalleryImage, b: GalleryImage) => a.sort_order - b.sort_order);
  }

  /**
   * Get thumbnail URL for a gallery image.
   */
  getGalleryThumbUrl(image: GalleryImage): string {
    if (!image.file) return '';
    const key = image.file.s3_thumbnail_medium_key || image.file.s3_original_key;
    return this.getS3Url(key);
  }

  /**
   * Open gallery lightbox at specified index.
   */
  onGalleryImageClick(index: number): void {
    this.galleryLightboxIndex.set(index);
    this.galleryLightboxOpen.set(true);
  }
}
