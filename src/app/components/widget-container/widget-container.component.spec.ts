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
import { Component, input, provideZonelessChangeDetection, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { WidgetContainerComponent } from './widget-container.component';
import { WidgetComponentRegistry } from '../../services/widget-component-registry.service';
import { DashboardWidget } from '../../interfaces/dashboard';
import { createMockWidget, MOCK_WIDGETS } from '../../testing';

// Mock widget component for testing
@Component({
  selector: 'app-test-widget',
  template: '<div class="test-widget">Test Widget Content</div>',
  changeDetection: ChangeDetectionStrategy.Eager,
  standalone: true
})
class TestWidgetComponent {
  widget = input.required<DashboardWidget>();
}

describe('WidgetContainerComponent', () => {
  let component: WidgetContainerComponent;
  let fixture: ComponentFixture<WidgetContainerComponent>;
  let registry: WidgetComponentRegistry;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [WidgetContainerComponent, CommonModule],
      providers: [
        provideZonelessChangeDetection(),
        WidgetComponentRegistry
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(WidgetContainerComponent);
    component = fixture.componentInstance;
    registry = TestBed.inject(WidgetComponentRegistry);
  });

  afterEach(() => {
    registry.clear(); // Clean up registry after each test
  });

  describe('Basic Component Setup', () => {
    it('should create', () => {
      registry.register('markdown', TestWidgetComponent);
      fixture.componentRef.setInput('widget', MOCK_WIDGETS.markdown);
      fixture.detectChanges();

      expect(component).toBeTruthy();
    });

    it('should have widget input', () => {
      const mockWidget = MOCK_WIDGETS.markdown;
      fixture.componentRef.setInput('widget', mockWidget);
      fixture.detectChanges();

      expect(component.widget()).toEqual(mockWidget);
    });
  });

  describe('widgetComponent computed signal', () => {
    it('should return component from registry when registered', () => {
      registry.register('markdown', TestWidgetComponent);

      fixture.componentRef.setInput('widget', MOCK_WIDGETS.markdown);
      fixture.detectChanges();

      expect(component.widgetComponent()).toBe(TestWidgetComponent);
    });

    it('should return null when widget type not registered', () => {
      spyOn(console, 'error'); // Suppress error log

      const unknownWidget = createMockWidget({
        widget_type: 'unknown_type'
      });

      fixture.componentRef.setInput('widget', unknownWidget);
      fixture.detectChanges();

      expect(component.widgetComponent()).toBeNull();
    });

    it('should log error when widget type not found', () => {
      spyOn(console, 'error');

      const unknownWidget = createMockWidget({
        widget_type: 'unknown_type'
      });

      fixture.componentRef.setInput('widget', unknownWidget);
      fixture.detectChanges();

      expect(console.error).toHaveBeenCalledWith(
        '[WidgetContainerComponent] No component registered for widget type: unknown_type'
      );
    });

    it('should update when widget input changes to different type', () => {
      registry.register('markdown', TestWidgetComponent);

      // Set initial widget
      fixture.componentRef.setInput('widget', MOCK_WIDGETS.markdown);
      fixture.detectChanges();
      expect(component.widgetComponent()).toBe(TestWidgetComponent);

      // Change to unknown type
      spyOn(console, 'error'); // Suppress error
      fixture.componentRef.setInput('widget', MOCK_WIDGETS.unknownType);
      fixture.detectChanges();
      expect(component.widgetComponent()).toBeNull();
    });
  });

  describe('hasError computed signal', () => {
    it('should return false when widget component is found', () => {
      registry.register('markdown', TestWidgetComponent);

      fixture.componentRef.setInput('widget', MOCK_WIDGETS.markdown);
      fixture.detectChanges();

      expect(component.hasError()).toBe(false);
    });

    it('should return true when widget component is not found', () => {
      spyOn(console, 'error'); // Suppress error

      const unknownWidget = createMockWidget({
        widget_type: 'unknown_type'
      });

      fixture.componentRef.setInput('widget', unknownWidget);
      fixture.detectChanges();

      expect(component.hasError()).toBe(true);
    });

    it('should update when component registration changes', () => {
      spyOn(console, 'error'); // Suppress error

      const widget = createMockWidget({ widget_type: 'test_widget' });

      // Initially not registered
      fixture.componentRef.setInput('widget', widget);
      fixture.detectChanges();
      expect(component.hasError()).toBe(true);

      // Register component and trigger signal re-evaluation with new widget object
      registry.register('test_widget', TestWidgetComponent);
      fixture.componentRef.setInput('widget', createMockWidget({ widget_type: 'test_widget' }));
      fixture.detectChanges();
      expect(component.hasError()).toBe(false);
    });
  });

  describe('title computed signal', () => {
    it('should return widget title when present', () => {
      const widgetWithTitle = createMockWidget({
        title: 'My Widget Title'
      });

      fixture.componentRef.setInput('widget', widgetWithTitle);
      fixture.detectChanges();

      expect(component.title()).toBe('My Widget Title');
    });

    it('should return null when widget has no title', () => {
      fixture.componentRef.setInput('widget', MOCK_WIDGETS.markdownNoTitle);
      fixture.detectChanges();

      expect(component.title()).toBeNull();
    });

    it('should update when widget input changes', () => {
      const widget1 = createMockWidget({ title: 'Title 1' });
      const widget2 = createMockWidget({ title: 'Title 2' });

      fixture.componentRef.setInput('widget', widget1);
      fixture.detectChanges();
      expect(component.title()).toBe('Title 1');

      fixture.componentRef.setInput('widget', widget2);
      fixture.detectChanges();
      expect(component.title()).toBe('Title 2');
    });
  });

  describe('widgetInputs computed signal', () => {
    it('should create inputs object with widget property', () => {
      const mockWidget = MOCK_WIDGETS.markdown;

      fixture.componentRef.setInput('widget', mockWidget);
      fixture.detectChanges();

      const inputs = component.widgetInputs();
      expect(inputs).toEqual({ widget: mockWidget });
    });

    it('should update when widget input changes', () => {
      fixture.componentRef.setInput('widget', MOCK_WIDGETS.markdown);
      fixture.detectChanges();
      expect(component.widgetInputs().widget).toEqual(MOCK_WIDGETS.markdown);

      fixture.componentRef.setInput('widget', MOCK_WIDGETS.filteredList);
      fixture.detectChanges();
      expect(component.widgetInputs().widget).toEqual(MOCK_WIDGETS.filteredList);
    });
  });

  describe('retry()', () => {
    it('should exist as a method', () => {
      expect(component.retry).toBeDefined();
      expect(typeof component.retry).toBe('function');
    });

    it('should not throw error when called', () => {
      expect(() => component.retry()).not.toThrow();
    });
  });

  describe('Template Rendering', () => {
    it('should render widget container with card styling', () => {
      registry.register('markdown', TestWidgetComponent);
      fixture.componentRef.setInput('widget', MOCK_WIDGETS.markdown);
      fixture.detectChanges();

      const compiled = fixture.nativeElement as HTMLElement;
      const container = compiled.querySelector('.widget-container');

      expect(container).toBeTruthy();
      expect(container?.classList.contains('card')).toBe(true);
      expect(container?.classList.contains('bg-base-100')).toBe(true);
      expect(container?.classList.contains('shadow-md')).toBe(true);
    });

    it('should render widget title when present', () => {
      registry.register('markdown', TestWidgetComponent);
      const widgetWithTitle = createMockWidget({
        widget_type: 'markdown',
        title: 'Test Title'
      });

      fixture.componentRef.setInput('widget', widgetWithTitle);
      fixture.detectChanges();

      const compiled = fixture.nativeElement as HTMLElement;
      const header = compiled.querySelector('.card-header');
      const title = compiled.querySelector('.card-header h3');

      expect(header).toBeTruthy();
      expect(title?.textContent?.trim()).toBe('Test Title');
    });

    it('should not render title section when title is null', () => {
      registry.register('markdown', TestWidgetComponent);
      fixture.componentRef.setInput('widget', MOCK_WIDGETS.markdownNoTitle);
      fixture.detectChanges();

      const compiled = fixture.nativeElement as HTMLElement;
      const header = compiled.querySelector('.card-header');

      expect(header).toBeNull();
    });

    it('should render error state when component not found', () => {
      spyOn(console, 'error'); // Suppress error

      const unknownWidget = createMockWidget({
        widget_type: 'unknown_type'
      });

      fixture.componentRef.setInput('widget', unknownWidget);
      fixture.detectChanges();

      const compiled = fixture.nativeElement as HTMLElement;
      const errorState = compiled.querySelector('.error-state');
      const alert = compiled.querySelector('.alert-error');

      expect(errorState).toBeTruthy();
      expect(alert).toBeTruthy();
      expect(compiled.textContent).toContain('Widget Failed to Load');
      expect(compiled.textContent).toContain('Unknown widget type: unknown_type');
    });

    it('should render retry button in error state', () => {
      spyOn(console, 'error'); // Suppress error

      const unknownWidget = createMockWidget({
        widget_type: 'unknown_type'
      });

      fixture.componentRef.setInput('widget', unknownWidget);
      fixture.detectChanges();

      const compiled = fixture.nativeElement as HTMLElement;
      const retryButton = compiled.querySelector('button');

      expect(retryButton).toBeTruthy();
      expect(retryButton?.textContent).toContain('Retry');
    });

    it('should trigger retry() when retry button clicked', () => {
      spyOn(console, 'error'); // Suppress error
      spyOn(component, 'retry').and.callThrough();

      const unknownWidget = createMockWidget({
        widget_type: 'unknown_type'
      });

      fixture.componentRef.setInput('widget', unknownWidget);
      fixture.detectChanges();

      const compiled = fixture.nativeElement as HTMLElement;
      const retryButton = compiled.querySelector('button') as HTMLButtonElement;

      retryButton.click();

      expect(component.retry).toHaveBeenCalled();
    });

    it('should render widget component when registered', () => {
      registry.register('markdown', TestWidgetComponent);

      fixture.componentRef.setInput('widget', MOCK_WIDGETS.markdown);
      fixture.detectChanges();

      const compiled = fixture.nativeElement as HTMLElement;
      const widgetContent = compiled.querySelector('.widget-content');
      const testWidget = compiled.querySelector('.test-widget');

      expect(widgetContent).toBeTruthy();
      expect(testWidget).toBeTruthy();
      expect(testWidget?.textContent).toBe('Test Widget Content');
    });

    it('should not render error state when component is found', () => {
      registry.register('markdown', TestWidgetComponent);

      fixture.componentRef.setInput('widget', MOCK_WIDGETS.markdown);
      fixture.detectChanges();

      const compiled = fixture.nativeElement as HTMLElement;
      const errorState = compiled.querySelector('.error-state');

      expect(errorState).toBeNull();
    });

    it('should pass widget to child component via NgComponentOutlet', () => {
      registry.register('markdown', TestWidgetComponent);

      fixture.componentRef.setInput('widget', MOCK_WIDGETS.markdown);
      fixture.detectChanges();

      // Child component should receive the widget input
      // This is verified by the component rendering successfully
      const compiled = fixture.nativeElement as HTMLElement;
      const testWidget = compiled.querySelector('.test-widget');

      expect(testWidget).toBeTruthy();
    });
  });

  describe('Change Detection with OnPush', () => {
    it('should update when widget input changes', () => {
      registry.register('markdown', TestWidgetComponent);

      const widget1 = createMockWidget({
        widget_type: 'markdown',
        title: 'Widget 1'
      });
      const widget2 = createMockWidget({
        widget_type: 'markdown',
        title: 'Widget 2'
      });

      fixture.componentRef.setInput('widget', widget1);
      fixture.detectChanges();

      const compiled = fixture.nativeElement as HTMLElement;
      let title = compiled.querySelector('.card-header h3');
      expect(title?.textContent?.trim()).toBe('Widget 1');

      fixture.componentRef.setInput('widget', widget2);
      fixture.detectChanges();

      title = compiled.querySelector('.card-header h3');
      expect(title?.textContent?.trim()).toBe('Widget 2');
    });
  });

  describe('Pre-configured Mock Widgets', () => {
    it('should render MOCK_WIDGETS.markdown', () => {
      registry.register('markdown', TestWidgetComponent);

      fixture.componentRef.setInput('widget', MOCK_WIDGETS.markdown);
      fixture.detectChanges();

      expect(component.widget().widget_type).toBe('markdown');
      expect(component.title()).toBe('Markdown Widget');
      expect(component.hasError()).toBe(false);
    });

    it('should show error for MOCK_WIDGETS.unknownType', () => {
      spyOn(console, 'error'); // Suppress error

      fixture.componentRef.setInput('widget', MOCK_WIDGETS.unknownType);
      fixture.detectChanges();

      expect(component.widget().widget_type).toBe('unknown_widget_type');
      expect(component.hasError()).toBe(true);

      const compiled = fixture.nativeElement as HTMLElement;
      expect(compiled.textContent).toContain('Unknown widget type: unknown_widget_type');
    });

    it('should render MOCK_WIDGETS.filteredList when registered', () => {
      registry.register('filtered_list', TestWidgetComponent);

      fixture.componentRef.setInput('widget', MOCK_WIDGETS.filteredList);
      fixture.detectChanges();

      expect(component.widget().widget_type).toBe('filtered_list');
      expect(component.title()).toBe('Recent Issues');
      expect(component.hasError()).toBe(false);
    });
  });

  describe('Edge Cases', () => {
    it('should handle widget with all null optional fields', () => {
      registry.register('markdown', TestWidgetComponent);

      const minimalWidget = createMockWidget({
        title: null,
        entity_key: null,
        refresh_interval_seconds: null
      });

      fixture.componentRef.setInput('widget', minimalWidget);
      fixture.detectChanges();

      expect(component.hasError()).toBe(false);
      expect(component.title()).toBeNull();

      const compiled = fixture.nativeElement as HTMLElement;
      const header = compiled.querySelector('.card-header');
      expect(header).toBeNull(); // No title section
    });

    it('should handle switching from error to success state', () => {
      spyOn(console, 'error'); // Suppress error

      const unknownWidget = createMockWidget({
        widget_type: 'test_widget'
      });

      // Start with error state
      fixture.componentRef.setInput('widget', unknownWidget);
      fixture.detectChanges();
      expect(component.hasError()).toBe(true);

      // Register component and trigger change detection
      registry.register('test_widget', TestWidgetComponent);
      fixture.componentRef.setInput('widget', createMockWidget({ widget_type: 'test_widget' }));
      fixture.detectChanges();

      expect(component.hasError()).toBe(false);

      const compiled = fixture.nativeElement as HTMLElement;
      const errorState = compiled.querySelector('.error-state');
      const widgetContent = compiled.querySelector('.widget-content');

      expect(errorState).toBeNull();
      expect(widgetContent).toBeTruthy();
    });
  });
});
