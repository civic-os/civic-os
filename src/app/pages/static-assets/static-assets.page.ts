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

import { Component, ChangeDetectionStrategy, signal, computed, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ImageCropperComponent, ImageCroppedEvent, LoadedImage, CropperPosition } from 'ngx-image-cropper';
import { CosModalComponent } from '../../components/cos-modal/cos-modal.component';
import { StaticAssetsService, DEFAULT_BREAKPOINTS, CROP_PRESET_PROFILES } from '../../services/static-assets.service';
import { FileUploadService } from '../../services/file-upload.service';
import { StaticAsset, CropState, CropCoordinates, CropBreakpoint, CropPresetProfile } from '../../interfaces/dashboard';
import { getS3Config } from '../../config/runtime';

type CropStep = 'upload' | 'profile' | 'crop-desktop' | 'crop-tablet' | 'crop-mobile' | 'saving';

@Component({
  selector: 'app-static-assets',
  standalone: true,
  imports: [CommonModule, FormsModule, ImageCropperComponent, CosModalComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './static-assets.page.html',
  styleUrl: './static-assets.page.css'
})
export class StaticAssetsPage implements OnInit {
  private staticAssetsService = inject(StaticAssetsService);
  private fileUploadService = inject(FileUploadService);

  // List state
  assets = signal<StaticAsset[]>([]);
  loading = signal(true);
  error = signal<string | undefined>(undefined);
  hasAssets = computed(() => this.assets().length > 0);

  // Create/Edit modal state
  showCreateModal = signal(false);
  editingAsset = signal<StaticAsset | null>(null);
  isEditing = computed(() => this.editingAsset() !== null);

  // Delete modal state
  deletingAsset = signal<StaticAsset | null>(null);
  deleteLoading = signal(false);
  deleteError = signal<string | undefined>(undefined);

  // Crop workflow state
  cropStep = signal<CropStep>('upload');
  assetName = signal('');
  assetAltText = signal('');
  selectedProfile = signal<CropPresetProfile>(CROP_PRESET_PROFILES[0]);
  customRatios = signal({ desktop: 16 / 9, tablet: 4 / 3, mobile: 1 });

  // Image data for cropper
  imageFile = signal<File | null>(null);
  originalFileId = signal<string | null>(null);
  originalImageUrl = signal<string | null>(null);

  // Crop results per breakpoint
  croppedBlobs = signal<{ desktop?: Blob; tablet?: Blob; mobile?: Blob }>({});
  cropCoordinates = signal<CropState>({});

  // Current crop breakpoint
  currentCropBreakpoint = computed<CropBreakpoint | null>(() => {
    const step = this.cropStep();
    if (step === 'crop-desktop') return this.getBreakpointConfig('desktop');
    if (step === 'crop-tablet') return this.getBreakpointConfig('tablet');
    if (step === 'crop-mobile') return this.getBreakpointConfig('mobile');
    return null;
  });

  currentAspectRatio = computed(() => {
    const bp = this.currentCropBreakpoint();
    return bp ? bp.ratio : 16 / 9;
  });

  /** Display string for the live aspect ratio (rounded to whole numbers) */
  liveRatioDisplay = computed(() => {
    const ratio = this.liveRatio();
    if (ratio == null) return '';
    // Try common ratios first
    if (Math.abs(ratio - 16 / 9) < 0.05) return '16:9';
    if (Math.abs(ratio - 4 / 3) < 0.05) return '4:3';
    if (Math.abs(ratio - 21 / 9) < 0.05) return '21:9';
    if (Math.abs(ratio - 1) < 0.05) return '1:1';
    if (Math.abs(ratio - 3 / 2) < 0.05) return '3:2';
    // Approximate with small whole numbers (try denominators 1-12)
    let bestNum = Math.round(ratio);
    let bestDen = 1;
    let bestErr = Math.abs(ratio - bestNum);
    for (let den = 2; den <= 12; den++) {
      const num = Math.round(ratio * den);
      const err = Math.abs(ratio - num / den);
      if (err < bestErr) {
        bestErr = err;
        bestNum = num;
        bestDen = den;
      }
    }
    return `${bestNum}:${bestDen}`;
  });

  // Saved cropper viewport positions for restoring crops when navigating between breakpoints
  savedCropperPositions = signal<Record<string, CropperPosition>>({});

  // Saved lock state per breakpoint (so going back restores whether ratio was locked)
  savedLockStates = signal<Record<string, boolean>>({});

  // True after the image-cropper fires (cropperReady). Gates position restoration
  // so we don't feed coordinates before the image is loaded (they'd be ignored).
  cropperInitialized = signal(false);

  // Computed: the cropper position to restore for the current breakpoint (or undefined for a fresh crop)
  currentCropperPosition = computed<CropperPosition | undefined>(() => {
    if (!this.cropperInitialized()) return undefined;
    const step = this.cropStep();
    const key = step.replace('crop-', '');
    return this.savedCropperPositions()[key];
  });

  // Aspect ratio lock/unlock
  ratioLocked = signal(true);
  liveRatio = signal<number | null>(null);

  // Tracks asset ID from a partially-completed save (prevents 409 on retry)
  pendingAssetId = signal<string | null>(null);

  // Save progress
  saveProgress = signal('');
  saving = signal(false);

  // Available presets
  presetProfiles = CROP_PRESET_PROFILES;

  ngOnInit(): void {
    this.loadAssets();
  }

  loadAssets(): void {
    this.loading.set(true);
    this.error.set(undefined);
    this.staticAssetsService.getAll().subscribe({
      next: (assets) => {
        this.assets.set(assets);
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set('Failed to load static assets');
        this.loading.set(false);
      }
    });
  }

  // ─── Create / Edit ─────────────────────────────────────────────

  openCreateModal(): void {
    this.resetCropState();
    this.showCreateModal.set(true);
    this.cropStep.set('upload');
  }

  openEditModal(asset: StaticAsset): void {
    this.resetCropState();
    this.editingAsset.set(asset);
    this.assetName.set(asset.display_name);
    this.assetAltText.set(asset.alt_text || '');
    this.originalFileId.set(asset.original_file_id);
    this.showCreateModal.set(true);

    // Load original image URL for re-cropping
    const originalFile = (asset as any).original_file;
    if (originalFile?.s3_original_key) {
      this.originalImageUrl.set(this.getS3Url(originalFile.s3_original_key));
    }

    // Restore previous crop state if available
    if (asset.crop_state) {
      this.cropCoordinates.set(asset.crop_state);

      // Restore viewport crop positions and lock states from persisted crop_state
      const restoredPositions: Record<string, CropperPosition> = {};
      const restoredLockStates: Record<string, boolean> = {};
      for (const key of ['desktop', 'tablet', 'mobile'] as const) {
        const coords = asset.crop_state[key];
        if (coords?.cropperPosition) {
          restoredPositions[key] = coords.cropperPosition;
        }
        if (coords?.ratioLocked !== undefined) {
          restoredLockStates[key] = coords.ratioLocked;
        }
      }
      this.savedCropperPositions.set(restoredPositions);
      this.savedLockStates.set(restoredLockStates);

      // Restore selected crop profile
      if (asset.crop_state.profileName) {
        const savedProfile = CROP_PRESET_PROFILES.find(p => p.name === asset.crop_state!.profileName);
        if (savedProfile) {
          this.selectedProfile.set(savedProfile);
        }
      }
    }

    // Skip upload step, go straight to profile selection
    this.cropStep.set('profile');
  }

  closeModals(): void {
    this.showCreateModal.set(false);
    this.editingAsset.set(null);
    this.deletingAsset.set(null);
    this.deleteError.set(undefined);
    this.resetCropState();
  }

  private resetCropState(): void {
    this.cropStep.set('upload');
    this.assetName.set('');
    this.assetAltText.set('');
    this.imageFile.set(null);
    this.originalFileId.set(null);
    this.originalImageUrl.set(null);
    this.croppedBlobs.set({});
    this.cropCoordinates.set({});
    this.savedCropperPositions.set({});
    this.savedLockStates.set({});
    this.cropperInitialized.set(false);
    this.selectedProfile.set(CROP_PRESET_PROFILES[0]);
    this.customRatios.set({ desktop: 16 / 9, tablet: 4 / 3, mobile: 1 });
    this.ratioLocked.set(true);
    this.liveRatio.set(null);
    this.pendingAssetId.set(null);
    this.saveProgress.set('');
    this.saving.set(false);
  }

  // ─── Upload Step ───────────────────────────────────────────────

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      this.imageFile.set(input.files[0]);
      if (!this.assetName()) {
        // Auto-fill name from filename (strip extension)
        const name = input.files[0].name.replace(/\.[^/.]+$/, '').replace(/[-_]/g, ' ');
        this.assetName.set(name);
      }
    }
  }

  proceedToProfile(): void {
    this.cropStep.set('profile');
  }

  // ─── Profile Step ──────────────────────────────────────────────

  selectProfile(profile: CropPresetProfile): void {
    this.selectedProfile.set(profile);
  }

  proceedToCropping(): void {
    // Restore saved lock state for desktop if re-editing, otherwise default to locked
    this.restoreLockState('desktop');
    this.cropStep.set('crop-desktop');
  }

  toggleRatioLock(): void {
    const wasLocked = this.ratioLocked();
    this.ratioLocked.set(!wasLocked);
    if (!wasLocked) {
      // Re-locking: reset live ratio — the cropper will snap back via maintainAspectRatio
      this.liveRatio.set(null);
    }
  }

  // ─── Crop Steps ────────────────────────────────────────────────

  getBreakpointConfig(key: 'desktop' | 'tablet' | 'mobile'): CropBreakpoint {
    const profile = this.selectedProfile();
    const ratio = profile.name === 'Custom'
      ? this.customRatios()[key]
      : profile.breakpoints[key];

    const base = DEFAULT_BREAKPOINTS.find(bp => bp.key === key)!;
    return { ...base, ratio, label: `${base.label} (${this.formatRatio(ratio)})` };
  }

  formatRatio(ratio: number): string {
    // Common ratios
    if (Math.abs(ratio - 16 / 9) < 0.01) return '16:9';
    if (Math.abs(ratio - 4 / 3) < 0.01) return '4:3';
    if (Math.abs(ratio - 21 / 9) < 0.01) return '21:9';
    if (Math.abs(ratio - 1) < 0.01) return '1:1';
    return ratio.toFixed(2);
  }

  onImageCropped(event: ImageCroppedEvent): void {
    const step = this.cropStep();
    const key = step.replace('crop-', '') as 'desktop' | 'tablet' | 'mobile';

    if (event.blob) {
      this.croppedBlobs.update(blobs => ({ ...blobs, [key]: event.blob! }));
    }

    // Save viewport-relative crop position for restoring when navigating back
    if (event.cropperPosition) {
      this.savedCropperPositions.update(positions => ({ ...positions, [key]: event.cropperPosition }));
    }

    if (event.imagePosition) {
      const w = event.imagePosition.x2 - event.imagePosition.x1;
      const h = event.imagePosition.y2 - event.imagePosition.y1;
      const actualRatio = h > 0 ? w / h : this.currentAspectRatio();

      // Update live ratio display when unlocked
      if (!this.ratioLocked()) {
        this.liveRatio.set(actualRatio);
      }

      const coords: CropCoordinates = {
        x: event.imagePosition.x1,
        y: event.imagePosition.y1,
        width: w,
        height: h,
        ratio: this.ratioLocked() ? this.currentAspectRatio() : actualRatio,
        cropperPosition: event.cropperPosition ? { ...event.cropperPosition } : undefined,
        ratioLocked: this.ratioLocked()
      };
      this.cropCoordinates.update(state => ({ ...state, [key]: coords }));
    }
  }

  onImageLoaded(event: LoadedImage): void {
    // Image loaded into cropper — no action needed
  }

  onCropperReady(): void {
    // Image loaded and cropper initialized — now safe to restore saved positions
    this.cropperInitialized.set(true);
  }

  onLoadImageFailed(): void {
    this.error.set('Failed to load image for cropping');
  }

  confirmCrop(): void {
    const step = this.cropStep();
    const key = step.replace('crop-', '');
    // Save current lock state before advancing
    this.savedLockStates.update(states => ({ ...states, [key]: this.ratioLocked() }));
    // Reset lock state for the next (potentially unvisited) breakpoint
    this.ratioLocked.set(true);
    this.liveRatio.set(null);
    if (step === 'crop-desktop') {
      this.restoreLockState('tablet');
      this.cropStep.set('crop-tablet');
    } else if (step === 'crop-tablet') {
      this.restoreLockState('mobile');
      this.cropStep.set('crop-mobile');
    } else if (step === 'crop-mobile') {
      this.saveAsset();
    }
  }

  goBackCrop(): void {
    const step = this.cropStep();
    const key = step.replace('crop-', '');
    // Save current lock state before going back
    this.savedLockStates.update(states => ({ ...states, [key]: this.ratioLocked() }));
    if (step === 'crop-mobile') {
      this.restoreLockState('tablet');
      this.cropStep.set('crop-tablet');
    } else if (step === 'crop-tablet') {
      this.restoreLockState('desktop');
      this.cropStep.set('crop-desktop');
    } else if (step === 'crop-desktop') {
      this.cropStep.set('profile');
    }
  }

  /** Restore the lock state for a breakpoint if it was previously visited */
  private restoreLockState(key: string): void {
    const savedLock = this.savedLockStates()[key];
    if (savedLock !== undefined) {
      this.ratioLocked.set(savedLock);
      // Restore live ratio from saved crop coordinates if unlocked
      if (!savedLock) {
        const coords = this.cropCoordinates()[key as 'desktop' | 'tablet' | 'mobile'];
        this.liveRatio.set(coords?.ratio ?? null);
      } else {
        this.liveRatio.set(null);
      }
    } else {
      // First visit to this breakpoint — default to locked
      this.ratioLocked.set(true);
      this.liveRatio.set(null);
    }
  }

  getCropStepNumber(): number {
    const step = this.cropStep();
    if (step === 'crop-desktop') return 1;
    if (step === 'crop-tablet') return 2;
    if (step === 'crop-mobile') return 3;
    return 0;
  }

  // ─── Save ──────────────────────────────────────────────────────

  async saveAsset(): Promise<void> {
    this.saving.set(true);
    this.cropStep.set('saving');

    try {
      // Resume from a previous partial save if asset already created
      let assetId = this.pendingAssetId();

      if (this.isEditing()) {
        assetId = this.editingAsset()!.id;
      } else if (!assetId) {
        // Step 1: Upload original image
        this.saveProgress.set('Uploading original image...');
        const file = this.imageFile();
        if (!file) throw new Error('No image file selected');

        const tempId = crypto.randomUUID();
        const originalFile = await this.fileUploadService.uploadFile(file, 'static_assets', tempId, false);

        // Step 2: Create asset record
        this.saveProgress.set('Creating asset record...');
        const created = await this.staticAssetsService.create({
          display_name: this.assetName(),
          alt_text: this.assetAltText() || undefined,
          original_file_id: originalFile.id
        }).toPromise();
        assetId = created!.id;

        // Remember in case step 3 fails and user retries
        this.pendingAssetId.set(assetId);
      }

      // Step 3: Upload cropped variants
      const blobs = this.croppedBlobs();
      const fileIds: Record<string, string> = {};

      for (const key of ['desktop', 'tablet', 'mobile'] as const) {
        const blob = blobs[key];
        if (blob) {
          this.saveProgress.set(`Uploading ${key} crop...`);
          fileIds[`${key}_file_id`] = await this.staticAssetsService.uploadCroppedImage(
            blob, assetId!, key, true
          );
        }
      }

      // Step 4: Update asset with file IDs and crop state
      this.saveProgress.set('Saving asset metadata...');
      const cropState: CropState = {
        ...this.cropCoordinates(),
        profileName: this.selectedProfile().name
      };
      await this.staticAssetsService.update(assetId!, {
        ...fileIds,
        crop_state: cropState,
        ...(this.isEditing() ? {
          display_name: this.assetName(),
          alt_text: this.assetAltText() || undefined
        } : {})
      } as any).toPromise();

      this.saveProgress.set('Done!');
      this.closeModals();
      this.loadAssets();
    } catch (err: any) {
      console.error('Error saving static asset:', err);
      this.error.set(`Failed to save asset: ${err.message}`);
      this.saving.set(false);
      this.cropStep.set('crop-mobile'); // Go back to last crop step
    }
  }

  // ─── Delete ────────────────────────────────────────────────────

  confirmDelete(asset: StaticAsset): void {
    this.deletingAsset.set(asset);
    this.deleteError.set(undefined);
  }

  deleteAsset(): void {
    const asset = this.deletingAsset();
    if (!asset) return;

    this.deleteLoading.set(true);
    this.deleteError.set(undefined);

    this.staticAssetsService.delete(asset.id).subscribe({
      next: () => {
        this.deleteLoading.set(false);
        this.closeModals();
        this.loadAssets();
      },
      error: (err) => {
        this.deleteLoading.set(false);
        this.deleteError.set('Failed to delete asset. Please try again.');
      }
    });
  }

  // ─── Helpers ───────────────────────────────────────────────────

  getS3Url(s3Key: string | null | undefined): string {
    if (!s3Key) return '';
    const s3Config = getS3Config();
    return `${s3Config.endpoint}/${s3Config.bucket}/${s3Key}`;
  }

  getThumbnailUrl(asset: StaticAsset): string {
    const original = (asset as any).original_file;
    if (original?.s3_thumbnail_small_key) {
      return this.getS3Url(original.s3_thumbnail_small_key);
    }
    if (original?.s3_thumbnail_medium_key) {
      return this.getS3Url(original.s3_thumbnail_medium_key);
    }
    return '';
  }

  formatDate(dateStr: string): string {
    return new Date(dateStr).toLocaleDateString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric'
    });
  }

  hasCrops(asset: StaticAsset): boolean {
    return !!(asset.desktop_file_id || asset.tablet_file_id || asset.mobile_file_id);
  }
}
