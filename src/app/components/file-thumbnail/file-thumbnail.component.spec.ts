/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 */

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { FileThumbnailComponent } from './file-thumbnail.component';
import { FileReference } from '../../interfaces/entity';

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
    updated_at: '2026-01-01'
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [FileThumbnailComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
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
      s3_thumbnail_small_key: undefined,
      s3_thumbnail_medium_key: undefined,
      s3_thumbnail_large_key: undefined,
      thumbnail_status: 'pending'
    };
    fixture.componentRef.setInput('file', fileNoThumb);
    fixture.detectChanges();

    expect(component.thumbnailUrl()).toContain('original.jpg');
    expect(component.isLoading()).toBe(false); // Has original to show
  });

  it('should show loading state when no image keys available', () => {
    const pendingFile: FileReference = {
      ...mockFile,
      s3_original_key: '',
      s3_thumbnail_small_key: undefined,
      s3_thumbnail_medium_key: undefined,
      s3_thumbnail_large_key: undefined,
      thumbnail_status: 'pending'
    };
    fixture.componentRef.setInput('file', pendingFile);
    fixture.detectChanges();

    expect(component.thumbnailUrl()).toBeNull();
    expect(component.isLoading()).toBe(true);
  });

  it('should show failed state when thumbnail failed and no keys', () => {
    const failedFile: FileReference = {
      ...mockFile,
      s3_original_key: '',
      s3_thumbnail_small_key: undefined,
      s3_thumbnail_medium_key: undefined,
      s3_thumbnail_large_key: undefined,
      thumbnail_status: 'failed'
    };
    fixture.componentRef.setInput('file', failedFile);
    fixture.detectChanges();

    expect(component.isFailed()).toBe(true);
    expect(component.isLoading()).toBe(false);
  });

  it('should not show loading when file has original key even if pending', () => {
    const pendingWithOriginal: FileReference = {
      ...mockFile,
      s3_thumbnail_medium_key: undefined,
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
});
