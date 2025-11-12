import {
  Component,
  Input,
  Output,
  EventEmitter,
  OnInit,
  OnDestroy,
  ChangeDetectionStrategy,
  signal,
  inject
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormBuilder, FormGroup, ReactiveFormsModule, Validators, FormsModule } from '@angular/forms';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { Subject, Observable } from 'rxjs';
import { debounceTime, takeUntil } from 'rxjs/operators';
import {
  NotificationService,
  NotificationTemplate,
  ValidationResult,
  PreviewResult
} from '../../services/notification.service';
import { SchemaService } from '../../services/schema.service';
import { DataService } from '../../services/data.service';
import { SchemaEntityTable } from '../../interfaces/entity';

@Component({
  selector: 'app-template-editor',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './template-editor.component.html',
  styleUrl: './template-editor.component.css'
})
export class TemplateEditorComponent implements OnInit, OnDestroy {
  @Input() template: NotificationTemplate | null = null;
  @Output() save = new EventEmitter<NotificationTemplate>();
  @Output() cancel = new EventEmitter<void>();

  // Services
  private fb = inject(FormBuilder);
  private notificationService = inject(NotificationService);
  private schemaService = inject(SchemaService);
  private dataService = inject(DataService);
  private sanitizer = inject(DomSanitizer);

  // Form
  templateForm!: FormGroup;

  // Tabs state
  activeTab = signal<'subject' | 'html' | 'text' | 'sms'>('subject');

  // Entity selection
  entities$: Observable<SchemaEntityTable[] | undefined>;
  loadingSampleData = signal(false);

  // Validation state (Map<field_name, ValidationResult>)
  validationResults = signal<Map<string, ValidationResult>>(new Map());
  validating = signal<Set<string>>(new Set());

  // Preview state
  previewResults = signal<Map<string, string>>(new Map());
  previewing = signal(false);
  sampleData = signal('{"display_name": "Example Item", "id": 1}');
  showSampleData = signal(false);

  // Save state
  saving = signal(false);
  saveError = signal<string | undefined>(undefined);

  // Placeholder strings (avoid Angular template parsing issues)
  readonly subjectPlaceholder = 'New issue: {{.Entity.display_name}}';
  readonly htmlPlaceholder = '<h2>New Issue</h2><p>{{.Entity.display_name}}</p>';
  readonly textPlaceholder = 'New Issue: {{.Entity.display_name}}';
  readonly smsPlaceholder = 'New issue: {{.Entity.display_name}} (160 char limit)';

  // Template syntax help examples
  readonly syntaxExample1 = '{{.Entity.field}}';
  readonly syntaxExample2 = '{{.Metadata.site_url}}';
  readonly syntaxExample3 = '{{if .Entity.field}}...{{end}}';

  // Debounce subjects for validation
  private validationSubjects = new Map<string, Subject<void>>();
  private destroy$ = new Subject<void>();

  constructor() {
    // Load entities for dropdown
    this.entities$ = this.schemaService.getEntitiesForMenu();
  }

  ngOnInit(): void {
    this.initializeForm();
    this.setupValidation();
    this.setupEntityTypeListener();

    // Load sample data if entity_type is already set (editing existing template)
    const entityType = this.templateForm.get('entity_type')?.value;
    if (entityType) {
      this.fetchRandomEntityData(entityType);
    }
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
    this.validationSubjects.forEach(subject => subject.complete());
  }

  /**
   * Initialize reactive form
   */
  private initializeForm(): void {
    this.templateForm = this.fb.group({
      name: [this.template?.name || '', [Validators.required, Validators.maxLength(100)]],
      description: [this.template?.description || ''],
      entity_type: [this.template?.entity_type || ''],
      subject_template: [this.template?.subject_template || '', Validators.required],
      html_template: [this.template?.html_template || '', Validators.required],
      text_template: [this.template?.text_template || '', Validators.required],
      sms_template: [this.template?.sms_template || '']
    });
  }

