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

import { Component, input, computed, signal, effect, inject, ChangeDetectionStrategy } from '@angular/core';
import { RouterLink } from '@angular/router';
import { DashboardWidget, ImageWidgetConfig, StaticAsset } from '../../../interfaces/dashboard';
import { StaticAssetsService } from '../../../services/static-assets.service';
import { DEFAULT_BREAKPOINTS } from '../../../services/static-assets.service';
import { getS3Config } from '../../../config/runtime';

/**
 * Image Widget Component (v0.38.0)
 *
 * Displays a static image asset with art-directed responsive crops.
 * Uses <picture>/<source> elements to serve the right crop per breakpoint:
 * - Desktop (>=1024px): desktop_file crop
 * - Tablet (>=768px): tablet_file crop
 * - Mobile (fallback): mobile_file crop
 *
 * Within each breakpoint, uses srcset with medium (400px) and large (800px)
 * thumbnail variants for resolution switching (1x/2x displays).
 *
 * Widget Config (JSONB):
 * {
 *   "static_asset": "homepage-hero",   // slug (required)
 *   "objectFit": "cover",              // CSS object-fit (optional, default: 'cover')
 *   "maxHeight": "300px",              // CSS max-height (optional)
 *   "linkUrl": "/view/events"          // Click navigates here (optional)
 * }
 */
@Component({
  selector: 'app-image-widget',
  imports: [RouterLink],
  templateUrl: './image-widget.component.html',
  styleUrl: './image-widget.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ImageWidgetComponent {
  private staticAssetsService = inject(StaticAssetsService);

  // Widget configuration from parent (WidgetContainerComponent)
  widget = input.required<DashboardWidget>();

  // Extract typed config
  config = computed<ImageWidgetConfig>(() => {
    return this.widget().config as ImageWidgetConfig;
  });

  // Component state
  asset = signal<StaticAsset | null>(null);
  isLoading = signal(true);
  error = signal<string | null>(null);

  // Derived display values
  linkUrl = computed(() => this.config().linkUrl || null);
  altText = computed(() => this.asset()?.alt_text || this.asset()?.display_name || '');

  // Fallback src for the <img> element (mobile crop preferred, then tablet, then desktop)
  fallbackSrc = computed(() =>
    this.getSrcForBreakpoint('mobile') || this.getSrcForBreakpoint('tablet') || this.getSrcForBreakpoint('desktop')
  );

  // Breakpoint definitions
  breakpoints = DEFAULT_BREAKPOINTS;

  constructor() {
    // Fetch asset whenever slug changes
    effect(() => {
      const slug = this.config().static_asset;
      if (!slug) {
        this.error.set('No static_asset slug configured');
        this.isLoading.set(false);
        return;
      }

      this.isLoading.set(true);
      this.error.set(null);

      this.staticAssetsService.getBySlug(slug).subscribe({
        next: (result) => {
          if (result) {
            this.asset.set(result);
          } else {
            this.error.set(`Static asset "${slug}" not found`);
          }
          this.isLoading.set(false);
        },
        error: (err) => {
          this.error.set(`Failed to load asset: ${err.message}`);
          this.isLoading.set(false);
        }
      });
    });
  }

  /**
   * Get S3 URL for a file key.
   * Same pattern as ImageViewerComponent.
   */
  getS3Url(s3Key: string | null | undefined): string {
    if (!s3Key) return '';
    const s3Config = getS3Config();
    return `${s3Config.endpoint}/${s3Config.bucket}/${s3Key}`;
  }

  /**
   * Get the <source> srcset for a breakpoint.
   * Uses the original crop file directly — static asset crops are already
   * pre-sized (1200px wide) so square thumbnails would distort the aspect ratio.
   */
  getSrcsetForBreakpoint(breakpointKey: string): string {
    const a = this.asset() as any;
    if (!a) return '';

    const fileData = a[`${breakpointKey}_file`];
    if (!fileData) return '';

    if (fileData.s3_original_key) {
      return this.getS3Url(fileData.s3_original_key);
    }
    return '';
  }

  /**
   * Get the fallback src for a breakpoint.
   * Uses the original crop — thumbnails are square-padded and unsuitable for display.
   */
  getSrcForBreakpoint(breakpointKey: string): string {
    const a = this.asset() as any;
    if (!a) return '';

    const fileData = a[`${breakpointKey}_file`];
    if (!fileData) return '';

    return this.getS3Url(fileData.s3_original_key);
  }

  /**
   * Check if a breakpoint crop exists.
   */
  hasBreakpointCrop(breakpointKey: string): boolean {
    const a = this.asset() as any;
    return !!a && a[`${breakpointKey}_file`] != null;
  }
}
