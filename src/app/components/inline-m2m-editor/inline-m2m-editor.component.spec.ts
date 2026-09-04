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
import { provideHttpClient, withXhr } from '@angular/common/http';
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
        const mockDataService = {
            getData: vi.fn().mockName("DataService.getData"),
            getDataPaginated: vi.fn().mockName("DataService.getDataPaginated"),
            callRpc: vi.fn().mockName("DataService.callRpc")
        };
        const mockSchemaService = {
            getEntity: vi.fn().mockName("SchemaService.getEntity"),
            getPropsForList: vi.fn().mockName("SchemaService.getPropsForList"),
            getPropsForFilter: vi.fn().mockName("SchemaService.getPropsForFilter"),
            getStatusOptionsSync: vi.fn().mockName("SchemaService.getStatusOptionsSync"),
            ensureStatusOptionsLoaded: vi.fn().mockName("SchemaService.ensureStatusOptionsLoaded"),
            getCategoryOptionsSync: vi.fn().mockName("SchemaService.getCategoryOptionsSync"),
            ensureCategoryOptionsLoaded: vi.fn().mockName("SchemaService.ensureCategoryOptionsLoaded")
        };

        mockDataService.getData.mockReturnValue(of([]));
        mockDataService.getDataPaginated.mockReturnValue(of({ data: [], totalCount: 0 }));
        mockSchemaService.getEntity.mockReturnValue(of(undefined));
        mockSchemaService.getPropsForList.mockReturnValue(of([]));
        mockSchemaService.getPropsForFilter.mockReturnValue(of([]));

        await TestBed.configureTestingModule({
            imports: [InlineM2mEditorComponent],
            providers: [
                provideZonelessChangeDetection(),
                provideHttpClient(withXhr()),
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
        expect(chips.every(c => c.state === 'current')).toBe(true);
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

        vi.spyOn(component.pendingDiff, 'emit').mockReturnValue(undefined);

        component.onModalApply({ toAdd: [3], toRemove: [1] });

        expect(component.pendingDiff.emit).toHaveBeenCalledWith({ toAdd: [3], toRemove: [1] });
    });

    it('should close modal on apply', () => {
        fixture.componentRef.setInput('property', mockProperty);
        fixture.componentRef.setInput('currentValues', currentValues);
        fixture.detectChanges();

        component.showModal.set(true);
        component.onModalApply({ toAdd: [], toRemove: [] });
        expect(component.showModal()).toBe(false);
    });

    it('should open modal on openModal call', () => {
        fixture.componentRef.setInput('property', mockProperty);
        fixture.componentRef.setInput('currentValues', currentValues);
        fixture.detectChanges();

        component.openModal();
        expect(component.showModal()).toBe(true);
    });

    it('should report hasPendingChanges correctly', () => {
        fixture.componentRef.setInput('property', mockProperty);
        fixture.componentRef.setInput('currentValues', currentValues);
        fixture.detectChanges();

        expect(component.hasPendingChanges()).toBe(false);

        component.onModalApply({ toAdd: [3], toRemove: [] });
        expect(component.hasPendingChanges()).toBe(true);
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

    describe('Computed Column Filter (v0.53.0)', () => {
        it('should build computedFilter when options_filter_column is set', () => {
            const propWithFilter = {
                ...MOCK_M2M_PROPERTY,
                show_inline: true,
                fk_search_modal: true,
                options_filter_column: 'is_eligible'
            };

            fixture.componentRef.setInput('property', propWithFilter);
            fixture.componentRef.setInput('currentValues', currentValues);
            fixture.detectChanges();

            const filter = component.computedFilter();
            expect(filter).toBeTruthy();
            expect(filter!.column).toBe('is_eligible');
            expect(filter!.operator).toBe('is');
            expect(filter!.value).toBe('true');
        });

        it('should return null computedFilter when options_filter_column is not set', () => {
            fixture.componentRef.setInput('property', mockProperty);
            fixture.componentRef.setInput('currentValues', currentValues);
            fixture.detectChanges();

            expect(component.computedFilter()).toBeNull();
        });

        it('should return null computedFilter when options_filter_column is undefined', () => {
            const propNoFilter = {
                ...MOCK_M2M_PROPERTY,
                show_inline: true,
                fk_search_modal: true,
                options_filter_column: undefined
            };

            fixture.componentRef.setInput('property', propNoFilter);
            fixture.componentRef.setInput('currentValues', currentValues);
            fixture.detectChanges();

            expect(component.computedFilter()).toBeNull();
        });
    });
});
