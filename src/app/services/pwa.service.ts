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

import { Injectable, inject, signal, computed } from '@angular/core';
import { SwUpdate, VersionReadyEvent } from '@angular/service-worker';
import { filter } from 'rxjs';
import { getPwaConfig } from '../config/runtime';

/**
 * Central PWA service managing online/offline state, install prompts,
 * service worker updates, and cleanup when PWA is disabled.
 *
 * When PWA is disabled (`getPwaConfig().enabled === false`), this service
 * actively unregisters any existing service workers and exposes no-op signals.
 */
@Injectable({
  providedIn: 'root'
})
export class PwaService {
  private readonly swUpdate = inject(SwUpdate);
  private readonly pwaEnabled = getPwaConfig().enabled;

  private readonly DISMISS_KEY = 'civic-os-pwa-install-dismissed';

  // Stashed beforeinstallprompt event
  private deferredPrompt: Event | null = null;

  // Writable signals
  private readonly _isOnline = signal(typeof navigator !== 'undefined' ? navigator.onLine : true);
  private readonly _installable = signal(false);
  private readonly _installed = signal(
    typeof window !== 'undefined' && window.matchMedia('(display-mode: standalone)').matches
  );
  private readonly _installDismissed = signal(this.loadDismissed());
  private readonly _updateAvailable = signal(false);

  // Public readonly signals
  readonly isOnline = this._isOnline.asReadonly();
  readonly installable = this._installable.asReadonly();
  readonly installed = this._installed.asReadonly();
  readonly installDismissed = this._installDismissed.asReadonly();
  readonly updateAvailable = this._updateAvailable.asReadonly();

  // Computed: show install banner on first visit
  readonly showInstallBanner = computed(() =>
    this.pwaEnabled && this._installable() && !this._installed() && !this._installDismissed()
  );

  // Computed: show install option in settings
  readonly showInstallInSettings = computed(() =>
    this.pwaEnabled && this._installable() && !this._installed()
  );

  // Computed: show update toast only in standalone mode (installed PWA)
  readonly showUpdateToast = computed(() =>
    this._updateAvailable() && this._installed()
  );

  constructor() {
    // Online/offline tracking works regardless of PWA status
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => this._isOnline.set(true));
      window.addEventListener('offline', () => this._isOnline.set(false));
    }

    if (!this.pwaEnabled) {
      this.unregisterAllServiceWorkers();
      return;
    }

    // Listen for install prompt
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeinstallprompt', (e: Event) => {
        e.preventDefault();
        this.deferredPrompt = e;
        this._installable.set(true);
      });

      window.addEventListener('appinstalled', () => {
        this._installed.set(true);
        this.deferredPrompt = null;
      });
    }

    // Listen for service worker updates
    this.swUpdate.versionUpdates.pipe(
      filter((event): event is VersionReadyEvent => event.type === 'VERSION_READY')
    ).subscribe(() => {
      this._updateAvailable.set(true);
    });

    // Matomo custom variable for PWA vs browser sessions
    this.setMatomoAppMode();
  }

  /**
   * Trigger the browser's install prompt.
   * Returns a promise that resolves with the user's choice.
   */
  async promptInstall(): Promise<'accepted' | 'dismissed' | undefined> {
    if (!this.deferredPrompt) return undefined;

    const prompt = this.deferredPrompt as any;
    prompt.prompt();
    const result = await prompt.userChoice;
    this.deferredPrompt = null;
    this._installable.set(false);
    return result?.outcome;
  }

  /**
   * Dismiss the install banner and remember the choice.
   */
  dismissInstallBanner(): void {
    this._installDismissed.set(true);
    try {
      localStorage.setItem(this.DISMISS_KEY, 'true');
    } catch {
      // localStorage may be unavailable
    }
  }

  /**
   * Reload the page to apply a service worker update.
   */
  reloadForUpdate(): void {
    document.location.reload();
  }

  /**
   * Unregister all service workers. Called when PWA is disabled
   * to clean up any previously registered workers.
   */
  private async unregisterAllServiceWorkers(): Promise<void> {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

    try {
      const registrations = await navigator.serviceWorker.getRegistrations();
      for (const registration of registrations) {
        await registration.unregister();
      }
    } catch {
      // Silently ignore — SW API may not be available
    }
  }

  private loadDismissed(): boolean {
    try {
      return localStorage.getItem(this.DISMISS_KEY) === 'true';
    } catch {
      return false;
    }
  }

  private setMatomoAppMode(): void {
    // Dynamically import to avoid circular dependency
    try {
      const MatomoTracker = (window as any).__ngx_matomo_tracker;
      if (MatomoTracker) {
        const mode = window.matchMedia('(display-mode: standalone)').matches ? 'pwa' : 'browser';
        MatomoTracker.setCustomVariable(1, 'AppMode', mode, 'visit');
      }
    } catch {
      // Matomo may not be configured
    }
  }
}
