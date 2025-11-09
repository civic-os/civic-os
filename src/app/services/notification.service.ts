import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, of, timer } from 'rxjs';
import { catchError, map, switchMap, takeWhile, tap } from 'rxjs/operators';
import { getPostgrestUrl } from '../config/runtime';

// ============================================================================
// Interfaces
// ============================================================================

export interface NotificationTemplate {
  id: number;
  name: string;
  description: string;
  subject_template: string;
  html_template: string;
  text_template: string;
  sms_template?: string;
  entity_type?: string;
  created_at: string;
  updated_at: string;
}

export interface TemplateParts {
  subject_template?: string;
  html_template?: string;
  text_template?: string;
  sms_template?: string;
}

export interface ValidationResult {
  part_name: string;
  valid: boolean;
  error_message?: string;
}

export interface ValidationResponse {
  validation_id: string;
}

export interface ValidationStatusResponse {
  status: string;
  part_name?: string;
  valid?: boolean;
  error_message?: string;
}

export interface PreviewResult {
  part_name: string;
  rendered_output?: string;
  error_message?: string;
}

export interface PreviewResponse {
  validation_id: string;
}

export interface PreviewStatusResponse {
  status: string;
  part_name?: string;
  rendered_output?: string;
  error_message?: string;
}

export interface ApiResponse {
  success: boolean;
  body?: any;
  error?: {
    message: string;
    humanMessage: string;
  };
}

export interface NotificationPreference {
  user_id: string;
  channel: 'email' | 'sms';
  enabled: boolean;
  email_address?: string;
  phone_number?: string;
  created_at: string;
  updated_at: string;
}

// ============================================================================
// Service
// ============================================================================

@Injectable({
  providedIn: 'root'
})
export class NotificationService {
  private http = inject(HttpClient);
  private baseUrl = getPostgrestUrl();

  // ==========================================================================
  // Template CRUD Operations
  // ==========================================================================

  /**
   * Get all notification templates
   */
  getTemplates(): Observable<NotificationTemplate[]> {
    return this.http.get<NotificationTemplate[]>(
      `${this.baseUrl}notification_templates?select=*&order=name.asc`
    ).pipe(
      catchError((error) => {
        console.error('Error fetching templates:', error);
        return of([]);
      })
    );
  }

  /**
   * Get a single notification template by ID
   */
  getTemplate(id: number): Observable<NotificationTemplate | null> {
    return this.http.get<NotificationTemplate[]>(
      `${this.baseUrl}notification_templates?id=eq.${id}&select=*`
    ).pipe(
      map((templates) => templates.length > 0 ? templates[0] : null),
      catchError((error) => {
        console.error('Error fetching template:', error);
        return of(null);
      })
    );
  }

  /**
   * Create a new notification template
   */
  createTemplate(template: Partial<NotificationTemplate>): Observable<ApiResponse> {
    return this.http.post(
      `${this.baseUrl}notification_templates`,
      template,
      {
        headers: {
          'Prefer': 'return=representation'
        }
      }
    ).pipe(
      map((response: any) => ({
        success: true,
        body: response
      } as ApiResponse)),
      catchError((error) => {
        console.error('Error creating template:', error);
        return of({
          success: false,
          error: {
            message: error.message,
            humanMessage: this.getHumanErrorMessage(error)
          }
        } as ApiResponse);
      })
    );
  }

  /**
   * Update an existing notification template
   */
  updateTemplate(id: number, template: Partial<NotificationTemplate>): Observable<ApiResponse> {
    return this.http.patch(
      `${this.baseUrl}notification_templates?id=eq.${id}`,
      template,
      {
        headers: {
          'Prefer': 'return=representation'
        }
      }
    ).pipe(
      map((response: any) => ({
        success: true,
        body: response
      } as ApiResponse)),
      catchError((error) => {
        console.error('Error updating template:', error);
        return of({
          success: false,
          error: {
            message: error.message,
            humanMessage: this.getHumanErrorMessage(error)
          }
        } as ApiResponse);
      })
    );
  }

