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
import { SystemFunctionsPage } from './system-functions.page';
import { IntrospectionService } from '../../services/introspection.service';
import { SqlBlockTransformerService } from '../../services/sql-block-transformer.service';
import { SchemaFunction } from '../../interfaces/introspection';

function createMockFunction(overrides: Partial<SchemaFunction> = {}): SchemaFunction {
  return {
    function_name: 'test_function',
    schema_name: 'public',
    display_name: 'Test Function',
    description: 'A test function',
    category: 'workflow',
    parameters: null,
    returns_type: 'void',
    returns_description: null,
    is_idempotent: false,
    minimum_role: null,
    entity_effects: [],
    hidden_effects_count: 0,
    is_registered: true,
    has_active_schedule: false,
    can_execute: true,
    source_code: 'CREATE FUNCTION test_function() RETURNS void AS $$ BEGIN NULL; END; $$ LANGUAGE plpgsql;',
    language: 'plpgsql',
    ...overrides
  };
}

describe('SystemFunctionsPage', () => {
  let component: SystemFunctionsPage;
  let fixture: ComponentFixture<SystemFunctionsPage>;
  let mockIntrospection: jasmine.SpyObj<IntrospectionService>;
  let mockTransformer: jasmine.SpyObj<SqlBlockTransformerService>;

  beforeEach(async () => {
    mockIntrospection = jasmine.createSpyObj('IntrospectionService', ['getFunctions']);
    mockIntrospection.getFunctions.and.returnValue(of([
      createMockFunction(),
      createMockFunction({ function_name: 'approve_request', display_name: 'Approve Request', category: 'approval' })
    ]));

    mockTransformer = jasmine.createSpyObj('SqlBlockTransformerService', ['toBlocklyWorkspace']);
    mockTransformer.toBlocklyWorkspace.and.resolveTo({ blocks: { languageVersion: 0, blocks: [] } });

    await TestBed.configureTestingModule({
      imports: [SystemFunctionsPage],
      providers: [
        provideZonelessChangeDetection(),
        provideMarkdown(),
        { provide: IntrospectionService, useValue: mockIntrospection },
        { provide: SqlBlockTransformerService, useValue: mockTransformer }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(SystemFunctionsPage);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should load functions', () => {
    expect(component.functions().length).toBe(2);
    expect(component.loading()).toBeFalse();
  });

  it('should extract unique categories', () => {
    expect(component.categories()).toContain('workflow');
    expect(component.categories()).toContain('approval');
  });

  it('should filter by search query', () => {
    component.searchQuery.set('approve');
    expect(component.filteredFunctions().length).toBe(1);
    expect(component.filteredFunctions()[0].function_name).toBe('approve_request');
  });

  it('should filter by category', () => {
    component.categoryFilter.set('workflow');
    expect(component.filteredFunctions().length).toBe(1);
    expect(component.filteredFunctions()[0].category).toBe('workflow');
  });

  it('should toggle function expansion', () => {
    expect(component.isExpanded('test_function')).toBeFalse();
    component.toggleFunction('test_function');
    expect(component.isExpanded('test_function')).toBeTrue();
    component.toggleFunction('test_function');
    expect(component.isExpanded('test_function')).toBeFalse();
  });

  it('should show all functions when no filter applied', () => {
    expect(component.filteredFunctions().length).toBe(2);
  });
});
