/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 */

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { PhotoGalleryEditorComponent } from './photo-gallery-editor.component';
import { GalleryService } from '../../services/gallery.service';
import { FileUploadService } from '../../services/file-upload.service';
import { GalleryImage, PhotoGalleryConfig } from '../../interfaces/entity';
import { provideTranslationTesting } from '../../testing/translation-testing';

describe('PhotoGalleryEditorComponent', () => {
  let component: PhotoGalleryEditorComponent;
  let fixture: ComponentFixture<PhotoGalleryEditorComponent>;

  const mockConfig: PhotoGalleryConfig = {
    table_name: 'issues',
    column_name: 'photos',
    max_images: 10,
    allowed_types: 'image/jpeg,image/png',
    max_file_size: 5242880
  };

  const mockImages: GalleryImage[] = [
    {
      file_id: 'file-1', sort_order: 0, caption: null, alt_text: null,
      created_at: '2026-01-01',
      file: {
        id: 'file-1', file_name: 'photo1.jpg', file_type: 'image/jpeg', file_size: 1024,
        entity_type: 'photo_gallery', entity_id: 'gal-1', s3_bucket: 'test',
        s3_key_prefix: 'p', s3_original_key: 'p/original.jpg',
        s3_thumbnail_medium_key: 'p/thumb_400.jpg',
        thumbnail_status: 'completed', created_at: '2026-01-01', updated_at: '2026-01-01'
      }
    },
    {
      file_id: 'file-2', sort_order: 1, caption: 'Caption 2', alt_text: null,
      created_at: '2026-01-02',
      file: {
        id: 'file-2', file_name: 'photo2.png', file_type: 'image/png', file_size: 2048,
        entity_type: 'photo_gallery', entity_id: 'gal-1', s3_bucket: 'test',
        s3_key_prefix: 'p', s3_original_key: 'p/original.png',
        s3_thumbnail_medium_key: 'p/thumb_400.png',
        thumbnail_status: 'completed', created_at: '2026-01-02', updated_at: '2026-01-02'
      }
    }
  ];

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [PhotoGalleryEditorComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideTranslationTesting(),
        GalleryService,
        { provide: FileUploadService, useValue: {} }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(PhotoGalleryEditorComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('entityType', 'issues');
    fixture.componentRef.setInput('columnName', 'photos');
    fixture.componentRef.setInput('config', mockConfig);
    fixture.componentRef.setInput('currentFiles', mockImages);
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should initialize images from input', () => {
    expect(component.images().length).toBe(2);
    expect(component.images()[0].file_id).toBe('file-1');
  });

  it('should compute currentCount correctly', () => {
    expect(component.currentCount()).toBe(2);
  });

  it('should compute maxImages from config', () => {
    expect(component.maxImages()).toBe(10);
  });

  it('should not be at max with 2 of 10', () => {
    expect(component.atMax()).toBe(false);
  });

  it('should be at max when images equal max_images', () => {
    // Set images directly (currentFiles only syncs on initial load)
    const tenImages = Array.from({ length: 10 }, (_, i) => ({
      ...mockImages[0],
      file_id: `file-${i}`,
      sort_order: i
    }));
    component.images.set(tenImages);

    expect(component.atMax()).toBe(true);
  });

  it('should compute acceptTypes from config', () => {
    expect(component.acceptTypes()).toBe('image/jpeg,image/png');
  });

  it('should open lightbox at correct index', () => {
    component.openLightbox(1);
    expect(component.lightboxOpen()).toBe(true);
    expect(component.lightboxIndex()).toBe(1);
  });

  it('should generate S3 URL', () => {
    const url = component.getS3Url('some/key.jpg');
    expect(url).toContain('some/key.jpg');
  });

  it('should get thumbnail URL from file', () => {
    const url = component.getThumbUrl(mockImages[0]);
    expect(url).toContain('thumb_400.jpg');
  });

  describe('Keyboard Reorder (move buttons)', () => {
    it('moveLater should reorder images, flag reorder dirty, and announce position', () => {
      component.moveLater(0); // Move first image later

      expect(component.images()[0].file_id).toBe('file-2');
      expect(component.images()[1].file_id).toBe('file-1');
      expect(component.hasPendingChanges()).toBe(true);
      // Announcement references the new position (2 of 2)
      expect(component.reorderAnnouncement()).toContain('2');
    });

    it('moveEarlier should reorder images back to original order', () => {
      component.moveLater(0);
      component.moveEarlier(1); // Move it back

      expect(component.images()[0].file_id).toBe('file-1');
      expect(component.images()[1].file_id).toBe('file-2');
    });

    it('should not reorder past a boundary', () => {
      component.moveEarlier(0); // First image cannot move earlier

      expect(component.images()[0].file_id).toBe('file-1');
      expect(component.images()[1].file_id).toBe('file-2');
    });
  });
});