  /**
   * Setup debounced validation for template fields
   */
  private setupValidation(): void {
    const fieldsToValidate = ['subject_template', 'html_template', 'text_template', 'sms_template'];

    fieldsToValidate.forEach(field => {
      const subject = new Subject<void>();
      this.validationSubjects.set(field, subject);

      // Debounce 500ms
      subject.pipe(debounceTime(500)).subscribe(() => {
        this.validateField(field);
      });

      // Subscribe to form control changes
      this.templateForm.get(field)?.valueChanges.subscribe(() => {
        subject.next();
      });
    });
  }

  /**
   * Validate a single template field
   */
  private validateField(fieldName: string): void {
    const value = this.templateForm.get(fieldName)?.value;
    if (!value || value.trim() === '') {
      // Clear validation for empty fields
      const results = new Map(this.validationResults());
      results.delete(fieldName);
      this.validationResults.set(results);
      return;
    }

    // Mark as validating
    const validatingSet = new Set(this.validating());
    validatingSet.add(fieldName);
    this.validating.set(validatingSet);

    // Build parts object
    const parts: any = {};
    parts[fieldName] = value;

    // Call validation service
    this.notificationService.validateTemplateParts(parts).subscribe({
      next: (results) => {
        // Store validation results
        const resultsMap = new Map(this.validationResults());
        results.forEach(result => {
          resultsMap.set(result.part_name, result);
        });
        this.validationResults.set(resultsMap);

        // Clear validating state
        const validatingSet = new Set(this.validating());
        validatingSet.delete(fieldName);
        this.validating.set(validatingSet);
      },
      error: () => {
        // Clear validating state on error
        const validatingSet = new Set(this.validating());
        validatingSet.delete(fieldName);
        this.validating.set(validatingSet);
      }
    });
  }

  /**
   * Preview a single template with sample data
   */
  previewSingleTemplate(partName: 'subject' | 'html' | 'text' | 'sms'): void {
    // Validate sample data JSON
    let sampleEntityData;
    try {
      sampleEntityData = JSON.parse(this.sampleData());
    } catch (e) {
      alert('Invalid JSON in sample data. Please fix and try again.');
      return;
    }

    this.previewing.set(true);

    // Build parts object with only the requested part
    const fieldMap = {
      'subject': 'subject_template',
      'html': 'html_template',
      'text': 'text_template',
      'sms': 'sms_template'
    };

    const fieldName = fieldMap[partName];
    const parts: any = {};
    parts[fieldName] = this.templateForm.get(fieldName)?.value;

    this.notificationService.previewTemplateParts(parts, sampleEntityData).subscribe({
      next: (results) => {
        const resultsMap = new Map(this.previewResults());
        results.forEach(result => {
          if (result.rendered_output) {
            resultsMap.set(result.part_name, result.rendered_output);
          } else if (result.error_message) {
            // Clear preview on error (error will be shown via validation)
            resultsMap.delete(result.part_name);
          }
        });
        this.previewResults.set(resultsMap);
        this.previewing.set(false);
      },
      error: () => {
        this.previewing.set(false);
        alert('Preview failed. Please check your template and try again.');
      }
    });
  }

  /**
   * Submit form (create or update)
   */
  onSubmit(): void {
    if (this.templateForm.invalid) {
      this.templateForm.markAllAsTouched();
      return;
    }

    this.saving.set(true);
    this.saveError.set(undefined);

    const formValue = this.templateForm.value;

    if (this.template) {
      // Update existing template
      this.notificationService.updateTemplate(this.template.id, formValue).subscribe({
        next: (response) => {
          if (response.success) {
            this.save.emit(response.body[0]);
          } else {
            this.saveError.set(response.error?.humanMessage);
            this.saving.set(false);
          }
        },
        error: () => {
          this.saveError.set('Failed to update template. Please try again.');
          this.saving.set(false);
        }
      });
    } else {
      // Create new template
      this.notificationService.createTemplate(formValue).subscribe({
        next: (response) => {
          if (response.success) {
            this.save.emit(response.body[0]);
          } else {
            this.saveError.set(response.error?.humanMessage);
            this.saving.set(false);
          }
        },
        error: () => {
          this.saveError.set('Failed to create template. Please try again.');
          this.saving.set(false);
        }
      });
    }
  }

  /**
   * Cancel editing
   */
  onCancel(): void {
    this.cancel.emit();
  }

  /**
   * Get validation result for a field
   */
  getValidationResult(fieldName: string): ValidationResult | undefined {
    return this.validationResults().get(fieldName);
  }

