/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { By } from '@angular/platform-browser';
import { BlocklyViewerComponent } from './blockly-viewer.component';
import { SqlBlockTransformerService } from '../../services/sql-block-transformer.service';
import { settleLazyComponents } from '../../testing/lazy-components';

describe('BlocklyViewerComponent', () => {
    let component: BlocklyViewerComponent;
    let fixture: ComponentFixture<BlocklyViewerComponent>;
    let mockTransformer: any;

    beforeEach(async () => {
        mockTransformer = {
            toBlocklyWorkspace: vi.fn().mockName("SqlBlockTransformerService.toBlocklyWorkspace")
        };
        mockTransformer.toBlocklyWorkspace.mockResolvedValue({
            blocks: { languageVersion: 0, blocks: [] }
        });

        await TestBed.configureTestingModule({
            imports: [BlocklyViewerComponent],
            providers: [
                provideZonelessChangeDetection(),
                { provide: SqlBlockTransformerService, useValue: mockTransformer }
            ]
        }).compileComponents();

        fixture = TestBed.createComponent(BlocklyViewerComponent);
        component = fixture.componentInstance;
    });

    // Let lazy-loaded children (maps, editor, Blockly) finish initializing
    // before teardown so nothing outlives this spec file (testing/lazy-components.ts).
    afterEach(async () => {
        await settleLazyComponents(fixture);
    });

    it('should create', () => {
        expect(component).toBeTruthy();
    });

    it('should show loading spinner initially', () => {
        fixture.componentRef.setInput('sourceCode', 'SELECT 1');
        fixture.detectChanges();

        const spinner = fixture.debugElement.query(By.css('.loading-spinner'));
        expect(spinner).toBeTruthy();
    });

    it('should default to loading state', () => {
        fixture.componentRef.setInput('sourceCode', 'SELECT 1');
        fixture.detectChanges();

        expect(component.loading()).toBe(true);
        expect(component.error()).toBe(false);
    });

    it('should have default workspace height of 400', () => {
        fixture.componentRef.setInput('sourceCode', 'SELECT 1');
        fixture.detectChanges();

        expect(component.workspaceHeight()).toBe(400);
    });

    it('should accept optional objectType input', () => {
        fixture.componentRef.setInput('sourceCode', 'SELECT 1');
        fixture.componentRef.setInput('objectType', 'function');
        fixture.detectChanges();

        expect(component.objectType()).toBe('function');
    });

    it('should have blockly container with border styling', () => {
        fixture.componentRef.setInput('sourceCode', 'SELECT 1');
        fixture.detectChanges();

        const container = fixture.debugElement.query(By.css('.blockly-container'));
        expect(container).toBeTruthy();
        expect(container.nativeElement.classList.contains('border')).toBe(true);
        expect(container.nativeElement.classList.contains('border-base-300')).toBe(true);
    });
});
