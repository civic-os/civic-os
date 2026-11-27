/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 */

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient, withXhr } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { FileThumbnailComponent } from './file-thumbnail.component';
import { FileReference } from '../../interfaces/entity';
import { FileUploadService } from '../../services/file-upload.service';

describe('FileThumbnailComponent', () => {
    let component: FileThumbnailComponent;
    let fixture: ComponentFixture<FileThumbnailComponent>;

    const mockFile: FileReference = {
        id: 'file-1',
        file_name: 'photo.jpg',
        file_type: 'image/jpeg',
        file_size: 1024,
        entity_type: 'issues',
        entity_id: 'issue-1',
        s3_bucket: 'test',
        s3_key_prefix: 'p',
        s3_original_key: 'p/original.jpg',
        s3_thumbnail_small_key: 'p/thumb_150.jpg',
        s3_thumbnail_medium_key: 'p/thumb_400.jpg',
        s3_thumbnail_large_key: 'p/thumb_800.jpg',
        thumbnail_status: 'completed',
        created_at: '2026-01-01',
        updated_at: '2026-01-01',
        url: 'https://s3.test/test/p/original.jpg?X-Amz-Signature=a',
        thumb_small_url: 'https://s3.test/test/p/thumb_150.jpg?X-Amz-Signature=b',
        thumb_medium_url: 'https://s3.test/test/p/thumb_400.jpg?X-Amz-Signature=c',
        thumb_large_url: 'https://s3.test/test/p/thumb_800.jpg?X-Amz-Signature=d'
    };

    beforeEach(async () => {
        await TestBed.configureTestingModule({
            imports: [FileThumbnailComponent],
            providers: [
                provideZonelessChangeDetection(),
                provideHttpClient(withXhr()),
                provideHttpClientTesting()
            ]
        }).compileComponents();

        fixture = TestBed.createComponent(FileThumbnailComponent);
        component = fixture.componentInstance;
    });

    it('should create', () => {
        fixture.detectChanges();
        expect(component).toBeTruthy();
    });

    it('should show medium thumbnail URL by default', () => {
        fixture.componentRef.setInput('file', mockFile);
        fixture.detectChanges();

        expect(component.thumbnailUrl()).toContain('thumb_400.jpg');
    });

    it('should show small thumbnail when preferredSize is small', () => {
        fixture.componentRef.setInput('file', mockFile);
        fixture.componentRef.setInput('preferredSize', 'small');
        fixture.detectChanges();

        expect(component.thumbnailUrl()).toContain('thumb_150.jpg');
    });

    it('should show original when preferredSize is original', () => {
        fixture.componentRef.setInput('file', mockFile);
        fixture.componentRef.setInput('preferredSize', 'original');
        fixture.detectChanges();

        expect(component.thumbnailUrl()).toContain('original.jpg');
    });

    it('should fall back to original when medium thumbnail not available', () => {
        const fileNoThumb: FileReference = {
            ...mockFile,
            thumb_small_url: null,
            thumb_medium_url: null,
            thumb_large_url: null,
            thumbnail_status: 'pending'
        };
        fixture.componentRef.setInput('file', fileNoThumb);
        fixture.detectChanges();

        expect(component.thumbnailUrl()).toContain('original.jpg');
        expect(component.isLoading()).toBe(false); // Has original to show
    });

    it('should show loading state when no image URLs are available', () => {
        const pendingFile: FileReference = {
            ...mockFile,
            url: null,
            thumb_small_url: null,
            thumb_medium_url: null,
            thumb_large_url: null,
            thumbnail_status: 'pending'
        };
        fixture.componentRef.setInput('file', pendingFile);
        fixture.detectChanges();

        expect(component.thumbnailUrl()).toBeNull();
        expect(component.isLoading()).toBe(true);
    });

    it('should show failed state when thumbnail failed and no URLs', () => {
        const failedFile: FileReference = {
            ...mockFile,
            url: null,
            thumb_small_url: null,
            thumb_medium_url: null,
            thumb_large_url: null,
            thumbnail_status: 'failed'
        };
        fixture.componentRef.setInput('file', failedFile);
        fixture.detectChanges();

        expect(component.isFailed()).toBe(true);
        expect(component.isLoading()).toBe(false);
    });

    it('should not show loading when file has an original URL even if pending', () => {
        const pendingWithOriginal: FileReference = {
            ...mockFile,
            thumb_medium_url: null,
            thumb_large_url: null,
            thumbnail_status: 'pending'
        };
        fixture.componentRef.setInput('file', pendingWithOriginal);
        fixture.detectChanges();

        expect(component.isLoading()).toBe(false);
        expect(component.thumbnailUrl()).toContain('original.jpg');
    });

    it('should return null thumbnailUrl when file is null', () => {
        fixture.componentRef.setInput('file', null);
        fixture.detectChanges();

        expect(component.thumbnailUrl()).toBeNull();
    });

    it('never builds a URL from the S3 keys (a record without URLs shows the placeholder)', () => {
        const keysOnly: FileReference = { ...mockFile, url: null, thumb_small_url: null, thumb_medium_url: null, thumb_large_url: null };
        fixture.componentRef.setInput('file', keysOnly);
        fixture.detectChanges();

        expect(component.thumbnailUrl()).toBeNull();
    });

    it('refetches the file once when its image fails to load (an expired signed URL)', async () => {
        const getFile = vi.spyOn(TestBed.inject(FileUploadService), 'getFile')
            .mockResolvedValue({ ...mockFile, thumb_medium_url: 'https://s3.test/test/p/thumb_400.jpg?X-Amz-Signature=fresh' });
        fixture.componentRef.setInput('file', mockFile);
        fixture.detectChanges();

        component.onImageError();
        component.onImageError();
        await Promise.resolve();
        await Promise.resolve();

        expect(getFile).toHaveBeenCalledExactlyOnceWith('file-1');
        expect(component.thumbnailUrl()).toContain('Signature=fresh');
    });
});
