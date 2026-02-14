/**
 * Copyright (C) 2023-2025 Civic OS, L3C
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import { Component, ChangeDetectionStrategy, inject, signal, computed } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { catchError, of } from 'rxjs';
import { IntrospectionService } from '../../services/introspection.service';
import { SchemaFunction } from '../../interfaces/introspection';
import { CodeViewerComponent } from '../../components/code-viewer/code-viewer.component';

/**
 * System Functions & RPCs page.
 *
 * Displays all permission-filtered functions with expandable rows
 * showing Blockly visual blocks or raw SQL source code.
 *
 * Accessible to all authenticated users — visibility is controlled
 * by the schema_functions view's WHERE clause in the database.
 *
 * @since v0.29.0
 */
@Component({
  selector: 'app-system-functions',
  standalone: true,
  imports: [CommonModule, FormsModule, CodeViewerComponent],
  templateUrl: './system-functions.page.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class SystemFunctionsPage {
  private introspection = inject(IntrospectionService);

  /** Raw functions from the API. */
  private functionsData = toSignal(
    this.introspection.getFunctions().pipe(
      catchError(() => {
        this.error.set('Failed to load functions. Please try again later.');
        return of([] as SchemaFunction[]);
      })
    ),
    { initialValue: undefined }
  );

  error = signal<string | undefined>(undefined);
  searchQuery = signal('');
  categoryFilter = signal('');
  expandedFunctions = signal<Set<string>>(new Set());

  loading = computed(() => this.functionsData() === undefined);

  functions = computed(() => this.functionsData() ?? []);

  /** Unique categories from the function list. */
  categories = computed(() => {
    const cats = new Set<string>();
    for (const fn of this.functions()) {
      if (fn.category) cats.add(fn.category);
    }
    return Array.from(cats).sort();
  });

  /** Filtered functions based on search and category. */
  filteredFunctions = computed(() => {
    let fns = this.functions();
    const query = this.searchQuery().toLowerCase().trim();
    const cat = this.categoryFilter();

    if (query) {
      fns = fns.filter(fn =>
        fn.function_name.toLowerCase().includes(query) ||
        (fn.display_name && fn.display_name.toLowerCase().includes(query)) ||
        (fn.description && fn.description.toLowerCase().includes(query))
      );
    }

    if (cat) {
      fns = fns.filter(fn => fn.category === cat);
    }

    return fns;
  });

  toggleFunction(name: string): void {
    const expanded = new Set(this.expandedFunctions());
    if (expanded.has(name)) {
      expanded.delete(name);
    } else {
      expanded.add(name);
    }
    this.expandedFunctions.set(expanded);
  }

  isExpanded(name: string): boolean {
    return this.expandedFunctions().has(name);
  }
}
