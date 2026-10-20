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
import { By } from '@angular/platform-browser';
import { MarkdownEditorComponent } from './markdown-editor.component';
import { provideTranslationTesting } from '../../testing/translation-testing';
import { realTick } from '../../testing/fake-time';

describe('MarkdownEditorComponent', () => {
    let component: MarkdownEditorComponent;
    let fixture: ComponentFixture<MarkdownEditorComponent>;

    beforeEach(async () => {
        await TestBed.configureTestingModule({
            imports: [MarkdownEditorComponent],
            providers: [
                provideZonelessChangeDetection(),
                provideTranslationTesting()
            ]
        }).compileComponents();

        fixture = TestBed.createComponent(MarkdownEditorComponent);
        component = fixture.componentInstance;
        fixture.detectChanges();
    });

    it('should create', () => {
        expect(component).toBeTruthy();
    });

    it('should render a toolbar with role="toolbar"', () => {
        const toolbar = fixture.debugElement.query(By.css('[role="toolbar"]'));
        expect(toolbar).toBeTruthy();
    });

    it('should render formatting buttons with aria-pressed attributes', () => {
        const buttons = fixture.debugElement.queryAll(By.css('button[aria-pressed]'));
        // Bold, Italic, Strike, H1, H2, H3, Bullet, Ordered, Blockquote, Code
        expect(buttons.length).toBeGreaterThanOrEqual(10);
    });

    it('should render an editor container div', () => {
        const editorEl = fixture.debugElement.query(By.css('.prose'));
        expect(editorEl).toBeTruthy();
    });

    // --- ControlValueAccessor interface ---

    it('should implement registerOnChange', () => {
        const spy = vi.fn().mockName('onChange');
        component.registerOnChange(spy);
        // No error thrown
        expect(component).toBeTruthy();
    });

    it('should implement registerOnTouched', () => {
        const spy = vi.fn().mockName('onTouched');
        component.registerOnTouched(spy);
        expect(component).toBeTruthy();
    });

    it('should store pending value if editor not yet initialized', () => {
        // Create a fresh component without triggering ngAfterViewInit
        const freshFixture = TestBed.createComponent(MarkdownEditorComponent);
        const freshComponent = freshFixture.componentInstance;
        // writeValue before editor initializes should not throw
        freshComponent.writeValue('# Test');
        expect(freshComponent).toBeTruthy();
    });

    it('should apply disabled state via setDisabledState', () => {
        component.setDisabledState(true);
        expect(component.disabled()).toBe(true);

        component.setDisabledState(false);
        expect(component.disabled()).toBe(false);
    });

    it('should show opacity-50 class when disabled', () => {
        component.setDisabledState(true);
        fixture.detectChanges();

        const editorWrapper = fixture.debugElement.query(By.css('.opacity-50'));
        expect(editorWrapper).toBeTruthy();
    });

    // --- Toolbar state signals ---

    it('should initialize all toolbar signals as false', () => {
        expect(component.isBold()).toBe(false);
        expect(component.isItalic()).toBe(false);
        expect(component.isStrike()).toBe(false);
        expect(component.isCode()).toBe(false);
        expect(component.isBulletList()).toBe(false);
        expect(component.isOrderedList()).toBe(false);
        expect(component.isBlockquote()).toBe(false);
        expect(component.isHeading(1)).toBe(false);
        expect(component.isHeading(2)).toBe(false);
        expect(component.isHeading(3)).toBe(false);
    });
    // --- Lazy TipTap import vs. destroy ---

    /** Resolve once the component's own TipTap imports have resolved (module cache) */
    async function tiptapLoaded(): Promise<void> {
        await Promise.all([
            import('@tiptap/core'),
            import('@tiptap/starter-kit'),
            import('@tiptap/markdown'),
            import('@tiptap/extension-link'),
        ]);
        await realTick();
    }

    it('builds the editor once TipTap has loaded', async () => {
        await vi.waitFor(() => expect(component.editorEl.nativeElement.querySelector('.ProseMirror')).toBeTruthy());
    });

    it('builds no editor when destroyed before TipTap has loaded', async () => {
        const early = TestBed.createComponent(MarkdownEditorComponent);
        const surface = early.componentInstance.editorEl.nativeElement;
        early.detectChanges(); // ngAfterViewInit starts the dynamic imports
        early.destroy();

        await tiptapLoaded();

        expect(surface.querySelector('.ProseMirror')).toBeNull();
    });

    // --- Accessible name of the editable surface ---

    function editableSurface(): HTMLElement {
        return component.editorEl.nativeElement.querySelector('.ProseMirror') as HTMLElement;
    }

    it('gives the editable surface a role and a translated fallback accessible name', async () => {
        await vi.waitFor(() => expect(editableSurface()).toBeTruthy());

        expect(editableSurface().getAttribute('role')).toBe('textbox');
        expect(editableSurface().getAttribute('aria-multiline')).toBe('true');
        expect(editableSurface().getAttribute('aria-label')).toBe('Markdown editor');
    });

    it('names the editable surface after the field and forwards required/invalid/describedby', async () => {
        await vi.waitFor(() => expect(editableSurface()).toBeTruthy());

        fixture.componentRef.setInput('ariaLabel', 'Description');
        fixture.componentRef.setInput('ariaRequired', true);
        fixture.componentRef.setInput('ariaInvalid', true);
        fixture.componentRef.setInput('ariaDescribedBy', 'description-desc description-error');
        fixture.detectChanges();

        const el = editableSurface();
        expect(el.getAttribute('aria-label')).toBe('Description');
        expect(el.getAttribute('aria-required')).toBe('true');
        expect(el.getAttribute('aria-invalid')).toBe('true');
        expect(el.getAttribute('aria-describedby')).toBe('description-desc description-error');
        expect(el.getAttribute('role')).toBe('textbox');

        fixture.componentRef.setInput('ariaInvalid', false);
        fixture.detectChanges();
        expect(el.hasAttribute('aria-invalid')).toBe(false);
    });
});
