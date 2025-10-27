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


import { Component, inject, ViewChild, signal, ChangeDetectionStrategy } from '@angular/core';
import { SchemaService } from '../../services/schema.service';
import { Observable, map, mergeMap, of, tap } from 'rxjs';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { DataService } from '../../services/data.service';
import { SchemaEntityProperty, SchemaEntityTable, EntityPropertyType } from '../../interfaces/entity';
import { DialogComponent } from '../../components/dialog/dialog.component';
import Keycloak from 'keycloak-js';

import { EditPropertyComponent } from '../../components/edit-property/edit-property.component';
import { AnalyticsService } from '../../services/analytics.service';
import { CommonModule } from '@angular/common';

@Component({
    selector: 'app-edit',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [
    EditPropertyComponent,
    CommonModule,
    ReactiveFormsModule,
    DialogComponent,
    RouterModule
],
    templateUrl: './edit.page.html',
    styleUrl: './edit.page.css'
})
export class EditPage {
  private route = inject(ActivatedRoute);
  private schema = inject(SchemaService);
  private data = inject(DataService);
  private router = inject(Router);
  private keycloak = inject(Keycloak);
  private analytics = inject(AnalyticsService);

  // Expose Math and SchemaService to template
  protected readonly Math = Math;
  protected readonly SchemaService = SchemaService;

  public entityKey?: string;
  public entityId?: string;
  public entity$: Observable<SchemaEntityTable | undefined> = this.route.params.pipe(mergeMap(p => {
    this.entityKey = p['entityKey'];
    this.entityId = p['entityId'];
    if(p['entityKey'] && p['entityId']) {
      return this.schema.getEntity(p['entityKey']);
    } else {
      return of(undefined);
    }
  }));
  public properties$: Observable<SchemaEntityProperty[]> = this.entity$.pipe(mergeMap(e => {
    if(e) {
      // Filter OUT M:M properties - they can only be edited on Detail page
      return this.schema.getPropsForEdit(e)
        .pipe(
          map(props => props.filter(p => p.type !== EntityPropertyType.ManyToMany)),
          tap(props => {
            this.currentProps = props;
          })
        );
    } else {
      return of([]);
    }
  }));
  public data$: Observable<any> = this.properties$.pipe(mergeMap(props => {
    if(props && props.length > 0 && this.entityKey) {
      let columns = props
        .map(x => SchemaService.propertyToSelectStringForEdit(x));
      return this.data.getData({key: this.entityKey, entityId: this.entityId, fields: columns})
        .pipe(map(x => x[0]));
    } else {
      return of(undefined);
    }
  }),
  tap(data => {
    if (data && this.currentProps.length > 0) {
      // Create form with actual data values, not defaults
      // M:M properties are filtered out, so just map regular properties
      const formConfig = Object.fromEntries(
        this.currentProps.map(p => [
          p.column_name,
          new FormControl(
            this.transformValueForControl(p, (data as any)[p.column_name]),
            SchemaService.getFormValidatorsForProperty(p)
          )
        ])
      );

      this.editForm = new FormGroup(formConfig);

      // Subscribe to form status changes to reactively hide error banner
      this.editForm.statusChanges.subscribe(status => {
        if (status === 'VALID' && this.showValidationError()) {
          this.showValidationError.set(false);
        }
      });
    }
    this.loading.set(false);
  })
  );

  public editForm?: FormGroup;
  public loading = signal(true);
  public showValidationError = signal(false);
  private currentProps: SchemaEntityProperty[] = [];

  @ViewChild('successDialog') successDialog!: DialogComponent;
  @ViewChild('errorDialog') errorDialog!: DialogComponent;

