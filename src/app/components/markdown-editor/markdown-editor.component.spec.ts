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
    const spy = jasmine.createSpy('onChange');
    component.registerOnChange(spy);
    // No error thrown
    expect(component).toBeTruthy();
  });

  it('should implement registerOnTouched', () => {
    const spy = jasmine.createSpy('onTouched');
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
    expect(component.disabled()).toBeTrue();

    component.setDisabledState(false);
    expect(component.disabled()).toBeFalse();
  });

  it('should show opacity-50 class when disabled', () => {
    component.setDisabledState(true);
    fixture.detectChanges();

    const editorWrapper = fixture.debugElement.query(By.css('.opacity-50'));
    expect(editorWrapper).toBeTruthy();
  });

  // --- Toolbar state signals ---

  it('should initialize all toolbar signals as false', () => {
    expect(component.isBold()).toBeFalse();
    expect(component.isItalic()).toBeFalse();
    expect(component.isStrike()).toBeFalse();
    expect(component.isCode()).toBeFalse();
    expect(component.isBulletList()).toBeFalse();
    expect(component.isOrderedList()).toBeFalse();
    expect(component.isBlockquote()).toBeFalse();
    expect(component.isHeading(1)).toBeFalse();
    expect(component.isHeading(2)).toBeFalse();
    expect(component.isHeading(3)).toBeFalse();
  });
});
