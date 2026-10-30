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

import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { Subject, debounce, filter, map, of, switchMap, tap, timer } from 'rxjs';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { AuthService } from '../../services/auth.service';
import { ConfigService } from '../../services/config.service';
import { TranslationService } from '../../services/translation.service';
import {
  ConfigAdminService,
  ENV_VAR_NAMES,
  InstanceConfigRow,
  SetConfigResult
} from '../../services/config-admin.service';
import { RECOMMENDED_THEMES, themeNameToLabel } from '../../constants/themes';
import { getFaviconUrl, getMapConfig, getPwaAppNameOverride, getPwaConfig } from '../../config/runtime';

export type FieldStatus = 'idle' | 'saving' | 'saved' | 'error';

export interface ConfigGroup {
  key: string | null;
  displayName: string | null;
  description: string | null;
  icon: string | null;
  rows: InstanceConfigRow[];
}

interface FieldEmission {
  value: string | null;
  immediate: boolean;
}

/** Quiet period after the last keystroke before a text field is saved. */
export const CONFIG_SAVE_DEBOUNCE_MS = 1000;

/** A same-origin path: one leading slash, not `//host` or `/\host`, no whitespace or backslash. */
const SAFE_RETURN_TO = /^\/(?![/\\])[^\s\\]*$/;