  submitForm(event: any) {
    event?.preventDefault?.();

    const form = this.editForm;
    if (!form) return;

    // Check if form is valid
    if (form.invalid) {
      // Mark all fields as touched to trigger validation display
      Object.keys(form.controls).forEach(key => {
        form.controls[key].markAsTouched();
      });

      // Show validation error banner
      this.showValidationError.set(true);

      // Scroll to first invalid field
      this.scrollToFirstError();

      return; // Stop submission
    }

    // Form is valid, hide error banner and proceed
    this.showValidationError.set(false);

    // Refresh token before submission (if expires in < 60 seconds)
    this.keycloak.updateToken(60)
      .then(() => {
        // Token is fresh, proceed with submission
        if(this.entityKey && this.entityId && form) {
          const formData = form.value;

          // Transform values back to database format before submission
          const transformedData = this.transformValuesForApi(formData);

          // M:M properties are filtered out, so just edit the entity directly
          this.data.editData(this.entityKey, this.entityId, transformedData)
            .subscribe({
              next: (result) => {
                if(result.success === true) {
                  // Track successful record edit
                  if (this.entityKey) {
                    this.analytics.trackEvent('Entity', 'Edit', this.entityKey);
                  }

                  if (this.successDialog) {
                    this.successDialog.open();
                  } else {
                    console.error('Success dialog not available');
                  }
                } else {
                  console.error('[EDIT SUBMIT] API returned error:', result.error);
                  console.error('[EDIT SUBMIT] Error details:', {
                    httpCode: result.error?.httpCode,
                    message: result.error?.message,
                    details: result.error?.details,
                    hint: result.error?.hint,
                    humanMessage: result.error?.humanMessage
                  });
                  if (this.errorDialog) {
                    this.errorDialog.open(result.error);
                  } else {
                    console.error('Error dialog not available', result.error);
                  }
                }
              },
              error: (err) => {
                console.error('Unexpected error during edit:', err);
                if (this.errorDialog) {
                  this.errorDialog.open({
                    httpCode: 500,
                    message: 'An unexpected error occurred',
                    humanMessage: 'System Error'
                  });
                }
              }
            });
        }
      })
      .catch((error) => {
        // Token refresh failed - session expired
        if (this.errorDialog) {
          this.errorDialog.open({
            httpCode: 401,
            message: "Session expired",
            humanMessage: "Session Expired",
            hint: "Your login session has expired. Please refresh the page to log in again."
          });
        }
      });
  }

  private scrollToFirstError(): void {
    // Wait for Angular to update the DOM with error classes
    setTimeout(() => {
      const firstInvalidControl = document.querySelector('.ng-invalid:not(form)');
      if (firstInvalidControl) {
        firstInvalidControl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        // Try to focus if it's a focusable element
        if (firstInvalidControl instanceof HTMLElement) {
          firstInvalidControl.focus();
        }
      }
    }, 100);
  }

  navToList(key?: string) {
    if(key) {
      this.router.navigate(['view', key]);
    } else {
      this.router.navigate(['view', this.entityKey]);
    }
  }
  navToRecord(key: string, id?: string) {
    this.router.navigate(['view', key, id]);
  }

  /**
   * TIMEZONE-SENSITIVE CODE: Load-time transformation for datetime fields
   *
   * This method handles two distinct timestamp types from PostgreSQL:
   *
   * 1. DateTime (timestamp without time zone):
   *    - Stores "wall clock" time without timezone context
   *    - Example: "2025-01-15T10:30:00" means 10:30 regardless of timezone
   *    - Transformation: Strip timezone suffix (if any), truncate to HH:MM format
   *    - User sees exactly what's stored in the database
   *
   * 2. DateTimeLocal (timestamptz):
   *    - Stores absolute point in time (always in UTC internally)
   *    - Example: "2025-01-15T10:30:00+00:00" = 10:30 UTC = 5:30 AM EST = 2:30 AM PST
   *    - Transformation: Convert UTC → User's local timezone for display
   *    - User sees the time in THEIR timezone, not UTC
   *
   * CRITICAL: The datetime-local input type expects a string like "2025-01-15T10:30"
   * in the USER'S LOCAL TIMEZONE. Do not just strip the timezone - that would show
   * UTC time as if it were local time, causing incorrect displays.
   *
   * WARNING: Modifying this code can cause timezone bugs. Always test with users
   * in different timezones (EST, PST, UTC) before deploying changes.
   */
  private transformValueForControl(prop: SchemaEntityProperty, rawValue: any): any {
    if (rawValue === null || rawValue === undefined) return rawValue;

    // DateTime (timestamp without time zone): Just format for input, no timezone conversion
    if (prop.type === EntityPropertyType.DateTime) {
      if (typeof rawValue === 'string') {
        // PostgreSQL may return: "2025-01-15T10:30:00" (no timezone)
        // datetime-local input needs: "2025-01-15T10:30"
        return rawValue.substring(0, 16);
      }
    }

    // DateTimeLocal (timestamptz): Convert UTC to user's local timezone
    if (prop.type === EntityPropertyType.DateTimeLocal) {
      if (typeof rawValue === 'string') {
        // PostgreSQL returns: "2025-01-15T10:30:00+00:00" or "2025-01-15T10:30:00.000Z" (UTC)
        // Parse as UTC, then convert to local time for display
        const utcDate = new Date(rawValue); // Parses as UTC
        // Format as local time for datetime-local input (YYYY-MM-DDTHH:MM)
        const year = utcDate.getFullYear();
        const month = String(utcDate.getMonth() + 1).padStart(2, '0');
        const day = String(utcDate.getDate()).padStart(2, '0');
        const hours = String(utcDate.getHours()).padStart(2, '0');
        const minutes = String(utcDate.getMinutes()).padStart(2, '0');
        return `${year}-${month}-${day}T${hours}:${minutes}`;
      }
    }

    // Money: Parse formatted string to number for ngx-currency
    if (prop.type === EntityPropertyType.Money) {
      if (typeof rawValue === 'string') {
        // PostgreSQL returns: "$100.00"
        // ngx-currency needs: 100.00 (number)
        const numericValue = parseFloat(rawValue.replace(/[$,]/g, ''));
        if (!isNaN(numericValue)) {
          return numericValue;
        }
      }
    }

    return rawValue;
  }

