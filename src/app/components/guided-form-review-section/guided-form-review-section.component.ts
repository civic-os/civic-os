/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 */

import { Component, input, output, computed, signal, effect, ChangeDetectionStrategy, inject, DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { forkJoin, of, Observable } from 'rxjs';
import { switchMap, take } from 'rxjs/operators';
import { GuidedFormService } from '../../services/guided-form.service';
import { SchemaService } from '../../services/schema.service';
import { DataService } from '../../services/data.service';
import { SchemaEntityProperty, EntityPropertyType } from '../../interfaces/entity';
import { GuidedFormContext, EffectiveGuidedFormStep } from '../../interfaces/guided-form';
import { DisplayPropertyComponent } from '../display-property/display-property.component';
import { LoadingIndicatorComponent } from '../loading-indicator/loading-indicator.component';
import { TranslatePipe } from '../../pipes/translate.pipe';

@Component({
  selector: 'app-guided-form-review-section',
  standalone: true,
  imports: [CommonModule, RouterModule, DisplayPropertyComponent, LoadingIndicatorComponent, TranslatePipe],
  templateUrl: './guided-form-review-section.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class GuidedFormReviewSectionComponent {
  private guidedFormService = inject(GuidedFormService);
  private schemaService = inject(SchemaService);
  private destroyRef = inject(DestroyRef);

  // Inputs
  context = input.required<GuidedFormContext>();
  parentRecord = input<any>();
  entityDisplayName = input<string>();
  submitting = input<boolean>(false);
  readOnly = input<boolean>(false);
  submitted = input<boolean>(false);

  // Outputs
  submit = output<void>();
  editStep = output<string>();

  // Local state
  stepRecords = signal<Map<string, any>>(new Map());
  loading = signal(false);

  /** Schema properties per table: tableName → visible detail properties */
  tableProperties = signal<Map<string, SchemaEntityProperty[]>>(new Map());
  private propertiesLoaded = signal(false);

  // Derived from context input
  definition = computed(() => this.context().definition);

  effectiveSteps = computed(() => {
    const ctx = this.context();
    if (!ctx) return [];
    const parent = this.parentRecord();
    return this.guidedFormService.getEffectiveSteps(ctx.steps, parent, ctx.progress);
  });

  dataSteps = computed(() =>
    this.effectiveSteps().filter(s => s.step_key !== '__parent__' && !s.isSkipped)
  );

  /** Get schema-driven properties for the parent table, excluding system columns */
  parentProperties = computed(() => {
    const def = this.definition();
    if (!def) return [];
    return this.getDisplayProps(def.parent_table);
  });

  // Reactive effect: load schema properties when context is available.
  private loadPropertiesEffect = effect(() => {
    const ctx = this.context();
    const dataSteps = this.dataSteps();
    if (!ctx || this.propertiesLoaded()) return;

    // Collect all table names (parent + step tables)
    const tables = new Set<string>();
    tables.add(ctx.definition.parent_table);
    for (const step of dataSteps) {
      if (step.step_table) tables.add(step.step_table);
    }

    // Build FK column set so we can exclude them from review display
    const fkColumns = new Set<string>();
    for (const step of ctx.steps) {
      if (step.parent_fk_column) fkColumns.add(step.parent_fk_column);
    }

    // Mark as loaded immediately to prevent re-entry
    this.propertiesLoaded.set(true);

    // Load properties for all tables in parallel
    const requests: Record<string, Observable<any>> = {};
    for (const table of tables) {
      requests[table] = this.schemaService.getEntity(table).pipe(take(1));
    }

    forkJoin(requests).pipe(
      switchMap(entities => {
        const propRequests: Record<string, Observable<SchemaEntityProperty[]>> = {};
        for (const [table, entity] of Object.entries(entities)) {
          if (entity) {
            propRequests[table] = this.schemaService.getPropsForDetail(entity).pipe(take(1));
          }
        }
        if (Object.keys(propRequests).length === 0) return of({} as Record<string, SchemaEntityProperty[]>);
        return forkJoin(propRequests);
      })
    ).subscribe(propsByTable => {
      const propsMap = new Map<string, SchemaEntityProperty[]>();
      for (const [table, props] of Object.entries(propsByTable)) {
        // Filter out system/internal columns and FK columns
        const filtered = props.filter(p =>
          !this.systemColumns.has(p.column_name) && !fkColumns.has(p.column_name)
        );
        propsMap.set(table, filtered);
      }
      this.tableProperties.set(propsMap);
    });
  });

  // Reactive effect: load step records AFTER properties are loaded.
  private loadRecordsEffect = effect(() => {
    const steps = this.dataSteps();
    const propsMap = this.tableProperties();
    if (steps.length > 0 && propsMap.size > 0 && !this.loading() && this.stepRecords().size === 0) {
      this.loadStepRecords();
    }
  });

  // Columns to hide from review cards (internal/system columns)
  private systemColumns = new Set([
    'id', 'created_at', 'updated_at', 'status_id', 'submitted_at',
    'civic_os_text_search', 'display_name'
  ]);

  /** Get display properties for a table from cache */
  getDisplayProps(tableName: string): SchemaEntityProperty[] {
    return this.tableProperties().get(tableName) || [];
  }

  /** Get properties for a specific step */
  getStepProperties(step: EffectiveGuidedFormStep): SchemaEntityProperty[] {
    return this.getDisplayProps(step.step_table);
  }

  /** Build a PostgREST select string for a step table using its schema properties */
  private buildSelectString(stepTable: string): string {
    const props = this.tableProperties().get(stepTable) || [];
    const selectParts = ['id', ...props.map(p => SchemaService.propertyToSelectString(p))];
    // Deduplicate (id may already be in props)
    return [...new Set(selectParts)].join(',');
  }

  private loadStepRecords(): void {
    const steps = this.dataSteps();
    if (steps.length === 0) return;
    if (this.loading()) return;
    if (this.stepRecords().size > 0) return;

    const ctx = this.context();
    if (!ctx) return;

    // Build a map of step_key → Observable for parallel fetching
    const requests: Record<string, Observable<any[]>> = {};
    for (const step of steps) {
      if (!step.parent_fk_column) continue;
      const select = this.buildSelectString(step.step_table);
      requests[step.step_key] = this.guidedFormService.getStepRecord(
        step.step_table,
        step.parent_fk_column,
        ctx.parent_id,
        select
      );
    }

    // If no steps have FK columns, nothing to load
    if (Object.keys(requests).length === 0) {
      return;
    }

    this.loading.set(true);

    forkJoin(requests).pipe(
      takeUntilDestroyed(this.destroyRef)
    ).subscribe({
      next: results => {
        const records = new Map<string, any>();
        for (const [stepKey, data] of Object.entries(results)) {
          if (data.length > 0) {
            const record = data[0];
            // Transform M:M junction data so DisplayPropertyComponent gets flat items
            const step = steps.find(s => s.step_key === stepKey);
            if (step) {
              const stepProps = this.tableProperties().get(step.step_table) || [];
              for (const p of stepProps) {
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
            }
            records.set(stepKey, record);
          }
        }
        this.stepRecords.set(records);
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
      }
    });
  }

  onEditStep(stepKey: string): void {
    this.editStep.emit(stepKey);
  }

  onSubmit(): void {
    this.submit.emit();
  }

  getStepRecord(stepKey: string): any {
    return this.stepRecords().get(stepKey);
  }

  /** Column span for review grid: wide props (TextLong, GeoPoint, files) span full row */
  getColSpan(prop: SchemaEntityProperty): string {
    const span = SchemaService.getColumnSpan(prop);
    return span >= 2 ? 'col-span-full' : '';
  }

  SchemaService = SchemaService;
}
