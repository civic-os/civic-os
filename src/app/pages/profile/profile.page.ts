/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { Component, ChangeDetectionStrategy, inject, signal, effect, DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { forkJoin, of, take } from 'rxjs';
import { switchMap } from 'rxjs/operators';
import { ProfileService, ProfileExtension, UserPrivateRecord } from '../../services/profile.service';
import { NotificationService, NotificationPreference } from '../../services/notification.service';
import { AuthService } from '../../services/auth.service';
import { SchemaService } from '../../services/schema.service';
import { DataService } from '../../services/data.service';
import { SchemaEntityProperty, InverseRelationshipData, EntityPropertyType } from '../../interfaces/entity';
import { DisplayPropertyComponent } from '../../components/display-property/display-property.component';
import { RelatedRecordsComponent } from '../../components/related-records/related-records.component';
import { getSmsConfig } from '../../config/runtime';
import { TranslatePipe } from '../../pipes/translate.pipe';

@Component({
  selector: 'app-profile-page',
  standalone: true,
  imports: [CommonModule, FormsModule, DisplayPropertyComponent, RelatedRecordsComponent, TranslatePipe],
  templateUrl: './profile.page.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ProfilePage {
  private profileService = inject(ProfileService);
  private notificationService = inject(NotificationService);
  private auth = inject(AuthService);
  private schemaService = inject(SchemaService);
  private dataService = inject(DataService);
  private router = inject(Router);
  private destroyRef = inject(DestroyRef);

  // SMS config
  smsConfigured = getSmsConfig().configured;

  // ─── Loading state ─────────────────────────────────────────────────
  loading = signal(true);

  // ─── Core user info ────────────────────────────────────────────────
  userRecord = signal<UserPrivateRecord | null>(null);
  editingCoreInfo = signal(false);
  editFirstName = '';
  editLastName = '';
  editPhone = '';
  saving = signal(false);
  saveMessage = signal('');
  saveSuccess = signal(false);

  // ─── Notification preferences ──────────────────────────────────────
  preferencesLoading = signal(false);
  emailPreference = signal<NotificationPreference | undefined>(undefined);
  smsPreference = signal<NotificationPreference | undefined>(undefined);

  // ─── Profile extensions ────────────────────────────────────────────
  extensions = signal<ProfileExtension[]>([]);
  extensionProperties = signal<Map<string, SchemaEntityProperty[]>>(new Map());
  extensionRecords = signal<Map<string, any>>(new Map());

  // ─── Related records ──────────────────────────────────────────────
  relatedRecords = signal<InverseRelationshipData[]>([]);


  // Columns to exclude from extension display
  private systemColumns = new Set([
    'id', 'created_at', 'updated_at', 'civic_os_text_search', 'display_name'
  ]);

  // ─── Phase 1: Load core data ───────────────────────────────────────
  private loadDataEffect = effect(() => {
    // This runs once on init. We read auth.authenticated() to ensure user is ready.
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

      // Set notification preferences
      this.emailPreference.set(result.prefs.find(p => p.channel === 'email'));
      this.smsPreference.set(result.prefs.find(p => p.channel === 'sms'));

      this.loading.set(false);

      // Trigger phase 2: load extension schemas + records
      this.loadExtensionData(result.extensions, result.user?.id || '');

      // Trigger phase 3: load related records (inverse relationships)
      this.loadRelatedRecords(result.extensions, result.user?.id || '');
    });
  });

  // ─── Phase 2: Load extension schemas and records ───────────────────
  private loadExtensionData(extensions: ProfileExtension[], userId: string): void {
    const completedExtensions = extensions.filter(e => e.has_record);
    if (completedExtensions.length === 0) return;

    // Load schema properties for all completed extension tables
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
      // Build FK column set from extensions
      const fkColumns = new Set(extensions.map(e => e.user_fk_column));

      const propsMap = new Map<string, SchemaEntityProperty[]>();
      for (const [table, props] of Object.entries(propsByTable)) {
        const filtered = (props as SchemaEntityProperty[]).filter(p =>
          !this.systemColumns.has(p.column_name) && !fkColumns.has(p.column_name)
        );
        propsMap.set(table, filtered);
      }
      this.extensionProperties.set(propsMap);

      // Now load actual records
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
          // Transform M:M junction data so DisplayPropertyComponent gets flat items
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

  // ─── Phase 3: Load related records (inverse relationships) ────────
  private loadRelatedRecords(extensions: ProfileExtension[], userId: string): void {
    if (!userId) return;

    // Exclude extension tables (shown in their own sections) and framework tables
    const excludeTables = new Set([
      ...extensions.map(e => e.table_name),
      'civic_os_users_private'
    ]);

    this.schemaService.getInverseRelationships('civic_os_users', excludeTables).pipe(
      switchMap(relationships => {
        if (relationships.length === 0) return of([]);

        // Fetch preview data for each relationship in parallel
        const dataRequests = relationships.map(meta =>
          this.dataService.getInverseRelationshipData(meta, userId)
        );
        return forkJoin(dataRequests);
      }),
      takeUntilDestroyed(this.destroyRef)
    ).subscribe(results => {
      // Only show relationships with records
      this.relatedRecords.set(results.filter(r => r.totalCount > 0));
    });
  }

  // ─── Core info editing ─────────────────────────────────────────────

  startEditCoreInfo(): void {
    const user = this.userRecord();
    if (!user) return;
    this.editFirstName = user.first_name || '';
    this.editLastName = user.last_name || '';
    this.editPhone = user.phone || '';
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
        // Update the local record
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

        // Reload notification preferences — the trigger updates SMS phone_number
        // on phone change, so the UI needs to reflect the new state
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

  // ─── Phone formatting ──────────────────────────────────────────────

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

    // Extract only digits, limit to 10
    const digits = input.value.replace(/\D/g, '').slice(0, 10);
    this.editPhone = digits;

    // Format for display
    const formatted = this.getFormattedPhone(digits);
    input.value = formatted;

    // Restore cursor position
    let newCursorPos = 0;
    let digitCount = 0;
    for (let i = 0; i < formatted.length && digitCount < digitsBeforeCursor; i++) {
      if (/\d/.test(formatted[i])) digitCount++;
      newCursorPos = i + 1;
    }
    input.setSelectionRange(newCursorPos, newCursorPos);
  }

  // ─── Notification toggles ─────────────────────────────────────────

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

  // ─── Extension navigation ─────────────────────────────────────────

  navigateToEditExtension(tableName: string, recordId: string): void {
    this.router.navigate(['edit', tableName, recordId], {
      queryParams: { returnTo: '/profile' }
    });
  }

  navigateToCreateExtension(tableName: string, fkColumn: string): void {
    this.auth.getCurrentUserId().pipe(take(1)).subscribe(userId => {
      if (userId) {
        this.router.navigate(['create', tableName], {
          queryParams: { [fkColumn]: userId, returnTo: '/profile' }
        });
      }
    });
  }

  // ─── Helpers ───────────────────────────────────────────────────────

  getColSpan(prop: SchemaEntityProperty): string {
    const span = SchemaService.getColumnSpan(prop);
    return span >= 2 ? 'col-span-full' : '';
  }
}