  /**
   * TIMEZONE-SENSITIVE CODE: Submit-time transformation for datetime fields
   *
   * This method transforms form values back to PostgreSQL-compatible formats:
   *
   * 1. DateTime (timestamp without time zone):
   *    - User enters "wall clock" time (e.g., "10:30")
   *    - Transformation: Add ":00" seconds → "2025-01-15T10:30:00"
   *    - PostgreSQL stores exactly as-is (no timezone conversion)
   *    - Result: Same wall clock time in database as user entered
   *
   * 2. DateTimeLocal (timestamptz):
   *    - User enters time in THEIR local timezone (e.g., "17:30" in EST)
   *    - Transformation: Convert to UTC with "Z" suffix → "2025-01-15T22:30:00.000Z"
   *    - PostgreSQL stores in UTC (internally converts and strips the Z)
   *    - Result: Absolute point in time preserved regardless of user's timezone
   *
   * CRITICAL: DateTimeLocal MUST be converted to UTC before sending to PostgreSQL.
   * The datetime-local input gives us a string like "2025-01-15T17:30" which represents
   * the time in the user's local timezone. We must interpret this as local time and
   * convert to UTC. Do NOT just add seconds - that would send local time as if it were UTC.
   *
   * Example: User in EST enters "5:30 PM" on Jan 15, 2025
   * - Input string: "2025-01-15T17:30"
   * - Interpret as: 5:30 PM EST = 10:30 PM UTC
   * - Send to database: "2025-01-15T22:30:00.000Z"
   * - Database stores: 2025-01-15 22:30:00+00 (10:30 PM UTC)
   *
   * WARNING: Timezone bugs here affect data integrity. Test with multiple timezones.
   */
  private transformValuesForApi(formData: any): any {
    const transformed = { ...formData };

    // Transform values back to database format for each property
    this.currentProps.forEach(prop => {
      const value = transformed[prop.column_name];
      if (value === null || value === undefined) return;

      // File types: Extract UUID from file object or uploaded file reference
      if ([EntityPropertyType.File, EntityPropertyType.FileImage, EntityPropertyType.FilePDF].includes(prop.type)) {
        if (typeof value === 'object' && value.id) {
          // Either embedded file object from initial load, or FileReference from upload
          transformed[prop.column_name] = value.id;
        }
        // If it's already a UUID string, leave it as-is
      }

      // DateTime (timestamp without time zone): Add seconds, no timezone conversion
      if (prop.type === EntityPropertyType.DateTime) {
        if (typeof value === 'string') {
          // Input gives us: "2025-01-15T10:30" (local wall clock time)
          // PostgreSQL expects: "2025-01-15T10:30:00" (with seconds, no timezone)
          if (value.length === 16) {
            transformed[prop.column_name] = value + ':00';
          }
        }
      }

      // DateTimeLocal (timestamptz): Convert local time to UTC ISO format
      if (prop.type === EntityPropertyType.DateTimeLocal) {
        if (typeof value === 'string') {
          // Input gives us: "2025-01-15T17:30" (time in user's local timezone)
          // PostgreSQL expects: ISO string with timezone (e.g., "2025-01-15T22:30:00.000Z")
          if (value.length === 16) {
            // Interpret input string as LOCAL time, then convert to UTC
            const localDate = new Date(value); // Browser interprets as local timezone
            const utcISO = localDate.toISOString(); // Converts to UTC with .000Z format
            transformed[prop.column_name] = utcISO;
          }
        }
      }

      // Money: Keep as number, PostgREST accepts numeric values for money type
    });

    return transformed;
  }
}
