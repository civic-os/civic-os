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

import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom, interval, takeWhile, map } from 'rxjs';
import { getPostgrestUrl } from '../config/runtime';
import { FileReference } from '../interfaces/entity';

interface UploadUrlRequest {
  p_entity_type: string;
  p_entity_id: string;
  p_file_name: string;
  p_file_type: string;
}

interface UploadUrlResponse {
  status: string;
  url: string;
  file_id: string;
  error: string | null;
}

@Injectable({
  providedIn: 'root'
})
export class FileUploadService {
  private readonly apiUrl = getPostgrestUrl();

  constructor(private http: HttpClient) {}

  /**
   * Complete file upload workflow
   * 1. Request presigned URL from PostgreSQL
   * 2. Poll until URL is ready
   * 3. Upload file directly to S3
   * 4. Create file record in database
   * 5. Optionally wait for thumbnails
   */
  async uploadFile(
    file: File,
    entityType: string,
    entityId: string,
    waitForThumbnails = false
  ): Promise<FileReference> {
    // Step 1: Request presigned upload URL
    const requestId = await this.requestUploadUrl(file.name, file.type, entityType, entityId);

    // Step 2: Poll for presigned URL (max 10 seconds)
    const { url, file_id } = await this.pollForUrl(requestId);

    // Step 3: Upload file directly to S3
    await this.uploadToS3(url, file);

    // Step 4: Create file record in database
    const fileRecord = await this.createFileRecord(file_id, file.name, file.type, file.size, entityType, entityId, url);

    // Step 5: Optionally wait for thumbnail generation
    if (waitForThumbnails && file.type.startsWith('image/')) {
      await this.waitForThumbnails(file_id);
      // Refetch the file record to get updated thumbnail_status and thumbnail keys
      const updatedRecord = await this.getFile(file_id);
      return updatedRecord || fileRecord;
    }

    return fileRecord;
  }

  /**
   * Request presigned URL from PostgreSQL via RPC
   * Returns request ID for polling
   */
  private async requestUploadUrl(
    fileName: string,
    fileType: string,
    entityType: string,
    entityId: string
  ): Promise<string> {
    const body: UploadUrlRequest = {
      p_entity_type: entityType,
      p_entity_id: entityId,
      p_file_name: fileName,
      p_file_type: fileType
    };

    const response = await firstValueFrom(
      this.http.post<string>(`${this.apiUrl}rpc/request_upload_url`, body)
    );

    return response;
  }

  /**
   * Poll for presigned URL completion
   * Checks every 500ms for up to 10 seconds
   */
  private async pollForUrl(requestId: string): Promise<{ url: string; file_id: string }> {
    const maxAttempts = 20;  // 20 attempts × 500ms = 10 seconds
    let attempt = 0;

    while (attempt < maxAttempts) {
      const response = await firstValueFrom(
        this.http.get<UploadUrlResponse[]>(
          `${this.apiUrl}rpc/get_upload_url?p_request_id=${requestId}`
        )
      );

      const result = response[0];

      if (result.status === 'completed') {
        return { url: result.url, file_id: result.file_id };
      } else if (result.status === 'failed') {
        throw new Error(result.error || 'Failed to get upload URL');
      }

      // Wait 500ms before next attempt
      await new Promise(resolve => setTimeout(resolve, 500));
      attempt++;
    }

    throw new Error('Timeout waiting for upload URL');
  }

  /**
   * Upload file directly to S3 using presigned URL
   */
  private async uploadToS3(presignedUrl: string, file: File): Promise<void> {
    await firstValueFrom(
      this.http.put(presignedUrl, file, {
        headers: {
          'Content-Type': file.type
        }
      })
    );
  }

  /**
   * Create file record in database
   * Extracts S3 key and bucket name from presigned URL
   */
  private async createFileRecord(
    fileId: string,
    fileName: string,
    fileType: string,
    fileSize: number,
    entityType: string,
    entityId: string,
    presignedUrl: string
  ): Promise<FileReference> {
    // Extract S3 bucket and key from presigned URL (before query params)
    // For path-style URLs: http://host/bucket/key
    const url = new URL(presignedUrl);
    const pathWithoutLeadingSlash = url.pathname.substring(1);  // Remove leading /

    // Split path: first segment is bucket, rest is key
    // URL: http://localhost:9000/civic-os-files/Issue/1/.../file.png
    // Bucket: civic-os-files
    // Key: Issue/1/.../file.png
    const pathParts = pathWithoutLeadingSlash.split('/');
    const s3Bucket = pathParts[0];  // First segment is bucket name
    const s3Key = pathParts.slice(1).join('/');  // Rest is the S3 key

    const body = {
      id: fileId,
      entity_type: entityType,
      entity_id: entityId,
      file_name: fileName,
      file_type: fileType,
      file_size: fileSize,
      s3_bucket: s3Bucket,
      s3_original_key: s3Key,
      thumbnail_status: fileType.startsWith('image/') || fileType === 'application/pdf' ? 'pending' : 'not_applicable'
    };

    const response = await firstValueFrom(
      this.http.post<FileReference[]>(
        `${this.apiUrl}files`,
        body,
        {
          headers: {
            'Prefer': 'return=representation'
          }
        }
      )
    );

    // PostgREST returns an array even for single inserts
    return response[0];
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
   * Delete file (soft delete)
   * Note: Actual S3 cleanup should be handled by backend cleanup job
   */
  async deleteFile(fileId: string): Promise<void> {
    await firstValueFrom(
      this.http.delete(`${this.apiUrl}files?id=eq.${fileId}`)
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
