/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 */

import { TestBed } from '@angular/core/testing';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { StaticAssetsService, DEFAULT_BREAKPOINTS, CROP_PRESET_PROFILES } from './static-assets.service';
import { AuthService } from './auth.service';

describe('StaticAssetsService', () => {
  let service: StaticAssetsService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    const mockAuth = jasmine.createSpyObj('AuthService', ['hasPermission']);
    mockAuth.hasPermission.and.returnValue(false);

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: AuthService, useValue: mockAuth },
        StaticAssetsService
      ]
    });
    service = TestBed.inject(StaticAssetsService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  describe('getAll', () => {
    it('should fetch all static assets', () => {
      const mockAssets = [
        { id: '1', slug: 'hero', display_name: 'Hero Banner', created_at: '2026-01-01' },
        { id: '2', slug: 'logo', display_name: 'Logo', created_at: '2026-01-02' }
      ];

      service.getAll().subscribe(assets => {
        expect(assets.length).toBe(2);
        expect(assets[0].slug).toBe('hero');
      });

      const req = httpMock.expectOne(r => r.url.includes('static_assets') && r.url.includes('order=created_at.desc'));
      expect(req.request.method).toBe('GET');
      req.flush(mockAssets);
    });

    it('should return empty array on error', () => {
      service.getAll().subscribe(assets => {
        expect(assets).toEqual([]);
      });

      const req = httpMock.expectOne(r => r.url.includes('static_assets'));
      req.error(new ProgressEvent('error'));
    });
  });

  describe('getBySlug', () => {
    it('should fetch asset by slug', () => {
      const mockAsset = { id: '1', slug: 'hero', display_name: 'Hero Banner' };

      service.getBySlug('hero').subscribe(asset => {
        expect(asset).toBeTruthy();
        expect(asset!.slug).toBe('hero');
      });

      const req = httpMock.expectOne(r => r.url.includes('slug=eq.hero'));
      expect(req.request.method).toBe('GET');
      req.flush([mockAsset]);
    });

    it('should return null when asset not found', () => {
      service.getBySlug('nonexistent').subscribe(asset => {
        expect(asset).toBeNull();
      });

      const req = httpMock.expectOne(r => r.url.includes('slug=eq.nonexistent'));
      req.flush([]);
    });
  });

  describe('create', () => {
    it('should create a static asset', () => {
      const newAsset = {
        display_name: 'Hero Banner',
        original_file_id: 'file-123'
      };

      service.create(newAsset).subscribe(result => {
        expect(result.slug).toBe('hero-banner');
      });

      const req = httpMock.expectOne(r => r.url.includes('static_assets') && r.method === 'POST');
      expect(req.request.headers.get('Prefer')).toBe('return=representation');
      req.flush({ id: '1', slug: 'hero-banner', ...newAsset });
    });
  });

  describe('update', () => {
    it('should update a static asset', () => {
      service.update('1', { display_name: 'Updated Name' }).subscribe(result => {
        expect(result.display_name).toBe('Updated Name');
      });

      const req = httpMock.expectOne(r => r.url.includes('id=eq.1') && r.method === 'PATCH');
      req.flush([{ id: '1', display_name: 'Updated Name' }]);
    });
  });

  describe('delete', () => {
    it('should delete a static asset', () => {
      service.delete('1').subscribe();

      const req = httpMock.expectOne(r => r.url.includes('id=eq.1') && r.method === 'DELETE');
      req.flush(null);
    });
  });

  describe('hasStaticAssetAccess', () => {
    it('should delegate to AuthService.hasPermission', () => {
      const mockAuth = TestBed.inject(AuthService) as jasmine.SpyObj<AuthService>;
      mockAuth.hasPermission.and.returnValue(true);

      const result = service.hasStaticAssetAccess();
      expect(result).toBe(true);
      expect(mockAuth.hasPermission).toHaveBeenCalledWith('static_assets', 'create');
    });

    it('should return false when permission denied', () => {
      const mockAuth = TestBed.inject(AuthService) as jasmine.SpyObj<AuthService>;
      mockAuth.hasPermission.and.returnValue(false);

      const result = service.hasStaticAssetAccess();
      expect(result).toBe(false);
    });
  });

  describe('constants', () => {
    it('should have 3 default breakpoints', () => {
      expect(DEFAULT_BREAKPOINTS.length).toBe(3);
      expect(DEFAULT_BREAKPOINTS.map(bp => bp.key)).toEqual(['desktop', 'tablet', 'mobile']);
    });

    it('should have correct default ratios', () => {
      const desktop = DEFAULT_BREAKPOINTS.find(bp => bp.key === 'desktop');
      const tablet = DEFAULT_BREAKPOINTS.find(bp => bp.key === 'tablet');
      const mobile = DEFAULT_BREAKPOINTS.find(bp => bp.key === 'mobile');

      expect(desktop!.ratio).toBeCloseTo(16 / 9);
      expect(tablet!.ratio).toBeCloseTo(4 / 3);
      expect(mobile!.ratio).toBe(1);
    });

    it('should have preset profiles', () => {
      expect(CROP_PRESET_PROFILES.length).toBe(3);
      expect(CROP_PRESET_PROFILES.map(p => p.name)).toEqual(['Card Image', 'Hero Banner', 'Square Only']);
    });

    it('should have correct media queries', () => {
      const desktop = DEFAULT_BREAKPOINTS.find(bp => bp.key === 'desktop');
      const tablet = DEFAULT_BREAKPOINTS.find(bp => bp.key === 'tablet');
      const mobile = DEFAULT_BREAKPOINTS.find(bp => bp.key === 'mobile');

      expect(desktop!.mediaQuery).toBe('(min-width: 1024px)');
      expect(tablet!.mediaQuery).toBe('(min-width: 768px)');
      expect(mobile!.mediaQuery).toBe(''); // Fallback
    });
  });
});