  /**
   * Delete a notification template
   */
  deleteTemplate(id: number): Observable<ApiResponse> {
    return this.http.delete(
      `${this.baseUrl}notification_templates?id=eq.${id}`
    ).pipe(
      map(() => ({
        success: true
      } as ApiResponse)),
      catchError((error) => {
        console.error('Error deleting template:', error);
        return of({
          success: false,
          error: {
            message: error.message,
            humanMessage: this.getHumanErrorMessage(error)
          }
        } as ApiResponse);
      })
    );
  }

  // ==========================================================================
  // Template Validation & Preview
  // ==========================================================================

  /**
   * Validate template parts (subject, HTML, text, SMS)
   * Returns validation result for each part provided.
   * This is asynchronous - enqueues job and polls for results.
   */
  validateTemplateParts(parts: TemplateParts): Observable<ValidationResult[]> {
    // Step 1: Enqueue validation job
    return this.http.post<ValidationResponse[]>(
      `${this.baseUrl}rpc/validate_template_parts`,
      {
        p_subject_template: parts.subject_template || null,
        p_html_template: parts.html_template || null,
        p_text_template: parts.text_template || null,
        p_sms_template: parts.sms_template || null
      }
    ).pipe(
      map(response => response[0].validation_id),
      // Step 2: Poll for results every 200ms until completed
      switchMap(validationId => this.pollForValidationResults(validationId)),
      catchError((error) => {
        console.error('Error validating templates:', error);
        // Return validation error for all parts
        const errorResults: ValidationResult[] = [];
        if (parts.subject_template) {
          errorResults.push({
            part_name: 'subject',
            valid: false,
            error_message: 'Validation service unavailable'
          });
        }
        if (parts.html_template) {
          errorResults.push({
            part_name: 'html',
            valid: false,
            error_message: 'Validation service unavailable'
          });
        }
        if (parts.text_template) {
          errorResults.push({
            part_name: 'text',
            valid: false,
            error_message: 'Validation service unavailable'
          });
        }
        if (parts.sms_template) {
          errorResults.push({
            part_name: 'sms',
            valid: false,
            error_message: 'Validation service unavailable'
          });
        }
        return of(errorResults);
      })
    );
  }

  /**
   * Poll for validation results until completed
   * @private
   */
  private pollForValidationResults(validationId: string): Observable<ValidationResult[]> {
    return timer(0, 200).pipe(
      switchMap(() => this.getValidationResults(validationId)),
      // Stop polling when status is 'completed'
      takeWhile(results => results[0]?.status !== 'completed', true),
      // Only emit completed results
      map(results => {
        if (results[0]?.status === 'completed') {
          return results.filter(r => r.part_name != null).map(r => ({
            part_name: r.part_name!,
            valid: r.valid!,
            error_message: r.error_message
          }));
        }
        return null; // Pending - don't emit yet
      }),
      // Filter out null values (pending statuses)
      tap(results => { if (results) console.log('Validation completed:', results); }),
      switchMap(results => results ? of(results) : of())
    );
  }

  /**
   * Get validation results for a validation ID
   * @private
   */
  private getValidationResults(validationId: string): Observable<ValidationStatusResponse[]> {
    return this.http.post<ValidationStatusResponse[]>(
      `${this.baseUrl}rpc/get_validation_results`,
      { p_validation_id: validationId }
    );
  }

