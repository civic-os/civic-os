/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 */

import { TestBed } from '@angular/core/testing';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { GalleryService } from './gallery.service';

describe('GalleryService', () => {
  let service: GalleryService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        GalleryService
      ]
    });
    service = TestBed.inject(GalleryService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  describe('createDraftGallery', () => {
    it('should call create_draft_gallery RPC with correct params', () => {
      service.createDraftGallery('issues', 'photos').subscribe(id => {
        expect(id).toBe('gallery-uuid-1');
      });

      const req = httpMock.expectOne(r => r.url.includes('rpc/create_draft_gallery'));
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual({
        p_entity_type: 'issues',
        p_property_name: 'photos'
      });
      req.flush('gallery-uuid-1');
    });
  });

  describe('linkGalleryToEntity', () => {
    it('should call link_gallery_to_entity RPC', () => {
      service.linkGalleryToEntity('gal-1', 'issues', '42', 'photos').subscribe();

      const req = httpMock.expectOne(r => r.url.includes('rpc/link_gallery_to_entity'));
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual({
        p_gallery_id: 'gal-1',
        p_entity_type: 'issues',
        p_entity_id: '42',
        p_column_name: 'photos'
      });
      req.flush(null);
    });
  });

  describe('addImage', () => {
    it('should call add_gallery_image RPC with correct params', () => {
      service.addImage('issues', '42', 'photos', 'file-uuid-1', 0, 'My caption').subscribe(id => {
        expect(id).toBe('gallery-uuid-1');
      });

      const req = httpMock.expectOne(r => r.url.includes('rpc/add_gallery_image'));
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual({
        p_entity_type: 'issues',
        p_entity_id: '42',
        p_column_name: 'photos',
        p_file_id: 'file-uuid-1',
        p_sort_order: 0,
        p_caption: 'My caption',
        p_alt_text: null
      });
      req.flush('gallery-uuid-1');
    });
  });

  describe('addImageById', () => {
    it('should call add_gallery_image_by_id RPC', () => {
      service.addImageById('gal-1', 'file-1', 2).subscribe();

      const req = httpMock.expectOne(r => r.url.includes('rpc/add_gallery_image_by_id'));
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual({
        p_gallery_id: 'gal-1',
        p_file_id: 'file-1',
        p_sort_order: 2,
        p_caption: null,
        p_alt_text: null
      });
      req.flush(null);
    });
  });

  describe('removeImage', () => {
    it('should call remove_gallery_image RPC', () => {
      service.removeImage('gal-1', 'file-1').subscribe();

      const req = httpMock.expectOne(r => r.url.includes('rpc/remove_gallery_image'));
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual({
        p_gallery_id: 'gal-1',
        p_file_id: 'file-1'
      });
      req.flush(null);
    });
  });

  describe('reorderImages', () => {
    it('should call reorder_gallery_images RPC with file IDs array', () => {
      service.reorderImages('gal-1', ['file-3', 'file-1', 'file-2']).subscribe();

      const req = httpMock.expectOne(r => r.url.includes('rpc/reorder_gallery_images'));
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual({
        p_gallery_id: 'gal-1',
        p_file_ids: ['file-3', 'file-1', 'file-2']
      });
      req.flush(null);
    });
  });

  describe('getConfig', () => {
    it('should fetch config from PostgREST', () => {
      service.getConfig('issues', 'photos').subscribe(config => {
        expect(config.max_images).toBe(10);
        expect(config.allowed_types).toBe('image/jpeg,image/png');
      });

      const req = httpMock.expectOne(r => r.url.includes('photo_gallery_config'));
      req.flush([{
        table_name: 'issues',
        column_name: 'photos',
        max_images: 10,
        allowed_types: 'image/jpeg,image/png',
        max_file_size: null
      }]);
    });

    it('should return default config when no config exists', () => {
      service.getConfig('issues', 'photos').subscribe(config => {
        expect(config.max_images).toBe(20);
        expect(config.allowed_types).toBe('image/*');
      });

      const req = httpMock.expectOne(r => r.url.includes('photo_gallery_config'));
      req.flush([]);
    });
  });

  describe('getGalleryImages', () => {
    it('should fetch images with embedded file data', () => {
      service.getGalleryImages('gal-1').subscribe(images => {
        expect(images.length).toBe(2);
        expect(images[0].file_id).toBe('file-1');
      });

      const req = httpMock.expectOne(r =>
        r.url.includes('photo_gallery_files') && r.url.includes('gallery_id=eq.gal-1')
      );
      req.flush([
        { file_id: 'file-1', sort_order: 0, caption: null, alt_text: null, created_at: '2026-01-01', file: { id: 'file-1', file_name: 'test.jpg' } },
        { file_id: 'file-2', sort_order: 1, caption: 'A photo', alt_text: null, created_at: '2026-01-02', file: { id: 'file-2', file_name: 'test2.jpg' } }
      ]);
    });
  });

  describe('getStorageStats', () => {
    it('should call get_gallery_storage_stats RPC', () => {
      service.getStorageStats().subscribe(stats => {
        expect(stats.total_galleries).toBe(5);
      });

      const req = httpMock.expectOne(r => r.url.includes('rpc/get_gallery_storage_stats'));
      expect(req.request.method).toBe('POST');
      req.flush({ total_galleries: 5, total_images: 23, total_size: 1048576 });
    });
  });
});
