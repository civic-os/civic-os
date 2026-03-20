/**
 * Copyright (C) 2023-2025 Civic OS, L3C
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
import { ManyToManyEditorComponent } from './many-to-many-editor.component';
import { DataService } from '../../services/data.service';
import { AuthService } from '../../services/auth.service';
import { of, throwError, Subject } from 'rxjs';
import { MOCK_M2M_PROPERTY, MOCK_RELATED_DATA, createMockManyToManyMeta } from '../../testing/mock-schema';
import { provideRouter } from '@angular/router';

describe('ManyToManyEditorComponent', () => {
  let component: ManyToManyEditorComponent;
  let fixture: ComponentFixture<ManyToManyEditorComponent>;
  let mockDataService: jasmine.SpyObj<DataService>;
  let mockAuthService: jasmine.SpyObj<AuthService>;

  beforeEach(async () => {
    mockDataService = jasmine.createSpyObj('DataService', [
      'getData',
      'addManyToManyRelation',
      'removeManyToManyRelation'
    ]);

    mockAuthService = jasmine.createSpyObj('AuthService', ['hasPermission']);

    // Default mock return values
    mockDataService.getData.and.returnValue(of(MOCK_RELATED_DATA));
    mockAuthService.hasPermission.and.returnValue(true);
    mockDataService.addManyToManyRelation.and.returnValue(of({ success: true }));
    mockDataService.removeManyToManyRelation.and.returnValue(of({ success: true }));

    await TestBed.configureTestingModule({
      imports: [ManyToManyEditorComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: DataService, useValue: mockDataService },
        { provide: AuthService, useValue: mockAuthService },
        provideRouter([])
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(ManyToManyEditorComponent);
    component = fixture.componentInstance;
  });

  describe('Component Initialization', () => {
    it('should create', () => {
      expect(component).toBeTruthy();
    });

    it('should load available options on init', (done) => {
      fixture.componentRef.setInput('entityId', 1);
      fixture.componentRef.setInput('property', MOCK_M2M_PROPERTY);
      fixture.componentRef.setInput('currentValues', []);

      fixture.detectChanges();

      setTimeout(() => {
        expect(mockDataService.getData).toHaveBeenCalledWith({
          key: 'tags',
          fields: ['id', 'display_name', 'color'],
          orderField: 'display_name'
        });
        expect(component.availableOptions()).toEqual(MOCK_RELATED_DATA);
        done();
      }, 10);
    });

    it('should load options without color field if relatedTableHasColor is false', (done) => {
      const propWithoutColor = {
        ...MOCK_M2M_PROPERTY,
        many_to_many_meta: createMockManyToManyMeta({ relatedTableHasColor: false })
      };

      fixture.componentRef.setInput('entityId', 1);
      fixture.componentRef.setInput('property', propWithoutColor);
      fixture.componentRef.setInput('currentValues', []);

      fixture.detectChanges();

      setTimeout(() => {
        expect(mockDataService.getData).toHaveBeenCalledWith({
          key: 'tags',
          fields: ['id', 'display_name'],
          orderField: 'display_name'
        });
        done();
      }, 10);
    });

    it('should check permissions on init', (done) => {
      fixture.componentRef.setInput('entityId', 1);
      fixture.componentRef.setInput('property', MOCK_M2M_PROPERTY);
      fixture.componentRef.setInput('currentValues', []);

      fixture.detectChanges();

      setTimeout(() => {
        expect(mockAuthService.hasPermission).toHaveBeenCalledWith('issue_tags', 'create');
        expect(mockAuthService.hasPermission).toHaveBeenCalledWith('issue_tags', 'delete');
        expect(component.canEdit()).toBe(true);
        done();
      }, 10);
    });

    it('should set canEdit to false if create permission is missing', (done) => {
      mockAuthService.hasPermission.and.callFake((table: string, permission: string) => {
        return permission !== 'create';
      });

      fixture.componentRef.setInput('entityId', 1);
      fixture.componentRef.setInput('property', MOCK_M2M_PROPERTY);
      fixture.componentRef.setInput('currentValues', []);

      fixture.detectChanges();

      setTimeout(() => {
        expect(component.canEdit()).toBe(false);
        done();
      }, 10);
    });

    it('should set canEdit to false if delete permission is missing', (done) => {
      mockAuthService.hasPermission.and.callFake((table: string, permission: string) => {
        return permission !== 'delete';
      });

      fixture.componentRef.setInput('entityId', 1);
      fixture.componentRef.setInput('property', MOCK_M2M_PROPERTY);
      fixture.componentRef.setInput('currentValues', []);

      fixture.detectChanges();

      setTimeout(() => {
        expect(component.canEdit()).toBe(false);
        done();
      }, 10);
    });
  });

  describe('Display Mode', () => {
    beforeEach(() => {
      fixture.componentRef.setInput('entityId', 1);
      fixture.componentRef.setInput('property', MOCK_M2M_PROPERTY);
      fixture.componentRef.setInput('currentValues', [
        { id: 1, display_name: 'Urgent', color: '#FF0000' },
        { id: 2, display_name: 'Road Surface', color: '#00FF00' }
      ]);
      fixture.detectChanges();
    });

    it('should be in display mode by default', () => {
      expect(component.isEditing()).toBe(false);
    });

    it('should display current values as badges', () => {
      const compiled = fixture.nativeElement;
      const badges = compiled.querySelectorAll('.badge');
      expect(badges.length).toBe(2);
    });

    it('should show "None" when no current values', () => {
      fixture.componentRef.setInput('currentValues', []);
      fixture.detectChanges();

      const compiled = fixture.nativeElement;
      expect(compiled.textContent).toContain('None');
    });

    it('should render color dots when items have colors', () => {
      const compiled = fixture.nativeElement;
      const colorDots = compiled.querySelectorAll('.rounded-full');
      expect(colorDots.length).toBe(2);
    });

    it('should show Edit button when canEdit is true', (done) => {
      setTimeout(() => {
        fixture.detectChanges();
        const compiled = fixture.nativeElement;
        const editButton = compiled.querySelector('button');
        expect(editButton?.textContent).toContain('Edit');
        done();
      }, 10);
    });

    it('should hide Edit button when canEdit is false', (done) => {
      mockAuthService.hasPermission.and.returnValue(false);
      // Re-set property to trigger the effect that re-checks permissions
      fixture.componentRef.setInput('property', { ...MOCK_M2M_PROPERTY });
      fixture.detectChanges();

      setTimeout(() => {
        fixture.detectChanges();
        const compiled = fixture.nativeElement;
        const editButton = compiled.querySelector('button');
        expect(editButton).toBeNull();
        done();
      }, 10);
    });
  });

  describe('Edit Mode', () => {
    beforeEach((done) => {
      fixture.componentRef.setInput('entityId', 1);
      fixture.componentRef.setInput('property', MOCK_M2M_PROPERTY);
      fixture.componentRef.setInput('currentValues', [
        { id: 1, display_name: 'Urgent', color: '#FF0000' }
      ]);
      fixture.detectChanges();

      setTimeout(() => {
        component.enterEditMode();
        fixture.detectChanges();
        done();
      }, 10);
    });

    it('should enter edit mode when enterEditMode is called', () => {
      expect(component.isEditing()).toBe(true);
    });

    it('should populate workingSelection with current IDs on enter edit mode', () => {
      expect(component.workingSelection()).toEqual([1]);
    });

    it('should display checkboxes in edit mode', () => {
      const compiled = fixture.nativeElement;
      const checkboxes = compiled.querySelectorAll('input[type="checkbox"]');
      expect(checkboxes.length).toBeGreaterThan(0);
    });

    it('should check checkboxes for currently selected items', () => {
      const compiled = fixture.nativeElement;
      const firstCheckbox = compiled.querySelector('input[type="checkbox"]') as HTMLInputElement;
      expect(firstCheckbox?.checked).toBe(true);
    });

    it('should toggle selection when checkbox is clicked', () => {
      component.toggleSelection(2);
      expect(component.workingSelection()).toEqual([1, 2]);

      component.toggleSelection(1);
      expect(component.workingSelection()).toEqual([2]);
    });

    it('should display search input when more than 10 options', (done) => {
      const manyOptions = Array.from({ length: 15 }, (_, i) => ({
        id: i + 1,
        display_name: `Option ${i + 1}`,
        created_at: '2025-01-01T00:00:00Z',
        updated_at: '2025-01-01T00:00:00Z'
      }));
      mockDataService.getData.and.returnValue(of(manyOptions));

      // Create a fresh component with many options
      fixture = TestBed.createComponent(ManyToManyEditorComponent);
      component = fixture.componentInstance;
      fixture.componentRef.setInput('entityId', 2);
      fixture.componentRef.setInput('property', MOCK_M2M_PROPERTY);
      fixture.componentRef.setInput('currentValues', []);
      fixture.detectChanges();

      setTimeout(() => {
        component.enterEditMode();
        fixture.detectChanges();

        const compiled = fixture.nativeElement;
        const searchInput = compiled.querySelector('input[type="search"]');
        expect(searchInput).toBeTruthy();
        done();
      }, 20);
    });

    it('should hide search input when 10 or fewer options', () => {
      const compiled = fixture.nativeElement;
      const searchInput = compiled.querySelector('input[type="search"]');
      expect(searchInput).toBeNull();
    });

    it('should filter options based on search term', () => {
      component.searchTerm.set('Road');
      fixture.detectChanges();

      const filtered = component.filteredOptions();
      expect(filtered.length).toBe(1);
      expect(filtered[0].display_name).toBe('Road Surface');
    });

    it('should be case-insensitive when filtering', () => {
      component.searchTerm.set('urgent');
      fixture.detectChanges();

      const filtered = component.filteredOptions();
      expect(filtered.length).toBe(1);
      expect(filtered[0].display_name).toBe('Urgent');
    });

    it('should show all options when search term is empty', () => {
      component.searchTerm.set('');
      fixture.detectChanges();

      const filtered = component.filteredOptions();
      expect(filtered.length).toBe(MOCK_RELATED_DATA.length);
    });

    it('should display selection count', () => {
      const compiled = fixture.nativeElement;
      expect(compiled.textContent).toContain('1 selected');
    });

    it('should cancel edit mode and reset state', () => {
      component.toggleSelection(2);
      component.cancel();

      expect(component.isEditing()).toBe(false);
      expect(component.workingSelection()).toEqual([]);
      expect(component.searchTerm()).toBe('');
    });
  });

  describe('Pending Changes', () => {
    beforeEach((done) => {
      fixture.componentRef.setInput('entityId', 1);
      fixture.componentRef.setInput('property', MOCK_M2M_PROPERTY);
      fixture.componentRef.setInput('currentValues', [
        { id: 1, display_name: 'Urgent', color: '#FF0000' },
        { id: 2, display_name: 'Road Surface', color: '#00FF00' }
      ]);
      fixture.detectChanges();

      setTimeout(() => {
        component.enterEditMode();
        fixture.detectChanges();
        done();
      }, 10);
    });

    it('should compute pending changes correctly when adding items', () => {
      component.toggleSelection(3);
      fixture.detectChanges();

      const changes = component.pendingChanges();
      expect(changes.toAdd).toEqual([3]);
      expect(changes.toRemove).toEqual([]);
    });

    it('should compute pending changes correctly when removing items', () => {
      component.toggleSelection(1);
      fixture.detectChanges();

      const changes = component.pendingChanges();
      expect(changes.toAdd).toEqual([]);
      expect(changes.toRemove).toEqual([1]);
    });

    it('should compute pending changes correctly when adding and removing', () => {
      component.toggleSelection(1); // Remove
      component.toggleSelection(3); // Add
      fixture.detectChanges();

      const changes = component.pendingChanges();
      expect(changes.toAdd).toEqual([3]);
      expect(changes.toRemove).toEqual([1]);
    });

    it('should show no pending changes when nothing changed', () => {
      const changes = component.pendingChanges();
      expect(changes.toAdd).toEqual([]);
      expect(changes.toRemove).toEqual([]);
    });

    it('should display pending changes alert when changes exist', () => {
      component.toggleSelection(3);
      fixture.detectChanges();

      const compiled = fixture.nativeElement;
      expect(compiled.textContent).toContain('Pending changes');
      expect(compiled.textContent).toContain('+1');
    });
  });

  describe('Save Operation', () => {
    beforeEach((done) => {
      fixture.componentRef.setInput('entityId', 1);
      fixture.componentRef.setInput('property', MOCK_M2M_PROPERTY);
      fixture.componentRef.setInput('currentValues', [
        { id: 1, display_name: 'Urgent', color: '#FF0000' }
      ]);
      fixture.detectChanges();

      setTimeout(() => {
        component.enterEditMode();
        fixture.detectChanges();
        done();
      }, 10);
    });

    it('should exit edit mode without saving when no changes made', () => {
      component.save();
      expect(component.isEditing()).toBe(false);
      expect(mockDataService.addManyToManyRelation).not.toHaveBeenCalled();
      expect(mockDataService.removeManyToManyRelation).not.toHaveBeenCalled();
    });

    it('should call addManyToManyRelation for added items', (done) => {
      component.toggleSelection(2);
      component.save();

      setTimeout(() => {
        expect(mockDataService.addManyToManyRelation).toHaveBeenCalledWith(
          1,
          MOCK_M2M_PROPERTY.many_to_many_meta!,
          2
        );
        done();
      }, 10);
    });

    it('should call removeManyToManyRelation for removed items', (done) => {
      component.toggleSelection(1);
      component.save();

      setTimeout(() => {
        expect(mockDataService.removeManyToManyRelation).toHaveBeenCalledWith(
          1,
          MOCK_M2M_PROPERTY.many_to_many_meta!,
          1
        );
        done();
      }, 10);
    });

    it('should execute multiple operations in parallel', (done) => {
      component.toggleSelection(1); // Remove
      component.toggleSelection(2); // Add
      component.toggleSelection(3); // Add
      component.save();

      setTimeout(() => {
        expect(mockDataService.removeManyToManyRelation).toHaveBeenCalledTimes(1);
        expect(mockDataService.addManyToManyRelation).toHaveBeenCalledTimes(2);
        done();
      }, 10);
    });

    it('should emit relationChanged on successful save', (done) => {
      spyOn(component.relationChanged, 'emit');
      component.toggleSelection(2);
      component.save();

      setTimeout(() => {
        expect(component.relationChanged.emit).toHaveBeenCalled();
        done();
      }, 10);
    });

    it('should exit edit mode on successful save', (done) => {
      component.toggleSelection(2);
      component.save();

      setTimeout(() => {
        expect(component.isEditing()).toBe(false);
        done();
      }, 10);
    });

    it('should set loading state during save', () => {
      // Use Subject to delay completion so we can check loading state
      const saveSubject = new Subject<{ success: boolean }>();
      mockDataService.addManyToManyRelation.and.returnValue(saveSubject.asObservable());

      component.toggleSelection(2);
      component.save();

      // Loading should be true while operation is in progress
      expect(component.loading()).toBe(true);

      // Complete the operation
      saveSubject.next({ success: true });
      saveSubject.complete();
    });

    it('should clear loading state after save completes', (done) => {
      component.toggleSelection(2);
      component.save();

      setTimeout(() => {
        expect(component.loading()).toBe(false);
        done();
      }, 10);
    });

    it('should handle error when all operations fail', (done) => {
      mockDataService.addManyToManyRelation.and.returnValue(of({ success: false }));
      component.toggleSelection(2);
      component.save();

      setTimeout(() => {
        expect(component.error()).toBe('All changes failed. Please try again.');
        expect(component.isEditing()).toBe(true); // Stays in edit mode
        done();
      }, 10);
    });

    it('should handle partial failures', (done) => {
      spyOn(component.relationChanged, 'emit');
      let callCount = 0;
      mockDataService.addManyToManyRelation.and.callFake(() => {
        callCount++;
        return of({ success: callCount === 1 });
      });

      component.toggleSelection(2);
      component.toggleSelection(3);
      component.save();

      setTimeout(() => {
        expect(component.error()).toContain('1 changes succeeded, 1 failed');
        expect(component.relationChanged.emit).toHaveBeenCalled();
        done();
      }, 10);
    });

    it('should handle network errors', (done) => {
      mockDataService.addManyToManyRelation.and.returnValue(
        throwError(() => new Error('Network error'))
      );

      component.toggleSelection(2);
      component.save();

      setTimeout(() => {
        expect(component.error()).toBe('Failed to save changes');
        expect(component.loading()).toBe(false);
        done();
      }, 10);
    });
  });

  describe('RouterLink Integration', () => {
    it('should generate correct router link for related entities', () => {
      fixture.componentRef.setInput('entityId', 1);
      fixture.componentRef.setInput('property', MOCK_M2M_PROPERTY);
      fixture.componentRef.setInput('currentValues', [
        { id: 5, display_name: 'Drainage', color: '#FF00FF' }
      ]);
      fixture.detectChanges();

      const compiled = fixture.nativeElement;
      const link = compiled.querySelector('a');
      // Check that link exists and has the expected href
      expect(link).toBeTruthy();
      expect(link?.getAttribute('href')).toBe('/view/tags/5');
    });
  });
});
