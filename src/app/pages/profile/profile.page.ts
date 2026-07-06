/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { Component, ChangeDetectionStrategy, inject, signal, computed, DestroyRef } from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, ActivatedRoute } from '@angular/router';
import { combineLatest, forkJoin, of, take } from 'rxjs';
import { filter, switchMap } from 'rxjs/operators';
import { ProfileService, ProfileExtension, UserPrivateRecord } from '../../services/profile.service';
import { NotificationService, NotificationPreference } from '../../services/notification.service';
import { AuthService } from '../../services/auth.service';
import { SchemaService } from '../../services/schema.service';
import { DataService } from '../../services/data.service';
import { UserManagementService } from '../../services/user-management.service';
import { LocaleService } from '../../services/locale.service';
import { SchemaEntityProperty, InverseRelationshipData, EntityPropertyType } from '../../interfaces/entity';
import { DisplayPropertyComponent } from '../../components/display-property/display-property.component';
import { RelatedRecordsComponent } from '../../components/related-records/related-records.component';
import { EntityActionPanelComponent } from '../../components/entity-action-panel/entity-action-panel.component';
import { getSmsConfig } from '../../config/runtime';
import { TranslatePipe } from '../../pipes/translate.pipe';

@Component({
  selector: 'app-profile-page',
  standalone: true,
  imports: [CommonModule, FormsModule, DisplayPropertyComponent, RelatedRecordsComponent, EntityActionPanelComponent, TranslatePipe],
  templateUrl: './profile.page.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ProfilePage {
  private profileService = inject(ProfileService);
  private notificationService = inject(NotificationService);
  auth = inject(AuthService);
  private schemaService = inject(SchemaService);
  private dataService = inject(DataService);
  private userManagementService = inject(UserManagementService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private destroyRef = inject(DestroyRef);
  localeService = inject(LocaleService);

  // SMS config
  smsConfigured = getSmsConfig().configured;

  // ─── Route mode signals ──────────────────────────────────────────
  isOwnProfile = signal(true);
  targetUserId = signal<string | null>(null);
  canEditCoreInfo = signal(false);
  notFound = signal(false);

  // ─── Loading state ───────────────────────────────────────────────
  loading = signal(true);

  // ─── Core user info ──────────────────────────────────────────────
  userRecord = signal<UserPrivateRecord | null>(null);
  editingCoreInfo = signal(false);
  editFirstName = '';
  editLastName = '';
  editPhone = '';
  editLocale = '';
  saving = signal(false);
  saveMessage = signal('');
  saveSuccess = signal(false);

  // ─── Notification preferences ────────────────────────────────────
  preferencesLoading = signal(false);
  emailPreference = signal<NotificationPreference | undefined>(undefined);
  smsPreference = signal<NotificationPreference | undefined>(undefined);

  // ─── Profile extensions ──────────────────────────────────────────
  extensions = signal<ProfileExtension[]>([]);
  extensionProperties = signal<Map<string, SchemaEntityProperty[]>>(new Map());
  extensionRecords = signal<Map<string, any>>(new Map());

  // ─── Related records ─────────────────────────────────────────────
  relatedRecords = signal<InverseRelationshipData[]>([]);

  // ─── Enriched user data (for entity action conditions) ──────────
  enrichedUserData = computed(() => {
    const user = this.userRecord();
    if (!user) return null;

    const enriched: Record<string, any> = { ...user };

    // Add has_record flags for all extensions (available after Phase 1)
    for (const ext of this.extensions()) {
      enriched[ext.table_name] = { has_record: ext.has_record };
    }

    // Overlay full extension records when available (after Phase 3)
    for (const [tableName, record] of this.extensionRecords().entries()) {
      enriched[tableName] = { ...record, has_record: true };
    }

    return enriched;
  });

  // Columns to exclude from extension display
  private systemColumns = new Set([
    'id', 'created_at', 'updated_at', 'civic_os_text_search', 'display_name'
  ]);

  constructor() {
    // Observable that emits once when permissions are loaded (handles async permission cache)
    const permissionsLoaded$ = toObservable(this.auth.permissionsLoaded).pipe(
      filter(loaded => loaded),
      take(1)
    );

    this.route.paramMap.pipe(
      takeUntilDestroyed(this.destroyRef)
    ).subscribe(params => {
      const userId = params.get('userId');

      // Reset state on route change
      this.loading.set(true);
      this.notFound.set(false);

      if (userId) {
        // Wait for both user ID and permissions cache before proceeding.
        // permissionsCache is loaded asynchronously via RPC after Keycloak Ready,
        // so hasPermission() may return false if checked too early.
        combineLatest([
          this.auth.getCurrentUserId().pipe(take(1)),
          permissionsLoaded$
        ]).pipe(take(1)).subscribe(([ownId]) => {
          if (userId === ownId) {
            this.router.navigate(['/profile'], { replaceUrl: true });
            return;
          }

          this.isOwnProfile.set(false);
          this.targetUserId.set(userId);
          this.canEditCoreInfo.set(this.auth.hasPermission('civic_os_users_private', 'update'));
          this.loadOtherProfile(userId);
        });
      } else {
        this.isOwnProfile.set(true);
        this.targetUserId.set(null);
        this.canEditCoreInfo.set(true);
        this.loadOwnProfile();
      }
    });
  }

  // ─── Own profile loading ─────────────────────────────────────────

  private loadOwnProfile(): void {
    if (!this.auth.authenticated()) return;

    forkJoin({
      user: this.profileService.getCurrentUserPrivateRecord(),
      extensions: this.profileService.getProfileExtensions(),
      prefs: this.notificationService.getUserPreferences()
    }).pipe(
      takeUntilDestroyed(this.destroyRef)
    ).subscribe(result => {
      this.userRecord.set(result.user);
      this.extensions.set(result.extensions);

      this.emailPreference.set(result.prefs.find(p => p.channel === 'email'));
      this.smsPreference.set(result.prefs.find(p => p.channel === 'sms'));

      this.loading.set(false);

      this.loadExtensionData(result.extensions, result.user?.id || '');
      this.loadRelatedRecords(result.extensions, result.user?.id || '');
    });
  }

  // ─── Other user profile loading ──────────────────────────────────

  private loadOtherProfile(userId: string): void {
    forkJoin({
      user: this.profileService.getUserProfileRecord(userId),
      extensions: this.profileService.getProfileExtensions(userId)
    }).pipe(
      takeUntilDestroyed(this.destroyRef)
    ).subscribe(result => {
      if (!result.user) {
        this.notFound.set(true);
        this.loading.set(false);
        return;
      }

      this.userRecord.set(result.user);
      this.extensions.set(result.extensions);
      this.loading.set(false);

      this.loadExtensionData(result.extensions, userId);
      this.loadRelatedRecords(result.extensions, userId);
    });
  }

  // ─── Phase 2: Load extension schemas and records ─────────────────

  private loadExtensionData(extensions: ProfileExtension[], userId: string): void {
    const completedExtensions = extensions.filter(e => e.has_record);
    if (completedExtensions.length === 0) return;

    const entityRequests: Record<string, any> = {};
    for (const ext of completedExtensions) {
      entityRequests[ext.table_name] = this.schemaService.getEntity(ext.table_name).pipe(take(1));
    }

    forkJoin(entityRequests).pipe(
      switchMap(entities => {
        const propRequests: Record<string, any> = {};
        for (const [table, entity] of Object.entries(entities)) {
          if (entity) {
            propRequests[table] = this.schemaService.getPropsForDetail(entity as any).pipe(take(1));
          }
        }
        if (Object.keys(propRequests).length === 0) return of({} as Record<string, SchemaEntityProperty[]>);
        return forkJoin(propRequests);
      }),
      takeUntilDestroyed(this.destroyRef)
    ).subscribe(propsByTable => {
      const fkColumns = new Set(extensions.map(e => e.user_fk_column));

      const propsMap = new Map<string, SchemaEntityProperty[]>();
      for (const [table, props] of Object.entries(propsByTable)) {
        const filtered = (props as SchemaEntityProperty[]).filter(p =>
          !this.systemColumns.has(p.column_name) && !fkColumns.has(p.column_name)
        );
        propsMap.set(table, filtered);
      }
      this.extensionProperties.set(propsMap);

      this.loadExtensionRecords(completedExtensions, userId, propsMap);
    });
  }

  private loadExtensionRecords(
    extensions: ProfileExtension[],
    userId: string,
    propsMap: Map<string, SchemaEntityProperty[]>
  ): void {
    const requests: Record<string, any> = {};
    for (const ext of extensions) {
      const props = propsMap.get(ext.table_name) || [];
      const selectParts = ['id', ...props.map(p => SchemaService.propertyToSelectString(p))];
      const select = [...new Set(selectParts)].join(',');
      requests[ext.table_name] = this.profileService.getExtensionRecord(
        ext.table_name, ext.user_fk_column, userId, select
      );
    }

    forkJoin(requests).pipe(
      takeUntilDestroyed(this.destroyRef)
    ).subscribe(results => {
      const recordsMap = new Map<string, any>();
      for (const [table, records] of Object.entries(results)) {
        const arr = records as any[];
        if (arr.length > 0) {
          const record = arr[0];
          const tableProps = propsMap.get(table) || [];
          for (const p of tableProps) {
            if (p.type === EntityPropertyType.ManyToMany && p.many_to_many_meta) {
              const junctionData = record[p.column_name] || [];
              const extraColNames = p.many_to_many_meta.extraColumns.map(c => c.column_name);
              record[p.column_name] = DataService.transformManyToManyData(
                junctionData,
                p.many_to_many_meta.relatedTable,
                extraColNames.length > 0 ? extraColNames : undefined,
                p.many_to_many_meta.parentHops,
                p.many_to_many_meta.parentHops?.length ? p.many_to_many_meta.targetTable : undefined
              );
            }
          }
          recordsMap.set(table, record);
        }
      }
      this.extensionRecords.set(recordsMap);
    });
  }

  // ─── Phase 3: Load related records (inverse relationships) ───────

  private loadRelatedRecords(extensions: ProfileExtension[], userId: string): void {
    if (!userId) return;

    const excludeTables = new Set([
      ...extensions.map(e => e.table_name),
      'civic_os_users_private'
    ]);

    this.schemaService.getInverseRelationships('civic_os_users', excludeTables).pipe(
      switchMap(relationships => {
        if (relationships.length === 0) return of([]);

        const dataRequests = relationships.map(meta =>
          this.dataService.getInverseRelationshipData(meta, userId)
        );
        return forkJoin(dataRequests);
      }),
      takeUntilDestroyed(this.destroyRef)
    ).subscribe(results => {
      this.relatedRecords.set(results.filter(r => r.totalCount > 0));
    });
  }

  // ─── Core info editing ───────────────────────────────────────────

  startEditCoreInfo(): void {
    const user = this.userRecord();
    if (!user) return;
    this.editFirstName = user.first_name || '';
    this.editLastName = user.last_name || '';
    this.editPhone = user.phone || '';
    this.editLocale = this.localeService.locale();
    this.editingCoreInfo.set(true);
    this.saveMessage.set('');
  }

  cancelEditCoreInfo(): void {
    this.editingCoreInfo.set(false);
    this.saveMessage.set('');
  }

  /** True when phone has some digits but is not exactly 10 */
  isPhoneInvalid(): boolean {
    const digits = this.editPhone.replace(/\D/g, '');
    return digits.length > 0 && digits.length !== 10;
  }

  saveCoreInfo(): void {
    if (!this.editFirstName.trim() || !this.editLastName.trim()) return;
    if (this.isPhoneInvalid()) return;

    this.saving.set(true);
    this.saveMessage.set('');

    if (this.isOwnProfile()) {
      this.saveOwnProfile();
    } else {
      this.saveOtherUserProfile();
    }
  }

  private saveOwnProfile(): void {
    this.profileService.updateOwnProfile(
      this.editFirstName.trim(),
      this.editLastName.trim(),
      this.editPhone || undefined
    ).pipe(
      takeUntilDestroyed(this.destroyRef)
    ).subscribe(result => {
      this.saving.set(false);
      if (result.success) {
        this.saveSuccess.set(true);
        this.saveMessage.set(result.message || 'Profile updated successfully');
        const user = this.userRecord();
        if (user) {
          this.userRecord.set({
            ...user,
            first_name: this.editFirstName.trim(),
            last_name: this.editLastName.trim(),
            phone: this.editPhone || null,
            display_name: `${this.editFirstName.trim()} ${this.editLastName.trim()}`
          });
        }
        this.editingCoreInfo.set(false);

        // Apply locale change only on successful save
        if (this.editLocale !== this.localeService.locale()) {
          this.localeService.setLocale(this.editLocale);
        }

        // Reload notification preferences (trigger may have updated SMS phone)
        this.notificationService.getUserPreferences().pipe(
          takeUntilDestroyed(this.destroyRef)
        ).subscribe(prefs => {
          this.emailPreference.set(prefs.find(p => p.channel === 'email'));
          this.smsPreference.set(prefs.find(p => p.channel === 'sms'));
        });
      } else {
        this.saveSuccess.set(false);
        this.saveMessage.set(result.error || 'Failed to update profile');
      }
    });
  }

  private saveOtherUserProfile(): void {
    const userId = this.targetUserId();
    if (!userId) return;

    this.userManagementService.updateUserInfo({
      user_id: userId,
      first_name: this.editFirstName.trim(),
      last_name: this.editLastName.trim(),
      phone: this.editPhone || undefined
    }).pipe(
      takeUntilDestroyed(this.destroyRef)
    ).subscribe(result => {
      this.saving.set(false);
      if (result.success) {
        this.saveSuccess.set(true);
        this.saveMessage.set('Profile updated successfully');
        const user = this.userRecord();
        if (user) {
          this.userRecord.set({
            ...user,
            first_name: this.editFirstName.trim(),
            last_name: this.editLastName.trim(),
            phone: this.editPhone || null,
            display_name: `${this.editFirstName.trim()} ${this.editLastName.trim()}`
          });
        }
        this.editingCoreInfo.set(false);
      } else {
        this.saveSuccess.set(false);
        this.saveMessage.set(result.error?.humanMessage || 'Failed to update profile');
      }
    });
  }

  // ─── Phone formatting ────────────────────────────────────────────

  /** Format raw digits as (555) 123-4567 for display */
  getFormattedPhone(rawDigits?: string | null): string {
    const digits = (rawDigits || '').replace(/\D/g, '');
    if (!digits) return '';
    if (digits.length <= 3) return `(${digits}`;
    if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6, 10)}`;
  }

  /** Handle phone input: strip non-digits, store raw, format display */
  onPhoneInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    const cursorPos = input.selectionStart || 0;
    const digitsBeforeCursor = input.value.slice(0, cursorPos).replace(/\D/g, '').length;

    const digits = input.value.replace(/\D/g, '').slice(0, 10);
    this.editPhone = digits;

    const formatted = this.getFormattedPhone(digits);
    input.value = formatted;

    let newCursorPos = 0;
    let digitCount = 0;
    for (let i = 0; i < formatted.length && digitCount < digitsBeforeCursor; i++) {
      if (/\d/.test(formatted[i])) digitCount++;
      newCursorPos = i + 1;
    }
    input.setSelectionRange(newCursorPos, newCursorPos);
  }

  // ─── Notification toggles ───────────────────────────────────────

  onEmailToggle(enabled: boolean): void {
    this.notificationService.updatePreference('email', enabled).pipe(
      takeUntilDestroyed(this.destroyRef)
    ).subscribe(result => {
      if (result.success) {
        const current = this.emailPreference();
        if (current) {
          this.emailPreference.set({ ...current, enabled });
        }
      }
    });
  }

  onSmsToggle(enabled: boolean): void {
    this.notificationService.updatePreference('sms', enabled).pipe(
      takeUntilDestroyed(this.destroyRef)
    ).subscribe(result => {
      if (result.success) {
        const current = this.smsPreference();
        if (current) {
          this.smsPreference.set({ ...current, enabled });
        }
      }
    });
  }

  // ─── Extension navigation ───────────────────────────────────────

  navigateToEditExtension(tableName: string, recordId: string): void {
    const returnTo = this.isOwnProfile() ? '/profile' : `/profile/${this.targetUserId()}`;
    this.router.navigate(['edit', tableName, recordId], {
      queryParams: { returnTo }
    });
  }

  navigateToCreateExtension(tableName: string, fkColumn: string): void {
    const userId = this.targetUserId();
    if (this.isOwnProfile()) {
      this.auth.getCurrentUserId().pipe(take(1)).subscribe(ownId => {
        if (ownId) {
          this.router.navigate(['create', tableName], {
            queryParams: { [fkColumn]: ownId, returnTo: '/profile' }
          });
        }
      });
    } else if (userId) {
      this.router.navigate(['create', tableName], {
        queryParams: { [fkColumn]: userId, returnTo: `/profile/${userId}` }
      });
    }
  }

  // ─── Profile reload (triggered by entity action panel) ──────────

  reloadProfile(): void {
    if (this.isOwnProfile()) {
      this.loadOwnProfile();
    } else {
      const userId = this.targetUserId();
      if (userId) this.loadOtherProfile(userId);
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────

  getColSpan(prop: SchemaEntityProperty): string {
    const span = SchemaService.getColumnSpan(prop);
    return span >= 2 ? 'col-span-full' : '';
  }
}
