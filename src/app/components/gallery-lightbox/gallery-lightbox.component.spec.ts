/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 */

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { GalleryLightboxComponent } from './gallery-lightbox.component';
import { GalleryImage } from '../../interfaces/entity';
import { provideTranslationTesting } from '../../testing/translation-testing';

describe('GalleryLightboxComponent', () => {
  let component: GalleryLightboxComponent;
  let fixture: ComponentFixture<GalleryLightboxComponent>;

  const mockImages: GalleryImage[] = [
    {
      file_id: 'file-1',
      sort_order: 0,
      caption: 'First photo',
      alt_text: 'Alt 1',
      created_at: '2026-01-01',
      file: {
        id: 'file-1', file_name: 'photo1.jpg', file_type: 'image/jpeg', file_size: 1024,
        entity_type: 'photo_gallery', entity_id: 'gal-1', s3_bucket: 'test',
        s3_key_prefix: 'photo_gallery/gal-1/file-1', s3_original_key: 'photo_gallery/gal-1/file-1/original.jpg',
        s3_thumbnail_small_key: 'photo_gallery/gal-1/file-1/thumb_150.jpg',
        s3_thumbnail_medium_key: 'photo_gallery/gal-1/file-1/thumb_400.jpg',
        s3_thumbnail_large_key: 'photo_gallery/gal-1/file-1/thumb_800.jpg',
        thumbnail_status: 'completed', created_at: '2026-01-01', updated_at: '2026-01-01'
      }
    },
    {
      file_id: 'file-2',
      sort_order: 1,
      caption: null,
      alt_text: null,
      created_at: '2026-01-02',
      file: {
        id: 'file-2', file_name: 'photo2.jpg', file_type: 'image/jpeg', file_size: 2048,
        entity_type: 'photo_gallery', entity_id: 'gal-1', s3_bucket: 'test',
        s3_key_prefix: 'photo_gallery/gal-1/file-2', s3_original_key: 'photo_gallery/gal-1/file-2/original.jpg',
        thumbnail_status: 'completed', created_at: '2026-01-02', updated_at: '2026-01-02'
      }
    }
  ];

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [GalleryLightboxComponent],
      providers: [provideZonelessChangeDetection(), ...provideTranslationTesting()]
    }).compileComponents();

    fixture = TestBed.createComponent(GalleryLightboxComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('images', mockImages);
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should navigate to next image', () => {
    component.currentIndex.set(0);
    component.next();
    expect(component.currentIndex()).toBe(1);
  });

  it('should wrap around to first image', () => {
    component.currentIndex.set(1);
    component.next();
    expect(component.currentIndex()).toBe(0);
  });

  it('should navigate to previous image', () => {
    component.currentIndex.set(1);
    component.prev();
    expect(component.currentIndex()).toBe(0);
  });

  it('should wrap around to last image on prev from first', () => {
    component.currentIndex.set(0);
    component.prev();
    expect(component.currentIndex()).toBe(1);
  });

  it('should return correct current image', () => {
    component.currentIndex.set(0);
    expect(component.currentImage()?.file_id).toBe('file-1');

    component.currentIndex.set(1);
    expect(component.currentImage()?.file_id).toBe('file-2');
  });

  it('should set index via open()', () => {
    component.open(1);
    expect(component.currentIndex()).toBe(1);
  });

  it('should emit closed event', () => {
    const closedSpy = spyOn(component.closed, 'emit');
    component.close();
    expect(closedSpy).toHaveBeenCalled();
  });

  it('should handle keyboard events when open', () => {
    fixture.componentRef.setInput('isOpen', true);
    fixture.detectChanges();

    component.currentIndex.set(0);
    component.onKeydown(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    expect(component.currentIndex()).toBe(1);

    component.onKeydown(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    expect(component.currentIndex()).toBe(0);
  });

  it('should not navigate on keyboard when closed', () => {
    fixture.componentRef.setInput('isOpen', false);
    fixture.detectChanges();

    component.currentIndex.set(0);
    component.onKeydown(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    expect(component.currentIndex()).toBe(0);
  });
});
