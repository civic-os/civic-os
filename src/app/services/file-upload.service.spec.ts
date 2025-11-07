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

import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { FileUploadService } from './file-upload.service';
import { FileReference } from '../interfaces/entity';

describe('FileUploadService', () => {
  let service: FileUploadService;
  let httpMock: HttpTestingController;
  const apiUrl = 'http://localhost:3000/';

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideZonelessChangeDetection(),
        FileUploadService
      ]
    });
    service = TestBed.inject(FileUploadService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  describe('validateFile', () => {
    it('should accept valid file type', () => {
      const file = new File(['test'], 'test.jpg', { type: 'image/jpeg' });
      const result = service.validateFile(file, 'image/jpeg,image/png', 5000000);

      expect(result).toBeNull();
    });

    it('should accept wildcard file type', () => {
      const file = new File(['test'], 'test.jpg', { type: 'image/jpeg' });
      const result = service.validateFile(file, 'image/*', 5000000);

      expect(result).toBeNull();
    });

    it('should reject invalid file type', () => {
      const file = new File(['test'], 'test.txt', { type: 'text/plain' });
      const result = service.validateFile(file, 'image/jpeg,image/png', 5000000);

      expect(result).toContain('not allowed');
    });

    it('should reject file exceeding max size', () => {
      const file = new File(['x'.repeat(6000000)], 'test.jpg', { type: 'image/jpeg' });
      const result = service.validateFile(file, 'image/*', 5000000);

      expect(result).toContain('exceeds maximum');
    });

    it('should accept file within size limit', () => {
      const file = new File(['x'.repeat(4000000)], 'test.jpg', { type: 'image/jpeg' });
      const result = service.validateFile(file, 'image/*', 5000000);

      expect(result).toBeNull();
    });

    it('should accept any type when allowedTypes is undefined', () => {
      const file = new File(['test'], 'test.txt', { type: 'text/plain' });
      const result = service.validateFile(file, undefined, 5000000);

      expect(result).toBeNull();
    });

    it('should accept any size when maxSizeBytes is undefined', () => {
      const file = new File(['x'.repeat(10000000)], 'test.jpg', { type: 'image/jpeg' });
      const result = service.validateFile(file, 'image/*', undefined);

      expect(result).toBeNull();
    });
  });

  describe('getFile', () => {
    it('should retrieve file by ID', async () => {
      const fileId = '019a1781-bc15-706b-99ee-6b62b24e223c';
      const mockFile: FileReference = {
        id: fileId,
        entity_type: 'Issue',
        entity_id: '1',
        file_name: 'test.jpg',
        file_type: 'image/jpeg',
        file_size: 1024,
        s3_bucket: 'civic-os-files',
        s3_key_prefix: 'Issue/1/019a1781-bc15-706b-99ee-6b62b24e223c',
        s3_original_key: 'Issue/1/019a1781-bc15-706b-99ee-6b62b24e223c/original.jpg',
        s3_thumbnail_small_key: undefined,
        s3_thumbnail_medium_key: undefined,
        s3_thumbnail_large_key: undefined,
        thumbnail_status: 'pending',
        thumbnail_error: undefined,
        created_at: '2025-01-15T10:30:00Z',
        updated_at: '2025-01-15T10:30:00Z'
      };

      const promise = service.getFile(fileId);

      const req = httpMock.expectOne(r => r.url.includes(`files?id=eq.${fileId}`));
      expect(req.request.method).toBe('GET');
      req.flush([mockFile]);

      const result = await promise;
      expect(result).toEqual(mockFile);
    });

    it('should return null when file not found', async () => {
      const fileId = 'nonexistent';

      const promise = service.getFile(fileId);

      const req = httpMock.expectOne(r => r.url.includes(`files?id=eq.${fileId}`));
      req.flush([]);

      const result = await promise;
      expect(result).toBeNull();
    });
  });

  describe('deleteFile', () => {
    it('should delete file by ID', async () => {
      const fileId = '019a1781-bc15-706b-99ee-6b62b24e223c';

      const promise = service.deleteFile(fileId);

      const req = httpMock.expectOne(r => r.url.includes(`files?id=eq.${fileId}`));
      expect(req.request.method).toBe('DELETE');
      req.flush({});

      await promise;
      // Test passes if no error thrown
    });
  });

  describe('uploadFile - full workflow', () => {
    it('should complete full upload workflow with thumbnails', async () => {
      const file = new File(['test'], 'test.jpg', { type: 'image/jpeg' });
      const entityType = 'Issue';
      const entityId = '1';
      const requestId = 'req-123';
      const fileId = '019a1781-bc15-706b-99ee-6b62b24e223c';
      const presignedUrl = 'http://localhost:9000/civic-os-files/Issue/1/019a1781-bc15-706b-99ee-6b62b24e223c/original.jpg?signature=abc';

      const mockFileRef: FileReference = {
        id: fileId,
        entity_type: entityType,
        entity_id: entityId,
        file_name: 'test.jpg',
        file_type: 'image/jpeg',
        file_size: 4,
        s3_bucket: 'civic-os-files',
        s3_key_prefix: 'Issue/1/019a1781-bc15-706b-99ee-6b62b24e223c',
        s3_original_key: 'Issue/1/019a1781-bc15-706b-99ee-6b62b24e223c/original.jpg',
        s3_thumbnail_small_key: undefined,
        s3_thumbnail_medium_key: undefined,
        s3_thumbnail_large_key: undefined,
        thumbnail_status: 'pending',
        thumbnail_error: undefined,
        created_at: '2025-01-15T10:30:00Z',
        updated_at: '2025-01-15T10:30:00Z'
      };

      const updatedFileRef: FileReference = {
        ...mockFileRef,
        s3_thumbnail_small_key: 'Issue/1/019a1781-bc15-706b-99ee-6b62b24e223c/thumb-small.jpg',
        s3_thumbnail_medium_key: 'Issue/1/019a1781-bc15-706b-99ee-6b62b24e223c/thumb-medium.jpg',
        s3_thumbnail_large_key: 'Issue/1/019a1781-bc15-706b-99ee-6b62b24e223c/thumb-large.jpg',
        thumbnail_status: 'completed'
      };

      // Start the upload workflow
      const promise = service.uploadFile(file, entityType, entityId, true);

      // Small delay to let the first HTTP request initiate
      await new Promise(resolve => setTimeout(resolve, 10));

      // Step 1: Request presigned URL
      const reqUrl = httpMock.expectOne(r => r.url.includes('request_upload_url'));
      expect(reqUrl.request.method).toBe('POST');
      reqUrl.flush(requestId);

      // Small delay to let polling start
      await new Promise(resolve => setTimeout(resolve, 10));

      // Step 2: Poll for URL (first attempt returns pending)
      const reqPoll1 = httpMock.expectOne(r => r.url.includes('get_upload_url'));
      reqPoll1.flush([{ status: 'pending', url: null, file_id: null, error: null }]);

      // Wait for retry delay (500ms) + small buffer
      await new Promise(resolve => setTimeout(resolve, 550));

      // Second poll returns completed
      const reqPoll2 = httpMock.expectOne(r => r.url.includes('get_upload_url'));
      reqPoll2.flush([{ status: 'completed', url: presignedUrl, file_id: fileId, error: null }]);

      // Small delay before S3 upload
      await new Promise(resolve => setTimeout(resolve, 10));

      // Step 3: Upload to S3
      const reqS3 = httpMock.expectOne(presignedUrl);
      expect(reqS3.request.method).toBe('PUT');
      reqS3.flush({});

      // Small delay before file creation
      await new Promise(resolve => setTimeout(resolve, 10));

      // Step 4: Create file record
      const reqCreate = httpMock.expectOne(r => r.url.endsWith('files'));
      expect(reqCreate.request.method).toBe('POST');
      reqCreate.flush([mockFileRef]);

      // Wait for interval polling to start (1000ms delay before first poll)
      await new Promise(resolve => setTimeout(resolve, 1050));

      // Step 5: Wait for thumbnails (first attempt returns processing)
      const reqThumb1 = httpMock.expectOne(r => r.url.includes('thumbnail_status'));
      reqThumb1.flush([{ thumbnail_status: 'processing' }]);

      // Wait for second poll (1000ms interval)
      await new Promise(resolve => setTimeout(resolve, 1050));

      // Second attempt returns completed
      const reqThumb2 = httpMock.expectOne(r => r.url.includes('thumbnail_status'));
      reqThumb2.flush([{ thumbnail_status: 'completed' }]);

      // Small delay before refetch
      await new Promise(resolve => setTimeout(resolve, 10));

      // Step 6: Refetch file record
      const reqRefetch = httpMock.expectOne(r => r.url.includes('files?id=eq'));
      reqRefetch.flush([updatedFileRef]);

      const result = await promise;
      expect(result).toEqual(updatedFileRef);
      expect(result.thumbnail_status).toBe('completed');
    }, 5000); // 5 second timeout for thumbnail workflow

    it('should handle upload without waiting for thumbnails', async () => {
      const file = new File(['test'], 'test.txt', { type: 'text/plain' });
      const entityType = 'Issue';
      const entityId = '1';
      const requestId = 'req-456';
      const fileId = '019a1781-bc15-706b-99ee-6b62b24e223d';
      const presignedUrl = 'http://localhost:9000/civic-os-files/Issue/1/019a1781-bc15-706b-99ee-6b62b24e223d/original.txt?signature=def';

      const mockFileRef: FileReference = {
        id: fileId,
        entity_type: entityType,
        entity_id: entityId,
        file_name: 'test.txt',
        file_type: 'text/plain',
        file_size: 4,
        s3_bucket: 'civic-os-files',
        s3_key_prefix: 'Issue/1/019a1781-bc15-706b-99ee-6b62b24e223d',
        s3_original_key: 'Issue/1/019a1781-bc15-706b-99ee-6b62b24e223d/original.txt',
        s3_thumbnail_small_key: undefined,
        s3_thumbnail_medium_key: undefined,
        s3_thumbnail_large_key: undefined,
        thumbnail_status: 'not_applicable',
        thumbnail_error: undefined,
        created_at: '2025-01-15T10:30:00Z',
        updated_at: '2025-01-15T10:30:00Z'
      };

      const promise = service.uploadFile(file, entityType, entityId, false);
      await new Promise(resolve => setTimeout(resolve, 10));

      // Request presigned URL
      const reqUrl = httpMock.expectOne(r => r.url.includes('request_upload_url'));
      reqUrl.flush(requestId);
      await new Promise(resolve => setTimeout(resolve, 10));

      // Poll for URL
      const reqPoll = httpMock.expectOne(r => r.url.includes('get_upload_url'));
      reqPoll.flush([{ status: 'completed', url: presignedUrl, file_id: fileId, error: null }]);
      await new Promise(resolve => setTimeout(resolve, 10));

      // Upload to S3
      const reqS3 = httpMock.expectOne(presignedUrl);
      reqS3.flush({});
      await new Promise(resolve => setTimeout(resolve, 10));

      // Create file record
      const reqCreate = httpMock.expectOne(r => r.url.endsWith('files'));
      reqCreate.flush([mockFileRef]);

      const result = await promise;
      expect(result).toEqual(mockFileRef);
      expect(result.thumbnail_status).toBe('not_applicable');
    });

    it('should handle polling timeout', async () => {
      const file = new File(['test'], 'test.jpg', { type: 'image/jpeg' });
      const requestId = 'req-timeout';

      const promise = service.uploadFile(file, 'Issue', '1', false);
      await new Promise(resolve => setTimeout(resolve, 10));

      // Request presigned URL
      const reqUrl = httpMock.expectOne(r => r.url.includes('request_upload_url'));
      reqUrl.flush(requestId);

      // All 20 polling attempts return pending
      for (let i = 0; i < 20; i++) {
        await new Promise(resolve => setTimeout(resolve, 550));
        const reqPoll = httpMock.expectOne(r => r.url.includes('get_upload_url'));
        reqPoll.flush([{ status: 'pending', url: null, file_id: null, error: null }]);
      }

      await expectAsync(promise).toBeRejectedWithError('Timeout waiting for upload URL');
    }, 15000); // 15 second timeout for this test

    it('should handle presigned URL request failure', async () => {
      const file = new File(['test'], 'test.jpg', { type: 'image/jpeg' });
      const requestId = 'req-fail';

      const promise = service.uploadFile(file, 'Issue', '1', false);
      await new Promise(resolve => setTimeout(resolve, 10));

      // Request presigned URL
      const reqUrl = httpMock.expectOne(r => r.url.includes('request_upload_url'));
      reqUrl.flush(requestId);
      await new Promise(resolve => setTimeout(resolve, 10));

      // Poll returns failed status
      const reqPoll = httpMock.expectOne(r => r.url.includes('get_upload_url'));
      reqPoll.flush([{ status: 'failed', url: null, file_id: null, error: 'S3 error' }]);

      await expectAsync(promise).toBeRejectedWithError('S3 error');
    });
  });
});
