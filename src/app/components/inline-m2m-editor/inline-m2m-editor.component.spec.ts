/**
 * Copyright (C) 2023-2026 Civic OS, L3C
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

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { of } from 'rxjs';
import { InlineM2mEditorComponent } from './inline-m2m-editor.component';
import { DataService } from '../../services/data.service';
import { SchemaService } from '../../services/schema.service';
import { MOCK_M2M_PROPERTY } from '../../testing/mock-schema';

describe('InlineM2mEditorComponent', () => {
  let component: InlineM2mEditorComponent;
  let fixture: ComponentFixture<InlineM2mEditorComponent>;

  const mockProperty = {
    ...MOCK_M2M_PROPERTY,
    show_inline: true,
    fk_search_modal: true
  };

  const currentValues = [
    { id: 1, display_name: 'Urgent', color: '#FF0000' },
    { id: 2, display_name: 'Road Surface', color: '#00FF00' }
  ];

  beforeEach(async () => {
    const mockDataService = jasmine.createSpyObj('DataService', ['getData', 'getDataPaginated', 'callRpc']);
    const mockSchemaService = jasmine.createSpyObj('SchemaService', [
      'getEntity', 'getPropsForList', 'getPropsForFilter',
      'getStatusOptionsSync', 'ensureStatusOptionsLoaded',
      'getCategoryOptionsSync', 'ensureCategoryOptionsLoaded'
    ]);

    mockDataService.getData.and.returnValue(of([]));
    mockDataService.getDataPaginated.and.returnValue(of({ data: [], totalCount: 0 }));
    mockSchemaService.getEntity.and.returnValue(of(undefined));
    mockSchemaService.getPropsForList.and.returnValue(of([]));
    mockSchemaService.getPropsForFilter.and.returnValue(of([]));

    await TestBed.configureTestingModule({
      imports: [InlineM2mEditorComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: DataService, useValue: mockDataService },
        { provide: SchemaService, useValue: mockSchemaService }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(InlineM2mEditorComponent);
    component = fixture.componentInstance;
  });

  it('should create', () => {
    fixture.componentRef.setInput('property', mockProperty);
    fixture.componentRef.setInput('currentValues', currentValues);
    fixture.detectChanges();
    expect(component).toBeTruthy();
  });

  it('should render current chips as current state', () => {
    fixture.componentRef.setInput('property', mockProperty);
    fixture.componentRef.setInput('currentValues', currentValues);
    fixture.detectChanges();

    const chips = component.effectiveChips();
    expect(chips.length).toBe(2);
    expect(chips.every(c => c.state === 'current')).toBeTrue();
  });

  it('should show pending added chips after modal apply', () => {
    fixture.componentRef.setInput('property', mockProperty);
    fixture.componentRef.setInput('currentValues', currentValues);
    fixture.detectChanges();

    // Simulate modal apply with an addition
    component.onModalApply({ toAdd: [3], toRemove: [] });

    const chips = component.effectiveChips();
    expect(chips.length).toBe(3);
    const addedChip = chips.find(c => c.id === 3);
    expect(addedChip?.state).toBe('added');
  });

  it('should show pending removed chips with removed state', () => {
    fixture.componentRef.setInput('property', mockProperty);
    fixture.componentRef.setInput('currentValues', currentValues);
    fixture.detectChanges();

    // Remove item 1
    component.onModalApply({ toAdd: [], toRemove: [1] });

    const chips = component.effectiveChips();
    const removedChip = chips.find(c => c.id === 1);
    expect(removedChip?.state).toBe('removed');
  });

  it('should emit pendingDiff on modal apply', () => {
    fixture.componentRef.setInput('property', mockProperty);
    fixture.componentRef.setInput('currentValues', currentValues);
    fixture.detectChanges();

    spyOn(component.pendingDiff, 'emit');

    component.onModalApply({ toAdd: [3], toRemove: [1] });

    expect(component.pendingDiff.emit).toHaveBeenCalledWith({ toAdd: [3], toRemove: [1] });
  });

  it('should close modal on apply', () => {
    fixture.componentRef.setInput('property', mockProperty);
    fixture.componentRef.setInput('currentValues', currentValues);
    fixture.detectChanges();

    component.showModal.set(true);
    component.onModalApply({ toAdd: [], toRemove: [] });
    expect(component.showModal()).toBeFalse();
  });

  it('should open modal on openModal call', () => {
    fixture.componentRef.setInput('property', mockProperty);
    fixture.componentRef.setInput('currentValues', currentValues);
    fixture.detectChanges();

    component.openModal();
    expect(component.showModal()).toBeTrue();
  });

  it('should report hasPendingChanges correctly', () => {
    fixture.componentRef.setInput('property', mockProperty);
    fixture.componentRef.setInput('currentValues', currentValues);
    fixture.detectChanges();

    expect(component.hasPendingChanges()).toBeFalse();

    component.onModalApply({ toAdd: [3], toRemove: [] });
    expect(component.hasPendingChanges()).toBeTrue();
  });

  it('should render empty state when no current values', () => {
    fixture.componentRef.setInput('property', mockProperty);
    fixture.componentRef.setInput('currentValues', []);
    fixture.detectChanges();

    const chips = component.effectiveChips();
    expect(chips.length).toBe(0);
  });

  it('should compute currentValueIdsForModal including pending changes', () => {
    fixture.componentRef.setInput('property', mockProperty);
    fixture.componentRef.setInput('currentValues', currentValues);
    fixture.detectChanges();

    // Add 3, remove 1
    component.onModalApply({ toAdd: [3], toRemove: [1] });

    const ids = component.currentValueIdsForModal();
    expect(ids).toContain(2);
    expect(ids).toContain(3);
    expect(ids).not.toContain(1);
  });
});
