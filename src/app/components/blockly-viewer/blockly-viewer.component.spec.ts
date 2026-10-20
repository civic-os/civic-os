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
import { realTick } from '../../testing/fake-time';

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
    /**
     * Blockly itself cannot load under the Node test runner (it requires jsdom),
     * so these specs stub loadBlockly() with a fake module and resolve it on cue.
     */
    function stubBlocklyLoad() {
        const workspace = {
            dispose: vi.fn(), getBlocksBoundingBox: () => null, setScale: vi.fn(),
            scroll: vi.fn(), setTheme: vi.fn()
        };
        const Blockly = {
            Blocks: {} as Record<string, unknown>,
            common: { defineBlocks: vi.fn(), createBlockDefinitionsFromJsonArray: vi.fn() },
            inject: vi.fn().mockReturnValue(workspace),
            serialization: { workspaces: { load: vi.fn() } },
            svgResize: vi.fn()
        };
        let resolve!: () => void;
        const loaded = new Promise<any>(r => {
            resolve = () => r({ Blockly, SQL_BLOCK_DEFINITIONS: [], createCivicOsBlocklyTheme: () => ({}) });
        });
        vi.spyOn(component as any, 'loadBlockly').mockReturnValue(loaded);
        return { Blockly, workspace, resolve, loaded };
    }

    it('injects a workspace once Blockly has loaded', async () => {
        const { Blockly, resolve } = stubBlocklyLoad();
        fixture.componentRef.setInput('sourceCode', 'SELECT 1');
        fixture.detectChanges();

        resolve();

        await vi.waitFor(() => expect(component.loading()).toBe(false));
        expect(component.error()).toBe(false);
        expect(Blockly.inject).toHaveBeenCalledTimes(1);
        expect(mockTransformer.toBlocklyWorkspace).toHaveBeenCalled();
        fixture.destroy();
    });

    it('injects no workspace when destroyed before Blockly has loaded', async () => {
        const { Blockly, resolve, loaded } = stubBlocklyLoad();
        fixture.componentRef.setInput('sourceCode', 'SELECT 1');
        fixture.detectChanges(); // ngAfterViewInit starts loading
        fixture.destroy();

        resolve();
        await loaded;
        await realTick();

        expect(Blockly.inject).not.toHaveBeenCalled();
        expect(mockTransformer.toBlocklyWorkspace).not.toHaveBeenCalled();
    });

    it('does not load blocks into the disposed workspace when destroyed during the transform', async () => {
        const { Blockly, workspace, resolve } = stubBlocklyLoad();
        let finishTransform!: (json: unknown) => void;
        mockTransformer.toBlocklyWorkspace.mockReturnValue(new Promise(r => { finishTransform = r; }));
        fixture.componentRef.setInput('sourceCode', 'SELECT 1');
        fixture.detectChanges();
        resolve();
        await vi.waitFor(() => expect(mockTransformer.toBlocklyWorkspace).toHaveBeenCalled());

        fixture.destroy();
        expect(workspace.dispose).toHaveBeenCalled();
        finishTransform({ blocks: { languageVersion: 0, blocks: [] } });
        await realTick();

        expect(Blockly.serialization.workspaces.load).not.toHaveBeenCalled();
    });
});
