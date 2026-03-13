/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 */

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { provideZonelessChangeDetection } from '@angular/core';
import { StaticAssetsPage } from './static-assets.page';
import { StaticAssetsService } from '../../services/static-assets.service';
import { of } from 'rxjs';

describe('StaticAssetsPage', () => {
  let component: StaticAssetsPage;
  let fixture: ComponentFixture<StaticAssetsPage>;
  let mockService: jasmine.SpyObj<StaticAssetsService>;

  beforeEach(async () => {
    mockService = jasmine.createSpyObj('StaticAssetsService', ['getAll', 'create', 'update', 'delete', 'getBySlug', 'getById', 'uploadCroppedImage', 'hasStaticAssetAccess']);
    mockService.getAll.and.returnValue(of([]));

    await TestBed.configureTestingModule({
      imports: [StaticAssetsPage],
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: StaticAssetsService, useValue: mockService }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(StaticAssetsPage);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should load assets on init', () => {
    expect(mockService.getAll).toHaveBeenCalled();
  });

  it('should show empty state when no assets', () => {
    expect(component.hasAssets()).toBe(false);
  });

  it('should display assets when loaded', () => {
    mockService.getAll.and.returnValue(of([
      { id: '1', slug: 'hero', display_name: 'Hero', alt_text: null,
        original_file_id: 'f1', desktop_file_id: null, tablet_file_id: null,
        mobile_file_id: null, crop_state: null, created_by: null,
        created_at: '2026-01-01', updated_at: '2026-01-01' }
    ] as any));
    component.loadAssets();
    fixture.detectChanges();
    expect(component.hasAssets()).toBe(true);
    expect(component.assets().length).toBe(1);
  });

  describe('modals', () => {
    it('should open create modal', () => {
      component.openCreateModal();
      expect(component.showCreateModal()).toBe(true);
      expect(component.cropStep()).toBe('upload');
    });

    it('should close modals and reset state', () => {
      component.openCreateModal();
      component.closeModals();
      expect(component.showCreateModal()).toBe(false);
      expect(component.cropStep()).toBe('upload');
      expect(component.assetName()).toBe('');
    });

    it('should open delete confirmation', () => {
      const mockAsset = { id: '1', slug: 'hero', display_name: 'Hero' } as any;
      component.confirmDelete(mockAsset);
      expect(component.deletingAsset()).toBe(mockAsset);
    });
  });

  describe('crop workflow', () => {
    it('should have correct initial step', () => {
      component.openCreateModal();
      expect(component.cropStep()).toBe('upload');
    });

    it('should progress through crop steps', () => {
      component.cropStep.set('crop-desktop');
      expect(component.getCropStepNumber()).toBe(1);

      component.cropStep.set('crop-tablet');
      expect(component.getCropStepNumber()).toBe(2);

      component.cropStep.set('crop-mobile');
      expect(component.getCropStepNumber()).toBe(3);
    });

    it('should navigate back through crop steps', () => {
      component.cropStep.set('crop-mobile');
      component.goBackCrop();
      expect(component.cropStep()).toBe('crop-tablet');

      component.goBackCrop();
      expect(component.cropStep()).toBe('crop-desktop');

      component.goBackCrop();
      expect(component.cropStep()).toBe('profile');
    });
  });

  describe('aspect ratio lock/unlock', () => {
    it('should default to locked', () => {
      expect(component.ratioLocked()).toBe(true);
    });

    it('should toggle lock state', () => {
      component.toggleRatioLock();
      expect(component.ratioLocked()).toBe(false);

      component.toggleRatioLock();
      expect(component.ratioLocked()).toBe(true);
    });

    it('should reset live ratio when re-locking', () => {
      component.toggleRatioLock(); // unlock
      component.liveRatio.set(2.5);
      expect(component.liveRatio()).toBe(2.5);

      component.toggleRatioLock(); // re-lock
      expect(component.liveRatio()).toBeNull();
    });

    it('should reset lock state when advancing crop steps', () => {
      component.cropStep.set('crop-desktop');
      component.toggleRatioLock(); // unlock
      expect(component.ratioLocked()).toBe(false);

      component.confirmCrop(); // advances to tablet, should reset
      expect(component.ratioLocked()).toBe(true);
      expect(component.liveRatio()).toBeNull();
    });

    it('should display live ratio for common ratios', () => {
      component.liveRatio.set(16 / 9);
      expect(component.liveRatioDisplay()).toBe('16:9');

      component.liveRatio.set(4 / 3);
      expect(component.liveRatioDisplay()).toBe('4:3');

      component.liveRatio.set(1);
      expect(component.liveRatioDisplay()).toBe('1:1');
    });

    it('should approximate non-standard ratios with whole numbers', () => {
      component.liveRatio.set(1.5);
      expect(component.liveRatioDisplay()).toBe('3:2');

      component.liveRatio.set(2.0);
      expect(component.liveRatioDisplay()).toBe('2:1');
    });

    it('should return empty string when no live ratio', () => {
      component.liveRatio.set(null);
      expect(component.liveRatioDisplay()).toBe('');
    });

    it('should reset lock when closing modals', () => {
      component.openCreateModal();
      component.toggleRatioLock();
      expect(component.ratioLocked()).toBe(false);

      component.closeModals();
      expect(component.ratioLocked()).toBe(true);
    });
  });

  describe('crop position memory', () => {
    it('should save cropper positions from imageCropped events', () => {
      component.cropStep.set('crop-desktop');
      const event = {
        blob: new Blob(['test'], { type: 'image/jpeg' }),
        cropperPosition: { x1: 10, y1: 20, x2: 300, y2: 200 },
        imagePosition: { x1: 100, y1: 200, x2: 700, y2: 600 },
        width: 600,
        height: 400
      } as any;

      component.onImageCropped(event);

      expect(component.savedCropperPositions()['desktop']).toEqual({ x1: 10, y1: 20, x2: 300, y2: 200 });
    });

    it('should return saved position for current breakpoint after cropper ready', () => {
      component.savedCropperPositions.set({
        desktop: { x1: 10, y1: 20, x2: 300, y2: 200 }
      });
      component.cropStep.set('crop-desktop');
      // Before cropper ready — gated to prevent feeding position before image loads
      expect(component.currentCropperPosition()).toBeUndefined();
      // After cropper ready — position is available
      component.onCropperReady();
      expect(component.currentCropperPosition()).toEqual({ x1: 10, y1: 20, x2: 300, y2: 200 });
    });

    it('should return undefined for unvisited breakpoints', () => {
      component.onCropperReady();
      component.cropStep.set('crop-tablet');
      expect(component.currentCropperPosition()).toBeUndefined();
    });

    it('should preserve positions when navigating back and forward', () => {
      // Simulate desktop crop
      component.cropStep.set('crop-desktop');
      component.onImageCropped({
        blob: new Blob(['test']),
        cropperPosition: { x1: 10, y1: 20, x2: 300, y2: 200 },
        imagePosition: { x1: 0, y1: 0, x2: 600, y2: 400 },
        width: 600, height: 400
      } as any);

      // Advance to tablet
      component.confirmCrop();
      expect(component.cropStep()).toBe('crop-tablet');

      // Go back to desktop — position should still be saved
      component.goBackCrop();
      expect(component.cropStep()).toBe('crop-desktop');
      expect(component.savedCropperPositions()['desktop']).toEqual({ x1: 10, y1: 20, x2: 300, y2: 200 });
    });

    it('should save and restore lock state per breakpoint', () => {
      component.cropStep.set('crop-desktop');
      component.toggleRatioLock(); // unlock desktop
      expect(component.ratioLocked()).toBe(false);

      component.confirmCrop(); // advance to tablet (saves desktop=unlocked)
      expect(component.ratioLocked()).toBe(true); // tablet starts locked

      component.goBackCrop(); // back to desktop (restores desktop=unlocked)
      expect(component.ratioLocked()).toBe(false);
    });

    it('should clear saved positions on modal close', () => {
      component.savedCropperPositions.set({
        desktop: { x1: 10, y1: 20, x2: 300, y2: 200 }
      });
      component.savedLockStates.set({ desktop: false });

      component.closeModals();

      expect(component.savedCropperPositions()).toEqual({});
      expect(component.savedLockStates()).toEqual({});
    });

    it('should persist cropperPosition and ratioLocked in cropCoordinates', () => {
      component.cropStep.set('crop-desktop');
      component.onImageCropped({
        blob: new Blob(['test']),
        cropperPosition: { x1: 50, y1: 60, x2: 400, y2: 300 },
        imagePosition: { x1: 100, y1: 120, x2: 800, y2: 600 },
        width: 700, height: 480
      } as any);

      const coords = component.cropCoordinates()['desktop'];
      expect(coords).toBeDefined();
      expect(coords!.cropperPosition).toEqual({ x1: 50, y1: 60, x2: 400, y2: 300 });
      expect(coords!.ratioLocked).toBe(true);
    });

    it('should persist ratioLocked=false when aspect ratio is unlocked', () => {
      component.cropStep.set('crop-tablet');
      component.toggleRatioLock(); // unlock
      component.onImageCropped({
        blob: new Blob(['test']),
        cropperPosition: { x1: 10, y1: 10, x2: 200, y2: 150 },
        imagePosition: { x1: 50, y1: 50, x2: 450, y2: 350 },
        width: 400, height: 300
      } as any);

      const coords = component.cropCoordinates()['tablet'];
      expect(coords!.ratioLocked).toBe(false);
    });

    it('should restore crop positions from database on re-edit', () => {
      const mockAsset = {
        id: '123',
        display_name: 'Test Asset',
        alt_text: 'Alt text',
        original_file_id: 'file-1',
        slug: 'test-asset',
        crop_state: {
          desktop: {
            x: 100, y: 200, width: 600, height: 337,
            ratio: 16 / 9,
            cropperPosition: { x1: 20, y1: 40, x2: 320, y2: 210 },
            ratioLocked: true
          },
          tablet: {
            x: 50, y: 100, width: 400, height: 300,
            ratio: 4 / 3,
            cropperPosition: { x1: 10, y1: 20, x2: 210, y2: 170 },
            ratioLocked: false
          },
          profileName: 'Card Image'
        },
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z'
      } as any;

      component.openEditModal(mockAsset);

      // Crop positions restored
      expect(component.savedCropperPositions()['desktop']).toEqual({ x1: 20, y1: 40, x2: 320, y2: 210 });
      expect(component.savedCropperPositions()['tablet']).toEqual({ x1: 10, y1: 20, x2: 210, y2: 170 });

      // Lock states restored
      expect(component.savedLockStates()['desktop']).toBe(true);
      expect(component.savedLockStates()['tablet']).toBe(false);

      // Profile restored
      expect(component.selectedProfile().name).toBe('Card Image');
    });

    it('should restore lock state when entering first crop step on re-edit', () => {
      const mockAsset = {
        id: '123', display_name: 'Test', alt_text: '', original_file_id: 'f1', slug: 'test',
        crop_state: {
          desktop: {
            x: 0, y: 0, width: 100, height: 100, ratio: 1,
            cropperPosition: { x1: 0, y1: 0, x2: 100, y2: 100 },
            ratioLocked: false
          }
        },
        created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z'
      } as any;

      component.openEditModal(mockAsset);
      component.proceedToCropping();

      // Desktop was saved as unlocked — should restore that
      expect(component.ratioLocked()).toBe(false);
    });

    it('should default to locked for breakpoints without saved lock state', () => {
      const mockAsset = {
        id: '123', display_name: 'Test', alt_text: '', original_file_id: 'f1', slug: 'test',
        crop_state: {
          desktop: { x: 0, y: 0, width: 100, height: 56, ratio: 16 / 9 }
          // No ratioLocked or cropperPosition saved (old asset)
        },
        created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z'
      } as any;

      component.openEditModal(mockAsset);
      component.proceedToCropping();

      expect(component.ratioLocked()).toBe(true);
    });
  });

  describe('helpers', () => {
    it('should format dates', () => {
      const result = component.formatDate('2026-03-13T12:00:00Z');
      expect(result).toContain('2026');
    });

    it('should detect crops', () => {
      expect(component.hasCrops({ desktop_file_id: '1' } as any)).toBe(true);
      expect(component.hasCrops({ desktop_file_id: null, tablet_file_id: null, mobile_file_id: null } as any)).toBe(false);
    });

    it('should format common ratios', () => {
      expect(component.formatRatio(16 / 9)).toBe('16:9');
      expect(component.formatRatio(4 / 3)).toBe('4:3');
      expect(component.formatRatio(1)).toBe('1:1');
      expect(component.formatRatio(21 / 9)).toBe('21:9');
    });
  });

  describe('delete', () => {
    it('should delete asset and reload', () => {
      mockService.delete.and.returnValue(of(undefined));
      const mockAsset = { id: '1', slug: 'hero', display_name: 'Hero' } as any;

      component.confirmDelete(mockAsset);
      component.deleteAsset();

      expect(mockService.delete).toHaveBeenCalledWith('1');
    });
  });
});
