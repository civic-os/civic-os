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

import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable, catchError, map, of } from 'rxjs';
import { getPostgrestUrl } from '../config/runtime';
import { StaticAsset, CropState, CropBreakpoint, CropPresetProfile } from '../interfaces/dashboard';
import { FileReference } from '../interfaces/entity';
import { FileUploadService } from './file-upload.service';
import { AuthService } from './auth.service';

/**
 * Default breakpoint definitions for responsive image crops.
 * Media queries follow mobile-first: mobile is the fallback <img>,
 * tablet and desktop use <source media="...">.
 */
export const DEFAULT_BREAKPOINTS: CropBreakpoint[] = [
  { key: 'desktop', label: 'Desktop', ratio: 16 / 9, mediaQuery: '(min-width: 1024px)' },
  { key: 'tablet', label: 'Tablet', ratio: 4 / 3, mediaQuery: '(min-width: 768px)' },
  { key: 'mobile', label: 'Mobile', ratio: 1, mediaQuery: '' }, // Fallback, no media query
];

/**
 * Preset crop profiles for common use cases.
 */
export const CROP_PRESET_PROFILES: CropPresetProfile[] = [
  {
    name: 'Card Image',
    description: 'Standard responsive image (16:9, 4:3, 1:1)',
    breakpoints: { desktop: 16 / 9, tablet: 4 / 3, mobile: 1 },
  },
  {
    name: 'Hero Banner',
    description: 'Wide cinematic banner (21:9, 16:9, 1:1)',
    breakpoints: { desktop: 21 / 9, tablet: 16 / 9, mobile: 1 },
  },
  {
    name: 'Square Only',
    description: 'Same square crop across all breakpoints',
    breakpoints: { desktop: 1, tablet: 1, mobile: 1 },
  },
];

/**
 * Service for managing static image assets with responsive breakpoint crops.
 *
 * Static assets are standalone images not tied to any entity. They are uploaded
 * and cropped via an admin page, then referenced in dashboard image widgets
 * by their immutable slug.
 */
/**
 * A static asset with its embedded files. Static assets are public files (metadata.file_is_public), so
 * each file's url and thumb_*_url are direct, stable URLs (v0.88.0).
 */
export type StaticAssetFile = Pick<FileReference, 'id' | 'thumbnail_status' | 'url' | 'thumb_small_url' | 'thumb_medium_url' | 'thumb_large_url'>;
export type StaticAssetWithFiles = StaticAsset & {
  original_file?: StaticAssetFile | null;
  desktop_file?: StaticAssetFile | null;
  tablet_file?: StaticAssetFile | null;
  mobile_file?: StaticAssetFile | null;
};

@Injectable({
  providedIn: 'root'
})
export class StaticAssetsService {
  private http = inject(HttpClient);
  private fileUpload = inject(FileUploadService);
  private auth = inject(AuthService);

  /**
   * Check if the current user has permission to manage static assets.
   * Used by the sidebar to conditionally show the menu item.
   * Follows the same pattern as UserManagementService.hasUserManagementAccess().
   */
  hasStaticAssetAccess(): boolean {
    return this.auth.permission('static_assets', 'create')();
  }

  /**
   * Fetch all static assets, ordered by creation date.
   * Includes embedded file metadata for thumbnails via PostgREST resource embedding.
   */
  getAll(): Observable<StaticAssetWithFiles[]> {
    const select = [
      '*',
      'original_file:files!original_file_id(id,s3_original_key,s3_thumbnail_small_key,s3_thumbnail_medium_key,thumbnail_status,url,thumb_small_url,thumb_medium_url,thumb_large_url)',
      'desktop_file:files!desktop_file_id(id,s3_original_key,s3_thumbnail_medium_key,s3_thumbnail_large_key,thumbnail_status,url,thumb_small_url,thumb_medium_url,thumb_large_url)',
      'tablet_file:files!tablet_file_id(id,s3_original_key,s3_thumbnail_medium_key,s3_thumbnail_large_key,thumbnail_status,url,thumb_small_url,thumb_medium_url,thumb_large_url)',
      'mobile_file:files!mobile_file_id(id,s3_original_key,s3_thumbnail_medium_key,s3_thumbnail_large_key,thumbnail_status,url,thumb_small_url,thumb_medium_url,thumb_large_url)',
    ].join(',');

    return this.http.get<StaticAssetWithFiles[]>(
      `${getPostgrestUrl()}static_assets?select=${select}&order=created_at.desc`
    ).pipe(
      catchError(error => {
        console.error('Error fetching static assets:', error);
        return of([]);
      })
    );
  }

