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

import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, map, catchError, of } from 'rxjs';
import { GalleryImage, PhotoGalleryConfig } from '../interfaces/entity';
import { getPostgrestUrl } from '../config/runtime';

/**
 * Service for managing photo galleries.
 * Wraps PostgREST RPC calls for gallery CRUD operations.
 *
 * Gallery lifecycle:
 * - Detail/Edit pages: `addImage()` lazy-creates gallery if needed
 * - Create pages: `createDraftGallery()` → upload files → `linkGalleryToEntity()` after entity creation
 *
 * Added in v0.47.0.
 */
@Injectable({ providedIn: 'root' })
export class GalleryService {
  private http = inject(HttpClient);

  /**
   * Create a draft gallery (entity_id = NULL) for Create page workflow.
   * Files can be uploaded immediately; gallery is linked after entity creation.
   * @returns gallery_id UUID
   */
  createDraftGallery(entityType: string, propertyName: string): Observable<string> {
    return this.http.post<string>(
      getPostgrestUrl() + 'rpc/create_draft_gallery',
      { p_entity_type: entityType, p_property_name: propertyName }
    );
  }

  /**
   * Link a draft gallery to a newly created entity and set the FK column.
   * Called after entity POST on Create page.
   */
  linkGalleryToEntity(galleryId: string, entityType: string, entityId: string, columnName: string): Observable<void> {
    return this.http.post<void>(
      getPostgrestUrl() + 'rpc/link_gallery_to_entity',
      {
        p_gallery_id: galleryId,
        p_entity_type: entityType,
        p_entity_id: entityId,
        p_column_name: columnName
      }
    );
  }

  /**
   * Add an image to a gallery on an existing entity.
   * Lazy-creates gallery if none exists for this entity+column.
   * @returns gallery_id UUID (new or existing)
   */
  addImage(
    entityType: string, entityId: string, columnName: string,
    fileId: string, sortOrder: number = 0, caption?: string, altText?: string
  ): Observable<string> {
    return this.http.post<string>(
      getPostgrestUrl() + 'rpc/add_gallery_image',
      {
        p_entity_type: entityType,
        p_entity_id: entityId,
        p_column_name: columnName,
        p_file_id: fileId,
        p_sort_order: sortOrder,
        p_caption: caption || null,
        p_alt_text: altText || null
      }
    );
  }

  /**
   * Add an image to an existing gallery by ID (for Create page).
   * Gallery must already exist (created via createDraftGallery).
   */
  addImageById(
    galleryId: string, fileId: string, sortOrder: number = 0,
    caption?: string, altText?: string
  ): Observable<void> {
    return this.http.post<void>(
      getPostgrestUrl() + 'rpc/add_gallery_image_by_id',
      {
        p_gallery_id: galleryId,
        p_file_id: fileId,
        p_sort_order: sortOrder,
        p_caption: caption || null,
        p_alt_text: altText || null
      }
    );
  }

  /**
   * Remove an image from a gallery (deletes junction row, file remains).
   */
  removeImage(galleryId: string, fileId: string): Observable<void> {
    return this.http.post<void>(
      getPostgrestUrl() + 'rpc/remove_gallery_image',
      { p_gallery_id: galleryId, p_file_id: fileId }
    );
  }

  /**
   * Reorder gallery images. Array position becomes sort_order.
   */
  reorderImages(galleryId: string, fileIds: string[]): Observable<void> {
    return this.http.post<void>(
      getPostgrestUrl() + 'rpc/reorder_gallery_images',
      { p_gallery_id: galleryId, p_file_ids: fileIds }
    );
  }

  /**
   * Update caption and alt_text for a gallery image.
   */
  updateImageMeta(galleryId: string, fileId: string, caption: string | null, altText: string | null): Observable<void> {
    return this.http.post<void>(
      getPostgrestUrl() + 'rpc/update_gallery_image_meta',
      {
        p_gallery_id: galleryId,
        p_file_id: fileId,
        p_caption: caption,
        p_alt_text: altText
      }
    );
  }

  /**
   * Get gallery configuration for a specific table+column.
   * Returns default config if none configured.
   */
  getConfig(tableName: string, columnName: string): Observable<PhotoGalleryConfig> {
    return this.http.get<PhotoGalleryConfig[]>(
      getPostgrestUrl() + `photo_gallery_config?table_name=eq.${tableName}&column_name=eq.${columnName}`
    ).pipe(
      map(results => results.length > 0 ? results[0] : {
        table_name: tableName,
        column_name: columnName,
        max_images: 20,
        allowed_types: 'image/*',
        max_file_size: null
      })
    );
  }

  /**
   * Get gallery images with full file data via PostgREST embedding.
   * Used when refreshing gallery after mutations.
   */
  getGalleryImages(galleryId: string): Observable<GalleryImage[]> {
    return this.http.get<GalleryImage[]>(
      getPostgrestUrl() + `photo_gallery_files?gallery_id=eq.${galleryId}&order=sort_order&select=file_id,sort_order,caption,alt_text,created_at,file:files!file_id(id,file_name,file_type,file_size,s3_key_prefix,s3_original_key,s3_thumbnail_small_key,s3_thumbnail_medium_key,s3_thumbnail_large_key,thumbnail_status)`
    );
  }

  /**
   * Get image count for a gallery (lightweight, for list page).
   */
  getImageCount(galleryId: string): Observable<number> {
    return this.http.get<any[]>(
      getPostgrestUrl() + `photo_gallery_files?gallery_id=eq.${galleryId}&select=file_id`,
      { observe: 'response' }
    ).pipe(
      map(response => {
        // Use Content-Range header if available, otherwise count results
        const range = response.headers.get('Content-Range');
        if (range) {
          const match = range.match(/\/(\d+)/);
          if (match) return parseInt(match[1], 10);
        }
        return response.body?.length ?? 0;
      }),
      catchError(() => of(0))
    );
  }

  /**
   * Get gallery storage statistics (for admin page).
   */
  getStorageStats(): Observable<any> {
    return this.http.post(
      getPostgrestUrl() + 'rpc/get_gallery_storage_stats',
      {}
    );
  }
}
