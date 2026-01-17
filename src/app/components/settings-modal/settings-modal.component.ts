/**
 * Copyright (C) 2023-2025 Civic OS, L3C
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

import { Component, ChangeDetectionStrategy, input, output, signal, inject, effect } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { AnalyticsService } from '../../services/analytics.service';
import { NotificationService, type NotificationPreference } from '../../services/notification.service';
import { AuthService } from '../../services/auth.service';
import { ImpersonationService } from '../../services/impersonation.service';
import { PermissionsService, Role } from '../../services/permissions.service';
import { getMatomoConfig } from '../../config/runtime';
import { CosModalComponent } from '../cos-modal/cos-modal.component';

/**
 * Settings modal component for user preferences.
 *
 * Contains:
 * - Analytics opt-out preference (localStorage-based)
 * - Notification preferences (email/SMS enabled/disabled)
 */
@Component({
  selector: 'app-settings-modal',
  imports: [CommonModule, FormsModule, CosModalComponent],
  templateUrl: './settings-modal.component.html',
  styleUrl: './settings-modal.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class SettingsModalComponent {
  private readonly analyticsService = inject(AnalyticsService);
  private readonly notificationService = inject(NotificationService);
  private readonly matomoConfig = getMatomoConfig();

  // Public services for template access
  readonly auth = inject(AuthService);
  readonly impersonation = inject(ImpersonationService);
  private readonly permissionsService = inject(PermissionsService);

  // Input: Control visibility of modal
  showModal = input.required<boolean>();

  // Output: Notify parent to close modal
  closeModal = output<void>();

  // State: Analytics enabled/disabled preference
  analyticsEnabled = signal<boolean>(true);

  // State: Notification preferences
  notificationPreferences = signal<NotificationPreference[]>([]);
  emailPreference = signal<NotificationPreference | undefined>(undefined);
  smsPreference = signal<NotificationPreference | undefined>(undefined);
  preferencesLoading = signal<boolean>(false);

  // State: Impersonation
  availableRoles = signal<Role[]>([]);
  selectedRoles = signal<string[]>([]);
  impersonationLoading = signal<boolean>(false);

  // Check if analytics is configured at all
  analyticsConfigured = this.matomoConfig.url && this.matomoConfig.siteId;

  constructor() {
    // Load initial preference from localStorage
    this.analyticsEnabled.set(this.analyticsService.getUserPreference());

    // Load preferences and roles when modal opens
    effect(() => {
      if (this.showModal()) {
        this.loadNotificationPreferences();

        // Load available roles for admins
        if (this.auth.isRealAdmin()) {
          this.loadAvailableRoles();
        }
      }
    });
  }

  /**
   * Load notification preferences from API
   */
  private loadNotificationPreferences(): void {
    this.preferencesLoading.set(true);
    this.notificationService.getUserPreferences().subscribe({
      next: (preferences) => {
        this.notificationPreferences.set(preferences);
        this.emailPreference.set(preferences.find(p => p.channel === 'email'));
        this.smsPreference.set(preferences.find(p => p.channel === 'sms'));
        this.preferencesLoading.set(false);
      },
      error: () => {
        this.preferencesLoading.set(false);
      }
    });
  }

  /**
   * Handle analytics checkbox change.
   * Updates localStorage and notifies AnalyticsService.
   */
  onAnalyticsToggle(): void {
    const enabled = this.analyticsEnabled();
    this.analyticsService.setEnabled(enabled);
  }

  /**
   * Handle email notification toggle
   */
  onEmailToggle(enabled: boolean): void {
    this.notificationService.updatePreference('email', enabled).subscribe({
      next: () => {
        // Update local state
        const pref = this.emailPreference();
        if (pref) {
          this.emailPreference.set({ ...pref, enabled });
        }
      }
    });
  }

  /**
   * Handle SMS notification toggle
   */
  onSmsToggle(enabled: boolean): void {
    this.notificationService.updatePreference('sms', enabled).subscribe({
      next: () => {
        // Update local state
        const pref = this.smsPreference();
        if (pref) {
          this.smsPreference.set({ ...pref, enabled });
        }
      }
    });
  }

  /**
   * Close the modal.
   * Emits closeModal event to parent component.
   */
  close(): void {
    this.closeModal.emit();
  }

  // =========================================================================
  // IMPERSONATION (Admin Only)
  // =========================================================================

  /**
   * Load available roles for impersonation selection
   */
  private loadAvailableRoles(): void {
    this.permissionsService.getRoles().subscribe({
      next: (roles) => {
        // Filter out 'anonymous' - can't impersonate as anonymous
        this.availableRoles.set(roles.filter(r => r.display_name !== 'anonymous'));
      },
      error: (err) => {
        console.error('Failed to load roles for impersonation:', err);
        this.availableRoles.set([]);
      }
    });
  }

  /**
   * Toggle role selection for impersonation
   */
  toggleRole(roleName: string): void {
    const current = this.selectedRoles();
    if (current.includes(roleName)) {
      this.selectedRoles.set(current.filter(r => r !== roleName));
    } else {
      this.selectedRoles.set([...current, roleName]);
    }
  }

  /**
   * Check if a role is currently selected
   */
  isRoleSelected(roleName: string): boolean {
    return this.selectedRoles().includes(roleName);
  }

  /**
   * Start impersonation with selected roles
   */
  startImpersonation(): void {
    const roles = this.selectedRoles();
    if (roles.length === 0) {
      return;
    }

    this.impersonationLoading.set(true);
    this.impersonation.startImpersonation(roles).subscribe({
      next: () => {
        this.impersonationLoading.set(false);
        // Clear selection after starting
        this.selectedRoles.set([]);
      },
      error: (err) => {
        console.error('Failed to start impersonation:', err);
        this.impersonationLoading.set(false);
      }
    });
  }

  /**
   * Stop impersonation and return to real roles
   */
  stopImpersonation(): void {
    this.impersonationLoading.set(true);
    this.impersonation.stopImpersonation().subscribe({
      next: () => {
        this.impersonationLoading.set(false);
        // Reload available roles now that we have real admin permissions again
        this.loadAvailableRoles();
      },
      error: (err) => {
        console.error('Failed to stop impersonation:', err);
        this.impersonationLoading.set(false);
      }
    });
  }
}
