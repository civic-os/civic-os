/**
 * Copyright (C) 2023-2025 Civic OS, L3C
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideMarkdown } from 'ngx-markdown';
import { of } from 'rxjs';
import { SystemPoliciesPage } from './system-policies.page';
import { IntrospectionService } from '../../services/introspection.service';
import { SqlBlockTransformerService } from '../../services/sql-block-transformer.service';
import { SchemaRlsPolicy } from '../../interfaces/introspection';

function createMockPolicy(overrides: Partial<SchemaRlsPolicy> = {}): SchemaRlsPolicy {
  return {
    schema_name: 'public',
    table_name: 'issues',
    policy_name: 'users_see_own',
    permissive: 'PERMISSIVE',
    roles: ['authenticated'],
    command: 'SELECT',
    using_expression: '(user_id = current_user_id())',
    with_check_expression: null,
    ...overrides
  };
}

describe('SystemPoliciesPage', () => {
  let component: SystemPoliciesPage;
  let fixture: ComponentFixture<SystemPoliciesPage>;
  let mockIntrospection: jasmine.SpyObj<IntrospectionService>;
  let mockTransformer: jasmine.SpyObj<SqlBlockTransformerService>;

  beforeEach(async () => {
    mockIntrospection = jasmine.createSpyObj('IntrospectionService', ['getRlsPolicies']);
    mockIntrospection.getRlsPolicies.and.returnValue(of([
      createMockPolicy(),
      createMockPolicy({ table_name: 'issues', policy_name: 'users_insert_own', command: 'INSERT', with_check_expression: '(user_id = current_user_id())' }),
      createMockPolicy({ table_name: 'comments', policy_name: 'comments_select', command: 'SELECT' })
    ]));

    mockTransformer = jasmine.createSpyObj('SqlBlockTransformerService', ['toBlocklyWorkspace']);
    mockTransformer.toBlocklyWorkspace.and.resolveTo({ blocks: { languageVersion: 0, blocks: [] } });

    await TestBed.configureTestingModule({
      imports: [SystemPoliciesPage],
      providers: [
        provideZonelessChangeDetection(),
        provideMarkdown(),
        { provide: IntrospectionService, useValue: mockIntrospection },
        { provide: SqlBlockTransformerService, useValue: mockTransformer }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(SystemPoliciesPage);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should load policies', () => {
    expect(component.policies().length).toBe(3);
    expect(component.loading()).toBeFalse();
  });

  it('should group policies by table', () => {
    const groups = component.policyGroups();
    expect(groups.length).toBe(2);
    expect(groups[0].tableName).toBe('comments');
    expect(groups[1].tableName).toBe('issues');
    expect(groups[1].policies.length).toBe(2);
  });

  it('should filter by search query', () => {
    component.searchQuery.set('comments');
    expect(component.filteredPolicies().length).toBe(1);
    expect(component.policyGroups().length).toBe(1);
  });

  it('should toggle policy expansion', () => {
    const key = 'issues:users_see_own';
    expect(component.isExpanded(key)).toBeFalse();
    component.togglePolicy(key);
    expect(component.isExpanded(key)).toBeTrue();
  });

  it('should generate unique policy keys', () => {
    const policy = createMockPolicy();
    expect(component.getPolicyKey(policy)).toBe('issues:users_see_own');
  });

  it('should return correct badge class for commands', () => {
    expect(component.getCommandBadgeClass('SELECT')).toBe('badge-info');
    expect(component.getCommandBadgeClass('INSERT')).toBe('badge-success');
    expect(component.getCommandBadgeClass('UPDATE')).toBe('badge-warning');
    expect(component.getCommandBadgeClass('DELETE')).toBe('badge-error');
    expect(component.getCommandBadgeClass('ALL')).toBe('badge-ghost');
  });
});
