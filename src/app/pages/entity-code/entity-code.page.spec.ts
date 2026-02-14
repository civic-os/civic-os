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
import { provideRouter } from '@angular/router';
import { provideMarkdown } from 'ngx-markdown';
import { ActivatedRoute } from '@angular/router';
import { of } from 'rxjs';
import { EntityCodePage } from './entity-code.page';
import { IntrospectionService } from '../../services/introspection.service';
import { SqlBlockTransformerService } from '../../services/sql-block-transformer.service';
import { EntitySourceCodeResponse } from '../../interfaces/introspection';

describe('EntityCodePage', () => {
  let component: EntityCodePage;
  let fixture: ComponentFixture<EntityCodePage>;
  let mockIntrospection: jasmine.SpyObj<IntrospectionService>;
  let mockTransformer: jasmine.SpyObj<SqlBlockTransformerService>;

  const mockResponse: EntitySourceCodeResponse = {
    code_objects: [
      {
        object_type: 'view_definition',
        object_name: 'manager_events',
        display_name: 'Manager Events View',
        description: 'Virtual entity view',
        source_code: 'SELECT * FROM events WHERE manager_id = current_user_id()',
        language: 'sql',
        related_table: 'manager_events',
        category: 'view'
      },
      {
        object_type: 'trigger_function',
        object_name: 'handle_manager_event_insert',
        display_name: 'Handle Insert',
        description: 'INSTEAD OF INSERT trigger function',
        source_code: 'CREATE FUNCTION handle_manager_event_insert() RETURNS trigger AS $$ BEGIN RETURN NEW; END; $$ LANGUAGE plpgsql;',
        language: 'plpgsql',
        related_table: 'manager_events',
        category: 'trigger'
      },
      {
        object_type: 'check_constraint',
        object_name: 'check_title_length',
        display_name: 'Title Length Check',
        description: null,
        source_code: 'CHECK (length(title) > 0)',
        language: 'sql',
        related_table: 'manager_events',
        category: 'constraint'
      }
    ],
    hidden_code_count: 1
  };

  beforeEach(async () => {
    mockIntrospection = jasmine.createSpyObj('IntrospectionService', ['getEntitySourceCode']);
    mockIntrospection.getEntitySourceCode.and.returnValue(of(mockResponse));

    mockTransformer = jasmine.createSpyObj('SqlBlockTransformerService', ['toBlocklyWorkspace']);
    mockTransformer.toBlocklyWorkspace.and.resolveTo({ blocks: { languageVersion: 0, blocks: [] } });

    await TestBed.configureTestingModule({
      imports: [EntityCodePage],
      providers: [
        provideZonelessChangeDetection(),
        provideMarkdown(),
        {
          provide: ActivatedRoute,
          useValue: {
            paramMap: of(new Map([['tableName', 'manager_events']]))
          }
        },
        { provide: IntrospectionService, useValue: mockIntrospection },
        { provide: SqlBlockTransformerService, useValue: mockTransformer }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(EntityCodePage);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should load source code data', () => {
    expect(component.loading()).toBeFalse();
    expect(component.response()).toBeTruthy();
  });

  it('should show hidden count', () => {
    expect(component.hiddenCount()).toBe(1);
  });

  it('should group code objects into sections', () => {
    const sections = component.sections();
    expect(sections.length).toBe(3);
    expect(sections[0].title).toBe('View Definition');
    expect(sections[1].title).toBe('Trigger Functions');
    expect(sections[2].title).toBe('CHECK Constraints');
  });

  it('should not create empty sections', () => {
    const sectionTypes = component.sections().map(s => s.objectType);
    expect(sectionTypes).not.toContain('rls_policy');
    expect(sectionTypes).not.toContain('column_default');
  });

  it('should call getEntitySourceCode with correct table name', () => {
    expect(mockIntrospection.getEntitySourceCode).toHaveBeenCalledWith('manager_events');
  });
});
