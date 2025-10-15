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


import { Component, inject, ViewChild, ChangeDetectionStrategy } from '@angular/core';
import { Observable, mergeMap, of, tap, map } from 'rxjs';
import { SchemaEntityProperty, SchemaEntityTable, EntityPropertyType } from '../../interfaces/entity';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { SchemaService } from '../../services/schema.service';
import Keycloak from 'keycloak-js';

import { EditPropertyComponent } from "../../components/edit-property/edit-property.component";
import { CommonModule } from '@angular/common';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { DataService } from '../../services/data.service';
import { DialogComponent } from "../../components/dialog/dialog.component";

@Component({
    selector: 'app-create',
    templateUrl: './create.page.html',
    styleUrl: './create.page.css',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [
    EditPropertyComponent,
    CommonModule,
    ReactiveFormsModule,
    DialogComponent,
    RouterModule
]
})
export class CreatePage {
  private route = inject(ActivatedRoute);
  private schema = inject(SchemaService);
  private data = inject(DataService);
  private router = inject(Router);
  private keycloak = inject(Keycloak);

  // Expose Math and SchemaService to template
  protected readonly Math = Math;
  protected readonly SchemaService = SchemaService;

  public entityKey?: string;
  public entity$: Observable<SchemaEntityTable | undefined> = this.route.params.pipe(mergeMap(p => {
    this.entityKey = p['entityKey'];
    if(p['entityKey']) {
      return this.schema.getEntity(p['entityKey']);
    } else {
      return of(undefined);
    }
  }));
  public properties$: Observable<SchemaEntityProperty[]> = this.entity$.pipe(mergeMap(e => {
    if(e) {
      // Filter OUT M:M properties - they can only be edited on Detail page after entity is created
      let props = this.schema.getPropsForCreate(e)
        .pipe(
          map(props => props.filter(p => p.type !== EntityPropertyType.ManyToMany)),
          tap(props => {
            this.currentProps = props;
            this.createForm = new FormGroup(
              Object.fromEntries(
                props.map(p => {
                  const validators = SchemaService.getFormValidatorsForProperty(p);
                  const defaultValue = SchemaService.getDefaultValueForProperty(p);
                  return [
                    p.column_name,
                    new FormControl(
                      defaultValue,
                      validators
                    )
                  ];
                })
              )
            );

            // Subscribe to form status changes
            this.createForm.statusChanges.subscribe(status => {
              // Reactively hide error banner when form becomes valid
              if (status === 'VALID' && this.showValidationError) {
                console.log('[CREATE FORM] Form is now valid, hiding error banner');
                this.showValidationError = false;
              }
            });
          })
        );
      return props;
    } else {
      return of([]);
    }
  }));

  public createForm?: FormGroup;
  public showValidationError = false;
  private currentProps: SchemaEntityProperty[] = [];
  @ViewChild('successDialog') successDialog!: DialogComponent;
  @ViewChild('errorDialog') errorDialog!: DialogComponent;

  submitForm(event: any) {
    event?.preventDefault?.();

    if (!this.createForm) return;

    // Check if form is valid
    if (this.createForm.invalid) {
      // Mark all fields as touched to trigger validation display
      Object.keys(this.createForm.controls).forEach(key => {
        this.createForm!.controls[key].markAsTouched();
      });

      // Show validation error banner
      this.showValidationError = true;

      // Scroll to first invalid field
      this.scrollToFirstError();

      return; // Stop submission
    }

    // Form is valid, hide error banner and proceed
    this.showValidationError = false;

    // Refresh token before submission (if expires in < 60 seconds)
    this.keycloak.updateToken(60)
      .then(() => {
        // Token is fresh, proceed with submission
        if(this.entityKey && this.createForm) {
          const formData = this.createForm.value;

          // Transform values back to database format before submission
          const transformedData = this.transformValuesForApi(formData);

          // M:M properties are filtered out, so just create the entity directly
          this.data.createData(this.entityKey, transformedData)
            .subscribe({
              next: (result) => {
                if(result.success === true) {
                  console.log('[CREATE SUBMIT] Success!');
                  if (this.successDialog) {
                    this.successDialog.open();
                  } else {
                    console.error('Success dialog not available');
                  }
                } else {
                  console.error('[CREATE SUBMIT] API returned error:', result.error);
                  console.error('[CREATE SUBMIT] Error details:', {
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
                console.error('Unexpected error during create:', err);
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
  navToCreate(key?: string) {
    this.createForm?.reset();
    if(key) {
      this.router.navigate(['create', key]);
    } else {
      this.router.navigate(['create', this.entityKey]);
    }
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
   * Example: User in EST creates record at "5:30 PM" on Jan 15, 2025
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