  /**
   * Check if field is currently validating
   */
  isValidating(fieldName: string): boolean {
    return this.validating().has(fieldName);
  }

  /**
   * Get preview result for a part
   */
  getPreviewResult(partName: string): string | undefined {
    return this.previewResults().get(partName);
  }

  /**
   * Get sanitized HTML preview result
   */
  getSafeHtmlPreview(): SafeHtml | null {
    const result = this.previewResults().get('html');
    if (!result) {
      return null;
    }
    const wrappedHtml = this.wrapHtmlPreview(result);
    return this.sanitizer.bypassSecurityTrustHtml(wrappedHtml);
  }

  /**
   * Wrap HTML content in a complete document with styles
   */
  private wrapHtmlPreview(content: string): string {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      font-size: 14px;
      line-height: 1.5;
      color: #333;
      padding: 16px;
      margin: 0;
      background: white;
    }
    h1, h2, h3, h4, h5, h6 {
      margin-top: 0;
      margin-bottom: 0.5em;
      font-weight: 600;
    }
    p {
      margin-top: 0;
      margin-bottom: 1em;
    }
    a {
      color: #3b82f6;
      text-decoration: underline;
    }
    a:hover {
      color: #2563eb;
    }
    table {
      border-collapse: collapse;
      width: 100%;
    }
    th, td {
      padding: 8px;
      text-align: left;
      border: 1px solid #ddd;
    }
    th {
      background-color: #f3f4f6;
      font-weight: 600;
    }
  </style>
</head>
<body>
${content}
</body>
</html>`;
  }

  /**
   * Toggle sample data visibility
   */
  toggleSampleData(): void {
    this.showSampleData.set(!this.showSampleData());
  }

  /**
   * Set active tab
   */
  setActiveTab(tab: 'subject' | 'html' | 'text' | 'sms'): void {
    this.activeTab.set(tab);
  }

  /**
   * Listen for entity type changes and fetch random sample data
   */
  private setupEntityTypeListener(): void {
    this.templateForm.get('entity_type')?.valueChanges
      .pipe(takeUntil(this.destroy$))
      .subscribe((entityKey: string) => {
        if (entityKey) {
          this.fetchRandomEntityData(entityKey);
        }
      });
  }

  /**
   * Fetch the most recent entity from the selected table for sample data
   */
  private fetchRandomEntityData(entityKey: string): void {
    this.loadingSampleData.set(true);

    // First, get the entity schema to build proper field list
    this.schemaService.getEntity(entityKey)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (entity: SchemaEntityTable | undefined) => {
          if (!entity) {
            this.loadingSampleData.set(false);
            return;
          }

          // Get all properties for this entity to build explicit field list
          this.schemaService.getPropertiesForEntity(entity)
            .pipe(takeUntil(this.destroy$))
            .subscribe({
              next: (properties) => {
                // Build explicit field list from schema properties
                const fields = properties.map(prop => prop.column_name);

                // Get the most recent record with explicit field list
                const query = {
                  key: entityKey,
                  fields: fields,  // Use explicit field list instead of '*'
                  orderField: 'id',
                  orderDirection: 'desc',
                  pagination: { page: 0, pageSize: 1 }
                };

                this.dataService.getData(query)
                  .pipe(takeUntil(this.destroy$))
                  .subscribe({
                    next: (response) => {
                      if (response && response.length > 0) {
                        // Pretty-print the JSON for better readability
                        const prettyJson = JSON.stringify(response[0], null, 2);
                        this.sampleData.set(prettyJson);
                      } else {
                        // No data available, provide empty object
                        this.sampleData.set('{\n  "id": 1,\n  "display_name": "Example ' + entityKey + '"\n}');
                      }
                      this.loadingSampleData.set(false);
                    },
                    error: (err: Error) => {
                      console.error('Error fetching sample data:', err);
                      this.loadingSampleData.set(false);
                    }
                  });
              },
              error: (err: Error) => {
                console.error('Error fetching entity properties:', err);
                this.loadingSampleData.set(false);
              }
            });
        },
        error: (err: Error) => {
          console.error('Error fetching entity schema:', err);
          this.loadingSampleData.set(false);
        }
      });
  }
}