@Component({
  selector: 'app-admin-config',
  standalone: true,
  imports: [TranslatePipe],
  templateUrl: './admin-config.page.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class AdminConfigPage {
  private configAdmin = inject(ConfigAdminService);
  private configService = inject(ConfigService);
  private translation = inject(TranslationService);
  private auth = inject(AuthService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private destroyRef = inject(DestroyRef);

  readonly themeOptions = RECOMMENDED_THEMES;
  readonly themeLabel = themeNameToLabel;

  // Data
  groups = signal<ConfigGroup[]>([]);
  loading = signal(true);
  error = signal<string | undefined>(undefined);

  /** Current field values (null = unset). Holds drafts while the user is typing. */
  values = signal<Record<string, string | null>>({});
  statuses = signal<Record<string, FieldStatus>>({});
  fieldErrors = signal<Record<string, string>>({});

  private subjects = new Map<string, Subject<FieldEmission>>();
  /** Per key: the value last sent, the value the server last stored, the value last rejected. */
  private lastSent = new Map<string, string | null>();
  private stored = new Map<string, string | null>();
  private failed = new Map<string, string | null>();

  canEdit = computed(() =>
    this.auth.permissionsLoaded() && this.auth.hasPermission('metadata.instance_config', 'update')
  );

  // Done button
  private returnToParam = toSignal(
    this.route.queryParamMap.pipe(map(params => params.get('returnTo'))),
    { initialValue: null }
  );
  safeReturnTo = computed(() => {
    const value = this.returnToParam();
    return value && SAFE_RETURN_TO.test(value) ? value : null;
  });

  // Deployment section (read-only Tier 1 values; nothing secret)
  readonly deployment = {
    faviconUrl: getFaviconUrl(),
    pwaEnabled: getPwaConfig().enabled,
    pwaAppName: getPwaAppNameOverride(),
    mapTileUrl: getMapConfig().tileUrl
  };

  constructor() {
    this.destroyRef.onDestroy(() => this.flushPendingSaves());
    this.load();
  }

  // ── Data Loading ──────────────────────────────

  load() {
    this.loading.set(true);
    this.error.set(undefined);
    this.configAdmin.getConfig().subscribe({
      next: (rows) => {
        const values: Record<string, string | null> = {};
        for (const row of rows) {
          values[row.config_key] = row.config_value;
          this.setupField(row);
        }
        this.values.set(values);
        this.groups.set(this.buildGroups(rows));
        this.loading.set(false);
      },
      error: (err) => {
        console.error('Error fetching instance config:', err);
        this.error.set('admin_config.load_error');
        this.loading.set(false);
      }
    });
  }

  /** Groups in API order; rows without a group go last. */
  private buildGroups(rows: InstanceConfigRow[]): ConfigGroup[] {
    const grouped = new Map<string, ConfigGroup>();
    const ungrouped: InstanceConfigRow[] = [];
    for (const row of rows) {
      if (row.group_key === null || row.group_key === undefined) {
        ungrouped.push(row);
        continue;
      }
      let group = grouped.get(row.group_key);
      if (!group) {
        group = {
          key: row.group_key,
          displayName: row.group_display_name,
          description: row.group_description,
          icon: row.group_icon,
          rows: []
        };
        grouped.set(row.group_key, group);
      }
      group.rows.push(row);
    }
    const result = [...grouped.values()];
    if (ungrouped.length > 0) {
      result.push({ key: null, displayName: null, description: null, icon: null, rows: ungrouped });
    }
    return result;
  }

  // ── Saving ────────────────────────────────────

  /** One Subject per field: latest value wins, a text field never saves per keystroke. */
  private setupField(row: InstanceConfigRow) {
    const key = row.config_key;
    const subject = new Subject<FieldEmission>();
    this.subjects.set(key, subject);
    // Seed with the loaded value so re-entering it is not a change.
    this.lastSent.set(key, row.config_value);
    this.stored.set(key, row.config_value);

    subject.pipe(
      debounce(e => e.immediate ? of(0) : timer(CONFIG_SAVE_DEBOUNCE_MS)),
      // Compared with the last value sent; a failed save clears it, so the same value can be retried.
      filter(e => !this.lastSent.has(key) || this.lastSent.get(key) !== e.value),
      tap(e => {
        this.lastSent.set(key, e.value);
        this.setStatus(key, 'saving');
      }),
      switchMap(e => this.configAdmin.setValue(key, e.value).pipe(
        map(result => ({ sent: e.value, result }))
      )),
      takeUntilDestroyed(this.destroyRef)
    ).subscribe(({ sent, result }) => this.applyResult(key, sent, result));
  }

  /**
   * Leaving the page (Done, a sidebar link) inside the debounce window, or while a save is in
   * flight, would drop the edit. Send each field whose draft differs from the stored value.
   * The service is root-scoped, so the request outlives this page.
   */
  private flushPendingSaves() {
    if (!this.canEdit()) return;
    for (const key of this.subjects.keys()) {
      const draft = this.values()[key] ?? null;
      const value = draft === '' ? null : draft;
      if (value === this.stored.get(key) || value === this.failed.get(key)) continue;
      this.configAdmin.setValue(key, value).subscribe();
    }
  }

  private applyResult(key: string, sent: string | null, result: SetConfigResult) {
    if (!result.success) {
      this.lastSent.delete(key);
      this.failed.set(key, sent);
      this.fieldErrors.update(errors => ({ ...errors, [key]: result.error || '' }));
      this.setStatus(key, 'error');
      return;
    }
    this.stored.set(key, sent);
    this.failed.delete(key);
    this.fieldErrors.update(errors => {
      const rest = { ...errors };
      delete rest[key];
      return rest;
    });
    // Show the normalized value, unless the user has already typed something newer.
    // A newer draft is still queued: stay "saving" until it lands.
    const current = this.values()[key] ?? null;
    if ((current === '' ? null : current) !== sent) return;
    this.values.update(values => ({ ...values, [key]: result.config_value ?? null }));
    this.setStatus(key, 'saved');
  }

  private setStatus(key: string, status: FieldStatus) {
    this.statuses.update(statuses => ({ ...statuses, [key]: status }));
  }

  private emit(key: string, value: string | null, immediate: boolean) {
    this.values.update(values => ({ ...values, [key]: value }));
    if (this.statuses()[key] === 'saved') this.setStatus(key, 'idle');
    this.subjects.get(key)?.next({ value: value === '' ? null : value, immediate });
  }

  onTextInput(row: InstanceConfigRow, value: string) {
    this.emit(row.config_key, value, false);
  }

  onToggle(row: InstanceConfigRow, checked: boolean) {
    this.emit(row.config_key, String(checked), true);
  }

  onSelect(row: InstanceConfigRow, value: string) {
    this.emit(row.config_key, value === '' ? null : value, true);
  }

  reset(row: InstanceConfigRow) {
    this.emit(row.config_key, null, true);
  }

  // ── View helpers ──────────────────────────────

  statusOf(key: string): FieldStatus {
    return this.statuses()[key] ?? 'idle';
  }

  isSet(key: string): boolean {
    const value = this.values()[key];
    return value !== null && value !== undefined && value !== '';
  }

  textValue(key: string): string {
    return this.values()[key] ?? '';
  }

  envVarFor(key: string): string | undefined {
    return ENV_VAR_NAMES[key];
  }

  /** True for an unset key whose default_value applies (integrator keys only). */
  usesDefault(row: InstanceConfigRow): boolean {
    return !this.isSet(row.config_key) && !!row.default_value;
  }

  /**
   * Placeholder of an unset field: `<ENV_VAR>: <inherited value>` for a framework key,
   * `Default: <value>` for a key with a default_value, else empty.
   */
  placeholderFor(row: InstanceConfigRow): string {
    if (this.isSet(row.config_key)) return '';
    const envVar = ENV_VAR_NAMES[row.config_key];
    if (envVar) return `${envVar}: ${this.configService.envValue(row.config_key) ?? ''}`;
    return row.default_value ? this.defaultLabel(row.default_value) : '';
  }

  /** Effective toggle state: the DB value, else the inherited ENV value or the default. */
  toggleChecked(row: InstanceConfigRow): boolean {
    const value = this.values()[row.config_key];
    if (value === 'true') return true;
    if (value === 'false') return false;
    const fallback = ENV_VAR_NAMES[row.config_key] ? this.configService.envValue(row.config_key) : row.default_value;
    return fallback === 'true';
  }

  /** Label for the theme select's empty option: the inherited theme or the default, else null. */
  themeInheritedLabel(row: InstanceConfigRow): string | null {
    const envVar = ENV_VAR_NAMES[row.config_key];
    if (!envVar) return row.default_value ? this.defaultLabel(themeNameToLabel(row.default_value)) : null;
    const env = this.configService.envValue(row.config_key);
    return env ? `${envVar}: ${themeNameToLabel(env)}` : null;
  }

  private defaultLabel(value: string): string {
    this.translation.version();
    return this.translation.get('admin_config.default_is', { value });
  }

  /** The stored theme when it is not one of the vetted options, so the select can still show it. */
  unlistedTheme(key: string): string | null {
    const value = this.values()[key];
    return value && !RECOMMENDED_THEMES.includes(value) ? value : null;
  }

  /** Read-only rendering: the DB value, else the inherited ENV value or the default. */
  readOnlyValue(row: InstanceConfigRow): { text: string; inheritedFrom: string | null; isDefault: boolean } {
    const value = this.values()[row.config_key];
    if (value !== null && value !== undefined && value !== '') return { text: value, inheritedFrom: null, isDefault: false };
    const envVar = ENV_VAR_NAMES[row.config_key];
    const env = envVar ? this.configService.envValue(row.config_key) : null;
    if (envVar && env) return { text: env, inheritedFrom: envVar, isDefault: false };
    if (row.default_value) return { text: row.default_value, inheritedFrom: null, isDefault: true };
    return { text: '', inheritedFrom: null, isDefault: false };
  }

  done() {
    const target = this.safeReturnTo();
    if (target) this.router.navigateByUrl(target);
  }
}
