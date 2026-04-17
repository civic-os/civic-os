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

import { Component, ChangeDetectionStrategy, inject, signal, computed } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subject, switchMap, of, debounceTime, startWith, combineLatest, Observable, map } from 'rxjs';
import { UserManagementService, ManagedUser, ManageableRole, ProvisionUserRequest, AdminNotificationPreference } from '../../services/user-management.service';
import { ImportExportService } from '../../services/import-export.service';
import { getSmsConfig } from '../../config/runtime';
import { ImportModalComponent } from '../../components/import-modal/import-modal.component';
import { CustomImportConfig, ImportColumn, CustomImportResult } from '../../interfaces/import';

@Component({
  selector: 'app-user-management',
  standalone: true,
  imports: [CommonModule, FormsModule, ImportModalComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="p-4 max-w-7xl mx-auto">
      <div class="flex justify-between items-center mb-6">
        <div>
          <h1 class="text-2xl font-bold">User Management</h1>
          <p class="text-base-content/60 mt-1">Create and manage user accounts</p>
        </div>
        <div class="flex gap-2">
          <button class="btn btn-outline" (click)="openImportModal()">
            <span class="material-symbols-outlined">upload</span>
            Import Users
          </button>
          <button class="btn btn-primary" (click)="openCreateModal()">
            <span class="material-symbols-outlined">person_add</span>
            Create User
          </button>
        </div>
      </div>

      <!-- Filters -->
      <div class="flex gap-4 mb-4">
        <div class="flex-1">
          <input type="text" placeholder="Search by name or email..."
                 class="input input-bordered w-full"
                 [ngModel]="searchTerm()"
                 (ngModelChange)="onSearchChange($event)" />
        </div>
        <select class="select select-bordered"
                [ngModel]="roleFilter()"
                (ngModelChange)="onRoleFilterChange($event)">
          <option value="all">All roles</option>
          @for (role of manageableRoles(); track role.role_id) {
            <option [value]="role.role_key">{{ role.display_name }}</option>
          }
        </select>
        <select class="select select-bordered"
                [ngModel]="statusFilter()"
                (ngModelChange)="onStatusFilterChange($event)">
          <option value="all">All statuses</option>
          <option value="active">Active</option>
          <option value="pending">Pending</option>
          <option value="processing">Processing</option>
          <option value="failed">Failed</option>
        </select>
      </div>

      <!-- Users Table -->
      @if (loading()) {
        <div class="flex justify-center py-12">
          <span class="loading loading-spinner loading-lg"></span>
        </div>
      } @else if (users().length === 0) {
        <div class="text-center py-12 text-base-content/60">
          <span class="material-symbols-outlined text-4xl mb-2">group</span>
          <p>No users found</p>
        </div>
      } @else {
        <div class="overflow-x-auto">
          <table class="table table-sm">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Phone</th>
                <th class="w-16">Notif</th>
                <th>Roles</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              @for (user of users(); track user.email) {
                <tr>
                  <td>
                    <div class="font-medium">{{ user.full_name || user.display_name }}</div>
                  </td>
                  <td>{{ user.email }}</td>
                  <td>
                    @if (user.phone) {
                      {{ formatPhone(user.phone) }}
                    } @else {
                      <span class="text-base-content/40">-</span>
                    }
                  </td>
                  <td>
                    <div class="flex gap-0.5">
                      @if (user.email_notif_enabled !== null) {
                        <span class="material-symbols-outlined text-sm"
                              [class.opacity-30]="!user.email_notif_enabled"
                              [title]="'Email ' + (user.email_notif_enabled ? 'enabled' : 'disabled')">
                          mail
                        </span>
                      }
                      @if (smsConfigured && user.sms_notif_enabled !== null) {
                        @if (user.sms_opted_out) {
                          <span class="material-symbols-outlined text-sm text-warning"
                                title="SMS blocked by carrier (user must text START)">
                            sms_failed
                          </span>
                        } @else {
                          <span class="material-symbols-outlined text-sm"
                                [class.opacity-30]="!user.sms_notif_enabled"
                                [title]="'SMS ' + (user.sms_notif_enabled ? 'enabled' : 'disabled')">
                            sms
                          </span>
                        }
                      }
                    </div>
                  </td>
                  <td>
                    <div class="flex flex-wrap gap-1">
                      @for (role of user.roles || []; track role) {
                        <span class="badge badge-sm badge-outline">{{ getRoleDisplayName(role) }}</span>
                      }
                    </div>
                  </td>
                  <td>
                    <span class="badge badge-sm" [class]="getStatusClass(user.status)">
                      {{ user.status }}
                    </span>
                  </td>
                  <td>
                    <div class="flex gap-1">
                      @if (user.status === 'active' && user.id) {
                        <button class="btn btn-xs btn-ghost" title="Edit user"
                                (click)="openEditModal(user)">
                          <span class="material-symbols-outlined text-sm">edit</span>
                        </button>
                      }
                      @if (user.status === 'failed') {
                        <button class="btn btn-xs btn-ghost" title="View error"
                                (click)="viewError(user)">
                          <span class="material-symbols-outlined text-sm">info</span>
                        </button>
                        <button class="btn btn-xs btn-primary" title="Retry"
                                (click)="retryUser(user)">
                          <span class="material-symbols-outlined text-sm">refresh</span>
                        </button>
                      }
                    </div>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }

      <!-- Error Alert -->
      @if (errorMessage()) {
        <div class="alert alert-error mt-4">
          <span class="material-symbols-outlined">error</span>
          <span>{{ errorMessage() }}</span>
          <button class="btn btn-sm btn-ghost" (click)="errorMessage.set(undefined)">Dismiss</button>
        </div>
      }

      <!-- Success Alert -->
      @if (successMessage()) {
        <div class="alert alert-success mt-4">
          <span class="material-symbols-outlined">check_circle</span>
          <span>{{ successMessage() }}</span>
          <button class="btn btn-sm btn-ghost" (click)="successMessage.set(undefined)">Dismiss</button>
        </div>
      }
    </div>

    <!-- Create User Modal -->
    @if (showCreateModal()) {
      <div class="modal modal-open">
        <div class="modal-box">
          <h3 class="font-bold text-lg mb-4">Create User</h3>

          <div class="grid grid-cols-2 gap-4">
            <div>
              <label class="label"><span class="label-text">First Name *</span></label>
              <input type="text" class="input input-bordered w-full"
                     [ngModel]="newUser.first_name"
                     (ngModelChange)="newUser.first_name = $event" />
            </div>
            <div>
              <label class="label"><span class="label-text">Last Name *</span></label>
              <input type="text" class="input input-bordered w-full"
                     [ngModel]="newUser.last_name"
                     (ngModelChange)="newUser.last_name = $event" />
            </div>
          </div>

          <div class="mt-3">
            <label class="label"><span class="label-text">Email *</span></label>
            <input type="email" class="input input-bordered w-full"
                   [ngModel]="newUser.email"
                   (ngModelChange)="newUser.email = $event" />
          </div>

          <div class="mt-3">
            <label class="label"><span class="label-text">Phone</span></label>
            <input type="tel" class="input input-bordered w-full" placeholder="5551234567"
                   [ngModel]="newUser.phone"
                   (ngModelChange)="newUser.phone = $event" />
          </div>

          <div class="mt-3">
            <label class="label"><span class="label-text">Roles</span></label>
            <div class="flex flex-wrap gap-2">
              @for (role of manageableRoles(); track role.role_id) {
                <label class="cursor-pointer flex items-center gap-1">
                  <input type="checkbox" class="checkbox checkbox-sm"
                         [checked]="isRoleSelected(role.role_key)"
                         (change)="toggleRole(role.role_key)" />
                  <span class="text-sm">{{ role.display_name }}</span>
                </label>
              }
            </div>
          </div>

          <div class="mt-3 flex flex-col gap-1">
            <label class="cursor-pointer flex items-center gap-2">
              <input type="checkbox" class="checkbox checkbox-sm"
                     [ngModel]="newUser.send_welcome_email"
                     (ngModelChange)="newUser.send_welcome_email = $event" />
              <span class="text-sm">Send welcome email</span>
            </label>
            @if (smsConfigured) {
              <label class="cursor-pointer flex items-center gap-2">
                <input type="checkbox" class="checkbox checkbox-sm"
                       [ngModel]="newUser.send_welcome_sms"
                       (ngModelChange)="newUser.send_welcome_sms = $event" />
                <span class="text-sm">Send welcome SMS</span>
              </label>
            }
          </div>

          @if (createError()) {
            <div class="alert alert-error mt-4 text-sm">{{ createError() }}</div>
          }

          <div class="modal-action">
            <button class="btn" (click)="closeCreateModal()">Cancel</button>
            <button class="btn btn-primary" [disabled]="createLoading()"
                    (click)="submitCreateUser()">
              @if (createLoading()) {
                <span class="loading loading-spinner loading-sm"></span>
              }
              Create
            </button>
          </div>
        </div>
        <div class="modal-backdrop" (click)="closeCreateModal()"></div>
      </div>
    }

    <!-- Error Detail Modal -->
    @if (showErrorModal()) {
      <div class="modal modal-open">
        <div class="modal-box">
          <h3 class="font-bold text-lg mb-2">Provisioning Error</h3>
          <p class="text-sm text-base-content/70 mb-4">{{ errorDetailUser()?.display_name }} ({{ errorDetailUser()?.email }})</p>
          <div class="bg-error/10 text-error p-3 rounded-lg text-sm font-mono whitespace-pre-wrap">{{ errorDetailUser()?.error_message }}</div>
          <div class="modal-action">
            <button class="btn" (click)="showErrorModal.set(false)">Close</button>
          </div>
        </div>
        <div class="modal-backdrop" (click)="showErrorModal.set(false)"></div>
      </div>
    }

    <!-- Edit User Modal -->
    @if (showEditModal()) {
      <div class="modal modal-open">
        <div class="modal-box">
          <h3 class="font-bold text-lg mb-4">Edit User</h3>

          <!-- User Info Section -->
          <div class="grid grid-cols-2 gap-4">
            <div>
              <label class="label"><span class="label-text">First Name *</span></label>
              <input type="text" class="input input-bordered w-full"
                     [ngModel]="editFirstName()"
                     (ngModelChange)="editFirstName.set($event)" />
            </div>
            <div>
              <label class="label"><span class="label-text">Last Name *</span></label>
              <input type="text" class="input input-bordered w-full"
                     [ngModel]="editLastName()"
                     (ngModelChange)="editLastName.set($event)" />
            </div>
          </div>

          <div class="mt-3">
            <label class="label"><span class="label-text">Phone</span></label>
            <input type="tel" class="input input-bordered w-full" placeholder="5551234567"
                   [ngModel]="editPhone()"
                   (ngModelChange)="editPhone.set($event)" />
          </div>

          <div class="mt-3">
            <label class="label"><span class="label-text">Email</span></label>
            <input type="email" class="input input-bordered w-full" disabled
                   [value]="editUser()?.email" />
            <div class="text-xs text-base-content/50 mt-1">Email address cannot be changed from this page</div>
          </div>

          <!-- Divider -->
          <div class="divider">Roles</div>

          <!-- Roles Section -->
          <div class="flex flex-wrap gap-3">
            @for (role of manageableRoles(); track role.role_id) {
              <label class="cursor-pointer flex items-center gap-1.5">
                <input type="checkbox" class="checkbox checkbox-sm"
                       [checked]="editRoles().has(role.role_key)"
                       [disabled]="editRolesLoading().has(role.role_key)"
                       (change)="toggleEditRole(role.role_key)" />
                <span class="text-sm">{{ role.display_name }}</span>
                @if (editRolesLoading().has(role.role_key)) {
                  <span class="loading loading-spinner loading-xs"></span>
                }
              </label>
            }
          </div>

          <!-- Divider -->
          <div class="divider">Notifications</div>

          <!-- Notification Preferences Section -->
          @if (editNotifLoading()) {
            <div class="text-sm opacity-70">Loading notification preferences...</div>
          } @else {
            <!-- Email Notification Toggle -->
            @if (editEmailNotif(); as emailNotif) {
              <label class="flex items-start cursor-pointer gap-3 mb-3">
                <input
                  type="checkbox"
                  class="checkbox flex-shrink-0 mt-0.5"
                  [checked]="emailNotif.enabled"
                  (change)="toggleEditNotifPref('email', $any($event.target).checked)"
                />
                <div>
                  <span>Email notifications</span>
                  @if (emailNotif.email_address) {
                    <p class="text-xs opacity-70">{{ emailNotif.email_address }}</p>
                  }
                </div>
              </label>
            }

            <!-- SMS Notification Toggle (only when SMS is configured) -->
            @if (smsConfigured) {
              @if (editSmsNotif(); as smsNotif) {
                <label class="flex items-start cursor-pointer gap-3 mb-3"
                       [class.opacity-50]="smsNotif.sms_opted_out">
                  <input
                    type="checkbox"
                    class="checkbox flex-shrink-0 mt-0.5"
                    [checked]="smsNotif.enabled"
                    [disabled]="smsNotif.sms_opted_out"
                    (change)="toggleEditNotifPref('sms', $any($event.target).checked)"
                  />
                  <div>
                    <span>SMS notifications</span>
                    @if (smsNotif.phone_number) {
                      <p class="text-xs opacity-70">
                        {{ formatPhone(smsNotif.phone_number) }}
                      </p>
                    }
                  </div>
                </label>
                @if (smsNotif.sms_opted_out) {
                  <div class="alert alert-warning text-xs py-2 mt-1">
                    <span class="material-symbols-outlined text-sm">sms_failed</span>
                    <span>Carrier blocked — user must text START to re-enable SMS</span>
                  </div>
                  <button class="btn btn-xs btn-warning btn-outline mt-1"
                          (click)="clearSmsOptedOut()">
                    Clear opt-out &amp; retry
                  </button>
                }
              }
            }

            @if (!editEmailNotif() && !editSmsNotif()) {
              <p class="text-sm opacity-70">No notification preferences found for this user.</p>
            }
          }

          @if (editError()) {
            <div class="alert alert-error mt-4 text-sm">{{ editError() }}</div>
          }

          <div class="modal-action">
            <button class="btn" (click)="closeEditModal()">Cancel</button>
            <button class="btn btn-primary" [disabled]="editLoading()"
                    (click)="submitEditUser()">
              @if (editLoading()) {
                <span class="loading loading-spinner loading-sm"></span>
              }
              Save Changes
            </button>
          </div>
        </div>
        <div class="modal-backdrop" (click)="closeEditModal()"></div>
      </div>
    }

    <!-- Import Users Modal -->
    @if (showImportModal()) {
      <app-import-modal
        [customImport]="userImportConfig"
        (close)="showImportModal.set(false)"
        (importSuccess)="onImportSuccess($event)">
      </app-import-modal>
    }
  `
})
export class UserManagementPage {
  private userService = inject(UserManagementService);
  private importExportService = inject(ImportExportService);

  // Search and filter state
  searchTerm = signal('');
  statusFilter = signal('all');
  roleFilter = signal('all');
  private refreshSubject = new Subject<void>();
  private searchSubject = new Subject<string>();

  // Data
  loading = signal(true);
  users = signal<ManagedUser[]>([]);
  errorMessage = signal<string | undefined>(undefined);
  successMessage = signal<string | undefined>(undefined);

  // Create modal state
  showCreateModal = signal(false);

  // Import modal state
  showImportModal = signal(false);
  createLoading = signal(false);
  createError = signal<string | undefined>(undefined);
  newUser: ProvisionUserRequest = this.emptyUser();
  selectedRoles = signal<Set<string>>(new Set(['user']));

  // Manageable roles
  manageableRoles = toSignal(this.userService.getManageableRoles(), { initialValue: [] as ManageableRole[] });

  // Edit modal state
  showEditModal = signal(false);
  editLoading = signal(false);
  editError = signal<string | undefined>(undefined);
  editUser = signal<ManagedUser | undefined>(undefined);
  editFirstName = signal('');
  editLastName = signal('');
  editPhone = signal('');
  editRoles = signal<Set<string>>(new Set());
  editRolesLoading = signal<Set<string>>(new Set());

  // Notification preferences for edit modal
  readonly smsConfigured = getSmsConfig().configured;
  editNotifPrefs = signal<AdminNotificationPreference[]>([]);
  editNotifLoading = signal(false);
  editEmailNotif = signal<AdminNotificationPreference | undefined>(undefined);
  editSmsNotif = signal<AdminNotificationPreference | undefined>(undefined);

  // Error detail modal
  showErrorModal = signal(false);
  errorDetailUser = signal<ManagedUser | undefined>(undefined);

  constructor() {
    // Debounced search
    this.searchSubject.pipe(
      debounceTime(300)
    ).subscribe(term => {
      this.searchTerm.set(term);
      this.loadUsers();
    });

    // Initial load
    this.loadUsers();
  }

  private loadUsers(): void {
    this.loading.set(true);
    this.userService.getManagedUsers(this.searchTerm(), this.statusFilter(), this.roleFilter()).subscribe(users => {
      this.users.set(users);
      this.loading.set(false);
    });
  }

  onSearchChange(term: string): void {
    this.searchSubject.next(term);
  }

  onStatusFilterChange(status: string): void {
    this.statusFilter.set(status);
    this.loadUsers();
  }

  onRoleFilterChange(role: string): void {
    this.roleFilter.set(role);
    this.loadUsers();
  }

  getStatusClass(status: string): string {
    switch (status) {
      case 'active': return 'badge-success';
      case 'pending': return 'badge-warning';
      case 'processing': return 'badge-info';
      case 'failed': return 'badge-error';
      default: return 'badge-ghost';
    }
  }

  formatPhone(phone: string): string {
    if (phone && phone.length === 10) {
      return `(${phone.slice(0, 3)}) ${phone.slice(3, 6)}-${phone.slice(6)}`;
    }
    return phone;
  }

  // =========================================================================
  // Create User Modal
  // =========================================================================

  openCreateModal(): void {
    this.newUser = this.emptyUser();
    this.selectedRoles.set(new Set(['user']));
    this.createError.set(undefined);
    this.showCreateModal.set(true);
  }

  closeCreateModal(): void {
    this.showCreateModal.set(false);
  }

  isRoleSelected(roleName: string): boolean {
    return this.selectedRoles().has(roleName);
  }

  toggleRole(roleName: string): void {
    const roles = new Set(this.selectedRoles());
    if (roles.has(roleName)) {
      roles.delete(roleName);
    } else {
      roles.add(roleName);
    }
    this.selectedRoles.set(roles);
  }

  submitCreateUser(): void {
    // Validation
    if (!this.newUser.email || !this.newUser.first_name || !this.newUser.last_name) {
      this.createError.set('Email, first name, and last name are required');
      return;
    }

    this.createLoading.set(true);
    this.createError.set(undefined);

    const request: ProvisionUserRequest = {
      ...this.newUser,
      initial_roles: Array.from(this.selectedRoles())
    };

    this.userService.createUser(request).subscribe(response => {
      this.createLoading.set(false);
      if (response.success) {
        this.showCreateModal.set(false);
        this.successMessage.set(`User ${this.newUser.first_name} ${this.newUser.last_name} created. Provisioning in progress...`);
        this.loadUsers();
        setTimeout(() => this.successMessage.set(undefined), 5000);
      } else {
        this.createError.set(response.error?.humanMessage || 'Failed to create user');
      }
    });
  }

  // =========================================================================
  // Edit User Modal
  // =========================================================================

  openEditModal(user: ManagedUser): void {
    if (user.status !== 'active' || !user.id) {
      return;
    }
    this.editUser.set(user);
    this.editFirstName.set(user.first_name || '');
    this.editLastName.set(user.last_name || '');
    this.editPhone.set(user.phone || '');
    this.editRoles.set(new Set(user.roles || []));
    this.editRolesLoading.set(new Set());
    this.editError.set(undefined);
    this.editLoading.set(false);
    this.showEditModal.set(true);

    // Load notification preferences
    this.editNotifLoading.set(true);
    this.editNotifPrefs.set([]);
    this.editEmailNotif.set(undefined);
    this.editSmsNotif.set(undefined);
    this.userService.getNotificationPreferences(user.id).subscribe({
      next: (prefs) => {
        this.editNotifPrefs.set(prefs);
        this.editEmailNotif.set(prefs.find(p => p.channel === 'email'));
        this.editSmsNotif.set(prefs.find(p => p.channel === 'sms'));
        this.editNotifLoading.set(false);
      },
      error: () => this.editNotifLoading.set(false)
    });
  }

  closeEditModal(): void {
    this.showEditModal.set(false);
    this.loadUsers();
  }

  getRoleDisplayName(roleKey: string): string {
    const role = this.manageableRoles().find(r => r.role_key === roleKey);
    return role?.display_name ?? roleKey;
  }

  toggleEditRole(roleName: string): void {
    const user = this.editUser();
    if (!user?.id) return;

    const currentRoles = this.editRoles();
    const isAssigned = currentRoles.has(roleName);

    // Set loading for this role
    const loading = new Set(this.editRolesLoading());
    loading.add(roleName);
    this.editRolesLoading.set(loading);

    const operation = isAssigned
      ? this.userService.revokeUserRole(user.id, roleName)
      : this.userService.assignUserRole(user.id, roleName);

    operation.subscribe(response => {
      // Clear loading for this role
      const updatedLoading = new Set(this.editRolesLoading());
      updatedLoading.delete(roleName);
      this.editRolesLoading.set(updatedLoading);

      if (response.success) {
        const updatedRoles = new Set(this.editRoles());
        if (isAssigned) {
          updatedRoles.delete(roleName);
        } else {
          updatedRoles.add(roleName);
        }
        this.editRoles.set(updatedRoles);
        this.editError.set(undefined);
      } else {
        this.editError.set(response.error?.humanMessage || 'Failed to update role');
      }
    });
  }

  toggleEditNotifPref(channel: string, enabled: boolean): void {
    const user = this.editUser();
    if (!user?.id) return;

    this.userService.updateNotificationPreference(user.id, channel, enabled).subscribe(response => {
      if (response.success) {
        if (channel === 'email') {
          const pref = this.editEmailNotif();
          if (pref) this.editEmailNotif.set({ ...pref, enabled });
        } else if (channel === 'sms') {
          const pref = this.editSmsNotif();
          if (pref) this.editSmsNotif.set({ ...pref, enabled });
        }
      } else {
        this.editError.set(response.error?.humanMessage || 'Failed to update notification preference');
      }
    });
  }

  clearSmsOptedOut(): void {
    const user = this.editUser();
    if (!user?.id) return;

    this.userService.updateNotificationPreference(user.id, 'sms', true, true).subscribe(response => {
      if (response.success) {
        const pref = this.editSmsNotif();
        if (pref) this.editSmsNotif.set({ ...pref, enabled: true, sms_opted_out: false });
      } else {
        this.editError.set(response.error?.humanMessage || 'Failed to clear SMS opt-out');
      }
    });
  }

  submitEditUser(): void {
    const user = this.editUser();
    if (!user?.id) return;

    const firstName = this.editFirstName().trim();
    const lastName = this.editLastName().trim();

    if (!firstName || !lastName) {
      this.editError.set('First name and last name are required');
      return;
    }

    this.editLoading.set(true);
    this.editError.set(undefined);

    const phone = this.editPhone().trim();

    this.userService.updateUserInfo({
      user_id: user.id,
      first_name: firstName,
      last_name: lastName,
      phone: phone || undefined
    }).subscribe(response => {
      this.editLoading.set(false);
      if (response.success) {
        this.showEditModal.set(false);
        this.successMessage.set(`User ${firstName} ${lastName} updated successfully.`);
        this.loadUsers();
        setTimeout(() => this.successMessage.set(undefined), 5000);
      } else {
        this.editError.set(response.error?.humanMessage || 'Failed to update user');
      }
    });
  }

  // =========================================================================
  // Error & Retry
  // =========================================================================

  viewError(user: ManagedUser): void {
    this.errorDetailUser.set(user);
    this.showErrorModal.set(true);
  }

  retryUser(user: ManagedUser): void {
    if (!user.provision_id) {
      this.errorMessage.set('Cannot retry: no provisioning record found');
      return;
    }
    this.userService.retryProvisioning(user.provision_id).subscribe(response => {
      if (response.success) {
        this.successMessage.set(`Retrying provisioning for ${user.display_name}...`);
        setTimeout(() => {
          this.successMessage.set(undefined);
          this.loadUsers();
        }, 3000);
      } else {
        this.errorMessage.set(response.error?.humanMessage || 'Retry failed');
      }
    });
  }

  // =========================================================================
  // Import Users
  // =========================================================================

  /** Column definitions for user import */
  private readonly userImportColumns: ImportColumn[] = [
    { name: 'Email', key: 'email', required: true, type: 'email', hint: 'Required. User email address' },
    { name: 'First Name', key: 'first_name', required: true, type: 'text', hint: 'Required. User first name' },
    { name: 'Last Name', key: 'last_name', required: true, type: 'text', hint: 'Required. User last name' },
    { name: 'Phone', key: 'phone', required: false, type: 'phone', hint: 'Optional. 10-digit phone number' },
    { name: 'Roles', key: 'roles', required: false, type: 'comma-list', hint: 'Optional. Comma-separated role names (default: user)' },
    { name: 'Send Welcome Email', key: 'send_welcome_email', required: false, type: 'boolean', hint: 'Optional. true/false (default: true)' },
    { name: 'Send Welcome SMS', key: 'send_welcome_sms', required: false, type: 'boolean', hint: 'Optional. true/false (default: false)' }
  ];

  /** Custom import configuration for the import modal */
  userImportConfig: CustomImportConfig = {
    title: 'Import Users',
    columns: this.userImportColumns,
    submit: (validRows: Record<string, any>[]): Observable<CustomImportResult> => {
      return this.submitUserImport(validRows);
    },
    generateTemplate: () => {
      this.importExportService.generateUserImportTemplate(this.manageableRoles());
    }
  };

  openImportModal(): void {
    this.showImportModal.set(true);
  }

  /**
   * Transform validated rows to ProvisionUserRequest[] and submit via RPC.
   * Applies defaults: roles → ['user'], send_welcome_email → true.
   */
  submitUserImport(validRows: Record<string, any>[]): Observable<CustomImportResult> {
    const users: ProvisionUserRequest[] = validRows.map(row => ({
      email: row['email'],
      first_name: row['first_name'],
      last_name: row['last_name'],
      phone: row['phone'] || undefined,
      initial_roles: row['roles'] && row['roles'].length > 0 ? row['roles'] : ['user'],
      send_welcome_email: row['send_welcome_email'] !== null ? row['send_welcome_email'] : true,
      send_welcome_sms: row['send_welcome_sms'] !== null ? row['send_welcome_sms'] : false
    }));

    return this.userService.importUsersDetailed(users).pipe(
      map(result => ({
        success: result.success,
        importedCount: result.created_count,
        errorCount: result.error_count,
        errors: result.errors.map(e => ({
          index: e.index,
          identifier: e.email,
          error: e.error
        }))
      }))
    );
  }

  onImportSuccess(count: number): void {
    this.showImportModal.set(false);
    this.successMessage.set(`${count} users submitted for provisioning.`);
    this.loadUsers();
    setTimeout(() => this.successMessage.set(undefined), 5000);
  }

  private emptyUser(): ProvisionUserRequest {
    return {
      email: '',
      first_name: '',
      last_name: '',
      phone: undefined,
      initial_roles: ['user'],
      send_welcome_email: true,
      send_welcome_sms: false
    };
  }
}
