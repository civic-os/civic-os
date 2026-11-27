/**
 * Copyright (C) 2023-2026 Civic OS, L3C
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
import { Component, input, signal, computed, inject, Injector, ChangeDetectionStrategy, ViewChild } from '@angular/core';
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
import { FileAccessService } from '../../services/file-access.service';
import { getContrastTextColor } from '../../utils/color.utils';
import { MarkdownModule } from 'ngx-markdown';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { HelpToggletipComponent } from '../help-toggletip/help-toggletip.component';
import { ContrastTextDirective } from '../../directives/contrast-text.directive';
import { compareBySortOrder } from '@civic-os/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { of, switchMap } from 'rxjs';
import { DimensionService } from '../../services/dimension.service';
import { formatTreeLabel } from '../../utils/tree-path';

@Component({
    selector: 'app-display-property',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [
    HelpToggletipComponent,
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
        MarkdownModule,
        TranslatePipe,
        ContrastTextDirective,
    ],
    templateUrl: './display-property.component.html',
    styleUrl: './display-property.component.css'
})
export class DisplayPropertyComponent {
  /** Whether the field description is shown under the label (the label's help toggletip, issue #130). */
  readonly descriptionOpen = signal(false);
  /** id of the shown description, unique per field on a page. */
  readonly helpPanelId = computed(() => `display-help-${this.prop().table_name}-${this.prop().column_name}`);

  @ViewChild(ImageViewerComponent) imageViewer?: ImageViewerComponent;
  @ViewChild(PdfViewerComponent) pdfViewer?: PdfViewerComponent;

  prop = input.required<SchemaEntityProperty>({ alias: 'property' });
  datum = input<any>();
  linkRelated = input<boolean>(true);
  showLabel = input<boolean>(true);
  compact = input<boolean>(false);
  highlightTerms = input<string[]>([]);
  /**
   * Dimension values only (v0.86.0): show the row's ancestors after its label, "Shovels (Hand Tools › Digging
   * & Soil)". Detail turns it on; List and other compact contexts keep the label alone. The label renders at
   * once and the ancestors follow from one flat request for the dimension table.
   */
  showPath = input<boolean>(false);

  propType = computed(() => this.prop().type);

  // Resolved only when a Dimension path is shown, so contexts that never show one need no HTTP providers
  private readonly injector = inject(Injector);
  private readonly fileAccess = inject(FileAccessService);
  private readonly ancestorLabels = toSignal(
    toObservable(
      computed(() => ({ prop: this.prop(), id: this.datum()?.id, on: this.showPath() }), {
        equal: (a, b) => a.prop === b.prop && a.id === b.id && a.on === b.on,
      }),
    ).pipe(
      switchMap(({ prop, id, on }) =>
        on && prop.type === EntityPropertyType.Dimension
          ? this.injector.get(DimensionService).getAncestorLabels(prop, id)
          : of([]),
      ),
    ),
    { initialValue: [] as string[] },
  );

  /** A Dimension value's display text: its label, then its ancestors in parentheses when showPath is on. */
  readonly dimensionText = computed(() => formatTreeLabel(this.datum()?.display_name ?? '', this.ancestorLabels()));
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
    const parts = [...meta.extraColumns]
      .sort(compareBySortOrder)
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
   * Download a generic file under its name with a URL read at click time (signed URLs expire, v0.88.0).
   * The link's href stays usable for a middle-click or "open in new tab" while it is fresh.
   */
  onFileDownload(event: Event, file: FileReference) {
    event.preventDefault();
    void this.fileAccess.download(file);
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
   * Open gallery lightbox at specified index.
   */
  onGalleryImageClick(index: number): void {
    this.galleryLightboxIndex.set(index);
    this.galleryLightboxOpen.set(true);
  }
}
