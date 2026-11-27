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
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom, interval, takeWhile, map } from 'rxjs';
import { getPostgrestUrl } from '../config/runtime';
import { FileReference } from '../interfaces/entity';
import { TranslationService } from './translation.service';

/** What `request_file_upload` returns (v0.88.0): the upload the database issued. */
export interface IssuedUpload {
  url: string;
  file_id: string;
  bucket: string;
  key: string;
  is_public: boolean;
}

@Injectable({
  providedIn: 'root'
})
export class FileUploadService {
  private readonly apiUrl = getPostgrestUrl();

  // Track in-flight uploads to prevent duplicates (e.g., double-clicks, re-renders)
  // Key format: "{entityType}:{entityId}:{fileName}"
  private inFlightUploads = new Map<string, Promise<FileReference>>();

  private translation = inject(TranslationService);

  constructor(private http: HttpClient) {}

  /**
   * Complete file upload workflow (v0.88.0: the database signs the upload synchronously)
   * 1. Ask the database to issue an upload (file id, key, presigned PUT)
   * 2. Upload file directly to S3
   * 3. Register the file record (only an upload issued to this user is accepted)
   * 4. Optionally wait for thumbnails
   *
   * Includes duplicate prevention: if upload already in progress for same
   * entityType/entityId/fileName, returns the existing promise instead of
   * starting a new upload (prevents 409 PRIMARY KEY errors on metadata.files)
   */
  async uploadFile(
    file: File,
    entityType: string,
    entityId: string,
    waitForThumbnails = false,
    propertyName?: string
  ): Promise<FileReference> {
    // Generate unique key for this upload request
    const uploadKey = `${entityType}:${entityId}:${file.name}`;

    // Check if upload already in progress
    const existingUpload = this.inFlightUploads.get(uploadKey);
    if (existingUpload) {
      return existingUpload;
    }

    // Start new upload and track the promise
    const uploadPromise = this.performUpload(file, entityType, entityId, waitForThumbnails, propertyName);

    this.inFlightUploads.set(uploadKey, uploadPromise);

    try {
      const result = await uploadPromise;
      return result;
    } finally {
      // Always clean up, even if upload fails
      this.inFlightUploads.delete(uploadKey);
    }
  }

  /**
   * Internal method that performs the actual upload workflow
   */
  private async performUpload(
    file: File,
    entityType: string,
    entityId: string,
    waitForThumbnails: boolean,
    propertyName?: string
  ): Promise<FileReference> {
    // Step 1: The database issues the upload: file id, key and a presigned PUT
    const issued = await this.requestFileUpload(file.name, file.type, entityType, entityId);

    // Step 2: Upload file directly to S3
    await this.uploadToS3(issued, file);

    // Step 3: Register the file record
    const fileRecord = await this.createFileRecord(issued, file.name, file.type, file.size, entityType, entityId, propertyName);
    const file_id = issued.file_id;

    // Step 4: Optionally wait for thumbnail generation
    if (waitForThumbnails && file.type.startsWith('image/')) {
      await this.waitForThumbnails(file_id);
      // Refetch the file record to get updated thumbnail_status and thumbnail keys
      const updatedRecord = await this.getFile(file_id);
      return updatedRecord || fileRecord;
    }

    return fileRecord;
  }

  /**
   * Ask the database to issue one upload (`request_file_upload`). Until the consolidated worker has
   * published the S3 settings the RPC refuses with `file_storage_not_configured`, shown translated.
   */
  private async requestFileUpload(
    fileName: string,
    fileType: string,
    entityType: string,
    entityId: string
  ): Promise<IssuedUpload> {
    try {
      return await firstValueFrom(
        this.http.post<IssuedUpload>(`${this.apiUrl}rpc/request_file_upload`, {
          p_entity_type: entityType,
          p_entity_id: entityId,
          p_file_name: fileName,
          p_file_type: fileType
        })
      );
    } catch (error) {
      if (error instanceof HttpErrorResponse && error.error?.message === 'file_storage_not_configured') {
        throw new Error(this.translation.get('file_upload.storage_not_configured'), { cause: error });
      }
      throw error;
    }
  }

