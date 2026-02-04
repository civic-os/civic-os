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

import { Component, inject, input, computed, ChangeDetectionStrategy, signal } from '@angular/core';
import { SchemaEntityProperty, EntityPropertyType, FileReference } from '../../interfaces/entity';

import { Observable, map } from 'rxjs';
import { DataService } from '../../services/data.service';
import { FileUploadService } from '../../services/file-upload.service';
import { SchemaService } from '../../services/schema.service';
import { NgxMaskDirective, provideNgxMask } from 'ngx-mask';
import { NgxCurrencyDirective } from 'ngx-currency';
import { FormGroup, ReactiveFormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { GeoPointMapComponent } from '../geo-point-map/geo-point-map.component';
import { EditTimeSlotComponent } from '../edit-time-slot/edit-time-slot.component';
import { EditRecurringTimeSlotComponent } from '../edit-recurring-time-slot/edit-recurring-time-slot.component';
import { PaymentBadgeComponent } from '../payment-badge/payment-badge.component';
import { getS3Config } from '../../config/runtime';

@Component({
    selector: 'app-edit-property',
    changeDetection: ChangeDetectionStrategy.OnPush,
    templateUrl: './edit-property.component.html',
    styleUrl: './edit-property.component.css',
    imports: [
    CommonModule,
    NgxMaskDirective,
    NgxCurrencyDirective,
    ReactiveFormsModule,
    GeoPointMapComponent,
    EditTimeSlotComponent,
    EditRecurringTimeSlotComponent,
    PaymentBadgeComponent
],
    providers: [
        provideNgxMask(),
    ]
})
export class EditPropertyComponent {
  private data = inject(DataService);
  private fileUpload = inject(FileUploadService);
  private schema = inject(SchemaService);

  prop = input.required<SchemaEntityProperty>({ alias: 'property' });
  form = input.required<FormGroup>({ alias: 'formGroup' });
  entityType = input<string>('');
  entityId = input<string>('');

  public selectOptions$?: Observable<{id: number, text: string}[]>;
  public statusOptions$?: Observable<{id: number, text: string, color: string | null}[]>;

  propType = computed(() => this.prop().type);

  /**
   * Computed signal to check if field is required.
   * Returns true if:
   *   1. Column is NOT NULL at database level (!is_nullable), OR
   *   2. Column has a 'required' validation rule
   *
   * This is important for Virtual Entities (VIEWs) where columns are often
   * nullable at the schema level but have required validation rules.
   */
  isRequired = computed(() => {
    const prop = this.prop();
    if (!prop.is_nullable) return true;
    return prop.validation_rules?.some(r => r.type === 'required') ?? false;
  });

  // File upload state
  uploadingFile = signal(false);
  uploadError = signal<string | null>(null);
  currentFile = signal<FileReference | null>(null);

  public EntityPropertyType = EntityPropertyType;

  ngOnInit() {
    const prop = this.prop();

    // Load FK options
    if(this.propType() == EntityPropertyType.ForeignKeyName) {
      this.selectOptions$ = this.data.getData({
        key: prop.join_table,
        fields: ['id:' + prop.join_column, 'display_name'],
        orderField: 'id',
      })
      .pipe(map(data => {
        return data.map(d => {
          return {
            id: d.id,
            text: d.display_name,
          }
        });
      }));
    }

    // Load User options
    // Fetch both public and private display names (full_name only visible if user has permission)
    if(this.propType() == EntityPropertyType.User) {
      this.selectOptions$ = this.data.getData({
        key: 'civic_os_users',
        fields: ['id', 'display_name', 'full_name', 'phone', 'email'],
        orderField: 'display_name',
        orderDirection: 'asc'
      })
      .pipe(map(data => {
        return data.map(d => {
          // Prefer full_name if available (authorized), otherwise use display_name (public)
          const displayName = (d as any).full_name || d.display_name;
          return {
            id: d.id,
            text: displayName,
          }
        });
      }));
    }

    // Load Status options from cached SchemaService
    // Uses get_statuses_for_entity RPC with caching to avoid redundant calls
    if(this.propType() == EntityPropertyType.Status && prop.status_entity_type) {
      this.statusOptions$ = this.schema.getStatusesForEntity(prop.status_entity_type)
        .pipe(map(statuses => {
          return statuses.map(s => ({
            id: s.id,
            text: s.display_name,
            color: s.color
          }));
        }));
    }

    // Load existing file reference if this is a file field
    // This is a one-time load on init, similar to loading FK options above
    if (this.propType() === EntityPropertyType.File ||
        this.propType() === EntityPropertyType.FileImage ||
        this.propType() === EntityPropertyType.FilePDF) {
      const fileValue = this.form().get(prop.column_name)?.value;

      if (fileValue) {
        // Check if it's an embedded file object (from edit page load) or UUID string
        if (typeof fileValue === 'object' && fileValue.id) {
          // Already have file metadata from initial load
          this.currentFile.set(fileValue);
        } else if (typeof fileValue === 'string') {
          // Have UUID, need to fetch metadata
          this.fileUpload.getFile(fileValue).then(fileRef => {
            if (fileRef) {
              this.currentFile.set(fileRef);
            }
          }).catch(err => {
            console.error('Failed to load file metadata:', err);
          });
        }
      }
    }

    // Note: Value transformation for datetime-local and money inputs
    // is now handled in edit.page.ts when creating FormControls.
    // This ensures transformation happens when data arrives, not when component initializes.
  }

  public onMapValueChange(ewkt: string) {
    // FormControl setValue automatically triggers change detection in OnPush
    // No setTimeout needed with Angular's reactive forms
    const prop = this.prop();
    const form = this.form();
    form.get(prop.column_name)?.setValue(ewkt);
    form.get(prop.column_name)?.markAsDirty();
  }

  /**
   * Get the color of the currently selected status option
   * Used to style the select border
   */
  getSelectedStatusColor(options: {id: number, text: string, color: string | null}[]): string | null {
    const selectedId = this.form().get(this.prop().column_name)?.value;
    if (!selectedId) return null;
    const selected = options.find(o => o.id === +selectedId);
    return selected?.color || null;
  }

  /**
   * Get a semi-transparent background color based on the selected status
   * Converts hex color to rgba with 15% opacity
   */
  getSelectedStatusBackgroundColor(options: {id: number, text: string, color: string | null}[]): string | null {
    const color = this.getSelectedStatusColor(options);
    if (!color) return null;

    // Convert hex to RGB and add transparency
    const hex = color.replace('#', '');
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, 0.15)`;
  }

  /**
   * Get custom validation message for a specific validation type.
   * Returns null if no custom message exists (triggering default message display).
   */
  getValidationMessage(type: string): string | null {
    const rules = this.prop().validation_rules;
    if (!rules || rules.length === 0) return null;
    const rule = rules.find(r => r.type === type);
    return rule?.message || null;
  }

  /**
   * Check if form control is invalid and touched (for conditional styling).
   * Used to skip status color styling when field needs validation highlight.
   */
  isControlInvalidAndTouched(columnName: string): boolean {
    const ctl = this.form().controls[columnName];
    return ctl?.invalid && ctl?.touched;
  }

  // Format phone number for display: 5551234567 → (555) 123-4567
  public getFormattedPhone(controlName: string): string {
    const rawValue = this.form().get(controlName)?.value;
    if (!rawValue) return '';

    // Remove all non-digits
    const digits = rawValue.replace(/\D/g, '');

    // Format based on length
    if (digits.length <= 3) {
      return digits ? `(${digits}` : '';
    } else if (digits.length <= 6) {
      return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
    } else {
      return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6, 10)}`;
    }
  }

  // Handle phone input: format display, store raw digits
  public onPhoneInput(event: Event, controlName: string): void {
    const input = event.target as HTMLInputElement;
    const cursorPos = input.selectionStart || 0;

    // Calculate digits before cursor BEFORE we change input.value
    // This fixes cursor jumping when formatting adds/removes characters
    const digitsBeforeCursor = input.value.slice(0, cursorPos).replace(/\D/g, '').length;

    // Extract only digits
    const digits = input.value.replace(/\D/g, '').slice(0, 10);

    // Store raw digits in form control
    this.form().get(controlName)?.setValue(digits, { emitEvent: false });

    // Format for display
    const formatted = this.getFormattedPhone(controlName);
    input.value = formatted;

    // Restore cursor position (find position after same number of digits)
    let newCursorPos = 0;
    let digitCount = 0;

    for (let i = 0; i < formatted.length && digitCount < digitsBeforeCursor; i++) {
      if (/\d/.test(formatted[i])) digitCount++;
      newCursorPos = i + 1;
    }

    input.setSelectionRange(newCursorPos, newCursorPos);
  }

  /**
   * Mark phone control as touched on blur.
   * Required because phone input doesn't use formControlName binding.
   */
  public onPhoneBlur(controlName: string): void {
    this.form().get(controlName)?.markAsTouched();
  }

  /**
   * Handle file selection and upload
   */
  async onFileSelected(event: Event, controlName: string): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    const prop = this.prop();
    const allowedTypes = this.getFileTypeValidation();
    const maxSize = this.getMaxFileSizeValidation();

    // Validate file
    const validationError = this.fileUpload.validateFile(file, allowedTypes, maxSize);
    if (validationError) {
      this.uploadError.set(validationError);
      input.value = ''; // Clear input
      return;
    }

    // Upload file
    this.uploadError.set(null);
    this.uploadingFile.set(true);

    try {
      const fileRef = await this.fileUpload.uploadFile(
        file,
        this.entityType(),
        this.entityId(),
        true // Wait for thumbnails
      );

      // Store file reference ID in form control
      this.form().get(controlName)?.setValue(fileRef.id);
      this.form().get(controlName)?.markAsDirty();
      this.currentFile.set(fileRef);

      // Clear the file input so it doesn't show the old filename
      input.value = '';

    } catch (error: any) {
      this.uploadError.set(error.message || 'Upload failed');
      input.value = ''; // Clear input on error
    } finally {
      this.uploadingFile.set(false);
    }
  }

  /**
   * Get allowed file types from validation rules
   */
  private getFileTypeValidation(): string | undefined {
    const rule = this.prop().validation_rules?.find(r => r.type === 'fileType');
    return rule?.value;
  }

  /**
   * Get max file size from validation rules (in bytes)
   */
  private getMaxFileSizeValidation(): number | undefined {
    const rule = this.prop().validation_rules?.find(r => r.type === 'maxFileSize');
    return rule?.value ? parseInt(rule.value, 10) : undefined;
  }

  /**
   * Get accept attribute for file input from validation
   */
  getFileAccept(): string {
    const fileType = this.getFileTypeValidation();
    if (!fileType) return '*/*';

    // Convert MIME type to accept attribute
    // e.g., 'image/jpeg' → 'image/jpeg'
    // e.g., 'image/*' → 'image/*'
    return fileType;
  }

  /**
   * Generate S3 URL from key
   */
  getS3Url(s3Key: string | undefined): string | null {
    if (!s3Key) return null;

    const s3Config = getS3Config();
    return `${s3Config.endpoint}/${s3Config.bucket}/${s3Key}`;
  }

  /**
   * Clear file selection
   */
  onClearFile(controlName: string) {
    this.form().get(controlName)?.setValue(null);
    this.form().get(controlName)?.markAsDirty();
    this.currentFile.set(null);
    this.uploadError.set(null);
  }
}
