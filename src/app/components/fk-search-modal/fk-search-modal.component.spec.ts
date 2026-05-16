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
import { By } from '@angular/platform-browser';
import { of } from 'rxjs';
import { FkSearchModalComponent } from './fk-search-modal.component';
import { DataService } from '../../services/data.service';
import { SchemaService } from '../../services/schema.service';
import { createMockEntity, createMockProperty } from '../../testing';
import { EntityPropertyType } from '../../interfaces/entity';

describe('FkSearchModalComponent', () => {
  let component: FkSearchModalComponent;
  let fixture: ComponentFixture<FkSearchModalComponent>;
  let mockDataService: jasmine.SpyObj<DataService>;
  let mockSchemaService: jasmine.SpyObj<SchemaService>;

  const mockListProps = [
    createMockProperty({
      column_name: 'display_name',
      display_name: 'Name',
      type: EntityPropertyType.TextShort
    }),
    createMockProperty({
      column_name: 'email',
      display_name: 'Email',
      type: EntityPropertyType.Email
    })
  ];

  const mockFilterProps = [
    createMockProperty({
      column_name: 'status_id',
      display_name: 'Status',
      type: EntityPropertyType.ForeignKeyName,
      filterable: true,
      join_table: 'statuses',
      join_column: 'id'
    })
  ];

  const mockEntity = createMockEntity({
    table_name: 'borrowers',
    display_name: 'Borrowers',
    search_fields: ['display_name']
  });

  const mockRows = [
    { id: 1, display_name: 'Alice Smith', email: 'alice@example.com' },
    { id: 2, display_name: 'Bob Jones', email: 'bob@example.com' },
    { id: 3, display_name: 'Carol White', email: 'carol@example.com' }
  ];

  // Helper to wait for async effects and data loading
  async function waitForData() {
    await new Promise(resolve => setTimeout(resolve, 100));
    fixture.detectChanges();
    await fixture.whenStable();
  }

  beforeEach(async () => {
    mockDataService = jasmine.createSpyObj('DataService', ['getData', 'getDataPaginated', 'callRpc']);
    mockSchemaService = jasmine.createSpyObj('SchemaService', [
      'getEntity', 'getPropsForList', 'getPropsForFilter',
      'getStatusOptionsSync', 'ensureStatusOptionsLoaded',
      'getCategoryOptionsSync', 'ensureCategoryOptionsLoaded'
    ]);

    mockDataService.getData.and.returnValue(of([]));
    mockDataService.getDataPaginated.and.returnValue(of({ data: mockRows as any, totalCount: 3 }));
    mockSchemaService.getEntity.and.returnValue(of(mockEntity));
    mockSchemaService.getPropsForList.and.returnValue(of(mockListProps));
    mockSchemaService.getPropsForFilter.and.returnValue(of([]));

    await TestBed.configureTestingModule({
      imports: [FkSearchModalComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: DataService, useValue: mockDataService },
        { provide: SchemaService, useValue: mockSchemaService }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(FkSearchModalComponent);
    component = fixture.componentInstance;
  });

  it('should create', () => {
    fixture.componentRef.setInput('isOpen', false);
    fixture.componentRef.setInput('joinTable', 'borrowers');
    fixture.detectChanges();
    expect(component).toBeTruthy();
  });

  describe('Table Mode', () => {
    beforeEach(() => {
      fixture.componentRef.setInput('joinTable', 'borrowers');
      fixture.componentRef.setInput('isOpen', false);
      fixture.componentRef.setInput('rpcOptions', null);
      fixture.detectChanges();
    });

    it('should fetch properties via SchemaService when opened', async () => {
      fixture.componentRef.setInput('isOpen', true);
      fixture.detectChanges();
      await waitForData();

      expect(mockSchemaService.getEntity).toHaveBeenCalledWith('borrowers');
      expect(mockSchemaService.getPropsForList).toHaveBeenCalled();
    });

    it('should load data via getDataPaginated', async () => {
      fixture.componentRef.setInput('isOpen', true);
      fixture.detectChanges();
      await waitForData();

      expect(mockDataService.getDataPaginated).toHaveBeenCalled();
      expect(component.rows().length).toBe(3);
      expect(component.totalCount()).toBe(3);
    });

    it('should highlight row on click', async () => {
      fixture.componentRef.setInput('isOpen', true);
      fixture.detectChanges();
      await waitForData();

      // Click second row via component method
      component.onRowClick(mockRows[1] as any);
      fixture.detectChanges();

      expect(component.pendingSelection()).toEqual({ id: 2, displayName: 'Bob Jones' });
      expect(component.isSelected(2)).toBe(true);
      expect(component.isSelected(1)).toBe(false);
    });

    it('should emit confirmed with selection on Confirm', async () => {
      fixture.componentRef.setInput('isOpen', true);
      fixture.detectChanges();
      await waitForData();

      spyOn(component.confirmed, 'emit');

      // Select row via method
      component.onRowClick(mockRows[0] as any);
      component.onConfirm();

      expect(component.confirmed.emit).toHaveBeenCalledWith({ id: 1, displayName: 'Alice Smith' });
    });

    it('should emit closed on Cancel', async () => {
      fixture.componentRef.setInput('isOpen', true);
      fixture.detectChanges();
      await waitForData();

      spyOn(component.closed, 'emit');
      component.onCancel();

      expect(component.closed.emit).toHaveBeenCalled();
    });

    it('should disable Confirm when selection matches current value', async () => {
      fixture.componentRef.setInput('currentValue', 1);
      fixture.componentRef.setInput('isOpen', true);
      fixture.detectChanges();
      await waitForData();

      // Pre-highlighted current value
      expect(component.pendingSelection()?.id).toBe(1);
      expect(component.confirmEnabled()).toBe(false);

      // Click a different row
      component.onRowClick(mockRows[1] as any);
      expect(component.confirmEnabled()).toBe(true);
    });

    it('should emit confirmed with null on Clear', async () => {
      fixture.componentRef.setInput('isNullable', true);
      fixture.componentRef.setInput('isOpen', true);
      fixture.detectChanges();
      await waitForData();

      spyOn(component.confirmed, 'emit');
      component.onClear();

      expect(component.confirmed.emit).toHaveBeenCalledWith(null);
    });

    it('should show Clear button only when nullable', async () => {
      fixture.componentRef.setInput('isNullable', true);
      fixture.componentRef.setInput('isOpen', true);
      fixture.detectChanges();
      await waitForData();

      const clearBtn = fixture.debugElement.queryAll(By.css('.cos-modal-action button'))
        .find(b => b.nativeElement.textContent.includes('Clear'));
      expect(clearBtn).toBeTruthy();
    });

    it('should not show Clear button when not nullable', async () => {
      fixture.componentRef.setInput('isNullable', false);
      fixture.componentRef.setInput('isOpen', true);
      fixture.detectChanges();
      await waitForData();

      const clearBtn = fixture.debugElement.queryAll(By.css('.cos-modal-action button'))
        .find(b => b.nativeElement.textContent.includes('Clear'));
      expect(clearBtn).toBeFalsy();
    });

    it('should display search input when entity has search_fields', async () => {
      fixture.componentRef.setInput('isOpen', true);
      fixture.detectChanges();
      await waitForData();

      const searchInput = fixture.debugElement.query(By.css('input[placeholder="Search..."]'));
      expect(searchInput).toBeTruthy();
    });
  });

  describe('RPC ID Filtering', () => {
    const rpcOptions = [
      { id: 1, text: 'Approved Alice' },
      { id: 2, text: 'Approved Bob' },
      { id: 3, text: 'Approved Carol' }
    ];

    beforeEach(() => {
      fixture.componentRef.setInput('joinTable', 'borrowers');
      fixture.componentRef.setInput('rpcOptions', rpcOptions);
      fixture.componentRef.setInput('isOpen', false);
      fixture.detectChanges();
    });

    it('should inject RPC IDs as filter into table query', async () => {
      fixture.componentRef.setInput('isOpen', true);
      fixture.detectChanges();
      await waitForData();

      expect(mockDataService.getDataPaginated).toHaveBeenCalled();
      const callArgs = mockDataService.getDataPaginated.calls.mostRecent().args[0];
      // Should include an `in` filter with the RPC option IDs
      expect(callArgs.filters).toBeTruthy();
      const idFilter = callArgs.filters!.find((f: any) => f.operator === 'in');
      expect(idFilter).toBeTruthy();
      expect(idFilter!.value).toBe('(1,2,3)');
    });

    it('should still use full entity columns with RPC options', async () => {
      fixture.componentRef.setInput('isOpen', true);
      fixture.detectChanges();
      await waitForData();

      // Should load entity metadata and show list properties (not just Name)
      expect(mockSchemaService.getEntity).toHaveBeenCalledWith('borrowers');
      expect(mockSchemaService.getPropsForList).toHaveBeenCalled();
      expect(component.listProperties().length).toBe(2); // display_name + email
    });

    it('should show full column headers with RPC options', async () => {
      fixture.componentRef.setInput('isOpen', true);
      fixture.detectChanges();
      await waitForData();

      const headers = fixture.debugElement.queryAll(By.css('thead th'));
      // radio + display_name + email (full entity columns, not just "Name")
      expect(headers.length).toBe(3);
    });
  });

  describe('Confirm Button State', () => {
    it('should be disabled when no change from current value', () => {
      fixture.componentRef.setInput('joinTable', 'borrowers');
      fixture.componentRef.setInput('currentValue', 1);
      fixture.componentRef.setInput('rpcOptions', null);
      fixture.componentRef.setInput('isOpen', false);
      fixture.detectChanges();

      component.pendingSelection.set({ id: 1, displayName: 'Alice' });
      expect(component.confirmEnabled()).toBe(false);
    });

    it('should be enabled when selection differs from current', () => {
      fixture.componentRef.setInput('joinTable', 'borrowers');
      fixture.componentRef.setInput('currentValue', 1);
      fixture.componentRef.setInput('rpcOptions', null);
      fixture.componentRef.setInput('isOpen', false);
      fixture.detectChanges();

      component.pendingSelection.set({ id: 2, displayName: 'Bob' });
      expect(component.confirmEnabled()).toBe(true);
    });

    it('should be enabled when current is null and selection is made', () => {
      fixture.componentRef.setInput('joinTable', 'borrowers');
      fixture.componentRef.setInput('currentValue', null);
      fixture.componentRef.setInput('rpcOptions', null);
      fixture.componentRef.setInput('isOpen', false);
      fixture.detectChanges();

      component.pendingSelection.set({ id: 1, displayName: 'Alice' });
      expect(component.confirmEnabled()).toBe(true);
    });
  });

  describe('Sort', () => {
    it('should toggle sort direction on same column', () => {
      fixture.componentRef.setInput('joinTable', 'borrowers');
      fixture.componentRef.setInput('rpcOptions', null);
      fixture.componentRef.setInput('isOpen', false);
      fixture.detectChanges();

      component.orderField.set('display_name');
      component.orderDirection.set('asc');

      component.onSort('display_name');
      expect(component.orderDirection()).toBe('desc');

      component.onSort('display_name');
      expect(component.orderDirection()).toBe('asc');
    });

    it('should reset to asc when sorting by new column', () => {
      fixture.componentRef.setInput('joinTable', 'borrowers');
      fixture.componentRef.setInput('rpcOptions', null);
      fixture.componentRef.setInput('isOpen', false);
      fixture.detectChanges();

      component.orderField.set('display_name');
      component.orderDirection.set('desc');

      component.onSort('email');
      expect(component.orderField()).toBe('email');
      expect(component.orderDirection()).toBe('asc');
    });

    it('should return correct sort icon', () => {
      fixture.componentRef.setInput('joinTable', 'borrowers');
      fixture.componentRef.setInput('rpcOptions', null);
      fixture.componentRef.setInput('isOpen', false);
      fixture.detectChanges();

      component.orderField.set('display_name');
      component.orderDirection.set('asc');

      expect(component.getSortIcon('display_name')).toBe('arrow_upward');
      expect(component.getSortIcon('email')).toBe('');

      component.orderDirection.set('desc');
      expect(component.getSortIcon('display_name')).toBe('arrow_downward');
    });
  });

  describe('Multi-Select Mode (v0.46.0)', () => {
    const currentItems = [
      { id: 1, display_name: 'Urgent', color: '#FF0000' },
      { id: 2, display_name: 'Road Surface', color: '#00FF00' }
    ];

    function setupMultiSelect() {
      fixture.componentRef.setInput('joinTable', 'tags');
      fixture.componentRef.setInput('multiSelect', true);
      fixture.componentRef.setInput('currentValueIds', [1, 2]);
      fixture.componentRef.setInput('currentValueItems', currentItems);
      fixture.componentRef.setInput('rpcOptions', null);
      fixture.componentRef.setInput('isOpen', false);
      fixture.detectChanges();
    }

    it('should initialize workingSelection from currentValueIds on open', async () => {
      setupMultiSelect();
      fixture.componentRef.setInput('isOpen', true);
      fixture.detectChanges();
      await waitForData();

      expect(component.workingSelection().has(1)).toBeTrue();
      expect(component.workingSelection().has(2)).toBeTrue();
      expect(component.workingSelection().size).toBe(2);
    });

    it('should populate chipCache from currentValueItems on open', async () => {
      // Use IDs that don't overlap with mock page rows (1,2,3) so they
      // aren't overwritten by loadTableData's cache update
      const nonOverlappingItems = [
        { id: 100, display_name: 'Tag Alpha', color: '#FF0000' },
        { id: 200, display_name: 'Tag Beta', color: '#00FF00' }
      ];
      fixture.componentRef.setInput('joinTable', 'tags');
      fixture.componentRef.setInput('multiSelect', true);
      fixture.componentRef.setInput('currentValueIds', [100, 200]);
      fixture.componentRef.setInput('currentValueItems', nonOverlappingItems);
      fixture.componentRef.setInput('rpcOptions', null);
      fixture.componentRef.setInput('isOpen', true);
      fixture.detectChanges();
      await waitForData();

      const cache = component.chipCache();
      expect(cache.get(100)?.display_name).toBe('Tag Alpha');
      expect(cache.get(100)?.color).toBe('#FF0000');
      expect(cache.get(200)?.display_name).toBe('Tag Beta');
    });

    it('should render checkboxes instead of radios in multi-select mode', async () => {
      setupMultiSelect();
      fixture.componentRef.setInput('isOpen', true);
      fixture.detectChanges();
      await waitForData();

      const checkboxes = fixture.debugElement.queryAll(By.css('input[type="checkbox"]'));
      const radios = fixture.debugElement.queryAll(By.css('input[type="radio"]'));
      expect(checkboxes.length).toBeGreaterThan(0);
      expect(radios.length).toBe(0);
    });

    it('should toggle selection on checkbox click', async () => {
      setupMultiSelect();
      fixture.componentRef.setInput('isOpen', true);
      fixture.detectChanges();
      await waitForData();

      // Add item 3 to selection
      component.toggleSelection(3, 'Carol White');
      expect(component.workingSelection().has(3)).toBeTrue();
      expect(component.workingSelection().size).toBe(3);

      // Remove item 1 from selection
      component.toggleSelection(1, 'Urgent', '#FF0000');
      expect(component.workingSelection().has(1)).toBeFalse();
      expect(component.workingSelection().size).toBe(2);
    });

    it('should show selected chips in right panel', async () => {
      // Use non-overlapping IDs so page data doesn't overwrite chip cache
      const items = [
        { id: 100, display_name: 'Urgent', color: '#FF0000' },
        { id: 200, display_name: 'Road Surface', color: '#00FF00' }
      ];
      fixture.componentRef.setInput('joinTable', 'tags');
      fixture.componentRef.setInput('multiSelect', true);
      fixture.componentRef.setInput('currentValueIds', [100, 200]);
      fixture.componentRef.setInput('currentValueItems', items);
      fixture.componentRef.setInput('rpcOptions', null);
      fixture.componentRef.setInput('isOpen', true);
      fixture.detectChanges();
      await waitForData();

      const chips = component.selectedChips();
      expect(chips.length).toBe(2);
      // Sorted alphabetically
      expect(chips[0].display_name).toBe('Road Surface');
      expect(chips[1].display_name).toBe('Urgent');
    });

    it('should remove chip from right panel via removeChip', async () => {
      setupMultiSelect();
      fixture.componentRef.setInput('isOpen', true);
      fixture.detectChanges();
      await waitForData();

      component.removeChip(1);
      expect(component.workingSelection().has(1)).toBeFalse();
      expect(component.selectedChips().length).toBe(1);
    });

    it('should persist selection across pagination', async () => {
      setupMultiSelect();
      fixture.componentRef.setInput('isOpen', true);
      fixture.detectChanges();
      await waitForData();

      // Add item 3 from current page
      component.toggleSelection(3, 'Carol White');

      // Simulate page change (data reload with different rows)
      mockDataService.getDataPaginated.and.returnValue(of({
        data: [
          { id: 4, display_name: 'Dave Green', email: 'd@test.com' },
          { id: 5, display_name: 'Eve Black', email: 'e@test.com' }
        ] as any,
        totalCount: 5
      }));
      component.onPageChange(2);
      await waitForData();

      // Selection should persist
      expect(component.workingSelection().has(1)).toBeTrue();
      expect(component.workingSelection().has(2)).toBeTrue();
      expect(component.workingSelection().has(3)).toBeTrue();
      expect(component.selectedChips().length).toBe(3);
    });

    it('should compute pendingDiff correctly', async () => {
      setupMultiSelect();
      fixture.componentRef.setInput('isOpen', true);
      fixture.detectChanges();
      await waitForData();

      // Add item 3, remove item 1
      component.toggleSelection(3, 'Carol White');
      component.toggleSelection(1, 'Urgent');

      const diff = component.pendingDiff();
      expect(diff.toAdd).toEqual([3]);
      expect(diff.toRemove).toEqual([1]);
    });

    it('should disable Apply when diff is empty', async () => {
      setupMultiSelect();
      fixture.componentRef.setInput('isOpen', true);
      fixture.detectChanges();
      await waitForData();

      // No changes made
      expect(component.applyEnabled()).toBeFalse();
    });

    it('should enable Apply when diff is non-empty', async () => {
      setupMultiSelect();
      fixture.componentRef.setInput('isOpen', true);
      fixture.detectChanges();
      await waitForData();

      component.toggleSelection(3, 'Carol White');
      expect(component.applyEnabled()).toBeTrue();
    });

    it('should emit applied with diff on Apply', async () => {
      setupMultiSelect();
      fixture.componentRef.setInput('isOpen', true);
      fixture.detectChanges();
      await waitForData();

      spyOn(component.applied, 'emit');

      component.toggleSelection(3, 'Carol White');
      component.toggleSelection(1, 'Urgent');
      component.onApply();

      expect(component.applied.emit).toHaveBeenCalledWith(
        jasmine.objectContaining({ toAdd: [3], toRemove: [1] })
      );
    });

    it('should populate chipCache from page data', async () => {
      setupMultiSelect();
      fixture.componentRef.setInput('isOpen', true);
      fixture.detectChanges();
      await waitForData();

      // Row data should be cached
      const cache = component.chipCache();
      expect(cache.get(3)?.display_name).toBe('Carol White');
    });

    it('should show Apply button instead of Confirm in multi-select mode', async () => {
      setupMultiSelect();
      fixture.componentRef.setInput('isOpen', true);
      fixture.detectChanges();
      await waitForData();

      const buttons = fixture.debugElement.queryAll(By.css('.cos-modal-action button'));
      const buttonTexts = buttons.map(b => b.nativeElement.textContent.trim());
      expect(buttonTexts.some(t => t.includes('Apply'))).toBeTrue();
      expect(buttonTexts.some(t => t.includes('Confirm'))).toBeFalse();
    });
  });

  describe('Server Filter (v0.53.0)', () => {
    beforeEach(() => {
      fixture.componentRef.setInput('joinTable', 'borrowers');
      fixture.componentRef.setInput('rpcOptions', null);
      fixture.componentRef.setInput('isOpen', false);
      fixture.detectChanges();
    });

    it('should include serverFilter in query when provided', async () => {
      fixture.componentRef.setInput('serverFilter', { column: 'is_eligible', operator: 'is', value: 'true' });
      fixture.componentRef.setInput('isOpen', true);
      fixture.detectChanges();
      await waitForData();

      expect(mockDataService.getDataPaginated).toHaveBeenCalled();
      const callArgs = mockDataService.getDataPaginated.calls.mostRecent().args[0];
      const serverFilter = callArgs.filters!.find((f: any) => f.column === 'is_eligible');
      expect(serverFilter).toBeTruthy();
      expect(serverFilter!.operator).toBe('is');
      expect(serverFilter!.value).toBe('true');
    });

    it('should use serverFilter instead of rpcIdFilter when both are available', async () => {
      const rpcOptions = [
        { id: 1, text: 'Option A' },
        { id: 2, text: 'Option B' }
      ];
      fixture.componentRef.setInput('rpcOptions', rpcOptions);
      fixture.componentRef.setInput('serverFilter', { column: 'is_eligible', operator: 'is', value: 'true' });
      fixture.componentRef.setInput('isOpen', true);
      fixture.detectChanges();
      await waitForData();

      const callArgs = mockDataService.getDataPaginated.calls.mostRecent().args[0];
      // serverFilter should be present
      const serverFilter = callArgs.filters!.find((f: any) => f.column === 'is_eligible');
      expect(serverFilter).toBeTruthy();
      // rpcIdFilter (in operator) should NOT be present
      const inFilter = callArgs.filters!.find((f: any) => f.operator === 'in');
      expect(inFilter).toBeFalsy();
    });

    it('should fall back to rpcIdFilter when serverFilter is null', async () => {
      const rpcOptions = [
        { id: 1, text: 'Option A' },
        { id: 2, text: 'Option B' }
      ];
      fixture.componentRef.setInput('rpcOptions', rpcOptions);
      fixture.componentRef.setInput('serverFilter', null);
      fixture.componentRef.setInput('isOpen', true);
      fixture.detectChanges();
      await waitForData();

      const callArgs = mockDataService.getDataPaginated.calls.mostRecent().args[0];
      // rpcIdFilter (in operator) should be present since serverFilter is null
      const inFilter = callArgs.filters!.find((f: any) => f.operator === 'in');
      expect(inFilter).toBeTruthy();
      expect(inFilter!.value).toBe('(1,2)');
    });

    it('should not add any extra filter when both serverFilter and rpcOptions are null', async () => {
      fixture.componentRef.setInput('serverFilter', null);
      fixture.componentRef.setInput('rpcOptions', null);
      fixture.componentRef.setInput('isOpen', true);
      fixture.detectChanges();
      await waitForData();

      const callArgs = mockDataService.getDataPaginated.calls.mostRecent().args[0];
      // No server filter and no in filter
      const serverFilter = callArgs.filters?.find((f: any) => f.column === 'is_eligible');
      const inFilter = callArgs.filters?.find((f: any) => f.operator === 'in');
      expect(serverFilter).toBeFalsy();
      expect(inFilter).toBeFalsy();
    });
  });

  describe('Fallback for unregistered entities', () => {
    it('should fall back gracefully when entity not in SchemaService', async () => {
      mockSchemaService.getEntity.and.returnValue(of(undefined));
      mockDataService.getDataPaginated.and.returnValue(of({
        data: [{ id: 1, display_name: 'Fallback Item' }] as any,
        totalCount: 1
      }));

      fixture.componentRef.setInput('joinTable', 'unregistered_table');
      fixture.componentRef.setInput('rpcOptions', null);
      fixture.componentRef.setInput('isOpen', true);
      fixture.detectChanges();
      await waitForData();

      expect(component.listProperties().length).toBe(0);
      expect(mockDataService.getDataPaginated).toHaveBeenCalled();
      const callArgs = mockDataService.getDataPaginated.calls.mostRecent().args[0];
      expect(callArgs.fields).toEqual(['id', 'display_name']);
    });
  });

  describe('System Type Config (v0.49.1)', () => {
    it('should use system type config for civic_os_users when entity not in schema_entities', async () => {
      // civic_os_users is not registered in schema_entities, but has a system type config
      mockSchemaService.getEntity.and.returnValue(of(undefined));
      mockDataService.getDataPaginated.and.returnValue(of({
        data: [
          { id: 'uuid-1', display_name: 'Alice Smith', email: 'alice@example.com', phone: '5551234567' },
          { id: 'uuid-2', display_name: 'Bob Jones', email: 'bob@example.com', phone: null }
        ] as any,
        totalCount: 2
      }));

      fixture.componentRef.setInput('joinTable', 'civic_os_users');
      fixture.componentRef.setInput('rpcOptions', null);
      fixture.componentRef.setInput('isOpen', true);
      fixture.detectChanges();
      await waitForData();

      // Should have populated listProperties from system config (3 columns: Name, Email, Phone)
      expect(component.listProperties().length).toBe(3);
      expect(component.listProperties()[0].column_name).toBe('display_name');
      expect(component.listProperties()[1].column_name).toBe('email');
      expect(component.listProperties()[2].column_name).toBe('phone');

      // Should have search enabled (via hasTextSearch flag, not searchFields)
      expect(component.hasSearchFields()).toBe(true);

      // Should NOT have called getPropsForList (not a registered entity)
      expect(mockSchemaService.getPropsForList).not.toHaveBeenCalled();
    });

    it('should use tsvector search (wfts) for civic_os_users, not ILIKE', async () => {
      // v0.50.1: civic_os_users has hasTextSearch=true and searchFields=[]
      // so search should use the standard wfts path, not ILIKE substring matching
      mockSchemaService.getEntity.and.returnValue(of(undefined));
      mockDataService.getDataPaginated.and.returnValue(of({
        data: [
          { id: 'uuid-1', display_name: 'Alice Smith', email: 'alice@example.com', phone: '5551234567' }
        ] as any,
        totalCount: 1
      }));

      fixture.componentRef.setInput('joinTable', 'civic_os_users');
      fixture.componentRef.setInput('rpcOptions', null);
      fixture.componentRef.setInput('isOpen', true);
      fixture.detectChanges();
      await waitForData();

      // Perform a search
      component.onSearchInput('555');
      await waitForData();

      const callArgs = mockDataService.getDataPaginated.calls.mostRecent().args[0];
      // Should use searchQuery (wfts path), NOT rawQueryParams (ILIKE path)
      expect(callArgs.searchQuery).toBe('555');
      expect(callArgs.rawQueryParams).toBeUndefined();
    });

    it('should show search input for civic_os_users system type', async () => {
      mockSchemaService.getEntity.and.returnValue(of(undefined));
      mockDataService.getDataPaginated.and.returnValue(of({
        data: [{ id: 'uuid-1', display_name: 'Alice' }] as any,
        totalCount: 1
      }));

      fixture.componentRef.setInput('joinTable', 'civic_os_users');
      fixture.componentRef.setInput('rpcOptions', null);
      fixture.componentRef.setInput('isOpen', true);
      fixture.detectChanges();
      await waitForData();

      const searchInput = fixture.debugElement.query(By.css('input[placeholder="Search..."]'));
      expect(searchInput).toBeTruthy();
    });

    it('should still fall back to empty for unknown unregistered tables', async () => {
      mockSchemaService.getEntity.and.returnValue(of(undefined));
      mockDataService.getDataPaginated.and.returnValue(of({
        data: [{ id: 1, display_name: 'Item' }] as any,
        totalCount: 1
      }));

      fixture.componentRef.setInput('joinTable', 'some_unknown_table');
      fixture.componentRef.setInput('rpcOptions', null);
      fixture.componentRef.setInput('isOpen', true);
      fixture.detectChanges();
      await waitForData();

      // Should have no list properties (empty fallback)
      expect(component.listProperties().length).toBe(0);
      expect(component.hasSearchFields()).toBe(false);
    });
  });
});