  /**
   * Upload the file directly to S3 with the presigned URL. Only a public file (a static asset) has
   * x-amz-acl: public-read signed into its URL, and S3 refuses an x-amz-* header that was not signed,
   * so the header is sent exactly when the database says the file is public.
   */
  private async uploadToS3(issued: IssuedUpload, file: File): Promise<void> {
    const headers: Record<string, string> = { 'Content-Type': file.type };
    if (issued.is_public) {
      headers['x-amz-acl'] = 'public-read';
    }
    await firstValueFrom(this.http.put(issued.url, file, { headers }));
  }

  /**
   * Register the file via RPC with the bucket and key the database issued
   * (admin pattern: VIEWs for reads, RPCs for writes).
   */
  private async createFileRecord(
    issued: IssuedUpload,
    fileName: string,
    fileType: string,
    fileSize: number,
    entityType: string,
    entityId: string,
    propertyName?: string
  ): Promise<FileReference> {
    const body: Record<string, any> = {
      p_id: issued.file_id,
      p_entity_type: entityType,
      p_entity_id: entityId,
      p_file_name: fileName,
      p_file_type: fileType,
      p_file_size: fileSize,
      p_s3_bucket: issued.bucket,
      p_s3_original_key: issued.key,
      p_thumbnail_status: fileType.startsWith('image/') || fileType === 'application/pdf' ? 'pending' : 'not_applicable'
    };

    if (propertyName) {
      body['p_property_name'] = propertyName;
    }

    return await firstValueFrom(
      this.http.post<FileReference>(
        `${this.apiUrl}rpc/create_file_record`,
        body
      )
    );
  }

  /**
   * Wait for thumbnail generation to complete
   * Polls every 1 second for up to 30 seconds
   */
  private async waitForThumbnails(fileId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const maxTime = 30000;  // 30 seconds
      const pollInterval = 1000;  // 1 second
      const maxAttempts = maxTime / pollInterval;
      let attempt = 0;

      const subscription = interval(pollInterval).pipe(
        map(() => attempt++),
        takeWhile(() => attempt < maxAttempts, true)
      ).subscribe(async () => {
        try {
          const files = await firstValueFrom(
            this.http.get<FileReference[]>(`${this.apiUrl}files?id=eq.${fileId}&select=thumbnail_status`)
          );

          const status = files[0]?.thumbnail_status;

          if (status === 'completed') {
            subscription.unsubscribe();
            resolve();
          } else if (status === 'failed') {
            subscription.unsubscribe();
            resolve();  // Resolve anyway - thumbnail failure shouldn't block upload
          } else if (attempt >= maxAttempts) {
            subscription.unsubscribe();
            resolve();  // Timeout - resolve anyway
          }
        } catch (error) {
          subscription.unsubscribe();
          reject(error);
        }
      });
    });
  }

  /**
   * Get file by ID
   */
  async getFile(fileId: string): Promise<FileReference | null> {
    const response = await firstValueFrom(
      this.http.get<FileReference[]>(`${this.apiUrl}files?id=eq.${fileId}`)
    );

    return response[0] || null;
  }

  /**
   * Delete file via RPC (ownership or admin check enforced server-side)
   * Note: Actual S3 cleanup should be handled by backend cleanup job
   */
  async deleteFile(fileId: string): Promise<void> {
    await firstValueFrom(
      this.http.post(`${this.apiUrl}rpc/delete_file_record`, { p_file_id: fileId })
    );
  }

  /**
   * Validate file before upload
   * Returns error message if invalid, null if valid
   */
  validateFile(file: File, allowedTypes?: string, maxSizeBytes?: number): string | null {
    // Check file type
    if (allowedTypes) {
      const allowed = allowedTypes.split(',').map(t => t.trim());
      const matches = allowed.some(pattern => {
        if (pattern.endsWith('/*')) {
          // Handle wildcards like "image/*"
          const prefix = pattern.replace('/*', '');
          return file.type.startsWith(prefix);
        }
        return file.type === pattern;
      });

      if (!matches) {
        return `File type ${file.type} is not allowed. Allowed types: ${allowedTypes}`;
      }
    }

    // Check file size
    if (maxSizeBytes && file.size > maxSizeBytes) {
      const maxMB = (maxSizeBytes / 1024 / 1024).toFixed(1);
      const actualMB = (file.size / 1024 / 1024).toFixed(1);
      return `File size ${actualMB}MB exceeds maximum ${maxMB}MB`;
    }

    return null;
  }
}