  /**
   * Fetch a single static asset by slug.
   * Used by the image widget to resolve asset data for display.
   */
  getBySlug(slug: string): Observable<StaticAssetWithFiles | null> {
    const select = [
      '*',
      'desktop_file:files!desktop_file_id(id,s3_original_key,s3_thumbnail_medium_key,s3_thumbnail_large_key,thumbnail_status,url,thumb_small_url,thumb_medium_url,thumb_large_url)',
      'tablet_file:files!tablet_file_id(id,s3_original_key,s3_thumbnail_medium_key,s3_thumbnail_large_key,thumbnail_status,url,thumb_small_url,thumb_medium_url,thumb_large_url)',
      'mobile_file:files!mobile_file_id(id,s3_original_key,s3_thumbnail_medium_key,s3_thumbnail_large_key,thumbnail_status,url,thumb_small_url,thumb_medium_url,thumb_large_url)',
    ].join(',');

    return this.http.get<StaticAssetWithFiles[]>(
      `${getPostgrestUrl()}static_assets?select=${select}&slug=eq.${encodeURIComponent(slug)}&limit=1`
    ).pipe(
      map(results => results.length > 0 ? results[0] : null),
      catchError(error => {
        console.error(`Error fetching static asset "${slug}":`, error);
        return of(null);
      })
    );
  }

  /**
   * Fetch a single static asset by ID (for editing).
   */
  getById(id: string): Observable<StaticAsset | null> {
    const select = [
      '*',
      'original_file:files!original_file_id(id,s3_original_key,s3_thumbnail_medium_key,thumbnail_status,url,thumb_small_url,thumb_medium_url,thumb_large_url)',
      'desktop_file:files!desktop_file_id(id,s3_original_key,s3_thumbnail_medium_key,s3_thumbnail_large_key,thumbnail_status,url,thumb_small_url,thumb_medium_url,thumb_large_url)',
      'tablet_file:files!tablet_file_id(id,s3_original_key,s3_thumbnail_medium_key,s3_thumbnail_large_key,thumbnail_status,url,thumb_small_url,thumb_medium_url,thumb_large_url)',
      'mobile_file:files!mobile_file_id(id,s3_original_key,s3_thumbnail_medium_key,s3_thumbnail_large_key,thumbnail_status,url,thumb_small_url,thumb_medium_url,thumb_large_url)',
    ].join(',');

    return this.http.get<StaticAsset[]>(
      `${getPostgrestUrl()}static_assets?select=${select}&id=eq.${encodeURIComponent(id)}&limit=1`
    ).pipe(
      map(results => results.length > 0 ? results[0] : null),
      catchError(error => {
        console.error(`Error fetching static asset by ID "${id}":`, error);
        return of(null);
      })
    );
  }

  /**
   * Create a new static asset record.
   * File uploads (original + crops) should be done via FileUploadService first;
   * this method just creates the metadata record linking them together.
   */
  create(asset: {
    display_name: string;
    alt_text?: string;
    original_file_id: string;
    desktop_file_id?: string;
    tablet_file_id?: string;
    mobile_file_id?: string;
    crop_state?: CropState;
  }): Observable<StaticAsset> {
    return this.http.post<StaticAsset>(
      `${getPostgrestUrl()}static_assets`,
      asset,
      { headers: { 'Prefer': 'return=representation' } }
    ).pipe(
      map((result: any) => Array.isArray(result) ? result[0] : result)
    );
  }

  /**
   * Update an existing static asset (e.g., after re-cropping).
   * Only updates provided fields.
   */
  update(id: string, updates: {
    display_name?: string;
    alt_text?: string;
    desktop_file_id?: string;
    tablet_file_id?: string;
    mobile_file_id?: string;
    crop_state?: CropState;
  }): Observable<StaticAsset> {
    return this.http.patch<StaticAsset>(
      `${getPostgrestUrl()}static_assets?id=eq.${encodeURIComponent(id)}`,
      updates,
      { headers: { 'Prefer': 'return=representation' } }
    ).pipe(
      map((result: any) => Array.isArray(result) ? result[0] : result)
    );
  }

  /**
   * Delete a static asset and its associated files.
   */
  delete(id: string): Observable<void> {
    return this.http.delete<void>(
      `${getPostgrestUrl()}static_assets?id=eq.${encodeURIComponent(id)}`
    );
  }

  /**
   * Upload a cropped image blob as a file.
   * Uses the FileUploadService presigned URL workflow.
   * Entity type is 'static_assets' to group files in S3.
   */
  async uploadCroppedImage(
    blob: Blob,
    assetId: string,
    breakpointKey: string,
    waitForThumbnails = true
  ): Promise<string> {
    const fileName = `${breakpointKey}-crop.${blob.type === 'image/png' ? 'png' : 'jpg'}`;
    const file = new File([blob], fileName, { type: blob.type });
    const result = await this.fileUpload.uploadFile(file, 'static_assets', assetId, waitForThumbnails);
    return result.id;
  }
}
