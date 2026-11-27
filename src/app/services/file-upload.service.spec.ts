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

import { TestBed } from '@angular/core/testing';
import { provideHttpClient, withXhr } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { FileUploadService } from './file-upload.service';
import { FileReference } from '../interfaces/entity';
import { advanceTime, useFakeTimeInEachTest } from '../testing/fake-time';
import { provideTranslationTesting } from '../testing/translation-testing';

describe('FileUploadService', () => {
    // Fixed real-time waits raced debounces, polling and change-detection
    // scheduling under CPU starvation; every test runs on fake time
    // (testing/fake-time.ts) and advances it instead.
    useFakeTimeInEachTest();

    let service: FileUploadService;
    let httpMock: HttpTestingController;
    const apiUrl = 'http://localhost:3000/';

    beforeEach(() => {
        TestBed.configureTestingModule({
            providers: [
                provideHttpClient(withXhr()),
                provideHttpClientTesting(),
                provideZonelessChangeDetection(),
                provideTranslationTesting(),
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
        it('should delete file by ID via RPC', async () => {
            const fileId = '019a1781-bc15-706b-99ee-6b62b24e223c';

            const promise = service.deleteFile(fileId);

            const req = httpMock.expectOne(r => r.url.includes('rpc/delete_file_record'));
            expect(req.request.method).toBe('POST');
            expect(req.request.body).toEqual({ p_file_id: fileId });
            req.flush({});

            await promise;
            // Test passes if no error thrown
        });
    });

    describe('uploadFile - full workflow (v0.88.0: the database issues the upload)', () => {
        const fileId = '019a1781-bc15-706b-99ee-6b62b24e223c';
        const key = (ext: string, type = 'Issue', id = '1') => `${type}/${id}/${fileId}/original.${ext}`;
        const issued = (ext: string, isPublic = false, type = 'Issue', id = '1') => ({
            url: `http://localhost:9000/civic-os-files/${key(ext, type, id)}?X-Amz-Signature=abc`,
            file_id: fileId, bucket: 'civic-os-files', key: key(ext, type, id), is_public: isPublic
        });
        const record = (ext: string, fileType: string, status: FileReference['thumbnail_status']): FileReference => ({
            id: fileId, entity_type: 'Issue', entity_id: '1', file_name: `test.${ext}`, file_type: fileType, file_size: 4,
            s3_bucket: 'civic-os-files', s3_key_prefix: `Issue/1/${fileId}`, s3_original_key: key(ext),
            thumbnail_status: status, created_at: '2025-01-15T10:30:00Z', updated_at: '2025-01-15T10:30:00Z',
            url: `http://localhost:9000/civic-os-files/${key(ext)}?X-Amz-Signature=view`
        });

        it('issues, uploads, registers and waits for thumbnails, with no polling for the URL', async () => {
            const file = new File(['test'], 'test.jpg', { type: 'image/jpeg' });
            const created = record('jpg', 'image/jpeg', 'pending');
            const done: FileReference = { ...created, thumbnail_status: 'completed', thumb_small_url: 'http://s/small?sig' };

            const promise = service.uploadFile(file, 'Issue', '1', true);
            await advanceTime(10);

            const req = httpMock.expectOne(r => r.url.endsWith('rpc/request_file_upload'));
            expect(req.request.method).toBe('POST');
            expect(req.request.body).toEqual({ p_entity_type: 'Issue', p_entity_id: '1', p_file_name: 'test.jpg', p_file_type: 'image/jpeg' });
            req.flush(issued('jpg'));
            await advanceTime(10);

            const put = httpMock.expectOne(issued('jpg').url);
            expect(put.request.method).toBe('PUT');
            expect(put.request.headers.get('Content-Type')).toBe('image/jpeg');
            expect(put.request.headers.has('x-amz-acl')).toBe(false);
            put.flush({});
            await advanceTime(10);

            const create = httpMock.expectOne(r => r.url.includes('rpc/create_file_record'));
            expect(create.request.body).toEqual(expect.objectContaining({
                p_id: fileId, p_s3_bucket: 'civic-os-files', p_s3_original_key: key('jpg'), p_thumbnail_status: 'pending'
            }));
            create.flush(created);

            await advanceTime(1050);
            httpMock.expectOne(r => r.url.includes('thumbnail_status')).flush([{ thumbnail_status: 'processing' }]);
            await advanceTime(1050);
            httpMock.expectOne(r => r.url.includes('thumbnail_status')).flush([{ thumbnail_status: 'completed' }]);
            await advanceTime(10);
            httpMock.expectOne(r => r.url.includes('files?id=eq')).flush([done]);

            expect(await promise).toEqual(done);
            httpMock.expectNone(r => r.url.includes('get_upload_url') || r.url.includes('request_upload_url'));
        }, 5000);

        it('returns the registered record (with its URLs) when not waiting for thumbnails', async () => {
            const file = new File(['test'], 'test.txt', { type: 'text/plain' });
            const created = record('txt', 'text/plain', 'not_applicable');
            const promise = service.uploadFile(file, 'Issue', '1', false);
            await advanceTime(10);
            httpMock.expectOne(r => r.url.endsWith('rpc/request_file_upload')).flush(issued('txt'));
            await advanceTime(10);
            httpMock.expectOne(issued('txt').url).flush({});
            await advanceTime(10);
            httpMock.expectOne(r => r.url.includes('rpc/create_file_record')).flush(created);

            const result = await promise;
            expect(result).toEqual(created);
            expect(result.url).toContain('X-Amz-Signature');
        });

        it('sends x-amz-acl: public-read only for a public file (a static asset)', async () => {
            const file = new File(['test'], 'logo.png', { type: 'image/png' });
            const promise = service.uploadFile(file, 'static_assets', 'a1', false);
            await advanceTime(10);
            httpMock.expectOne(r => r.url.endsWith('rpc/request_file_upload')).flush(issued('png', true, 'static_assets', 'a1'));
            await advanceTime(10);
            const put = httpMock.expectOne(issued('png', true, 'static_assets', 'a1').url);
            expect(put.request.headers.get('x-amz-acl')).toBe('public-read');
            put.flush({});
            await advanceTime(10);
            httpMock.expectOne(r => r.url.includes('rpc/create_file_record')).flush(record('png', 'image/png', 'pending'));
            await promise;
        });

        it('includes propertyName in the file record when provided, and omits it otherwise', async () => {
            for (const propertyName of ['resume', undefined]) {
                const file = new File(['test'], 'doc.pdf', { type: 'application/pdf' });
                const promise = service.uploadFile(file, 'staff_documents', '5', false, propertyName);
                await advanceTime(10);
                httpMock.expectOne(r => r.url.endsWith('rpc/request_file_upload')).flush(issued('pdf', false, 'staff_documents', '5'));
                await advanceTime(10);
                httpMock.expectOne(issued('pdf', false, 'staff_documents', '5').url).flush({});
                await advanceTime(10);
                const create = httpMock.expectOne(r => r.url.includes('rpc/create_file_record'));
                expect(create.request.body.p_property_name).toBe(propertyName);
                create.flush(record('pdf', 'application/pdf', 'pending'));
                await promise;
            }
        });

        it('shows a translated message when the database has no S3 signing config', async () => {
            const file = new File(['test'], 'test.jpg', { type: 'image/jpeg' });
            const promise = service.uploadFile(file, 'Issue', '1', false);
            const rejected = expect(promise).rejects.toThrowError('File storage is not set up yet');
            await advanceTime(10);
            httpMock.expectOne(r => r.url.endsWith('rpc/request_file_upload'))
                .flush({ code: '55000', message: 'file_storage_not_configured' }, { status: 400, statusText: 'Bad Request' });
            await rejected;
        });

        it('passes other errors through', async () => {
            const file = new File(['test'], 'test.jpg', { type: 'image/jpeg' });
            const promise = service.uploadFile(file, 'Issue', '1', false);
            const rejected = expect(promise).rejects.toBeTruthy();
            await advanceTime(10);
            httpMock.expectOne(r => r.url.endsWith('rpc/request_file_upload'))
                .flush({ code: '42501', message: 'Not authorized to upload static assets' }, { status: 403, statusText: 'Forbidden' });
            await rejected;
        });
    });
});
