/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import { Component, ChangeDetectionStrategy, inject, signal, computed } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { CommonModule } from '@angular/common';
import { switchMap, catchError, of, map } from 'rxjs';
import { IntrospectionService } from '../../services/introspection.service';
import { NavigationService } from '../../services/navigation.service';
import { CodeObject, CodeObjectType, EntitySourceCodeResponse } from '../../interfaces/introspection';
import { CodeViewerComponent } from '../../components/code-viewer/code-viewer.component';

/** Grouping for display sections. */
interface CodeSection {
  title: string;
  icon: string;
  objectType: CodeObjectType;
  items: CodeObject[];
}

/**
 * Entity Code page — shows ALL executable SQL for a single entity.
 *
 * Groups code by type: View Definition → RPC Functions → Triggers →
 * CHECK Constraints → Column Defaults → Domains.
 * RLS Policies section only visible to admins (gated in the RPC).
 *
 * Route: /system/entity-code/:tableName
 *
 * @since v0.29.0
 */
@Component({
  selector: 'app-entity-code',
  standalone: true,
  imports: [CommonModule, CodeViewerComponent],
  templateUrl: './entity-code.page.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class EntityCodePage {
  private route = inject(ActivatedRoute);
  private introspection = inject(IntrospectionService);
  private navigation = inject(NavigationService);

  error = signal<string | undefined>(undefined);

  tableName = toSignal(
    this.route.paramMap.pipe(map(params => params.get('tableName') ?? '')),
    { initialValue: '' }
  );

  private sourceData = toSignal(
    this.route.paramMap.pipe(
      map(params => params.get('tableName') ?? ''),
      switchMap(tableName => {
        if (!tableName) {
          return of(null);
        }
        return this.introspection.getEntitySourceCode(tableName).pipe(
          catchError(() => {
            this.error.set('Failed to load source code for this entity.');
            return of(null);
          })
        );
      })
    ),
    { initialValue: undefined }
  );

  loading = computed(() => this.sourceData() === undefined);

  response = computed(() => this.sourceData() as EntitySourceCodeResponse | null);

  hiddenCount = computed(() => this.response()?.hidden_code_count ?? 0);

  /** Group code objects into display sections. */
  sections = computed((): CodeSection[] => {
    const resp = this.response();
    if (!resp?.code_objects) return [];

    const sectionConfig: { type: CodeObjectType; title: string; icon: string }[] = [
      { type: 'view_definition', title: 'View Definition', icon: 'visibility' },
      { type: 'function', title: 'RPC Functions', icon: 'functions' },
      { type: 'trigger_function', title: 'Trigger Functions', icon: 'bolt' },
      { type: 'trigger_definition', title: 'Trigger Definitions', icon: 'play_arrow' },
      { type: 'rls_policy', title: 'RLS Policies', icon: 'shield' },
      { type: 'check_constraint', title: 'CHECK Constraints', icon: 'check_circle' },
      { type: 'column_default', title: 'Column Defaults', icon: 'data_object' },
      { type: 'domain_definition', title: 'Domain Definitions', icon: 'category' }
    ];

    return sectionConfig
      .map(cfg => ({
        title: cfg.title,
        icon: cfg.icon,
        objectType: cfg.type,
        items: resp.code_objects.filter(co => co.object_type === cfg.type)
      }))
      .filter(section => section.items.length > 0);
  });

  goBack(): void {
    this.navigation.goBack('/system/functions');
  }
}
