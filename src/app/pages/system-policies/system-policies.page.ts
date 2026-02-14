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
import { SchemaRlsPolicy } from '../../interfaces/introspection';
import { CodeViewerComponent } from '../../components/code-viewer/code-viewer.component';

/** Group of policies for one table. */
interface PolicyGroup {
  tableName: string;
  policies: SchemaRlsPolicy[];
}

/**
 * System Policies page — admin-only view of RLS policies.
 *
 * Displays Row Level Security policies grouped by table,
 * with expandable USING and WITH CHECK expressions as visual blocks.
 *
 * Route: /system/policies (requires authGuard)
 * Database: schema_rls_policies view (gated by is_admin())
 *
 * @since v0.29.0
 */
@Component({
  selector: 'app-system-policies',
  standalone: true,
  imports: [CommonModule, FormsModule, CodeViewerComponent],
  templateUrl: './system-policies.page.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class SystemPoliciesPage {
  private introspection = inject(IntrospectionService);

  private policiesData = toSignal(
    this.introspection.getRlsPolicies().pipe(
      catchError(() => {
        this.error.set('Failed to load RLS policies. You may not have admin access.');
        return of([] as SchemaRlsPolicy[]);
      })
    ),
    { initialValue: undefined }
  );

  error = signal<string | undefined>(undefined);
  searchQuery = signal('');
  expandedPolicies = signal<Set<string>>(new Set());

  loading = computed(() => this.policiesData() === undefined);

  policies = computed(() => this.policiesData() ?? []);

  /** Group policies by table name. */
  policyGroups = computed((): PolicyGroup[] => {
    const fns = this.filteredPolicies();
    const groups = new Map<string, SchemaRlsPolicy[]>();

    for (const policy of fns) {
      const existing = groups.get(policy.table_name) ?? [];
      existing.push(policy);
      groups.set(policy.table_name, existing);
    }

    return Array.from(groups.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([tableName, policies]) => ({ tableName, policies }));
  });

  filteredPolicies = computed(() => {
    const query = this.searchQuery().toLowerCase().trim();
    if (!query) return this.policies();

    return this.policies().filter(p =>
      p.table_name.toLowerCase().includes(query) ||
      p.policy_name.toLowerCase().includes(query) ||
      (p.using_expression && p.using_expression.toLowerCase().includes(query)) ||
      (p.with_check_expression && p.with_check_expression.toLowerCase().includes(query))
    );
  });

  togglePolicy(key: string): void {
    const expanded = new Set(this.expandedPolicies());
    if (expanded.has(key)) {
      expanded.delete(key);
    } else {
      expanded.add(key);
    }
    this.expandedPolicies.set(expanded);
  }

  isExpanded(key: string): boolean {
    return this.expandedPolicies().has(key);
  }

  getPolicyKey(policy: SchemaRlsPolicy): string {
    return `${policy.table_name}:${policy.policy_name}`;
  }

  getCommandBadgeClass(cmd: string): string {
    switch (cmd) {
      case 'SELECT': return 'badge-info';
      case 'INSERT': return 'badge-success';
      case 'UPDATE': return 'badge-warning';
      case 'DELETE': return 'badge-error';
      default: return 'badge-ghost';
    }
  }
}