  /**
   * Preview template parts with sample entity data
   * Returns rendered output for valid templates, error messages for invalid ones.
   * This is asynchronous - enqueues job and polls for results.
   */
  previewTemplateParts(
    parts: TemplateParts,
    sampleEntityData: any
  ): Observable<PreviewResult[]> {
    // Step 1: Enqueue preview job
    return this.http.post<PreviewResponse[]>(
      `${this.baseUrl}rpc/preview_template_parts`,
      {
        p_subject_template: parts.subject_template || null,
        p_html_template: parts.html_template || null,
        p_text_template: parts.text_template || null,
        p_sms_template: parts.sms_template || null,
        p_sample_entity_data: sampleEntityData
      }
    ).pipe(
      map(response => response[0].validation_id),
      // Step 2: Poll for results every 200ms until completed
      switchMap(validationId => this.pollForPreviewResults(validationId)),
      catchError((error) => {
        console.error('Error previewing templates:', error);
        // Return preview error for all parts
        const errorResults: PreviewResult[] = [];
        if (parts.subject_template) {
          errorResults.push({
            part_name: 'subject',
            error_message: 'Preview service unavailable'
          });
        }
        if (parts.html_template) {
          errorResults.push({
            part_name: 'html',
            error_message: 'Preview service unavailable'
          });
        }
        if (parts.text_template) {
          errorResults.push({
            part_name: 'text',
            error_message: 'Preview service unavailable'
          });
        }
        if (parts.sms_template) {
          errorResults.push({
            part_name: 'sms',
            error_message: 'Preview service unavailable'
          });
        }
        return of(errorResults);
      })
    );
  }

  /**
   * Poll for preview results until completed
   * @private
   */
  private pollForPreviewResults(validationId: string): Observable<PreviewResult[]> {
    return timer(0, 200).pipe(
      switchMap(() => this.getPreviewResults(validationId)),
      // Stop polling when status is 'completed'
      takeWhile(results => results[0]?.status !== 'completed', true),
      // Only emit completed results
      map(results => {
        if (results[0]?.status === 'completed') {
          return results.filter(r => r.part_name != null).map(r => ({
            part_name: r.part_name!,
            rendered_output: r.rendered_output,
            error_message: r.error_message
          }));
        }
        return null; // Pending - don't emit yet
      }),
      // Filter out null values (pending statuses)
      tap(results => { if (results) console.log('Preview completed:', results); }),
      switchMap(results => results ? of(results) : of())
    );
  }

  /**
   * Get preview results for a validation ID
   * @private
   */
  private getPreviewResults(validationId: string): Observable<PreviewStatusResponse[]> {
    return this.http.post<PreviewStatusResponse[]>(
      `${this.baseUrl}rpc/get_preview_results`,
      { p_validation_id: validationId }
    );
  }

  // ==========================================================================
  // Authorization
  // ==========================================================================

  /**
   * Check if current user is admin
   */
  isAdmin(): Observable<boolean> {
    return this.http.post<boolean>(
      `${this.baseUrl}rpc/is_admin`,
      {}
    ).pipe(
      catchError(() => of(false))
    );
  }

  // ==========================================================================
  // Notification Preferences
  // ==========================================================================

  /**
   * Get current user's notification preferences
   */
  getUserPreferences(): Observable<NotificationPreference[]> {
    return this.http.get<NotificationPreference[]>(
      `${this.baseUrl}notification_preferences?select=*&order=channel.asc`
    ).pipe(
      catchError((error) => {
        console.error('Error fetching notification preferences:', error);
        return of([]);
      })
    );
  }

  /**
   * Update notification preference enabled status
   */
  updatePreference(channel: 'email' | 'sms', enabled: boolean): Observable<ApiResponse> {
    return this.http.patch(
      `${this.baseUrl}notification_preferences?channel=eq.${channel}`,
      { enabled },
      {
        headers: {
          'Prefer': 'return=representation'
        }
      }
    ).pipe(
      map((response: any) => ({
        success: true,
        body: response
      } as ApiResponse)),
      catchError((error) => {
        console.error('Error updating notification preference:', error);
        return of({
          success: false,
          error: {
            message: error.message,
            humanMessage: this.getHumanErrorMessage(error)
          }
        } as ApiResponse);
      })
    );
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  /**
   * Extract human-readable error message from HTTP error
   */
  private getHumanErrorMessage(error: any): string {
    if (error.error?.message) {
      return error.error.message;
    }

    if (error.status === 409) {
      return 'A template with this name already exists.';
    }

    if (error.status === 403) {
      return 'You do not have permission to perform this action.';
    }

    if (error.status === 404) {
      return 'Template not found.';
    }

    return 'An unexpected error occurred. Please try again.';
  }
}
